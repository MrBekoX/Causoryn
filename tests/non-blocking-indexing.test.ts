import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryGraphRepository } from "@causoryn/graph";
import {
  IndexJobManager,
  IndexService,
  runIndexWorkerTask,
  startIndexWorker,
  validateWorkerEntryPath,
  type IndexProgressEvent,
  type IndexWorkerMessage,
  type IndexWorkerTaskInput,
} from "@causoryn/indexing";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

const WS = "ws_non_blocking";
const T0 = "2026-11-24T14:00:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-worker-idx-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function createSubstantialTsWorkspace(rootDir: string, moduleCount = 50): void {
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "src", "shared.ts"),
    [
      "export interface DomainRecord<T> {",
      "  readonly id: string;",
      "  readonly payload: T;",
      "  readonly tags: readonly string[];",
      "}",
      "export function wrapRecord<T>(id: string, payload: T): DomainRecord<T> {",
      "  return { id, payload, tags: ['core'] };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  for (let i = 0; i < moduleCount; i += 1) {
    const prevImport =
      i > 0
        ? `import { processModule${i - 1} } from "./module_${i - 1}.js";\n`
        : "";
    const prevCall = i > 0 ? `processModule${i - 1}(input)` : "input";
    writeFileSync(
      path.join(rootDir, "src", `module_${i}.ts`),
      [
        `import { wrapRecord, type DomainRecord } from "./shared.js";`,
        prevImport,
        `export interface Module${i}Result { readonly index: number; readonly value: string; }`,
        `export class Service${i} {`,
        `  execute(input: string): DomainRecord<Module${i}Result> {`,
        `    const base = ${prevCall};`,
        `    return wrapRecord("m-${i}", { index: ${i}, value: String(base) });`,
        `  }`,
        `}`,
        `export function processModule${i}(input: string): string {`,
        `  const svc = new Service${i}();`,
        `  return svc.execute(input).payload.value;`,
        `}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

describe("Task 2.5 — Non-Blocking worker_threads Indexing & Structured Progress", { timeout: 60_000 }, () => {
  it("executes SQLite indexing off the main thread in a real worker_threads Worker, keeps event-loop latency < 500ms, and emits >= 2 progress updates", async () => {
    const wsDir = path.join(tempRoot, "ws-worker");
    const dbFile = path.join(tempRoot, "graph.sqlite");
    createSubstantialTsWorkspace(wsDir, 50);

    const repo = new SqliteGraphRepository(dbFile);
    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
      const indexService = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => new Date().toISOString(),
        limits: { maxFiles: 500 },
        tolerateConcurrentPublishRace: true,
      });

      const progressEvents: IndexProgressEvent[] = [];
      const manager = new IndexJobManager({
        indexService,
        policy,
        clock: () => new Date().toISOString(),
        workerDbPath: dbFile,
        onProgress: (_jobId, event) => {
          progressEvents.push(event);
        },
      });

      // Measure main-thread event-loop lag continuously while worker thread runs
      let maxLagMs = 0;
      let tickCount = 0;
      let lastTick = performance.now();
      const probeIntervalMs = 15;
      const timer = setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - lastTick - probeIntervalMs);
        if (lag > maxLagMs) maxLagMs = lag;
        tickCount += 1;
        lastTick = now;
      }, probeIntervalMs);

      let finished;
      try {
        const queued = manager.refreshIndex(wsDir, { mode: "full" });
        expect(queued.status).toBe("queued");
        expect(queued.progress.phase).toBe("queued");

        // Concurrent main-thread reads must stay fast while worker indexes
        const statusReads: number[] = [];
        for (let i = 0; i < 10; i += 1) {
          const t0 = performance.now();
          manager.status(queued.jobId);
          repo.getLatestSnapshotMeta(WS);
          statusReads.push(performance.now() - t0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(Math.max(...statusReads)).toBeLessThan(500);

        finished = await manager.waitForJob(queued.jobId);
      } finally {
        clearInterval(timer);
      }

      expect(finished.status).toBe("done");
      expect(finished.executionMode).toBe("worker");
      expect(finished.snapshotId).not.toBeNull();
      expect(finished.snapshotState).toBe("ready");
      expect(finished.fileCount).toBe(51);
      expect(finished.tsFileCount).toBe(51);
      expect(finished.progress.phase).toBe("done");
      expect(finished.progressPercent).toBe(100);

      // Event loop remained responsive (< 500ms lag) while worker ran TS TypeChecker
      expect(tickCount).toBeGreaterThanOrEqual(2);
      expect(maxLagMs).toBeLessThan(500);

      // At least 2 structured progress updates emitted during indexing
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents.some((e) => e.phase === "inventory" || e.phase === "analyzing")).toBe(true);
      expect(progressEvents.some((e) => e.phase === "done")).toBe(true);

      // Main-thread SQLite reader sees the worker-published snapshot immediately via WAL
      const latestMeta = repo.getLatestSnapshotMeta(WS);
      expect(latestMeta?.snapshotId).toBe(finished.snapshotId);
      expect(latestMeta?.stale).toBe(false);
      const latestRead = repo.getLatestPublished(WS);
      expect(latestRead?.snapshot.meta.id).toBe(finished.snapshotId);
      expect(latestRead?.snapshot.nodes.some((n) => n.qualifiedName === "Service49")).toBe(true);

      // Follow-up incremental job in worker_threads applies early cutoff on body-only edit!
      writeFileSync(
        path.join(wsDir, "src", "module_49.ts"),
        [
          "// Worker incremental body edit",
          `import { wrapRecord, type DomainRecord } from "./shared.js";`,
          `import { processModule48 } from "./module_48.js";`,
          `export interface Module49Result { readonly index: number; readonly value: string; }`,
          `export class Service49 {`,
          `  execute(input: string): DomainRecord<Module49Result> {`,
          `    const base = processModule48(input);`,
          `    const formatted = String(base);`,
          `    return wrapRecord("m-49", { index: 49, value: formatted });`,
          `  }`,
          `}`,
          `export function processModule49(input: string): string {`,
          `  const svc = new Service49();`,
          `  return svc.execute(input).payload.value;`,
          `}`,
          "",
        ].join("\n"),
        "utf8",
      );
      const incJob = manager.refreshIndex(wsDir, {
        mode: "incremental",
        changeSet: ["src/module_49.ts"],
      });
      const incDone = await manager.waitForJob(incJob.jobId);
      expect(incDone.status).toBe("done");
      expect(incDone.executionMode).toBe("worker");
      expect(incDone.earlyCutoffApplied).toBe(true);
      expect(incDone.reanalyzedFiles).toBe(1);
      expect(incDone.cachedFiles).toBe(50);
    } finally {
      repo.close();
    }
  });

  it("falls back cleanly to in-process async execution for InMemoryGraphRepository and still emits >= 2 progress events", async () => {
    const wsDir = path.join(tempRoot, "ws-mem");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });
    writeFileSync(
      path.join(wsDir, "src", "hello.ts"),
      "export function hello(): string { return 'world'; }\n",
      "utf8",
    );

    const repo = new InMemoryGraphRepository();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
    const indexService = new IndexService({
      workspaceId: WS,
      policy,
      repository: repo,
      clock: () => T0,
      limits: { maxFiles: 100 },
    });

    const events: IndexProgressEvent[] = [];
    const manager = new IndexJobManager({
      indexService,
      policy,
      clock: () => T0,
      onProgress: (_jobId, event) => {
        events.push(event);
      },
    });

    const job = manager.refreshIndex(wsDir, { mode: "full" });
    const done = await manager.waitForJob(job.jobId);
    expect(done.status).toBe("done");
    expect(done.executionMode).toBe("in-process");
    expect(done.progress.phase).toBe("done");
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("Finding #1: index-worker eliminates dynamic sqliteModuleSpecifier import sink, exports startIndexWorker, and never double-starts when imported by a wrapper entrypoint", async () => {
    const workerSourcePath = path.resolve(
      process.cwd(),
      "packages",
      "indexing",
      "src",
      "index-worker.ts",
    );
    const workerSource = readFileSync(workerSourcePath, "utf8");
    expect(workerSource).not.toContain("sqliteModuleSpecifier");
    // Every `import(...)` call in index-worker.ts must use a static string literal
    expect(workerSource).not.toMatch(/\bimport\s*\(\s*(?!["'])/);
    expect(typeof startIndexWorker).toBe("function");

    const wsDir = path.join(tempRoot, "ws-f1");
    const dbFile = path.join(tempRoot, "f1.sqlite");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });
    writeFileSync(
      path.join(wsDir, "src", "app.ts"),
      "export function greet(name: string): string { return `hi ${name}`; }\n",
      "utf8",
    );

    const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
    const payload: IndexWorkerTaskInput = {
      dbPath: dbFile,
      rootPath: wsDir,
      mode: "full",
      changeSet: [],
      workspaceId: WS,
      policyConfig: policy.config,
      limits: { maxFiles: 100 },
      fixedClockIso: T0,
    };

    // Direct runIndexWorkerTask with injected constructor proves static DI is honored
    let injectedCtorCalls = 0;
    class TrackedSqliteRepo extends SqliteGraphRepository {
      constructor(p: string) {
        super(p);
        injectedCtorCalls += 1;
      }
    }
    const directSummary = await runIndexWorkerTask(payload, undefined, TrackedSqliteRepo);
    expect(injectedCtorCalls).toBe(1);
    expect(directSummary.published).toBe(true);
    expect(directSummary.state).toBe("ready");

    // Simulate packages/mcp-server/src/index-worker-entry.ts importing startIndexWorker
    // and calling startIndexWorker(SqliteGraphRepository) inside a real Worker thread:
    // must post EXACTLY ONE "done" message (auto-start guard prevents duplicate execution).
    const wrapperDb = path.join(tempRoot, "f1-wrapper.sqlite");
    const wrapperEntryPath = path.join(tempRoot, "mock-index-worker-entry.ts");
    const indexWorkerFileUrl = pathToFileURL(workerSourcePath).href;
    const sqlitePkgFileUrl = pathToFileURL(
      path.resolve(process.cwd(), "packages", "storage-sqlite", "src", "index.ts"),
    ).href;
    writeFileSync(
      wrapperEntryPath,
      [
        `import { startIndexWorker } from ${JSON.stringify(indexWorkerFileUrl)};`,
        `import { SqliteGraphRepository } from ${JSON.stringify(sqlitePkgFileUrl)};`,
        `startIndexWorker(SqliteGraphRepository);`,
        `startIndexWorker(SqliteGraphRepository);`,
        "",
      ].join("\n"),
      "utf8",
    );

    const bootstrap = `
      import { registerHooks } from "node:module";
      import { existsSync } from "node:fs";
      import path from "node:path";
      import { fileURLToPath, pathToFileURL } from "node:url";
      import { workerData } from "node:worker_threads";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          try { return nextResolve(specifier, context); } catch (err) {
            if (specifier.endsWith(".js") && context.parentURL && context.parentURL.startsWith("file:")) {
              const parentDir = path.dirname(fileURLToPath(context.parentURL));
              const tsPath = path.resolve(parentDir, specifier.slice(0, -3) + ".ts");
              if (existsSync(tsPath)) return nextResolve(pathToFileURL(tsPath).href, context);
            }
            throw err;
          }
        },
      });
      await import(workerData.__workerEntryUrl);
    `;

    const messages: IndexWorkerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(bootstrap, {
        eval: true,
        workerData: {
          ...payload,
          dbPath: wrapperDb,
          __workerEntryUrl: pathToFileURL(wrapperEntryPath).href,
          __causorynBootstrap: true,
        },
        execArgv: ["--experimental-transform-types", "--no-warnings"],
      });
      worker.on("message", (msg: IndexWorkerMessage) => {
        messages.push(msg);
        if (msg.type === "done" || msg.type === "error") {
          // Wait briefly to catch any accidental duplicate execution before terminating
          setTimeout(() => {
            void worker.terminate().then(() => resolve());
          }, 150);
        }
      });
      worker.on("error", reject);
    });

    const doneMessages = messages.filter((m) => m.type === "done");
    const errorMessages = messages.filter((m) => m.type === "error");
    expect(errorMessages).toEqual([]);
    expect(doneMessages).toHaveLength(1);
    expect(doneMessages[0]?.type === "done" && doneMessages[0].result.published).toBe(true);
  });

  it("Finding #2: IndexJobManager.close() terminates active worker, cancels queued jobs, settles waiters, clears progress listeners, and never calls syncRunCountFromRepository after close", async () => {
    const wsDir = path.join(tempRoot, "ws-close");
    const dbFile = path.join(tempRoot, "close.sqlite");
    createSubstantialTsWorkspace(wsDir, 40);

    const repo = new SqliteGraphRepository(dbFile);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
    const indexService = new IndexService({
      workspaceId: WS,
      policy,
      repository: repo,
      clock: () => new Date().toISOString(),
      limits: { maxFiles: 500 },
      tolerateConcurrentPublishRace: true,
    });

    let syncCallsAfterClose = 0;
    let isClosed = false;
    const origSync = indexService.syncRunCountFromRepository.bind(indexService);
    indexService.syncRunCountFromRepository = () => {
      if (isClosed) {
        syncCallsAfterClose += 1;
      }
      origSync();
    };

    const progressAfterClose: IndexProgressEvent[] = [];
    const manager = new IndexJobManager({
      indexService,
      policy,
      clock: () => new Date().toISOString(),
      workerDbPath: dbFile,
      onProgress: (_jobId, event) => {
        if (isClosed) {
          progressAfterClose.push(event);
        }
      },
    });

    const job1 = manager.refreshIndex(wsDir, { mode: "full" });
    const job2 = manager.refreshIndex(wsDir, { mode: "full" });
    const p1 = manager.waitForJob(job1.jobId);
    const p2 = manager.waitForJob(job2.jobId);

    // Let drain start the first worker before closing
    await new Promise((resolve) => setTimeout(resolve, 40));

    isClosed = true;
    manager.close();
    // Idempotent second close
    manager.close();
    // Closing the SQLite repository immediately after manager.close() must never crash!
    repo.close();

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe("failed");
    expect(res2.status).toBe("failed");
    expect(res2.error?.message).toMatch(/closed|cancel/i);

    // Further refreshIndex calls after close are rejected synchronously
    expect(() => manager.refreshIndex(wsDir, { mode: "full" })).toThrow();

    // Give terminated worker time to exit cleanly; verify zero post-close sync or progress calls
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(syncCallsAfterClose).toBe(0);
    expect(progressAfterClose).toEqual([]);
  });

  it("Finding #6: validateWorkerEntryPath rejects empty, NUL, UNC/device paths, directories, symlinks, and sibling escapes; IndexJobManager falls back safely", async () => {
    const allowedDir = path.join(tempRoot, "worker-dir");
    const siblingPrefixDir = path.join(tempRoot, "worker-dir-evil");
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(siblingPrefixDir, { recursive: true });

    const validFile = path.join(allowedDir, "index-worker.mjs");
    const outsideFile = path.join(siblingPrefixDir, "index-worker.mjs");
    const nestedDir = path.join(allowedDir, "subdir");
    writeFileSync(validFile, "// ok\n", "utf8");
    writeFileSync(outsideFile, "// evil\n", "utf8");
    mkdirSync(nestedDir, { recursive: true });

    // Empty / whitespace / NUL / UNC / device path rejections
    expect(validateWorkerEntryPath("")).toBeUndefined();
    expect(validateWorkerEntryPath("   ")).toBeUndefined();
    expect(validateWorkerEntryPath(`${validFile}\0.js`)).toBeUndefined();
    expect(validateWorkerEntryPath("\\\\attacker\\share\\index-worker.mjs")).toBeUndefined();
    expect(validateWorkerEntryPath("//attacker/share/index-worker.mjs")).toBeUndefined();
    expect(validateWorkerEntryPath("/\\attacker\\index-worker.mjs")).toBeUndefined();
    expect(validateWorkerEntryPath("\\/attacker/index-worker.mjs")).toBeUndefined();
    expect(validateWorkerEntryPath("\\\\?\\C:\\index-worker.mjs")).toBeUndefined();

    // Non-file (directory) and non-existent path rejections
    expect(validateWorkerEntryPath(nestedDir)).toBeUndefined();
    expect(validateWorkerEntryPath(path.join(allowedDir, "missing.mjs"))).toBeUndefined();

    // Allowed parent dir containment (including prefix-collision sibling dir rejection)
    expect(validateWorkerEntryPath(validFile, allowedDir)).toBeDefined();
    expect(validateWorkerEntryPath(outsideFile, allowedDir)).toBeUndefined();
    expect(
      validateWorkerEntryPath(
        path.join(allowedDir, "..", "worker-dir-evil", "index-worker.mjs"),
        allowedDir,
      ),
    ).toBeUndefined();

    // Symlink rejection (best-effort file symlink creation; falls back to directory junction if Windows lacks file symlink privilege)
    const linkPath = path.join(allowedDir, "symlink-worker.mjs");
    let createdLink = false;
    try {
      symlinkSync(validFile, linkPath, "file");
      createdLink = true;
    } catch {
      try {
        symlinkSync(nestedDir, linkPath, "junction");
        createdLink = true;
      } catch {
        createdLink = false;
      }
    }
    if (createdLink) {
      expect(validateWorkerEntryPath(linkPath)).toBeUndefined();
      expect(validateWorkerEntryPath(linkPath, allowedDir)).toBeUndefined();
    }

    // IndexJobManager given an invalid/UNC workerEntryPath safely falls back to in-process execution
    const wsDir = path.join(tempRoot, "ws-f6");
    const dbFile = path.join(tempRoot, "f6.sqlite");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });
    writeFileSync(
      path.join(wsDir, "src", "ok.ts"),
      "export const ANSWER = 42;\n",
      "utf8",
    );
    const repo = new SqliteGraphRepository(dbFile);
    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
      const indexService = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const manager = new IndexJobManager({
        indexService,
        policy,
        clock: () => T0,
        workerDbPath: dbFile,
        workerEntryPath: "\\\\attacker\\share\\evil-worker.mjs",
      });
      const job = manager.refreshIndex(wsDir, { mode: "full" });
      const done = await manager.waitForJob(job.jobId);
      expect(done.status).toBe("done");
      expect(done.executionMode).toBe("in-process");
      manager.close();
    } finally {
      repo.close();
    }
  });
});
