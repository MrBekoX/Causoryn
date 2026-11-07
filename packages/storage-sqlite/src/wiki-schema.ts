import Database from "better-sqlite3";

/**
 * Wiki şema dilimi — TŞ v2.1 §16A.7 (s.17) varlık ailesinin Faz C2
 * karşılıkları (wiki/sprint-4.md W2): wiki_snapshots + wiki_pages,
 * wiki_page_sections, wiki_links, wiki_page_versions, wiki_annotations,
 * wiki_aliases + wiki_fts (FTS5).
 *
 * Şema kararları (mevcut graph şemasının deseni KIRILMADAN uygulanır —
 * bkz. schema.ts; graph tabloları olduğu gibi kalır):
 * - `wiki_snapshots.sid` INTEGER PRIMARY KEY iç kimliktir; `id`
 *   (TEXT, UNIQUE) publish anında atanan deterministik wiki snapshot
 *   kimliğidir ve building sırasında NULL'dur (TŞ §16A.5: building
 *   görünmez; publish tek UPDATE — GraphSnapshot disipliniyle birebir).
 * - Child tablolar `wiki_snapshot_sid` üzerinden bağlanır; snapshot
 *   silinirse tüm projeksiyon ON DELETE CASCADE ağacı gider.
 * - wiki_pages parent FK'sı KENDİ tablosuna kompozit referanstır
 *   (sections/pages → pages; sprint-4 W2 isteği): parent sayfa aynı
 *   snapshot içinde önce yazılmalıdır.
 * - wiki_links.to_page_id NULL olabilir (K-013 #4: bozuk link WikiLink
 *   korunur, toPageId null; diagnostics W3'te üretilir); NULL olmayan
 *   hedef kompozit FK ile SQL düzeyinde doğrulanır.
 * - wiki_page_versions sayfa başına tek satırdır (PK: sid + page_id);
 *   revizyonlar arası geçmiş ayrı wiki snapshot satırlarında yaşar
 *   (TŞ §16A.4 iki düzey sürüm).
 * - wiki_annotations OVERLAY tablosudur ve wiki_snapshots'a FK ile
 *   BAĞLANMAZ (TŞ §16A.6: generated layer yenilendiğinde asla üzerine
 *   yazılmaz; W7 reindex anotasyonlara dokunmaz). Yalnızca workspace'e
 *   bağlıdır (workspace/user storage ayrımı, TŞ §16A.6).
 * - wiki_aliases workspace kapsamlı KALICI tablodur (PK ile aynı alias
 *   iki kez yazılamaz). Alan eşlemesi — sprint-4 W2 emri ("pageId + alias
 *   + source, deterministik") ile TŞ §16A.7 eması
 *   WikiPageAlias(oldPageId, candidateNewPageId, reason, matchConfidence)
 *   ve wiki-spec §3.6 taslağı birleşiktir; sapma bilinçli ve şöyledir:
 *   page_id ↔ oldPageId (alias'ın sahibi eski/kanonik sayfa);
 *   alias ↔ W2 emrinin eklediği 'alias' sütunu (eski slug/başlık metni —
 *   emada yok, redirect çözümlemesi için gerekli); source ↔ reason
 *   (yeniden adlandırma göstergesi: rename/relocation vb.);
 *   candidate_new_page_id ↔ candidateNewPageId (NULL = çözülememiş
 *   candidate_redirect); match_confidence ↔ matchConfidence (0..1 CHECK).
 *   K-013 bu alan adlarını kilitlememiştir; W5/W7 tüketicileri bu
 *   eşlemeyi referans alır.
 * - wiki_fts FK'SIZDIR (Faz A dersi: sanal tabloda FK yok; symbol_fts
 *   deseni). Sütunlar TŞ §16A.7 WikiSearchIndex listesidir: title,
 *   qualifiedSymbol, apiRoute, module, tags + body (TŞ §16A.3 BM25
 *   içerik sıralaması için — FTS5 sonradan ALTER edilemez, baştan
 *   eklenir) + page_id/wiki_snapshot_sid UNINDEXED birleştirme
 *   anahtarları (W4). manualNotes opt-in sütunu TŞ §20 config kararıyla
 *   W4/W7'de değerlendirilir.
 * - Bütün DDL satırları TEK TEK statik literaldir ve hazırlanmış ifade
 *   olarak çalıştırılır; veri ise yalnızca parametrelerle bağlanır
 *   (bkz. wiki-store.ts). SQL metnine hiçbir değişken katılmaz.
 */

/**
 * Wiki DDL — her öğe tek, tamamen statik bir SQL ifadesidir. İfade
 * listesi sırayla hazırlanmış ifade olarak çalıştırılır (bkz.
 * applyWikiSchema); şema sürümü damgası schema.ts'te verilir.
 */
const WIKI_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS wiki_snapshots (
    sid INTEGER PRIMARY KEY,
    id TEXT UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    graph_snapshot_id TEXT NOT NULL,
    revision_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building','ready','partial','failed')),
    created_at TEXT NOT NULL,
    built_at TEXT,
    template_version TEXT NOT NULL,
    failure_reason TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_snapshots_active_build
    ON wiki_snapshots(workspace_id, graph_snapshot_id)
    WHERE status = 'building'`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_snapshots_workspace_state
    ON wiki_snapshots(workspace_id, status)`,
  `CREATE TABLE IF NOT EXISTS wiki_pages (
    wiki_snapshot_sid INTEGER NOT NULL REFERENCES wiki_snapshots(sid) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'overview','architecture','project','module','component','symbol','api',
      'business_flow','event','data','contract','policy','test','timeline',
      'onboarding','coverage')),
    parent_id TEXT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    route TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    freshness TEXT NOT NULL CHECK (freshness IN ('fresh','stale')),
    coverage_status TEXT NOT NULL
      CHECK (coverage_status IN ('complete','partial','unsupported','no_data')),
    coverage_detail TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (wiki_snapshot_sid, page_id),
    FOREIGN KEY (wiki_snapshot_sid, parent_id)
      REFERENCES wiki_pages(wiki_snapshot_sid, page_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_snapshot_kind
    ON wiki_pages(wiki_snapshot_sid, kind)`,
  `CREATE TABLE IF NOT EXISTS wiki_page_sections (
    wiki_snapshot_sid INTEGER NOT NULL REFERENCES wiki_snapshots(sid) ON DELETE CASCADE,
    section_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    generated_markdown TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','partial','no_data')),
    position INTEGER NOT NULL,
    PRIMARY KEY (wiki_snapshot_sid, section_id),
    FOREIGN KEY (wiki_snapshot_sid, page_id)
      REFERENCES wiki_pages(wiki_snapshot_sid, page_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_sections_snapshot_page
    ON wiki_page_sections(wiki_snapshot_sid, page_id)`,
  `CREATE TABLE IF NOT EXISTS wiki_links (
    wiki_snapshot_sid INTEGER NOT NULL REFERENCES wiki_snapshots(sid) ON DELETE CASCADE,
    link_id TEXT NOT NULL,
    from_page_id TEXT NOT NULL,
    to_page_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN (
      'PARENT_OF','DOCUMENTS','DEPENDS_ON','CALLS','IMPLEMENTS','PRODUCES',
      'CONSUMES','TESTED_BY','FLOWS_TO','RELATED_CONTRACT','CHANGED_IN')),
    resolution TEXT NOT NULL
      CHECK (resolution IN ('verified','heuristic','unresolved')),
    evidence_refs_json TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (wiki_snapshot_sid, link_id),
    FOREIGN KEY (wiki_snapshot_sid, from_page_id)
      REFERENCES wiki_pages(wiki_snapshot_sid, page_id) ON DELETE CASCADE,
    FOREIGN KEY (wiki_snapshot_sid, to_page_id)
      REFERENCES wiki_pages(wiki_snapshot_sid, page_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_links_snapshot_from
    ON wiki_links(wiki_snapshot_sid, from_page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_links_snapshot_to
    ON wiki_links(wiki_snapshot_sid, to_page_id)`,
  `CREATE TABLE IF NOT EXISTS wiki_page_versions (
    wiki_snapshot_sid INTEGER NOT NULL REFERENCES wiki_snapshots(sid) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    revision_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    link_set_hash TEXT NOT NULL,
    template_version TEXT NOT NULL,
    coverage_status TEXT NOT NULL
      CHECK (coverage_status IN ('complete','partial','unsupported','no_data')),
    position INTEGER NOT NULL,
    PRIMARY KEY (wiki_snapshot_sid, page_id),
    FOREIGN KEY (wiki_snapshot_sid, page_id)
      REFERENCES wiki_pages(wiki_snapshot_sid, page_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_annotations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    stable_page_id TEXT NOT NULL,
    section_key TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    origin TEXT,
    verified INTEGER,
    body TEXT NOT NULL,
    annotation_version INTEGER NOT NULL CHECK (annotation_version >= 0),
    updated_at TEXT NOT NULL,
    position INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_annotations_workspace
    ON wiki_annotations(workspace_id)`,
  `CREATE TABLE IF NOT EXISTS wiki_aliases (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    source TEXT NOT NULL,
    candidate_new_page_id TEXT,
    match_confidence REAL
      CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
    position INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, page_id, alias)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    title,
    qualified_symbol,
    api_route,
    module,
    tags,
    body,
    page_id UNINDEXED,
    wiki_snapshot_sid UNINDEXED
  )`,
];

/** Wiki dilimi DDL'ini uygular (applySchema içinde, aynı transaction'da). */
export function applyWikiSchema(db: Database.Database): void {
  for (const statement of WIKI_SCHEMA_STATEMENTS) {
    db.prepare(statement).run();
  }
}
