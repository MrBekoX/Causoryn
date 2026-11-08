import { describe, expect, it } from "vitest";

import {
  matchContractEdges,
  scanServiceAnchors,
  type ContractCandidate,
  type ServiceAnchor,
} from "../src/index.js";

/* Saf eşleştirme çekirdeği: TŞ §11 kuralı — produces/consumes edge'i
 * YALNIZCA net isim/route/schema kimliği eşleşmesinde verified; isim
 * benzerliği heuristic; daha zayıf eşleşme kenar üretmez. */

function openApiContract(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  return {
    contractId: "node:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceKind: "openapi",
    nodeKind: "ApiContract",
    name: "createOrder",
    qualifiedName: "createOrder",
    method: "POST",
    route: "/orders",
    responseSchemaIds: [],
    properties: [],
    requiredPropertyNames: [],
    resolvedRefs: [],
    certainty: "full",
    evidence: { relativePath: "docs/openapi.yaml", startLine: 6, endLine: 6 },
    diagnostics: [],
    ...overrides,
  };
}

function endpointAnchor(overrides: Partial<ServiceAnchor> = {}): ServiceAnchor {
  return {
    anchorKind: "endpoint",
    symbol: "orders-service",
    method: "POST",
    route: "/orders",
    evidence: { relativePath: "src/services/orders-service.ts", startLine: 24, endLine: 24 },
    ...overrides,
  };
}

describe("matchContractEdges — route kuralı", () => {
  it("pozitif: birebir route+method eşleşmesi → PRODUCES_CONTRACT verified (basis route, iki taraf kanıtlı)", () => {
    const edges = matchContractEdges([openApiContract()], [endpointAnchor()]);
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge?.edgeKind).toBe("PRODUCES_CONTRACT");
    expect(edge?.resolution).toBe("verified");
    expect(edge?.matchBasis).toBe("route");
    expect(edge?.fromSymbol).toBe("orders-service");
    expect(edge?.toContractId).toBe(openApiContract().contractId);
    expect(edge?.evidence).toEqual([
      { relativePath: "src/services/orders-service.ts", startLine: 24, endLine: 24 },
      { relativePath: "docs/openapi.yaml", startLine: 6, endLine: 6 },
    ]);
  });

  it("pozitif: param şablonu eşdeğerliği — ':orderId' ile '{orderId}' aynı segment şekli", () => {
    const contract = openApiContract({
      method: "GET",
      route: "/orders/{orderId}",
      qualifiedName: "getOrder",
      name: "getOrder",
    });
    const anchor = endpointAnchor({
      method: "GET",
      route: "/orders/:orderId",
      evidence: { relativePath: "src/services/orders-service.ts", startLine: 25, endLine: 25 },
    });
    const edges = matchContractEdges([contract], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolution).toBe("verified");
    expect(edges[0]?.matchBasis).toBe("route");
  });

  it("negatif: method farklı → kenar üretilmez", () => {
    const contract = openApiContract({ method: "GET", route: "/orders", qualifiedName: "listOrders" });
    const edges = matchContractEdges([contract], [endpointAnchor({ method: "POST" })]);
    expect(edges).toHaveLength(0);
  });

  it("negatif: segment sayısı farklı → kenar üretilmez", () => {
    const contract = openApiContract({ route: "/orders/{orderId}" });
    const edges = matchContractEdges([contract], [endpointAnchor({ route: "/orders" })]);
    expect(edges).toHaveLength(0);
  });

  it("heuristic: route yalnızca case farkıyla eşleşiyor → verified DEĞİL, basis name-similarity", () => {
    const contract = openApiContract({ route: "/ORDERS" });
    const edges = matchContractEdges([contract], [endpointAnchor({ route: "/orders" })]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolution).toBe("heuristic");
    expect(edges[0]?.matchBasis).toBe("name-similarity");
  });

  it("negatif: tamamen farklı route → kenar yok", () => {
    const edges = matchContractEdges(
      [openApiContract({ route: "/billing/invoices" })],
      [endpointAnchor({ route: "/orders" })],
    );
    expect(edges).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* topic kuralı (AsyncAPI)                                             */
/* ------------------------------------------------------------------ */

function asyncApiContract(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  return {
    contractId: "node:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceKind: "asyncapi",
    nodeKind: "EventContract",
    name: "order-created-v1",
    qualifiedName: "order-created-v1#publish",
    topic: "order-created-v1",
    channelDirection: "publish",
    responseSchemaIds: [],
    properties: [],
    requiredPropertyNames: [],
    resolvedRefs: [],
    certainty: "full",
    evidence: { relativePath: "asyncapi.yaml", startLine: 6, endLine: 6 },
    diagnostics: [],
    ...overrides,
  };
}

describe("matchContractEdges — topic kuralı", () => {
  it("pozitif: producer ankrajı publish kanalıyla → PRODUCES verified (basis topic-id)", () => {
    const anchor: ServiceAnchor = {
      anchorKind: "producer",
      symbol: "orders-service",
      topic: "order-created-v1",
      evidence: { relativePath: "src/services/orders-service.ts", startLine: 27, endLine: 27 },
    };
    const edges = matchContractEdges([asyncApiContract()], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeKind).toBe("PRODUCES_CONTRACT");
    expect(edges[0]?.resolution).toBe("verified");
    expect(edges[0]?.matchBasis).toBe("topic-id");
  });

  it("pozitif: consumer ankrajı subscribe kanalıyla → CONSUMES verified", () => {
    const contract = asyncApiContract({
      channelDirection: "subscribe",
      qualifiedName: "order-created-v1#subscribe",
    });
    const anchor: ServiceAnchor = {
      anchorKind: "consumer",
      symbol: "orders-service",
      topic: "order-created-v1",
      evidence: { relativePath: "src/services/orders-service.ts", startLine: 28, endLine: 28 },
    };
    const edges = matchContractEdges([contract], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeKind).toBe("CONSUMES_CONTRACT");
    expect(edges[0]?.resolution).toBe("verified");
    expect(edges[0]?.matchBasis).toBe("topic-id");
  });

  it("heuristic: yön çelişkisi — consumer ankrajı yalnızca publish kanalı varken → CONSUMES heuristic", () => {
    const anchor: ServiceAnchor = {
      anchorKind: "consumer",
      symbol: "orders-service",
      topic: "order-created-v1",
      evidence: { relativePath: "src/x.ts", startLine: 1, endLine: 1 },
    };
    const edges = matchContractEdges([asyncApiContract()], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeKind).toBe("CONSUMES_CONTRACT");
    expect(edges[0]?.resolution).toBe("heuristic");
  });

  it("negatif: farklı topic → kenar yok (zayıf benzerlik üretilmez)", () => {
    const anchor: ServiceAnchor = {
      anchorKind: "producer",
      symbol: "orders-service",
      topic: "order-created",
      evidence: { relativePath: "src/x.ts", startLine: 1, endLine: 1 },
    };
    const edges = matchContractEdges([asyncApiContract()], [anchor]);
    expect(edges).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* tablo kuralı (SQL) + kaynak türü sınırı + determinizm               */
/* ------------------------------------------------------------------ */

function sqlContract(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  return {
    contractId: "node:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceKind: "sql",
    nodeKind: "SchemaContract",
    name: "orders",
    qualifiedName: "table:orders",
    responseSchemaIds: [],
    properties: [],
    requiredPropertyNames: [],
    resolvedRefs: [],
    certainty: "full",
    evidence: { relativePath: "db/001_create_orders.sql", startLine: 2, endLine: 7 },
    diagnostics: [],
    ...overrides,
  };
}

describe("matchContractEdges — tablo kuralı ve sınır kontrolleri", () => {
  it("pozitif: INSERT INTO orders ↔ CREATE TABLE orders → CONSUMES verified (basis name-exact)", () => {
    const anchor: ServiceAnchor = {
      anchorKind: "table",
      symbol: "order-repository",
      table: "orders",
      evidence: { relativePath: "src/repositories/order-repository.ts", startLine: 19, endLine: 19 },
    };
    const edges = matchContractEdges([sqlContract()], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeKind).toBe("CONSUMES_CONTRACT");
    expect(edges[0]?.resolution).toBe("verified");
    expect(edges[0]?.matchBasis).toBe("name-exact");
  });

  it("heuristic: ORDERS (case farkı) → heuristic name-similarity, verified ASLA değil (TŞ §11)", () => {
    const anchor: ServiceAnchor = {
      anchorKind: "table",
      symbol: "billing-service",
      table: "ORDERS",
      evidence: { relativePath: "src/services/billing-service.ts", startLine: 21, endLine: 21 },
    };
    const edges = matchContractEdges([sqlContract()], [anchor]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolution).toBe("heuristic");
    expect(edges[0]?.matchBasis).toBe("name-similarity");
    expect(edges[0]?.edgeKind).toBe("CONSUMES_CONTRACT");
  });

  it("negatif: kaynak türü sınırı — endpoint ankrajı SQL sözleşmesiyle eşleşmez", () => {
    const edges = matchContractEdges([sqlContract()], [endpointAnchor({ route: "/orders" })]);
    expect(edges).toHaveLength(0);
  });

  it("pozitif: verified ve heuristic aynı (from,to,kind) çiftinde ÇAKIŞIRSA verified kazanır ve kanıtlar birleşir (put merge dalı)", () => {
    // Gerçek çakışma: AYNI sembol aynı sözleşmeyi iki yoldan eşler —
    // exact tablo → verified (name-exact), büyük/küçük farkı → heuristic
    // (name-similarity). İkisi de aynı (edgeKind, fromSymbol, toContractId)
    // anahtarını üretir → merge dalı çalışır.
    const contract = sqlContract({ name: "orders", qualifiedName: "table:orders" });
    const exact: ServiceAnchor = {
      anchorKind: "table",
      symbol: "repo",
      table: "orders",
      evidence: { relativePath: "a.ts", startLine: 1, endLine: 1 },
    };
    const similar: ServiceAnchor = {
      anchorKind: "table",
      symbol: "repo",
      table: "ORDERS",
      evidence: { relativePath: "b.ts", startLine: 2, endLine: 2 },
    };
    const edges = matchContractEdges([contract], [exact, similar]);
    // Çakışma TEK kenarda birleştirilir (ikinci kenar üretilmez).
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    // verified > heuristic: kazanan exact ankrajın sınıflamasıdır.
    expect(edge?.resolution).toBe("verified");
    expect(edge?.matchBasis).toBe("name-exact");
    // Kanıt birleşimi: kazanan kanıt zinciri (ankraj + sözleşme) + kaybedenin
    // tekrarsız katkısı; sıra korunur.
    expect(edge?.evidence).toEqual([
      { relativePath: "a.ts", startLine: 1, endLine: 1 },
      contract.evidence,
      { relativePath: "b.ts", startLine: 2, endLine: 2 },
    ]);
    // Anchor sırası ters çevrilse bile kazanan/kanıt sırası DEĞİŞMEZ:
    // verified her zaman kazanır ve kazanan kanıtı önce yazılır.
    const reversed = matchContractEdges([contract], [similar, exact]);
    expect(reversed).toEqual(edges);
  });

  it("pozitif: girdi sırası permütasyona karşı çıktı deterministiktir (kanonik sıralama)", () => {
    const contracts = [
      sqlContract(),
      asyncApiContract(),
      openApiContract(),
      openApiContract({ contractId: "node:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", route: "/orders/{orderId}", method: "GET", qualifiedName: "getOrder", name: "getOrder" }),
    ];
    const anchors: ServiceAnchor[] = [
      endpointAnchor(),
      endpointAnchor({
        method: "GET",
        route: "/orders/:orderId",
        evidence: { relativePath: "src/services/orders-service.ts", startLine: 25, endLine: 25 },
      }),
      { anchorKind: "producer", symbol: "orders-service", topic: "order-created-v1", evidence: { relativePath: "src/x.ts", startLine: 2, endLine: 2 } },
      { anchorKind: "table", symbol: "repo", table: "orders", evidence: { relativePath: "src/y.ts", startLine: 3, endLine: 3 } },
    ];
    const a = JSON.stringify(matchContractEdges(contracts, anchors));
    const b = JSON.stringify(matchContractEdges([...contracts].reverse(), [...anchors].reverse()));
    expect(a).toBe(b);
    // çıktı kanonik anahtarla sıralıdır
    const parsed = JSON.parse(a) as Array<{ edgeKind: string; fromSymbol: string; toContractId: string }>;
    const sorted = [...parsed].sort((x, y) => {
      const kx = `${x.edgeKind}|${x.fromSymbol}|${x.toContractId}`;
      const ky = `${y.edgeKind}|${y.fromSymbol}|${y.toContractId}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
    expect(parsed).toEqual(sorted);
  });
});

/* ------------------------------------------------------------------ */
/* scanServiceAnchors — basitleştirilmiş satır tarayıcı                */
/* ------------------------------------------------------------------ */

describe("scanServiceAnchors", () => {
  it("pozitif: rota/publish/subscribe/SQL ankrajlarını satır kanıtıyla çıkarır", () => {
    const text = [
      "export function register(router: Router, bus: EventBus, db: Db): void {",
      '  router.post("/orders", h1);',
      '  router.get("/orders/:orderId", h2);',
      '  bus.publish("order-created-v1", payload);',
      '  bus.subscribe("billing.invoice-created", handler);',
      '  db.run("INSERT INTO orders VALUES (1)");',
      "}",
    ].join("\n");
    const anchors = scanServiceAnchors("src/orders-service.ts", text, "orders-service");

    const endpoint = anchors.find((a) => a.anchorKind === "endpoint" && a.method === "POST");
    expect(endpoint?.route).toBe("/orders");
    expect(endpoint?.evidence).toEqual({
      relativePath: "src/orders-service.ts",
      startLine: 2,
      endLine: 2,
    });
    expect(anchors.some((a) => a.anchorKind === "endpoint" && a.route === "/orders/:orderId")).toBe(
      true,
    );
    const producer = anchors.find((a) => a.anchorKind === "producer");
    expect(producer?.topic).toBe("order-created-v1");
    const consumer = anchors.find((a) => a.anchorKind === "consumer");
    expect(consumer?.topic).toBe("billing.invoice-created");
    const table = anchors.find((a) => a.anchorKind === "table");
    expect(table?.table).toBe("orders");
  });

  it("negatif: yorum satırlarındaki desenler ankraj üretmez (// yorumu temizlenir)", () => {
    const text = [
      "// router.post(\"/fake-route\", never);",
      "// bus.publish(\"fake-topic\", x);",
      "export const nothing = 1;",
    ].join("\n");
    const anchors = scanServiceAnchors("src/x.ts", text, "x");
    expect(anchors).toEqual([]);
  });

  it("pozitif: determinizm — aynı girdi bit-bit aynı çıktı", () => {
    const text = 'router.post("/a", h);\nrouter.get("/b", h2);\n';
    const a = JSON.stringify(scanServiceAnchors("x.ts", text, "x"));
    const b = JSON.stringify(scanServiceAnchors("x.ts", text, "x"));
    expect(a).toBe(b);
  });
});
