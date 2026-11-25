import path from "node:path";

import {
  assertValidGitRef,
  GraphRepositoryError,
  GuardError,
  InMemoryGraphRepository,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  readGitBlob,
  resolveGitCommitRef,
  WORKING_TREE_REF,
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
  UNTRUSTED_RULES_TRUST_WARNING,
  VerificationError,
  verifyChange,
  type VerificationReport,
  type VerifyRulesProvenance,
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
  if (error instanceof GuardError || error instanceof GraphRepositoryError) {
    // Guard policy/baseline schema rejection or invalid git ref → POLICY_INVALID / INVALID_REVISION.
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
  /** Optional trusted git ref (commit/branch/tag) from which architecture rules/baseline are loaded (defaults to manifest HEAD or "HEAD"). */
  baseRef: z.string().min(1).optional(),
  /** TŞ §10.4 "targetRevision": çekirdek yalnızca working-tree destekler. */
  targetRevision: z.literal("working-tree").optional(),
  /** Subset of checks; defaults to ["architecture", "graph-diff", "test-plan"] ("contracts" runs only when explicitly requested). */
  checks: z.enum(["architecture", "contracts", "graph-diff", "test-plan"])
    .array()
    .min(1)
    .optional(),
  /** E3: host-supplied test run record (always reported as state: "host_asserted", engineVerified: false). */
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
    "untrusted-rules",
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
      status: z.enum(["not_run", "host_asserted"]),
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
  /** Where the architecture rules/baseline came from (architecture check requested only). */
  rulesProvenance: z
    .strictObject({
      source: z.enum(["git-ref", "working-tree"]),
      ref: z.string().optional(),
      commit: z.string().optional(),
      refOrigin: z.enum(["explicit", "preflight-manifest", "default-head"]).optional(),
      fallbackReason: z.enum(["rules-not-in-ref", "ref-unreadable"]).optional(),
    })
    .optional(),
  /** Present when the rules came from the untrusted working tree (verdict is never no_findings). */
  trustWarning: z.literal(UNTRUSTED_RULES_TRUST_WARNING).optional(),
});

/* ------------------------------------------------------------------ */
/* Yardımcılar: hedef projeksiyon + guard girdisi + taban çözümü        */
/* ------------------------------------------------------------------ */

const DEFAULT_VERIFY_CHECKS = ["architecture", "graph-diff", "test-plan"] as const;
const ARCHITECTURE_POLICY_BLOB_PATH = ".causoryn/architecture.rules.yaml";
const ARCHITECTURE_BASELINE_BLOB_PATH = ".causoryn/architecture.baseline.yaml";

/**
 * Asynchronous working-tree projection using a scratch InMemoryGraphRepository
 * so the real repository and workspace stay strictly read-only AND multi-language
 * sidecars (C#, Python, Go, Rust) run at full L1/L2 parity against the async
 * base snapshot instead of falsely degrading to L0.
 */
async function projectWorkingTree(
  deps: VerificationServiceDeps,
  canonicalRoot: string,
): Promise<{ readonly snapshot: SnapshotGraph; readonly warnings: readonly string[] }> {
  const scratch = new InMemoryGraphRepository();
  const projectionService = new IndexService({
    workspaceId: deps.config.workspaceId,
    policy: deps.policy,
    repository: scratch,
    clock: deps.clock,
    limits: { maxFiles: deps.config.index.maxFiles },
  });
  const run = await projectionService.runIndexAsync(canonicalRoot);
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

type TrustedGitBlobRead =
  | { readonly status: "ok"; readonly text: string }
  /** The ref was read but the file does not exist in that commit. */
  | { readonly status: "missing" }
  /** The ref/blob could not be read (git unavailable, not a repository, git error). */
  | { readonly status: "unreadable" };

async function tryReadTrustedGitBlob(
  canonicalRoot: string,
  ref: string,
  blobPath: string,
  maxBytes: number,
): Promise<TrustedGitBlobRead> {
  try {
    const text = await readGitBlob(canonicalRoot, ref, blobPath, {
      maxBufferBytes: maxBytes,
    });
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      throw new CausorynToolError(
        "LIMIT_EXCEEDED",
        `${blobPath} at git ref ${ref} (${String(bytes)} bytes) exceeds config.maxFileBytes (${String(maxBytes)})`,
      );
    }
    return { status: "ok", text };
  } catch (error) {
    if (error instanceof CausorynToolError) throw error;
    if (error instanceof GraphRepositoryError) {
      if (/maxBuffer/i.test(error.message)) {
        throw new CausorynToolError(
          "LIMIT_EXCEEDED",
          `${blobPath} at git ref ${ref} exceeds config.maxFileBytes (${String(maxBytes)})`,
        );
      }
      if (error.code === "compare/blob-not-found") {
        return { status: "missing" };
      }
      if (
        error.code === "compare/ref-not-found" ||
        error.code === "compare/git-unavailable" ||
        error.code === "compare/git-command-failed"
      ) {
        return { status: "unreadable" };
      }
    }
    throw error;
  }
}

/**
 * Loads architecture policy and baseline with git-ref trust precedence and
 * reports where they came from (`provenance`, reflected in the report and
 * in the verdict by the verification core).
 *
 * Trust rule:
 * 1. The trusted base ref is the caller's `baseRef`, else the preflight
 *    manifest's `sourceRevision.head`, else `HEAD`. The ref is resolved to a
 *    commit once and both files are read from that commit, so the rules and
 *    the baseline always come from the same commit. When the rules come from
 *    git, a modified or untracked working-tree baseline is NOT loaded, so the
 *    diff under verification cannot weaken or suppress its own rules.
 * 2. An explicit `baseRef` is the caller's trusted choice even when it names
 *    an old commit; it must resolve (fail closed with INVALID_REVISION /
 *    INVALID_ARGUMENT otherwise) and the report names the ref, the resolved
 *    commit and `refOrigin: "explicit"`, so a reviewer can see which rules
 *    were applied.
 * 3. The working tree is used only when the rules file does not exist at the
 *    trusted commit (`rules-not-in-ref`) or the trusted ref cannot be read
 *    (`ref-unreadable`: not a git repository, no commits, git error). Such a
 *    result is untrusted: the report carries `trustWarning` and the verdict
 *    can never be `no_findings` (verdict rule `untrusted-rules`).
 */
async function loadGuardInputs(
  deps: VerificationServiceDeps,
  canonicalRoot: string,
  architectureRequested: boolean,
  trustedBaseRef: string,
  refOrigin: NonNullable<VerifyRulesProvenance["refOrigin"]>,
  explicitBaseRef: string | undefined,
): Promise<{
  readonly guardPolicy: ArchitecturePolicy | undefined;
  readonly guardBaseline: ArchitectureBaseline | undefined;
  readonly warning: string | undefined;
  readonly provenance: VerifyRulesProvenance | undefined;
}> {
  if (!architectureRequested) {
    return {
      guardPolicy: undefined,
      guardBaseline: undefined,
      warning: undefined,
      provenance: undefined,
    };
  }
  let trustedCommit: string | undefined;
  if (explicitBaseRef !== undefined) {
    if (explicitBaseRef === WORKING_TREE_REF) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        "baseRef must be a git commit, branch, or tag ref (working-tree cannot be used as a trusted base ref)",
      );
    }
    assertValidGitRef(explicitBaseRef);
    try {
      trustedCommit = await resolveGitCommitRef(canonicalRoot, explicitBaseRef);
    } catch (error) {
      if (error instanceof GraphRepositoryError) {
        throw graphErrorToToolError(error);
      }
      throw error;
    }
  } else if (trustedBaseRef !== WORKING_TREE_REF) {
    try {
      assertValidGitRef(trustedBaseRef);
      trustedCommit = await resolveGitCommitRef(canonicalRoot, trustedBaseRef);
    } catch (error) {
      // Implicit base ref that cannot be resolved (not a git repository, no
      // commits yet, git unavailable): fall back below, flagged as untrusted.
      if (!(error instanceof GraphRepositoryError)) throw error;
      trustedCommit = undefined;
    }
  }

  const maxBytes = deps.config.maxFileBytes;
  const consultedRef = trustedBaseRef === WORKING_TREE_REF ? undefined : trustedBaseRef;

  // 1) Trusted git base commit first.
  let fallbackReason: NonNullable<VerifyRulesProvenance["fallbackReason"]> = "ref-unreadable";
  if (trustedCommit !== undefined) {
    const gitPolicyRead = await tryReadTrustedGitBlob(
      canonicalRoot,
      trustedCommit,
      ARCHITECTURE_POLICY_BLOB_PATH,
      maxBytes,
    );
    if (gitPolicyRead.status === "ok") {
      const gitBaselineRead = await tryReadTrustedGitBlob(
        canonicalRoot,
        trustedCommit,
        ARCHITECTURE_BASELINE_BLOB_PATH,
        maxBytes,
      );
      const policy = parseArchitecturePolicy(gitPolicyRead.text);
      const baseline =
        gitBaselineRead.status === "ok"
          ? parseArchitectureBaseline(gitBaselineRead.text)
          : undefined;
      return {
        guardPolicy: policy,
        guardBaseline: baseline,
        warning: undefined,
        provenance: {
          source: "git-ref",
          ...(consultedRef === undefined ? {} : { ref: consultedRef }),
          commit: trustedCommit,
          refOrigin,
        },
      };
    }
    fallbackReason = gitPolicyRead.status === "missing" ? "rules-not-in-ref" : "ref-unreadable";
  }

  // 2) Fallback: rules not committed at the trusted commit, or the trusted
  //    ref is unreadable — load from the working tree, flagged untrusted.
  const policyRead = await readGuardText(
    path.join(canonicalRoot, ".causoryn", "architecture.rules.yaml"),
    maxBytes,
  );
  if (policyRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `.causoryn/architecture.rules.yaml (${String(policyRead.bytes)} bytes) exceeds config.maxFileBytes (${String(maxBytes)}); reduce the policy file size`,
    );
  }
  if (policyRead.status !== "ok") {
    return {
      guardPolicy: undefined,
      guardBaseline: undefined,
      warning:
        "architecture check could not be evaluated: .causoryn/architecture.rules.yaml was not found in the base commit or workspace root",
      provenance: undefined,
    };
  }
  const baselineRead = await readGuardText(
    path.join(canonicalRoot, ".causoryn", "architecture.baseline.yaml"),
    maxBytes,
  );
  if (baselineRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `.causoryn/architecture.baseline.yaml (${String(baselineRead.bytes)} bytes) exceeds config.maxFileBytes (${String(maxBytes)}); reduce the baseline file size`,
    );
  }
  const policy = parseArchitecturePolicy(policyRead.text);
  const baseline =
    baselineRead.status === "ok" ? parseArchitectureBaseline(baselineRead.text) : undefined;
  return {
    guardPolicy: policy,
    guardBaseline: baseline,
    warning: undefined,
    provenance: {
      source: "working-tree",
      ...(consultedRef === undefined ? {} : { ref: consultedRef }),
      refOrigin,
      fallbackReason,
    },
  };
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
      `baseSnapshot could not be resolved: ${snapshotId} — it must be a snapshot ID published for this workspace`,
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
      "preflightId or baseSnapshot is required: provide at least one; to get a preflightId, call causoryn_preflight_change first",
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
        `preflightId could not be resolved: unknown ID ${input.preflightId}; a manifest can only be resolved if causoryn_preflight_change created it in this server process (the store is in-memory); otherwise identify the change set with a baseSnapshot ID`,
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
        `preflightId and baseSnapshot do not match: the manifest base is ${manifest.baseSnapshotId} but baseSnapshot is ${baseSnapshotId}; pass the same base snapshot ID or only one of them`,
      );
    }
  }
  if (baseSnapshotId === undefined) {
    // Ulaşılamaz dal (adım 1'de en az biri zorunlu kılındı, adım 3'te manifest
    // tabanı yazıldı); savunma katmanı — uydurma taban yoktur.
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "preflightId or baseSnapshot is required: provide at least one",
    );
  }
  const baseRead = resolveBaseSnapshot(deps, workspaceId, baseSnapshotId);
  const baseSnapshot = baseRead.snapshot;

  // 4) Asynchronous working-tree projection (scratch repo; real repo untouched).
  const projection = await projectWorkingTree(deps, canonicalRoot).catch((error: unknown) =>
    rethrowAsToolError(error, requestId),
  );

  // 5) Guard inputs: default checks exclude unevaluable "contracts" so default
  //    verify_change calls do not automatically degrade to inconclusive.
  //    Rules/baseline are loaded from the trusted base git ref first.
  const requestedChecks = input.checks ?? [...DEFAULT_VERIFY_CHECKS];
  const architectureRequested = requestedChecks.includes("architecture");
  const contractsRequested = requestedChecks.includes("contracts");
  const manifestHead = manifest?.sourceRevision?.head;
  const trustedBaseRef = input.baseRef ?? manifestHead ?? "HEAD";
  const refOrigin: NonNullable<VerifyRulesProvenance["refOrigin"]> =
    input.baseRef !== undefined
      ? "explicit"
      : manifestHead !== undefined
        ? "preflight-manifest"
        : "default-head";
  const guard = await loadGuardInputs(
    deps,
    canonicalRoot,
    architectureRequested,
    trustedBaseRef,
    refOrigin,
    input.baseRef,
  ).catch((error: unknown) => rethrowAsToolError(error, requestId));

  // 6) Core verification call (pure, read-only, never executes tests).
  const report: VerificationReport = runVerification(() =>
    verifyChange({
      baseSnapshot,
      targetSnapshot: projection.snapshot,
      checks: requestedChecks,
      ...(input.preflightId === undefined ? {} : { preflightId: input.preflightId }),
      resolvePreflight: (id: string) => deps.preflightStore?.get(id),
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
      ...(guard.provenance === undefined ? {} : { rulesProvenance: guard.provenance }),
      ...(input.observedTestRun === undefined
        ? {}
        : {
            observedTestRun: {
              state: input.observedTestRun.state,
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

  // 7) Envelope: anchor to base snapshot + honesty & trust warnings.
  const warnings = staleWarningOf(baseRead);
  warnings.push(...projection.warnings);
  if (guard.warning !== undefined) warnings.push(guard.warning);
  if (report.trustWarning !== undefined) {
    const reason =
      guard.provenance?.fallbackReason === "rules-not-in-ref"
        ? `not found in git ref ${trustedBaseRef}`
        : `git ref ${trustedBaseRef} could not be read`;
    warnings.push(
      `${report.trustWarning}: .causoryn/architecture.rules.yaml was loaded from the untrusted working tree (${reason}); the verdict cannot be no_findings, verify rules were not weakened in this diff`,
    );
  }
  if (contractsRequested && report.checks.contracts.status === "not_evaluated") {
    warnings.push(
      "contracts check could not be evaluated on this tool surface without explicit before/after contract spec pairs; run causoryn_check_contracts or causoryn_detect_contract_drift separately (verdict is inconclusive)",
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: baseSnapshot.meta.id,
    status: envelopeStatusOf(baseRead),
    coverage: coverageOf(baseSnapshot),
    warnings,
    // trustWarning and rulesProvenance are part of the report itself (and of
    // its reportId hash), not an envelope-only annotation.
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
