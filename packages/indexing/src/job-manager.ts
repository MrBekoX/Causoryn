import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import {
  IndexService,
  type IndexDiagnostic,
  type IndexRunResult,
} from "./index-service.js";

/**
 * IndexJobManager — snapshot iş yönetimi (TŞ v2.1 §10.2, sprint-2 B6).
 *
 * causoryn_refresh_index "Yeni snapshot işi" üretir; mevcut
 * envanter → adapter → graph → snapshot pipeline'ı (IndexService.runIndex)
 * bir iş olarak SARMALANIR, pipeline'ın kendisi değiştirilmez. İşler
 * in-process async koşar (TŞ §10.2 "Live Architecture" bağlamının Faz B
 * dilimi): `refreshIndex` çağrısı işi kuyruğa alıp anında döner, kuyruk
 * sırayla (job başına bir runIndex, eşzamanlılık yok) boşalır.
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
 * Progress semantiği (dürüstlük notu): Faz A/B6 pipeline'ı tek senkron
 * adımdır (IndexService.runIndex); ara yüzde (dosya başına) gözlemlenebilir
 * DEĞİLDİR. Bu dilimde progress yalnızca iş yaşam döngüsü aşamalarını
 * raporlar: queued=0 → running=50 → done=100; failed iş son yüzdeyi
 * korur. Dosya düzeyi yüzde, B7 incremental diliminin işidir.
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
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly warnings: readonly string[];
  readonly error: IndexJobError | null;
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
}

/** İş "running" aşamasına geçtiğinde raporlanan ara yüzde (yukarıdaki not). */
const RUNNING_PROGRESS_PERCENT = 50;

/** Varsayılan işletim kaydı sınırı. */
const DEFAULT_MAX_JOBS = 100;

interface JobWaiter {
  readonly resolve: (record: IndexJobRecord) => void;
  readonly reject: (error: unknown) => void;
}

/** Kaydı derin dondurur (dizi kopyalarıyla; ADR-005 stili). */
function freezeRecord(record: IndexJobRecord): IndexJobRecord {
  return Object.freeze({
    ...record,
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
  /** Sayaç tabanlı default jobId üretimi için monoton sayaç. */
  private counter = 0;

  /** jobId → kayıt; ekleme sırası = oluşturma sırası (FIFO evict için). */
  private readonly records = new Map<string, IndexJobRecord>();
  private readonly roots = new Map<string, string>();
  private readonly waiters = new Map<string, JobWaiter[]>();
  private readonly queue: string[] = [];
  private draining = false;
  private lastJobId: string | undefined;

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
  }

  /**
   * Yeni snapshot işi başlatır. Yetkilendirme ve iş türü denetimi SENKRON
   * yapılır: reddedilen istek iş kaydı AÇMAZ ve IndexingError ile çağrı
   * anında reddedilir (MCP katmanı bunu WORKSPACE_NOT_AUTHORIZED /
   * INVALID_ARGUMENT envelope'una çevirir). Kabul edilen istek kuyruğa
   * alınır ve kaydı anında döner (status "queued").
   *
   * Sprint-2 B7: mode "incremental" desteklenir — IndexService.runIncrementalIndex
   * koşturulur; `changeSet` kayda taşınır (karar yetkilisi karma
   * karşılaştırmasıdır, bkz. IndexService.runIncrementalIndex). `scope`
   * hâlâ desteklenmez (indexing/unsupported-mode).
   */
  refreshIndex(
    rootPath: string,
    input: {
      readonly mode: IndexJobMode;
      readonly scope?: string;
      readonly changeSet?: readonly string[];
    },
  ): IndexJobRecord {
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
      createdAt: this.clock(),
      startedAt: null,
      finishedAt: null,
      snapshotId: null,
      snapshotState: null,
      stale: false,
      fileCount: null,
      tsFileCount: null,
      diagnostics: [],
      warnings: [],
      error: null,
    });
    this.records.set(jobId, record);
    this.roots.set(jobId, rootPath);
    this.lastJobId = jobId;
    this.evictOverflow();
    this.enqueue(jobId);
    return this.records.get(jobId) as IndexJobRecord;
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

  /* ---------------------------------------------------------------- */
  /* İç kuyruk                                                        */
  /* ---------------------------------------------------------------- */

  private enqueue(jobId: string): void {
    this.queue.push(jobId);
    if (this.draining) return;
    this.draining = true;
    this.scheduler(() => this.drain());
  }

  private drain(): void {
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift() as string;
        try {
          this.runJob(jobId);
        } catch (error) {
          // runJob her hatayı yakalar; buraya ulaşmak beklenmedik bir
          // kusurdur (ör. donmuş kayıt inşası) — işi güvenli biçimde
          // düşürür, kuyruk çalışmaya devam eder.
          this.failSafely(jobId, error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private runJob(jobId: string): void {
    const current = this.records.get(jobId);
    const rootPath = this.roots.get(jobId);
    if (current === undefined || rootPath === undefined) return;

    const running = freezeRecord({
      ...current,
      status: "running",
      progressPercent: RUNNING_PROGRESS_PERCENT,
      startedAt: this.clock(),
    });
    this.records.set(jobId, running);

    let result: IndexRunResult;
    try {
      result =
        running.mode === "incremental"
          ? this.indexService.runIncrementalIndex(rootPath, running.changeSet)
          : this.indexService.runIndex(rootPath);
    } catch (error) {
      const code = error instanceof IndexingError ? error.code : "indexing/internal";
      const message = error instanceof Error ? error.message : String(error);
      const failed = freezeRecord({
        ...running,
        status: "failed",
        finishedAt: this.clock(),
        error: { code, message },
      });
      this.records.set(jobId, failed);
      this.settle(jobId);
      return;
    }

    const done = freezeRecord({
      ...running,
      status: "done",
      progressPercent: 100,
      finishedAt: this.clock(),
      snapshotId: result.snapshotId,
      snapshotState: result.state,
      stale: result.stale,
      fileCount: result.fileCount,
      tsFileCount: result.tsFileCount,
      diagnostics: result.diagnostics,
      warnings: result.warnings,
      error: null,
    });
    this.records.set(jobId, done);
    this.settle(jobId);
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
          finishedAt: this.clock(),
          error: { code: "indexing/internal", message },
        }),
      );
    }
    this.settle(jobId);
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

  /** maxJobs aşımında en eski kaydı FIFO düşürür; bekleyenleri reddeder. */
  private evictOverflow(): void {
    while (this.records.size > this.maxJobs) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      const jobId = oldest.value;
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
