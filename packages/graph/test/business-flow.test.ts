import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  nodeId,
  type SnapshotGraph,
  type SourceSpan,
} from "@causoryn/domain";

import { GraphRepositoryError, traceBusinessFlow as traceBusinessFlowFromIndex } from "../src/index.js";
import {
  BUSINESS_FLOW_EDGE_KINDS,
  FLOW_LIMIT_CEILINGS,
  traceBusinessFlow,
  type FlowSegment,
  type TraceBusinessFlowResult,
} from "../src/business-flow.js";

/**
 * causoryn_trace_business_flow çekirdeği test üçlüleri — TŞ v2.1 §14
 * (Sayfa 12) Business Flow sözleşmesi, §10.2 (Sayfa 10) araç girdisi
 * (flowSeed, boundaries?, maxHops), §20 (Sayfa 22) results tavanları.
 *
 * TŞ §14: "Eşleştirilen sınırlar: UI route/component → fetch/client method
 * → OpenAPI/backend endpoint → handler → domain service → repository/ORM →
 * table; ayrıca producer event → broker/topic → consumer. Her sınır
 * geçişi kendi evidence'ına ve certainty işaretine sahiptir.
 * trace_business_flow bir açıklama hikâyesi değil, graf ve FlowSegment[]
 * döndürür."
 *
 * Pozitif: fixture-ts-orders POST /orders → handler → service → repository
 * → table zinciri segment segment certainty'li; producer→broker(topic
 * kontratı)→consumer contract segmenti. Negatif: kopuk zincir gap
 * segmentiyle dürüstçe kesilir, uydurma köprü üretilmez; izole/bilinmeyen
 * seed dürüstçe raporlanır. Partial: heuristic kenarın SONRASI "possible"
 * işaretli (TŞ §11: isim benzerliği heuristic kalır; sonrası kesin
 * iddia edilemez).
 *
 * Kenar sözcüğü: ROUTES_TO, CALLS, PRODUCES_CONTRACT, CONSUMES_CONTRACT,
 * CONTAINS (sprint-5 D5 görev tanımı). Kontrat node/kenarları D1 adayları
 *yla aynı deterministik kimlikle kurulur (packages/contracts
 * asyncapi-discovery.ts:187 `${topic}#${direction}`, sql-discovery.ts:372
 * `table:<name>`, openapi-discovery.ts:212 `operationId ?? "M /route"`;
 * hepsi domain nodeId ile türetilir).
 *
 * Kırmızı çizgi testi: çıktı asla mutlak akış iddiası taşımaz; her
 * segment kendi certainty'ini taşır; kopukluk "gap" olarak raporlanır.
 */

const WS = "ws_flow";
const CREATED_AT = "2026-11-07T09:00:00.000Z";

function span(relativePath: string, startLine: number, endLine: number): SourceSpan {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}`,
  };
}

/** Fixture node kimlikleri — createSnapshot ile aynı deterministik türetim. */
function nid(
  kind: Parameters<typeof nodeId>[0]["kind"],
  qualifiedName: string,
  relativePath?: string,
): string {
  return nodeId({
    workspaceId: WS,
    kind,
    qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
  });
}

/* ------------------------------------------------------------------ */
/* Fixture sembol adları — examples/fixture-ts-orders + fixture-       */
/* contract-drift kaynak adlarıyla birebir.                            */
/* ------------------------------------------------------------------ */

const EP_ORDERS = "POST /orders";
const HANDLER_ORDERS = "createOrdersRoute";
const SVC_ORDERS = "OrdersService";
const REPO_ORDERS = "OrderRepository";
const TABLE_ORDERS = "table:orders"; // D1 sql-discovery qualifiedName
const SQL_PATH = "db/001_create_orders.sql";

const TOPIC_ORDER_CREATED = "order-created-v1#publish"; // D1 asyncapi qualifiedName
const ASYNCAPI_PATH = "asyncapi.yaml";
const CONSUMER_BILLING = "billingOnOrderCreated";

const EP_INVOICES = "POST /invoices";
const HANDLER_INVOICES = "invoicesHandler";

const EP_BILLING_TOTALS = "POST /billing-totals";
const HANDLER_BILLING_TOTALS = "billingTotalsHandler";
const SVC_BILLING = "BillingService";

interface EdgeSpec {
  readonly kind: string;
  readonly from: readonly [kind: Parameters<typeof nodeId>[0]["kind"], qn: string, path?: string];
  readonly to: readonly [kind: Parameters<typeof nodeId>[0]["kind"], qn: string, path?: string];
  readonly resolution: "verified" | "heuristic" | "unresolved";
}

function ref(
  part: readonly [
    kind: Parameters<typeof nodeId>[0]["kind"],
    qualifiedName: string,
    path?: string,
  ],
): {
  kind: Parameters<typeof nodeId>[0]["kind"];
  qualifiedName: string;
  relativePath?: string;
} {
  return {
    kind: part[0],
    qualifiedName: part[1],
    ...(part[2] === undefined ? {} : { relativePath: part[2] }),
  };
}

interface FixtureNodeSpec {
  readonly kind: Parameters<typeof nodeId>[0]["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
}

/**
 * Ortak node kümesi: request zinciri (fixture-ts-orders) + event zinciri
 * (fixture-contract-drift kontratları) + kopuk/partial senaryo node'ları.
 */
const BASE_NODES: readonly FixtureNodeSpec[] = [
  { kind: "Endpoint", qualifiedName: EP_ORDERS, relativePath: "src/app.ts" },
  { kind: "Handler", qualifiedName: HANDLER_ORDERS, relativePath: "src/routes/orders.ts" },
  { kind: "Class", qualifiedName: SVC_ORDERS, relativePath: "src/services/orders-service.ts" },
  {
    kind: "Class",
    qualifiedName: REPO_ORDERS,
    relativePath: "src/repositories/order-repository.ts",
  },
  // D1 sql keşfi: CREATE TABLE orders → SchemaContract "table:orders"
  { kind: "SchemaContract", qualifiedName: TABLE_ORDERS, relativePath: SQL_PATH },
  // D1 asyncapi keşfi: order-created-v1 publish kanalı → EventContract
  { kind: "EventContract", qualifiedName: TOPIC_ORDER_CREATED, relativePath: ASYNCAPI_PATH },
  // billing tarafındaki consumer handler (event zincirinin ucu)
  {
    kind: "Function",
    qualifiedName: CONSUMER_BILLING,
    relativePath: "src/services/billing-service.ts",
  },
  // kopuk zincir senaryosu
  { kind: "Endpoint", qualifiedName: EP_INVOICES, relativePath: "src/app.ts" },
  { kind: "Handler", qualifiedName: HANDLER_INVOICES, relativePath: "src/routes/invoices.ts" },
  // partial senaryo: heuristic CALLS + isim-benzerliği CONSUMES (ORDERS≠orders)
  {
    kind: "Endpoint",
    qualifiedName: EP_BILLING_TOTALS,
    relativePath: "src/app.ts",
  },
  {
    kind: "Handler",
    qualifiedName: HANDLER_BILLING_TOTALS,
    relativePath: "src/routes/billing.ts",
  },
  { kind: "Class", qualifiedName: SVC_BILLING, relativePath: "src/services/billing-service.ts" },
];

const BASE_EDGES: readonly EdgeSpec[] = [
  {
    kind: "ROUTES_TO",
    from: ["Endpoint", EP_ORDERS, "src/app.ts"],
    to: ["Handler", HANDLER_ORDERS, "src/routes/orders.ts"],
    resolution: "verified",
  },
  {
    kind: "CALLS",
    from: ["Handler", HANDLER_ORDERS, "src/routes/orders.ts"],
    to: ["Class", SVC_ORDERS, "src/services/orders-service.ts"],
    resolution: "verified",
  },
  {
    kind: "CALLS",
    from: ["Class", SVC_ORDERS, "src/services/orders-service.ts"],
    to: ["Class", REPO_ORDERS, "src/repositories/order-repository.ts"],
    resolution: "verified",
  },
  // D1 match.ts kural 3: tablo adı birebir → verified CONSUMES_CONTRACT
  {
    kind: "CONSUMES_CONTRACT",
    from: ["Class", REPO_ORDERS, "src/repositories/order-repository.ts"],
    to: ["SchemaContract", TABLE_ORDERS, SQL_PATH],
    resolution: "verified",
  },
  // D1 match.ts kural 2: topic birebir + publish yönü → verified PRODUCES_CONTRACT
  {
    kind: "PRODUCES_CONTRACT",
    from: ["Class", SVC_ORDERS, "src/services/orders-service.ts"],
    to: ["EventContract", TOPIC_ORDER_CREATED, ASYNCAPI_PATH],
    resolution: "verified",
  },
  // consumer: topic birebir → verified CONSUMES_CONTRACT (direction çelişkisi yok)
  {
    kind: "CONSUMES_CONTRACT",
    from: ["Function", CONSUMER_BILLING, "src/services/billing-service.ts"],
    to: ["EventContract", TOPIC_ORDER_CREATED, ASYNCAPI_PATH],
    resolution: "verified",
  },
  // kopuk zincir: invoices handler'ın devamı YOK
  {
    kind: "ROUTES_TO",
    from: ["Endpoint", EP_INVOICES, "src/app.ts"],
    to: ["Handler", HANDLER_INVOICES, "src/routes/invoices.ts"],
    resolution: "verified",
  },
  // partial zincir: verified ROUTES_TO ile başlar, heuristic CALLS ile sürer
  {
    kind: "ROUTES_TO",
    from: ["Endpoint", EP_BILLING_TOTALS, "src/app.ts"],
    to: ["Handler", HANDLER_BILLING_TOTALS, "src/routes/billing.ts"],
    resolution: "verified",
  },
  // partial zincir: heuristic CALLS (statik çözümleme yarım kaldı)
  {
    kind: "CALLS",
    from: ["Handler", HANDLER_BILLING_TOTALS, "src/routes/billing.ts"],
    to: ["Class", SVC_BILLING, "src/services/billing-service.ts"],
    resolution: "heuristic",
  },
  // D1 match.ts kural 3: normalize isim eşitliği (ORDERS vs orders) → heuristic
  {
    kind: "CONSUMES_CONTRACT",
    from: ["Class", SVC_BILLING, "src/services/billing-service.ts"],
    to: ["SchemaContract", TABLE_ORDERS, SQL_PATH],
    resolution: "heuristic",
  },
];

function edgeInput(spec: EdgeSpec) {
  const evidence = [
    {
      kind: "business-flow-fixture",
      span: span("fixture", 1, 1),
      analyzerId: "fixtures",
      analyzerVersion: "0.0.0",
      rationale: `fixture ${spec.kind} kenarı`,
    },
  ];
  return {
    kind: spec.kind as never,
    from: ref(spec.from),
    to: ref(spec.to),
    resolution: spec.resolution,
    // verified kenar kanıt şartı (TŞ §8 invariant i); heuristic kenara da
    // D1 ContractEdgeCandidate.evidence karşılığı kanıt verilir.
    evidence,
  };
}

/** Ana fixture: request + event zincirleri, kopuk ve partial senaryolar. */
function buildFixtureSnapshot(extraNodes: readonly FixtureNodeSpec[] = []): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-flow-fixture",
    analyzerFingerprint: "fp-flow-fixture",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [...BASE_NODES, ...extraNodes].map((node) => ({
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
    })),
    edges: BASE_EDGES.map(edgeInput),
  });
}

/** Yalnızca belirli node/kenarları taşıyan daraltılmış snapshot kurar. */
function buildSnapshotWith(
  nodes: readonly FixtureNodeSpec[],
  edges: readonly EdgeSpec[],
): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-flow-fixture",
    analyzerFingerprint: "fp-flow-fixture",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: nodes.map((node) => ({
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
    })),
    edges: edges.map(edgeInput),
  });
}

function segmentNodeIds(segments: readonly FlowSegment[]): string[] {
  return segments.map((segment) => segment.to?.nodeId ?? segment.from.nodeId);
}

/* ------------------------------------------------------------------ */
/* Pozitif: POST /orders → handler → service → repo → table            */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — pozitif (request zinciri)", () => {
  const snapshot = buildFixtureSnapshot();

  it("POST /orders → handler → service → repository → table zincirini segment segment certainty'li üretir", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS });

    expect(result.seed).not.toBeNull();
    expect(result.seed?.qualifiedName).toBe(EP_ORDERS);
    expect(result.unresolvedSeed).toBeNull();

    // OrdersService'te dallar: repo→table (request) ve kontrat→consumer
    // (event); ikinci akış ROUTES_TO/CALLS + kontrat bacaklarını taşıdığı
    // için chainKinds ["event","request"] olur.
    expect(result.flows).toHaveLength(2);

    const requestFlow = result.flows.find(
      (flow) => flow.hopCount === 4 && flow.terminalNode.qualifiedName === TABLE_ORDERS,
    );
    expect(requestFlow).toBeDefined();

    const chain = requestFlow?.segments.map((segment) => [
      segment.edge?.kind,
      segment.to?.qualifiedName,
    ]) ?? [];
    expect(chain).toEqual([
      ["ROUTES_TO", HANDLER_ORDERS],
      ["CALLS", SVC_ORDERS],
      ["CALLS", REPO_ORDERS],
      ["CONSUMES_CONTRACT", TABLE_ORDERS],
    ]);
    // Her segment kendi certainty'ini taşır (TŞ §14): hepsi verified.
    expect(requestFlow?.segments.map((segment) => segment.certainty)).toEqual([
      "verified",
      "verified",
      "verified",
      "verified",
    ]);
    // Zincirin en zayıf halkası + akış düzeyi özet ayrı raporlanır.
    expect(requestFlow?.certainty).toBe("verified");
    expect(requestFlow?.resolution).toBe("verified");
    expect(requestFlow?.hasGap).toBe(false);
    expect(requestFlow?.terminalNode?.qualifiedName).toBe(TABLE_ORDERS);
    expect(requestFlow?.chainKinds).toEqual(["request"]);
    // verified segmentler kanıt taşır (ADR-004 Evidence First).
    for (const segment of requestFlow?.segments ?? []) {
      expect(segment.edge?.evidenceIds.length).toBeGreaterThan(0);
    }
    // Akış kanıtları tekrarsız ve kanonik sırada.
    const flowEvidence = requestFlow?.evidenceIds ?? [];
    expect([...flowEvidence].sort()).toEqual(flowEvidence);
    expect(new Set(flowEvidence).size).toBe(flowEvidence.length);
  });

  it("request zinciri SchemaContract (table) terminalinde dürüstçe biter — gap üretmez", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS });
    const requestFlow = result.flows.find(
      (flow) => flow.hopCount === 4 && flow.terminalNode.qualifiedName === TABLE_ORDERS,
    );
    expect(requestFlow?.segments.at(-1)?.to?.kind).toBe("SchemaContract");
    expect(requestFlow?.segments.at(-1)?.certainty).not.toBe("gap");
  });
});

/* ------------------------------------------------------------------ */
/* Pozitif: producer → broker(topic kontratı) → consumer               */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — pozitif (event zinciri)", () => {
  const snapshot = buildFixtureSnapshot();

  it("producer → EventContract → consumer contract segmentini üretir", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: SVC_ORDERS });

    const eventFlow = result.flows.find((flow) =>
      flow.segments.some((segment) => segment.to?.qualifiedName === CONSUMER_BILLING),
    );
    expect(eventFlow).toBeDefined();
    expect(eventFlow?.segments.map((segment) => [segment.edge?.kind, segment.certainty])).toEqual([
      ["PRODUCES_CONTRACT", "verified"],
      ["CONSUMES_CONTRACT", "verified"],
    ]);
    // Kontrattan consumera geçiş, CONSUMES_CONTRACT kenarının TERS yönünde
    // izlenir; kenar ham yönüyle (consumer → kontrat) aynen raporlanır.
    const consumerLeg = eventFlow?.segments.at(-1);
    expect(consumerLeg?.edge?.direction).toBe("reverse");
    expect(consumerLeg?.edge?.from).toBe(nid("Function", CONSUMER_BILLING, "src/services/billing-service.ts"));
    expect(consumerLeg?.edge?.to).toBe(
      nid("EventContract", TOPIC_ORDER_CREATED, ASYNCAPI_PATH),
    );
    expect(consumerLeg?.from?.qualifiedName).toBe(TOPIC_ORDER_CREATED);
    expect(consumerLeg?.to?.qualifiedName).toBe(CONSUMER_BILLING);
    expect(eventFlow?.chainKinds).toEqual(["event"]);
    expect(eventFlow?.hasGap).toBe(false);
    // Event zincirinin ucu (consumer) dürüst terminaldir: gap üretilmez.
    expect(eventFlow?.terminalNode?.qualifiedName).toBe(CONSUMER_BILLING);
  });

  it("consumer seed'iyle ters yönde: consumer → kontrat → producer → repo → table", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: CONSUMER_BILLING });

    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0];
    expect(flow?.segments.map((segment) => segment.edge?.kind)).toEqual([
      "CONSUMES_CONTRACT",
      "PRODUCES_CONTRACT",
      "CALLS",
      "CONSUMES_CONTRACT",
    ]);
    expect(flow?.certainty).toBe("verified");
    expect(flow?.terminalNode?.qualifiedName).toBe(TABLE_ORDERS);
    expect(flow?.chainKinds).toEqual(["event", "request"]);
  });
});

/* ------------------------------------------------------------------ */
/* Negatif: kopuk zincir → gap segmenti, uydurma köprü yok             */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — negatif (kopuk zincir ve çözülemeyen seed)", () => {
  const snapshot = buildFixtureSnapshot();

  it("kopuk zinciri gap segmentiyle dürüstçe keser; uydurma köprü/node üretmez", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_INVOICES });

    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0];
    expect(flow?.segments).toHaveLength(2);
    const gap = flow?.segments.at(-1);
    expect(gap?.certainty).toBe("gap");
    expect(gap?.edge).toBeNull();
    expect(gap?.to).toBeNull();
    expect(gap?.resolution).toBeNull();
    expect(gap?.reason).toContain("köprü üretilmedi");
    // Kopukluğun ÖNCESİ dürüst raporlanır: verified ROUTES_TO segmenti.
    expect(flow?.segments[0]?.certainty).toBe("verified");
    expect(flow?.hasGap).toBe(true);
    expect(flow?.certainty).toBe("gap");
    // Uydurma köprü yok: bilinmeyen bir service node'una segment açılmaz.
    const visited = segmentNodeIds(flow?.segments ?? []);
    expect(visited).toHaveLength(2);
    expect(visited.some((id) => id.includes("InvoiceService"))).toBe(false);
  });

  it("hiç devamı olmayan izole seed'i gap ile raporlar", () => {
    const isolated = buildSnapshotWith(
      [{ kind: "Function", qualifiedName: "formatDate", relativePath: "src/utils/date.ts" }],
      [],
    );
    const result = traceBusinessFlow(isolated, { flowSeed: "formatDate" });
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.segments).toHaveLength(1);
    expect(result.flows[0]?.segments[0]?.certainty).toBe("gap");
    expect(result.flows[0]?.hasGap).toBe(true);
  });

  it("bilinmeyen seed'i unresolvedSeed ile raporlar; akış üretmez", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: "no/such/symbol" });
    expect(result.seed).toBeNull();
    expect(result.unresolvedSeed?.seed).toBe("no/such/symbol");
    expect(result.flows).toHaveLength(0);
  });

  it("belirsiz (çok eşleşen) seed'i adaylarıyla raporlar; otomatik seçim yapmaz", () => {
    const ambiguousName = "dupHandler";
    const ambiguous = buildSnapshotWith(
      [
        { kind: "Handler", qualifiedName: ambiguousName, relativePath: "src/a.ts" },
        { kind: "Handler", qualifiedName: ambiguousName, relativePath: "src/b.ts" },
      ],
      [],
    );
    const result = traceBusinessFlow(ambiguous, { flowSeed: ambiguousName });
    expect(result.seed).toBeNull();
    expect(result.unresolvedSeed?.reason).toContain("belirsiz");
    expect(result.unresolvedSeed?.reason).toContain(
      nid("Handler", ambiguousName, "src/a.ts"),
    );
    expect(result.flows).toHaveLength(0);
  });

  it("boş seed ve geçersiz limitleri reddeder", () => {
    expect(() => traceBusinessFlow(snapshot, { flowSeed: "   " })).toThrowError(
      GraphRepositoryError,
    );
    expect(() => traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxHops: 0 })).toThrowError(
      GraphRepositoryError,
    );
    expect(() =>
      traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxFlows: Number.NaN }),
    ).toThrowError(GraphRepositoryError);
    expect(() =>
      traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, boundaries: ["IMPORTS"] }),
    ).toThrowError(GraphRepositoryError);
  });

  it("building snapshot'ta çalışmaz", () => {
    const building = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "building",
      createdAt: CREATED_AT,
      nodes: BASE_NODES.slice(0, 2).map((node) => ({
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
      })),
      edges: [],
    });
    try {
      traceBusinessFlow(building, { flowSeed: EP_ORDERS });
      expect.unreachable("building snapshot reddedilmeliydi");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe("graph/business-flow-snapshot-state");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Partial: heuristic kenarın sonrası "possible" işaretli              */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — partial (heuristic kenar sonrası possible)", () => {
  const snapshot = buildFixtureSnapshot();

  it("heuristic kenar 'heuristic', onu izleyen kenarlar 'possible' işaretlenir", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_BILLING_TOTALS });

    // BillingService'in tek devamı isim-benzerliği CONSUMES_CONTRACT'tir.
    expect(result.flows).toHaveLength(1);
    const contractFlow = result.flows[0];
    expect(contractFlow?.segments.map((segment) => [segment.certainty, segment.resolution])).toEqual([
      ["verified", "verified"],
      ["heuristic", "heuristic"],
      ["possible", "heuristic"], // heuristic köprünün sonrası: kesin iddia yok
    ]);
    expect(contractFlow?.certainty).toBe("possible");
  });

  it("heuristic kenardan SONRAKI verified kenar 'possible' olur; resolution alanı ayrı kalır", () => {
    const handler = { kind: "Handler" as const, qualifiedName: "h1", relativePath: "src/h.ts" };
    const service = { kind: "Class" as const, qualifiedName: "svc", relativePath: "src/s.ts" };
    const repo = { kind: "Class" as const, qualifiedName: "repo", relativePath: "src/r.ts" };
    const table = { kind: "SchemaContract" as const, qualifiedName: TABLE_ORDERS, relativePath: SQL_PATH };
    const endpoint = { kind: "Endpoint" as const, qualifiedName: "POST /x", relativePath: "src/app.ts" };
    const snapshotPartial = buildSnapshotWith(
      [endpoint, handler, service, repo, table],
      [
        {
          kind: "ROUTES_TO",
          from: ["Endpoint", "POST /x", "src/app.ts"],
          to: ["Handler", "h1", "src/h.ts"],
          resolution: "verified",
        },
        {
          kind: "CALLS",
          from: ["Handler", "h1", "src/h.ts"],
          to: ["Class", "svc", "src/s.ts"],
          resolution: "heuristic",
        },
        {
          kind: "CALLS",
          from: ["Class", "svc", "src/s.ts"],
          to: ["Class", "repo", "src/r.ts"],
          resolution: "verified",
        },
        {
          kind: "CONSUMES_CONTRACT",
          from: ["Class", "repo", "src/r.ts"],
          to: ["SchemaContract", TABLE_ORDERS, SQL_PATH],
          resolution: "verified",
        },
      ],
    );
    const result = traceBusinessFlow(snapshotPartial, { flowSeed: "POST /x" });
    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0];
    expect(flow?.segments.map((segment) => [segment.certainty, segment.resolution])).toEqual([
      ["verified", "verified"],
      ["heuristic", "heuristic"],
      ["possible", "verified"], // verified kenar, ama heuristic köprünün SONRASI
      ["possible", "verified"],
    ]);
    expect(flow?.certainty).toBe("possible");
    expect(flow?.resolution).toBe("heuristic");
    expect(flow?.hasGap).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Sınırlar: maxHops/maxFlows tavanları, döngü koruması, boundaries    */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — sınırlar ve döngü koruması", () => {
  const snapshot = buildFixtureSnapshot();

  it("maxHops zinciri truncated olarak kırpür; gap sanması üretmez", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxHops: 2 });
    const requestFlow = result.flows.find((flow) =>
      flow.segments.some((segment) => segment.to?.qualifiedName === SVC_ORDERS),
    );
    expect(requestFlow?.segments).toHaveLength(2);
    expect(requestFlow?.truncated).toBe(true);
    expect(requestFlow?.truncatedBy).toEqual(["maxHops"]);
    expect(requestFlow?.hasGap).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("maxHops tavanı (8) aşıldığında istek tavana indirilir ve rationale düşer", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxHops: 99 });
    expect(result.limits.maxHops).toBe(FLOW_LIMIT_CEILINGS.maxHops);
    expect(result.rationales.some((entry) => entry.includes("maxHops"))).toBe(true);
  });

  it("maxFlows dal sayısını sınırlar ve truncatedBy maxFlows raporlar", () => {
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxFlows: 1 });
    expect(result.flows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxFlows");
    expect(result.rationales.some((entry) => entry.includes("maxFlows"))).toBe(true);
  });

  it("döngüde sonsuz döngüye girmez; basit yol koruması akışı kapatır", () => {
    const a = { kind: "Class" as const, qualifiedName: "loopA", relativePath: "src/a.ts" };
    const b = { kind: "Class" as const, qualifiedName: "loopB", relativePath: "src/b.ts" };
    const looped = buildSnapshotWith(
      [a, b],
      [
        {
          kind: "CALLS",
          from: ["Class", "loopA", "src/a.ts"],
          to: ["Class", "loopB", "src/b.ts"],
          resolution: "verified",
        },
        {
          kind: "CALLS",
          from: ["Class", "loopB", "src/b.ts"],
          to: ["Class", "loopA", "src/a.ts"],
          resolution: "verified",
        },
      ],
    );
    const result = traceBusinessFlow(looped, { flowSeed: "loopA" });
    expect(result.flows).toHaveLength(1);
    const visited = segmentNodeIds(result.flows[0]?.segments ?? []);
    expect(new Set(visited).size).toBe(visited.length);
    expect(result.flows[0]?.hasGap).toBe(false);
  });

  it("boundaries parametresi izlenen kenar türlerini kısıtlar; kısıtlanan kesim gap ile raporlanır", () => {
    const result = traceBusinessFlow(snapshot, {
      flowSeed: EP_ORDERS,
      boundaries: ["CALLS"],
    });
    // Endpoint'ten CALLS kenarı yok: zincir başlayamaz; dürüst gap.
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.segments[0]?.certainty).toBe("gap");
    expect(result.flows[0]?.segments[0]?.reason).toContain("CALLS");
  });

  it("varsayılan boundary sözcüğü D5 görevindeki beş kenar türüdür", () => {
    expect([...BUSINESS_FLOW_EDGE_KINDS]).toEqual([
      "ROUTES_TO",
      "CALLS",
      "PRODUCES_CONTRACT",
      "CONSUMES_CONTRACT",
      "CONTAINS",
    ]);
    // TŞ §20 (s.22 config): results.maxNodes: 250 — maxNodes tavanı zorunlu.
    expect(FLOW_LIMIT_CEILINGS).toEqual({ maxHops: 8, maxFlows: 20, maxNodes: 250 });
  });
});

/* ------------------------------------------------------------------ */
/* TŞ §20 maxNodes bütçesi: BFS kuyruğu node bütçesiyle sınırlı        */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — maxNodes resource budget (TŞ §20)", () => {
  /** 15 node'luk 4 katmanlı ikili ağaç: dallanma kuyruğu patlatmadan önce
   * bütçenin devreye girdiğini göstermek için. */
  function buildTreeSnapshot(): SnapshotGraph {
    const names = ["n0", "n1a", "n1b", "n2a", "n2b", "n2c", "n2d"];
    const nodes = names.map(
      (name) => ({ kind: "Function" as const, qualifiedName: name, relativePath: `src/${name}.ts` }),
    );
    const treeEdges: readonly EdgeSpec[] = [
      { kind: "CALLS", from: ["Function", "n0", "src/n0.ts"], to: ["Function", "n1a", "src/n1a.ts"], resolution: "verified" },
      { kind: "CALLS", from: ["Function", "n0", "src/n0.ts"], to: ["Function", "n1b", "src/n1b.ts"], resolution: "verified" },
      { kind: "CALLS", from: ["Function", "n1a", "src/n1a.ts"], to: ["Function", "n2a", "src/n2a.ts"], resolution: "verified" },
      { kind: "CALLS", from: ["Function", "n1a", "src/n1a.ts"], to: ["Function", "n2b", "src/n2b.ts"], resolution: "verified" },
      { kind: "CALLS", from: ["Function", "n1b", "src/n1b.ts"], to: ["Function", "n2c", "src/n2c.ts"], resolution: "verified" },
      { kind: "CALLS", from: ["Function", "n1b", "src/n1b.ts"], to: ["Function", "n2d", "src/n2d.ts"], resolution: "verified" },
    ];
    return buildSnapshotWith(nodes, treeEdges);
  }

  it("maxNodes tavanı (250) TŞ §20 ile uyumludur ve istek tavana indirilir", () => {
    const result = traceBusinessFlow(buildTreeSnapshot(), { flowSeed: "n0", maxNodes: 999 });
    expect(result.limits.maxNodes).toBe(FLOW_LIMIT_CEILINGS.maxNodes);
    expect(FLOW_LIMIT_CEILINGS.maxNodes).toBe(250);
    expect(result.rationales.some((entry) => entry.includes("maxNodes"))).toBe(true);
  });

  it("istenen maxNodes bütçesi dolduğunda genişleme durur; kuyruğu bütçesiz büyütmez", () => {
    const result = traceBusinessFlow(buildTreeSnapshot(), { flowSeed: "n0", maxNodes: 5 });

    // Bütçe raporu: truncatedBy maxNodes + rationale.
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxNodes");
    expect(result.rationales.some((entry) => entry.includes("maxNodes"))).toBe(true);

    // Tüm akışların segment uçlarında geçen AYRIK node sayısı bütçeyi aşamaz:
    // budanmamış akışlar yalnızca bütçelenmiş node'ları içerebilir.
    const distinct = new Set<string>();
    for (const flow of result.flows) {
      for (const segment of flow.segments) {
        distinct.add(segment.from.nodeId);
        if (segment.to !== null) distinct.add(segment.to.nodeId);
      }
    }
    expect(distinct.size).toBeLessThanOrEqual(5);
    // Budanan akışlar dürüstçe truncated işaretlenir (budak, gap değil).
    for (const flow of result.flows) {
      if (flow.truncated) expect(flow.truncatedBy).toEqual(["maxNodes"]);
    }
    expect(result.flows.length).toBeGreaterThanOrEqual(1);
  });

  it("orders fixture'ında maxNodes: 2 ile zincir bütçe sınırında dürüstçe kırpılır", () => {
    const snapshot = buildFixtureSnapshot();
    const result = traceBusinessFlow(snapshot, { flowSeed: EP_ORDERS, maxNodes: 2 });
    expect(result.limits.maxNodes).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxNodes");
    // Seed + 1 bütçelenmiş node: tek kısa akış üretilir, kuyruk patlamaz.
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.truncated).toBe(true);
    expect(result.flows[0]?.truncatedBy).toEqual(["maxNodes"]);
  });

  it("KISMİ blok dürüstçe raporlanır: blok karışık (serbest dönüş + bloke yeni node) olsa bile sonuç truncated işaretler", () => {
    // A→B, B→C, B→D, C→B; maxNodes=3 (A,B,C bütçelenir, D bloke olur).
    // B→D blokesi KISMIDIR: aynı kısmi akışta C'ye serbest dönüş de vardır.
    // Eski davranışta bu blok hiç raporlanmaz, [A,B,C] zinciri 'döngü
    // koruması'yla TEMİZ kapanır ve sonuç truncated:false kalırdı.
    const mixed = buildSnapshotWith(
      [
        { kind: "Function", qualifiedName: "mA", relativePath: "src/ma.ts" },
        { kind: "Function", qualifiedName: "mB", relativePath: "src/mb.ts" },
        { kind: "Function", qualifiedName: "mC", relativePath: "src/mc.ts" },
        { kind: "Function", qualifiedName: "mD", relativePath: "src/md.ts" },
      ],
      [
        { kind: "CALLS", from: ["Function", "mA", "src/ma.ts"], to: ["Function", "mB", "src/mb.ts"], resolution: "verified" },
        { kind: "CALLS", from: ["Function", "mB", "src/mb.ts"], to: ["Function", "mC", "src/mc.ts"], resolution: "verified" },
        { kind: "CALLS", from: ["Function", "mB", "src/mb.ts"], to: ["Function", "mD", "src/md.ts"], resolution: "verified" },
        { kind: "CALLS", from: ["Function", "mC", "src/mc.ts"], to: ["Function", "mB", "src/mb.ts"], resolution: "verified" },
      ],
    );
    const result = traceBusinessFlow(mixed, { flowSeed: "mA", maxNodes: 3 });
    // Dürüstlük sözleşmesi: kota keşfi fiilen durdurduysa sonuç bunu
    // taşımak ZORUNDADIR (TŞ §20 truncated; mutlak iddia üretme yok).
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxNodes");
    expect(result.rationales.some((entry) => entry.includes("maxNodes"))).toBe(true);
    // Kota sonrası kapatılan kısmi akışlar cutBy ["maxNodes"] taşır.
    expect(result.flows.length).toBeGreaterThanOrEqual(1);
    expect(result.flows.some((flow) => flow.truncatedBy.includes("maxNodes"))).toBe(true);
    // Ayrıca bloke node hiçbir akışa sızmaz (uydurma yok).
    for (const flow of result.flows) {
      for (const segment of flow.segments) {
        expect(segment.to?.qualifiedName).not.toBe("mD");
        expect(segment.from.qualifiedName).not.toBe("mD");
      }
    }
  });

  it("yoğun çok-parent grafta serbest dönüşler bütçesiz katlanamaz (kapanışsız derin graf)", () => {
    // 8 node'luk tam yönlü çizge (self-loop hariç 56 kenar): her node'un
    // çıkışı VARDIR — hiçbir ara katmanda gap/cycle kapanışı olmaz; kapanış
    // yalnızca maxHops katmanında görülür. Bu kapanışsız derin grafta BFS,
    // ilk kapanışa varmadan tüm sığ katmanları kuyruğa alır (~13.7k basit
    // yol); kota (250) hiç dolmaz ama türetilmiş kuyruğa-alma bütçesi
    // (maxNodes × maxHops) kuyruğu bütçesiz büyütemez.
    const denseNames = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];
    const denseNodes = denseNames.map(
      (name) => ({ kind: "Function" as const, qualifiedName: name, relativePath: `src/${name}.ts` }),
    );
    const denseEdges: EdgeSpec[] = [];
    for (let i = 0; i < denseNames.length; i += 1) {
      for (let j = 0; j < denseNames.length; j += 1) {
        if (i === j) continue;
        denseEdges.push({
          kind: "CALLS",
          from: ["Function", denseNames[i] as string, `src/${denseNames[i] as string}.ts`],
          to: ["Function", denseNames[j] as string, `src/${denseNames[j] as string}.ts`],
          resolution: "verified",
        });
      }
    }
    const dense = buildSnapshotWith(denseNodes, denseEdges);
    const result = traceBusinessFlow(dense, { flowSeed: "d0" });
    // Kapanış yokluğunda kuyruk bütçesiz büyüyemez: türetilmiş kuyruk
    // bütçesi vurulur ve dürüstçe raporlanır.
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxNodes");
    expect(result.rationales.some((entry) => entry.includes("maxNodes"))).toBe(true);
    // Budanan akışlar cutBy ["maxNodes"] ile işaretlenir.
    expect(result.flows.some((flow) => flow.truncatedBy.includes("maxNodes"))).toBe(true);
    // Tavanlar: maxFlows'u aşan akış üretilmez.
    expect(result.flows.length).toBeLessThanOrEqual(FLOW_LIMIT_CEILINGS.maxFlows);
  });
});

/* ------------------------------------------------------------------ */
/* Kontrat dead-end rationale'i: 'döngü koruması' yanıltıcı olmaz      */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — kontrat devamsızlık rationale'i", () => {
  it("consumer'ı olmayan topic kontratı 'başka producer/consumer kenarı yok' gerekçesiyle kapanır; döngü koruması sanması üretilmez", () => {
    // Tek producer, consumer YOK: kontrattaki tek devam kenarı geldiğimiz
    // PRODUCES_CONTRACT'tır (geri döner) — gerçek durum devamsızlıktır.
    const loneProducer = buildSnapshotWith(
      [
        { kind: "Class", qualifiedName: "LoneProducer", relativePath: "src/lp.ts" },
        { kind: "EventContract", qualifiedName: TOPIC_ORDER_CREATED, relativePath: ASYNCAPI_PATH },
      ],
      [
        {
          kind: "PRODUCES_CONTRACT",
          from: ["Class", "LoneProducer", "src/lp.ts"],
          to: ["EventContract", TOPIC_ORDER_CREATED, ASYNCAPI_PATH],
          resolution: "verified",
        },
      ],
    );
    const result = traceBusinessFlow(loneProducer, { flowSeed: "LoneProducer" });
    expect(result.flows).toHaveLength(1);
    // Davranış değişmedi: kontrat geçişi temiz kapanır (uydurma köprü yok).
    expect(result.flows[0]?.hasGap).toBe(false);
    expect(result.flows[0]?.terminalNode?.kind).toBe("EventContract");
    // Dürüstlük: rationale gerçek durumu adlandırır.
    expect(
      result.rationales.some(
        (entry) => entry.includes("kontrat") && entry.includes("producer/consumer kenarı bulunamadı"),
      ),
    ).toBe(true);
    expect(result.rationales.some((entry) => entry.includes("döngü koruması"))).toBe(false);
  });

  it("kontrat olmayan node'larda tüm devam kenarları ziyaret edilmişse 'döngü koruması' rationale'i korunur", () => {
    const a = { kind: "Class" as const, qualifiedName: "loopA", relativePath: "src/a.ts" };
    const b = { kind: "Class" as const, qualifiedName: "loopB", relativePath: "src/b.ts" };
    const looped = buildSnapshotWith(
      [a, b],
      [
        { kind: "CALLS", from: ["Class", "loopA", "src/a.ts"], to: ["Class", "loopB", "src/b.ts"], resolution: "verified" },
        { kind: "CALLS", from: ["Class", "loopB", "src/b.ts"], to: ["Class", "loopA", "src/a.ts"], resolution: "verified" },
      ],
    );
    const result = traceBusinessFlow(looped, { flowSeed: "loopA" });
    expect(result.rationales.some((entry) => entry.includes("döngü koruması"))).toBe(true);
  });

  it("paket girişi (index.ts) traceBusinessFlow'u dışa açar", () => {
    expect(traceBusinessFlowFromIndex).toBe(traceBusinessFlow);
  });
});

/* ------------------------------------------------------------------ */
/* Determinizm: aynı giriş → aynı çıktı JSON                           */
/* ------------------------------------------------------------------ */

describe("traceBusinessFlow — determinizm", () => {
  it("aynı girdiyle iki koşum bit-bit aynı JSON'u üretir", () => {
    const snapshot = buildFixtureSnapshot();
    const input = { flowSeed: EP_ORDERS } as const;
    const first: TraceBusinessFlowResult = traceBusinessFlow(snapshot, input);
    const second: TraceBusinessFlowResult = traceBusinessFlow(snapshot, input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Kanonik sıralamalar: flow id'leri emisyon sırasında tutarlı.
    expect(first.flows.map((flow) => flow.flowId)).toEqual(
      first.flows.map((_, index) => `flow:${String(index + 1).padStart(4, "0")}`),
    );
  });
});
