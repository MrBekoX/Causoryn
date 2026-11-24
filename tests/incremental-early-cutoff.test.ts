import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { snapshotCanonicalJson } from "@causoryn/domain";
import { IndexService } from "@causoryn/indexing";
import { SCHEMA_VERSION, SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

const WS = "ws_incremental_cutoff";
const T0 = "2026-11-24T13:00:00.000Z";
const T1 = "2026-11-24T13:05:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-inc-cutoff-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Creates a 20-file TypeScript fixture repo:
 * - src/math.ts (shared core leaf, imported by 5 callers)
 * - src/caller_0.ts .. src/caller_4.ts (import and call add() from ./math.js)
 * - src/unrelated_0.ts .. src/unrelated_13.ts (14 independent modules)
 */
function create20FileWorkspace(rootDir: string, mathContent: string): void {
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src", "math.ts"), mathContent, "utf8");

  for (let i = 0; i < 5; i += 1) {
    writeFileSync(
      path.join(rootDir, "src", `caller_${i}.ts`),
      [
        `import { add } from "./math.js";`,
        `export function computeForCaller${i}(x: number): number {`,
        `  return add(x, ${i + 1});`,
        `}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  for (let i = 0; i < 14; i += 1) {
    writeFileSync(
      path.join(rootDir, "src", `unrelated_${i}.ts`),
      [
        `export interface Widget${i} { readonly id: string; readonly count: number; }`,
        `export function buildWidget${i}(id: string): Widget${i} {`,
        `  return { id, count: ${i} };`,
        `}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

const MATH_V1 = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const MATH_V2_COMMENT_AND_BODY = [
  "// Added explanation comment without changing exported signature",
  "export function add(a: number, b: number): number {",
  "  const total = a + b;",
  "  return total;",
  "}",
  "",
].join("\n");

const MATH_V3_SIGNATURE_CHANGE = [
  "export function add(a: number, b: number, c: number = 0): number {",
  "  return a + b + c;",
  "}",
  "export function multiply(a: number, b: number): number {",
  "  return a * b;",
  "}",
  "",
].join("\n");

describe("Task 2.6 — Schema v4 & True Per-File Incremental Indexing with Early Cutoff", { timeout: 45_000 }, () => {
  it("bumps SCHEMA_VERSION to 4, creates file_facts table, and migrates v3 DB cleanly to v4", () => {
    expect(SCHEMA_VERSION).toBe(4);
    const dbFile = path.join(tempRoot, "v4-fresh.sqlite");
    const repo = new SqliteGraphRepository(dbFile);
    try {
      const probe = new Database(dbFile, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(4);
        const tables = (
          probe
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(tables).toContain("file_facts");
        expect(tables).toContain("build_leases");
        expect(tables).toContain("symbol_fts");
      } finally {
        probe.close();
      }
    } finally {
      repo.close();
    }

    // Also test v3 -> v4 backward-compatible migration with existing published node & old 3-col symbol_fts
    const legacyFile = path.join(tempRoot, "v3-legacy.sqlite");
    const legacy = new Database(legacyFile);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE files (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, relative_path));
      CREATE TABLE snapshots (sid INTEGER PRIMARY KEY, id TEXT UNIQUE, build_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, revision_id TEXT NOT NULL, revision_sequence INTEGER NOT NULL, config_hash TEXT NOT NULL, analyzer_fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('building','ready','partial','failed')), created_at TEXT NOT NULL, published_at TEXT, failure_reason TEXT);
      CREATE TABLE build_leases (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, build_id TEXT NOT NULL, lease_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, host_label TEXT, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE nodes (snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE, node_id TEXT NOT NULL, kind TEXT NOT NULL, qualified_name TEXT NOT NULL, language TEXT, relative_path TEXT, start_line INTEGER, end_line INTEGER, source_hash TEXT, attributes_json TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (snapshot_sid, node_id));
      CREATE TABLE edges (snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE, edge_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL CHECK (resolution IN ('verified','heuristic','unresolved')), evidence_ids_json TEXT NOT NULL, ambiguity_json TEXT, position INTEGER NOT NULL, PRIMARY KEY (snapshot_sid, edge_id));
      CREATE TABLE evidence (snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE, evidence_id TEXT NOT NULL, kind TEXT NOT NULL, relative_path TEXT, start_line INTEGER, end_line INTEGER, source_hash TEXT, analyzer_id TEXT NOT NULL, analyzer_version TEXT NOT NULL, rationale TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (snapshot_sid, evidence_id));
      CREATE VIRTUAL TABLE symbol_fts USING fts5(symbol, node_id UNINDEXED, snapshot_sid UNINDEXED);
      INSERT INTO workspaces VALUES ('${WS}', '/tmp/v3', '${T0}');
      INSERT INTO snapshots VALUES (1, 'snapshot:${"a".repeat(64)}', 'build-1', '${WS}', 'rev-1', 1, 'cfg', 'fp', 'ready', '${T0}', '${T0}', NULL);
      INSERT INTO nodes VALUES (1, 'node:${"b".repeat(64)}', 'Function', 'registerTool', 'typescript', 'packages/mcp-server/src/server.ts', 1, 5, 'h1', '{}', 1);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new SqliteGraphRepository(legacyFile);
    try {
      const hits = migrated.searchSymbols("register mcp tool", 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.symbol).toBe("registerTool");
      expect(migrated.listFileFacts(WS)).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("early cutoff: comment/body edit re-analyzes ONLY 1 file, skips 19 cached files, and matches clean full index snapshot ID identically", async () => {
    const wsInc = path.join(tempRoot, "ws-inc");
    const wsFull = path.join(tempRoot, "ws-full");
    create20FileWorkspace(wsInc, MATH_V1);

    const dbInc = path.join(tempRoot, "inc.sqlite");
    const dbFull = path.join(tempRoot, "full.sqlite");

    const repoInc = new SqliteGraphRepository(dbInc);
    const repoFull = new SqliteGraphRepository(dbFull);
    try {
      let now = T0;
      const serviceInc = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsInc] }),
        repository: repoInc,
        clock: () => now,
        limits: { maxFiles: 200 },
      });

      const first = await serviceInc.runIndexAsync(wsInc);
      expect(first.published).toBe(true);
      expect(first.tsFileCount).toBe(20);
      expect(first.reanalyzedFiles).toBe(20);
      expect(first.cachedFiles).toBe(0);

      // Edit ONLY comments and internal function body of src/math.ts
      writeFileSync(path.join(wsInc, "src", "math.ts"), MATH_V2_COMMENT_AND_BODY, "utf8");
      now = T1;
      const incremental = await serviceInc.runIncrementalIndexAsync(wsInc, ["src/math.ts"]);

      expect(incremental.published).toBe(true);
      expect(incremental.earlyCutoffApplied).toBe(true);
      expect(incremental.reanalyzedFiles).toBe(1);
      expect(incremental.cachedFiles).toBe(19);
      expect(incremental.state).toBe("ready");

      // Compare against a clean full index of the EXACT SAME workspace directory at the same sequence (2)
      const serviceFull = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsInc] }),
        repository: repoFull,
        clock: () => T0,
        limits: { maxFiles: 200 },
      });
      // Run seq 1 on V1? Even simpler: run seq 1 on wsFull(V1) then seq 2 on wsInc(V2),
      // OR run full(V1) -> edit -> full(V2) on wsFull with same root!
      // Same workspace directory (wsInc) ensures identical Workspace rootPath attribute too!
      writeFileSync(path.join(wsInc, "src", "math.ts"), MATH_V1, "utf8");
      await serviceFull.runIndexAsync(wsInc); // seq 1
      writeFileSync(path.join(wsInc, "src", "math.ts"), MATH_V2_COMMENT_AND_BODY, "utf8");
      const cleanFull = await serviceFull.runIndexAsync(wsInc); // seq 2

      // Exact determinism guarantee: incremental snapshot ID === clean full-index snapshot ID!
      expect(incremental.snapshot.meta.revision.sequence).toBe(cleanFull.snapshot.meta.revision.sequence);
      expect(incremental.snapshot.meta.analyzerFingerprint).toBe(cleanFull.snapshot.meta.analyzerFingerprint);
      expect(incremental.snapshotId).toBe(cleanFull.snapshotId);
      expect(
        snapshotCanonicalJson({
          ...incremental.snapshot,
          meta: { ...incremental.snapshot.meta, createdAt: T0 },
        }),
      ).toBe(
        snapshotCanonicalJson({
          ...cleanFull.snapshot,
          meta: { ...cleanFull.snapshot.meta, createdAt: T0 },
        }),
      );
    } finally {
      repoInc.close();
      repoFull.close();
      rmSync(wsFull, { recursive: true, force: true });
    }
  });

  it("signature change invalidates changed file + direct reverse dependents (6 files), keeps 14 unrelated files cached, and matches clean full index ID", async () => {
    const wsDir = path.join(tempRoot, "ws-sig");
    create20FileWorkspace(wsDir, MATH_V1);

    const repoInc = new SqliteGraphRepository(path.join(tempRoot, "sig-inc.sqlite"));
    const repoFull = new SqliteGraphRepository(path.join(tempRoot, "sig-full.sqlite"));
    try {
      let now = T0;
      const serviceInc = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoInc,
        clock: () => now,
        limits: { maxFiles: 200 },
      });

      await serviceInc.runIndexAsync(wsDir); // seq 1

      // Change exported signature and add new export `multiply` in src/math.ts
      writeFileSync(path.join(wsDir, "src", "math.ts"), MATH_V3_SIGNATURE_CHANGE, "utf8");
      now = T1;
      const incremental = await serviceInc.runIncrementalIndexAsync(wsDir, ["src/math.ts"]);

      expect(incremental.published).toBe(true);
      expect(incremental.earlyCutoffApplied).toBe(false);
      // 1 changed (math.ts) + 5 direct callers (caller_0..caller_4) = 6 reanalyzed; 14 unrelated cached!
      expect(incremental.reanalyzedFiles).toBe(6);
      expect(incremental.cachedFiles).toBe(14);
      expect(incremental.snapshot.nodes.some((n) => n.qualifiedName === "multiply")).toBe(true);

      // Verify exact determinism against clean full index at sequence 2
      const serviceFull = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoFull,
        clock: () => T0,
        limits: { maxFiles: 200 },
      });
      writeFileSync(path.join(wsDir, "src", "math.ts"), MATH_V1, "utf8");
      await serviceFull.runIndexAsync(wsDir); // seq 1
      writeFileSync(path.join(wsDir, "src", "math.ts"), MATH_V3_SIGNATURE_CHANGE, "utf8");
      const cleanFull = await serviceFull.runIndexAsync(wsDir); // seq 2

      expect(incremental.snapshotId).toBe(cleanFull.snapshotId);
    } finally {
      repoInc.close();
      repoFull.close();
    }
  });

  it("editing an importing caller file preserves all verified cross-file edges and matches clean full index identically", async () => {
    const wsDir = path.join(tempRoot, "ws-caller-edit");
    create20FileWorkspace(wsDir, MATH_V1);

    const repoInc = new SqliteGraphRepository(path.join(tempRoot, "caller-inc.sqlite"));
    const repoFull = new SqliteGraphRepository(path.join(tempRoot, "caller-full.sqlite"));
    try {
      let now = T0;
      const serviceInc = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoInc,
        clock: () => now,
        limits: { maxFiles: 200 },
      });

      await serviceInc.runIndexAsync(wsDir); // seq 1

      const updatedCaller = [
        "// Body-only comment & local var edit inside caller_0",
        `import { add } from "./math.js";`,
        `export function computeForCaller0(x: number): number {`,
        `  const res = add(x, 1);`,
        `  return res;`,
        `}`,
        "",
      ].join("\n");
      writeFileSync(path.join(wsDir, "src", "caller_0.ts"), updatedCaller, "utf8");
      now = T1;
      const incremental = await serviceInc.runIncrementalIndexAsync(wsDir, ["src/caller_0.ts"]);

      expect(incremental.published).toBe(true);
      expect(incremental.earlyCutoffApplied).toBe(true);
      expect(incremental.reanalyzedFiles).toBe(1);
      expect(incremental.cachedFiles).toBe(19);

      // Verify caller_0 -> math.add CALLS edge is still verified (forward dependency context included!)
      const nodesById = new Map(incremental.snapshot.nodes.map((n) => [n.id, n]));
      const verifiedCall = incremental.snapshot.edges.find(
        (e) =>
          e.kind === "CALLS" &&
          e.resolution === "verified" &&
          nodesById.get(e.from)?.qualifiedName === "computeForCaller0" &&
          nodesById.get(e.to)?.qualifiedName === "add",
      );
      expect(verifiedCall).toBeDefined();

      // Compare against clean full index at seq 2
      const serviceFull = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoFull,
        clock: () => T0,
        limits: { maxFiles: 200 },
      });
      create20FileWorkspace(wsDir, MATH_V1);
      await serviceFull.runIndexAsync(wsDir); // seq 1
      writeFileSync(path.join(wsDir, "src", "caller_0.ts"), updatedCaller, "utf8");
      const cleanFull = await serviceFull.runIndexAsync(wsDir); // seq 2

      expect(incremental.snapshotId).toBe(cleanFull.snapshotId);
    } finally {
      repoInc.close();
      repoFull.close();
    }
  });

  it("Finding #7a(i): regex literal containing quotes (const r = /\"/g) and nested template expressions do not corrupt interface surface and still invalidate dependents on later export signature change", async () => {
    const wsDir = path.join(tempRoot, "ws-regex-tpl");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });

    const libV1 = [
      "export function sanitize(input: string): string {",
      '  const r = /"/g;',
      "  return input.replace(r, '');",
      "}",
      "export function formatValue(x: number): string {",
      "  return String(x);",
      "}",
      "",
    ].join("\n");

    const libV2SigChange = [
      "export function sanitize(input: string): string {",
      '  const r = /"/g;',
      "  return input.replace(r, '');",
      "}",
      "export function formatValue(x: number, radix: number = 10): string {",
      "  return x.toString(radix);",
      "}",
      "",
    ].join("\n");

    const tplV1 = [
      "export function wrap(input: string): string {",
      "  return `prefix ${input.replace('a', '`')} suffix`;",
      "}",
      "export function compute(x: number): number {",
      "  return x;",
      "}",
      "",
    ].join("\n");

    const tplV2SigChange = [
      "export function wrap(input: string): string {",
      "  return `prefix ${input.replace('a', '`')} suffix`;",
      "}",
      "export function compute(x: number, y: number = 0): number {",
      "  return x + y;",
      "}",
      "",
    ].join("\n");

    const consumerSrc = [
      'import { formatValue } from "./lib.js";',
      'import { compute } from "./tpl.js";',
      "export function render(n: number): string {",
      "  return formatValue(compute(n));",
      "}",
      "",
    ].join("\n");

    writeFileSync(path.join(wsDir, "src", "lib.ts"), libV1, "utf8");
    writeFileSync(path.join(wsDir, "src", "tpl.ts"), tplV1, "utf8");
    writeFileSync(path.join(wsDir, "src", "consumer.ts"), consumerSrc, "utf8");

    const repoInc = new SqliteGraphRepository(path.join(tempRoot, "regex-inc.sqlite"));
    const repoFull = new SqliteGraphRepository(path.join(tempRoot, "regex-full.sqlite"));
    try {
      let now = T0;
      const serviceInc = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoInc,
        clock: () => now,
        limits: { maxFiles: 100 },
      });
      await serviceInc.runIndexAsync(wsDir); // seq 1

      // 1) Regex literal `/"/g` before edited export signature must NOT trigger false early cutoff
      writeFileSync(path.join(wsDir, "src", "lib.ts"), libV2SigChange, "utf8");
      now = T1;
      const inc = await serviceInc.runIncrementalIndexAsync(wsDir, ["src/lib.ts"]);

      expect(inc.published).toBe(true);
      expect(inc.earlyCutoffApplied).toBe(false);
      expect(inc.reanalyzedFiles).toBe(2);
      expect(inc.cachedFiles).toBe(1);

      // 2) Nested template literal `${input.replace('a', '`')}` before edited export signature must NOT trigger false early cutoff
      writeFileSync(path.join(wsDir, "src", "tpl.ts"), tplV2SigChange, "utf8");
      now = "2026-11-24T13:07:00.000Z";
      const incTpl = await serviceInc.runIncrementalIndexAsync(wsDir, ["src/tpl.ts"]);
      expect(incTpl.published).toBe(true);
      expect(incTpl.earlyCutoffApplied).toBe(false);
      expect(incTpl.reanalyzedFiles).toBe(2);
      expect(incTpl.cachedFiles).toBe(1);

      const serviceFull = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repoFull,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      writeFileSync(path.join(wsDir, "src", "lib.ts"), libV1, "utf8");
      writeFileSync(path.join(wsDir, "src", "tpl.ts"), tplV1, "utf8");
      await serviceFull.runIndexAsync(wsDir); // seq 1
      writeFileSync(path.join(wsDir, "src", "lib.ts"), libV2SigChange, "utf8");
      await serviceFull.runIndexAsync(wsDir); // seq 2
      writeFileSync(path.join(wsDir, "src", "tpl.ts"), tplV2SigChange, "utf8");
      const cleanFull = await serviceFull.runIndexAsync(wsDir); // seq 3
      expect(incTpl.snapshotId).toBe(cleanFull.snapshotId);
    } finally {
      repoInc.close();
      repoFull.close();
    }
  });

  it("Finding #7a(iii): generic object type argument in class extends (class Foo extends Bar<{ a: number }>) preserves class method signature tracking and avoids false early cutoff", async () => {
    const wsDir = path.join(tempRoot, "ws-generic-extends");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });

    const serviceV1 = [
      "export class Bar<T> {",
      "  protected state!: T;",
      "}",
      "export class Foo extends Bar<{ a: number; b: string }> {",
      "  public run(x: number): number {",
      "    return x;",
      "  }",
      "}",
      "export function withObjParam(x: { a: number }): number {",
      "  return x.a;",
      "}",
      "",
    ].join("\n");

    const serviceV2BodyOnly = [
      "export class Bar<T> {",
      "  protected state!: T;",
      "}",
      "export class Foo extends Bar<{ a: number; b: string }> {",
      "  public run(x: number): number {",
      "    const result = x + 0;",
      "    return result;",
      "  }",
      "}",
      "export function withObjParam(x: { a: number }): number {",
      "  const val = x.a;",
      "  return val;",
      "}",
      "",
    ].join("\n");

    const serviceV3MethodSigChange = [
      "export class Bar<T> {",
      "  protected state!: T;",
      "}",
      "export class Foo extends Bar<{ a: number; b: string }> {",
      "  public run(x: number, scale: number = 1): number {",
      "    return x * scale;",
      "  }",
      "}",
      "export function withObjParam(x: { a: number }): number {",
      "  return x.a;",
      "}",
      "",
    ].join("\n");

    const consumerSrc = [
      'import { Foo, withObjParam } from "./service.js";',
      "export function invoke(): number {",
      "  return new Foo().run(1) + withObjParam({ a: 2 });",
      "}",
      "",
    ].join("\n");

    writeFileSync(path.join(wsDir, "src", "service.ts"), serviceV1, "utf8");
    writeFileSync(path.join(wsDir, "src", "consumer.ts"), consumerSrc, "utf8");

    const repo = new SqliteGraphRepository(path.join(tempRoot, "generic-extends.sqlite"));
    try {
      let now = T0;
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repo,
        clock: () => now,
        limits: { maxFiles: 100 },
      });
      await service.runIndexAsync(wsDir); // seq 1

      // Body-only edit inside Foo.run and withObjParam STILL qualifies for early cutoff
      writeFileSync(path.join(wsDir, "src", "service.ts"), serviceV2BodyOnly, "utf8");
      now = T1;
      const bodyOnlyRun = await service.runIncrementalIndexAsync(wsDir, ["src/service.ts"]);
      expect(bodyOnlyRun.published).toBe(true);
      expect(bodyOnlyRun.earlyCutoffApplied).toBe(true);
      expect(bodyOnlyRun.reanalyzedFiles).toBe(1);
      expect(bodyOnlyRun.cachedFiles).toBe(1);

      // Changing Foo.run signature MUST break early cutoff and invalidate consumer.ts!
      writeFileSync(path.join(wsDir, "src", "service.ts"), serviceV3MethodSigChange, "utf8");
      now = "2026-11-24T13:10:00.000Z";
      const sigChangeRun = await service.runIncrementalIndexAsync(wsDir, ["src/service.ts"]);
      expect(sigChangeRun.published).toBe(true);
      expect(sigChangeRun.earlyCutoffApplied).toBe(false);
      expect(sigChangeRun.reanalyzedFiles).toBe(2);
      expect(sigChangeRun.cachedFiles).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("Finding #7b: non-converged >8-pass invalidation cascade falls back cleanly to full indexing instead of merging stale facts", async () => {
    const wsDir = path.join(tempRoot, "ws-deep-chain");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });

    const chainLen = 10;
    writeFileSync(
      path.join(wsDir, "src", "chain_0.ts"),
      "export function step0(x: number): number { return x + 1; }\n",
      "utf8",
    );
    for (let i = 1; i < chainLen; i += 1) {
      writeFileSync(
        path.join(wsDir, "src", `chain_${i}.ts`),
        [
          `import { step${i - 1} } from "./chain_${i - 1}.js";`,
          `export function step${i}(x: number): number { return step${i - 1}(x) + ${i}; }`,
          "",
        ].join("\n"),
        "utf8",
      );
    }

    const dbFile = path.join(tempRoot, "deep-chain.sqlite");
    const repo = new SqliteGraphRepository(dbFile);
    try {
      let now = T0;
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repo,
        clock: () => now,
        limits: { maxFiles: 100 },
      });
      await service.runIndexAsync(wsDir); // seq 1

      // Force every hop in the 10-file chain to observe an interface hash change when visited,
      // guaranteeing the dirty cascade exceeds the 8-pass loop budget.
      const rawDb = new Database(dbFile);
      try {
        rawDb
          .prepare(
            "UPDATE file_facts SET public_interface_hash = 'forced-stale-hash' WHERE workspace_id = ? AND relative_path <> 'src/chain_0.ts'",
          )
          .run(WS);
      } finally {
        rawDb.close();
      }

      writeFileSync(
        path.join(wsDir, "src", "chain_0.ts"),
        "export function step0(x: number, y: number = 0): number { return x + y + 1; }\n",
        "utf8",
      );
      now = T1;
      const run = await service.runIncrementalIndexAsync(wsDir, ["src/chain_0.ts"]);

      // Non-converged 8-pass loop must fall back to full indexing (all 10 files reanalyzed, 0 cached)
      expect(run.published).toBe(true);
      expect(run.reanalyzedFiles).toBe(chainLen);
      expect(run.cachedFiles).toBe(0);
      expect(run.state).toBe("ready");
    } finally {
      repo.close();
    }
  });

  it("Finding #7c: dangling edge endpoint in cached file_facts triggers clean full fallback instead of crashing addAdapterGraph", async () => {
    const wsDir = path.join(tempRoot, "ws-dangling-fact");
    mkdirSync(path.join(wsDir, "src"), { recursive: true });
    writeFileSync(
      path.join(wsDir, "src", "a.ts"),
      "export function alpha(): number { return 1; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "src", "b.ts"),
      "export function beta(): number { return 2; }\n",
      "utf8",
    );

    const dbFile = path.join(tempRoot, "dangling-fact.sqlite");
    const repo = new SqliteGraphRepository(dbFile);
    try {
      let now = T0;
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repo,
        clock: () => now,
        limits: { maxFiles: 100 },
      });
      await service.runIndexAsync(wsDir); // seq 1

      // Inject a dangling edge in cached file_facts for untouched src/b.ts
      const rawDb = new Database(dbFile);
      try {
        const row = rawDb
          .prepare(
            "SELECT edges_json FROM file_facts WHERE workspace_id = ? AND relative_path = 'src/b.ts'",
          )
          .get(WS) as { edges_json: string };
        const edges = JSON.parse(row.edges_json) as unknown[];
        edges.push({
          kind: "CALLS",
          from: { kind: "Function", qualifiedName: "beta", relativePath: "src/b.ts" },
          to: { kind: "Function", qualifiedName: "deletedGhost", relativePath: "src/a.ts" },
          resolution: "verified",
          evidence: [],
        });
        rawDb
          .prepare(
            "UPDATE file_facts SET edges_json = ? WHERE workspace_id = ? AND relative_path = 'src/b.ts'",
          )
          .run(JSON.stringify(edges), WS);
      } finally {
        rawDb.close();
      }

      // Edit src/a.ts (body-only) and run incremental index -> mergeFileFactOutputs detects dangling endpoint
      // and returns undefined, triggering clean full fallback without throwing!
      writeFileSync(
        path.join(wsDir, "src", "a.ts"),
        "export function alpha(): number { const n = 1; return n; }\n",
        "utf8",
      );
      now = T1;
      const run = await service.runIncrementalIndexAsync(wsDir, ["src/a.ts"]);
      expect(run.published).toBe(true);
      expect(run.state).toBe("ready");
      expect(run.reanalyzedFiles).toBe(2);
      expect(run.cachedFiles).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("Finding #7d: workspace package.json edits trigger full re-index and non-relative workspace imports without tsconfig get full TS compiler context", async () => {
    const wsDir = path.join(tempRoot, "ws-pkg-json");
    mkdirSync(path.join(wsDir, "packages", "domain", "src"), { recursive: true });
    mkdirSync(path.join(wsDir, "packages", "extra", "src"), { recursive: true });
    mkdirSync(path.join(wsDir, "packages", "service", "src"), { recursive: true });
    mkdirSync(path.join(wsDir, "packages", "unrelated", "src"), { recursive: true });

    // Intentionally NO tsconfig.json — workspace resolution relies solely on package.json!
    writeFileSync(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "monorepo", private: true, workspaces: ["packages/*"] }),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "domain", "package.json"),
      JSON.stringify({
        name: "@acme/domain",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "extra", "package.json"),
      JSON.stringify({
        name: "@acme/extra",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "service", "package.json"),
      JSON.stringify({ name: "@acme/service", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "domain", "src", "index.ts"),
      "export function makeId(seq: number): string { return `id-${seq}`; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "domain", "src", "alt.ts"),
      "export function makeId(seq: number): string { return `alt-${seq}`; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "extra", "src", "index.ts"),
      "export function tagId(id: string): string { return `[${id}]`; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "service", "src", "index.ts"),
      [
        'import { makeId } from "@acme/domain";',
        "export function runService(seq: number): string {",
        "  return makeId(seq);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "unrelated", "src", "util.ts"),
      "export function helper(): number { return 7; }\n",
      "utf8",
    );

    const repo = new SqliteGraphRepository(path.join(tempRoot, "pkg-json.sqlite"));
    try {
      let now = T0;
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [wsDir] }),
        repository: repo,
        clock: () => now,
        limits: { maxFiles: 100 },
      });

      const first = await service.runIndexAsync(wsDir);
      expect(first.published).toBe(true);
      expect(first.state).toBe("ready");

      // 1) Edit @acme/service to add a BRAND-NEW non-relative workspace import (@acme/extra)
      //    without any tsconfig.json: `hasWorkspacePackageJson` must trigger full TS compiler
      //    context so the newly added cross-package CALLS edge to packages/extra/src/index.ts
      //    resolves as `verified` (not unresolved)!
      writeFileSync(
        path.join(wsDir, "packages", "service", "src", "index.ts"),
        [
          'import { makeId } from "@acme/domain";',
          'import { tagId } from "@acme/extra";',
          "export function runService(seq: number): string {",
          "  return tagId(makeId(seq));",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      now = T1;
      const incNewPkgImport = await service.runIncrementalIndexAsync(wsDir, [
        "packages/service/src/index.ts",
      ]);
      expect(incNewPkgImport.published).toBe(true);
      expect(incNewPkgImport.reanalyzedFiles).toBe(1);
      expect(incNewPkgImport.cachedFiles).toBe(4);

      const nodesById = new Map(incNewPkgImport.snapshot.nodes.map((n) => [n.id, n]));
      const verifiedNewCrossPkgCall = incNewPkgImport.snapshot.edges.find(
        (e) =>
          e.kind === "CALLS" &&
          e.resolution === "verified" &&
          nodesById.get(e.from)?.qualifiedName === "runService" &&
          nodesById.get(e.to)?.qualifiedName === "tagId" &&
          nodesById.get(e.to)?.location?.relativePath === "packages/extra/src/index.ts",
      );
      expect(verifiedNewCrossPkgCall).toBeDefined();

      // 2) Edit workspace package.json `exports` to point "." to "./src/alt.ts":
      //    must NOT be a no-op and must trigger full re-index!
      writeFileSync(
        path.join(wsDir, "packages", "domain", "package.json"),
        JSON.stringify({
          name: "@acme/domain",
          version: "1.0.0",
          type: "module",
          exports: { ".": "./src/alt.ts" },
        }),
        "utf8",
      );
      now = "2026-11-24T13:15:00.000Z";
      const pkgChangeRun = await service.runIncrementalIndexAsync(wsDir, [
        "packages/domain/package.json",
      ]);
      expect(pkgChangeRun.published).toBe(true);
      expect(pkgChangeRun.reanalyzedFiles).toBe(5);
      expect(pkgChangeRun.cachedFiles).toBe(0);

      const nodesAfterPkg = new Map(pkgChangeRun.snapshot.nodes.map((n) => [n.id, n]));
      const reroutedImport = pkgChangeRun.snapshot.edges.find(
        (e) =>
          e.kind === "IMPORTS" &&
          e.resolution === "verified" &&
          nodesAfterPkg.get(e.from)?.qualifiedName === "packages/service/src/index.ts" &&
          nodesAfterPkg.get(e.to)?.qualifiedName === "packages/domain/src/alt.ts",
      );
      expect(reroutedImport).toBeDefined();
    } finally {
      repo.close();
    }
  });
});
