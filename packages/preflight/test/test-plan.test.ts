import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  nodeId,
  type SnapshotGraph,
  type SourceSpan,
} from "@causoryn/domain";

import { PreflightError } from "../src/index.js";
import {
  deriveTestPlan,
  TEST_PLAN_DEFAULTS,
  TEST_PLAN_LIMIT_CEILINGS,
  type DeriveTestPlanInput,
  type TestPlanCandidate,
  type TestPlanResult,
} from "../src/test-plan.js";

/**
 * causoryn_derive_test_plan çekirdeği test üçlüleri — sprint-5 D6.
 *
 * Sözleşme kaynakları:
 * - TŞ v2.1 §15 (Sayfa 13, pdftotext çıkarımı) Test Intelligence:
 *   "TESTS edge'leri, test naming/framework bindings, changed call sites,
 *   impacted contracts üzerinden test adayları çıkarılır. Her öneri reason,
 *   evidenceIds, matchLevel, missingCoverageCandidate taşır. 'Bu testler
 *   geçti' ifadesi ancak gerçek test raporu kanıtı varsa gösterilir."
 * - TŞ §3.1 sorumluluk matrisi: "Testleri çalıştırma → Hayır; varsayılan
 *   yalnızca test planı üretir."
 * - TŞ §20 resource budget: sınırlar açıkça raporlanır (impact.ts ile aynı
 *   requireLimit/clamp örüntüsü).
 * - sprint-5.md D6 + çıkış kriteri: pozitif/negatif/partial üçlüsü.
 *
 * Pozitif (backward-safe): TESTS kenarı olan OrdersService → direct aday,
 * evidence'lı; TESTS'siz AuditLogger → missingCoverageCandidate. Negatif:
 * sinyalsiz değişen dosya + bilinmeyen sembol → boş plan + rationale.
 * Partial: yalnızca isimlendirme sinyali → matchLevel="naming", heuristic
 * (düşük güven), evidence'sız.
 *
 * Kırmızı çizgi testi: çıktı asla "geçti/passed/çalıştırıldı" türünden
 * çalıştırma iddiası taşımaz — yalnızca aday + gerekçe vardır.
 */

const WS = "ws_preflight";
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

const SVC = "Orders.Application.OrdersService";
const SVC_PATH = "src/services/OrdersService.ts";
const AUDIT = "Orders.Application.AuditLogger";
const AUDIT_PATH = "src/services/AuditLogger.ts";
const BILLING = "Billing.Services.BillingService";
const BILLING_PATH = "src/services/BillingService.ts";
const CONTROLLER = "Billing.Controllers.BillingController";
const T1 = "OrdersService creates order";
const T1_PATH = "tests/OrdersService.test.ts";
const T2 = "Billing flows end to end";
const T2_PATH = "tests/billing.flows.test.ts";
const NOTES_PATH = "src/reports/Notes.md";
const BILLING_TEST_PATH = "tests/BillingService.test.ts";

function ref(
  kind: Parameters<typeof nodeId>[0]["kind"],
  qualifiedName: string,
  relativePath: string,
): { kind: Parameters<typeof nodeId>[0]["kind"]; qualifiedName: string; relativePath: string } {
  return { kind, qualifiedName, relativePath };
}

/**
 * Test Intelligence fixture'ı:
 * - OrdersService: TESTS kenarı (T1) + kendi üzerinden CALLS (T1) + isim
 *   bağlamı (tests/OrdersService.test.ts) → üç sinyal aynı (test, sembol)
 *   çiftinde birleşir → tek direct aday, kanıt birleşimi.
 * - AuditLogger: hiç TESTS kenarı bilmez → missingCoverageCandidate.
 * - BillingService: T2 → BillingController → BillingService CALLS zinciri
 *   (call-site adayı) + tests/BillingService.test.ts isim bağlamı (naming);
 *   TESTS kenarı yok → aynı zamanda missingCoverageCandidate.
 * - Notes.md: snapshot'ta var ama hiçbir sinyal üretmez (negatif senaryo).
 * - "Orders.Application.OrdersService" adı Class + Function arasında
 *   paylaşılır → tam qualifiedName ile hedefleme belirsizlik üretir.
 */
function buildFixtureSnapshot(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-preflight-fixture",
    analyzerFingerprint: "fp-preflight-fixture",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [
      { kind: "Class", qualifiedName: SVC, relativePath: SVC_PATH },
      { kind: "Class", qualifiedName: AUDIT, relativePath: AUDIT_PATH },
      { kind: "Class", qualifiedName: BILLING, relativePath: BILLING_PATH },
      { kind: "Class", qualifiedName: CONTROLLER, relativePath: "src/controllers/BillingController.ts" },
      {
        kind: "Test",
        qualifiedName: T1,
        relativePath: T1_PATH,
        location: span(T1_PATH, 7, 20),
      },
      {
        kind: "Test",
        qualifiedName: T2,
        relativePath: T2_PATH,
        location: span(T2_PATH, 4, 16),
      },
      { kind: "File", qualifiedName: SVC_PATH, relativePath: SVC_PATH },
      { kind: "File", qualifiedName: AUDIT_PATH, relativePath: AUDIT_PATH },
      { kind: "File", qualifiedName: BILLING_PATH, relativePath: BILLING_PATH },
      { kind: "File", qualifiedName: T1_PATH, relativePath: T1_PATH },
      { kind: "File", qualifiedName: BILLING_TEST_PATH, relativePath: BILLING_TEST_PATH },
      { kind: "File", qualifiedName: NOTES_PATH, relativePath: NOTES_PATH },
      // Belirsizlik fixture'ı: aynı tam qualifiedName, farklı tür/path.
      { kind: "Function", qualifiedName: SVC, relativePath: "src/legacy/orders.ts" },
    ],
    edges: [
      {
        kind: "TESTS",
        from: ref("Test", T1, T1_PATH),
        to: ref("Class", SVC, SVC_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "test-binding",
            span: span(T1_PATH, 7, 7),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "TESTS: test dosyası OrdersService'i import ediyor (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Test", T1, T1_PATH),
        to: ref("Class", SVC, SVC_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span(T1_PATH, 9, 9),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: test gövdesinde OrdersService örneği çağrısı (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Test", T2, T2_PATH),
        to: ref("Class", CONTROLLER, "src/controllers/BillingController.ts"),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span(T2_PATH, 5, 5),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: test gövdesinde BillingController çağrısı (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Class", CONTROLLER, "src/controllers/BillingController.ts"),
        to: ref("Class", BILLING, BILLING_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span("src/controllers/BillingController.ts", 12, 12),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: controller gövdesinde BillingService çağrısı (verified).",
          },
        ],
      },
    ],
  });
}

/** Pozitif girdi: OrdersService (node kimliğiyle) + AuditLogger (node kimliğiyle). */
function positiveInput(): DeriveTestPlanInput {
  return {
    changedSymbols: [nid("Class", SVC, SVC_PATH), nid("Class", AUDIT, AUDIT_PATH)],
  };
}

/** Tüm aday metinlerini tek bir tarama dizgisinde toplar (kırmızı çizgi testi). */
function serializeResult(result: TestPlanResult): string {
  return JSON.stringify(result);
}

describe("deriveTestPlan — pozitif (backward-safe)", () => {
  it("TESTS kenarı olan sembol tek direct aday üretir; kanıt birleşimi taşır", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), positiveInput());

    expect(result.snapshotId).toBe(buildFixtureSnapshot().meta.id);
    expect(result.identifiedSymbols).toHaveLength(2);

    const svcCandidates = result.candidates.filter(
      (candidate) => candidate.changedQualifiedName === SVC,
    );
    expect(svcCandidates).toHaveLength(1);
    const direct = svcCandidates[0] as TestPlanCandidate;
    expect(direct.matchLevel).toBe("direct");
    expect(direct.testKind).toBe("Test");
    expect(direct.testQualifiedName).toBe(T1);
    expect(direct.depth).toBe(1);
    expect(direct.resolution).toBe("verified");
    // Kanıt birleşimi: TESTS kenarı + test gövdesindeki CALLS kenarı.
    expect(direct.evidenceIds).toHaveLength(2);
    expect(direct.evidenceIds).toEqual([...direct.evidenceIds].sort());
    // En güçlü sinyalin kenar referansı (TESTS) taşınır.
    expect(direct.edges).toHaveLength(1);
    expect(direct.edges[0]?.kind).toBe("TESTS");
    expect(direct.reason.length).toBeGreaterThan(0);
    expect(direct.candidateId).toBe("testplan:0001");
    // Direct aday, missingCoverage'a yazılmaz.
    expect(
      result.missingCoverageCandidates.some(
        (missing) => missing.qualifiedName === SVC,
      ),
    ).toBe(false);
  });

  it("TESTS kenarı bilmeyen değişen sembol missingCoverageCandidate olur", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), positiveInput());

    expect(result.missingCoverageCandidates).toHaveLength(1);
    const missing = result.missingCoverageCandidates[0];
    expect(missing?.qualifiedName).toBe(AUDIT);
    expect(missing?.kind).toBe("Class");
    expect(missing?.reason).toContain("TESTS");
  });

  it("CALLS ters taraması test node'una 2 adımda ulaşır → call-site adayı", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [BILLING],
    });

    const callSite = result.candidates.find(
      (candidate) => candidate.matchLevel === "call-site",
    );
    expect(callSite).toBeDefined();
    expect(callSite?.testQualifiedName).toBe(T2);
    expect(callSite?.changedQualifiedName).toBe(BILLING);
    expect(callSite?.depth).toBe(2);
    expect(callSite?.resolution).toBe("verified");
    expect(callSite?.edges).toHaveLength(2);
    expect(callSite?.evidenceIds).toHaveLength(2);
    // BillingService'in TESTS kenarı yoktur → missingCoverage da üretilir.
    expect(
      result.missingCoverageCandidates.some((m) => m.qualifiedName === BILLING),
    ).toBe(true);
  });

  it("isim bağlamı sinyali Test node'unu dosya yolundan çözümler ve direct ile birleşir", () => {
    // Yalnızca TESTS'siz bir isim bağlamı senaryosu ayrı ele alınır (partial);
    // burada direct+naming birleşmesinin tek adayda çözüldüğü doğrulanır.
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [nid("Class", SVC, SVC_PATH)],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.summary.direct).toBe(1);
    expect(result.summary.totalCandidates).toBe(1);
  });

  it("tam qualifiedName ile benzersiz sembol çözümlenir (AuditLogger)", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [AUDIT],
    });
    expect(result.identifiedSymbols).toHaveLength(1);
    expect(result.identifiedSymbols[0]?.qualifiedName).toBe(AUDIT);
    expect(result.unresolvedSymbols).toHaveLength(0);
    expect(result.missingCoverageCandidates).toHaveLength(1);
  });
});

describe("deriveTestPlan — partial (yalnızca naming sinyali)", () => {
  it("değişen dosya için yalnızca isimlendirme bağlamı adayı düşük güvenle üretilir", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedFiles: [BILLING_PATH],
    });

    expect(result.candidates).toHaveLength(1);
    const naming = result.candidates[0] as TestPlanCandidate;
    expect(naming.matchLevel).toBe("naming");
    // İsim benzerliği kanıt değildir: heuristic çözünürlük + boş kenar/kanıt.
    expect(naming.resolution).toBe("heuristic");
    expect(naming.depth).toBe(0);
    expect(naming.edges).toHaveLength(0);
    expect(naming.evidenceIds).toHaveLength(0);
    expect(naming.testQualifiedName).toBe(BILLING_TEST_PATH);
    expect(naming.changedQualifiedName).toBe(BILLING_PATH);
    expect(naming.reason).toContain("naming");
    // Değişen dosya sembol değildir → missingCoverage üretilmez.
    expect(result.missingCoverageCandidates).toHaveLength(0);
    expect(result.summary.naming).toBe(1);
  });
});

describe("deriveTestPlan — negatif (sinyalsiz değişiklik kümesi)", () => {
  it("eşleşen ama sinyalsiz dosya + çözülemeyen sembol → boş plan + rationale", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedFiles: [NOTES_PATH],
      changedSymbols: ["Ghost.MissingSymbol"],
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.missingCoverageCandidates).toHaveLength(0);
    expect(result.identifiedSymbols).toHaveLength(0);
    expect(result.unresolvedSymbols).toHaveLength(1);
    expect(result.unresolvedSymbols[0]?.target).toBe("Ghost.MissingSymbol");
    expect(result.summary.totalCandidates).toBe(0);
    // Boş plan gerekçesi açıkça raporlanır.
    expect(result.rationales.some((r) => r.includes("Ghost.MissingSymbol"))).toBe(true);
    expect(result.rationales.some((r) => r.includes(NOTES_PATH))).toBe(true);
    expect(result.rationales.some((r) => r.includes("boş"))).toBe(true);
  });
});

describe("deriveTestPlan — belirsiz sembol ve doğrulama reddi", () => {
  it("aynı tam qualifiedName iki node ile eşleşirse otomatik kesinleştirme yapılmaz", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [SVC],
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.identifiedSymbols).toHaveLength(0);
    expect(result.unresolvedSymbols).toHaveLength(1);
    const entry = result.unresolvedSymbols[0];
    expect(entry?.target).toBe(SVC);
    expect(entry?.reason).toContain("belirsiz");
    // İki aday node kimliği gerekçede sayılır.
    expect(entry?.reason).toContain(nid("Class", SVC, SVC_PATH));
    expect(entry?.reason).toContain(nid("Function", SVC, "src/legacy/orders.ts"));
  });

  it("building snapshot reddedilir (preflight/snapshot-state)", () => {
    const building = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "building",
      createdAt: CREATED_AT,
      nodes: [{ kind: "File", qualifiedName: NOTES_PATH, relativePath: NOTES_PATH }],
      edges: [],
    });
    expect(() =>
      deriveTestPlan(building, { changedFiles: [NOTES_PATH] }),
    ).toThrow(PreflightError);
    try {
      deriveTestPlan(building, { changedFiles: [NOTES_PATH] });
    } catch (error) {
      expect((error as PreflightError).code).toBe("preflight/snapshot-state");
    }
  });

  it("boş/blank hedef kümesi reddedilir (preflight/invalid-input)", () => {
    const snapshot = buildFixtureSnapshot();
    expect(() => deriveTestPlan(snapshot, {})).toThrow(PreflightError);
    expect(() => deriveTestPlan(snapshot, { changedSymbols: [], changedFiles: [] })).toThrow(
      PreflightError,
    );
    expect(() => deriveTestPlan(snapshot, { changedSymbols: ["   "] })).toThrow(PreflightError);
    try {
      deriveTestPlan(snapshot, {});
    } catch (error) {
      expect((error as PreflightError).code).toBe("preflight/invalid-input");
    }
  });
});

describe("deriveTestPlan — resource budget (TŞ §20)", () => {
  it("tavanlar sabittir ve istek tavan üstiyse gerekçeyle kırpılır", () => {
    expect(TEST_PLAN_LIMIT_CEILINGS).toEqual({ maxDepth: 6, maxCandidates: 50 });
    expect(TEST_PLAN_DEFAULTS).toEqual({ maxDepth: 3, maxCandidates: 20 });

    const snapshot = buildFixtureSnapshot();
    const result = deriveTestPlan(snapshot, {
      changedSymbols: [nid("Class", SVC, SVC_PATH), BILLING],
      maxDepth: 99,
      maxCandidates: 999,
    });
    expect(result.limits).toEqual({ maxDepth: 6, maxCandidates: 50 });
    // Kırpım gerekçesi açıkça raporlanır (TŞ §20).
    expect(result.rationales.some((r) => r.includes("maxDepth"))).toBe(true);
    expect(result.rationales.some((r) => r.includes("maxCandidates"))).toBe(true);
    // Kırpılmış tavanlar altında fixture 3 aday üretir → budget vurulmaz.
    expect(result.truncated).toBe(false);
  });

  it("maxCandidates=1 tek aday tutar ve truncated işaretler", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [nid("Class", SVC, SVC_PATH), BILLING],
      maxCandidates: 1,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxCandidates");
  });

  it("maxDepth=1 derin CALLS zincirini keser; direct aday etkilenmez", () => {
    const result = deriveTestPlan(buildFixtureSnapshot(), {
      changedSymbols: [nid("Class", SVC, SVC_PATH), BILLING],
      maxDepth: 1,
    });
    const callSite = result.candidates.find((c) => c.matchLevel === "call-site");
    // T2'ye giden zincir 2 kenarlıdır; maxDepth=1 ile kesilir → call-site
    // adayı yok, truncation raporlanır.
    expect(callSite?.testQualifiedName).toBeUndefined();
    expect(callSite).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toContain("maxDepth");
    // depth 1 direct aday yaşar.
    expect(result.candidates.some((c) => c.matchLevel === "direct")).toBe(true);
  });

  it("pozitif olmayan limit girdisi reddedilir", () => {
    const snapshot = buildFixtureSnapshot();
    expect(() => deriveTestPlan(snapshot, { changedSymbols: [AUDIT], maxDepth: 0 })).toThrow(
      PreflightError,
    );
    expect(() =>
      deriveTestPlan(snapshot, { changedSymbols: [AUDIT], maxCandidates: -3 }),
    ).toThrow(PreflightError);
  });
});

describe("deriveTestPlan — determinizm ve kırmızı çizgi", () => {
  it("aynı girdi → bit-bit aynı JSON; girdi sırası çıktıyı değiştirmez", () => {
    const snapshot = buildFixtureSnapshot();
    const a = deriveTestPlan(snapshot, positiveInput());
    const b = deriveTestPlan(snapshot, positiveInput());
    expect(serializeResult(a)).toBe(serializeResult(b));

    const shuffled = deriveTestPlan(snapshot, {
      changedSymbols: [...(positiveInput().changedSymbols ?? [])].reverse(),
    });
    expect(serializeResult(shuffled)).toBe(serializeResult(a));
  });

  it("çıktı asla çalıştırma/geçme iddiası taşımaz (yalnızca aday + gerekçe)", () => {
    const snapshot = buildFixtureSnapshot();
    const positive = deriveTestPlan(snapshot, positiveInput());
    const empty = deriveTestPlan(snapshot, { changedFiles: [NOTES_PATH] });
    const forbidden = /passed|geçti|çalıştırıldı|başarılı|was run|executed/i;
    expect(forbidden.test(serializeResult(positive))).toBe(false);
    expect(forbidden.test(serializeResult(empty))).toBe(false);
    // Her aday bir gerekçe taşır ve adaylık alanı matchLevel ile sınırlıdır.
    for (const candidate of positive.candidates) {
      expect(["direct", "naming", "call-site"]).toContain(candidate.matchLevel);
      expect(candidate.reason.length).toBeGreaterThan(0);
    }
  });
});
