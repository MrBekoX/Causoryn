import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSnapshot,
  nodeId,
  type NodeKind,
  type SnapshotGraph,
  type SourceSpan,
} from "@causoryn/domain";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { PreflightError } from "../src/errors.js";
import {
  buildPreflightManifest,
  PREFLIGHT_MANIFEST_DEFAULTS,
  PREFLIGHT_MANIFEST_LIMITS,
  type FileAuthorizationDecision,
  type PreflightManifestInput,
  type PreflightSourceRevision,
} from "../src/manifest.js";
import { resolveSourceRevision } from "../src/source-revision.js";

/**
 * causoryn_preflight_change manifest çekirdeği test üçlüleri — sprint-5 D4.
 *
 * Sözleşme kaynakları (TŞ v2.1, pdftotext çıkarımı):
 * - §10.2 (Sayfa 10): `causoryn_preflight_change` girdisi "intent,
 *   targetSymbols/files?, baseSnapshot?", çıktı "Preflight Manifest ve risk
 *   adayı".
 * - §10.3 (Sayfa 10-11) örnek manifest gövdesi: preflightId, baseSnapshotId,
 *   intentLabel, identifiedTargets, impactCandidates (id/pathEvidenceIds/
 *   certainty), contractChecks (contractId/status), testPlanId, limitations,
 *   sourceRevision (kind/head/dirty) ve "candidateTargets +
 *   requiresDisambiguation" hükmü: "Eğer hedef sadece doğal dilde verilmiş
 *   ve sembollere kesin bağlanamamışsa candidateTargets ve
 *   requiresDisambiguation sunar, yapay zekâ mantığıyla otomatik
 *   kesinleştirme yapmaz."
 * - §12 (Sayfa 4, özellik 12): "Kod değiştirilmeden önce etki/risk adayları,
 *   gerekli sözleşmeler, test planı ve baseline snapshot içeren Preflight
 *   Manifest."
 * - sprint-5.md D4 + çıkış kriteri: pozitif/negatif/partial üçlüsü.
 *
 * Pozitif: OrdersService hedefli intent → impactCandidates (direct +
 * indirect certainty'lı, pathEvidenceIds'li) + contractChecks (risk →
 * at_risk) + testPlanId dolu manifest. Negatif: belirsiz sembol adı →
 * requiresDisambiguation + aday listesi (otomatik kesinleştirme YOK); izinsiz
 * dosya → preflight/file-not-authorized yetki reddi. Partial: bir hedef
 * çözülür, bir hedef suffix-adayıyla belirsiz kalır, bir dosya snapshot'ta
 * yoktur → karma manifest + limitations.
 *
 * Kırmızı çizgi testi: manifest üretimi sonrası çalışma ağacı BİT-BİT
 * aynıdır (candidate-only sözleşmesi; preflight hiçbir koşulda kod yazmaz).
 */

const execFile = promisify(execFileCallback);

const WS = "ws_preflight_manifest";
const CREATED_AT = "2026-11-08T09:00:00.000Z";

function span(relativePath: string, startLine: number, endLine: number): SourceSpan {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}`,
  };
}

function nid(
  kind: NodeKind,
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
const ORDER_REPO = "Orders.Application.OrderRepository";
const ORDER_REPO_PATH = "src/repositories/OrderRepository.ts";
const BILLING = "Billing.Services.BillingService";
const BILLING_PATH = "src/services/BillingService.ts";
const CONTROLLER = "Billing.Controllers.BillingController";
const CONTROLLER_PATH = "src/controllers/BillingController.ts";
const AUDIT = "Orders.Application.AuditLogger";
const AUDIT_PATH = "src/services/AuditLogger.ts";
const T1 = "OrdersService creates order";
const T1_PATH = "tests/OrdersService.test.ts";
const T2 = "Billing flows end to end";
const T2_PATH = "tests/billing.flows.test.ts";
const NOTES_PATH = "src/reports/Notes.md";
const MISSING_FILE = "src/missing/Nope.ts";

/** D6 çıktısı referansı: deriveTestPlan candidateId uzayıyla aynı biçim. */
const TEST_PLAN_ID = "testplan:0001";

function ref(
  kind: NodeKind,
  qualifiedName: string,
  relativePath: string,
): { kind: NodeKind; qualifiedName: string; relativePath: string } {
  return { kind, qualifiedName, relativePath };
}

/**
 * Manifest fixture'ı (test-plan.test.ts fixture örüntüsüyle aynı aile):
 * - SVC: TESTS (T1) + iki CALLS kökünü alır → ters BFS direct adaylar
 *   (T1, OrderRepository, BillingController) + indirect aday (BillingService,
 *   T2).svc dosyası da File node'u olarak hedeflenebilir.
 * - AuditLogger: izole (ters kenar yok) → etki adayı yok + rationale.
 * - "Orders.Application.OrdersService" adı Class + Function arasında
 *   paylaşılır → tam ad hedeflemesi belirsizlik üretir (TŞ §10.3
 *   requiresDisambiguation fixture'ı).
 */
function buildFixtureSnapshot(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-manifest-1", sequence: 1 },
    configHash: "cfg-manifest-fixture",
    analyzerFingerprint: "fp-manifest-fixture",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [
      { kind: "Class", qualifiedName: SVC, relativePath: SVC_PATH },
      { kind: "Class", qualifiedName: ORDER_REPO, relativePath: ORDER_REPO_PATH },
      { kind: "Class", qualifiedName: BILLING, relativePath: BILLING_PATH },
      { kind: "Class", qualifiedName: CONTROLLER, relativePath: CONTROLLER_PATH },
      { kind: "Class", qualifiedName: AUDIT, relativePath: AUDIT_PATH },
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
      { kind: "File", qualifiedName: ORDER_REPO_PATH, relativePath: ORDER_REPO_PATH },
      { kind: "File", qualifiedName: BILLING_PATH, relativePath: BILLING_PATH },
      { kind: "File", qualifiedName: CONTROLLER_PATH, relativePath: CONTROLLER_PATH },
      { kind: "File", qualifiedName: AUDIT_PATH, relativePath: AUDIT_PATH },
      { kind: "File", qualifiedName: T1_PATH, relativePath: T1_PATH },
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
            rationale: "CALLS: test gövdesinde OrdersService çağrısı (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Class", ORDER_REPO, ORDER_REPO_PATH),
        to: ref("Class", SVC, SVC_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span(ORDER_REPO_PATH, 14, 14),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: repository OrdersService'i çağırıyor (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Class", CONTROLLER, CONTROLLER_PATH),
        to: ref("Class", SVC, SVC_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span(CONTROLLER_PATH, 12, 12),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: controller OrdersService'i çağırıyor (verified).",
          },
        ],
      },
      {
        kind: "CALLS",
        from: ref("Test", T2, T2_PATH),
        to: ref("Class", CONTROLLER, CONTROLLER_PATH),
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
        from: ref("Class", BILLING, BILLING_PATH),
        to: ref("Class", CONTROLLER, CONTROLLER_PATH),
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: span(BILLING_PATH, 21, 21),
            analyzerId: "causoryn/typescript",
            analyzerVersion: "0.1.0",
            rationale: "CALLS: BillingService controller'ı çağırıyor (verified).",
          },
        ],
      },
    ],
  });
}

/** Test düzlemi yetkilendiricisi: her dosyayı izinli sayar (deterministik). */
function allowAllFiles(file: string): FileAuthorizationDecision {
  return { allowed: true, relativePath: file };
}

const WORKING_REVISION: PreflightSourceRevision = {
  kind: "working-tree",
  head: "abc123",
  dirty: false,
};

/** Pozitif girdi: TŞ §10.3 örnek isteğinin fixture karşılığı. */
function positiveInput(): PreflightManifestInput {
  return {
    intent: "POST /orders akışında event payload alanını değiştirme",
    targetSymbols: [nid("Class", SVC, SVC_PATH)],
    targetFiles: [SVC_PATH],
    includeContracts: true,
    includeTestPlan: true,
    contractChecks: [
      { contractId: "evt_order_created", classification: "risk", summary: "opsiyonel alan zorunlu yapıldı" },
    ],
    testPlanId: TEST_PLAN_ID,
    sourceRevision: WORKING_REVISION,
    authorizeFile: allowAllFiles,
  };
}

describe("buildPreflightManifest — pozitif (backward-safe)", () => {
  it("OrdersService hedefli intent → impactCandidates + contractChecks + testPlanId dolu manifest", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, positiveInput());

    // TŞ §10.3 gövdesi: kimlik + bağlama alanları.
    expect(manifest.preflightId).toMatch(/^preflight:[0-9a-f]{64}$/);
    expect(manifest.baseSnapshotId).toBe(snapshot.meta.id);
    expect(manifest.intentLabel).toBe("POST /orders akışında event payload alanını değiştirme");
    expect(manifest.candidateOnly).toBe(true);

    // identifiedTargets: sembol + dosya hedefleri çözümlenmiş.
    const targetIds = manifest.identifiedTargets.map((target) => target.nodeId);
    expect(targetIds).toContain(nid("Class", SVC, SVC_PATH));
    expect(targetIds).toContain(nid("File", SVC_PATH, SVC_PATH));
    const symbolTarget = manifest.identifiedTargets.find(
      (target) => target.nodeId === nid("Class", SVC, SVC_PATH),
    );
    expect(symbolTarget?.origin).toBe("symbol");
    const fileTarget = manifest.identifiedTargets.find(
      (target) => target.nodeId === nid("File", SVC_PATH, SVC_PATH),
    );
    expect(fileTarget?.origin).toBe("file");

    // impactCandidates (packages/graph analyzeImpact yeniden kullanımı):
    // direct (OrderRepository, depth 1) + indirect (BillingService, depth 2).
    const byId = new Map(manifest.impactCandidates.map((candidate) => [candidate.id, candidate]));
    const repoCandidate = byId.get(nid("Class", ORDER_REPO, ORDER_REPO_PATH));
    expect(repoCandidate).toBeDefined();
    expect(repoCandidate?.certainty).toBe("direct");
    expect(repoCandidate?.pathEvidenceIds.length).toBeGreaterThan(0);
    const billingCandidate = byId.get(nid("Class", BILLING, BILLING_PATH));
    expect(billingCandidate?.certainty).toBe("indirect");
    // TŞ §13: "%100 etkilenecek" iddiası yoktur; certainty + resolution ayrıdır.
    for (const candidate of manifest.impactCandidates) {
      expect(["direct", "indirect", "possible"]).toContain(candidate.certainty);
      expect(["verified", "heuristic", "unresolved"]).toContain(candidate.resolution);
    }

    // contractChecks: D2 sınıflaması → TŞ §10.3 status eşlemesi (risk → at_risk).
    expect(manifest.contractChecks).toEqual([
      {
        contractId: "evt_order_created",
        status: "at_risk",
        classification: "risk",
        summary: "opsiyonel alan zorunlu yapıldı",
      },
    ]);

    // testPlanId: D6 çıktısı referansı aynen taşınır.
    expect(manifest.testPlanId).toBe(TEST_PLAN_ID);

    // sourceRevision: git-read salt-okunur HEAD kaydı aynen taşınır.
    expect(manifest.sourceRevision).toEqual(WORKING_REVISION);

    // Belirsizlik yok: tüm hedefler kesin bağlandı.
    expect(manifest.requiresDisambiguation).toBe(false);
    expect(manifest.candidateTargets).toEqual([]);
  });

  it("determinizm: aynı girdi bit-bit aynı JSON'u üretir; girdi sırası çıktıyı değiştirmez", () => {
    const snapshot = buildFixtureSnapshot();
    const first = buildPreflightManifest(snapshot, positiveInput());
    const second = buildPreflightManifest(snapshot, positiveInput());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // Girdi dizi sıraları (symbols/files/checks/limitations) karıştırılır;
    // çekirdek kanonik sıraya indirger → aynı çıktı.
    const shuffled: PreflightManifestInput = {
      ...positiveInput(),
      targetSymbols: [nid("Class", SVC, SVC_PATH), nid("Class", ORDER_REPO, ORDER_REPO_PATH)],
      targetFiles: [SVC_PATH, ORDER_REPO_PATH],
      contractChecks: [
        { contractId: "orders-public-api", classification: "backward-safe" },
        { contractId: "evt_order_created", classification: "breaking_candidate" },
      ],
    };
    const shuffledA = buildPreflightManifest(snapshot, shuffled);
    const shuffledB = buildPreflightManifest(snapshot, {
      ...shuffled,
      targetSymbols: [...(shuffled.targetSymbols ?? [])].reverse(),
      targetFiles: [...(shuffled.targetFiles ?? [])].reverse(),
      contractChecks: [...(shuffled.contractChecks ?? [])].reverse(),
    });
    expect(JSON.stringify(shuffledB)).toBe(JSON.stringify(shuffledA));

    // Farklı girdi → farklı preflightId (kimlik içerik duyarlı).
    expect(shuffledA.preflightId).not.toBe(first.preflightId);
    // Sınıflama eşlemesi: backward-safe → backward_safe, breaking_candidate → at_risk.
    const checks = new Map(shuffledA.contractChecks.map((check) => [check.contractId, check]));
    expect(checks.get("orders-public-api")?.status).toBe("backward_safe");
    expect(checks.get("evt_order_created")?.status).toBe("at_risk");
  });

  it("limit tavanları: maxDisambiguationCandidates isteği tavana kırpılır ve limitation düşer", () => {
    const snapshot = buildFixtureSnapshot();
    const requested = PREFLIGHT_MANIFEST_LIMITS.maxDisambiguationCandidates + 5;
    const manifest = buildPreflightManifest(snapshot, {
      intent: "hedef aday sınırı denemesi",
      targetSymbols: [SVC],
      sourceRevision: WORKING_REVISION,
      maxDisambiguationCandidates: requested,
      authorizeFile: allowAllFiles,
    });
    expect(manifest.limitations.some((note) => note.includes(String(requested)))).toBe(true);
    expect(PREFLIGHT_MANIFEST_DEFAULTS.maxDisambiguationCandidates).toBeGreaterThan(0);
  });

  it("stable-sort tie: aynı contractId+classification, farklı summary → girdi sırası çıktıyı ve preflightId'yi DEĞİŞTİRMEMELİ", () => {
    // Denetim bulgusu (medium): contractChecks karşılaştırıcısı yalnızca
    // (contractId, classification) kıyasladığında summary'si farklı iki kayıt
    // girdi sırasını korur → farklı manifest JSON'u ve farklı preflightId
    // üretilir (TŞ §8 invariant vi delik: girdi dizi sırası çıktıyı
    // değiştirmemeli).
    const snapshot = buildFixtureSnapshot();
    const baseInput = {
      intent: "tie determinizmi",
      targetSymbols: [nid("Class", SVC, SVC_PATH)],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    };
    const checkA = {
      contractId: "evt_order_created",
      classification: "risk" as const,
      summary: "summary-A",
    };
    const checkB = {
      contractId: "evt_order_created",
      classification: "risk" as const,
      summary: "summary-B",
    };
    const first = buildPreflightManifest(snapshot, {
      ...baseInput,
      contractChecks: [checkA, checkB],
    });
    const second = buildPreflightManifest(snapshot, {
      ...baseInput,
      contractChecks: [checkB, checkA],
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Tam eşitlik bozulmazsa kimlik de bozulur: birebir aynı preflightId.
    expect(second.preflightId).toBe(first.preflightId);
    // Her iki kayıt da kaybolmadan, deterministik sırada taşınır.
    expect(first.contractChecks.map((check) => check.summary)).toEqual([
      "summary-A",
      "summary-B",
    ]);
  });
});

describe("buildPreflightManifest — negatif (breaking candidate)", () => {
  it("belirsiz sembol adı → requiresDisambiguation + exact-name aday listesi; otomatik kesinleştirme yok", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "OrdersService payload değişikliği",
      targetSymbols: [SVC],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    });

    expect(manifest.requiresDisambiguation).toBe(true);
    expect(manifest.identifiedTargets).toEqual([]);
    expect(manifest.impactCandidates).toEqual([]);

    expect(manifest.candidateTargets).toHaveLength(1);
    const entry = manifest.candidateTargets[0];
    expect(entry?.target).toBe(SVC);
    expect(entry?.reason).toContain("ambiguous target");
    expect(entry?.candidates).toHaveLength(2);
    expect(entry?.candidates.map((candidate) => candidate.matchBasis)).toEqual([
      "exact-name",
      "exact-name",
    ]);
    // Adaylar Class + Function node'larıdır; ÇÖZÜMLEME yapılmamıştır
    // (TŞ §10.3: otomatik kesinleştirme yok).
    expect(entry?.candidates.map((candidate) => candidate.nodeId).sort()).toEqual(
      [nid("Class", SVC, SVC_PATH), nid("Function", SVC, "src/legacy/orders.ts")].sort(),
    );
  });

  it("izinsiz dosya → preflight/file-not-authorized yetki reddi (fail-closed)", () => {
    const snapshot = buildFixtureSnapshot();
    // Gerçek politika: allowRoots boş → her dosya reddedilir (workspace dilimi).
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [] });
    expect(() =>
      buildPreflightManifest(snapshot, {
        intent: "izinsiz dosya denemesi",
        targetFiles: ["src/services/OrdersService.ts"],
        sourceRevision: WORKING_REVISION,
        authorizeFile: (file) => {
          const decision = policy.checkFile("", file);
          return decision.allowed
            ? { allowed: true, relativePath: decision.relativePath }
            : { allowed: false, code: decision.code, reason: decision.reason };
        },
      }),
    ).toThrowError(PreflightError);
    try {
      buildPreflightManifest(snapshot, {
        intent: "izinsiz dosya denemesi",
        targetFiles: ["src/services/OrdersService.ts"],
        sourceRevision: WORKING_REVISION,
        authorizeFile: (file) => {
          const decision = policy.checkFile("", file);
          return decision.allowed
            ? { allowed: true, relativePath: decision.relativePath }
            : { allowed: false, code: decision.code, reason: decision.reason };
        },
      });
      expect.unreachable("izinsiz dosya manifest üretmemeli");
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightError);
      expect((error as PreflightError).code).toBe("preflight/file-not-authorized");
      expect((error as PreflightError).message).toContain("src/services/OrdersService.ts");
    }
  });

  it("authorizeFile verilmeden hedef dosya istenemez (fail-closed varsayılan)", () => {
    const snapshot = buildFixtureSnapshot();
    expect(() =>
      buildPreflightManifest(snapshot, {
        intent: "yetkilendirici yok",
        targetFiles: [SVC_PATH],
        sourceRevision: WORKING_REVISION,
      }),
    ).toThrowError(PreflightError);
    try {
      buildPreflightManifest(snapshot, {
        intent: "yetkilendirici yok",
        targetFiles: [SVC_PATH],
        sourceRevision: WORKING_REVISION,
      });
      expect.unreachable("authorizeFile'sız dosya hedefi reddedilmeli");
    } catch (error) {
      expect((error as PreflightError).code).toBe("preflight/invalid-input");
    }
  });

  it("unknown sınıflaması status olarak korunur (uydurma sınıflama yok)", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "serializer bilinmiyor",
      targetSymbols: [nid("Class", SVC, SVC_PATH)],
      contractChecks: [
        { contractId: "proto_order_events", classification: "unknown", summary: "serializer unknown" },
      ],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    });
    expect(manifest.contractChecks).toEqual([
      {
        contractId: "proto_order_events",
        status: "unknown",
        classification: "unknown",
        summary: "serializer unknown",
      },
    ]);
  });

  it("geçersiz girdiler açık reddedilir: boş intent / boş hedef kümesi / building snapshot", () => {
    const snapshot = buildFixtureSnapshot();
    expect(() =>
      buildPreflightManifest(snapshot, { intent: "   ", targetSymbols: [SVC] }),
    ).toThrowError(PreflightError);
    expect(() => buildPreflightManifest(snapshot, { intent: "intent", targetSymbols: [] }))
      .toThrowError(PreflightError);
    expect(() =>
      buildPreflightManifest(snapshot, { intent: "intent", sourceRevision: WORKING_REVISION }),
    ).toThrowError(PreflightError);

    const building = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-building", sequence: 2 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "building",
      createdAt: CREATED_AT,
      nodes: [{ kind: "Class", qualifiedName: SVC, relativePath: SVC_PATH }],
      edges: [],
    });
    try {
      buildPreflightManifest(building, {
        intent: "intent",
        targetSymbols: [SVC],
        sourceRevision: WORKING_REVISION,
        authorizeFile: allowAllFiles,
      });
      expect.unreachable("building snapshot sorgulanmamalı");
    } catch (error) {
      expect((error as PreflightError).code).toBe("preflight/snapshot-state");
    }
  });
});

describe("buildPreflightManifest — partial (karma manifest)", () => {
  it("bir hedef çözülür, bir hedef suffix adayıyla belirsiz kalır, bir dosya snapshot'ta yoktur", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "karma hedef kümesi",
      targetSymbols: [nid("Class", SVC, SVC_PATH), "AuditLogger"],
      targetFiles: [NOTES_PATH, MISSING_FILE],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    });

    // Çözülenler manifest'te: SVC sembolü + Notes.md dosyası.
    const targetIds = manifest.identifiedTargets.map((target) => target.nodeId);
    expect(targetIds).toContain(nid("Class", SVC, SVC_PATH));
    expect(targetIds).toContain(nid("File", NOTES_PATH, NOTES_PATH));

    // Çözülemeyen hedef aday listesiyle işaretlenir (suffix-segment eşleşmesi:
    // "AuditLogger" → Orders.Application.AuditLogger; ÇÖZÜMLEME DEĞİL adaylık).
    expect(manifest.requiresDisambiguation).toBe(true);
    expect(manifest.candidateTargets).toHaveLength(1);
    const entry = manifest.candidateTargets[0];
    expect(entry?.target).toBe("AuditLogger");
    expect(entry?.candidates).toEqual([
      {
        nodeId: nid("Class", AUDIT, AUDIT_PATH),
        kind: "Class",
        qualifiedName: AUDIT,
        matchBasis: "suffix-segment",
      },
    ]);

    // Karma: çözülen hedeflerden etki adayları da üretilir.
    expect(manifest.impactCandidates.length).toBeGreaterThan(0);

    // Snapshot'ta olmayan dosya uydurulmaz: limitation düşer.
    expect(
      manifest.limitations.some((note) => note.includes(MISSING_FILE)),
    ).toBe(true);
    // İzole hedef rationale'i limitations'a taşınır (AuditLogger kökü çözülmedi;
    // burada izole notu çıkmaz — ama SVC izole değildir).
    expect(manifest.limitations.length).toBeGreaterThan(0);
  });

  it("hiç adayı bulunamayan hedef: requiresDisambiguation true + boş aday listesi + limitation", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "bilinmeyen sembol",
      targetSymbols: ["TotallyUnknownSymbol"],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    });
    expect(manifest.requiresDisambiguation).toBe(true);
    expect(manifest.candidateTargets).toHaveLength(1);
    expect(manifest.candidateTargets[0]?.candidates).toEqual([]);
    expect(
      manifest.limitations.some((note) => note.includes("TotallyUnknownSymbol")),
    ).toBe(true);
    expect(manifest.identifiedTargets).toEqual([]);
  });

  it("includeContracts=false sözleşme denetimini bırakır; includeTestPlan=true referanssız limitation üretir", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "flag davranışı",
      targetSymbols: [nid("Class", SVC, SVC_PATH)],
      includeContracts: false,
      includeTestPlan: true,
      contractChecks: [{ contractId: "evt_order_created", classification: "risk" }],
      sourceRevision: WORKING_REVISION,
      authorizeFile: allowAllFiles,
    });
    expect(manifest.contractChecks).toEqual([]);
    expect(
      manifest.limitations.some((note) => note.includes("includeContracts")),
    ).toBe(true);
    expect(manifest.testPlanId).toBeUndefined();
    expect(
      manifest.limitations.some((note) => note.includes("testPlanId")),
    ).toBe(true);
  });

  it("sourceRevision verilmezse manifest limitation ile üretilir (git'siz workspace hayatta kalır)", () => {
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "revizyonsuz",
      targetSymbols: [nid("Class", SVC, SVC_PATH)],
      authorizeFile: allowAllFiles,
    });
    expect(manifest.sourceRevision).toBeUndefined();
    expect(
      manifest.limitations.some((note) => note.includes("sourceRevision")),
    ).toBe(true);
  });
});

describe("candidate-only sözleşmesi — manifest üretimi çalışma ağacını DEĞİŞTİRMEZ", { timeout: 60_000 }, () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function git(cwd: string, args: string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
    });
    return result.stdout;
  }

  /** Çalışma ağacı parmak izi: (relativePath, içerik sha256) çiftleri — .git hariç. */
  async function hashWorktree(root: string): Promise<string> {
    const digest = createHash("sha256");
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === ".git") continue;
          await walk(path.join(dir, entry.name), relative);
          continue;
        }
        if (!entry.isFile()) continue;
        const content = await readFile(path.join(dir, entry.name));
        digest.update(relative);
        digest.update(createHash("sha256").update(content).digest("hex"));
      }
    };
    await walk(root, "");
    return digest.digest("hex");
  }

  it("buildPreflightManifest + resolveSourceRevision sonrası ağaç ve git durumu birebir aynı", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-manifest-"));
    createdDirs.push(repoRoot);
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.name", "Causoryn Preflight Test"]);
    await git(repoRoot, ["config", "user.email", "preflight-test@causoryn.invalid"]);
    await git(repoRoot, ["config", "core.autocrlf", "false"]);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "orders.ts"),
      "export function createOrder(): void {}\n",
      "utf8",
    );
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "baseline"]);

    const treeBefore = await hashWorktree(repoRoot);
    const statusBefore = (await git(repoRoot, ["status", "--porcelain"])).trim();

    // Salt-okunur HEAD çözümlemesi + manifest üretimi (candidate-only).
    const resolution = await resolveSourceRevision(repoRoot);
    const snapshot = buildFixtureSnapshot();
    const manifest = buildPreflightManifest(snapshot, {
      intent: "createOrder imzasını genişletme",
      targetSymbols: [nid("Class", SVC, SVC_PATH)],
      targetFiles: [SVC_PATH],
      testPlanId: TEST_PLAN_ID,
      contractChecks: [{ contractId: "evt_order_created", classification: "risk" }],
      ...(resolution.sourceRevision === undefined
        ? {}
        : { sourceRevision: resolution.sourceRevision }),
      authorizeFile: allowAllFiles,
    });
    expect(manifest.preflightId).toMatch(/^preflight:[0-9a-f]{64}$/);
    expect(resolution.sourceRevision?.kind).toBe("working-tree");

    const treeAfter = await hashWorktree(repoRoot);
    const statusAfter = (await git(repoRoot, ["status", "--porcelain"])).trim();
    expect(treeAfter).toBe(treeBefore);
    expect(statusAfter).toBe(statusBefore);
  });
});

describe("resolveSourceRevision — salt-okunur HEAD çözümlemesi", { timeout: 60_000 }, () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function git(cwd: string, args: string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
    });
    return result.stdout;
  }

  it("temiz git deposu: working-tree + 40-hex head; dirty bilinçli olarak üretilmez", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-rev-"));
    createdDirs.push(repoRoot);
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.name", "Causoryn Preflight Test"]);
    await git(repoRoot, ["config", "user.email", "preflight-test@causoryn.invalid"]);
    await git(repoRoot, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repoRoot, "a.ts"), "export const a = 1;\n", "utf8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "baseline", "--allow-empty"]);
    const expectedHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim().toLowerCase();

    const resolution = await resolveSourceRevision(repoRoot);
    expect(resolution.sourceRevision).toEqual({
      kind: "working-tree",
      head: expectedHead,
    });
    // Bilinçli sınır: dirty üretilmez ve bu dürüstçe raporlanır.
    expect(resolution.sourceRevision?.dirty).toBeUndefined();
    expect(resolution.limitations).toHaveLength(1);
    expect(resolution.limitations[0]).toContain("dirty");
  });

  it("aşırı büyük packed-refs kota ile okunmaz ve limitation açıkça raporlanır (TŞ §19)", async () => {
    // Denetim bulgusu (low): packed-refs boyut kotası olmadan tamamen
    // belleğe okunuyordu; güvenilmez repoda planted büyük dosya bellek
    // tüketimi vektörüdür (contracts parse-safety MAX_SPEC_BYTES örüntüsü).
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-rev-"));
    createdDirs.push(repoRoot);
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.name", "Causoryn Preflight Test"]);
    await git(repoRoot, ["config", "user.email", "preflight-test@causoryn.invalid"]);
    await git(repoRoot, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repoRoot, "a.ts"), "export const a = 1;\n", "utf8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "baseline", "--allow-empty"]);

    // Loose ref'i kaldır → çözümleme packed-refs'e düşmek ZORUNDA.
    await rm(path.join(repoRoot, ".git", "refs", "heads", "main"));
    // Planted kota üstü packed-refs (1 MiB üstü dolgu).
    const padding = `# ${"x".repeat(128)}\n`;
    const oversized = padding.repeat(Math.ceil((1024 * 1024 * 1.5) / padding.length));
    await writeFile(path.join(repoRoot, ".git", "packed-refs"), oversized, "utf8");

    const resolution = await resolveSourceRevision(repoRoot);
    // Kota aşımı uydurma SHA ile telafi EDİLMEZ: revizyon çözülemez.
    expect(resolution.sourceRevision).toBeUndefined();
    expect(
      resolution.limitations.some((note) => note.includes("quota")),
    ).toBe(true);
  });

  it("commit edilmemiş dosya head'i değiştirmez; git'siz dizin → sourceRevision yok + limitation", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-rev-"));
    createdDirs.push(repoRoot);
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.name", "Causoryn Preflight Test"]);
    await git(repoRoot, ["config", "user.email", "preflight-test@causoryn.invalid"]);
    await git(repoRoot, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repoRoot, "a.ts"), "export const a = 1;\n", "utf8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "baseline", "--allow-empty"]);
    const headBefore = (await git(repoRoot, ["rev-parse", "HEAD"])).trim().toLowerCase();
    await writeFile(path.join(repoRoot, "b.ts"), "export const b = 2;\n", "utf8");

    const untracked = await resolveSourceRevision(repoRoot);
    // head commit'e bağlıdır; çalışma ağacı kirliği bildirilmez (uydurma yok),
    // bilinçli sınır limitation ile raporlanır.
    expect(untracked.sourceRevision?.head).toBe(headBefore);
    expect(untracked.sourceRevision?.dirty).toBeUndefined();
    expect(untracked.limitations.some((note) => note.includes("dirty"))).toBe(true);

    const plain = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-nogit-"));
    createdDirs.push(plain);
    await writeFile(path.join(plain, "x.ts"), "export const x = 3;\n", "utf8");
    const noGit = await resolveSourceRevision(plain);
    expect(noGit.sourceRevision).toBeUndefined();
    expect(noGit.limitations.length).toBeGreaterThan(0);
  });

  it("CodeQL #35: aşırı büyük .git/HEAD kota ile reddedilir; dizin HEAD çökmez; çoklu parça (>64 KiB) packed-refs çözülür", async () => {
    // 1. Aşırı büyük .git/HEAD (> 1 MiB) → quota limitation + sourceRevision=undefined
    const oversizedHeadRepo = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-head-"));
    createdDirs.push(oversizedHeadRepo);
    await mkdir(path.join(oversizedHeadRepo, ".git"), { recursive: true });
    const oversizedHead = `${"a".repeat(1024 * 1024 + 64)}\n`;
    await writeFile(path.join(oversizedHeadRepo, ".git", "HEAD"), oversizedHead, "utf8");

    const headQuotaRes = await resolveSourceRevision(oversizedHeadRepo);
    expect(headQuotaRes.sourceRevision).toBeUndefined();
    expect(
      headQuotaRes.limitations.some(
        (note) => note.includes(".git/HEAD") && note.includes("exceeds the size quota"),
      ),
    ).toBe(true);

    // 2. .git/HEAD bir dizinse (dosya değil) fırlatmadan undefined + limitation döner
    const dirHeadRepo = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-dirhead-"));
    createdDirs.push(dirHeadRepo);
    await mkdir(path.join(dirHeadRepo, ".git", "HEAD"), { recursive: true });
    const dirHeadRes = await resolveSourceRevision(dirHeadRepo);
    expect(dirHeadRes.sourceRevision).toBeUndefined();
    expect(dirHeadRes.limitations.length).toBeGreaterThan(0);

    // 3. Çoklu 64 KiB parça (> 128 KiB, kota altı) packed-refs tam okunur ve HEAD çözülür
    const multiChunkRepo = await mkdtemp(path.join(os.tmpdir(), "causoryn-preflight-packed-"));
    createdDirs.push(multiChunkRepo);
    await mkdir(path.join(multiChunkRepo, ".git"), { recursive: true });
    await writeFile(
      path.join(multiChunkRepo, ".git", "HEAD"),
      "ref: refs/heads/main\n",
      "utf8",
    );
    const expectedSha = "0123456789abcdef0123456789abcdef01234567";
    const commentBlock = `# ${"c".repeat(120)}\n`.repeat(1500); // ~184 KiB (> 2 × 64 KiB)
    await writeFile(
      path.join(multiChunkRepo, ".git", "packed-refs"),
      `${commentBlock}${expectedSha} refs/heads/main\n`,
      "utf8",
    );
    const multiChunkRes = await resolveSourceRevision(multiChunkRepo);
    expect(multiChunkRes.sourceRevision).toEqual({
      kind: "working-tree",
      head: expectedSha,
    });
  });
});
