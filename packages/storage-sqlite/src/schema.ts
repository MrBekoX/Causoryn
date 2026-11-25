import { closeSync, openSync } from "node:fs";

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
 * - Wave 1 Track C (Task 1.7): SCHEMA_VERSION 3 — adds the heartbeat-renewed
 *   single-writer `build_leases` table for the shared per-workspace DB.
 *   v1/v2 -> v3 migration is backward compatible inside one transaction.
 * - Wave 2 Track 2C (Tasks 2.4, 2.6 & LocAgent FTS5): SCHEMA_VERSION 4 —
 *   adds `file_facts` table for per-file incremental indexing with early cutoff
 *   (`public_interface_hash` + `imported_paths_json`) and upgrades `symbol_fts`
 *   to `(symbol, search_text, node_id UNINDEXED, snapshot_sid UNINDEXED)` (default
 *   `detail=full`) with LocAgent path+camelCase tokenization. v1/v2/v3 -> v4
 *   migration runs in a single atomic transaction.
 * - Task 1.7 follow-up: SCHEMA_VERSION 5 — `build_leases` gains `hostname`
 *   (os.hostname() of the lease owner; PID liveness is only meaningful on the
 *   same machine) and `owner_instance` (per-process instance id that detects
 *   PID reuse and stale same-process leases). Added with `ALTER TABLE ... ADD
 *   COLUMN` (nullable), so v3/v4 lease rows stay readable; rows written by an
 *   older build carry NULL and are treated as "unknown host" (TTL only).
 * - Forward guard: a database stamped with a NEWER `user_version` than this build
 *   understands is refused with `SchemaTooNewError` (code
 *   `storage/schema-too-new`) instead of being silently used, so two different
 *   schema versions never write the same file. The runtime CLI then falls back
 *   to a version-specific file (`graph.schema-<N>.sqlite`).
 * - SQLite security notes (corrected): better-sqlite3@13.2.0 bundles SQLite
 *   3.54.1 (`select sqlite_version()`), which already contains the fixes for
 *   CVE-2026-119373 and CVE-2026-119375. `page_size = 4096` is SQLite's default
 *   page size and is NOT a mitigation, so it is no longer set explicitly. The
 *   real mitigation for CVE-2026-119375 is to never open untrusted database/WAL
 *   files: Causoryn only opens databases inside its own data directory.
 */

export const SCHEMA_VERSION = 5;

/**
 * Per-connection hardening applied to every SQLite connection Causoryn opens
 * (read-write, read-only and heartbeat connections alike).
 *
 * `trusted_schema = OFF`: SQL functions that are not marked innocuous (and
 * virtual tables that are not marked innocuous) can no longer run from
 * schema objects such as views, triggers, CHECK/DEFAULT expressions or
 * expression indexes. Causoryn's own schema uses none of these, so normal
 * operation is unchanged, while a tampered schema cannot make queries call
 * application functions as a side effect.
 */
export function hardenSqliteConnection(db: Database.Database): void {
  db.pragma("trusted_schema = OFF");
}

/**
 * Returns the `PRAGMA user_version` value when it is a non-negative integer,
 * otherwise `undefined`. Causoryn only ever stamps 0 (new file) or 1..N; a
 * negative or non-integer value means the file was not written by Causoryn
 * (or was altered), so callers refuse it before anything writes the file.
 */
export function validUserVersion(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

/**
 * Creates a database file that does not exist yet with owner-only
 * permissions (0o600 on POSIX; the mode is ignored on Windows). The SQLite
 * unix VFS gives the `-wal`, `-shm` and journal files the mode of the main
 * database file, so they are owner-only as well. The file is created with
 * O_CREAT|O_EXCL (`wx`): an existing entry is never truncated, re-permissioned
 * or followed. SQLite treats the empty file as a new database. Special names
 * (`:memory:`, empty, `file:` URIs) are left to SQLite; any other open error
 * is also left to SQLite so its usual error is reported.
 */
export function createPrivateDatabaseFile(dbPath: string): void {
  if (dbPath === "" || dbPath === ":memory:" || dbPath.startsWith("file:")) return;
  let fd: number;
  try {
    fd = openSync(dbPath, "wx", 0o600);
  } catch {
    return;
  }
  closeSync(fd);
}

/**
 * Typed refusal for a database whose `user_version` is newer than this build's
 * `SCHEMA_VERSION`. Carries both versions so callers can pick a fallback file.
 */
export class SchemaTooNewError extends Error {
  readonly code = "storage/schema-too-new";
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number = SCHEMA_VERSION) {
    super(
      `Database schema v${String(foundVersion)} is newer than this Causoryn build supports (v${String(supportedVersion)}); refusing to open it`,
    );
    this.name = "SchemaTooNewError";
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * Reads `PRAGMA user_version` of an existing SQLite file through a read-only
 * connection without creating, migrating or writing anything. Returns
 * `undefined` when the file does not exist.
 */
export function readSqliteUserVersion(dbPath: string): number | undefined {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === "SQLITE_CANTOPEN") {
      return undefined;
    }
    throw error;
  }
  try {
    hardenSqliteConnection(db);
    const raw = db.pragma("user_version", { simple: true });
    const version = validUserVersion(raw);
    if (version === undefined) {
      throw new Error(`Unexpected SQLite user_version: ${String(raw)}`);
    }
    return version;
  } finally {
    db.close();
  }
}

/** Applies the schema when `user_version < SCHEMA_VERSION`; the DDL is fully static. */
export function applySchema(db: Database.Database): void {
  const raw = db.pragma("user_version", { simple: true });
  const version = validUserVersion(raw);
  if (version === undefined) {
    throw new Error(`Unexpected SQLite user_version: ${String(raw)}; refusing to apply the schema`);
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaTooNewError(version, SCHEMA_VERSION);
  }
  if (version === SCHEMA_VERSION) return;
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
        hostname TEXT,
        owner_instance TEXT,
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

    // v3/v4 -> v5: existing build_leases tables gain the nullable lease
    // identity columns (CREATE TABLE IF NOT EXISTS above is a no-op for them).
    const leaseColumns = new Set(
      (
        db.prepare("SELECT name FROM pragma_table_info('build_leases')").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!leaseColumns.has("hostname")) {
      db.exec("ALTER TABLE build_leases ADD COLUMN hostname TEXT;");
    }
    if (!leaseColumns.has("owner_instance")) {
      db.exec("ALTER TABLE build_leases ADD COLUMN owner_instance TEXT;");
    }

    applyWikiSchema(db);
    db.exec("PRAGMA user_version = 5;");
  })();
}
