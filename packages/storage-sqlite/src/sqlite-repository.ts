import Database from "better-sqlite3";

import {
  canonicalJson,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type SnapshotGraph,
} from "@causoryn/domain";
import {
  GraphRepositoryError,
  buildSafeFts5OrQuery,
  buildSymbolFtsDocument,
  deriveBuildId,
  finalizeSnapshotGraph,
  requireNonEmptyField,
  requireTimestamp,
  validateEdgeIdentity,
  validateEdgeShape,
  validateEvidence,
  validateNode,
  type BuildContent,
  type FileRecord,
  type GraphRepository,
  type PublishableState,
  type SnapshotBuildInfo,
  type SnapshotBuildInput,
  type SnapshotMetaInput,
  type SnapshotRead,
  type SymbolIndexEntry,
  type SymbolSearchHit,
  type SymbolSearchStore,
  type WorkspaceLanguageCoverageMeta,
  type WorkspaceRecord,
  type WorkspaceSummaryMeta,
} from "@causoryn/graph";

import {
  currentLeaseHostname,
  evaluateBuildLeaseLiveness,
  PROCESS_LEASE_INSTANCE_ID,
  type BuildLeaseLivenessContext,
} from "./build-lease.js";
import {
  applySchema,
  createPrivateDatabaseFile,
  hardenSqliteConnection,
  SCHEMA_VERSION,
  validUserVersion,
} from "./schema.js";

export { defaultIsPidAlive } from "./build-lease.js";

/**
 * SQLite GraphRepository — GraphRepository sözleşmesinin kalıcı
 * gerçeklemesi (TŞ v2.1 §9, ADR-005/008; sprint-1 görev 5).
 *
 * - Atomik yayımlama (TŞ §9): build satırları `building` durumunda ayrı
 *   işlem/kayıt olarak hazırlanır; publish tek SQLite transaction'dır —
 *   finalize (invariant denetimi; dangling/unknown-evidence-ref dahil) ve
 *   snapshots satırına deterministik kimlik/state UPDATE'i. Herhangi bir
 *   adım başarısız olursa işlem geri alınır: yarım snapshot asla görünmez;
 *   önceki yayın olduğu gibi sorgulanabilir kalır (stale=true bayrağıyla).
 * - Güvenlik: TÜM girdiler hazırlanmış ifade parametreleriyle bağlanır;
 *   SQL metni yalnızca statik sabitlerden oluşur. Workspace salt okunurdur
 *   (ADR-008) — yalnızca izinli data-root altındaki dosyaya yazar.
 * - Okuma yolu "replay" tasarımıdır: satırlar girdi biçiminde okunur ve
 *   domain createSnapshot (finalize) ile yeniden inşa edilir; depodan
 *   dönen her snapshot domain doğrulamasından geçmiş, dondurulmuş ve
 *   canonical düzendedir (bellek ↔ SQLite round-trip eşitliğinin
 *   yapısal garantisi).
 */

interface SnapshotRow {
  sid: number;
  id: string | null;
  build_id: string;
  workspace_id: string;
  revision_id: string;
  revision_sequence: number;
  config_hash: string;
  analyzer_fingerprint: string;
  state: "building" | "ready" | "partial" | "failed";
  created_at: string;
  published_at: string | null;
  failure_reason: string | null;
}

interface NodeRow {
  node_id: string;
  kind: string;
  qualified_name: string;
  language: string | null;
  relative_path: string | null;
  start_line: number | null;
  end_line: number | null;
  source_hash: string | null;
  attributes_json: string;
}

interface EdgeRow {
  edge_id: string;
  from_id: string;
  to_id: string;
  kind: string;
  resolution: string;
  evidence_ids_json: string;
  ambiguity_json: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  kind: string;
  relative_path: string | null;
  start_line: number | null;
  end_line: number | null;
  source_hash: string | null;
  analyzer_id: string;
  analyzer_version: string;
  rationale: string;
}

interface FileRow {
  workspace_id: string;
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  root_path: string;
  created_at: string;
}

interface BuildLeaseRow {
  workspace_id: string;
  build_id: string;
  lease_id: string;
  owner_pid: number;
  host_label: string | null;
  hostname: string | null;
  owner_instance: string | null;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export const ORPHAN_BUILD_FAILURE_REASON = "orphan-build-recovered";

/** Active single-writer build lease metadata stored in `build_leases`. */
export interface BuildLeaseRecord {
  readonly workspaceId: string;
  readonly buildId: string;
  readonly leaseId: string;
  readonly ownerPid: number;
  readonly hostLabel: string | null;
  /** `os.hostname()` of the lease owner (NULL for rows written before schema v5). */
  readonly hostname: string | null;
  /** Per-process owner instance id (NULL for rows written before schema v5). */
  readonly ownerInstance: string | null;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

/**
 * Liveness options shared by `acquireBuildLease` and `recoverOrphanBuilds`.
 * `hostname` / `processInstanceId` identify the CALLER; when the caller
 * acquires, they are also recorded as the new owner's identity.
 */
export interface BuildLeaseLivenessOptions {
  /** Caller hostname (default `os.hostname()`). */
  readonly hostname?: string;
  /** Caller per-process instance id (default: this module's process instance id). */
  readonly processInstanceId?: string;
  /** Optional PID liveness predicate (defaults to `defaultIsPidAlive`). */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Same-process registry probe (see `evaluateBuildLeaseLiveness`). */
  readonly isLocalLeaseActive?: (leaseId: string) => boolean | undefined;
  /** Hard heartbeat staleness ceiling in ms (default 10 minutes). */
  readonly staleCeilingMs?: number;
}

export interface AcquireBuildLeaseInput extends BuildLeaseLivenessOptions {
  readonly workspaceId: string;
  readonly buildId: string;
  readonly leaseId: string;
  readonly ownerPid: number;
  readonly hostLabel?: string;
  readonly nowIso: string;
  readonly ttlMs: number;
}

/** Result of a heartbeat renewal on a dedicated heartbeat connection. */
export type BuildLeaseRenewOutcome = "renewed" | "lost" | "busy";

/**
 * Dedicated, short-busy-timeout SQLite connection used to renew a build lease
 * from a thread that must never block (the MCP main thread renews leases held
 * by its indexing worker thread).
 */
export interface BuildLeaseHeartbeatConnection {
  renew(
    workspaceId: string,
    leaseId: string,
    nowIso: string,
    ttlMs: number,
  ): BuildLeaseRenewOutcome;
  release(workspaceId: string, leaseId: string): void;
  close(): void;
}

export type AcquireBuildLeaseResult =
  | { readonly acquired: true; readonly lease: BuildLeaseRecord }
  | { readonly acquired: false; readonly holder: BuildLeaseRecord };

export interface RecoverOrphanBuildsOptions extends BuildLeaseLivenessOptions {
  readonly nowIso?: string;
}

export interface RecoverOrphanBuildsResult {
  readonly recoveredBuildIds: readonly string[];
  readonly clearedLease: boolean;
}

function mapBuildLeaseRow(row: BuildLeaseRow): BuildLeaseRecord {
  return {
    workspaceId: row.workspace_id,
    buildId: row.build_id,
    leaseId: row.lease_id,
    ownerPid: row.owner_pid,
    hostLabel: row.host_label,
    hostname: row.hostname,
    ownerInstance: row.owner_instance,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function computeExpiresAtIso(nowIso: string, ttlMs: number): string {
  requireTimestamp("nowIso", nowIso);
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new GraphRepositoryError(
      "graph/invalid-limit",
      `ttlMs must be a positive finite number: ${String(ttlMs)}`,
    );
  }
  const baseMs = Date.parse(nowIso);
  return new Date(baseMs + Math.floor(ttlMs)).toISOString();
}

function livenessContextOf(
  nowIso: string,
  options: BuildLeaseLivenessOptions,
): BuildLeaseLivenessContext {
  return {
    nowIso,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.processInstanceId === undefined
      ? {}
      : { processInstanceId: options.processInstanceId }),
    ...(options.isPidAlive === undefined ? {} : { isPidAlive: options.isPidAlive }),
    ...(options.isLocalLeaseActive === undefined
      ? {}
      : { isLocalLeaseActive: options.isLocalLeaseActive }),
    ...(options.staleCeilingMs === undefined
      ? {}
      : { staleCeilingMs: options.staleCeilingMs }),
  };
}

function isLeaseRowAlive(row: BuildLeaseRow, context: BuildLeaseLivenessContext): boolean {
  return evaluateBuildLeaseLiveness(
    {
      leaseId: row.lease_id,
      ownerPid: row.owner_pid,
      hostname: row.hostname,
      ownerInstance: row.owner_instance,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    },
    context,
  ).alive;
}

function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

const DEFAULT_HEARTBEAT_BUSY_TIMEOUT_MS = 50;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonField(field: string, text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GraphRepositoryError(
      "storage/corrupt-row",
      `Could not parse JSON column (${field}): ${errorText(error)}`,
    );
  }
  return parsed as JsonValue;
}

interface FileFactRow {
  workspace_id: string;
  relative_path: string;
  content_hash: string;
  analyzer_fingerprint: string;
  language: string;
  public_interface_hash: string;
  nodes_json: string;
  edges_json: string;
  evidence_json: string;
  imported_paths_json: string;
  updated_at: string;
}

/** Per-file cached analysis fact stored in `file_facts` (schema v4, Task 2.6). */
export interface FileFactRecord {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly analyzerFingerprint: string;
  readonly language: string;
  readonly publicInterfaceHash: string;
  readonly nodesJson: string;
  readonly edgesJson: string;
  readonly evidenceJson: string;
  readonly importedPathsJson: string;
  readonly updatedAt: string;
}

/** Lightweight published snapshot metadata summary (no node/edge/evidence hydration). */
export interface SnapshotMetaSummary {
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly state: PublishableState;
  readonly revisionId: string;
  readonly revisionSequence: number;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly createdAt: string;
  readonly publishedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly evidenceCount: number;
  readonly stale: boolean;
}

/** Retention GC result returned by `pruneOldSnapshots`. */
export interface PruneSnapshotsResult {
  readonly prunedSnapshotSids: number;
  readonly prunedFtsRows: number;
}

export interface PruneSnapshotsOptions {
  readonly checkpointMode?: "PASSIVE" | "TRUNCATE";
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_PUBLISHED_CACHE_ENTRIES = 1;
const DEFAULT_SNAPSHOT_RETENTION_KEEP_COUNT = 2;
const MAX_RETAINED_FAILED_BUILDS = 2;
const SNAPSHOT_ID_PATTERN = /^snapshot:[0-9a-f]{64}$/;

interface CachedPublishedSnapshot {
  readonly id: string;
  readonly dataVersion: number;
  readonly graph: SnapshotGraph;
}

interface CachedWorkspaceSummaryMeta {
  readonly id: string;
  readonly dataVersion: number;
  readonly meta: Omit<WorkspaceSummaryMeta, "stale">;
}

function mapFileFactRow(row: FileFactRow): FileFactRecord {
  return {
    workspaceId: row.workspace_id,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    analyzerFingerprint: row.analyzer_fingerprint,
    language: row.language,
    publicInterfaceHash: row.public_interface_hash,
    nodesJson: row.nodes_json,
    edgesJson: row.edges_json,
    evidenceJson: row.evidence_json,
    importedPathsJson: row.imported_paths_json,
    updatedAt: row.updated_at,
  };
}

function ensureSortedById<T extends { readonly id: string }>(items: T[]): T[] {
  for (let i = 1; i < items.length; i += 1) {
    if ((items[i - 1] as T).id > (items[i] as T).id) {
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      break;
    }
  }
  return items;
}

export class SqliteGraphRepository
  implements GraphRepository, SymbolSearchStore
{
  readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly buildPositions = new Map<
    number,
    { nodes: number; edges: number; evidence: number }
  >();
  private readonly publishedCache = new Map<number, CachedPublishedSnapshot>();
  private readonly summaryMetaCache = new Map<number, CachedWorkspaceSummaryMeta>();
  private buildSerial = 0;

  constructor(dbPath: string) {
    requireNonEmptyField("dbPath", dbPath);
    this.dbPath = dbPath;
    // A new database file is created owner-only (0o600) before SQLite opens it.
    createPrivateDatabaseFile(dbPath);
    this.db = new Database(dbPath);
    try {
      hardenSqliteConnection(this.db);
      this.db.pragma("busy_timeout = 5000");
      // Version checks run before any pragma that could write the file.
      const rawVersion = this.db.pragma("user_version", { simple: true });
      const version = validUserVersion(rawVersion);
      if (version === undefined) {
        throw new GraphRepositoryError(
          "storage/schema-corrupt",
          `Unexpected SQLite user_version: ${String(rawVersion)}; refusing to open ${dbPath}`,
        );
      }
      if (version > SCHEMA_VERSION) {
        // Forward guard: never write a database stamped by a newer schema.
        throw new GraphRepositoryError(
          "storage/schema-too-new",
          `Database schema v${String(version)} is newer than this Causoryn build supports (v${String(SCHEMA_VERSION)}); refusing to open ${dbPath}`,
        );
      }
      // No explicit page_size: 4096 is SQLite's default and is not a security
      // control (see schema.ts header for the corrected CVE notes).
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("temp_store = MEMORY");
      this.db.pragma("cache_size = -16000");
      applySchema(this.db);
      const maxSid = this.db
        .prepare("SELECT COALESCE(MAX(sid), 0) AS max_sid FROM snapshots")
        .get() as { max_sid: number };
      this.buildSerial = maxSid.max_sid;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.buildPositions.clear();
    this.publishedCache.clear();
    this.summaryMetaCache.clear();
    this.db.close();
  }

  /** Default lease owner instance id recorded by this repository's process (thread). */
  get leaseOwnerInstance(): string {
    return PROCESS_LEASE_INSTANCE_ID;
  }

  /**
   * Opens a separate connection to the same database file whose only job is
   * to renew/release one build lease without ever blocking the caller for
   * long: `busy_timeout` is short and a busy database yields `"busy"` (the
   * caller simply retries on its next tick).
   */
  openBuildLeaseHeartbeat(
    options: { readonly busyTimeoutMs?: number } = {},
  ): BuildLeaseHeartbeatConnection {
    const busyTimeoutMs =
      options.busyTimeoutMs !== undefined &&
      Number.isInteger(options.busyTimeoutMs) &&
      options.busyTimeoutMs >= 0
        ? options.busyTimeoutMs
        : DEFAULT_HEARTBEAT_BUSY_TIMEOUT_MS;
    const db = new Database(this.dbPath, { fileMustExist: true });
    try {
      hardenSqliteConnection(db);
      db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
    } catch (error) {
      db.close();
      throw error;
    }
    const renewStmt = db.prepare(
      `UPDATE build_leases
       SET heartbeat_at = ?, expires_at = ?
       WHERE workspace_id = ? AND lease_id = ?`,
    );
    const releaseStmt = db.prepare(
      `DELETE FROM build_leases WHERE workspace_id = ? AND lease_id = ?`,
    );
    let closed = false;
    return {
      renew: (workspaceId, leaseId, nowIso, ttlMs): BuildLeaseRenewOutcome => {
        if (closed) return "lost";
        const nextExpiresAt = computeExpiresAtIso(nowIso, ttlMs);
        try {
          const result = renewStmt.run(nowIso, nextExpiresAt, workspaceId, leaseId);
          return result.changes === 1 ? "renewed" : "lost";
        } catch (error) {
          if (isSqliteBusyError(error)) return "busy";
          throw error;
        }
      },
      release: (workspaceId, leaseId): void => {
        if (closed) return;
        try {
          releaseStmt.run(workspaceId, leaseId);
        } catch (error) {
          if (!isSqliteBusyError(error)) throw error;
        }
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
  }

  private currentDataVersion(): number {
    const version = this.db.pragma("data_version", { simple: true });
    return typeof version === "number" ? version : -1;
  }

  private cachePublished(sid: number, graph: SnapshotGraph): void {
    if (this.publishedCache.has(sid)) {
      this.publishedCache.delete(sid);
    } else if (this.publishedCache.size >= MAX_PUBLISHED_CACHE_ENTRIES) {
      const oldestKey = this.publishedCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.publishedCache.delete(oldestKey);
      }
    }
    this.publishedCache.set(sid, {
      id: graph.meta.id,
      dataVersion: this.currentDataVersion(),
      graph,
    });
  }

  private cacheSummaryMeta(
    sid: number,
    meta: Omit<WorkspaceSummaryMeta, "stale">,
  ): void {
    if (this.summaryMetaCache.has(sid)) {
      this.summaryMetaCache.delete(sid);
    } else if (this.summaryMetaCache.size >= MAX_PUBLISHED_CACHE_ENTRIES) {
      const oldestKey = this.summaryMetaCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.summaryMetaCache.delete(oldestKey);
      }
    }
    this.summaryMetaCache.set(sid, {
      id: meta.snapshotId,
      dataVersion: this.currentDataVersion(),
      meta,
    });
  }

  runInTransaction<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      return fn();
    }
    const tx = this.db.transaction(fn);
    try {
      // BEGIN IMMEDIATE: take the write lock up front. A deferred transaction
      // that reads first and writes later fails with SQLITE_BUSY_SNAPSHOT
      // ("database is locked", no busy wait) whenever another connection --
      // e.g. the main-thread lease heartbeat -- commits in between.
      return tx.immediate();
    } catch (error) {
      // Rollback sonrasında bellek-içi pozisyon önbelleği sıfırlanır.
      this.buildPositions.clear();
      throw error;
    }
  }

  private getBuildPositionCounter(sid: number): {
    nodes: number;
    edges: number;
    evidence: number;
  } {
    let counter = this.buildPositions.get(sid);
    if (counter === undefined) {
      const maxNodes = (
        this.stmt("SELECT COALESCE(MAX(position), 0) AS max_pos FROM nodes WHERE snapshot_sid = ?").get(
          sid,
        ) as { max_pos: number }
      ).max_pos;
      const maxEdges = (
        this.stmt("SELECT COALESCE(MAX(position), 0) AS max_pos FROM edges WHERE snapshot_sid = ?").get(
          sid,
        ) as { max_pos: number }
      ).max_pos;
      const maxEvidence = (
        this.stmt("SELECT COALESCE(MAX(position), 0) AS max_pos FROM evidence WHERE snapshot_sid = ?").get(
          sid,
        ) as { max_pos: number }
      ).max_pos;
      counter = { nodes: maxNodes, edges: maxEdges, evidence: maxEvidence };
      this.buildPositions.set(sid, counter);
    }
    return counter;
  }

  registerWorkspace(record: WorkspaceRecord): void {
    requireNonEmptyField("workspace.id", record.id);
    requireNonEmptyField("workspace.rootPath", record.rootPath);
    // Denetim bulgusu düzeltmesi: memory gerçeklemesiyle aynı sözleşme —
    // ISO çözümlenemeyen zaman damgası kalıcı depoya yazılamaz.
    requireTimestamp("workspace.createdAt", record.createdAt);
    const exists = this.stmt(
      "SELECT 1 AS hit FROM workspaces WHERE id = ? LIMIT 1",
    ).get(record.id);
    if (exists !== undefined) {
      throw new GraphRepositoryError(
        "graph/duplicate-workspace",
        `Workspace is already registered: ${record.id}`,
      );
    }
    this.runWrite(
      "INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)",
      record.id,
      record.rootPath,
      record.createdAt,
    );
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.stmt(
      "SELECT id, root_path, created_at FROM workspaces WHERE id = ? LIMIT 1",
    ).get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Bilinmeyen workspace: ${workspaceId}`,
      );
    }
    return row;
  }

  upsertFile(record: FileRecord): void {
    this.requireWorkspace(record.workspaceId);
    requireNonEmptyField("file.relativePath", record.relativePath);
    requireNonEmptyField("file.contentHash", record.contentHash);
    // Denetim bulgusu düzeltmesi: memory gerçeklemesiyle aynı sözleşme.
    requireTimestamp("file.updatedAt", record.updatedAt);
    if (
      typeof record.sizeBytes !== "number" ||
      !Number.isInteger(record.sizeBytes) ||
      record.sizeBytes < 0
    ) {
      throw new GraphRepositoryError(
        "graph/invalid-file-size",
        `file.sizeBytes must be a non-negative integer: ${String(record.sizeBytes)}`,
      );
    }
    this.runWrite(
      `INSERT INTO files (workspace_id, relative_path, content_hash, size_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`,
      record.workspaceId,
      record.relativePath,
      record.contentHash,
      record.sizeBytes,
      record.updatedAt,
    );
  }

  listFiles(workspaceId: string): readonly FileRecord[] {
    this.requireWorkspace(workspaceId);
    const rows = this.stmt(
      `SELECT workspace_id, relative_path, content_hash, size_bytes, updated_at
       FROM files WHERE workspace_id = ? ORDER BY relative_path`,
    ).all(workspaceId) as FileRow[];
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Güvenlik bulgusu 3: silinen dosyanın files kaydını düşürür. SQL
   * parametreli hazırlanmış ifadedir (kural: dış girdi asla SQL'e
   * birleştirilmez); dönüş kayıt düşürüldü mü bilgisi taşır.
   */
  deleteFile(workspaceId: string, relativePath: string): boolean {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("file.relativePath", relativePath);
    const result = this.runWrite(
      `DELETE FROM files WHERE workspace_id = ? AND relative_path = ?`,
      workspaceId,
      relativePath,
    );
    return result.changes > 0;
  }

  beginBuild(input: SnapshotBuildInput): SnapshotBuildInfo {
    this.requireWorkspace(input.workspaceId);
    requireNonEmptyField("build.revision.id", input.revision.id);
    requireTimestamp("build.createdAt", input.createdAt);
    const active = this.stmt(
      `SELECT sid FROM snapshots
       WHERE workspace_id = ? AND revision_id = ? AND revision_sequence = ?
         AND state = 'building' LIMIT 1`,
    ).get(input.workspaceId, input.revision.id, input.revision.sequence);
    if (active !== undefined) {
      throw new GraphRepositoryError(
        "graph/build-already-active",
        `An active build already exists for the same revision: ${input.workspaceId}#${input.revision.id}@${input.revision.sequence}`,
      );
    }
    this.buildSerial += 1;
    const buildId = deriveBuildId(input, this.buildSerial);
    this.runWrite(
      `INSERT INTO snapshots
         (build_id, workspace_id, revision_id, revision_sequence,
          config_hash, analyzer_fingerprint, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'building', ?)`,
      buildId,
      input.workspaceId,
      input.revision.id,
      input.revision.sequence,
      input.configHash,
      input.analyzerFingerprint,
      input.createdAt,
    );
    const row = this.requireBuildingRow(buildId);
    this.buildPositions.set(row.sid, { nodes: 0, edges: 0, evidence: 0 });
    return this.buildInfo(row, 0, 0, 0);
  }

  getBuild(buildId: string): SnapshotBuildInfo | undefined {
    requireNonEmptyField("buildId", buildId);
    const row = this.stmt(
      `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
              config_hash, analyzer_fingerprint, state, created_at,
              published_at, failure_reason
       FROM snapshots WHERE build_id = ? AND state IN ('building','failed')
       ORDER BY sid DESC LIMIT 1`,
    ).get(buildId) as SnapshotRow | undefined;
    if (row === undefined) return undefined;
    return this.buildInfo(
      row,
      this.countRows("nodes", row.sid),
      this.countRows("edges", row.sid),
      this.countRows("evidence", row.sid),
    );
  }

  addNode(buildId: string, node: GraphNode): void {
    const row = this.requireBuildingRow(buildId);
    // Ortak sözleşme katmanı: tip kataloğu + JSON güvenliği + ID türetimi
    // (validation.ts — bellek içi gerçeklemeyle aynı kod).
    validateNode(row.workspace_id, node);
    const exists = this.stmt(
      "SELECT 1 AS hit FROM nodes WHERE snapshot_sid = ? AND node_id = ? LIMIT 1",
    ).get(row.sid, node.id);
    if (exists !== undefined) {
      throw new GraphRepositoryError(
        "graph/duplicate-node",
        `Node id already exists in this build: ${node.id}`,
      );
    }
    const location = node.location;
    const counter = this.getBuildPositionCounter(row.sid);
    const nextPos = counter.nodes + 1;
    this.runWrite(
      `INSERT INTO nodes
         (snapshot_sid, node_id, kind, qualified_name, language, relative_path,
          start_line, end_line, source_hash, attributes_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.sid,
      node.id,
      node.kind,
      node.qualifiedName,
      node.language ?? null,
      location === undefined ? null : location.relativePath,
      location === undefined ? null : location.startLine,
      location === undefined ? null : location.endLine,
      location === undefined ? null : location.sourceHash,
      canonicalJson(node.attributes as JsonValue),
      nextPos,
    );
    counter.nodes = nextPos;
  }

  addEvidence(buildId: string, evidence: Evidence): void {
    const row = this.requireBuildingRow(buildId);
    validateEvidence(row.workspace_id, evidence);
    // Aynı kimlik aynı içerikten türediği için sessiz dedup güvenlidir.
    const exists = this.stmt(
      "SELECT 1 AS hit FROM evidence WHERE snapshot_sid = ? AND evidence_id = ? LIMIT 1",
    ).get(row.sid, evidence.id);
    if (exists !== undefined) return;
    const span = evidence.span;
    const counter = this.getBuildPositionCounter(row.sid);
    const nextPos = counter.evidence + 1;
    this.runWrite(
      `INSERT INTO evidence
         (snapshot_sid, evidence_id, kind, relative_path, start_line, end_line,
          source_hash, analyzer_id, analyzer_version, rationale, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.sid,
      evidence.id,
      evidence.kind,
      span === undefined ? null : span.relativePath,
      span === undefined ? null : span.startLine,
      span === undefined ? null : span.endLine,
      span === undefined ? null : span.sourceHash,
      evidence.analyzerId,
      evidence.analyzerVersion,
      evidence.rationale,
      nextPos,
    );
    counter.evidence = nextPos;
  }

  addEdge(buildId: string, edge: GraphEdge): void {
    const row = this.requireBuildingRow(buildId);
    validateEdgeShape(edge);
    for (const endpoint of [edge.from, edge.to]) {
      const exists = this.stmt(
        "SELECT 1 AS hit FROM nodes WHERE snapshot_sid = ? AND node_id = ? LIMIT 1",
      ).get(row.sid, endpoint);
      if (exists === undefined) {
        const missing = endpoint === edge.from ? "from" : "to";
        throw new GraphRepositoryError(
          "graph/dangling-edge",
          `Edge endpoint points to an unknown node (${missing}): ${endpoint}`,
        );
      }
    }
    validateEdgeIdentity(row.workspace_id, edge);
    const exists = this.stmt(
      "SELECT 1 AS hit FROM edges WHERE snapshot_sid = ? AND edge_id = ? LIMIT 1",
    ).get(row.sid, edge.id);
    if (exists !== undefined) {
      throw new GraphRepositoryError(
        "graph/duplicate-edge",
        `Edge id already exists in this build: ${edge.id}`,
      );
    }
    const ambiguityJson =
      edge.ambiguity === undefined
        ? null
        : canonicalJson({
            candidates: [...edge.ambiguity.candidates],
            reason: edge.ambiguity.reason,
          });
    const evidenceIdsJson = canonicalJson([...edge.evidenceIds]);
    const counter = this.getBuildPositionCounter(row.sid);
    const nextPos = counter.edges + 1;
    this.runWrite(
      `INSERT INTO edges
         (snapshot_sid, edge_id, from_id, to_id, kind, resolution,
          evidence_ids_json, ambiguity_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.sid,
      edge.id,
      edge.from,
      edge.to,
      edge.kind,
      edge.resolution,
      evidenceIdsJson,
      ambiguityJson,
      nextPos,
    );
    counter.edges = nextPos;
  }

  publish(
    buildId: string,
    state: PublishableState,
    publishedAt: string,
  ): SnapshotGraph {
    requireNonEmptyField("buildId", buildId);
    requireTimestamp("publishedAt", publishedAt);
    let prunedDuringPublish = false;
    const publishTx = this.db.transaction((): SnapshotGraph => {
      const row = this.requireBuildingRow(buildId);
      const content = this.readBuildContent(row.sid);
      // İnvariant denetimi (dangling/unknown-evidence-ref dahil) +
      // deterministik ID + derin dondurma; hata durumunda transaction
      // geri alınır, depo değişmez.
      const graph = finalizeSnapshotGraph(this.metaOf(row, state), content);
      const result = this.stmt(
        `UPDATE snapshots SET id = ?, state = ?, published_at = ?
         WHERE sid = ? AND state = 'building'`,
      ).run(graph.meta.id, state, publishedAt, row.sid);
      if (result.changes !== 1) {
        throw new GraphRepositoryError(
          "graph/build-not-active",
          `No active build: ${buildId}`,
        );
      }
      this.stmt(
        `DELETE FROM build_leases WHERE workspace_id = ? AND build_id = ?`,
      ).run(row.workspace_id, buildId);
      this.buildPositions.delete(row.sid);
      const pruned = this.pruneOldSnapshotsLocked(
        row.workspace_id,
        DEFAULT_SNAPSHOT_RETENTION_KEEP_COUNT,
      );
      prunedDuringPublish =
        pruned.prunedSnapshotSids > 0 || pruned.prunedFtsRows > 0;
      this.cachePublished(row.sid, graph);
      return graph;
    });
    let publishedGraph: SnapshotGraph;
    try {
      // IMMEDIATE: publish reads the whole build before its UPDATE; holding
      // the write lock from BEGIN prevents a concurrent commit (lease
      // heartbeat, peer) from invalidating that read snapshot.
      publishedGraph = publishTx.immediate();
    } catch (error) {
      if (error instanceof GraphRepositoryError) throw error;
      // SQLite hatası (ör. aynı deterministik kimliğe çakışan UNIQUE
      // kısıtı): transaction zaten geri alındı; yarım durum yoktur.
      throw new GraphRepositoryError(
        "graph/publish-failed",
        `Publish failed; the store was not changed: ${errorText(error)}`,
      );
    }
    if (prunedDuringPublish && !this.db.inTransaction) {
      this.runWalCheckpoint("PASSIVE");
    }
    return publishedGraph;
  }

  failBuild(buildId: string, reason: string): void {
    requireNonEmptyField("buildId", buildId);
    requireNonEmptyField("reason", reason);
    const runFail = (): void => {
      const existing = this.stmt(
        `SELECT sid, workspace_id FROM snapshots WHERE build_id = ? AND state = 'building' LIMIT 1`,
      ).get(buildId) as { sid: number; workspace_id: string } | undefined;
      const result = this.runWrite(
        `UPDATE snapshots SET state = 'failed', failure_reason = ?
         WHERE build_id = ? AND state = 'building'`,
        reason,
        buildId,
      );
      if (result.changes === 0) {
        throw new GraphRepositoryError(
          "graph/build-not-active",
          `No active build: ${buildId}`,
        );
      }
      if (existing !== undefined) {
        this.runWrite(
          `DELETE FROM build_leases WHERE workspace_id = ? AND build_id = ?`,
          existing.workspace_id,
          buildId,
        );
        this.buildPositions.delete(existing.sid);
      }
    };
    if (this.db.inTransaction) {
      runFail();
    } else {
      this.db.transaction(runFail).immediate();
    }
  }

  /**
   * Acquires the single-writer build lease for `workspaceId` atomically via
   * `BEGIN IMMEDIATE`. If an existing lease is expired or owned by a confirmed-dead
   * PID, it is replaced atomically; if held by a live peer, returns `{ acquired: false, holder }`.
   */
  acquireBuildLease(input: AcquireBuildLeaseInput): AcquireBuildLeaseResult {
    this.requireWorkspace(input.workspaceId);
    requireNonEmptyField("buildId", input.buildId);
    requireNonEmptyField("leaseId", input.leaseId);
    if (!Number.isInteger(input.ownerPid) || input.ownerPid <= 0) {
      throw new GraphRepositoryError(
        "graph/invalid-limit",
        `ownerPid must be a positive integer: ${String(input.ownerPid)}`,
      );
    }
    const expiresAt = computeExpiresAtIso(input.nowIso, input.ttlMs);
    const hostLabel =
      input.hostLabel !== undefined && input.hostLabel.trim().length > 0
        ? input.hostLabel.trim()
        : null;
    const hostname =
      input.hostname !== undefined && input.hostname.trim().length > 0
        ? input.hostname.trim()
        : currentLeaseHostname();
    const ownerInstance = input.processInstanceId ?? PROCESS_LEASE_INSTANCE_ID;
    const livenessContext = livenessContextOf(input.nowIso, {
      ...input,
      hostname,
      processInstanceId: ownerInstance,
    });

    const execute = (): AcquireBuildLeaseResult => {
      const existing = this.stmt(
        `SELECT workspace_id, build_id, lease_id, owner_pid, host_label,
                hostname, owner_instance, acquired_at, heartbeat_at, expires_at
         FROM build_leases WHERE workspace_id = ? LIMIT 1`,
      ).get(input.workspaceId) as BuildLeaseRow | undefined;

      if (existing !== undefined) {
        if (isLeaseRowAlive(existing, livenessContext)) {
          return { acquired: false, holder: mapBuildLeaseRow(existing) };
        }
        this.runWrite(
          `DELETE FROM build_leases WHERE workspace_id = ?`,
          input.workspaceId,
        );
      }

      this.runWrite(
        `INSERT INTO build_leases
           (workspace_id, build_id, lease_id, owner_pid, host_label,
            hostname, owner_instance, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.workspaceId,
        input.buildId,
        input.leaseId,
        input.ownerPid,
        hostLabel,
        hostname,
        ownerInstance,
        input.nowIso,
        input.nowIso,
        expiresAt,
      );

      return {
        acquired: true,
        lease: {
          workspaceId: input.workspaceId,
          buildId: input.buildId,
          leaseId: input.leaseId,
          ownerPid: input.ownerPid,
          hostLabel,
          hostname,
          ownerInstance,
          acquiredAt: input.nowIso,
          heartbeatAt: input.nowIso,
          expiresAt,
        },
      };
    };

    return this.db.inTransaction
      ? execute()
      : this.db.transaction(execute).immediate();
  }

  /** Runs `fn` inside a `BEGIN IMMEDIATE` SQLite transaction (reentrant if already in transaction). */
  withImmediateTransaction<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn).immediate();
  }

  /** Updates the `build_id` bound to an already-acquired lease row. */
  bindBuildLeaseBuildId(
    workspaceId: string,
    leaseId: string,
    buildId: string,
  ): boolean {
    requireNonEmptyField("workspaceId", workspaceId);
    requireNonEmptyField("leaseId", leaseId);
    requireNonEmptyField("buildId", buildId);
    const result = this.runWrite(
      `UPDATE build_leases SET build_id = ? WHERE workspace_id = ? AND lease_id = ?`,
      buildId,
      workspaceId,
      leaseId,
    );
    return result.changes === 1;
  }

  /** Renews heartbeat and expiration timestamp for an active lease owned by `leaseId`. */
  renewBuildLease(
    workspaceId: string,
    leaseId: string,
    nowIso: string,
    ttlMs: number,
  ): boolean {
    requireNonEmptyField("workspaceId", workspaceId);
    requireNonEmptyField("leaseId", leaseId);
    const nextExpiresAt = computeExpiresAtIso(nowIso, ttlMs);
    const result = this.runWrite(
      `UPDATE build_leases
       SET heartbeat_at = ?, expires_at = ?
       WHERE workspace_id = ? AND lease_id = ?`,
      nowIso,
      nextExpiresAt,
      workspaceId,
      leaseId,
    );
    return result.changes === 1;
  }

  /** Idempotently releases a lease row owned by `leaseId`. */
  releaseBuildLease(workspaceId: string, leaseId: string): void {
    requireNonEmptyField("workspaceId", workspaceId);
    requireNonEmptyField("leaseId", leaseId);
    this.runWrite(
      `DELETE FROM build_leases WHERE workspace_id = ? AND lease_id = ?`,
      workspaceId,
      leaseId,
    );
  }

  /** Returns the current lease row for `workspaceId`, if any. */
  getActiveBuildLease(workspaceId: string): BuildLeaseRecord | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    const row = this.stmt(
      `SELECT workspace_id, build_id, lease_id, owner_pid, host_label,
              hostname, owner_instance, acquired_at, heartbeat_at, expires_at
       FROM build_leases WHERE workspace_id = ? LIMIT 1`,
    ).get(workspaceId) as BuildLeaseRow | undefined;
    return row === undefined ? undefined : mapBuildLeaseRow(row);
  }

  /**
   * Atomically recovers orphaned `building` snapshot rows and expired/dead-PID
   * build leases for `workspaceId`:
   * - A `building` row is orphaned if:
   *   (i) no lease row exists for `workspaceId` (e.g., legacy v0.2.4 crash), OR
   *   (ii) the lease holder is dead under the liveness rule of
   *        `evaluateBuildLeaseLiveness` (dead PID on this host, expired TTL for
   *        a foreign/unknown host, PID reuse, stale heartbeat ceiling, ...), OR
   *   (iii) the live lease belongs to a different `build_id`.
   * - Orphan `building` rows are transitioned to `state = 'failed'`,
   *   `failure_reason = 'orphan-build-recovered'`, and dead lease rows are deleted.
   */
  recoverOrphanBuilds(
    workspaceId: string,
    options: RecoverOrphanBuildsOptions = {},
  ): RecoverOrphanBuildsResult {
    requireNonEmptyField("workspaceId", workspaceId);
    const nowIso = options.nowIso ?? new Date().toISOString();
    requireTimestamp("nowIso", nowIso);
    const livenessContext = livenessContextOf(nowIso, options);

    const execute = (): RecoverOrphanBuildsResult => {
      const lease = this.stmt(
        `SELECT workspace_id, build_id, lease_id, owner_pid, host_label,
                hostname, owner_instance, acquired_at, heartbeat_at, expires_at
         FROM build_leases WHERE workspace_id = ? LIMIT 1`,
      ).get(workspaceId) as BuildLeaseRow | undefined;

      const leaseIsLive =
        lease !== undefined && isLeaseRowAlive(lease, livenessContext);

      const buildingRows = this.stmt(
        `SELECT sid, build_id FROM snapshots
         WHERE workspace_id = ? AND state = 'building'
         ORDER BY sid ASC`,
      ).all(workspaceId) as Array<{ sid: number; build_id: string }>;

      const recoveredBuildIds: string[] = [];
      for (const row of buildingRows) {
        const ownedByLiveLease =
          lease !== undefined && leaseIsLive && lease.build_id === row.build_id;
        if (ownedByLiveLease) {
          continue;
        }
        const updated = this.runWrite(
          `UPDATE snapshots SET state = 'failed', failure_reason = ?
           WHERE sid = ? AND state = 'building'`,
          ORPHAN_BUILD_FAILURE_REASON,
          row.sid,
        );
        if (updated.changes > 0) {
          this.buildPositions.delete(row.sid);
          recoveredBuildIds.push(row.build_id);
        }
      }

      let clearedLease = false;
      if (lease !== undefined && !leaseIsLive) {
        const deleted = this.runWrite(
          `DELETE FROM build_leases WHERE workspace_id = ? AND lease_id = ?`,
          workspaceId,
          lease.lease_id,
        );
        clearedLease = deleted.changes > 0;
      }

      return { recoveredBuildIds, clearedLease };
    };

    return this.db.inTransaction
      ? execute()
      : this.db.transaction(execute).immediate();
  }

  private runInReadTransaction<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn)();
  }

  getSnapshot(snapshotId: string): SnapshotRead | undefined {
    requireNonEmptyField("snapshotId", snapshotId);
    return this.runInReadTransaction(() => {
      const row = this.stmt(
        `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
                config_hash, analyzer_fingerprint, state, created_at,
                published_at, failure_reason
         FROM snapshots WHERE id = ? AND state IN ('ready','partial') LIMIT 1`,
      ).get(snapshotId) as SnapshotRow | undefined;
      if (row === undefined) return undefined;
      return {
        snapshot: this.reconstructPublished(row),
        stale: this.isStale(row),
      };
    });
  }

  getLatestPublished(workspaceId: string): SnapshotRead | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    return this.runInReadTransaction(() => {
      const row = this.stmt(
        `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
                config_hash, analyzer_fingerprint, state, created_at,
                published_at, failure_reason
         FROM snapshots
         WHERE workspace_id = ? AND state IN ('ready','partial')
         ORDER BY revision_sequence DESC, published_at DESC, sid DESC
         LIMIT 1`,
      ).get(workspaceId) as SnapshotRow | undefined;
      if (row === undefined) return undefined;
      return {
        snapshot: this.reconstructPublished(row),
        stale: this.isStale(row),
      };
    });
  }

  /**
   * Lightweight metadata query for the newest published snapshot of `workspaceId`.
   * Reads ONLY the `snapshots` metadata row + `COUNT(*)` over `nodes`/`edges`/`evidence`
   * without hydrating graph rows into memory (Task 2.4b instant warm boot).
   */
  getLatestSnapshotMeta(workspaceId: string): SnapshotMetaSummary | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    return this.runInReadTransaction(() => {
      const row = this.stmt(
        `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
                config_hash, analyzer_fingerprint, state, created_at,
                published_at, failure_reason
         FROM snapshots
         WHERE workspace_id = ? AND state IN ('ready','partial')
         ORDER BY revision_sequence DESC, published_at DESC, sid DESC
         LIMIT 1`,
      ).get(workspaceId) as SnapshotRow | undefined;
      if (row === undefined || row.id === null) return undefined;
      if (row.state !== "ready" && row.state !== "partial") return undefined;
      return {
        snapshotId: row.id,
        workspaceId: row.workspace_id,
        state: row.state,
        revisionId: row.revision_id,
        revisionSequence: row.revision_sequence,
        configHash: row.config_hash,
        analyzerFingerprint: row.analyzer_fingerprint,
        createdAt: row.created_at,
        publishedAt: row.published_at ?? row.created_at,
        nodeCount: this.countRows("nodes", row.sid),
        edgeCount: this.countRows("edges", row.sid),
        evidenceCount: this.countRows("evidence", row.sid),
        stale: this.isStale(row),
      };
    });
  }

  /**
   * Zero-hydration workspace summary aggregation inside a single deferred WAL MVCC
   * read transaction. Computes counts, languages, entrypoints, frameworks, edge
   * breakdowns, and per-language coverage directly via SQLite aggregates without
   * hydrating nodes, edges, or evidence rows into JS memory.
   */
  getLatestWorkspaceSummaryMeta(
    workspaceId: string,
  ): WorkspaceSummaryMeta | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    return this.runInReadTransaction(() => {
      const row = this.stmt(
        `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
                config_hash, analyzer_fingerprint, state, created_at,
                published_at, failure_reason
         FROM snapshots
         WHERE workspace_id = ? AND state IN ('ready','partial')
         ORDER BY revision_sequence DESC, published_at DESC, sid DESC
         LIMIT 1`,
      ).get(workspaceId) as SnapshotRow | undefined;
      if (row === undefined || row.id === null) return undefined;
      if (row.state !== "ready" && row.state !== "partial") return undefined;

      const stale = this.isStale(row);
      const cached = this.summaryMetaCache.get(row.sid);
      if (
        cached !== undefined &&
        cached.id === row.id &&
        cached.dataVersion === this.currentDataVersion()
      ) {
        return { ...cached.meta, stale };
      }

      const evidenceCount = this.countRows("evidence", row.sid);

      interface NodeLangAggRow {
        lang: string;
        total_cnt: number;
        file_cnt: number;
        has_non_file_symbols: number;
      }
      const nodeLangRows = this.stmt(
        `SELECT COALESCE(language, '') AS lang,
                COUNT(*) AS total_cnt,
                SUM(CASE WHEN kind = 'File' THEN 1 ELSE 0 END) AS file_cnt,
                MAX(CASE WHEN kind NOT IN ('File', 'Workspace', 'UnknownExternal') THEN 1 ELSE 0 END) AS has_non_file_symbols
         FROM nodes
         WHERE snapshot_sid = ?
         GROUP BY COALESCE(language, '')`,
      ).all(row.sid) as NodeLangAggRow[];

      interface MutableLangBucket {
        files: number;
        hasNonFileSymbols: boolean;
        hasSemanticEdges: boolean;
        verifiedEdges: number;
        heuristicEdges: number;
        unresolvedEdges: number;
      }
      const langBuckets = new Map<string, MutableLangBucket>();
      const ensureBucket = (lang: string): MutableLangBucket => {
        let bucket = langBuckets.get(lang);
        if (bucket === undefined) {
          bucket = {
            files: 0,
            hasNonFileSymbols: false,
            hasSemanticEdges: false,
            verifiedEdges: 0,
            heuristicEdges: 0,
            unresolvedEdges: 0,
          };
          langBuckets.set(lang, bucket);
        }
        return bucket;
      };

      let nodeCount = 0;
      let fileCount = 0;
      let majorLang: string | undefined;
      let majorLangNodeCount = -1;
      for (const nodeAgg of nodeLangRows) {
        nodeCount += nodeAgg.total_cnt;
        fileCount += nodeAgg.file_cnt;
        if (nodeAgg.lang.length > 0) {
          const bucket = ensureBucket(nodeAgg.lang);
          bucket.files += nodeAgg.file_cnt;
          if (nodeAgg.has_non_file_symbols === 1) {
            bucket.hasNonFileSymbols = true;
          }
          if (
            nodeAgg.total_cnt > majorLangNodeCount ||
            (nodeAgg.total_cnt === majorLangNodeCount &&
              majorLang !== undefined &&
              nodeAgg.lang < majorLang)
          ) {
            majorLang = nodeAgg.lang;
            majorLangNodeCount = nodeAgg.total_cnt;
          }
        }
      }

      interface EntrypointRow {
        qualified_name: string;
        kind: string;
        attributes_json: string;
      }
      const entrypointRows = this.stmt(
        `SELECT qualified_name, kind, attributes_json
         FROM nodes
         WHERE snapshot_sid = ? AND kind IN ('Endpoint', 'Handler')
         ORDER BY qualified_name ASC`,
      ).all(row.sid) as EntrypointRow[];

      const entrypoints: string[] = [];
      const frameworkSet = new Set<string>();
      for (const ep of entrypointRows) {
        entrypoints.push(ep.qualified_name);
        if (ep.kind === "Endpoint") {
          const parsed = parseJsonField(
            `nodes.attributes_json:${ep.qualified_name}`,
            ep.attributes_json,
          );
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const fw = (parsed as Record<string, unknown>).framework;
            if (typeof fw === "string") {
              frameworkSet.add(fw);
            }
          }
        }
      }
      entrypoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const frameworks = [...frameworkSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      interface EdgeKindAggRow {
        kind: string;
        verified_cnt: number;
        heuristic_cnt: number;
        unresolved_cnt: number;
      }
      const edgeKindRows = this.stmt(
        `SELECT kind,
                SUM(CASE WHEN resolution = 'verified' THEN 1 ELSE 0 END) AS verified_cnt,
                SUM(CASE WHEN resolution = 'heuristic' THEN 1 ELSE 0 END) AS heuristic_cnt,
                SUM(CASE WHEN resolution NOT IN ('verified', 'heuristic') THEN 1 ELSE 0 END) AS unresolved_cnt
         FROM edges
         WHERE snapshot_sid = ?
         GROUP BY kind
         ORDER BY kind ASC`,
      ).all(row.sid) as EdgeKindAggRow[];

      const edgeKindCounts = new Map<string, number>();
      let verified = 0;
      let heuristic = 0;
      let unresolved = 0;
      for (const edgeAgg of edgeKindRows) {
        const kindTotal =
          edgeAgg.verified_cnt + edgeAgg.heuristic_cnt + edgeAgg.unresolved_cnt;
        edgeKindCounts.set(edgeAgg.kind, kindTotal);
        verified += edgeAgg.verified_cnt;
        heuristic += edgeAgg.heuristic_cnt;
        unresolved += edgeAgg.unresolved_cnt;
      }
      const edgeCount = verified + heuristic + unresolved;
      const edgesByKind: Record<string, number> = {};
      for (const kind of [...edgeKindCounts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        edgesByKind[kind] = edgeKindCounts.get(kind) ?? 0;
      }

      // Per-language edge breakdown via majority-language complement:
      // Every edge with `fn.language = majorLang AND fn.kind != 'Workspace'` is guaranteed
      // to resolve to `majorLang` (and is never `Workspace --CONTAINS--> *`), so we only join
      // the complement (`fn.language IS NULL OR fn.language != majorLang OR fn.kind = 'Workspace'`)
      // using `idx_edges_snapshot_from`, and derive the majority bucket by exact subtraction.
      if (edgeCount > 0 && majorLang !== undefined) {
        interface NonMajorEdgeAggRow {
          edge_kind: string;
          resolution: string;
          lang: string;
          cnt: number;
        }
        const nonMajorRows = this.stmt(
          `SELECT e.kind AS edge_kind,
                  e.resolution AS resolution,
                  CASE
                    WHEN fn.kind = 'Workspace' AND e.kind = 'CONTAINS' THEN ''
                    ELSE COALESCE(NULLIF(fn.language, ''), NULLIF(tn.language, ''), '')
                  END AS lang,
                  COUNT(*) AS cnt
           FROM nodes fn
           CROSS JOIN edges e INDEXED BY idx_edges_snapshot_from
             ON e.snapshot_sid = fn.snapshot_sid AND e.from_id = fn.node_id
           LEFT JOIN nodes tn
             ON (fn.language IS NULL OR fn.language = '')
             AND NOT (fn.kind = 'Workspace' AND e.kind = 'CONTAINS')
             AND tn.snapshot_sid = e.snapshot_sid AND tn.node_id = e.to_id
           WHERE fn.snapshot_sid = ?
             AND (fn.language IS NULL OR fn.language != ? OR fn.kind = 'Workspace')
           GROUP BY e.kind, e.resolution, lang`,
        ).all(row.sid, majorLang) as NonMajorEdgeAggRow[];

        const nonMajorByKind = new Map<
          string,
          { verified: number; heuristic: number; unresolved: number }
        >();
        for (const item of nonMajorRows) {
          let kindTotals = nonMajorByKind.get(item.edge_kind);
          if (kindTotals === undefined) {
            kindTotals = { verified: 0, heuristic: 0, unresolved: 0 };
            nonMajorByKind.set(item.edge_kind, kindTotals);
          }
          if (item.resolution === "verified") {
            kindTotals.verified += item.cnt;
          } else if (item.resolution === "heuristic") {
            kindTotals.heuristic += item.cnt;
          } else {
            kindTotals.unresolved += item.cnt;
          }

          if (item.lang.length > 0) {
            const bucket = ensureBucket(item.lang);
            if (item.edge_kind !== "CONTAINS") {
              bucket.hasSemanticEdges = true;
            }
            if (item.resolution === "verified") {
              bucket.verifiedEdges += item.cnt;
            } else if (item.resolution === "heuristic") {
              bucket.heuristicEdges += item.cnt;
            } else {
              bucket.unresolvedEdges += item.cnt;
            }
          }
        }

        const majorBucket = ensureBucket(majorLang);
        for (const edgeAgg of edgeKindRows) {
          const excluded = nonMajorByKind.get(edgeAgg.kind);
          const remVerified = Math.max(
            0,
            edgeAgg.verified_cnt - (excluded?.verified ?? 0),
          );
          const remHeuristic = Math.max(
            0,
            edgeAgg.heuristic_cnt - (excluded?.heuristic ?? 0),
          );
          const remUnresolved = Math.max(
            0,
            edgeAgg.unresolved_cnt - (excluded?.unresolved ?? 0),
          );
          majorBucket.verifiedEdges += remVerified;
          majorBucket.heuristicEdges += remHeuristic;
          majorBucket.unresolvedEdges += remUnresolved;
          if (
            edgeAgg.kind !== "CONTAINS" &&
            remVerified + remHeuristic + remUnresolved > 0
          ) {
            majorBucket.hasSemanticEdges = true;
          }
        }
      }

      const sortedLangs = [...langBuckets.keys()].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const languages: Array<{ readonly language: string; readonly files: number }> = [];
      const languageCoverage: WorkspaceLanguageCoverageMeta[] = [];
      for (const lang of sortedLangs) {
        const bucket = langBuckets.get(lang)!;
        if (bucket.files > 0) {
          languages.push({ language: lang, files: bucket.files });
        }
        languageCoverage.push({
          language: lang,
          files: bucket.files,
          hasNonFileSymbols: bucket.hasNonFileSymbols,
          hasSemanticEdges: bucket.hasSemanticEdges,
          verifiedEdges: bucket.verifiedEdges,
          heuristicEdges: bucket.heuristicEdges,
          unresolvedEdges: bucket.unresolvedEdges,
        });
      }

      const immutableMeta: Omit<WorkspaceSummaryMeta, "stale"> = {
        snapshotId: row.id,
        workspaceId: row.workspace_id,
        state: row.state,
        revisionId: row.revision_id,
        revisionSequence: row.revision_sequence,
        nodeCount,
        edgeCount,
        evidenceCount,
        fileCount,
        languages,
        frameworks,
        entrypoints,
        edgesByKind,
        resolutions: {
          verified,
          heuristic,
          unresolved,
        },
        languageCoverage,
      };
      this.cacheSummaryMeta(row.sid, immutableMeta);
      return { ...immutableMeta, stale };
    });
  }

  /**
   * Retention GC (Task 2.4b): retains only the newest `keepCount` (default 2)
   * published snapshots + last 2 failed builds for `workspaceId`, deletes orphaned
   * `symbol_fts` rows, and runs a safe WAL checkpoint outside the transaction.
   */
  pruneOldSnapshots(
    workspaceId: string,
    keepCount = DEFAULT_SNAPSHOT_RETENTION_KEEP_COUNT,
    options: PruneSnapshotsOptions = {},
  ): PruneSnapshotsResult {
    requireNonEmptyField("workspaceId", workspaceId);
    if (!Number.isInteger(keepCount) || keepCount < 1) {
      throw new GraphRepositoryError(
        "graph/invalid-limit",
        `keepCount must be a positive integer: ${String(keepCount)}`,
      );
    }
    const result = this.db.inTransaction
      ? this.pruneOldSnapshotsLocked(workspaceId, keepCount)
      : this.db
          .transaction(() => this.pruneOldSnapshotsLocked(workspaceId, keepCount))
          .immediate();
    if (
      !this.db.inTransaction &&
      (result.prunedSnapshotSids > 0 || result.prunedFtsRows > 0)
    ) {
      this.runWalCheckpoint(options.checkpointMode ?? "PASSIVE");
    }
    return result;
  }

  private pruneOldSnapshotsLocked(
    workspaceId: string,
    keepCount: number,
  ): PruneSnapshotsResult {
    const publishedSids = (
      this.stmt(
        `SELECT sid FROM snapshots
         WHERE workspace_id = ? AND state IN ('ready','partial')
         ORDER BY revision_sequence DESC, published_at DESC, sid DESC`,
      ).all(workspaceId) as Array<{ sid: number }>
    ).map((r) => r.sid);

    const failedSids = (
      this.stmt(
        `SELECT sid FROM snapshots
         WHERE workspace_id = ? AND state = 'failed'
         ORDER BY sid DESC`,
      ).all(workspaceId) as Array<{ sid: number }>
    ).map((r) => r.sid);

    const sidsToDelete = [
      ...publishedSids.slice(keepCount),
      ...failedSids.slice(MAX_RETAINED_FAILED_BUILDS),
    ];

    let prunedSnapshotSids = 0;
    const deleteSnapStmt = this.stmt(`DELETE FROM snapshots WHERE sid = ?`);
    for (const sid of sidsToDelete) {
      const deleted = deleteSnapStmt.run(sid);
      prunedSnapshotSids += deleted.changes;
      this.publishedCache.delete(sid);
      this.summaryMetaCache.delete(sid);
      this.buildPositions.delete(sid);
    }

    const ftsDeleted = this.stmt(
      `DELETE FROM symbol_fts
       WHERE snapshot_sid NOT IN (SELECT sid FROM snapshots)`,
    ).run();

    return {
      prunedSnapshotSids,
      prunedFtsRows: ftsDeleted.changes,
    };
  }

  private runWalCheckpoint(mode: "PASSIVE" | "TRUNCATE"): void {
    try {
      this.db.pragma(
        mode === "TRUNCATE"
          ? "wal_checkpoint(TRUNCATE)"
          : "wal_checkpoint(PASSIVE)",
      );
    } catch {
      // Best-effort WAL checkpoint: concurrent readers may defer truncation safely.
    }
  }

  /* ---------------------------------------------------------------- */
  /* Per-file incremental analysis facts (schema v4, Task 2.6)        */
  /* ---------------------------------------------------------------- */

  upsertFileFact(record: FileFactRecord): void {
    this.requireWorkspace(record.workspaceId);
    requireNonEmptyField("fileFact.relativePath", record.relativePath);
    requireNonEmptyField("fileFact.contentHash", record.contentHash);
    requireNonEmptyField("fileFact.analyzerFingerprint", record.analyzerFingerprint);
    requireNonEmptyField("fileFact.language", record.language);
    requireNonEmptyField("fileFact.publicInterfaceHash", record.publicInterfaceHash);
    requireTimestamp("fileFact.updatedAt", record.updatedAt);
    this.runWrite(
      `INSERT INTO file_facts (
         workspace_id, relative_path, content_hash, analyzer_fingerprint,
         language, public_interface_hash, nodes_json, edges_json,
         evidence_json, imported_paths_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         analyzer_fingerprint = excluded.analyzer_fingerprint,
         language = excluded.language,
         public_interface_hash = excluded.public_interface_hash,
         nodes_json = excluded.nodes_json,
         edges_json = excluded.edges_json,
         evidence_json = excluded.evidence_json,
         imported_paths_json = excluded.imported_paths_json,
         updated_at = excluded.updated_at`,
      record.workspaceId,
      record.relativePath,
      record.contentHash,
      record.analyzerFingerprint,
      record.language,
      record.publicInterfaceHash,
      record.nodesJson,
      record.edgesJson,
      record.evidenceJson,
      record.importedPathsJson,
      record.updatedAt,
    );
  }

  upsertFileFacts(records: readonly FileFactRecord[]): void {
    if (records.length === 0) return;
    this.runInTransaction(() => {
      for (const record of records) {
        this.upsertFileFact(record);
      }
    });
  }

  listFileFacts(
    workspaceId: string,
    analyzerFingerprint?: string,
  ): readonly FileFactRecord[] {
    this.requireWorkspace(workspaceId);
    const rows =
      analyzerFingerprint !== undefined
        ? (this.stmt(
            `SELECT workspace_id, relative_path, content_hash, analyzer_fingerprint,
                    language, public_interface_hash, nodes_json, edges_json,
                    evidence_json, imported_paths_json, updated_at
             FROM file_facts
             WHERE workspace_id = ? AND analyzer_fingerprint = ?
             ORDER BY relative_path ASC`,
          ).all(workspaceId, analyzerFingerprint) as FileFactRow[])
        : (this.stmt(
            `SELECT workspace_id, relative_path, content_hash, analyzer_fingerprint,
                    language, public_interface_hash, nodes_json, edges_json,
                    evidence_json, imported_paths_json, updated_at
             FROM file_facts
             WHERE workspace_id = ?
             ORDER BY relative_path ASC`,
          ).all(workspaceId) as FileFactRow[]);
    return rows.map(mapFileFactRow);
  }

  deleteFileFact(workspaceId: string, relativePath: string): boolean {
    this.requireWorkspace(workspaceId);
    requireNonEmptyField("fileFact.relativePath", relativePath);
    const result = this.runWrite(
      `DELETE FROM file_facts WHERE workspace_id = ? AND relative_path = ?`,
      workspaceId,
      relativePath,
    );
    return result.changes > 0;
  }

  clearFileFacts(workspaceId: string): number {
    this.requireWorkspace(workspaceId);
    const result = this.runWrite(
      `DELETE FROM file_facts WHERE workspace_id = ?`,
      workspaceId,
    );
    return result.changes;
  }

  indexSymbols(snapshotId: string, entries: readonly SymbolIndexEntry[]): void {
    requireNonEmptyField("snapshotId", snapshotId);
    const row = this.stmt(
      `SELECT sid FROM snapshots WHERE id = ? OR build_id = ?
       ORDER BY sid DESC LIMIT 1`,
    ).get(snapshotId, snapshotId) as { sid: number } | undefined;
    if (row === undefined) {
      throw new GraphRepositoryError(
        "graph/unknown-snapshot",
        `Snapshot or build id not found: ${snapshotId}`,
      );
    }
    for (const entry of entries) {
      requireNonEmptyField("entry.symbol", entry.symbol);
      requireNonEmptyField("entry.nodeId", entry.nodeId);
    }
    const insertTx = this.db.transaction(
      (sid: number, items: readonly SymbolIndexEntry[]): void => {
        const insertStmt = this.stmt(
          "INSERT INTO symbol_fts (symbol, search_text, node_id, snapshot_sid) VALUES (?, ?, ?, ?)",
        );
        for (const entry of items) {
          const searchText = buildSymbolFtsDocument(
            entry.symbol,
            entry.relativePath,
          );
          insertStmt.run(entry.symbol, searchText, entry.nodeId, sid);
        }
      },
    );
    try {
      insertTx(row.sid, entries);
    } catch (error) {
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite write error: ${errorText(error)}`,
      );
    }
  }

  /** Replaces all FTS5 rows for `snapshotId` atomically using LocAgent tokenization. */
  replaceSymbolIndex(
    snapshotId: string,
    entries: readonly SymbolIndexEntry[],
  ): void {
    requireNonEmptyField("snapshotId", snapshotId);
    const row = this.stmt(
      `SELECT sid FROM snapshots WHERE id = ? OR build_id = ?
       ORDER BY sid DESC LIMIT 1`,
    ).get(snapshotId, snapshotId) as { sid: number } | undefined;
    if (row === undefined) {
      throw new GraphRepositoryError(
        "graph/unknown-snapshot",
        `Snapshot or build id not found: ${snapshotId}`,
      );
    }
    for (const entry of entries) {
      requireNonEmptyField("entry.symbol", entry.symbol);
      requireNonEmptyField("entry.nodeId", entry.nodeId);
    }
    const replaceTx = this.db.transaction(
      (sid: number, items: readonly SymbolIndexEntry[]): void => {
        this.stmt("DELETE FROM symbol_fts WHERE snapshot_sid = ?").run(sid);
        const insertStmt = this.stmt(
          "INSERT INTO symbol_fts (symbol, search_text, node_id, snapshot_sid) VALUES (?, ?, ?, ?)",
        );
        for (const entry of items) {
          const searchText = buildSymbolFtsDocument(
            entry.symbol,
            entry.relativePath,
          );
          insertStmt.run(entry.symbol, searchText, entry.nodeId, sid);
        }
      },
    );
    try {
      replaceTx(row.sid, entries);
    } catch (error) {
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite write error: ${errorText(error)}`,
      );
    }
  }

  searchSymbols(
    query: string,
    limit?: number,
    snapshotId?: string,
  ): readonly SymbolSearchHit[] {
    const trimmed = requireNonEmptyField("query", query);
    const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1) {
      throw new GraphRepositoryError(
        "graph/invalid-limit",
        `limit must be a positive integer: ${String(effectiveLimit)}`,
      );
    }
    if (snapshotId !== undefined) {
      requireNonEmptyField("snapshotId", snapshotId);
    }
    // Strip embedded NUL bytes before tokenization (SQLite C FTS5 parser safety).
    const sanitized = trimmed.replaceAll("\0", " ").trim();
    if (sanitized.length === 0) {
      return [];
    }
    // LocAgent safe FTS5 OR query: strictly double-quoted alphanumeric tokens,
    // zero raw FTS5 operators, zero wildcard `*` injection (CVE-2026-119373).
    const ftsQuery = buildSafeFts5OrQuery(sanitized);
    if (ftsQuery === null) {
      return [];
    }
    let rows: Array<{
      symbol: string;
      node_id: string;
      snapshot_id: string | null;
    }>;
    try {
      rows =
        snapshotId !== undefined
          ? (this.stmt(
              `WITH raw AS MATERIALIZED (
                 SELECT symbol_fts.symbol AS symbol,
                        symbol_fts.node_id AS node_id,
                        snapshots.id AS snapshot_id,
                        bm25(symbol_fts, 2.0, 1.0, 0.0, 0.0) AS rank_score
                 FROM symbol_fts
                 JOIN snapshots ON snapshots.sid = symbol_fts.snapshot_sid
                 WHERE symbol_fts MATCH ? AND snapshots.id = ? AND snapshots.state IN ('ready','partial')
               )
               SELECT raw.symbol AS symbol,
                      raw.node_id AS node_id,
                      raw.snapshot_id AS snapshot_id
               FROM raw
               GROUP BY raw.symbol, raw.node_id, raw.snapshot_id
               ORDER BY MIN(raw.rank_score) ASC, raw.node_id ASC, raw.symbol ASC
               LIMIT ?`,
            ).all(ftsQuery, snapshotId, effectiveLimit) as Array<{
              symbol: string;
              node_id: string;
              snapshot_id: string | null;
            }>)
          : (this.stmt(
              `WITH raw AS MATERIALIZED (
                 SELECT symbol_fts.symbol AS symbol,
                        symbol_fts.node_id AS node_id,
                        snapshots.sid AS sid,
                        bm25(symbol_fts, 2.0, 1.0, 0.0, 0.0) AS rank_score
                 FROM symbol_fts
                 JOIN snapshots ON snapshots.sid = symbol_fts.snapshot_sid
                 WHERE symbol_fts MATCH ? AND snapshots.state IN ('ready','partial')
               ),
               matched AS (
                 SELECT raw.symbol AS symbol,
                        raw.node_id AS node_id,
                        MAX(raw.sid) AS latest_sid,
                        MIN(raw.rank_score) AS rank_score
                 FROM raw
                 GROUP BY raw.symbol, raw.node_id
               )
               SELECT matched.symbol AS symbol,
                      matched.node_id AS node_id,
                      snapshots.id AS snapshot_id
               FROM matched
               JOIN snapshots ON snapshots.sid = matched.latest_sid
               ORDER BY matched.rank_score ASC, matched.node_id ASC, matched.symbol ASC
               LIMIT ?`,
            ).all(ftsQuery, effectiveLimit) as Array<{
              symbol: string;
              node_id: string;
              snapshot_id: string | null;
            }>);
    } catch (error) {
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite FTS search error: ${errorText(error)}`,
      );
    }
    return rows.map((row) => ({
      symbol: row.symbol,
      nodeId: row.node_id,
      snapshotId: row.snapshot_id ?? "",
    }));
  }

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
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite write error: ${errorText(error)}`,
      );
    }
  }

  private requireBuildingRow(buildId: string): SnapshotRow {
    requireNonEmptyField("buildId", buildId);
    const row = this.stmt(
      `SELECT sid, id, build_id, workspace_id, revision_id, revision_sequence,
              config_hash, analyzer_fingerprint, state, created_at,
              published_at, failure_reason
       FROM snapshots WHERE build_id = ? AND state = 'building'
       ORDER BY sid DESC LIMIT 1`,
    ).get(buildId) as SnapshotRow | undefined;
    if (row === undefined) {
      throw new GraphRepositoryError(
        "graph/build-not-active",
        `No active build: ${buildId}`,
      );
    }
    return row;
  }

  private countRows(
    table: "nodes" | "edges" | "evidence",
    sid: number,
  ): number {
    // `table` yalnızca çağıran sabitlerinden gelir (dış girdi değildir);
    // her tablo için ayrı STATİK sorgu metni — SQL'e interpolasyon yok.
    if (table === "nodes") {
      const row = this.stmt(
        "SELECT COUNT(*) AS count FROM nodes WHERE snapshot_sid = ?",
      ).get(sid) as { count: number };
      return row.count;
    }
    if (table === "edges") {
      const row = this.stmt(
        "SELECT COUNT(*) AS count FROM edges WHERE snapshot_sid = ?",
      ).get(sid) as { count: number };
      return row.count;
    }
    const row = this.stmt(
      "SELECT COUNT(*) AS count FROM evidence WHERE snapshot_sid = ?",
    ).get(sid) as { count: number };
    return row.count;
  }

  private metaOf(
    row: SnapshotRow,
    state: PublishableState | SnapshotRow["state"],
  ): SnapshotMetaInput {
    return {
      workspaceId: row.workspace_id,
      revision: { id: row.revision_id, sequence: row.revision_sequence },
      configHash: row.config_hash,
      analyzerFingerprint: row.analyzer_fingerprint,
      createdAt: row.created_at,
      state,
    };
  }

  private mapNodeRow(row: NodeRow): GraphNode {
    const spanComplete =
      row.relative_path !== null &&
      row.start_line !== null &&
      row.end_line !== null &&
      row.source_hash !== null;
    const spanAny =
      row.relative_path !== null ||
      row.start_line !== null ||
      row.end_line !== null ||
      row.source_hash !== null;
    if (!spanComplete && spanAny) {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `Node location columns are missing: ${row.node_id}`,
      );
    }
    const span =
      row.relative_path === null ||
      row.start_line === null ||
      row.end_line === null ||
      row.source_hash === null
        ? undefined
        : {
            relativePath: row.relative_path,
            startLine: row.start_line,
            endLine: row.end_line,
            sourceHash: row.source_hash,
          };
    return {
      id: row.node_id,
      kind: row.kind as GraphNode["kind"],
      qualifiedName: row.qualified_name,
      ...(row.language === null ? {} : { language: row.language }),
      ...(span === undefined ? {} : { location: span }),
      attributes: parseJsonField(
        `nodes.attributes_json:${row.node_id}`,
        row.attributes_json,
      ) as Record<string, unknown>,
    };
  }

  private mapEdgeRow(row: EdgeRow): GraphEdge {
    const parsedEvidenceIds = parseJsonField(
      `edges.evidence_ids_json:${row.edge_id}`,
      row.evidence_ids_json,
    );
    if (!Array.isArray(parsedEvidenceIds)) {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `edge.evidence_ids_json is not an array: ${row.edge_id}`,
      );
    }
    let ambiguity: GraphEdge["ambiguity"];
    if (row.ambiguity_json !== null) {
      const parsed = parseJsonField(
        `edges.ambiguity_json:${row.edge_id}`,
        row.ambiguity_json,
      ) as { candidates: string[]; reason: string };
      ambiguity = { candidates: parsed.candidates, reason: parsed.reason };
    }
    return {
      id: row.edge_id,
      from: row.from_id,
      to: row.to_id,
      kind: row.kind as GraphEdge["kind"],
      resolution: row.resolution as GraphEdge["resolution"],
      evidenceIds: parsedEvidenceIds as string[],
      ...(ambiguity === undefined ? {} : { ambiguity }),
    };
  }

  private mapEvidenceRow(row: EvidenceRow): Evidence {
    const spanComplete =
      row.relative_path !== null &&
      row.start_line !== null &&
      row.end_line !== null &&
      row.source_hash !== null;
    const spanAny =
      row.relative_path !== null ||
      row.start_line !== null ||
      row.end_line !== null ||
      row.source_hash !== null;
    if (!spanComplete && spanAny) {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `Evidence location columns are missing: ${row.evidence_id}`,
      );
    }
    const span =
      row.relative_path === null ||
      row.start_line === null ||
      row.end_line === null ||
      row.source_hash === null
        ? undefined
        : {
            relativePath: row.relative_path,
            startLine: row.start_line,
            endLine: row.end_line,
            sourceHash: row.source_hash,
          };
    return {
      id: row.evidence_id,
      kind: row.kind,
      ...(span === undefined ? {} : { span }),
      analyzerId: row.analyzer_id,
      analyzerVersion: row.analyzer_version,
      rationale: row.rationale,
    };
  }

  private readBuildContent(sid: number): BuildContent {
    const nodeRows = this.stmt(
      `SELECT node_id, kind, qualified_name, language, relative_path,
              start_line, end_line, source_hash, attributes_json
       FROM nodes WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as NodeRow[];
    const nodes = nodeRows.map((row) => this.mapNodeRow(row));

    const edgeRows = this.stmt(
      `SELECT edge_id, from_id, to_id, kind, resolution,
              evidence_ids_json, ambiguity_json
       FROM edges WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as EdgeRow[];
    const edges = edgeRows.map((row) => this.mapEdgeRow(row));

    const evidenceRows = this.stmt(
      `SELECT evidence_id, kind, relative_path, start_line, end_line,
              source_hash, analyzer_id, analyzer_version, rationale
       FROM evidence WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as EvidenceRow[];
    const evidence = evidenceRows.map((row) => this.mapEvidenceRow(row));

    return { nodes, edges, evidence };
  }

  /**
   * Direct trusted hydration for already-published snapshots (Task 2.4b).
   * Full invariant validation (Zod, ID derivation, dangling edges, canonical hashing)
   * is enforced at write/publish time (`add*` + `publish` -> `finalizeSnapshotGraph`);
   * reads hydrate directly in canonical ID order without re-hashing or re-validating
   * 50k+ rows on warm startup.
   */
  private hydratePublishedSnapshot(row: SnapshotRow): SnapshotGraph {
    if (row.state !== "ready" && row.state !== "partial") {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `An unpublished snapshot cannot be read: ${String(row.id)}`,
      );
    }
    if (row.id === null || !SNAPSHOT_ID_PATTERN.test(row.id)) {
      throw new GraphRepositoryError(
        "storage/corrupt-snapshot",
        `Snapshot id is invalid or corrupt: ${String(row.id)}`,
      );
    }

    const nodeRows = this.stmt(
      `SELECT node_id, kind, qualified_name, language, relative_path,
              start_line, end_line, source_hash, attributes_json
       FROM nodes WHERE snapshot_sid = ? ORDER BY node_id ASC`,
    ).all(row.sid) as NodeRow[];
    const nodes = ensureSortedById(nodeRows.map((r) => this.mapNodeRow(r)));

    const edgeRows = this.stmt(
      `SELECT edge_id, from_id, to_id, kind, resolution,
              evidence_ids_json, ambiguity_json
       FROM edges WHERE snapshot_sid = ? ORDER BY edge_id ASC`,
    ).all(row.sid) as EdgeRow[];
    const edges = ensureSortedById(edgeRows.map((r) => this.mapEdgeRow(r)));

    const evidenceRows = this.stmt(
      `SELECT evidence_id, kind, relative_path, start_line, end_line,
              source_hash, analyzer_id, analyzer_version, rationale
       FROM evidence WHERE snapshot_sid = ? ORDER BY evidence_id ASC`,
    ).all(row.sid) as EvidenceRow[];
    const evidence = ensureSortedById(
      evidenceRows.map((r) => this.mapEvidenceRow(r)),
    );

    const meta = Object.freeze({
      id: row.id,
      workspaceId: row.workspace_id,
      revision: Object.freeze({
        id: row.revision_id,
        sequence: row.revision_sequence,
      }),
      configHash: row.config_hash,
      analyzerFingerprint: row.analyzer_fingerprint,
      state: row.state,
      createdAt: row.created_at,
    });

    return Object.freeze({
      meta,
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      evidence: Object.freeze(evidence),
    });
  }

  private reconstructPublished(row: SnapshotRow): SnapshotGraph {
    if (row.state !== "ready" && row.state !== "partial") {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `An unpublished snapshot cannot be read: ${String(row.id)}`,
      );
    }
    const cached = this.publishedCache.get(row.sid);
    if (
      cached !== undefined &&
      row.id !== null &&
      cached.id === row.id &&
      cached.dataVersion === this.currentDataVersion()
    ) {
      return cached.graph;
    }
    const graph = this.hydratePublishedSnapshot(row);
    this.cachePublished(row.sid, graph);
    return graph;
  }

  private isStale(row: SnapshotRow): boolean {
    const publishedAt = row.published_at ?? "";
    const newerPublished = this.stmt(
      `SELECT 1 AS hit FROM snapshots
       WHERE workspace_id = ? AND state IN ('ready','partial') AND sid <> ?
         AND (revision_sequence > ?
              OR (revision_sequence = ? AND published_at > ?)
              OR (revision_sequence = ? AND published_at = ? AND sid > ?))`,
    ).get(
      row.workspace_id,
      row.sid,
      row.revision_sequence,
      row.revision_sequence,
      publishedAt,
      row.revision_sequence,
      publishedAt,
      row.sid,
    );
    if (newerPublished !== undefined) return true;
    const stalingBuild = this.stmt(
      `SELECT 1 AS hit FROM snapshots
       WHERE workspace_id = ? AND state = 'building' AND revision_sequence >= ?`,
    ).get(row.workspace_id, row.revision_sequence);
    return stalingBuild !== undefined;
  }

  private buildInfo(
    row: SnapshotRow,
    nodeCount: number,
    edgeCount: number,
    evidenceCount: number,
  ): SnapshotBuildInfo {
    return {
      buildId: row.build_id,
      workspaceId: row.workspace_id,
      revision: { id: row.revision_id, sequence: row.revision_sequence },
      configHash: row.config_hash,
      analyzerFingerprint: row.analyzer_fingerprint,
      createdAt: row.created_at,
      state: row.state === "failed" ? "failed" : "building",
      nodeCount,
      edgeCount,
      evidenceCount,
      ...(row.failure_reason === null
        ? {}
        : { failureReason: row.failure_reason }),
    };
  }
}
