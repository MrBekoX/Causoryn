import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEdge,
  evidenceId,
  nodeId,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SourceSpan,
} from "@causoryn/domain";

import {
  GraphRepositoryError,
  SqliteGraphRepository,
} from "../src/index.js";

/**
 * SQLite GraphRepository test üçlüleri (TŞ v2.1 §9; sprint-1 görev 5).
 *
 * Pozitif: WAL/FK şeması, building → ready/publish akışı, FTS5 temel
 * arama, workspace/files. Negatif: dangling edge, duplicate build,
 * duplicate publish (transaction rollback senaryosu), ID uyuşmazlığı,
 * SQL enjeksiyonu GÖRÜNÜMLÜ girdilerin parametreli saklanması. Partial:
 * stale bayrağı, published-only FTS filtresi, yeniden açma kalıcılığı.
 *
 * Tüm veritabanları os.tmpdir() altındaki geçici dizindedir; depoya yazılmaz
 * (ADR-008). Tüm SQL girdileri hazırlanmış ifade parametreleriyle bağlanır.
 */

const WS = "ws_orders";
const CREATED_AT = "2026-11-02T10:00:00.000Z";
const PUBLISHED_AT = "2026-11-02T10:05:00.000Z";
const PUBLISHED_AT_2 = "2026-11-02T10:10:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-sqlite-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function dbPath(name: string): string {
  return path.join(tempRoot, name);
}

function span(
  relativePath: string,
  startLine: number,
  endLine: number,
): SourceSpan {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}`,
  };
}

function orderNodes(workspaceId = WS): GraphNode[] {
  const mk = (
    kind: GraphNode["kind"],
    qualifiedName: string,
    location?: SourceSpan,
  ): GraphNode => ({
    id: nodeId({
      workspaceId,
      kind,
      qualifiedName,
      ...(location === undefined
        ? {}
        : { relativePath: location.relativePath }),
    }),
    kind,
    qualifiedName,
    language: "typescript",
    ...(location === undefined ? {} : { location }),
    attributes: {},
  });
  return [
    mk("Workspace", workspaceId),
    mk("Endpoint", "POST /orders", span("src/orders/routes.ts", 8, 16)),
    mk("Class", "OrdersService", span("src/orders/service.ts", 3, 40)),
    mk("Class", "OrdersRepository", span("src/orders/service.ts", 42, 60)),
  ];
}

function orderEvidence(workspaceId = WS): Evidence[] {
  const mk = (
    kind: string,
    evidenceSpan: SourceSpan,
    rationale: string,
  ): Evidence => ({
    id: evidenceId({
      workspaceId,
      kind,
      span: evidenceSpan,
      analyzerId: "typescript-adapter",
      analyzerVersion: "0.1.0",
      rationale,
    }),
    kind,
    span: evidenceSpan,
    analyzerId: "typescript-adapter",
    analyzerVersion: "0.1.0",
    rationale,
  });
  return [
    mk("route-binding", span("src/orders/routes.ts", 8, 16), "Route dekoratörü endpoint'i bağlar."),
    mk("call-site", span("src/orders/service.ts", 21, 21), "Servis metodu repository çağrısı."),
  ];
}

function orderEdges(
  nodes: readonly GraphNode[],
  workspaceId = WS,
): GraphEdge[] {
  const [, endpoint, service, repository] = nodes;
  const evidence = orderEvidence(workspaceId);
  return [
    createEdge({
      workspaceId,
      kind: "ROUTES_TO",
      from: endpoint!.id,
      to: service!.id,
      resolution: "verified",
      evidenceIds: [evidence[0]!.id],
    }),
    createEdge({
      workspaceId,
      kind: "CALLS",
      from: service!.id,
      to: repository!.id,
      resolution: "verified",
      evidenceIds: [evidence[1]!.id],
    }),
  ];
}

function makeRepo(name: string): SqliteGraphRepository {
  const repo = new SqliteGraphRepository(dbPath(name));
  repo.registerWorkspace({
    id: WS,
    rootPath: "D:/fixture/orders",
    createdAt: CREATED_AT,
  });
  return repo;
}

function buildOrderSnapshot(repo: SqliteGraphRepository, sequence: number) {
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: `rev-${sequence}`, sequence },
    configHash: "cfg:001",
    analyzerFingerprint: "ts-adapter@0.1.0",
    createdAt: CREATED_AT,
  });
  const nodes = orderNodes();
  const evidence = orderEvidence();
  const edges = orderEdges(nodes);
  for (const node of nodes) repo.addNode(build.buildId, node);
  for (const item of evidence) repo.addEvidence(build.buildId, item);
  for (const edge of edges) repo.addEdge(build.buildId, edge);
  return { build, nodes, evidence, edges };
}

function expectRepoError(code: string, action: () => unknown): void {
  try {
    action();
    expect.fail(`GraphRepositoryError bekleniyordu: ${code}`);
  } catch (error) {
    expect(error, "hata GraphRepositoryError olmalı").toBeInstanceOf(
      GraphRepositoryError,
    );
    expect((error as GraphRepositoryError).code).toBe(code);
  }
}

/* ------------------------------------------------------------------ */
/* Şema ve bağlantı                                                    */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository — şema ve bağlantı", () => {
  it("dosya DB'sinde WAL, foreign_keys ve tablo ailesi kurulur", () => {
    const file = dbPath("graph.sqlite");
    const repo = new SqliteGraphRepository(file);
    try {
      const probe = new Database(file);
      const journalMode = probe.pragma("journal_mode", {
        simple: true,
      }) as string;
      expect(journalMode).toBe("wal");
      const foreignKeys = probe.pragma("foreign_keys", {
        simple: true,
      }) as number;
      expect(foreignKeys).toBe(1);

      const tables = (
        probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const table of [
        "workspaces",
        "files",
        "file_facts",
        "snapshots",
        "build_leases",
        "nodes",
        "edges",
        "evidence",
        "symbol_fts",
      ]) {
        expect(tables, `tablo yok: ${table}`).toContain(table);
      }
      expect(probe.pragma("page_size", { simple: true })).toBe(4096);
      expect(probe.pragma("user_version", { simple: true })).toBe(4);
      probe.close();
    } finally {
      repo.close();
    }
  });

  it("aynı dosya yeniden açıldığında veri kalıcıdır", () => {
    const file = dbPath("persist.sqlite");
    const first = new SqliteGraphRepository(file);
    first.registerWorkspace({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    const { build } = buildOrderSnapshot(first, 1);
    const graph = first.publish(build.buildId, "ready", PUBLISHED_AT);
    first.close();

    const second = new SqliteGraphRepository(file);
    try {
      const read = second.getSnapshot(graph.meta.id);
      expect(read?.snapshot.meta.id).toBe(graph.meta.id);
      expect(read?.snapshot.nodes.length).toBe(graph.nodes.length);
    } finally {
      second.close();
    }
  });

  it("yeniden açılan DB buildSerial sayacını MAX(sid) üzerinden başlatır (buildId tekrarı yok)", () => {
    const file = dbPath("serial-persist.sqlite");
    const first = new SqliteGraphRepository(file);
    first.registerWorkspace({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    const { build: firstBuild } = buildOrderSnapshot(first, 1);
    first.publish(firstBuild.buildId, "ready", PUBLISHED_AT);
    first.close();

    const second = new SqliteGraphRepository(file);
    try {
      const secondBuild = second.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      expect(secondBuild.buildId).not.toBe(firstBuild.buildId);
    } finally {
      second.close();
    }
  });

  it("farklı şema sürümü reddedilir", () => {
    const file = dbPath("future.sqlite");
    const probe = new Database(file);
    probe.pragma("user_version = 99");
    probe.close();
    expect(() => new SqliteGraphRepository(file)).toThrow(
      GraphRepositoryError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pozitif akış                                                        */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository — pozitif akış", () => {
  it("building → publish ready: snapshot döner, building asla görünmez", () => {
    const repo = makeRepo("positive.sqlite");
    try {
      const { build, nodes, evidence, edges } = buildOrderSnapshot(repo, 1);

      // Yayımdan önce: building snapshot hiçbir okuma yolunda görünmez.
      expect(repo.getSnapshot(build.buildId)).toBeUndefined();
      expect(repo.getLatestPublished(WS)).toBeUndefined();

      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      expect(graph.meta.state).toBe("ready");
      expect(graph.nodes.length).toBe(nodes.length);
      expect(graph.edges.length).toBe(edges.length);
      expect(graph.evidence.length).toBe(evidence.length);
      expect(repo.getSnapshot(graph.meta.id)?.stale).toBe(false);
      expect(repo.getBuild(build.buildId)).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("span, ambiguity ve attributes alanları kayıpsız döner", () => {
    const repo = makeRepo("fields.sqlite");
    try {
      repo.registerWorkspace({
        id: "ws_attrs",
        rootPath: "D:/fixture/attrs",
        createdAt: CREATED_AT,
      });
      const build = repo.beginBuild({
        workspaceId: "ws_attrs",
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      const node = {
        id: nodeId({
          workspaceId: "ws_attrs",
          kind: "Class",
          qualifiedName: "OrdersService",
          relativePath: "src/orders/service.ts",
        }),
        kind: "Class" as const,
        qualifiedName: "OrdersService",
        language: "typescript",
        location: span("src/orders/service.ts", 3, 40),
        attributes: {
          decorators: ["Injectable"],
          nested: { deep: [1, true, null, "son"] },
          count: 42,
          ratio: 0.5,
        },
      };
      repo.addNode(build.buildId, node);

      const second = nodeId({
        workspaceId: "ws_attrs",
        kind: "Class",
        qualifiedName: "OrdersRepository",
        relativePath: "src/orders/service.ts",
      });
      repo.addNode(build.buildId, {
        id: second,
        kind: "Class",
        qualifiedName: "OrdersRepository",
        language: "typescript",
        location: span("src/orders/service.ts", 42, 60),
        attributes: {},
      });
      repo.addEdge(build.buildId, {
        ...createEdge({
          workspaceId: "ws_attrs",
          kind: "CALLS",
          from: node.id,
          to: second,
          resolution: "heuristic",
          evidenceIds: [],
        }),
        ambiguity: {
          candidates: ["OrdersRepository", "LegacyOrdersRepository"],
          reason: "aynı isimli iki aday",
        },
      });
      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);

      expect(graph.nodes[0]?.attributes).toEqual(node.attributes);
      expect(graph.nodes[0]?.location).toEqual(node.location);
      expect(graph.edges[0]?.ambiguity?.candidates).toEqual([
        "OrdersRepository",
        "LegacyOrdersRepository",
      ]);
      expect(graph.edges[0]?.ambiguity?.reason).toBe(
        "aynı isimli iki aday",
      );
    } finally {
      repo.close();
    }
  });

  it("SQL enjeksiyonu görünümünde girdiler parametreli saklanır (davranışsal kanıt)", () => {
    const repo = makeRepo("injection.sqlite");
    try {
      repo.registerWorkspace({
        id: "ws_inj",
        rootPath: "D:/fixture/inj",
        createdAt: CREATED_AT,
      });
      const build = repo.beginBuild({
        workspaceId: "ws_inj",
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: CREATED_AT,
      });
      const hostile = "Robert'); DROP TABLE nodes;--";
      const node = {
        id: nodeId({
          workspaceId: "ws_inj",
          kind: "Class",
          qualifiedName: hostile,
        }),
        kind: "Class" as const,
        qualifiedName: hostile,
        attributes: { note: "' OR '1'='1" },
      };
      repo.addNode(build.buildId, node);
      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);

      // Tablo hâlâ yerinde; girdi kayıpsız ve değişmez olarak döner.
      const read = repo.getSnapshot(graph.meta.id);
      expect(read?.snapshot.nodes[0]?.qualifiedName).toBe(hostile);
      expect(read?.snapshot.nodes[0]?.attributes).toEqual(node.attributes);
      expect(read?.snapshot.nodes.length).toBe(1);

      // workspaces tablosu da ayakta: kayıt listelenir.
      expect(repo.listFiles("ws_inj")).toEqual([]);
    } finally {
      repo.close();
    }
  });

  it("workspace + files: upsert ve sıralı listeleme", () => {
    const repo = makeRepo("files.sqlite");
    try {
      repo.upsertFile({
        workspaceId: WS,
        relativePath: "src/orders/service.ts",
        contentHash: "sha256:aaa",
        sizeBytes: 120,
        updatedAt: CREATED_AT,
      });
      repo.upsertFile({
        workspaceId: WS,
        relativePath: "src/orders/routes.ts",
        contentHash: "sha256:bbb",
        sizeBytes: 40,
        updatedAt: CREATED_AT,
      });
      // Aynı yol tekrar: satır güncellenir, çoğalmaz.
      repo.upsertFile({
        workspaceId: WS,
        relativePath: "src/orders/service.ts",
        contentHash: "sha256:ccc",
        sizeBytes: 128,
        updatedAt: PUBLISHED_AT,
      });

      const files = repo.listFiles(WS);
      expect(files.map((file) => file.relativePath)).toEqual([
        "src/orders/routes.ts",
        "src/orders/service.ts",
      ]);
      expect(files[1]?.contentHash).toBe("sha256:ccc");
      expect(files[1]?.sizeBytes).toBe(128);

      expectRepoError("graph/unknown-workspace", () => {
        repo.upsertFile({
          workspaceId: "ws_yok",
          relativePath: "x.ts",
          contentHash: "h",
          sizeBytes: 1,
          updatedAt: CREATED_AT,
        });
      });
    } finally {
      repo.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Negatifler + transaction rollback                                   */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository — negatifler ve rollback", () => {
  it("dangling edge reddedilir; satır yazılmaz", () => {
    const repo = makeRepo("dangling.sqlite");
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      const nodes = orderNodes();
      const evidence = orderEvidence();
      const edges = orderEdges(nodes);
      for (const node of nodes) repo.addNode(build.buildId, node);
      for (const item of evidence) repo.addEvidence(build.buildId, item);
      repo.addEdge(build.buildId, edges[0]!);

      const ghost = nodeId({
        workspaceId: WS,
        kind: "Class",
        qualifiedName: "Ghost",
      });
      expectRepoError("graph/dangling-edge", () => {
        repo.addEdge(build.buildId, {
          id: `edge:${"0".repeat(64)}`,
          from: nodes[0]!.id,
          to: ghost,
          kind: "CALLS",
          resolution: "heuristic",
          evidenceIds: [],
        });
      });

      // Build sağlam: kalan doğru kenar eklenebilir, publish başarılı.
      repo.addEdge(build.buildId, edges[1]!);
      expect(
        repo.publish(build.buildId, "ready", PUBLISHED_AT).edges.length,
      ).toBe(2);
    } finally {
      repo.close();
    }
  });

  it("ID türetimiyle uyuşmayan node reddedilir", () => {
    const repo = makeRepo("idmismatch.sqlite");
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: CREATED_AT,
      });
      expectRepoError("graph/node-id-mismatch", () => {
        repo.addNode(build.buildId, {
          id: "node:deadbeef",
          kind: "Class",
          qualifiedName: "OrdersService",
          attributes: {},
        });
      });
    } finally {
      repo.close();
    }
  });

  it("aynı revizyon için ikinci aktif build reddedilir", () => {
    const repo = makeRepo("dupbuild.sqlite");
    try {
      repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: CREATED_AT,
      });
      expectRepoError("graph/build-already-active", () => {
        repo.beginBuild({
          workspaceId: WS,
          revision: { id: "rev-1", sequence: 1 },
          configHash: "cfg",
          analyzerFingerprint: "fp",
          createdAt: CREATED_AT,
        });
      });
    } finally {
      repo.close();
    }
  });

  it("ROLLBACK: aynı içerik yeniden yayımlanınca depo yarım durumda kalmaz", () => {
    // Snapshot ID içerikten türediği için aynı revizyon + aynı içerik aynı
    // final ID'yi üretir. Publish sırasında snapshots PK çakışması, işlem
    // içindeki tüm yazımları geri almalıdır (yarım snapshot asla görünmez).
    const file = dbPath("rollback.sqlite");
    const first = new SqliteGraphRepository(file);
    first.registerWorkspace({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    const a = buildOrderSnapshot(first, 1);
    const graphA = first.publish(a.build.buildId, "ready", PUBLISHED_AT);
    first.close();

    const second = new SqliteGraphRepository(file);
    try {
      const dup = second.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      const nodes = orderNodes();
      const evidence = orderEvidence();
      const edges = orderEdges(nodes);
      for (const node of nodes) second.addNode(dup.buildId, node);
      for (const item of evidence) second.addEvidence(dup.buildId, item);
      for (const edge of edges) second.addEdge(dup.buildId, edge);

      expectRepoError("graph/publish-failed", () => {
        second.publish(dup.buildId, "ready", PUBLISHED_AT_2);
      });

      // Rollback doğrulaması 1: önceki yayın hâlâ yerinde ve aynı içerikte.
      const probe = new Database(file);
      const snapshotRows = probe
        .prepare(
          "SELECT id, state FROM snapshots WHERE state IN ('ready','partial')",
        )
        .all() as Array<{ id: string; state: string }>;
      expect(snapshotRows.length, "yalnızca eski yayın kalmalı").toBe(1);
      expect(snapshotRows[0]?.id).toBe(graphA.meta.id);

      // Rollback doğrulaması 2: yeni build hâlâ building, id atanmamış.
      const buildingRows = probe
        .prepare("SELECT build_id, id, state FROM snapshots WHERE state='building'")
        .all() as Array<{ build_id: string; id: string | null; state: string }>;
      expect(buildingRows.length).toBe(1);
      expect(buildingRows[0]?.build_id).toBe(dup.buildId);
      expect(buildingRows[0]?.id).toBeNull();
      probe.close();

      // Uygulama düzeyi: eski yayın okunur; son yayın hâlâ A. Yeniden
      // indeksleme sürdüğü (building) için yayın stale=true işaretlenir.
      let latest = second.getLatestPublished(WS);
      expect(latest?.snapshot.meta.id).toBe(graphA.meta.id);
      expect(latest?.stale, "aktif yeniden indeksleme eski yayını stale yapar").toBe(true);

      // Build terk edilir: stale düşer, failed kayıt yayını etkilemez.
      second.failBuild(dup.buildId, "duplicate publish");
      latest = second.getLatestPublished(WS);
      expect(latest?.snapshot.meta.id).toBe(graphA.meta.id);
      expect(latest?.stale, "failed build eski yayını stale yapmaz").toBe(false);

      // Depo çalışmaya devam eder: yeni revizyon normal yayımlanır.
      const fresh = second.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-2", sequence: 2 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      const freshNodes = orderNodes();
      const freshEvidence = orderEvidence();
      const freshEdges = orderEdges(freshNodes);
      for (const node of freshNodes) second.addNode(fresh.buildId, node);
      for (const item of freshEvidence) second.addEvidence(fresh.buildId, item);
      for (const edge of freshEdges) second.addEdge(fresh.buildId, edge);
      const graphC = second.publish(fresh.buildId, "ready", PUBLISHED_AT_2);
      expect(graphC.meta.revision.sequence).toBe(2);
    } finally {
      second.close();
    }
  });

  it("failBuild sonrası build failed olur ve publish reddedilir", () => {
    const repo = makeRepo("failbuild.sqlite");
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: CREATED_AT,
      });
      repo.failBuild(build.buildId, "adapter çöktü");
      expect(repo.getBuild(build.buildId)?.state).toBe("failed");
      expect(repo.getBuild(build.buildId)?.failureReason).toBe("adapter çöktü");
      expectRepoError("graph/build-not-active", () => {
        repo.publish(build.buildId, "ready", PUBLISHED_AT);
      });
      expect(repo.getLatestPublished(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Atomik yayımlama + stale (SQLite tarafı)                            */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository — atomik yayımlama ve stale", () => {
  it("build sürerken eski yayın stale=true, building görünmez; yayın sonrası stale=false", () => {
    const repo = makeRepo("stale.sqlite");
    try {
      const a = buildOrderSnapshot(repo, 1);
      const graphA = repo.publish(a.build.buildId, "ready", PUBLISHED_AT);

      const b = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-2", sequence: 2 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      let latest = repo.getLatestPublished(WS);
      expect(latest?.snapshot.meta.id).toBe(graphA.meta.id);
      expect(latest?.stale).toBe(true);
      expect(repo.getSnapshot(b.buildId)).toBeUndefined();

      const nodes = orderNodes();
      const evidence = orderEvidence();
      const edges = orderEdges(nodes);
      for (const node of nodes) repo.addNode(b.buildId, node);
      for (const item of evidence) repo.addEvidence(b.buildId, item);
      for (const edge of edges) repo.addEdge(b.buildId, edge);
      const graphB = repo.publish(b.buildId, "ready", PUBLISHED_AT_2);

      latest = repo.getLatestPublished(WS);
      expect(latest?.snapshot.meta.id).toBe(graphB.meta.id);
      expect(latest?.stale).toBe(false);
      const old = repo.getSnapshot(graphA.meta.id);
      expect(old?.snapshot.meta.id).toBe(graphA.meta.id);
      expect(old?.stale).toBe(true);
    } finally {
      repo.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* FTS5 symbol_fts — temel ekleme/arama                                */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository — symbol_fts (temel)", () => {
  it("sembol eklenir, yayınlanmış snapshot içinde token eşleşmesiyle aranır", () => {
    const repo = makeRepo("fts.sqlite");
    try {
      const { build } = buildOrderSnapshot(repo, 1);
      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      repo.indexSymbols(graph.meta.id, [
        { symbol: "createOrder", nodeId: graph.nodes[1]!.id },
        { symbol: "listOrders", nodeId: graph.nodes[2]!.id },
      ]);

      // LocAgent camelCase tokenlaştırması + BM25: createOrder tam + alt-token
      // eşleşmesiyle 1. sırada, listOrders ortak "order" tokenıyla 2. sırada döner.
      const hits = repo.searchSymbols("createOrder");
      expect(hits.length).toBe(2);
      expect(hits[0]?.symbol).toBe("createOrder");
      expect(hits[0]?.nodeId).toBe(graph.nodes[1]!.id);
      expect(hits[0]?.snapshotId).toBe(graph.meta.id);
      expect(hits[1]?.symbol).toBe("listOrders");

      // Ortak "order" tokenına sahip tüm semboller (camelCase + snake_case)
      // deterministik BM25 + node_id sırasıyla döner.
      repo.indexSymbols(graph.meta.id, [
        { symbol: "order_total", nodeId: graph.nodes[2]!.id },
        { symbol: "order_item", nodeId: graph.nodes[3]!.id },
      ]);
      const ordered = repo.searchSymbols("order", 10);
      expect(ordered.map((hit) => hit.symbol)).toEqual(
        expect.arrayContaining([
          "createOrder",
          "listOrders",
          "order_item",
          "order_total",
        ]),
      );
      expect(ordered).toHaveLength(4);
      // Farklı token eşleşmez (alt-dize semantiği yok).
      expect(repo.searchSymbols("nomatchsymbol")).toEqual([]);
    } finally {
      repo.close();
    }
  });

  it("building sırasında indekslenen semboller yayınla aranır olur (published-only)", () => {
    const repo = makeRepo("fts-building.sqlite");
    try {
      const { build } = buildOrderSnapshot(repo, 1);
      repo.indexSymbols(build.buildId, [
        { symbol: "createOrder", nodeId: "node:x" },
      ]);
      // Building: arama sadece ready/partial satırlara JOIN eder.
      expect(repo.searchSymbols("createOrder")).toEqual([]);

      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      // Semboller snapshot'a (sid üzerinden) aittir; yayınlanınca aranır.
      const hits = repo.searchSymbols("createOrder");
      expect(hits.length).toBe(1);
      expect(hits[0]?.snapshotId).toBe(graph.meta.id);
    } finally {
      repo.close();
    }
  });

  it("FTS operatörü görünümü girdi düz metin gibi aranır (enjeksiyon yok)", () => {
    const repo = makeRepo("fts-quote.sqlite");
    try {
      const { build } = buildOrderSnapshot(repo, 1);
      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      repo.indexSymbols(graph.meta.id, [
        { symbol: 'create"Order', nodeId: graph.nodes[1]!.id },
      ]);
      // Tırnaklı girdi ifade (phrase) olarak bağlanır: hata üretmez, eşleşir.
      const hits = repo.searchSymbols('create"Order');
      expect(hits.length).toBe(1);
      expect(hits[0]?.symbol).toBe('create"Order');

      expectRepoError("graph/empty-required-field", () => {
        repo.searchSymbols("   ");
      });
      expectRepoError("graph/unknown-snapshot", () => {
        repo.indexSymbols("snapshot:yok", [{ symbol: "x", nodeId: "n" }]);
      });
    } finally {
      repo.close();
    }
  });
});

describe("SqliteGraphRepository — timestamp sözleşmesi (memory gerçeklemesiyle uyum)", () => {
  it("negatif: workspace.createdAt ISO-dışı değer reddedilir (graph/invalid-timestamp)", () => {
    const repo = new SqliteGraphRepository(dbPath("ts-workspace.sqlite"));
    expectRepoError("graph/invalid-timestamp", () => {
      repo.registerWorkspace({
        id: "ws_ts",
        rootPath: "D:/fixture/x",
        createdAt: "not-a-date",
      });
    });
    repo.close();
  });

  it("negatif: file.updatedAt ISO-dışı değer reddedilir (graph/invalid-timestamp)", () => {
    const repo = makeRepo("ts-file.sqlite");
    expectRepoError("graph/invalid-timestamp", () => {
      repo.upsertFile({
        workspaceId: WS,
        relativePath: "src/x.ts",
        contentHash: "hash-x",
        sizeBytes: 10,
        updatedAt: "not-a-date",
      });
    });
    repo.close();
  });
});

/* ------------------------------------------------------------------ */
/* Güvenlik bulgusu 3: silinen dosyanın files kaydı düşürülebilir      */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository.deleteFile — güvenlik bulgusu 3", () => {
  it("pozitif: kayıt parametreli DELETE ile düşürülür, true döner", () => {
    const repo = new SqliteGraphRepository(dbPath("delete-file.sqlite"));
    try {
      repo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      // Parametre GÖRÜNÜMÜ: SQL enjeksiyonu görünümlü girdi bile
      // hazırlanmış ifade parametresiyle bağlanır (mevcut suite kuralı).
      const injectionish = "src/x'; DROP TABLE files; --";
      repo.upsertFile({
        workspaceId: WS,
        relativePath: injectionish,
        contentHash: "hash-1",
        sizeBytes: 10,
        updatedAt: CREATED_AT,
      });
      repo.upsertFile({
        workspaceId: WS,
        relativePath: "src/kept.ts",
        contentHash: "hash-2",
        sizeBytes: 12,
        updatedAt: CREATED_AT,
      });

      expect(repo.deleteFile(WS, injectionish)).toBe(true);
      const paths = repo.listFiles(WS).map((record) => record.relativePath);
      expect(paths).toEqual(["src/kept.ts"]);
      // Tablo hâlâ sağlam (DROP görünümlü girdi parametreye bağlandı).
      expect(repo.deleteFile(WS, injectionish)).toBe(false);
      expect(repo.listFiles(WS).length).toBe(1);
    } finally {
      repo.close();
    }
  });

  it("negatif: bilinmeyen workspace GraphRepositoryError ile reddedilir", () => {
    const repo = new SqliteGraphRepository(dbPath("delete-file-ws.sqlite"));
    try {
      repo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      expect(() => repo.deleteFile("baska-ws", "src/x.ts")).toThrowError(
        GraphRepositoryError,
      );
    } finally {
      repo.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Security Analysis #2 — symbol_fts NUL byte ve tekilleştirme         */
/* ------------------------------------------------------------------ */

describe("SqliteGraphRepository.searchSymbols — NUL byte güvenliği ve tekilleştirme", () => {
  it("NUL byte içeren sorgu SqliteError fırlatmaz; birden çok snapshot yayımında (symbol, nodeId) en güncel yayına tekilleştirilir", () => {
    const repo = new SqliteGraphRepository(dbPath("fts-nul-dedup.sqlite"));
    try {
      repo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      const snap1 = buildOrderSnapshot(repo, 1);
      const pub1 = repo.publish(snap1.build.buildId, "ready", PUBLISHED_AT);
      const targetNode = pub1.nodes.find((n) => n.kind !== "Workspace");
      expect(targetNode).toBeDefined();
      const nodeIdVal = targetNode!.id;

      repo.indexSymbols(pub1.meta.id, [
        { symbol: "OrdersService", nodeId: nodeIdVal },
      ]);

      const snap2 = buildOrderSnapshot(repo, 2);
      const pub2 = repo.publish(snap2.build.buildId, "ready", PUBLISHED_AT_2);
      repo.indexSymbols(pub2.meta.id, [
        { symbol: "OrdersService", nodeId: nodeIdVal },
      ]);

      // 1) Çoklu snapshot yayımında aynı (symbol, nodeId) çifti tek satır döner (en güncel snapshotId).
      const normalHits = repo.searchSymbols("OrdersService", 10);
      expect(normalHits).toHaveLength(1);
      expect(normalHits[0]?.nodeId).toBe(nodeIdVal);
      expect(normalHits[0]?.snapshotId).toBe(pub2.meta.id);

      // 1b) snapshotId parametresi verildiğinde yalnızca o snapshot'ın kayıtları döner (eski/silinmiş sembol sızmaz).
      repo.indexSymbols(pub1.meta.id, [
        { symbol: "LegacyDeletedSymbol", nodeId: "node:legacy" },
      ]);
      expect(repo.searchSymbols("LegacyDeletedSymbol", 10, pub2.meta.id)).toEqual([]);
      expect(repo.searchSymbols("LegacyDeletedSymbol", 10, pub1.meta.id)).toEqual([
        { symbol: "LegacyDeletedSymbol", nodeId: "node:legacy", snapshotId: pub1.meta.id },
      ]);

      // 2) NUL byte içeren sorgu C-string kesilmesiyle SqliteError ("unterminated string") fırlatmaz.
      expect(() => repo.searchSymbols("Orders\0Service", 10)).not.toThrow();
      // Yalnızca NUL + boşluk kalan sorgu boş dizi döner.
      expect(repo.searchSymbols(" \0 \0 ", 10)).toEqual([]);
    } finally {
      repo.close();
    }
  });
});

describe("v0.2.1 SqliteGraphRepository.runInTransaction ve O(1) position sayacı", () => {
  it("toplu yazım tek transaction içinde çalışır, iç-içe çağrı güvenlidir ve rollback sonrası position sayacı tutarlı kalır", () => {
    const repo = makeRepo("tx-batch.sqlite");
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-tx", sequence: 1 },
        configHash: "cfg:tx",
        analyzerFingerprint: "fp:tx",
        createdAt: CREATED_AT,
      });
      const nodes = orderNodes();
      const evidence = orderEvidence();
      const edges = orderEdges(nodes);

      // Rollback senaryosu: hata fırlatan transaction içindeki eklemeler geri alınmalı:
      expect(() =>
        repo.runInTransaction(() => {
          repo.addNode(build.buildId, nodes[0]!);
          throw new Error("bilincli-rollback");
        }),
      ).toThrow("bilincli-rollback");

      expect(repo.getBuild(build.buildId)?.nodeCount).toBe(0);

      // İç-içe runInTransaction + tam ekleme ve publish:
      repo.runInTransaction(() => {
        repo.runInTransaction(() => {
          for (const n of nodes) repo.addNode(build.buildId, n);
          for (const ev of evidence) repo.addEvidence(build.buildId, ev);
          for (const ed of edges) repo.addEdge(build.buildId, ed);
        });
      });

      const published = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      expect(published.nodes).toHaveLength(nodes.length);
      expect(published.edges).toHaveLength(edges.length);
      expect(published.evidence).toHaveLength(evidence.length);

      // Read-through bellek önbelleği: ardışık okumalar aynı dondurulmuş SnapshotGraph referansını döner:
      const read1 = repo.getLatestPublished(WS);
      const read2 = repo.getLatestPublished(WS);
      expect(read1?.snapshot).toBe(published);
      expect(read2?.snapshot).toBe(published);
    } finally {
      repo.close();
    }
  });

  it("dış bağlantı SQLite satırını değiştirdiğinde PRAGMA data_version önbelleği geçersiz kılar", () => {
    const file = dbPath("cache-invalidation.sqlite");
    const repo = new SqliteGraphRepository(file);
    try {
      repo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      const built = buildOrderSnapshot(repo, 1);
      const published = repo.publish(built.build.buildId, "ready", PUBLISHED_AT);
      expect(repo.getLatestPublished(WS)?.snapshot).toBe(published);

      // Başka bir bağlantıdan veritabanındaki snapshot kimliği bozulursa cache bayat dönmemeli:
      const external = new Database(file);
      try {
        external.prepare("UPDATE snapshots SET id = 'snapshot:tampered' WHERE id = ?").run(published.meta.id);
      } finally {
        external.close();
      }
      expectRepoError("storage/corrupt-snapshot", () => {
        repo.getLatestPublished(WS);
      });
    } finally {
      repo.close();
    }
  });
});

describe("Task 1.7 — SqliteGraphRepository build_leases ve recoverOrphanBuilds", () => {
  it("acquire / renew / release / publish-cleanup / failBuild-cleanup yaşam döngüsünü atomik yürütür", () => {
    const repo = makeRepo("leases.sqlite");
    try {
      const built = buildOrderSnapshot(repo, 1);
      const acq1 = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: built.build.buildId,
        leaseId: "lease-1",
        ownerPid: process.pid,
        hostLabel: "claude-code",
        nowIso: CREATED_AT,
        ttlMs: 30_000,
      });
      expect(acq1.acquired).toBe(true);
      expect(repo.getActiveBuildLease(WS)?.leaseId).toBe("lease-1");
      expect(repo.getActiveBuildLease(WS)?.hostLabel).toBe("claude-code");

      // Canlı lease varken ikinci edinen reddedilir ve mevcut holder döner.
      const acq2 = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: "build-other",
        leaseId: "lease-2",
        ownerPid: process.pid,
        hostLabel: "codex",
        nowIso: CREATED_AT,
        ttlMs: 30_000,
        isPidAlive: () => true,
      });
      expect(acq2.acquired).toBe(false);
      if (!acq2.acquired) {
        expect(acq2.holder.leaseId).toBe("lease-1");
        expect(acq2.holder.hostLabel).toBe("claude-code");
      }

      // Yenileme doğru leaseId ile başarılı, yanlış leaseId ile false döner.
      expect(repo.renewBuildLease(WS, "wrong-lease", PUBLISHED_AT, 30_000)).toBe(false);
      expect(repo.renewBuildLease(WS, "lease-1", PUBLISHED_AT, 30_000)).toBe(true);
      expect(repo.getActiveBuildLease(WS)?.heartbeatAt).toBe(PUBLISHED_AT);

      // publish() eşleşen lease satırını atomik olarak temizler.
      repo.publish(built.build.buildId, "ready", PUBLISHED_AT);
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();

      // failBuild() de eşleşen lease satırını atomik olarak temizler.
      const built2 = buildOrderSnapshot(repo, 2);
      const acq3 = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: built2.build.buildId,
        leaseId: "lease-3",
        ownerPid: process.pid,
        nowIso: PUBLISHED_AT,
        ttlMs: 30_000,
      });
      expect(acq3.acquired).toBe(true);
      repo.failBuild(built2.build.buildId, "aborted");
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();

      // releaseBuildLease idempotenttir (olmayan lease için fırlatmaz).
      expect(() => repo.releaseBuildLease(WS, "lease-3")).not.toThrow();
    } finally {
      repo.close();
    }
  });

  it("recoverOrphanBuilds canlı lease'i korur; lease'siz, süresi dolmuş veya ölü PID'li building satırlarını kurtarır", () => {
    const repo = makeRepo("orphan-unit.sqlite");
    try {
      const liveBuild = buildOrderSnapshot(repo, 1).build;
      const orphanBuild = buildOrderSnapshot(repo, 2).build;
      repo.acquireBuildLease({
        workspaceId: WS,
        buildId: liveBuild.buildId,
        leaseId: "lease-live",
        ownerPid: process.pid,
        nowIso: CREATED_AT,
        ttlMs: 30_000,
      });

      // Canlı lease liveBuild'i korur, ama lease ile eşleşmeyen orphanBuild kurtarılır!
      const partialRecovery = repo.recoverOrphanBuilds(WS, {
        nowIso: CREATED_AT,
        isPidAlive: () => true,
      });
      expect(partialRecovery.recoveredBuildIds).toEqual([orphanBuild.buildId]);
      expect(partialRecovery.clearedLease).toBe(false);
      expect(repo.getBuild(liveBuild.buildId)?.state).toBe("building");
      expect(repo.getBuild(orphanBuild.buildId)?.state).toBe("failed");
      expect(repo.getBuild(orphanBuild.buildId)?.failureReason).toBe("orphan-build-recovered");
      expect(repo.getActiveBuildLease(WS)?.leaseId).toBe("lease-live");

      // Süre dolduğunda (PUBLISHED_AT = CREATED_AT + 5 dk > 30 sn) liveBuild ve lease temizlenir.
      const fullRecovery = repo.recoverOrphanBuilds(WS, {
        nowIso: PUBLISHED_AT,
        isPidAlive: () => true,
      });
      expect(fullRecovery.recoveredBuildIds).toEqual([liveBuild.buildId]);
      expect(fullRecovery.clearedLease).toBe(true);
      expect(repo.getBuild(liveBuild.buildId)?.state).toBe("failed");
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });
});

describe("SqliteGraphRepository.getLatestWorkspaceSummaryMeta — zero-hydration SQLite aggregation", () => {
  it("returns undefined before publish, aggregates counts/entrypoints/frameworks/resolutions/languageCoverage, and tracks stale & external invalidation", () => {
    const file = dbPath("summary-meta.sqlite");
    const repo = new SqliteGraphRepository(file);
    try {
      repo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });

      // No snapshot published yet (even while building)
      expect(repo.getLatestWorkspaceSummaryMeta(WS)).toBeUndefined();
      const { build } = buildOrderSnapshot(repo, 1);
      expect(repo.getLatestWorkspaceSummaryMeta(WS)).toBeUndefined();

      const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
      const summary = repo.getLatestWorkspaceSummaryMeta(WS);
      expect(summary).toBeDefined();
      expect(summary?.snapshotId).toBe(graph.meta.id);
      expect(summary?.workspaceId).toBe(WS);
      expect(summary?.state).toBe("ready");
      expect(summary?.revisionId).toBe("rev-1");
      expect(summary?.revisionSequence).toBe(1);
      expect(summary?.stale).toBe(false);
      expect(summary?.nodeCount).toBe(4);
      expect(summary?.edgeCount).toBe(2);
      expect(summary?.evidenceCount).toBe(2);
      expect(summary?.fileCount).toBe(0);
      expect(summary?.languages).toEqual([]);
      expect(summary?.frameworks).toEqual([]);
      expect(summary?.entrypoints).toEqual(["POST /orders"]);
      expect(summary?.edgesByKind).toEqual({ CALLS: 1, ROUTES_TO: 1 });
      expect(summary?.resolutions).toEqual({ verified: 2, heuristic: 0, unresolved: 0 });
      expect(summary?.languageCoverage).toEqual([
        {
          language: "typescript",
          files: 0,
          hasNonFileSymbols: true,
          hasSemanticEdges: true,
          verifiedEdges: 2,
          heuristicEdges: 0,
          unresolvedEdges: 0,
        },
      ]);

      // Active newer build flips stale -> true immediately (never stale-cached)
      const nextBuild = buildOrderSnapshot(repo, 2).build;
      expect(repo.getLatestWorkspaceSummaryMeta(WS)?.stale).toBe(true);

      // Failing the newer build flips stale back -> false
      repo.failBuild(nextBuild.buildId, "cancelled");
      expect(repo.getLatestWorkspaceSummaryMeta(WS)?.stale).toBe(false);

      // External connection write invalidates any cached summary via PRAGMA data_version
      const external = new Database(file);
      try {
        external
          .prepare("UPDATE nodes SET attributes_json = ? WHERE kind = 'Endpoint'")
          .run(JSON.stringify({ framework: "express" }));
      } finally {
        external.close();
      }
      expect(repo.getLatestWorkspaceSummaryMeta(WS)?.frameworks).toEqual(["express"]);
    } finally {
      repo.close();
    }
  });

  it("pins an MVCC read transaction so concurrent publish + pruneOldSnapshots cannot tear getLatestWorkspaceSummaryMeta", () => {
    const file = dbPath("summary-meta-mvcc.sqlite");
    const writer = new SqliteGraphRepository(file);
    const reader = new SqliteGraphRepository(file);
    try {
      writer.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      const b1 = buildOrderSnapshot(writer, 1);
      const snap1 = writer.publish(b1.build.buildId, "ready", PUBLISHED_AT);

      const readerInternal = reader as unknown as {
        countRows: (table: "nodes" | "edges" | "evidence", sid: number) => number;
      };
      const origCountRows = readerInternal.countRows.bind(reader);
      let injected = false;
      readerInternal.countRows = (table, sid) => {
        if (!injected) {
          injected = true;
          const b2 = buildOrderSnapshot(writer, 2);
          writer.publish(b2.build.buildId, "ready", PUBLISHED_AT_2);
          const gc = writer.pruneOldSnapshots(WS, 1);
          expect(gc.prunedSnapshotSids).toBe(1);
        }
        return origCountRows(table, sid);
      };

      const meta = reader.getLatestWorkspaceSummaryMeta(WS);
      readerInternal.countRows = origCountRows;

      expect(injected).toBe(true);
      expect(meta?.snapshotId).toBe(snap1.meta.id);
      expect(meta?.nodeCount).toBe(4);
      expect(meta?.edgeCount).toBe(2);
      expect(meta?.evidenceCount).toBe(2);
      expect(meta?.stale).toBe(false);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
