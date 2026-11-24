import { lstatSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import {
  IndexService,
  type IndexDiagnostic,
  type IndexProgressCallback,
  type IndexProgressEvent,
  type IndexProgressPhase,
  type IndexRunResult,
  type IndexWorkerServiceConfig,
} from "./index-service.js";
import type {
  IndexWorkerMessage,
  IndexWorkerResultSummary,
  IndexWorkerTaskInput,
} from "./index-worker.js";

/**
 * IndexJobManager — snapshot iş yönetimi (TŞ v2.1 §10.2, sprint-2 B6).
 *
 * causoryn_refresh_index "Yeni snapshot işi" üretir; envanter → dil
 * adapter'ları → graph → snapshot pipeline'ı bir iş olarak SARMALANIR.
 * B9 denetim düzeltmesiyle işler TAM pipeline'ı koşturur:
 * IndexService.runIndexAsync/runIncrementalIndexAsync await edilir —
 * .cs'li workspace'lerde C# derin analizi (Roslyn worker) iş içinde
 * yürür; senkron runIndex köprüsü (L0 + partial) yalnızca senkron
 * çağıran tarafa (mcp-server autoIndex başlatma koşumu) aittir. İşler
 * in-process async koşar (TŞ §10.2 "Live Architecture" bağlamının Faz B
 * dilimi): `refreshIndex` çağrısı işi kuyruğa alıp anında döner, kuyruk
 * sırayla (job başına bir iş, eşzamanlılık yok) boşalır.
 *
 * jobId tasarım karşısı (gerekçeli karar):
 * - Snapshot ID determinizmi korunur. Snapshot ID formülü yalnızca
 *   [workspaceId, revision.id, revision.sequence, configHash,
 *   analyzerFingerprint, contentHash] girdilerinden türetilir
 *   (packages/domain/src/snapshot.ts "Snapshot ID" başlığı); jobId
 *   graph içerigine HİÇBİR düzeyde girmez. Test: farklı jobId
 *   üreticileriyle koşan iki iş aynı snapshot ID'yi üretir.
 * - jobId İÇERİKTEN türetilemez: aynı içerikle üst üste iki refresh,
 *   birbirinden ayrı işletim kayıtlarıdır; içerik bazlı kimlik iki
 *   operasyonu tek kayda düşürüp ilerleme/tanı takibini bozar.
 * - Varsayılan üretim per-manager sıfırlanan monoton sayaçtır
 *   (`job-000001`, …): saat/RNG okumaz, dolayısıyla aynı çağrı dizisi
 *   aynı jobId dizisini üretir (test determinizmi). `jobIdGenerator`
 *   enjeksiyon noktası alternate kimlik şemalarına izin verir.
 * - jobId bir İŞLETİM kaydıdır: kayıt sayısı `maxJobs` ile sınırlıdır,
 *   en eski kayıt FIFO düşer; düşen jobId sonraki sorguda "bilinmeyen"
 *   sayılır (MCP katmanında INVALID_ARGUMENT).
 *
 * Progress semantiği (dürüstlük notu): pipeline tek iş adımıdır; ara yüzde
 * (dosya başına) gözlemlenebilir DEĞİLDİR. Bu dilimde progress yalnızca iş
 * yaşam döngüsü aşamalarını raporlar: queued=0 → running=50 → done=100;
 * failed iş son yüzdeyi korur. Dosya düzeyi yüzde, sonraki dilim konusudur.
 *
 * Bu paket saat okumaz: tüm zaman damgaları enjekte edilen `clock`'tan
 * gelir (IndexService ile aynı determinizm ilkesi).
 */

/** Refresh iş türleri (TŞ §10.2 "mode"). */
export type IndexJobMode = "full" | "incremental";

/** İş yaşam döngüsü durumları. */
export type IndexJobStatus = "queued" | "running" | "done" | "failed";

/** Başarısız işin uygulama düzeyi hata kaydı (IndexingError kodu). */
export interface IndexJobError {
  readonly code: string;
  readonly message: string;
}

/** Structured job progress snapshot (`job.progress`). */
export interface IndexJobProgress {
  readonly phase: IndexProgressPhase;
  readonly completed: number;
  readonly total: number;
  readonly message?: string;
}

/** Bir refresh işinin işletim kaydı (index_status çıktısının kaynağı). */
export interface IndexJobRecord {
  readonly jobId: string;
  readonly mode: IndexJobMode;
  /** Bu dilimde hep null (scope desteklenmez; sonraki dilim konusu). */
  readonly scope: string | null;
  /**
   * İşin tetiklendiği değişiklik kümesi (kök-göreceli POSIX yollar, sıralı).
   * full işlerde de tetikleyici dosyalar taşınır; Watcher dışı çağrıda boş.
   */
  readonly changeSet: readonly string[];
  readonly status: IndexJobStatus;
  readonly progressPercent: number;
  /** Structured progress state updated continuously during worker/in-process indexing. */
  readonly progress: IndexJobProgress;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** İşin yayımladığı snapshot; koşarken/failed iken null. */
  readonly snapshotId: string | null;
  readonly snapshotState: "ready" | "partial" | null;
  /** Yayımlanan snapshot'ın publish anındaki staleness bayrağı. */
  readonly stale: boolean;
  readonly fileCount: number | null;
  readonly tsFileCount: number | null;
  /** Adapter'a verilen .cs dosya sayısı; koşarken/queued'da null (B9). */
  readonly csFileCount: number | null;
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly warnings: readonly string[];
  readonly error: IndexJobError | null;
  /** Execution path used for this job (`worker` off-thread vs `in-process` fallback). */
  readonly executionMode?: "worker" | "in-process";
  /** Number of source files re-analyzed (Task 2.6). */
  readonly reanalyzedFiles?: number;
  /** Number of source files served from `file_facts` cache (Task 2.6). */
  readonly cachedFiles?: number;
  /** True when early cutoff avoided invalidating reverse dependents (Task 2.6). */
  readonly earlyCutoffApplied?: boolean;
}

export interface IndexJobManagerOptions {
  readonly indexService: IndexService;
  /** Senkron kök yetkilendirmesi için (reddedilen kök iş açmaz). */
  readonly policy: WorkspaceAccessPolicy;
  readonly clock: () => string;
  /** Varsayılan: per-manager monoton sayaç (`job-000001`). */
  readonly jobIdGenerator?: () => string;
  /** Varsayılan: setImmediate (in-process async). Testler manuel kuyruk verir. */
  readonly scheduler?: (task: () => void) => void;
  /** İşletim kaydı sınırı; en eski kayıt FIFO düşer. Varsayılan 100. */
  readonly maxJobs?: number;
  /**
   * Optional SQLite DB path for off-thread `worker_threads` indexing.
   * When omitted, automatically derived from `SqliteGraphRepository.dbPath` if available.
   */
  readonly workerDbPath?: string;
  /** Optional explicit override path to compiled/bundled `index-worker` entrypoint. */
  readonly workerEntryPath?: string;
  /** Set `false` to disable `worker_threads` execution and force in-process async mode. */
  readonly useWorkerThread?: boolean;
  /** Optional fixed ISO timestamp forwarded to worker-thread clock (test seam). */
  readonly workerFixedClockIso?: string;
  /** Optional progress listener notified whenever any job emits a progress event. */
  readonly onProgress?: (jobId: string, event: IndexProgressEvent) => void;
}

/** İş "running" aşamasına geçtiğinde raporlanan başlangıç yüzdesi. */
const RUNNING_PROGRESS_PERCENT = 10;

/** Varsayılan işletim kaydı sınırı. */
const DEFAULT_MAX_JOBS = 100;

/**
 * Static ESM bootstrap used ONLY when spawning `index-worker.ts` directly from
 * TypeScript source (Vitest / dev mode on Node 24+). Registers a relative `.js` -> `.ts`
 * resolver via `node:module` `registerHooks` and imports the trusted `workerData.__workerEntryUrl`.
 */
const TS_WORKER_BOOTSTRAP_CODE = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workerData } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        specifier.endsWith(".js") &&
        context.parentURL &&
        context.parentURL.startsWith("file:")
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const tsPath = path.resolve(parentDir, specifier.slice(0, -3) + ".ts");
        if (existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
      throw err;
    }
  },
});

await import(workerData.__workerEntryUrl);
`;

interface ResolvedWorkerEntry {
  readonly kind: "js" | "ts-source";
  readonly path: string;
}

const UNC_OR_DEVICE_PATH_PATTERN = /^(?:\\\\|\/\/|\/\\|\\\/)/;

function stripWin32DevicePrefix(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function normalizePathForContainment(value: string): string {
  const stripped = stripWin32DevicePrefix(path.resolve(value));
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function isStrictlyInsideDir(targetPath: string, parentDir: string): boolean {
  const normTarget = normalizePathForContainment(targetPath);
  const normParent = normalizePathForContainment(parentDir);
  if (normTarget === normParent) return false;
  const boundary = normParent.endsWith(path.sep)
    ? normParent
    : `${normParent}${path.sep}`;
  return normTarget.startsWith(boundary);
}

/**
 * Validates a `worker_threads` entrypoint file path fail-closed:
 * - rejects empty/whitespace strings, NUL bytes, and UNC/Windows device paths;
 * - checks `lstatSync` to reject symlinks and non-regular files (directories/FIFOs);
 * - canonicalizes via `realpathSync` and, when `allowedParentDir` is specified
 *   (default sibling discovery), verifies strict containment inside `realpathSync(allowedParentDir)`.
 */
export function validateWorkerEntryPath(
  candidate: string,
  allowedParentDir?: string,
): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return undefined;
  }
  if (candidate.includes("\0")) {
    return undefined;
  }
  if (UNC_OR_DEVICE_PATH_PATTERN.test(candidate)) {
    return undefined;
  }
  const resolved = path.resolve(candidate);
  if (UNC_OR_DEVICE_PATH_PATTERN.test(resolved)) {
    return undefined;
  }

  let stat: Stats;
  try {
    stat = lstatSync(resolved);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return undefined;
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(resolved);
  } catch {
    return undefined;
  }
  if (UNC_OR_DEVICE_PATH_PATTERN.test(stripWin32DevicePrefix(realCandidate))) {
    return undefined;
  }

  if (allowedParentDir !== undefined) {
    if (
      typeof allowedParentDir !== "string" ||
      allowedParentDir.trim().length === 0 ||
      allowedParentDir.includes("\0") ||
      UNC_OR_DEVICE_PATH_PATTERN.test(allowedParentDir)
    ) {
      return undefined;
    }
    let realParent: string;
    try {
      realParent = realpathSync(path.resolve(allowedParentDir));
    } catch {
      return undefined;
    }
    if (!isStrictlyInsideDir(realCandidate, realParent)) {
      return undefined;
    }
  }

  return realCandidate;
}

interface JobWaiter {
  readonly resolve: (record: IndexJobRecord) => void;
  readonly reject: (error: unknown) => void;
}

function progressPercentFromEvent(
  event: IndexProgressEvent,
  fallbackPercent: number,
): number {
  switch (event.phase) {
    case "queued":
      return 0;
    case "inventory":
      return event.total > 0 && event.completed >= event.total ? 15 : 5;
    case "analyzing": {
      const ratio =
        event.total > 0 ? Math.min(1, Math.max(0, event.completed / event.total)) : 0.5;
      return Math.round(15 + ratio * 60);
    }
    case "building":
      return 85;
    case "publishing":
      return 95;
    case "done":
      return 100;
    case "failed":
      return fallbackPercent;
  }
}

/** Kaydı derin dondurur (dizi kopyalarıyla; ADR-005 stili). */
function freezeRecord(record: IndexJobRecord): IndexJobRecord {
  return Object.freeze({
    ...record,
    progress: Object.freeze({ ...record.progress }),
    diagnostics: Object.freeze(record.diagnostics.map((item) => ({ ...item }))),
    warnings: Object.freeze([...record.warnings]),
    error: record.error === null ? null : Object.freeze({ ...record.error }),
  }) as IndexJobRecord;
}

export class IndexJobManager {
  private readonly indexService: IndexService;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly clock: () => string;
  private readonly jobIdGenerator: () => string;
  private readonly scheduler: (task: () => void) => void;
  private readonly maxJobs: number;
  private readonly workerDbPath: string | undefined;
  private readonly workerEntryPath: string | undefined;
  private readonly useWorkerThread: boolean;
  private readonly workerFixedClockIso: string | undefined;
  private readonly onProgressListener:
    | ((jobId: string, event: IndexProgressEvent) => void)
    | undefined;
  /** Sayaç tabanlı default jobId üretimi için monoton sayaç. */
  private counter = 0;

  /** jobId → kayıt; ekleme sırası = oluşturma sırası (FIFO evict için). */
  private readonly records = new Map<string, IndexJobRecord>();
  private readonly roots = new Map<string, string>();
  private readonly waiters = new Map<string, JobWaiter[]>();
  private readonly progressListeners = new Map<string, Set<IndexProgressCallback>>();
  private readonly queue: string[] = [];
  private draining = false;
  private lastJobId: string | undefined;
  private activeWorker: Worker | undefined;
  private closed = false;

  constructor(options: IndexJobManagerOptions) {
    this.indexService = options.indexService;
    this.policy = options.policy;
    this.clock = options.clock;
    this.jobIdGenerator =
      options.jobIdGenerator ??
      (() => {
        // Monoton sayaç: saat/RNG okumaz; aynı çağrı dizisi aynı kimlik
        // dizisini üretir (determinizm; bkz. sınıf başlığındaki gerekçe).
        this.counter += 1;
        return `job-${String(this.counter).padStart(6, "0")}`;
      });
    this.scheduler = options.scheduler ?? ((task) => setImmediate(task));
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.workerDbPath = options.workerDbPath;
    this.workerEntryPath = options.workerEntryPath;
    this.useWorkerThread = options.useWorkerThread ?? true;
    this.workerFixedClockIso = options.workerFixedClockIso;
    this.onProgressListener = options.onProgress;
  }

  /**
   * Yeni snapshot işi başlatır. Yetkilendirme ve iş türü denetimi SENKRON
   * yapılır: reddedilen istek iş kaydı AÇMAZ ve IndexingError ile çağrı
   * anında reddedilir (MCP katmanı bunu WORKSPACE_NOT_AUTHORIZED /
   * INVALID_ARGUMENT envelope'una çevirir). Kabul edilen istek kuyruğa
   * alınır ve kaydı anında döner (status "queued").
   *
   * Sprint-2 B7: mode "incremental" desteklenir — IndexService.runIncrementalIndexAsync
   * koşturulur; `changeSet` kayda taşınır (karar yetkilisi karma
   * karşılaştırmasıdır, bkz. IndexService.runIncrementalIndexAsync). `scope`
   * hâlâ desteklenmez (indexing/unsupported-mode).
   */
  refreshIndex(
    rootPath: string,
    input: {
      readonly mode: IndexJobMode;
      readonly scope?: string;
      readonly changeSet?: readonly string[];
      readonly onProgress?: IndexProgressCallback;
    },
  ): IndexJobRecord {
    if (this.closed) {
      throw new IndexingError(
        "indexing/internal",
        "IndexJobManager kapatıldı; yeni indeksleme işi kabul edilmiyor",
      );
    }
    if (input.mode !== "full" && input.mode !== "incremental") {
      throw new IndexingError(
        "indexing/unsupported-mode",
        `mode "${input.mode as string}" desteklenmiyor (full | incremental)`,
      );
    }
    if (input.scope !== undefined) {
      throw new IndexingError(
        "indexing/unsupported-mode",
        "scope dar kapsamlı yeniden indeksleme desteklenmiyor; sonraki dilimde değerlendirilecek",
      );
    }
    const decision = this.policy.authorizeRoot(rootPath);
    if (!decision.allowed) {
      throw new IndexingError(
        "indexing/root-not-authorized",
        `kök yetkilendirilmedi (${decision.code}): ${decision.reason}`,
      );
    }

    const jobId = this.jobIdGenerator();
    const record = freezeRecord({
      jobId,
      mode: input.mode,
      scope: null,
      changeSet: Object.freeze([...(input.changeSet ?? [])].sort()),
      status: "queued",
      progressPercent: 0,
      progress: {
        phase: "queued",
        completed: 0,
        total: 0,
        message: "Queued for indexing",
      },
      createdAt: this.clock(),
      startedAt: null,
      finishedAt: null,
      snapshotId: null,
      snapshotState: null,
      stale: false,
      fileCount: null,
      tsFileCount: null,
      csFileCount: null,
      diagnostics: [],
      warnings: [],
      error: null,
    });
    this.records.set(jobId, record);
    this.roots.set(jobId, rootPath);
    if (input.onProgress !== undefined) {
      this.subscribeProgress(jobId, input.onProgress);
    }
    this.lastJobId = jobId;
    this.evictOverflow();
    this.enqueue(jobId);
    return this.records.get(jobId) as IndexJobRecord;
  }

  /** Subscribes to live structured progress updates for `jobId`; returns an unsubscribe function. */
  subscribeProgress(
    jobId: string,
    listener: IndexProgressCallback,
  ): () => void {
    if (this.closed) {
      return () => {};
    }
    let set = this.progressListeners.get(jobId);
    if (set === undefined) {
      set = new Set<IndexProgressCallback>();
      this.progressListeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set !== undefined && set.size === 0) {
        this.progressListeners.delete(jobId);
      }
    };
  }

  /** jobId ile iş kaydı; bilinmeyen/düşen kimlikte undefined. */
  status(jobId: string): IndexJobRecord | undefined {
    return this.records.get(jobId);
  }

  /** En son başlatılan iş kaydı; hiç iş başlamadıysa undefined. */
  latest(): IndexJobRecord | undefined {
    return this.lastJobId === undefined
      ? undefined
      : this.records.get(this.lastJobId);
  }

  /**
   * Güncel iş kayıtları (oluşturma sırasıyla). Evict edilen (maxJobs
   * aşımı) kayıtlar listeye girmez; index_status listing ve testler için
   * gözlemlenebilirlik yüzeyi (sprint-2 B7 watcher doğrulaması kullanır).
   */
  jobs(): readonly IndexJobRecord[] {
    return [...this.records.values()];
  }

  /**
   * İş terminal duruma (done/failed) gelene dek bekler; test ve orkestrasyon
   * seam'i. Bilinmeyen jobId reddeder (IndexingError DEĞİL — bu seam MCP
   * hata tablosuna çevrilmez; tool düzeyi bilinmeyen jobId INVALID_ARGUMENT
   * döner). Terminal durumda anında çözülür.
   */
  waitForJob(jobId: string): Promise<IndexJobRecord> {
    const existing = this.records.get(jobId);
    if (existing === undefined) {
      return Promise.reject(new Error(`bilinmeyen jobId: ${jobId}`));
    }
    if (existing.status === "done" || existing.status === "failed") {
      return Promise.resolve(existing);
    }
    return new Promise<IndexJobRecord>((resolve, reject) => {
      const list = this.waiters.get(jobId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(jobId, list);
    });
  }

  /**
   * Shuts down the job manager idempotently:
   * - prevents new jobs and post-close repository mutations,
   * - cancels all queued and in-flight jobs and settles pending waiters cleanly,
   * - clears progress listeners,
   * - terminates any active off-thread indexing `Worker`.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    const worker = this.activeWorker;
    this.activeWorker = undefined;
    if (worker !== undefined) {
      void worker.terminate().catch(() => {});
    }

    const cancelledMessage = "Indexing job cancelled: job manager closed";
    const cancelJob = (jobId: string): void => {
      const current = this.records.get(jobId);
      if (
        current !== undefined &&
        current.status !== "done" &&
        current.status !== "failed"
      ) {
        this.records.set(
          jobId,
          freezeRecord({
            ...current,
            status: "failed",
            progress: {
              phase: "failed",
              completed: current.progress.completed,
              total: current.progress.total,
              message: cancelledMessage,
            },
            finishedAt: this.clock(),
            error: { code: "indexing/internal", message: cancelledMessage },
          }),
        );
      }
      this.settle(jobId);
    };

    const pendingQueued = this.queue.splice(0);
    for (const queuedJobId of pendingQueued) {
      cancelJob(queuedJobId);
    }

    for (const [jobId, record] of this.records) {
      if (record.status === "queued" || record.status === "running") {
        cancelJob(jobId);
      }
    }

    for (const jobId of [...this.waiters.keys()]) {
      this.settle(jobId);
    }
    this.waiters.clear();
    this.progressListeners.clear();
  }

  /* ---------------------------------------------------------------- */
  /* İç kuyruk                                                        */
  /* ---------------------------------------------------------------- */

  private enqueue(jobId: string): void {
    if (this.closed) return;
    this.queue.push(jobId);
    if (this.draining) return;
    this.draining = true;
    // drain async'tir; scheduler callback'inin dönüşü kuyruk sahipliğiyle
    // ilgisidir — işler drain içinde sırayla await edilir.
    this.scheduler(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      // İşler SIRAYLA koşar: her iş tamamlanmadan (await) sonrakine
      // geçilmez — "job başına bir iş, eşzamanlılık yok" sözleşmesi
      // async pipeline ile de korunur.
      while (!this.closed && this.queue.length > 0) {
        const jobId = this.queue.shift() as string;
        try {
          await this.runJob(jobId);
        } catch (error) {
          // runJob her hatayı yakalar; buraya ulaşmak beklenmedik bir
          // kusurdur (ör. donmuş kayıt inşası) — işi güvenli biçimde
          // düşürür, kuyruk çalışmaya devam eder.
          if (!this.closed) {
            this.failSafely(jobId, error);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private emitProgress(jobId: string, event: IndexProgressEvent): void {
    if (this.closed) return;
    const existing = this.records.get(jobId);
    if (existing !== undefined && existing.status === "running") {
      const updated = freezeRecord({
        ...existing,
        progressPercent: progressPercentFromEvent(event, existing.progressPercent),
        progress: {
          phase: event.phase,
          completed: event.completed,
          total: event.total,
          message: event.message,
        },
      });
      this.records.set(jobId, updated);
    }
    try {
      this.onProgressListener?.(jobId, event);
    } catch {
      // Listener errors must never crash the indexing job queue.
    }
    const perJob = this.progressListeners.get(jobId);
    if (perJob !== undefined) {
      for (const listener of perJob) {
        try {
          listener(event);
        } catch {
          // Listener errors must never crash the indexing job queue.
        }
      }
    }
  }

  private resolveWorkerEntry(): ResolvedWorkerEntry | undefined {
    if (this.workerEntryPath !== undefined) {
      const validated = validateWorkerEntryPath(this.workerEntryPath);
      if (validated === undefined) return undefined;
      return {
        kind: validated.endsWith(".ts") ? "ts-source" : "js",
        path: validated,
      };
    }
    let selfPath: string;
    try {
      selfPath = fileURLToPath(import.meta.url);
    } catch {
      return undefined;
    }
    const selfDir = path.dirname(selfPath);
    if (selfPath.endsWith(".ts")) {
      const tsWorker = validateWorkerEntryPath(
        path.join(selfDir, "index-worker.ts"),
        selfDir,
      );
      return tsWorker !== undefined
        ? { kind: "ts-source", path: tsWorker }
        : undefined;
    }
    if (selfPath.endsWith(".mjs")) {
      const mjsWorker = validateWorkerEntryPath(
        path.join(selfDir, "index-worker.mjs"),
        selfDir,
      );
      if (mjsWorker !== undefined) return { kind: "js", path: mjsWorker };
      const jsWorker = validateWorkerEntryPath(
        path.join(selfDir, "index-worker.js"),
        selfDir,
      );
      if (jsWorker !== undefined) return { kind: "js", path: jsWorker };
      return undefined;
    }
    const jsWorker = validateWorkerEntryPath(
      path.join(selfDir, "index-worker.js"),
      selfDir,
    );
    if (jsWorker !== undefined) return { kind: "js", path: jsWorker };
    const mjsWorker = validateWorkerEntryPath(
      path.join(selfDir, "index-worker.mjs"),
      selfDir,
    );
    if (mjsWorker !== undefined) return { kind: "js", path: mjsWorker };
    return undefined;
  }

  private runInWorkerThread(
    jobId: string,
    rootPath: string,
    running: IndexJobRecord,
    workerEntry: ResolvedWorkerEntry,
    dbPath: string,
    serviceConfig: IndexWorkerServiceConfig,
  ): Promise<IndexWorkerResultSummary> {
    if (this.closed) {
      return Promise.reject(
        new IndexingError(
          "indexing/internal",
          "Indexing job cancelled: job manager closed",
        ),
      );
    }

    const payload: IndexWorkerTaskInput = {
      dbPath,
      rootPath,
      mode: running.mode,
      changeSet: [...running.changeSet],
      workspaceId: serviceConfig.workspaceId,
      policyConfig: serviceConfig.policyConfig,
      limits: serviceConfig.limits,
      ...(serviceConfig.csharp === undefined ? {} : { csharp: serviceConfig.csharp }),
      ...(serviceConfig.python === undefined ? {} : { python: serviceConfig.python }),
      ...(serviceConfig.go === undefined ? {} : { go: serviceConfig.go }),
      ...(serviceConfig.rust === undefined ? {} : { rust: serviceConfig.rust }),
      tolerateConcurrentPublishRace: serviceConfig.tolerateConcurrentPublishRace,
      ...(serviceConfig.hostLabel === undefined ? {} : { hostLabel: serviceConfig.hostLabel }),
      leaseTtlMs: serviceConfig.leaseTtlMs,
      leaseHeartbeatIntervalMs: serviceConfig.leaseHeartbeatIntervalMs,
      ...(this.workerFixedClockIso === undefined
        ? {}
        : { fixedClockIso: this.workerFixedClockIso }),
    };

    return new Promise<IndexWorkerResultSummary>((resolve, reject) => {
      if (this.closed) {
        reject(
          new IndexingError(
            "indexing/internal",
            "Indexing job cancelled: job manager closed",
          ),
        );
        return;
      }
      let settled = false;
      const worker =
        workerEntry.kind === "ts-source"
          ? new Worker(TS_WORKER_BOOTSTRAP_CODE, {
              eval: true,
              workerData: {
                ...payload,
                __workerEntryUrl: pathToFileURL(workerEntry.path).href,
                __causorynBootstrap: true,
              },
              execArgv: ["--experimental-transform-types", "--no-warnings"],
            })
          : new Worker(pathToFileURL(workerEntry.path), {
              workerData: payload,
            });
      this.activeWorker = worker;

      const clearActiveWorker = (): void => {
        if (this.activeWorker === worker) {
          this.activeWorker = undefined;
        }
      };

      const finishResolve = (summary: IndexWorkerResultSummary): void => {
        if (settled) return;
        settled = true;
        clearActiveWorker();
        void worker.terminate().catch(() => {});
        resolve(summary);
      };

      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearActiveWorker();
        void worker.terminate().catch(() => {});
        reject(error);
      };

      worker.on("message", (raw: unknown) => {
        if (this.closed) return;
        if (raw === null || typeof raw !== "object") return;
        const msg = raw as IndexWorkerMessage;
        if (msg.type === "progress") {
          this.emitProgress(jobId, {
            phase: msg.phase,
            completed: msg.completed,
            total: msg.total,
            message: msg.message,
          });
          return;
        }
        if (msg.type === "done") {
          finishResolve(msg.result);
          return;
        }
        if (msg.type === "error") {
          finishReject(
            new IndexingError(
              msg.code === "indexing/root-not-authorized" ||
                msg.code === "indexing/limit-exceeded" ||
                msg.code === "indexing/unsupported-mode" ||
                msg.code === "indexing/internal"
                ? msg.code
                : "indexing/internal",
              msg.message,
            ),
          );
        }
      });

      worker.on("error", (err) => {
        clearActiveWorker();
        finishReject(err);
      });

      worker.on("exit", (exitCode) => {
        clearActiveWorker();
        if (!settled) {
          finishReject(
            new IndexingError(
              "indexing/internal",
              `Indexing worker exited unexpectedly with code ${String(exitCode)}`,
            ),
          );
        }
      });
    });
  }

  /**
   * İş koşumu (B9 + Task 2.5): SQLite `dbPath` ve worker giriş noktası
   * mevcutsa indeksleme işini ana event-loop'u bloklamadan kendi `worker_threads`
   * iş parçacığında yürütür; bellek içi depo veya worker yoksa in-process async
   * pipeline'a zarifçe düşer. Her iki yolda da canlı progress olayları akar.
   */
  private async runJob(jobId: string): Promise<void> {
    if (this.closed) return;
    const current = this.records.get(jobId);
    const rootPath = this.roots.get(jobId);
    if (current === undefined || rootPath === undefined) return;

    const serviceConfig = this.useWorkerThread
      ? this.indexService.getWorkerConfig()
      : undefined;
    const effectiveDbPath = this.workerDbPath ?? serviceConfig?.dbPath;
    const workerEntry =
      this.useWorkerThread &&
      effectiveDbPath !== undefined &&
      serviceConfig !== undefined
        ? this.resolveWorkerEntry()
        : undefined;
    const executionMode: "worker" | "in-process" =
      workerEntry !== undefined &&
      effectiveDbPath !== undefined &&
      serviceConfig !== undefined
        ? "worker"
        : "in-process";

    const running = freezeRecord({
      ...current,
      status: "running",
      progressPercent: RUNNING_PROGRESS_PERCENT,
      progress: {
        phase: "inventory",
        completed: 0,
        total: 0,
        message: "Starting indexing job",
      },
      startedAt: this.clock(),
      executionMode,
    });
    this.records.set(jobId, running);

    let result: IndexRunResult | IndexWorkerResultSummary;
    try {
      if (
        executionMode === "worker" &&
        workerEntry !== undefined &&
        effectiveDbPath !== undefined &&
        serviceConfig !== undefined
      ) {
        result = await this.runInWorkerThread(
          jobId,
          rootPath,
          running,
          workerEntry,
          effectiveDbPath,
          serviceConfig,
        );
        if (this.closed) return;
        this.indexService.syncRunCountFromRepository();
      } else {
        const onProgress: IndexProgressCallback = (event) => {
          this.emitProgress(jobId, event);
        };
        result =
          running.mode === "incremental"
            ? await this.indexService.runIncrementalIndexAsync(
                rootPath,
                running.changeSet,
                { onProgress },
              )
            : await this.indexService.runIndexAsync(rootPath, { onProgress });
        if (this.closed) return;
      }
    } catch (error) {
      if (this.closed) return;
      const code = error instanceof IndexingError ? error.code : "indexing/internal";
      const message = error instanceof Error ? error.message : String(error);
      const latestBeforeFail = this.records.get(jobId) ?? running;
      const failed = freezeRecord({
        ...latestBeforeFail,
        status: "failed",
        progress: {
          phase: "failed",
          completed: latestBeforeFail.progress.completed,
          total: latestBeforeFail.progress.total,
          message,
        },
        finishedAt: this.clock(),
        error: { code, message },
      });
      this.records.set(jobId, failed);
      this.progressListeners.delete(jobId);
      this.settle(jobId);
      // Güvenlik bulgusu 5: terminal kayıt sonrası saklama sınırı boşaltılır
      // (yalnızca terminal kayıtlar düşürülür — bkz. evictOverflow).
      this.evictOverflow();
      return;
    }

    const latestBeforeDone = this.records.get(jobId) ?? running;
    const totalFiles = result.fileCount;
    const done = freezeRecord({
      ...latestBeforeDone,
      status: "done",
      progressPercent: 100,
      progress: {
        phase: "done",
        completed: totalFiles,
        total: totalFiles,
        message: `Published snapshot ${result.snapshotId}`,
      },
      finishedAt: this.clock(),
      snapshotId: result.snapshotId,
      snapshotState: result.state,
      stale: result.stale,
      fileCount: result.fileCount,
      tsFileCount: result.tsFileCount,
      csFileCount: result.csFileCount,
      diagnostics: result.diagnostics,
      warnings: result.warnings,
      error: null,
      executionMode,
      ...(result.reanalyzedFiles === undefined
        ? {}
        : { reanalyzedFiles: result.reanalyzedFiles }),
      ...(result.cachedFiles === undefined ? {} : { cachedFiles: result.cachedFiles }),
      ...(result.earlyCutoffApplied === undefined
        ? {}
        : { earlyCutoffApplied: result.earlyCutoffApplied }),
    });
    this.records.set(jobId, done);
    this.progressListeners.delete(jobId);
    this.settle(jobId);
    this.evictOverflow();
  }

  private failSafely(jobId: string, error: unknown): void {
    const current = this.records.get(jobId);
    if (current !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      this.records.set(
        jobId,
        freezeRecord({
          ...current,
          status: "failed",
          progress: {
            phase: "failed",
            completed: current.progress.completed,
            total: current.progress.total,
            message,
          },
          finishedAt: this.clock(),
          error: { code: "indexing/internal", message },
        }),
      );
    }
    this.progressListeners.delete(jobId);
    this.settle(jobId);
    this.evictOverflow();
  }

  /** Bekleyen waiter'ları terminal kayıtla çözer. */
  private settle(jobId: string): void {
    const record = this.records.get(jobId);
    const list = this.waiters.get(jobId);
    if (list === undefined) return;
    this.waiters.delete(jobId);
    for (const waiter of list) {
      if (record === undefined) {
        waiter.reject(new Error(`iş kaydı kayboldu: ${jobId}`));
      } else {
        waiter.resolve(record);
      }
    }
  }

  /**
   * maxJobs aşımında en eski TERMINAL kaydı FIFO düşürür (güvenlik
   * bulgusu 5). Kuyrukta bekleyen veya işletimde olan işler ASLA
   * düşürülmez: kayıt düşürmek işi sessizce iptal ederdi (runJob kayıt
   * yokken sessiz döner, iş koşum olmadan kaybolur). maxJobs bir kayıt
   * SAKLAMA sınırıdır — geçici taşma kuyruk uzunluğuyla sınırlıdır ve
   * işler terminal duruma gelirken boşaltılır (post-settle evict).
   * Terminal kayıtların waiter'ları settle ile zaten çözülmüştür; reject
   * dalı savunma amaçlı kalır.
   */
  private evictOverflow(): void {
    while (this.records.size > this.maxJobs) {
      let oldestTerminal: string | undefined;
      for (const [jobId, record] of this.records) {
        if (record.status === "done" || record.status === "failed") {
          oldestTerminal = jobId;
          break;
        }
      }
      if (oldestTerminal === undefined) break;
      const jobId = oldestTerminal;
      this.records.delete(jobId);
      this.roots.delete(jobId);
      const list = this.waiters.get(jobId);
      if (list !== undefined) {
        this.waiters.delete(jobId);
        for (const waiter of list) {
          waiter.reject(new Error(`iş kaydı sınır aşımıyla düşürüldü: ${jobId}`));
        }
      }
    }
  }
}
