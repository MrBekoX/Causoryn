import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultGitProcessRunner,
  setGitProcessRunnerForTesting,
} from "../packages/graph/src/git-read.js";
import { InMemoryGraphRepository } from "../packages/graph/src/index.js";
import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
  type CausorynContext,
} from "../packages/mcp-server/src/index.js";

/**
 * History tools analyze a commit from its git objects when no trusted index
 * snapshot covers it: the commit tree is listed and its blobs are read with
 * the hardened read-only git helpers (never checked out), the policy-allowed
 * files are indexed in memory by a scratch IndexService, and the result is a
 * symbol-level point. With a data root the result is cached under
 * `<data root>/history/`; fresh analyses per call are budgeted.
 */

const ANALYZED_NOTE =
  "was analyzed from its git objects (source files from the commit; project files and installed packages from the working tree)";
const CACHED_NOTE = "served from the history cache";
const TRUST_WARNING = "snapshot-loaded-from-committed-git-blob";
const BUDGET_ENV = "CAUSORYN_HISTORY_MAX_ANALYSES";

const pythonAvailable = spawnSync("python", ["--version"], { stdio: "ignore" }).status === 0;

const cleanups: Array<() => void> = [];
afterEach(() => {
  setGitProcessRunnerForTesting(undefined);
  delete process.env[BUDGET_ENV];
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => removeDir(dir));
  return dir;
}

interface Repo {
  readonly root: string;
  readonly git: (...args: string[]) => string;
  readonly write: (relativePath: string, content: string) => void;
  readonly commit: (message: string, tag: string) => string;
  readonly sha: (ref: string) => string;
}

function makeRepo(prefix = "causoryn-history-analysis-"): Repo {
  const root = makeTempDir(prefix);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
    });
  const write = (relativePath: string, content: string): void => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@causoryn.local");
  git("config", "user.name", "Causoryn Fixture");
  git("config", "commit.gpgsign", "false");
  const commit = (message: string, tag: string): string => {
    git("add", "-A");
    git("commit", "-m", message);
    git("tag", tag);
    return git("rev-parse", "HEAD").trim();
  };
  const sha = (ref: string): string => git("rev-parse", `${ref}^{commit}`).trim();
  return { root, git, write, commit, sha };
}

const ORDERS_V1 =
  "export class OrdersService {\n  create(sku: string): string {\n    return `ord:${sku}`;\n  }\n}\n";
const ORDERS_V2 =
  "export class OrdersService {\n  create(sku: string): string {\n    return `ord:${sku}`;\n  }\n\n  cancel(id: string): boolean {\n    return id.length > 0;\n  }\n}\n";
const BILLING =
  "export class BillingService {\n  charge(id: string): boolean {\n    return id.length > 0;\n  }\n}\n";
const NOTIFY = "export function notifyCustomer(id: string): string {\n  return `sent:${id}`;\n}\n";
const SERVICE_PY_V1 = "def handle_order(order_id):\n    return order_id\n";
const SERVICE_PY_V2 =
  "def handle_order(order_id):\n    return order_id\n\n\ndef refund_order(order_id):\n    return order_id\n";

/** t1 → t2 → t3 (HEAD); no committed architecture snapshot anywhere. */
function makeHistoryRepo(options: { readonly python?: boolean } = {}): Repo {
  const repo = makeRepo();
  repo.write("README.md", "# history fixture\n");
  repo.write("src/orders.ts", ORDERS_V1);
  if (options.python === true) repo.write("app/service.py", SERVICE_PY_V1);
  repo.commit("t1", "t1");
  repo.write("src/orders.ts", ORDERS_V2);
  repo.write("src/billing.ts", BILLING);
  if (options.python === true) repo.write("app/service.py", SERVICE_PY_V2);
  repo.commit("t2", "t2");
  repo.write("src/notify.ts", NOTIFY);
  repo.commit("t3", "t3");
  return repo;
}

interface Session {
  readonly context: CausorynContext;
  readonly dataDir: string | undefined;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly callRaw: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function openSession(
  root: string,
  options: {
    readonly dataRoot?: boolean;
    readonly autoIndex?: boolean;
    readonly config?: Record<string, unknown>;
  } = {},
): Promise<Session> {
  const dataDir = options.dataRoot === false ? undefined : makeTempDir("causoryn-history-data-");
  const context = createCausorynContext(
    {
      workspaceId: "history-analysis",
      allowRoots: [root],
      autoIndex: options.autoIndex ?? false,
      ...(dataDir === undefined ? {} : { storage: { dataDbPath: path.join(dataDir, "graph.sqlite") } }),
      ...(options.config ?? {}),
    },
    { logger: () => {} },
  );
  const server = createCausorynMcpServer(context, { toolProfile: "history" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-analysis-test", version: "0.0.0" });
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
    callRaw,
    call: async (name, args) => {
      const envelope = await callRaw(name, args);
      expect(envelope.status, JSON.stringify(envelope)).not.toBe("error");
      return envelope;
    },
  };
}

function warningsOf(envelope: Record<string, unknown>): string[] {
  return envelope.warnings as string[];
}

function diffOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return (envelope.data as Record<string, unknown>).diff as Record<string, unknown>;
}

function namesOf(changes: unknown): string[] {
  return (changes as Array<{ node: { qualifiedName: string } }>).map((entry) => entry.node.qualifiedName);
}

function timelineOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return (envelope.data as Record<string, unknown>).timeline as Record<string, unknown>;
}

function analyzedNote(ref: string, sha: string): string {
  return `'${ref}' (commit ${sha.slice(0, 12)}) ${ANALYZED_NOTE}`;
}

function historyFiles(dataDir: string | undefined): string[] {
  if (dataDir === undefined) return [];
  const dir = path.join(dataDir, "history");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Every path below `root` except `.git` (POSIX, sorted). */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(relative);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("history tools analyze commits from their git objects", { timeout: 180_000 }, () => {
  it("compare HEAD~1 → HEAD returns symbol-level differences for commits without a committed snapshot, then serves them from the cache", async () => {
    const repo = makeHistoryRepo();
    const statusBefore = repo.git("status", "--porcelain");
    const treeBefore = listTree(repo.root);
    const session = await openSession(repo.root);

    const first = await session.call("causoryn_compare_architecture", {
      baseRef: "HEAD~1",
      targetRef: "HEAD",
    });
    const diff = diffOf(first);
    expect(namesOf(diff.added)).toContain("notifyCustomer");
    expect(namesOf(diff.removed)).toEqual([]);
    expect(namesOf(diff.changed)).toEqual([]);
    expect((diff.summary as Record<string, number>).unchangedNodes).toBeGreaterThan(3);
    const warnings = warningsOf(first);
    expect(warnings).toContain(analyzedNote("HEAD~1", repo.sha("HEAD~1")));
    expect(warnings).toContain(analyzedNote("HEAD", repo.sha("HEAD")));
    expect(warnings.some((warning) => warning.includes(TRUST_WARNING))).toBe(false);
    expect(warnings.some((warning) => warning.includes(CACHED_NOTE))).toBe(false);

    // Cached under the data root, keyed by commit; nothing in the workspace.
    const cached = historyFiles(session.dataDir);
    expect(cached).toHaveLength(2);
    expect(cached.some((name) => name.startsWith(`${repo.sha("HEAD~1")}-`))).toBe(true);
    expect(cached.some((name) => name.startsWith(`${repo.sha("HEAD")}-`))).toBe(true);
    expect(cached.every((name) => name.endsWith(".json"))).toBe(true);

    const second = await session.call("causoryn_compare_architecture", {
      baseRef: "HEAD~1",
      targetRef: "HEAD",
    });
    expect(second.data).toEqual(first.data);
    expect(warningsOf(second)).toContain(`${analyzedNote("HEAD~1", repo.sha("HEAD~1"))}; ${CACHED_NOTE}`);
    expect(warningsOf(second)).toContain(`${analyzedNote("HEAD", repo.sha("HEAD"))}; ${CACHED_NOTE}`);

    expect(repo.git("status", "--porcelain")).toBe(statusBefore);
    expect(listTree(repo.root)).toEqual(treeBefore);
  });

  it("timeline over three refs analyzes every point and notes the git-object analysis", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root);
    const envelope = await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2", "t3"] });
    const timeline = timelineOf(envelope);
    expect(timeline.analyzedPoints).toBe(3);
    expect(timeline.unanalyzedPoints).toBe(0);
    const points = timeline.points as Array<Record<string, unknown>>;
    expect(points.every((point) => point.trustWarning === undefined)).toBe(true);
    const intervals = timeline.intervals as Array<Record<string, unknown>>;
    expect(intervals.map((interval) => interval.kind)).toEqual(["diff", "diff"]);
    const t1t2 = intervals[0]?.changes as Record<string, number>;
    // + BillingService, BillingService.charge, OrdersService.cancel and the billing.ts File node.
    expect(t1t2.added).toBeGreaterThanOrEqual(4);
    for (const ref of ["t1", "t2", "t3"]) {
      expect(warningsOf(envelope)).toContain(analyzedNote(ref, repo.sha(ref)));
    }
    expect(historyFiles(session.dataDir)).toHaveLength(3);
  });

  it.skipIf(!pythonAvailable)("Python sources of a commit are analyzed by the Python worker", async () => {
    const repo = makeHistoryRepo({ python: true });
    const session = await openSession(repo.root);
    const envelope = await session.call("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" });
    const added = namesOf(diffOf(envelope).added);
    expect(added.some((name) => name.endsWith("refund_order"))).toBe(true);
    expect(added).toContain("BillingService");
  });

  it("an analysis that ran without an available language worker is used but not cached", async () => {
    const repo = makeHistoryRepo({ python: true });
    const session = await openSession(repo.root);
    const previous = process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"];
    process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"] = path.join(
      makeTempDir("causoryn-no-python-worker-"),
      "missing-worker.py",
    );
    try {
      const envelope = await session.call("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t2" });
      expect(namesOf(diffOf(envelope).added)).toContain("BillingService");
      const note = warningsOf(envelope).find((warning) =>
        warning.startsWith(analyzedNote("t2", repo.sha("t2"))),
      );
      expect(note).toBeDefined();
      expect(note).toContain("not cached: a language worker was unavailable");
      expect(historyFiles(session.dataDir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"];
      else process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"] = previous;
    }
  });

  it("budget: CAUSORYN_HISTORY_MAX_ANALYSES=1 analyzes one fresh point per call and the cache carries the rest", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root);
    process.env[BUDGET_ENV] = "1";

    const first = timelineOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2", "t3"] }));
    expect(first.analyzedPoints).toBe(1);
    const firstPoints = first.points as Array<Record<string, unknown>>;
    expect(firstPoints[0]?.status).toBe("analyzed");
    for (const point of firstPoints.slice(1)) {
      expect(point.status).toBe("unanalyzed");
      expect(String(point.unanalyzedReason)).toMatch(/^analysis-budget-exceeded: /);
      expect(String(point.unanalyzedReason)).toContain("cached");
    }

    const secondEnvelope = await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2", "t3"] });
    const second = timelineOf(secondEnvelope);
    expect(second.analyzedPoints).toBe(2);
    expect(warningsOf(secondEnvelope)).toContain(`${analyzedNote("t1", repo.sha("t1"))}; ${CACHED_NOTE}`);
    expect(warningsOf(secondEnvelope)).toContain(analyzedNote("t2", repo.sha("t2")));

    const third = timelineOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2", "t3"] }));
    expect(third.analyzedPoints).toBe(3);
  });

  it("the same commit named twice in one call is analyzed once", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root);
    process.env[BUDGET_ENV] = "1";
    const envelope = await session.call("causoryn_compare_architecture", { baseRef: "t3", targetRef: "HEAD" });
    const summary = diffOf(envelope).summary as Record<string, number>;
    expect([summary.added, summary.removed, summary.changed]).toEqual([0, 0, 0]);
    expect(summary.unchangedNodes).toBeGreaterThan(3);
    expect(historyFiles(session.dataDir)).toHaveLength(1);
  });

  it("an invalid CAUSORYN_HISTORY_MAX_ANALYSES value is ignored (default budget)", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root);
    process.env[BUDGET_ENV] = "0";
    const timeline = timelineOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2", "t3"] }));
    expect(timeline.analyzedPoints).toBe(3);
  });

  it("symlinks, submodules and denied paths in a commit are never read; nothing is written into the workspace", async () => {
    const repo = makeRepo("causoryn-history-security-");
    repo.write("README.md", "# security fixture\n");
    repo.commit("base", "base");
    repo.write("src/app.ts", "export function appMain(): number {\n  return 1;\n}\n");
    repo.write(".env", "API_TOKEN=do-not-read\n");
    repo.write("keys/server.pem", "placeholder key material: do-not-read\n");
    repo.git("add", "-A");
    // A symlink entry and a submodule (gitlink) entry, written straight into the index.
    const linkBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo.root,
      input: "../outside/secret.ts",
      encoding: "utf8",
    }).trim();
    repo.git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},src/link.ts`);
    repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.sha("base")},libs/sub`);
    repo.git("commit", "-m", "with links");
    repo.git("tag", "secure");
    const statusBefore = repo.git("status", "--porcelain");
    const treeBefore = listTree(repo.root);

    const catFileTargets: string[] = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      const catFile = args.indexOf("cat-file");
      if (catFile >= 0) catFileTargets.push(args[args.length - 1] ?? "");
      return defaultGitProcessRunner(file, args, options);
    });

    const session = await openSession(repo.root);
    const envelope = await session.call("causoryn_compare_architecture", { baseRef: "base", targetRef: "secure" });
    const added = diffOf(envelope).added as Array<{ node: { qualifiedName: string; relativePath?: string } }>;
    expect(added.map((entry) => entry.node.qualifiedName)).toContain("appMain");
    const addedPaths = added.map((entry) => entry.node.relativePath ?? "");
    for (const denied of [".env", "keys/server.pem", "src/link.ts", "libs/sub"]) {
      expect(addedPaths).not.toContain(denied);
      expect(catFileTargets.some((target) => target.endsWith(`:${denied}`))).toBe(false);
    }
    expect(catFileTargets.some((target) => target.endsWith(":src/app.ts"))).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("do-not-read");

    expect(repo.git("status", "--porcelain")).toBe(statusBefore);
    expect(listTree(repo.root)).toEqual(treeBefore);
    // The cache lives under the data root, outside the workspace.
    expect(historyFiles(session.dataDir)).toHaveLength(2);
    expect(listTree(repo.root).some((entry) => entry.includes("history"))).toBe(false);
  });

  it("a data root inside the workspace never receives history cache files", async () => {
    const repo = makeHistoryRepo();
    // Startup validation of storage.dataDbPath is skipped with a repository
    // override; the history cache checks the location itself.
    const insideDataDir = path.join(repo.root, ".cache-data");
    mkdirSync(insideDataDir);
    const context = createCausorynContext(
      {
        workspaceId: "history-analysis",
        allowRoots: [repo.root],
        autoIndex: false,
        storage: { dataDbPath: path.join(insideDataDir, "graph.sqlite") },
      },
      { logger: () => {}, repository: new InMemoryGraphRepository() },
    );
    const server = createCausorynMcpServer(context, { toolProfile: "history" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "history-analysis-inside", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(() => {
      void client.close();
      void server.close();
      context.close();
    });
    const result = (await client.callTool({
      name: "causoryn_compare_architecture",
      arguments: { baseRef: "t2", targetRef: "t3" },
    })) as CallToolResult;
    const envelope = EnvelopeSchema.parse(result.structuredContent) as Record<string, unknown>;
    expect(envelope.status).toBe("ok");
    expect(warningsOf(envelope)).toContain(
      `${analyzedNote("t3", repo.sha("t3"))}; not cached: the history cache could not be written (see the server log)`,
    );
    expect(existsSync(path.join(insideDataDir, "history"))).toBe(false);
    expect(readdirSync(insideDataDir)).toEqual([]);
  });

  it("a corrupt history cache entry is ignored, removed and re-analyzed", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root);
    await session.call("causoryn_compare_architecture", { baseRef: "t2", targetRef: "t3" });
    const dir = path.join(session.dataDir as string, "history");
    const files = historyFiles(session.dataDir);
    const t2File = files.find((name) => name.startsWith(repo.sha("t2"))) as string;
    const t3File = files.find((name) => name.startsWith(repo.sha("t3"))) as string;
    writeFileSync(path.join(dir, t2File), "{ not json", "utf8");
    const t3Entry = JSON.parse(readFileSync(path.join(dir, t3File), "utf8")) as Record<string, unknown>;
    writeFileSync(
      path.join(dir, t3File),
      JSON.stringify({ ...t3Entry, contentSet: { nodes: "not-an-array", edges: [] } }),
      "utf8",
    );

    const again = await session.call("causoryn_compare_architecture", { baseRef: "t2", targetRef: "t3" });
    expect(warningsOf(again)).toContain(analyzedNote("t2", repo.sha("t2")));
    expect(warningsOf(again)).toContain(analyzedNote("t3", repo.sha("t3")));
    expect(warningsOf(again).some((warning) => warning.includes(CACHED_NOTE))).toBe(false);
    expect(namesOf(diffOf(again).added)).toContain("notifyCustomer");
    for (const name of [t2File, t3File]) {
      const rewritten = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
      expect(Array.isArray((rewritten.contentSet as Record<string, unknown>).nodes)).toBe(true);
    }
  });

  it("without a data root commits are analyzed on every call and nothing is cached", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root, { dataRoot: false });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const envelope = await session.call("causoryn_compare_architecture", { baseRef: "t2", targetRef: "t3" });
      expect(warningsOf(envelope)).toContain(analyzedNote("t2", repo.sha("t2")));
      expect(warningsOf(envelope).some((warning) => warning.includes(CACHED_NOTE))).toBe(false);
    }
    process.env[BUDGET_ENV] = "1";
    const timeline = timelineOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t2"] }));
    const reason = String((timeline.points as Array<Record<string, unknown>>)[1]?.unanalyzedReason);
    expect(reason).toMatch(/^analysis-budget-exceeded: /);
    expect(reason).toContain("data root");
  });

  it("an analysis failure leaves the point unanalyzed with a clear reason instead of failing the tool", async () => {
    const repo = makeHistoryRepo();
    const session = await openSession(repo.root, { config: { index: { maxFiles: 2 } } });
    const timeline = timelineOf(await session.call("causoryn_architecture_timeline", { refs: ["t1", "t3"] }));
    const points = timeline.points as Array<Record<string, unknown>>;
    // t1 has 2 files; t3 has 4 (README.md + 3 sources) — above index.maxFiles.
    expect(points[0]?.status).toBe("analyzed");
    expect(points[1]?.status).toBe("unanalyzed");
    expect(String(points[1]?.unanalyzedReason)).toMatch(/^commit-analysis-failed: .*index\.maxFiles \(2\)/);

    const compare = await session.callRaw("causoryn_compare_architecture", { baseRef: "t1", targetRef: "t3" });
    expect(compare.status).toBe("error");
    const error = compare.error as Record<string, unknown>;
    expect(error.code).toBe("INVALID_REVISION");
    expect(String(error.message)).toContain("index.maxFiles");
  });

  it("a commit analyzed from git objects has the granularity of the index built from the same content", async () => {
    const repo = makeRepo("causoryn-history-granularity-");
    repo.write("src/orders.ts", ORDERS_V2);
    repo.write("src/billing.ts", BILLING);
    repo.write("src/notify.ts", NOTIFY);
    repo.commit("only", "only");
    const session = await openSession(repo.root, { autoIndex: true });
    const indexed = session.context.repository.getLatestPublished("history-analysis");
    expect(indexed).toBeDefined();
    // The working tree no longer proves the commit, so HEAD is analyzed from git objects.
    repo.write("src/notify.ts", `${NOTIFY}// edited after indexing\n`);

    const envelope = await session.call("causoryn_compare_architecture", {
      baseRef: "HEAD",
      targetRef: "working-tree",
    });
    expect(warningsOf(envelope)).toContain(analyzedNote("HEAD", repo.sha("HEAD")));
    const summary = diffOf(envelope).summary as Record<string, number>;
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.changed).toBe(0);
    expect(summary.edgeAdded).toBe(0);
    expect(summary.edgeRemoved).toBe(0);
    expect(summary.unchangedNodes).toBe(indexed?.snapshot.nodes.length);
  });
});
