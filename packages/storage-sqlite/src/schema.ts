import Database from "better-sqlite3";

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
 * - Şema sürümü PRAGMA user_version ile izlenir (Faz A dilimi için tek
 *   sürüm; ileride migration tablosuna geçilebilir — TŞ §9
 *   schema_migrations). Sürüm damgası DDL literalinin son satırıdır ve
 *   SCHEMA_VERSION sabitiyle birlikte güncellenmelidir.
 */

export const SCHEMA_VERSION = 1;

/** Şemayı uygular (sürüm < SCHEMA_VERSION ise); DDL tamamen statiktir. */
export function applySchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error(`SQLite user_version okunamadı: ${String(version)}`);
  }
  if (version >= SCHEMA_VERSION) return;
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
      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
        symbol,
        node_id UNINDEXED,
        snapshot_sid UNINDEXED
      );
      PRAGMA user_version = 1;
    `);
  })();
}
