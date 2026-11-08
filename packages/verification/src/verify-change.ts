import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type GraphNode,
  type JsonValue,
  type SnapshotGraph,
} from "@causoryn/domain";
import {
  diffContentSets,
  findViolations,
  type ArchitectureBaseline,
  type CompareContentSet,
  type CompareNodeIdentity,
  type GuardFinding,
} from "@causoryn/graph";
import type {
  ContractDriftItem,
  ContractDriftResult,
} from "@causoryn/contracts";
import {
  deriveTestPlan,
  type PreflightManifest,
  type TestPlanCandidate,
} from "@causoryn/preflight";

import { VerificationError } from "./errors.js";
import {
  OBSERVED_TEST_RUN_SCHEMA,
  TEST_RUN_STATUS_SCHEMA,
  formatZodIssues,
} from "./test-status-schema.js";
import {
  NO_FINDINGS_CORE_DISCLAIMER,
  NO_FINDINGS_DISCLAIMER,
  VERIFY_CHECK_NAMES,
  VERIFY_VERDICT_RULES,
  type ArchitectureCheckResult,
  type ContractsCheckResult,
  type GraphDiffCheckResult,
  type ObservedTestRun,
  type PreflightAlignment,
  type TestPlanCheckResult,
  type VerifyChangeInput,
  type VerifyCheckName,
  type VerifyCheckStatus,
  type VerifyContractDriftEntry,
  type VerificationReport,
  type VerifyFileAuthorizer,
  type VerifyTestCandidateStatus,
  type VerifyTestStatus,
  type VerifyVerdict,
  type VerifyVerdictRule,
} from "./types.js";

/**
 * causoryn_verify_change saf çekirdeği — sprint-6 E1.
 *
 * Sözleşme (TŞ v2.1, PyMuPDF çıkarımı, raw/Causoryn_Teknik_Dokuman_v2.1.pdf):
 * - §10.4 (Sayfa 11): girdi {preflightId, targetRevision: "working-tree",
 *   checks: [architecture, contracts, graph-diff, test-plan]}; yanıt
 *   {baseSnapshotId, targetSnapshotId, verdict, architectureFindings,
 *   contractDrift, tests: {state: "not_run", recommendedCount,
 *   observedCount}, unknowns, evidenceIds}. Dürüstlük hükmü: "no_findings
 *   güvenli/correct kod garantisi değildir. Test runner varsayılan kurulmaz
 *   veya otomatik çalıştırılmaz. Host'un yaptığı test koşuları ancak
 *   dosya/provenance veya açıkça verilen doğrulanabilir test raporuyla
 *   observed olarak kaydedilebilir; iddia ile başarılı sayılmaz."
 * - §1 ürün döngüsü (Sayfa 2): Discover → Preflight → Agent Edits → Verify →
 *   Explain; verify "değişiklik sonrası mimari bütünlüğü tekrarlanabilir
 *   kurallarla kontrol eder".
 * - §23 Faz E kapısı: "Before/after reproducibility + no-test-run honesty".
 *
 * BİRLEŞTİRME KATMANI SÖZLEŞMESİ (packages/preflight manifest.ts örüntüsü):
 * bileşenler YENİDEN YAZILMAZ, çağrılır —
 * - graph-diff   : packages/graph `diffContentSets` (C3 compare çekirdeği)
 *   base ↔ target içerik kümeleri üzerinde; eşiği/skorlaması compare.ts'tedir.
 * - architecture : packages/graph `findViolations` (C2 guard motoru; Tarjan
 *   SCC + forbidden-dependency, suppression yönetişimi guard.ts'tedir).
 *   Hedef (working-tree) snapshot üzerinde koşar; guardPolicy verilmezse
 *   denetim not_evaluated olur (verdict'e inconclusive katkısı — uydurma
 *   "temiz" kararı yok).
 * - contracts    : host katmanının ürettiği D2/D3 `ContractDriftResult`
 *   kayıtları sözleşme başına sınıflama kayıtlarına eşlenir (D4 manifest.ts
 *   contractChecks eşleme disiplini; kaynak sınıflama korunur).
 * - test-plan    : packages/preflight `deriveTestPlan` (D6); kapsam
 *   (preflight/explicit) yoksa değişiklik kümesi graph-diff'ten türetilir.
 *   E3: aday durumları VARSAYILAN not_run'dır; `observedTestRun` yalnızca
 *   dosya/provenance kanıtıyla (evidenceRef ZORUNLU + opsiyonel sha256 —
 *   OBSERVED_TEST_RUN_SCHEMA) kabul edilir; 'passed' iddiası yalnızca
 *   observed + kanıtlı + rapor gerçekten geçiyorsa (failedCount 0 &&
 *   passedCount ≥ 1) üretilir; not_run dalında passed/evidenceRef tip ve
 *   şema düzeyinde YOKTUR (VerifyTestStatus discriminated union +
 *   TEST_RUN_STATUS_SCHEMA.superRefine). Motor HİÇBİR KOŞULDA test
 *   çalıştırmaz (otomatik test koşucusu yasak — kırmızı çizgi 5).
 *
 * GİRDİ MODLARI: preflightId (D4 manifesti, enjekte çözümleyiciden) VEYA
 * changedSymbols/changedFiles (beyan edilen kapsam) — ikisi birlikte
 * verilmez (TŞ §10.2 "changeSet/preflightId?" örüntüsü). Hiçbiri verilmezse
 * kapsam graph-diff'ten türetilir (derivedFrom: "graph-diff").
 *
 * ÇALIŞMA AĞACI VE YETKİ: çekirdek fs OKUMAZ; çalışma ağacı, indexing
 * katmanının WorkspaceAccessPolicy üzerinden ürettiği targetSnapshot olarak
 * girer. Çekirdeğin kendi yüzeyinde dosya yalnızca kapsam hedefidir ve
 * authorizeFile kararı olmadan kullanılamaz (fail-closed); red kararı
 * verification/file-not-authorized ile raporlanır (sessiz düşürme yok).
 *
 * VERDICT SEMANTİĞİ (sprint-6 E2 — deterministik kural zinciri; öncelik
 * sırasında İLK uygulanan kural karar verir; tüm uygulanmış kurallar
 * verdictRationale'da gerekçeleriyle listelenir; bkz. types.ts
 * VERIFY_VERDICT_RULES belgesi):
 *   1. blocking-finding  : baskılanmamış error bulgusu veya breaking_candidate
 *      drift → blocking_findings (sert bulgu hiçbir sinyalle yumuşatılmaz).
 *   2. missing-input     : istenen denetim not_evaluated (girdi eksik / policy
 *      reddi) → inconclusive; tamamlanmamış değerlendirme review_required
 *      izlenimi veremez.
 *   3. suppressed-finding: suppression uygulanmış bulgu → review_required
 *      (baseline istisnası inceleme gerektirir).
 *   4. unresolved-target : kapsam hedefi çözülemedi → review_required
 *      (bulgu yoktur ama kapsamın bir bölümü denetlenemedi; tam çözümlü
 *      değil).
 *   5. warning-finding   : baskılanmamış warning/info bulgusu →
 *      review_required.
 *   6. contract-risk     : risk/unknown drift kaydı → review_required.
 *   7. api-surface       : API yüzeyi değişimi → review_required.
 *   8. clean-and-resolved: sinyal yok + tüm istenen denetimler evaluated →
 *      no_findings.
 * no_findings güvenli/kod-dogruğu garantisi DEĞİLDİR: HER raporun
 * disclaimers alanı NO_FINDINGS_CORE_DISCLAIMER'ı taşır (TŞ §10.4);
 * verdictRationale[0] karar veren kuralı, incompleteChecks eksik/kısmi
 * denetimleri raporlar.
 *
 * SAF ÇEKİRDEK: fs/thread/saat/rastgele okumaz; MCP türlerini import etmez;
 * girdileri mutasyona uğratmaz. Tüm çıktı dizileri kanonik sıralı → aynı
 * (base, target, kapsam, kurallar) girdisi iki koşumda bit-bit aynı JSON'u
 * üretir; girdi dizi sırası çıktıyı değiştirmez (TŞ §8 invariant vi).
 * reportId, rapor gövdesinin (kimlik alanı hariç) canonical JSON SHA-256
 * karmasıdır. serializeVerificationReport çıktısı sprint kapısının
 * (Faz E: before/after reproducibility) byte-determinizm kanıtıdır.
 */

/** guardBaseline verilmediğinde uygulanan boş suppression kümesi. */
const EMPTY_BASELINE: ArchitectureBaseline = { version: 1, suppressions: [] };

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function invalid(message: string): VerificationError {
  return new VerificationError("verification/invalid-input", message);
}

function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${field} boş/blank olamaz: ${String(value)}`);
  }
  return value;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(cmp);
}

/**
 * Öncelik zincirindeki ilk kuralı verdict'e eşler (E2 geçiş kuralları —
 * types.ts VERIFY_VERDICT_RULES belgesindeki 1..8 sırası). Uydurma kural
 * kimliği compile-time'da imkânsızdır (kural kümesi sabit union).
 */
function verdictOfFirstRule(first: VerifyVerdictRule): VerifyVerdict {
  switch (first.rule) {
    case VERIFY_VERDICT_RULES.blockingFinding:
      return "blocking_findings";
    case VERIFY_VERDICT_RULES.missingInput:
      return "inconclusive";
    case VERIFY_VERDICT_RULES.suppressedFinding:
    case VERIFY_VERDICT_RULES.unresolvedTarget:
    case VERIFY_VERDICT_RULES.warningFinding:
    case VERIFY_VERDICT_RULES.contractRisk:
    case VERIFY_VERDICT_RULES.apiSurface:
      return "review_required";
    case VERIFY_VERDICT_RULES.cleanResolved:
      return "no_findings";
  }
}

function assertSnapshotUsable(snapshot: SnapshotGraph, label: string): void {
  const state = snapshot.meta?.state;
  if (state !== "ready" && state !== "partial") {
    throw new VerificationError(
      "verification/snapshot-state",
      `verify yalnızca ready/partial snapshot üzerinde çalışır (${label}); snapshot durumu: ${String(state)}`,
    );
  }
  if (typeof snapshot.meta?.id !== "string" || snapshot.meta.id.length === 0) {
    throw invalid(`${label}.meta.id geçersiz: yayımlanmış snapshot kimliği zorunludur`);
  }
}

/** Bilinen denetim adları üyelik kümesi (string dahil etme hatası olmasın). */
const KNOWN_CHECKS: ReadonlySet<string> = new Set<string>(VERIFY_CHECK_NAMES);

/** checks girdisini kanonik sıraya indirger; bilinmeyen ad invalid-input. */
function normalizeChecks(checks: readonly VerifyCheckName[] | undefined): VerifyCheckName[] {
  if (checks === undefined) return [...VERIFY_CHECK_NAMES];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw invalid(
      "checks kümesi boş olamaz: en az bir denetim adı verin veya parametreyi hiç vermeyin (tümü)",
    );
  }
  const seen = new Set<string>();
  for (const check of checks) {
    if (typeof check !== "string" || !KNOWN_CHECKS.has(check)) {
      throw invalid(
        `bilinmeyen denetim adı: ${String(check)}; beklenen değerler: ${VERIFY_CHECK_NAMES.join(", ")}`,
      );
    }
    seen.add(check);
  }
  return VERIFY_CHECK_NAMES.filter((name) => seen.has(name));
}

/** Kapsam: beyan edilen hedefler (scope) veya diff'ten türetme (graph-diff). */
interface VerifyScope {
  readonly source: "scope" | "graph-diff";
  readonly changedSymbols: readonly string[];
  readonly changedFiles: readonly string[];
}

/**
 * Kapsam dosyalarının yetkilendirmesi (fail-closed): dosya kümesi boş değilse
 * authorizeFile ZORUNLU; red kararı verification/file-not-authorized olur.
 */
function authorizeScopeFiles(
  files: readonly string[],
  authorizeFile: VerifyFileAuthorizer | undefined,
): string[] {
  if (files.length === 0) return [];
  if (authorizeFile === undefined) {
    throw invalid(
      "kapsam dosyası verildi ama authorizeFile sağlanmadı: dosyalar yetkilendirme kararı olmadan kullanılamaz (fail-closed)",
    );
  }
  const authorized: string[] = [];
  for (const file of files) {
    requireNonBlank("kapsam dosyası", file);
    const decision = authorizeFile(file);
    if (!decision.allowed) {
      throw new VerificationError(
        "verification/file-not-authorized",
        `kapsam dosyası yetkilendirilmedi: ${file}` +
          ` (${decision.code ?? "workspace/path-denied"})` +
          `${decision.reason === undefined ? "" : ` — ${decision.reason}`}`,
      );
    }
    authorized.push(decision.relativePath ?? file);
  }
  return sortedUnique(authorized);
}

/** E3: şema doğrulamasından geçmiş host koşum kaydının normalize hâli. */
interface NormalizedObservedRun {
  readonly evidenceRef: string;
  readonly evidenceSha256?: string;
  readonly evidenceIds: readonly string[];
  readonly observedCount: number;
  readonly passedCount?: number;
  readonly failedCount?: number;
  readonly testNames: readonly string[];
}

/**
 * E3 dürüstlük kapısı: host koşum kaydı OBSERVED_TEST_RUN_SCHEMA ile
 * doğrulanır (evidenceRef ZORUNLU; observedCount ≥ 1; sha256 biçimi);
 * kanıtsız koşum iddiası VerificationError ile reddedilir — iddia ile
 * başarılı sayılmaz (TŞ §10.4). Motor kaydı DOĞRULAR, koşumu ASLA ÜRETMEZ.
 */
function normalizeObservedRun(
  input: ObservedTestRun | undefined,
): NormalizedObservedRun | undefined {
  if (input === undefined) return undefined;
  const parsed = OBSERVED_TEST_RUN_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new VerificationError(
      "verification/invalid-input",
      `observedTestRun doğrulanamadı (E3 dürüstlük şeması — kanıtsız koşum iddiası kabul edilmez): ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const data = parsed.data;
  return {
    evidenceRef: data.evidenceRef,
    ...(data.evidenceSha256 === undefined ? {} : { evidenceSha256: data.evidenceSha256 }),
    evidenceIds: sortedUnique(data.evidenceIds ?? []),
    observedCount: data.observedCount,
    ...(data.passedCount === undefined ? {} : { passedCount: data.passedCount }),
    ...(data.failedCount === undefined ? {} : { failedCount: data.failedCount }),
    testNames: sortedUnique(data.testNames ?? []),
  };
}

/**
 * E3: koşum durumu nesnesi. observed yoksa not_run (kanıt/passed alanları
 * FİZİKSEL olarak yazılmaz — tip ve şema düzeyinde yasak); observed varsa
 * evidenceRef zorunlu taşınır ve 'passed' iddiası YALNIZCA rapor gerçekten
 * geçiyorsa (failedCount 0 && passedCount ≥ 1) true literal olarak yazılır.
 */
function testStatusOf(
  recommendedCount: number,
  observed: NormalizedObservedRun | undefined,
): VerifyTestStatus {
  if (observed === undefined) {
    return { status: "not_run", recommendedCount, observedCount: 0 };
  }
  const passedClaim =
    observed.passedCount !== undefined &&
    observed.failedCount !== undefined &&
    observed.failedCount === 0 &&
    observed.passedCount >= 1
      ? { passed: true as const }
      : {};
  return {
    status: "observed",
    recommendedCount,
    observedCount: observed.observedCount,
    evidenceRef: observed.evidenceRef,
    ...(observed.evidenceSha256 === undefined ? {} : { evidenceSha256: observed.evidenceSha256 }),
    ...(observed.evidenceIds.length > 0 ? { evidenceIds: observed.evidenceIds } : {}),
    ...passedClaim,
    ...(observed.passedCount === undefined ? {} : { passedCount: observed.passedCount }),
    ...(observed.failedCount === undefined ? {} : { failedCount: observed.failedCount }),
  };
}

/** Koşum durumu nesnesinin şema invariantlarını savunmada yeniden doğrular. */
function assertTestStatusSchema(status: VerifyTestStatus): void {
  const parsed = TEST_RUN_STATUS_SCHEMA.safeParse(status);
  if (!parsed.success) {
    throw invalid(
      `tests koşum durumu E3 şemasını ihlal ediyor (dahili invariant): ${formatZodIssues(parsed.error.issues)}`,
    );
  }
}

function identityOf(node: GraphNode): CompareNodeIdentity {
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.location?.relativePath === undefined
      ? {}
      : { relativePath: node.location.relativePath }),
  };
}

/**
 * SnapshotGraph → compare içerik kümesi. Konum, compare kimliğine
 * `location.relativePath` üzerinden girer (satır aralığı/hash
 * karşılaştırılmaz — compare.ts sözleşmesi: satır kayması mimari
 * değişiklik değildir). Kenar uçları node kimliğinden çözülür; dangling
 * kenar (createSnapshot ile üretilemez) savunmada invalid-input olur.
 */
function toContentSet(snapshot: SnapshotGraph): CompareContentSet {
  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);
  const nodes = snapshot.nodes.map((node) => ({
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.location?.relativePath === undefined
      ? {}
      : { relativePath: node.location.relativePath }),
    ...(node.language === undefined ? {} : { language: node.language }),
    attributes: node.attributes,
  }));
  const edges = snapshot.edges.map((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) {
      throw invalid(
        `snapshot kenarı içerik kümesinde çözülemedi (dangling; bozuk snapshot): ${edge.id}`,
      );
    }
    return {
      kind: edge.kind,
      from: identityOf(from),
      to: identityOf(to),
      resolution: edge.resolution,
    };
  });
  return { nodes, edges };
}

/** D3 ContractDriftResult kabuk doğrulaması (array alanları). */
function assertDriftResult(drift: ContractDriftResult): void {
  const arrayFields = [
    "contractChanges",
    "breakingCandidates",
    "risks",
    "unknowns",
    "impactedEdges",
    "unconsumedChanges",
    "unattachedFindings",
    "evaluations",
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(drift[field])) {
      throw invalid(
        `contractDrift D3 çıktısı doğrulanamadı: ${field} dizisi zorunludur (detectContractDrift çıktısı beklenir)`,
      );
    }
  }
  if (!Array.isArray(drift.rationale)) {
    throw invalid(
      "contractDrift D3 çıktısı doğrulanamadı: rationale dizisi zorunludur",
    );
  }
}

function driftEntryOf(
  item: ContractDriftItem,
  compatibility: VerifyContractDriftEntry["compatibility"],
): VerifyContractDriftEntry {
  return {
    matchKey: item.matchKey,
    contractId: item.contractId,
    name: item.name,
    changeKind: item.changeKind,
    compatibility,
    summary: item.summary,
  };
}

function findingJsonValue(finding: GuardFinding): JsonValue {
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    ruleType: finding.ruleType,
    severity: finding.severity,
    from: finding.from,
    to: finding.to,
    ...(finding.fromPath === undefined ? {} : { fromPath: finding.fromPath }),
    ...(finding.toPath === undefined ? {} : { toPath: finding.toPath }),
    evidenceIds: [...finding.evidenceIds],
    ...(finding.cycle === undefined ? {} : { cycle: [...finding.cycle] }),
    suppressed: finding.suppressed,
    ...(finding.suppression === undefined
      ? {}
      : {
          suppression: {
            reason: finding.suppression.reason,
            owner: finding.suppression.owner,
            date: finding.suppression.date,
          },
        }),
    snapshotId: finding.snapshotId,
  };
}

/**
 * Verify raporunu üretir: base ↔ working-tree karşılaştırması + istenen
 * dört denetim + deterministik verdict. Kod yazmaz; çalışma ağacını
 * değiştirmez; test çalıştırmaz (TŞ §10.4).
 */
export function verifyChange(input: VerifyChangeInput): VerificationReport {
  // 1) Snapshot durumu: base ve target ready/partial olmalı.
  assertSnapshotUsable(input.baseSnapshot, "baseSnapshot");
  assertSnapshotUsable(input.targetSnapshot, "targetSnapshot");

  // 2) İstenen denetimler: kanonik sıra (girdi sırası çıktıyı değiştirmez).
  const requestedChecks = normalizeChecks(input.checks);
  const requested = new Set<VerifyCheckName>(requestedChecks);

  // 3) preflightId: çözümleyici enjeksiyonu zorunlu; bilinmeyen kimlik sabit
  //    hata kodu (verification/preflight-not-found). preflightId ile beyan
  //    edilen kapsam birlikte verilmez (TŞ §10.2 örüntüsü).
  let manifest: PreflightManifest | undefined;
  if (input.preflightId !== undefined) {
    requireNonBlank("preflightId", input.preflightId);
    if (input.changedSymbols !== undefined || input.changedFiles !== undefined) {
      throw invalid(
        "preflightId ile changedSymbols/changedFiles birlikte verilmez (TŞ §10.2 'changeSet/preflightId?' — tam birini verin)",
      );
    }
    if (input.resolvePreflight === undefined) {
      throw new VerificationError(
        "verification/preflight-not-found",
        `preflightId çözümlenemedi (manifest çözümleyici sağlanmadı): ${input.preflightId}`,
      );
    }
    manifest = input.resolvePreflight(input.preflightId);
    if (manifest === undefined) {
      throw new VerificationError(
        "verification/preflight-not-found",
        `preflightId çözümlenemedi: bilinmeyen kimlik — ${input.preflightId}`,
      );
    }
    if (manifest.preflightId !== input.preflightId) {
      throw invalid(
        `çözümlenen manifest kimliği istenenle uyuşmuyor: istenen ${input.preflightId}, dönen ${manifest.preflightId}`,
      );
    }
  }

  // 4) Kapsam: manifest hedefleri → sembol (nodeId, yoksa qualifiedName) +
  //    dosya (yetkili yol); explicit changedSymbols/changedFiles → aynı
  //    yetkilendirme disiplini. Boş/blank üye invalid-input.
  const targetNodeIds = new Set(input.targetSnapshot.nodes.map((node) => node.id));
  let scopeSymbols: string[] = [];
  let scopeFiles: string[] = [];
  if (manifest !== undefined) {
    const fileTargets: string[] = [];
    for (const target of manifest.identifiedTargets) {
      requireNonBlank("manifest identifiedTargets üyesi", target.qualifiedName);
      if (target.origin === "file") fileTargets.push(target.qualifiedName);
      else {
        // nodeId yayımlanmış hedef snapshot'ta varsa en kesin çözüm odur
        // (aynı workspace kimliği + aynı node kimliği); yoksa qualifiedName
        // ile çözülmeye çalışılır (değişmemiş ağaçta uyuşur; çözülemezse
        // deriveTestPlan unresolved raporlar — otomatik kesinleştirme yok).
        scopeSymbols.push(targetNodeIds.has(target.nodeId) ? target.nodeId : target.qualifiedName);
      }
    }
    scopeFiles = authorizeScopeFiles(fileTargets, input.authorizeFile);
    scopeSymbols = sortedUnique(scopeSymbols);
  } else if (input.changedSymbols !== undefined || input.changedFiles !== undefined) {
    const symbols = input.changedSymbols ?? [];
    for (const symbol of symbols) requireNonBlank("changedSymbols üyesi", symbol);
    const files = input.changedFiles ?? [];
    scopeSymbols = sortedUnique(symbols);
    scopeFiles = authorizeScopeFiles(files, input.authorizeFile);
  }

  // 5) Observed test koşumu: E3 şema kapısı — evidenceRef ZORUNLU; kanıtsız
  //    koşum iddiası erken ve deterministik olarak reddedilir (TŞ §10.4).
  //    Motor kaydı doğrular; koşumu ASLA ÜRETMEZ.
  const observedRun = normalizeObservedRun(input.observedTestRun);

  // 6) graph-diff: base ↔ target içerik kümeleri (packages/graph compare
  //    çekirdeği; eşiği/skorlaması compare.ts'tedir).
  const diff = diffContentSets(
    toContentSet(input.baseSnapshot),
    toContentSet(input.targetSnapshot),
  );

  // Değişiklik kümesi dizgileri: tüm tarafların qualifiedName + yol birleşimi
  // (alignment ve graph-diff kanıt eşlemesi için); hedef taraflı sembol/yol
  // kümeleri kapsam türetmede kullanılır (kaldırılan semboller kapsam
  // SEMBOLÜ olamaz — hedef snapshot'ta yoktur; ama değişiklik dizgisi olarak
  // gözlenirler).
  const diffStrings = new Set<string>();
  const targetSideSymbols = new Set<string>();
  const targetSidePaths = new Set<string>();
  const collectIdentity = (identity: CompareNodeIdentity, targetSide: boolean): void => {
    diffStrings.add(identity.qualifiedName);
    if (targetSide) targetSideSymbols.add(identity.qualifiedName);
    if (identity.relativePath !== undefined) {
      diffStrings.add(identity.relativePath);
      if (targetSide) targetSidePaths.add(identity.relativePath);
    }
  };
  for (const change of diff.added) collectIdentity(change.node, true);
  for (const change of diff.changed) collectIdentity(change.node, true);
  for (const change of diff.removed) collectIdentity(change.node, false);
  for (const match of diff.renamed) {
    collectIdentity(match.from, false);
    collectIdentity(match.to, true);
  }
  for (const match of diff.uncertain) {
    collectIdentity(match.from, false);
    collectIdentity(match.to, true);
  }

  const unknowns: string[] = [];
  const limitations: string[] = [];
  const evidence = new Set<string>();

  // 7) architecture denetimi: C2 guard kuralları hedef snapshot üzerinde.
  let architecture: ArchitectureCheckResult;
  if (!requested.has("architecture")) {
    architecture = {
      status: "not_requested",
      findings: [],
      suppressedCount: 0,
      evidenceIds: [],
      limitations: [`"architecture" denetimi istenmedi (checks parametresi)`],
    };
  } else if (input.guardPolicy === undefined) {
    unknowns.push(
      "architecture denetimi değerlendirilemedi: guard policy sağlanmadı (parseArchitecturePolicy çıktısı beklenir)",
    );
    architecture = {
      status: "not_evaluated",
      findings: [],
      suppressedCount: 0,
      evidenceIds: [],
      limitations: [
        "architecture denetimi değerlendirilemedi: guard policy sağlanmadı (parseArchitecturePolicy çıktısı beklenir)",
      ],
    };
  } else {
    const usedDefaultBaseline = input.guardBaseline === undefined;
    const findings = findViolations(
      input.targetSnapshot,
      input.guardPolicy,
      input.guardBaseline ?? EMPTY_BASELINE,
    );
    const suppressedCount = findings.filter((finding) => finding.suppressed).length;
    for (const finding of findings) {
      for (const id of finding.evidenceIds) evidence.add(id);
    }
    architecture = {
      status: "evaluated",
      findings,
      suppressedCount,
      evidenceIds: sortedUnique(findings.flatMap((finding) => [...finding.evidenceIds])),
      limitations: usedDefaultBaseline
        ? ["guardBaseline sağlanmadı; boş suppression kümesi uygulandı"]
        : [],
    };
  }
  limitations.push(...architecture.limitations);

  // 8) contracts denetimi: D2/D3 kayıtlarının sınıflama eşlemesi (kaynak
  //    sınıflama korunur; uydurma sınıflama yok — D4 eşleme disiplini).
  let contracts: ContractsCheckResult;
  let contractDriftEntries: VerifyContractDriftEntry[] = [];
  if (!requested.has("contracts")) {
    contracts = {
      status: "not_requested",
      drift: [],
      unconsumedChanges: [],
      evidenceIds: [],
      limitations: [`"contracts" denetimi istenmedi (checks parametresi)`],
    };
  } else if (input.contractDrift === undefined) {
    const note =
      "contracts denetimi değerlendirilemedi: D2/D3 drift sonucu sağlanmadı (detectContractDrift çıktısı beklenir)";
    unknowns.push(note);
    contracts = {
      status: "not_evaluated",
      drift: [],
      unconsumedChanges: [],
      evidenceIds: [],
      limitations: [note],
    };
  } else {
    const drift = input.contractDrift;
    assertDriftResult(drift);
    contractDriftEntries = [
      ...drift.breakingCandidates.map((item) => driftEntryOf(item, "breaking_candidate")),
      ...drift.risks.map((item) => driftEntryOf(item, "risk")),
      ...drift.unknowns.map((item) => driftEntryOf(item, "unknown")),
    ].sort(
      (a, b) =>
        cmp(a.matchKey, b.matchKey) ||
        cmp(a.contractId, b.contractId) ||
        cmp(a.compatibility, b.compatibility),
    );
    const unconsumedChanges = [...drift.unconsumedChanges].sort(
      (a, b) =>
        cmp(a.contractId, b.contractId) ||
        cmp(a.changeKind, b.changeKind) ||
        cmp(a.summary, b.summary),
    );
    for (const entry of contractDriftEntries) {
      if (entry.compatibility === "unknown") {
        unknowns.push(
          `sözleşme "${entry.contractId}" (${entry.matchKey}): sınıflama unknown — ${entry.summary}`,
        );
      }
    }
    for (const change of unconsumedChanges) {
      unknowns.push(
        `sözleşme "${change.contractId}": tüketici kenarı bulunamadı; etki değerlendirilemedi (unresolved consumers)`,
      );
    }
    contracts = {
      status: "evaluated",
      drift: contractDriftEntries,
      unconsumedChanges,
      evidenceIds: [], // D2/D3 kanıtı span tabanlıdır; Evidence kaydı kimliği taşımaz
      limitations: [
        "contracts denetimi D2/D3 kayıtlarını yansıtır; sözleşme uyumluluğu framework/serializer/runtime'a göre farklılaşabilir (TŞ §11 unknown ilkesi)",
      ],
    };
  }
  limitations.push(...contracts.limitations);

  // 9) graph-diff denetimi: her zaman değerlendirilebilir (girdi veridir).
  const graphDiffEvidenceIds: string[] = [];
  if (requested.has("graph-diff")) {
    for (const record of [...input.baseSnapshot.evidence, ...input.targetSnapshot.evidence]) {
      if (record.span !== undefined && diffStrings.has(record.span.relativePath)) {
        graphDiffEvidenceIds.push(record.id);
        evidence.add(record.id);
      }
    }
  }
  const diffTotal =
    diff.summary.added +
    diff.summary.removed +
    diff.summary.changed +
    diff.summary.renamed +
    diff.summary.uncertain +
    diff.summary.edgeAdded +
    diff.summary.edgeRemoved +
    diff.summary.edgeChanged;
  const graphDiff: GraphDiffCheckResult = {
    status: requested.has("graph-diff") ? "evaluated" : "not_requested",
    diffSummary: diff.summary,
    apiSurfaceChanges: diff.summary.apiSurfaceChanges,
    evidenceIds: sortedUnique(graphDiffEvidenceIds),
    limitations: requested.has("graph-diff")
      ? diffTotal === 0
        ? ["graph-diff: taban ile hedef içerik kümesi özdeş (node/edge değişikliği yok)"]
        : []
      : [`"graph-diff" denetimi istenmedi (checks parametresi)`],
  };
  limitations.push(...graphDiff.limitations);

  // 10) test-plan denetimi: D6 adayları; kapsam yoksa diff'ten türetilir.
  //     E3: aday durumları VARSAYILAN not_run; observed yalnızca kanıtlı
  //     kaydın explicit testNames bağlamasıyla (testNodeId veya tam
  //     testQualifiedName; birebir eşleşme, uydurma kapsama yok).
  let testPlan: TestPlanCheckResult;
  let scopeUnresolved = 0;
  if (!requested.has("test-plan")) {
    testPlan = {
      status: "not_requested",
      run: testStatusOf(0, observedRun),
      derivedFrom: scopeSymbols.length > 0 || scopeFiles.length > 0 ? "scope" : "graph-diff",
      recommendedCount: 0,
      candidates: [],
      candidateStatuses: [],
      missingCoverageCandidates: [],
      unresolvedTargets: [],
      evidenceIds: observedRun === undefined ? [] : [...observedRun.evidenceIds],
      limitations: [`"test-plan" denetimi istenmedi (checks parametresi)`],
    };
  } else {
    // Kapsam çözümü: beyan edilen kapsam (preflight/explicit) önceliklidir;
    // yoksa değişiklik kümesi graph-diff'ten TÜRETİLİR (E1/E3: diff boş
    // değilken adaylar asla boş planla geçiştirilmez — dürüstlük).
    const derivedScope: VerifyScope =
      scopeSymbols.length > 0 || scopeFiles.length > 0
        ? { source: "scope", changedSymbols: scopeSymbols, changedFiles: scopeFiles }
        : {
            source: "graph-diff",
            changedSymbols: sortedUnique(targetSideSymbols),
            changedFiles: sortedUnique(targetSidePaths),
          };
    if (derivedScope.changedSymbols.length === 0 && derivedScope.changedFiles.length === 0) {
      // Gerçekten boş değişiklik kümesi (diff boş): D6 boş kümeyle çağrılmaz
      // (çekirdek boş küme reddeder) — dürüst boş plan + gerekçe.
      testPlan = {
        status: "evaluated",
        run: testStatusOf(0, observedRun),
        derivedFrom: derivedScope.source,
        recommendedCount: 0,
        candidates: [],
        candidateStatuses: [],
        missingCoverageCandidates: [],
        unresolvedTargets: [],
        evidenceIds: observedRun === undefined ? [] : [...observedRun.evidenceIds],
        limitations: [
          "test planı boş: taban ile hedef özdeş (değişiklik kümesi boş) — test adayı türetilemez; çalıştırma kararı kullanıcı/host akışına aittir",
        ],
      };
      limitations.push(...testPlan.limitations);
    } else {
      const plan = deriveTestPlan(input.targetSnapshot, {
        changedSymbols: derivedScope.changedSymbols,
        changedFiles: derivedScope.changedFiles,
      });
      scopeUnresolved = plan.unresolvedSymbols.length;
      for (const unresolved of plan.unresolvedSymbols) {
        unknowns.push(unresolved.reason);
      }
      const boundNames = new Set(observedRun?.testNames ?? []);
      const candidateStatuses: VerifyTestCandidateStatus[] = plan.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        testNodeId: candidate.testNodeId,
        testQualifiedName: candidate.testQualifiedName,
        status:
          boundNames.has(candidate.testNodeId) || boundNames.has(candidate.testQualifiedName)
            ? ("observed" as const)
            : ("not_run" as const),
      }));
      const candidateEvidence = plan.candidates.flatMap(
        (candidate: TestPlanCandidate) => [...candidate.evidenceIds],
      );
      const planEvidence =
        observedRun === undefined
          ? candidateEvidence
          : [...candidateEvidence, ...observedRun.evidenceIds];
      for (const id of planEvidence) evidence.add(id);
      testPlan = {
        status: scopeUnresolved > 0 ? "partial" : "evaluated",
        run: testStatusOf(plan.summary.totalCandidates, observedRun),
        derivedFrom: derivedScope.source,
        recommendedCount: plan.summary.totalCandidates,
        candidates: plan.candidates,
        candidateStatuses,
        missingCoverageCandidates: plan.missingCoverageCandidates,
        unresolvedTargets: plan.unresolvedSymbols,
        evidenceIds: sortedUnique(planEvidence),
        limitations: plan.rationales,
      };
    }
  }
  limitations.push(...testPlan.limitations);
  // Bağlanamayan testNames üyeleri SESSİZCE DÜŞÜRÜLMEZ (dürüstlük):
  // explicit bağlama birebirdir; uymayan ad limitation ile raporlanır.
  if (observedRun !== undefined && observedRun.testNames.length > 0) {
    for (const name of observedRun.testNames) {
      const matched = testPlan.candidates.some(
        (candidate) => candidate.testNodeId === name || candidate.testQualifiedName === name,
      );
      if (!matched) {
        limitations.push(
          `observed kaydın testNames üyesi hiçbir test adayına bağlanmadı: "${name}" (bağlama explicit ve birebirdir; uydurma kapsama yok)`,
        );
      }
    }
  }
  if (observedRun !== undefined) {
    limitations.push(
      `test koşumu observed kaydedildi: ${String(observedRun.observedCount)} test; kanıt: ${observedRun.evidenceRef}` +
        `${observedRun.evidenceSha256 === undefined ? "" : ` (sha256: ${observedRun.evidenceSha256})`}` +
        " (Causoryn test çalıştırmaz; kayıt host kanıtıdır — TŞ §10.4)",
    );
  }

  // 11) preflight hizası: D4 hedefleri gerçek değişiklik kümesinde görüldü mü
  //     (bilgilendirme; inconclusive YAPMAZ — değişiklik yokluğu beklenen bir
  //     durumdur).
  let alignment: PreflightAlignment | undefined;
  if (manifest !== undefined) {
    const targets = manifest.identifiedTargets.map((target) => ({
      target: target.qualifiedName,
      origin: target.origin,
      observedInDiff: diffStrings.has(target.qualifiedName),
    }));
    const anyObserved = targets.some((target) => target.observedInDiff);
    if (!anyObserved && targets.length > 0) {
      limitations.push(
        `preflight hedeflerinin hiçbiri değişiklik kümesinde gözlenmedi (${String(targets.length)} hedef; bilgilendirme — inconclusive değildir)`,
      );
    }
    alignment = { preflightId: manifest.preflightId, targets, anyObserved };
  }

  // 12) verdict: deterministik kural zinciri (E2; öncelik sırası — ilk
  //     uygulanan kural karar verir, kalan uygulanmış kurallar rationale'a
  //     bilgi amacıyla yazılır; bkz. types.ts VERIFY_VERDICT_RULES belgesi).
  const unsuppressedErrors = architecture.findings.filter(
    (finding) => !finding.suppressed && finding.severity === "error",
  ).length;
  const unsuppressedNonErrors = architecture.findings.filter(
    (finding) => !finding.suppressed && finding.severity !== "error",
  ).length;
  const suppressedFindings = architecture.suppressedCount;
  const breakingCount = contractDriftEntries.filter(
    (entry) => entry.compatibility === "breaking_candidate",
  ).length;
  const reviewContractCount = contractDriftEntries.filter(
    (entry) => entry.compatibility !== "breaking_candidate",
  ).length;
  const notEvaluatedNames = requestedChecks.filter((name) => {
    if (name === "architecture") return architecture.status === "not_evaluated";
    if (name === "contracts") return contracts.status === "not_evaluated";
    // graph-diff veri tabanlıdır (her zaman evaluated); test-plan
    // not_evaluated durumu üretmez (evaluated | partial | not_requested).
    return false;
  });

  const rationale: VerifyVerdictRule[] = [];
  if (unsuppressedErrors > 0 || breakingCount > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.blockingFinding,
      detail:
        `${String(unsuppressedErrors)} baskılanmamış error guard bulgusu` +
        ` ve/veya ${String(breakingCount)} breaking_candidate drift kaydı` +
        `${architecture.findings.some((finding) => !finding.suppressed && finding.severity === "error") ? ` (ruleId: ${[...new Set(architecture.findings.filter((finding) => !finding.suppressed && finding.severity === "error").map((finding) => finding.ruleId))].sort(cmp).join(", ")})` : ""}`,
    });
  }
  if (notEvaluatedNames.length > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.missingInput,
      detail: `değerlendirilemeyen istenen denetim(ler): ${notEvaluatedNames.join(", ")} (girdi eksik / policy reddi — denetim koşulamadı)`,
    });
  }
  if (suppressedFindings > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.suppressedFinding,
      detail: `${String(suppressedFindings)} bulgu baseline suppression ile baskılandı; yönetişim incelemesi gerekir`,
    });
  }
  if (scopeUnresolved > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.unresolvedTarget,
      detail: `${String(scopeUnresolved)} kapsam hedefi hedef snapshot'ta çözülemedi; kapsamın bu bölümü denetlenemedi`,
    });
  }
  if (unsuppressedNonErrors > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.warningFinding,
      detail: `${String(unsuppressedNonErrors)} baskılanmamış warning/info guard bulgusu`,
    });
  }
  if (reviewContractCount > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.contractRisk,
      detail: `${String(reviewContractCount)} risk/unknown sınıflı contract drift kaydı`,
    });
  }
  if (graphDiff.apiSurfaceChanges > 0) {
    rationale.push({
      rule: VERIFY_VERDICT_RULES.apiSurface,
      detail: `${String(graphDiff.apiSurfaceChanges)} API yüzeyi (endpoint/contract türleri) değişimi`,
    });
  }

  let verdict: VerifyVerdict;
  if (rationale.length === 0) {
    verdict = "no_findings";
    rationale.push({
      rule: VERIFY_VERDICT_RULES.cleanResolved,
      detail: "hiçbir bulgu/belirsizlik sinyali yok; tüm istenen denetimler evaluated",
    });
  } else {
    verdict = verdictOfFirstRule(rationale[0] ?? { rule: VERIFY_VERDICT_RULES.cleanResolved, detail: "" });
  }

  // E2 eksik denetim listesi: istenen denetimlerden not_evaluated veya
  // partial durumda olanlar (kanonik sıra; not_requested dahil değildir).
  const statusOfCheck = (name: VerifyCheckName): VerifyCheckStatus => {
    if (name === "architecture") return architecture.status;
    if (name === "contracts") return contracts.status;
    if (name === "graph-diff") return graphDiff.status;
    return testPlan.status;
  };
  const incompleteChecks = requestedChecks.filter((name) => {
    const status = statusOfCheck(name);
    return status === "not_evaluated" || status === "partial";
  });

  // E2 disclaimers: çekirdek uyarı HER raporda; not_run durumunda koşum
  // dürüstlüğü kaydı eklenir (TŞ §10.4: koşucu yok; iddia başarılı sayılmaz).
  const disclaimers: string[] = [NO_FINDINGS_CORE_DISCLAIMER];
  if (observedRun === undefined) {
    disclaimers.push(
      `test-plan durumu not_run: hiçbir test çalıştırılmadı; recommendedCount (${String(testPlan.recommendedCount)}) yalnızca aday listesidir (Causoryn test koşucusu içermez — TŞ §10.4)`,
    );
  }

  // 13) TŞ §10.4 üst düzey izdüşümleri + kanıt birleşimi.
  for (const id of architecture.evidenceIds) evidence.add(id);

  // E3: tests bloğu — koşum durumu dürüstlüğü (report.tests ile
  // checks.testPlan.run aynı değeri taşır); şema invariantları savunmada
  // yeniden doğrulanır (refine aktif her raporda koşar).
  const tests = testStatusOf(testPlan.recommendedCount, observedRun);
  assertTestStatusSchema(tests);

  const body: Omit<VerificationReport, "reportId"> = {
    baseSnapshotId: input.baseSnapshot.meta.id,
    targetSnapshotId: input.targetSnapshot.meta.id,
    targetRevision: "working-tree",
    ...(manifest === undefined ? {} : { preflightId: manifest.preflightId }),
    requestedChecks,
    verdict,
    verdictNote: NO_FINDINGS_DISCLAIMER,
    verdictRationale: rationale,
    incompleteChecks,
    disclaimers,
    findings: architecture.findings.filter((finding) => !finding.suppressed),
    contractDrift: contractDriftEntries,
    tests,
    unknowns: sortedUnique(unknowns),
    evidenceIds: sortedUnique(evidence),
    checks: { architecture, contracts, graphDiff, testPlan },
    ...(alignment === undefined ? {} : { preflightAlignment: alignment }),
    limitations: sortedUnique(limitations),
  };

  const contentHash = sha256Hex(utf8Encode(canonicalJson(reportBodyJsonValue(body))));
  return { reportId: `verification:${contentHash}`, ...body };
}

/* ------------------------------------------------------------------ */
/* Canonical JSON gövde kurucuları (manifest.ts örüntüsü; cast yok)    */
/* ------------------------------------------------------------------ */

function architectureCheckJsonValue(check: ArchitectureCheckResult): JsonValue {
  return {
    status: check.status,
    findings: check.findings.map(findingJsonValue),
    suppressedCount: check.suppressedCount,
    evidenceIds: [...check.evidenceIds],
    limitations: [...check.limitations],
  };
}

function contractsCheckJsonValue(check: ContractsCheckResult): JsonValue {
  return {
    status: check.status,
    drift: check.drift.map((entry) => ({
      matchKey: entry.matchKey,
      contractId: entry.contractId,
      name: entry.name,
      changeKind: entry.changeKind,
      compatibility: entry.compatibility,
      summary: entry.summary,
    })),
    unconsumedChanges: check.unconsumedChanges.map((change) => ({
      contractId: change.contractId,
      changeKind: change.changeKind,
      summary: change.summary,
    })),
    evidenceIds: [...check.evidenceIds],
    limitations: [...check.limitations],
  };
}

function graphDiffCheckJsonValue(check: GraphDiffCheckResult): JsonValue {
  const summary = check.diffSummary;
  return {
    status: check.status,
    diffSummary: {
      added: summary.added,
      removed: summary.removed,
      changed: summary.changed,
      renamed: summary.renamed,
      uncertain: summary.uncertain,
      unchangedNodes: summary.unchangedNodes,
      edgeAdded: summary.edgeAdded,
      edgeRemoved: summary.edgeRemoved,
      edgeChanged: summary.edgeChanged,
      edgeUnchanged: summary.edgeUnchanged,
      apiSurfaceChanges: summary.apiSurfaceChanges,
    },
    apiSurfaceChanges: check.apiSurfaceChanges,
    evidenceIds: [...check.evidenceIds],
    limitations: [...check.limitations],
  };
}

function testStatusJsonValue(status: VerifyTestStatus): JsonValue {
  if (status.status === "not_run") {
    // E3: not_run dalında kanıt/passed alanları YAZILMAZ (fiziksel yokluk).
    return {
      status: status.status,
      recommendedCount: status.recommendedCount,
      observedCount: status.observedCount,
    };
  }
  return {
    status: status.status,
    recommendedCount: status.recommendedCount,
    observedCount: status.observedCount,
    evidenceRef: status.evidenceRef,
    ...(status.evidenceSha256 === undefined ? {} : { evidenceSha256: status.evidenceSha256 }),
    ...(status.evidenceIds === undefined ? {} : { evidenceIds: [...status.evidenceIds] }),
    ...(status.passed === undefined ? {} : { passed: status.passed }),
    ...(status.passedCount === undefined ? {} : { passedCount: status.passedCount }),
    ...(status.failedCount === undefined ? {} : { failedCount: status.failedCount }),
  };
}

function testPlanCheckJsonValue(check: TestPlanCheckResult): JsonValue {
  return {
    status: check.status,
    run: testStatusJsonValue(check.run),
    derivedFrom: check.derivedFrom,
    recommendedCount: check.recommendedCount,
    candidates: check.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      testNodeId: candidate.testNodeId,
      testQualifiedName: candidate.testQualifiedName,
      testKind: candidate.testKind,
      changedNodeId: candidate.changedNodeId,
      changedQualifiedName: candidate.changedQualifiedName,
      matchLevel: candidate.matchLevel,
      resolution: candidate.resolution,
      depth: candidate.depth,
      reason: candidate.reason,
      evidenceIds: [...candidate.evidenceIds],
      edges: candidate.edges.map((edgeRef) => ({
        edgeId: edgeRef.edgeId,
        kind: edgeRef.kind,
        from: edgeRef.from,
        to: edgeRef.to,
        resolution: edgeRef.resolution,
        evidenceIds: [...edgeRef.evidenceIds],
      })),
    })),
    candidateStatuses: check.candidateStatuses.map((entry) => ({
      candidateId: entry.candidateId,
      testNodeId: entry.testNodeId,
      testQualifiedName: entry.testQualifiedName,
      status: entry.status,
    })),
    missingCoverageCandidates: check.missingCoverageCandidates.map((candidate) => ({
      nodeId: candidate.nodeId,
      kind: candidate.kind,
      qualifiedName: candidate.qualifiedName,
      reason: candidate.reason,
    })),
    unresolvedTargets: check.unresolvedTargets.map((unresolved) => ({
      target: unresolved.target,
      reason: unresolved.reason,
    })),
    evidenceIds: [...check.evidenceIds],
    limitations: [...check.limitations],
  };
}

function alignmentJsonValue(alignment: PreflightAlignment): JsonValue {
  return {
    preflightId: alignment.preflightId,
    targets: alignment.targets.map((target) => ({
      target: target.target,
      origin: target.origin,
      observedInDiff: target.observedInDiff,
    })),
    anyObserved: alignment.anyObserved,
  };
}

/** reportId karmasına giren gövde (kimlik alanı hariç tüm rapor). */
function reportBodyJsonValue(
  body: Omit<VerificationReport, "reportId">,
): Record<string, JsonValue> {
  return {
    baseSnapshotId: body.baseSnapshotId,
    targetSnapshotId: body.targetSnapshotId,
    targetRevision: body.targetRevision,
    ...(body.preflightId === undefined ? {} : { preflightId: body.preflightId }),
    requestedChecks: [...body.requestedChecks],
    verdict: body.verdict,
    verdictNote: body.verdictNote,
    verdictRationale: body.verdictRationale.map((rule) => ({
      rule: rule.rule,
      detail: rule.detail,
    })),
    incompleteChecks: [...body.incompleteChecks],
    disclaimers: [...body.disclaimers],
    findings: body.findings.map(findingJsonValue),
    contractDrift: body.contractDrift.map((entry) => ({
      matchKey: entry.matchKey,
      contractId: entry.contractId,
      name: entry.name,
      changeKind: entry.changeKind,
      compatibility: entry.compatibility,
      summary: entry.summary,
    })),
    tests: testStatusJsonValue(body.tests),
    unknowns: [...body.unknowns],
    evidenceIds: [...body.evidenceIds],
    checks: {
      architecture: architectureCheckJsonValue(body.checks.architecture),
      contracts: contractsCheckJsonValue(body.checks.contracts),
      graphDiff: graphDiffCheckJsonValue(body.checks.graphDiff),
      testPlan: testPlanCheckJsonValue(body.checks.testPlan),
    },
    ...(body.preflightAlignment === undefined
      ? {}
      : { preflightAlignment: alignmentJsonValue(body.preflightAlignment) }),
    limitations: [...body.limitations],
  };
}

/**
 * Raporun canonical JSON seri hâli — sprint kapısı (Faz E "before/after
 * reproducibility") bu çıktının iki koşumda byte-deterministik olduğunu
 * test ile kanıtlar. Saat/rastgelelik alanı içermez.
 */
export function serializeVerificationReport(report: VerificationReport): string {
  return canonicalJson({
    ...reportBodyJsonValue(report),
    reportId: report.reportId,
  });
}
