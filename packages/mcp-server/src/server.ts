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
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * MCP protokol adaptasyonu (TŞ v2.1 §5/§10, ADR-003): SDK McpServer
 * üzerinden tam olarak 23 gerçek araç yayımlanır (sprint-1: 5 çekirdek araç;
 * sprint-2 B6: causoryn_index_status + causoryn_refresh_index; sprint-2 B5:
 * causoryn_get_symbol_context; sprint-2 B4: causoryn_trace_execution;
 * sprint-3 C8: causoryn_analyze_impact, causoryn_check_architecture,
 * causoryn_compare_architecture, causoryn_get_agent_context,
 * causoryn_generate_onboarding, causoryn_export_documentation,
 * causoryn_architecture_timeline; sprint-4 W5 (Faz C2 Living Wiki, TŞ
 * §16A.8): causoryn_wiki_build + 6 salt-okunur wiki aracı; tools/list boş
 * handler yayınlamaz — ADR-010).
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
  readonly handler: (requestId: string, args: unknown) => Envelope | Promise<Envelope>;
}

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
      handler: (requestId, args) =>
        indexStatus(context, requestId, args as z.infer<typeof IndexStatusInputSchema>),
    },
    {
      name: "causoryn_refresh_index",
      title: "İndeks yenileme",
      description:
        "Yeni snapshot işi başlatır (mode: full; incremental Live Architecture dilimine aittir): çağrı anında jobId döner, iş arka planda koşar; causoryn_index_status ile izlenir. Yalnızca Causoryn izinli data-root'una yazar.",
      inputSchema: RefreshIndexInputSchema,
      outputSchema: envelopeOutputSchema(RefreshIndexDataSchema),
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
      handler: (requestId, args) =>
        traceExecution(context, requestId, args as z.infer<typeof TraceExecutionInputSchema>),
    },
    {
      name: "causoryn_analyze_impact",
      title: "Etki analizi",
      description:
        "Hedef sembollerden ters kenar BFS ile bounded etki yolları: certainty (direct|indirect|possible) ile resolution (verified|heuristic|unresolved) ayrı alanlardır; mutlak etki iddiası üretilmez. Çözülemeyen hedefler unresolvedTargets'ta raporlanır; sınırlar TŞ §20 tavanlarına kırpılır ve rationale ile açıkça raporlanır.",
      inputSchema: AnalyzeImpactInputSchema,
      outputSchema: envelopeOutputSchema(AnalyzeImpactDataSchema),
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
        "Yayımlanmış snapshot'ı json|markdown|mermaid|html formatında deterministik olarak dışa aktarır. Yazma YALNIZCA config output.allowedOutputDirs beyanlı dizinine atomiktir (.tmp + rename); beyanlı olmayan hedef EXPORT_NOT_ALLOWED, reddedilen dosya adı PATH_DENIED döndürür. HTML offline self-contained'dır: escaping + CSP, CDN/analytics yok.",
      inputSchema: ExportDocumentationInputSchema,
      outputSchema: envelopeOutputSchema(ExportDocumentationDataSchema),
      handler: (requestId, args) =>
        exportDocumentationTool(
          context,
          requestId,
          args as z.infer<typeof ExportDocumentationInputSchema>,
        ),
    },
    {
      name: "causoryn_get_evidence",
      title: "Evidence provenance",
      description:
        "Node/edge/evidence kimliğinin kanıt dizisi: relativePath, startLine/endLine, sourceHash, analyzerId, rationale. Yayınlanmış snapshot'ta olmayan kimlik EVIDENCE_NOT_FOUND döndürür.",
      inputSchema: GetEvidenceInputSchema,
      outputSchema: envelopeOutputSchema(GetEvidenceDataSchema),
      handler: (requestId, args) =>
        getEvidence(context, requestId, args as z.infer<typeof GetEvidenceInputSchema>),
    },
    {
      name: "causoryn_architecture_timeline",
      title: "Architecture Timeline",
      description:
        "Git refs listesi veya bounded history-range üzerinden mimari zaman çizgisi: deterministik eşit aralıklı sampling (maxRevisions; uçlar korunur, atlanan noktalar skipped listesinde açık), seçilen noktaların snapshot blob'ları salt-okunur git okumasıyla alınır ve ardışık diff özetleri raporlanır. Analiz edilemeyen noktalar/aralıklar AÇIK raporlanır; hiçbir sayı uydurulmaz.",
      inputSchema: ArchitectureTimelineInputSchema,
      outputSchema: envelopeOutputSchema(ArchitectureTimelineDataSchema),
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
        "İki WikiSnapshot arası sayfa farkları (salt okunur; working tree değişmez): addedPages/removedPages, changedSections, addedLinks/removedLinks, coverageDelta ({previous, current, reason?} — K-013 #3) ve unresolvedDifferences. contractChanges ({contractId, changeKind, summary} — K-013 #7) iki WikiSnapshot'ın arka graph snapshot'larının sözleşme node yüzeyleri (ApiContract/EventContract/SchemaContract/ContractVersion) üzerinden hesaplanır; arka graph çözümlenemediğinde veya iki yüzeyde de sözleşme kaydı yoksa [] + dürüst not warnings'te döner.",
      inputSchema: WikiDiffInputSchema,
      outputSchema: envelopeOutputSchema(WikiDiffDataSchema),
      handler: (requestId, args) =>
        wikiDiff(context, requestId, args as z.infer<typeof WikiDiffInputSchema>),
    },
  ];
}

/** Context'i MCP McpServer'a bağlar; tam olarak 23 araç kaydeder. */
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
