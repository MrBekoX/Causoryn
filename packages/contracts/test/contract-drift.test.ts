import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ContractDiscoveryError,
  detectContractDrift,
  discoverOpenApiContracts,
  discoverProtobufContracts,
  discoverSqlContracts,
  matchContractEdges,
  scanServiceAnchors,
  type ContractCandidate,
  type ContractDriftResult,
  type ContractEdgeCandidate,
  type DiscoveryOutput,
  type ServiceAnchor,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi (diğer contract testleriyle aynı disiplin) */
/* ------------------------------------------------------------------ */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-contract-drift");

function resolveWithinFixture(relativePath: string): string {
  const target = path.resolve(FIXTURE_ROOT, relativePath);
  const boundary = FIXTURE_ROOT.endsWith(path.sep) ? FIXTURE_ROOT : FIXTURE_ROOT + path.sep;
  if (target !== FIXTURE_ROOT && !target.startsWith(boundary)) {
    throw new Error(`Fixture kökü dışına erişim reddedildi: ${relativePath}`);
  }
  return target;
}

function readFixture(relativePath: string): string {
  return readFileSync(resolveWithinFixture(relativePath), "utf8");
}

/* ------------------------------------------------------------------ */
/* Test adayı üretimi                                                  */
/* ------------------------------------------------------------------ */

let candidateSeq = 0;

function makeCandidate(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  candidateSeq += 1;
  const hex = candidateSeq.toString(16).padStart(64, "0");
  return {
    contractId: `node:${hex}`,
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
    evidence: { relativePath: "openapi.yaml", startLine: 6, endLine: 6 },
    diagnostics: [],
    ...overrides,
  };
}

/** Endpoint olmayan (SchemaContract) aday: method/route anahtarları taşınmaz. */
function makeSchemaCandidate(overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  const candidate = makeCandidate(overrides);
  const { method: ignoredMethod, route: ignoredRoute, ...withoutEndpoint } = candidate;
  void ignoredMethod;
  void ignoredRoute;
  return withoutEndpoint;
}

function endpointAnchor(
  symbol: string,
  method: string,
  route: string,
  line: number,
): ServiceAnchor {
  return {
    anchorKind: "endpoint",
    symbol,
    method,
    route,
    evidence: { relativePath: "src/services/orders-service.ts", startLine: line, endLine: line },
  };
}

function findChange(
  result: ContractDriftResult,
  contractId: string,
): (typeof result.contractChanges)[number] | undefined {
  return result.contractChanges.find((record) => record.contractId === contractId);
}

/* ------------------------------------------------------------------ */
/* POZİTİF — gerçek fixture SQL drift (001→002) × gerçek tüketici      */
/* kenarları (order-repository verified, billing heuristic)            */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — pozitif (tüketici kenarına etki + contractChanges)", () => {
  const base = discoverSqlContracts("w_drift", "db/001_create_orders.sql", readFixture("db/001_create_orders.sql"));
  const target = discoverSqlContracts("w_drift", "db/002_alter_orders.sql", readFixture("db/002_alter_orders.sql"));

  // Tüketici kodu iki sürüm arasında DEĞİŞMEMİŞTİR; aynı ankraj dosyaları
  // her iki sürümün sözleşmelerine kenar üretir (gerçekçi drift sahnesi).
  const anchors: ServiceAnchor[] = [
    ...scanServiceAnchors(
      "src/repositories/order-repository.ts",
      readFixture("src/repositories/order-repository.ts"),
      "order-repository",
    ),
    ...scanServiceAnchors(
      "src/services/billing-service.ts",
      readFixture("src/services/billing-service.ts"),
      "billing-service",
    ),
  ];
  const baseEdges = matchContractEdges(base.contracts, anchors);
  const targetEdges = matchContractEdges(target.contracts, anchors);

  const baseTable = base.contracts.find((contract) => contract.name === "orders") as ContractCandidate;
  const targetTable = target.contracts.find((contract) => contract.name === "orders") as ContractCandidate;

  const drift = detectContractDrift({ base, target, baseEdges, targetEdges });

  it("table:orders modified → K-013(7) contractChanges kaydı: {contractId, changeKind, summary} TAM gövde", () => {
    expect(drift.contractChanges).toHaveLength(1);
    const record = findChange(drift, targetTable.contractId);
    expect(record).toBeDefined();
    expect(record?.changeKind).toBe("modified");
    expect(record?.summary).toContain("column-dropped");
    expect(record?.summary).toContain("orders");
    // K-013(7) gövdesi TAM ÜÇ alan: fazlası yok, eksiği yok
    expect(Object.keys(record as object).sort()).toEqual(["changeKind", "contractId", "summary"]);
  });

  it("breaking_candidate AYRI alanda; risks ve unknowns KARİŞTIRMAZ", () => {
    expect(drift.breakingCandidates).toHaveLength(1);
    const item = drift.breakingCandidates[0] as ContractDriftResult["breakingCandidates"][number];
    expect(item.matchKey).toBe("sql SchemaContract table:orders");
    expect(item.contractId).toBe(targetTable.contractId);
    expect(item.changeKind).toBe("modified");
    // kural adı + kanıt item içinde taşınır
    const dropped = item.findings.find((finding) => finding.ruleId === "column-dropped");
    expect(dropped?.classification).toBe("breaking_candidate");
    expect(dropped?.property).toBe("currency");
    expect(dropped?.evidence[0]?.relativePath).toBe("db/002_alter_orders.sql");
    // ayrı alan disiplini: aynı çift başka alanda TEKRAR ETMEZ
    expect(drift.risks).toHaveLength(0);
    expect(drift.unknowns).toHaveLength(0);
  });

  it("etki grafı: tüketici kenarları kanıtlarıyla — verified repo + heuristic billing, iki sürüm tarafı", () => {
    // base tarafı: 2 kenar (repo verified + billing heuristic); target tarafı: 2 kenar
    expect(drift.impactedEdges).toHaveLength(4);

    const baseRepo = drift.impactedEdges.find(
      (impact) =>
        impact.side === "base" &&
        impact.fromSymbol === "order-repository" &&
        impact.toContractId === baseTable.contractId,
    );
    expect(baseRepo?.edgeKind).toBe("CONSUMES_CONTRACT");
    expect(baseRepo?.resolution).toBe("verified"); // ASLA yükseltme yok: verified kalır
    expect(baseRepo?.matchBasis).toBe("name-exact");
    expect(baseRepo?.classification).toBe("breaking_candidate");
    expect(baseRepo?.matchKey).toBe("sql SchemaContract table:orders");
    expect(baseRepo?.evidence.length).toBeGreaterThan(0);

    const targetBilling = drift.impactedEdges.find(
      (impact) =>
        impact.side === "target" &&
        impact.fromSymbol === "billing-service" &&
        impact.toContractId === targetTable.contractId,
    );
    expect(targetBilling?.resolution).toBe("heuristic"); // heuristic ASLA verified'a yükseltilmez
    expect(targetBilling?.matchBasis).toBe("name-similarity");
    expect(targetBilling?.changeKind).toBe("modified");
  });

  it("tüketici kenarı VAR → unconsumedChanges boş; determinizm + saflık", () => {
    expect(drift.unconsumedChanges).toHaveLength(0);
    const snapshot = JSON.stringify([base, target, baseEdges, targetEdges]);
    const again = detectContractDrift({ base, target, baseEdges, targetEdges });
    expect(JSON.stringify(again)).toBe(JSON.stringify(drift));
    expect(JSON.stringify([base, target, baseEdges, targetEdges])).toBe(snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* NEGATİF — değişiklik yok → boş drift + rationale                    */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — negatif (değişiklik yok)", () => {
  const openapiText = readFixture("openapi.yaml");
  const base = discoverOpenApiContracts("w_drift", "openapi.yaml", openapiText);
  const target = discoverOpenApiContracts("w_drift", "openapi.yaml", openapiText);

  const anchors: ServiceAnchor[] = scanServiceAnchors(
    "src/services/orders-service.ts",
    readFixture("src/services/orders-service.ts"),
    "orders-service",
  );
  const edges = matchContractEdges(base.contracts, anchors);
  const drift = detectContractDrift({ base, target, baseEdges: edges, targetEdges: edges });

  it("öz-karşılaştırma: contractChanges/impactedEdges/üç sınıflama alanı tamamen boş", () => {
    expect(drift.contractChanges).toHaveLength(0);
    expect(drift.impactedEdges).toHaveLength(0);
    expect(drift.breakingCandidates).toHaveLength(0);
    expect(drift.risks).toHaveLength(0);
    expect(drift.unknowns).toHaveLength(0);
    expect(drift.unconsumedChanges).toHaveLength(0);
  });

  it("rationale gerekçeyi taşır: karşılaştırılan çift sayısı + değişiklik yok notu", () => {
    expect(drift.rationale.length).toBeGreaterThan(0);
    expect(drift.rationale[0]).toContain("compared pairs");
    expect(drift.rationale[0]).toContain("; changed: 0;");
    expect(drift.rationale.some((entry) => entry.includes("drift is empty"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* PARTIAL — tüketici kenarı olmayan sözleşme değişimi                 */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — partial (unconsumed)", () => {
  // Gerçek fixture şekli: schemas/order-created.schema.json OrderCreatedPayload
  // (required [orderId, amountMinor]); v2 adayı amountMinor'u SİLİYOR
  // (breaking_candidate) ancak hiçbir tüketici kenarı YOK.
  const payloadV1 = makeSchemaCandidate({
    sourceKind: "json-schema",
    nodeKind: "SchemaContract",
    name: "OrderCreatedPayload",
    qualifiedName: "OrderCreatedPayload",
    requiredPropertyNames: ["orderId", "amountMinor"],
    properties: [
      { name: "amountMinor", type: "integer", required: true },
      { name: "orderId", type: "string", required: true },
    ],
    evidence: { relativePath: "schemas/order-created.schema.json", startLine: 4, endLine: 4 },
  });
  const payloadV2 = makeSchemaCandidate({
    sourceKind: "json-schema",
    nodeKind: "SchemaContract",
    name: "OrderCreatedPayload",
    qualifiedName: "OrderCreatedPayload",
    requiredPropertyNames: ["orderId"],
    properties: [{ name: "orderId", type: "string", required: true }],
    evidence: { relativePath: "schemas/order-created.schema.json", startLine: 4, endLine: 4 },
  });

  const drift = detectContractDrift({
    base: { contracts: [payloadV1], diagnostics: [] },
    target: { contracts: [payloadV2], diagnostics: [] },
    baseEdges: [],
    targetEdges: [],
  });

  it("breaking değişim sınıflanır AMA etki grafı boştur + unconsumed kaydı ve rationale notu üretilir", () => {
    expect(drift.breakingCandidates).toHaveLength(1);
    expect(drift.impactedEdges).toHaveLength(0); // etki yok
    expect(drift.unconsumedChanges).toHaveLength(1);
    const record = drift.unconsumedChanges[0] as ContractDriftResult["unconsumedChanges"][number];
    expect(record.contractId).toBe(payloadV2.contractId);
    expect(record.changeKind).toBe("modified");
    expect(
      drift.rationale.some(
        (entry) =>
          entry.startsWith("unconsumed:") &&
          entry.includes("json-schema SchemaContract OrderCreatedPayload"),
      ),
    ).toBe(true);
  });

  it("değişmeyen serializer-unknown çifti unknowns'a GİRMEZ; rationale değerlendirme notu taşır", () => {
    const protoText = readFixture("contracts/order-created.proto");
    const proto = discoverProtobufContracts("w_drift", "contracts/order-created.proto", protoText);
    const protoDrift = detectContractDrift({
      base: { contracts: proto.contracts, diagnostics: proto.diagnostics },
      target: { contracts: proto.contracts, diagnostics: proto.diagnostics },
      baseEdges: [],
      targetEdges: [],
    });
    expect(protoDrift.contractChanges).toHaveLength(0);
    expect(protoDrift.unknowns).toHaveLength(0); // değişiklik yok → sınıflama alanlarına girmez
    expect(
      protoDrift.rationale.some(
        (entry) => entry.includes("serializer-unknown") && entry.includes("no change"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ADDED/REMOVED etki grafı — POST→PUT metot değişimi (constructed)    */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — added/removed etki grafı", () => {
  const baseContracts = [
    makeCandidate({ method: "POST", route: "/orders", qualifiedName: "createOrder", name: "createOrder" }),
    makeCandidate({
      method: "GET",
      route: "/orders/{orderId}",
      qualifiedName: "getOrder",
      name: "getOrder",
      evidence: { relativePath: "openapi.yaml", startLine: 15, endLine: 15 },
    }),
  ];
  const targetContracts = [
    makeCandidate({
      method: "PUT",
      route: "/orders",
      qualifiedName: "replaceOrder",
      name: "replaceOrder",
      evidence: { relativePath: "openapi-v2.yaml", startLine: 6, endLine: 6 },
    }),
  ];

  const baseEdges: ContractEdgeCandidate[] = matchContractEdges(
    baseContracts,
    [endpointAnchor("orders-service", "POST", "/orders", 16), endpointAnchor("orders-service", "GET", "/orders/:orderId", 17)],
  );
  const targetEdges: ContractEdgeCandidate[] = matchContractEdges(
    targetContracts,
    [endpointAnchor("orders-service", "PUT", "/orders", 16)],
  );

  const drift = detectContractDrift({
    base: { contracts: baseContracts, diagnostics: [] },
    target: { contracts: targetContracts, diagnostics: [] },
    baseEdges,
    targetEdges,
  });

  it("metot değişimi: POST removed (breaking) + PUT added (backward-safe) contractChanges kayıtları", () => {
    expect(drift.contractChanges).toHaveLength(3);
    const removedPost = drift.contractChanges.find((record) => record.contractId === baseContracts[0]?.contractId);
    expect(removedPost?.changeKind).toBe("removed");
    const removedGet = drift.contractChanges.find((record) => record.contractId === baseContracts[1]?.contractId);
    expect(removedGet?.changeKind).toBe("removed");
    const addedPut = drift.contractChanges.find((record) => record.contractId === targetContracts[0]?.contractId);
    expect(addedPut?.changeKind).toBe("added");
    expect(addedPut?.summary).toContain("added-endpoint");
  });

  it("breaking_candidates: POST method-changed + GET removed-endpoint; backward-safe PUT üç sınıflama alanına girmez", () => {
    expect(drift.breakingCandidates).toHaveLength(2);
    expect(drift.risks).toHaveLength(0);
    expect(drift.unknowns).toHaveLength(0);
  });

  it("etki grafı: base tarafı POST/GET kenarları breaking ile, target tarafı PUT kenarı backward-safe ile işaretlenir", () => {
    expect(drift.impactedEdges).toHaveLength(3);
    const postImpact = drift.impactedEdges.find((impact) => impact.toContractId === baseContracts[0]?.contractId);
    expect(postImpact?.side).toBe("base");
    expect(postImpact?.classification).toBe("breaking_candidate");
    expect(postImpact?.changeKind).toBe("removed");
    const putImpact = drift.impactedEdges.find((impact) => impact.toContractId === targetContracts[0]?.contractId);
    expect(putImpact?.side).toBe("target");
    expect(putImpact?.classification).toBe("backward-safe");
    expect(putImpact?.changeKind).toBe("added");
    // endpoint sözleşmelerinin tüketici kenarı yok → unconsumed notu (dış istemciler görünmez)
    expect(drift.unconsumedChanges).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* UNKNOWN sınıflı DEĞİŞEN çiftler — sprint-5 çıkış kriteri: unknown   */
/* üçlüsü D3 çıktı tarafında da testli olmalı (unknowns.push dalı)     */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — unknown sınıflı değişiklikler (ayrı alan)", () => {
  it("serializer-unknown işaretli DEĞİŞEN çift → unknowns dolar; breakingCandidates/risks TEKRAR ETMEZ", () => {
    // Marker formatı protobuf-discovery.ts sözleşmesidir ("— serializer unknown").
    // Not: D1'de marker'lı aday pratikte partial olarak gelir; bu kurulum çekirdeğin
    // marker sözleşmesini (diagnostics metni) doğrudan doğrular — değişiklik bulgusu
    // (optional-property-added) ateşlenerek changeKind=modified altında unknown
    // sınıflamasının üretildiği kanıtlanır.
    const marker = "protobuf: map<string,string> field type is beyond the scope of this limited parser — serializer unknown";
    const evtV1 = makeSchemaCandidate({
      sourceKind: "protobuf",
      nodeKind: "SchemaContract",
      name: "causoryn.orders.OrderCreatedEvent",
      qualifiedName: "causoryn.orders.OrderCreatedEvent",
      requiredPropertyNames: [],
      properties: [
        { name: "amount_minor", type: "int64", required: false },
        { name: "order_id", type: "string", required: false },
      ],
      certainty: "full",
      diagnostics: [marker],
      evidence: { relativePath: "contracts/order-created.proto", startLine: 6, endLine: 11 },
    });
    const evtV2 = makeSchemaCandidate({
      sourceKind: "protobuf",
      nodeKind: "SchemaContract",
      name: "causoryn.orders.OrderCreatedEvent",
      qualifiedName: "causoryn.orders.OrderCreatedEvent",
      requiredPropertyNames: [],
      properties: [
        { name: "amount_minor", type: "int64", required: false },
        { name: "currency", type: "string", required: false },
        { name: "order_id", type: "string", required: false },
      ],
      certainty: "full",
      diagnostics: [marker],
      evidence: { relativePath: "contracts/order-created.proto", startLine: 6, endLine: 12 },
    });

    const drift = detectContractDrift({
      base: { contracts: [evtV1], diagnostics: [] },
      target: { contracts: [evtV2], diagnostics: [] },
      baseEdges: [],
      targetEdges: [],
    });

    expect(drift.contractChanges).toHaveLength(1);
    expect(drift.contractChanges[0]?.changeKind).toBe("modified");
    expect(drift.unknowns).toHaveLength(1);
    const item = drift.unknowns[0] as ContractDriftResult["unknowns"][number];
    expect(item.matchKey).toBe("protobuf SchemaContract causoryn.orders.OrderCreatedEvent");
    expect(item.findings.some((finding) => finding.ruleId === "serializer-unknown")).toBe(true);
    expect(item.findings.some((finding) => finding.ruleId === "optional-property-added")).toBe(true);
    // TEK ALAN disiplini: aynı çift başka sınıflama alanında TEKRAR ETMEZ
    expect(drift.breakingCandidates).toHaveLength(0);
    expect(drift.risks).toHaveLength(0);
  });

  it("gerçek keşif: rename-only SQL hedefi → column-renamed unknown → unknowns dolar (gerçek diagnostic yolu)", () => {
    const renameOnlySql =
      "-- v3: sadece rename tanima dilimi\nALTER TABLE orders RENAME COLUMN amount TO amount_minor;\n";
    const base = discoverSqlContracts("w_drift", "db/001_create_orders.sql", readFixture("db/001_create_orders.sql"));
    const target = discoverSqlContracts("w_drift", "db/003_rename_orders.sql", renameOnlySql);
    const drift = detectContractDrift({
      base,
      target,
      baseEdges: [],
      targetEdges: [],
    });

    expect(drift.unknowns).toHaveLength(1);
    const item = drift.unknowns[0] as ContractDriftResult["unknowns"][number];
    expect(item.matchKey).toBe("sql SchemaContract table:orders");
    const renamed = item.findings.find((finding) => finding.ruleId === "column-renamed");
    expect(renamed?.classification).toBe("unknown");
    expect(renamed?.property).toBe("amount");
    // ALTER-only hedef partial olduğundan yapısal silme iddiası ÜRETİLMEZ
    expect(item.findings.some((finding) => finding.ruleId === "required-property-removed")).toBe(false);
    expect(drift.breakingCandidates).toHaveLength(0);
    expect(drift.risks).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Kenar girdi doğrulaması — Evidence First: kanıtsız/bozuk kenar      */
/* girdisi etki kaydına taşınmaz, açık reddi verilir                   */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — kenar girdi doğrulaması (açık reddi)", () => {
  const empty: DiscoveryOutput = { contracts: [], diagnostics: [] };

  function validEdge(overrides: Partial<ContractEdgeCandidate> = {}): ContractEdgeCandidate {
    return {
      edgeKind: "CONSUMES_CONTRACT",
      fromSymbol: "order-repository",
      toContractId: "node:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resolution: "verified",
      matchBasis: "name-exact",
      evidence: [{ relativePath: "src/repositories/order-repository.ts", startLine: 12, endLine: 12 }],
      ...overrides,
    };
  }

  it("geçerli kenar kabul edilir (pozitif kontrol)", () => {
    const drift = detectContractDrift({
      base: empty,
      target: empty,
      baseEdges: [validEdge()],
      targetEdges: [],
    });
    expect(drift.contractChanges).toHaveLength(0);
  });

  it("evidence'sız kenar → contracts/invalid-input reddi (TŞ Evidence First)", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [validEdge({ evidence: [] })],
        targetEdges: [],
      }),
    ).toThrow(ContractDiscoveryError);
  });

  it("geçersiz edgeKind → reddi", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [validEdge({ edgeKind: "PRODUCES" as ContractEdgeCandidate["edgeKind"] })],
        targetEdges: [],
      }),
    ).toThrow(/invalid-input/u);
  });

  it("geçersiz resolution → reddi", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [validEdge({ resolution: "unknown" as ContractEdgeCandidate["resolution"] })],
        targetEdges: [],
      }),
    ).toThrow(/invalid-input/u);
  });

  it("geçersiz matchBasis → reddi", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [validEdge({ matchBasis: "schema-id" as ContractEdgeCandidate["matchBasis"] })],
        targetEdges: [],
      }),
    ).toThrow(/invalid-input/u);
  });

  it("geçersiz evidence span (startLine 0 / relativePath boş) → reddi", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [
          validEdge({
            evidence: [{ relativePath: "src/x.ts", startLine: 0, endLine: 0 }],
          }),
        ],
        targetEdges: [],
      }),
    ).toThrow(/invalid-input/u);
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [],
        targetEdges: [validEdge({ evidence: [{ relativePath: "", startLine: 1, endLine: 1 }] })],
      }),
    ).toThrow(/invalid-input/u);
  });

  it("boş fromSymbol/toContractId → reddi", () => {
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [validEdge({ fromSymbol: "" })],
        targetEdges: [],
      }),
    ).toThrow(/invalid-input/u);
  });
});

/* ------------------------------------------------------------------ */
/* Girdi doğrulama                                                     */
/* ------------------------------------------------------------------ */

describe("detectContractDrift — girdi disiplini", () => {
  const empty: DiscoveryOutput = { contracts: [], diagnostics: [] };

  it("eksik/hatalı alan → contracts/invalid-input açık reddi", () => {
    expect(() =>
      detectContractDrift({
        base: undefined as unknown as DiscoveryOutput,
        target: empty,
        baseEdges: [],
        targetEdges: [],
      }),
    ).toThrow(ContractDiscoveryError);
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: "x" as unknown as ContractEdgeCandidate[],
        targetEdges: [],
      }),
    ).toThrow(ContractDiscoveryError);
    expect(() =>
      detectContractDrift({
        base: empty,
        target: empty,
        baseEdges: [],
        targetEdges: [{ fromSymbol: "x" } as unknown as ContractEdgeCandidate],
      }),
    ).toThrow(/invalid-input/u);
  });

  it("tamamen boş girdi → boş drift, rationale sayacıyla", () => {
    const drift = detectContractDrift({ base: empty, target: empty, baseEdges: [], targetEdges: [] });
    expect(drift.contractChanges).toHaveLength(0);
    expect(drift.rationale[0]).toContain("compared pairs: 0");
  });
});
