import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEdge,
  createSnapshot,
  evidenceId,
  nodeId,
  snapshotCanonicalJson,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SnapshotInput,
  type SourceSpan,
} from "@causoryn/domain";
import { computeStreamingContentHash } from "../packages/domain/src/snapshot.js";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { IndexService } from "@causoryn/indexing";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

const WS = "ws_stream_gc";
const T0 = "2026-11-24T12:00:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-stream-gc-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeSpan(relativePath: string, line: number): SourceSpan {
  return {
    relativePath,
    startLine: line,
    endLine: line,
    sourceHash: `hash-${relativePath}-${line}`,
  };
}

function publishSyntheticSnapshot(
  repo: SqliteGraphRepository,
  sequence: number,
  symbolCount = 5,
): { snapshotId: string; nodeIds: string[] } {
  const createdAt = new Date(Date.parse(T0) + sequence * 1000).toISOString();
  const publishedAt = new Date(Date.parse(T0) + sequence * 1000 + 500).toISOString();
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: `rev-${sequence}`, sequence },
    configHash: "cfg-gc",
    analyzerFingerprint: "fp-gc",
    createdAt,
  });

  const wsNode: GraphNode = {
    id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
    kind: "Workspace",
    qualifiedName: WS,
    attributes: {},
  };
  repo.addNode(build.buildId, wsNode);

  const nodeIds: string[] = [];
  for (let i = 0; i < symbolCount; i += 1) {
    const relPath = `src/mod_${sequence}_${i}.ts`;
    const fileSpan = makeSpan(relPath, 1);
    const fileNode: GraphNode = {
      id: nodeId({
        workspaceId: WS,
        kind: "File",
        qualifiedName: relPath,
        relativePath: relPath,
      }),
      kind: "File",
      qualifiedName: relPath,
      language: "typescript",
      location: fileSpan,
      attributes: { relativePath: relPath },
    };
    const fnName = `computeMetricSeq${sequence}Item${i}`;
    const fnNode: GraphNode = {
      id: nodeId({
        workspaceId: WS,
        kind: "Function",
        qualifiedName: fnName,
        relativePath: relPath,
      }),
      kind: "Function",
      qualifiedName: fnName,
      language: "typescript",
      location: makeSpan(relPath, 5),
      attributes: { relativePath: relPath },
    };
    const ev: Evidence = {
      id: evidenceId({
        workspaceId: WS,
        kind: "ast-span",
        span: fileSpan,
        analyzerId: "ts-adapter",
        analyzerVersion: "0.2.4",
        rationale: `CONTAINS ${fnName}`,
      }),
      kind: "ast-span",
      span: fileSpan,
      analyzerId: "ts-adapter",
      analyzerVersion: "0.2.4",
      rationale: `CONTAINS ${fnName}`,
    };
    const edge: GraphEdge = createEdge({
      workspaceId: WS,
      kind: "CONTAINS",
      from: fileNode.id,
      to: fnNode.id,
      resolution: "verified",
      evidenceIds: [ev.id],
    });
    repo.addNode(build.buildId, fileNode);
    repo.addNode(build.buildId, fnNode);
    repo.addEvidence(build.buildId, ev);
    repo.addEdge(build.buildId, edge);
    nodeIds.push(fnNode.id);
  }

  const graph = repo.publish(build.buildId, "ready", publishedAt);
  repo.indexSymbols(
    graph.meta.id,
    graph.nodes
      .filter((n) => n.kind !== "Workspace" && n.kind !== "UnknownExternal")
      .map((n) => ({
        symbol: n.qualifiedName,
        nodeId: n.id,
        ...(n.location?.relativePath === undefined
          ? {}
          : { relativePath: n.location.relativePath }),
      })),
  );
  return { snapshotId: graph.meta.id, nodeIds };
}

describe("Task 2.4a — Streaming SHA-256 Snapshot Hashing", { timeout: 30_000 }, () => {
  it("produces 100% deterministic snapshot IDs regardless of input ordering and matches node:crypto SHA-256", () => {
    const baseInput: SnapshotInput = {
      workspaceId: WS,
      revision: { id: "rev-stream", sequence: 1 },
      configHash: "cfg-stream",
      analyzerFingerprint: "fp-stream",
      state: "ready",
      createdAt: T0,
      nodes: [
        { kind: "Workspace", qualifiedName: WS },
        {
          kind: "File",
          qualifiedName: "src/alpha.ts",
          relativePath: "src/alpha.ts",
          language: "typescript",
          location: makeSpan("src/alpha.ts", 1),
        },
        {
          kind: "Function",
          qualifiedName: "alphaFn",
          relativePath: "src/alpha.ts",
          language: "typescript",
          location: makeSpan("src/alpha.ts", 3),
          attributes: { exported: true, unicode: "çğıöşü 🚀" },
        },
        {
          kind: "Function",
          qualifiedName: "betaFn",
          relativePath: "src/alpha.ts",
          language: "typescript",
          location: makeSpan("src/alpha.ts", 9),
          attributes: { exported: false },
        },
      ],
      edges: [
        {
          kind: "CALLS",
          from: { kind: "Function", qualifiedName: "alphaFn", relativePath: "src/alpha.ts" },
          to: { kind: "Function", qualifiedName: "betaFn", relativePath: "src/alpha.ts" },
          resolution: "verified",
          evidence: [
            {
              kind: "semantic-symbol",
              span: makeSpan("src/alpha.ts", 4),
              analyzerId: "ts-adapter",
              analyzerVersion: "0.2.4",
              rationale: "alphaFn calls betaFn",
            },
          ],
        },
      ],
    };

    const snapA = createSnapshot(baseInput);
    const snapB = createSnapshot({
      ...baseInput,
      nodes: [...baseInput.nodes].reverse(),
      edges: [...baseInput.edges].reverse(),
    });

    expect(snapA.meta.id).toBe(snapB.meta.id);
    expect(snapA.meta.id).toMatch(/^snapshot:[0-9a-f]{64}$/);
    expect(snapshotCanonicalJson(snapA)).toBe(snapshotCanonicalJson(snapB));

    // Verify streaming content hash matches node:crypto SHA-256 over canonical content object
    const streamingDigest = computeStreamingContentHash(
      snapA.nodes,
      snapA.edges,
      snapA.evidence,
    );
    const parsedCanonical = JSON.parse(snapshotCanonicalJson(snapA)) as {
      nodes: unknown;
      edges: unknown;
      evidence: unknown;
    };
    const canonicalContent = JSON.stringify({
      edges: parsedCanonical.edges,
      evidence: parsedCanonical.evidence,
      nodes: parsedCanonical.nodes,
    });
    const nodeCryptoDigest = createHash("sha256")
      .update(canonicalContent, "utf8")
      .digest("hex");
    expect(streamingDigest).toBe(nodeCryptoDigest);
  });

  it("hashes a 10,000-node synthetic graph cleanly via streaming SHA-256 without monolithic string blowup", () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const evidence: Evidence[] = [];

    const wsNode: GraphNode = {
      id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
      kind: "Workspace",
      qualifiedName: WS,
      attributes: {},
    };
    nodes.push(wsNode);

    for (let i = 0; i < 10_000; i += 1) {
      const rel = `src/dir_${i % 50}/file_${i}.ts`;
      const sp = makeSpan(rel, 1);
      const n: GraphNode = {
        id: nodeId({
          workspaceId: WS,
          kind: "Function",
          qualifiedName: `fn_${i}`,
          relativePath: rel,
        }),
        kind: "Function",
        qualifiedName: `fn_${i}`,
        language: "typescript",
        location: sp,
        attributes: { index: i, exported: i % 2 === 0 },
      };
      nodes.push(n);
      if (i > 0) {
        const ev: Evidence = {
          id: evidenceId({
            workspaceId: WS,
            kind: "call-site",
            span: sp,
            analyzerId: "ts",
            analyzerVersion: "1.0.0",
            rationale: `edge-${i}`,
          }),
          kind: "call-site",
          span: sp,
          analyzerId: "ts",
          analyzerVersion: "1.0.0",
          rationale: `edge-${i}`,
        };
        evidence.push(ev);
        edges.push(
          createEdge({
            workspaceId: WS,
            kind: "CALLS",
            from: nodes[i]!.id,
            to: n.id,
            resolution: "verified",
            evidenceIds: [ev.id],
          }),
        );
      }
    }

    nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const digest1 = computeStreamingContentHash(nodes, edges, evidence);
    const digest2 = computeStreamingContentHash(nodes, edges, evidence);
    expect(digest1).toMatch(/^[0-9a-f]{64}$/);
    expect(digest1).toBe(digest2);
  });
});

describe("Task 2.4b — Warm Boot Meta, Fast Hydration, Retention GC & LocAgent FTS5", { timeout: 30_000 }, () => {
  it("retains only the 2 newest published snapshots after 5 publishes and leaves 0 orphan symbol_fts rows", () => {
    const dbFile = path.join(tempRoot, "retention-gc.sqlite");
    const repo = new SqliteGraphRepository(dbFile);
    try {
      repo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });

      const publishedIds: string[] = [];
      for (let seq = 1; seq <= 5; seq += 1) {
        const { snapshotId } = publishSyntheticSnapshot(repo, seq, 4);
        publishedIds.push(snapshotId);
      }

      // Also create 4 failed builds to confirm failed-build pruning
      for (let f = 10; f < 14; f += 1) {
        const b = repo.beginBuild({
          workspaceId: WS,
          revision: { id: `fail-${f}`, sequence: f },
          configHash: "cfg-gc",
          analyzerFingerprint: "fp-gc",
          createdAt: T0,
        });
        repo.failBuild(b.buildId, `failure-${f}`);
      }
      const gcResult = repo.pruneOldSnapshots(WS, 2);
      expect(gcResult.prunedSnapshotSids).toBeGreaterThanOrEqual(2);

      const probe = new Database(dbFile, { readonly: true });
      try {
        const pubRows = probe
          .prepare(
            "SELECT sid, id, revision_sequence FROM snapshots WHERE workspace_id = ? AND state IN ('ready','partial') ORDER BY revision_sequence DESC",
          )
          .all(WS) as Array<{ sid: number; id: string; revision_sequence: number }>;
        expect(pubRows).toHaveLength(2);
        expect(pubRows.map((r) => r.id)).toEqual([publishedIds[4], publishedIds[3]]);

        const failedCount = (
          probe
            .prepare("SELECT COUNT(*) AS count FROM snapshots WHERE workspace_id = ? AND state = 'failed'")
            .get(WS) as { count: number }
        ).count;
        expect(failedCount).toBeLessThanOrEqual(2);

        const orphanFtsCount = (
          probe
            .prepare("SELECT COUNT(*) AS count FROM symbol_fts WHERE snapshot_sid NOT IN (SELECT sid FROM snapshots)")
            .get() as { count: number }
        ).count;
        expect(orphanFtsCount).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      repo.close();
    }
  });

  it("getLatestSnapshotMeta returns accurate summary in < 20ms without hydrating node rows (both SQLite and InMemory)", () => {
    const dbFile = path.join(tempRoot, "warm-meta.sqlite");
    const repo = new SqliteGraphRepository(dbFile);
    let expectedId = "";
    try {
      repo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
      const res = publishSyntheticSnapshot(repo, 1, 200);
      expectedId = res.snapshotId;
    } finally {
      repo.close();
    }

    // Reopen fresh connection (cold cache) and measure getLatestSnapshotMeta
    const warmRepo = new SqliteGraphRepository(dbFile);
    try {
      const start = performance.now();
      const meta = warmRepo.getLatestSnapshotMeta(WS);
      const elapsedMs = performance.now() - start;

      expect(meta).toBeDefined();
      expect(meta?.snapshotId).toBe(expectedId);
      expect(meta?.workspaceId).toBe(WS);
      expect(meta?.state).toBe("ready");
      expect(meta?.revisionSequence).toBe(1);
      expect(meta?.nodeCount).toBe(401); // 1 workspace + 200 files + 200 functions
      expect(meta?.edgeCount).toBe(200);
      expect(meta?.evidenceCount).toBe(200);
      expect(meta?.stale).toBe(false);
      expect(elapsedMs).toBeLessThan(20);

      // Fast direct hydration returns full snapshot matching exact ID and canonical order
      const full = warmRepo.getLatestPublished(WS);
      expect(full?.snapshot.meta.id).toBe(expectedId);
      expect(full?.snapshot.nodes).toHaveLength(401);
      expect(full?.snapshot.edges).toHaveLength(200);

      // IndexService warm constructor must read sequence via getLatestSnapshotMeta ONLY
      // (NEVER triggering full-graph getLatestPublished hydration on boot!)
      let fullHydrationCalls = 0;
      let metaCalls = 0;
      const origGetLatestPublished = warmRepo.getLatestPublished.bind(warmRepo);
      const origGetLatestSnapshotMeta = warmRepo.getLatestSnapshotMeta.bind(warmRepo);
      warmRepo.getLatestPublished = (wsId: string) => {
        fullHydrationCalls += 1;
        return origGetLatestPublished(wsId);
      };
      warmRepo.getLatestSnapshotMeta = (wsId: string) => {
        metaCalls += 1;
        return origGetLatestSnapshotMeta(wsId);
      };
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [tempRoot] });
      new IndexService({
        workspaceId: WS,
        policy,
        repository: warmRepo,
        clock: () => T0,
        limits: { maxFiles: 500 },
      });
      expect(metaCalls).toBeGreaterThanOrEqual(1);
      expect(fullHydrationCalls).toBe(0);
    } finally {
      warmRepo.close();
    }

    // Also verify InMemoryGraphRepository implements getLatestSnapshotMeta & pruneOldSnapshots
    const mem = new InMemoryGraphRepository();
    mem.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
    for (let seq = 1; seq <= 4; seq += 1) {
      const b = mem.beginBuild({
        workspaceId: WS,
        revision: { id: `r-${seq}`, sequence: seq },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: T0,
      });
      mem.addNode(b.buildId, {
        id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
        kind: "Workspace",
        qualifiedName: WS,
        attributes: {},
      });
      mem.publish(b.buildId, "ready", new Date(Date.parse(T0) + seq * 1000).toISOString());
    }
    const memMeta = mem.getLatestSnapshotMeta(WS);
    expect(memMeta?.revisionSequence).toBe(4);
    expect(memMeta?.nodeCount).toBe(1);
    const memPruned = mem.pruneOldSnapshots(WS, 2);
    expect(memPruned.prunedSnapshotSids).toBe(2);
  });

  it("LocAgent FTS5 indexes both symbols and File nodes, ranks natural-language queries via BM25, and blocks FTS5 operator/wildcard injection", async () => {
    const wsDir = path.join(tempRoot, "locagent-ws");
    const dbFile = path.join(tempRoot, "locagent.sqlite");
    mkdirSync(path.join(wsDir, "packages", "mcp-server", "src"), { recursive: true });
    mkdirSync(path.join(wsDir, "packages", "billing", "src"), { recursive: true });

    writeFileSync(
      path.join(wsDir, "packages", "mcp-server", "src", "server.ts"),
      [
        "export function registerTool(name: string): string { return name; }",
        "export function createCausorynMcpServer(): string { return registerTool('status'); }",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(wsDir, "packages", "billing", "src", "invoice.ts"),
      "export function calculateInvoiceTotal(subtotal: number): number { return subtotal * 1.2; }\n",
      "utf8",
    );

    const repo = new SqliteGraphRepository(dbFile);
    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [wsDir] });
      const service = new IndexService({
        workspaceId: "locagent",
        policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const run = await service.runIndexAsync(wsDir);
      expect(run.published).toBe(true);

      // Natural language query matches MCP tool registration symbols AND server.ts File node
      const hits = repo.searchSymbols("Where are MCP tools registered?", 10, run.snapshotId);
      expect(hits.length).toBeGreaterThan(0);
      const hitSymbols = hits.map((h) => h.symbol);
      expect(
        hitSymbols.some(
          (s) =>
            s === "registerTool" ||
            s === "createCausorynMcpServer" ||
            s === "packages/mcp-server/src/server.ts",
        ),
      ).toBe(true);
      // Confirm File nodes themselves are indexed in symbol_fts
      const fileHits = repo.searchSymbols("packages mcp server", 10, run.snapshotId);
      expect(fileHits.some((h) => h.symbol === "packages/mcp-server/src/server.ts")).toBe(true);

      // Hostile FTS5 operator / wildcard injection attempts must never throw or act as raw operators
      expect(() => repo.searchSymbols("register* NEAR(tool, mcp) NOT invoice ^server", 10)).not.toThrow();
      expect(() => repo.searchSymbols('*** "unterminated (((( :', 10)).not.toThrow();
      expect(repo.searchSymbols("*** ((( )))", 10)).toEqual([]);
    } finally {
      repo.close();
    }
  });

  it("Finding #3: wraps getSnapshot, getLatestPublished, and getLatestSnapshotMeta in deferred read transactions so concurrent pruneOldSnapshots GC cannot tear reads", () => {
    const dbFile = path.join(tempRoot, "mvcc-atomic-reads.sqlite");
    const writerRepo = new SqliteGraphRepository(dbFile);
    const readerRepo = new SqliteGraphRepository(dbFile);
    try {
      writerRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
      const snap1 = publishSyntheticSnapshot(writerRepo, 1, 10);

      // 1) getLatestSnapshotMeta: inject concurrent publish+prune right before COUNT(*) runs.
      // Without a deferred read transaction, pruning sid=1 mid-read causes nodeCount=0 (torn read).
      const readerInternal = readerRepo as unknown as {
        countRows: (table: "nodes" | "edges" | "evidence", sid: number) => number;
        reconstructPublished: (row: unknown) => unknown;
      };
      const origCountRows = readerInternal.countRows.bind(readerRepo);
      let injectedMetaPrune = false;
      let snap2Id = "";
      readerInternal.countRows = (table, sid) => {
        if (!injectedMetaPrune) {
          injectedMetaPrune = true;
          snap2Id = publishSyntheticSnapshot(writerRepo, 2, 10).snapshotId;
          const gc = writerRepo.pruneOldSnapshots(WS, 1);
          expect(gc.prunedSnapshotSids).toBe(1);
        }
        return origCountRows(table, sid);
      };
      const meta1 = readerRepo.getLatestSnapshotMeta(WS);
      readerInternal.countRows = origCountRows;

      expect(injectedMetaPrune).toBe(true);
      expect(meta1).toBeDefined();
      expect(meta1?.snapshotId).toBe(snap1.snapshotId);
      expect(meta1?.nodeCount).toBe(21);
      expect(meta1?.edgeCount).toBe(10);
      expect(meta1?.evidenceCount).toBe(10);
      expect(meta1?.stale).toBe(false);

      // 2) getSnapshot: inject concurrent publish+prune right before reconstructPublished hydrates nodes/edges/evidence.
      const origReconstruct = readerInternal.reconstructPublished.bind(readerRepo);
      let injectedGetSnapPrune = false;
      readerInternal.reconstructPublished = (row) => {
        if (!injectedGetSnapPrune) {
          injectedGetSnapPrune = true;
          publishSyntheticSnapshot(writerRepo, 3, 10);
          const gc = writerRepo.pruneOldSnapshots(WS, 1);
          expect(gc.prunedSnapshotSids).toBe(1);
        }
        return origReconstruct(row);
      };
      const read2 = readerRepo.getSnapshot(snap2Id);
      readerInternal.reconstructPublished = origReconstruct;

      expect(injectedGetSnapPrune).toBe(true);
      expect(read2).toBeDefined();
      expect(read2?.snapshot.meta.id).toBe(snap2Id);
      expect(read2?.snapshot.nodes).toHaveLength(21);
      expect(read2?.snapshot.edges).toHaveLength(10);
      expect(read2?.snapshot.evidence).toHaveLength(10);
      expect(read2?.stale).toBe(false);

      // 3) getLatestPublished: inject concurrent publish+prune right before reconstructPublished hydrates seq 3.
      let injectedLatestPrune = false;
      readerInternal.reconstructPublished = (row) => {
        if (!injectedLatestPrune) {
          injectedLatestPrune = true;
          publishSyntheticSnapshot(writerRepo, 4, 10);
          const gc = writerRepo.pruneOldSnapshots(WS, 1);
          expect(gc.prunedSnapshotSids).toBe(1);
        }
        return origReconstruct(row);
      };
      const read3 = readerRepo.getLatestPublished(WS);
      readerInternal.reconstructPublished = origReconstruct;

      expect(injectedLatestPrune).toBe(true);
      expect(read3).toBeDefined();
      expect(read3?.snapshot.meta.revision.sequence).toBe(3);
      expect(read3?.snapshot.nodes).toHaveLength(21);
      expect(read3?.snapshot.edges).toHaveLength(10);
      expect(read3?.snapshot.evidence).toHaveLength(10);
      expect(read3?.stale).toBe(false);
    } finally {
      readerRepo.close();
      writerRepo.close();
    }
  });
});
