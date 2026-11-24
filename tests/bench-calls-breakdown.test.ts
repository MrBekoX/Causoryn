/**
 * Unit tests for `scripts/bench/calls-breakdown.mjs` — the CALLS edge
 * resolution breakdown and per-language unresolved ratio reported by
 * `scripts/bench/real-repo-eval.mjs`.
 *
 * Why: the overall "unresolved edge %" headline hides where the gain comes
 * from. A `verified` CALLS edge whose target is an `UnknownExternal` node is a
 * call into a library / runtime / test framework, not a resolved project
 * symbol. These tests pin the split (verifiedInternal / verifiedExternal /
 * heuristic / unresolved), the per-language attribution rule (same rule as the
 * engine's `coverage.byLanguage`), and the "latest published snapshot only"
 * selection against a real-schema SQLite database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteGraphRepository } from "@causoryn/storage-sqlite";

interface CallsSplit {
  readonly total: number;
  readonly verifiedInternal: number;
  readonly verifiedExternal: number;
  readonly heuristic: number;
  readonly unresolved: number;
  readonly pct: {
    readonly verifiedInternal: number | null;
    readonly verifiedExternal: number | null;
    readonly heuristic: number | null;
    readonly unresolved: number | null;
  };
}

interface LanguageBreakdown {
  readonly totalEdges: number;
  readonly verifiedEdges: number;
  readonly heuristicEdges: number;
  readonly unresolvedEdges: number;
  readonly unresolvedPct: number | null;
  readonly calls: CallsSplit;
}

interface EdgeBreakdown {
  readonly totalEdges: number;
  readonly unresolvedEdges: number;
  readonly unresolvedPct: number | null;
  readonly calls: CallsSplit;
  readonly byLanguage: Readonly<Record<string, LanguageBreakdown>>;
  readonly unattributed: { readonly totalEdges: number; readonly unresolvedEdges: number };
}

interface SnapshotEdgeBreakdown extends EdgeBreakdown {
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly snapshotState: string;
}

interface EdgeGroupRow {
  readonly edgeKind: string;
  readonly resolution: string;
  readonly fromKind: string | null;
  readonly fromLanguage: string | null;
  readonly targetKind: string | null;
  readonly targetLanguage: string | null;
  readonly count: number;
}

interface CoverageLike {
  readonly totalEdges: number;
  readonly unresolvedEdges: number;
  readonly byLanguage?: Readonly<
    Record<
      string,
      {
        readonly verifiedEdges: number;
        readonly heuristicEdges: number;
        readonly unresolvedEdges: number;
      }
    >
  >;
}

interface CallsBreakdownModule {
  readonly percentOf: (part: number, whole: number) => number | null;
  readonly attributeEdgeLanguage: (row: EdgeGroupRow) => string | null;
  readonly aggregateEdgeBreakdown: (rows: readonly EdgeGroupRow[]) => EdgeBreakdown;
  readonly computeEdgeBreakdown: (
    db: unknown,
    options?: { readonly snapshotId?: string },
  ) => SnapshotEdgeBreakdown;
  readonly compareWithMcpCoverage: (
    breakdown: EdgeBreakdown,
    coverage: CoverageLike | null | undefined,
  ) => {
    readonly compared: boolean;
    readonly totalsMatch: boolean;
    readonly mismatchedLanguages: readonly string[];
  };
  readonly formatEdgeBreakdownMarkdown: (
    breakdown: (SnapshotEdgeBreakdown & { readonly available: true }) | {
      readonly available: false;
      readonly reason: string;
    },
  ) => string[];
}

async function loadModule(): Promise<CallsBreakdownModule> {
  return (await import(
    new URL("../scripts/bench/calls-breakdown.mjs", import.meta.url).href
  )) as CallsBreakdownModule;
}

function row(
  edgeKind: string,
  resolution: string,
  fromKind: string | null,
  fromLanguage: string | null,
  targetKind: string | null,
  targetLanguage: string | null,
  count = 1,
): EdgeGroupRow {
  return { edgeKind, resolution, fromKind, fromLanguage, targetKind, targetLanguage, count };
}

describe("calls-breakdown: pure aggregation (synthetic rows)", () => {
  it("percentOf rounds to two decimals and returns null for an empty denominator", async () => {
    const mod = await loadModule();
    expect(mod.percentOf(761, 39_578)).toBe(1.92);
    expect(mod.percentOf(243, 384)).toBe(63.28);
    expect(mod.percentOf(0, 10)).toBe(0);
    expect(mod.percentOf(0, 0)).toBeNull();
  });

  it("attributes an edge to the source node language, then the target language, and never attributes Workspace CONTAINS", async () => {
    const mod = await loadModule();
    expect(mod.attributeEdgeLanguage(row("CALLS", "verified", "Function", "typescript", "Function", "python"))).toBe(
      "typescript",
    );
    expect(mod.attributeEdgeLanguage(row("CONFIGURES", "verified", "Config", null, "Function", "rust"))).toBe("rust");
    expect(mod.attributeEdgeLanguage(row("CONFIGURES", "verified", "Config", "", "Function", "go"))).toBe("go");
    expect(mod.attributeEdgeLanguage(row("CONTAINS", "verified", "Workspace", null, "File", "typescript"))).toBeNull();
    expect(mod.attributeEdgeLanguage(row("CONFIGURES", "heuristic", "Config", null, "UnknownExternal", null))).toBeNull();
    // A Workspace node that is the source of a non-CONTAINS edge still falls back to the target language.
    expect(mod.attributeEdgeLanguage(row("DEPENDS_ON", "verified", "Workspace", null, "Package", "csharp"))).toBe(
      "csharp",
    );
  });

  it("splits CALLS into verifiedInternal / verifiedExternal / heuristic / unresolved and reports per-language unresolved ratios", async () => {
    const mod = await loadModule();
    const rows: EdgeGroupRow[] = [
      // Workspace containment: counted in totals, never attributed to a language.
      row("CONTAINS", "verified", "Workspace", null, "File", "typescript", 3),
      // TypeScript
      row("DECLARES", "verified", "File", "typescript", "Function", "typescript", 4),
      row("CALLS", "verified", "Function", "typescript", "Function", "typescript", 5),
      row("CALLS", "verified", "Method", "typescript", "UnknownExternal", null, 7),
      row("CALLS", "verified", "Test", "typescript", "UnknownExternal", "typescript", 2),
      row("CALLS", "heuristic", "Function", "typescript", "Function", "typescript", 1),
      row("CALLS", "unresolved", "Function", "typescript", "UnknownExternal", null, 2),
      row("IMPORTS", "unresolved", "File", "typescript", "UnknownExternal", null, 1),
      // Python
      row("CALLS", "verified", "Function", "python", "UnknownExternal", null, 1),
      row("CALLS", "unresolved", "Function", "python", "UnknownExternal", null, 3),
      // Rust: unresolved-heavy
      row("CALLS", "heuristic", "Function", "rust", "Function", "rust", 2),
      row("CALLS", "unresolved", "Function", "rust", "UnknownExternal", null, 6),
      // Language-less source: falls back to target language (typescript) / stays unattributed.
      row("CONFIGURES", "verified", "Config", null, "Function", "typescript", 1),
      row("CONFIGURES", "unresolved", "Config", null, "UnknownExternal", null, 1),
    ];

    const result = mod.aggregateEdgeBreakdown(rows);

    expect(result.totalEdges).toBe(39);
    expect(result.unresolvedEdges).toBe(13);
    expect(result.unresolvedPct).toBe(33.33);

    expect(result.calls).toEqual({
      total: 29,
      verifiedInternal: 5,
      verifiedExternal: 10,
      heuristic: 3,
      unresolved: 11,
      pct: {
        verifiedInternal: 17.24,
        verifiedExternal: 34.48,
        heuristic: 10.34,
        unresolved: 37.93,
      },
    });

    expect(Object.keys(result.byLanguage)).toEqual(["python", "rust", "typescript"]);

    expect(result.byLanguage.typescript).toEqual({
      totalEdges: 23,
      verifiedEdges: 19,
      heuristicEdges: 1,
      unresolvedEdges: 3,
      unresolvedPct: 13.04,
      calls: {
        total: 17,
        verifiedInternal: 5,
        verifiedExternal: 9,
        heuristic: 1,
        unresolved: 2,
        pct: { verifiedInternal: 29.41, verifiedExternal: 52.94, heuristic: 5.88, unresolved: 11.76 },
      },
    });
    expect(result.byLanguage.python?.unresolvedEdges).toBe(3);
    expect(result.byLanguage.python?.totalEdges).toBe(4);
    expect(result.byLanguage.python?.unresolvedPct).toBe(75);
    expect(result.byLanguage.python?.calls.verifiedExternal).toBe(1);
    expect(result.byLanguage.rust?.unresolvedPct).toBe(75);
    expect(result.byLanguage.rust?.calls).toEqual({
      total: 8,
      verifiedInternal: 0,
      verifiedExternal: 0,
      heuristic: 2,
      unresolved: 6,
      pct: { verifiedInternal: 0, verifiedExternal: 0, heuristic: 25, unresolved: 75 },
    });

    expect(result.unattributed).toEqual({ totalEdges: 4, unresolvedEdges: 1 });

    // Invariants: per-language + unattributed totals reconcile with the overall totals.
    const languageTotal = Object.values(result.byLanguage).reduce((sum, b) => sum + b.totalEdges, 0);
    const languageUnresolved = Object.values(result.byLanguage).reduce((sum, b) => sum + b.unresolvedEdges, 0);
    expect(languageTotal + result.unattributed.totalEdges).toBe(result.totalEdges);
    expect(languageUnresolved + result.unattributed.unresolvedEdges).toBe(result.unresolvedEdges);
    const c = result.calls;
    expect(c.verifiedInternal + c.verifiedExternal + c.heuristic + c.unresolved).toBe(c.total);
  });

  it("returns zero counts and null percentages when there are no edges or no CALLS edges", async () => {
    const mod = await loadModule();
    const empty = mod.aggregateEdgeBreakdown([]);
    expect(empty.totalEdges).toBe(0);
    expect(empty.unresolvedPct).toBeNull();
    expect(empty.calls.total).toBe(0);
    expect(empty.calls.pct).toEqual({
      verifiedInternal: null,
      verifiedExternal: null,
      heuristic: null,
      unresolved: null,
    });
    expect(empty.byLanguage).toEqual({});

    const noCalls = mod.aggregateEdgeBreakdown([
      row("IMPORTS", "unresolved", "File", "go", "UnknownExternal", null, 2),
    ]);
    expect(noCalls.calls.total).toBe(0);
    expect(noCalls.byLanguage.go?.unresolvedPct).toBe(100);
    expect(noCalls.byLanguage.go?.calls.pct.unresolved).toBeNull();
  });

  it("accepts bigint counts and rejects malformed rows instead of miscounting silently", async () => {
    const mod = await loadModule();
    const fromBigint = mod.aggregateEdgeBreakdown([
      { ...row("CALLS", "verified", "Function", "go", "Function", "go"), count: 3n as unknown as number },
    ]);
    expect(fromBigint.calls.verifiedInternal).toBe(3);

    expect(() => mod.aggregateEdgeBreakdown("nope" as unknown as EdgeGroupRow[])).toThrow(/array/i);
    expect(() =>
      mod.aggregateEdgeBreakdown([row("CALLS", "verified", "Function", "go", "Function", "go", -1)]),
    ).toThrow(/count/i);
    expect(() =>
      mod.aggregateEdgeBreakdown([row("CALLS", "verified", "Function", "go", "Function", "go", 1.5)]),
    ).toThrow(/count/i);
    expect(() =>
      mod.aggregateEdgeBreakdown([row("CALLS", "maybe", "Function", "go", "Function", "go", 1)]),
    ).toThrow(/resolution/i);
  });

  it("compares the database breakdown against the MCP envelope coverage", async () => {
    const mod = await loadModule();
    const breakdown = mod.aggregateEdgeBreakdown([
      row("CALLS", "verified", "Function", "typescript", "Function", "typescript", 4),
      row("CALLS", "unresolved", "Function", "python", "UnknownExternal", null, 1),
    ]);
    const matching = mod.compareWithMcpCoverage(breakdown, {
      totalEdges: 5,
      unresolvedEdges: 1,
      byLanguage: {
        typescript: { verifiedEdges: 4, heuristicEdges: 0, unresolvedEdges: 0 },
        python: { verifiedEdges: 0, heuristicEdges: 0, unresolvedEdges: 1 },
      },
    });
    expect(matching).toEqual({ compared: true, totalsMatch: true, mismatchedLanguages: [] });

    const drifted = mod.compareWithMcpCoverage(breakdown, {
      totalEdges: 6,
      unresolvedEdges: 1,
      byLanguage: {
        typescript: { verifiedEdges: 4, heuristicEdges: 0, unresolvedEdges: 0 },
        python: { verifiedEdges: 0, heuristicEdges: 0, unresolvedEdges: 2 },
        go: { verifiedEdges: 1, heuristicEdges: 0, unresolvedEdges: 0 },
      },
    });
    expect(drifted).toEqual({ compared: true, totalsMatch: false, mismatchedLanguages: ["go", "python"] });

    expect(mod.compareWithMcpCoverage(breakdown, null)).toEqual({
      compared: false,
      totalsMatch: false,
      mismatchedLanguages: [],
    });
  });
});

describe("calls-breakdown: real-schema SQLite database (latest published snapshot only)", () => {
  const WS = "ws_bench_calls";
  const OTHER_WS = "ws_bench_other";
  let tempRoot: string;
  let dbPath: string;
  let multiWsDbPath: string;

  function seedSnapshot(
    db: Database.Database,
    snapshot: {
      sid: number;
      id: string | null;
      workspaceId: string;
      state: "building" | "ready" | "partial" | "failed";
      revisionSequence: number;
      publishedAt: string | null;
    },
    nodes: ReadonlyArray<readonly [id: string, kind: string, language: string | null]>,
    edges: ReadonlyArray<readonly [from: string, to: string, kind: string, resolution: string]>,
  ): void {
    db.prepare(
      `INSERT INTO snapshots (sid, id, build_id, workspace_id, revision_id, revision_sequence,
                              config_hash, analyzer_fingerprint, state, created_at, published_at, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, 'cfg', 'fp', ?, '2026-11-24T10:00:00.000Z', ?, NULL)`,
    ).run(
      snapshot.sid,
      snapshot.id,
      `build_${String(snapshot.sid)}`,
      snapshot.workspaceId,
      `rev_${String(snapshot.revisionSequence)}`,
      snapshot.revisionSequence,
      snapshot.state,
      snapshot.publishedAt,
    );
    const insertNode = db.prepare(
      `INSERT INTO nodes (snapshot_sid, node_id, kind, qualified_name, language, relative_path,
                          start_line, end_line, source_hash, attributes_json, position)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', ?)`,
    );
    nodes.forEach(([id, kind, language], index) => {
      insertNode.run(snapshot.sid, id, kind, id, language, index);
    });
    const insertEdge = db.prepare(
      `INSERT INTO edges (snapshot_sid, edge_id, from_id, to_id, kind, resolution,
                          evidence_ids_json, ambiguity_json, position)
       VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?)`,
    );
    edges.forEach(([from, to, kind, resolution], index) => {
      insertEdge.run(snapshot.sid, `e${String(snapshot.sid)}_${String(index)}`, from, to, kind, resolution, index);
    });
  }

  const LATEST_NODES: ReadonlyArray<readonly [string, string, string | null]> = [
    ["ws", "Workspace", null],
    ["file_ts", "File", "typescript"],
    ["fn_a", "Function", "typescript"],
    ["fn_b", "Function", "typescript"],
    ["test_a", "Test", "typescript"],
    ["ext_expect", "UnknownExternal", null],
    ["ext_push", "UnknownExternal", "typescript"],
    ["ext_unres", "UnknownExternal", null],
    ["file_py", "File", "python"],
    ["py_f", "Function", "python"],
    ["py_g", "Function", "python"],
    ["rs_main", "Function", "rust"],
    ["rs_g", "Function", "rust"],
    ["cfg", "Config", null],
  ];

  const LATEST_EDGES: ReadonlyArray<readonly [string, string, string, string]> = [
    ["ws", "file_ts", "CONTAINS", "verified"],
    ["ws", "file_py", "CONTAINS", "verified"],
    ["file_ts", "fn_a", "DECLARES", "verified"],
    ["file_ts", "fn_b", "DECLARES", "verified"],
    ["fn_a", "fn_b", "CALLS", "verified"],
    ["test_a", "fn_a", "CALLS", "verified"],
    ["test_a", "ext_expect", "CALLS", "verified"],
    ["test_a", "ext_expect", "CALLS", "verified"],
    ["fn_b", "ext_push", "CALLS", "verified"],
    ["fn_b", "fn_a", "CALLS", "heuristic"],
    ["fn_b", "ext_unres", "CALLS", "unresolved"],
    ["file_ts", "ext_unres", "IMPORTS", "unresolved"],
    ["py_f", "py_g", "CALLS", "verified"],
    ["py_f", "ext_unres", "CALLS", "unresolved"],
    ["py_g", "ext_expect", "CALLS", "heuristic"],
    ["rs_main", "rs_g", "CALLS", "heuristic"],
    ["rs_main", "ext_unres", "CALLS", "unresolved"],
    ["rs_g", "ext_unres", "CALLS", "unresolved"],
    ["cfg", "fn_a", "CONFIGURES", "verified"],
    ["cfg", "ext_expect", "CONFIGURES", "unresolved"],
  ];

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-bench-calls-"));
    dbPath = path.join(tempRoot, "graph.sqlite");
    multiWsDbPath = path.join(tempRoot, "multi-ws.sqlite");

    for (const target of [dbPath, multiWsDbPath]) {
      // Real schema + pragmas via the production repository constructor.
      new SqliteGraphRepository(target).close();
    }

    const db = new Database(dbPath);
    try {
      db.pragma("foreign_keys = ON");
      db.prepare("INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)").run(
        WS,
        "/virtual/ws",
        "2026-11-24T10:00:00.000Z",
      );
      db.transaction(() => {
        // Older published snapshot: must be ignored (all edges unresolved CALLS).
        seedSnapshot(
          db,
          {
            sid: 1,
            id: "snap_old",
            workspaceId: WS,
            state: "ready",
            revisionSequence: 1,
            publishedAt: "2026-11-24T10:01:00.000Z",
          },
          [
            ["fn_a", "Function", "typescript"],
            ["ext_unres", "UnknownExternal", null],
          ],
          [
            ["fn_a", "ext_unres", "CALLS", "unresolved"],
            ["fn_a", "ext_unres", "CALLS", "unresolved"],
            ["fn_a", "ext_unres", "CALLS", "unresolved"],
          ],
        );
        // Latest published snapshot (partial state is still published).
        seedSnapshot(
          db,
          {
            sid: 2,
            id: "snap_latest",
            workspaceId: WS,
            state: "partial",
            revisionSequence: 2,
            publishedAt: "2026-11-24T10:02:00.000Z",
          },
          LATEST_NODES,
          LATEST_EDGES,
        );
        // In-flight build and a failed build with higher revision sequences: never counted.
        seedSnapshot(
          db,
          { sid: 3, id: null, workspaceId: WS, state: "building", revisionSequence: 3, publishedAt: null },
          [
            ["fn_a", "Function", "typescript"],
            ["fn_b", "Function", "typescript"],
          ],
          [["fn_a", "fn_b", "CALLS", "verified"]],
        );
        seedSnapshot(
          db,
          { sid: 4, id: null, workspaceId: WS, state: "failed", revisionSequence: 4, publishedAt: null },
          [["fn_a", "Function", "typescript"]],
          [],
        );
      })();
    } finally {
      db.close();
    }

    const multi = new Database(multiWsDbPath);
    try {
      multi.pragma("foreign_keys = ON");
      const insertWs = multi.prepare("INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)");
      insertWs.run(WS, "/virtual/ws", "2026-11-24T10:00:00.000Z");
      insertWs.run(OTHER_WS, "/virtual/other", "2026-11-24T10:00:00.000Z");
      multi.transaction(() => {
        seedSnapshot(
          multi,
          { sid: 1, id: "snap_ws_a", workspaceId: WS, state: "ready", revisionSequence: 1, publishedAt: "2026-11-24T10:01:00.000Z" },
          [["fn_a", "Function", "go"]],
          [],
        );
        seedSnapshot(
          multi,
          { sid: 2, id: "snap_ws_b", workspaceId: OTHER_WS, state: "ready", revisionSequence: 1, publishedAt: "2026-11-24T10:01:00.000Z" },
          [["fn_a", "Function", "go"]],
          [],
        );
      })();
    } finally {
      multi.close();
    }
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function openReadOnly(target: string): Database.Database {
    return new Database(target, { readonly: true, fileMustExist: true });
  }

  it("counts only the latest published snapshot (ignores older ready, building and failed rows)", async () => {
    const mod = await loadModule();
    const db = openReadOnly(dbPath);
    try {
      const result = mod.computeEdgeBreakdown(db);
      expect(result.workspaceId).toBe(WS);
      expect(result.snapshotId).toBe("snap_latest");
      expect(result.snapshotState).toBe("partial");
      expect(result.totalEdges).toBe(LATEST_EDGES.length);
      expect(result.unresolvedEdges).toBe(6);
      expect(result.calls).toMatchObject({
        total: 13,
        verifiedInternal: 3,
        verifiedExternal: 3,
        heuristic: 3,
        unresolved: 4,
      });
      expect(result.byLanguage.typescript).toMatchObject({
        totalEdges: 11,
        verifiedEdges: 8,
        heuristicEdges: 1,
        unresolvedEdges: 2,
        unresolvedPct: 18.18,
      });
      expect(result.byLanguage.typescript?.calls).toMatchObject({
        total: 7,
        verifiedInternal: 2,
        verifiedExternal: 3,
        heuristic: 1,
        unresolved: 1,
      });
      expect(result.byLanguage.python).toMatchObject({ totalEdges: 3, unresolvedEdges: 1, unresolvedPct: 33.33 });
      expect(result.byLanguage.rust).toMatchObject({ totalEdges: 3, unresolvedEdges: 2, unresolvedPct: 66.67 });
      expect(result.unattributed).toEqual({ totalEdges: 3, unresolvedEdges: 1 });
    } finally {
      db.close();
    }
  });

  it("accepts the MCP-reported snapshot id only when it is the latest published snapshot", async () => {
    const mod = await loadModule();
    const db = openReadOnly(dbPath);
    try {
      expect(mod.computeEdgeBreakdown(db, { snapshotId: "snap_latest" }).snapshotId).toBe("snap_latest");
      expect(() => mod.computeEdgeBreakdown(db, { snapshotId: "snap_old" })).toThrow(/not the latest published/i);
      expect(() => mod.computeEdgeBreakdown(db, { snapshotId: "snap_missing" })).toThrow(/not found/i);
    } finally {
      db.close();
    }
  });

  it("refuses to guess when several workspaces have published snapshots and no snapshot id is given", async () => {
    const mod = await loadModule();
    const db = openReadOnly(multiWsDbPath);
    try {
      expect(() => mod.computeEdgeBreakdown(db)).toThrow(/workspaces/i);
      expect(mod.computeEdgeBreakdown(db, { snapshotId: "snap_ws_b" }).workspaceId).toBe(OTHER_WS);
    } finally {
      db.close();
    }
  });

  it("matches the engine's own per-language aggregation (SqliteGraphRepository.getLatestWorkspaceSummaryMeta)", async () => {
    const mod = await loadModule();
    const repo = new SqliteGraphRepository(dbPath);
    let engineMeta: ReturnType<SqliteGraphRepository["getLatestWorkspaceSummaryMeta"]>;
    try {
      engineMeta = repo.getLatestWorkspaceSummaryMeta(WS);
    } finally {
      repo.close();
    }
    expect(engineMeta?.snapshotId).toBe("snap_latest");

    const db = openReadOnly(dbPath);
    let result: SnapshotEdgeBreakdown;
    try {
      result = mod.computeEdgeBreakdown(db);
    } finally {
      db.close();
    }

    expect(result.totalEdges).toBe(engineMeta?.edgeCount);
    expect(result.unresolvedEdges).toBe(engineMeta?.resolutions.unresolved);

    const engineByLanguage: Record<string, { verifiedEdges: number; heuristicEdges: number; unresolvedEdges: number }> =
      {};
    for (const entry of engineMeta?.languageCoverage ?? []) {
      engineByLanguage[entry.language] = {
        verifiedEdges: entry.verifiedEdges,
        heuristicEdges: entry.heuristicEdges,
        unresolvedEdges: entry.unresolvedEdges,
      };
    }
    const comparison = mod.compareWithMcpCoverage(result, {
      totalEdges: engineMeta?.edgeCount ?? -1,
      unresolvedEdges: engineMeta?.resolutions.unresolved ?? -1,
      byLanguage: engineByLanguage,
    });
    expect(comparison).toEqual({ compared: true, totalsMatch: true, mismatchedLanguages: [] });
  });

  it("formats an honest Markdown section (labels external CALLS, reports per-language ratios, or says why it was not measured)", async () => {
    const mod = await loadModule();
    const db = openReadOnly(dbPath);
    let result: SnapshotEdgeBreakdown;
    try {
      result = mod.computeEdgeBreakdown(db);
    } finally {
      db.close();
    }
    const markdown = mod.formatEdgeBreakdownMarkdown({ available: true, ...result }).join("\n");
    expect(markdown).toContain("### CALLS Edge Resolution Breakdown");
    expect(markdown).toContain("`UnknownExternal`");
    expect(markdown).toMatch(/not .*resolved .*project symbol/i);
    expect(markdown).toContain("| `verifiedInternal` | 3 | 23.08% |");
    expect(markdown).toContain("| `verifiedExternal` | 3 | 23.08% |");
    expect(markdown).toContain("| `heuristic` | 3 | 23.08% |");
    expect(markdown).toContain("| `unresolved` | 4 | 30.77% |");
    expect(markdown).toContain("### Unresolved Edge Ratio by Language");
    expect(markdown).toMatch(/\| rust \| 3 \| 2 \| 66\.67% \|/);
    expect(markdown).toContain("snap_latest");

    const unavailable = mod
      .formatEdgeBreakdownMarkdown({ available: false, reason: "graph.sqlite not found" })
      .join("\n");
    expect(unavailable).toContain("### CALLS Edge Resolution Breakdown");
    expect(unavailable).toMatch(/not measured/i);
    expect(unavailable).toContain("graph.sqlite not found");
  });
});
