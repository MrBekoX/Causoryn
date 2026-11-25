import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createEdge,
  createSnapshot,
  evidenceId,
  nodeId,
  type Evidence,
  type GraphNode,
  type SourceSpan,
} from "@causoryn/domain";

import {
  GraphRepositoryError,
  InMemoryGraphRepository,
} from "../src/index.js";

// Paket girişi yüzeyi: generateOnboarding @causoryn/graph'tan erişilebilir
// olmalı; C8 araç kaydı bu export'u kullanır (denetim bulgusu 6).
import { generateOnboarding as indexGenerateOnboarding } from "../src/index.js";

import {
  ONBOARDING_LIMIT_CEILINGS,
  generateOnboarding,
  type LearningStep,
  type OnboardingProfile,
} from "../src/onboarding.js";

/**
 * Report digests produced by the reference implementation (the previous
 * Kahn loop that re-sorted the ready list and used shift() per step),
 * captured before the priority-queue refactor.
 */
const REFERENCE_ONBOARDING_DIGESTS: Record<string, string> = {
  "positive:beginner": "8e3f803134e837cc2d660fd51b9ef02459bde24f6830d274cf388764a669378f",
  "positive:intermediate": "f9dc47b410a6d6a74323bfb07d45e29c048f935c7834b55cde87e03d64eab897",
  "positive:maintainer": "2fea8da00b77027e6fa0c92d5fdc764629de3bec5a11d9dddc617295240ad788",
  "random-1": "f21b9f2bf825599796f00f225c9876347eb070c3bc5f0a4c41ecd400c40bee43",
  "random-2": "897caaa3c523d0b632fbca253a3616c35b141f80f23faf105d5c05cfb5c608f7",
  "random-3": "f2e2ea648eeec49785b09c5b6b9ba2053952a943872a39b67a31e91cc14d1c9c",
};

/**
 * causoryn_generate_onboarding çekirdeği — test üçlüsü (TŞ v2.1 §16; TŞ §8
 * Onboarding Mode çıktı tablosu; sprint-3 C5).
 *
 * Pozitif: üç profilin içerik seti farkları, derece merkeziliği sıralaması
 * ve leksik tie-break, giriş noktası türetimi (endpoint + düşük dereeli
 * yüksek önemli sınıflar), SCC'leri tek adım sayan yapısal öğrenme sırası.
 * Negatif: boş snapshot → boş ama geçerli, serileştirilebilir yapı.
 * Partial: endpoint içermeyen repo → giriş noktası yerine "riskli alanlar"
 * uyarısı + unresolved kenar uçlarından risk alanları.
 *
 * Determinizm: aynı girdi → aynı çıktı JSON (canonicalJson karşılaştırması);
 * saat okunmaz, uyarı/rapor şablonları girdiye bağlıdır.
 */

const WS = "ws_onboarding";
const CREATED_AT = "2026-11-03T09:00:00.000Z";
const PUBLISHED_AT = "2026-11-03T09:05:00.000Z";

function span(relativePath: string, startLine: number, endLine: number): SourceSpan {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}`,
  };
}

function makeNode(
  kind: GraphNode["kind"],
  qualifiedName: string,
  location?: SourceSpan,
): GraphNode {
  return {
    id: nodeId({
      workspaceId: WS,
      kind,
      qualifiedName,
      ...(location === undefined ? {} : { relativePath: location.relativePath }),
    }),
    kind,
    qualifiedName,
    language: "typescript",
    ...(location === undefined ? {} : { location }),
    attributes: {},
  };
}

function makeEvidence(
  evidenceSpan: SourceSpan,
  rationale: string,
): Evidence {
  return {
    id: evidenceId({
      workspaceId: WS,
      kind: "static-analysis",
      span: evidenceSpan,
      analyzerId: "typescript-adapter",
      analyzerVersion: "0.1.0",
      rationale,
    }),
    kind: "static-analysis",
    span: evidenceSpan,
    analyzerId: "typescript-adapter",
    analyzerVersion: "0.1.0",
    rationale,
  };
}

/* ------------------------------------------------------------------ */
/* Pozitif fixture: 6 modül (DEPENDS_ON) + sipariş akışı + test node'u  */
/* ------------------------------------------------------------------ */

/**
 * Modül dereceleri (yalnızca DEPENDS_ON kenarları; başka kenar yok):
 *   shared: 4 (4 gelen) · orders: 3 (3 giden)
 *   billing/auth/notifications: 2'şer (1 gelen + 1 giden; tie → leksik)
 *   tools: 1 (1 giden) → ilk 5 dışında kalır.
 * Beklenen ilk 5: shared, orders, auth, billing, notifications.
 */
function positiveFixtureNodes(): GraphNode[] {
  const module = (name: string): GraphNode =>
    makeNode("Module", name, span(`src/${name}/package.ts`, 1, 1));
  return [
    module("orders"),
    module("billing"),
    module("auth"),
    module("shared"),
    module("notifications"),
    module("tools"),
    makeNode("Endpoint", "POST /orders", span("src/orders/routes.ts", 8, 16)),
    makeNode("Class", "AppBootstrap", span("src/bootstrap/app.ts", 3, 30)),
    makeNode("Class", "CliBootstrap", span("src/bootstrap/cli.ts", 3, 30)),
    makeNode("Class", "OrdersController", span("src/orders/controller.ts", 5, 60)),
    makeNode("Class", "OrdersService", span("src/orders/service.ts", 10, 90)),
    makeNode("Class", "AuditService", span("src/audit/service.ts", 10, 70)),
    makeNode("Class", "OrdersRepository", span("src/orders/repository.ts", 12, 80)),
    makeNode("Test", "orders.service.test", span("src/orders/service.test.ts", 1, 60)),
  ];
}

function positiveFixtureEvidence(): Evidence[] {
  return [
    makeEvidence(
      span("src/orders/routes.ts", 8, 16),
      "Route dekoratörü endpoint'i controller'a bağlar.",
    ),
    makeEvidence(
      span("src/bootstrap/app.ts", 12, 12),
      "Bootstrap'tan controller çağrısı.",
    ),
    makeEvidence(
      span("src/orders/controller.ts", 22, 22),
      "Controller'dan servis çağrısı.",
    ),
    makeEvidence(
      span("src/orders/service.ts", 33, 33),
      "Servisten repository çağrısı.",
    ),
    makeEvidence(
      span("src/orders/service.ts", 41, 41),
      "Servisten denetim servisi çağrısı.",
    ),
    makeEvidence(
      span("src/audit/service.ts", 30, 30),
      "Denetim servisinden servis çağrısı (döngü).",
    ),
    makeEvidence(
      span("src/orders/service.test.ts", 12, 12),
      "Test service'i hedefler.",
    ),
    makeEvidence(
      span("src/orders/package.ts", 1, 1),
      "Modüller arası bağımlılık bildirimi.",
    ),
  ];
}

function positiveFixtureEdges(nodes: readonly GraphNode[]) {
  const byName = new Map(nodes.map((node) => [node.qualifiedName, node]));
  const ref = (name: string): GraphNode => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`fixture node eksik: ${name}`);
    return found;
  };
  const ev = positiveFixtureEvidence();
  const dependsOn = (from: string, to: string) =>
    createEdge({
      workspaceId: WS,
      kind: "DEPENDS_ON",
      from: ref(from).id,
      to: ref(to).id,
      resolution: "verified",
      evidenceIds: [ev[7]!.id],
    });
  const calls = (from: string, to: string, evidenceIndex: number) =>
    createEdge({
      workspaceId: WS,
      kind: "CALLS",
      from: ref(from).id,
      to: ref(to).id,
      resolution: "verified",
      evidenceIds: [ev[evidenceIndex]!.id],
    });
  return [
    dependsOn("orders", "billing"),
    dependsOn("orders", "auth"),
    dependsOn("orders", "notifications"),
    dependsOn("billing", "shared"),
    dependsOn("auth", "shared"),
    dependsOn("notifications", "shared"),
    dependsOn("tools", "shared"),
    createEdge({
      workspaceId: WS,
      kind: "ROUTES_TO",
      from: ref("POST /orders").id,
      to: ref("OrdersController").id,
      resolution: "verified",
      evidenceIds: [ev[0]!.id],
    }),
    calls("AppBootstrap", "OrdersController", 1),
    // Heuristic: bilinmeyen kenar özetini besler; öğrenme sırasına girer.
    createEdge({
      workspaceId: WS,
      kind: "CALLS",
      from: ref("CliBootstrap").id,
      to: ref("OrdersController").id,
      resolution: "heuristic",
      evidenceIds: [],
    }),
    calls("OrdersController", "OrdersService", 2),
    calls("OrdersService", "OrdersRepository", 3),
    calls("OrdersService", "AuditService", 4),
    calls("AuditService", "OrdersService", 5),
    createEdge({
      workspaceId: WS,
      kind: "TESTS",
      from: ref("orders.service.test").id,
      to: ref("OrdersService").id,
      resolution: "verified",
      evidenceIds: [ev[6]!.id],
    }),
  ];
}

function publishPositiveSnapshot(
  insertionOrder: "forward" | "reversed" = "forward",
): ReturnType<InMemoryGraphRepository["publish"]> {
  const repo = new InMemoryGraphRepository();
  repo.registerWorkspace({
    id: WS,
    rootPath: "D:/fixture/onboarding",
    createdAt: CREATED_AT,
  });
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: "rev-onb", sequence: 1 },
    configHash: "cfg:001",
    analyzerFingerprint: "ts-adapter@0.1.0",
    createdAt: CREATED_AT,
  });
  const nodes = positiveFixtureNodes();
  const evidence = positiveFixtureEvidence();
  const edges = positiveFixtureEdges(nodes);
  const reverse = <T>(list: readonly T[]): T[] => [...list].reverse();
  if (insertionOrder === "forward") {
    for (const node of nodes) repo.addNode(build.buildId, node);
    for (const item of evidence) repo.addEvidence(build.buildId, item);
    for (const edge of edges) repo.addEdge(build.buildId, edge);
  } else {
    // Permütasyon koşumu: node/edge dizileri ters sırada, evidence en son
    // (denetim bulgusu 2: "girdi dizilerinin sırasına dayanmaz" iddiasının
    // test kanıtı).
    for (const node of reverse(nodes)) repo.addNode(build.buildId, node);
    for (const edge of reverse(edges)) repo.addEdge(build.buildId, edge);
    for (const item of reverse(evidence)) repo.addEvidence(build.buildId, item);
  }
  return repo.publish(build.buildId, "ready", PUBLISHED_AT);
}

/* ------------------------------------------------------------------ */
/* Partial fixture: endpoint yok + unresolved kenar                     */
/* ------------------------------------------------------------------ */

function publishNoEndpointSnapshot() {
  const repo = new InMemoryGraphRepository();
  repo.registerWorkspace({
    id: WS,
    rootPath: "D:/fixture/onboarding",
    createdAt: CREATED_AT,
  });
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: "rev-noep", sequence: 1 },
    configHash: "cfg:001",
    analyzerFingerprint: "ts-adapter@0.1.0",
    createdAt: CREATED_AT,
  });
  const alpha = makeNode("Class", "Alpha", span("src/alpha.ts", 1, 20));
  const beta = makeNode("Class", "Beta", span("src/beta.ts", 1, 20));
  const gamma = makeNode("Class", "Gamma", span("src/gamma.ts", 1, 20));
  const core = makeNode("Module", "core", span("src/core/package.ts", 1, 1));
  for (const node of [alpha, beta, gamma, core]) repo.addNode(build.buildId, node);
  repo.addEvidence(
    build.buildId,
    makeEvidence(
      span("src/alpha.ts", 9, 9),
      "Alpha'nın Beta çağrısı.",
    ),
  );
  repo.addEdge(
    build.buildId,
    createEdge({
      workspaceId: WS,
      kind: "CALLS",
      from: alpha.id,
      to: beta.id,
      resolution: "verified",
      evidenceIds: [
        evidenceId({
          workspaceId: WS,
          kind: "static-analysis",
          span: span("src/alpha.ts", 9, 9),
          analyzerId: "typescript-adapter",
          analyzerVersion: "0.1.0",
          rationale: "Alpha'nın Beta çağrısı.",
        }),
      ],
    }),
  );
  // Unresolved: hedef çözülemedi → risk alanı; öğrenme sırasına girmez.
  repo.addEdge(
    build.buildId,
    createEdge({
      workspaceId: WS,
      kind: "CALLS",
      from: beta.id,
      to: gamma.id,
      resolution: "unresolved",
      evidenceIds: [],
    }),
  );
  return repo.publish(build.buildId, "partial", PUBLISHED_AT);
}

/* ------------------------------------------------------------------ */
/* Negatif fixture: boş snapshot                                        */
/* ------------------------------------------------------------------ */

function publishEmptySnapshot() {
  const repo = new InMemoryGraphRepository();
  repo.registerWorkspace({
    id: WS,
    rootPath: "D:/fixture/onboarding",
    createdAt: CREATED_AT,
  });
  const build = repo.beginBuild({
    workspaceId: WS,
    revision: { id: "rev-empty", sequence: 1 },
    configHash: "cfg:001",
    analyzerFingerprint: "ts-adapter@0.1.0",
    createdAt: CREATED_AT,
  });
  return repo.publish(build.buildId, "ready", PUBLISHED_AT);
}

/* ------------------------------------------------------------------ */
/* Pozitif                                                              */
/* ------------------------------------------------------------------ */

describe("generateOnboarding — pozitif", () => {
  const snapshot = publishPositiveSnapshot();

  it("üç profil farklı içerik seti döndürür (TŞ §16 içerik listesi)", () => {
    const beginner = generateOnboarding(snapshot, { profile: "beginner" });
    const intermediate = generateOnboarding(snapshot, { profile: "intermediate" });
    const maintainer = generateOnboarding(snapshot, { profile: "maintainer" });

    expect(beginner.profile).toBe("beginner");
    expect(beginner.entryPoints.length).toBeGreaterThan(0);
    expect(beginner.topModules.length).toBe(5);
    expect(beginner.learningOrder.length).toBeGreaterThan(0);
    // Beginner temel set: bilinmeyen kenar/akış/test bölümleri boş kalır.
    expect(beginner.unknownEdges).toEqual([]);
    expect(beginner.criticalFlows).toEqual([]);
    expect(beginner.tests).toEqual([]);

    // Intermediate: bilinmeyen kenarlar açılır, akış/test yok.
    expect(intermediate.unknownEdges.length).toBeGreaterThan(0);
    expect(intermediate.criticalFlows).toEqual([]);
    expect(intermediate.tests).toEqual([]);

    // Maintainer: tam set.
    expect(maintainer.unknownEdges.length).toBeGreaterThan(0);
    expect(maintainer.criticalFlows.length).toBeGreaterThan(0);
    expect(maintainer.tests.length).toBeGreaterThan(0);
  });

  it("ilk 5 modül derece merkeziliğine göre sıralanır; tie-break leksiktir", () => {
    const report = generateOnboarding(snapshot, { profile: "beginner" });

    expect(
      report.topModules.map((module) => module.qualifiedName),
    ).toEqual(["shared", "orders", "auth", "billing", "notifications"]);

    const [shared, orders] = report.topModules;
    expect(shared?.degree).toBe(4);
    expect(shared?.inDegree).toBe(4);
    expect(shared?.outDegree).toBe(0);
    expect(orders?.degree).toBe(3);
    // Derece merkeziliği normalize edilir: degree / (toplam node - 1).
    expect(shared?.centrality).toBeCloseTo(4 / (snapshot.nodes.length - 1), 12);
    // "tools" (derece 1) ilk 5'e girmez.
    expect(
      report.topModules.map((module) => module.qualifiedName),
    ).not.toContain("tools");
  });

  it("limit aşımı: topModuleCount override edilirse kesilir", () => {
    const report = generateOnboarding(snapshot, {
      profile: "beginner",
      limits: { topModuleCount: 2 },
    });
    expect(
      report.topModules.map((module) => module.qualifiedName),
    ).toEqual(["shared", "orders"]);
  });

  it("giriş noktaları: endpoint + düşük dereeli yüksek önemli sınıflar", () => {
    const report = generateOnboarding(snapshot, { profile: "beginner" });

    expect(
      report.entryPoints.map((entry) => entry.qualifiedName),
    ).toEqual(["POST /orders", "AppBootstrap", "CliBootstrap"]);
    expect(report.entryPoints[0]?.reason).toBe("endpoint-node");
    expect(report.entryPoints[1]?.reason).toBe(
      "low-degree-high-importance-class",
    );
    // OrdersController'a ROUTES_TO + CALLS gelir (giriş derecesi > 0) →
    // giriş noktası seçilmez.
    expect(
      report.entryPoints.map((entry) => entry.qualifiedName),
    ).not.toContain("OrdersController");
  });

  it("öğrenme sırası: bağımlılık önce, SCC tek adım, sıra alanı 1-based", () => {
    // Intermediate (tavan 25) tüm adayları kapsar; beginner 10 adımla
    // kesilir (bkz. determinizm bölümü).
    const report = generateOnboarding(snapshot, { profile: "intermediate" });
    const steps = report.learningOrder;
    const nameOf = (step: LearningStep) => step.qualifiedName;
    const indexOf = (name: string) =>
      steps.findIndex((step) => nameOf(step) === name);

    // Sıra alanı 1-based ve artan.
    steps.forEach((step, index) => expect(step.order).toBe(index + 1));

    // Yaprak bağımlılık en önce öğrenilir.
    expect(indexOf("OrdersRepository")).toBe(0);

    // Döngü (OrdersService ↔ AuditService) tek bileşen: aynı componentId,
    // componentSize 2, ardışık iki adım.
    const serviceIndex = indexOf("OrdersService");
    const auditIndex = indexOf("AuditService");
    expect(Math.abs(serviceIndex - auditIndex)).toBe(1);
    expect(steps[serviceIndex]?.componentSize).toBe(2);
    expect(steps[auditIndex]?.componentId).toBe(
      steps[serviceIndex]?.componentId,
    );

    // Bağımlılık yönü: shared, ona bağımlı modüllerden önce; orders en son
    // bağımlılarından sonra; Zincir: OrdersService → OrdersController →
    // endpoint.
    expect(indexOf("shared")).toBeLessThan(indexOf("billing"));
    expect(indexOf("shared")).toBeLessThan(indexOf("auth"));
    expect(indexOf("orders")).toBeGreaterThan(indexOf("billing"));
    expect(indexOf("orders")).toBeGreaterThan(indexOf("auth"));
    expect(indexOf("orders")).toBeGreaterThan(indexOf("notifications"));
    expect(indexOf("OrdersService")).toBeLessThan(indexOf("OrdersController"));
    expect(indexOf("OrdersController")).toBeLessThan(indexOf("POST /orders"));

    // Öğrenme adayları yapısal türlerle sınırlı: Test node'u sıralamada yok.
    expect(indexOf("orders.service.test")).toBe(-1);
    // Tüm Module adayları sıralamada.
    for (const name of ["orders", "billing", "auth", "shared", "notifications", "tools"]) {
      expect(indexOf(name)).toBeGreaterThan(-1);
    }
  });

  it("maintainer: kritik akış ve test bölümleri yapısal olarak döner", () => {
    const report = generateOnboarding(snapshot, { profile: "maintainer" });

    expect(report.criticalFlows).toHaveLength(1);
    const flow = report.criticalFlows[0];
    expect(flow?.entryQualifiedName).toBe("POST /orders");
    expect(flow?.steps.map((step) => step.qualifiedName)).toEqual([
      "OrdersController",
      "OrdersService",
      "AuditService",
    ]);
    expect(flow?.steps.map((step) => step.depth)).toEqual([1, 2, 3]);

    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]?.qualifiedName).toBe("orders.service.test");
    expect(report.tests[0]?.testedQualifiedNames).toEqual(["OrdersService"]);
  });

  it("intermediate/maintainer: bilinmeyen kenarlar çözüm düzeyine göre özetlenir", () => {
    for (const profile of ["intermediate", "maintainer"] as const) {
      const report = generateOnboarding(snapshot, { profile });
      expect(report.unknownEdges).toHaveLength(1);
      const summary = report.unknownEdges[0];
      expect(summary?.resolution).toBe("heuristic");
      expect(summary?.edgeCount).toBe(1);
      // Etkilenen node'lar: kenarın her iki ucu, leksik sıralı.
      expect(summary?.affectedNodes).toEqual([
        "CliBootstrap",
        "OrdersController",
      ]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Negatif                                                              */
/* ------------------------------------------------------------------ */

describe("generateOnboarding — negatif (boş snapshot)", () => {
  it("boş snapshot: tüm bölümler boş ama yapı geçerli ve serileştirilebilir", () => {
    const snapshot = publishEmptySnapshot();
    const report = generateOnboarding(snapshot, { profile: "beginner" });

    expect(report.profile).toBe("beginner");
    expect(report.snapshotId).toBe(snapshot.meta.id);
    expect(report.entryPoints).toEqual([]);
    expect(report.topModules).toEqual([]);
    expect(report.learningOrder).toEqual([]);
    expect(report.criticalFlows).toEqual([]);
    expect(report.tests).toEqual([]);
    expect(report.unknownEdges).toEqual([]);
    expect(report.riskAreas).toEqual([]);
    expect(report.warnings).toEqual([]);

    // JSON'a serileştirilebilir ve deterministik (anahtar sırası kanonik).
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
    expect(canonicalJson(JSON.parse(JSON.stringify(report)))).toContain(snapshot.meta.id);
  });
});

/* ------------------------------------------------------------------ */
/* Partial                                                              */
/* ------------------------------------------------------------------ */

describe("generateOnboarding — partial (endpoint içermeyen repo)", () => {
  it("giriş noktası yerine riskli alanlar uyarısı döner", () => {
    const snapshot = publishNoEndpointSnapshot();
    const report = generateOnboarding(snapshot, { profile: "beginner" });

    // Endpoint yüzeyi olmadığından giriş noktası türetimi yapılmaz:
    // sınıf tabanlı 'giriş noktası' spekülatiftir, uydurulmaz.
    expect(report.entryPoints).toEqual([]);

    const codes = report.warnings.map((warning) => warning.code);
    expect(codes).toContain("onboarding/no-entry-endpoint");
    const warning = report.warnings.find(
      (item) => item.code === "onboarding/no-entry-endpoint",
    );
    expect(warning?.message).toContain("riskAreas");

    // Risk alanları: unresolved kenar uçları, sayı + leksik sıra.
    expect(
      report.riskAreas.map((area) => area.qualifiedName),
    ).toEqual(["Beta", "Gamma"]);
    expect(report.riskAreas[0]?.unresolvedEdgeCount).toBe(1);
    expect(report.riskAreas[0]?.kind).toBe("Class");

    // Unresolved kenar öğrenme sırasına kısıt girmez; verified kısıt girer.
    const indexOf = (name: string) =>
      report.learningOrder.findIndex((step) => step.qualifiedName === name);
    expect(indexOf("Beta")).toBeLessThan(indexOf("Alpha"));
    expect(indexOf("Gamma")).toBeGreaterThan(-1);
    expect(indexOf("core")).toBeGreaterThan(-1);
  });
});

/* ------------------------------------------------------------------ */
/* Determinizm ve sınırlar                                              */
/* ------------------------------------------------------------------ */

describe("generateOnboarding — determinizm", () => {
  const snapshot = publishPositiveSnapshot();

  it("aynı girdi → aynı çıktı JSON (canonical)", () => {
    const first = generateOnboarding(snapshot, { profile: "maintainer" });
    const second = generateOnboarding(snapshot, { profile: "maintainer" });
    expect(canonicalJson(JSON.parse(JSON.stringify(first)))).toBe(
      canonicalJson(JSON.parse(JSON.stringify(second))),
    );
  });

  it("farklı ekleme sırasıyla kurulan aynı içerik → bit-bit aynı çıktı", () => {
    // Denetim bulgusu 2: onboarding.ts "girdi dizilerinin sırasına dayanmaz"
    // iddiasını iki ayrı koşumla kanıtlar; forward/reversed ekleme sırası
    // sonucu değiştirmez (domain kanonik sıralaması + çekirdekte derece
    // toplamları ve leksik sıralamalar).
    const forward = publishPositiveSnapshot("forward");
    const reversed = publishPositiveSnapshot("reversed");
    const reportForward = generateOnboarding(forward, { profile: "maintainer" });
    const reportReversed = generateOnboarding(reversed, { profile: "maintainer" });
    // İçerik aynı olduğundan snapshot ID'leri de aynı türetilir.
    expect(reversed.meta.id).toBe(forward.meta.id);
    expect(canonicalJson(JSON.parse(JSON.stringify(reportReversed)))).toBe(
      canonicalJson(JSON.parse(JSON.stringify(reportForward))),
    );
  });

  it("maxLearningSteps override edilirse kesilir ve uyarı verir", () => {
    const report = generateOnboarding(snapshot, {
      profile: "maintainer",
      limits: { maxLearningSteps: 3 },
    });
    expect(report.learningOrder).toHaveLength(3);
    const codes = report.warnings.map((warning) => warning.code);
    expect(codes).toContain("onboarding/learning-order-truncated");
    // Audit finding 7: the template text must read correctly (English runtime text).
    const warning = report.warnings.find(
      (item) => item.code === "onboarding/learning-order-truncated",
    );
    expect(warning?.message).toContain("clamped to the ceiling");
  });

  it("profil öğrenme adımı tavanları profil başına farklıdır", () => {
    // Pozitif fixture 13 yapısal aday üretir: beginner tavanı (10) keser
    // ve uyarı verir; intermediate (25) ve maintainer (50) kesmez.
    const reports = {
      beginner: generateOnboarding(snapshot, { profile: "beginner" }),
      intermediate: generateOnboarding(snapshot, { profile: "intermediate" }),
      maintainer: generateOnboarding(snapshot, { profile: "maintainer" }),
    };
    expect(reports.beginner.learningOrder).toHaveLength(10);
    expect(reports.intermediate.learningOrder).toHaveLength(13);
    expect(reports.maintainer.learningOrder).toHaveLength(13);
    const beginnerCodes = reports.beginner.warnings.map((w) => w.code);
    expect(beginnerCodes).toContain("onboarding/learning-order-truncated");
    expect(
      reports.intermediate.warnings.map((w) => w.code),
    ).not.toContain("onboarding/learning-order-truncated");
  });
});

/* ------------------------------------------------------------------ */
/* Girdi doğrulama                                                      */
/* ------------------------------------------------------------------ */

describe("generateOnboarding — girdi doğrulama", () => {
  const snapshot = publishPositiveSnapshot();

  function expectError(code: string, action: () => unknown): void {
    try {
      action();
      expect.fail(`GraphRepositoryError bekleniyordu: ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe(code);
    }
  }

  it("paket girişi generateOnboarding'i export eder (denetim bulgusu 6)", () => {
    expect(typeof indexGenerateOnboarding).toBe("function");
    // Export edilen referans çekirdek implementasyonun ta kendisidir.
    expect(indexGenerateOnboarding).toBe(generateOnboarding);
  });

  it("building/failed snapshot reddedilir (denetim bulgusu 1; TŞ §9)", () => {
    // Bellek deposu building snapshot'ı okuma yolunda vermez; saf çekirdek
    // doğrudan çağrılabildiğinden durum koruması çekirdekte de olmalı
    // (kardeş analyzeImpact: graph/impact-snapshot-state, impact.ts:269-276).
    for (const state of ["building", "failed"] as const) {
      const snapshot = createSnapshot({
        workspaceId: WS,
        revision: { id: `rev-${state}`, sequence: 1 },
        configHash: "cfg:001",
        analyzerFingerprint: "ts-adapter@0.1.0",
        state,
        createdAt: CREATED_AT,
        nodes: [],
        edges: [],
        evidence: [],
      });
      expectError("graph/onboarding-snapshot-state", () =>
        generateOnboarding(snapshot, { profile: "beginner" }),
      );
    }
  });

  it("ready/partial snapshot kabul edilir", () => {
    // Partial zaten partial-fixture testiyle kanıtlı; ready pozitif akışta.
    expect(snapshot.meta.state).toBe("ready");
    expect(() =>
      generateOnboarding(snapshot, { profile: "beginner" }),
    ).not.toThrow();
  });

  it("bilinmeyen profil reddedilir", () => {
    expectError("graph/onboarding-invalid-input", () =>
      generateOnboarding(snapshot, {
        profile: "expert" as unknown as OnboardingProfile,
      }),
    );
  });

  it("geçersiz limitler reddedilir", () => {
    expectError("graph/onboarding-invalid-input", () =>
      generateOnboarding(snapshot, {
        profile: "beginner",
        limits: { topModuleCount: 0 },
      }),
    );
    expectError("graph/onboarding-invalid-input", () =>
      generateOnboarding(snapshot, {
        profile: "beginner",
        limits: { maxLearningSteps: 1.5 },
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Limit ceilings + learning-order determinism under the Kahn ordering */
/* ------------------------------------------------------------------ */

/** Seeded PRNG (mulberry32) so generated graphs are identical on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random graph with dependency cycles (SCCs), mixed kinds and resolutions,
 * endpoints and tests, built through createSnapshot (canonical ids).
 */
function randomOnboardingSnapshot(seed: number, nodeCount: number, edgeCount: number) {
  const random = seededRandom(seed);
  const kinds = ["Module", "Class", "Function", "Method", "Endpoint", "Test"] as const;
  const refs = Array.from({ length: nodeCount }, (_, index) => {
    const kind = kinds[Math.floor(random() * kinds.length)] ?? "Module";
    const relativePath = `src/m${String(index % 17)}/file${String(index)}.ts`;
    return { kind, qualifiedName: `pkg.n${String((index * 7919) % nodeCount)}.${kind}`, relativePath };
  });
  const edgeKinds = ["DEPENDS_ON", "IMPORTS", "CALLS", "ROUTES_TO", "TESTS"] as const;
  const resolutions = ["verified", "verified", "heuristic", "unresolved"] as const;
  const seen = new Set<string>();
  const edges = [];
  for (let attempt = 0; attempt < edgeCount * 3 && edges.length < edgeCount; attempt += 1) {
    const from = refs[Math.floor(random() * nodeCount)];
    const to = refs[Math.floor(random() * nodeCount)];
    if (from === undefined || to === undefined || from === to) continue;
    const kind = edgeKinds[Math.floor(random() * edgeKinds.length)] ?? "CALLS";
    const key = `${kind}|${from.qualifiedName}|${to.qualifiedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      kind,
      from,
      to,
      resolution: resolutions[Math.floor(random() * resolutions.length)] ?? "verified",
      evidence: [
        {
          kind: "source" as const,
          analyzerId: "fixture",
          analyzerVersion: "0.0.0",
          rationale: `edge ${key}`,
        },
      ],
    });
  }
  return createSnapshot({
    workspaceId: WS,
    revision: { id: `rev-random-${String(seed)}`, sequence: 1 },
    configHash: "cfg:random",
    analyzerFingerprint: "fixture@0.0.0",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: refs.map((ref) => ({
      kind: ref.kind,
      qualifiedName: ref.qualifiedName,
      relativePath: ref.relativePath,
      language: "typescript",
      location: { relativePath: ref.relativePath, startLine: 1, endLine: 5, sourceHash: `sha256:${ref.qualifiedName}` },
    })),
    edges,
  });
}

function reportDigest(report: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(report))))
    .digest("hex");
}

describe("generateOnboarding — limit ceilings and deterministic learning order", () => {
  const snapshot = publishPositiveSnapshot();

  it("clamps oversized limits to documented ceilings with an onboarding/limit-clamped warning", () => {
    expect(ONBOARDING_LIMIT_CEILINGS).toEqual({
      entryPointLimit: 100,
      topModuleCount: 100,
      maxLearningSteps: 500,
      maxCriticalFlows: 50,
    });
    const big = randomOnboardingSnapshot(7, 900, 1_400);
    const report = generateOnboarding(big, {
      profile: "maintainer",
      limits: {
        entryPointLimit: 1_000_000,
        topModuleCount: 1_000_000,
        maxLearningSteps: 1_000_000,
        maxCriticalFlows: 1_000_000,
      },
    });
    expect(report.learningOrder.length).toBeLessThanOrEqual(ONBOARDING_LIMIT_CEILINGS.maxLearningSteps);
    expect(report.learningOrder.length).toBe(ONBOARDING_LIMIT_CEILINGS.maxLearningSteps);
    expect(report.topModules.length).toBeLessThanOrEqual(ONBOARDING_LIMIT_CEILINGS.topModuleCount);
    expect(report.entryPoints.length).toBeLessThanOrEqual(
      Math.max(ONBOARDING_LIMIT_CEILINGS.entryPointLimit, big.nodes.filter((n) => n.kind === "Endpoint").length),
    );
    expect(report.criticalFlows.length).toBeLessThanOrEqual(ONBOARDING_LIMIT_CEILINGS.maxCriticalFlows);
    const clamped = report.warnings.filter((warning) => warning.code === "onboarding/limit-clamped");
    expect(clamped.map((warning) => warning.message)).toEqual([
      "entryPointLimit=1000000 exceeds the ceiling 100; clamped to 100",
      "topModuleCount=1000000 exceeds the ceiling 100; clamped to 100",
      "maxLearningSteps=1000000 exceeds the ceiling 500; clamped to 500",
      "maxCriticalFlows=1000000 exceeds the ceiling 50; clamped to 50",
    ]);
  });

  it("limits at the ceiling are applied without a clamp warning", () => {
    const report = generateOnboarding(snapshot, {
      profile: "maintainer",
      limits: { ...ONBOARDING_LIMIT_CEILINGS },
    });
    expect(report.warnings.map((warning) => warning.code)).not.toContain("onboarding/limit-clamped");
  });

  it("learning order and the whole report stay byte-identical to the reference outputs (existing and generated fixtures)", () => {
    // Digests captured with the previous sort()+shift() Kahn loop; the
    // priority-queue ordering must reproduce them exactly.
    const profiles: readonly OnboardingProfile[] = ["beginner", "intermediate", "maintainer"];
    const digests: Record<string, string> = {};
    for (const profile of profiles) {
      digests[`positive:${profile}`] = reportDigest(generateOnboarding(snapshot, { profile }));
    }
    for (const seed of [1, 2, 3]) {
      const generated = randomOnboardingSnapshot(seed, 120, 260);
      digests[`random-${String(seed)}`] = reportDigest(
        generateOnboarding(generated, { profile: "maintainer", limits: { maxLearningSteps: 500 } }),
      );
    }
    expect(digests).toEqual(REFERENCE_ONBOARDING_DIGESTS);
  });
});
