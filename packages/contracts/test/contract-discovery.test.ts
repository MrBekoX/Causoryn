import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import {
  ContractDiscoveryError,
  discoverContractsFromTexts,
  matchContractEdges,
  readContractFiles,
  scanServiceAnchors,
  type ContractCandidate,
  type ContractFileInput,
  type ServiceAnchor,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi (same-root sınır denetimi)              */
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

/** Sözleşme spec dosyaları (TŞ §11 keşif kaynakları). */
const SPEC_PATHS = [
  "openapi.yaml",
  "openapi-v2.yaml",
  "asyncapi.yaml",
  "db/001_create_orders.sql",
  "db/002_alter_orders.sql",
  "contracts/order-created.proto",
  "schemas/order-created.schema.json",
] as const;

/** Servis ankraj dosyaları (kenar eşleştirmesinin diğer tarafı). */
const SERVICE_PATHS = [
  "src/services/orders-service.ts",
  "src/repositories/order-repository.ts",
  "src/services/billing-service.ts",
] as const;

function readFixtureFiles(relativePaths: readonly string[]): ContractFileInput[] {
  return relativePaths.map((relativePath) => ({
    relativePath,
    text: readFileSync(resolveWithinFixture(relativePath), "utf8"),
  }));
}

function findContract(
  contracts: readonly ContractCandidate[],
  predicate: (c: ContractCandidate) => boolean,
): ContractCandidate {
  const hit = contracts.find(predicate);
  if (hit === undefined) {
    throw new Error("Beklenen sözleşme adayı bulunamadı");
  }
  return hit;
}

describe("fixture-contract-drift — pozitif keşif (backward-safe yüzey)", () => {
  const specs = readFixtureFiles(SPEC_PATHS);
  const discovery = discoverContractsFromTexts("w_fixture_drift", specs);
  const anchors: ServiceAnchor[] = readFixtureFiles(SERVICE_PATHS).flatMap((file) =>
    scanServiceAnchors(file.relativePath, file.text, path.basename(file.relativePath, ".ts")),
  );
  const edges = matchContractEdges(discovery.contracts, anchors);

  it("pozitif: openapi POST /orders → ApiContract adayı; request şeması ve required kanıtı dosya+satırlı", () => {
    const post = findContract(
      discovery.contracts,
      (c) => c.sourceKind === "openapi" && c.method === "POST" && c.route === "/orders" && c.evidence.relativePath === "openapi.yaml",
    );
    expect(post.nodeKind).toBe("ApiContract");
    expect(post.qualifiedName).toBe("createOrder");
    expect(post.requestSchemaId).toBe("CreateOrderInput");
    expect(post.requiredPropertyNames).toEqual(["amount", "currency"]);
    expect(post.responseSchemaIds).toEqual(["Order"]);
    expect(post.evidence).toEqual({ relativePath: "openapi.yaml", startLine: 6, endLine: 6 });
    expect(post.certainty).toBe("full");
  });

  it("pozitif: service route'u openapi path'iyle eşleşir → verified PRODUCES_CONTRACT (basis route)", () => {
    const routeEdges = edges.filter(
      (e) => e.matchBasis === "route" && e.fromSymbol === "orders-service",
    );
    // POST /orders ve GET /orders/:orderId ankrajları; her rota openapi.yaml
    // VE openapi-v2.yaml'de karşılık bulur → 2 method × 2 spec = 4 verified.
    expect(routeEdges).toHaveLength(4);
    expect(routeEdges.every((e) => e.resolution === "verified")).toBe(true);
    const postEdge = routeEdges.find((e) =>
      e.evidence.some(
        (ev) => ev.relativePath === "src/services/orders-service.ts" && ev.startLine === 23,
      ),
    );
    expect(postEdge?.edgeKind).toBe("PRODUCES_CONTRACT");
    expect(postEdge?.evidence.some((ev) => ev.relativePath === "openapi.yaml")).toBe(true);
    // v1 ve v2 sözleşmelerine ayrı ayrı kenar (ayrık contractId)
    expect(
      routeEdges.filter((e) => e.evidence.some((ev) => ev.relativePath === "openapi.yaml")),
    ).toHaveLength(2);
    expect(
      routeEdges.filter((e) => e.evidence.some((ev) => ev.relativePath === "openapi-v2.yaml")),
    ).toHaveLength(2);
  });

  it("pozitif: asyncapi topic'leri → publish verified PRODUCES + subscribe verified CONSUMES (basis topic-id)", () => {
    const produce = edges.find(
      (e) => e.edgeKind === "PRODUCES_CONTRACT" && e.matchBasis === "topic-id",
    );
    expect(produce?.resolution).toBe("verified");
    expect(produce?.evidence.some((ev) => ev.relativePath === "asyncapi.yaml" && ev.startLine === 6)).toBe(true);

    const consume = edges.find(
      (e) => e.edgeKind === "CONSUMES_CONTRACT" && e.matchBasis === "topic-id",
    );
    expect(consume?.resolution).toBe("verified");
    expect(consume?.evidence.some((ev) => ev.relativePath === "asyncapi.yaml" && ev.startLine === 13)).toBe(true);
  });

  it("pozitif: SQL tablosu → repo INSERT INTO verified name-exact; ORDERS büyük harf heuristic", () => {
    const exact = edges.filter((e) => e.matchBasis === "name-exact");
    expect(exact.every((e) => e.resolution === "verified" && e.edgeKind === "CONSUMES_CONTRACT")).toBe(true);
    expect(exact.length).toBeGreaterThanOrEqual(2); // 001 ve 002 sözleşmeleri
    expect(exact.some((e) => e.fromSymbol === "order-repository")).toBe(true);

    const similar = edges.filter((e) => e.matchBasis === "name-similarity");
    expect(similar.length).toBeGreaterThanOrEqual(1);
    expect(similar.every((e) => e.resolution === "heuristic")).toBe(true);
    expect(similar.every((e) => e.fromSymbol === "billing-service")).toBe(true);
  });

  it("pozitif: tüm adaylar kanıtlıdır (dosya + 1 tabanlı satır) ve ID'ler deterministik formdadır", () => {
    for (const contract of discovery.contracts) {
      expect(contract.contractId).toMatch(/^node:[0-9a-f]{64}$/);
      expect(contract.evidence.startLine).toBeGreaterThanOrEqual(1);
      expect(contract.evidence.endLine).toBeGreaterThanOrEqual(contract.evidence.startLine);
    }
    for (const edge of edges) {
      expect(edge.evidence.length).toBeGreaterThanOrEqual(1);
    }
    // verified kenar en az iki taraf kanıtı taşır (ADR-004 Evidence First)
    for (const edge of edges.filter((e) => e.resolution === "verified")) {
      expect(edge.evidence.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("pozitif: JSON Schema sözleşmesi iç $ref'i çözümlenmiş olarak bulunur", () => {
    const schema = findContract(
      discovery.contracts,
      (c) => c.sourceKind === "json-schema",
    );
    expect(schema.name).toBe("https://schemas.causoryn.local/order-created-v1.json");
    expect(schema.requiredPropertyNames).toEqual(["orderId", "amountMinor"]);
    expect(schema.resolvedRefs).toEqual(["#/$defs/Money"]);
  });

  it("pozitif: determinizm — aynı girdi → bit-bit aynı çıktı JSON (TŞ §8 invariant vi)", () => {
    const a = JSON.stringify(discoverContractsFromTexts("w_fixture_drift", specs));
    const b = JSON.stringify(discoverContractsFromTexts("w_fixture_drift", specs));
    expect(a).toBe(b);

    const permuted = discoverContractsFromTexts("w_fixture_drift", [...specs].reverse());
    const edgesPermuted = matchContractEdges(permuted.contracts, [...anchors].reverse());
    expect(JSON.stringify(permuted)).toBe(a);
    expect(JSON.stringify(edgesPermuted)).toBe(JSON.stringify(edges));
  });
});

describe("fixture-contract-drift — negatif senaryolar (açık reddi)", () => {
  it("negatif: policy dışı göreli yol → contracts/file-not-authorized yetki reddi", async () => {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [FIXTURE_ROOT] });
    await expect(
      readContractFiles(FIXTURE_ROOT, policy, ["../fixture-ts-orders/README.md"]),
    ).rejects.toMatchObject({ code: "contracts/file-not-authorized" });
  });

  it("negatif: policy dışı mutlak yol (repo kökü) → contracts/file-not-authorized", async () => {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [FIXTURE_ROOT] });
    await expect(
      readContractFiles(FIXTURE_ROOT, policy, [path.join(REPO_ROOT, "package.json")]),
    ).rejects.toMatchObject({ code: "contracts/file-not-authorized" });
  });

  it("pozitif: policy içi dosyalar salt-okunur okunur (içerik birebir)", async () => {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [FIXTURE_ROOT] });
    const files = await readContractFiles(FIXTURE_ROOT, policy, ["db/001_create_orders.sql"]);
    expect(files).toHaveLength(1);
    expect(files[0]?.relativePath).toBe("db/001_create_orders.sql");
    expect(files[0]?.text).toContain("CREATE TABLE orders");
  });

  it("negatif: bozuk YAML spec'i → contracts/spec-yaml-invalid açık parse reddi", () => {
    const broken: ContractFileInput[] = [
      { relativePath: "openapi.yaml", text: "openapi: 3.1.0\ninfo:\n\ttitle: tab\n" },
    ];
    expect(() => discoverContractsFromTexts("w_fixture_drift", broken)).toThrowError(
      ContractDiscoveryError,
    );
    try {
      discoverContractsFromTexts("w_fixture_drift", broken);
    } catch (err) {
      expect((err as ContractDiscoveryError).code).toBe("contracts/spec-yaml-invalid");
    }
  });

  it("negatif: keşif kotası dışı dosya türü → sözleşme üretmez, diagnostic kaydeder", () => {
    const unknownType: ContractFileInput[] = [
      { relativePath: "assets/logo.png.txt", text: "not a spec" },
    ];
    const out = discoverContractsFromTexts("w_fixture_drift", unknownType);
    expect(out.contracts).toHaveLength(0);
    expect(out.diagnostics.some((d) => d.code === "contracts/unsupported-spec-content")).toBe(
      true,
    );
  });
});

describe("fixture-contract-drift — partial/unknown senaryolar", () => {
  const discovery = discoverContractsFromTexts("w_fixture_drift", readFixtureFiles(SPEC_PATHS));

  it("partial: protobuf map alanı → certainty partial + unknown serializer notu", () => {
    const event = findContract(
      discovery.contracts,
      (c) => c.sourceKind === "protobuf" && c.name === "causoryn.orders.OrderCreatedEvent",
    );
    expect(event.certainty).toBe("partial");
    expect(event.diagnostics.some((d) => /unknown/i.test(d))).toBe(true);
    expect(event.evidence).toEqual({
      relativePath: "contracts/order-created.proto",
      startLine: 8,
      endLine: 13,
    });

    const rpc = findContract(
      discovery.contracts,
      (c) => c.sourceKind === "protobuf" && c.qualifiedName === "OrderEvents.OrderCreated",
    );
    expect(rpc.nodeKind).toBe("ApiContract");
    expect(rpc.requestSchemaId).toBe("causoryn.orders.OrderCreatedEvent");
    expect(rpc.responseSchemaIds).toEqual(["causoryn.orders.OrderCreatedAck"]);
  });

  it("partial: 002 migration → DROP/RENAME diagnostic'lı partial sözleşme (breaking malzemesi keşifte işaretlenir)", () => {
    const altered = findContract(
      discovery.contracts,
      (c) => c.sourceKind === "sql" && c.evidence.relativePath === "db/002_alter_orders.sql",
    );
    expect(altered.certainty).toBe("partial");
    expect(altered.properties).toEqual([{ name: "note", type: "VARCHAR(256)", required: false }]);

    const codes = discovery.diagnostics
      .filter((d) => d.relativePath === "db/002_alter_orders.sql")
      .map((d) => d.code);
    expect(codes).toContain("contracts/sql-drop-column");
    expect(codes).toContain("contracts/sql-rename-column");
  });

  it("pozitif: v1↔v2 openapi her ikisi de keşfedilir (drift malzemesi); keşif yüzeyi compatibility KARARI VERMEZ", () => {
    const postV1 = discovery.contracts.find(
      (c) => c.sourceKind === "openapi" && c.evidence.relativePath === "openapi.yaml" && c.method === "POST",
    );
    const postV2 = discovery.contracts.find(
      (c) => c.sourceKind === "openapi" && c.evidence.relativePath === "openapi-v2.yaml" && c.method === "POST",
    );
    expect(postV1?.requiredPropertyNames).toEqual(["amount", "currency"]);
    expect(postV2?.requiredPropertyNames).toEqual(["amount"]);
    // ayrık node kimlikleri (aynı qualifiedName, farklı kaynak dosya)
    expect(postV1?.contractId).not.toBe(postV2?.contractId);
    // keşif adayı compatibility etiketi TAŞIMAZ — o karar D2/D3 drift araçlarınındır
    expect(JSON.stringify(discovery.contracts)).not.toContain("breaking");
  });

  it("fixture disiplini: v2 malzemesi TŞ §11 semantiğiyle pişirilmiştir — request required→optional backward-safe, Order'dan zorunlu property SİLİNMİŞ (breaking adayı)", () => {
    const [v1Spec, v2Spec] = readFixtureFiles(["openapi.yaml", "openapi-v2.yaml"]);
    if (v1Spec === undefined || v2Spec === undefined) {
      throw new Error("openapi fixture dosyaları okunamadı");
    }
    const pairDiscovery = discoverContractsFromTexts("w_fixture_drift", [v1Spec, v2Spec]);
    const postV2 = pairDiscovery.contracts.find(
      (c) => c.sourceKind === "openapi" && c.evidence.relativePath === "openapi-v2.yaml" && c.method === "POST",
    );
    if (postV2 === undefined) throw new Error("v2 POST /orders adayı bulunamadı");

    // backward-safe malzeme: istek şemasında currency property'si KALIR,
    // yalnızca zorunluluktan çıkar (required→optional; request için backward-safe)
    expect(postV2.properties).toContainEqual({ name: "currency", type: "string", required: false });
    expect(postV2.properties).toContainEqual({ name: "note", type: "string", required: false });

    // breaking_candidate malzemesi (TŞ §11: zorunlu property silinmesi):
    // YANIT şeması Order'dan zorunlu currency property'si tamamen SİLİNMİŞTİR.
    const v2OrderBlock = v2Spec.text.slice(
      v2Spec.text.indexOf("    Order:"),
      v2Spec.text.indexOf("    OrderList:"),
    );
    expect(v2OrderBlock.length).toBeGreaterThan(0);
    // property ANAHTARI olarak currency yok (yorum metni serbest)
    expect(v2OrderBlock).not.toMatch(/^\s+currency:/m);
    const v1OrderBlock = v1Spec.text.slice(v1Spec.text.indexOf("    Order:"));
    expect(v1OrderBlock).toMatch(/^\s+currency:/m);
    expect(v1OrderBlock).toContain("required: [id, amount, currency]");
    expect(v2OrderBlock).toContain("required: [id, amount]");
  });
});
