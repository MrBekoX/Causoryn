/**
 * @causoryn/wiki — WikiProjectionEngine paket girişi.
 *
 * GraphSnapshot → WikiSnapshot deterministik projeksiyonu (TŞ v2.1 §16A;
 * ADR-011/012; docs/wiki-spec.md §3.0–§3.2; K-013). Saf çekirdek: MCP türü
 * import etmez; WikiLink üretimi W3'te (TŞ §16A.2), SQLite şeması W2'de
 * (TŞ §16A.7 wiki_* tabloları) eklenir.
 */

export { WikiProjectionError, WikiSearchError } from "./errors.js";

export {
  WIKI_ROOT_CATEGORIES,
  WIKI_ROOT_CATEGORY_BY_KEY,
  WIKI_TEMPLATE_VERSION,
} from "./taxonomy.js";
export type { WikiRootCategory } from "./taxonomy.js";

export {
  CoverageStatusSchema,
  EvidenceRefSchema,
  FreshnessSchema,
  WikiCoverageSchema,
  WikiPageKindSchema,
  WikiPageSchema,
  WikiPageSectionSchema,
  WikiPageSectionStatusSchema,
  WikiProjectionSchema,
  WikiResolutionSchema,
  WikiSnapshotSchema,
  WikiSnapshotStatusSchema,
} from "./schema.js";
export type {
  CoverageStatus,
  EvidenceRef,
  Freshness,
  WikiCoverage,
  WikiPage,
  WikiPageKind,
  WikiPageSection,
  WikiPageSectionStatus,
  WikiProjection,
  WikiSnapshot,
  WikiSnapshotStatus,
} from "./schema.js";

export {
  computeCoverageDelta,
  computeWikiCoverageDeltas,
  CoverageDeltaSchema,
} from "./coverage-delta.js";
export type { CoverageDelta, WikiCoverageDeltaEntry } from "./coverage-delta.js";

export {
  BrokenLinkDiagnosticSchema,
  WikiLinkDraftSchema,
  WikiLinkKindSchema,
  WikiLinkSchema,
  buildWikiLinkIndex,
  resolveWikiLinks,
} from "./links.js";
export type {
  BrokenLinkDiagnostic,
  WikiAliasEntry,
  WikiLink,
  WikiLinkDraft,
  WikiLinkIndex,
  WikiLinkKind,
  WikiLinkResolution,
  WikiLinkResolutionInput,
  WikiPageTarget,
} from "./links.js";

export {
  wikiPageContentHash,
  wikiPageContentJsonValue,
  wikiProjectionCanonicalJson,
  wikiProjectionContentHash,
} from "./content-hash.js";

export { projectWiki, wikiSlugify } from "./projection.js";
export type { WikiProjectionInput } from "./projection.js";

// W6 incremental invalidation (TŞ §16A.5; wiki/sprint-4.md W6) — motor +
// deterministik graph diff + Zod rapor şemaları (denetim bulgusu 2/7:
// paket girişinden tüketilebilirlik).
export {
  WikiGraphDiffSchema,
  WikiIncrementalBuildReportSchema,
  diffWikiGraphs,
  projectWikiIncremental,
} from "./incremental.js";
export type {
  WikiGraphDiff,
  WikiIncrementalBuild,
  WikiIncrementalBuildReport,
  WikiIncrementalInput,
} from "./incremental.js";
export { deriveWikiSnapshotId } from "./projection.js";

export {
  WIKI_EXPORT_HTML_CSP,
  WIKI_EXPORT_INDEX_HTML_NAME,
  WIKI_EXPORT_INDEX_MD_NAME,
  WIKI_EXPORT_MARKDOWN_DIR_NAME,
  buildWikiExportFileSet,
  exportWikiOffline,
  serializeWikiHtml,
  serializeWikiIndexMarkdown,
  serializeWikiPageMarkdown,
} from "./export.js";
export type {
  WikiExportFile,
  WikiExportWrittenFile,
  WikiOfflineExportInput,
  WikiOfflineExportResult,
} from "./export.js";

export {
  normalizeWikiSearchQuery,
  escapeFtsPhrase,
  buildWikiMatchExpression,
} from "./search-query.js";

export {
  encodeWikiSearchCursor,
  decodeWikiSearchCursor,
} from "./search-cursor.js";

export {
  rankWikiSearchCandidates,
} from "./search-ranking.js";
export type {
  WikiSearchCandidate,
  WikiSearchRanking,
  WikiSearchRankingOptions,
} from "./search-ranking.js";

export {
  WIKI_SEARCH_MATCHED_FIELDS,
  WikiSearchHitSchema,
  WikiSearchMatchedFieldSchema,
  WikiSearchResultSchema,
  WikiSearchSkippedRankLegSchema,
} from "./search-schema.js";
export type {
  WikiSearchHit,
  WikiSearchMatchedField,
  WikiSearchResult,
  WikiSearchSkippedRankLeg,
} from "./search-schema.js";

export {
  DEFAULT_WIKI_SEARCH_LIMIT,
  MAX_WIKI_SEARCH_LIMIT,
  WikiSearchStore,
} from "./search-store.js";
export type {
  WikiSearchDatabase,
  WikiSearchInput,
  WikiSearchStatement,
} from "./search-store.js";
