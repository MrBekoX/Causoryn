import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ArchitectureAnnotationsSchema,
  ArchitectureProjectionOptionsSchema,
  EXPORT_DOCUMENTATION_FORMATS,
  EXPORT_DOCUMENTATION_VIEWS,
  GraphRepositoryError,
  GuardError,
  type ArchitectureTimeline,
  type ExportDocumentationView,
  analyzeImpact,
  buildArchitectureTimelineFromGit,
  diffContentSets,
  exportDocumentationViewSchema,
  findOrphanSuppressions,
  findViolations,
  generateAgentContext,
  generateOnboarding,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  readTimelinePointFromGit,
  writeDocumentation,
} from "@causoryn/graph";
import { z } from "zod";

import { CausorynToolError } from "./errors.js";
import { buildEnvelope, type Envelope } from "./envelope.js";
import {
  coverageOf,
  envelopeStatusOf,
  requireAuthorizedWorkspace,
  requireSnapshot,
  staleWarningOf,
  type ServiceDeps,
} from "./services.js";

/**
 * Faz C uygulama servisleri (sprint-3 C8 — C1–C7 çekirdek modüllerinin MCP
 * yüzeyi; TŞ v2.1 §10.2 araç kataloğu, §12 Guard, §13 Impact/Diff/Timeline,
 * §15 Agent GPS, §16 Onboarding/Export).
 *
 * Ortal davranış services.ts ile birebir aynıdır: workspace yetkilendirmesi
 * ilk adım (WORKSPACE_NOT_AUTHORIZED), yayınlanmış snapshot gerektiren
 * araçlar INDEX_NOT_READY, çıktılar deterministiktir (TŞ §8 invariant iv/vi).
 *
 * TŞ §10.2 alan adı sadakati (PDF Sayfa 9–10'dan doğrulandı):
 * - causoryn_analyze_impact: "targets/diff, depth, edgeKinds" → `targets`
 *   (zorunlu; diff tabanlı girdi preflight dilimine aittir), `depth?`
 *   (çekirdek AnalyzeImpactInput.maxDepth'e eşlenir), `edgeKinds?`;
 *   TŞ §20 resource budget `maxPaths`/`maxNodes` de açıktır.
 * - causoryn_check_architecture: "policyId?, scope?" → ikisi de şemada
 *   beyanlı ama bu dilimde DESTEKLENMEZ (tek workspace policy dosyası
 *   `.causoryn/architecture.rules.yaml` değerlendirilir); şemayı geçen
 *   değer refresh_index mode/scope geleneğiyle AÇIK INVALID_ARGUMENT reddedilir
 *   (ADR-010: sessiz yok sayma yok).
 * - causoryn_compare_architecture: "baseRef, targetRef" → birebir.
 * - causoryn_get_agent_context: "task, candidateScope?, tokenBudget" →
 *   `task`/`tokenBudget` çekirdeğe birebir; `candidateScope?` beyanlı ama
 *   çekirdek aday evresi henüz almıyor (agent-context.ts başlığındaki not)
 *   → açık INVALID_ARGUMENT reddi.
 * - causoryn_generate_onboarding: "audience, focus?" → `audience` çekirdek
 *   `profile` alanına eşlenir (değerler TŞ §16 profilleri: beginner/
 *   intermediate/maintainer); `focus?` beyanlı ama çekirdekte karşılığı yok
 *   → açık INVALID_ARGUMENT reddi.
 * - causoryn_export_documentation: "format, view, output?" → `format`
 *   (json|markdown|mermaid|html|snapshot; TŞ §16), `outputDir` (explicit
 *   OutputAccessPolicy beyanı), `fileName?`, `view?` (`architecture`
 *   varsayılan / `interactive` yalnızca HTML / `full` ham döküm; `wiki`
 *   Living Wiki'ye ait olduğundan açık INVALID_ARGUMENT), `options?`,
 *   `annotations?` (fail-closed Host-LLM anotasyonları, v0.2.2).
 * - causoryn_get_agent_context "task, candidateScope?, tokenBudget" →
 *   tokenBudget TŞ'de ?siz (ZORUNLU) olduğundan yüzey şeması da zorunludur
 *   (takım denetimi bulgusu); çekirdeğin default 2048 davranışı araç
 *   yüzeyinde açılmaz.
 * - causoryn_architecture_timeline: "refs/range, granularity" → `refs?`/
 *   `range?` (tam olarak biri — çekirdek sözleşmesi), `maxRevisions?`/
 *   `maxRangeWalk?` (TŞ §13 sampling); `granularity?` çekirdekte nokta
 *   seçimi olarak işlenmiyor (timeline.ts başlığındaki not) → açık ret.
 *
 * Git erişimi (compare/timeline): yalnızca @causoryn/graph salt-okunur
 * spawn katmanı (cat-file/ls-tree, shell kapalı, ref/blob-path doğrulamalı)
 * — checkout/reset/clean imkânsızdır (TŞ §13; kırmızı çizgi 3).
 */

/* ------------------------------------------------------------------ */
/* Graph sözleşme kodları → sabit tool kodu eşlemesi                   */
/* ------------------------------------------------------------------ */

/**
 * @causoryn/graph sözleşme kodları → sabit tool hata kodu (TŞ §10.1 taban;
 * export yazma reddi EXPORT_NOT_ALLOWED — takım denetimi bulgusu sonrası
 * TŞ sabit kodu kullanılır, uzantı kodu basılmaz). Eşleme tek noktadadır;
 * modül kodları istemciye SIZMAZ (mesaj taşınır, kod sabittir).
 *
 * `log` verildiğinde INTERNAL_ERROR'a eşlenen (ortam hata sınıfı: git
 * yok/komut başarısız/yazma hatası) hataların ORİJİNAL mesajı bu logger'a
 * yazılır — istemciye genel mesaj gider ama detay kaybolmaz; errors.ts'teki
 * INTERNAL_ERROR userAction'ı ("stderr loglarını inceleyin") bu logun
 * karşılığıdır (takım denetimi bulgusu 2).
 */
export function graphErrorToToolError(
  error: {
    readonly code: string;
    readonly message: string;
  },
  log?: (message: string) => void,
): CausorynToolError {
  const code = error.code;
  // Şema/girdi ihlalleri — istemci girdisini düzeltmelidir.
  if (
    code === "graph/impact-invalid-input" ||
    code === "graph/agent-context-invalid-input" ||
    code === "graph/onboarding-invalid-input" ||
    code === "compare/invalid-ref" ||
    code === "compare/invalid-blob-path" ||
    code === "timeline/invalid-input" ||
    code === "timeline/insufficient-points" ||
    code === "timeline/duplicate-ref" ||
    code === "timeline/invalid-limit" ||
    code === "timeline/trend-invalid-input" ||
    code === "export/invalid-format" ||
    code === "export/invalid-view" ||
    code === "export/invalid-options" ||
    code === "export/invalid-annotations"
  ) {
    return new CausorynToolError("INVALID_ARGUMENT", error.message);
  }
  // Snapshot durumu korumaları — indeksleme çözümü ile aynı kod.
  if (
    code === "graph/impact-snapshot-state" ||
    code === "graph/agent-context-snapshot-state" ||
    code === "graph/onboarding-snapshot-state"
  ) {
    return new CausorynToolError("INDEX_NOT_READY", error.message);
  }
  // Guard policy/baseline doğrulaması (TŞ §10.1 sabit POLICY_INVALID).
  if (code.startsWith("guard/")) {
    return new CausorynToolError("POLICY_INVALID", error.message);
  }
  // Revizyon/ref/içerik sözleşmeleri (TŞ §10.1 sabit INVALID_REVISION):
  // çözümlenemeyen ref, ref'te okunamayan/bozuk snapshot blob'u, diff
  // içerik sözleşmesi ihlali, aralık çözümleme hatası.
  if (
    code === "compare/ref-not-found" ||
    code === "compare/blob-not-found" ||
    code === "compare/unknown-node-kind" ||
    code === "compare/unknown-edge-kind" ||
    code === "compare/unknown-resolution" ||
    code === "compare/non-json-attribute" ||
    code === "compare/empty-qualified-name" ||
    code === "compare/invalid-node-field" ||
    code === "compare/duplicate-node" ||
    code === "compare/duplicate-edge" ||
    code === "compare/dangling-edge" ||
    code === "compare/tree-too-large" ||
    code === "compare/git-unexpected-output" ||
    code === "timeline/invalid-range"
  ) {
    return new CausorynToolError("INVALID_REVISION", error.message);
  }
  // Export yazma yetkilendirmesi — TŞ §10.1 SABİT EXPORT_NOT_ALLOWED (takım
  // denetimi bulgusu: TŞ sabit listesinde EXPORT_NOT_ALLOWED var, s.9;
  // beyanlı olmayan output dizini bu kodun adı ve TŞ §16 konumu gereği tam
  // karşılığıdır — yeni uzantı kodu basılmaz).
  if (code === "export/output-not-authorized") {
    return new CausorynToolError("EXPORT_NOT_ALLOWED", error.message);
  }
  // Çıktı yolu kaçışı (null byte / ayraç / ".." / realpath) → mevcut taban kod.
  if (code === "export/output-path-denied") {
    return new CausorynToolError("PATH_DENIED", error.message);
  }
  // Ortam/hata sınıfı (git yok, komut başarısız, yazma hatası) →
  // retryable=true INTERNAL_ERROR. Orijinal mesaj + modül kodu YALNIZCA
  // enjekte edilen logger'a (stderr) yazılır; istemci mesajı geneldir.
  log?.(`graf sözleşme hatası ${code} INTERNAL_ERROR'a eşlendi: ${error.message}`);
  return new CausorynToolError(
    "INTERNAL_ERROR",
    "Beklenmeyen iç hata; ayrıntılar sunucu loglarında",
  );
}

/** Senkron graf işlerini sabit hata eşlemesiyle koşturur (logger dahil). */
function runGraph<T>(logger: (message: string) => void, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof GraphRepositoryError || error instanceof GuardError) {
      throw graphErrorToToolError(error, logger);
    }
    throw error;
  }
}

/** Eşzamansız (git spawn) graf işlerini aynı eşlemeyle koşturur. */
async function runGraphAsync<T>(
  logger: (message: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GraphRepositoryError || error instanceof GuardError) {
      throw graphErrorToToolError(error, logger);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* C1 — causoryn_analyze_impact                                        */
/* ------------------------------------------------------------------ */

export const AnalyzeImpactInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "targets/diff": node kimliği ("node:<hex>") veya TAM
   * qualifiedName; otomatik kesinleştirme yapılmaz (TŞ §10.3). */
  targets: z.array(z.string().min(1)).min(1),
  /** TŞ §10.2 "depth": yol uzunluğu; çekirdek maxDepth'e eşlenir. */
  depth: z.number().int().positive().optional(),
  /** TŞ §20 resource budget maxPaths. */
  maxPaths: z.number().int().positive().optional(),
  /** TŞ §20 resource budget maxNodes. */
  maxNodes: z.number().int().positive().optional(),
  /** Traversal'a girecek kenar türleri (EDGE_KINDS alt kümesi; anlamsal
   * doğrulama çekirdekte yapılır → INVALID_ARGUMENT). */
  edgeKinds: z.array(z.string().min(1)).optional(),
});

const ImpactTargetRefSchema = z.strictObject({
  nodeId: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
});

const ImpactEdgeRefSchema = z.strictObject({
  edgeId: z.string(),
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  resolution: z.string(),
  evidenceIds: z.array(z.string()),
});

const ImpactPathSchema = z.strictObject({
  pathId: z.string(),
  targetNodeId: z.string(),
  endpointNodeId: z.string(),
  endpointQualifiedName: z.string(),
  endpointKind: z.string(),
  depth: z.number().int().nonnegative(),
  certainty: z.enum(["direct", "indirect", "possible"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  truncated: z.boolean(),
  edges: z.array(ImpactEdgeRefSchema),
  evidenceIds: z.array(z.string()),
});

const ImpactAffectedNodeSchema = z.strictObject({
  nodeId: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
  minDepth: z.number().int().nonnegative(),
  pathCount: z.number().int().nonnegative(),
  certainty: z.enum(["direct", "indirect", "possible"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  truncated: z.boolean(),
  pathEvidenceIds: z.array(z.string()),
  targetNodeIds: z.array(z.string()),
});

const ImpactSummaryCellSchema = z.strictObject({
  verified: z.number().int().nonnegative(),
  heuristic: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
});

export const AnalyzeImpactDataSchema = z.strictObject({
  snapshotId: z.string(),
  targets: z.array(ImpactTargetRefSchema),
  unresolvedTargets: z.array(
    z.strictObject({ target: z.string(), reason: z.string() }),
  ),
  affectedNodes: z.array(ImpactAffectedNodeSchema),
  paths: z.array(ImpactPathSchema),
  summary: z.strictObject({
    paths: z.strictObject({
      direct: z.number().int().nonnegative(),
      indirect: z.number().int().nonnegative(),
      possible: z.number().int().nonnegative(),
    }),
    affectedNodes: z.strictObject({
      direct: ImpactSummaryCellSchema,
      indirect: ImpactSummaryCellSchema,
      possible: ImpactSummaryCellSchema,
    }),
    totalPaths: z.number().int().nonnegative(),
    totalAffectedNodes: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
  truncatedBy: z.array(z.enum(["maxDepth", "maxNodes", "maxPaths"])),
  limits: z.strictObject({
    maxDepth: z.number().int().positive(),
    maxPaths: z.number().int().positive(),
    maxNodes: z.number().int().positive(),
  }),
  rationales: z.array(z.string()),
});

/**
 * causoryn_analyze_impact (TŞ §13 Impact + §10.2 girdisi; C1): hedef
 * sembollerden ters kenar BFS ile bounded etki yolları. certainty
 * (direct|indirect|possible) ile resolution (verified|heuristic|unresolved)
 * AYRI alanlardır; mutlak etki iddiası üretilmez (TŞ kırmızı çizgisi).
 * TŞ §20: istenen sınırlar tavana kırpılır ve rationale ile raporlanır
 * (hata değil); çözülemeyen hedefler unresolvedTargets'ta raporlanır
 * (otomatik kesinleştirme yok — TŞ §10.3).
 */
export function analyzeImpactTool(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof AnalyzeImpactInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const result = runGraph(deps.logger, () =>
    analyzeImpact(read.snapshot, {
      targets: input.targets,
      ...(input.depth === undefined ? {} : { maxDepth: input.depth }),
      ...(input.maxPaths === undefined ? {} : { maxPaths: input.maxPaths }),
      ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
      ...(input.edgeKinds === undefined ? {} : { edgeKinds: input.edgeKinds }),
    }),
  );
  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings: staleWarningOf(read),
    data: result,
  });
}

/* ------------------------------------------------------------------ */
/* C2 — causoryn_check_architecture                                    */
/* ------------------------------------------------------------------ */

export const CheckArchitectureInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "policyId?": bu dilimde desteklenmiyor (açık ret). */
  policyId: z.string().min(1).optional(),
  /** TŞ §10.2 "scope?": bu dilimde desteklenmiyor (açık ret). */
  scope: z.string().min(1).optional(),
});

export const GuardFindingSchema = z.strictObject({
  id: z.string(),
  ruleId: z.string(),
  ruleType: z.enum(["no-cycles", "forbidden-dependency"]),
  severity: z.enum(["error", "warning", "info"]),
  from: z.string(),
  to: z.string(),
  fromPath: z.string().optional(),
  toPath: z.string().optional(),
  evidenceIds: z.array(z.string()),
  cycle: z.array(z.string()).optional(),
  suppressed: z.boolean(),
  suppression: z
    .strictObject({ reason: z.string(), owner: z.string(), date: z.string() })
    .optional(),
  snapshotId: z.string(),
});

const SuppressionEntrySchema = z.strictObject({
  ruleId: z.string(),
  reason: z.string(),
  owner: z.string(),
  date: z.string(),
});

export const CheckArchitectureDataSchema = z.strictObject({
  policyPath: z.string(),
  baselinePath: z.string().nullable(),
  evaluatedRules: z.number().int().nonnegative(),
  findings: z.array(GuardFindingSchema),
  orphanSuppressions: z.array(SuppressionEntrySchema),
  summary: z.strictObject({
    findings: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
    bySeverity: z.strictObject({
      error: z.number().int().nonnegative(),
      warning: z.number().int().nonnegative(),
      info: z.number().int().nonnegative(),
    }),
  }),
});

/** Workspace köküne göre policy/baseline dosya yolları. Çıktıda taşınan
 * gösterim POSIX ayıracıyla sabittir (platformdan bağımsız sözleşme);
 * fs erişimi path.join ile yapılır. */
const POLICY_RELATIVE_PATH = ".causoryn/architecture.rules.yaml";
const BASELINE_RELATIVE_PATH = ".causoryn/architecture.baseline.yaml";

/** Policy/baseline okuma sonucu: okundu, yok ya da bütçe aşımı. */
type ReadTextResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large"; readonly bytes: number };

/**
 * Policy/baseline dosyasını TŞ §20 "dosya başına byte" resource bütçesiyle
 * okur (takım denetimi bulgusu: TŞ §19 gereği depo dosyası güvenilmez
 * girdidir; bütçesiz tam belleğe okuma yoktur). Denetim iki katmandır:
 * okuma ÖNCESİ stat boyutu VE okuma SONRASI byteLength (stat/read yarışına
 * karşı savunma; utf-8 uzunluk farkı dahil). Bütçe aşımı LIMIT_EXCEEDED
 * eşlenir; eksik dosya "missing" (çağıran POLICY_INVALID'a çevirir).
 */
async function readOptionalTextFile(
  absolutePath: string,
  maxBytes: number,
): Promise<ReadTextResult> {
  let statSize: number | undefined;
  try {
    statSize = (await stat(absolutePath)).size;
  } catch {
    return { status: "missing" };
  }
  if (statSize > maxBytes) {
    return { status: "too-large", bytes: statSize };
  }
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch {
    return { status: "missing" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    return { status: "too-large", bytes };
  }
  return { status: "ok", text };
}

/**
 * causoryn_check_architecture (TŞ §12 Architecture Guard; C2): workspace
 * kökündeki `.causoryn/architecture.rules.yaml` policy'sini (ve verilmişse
 * `.causoryn/architecture.baseline.yaml` suppression dosyasını) çözümler,
 * yayınlanmış snapshot üzerinde kural ihlallerini değerlendirir.
 *
 * - Policy/baseline çözümleme reddi VEYA policy dosyasının yokluğu →
 *   TŞ §10.1 sabit POLICY_INVALID (guard/... kodlarının eşlemesi).
 * - finding = {id, ruleId, severity, from, to, evidenceIds, suppression?,
 *   snapshotId} (TŞ §12 sözleşmesi; suppression reason/owner/date zorunlu).
 * - Yönetişim yüzeyi: policy'de karşılığı olmayan suppression girişleri
 *   orphanSuppressions'ta listelenir (bayat baseline görünür kılınır).
 * - "CI fail ancak kullanıcı blocking koşulunu bilerek etkinleştirdiğinde"
 *   (TŞ §12): bu araç yalnızca BULGU raporlar; hiçbir CI/çıkış kodu
 *   kararına karışmaz.
 */
export async function checkArchitecture(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof CheckArchitectureInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);

  if (input.policyId !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "policyId bu araç yüzeyinde henüz açılmadı; bu dilimde yalnızca workspace kökündeki .causoryn/architecture.rules.yaml değerlendirilir",
    );
  }
  if (input.scope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `scope dar kapsamlı guard değerlendirmesi bu araç yüzeyinde desteklenmiyor (${input.scope}); kapsam kural başına policy dosyasında tanımlanır (scope: modules|files|all)`,
    );
  }

  // TŞ §20 "dosya başına byte": policy/baseline workspace'ten gelen
  // güvenilmez dosyalardır; okuma config.maxFileBytes bütçesiyle sınırlıdır
  // (takım denetimi bulgusu — bütçesiz tam bellek okuması yoktur).
  const maxPolicyBytes = deps.config.maxFileBytes;
  const policyRead = await readOptionalTextFile(
    path.join(canonicalRoot, ".causoryn", "architecture.rules.yaml"),
    maxPolicyBytes,
  );
  if (policyRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `${POLICY_RELATIVE_PATH} ${String(policyRead.bytes)} byte ile config.maxFileBytes tavanını (${String(maxPolicyBytes)}) aşıyor (TŞ §20 dosya başına byte bütçesi); policy dosyasını küçültün veya kuralları bölün`,
    );
  }
  if (policyRead.status !== "ok") {
    throw new CausorynToolError(
      "POLICY_INVALID",
      `policy dosyası bulunamadı: ${POLICY_RELATIVE_PATH} (workspace köküne göre); guard değerlendirmesi için kural dosyası oluşturun`,
    );
  }
  const policyText = policyRead.text;
  const baselineRead = await readOptionalTextFile(
    path.join(canonicalRoot, ".causoryn", "architecture.baseline.yaml"),
    maxPolicyBytes,
  );
  if (baselineRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `${BASELINE_RELATIVE_PATH} ${String(baselineRead.bytes)} byte ile config.maxFileBytes tavanını (${String(maxPolicyBytes)}) aşıyor (TŞ §20 dosya başına byte bütçesi); baseline dosyasını küçültün`,
    );
  }
  const baselineText = baselineRead.status === "ok" ? baselineRead.text : null;

  const findings = await runGraphAsync(deps.logger, async () => {
    const policy = parseArchitecturePolicy(policyText);
    const baseline =
      baselineText === null
        ? { version: 1 as const, suppressions: [] }
        : parseArchitectureBaseline(baselineText);
    const violations = findViolations(read.snapshot, policy, baseline);
    const orphans = findOrphanSuppressions(policy, baseline);
    return { policy, violations, orphans };
  });

  const bySeverity = { error: 0, warning: 0, info: 0 };
  let suppressed = 0;
  for (const finding of findings.violations) {
    bySeverity[finding.severity] += 1;
    if (finding.suppressed) suppressed += 1;
  }

  const warnings = [...staleWarningOf(read)];
  if (findings.violations.length === 0) {
    warnings.push(
      "guard değerlendirmesi tamamlandı; kural ihlali bulunamadı (boş bulgu seti hat değil, raporlanan sonuçtur)",
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings,
    data: {
      policyPath: POLICY_RELATIVE_PATH,
      baselinePath: baselineText === null ? null : BASELINE_RELATIVE_PATH,
      evaluatedRules: findings.policy.rules.length,
      findings: findings.violations,
      orphanSuppressions: findings.orphans,
      summary: {
        findings: findings.violations.length,
        suppressed,
        bySeverity,
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* C3 — causoryn_compare_architecture                                  */
/* ------------------------------------------------------------------ */

export const CompareArchitectureInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "baseRef": commit/tag/branch/sha veya working-tree (TŞ §13). */
  baseRef: z.string().min(1),
  /** TŞ §10.2 "targetRef": aynı sözleşme. */
  targetRef: z.string().min(1),
});

const CompareIdentitySchema = z.strictObject({
  kind: z.string(),
  qualifiedName: z.string(),
  relativePath: z.string().optional(),
});

const NodeChangeSchema = z.strictObject({
  classification: z.enum(["added", "removed", "changed"]),
  node: CompareIdentitySchema,
  changeType: z.string().optional(),
  changedAttributeKeys: z.array(z.string()).optional(),
});

const RenameMatchSchema = z.strictObject({
  from: CompareIdentitySchema,
  to: CompareIdentitySchema,
  confidence: z.enum(["high", "medium", "low"]),
  score: z.number(),
  components: z.strictObject({
    baseName: z.number(),
    signature: z.number().nullable(),
    path: z.number().nullable(),
  }),
  reason: z.string(),
});

const UncertainMatchSchema = z.strictObject({
  from: CompareIdentitySchema,
  to: CompareIdentitySchema,
  score: z.number(),
  reason: z.string(),
});

const EdgeChangeSchema = z.strictObject({
  changeType: z.enum(["added", "removed", "resolution-changed"]),
  kind: z.string(),
  from: CompareIdentitySchema,
  to: CompareIdentitySchema,
  baseResolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
  targetResolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

const ArchitectureDiffSchema = z.strictObject({
  added: z.array(NodeChangeSchema),
  removed: z.array(NodeChangeSchema),
  changed: z.array(NodeChangeSchema),
  renamed: z.array(RenameMatchSchema),
  uncertain: z.array(UncertainMatchSchema),
  unchangedNodeCount: z.number().int().nonnegative(),
  edges: z.strictObject({
    added: z.array(EdgeChangeSchema),
    removed: z.array(EdgeChangeSchema),
    changed: z.array(EdgeChangeSchema),
    unchangedCount: z.number().int().nonnegative(),
  }),
  apiSurface: z.strictObject({
    added: z.array(NodeChangeSchema),
    removed: z.array(NodeChangeSchema),
    changed: z.array(NodeChangeSchema),
    renamed: z.array(RenameMatchSchema),
    uncertain: z.array(UncertainMatchSchema),
  }),
  summary: z.strictObject({
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
});

export const CompareArchitectureDataSchema = z.strictObject({
  baseRef: z.string(),
  targetRef: z.string(),
  diff: ArchitectureDiffSchema,
});

/**
 * causoryn_compare_architecture (TŞ §13 Architecture Diff; C3): iki git
 * ref'inin `.causoryn/architecture-snapshot.json` blob'ları salt-okunur
 * cat-file ile okunur (checkout/reset/clean YOK) ve içerik kümeleri
 * diffContentSets çekirdeğiyle karşılaştırılır. Rename matching
 * qualifiedName + imza parmak izi + yol benzerliğiyle heuristiktir ve
 * confidence BELGELIDIR (bantlar + skorlar çıktıda taşınır). Blob'u
 * olmayan/bozuk içerikli revizyon → INVALID_REVISION (uydurma içerik yok).
 */
export async function compareArchitecture(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof CompareArchitectureInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);

  const diff = await runGraphAsync(deps.logger, async () => {
    const basePoint = await readTimelinePointFromGit(canonicalRoot, input.baseRef);
    if (basePoint.status !== "analyzed") {
      throw new GraphRepositoryError(
        "compare/blob-not-found",
        `baseRef '${input.baseRef}' analiz edilemedi: ${basePoint.reason}`,
      );
    }
    const targetPoint = await readTimelinePointFromGit(canonicalRoot, input.targetRef);
    if (targetPoint.status !== "analyzed") {
      throw new GraphRepositoryError(
        "compare/blob-not-found",
        `targetRef '${input.targetRef}' analiz edilemedi: ${targetPoint.reason}`,
      );
    }
    return diffContentSets(basePoint.contentSet, targetPoint.contentSet);
  });

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: null,
    status: "ok",
    coverage: null,
    warnings: [],
    data: {
      baseRef: input.baseRef,
      targetRef: input.targetRef,
      diff,
    },
  });
}

/* ------------------------------------------------------------------ */
/* C4 — causoryn_get_agent_context                                     */
/* ------------------------------------------------------------------ */

export const GetAgentContextInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "task": görev metni = arama sorgusu (çıktıya yazılmaz). */
  task: z.string().min(1),
  /** TŞ §10.2 "candidateScope?": bu dilimde desteklenmiyor (açık ret). */
  candidateScope: z.string().min(1).optional(),
  /** TŞ §10.2 "tokenBudget" — PDF'te ? YOK (ZORUNLU alan; takım denetimi
   * bulgusu): estimatedTokens bütçesi istemciden istenir; çekirdeğin
   * default 2048 değeri araç yüzeyinde açılmaz (TŞ sadakati). */
  tokenBudget: z.number().int().positive(),
  /** graph-proximity BFS derinliği (çekirdek tavanı 4). */
  maxProximityDepth: z.number().int().positive().optional(),
});

const AgentContextLegSchema = z.enum([
  "exact-symbol",
  "graph-proximity",
  "contract",
  "freshness",
  "fts",
]);

const AgentContextItemSchema = z.strictObject({
  nodeId: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
  relativePath: z.string().optional(),
  span: z
    .strictObject({ startLine: z.number().int(), endLine: z.number().int() })
    .optional(),
  legs: z.array(AgentContextLegSchema),
  scores: z.strictObject({
    exact: z.number(),
    proximity: z.number(),
    contract: z.number(),
    freshness: z.number(),
    fts: z.number(),
  }),
  proximityDepth: z.number().int().nonnegative().optional(),
  evidenceIds: z.array(z.string()),
  reason: z.string(),
  estimatedTokens: z.number().int().positive(),
});

export const GetAgentContextDataSchema = z.strictObject({
  snapshotId: z.string(),
  snapshotState: z.string(),
  queryTokens: z.array(z.string()),
  tokenBudget: z.number().int().positive(),
  estimatedTokens: z.number().int().nonnegative(),
  contextItems: z.array(AgentContextItemSchema),
  omittedCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  legsApplied: z.array(AgentContextLegSchema),
  degradedLegs: z.array(
    z.strictObject({ leg: AgentContextLegSchema, reason: z.string() }),
  ),
  rationales: z.array(z.string()),
});

/**
 * causoryn_get_agent_context (TŞ §15 Agent GPS; C4): görev metnini YALNIZCA
 * arama sorgusu olarak değerlendirir; exact-symbol → graph-proximity →
 * contract → freshness → fts ayaklarıyla sıralar, tokenBudget bütçesine
 * (estimatedTokens = ceil(item JSON chars / 4)). Girdisi olmayan ayaklar
 * degradedLegs'te raporlanır (hata değildir). freshness ayağı depo
 * envanterinden (repository.listFiles → files.updatedAt, TŞ §9) beslenir;
 * fts ayağı symbolSearch (SQLite symbol_fts) bağlandığında aktifleşir,
 * yoksa degrade raporlanır. Prompt injection korunması: görev metni hiçbir
 * item reason'una interpole edilmez (çekirdek sözleşmesi).
 */
export function getAgentContext(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GetAgentContextInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);

  if (input.candidateScope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "candidateScope bu araç yüzeyinde henüz açılmadı (aday evresi şimdilik tüm yayınlanmış snapshot); görevi task metniyle daraltın",
    );
  }

  // freshness ayağı: TŞ §9 files envanteri (indeksleme updatedAt kayıtları).
  const fileFreshness = deps.repository
    .listFiles(workspaceId)
    .map((file) => ({ relativePath: file.relativePath, updatedAt: file.updatedAt }));

  const result = runGraph(deps.logger, () =>
    generateAgentContext(read.snapshot, {
      task: input.task,
      tokenBudget: input.tokenBudget,
      ...(input.maxProximityDepth === undefined
        ? {}
        : { maxProximityDepth: input.maxProximityDepth }),
      ...(deps.symbolSearch != null ? { symbolSearch: deps.symbolSearch } : {}),
      fileFreshness,
    }),
  );

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings: staleWarningOf(read),
    data: result,
  });
}

/* ------------------------------------------------------------------ */
/* C5 — causoryn_generate_onboarding                                   */
/* ------------------------------------------------------------------ */

export const GenerateOnboardingInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "audience": TŞ §16 profilleri (çekirdek profile alanı). */
  audience: z.enum(["beginner", "intermediate", "maintainer"]),
  /** TŞ §10.2 "focus?": bu dilimde desteklenmiyor (açık ret). */
  focus: z.string().min(1).optional(),
  /** Hesap sınırları (çekirdek OnboardingLimits; pozitif tam sayılar). */
  limits: z
    .strictObject({
      entryPointLimit: z.number().int().positive().optional(),
      topModuleCount: z.number().int().positive().optional(),
      maxLearningSteps: z.number().int().positive().optional(),
      maxCriticalFlows: z.number().int().positive().optional(),
    })
    .optional(),
});

const OnboardingEntrySchema = z.strictObject({
  nodeId: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
  relativePath: z.string().optional(),
  reason: z.string(),
});

export const GenerateOnboardingDataSchema = z.strictObject({
  profile: z.enum(["beginner", "intermediate", "maintainer"]),
  snapshotId: z.string(),
  snapshotState: z.string(),
  entryPoints: z.array(OnboardingEntrySchema),
  topModules: z.array(
    z.strictObject({
      nodeId: z.string(),
      qualifiedName: z.string(),
      relativePath: z.string().optional(),
      degree: z.number().int().nonnegative(),
      inDegree: z.number().int().nonnegative(),
      outDegree: z.number().int().nonnegative(),
      centrality: z.number(),
    }),
  ),
  learningOrder: z.array(
    z.strictObject({
      order: z.number().int().positive(),
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      relativePath: z.string().optional(),
      componentId: z.number().int().nonnegative(),
      componentSize: z.number().int().positive(),
    }),
  ),
  criticalFlows: z.array(
    z.strictObject({
      entryNodeId: z.string(),
      entryQualifiedName: z.string(),
      steps: z.array(
        z.strictObject({
          nodeId: z.string(),
          qualifiedName: z.string(),
          depth: z.number().int().positive(),
        }),
      ),
    }),
  ),
  tests: z.array(
    z.strictObject({
      nodeId: z.string(),
      qualifiedName: z.string(),
      testedQualifiedNames: z.array(z.string()),
    }),
  ),
  unknownEdges: z.array(
    z.strictObject({
      resolution: z.enum(["heuristic", "unresolved"]),
      edgeCount: z.number().int().nonnegative(),
      affectedNodes: z.array(z.string()),
    }),
  ),
  riskAreas: z.array(
    z.strictObject({
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      unresolvedEdgeCount: z.number().int().nonnegative(),
    }),
  ),
  warnings: z.array(
    z.strictObject({
      code: z.enum([
        "onboarding/no-entry-endpoint",
        "onboarding/learning-order-truncated",
      ]),
      message: z.string(),
    }),
  ),
});

/**
 * causoryn_generate_onboarding (TŞ §16 Onboarding; C5): beginner/
 * intermediate/maintainer profiline göre giriş noktaları, ilk 5 yüksek
 * merkezi modül, öğrenme sırası (SCC ile döngü yoğunlaştırma), kritik
 * akışlar, testler, bilinmeyen kenarlar ve riskli alanlar — TAMAMI yapısal
 * veri. Açıklayıcı doğal dil host modelin işidir; bu araç şablon gerekçe
 * taşır (TŞ §16).
 */
export function generateOnboardingTool(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GenerateOnboardingInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);

  if (input.focus !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "focus bu araç yüzeyinde henüz açılmadı (rapor şimdilik tüm yayınlanmış snapshot için üretilir)",
    );
  }

  // exactOptionalPropertyTypes: zod optional alanları `number | undefined`
  // tipinde gelir; çekirdek Partial<OnboardingLimits> sözleşmesi undefined
  // özellik taşımaz — yalnızca VERİLMİŞ alanlar kopyalanır.
  const limits =
    input.limits === undefined
      ? undefined
      : {
          ...(input.limits.entryPointLimit === undefined
            ? {}
            : { entryPointLimit: input.limits.entryPointLimit }),
          ...(input.limits.topModuleCount === undefined
            ? {}
            : { topModuleCount: input.limits.topModuleCount }),
          ...(input.limits.maxLearningSteps === undefined
            ? {}
            : { maxLearningSteps: input.limits.maxLearningSteps }),
          ...(input.limits.maxCriticalFlows === undefined
            ? {}
            : { maxCriticalFlows: input.limits.maxCriticalFlows }),
        };

  const report = runGraph(deps.logger, () =>
    generateOnboarding(read.snapshot, {
      profile: input.audience,
      ...(limits === undefined ? {} : { limits }),
    }),
  );

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings: staleWarningOf(read),
    data: report,
  });
}

/* ------------------------------------------------------------------ */
/* C6 — causoryn_export_documentation                                  */
/* ------------------------------------------------------------------ */

export const ExportDocumentationInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2/§16 "format": json|markdown|mermaid|html|snapshot. */
  format: z.enum(EXPORT_DOCUMENTATION_FORMATS),
  /** Hedef çıktı dizini; config.output.allowedOutputDirs beyanında olmalıdır
   * (görev sözleşmesi: yazma yalnızca C6 output yetkilendirmesi üzerinden).
   * TŞ §10.2 "output?" alanının bu dilimdeki adıdır; EXPLICIT beyan ilkesi
   * gereği zorunludur (implicit yazma hedefi yoktur). */
  outputDir: z.string().min(1),
  /** SAF dosya adı (ayraçsız); verilmezse formatın varsayılan adı kullanılır. */
  fileName: z.string().min(1).optional(),
  /** TŞ §10.2 "view?": `architecture` (varsayılan görsel/özet mimari görünümü),
   * `interactive` (yalnızca HTML etkileşimli offline portal), `full` (ham
   * snapshot dökümü). `wiki` görünümü ayrı Living Wiki diliminde olduğundan
   * açık INVALID_ARGUMENT döndürür. */
  view: z.string().min(1).optional(),
  /** Mimari projeksiyon seçenekleri (yalnızca `architecture` / `interactive`). */
  options: ArchitectureProjectionOptionsSchema.optional(),
  /** Host-LLM tarafından Causoryn MCP çıktılarından sentezlenen ve fail-closed
   * doğrulanan mimari anotasyonlar (yalnızca `architecture` / `interactive`). */
  annotations: ArchitectureAnnotationsSchema.optional(),
});

const ExportArchitectureSummarySchema = z.strictObject({
  moduleCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  cycleCount: z.number().int().nonnegative(),
  entrypointCount: z.number().int().nonnegative(),
  contractCount: z.number().int().nonnegative(),
  flowCount: z.number().int().nonnegative(),
  annotated: z.boolean(),
  moduleIds: z.array(z.string()),
});

export const ExportDocumentationDataSchema = z.strictObject({
  path: z.string(),
  format: z.enum(EXPORT_DOCUMENTATION_FORMATS),
  bytes: z.number().int().positive(),
  atomic: z.literal(true),
  view: z.enum(EXPORT_DOCUMENTATION_VIEWS).optional(),
  architectureSummary: ExportArchitectureSummarySchema.optional(),
});

/**
 * causoryn_export_documentation (TŞ §16 Documentation Generator + export
 * güvenliği; C6 + v0.2.2 görsel mimari portal & Host-LLM anotasyonları):
 * yayınlanmış snapshot'ı istenen format ve görünümde deterministik serializer
 * ile üretir ve YALNIZCA OutputAccessPolicy beyanlı output dizinine atomik
 * yazar (.tmp + rename). Varsayılan `view="architecture"` katmanlı SVG/Mermaid
 * mimari görünümü üretir (`html` sıfır-JS katı CSP'lidir); `view="interactive"`
 * yalnızca HTML için etkileşimli offline portal (pan/zoom/arama/kanıt çekmecesi)
 * sunar; `view="full"` ham snapshot dökümüdür. `annotations` alanındaki tüm
 * moduleId/nodeId/evidenceId/keyFiles kimlikleri fail-closed doğrulanır.
 */
export function exportDocumentationTool(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof ExportDocumentationInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);

  let effectiveView: ExportDocumentationView | undefined;
  if (input.view !== undefined) {
    if (input.view === "wiki") {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        'view="wiki" bu araç yüzeyinde desteklenmez; wiki görünümü Living Wiki araçlarına aittir (izinli view değerleri: architecture, interactive, full)',
      );
    }
    const parsedView = exportDocumentationViewSchema.safeParse(input.view);
    if (!parsedView.success) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `Bilinmeyen view: ${input.view}; izinli değerler: ${EXPORT_DOCUMENTATION_VIEWS.join(", ")}`,
      );
    }
    effectiveView = parsedView.data;
  } else if (input.format !== "snapshot") {
    effectiveView = "architecture";
  }

  if (deps.outputPolicy === null) {
    // TŞ §10.1 sabit EXPORT_NOT_ALLOWED (takım denetimi bulgusu): beyansız
    // output listesi de export yazma reddinin tam karşılığıdır (default deny).
    throw new CausorynToolError(
      "EXPORT_NOT_ALLOWED",
      "sunucu konfigürasyonunda output.allowedOutputDirs beyanı yok (default deny); yazma hedefi beyan edilmeden export yapılamaz",
    );
  }
  const outputPolicy = deps.outputPolicy;

  const result = runGraph(deps.logger, () =>
    writeDocumentation(
      {
        snapshot: read.snapshot,
        format: input.format,
        outputDir: input.outputDir,
        ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
        ...(effectiveView === undefined ? {} : { view: effectiveView }),
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.annotations === undefined ? {} : { annotations: input.annotations }),
      },
      outputPolicy,
    ),
  );

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings: staleWarningOf(read),
    data: result,
  });
}

/* ------------------------------------------------------------------ */
/* C7 — causoryn_architecture_timeline                                 */
/* ------------------------------------------------------------------ */

export const ArchitectureTimelineInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "refs/range": refs listesi YA DA bounded aralık; çekirdek
   * sözleşmesi gereği TAM OLARAK BİRİ verilmelidir. */
  refs: z.array(z.string().min(1)).min(2).optional(),
  range: z
    .strictObject({ from: z.string().min(1), to: z.string().min(1) })
    .optional(),
  /** TŞ §13 sampling: tavan TIMELINE_CEILINGS.maxRevisions (60). */
  maxRevisions: z.number().int().min(2).optional(),
  /** Bounded history-range yürüyüş tavanı (çekirdek tavanı 500). */
  maxRangeWalk: z.number().int().min(2).optional(),
  /** TŞ §10.2 "granularity": nokta seçimi (commit/tag/milestone) bu dilimde
   * çekirdeğe bağlı değil (açık ret). */
  granularity: z.string().min(1).optional(),
});

const TimelinePointSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  sourceIndex: z.number().int().nonnegative(),
  ref: z.string(),
  status: z.enum(["analyzed", "unanalyzed"]),
  nodeCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  apiSurfaceNodeCount: z.number().int().nonnegative().optional(),
  unanalyzedReason: z.string().optional(),
});

const TimelineChangesSchema = z.strictObject({
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
});

const TimelineIntervalSchema = z.union([
  z.strictObject({
    kind: z.literal("diff"),
    fromIndex: z.number().int().nonnegative(),
    toIndex: z.number().int().nonnegative(),
    fromSourceIndex: z.number().int().nonnegative(),
    toSourceIndex: z.number().int().nonnegative(),
    fromRef: z.string(),
    toRef: z.string(),
    changes: TimelineChangesSchema,
  }),
  z.strictObject({
    kind: z.literal("unanalyzed-interval"),
    fromIndex: z.number().int().nonnegative(),
    toIndex: z.number().int().nonnegative(),
    fromSourceIndex: z.number().int().nonnegative(),
    toSourceIndex: z.number().int().nonnegative(),
    fromRef: z.string(),
    toRef: z.string(),
    reasons: z.strictObject({
      from: z.string().optional(),
      to: z.string().optional(),
      pair: z.string().optional(),
    }),
  }),
]);

/* Sprint-6 E5 — ihlal trendi şemaları: TŞ §13 trend göstergelerinden
 * cycles + layer violations dilimi. Bilinçli olarak BİLEŞİK SKOR ALANI
 * YOKTUR (TŞ §13: ölçüler kalite skoru olarak tek sayıya indirgenmez);
 * trendler metrik başına AYRI diziler halinde döner. */
const TimelineTrendSeriesValueSchema = z.union([
  z.strictObject({
    index: z.number().int().nonnegative(),
    ref: z.string(),
    count: z.number().int().nonnegative(),
  }),
  z.strictObject({
    index: z.number().int().nonnegative(),
    ref: z.string(),
    count: z.null(),
    reason: z.string(),
  }),
]);

const TimelineTrendStepSchema = z.strictObject({
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  fromRef: z.string(),
  toRef: z.string(),
  fromCount: z.number().int().nonnegative(),
  toCount: z.number().int().nonnegative(),
  direction: z.enum(["increasing", "decreasing", "flat"]),
});

const TimelineTrendSeriesSchema = z.strictObject({
  metric: z.enum(["no-cycles", "forbidden-dependency"]),
  values: z.array(TimelineTrendSeriesValueSchema),
  steps: z.array(TimelineTrendStepSchema),
  direction: z.enum(["increasing", "decreasing", "flat", "undetermined"]),
});

const TimelineTrendPointSchema = z.union([
  z.strictObject({
    index: z.number().int().nonnegative(),
    ref: z.string(),
    status: z.literal("evaluated"),
    evaluatedRules: z.number().int().nonnegative(),
    noCyclesViolations: z.number().int().nonnegative(),
    noCyclesSuppressed: z.number().int().nonnegative(),
    forbiddenDependencyViolations: z.number().int().nonnegative(),
    forbiddenDependencySuppressed: z.number().int().nonnegative(),
  }),
  z.strictObject({
    index: z.number().int().nonnegative(),
    ref: z.string(),
    status: z.literal("unavailable"),
    reason: z.string(),
  }),
]);

const TimelineViolationTrendSchema = z.strictObject({
  evaluatedPoints: z.number().int().nonnegative(),
  unavailablePoints: z.number().int().nonnegative(),
  points: z.array(TimelineTrendPointSchema),
  series: z.array(TimelineTrendSeriesSchema),
});

const ArchitectureTimelineSchema = z.strictObject({
  requestedPoints: z.number().int().nonnegative(),
  analyzedPoints: z.number().int().nonnegative(),
  unanalyzedPoints: z.number().int().nonnegative(),
  points: z.array(TimelinePointSchema),
  intervals: z.array(TimelineIntervalSchema),
  sampling: z.strictObject({
    applied: z.boolean(),
    maxRevisions: z.number().int().min(2),
    requestedPoints: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    skipped: z.array(
      z.strictObject({
        sourceIndex: z.number().int().nonnegative(),
        ref: z.string(),
      }),
    ),
  }),
  limits: z.strictObject({
    maxRevisions: z.number().int().min(2),
    maxRangeWalk: z.number().int().min(2),
  }),
  /** Sprint-6 E5: ihlal trendi (nokta başına C2 guard değerlendirmesi). */
  trend: TimelineViolationTrendSchema,
});

export const ArchitectureTimelineDataSchema = z.strictObject({
  refs: z.array(z.string()).nullable(),
  range: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
  timeline: ArchitectureTimelineSchema,
});

/**
 * causoryn_architecture_timeline (TŞ §13 Timeline; C7 + sprint-6 E5 evrim):
 * refs listesi veya bounded history-range üzerinden mimari snapshot
 * noktaları seçilir (deterministik eşit aralıklı sampling; uçlar korunur),
 * seçilen noktaların `.causoryn/architecture-snapshot.json` blob'ları
 * salt-okunur git okumasıyla alınır ve ardışık diff özetleri compare
 * çekirdeğinden türetilir. Analiz edilemeyen noktalar/aralıklar AÇIK
 * raporlanır; hiçbir sayı uydurulmaz. Ref çözümlemesi sampling'den ÖNCE
 * yapılır: var olmayan ref asla sessizce atlanmaz.
 *
 * Sprint-6 E5 (ihlal trendi): seçilmiş her noktanın içerik kümesi C2 guard
 * kurallarıyla (no-cycles / forbidden-dependency — o ref'teki
 * `.causoryn/architecture.rules.yaml` ve varsa
 * `.causoryn/architecture.baseline.yaml` blob'larıyla) nokta başına
 * değerlendirilir ve `trend` bölümünde raporlanır. Trendler metrik başına
 * AYRI dizilerdir; nokta başına aktif + baskılanmış ihlal sayıları ayrı
 * alanlardır; TŞ §13 gereği hiçbir bileşik "kalite skoru" üretilmez.
 * Policy blob'u olmayan/bozuk ref'lerde trend noktası coded 'unavailable'
 * olur (sıfır ihlal UYDURULMAZ); diff aralıkları (Sprint-3 davranışı)
 * etkilenmez.
 */
export async function architectureTimeline(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof ArchitectureTimelineInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);

  if (input.granularity !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `granularity bu araç yüzeyinde henüz açılmadı (${input.granularity}); nokta seçimi şimdilik refs sırasıyla yapılır`,
    );
  }

  const timeline: ArchitectureTimeline = await runGraphAsync(deps.logger, () =>
    buildArchitectureTimelineFromGit(canonicalRoot, {
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.maxRevisions === undefined ? {} : { maxRevisions: input.maxRevisions }),
      ...(input.maxRangeWalk === undefined ? {} : { maxRangeWalk: input.maxRangeWalk }),
    }),
  );

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: null,
    status: "ok",
    coverage: null,
    warnings: [],
    data: {
      refs: input.refs === undefined ? null : [...input.refs],
      range: input.range === undefined ? null : { ...input.range },
      timeline,
    },
  });
}
