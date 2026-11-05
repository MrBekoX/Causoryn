import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  nodeId,
  RESOLUTIONS,
  type SnapshotGraph,
  type SourceSpan,
} from "@causoryn/domain";

import { GraphRepositoryError } from "../src/index.js";
import {
  analyzeImpact,
  IMPACT_LIMIT_CEILINGS,
  type ImpactPath,
  type ImpactResult,
} from "../src/impact.js";

/**
 * causoryn_analyze_impact çekirdeği test üçlüleri — TŞ v2.1 §13 (Sayfa 12)
 * Impact sözleşmesi, §10.2 (Sayfa 10) araç kataloğu, §10.3 (Sayfa 11)
 * certainty örneği, §20 (Sayfa 22) results tavanları, §22 BFS impact testi.
 *
 * Pozitif: OrdersService/OrdersRepository değişiminin ters zinciri
 * endpoint/test yüzeylerine evidence ile çözülür. Negatif: izole sembol
 * boş etki + rationale; tavan üstü zincir truncated; bilinmeyen/belirsiz
 * hedef unresolvedTargets; geçersiz girdi reddi. Partial: unresolved
 * kenar zinciri "possible", heuristic kenar resolution'u ayrı alanda
 * taşır.
 *
 * Kırmızı çizgi testi: çıktı asla "%100 etkilenecek" tarzı mutlak etki
 * iddiası taşımaz; her yol resolution + truncated bayrağı taşır.
 */

const WS = "ws_impact";
const CREATED_AT = "2026-11-05T09:00:00.000Z";

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

const EP = "POST /orders";
const HANDLER = "ordersHandler";
const SVC = "OrdersService";
const REPO = "OrdersRepository";
const TEST = "orders service creates order";
const BILLING = "BillingService";
const BILLING_CLIENT = "BillingClient";
const NOTIFICATION = "NotificationService";
const ISOLATED = "formatDate";

/**
 * POST /orders → ordersHandler → OrdersService → OrdersRepository ana
 * zinciri (TŞ §13 endpoint/test/consumer yüzeyleri) + üç bağımlı:
 * verified TESTS kenarı (test yüzeyi), unresolved çağrı (BillingService),
 * heuristic çağrı (NotificationService). formatDate izole node'dur.
 */
function buildFixtureSnapshot(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-impact-fixture",
    analyzerFingerprint: "fp-impact-fixture",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [
      { kind: "Endpoint", qualifiedName: EP, relativePath: "src/routes/orders.ts" },
      { kind: "Handler", qualifiedName: HANDLER, relativePath: "src/routes/orders.ts" },
      { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
      {
        kind: "Class",
        qualifiedName: REPO,
        relativePath: "src/repositories/OrdersRepository.ts",
      },
      { kind: "Test", qualifiedName: TEST, relativePath: "tests/OrdersService.test.ts" },
      { kind: "Class", qualifiedName: BILLING, relativePath: "src/services/BillingService.ts" },
      {
        kind: "Class",
        qualifiedName: BILLING_CLIENT,
        relativePath: "src/clients/BillingClient.ts",
      },
      {
        kind: "Class",
        qualifiedName: NOTIFICATION,
        relativePath: "src/services/NotificationService.ts",
      },
      { kind: "Function", qualifiedName: ISOLATED, relativePath: "src/utils/date.ts" },
      // Aynı qualifiedName'i taşıyan ikinci node: belirsiz ad çözümleme
      // davranışını test etmek için (node kimliği kind+path ile farklıdır).
      { kind: "Function", qualifiedName: HANDLER, relativePath: "src/legacy/orders.ts" },
    ],
    edges: [
      {
        kind: "CALLS",
        from: { kind: "Handler", qualifiedName: HANDLER, relativePath: "src/routes/orders.ts" },
        to: { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span("src/routes/orders.ts", 18, 22),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: TypeChecker ile OrdersService'e çözümlendi (verified).",
          },
        ],
      },
      {
        kind: "ROUTES_TO",
        from: { kind: "Endpoint", qualifiedName: EP, relativePath: "src/routes/orders.ts" },
        to: { kind: "Handler", qualifiedName: HANDLER, relativePath: "src/routes/orders.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "route-registration",
            span: span("src/routes/orders.ts", 8, 8),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "ROUTES_TO: 'POST /orders' route kaydı handler'a çözümlendi.",
          },
        ],
      },
      {
        kind: "CALLS",
        from: { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
        to: { kind: "Class", qualifiedName: REPO, relativePath: "src/repositories/OrdersRepository.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span("src/services/OrdersService.ts", 31, 31),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: OrdersRepository örneği üzerinden çağrı (verified).",
          },
        ],
      },
      {
        kind: "TESTS",
        from: { kind: "Test", qualifiedName: TEST, relativePath: "tests/OrdersService.test.ts" },
        to: { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "test-binding",
            span: span("tests/OrdersService.test.ts", 7, 7),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "TESTS: test dosyası OrdersService'i import ediyor (verified).",
          },
        ],
      },
      {
        // Kanıtsız unresolved kenar: createEdge sözleşmesinde yalnızca
        // verified kenar kanıt şartır (invariant i).
        kind: "CALLS",
        from: { kind: "Class", qualifiedName: BILLING, relativePath: "src/services/BillingService.ts" },
        to: { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
        resolution: "unresolved",
        ambiguity: {
          candidates: ["OrdersService", "OrdersServiceProxy"],
          reason: "Dinamik çağrı isim benzerliğine dayalı çözümlendi.",
        },
      },
      {
        kind: "CALLS",
        from: {
          kind: "Class",
          qualifiedName: BILLING_CLIENT,
          relativePath: "src/clients/BillingClient.ts",
        },
        to: { kind: "Class", qualifiedName: BILLING, relativePath: "src/services/BillingService.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span("src/clients/BillingClient.ts", 5, 5),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: BillingService.TypeChecker ile çözümlendi (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: {
          kind: "Class",
          qualifiedName: NOTIFICATION,
          relativePath: "src/services/NotificationService.ts",
        },
        to: { kind: "Class", qualifiedName: SVC, relativePath: "src/services/OrdersService.ts" },
        resolution: "heuristic",
        evidence: [
          {
            kind: "name-match",
            span: span("src/services/NotificationService.ts", 12, 12),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: isim benzerliğine dayalı aday eşleşme (heuristic).",
          },
        ],
      },
    ],
  });
}

function edgeRefOf(
  snapshot: SnapshotGraph,
  kind: string,
  fromQualified: string,
  toQualified: string,
): { id: string; resolution: string; evidenceIds: readonly string[] } {
  const found = snapshot.edges.find((edge) => {
    const from = snapshot.nodes.find((node) => node.id === edge.from);
    const to = snapshot.nodes.find((node) => node.id === edge.to);
    return (
      edge.kind === kind &&
      from?.qualifiedName === fromQualified &&
      to?.qualifiedName === toQualified
    );
  });
  expect(found, `fixture edge yok: ${kind} ${fromQualified} -> ${toQualified}`).toBeDefined();
  return {
    id: found!.id,
    resolution: found!.resolution,
    evidenceIds: found!.evidenceIds,
  };
}

function affectedOf(
  result: ImpactResult,
  qualifiedName: string,
): ImpactResult["affectedNodes"][number] {
  const found = result.affectedNodes.find(
    (node) => node.qualifiedName === qualifiedName,
  );
  expect(found, `affected node yok: ${qualifiedName}`).toBeDefined();
  return found!;
}

function pathTo(
  result: ImpactResult,
  qualifiedName: string,
): ImpactPath {
  const found = result.paths.find((path) => path.endpointQualifiedName === qualifiedName);
  expect(found, `path yok: ${qualifiedName}`).toBeDefined();
  return found!;
}

describe("analyzeImpact (sprint-3 C1, TŞ §13 Impact)", () => {
  const snap = buildFixtureSnapshot();

  it("pozitif: OrdersService değişimi ters zincirde endpoint ve test yüzeylerini evidence ile bulur", () => {
    const result = analyzeImpact(snap, { targets: [SVC] });

    expect(result.snapshotId).toBe(snap.meta.id);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toEqual({
      nodeId: nid("Class", SVC, "src/services/OrdersService.ts"),
      kind: "Class",
      qualifiedName: SVC,
    });
    expect(result.unresolvedTargets).toEqual([]);

    // Ters zincir: handler (d1) + test (d1) + billing (d1) + notification
    // (d1) + endpoint (d2) + billingClient (d2).
    expect(result.paths).toHaveLength(6);
    expect(result.affectedNodes).toHaveLength(6);

    const epPath = pathTo(result, EP);
    expect(epPath.depth).toBe(2);
    expect(epPath.certainty).toBe("indirect");
    expect(epPath.resolution).toBe("verified");
    expect(epPath.truncated).toBe(false);
    // Kenarlar hedeften dışa doğru: önce handler→svc CALLS, sonra ep→handler
    // ROUTES_TO (from/to snapshot yönünde aynen taşınır).
    const callsEdge = edgeRefOf(snap, "CALLS", HANDLER, SVC);
    const routesEdge = edgeRefOf(snap, "ROUTES_TO", EP, HANDLER);
    expect(epPath.edges.map((edge) => edge.edgeId)).toEqual([callsEdge.id, routesEdge.id]);
    expect(epPath.edges[0]).toEqual({
      edgeId: callsEdge.id,
      kind: "CALLS",
      from: nid("Handler", HANDLER, "src/routes/orders.ts"),
      to: nid("Class", SVC, "src/services/OrdersService.ts"),
      resolution: "verified",
      evidenceIds: callsEdge.evidenceIds,
    });
    // Yol başına evidence: kenar kanıt birleşimi, tekrarsız + id kanonik sıra.
    expect(epPath.evidenceIds).toEqual(
      [...callsEdge.evidenceIds, ...routesEdge.evidenceIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    // Kanıt referansları snapshot evidence kümesinde gerçekten var.
    const evidenceIds = new Set(snap.evidence.map((item) => item.id));
    for (const id of epPath.evidenceIds) {
      expect(evidenceIds.has(id)).toBe(true);
    }

    const handler = affectedOf(result, HANDLER);
    expect(handler).toMatchObject({ certainty: "direct", resolution: "verified", minDepth: 1 });

    const testNode = affectedOf(result, TEST);
    expect(testNode).toMatchObject({ certainty: "direct", resolution: "verified", minDepth: 1 });

    // Summary matrisi: iki eksen ayrı hücrelerde (TŞ §13 "ayrıdır").
    expect(result.summary.affectedNodes.direct).toEqual({
      verified: 2,
      heuristic: 1,
      unresolved: 0,
    });
    expect(result.summary.affectedNodes.indirect).toEqual({
      verified: 1,
      heuristic: 0,
      unresolved: 0,
    });
    expect(result.summary.affectedNodes.possible).toEqual({
      verified: 0,
      heuristic: 0,
      unresolved: 2,
    });
    expect(result.summary.paths).toEqual({ direct: 3, indirect: 1, possible: 2 });
    expect(result.summary.totalAffectedNodes).toBe(6);
    expect(result.summary.totalPaths).toBe(6);

    // Tavan dışı koşum: kesme yok.
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toEqual([]);
    expect(result.limits).toEqual({ maxDepth: 8, maxPaths: 20, maxNodes: 250 });
  });

  it("pozitif: OrdersRepository hedefinde repository→endpoint zinciri ters sırada çözülür", () => {
    const result = analyzeImpact(snap, { targets: [REPO] });

    const epPath = pathTo(result, EP);
    expect(epPath.depth).toBe(3);
    expect(epPath.certainty).toBe("indirect");
    expect(epPath.resolution).toBe("verified");
    const svcCalls = edgeRefOf(snap, "CALLS", SVC, REPO);
    const handlerCalls = edgeRefOf(snap, "CALLS", HANDLER, SVC);
    const routesEdge = edgeRefOf(snap, "ROUTES_TO", EP, HANDLER);
    expect(epPath.edges.map((edge) => edge.edgeId)).toEqual([
      svcCalls.id,
      handlerCalls.id,
      routesEdge.id,
    ]);
    expect(epPath.evidenceIds).toEqual(
      [...svcCalls.evidenceIds, ...handlerCalls.evidenceIds, ...routesEdge.evidenceIds].sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
    expect(epPath.targetNodeId).toBe(nid("Class", REPO, "src/repositories/OrdersRepository.ts"));

    // Zincir: svc d1, handler/test/billing/notification d2, ep/billingClient d3.
    expect(result.paths).toHaveLength(7);
    expect(result.truncated).toBe(false);
  });

  it("negatif: izole sembol boş etki + rationale döndürür", () => {
    const result = analyzeImpact(snap, { targets: [ISOLATED] });

    expect(result.targets).toHaveLength(1);
    expect(result.paths).toEqual([]);
    expect(result.affectedNodes).toEqual([]);
    expect(result.summary.totalPaths).toBe(0);
    expect(result.summary.totalAffectedNodes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toEqual([]);
    expect(result.rationales.length).toBeGreaterThan(0);
    expect(result.rationales.some((entry) => entry.includes(ISOLATED))).toBe(true);
  });

  it("negatif: tavan üstü zincir truncated=true + truncatedBy=[maxDepth] raporlar", () => {
    const result = analyzeImpact(snap, { targets: [REPO], maxDepth: 2 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toEqual(["maxDepth"]);
    // Derinlik 2'de kesilir: endpoint/billingClient (d3) üretilmez.
    expect(result.paths.every((path) => path.depth <= 2)).toBe(true);
    expect(result.affectedNodes.some((node) => node.qualifiedName === EP)).toBe(false);
    expect(result.affectedNodes.some((node) => node.qualifiedName === BILLING_CLIENT)).toBe(false);
    // Devamı olan ama derinlik tavanına takılan yollar truncated taşır.
    const truncatedPaths = result.paths.filter((path) => path.truncated);
    expect(truncatedPaths.length).toBeGreaterThan(0);
    const handlerPath = pathTo(result, HANDLER);
    expect(handlerPath.truncated).toBe(true);
    // Tavanı aşmayan yolun truncated bayrağı false kalır.
    const svcPath = pathTo(result, SVC);
    expect(svcPath.truncated).toBe(false);
  });

  it("negatif: maxPaths tavanı yol sayısını kırpar", () => {
    const result = analyzeImpact(snap, { targets: [SVC], maxPaths: 3 });

    expect(result.paths).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toEqual(["maxPaths"]);
    expect(result.limits).toEqual({ maxDepth: 8, maxPaths: 3, maxNodes: 250 });
  });

  it("negatif: maxNodes tavanı etki yüzeyini kırpar", () => {
    const result = analyzeImpact(snap, { targets: [SVC], maxNodes: 3 });

    expect(result.affectedNodes.length).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toEqual(["maxNodes"]);
    // Hedefin kendisi asla etkilenen kümesine girmez.
    expect(result.affectedNodes.every((node) => node.qualifiedName !== SVC)).toBe(true);
  });

  it("negatif: istenen tavan config tavanına kırpılır ve rationale düşer", () => {
    const result = analyzeImpact(snap, { targets: [SVC], maxDepth: 99 });

    expect(result.limits.maxDepth).toBe(IMPACT_LIMIT_CEILINGS.maxDepth);
    expect(result.rationales.some((entry) => entry.includes("maxDepth"))).toBe(true);
  });

  it("negatif: bilinmeyen ve belirsiz hedef unresolvedTargets + rationale taşır", () => {
    const unknown = analyzeImpact(snap, { targets: ["GhostService"] });
    expect(unknown.targets).toEqual([]);
    expect(unknown.paths).toEqual([]);
    expect(unknown.unresolvedTargets).toHaveLength(1);
    expect(unknown.unresolvedTargets[0]!.target).toBe("GhostService");
    expect(unknown.rationales.some((entry) => entry.includes("GhostService"))).toBe(true);

    // "ordersHandler" tam adı 2 node'a eşleşir: çekirdek otomatik
    // kesinleştirme yapmaz (TŞ §10.3), adayları rationale ile raporlar.
    const ambiguous = analyzeImpact(snap, { targets: [HANDLER] });
    expect(ambiguous.targets).toEqual([]);
    expect(ambiguous.unresolvedTargets).toHaveLength(1);
    expect(ambiguous.unresolvedTargets[0]!.reason).toContain("2");
  });

  it("negatif: geçersiz girdiler ve sorgulanamaz snapshot reddedilir", () => {
    expect(() => analyzeImpact(snap, { targets: [] })).toThrow(GraphRepositoryError);
    expect(() => analyzeImpact(snap, { targets: ["   "] })).toThrow(GraphRepositoryError);
    expect(() => analyzeImpact(snap, { targets: [SVC], maxDepth: 0 })).toThrow(
      GraphRepositoryError,
    );
    expect(() => analyzeImpact(snap, { targets: [SVC], maxPaths: 1.5 })).toThrow(
      GraphRepositoryError,
    );
    expect(() => analyzeImpact(snap, { targets: [SVC], edgeKinds: ["NOT_A_KIND"] })).toThrow(
      GraphRepositoryError,
    );
    const building: SnapshotGraph = {
      meta: { ...snap.meta, state: "building" },
      nodes: snap.nodes,
      edges: snap.edges,
      evidence: snap.evidence,
    };
    expect(() => analyzeImpact(building, { targets: [SVC] })).toThrow(GraphRepositoryError);
  });

  it("partial: unresolved kenar zinciri 'possible' işaretler, resolution ayrı alanda kalır", () => {
    const result = analyzeImpact(snap, { targets: [SVC] });

    // Doğrudan unresolved bağımlı: certainty possible, resolution unresolved.
    const billing = affectedOf(result, BILLING);
    expect(billing.certainty).toBe("possible");
    expect(billing.resolution).toBe("unresolved");
    const billingPath = pathTo(result, BILLING);
    expect(billingPath.certainty).toBe("possible");
    expect(billingPath.resolution).toBe("unresolved");
    const unresolvedEdge = edgeRefOf(snap, "CALLS", BILLING, SVC);
    expect(billingPath.edges[0]).toEqual({
      edgeId: unresolvedEdge.id,
      kind: "CALLS",
      from: nid("Class", BILLING, "src/services/BillingService.ts"),
      to: nid("Class", SVC, "src/services/OrdersService.ts"),
      resolution: "unresolved",
      evidenceIds: [], // unresolved kenar kanıtsız kalabilir (invariant i)
    });

    // Zincirin en zayıf halkası: unresolved kenar verified kenara bağlanır →
    // yol possible/unresolved; resolution ile certainty HİÇ BİRLEŞMEZ.
    const clientPath = pathTo(result, BILLING_CLIENT);
    expect(clientPath.depth).toBe(2);
    expect(clientPath.certainty).toBe("possible");
    expect(clientPath.resolution).toBe("unresolved");
    const clientEdge = edgeRefOf(snap, "CALLS", BILLING_CLIENT, BILLING);
    expect(clientPath.edges.map((edge) => edge.resolution)).toEqual(["unresolved", "verified"]);
    expect(clientPath.evidenceIds).toEqual(clientEdge.evidenceIds);
  });

  it("partial: heuristic kenar resolution=heuristic taşır, certainty yapısal kalır", () => {
    const result = analyzeImpact(snap, { targets: [SVC] });

    const notification = affectedOf(result, NOTIFICATION);
    expect(notification.certainty).toBe("direct"); // depth 1: yapısal sınıf
    expect(notification.resolution).toBe("heuristic"); // güven düzeyi ayrı alanda
    const notificationPath = pathTo(result, NOTIFICATION);
    expect(notificationPath.certainty).toBe("direct");
    expect(notificationPath.resolution).toBe("heuristic");
    expect(notificationPath.evidenceIds.length).toBeGreaterThan(0);
  });

  it("edgeKinds filtresi ters traversal'a uygulanır (TŞ §10.2)", () => {
    const result = analyzeImpact(snap, { targets: [SVC], edgeKinds: ["CALLS"] });

    expect(result.affectedNodes.some((node) => node.qualifiedName === EP)).toBe(false);
    expect(result.affectedNodes.some((node) => node.qualifiedName === TEST)).toBe(false);
    expect(result.affectedNodes.some((node) => node.qualifiedName === HANDLER)).toBe(true);
    expect(result.affectedNodes.some((node) => node.qualifiedName === BILLING_CLIENT)).toBe(true);
    expect(result.paths.every((path) => path.edges.every((edge) => edge.kind === "CALLS"))).toBe(
      true,
    );
  });

  it("determinizm: iki koşum, karışık girdi sırası ve karışık snapshot sırası bit-bit aynı", () => {
    const input = { targets: [SVC] };
    const r1 = analyzeImpact(snap, input);
    const r2 = analyzeImpact(snap, input);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));

    // Aynı içerik, farklı dizi sırası: saf fonksiyon girdi sırasına
    // bağımlı olmamalıdır (snapshot kanonik düzeni dışında da garanti).
    const reordered: SnapshotGraph = {
      meta: snap.meta,
      nodes: [...snap.nodes].reverse(),
      edges: [...snap.edges].reverse(),
      evidence: [...snap.evidence].reverse(),
    };
    expect(JSON.stringify(analyzeImpact(reordered, input))).toBe(JSON.stringify(r1));

    // Yinelenen hedef girdisi sessizce tekilleşir: aynı çıktı.
    expect(JSON.stringify(analyzeImpact(snap, { targets: [SVC, SVC] }))).toBe(JSON.stringify(r1));
  });

  it("kırmızı çizgi: çıktı mutlak etki iddiası taşımaz, her yol resolution+truncated taşır", () => {
    const result = analyzeImpact(snap, { targets: [REPO] });
    const json = JSON.stringify(result);

    expect(json).not.toContain("%100");
    expect(json).not.toContain("100%");
    expect(json).not.toContain("kesin olarak etkilenecek");

    for (const path of result.paths) {
      expect(RESOLUTIONS).toContain(path.resolution);
      expect(["direct", "indirect", "possible"]).toContain(path.certainty);
      expect(typeof path.truncated).toBe("boolean");
      // resolution ve certainty AYRI alanlardır (TŞ §13 "ayrıdır").
      expect(Object.keys(path)).toContain("resolution");
      expect(Object.keys(path)).toContain("certainty");
    }
    for (const node of result.affectedNodes) {
      expect(RESOLUTIONS).toContain(node.resolution);
      expect(["direct", "indirect", "possible"]).toContain(node.certainty);
    }
    // Sonuç anahtar kümesi sabittir: mutlak iddia taşıyabilecek fazladan
    // alan sızamaz (çıktı şekli sözleşmesi).
    expect(Object.keys(result).sort()).toEqual(
      [
        "affectedNodes",
        "limits",
        "paths",
        "rationales",
        "snapshotId",
        "summary",
        "targets",
        "truncated",
        "truncatedBy",
        "unresolvedTargets",
      ].sort(),
    );
  });
});
