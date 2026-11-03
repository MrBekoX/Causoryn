import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  type SourceSpan,
} from "@causoryn/domain";

import { InMemoryGraphRepository } from "@causoryn/graph";

import { SqliteGraphRepository } from "../src/index.js";

/**
 * Bellek ↔ SQLite round-trip eşitliği ve determinizm (TŞ v2.1 §8 invariant
 * vi: aynı girdi → aynı Graph JSON; sprint-1 görev 5).
 *
 * Aynı build girdileri hem InMemoryGraphRepository'ye hem
 * SqliteGraphRepository'ye akıtılır; yayımlanan snapshot'lar domain
 * `snapshotCanonicalJson` üzerinden karşılaştırılır. Ek olarak ikinci bir
 * SQLite dosyasına yeniden yayın: aynı ID + aynı JSON (determinizm).
 */

const WS = "ws_roundtrip";
const CREATED_AT = "2026-11-02T09:00:00.000Z";
const PUBLISHED_AT = "2026-11-02T09:30:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-roundtrip-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

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

/** Zenginleştirilmiş fixture: tüm alan çeşitleri temsil edilsin. */
function fixtureNodes(workspaceId: string): GraphNode[] {
  const mk = (
    kind: GraphNode["kind"],
    qualifiedName: string,
    location?: SourceSpan,
    attributes: Readonly<Record<string, unknown>> = {},
    language?: string,
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
    ...(language === undefined ? {} : { language }),
    ...(location === undefined ? {} : { location }),
    attributes,
  });
  return [
    mk("Workspace", workspaceId, undefined, { rootHint: "orders" }),
    mk(
      "Endpoint",
      "POST /orders",
      span("src/orders/routes.ts", 8, 16),
      { method: "POST" },
      "typescript",
    ),
    mk(
      "Class",
      "OrdersService",
      span("src/orders/service.ts", 3, 40),
      { decorators: ["Injectable"], weight: 1.5, active: true },
      "typescript",
    ),
    mk("Class", "OrdersRepository", span("src/orders/service.ts", 42, 60)),
  ];
}

function fixtureEvidence(workspaceId: string): Evidence[] {
  const mk = (
    kind: string,
    evidenceSpan: SourceSpan | undefined,
    rationale: string,
  ): Evidence => ({
    id: evidenceId({
      workspaceId,
      kind,
      ...(evidenceSpan === undefined ? {} : { span: evidenceSpan }),
      analyzerId: "typescript-adapter",
      analyzerVersion: "0.1.0",
      rationale,
    }),
    kind,
    ...(evidenceSpan === undefined ? {} : { span: evidenceSpan }),
    analyzerId: "typescript-adapter",
    analyzerVersion: "0.1.0",
    rationale,
  });
  return [
    mk("route-binding", span("src/orders/routes.ts", 8, 16), "Route dekoratörü eşleşti."),
    mk("call-site", span("src/orders/service.ts", 21, 21), "Metot gövdesinde çağrı."),
    mk("heuristic-note", undefined, "Konumsuz kanıt: import grafiği."),
  ];
}

function fixtureEdges(
  workspaceId: string,
  nodes: readonly GraphNode[],
  evidence: readonly Evidence[],
): GraphEdge[] {
  const [, endpoint, service, repository] = nodes;
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
    createEdge({
      workspaceId,
      kind: "DEPENDS_ON",
      from: repository!.id,
      to: nodes[0]!.id,
      resolution: "heuristic",
      evidenceIds: [],
      ambiguity: {
        candidates: [nodes[0]!.qualifiedName],
        reason: "modül düzeyi eşleme",
      },
    }),
  ];
}

interface BuildContent {
  readonly nodes: readonly GraphNode[];
  readonly evidence: readonly Evidence[];
  readonly edges: readonly GraphEdge[];
}

function feedBuild(
  repo: InMemoryGraphRepository | SqliteGraphRepository,
  content: BuildContent,
): string {
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg:rt",
    analyzerFingerprint: "ts-adapter@0.1.0",
    createdAt: CREATED_AT,
  });
  for (const node of content.nodes) repo.addNode(build.buildId, node);
  for (const item of content.evidence) repo.addEvidence(build.buildId, item);
  for (const edge of content.edges) repo.addEdge(build.buildId, edge);
  return build.buildId;
}

/** Domain createSnapshot ile aynı sözleşmeden doğrudan golden üretimi. */
function goldenSnapshot(content: BuildContent) {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg:rt",
    analyzerFingerprint: "ts-adapter@0.1.0",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: content.nodes.map((node) => ({
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      ...(node.location === undefined
        ? {}
        : { relativePath: node.location.relativePath }),
      ...(node.language === undefined ? {} : { language: node.language }),
      ...(node.location === undefined ? {} : { location: node.location }),
      attributes: node.attributes,
    })),
    edges: content.edges.map((edge) => {
      const from = content.nodes.find((node) => node.id === edge.from);
      const to = content.nodes.find((node) => node.id === edge.to);
      if (from === undefined || to === undefined) {
        throw new Error("golden fixture uç çözümlemesi başarısız");
      }
      return {
        kind: edge.kind,
        from: {
          kind: from.kind,
          qualifiedName: from.qualifiedName,
          ...(from.location === undefined
            ? {}
            : { relativePath: from.location.relativePath }),
        },
        to: {
          kind: to.kind,
          qualifiedName: to.qualifiedName,
          ...(to.location === undefined
            ? {}
            : { relativePath: to.location.relativePath }),
        },
        resolution: edge.resolution,
        evidence: edge.evidenceIds.map((id) => {
          const item = content.evidence.find((candidate) => candidate.id === id);
          if (item === undefined) {
            throw new Error("golden fixture kanıt çözümlemesi başarısız");
          }
          return {
            kind: item.kind,
            ...(item.span === undefined ? {} : { span: item.span }),
            analyzerId: item.analyzerId,
            analyzerVersion: item.analyzerVersion,
            rationale: item.rationale,
          };
        }),
        ...(edge.ambiguity === undefined
          ? {}
          : {
              ambiguity: {
                candidates: [...edge.ambiguity.candidates],
                reason: edge.ambiguity.reason,
              },
            }),
      };
    }),
    evidence: content.evidence.map((item) => ({
      kind: item.kind,
      ...(item.span === undefined ? {} : { span: item.span }),
      analyzerId: item.analyzerId,
      analyzerVersion: item.analyzerVersion,
      rationale: item.rationale,
    })),
  });
}

describe("bellek ↔ SQLite round-trip eşitliği", () => {
  it("aynı girdiler her iki depoda aynı snapshot ID + aynı Graph JSON üretir", () => {
    const content: BuildContent = {
      nodes: fixtureNodes(WS),
      evidence: fixtureEvidence(WS),
      edges: fixtureEdges(WS, fixtureNodes(WS), fixtureEvidence(WS)),
    };

    const memoryRepo = new InMemoryGraphRepository();
    memoryRepo.registerWorkspace({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    const memoryBuildId = feedBuild(memoryRepo, content);
    const memoryGraph = memoryRepo.publish(
      memoryBuildId,
      "ready",
      PUBLISHED_AT,
    );

    const sqliteRepo = new SqliteGraphRepository(
      path.join(tempRoot, "rt.sqlite"),
    );
    try {
      sqliteRepo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      const sqliteBuildId = feedBuild(sqliteRepo, content);
      const sqliteGraph = sqliteRepo.publish(
        sqliteBuildId,
        "ready",
        PUBLISHED_AT,
      );

      const golden = goldenSnapshot(content);

      // 1) Deterministik snapshot ID üç üretimde de aynı.
      expect(memoryGraph.meta.id).toBe(golden.meta.id);
      expect(sqliteGraph.meta.id).toBe(golden.meta.id);

      // 2) Canonical JSON eşitliği (invariant vi) — depodan geri okuma dahil.
      const memoryRead = memoryRepo.getSnapshot(memoryGraph.meta.id);
      const sqliteRead = sqliteRepo.getSnapshot(sqliteGraph.meta.id);
      expect(memoryRead).toBeDefined();
      expect(sqliteRead).toBeDefined();
      const memoryJson = snapshotCanonicalJson(memoryRead!.snapshot);
      const sqliteJson = snapshotCanonicalJson(sqliteRead!.snapshot);
      expect(memoryJson).toBe(snapshotCanonicalJson(golden));
      expect(sqliteJson).toBe(memoryJson);

      // 3) stale bayrağı iki depoda aynı.
      expect(memoryRead?.stale).toBe(sqliteRead?.stale);

      // 4) getLatestPublished alanları birebir.
      const memoryLatest = memoryRepo.getLatestPublished(WS);
      const sqliteLatest = sqliteRepo.getLatestPublished(WS);
      expect(snapshotCanonicalJson(memoryLatest!.snapshot)).toBe(sqliteJson);
      expect(memoryLatest?.stale).toBe(sqliteLatest?.stale);
    } finally {
      sqliteRepo.close();
    }
  });

  it("build sürerken stale bayrağı iki depoda da true olur", () => {
    const content: BuildContent = {
      nodes: fixtureNodes(WS),
      evidence: fixtureEvidence(WS),
      edges: [],
    };
    const memoryRepo = new InMemoryGraphRepository();
    memoryRepo.registerWorkspace({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    const first = feedBuild(memoryRepo, content);
    memoryRepo.publish(first, "ready", PUBLISHED_AT);

    const sqliteRepo = new SqliteGraphRepository(
      path.join(tempRoot, "rt-stale.sqlite"),
    );
    try {
      sqliteRepo.registerWorkspace({
        id: WS,
        rootPath: "D:/fixture/orders",
        createdAt: CREATED_AT,
      });
      const firstSql = feedBuild(sqliteRepo, content);
      sqliteRepo.publish(firstSql, "ready", PUBLISHED_AT);

      memoryRepo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-2", sequence: 2 },
        configHash: "cfg:rt",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });
      sqliteRepo.beginBuild({
        workspaceId: WS,
        revision: { id: "rev-2", sequence: 2 },
        configHash: "cfg:rt",
        analyzerFingerprint: "ts-adapter@0.1.0",
        createdAt: CREATED_AT,
      });

      expect(memoryRepo.getLatestPublished(WS)?.stale).toBe(true);
      expect(sqliteRepo.getLatestPublished(WS)?.stale).toBe(true);
    } finally {
      sqliteRepo.close();
    }
  });
});

describe("determinizm (SQLite)", () => {
  it("iki ayrı veritabanı dosyası: aynı girdi → aynı ID ve aynı JSON", () => {
    const content: BuildContent = {
      nodes: fixtureNodes(WS),
      evidence: fixtureEvidence(WS),
      edges: fixtureEdges(WS, fixtureNodes(WS), fixtureEvidence(WS)),
    };

    const runOnce = (fileName: string): string => {
      const repo = new SqliteGraphRepository(path.join(tempRoot, fileName));
      try {
        repo.registerWorkspace({
          id: WS,
          rootPath: "D:/fixture/orders",
          createdAt: CREATED_AT,
        });
        const buildId = feedBuild(repo, content);
        const graph = repo.publish(buildId, "ready", PUBLISHED_AT);
        const read = repo.getSnapshot(graph.meta.id);
        return snapshotCanonicalJson(read!.snapshot);
      } finally {
        repo.close();
      }
    };

    const jsonA = runOnce("det-a.sqlite");
    const jsonB = runOnce("det-b.sqlite");
    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe(
      snapshotCanonicalJson(goldenSnapshot(content)),
    );
  });
});
