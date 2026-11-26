import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultGitProcessRunner,
  setGitProcessRunnerForTesting,
} from "../../graph/src/git-read.js";
import {
  acquireHistoryAnalysisSlot,
  DEFAULT_HISTORY_RESOURCE_LIMITS,
} from "../src/history-commit-analysis.js";
import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
  type CausorynContext,
} from "../src/index.js";
import { createTrustedHistorySources } from "../src/trusted-history.js";

/**
 * CAU-01: a fresh analysis of a commit from its git objects runs inside the
 * MCP process, so its work is bounded beyond the per-file and file-count
 * limits: a cumulative byte budget per commit and per call, a wall-clock
 * deadline per analysis and per call (checked between blob reads and at the
 * scratch index's phase boundaries), and a process-wide limit on running
 * fresh analyses. A limit that is hit leaves the point unanalyzed with an
 * explicit reason code; the server keeps answering other calls.
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  setGitProcessRunnerForTesting(undefined);
  for (const name of ENV_NAMES) delete process.env[name];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

const A_TS = "export function alpha(): number {\n  return 1;\n}\n";
const B_TS = "export function beta(): number {\n  return 2;\n}\n";
const C_TS = "export function gamma(): number {\n  return 3;\n}\n";

interface Repo {
  readonly root: string;
  readonly sha: (ref: string) => string;
}

/**
 * t1: src/a.ts · t2: + src/b.ts · t3: + src/c.ts (+ `extraFiles` small files in
 * t1). Only .ts files, so the analyzed text of a commit is the sum of its files.
 */
function makeRepo(extraFiles = 0): Repo {
  const root = makeTempDir("causoryn-history-budget-");
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
  write("src/a.ts", A_TS);
  for (let index = 0; index < extraFiles; index += 1) {
    write(`src/extra/e${String(index).padStart(2, "0")}.ts`, `export const e${String(index)} = ${String(index)};\n`);
  }
  commit("t1");
  write("src/b.ts", B_TS);
  commit("t2");
  write("src/c.ts", C_TS);
  commit("t3");
  return { root, sha: (ref) => git("rev-parse", `${ref}^{commit}`).trim() };
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface Session {
  readonly context: CausorynContext;
  readonly dataDir: string;
  readonly logs: string[];
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function openSession(root: string): Promise<Session> {
  const dataDir = makeTempDir("causoryn-history-budget-data-");
  const logs: string[] = [];
  const context = createCausorynContext(
    {
      workspaceId: "history-budget",
      allowRoots: [root],
      autoIndex: false,
      storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
    },
    { logger: (message) => logs.push(message) },
  );
  const server = createCausorynMcpServer(context, { toolProfile: "history" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-budget-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
    context.close();
  });
  return {
    context,
    dataDir,
    logs,
    call: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const parsed = EnvelopeSchema.safeParse(result.structuredContent);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? result.content)).toBe(true);
      const envelope = (parsed as { success: true; data: Record<string, unknown> }).data;
      expect(envelope.status, JSON.stringify(envelope)).not.toBe("error");
      return envelope;
    },
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

function isBlobRead(args: readonly string[]): boolean {
  const index = args.indexOf("cat-file");
  return index >= 0 && args[index + 1] === "blob";
}

/** A context for direct calls of the trusted history sources (no data root). */
function directContext(root: string, clock?: () => string): CausorynContext {
  const context = createCausorynContext(
    { workspaceId: "history-budget", allowRoots: [root], autoIndex: false },
    { logger: () => {}, ...(clock === undefined ? {} : { clock }) },
  );
  cleanups.push(() => context.close());
  return context;
}

function limits(overrides: Partial<typeof DEFAULT_HISTORY_RESOURCE_LIMITS>): typeof DEFAULT_HISTORY_RESOURCE_LIMITS {
  return { ...DEFAULT_HISTORY_RESOURCE_LIMITS, ...overrides };
}

function isContentSet(value: unknown): boolean {
  return (
    value !== undefined &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    (value as { status?: unknown }).status === undefined
  );
}

describe("history fresh analysis resource budgets (CAU-01)", { timeout: 120_000 }, () => {
  it("a commit above CAUSORYN_HISTORY_MAX_COMMIT_BYTES stays unanalyzed with commit-byte-budget-exceeded and a concurrent call is answered", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    // t1 (a.ts) fits; t2 (a.ts + b.ts) is one byte over the per-commit budget.
    process.env["CAUSORYN_HISTORY_MAX_COMMIT_BYTES"] = String(bytes(A_TS) + bytes(B_TS) - 1);

    const [timeline, status] = await Promise.all([
      session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }),
      session.call("causoryn_status", {}),
    ]);
    expect(status.status).not.toBe("error");
    const points = pointsOf(timeline);
    expect(points[0]?.status).toBe("analyzed");
    expect(points[1]?.status).toBe("unanalyzed");
    expect(String(points[1]?.unanalyzedReason)).toMatch(/^commit-byte-budget-exceeded: /);
    expect(String(points[1]?.unanalyzedReason)).toContain("CAUSORYN_HISTORY_MAX_COMMIT_BYTES");
    const warnings = timeline.warnings as string[];
    expect(
      warnings.some(
        (warning) =>
          warning.startsWith(`'t2' (commit ${repo.sha("t2").slice(0, 12)}) was not analyzed from its git objects: commit-byte-budget-exceeded: `),
      ),
      JSON.stringify(warnings),
    ).toBe(true);
    // Only the analyzed commit is cached.
    const cached = historyFiles(session.dataDir);
    expect(cached).toHaveLength(1);
    expect(cached[0]?.startsWith(`${repo.sha("t1")}-`)).toBe(true);
  });

  it("the fresh analyses of one call share CAUSORYN_HISTORY_MAX_REQUEST_BYTES; the next call continues from the cache", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    // t1 reads a.ts; t2 would read a.ts + b.ts on top: one byte too many for this call.
    process.env["CAUSORYN_HISTORY_MAX_REQUEST_BYTES"] = String(2 * bytes(A_TS) + bytes(B_TS) - 1);

    const first = pointsOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    expect(first[0]?.status).toBe("analyzed");
    expect(first[1]?.status).toBe("unanalyzed");
    expect(String(first[1]?.unanalyzedReason)).toMatch(/^request-byte-budget-exceeded: /);
    expect(String(first[1]?.unanalyzedReason)).toContain("CAUSORYN_HISTORY_MAX_REQUEST_BYTES");

    // t1 comes from the cache (no bytes read), so t2 fits into the next call's budget.
    const second = pointsOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    expect(second.map((point) => point.status)).toEqual(["analyzed", "analyzed"]);
  });

  it("an analysis past CAUSORYN_HISTORY_MAX_ANALYSIS_MS (injected clock) stops reading blobs and reports analysis-deadline-exceeded", async () => {
    const repo = makeRepo(20);
    const context = directContext(repo.root);
    let now = 0;
    const blobReads: string[] = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      if (isBlobRead(args)) {
        blobReads.push(args[args.length - 1] ?? "");
        now += 100_000;
      }
      return defaultGitProcessRunner(file, args, options);
    });
    const sources = createTrustedHistorySources(context, "history-budget", repo.root, {
      maxFreshAnalyses: 4,
      limits: limits({ maxAnalysisMs: 60_000, maxRequestMs: 10_000_000 }),
      now: () => now,
    });

    const result = await sources.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
    expect(result).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^analysis-deadline-exceeded: .*CAUSORYN_HISTORY_MAX_ANALYSIS_MS/) as unknown as string,
    });
    // t1 has 21 files; the readers stop instead of reading the rest.
    expect(blobReads.length).toBeLessThan(21);
    expect(
      sources
        .notes()
        .some((note) => note.startsWith(`'t1' (commit ${repo.sha("t1").slice(0, 12)}) was not analyzed from its git objects: analysis-deadline-exceeded: `)),
    ).toBe(true);
  });

  it("the call deadline CAUSORYN_HISTORY_MAX_REQUEST_MS stops the running analysis and every later point of the call", async () => {
    const repo = makeRepo();
    const context = directContext(repo.root);
    let now = 0;
    let blobReads = 0;
    setGitProcessRunnerForTesting((file, args, options) => {
      if (isBlobRead(args)) {
        blobReads += 1;
        now += 100_000;
      }
      return defaultGitProcessRunner(file, args, options);
    });
    const sources = createTrustedHistorySources(context, "history-budget", repo.root, {
      maxFreshAnalyses: 4,
      limits: limits({ maxAnalysisMs: 10_000_000, maxRequestMs: 60_000 }),
      now: () => now,
    });

    const first = await sources.reconstructFromGitTree(repo.root, "t2", repo.sha("t2"));
    expect(first).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^request-deadline-exceeded: .*CAUSORYN_HISTORY_MAX_REQUEST_MS/) as unknown as string,
    });
    const readsAfterFirst = blobReads;
    const second = await sources.reconstructFromGitTree(repo.root, "t3", repo.sha("t3"));
    expect(second).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^request-deadline-exceeded: /) as unknown as string,
    });
    // No blob of the later point was read.
    expect(blobReads).toBe(readsAfterFirst);
  });

  it("the deadline also stops the scratch index at its next phase boundary", async () => {
    const repo = makeRepo();
    let now = 0;
    // The scratch index reads the context clock (ISO time) while it builds;
    // the first read moves the injected monotonic clock past the deadline.
    let mode: "count" | "jump" | "off" = "off";
    let clockReads = 0;
    const context = directContext(repo.root, () => {
      if (mode !== "off") clockReads += 1;
      if (mode === "jump") now = 100_000;
      return "2026-01-01T00:00:00.000Z";
    });
    let blobReads = 0;
    setGitProcessRunnerForTesting((file, args, options) => {
      if (isBlobRead(args)) blobReads += 1;
      return defaultGitProcessRunner(file, args, options);
    });
    const open = () =>
      createTrustedHistorySources(context, "history-budget", repo.root, {
        maxFreshAnalyses: 4,
        limits: limits({ maxAnalysisMs: 60_000, maxRequestMs: 10_000_000 }),
        now: () => now,
      });

    // A complete scratch index run of t3, for reference.
    mode = "count";
    expect(isContentSet(await open().reconstructFromGitTree(repo.root, "t3", repo.sha("t3")))).toBe(true);
    const completeRunReads = clockReads;
    expect(completeRunReads).toBeGreaterThan(2);

    mode = "jump";
    clockReads = 0;
    blobReads = 0;
    const result = await open().reconstructFromGitTree(repo.root, "t3", repo.sha("t3"));
    mode = "off";
    expect(result).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^analysis-deadline-exceeded: /) as unknown as string,
    });
    // The inventory was read completely: the deadline passed inside the scratch index ...
    expect(blobReads).toBe(3);
    // ... which stopped at its next phase boundary instead of building and publishing.
    expect(clockReads).toBeLessThan(completeRunReads - 1);
  });

  it("with CAUSORYN_HISTORY_MAX_CONCURRENT=1 a second simultaneous fresh analysis gets analysis-busy, or waits a bounded time", async () => {
    const repo = makeRepo();
    const context = directContext(repo.root);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let blockNext = true;
    setGitProcessRunnerForTesting(async (file, args, options) => {
      if (isBlobRead(args) && blockNext) {
        blockNext = false;
        signalStarted();
        await firstBlocked;
      }
      return defaultGitProcessRunner(file, args, options);
    });
    const open = (busyWaitMs: number) =>
      createTrustedHistorySources(context, "history-budget", repo.root, {
        maxFreshAnalyses: 4,
        limits: limits({ maxConcurrentAnalyses: 1, busyWaitMs }),
      });

    const holder = open(0);
    const held = holder.reconstructFromGitTree(repo.root, "t1", repo.sha("t1"));
    await firstStarted;

    // No waiting: controlled outcome right away.
    const busy = open(0);
    const busyResult = await busy.reconstructFromGitTree(repo.root, "t2", repo.sha("t2"));
    expect(busyResult).toEqual({
      status: "unanalyzed",
      reason: expect.stringMatching(/^analysis-busy: .*CAUSORYN_HISTORY_MAX_CONCURRENT/) as unknown as string,
    });

    // Bounded wait: the analysis starts once the running one has finished.
    const waiter = open(60_000);
    let waiterDone = false;
    const waited = waiter.reconstructFromGitTree(repo.root, "t3", repo.sha("t3")).then((value) => {
      waiterDone = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waiterDone).toBe(false);
    releaseFirst();
    expect(isContentSet(await held)).toBe(true);
    expect(isContentSet(await waited)).toBe(true);

    // A bounded wait that runs out is busy as well.
    const slot = await acquireHistoryAnalysisSlot(1, 0);
    expect(slot).toBeDefined();
    try {
      const shortWait = open(30);
      const timedOut = await shortWait.reconstructFromGitTree(repo.root, "t2", repo.sha("t2"));
      expect(timedOut).toEqual({
        status: "unanalyzed",
        reason: expect.stringMatching(/^analysis-busy: /) as unknown as string,
      });
    } finally {
      slot?.();
    }
  });

  it("while the process-wide analysis slot is taken the history tools answer with analysis-busy and other tools keep answering", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    process.env["CAUSORYN_HISTORY_BUSY_WAIT_MS"] = "0";
    const release = await acquireHistoryAnalysisSlot(1, 0);
    expect(release).toBeDefined();
    cleanups.push(() => release?.());

    const [timeline, status] = await Promise.all([
      session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }),
      session.call("causoryn_status", {}),
    ]);
    expect(status.status).not.toBe("error");
    for (const point of pointsOf(timeline)) {
      expect(point.status).toBe("unanalyzed");
      expect(String(point.unanalyzedReason)).toMatch(/^analysis-busy: /);
    }
    expect(historyFiles(session.dataDir)).toEqual([]);

    release?.();
    const after = pointsOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    expect(after.map((point) => point.status)).toEqual(["analyzed", "analyzed"]);
  });

  it("invalid budget environment values are logged and the defaults apply", async () => {
    const repo = makeRepo();
    const session = await openSession(repo.root);
    process.env["CAUSORYN_HISTORY_MAX_COMMIT_BYTES"] = "0";
    process.env["CAUSORYN_HISTORY_MAX_REQUEST_BYTES"] = "lots";
    process.env["CAUSORYN_HISTORY_MAX_ANALYSIS_MS"] = "-5";
    process.env["CAUSORYN_HISTORY_MAX_REQUEST_MS"] = "1.5";
    process.env["CAUSORYN_HISTORY_MAX_CONCURRENT"] = "0";
    process.env["CAUSORYN_HISTORY_BUSY_WAIT_MS"] = "soon";

    const points = pointsOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    expect(points.map((point) => point.status)).toEqual(["analyzed", "analyzed"]);
    for (const name of ENV_NAMES.slice(1)) {
      expect(
        session.logs.some((line) => line.includes(name) && line.includes("ignoring")),
        `${name}: ${JSON.stringify(session.logs)}`,
      ).toBe(true);
    }
  });
});
