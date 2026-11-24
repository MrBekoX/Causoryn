/**
 * @causoryn/storage-sqlite — SQLite + FTS5 graph store (Faz A dilimi,
 * sprint-1 görev 5) ve Wiki projeksiyon deposu (Faz C2 dilimi, sprint-4
 * görev W2).
 *
 * GraphRepository sözleşmesinin kalıcı gerçeklemesi (TŞ v2.1 §9):
 * workspaces/files/snapshots/nodes/edges/evidence (+ edge_evidence)
 * tabloları, WAL, atomik snapshot yayımlama (building → ready/partial;
 * eski yayın stale=true ile sorgulanabilir kalır) ve symbol_fts temel
 * ekleme/arama. Tüm girdiler hazırlanmış ifadelerle parametrelenir.
 *
 * Wiki depolama (TŞ v2.1 §16A.7): wiki_snapshots/wiki_pages/
 * wiki_page_sections/wiki_links/wiki_page_versions/wiki_annotations/
 * wiki_aliases + wiki_fts; SqliteWikiStore atomik WikiSnapshot
 * yayımlaması ve overlay (anotasyon/alias) kalıcılığı sağlar.
 */
export { GraphRepositoryError } from "@causoryn/graph";
export {
  applySchema,
  readSqliteUserVersion,
  SCHEMA_VERSION,
  SchemaTooNewError,
} from "./schema.js";
export {
  currentLeaseHostname,
  DEFAULT_LEASE_STALE_CEILING_MS,
  defaultIsPidAlive,
  evaluateBuildLeaseLiveness,
  PROCESS_LEASE_INSTANCE_ID,
} from "./build-lease.js";
export type {
  BuildLeaseLiveness,
  BuildLeaseLivenessContext,
  BuildLeaseLivenessInput,
  BuildLeaseLivenessReason,
} from "./build-lease.js";
export {
  LEGACY_WORKSPACE_DB_PATTERN,
  listLegacyWorkspaceDatabases,
  migrateLegacyWorkspaceDatabase,
} from "./legacy-migration.js";
export type {
  LegacyDbCandidateReport,
  LegacyMigrationResult,
} from "./legacy-migration.js";
export {
  ORPHAN_BUILD_FAILURE_REASON,
  SqliteGraphRepository,
} from "./sqlite-repository.js";
export type {
  AcquireBuildLeaseInput,
  AcquireBuildLeaseResult,
  BuildLeaseHeartbeatConnection,
  BuildLeaseLivenessOptions,
  BuildLeaseRecord,
  BuildLeaseRenewOutcome,
  FileFactRecord,
  PruneSnapshotsOptions,
  PruneSnapshotsResult,
  RecoverOrphanBuildsOptions,
  RecoverOrphanBuildsResult,
  SnapshotMetaSummary,
} from "./sqlite-repository.js";
export { applyWikiSchema } from "./wiki-schema.js";
export {
  SqliteWikiStore,
  WikiStoreError,
} from "./wiki-store.js";
export type {
  WikiAlias,
  WikiAliasInput,
  WikiAnnotation,
  WikiAnnotationInput,
  WikiCoverageStatus,
  WikiEvidenceRef,
  WikiFreshness,
  WikiFtsDocInput,
  WikiLink,
  WikiLinkInput,
  WikiLinkKind,
  WikiLinkResolution,
  WikiPage,
  WikiPageInput,
  WikiPageKind,
  WikiPageSection,
  WikiPageSectionInput,
  WikiPageVersion,
  WikiPageVersionInput,
  WikiPublishStatus,
  WikiSearchHit,
  WikiSectionStatus,
  WikiSnapshot,
  WikiSnapshotMetaInput,
  WikiSnapshotRead,
  WikiSnapshotStatus,
} from "./wiki-store.js";
