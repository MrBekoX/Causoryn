import Database from "better-sqlite3";

import { canonicalJson, type JsonValue } from "@causoryn/domain";
import { requireNonEmptyField, requireTimestamp } from "@causoryn/graph";

import { applySchema, SCHEMA_VERSION } from "./schema.js";

/**
 * SqliteWikiStore — Wiki projeksiyonunun kalıcı gerçeklemesi (TŞ v2.1
 * §16A.5/§16A.7; wiki/sprint-4.md W2).
 *
 * - Atomik yayımlama (TŞ §16A.5 madde 5): wiki_pages/sections/links/
 *   versions/FTS satırları `building` durumundaki wiki_snapshots satırına
 *   bağlanarak yazılır; publish TEK SQLite transaction'dır (id + status +
 *   built_at UPDATE'i, GraphSnapshot disipliniyle birebir). Building
 *   satırları hiçbir okuma yolunda çözülemez (id NULL + status filtresi);
 *   yarım WikiSnapshot asla görünmez. failed durumu failWikiBuild ile
 *   yazılır (K-013 #1: ayrı 'error' durum adı yok).
 * - Round-trip sözleşmesi: yazılan WikiSnapshot satırları girdi
 *   biçiminde okunur; canonical JSON (TŞ §8 invariant vi) birebir
 *   eşitlik testlerle kanıtlanır (aynı girdi → aynı WikiSnapshot JSON).
 * - Overlay (TŞ §16A.6): wiki_annotations/wiki_aliases snapshot'a
 *   FK'LANMAZ; reindex (yeni wiki snapshot publish'i) üzerine yazamaz.
 *   W7 ince bağlantı: anotasyon CAS güncellemesi (annotationVersion)
 *   guarded UPDATE ile atomiktir; kimlik alanları (stablePageId/authorKind)
 *   API'de yoktur ve değiştirilemez; silme yalnızca explicit id iledir.
 * - Güvenlik: TÜM girdiler hazırlanmış ifade parametreleriyle bağlanır;
 *   SQL metni yalnızca statik sabitlerden oluşur. Kullanıcı workspace'i
 *   salt okunurdur (ADR-008) — bu depo yalnızca izinli data-root'taki
 *   SQLite dosyasına yazar.
 */

/** Wiki depolama sözleşme hatası (GraphRepositoryError deseninde). */
export class WikiStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WikiStoreError";
  }
}

// ---------------------------------------------------------------------------
// Tipler — alan adları TŞ §16A.7 (s.17) varlık listesine sadıktır; enum
// değer kümeleri K-013 kararlarıyla (docs/wiki-spec.md §8) hizalıdır.
// ---------------------------------------------------------------------------

/** TŞ §16A.7 WikiSnapshot.status — K-013 #1 (ayrı 'error' adı yok). */
export type WikiSnapshotStatus = "building" | "ready" | "partial" | "failed";

/** Publish edilebilir durumlar (TŞ §9 publish kuralı: ready/partial). */
export type WikiPublishStatus = "ready" | "partial";

/** TŞ §16A.1 önerilen sayfa türleri (16 değer). */
export type WikiPageKind =
  | "overview"
  | "architecture"
  | "project"
  | "module"
  | "component"
  | "symbol"
  | "api"
  | "business_flow"
  | "event"
  | "data"
  | "contract"
  | "policy"
  | "test"
  | "timeline"
  | "onboarding"
  | "coverage";

/** K-013 #3. */
export type WikiFreshness = "fresh" | "stale";

/** K-013 #3 (16A.1: no_data kategorisi asla doldurulmaz). */
export type WikiCoverageStatus =
  | "complete"
  | "partial"
  | "unsupported"
  | "no_data";

/** K-013 #3. */
export type WikiSectionStatus = "ok" | "partial" | "no_data";

/** TŞ §16A.2 WikiLink türleri (11 değer). */
export type WikiLinkKind =
  | "PARENT_OF"
  | "DOCUMENTS"
  | "DEPENDS_ON"
  | "CALLS"
  | "IMPLEMENTS"
  | "PRODUCES"
  | "CONSUMES"
  | "TESTED_BY"
  | "FLOWS_TO"
  | "RELATED_CONTRACT"
  | "CHANGED_IN";

/** TŞ §8 Resolution. */
export type WikiLinkResolution = "verified" | "heuristic" | "unresolved";

/** TŞ §8 Evidence/SourceSpan referansı (docs/wiki-spec.md §3.0 gövdesi). */
export interface WikiEvidenceRef {
  evidenceId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
}

/** TŞ §16A.7 WikiSnapshot — build girdisi (id publish'te atanır). */
export interface WikiSnapshotMetaInput {
  workspaceId: string;
  graphSnapshotId: string;
  revisionRef: string;
  templateVersion: string;
  /** ISO 8601 build başlangıcı. */
  createdAt: string;
}

/** TŞ §16A.7 WikiSnapshot — publish edilmiş okuma modeli. */
export interface WikiSnapshot {
  id: string;
  workspaceId: string;
  graphSnapshotId: string;
  revisionRef: string;
  status: WikiPublishStatus;
  builtAt: string;
  templateVersion: string;
}

/** TŞ §16A.7 WikiPage — snapshot içi yazım (wikiSnapshotId sid'den). */
export interface WikiPageInput {
  id: string;
  kind: WikiPageKind;
  /** Kök sayfalarda null; kompozit FK aynı snapshot'taki parent'ı zorlar. */
  parentId: string | null;
  title: string;
  slug: string;
  route: string;
  contentHash: string;
  freshness: WikiFreshness;
  coverage: { status: WikiCoverageStatus; detail?: string };
}

export type WikiPage = WikiPageInput & { wikiSnapshotId: string };

/** TŞ §16A.7 WikiPageSection. */
export interface WikiPageSectionInput {
  id: string;
  pageId: string;
  sectionKey: string;
  generatedMarkdown: string;
  evidenceRefs: readonly WikiEvidenceRef[];
  status: WikiSectionStatus;
}

export interface WikiPageSection {
  id: string;
  pageId: string;
  sectionKey: string;
  generatedMarkdown: string;
  evidenceRefs: readonly WikiEvidenceRef[];
  status: WikiSectionStatus;
}

/** TŞ §16A.7 WikiLink — K-013 #4: bozuk linkte toPageId null korunur. */
export interface WikiLinkInput {
  id: string;
  fromPageId: string;
  toPageId: string | null;
  kind: WikiLinkKind;
  resolution: WikiLinkResolution;
  /** TŞ §16A.7: her verified link ≥1 Evidence gerektirir. */
  evidenceRefs: readonly WikiEvidenceRef[];
}

export interface WikiLink {
  id: string;
  wikiSnapshotId: string;
  fromPageId: string;
  toPageId: string | null;
  kind: WikiLinkKind;
  resolution: WikiLinkResolution;
  evidenceRefs: readonly WikiEvidenceRef[];
}

/** TŞ §16A.7 WikiPageVersion (+ wiki-spec §3.4 templateVersion/coverage). */
export interface WikiPageVersionInput {
  pageId: string;
  revisionRef: string;
  contentHash: string;
  linkSetHash: string;
  templateVersion: string;
  coverage: { status: WikiCoverageStatus };
}

export interface WikiPageVersion {
  pageId: string;
  wikiSnapshotId: string;
  revisionRef: string;
  contentHash: string;
  linkSetHash: string;
  templateVersion: string;
  coverage: { status: WikiCoverageStatus };
}

/** TŞ §16A.6/§16A.7 WikiAnnotation — overlay; origin/verified
 * opsiyonel taşınır (değer kümeleri K-013'te kilitlenmedi). */
export interface WikiAnnotationInput {
  id: string;
  stablePageId: string;
  sectionKey: string;
  authorKind: string;
  origin?: string;
  verified?: boolean;
  body: string;
  annotationVersion: number;
  updatedAt: string;
}

export interface WikiAnnotation {
  id: string;
  stablePageId: string;
  sectionKey: string;
  authorKind: string;
  origin?: string;
  verified?: boolean;
  body: string;
  annotationVersion: number;
  updatedAt: string;
}

/** wiki_aliases — pageId + alias + source deterministik (sprint-4 W2);
 * candidateNewPageId/matchConfidence TŞ §16A.7 WikiPageAlias alanları.
 * (W7 notu: WikiAnnotation tipleri DEĞİŞMEDİ; yalnızca getAnnotation/
 * updateAnnotation/deleteAnnotation yöntemleri eklendi — mevcut
 * wiki_annotations tablosunun KULLANIMI, şema değişikliği yoktur.) */
export interface WikiAliasInput {
  pageId: string;
  alias: string;
  source: string;
  candidateNewPageId?: string | null;
  matchConfidence?: number | null;
}

export interface WikiAlias {
  pageId: string;
  alias: string;
  source: string;
  candidateNewPageId?: string | null;
  matchConfidence?: number | null;
}

/** wiki_fts dokümanı — TŞ §16A.7 WikiSearchIndex alanları (W4 tüketir). */
export interface WikiFtsDocInput {
  pageId: string;
  title: string;
  qualifiedSymbol?: string | null;
  apiRoute?: string | null;
  module?: string | null;
  tags?: string | null;
  body?: string | null;
}

/** Publish edilmiş WikiSnapshot'ın tam okuma modeli (round-trip birimi). */
export interface WikiSnapshotRead {
  snapshot: WikiSnapshot;
  pages: readonly WikiPage[];
  sections: readonly WikiPageSection[];
  links: readonly WikiLink[];
  versions: readonly WikiPageVersion[];
}

/** wiki_search temel hit modeli — sıralama/pagination W4'te genişler. */
export interface WikiSearchHit {
  pageId: string;
  wikiSnapshotId: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Sabit kümeler ve doğrulama yardımcıları
// ---------------------------------------------------------------------------

const PAGE_KINDS: ReadonlySet<string> = new Set<string>([
  "overview",
  "architecture",
  "project",
  "module",
  "component",
  "symbol",
  "api",
  "business_flow",
  "event",
  "data",
  "contract",
  "policy",
  "test",
  "timeline",
  "onboarding",
  "coverage",
]);

const COVERAGE_STATUSES: ReadonlySet<string> = new Set<string>([
  "complete",
  "partial",
  "unsupported",
  "no_data",
]);

const SECTION_STATUSES: ReadonlySet<string> = new Set<string>([
  "ok",
  "partial",
  "no_data",
]);

const LINK_KINDS: ReadonlySet<string> = new Set<string>([
  "PARENT_OF",
  "DOCUMENTS",
  "DEPENDS_ON",
  "CALLS",
  "IMPLEMENTS",
  "PRODUCES",
  "CONSUMES",
  "TESTED_BY",
  "FLOWS_TO",
  "RELATED_CONTRACT",
  "CHANGED_IN",
]);

const LINK_RESOLUTIONS: ReadonlySet<string> = new Set<string>([
  "verified",
  "heuristic",
  "unresolved",
]);

const FRESHNESS_STATUSES: ReadonlySet<string> = new Set<string>([
  "fresh",
  "stale",
]);

const PUBLISH_STATUSES: ReadonlySet<string> = new Set<string>([
  "ready",
  "partial",
]);

const DEFAULT_SEARCH_LIMIT = 20;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: ReadonlySet<string>,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new WikiStoreError(
      "wiki/invalid-field",
      `${field} has an invalid value: ${String(value)} (allowed: ${[...allowed].join(",")})`,
    );
  }
  return value as T;
}

function requireOptionalText(
  field: string,
  value: string | undefined | null,
): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyField(field, value);
}

function requireNonNegativeInt(field: string, value: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new WikiStoreError(
      "wiki/invalid-field",
      `${field} must be a non-negative integer: ${String(value)}`,
    );
  }
  return value;
}

function requireEvidenceRefs(
  field: string,
  refs: readonly WikiEvidenceRef[] | undefined,
): readonly WikiEvidenceRef[] {
  if (refs === undefined) {
    throw new WikiStoreError(
      "wiki/invalid-field",
      `${field} is required (an empty array is valid)`,
    );
  }
  for (const ref of refs) {
    requireNonEmptyField(`${field}.evidenceId`, ref.evidenceId);
    requireNonEmptyField(`${field}.relativePath`, ref.relativePath);
    requireNonEmptyField(`${field}.sourceHash`, ref.sourceHash);
    requireNonNegativeInt(`${field}.startLine`, ref.startLine);
    requireNonNegativeInt(`${field}.endLine`, ref.endLine);
  }
  return refs;
}

function requireCoverage(
  field: string,
  coverage: { status: WikiCoverageStatus; detail?: string } | undefined,
): { status: WikiCoverageStatus; detail?: string } {
  if (coverage === undefined || coverage === null) {
    throw new WikiStoreError(
      "wiki/invalid-field",
      `${field} zorunludur`,
    );
  }
  requireEnum(`${field}.status`, coverage.status, COVERAGE_STATUSES);
  if (coverage.detail !== undefined) {
    requireNonEmptyField(`${field}.detail`, coverage.detail);
  }
  return coverage;
}

function parseJsonField(field: string, text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WikiStoreError(
      "wiki/corrupt-row",
      `Could not parse JSON column (${field}): ${errorText(error)}`,
    );
  }
  return parsed as JsonValue;
}

function readEvidenceRefsJson(
  field: string,
  text: string,
): readonly WikiEvidenceRef[] {
  const parsed = parseJsonField(field, text);
  if (!Array.isArray(parsed)) {
    throw new WikiStoreError(
      "wiki/corrupt-row",
      `${field} is not an array`,
    );
  }
  return (parsed as unknown[]).map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const evidenceId = record["evidenceId"];
    const relativePath = record["relativePath"];
    const startLine = record["startLine"];
    const endLine = record["endLine"];
    const sourceHash = record["sourceHash"];
    if (
      typeof evidenceId !== "string" ||
      typeof relativePath !== "string" ||
      typeof sourceHash !== "string" ||
      typeof startLine !== "number" ||
      typeof endLine !== "number"
    ) {
      throw new WikiStoreError(
        "wiki/corrupt-row",
        `${field}[${index}] EvidenceRef fields are missing or corrupt`,
      );
    }
    return {
      evidenceId,
      relativePath,
      startLine,
      endLine,
      sourceHash,
    };
  });
}

// ---------------------------------------------------------------------------
// Satır tipleri
// ---------------------------------------------------------------------------

interface WikiSnapshotRow {
  sid: number;
  id: string | null;
  workspace_id: string;
  graph_snapshot_id: string;
  revision_ref: string;
  status: WikiSnapshotStatus;
  created_at: string;
  built_at: string | null;
  template_version: string;
  failure_reason: string | null;
}

interface WikiPageRow {
  page_id: string;
  kind: string;
  parent_id: string | null;
  title: string;
  slug: string;
  route: string;
  content_hash: string;
  freshness: string;
  coverage_status: string;
  coverage_detail: string | null;
}

interface WikiSectionRow {
  section_id: string;
  page_id: string;
  section_key: string;
  generated_markdown: string;
  evidence_refs_json: string;
  status: string;
}

interface WikiLinkRow {
  link_id: string;
  from_page_id: string;
  to_page_id: string | null;
  kind: string;
  resolution: string;
  evidence_refs_json: string;
}

interface WikiVersionRow {
  page_id: string;
  revision_ref: string;
  content_hash: string;
  link_set_hash: string;
  template_version: string;
  coverage_status: string;
}

interface WikiAnnotationRow {
  id: string;
  stable_page_id: string;
  section_key: string;
  author_kind: string;
  origin: string | null;
  verified: number | null;
  body: string;
  annotation_version: number;
  updated_at: string;
}

/** wiki_annotations satırı → okuma modeli (TŞ §16A.7 alan adları).
 * W7: list/get/update yolları bu TEK eşlemeyi paylaşır — satır şekli
 * üç okuma yolunda da bit-bit aynıdır. */
function annotationFromRow(row: WikiAnnotationRow): WikiAnnotation {
  return {
    id: row.id,
    stablePageId: row.stable_page_id,
    sectionKey: row.section_key,
    authorKind: row.author_kind,
    ...(row.origin === null ? {} : { origin: row.origin }),
    ...(row.verified === null ? {} : { verified: row.verified !== 0 }),
    body: row.body,
    annotationVersion: row.annotation_version,
    updatedAt: row.updated_at,
  };
}

interface WikiAliasRow {
  page_id: string;
  alias: string;
  source: string;
  candidate_new_page_id: string | null;
  match_confidence: number | null;
}

interface WorkspaceHitRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Depo
// ---------------------------------------------------------------------------

export class SqliteWikiStore {
  private readonly db: Database.Database;
  private readonly owned: boolean;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(source: string | Database.Database) {
    if (typeof source === "string") {
      requireNonEmptyField("dbPath", source);
      this.db = new Database(source);
      this.owned = true;
    } else {
      this.db = source;
      this.owned = false;
    }
    try {
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new WikiStoreError(
          "wiki/schema-corrupt",
          `Could not read SQLite user_version: ${String(version)}`,
        );
      }
      if (version > SCHEMA_VERSION) {
        // Forward guard BEFORE any pragma that could write the file.
        throw new WikiStoreError(
          "wiki/schema-too-new",
          `Database schema v${String(version)} is newer than this Causoryn build supports (v${String(SCHEMA_VERSION)}); refusing to open it`,
        );
      }
      // No explicit page_size: 4096 is SQLite's default and not a security
      // control (see schema.ts header for the corrected CVE notes).
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
      applySchema(this.db);
    } catch (error) {
      if (this.owned) this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.owned) this.db.close();
  }

  /**
   * Yeni wiki build'i başlatır; building satırı okuma yollarında görünmez.
   * Dönen sayısal tanıtıcı (sid) child yazım ve publish çağrılarında
   * kullanılır. Deterministik wiki snapshot kimliği publish anında atanır.
   */
  beginWikiBuild(input: WikiSnapshotMetaInput): number {
    this.requireWorkspace(input.workspaceId);
    requireNonEmptyField("build.graphSnapshotId", input.graphSnapshotId);
    requireNonEmptyField("build.revisionRef", input.revisionRef);
    requireNonEmptyField("build.templateVersion", input.templateVersion);
    requireTimestamp("build.createdAt", input.createdAt);
    // idx_wiki_snapshots_active_build sözleşmesi: aynı graph snapshot için
    // ikinci aktif build reddedilir. Tek bağlantılı senkron yazımda kontrol
    // yeterlidir; SELECT-then-INSERT arasında kalabilecek yarışta kısmi
    // UNIQUE index devreye girer ve ihlal aşağıda sözleşme hatasına
    // (wiki/build-already-active) çevrilir — generic driver-error değil.
    const active = this.stmt(
      `SELECT 1 AS hit FROM wiki_snapshots
       WHERE workspace_id = ? AND graph_snapshot_id = ? AND status = 'building'
       LIMIT 1`,
    ).get(input.workspaceId, input.graphSnapshotId);
    if (active !== undefined) {
      throw new WikiStoreError(
        "wiki/build-already-active",
        `An active wiki build already exists for the same graph snapshot: ${input.workspaceId}/${input.graphSnapshotId}`,
      );
    }
    let result: Database.RunResult;
    try {
      result = this.runWrite(
        `INSERT INTO wiki_snapshots
           (workspace_id, graph_snapshot_id, revision_ref, status,
            created_at, template_version)
         VALUES (?, ?, ?, 'building', ?, ?)`,
        input.workspaceId,
        input.graphSnapshotId,
        input.revisionRef,
        input.createdAt,
        input.templateVersion,
      );
    } catch (error) {
      if (
        error instanceof WikiStoreError &&
        error.message.includes("idx_wiki_snapshots_active_build")
      ) {
        throw new WikiStoreError(
          "wiki/build-already-active",
          `An active wiki build already exists for the same graph snapshot (race): ${input.workspaceId}/${input.graphSnapshotId}`,
        );
      }
      throw error;
    }
    return Number(result.lastInsertRowid);
  }

  addWikiPage(wikiSid: number, page: WikiPageInput): void {
    this.requireBuildingWikiRow(wikiSid);
    requireNonEmptyField("page.id", page.id);
    requireEnum("page.kind", page.kind, PAGE_KINDS);
    if (page.parentId !== null) {
      requireNonEmptyField("page.parentId", page.parentId);
    }
    requireNonEmptyField("page.title", page.title);
    requireNonEmptyField("page.slug", page.slug);
    requireNonEmptyField("page.route", page.route);
    requireNonEmptyField("page.contentHash", page.contentHash);
    requireEnum("page.freshness", page.freshness, FRESHNESS_STATUSES);
    requireCoverage("page.coverage", page.coverage);
    const exists = this.stmt(
      "SELECT 1 AS hit FROM wiki_pages WHERE wiki_snapshot_sid = ? AND page_id = ? LIMIT 1",
    ).get(wikiSid, page.id);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-page",
        `Page id already exists in this wiki build: ${page.id}`,
      );
    }
    const detail = page.coverage.detail;
    this.runWrite(
      `INSERT INTO wiki_pages
         (wiki_snapshot_sid, page_id, kind, parent_id, title, slug, route,
          content_hash, freshness, coverage_status, coverage_detail, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_pages WHERE wiki_snapshot_sid = ?))`,
      wikiSid,
      page.id,
      page.kind,
      page.parentId,
      page.title,
      page.slug,
      page.route,
      page.contentHash,
      page.freshness,
      page.coverage.status,
      detail === undefined ? null : detail,
      wikiSid,
    );
  }

  addWikiPageSection(wikiSid: number, section: WikiPageSectionInput): void {
    this.requireBuildingWikiRow(wikiSid);
    requireNonEmptyField("section.id", section.id);
    requireNonEmptyField("section.pageId", section.pageId);
    requireNonEmptyField("section.sectionKey", section.sectionKey);
    if (typeof section.generatedMarkdown !== "string") {
      throw new WikiStoreError(
        "wiki/invalid-field",
        "section.generatedMarkdown must be a string",
      );
    }
    requireEnum("section.status", section.status, SECTION_STATUSES);
    const refs = requireEvidenceRefs("section.evidenceRefs", section.evidenceRefs);
    const exists = this.stmt(
      "SELECT 1 AS hit FROM wiki_page_sections WHERE wiki_snapshot_sid = ? AND section_id = ? LIMIT 1",
    ).get(wikiSid, section.id);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-section",
        `Section id already exists in this wiki build: ${section.id}`,
      );
    }
    this.runWrite(
      `INSERT INTO wiki_page_sections
         (wiki_snapshot_sid, section_id, page_id, section_key,
          generated_markdown, evidence_refs_json, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_page_sections WHERE wiki_snapshot_sid = ?))`,
      wikiSid,
      section.id,
      section.pageId,
      section.sectionKey,
      section.generatedMarkdown,
      canonicalJson(refs as unknown as JsonValue),
      section.status,
      wikiSid,
    );
  }

  addWikiLink(wikiSid: number, link: WikiLinkInput): void {
    this.requireBuildingWikiRow(wikiSid);
    requireNonEmptyField("link.id", link.id);
    requireNonEmptyField("link.fromPageId", link.fromPageId);
    // K-013 #4: bozuk link toPageId=null ile korunur.
    requireOptionalText("link.toPageId", link.toPageId);
    requireEnum("link.kind", link.kind, LINK_KINDS);
    requireEnum("link.resolution", link.resolution, LINK_RESOLUTIONS);
    const refs = requireEvidenceRefs("link.evidenceRefs", link.evidenceRefs);
    if (link.resolution === "verified" && refs.length === 0) {
      throw new WikiStoreError(
        "wiki/verified-link-evidence-required",
        `A verified wiki link requires at least one evidence reference: ${link.id}`,
      );
    }
    const exists = this.stmt(
      "SELECT 1 AS hit FROM wiki_links WHERE wiki_snapshot_sid = ? AND link_id = ? LIMIT 1",
    ).get(wikiSid, link.id);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-link",
        `Link id already exists in this wiki build: ${link.id}`,
      );
    }
    this.runWrite(
      `INSERT INTO wiki_links
         (wiki_snapshot_sid, link_id, from_page_id, to_page_id, kind,
          resolution, evidence_refs_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_links WHERE wiki_snapshot_sid = ?))`,
      wikiSid,
      link.id,
      link.fromPageId,
      link.toPageId,
      link.kind,
      link.resolution,
      canonicalJson(refs as unknown as JsonValue),
      wikiSid,
    );
  }

  addWikiPageVersion(wikiSid: number, version: WikiPageVersionInput): void {
    this.requireBuildingWikiRow(wikiSid);
    requireNonEmptyField("version.pageId", version.pageId);
    requireNonEmptyField("version.revisionRef", version.revisionRef);
    requireNonEmptyField("version.contentHash", version.contentHash);
    requireNonEmptyField("version.linkSetHash", version.linkSetHash);
    requireNonEmptyField("version.templateVersion", version.templateVersion);
    requireEnum(
      "version.coverage.status",
      version.coverage?.status,
      COVERAGE_STATUSES,
    );
    const exists = this.stmt(
      "SELECT 1 AS hit FROM wiki_page_versions WHERE wiki_snapshot_sid = ? AND page_id = ? LIMIT 1",
    ).get(wikiSid, version.pageId);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-version",
        `A version for this page already exists in this wiki build: ${version.pageId}`,
      );
    }
    this.runWrite(
      `INSERT INTO wiki_page_versions
         (wiki_snapshot_sid, page_id, revision_ref, content_hash,
          link_set_hash, template_version, coverage_status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_page_versions WHERE wiki_snapshot_sid = ?))`,
      wikiSid,
      version.pageId,
      version.revisionRef,
      version.contentHash,
      version.linkSetHash,
      version.templateVersion,
      version.coverage.status,
      wikiSid,
    );
  }

  /**
   * FTS5 dokümanlarını yalnızca AKTİF (building) wiki build'e yazar
   * (wiki_fts FK'sızdır). Publish edilmiş bir snapshot'a sonradan yazım
   * REDDEDİLİR: arama sonuçları publish sonrası sessizce değiştirilemez
   * (TŞ §16A.5: publish atomik kesinlıktedir). Tüm liste ilk INSERT'ten
   * önce tamamen doğrulanır — listede bozuk doc varsa hiçbir satır
   * yazılmaz.
   */
  indexWikiFts(wikiSid: number, docs: readonly WikiFtsDocInput[]): void {
    this.requireBuildingWikiRow(wikiSid);
    for (const doc of docs) {
      requireNonEmptyField("doc.pageId", doc.pageId);
      requireNonEmptyField("doc.title", doc.title);
    }
    for (const doc of docs) {
      requireOptionalText("doc.qualifiedSymbol", doc.qualifiedSymbol);
      requireOptionalText("doc.apiRoute", doc.apiRoute);
      requireOptionalText("doc.module", doc.module);
      requireOptionalText("doc.tags", doc.tags);
      requireOptionalText("doc.body", doc.body);
    }
    for (const doc of docs) {
      this.runWrite(
        `INSERT INTO wiki_fts
           (title, qualified_symbol, api_route, module, tags, body,
            page_id, wiki_snapshot_sid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        doc.title,
        doc.qualifiedSymbol ?? null,
        doc.apiRoute ?? null,
        doc.module ?? null,
        doc.tags ?? null,
        doc.body ?? null,
        doc.pageId,
        wikiSid,
      );
    }
  }

  /**
   * Atomik yayımlama (TŞ §16A.5 madde 5): tek transaction içinde building
   * satırına deterministik id + status + built_at yazılır. Herhangi bir
   * adım başarısız olursa işlem geri alınır; yarım WikiSnapshot görünmez.
   */
  publishWiki(
    wikiSid: number,
    wikiSnapshotId: string,
    status: WikiPublishStatus,
    builtAt: string,
  ): WikiSnapshotRead {
    requireNonEmptyField("wikiSnapshotId", wikiSnapshotId);
    requireEnum("status", status, PUBLISH_STATUSES);
    requireTimestamp("builtAt", builtAt);
    const publishTx = this.db.transaction((): WikiSnapshotRead => {
      this.requireBuildingWikiRow(wikiSid);
      const result = this.stmt(
        `UPDATE wiki_snapshots SET id = ?, status = ?, built_at = ?
         WHERE sid = ? AND status = 'building'`,
      ).run(wikiSnapshotId, status, builtAt, wikiSid);
      if (result.changes !== 1) {
        throw new WikiStoreError(
          "wiki/build-not-active",
          `No active wiki build: ${String(wikiSid)}`,
        );
      }
      const published = this.requireWikiRow(wikiSid);
      return this.readSnapshotRows(published);
    });
    try {
      return publishTx();
    } catch (error) {
      if (error instanceof WikiStoreError) throw error;
      throw new WikiStoreError(
        "wiki/publish-failed",
        `Wiki publish failed; the store was not changed: ${errorText(error)}`,
      );
    }
  }

  /** Build başarısız olarak kapatılır (K-013 #1: 'failed' durumu). */
  failWikiBuild(wikiSid: number, reason: string): void {
    requireNonEmptyField("reason", reason);
    const result = this.runWrite(
      `UPDATE wiki_snapshots SET status = 'failed', failure_reason = ?
       WHERE sid = ? AND status = 'building'`,
      reason,
      wikiSid,
    );
    if (result.changes === 0) {
      throw new WikiStoreError(
        "wiki/build-not-active",
        `No active wiki build: ${String(wikiSid)}`,
      );
    }
  }

  /** Publish edilmiş (ready/partial) WikiSnapshot'ı tam okur. */
  readWikiSnapshot(wikiSnapshotId: string): WikiSnapshotRead | undefined {
    requireNonEmptyField("wikiSnapshotId", wikiSnapshotId);
    const row = this.stmt(
      `SELECT sid, id, workspace_id, graph_snapshot_id, revision_ref, status,
              created_at, built_at, template_version, failure_reason
       FROM wiki_snapshots
       WHERE id = ? AND status IN ('ready','partial') LIMIT 1`,
    ).get(wikiSnapshotId) as WikiSnapshotRow | undefined;
    if (row === undefined) return undefined;
    return this.readSnapshotRows(row);
  }

  /** Workspace'in en güncel publish edilmiş WikiSnapshot'ı (sid sırası). */
  getLatestPublishedWiki(workspaceId: string): WikiSnapshotRead | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    const row = this.stmt(
      `SELECT sid, id, workspace_id, graph_snapshot_id, revision_ref, status,
              created_at, built_at, template_version, failure_reason
       FROM wiki_snapshots
       WHERE workspace_id = ? AND status IN ('ready','partial')
       ORDER BY sid DESC LIMIT 1`,
    ).get(workspaceId) as WikiSnapshotRow | undefined;
    if (row === undefined) return undefined;
    return this.readSnapshotRows(row);
  }

  /**
   * Temel FTS5 arama (W2 kanıt düzeyi): sorgu phrase sözdizimiyle
   * sarmalanır ve PARAMETRE olarak bağlanır; yalnızca publish edilmiş
   * wiki snapshot'ların satırları eşleşir.
   *
   * Kapsam notu (denetim bulgusu): `options.workspaceId` verilirse sonuç
   * yalnızca o workspace'in publish edilmiş snapshot'larıyla sınırlanır —
   * çok-workspace'li DB'de cross-workspace hit engellenir. Filtresiz
   * çağrı tüm workspace'lerin publish edilmiş satırlarını döndürür
   * (searchSymbols gevşek deseni). Tam scoping + pageKind/language/revision
   * filtreleri, cursor/limit (K-013 #5) ve matchedFields sıralaması
   * W4/W5'te zorunludur (TŞ §16A.3) — orada bu temel arama değiştirilir.
   */
  searchWiki(
    query: string,
    options?: { limit?: number; workspaceId?: string },
  ): readonly WikiSearchHit[] {
    const trimmed = requireNonEmptyField("query", query);
    const effectiveLimit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1) {
      throw new WikiStoreError(
        "wiki/invalid-limit",
        `limit must be a positive integer: ${String(effectiveLimit)}`,
      );
    }
    const phrase = `"${trimmed.replaceAll('"', '""')}"`;
    // İki STATİK sorgu metni (workspace filtresi opsiyonel); SQL metnine
    // hiçbir girdi katılmaz, değerler parametreyle bağlanır.
    const rows = (
      options?.workspaceId === undefined
        ? this.stmt(
            `SELECT wiki_fts.page_id AS page_id,
                    wiki_snapshots.id AS wiki_snapshot_id,
                    wiki_fts.title AS title
             FROM wiki_fts JOIN wiki_snapshots ON wiki_snapshots.sid = wiki_fts.wiki_snapshot_sid
             WHERE wiki_fts MATCH ? AND wiki_snapshots.status IN ('ready','partial')
             ORDER BY wiki_fts.title, wiki_fts.page_id
             LIMIT ?`,
          ).all(phrase, effectiveLimit)
        : this.stmt(
            `SELECT wiki_fts.page_id AS page_id,
                    wiki_snapshots.id AS wiki_snapshot_id,
                    wiki_fts.title AS title
             FROM wiki_fts JOIN wiki_snapshots ON wiki_snapshots.sid = wiki_fts.wiki_snapshot_sid
             WHERE wiki_fts MATCH ?
               AND wiki_snapshots.status IN ('ready','partial')
               AND wiki_snapshots.workspace_id = ?
             ORDER BY wiki_fts.title, wiki_fts.page_id
             LIMIT ?`,
          ).all(phrase, requireNonEmptyField("workspaceId", options.workspaceId), effectiveLimit)
    ) as Array<{
      page_id: string;
      wiki_snapshot_id: string | null;
      title: string;
    }>;
    return rows.map((row) => ({
      pageId: row.page_id,
      wikiSnapshotId: row.wiki_snapshot_id ?? "",
      title: row.title,
    }));
  }

  /**
   * Overlay anotasyon yazar (TŞ §16A.6). Snapshot'a bağlı DEĞİLDİR;
   * reindex asla üzerine yazmaz. Duplicate id reddedilir (PK).
   */
  writeAnnotation(workspaceId: string, annotation: WikiAnnotationInput): void {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("annotation.id", annotation.id);
    requireNonEmptyField("annotation.stablePageId", annotation.stablePageId);
    requireNonEmptyField("annotation.sectionKey", annotation.sectionKey);
    requireNonEmptyField("annotation.authorKind", annotation.authorKind);
    requireOptionalText("annotation.origin", annotation.origin ?? null);
    if (
      annotation.verified !== undefined &&
      typeof annotation.verified !== "boolean"
    ) {
      throw new WikiStoreError(
        "wiki/invalid-field",
        "annotation.verified must be a boolean",
      );
    }
    requireNonNegativeInt(
      "annotation.annotationVersion",
      annotation.annotationVersion,
    );
    requireTimestamp("annotation.updatedAt", annotation.updatedAt);
    if (typeof annotation.body !== "string") {
      throw new WikiStoreError(
        "wiki/invalid-field",
        "annotation.body must be a string",
      );
    }
    const exists = this.stmt(
      "SELECT 1 AS hit FROM wiki_annotations WHERE id = ? LIMIT 1",
    ).get(annotation.id);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-annotation",
        `Annotation id already exists: ${annotation.id}`,
      );
    }
    try {
      this.runWrite(
        `INSERT INTO wiki_annotations
           (id, workspace_id, stable_page_id, section_key, author_kind,
            origin, verified, body, annotation_version, updated_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_annotations))`,
        annotation.id,
        workspaceId,
        annotation.stablePageId,
        annotation.sectionKey,
        annotation.authorKind,
        annotation.origin === undefined ? null : annotation.origin,
        annotation.verified === undefined ? null : annotation.verified ? 1 : 0,
        annotation.body,
        annotation.annotationVersion,
        annotation.updatedAt,
      );
    } catch (error) {
      // Güvenlik analizi bulgusu 2: SELECT-then-INSERT arasında yarış
      // penceresi vardır — iki süreç aynı data-root'a aynı anotasyon
      // kimliğini yazarken SELECT her iki tarafta "yok" görebilir; PK
      // UNIQUE ihlali alan kaybeden taraf dürüst wiki/duplicate-annotation
      // kodu görmelidir (storage/driver-error'a sarılmak bütünlüğü
      // DEĞİŞTİRMEZ — PK yine de yazımı reddeder — ama istemciye
      // "beklenmeyen iç hata" sinyali verir). Mesaj formatı SQLite sabitidir
      // ("UNIQUE constraint failed: <tablo>.<sütun>").
      if (
        error instanceof WikiStoreError &&
        error.code === "storage/driver-error" &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new WikiStoreError(
          "wiki/duplicate-annotation",
          `Annotation id already exists (lost a concurrent write race): ${annotation.id}`,
        );
      }
      throw error;
    }
  }

  listAnnotations(workspaceId: string): readonly WikiAnnotation[] {
    this.requireWorkspace(workspaceId);
    const rows = this.stmt(
      `SELECT id, stable_page_id, section_key, author_kind, origin,
              verified, body, annotation_version, updated_at
       FROM wiki_annotations WHERE workspace_id = ? ORDER BY position`,
    ).all(workspaceId) as WikiAnnotationRow[];
    return rows.map(annotationFromRow);
  }

  /**
   * Tek anotasyonu workspace kapsamında okur (sprint-4 W7). Satır yoksa
   * undefined döner (okuma sözleşmesi); satır başka workspace'teyse de
   * undefined'dır — cross-workspace izolasyonunda satırın varlığı
   * sızdırılmaz (wiki-spec §3.5: workspace/user storage ayrımı).
   */
  getAnnotation(workspaceId: string, id: string): WikiAnnotation | undefined {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("annotation.id", id);
    const row = this.stmt(
      `SELECT id, stable_page_id, section_key, author_kind, origin,
              verified, body, annotation_version, updated_at
       FROM wiki_annotations WHERE workspace_id = ? AND id = ? LIMIT 1`,
    ).get(workspaceId, id) as WikiAnnotationRow | undefined;
    return row === undefined ? undefined : annotationFromRow(row);
  }

  /**
   * Optimistic concurrency CAS güncellemesi (TŞ §16A.6, sprint-4 W7).
   * Sürüm koşulu guarded UPDATE ile TEK ATOMİK ifadede uygulanır:
   * `WHERE ... AND annotation_version = ?` — changes=0 çakışmadır
   * (wiki/annotation-conflict; MCP sabit karşılığı WIKI_NOTE_CONFLICT,
   * TŞ §10.1 s.9 — yeni uzantı kodu açılmaz, K-008 örüntüsü).
   *
   * Kimlik alanları (stablePageId, authorKind) bu API'de YOKTUR ve
   * değiştirilemez: rename/removed sonrası not yeniden hedeflenmez;
   * orphan akışı overlay katmanında türetilmiş durumla çözülür.
   * Patch alanlarında `undefined` = alan değişmez; `origin`/`verified`
   * için `null` = alan temizlenir (SQL NULL). Boş patch sürümü yine de
   * ilerletir (her yazma yeni sürümdür); içerik alanları korunur.
   */
  updateAnnotation(
    workspaceId: string,
    input: {
      readonly id: string;
      readonly expectedAnnotationVersion: number;
      readonly body?: string;
      readonly sectionKey?: string;
      readonly origin?: string | null;
      readonly verified?: boolean | null;
    },
    updatedAt: string,
  ): WikiAnnotation {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("annotation.id", input.id);
    requireNonNegativeInt(
      "annotation.expectedAnnotationVersion",
      input.expectedAnnotationVersion,
    );
    requireTimestamp("annotation.updatedAt", updatedAt);
    if (input.body !== undefined && typeof input.body !== "string") {
      throw new WikiStoreError(
        "wiki/invalid-field",
        "annotation.body must be a string",
      );
    }
    if (input.sectionKey !== undefined) {
      requireNonEmptyField("annotation.sectionKey", input.sectionKey);
    }
    if (input.origin !== undefined) {
      requireOptionalText("annotation.origin", input.origin);
    }
    if (
      input.verified !== undefined &&
      input.verified !== null &&
      typeof input.verified !== "boolean"
    ) {
      throw new WikiStoreError(
        "wiki/invalid-field",
        "annotation.verified must be a boolean or null",
      );
    }
    const current = this.stmt(
      `SELECT id, stable_page_id, section_key, author_kind, origin,
              verified, body, annotation_version, updated_at
       FROM wiki_annotations WHERE workspace_id = ? AND id = ? LIMIT 1`,
    ).get(workspaceId, input.id) as WikiAnnotationRow | undefined;
    if (current === undefined) {
      throw new WikiStoreError(
        "wiki/annotation-not-found",
        `Annotation not found: ${input.id}`,
      );
    }
    const result = this.runWrite(
      `UPDATE wiki_annotations
       SET body = ?, section_key = ?, origin = ?, verified = ?,
           annotation_version = annotation_version + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND annotation_version = ?`,
      input.body ?? current.body,
      input.sectionKey ?? current.section_key,
      input.origin === undefined ? current.origin : input.origin,
      input.verified === undefined
        ? current.verified
        : input.verified === null
          ? null
          : input.verified
            ? 1
            : 0,
      updatedAt,
      workspaceId,
      input.id,
      input.expectedAnnotationVersion,
    );
    if (result.changes !== 1) {
      throw new WikiStoreError(
        "wiki/annotation-conflict",
        `Annotation version conflict (expected ${String(input.expectedAnnotationVersion)}, current ${String(current.annotation_version)}): ${input.id}`,
      );
    }
    const updated = this.stmt(
      `SELECT id, stable_page_id, section_key, author_kind, origin,
              verified, body, annotation_version, updated_at
       FROM wiki_annotations WHERE workspace_id = ? AND id = ? LIMIT 1`,
    ).get(workspaceId, input.id) as WikiAnnotationRow | undefined;
    if (updated === undefined) {
      throw new WikiStoreError(
        "wiki/annotation-not-found",
        `Could not read the updated annotation: ${input.id}`,
      );
    }
    return annotationFromRow(updated);
  }

  /**
   * Anotasyonu explicit id ile siler (sprint-4 W7). Toplu/örtük silme
   * API'si YOKTUR: reindex anotasyon satırlarına asla dokunmaz; silme
   * yalnızca bu yöntemle, açık kimlikle yapılır (TŞ §16A.6: notlar
   * silinmez; orphan akışında satır korunur). id yoksa (veya satır başka
   * workspace'teyse) wiki/annotation-not-found.
   */
  deleteAnnotation(workspaceId: string, id: string): void {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("annotation.id", id);
    const result = this.runWrite(
      "DELETE FROM wiki_annotations WHERE workspace_id = ? AND id = ?",
      workspaceId,
      id,
    );
    if (result.changes !== 1) {
      throw new WikiStoreError(
        "wiki/annotation-not-found",
        `Annotation not found: ${id}`,
      );
    }
  }

  /**
   * Deterministik alias yazar (PK: workspace + page + alias). Alan
   * eşlemesi (bkz. wiki-schema.ts): pageId ↔ TŞ §16A.7 oldPageId;
   * alias ↔ W2 emrinin 'alias' sütunu (eski slug/başlık); source ↔
   * reason (rename/relocation göstergesi); candidateNewPageId ↔
   * candidateNewPageId (NULL = çözülememiş candidate_redirect);
   * matchConfidence ↔ matchConfidence (0..1). Rename/relocation redirect
   * çözümlemesi TŞ §16A.1'dir.
   */
  writeAlias(workspaceId: string, alias: WikiAliasInput): void {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("alias.pageId", alias.pageId);
    requireNonEmptyField("alias.alias", alias.alias);
    requireNonEmptyField("alias.source", alias.source);
    requireOptionalText("alias.candidateNewPageId", alias.candidateNewPageId ?? null);
    const confidence = alias.matchConfidence ?? null;
    if (
      confidence !== null &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    ) {
      throw new WikiStoreError(
        "wiki/invalid-field",
        `alias.matchConfidence must be within 0..1: ${String(confidence)}`,
      );
    }
    const exists = this.stmt(
      `SELECT 1 AS hit FROM wiki_aliases
       WHERE workspace_id = ? AND page_id = ? AND alias = ? LIMIT 1`,
    ).get(workspaceId, alias.pageId, alias.alias);
    if (exists !== undefined) {
      throw new WikiStoreError(
        "wiki/duplicate-alias",
        `Alias already exists: ${alias.pageId}/${alias.alias}`,
      );
    }
    this.runWrite(
      `INSERT INTO wiki_aliases
         (workspace_id, page_id, alias, source, candidate_new_page_id,
          match_confidence, position)
       VALUES (?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_aliases))`,
      workspaceId,
      alias.pageId,
      alias.alias,
      alias.source,
      alias.candidateNewPageId === undefined || alias.candidateNewPageId === null
        ? null
        : alias.candidateNewPageId,
      confidence,
    );
  }

  listAliases(workspaceId: string): readonly WikiAlias[] {
    this.requireWorkspace(workspaceId);
    const rows = this.stmt(
      `SELECT page_id, alias, source, candidate_new_page_id, match_confidence
       FROM wiki_aliases WHERE workspace_id = ? ORDER BY position`,
    ).all(workspaceId) as WikiAliasRow[];
    return rows.map((row) => ({
      pageId: row.page_id,
      alias: row.alias,
      source: row.source,
      ...(row.candidate_new_page_id === null
        ? {}
        : { candidateNewPageId: row.candidate_new_page_id }),
      ...(row.match_confidence === null
        ? {}
        : { matchConfidence: row.match_confidence }),
    }));
  }

  // -------------------------------------------------------------------------
  // İç yardımcılar
  // -------------------------------------------------------------------------

  private stmt(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private runWrite(sql: string, ...params: unknown[]): Database.RunResult {
    try {
      return this.stmt(sql).run(...params);
    } catch (error) {
      throw new WikiStoreError(
        "storage/driver-error",
        `SQLite write error: ${errorText(error)}`,
      );
    }
  }

  private requireWorkspace(workspaceId: string): WorkspaceHitRow {
    requireNonEmptyField("workspaceId", workspaceId);
    const row = this.stmt(
      "SELECT id FROM workspaces WHERE id = ? LIMIT 1",
    ).get(workspaceId) as WorkspaceHitRow | undefined;
    if (row === undefined) {
      throw new WikiStoreError(
        "wiki/unknown-workspace",
        `Bilinmeyen workspace: ${workspaceId}`,
      );
    }
    return row;
  }

  private requireWikiRow(wikiSid: number): WikiSnapshotRow {
    const row = this.stmt(
      `SELECT sid, id, workspace_id, graph_snapshot_id, revision_ref, status,
              created_at, built_at, template_version, failure_reason
       FROM wiki_snapshots WHERE sid = ? LIMIT 1`,
    ).get(wikiSid) as WikiSnapshotRow | undefined;
    if (row === undefined) {
      throw new WikiStoreError(
        "wiki/unknown-snapshot",
        `Wiki snapshot row not found: ${String(wikiSid)}`,
      );
    }
    return row;
  }

  private requireBuildingWikiRow(wikiSid: number): WikiSnapshotRow {
    const row = this.requireWikiRow(wikiSid);
    if (row.status !== "building") {
      throw new WikiStoreError(
        "wiki/build-not-active",
        `No active wiki build (status: ${row.status}): ${String(wikiSid)}`,
      );
    }
    return row;
  }

  /** Tam okuma modeli: snapshot + pages + sections + links + versions. */
  private readSnapshotRows(row: WikiSnapshotRow): WikiSnapshotRead {
    if (row.id === null || (row.status !== "ready" && row.status !== "partial")) {
      throw new WikiStoreError(
        "wiki/corrupt-row",
        `An unpublished wiki snapshot cannot be read: sid=${String(row.sid)} status=${row.status}`,
      );
    }
    const snapshot: WikiSnapshot = {
      id: row.id,
      workspaceId: row.workspace_id,
      graphSnapshotId: row.graph_snapshot_id,
      revisionRef: row.revision_ref,
      status: row.status,
      builtAt: row.built_at ?? "",
      templateVersion: row.template_version,
    };
    const pageRows = this.stmt(
      `SELECT page_id, kind, parent_id, title, slug, route, content_hash,
              freshness, coverage_status, coverage_detail
       FROM wiki_pages WHERE wiki_snapshot_sid = ? ORDER BY position`,
    ).all(row.sid) as WikiPageRow[];
    const pages: WikiPage[] = pageRows.map((pageRow) => {
      const detail = pageRow.coverage_detail;
      return {
        id: pageRow.page_id,
        wikiSnapshotId: row.id as string,
        kind: pageRow.kind as WikiPageKind,
        parentId: pageRow.parent_id,
        title: pageRow.title,
        slug: pageRow.slug,
        route: pageRow.route,
        contentHash: pageRow.content_hash,
        freshness: pageRow.freshness as WikiFreshness,
        coverage: {
          status: pageRow.coverage_status as WikiCoverageStatus,
          ...(detail === null ? {} : { detail }),
        },
      };
    });
    const sectionRows = this.stmt(
      `SELECT section_id, page_id, section_key, generated_markdown,
              evidence_refs_json, status
       FROM wiki_page_sections WHERE wiki_snapshot_sid = ? ORDER BY position`,
    ).all(row.sid) as WikiSectionRow[];
    const sections: WikiPageSection[] = sectionRows.map((sectionRow) => ({
      id: sectionRow.section_id,
      pageId: sectionRow.page_id,
      sectionKey: sectionRow.section_key,
      generatedMarkdown: sectionRow.generated_markdown,
      evidenceRefs: readEvidenceRefsJson(
        `wiki_page_sections.evidence_refs_json:${sectionRow.section_id}`,
        sectionRow.evidence_refs_json,
      ),
      status: sectionRow.status as WikiSectionStatus,
    }));
    const linkRows = this.stmt(
      `SELECT link_id, from_page_id, to_page_id, kind, resolution,
              evidence_refs_json
       FROM wiki_links WHERE wiki_snapshot_sid = ? ORDER BY position`,
    ).all(row.sid) as WikiLinkRow[];
    const links: WikiLink[] = linkRows.map((linkRow) => ({
      id: linkRow.link_id,
      wikiSnapshotId: row.id as string,
      fromPageId: linkRow.from_page_id,
      toPageId: linkRow.to_page_id,
      kind: linkRow.kind as WikiLinkKind,
      resolution: linkRow.resolution as WikiLinkResolution,
      evidenceRefs: readEvidenceRefsJson(
        `wiki_links.evidence_refs_json:${linkRow.link_id}`,
        linkRow.evidence_refs_json,
      ),
    }));
    const versionRows = this.stmt(
      `SELECT page_id, revision_ref, content_hash, link_set_hash,
              template_version, coverage_status
       FROM wiki_page_versions WHERE wiki_snapshot_sid = ? ORDER BY position`,
    ).all(row.sid) as WikiVersionRow[];
    const versions: WikiPageVersion[] = versionRows.map((versionRow) => ({
      pageId: versionRow.page_id,
      wikiSnapshotId: row.id as string,
      revisionRef: versionRow.revision_ref,
      contentHash: versionRow.content_hash,
      linkSetHash: versionRow.link_set_hash,
      templateVersion: versionRow.template_version,
      coverage: {
        status: versionRow.coverage_status as WikiCoverageStatus,
      },
    }));
    return { snapshot, pages, sections, links, versions };
  }
}
