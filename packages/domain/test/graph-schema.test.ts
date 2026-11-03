import { describe, expect, it } from "vitest";

import { DomainError } from "../src/errors.js";
import { EDGE_KINDS, NODE_KINDS } from "../src/graph-kinds.js";
import {
  EdgeKindSchema,
  EvidenceSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  NodeKindSchema,
  ResolutionSchema,
  SnapshotSchema,
  SourceSpanSchema,
} from "../src/graph-schema.js";
import { edgeId, nodeId } from "../src/ids.js";
import {
  createSnapshot,
  snapshotCanonicalJson,
  type SnapshotEdgeInput,
  type SnapshotGraph,
  type SnapshotInput,
} from "../src/snapshot.js";

// ---------------------------------------------------------------------------
// Fixtures — TŞ v2.1 §8 örneği: POST /orders → OrdersService → Module
// ---------------------------------------------------------------------------

const WS = "ws-fix";

const ORDERS_SPAN = {
  relativePath: "src/orders/orders.service.ts",
  startLine: 10,
  endLine: 24,
  sourceHash: "hash-orders-1",
};

const ROUTE_SPAN = {
  relativePath: "src/orders/orders.controller.ts",
  startLine: 4,
  endLine: 9,
  sourceHash: "hash-route-2",
};

function makeInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    workspaceId: WS,
    revision: { id: "rev-7", sequence: 7 },
    configHash: "cfg-1",
    analyzerFingerprint: "ts-adapter@0.1.0",
    state: "ready",
    createdAt: "2026-11-02T12:00:00.000Z",
    nodes: [
      { kind: "Workspace", qualifiedName: "demo" },
      { kind: "Module", qualifiedName: "src/orders", relativePath: "src/orders" },
      {
        kind: "File",
        qualifiedName: "src/orders/orders.service.ts",
        relativePath: "src/orders/orders.service.ts",
        language: "typescript",
        location: ORDERS_SPAN,
      },
      {
        kind: "Class",
        qualifiedName: "OrdersService",
        relativePath: "src/orders/orders.service.ts",
        attributes: { exported: true },
      },
      { kind: "Endpoint", qualifiedName: "POST /orders" },
    ],
    edges: [
      {
        kind: "CONTAINS",
        from: { kind: "Workspace", qualifiedName: "demo" },
        to: { kind: "Module", qualifiedName: "src/orders", relativePath: "src/orders" },
        resolution: "verified",
        evidence: [
          {
            kind: "ast-span",
            span: ORDERS_SPAN,
            analyzerId: "ts-adapter",
            analyzerVersion: "0.1.0",
            rationale: "Dizin yapısı AST module specifiers üzerinden çözüldü",
          },
        ],
      },
      {
        kind: "ROUTES_TO",
        from: { kind: "Endpoint", qualifiedName: "POST /orders" },
        to: {
          kind: "Class",
          qualifiedName: "OrdersService",
          relativePath: "src/orders/orders.service.ts",
        },
        resolution: "verified",
        evidence: [
          {
            kind: "route-attribute",
            span: ROUTE_SPAN,
            analyzerId: "ts-adapter",
            analyzerVersion: "0.1.0",
            rationale: "@Post dekoratörü ile handler eşleşmesi",
          },
        ],
      },
      {
        kind: "DEPENDS_ON",
        from: {
          kind: "Class",
          qualifiedName: "OrdersService",
          relativePath: "src/orders/orders.service.ts",
        },
        to: { kind: "Module", qualifiedName: "src/orders", relativePath: "src/orders" },
        resolution: "heuristic",
        evidence: [],
      },
    ],
    evidence: [],
    ...overrides,
  };
}

function domainErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return (err as DomainError).code;
  }
  throw new Error("DomainError beklenmişti ama fırlatılmadı");
}

// ---------------------------------------------------------------------------
// Katalog şemaları — TŞ listesi kapılıdır (katalog dışı tür uydurulamaz)
// ---------------------------------------------------------------------------

describe("tür kataloğu şemaları", () => {
  it("pozitif: NODE_KINDS'in tüm üyeleri NodeKindSchema'dan geçer (TŞ §8 bire bir)", () => {
    for (const kind of NODE_KINDS) {
      expect(NodeKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("pozitif: EDGE_KINDS'in tüm üyeleri EdgeKindSchema'dan geçer (TŞ §8 bire bir)", () => {
    for (const kind of EDGE_KINDS) {
      expect(EdgeKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("pozitif: Resolution yalnızca verified/heuristic/unresolved kabul eder", () => {
    expect(ResolutionSchema.safeParse("verified").success).toBe(true);
    expect(ResolutionSchema.safeParse("heuristic").success).toBe(true);
    expect(ResolutionSchema.safeParse("unresolved").success).toBe(true);
  });

  it("negatif: katalog dışı türler reddedilir", () => {
    expect(NodeKindSchema.safeParse("Gateway").success).toBe(false);
    expect(NodeKindSchema.safeParse("gateway").success).toBe(false);
    expect(EdgeKindSchema.safeParse("CALLS_AT").success).toBe(false);
    expect(ResolutionSchema.safeParse("proven").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SourceSpan / Evidence / GraphNode / GraphEdge şemaları
// ---------------------------------------------------------------------------

describe("SourceSpanSchema", () => {
  it("pozitif: geçerli span ve tek satırlık span (startLine === endLine) parse edilir", () => {
    expect(SourceSpanSchema.safeParse(ORDERS_SPAN).success).toBe(true);
    expect(
      SourceSpanSchema.safeParse({ ...ORDERS_SPAN, endLine: 10 }).success,
    ).toBe(true);
  });

  it("negatif: endLine < startLine reddedilir", () => {
    expect(
      SourceSpanSchema.safeParse({ ...ORDERS_SPAN, endLine: 9 }).success,
    ).toBe(false);
  });

  it("negatif: boş relativePath veya sourceHash reddedilir", () => {
    expect(
      SourceSpanSchema.safeParse({ ...ORDERS_SPAN, relativePath: "" }).success,
    ).toBe(false);
    expect(
      SourceSpanSchema.safeParse({ ...ORDERS_SPAN, sourceHash: "" }).success,
    ).toBe(false);
  });
});

describe("EvidenceSchema", () => {
  it("pozitif: span'li kanıt parse edilir", () => {
    const result = EvidenceSchema.safeParse({
      id: "evidence:aa",
      kind: "ast-span",
      span: ORDERS_SPAN,
      analyzerId: "ts-adapter",
      analyzerVersion: "0.1.0",
      rationale: "Metot bildirimi AST span üzerinden eşleştirildi",
    });
    expect(result.success).toBe(true);
  });

  it("partial: span'sız kanıt geçerlidir (TŞ §8 Evidence span opsiyoneldir)", () => {
    const result = EvidenceSchema.safeParse({
      id: "evidence:bb",
      kind: "git-diff",
      analyzerId: "git-analyzer",
      analyzerVersion: "0.1.0",
      rationale: "Diff üzerinden bağlantı adayı",
    });
    expect(result.success).toBe(true);
  });

  it("negatif: boş analyzerId veya rationale reddedilir", () => {
    const base = {
      id: "evidence:cc",
      kind: "ast-span",
      analyzerId: "ts-adapter",
      analyzerVersion: "0.1.0",
      rationale: "gerekçe",
    };
    expect(EvidenceSchema.safeParse({ ...base, analyzerId: "" }).success).toBe(
      false,
    );
    expect(EvidenceSchema.safeParse({ ...base, rationale: "  " }).success).toBe(
      false,
    );
  });
});

describe("GraphNodeSchema", () => {
  const validNode = {
    id: "node:aa",
    kind: "Class",
    qualifiedName: "OrdersService",
    language: "typescript",
    location: ORDERS_SPAN,
    attributes: { exported: true },
  };

  it("pozitif: tam alanlı node parse edilir", () => {
    expect(GraphNodeSchema.safeParse(validNode).success).toBe(true);
  });

  it("partial: opsiyonel alanlar olmadan da parse edilir", () => {
    const result = GraphNodeSchema.safeParse({
      id: "node:bb",
      kind: "Endpoint",
      qualifiedName: "POST /orders",
      attributes: {},
    });
    expect(result.success).toBe(true);
  });

  it("negatif: katalog dışı node türü reddedilir", () => {
    expect(
      GraphNodeSchema.safeParse({ ...validNode, kind: "Gateway" }).success,
    ).toBe(false);
  });

  it("negatif: tanım dışı ekstra alan reddedilir (strict)", () => {
    expect(
      GraphNodeSchema.safeParse({ ...validNode, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("GraphEdgeSchema — TŞ §8 invariant (i) şema düzeyinde", () => {
  const validEdge = {
    id: "edge:aa",
    from: "node:aa",
    to: "node:bb",
    kind: "CALLS",
    resolution: "verified",
    evidenceIds: ["evidence:ee"],
  };

  it("pozitif: verified kenar kanıtla parse edilir", () => {
    expect(GraphEdgeSchema.safeParse(validEdge).success).toBe(true);
  });

  it("negatif: verified kenar kanıtsız parse EDİLEMEZ", () => {
    const result = GraphEdgeSchema.safeParse({
      ...validEdge,
      evidenceIds: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("evidenceIds");
    }
  });

  it("partial: heuristic kenar kanıtsız parse edilir", () => {
    expect(
      GraphEdgeSchema.safeParse({ ...validEdge, resolution: "heuristic", evidenceIds: [] })
        .success,
    ).toBe(true);
  });

  it("partial: unresolved kenar ambiguity taşıyabilir (aday listesi boş olamaz)", () => {
    const unresolved = {
      ...validEdge,
      resolution: "unresolved",
      evidenceIds: [],
      ambiguity: { candidates: ["node:x", "node:y"], reason: "aynı isimli iki sembol" },
    };
    expect(GraphEdgeSchema.safeParse(unresolved).success).toBe(true);
    expect(
      GraphEdgeSchema.safeParse({
        ...unresolved,
        ambiguity: { candidates: [], reason: "yok" },
      }).success,
    ).toBe(false);
  });

  it("negatif: katalog dışı edge türü veya resolution reddedilir", () => {
    expect(
      GraphEdgeSchema.safeParse({ ...validEdge, kind: "CALLS_AT" }).success,
    ).toBe(false);
    expect(
      GraphEdgeSchema.safeParse({ ...validEdge, resolution: "proven" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SnapshotSchema — dangling edge ve duplicate kimlik refine'ı (snapshot düzeyi)
// ---------------------------------------------------------------------------

/** Şema testleri için ham snapshot literal'i (kurucudan bağımsız). */
function rawSnapshot(): Record<string, unknown> {
  return {
    meta: {
      id: "snapshot:aa",
      workspaceId: WS,
      revision: { id: "rev-7", sequence: 7 },
      configHash: "cfg-1",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-02T12:00:00.000Z",
    },
    nodes: [
      { id: "node:ws", kind: "Workspace", qualifiedName: "demo", attributes: {} },
      {
        id: "node:svc",
        kind: "Class",
        qualifiedName: "OrdersService",
        attributes: {},
      },
    ],
    edges: [
      {
        id: "edge:1",
        from: "node:ws",
        to: "node:svc",
        kind: "CONTAINS",
        resolution: "verified",
        evidenceIds: ["evidence:1"],
      },
    ],
    evidence: [
      {
        id: "evidence:1",
        kind: "ast-span",
        span: ORDERS_SPAN,
        analyzerId: "ts-adapter",
        analyzerVersion: "0.1.0",
        rationale: "sınıf bildirimi",
      },
    ],
  };
}

describe("SnapshotSchema — dangling/duplicate refine (snapshot düzeyi)", () => {
  it("pozitif: tutarlı snapshot parse edilir", () => {
    expect(SnapshotSchema.safeParse(rawSnapshot()).success).toBe(true);
  });

  it("negatif: kenar ucu bilinmeyen node'a işaret ediyorsa parse reddedilir (dangling)", () => {
    const dangling = rawSnapshot();
    const edges = (dangling.edges as Record<string, unknown>[]).map((e) => ({
      ...e,
      to: "node:ghost",
    }));
    dangling.edges = edges;
    const result = SnapshotSchema.safeParse(dangling);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) =>
        String(issue.message),
      );
      expect(messages.some((m) => m.includes("node:ghost"))).toBe(true);
    }
  });

  it("negatif: kenarın bilinmeyen kanıta işaret etmesi reddedilir", () => {
    const missingEvidence = rawSnapshot();
    const edges = (missingEvidence.edges as Record<string, unknown>[]).map(
      (e) => ({ ...e, evidenceIds: ["evidence:ghost"] }),
    );
    missingEvidence.edges = edges;
    expect(SnapshotSchema.safeParse(missingEvidence).success).toBe(false);
  });

  it("negatif: aynı kimlikte iki node reddedilir", () => {
    const duplicated = rawSnapshot();
    duplicated.nodes = [
      ...(duplicated.nodes as Record<string, unknown>[]),
      { id: "node:svc", kind: "Module", qualifiedName: "OrdersService", attributes: {} },
    ];
    expect(SnapshotSchema.safeParse(duplicated).success).toBe(false);
  });

  it("partial: kanıtsız heuristic kenarlı snapshot geçerlidir", () => {
    const heuristic = rawSnapshot();
    heuristic.edges = [
      ...(heuristic.edges as Record<string, unknown>[]),
      {
        id: "edge:2",
        from: "node:svc",
        to: "node:ws",
        kind: "DEPENDS_ON",
        resolution: "heuristic",
        evidenceIds: [],
      },
    ];
    expect(SnapshotSchema.safeParse(heuristic).success).toBe(true);
  });

  it("negatif: geçersiz createdAt (ISO değil) reddedilir", () => {
    const badTime = rawSnapshot();
    (badTime.meta as Record<string, unknown>).createdAt = "yarın";
    expect(SnapshotSchema.safeParse(badTime).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSnapshot — kurucu düzeyi invariant'lar + freeze
// ---------------------------------------------------------------------------

describe("createSnapshot", () => {
  it("pozitif: graph'ı inşa eder ve ID'ler yardımcı fonksiyonlarla birebir eşleşir (TŞ §8 invariant iii)", () => {
    const snapshot = createSnapshot(makeInput());

    const classNode = snapshot.nodes.find((n) => n.kind === "Class");
    expect(classNode).toBeDefined();
    expect(classNode?.id).toBe(
      nodeId({
        workspaceId: WS,
        kind: "Class",
        qualifiedName: "OrdersService",
        relativePath: "src/orders/orders.service.ts",
      }),
    );

    const callsEdge = snapshot.edges.find((e) => e.kind === "ROUTES_TO");
    expect(callsEdge?.resolution).toBe("verified");
    expect(callsEdge?.evidenceIds.length).toBeGreaterThanOrEqual(1);
    expect(callsEdge?.id).toBe(
      edgeId({
        workspaceId: WS,
        kind: "ROUTES_TO",
        from: snapshot.nodes.find((n) => n.kind === "Endpoint")?.id ?? "",
        to: classNode?.id ?? "",
      }),
    );

    expect(snapshot.evidence.length).toBeGreaterThanOrEqual(1);
    const firstEvidence = snapshot.evidence[0]!;
    expect(firstEvidence.id).toMatch(/^evidence:[0-9a-f]{64}$/);
    expect(snapshot.meta.id).toMatch(/^snapshot:[0-9a-f]{64}$/);
    expect(snapshot.meta.workspaceId).toBe(WS);
    expect(snapshot.meta.state).toBe("ready");
  });

  it("pozitif: diziler kanonik düzendedir (ID'ye göre sıralı — TŞ §8 invariant iv)", () => {
    const snapshot = createSnapshot(makeInput());
    const isSorted = (ids: readonly string[]): boolean =>
      ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id);
    expect(isSorted(snapshot.nodes.map((n) => n.id))).toBe(true);
    expect(isSorted(snapshot.edges.map((e) => e.id))).toBe(true);
    expect(isSorted(snapshot.evidence.map((e) => e.id))).toBe(true);
  });

  it("pozitif: snapshot derin dondurulmuştur (ADR-005 Immutable Snapshots)", () => {
    const snapshot = createSnapshot(makeInput());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.meta)).toBe(true);
    expect(Object.isFrozen(snapshot.meta.revision)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.edges)).toBe(true);
    expect(Object.isFrozen(snapshot.edges[0])).toBe(true);
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    const exported = snapshot.nodes.find((n) => n.kind === "Class");
    expect(Object.isFrozen(exported?.attributes)).toBe(true);
  });

  it("negatif: dondurulmuş snapshot'ın mutasyonu strict modda TypeError fırlatır", () => {
    const snapshot = createSnapshot(makeInput());
    expect(() => {
      (snapshot.meta as { state: string }).state = "failed";
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.nodes as SnapshotGraph["nodes"][number][]).push({
        id: "node:injected",
        kind: "Class",
        qualifiedName: "Injected",
        attributes: {},
      });
    }).toThrow(TypeError);
  });

  it("negatif: dangling edge kurucu düzeyde engellenir (TŞ §8 invariant ii)", () => {
    const err = domainErrorCode(() =>
      createSnapshot(
        makeInput({
          edges: [
            {
              kind: "CALLS",
              from: { kind: "Workspace", qualifiedName: "demo" },
              to: { kind: "Class", qualifiedName: "GhostService" },
              resolution: "heuristic",
              evidence: [],
            },
          ],
        }),
      ),
    );
    expect(err).toBe("domain/dangling-edge");
  });

  it("negatif: verified kenar kanıtsız inşa edilemez (kurucu, invariant i)", () => {
    const err = domainErrorCode(() =>
      createSnapshot(
        makeInput({
          edges: [
            {
              kind: "CALLS",
              from: { kind: "Workspace", qualifiedName: "demo" },
              to: {
                kind: "Class",
                qualifiedName: "OrdersService",
                relativePath: "src/orders/orders.service.ts",
              },
              resolution: "verified",
              evidence: [],
            },
          ],
        }),
      ),
    );
    expect(err).toBe("domain/verified-edge-requires-evidence");
  });

  it("negatif: aynı kimlikte iki node reddedilir (domain/duplicate-node)", () => {
    const err = domainErrorCode(() =>
      createSnapshot(
        makeInput({
          nodes: [
            { kind: "Workspace", qualifiedName: "demo" },
            { kind: "Workspace", qualifiedName: "demo" },
          ],
        }),
      ),
    );
    expect(err).toBe("domain/duplicate-node");
  });

  it("negatif: aynı kimlikte iki edge reddedilir (domain/duplicate-edge)", () => {
    const duplicatedEdge: SnapshotEdgeInput = {
      kind: "CONTAINS" as const,
      from: { kind: "Workspace", qualifiedName: "demo" },
      to: { kind: "Module", qualifiedName: "src/orders", relativePath: "src/orders" },
      resolution: "verified" as const,
      evidence: [
        {
          kind: "ast-span",
          span: ORDERS_SPAN,
          analyzerId: "ts-adapter",
          analyzerVersion: "0.1.0",
          rationale: "Dizin yapısı AST module specifiers üzerinden çözüldü",
        },
      ],
    };
    const err = domainErrorCode(() =>
      createSnapshot(
        makeInput({
          edges: [duplicatedEdge, { ...duplicatedEdge }],
        }),
      ),
    );
    expect(err).toBe("domain/duplicate-edge");
  });

  it("partial: boş graph (0 node/edge/evidence) inşa edilir ve frozen'dır", () => {
    const snapshot = createSnapshot(
      makeInput({ nodes: [], edges: [], evidence: [] }),
    );
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.evidence).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.meta.id).toMatch(/^snapshot:[0-9a-f]{64}$/);
  });

  it("partial: aynı kanıt tanımı iki kenarda kullanılırsa tek kayıta indirgenir (deterministik dedup)", () => {
    const sharedEvidence = {
      kind: "ast-span",
      span: ORDERS_SPAN,
      analyzerId: "ts-adapter",
      analyzerVersion: "0.1.0",
      rationale: "Aynı bildirim span'ı",
    };
    const snapshot = createSnapshot(
      makeInput({
        edges: [
          {
            kind: "CONTAINS",
            from: { kind: "Workspace", qualifiedName: "demo" },
            to: { kind: "Module", qualifiedName: "src/orders", relativePath: "src/orders" },
            resolution: "verified",
            evidence: [sharedEvidence],
          },
          {
            kind: "CALLS",
            from: { kind: "Endpoint", qualifiedName: "POST /orders" },
            to: {
              kind: "Class",
              qualifiedName: "OrdersService",
              relativePath: "src/orders/orders.service.ts",
            },
            resolution: "verified",
            evidence: [{ ...sharedEvidence }],
          },
        ],
      }),
    );
    expect(snapshot.evidence.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinizm — TŞ §8 invariant (iii) ve (vi)
// ---------------------------------------------------------------------------

describe("Determinizm (TŞ §8 invariant iii & vi)", () => {
  it("pozitif: iki bağımsız kurulum (farklı ekleme sırası) deep-equal ve aynı canonical JSON üretir", () => {
    const input = makeInput();
    const shuffled = makeInput({
      nodes: [...input.nodes].reverse(),
      edges: [...input.edges].reverse(),
    });

    const a = createSnapshot(input);
    const b = createSnapshot(shuffled);

    expect(a).toEqual(b);
    expect(a.meta.id).toBe(b.meta.id);
    expect(snapshotCanonicalJson(a)).toBe(snapshotCanonicalJson(b));
  });

  it("pozitif: createdAt ID'ye KATILMAZ — farklı zaman damgası aynı snapshot ID üretir", () => {
    const a = createSnapshot(makeInput({ createdAt: "2026-11-02T12:00:00.000Z" }));
    const b = createSnapshot(makeInput({ createdAt: "2027-01-15T08:30:00.000Z" }));
    expect(a.meta.id).toBe(b.meta.id);
    expect(a.meta.createdAt).toBe("2026-11-02T12:00:00.000Z");
    expect(b.meta.createdAt).toBe("2027-01-15T08:30:00.000Z");
  });

  it("negatif: deterministik girdilerden biri değişirse snapshot ID değişir", () => {
    const base = createSnapshot(makeInput()).meta.id;
    const otherRevision = createSnapshot(
      makeInput({ revision: { id: "rev-8", sequence: 8 } }),
    ).meta.id;
    const otherContent = createSnapshot(
      makeInput({
        nodes: [
          ...makeInput().nodes,
          { kind: "Class", qualifiedName: "BillingService", relativePath: "src/billing.ts" },
        ],
      }),
    ).meta.id;
    expect(new Set([base, otherRevision, otherContent]).size).toBe(3);
  });

  it("pozitif: createdAt yalnızca meta'da taşınır — nodes/edges/evidence zaman damgasından etkilenmez", () => {
    const a = createSnapshot(makeInput({ createdAt: "2026-11-02T12:00:00.000Z" }));
    const b = createSnapshot(makeInput({ createdAt: "2027-01-15T08:30:00.000Z" }));
    expect(a.nodes).toEqual(b.nodes);
    expect(a.edges).toEqual(b.edges);
    expect(a.evidence).toEqual(b.evidence);
    expect(a.meta.createdAt).toBe("2026-11-02T12:00:00.000Z");
    expect(b.meta.createdAt).toBe("2027-01-15T08:30:00.000Z");
  });
});
