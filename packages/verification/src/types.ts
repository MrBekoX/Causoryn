import type {
  ArchitectureBaseline,
  ArchitecturePolicy,
  ArchitectureDiff,
  GuardFinding,
} from "@causoryn/graph";
import type {
  ContractDriftResult,
  ContractChangeRecord,
} from "@causoryn/contracts";
import type {
  PreflightManifest,
  TestPlanCandidate,
  TestPlanMissingCoverageCandidate,
  TestPlanUnresolvedSymbol,
} from "@causoryn/preflight";
import type { SnapshotGraph } from "@causoryn/domain";

/**
 * causoryn_verify_change rapor sözleşmesi — sprint-6 E1 (TŞ v2.1 §10.4).
 *
 * TŞ §10.4 yanıt gövdesinin bire bir karşılığı: baseSnapshotId,
 * targetSnapshotId, verdict, architectureFindings, contractDrift, tests
 * {state/recommendedCount/observedCount}, unknowns, evidenceIds — artı
 * E1'in "her check kendi sonucunu + kanıtlarını taşır" sözleşmesi için
 * `checks` bölümü. Alan sadakati (sprint-6 takım denetimi hizalaması):
 * TŞ örneğindeki üst düzey `architectureFindings` ve koşum bloğunun
 * `state` ayırıcısı IDENTİK taşınır (önceki `findings`/`tests.status`
 * sapmaları kaldırıldı — identifiedTargets/impactCandidates örüntüsü).
 *
 * Dürüstlük sabitleri (TŞ §10.4 metni): "verdict değerleri no_findings |
 * review_required | blocking_findings | inconclusive olabilir. no_findings
 * güvenli/correct kod garantisi değildir. Test runner varsayılan kurulmaz
 * veya otomatik çalıştırılmaz. Host'un yaptığı test koşuları ancak
 * dosya/provenance veya açıkça verilen doğrulanabilir test raporuyla
 * observed olarak kaydedilebilir; iddia ile başarılı sayılmaz."
 */

/** TŞ §10.4 girdisindeki checks kümesi. */
export type VerifyCheckName = "architecture" | "contracts" | "graph-diff" | "test-plan";

/** Kanonik check sırası (girdi dizi sırası çıktıyı değiştirmez — TŞ §8 vi). */
export const VERIFY_CHECK_NAMES: readonly VerifyCheckName[] = [
  "architecture",
  "contracts",
  "graph-diff",
  "test-plan",
];

/** TŞ §10.4 verdict sözlüğü. */
export type VerifyVerdict =
  | "no_findings"
  | "review_required"
  | "blocking_findings"
  | "inconclusive";

/**
 * E2 verdict geçiş kuralı kimlikleri — sabit, deterministik öncelik zinciri.
 * Karar sırası (ilk uygulanan kural karar verir; kalan uygulanmış kurallar
 * rationale'a bilgi amacıyla yazılır):
 *   1. blocking-finding  : baskılanmamış error guard bulgusu veya
 *     breaking_candidate contract drift → blocking_findings (sert bulgu
 *     hiçbir sinyalle yumuşatılmaz).
 *   2. missing-input     : İSTENEN bir denetim not_evaluated (girdi eksik /
 *     policy reddi — denetim koşulamadı) → inconclusive; tamamlanmamış
 *     değerlendirme review_required izlenimi VEREMEZ.
 *   2b. untrusted-rules  : architecture evaluated with working-tree rules
 *     (not from a trusted git ref) → review_required.
 *   3. suppressed-finding: suppression uygulanmış bulgu (baseline istisnası;
 *     yönetişim incelemesi gerekir) → review_required.
 *   4. unresolved-target : kapsam hedefi hedef snapshot'ta çözülemedi →
 *     review_required (tam çözümlü değil; bulgu yoktur ama kapsamın bir
 *     bölümü denetlenemedi).
 *   5. warning-finding   : baskılanmamış warning/info guard bulgusu →
 *     review_required.
 *   6. contract-risk     : risk/unknown sınıflı contract drift kaydı →
 *     review_required.
 *   7. api-surface       : API yüzeyi (endpoint/contract türleri) değişimi →
 *     review_required.
 *   8. clean-and-resolved: hiçbir sinyal yok + tüm istenen denetimler
 *     evaluated → no_findings (disclaimers ZORUNLU eşlik eder).
 */
export const VERIFY_VERDICT_RULES = {
  blockingFinding: "blocking-finding",
  missingInput: "missing-input",
  /**
   * The architecture check was evaluated with rules (and baseline) read from
   * the working tree instead of a trusted git ref, so the change under
   * verification could have weakened them → review_required. Placed after
   * missing-input and before every other review rule: a clean architecture
   * result is never reported as no_findings when its rules are untrusted.
   */
  untrustedRules: "untrusted-rules",
  suppressedFinding: "suppressed-finding",
  unresolvedTarget: "unresolved-target",
  warningFinding: "warning-finding",
  contractRisk: "contract-risk",
  apiSurface: "api-surface",
  cleanResolved: "clean-and-resolved",
} as const;

/** VERIFY_VERDICT_RULES üye kimlikleri. */
export type VerifyVerdictRuleId =
  (typeof VERIFY_VERDICT_RULES)[keyof typeof VERIFY_VERDICT_RULES];

/** Tek verdict kural kaydı: hangi kural, neden uygulandı. */
export interface VerifyVerdictRule {
  readonly rule: VerifyVerdictRuleId;
  /** İnsan-okur gerekçe (deterministik; sayılar String() ile yazılır). */
  readonly detail: string;
}

/**
 * E2 dürüstlük çekirdek uyarısı — TŞ §10.4 "no_findings güvenli/correct kod
 * garantisi değildir" hükmünün rapor yüzeyindeki birebir karşılığı. HER
 * raporun `disclaimers` alanında bulunur (yalnızca no_findings'te değil:
 * dürüstlük notu verdict'ten bağımsızdır).
 *
 * Kelime seçimi bilinçlidir (sprint-6 kapısı, wiki/sprint-6.md): "testler
 * koşulmadıysa rapor asla 'geçti' DEMEZ" — bu sabit ve tüm rapor dizgileri
 * 'geçti' kökünü TAŞIMAZ (koşum iddiası yalnızca kanıtlı observed kaydıyla
 * mümkündür; kapı testi ham substring aramasıdır).
 */
export const NO_FINDINGS_CORE_DISCLAIMER =
  "no_findings only means the rule-based checks completed without issues; it is not a guarantee of code correctness or security; if tests were not run, behavior changes are unverified";

/**
 * Tekil denetim durumu:
 * - evaluated    : denetim koştu ve tamamlandı (bulgu boş olabilir).
 * - partial      : denetim koştu ama kapsamın bir bölümü çözülemedi.
 * - not_evaluated: İSTENDİ ama girdi eksikliğinden koşulamadı (verdict'e
 *   inconclusive olarak katkı verir).
 * - not_requested: checks parametresiyle istenmedi (verdict hesabına girmez;
 *   limitation ile raporlanır).
 */
export type VerifyCheckStatus =
  | "evaluated"
  | "partial"
  | "not_evaluated"
  | "not_requested";

/**
 * TŞ §10.4 dürüstlük sabiti — HER raporda `verdictNote` olarak taşınır:
 * no_findings güvenli/doğru kod garantisi değildir.
 */
export const NO_FINDINGS_DISCLAIMER =
  "no_findings is NOT a guarantee of safe or correct code: it only means the requested checks produced no findings";

/** TŞ §10.4 girdisindeki targetRevision; bu çekirdek yalnızca working-tree destekler. */
export type VerifyTargetRevision = "working-tree";

/** Trust warning carried by reports whose architecture rules came from the working tree. */
export const UNTRUSTED_RULES_TRUST_WARNING =
  "architecture-rules-loaded-from-untrusted-working-tree" as const;

/**
 * Where the host loaded the architecture rules (`.causoryn/architecture.rules.yaml`)
 * and baseline from. The pure core cannot read git; the host states the
 * provenance and the core reflects it in the report and the verdict.
 *
 * - `source: "git-ref"`: rules came from the trusted git ref `ref`, resolved
 *   to `commit`. This is trusted even when `ref` is an old commit: choosing
 *   the base ref is the caller's decision, and the report names it.
 * - `source: "working-tree"`: rules came from the working tree (no rules file
 *   at the ref, or the ref could not be read). Untrusted: the change under
 *   verification may have edited them.
 */
export interface VerifyRulesProvenance {
  readonly source: "git-ref" | "working-tree";
  /** Git ref consulted as the trusted base (also reported when falling back). */
  readonly ref?: string;
  /** Commit the ref resolved to (only when the rules were read from git). */
  readonly commit?: string;
  /** How the ref was chosen: caller baseRef, preflight manifest HEAD, or the HEAD default. */
  readonly refOrigin?: "explicit" | "preflight-manifest" | "default-head";
  /** Why the working tree was used (only for `source: "working-tree"`). */
  readonly fallbackReason?: "rules-not-in-ref" | "ref-unreadable";
}

/** architecture denetimi sonucu: C2 guard bulguları (suppression işaretli). */
export interface ArchitectureCheckResult {
  readonly status: VerifyCheckStatus;
  /** findViolations çıktısı — suppressed kayıtlar dahil (yönetişim görünürlüğü). */
  readonly findings: readonly GuardFinding[];
  /** suppression ile baskılanmış bulgu sayısı. */
  readonly suppressedCount: number;
  readonly evidenceIds: readonly string[];
  readonly limitations: readonly string[];
}

/** TŞ §10.4 contractDrift kaydı: D2/D3 sınıflaması sözleşme başına. */
export interface VerifyContractDriftEntry {
  readonly matchKey: string;
  readonly contractId: string;
  readonly name: string;
  readonly changeKind: "added" | "removed" | "modified";
  readonly compatibility: "breaking_candidate" | "risk" | "unknown";
  readonly summary: string;
}

/** contracts denetimi sonucu (D2/D3 compatibility + drift kayıtları). */
export interface ContractsCheckResult {
  readonly status: VerifyCheckStatus;
  readonly drift: readonly VerifyContractDriftEntry[];
  /** Tüketici kenarı bulunamayan değişiklikler (unresolved consumers — TŞ §11). */
  readonly unconsumedChanges: readonly ContractChangeRecord[];
  readonly evidenceIds: readonly string[];
  readonly limitations: readonly string[];
}

/** graph-diff denetimi sonucu (base ↔ working-tree projeksiyonu). */
export interface GraphDiffCheckResult {
  readonly status: VerifyCheckStatus;
  /** compare çekirdeğinin sayısal özeti (ArchitectureDiff.summary). */
  readonly diffSummary: ArchitectureDiff["summary"];
  /** API yüzeyi (endpoint/contract türleri) değişim sayısı. */
  readonly apiSurfaceChanges: number;
  /** Değişen yollara span'ıyla bağlanan snapshot kanıt kayıtları. */
  readonly evidenceIds: readonly string[];
  readonly limitations: readonly string[];
}

/** test-plan denetimi sonucu: D6 adayları + koşum durumu dürüstlüğü (E3). */
export interface TestPlanCheckResult {
  readonly status: VerifyCheckStatus;
  /**
   * E3 koşum durumu (report.tests ile aynı değer): not_run varsayılan;
   * observed yalnızca kanıtlı kayıtla — passed/evidenceRef alanları
   * not_run dalında tip düzeyinde YOKTUR.
   */
  readonly run: VerifyTestStatus;
  /** Kapsamın kaynağı: beyan edilen kapsam (preflight/explicit) veya diff. */
  readonly derivedFrom: "scope" | "graph-diff";
  readonly recommendedCount: number;
  readonly candidates: readonly TestPlanCandidate[];
  /**
   * E3: aday başına koşum durumu — varsayılan not_run; observed yalnızca
   * kanıtlı kaydın explicit testNames bağlamasıyla (candidates ile aynı
   * kanonik sırada).
   */
  readonly candidateStatuses: readonly VerifyTestCandidateStatus[];
  readonly missingCoverageCandidates: readonly TestPlanMissingCoverageCandidate[];
  readonly unresolvedTargets: readonly TestPlanUnresolvedSymbol[];
  readonly evidenceIds: readonly string[];
  readonly limitations: readonly string[];
}

/** Preflight hedefinin gerçek değişiklik kümesiyle hizası (bilgi amaçlı). */
export interface PreflightAlignmentTarget {
  /** qualifiedName (sembol) veya kök-göreceli yol (dosya hedefi). */
  readonly target: string;
  readonly origin: "symbol" | "file";
  readonly observedInDiff: boolean;
}

/** D4 manifesti ↔ gerçek değişiklik kümesi hizası. */
export interface PreflightAlignment {
  readonly preflightId: string;
  readonly targets: readonly PreflightAlignmentTarget[];
  /** En az bir hedef diff'te gözlendi mi. */
  readonly anyObserved: boolean;
}

/**
 * Verify raporu. `preflightId` ve `preflightAlignment` yalnızca
 * preflightId verildiğinde ANAHTAR OLARAK bulunur (canonical JSON anahtar-
 * düzeyi yok sayım; exactOptionalPropertyTypes uyumlu opsiyonel alanlar);
 * `reportId` gövdenin canonical JSON SHA-256 karmasıdır (preflightId
 * örüntüsü) — aynı girdi → aynı rapor → aynı kimlik.
 */
export interface VerificationReport {
  readonly reportId: string;
  readonly baseSnapshotId: string;
  readonly targetSnapshotId: string;
  readonly targetRevision: VerifyTargetRevision;
  readonly preflightId?: string;
  /** Kanonik sıralı istenen denetim kümesi (girdi sırasından bağımsız). */
  readonly requestedChecks: readonly VerifyCheckName[];
  readonly verdict: VerifyVerdict;
  /** Sabit dürüstlük notu (NO_FINDINGS_DISCLAIMER) — her raporda bulunur. */
  readonly verdictNote: string;
  /**
   * E2: verdict kararının geldiği kural zinciri — öncelik sırasında
   * UYGULANAN tüm kurallar; [0] karar veren kuraldır (VERIFY_VERDICT_RULES
   * belgesindeki 1..8 sırası). Her karar hangi kuraldan geldiğiyle
   * raporlanır; uydurma kural kimliği üretilemez (sabit küme).
   */
  readonly verdictRationale: readonly VerifyVerdictRule[];
  /**
   * E2: eksik/kısmi denetim listesi — istenen denetimlerden durumu
   * not_evaluated (girdi eksik) veya partial (kısmi çözüm) olanlar, kanonik
   * sırada. not_requested denetimler listede YOK (istlenmemiştir).
   */
  readonly incompleteChecks: readonly VerifyCheckName[];
  /**
   * E2: açık dürüstlük uyarıları — her raporda en az
   * NO_FINDINGS_CORE_DISCLAIMER bulunur (no_findings güvenli/kod-dogruğu
   * garantisi değildir); not_run durumunda koşum dürüstlüğü kaydı eklenir.
   */
  readonly disclaimers: readonly string[];
  /**
   * Baskılanmamış architecture bulguları — TŞ §10.4 örnek yanıtındaki üst
   * düzey alan adıyla BİRE BİR ("architectureFindings", PDF s.11; sprint-6
   * takım denetimi hizalaması: eski `findings` sapması kaldırıldı ve
   * identifiedTargets/impactCandidates örüntüsündeki alan-sadakat
   * pratiğine bağlandı). checks.architecture.findings bölümündeki
   * baskılanmış kayıtlar dahil olmak üzere TÜM bulgular ayrıca
   * checks.architecture altında yönetişim görünürlüğüyle taşınır.
   */
  readonly architectureFindings: readonly GuardFinding[];
  /** TŞ contractDrift: sınıflı drift kayıtları. */
  readonly contractDrift: readonly VerifyContractDriftEntry[];
  /**
   * E3: TŞ §10.4 tests bloğu — koşum durumu dürüstlüğü (ayırıcı alan TŞ
   * örneğiyle birebir `state`: not_run|observed; observed'da evidenceRef
   * zorunlu; passed iddiası yalnızca kanıtlı ve gerçekten geçen raporda;
   * not_run dalında passed/evidenceRef tip düzeyinde yoktur).
   */
  readonly tests: VerifyTestStatus;
  readonly unknowns: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly checks: {
    readonly architecture: ArchitectureCheckResult;
    readonly contracts: ContractsCheckResult;
    readonly graphDiff: GraphDiffCheckResult;
    readonly testPlan: TestPlanCheckResult;
  };
  readonly preflightAlignment?: PreflightAlignment;
  readonly limitations: readonly string[];
  /**
   * Provenance of the architecture rules; present only when the architecture
   * check was requested and the host supplied it.
   */
  readonly rulesProvenance?: VerifyRulesProvenance;
  /** Set when the architecture rules were read from the untrusted working tree. */
  readonly trustWarning?: typeof UNTRUSTED_RULES_TRUST_WARNING;
}

/**
 * Dosya yetkilendirme kararı — WorkspaceAccessPolicy.checkFile kararının
 * yapısal kopyası (preflight/src/manifest.ts FileAuthorizationDecision ile
 * aynı sözleşme; paketler arası tip bağımlılığı kurulmadan yapısal eşleşme).
 */
export interface VerifyFileAuthorizationDecision {
  readonly allowed: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly relativePath?: string;
}

/** Deterministik dosya yetkilendirme işlevi (saf; girdi kök-göreceli yol). */
export type VerifyFileAuthorizer = (
  file: string,
) => VerifyFileAuthorizationDecision;

/**
 * E3: tek test adayının koşum durumu. VARSAYILAN not_run'dır; observed
 * yalnızca kanıtlı koşum kaydının explicit testNames bağlamasıyla mümkündür
 * (bağlama testNodeId veya tam testQualifiedName ile birebir yapılır;
 * isim benzerliği/fuzzy eşleşme YOKTUR — uydurma kapsama yok). Alan adı
 * bilinçli olarak `status`'tur: bu kayıt E3'ün kendi aday-başına yapısıdır
 * ve TŞ §10.4 örneğinde sayılmaz; TŞ'nin bire bir taşıdığı alan yalnızca
 * üst düzey tests bloğudur (orada ayırıcı `state`'dir).
 */
export interface VerifyTestCandidateStatus {
  readonly candidateId: string;
  readonly testNodeId: string;
  readonly testQualifiedName: string;
  readonly status: "not_run" | "observed";
}

/**
 * E3: koşum durumu — discriminated union. AYIRICI ALAN ADI TŞ §10.4 alan
 * sadakatiyle birebirdir: örnek yanıt gövdesi (PDF s.11) koşum bloğunu
 * {"state": "not_run", ...} olarak taşır — sprint-6 takım denetimi
 * bulgusunun hizalaması (tests.status sapması kaldırıldı). Dürüstlük
 * sözleşmesi tip düzeyinde sabittir: not_run dalında `passed` ve
 * `evidenceRef` alanları YOKTUR (üretimi derleyici hatasıdır); 'passed'
 * iddiası yalnızca observed dalında ve yalnızca `true` literal olarak
 * mümkündür (başarısız rapor asla passed:false ile temsil edilmez —
 * sayılar passedCount/failedCount taşır; iddia yalnızca kanıtlı ve
 * gerçekten geçen raporda yapılır). Şema düzeyinde karşılığı
 * TEST_RUN_STATUS_SCHEMA.superRefine'dır (test-status-schema.ts).
 */
export type VerifyTestStatus =
  | {
      /** Testler koşulmadı (varsayılan). */
      readonly state: "not_run";
      readonly recommendedCount: number;
      readonly observedCount: 0;
    }
  | {
      /** Host koşumu kanıtlı kayıtla doğrulandı (motor koşmaz — TŞ §10.4). */
      readonly state: "observed";
      readonly recommendedCount: number;
      readonly observedCount: number;
      /**
       * ZORUNLU (Zod refine): dosya/provenance kanıt referansı — kök-göreceli
       * rapor dosyası yolu veya doğrulanabilir test raporu referansı.
       */
      readonly evidenceRef: string;
      /** Kanıt dosyasının sha256 karması (dosya kanıtı: yol + hash). */
      readonly evidenceSha256?: string;
      readonly evidenceIds?: readonly string[];
      /**
       * 'passed' iddiası: yalnızca rapor gerçekten geçiyorsa (failedCount 0
       * && passedCount ≥ 1) true literal olarak taşınır; aksi hâlde alan
       * GİSINIR (passed:false yazılmaz — iddia yalnızca kanıtla).
       */
      readonly passed?: true;
      readonly passedCount?: number;
      readonly failedCount?: number;
    };

/**
 * Host'un yaptığı test koşumunun dürüst kaydı (E3, TŞ §10.4): observed
 * durumu YALNIZCA dosya/provenance kanıtıyla kabul edilir — evidenceRef
 * ZORUNLUDUR (OBSERVED_TEST_RUN_SCHEMA ile şema düzeyinde zorlanır);
 * kanıtsız koşum iddiası invalid-input ile reddedilir. Motor bu kaydı
 * DOĞRULAR, koşumu ASLA ÜRETMEZ (otomatik test koşucusu yasak). Ayırıcı
 * alan adı koşum çıktısıyla aynı söz dağarcığını taşır (`state` — TŞ §10.4
 * koşum bloğu alan sadakati).
 */
export interface ObservedTestRun {
  /** Sabit: bu bir koşum kaydıdır (not_run kaydı girdi olarak yoktur). */
  readonly state: "observed";
  /** ZORUNLU: kök-göreceli rapor dosyası yolu veya doğrulanabilir rapor referansı. */
  readonly evidenceRef: string;
  /** Rapor dosyasının sha256 karması (dosya kanıtı: yol + hash). */
  readonly evidenceSha256?: string;
  /** Koşumu destekleyen ek kanıt kimlikleri (provenance). */
  readonly evidenceIds?: readonly string[];
  /** En az 1 olmalı; 0 koşum "observed" olamaz. */
  readonly observedCount: number;
  /** Raporun geçen test sayısı (rapordan; 'passed' iddiasının tek kaynağı). */
  readonly passedCount?: number;
  /** Raporun failing test sayısı. */
  readonly failedCount?: number;
  /**
   * Kaydın kapsadığı adaylar: testNodeId veya TAM testQualifiedName.
   * Bu alanla bağlanan adayların candidateStatuses durumu observed olur;
   * alan yoksa kayıt run-düzeyidir ve HİÇBİR adayı observed yapmaz
   * (kapsama iddiası yalnızca explicit bağlamayla mümkündür).
   */
  readonly testNames?: readonly string[];
}

/**
 * verifyChange girdisi. Çalışma ağacı SAFTIR: SnapshotGraph projeksiyonu
 * olarak girer (indexing katmanı dosyaları WorkspaceAccessPolicy üzerinden
 * okur); çekirdeğin kendi yüzeyinde dosya YALNIZCA kapsam hedefi olarak
 * geçer ve authorizeFile kararı olmadan kullanılamaz (fail-closed).
 */
export interface VerifyChangeInput {
  /** Yayımlanmış taban snapshot (before). */
  readonly baseSnapshot: SnapshotGraph;
  /** Çalışma ağacı projeksiyonu (after; policy üzerinden üretilmiş). */
  readonly targetSnapshot: SnapshotGraph;
  /** İstenen denetimler; varsayılan VERIFY_CHECK_NAMES tamamı. */
  readonly checks?: readonly VerifyCheckName[];
  /** D4 manifest kimliği; resolvePreflight ile çözülür. */
  readonly preflightId?: string;
  /** preflightId çözümleyici (manifest deposu host katmanındadır). */
  readonly resolvePreflight?: (
    id: string,
  ) => PreflightManifest | undefined;
  /** Beyan edilen değişen semboller (preflightId yerine). */
  readonly changedSymbols?: readonly string[];
  /** Beyan edilen değişen dosyalar (preflightId yerine; yetki zorunlu). */
  readonly changedFiles?: readonly string[];
  /** Dosya yetkilendirme kararı; changedFiles/manifest dosya hedefi boş değilse ZORUNLU. */
  readonly authorizeFile?: VerifyFileAuthorizer;
  /** C2 guard kuralları (parseArchitecturePolicy çıktısı). */
  readonly guardPolicy?: ArchitecturePolicy;
  /** Suppression baseline (verilmezse boş küme uygulanır). */
  readonly guardBaseline?: ArchitectureBaseline;
  /** Where guardPolicy/guardBaseline were loaded from (see VerifyRulesProvenance). */
  readonly rulesProvenance?: VerifyRulesProvenance;
  /** D2/D3 drift sonucu (detectContractDrift çıktısı). */
  readonly contractDrift?: ContractDriftResult;
  /** Host test koşumu kaydı (kanıtsız → invalid-input). */
  readonly observedTestRun?: ObservedTestRun;
}
