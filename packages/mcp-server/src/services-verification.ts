import path from "node:path";

import {
  GuardError,
  InMemoryGraphRepository,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  type ArchitectureBaseline,
  type ArchitecturePolicy,
  type SnapshotRead,
} from "@causoryn/graph";
import { IndexService, IndexingError } from "@causoryn/indexing";
import type { PreflightManifest } from "@causoryn/preflight";
import type { SnapshotGraph } from "@causoryn/domain";
import {
  OBSERVED_TEST_RUN_SCHEMA,
  TEST_RUN_STATUS_SCHEMA,
  VerificationError,
  verifyChange,
  type VerificationReport,
} from "@causoryn/verification";
import { z } from "zod";

import type { ServiceDeps } from "./services.js";
import {
  coverageOf,
  envelopeStatusOf,
  indexingErrorToToolError,
  requireAuthorizedWorkspace,
  staleWarningOf,
} from "./services.js";
import { graphErrorToToolError, GuardFindingSchema } from "./services-architecture.js";
import { CausorynToolError } from "./errors.js";
import { buildEnvelope, type Envelope } from "./envelope.js";
import type { PreflightManifestStore } from "./preflight-store.js";
import {
  readOptionalBoundedTextFile,
  type BoundedTextReadResult,
} from "./safe-file-read.js";

/**
 * Faz E uygulama servisi (sprint-6 causoryn_verify_change — Agent Change
 * Guard çekirdeğinin MCP yüzeyi; TŞ v2.1 §10.2 katalog satırı "preflightId/
 * baseSnapshot, target" + §10.4 Verify Change örneği ve dürüstlük hükmü).
 *
 * TŞ alan sadakati (birincil kaynak: raw/Causoryn_Teknik_Dokuman_v2.1.pdf,
 * PyMuPDF çıkarımı — s.10 katalog satırı, s.11 §10.4 örneği):
 * - Girdi katalogda "preflightId/baseSnapshot, target": preflightId VEYA
 *   baseSnapshot — EN AZ BİRİ zorunlu; ikisi birden verilirse uyumluluk
 *   çözümü uygulanır (manifest.baseSnapshotId = baseSnapshot kimliği;
 *   çelişki INVALID_ARGUMENT). "target" = targetRevision ve TŞ §10.4
 *   örneğinde yalnızca "working-tree" değerini taşır; bu çekirdek yalnızca
 *   working-tree desteklediğinden şema z.literal("working-tree").optional()
 *   ile sabitlenmiştir (başka değer şema reddidir).
 * - checks: TŞ §10.4 dört denetim kümesinin boş olmayan alt kümesi; yoksa
 *   tamamı istenir (çekirdek kanonik sıraya indirger — girdi sırası
 *   çıktıyı değiştirmez, TŞ §8 invariant vi).
 * - Yanıt: TŞ §10.4 gövdesi {baseSnapshotId, targetSnapshotId, verdict,
 *   architectureFindings, contractDrift, tests, unknowns, evidenceIds} +
 *   E1-E3 `checks`/`disclaimers`/`verdictRationale` bölümleri.
 *
 * DÜRÜSTLÜK YÜZEYİ (TŞ §10.4 metni, bire bir):
 * - no_findings güvenli/correct kod garantisi değildir → HER raporda
 *   disclaimers + verdictNote taşınır (çekirdek sözleşmesi).
 * - Test runner kurulmaz/çalıştırılmaz → motor koşum ÜRETMEZ; `observed`
 *   yalnızca OBSERVED_TEST_RUN_SCHEMA ile kanıtlı host kaydından gelir
 *   (evidenceRef zorunlu; kanıtsız koşum iddiası şema reddidir).
 * - contracts denetimi bu MCP yüzeyinden ÜRETİLEMEZ: TŞ §10.4 girdisinde
 *   sözleşme spec çifti yoktur ve istemciden sınıflama kaydı kabul edilmez
 *   (TŞ §11 "Server yalnızca statik delili ifade eder" — preflight
 *   contractChecks örüntüsü). contracts istenirse denetim not_evaluated
 *   raporlanır ve missing-input kuralı verdict'i INCONCLUSIVE yapar
 *   (tamamlanmamış değerlendirme review_required izlenimi veremez — E2).
 *   architecture denetimi için guard policy'si workspace kökündeki
 *   `.causoryn/architecture.rules.yaml`'dan yüklenir (check_architecture
 *   örüntüsü); dosya yoksa denetim not_evaluated olur (POLICY_INVALID
 *   DEĞİL — verify raporun DÖRT denetiminden biri eksiktür, tüm araçın
 *   reddi değildir); dosya var ama şema reddi ise POLICY_INVALID fırlatılır
 *   (check_architecture sözleşmesiyle aynı).
 *
 * ÇALIŞMA AĞACI PROJEKSİYONU (target): TŞ §10.4 "targetRevision:
 * working-tree" — hedef snapshot, IndexService (ApplicationService sınırı
 * 3: mcp-server parser paketi import etmez) ile ATIK bir InMemoryGraph
 * Repository üzerine koşulur. Atık depo yöntemi iki sözleşmeyi birden
 * korur: (1) gerçek repository/veri kökü DEĞİŞMEZ (verify salt-okunur
 * doğrulamadır; refresh_index'in yazma izni verify'e geçmez) ve
 * (2) byte-determinizm (sprint kapısı): her projeksiyon taze IndexService
 * ile revision.sequence=1'den koşar, snapshot kimliği createdAt'i içermez
 * (domain createSnapshot sözleşmesi) → aynı ağaç + aynı config = aynı
 * targetSnapshotId. Node kimlikleri workspaceId+kimlik kongresiyle taban
 * snapshot'ınkiyle bire bir karşılaştırılabilirdir.
 *
 * PREFLIGHT DEPOSU: preflight_change (services-differentiation.ts)
 * ürettiği manifesti sürecin PreflightManifestStore'una kaydeder; bu
 * servis preflightId'yi oradan çözer. Depo süreç-içidir: bilinmeyen
 * kimlik çekirdeğin sabit verification/preflight-not-found yolundan
 * INVALID_ARGUMENT ile reddedilir (D4 hata eşleme disiplini; yeni uzantı
 * kodu basılmaz — K-008 örüntüsü).
 */

/** verify servislerinin kullandığı deps: ServiceDeps + süreç-içi manifest deposu. */
export interface VerificationServiceDeps extends ServiceDeps {
  /** Sprint-6 Faz E: preflight_change'in manifest kaydettiği süreç-içi depo. */
  readonly preflightStore?: PreflightManifestStore;
}

/* ------------------------------------------------------------------ */
/* Hata eşlemesi (paket kodları → sabit tool kodu; tek nokta)           */
/* ------------------------------------------------------------------ */

/**
 * @causoryn/verification VerificationError → sabit tool hata kodu
 * (D4 preflightErrorToToolError disipliniyle birebir):
 * - verification/invalid-input        → INVALID_ARGUMENT (K-008 uzantısı)
 * - verification/preflight-not-found  → INVALID_ARGUMENT (bilinmeyen kimlik
 *   geçersiz girdidir; D4'ün "manifest deposu yok" open-ret'i ile aynı kod
 *   sınıfı. Yeni uzantı kodu BASILMAZ: TŞ §10.1 listesinde bire bir kod
 *   yoksa uzantı K-008 örüntüsüyle zaten var olan üçlüden seçilir)
 * - verification/file-not-authorized  → PATH_DENIED (salt-okunur erişim reddi)
 * - verification/snapshot-state       → INDEX_NOT_READY (publish sözleşmesi)
 */
export function verificationErrorToToolError(error: VerificationError): CausorynToolError {
  switch (error.code) {
    case "verification/invalid-input":
    case "verification/preflight-not-found":
      return new CausorynToolError("INVALID_ARGUMENT", error.message);
    case "verification/file-not-authorized":
      return new CausorynToolError("PATH_DENIED", error.message);
    case "verification/snapshot-state":
      return new CausorynToolError("INDEX_NOT_READY", error.message);
  }
}

/**
 * Paket hatalarını sabit tool kodlarına EŞLEYEN tek zincir (denetim bulgusu
 * F6: indexing/* eşlemesi artık TEK yerde — services.ts indexingErrorToTool-
 * Error yeniden kullanılır). Kodlanmamış yabancı hata olduğu gibi yükselir.
 * Eşlenemeyen hata CausorynToolError DEĞİLDİR: server.ts catch-all'ı ona
 * INTERNAL_ERROR verir — bu yüzden şema red sınıfı hatalar (GuardError vb.)
 * buradan mutlaka geçmelidir; async reddi için bkz. loadGuardInputs çağrı
 * yerindeki .catch(rethrowAsToolError).
 */
function rethrowAsToolError(error: unknown, requestId: string): never {
  if (error instanceof VerificationError) {
    throw verificationErrorToToolError(error);
  }
  if (error instanceof IndexingError) {
    throw indexingErrorToToolError(error, requestId);
  }
  if (error instanceof GuardError) {
    // Guard policy/baseline şema reddi: guard/* kodlarının sabit eşlemesi
    // (graphErrorToToolError → POLICY_INVALID; check_architecture sözleşmesi).
    throw graphErrorToToolError(error);
  }
  throw error;
}

/** Paket hatalarını sabit tool kodlarına eşleyerek koşturur (senkron). */
function runVerification<T>(work: () => T, requestId: string): T {
  try {
    return work();
  } catch (error) {
    rethrowAsToolError(error, requestId);
  }
}

/* ------------------------------------------------------------------ */
/* Girdi şeması (TŞ §10.2/§10.4 alanları)                               */
/* ------------------------------------------------------------------ */

export const VerifyChangeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "preflightId/baseSnapshot" — EN AZ BİRİ zorunlu. */
  preflightId: z.string().min(1).optional(),
  /** Taban yayın kimliği; preflightId ile birlikte UYUMLU olmalıdır. */
  baseSnapshot: z.string().min(1).optional(),
  /** TŞ §10.4 "targetRevision": çekirdek yalnızca working-tree destekler. */
  targetRevision: z.literal("working-tree").optional(),
  /** TŞ §10.4 "checks": dört denetimin boş olmayan alt kümesi; yoksa tamamı. */
  checks: z.enum(["architecture", "contracts", "graph-diff", "test-plan"])
    .array()
    .min(1)
    .optional(),
  /** E3: host koşum kaydı — evidenceRef ZORUNLU (kanıtsız iddia şema reddi). */
  observedTestRun: OBSERVED_TEST_RUN_SCHEMA.optional(),
});

/* ------------------------------------------------------------------ */
/* Çıktı şeması (TŞ §10.4 gövdesi + E1-E3 `checks` bölümleri)           */
/* ------------------------------------------------------------------ */

const VerifyCheckStatusSchema = z.enum([
  "evaluated",
  "partial",
  "not_evaluated",
  "not_requested",
]);

const VerifyVerdictRuleSchema = z.strictObject({
  rule: z.enum([
    "blocking-finding",
    "missing-input",
    "suppressed-finding",
    "unresolved-target",
    "warning-finding",
    "contract-risk",
    "api-surface",
    "clean-and-resolved",
  ]),
  detail: z.string(),
});

const VerifyContractDriftEntrySchema = z.strictObject({
  matchKey: z.string(),
  contractId: z.string(),
  name: z.string(),
  changeKind: z.enum(["added", "removed", "modified"]),
  compatibility: z.enum(["breaking_candidate", "risk", "unknown"]),
  summary: z.string(),
});

/** TestPlanCandidate — services-differentiation.ts TestPlanDataSchema adayıyla aynı sözleşme. */
const TestPlanCandidateSchema = z.strictObject({
  candidateId: z.string(),
  testNodeId: z.string(),
  testQualifiedName: z.string(),
  testKind: z.string(),
  changedNodeId: z.string(),
  changedQualifiedName: z.string(),
  matchLevel: z.enum(["direct", "naming", "call-site"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  depth: z.number().int().nonnegative(),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
  edges: z.array(
    z.strictObject({
      edgeId: z.string(),
      kind: z.string(),
      from: z.string(),
      to: z.string(),
      resolution: z.enum(["verified", "heuristic", "unresolved"]),
      evidenceIds: z.array(z.string()),
    }),
  ),
});

const ArchitectureCheckResultSchema = z.strictObject({
  status: VerifyCheckStatusSchema,
  findings: z.array(GuardFindingSchema),
  suppressedCount: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
});

const ContractsCheckResultSchema = z.strictObject({
  status: VerifyCheckStatusSchema,
  drift: z.array(VerifyContractDriftEntrySchema),
  unconsumedChanges: z.array(
    z.strictObject({
      contractId: z.string(),
      changeKind: z.enum(["added", "removed", "modified"]),
      summary: z.string(),
    }),
  ),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
});

const GraphDiffCheckResultSchema = z.strictObject({
  status: VerifyCheckStatusSchema,
  diffSummary: z.strictObject({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    renamed: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    unchangedNodes: z.number().int().nonnegative(),
    edgeAdded: z.number().int().nonnegative(),
    edgeRemoved: z.number().int().nonnegative(),
    edgeChanged: z.number().int().nonnegative(),
    edgeUnchanged: z.number().int().nonnegative(),
    apiSurfaceChanges: z.number().int().nonnegative(),
  }),
  apiSurfaceChanges: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
});

const TestPlanCheckResultSchema = z.strictObject({
  status: VerifyCheckStatusSchema,
  /** E3 koşum dürüstlüğü — TEST_RUN_STATUS_SCHEMA (superRefine) ile aynı şema. */
  run: TEST_RUN_STATUS_SCHEMA,
  derivedFrom: z.enum(["scope", "graph-diff"]),
  recommendedCount: z.number().int().nonnegative(),
  candidates: z.array(TestPlanCandidateSchema),
  candidateStatuses: z.array(
    z.strictObject({
      candidateId: z.string(),
      testNodeId: z.string(),
      testQualifiedName: z.string(),
      status: z.enum(["not_run", "observed"]),
    }),
  ),
  missingCoverageCandidates: z.array(
    z.strictObject({
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      reason: z.string(),
    }),
  ),
  unresolvedTargets: z.array(
    z.strictObject({ target: z.string(), reason: z.string() }),
  ),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
});

export const VerifyChangeDataSchema = z.strictObject({
  reportId: z.string(),
  baseSnapshotId: z.string(),
  targetSnapshotId: z.string(),
  targetRevision: z.literal("working-tree"),
  preflightId: z.string().optional(),
  requestedChecks: z.array(z.enum(["architecture", "contracts", "graph-diff", "test-plan"])),
  verdict: z.enum(["no_findings", "review_required", "blocking_findings", "inconclusive"]),
  verdictNote: z.string(),
  verdictRationale: z.array(VerifyVerdictRuleSchema),
  incompleteChecks: z.array(z.enum(["architecture", "contracts", "graph-diff", "test-plan"])),
  disclaimers: z.array(z.string()),
  // TŞ §10.4 örnek yanıtındaki üst düzey alan adıyla bire bir (PDF s.11;
  // sprint-6 takım denetimi hizalaması — eski `findings` sapması kaldırıldı).
  architectureFindings: z.array(GuardFindingSchema),
  contractDrift: z.array(VerifyContractDriftEntrySchema),
  tests: TEST_RUN_STATUS_SCHEMA,
  unknowns: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  checks: z.strictObject({
    architecture: ArchitectureCheckResultSchema,
    contracts: ContractsCheckResultSchema,
    graphDiff: GraphDiffCheckResultSchema,
    testPlan: TestPlanCheckResultSchema,
  }),
  preflightAlignment: z
    .strictObject({
      preflightId: z.string(),
      targets: z.array(
        z.strictObject({
          target: z.string(),
          origin: z.enum(["symbol", "file"]),
          observedInDiff: z.boolean(),
        }),
      ),
      anyObserved: z.boolean(),
    })
    .optional(),
  limitations: z.array(z.string()),
});

/* ------------------------------------------------------------------ */
/* Yardımcılar: hedef projeksiyon + guard girdisi + taban çözümü        */
/* ------------------------------------------------------------------ */

/**
 * Working-tree projeksiyonu (TŞ §10.4 target): IndexService ATIK bir
 * InMemoryGraphRepository üzerine koşulur. Gerçek repository ve veri kökü
 * DEĞİŞMEZ (verify salt-okunur doğrulamadır); projeksiyon snapshot kimliği
 * createdAt'i içermediğinden aynı ağaç + aynı config = aynı kimlik
 * (byte-determinizm sprint kapısı; bkz. dosya başlığı).
 */
function projectWorkingTree(
  deps: VerificationServiceDeps,
  canonicalRoot: string,
): { readonly snapshot: SnapshotGraph; readonly warnings: readonly string[] } {
  const scratch = new InMemoryGraphRepository();
  const projectionService = new IndexService({
    workspaceId: deps.config.workspaceId,
    policy: deps.policy,
    repository: scratch,
    clock: deps.clock,
    limits: { maxFiles: deps.config.index.maxFiles },
  });
  const run = projectionService.runIndex(canonicalRoot);
  return { snapshot: run.snapshot, warnings: run.warnings };
}

/**
 * Guard dosyasını TŞ §20 "dosya başına byte" bütçesiyle tek file handle
 * üzerinden sınırlı okur (CWE-367 TOCTOU'ya karşı open+fstat+bounded read).
 * Eksik dosya "missing".
 */
function readGuardText(
  absolutePath: string,
  maxBytes: number,
): Promise<BoundedTextReadResult> {
  return readOptionalBoundedTextFile(absolutePath, maxBytes);
}

/**
 * Guard girdisi: architecture denetimi istendiyse workspace kökündeki
 * policy (ve varsa baseline) çözümlenir. Policy YOKSA undefined döner
 * (çekirdekte not_evaluated → inconclusive; aracın TAMAMI reddedilmez);
 * şema reddi graphErrorToToolError üzerinden POLICY_INVALID olur (runVerification).
 */
async function loadGuardInputs(
  deps: VerificationServiceDeps,
  canonicalRoot: string,
  architectureRequested: boolean,
): Promise<{
  readonly guardPolicy: ArchitecturePolicy | undefined;
  readonly guardBaseline: ArchitectureBaseline | undefined;
  readonly warning: string | undefined;
}> {
  if (!architectureRequested) {
    return { guardPolicy: undefined, guardBaseline: undefined, warning: undefined };
  }
  const maxBytes = deps.config.maxFileBytes;
  const policyRead = await readGuardText(
    path.join(canonicalRoot, ".causoryn", "architecture.rules.yaml"),
    maxBytes,
  );
  if (policyRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `.causoryn/architecture.rules.yaml ${String(policyRead.bytes)} byte ile config.maxFileBytes tavanını (${String(maxBytes)}) aşıyor (TŞ §20 dosya başına byte bütçesi); policy dosyasını küçültün veya kuralları bölün`,
    );
  }
  if (policyRead.status !== "ok") {
    return {
      guardPolicy: undefined,
      guardBaseline: undefined,
      warning:
        "architecture denetimi değerlendirilemedi: workspace kökünde .causoryn/architecture.rules.yaml bulunamadı; guard kural dosyası oluşturun (yokluğu hataya değil, denetimin koşulamamasına yol açar — TŞ §10.4 inconclusive)",
    };
  }
  const baselineRead = await readGuardText(
    path.join(canonicalRoot, ".causoryn", "architecture.baseline.yaml"),
    maxBytes,
  );
  if (baselineRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `.causoryn/architecture.baseline.yaml ${String(baselineRead.bytes)} byte ile config.maxFileBytes tavanını (${String(maxBytes)}) aşıyor (TŞ §20 dosya başına byte bütçesi); baseline dosyasını küçültün`,
    );
  }
  const policy = parseArchitecturePolicy(policyRead.text);
  const baseline =
    baselineRead.status === "ok" ? parseArchitectureBaseline(baselineRead.text) : undefined;
  return { guardPolicy: policy, guardBaseline: baseline, warning: undefined };
}

/** Taban yayın kimliğini çözer (services-differentiation resolveEnvelopeSnapshot örüntüsü). */
function resolveBaseSnapshot(
  deps: VerificationServiceDeps,
  workspaceId: string,
  snapshotId: string,
): SnapshotRead {
  const read = deps.repository.getSnapshot(snapshotId);
  if (read === undefined || read.snapshot.meta.workspaceId !== workspaceId) {
    throw new CausorynToolError(
      "INVALID_REVISION",
      `baseSnapshot çözümlenemedi: ${snapshotId} — bu workspace için yayınlanmış snapshot kimliği olmalı`,
    );
  }
  return read;
}

/* ------------------------------------------------------------------ */
/* causoryn_verify_change                                               */
/* ------------------------------------------------------------------ */

/**
 * causoryn_verify_change (TŞ §10.2/§10.4; sprint-6 Faz E): taban yayın ile
 * çalışma ağacı projeksiyonu arasındaki değişikliği dört denetimde
 * değerleyen deterministik rapor. KOD YAZMAZ: kaynak ağaç, gerçek
 * repository ve veri kökü değişmez; test ÇALIŞTIRMAZ (E3 — observed yalnızca
 * kanıtlı host kaydıyla). Verdict E2 sabit kural zincirinden gelir;
 * no_findings güvenli/kod garantisi DEĞİLDİR (her raporda disclaimers).
 */
export async function verifyChangeTool(
  deps: VerificationServiceDeps,
  requestId: string,
  input: z.infer<typeof VerifyChangeInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);

  // 1) Girdi disiplini: preflightId/baseSnapshot — en az biri zorunlu
  //    (TŞ §10.2 katalog satırı "preflightId/baseSnapshot").
  if (input.preflightId === undefined && input.baseSnapshot === undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "preflightId veya baseSnapshot gerekli: en az biri verilmelidir (TŞ §10.2 'preflightId/baseSnapshot'); preflightId için önce causoryn_preflight_change çağırın",
    );
  }

  // 2) Taban snapshot: baseSnapshot verilmişse yayın kimliği çözülür
  //    (bilinmeyen kimlik INVALID_REVISION — D2 örüntüsü); aksi halde
  //    manifest.taban kimliği (3. adımda) taban olur.
  let baseSnapshotId = input.baseSnapshot;

  // 3) preflightId çözümü: süreç-içi manifest deposu (preflight_change doldurur).
  let manifest: PreflightManifest | undefined;
  if (input.preflightId !== undefined) {
    manifest = deps.preflightStore?.get(input.preflightId);
    if (manifest === undefined) {
      // Bilinmeyen kimlik: kanonik ret D4 eşleme disipliniyle
      // INVALID_ARGUMENT'tır (verification/preflight-not-found kod sınıfı;
      // yeni uzantı kodu basılmaz — K-008 örüntüsü). Taban kimliği türetilemez
      // ve uydurma taban üretimi yoktur; çekirdeğin resolvePreflight savunma
      // katmanı aynı sözleşmeyi yeniden koşar.
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `preflightId çözümlenemedi: bilinmeyen kimlik — ${input.preflightId}; manifest yalnızca bu sunucu sürecinde causoryn_preflight_change ile üretildiyse çözülür (depo süreç-içidir), aksi hâlde değişiklik kümesini baseSnapshot kimliğiyle verin`,
      );
    }
    if (baseSnapshotId === undefined) {
      baseSnapshotId = manifest.baseSnapshotId;
    } else if (baseSnapshotId !== manifest.baseSnapshotId) {
      // Uyumluluk çözümü: ikisi birden verilirse manifest tabanı ile taban
      // yayın AYNI olmak zorundadır (TŞ §10.2 tek katalog satırı; çelişkili
      // kimlik çifti uydurma hizalamaya yol açamaz).
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `preflightId ile baseSnapshot uyumsuz: manifest tabanı ${manifest.baseSnapshotId}, verilen baseSnapshot ${baseSnapshotId} — aynı taban yayın kimliğini verin veya yalnızca birini belirtin`,
      );
    }
  }
  if (baseSnapshotId === undefined) {
    // Ulaşılamaz dal (adım 1'de en az biri zorunlu kılındı, adım 3'te manifest
    // tabanı yazıldı); savunma katmanı — uydurma taban yoktur.
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "preflightId veya baseSnapshot gerekli: en az biri verilmelidir (TŞ §10.2 'preflightId/baseSnapshot')",
    );
  }
  const baseRead = resolveBaseSnapshot(deps, workspaceId, baseSnapshotId);
  const baseSnapshot = baseRead.snapshot;

  // 4) Hedef projeksiyon: working-tree (atık depo; gerçek repo değişmez).
  const projection = projectWorkingTree(deps, canonicalRoot);

  // 5) Guard girdisi (yalnızca architecture istendiyse yüklenir). Parse şema
  //    reddi (bozuk YAML/şema → GuardError) runVerification sarmalının
  //    DIŞINDA kaldığı için INTERNAL_ERROR'a düşüyordu (denetim bulgusu);
  //    async red aynı tek eşleme zinciriyle POLICY_INVALID'a düşer
  //    (check_architecture sözleşmesi; başlık sözü bu yolda da dürüsttür).
  const requestedChecks = input.checks ?? ["architecture", "contracts", "graph-diff", "test-plan"];
  const architectureRequested = requestedChecks.includes("architecture");
  const contractsRequested = requestedChecks.includes("contracts");
  const guard = await loadGuardInputs(deps, canonicalRoot, architectureRequested).catch(
    (error: unknown) => rethrowAsToolError(error, requestId),
  );

  // 6) Çekirdek çağrısı: saf verifyChange — kod yazmaz, test çalıştırmaz.
  const report: VerificationReport = runVerification(() =>
    verifyChange({
      baseSnapshot,
      targetSnapshot: projection.snapshot,
      checks: requestedChecks,
      ...(input.preflightId === undefined ? {} : { preflightId: input.preflightId }),
      resolvePreflight: (id: string) => deps.preflightStore?.get(id),
      // Dosya yetkilendirmesi: WorkspaceAccessPolicy kararı fail-closed
      // çekirdeğe enjekte edilir (red kararı verification/file-not-authorized
      // → PATH_DENIED; sessiz düşürme yok).
      authorizeFile: (file: string) => {
        const decision = deps.policy.checkFile(canonicalRoot, file);
        return decision.allowed
          ? {
              allowed: true,
              ...(decision.relativePath === undefined ? {} : { relativePath: decision.relativePath }),
            }
          : {
              allowed: false,
              ...(decision.code === undefined ? {} : { code: decision.code }),
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            };
      },
      ...(guard.guardPolicy === undefined ? {} : { guardPolicy: guard.guardPolicy }),
      ...(guard.guardBaseline === undefined ? {} : { guardBaseline: guard.guardBaseline }),
      // contractDrift bilinçli olarak VERİLMEZ: TŞ §10.4 girdisinde sözleşme
      // spec çifti yoktur; istemciden sınıflama kaydı kabul edilmez (TŞ §11).
      // E3: observed koşum kaydı exactOptionalPropertyTypes disipliniyle
      // normalize edilir (zod optional'ının `| undefined` alanları çekirdek
      // sözleşmesine bire bir alan-indirmeyle taşınır; boş alan YAZILMAZ;
      // ayırıcı TŞ §10.4 koşum bloğuyla aynı `state` dağarcığındadır).
      ...(input.observedTestRun === undefined
        ? {}
        : {
            observedTestRun: {
              state: "observed" as const,
              evidenceRef: input.observedTestRun.evidenceRef,
              ...(input.observedTestRun.evidenceSha256 === undefined
                ? {}
                : { evidenceSha256: input.observedTestRun.evidenceSha256 }),
              ...(input.observedTestRun.evidenceIds === undefined
                ? {}
                : { evidenceIds: [...input.observedTestRun.evidenceIds] }),
              observedCount: input.observedTestRun.observedCount,
              ...(input.observedTestRun.passedCount === undefined
                ? {}
                : { passedCount: input.observedTestRun.passedCount }),
              ...(input.observedTestRun.failedCount === undefined
                ? {}
                : { failedCount: input.observedTestRun.failedCount }),
              ...(input.observedTestRun.testNames === undefined
                ? {}
                : { testNames: [...input.observedTestRun.testNames] }),
            },
          }),
    }),
  requestId);


  // 7) Envelope: taban yayın çapası + dürüstlük uyarıları.
  const warnings = staleWarningOf(baseRead);
  warnings.push(...projection.warnings);
  if (guard.warning !== undefined) warnings.push(guard.warning);
  if (contractsRequested && report.checks.contracts.status === "not_evaluated") {
    warnings.push(
      "contracts denetimi bu araç yüzeyinde değerlendirilemedi: TŞ §10.4 girdisinde sözleşme spec çifti yoktur; sözleşme drift'i için causoryn_check_contracts / causoryn_detect_contract_drift çıktılarıyla ayrı değerlendirme yapın (verdict inconclusive — tamamlanmamış değerlendirme review_required sayılmaz)",
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: baseSnapshot.meta.id,
    status: envelopeStatusOf(baseRead),
    coverage: coverageOf(baseSnapshot),
    warnings,
    data: report,
  });
}

/* ------------------------------------------------------------------ */
/* Kullanılan sabit kodlar (errors.ts alt kümesi; yeni uzantı YOK)      */
/* ------------------------------------------------------------------ */

/** Bu dilimde kullanılan sabit kodlar (bkz. verificationErrorToToolError). */
export const VERIFICATION_TOOL_ERROR_CODES_USED = [
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "LIMIT_EXCEEDED",
  "INVALID_ARGUMENT",
  "INVALID_REVISION",
  "POLICY_INVALID",
  "INTERNAL_ERROR",
] as const;
