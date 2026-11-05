/**
 * @causoryn/wiki — WikiProjectionEngine paket girişi.
 *
 * GraphSnapshot → WikiSnapshot deterministik projeksiyonu (TŞ v2.1 §16A;
 * ADR-011/012; docs/wiki-spec.md §3.0–§3.2; K-013). Saf çekirdek: MCP türü
 * import etmez; WikiLink üretimi W3'te (TŞ §16A.2), SQLite şeması W2'de
 * (TŞ §16A.7 wiki_* tabloları) eklenir.
 */

export { WikiProjectionError } from "./errors.js";

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
  wikiPageContentHash,
  wikiPageContentJsonValue,
  wikiProjectionCanonicalJson,
  wikiProjectionContentHash,
} from "./content-hash.js";

export { projectWiki, wikiSlugify } from "./projection.js";
export type { WikiProjectionInput } from "./projection.js";
