import { describe, expect, it } from "vitest";

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

import {
  GraphRepositoryError,
  InMemoryGraphRepository,
} from "../src/index.js";

/**
 * In-memory GraphRepository test üçlüleri (TŞ v2.1 §8/§9, ADR-005; sprint-1
 * görev 5). Pozitif: building → ready/partial atomik yayımlama. Negatif:
 * dangling edge, verified-kanıtsız kenar, duplicate node, ID uyuşmazlığı
 * (determinizm koruması), unknown workspace/build. Partial: stale bayrağı,
 * eski snapshot sorgulanabilirliği, ekleme sırasından bağımsız determinizm.
 *
 * Depo SAAT OKUMAZ: tüm zaman damgaları test tarafından sabit verilir.
 */

const WS = "ws_orders";
const CREATED_AT = "2026-11-02T10:00:00.000Z";
const PUBLISHED_AT = "2026-11-02T10:05:00.000Z";
const PUBLISHED_AT_2 = "2026-11-02T10:10:00.000Z";

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

function makeRepo(): InMemoryGraphRepository {
  const repo = new InMemoryGraphRepository();
  repo.registerWorkspace({
    id: WS,
    rootPath: "D:/fixture/orders",
    createdAt: CREATED_AT,
  });
  return repo;
}

/** POST /orders → OrdersService → OrdersRepository zinciri (sprint-1 görev 4 kanalı). */
function orderNodes(): GraphNode[] {
  const mk = (
    kind: GraphNode["kind"],
    qualifiedName: string,
    location?: SourceSpan,
  ): GraphNode => ({
    id: nodeId({
      workspaceId: WS,
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
    mk("Workspace", WS),
    mk("Endpoint", "POST /orders", span("src/orders/routes.ts", 8, 16)),
    mk("Class", "OrdersService", span("src/orders/service.ts", 3, 40)),
    mk("Class", "OrdersRepository", span("src/orders/service.ts", 42, 60)),
  ];
}

function orderEvidence(): Evidence[] {
  const mk = (
    kind: string,
    evidenceSpan: SourceSpan,
    rationale: string,
  ): Evidence => ({
    id: evidenceId({
      workspaceId: WS,
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

function orderEdges(nodes: readonly GraphNode[]): GraphEdge[] {
  const [, endpoint, service, repository] = nodes;
  if (endpoint === undefined || service === undefined || repository === undefined) {
    throw new Error("fixture node eksik");
  }
  return [
    createEdge({
      workspaceId: WS,
      kind: "ROUTES_TO",
      from: endpoint.id,
      to: service.id,
      resolution: "verified",
      evidenceIds: [orderEvidence()[0]!.id],
    }),
    createEdge({
      workspaceId: WS,
      kind: "CALLS",
      from: service.id,
      to: repository.id,
      resolution: "verified",
      evidenceIds: [orderEvidence()[1]!.id],
    }),
  ];
}

function buildOrderSnapshot(repo: InMemoryGraphRepository, sequence: number) {
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
/* Pozitif: building → publish akışı                                   */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository — pozitif akış", () => {
  it("beginBuild → add* → publish ready: snapshot döner ve sorgulanır", () => {
    const repo = makeRepo();
    const { build, nodes, evidence, edges } = buildOrderSnapshot(repo, 1);

    // Yayımdan ÖNCE building snapshot asla görünmez.
    expect(repo.getSnapshot(build.buildId)).toBeUndefined();
    expect(repo.getLatestPublished(WS)).toBeUndefined();

    const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
    expect(graph.meta.state).toBe("ready");
    expect(graph.meta.workspaceId).toBe(WS);
    expect(graph.meta.revision.sequence).toBe(1);
    expect(graph.nodes.length).toBe(nodes.length);
    expect(graph.edges.length).toBe(edges.length);
    expect(graph.evidence.length).toBe(evidence.length);

    // Yayımlanan snapshot ID ile sorgulanır.
    const read = repo.getSnapshot(graph.meta.id);
    expect(read).toBeDefined();
    expect(read?.snapshot.meta.id).toBe(graph.meta.id);
    expect(read?.stale).toBe(false);

    // getLatestPublished: en son yayımlanan, stale=false.
    const latest = repo.getLatestPublished(WS);
    expect(latest?.snapshot.meta.id).toBe(graph.meta.id);
    expect(latest?.stale).toBe(false);

    // Build tüketildi: build kimliği artık aktif değil.
    expect(repo.getBuild(build.buildId)).toBeUndefined();
  });

  it("publish partial: coverage eksikken usable snapshot olarak görünür", () => {
    const repo = makeRepo();
    const build = repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-partial", sequence: 1 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      createdAt: CREATED_AT,
    });
    const nodes = orderNodes();
    for (const node of nodes) repo.addNode(build.buildId, node);
    // Kanıtsız: heuristic kenar.
    const [, endpoint, service] = nodes;
    repo.addEdge(build.buildId, {
      ...createEdge({
        workspaceId: WS,
        kind: "CALLS",
        from: endpoint!.id,
        to: service!.id,
        resolution: "heuristic",
        evidenceIds: [],
      }),
    });

    const graph = repo.publish(build.buildId, "partial", PUBLISHED_AT);
    expect(graph.meta.state).toBe("partial");
    expect(repo.getLatestPublished(WS)?.snapshot.meta.state).toBe("partial");
  });

  it("eksik kenar uçları golden createSnapshot çıktısıyla aynıdır", () => {
    // Depo, domain createSnapshot ile aynı deterministik ID'yi üretmeli.
    const repo = makeRepo();
    const { build } = buildOrderSnapshot(repo, 1);
    const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);

    const golden = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: orderNodes().map((node) => ({
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        ...(node.location === undefined
          ? {}
          : { relativePath: node.location.relativePath }),
        ...(node.language === undefined ? {} : { language: node.language }),
        ...(node.location === undefined ? {} : { location: node.location }),
        attributes: node.attributes,
      })),
      edges: [],
      evidence: [],
    });
    // Kenarları golden'a ekleyemeyiz (createSnapshot input'u NodeRef ister);
    // yalnızca node kimliklerini karşılaştırıyoruz: depo ID'leri domain
    // türetimiyle birebir aynı olmalı.
    const repoNodeIds = new Set(graph.nodes.map((node) => node.id));
    for (const goldenNode of golden.nodes) {
      expect(repoNodeIds.has(goldenNode.id)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Negatifler                                                          */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository — negatifler", () => {
  it("dangling edge reddedilir; build kullanılabilir kalır", () => {
    const repo = makeRepo();
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

    const ghostId = nodeId({
      workspaceId: WS,
      kind: "Class",
      qualifiedName: "Ghost",
    });
    expectRepoError("graph/dangling-edge", () => {
      repo.addEdge(build.buildId, {
        id: `edge:${"0".repeat(64)}`,
        from: nodes[1]!.id,
        to: ghostId,
        kind: "CALLS",
        resolution: "heuristic",
        evidenceIds: [],
      });
    });

    // Build bozulmadı: kalan doğru kenar eklenebilir ve publish başarılı.
    repo.addEdge(build.buildId, edges[1]!);
    const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
    expect(graph.edges.length).toBe(2);
  });

  it("verified kanıtsız kenar reddedilir (ADR-004)", () => {
    const repo = makeRepo();
    const { build, nodes } = buildOrderSnapshot(repo, 1);
    const [, endpoint, service] = nodes;
    expectRepoError("graph/verified-edge-requires-evidence", () => {
      repo.addEdge(build.buildId, {
        id: `edge:${"1".repeat(64)}`,
        from: endpoint!.id,
        to: service!.id,
        kind: "CALLS",
        resolution: "verified",
        evidenceIds: [],
      });
    });
  });

  it("duplicate node reddedilir", () => {
    const repo = makeRepo();
    const { build, nodes } = buildOrderSnapshot(repo, 1);
    expectRepoError("graph/duplicate-node", () => {
      repo.addNode(build.buildId, nodes[0]!);
    });
  });

  it("ID türetimiyle uyuşmayan node reddedilir (determinizm koruması)", () => {
    const repo = makeRepo();
    const build = repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-idm", sequence: 1 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
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
  });

  it("bilinmeyen workspace için beginBuild reddedilir", () => {
    const repo = makeRepo();
    expectRepoError("graph/unknown-workspace", () => {
      repo.beginBuild({
        workspaceId: "ws_yok",
        revision: { id: "rev-x", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: CREATED_AT,
      });
    });
  });

  it("aynı (workspace, revision) için ikinci aktif build reddedilir", () => {
    const repo = makeRepo();
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
  });

  it("publish: kanıt referansı bilinmeyen kenar reddedilir ve build building kalır", () => {
    const repo = makeRepo();
    const { build, nodes } = buildOrderSnapshot(repo, 1);
    const [, endpoint, service] = nodes;
    repo.addEdge(build.buildId, {
      ...createEdge({
        workspaceId: WS,
        kind: "CALLS",
        from: endpoint!.id,
        to: service!.id,
        resolution: "heuristic",
        evidenceIds: [],
      }),
      evidenceIds: ["evidence:hayalurun"],
    });

    expectRepoError("graph/unknown-evidence-ref", () => {
      repo.publish(build.buildId, "ready", PUBLISHED_AT);
    });
    // Rollback semantiği (memory): build hâlâ building, yayımlanan yok.
    expect(repo.getBuild(build.buildId)?.state).toBe("building");
    expect(repo.getLatestPublished(WS)).toBeUndefined();
  });

  it("failBuild: build failed işaretlenir ve gerekçe saklanır", () => {
    const repo = makeRepo();
    const build = repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-fail", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      createdAt: CREATED_AT,
    });
    repo.failBuild(build.buildId, "adapter çöktü");
    const info = repo.getBuild(build.buildId);
    expect(info?.state).toBe("failed");
    expect(info?.failureReason).toBe("adapter çöktü");
    // Failed snapshot asla sorgulanamaz.
    expect(repo.getLatestPublished(WS)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Atomik yayımlama + stale bayrağı                                    */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository — atomik yayımlama ve stale", () => {
  it("build sürerken eski snapshot okunur ve stale=true döner", () => {
    const repo = makeRepo();
    const a = buildOrderSnapshot(repo, 1);
    const graphA = repo.publish(a.build.buildId, "ready", PUBLISHED_AT);

    // Yeni indeksleme başlıyor (uzun süren build senaryosu, TŞ §9).
    const b = repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-2", sequence: 2 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      createdAt: CREATED_AT,
    });

    const latest = repo.getLatestPublished(WS);
    expect(latest?.snapshot.meta.id).toBe(graphA.meta.id);
    expect(latest?.stale, "eski snapshot artık stale").toBe(true);

    // Building snapshot hâlâ hiçbir okuma yolunda görünmez.
    expect(repo.getSnapshot(b.buildId)).toBeUndefined();
    expect(repo.getLatestPublished(WS)?.snapshot.meta.state).toBe("ready");
  });

  it("yeni snapshot yayımlanınca stale düşer ama eski snapshot okunmaya devam eder", () => {
    const repo = makeRepo();
    const a = buildOrderSnapshot(repo, 1);
    const graphA = repo.publish(a.build.buildId, "ready", PUBLISHED_AT);

    const b = repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-2", sequence: 2 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      createdAt: CREATED_AT,
    });
    const { nodes, evidence, edges } = {
      nodes: orderNodes(),
      evidence: orderEvidence(),
      edges: orderEdges(orderNodes()),
    };
    for (const node of nodes) repo.addNode(b.buildId, node);
    for (const item of evidence) repo.addEvidence(b.buildId, item);
    for (const edge of edges) repo.addEdge(b.buildId, edge);
    const graphB = repo.publish(b.buildId, "ready", PUBLISHED_AT_2);

    // En son yayın: B, stale=false.
    const latest = repo.getLatestPublished(WS);
    expect(latest?.snapshot.meta.id).toBe(graphB.meta.id);
    expect(latest?.stale).toBe(false);

    // Eski snapshot hâlâ ID ile sorgulanabilir; ama stale=true.
    const old = repo.getSnapshot(graphA.meta.id);
    expect(old?.snapshot.meta.id).toBe(graphA.meta.id);
    expect(old?.stale, "yerini alan yayın var: eski stale").toBe(true);
  });

  it("daha eski revision için başlayan build, daha yeni yayını stale yapmaz", () => {
    const repo = makeRepo();
    const a = buildOrderSnapshot(repo, 2);
    repo.publish(a.build.buildId, "ready", PUBLISHED_AT);

    repo.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-1-geri", sequence: 1 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      createdAt: CREATED_AT,
    });
    expect(repo.getLatestPublished(WS)?.stale).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Değişmezlik + determinizm                                           */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository — değişmezlik ve determinizm", () => {
  it("dönen snapshot derin dondurulmuştur", () => {
    const repo = makeRepo();
    const { build } = buildOrderSnapshot(repo, 1);
    const graph = repo.publish(build.buildId, "ready", PUBLISHED_AT);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(graph.edges[0])).toBe(true);
    expect(Object.isFrozen(graph.evidence[0])).toBe(true);
    expect(Object.isFrozen(graph.nodes[0]?.attributes)).toBe(true);
  });

  it("ekleme sırasından bağımsız: aynı girdi → aynı snapshot ID ve aynı Graph JSON", () => {
    const repoA = makeRepo();
    const repoB = makeRepo();

    const a = buildOrderSnapshot(repoA, 1); // node → evidence → edge sırası
    const graphA = repoA.publish(a.build.buildId, "ready", PUBLISHED_AT);

    // Ters sıralama (bağımlılık kısıtı korunarak): evidence → node → edge.
    const buildB = repoB.beginBuild({
      workspaceId: WS,
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg:001",
      analyzerFingerprint: "ts-adapter@0.1.0",
      createdAt: CREATED_AT,
    });
    const nodes = orderNodes();
    const evidence = orderEvidence();
    const edges = orderEdges(nodes);
    for (const item of [...evidence].reverse()) {
      repoB.addEvidence(buildB.buildId, item);
    }
    for (const node of [...nodes].reverse()) {
      repoB.addNode(buildB.buildId, node);
    }
    for (const edge of [...edges].reverse()) {
      repoB.addEdge(buildB.buildId, edge);
    }
    const graphB = repoB.publish(buildB.buildId, "ready", PUBLISHED_AT);

    expect(graphA.meta.id).toBe(graphB.meta.id);
    expect(snapshotCanonicalJson(graphA)).toBe(snapshotCanonicalJson(graphB));
  });
});

/* ------------------------------------------------------------------ */
/* Güvenlik bulgusu 3: silinen dosyanın files kaydı düşürülebilir      */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository.deleteFile — güvenlik bulgusu 3", () => {
  it("pozitif: kayıt düşürülür, true döner ve listFiles artık içermez", () => {
    const repo = makeRepo();
    repo.upsertFile({
      workspaceId: WS,
      relativePath: "src/orders/removed.ts",
      contentHash: "hash-1",
      sizeBytes: 10,
      updatedAt: CREATED_AT,
    });
    repo.upsertFile({
      workspaceId: WS,
      relativePath: "src/orders/kept.ts",
      contentHash: "hash-2",
      sizeBytes: 12,
      updatedAt: CREATED_AT,
    });

    const removed = repo.deleteFile(WS, "src/orders/removed.ts");
    expect(removed).toBe(true);
    const paths = repo.listFiles(WS).map((record) => record.relativePath);
    expect(paths).toEqual(["src/orders/kept.ts"]);

    // İkinci silme: kayıt yok → false (idempotent mutabakat için).
    expect(repo.deleteFile(WS, "src/orders/removed.ts")).toBe(false);
  });

  it("negatif: bilinmeyen workspace graph/unknown-workspace ile reddedilir", () => {
    const repo = makeRepo();
    expect(() => repo.deleteFile("baska-ws", "src/x.ts")).toThrowError(
      GraphRepositoryError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* CAU-03: kayıtlı workspace kaydı kimlikle geri okunur                */
/* ------------------------------------------------------------------ */

describe("InMemoryGraphRepository.getWorkspace — CAU-03 root binding", () => {
  it("returns the registered record by id, and undefined for an id that was never registered", () => {
    const repo = makeRepo();
    expect(repo.getWorkspace(WS)).toEqual({
      id: WS,
      rootPath: "D:/fixture/orders",
      createdAt: CREATED_AT,
    });
    expect(repo.getWorkspace("ws_never_registered")).toBeUndefined();
  });

  it("returns a copy: changing the returned object does not change the stored record", () => {
    const repo = makeRepo();
    const record = repo.getWorkspace(WS) as { rootPath: string };
    record.rootPath = "D:/somewhere/else";
    expect(repo.getWorkspace(WS)?.rootPath).toBe("D:/fixture/orders");
  });

  it("rejects an empty workspace id like the other read paths", () => {
    const repo = makeRepo();
    expect(() => repo.getWorkspace("  ")).toThrowError(GraphRepositoryError);
  });
});

describe("InMemoryGraphRepository.updateWorkspaceRootPath — CAU-03 legacy root upgrade", () => {
  it("replaces the recorded root only while it still holds the expected value", () => {
    const repo = makeRepo();
    expect(repo.updateWorkspaceRootPath(WS, "D:/fixture/orders", "D:/real/orders")).toBe(true);
    // The upgrade also marks the record as holding a canonical root.
    expect(repo.getWorkspace(WS)).toEqual({ id: WS, rootPath: "D:/real/orders", createdAt: CREATED_AT, rootCanonical: true });
    // A stale expectation (another writer changed the row) changes nothing.
    expect(repo.updateWorkspaceRootPath(WS, "D:/fixture/orders", "D:/elsewhere")).toBe(false);
    expect(repo.getWorkspace(WS)?.rootPath).toBe("D:/real/orders");
  });

  it("upgrades a record once: a record already marked canonical is never rewritten, even when its root matches", () => {
    const repo = makeRepo();
    expect(repo.updateWorkspaceRootPath(WS, "D:/fixture/orders", "D:/fixture/orders")).toBe(true);
    expect(repo.getWorkspace(WS)?.rootCanonical).toBe(true);
    expect(repo.updateWorkspaceRootPath(WS, "D:/fixture/orders", "D:/elsewhere")).toBe(false);
    expect(repo.getWorkspace(WS)?.rootPath).toBe("D:/fixture/orders");

    repo.registerWorkspace({ id: "ws_marked", rootPath: "D:/fixture/marked", createdAt: CREATED_AT, rootCanonical: true });
    expect(repo.getWorkspace("ws_marked")).toEqual({
      id: "ws_marked",
      rootPath: "D:/fixture/marked",
      createdAt: CREATED_AT,
      rootCanonical: true,
    });
    expect(repo.updateWorkspaceRootPath("ws_marked", "D:/fixture/marked", "D:/elsewhere")).toBe(false);
    expect(repo.getWorkspace("ws_marked")?.rootPath).toBe("D:/fixture/marked");
  });

  it("a record registered with rootCanonical: false carries no mark", () => {
    const repo = makeRepo();
    repo.registerWorkspace({ id: "ws_unmarked", rootPath: "D:/fixture/unmarked", createdAt: CREATED_AT, rootCanonical: false });
    const record = repo.getWorkspace("ws_unmarked");
    expect(record).toEqual({ id: "ws_unmarked", rootPath: "D:/fixture/unmarked", createdAt: CREATED_AT });
    expect(record !== undefined && Object.hasOwn(record, "rootCanonical")).toBe(false);
  });

  it("reports an unknown id as not updated and rejects empty fields", () => {
    const repo = makeRepo();
    expect(repo.updateWorkspaceRootPath("ws_never_registered", "D:/fixture/orders", "D:/x")).toBe(false);
    expect(repo.getWorkspace("ws_never_registered")).toBeUndefined();
    expect(() => repo.updateWorkspaceRootPath(" ", "D:/fixture/orders", "D:/x")).toThrowError(GraphRepositoryError);
    expect(() => repo.updateWorkspaceRootPath(WS, "D:/fixture/orders", "")).toThrowError(GraphRepositoryError);
    expect(repo.getWorkspace(WS)?.rootPath).toBe("D:/fixture/orders");
  });
});
