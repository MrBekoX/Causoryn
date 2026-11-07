import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ContractDiscoveryError,
  checkContractCompatibility,
  discoverOpenApiContracts,
  discoverProtobufContracts,
  discoverSqlContracts,
  evaluateContractPair,
  parseStructuredSpec,
  type ContractCandidate,
  type ContractCompatibilityFinding,
  type ContractPairEvaluation,
  type DiscoveryOutput,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi (contract-discovery.test.ts ile aynı disiplin) */
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

function fixtureLineOf(relativePath: string, ...segments: Array<string | number>): number {
  const line = parseStructuredSpec(relativePath, readFixture(relativePath)).lineOf(...segments);
  if (line === undefined) {
    throw new Error(`Fixture satırı çözümlenemedi: ${relativePath} ${segments.join("/")}`);
  }
  return line;
}

/* ------------------------------------------------------------------ */
/* Test adayı üretimi (contract-matching.test.ts örüntüsü)             */
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

function findingOf(
  evaluation: ContractPairEvaluation,
  ruleId: string,
  property?: string,
): ContractCompatibilityFinding | undefined {
  return evaluation.findings.find(
    (finding) => finding.ruleId === ruleId && (property === undefined || finding.property === property),
  );
}

/* ------------------------------------------------------------------ */
/* POZİTİF — fixture openapi v1→v2 gerçek keşif: opsiyonel alan        */
/* ekleme + zorunluluk gevşemesi → backward-safe                       */
/* ------------------------------------------------------------------ */

describe("checkContractCompatibility — pozitif (backward-safe)", () => {
  const base = discoverOpenApiContracts("w_drift", "openapi.yaml", readFixture("openapi.yaml"));
  const target = discoverOpenApiContracts("w_drift", "openapi-v2.yaml", readFixture("openapi-v2.yaml"));
  const report = checkContractCompatibility(base, target);

  it("POST /orders çifti backward-safe; her bulguda kural adı + eski/yeni satır kanıtı var", () => {
    const pair = report.evaluations.find((evaluation) => evaluation.matchKey === "POST /orders");
    expect(pair).toBeDefined();
    const evaluation = pair as ContractPairEvaluation;
    expect(evaluation.changeKind).toBe("modified");
    expect(evaluation.classification).toBe("backward-safe");
    expect(evaluation.baseContractId).toBe(base.contracts.find((c) => c.route === "/orders" && c.method === "POST")?.contractId);
    expect(evaluation.targetContractId).toBe(target.contracts.find((c) => c.route === "/orders" && c.method === "POST")?.contractId);

    // TŞ §11 kuralı: yeni opsiyonel alan → backward-safe
    const added = findingOf(evaluation, "optional-property-added", "note");
    expect(added?.classification).toBe("backward-safe");
    expect(added?.evidence).toHaveLength(2);
    expect(added?.evidence[0]).toEqual({
      relativePath: "openapi.yaml",
      startLine: fixtureLineOf("openapi.yaml", "paths", "/orders"),
      endLine: fixtureLineOf("openapi.yaml", "paths", "/orders"),
    });
    expect(added?.evidence[1]?.relativePath).toBe("openapi-v2.yaml");
    expect(added?.evidence[1]?.startLine).toBe(fixtureLineOf("openapi-v2.yaml", "paths", "/orders"));

    // property korunur, yalnızca zorunluluk gevşer → backward-safe (belgeli)
    const relaxed = findingOf(evaluation, "required-property-relaxed", "currency");
    expect(relaxed?.classification).toBe("backward-safe");
    expect(relaxed?.evidence).toHaveLength(2);
  });

  it("yeni GET /orders rotası → added-endpoint backward-safe; değişmeyen çift unchanged", () => {
    const added = report.evaluations.find((evaluation) => evaluation.matchKey === "GET /orders");
    expect(added?.changeKind).toBe("added");
    expect(added?.classification).toBe("backward-safe");
    expect(findingOf(added as ContractPairEvaluation, "added-endpoint")?.classification).toBe("backward-safe");

    const unchanged = report.evaluations.find((evaluation) => evaluation.matchKey === "GET /orders/{orderId}");
    expect(unchanged?.changeKind).toBe("unchanged");
    expect(unchanged?.classification).toBe("backward-safe");
  });

  it("rapor toplam sınıflaması backward-safe; determinizm invariant'ı (aynı giriş → aynı JSON)", () => {
    expect(report.classification).toBe("backward-safe");
    const again = checkContractCompatibility(base, target);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    // saflık: girdi adayları mutasyona uğramaz
    expect(() => JSON.parse(JSON.stringify(base))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* NEGATİF — TŞ §11 kural 1: zorunlu property silinmesi                */
/* → breaking_candidate + eski/yeni satır kanıtı                       */
/*                                                                     */
/* Fixture bağlantısı: openapi keşif dilimi ApiContract adayına         */
/* YALNIZCA request şemasının property'lerini taşır; breaking          */
/* malzemesi (Order YANIT şemasından zorunlu currency silinmesi)        */
/* şema düzeyidir. Bu senaryo adayları fixture dosyalarındaki Order     */
/* bloklarının gerçek şekliyle ve gerçek satır kanıtlarıyla kurulur.    */
/* ------------------------------------------------------------------ */

describe("evaluateContractPair — negatif (breaking_candidate)", () => {
  const v1OrderLine = fixtureLineOf("openapi.yaml", "components", "schemas", "Order");
  const v2OrderLine = fixtureLineOf("openapi-v2.yaml", "components", "schemas", "Order");

  // Fixture Order bloklarının birebir şekli:
  // v1: type object, required [id, amount, currency], properties id/amount/currency
  // v2: type object, required [id, amount], properties id/amount — currency TAMAMEN SİLİNDİ
  const v1Order = makeSchemaCandidate({
    sourceKind: "openapi",
    nodeKind: "SchemaContract",
    name: "Order",
    qualifiedName: "Order",
    requiredPropertyNames: ["id", "amount", "currency"],
    properties: [
      { name: "amount", type: "number", required: true },
      { name: "currency", type: "string", required: true },
      { name: "id", type: "string", required: true },
    ],
    evidence: { relativePath: "openapi.yaml", startLine: v1OrderLine, endLine: v1OrderLine },
  });
  const v2Order = makeSchemaCandidate({
    sourceKind: "openapi",
    nodeKind: "SchemaContract",
    name: "Order",
    qualifiedName: "Order",
    requiredPropertyNames: ["id", "amount"],
    properties: [
      { name: "amount", type: "number", required: true },
      { name: "id", type: "string", required: true },
    ],
    evidence: { relativePath: "openapi-v2.yaml", startLine: v2OrderLine, endLine: v2OrderLine },
  });

  const evaluation = evaluateContractPair(v1Order, v2Order);

  // Kontrol varyantı: currency SİLİNMEZ, yalnızca opsiyonelleşir (property korunur).
  const v2OrderRelaxed = makeSchemaCandidate({
    sourceKind: "openapi",
    nodeKind: "SchemaContract",
    name: "Order",
    qualifiedName: "Order",
    requiredPropertyNames: ["id", "amount"],
    properties: [
      { name: "amount", type: "number", required: true },
      { name: "currency", type: "string", required: false },
      { name: "id", type: "string", required: true },
    ],
    evidence: { relativePath: "openapi-v2.yaml", startLine: v2OrderLine, endLine: v2OrderLine },
  });

  it("zorunlu property silinmesi → breaking_candidate; kural adı currency + eski/yeni satır kanıtı", () => {
    expect(evaluation.classification).toBe("breaking_candidate");
    expect(evaluation.changeKind).toBe("modified");
    const finding = findingOf(evaluation, "required-property-removed", "currency");
    expect(finding).toBeDefined();
    expect(finding?.classification).toBe("breaking_candidate");
    expect(finding?.property).toBe("currency");
    expect(finding?.evidence).toEqual([
      { relativePath: "openapi.yaml", startLine: v1OrderLine, endLine: v1OrderLine },
      { relativePath: "openapi-v2.yaml", startLine: v2OrderLine, endLine: v2OrderLine },
    ]);
  });

  it("kontrol: silinen property geri gelir fakat opsiyonelse breaking İDDİASI YOK (required→optional backward-safe)", () => {
    const relaxed = evaluateContractPair(v1Order, v2OrderRelaxed);
    expect(relaxed.classification).toBe("backward-safe");
    expect(findingOf(relaxed, "required-property-removed", "currency")).toBeUndefined();
    expect(findingOf(relaxed, "required-property-relaxed", "currency")?.classification).toBe("backward-safe");
  });

  it("ters yön: opsiyonel→zorunlu (TŞ §11 nullable→required karşılığı) → risk", () => {
    const reversed = evaluateContractPair(v2OrderRelaxed, v1Order);
    expect(reversed.classification).toBe("risk");
    expect(findingOf(reversed, "optional-property-made-required", "currency")?.classification).toBe("risk");
  });
});

/* ------------------------------------------------------------------ */
/* NEGATİF (gerçek keşif) — fixture SQL 001→002: kolon kaldırma        */
/* (TŞ §11: "DB kolon kaldırma → tüketiciler için aday etki")          */
/* ------------------------------------------------------------------ */

describe("checkContractCompatibility — SQL fixture drift (gerçek keşif)", () => {
  const base = discoverSqlContracts(
    "w_drift",
    "db/001_create_orders.sql",
    readFixture("db/001_create_orders.sql"),
  );
  const target = discoverSqlContracts(
    "w_drift",
    "db/002_alter_orders.sql",
    readFixture("db/002_alter_orders.sql"),
  );
  const report = checkContractCompatibility(base, target);

  const sql2Lines = readFixture("db/002_alter_orders.sql").split(/\r?\n/);
  // Yalnızca gerçek ALTER statement'ı eşle (dosyadaki -- yorum satırı aynı metni taşır).
  const dropLine =
    sql2Lines.findIndex(
      (line) => line.trimStart().startsWith("ALTER TABLE") && line.includes("DROP COLUMN currency"),
    ) + 1;

  it("table:orders çifti breaking_candidate; column-dropped kanıtı DROP satırına işaret eder", () => {
    expect(report.classification).toBe("breaking_candidate");
    const pair = report.evaluations.find((evaluation) => evaluation.matchKey === "sql SchemaContract table:orders");
    expect(pair).toBeDefined();
    const evaluation = pair as ContractPairEvaluation;
    expect(evaluation.classification).toBe("breaking_candidate");
    expect(evaluation.changeKind).toBe("modified");

    const dropped = findingOf(evaluation, "column-dropped", "currency");
    expect(dropped?.classification).toBe("breaking_candidate");
    expect(dropped?.evidence).toEqual([
      { relativePath: "db/002_alter_orders.sql", startLine: dropLine, endLine: dropLine },
    ]);
  });

  it("kısmi keşif dürüstlüğü: ALTER-only hedef dosyada yapısal silme iddiası ÜRETİLMEZ, discovery-partial unknown düşer", () => {
    const pair = report.evaluations.find(
      (evaluation) => evaluation.matchKey === "sql SchemaContract table:orders",
    ) as ContractPairEvaluation;
    const partial = findingOf(pair, "discovery-partial");
    expect(partial?.classification).toBe("unknown");
    // Bastırılan adlar belirli olmalı (id/amount/created_at zorunlu, currency opsiyonel)
    for (const name of ["id", "amount", "created_at", "currency"]) {
      expect(partial?.summary).toContain(name);
    }
    // Bastırılanlar için breaking bulgusu üretilmemiştir (uydurma güven yok)
    expect(findingOf(pair, "required-property-removed", "id")).toBeUndefined();
    expect(findingOf(pair, "required-property-removed", "amount")).toBeUndefined();
    // ADD COLUMN note → backward-safe ekleme
    expect(findingOf(pair, "optional-property-added", "note")?.classification).toBe("backward-safe");
    // RENAME tanıma dilimi: sınıflandırma TŞ'de yok → unknown (uydurma yok)
    expect(findingOf(pair, "column-renamed", "amount")?.classification).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* PARTIAL — bilinmeyen serializer → unknown + gerekçe                 */
/* (fixture contracts/order-created.proto: map alanı)                  */
/* ------------------------------------------------------------------ */

describe("evaluateContractPair — partial (unknown serializer)", () => {
  const protoText = readFixture("contracts/order-created.proto");
  const discovery = discoverProtobufContracts("w_drift", "contracts/order-created.proto", protoText);
  const message = discovery.contracts.find((c) => c.name === "causoryn.orders.OrderCreatedEvent");
  const rpc = discovery.contracts.find((c) => c.name === "OrderEvents.OrderCreated");

  it("serializer unknown işaretli aday çifti → unknown sınıflaması + gerekçe; breaking/risk İDDİASI YOK", () => {
    expect(message).toBeDefined();
    const evaluation = evaluateContractPair(message as ContractCandidate, message as ContractCandidate);
    expect(evaluation.classification).toBe("unknown");
    expect(evaluation.changeKind).toBe("unchanged");
    expect(evaluation.findings).toHaveLength(1);
    const finding = evaluation.findings[0] as ContractCompatibilityFinding;
    expect(finding.ruleId).toBe("serializer-unknown");
    expect(finding.classification).toBe("unknown");
    expect(finding.summary).toContain("map<string,string>");
    expect(finding.summary).toContain("serializer unknown");
    expect(finding.evidence).toHaveLength(2);
    // Uydurma karar yok: backward/breaking sınıflaması üretilmez
    expect(
      evaluation.findings.some(
        (entry) => entry.classification === "breaking_candidate" || entry.classification === "risk",
      ),
    ).toBe(false);
  });

  it("aynı dosyadaki bilinen rpc adayı etkilenmez (full çift → no-change-detected backward-safe)", () => {
    expect(rpc).toBeDefined();
    const evaluation = evaluateContractPair(rpc as ContractCandidate, rpc as ContractCandidate);
    expect(evaluation.classification).toBe("backward-safe");
    expect(findingOf(evaluation, "no-change-detected")?.classification).toBe("backward-safe");
  });
});

/* ------------------------------------------------------------------ */
/* TŞ §11 kural 4 — endpoint silme / metot değişimi → breaking_candidate */
/* ------------------------------------------------------------------ */

describe("checkContractCompatibility — endpoint silme / metot değişimi", () => {
  const base: DiscoveryOutput = {
    contracts: [
      makeCandidate({ method: "POST", route: "/orders", qualifiedName: "createOrder", name: "createOrder" }),
      makeCandidate({
        method: "GET",
        route: "/orders/{orderId}",
        qualifiedName: "getOrder",
        name: "getOrder",
        evidence: { relativePath: "openapi.yaml", startLine: 15, endLine: 15 },
      }),
    ],
    diagnostics: [],
  };
  const target: DiscoveryOutput = {
    contracts: [
      makeCandidate({
        method: "PUT",
        route: "/orders",
        qualifiedName: "replaceOrder",
        name: "replaceOrder",
        evidence: { relativePath: "openapi-v2.yaml", startLine: 6, endLine: 6 },
      }),
    ],
    diagnostics: [],
  };
  const report = checkContractCompatibility(base, target);

  it("aynı route'ta method değişimi (POST→PUT) → method-changed breaking_candidate + iki taraf kanıtı", () => {
    const evaluation = report.evaluations.find((entry) => entry.matchKey === "POST /orders");
    expect(evaluation?.classification).toBe("breaking_candidate");
    expect(evaluation?.changeKind).toBe("removed");
    const finding = findingOf(evaluation as ContractPairEvaluation, "method-changed");
    expect(finding?.classification).toBe("breaking_candidate");
    expect(finding?.evidence).toHaveLength(2);
    expect(finding?.evidence[0]?.relativePath).toBe("openapi.yaml");
    expect(finding?.evidence[1]?.relativePath).toBe("openapi-v2.yaml");
  });

  it("tamamen silinen endpoint → removed-endpoint breaking_candidate", () => {
    const evaluation = report.evaluations.find((entry) => entry.matchKey === "GET /orders/{orderId}");
    expect(evaluation?.classification).toBe("breaking_candidate");
    const finding = findingOf(evaluation as ContractPairEvaluation, "removed-endpoint");
    expect(finding?.classification).toBe("breaking_candidate");
    expect(finding?.evidence[0]?.startLine).toBe(15);
  });

  it("target'ta yeni method → added-endpoint backward-safe; rapor toplamı breaking_candidate", () => {
    const evaluation = report.evaluations.find((entry) => entry.matchKey === "PUT /orders");
    expect(evaluation?.changeKind).toBe("added");
    expect(findingOf(evaluation as ContractPairEvaluation, "added-endpoint")?.classification).toBe("backward-safe");
    expect(report.classification).toBe("breaking_candidate");
  });
});

/* ------------------------------------------------------------------ */
/* Saflık / girdi doğrulama                                            */
/* ------------------------------------------------------------------ */

describe("checkContractCompatibility — saflık ve girdi disiplini", () => {
  it("tam fixture setinde iki koşum bit-bit aynı JSON'u üretir (TŞ §8 invariant vi)", () => {
    const files = ["openapi.yaml", "openapi-v2.yaml"].map((relativePath) => ({
      relativePath,
      text: readFixture(relativePath),
    }));
    const base = discoverOpenApiContracts("w_drift", files[0]?.relativePath ?? "", files[0]?.text ?? "");
    const target = discoverOpenApiContracts("w_drift", files[1]?.relativePath ?? "", files[1]?.text ?? "");
    const snapshot = JSON.stringify([base, target]);
    const first = checkContractCompatibility(base, target);
    const second = checkContractCompatibility(base, target);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify([base, target])).toBe(snapshot); // girdi mutasyonu yok
  });

  it("boş girdi → boş değerlendirme; değerlendirilecek sözleşme yokken breaking iddiası üretilmez", () => {
    const empty: DiscoveryOutput = { contracts: [], diagnostics: [] };
    const report = checkContractCompatibility(empty, empty);
    expect(report.evaluations).toHaveLength(0);
    expect(report.classification).toBe("backward-safe");
  });

  it("bozuk girdi → contracts/invalid-input açık reddi", () => {
    expect(() =>
      checkContractCompatibility(
        { contracts: undefined, diagnostics: [] } as unknown as DiscoveryOutput,
        { contracts: [], diagnostics: [] },
      ),
    ).toThrow(ContractDiscoveryError);
    expect(() =>
      checkContractCompatibility(
        { contracts: [], diagnostics: [] },
        { contracts: "x" } as unknown as DiscoveryOutput,
      ),
    ).toThrow(/invalid-input/u);
  });
});
