import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexJobManager, IndexService } from "../src/index.js";

/**
 * A cancelled index job never publishes (security finding F33, follow-up).
 * IndexJobManager.close() releases the job's build lease at once and asks the
 * worker to stop with a `cancel` message, but a worker reads that message only
 * when its event loop turns. The end of a run (graph build, file facts and the
 * publish) is one synchronous segment, so without more a job that close() met
 * there still published its snapshot after its lease was gone: a new context
 * for the same root could already be building (single-writer rule broken) while
 * the closed manager reported the job as cancelled.
 *
 * close() now also sets the job's shared cancel flag (a SharedArrayBuffer the
 * worker reads without its event loop) before it releases the lease; the job
 * checks it before it persists file facts and inside the write transaction that
 * publishes, so the publish cannot slip between the check and the commit.
 *
 * The worker entry is helpers/pausing-index-job-worker.ts: the real job (IndexService
 * over SQLite) behind the real job protocol, blocked synchronously at one
 * progress phase until the test resumes it.
 */

const PAUSING_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "pausing-index-job-worker.ts");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TS_FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const WS = "ws_cancel_publish";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

interface BuildRow {
  readonly state: string;
  readonly failure_reason: string | null;
}

/** Snapshot rows and file facts of the data store, read through a fresh read-only connection. */
function storeState(dbPath: string): { readonly builds: readonly BuildRow[]; readonly fileFacts: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const builds = db
      .prepare("SELECT state, failure_reason FROM snapshots WHERE workspace_id = ? ORDER BY sid")
      .all(WS) as BuildRow[];
    const facts = db.prepare("SELECT COUNT(*) AS n FROM file_facts WHERE workspace_id = ?").get(WS) as {
      readonly n: number;
    };
    return { builds, fileFacts: facts.n };
  } finally {
    db.close();
  }
}

function clock(): string {
  return new Date().toISOString();
}

describe("a cancelled index job publishes nothing, even from its last synchronous segment", { timeout: 90_000 }, () => {
  it.each([
    ["building", /cancelled before persisting file facts/],
    ["publishing", /cancelled before publishing/],
  ])(
    "close() while the worker is blocked at the %s phase: no snapshot, no lease, the build is failed as cancelled",
    async (phase, reason) => {
      const dataDir = makeTempDir("causoryn-cancel-publish-data-");
      const controlDir = makeTempDir("causoryn-cancel-publish-control-");
      const dbPath = path.join(dataDir, "index.sqlite");
      const repository = new SqliteGraphRepository(dbPath);
      cleanups.push(() => {
        repository.close();
      });
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [TS_FIXTURE_ROOT] });
      const indexService = new IndexService({
        workspaceId: WS,
        policy,
        repository,
        clock,
        limits: { maxFiles: 1_000 },
      });
      let markReleased!: () => void;
      const released = new Promise<void>((resolve) => {
        markReleased = resolve;
      });
      const manager = new IndexJobManager({
        indexService,
        policy,
        clock,
        workerDbPath: dbPath,
        workerEntryPath: PAUSING_WORKER,
        onWorkerReleased: () => {
          markReleased();
        },
      });
      cleanups.push(() => {
        manager.close();
      });

      const job = manager.refreshIndex(TS_FIXTURE_ROOT, {
        mode: "full",
        changeSet: [JSON.stringify({ pauseAt: phase, controlDir })],
      });
      await vi.waitFor(
        () => {
          expect(existsSync(path.join(controlDir, "paused")), "the worker did not reach the pause").toBe(true);
        },
        { timeout: 60_000, interval: 20 },
      );
      expect(repository.getActiveBuildLease(WS)).toBeDefined();

      const waiting = manager.waitForJob(job.jobId);
      manager.close();
      expect((await waiting).status).toBe("failed");
      // The lease is released at once: a new context may start building now.
      expect(repository.getActiveBuildLease(WS)).toBeUndefined();

      // The worker resumes the rest of its synchronous segment before it reads the cancel request.
      writeFileSync(path.join(controlDir, "resume"), "", "utf8");
      await released;

      expect(repository.getLatestPublished(WS)).toBeUndefined();
      const state = storeState(dbPath);
      expect(state.builds.some((row) => row.state === "ready" || row.state === "partial")).toBe(false);
      // The job itself refused to go on (not the grace-period termination, which leaves the row building).
      expect(state.builds).toEqual([{ state: "failed", failure_reason: expect.stringMatching(reason) as unknown as string }]);
      if (phase === "building") expect(state.fileFacts).toBe(0);
    },
  );
});

describe("IndexService isCancelled (the job side of the cancel flag)", { timeout: 90_000 }, () => {
  it("a run whose cancel check turns true before the publish fails its build and publishes nothing", async () => {
    const dataDir = makeTempDir("causoryn-cancel-check-");
    const dbPath = path.join(dataDir, "index.sqlite");
    const repository = new SqliteGraphRepository(dbPath);
    cleanups.push(() => {
      repository.close();
    });
    let cancelled = false;
    const service = new IndexService({
      workspaceId: WS,
      policy: WorkspaceAccessPolicy.create({ allowRoots: [TS_FIXTURE_ROOT] }),
      repository,
      clock,
      limits: { maxFiles: 1_000 },
      isCancelled: () => cancelled,
    });
    await expect(
      service.runIndexAsync(TS_FIXTURE_ROOT, {
        onProgress: (event) => {
          if (event.phase === "publishing") cancelled = true;
        },
      }),
    ).rejects.toThrow(/cancelled before publishing/);
    expect(repository.getLatestPublished(WS)).toBeUndefined();
    expect(repository.getActiveBuildLease(WS)).toBeUndefined();
    expect(storeState(dbPath).builds).toEqual([
      { state: "failed", failure_reason: expect.stringMatching(/cancelled before publishing/) as unknown as string },
    ]);
  });

  it("a cancel that lands between the file-facts check and its write transaction writes no file facts", async () => {
    const dataDir = makeTempDir("causoryn-cancel-facts-");
    const dbPath = path.join(dataDir, "index.sqlite");
    const repository = new SqliteGraphRepository(dbPath);
    cleanups.push(() => {
      repository.close();
    });
    // The job manager sets the flag at any point of the job's synchronous tail;
    // here it lands right after the first cancel check (the one before the
    // file facts are prepared), before their write transaction starts.
    let checks = 0;
    const service = new IndexService({
      workspaceId: WS,
      policy: WorkspaceAccessPolicy.create({ allowRoots: [TS_FIXTURE_ROOT] }),
      repository,
      clock,
      limits: { maxFiles: 1_000 },
      isCancelled: () => {
        checks += 1;
        return checks >= 2;
      },
    });
    await expect(service.runIndexAsync(TS_FIXTURE_ROOT)).rejects.toThrow(/cancelled before persisting file facts/);
    expect(repository.getLatestPublished(WS)).toBeUndefined();
    expect(storeState(dbPath).fileFacts).toBe(0);
  });

  it("a run that is never cancelled publishes as before (control)", async () => {
    const dataDir = makeTempDir("causoryn-cancel-check-control-");
    const dbPath = path.join(dataDir, "index.sqlite");
    const repository = new SqliteGraphRepository(dbPath);
    cleanups.push(() => {
      repository.close();
    });
    const service = new IndexService({
      workspaceId: WS,
      policy: WorkspaceAccessPolicy.create({ allowRoots: [TS_FIXTURE_ROOT] }),
      repository,
      clock,
      limits: { maxFiles: 1_000 },
      isCancelled: () => false,
    });
    const result = await service.runIndexAsync(TS_FIXTURE_ROOT);
    expect(result.published).toBe(true);
    expect(repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(result.snapshotId);
    expect(storeState(dbPath).fileFacts).toBeGreaterThan(0);
  });
});

/**
 * The `files` table is what the next refresh compares the inventory with
 * (analyzeChanges): a job that does not publish must leave it as it was, or
 * the next incremental refresh reports "No changes" and keeps serving the old
 * snapshot until another file changes. For a job with a cancel check the files
 * sync runs inside the publish transaction, right before the publish.
 */
describe("a cancelled index job leaves the files table as it was", { timeout: 120_000 }, () => {
  /** A writable TypeScript workspace (the repository fixtures are read-only). */
  function editableWorkspace(): string {
    const root = makeTempDir("causoryn-cancel-files-ws-");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "util.ts"), "export function twice(n: number): number {\n  return n * 2;\n}\n", "utf8");
    writeFileSync(
      path.join(root, "src", "app.ts"),
      'import { twice } from "./util.js";\nexport function run(): number {\n  return twice(1);\n}\n',
      "utf8",
    );
    return root;
  }

  function fileHashes(repository: SqliteGraphRepository): readonly string[] {
    return repository
      .listFiles(WS)
      .map((record) => `${record.relativePath}=${record.contentHash}`)
      .sort();
  }

  const EDITED_APP =
    'import { twice } from "./util.js";\nexport function run(): number {\n  return twice(2);\n}\nexport function other(): string {\n  return "x";\n}\n';

  it.each(["building", "publishing"])(
    "close() while the worker is blocked at the %s phase: files keeps the published hashes and the next incremental refresh re-indexes",
    async (phase) => {
      const root = editableWorkspace();
      const controlDir = makeTempDir("causoryn-cancel-files-control-");
      const dbPath = path.join(makeTempDir("causoryn-cancel-files-data-"), "index.sqlite");
      const repository = new SqliteGraphRepository(dbPath);
      cleanups.push(() => {
        repository.close();
      });
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const indexService = new IndexService({ workspaceId: WS, policy, repository, clock, limits: { maxFiles: 1_000 } });
      const first = await indexService.runIndexAsync(root);
      expect(first.published).toBe(true);
      const publishedHashes = fileHashes(repository);

      writeFileSync(path.join(root, "src", "app.ts"), EDITED_APP, "utf8");
      let markReleased!: () => void;
      const released = new Promise<void>((resolve) => {
        markReleased = resolve;
      });
      const manager = new IndexJobManager({
        indexService,
        policy,
        clock,
        workerDbPath: dbPath,
        workerEntryPath: PAUSING_WORKER,
        onWorkerReleased: () => {
          markReleased();
        },
      });
      cleanups.push(() => {
        manager.close();
      });
      manager.refreshIndex(root, { mode: "full", changeSet: [JSON.stringify({ pauseAt: phase, controlDir })] });
      await vi.waitFor(
        () => {
          expect(existsSync(path.join(controlDir, "paused")), "the worker did not reach the pause").toBe(true);
        },
        { timeout: 60_000, interval: 20 },
      );
      manager.close();
      writeFileSync(path.join(controlDir, "resume"), "", "utf8");
      await released;

      expect(repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(first.snapshotId);
      expect(fileHashes(repository)).toEqual(publishedHashes);

      const next = await indexService.runIncrementalIndexAsync(root, ["src/app.ts"]);
      expect(next.outcome).toBe("published");
      expect(next.snapshotId).not.toBe(first.snapshotId);
      expect(fileHashes(repository)).not.toEqual(publishedHashes);
    },
  );

  it("in process: a run cancelled at its publish leaves files unchanged, and the next run sees the edit", async () => {
    const root = editableWorkspace();
    const dbPath = path.join(makeTempDir("causoryn-cancel-files-inproc-"), "index.sqlite");
    const repository = new SqliteGraphRepository(dbPath);
    cleanups.push(() => {
      repository.close();
    });
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const first = await new IndexService({ workspaceId: WS, policy, repository, clock, limits: { maxFiles: 1_000 } }).runIndexAsync(
      root,
    );
    const publishedHashes = fileHashes(repository);

    writeFileSync(path.join(root, "src", "app.ts"), EDITED_APP, "utf8");
    let cancelled = false;
    const cancelledService = new IndexService({
      workspaceId: WS,
      policy,
      repository,
      clock,
      limits: { maxFiles: 1_000 },
      isCancelled: () => cancelled,
    });
    await expect(
      cancelledService.runIncrementalIndexAsync(root, ["src/app.ts"], {
        onProgress: (event) => {
          if (event.phase === "publishing") cancelled = true;
        },
      }),
    ).rejects.toThrow(/cancelled before publishing/);
    expect(fileHashes(repository)).toEqual(publishedHashes);

    const next = await new IndexService({
      workspaceId: WS,
      policy,
      repository,
      clock,
      limits: { maxFiles: 1_000 },
    }).runIncrementalIndexAsync(root, ["src/app.ts"]);
    expect(next.outcome).toBe("published");
    expect(next.snapshotId).not.toBe(first.snapshotId);
  });
});
