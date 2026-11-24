import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_VERSION,
  analyzeTypeScriptProgram,
} from "@causoryn/adapter-typescript";
import {
  CSHARP_ROSLYN_ADAPTER_ID,
  CSHARP_ROSLYN_ADAPTER_VERSION,
  DEFAULT_DOTNET_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WORKER_DLL_RELATIVE_PATH,
  analyzeCSharpWorkspace,
  type AnalyzeCSharpWorkspaceInput,
  type RoslynAdapterDiagnostic,
  type RoslynAdapterResult,
} from "@causoryn/adapter-csharp-roslyn";
import {
  DEFAULT_GO_BINARY_PATH,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_GO_REQUEST_TIMEOUT_MS,
  GO_ADAPTER_ID,
  GO_ADAPTER_VERSION,
  WORKER_DIR_RELATIVE_PATH as GO_WORKER_DIR_RELATIVE_PATH,
  analyzeGoWorkspace,
  type GoAdapterResult,
} from "@causoryn/adapter-go";
import {
  DEFAULT_PYTHON_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_PY_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS as DEFAULT_PY_RESPONSE_MAX_CHARS,
  PYTHON_WORKER_ADAPTER_ID,
  PYTHON_WORKER_ADAPTER_VERSION,
  WORKER_SCRIPT_RELATIVE_PATH,
  analyzePythonWorkspace,
  type PythonAdapterResult,
} from "@causoryn/adapter-python";
import {
  DEFAULT_CARGO_BUILD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_RS_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS as DEFAULT_RS_RESPONSE_MAX_CHARS,
  RUST_ADAPTER_ID,
  RUST_ADAPTER_VERSION,
  WORKER_BINARY_NAME,
  defaultWorkerDir,
  analyzeRustWorkspace,
  type RustAdapterResult,
} from "@causoryn/adapter-rust";
import {
  canonicalJson,
  createEdge,
  evidenceId,
  nodeId,
  sha256Hex,
  utf8Encode,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type NodeKind,
  type NodeRef,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
  type SourceSpan,
} from "@causoryn/domain";
import {
  GraphRepositoryError,
  type GraphRepository,
  type PublishableState,
  type SymbolIndexEntry,
  type SymbolSearchStore,
} from "@causoryn/graph";
import type { WorkspaceAccessPolicy, WorkspacePolicyConfig } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import {
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
  type GoIndexSettings,
  type PythonIndexSettings,
  type RoslynAdapterSettings,
  type RoslynDiscoveryStatus,
  type RoslynRefPackContext,
  type RustIndexSettings,
  type WorkerRunStatus,
} from "./fingerprint.js";
import {
  collectInventory,
  collectInventoryAsync,
  yieldToEventLoop,
  type InventoryEntry,
} from "./inventory.js";

/**
 * IndexService — indeksleme pipeline'ı (TŞ v2.1 §9, §25/4-5; sprint-1
 * görev 6 + sprint-2 B7 Live Architecture + sprint-2 B9 çoklu dil
 * entegrasyonu):
 *
 *   dosya envanteri (WorkspaceAccessPolicy ile) → dil adapter'ları
 *   (TypeScript senkron, C# Roslyn worker async) → graph inşası
 *   (deterministik domain ID'leri) → atomik snapshot publish
 *
 * - Envanter: `collectInventory` (politika izinli, deterministik sıralı).
 * - Adapter: salt-okunur kaynak çantası; tek dosyanın parse hatası analizi
 *   düşürmez (diagnostics + state partial).
 * - Graph: node/edge/evidence kimlikleri domain katmanında türetilir
 *   (TŞ §8 invariant iii); her node'un kimlik `relativePath` bileşeni
 *   graph kongresi gereği `node.location.relativePath` ile aynıdır.
 * - Publish: repository `beginBuild → add* → publish` atomik akışı
 *   (ADR-005); hata durumunda `failBuild` ile kayıt `failed` olur ve
 *   yayın akışına hiçbir şey girmez.
 * - Bu paket saat okumaz: `createdAt`/`publishedAt` enjekte edilen
 *   `clock`'tan gelir (domain/repository ile aynı determinizm ilkesi).
 *
 * B9 çoklu dil sözleşmesi (iki koşum yolu) + M2 ile beş dil:
 * - `runIndexAsync` / `runIncrementalIndexAsync`: TAM pipeline — .cs
 *   dosyaları analyzeCSharpWorkspace'e; .py/.go/.rs dosyaları
 *   analyzePythonWorkspace/analyzeGoWorkspace/analyzeRustWorkspace'e
 *   yönlendirilir; beş dilin çıktıları TEK snapshot'a katılır (dangling
 *   yok — cross-boundary sözleşmesi). Bir worker kullanılamıyorsa o
 *   adapter'ın L0/L1 fallback'i ile motor çökmez (partial + explicit
 *   warning); diğer dillerin analizi yaşar.
 * - `runIndex` / `runIncrementalIndex` (SENKRON köprü): Roslyn/python/go/
 *   rust worker'lar async koştuğu için senkron imza derin analizi
 *   BEKLEYEMEZ; TS dışındaki dil dosyaları yalnızca L0 envanter düzeyinde
 *   (File node'ları, uydurma sembol/kenar yok) temsil edilir ve bu
 *   dürüstçe partial + explicit warning ile raporlanır (TŞ §7 "yalnızca
 *   kanıtlanabilen L0/L1 bilgisi sunulur"). Senkron yol hiçbir koşulda
 *   worker başlatmaz — spawn çağrısı yalnızca adapter'ların async
 *   API'sindedir.
 */
/**
 * Pipeline sürümü; envanter evidence `analyzerVersion` alanına yazılır.
 * Manifest hizası (denetim bulgusu): bu sabit packages/indexing
 * package.json sürümüyle KİLİTLİDİR (test: index-service-csharp.test.ts
 * "INDEXING_VERSION packages/indexing manifest sürümüyle aynıdır") —
 * mcp-server iç workspace bağımlılıklarını exact manifest sürümüne pinlediğinden
 * (packages/mcp-server/package.json) sürüm yükseltmesi manifest-first
 * yapılmalıdır; aksi halde npm çözümlemesi kırılır. Pipeline davranış
 * kimliği, bu sürümden bağımsız olarak analyzerFingerprint fp2 şemasıyla
 * taşınır (fp1→fp2 geçişi snapshot meta'da ayrışır).
 */
export const INDEXING_VERSION = "0.2.4";

/** Envanter/adaptasyon limitleri (TŞ §20 index bölümü). */
export interface IndexLimits {
  readonly maxFiles: number;
}

/**
 * C# adapter ayarları (IndexService düzeyi yapılandırma; MCP araç girdisi
 * değildir). Tanımsız alanlar adapter varsayılanlarına düşer; etkin
 * değerler fingerprint opts hash'ine girer.
 */
export interface CsharpIndexOptions {
  readonly dotnetCommand?: string;
  readonly requestTimeoutMs?: number;
  readonly workerDllPath?: string;
  /**
   * Yalnızca test enjeksiyonu (adapter RoslynAdapterOptions.spawnProcess
   * precedens'iyle aynı kural): analiz fonksiyonu seam'i. Prod yol
   * analyzeCSharpWorkspace'dir; opts fingerprint hash'ine GİRMEZ.
   */
  readonly analyzeCSharp?: AnalyzeCSharpFunction;
}

/** analyzeCSharpWorkspace ile aynı imza (seam tipi). */
export type AnalyzeCSharpFunction = (
  input: AnalyzeCSharpWorkspaceInput,
) => Promise<RoslynAdapterResult>;

/**
 * Python adapter ayarları (IndexService düzeyi yapılandırma; MCP araç
 * girdisi değildir; M2). Tanımsız alanlar adapter varsayılanlarına düşer
 * (env override'ları dahil); etkin değerler fingerprint pyopts hash'ine
 * girer.
 */
export interface PythonIndexOptions {
  readonly pythonCommand?: string;
  readonly requestTimeoutMs?: number;
  readonly workerScriptPath?: string;
}

/**
 * Go adapter ayarları (M2). goWorkerBinaryPath verilirse önceden
 * derlenmiş binary modu ("go run" atlanır); env override'ları
 * (CAUSORYN_GO_WORKER_BIN / CAUSORYN_GO_WORKER_DIR) option verilmediyse
 * uygulanır.
 */
export interface GoIndexOptions {
  readonly goBinaryPath?: string;
  readonly goWorkerBinaryPath?: string;
  readonly workerDir?: string;
  readonly requestTimeoutMs?: number;
}

/** Rust adapter ayarları (M2); workerDir env override (CAUSORYN_RUST_WORKER_DIR) adapter default'u. */
export interface RustIndexOptions {
  readonly workerDir?: string;
  readonly cargoHomeDir?: string;
  readonly requestTimeoutMs?: number;
  readonly cargoBuildTimeoutMs?: number;
}

export interface IndexServiceOptions {
  readonly workspaceId: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  /** ISO-8601 üretir; domain saat okumaz. */
  readonly clock: () => string;
  readonly limits: IndexLimits;
  /** C# (roslyn worker) adapter ayarları; tanımsızsa defaults. */
  readonly csharp?: CsharpIndexOptions;
  /** Python (stdlib ast sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly python?: PythonIndexOptions;
  /** Go (go/parser sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly go?: GoIndexOptions;
  /** Rust (syn sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly rust?: RustIndexOptions;
  /**
   * K-021: Aynı SQLite veri kökünü paylaşan çoklu süreç yarışlarında
   * (graph/build-already-active ve graph/publish-failed) kaybeden build'i
   * failBuild ile temizleyip yayımlanmış mevcut snapshot'a zarifçe düşer.
   * Varsayılan false.
   */
  readonly tolerateConcurrentPublishRace?: boolean;
  /**
   * Optional diagnostic host/client label stored in `build_leases.host_label`
   * (e.g., "claude-code", "codex", "antigravity"). Does not affect snapshot IDs.
   */
  readonly hostLabel?: string;
  /** Build lease TTL in milliseconds (default: 30_000). */
  readonly leaseTtlMs?: number;
  /** Heartbeat renewal interval in milliseconds (default: 10_000). */
  readonly leaseHeartbeatIntervalMs?: number;
  /** Optional PID liveness predicate for lease recovery (test seam). */
  readonly isPidAlive?: (pid: number) => boolean;
  /**
   * Per-process lease owner instance id. Defaults to the repository's
   * `leaseOwnerInstance` (or a per-module random id). Worker threads receive
   * the main thread's id so the whole process shares one instance id.
   */
  readonly processInstanceId?: string;
  /**
   * Maximum time an async run waits for a live peer that holds the workspace
   * build lease before giving up with outcome `peer_busy` (default 15 minutes;
   * env `CAUSORYN_PEER_WAIT_TIMEOUT_MS`). `0` disables waiting.
   */
  readonly peerWaitTimeoutMs?: number;
  /** Initial poll interval while waiting for a peer (default 100 ms, doubles up to 2 s). */
  readonly peerPollIntervalMs?: number;
  /**
   * Hard heartbeat staleness ceiling after which any lease is considered dead
   * (PID-reuse guard; default 10 minutes; env `CAUSORYN_LEASE_STALE_CEILING_MS`).
   */
  readonly leaseStaleCeilingMs?: number;
  /** Notified when this service acquires/releases a build lease (worker -> main thread bridge). */
  readonly onLeaseEvent?: (event: BuildLeaseEvent) => void;
}

/** Build lease lifecycle notification emitted by `IndexService`. */
export interface BuildLeaseEvent {
  readonly type: "acquired" | "released";
  readonly leaseId: string;
}

/**
 * Honest outcome of one indexing run:
 * - `published`: a new snapshot was published by this run.
 * - `unchanged`: no index-relevant change; the current snapshot was kept.
 * - `reused_peer`: a concurrent build published the snapshot this run reuses
 *   (either it won the publish race, or this run waited for it and the
 *   inventory matched, so nothing was re-analyzed).
 * - `peer_busy`: a live peer still holds the build lease; this run did not
 *   build anything and the previously published snapshot is still served.
 */
export type IndexRunOutcome = "published" | "unchanged" | "reused_peer" | "peer_busy";

/** Explicit peer status when another live process currently holds the build lease. */
export type IndexPeerStatus = "waiting_for_peer";

/** Single-writer workspace build lease metadata (structural match for SqliteGraphRepository). */
export interface BuildLeaseInfo {
  readonly workspaceId: string;
  readonly buildId: string;
  readonly leaseId: string;
  readonly ownerPid: number;
  readonly hostLabel: string | null;
  /** `os.hostname()` of the owner (schema v5; absent/NULL for older rows). */
  readonly hostname?: string | null;
  /** Per-process owner instance id (schema v5; absent/NULL for older rows). */
  readonly ownerInstance?: string | null;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

/** Liveness inputs forwarded to the repository's lease rule (see storage-sqlite build-lease.ts). */
export interface BuildLeaseLivenessOptions {
  readonly processInstanceId?: string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly isLocalLeaseActive?: (leaseId: string) => boolean | undefined;
  readonly staleCeilingMs?: number;
}

/** Non-blocking dedicated heartbeat connection (structural match for SqliteGraphRepository). */
export interface BuildLeaseHeartbeatConnection {
  renew(
    workspaceId: string,
    leaseId: string,
    nowIso: string,
    ttlMs: number,
  ): "renewed" | "lost" | "busy";
  release(workspaceId: string, leaseId: string): void;
  close(): void;
}

/** Optional build-lease & orphan-recovery capability implemented by persistent repositories. */
export interface BuildLeaseStore {
  acquireBuildLease(
    input: {
      readonly workspaceId: string;
      readonly buildId: string;
      readonly leaseId: string;
      readonly ownerPid: number;
      readonly hostLabel?: string;
      readonly nowIso: string;
      readonly ttlMs: number;
    } & BuildLeaseLivenessOptions,
  ):
    | { readonly acquired: true; readonly lease?: BuildLeaseInfo }
    | { readonly acquired: false; readonly holder: BuildLeaseInfo };
  renewBuildLease(
    workspaceId: string,
    leaseId: string,
    nowIso: string,
    ttlMs: number,
  ): boolean;
  releaseBuildLease(workspaceId: string, leaseId: string): void;
  getActiveBuildLease(workspaceId: string): BuildLeaseInfo | undefined;
  recoverOrphanBuilds(
    workspaceId: string,
    options?: { readonly nowIso?: string } & BuildLeaseLivenessOptions,
  ): { readonly recoveredBuildIds: readonly string[]; readonly clearedLease: boolean };
  bindBuildLeaseBuildId?(
    workspaceId: string,
    leaseId: string,
    buildId: string,
  ): boolean;
  withImmediateTransaction?<T>(fn: () => T): T;
  /** Opens a dedicated, short-busy-timeout connection for main-thread lease renewal. */
  openBuildLeaseHeartbeat?(options?: {
    readonly busyTimeoutMs?: number;
  }): BuildLeaseHeartbeatConnection;
  /** Default lease owner instance id of this repository's process (thread). */
  readonly leaseOwnerInstance?: string;
}

/** Per-file cached analysis fact stored in `file_facts` (structural match for SqliteGraphRepository). */
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

/** Optional per-file incremental fact store implemented by SQLite and InMemory repositories. */
export interface FileFactStore {
  upsertFileFact(record: FileFactRecord): void;
  upsertFileFacts(records: readonly FileFactRecord[]): void;
  listFileFacts(
    workspaceId: string,
    analyzerFingerprint?: string,
  ): readonly FileFactRecord[];
  deleteFileFact(workspaceId: string, relativePath: string): boolean;
  clearFileFacts(workspaceId: string): number;
}

/** Structured indexing lifecycle phase reported via progress callbacks / worker messages. */
export type IndexProgressPhase =
  | "queued"
  | "inventory"
  | "waiting_for_peer"
  | "analyzing"
  | "building"
  | "publishing"
  | "done"
  | "reused"
  | "failed";

/** Structured progress event emitted during async / worker-thread indexing. */
export interface IndexProgressEvent {
  readonly phase: IndexProgressPhase;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

export type IndexProgressCallback = (event: IndexProgressEvent) => void;

export interface IndexRunOptions {
  readonly onProgress?: IndexProgressCallback;
}

/** Serializable IndexService configuration forwarded to `worker_threads` worker entrypoint. */
export interface IndexWorkerServiceConfig {
  readonly dbPath?: string;
  readonly workspaceId: string;
  readonly policyConfig: WorkspacePolicyConfig;
  readonly limits: IndexLimits;
  readonly csharp?: {
    readonly dotnetCommand?: string;
    readonly requestTimeoutMs?: number;
    readonly workerDllPath?: string;
  };
  readonly python?: PythonIndexOptions;
  readonly go?: GoIndexOptions;
  readonly rust?: RustIndexOptions;
  readonly tolerateConcurrentPublishRace: boolean;
  readonly hostLabel?: string;
  readonly leaseTtlMs: number;
  readonly leaseHeartbeatIntervalMs: number;
  /** Main-thread process instance id shared with the worker thread. */
  readonly processInstanceId?: string;
  readonly peerWaitTimeoutMs?: number;
  readonly leaseStaleCeilingMs?: number;
}

/** Adapter tanı kaydının uygulama düzeyi karşılığı (parser detayı sızmaz). */
export interface IndexDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  readonly line: number;
}

/** Tek indeksleme koşusunun sonucu. */
export interface IndexRunResult {
  readonly snapshotId: string;
  readonly snapshot: SnapshotGraph;
  readonly stale: boolean;
  /** Envanterdeki toplam dosya sayısı (uzantıdan bağımsız). */
  readonly fileCount: number;
  /** Adapter'a verilen TS/TSX dosya sayısı. */
  readonly tsFileCount: number;
  /** Adapter'a verilen .cs dosya sayısı (B9). */
  readonly csFileCount: number;
  readonly state: PublishableState;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly IndexDiagnostic[];
  /**
   * true: yeni snapshot yayımlandı. false: incremental no-op — değişiklik
   * dil analizleri için anlamlı değildi; graph korunup mevcut snapshot
   * yeniden kullanıldı (yalnızca files tablosu tazelendi).
   */
  readonly published: boolean;
  /** Explicit run outcome; `published` is true only for outcome `published`. */
  readonly outcome: IndexRunOutcome;
  /** Number of source files re-analyzed during this indexing run (Task 2.6). */
  readonly reanalyzedFiles?: number;
  /** Number of unchanged source files reused from `file_facts` cache (Task 2.6). */
  readonly cachedFiles?: number;
  /** True when early cutoff skipped reverse dependents because public interfaces stayed identical. */
  readonly earlyCutoffApplied?: boolean;
  /** Set when a live peer holds the workspace build lease and this run deferred honestly. */
  readonly peerStatus?: IndexPeerStatus;
  /** True when this run deferred because a live peer is actively building. */
  readonly waitingForPeer?: boolean;
  /** True when an existing published snapshot was reused without publishing a new build. */
  readonly reused?: boolean;
  /** Holder lease metadata when `peerStatus === "waiting_for_peer"`. */
  readonly peerLease?: BuildLeaseInfo;
}

/** Adapter çıktısının pipeline graph inşasına verilen ortak biçimi. */
interface AdapterOutput {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly state: "ready" | "partial";
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  /** Üst düzey kanıt listesi (yalnızca roslyn worker taşır — PROTOCOL.md v1). */
  readonly evidence: readonly SnapshotEvidenceInput[];
}

/** Adapter node girdisini graph kongresine uygun GraphNode'a çevirir. */
function toGraphNode(
  workspaceId: string,
  input: {
    readonly kind: NodeKind;
    readonly qualifiedName: string;
    readonly relativePath?: string;
    readonly language?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  },
  contentHashByPath: ReadonlyMap<string, string>,
): GraphNode {
  const relativePath = input.relativePath;
  const location: SourceSpan | undefined =
    relativePath === undefined
      ? undefined
      : {
          relativePath,
          startLine: 1,
          endLine: 1,
          // Envanter karması: node'un geldiği dosyanın bütünlük kanıtı.
          // Envanter dışı bir path bu aşamada sözleşme ihlalidir.
          sourceHash: contentHashByPath.get(relativePath) ?? "",
        };
  if (location !== undefined && location.sourceHash.length === 0) {
    throw new IndexingError(
      "indexing/internal",
      `adapter node points to a file that is not in the inventory: ${relativePath ?? "?"}`,
    );
  }
  return {
    id: nodeId({
      workspaceId,
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(relativePath === undefined ? {} : { relativePath }),
    }),
    kind: input.kind,
    qualifiedName: input.qualifiedName,
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(location === undefined ? {} : { location }),
    attributes: {
      ...(input.attributes ?? {}),
      // Provenance kongresi: sembol node'unun geldiği dosya (arama/ambiguity
      // adaylarında relativePath raporlamak için).
      ...(relativePath === undefined ? {} : { relativePath }),
    },
  };
}

/** Domain NodeRef kimlik anahtarı (snapshot.ts ile aynı formül). */
function nodeRefKey(ref: NodeRef): string {
  return canonicalJson([ref.kind, ref.qualifiedName, ref.relativePath ?? null]);
}

function isSymbolSearchStore(
  repository: GraphRepository,
): repository is GraphRepository & SymbolSearchStore {
  return (
    "indexSymbols" in repository &&
    typeof (repository as { indexSymbols?: unknown }).indexSymbols === "function"
  );
}

function isBuildLeaseStore(
  repository: GraphRepository,
): repository is GraphRepository & BuildLeaseStore {
  const candidate = repository as Partial<BuildLeaseStore>;
  return (
    typeof candidate.acquireBuildLease === "function" &&
    typeof candidate.renewBuildLease === "function" &&
    typeof candidate.releaseBuildLease === "function" &&
    typeof candidate.getActiveBuildLease === "function" &&
    typeof candidate.recoverOrphanBuilds === "function"
  );
}

function isFileFactStore(
  repository: GraphRepository,
): repository is GraphRepository & FileFactStore {
  const candidate = repository as Partial<FileFactStore>;
  return (
    typeof candidate.upsertFileFact === "function" &&
    typeof candidate.upsertFileFacts === "function" &&
    typeof candidate.listFileFacts === "function" &&
    typeof candidate.deleteFileFact === "function" &&
    typeof candidate.clearFileFacts === "function"
  );
}

const VOLATILE_INTERFACE_ATTR_KEYS = new Set([
  "sourceHash",
  "startLine",
  "endLine",
  "line",
  "column",
  "relativePath",
]);

function stripVolatileAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): JsonValue {
  if (attributes === undefined) return {};
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(attributes).sort()) {
    if (VOLATILE_INTERFACE_ATTR_KEYS.has(key)) continue;
    const value = attributes[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      out[key] = value;
    } else if (Array.isArray(value) || typeof value === "object") {
      try {
        out[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
      } catch {
        // Ignore non-serializable attribute values in interface fingerprint.
      }
    }
  }
  return out;
}

function isIdentCharCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36
  );
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Tokens after which `/` begins a JavaScript/TypeScript regular expression literal
 * rather than a division operator.
 */
const JS_REGEX_PREFIX_TOKENS = new Set([
  "(",
  "[",
  "{",
  "}",
  ";",
  ",",
  ":",
  "?",
  "=",
  "=>",
  "!",
  "~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "<",
  ">",
  "->",
  "::",
  "return",
  "throw",
  "case",
  "in",
  "instanceof",
  "typeof",
  "void",
  "delete",
  "new",
  "yield",
  "await",
  "of",
  "else",
  "do",
  "export",
  "default",
]);

/**
 * Pure O(n) comment-stripping lexer for brace-delimited languages (TS/JS/Go/Rust/C#).
 * Zero backtracking regexes; handles single-line comments, block comments, string
 * literals, JS/TS regex literals (`/pattern/flags`), nested template literal
 * `${ ... }` expressions, and CRLF cleanly.
 */
function tokenizeBraceSource(
  content: string,
  options: { readonly isJsTs?: boolean } = {},
): string[] {
  const isJsTs = options.isJsTs ?? false;
  const tokens: string[] = [];
  const len = content.length;
  const templateBraceDepthStack: number[] = [];
  let i = 0;

  const scanJsTemplateChunk = (startIndex: number): void => {
    let cur = startIndex + 1;
    while (cur < len) {
      const code = content.charCodeAt(cur);
      if (code === 92) {
        cur = Math.min(len, cur + 2);
        continue;
      }
      if (code === 96) {
        cur += 1;
        tokens.push(content.slice(startIndex, cur));
        i = cur;
        return;
      }
      if (code === 36 && cur + 1 < len && content.charCodeAt(cur + 1) === 123) {
        cur += 2;
        tokens.push(content.slice(startIndex, cur));
        templateBraceDepthStack.push(0);
        i = cur;
        return;
      }
      cur += 1;
    }
    tokens.push(content.slice(startIndex, len));
    i = len;
  };

  while (i < len) {
    const ch = content.charCodeAt(i);
    // Whitespace
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      i += 1;
      continue;
    }
    // Single-line comment //
    if (ch === 47 && i + 1 < len && content.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < len && content.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    // Multi-line comment /* ... */
    if (ch === 47 && i + 1 < len && content.charCodeAt(i + 1) === 42) {
      i += 2;
      while (
        i + 1 < len &&
        !(content.charCodeAt(i) === 42 && content.charCodeAt(i + 1) === 47)
      ) {
        i += 1;
      }
      i = Math.min(len, i + 2);
      continue;
    }
    // JS/TS regex literal `/pattern/flags` (distinguished from division `/`)
    if (isJsTs && ch === 47) {
      const prev = tokens[tokens.length - 1];
      if (prev === undefined || JS_REGEX_PREFIX_TOKENS.has(prev)) {
        const start = i;
        let cur = i + 1;
        let inCharClass = false;
        let closed = false;
        while (cur < len) {
          const code = content.charCodeAt(cur);
          if (code === 10 || code === 13) {
            // Regex literals cannot span unescaped line breaks
            break;
          }
          if (code === 92) {
            if (
              cur + 1 < len &&
              content.charCodeAt(cur + 1) !== 10 &&
              content.charCodeAt(cur + 1) !== 13
            ) {
              cur += 2;
            } else {
              break;
            }
            continue;
          }
          if (code === 91) {
            inCharClass = true;
            cur += 1;
            continue;
          }
          if (code === 93) {
            inCharClass = false;
            cur += 1;
            continue;
          }
          if (code === 47 && !inCharClass) {
            cur += 1;
            while (cur < len && isAsciiAlphaCode(content.charCodeAt(cur))) {
              cur += 1;
            }
            closed = true;
            break;
          }
          cur += 1;
        }
        if (closed) {
          tokens.push(content.slice(start, cur));
          i = cur;
          continue;
        }
      }
      tokens.push("/");
      i += 1;
      continue;
    }
    // Template literal (`...${...}...`)
    if (ch === 96) {
      if (isJsTs) {
        scanJsTemplateChunk(i);
        continue;
      }
      const start = i;
      i += 1;
      while (i < len && content.charCodeAt(i) !== 96) {
        i += 1;
      }
      if (i < len) i += 1;
      tokens.push(content.slice(start, i));
      continue;
    }
    // Nested `{` / `}` inside JS/TS template interpolation `${ ... }`
    if (isJsTs && templateBraceDepthStack.length > 0) {
      if (ch === 123) {
        templateBraceDepthStack[templateBraceDepthStack.length - 1] =
          (templateBraceDepthStack[templateBraceDepthStack.length - 1] ?? 0) + 1;
        tokens.push("{");
        i += 1;
        continue;
      }
      if (ch === 125) {
        const depth = templateBraceDepthStack[templateBraceDepthStack.length - 1] ?? 0;
        if (depth > 0) {
          templateBraceDepthStack[templateBraceDepthStack.length - 1] = depth - 1;
          tokens.push("}");
          i += 1;
          continue;
        }
        templateBraceDepthStack.pop();
        scanJsTemplateChunk(i);
        continue;
      }
    }
    // Single- or double-quoted string literal ('...', "...")
    if (ch === 34 || ch === 39) {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const cur = content.charCodeAt(i);
        if (cur === 92) {
          i = Math.min(len, i + 2);
          continue;
        }
        if (cur === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push(content.slice(start, i));
      continue;
    }
    // Identifier / keyword / number
    if (isIdentCharCode(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentCharCode(content.charCodeAt(i))) i += 1;
      tokens.push(content.slice(start, i));
      continue;
    }
    // Two-char punctuation (`=>`, `::`, `->`, `++`, `--`, JSX `</`)
    if (i + 1 < len) {
      const pair = content.slice(i, i + 2);
      if (
        pair === "=>" ||
        pair === "::" ||
        pair === "->" ||
        pair === "++" ||
        pair === "--" ||
        pair === "</"
      ) {
        tokens.push(pair);
        i += 2;
        continue;
      }
    }
    tokens.push(content[i]!);
    i += 1;
  }
  return tokens;
}

interface InterfaceBraceFrame {
  readonly kind: "type-like" | "class" | "body";
  readonly insideHeader: boolean;
}

/**
 * Extracts a deterministic, comment-free, body-stripped declaration surface for
 * TS/JS/Go/Rust/C# files in O(n) time so early cutoff ignores comment/whitespace/body
 * edits while detecting every exported signature, type, class member, or re-export change.
 * Tracks `parenDepth` and `angleDepth` so object types inside generic type arguments
 * (`class Foo extends Bar<{ a: number }>`) or parameter lists (`function f(x: { a: number })`)
 * never prematurely clear `currentDeclKeyword` or trigger body skipping.
 */
function extractBraceLanguageInterfaceSurface(
  content: string,
  language = "typescript",
): string {
  const isJsTs = language === "typescript" || language === "javascript";
  const tokens = tokenizeBraceSource(content, { isJsTs });
  const out: string[] = [];
  const braceStack: InterfaceBraceFrame[] = [];
  const parenAngleStack: number[] = [];
  let angleDepth = 0;
  let headerBraceCount = 0;
  let skipBodyDepth = 0;
  let currentDeclKeyword = "";

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (skipBodyDepth > 0) {
      if (tok === "{") {
        skipBodyDepth += 1;
      } else if (tok === "}") {
        skipBodyDepth -= 1;
        if (skipBodyDepth === 0) {
          braceStack.pop();
          out.push("}");
        }
      }
      continue;
    }

    if (tok === "(") {
      parenAngleStack.push(angleDepth);
    } else if (tok === ")") {
      if (parenAngleStack.length > 0) {
        angleDepth = parenAngleStack.pop()!;
      }
    } else if (tok === "<") {
      angleDepth += 1;
    } else if (tok === ">") {
      if (angleDepth > 0) {
        angleDepth -= 1;
      }
    }

    const inHeaderContext =
      parenAngleStack.length > 0 || angleDepth > 0 || headerBraceCount > 0;
    const enclosingKind = braceStack[braceStack.length - 1]?.kind;

    if (!inHeaderContext && enclosingKind !== "type-like") {
      if (
        tok === "interface" ||
        tok === "type" ||
        tok === "enum" ||
        tok === "namespace" ||
        tok === "struct" ||
        tok === "trait" ||
        tok === "class" ||
        tok === "function" ||
        tok === "func" ||
        tok === "fn"
      ) {
        currentDeclKeyword = tok;
      } else if (tok === "const" || tok === "let" || tok === "var") {
        currentDeclKeyword = "";
      }
    }

    if (tok === ";" && parenAngleStack.length === 0 && headerBraceCount === 0) {
      currentDeclKeyword = "";
      angleDepth = 0;
    }

    if (tok === "{") {
      const prev = tokens[i - 1] ?? "";
      const insideHeader = inHeaderContext;
      let kind: "type-like" | "class" | "body";
      if (insideHeader) {
        kind = "type-like";
      } else if (
        prev === "export" ||
        prev === "import" ||
        prev === ":" ||
        prev === "=" ||
        prev === "|" ||
        prev === "&" ||
        currentDeclKeyword === "interface" ||
        currentDeclKeyword === "type" ||
        currentDeclKeyword === "enum" ||
        currentDeclKeyword === "namespace" ||
        currentDeclKeyword === "struct" ||
        currentDeclKeyword === "trait"
      ) {
        kind = "type-like";
      } else if (currentDeclKeyword === "class") {
        kind = "class";
      } else if (enclosingKind === "class" && prev !== "=>") {
        kind = "body";
      } else {
        kind = "body";
      }

      braceStack.push({ kind, insideHeader });
      if (insideHeader) {
        headerBraceCount += 1;
      } else if (currentDeclKeyword !== "type") {
        currentDeclKeyword = "";
      }
      out.push("{");
      if (kind === "body") {
        skipBodyDepth = 1;
      }
      continue;
    }

    if (tok === "}") {
      const popped = braceStack.pop();
      if (popped?.insideHeader) {
        headerBraceCount = Math.max(0, headerBraceCount - 1);
      } else if (currentDeclKeyword !== "type") {
        currentDeclKeyword = "";
      }
      out.push("}");
      continue;
    }

    out.push(tok);
  }

  return out.join(" ");
}

/**
 * Extracts a deterministic comment-free, body-stripped signature surface for Python
 * files (module-level and class-level `def`/`async def`/`class`/`__all__` headers).
 */
function extractPythonInterfaceSurface(content: string): string {
  const lines = content.split(/\r?\n/);
  const headers: string[] = [];
  for (const rawLine of lines) {
    // Strip inline # comments outside quotes linearly
    let stripped = "";
    let inQuote: string | null = null;
    for (let i = 0; i < rawLine.length; i += 1) {
      const ch = rawLine[i]!;
      if (inQuote !== null) {
        stripped += ch;
        if (ch === "\\" && i + 1 < rawLine.length) {
          stripped += rawLine[i + 1]!;
          i += 1;
        } else if (ch === inQuote) {
          inQuote = null;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
        stripped += ch;
      } else if (ch === "#") {
        break;
      } else {
        stripped += ch;
      }
    }
    const trimmed = stripped.trim();
    if (trimmed.length === 0) continue;
    const isTopLevel = rawLine[0] !== " " && rawLine[0] !== "\t";
    if (
      isTopLevel ||
      trimmed.startsWith("def ") ||
      trimmed.startsWith("async def ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("@")
    ) {
      if (
        isTopLevel &&
        (trimmed.startsWith('"""') || trimmed.startsWith("'''"))
      ) {
        continue;
      }
      headers.push(trimmed);
    }
  }
  return headers.join("\n");
}

/**
 * Computes the deterministic early-cutoff `publicInterfaceHash` for a single file
 * (Mokhov et al., ICFP 2018): combines extracted non-File symbol descriptors with
 * the body-stripped, comment-stripped declaration surface.
 */
function computePublicInterfaceHash(
  language: string,
  content: string,
  fileNodes: readonly SnapshotNodeInput[],
): string {
  const symbolDescriptors: JsonValue[] = fileNodes
    .filter((node) => node.kind !== "File")
    .map((node) => [
      node.kind,
      node.qualifiedName,
      stripVolatileAttributes(node.attributes),
    ])
    .sort((a, b) => {
      const ka = canonicalJson(a);
      const kb = canonicalJson(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const surface =
    language === "python"
      ? extractPythonInterfaceSurface(content)
      : extractBraceLanguageInterfaceSurface(content, language);

  return sha256Hex(
    utf8Encode(canonicalJson([language, symbolDescriptors, surface])),
  );
}

function edgeOwnerPath(edge: SnapshotEdgeInput): string | undefined {
  if (edge.from.relativePath !== undefined) return edge.from.relativePath;
  const firstSpanPath = edge.evidence?.[0]?.span?.relativePath;
  if (firstSpanPath !== undefined) return firstSpanPath;
  return edge.to.relativePath;
}

interface ParsedFileFactPayload {
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
  readonly importedPaths: readonly string[];
}

function parseFileFactPayload(record: FileFactRecord): ParsedFileFactPayload | undefined {
  try {
    const nodes = JSON.parse(record.nodesJson) as SnapshotNodeInput[];
    const edges = JSON.parse(record.edgesJson) as SnapshotEdgeInput[];
    const evidence = JSON.parse(record.evidenceJson) as SnapshotEvidenceInput[];
    const importedPaths = JSON.parse(record.importedPathsJson) as string[];
    if (
      !Array.isArray(nodes) ||
      !Array.isArray(edges) ||
      !Array.isArray(evidence) ||
      !Array.isArray(importedPaths)
    ) {
      return undefined;
    }
    return { nodes, edges, evidence, importedPaths };
  } catch {
    return undefined;
  }
}

/**
 * Partitions an adapter output into per-file `FileFactRecord` entries for `targetEntries`.
 * External nodes (`relativePath === undefined`) referenced by a file's edges are attached
 * to that file's fact so merging cached + dirty facts preserves 100% of external nodes.
 */
function partitionAdapterOutputByFile(input: {
  readonly workspaceId: string;
  readonly analyzerFingerprint: string;
  readonly language: string;
  readonly updatedAt: string;
  readonly targetEntries: readonly InventoryEntry[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}): Map<string, FileFactRecord> {
  const targetByPath = new Map(
    input.targetEntries.map((entry) => [entry.relativePath, entry]),
  );
  const externalNodeByKey = new Map<string, SnapshotNodeInput>();
  const buckets = new Map<
    string,
    {
      readonly ownNodes: SnapshotNodeInput[];
      readonly edges: SnapshotEdgeInput[];
      readonly evidence: SnapshotEvidenceInput[];
      readonly importedPaths: Set<string>;
      readonly externalNodeKeys: Set<string>;
    }
  >();

  for (const entry of input.targetEntries) {
    buckets.set(entry.relativePath, {
      ownNodes: [],
      edges: [],
      evidence: [],
      importedPaths: new Set(),
      externalNodeKeys: new Set(),
    });
  }

  for (const node of input.nodes) {
    if (node.relativePath === undefined) {
      externalNodeByKey.set(nodeRefKey(node), node);
      continue;
    }
    const bucket = buckets.get(node.relativePath);
    if (bucket !== undefined) {
      bucket.ownNodes.push(node);
    }
  }

  for (const edge of input.edges) {
    const owner = edgeOwnerPath(edge);
    if (owner === undefined) continue;
    const bucket = buckets.get(owner);
    if (bucket === undefined) continue;
    bucket.edges.push(edge);
    if (edge.from.relativePath === undefined) {
      bucket.externalNodeKeys.add(nodeRefKey(edge.from));
    }
    if (edge.to.relativePath === undefined) {
      bucket.externalNodeKeys.add(nodeRefKey(edge.to));
    }
    if (edge.to.relativePath !== undefined && edge.to.relativePath !== owner) {
      bucket.importedPaths.add(edge.to.relativePath);
    }
  }

  for (const ev of input.evidence) {
    const owner = ev.span?.relativePath;
    if (owner === undefined) continue;
    const bucket = buckets.get(owner);
    if (bucket !== undefined) {
      bucket.evidence.push(ev);
    }
  }

  const facts = new Map<string, FileFactRecord>();
  for (const [relativePath, bucket] of buckets) {
    const entry = targetByPath.get(relativePath)!;
    const externalNodes: SnapshotNodeInput[] = [];
    for (const key of [...bucket.externalNodeKeys].sort()) {
      const extNode = externalNodeByKey.get(key);
      if (extNode !== undefined) {
        externalNodes.push(extNode);
      }
    }
    const allFileNodes = [...bucket.ownNodes, ...externalNodes];
    const importedPaths = [...bucket.importedPaths].sort();
    const publicInterfaceHash = computePublicInterfaceHash(
      input.language,
      entry.content,
      bucket.ownNodes,
    );
    facts.set(relativePath, {
      workspaceId: input.workspaceId,
      relativePath,
      contentHash: entry.contentHash,
      analyzerFingerprint: input.analyzerFingerprint,
      language: input.language,
      publicInterfaceHash,
      nodesJson: JSON.stringify(allFileNodes),
      edgesJson: JSON.stringify(bucket.edges),
      evidenceJson: JSON.stringify(bucket.evidence),
      importedPathsJson: JSON.stringify(importedPaths),
      updatedAt: input.updatedAt,
    });
  }
  return facts;
}

const RESOLUTION_RANK: Readonly<Record<SnapshotEdgeInput["resolution"], number>> = {
  verified: 3,
  heuristic: 2,
  unresolved: 1,
};

/**
 * Reconstructs a merged `AdapterOutput` from per-file `FileFactRecord`s in canonical
 * path order, deduplicating shared external nodes and identical edges cleanly.
 */
function mergeFileFactOutputs(
  facts: readonly FileFactRecord[],
  meta: {
    readonly analyzerId: string;
    readonly analyzerVersion: string;
    readonly state: "ready" | "partial";
  },
): AdapterOutput | undefined {
  const sortedFacts = [...facts].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const nodeByKey = new Map<string, SnapshotNodeInput>();
  const edgeByKey = new Map<
    string,
    {
      edge: SnapshotEdgeInput;
      evidenceByCanon: Map<string, SnapshotEvidenceInput>;
    }
  >();
  const topEvidenceByCanon = new Map<string, SnapshotEvidenceInput>();

  for (const fact of sortedFacts) {
    const parsed = parseFileFactPayload(fact);
    if (parsed === undefined) return undefined;

    for (const node of parsed.nodes) {
      const key = nodeRefKey(node);
      if (!nodeByKey.has(key)) {
        nodeByKey.set(key, node);
      }
    }

    for (const edge of parsed.edges) {
      const key = canonicalJson([
        edge.kind,
        edge.from.kind,
        edge.from.qualifiedName,
        edge.from.relativePath ?? null,
        edge.to.kind,
        edge.to.qualifiedName,
        edge.to.relativePath ?? null,
      ]);
      const existing = edgeByKey.get(key);
      if (existing === undefined) {
        const evidenceByCanon = new Map<string, SnapshotEvidenceInput>();
        for (const ev of edge.evidence ?? []) {
          evidenceByCanon.set(canonicalJson(ev as unknown as JsonValue), ev);
        }
        edgeByKey.set(key, { edge, evidenceByCanon });
      } else {
        for (const ev of edge.evidence ?? []) {
          existing.evidenceByCanon.set(canonicalJson(ev as unknown as JsonValue), ev);
        }
        if (RESOLUTION_RANK[edge.resolution] > RESOLUTION_RANK[existing.edge.resolution]) {
          existing.edge = edge;
        }
      }
    }

    for (const ev of parsed.evidence) {
      topEvidenceByCanon.set(canonicalJson(ev as unknown as JsonValue), ev);
    }
  }

  const mergedEdges: SnapshotEdgeInput[] = [];
  for (const entry of edgeByKey.values()) {
    if (
      !nodeByKey.has(nodeRefKey(entry.edge.from)) ||
      !nodeByKey.has(nodeRefKey(entry.edge.to))
    ) {
      return undefined;
    }
    const mergedEvidence = [...entry.evidenceByCanon.values()];
    mergedEdges.push({
      ...entry.edge,
      ...(mergedEvidence.length === 0 ? {} : { evidence: mergedEvidence }),
    });
  }

  return {
    analyzerId: meta.analyzerId,
    analyzerVersion: meta.analyzerVersion,
    state: meta.state,
    nodes: [...nodeByKey.values()],
    edges: mergedEdges,
    evidence: [...topEvidenceByCanon.values()],
  };
}

const TS_RESOLVE_CANDIDATE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
];

function resolveRelativeTsSpecifier(
  fromRelativePath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const fromDir = path.posix.dirname(fromRelativePath);
  const rawJoined = path.posix.normalize(
    fromDir === "." ? specifier : `${fromDir}/${specifier}`,
  );
  if (knownPaths.has(rawJoined)) return rawJoined;

  // TS ESM convention: `./foo.js` -> `./foo.ts` / `./foo.tsx`
  const strippedJs = rawJoined.replace(/\.(?:m?js|cjs|jsx)$/i, "");
  for (const ext of TS_RESOLVE_CANDIDATE_EXTS) {
    const candidate = `${strippedJs}${ext}`;
    if (knownPaths.has(candidate)) return candidate;
  }
  for (const ext of TS_RESOLVE_CANDIDATE_EXTS) {
    const indexCandidate = `${rawJoined}/index${ext}`;
    if (knownPaths.has(indexCandidate)) return indexCandidate;
  }
  return undefined;
}

/**
 * Pure O(n) static specifier scanner for TS/JS dirty files so incremental analysis
 * always includes newly added forward relative imports in compiler context.
 */
function scanTsSpecifiers(content: string): {
  readonly relativeSpecifiers: readonly string[];
  readonly hasNonRelativeWorkspaceSpecifier: boolean;
} {
  const tokens = tokenizeBraceSource(content, { isJsTs: true });
  const relativeSpecifiers: string[] = [];
  let hasNonRelativeWorkspaceSpecifier = false;

  const inspectLiteral = (rawLiteral: string): void => {
    if (rawLiteral.length < 2) return;
    const quote = rawLiteral[0];
    if (quote !== '"' && quote !== "'") return;
    const spec = rawLiteral.slice(1, -1);
    if (spec.length === 0) return;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      relativeSpecifiers.push(spec);
    } else if (!spec.startsWith("node:")) {
      hasNonRelativeWorkspaceSpecifier = true;
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === "from" && i + 1 < tokens.length) {
      inspectLiteral(tokens[i + 1]!);
    } else if (
      tok === "import" &&
      i + 1 < tokens.length &&
      (tokens[i + 1]!.startsWith('"') || tokens[i + 1]!.startsWith("'"))
    ) {
      inspectLiteral(tokens[i + 1]!);
    } else if (
      (tok === "require" || tok === "import") &&
      tokens[i + 1] === "(" &&
      i + 2 < tokens.length
    ) {
      inspectLiteral(tokens[i + 2]!);
    }
  }

  return { relativeSpecifiers, hasNonRelativeWorkspaceSpecifier };
}

/**
 * Computes the minimal set of TS/JS files required as compiler context for `dirtyPaths`
 * (dirty files + transitive forward relative imports + any ambient `.d.ts` files).
 */
function computeTsContextPaths(
  dirtyPaths: readonly string[],
  allTsEntries: readonly InventoryEntry[],
  cachedFactsByPath: ReadonlyMap<string, FileFactRecord>,
  hasTsConfig: boolean,
  hasWorkspacePackageJson: boolean,
): readonly InventoryEntry[] {
  const entryByPath = new Map(allTsEntries.map((e) => [e.relativePath, e]));
  const knownPaths = new Set(entryByPath.keys());
  const contextSet = new Set<string>(dirtyPaths);
  const queue = [...dirtyPaths];

  // Always include ambient `.d.ts` files in compiler context
  for (const entry of allTsEntries) {
    if (entry.relativePath.endsWith(".d.ts")) {
      contextSet.add(entry.relativePath);
    }
  }

  let needsFullWorkspaceContext = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entry = entryByPath.get(current);
    if (entry === undefined) continue;

    // 1) Forward edges from cached fact (if available)
    const cached = cachedFactsByPath.get(current);
    if (cached !== undefined) {
      const parsed = parseFileFactPayload(cached);
      if (parsed !== undefined) {
        for (const dep of parsed.importedPaths) {
          if (knownPaths.has(dep) && !contextSet.has(dep)) {
            contextSet.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    // 2) Live scan of current file's specifiers (captures newly added imports)
    const scanned = scanTsSpecifiers(entry.content);
    for (const spec of scanned.relativeSpecifiers) {
      const resolved = resolveRelativeTsSpecifier(current, spec, knownPaths);
      if (resolved !== undefined && !contextSet.has(resolved)) {
        contextSet.add(resolved);
        queue.push(resolved);
      }
    }
    if (
      scanned.hasNonRelativeWorkspaceSpecifier &&
      (hasTsConfig || hasWorkspacePackageJson)
    ) {
      // Path aliases / workspace packages configured in tsconfig or workspace package.json
      // may resolve to non-relative sibling files; fall back safely to full TS context to avoid losing edges.
      needsFullWorkspaceContext = true;
      break;
    }
  }

  if (needsFullWorkspaceContext) {
    return allTsEntries;
  }

  return allTsEntries.filter((entry) => contextSet.has(entry.relativePath));
}

const DEFAULT_BUILD_LEASE_TTL_MS = 30_000;
const DEFAULT_BUILD_LEASE_HEARTBEAT_MS = 10_000;
/** Default bound on waiting for a live peer build (15 minutes: longer than the 10 minute lease staleness ceiling, so a dead owner whose PID was reused is always recovered within the wait). */
export const DEFAULT_PEER_WAIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_PEER_POLL_INTERVAL_MS = 100;
const MAX_PEER_POLL_INTERVAL_MS = 2_000;
const PEER_WAIT_PROGRESS_INTERVAL_MS = 5_000;
/** Busy timeout of the main-thread heartbeat connection: never block the MCP loop. */
const EXTERNAL_HEARTBEAT_BUSY_TIMEOUT_MS = 50;

/** Fallback per-module process instance id (used when the repository exposes none). */
const MODULE_PROCESS_INSTANCE_ID = randomUUID();

/**
 * Build leases held by builds that are active in THIS thread (IndexService
 * builds, and worker leases the job manager tracks on the main thread).
 * Positive-only: absence never proves a lease is dead (see liveness rule).
 */
const LOCALLY_ACTIVE_BUILD_LEASES = new Set<string>();

/** Marks a lease as held by a build that is active in this thread. */
export function markBuildLeaseActiveLocally(leaseId: string): void {
  LOCALLY_ACTIVE_BUILD_LEASES.add(leaseId);
}

/** Removes a lease from this thread's active-build registry. */
export function clearBuildLeaseActiveLocally(leaseId: string): void {
  LOCALLY_ACTIVE_BUILD_LEASES.delete(leaseId);
}

/** `true` when an active build in this thread holds `leaseId`; otherwise `undefined` (unknown). */
export function isBuildLeaseActiveLocally(leaseId: string): boolean | undefined {
  return LOCALLY_ACTIVE_BUILD_LEASES.has(leaseId) ? true : undefined;
}

function positiveMsOrDefault(
  option: number | undefined,
  envName: string,
  fallback: number,
  allowZero = false,
): number {
  const valid = (value: number): boolean =>
    Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (option !== undefined && valid(option)) return option;
  const raw = process.env[envName]?.trim();
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (valid(parsed)) return parsed;
  }
  return fallback;
}

function sleepMs(ms: number): Promise<void> {
  // Intentionally NOT unref'd: inside a worker thread an unref'd timer would
  // let the thread exit while it is waiting for a peer.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** SQLite busy/locked failures (raw better-sqlite3 errors or wrapped driver errors). */
function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  ) {
    return true;
  }
  return error instanceof Error && /database is (locked|busy)/i.test(error.message);
}

function describeLeaseHolder(holder: BuildLeaseInfo | undefined): string {
  if (holder === undefined) return "a live peer build";
  const host =
    holder.hostname !== undefined && holder.hostname !== null ? holder.hostname : "unknown host";
  const label = holder.hostLabel !== null ? `, client=${holder.hostLabel}` : "";
  return `pid=${String(holder.ownerPid)} on ${host}${label}, heartbeat=${holder.heartbeatAt}, expiresAt=${holder.expiresAt}`;
}

interface ActiveBuildLeaseHandle {
  readonly leaseId: string;
  /** Renews the lease now (phase boundaries); never throws. */
  readonly renewNow: () => void;
  readonly stop: () => void;
  readonly release: () => void;
}

/** Main-thread heartbeat for a lease held by an indexing worker thread. */
export interface ExternalLeaseHeartbeat {
  /** Stops renewing; `release: true` also deletes the lease row (worker exit/crash/close). */
  stop(options: { readonly release: boolean }): void;
}

type LeaseClaim =
  | { readonly kind: "claimed"; readonly lease: ActiveBuildLeaseHandle | null }
  | { readonly kind: "result"; readonly result: IndexRunResult };

function toEvidence(workspaceId: string, input: {
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}): Evidence {
  const id = evidenceId({
    workspaceId,
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: input.span }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  });
  return {
    id,
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: input.span }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  };
}

/** Roslyn tanısını uygulama düzeyi kayda çevirir (alanlar birebir). */
function toDiagnostic(diagnostic: RoslynAdapterDiagnostic): IndexDiagnostic {
  return {
    relativePath: diagnostic.relativePath,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
  };
}

/**
 * M2: senkron köprü L0 File node'larının analyzer provenance'ı — dilin
 * kayıtlı sidecar adapter kimliği (INDEXED_ADAPTERS ile aynı sabitler).
 */
function l0LanguageAnalyzerId(language: string): string {
  switch (language) {
    case "python":
      return PYTHON_WORKER_ADAPTER_ID;
    case "go":
      return GO_ADAPTER_ID;
    case "rust":
      return RUST_ADAPTER_ID;
    default:
      return "causoryn-indexing";
  }
}

/** M2: L0 provenance sürümü — dil adapter sürüm sabiti. */
function l0LanguageAnalyzerVersion(language: string): string {
  switch (language) {
    case "python":
      return PYTHON_WORKER_ADAPTER_VERSION;
    case "go":
      return GO_ADAPTER_VERSION;
    case "rust":
      return RUST_ADAPTER_VERSION;
    default:
      return INDEXING_VERSION;
  }
}

/** prepareRun çıktısı (pipeline girdisi; M2 ile beş dil kümesi + TS/JS/package.json yapılandırmaları). */
interface PreparedRun {
  readonly canonicalRoot: string;
  readonly entries: InventoryEntry[];
  readonly tsEntries: InventoryEntry[];
  readonly tsConfigEntries: InventoryEntry[];
  readonly packageJsonEntries: InventoryEntry[];
  readonly csEntries: InventoryEntry[];
  readonly pyEntries: InventoryEntry[];
  readonly goEntries: InventoryEntry[];
  readonly goModEntries: InventoryEntry[];
  readonly rsEntries: InventoryEntry[];
}

const TS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const CS_EXTENSIONS = new Set([".cs"]);
/** M2: sidecar worker dil uzantıları (python/go/rust). */
const PY_EXTENSIONS = new Set([".py"]);
const GO_EXTENSIONS = new Set([".go"]);
const RS_EXTENSIONS = new Set([".rs"]);

const TS_JS_CONFIG_FILE_PATTERN = /^(?:ts|js)config(?:\..+|-.*)?\.json$/i;

function isTsConfigFile(relativePath: string): boolean {
  return TS_JS_CONFIG_FILE_PATTERN.test(path.posix.basename(relativePath));
}

function isGoModFile(relativePath: string): boolean {
  return path.posix.basename(relativePath) === "go.mod";
}

function isWorkspacePackageJsonFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (path.posix.basename(normalized) !== "package.json") return false;
  return !normalized.split("/").includes("node_modules");
}

/**
 * Dinamik sidecar asset kökü çözümleyicisi:
 * 1) CAUSORYN_ASSET_ROOT ortam değişkeni doluysa mutlak yolunu döner,
 * 2) import.meta.url dizininden yukarı 0..4 ata dizinde native/python-worker/worker.py
 *    arar (monorepo derinlik-3 ve paketlenmiş bundle derinlik-1 düzenleri),
 * 3) bulunamazsa 3-seviye üst ata dizine geri düşer.
 */
function resolveIndexingAssetRoot(): string {
  const envAssetRoot = process.env["CAUSORYN_ASSET_ROOT"]?.trim();
  if (envAssetRoot !== undefined && envAssetRoot.length > 0) {
    return path.resolve(envAssetRoot);
  }
  const startDir = dirname(fileURLToPath(import.meta.url));
  let current = startDir;
  for (let depth = 0; depth <= 4; depth += 1) {
    if (existsSync(join(current, "native", "python-worker", "worker.py"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirname(dirname(dirname(startDir)));
}

export class IndexService {
  private readonly workspaceId: string;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly repository: GraphRepository;
  private readonly clock: () => string;
  private readonly limits: IndexLimits;
  private readonly configHash: string;
  /** C# adapter'a geçilen etkin ayarlar (opts fingerprint hash'i). */
  private readonly csharpSettings: RoslynAdapterSettings;
  /** Python adapter'a geçilen etkin ayarlar (pyopts fingerprint hash'i; M2). */
  private readonly pythonSettings: PythonIndexSettings;
  /** Go adapter'a geçilen etkin ayarlar (goopts fingerprint hash'i; M2). */
  private readonly goSettings: GoIndexSettings;
  /** Rust adapter'a geçilen etkin ayarlar (rustopts fingerprint hash'i; M2). */
  private readonly rustSettings: RustIndexSettings;
  /** Rust workerDir yalnızca açıkça override edildiğinde adapter'a iletilir. */
  private readonly hasExplicitRustWorkerDir: boolean;
  /** C# analiz seam'i: prod analyzeCSharpWorkspace; testler stub enjekte eder. */
  private readonly analyzeCSharpFn: AnalyzeCSharpFunction;
  /** True when a custom non-serializable C# test seam was injected. */
  private readonly hasCustomCsharpStub: boolean;
  private readonly rawCsharpOptions: CsharpIndexOptions | undefined;
  private readonly rawPythonOptions: PythonIndexOptions | undefined;
  private readonly rawGoOptions: GoIndexOptions | undefined;
  private readonly rawRustOptions: RustIndexOptions | undefined;
  /** K-021: çoklu-süreç SQLite yarış kurtarma modu. */
  private readonly tolerateConcurrentPublishRace: boolean;
  /** Optional diagnostic host/client label stored in build_leases.host_label. */
  private readonly hostLabel: string | undefined;
  /** Single-writer build lease TTL in ms (default 30_000). */
  private readonly leaseTtlMs: number;
  /** Heartbeat renewal interval in ms (default 10_000). */
  private readonly leaseHeartbeatIntervalMs: number;
  /** Optional PID liveness predicate for lease recovery (test seam). */
  private readonly isPidAlive: ((pid: number) => boolean) | undefined;
  /** Per-process lease owner instance id (shared with worker threads). */
  private readonly processInstanceId: string;
  /** Upper bound on waiting for a live peer build (ms; 0 = do not wait). */
  private readonly peerWaitTimeoutMs: number;
  /** Initial peer poll interval (ms). */
  private readonly peerPollIntervalMs: number;
  /** Hard lease heartbeat staleness ceiling (ms). */
  private readonly leaseStaleCeilingMs: number | undefined;
  private readonly onLeaseEvent: ((event: BuildLeaseEvent) => void) | undefined;
  /** Leases currently held by runs of this service (renewed at phase boundaries). */
  private readonly heldLeases = new Set<ActiveBuildLeaseHandle>();
  private workspaceRegistered = false;
  private runCount = 0;

  constructor(options: IndexServiceOptions) {
    this.workspaceId = options.workspaceId;
    this.policy = options.policy;
    this.repository = options.repository;
    this.clock = options.clock;
    this.limits = options.limits;
    this.tolerateConcurrentPublishRace = options.tolerateConcurrentPublishRace ?? false;
    this.hostLabel = options.hostLabel;
    this.leaseTtlMs =
      options.leaseTtlMs !== undefined && Number.isFinite(options.leaseTtlMs) && options.leaseTtlMs > 0
        ? options.leaseTtlMs
        : DEFAULT_BUILD_LEASE_TTL_MS;
    this.leaseHeartbeatIntervalMs =
      options.leaseHeartbeatIntervalMs !== undefined &&
      Number.isFinite(options.leaseHeartbeatIntervalMs) &&
      options.leaseHeartbeatIntervalMs > 0
        ? options.leaseHeartbeatIntervalMs
        : DEFAULT_BUILD_LEASE_HEARTBEAT_MS;
    this.isPidAlive = options.isPidAlive;
    const repositoryInstance = (this.repository as Partial<BuildLeaseStore>).leaseOwnerInstance;
    this.processInstanceId =
      options.processInstanceId !== undefined && options.processInstanceId.trim().length > 0
        ? options.processInstanceId
        : typeof repositoryInstance === "string" && repositoryInstance.length > 0
          ? repositoryInstance
          : MODULE_PROCESS_INSTANCE_ID;
    this.peerWaitTimeoutMs = positiveMsOrDefault(
      options.peerWaitTimeoutMs,
      "CAUSORYN_PEER_WAIT_TIMEOUT_MS",
      DEFAULT_PEER_WAIT_TIMEOUT_MS,
      true,
    );
    this.peerPollIntervalMs = positiveMsOrDefault(
      options.peerPollIntervalMs,
      "CAUSORYN_PEER_POLL_INTERVAL_MS",
      DEFAULT_PEER_POLL_INTERVAL_MS,
    );
    const ceiling = positiveMsOrDefault(
      options.leaseStaleCeilingMs,
      "CAUSORYN_LEASE_STALE_CEILING_MS",
      0,
    );
    this.leaseStaleCeilingMs = ceiling > 0 ? ceiling : undefined;
    this.onLeaseEvent = options.onLeaseEvent;
    const policyConfig = options.policy.config;
    const hashInput: JsonValue = {
      workspaceId: this.workspaceId,
      maxFiles: options.limits.maxFiles,
      allowRoots: [...policyConfig.allowRoots],
      ignore: [...policyConfig.ignore],
      extraIgnore: [...policyConfig.extraIgnore],
      binaryExtensions: [...policyConfig.binaryExtensions],
      extensionFilterMode: policyConfig.extensionFilterMode,
      allowedExtensions: [...policyConfig.allowedExtensions],
      maxFileBytes: policyConfig.maxFileBytes,
    };
    this.configHash = sha256Hex(utf8Encode(canonicalJson(hashInput)));
    const assetRoot = resolveIndexingAssetRoot();
    // Etkin C# ayarları: açık option > ortam değişkeni (worker DLL yolu) >
    // düz paketlenmiş DLL > B1 build çıktısı varsayılanı. Ortam değişkeni
    // kuralı adapter ile aynıdır (CAUSORYN_ROSLYN_WORKER_DLL) — fingerprint
    // gerçekten kullanılan DLL yolunu yansıtır.
    const envWorkerDll = process.env["CAUSORYN_ROSLYN_WORKER_DLL"];
    let defaultWorkerDll: string;
    if (envWorkerDll !== undefined && envWorkerDll.trim().length > 0) {
      defaultWorkerDll = envWorkerDll;
    } else {
      const flatWorkerDll = join(
        assetRoot,
        "native",
        "roslyn-worker",
        "Causoryn.RoslynWorker.dll",
      );
      defaultWorkerDll = existsSync(flatWorkerDll)
        ? flatWorkerDll
        : join(assetRoot, WORKER_DLL_RELATIVE_PATH);
    }
    const csharpOptions = options.csharp ?? {};
    this.rawCsharpOptions = options.csharp;
    this.rawPythonOptions = options.python;
    this.rawGoOptions = options.go;
    this.rawRustOptions = options.rust;
    this.hasCustomCsharpStub = csharpOptions.analyzeCSharp !== undefined;
    this.csharpSettings = {
      dotnetCommand: csharpOptions.dotnetCommand ?? DEFAULT_DOTNET_COMMAND,
      requestTimeoutMs: csharpOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      workerDllPath: csharpOptions.workerDllPath ?? defaultWorkerDll,
    };
    // Yalnızca test enjeksiyonu; opts fingerprint hash'ine girmez.
    this.analyzeCSharpFn = csharpOptions.analyzeCSharp ?? analyzeCSharpWorkspace;
    // M2: Python/Go/Rust etkin ayarları — açık option > ortam değişkeni
    // (adapter override kuralıyla aynı) > adapter varsayılanı. Ortam
    // değişkeni adları adapter'ların default çözümlemesiyle birebir:
    // CAUSORYN_PYTHON_WORKER_SCRIPT, CAUSORYN_GO_WORKER_BIN,
    // CAUSORYN_GO_WORKER_DIR, CAUSORYN_RUST_WORKER_DIR (rust default'u
    // adapter'ın defaultWorkerDir'iyle çözülür). Fingerprint, GERÇEKTEN
    // kullanılan yolları taşır.
    const pythonOptions = options.python ?? {};
    const envPythonScript = process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"];
    this.pythonSettings = {
      pythonCommand: pythonOptions.pythonCommand ?? DEFAULT_PYTHON_COMMAND,
      requestTimeoutMs: pythonOptions.requestTimeoutMs ?? DEFAULT_PY_REQUEST_TIMEOUT_MS,
      workerScriptPath:
        pythonOptions.workerScriptPath ??
        (envPythonScript !== undefined && envPythonScript.trim().length > 0
          ? envPythonScript
          : join(assetRoot, WORKER_SCRIPT_RELATIVE_PATH)),
      responseMaxChars: DEFAULT_PY_RESPONSE_MAX_CHARS,
    };
    const goOptions = options.go ?? {};
    const envGoWorkerBin = process.env["CAUSORYN_GO_WORKER_BIN"];
    const envGoWorkerDir = process.env["CAUSORYN_GO_WORKER_DIR"];
    this.goSettings = {
      goBinaryPath: goOptions.goBinaryPath ?? DEFAULT_GO_BINARY_PATH,
      goWorkerBinaryPath:
        goOptions.goWorkerBinaryPath ??
        (envGoWorkerBin !== undefined && envGoWorkerBin.trim().length > 0 ? envGoWorkerBin : ""),
      workerDir:
        goOptions.workerDir ??
        (envGoWorkerDir !== undefined && envGoWorkerDir.trim().length > 0
          ? envGoWorkerDir
          : join(assetRoot, GO_WORKER_DIR_RELATIVE_PATH)),
      requestTimeoutMs: goOptions.requestTimeoutMs ?? DEFAULT_GO_REQUEST_TIMEOUT_MS,
    };
    const rustOptions = options.rust ?? {};
    this.hasExplicitRustWorkerDir =
      rustOptions.workerDir !== undefined ||
      Boolean(process.env["CAUSORYN_RUST_WORKER_DIR"]?.trim());
    this.rustSettings = {
      workerDir: rustOptions.workerDir ?? defaultWorkerDir(),
      workerBinaryName: WORKER_BINARY_NAME,
      cargoHomeDir: rustOptions.cargoHomeDir ?? "",
      requestTimeoutMs: rustOptions.requestTimeoutMs ?? DEFAULT_RS_REQUEST_TIMEOUT_MS,
      responseMaxChars: DEFAULT_RS_RESPONSE_MAX_CHARS,
      cargoBuildTimeoutMs: rustOptions.cargoBuildTimeoutMs ?? DEFAULT_CARGO_BUILD_TIMEOUT_MS,
    };
    this.recoverOrphanBuildsIfSupported(this.clock());
    this.runCount = this.readInitialRunCount();
  }

  /**
   * Recovers any orphaned `building` rows (no lease, expired lease, or dead PID)
   * when backed by a build-lease-capable repository (e.g. SqliteGraphRepository).
   * Safe no-op on repositories without lease support or unregistered workspaces.
   */
  private recoverOrphanBuildsIfSupported(nowIso: string): void {
    if (this.workspaceId.trim().length === 0) return;
    if (!isBuildLeaseStore(this.repository)) return;
    try {
      this.repository.recoverOrphanBuilds(this.workspaceId, {
        nowIso,
        ...this.leaseLivenessOptions(),
      });
    } catch {
      // Best-effort recovery; startup/build continues cleanly if workspace is not registered yet.
    }
  }

  /** Recovers orphaned builds now (job manager calls this after a worker crash/exit). */
  recoverOrphanBuildsNow(): void {
    this.recoverOrphanBuildsIfSupported(this.clock());
  }

  /** Liveness inputs for the repository lease rule (hostname defaults to os.hostname()). */
  private leaseLivenessOptions(): BuildLeaseLivenessOptions {
    return {
      processInstanceId: this.processInstanceId,
      isLocalLeaseActive: isBuildLeaseActiveLocally,
      ...(this.isPidAlive === undefined ? {} : { isPidAlive: this.isPidAlive }),
      ...(this.leaseStaleCeilingMs === undefined
        ? {}
        : { staleCeilingMs: this.leaseStaleCeilingMs }),
    };
  }

  private emitLeaseEvent(event: BuildLeaseEvent): void {
    try {
      this.onLeaseEvent?.(event);
    } catch {
      // Lease notifications are advisory; never fail a build because of them.
    }
  }

  private startLeaseHeartbeat(
    leaseStore: BuildLeaseStore,
    leaseId: string,
  ): ActiveBuildLeaseHandle {
    let released = false;
    const renewNow = (): void => {
      if (released) return;
      try {
        leaseStore.renewBuildLease(
          this.workspaceId,
          leaseId,
          this.clock(),
          this.leaseTtlMs,
        );
      } catch {
        // Best-effort heartbeat; DB may have been closed concurrently.
      }
    };
    // In-thread timer: keeps the lease fresh whenever this thread's event loop
    // is free. It starves during long synchronous analysis, which is why the
    // job manager also renews from the main thread and runs renew at every
    // phase boundary (renewNow via progress events).
    const timer = setInterval(renewNow, this.leaseHeartbeatIntervalMs);
    timer.unref();

    const stop = (): void => {
      clearInterval(timer);
    };

    const handle: ActiveBuildLeaseHandle = {
      leaseId,
      renewNow,
      stop,
      release: (): void => {
        if (released) return;
        released = true;
        stop();
        this.heldLeases.delete(handle);
        clearBuildLeaseActiveLocally(leaseId);
        try {
          leaseStore.releaseBuildLease(this.workspaceId, leaseId);
        } catch {
          // Best-effort release; publish/failBuild may have already cleared the lease.
        }
        this.emitLeaseEvent({ type: "released", leaseId });
      },
    };
    this.heldLeases.add(handle);
    markBuildLeaseActiveLocally(leaseId);
    this.emitLeaseEvent({ type: "acquired", leaseId });
    return handle;
  }

  /** Renews every lease held by this service (called at phase boundaries). */
  private renewHeldLeases(): void {
    for (const handle of this.heldLeases) {
      handle.renewNow();
    }
  }

  /** Wraps run options so every progress event (phase boundary) renews held leases. */
  private withPhaseBoundaryRenewal(options: IndexRunOptions): IndexRunOptions {
    const forward = options.onProgress;
    return {
      ...options,
      onProgress: (event): void => {
        this.renewHeldLeases();
        forward?.(event);
      },
    };
  }

  /**
   * Starts a main-thread heartbeat for a lease held by an indexing worker
   * thread. Uses a dedicated connection with a very short busy timeout so the
   * MCP event loop never blocks on the worker's write transactions; a busy
   * tick is simply retried on the next interval. Returns `undefined` for
   * repositories without lease support.
   */
  startExternalLeaseHeartbeat(leaseId: string): ExternalLeaseHeartbeat | undefined {
    if (!isBuildLeaseStore(this.repository)) return undefined;
    const store = this.repository;
    let connection: BuildLeaseHeartbeatConnection | undefined;
    if (typeof store.openBuildLeaseHeartbeat === "function") {
      try {
        connection = store.openBuildLeaseHeartbeat({
          busyTimeoutMs: EXTERNAL_HEARTBEAT_BUSY_TIMEOUT_MS,
        });
      } catch {
        connection = undefined;
      }
    }
    let lost = false;
    let stopped = false;
    const renew = (): void => {
      if (lost || stopped) return;
      try {
        if (connection !== undefined) {
          const outcome = connection.renew(
            this.workspaceId,
            leaseId,
            this.clock(),
            this.leaseTtlMs,
          );
          if (outcome === "lost") lost = true;
        } else if (
          !store.renewBuildLease(this.workspaceId, leaseId, this.clock(), this.leaseTtlMs)
        ) {
          lost = true;
        }
      } catch {
        // Best-effort; retried on the next tick.
      }
    };
    const timer = setInterval(renew, this.leaseHeartbeatIntervalMs);
    timer.unref();
    return {
      stop: ({ release }): void => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        if (release) {
          try {
            if (connection !== undefined) {
              connection.release(this.workspaceId, leaseId);
            } else {
              store.releaseBuildLease(this.workspaceId, leaseId);
            }
          } catch {
            // Best-effort release.
          }
        }
        try {
          connection?.close();
        } catch {
          // Ignore close failures.
        }
      },
    };
  }

  /**
   * Depoda yayımlanmış bir snapshot varsa revision.sequence değerini okur;
   * kalıcı SQLite yeniden açılışlarında sequence sıfırlanmasını ve UNIQUE(id)
   * çakışmasını önler. Kayıtlı olmayan workspace'lerde güvenli biçimde 0 döner.
   * Task 2.4b: `getLatestSnapshotMeta` varsa tam graph hidrasyonu yapmadan
   * yalnızca metadata satırını okur (< 5 ms sıcak başlatma).
   */
  private readInitialRunCount(): number {
    if (this.workspaceId.trim().length === 0) return 0;
    try {
      if (typeof this.repository.getLatestSnapshotMeta === "function") {
        return this.repository.getLatestSnapshotMeta(this.workspaceId)?.revisionSequence ?? 0;
      }
      const existing = this.repository.getLatestPublished(this.workspaceId);
      return existing?.snapshot.meta.revision.sequence ?? 0;
    } catch {
      return 0;
    }
  }

  /** Synchronizes in-memory `runCount` with the latest published snapshot metadata (used after worker runs). */
  syncRunCountFromRepository(): void {
    const latestSeq = this.readInitialRunCount();
    if (latestSeq > this.runCount) {
      this.runCount = latestSeq;
    }
  }

  /**
   * Returns a structured-clone-safe configuration snapshot for `worker_threads`
   * off-thread indexing, or `undefined` when non-serializable test seams were injected.
   */
  getWorkerConfig(): IndexWorkerServiceConfig | undefined {
    if (this.hasCustomCsharpStub || this.isPidAlive !== undefined) {
      return undefined;
    }
    const repoDbPath = (this.repository as { readonly dbPath?: unknown }).dbPath;
    const dbPath =
      typeof repoDbPath === "string" &&
      repoDbPath.trim().length > 0 &&
      repoDbPath !== ":memory:"
        ? repoDbPath
        : undefined;
    const rawCs = this.rawCsharpOptions;
    const csharpConfig =
      rawCs === undefined
        ? undefined
        : {
            ...(rawCs.dotnetCommand === undefined
              ? {}
              : { dotnetCommand: rawCs.dotnetCommand }),
            ...(rawCs.requestTimeoutMs === undefined
              ? {}
              : { requestTimeoutMs: rawCs.requestTimeoutMs }),
            ...(rawCs.workerDllPath === undefined
              ? {}
              : { workerDllPath: rawCs.workerDllPath }),
          };
    return {
      ...(dbPath === undefined ? {} : { dbPath }),
      workspaceId: this.workspaceId,
      policyConfig: {
        allowRoots: [...this.policy.config.allowRoots],
        ignore: [...this.policy.config.ignore],
        extraIgnore: [...this.policy.config.extraIgnore],
        binaryExtensions: [...this.policy.config.binaryExtensions],
        extensionFilterMode: this.policy.config.extensionFilterMode,
        allowedExtensions: [...this.policy.config.allowedExtensions],
        maxFileBytes: this.policy.config.maxFileBytes,
      },
      limits: { maxFiles: this.limits.maxFiles },
      ...(csharpConfig === undefined ? {} : { csharp: csharpConfig }),
      ...(this.rawPythonOptions === undefined ? {} : { python: { ...this.rawPythonOptions } }),
      ...(this.rawGoOptions === undefined ? {} : { go: { ...this.rawGoOptions } }),
      ...(this.rawRustOptions === undefined ? {} : { rust: { ...this.rawRustOptions } }),
      tolerateConcurrentPublishRace: this.tolerateConcurrentPublishRace,
      ...(this.hostLabel === undefined ? {} : { hostLabel: this.hostLabel }),
      leaseTtlMs: this.leaseTtlMs,
      leaseHeartbeatIntervalMs: this.leaseHeartbeatIntervalMs,
      processInstanceId: this.processInstanceId,
      peerWaitTimeoutMs: this.peerWaitTimeoutMs,
      ...(this.leaseStaleCeilingMs === undefined
        ? {}
        : { leaseStaleCeilingMs: this.leaseStaleCeilingMs }),
    };
  }

  /**
   * Depo SymbolSearchStore destekliyorsa yayımlanan snapshot'ın hem sembol
   * hem `File` düğümlerini (yalnızca `Workspace` ve `UnknownExternal` hariç)
   * `relativePath` bilgisiyle birlikte `symbol_fts` tablosuna yazar (LocAgent FTS5).
   */
  private indexPublishedSymbols(snapshot: SnapshotGraph): void {
    if (!isSymbolSearchStore(this.repository)) return;
    const symbolEntries: SymbolIndexEntry[] = [];
    for (const node of snapshot.nodes) {
      if (node.kind === "Workspace" || node.kind === "UnknownExternal") {
        continue;
      }
      symbolEntries.push({
        symbol: node.qualifiedName,
        nodeId: node.id,
        ...(node.location?.relativePath === undefined
          ? {}
          : { relativePath: node.location.relativePath }),
      });
    }
    if (symbolEntries.length > 0) {
      if (typeof this.repository.replaceSymbolIndex === "function") {
        this.repository.replaceSymbolIndex(snapshot.meta.id, symbolEntries);
      } else {
        this.repository.indexSymbols(snapshot.meta.id, symbolEntries);
      }
    }
  }

  /**
   * Kökü yetkilendirir, envanteri çıkarır, TS kaynaklarını adapter'dan
   * geçirir ve snapshot'ı atomik yayımlar. Yetkisiz kök / limit aşımı
   * IndexingError ile reddedilir; hiçbir kısmi yayın yapılmaz.
   *
   * SENKRON köprü: .cs dosyaları varsa C# derin analiz YÜRÜTÜLMEZ (Roslyn
   * worker async koşar; senkron imza onu bekleyemez ve bu yol worker'ı
   * hiç başlatmaz) — C# L0 envanter düzeyinde temsil edilir ve durum
   * partial + explicit warning ile raporlanır. Tam birleşik analiz için
   * `runIndexAsync` / refresh işi kullanılmalıdır.
   */
  runIndex(rootPath: string): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    return this.runPipeline(prepared);
  }

  /**
   * TAM pipeline (B9): kökü yetkilendirir, envanteri çıkarır, TS ve .cs
   * kaynaklarını sırayla kendi adapter'larından geçirir ve iki dilin
   * çıktısını TEK snapshot'a katıp atomik yayımlar. Worker kullanılamıyorsa
   * adapter L0/L1'e düşer (partial + warning) — motor çökmez.
   */
  async runIndexAsync(
    rootPath: string,
    rawOptions: IndexRunOptions = {},
  ): Promise<IndexRunResult> {
    const options = this.withPhaseBoundaryRenewal(rawOptions);
    options.onProgress?.({
      phase: "inventory",
      completed: 0,
      total: 0,
      message: "Scanning workspace inventory",
    });
    const prepared = await this.prepareRunAsync(rootPath);
    options.onProgress?.({
      phase: "inventory",
      completed: prepared.entries.length,
      total: prepared.entries.length,
      message: `Collected ${String(prepared.entries.length)} workspace files`,
    });
    // Finding 6: claim the single-writer lease BEFORE analysis so a second
    // host waits (and can reuse the peer's snapshot) instead of re-analyzing.
    const claim = await this.claimBuildLeaseAsync(prepared, options, []);
    if (claim.kind === "result") {
      return claim.result;
    }
    try {
      return await this.runPipelineAsync(prepared, options, claim.lease);
    } finally {
      claim.lease?.release();
    }
  }

  /**
   * SENKRON incremental yeniden indeksleme (TŞ v2.1 §9; sprint-2 B7 + Task 2.6).
   *
   * Karar yetkilisi DEĞİŞİKLİK KARMASIDIR (TŞ §9 "fingerprint" adımı):
   * envanter tam taranır, files tablosunun önceki karmalarıyla
   * karşılaştırılır. Dil kapsamındaki kaynaklarda anlamlı değişim yoksa
   * graph KORUNUR (published=false). TS-only workspace'lerde `file_facts`
   * erken kesme (early cutoff) ile yalnızca kirli dosyalar yeniden analiz edilir.
   */
  runIncrementalIndex(rootPath: string, changeSet: readonly string[] = []): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    this.recoverOrphanBuildsIfSupported(this.clock());
    const change = this.analyzeChanges(prepared.entries);
    const totalLangFiles = this.countLanguageEntries(prepared);
    const latestMeta = this.readLatestPublishedMeta();
    if (!change && latestMeta !== undefined) {
      const latest = this.repository.getLatestPublished(this.workspaceId);
      if (
        latest !== undefined &&
        (latest.snapshot.meta.state === "ready" || latest.snapshot.meta.state === "partial")
      ) {
        return this.noOpResult(
          prepared.entries,
          prepared.tsEntries.length,
          prepared.csEntries.length,
          latest,
          changeSet,
          totalLangFiles,
        );
      }
    }
    if (
      latestMeta !== undefined &&
      prepared.csEntries.length === 0 &&
      prepared.pyEntries.length === 0 &&
      prepared.goEntries.length === 0 &&
      prepared.rsEntries.length === 0
    ) {
      const incremental = this.tryRunSyncTsIncremental(prepared, latestMeta);
      if (incremental !== undefined) {
        return incremental;
      }
    }
    return this.runPipeline(prepared);
  }

  /**
   * TAM incremental pipeline (B9 + M2 + Task 2.6 early cutoff):
   * dil karma karşılaştırması (TS, C#, python, go, rust); hiçbir dilde anlamlı
   * değişim yoksa mevcut snapshot korunur (published=false); değişim varsa
   * `file_facts` önbelleği + `publicInterfaceHash` erken kesme ile yalnızca
   * kirli dosya(lar) ve (arayüz değiştiyse) doğrudan ters bağımlılar analiz edilir.
   */
  async runIncrementalIndexAsync(
    rootPath: string,
    changeSet: readonly string[] = [],
    rawOptions: IndexRunOptions = {},
  ): Promise<IndexRunResult> {
    const options = this.withPhaseBoundaryRenewal(rawOptions);
    options.onProgress?.({
      phase: "inventory",
      completed: 0,
      total: 0,
      message: "Scanning workspace inventory",
    });
    const prepared = await this.prepareRunAsync(rootPath);
    options.onProgress?.({
      phase: "inventory",
      completed: prepared.entries.length,
      total: prepared.entries.length,
      message: `Collected ${String(prepared.entries.length)} workspace files`,
    });
    this.recoverOrphanBuildsIfSupported(this.clock());
    const change = this.analyzeChanges(prepared.entries);
    const totalLangFiles = this.countLanguageEntries(prepared);
    const latestMeta = this.readLatestPublishedMeta();
    const degradedSyncSnapshot =
      latestMeta !== undefined &&
      latestMeta.analyzerFingerprint.includes("sync-run-degraded");
    if (!change && !degradedSyncSnapshot && latestMeta !== undefined) {
      const latest = this.repository.getLatestPublished(this.workspaceId);
      if (
        latest !== undefined &&
        (latest.snapshot.meta.state === "ready" || latest.snapshot.meta.state === "partial")
      ) {
        options.onProgress?.({
          phase: "reused",
          completed: totalLangFiles,
          total: totalLangFiles,
          message: `No changes; snapshot ${latest.snapshot.meta.id} is current`,
        });
        return this.noOpResult(
          prepared.entries,
          prepared.tsEntries.length,
          prepared.csEntries.length,
          latest,
          changeSet,
          totalLangFiles,
        );
      }
    }
    const claim = await this.claimBuildLeaseAsync(prepared, options, changeSet);
    if (claim.kind === "result") {
      return claim.result;
    }
    try {
      if (latestMeta !== undefined && !degradedSyncSnapshot) {
        const incremental = await this.tryRunIncrementalPipelineAsync(
          prepared,
          latestMeta,
          options,
          claim.lease,
        );
        if (incremental !== undefined) {
          return incremental;
        }
      }
      return await this.runPipelineAsync(prepared, options, claim.lease);
    } finally {
      claim.lease?.release();
    }
  }

  /**
   * Claims the workspace build lease before any analysis (finding 6).
   * - No lease-capable repository -> `{ kind: "claimed", lease: null }`.
   * - Lease free (or the holder is dead under the liveness rule) -> claimed.
   * - Live holder -> polls with exponential backoff (progress phase
   *   `waiting_for_peer`), bounded by `peerWaitTimeoutMs`. Once claimed after
   *   waiting, the inventory is re-checked against the snapshot the peer
   *   published; if it matches, the peer snapshot is reused WITHOUT analysis
   *   (outcome `reused_peer`). On timeout the run returns outcome `peer_busy`
   *   (or throws when nothing has ever been published).
   */
  private async claimBuildLeaseAsync(
    prepared: PreparedRun,
    options: IndexRunOptions,
    changeSet: readonly string[],
  ): Promise<LeaseClaim> {
    if (!isBuildLeaseStore(this.repository)) {
      return { kind: "claimed", lease: null };
    }
    const leaseStore = this.repository;
    this.recoverOrphanBuildsIfSupported(this.clock());
    const latestBeforeWait = this.readLatestPublishedMeta()?.snapshotId;
    const startedAt = performance.now();
    let pollMs = this.peerPollIntervalMs;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let waited = false;
    let lastHolder: BuildLeaseInfo | undefined;

    for (;;) {
      const leaseId = randomUUID();
      let acquired: ReturnType<BuildLeaseStore["acquireBuildLease"]> | undefined;
      try {
        acquired = leaseStore.acquireBuildLease({
          workspaceId: this.workspaceId,
          buildId: `pending:${leaseId}`,
          leaseId,
          ownerPid: process.pid,
          ...(this.hostLabel === undefined ? {} : { hostLabel: this.hostLabel }),
          nowIso: this.clock(),
          ttlMs: this.leaseTtlMs,
          ...this.leaseLivenessOptions(),
        });
      } catch (error) {
        // A peer holding the write lock longer than busy_timeout (e.g. while
        // publishing a large snapshot) is a reason to wait, not to fail.
        if (!isSqliteBusyError(error)) throw error;
        acquired = undefined;
      }
      if (acquired === undefined) {
        waited = true;
        if (performance.now() - startedAt >= this.peerWaitTimeoutMs) {
          throw new IndexingError(
            "indexing/internal",
            `The workspace database stayed locked by a concurrent writer for ${String(this.peerWaitTimeoutMs)} ms; gave up claiming the build lease`,
          );
        }
        await sleepMs(Math.max(1, pollMs));
        pollMs = Math.min(pollMs * 2, MAX_PEER_POLL_INTERVAL_MS);
        continue;
      }
      if (acquired.acquired) {
        const lease = this.startLeaseHeartbeat(leaseStore, leaseId);
        if (!waited) {
          return { kind: "claimed", lease };
        }
        const reused = this.tryReusePeerSnapshot(
          prepared,
          latestBeforeWait,
          lastHolder,
          changeSet,
        );
        if (reused !== undefined) {
          lease.release();
          options.onProgress?.({
            phase: "reused",
            completed: this.countLanguageEntries(prepared),
            total: this.countLanguageEntries(prepared),
            message: `A concurrent build published snapshot ${reused.snapshotId} first; reused it`,
          });
          return { kind: "result", result: reused };
        }
        return { kind: "claimed", lease };
      }

      lastHolder = acquired.holder;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= this.peerWaitTimeoutMs) {
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          return {
            kind: "result",
            result: this.waitingForPeerResult(
              latest,
              acquired.holder,
              prepared.entries.length,
              prepared.tsEntries.length,
              prepared.csEntries.length,
              [],
              [],
              waited ? elapsed : undefined,
            ),
          };
        }
        throw new GraphRepositoryError(
          "graph/build-already-active",
          `A concurrent index build (${describeLeaseHolder(acquired.holder)}) holds the build lease for workspace ${this.workspaceId} and no snapshot has been published yet; gave up waiting after ${String(Math.round(elapsed))} ms`,
        );
      }
      waited = true;
      const now = performance.now();
      if (now - lastProgressAt >= PEER_WAIT_PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        options.onProgress?.({
          phase: "waiting_for_peer",
          completed: 0,
          total: 0,
          message: `Waiting for a concurrent index build (${describeLeaseHolder(acquired.holder)}) to finish`,
        });
      }
      const remaining = this.peerWaitTimeoutMs - (performance.now() - startedAt);
      await sleepMs(Math.max(1, Math.min(pollMs, remaining)));
      pollMs = Math.min(pollMs * 2, MAX_PEER_POLL_INTERVAL_MS);
    }
  }

  /**
   * After waiting for a peer: if the peer published a snapshot with the same
   * configuration and the current inventory has no index-relevant change
   * relative to it, return a `reused_peer` result (no analysis).
   */
  private tryReusePeerSnapshot(
    prepared: PreparedRun,
    latestBeforeWait: string | undefined,
    peer: BuildLeaseInfo | undefined,
    changeSet: readonly string[],
  ): IndexRunResult | undefined {
    const latestMeta = this.readLatestPublishedMeta();
    if (latestMeta === undefined || latestMeta.snapshotId === latestBeforeWait) {
      return undefined;
    }
    if (latestMeta.configHash !== this.configHash) return undefined;
    if (latestMeta.analyzerFingerprint.includes("sync-run-degraded")) return undefined;
    if (this.analyzeChanges(prepared.entries)) return undefined;
    const latest = this.repository.getLatestPublished(this.workspaceId);
    if (
      latest === undefined ||
      (latest.snapshot.meta.state !== "ready" && latest.snapshot.meta.state !== "partial")
    ) {
      return undefined;
    }
    const totalLangFiles = this.countLanguageEntries(prepared);
    const base = this.noOpResult(
      prepared.entries,
      prepared.tsEntries.length,
      prepared.csEntries.length,
      latest,
      changeSet,
      totalLangFiles,
    );
    this.runCount = Math.max(this.runCount, latest.snapshot.meta.revision.sequence);
    return {
      ...base,
      reused: true,
      outcome: "reused_peer",
      warnings: [
        `A concurrent build (${describeLeaseHolder(peer)}) published snapshot ${latest.snapshot.meta.id} while this run waited; the workspace inventory matches it, so it was reused without re-analysis`,
      ],
    };
  }

  private countLanguageEntries(prepared: PreparedRun): number {
    return (
      prepared.tsEntries.length +
      prepared.csEntries.length +
      prepared.pyEntries.length +
      prepared.goEntries.length +
      prepared.rsEntries.length
    );
  }

  private readLatestPublishedMeta():
    | {
        readonly snapshotId: string;
        readonly configHash: string;
        readonly analyzerFingerprint: string;
        readonly state: PublishableState;
      }
    | undefined {
    if (typeof this.repository.getLatestSnapshotMeta === "function") {
      const meta = this.repository.getLatestSnapshotMeta(this.workspaceId);
      if (meta === undefined) return undefined;
      return {
        snapshotId: meta.snapshotId,
        configHash: meta.configHash,
        analyzerFingerprint: meta.analyzerFingerprint,
        state: meta.state,
      };
    }
    const latest = this.repository.getLatestPublished(this.workspaceId);
    if (latest === undefined) return undefined;
    const state = latest.snapshot.meta.state;
    if (state !== "ready" && state !== "partial") return undefined;
    return {
      snapshotId: latest.snapshot.meta.id,
      configHash: latest.snapshot.meta.configHash,
      analyzerFingerprint: latest.snapshot.meta.analyzerFingerprint,
      state,
    };
  }

  private hasConfigFileChanged(prepared: PreparedRun): boolean {
    const previousFiles = this.repository.listFiles(this.workspaceId);
    const prevConfigHashes = new Map<string, string>();
    for (const file of previousFiles) {
      if (
        isTsConfigFile(file.relativePath) ||
        isGoModFile(file.relativePath) ||
        isWorkspacePackageJsonFile(file.relativePath)
      ) {
        prevConfigHashes.set(file.relativePath, file.contentHash);
      }
    }
    const currentConfigs = [
      ...prepared.tsConfigEntries,
      ...prepared.goModEntries,
      ...prepared.packageJsonEntries,
    ];
    if (currentConfigs.length !== prevConfigHashes.size) return true;
    for (const cfg of currentConfigs) {
      if (prevConfigHashes.get(cfg.relativePath) !== cfg.contentHash) {
        return true;
      }
    }
    return false;
  }

  private persistFileFacts(
    currentLanguagePaths: ReadonlySet<string>,
    factMaps: readonly ReadonlyMap<string, FileFactRecord>[],
    diagnosticPaths: ReadonlySet<string>,
  ): void {
    if (!isFileFactStore(this.repository)) return;
    const store = this.repository;
    const toUpsert: FileFactRecord[] = [];
    for (const map of factMaps) {
      for (const [relativePath, record] of map) {
        if (!diagnosticPaths.has(relativePath)) {
          toUpsert.push(record);
        }
      }
    }
    const existingFacts = store.listFileFacts(this.workspaceId);
    this.withTransaction(() => {
      if (toUpsert.length > 0) {
        store.upsertFileFacts(toUpsert);
      }
      for (const existing of existingFacts) {
        if (
          !currentLanguagePaths.has(existing.relativePath) ||
          diagnosticPaths.has(existing.relativePath)
        ) {
          store.deleteFileFact(this.workspaceId, existing.relativePath);
        }
      }
    });
  }

  /**
   * Synchronous TS-only incremental early-cutoff path for `runIncrementalIndex`.
   */
  private tryRunSyncTsIncremental(
    prepared: PreparedRun,
    prevMeta: {
      readonly configHash: string;
      readonly analyzerFingerprint: string;
    },
  ): IndexRunResult | undefined {
    if (!isFileFactStore(this.repository)) return undefined;
    if (prepared.tsEntries.length === 0) return undefined;
    if (prevMeta.configHash !== this.configHash) return undefined;
    if (
      prevMeta.analyzerFingerprint.includes("sync-run-degraded") ||
      prevMeta.analyzerFingerprint.includes("worker-unavailable")
    ) {
      return undefined;
    }
    if (this.hasConfigFileChanged(prepared)) return undefined;

    const cachedFacts = this.repository.listFileFacts(
      this.workspaceId,
      prevMeta.analyzerFingerprint,
    );
    if (cachedFacts.length === 0) return undefined;
    const cachedTsByPath = new Map<string, FileFactRecord>();
    for (const fact of cachedFacts) {
      if (fact.language === "typescript") {
        cachedTsByPath.set(fact.relativePath, fact);
      }
    }
    if (cachedTsByPath.size === 0) return undefined;

    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const updatedAt = this.clock();
    const tsOutcome = this.runIncrementalTsLanguage(
      prepared.canonicalRoot,
      prepared.tsEntries,
      prepared.tsConfigEntries,
      prepared.packageJsonEntries.length > 0,
      cachedTsByPath,
      prevMeta.analyzerFingerprint,
      updatedAt,
      warnings,
      diagnostics,
    );
    if (tsOutcome === undefined) return undefined;

    const contentHashByPath = new Map<string, string>(
      prepared.entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );
    const createdAt = this.clock();
    const buildAttempt = this.openBuildOrRecover(
      prepared.entries,
      prevMeta.analyzerFingerprint,
      createdAt,
      prepared.canonicalRoot,
      prepared.entries.length,
      prepared.tsEntries.length,
      0,
      warnings,
      diagnostics,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const { opened, activeLease } = buildAttempt;
    try {
      const finalState: PublishableState =
        tsOutcome.output.state === "ready" && diagnostics.length === 0
          ? "ready"
          : "partial";
      try {
        this.syncInventoryRecords(prepared.entries);
        const nodeByKey = new Map<string, GraphNode>();
        this.withTransaction(() => {
          this.addAdapterGraph(
            opened.buildId,
            opened.workspaceNode,
            tsOutcome.output,
            contentHashByPath,
            nodeByKey,
          );
        });
        const diagnosticPaths = new Set(diagnostics.map((d) => d.relativePath));
        const currentLangPaths = new Set(
          prepared.tsEntries.map((entry) => entry.relativePath),
        );
        this.persistFileFacts(
          currentLangPaths,
          [tsOutcome.updatedFacts],
          diagnosticPaths,
        );
      } catch (error) {
        this.failBuild(opened.buildId, error);
      }
      return this.finalizePublish(
        opened.buildId,
        finalState,
        prepared.entries.length,
        prepared.tsEntries.length,
        0,
        warnings,
        diagnostics,
        {
          reanalyzedFiles: tsOutcome.reanalyzedFiles,
          cachedFiles: prepared.tsEntries.length - tsOutcome.reanalyzedFiles,
          earlyCutoffApplied: tsOutcome.earlyCutoffApplied,
        },
      );
    } finally {
      activeLease?.release();
    }
  }

  /**
   * Executes incremental TypeScript analysis with per-file `publicInterfaceHash`
   * early cutoff (Mokhov et al., ICFP 2018).
   */
  private runIncrementalTsLanguage(
    canonicalRoot: string,
    tsEntries: readonly InventoryEntry[],
    tsConfigEntries: readonly InventoryEntry[],
    hasWorkspacePackageJson: boolean,
    cachedByPath: ReadonlyMap<string, FileFactRecord>,
    analyzerFingerprint: string,
    updatedAt: string,
    warnings: string[],
    diagnostics: IndexDiagnostic[],
  ):
    | {
        readonly output: AdapterOutput;
        readonly updatedFacts: Map<string, FileFactRecord>;
        readonly reanalyzedFiles: number;
        readonly earlyCutoffApplied: boolean;
      }
    | undefined {
    const entryByPath = new Map(tsEntries.map((e) => [e.relativePath, e]));
    const currentPaths = new Set(entryByPath.keys());

    // Build reverse dependency map from cached facts
    const reverseDependents = new Map<string, Set<string>>();
    for (const [filePath, fact] of cachedByPath) {
      const parsed = parseFileFactPayload(fact);
      if (parsed === undefined) return undefined;
      for (const dep of parsed.importedPaths) {
        let rev = reverseDependents.get(dep);
        if (rev === undefined) {
          rev = new Set<string>();
          reverseDependents.set(dep, rev);
        }
        rev.add(filePath);
      }
    }

    const dirtySet = new Set<string>();
    for (const entry of tsEntries) {
      const prev = cachedByPath.get(entry.relativePath);
      if (prev === undefined || prev.contentHash !== entry.contentHash) {
        dirtySet.add(entry.relativePath);
      }
    }

    let interfaceChangedAny = false;
    for (const prevPath of cachedByPath.keys()) {
      if (!currentPaths.has(prevPath)) {
        interfaceChangedAny = true;
        const deps = reverseDependents.get(prevPath);
        if (deps !== undefined) {
          for (const dep of deps) {
            if (currentPaths.has(dep)) dirtySet.add(dep);
          }
        }
      }
    }

    const mergedFacts = new Map<string, FileFactRecord>();
    for (const [p, fact] of cachedByPath) {
      if (currentPaths.has(p)) {
        mergedFacts.set(p, fact);
      }
    }

    const reanalyzedSet = new Set<string>();
    const updatedFacts = new Map<string, FileFactRecord>();
    let earlyCutoffHits = 0;
    let state: "ready" | "partial" = "ready";

    for (let pass = 0; pass < 8; pass += 1) {
      const batch = [...dirtySet]
        .filter((p) => !reanalyzedSet.has(p) && entryByPath.has(p))
        .sort();
      if (batch.length === 0) break;

      const batchSet = new Set(batch);
      const batchEntries = batch.map((p) => entryByPath.get(p)!);
      const contextEntries = computeTsContextPaths(
        batch,
        tsEntries,
        mergedFacts,
        tsConfigEntries.length > 0,
        hasWorkspacePackageJson,
      );

      const adapterResult = analyzeTypeScriptProgram({
        workspaceId: this.workspaceId,
        rootDir: canonicalRoot,
        sources: contextEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
        configFiles: tsConfigEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
      });

      const batchDiagnostics = adapterResult.diagnostics.filter((d) =>
        batchSet.has(d.relativePath),
      );
      if (batchDiagnostics.length > 0) {
        state = "partial";
      }
      for (const diagnostic of batchDiagnostics) {
        const converted: IndexDiagnostic = {
          relativePath: diagnostic.relativePath,
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
        };
        diagnostics.push(converted);
        warnings.push(
          `diagnostic: ${converted.relativePath}:${String(converted.line)} ${converted.code} ${converted.message}`,
        );
      }
      warnings.push(...adapterResult.warnings);

      const freshFacts = partitionAdapterOutputByFile({
        workspaceId: this.workspaceId,
        analyzerFingerprint,
        language: "typescript",
        updatedAt,
        targetEntries: batchEntries,
        nodes: adapterResult.nodes,
        edges: adapterResult.edges,
        evidence: [],
      });

      for (const filePath of batch) {
        reanalyzedSet.add(filePath);
        const newFact = freshFacts.get(filePath);
        if (newFact === undefined) return undefined;
        const prevFact = cachedByPath.get(filePath);
        mergedFacts.set(filePath, newFact);
        updatedFacts.set(filePath, newFact);

        if (
          prevFact !== undefined &&
          newFact.publicInterfaceHash === prevFact.publicInterfaceHash
        ) {
          earlyCutoffHits += 1;
        } else {
          interfaceChangedAny = true;
          const dependents = reverseDependents.get(filePath);
          if (dependents !== undefined) {
            for (const dep of dependents) {
              if (currentPaths.has(dep) && !reanalyzedSet.has(dep)) {
                dirtySet.add(dep);
              }
            }
          }
        }
      }
    }

    for (const p of dirtySet) {
      if (entryByPath.has(p) && !reanalyzedSet.has(p)) {
        return undefined;
      }
    }

    const mergedOutput = mergeFileFactOutputs([...mergedFacts.values()], {
      analyzerId: TS_ADAPTER_ANALYZER_ID,
      analyzerVersion: TS_ADAPTER_VERSION,
      state,
    });
    if (mergedOutput === undefined) return undefined;

    return {
      output: mergedOutput,
      updatedFacts,
      reanalyzedFiles: reanalyzedSet.size,
      earlyCutoffApplied: earlyCutoffHits > 0 && !interfaceChangedAny,
    };
  }

  /**
   * Async per-file incremental indexing pipeline with early cutoff across all
   * configured languages (Task 2.6). Falls back cleanly (`undefined`) to full
   * `runPipelineAsync` whenever config/fingerprint/language-set changed or cache is cold.
   */
  private async tryRunIncrementalPipelineAsync(
    prepared: PreparedRun,
    prevMeta: {
      readonly configHash: string;
      readonly analyzerFingerprint: string;
    },
    options: IndexRunOptions,
    claimedLease?: ActiveBuildLeaseHandle | null,
  ): Promise<IndexRunResult | undefined> {
    if (!isFileFactStore(this.repository)) return undefined;
    if (prevMeta.configHash !== this.configHash) return undefined;
    if (
      prevMeta.analyzerFingerprint.includes("sync-run-degraded") ||
      prevMeta.analyzerFingerprint.includes("worker-unavailable")
    ) {
      return undefined;
    }
    if (this.hasConfigFileChanged(prepared)) return undefined;

    const totalLangFiles = this.countLanguageEntries(prepared);
    if (totalLangFiles === 0) return undefined;

    const cachedFacts = this.repository.listFileFacts(
      this.workspaceId,
      prevMeta.analyzerFingerprint,
    );
    if (cachedFacts.length === 0) return undefined;

    const cachedByLang = new Map<string, Map<string, FileFactRecord>>();
    for (const fact of cachedFacts) {
      let langMap = cachedByLang.get(fact.language);
      if (langMap === undefined) {
        langMap = new Map<string, FileFactRecord>();
        cachedByLang.set(fact.language, langMap);
      }
      langMap.set(fact.relativePath, fact);
    }

    // Ensure the set of active languages matches the cached fingerprint exactly
    const activeLangCounts: ReadonlyArray<readonly [string, readonly InventoryEntry[]]> = [
      ["typescript", prepared.tsEntries],
      ["csharp", prepared.csEntries],
      ["python", prepared.pyEntries],
      ["go", prepared.goEntries],
      ["rust", prepared.rsEntries],
    ];
    for (const [lang, langEntries] of activeLangCounts) {
      const hadLang = (cachedByLang.get(lang)?.size ?? 0) > 0;
      const hasLang = langEntries.length > 0;
      if (hadLang !== hasLang) {
        return undefined;
      }
    }

    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const updatedAt = this.clock();
    const adapterOutputs: AdapterOutput[] = [];
    const factMapsToPersist: Array<ReadonlyMap<string, FileFactRecord>> = [];
    let totalReanalyzed = 0;
    let earlyCutoffAppliedAny = false;
    let interfaceBrokeCutoffAny = false;
    let processedLangFiles = 0;

    options.onProgress?.({
      phase: "analyzing",
      completed: 0,
      total: totalLangFiles,
      message: "Running incremental dependency analysis",
    });

    // 1) TypeScript / JavaScript
    if (prepared.tsEntries.length > 0) {
      await yieldToEventLoop();
      const tsCached = cachedByLang.get("typescript") ?? new Map<string, FileFactRecord>();
      const tsOutcome = this.runIncrementalTsLanguage(
        prepared.canonicalRoot,
        prepared.tsEntries,
        prepared.tsConfigEntries,
        prepared.packageJsonEntries.length > 0,
        tsCached,
        prevMeta.analyzerFingerprint,
        updatedAt,
        warnings,
        diagnostics,
      );
      if (tsOutcome === undefined) return undefined;
      adapterOutputs.push(tsOutcome.output);
      factMapsToPersist.push(tsOutcome.updatedFacts);
      totalReanalyzed += tsOutcome.reanalyzedFiles;
      if (tsOutcome.reanalyzedFiles > 0) {
        if (tsOutcome.earlyCutoffApplied) {
          earlyCutoffAppliedAny = true;
        } else {
          interfaceBrokeCutoffAny = true;
        }
      }
      processedLangFiles += prepared.tsEntries.length;
      options.onProgress?.({
        phase: "analyzing",
        completed: processedLangFiles,
        total: totalLangFiles,
        message: `Analyzed TypeScript (${String(tsOutcome.reanalyzedFiles)} reanalyzed, ${String(prepared.tsEntries.length - tsOutcome.reanalyzedFiles)} cached)`,
      });
      await yieldToEventLoop();
    }

    // 2) Sidecar languages (C#, Python, Go, Rust) — skip adapter completely when 0 files changed!
    const sidecarSpecs: ReadonlyArray<{
      readonly lang: "csharp" | "python" | "go" | "rust";
      readonly entries: readonly InventoryEntry[];
      readonly analyzerId: string;
      readonly analyzerVersion: string;
      readonly runAdapter: (subset: readonly InventoryEntry[]) => Promise<{
        readonly workerAvailable: boolean;
        readonly state: "ready" | "partial";
        readonly nodes: readonly SnapshotNodeInput[];
        readonly edges: readonly SnapshotEdgeInput[];
        readonly evidence: readonly SnapshotEvidenceInput[];
        readonly diagnostics: readonly RoslynAdapterDiagnostic[];
        readonly warnings: readonly string[];
      }>;
    }> = [
      {
        lang: "csharp",
        entries: prepared.csEntries,
        analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
        analyzerVersion: CSHARP_ROSLYN_ADAPTER_VERSION,
        runAdapter: (subset) =>
          this.analyzeCSharpFn({
            workspaceId: this.workspaceId,
            rootDir: prepared.canonicalRoot,
            files: subset.map((entry) => ({
              path: entry.relativePath,
              content: entry.content,
            })),
            options: {
              dotnetCommand: this.csharpSettings.dotnetCommand,
              requestTimeoutMs: this.csharpSettings.requestTimeoutMs,
              workerDllPath: this.csharpSettings.workerDllPath,
            },
          }),
      },
      {
        lang: "python",
        entries: prepared.pyEntries,
        analyzerId: PYTHON_WORKER_ADAPTER_ID,
        analyzerVersion: PYTHON_WORKER_ADAPTER_VERSION,
        runAdapter: (subset) =>
          analyzePythonWorkspace({
            workspaceId: this.workspaceId,
            files: subset.map((entry) => ({
              path: entry.relativePath,
              content: entry.content,
            })),
            options: {
              pythonCommand: this.pythonSettings.pythonCommand,
              requestTimeoutMs: this.pythonSettings.requestTimeoutMs,
              workerScriptPath: this.pythonSettings.workerScriptPath,
              responseMaxChars: this.pythonSettings.responseMaxChars,
            },
          }),
      },
      {
        lang: "go",
        entries: prepared.goEntries,
        analyzerId: GO_ADAPTER_ID,
        analyzerVersion: GO_ADAPTER_VERSION,
        runAdapter: (subset) =>
          analyzeGoWorkspace({
            workspaceId: this.workspaceId,
            files: subset.map((entry) => ({
              path: entry.relativePath,
              content: entry.content,
            })),
            ...(prepared.goModEntries.length > 0
              ? {
                  moduleFiles: prepared.goModEntries.map((entry) => ({
                    relativePath: entry.relativePath,
                    content: entry.content,
                  })),
                }
              : {}),
            options: {
              goBinaryPath: this.goSettings.goBinaryPath,
              ...(this.goSettings.goWorkerBinaryPath.length > 0
                ? { goWorkerBinaryPath: this.goSettings.goWorkerBinaryPath }
                : {}),
              workerDir: this.goSettings.workerDir,
              requestTimeoutMs: this.goSettings.requestTimeoutMs,
            },
          }),
      },
      {
        lang: "rust",
        entries: prepared.rsEntries,
        analyzerId: RUST_ADAPTER_ID,
        analyzerVersion: RUST_ADAPTER_VERSION,
        runAdapter: (subset) =>
          analyzeRustWorkspace({
            workspaceId: this.workspaceId,
            files: subset.map((entry) => ({
              path: entry.relativePath,
              content: entry.content,
            })),
            options: {
              ...(this.hasExplicitRustWorkerDir
                ? { workerDir: this.rustSettings.workerDir }
                : {}),
              workerBinaryName: this.rustSettings.workerBinaryName,
              ...(this.rustSettings.cargoHomeDir.length > 0
                ? { cargoHomeDir: this.rustSettings.cargoHomeDir }
                : {}),
              requestTimeoutMs: this.rustSettings.requestTimeoutMs,
              responseMaxChars: this.rustSettings.responseMaxChars,
              cargoBuildTimeoutMs: this.rustSettings.cargoBuildTimeoutMs,
            },
          }),
      },
    ];

    for (const spec of sidecarSpecs) {
      if (spec.entries.length === 0) continue;
      const langCached = cachedByLang.get(spec.lang) ?? new Map<string, FileFactRecord>();
      const entryByPath = new Map(spec.entries.map((e) => [e.relativePath, e]));
      const currentPaths = new Set(entryByPath.keys());

      const dirtyEntries = spec.entries.filter((entry) => {
        const prev = langCached.get(entry.relativePath);
        return prev === undefined || prev.contentHash !== entry.contentHash;
      });
      const hasDeleted = [...langCached.keys()].some((p) => !currentPaths.has(p));

      if (dirtyEntries.length === 0 && !hasDeleted) {
        const merged = mergeFileFactOutputs([...langCached.values()], {
          analyzerId: spec.analyzerId,
          analyzerVersion: spec.analyzerVersion,
          state: "ready",
        });
        if (merged === undefined) return undefined;
        adapterOutputs.push(merged);
      } else {
        // Re-analyze language files with full cross-file context so zero sidecar edge is lost
        const res = await spec.runAdapter(spec.entries);
        if (!res.workerAvailable) return undefined;
        for (const diag of res.diagnostics) {
          diagnostics.push(toDiagnostic(diag));
          warnings.push(
            `diagnostic: ${diag.relativePath}:${String(diag.line)} ${diag.code} ${diag.message}`,
          );
        }
        warnings.push(...res.warnings);
        const freshMap = partitionAdapterOutputByFile({
          workspaceId: this.workspaceId,
          analyzerFingerprint: prevMeta.analyzerFingerprint,
          language: spec.lang,
          updatedAt,
          targetEntries: spec.entries,
          nodes: res.nodes,
          edges: res.edges,
          evidence: res.evidence,
        });
        adapterOutputs.push({
          analyzerId: spec.analyzerId,
          analyzerVersion: spec.analyzerVersion,
          state: res.state,
          nodes: res.nodes,
          edges: res.edges,
          evidence: res.evidence,
        });
        factMapsToPersist.push(freshMap);
        totalReanalyzed += spec.entries.length;
        interfaceBrokeCutoffAny = true;
      }

      processedLangFiles += spec.entries.length;
      options.onProgress?.({
        phase: "analyzing",
        completed: processedLangFiles,
        total: totalLangFiles,
        message: `Processed ${spec.lang} files`,
      });
    }

    const contentHashByPath = new Map<string, string>(
      prepared.entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );
    const createdAt = this.clock();

    await yieldToEventLoop();
    options.onProgress?.({
      phase: "building",
      completed: totalLangFiles,
      total: totalLangFiles,
      message: "Building incremental snapshot graph",
    });

    const buildAttempt = this.openBuildOrRecover(
      prepared.entries,
      prevMeta.analyzerFingerprint,
      createdAt,
      prepared.canonicalRoot,
      prepared.entries.length,
      prepared.tsEntries.length,
      prepared.csEntries.length,
      warnings,
      diagnostics,
      claimedLease,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const { opened, activeLease } = buildAttempt;

    try {
      let finalState: PublishableState = "ready";
      try {
        this.syncInventoryRecords(prepared.entries);
        const nodeByKey = new Map<string, GraphNode>();
        this.withTransaction(() => {
          for (const output of adapterOutputs) {
            this.addAdapterGraph(
              opened.buildId,
              opened.workspaceNode,
              output,
              contentHashByPath,
              nodeByKey,
            );
            if (output.state !== "ready") finalState = "partial";
          }
        });
        if (diagnostics.length > 0) finalState = "partial";

        const diagnosticPaths = new Set(diagnostics.map((d) => d.relativePath));
        const currentLangPaths = new Set<string>([
          ...prepared.tsEntries.map((e) => e.relativePath),
          ...prepared.csEntries.map((e) => e.relativePath),
          ...prepared.pyEntries.map((e) => e.relativePath),
          ...prepared.goEntries.map((e) => e.relativePath),
          ...prepared.rsEntries.map((e) => e.relativePath),
        ]);
        this.persistFileFacts(currentLangPaths, factMapsToPersist, diagnosticPaths);
      } catch (error) {
        this.failBuild(opened.buildId, error);
      }

      options.onProgress?.({
        phase: "publishing",
        completed: totalLangFiles,
        total: totalLangFiles,
        message: "Publishing incremental snapshot",
      });
      const result = this.finalizePublish(
        opened.buildId,
        finalState,
        prepared.entries.length,
        prepared.tsEntries.length,
        prepared.csEntries.length,
        warnings,
        diagnostics,
        {
          reanalyzedFiles: totalReanalyzed,
          cachedFiles: totalLangFiles - totalReanalyzed,
          earlyCutoffApplied: earlyCutoffAppliedAny && !interfaceBrokeCutoffAny,
        },
      );
      options.onProgress?.({
        phase: "done",
        completed: totalLangFiles,
        total: totalLangFiles,
        message: `Published snapshot ${result.snapshotId}`,
      });
      return result;
    } finally {
      activeLease?.release();
    }
  }

  /**
   * Karma tabanlı değişim analizi (senkron + async ortak karar girdisi):
   * önceki files tablosu karmalarıyla güncel envanter karşılaştırılır.
   * Dil kümeleri (TS, C# ve M2 ile python/go/rust) birlikte değerlendirilir
   * (hepsi graph'a katkı verir); dil-dışı dosyalar kararı etkilemez (bkz.
   * noOpResult).
   */
  private analyzeChanges(entries: readonly InventoryEntry[]): boolean {
    const previousHashes = new Map(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => [record.relativePath, record.contentHash]),
    );
    const relevantEntries = entries.filter((entry) =>
      this.isIndexRelevantFile(entry.relativePath),
    );
    const relevantPaths = new Set(
      relevantEntries.map((entry) => entry.relativePath),
    );
    const changedSources = relevantEntries.filter(
      (entry) => previousHashes.get(entry.relativePath) !== entry.contentHash,
    );
    const deletedSources = [...previousHashes.keys()].filter(
      (relativePath) =>
        this.isIndexRelevantFile(relativePath) &&
        !relevantPaths.has(relativePath),
    );
    return changedSources.length > 0 || deletedSources.length > 0;
  }

  /** Değişim analizinde yeniden indeksleme tetikleyen dosya mı (dil kaynağı, TS/JS config, go.mod veya workspace package.json). */
  private isIndexRelevantFile(relativePath: string): boolean {
    return (
      this.isLanguageSource(path.extname(relativePath).toLowerCase()) ||
      isTsConfigFile(relativePath) ||
      isGoModFile(relativePath) ||
      isWorkspacePackageJsonFile(relativePath)
    );
  }

  /** Uzantının dil pipeline kapsamında olup olmadığı (senkron + async ortak). */
  private isLanguageSource(extension: string): boolean {
    return (
      TS_EXTENSIONS.has(extension) ||
      CS_EXTENSIONS.has(extension) ||
      PY_EXTENSIONS.has(extension) ||
      GO_EXTENSIONS.has(extension) ||
      RS_EXTENSIONS.has(extension)
    );
  }

  /**
   * No-op koşumu (senkron + async ortak): graph korunur, files tablosu
   * tazelenir, published=false. Güvenlik bulgusu 3 mutabakatı burada da
   * uygulanır: envanterde karşılığı olmayan kayıtlar düşürülür.
   */
  private noOpResult(
    entries: readonly InventoryEntry[],
    tsFileCount: number,
    csFileCount: number,
    latest: NonNullable<ReturnType<GraphRepository["getLatestPublished"]>>,
    changeSet: readonly string[],
    cachedLanguageFileCount = tsFileCount + csFileCount,
  ): IndexRunResult {
    // Güvenlik bulgusu 3: mutabakat upsert'lerden ÖNCE okunur.
    const previousFilePaths = new Set(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => record.relativePath),
    );
    const currentPaths = new Set(entries.map((entry) => entry.relativePath));
    const updatedAt = this.clock();
    this.withTransaction(() => {
      for (const entry of entries) {
        this.repository.upsertFile({
          workspaceId: this.workspaceId,
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          sizeBytes: entry.sizeBytes,
          updatedAt,
        });
      }
      for (const previousPath of previousFilePaths) {
        if (!currentPaths.has(previousPath)) {
          this.repository.deleteFile(this.workspaceId, previousPath);
        }
      }
    });
    return {
      snapshotId: latest.snapshot.meta.id,
      snapshot: latest.snapshot,
      stale: latest.stale,
      fileCount: entries.length,
      tsFileCount,
      csFileCount,
      // Bu dala girmenin ön koşulu meta.state ready|partial'dır; derin
      // özellik zinciri TS daraltmasını taşımadığı için açık daraltma.
      state: latest.snapshot.meta.state === "ready" ? "ready" : "partial",
      warnings: [
        "incremental no-op: no index-relevant change; the current snapshot was kept and the files table was refreshed",
        `change set: ${changeSet.length === 0 ? "(empty)" : changeSet.join(", ")}`,
      ],
      diagnostics: [],
      published: false,
      outcome: "unchanged",
      reanalyzedFiles: 0,
      cachedFiles: cachedLanguageFileCount,
      earlyCutoffApplied: false,
    };
  }

  /** Ortak hazırlık: yetki + workspace kaydı + senkron tam envanter (Discover). */
  private prepareRun(rootPath: string): PreparedRun {
    const canonicalRoot = this.authorizeAndRegister(rootPath);
    const entries = collectInventory(this.policy, canonicalRoot, this.limits.maxFiles);
    return this.partitionPreparedRun(canonicalRoot, entries);
  }

  /** Non-blocking async hazırlık: yetki + workspace kaydı + async envanter (v0.2.3). */
  private async prepareRunAsync(rootPath: string): Promise<PreparedRun> {
    const canonicalRoot = this.authorizeAndRegister(rootPath);
    const entries = await collectInventoryAsync(
      this.policy,
      canonicalRoot,
      this.limits.maxFiles,
    );
    return this.partitionPreparedRun(canonicalRoot, entries);
  }

  private authorizeAndRegister(rootPath: string): string {
    const rootDecision = this.policy.authorizeRoot(rootPath);
    if (!rootDecision.allowed) {
      throw new IndexingError(
        "indexing/root-not-authorized",
        `root is not authorized (${rootDecision.code}): ${rootDecision.reason}`,
      );
    }
    this.ensureWorkspaceRegistered();
    return rootDecision.canonicalRoot;
  }

  private partitionPreparedRun(
    canonicalRoot: string,
    entries: InventoryEntry[],
  ): PreparedRun {
    const tsEntries = entries.filter((entry) =>
      TS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const tsConfigEntries = entries.filter((entry) =>
      isTsConfigFile(entry.relativePath),
    );
    const packageJsonEntries = entries.filter((entry) =>
      isWorkspacePackageJsonFile(entry.relativePath),
    );
    const csEntries = entries.filter((entry) =>
      CS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const pyEntries = entries.filter((entry) =>
      PY_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const goEntries = entries.filter((entry) =>
      GO_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const goModEntries = entries.filter((entry) => isGoModFile(entry.relativePath));
    const rsEntries = entries.filter((entry) =>
      RS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    return {
      canonicalRoot,
      entries,
      tsEntries,
      tsConfigEntries,
      packageJsonEntries,
      csEntries,
      pyEntries,
      goEntries,
      goModEntries,
      rsEntries,
    };
  }

  private withTransaction<T>(fn: () => T): T {
    return this.repository.runInTransaction ? this.repository.runInTransaction(fn) : fn();
  }

  /**
   * Envanter kayıtlarını files tablosuna yansıtır (TŞ §9 files tablosu =
   * güncel envanter karşılığı); silme mutabakatı güvenlik bulgusu 3.
   */
  private syncInventoryRecords(entries: readonly InventoryEntry[]): void {
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );
    // upsert'lerden ÖNCE okunur (mutabakat temeli).
    const previousFilePaths = new Set(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => record.relativePath),
    );
    const updatedAt = this.clock();
    this.withTransaction(() => {
      for (const entry of entries) {
        this.repository.upsertFile({
          workspaceId: this.workspaceId,
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          sizeBytes: entry.sizeBytes,
          updatedAt,
        });
      }
      for (const previousPath of previousFilePaths) {
        if (!contentHashByPath.has(previousPath)) {
          this.repository.deleteFile(this.workspaceId, previousPath);
        }
      }
    });
  }

  /** Build açar + Workspace node'unu ekler (her koşumun ortak başlangıcı). */
  private openBuild(
    analyzerFingerprint: string,
    createdAt: string,
    canonicalRoot: string,
  ): {
    readonly buildId: string;
    readonly workspaceNode: GraphNode;
    readonly build: ReturnType<GraphRepository["beginBuild"]>;
  } {
    const revision = { id: "working-tree", sequence: this.runCount + 1 };
    const build = this.repository.beginBuild({
      workspaceId: this.workspaceId,
      revision,
      configHash: this.configHash,
      analyzerFingerprint,
      createdAt,
    });
    const workspaceNode: GraphNode = {
      id: nodeId({
        workspaceId: this.workspaceId,
        kind: "Workspace",
        qualifiedName: this.workspaceId,
      }),
      kind: "Workspace",
      qualifiedName: this.workspaceId,
      attributes: { rootPath: canonicalRoot },
    };
    this.repository.addNode(build.buildId, workspaceNode);
    return { buildId: build.buildId, workspaceNode, build };
  }

  /**
   * Eşzamanlı build/publish yarışında yayımlanmış snapshot üzerinden zarif
   * sonuç üretir ve yerel sequence sayacını ileri hizalar.
   */
  private concurrentReuseResult(
    latest: NonNullable<ReturnType<GraphRepository["getLatestPublished"]>>,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: readonly string[],
    diagnostics: readonly IndexDiagnostic[],
    raceWarning: string,
  ): IndexRunResult {
    this.runCount = Math.max(this.runCount, latest.snapshot.meta.revision.sequence);
    return {
      snapshotId: latest.snapshot.meta.id,
      snapshot: latest.snapshot,
      stale: latest.stale,
      fileCount,
      tsFileCount,
      csFileCount,
      state: latest.snapshot.meta.state === "ready" ? "ready" : "partial",
      warnings: [...warnings, raceWarning],
      diagnostics,
      published: false,
      reused: true,
      outcome: "reused_peer",
    };
  }

  /**
   * Honest deferred result when a live peer currently holds the build lease
   * (or an active peer build is running): never fakes fresh completion, returns
   * explicit `peerStatus: "waiting_for_peer"`, `waitingForPeer: true`, `reused: true`,
   * and an actionable warning referencing the live peer.
   */
  private waitingForPeerResult(
    latest: NonNullable<ReturnType<GraphRepository["getLatestPublished"]>>,
    holder: BuildLeaseInfo | undefined,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: readonly string[],
    diagnostics: readonly IndexDiagnostic[],
    waitedMs?: number,
  ): IndexRunResult {
    this.runCount = Math.max(this.runCount, latest.snapshot.meta.revision.sequence);
    const waitedText =
      waitedMs === undefined ? "" : ` after waiting ${String(Math.round(waitedMs))} ms`;
    const peerWarning = `waiting_for_peer: a concurrent index build (${describeLeaseHolder(holder)}) still holds the build lease${waitedText}; this run built nothing and the existing published snapshot ${latest.snapshot.meta.id} is still served`;
    return {
      snapshotId: latest.snapshot.meta.id,
      snapshot: latest.snapshot,
      stale: latest.stale,
      fileCount,
      tsFileCount,
      csFileCount,
      state: latest.snapshot.meta.state === "ready" ? "ready" : "partial",
      warnings: [...warnings, peerWarning],
      diagnostics,
      published: false,
      reused: true,
      waitingForPeer: true,
      peerStatus: "waiting_for_peer",
      outcome: "peer_busy",
      ...(holder === undefined ? {} : { peerLease: holder }),
    };
  }

  /**
   * Çoklu-süreç SQLite yarış modunda build açmadan hemen önce yayımlanmış
   * en güncel snapshot'ı kontrol eder:
   * - Birebir aynı dosya/karma + analyzerFingerprint + configHash kopyasıysa
   *   `runCount = latest.sequence - 1` ile UNIQUE(id) tekilleştirmesini korur,
   * - Aksi hâlde (başka süreç ilerledikten sonra dosyalar/ayarlar değiştiyse)
   *   `runCount = latest.sequence` ile yayını `N + 1` olarak monotonik ilerletir.
   */
  private syncRunCountBeforeBuild(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
  ): void {
    if (!this.tolerateConcurrentPublishRace) return;
    const latest = this.repository.getLatestPublished(this.workspaceId);
    if (latest === undefined || latest.snapshot.meta.revision.sequence <= this.runCount) {
      return;
    }
    if (this.matchesPublishedSnapshotInputs(entries, analyzerFingerprint, latest.snapshot)) {
      this.runCount = latest.snapshot.meta.revision.sequence - 1;
    } else {
      this.runCount = latest.snapshot.meta.revision.sequence;
    }
  }

  private matchesPublishedSnapshotInputs(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
    snapshot: SnapshotGraph,
  ): boolean {
    if (snapshot.meta.configHash !== this.configHash) return false;
    if (snapshot.meta.analyzerFingerprint !== analyzerFingerprint) return false;

    const repoFiles = this.repository.listFiles(this.workspaceId);
    if (repoFiles.length !== entries.length) return false;
    const repoHashByPath = new Map(
      repoFiles.map((record) => [record.relativePath, record.contentHash]),
    );
    const entryHashByPath = new Map<string, string>();
    let languageEntryCount = 0;
    for (const entry of entries) {
      if (repoHashByPath.get(entry.relativePath) !== entry.contentHash) {
        return false;
      }
      entryHashByPath.set(entry.relativePath, entry.contentHash);
      if (this.isLanguageSource(path.extname(entry.relativePath).toLowerCase())) {
        languageEntryCount += 1;
      }
    }

    let snapshotFileNodeCount = 0;
    for (const node of snapshot.nodes) {
      if (node.kind !== "File") continue;
      snapshotFileNodeCount += 1;
      if (
        node.location === undefined ||
        entryHashByPath.get(node.location.relativePath) !== node.location.sourceHash
      ) {
        return false;
      }
    }
    return snapshotFileNodeCount === languageEntryCount;
  }

  /**
   * Recovers any orphaned builds first, acquires the single-writer heartbeat lease
   * (when backed by a lease-capable repository), and opens a new build.
   * When a live peer holds a valid non-expired lease (or `graph/build-already-active`
   * occurs with a live peer), honestly returns `peerStatus: "waiting_for_peer"` with
   * the existing published snapshot (or throws fail-closed if none exists yet).
   */
  private openBuildOrRecover(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
    createdAt: string,
    canonicalRoot: string,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: readonly string[],
    diagnostics: readonly IndexDiagnostic[],
    preClaimed?: ActiveBuildLeaseHandle | null,
  ):
    | {
        readonly kind: "opened";
        readonly opened: ReturnType<IndexService["openBuild"]>;
        readonly activeLease: ActiveBuildLeaseHandle | undefined;
      }
    | { readonly kind: "reused"; readonly result: IndexRunResult } {
    this.recoverOrphanBuildsIfSupported(createdAt);
    this.syncRunCountBeforeBuild(entries, analyzerFingerprint);

    let activeLease: ActiveBuildLeaseHandle | undefined =
      preClaimed === null ? undefined : preClaimed;
    const leaseStore = isBuildLeaseStore(this.repository) ? this.repository : undefined;
    if (leaseStore !== undefined && preClaimed === undefined) {
      // Synchronous path: claim at open time without waiting (async runs
      // claim before analysis in claimBuildLeaseAsync).
      const leaseId = randomUUID();
      const provisionalBuildId = `pending:${leaseId}`;
      const acquired = leaseStore.acquireBuildLease({
        workspaceId: this.workspaceId,
        buildId: provisionalBuildId,
        leaseId,
        ownerPid: process.pid,
        ...(this.hostLabel === undefined ? {} : { hostLabel: this.hostLabel }),
        nowIso: createdAt,
        ttlMs: this.leaseTtlMs,
        ...this.leaseLivenessOptions(),
      });
      if (!acquired.acquired) {
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          return {
            kind: "reused",
            result: this.waitingForPeerResult(
              latest,
              acquired.holder,
              fileCount,
              tsFileCount,
              csFileCount,
              warnings,
              diagnostics,
            ),
          };
        }
        throw new GraphRepositoryError(
          "graph/build-already-active",
          `waiting_for_peer: a concurrent index build (${describeLeaseHolder(acquired.holder)}) holds the build lease for workspace ${this.workspaceId} and no snapshot has been published yet`,
        );
      }
      activeLease = this.startLeaseHeartbeat(leaseStore, leaseId);
    }

    try {
      const openAndBind = (): ReturnType<IndexService["openBuild"]> => {
        const opened = this.openBuild(analyzerFingerprint, createdAt, canonicalRoot);
        if (leaseStore !== undefined && activeLease !== undefined) {
          const bound = leaseStore.bindBuildLeaseBuildId?.(
            this.workspaceId,
            activeLease.leaseId,
            opened.buildId,
          );
          if (bound === false) {
            throw new GraphRepositoryError(
              "graph/build-already-active",
              `build lease ${activeLease.leaseId} was lost before binding build ${opened.buildId}`,
            );
          }
        }
        return opened;
      };
      const opened =
        leaseStore?.withImmediateTransaction !== undefined
          ? leaseStore.withImmediateTransaction(openAndBind)
          : openAndBind();
      return {
        kind: "opened",
        opened,
        activeLease,
      };
    } catch (error) {
      activeLease?.release();
      if (
        this.tolerateConcurrentPublishRace &&
        error instanceof GraphRepositoryError &&
        (error.code === "graph/build-already-active" ||
          (error.code === "storage/driver-error" &&
            error.message.includes("snapshots.workspace_id")))
      ) {
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          const holder = leaseStore?.getActiveBuildLease(this.workspaceId);
          return {
            kind: "reused",
            result: this.waitingForPeerResult(
              latest,
              holder,
              fileCount,
              tsFileCount,
              csFileCount,
              warnings,
              diagnostics,
            ),
          };
        }
      }
      throw error;
    }
  }

  /**
   * Build'i yayımlar; tolerateConcurrentPublishRace aktifken graph/publish-failed
   * yarışında önce kaybeden build satırını failBuild ile temizler, ardından
   * mevcut yayımlanmış snapshot varsa onu döner (yoksa normal hata yolu).
   */
  private finalizePublish(
    buildId: string,
    state: PublishableState,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: string[],
    diagnostics: IndexDiagnostic[],
    incrementalTelemetry?: {
      readonly reanalyzedFiles: number;
      readonly cachedFiles: number;
      readonly earlyCutoffApplied: boolean;
    },
  ): IndexRunResult {
    const publishedAt = this.clock();
    let snapshot: SnapshotGraph;
    try {
      snapshot = this.repository.publish(buildId, state, publishedAt);
    } catch (error) {
      if (
        this.tolerateConcurrentPublishRace &&
        error instanceof GraphRepositoryError &&
        error.code === "graph/publish-failed"
      ) {
        try {
          this.repository.failBuild(buildId, "concurrent snapshot publish race");
        } catch {
          // Build satırı zaten aktif değilse yutulur.
        }
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          return this.concurrentReuseResult(
            latest,
            fileCount,
            tsFileCount,
            csFileCount,
            warnings,
            diagnostics,
            "concurrent snapshot publish race (graph/publish-failed): reused existing published snapshot",
          );
        }
        throw new IndexingError("indexing/internal", `graph store rejected the operation: ${error.message}`);
      }
      this.failBuild(buildId, error);
    }
    try {
      this.indexPublishedSymbols(snapshot);
    } catch (error) {
      if (error instanceof GraphRepositoryError) {
        throw new IndexingError("indexing/internal", `graph store rejected the operation: ${error.message}`);
      }
      throw error;
    }
    this.runCount += 1;
    const stale =
      typeof this.repository.getLatestSnapshotMeta === "function"
        ? (this.repository.getLatestSnapshotMeta(this.workspaceId)?.stale ?? false)
        : (this.repository.getLatestPublished(this.workspaceId)?.stale ?? false);
    return {
      snapshotId: snapshot.meta.id,
      snapshot,
      stale,
      fileCount,
      tsFileCount,
      csFileCount,
      state,
      warnings,
      diagnostics,
      published: true,
      outcome: "published",
      ...(incrementalTelemetry === undefined ? {} : incrementalTelemetry),
    };
  }

  /**
   * SENKRON pipeline (runIndex/runIncrementalIndex gövdesi). C# derin
   * analizi YOKTUR: worker async koşar, senkron imza onu bekleyemez ve bu
   * yol worker'ı hiç başlatmaz — C# L0 File node'ları envanterden türetilir
   * (adapter L0/L1 fallback node şemasıyla birebir: kind File, language
   * csharp, attributes.sourceHash) ve durum partial'a zorlanır.
   *
   * M2: python/go/rust dosyaları için aynı köprü sözleşmesi geçerlidir —
   * sidecar worker'lar async koşar; senkron yol onları SPAWN ETMEZ, L0
   * envanter düzeyinde temsil eder ve bunu explicit warning + partial
   * fingerprint etiketiyle (pystate/gostate/ruststate=sync-run-degraded)
   * raporlar.
   *
   * Girdi aynıysa çıktı graph JSON'ı birebir aynıdır (TŞ §8 invariant vi);
   * mod bilgisi graph meta'sına girmez.
   */
  private runPipeline(prepared: PreparedRun): IndexRunResult {
    const {
      canonicalRoot,
      entries,
      tsEntries,
      tsConfigEntries,
      csEntries,
      pyEntries,
      goEntries,
      rsEntries,
    } = prepared;
    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );

    const createdAt = this.clock();
    const fingerprint = buildAnalyzerFingerprint({
      typescript:
        tsEntries.length > 0
          ? { analyzerId: TS_ADAPTER_ANALYZER_ID, version: TS_ADAPTER_VERSION }
          : null,
      csharp:
        csEntries.length > 0
          ? {
              analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
              version: CSHARP_ROSLYN_ADAPTER_VERSION,
              discovery: "sync-run-degraded",
              refPacks: null,
              settings: this.csharpSettings,
            }
          : null,
      python:
        pyEntries.length > 0
          ? {
              analyzerId: PYTHON_WORKER_ADAPTER_ID,
              version: PYTHON_WORKER_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.pythonSettings,
            }
          : null,
      go:
        goEntries.length > 0
          ? {
              analyzerId: GO_ADAPTER_ID,
              version: GO_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.goSettings,
            }
          : null,
      rust:
        rsEntries.length > 0
          ? {
              analyzerId: RUST_ADAPTER_ID,
              version: RUST_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.rustSettings,
            }
          : null,
    });
    const buildAttempt = this.openBuildOrRecover(
      entries,
      fingerprint,
      createdAt,
      canonicalRoot,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const { opened, activeLease } = buildAttempt;

    try {
      let finalState: PublishableState = "partial";
      let emptyLanguageRun = false;
      try {
        // Erken çıkış: analiz edilebilir dil kaynağı yok (orijinal davranış,
        // genelleştirilmiş uyarı; tek Workspace node'uyla partial publish).
        // M2 denetim bulgusu düzeltmesi: kapsam beş dile genişlediğinden
        // uyarı metni de beş dili sayar (yalnızca hiçbir dil dosyası yokken
        // bu dala girilir).
        if (
          tsEntries.length === 0 &&
          csEntries.length === 0 &&
          pyEntries.length === 0 &&
          goEntries.length === 0 &&
          rsEntries.length === 0
        ) {
          // Envanter mutabakatı: bu dalda adapter koşumu YOK, sıralama
          // tehlikesi yok — build'e girmeden mutabakat yapılır (async yol
          // sözleşmesiyle aynı mutabakat garantisi).
          this.syncInventoryRecords(entries);
          warnings.push(
            "the workspace contains no analyzable TypeScript/TSX/C#/Python/Go/Rust sources; coverage is zero (published as partial)",
          );
          for (const entry of entries) {
            warnings.push(`file is in the inventory but outside every language adapter: ${entry.relativePath}`);
          }
          emptyLanguageRun = true;
        } else {

        const nodeByKey = new Map<string, GraphNode>();
        let tsState: "ready" | "partial" = "ready";
        let syncTsNodes: readonly SnapshotNodeInput[] = [];
        let syncTsEdges: readonly SnapshotEdgeInput[] = [];
        if (tsEntries.length > 0) {
          // TS adapter (salt-okunur kaynak çantası; rootDir çözümleme
          // çapasıdır, adapter diske YAZMAZ — ADR-008).
          const adapterResult = analyzeTypeScriptProgram({
            workspaceId: this.workspaceId,
            rootDir: canonicalRoot,
            sources: tsEntries.map((entry) => ({
              relativePath: entry.relativePath,
              content: entry.content,
            })),
            configFiles: tsConfigEntries.map((entry) => ({
              relativePath: entry.relativePath,
              content: entry.content,
            })),
          });
          tsState = adapterResult.state;
          syncTsNodes = adapterResult.nodes;
          syncTsEdges = adapterResult.edges;
          for (const diagnostic of adapterResult.diagnostics) {
            const converted: IndexDiagnostic = {
              relativePath: diagnostic.relativePath,
              code: diagnostic.code,
              message: diagnostic.message,
              line: diagnostic.line,
            };
            diagnostics.push(converted);
            warnings.push(
              `diagnostic: ${converted.relativePath}:${String(converted.line)} ${converted.code} ${converted.message}`,
            );
          }
          warnings.push(...adapterResult.warnings);
          this.withTransaction(() => {
            this.addAdapterGraph(
              opened.buildId,
              opened.workspaceNode,
              {
                analyzerId: TS_ADAPTER_ANALYZER_ID,
                analyzerVersion: TS_ADAPTER_VERSION,
                state: tsState,
                nodes: adapterResult.nodes,
                edges: adapterResult.edges,
                evidence: [],
              },
              contentHashByPath,
              nodeByKey,
            );
          });
        }

        let csState: "ready" | "partial" = "ready";
        if (csEntries.length > 0) {
          // Senkron köprü: derin analiz yok — L0 envanter düzeyi + explicit
          // warning. worker başlatılmaz; uydurma sembol/kenar üretilmez.
          warnings.push(
            `synchronous run cannot perform deep C# symbol analysis (the Roslyn worker runs asynchronously): ${String(csEntries.length)} files listed at L0 inventory level; use runIndexAsync or a refresh job for full analysis`,
          );
          const l0Nodes: SnapshotNodeInput[] = csEntries.map((entry) => ({
            kind: "File",
            qualifiedName: entry.relativePath,
            language: "csharp",
            relativePath: entry.relativePath,
            attributes: { sourceHash: entry.contentHash },
          }));
          csState = "partial";
          this.addAdapterGraph(
            opened.buildId,
            opened.workspaceNode,
            {
              analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
              analyzerVersion: CSHARP_ROSLYN_ADAPTER_VERSION,
              state: csState,
              nodes: l0Nodes,
              edges: [],
              evidence: [],
            },
            contentHashByPath,
            nodeByKey,
          );
        }

        // M2: python/go/rust senkron köprü — worker SPAWN EDİLMEZ; L0
        // envanter düzeyi File node'ları (sourceHash attribute'lu) + explicit
        // warning. csharp köprü sözleşmesinin birebir karşılığı.
        const syncL0Languages: ReadonlyArray<{
          readonly label: string;
          readonly language: string;
          readonly workerName: string;
          readonly entries: InventoryEntry[];
        }> = [
          { label: "Python", language: "python", workerName: "python worker", entries: pyEntries },
          { label: "Go", language: "go", workerName: "go worker", entries: goEntries },
          { label: "Rust", language: "rust", workerName: "Rust worker", entries: rsEntries },
        ];
        let syncHasL0Language = csEntries.length > 0;
        for (const l0 of syncL0Languages) {
          if (l0.entries.length === 0) continue;
          warnings.push(
            `synchronous run cannot perform deep ${l0.label} symbol analysis (the ${l0.workerName} runs asynchronously): ${String(l0.entries.length)} files listed at L0 inventory level; use runIndexAsync or a refresh job for full analysis`,
          );
          const l0Nodes: SnapshotNodeInput[] = l0.entries.map((entry) => ({
            kind: "File",
            qualifiedName: entry.relativePath,
            language: l0.language,
            relativePath: entry.relativePath,
            attributes: { sourceHash: entry.contentHash },
          }));
          syncHasL0Language = true;
          this.addAdapterGraph(
            opened.buildId,
            opened.workspaceNode,
            {
              analyzerId: l0LanguageAnalyzerId(l0.language),
              analyzerVersion: l0LanguageAnalyzerVersion(l0.language),
              state: "partial",
              nodes: l0Nodes,
              edges: [],
              evidence: [],
            },
            contentHashByPath,
            nodeByKey,
          );
        }

        // Envanter mutabakatı ADAPTER KOŞUMLARINDAN SONRA (async yolun B10
        // sözleşmesiyle aynı sıralama — denetim bulgusu): adapter sözleşme
        // dışı fırlatırsa files tablosu güncellenmez; aksi hâlde güncellenen
        // envanter sonraki incremental koşumu "değişiklik yok" no-op'una
        // itip bayat graph'ı korur.
        this.syncInventoryRecords(entries);

        if (!syncHasL0Language && tsEntries.length > 0 && isFileFactStore(this.repository)) {
          const diagnosticPaths = new Set(diagnostics.map((d) => d.relativePath));
          const tsFacts = partitionAdapterOutputByFile({
            workspaceId: this.workspaceId,
            analyzerFingerprint: fingerprint,
            language: "typescript",
            updatedAt: createdAt,
            targetEntries: tsEntries,
            nodes: syncTsNodes,
            edges: syncTsEdges,
            evidence: [],
          });
          this.persistFileFacts(
            new Set(tsEntries.map((e) => e.relativePath)),
            [tsFacts],
            diagnosticPaths,
          );
        }

        finalState =
          tsState === "ready" &&
          csState === "ready" &&
          !syncHasL0Language &&
          diagnostics.length === 0
            ? "ready"
            : "partial";
        }
      } catch (error) {
        this.failBuild(opened.buildId, error);
      }

      const totalLangFiles = this.countLanguageEntries(prepared);
      if (emptyLanguageRun) {
        return this.finalizePublish(
          opened.buildId,
          "partial",
          entries.length,
          0,
          0,
          warnings,
          [],
          { reanalyzedFiles: 0, cachedFiles: 0, earlyCutoffApplied: false },
        );
      }
      return this.finalizePublish(
        opened.buildId,
        finalState,
        entries.length,
        tsEntries.length,
        csEntries.length,
        warnings,
        diagnostics,
        {
          reanalyzedFiles: totalLangFiles,
          cachedFiles: 0,
          earlyCutoffApplied: false,
        },
      );
    } finally {
      activeLease?.release();
    }
  }

  /**
   * TAM pipeline (runIndexAsync/runIncrementalIndexAsync gövdesi; B9+M2).
   * .cs dosyaları analyzeCSharpWorkspace'e; .py/.go/.rs dosyaları ilgili
   * analyzeXWorkspace'e yönlendirilir; beş dilin çıktısı TEK build'e
   * katılır (dangling yok — cross-boundary sözleşmesi). Bir worker
   * kullanılamazsa ilgili adapter L0/L1'e düşer (motor çökmez; diğer
   * dillerin analizi yaşar); partial + explicit warning ile yayımlanır.
   *
   * Fingerprint: C# worker healthy yanıttan ref-pack keşfi türetilir
   * (extractRoslynRefPackContext); python/go/rust worker durumları
   * (ready/worker-unavailable) pystate/gostate/ruststate segmentlerine
   * yazılır — build'in analyzerFingerprint alanı koşuma katılan beş
   * analyzer'ı dürüstçe taşır.
   */
  private async runPipelineAsync(
    prepared: PreparedRun,
    options: IndexRunOptions = {},
    claimedLease?: ActiveBuildLeaseHandle | null,
  ): Promise<IndexRunResult> {
    const {
      canonicalRoot,
      entries,
      tsEntries,
      tsConfigEntries,
      csEntries,
      pyEntries,
      goEntries,
      goModEntries,
      rsEntries,
    } = prepared;
    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );
    const totalLangFiles = this.countLanguageEntries(prepared);
    let completedLangFiles = 0;

    if (totalLangFiles > 0) {
      options.onProgress?.({
        phase: "analyzing",
        completed: 0,
        total: totalLangFiles,
        message: `Analyzing ${String(totalLangFiles)} source files`,
      });
    }

    // Sıralama sözleşmesi (denetim bulgusu): adapter koşumları files
    // upsert'lerinden ÖNCE yapılır. Adapter koşumu build'den ÖNCE olduğundan
    // (fp2 ref-pack gereği) sözleşme dışı bir adapter hatası envanter
    // mutabakatını BOZMADAN rethrow edilir — yoksa güncellenen files
    // tablosu sonraki incremental koşumu "değişiklik yok" kararıyla bayat
    // graph'ı korumaya iterdi.
    let tsState: "ready" | "partial" = "ready";
    let tsNodes: readonly SnapshotNodeInput[] = [];
    let tsEdges: readonly SnapshotEdgeInput[] = [];
    if (tsEntries.length > 0) {
      await yieldToEventLoop();
      const adapterResult = analyzeTypeScriptProgram({
        workspaceId: this.workspaceId,
        rootDir: canonicalRoot,
        sources: tsEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
        configFiles: tsConfigEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
      });
      tsState = adapterResult.state;
      tsNodes = adapterResult.nodes;
      tsEdges = adapterResult.edges;
      for (const diagnostic of adapterResult.diagnostics) {
        const converted: IndexDiagnostic = {
          relativePath: diagnostic.relativePath,
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
        };
        diagnostics.push(converted);
        warnings.push(
          `diagnostic: ${converted.relativePath}:${String(converted.line)} ${converted.code} ${converted.message}`,
        );
      }
      warnings.push(...adapterResult.warnings);
      completedLangFiles += tsEntries.length;
      options.onProgress?.({
        phase: "analyzing",
        completed: completedLangFiles,
        total: totalLangFiles,
        message: `Analyzed ${String(tsEntries.length)} TypeScript/JavaScript files`,
      });
      await yieldToEventLoop();
    }

    let csharpResult: RoslynAdapterResult | undefined;
    if (csEntries.length > 0) {
      // C# adapter (async worker; graceful fallback adapter içindedir).
      csharpResult = await this.analyzeCSharpFn({
        workspaceId: this.workspaceId,
        rootDir: canonicalRoot,
        files: csEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          dotnetCommand: this.csharpSettings.dotnetCommand,
          requestTimeoutMs: this.csharpSettings.requestTimeoutMs,
          workerDllPath: this.csharpSettings.workerDllPath,
        },
      });
      for (const diagnostic of csharpResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `diagnostic: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...csharpResult.warnings);
    }

    // M2: python/go/rust adapter koşumları (sıra sabittir: python, go,
    // rust — INDEXED_ADAPTERS kayıt sırası). Graceful fallback ADAPTER
    // İÇİNDEDİR: worker yoksa sonuç workerAvailable=false + L0/L1 File
    // node'ları ile döner; motor çökmez, diğer dillerin analizi yaşar.
    let pythonResult: PythonAdapterResult | undefined;
    if (pyEntries.length > 0) {
      pythonResult = await analyzePythonWorkspace({
        workspaceId: this.workspaceId,
        files: pyEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          pythonCommand: this.pythonSettings.pythonCommand,
          requestTimeoutMs: this.pythonSettings.requestTimeoutMs,
          workerScriptPath: this.pythonSettings.workerScriptPath,
          responseMaxChars: this.pythonSettings.responseMaxChars,
        },
      });
      for (const diagnostic of pythonResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `diagnostic: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...pythonResult.warnings);
    }
    let goResult: GoAdapterResult | undefined;
    if (goEntries.length > 0) {
      goResult = await analyzeGoWorkspace({
        workspaceId: this.workspaceId,
        files: goEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        ...(goModEntries.length > 0
          ? {
              moduleFiles: goModEntries.map((entry) => ({
                relativePath: entry.relativePath,
                content: entry.content,
              })),
            }
          : {}),
        options: {
          goBinaryPath: this.goSettings.goBinaryPath,
          ...(this.goSettings.goWorkerBinaryPath.length > 0
            ? { goWorkerBinaryPath: this.goSettings.goWorkerBinaryPath }
            : {}),
          workerDir: this.goSettings.workerDir,
          requestTimeoutMs: this.goSettings.requestTimeoutMs,
        },
      });
      for (const diagnostic of goResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `diagnostic: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...goResult.warnings);
    }
    let rustResult: RustAdapterResult | undefined;
    if (rsEntries.length > 0) {
      rustResult = await analyzeRustWorkspace({
        workspaceId: this.workspaceId,
        files: rsEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          ...(this.hasExplicitRustWorkerDir
            ? { workerDir: this.rustSettings.workerDir }
            : {}),
          workerBinaryName: this.rustSettings.workerBinaryName,
          ...(this.rustSettings.cargoHomeDir.length > 0
            ? { cargoHomeDir: this.rustSettings.cargoHomeDir }
            : {}),
          requestTimeoutMs: this.rustSettings.requestTimeoutMs,
          responseMaxChars: this.rustSettings.responseMaxChars,
          cargoBuildTimeoutMs: this.rustSettings.cargoBuildTimeoutMs,
        },
      });
      for (const diagnostic of rustResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `diagnostic: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...rustResult.warnings);
    }

    // fp2 ref-pack keşfi: worker healthy koştuysa yanıt warnings'inden
    // türetilir; healthy yanıtta keşif bilgisi yoksa nötr "discovery-unknown"
    // etiketi kullanılır — worker'un VARLIĞI ile keşfin BİLİNMESİ aynı
    // şey değildir (denetim bulgusu).
    let discovery: RoslynDiscoveryStatus;
    let refPacks: RoslynRefPackContext | null;
    if (csharpResult === undefined || !csharpResult.workerAvailable) {
      discovery = "worker-unavailable";
      refPacks = null;
    } else {
      refPacks = extractRoslynRefPackContext(csharpResult.warnings);
      discovery = refPacks === null ? "discovery-unknown" : "performed";
    }

    // M2: sidecar worker durumları — koşuma katılan her dilin GERÇEK
    // worker durumu fingerprint'e yazılır (fp1 dersi: worker'ın koşup
    // koşamadığı graph'ı değiştirir; fp bunu dürüstçe taşımalıdır).
    const pythonStatus: WorkerRunStatus =
      pythonResult === undefined ? "ready" : pythonResult.workerAvailable ? "ready" : "worker-unavailable";
    const goStatus: WorkerRunStatus =
      goResult === undefined ? "ready" : goResult.workerAvailable ? "ready" : "worker-unavailable";
    const rustStatus: WorkerRunStatus =
      rustResult === undefined ? "ready" : rustResult.workerAvailable ? "ready" : "worker-unavailable";

    const createdAt = this.clock();
    const fingerprint = buildAnalyzerFingerprint({
      typescript:
        tsEntries.length > 0
          ? { analyzerId: TS_ADAPTER_ANALYZER_ID, version: TS_ADAPTER_VERSION }
          : null,
      csharp:
        csEntries.length > 0
          ? {
              analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
              version: CSHARP_ROSLYN_ADAPTER_VERSION,
              discovery,
              refPacks,
              settings: this.csharpSettings,
            }
          : null,
      python:
        pyEntries.length > 0
          ? {
              analyzerId: PYTHON_WORKER_ADAPTER_ID,
              version: PYTHON_WORKER_ADAPTER_VERSION,
              status: pythonStatus,
              settings: this.pythonSettings,
            }
          : null,
      go:
        goEntries.length > 0
          ? {
              analyzerId: GO_ADAPTER_ID,
              version: GO_ADAPTER_VERSION,
              status: goStatus,
              settings: this.goSettings,
            }
          : null,
      rust:
        rsEntries.length > 0
          ? {
              analyzerId: RUST_ADAPTER_ID,
              version: RUST_ADAPTER_VERSION,
              status: rustStatus,
              settings: this.rustSettings,
            }
          : null,
    });

    await yieldToEventLoop();
    const buildAttempt = this.openBuildOrRecover(
      entries,
      fingerprint,
      createdAt,
      canonicalRoot,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
      claimedLease,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const { opened, activeLease } = buildAttempt;

    options.onProgress?.({
      phase: "building",
      completed: totalLangFiles,
      total: totalLangFiles,
      message: "Building snapshot graph",
    });

    try {
      let finalState: PublishableState = "ready";
      let emptyLanguageRun = false;
      try {
        // Envanter mutabakatı ADAPTER KOŞUMULARINDAN ve build açılışından sonra:
        // başka sürecin aktif build'i nedeniyle önceki snapshot'a düşülürse
        // files tablosu yayımlanmamış karmalarla kirlenmez.
        this.syncInventoryRecords(entries);

        // Erken çıkış: analiz edilebilir dil kaynağı yok — senkron yolun
        // aynı dürüstlük sözleşmesi (denetim bulgusu): coverage sıfırken
        // 'ready' uydurulmaz; partial + explicit kapsam uyarıları yayımlanır.
        if (
          tsEntries.length === 0 &&
          csEntries.length === 0 &&
          pyEntries.length === 0 &&
          goEntries.length === 0 &&
          rsEntries.length === 0
        ) {
          warnings.push(
            "the workspace contains no analyzable TypeScript/TSX/C#/Python/Go/Rust sources; coverage is zero (published as partial)",
          );
          for (const entry of entries) {
            warnings.push(`file is in the inventory but outside every language adapter: ${entry.relativePath}`);
          }
          emptyLanguageRun = true;
        } else {

        const nodeByKey = new Map<string, GraphNode>();
        let state: PublishableState = "ready";

        this.withTransaction(() => {
          if (tsEntries.length > 0) {
            this.addAdapterGraph(
              opened.buildId,
              opened.workspaceNode,
              {
                analyzerId: TS_ADAPTER_ANALYZER_ID,
                analyzerVersion: TS_ADAPTER_VERSION,
                state: tsState,
                nodes: tsNodes,
                edges: tsEdges,
                evidence: [],
              },
              contentHashByPath,
              nodeByKey,
            );
          }
          if (csharpResult !== undefined) {
            this.addAdapterGraph(
              opened.buildId,
              opened.workspaceNode,
              {
                analyzerId: csharpResult.analyzerId,
                analyzerVersion: csharpResult.analyzerVersion,
                state: csharpResult.state,
                nodes: csharpResult.nodes,
                edges: csharpResult.edges,
                evidence: csharpResult.evidence,
              },
              contentHashByPath,
              nodeByKey,
            );
            if (csharpResult.state !== "ready") state = "partial";
          }
          // M2: python/go/rust çıktıları aynı addAdapterGraph sözleşmesiyle
          // TEK build'e katılır (relativePath'li node çakışması açık hatadır;
          // kenar uçları node haritasından çözülür — dangling yok).
          for (const result of [pythonResult, goResult, rustResult]) {
            if (result === undefined) continue;
            this.addAdapterGraph(
              opened.buildId,
              opened.workspaceNode,
              {
                analyzerId: result.analyzerId,
                analyzerVersion: result.analyzerVersion,
                state: result.state,
                nodes: result.nodes,
                edges: result.edges,
                evidence: result.evidence,
              },
              contentHashByPath,
              nodeByKey,
            );
            if (result.state !== "ready") state = "partial";
          }
        });
        if (tsState !== "ready") state = "partial";
        if (diagnostics.length > 0) state = "partial";
        finalState = state;

        if (isFileFactStore(this.repository)) {
          const diagnosticPaths = new Set(diagnostics.map((d) => d.relativePath));
          const factMaps: Array<ReadonlyMap<string, FileFactRecord>> = [];
          if (tsEntries.length > 0) {
            factMaps.push(
              partitionAdapterOutputByFile({
                workspaceId: this.workspaceId,
                analyzerFingerprint: fingerprint,
                language: "typescript",
                updatedAt: createdAt,
                targetEntries: tsEntries,
                nodes: tsNodes,
                edges: tsEdges,
                evidence: [],
              }),
            );
          }
          if (csharpResult !== undefined && csharpResult.workerAvailable) {
            factMaps.push(
              partitionAdapterOutputByFile({
                workspaceId: this.workspaceId,
                analyzerFingerprint: fingerprint,
                language: "csharp",
                updatedAt: createdAt,
                targetEntries: csEntries,
                nodes: csharpResult.nodes,
                edges: csharpResult.edges,
                evidence: csharpResult.evidence,
              }),
            );
          }
          if (pythonResult !== undefined && pythonResult.workerAvailable) {
            factMaps.push(
              partitionAdapterOutputByFile({
                workspaceId: this.workspaceId,
                analyzerFingerprint: fingerprint,
                language: "python",
                updatedAt: createdAt,
                targetEntries: pyEntries,
                nodes: pythonResult.nodes,
                edges: pythonResult.edges,
                evidence: pythonResult.evidence,
              }),
            );
          }
          if (goResult !== undefined && goResult.workerAvailable) {
            factMaps.push(
              partitionAdapterOutputByFile({
                workspaceId: this.workspaceId,
                analyzerFingerprint: fingerprint,
                language: "go",
                updatedAt: createdAt,
                targetEntries: goEntries,
                nodes: goResult.nodes,
                edges: goResult.edges,
                evidence: goResult.evidence,
              }),
            );
          }
          if (rustResult !== undefined && rustResult.workerAvailable) {
            factMaps.push(
              partitionAdapterOutputByFile({
                workspaceId: this.workspaceId,
                analyzerFingerprint: fingerprint,
                language: "rust",
                updatedAt: createdAt,
                targetEntries: rsEntries,
                nodes: rustResult.nodes,
                edges: rustResult.edges,
                evidence: rustResult.evidence,
              }),
            );
          }
          const currentLangPaths = new Set<string>([
            ...tsEntries.map((e) => e.relativePath),
            ...csEntries.map((e) => e.relativePath),
            ...pyEntries.map((e) => e.relativePath),
            ...goEntries.map((e) => e.relativePath),
            ...rsEntries.map((e) => e.relativePath),
          ]);
          this.persistFileFacts(currentLangPaths, factMaps, diagnosticPaths);
        }
        }
      } catch (error) {
        this.failBuild(opened.buildId, error);
      }

      options.onProgress?.({
        phase: "publishing",
        completed: totalLangFiles,
        total: totalLangFiles,
        message: "Publishing snapshot",
      });
      if (emptyLanguageRun) {
        const emptyResult = this.finalizePublish(
          opened.buildId,
          "partial",
          entries.length,
          0,
          0,
          warnings,
          [],
          { reanalyzedFiles: 0, cachedFiles: 0, earlyCutoffApplied: false },
        );
        options.onProgress?.({
          phase: "done",
          completed: 0,
          total: 0,
          message: `Published partial snapshot ${emptyResult.snapshotId}`,
        });
        return emptyResult;
      }
      const result = this.finalizePublish(
        opened.buildId,
        finalState,
        entries.length,
        tsEntries.length,
        csEntries.length,
        warnings,
        diagnostics,
        {
          reanalyzedFiles: totalLangFiles,
          cachedFiles: 0,
          earlyCutoffApplied: false,
        },
      );
      options.onProgress?.({
        phase: "done",
        completed: totalLangFiles,
        total: totalLangFiles,
        message: `Published snapshot ${result.snapshotId}`,
      });
      return result;
    } finally {
      activeLease?.release();
    }
  }

  /**
   * Adapter çıktısını build'e katıyor: node'lar (dil crossed duplicate
   * kimlik reddedilir) → kenarlar (uçlar node haritasından çözülür —
   * dangling yok) → üst düzey kanıtlar → Workspace→File CONTAINS kenarları
   * (envanter kanıtlı; her iki dilin File node'ları için).
   */
  private addAdapterGraph(
    buildId: string,
    workspaceNode: GraphNode,
    output: AdapterOutput,
    contentHashByPath: ReadonlyMap<string, string>,
    nodeByKey: Map<string, GraphNode>,
  ): void {
    // 1) Node'lar: iki dil TEK kimlik haritasında (cross-boundary sözleşmesi —
    //    nodeId language içermez). relativePath taşımayan dış/sanal düğümler
    //    (örn. UnknownExternal "Request", ExternalDependency, Endpoint) polyglot
    //    repolarda birden fazla adapter tarafından meşru biçimde paylaşılır ve
    //    kanonik düğüm yeniden kullanılır; dosya-bağlı çakışma hâlâ açık hatadır.
    for (const nodeInput of output.nodes) {
      const key = nodeRefKey(nodeInput);
      if (nodeByKey.has(key)) {
        if (nodeInput.relativePath === undefined) {
          continue;
        }
        throw new IndexingError(
          "indexing/internal",
          `two adapters produced the same node id: ${key}`,
        );
      }
      const node = toGraphNode(this.workspaceId, nodeInput, contentHashByPath);
      nodeByKey.set(key, node);
      this.repository.addNode(buildId, node);
    }

    // 2) Kenarlar: uçlar node haritasından çözülür (dangling yok).
    for (const edgeInput of output.edges) {
      const from = nodeByKey.get(nodeRefKey(edgeInput.from));
      const to = nodeByKey.get(nodeRefKey(edgeInput.to));
      if (from === undefined || to === undefined) {
        const missing = from === undefined ? edgeInput.from : edgeInput.to;
        throw new IndexingError(
          "indexing/internal",
          `adapter edge points to an unknown node: ${nodeRefKey(missing)}`,
        );
      }
      const evidenceIds: string[] = [];
      for (const evidenceInput of edgeInput.evidence ?? []) {
        const evidence = toEvidence(this.workspaceId, evidenceInput);
        this.repository.addEvidence(buildId, evidence);
        evidenceIds.push(evidence.id);
      }
      const edge: GraphEdge = createEdge({
        workspaceId: this.workspaceId,
        kind: edgeInput.kind,
        from: from.id,
        to: to.id,
        resolution: edgeInput.resolution,
        evidenceIds,
        ...(edgeInput.ambiguity === undefined
          ? {}
          : {
              ambiguity: {
                candidates: [...edgeInput.ambiguity.candidates],
                reason: edgeInput.ambiguity.reason,
              },
            }),
      });
      this.repository.addEdge(buildId, edge);
    }

    // 3) Üst düzey kanıtlar (roslyn worker PROTOCOL.md v1; repository
    //    aynı kimliği sessiz dedup eder).
    for (const evidenceInput of output.evidence) {
      this.repository.addEvidence(buildId, toEvidence(this.workspaceId, evidenceInput));
    }

    // 4) CONTAINS: Workspace → her File node (envanter kanıtlı).
    for (const nodeInput of output.nodes) {
      if (nodeInput.kind !== "File" || nodeInput.relativePath === undefined) continue;
      const fileNode = nodeByKey.get(nodeRefKey(nodeInput));
      const sourceHash = contentHashByPath.get(nodeInput.relativePath);
      if (fileNode === undefined || sourceHash === undefined) {
        throw new IndexingError(
          "indexing/internal",
          `File node does not match the inventory: ${nodeInput.relativePath}`,
        );
      }
      const inventoryEvidence = toEvidence(this.workspaceId, {
        kind: "inventory",
        span: {
          relativePath: nodeInput.relativePath,
          startLine: 1,
          endLine: 1,
          sourceHash,
        },
        analyzerId: "causoryn-indexing",
        analyzerVersion: INDEXING_VERSION,
        rationale: "file inventory: source file allowed by WorkspaceAccessPolicy",
      });
      this.repository.addEvidence(buildId, inventoryEvidence);
      this.repository.addEdge(
        buildId,
        createEdge({
          workspaceId: this.workspaceId,
          kind: "CONTAINS",
          from: workspaceNode.id,
          to: fileNode.id,
          resolution: "verified",
          evidenceIds: [inventoryEvidence.id],
        }),
      );
    }
  }

  /** Build'i failed yapar ve hatayı sınıf sözleşmesine çevirip fırlatır. */
  private failBuild(buildId: string, error: unknown): never {
    if (error instanceof IndexingError) {
      this.repository.failBuild(buildId, `${error.code}: ${error.message}`);
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.repository.failBuild(buildId, reason);
    if (error instanceof GraphRepositoryError) {
      throw new IndexingError("indexing/internal", `graph store rejected the operation: ${reason}`);
    }
    throw error;
  }

  private ensureWorkspaceRegistered(): void {
    if (this.workspaceRegistered) return;
    try {
      this.repository.registerWorkspace({
        id: this.workspaceId,
        rootPath: this.policy.config.allowRoots[0] ?? "(root is authorized when indexing runs)",
        createdAt: this.clock(),
      });
      this.workspaceRegistered = true;
    } catch (error) {
      if (error instanceof GraphRepositoryError && error.code === "graph/duplicate-workspace") {
        // Aynı workspace zaten kayıtlı: idempotent kabul edilir.
        this.workspaceRegistered = true;
        return;
      }
      throw error;
    }
  }
}
