import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { runInventoryAnalysisInWorker } from "@causoryn/indexing";

import {
  acquireHistoryAnalysisSlot,
  DEFAULT_HISTORY_RESOURCE_LIMITS,
  HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB,
  historyAnalysisWorkerHeapMb,
  setHistoryAnalysisWorkerEntryForTesting,
} from "../src/history-commit-analysis.js";
import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
  type CausorynContext,
} from "../src/index.js";
import { createTrustedHistorySources } from "../src/trusted-history.js";

/**
 * CAU-01 (worker isolation): the fresh analysis of a commit from its git
 * objects no longer runs its scratch index on the MCP main thread. The blobs
 * are collected on the main thread (async git reads, byte budgets) and the
 * scratch index runs in a `worker_threads` worker of the existing index
 * worker entry, with a V8 heap limit derived from
 * CAUSORYN_HISTORY_MAX_COMMIT_BYTES. The worker is terminated at the
 * analysis or call deadline; a worker that runs out of memory, crashes or
 * exits becomes a controlled `unanalyzed` point, the analysis slot is
 * released, and the server keeps answering other tools meanwhile.
 */

const ENV_NAMES = [
  "CAUSORYN_HISTORY_MAX_ANALYSES",
  "CAUSORYN_HISTORY_MAX_COMMIT_BYTES",
  "CAUSORYN_HISTORY_MAX_REQUEST_BYTES",
  "CAUSORYN_HISTORY_MAX_ANALYSIS_MS",
  "CAUSORYN_HISTORY_MAX_REQUEST_MS",
  "CAUSORYN_HISTORY_MAX_CONCURRENT",
  "CAUSORYN_HISTORY_BUSY_WAIT_MS",
] as const;

/** Logged on the main thread when a fresh analysis hands its inventory to the worker. */
const WORKER_LOG = /^history: analyzing commit ([0-9a-f]{40}|[0-9a-f]{64}) in a worker thread /;

const MCP_SERVER_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const cleanups: Array<() => void> = [];
afterEach(() => {
  setHistoryAnalysisWorkerEntryForTesting(undefined);
  for (const name of ENV_NAMES) delete process.env[name];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

interface Repo {
  readonly root: string;
  readonly sha: (ref: string) => string;
}

/** A synthetic module with `functions` exported functions that call into the next module. */
function syntheticModule(index: number, modules: number, functions: number): string {
  const next = (index + 1) % modules;
  const lines = [`import { f${String(next)}_0 } from "./m${String(next)}";`, ""];
  for (let k = 0; k < functions; k += 1) {
    const id = `f${String(index)}_${String(k)}`;
    lines.push(
      `export interface R${String(index)}_${String(k)} { readonly total: number; readonly label: string; }`,
      `export function ${id}(value: number): R${String(index)}_${String(k)} {`,
      `  const parts: Record<string, number> = { a: value, b: value * ${String(k + 1)} };`,
      `  const total = parts["a"]! + parts["b"]! + (value > 0 ? f${String(next)}_0(value - 1).total : 0);`,
      `  return { total, label: \`${id}:\${String(total)}\` };`,
      "}",
    );
  }
  lines.push(
    `export class Service${String(index)} {`,
    `  run(value: number): number { return f${String(index)}_0(value).total; }`,
    "}",
    "",
  );
  return lines.join("\n");
}

/**
 * t1: src/a.ts · t2: + src/b.ts · big (optional): + `modules` synthetic
 * modules, large enough that the scratch index takes noticeable time.
 */
function makeRepo(options: { readonly modules?: number; readonly functions?: number } = {}): Repo {
  const root = makeTempDir("causoryn-history-worker-");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, stdio: "pipe", encoding: "utf8" });
  const write = (relativePath: string, content: string): void => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  };
  const commit = (tag: string): void => {
    git("add", "-A");
    git("commit", "-m", tag);
    git("tag", tag);
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@causoryn.local");
  git("config", "user.name", "Causoryn Fixture");
  git("config", "commit.gpgsign", "false");
  write("src/a.ts", "export function alpha(): number {\n  return 1;\n}\n");
  commit("t1");
  write("src/b.ts", "export function beta(): number {\n  return 2;\n}\n");
  commit("t2");
  const modules = options.modules ?? 0;
  if (modules > 0) {
    for (let index = 0; index < modules; index += 1) {
      write(`src/big/m${String(index)}.ts`, syntheticModule(index, modules, options.functions ?? 30));
    }
    commit("big");
  }
  return { root, sha: (ref) => git("rev-parse", `${ref}^{commit}`).trim() };
}

interface Session {
  readonly context: CausorynContext;
  readonly dataDir: string;
  readonly logs: string[];
  /** Resolves with the first log line matching `pattern` (also one logged before the call). */
  readonly waitForLog: (pattern: RegExp) => Promise<string>;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly callRaw: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function openSession(root: string): Promise<Session> {
  const dataDir = makeTempDir("causoryn-history-worker-data-");
  const logs: string[] = [];
  const listeners = new Set<(line: string) => void>();
  const context = createCausorynContext(
    {
      workspaceId: "history-worker",
      allowRoots: [root],
      autoIndex: false,
      storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
    },
    {
      logger: (message) => {
        logs.push(message);
        for (const listener of listeners) listener(message);
      },
    },
  );
  const server = createCausorynMcpServer(context, { toolProfile: "history" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-worker-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
    context.close();
  });
  const callRaw = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const parsed = EnvelopeSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? result.content)).toBe(true);
    return (parsed as { success: true; data: Record<string, unknown> }).data;
  };
  return {
    context,
    dataDir,
    logs,
    waitForLog: (pattern) => {
      const seen = logs.find((line) => pattern.test(line));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        // Only a failing test reaches this bound; it then reports what the server logged.
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`no log line matched ${String(pattern)}; server log: ${JSON.stringify(logs)}`));
        }, 90_000);
        const listener = (line: string): void => {
          if (!pattern.test(line)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(line);
        };
        listeners.add(listener);
      });
    },
    call: async (name, args) => {
      const envelope = await callRaw(name, args);
      expect(envelope.status, JSON.stringify(envelope)).not.toBe("error");
      return envelope;
    },
    callRaw,
  };
}

function pointsOf(envelope: Record<string, unknown>): Array<Record<string, unknown>> {
  const timeline = (envelope.data as Record<string, unknown>).timeline as Record<string, unknown>;
  return timeline.points as Array<Record<string, unknown>>;
}

function historyFiles(dataDir: string): string[] {
  const dir = path.join(dataDir, "history");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** A worker entry (plain ESM) written for one test: it replaces the analysis worker. */
function workerScript(name: string, source: string): string {
  const dir = makeTempDir("causoryn-history-worker-entry-");
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, source, "utf8");
  return file;
}

/** Spins without ever yielding, like a long synchronous TypeScript phase. */
const BUSY_WORKER = "for (;;) {}\n";
const CRASHING_WORKER = 'throw new Error("injected analysis worker crash");\n';
const EXITING_WORKER = "process.exit(7);\n";
/** Allocates until the worker's heap limit is reached. */
const ALLOCATING_WORKER = "const keep = [];\nfor (;;) keep.push(new Array(100000).fill(Math.random()));\n";
/**
 * Blocks in a synchronous child process call for 8 s when asked to analyze
 * (like `spawnSync cargo --version`): neither its message loop nor
 * `worker.terminate()` can stop it before the call returns.
 */
const BLOCKED_WORKER = [
  'import { spawnSync } from "node:child_process";',
  'import { parentPort } from "node:worker_threads";',
  'parentPort.on("message", (request) => {',
  '  if (request.type !== "analyze") return;',
  '  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 8000);"], { stdio: "ignore" });',
  "});",
  "",
].join("\n");

/** The process-wide analysis slot is free: it can be taken without waiting. */
async function expectSlotFree(): Promise<void> {
  const release = await acquireHistoryAnalysisSlot(1, 0);
  expect(release, "the analysis slot was not released").toBeDefined();
  release?.();
}

function directContext(root: string, logger: (message: string) => void = () => {}): CausorynContext {
  const context = createCausorynContext(
    { workspaceId: "history-worker", allowRoots: [root], autoIndex: false },
    { logger },
  );
  cleanups.push(() => context.close());
  return context;
}

describe("history fresh analysis in a worker thread (CAU-01)", { timeout: 180_000 }, () => {
  it("lowers the default byte budgets for in-process memory and derives the worker heap limit from the per-commit budget", () => {
    expect(DEFAULT_HISTORY_RESOURCE_LIMITS.maxCommitBytes).toBe(32 * 1024 * 1024);
    expect(DEFAULT_HISTORY_RESOURCE_LIMITS.maxRequestBytes).toBe(64 * 1024 * 1024);
    // 256 MiB for the analyzers themselves plus 24 MiB per MiB of accepted source text.
    expect(historyAnalysisWorkerHeapMb(DEFAULT_HISTORY_RESOURCE_LIMITS.maxCommitBytes)).toBe(1024);
    expect(historyAnalysisWorkerHeapMb(1)).toBe(280);
    expect(historyAnalysisWorkerHeapMb(1024 * 1024 + 1)).toBe(304);
  });

  it("clamps the worker heap limit to half of the machine's memory and to a hard ceiling, never below the analyzers' base heap", () => {
    const MiB = 1024 * 1024;
    const GiB = 1024 * MiB;
    // Enough memory: the per-commit formula applies.
    expect(historyAnalysisWorkerHeapMb(32 * MiB, 64 * GiB)).toBe(1024);
    // A 1 GiB machine: at most half of its memory.
    expect(historyAnalysisWorkerHeapMb(32 * MiB, 1 * GiB)).toBe(512);
    // A huge per-commit budget: the hard ceiling, whatever the machine has.
    expect(HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB).toBe(8192);
    expect(historyAnalysisWorkerHeapMb(1024 * MiB, 1024 * GiB)).toBe(HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB);
    // A tiny machine: not below the 256 MiB the analyzers need without any source text.
    expect(historyAnalysisWorkerHeapMb(32 * MiB, 256 * MiB)).toBe(256);
  });

  it("a large synthetic commit is analyzed in the worker while causoryn_status is answered", async () => {
    const repo = makeRepo({ modules: 80, functions: 20 });
    const session = await openSession(repo.root);
    const order: string[] = [];
    const timeline = session.call("causoryn_architecture_timeline", { refs: ["t1", "big"] }).then((envelope) => {
      order.push("timeline");
      return envelope;
    });
    // The analysis of `big` has been handed to the worker (or the call ended without one).
    const started = await Promise.race([session.waitForLog(new RegExp(`analyzing commit ${repo.sha("big")} in a worker thread`)), timeline.then(() => undefined)]);
    expect(started, "the commit was not analyzed in a worker thread").toBeDefined();
    const status = await session.call("causoryn_status", {});
    order.push("status");
    expect(status.status).not.toBe("error");

    const points = pointsOf(await timeline);
    expect(order).toEqual(["status", "timeline"]);
    expect(points.map((point) => point.status)).toEqual(["analyzed", "analyzed"]);
    // The worker's result is a real symbol-level analysis, cached like before.
    expect(historyFiles(session.dataDir).filter((name) => name.startsWith(`${repo.sha("big")}-`))).toHaveLength(1);
  });

  it("a worker that never finishes is terminated at CAUSORYN_HISTORY_MAX_ANALYSIS_MS: analysis-deadline-exceeded, other tools answer meanwhile, the slot is released", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    setHistoryAnalysisWorkerEntryForTesting(workerScript("busy", BUSY_WORKER));
    process.env["CAUSORYN_HISTORY_MAX_ANALYSIS_MS"] = "1500";
    process.env["CAUSORYN_HISTORY_BUSY_WAIT_MS"] = "0";

    const order: string[] = [];
    const timeline = session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }).then((envelope) => {
      order.push("timeline");
      return envelope;
    });
    await session.waitForLog(WORKER_LOG);
    const status = await session.call("causoryn_status", {});
    order.push("status");
    expect(status.status).not.toBe("error");

    const points = pointsOf(await timeline);
    expect(order).toEqual(["status", "timeline"]);
    for (const point of points) {
      expect(point.status).toBe("unanalyzed");
      expect(String(point.unanalyzedReason)).toMatch(/^analysis-deadline-exceeded: .*CAUSORYN_HISTORY_MAX_ANALYSIS_MS/);
    }
    expect(historyFiles(session.dataDir)).toEqual([]);
    await expectSlotFree();

    // The server is unharmed: with the real worker the same points are analyzed.
    setHistoryAnalysisWorkerEntryForTesting(undefined);
    delete process.env["CAUSORYN_HISTORY_MAX_ANALYSIS_MS"];
    const after = pointsOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    expect(after.map((point) => point.status)).toEqual(["analyzed", "analyzed"]);
  });

  it("the call deadline CAUSORYN_HISTORY_MAX_REQUEST_MS terminates the worker as well", async () => {
    const repo = makeRepo();
    const context = directContext(repo.root);
    setHistoryAnalysisWorkerEntryForTesting(workerScript("busy", BUSY_WORKER));
    const sources = createTrustedHistorySources(context, "history-worker", repo.root, {
      maxFreshAnalyses: 4,
      limits: { ...DEFAULT_HISTORY_RESOURCE_LIMITS, maxAnalysisMs: 10_000_000, maxRequestMs: 1500 },
    });
    const result = await sources.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
    expect(result).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^request-deadline-exceeded: .*CAUSORYN_HISTORY_MAX_REQUEST_MS/) as unknown as string,
    });
    await expectSlotFree();
  });

  it("a crashing or exiting analysis worker yields analysis-worker-failed and releases the slot", async () => {
    const repo = makeRepo();
    const logs: string[] = [];
    const context = directContext(repo.root, (message) => logs.push(message));
    for (const [name, source, detail] of [
      ["crash", CRASHING_WORKER, "injected analysis worker crash"],
      ["exit", EXITING_WORKER, "exit code 7"],
    ] as const) {
      setHistoryAnalysisWorkerEntryForTesting(workerScript(name, source));
      const sources = createTrustedHistorySources(context, "history-worker", repo.root, { maxFreshAnalyses: 4 });
      const result = await sources.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
      expect(result, name).toEqual({
        status: "unanalyzed",
        reason: expect.stringMatching(/^analysis-worker-failed: /) as unknown as string,
      });
      // The detail goes to the server log only.
      expect(JSON.stringify(result)).not.toContain(detail);
      expect(logs.some((line) => line.includes(detail)), `${name}: ${JSON.stringify(logs)}`).toBe(true);
      await expectSlotFree();
    }
  });

  it("a worker that cannot be stopped at the deadline does not hold the result back, but keeps the analysis slot until its thread has exited", async () => {
    const repo = makeRepo();
    const logs: string[] = [];
    const context = directContext(repo.root, (message) => logs.push(message));
    setHistoryAnalysisWorkerEntryForTesting(workerScript("blocked", BLOCKED_WORKER));
    const sources = createTrustedHistorySources(context, "history-worker", repo.root, {
      maxFreshAnalyses: 4,
      limits: { ...DEFAULT_HISTORY_RESOURCE_LIMITS, maxAnalysisMs: 1000 },
    });
    const startedAt = performance.now();
    const result = await sources.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
    const answeredAfterMs = performance.now() - startedAt;
    expect(result).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^analysis-deadline-exceeded: /) as unknown as string,
    });
    // The deadline (1 s) plus the bounded settle time, not the 8 s blocking call.
    expect(answeredAfterMs, JSON.stringify(logs)).toBeLessThan(6_000);
    // The thread is still blocked: the slot is still counted.
    const premature = await acquireHistoryAnalysisSlot(1, 0);
    premature?.();
    expect(premature, "the slot was released before the worker exited").toBeUndefined();
    // Once the blocking call has returned the thread exits and the slot comes free (no double release).
    const release = await acquireHistoryAnalysisSlot(1, 30_000);
    expect(release, "the analysis slot was not released").toBeDefined();
    expect(performance.now() - startedAt).toBeGreaterThan(answeredAfterMs);
    release?.();
    await expectSlotFree();
  });

  it("an analysis worker that runs out of its heap limit yields analysis-memory-exceeded", async () => {
    const repo = makeRepo();
    const context = directContext(repo.root);
    setHistoryAnalysisWorkerEntryForTesting(workerScript("allocate", ALLOCATING_WORKER));
    const sources = createTrustedHistorySources(context, "history-worker", repo.root, {
      maxFreshAnalyses: 4,
      // The smallest per-commit budget gives the smallest heap limit (280 MiB).
      limits: { ...DEFAULT_HISTORY_RESOURCE_LIMITS, maxCommitBytes: 1024 },
    });
    const result = await sources.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
    expect(result).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^analysis-memory-exceeded: .*280 MiB.*CAUSORYN_HISTORY_MAX_COMMIT_BYTES/) as unknown as string,
    });
    await expectSlotFree();
  });

  it.skipIf(!existsSync(path.join(MCP_SERVER_DIST, "index-worker.mjs")))(
    "the bundled index worker (dist/index-worker.mjs) runs the inventory analysis mode",
    async () => {
      const root = makeTempDir("causoryn-history-worker-bundle-");
      const content = "export function alpha(): number {\n  return 1;\n}\n";
      const { createHash } = await import("node:crypto");
      const context = directContext(root);
      const result = await runInventoryAnalysisInWorker(
        {
          workspaceId: "history-worker",
          rootPath: root,
          policyConfig: context.policy.config,
          limits: { maxFiles: 100 },
          entries: [
            {
              relativePath: "src/a.ts",
              sizeBytes: Buffer.byteLength(content, "utf8"),
              contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
              content,
            },
          ],
          fixedClockIso: "2026-01-01T00:00:00.000Z",
        },
        { maxHeapMb: 512, workerEntryPath: path.join(MCP_SERVER_DIST, "index-worker.mjs") },
      );
      expect(result.state).toBe("ready");
      const contentSet = JSON.parse(result.contentSetJson) as { nodes: Array<{ qualifiedName: string }> };
      expect(contentSet.nodes.map((node) => node.qualifiedName)).toContain("alpha");
    },
  );
});

describe("compare maps history limits to accurate tool errors (CAU-01)", { timeout: 180_000 }, () => {
  function errorOf(envelope: Record<string, unknown>): Record<string, unknown> {
    expect(envelope.status, JSON.stringify(envelope)).toBe("error");
    return envelope.error as Record<string, unknown>;
  }

  it("a byte budget is LIMIT_EXCEEDED, not INVALID_REVISION", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    process.env["CAUSORYN_HISTORY_MAX_COMMIT_BYTES"] = "1";
    const error = errorOf(await session.callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" }));
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(String(error.message)).toContain("baseRef 't1'");
    expect(String(error.message)).toContain("commit-byte-budget-exceeded");
    expect(String(error.message)).toContain("CAUSORYN_HISTORY_MAX_COMMIT_BYTES");
  });

  it("the analysis deadline is LIMIT_EXCEEDED", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    setHistoryAnalysisWorkerEntryForTesting(workerScript("busy", BUSY_WORKER));
    process.env["CAUSORYN_HISTORY_MAX_ANALYSIS_MS"] = "1000";
    const error = errorOf(await session.callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" }));
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(String(error.message)).toContain("analysis-deadline-exceeded");
    await expectSlotFree();
  });

  it("a busy analysis slot is the retryable INDEX_NOT_READY with an explicit message", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    process.env["CAUSORYN_HISTORY_BUSY_WAIT_MS"] = "0";
    const release = await acquireHistoryAnalysisSlot(1, 0);
    expect(release).toBeDefined();
    try {
      const error = errorOf(await session.callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" }));
      expect(error.code).toBe("INDEX_NOT_READY");
      expect(error.retryable).toBe(true);
      expect(String(error.message)).toContain("analysis-busy");
      expect(String(error.message)).toContain("another fresh commit analysis is running");
    } finally {
      release?.();
    }
    // Once the slot is free the same comparison works.
    const envelope = await session.call("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" });
    expect(envelope.status).not.toBe("error");
  });

  it("analysis-busy reaches the client as INDEX_NOT_READY even while an index job runs (it is not turned into the indexing-in-progress answer)", async () => {
    const repo = makeRepo();
    const base = createCausorynContext(
      { workspaceId: "history-worker", allowRoots: [repo.root], autoIndex: false },
      { logger: () => {} },
    );
    cleanups.push(() => base.close());
    // A background index job is running in this workspace.
    const context: CausorynContext = {
      ...base,
      getActiveIndexJob: () => ({ jobId: "job-busy", status: "running", progressPercent: 40, phase: "analyzing" }),
    };
    const server = createCausorynMcpServer(context, { toolProfile: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "history-busy-while-indexing", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });
    const callRaw = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const parsed = EnvelopeSchema.safeParse(result.structuredContent);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? result.content)).toBe(true);
      return (parsed as { success: true; data: Record<string, unknown> }).data;
    };

    process.env["CAUSORYN_HISTORY_BUSY_WAIT_MS"] = "0";
    const release = await acquireHistoryAnalysisSlot(1, 0);
    expect(release).toBeDefined();
    try {
      const error = errorOf(await callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" }));
      expect(error.code).toBe("INDEX_NOT_READY");
      expect(error.retryable).toBe(true);
      expect(String(error.message)).toContain("analysis-busy");
      expect(String(error.message)).toContain("another fresh commit analysis is running");

      // A tool whose INDEX_NOT_READY means "no index yet" still gets the indexing-in-progress answer.
      const pending = await callRaw("causoryn_find_symbols", { query: "alpha" });
      expect(pending.status).toBe("partial");
      expect((pending.data as Record<string, unknown>).indexing).toBe(true);
      expect((pending.data as Record<string, unknown>).jobId).toBe("job-busy");
    } finally {
      release?.();
    }
  });

  it("a failed analysis worker is the retryable INTERNAL_ERROR with an explicit message", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    setHistoryAnalysisWorkerEntryForTesting(workerScript("crash", CRASHING_WORKER));
    const error = errorOf(await session.callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" }));
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.retryable).toBe(true);
    expect(String(error.message)).toContain("analysis-worker-failed");
  });
});

describe("history tool descriptions", () => {
  it("compare and timeline do not claim to be read-only: they write the commit-analysis cache under the data root", async () => {
    const root = makeTempDir("causoryn-history-worker-desc-");
    const session = await openSession(root);
    const server = createCausorynMcpServer(session.context, { toolProfile: "history" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "history-worker-desc", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(() => {
      void client.close();
      void server.close();
    });
    const { tools } = await client.listTools();
    for (const name of ["causoryn_compare_architecture", "causoryn_architecture_timeline"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.description ?? "", name).not.toMatch(/read-only/i);
      expect(tool?.description ?? "", name).toMatch(/data root/i);
      expect(tool?.description ?? "", name).toMatch(/workspace/i);
    }
  });
});
