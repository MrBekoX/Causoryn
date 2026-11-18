import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { CausorynContext } from "./context.js";
import { CausorynToolError } from "./errors.js";
import {
  envelopeOutputSchema,
  errorEnvelope,
  type Envelope,
} from "./envelope.js";
import {
  AmbiguityDataSchema,
  CapabilitiesDataSchema,
  FindSymbolsDataSchema,
  FindSymbolsInputSchema,
  GetCapabilitiesInputSchema,
  GetEvidenceDataSchema,
  GetEvidenceInputSchema,
  GetSymbolContextDataSchema,
  GetSymbolContextInputSchema,
  IndexStatusDataSchema,
  IndexStatusInputSchema,
  MapDataSchema,
  MapSystemInputSchema,
  RefreshIndexDataSchema,
  RefreshIndexInputSchema,
  TraceExecutionDataSchema,
  TraceExecutionInputSchema,
  WorkspaceSummaryDataSchema,
  WorkspaceSummaryInputSchema,
  findSymbols,
  getCapabilities,
  getEvidence,
  getSymbolContext,
  indexStatus,
  mapSystem,
  refreshIndex,
  traceExecution,
  workspaceSummary,
} from "./services.js";
import {
  AnalyzeImpactDataSchema,
  AnalyzeImpactInputSchema,
  ArchitectureTimelineDataSchema,
  ArchitectureTimelineInputSchema,
  CheckArchitectureDataSchema,
  CheckArchitectureInputSchema,
  CompareArchitectureDataSchema,
  CompareArchitectureInputSchema,
  ExportDocumentationDataSchema,
  ExportDocumentationInputSchema,
  GenerateOnboardingDataSchema,
  GenerateOnboardingInputSchema,
  GetAgentContextDataSchema,
  GetAgentContextInputSchema,
  analyzeImpactTool,
  architectureTimeline,
  checkArchitecture,
  compareArchitecture,
  exportDocumentationTool,
  generateOnboardingTool,
  getAgentContext,
} from "./services-architecture.js";
import {
  WikiBuildDataSchema,
  WikiBuildInputSchema,
  WikiDiffDataSchema,
  WikiDiffInputSchema,
  WikiGetLinksDataSchema,
  WikiGetLinksInputSchema,
  WikiGetPageDataSchema,
  WikiGetPageInputSchema,
  WikiGetTreeDataSchema,
  WikiGetTreeInputSchema,
  WikiGetVersionsDataSchema,
  WikiGetVersionsInputSchema,
  WikiSearchDataSchema,
  WikiSearchInputSchema,
  wikiBuild,
  wikiDiff,
  wikiGetLinks,
  wikiGetPage,
  wikiGetTree,
  wikiGetVersions,
  wikiSearch,
} from "./services-wiki.js";
import {
  CheckContractsDataSchema,
  CheckContractsInputSchema,
  DetectContractDriftDataSchema,
  DetectContractDriftInputSchema,
  DeriveTestPlanDataSchema,
  DeriveTestPlanInputSchema,
  PreflightChangeDataSchema,
  PreflightChangeInputSchema,
  TraceBusinessFlowDataSchema,
  TraceBusinessFlowInputSchema,
  checkContracts,
  detectContractDriftTool,
  deriveTestPlan,
  preflightChange,
  traceBusinessFlow,
} from "./services-differentiation.js";
import {
  VerifyChangeDataSchema,
  VerifyChangeInputSchema,
  verifyChangeTool,
} from "./services-verification.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * MCP protokol adaptasyonu (TŞ v2.1 §5/§10, ADR-003): SDK McpServer
 * üzerinden tam olarak 29 gerçek araç yayımlanır (sprint-1: 5 çekirdek araç;
 * sprint-2 B6: causoryn_index_status + causoryn_refresh_index; sprint-2 B5:
 * causoryn_get_symbol_context; sprint-2 B4: causoryn_trace_execution;
 * sprint-3 C8: causoryn_analyze_impact, causoryn_check_architecture,
 * causoryn_compare_architecture, causoryn_get_agent_context,
 * causoryn_generate_onboarding, causoryn_export_documentation,
 * causoryn_architecture_timeline; sprint-4 W5 (Faz C2 Living Wiki, TŞ
 * §16A.8): causoryn_wiki_build + 6 salt-okunur wiki aracı; sprint-5
 * D2-D6 (Faz D Differentiation): causoryn_trace_business_flow,
 * causoryn_preflight_change, causoryn_check_contracts,
 * causoryn_detect_contract_drift, causoryn_derive_test_plan; sprint-6
 * E1-E3 (Faz E Agent Change Guard): causoryn_verify_change —
 * detect_contract_drift ile derive_test_plan arasında (TŞ §10.2 PDF s.10
 * katalog satır sırası); tools/list boş handler yayınlamaz — ADR-010).
 * Her araç:
 * - Zod inputSchema (SDK girdiyi otomatik doğrular; şema reddi protokol
 *   düzeyinde isError sonucu döner),
 * - Zod outputSchema (SDK structuredContent'i envelope şemasıyla doğrular),
 * - envelope yanıt (text fallback: JSON serileştirilmiş envelope — TŞ
 *   §10.1 "insan okunabilir kısa text fallback").
 *
 * Envelope düzeyi hatalar (WORKSPACE_NOT_AUTHORIZED, INDEX_NOT_READY, …)
 * isError=false structuredContent ile taşınır: statü sözleşmesidir, protokol
 * hatası değildir (TŞ §10.1 hata kodları yanıt gövdesinde yaşar).
 */

interface ToolRegistration {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly handler: (requestId: string, args: unknown) => Envelope | Promise<Envelope>;
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function envelopeResult(envelope: Envelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function buildRegistrations(context: CausorynContext): readonly ToolRegistration[] {
  return [
    {
      name: "causoryn_get_capabilities",
      title: "Causoryn yetenekleri",
      description:
        "Adapter düzeyleri (L0–L4), sunucu limitleri, protokol revizyonu ve yayımlanan araç listesini döndürür. Snapshot gerektirmez.",
      inputSchema: GetCapabilitiesInputSchema,
      outputSchema: envelopeOutputSchema(CapabilitiesDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getCapabilities(context, requestId, args as z.infer<typeof GetCapabilitiesInputSchema>),
    },
    {
      name: "causoryn_workspace_summary",
      title: "Workspace özeti",
      description:
        "Proje/framework/entrypoint/coverage özeti; tüm sayılar yayınlanmış graph snapshot'ından türetilir.",
      inputSchema: WorkspaceSummaryInputSchema,
      outputSchema: envelopeOutputSchema(WorkspaceSummaryDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        workspaceSummary(context, requestId, args as z.infer<typeof WorkspaceSummaryInputSchema>),
    },
    {
      name: "causoryn_index_status",
      title: "İndeks durumu",
      description:
        "Snapshot, stale, iş (job) ilerlemesi ve tanıları raporlar: jobId verilirse o iş, verilmezse en son iş; iş/snapshot yoksa null alanlar + yönlendirici uyarı döner.",
      inputSchema: IndexStatusInputSchema,
      outputSchema: envelopeOutputSchema(IndexStatusDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        indexStatus(context, requestId, args as z.infer<typeof IndexStatusInputSchema>),
    },
    {
      name: "causoryn_refresh_index",
      title: "İndeks yenileme",
      description:
        'Yeni snapshot işi başlatır (mode="full" | "incremental"): çağrı anında jobId döner, iş arka planda koşar; causoryn_index_status ile izlenir. mode="incremental" kaynak dosya karmaları değişmediyse mevcut yayını korur (no-op), senkron L0 başlangıç snapshot\'ını ise tam çok-dilli analize yükseltir. Yalnızca Causoryn\'in kendi graph deposuna (varsayılan süreç-içi InMemoryGraphRepository veya isteğe bağlı storage.dataDbPath SQLite kalıcı veri kökü) yazar; kaynak workspace dosyalarına yazmaz (Rust/Go sidecar\'ları derlenmemişse kendi toolchain target/cache dizinlerini kullanabilir).',
      inputSchema: RefreshIndexInputSchema,
      outputSchema: envelopeOutputSchema(RefreshIndexDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        refreshIndex(context, requestId, args as z.infer<typeof RefreshIndexInputSchema>),
    },
    {
      name: "causoryn_map_system",
      title: "Architecture Map",
      description:
        "L0–L3 düzeylerinde mimari harita: level/filters/maxNodes/cursor ile deterministik sıralı node+edge sayfaları; gerçek cursor sayfalama.",
      inputSchema: MapSystemInputSchema,
      outputSchema: envelopeOutputSchema(MapDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        mapSystem(context, requestId, args as z.infer<typeof MapSystemInputSchema>),
    },
    {
      name: "causoryn_find_symbols",
      title: "Sembol arama",
      description:
        "qualifiedName üzerinde tam/önek/içerir dereceli sembol arama; kind filtresi, limit, AMBIGUOUS_SYMBOL adayları.",
      inputSchema: FindSymbolsInputSchema,
      outputSchema: envelopeOutputSchema(
        // Hata yolu: AMBIGUOUS_SYMBOL data'sı aday listesi taşır (TŞ §10.3).
        AmbiguityDataSchema.or(FindSymbolsDataSchema),
      ),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        findSymbols(context, requestId, args as z.infer<typeof FindSymbolsInputSchema>),
    },
    {
      name: "causoryn_get_symbol_context",
      title: "Sembol bağlamı",
      description:
        "Sembol node'u + istenen derinliğe kadar komşu kenarlar (edgeKinds filtreli, deterministik sıralı) + kanıt kayıtları; symbolId node kimliği veya qualifiedName kabul eder (belirsiz ad AMBIGUOUS_SYMBOL adayları döner).",
      inputSchema: GetSymbolContextInputSchema,
      outputSchema: envelopeOutputSchema(
        // Hata yolu: AMBIGUOUS_SYMBOL data'sı aday listesi taşır (TŞ §10.3).
        AmbiguityDataSchema.or(GetSymbolContextDataSchema),
      ),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getSymbolContext(context, requestId, args as z.infer<typeof GetSymbolContextInputSchema>),
    },
    {
      name: "causoryn_trace_execution",
      title: "Execution Flow izi",
      description:
        "Entrypoint'ten (framework endpoint adı 'POST /orders' veya sembol adı/kimliği) CALLS ve ROUTES_TO kenarları üzerinde sınırlı, deterministik çağrı yolları: her yolun kenar listesi, kenar başına resolution + evidence ayrı alanlarda; zincir etiketi en zayıf kenar resolution'ıdır (heuristic kenarlı zincir verified gibi sunulmaz); unresolved kenarda zincir durur ve status partial olur. maxDepth/maxPaths config tavanlarıyla sınırlıdır; kesme truncated + warnings ile raporlanır.",
      inputSchema: TraceExecutionInputSchema,
      outputSchema: envelopeOutputSchema(
        // Hata yolu: AMBIGUOUS_SYMBOL data'sı aday listesi taşır (TŞ §10.3).
        AmbiguityDataSchema.or(TraceExecutionDataSchema),
      ),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        traceExecution(context, requestId, args as z.infer<typeof TraceExecutionInputSchema>),
    },
    {
      name: "causoryn_trace_business_flow",
      title: "Business Flow izi",
      description:
        "flowSeed'den (node kimliği veya tam qualifiedName) iş akışı zincirleri: ROUTES_TO/CALLS/PRODUCES_CONTRACT/CONSUMES_CONTRACT/CONTAINS kenarlarında bounded BFS + kontrat node'larında ters yön izleme. Her segment kendi certainty/resolution'ını ayrı alanlarda taşır; kopukluklar uydurma köprüyle DEĞİL gap segmentiyle raporlanır ve status partial olur; sınırlar TŞ §20 tavanlarıyla kırpılır ve truncated/rationale ile bildirilir. Belirsiz seed AMBIGUOUS_SYMBOL adaylarıyla, bilinmeyen seed SYMBOL_NOT_FOUND ile reddedilir (otomatik kesinleştirme yok).",
      inputSchema: TraceBusinessFlowInputSchema,
      outputSchema: envelopeOutputSchema(TraceBusinessFlowDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        traceBusinessFlow(
          context,
          requestId,
          args as z.infer<typeof TraceBusinessFlowInputSchema>,
        ),
    },
    {
      name: "causoryn_analyze_impact",
      title: "Etki analizi",
      description:
        "Hedef sembollerden ters kenar BFS ile bounded etki yolları: certainty (direct|indirect|possible) ile resolution (verified|heuristic|unresolved) ayrı alanlardır; mutlak etki iddiası üretilmez. Çözülemeyen hedefler unresolvedTargets'ta raporlanır; sınırlar TŞ §20 tavanlarına kırpılır ve rationale ile açıkça raporlanır.",
      inputSchema: AnalyzeImpactInputSchema,
      outputSchema: envelopeOutputSchema(AnalyzeImpactDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        analyzeImpactTool(context, requestId, args as z.infer<typeof AnalyzeImpactInputSchema>),
    },
    {
      name: "causoryn_check_architecture",
      title: "Architecture Guard",
      description:
        "Workspace kökündeki .causoryn/architecture.rules.yaml policy'sini yayınlanmış snapshot üzerinde değerlendirir (no-cycles Tarjan SCC + forbidden-dependency glob kuralları): TŞ §12 finding sözleşmesi {id, ruleId, severity, from, to, evidenceIds, suppression?, snapshotId}; baseline suppression (neden/sahip/tarih) bulguyu baskılar, policy'de karşılığı olmayan suppression orphanSuppressions'ta listelenir. Yalnızca bulgu raporlar; CI/çıkış kodu kararı vermez.",
      inputSchema: CheckArchitectureInputSchema,
      outputSchema: envelopeOutputSchema(CheckArchitectureDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        checkArchitecture(context, requestId, args as z.infer<typeof CheckArchitectureInputSchema>),
    },
    {
      name: "causoryn_compare_architecture",
      title: "Architecture Diff",
      description:
        "İki git ref'i (commit/tag/branch/sha veya working-tree) arasındaki mimari diff: node ek-çıkar-değişen kümeleri, belgeli confidence'lı rename eşleşmeleri, kenar değişimleri ve API yüzeyi değişimleri. Snapshot blob'ları salt-okunur git okumasıyla alınır (checkout/reset/clean yok); analiz edilemeyen revizyon INVALID_REVISION döndürür.",
      inputSchema: CompareArchitectureInputSchema,
      outputSchema: envelopeOutputSchema(CompareArchitectureDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        compareArchitecture(context, requestId, args as z.infer<typeof CompareArchitectureInputSchema>),
    },
    {
      name: "causoryn_get_agent_context",
      title: "AI Agent GPS",
      description:
        "Görev metnini yalnızca arama sorgusu olarak değerlendirip exact-symbol → graph-proximity → contract → freshness → fts ayaklarıyla sıralar: tokenBudget bütçesine kadar contextItems paketi (estimatedTokens, reason, evidence), omittedCount ve degrade ayaklar açıkça raporlanır. Görev metni çıktıya yazılmaz.",
      inputSchema: GetAgentContextInputSchema,
      outputSchema: envelopeOutputSchema(GetAgentContextDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getAgentContext(context, requestId, args as z.infer<typeof GetAgentContextInputSchema>),
    },
    {
      name: "causoryn_generate_onboarding",
      title: "Onboarding raporu",
      description:
        "beginner|intermediate|maintainer profiline göre yapısal onboarding verisi: giriş noktaları, ilk 5 yüksek merkezi modül, öğrenme sırası (döngüler SCC ile tek adımda), kritik akışlar, testler, bilinmeyen kenarlar ve riskli alanlar. Açıklayıcı doğal dil host modelin işidir; bu araç şablon gerekçe taşır.",
      inputSchema: GenerateOnboardingInputSchema,
      outputSchema: envelopeOutputSchema(GenerateOnboardingDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        generateOnboardingTool(
          context,
          requestId,
          args as z.infer<typeof GenerateOnboardingInputSchema>,
        ),
    },
    {
      name: "causoryn_export_documentation",
      title: "Documentation export",
      description:
        "Yayımlanmış snapshot'ı desteklenen formatta (json|markdown|mermaid|html|snapshot — mevcut EXPORT_DOCUMENTATION_FORMATS kümesi) deterministik olarak dışa aktarır. Yazma YALNIZCA config output.allowedOutputDirs beyanlı dizinine atomiktir (.tmp + rename); beyanlı olmayan hedef EXPORT_NOT_ALLOWED, reddedilen dosya adı PATH_DENIED döndürür. HTML offline self-contained'dır: escaping + CSP, CDN/analytics yok.",
      inputSchema: ExportDocumentationInputSchema,
      outputSchema: envelopeOutputSchema(ExportDocumentationDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        exportDocumentationTool(
          context,
          requestId,
          args as z.infer<typeof ExportDocumentationInputSchema>,
        ),
    },
    {
      name: "causoryn_preflight_change",
      title: "Preflight Manifest",
      description:
        "intent + targetSymbols/targetFiles hedef kümesinden ADAY Preflight Manifest üretir: impactCandidates (certainty/resolution ayrı alanlar), contractChecks, testPlanId (gömülü D6 test planının içerik adresli referansı), limitations ve sourceRevision (salt-okunur dosya okumasıyla HEAD; komut çalıştırma yok). KOD YAZMAZ: candidateOnly sabit true'dur ve çalışma ağacı değişmez; üretilen manifest yanıt gövdesinde döner ve causoryn_verify_change(preflightId) çözümü için yalnızca süreç-içi PreflightManifestStore belleğinde (FIFO 200) tutulur — diske veya kaynak ağaca asla yazılmaz. Sembole bağlanamayan hedef requiresDisambiguation + candidateTargets ile raporlanır (otomatik kesinleştirme yok, TŞ §10.3). Hedef dosyalar WorkspaceAccessPolicy kararı olmadan kullanılamaz (fail-closed).",
      inputSchema: PreflightChangeInputSchema,
      outputSchema: envelopeOutputSchema(PreflightChangeDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        preflightChange(context, requestId, args as z.infer<typeof PreflightChangeInputSchema>),
    },
    {
      name: "causoryn_check_contracts",
      title: "Sözleşme değerlendirmesi",
      description:
        "Sözleşme sürüm çiftlerini (contracts: {name?, base, target} spec dosyaları; WorkspaceAccessPolicy ile salt okunur keşif) checkContractCompatibility çekirdeğiyle değerlendirir: backward-safe/risk/breaking_candidate/unknown sınıflaması, kural adı + eski/yeni satır kanıtı taşıyan bulgular ve çift-bağlanamayan tanılar ayrı raporlanır. Sınıflama statik delildir: serializer/runtime davranışı bilinemediğinde unknown üretilir ve breaking delilini gizlemez (TŞ §11).",
      inputSchema: CheckContractsInputSchema,
      outputSchema: envelopeOutputSchema(CheckContractsDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        checkContracts(context, requestId, args as z.infer<typeof CheckContractsInputSchema>),
    },
    {
      name: "causoryn_detect_contract_drift",
      title: "Contract Drift",
      description:
        "İki sürümün spec dosyaları (base/target) arasında canonical drift: K-013(7) contractChanges ({contractId, changeKind, summary}), breaking_candidate/risk/unknown AYRI alanlarda, PRODUCES_CONTRACT/CONSUMES_CONTRACT etki grafı (kenar resolution ASLA yükseltilmez; anchorFiles ile tüketici/üretici ankrajları taranır) ve tüketici kenarı bulunamayan değişiklikler unconsumedChanges'te dürüstçe raporlanır (unresolved consumers, TŞ §11). scope matchKey daraltmasıdır.",
      inputSchema: DetectContractDriftInputSchema,
      outputSchema: envelopeOutputSchema(DetectContractDriftDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        detectContractDriftTool(
          context,
          requestId,
          args as z.infer<typeof DetectContractDriftInputSchema>,
        ),
    },
    {
      name: "causoryn_verify_change",
      title: "Agent Change Guard",
      description:
        "Değişiklik sonrası mimari bütünlüğü tekrarlanabilir kurallarla DOĞRULAR; kod yazmaz, çalışma ağacını değiştirmez ve test ÇALIŞTIRMAZ (TŞ §10.4). Taban yayın (preflightId manifestinden veya baseSnapshot kimliğinden) ile working-tree projeksiyonunu dört denetimde değerlendirir: architecture (workspace kökündeki .causoryn/architecture.rules.yaml guard kuralları; dosya yoksa denetim not_evaluated), contracts (bu yüzeyden üretilemez — spec çifti girdide yoktur; istenirse not_evaluated), graph-diff (taban ↔ çalışma ağacı içerik farkı) ve test-plan (D6 adayları; koşum durumu dürüstlüğü: not_run varsayılan, observed yalnızca evidenceRef'li kanıtlı host kaydıyla — 'passed' iddiası yalnızca kanıt + gerçekten geçen rapor sayılarıyla mümkündür). Verdict sabit kural zincirinden gelir: no_findings | review_required | blocking_findings | inconclusive; no_findings güvenli/kod garantisi DEĞİLDİR ve her raporda dürüstlük uyarıları taşınır. Rapor byte-deterministiktir: aynı working-tree + aynı taban = bit-bit aynı rapor (sprint kapısı).",
      inputSchema: VerifyChangeInputSchema,
      outputSchema: envelopeOutputSchema(VerifyChangeDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        verifyChangeTool(context, requestId, args as z.infer<typeof VerifyChangeInputSchema>),
    },
    {
      name: "causoryn_derive_test_plan",
      title: "Test planı adayları",
      description:
        "changeSet (changedSymbols/changedFiles) için deterministik test adayları: TESTS kenarları (direct), değişen çağrı noktalarından CALLS zincirleri (call-site) ve test-dosyası adlandırma bağlamı (naming; daima heuristic). Her aday reason + evidenceIds + matchLevel taşır; TESTS kenarı bilmeyen değişen semboller missingCoverageCandidates'tır. Test ÇALIŞTIRILMAZ ve 'geçti' iddiası ÜRETİLMEZ (TŞ §15); plan kimliği içerik adreslidir (testplan:<sha256>) ve preflight_change testPlanId'siyle bire bir eşleşir. preflightId girdisi bu dilimde çözümlenmez (açık INVALID_ARGUMENT).",
      inputSchema: DeriveTestPlanInputSchema,
      outputSchema: envelopeOutputSchema(DeriveTestPlanDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        deriveTestPlan(context, requestId, args as z.infer<typeof DeriveTestPlanInputSchema>),
    },
    {
      name: "causoryn_get_evidence",
      title: "Evidence provenance",
      description:
        "Node/edge/evidence/finding kimliğinin kanıt zinciri (TŞ §10.2 'node/edge/finding IDs'): her kayıt relativePath + startLine/endLine + sourceHash + analyzerId + rationale taşır; eksik alanlı eski kayıtlar partial=true + missingFields ile AÇIK işaretlenir, her kayıt bağlı graf bağlam referanslarını (contextRefs: katkı eden kenar / karşı uç node / bulgu) taşır ve chain özeti (targetKind/targetId/order/recordCount/partialCount/empty) deterministik düzene dair açık durum verir. finding:<sha256> kimlikleri snapshot'ta yaşamaz; workspace kökündeki .causoryn/architecture.rules.yaml policy'sinden deterministik türetilerek çözülür (check_architecture çıktısındaki kimlikleri kullanın). Policy yokluğu/bozukluğu POLICY_INVALID, türetilen bulgularla eşleşmeyen kimlik EVIDENCE_NOT_FOUND döndürür.",
      inputSchema: GetEvidenceInputSchema,
      outputSchema: envelopeOutputSchema(GetEvidenceDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getEvidence(context, requestId, args as z.infer<typeof GetEvidenceInputSchema>),
    },
    {
      name: "causoryn_architecture_timeline",
      title: "Architecture Timeline",
      description:
        "Git refs listesi veya bounded history-range üzerinden mimari zaman çizgisi: deterministik eşit aralıklı sampling (maxRevisions; uçlar korunur, atlanan noktalar skipped listesinde açık), seçilen noktaların snapshot blob'ları salt-okunur git okumasıyla alınır ve ardışık diff özetleri raporlanır. Faz E evrim görünümü: milestone bazlı özetler + ihlal trendi (no-cycles/forbidden ihlal sayıları nokta başına ayrı raporlanır — kalite tek sayıya indirgenmez). Analiz edilemeyen noktalar/aralıklar AÇIK raporlanır; hiçbir sayı uydurulmaz.",
      inputSchema: ArchitectureTimelineInputSchema,
      outputSchema: envelopeOutputSchema(ArchitectureTimelineDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        architectureTimeline(
          context,
          requestId,
          args as z.infer<typeof ArchitectureTimelineInputSchema>,
        ),
    },
    {
      name: "causoryn_wiki_build",
      title: "Wiki build",
      description:
        "Yayımlanmış graph snapshot'ından deterministik WikiSnapshot üretir ve YALNIZCA config wiki.dataDbPath ile beyanlı izinli Causoryn data-root SQLite dosyasına atomik publish ile yazar (kaynak workspace dosyalarına yazma yok; beyansız sunucuda default deny). Sayfa ağacı (TŞ §16A.1 taksonomisi; boş kategori no_data, uydurulmaz), çift yönlü linkler + broken-link diagnostics (K-013 #4), sayfa sürümleri ve wiki_fts aynı building satırına yazılır; aynı graph snapshot için ikinci build idempotent no-op raporlar. mode=full tüm sayfaları yeniden üretir; mode=incremental (K-013 #2, TŞ §16A.5 madde 4) W6 motoruyla yalnızca ilişkili pageId'leri yeniler (contentHash koruması); önceki WikiSnapshot/kaynak graph yoksa veya motor fallback kararı verirse graceful full build + data.fallbackReason (data.mode yürütülen modu bildirir).",
      inputSchema: WikiBuildInputSchema,
      outputSchema: envelopeOutputSchema(WikiBuildDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        wikiBuild(context, requestId, args as z.infer<typeof WikiBuildInputSchema>),
    },
    {
      name: "causoryn_wiki_get_tree",
      title: "Wiki sayfa ağacı",
      description:
        "Wiki sayfa ağacı hiyerarşisi (salt okunur): 12 kök kategori + alt sayfalar taksonomi sırasıyla, childCount + coverage/freshness ile; depth alt ağaç tavanı, parentId alt ağaç kökü, limit/cursor (K-013 #5) sayfalama. no_data kategoriler dolgusuz listelenir.",
      inputSchema: WikiGetTreeInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetTreeDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetTree(context, requestId, args as z.infer<typeof WikiGetTreeInputSchema>),
    },
    {
      name: "causoryn_wiki_get_page",
      title: "Wiki sayfası",
      description:
        "Tek wiki sayfası (salt okunur): generated layer bölümleri (sectionKey filtresi + bölüm sayfalaması), evidenceRefs provenance, coverage/freshness ve tüm bölümlerden türetilen sourceRefs. Overlay anotasyonlar bu araçta dönmez (TŞ §16A.6: ayrı yerel UI/CLI akışı).",
      inputSchema: WikiGetPageInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetPageDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetPage(context, requestId, args as z.infer<typeof WikiGetPageInputSchema>),
    },
    {
      name: "causoryn_wiki_search",
      title: "Wiki arama",
      description:
        "Wiki sayfa araması (salt okunur): kaçışlı çok alanlı FTS5 sorgu; sıralama exact sembol/route > başlık > modül > BM25 > graph yakınlığı; matchedFields + evidenceIds relevance açıklaması, snippet, cursor/limit sayfalama (K-013 #5). Embedding skoru yoktur (kırmızı çizgi #1); yakınlık ayağı verisi yoksa skippedRankLegs ile dürüst degrade.",
      inputSchema: WikiSearchInputSchema,
      outputSchema: envelopeOutputSchema(WikiSearchDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiSearch(context, requestId, args as z.infer<typeof WikiSearchInputSchema>),
    },
    {
      name: "causoryn_wiki_get_links",
      title: "Wiki bağlantıları",
      description:
        "Sayfanın outgoing + incoming (backlink) bağlantıları (salt okunur): resolution + evidence ile, linkKinds filtresi ve K-013 #5 sayfalama; toPageId=null kalan bozuk linkler brokenLinkDiagnostics ile raporlanır (K-013 #4: kayıt korunur, sessiz silinmez).",
      inputSchema: WikiGetLinksInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetLinksDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetLinks(context, requestId, args as z.infer<typeof WikiGetLinksInputSchema>),
    },
    {
      name: "causoryn_wiki_get_versions",
      title: "Wiki sürümleri",
      description:
        "Erişilebilir Git/snapshot revizyonları (salt okunur): veri kökündeki yayımlanmış WikiSnapshot revizyonu available (pageId ile sayfa sürümü: contentHash/linkSetHash/templateVersion/coverage); refs commit/tag/branch alias'ları salt-okunur git-read (cat-file) ile çözülür — çözülemeyen alias INVALID_REVISION, revizyon kaydı olmayan çözümlenmiş ref not_available + gerekçe.",
      inputSchema: WikiGetVersionsInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetVersionsDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        wikiGetVersions(
          context,
          requestId,
          args as z.infer<typeof WikiGetVersionsInputSchema>,
        ),
    },
    {
      name: "causoryn_wiki_diff",
      title: "Wiki diff",
      description:
        "İki WikiSnapshot arası sayfa farkları (salt okunur; working tree değişmez): addedPages/removedPages, changedSections, addedLinks/removedLinks, coverageDelta ({previous, current, reason?} — K-013 #3) ve unresolvedDifferences. contractChanges ({contractId, changeKind, summary} — K-013 #7) iki WikiSnapshot'ın arka graph snapshot'larının sözleşme node yüzeyleri (ApiContract/EventContract/SchemaContract/ContractVersion) üzerinden hesaplanır; arka graph çözümlenemediğinde [] + çözümleme başarısızlığı uyarısı döner, iki yüzeyde de sözleşme kaydı yoksa gerçek [] döner (boşluk notu yok — K-013(7) gövdesi kesindir).",
      inputSchema: WikiDiffInputSchema,
      outputSchema: envelopeOutputSchema(WikiDiffDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiDiff(context, requestId, args as z.infer<typeof WikiDiffInputSchema>),
    },
  ];
}

/** Context'i MCP McpServer'a bağlar; tam olarak 29 araç kaydeder. */
export function createCausorynMcpServer(context: CausorynContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  for (const registration of buildRegistrations(context)) {
    server.registerTool(
      registration.name,
      {
        title: registration.title,
        description: registration.description,
        inputSchema: registration.inputSchema,
        outputSchema: registration.outputSchema,
        annotations: registration.annotations,
      },
      async (args, extra) => {
        const requestId = String(extra.requestId);
        try {
          const envelope = await registration.handler(requestId, args);
          return envelopeResult(envelope);
        } catch (error) {
          if (error instanceof CausorynToolError) {
            context.logger(
              `tool ${registration.name} envelope hatası: ${error.code}: ${error.message}`,
            );
            return envelopeResult(
              errorEnvelope(requestId, context.config.workspaceId, null, error),
            );
          }
          // Ham hata mesajı (sürücü/kütüphane detayı: tablo adı, kimlik,
          // mutlak yol…) YALNIZCA stderr loguna gider; istemciye requestId
          // korelasyonlu genel mesaj döner (TŞ §10.1: stack/stack detayı
          // sonuca girmez; iç detay sızması da aynı ilkeye tabidir).
          const detail = error instanceof Error ? error.message : String(error);
          context.logger(`tool ${registration.name} beklenmeyen hata: ${detail}`);
          return envelopeResult(
            errorEnvelope(
              requestId,
              context.config.workspaceId,
              null,
              new CausorynToolError(
                "INTERNAL_ERROR",
                `Beklenmeyen iç hata; ayrıntılar sunucu loglarında (requestId: ${requestId})`,
              ),
            ),
          );
        }
      },
    );
  }
  return server;
}
