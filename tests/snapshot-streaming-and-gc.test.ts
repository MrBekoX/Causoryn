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
import { InMemoryGraphRepository, type GraphRepository } from "@causoryn/graph";
import { IndexJobManager, IndexService } from "@causoryn/indexing";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import {
  CausorynToolError,
  EnvelopeSchema,
  IndexStatusDataSchema,
  WorkspaceSummaryDataSchema,
  coverageOf,
  indexStatus,
  parseCausorynServerConfig,
  workspaceSummary,
} from "../packages/mcp-server/src/index.js";
import type { ServiceDeps } from "../packages/mcp-server/src/services.js";

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

describe("Zero-hydration WorkspaceSummaryMeta — bit-for-bit parity & <20ms status/summary", { timeout: 30_000 }, () => {
  function makeServiceDeps(repo: GraphRepository, wsId: string, rootDir: string): ServiceDeps {
    const config = parseCausorynServerConfig({
      workspaceId: wsId,
      allowRoots: [rootDir],
      autoIndex: false,
    });
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [rootDir] });
    const indexService = new IndexService({
      workspaceId: wsId,
      policy,
      repository: repo,
      clock: () => T0,
      limits: { maxFiles: config.index.maxFiles },
    });
    const jobManager = new IndexJobManager({
      policy,
      indexService,
      clock: () => T0,
    });
    return {
      config,
      policy,
      repository: repo,
      symbolSearch: null,
      jobManager,
      outputPolicy: null,
      wikiStore: null,
      wikiSearch: null,
      clock: () => T0,
      logger: () => {},
    };
  }

  function buildRichMultiLangSnapshot(
    repo: GraphRepository,
    wsId: string,
    state: "ready" | "partial" = "ready",
  ) {
    const build = repo.beginBuild({
      workspaceId: wsId,
      revision: { id: "rev-rich-1", sequence: 1 },
      configHash: "cfg-rich",
      analyzerFingerprint: "fp-rich",
      createdAt: T0,
    });

    const wsNode: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Workspace", qualifiedName: wsId }),
      kind: "Workspace",
      qualifiedName: wsId,
      attributes: {},
    };

    // TypeScript (L2): 2 files, 2 functions, 2 endpoints (duplicate framework + 2nd framework), 1 handler (ignored framework)
    const tsFile1: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "src/routes.ts", relativePath: "src/routes.ts" }),
      kind: "File",
      qualifiedName: "src/routes.ts",
      language: "typescript",
      location: makeSpan("src/routes.ts", 1),
      attributes: { relativePath: "src/routes.ts" },
    };
    const tsFile2: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "src/service.ts", relativePath: "src/service.ts" }),
      kind: "File",
      qualifiedName: "src/service.ts",
      language: "typescript",
      location: makeSpan("src/service.ts", 1),
      attributes: { relativePath: "src/service.ts" },
    };
    const tsEp1: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Endpoint", qualifiedName: "GET /orders", relativePath: "src/routes.ts" }),
      kind: "Endpoint",
      qualifiedName: "GET /orders",
      language: "typescript",
      location: makeSpan("src/routes.ts", 4),
      attributes: { framework: "express" },
    };
    const tsEp2: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Endpoint", qualifiedName: "POST /orders", relativePath: "src/routes.ts" }),
      kind: "Endpoint",
      qualifiedName: "POST /orders",
      language: "typescript",
      location: makeSpan("src/routes.ts", 10),
      attributes: { framework: "fastify" },
    };
    const tsEp3: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Endpoint", qualifiedName: "DELETE /orders", relativePath: "src/routes.ts" }),
      kind: "Endpoint",
      qualifiedName: "DELETE /orders",
      language: "typescript",
      location: makeSpan("src/routes.ts", 18),
      attributes: { framework: "express" },
    };
    const tsHandler: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Handler", qualifiedName: "handleOrder", relativePath: "src/routes.ts" }),
      kind: "Handler",
      qualifiedName: "handleOrder",
      language: "typescript",
      location: makeSpan("src/routes.ts", 22),
      attributes: { framework: "should-not-appear-from-handler" },
    };
    const tsFn: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Function", qualifiedName: "createOrder", relativePath: "src/service.ts" }),
      kind: "Function",
      qualifiedName: "createOrder",
      language: "typescript",
      location: makeSpan("src/service.ts", 5),
      attributes: {},
    };
    const extUnknown: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "UnknownExternal", qualifiedName: "external:logger" }),
      kind: "UnknownExternal",
      qualifiedName: "external:logger",
      attributes: {},
    };

    // Python (L2): 1 file, 1 function, heuristic + unresolved edges
    const pyFile: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "py/worker.py", relativePath: "py/worker.py" }),
      kind: "File",
      qualifiedName: "py/worker.py",
      language: "python",
      location: makeSpan("py/worker.py", 1),
      attributes: { relativePath: "py/worker.py" },
    };
    const pyFn: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Function", qualifiedName: "run_job", relativePath: "py/worker.py" }),
      kind: "Function",
      qualifiedName: "run_job",
      language: "python",
      location: makeSpan("py/worker.py", 3),
      attributes: {},
    };

    // Go (L1): 1 file, 1 function, ONLY CONTAINS edge (hasSemanticEdges === false)
    const goFile: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "cmd/main.go", relativePath: "cmd/main.go" }),
      kind: "File",
      qualifiedName: "cmd/main.go",
      language: "go",
      location: makeSpan("cmd/main.go", 1),
      attributes: { relativePath: "cmd/main.go" },
    };
    const goFn: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Function", qualifiedName: "main", relativePath: "cmd/main.go" }),
      kind: "Function",
      qualifiedName: "main",
      language: "go",
      location: makeSpan("cmd/main.go", 5),
      attributes: {},
    };

    // Rust (L0 degraded): ONLY a File node + Workspace --CONTAINS--> File (verified) -> must report 0 verifiedEdges & coverageRatio 0!
    const rsFile: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "crates/lib.rs", relativePath: "crates/lib.rs" }),
      kind: "File",
      qualifiedName: "crates/lib.rs",
      language: "rust",
      location: makeSpan("crates/lib.rs", 1),
      attributes: { relativePath: "crates/lib.rs" },
    };

    // Untyped File node (language undefined) — counted in fileCount, excluded from languages
    const untypedFile: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "File", qualifiedName: "README.txt", relativePath: "README.txt" }),
      kind: "File",
      qualifiedName: "README.txt",
      location: makeSpan("README.txt", 1),
      attributes: { relativePath: "README.txt" },
    };

    // C# node referenced ONLY as edge target from language-less UnknownExternal (tests COALESCE fallback to tn.language)
    const csClass: GraphNode = {
      id: nodeId({ workspaceId: wsId, kind: "Class", qualifiedName: "OrderController", relativePath: "Api/OrderController.cs" }),
      kind: "Class",
      qualifiedName: "OrderController",
      language: "csharp",
      location: makeSpan("Api/OrderController.cs", 4),
      attributes: {},
    };

    const nodes = [
      wsNode,
      tsFile1,
      tsFile2,
      tsEp1,
      tsEp2,
      tsEp3,
      tsHandler,
      tsFn,
      extUnknown,
      pyFile,
      pyFn,
      goFile,
      goFn,
      rsFile,
      untypedFile,
      csClass,
    ];
    for (const n of nodes) repo.addNode(build.buildId, n);

    const ev: Evidence = {
      id: evidenceId({
        workspaceId: wsId,
        kind: "ast-span",
        span: makeSpan("src/routes.ts", 1),
        analyzerId: "multi-adapter",
        analyzerVersion: "0.2.4",
        rationale: "synthetic evidence",
      }),
      kind: "ast-span",
      span: makeSpan("src/routes.ts", 1),
      analyzerId: "multi-adapter",
      analyzerVersion: "0.2.4",
      rationale: "synthetic evidence",
    };
    repo.addEvidence(build.buildId, ev);

    const edges: GraphEdge[] = [
      // Workspace --CONTAINS--> File (MUST be excluded from byLanguage)
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: tsFile1.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: tsFile2.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: pyFile.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: goFile.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: rsFile.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: wsNode.id, to: untypedFile.id, resolution: "verified", evidenceIds: [ev.id] }),
      // TypeScript semantic + contains edges
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: tsFile1.id, to: tsEp1.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "ROUTES_TO", from: tsEp1.id, to: tsHandler.id, resolution: "verified", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CALLS", from: tsHandler.id, to: tsFn.id, resolution: "heuristic", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "CALLS", from: tsFn.id, to: extUnknown.id, resolution: "unresolved", evidenceIds: [ev.id] }),
      // Python semantic edges
      createEdge({ workspaceId: wsId, kind: "CALLS", from: pyFn.id, to: extUnknown.id, resolution: "unresolved", evidenceIds: [ev.id] }),
      createEdge({ workspaceId: wsId, kind: "IMPORTS", from: pyFile.id, to: pyFn.id, resolution: "heuristic", evidenceIds: [ev.id] }),
      // Go CONTAINS only (no semantic edges)
      createEdge({ workspaceId: wsId, kind: "CONTAINS", from: goFile.id, to: goFn.id, resolution: "verified", evidenceIds: [ev.id] }),
      // Language-less from -> C# to (fallback to tn.language)
      createEdge({ workspaceId: wsId, kind: "REFERENCES", from: extUnknown.id, to: csClass.id, resolution: "heuristic", evidenceIds: [ev.id] }),
    ];
    for (const e of edges) repo.addEdge(build.buildId, e);

    return repo.publish(build.buildId, state, "2026-11-24T12:00:05.000Z");
  }

  it("matches full SnapshotGraph coverageOf + workspaceSummary + indexStatus BIT-FOR-BIT (including L0-degraded rust with Workspace--CONTAINS-->File)", () => {
    const dbFile = path.join(tempRoot, "summary-parity.sqlite");
    const sqliteRepo = new SqliteGraphRepository(dbFile);
    const memoryRepo = new InMemoryGraphRepository();
    try {
      sqliteRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
      memoryRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });

      const sqliteSnap = buildRichMultiLangSnapshot(sqliteRepo, WS, "partial");
      const memorySnap = buildRichMultiLangSnapshot(memoryRepo, WS, "partial");
      expect(sqliteSnap.meta.id).toBe(memorySnap.meta.id);

      const sqliteMeta = sqliteRepo.getLatestWorkspaceSummaryMeta(WS);
      const memoryMeta = memoryRepo.getLatestWorkspaceSummaryMeta(WS);
      expect(sqliteMeta).toBeDefined();
      expect(sqliteMeta).toEqual(memoryMeta);

      // Verify exact languageCoverage details including L0 rust & hasSemanticEdges
      const byLangMeta = new Map(sqliteMeta!.languageCoverage.map((c) => [c.language, c]));
      expect(byLangMeta.get("rust")).toEqual({
        language: "rust",
        files: 1,
        hasNonFileSymbols: false,
        hasSemanticEdges: false,
        verifiedEdges: 0,
        heuristicEdges: 0,
        unresolvedEdges: 0,
      });
      expect(byLangMeta.get("go")).toEqual({
        language: "go",
        files: 1,
        hasNonFileSymbols: true,
        hasSemanticEdges: false,
        verifiedEdges: 1,
        heuristicEdges: 0,
        unresolvedEdges: 0,
      });
      expect(byLangMeta.get("typescript")).toEqual({
        language: "typescript",
        files: 2,
        hasNonFileSymbols: true,
        hasSemanticEdges: true,
        verifiedEdges: 2,
        heuristicEdges: 1,
        unresolvedEdges: 1,
      });
      expect(byLangMeta.get("csharp")).toEqual({
        language: "csharp",
        files: 0,
        hasNonFileSymbols: true,
        hasSemanticEdges: true,
        verifiedEdges: 0,
        heuristicEdges: 1,
        unresolvedEdges: 0,
      });

      // Compare zero-hydration path vs full-hydration fallback path BIT-FOR-BIT!
      const fallbackRepo: GraphRepository = {
        registerWorkspace: (r) => sqliteRepo.registerWorkspace(r),
        upsertFile: (r) => sqliteRepo.upsertFile(r),
        listFiles: (id) => sqliteRepo.listFiles(id),
        deleteFile: (id, p) => sqliteRepo.deleteFile(id, p),
        beginBuild: (i) => sqliteRepo.beginBuild(i),
        getBuild: (id) => sqliteRepo.getBuild(id),
        addNode: (id, n) => sqliteRepo.addNode(id, n),
        addEdge: (id, e) => sqliteRepo.addEdge(id, e),
        addEvidence: (id, ev) => sqliteRepo.addEvidence(id, ev),
        publish: (id, st, ts) => sqliteRepo.publish(id, st, ts),
        failBuild: (id, r) => sqliteRepo.failBuild(id, r),
        getSnapshot: (id) => sqliteRepo.getSnapshot(id),
        getLatestPublished: (id) => sqliteRepo.getLatestPublished(id),
      };

      const fastDeps = makeServiceDeps(sqliteRepo, WS, tempRoot);
      const fallbackDeps = makeServiceDeps(fallbackRepo, WS, tempRoot);

      const fastSummary = workspaceSummary(fastDeps, "req-sum-1", { workspaceId: WS });
      const fallbackSummary = workspaceSummary(fallbackDeps, "req-sum-1", { workspaceId: WS });
      expect(EnvelopeSchema.safeParse(fastSummary).success).toBe(true);
      expect(WorkspaceSummaryDataSchema.safeParse(fastSummary.data).success).toBe(true);
      expect(JSON.stringify(fastSummary)).toBe(JSON.stringify(fallbackSummary));
      expect(fastSummary.coverage).toEqual(coverageOf(sqliteSnap));
      expect(fastSummary.coverage?.byLanguage?.rust).toEqual({
        tier: "L0",
        files: 1,
        verifiedEdges: 0,
        heuristicEdges: 0,
        unresolvedEdges: 0,
        coverageRatio: 0,
      });

      const fastStatus = indexStatus(fastDeps, "req-idx-1", { workspaceId: WS });
      const fallbackStatus = indexStatus(fallbackDeps, "req-idx-1", { workspaceId: WS });
      expect(EnvelopeSchema.safeParse(fastStatus).success).toBe(true);
      expect(IndexStatusDataSchema.safeParse(fastStatus.data).success).toBe(true);
      expect(JSON.stringify(fastStatus)).toBe(JSON.stringify(fallbackStatus));

      // Start an active build to verify stale=true parity on both endpoints
      sqliteRepo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-rich-2", sequence: 2 },
        configHash: "cfg-rich",
        analyzerFingerprint: "fp-rich",
        createdAt: T0,
      });
      const staleFastSummary = workspaceSummary(fastDeps, "req-sum-2", { workspaceId: WS });
      const staleFallbackSummary = workspaceSummary(fallbackDeps, "req-sum-2", { workspaceId: WS });
      expect(JSON.stringify(staleFastSummary)).toBe(JSON.stringify(staleFallbackSummary));

      const staleFastStatus = indexStatus(fastDeps, "req-idx-2", { workspaceId: WS });
      const staleFallbackStatus = indexStatus(fallbackDeps, "req-idx-2", { workspaceId: WS });
      expect(JSON.stringify(staleFastStatus)).toBe(JSON.stringify(staleFallbackStatus));
    } finally {
      sqliteRepo.close();
    }
  });

  it("calls getLatestPublished 0 times during workspaceSummary and indexStatus on a cold SqliteGraphRepository and completes in < 20ms", () => {
    const dbFile = path.join(tempRoot, "zero-hydration-perf.sqlite");
    const setupRepo = new SqliteGraphRepository(dbFile);
    let expectedSnapId = "";
    try {
      setupRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
      // Empty workspace checks: 0 getLatestPublished calls even when no snapshot exists
      let emptyHydrationCalls = 0;
      const origEmptyLatest = setupRepo.getLatestPublished.bind(setupRepo);
      setupRepo.getLatestPublished = (wsId: string) => {
        emptyHydrationCalls += 1;
        return origEmptyLatest(wsId);
      };
      const emptyDeps = makeServiceDeps(setupRepo, WS, tempRoot);
      const emptyIdx = indexStatus(emptyDeps, "req-empty-idx", { workspaceId: WS });
      expect((emptyIdx.data as { latestSnapshot: unknown }).latestSnapshot).toBeNull();
      expect(emptyIdx.coverage).toBeNull();
      expect(() => workspaceSummary(emptyDeps, "req-empty-sum", { workspaceId: WS })).toThrow(
        CausorynToolError,
      );
      expect(emptyHydrationCalls).toBe(0);
      setupRepo.getLatestPublished = origEmptyLatest;

      expectedSnapId = publishSyntheticSnapshot(setupRepo, 1, 300).snapshotId;
    } finally {
      setupRepo.close();
    }

    // Reopen fresh SQLite connection (cold cache)
    const warmRepo = new SqliteGraphRepository(dbFile);
    try {
      let fullHydrationCalls = 0;
      let summaryMetaCalls = 0;
      const origGetLatestPublished = warmRepo.getLatestPublished.bind(warmRepo);
      const origGetSummaryMeta = warmRepo.getLatestWorkspaceSummaryMeta.bind(warmRepo);
      warmRepo.getLatestPublished = (wsId: string) => {
        fullHydrationCalls += 1;
        return origGetLatestPublished(wsId);
      };
      warmRepo.getLatestWorkspaceSummaryMeta = (wsId: string) => {
        summaryMetaCalls += 1;
        return origGetSummaryMeta(wsId);
      };

      const deps = makeServiceDeps(warmRepo, WS, tempRoot);
      const t0 = performance.now();
      const idxEnv = indexStatus(deps, "req-perf-idx", { workspaceId: WS });
      const sumEnv = workspaceSummary(deps, "req-perf-sum", { workspaceId: WS });
      const elapsedMs = performance.now() - t0;

      expect(fullHydrationCalls).toBe(0);
      expect(summaryMetaCalls).toBe(2);
      expect(idxEnv.snapshotId).toBe(expectedSnapId);
      expect(sumEnv.snapshotId).toBe(expectedSnapId);
      expect((sumEnv.data as { nodeCount: number }).nodeCount).toBe(601);
      expect((sumEnv.data as { edgeCount: number }).edgeCount).toBe(300);
      expect((sumEnv.data as { evidenceCount: number }).evidenceCount).toBe(300);
      expect(elapsedMs).toBeLessThan(20);
    } finally {
      warmRepo.close();
    }
  });

  it("handles edge-case graph topologies (Workspace with majorLang, language-less edges, majorLang without semantic edges, and 0-language snapshots) identically to InMemory and coverageOf", () => {
    const dbFile = path.join(tempRoot, "complement-edge-cases.sqlite");
    const sqliteRepo = new SqliteGraphRepository(dbFile);
    const memoryRepo = new InMemoryGraphRepository();
    try {
      sqliteRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });
      memoryRepo.registerWorkspace({ id: WS, rootPath: tempRoot, createdAt: T0 });

      // Case 1: 0-language snapshot (only Workspace + untyped File + Workspace--CONTAINS-->File)
      for (const repo of [sqliteRepo, memoryRepo] as const) {
        const b = repo.beginBuild({
          workspaceId: WS,
          revision: { id: "rev-zero-lang", sequence: 1 },
          configHash: "cfg",
          analyzerFingerprint: "fp",
          createdAt: T0,
        });
        const ws: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
          kind: "Workspace",
          qualifiedName: WS,
          attributes: {},
        };
        const f: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "File", qualifiedName: "notes.txt", relativePath: "notes.txt" }),
          kind: "File",
          qualifiedName: "notes.txt",
          location: makeSpan("notes.txt", 1),
          attributes: {},
        };
        const ev: Evidence = {
          id: evidenceId({
            workspaceId: WS,
            kind: "ast-span",
            span: makeSpan("notes.txt", 1),
            analyzerId: "a",
            analyzerVersion: "1",
            rationale: "ws contains file",
          }),
          kind: "ast-span",
          span: makeSpan("notes.txt", 1),
          analyzerId: "a",
          analyzerVersion: "1",
          rationale: "ws contains file",
        };
        repo.addNode(b.buildId, ws);
        repo.addNode(b.buildId, f);
        repo.addEvidence(b.buildId, ev);
        repo.addEdge(
          b.buildId,
          createEdge({
            workspaceId: WS,
            kind: "CONTAINS",
            from: ws.id,
            to: f.id,
            resolution: "verified",
            evidenceIds: [ev.id],
          }),
        );
        repo.publish(b.buildId, "ready", "2026-11-24T12:01:00.000Z");
      }
      const zeroSqlite = sqliteRepo.getLatestWorkspaceSummaryMeta(WS);
      const zeroMem = memoryRepo.getLatestWorkspaceSummaryMeta(WS);
      expect(zeroSqlite).toEqual(zeroMem);
      expect(zeroSqlite?.fileCount).toBe(1);
      expect(zeroSqlite?.languages).toEqual([]);
      expect(zeroSqlite?.languageCoverage).toEqual([]);

      // Case 2: Workspace node HAS majorLang ("typescript"), majorLang has ONLY CONTAINS edges,
      // minority language ("python") has CALLS, plus UnknownExternal -> majorLang & UnknownExternal -> UnknownExternal
      let snap2Sqlite!: ReturnType<SqliteGraphRepository["publish"]>;
      for (const repo of [sqliteRepo, memoryRepo] as const) {
        const b = repo.beginBuild({
          workspaceId: WS,
          revision: { id: "rev-edge-cases", sequence: 2 },
          configHash: "cfg",
          analyzerFingerprint: "fp",
          createdAt: T0,
        });
        const ws: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
          kind: "Workspace",
          qualifiedName: WS,
          language: "typescript",
          attributes: {},
        };
        const tsFile1: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "File", qualifiedName: "a.ts", relativePath: "a.ts" }),
          kind: "File",
          qualifiedName: "a.ts",
          language: "typescript",
          location: makeSpan("a.ts", 1),
          attributes: {},
        };
        const tsFn1: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "Function", qualifiedName: "fa", relativePath: "a.ts" }),
          kind: "Function",
          qualifiedName: "fa",
          language: "typescript",
          location: makeSpan("a.ts", 2),
          attributes: {},
        };
        const tsFn2: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "Function", qualifiedName: "fb", relativePath: "a.ts" }),
          kind: "Function",
          qualifiedName: "fb",
          language: "typescript",
          location: makeSpan("a.ts", 3),
          attributes: {},
        };
        const pyFile: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "File", qualifiedName: "b.py", relativePath: "b.py" }),
          kind: "File",
          qualifiedName: "b.py",
          language: "python",
          location: makeSpan("b.py", 1),
          attributes: {},
        };
        const pyFn: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "Function", qualifiedName: "py_fn", relativePath: "b.py" }),
          kind: "Function",
          qualifiedName: "py_fn",
          language: "python",
          location: makeSpan("b.py", 2),
          attributes: {},
        };
        const ext1: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "UnknownExternal", qualifiedName: "ext:one" }),
          kind: "UnknownExternal",
          qualifiedName: "ext:one",
          attributes: {},
        };
        const ext2: GraphNode = {
          id: nodeId({ workspaceId: WS, kind: "UnknownExternal", qualifiedName: "ext:two" }),
          kind: "UnknownExternal",
          qualifiedName: "ext:two",
          attributes: {},
        };
        const ev: Evidence = {
          id: evidenceId({
            workspaceId: WS,
            kind: "ast-span",
            span: makeSpan("a.ts", 1),
            analyzerId: "a",
            analyzerVersion: "1",
            rationale: "ev",
          }),
          kind: "ast-span",
          span: makeSpan("a.ts", 1),
          analyzerId: "a",
          analyzerVersion: "1",
          rationale: "ev",
        };
        for (const n of [ws, tsFile1, tsFn1, tsFn2, pyFile, pyFn, ext1, ext2]) {
          repo.addNode(b.buildId, n);
        }
        repo.addEvidence(b.buildId, ev);
        // Workspace --CONTAINS--> tsFile1 (excluded!)
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CONTAINS", from: ws.id, to: tsFile1.id, resolution: "verified", evidenceIds: [ev.id] }));
        // tsFile1 --CONTAINS--> tsFn1 & tsFn2 (typescript CONTAINS only!)
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CONTAINS", from: tsFile1.id, to: tsFn1.id, resolution: "verified", evidenceIds: [ev.id] }));
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CONTAINS", from: tsFile1.id, to: tsFn2.id, resolution: "verified", evidenceIds: [ev.id] }));
        // python CALLS (semantic edge ONLY in python!)
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CALLS", from: pyFn.id, to: ext1.id, resolution: "unresolved", evidenceIds: [ev.id] }));
        // UnknownExternal -> UnknownExternal (language-less on both ends — MUST NOT leak into typescript!)
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CALLS", from: ext1.id, to: ext2.id, resolution: "unresolved", evidenceIds: [ev.id] }));
        // UnknownExternal -> tsFn1 (CONTAINS fallback to typescript, counted once!)
        repo.addEdge(b.buildId, createEdge({ workspaceId: WS, kind: "CONTAINS", from: ext1.id, to: tsFn1.id, resolution: "heuristic", evidenceIds: [ev.id] }));

        const pub = repo.publish(b.buildId, "ready", "2026-11-24T12:02:00.000Z");
        if (repo === sqliteRepo) snap2Sqlite = pub;
      }

      const metaSqlite = sqliteRepo.getLatestWorkspaceSummaryMeta(WS);
      const metaMemory = memoryRepo.getLatestWorkspaceSummaryMeta(WS);
      expect(metaSqlite).toEqual(metaMemory);

      const byLang = new Map(metaSqlite!.languageCoverage.map((c) => [c.language, c]));
      // TypeScript has ONLY CONTAINS edges (2 verified from tsFile1 + 1 heuristic fallback from ext1; Workspace--CONTAINS excluded; ext1->ext2 CALLS NOT leaked!)
      expect(byLang.get("typescript")).toEqual({
        language: "typescript",
        files: 1,
        hasNonFileSymbols: true,
        hasSemanticEdges: false,
        verifiedEdges: 2,
        heuristicEdges: 1,
        unresolvedEdges: 0,
      });
      expect(byLang.get("python")).toEqual({
        language: "python",
        files: 1,
        hasNonFileSymbols: true,
        hasSemanticEdges: true,
        verifiedEdges: 0,
        heuristicEdges: 0,
        unresolvedEdges: 1,
      });

      const deps = makeServiceDeps(sqliteRepo, WS, tempRoot);
      const sum = workspaceSummary(deps, "req-edge-case", { workspaceId: WS });
      expect(sum.coverage).toEqual(coverageOf(snap2Sqlite));
    } finally {
      sqliteRepo.close();
    }
  });
});
