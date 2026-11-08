import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  type NodeKind,
  type SnapshotGraph,
  type SnapshotEdgeInput,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import {
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  type ArchitectureBaseline,
  type ArchitecturePolicy,
} from "@causoryn/graph";
import type {
  ContractDriftItem,
  ContractDriftResult,
} from "@causoryn/contracts";
import {
  buildPreflightManifest,
  type PreflightManifest,
} from "@causoryn/preflight";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { VerificationError } from "../src/errors.js";
import {
  NO_FINDINGS_CORE_DISCLAIMER,
  NO_FINDINGS_DISCLAIMER,
  OBSERVED_TEST_RUN_SCHEMA,
  TEST_RUN_STATUS_SCHEMA,
  VERIFY_CHECK_NAMES,
  VERIFY_VERDICT_RULES,
  serializeVerificationReport,
  verifyChange,
  type ObservedTestRun,
  type VerifyCheckName,
  type VerifyTestStatus,
} from "../src/index.js";

/**
 * causoryn_verify_change çekirdek test üçlüsü — sprint-6 E1.
 *
 * Sözleşme kaynakları (TŞ v2.1, PyMuPDF çıkarımı, raw/Causoryn_Teknik_
 * Dokuman_v2.1.pdf):
 * - §10.4 (Sayfa 11) Verify Change örneği: girdi {preflightId,
 *   targetRevision: "working-tree", checks: [architecture, contracts,
 *   graph-diff, test-plan]}; yanıt {baseSnapshotId, targetSnapshotId,
 *   verdict, architectureFindings, contractDrift, tests:{state:
 *   "not_run", recommendedCount, observedCount}, unknowns, evidenceIds}.
 * - §10.4 dürüstlük hükmü: "verdict değerleri no_findings |
 *   review_required | blocking_findings | inconclusive olabilir.
 *   no_findings güvenli/correct kod garantisi değildir. Test runner
 *   varsayılan kurulmaz veya otomatik çalıştırılmaz."
 * - §23 Faz E kapısı: "Before/after reproducibility + no-test-run honesty"
 *   → aynı working-tree + aynı baseSnapshot → byte-deterministik rapor.
 *
 * Pozitif: manifest hedefleri değişmemiş ağaç → dört check evaluated +
 * verdict no_findings + iki bağımsız koşumda byte-deterministik rapor +
 * girdi dizi sırası çıktıyı değiştirmez (TŞ §8 invariant vi). Guard ihlali
 * → blocking_findings; warning bulgusu → review_required.
 * Negatif: bilinmeyen preflightId → verification/preflight-not-found;
 * policy dışı dosya → verification/file-not-authorized (gerçek
 * WorkspaceAccessPolicy); authorizeFile'sız dosya hedefi → invalid-input
 * (fail-closed); bilinmeyen check adı → invalid-input; building snapshot →
 * snapshot-state.
 * Partial: explicit kapsamda çözülemeyen hedef → check partial + unknowns +
 * verdict inconclusive; guard policy yok → architecture not_evaluated +
 * inconclusive; diff'ten türetilen kapsam; observedTestRun kanıtsız →
 * invalid-input (iddia ile başarılı sayılmaz).
 */

/* ------------------------------------------------------------------ */
/* Fixture yardımcıları                                                */
/* ------------------------------------------------------------------ */

const WS = "ws_verify_change";
const CREATED_AT = "2026-11-08T09:00:00.000Z";

const SVC = "App.OrdersService";
const SVC_PATH = "src/OrdersService.ts";
const REPO = "App.OrderRepository";
const REPO_PATH = "src/OrderRepository.ts";
const TEST = "App.OrdersService tests";
const TEST_PATH = "tests/OrdersService.test.ts";
const TEST2 = "App.OrderRepository tests";
const TEST2_PATH = "tests/OrderRepository.test.ts";
const AUDIT = "App.AuditLogger";
const AUDIT_PATH = "src/AuditLogger.ts";

function node(
  kind: NodeKind,
  qualifiedName: string,
  relativePath: string,
  attributes?: Record<string, unknown>,
): SnapshotNodeInput {
  return {
    kind,
    qualifiedName,
    relativePath,
    language: "typescript",
    location: {
      relativePath,
      startLine: 1,
      endLine: 10,
      sourceHash: `sha256:${qualifiedName}`,
    },
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function edge(
  kind: SnapshotEdgeInput["kind"],
  from: { kind: NodeKind; qualifiedName: string; relativePath: string },
  to: { kind: NodeKind; qualifiedName: string; relativePath: string },
  evidenceIds: readonly string[],
): SnapshotEdgeInput {
  return {
    kind,
    from,
    to,
    resolution: "verified",
    evidence: evidenceIds.map((id) => ({
      kind: "source",
      analyzerId: "fixture",
      analyzerVersion: "0.0.0",
      rationale: `fixture kenar kanıtı (${id})`,
    })),
  };
}

function buildSnapshot(nodes: readonly SnapshotNodeInput[], edges: readonly SnapshotEdgeInput[]): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-verify", sequence: 1 },
    configHash: "cfg-verify",
    analyzerFingerprint: "fp-verify",
    state: "ready",
    createdAt: CREATED_AT,
    nodes,
    edges,
  });
}

const SVC_REF = { kind: "Class" as NodeKind, qualifiedName: SVC, relativePath: SVC_PATH };
const REPO_REF = { kind: "Class" as NodeKind, qualifiedName: REPO, relativePath: REPO_PATH };
const TEST_REF = { kind: "Test" as NodeKind, qualifiedName: TEST, relativePath: TEST_PATH };
const TEST2_REF = { kind: "Test" as NodeKind, qualifiedName: TEST2, relativePath: TEST2_PATH };
const AUDIT_REF = { kind: "Class" as NodeKind, qualifiedName: AUDIT, relativePath: AUDIT_PATH };

/** Temiz ağaç: S → R CALLS, T → S TESTS, T2 → R TESTS. Değişiklik yok. */
function cleanTree(): SnapshotGraph {
  return buildSnapshot(
    [
      node("Class", SVC, SVC_PATH),
      node("Class", REPO, REPO_PATH),
      node("Test", TEST, TEST_PATH),
      node("Test", TEST2, TEST2_PATH),
    ],
    [
      edge("CALLS", SVC_REF, REPO_REF, ["ev-svc-repo"]),
      edge("TESTS", TEST_REF, SVC_REF, ["ev-test-svc"]),
      edge("TESTS", TEST2_REF, REPO_REF, ["ev-test2-repo"]),
    ],
  );
}

/** Değişmiş ağaç: R imzası değişti + yeni AuditLogger eklendi (S → N CALLS). */
function modifiedTree(): SnapshotGraph {
  return buildSnapshot(
    [
      node("Class", SVC, SVC_PATH),
      node("Class", REPO, REPO_PATH, { signature: "findAll(page: number): Order[] v2" }),
      node("Test", TEST, TEST_PATH),
      node("Test", TEST2, TEST2_PATH),
      node("Class", AUDIT, AUDIT_PATH),
    ],
    [
      edge("CALLS", SVC_REF, REPO_REF, ["ev-svc-repo"]),
      edge("TESTS", TEST_REF, SVC_REF, ["ev-test-svc"]),
      edge("TESTS", TEST2_REF, REPO_REF, ["ev-test2-repo"]),
      edge("CALLS", SVC_REF, AUDIT_REF, ["ev-svc-audit"]),
    ],
  );
}

/** Guard ihlali ağacı: src'ten tests'e CALLS (yasak bağımlılık). */
function violatingTree(): SnapshotGraph {
  return buildSnapshot(
    [node("Class", SVC, SVC_PATH), node("Test", TEST, TEST_PATH)],
    [edge("CALLS", SVC_REF, TEST_REF, ["ev-svc-test-bad"])],
  );
}

const CLEAN_POLICY: ArchitecturePolicy = parseArchitecturePolicy(
  [
    "version: 1",
    "rules:",
    "  - id: src-must-not-call-tests",
    "    type: forbidden-dependency",
    "    severity: error",
    '    from: "**/src/**"',
    '    to: "**/tests/**"',
    "    edgeKinds: [CALLS]",
    "",
  ].join("\n"),
);

const WARNING_POLICY: ArchitecturePolicy = parseArchitecturePolicy(
  [
    "version: 1",
    "rules:",
    "  - id: src-must-not-call-tests",
    "    type: forbidden-dependency",
    "    severity: warning",
    '    from: "**/src/**"',
    '    to: "**/tests/**"',
    "    edgeKinds: [CALLS]",
    "",
  ].join("\n"),
);

const EMPTY_BASELINE: ArchitectureBaseline = parseArchitectureBaseline(
  "version: 1\nsuppressions: []\n",
);

/** Boş drift sonucu (D3 çıktısının hiçbir şey bulmadığı hâli). */
function emptyDrift(): ContractDriftResult {
  return {
    contractChanges: [],
    breakingCandidates: [],
    risks: [],
    unknowns: [],
    impactedEdges: [],
    unconsumedChanges: [],
    unattachedFindings: [],
    evaluations: [],
    rationale: ["fixture: boş drift"],
  };
}

function driftItem(contractId: string, name: string): ContractDriftItem {
  return {
    matchKey: `event EventContract ${name}`,
    contractId,
    name,
    changeKind: "modified",
    summary: "zorunlu property kaldırıldı (fixture)",
    findings: [
      {
        ruleId: "required-property-removed",
        classification: "breaking_candidate",
        summary: "zorunlu property kaldırıldı (fixture)",
        evidence: [],
      },
    ],
  };
}

/** risk + breaking_candidate karışık drift sonucu (çok üyeli — sıra bağımsızlık için). */
function mixedDrift(): ContractDriftResult {
  return {
    contractChanges: [
      { contractId: "c_order_created_v2", changeKind: "modified", summary: "payload alanı değişti" },
      { contractId: "c_billing_event_v2", changeKind: "modified", summary: "topic payload genişledi" },
    ],
    breakingCandidates: [
      driftItem("c_order_created_v2", "OrderCreated"),
      driftItem("c_order_created_v2b", "OrderCreatedV2"),
    ],
    risks: [
      driftItem("c_billing_event_v2", "BillingEvent"),
      driftItem("c_billing_event_v2b", "BillingEventV2"),
    ],
    unknowns: [],
    impactedEdges: [],
    unconsumedChanges: [],
    unattachedFindings: [],
    evaluations: [],
    rationale: ["fixture: karma drift"],
  };
}

/** Temiz ağaç üzerinden gerçek D4 manifesti (packages/preflight). */
function manifestOf(snapshot: SnapshotGraph): PreflightManifest {
  return buildPreflightManifest(snapshot, {
    intent: "OrdersService davranışını değiştirme",
    targetSymbols: [SVC],
  });
}

/* ------------------------------------------------------------------ */
/* Pozitif                                                             */
/* ------------------------------------------------------------------ */

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makePolicyRoot(): { root: string; policy: WorkspaceAccessPolicy } {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-verify-"));
  createdDirs.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  writeFileSync(path.join(root, "src", "OrdersService.ts"), "export class OrdersService {}\n");
  writeFileSync(path.join(root, "secrets", "key.pem"), "-----BEGIN\n");
  return { root, policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }) };
}

describe("verifyChange — pozitif (değişmemiş manifest hedefleri)", () => {
  const base = cleanTree();
  const target = cleanTree();
  const manifest = manifestOf(base);
  const drift = emptyDrift();

  it("dört check evaluated + verdict no_findings + TŞ §10.4 yanıt gövdesi", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      preflightId: manifest.preflightId,
      resolvePreflight: (id) => (id === manifest.preflightId ? manifest : undefined),
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    });

    expect(report.preflightId).toBe(manifest.preflightId);
    expect(report.baseSnapshotId).toBe(base.meta.id);
    expect(report.targetSnapshotId).toBe(target.meta.id);
    expect(report.targetRevision).toBe("working-tree");
    expect(report.requestedChecks).toEqual([...VERIFY_CHECK_NAMES]);

    expect(report.checks.architecture.status).toBe("evaluated");
    expect(report.checks.contracts.status).toBe("evaluated");
    expect(report.checks.graphDiff.status).toBe("evaluated");
    expect(report.checks.testPlan.status).toBe("evaluated");

    // Değişiklik yok: guard bulgusu yok, drift yok, diff boş.
    expect(report.checks.architecture.findings).toHaveLength(0);
    expect(report.checks.contracts.drift).toHaveLength(0);
    expect(report.checks.graphDiff.diffSummary.added).toBe(0);
    expect(report.checks.graphDiff.diffSummary.removed).toBe(0);
    expect(report.checks.graphDiff.diffSummary.changed).toBe(0);

    // checks dolu: manifest hedefi (SVC) TESTS kenarıyla kapsandığından
    // test planı adayları türetilir; ancak durum daima not_run (test
    // koşucusu YOK — TŞ §10.4/§15).
    expect(report.checks.testPlan.recommendedCount).toBeGreaterThanOrEqual(1);
    expect(report.checks.testPlan.run.state).toBe("not_run");
    expect(report.tests.state).toBe("not_run");
    expect(report.tests.recommendedCount).toBeGreaterThanOrEqual(1);
    expect(report.tests.observedCount).toBe(0);

    expect(report.verdict).toBe("no_findings");
    expect(report.verdictNote).toBe(NO_FINDINGS_DISCLAIMER);
    expect(report.unknowns).toEqual([]);
    expect(report.evidenceIds.length).toBeGreaterThanOrEqual(1);

    // preflight hedefi diff'te gözlenmedi (hiçbir şey değişmedi) — bu bir
    // kısıt notudur; inconclusive DEĞİLDİR (değişiklik yokluğu beklenendir).
    expect(report.preflightAlignment).toBeDefined();
    expect(report.preflightAlignment?.targets[0]?.observedInDiff).toBe(false);
    expect(report.limitations.length).toBeGreaterThanOrEqual(1);
  });

  it("TŞ §10.4 alan sadakati: üst düzey architectureFindings + tests.state taşınır (findings/tests.status sapması yok)", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      preflightId: manifest.preflightId,
      resolvePreflight: (id) => (id === manifest.preflightId ? manifest : undefined),
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    });
    // TŞ §10.4 örnek yanıt (PDF s.11): üst düzey bulgu alanı
    // "architectureFindings", koşum bloğu {"state": "not_run", ...} — alan
    // adları bire bir taşınır (sprint-6 takım denetimi bulgusu: findings/
    // tests.status sapması önceki sprintlerin alan-sadakat pratiğini
    // ihlal ediyordu; identifiedTargets/impactCandidates örüntüsü).
    expect("architectureFindings" in report).toBe(true);
    expect("findings" in report).toBe(false);
    expect("state" in report.tests).toBe(true);
    expect("status" in report.tests).toBe(false);
    expect(report.tests.state).toBe("not_run");
    expect(report.checks.testPlan.run.state).toBe("not_run");
    // Koşum bloğu TŞ alanlarıyla tam kapanır: state/recommendedCount/
    // observedCount dışında alan yoktur (not_run dalı).
    expect(Object.keys(report.tests).sort()).toEqual([
      "observedCount",
      "recommendedCount",
      "state",
    ]);
  });

  it("TŞ §10.4 alan sadakati (serialize yüzeyi): reportId gövdesi ve serializeVerificationReport çıktısı üst düzey architectureFindings taşır", () => {
    // Sprint-6 takım denetimi 2. tur bulgusu: reportBodyJsonValue içindeki
    // üst düzey JSON anahtarı eski `findings` olarak kalmıştı (özellik
    // erişimi yeni adla, anahtar eski) — bu gövde hem reportId karmasının
    // hem serializeVerificationReport çıktısının kaynağıdır; nesne düzeyi
    // hizalama yalnızca rapor OBJESİNİ kapsıyordu, serialize yüzeyini
    // DEĞİL. Bu test serialize çıktısının üst düzey anahtarlarını kilitler.
    const serialized = serializeVerificationReport(
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: target,
        preflightId: manifest.preflightId,
        resolvePreflight: (id) => (id === manifest.preflightId ? manifest : undefined),
        guardPolicy: CLEAN_POLICY,
        guardBaseline: EMPTY_BASELINE,
        contractDrift: drift,
      }),
    );
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect("architectureFindings" in parsed).toBe(true);
    expect("findings" in parsed).toBe(false);
    // Serialize gövdesindeki koşum bloğu da TŞ ayırıcısıyla (`state`)
    // taşınır; eski `status` anahtarı koşum bloğunda yoktur.
    expect("state" in (parsed.tests as object)).toBe(true);
    expect("status" in (parsed.tests as object)).toBe(false);
    // reportId, bu gövdenin canonical JSON SHA-256 karmasıdır: gövde anahtarı
    // değiştiğinde kimlik de content-addressed olarak değişir (sabit değer
    // beklenmez; biçim sözleşmesi test edilir).
    expect(parsed.reportId).toMatch(/^verification:[0-9a-f]{64}$/);
  });

  it("sprint kapısı: aynı girdi ile iki koşum byte-deterministik", () => {
    // Sprint-6 takım denetimi 2. tur bulgusu: run2'nin girdisi eski hâlde
    // base/target TAKASLIYDI (base ve target ikisi de cleanTree() olduğundan
    // içerik/kimlik eşit → takas nötrleşip test yine yeşile koşuyordu, ancak
    // 'aynı girdi' sözüyle farklı referanslar karşılaştırılıyordu). Kapı
    // sözleşmesi TŞ Faz E: AYNI working-tree + AYNI baseSnapshot → bit-bit
    // aynı rapor; run2 girdisi run1 ile BİRE BİR aynıdır. Gerçek (diff'li)
    // determinizm kanıtı paralel olarak faz-e MCP testindedir
    // (faz-e-verify-change.test.ts: değişiklik sonrası verify×2).
    const gateInput = {
      baseSnapshot: base,
      targetSnapshot: target,
      preflightId: manifest.preflightId,
      resolvePreflight: (id: string) =>
        id === manifest.preflightId ? manifest : undefined,
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    };
    const run1 = serializeVerificationReport(verifyChange(gateInput));
    const run2 = serializeVerificationReport(verifyChange(gateInput));
    expect(run2).toBe(run1);
    expect(run1).toBe(canonicalJson(JSON.parse(run1)));
    // Rapor saat damgası taşımaz: snapshot createdAt yalnızca kimlik
    // karmasına girer; rapor gövdesinde ISO zaman alanı yoktur.
    expect(run1).not.toContain('"createdAt"');
    expect(run1).not.toContain(CREATED_AT);
  });

  it("girdi dizi sırası çıktıyı değiştirmez (TŞ §8 invariant vi)", () => {
    const drift = mixedDrift();
    const ordered = serializeVerificationReport(
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: target,
        checks: ["architecture", "contracts", "graph-diff", "test-plan"],
        guardPolicy: CLEAN_POLICY,
        guardBaseline: EMPTY_BASELINE,
        contractDrift: drift,
      }),
    );
    const shuffled = serializeVerificationReport(
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: target,
        checks: ["test-plan", "graph-diff", "contracts", "architecture"],
        guardPolicy: CLEAN_POLICY,
        guardBaseline: EMPTY_BASELINE,
        contractDrift: {
          ...drift,
          contractChanges: [...drift.contractChanges].reverse(),
          breakingCandidates: [...drift.breakingCandidates].reverse(),
          risks: [...drift.risks].reverse(),
        },
      }),
    );
    expect(shuffled).toBe(ordered);
  });

  it("guard ihlali → blocking_findings (unsuppressed error bulgusu)", () => {
    const report = verifyChange({
      baseSnapshot: cleanTree(),
      targetSnapshot: violatingTree(),
      checks: ["architecture", "graph-diff"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
    });
    expect(report.checks.architecture.status).toBe("evaluated");
    expect(report.checks.architecture.findings).toHaveLength(1);
    expect(report.checks.architecture.findings[0]?.severity).toBe("error");
    expect(report.checks.architecture.findings[0]?.suppressed).toBe(false);
    expect(report.checks.architecture.findings[0]?.snapshotId).toBe(
      report.targetSnapshotId,
    );
    expect(report.architectureFindings).toHaveLength(1);
    expect(report.verdict).toBe("blocking_findings");
  });

  it("yalnızca warning bulgusu → review_required", () => {
    const report = verifyChange({
      baseSnapshot: cleanTree(),
      targetSnapshot: violatingTree(),
      checks: ["architecture", "graph-diff"],
      guardPolicy: WARNING_POLICY,
      guardBaseline: EMPTY_BASELINE,
    });
    expect(report.verdict).toBe("review_required");
  });

  it("breaking_candidate drift → blocking_findings; risk → review_required katkısı", () => {
    const blocking = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      checks: ["contracts", "graph-diff"],
      contractDrift: mixedDrift(),
    });
    expect(blocking.checks.contracts.drift).toHaveLength(4);
    expect(
      blocking.checks.contracts.drift.filter((d) => d.compatibility === "breaking_candidate"),
    ).toHaveLength(2);
    expect(blocking.checks.contracts.drift.filter((d) => d.compatibility === "risk")).toHaveLength(2);
    expect(blocking.verdict).toBe("blocking_findings");
    // E2 kural kilidi (denetim bulgusu): blocking [0] karar verirken
    // contract-risk (6. kural) da UYGULANMIŞ kurallar listesinde taşınır —
    // öncelik zincirinin üye sapması bu yolda yakalanır.
    expect(blocking.verdictRationale[0]?.rule).toBe("blocking-finding");
    expect(blocking.verdictRationale.map((rule) => rule.rule)).toContain("contract-risk");
  });

  it("yalnızca risk drift → review_required + rationale[0] 'contract-risk' (E2 6. kural kilidi)", () => {
    const riskOnly: ContractDriftResult = {
      ...mixedDrift(),
      breakingCandidates: [],
    };
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      checks: ["contracts", "graph-diff"],
      contractDrift: riskOnly,
    });
    expect(report.checks.contracts.drift).toHaveLength(2);
    expect(
      report.checks.contracts.drift.every((d) => d.compatibility === "risk"),
    ).toBe(true);
    expect(report.verdict).toBe("review_required");
    // Karar doğrudan 6. kuradan gelir (api-surface tetiklenmez: taban=hedef).
    expect(report.verdictRationale[0]?.rule).toBe("contract-risk");
  });

  it("Endpoint ekleme → apiSurfaceChanges + rationale[0] 'api-surface' + review_required (E2 7. kural kilidi)", () => {
    const endpointAdded = buildSnapshot(
      [
        node("Class", SVC, SVC_PATH),
        node("Class", REPO, REPO_PATH),
        node("Test", TEST, TEST_PATH),
        node("Test", TEST2, TEST2_PATH),
        node("Endpoint", "App.POST /orders", "src/routes/orders.ts"),
      ],
      [
        edge("CALLS", SVC_REF, REPO_REF, ["ev-svc-repo"]),
        edge("TESTS", TEST_REF, SVC_REF, ["ev-test-svc"]),
        edge("TESTS", TEST2_REF, REPO_REF, ["ev-test2-repo"]),
      ],
    );
    const report = verifyChange({
      baseSnapshot: cleanTree(),
      targetSnapshot: endpointAdded,
      checks: ["graph-diff"],
    });
    expect(report.checks.graphDiff.status).toBe("evaluated");
    expect(report.checks.graphDiff.apiSurfaceChanges).toBe(1);
    expect(report.verdict).toBe("review_required");
    // Tek tetiklenen kural api-surface'tür (guard bulgusu yok; taban=hedef
    // diff'i yalnızca endpoint eklemesi; diğer denetimler istenmedi).
    expect(report.verdictRationale).toHaveLength(1);
    expect(report.verdictRationale[0]?.rule).toBe("api-surface");
    expect(report.verdictRationale[0]?.detail).toContain("1");
  });
});

/* ------------------------------------------------------------------ */
/* Negatif                                                             */
/* ------------------------------------------------------------------ */

describe("verifyChange — negatif", () => {
  const base = cleanTree();

  it("bilinmeyen preflightId → verification/preflight-not-found (sabit kod)", () => {
    const unknownId = "preflight:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    try {
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        preflightId: unknownId,
        resolvePreflight: () => undefined,
      });
      expect.unreachable("preflight-not-found beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).code).toBe("verification/preflight-not-found");
      expect((error as VerificationError).message).toContain(unknownId);
    }
  });

  it("resolver verilmeyen preflightId → yine verification/preflight-not-found", () => {
    expect(() =>
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        preflightId: manifestOf(base).preflightId,
      }),
    ).toThrowError(/preflight-not-found|çözümlenemedi/);
  });

  it("policy dışı dosya → verification/file-not-authorized (gerçek WorkspaceAccessPolicy)", () => {
    const { root, policy } = makePolicyRoot();
    try {
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        changedFiles: ["secrets/key.pem"],
        authorizeFile: (file) => {
          const decision = policy.checkFile(root, file);
          return decision.allowed
            ? { allowed: true, relativePath: decision.relativePath }
            : { allowed: false, code: decision.code, reason: decision.reason };
        },
      });
      expect.unreachable("file-not-authorized beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).code).toBe("verification/file-not-authorized");
    }
  });

  it("changedFiles + authorizeFile eksikliği → fail-closed invalid-input", () => {
    try {
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        changedFiles: ["src/OrdersService.ts"],
      });
      expect.unreachable("invalid-input beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).code).toBe("verification/invalid-input");
    }
  });

  it("bilinmeyen check adı → verification/invalid-input (kod düzeyi kilit)", () => {
    try {
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        checks: ["architecture", "no-such-check" as VerifyCheckName],
      });
      expect.unreachable("invalid-input beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).code).toBe("verification/invalid-input");
    }
  });

  it("building snapshot → verification/snapshot-state (kod düzeyi kilit)", () => {
    const building = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-verify", sequence: 1 },
      configHash: "cfg-verify",
      analyzerFingerprint: "fp-verify",
      state: "building",
      createdAt: CREATED_AT,
      nodes: [node("Class", SVC, SVC_PATH)],
      edges: [],
    });
    try {
      verifyChange({ baseSnapshot: building, targetSnapshot: base });
      expect.unreachable("snapshot-state beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      expect((error as VerificationError).code).toBe("verification/snapshot-state");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Partial                                                             */
/* ------------------------------------------------------------------ */

describe("verifyChange — partial", () => {
  const base = cleanTree();
  const target = modifiedTree();
  const drift = emptyDrift();

  it("çözülemeyen kapsam hedefi → test-plan partial + unknowns + review_required (E2 kuralı)", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      changedSymbols: [SVC, "Ghost.Missing"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    });
    expect(report.checks.testPlan.status).toBe("partial");
    expect(
      report.checks.testPlan.unresolvedTargets.some((entry) => entry.target === "Ghost.Missing"),
    ).toBe(true);
    expect(report.unknowns.some((u) => u.includes("Ghost.Missing"))).toBe(true);
    // E2 geçiş kuralı: bulgu yok ama çözümsüz hedef var → review_required
    // (inconclusive yalnızca girdi eksik/policy reddi içindir).
    expect(report.verdict).toBe("review_required");
    // Çözülen hedef adayları yine türetilir (kalan kapsam çalışır).
    expect(report.checks.testPlan.recommendedCount).toBeGreaterThanOrEqual(1);
    // byte-determinizm partial raporda da geçerlidir.
    const again = serializeVerificationReport(
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: target,
        changedSymbols: [SVC, "Ghost.Missing"],
        guardPolicy: CLEAN_POLICY,
        guardBaseline: EMPTY_BASELINE,
        contractDrift: drift,
      }),
    );
    expect(again).toBe(serializeVerificationReport(report));
  });

  it("guard policy yok → architecture not_evaluated + inconclusive", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      checks: ["architecture", "graph-diff"],
    });
    expect(report.checks.architecture.status).toBe("not_evaluated");
    expect(report.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(report.verdict).toBe("inconclusive");
  });

  it("kapsam verilmezse değişiklik kümesi diff'ten türetilir", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      checks: ["graph-diff", "test-plan"],
    });
    expect(report.preflightId).toBeUndefined();
    expect(report.preflightAlignment).toBeUndefined();
    expect(report.checks.graphDiff.diffSummary.changed).toBeGreaterThanOrEqual(1);
    expect(report.checks.graphDiff.diffSummary.added).toBeGreaterThanOrEqual(1);
    // Değişen node'lar (AuditLogger ekli, OrderRepository değişmiş) test
    // planı kapsamına girer; ancak SVC dışında TESTS kenarı yoktur.
    expect(report.checks.testPlan.status).toBe("evaluated");
    expect(report.checks.testPlan.derivedFrom).toBe("graph-diff");
  });

  it("observedTestRun kanıtla → observed; kanıtsız → invalid-input (iddia sayılmaz)", () => {
    const observed: ObservedTestRun = {
      state: "observed",
      evidenceRef: "reports/vitest-summary.json",
      evidenceSha256: "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3",
      observedCount: 2,
      evidenceIds: ["ev-test-run-1"],
    };
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: target,
      checks: ["test-plan", "graph-diff"],
      observedTestRun: observed,
    });
    expect(report.tests.state).toBe("observed");
    expect(report.tests.observedCount).toBe(2);

    // Kanıtsız koşum iddiası: şema reddeder (E3 — evidenceRef zorunlu).
    // Girdi kasıtlı olarak tip sözleşmesini ihlal eder; runtime şema katmanı
    // onu reddetmek ZORUNDADIR (fail-closed).
    const kanitsiz: ObservedTestRun = JSON.parse(
      '{"observedCount":2,"status":"observed"}',
    ) as ObservedTestRun;
    expect(() =>
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: target,
        checks: ["test-plan", "graph-diff"],
        observedTestRun: kanitsiz,
      }),
    ).toThrowError(VerificationError);
  });
});

/* ------------------------------------------------------------------ */
/* E2 — Verdict semantiği (sprint-6 E2)                                */
/* ------------------------------------------------------------------ */

/**
 * sprint-6.md E2: verdict semantiği — no_findings | review_required |
 * blocking_findings | inconclusive geçiş kuralları deterministik ve belgeli
 * olmalı; no_findings güvenli/kod-dogruğu GARANTİSİ DEĞİLDİR (çıktıda açık
 * disclaimers alanı); her verdict kararının hangi kuraldan geldiği
 * rationale ile raporlanır.
 *
 * TŞ v2.1 §10.4 (PyMuPDF çıkarımı, s.11 — bu ask içinde yeniden okundu):
 * "verdict değerleri no_findings | review_required | blocking_findings |
 * inconclusive olabilir. no_findings güvenli/correct kod garantisi değildir."
 *
 * Geçiş kuralları (öncelik sırasında; ilk uygulanan kural karar verir):
 *   1. blocking-finding  : baskılanmamış error bulgusu veya breaking_candidate drift
 *   2. missing-input     : istenen denetim not_evaluated (girdi eksik / policy reddi)
 *   3. suppressed-finding: suppression uygulanmış bulgu (baseline istisnası)
 *   4. unresolved-target : kapsam hedefi çözülemedi
 *   5. warning-finding   : baskılanmamış warning/info bulgusu
 *   6. contract-risk     : risk/unknown drift kaydı
 *   7. api-surface       : API yüzeyi değişimi
 *   8. clean-and-resolved: sinyal yok + tüm istenen denetimler evaluated
 */
describe("verifyChange — E2 verdict semantiği", () => {
  const base = cleanTree();
  const violation = violatingTree();
  const drift = emptyDrift();

  /** CLEAN_POLICY ihlalini baskılayan baseline (suppression kuralı senaryosu). */
  const SUPPRESSING_BASELINE: ArchitectureBaseline = parseArchitectureBaseline(
    [
      "version: 1",
      "suppressions:",
      "  - ruleId: src-must-not-call-tests",
      '    from: "**/src/**"',
      '    to: "**/tests/**"',
      '    reason: "Geçici istisna (fixture)"',
      "    owner: alice",
      "    date: 2026-11-08",
      "",
    ].join("\n"),
  );

  it("pozitif no_findings: tam çözümlü temiz ağaç; disclaimers birebir VAR; karar kuralı clean-and-resolved", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    });
    expect(report.verdict).toBe("no_findings");
    // E2: no_findings güvenli/kod-dogruğu garantisi değildir — disclaimers
    // alanı birebir bu anlamda HER no_findings çıktısında bulunur.
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
    expect(report.verdictRationale).toHaveLength(1);
    expect(report.verdictRationale[0]?.rule).toBe(VERIFY_VERDICT_RULES.cleanResolved);
    expect(report.incompleteChecks).toEqual([]);
    expect(report.disclaimers.some((d) => d.includes("not_run"))).toBe(true);
  });

  it("pozitif review_required: warning bulgusu → karar kuralı warning-finding", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: violation,
      checks: ["architecture", "graph-diff"],
      guardPolicy: WARNING_POLICY,
      guardBaseline: EMPTY_BASELINE,
    });
    expect(report.verdict).toBe("review_required");
    expect(report.verdictRationale[0]?.rule).toBe(VERIFY_VERDICT_RULES.warningFinding);
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
  });

  it("pozitif review_required: suppression uygulandı (baseline/suppression kuralı) → karar kuralı suppressed-finding", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: violation,
      checks: ["architecture", "graph-diff"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: SUPPRESSING_BASELINE,
    });
    expect(report.checks.architecture.suppressedCount).toBe(1);
    expect(report.checks.architecture.findings[0]?.suppressed).toBe(true);
    // Baskılanmamış bulgu yok (findings boş) ama suppression sinyali verdict'i
    // no_findings'e düşürmez: baseline istisnası inceleme gerektirir.
    expect(report.architectureFindings).toHaveLength(0);
    expect(report.verdict).toBe("review_required");
    expect(report.verdictRationale[0]?.rule).toBe(VERIFY_VERDICT_RULES.suppressedFinding);
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
  });

  it("pozitif blocking_findings: baskılanmamış error bulgusu → karar kuralı blocking-finding", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: violation,
      checks: ["architecture", "graph-diff"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
    });
    expect(report.verdict).toBe("blocking_findings");
    expect(report.verdictRationale[0]?.rule).toBe(VERIFY_VERDICT_RULES.blockingFinding);
    expect(report.verdictRationale[0]?.detail).toContain("src-must-not-call-tests");
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
  });

  it("pozitif inconclusive: istenen denetim girdisi eksik → karar kuralı missing-input + eksik liste", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      // guardPolicy ve contractDrift kasıtlı YOK (girdi eksik).
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.verdictRationale[0]?.rule).toBe(VERIFY_VERDICT_RULES.missingInput);
    expect(report.incompleteChecks).toEqual(["architecture", "contracts"]);
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
  });

  it("negatif: verdict üretilemeyen girdi → inconclusive + gerekçe unknowns'ta ve rationale detail'inde", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      checks: ["architecture", "graph-diff"],
      // guardPolicy YOK: architecture denetimi koşulamaz.
    });
    expect(report.checks.architecture.status).toBe("not_evaluated");
    expect(report.verdict).toBe("inconclusive");
    expect(report.unknowns.some((u) => u.includes("guard policy"))).toBe(true);
    const missing = report.verdictRationale.find(
      (rule) => rule.rule === VERIFY_VERDICT_RULES.missingInput,
    );
    expect(missing).toBeDefined();
    expect(missing?.detail).toContain("architecture");
  });

  it("partial: kısmi check (çözümsüz kapsam hedefi) → review_required + eksik check listesi ['test-plan']", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: modifiedTree(),
      changedSymbols: [SVC, "Ghost.Missing"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    });
    expect(report.checks.testPlan.status).toBe("partial");
    expect(report.incompleteChecks).toEqual(["test-plan"]);
    expect(report.verdict).toBe("review_required");
    expect(
      report.verdictRationale.some(
        (rule) => rule.rule === VERIFY_VERDICT_RULES.unresolvedTarget,
      ),
    ).toBe(true);
    expect(report.disclaimers).toContain(NO_FINDINGS_CORE_DISCLAIMER);
  });

  it("determinizm: disclaimers/verdictRationale/incompleteChecks ile iki koşum byte-eşit", () => {
    const input = {
      baseSnapshot: base,
      targetSnapshot: modifiedTree(),
      changedSymbols: [SVC, "Ghost.Missing"],
      guardPolicy: CLEAN_POLICY,
      guardBaseline: EMPTY_BASELINE,
      contractDrift: drift,
    };
    const run1 = serializeVerificationReport(verifyChange(input));
    const run2 = serializeVerificationReport(verifyChange(input));
    expect(run2).toBe(run1);
    expect(run1).toContain('"disclaimers"');
    expect(run1).toContain('"verdictRationale"');
    expect(run1).toContain('"incompleteChecks"');
  });
});

/* ------------------------------------------------------------------ */
/* E3 — Test durumu dürüstlüğü (sprint-6 E3)                           */
/* ------------------------------------------------------------------ */

/**
 * sprint-6.md E3: test adaylarının durumu varsayılan not_run; observed
 * YALNIZCA dosya/provenance kanıtıyla (rapor dosyası + sha256) veya
 * doğrulanabilir test raporu kanıtıyla set edilir; motor HİÇBİR KOŞULDA
 * test çalıştırmaz (otomatik test koşucusu YASAK); 'passed' iddiası
 * yalnızca observed + kanıtlı + rapor gerçekten geçiyorsa olur; not_run
 * iken tip düzeyinde imkânsızdır. evidenceRef observed'da ZORUNLUDUR
 * (Zod refine).
 *
 * TŞ v2.1 §10.4 (bu ask içinde PyMuPDF ile s.11'den yeniden okundu):
 * "Test runner varsayılan kurulmaz veya otomatik çalıştırılmaz. Host'un
 * yaptığı test koşuları ancak dosya/provenance veya açıkça verilen
 * doğrulanabilir test raporuyla observed olarak kaydedilebilir; iddia ile
 * başarılı sayılmaz."
 *
 * Sprint kapısı senaryosu: testler koşulmayan bir verify raporunda 'geçti'
 * kelimesi hiçbir test adayında geçmez (test assert eder).
 */
describe("verifyChange — E3 test durumu dürüstlüğü", () => {
  const base = cleanTree();
  const modified = modifiedTree();

  /**
   * GERÇEK rapor dosyası: tmp'de yazılır, sha256 gerçek baytlardan
   * hesaplanır (E3: dosya kanıtı = yol + hash).
   */
  function makeRealReportFile(passed: number, failed: number): { ref: string; sha256: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "causoryn-e3-report-"));
    createdDirs.push(dir);
    const reportPath = path.join(dir, "vitest-summary.json");
    writeFileSync(reportPath, JSON.stringify({ passed, failed }, null, 2) + "\n", "utf8");
    const sha256 = createHash("sha256").update(readFileSync(reportPath)).digest("hex");
    return { ref: reportPath, sha256 };
  }

  it("pozitif: provenance dosyalı observed + passed — dosya gerçek, hash gerçek, passed yalnızca kanıtlı kayıtta", () => {
    const file = makeRealReportFile(2, 0);
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      changedSymbols: [SVC], // explicit kapsam: TEST adayı türesin
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: file.ref,
        evidenceSha256: file.sha256,
        observedCount: 2,
        passedCount: 2,
        failedCount: 0,
        testNames: [TEST],
      },
    });
    expect(report.tests.state).toBe("observed");
    // Union daraltması: observed dalının alanları yalnızca daraltmayla erişilir.
    const tests = report.tests;
    if (tests.state !== "observed") {
      throw new Error(`observed beklenmişti, gelen: ${String(tests.state)}`);
    }
    expect(tests.evidenceRef).toBe(file.ref);
    expect(tests.evidenceSha256).toBe(file.sha256);
    expect(tests.observedCount).toBe(2);
    // 'passed' iddiası: rapor gerçekten geçiyor (failedCount 0, passedCount ≥1).
    expect(tests.passed).toBe(true);
    expect(report.checks.testPlan.run.state).toBe("observed");
    const run = report.checks.testPlan.run;
    if (run.state !== "observed") {
      throw new Error(`run observed beklenmişti, gelen: ${String(run.state)}`);
    }
    expect(run.passed).toBe(true);
    expect(run.evidenceRef).toBe(file.ref);
    // Explicit bağlama: yalnızca TEST adayı observed.
    expect(report.checks.testPlan.candidateStatuses).toHaveLength(1);
    const entry = report.checks.testPlan.candidateStatuses[0];
    expect(entry?.testQualifiedName).toBe(TEST);
    expect(entry?.status).toBe("observed");
    // determinizm: kanıtlı kayıtlı rapor iki koşumda byte-eşit
    const again = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      changedSymbols: [SVC],
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: file.ref,
        evidenceSha256: file.sha256,
        observedCount: 2,
        passedCount: 2,
        failedCount: 0,
        testNames: [TEST],
      },
    });
    expect(serializeVerificationReport(again)).toBe(serializeVerificationReport(report));
  });

  it("pozitif: rapor başarısızsa (failedCount > 0) observed vardır ama 'passed' iddiası ÜRETİLMEZ", () => {
    const file = makeRealReportFile(1, 2);
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: file.ref,
        evidenceSha256: file.sha256,
        observedCount: 3,
        passedCount: 1,
        failedCount: 2,
      },
    });
    expect(report.tests.state).toBe("observed");
    const tests = report.tests;
    if (tests.state !== "observed") {
      throw new Error(`observed beklenmişti, gelen: ${String(tests.state)}`);
    }
    expect(tests.failedCount).toBe(2);
    // Rapor başarısız: 'passed' iddiası üretilmez (anahtar fiziksel olarak yok;
    // passed:false ile temsil edilmez — sayılar konuşur).
    expect("passed" in tests).toBe(false);
  });

  it("negatif: kanıtsız observed denemesi → Zod şema reddi + VerificationError", () => {
    // Şema düzeyi: evidenceRef olmayan observed güvenli parse EDİLEMEZ.
    expect(OBSERVED_TEST_RUN_SCHEMA.safeParse({ observedCount: 2 }).success).toBe(false);
    expect(
      OBSERVED_TEST_RUN_SCHEMA.safeParse({
        state: "observed",
        evidenceRef: "   ",
        observedCount: 1,
      }).success,
    ).toBe(false);
    // Çekirdek yüzeyi: fail-closed VerificationError.
    const kanitsiz: ObservedTestRun = JSON.parse(
      '{"status":"observed","observedCount":2}',
    ) as ObservedTestRun;
    expect(() =>
      verifyChange({
        baseSnapshot: base,
        targetSnapshot: base,
        checks: ["test-plan", "graph-diff"],
        observedTestRun: kanitsiz,
      }),
    ).toThrowError(VerificationError);
  });

  it("negatif: observedTestRun.testNames/evidenceIds tavanı (200) aşarsa şema reddeder — girdiyle orantılı rapor büyümesi engellenir (TŞ §20 kaynak bütçesi)", () => {
    const evidence = {
      state: "observed" as const,
      evidenceRef: "reports/vitest-summary.json",
    };
    // 201 testNames üyesi: kabul EDİLMEZ (bağlanamayan her üye limitations'a
    // satır eklediğinden girdiyle orantılı rapor büyümesi güvenlik analisti
    // bulgusudur; tavan şema kapısında fail-closed).
    const largeNames = Array.from({ length: 201 }, (_, i) => `test:ad-${String(i)}`);
    expect(
      OBSERVED_TEST_RUN_SCHEMA.safeParse({
        ...evidence,
        observedCount: largeNames.length,
        testNames: largeNames,
      }).success,
    ).toBe(false);
    // 201 evidenceIds üyesi: kabul EDİLMEZ (rapor evidenceIds dizisi de
    // girdiyle sınırsız büyüyemez).
    const largeIds = Array.from({ length: 201 }, (_, i) => `ev-${String(i)}`);
    expect(
      OBSERVED_TEST_RUN_SCHEMA.safeParse({
        ...evidence,
        observedCount: largeIds.length,
        evidenceIds: largeIds,
      }).success,
    ).toBe(false);
    // Tavan İÇİNDE (200) uzunluk kabul edilir; meşru büyük koşum düşmez.
    expect(
      OBSERVED_TEST_RUN_SCHEMA.safeParse({
        ...evidence,
        observedCount: 200,
        testNames: Array.from({ length: 200 }, (_, i) => `test:ad-${String(i)}`),
        evidenceIds: Array.from({ length: 200 }, (_, i) => `ev-${String(i)}`),
      }).success,
    ).toBe(true);
  });

  it("negatif (tip düzeyi): not_run koşumda 'passed' ve 'evidenceRef' üretimi imkânsız", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      checks: ["test-plan", "graph-diff"],
    });
    expect(report.tests.state).toBe("not_run");
    // Çalışma zamanı: not_run kaydında bu anahtarlar FİZİKSEL olarak yok.
    expect("passed" in report.tests).toBe(false);
    expect("evidenceRef" in report.tests).toBe(false);
    expect(TEST_RUN_STATUS_SCHEMA.safeParse(report.tests).success).toBe(true);
    // Tip düzeyi: aşağıdaki atama DERLEYICIDE hatadır (hata literal'in
    // 'passed' özelliğinin satırında raporlanır); @ts-expect-error o satırda
    // bu hatayı tüketir. not_run dalına 'passed' alanı eklenirse direktif
    // kullanılmaz olur ve 'npx tsc -p tsconfig.typecheck.json' KIRMIZI olur
    // (E3 tip sözleşmesinin derleyici düzeyinde kanıtı).
    const illegal: VerifyTestStatus =
      // @ts-expect-error E3: not_run dalında 'passed' alanı tip düzeyinde yoktur
      { state: "not_run", recommendedCount: 1, observedCount: 0, passed: true };
    expect(illegal.state).toBe("not_run");
  });

  it("sprint kapısı: testler koşulmayan raporda 'geçti' kelimesi hiçbir test adayında geçmez", () => {
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: modified,
      checks: ["test-plan", "graph-diff"],
    });
    expect(report.tests.state).toBe("not_run");
    expect(report.checks.testPlan.run.state).toBe("not_run");
    // Her adayın gerekçe metni 'geçti' İCERMEZ (koşum/sonuç iddiası yok).
    const candidatesJson = canonicalJson(
      report.checks.testPlan.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        reason: candidate.reason,
      })),
    );
    expect(candidatesJson).not.toContain("geçti");
    // Tüm aday durumları not_run.
    expect(report.checks.testPlan.candidateStatuses.length).toBeGreaterThanOrEqual(1);
    for (const entry of report.checks.testPlan.candidateStatuses) {
      expect(entry.status).toBe("not_run");
    }
    // Limitations/unknowns'ta da koşum-sonuç iddiası metni yok.
    expect(canonicalJson(report.limitations)).not.toContain("geçti");
    expect(canonicalJson(report.unknowns)).not.toContain("geçti");
  });

  it("partial: karma — bir aday observed, diğer aday not_run (explicit testNames bağlaması)", () => {
    const file = makeRealReportFile(1, 0);
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: modified,
      changedSymbols: [SVC, REPO],
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: file.ref,
        evidenceSha256: file.sha256,
        observedCount: 1,
        passedCount: 1,
        failedCount: 0,
        testNames: [TEST],
      },
    });
    const statuses = report.checks.testPlan.candidateStatuses;
    expect(statuses).toHaveLength(2);
    const observedEntry = statuses.find((entry) => entry.testQualifiedName === TEST);
    const notRunEntry = statuses.find((entry) => entry.testQualifiedName !== TEST);
    expect(observedEntry?.status).toBe("observed");
    expect(notRunEntry?.status).toBe("not_run");
    expect(notRunEntry?.testQualifiedName).toBe(TEST2);
    expect(report.tests.state).toBe("observed");
  });

  it("partial: hiçbir adaya bağlanmayan testNames üyesi sessizce düşürülmez", () => {
    const file = makeRealReportFile(2, 0);
    const report = verifyChange({
      baseSnapshot: base,
      targetSnapshot: base,
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: file.ref,
        evidenceSha256: file.sha256,
        observedCount: 1,
        testNames: ["Ghost.Test.Yok"],
      },
    });
    // Bağlanamayan ad üyesi limitation ile raporlanır; hiçbir aday observed
    // YAZILMAZ (uydurma kapsama yok).
    expect(report.checks.testPlan.candidateStatuses.every((entry) => entry.status === "not_run")).toBe(
      true,
    );
    expect(
      report.limitations.some((entry) => entry.includes("Ghost.Test.Yok")),
    ).toBe(true);
  });
});
