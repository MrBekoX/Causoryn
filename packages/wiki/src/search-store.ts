import { WikiSearchError } from "./errors.js";
import {
  normalizeWikiSearchQuery,
  buildWikiMatchExpression,
} from "./search-query.js";
import {
  rankWikiSearchCandidates,
  type WikiSearchCandidate,
} from "./search-ranking.js";
import {
  WIKI_SEARCH_MATCHED_FIELDS,
  WikiSearchResultSchema,
  type WikiSearchHit,
  type WikiSearchMatchedField,
  type WikiSearchResult,
} from "./search-schema.js";
import {
  decodeWikiSearchCursor,
  encodeWikiSearchCursor,
} from "./search-cursor.js";

/**
 * Wiki FTS5 arama — storage katmanı (TŞ v2.1 §16A.3, §16A.7; sprint-4 W4).
 *
 * Katman ayrımı (sprint-4 W4 emri): bu dosya yalnızca SQLite erişimini
 * yürütür; sorgu kaçışı (search-query.ts), sıralama (search-ranking.ts),
 * cursor codec'i (search-cursor.ts) ve sonuç şemaları (search-schema.ts)
 * saf çekirdektir. Depo erişimi minimal yapısal bir port üzerinden
 * yapılır (WikiSearchDatabase): better-sqlite3 Database bu portu
 * yapısal olarak karşılar; packages/wiki better-sqlite3'e BAĞIMLI
 * DEĞİLDİR (bağımlılık sınırı korunur).
 *
 * Güvenlik: TÜM SQL metinleri statik literallerdir ve TÜM değerler
 * hazırlanmış ifade parametreleriyle bağlanır — kullanıcı sorgusu asla
 * SQL metnine katılmaz (MATCH ifadesi Faz A phrase kaçışıyla hazırlanır:
 * search-query.ts). Sütun filtreli alan eşleşme sorguları da altı adet
 * ayrı, tamamen statik ifadedir; sütun adı koddan gelir, girdiden değil.
 *
 * Kapsam: arama yalnızca publish edilmiş (ready/partial) WikiSnapshot
 * satırlarını görür (TŞ §16A.5: building görünmez; publish atomiktir).
 * Snapshot çözümlemesi workspace kapsamlıdır: wikiSnapshotId verilirse
 * hem id hem workspace eşleşir (cross-workspace okuma yok); verilmezse
 * workspace'in en güncel publish edilmiş snapshot'ı seçilir.
 *
 * Determinizm: adaylar tamamen sıralanır (ayaklar + leksik tie-break),
 * cursor bu toplam sıraya offset sayfalama uygular (K-013 #5: default
 * 50, max 200; nextCursor son sayfada null). Aday kümesi LIMIT'SİZ
 * çekilir — çok-ayaklı sıralama deterministik olması için tam küme
 * üzerindedir; wiki ölçeği (yüzlerce sayfa/snapshot) için uygundur.
 */

/** Hazırlanmış ifade portu — better-sqlite3 Statement yapısal uyar. */
export interface WikiSearchStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/** Depo portu — better-sqlite3 Database yapısal uyar. */
export interface WikiSearchDatabase {
  prepare(sql: string): WikiSearchStatement;
}

export interface WikiSearchInput {
  /** Zorunlu: sonuçlar bu workspace kapsamıyla sınırlıdır. */
  workspaceId: string;
  /** Kullanıcı sorgusu; boş/yalnız boşluk → wiki/empty-query. */
  query: string;
  /** Belirtilmezse workspace'in en güncel publish edilmiş WikiSnapshot'ı. */
  wikiSnapshotId?: string;
  /** K-013 #5: default 50, max 200. */
  limit?: number;
  /** Opak cursor (encodeWikiSearchCursor çıktısı). */
  cursor?: string;
  /** Graph yakınlık ayak verisi: pageId → mesafe (küçük = yakın);
   * verilmezse ayak atlanır + skippedRankLegs degrade notu. */
  proximity?: ReadonlyMap<string, number>;
}

export const DEFAULT_WIKI_SEARCH_LIMIT = 50;
export const MAX_WIKI_SEARCH_LIMIT = 200;

interface WikiSnapshotHit {
  sid: number;
  id: string;
}

/** Snapshot çözümleme sorguları — statik; değerler parametreyle bağlanır. */
const SQL_SNAPSHOT_BY_ID = `SELECT sid, id
 FROM wiki_snapshots
 WHERE id = ? AND workspace_id = ? AND status IN ('ready','partial')
 LIMIT 1`;

const SQL_SNAPSHOT_LATEST = `SELECT sid, id
 FROM wiki_snapshots
 WHERE workspace_id = ? AND status IN ('ready','partial')
 ORDER BY sid DESC LIMIT 1`;

/**
 * Aday sorgusu: FTS5 MATCH (kaçışlı phrase parametresi) + snapshot
 * kapsamı; snippet() ve bm25() FTS5 yardımcıları sabit argümanlarla
 * kullanılır (deterministik). Sıralama SQL'de DEĞİL, saf çekirdekte.
 */
const SQL_CANDIDATES = `SELECT wiki_fts.page_id AS page_id,
       wiki_pages.kind AS kind,
       wiki_pages.title AS title,
       wiki_pages.route AS route,
       wiki_pages.freshness AS freshness,
       wiki_fts.qualified_symbol AS qualified_symbol,
       wiki_fts.api_route AS api_route,
       wiki_fts.module AS module,
       snippet(wiki_fts, -1, '[', ']', '…', 12) AS snippet,
       bm25(wiki_fts) AS bm25
FROM wiki_fts
JOIN wiki_snapshots ON wiki_snapshots.sid = wiki_fts.wiki_snapshot_sid
JOIN wiki_pages ON wiki_pages.wiki_snapshot_sid = wiki_fts.wiki_snapshot_sid
               AND wiki_pages.page_id = wiki_fts.page_id
WHERE wiki_fts MATCH ? AND wiki_snapshots.sid = ?
  AND wiki_snapshots.status IN ('ready','partial')`;

/** Alan eşleşme gerçeği: altı AYRI statik sorgu; sütun adı koddan gelir.
 * Parametre 1: `sütun:"kaçışlı phrase"` (FTS5 sütun filtresi), parametre 2:
 * snapshot sid. SQL metnine hiçbir girdi katılmaz. */
const SQL_FIELD_MATCH: readonly {
  readonly field: WikiSearchMatchedField;
  readonly column: string;
  readonly sql: string;
}[] = [
  {
    field: "title",
    column: "title",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.title MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
  {
    field: "qualifiedSymbol",
    column: "qualified_symbol",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.qualified_symbol MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
  {
    field: "apiRoute",
    column: "api_route",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.api_route MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
  {
    field: "module",
    column: "module",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.module MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
  {
    field: "tags",
    column: "tags",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.tags MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
  {
    field: "body",
    column: "body",
    sql: `SELECT wiki_fts.page_id AS page_id
 FROM wiki_fts
 WHERE wiki_fts.body MATCH ? AND wiki_fts.wiki_snapshot_sid = ?`,
  },
];

/** Kanıt referansları yalnızca SONUÇ PENCERESİNDEKİ sayfalar için
 * taşınır; sql sıralaması deterministiktir (page_id, position). */
const SQL_SECTIONS = `SELECT page_id, evidence_refs_json
 FROM wiki_page_sections
 WHERE wiki_snapshot_sid = ?
 ORDER BY page_id, position`;

/**
 * Runs one FTS5 MATCH statement and maps SQLite failures to search contract
 * codes. The SQL text is static and already prepared, so an `SQLITE_ERROR`
 * raised while stepping comes from evaluating the MATCH expression: it maps
 * to `wiki/invalid-field` with a fixed message (no SQL, engine text or stack
 * reaches the caller). Any other failure is an environment error
 * (`storage/driver-error`); the service layer logs its detail to stderr and
 * returns a generic internal error.
 */
function runFullTextQuery(run: () => unknown[]): unknown[] {
  try {
    return run();
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "SQLITE_ERROR") {
      throw new WikiSearchError(
        "wiki/invalid-field",
        "query cannot be evaluated by the full-text index; remove unsupported characters and retry",
      );
    }
    throw new WikiSearchError(
      "storage/driver-error",
      `SQLite full-text search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `Storage row has an unexpected shape: ${what}`,
    );
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `Storage field must be a string: ${key}`,
    );
  }
  return value;
}

function asStringOrNull(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `Storage field must be a string or null: ${key}`,
    );
  }
  return value;
}

function asFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `Storage field must be a finite number: ${key}`,
    );
  }
  return value;
}

/** Bölüm kanıt referanslarını çözümler: tekrarsız + leksik sıralı
 * evidenceId listesi. Bozuk JSON → wiki/storage-corrupt (sessiz boşma
 * yok — kanıt listesi uydurulmaz). */
function collectEvidenceIds(rawJson: string, pageId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `evidence_refs_json could not be parsed: ${pageId}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new WikiSearchError(
      "wiki/storage-corrupt",
      `evidence_refs_json must be an array: ${pageId}`,
    );
  }
  const ids = new Set<string>();
  for (const ref of parsed) {
    if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
      throw new WikiSearchError(
        "wiki/storage-corrupt",
        `evidence reference must be an object: ${pageId}`,
      );
    }
    const evidenceId = (ref as Record<string, unknown>)["evidenceId"];
    if (typeof evidenceId !== "string" || evidenceId === "") {
      throw new WikiSearchError(
        "wiki/storage-corrupt",
        `evidenceId in an evidence reference must be a string: ${pageId}`,
      );
    }
    ids.add(evidenceId);
  }
  return [...ids].sort();
}

export class WikiSearchStore {
  private readonly db: WikiSearchDatabase;

  constructor(db: WikiSearchDatabase) {
    if (db === null || typeof db.prepare !== "function") {
      throw new WikiSearchError(
        "wiki/invalid-field",
        "A WikiSearchDatabase port is required (prepare function)",
      );
    }
    this.db = db;
  }

  /**
   * Wiki sayfa araması (TŞ §16A.3): kaçışlı çok alanlı FTS5 sorgu,
   * K-013 sıralaması (exact sembol/route > başlık > modül > BM25 >
   * graph yakınlığı — ayak verisi yoksa yakınlık atlanır), matchedFields
   * + evidenceIds relevance açıklaması ve opak cursor sayfalama.
   */
  search(input: WikiSearchInput): WikiSearchResult {
    const workspaceId =
      typeof input?.workspaceId === "string" ? input.workspaceId.trim() : "";
    if (workspaceId === "") {
      throw new WikiSearchError(
        "wiki/invalid-field",
        "workspaceId is required",
      );
    }
    if (typeof input.query !== "string") {
      throw new WikiSearchError(
        "wiki/invalid-field",
        "query must be a string",
      );
    }
    const query = normalizeWikiSearchQuery(input.query);
    if (query === "") {
      throw new WikiSearchError(
        "wiki/empty-query",
        "Query must not be empty (it is empty after normalization)",
      );
    }
    const limit = input.limit ?? DEFAULT_WIKI_SEARCH_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_WIKI_SEARCH_LIMIT
    ) {
      throw new WikiSearchError(
        "wiki/invalid-limit",
        `limit must be an integer in the range 1..${String(MAX_WIKI_SEARCH_LIMIT)}: ${String(limit)}`,
      );
    }
    const offset =
      input.cursor === undefined ? 0 : decodeWikiSearchCursor(input.cursor);
    if (offset === null) {
      throw new WikiSearchError(
        "wiki/invalid-cursor",
        "Cursor could not be decoded",
      );
    }
    const proximity = input.proximity;
    if (proximity !== undefined) {
      for (const [pageId, distance] of proximity) {
        if (typeof distance !== "number" || !Number.isFinite(distance)) {
          throw new WikiSearchError(
            "wiki/invalid-field",
            `proximity value must be a finite number: ${pageId}`,
          );
        }
      }
    }

    const snapshot = this.resolveSnapshot(workspaceId, input.wikiSnapshotId);
    const matchExpression = buildWikiMatchExpression(query);

    const candidateStatement = this.db.prepare(SQL_CANDIDATES);
    const candidateRows = runFullTextQuery(() =>
      candidateStatement.all(matchExpression, snapshot.sid),
    );
    const candidates = candidateRows.map((row) =>
      this.toCandidate(asRecord(row, "wiki_fts candidate row")),
    );

    // Alan eşleşme gerçeği: altı statik sütun-filtreli sorgu; sonuç
    // pageId kümeleri adaylarla kesiştirilir ve kanonik sırada yazılır.
    const matchedByField = new Map<WikiSearchMatchedField, Set<string>>();
    for (const fieldQuery of SQL_FIELD_MATCH) {
      const fieldStatement = this.db.prepare(fieldQuery.sql);
      const rows = runFullTextQuery(() =>
        fieldStatement.all(`${fieldQuery.column}:${matchExpression}`, snapshot.sid),
      );
      const pageIds = new Set<string>();
      for (const row of rows) {
        pageIds.add(asString(asRecord(row, "fts field row"), "page_id"));
      }
      matchedByField.set(fieldQuery.field, pageIds);
    }
    for (const candidate of candidates) {
      const matched: WikiSearchMatchedField[] = [];
      for (const field of WIKI_SEARCH_MATCHED_FIELDS) {
        if (matchedByField.get(field)?.has(candidate.pageId) === true) {
          matched.push(field);
        }
      }
      candidate.matchedFields = matched;
    }

    const ranking = rankWikiSearchCandidates(
      candidates,
      proximity === undefined ? { query } : { query, proximity },
    );
    const ordered = ranking.ordered;
    const window = ordered.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < ordered.length
        ? encodeWikiSearchCursor(offset + limit)
        : null;

    const evidenceByPage = this.readEvidenceIds(snapshot.sid, window);

    const hits: WikiSearchHit[] = window.map((candidate) => ({
      pageId: candidate.pageId,
      kind: candidate.kind,
      title: candidate.title,
      route: candidate.route,
      freshness: candidate.freshness,
      qualifiedSymbol: candidate.qualifiedSymbol,
      apiRoute: candidate.apiRoute,
      module: candidate.module,
      snippet: candidate.snippet,
      matchedFields: [...candidate.matchedFields],
      evidenceIds: evidenceByPage.get(candidate.pageId) ?? [],
    }));

    const result: WikiSearchResult = {
      wikiSnapshotId: snapshot.id,
      workspaceId,
      query,
      matchExpression,
      totalMatches: ordered.length,
      hits,
      nextCursor,
      skippedRankLegs: ranking.skippedRankLegs,
    };
    // Çıktı sözleşmesi self-check: dahili sapma → wiki/storage-corrupt.
    try {
      return WikiSearchResultSchema.parse(result);
    } catch {
      throw new WikiSearchError(
        "wiki/storage-corrupt",
        "Search result violated the schema contract",
      );
    }
  }

  /** Snapshot çözümleme: id verilirse id+workspace (cross-workspace
   * okuma yok), yoksa workspace'in en güncel publish edilmiş snapshot'ı. */
  private resolveSnapshot(
    workspaceId: string,
    wikiSnapshotId: string | undefined,
  ): WikiSnapshotHit {
    const row =
      wikiSnapshotId === undefined
        ? (this.db.prepare(SQL_SNAPSHOT_LATEST).get(workspaceId) as unknown)
        : (this.db
            .prepare(SQL_SNAPSHOT_BY_ID)
            .get(wikiSnapshotId, workspaceId) as unknown);
    if (row === undefined || row === null) {
      throw new WikiSearchError(
        "wiki/snapshot-not-found",
        wikiSnapshotId === undefined
          ? `No published WikiSnapshot for workspace: ${workspaceId}`
          : `WikiSnapshot not found in workspace scope: ${wikiSnapshotId}`,
      );
    }
    const record = asRecord(row, "wiki_snapshots row");
    const sid = asFiniteNumber(record, "sid");
    if (!Number.isInteger(sid)) {
      throw new WikiSearchError(
        "wiki/storage-corrupt",
        "wiki_snapshots.sid must be an integer",
      );
    }
    const id = asStringOrNull(record, "id");
    if (id === null) {
      throw new WikiSearchError(
        "wiki/storage-corrupt",
        "Published snapshot row must not have a null id",
      );
    }
    return { sid, id };
  }

  private toCandidate(record: Record<string, unknown>): WikiSearchCandidate {
    return {
      pageId: asString(record, "page_id"),
      kind: asString(record, "kind") as WikiSearchCandidate["kind"],
      title: asString(record, "title"),
      route: asString(record, "route"),
      freshness: asString(record, "freshness") as WikiSearchCandidate["freshness"],
      qualifiedSymbol: asStringOrNull(record, "qualified_symbol"),
      apiRoute: asStringOrNull(record, "api_route"),
      module: asStringOrNull(record, "module"),
      snippet: asStringOrNull(record, "snippet") ?? "",
      matchedFields: [],
      bm25Rank: asFiniteNumber(record, "bm25"),
    };
  }

  /** Sonuç penceresindeki sayfaların kanıt kimlikleri (tekrarsız,
   * leksik sıralı). Pencere boşsa sorgu hiç çalıştırılmaz. */
  private readEvidenceIds(
    sid: number,
    window: readonly WikiSearchCandidate[],
  ): Map<string, string[]> {
    const evidenceSets = new Map<string, Set<string>>();
    if (window.length === 0) return new Map<string, string[]>();
    const windowPages = new Set(window.map((candidate) => candidate.pageId));
    const rows = this.db
      .prepare(SQL_SECTIONS)
      .all(sid) as unknown[];
    for (const row of rows) {
      const record = asRecord(row, "wiki_page_sections row");
      const pageId = asString(record, "page_id");
      if (!windowPages.has(pageId)) continue;
      const refs = collectEvidenceIds(
        asString(record, "evidence_refs_json"),
        pageId,
      );
      const merged = evidenceSets.get(pageId) ?? new Set<string>();
      for (const id of refs) merged.add(id);
      evidenceSets.set(pageId, merged);
    }
    const evidenceByPage = new Map<string, string[]>();
    for (const [pageId, ids] of evidenceSets) {
      evidenceByPage.set(pageId, [...ids].sort());
    }
    return evidenceByPage;
  }
}
