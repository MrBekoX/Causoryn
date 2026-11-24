import Database from "better-sqlite3";
import { buildSymbolFtsDocument } from "@causoryn/graph";

import { applyWikiSchema } from "./wiki-schema.js";

/**
 * SQLite şeması — TŞ v2.1 §9 tablo ailesinin Faz A dilimi (sprint-1
 * görev 5): workspaces, files, snapshots, nodes, edges, evidence +
 * edge_evidence bağlama tablosu + symbol_fts (FTS5).
 *
 * Şema kararları:
 * - `snapshots.sid` INTEGER PRIMARY KEY iç kimliktir; `id` (TEXT, UNIQUE)
 *   publish anında atanan deterministik snapshot kimliğidir ve building
 *   sırasında NULL'dur. Building satırları hiçbir okuma yolunda
 *   çözülemez (yarım snapshot asla görünmez); publish tek UPDATE'tir.
 * - nodes/edges/evidence satırları build başlarken eklenmeye başlanır ve
 *   `snapshot_sid` üzerinden bağlanır; TŞ §9 kompozit indeksleri
 *   (snapshot, kind) / (snapshot, from_id) / (snapshot, to_id) /
 *   (snapshot, relative_path) `snapshot_sid` üzerinden kurulur.
 * - edges → nodes referans bütünlüğü kompozit FOREIGN KEY ile SQL
 *   düzeyinde zorlanır (invariant ii savunma katmanı); edge → evidence
 *   bağları (evidence_ids_json) konum korunarak edges satırında taşınır
 *   ve referans bütünlüğü publish'teki finalize denetiminde doğrulanır
 *   (bilinmeyen kanıt referansı → graph/unknown-evidence-ref).
 * - Bütün DDL TEK statik literal olarak `applySchema` içinde çalıştırılır:
 *   SQL metnine hiçbir değişken katılmaz (tarama ve denetim kolaylığı),
 *   veri yalnızca hazırlanmış ifade parametreleriyle bağlanır (bkz.
 *   sqlite-repository.ts).
 * - Şema sürümü PRAGMA user_version ile izlenir (Faz A graph dilimi için
 *   tek sürüm; ileride migration tablosuna geçilebilir — TŞ §9
 *   schema_migrations). Sürüm damgası DDL literalinin son satırıdır ve
 *   SCHEMA_VERSION sabitiyle birlikte güncellenmelidir.
 * - Faz C2 (sprint-4 W2): SCHEMA_VERSION 2 — wiki dilimi DDL'i
 *   (wiki-schema.ts, TŞ §16A.7) aynı migration transaction'ında uygulanır.
 *   Graph tabloları olduğu gibi kalır; v1 damgalı veritabanları idempotent
 *   DDL ile v2'ye yükselir.
 * - Wave 1 Track C (Task 1.7 + SQLite CVE savunma derinliği): SCHEMA_VERSION 3 —
 *   tek paylaşımlı workspace DB için heartbeat'li tek-yazıcı `build_leases`
 *   tablosu eklenir; yeni DB'lerde (`user_version === 0`) tablo oluşturmadan
 *   önce `PRAGMA page_size = 4096` (CVE-2026-119375 küçük WAL sayfası savunması)
 *   uygulanır; `symbol_fts` varsayılan `detail=full` ile korunur (asla
 *   `detail=none` kullanılmaz — CVE-2026-119373 savunması). v1/v2 → v3 geçişi
 *   tek transaction içinde geriye uyumludur.
 * - Wave 2 Track 2C (Tasks 2.4, 2.6 & LocAgent FTS5): SCHEMA_VERSION 4 —
 *   adds `file_facts` table for per-file incremental indexing with early cutoff
 *   (`public_interface_hash` + `imported_paths_json`) and upgrades `symbol_fts`
 *   to `(symbol, search_text, node_id UNINDEXED, snapshot_sid UNINDEXED)` (still
 *   default `detail=full`, CVE-2026-119373 hardened) with LocAgent path+camelCase
 *   tokenization. v1/v2/v3 -> v4 migration runs in a single atomic transaction.
 */

export const SCHEMA_VERSION = 4;

/** Şemayı uygular (sürüm < SCHEMA_VERSION ise); DDL tamamen statiktir. */
export function applySchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error(`SQLite user_version okunamadı: ${String(version)}`);
  }
  if (version >= SCHEMA_VERSION) return;
  if (version === 0) {
    // Defense-in-depth (CVE-2026-119375): enforce standard 4096-byte pages
    // before any table or WAL page is initialized on a brand-new database.
    db.pragma("page_size = 4096");
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS file_facts (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        analyzer_fingerprint TEXT NOT NULL,
        language TEXT NOT NULL,
        public_interface_hash TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        imported_paths_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_file_facts_workspace_fp
        ON file_facts(workspace_id, analyzer_fingerprint);
      CREATE TABLE IF NOT EXISTS snapshots (
        sid INTEGER PRIMARY KEY,
        id TEXT UNIQUE,
        build_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        revision_sequence INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        analyzer_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('building','ready','partial','failed')),
        created_at TEXT NOT NULL,
        published_at TEXT,
        failure_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_active_build
        ON snapshots(workspace_id, revision_id, revision_sequence)
        WHERE state = 'building';
      CREATE INDEX IF NOT EXISTS idx_snapshots_workspace_state
        ON snapshots(workspace_id, state);
      CREATE TABLE IF NOT EXISTS build_leases (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        build_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        host_label TEXT,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        language TEXT,
        relative_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        source_hash TEXT,
        attributes_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (snapshot_sid, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_snapshot_kind
        ON nodes(snapshot_sid, kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_snapshot_path
        ON nodes(snapshot_sid, relative_path);
      CREATE TABLE IF NOT EXISTS edges (
        snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE,
        edge_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resolution TEXT NOT NULL
          CHECK (resolution IN ('verified','heuristic','unresolved')),
        evidence_ids_json TEXT NOT NULL,
        ambiguity_json TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (snapshot_sid, edge_id),
        FOREIGN KEY (snapshot_sid, from_id)
          REFERENCES nodes(snapshot_sid, node_id) ON DELETE CASCADE,
        FOREIGN KEY (snapshot_sid, to_id)
          REFERENCES nodes(snapshot_sid, node_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_edges_snapshot_kind
        ON edges(snapshot_sid, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_snapshot_from
        ON edges(snapshot_sid, from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_snapshot_to
        ON edges(snapshot_sid, to_id);
      CREATE TABLE IF NOT EXISTS evidence (
        snapshot_sid INTEGER NOT NULL REFERENCES snapshots(sid) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        relative_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        source_hash TEXT,
        analyzer_id TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        rationale TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (snapshot_sid, evidence_id)
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_snapshot_path
        ON evidence(snapshot_sid, relative_path);
    `);

    if (version > 0 && version < 4) {
      db.exec(`DROP TABLE IF EXISTS symbol_fts;`);
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
        symbol,
        search_text,
        node_id UNINDEXED,
        snapshot_sid UNINDEXED
      );
    `);

    if (version > 0 && version < 4) {
      const existingNodes = db
        .prepare(
          `SELECT n.snapshot_sid AS snapshot_sid,
                  n.node_id AS node_id,
                  n.qualified_name AS qualified_name,
                  n.relative_path AS relative_path
           FROM nodes n
           JOIN snapshots s ON s.sid = n.snapshot_sid
           WHERE s.state IN ('ready','partial')
             AND n.kind NOT IN ('Workspace','UnknownExternal')`,
        )
        .all() as Array<{
        snapshot_sid: number;
        node_id: string;
        qualified_name: string;
        relative_path: string | null;
      }>;
      if (existingNodes.length > 0) {
        const insertFts = db.prepare(
          `INSERT INTO symbol_fts (symbol, search_text, node_id, snapshot_sid)
           VALUES (?, ?, ?, ?)`,
        );
        for (const row of existingNodes) {
          const searchText = buildSymbolFtsDocument(
            row.qualified_name,
            row.relative_path ?? undefined,
          );
          insertFts.run(row.qualified_name, searchText, row.node_id, row.snapshot_sid);
        }
      }
    }

    applyWikiSchema(db);
    db.exec("PRAGMA user_version = 4;");
  })();
}
