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
  type WorkspaceRecord,
} from "@causoryn/graph";

import { applySchema, SCHEMA_VERSION } from "./schema.js";

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
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface AcquireBuildLeaseInput {
  readonly workspaceId: string;
  readonly buildId: string;
  readonly leaseId: string;
  readonly ownerPid: number;
  readonly hostLabel?: string;
  readonly nowIso: string;
  readonly ttlMs: number;
  /** Optional PID liveness predicate (defaults to `defaultIsPidAlive`). */
  readonly isPidAlive?: (pid: number) => boolean;
}

export type AcquireBuildLeaseResult =
  | { readonly acquired: true; readonly lease: BuildLeaseRecord }
  | { readonly acquired: false; readonly holder: BuildLeaseRecord };

export interface RecoverOrphanBuildsOptions {
  readonly nowIso?: string;
  readonly isPidAlive?: (pid: number) => boolean;
}

export interface RecoverOrphanBuildsResult {
  readonly recoveredBuildIds: readonly string[];
  readonly clearedLease: boolean;
}

/**
 * Checks whether a local OS PID is alive using `process.kill(pid, 0)`.
 * - `pid <= 0` or non-integer -> false (never sends signal to process group 0 / -1).
 * - Success or `EPERM` -> true (process exists).
 * - `ESRCH` / `EINVAL` -> false (process confirmed dead).
 */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH" || code === "EINVAL") {
      return false;
    }
    return false;
  }
}

function mapBuildLeaseRow(row: BuildLeaseRow): BuildLeaseRecord {
  return {
    workspaceId: row.workspace_id,
    buildId: row.build_id,
    leaseId: row.lease_id,
    ownerPid: row.owner_pid,
    hostLabel: row.host_label,
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
      `ttlMs pozitif sonlu sayı olmalı: ${String(ttlMs)}`,
    );
  }
  const baseMs = Date.parse(nowIso);
  return new Date(baseMs + Math.floor(ttlMs)).toISOString();
}

function isLeaseExpired(expiresAt: string, nowIso: string): boolean {
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(expiresMs)) return true;
  if (!Number.isFinite(nowMs)) return false;
  return expiresMs <= nowMs;
}

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
      `JSON sütunu çözümlenemedi (${field}): ${errorText(error)}`,
    );
  }
  return parsed as JsonValue;
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_PUBLISHED_CACHE_ENTRIES = 4;

interface CachedPublishedSnapshot {
  readonly id: string;
  readonly dataVersion: number;
  readonly graph: SnapshotGraph;
}

export class SqliteGraphRepository
  implements GraphRepository, SymbolSearchStore
{
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly buildPositions = new Map<
    number,
    { nodes: number; edges: number; evidence: number }
  >();
  private readonly publishedCache = new Map<number, CachedPublishedSnapshot>();
  private buildSerial = 0;

  constructor(dbPath: string) {
    requireNonEmptyField("dbPath", dbPath);
    this.db = new Database(dbPath);
    try {
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new GraphRepositoryError(
          "storage/schema-corrupt",
          `user_version okunamadı: ${String(version)}`,
        );
      }
      if (version > SCHEMA_VERSION) {
        throw new GraphRepositoryError(
          "storage/schema-too-new",
          `Veritabanı şeması bu paketten daha yeni (v${version} > v${SCHEMA_VERSION})`,
        );
      }
      if (version === 0) {
        // Defense-in-depth (CVE-2026-119375): set 4096-byte page size before
        // initializing WAL or creating any tables on a brand-new database.
        this.db.pragma("page_size = 4096");
      }
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
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
    this.db.close();
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

  runInTransaction<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      return fn();
    }
    const tx = this.db.transaction(fn);
    try {
      return tx();
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
        `Workspace zaten kayıtlı: ${record.id}`,
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
        `file.sizeBytes negatif olmayan tam sayı olmalı: ${String(record.sizeBytes)}`,
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
        `Aynı revizyon için aktif build var: ${input.workspaceId}#${input.revision.id}@${input.revision.sequence}`,
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
        `Aynı node kimliği build içinde zaten var: ${node.id}`,
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
          `Kenar ucu bilinmeyen node'a işaret ediyor (${missing}): ${endpoint}`,
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
        `Aynı edge kimliği build içinde zaten var: ${edge.id}`,
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
          `Aktif build yok: ${buildId}`,
        );
      }
      this.stmt(
        `DELETE FROM build_leases WHERE workspace_id = ? AND build_id = ?`,
      ).run(row.workspace_id, buildId);
      this.buildPositions.delete(row.sid);
      this.cachePublished(row.sid, graph);
      return graph;
    });
    try {
      return publishTx();
    } catch (error) {
      if (error instanceof GraphRepositoryError) throw error;
      // SQLite hatası (ör. aynı deterministik kimliğe çakışan UNIQUE
      // kısıtı): transaction zaten geri alındı; yarım durum yoktur.
      throw new GraphRepositoryError(
        "graph/publish-failed",
        `Yayımlama işlemi başarısız, depo değişmedi: ${errorText(error)}`,
      );
    }
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
          `Aktif build yok: ${buildId}`,
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
        `ownerPid pozitif tam sayı olmalı: ${String(input.ownerPid)}`,
      );
    }
    const expiresAt = computeExpiresAtIso(input.nowIso, input.ttlMs);
    const hostLabel =
      input.hostLabel !== undefined && input.hostLabel.trim().length > 0
        ? input.hostLabel.trim()
        : null;
    const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;

    const execute = (): AcquireBuildLeaseResult => {
      const existing = this.stmt(
        `SELECT workspace_id, build_id, lease_id, owner_pid, host_label,
                acquired_at, heartbeat_at, expires_at
         FROM build_leases WHERE workspace_id = ? LIMIT 1`,
      ).get(input.workspaceId) as BuildLeaseRow | undefined;

      if (existing !== undefined) {
        const expired = isLeaseExpired(existing.expires_at, input.nowIso);
        const alive = !expired && isPidAlive(existing.owner_pid);
        if (alive) {
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
            acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.workspaceId,
        input.buildId,
        input.leaseId,
        input.ownerPid,
        hostLabel,
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
              acquired_at, heartbeat_at, expires_at
       FROM build_leases WHERE workspace_id = ? LIMIT 1`,
    ).get(workspaceId) as BuildLeaseRow | undefined;
    return row === undefined ? undefined : mapBuildLeaseRow(row);
  }

  /**
   * Atomically recovers orphaned `building` snapshot rows and expired/dead-PID
   * build leases for `workspaceId`:
   * - A `building` row is orphaned if:
   *   (i) no lease row exists for `workspaceId` (e.g., legacy v0.2.4 crash), OR
   *   (ii) the lease's `expires_at <= nowIso`, OR
   *   (iii) the lease's `owner_pid` is confirmed dead (`!isPidAlive(pid)`), OR
   *   (iv) the live lease belongs to a different `build_id`.
   * - Orphan `building` rows are transitioned to `state = 'failed'`,
   *   `failure_reason = 'orphan-build-recovered'`, and expired/dead lease rows are deleted.
   */
  recoverOrphanBuilds(
    workspaceId: string,
    options: RecoverOrphanBuildsOptions = {},
  ): RecoverOrphanBuildsResult {
    requireNonEmptyField("workspaceId", workspaceId);
    const nowIso = options.nowIso ?? new Date().toISOString();
    requireTimestamp("nowIso", nowIso);
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

    const execute = (): RecoverOrphanBuildsResult => {
      const lease = this.stmt(
        `SELECT workspace_id, build_id, lease_id, owner_pid, host_label,
                acquired_at, heartbeat_at, expires_at
         FROM build_leases WHERE workspace_id = ? LIMIT 1`,
      ).get(workspaceId) as BuildLeaseRow | undefined;

      const leaseIsLive =
        lease !== undefined &&
        !isLeaseExpired(lease.expires_at, nowIso) &&
        isPidAlive(lease.owner_pid);

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

  getSnapshot(snapshotId: string): SnapshotRead | undefined {
    requireNonEmptyField("snapshotId", snapshotId);
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
  }

  getLatestPublished(workspaceId: string): SnapshotRead | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
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
        `Snapshot ya da build kimliği bulunamadı: ${snapshotId}`,
      );
    }
    for (const entry of entries) {
      requireNonEmptyField("entry.symbol", entry.symbol);
      requireNonEmptyField("entry.nodeId", entry.nodeId);
    }
    const insertTx = this.db.transaction(
      (sid: number, items: readonly SymbolIndexEntry[]): void => {
        for (const entry of items) {
          this.stmt(
            "INSERT INTO symbol_fts (symbol, node_id, snapshot_sid) VALUES (?, ?, ?)",
          ).run(entry.symbol, entry.nodeId, sid);
        }
      },
    );
    try {
      insertTx(row.sid, entries);
    } catch (error) {
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite yazma hatası: ${errorText(error)}`,
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
        `limit pozitif tam sayı olmalı: ${String(effectiveLimit)}`,
      );
    }
    if (snapshotId !== undefined) {
      requireNonEmptyField("snapshotId", snapshotId);
    }
    // Gömülü NUL byte (\0) SQLite C FTS5 ayrıştırıcısında dizgeyi kapanış
    // tırnağından önce kesip "unterminated string" hatası ürettiğinden boşluğa
    // normalize edilir; kalan metin boşsa isabet yoktur.
    const sanitized = trimmed.replaceAll("\0", " ").trim();
    if (sanitized.length === 0) {
      return [];
    }
    // Kullanıcı girdisi FTS ifade (phrase) sözdizimiyle sarmalanır ve
    // PARAMETRE olarak bağlanır; operatör metni MATCH diline katılmaz.
    const phrase = `"${sanitized.replaceAll('"', '""')}"`;
    let rows: Array<{
      symbol: string;
      node_id: string;
      snapshot_id: string | null;
    }>;
    try {
      rows =
        snapshotId !== undefined
          ? (this.stmt(
              `SELECT DISTINCT symbol_fts.symbol AS symbol,
                      symbol_fts.node_id AS node_id,
                      snapshots.id AS snapshot_id
               FROM symbol_fts JOIN snapshots ON snapshots.sid = symbol_fts.snapshot_sid
               WHERE symbol_fts MATCH ? AND snapshots.id = ? AND snapshots.state IN ('ready','partial')
               ORDER BY symbol_fts.symbol, symbol_fts.node_id
               LIMIT ?`,
            ).all(phrase, snapshotId, effectiveLimit) as Array<{
              symbol: string;
              node_id: string;
              snapshot_id: string | null;
            }>)
          : (this.stmt(
              `SELECT matched.symbol AS symbol,
                      matched.node_id AS node_id,
                      snapshots.id AS snapshot_id
               FROM (
                 SELECT symbol_fts.symbol AS symbol,
                        symbol_fts.node_id AS node_id,
                        MAX(snapshots.sid) AS latest_sid
                 FROM symbol_fts
                 JOIN snapshots ON snapshots.sid = symbol_fts.snapshot_sid
                 WHERE symbol_fts MATCH ? AND snapshots.state IN ('ready','partial')
                 GROUP BY symbol_fts.symbol, symbol_fts.node_id
               ) AS matched
               JOIN snapshots ON snapshots.sid = matched.latest_sid
               ORDER BY matched.symbol, matched.node_id
               LIMIT ?`,
            ).all(phrase, effectiveLimit) as Array<{
              symbol: string;
              node_id: string;
              snapshot_id: string | null;
            }>);
    } catch (error) {
      throw new GraphRepositoryError(
        "storage/driver-error",
        `SQLite FTS arama hatası: ${errorText(error)}`,
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
        `SQLite yazma hatası: ${errorText(error)}`,
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
        `Aktif build yok: ${buildId}`,
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

  private readBuildContent(sid: number): BuildContent {
    const nodeRows = this.stmt(
      `SELECT node_id, kind, qualified_name, language, relative_path,
              start_line, end_line, source_hash, attributes_json
       FROM nodes WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as NodeRow[];
    const nodes: GraphNode[] = nodeRows.map((row) => {
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
          `Node konum sütunları eksik: ${row.node_id}`,
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
    });

    const edgeRows = this.stmt(
      `SELECT edge_id, from_id, to_id, kind, resolution,
              evidence_ids_json, ambiguity_json
       FROM edges WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as EdgeRow[];
    const edges: GraphEdge[] = edgeRows.map((row) => {
      const parsedEvidenceIds = parseJsonField(
        `edges.evidence_ids_json:${row.edge_id}`,
        row.evidence_ids_json,
      );
      if (!Array.isArray(parsedEvidenceIds)) {
        throw new GraphRepositoryError(
          "storage/corrupt-row",
          `edge.evidence_ids_json dizi değil: ${row.edge_id}`,
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
    });

    const evidenceRows = this.stmt(
      `SELECT evidence_id, kind, relative_path, start_line, end_line,
              source_hash, analyzer_id, analyzer_version, rationale
       FROM evidence WHERE snapshot_sid = ? ORDER BY position`,
    ).all(sid) as EvidenceRow[];
    const evidence: Evidence[] = evidenceRows.map((row) => {
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
          `Evidence konum sütunları eksik: ${row.evidence_id}`,
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
    });

    return { nodes, edges, evidence };
  }

  private reconstructPublished(row: SnapshotRow): SnapshotGraph {
    if (row.state !== "ready" && row.state !== "partial") {
      throw new GraphRepositoryError(
        "storage/corrupt-row",
        `Yayımlanmamış snapshot okunamaz: ${String(row.id)}`,
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
    const graph = finalizeSnapshotGraph(
      this.metaOf(row, row.state),
      this.readBuildContent(row.sid),
    );
    if (row.id === null || graph.meta.id !== row.id) {
      throw new GraphRepositoryError(
        "storage/corrupt-snapshot",
        `Snapshot kimliği satırla uyuşmuyor: ${String(row.id)} != ${graph.meta.id}`,
      );
    }
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
