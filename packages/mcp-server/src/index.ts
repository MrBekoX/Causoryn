/**
 * @causoryn/mcp-server — MCP protokol adaptasyonu paketi (Faz A dilimi,
 * sprint-1 görev 6; sprint-2 B6: causoryn_index_status +
 * causoryn_refresh_index, sprint-2 B5: causoryn_get_symbol_context,
 * sprint-3 C8: Faz C'nin 7 çekirdek aracı, sprint-4 W5: Living Wiki'nin
 * 7 aracı — TŞ §16A.8).
 *
 * Sorumluluk alanı (TŞ v2.1 §5 + §10): local stdio transport (ADR-003),
 * Zod input/output doğrulaması, authorization, SIZE limitleri
 * (results.maxNodes/maxSymbols/maxDepth/maxPaths, index.maxFiles,
 * workspace.maxFileBytes) ve ApplicationService yönlendirmesi. tools/list
 * tam olarak 23 gerçek araç yayımlar; boş handler yayınlanmaz (ADR-010,
 * wiki/mcp-tools.md).
 *
 * Kasıtlı kapsam dışı (dürüstlük beyanı): İSTEK HIZI (rate) limiti bu
 * dilimde YOKTUR — TŞ §19/§20'nin kaynak tüketimi sınırları bu dilimde
 * yalnızca boyut limitleriyle karşılanır. Rate limit sonraki dilimlere
 * aittir; karar kaydı wiki/decisions.md'e orkestratör tarafından
 * işlenmelidir (wiki yazımı bu pakete kapalıdır).
 *
 * SDK sürüm notu: TŞ §6 hedefi "resmî SDK v2 (@modelcontextprotocol/server)"
 * iken bu dilim KURULU @modelcontextprotocol/sdk 1.32.2 (v1.x hattı,
 * LATEST_PROTOCOL_VERSION 2025-11-25) ile yazılmıştır — npm install yasağı
 * nedeniyle sürüm yükseltmesi yapılmamıştır. Karar kaydı wiki/decisions.md
 * için orkestratöre bırakılmıştır.
 *
 * Kırmızı çizgiler (TŞ §10.1):
 * - stdout YALNIZCA MCP stdio protokol trafiği; tüm loglar stderr.
 * - Bu paket parser/analysis detayı içermez; workspace/indexing/graph
 *   uygulama servislerini tüketir (wiki/architecture.md bağımlılık sınırı 3).
 * - Envelope hata kodları sabittir (TŞ §10.1 + ÜÇ proje uzantısı:
 *   INVALID_ARGUMENT + EVIDENCE_NOT_FOUND (K-008) ve SYMBOL_NOT_FOUND
 *   (sprint-2 B5 get_symbol_context) — bkz. errors.ts başlığı. Sprint-3 C8'in
 *   guard/export/git-revision araçları YENİ uzantı kodu basmaz: POLICY_INVALID,
 *   INVALID_REVISION ve EXPORT_NOT_ALLOWED TŞ §10.1 sabit listesinin
 *   üyeleridir ve bu dilimde ilk kez kullanıldılar (takım denetimi bulgusu).
 *   K-008 karar kaydı (wiki/decisions.md) yalnızca ilk ikisini kapsar;
 *   SYMBOL_NOT_FOUND için K-008'i genişleten yeni ADR kaydının
 *   wiki/decisions.md'e işlenmesi orkestratöre aittir (wiki yazımı ajan
 *   dışı).
 */
export { SERVER_NAME, SERVER_VERSION, SCHEMA_VERSION, TOOL_NAMES } from "./version.js";
export type { ToolName } from "./version.js";
export { CAUSORYN_TOOL_ERROR_CODES, CausorynToolError } from "./errors.js";
export type { CausorynToolErrorCode } from "./errors.js";
export { parseCausorynServerConfig, causorynServerConfigSchema, CausorynConfigError } from "./config.js";
export type { CausorynServerConfig } from "./config.js";
export {
  EnvelopeSchema,
  CoverageSchema,
  ToolErrorSchema,
  buildEnvelope,
  envelopeOutputSchema,
  errorEnvelope,
} from "./envelope.js";
export type { Coverage, Envelope } from "./envelope.js";
export { encodeCursor, decodeCursor } from "./cursor.js";
export { createCausorynContext } from "./context.js";
export type { CausorynContext, ContextOverrides } from "./context.js";
export { createCausorynMcpServer } from "./server.js";
export {
  graphErrorToToolError,
  analyzeImpactTool,
  checkArchitecture,
  compareArchitecture,
  getAgentContext,
  generateOnboardingTool,
  exportDocumentationTool,
  architectureTimeline,
  AnalyzeImpactInputSchema,
  AnalyzeImpactDataSchema,
  CheckArchitectureInputSchema,
  CheckArchitectureDataSchema,
  GuardFindingSchema,
  CompareArchitectureInputSchema,
  CompareArchitectureDataSchema,
  GetAgentContextInputSchema,
  GetAgentContextDataSchema,
  GenerateOnboardingInputSchema,
  GenerateOnboardingDataSchema,
  ExportDocumentationInputSchema,
  ExportDocumentationDataSchema,
  ArchitectureTimelineInputSchema,
  ArchitectureTimelineDataSchema,
} from "./services-architecture.js";
export {
  wikiBuild,
  wikiGetTree,
  wikiGetPage,
  wikiSearch,
  wikiGetLinks,
  wikiGetVersions,
  wikiDiff,
  WIKI_TOOL_DEFAULT_LIMIT,
  WIKI_TOOL_MAX_LIMIT,
  WIKI_TOOL_ERROR_CODES_USED,
  WikiBuildInputSchema,
  WikiBuildDataSchema,
  WikiGetTreeInputSchema,
  WikiGetTreeDataSchema,
  WikiTreeNodeSchema,
  WikiGetPageInputSchema,
  WikiGetPageDataSchema,
  WikiSearchInputSchema,
  WikiSearchDataSchema,
  WikiGetLinksInputSchema,
  WikiGetLinksDataSchema,
  WikiGetVersionsInputSchema,
  WikiGetVersionsDataSchema,
  WikiVersionEntrySchema,
  WikiDiffInputSchema,
  WikiDiffDataSchema,
  WikiContractChangeSchema,
} from "./services-wiki.js";
export {
  getCapabilities,
  workspaceSummary,
  indexStatus,
  refreshIndex,
  mapSystem,
  findSymbols,
  getSymbolContext,
  traceExecution,
  getEvidence,
  GetCapabilitiesInputSchema,
  WorkspaceSummaryInputSchema,
  IndexStatusInputSchema,
  RefreshIndexInputSchema,
  MapSystemInputSchema,
  FindSymbolsInputSchema,
  GetSymbolContextInputSchema,
  TraceExecutionInputSchema,
  GetEvidenceInputSchema,
  CapabilitiesDataSchema,
  WorkspaceSummaryDataSchema,
  IndexStatusDataSchema,
  IndexJobRecordSchema,
  LatestSnapshotSchema,
  RefreshIndexDataSchema,
  MapDataSchema,
  FindSymbolsDataSchema,
  GetSymbolContextDataSchema,
  TraceExecutionDataSchema,
  TracePathSchema,
  TracePathEdgeSchema,
  SymbolContextNodeSchema,
  SymbolContextEdgeSchema,
  GetEvidenceDataSchema,
  EvidenceRecordSchema,
  EvidenceSpanSchema,
  AmbiguityDataSchema,
} from "./services.js";
