import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

import { sha256Hex, utf8Encode } from "@causoryn/domain";
import type { GraphRepository } from "@causoryn/graph";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import type { IndexJobManager } from "./job-manager.js";

/**
 * WorkspaceWatcher — Live Architecture FS watcher (TŞ v2.1 §9 "Incremental
 * pipeline" + §16A.5 "Canlı güncelleme"; sprint-2 B7).
 *
 * Boru hattı (TŞ §16A.5 dilimi):
 *   fs.watch olayı → WorkspaceAccessPolicy süzgeci (allowlist/ignore;
 *   TŞ §16A.5/1 "ignore/secret politikası uygulanır") → pending kümesi →
 *   debounce (TŞ §9: 300–1000 ms; trailing edge) → fingerprint karma
 *   karşılaştırması (TŞ §9 "fingerprint"; içerik değişmeyen olay = no-op
 *   skip) → invalidation tetikleyicisi (TŞ §9: package.json/tsconfig/.sln/
 *   .csproj değişimi → FULL rebuild; aksi halde incremental iş) →
 *   IndexJobManager kuyruğu (tek işletim, atomik publish) → done işinde
 *   fingerprint tablosu tazelenir.
 *
 * Kapsam dürüstlük notu (ADR-010): "incremental" iş, DEĞİŞEN dosyaların
 * güncel içerikle yeniden analiz edildiği ve graph'ın deterministik
 * pipeline'dan türetilerek atomik yayımlandığı işlettir. Dosya başına
 * parse önbelleği YOKTUR: TS adapter'ı program-geniş çözümleme yapar
 * (analyzeTypeScriptProgram) ve GraphRepository sözleşmesi snapshot
 * başına build gerektirir; graph tutarlılığı (IMPORTS/CALLS kenarları
 * değişmeyen ithalatçıları da ilgilendirir) tam türetimi zorunlu kılar.
 * Bu dilimin "incremental" değeri: olay-sürümü tetikleme, policy süzgeci,
 * fingerprint no-op atlaması, mod seçimi ve changeSet takibidir. Per-file
 * parse reuse, adapter seam'i sonrası dilim işidir.
 *
 * Hataya dayanıklılık (TŞ §16A.5/6, ask şartı 5): fs.watch kurulumu veya
 * error olayı (EMFILE vb.) motoru DÜŞÜRMEZ — stderr log + state "degraded"
 * + tek reconciliation full işi (TŞ §9 "overflow ... durumunda
 * reconciliation scan"). Watcher callback'i asla exception sızdırmaz.
 *
 * Yaşam döngüsü: start/stop in-process API'dir (Faz B'de MCP aracı DEĞİL;
 * araca sarma Faz B+ kararı olarak not edilmiştir — TŞ §10.2 kataloğunda
 * watcher tool'u yoktur).
 *
 * Policy değişimi (TŞ §9 "policy değişince ... invalid") bu dilimde FS
 * olayıyla izlenmez: WorkspaceAccessPolicy config'i in-process nesnedir;
 * config değişimi ayrı dilim konusudur. Kod yolu: config-hash alan
 * snapshot'lar zaten config değişiminde farklı kimlik üretir.
 *
 * Bu paket saat okumaz: log satırları enjekte edilen `clock`'tan gelir.
 */

/** TŞ §9 debounce bandı: "FS watcher 300–1000 ms debounce". */
export const WATCHER_DEBOUNCE_MIN_MS = 300;
export const WATCHER_DEBOUNCE_MAX_MS = 1000;
/** Varsayılan debounce: bandın ortası. */
export const WATCHER_DEBOUNCE_DEFAULT_MS = 500;

/**
 * Güvenlik bulgusu 2: trailing-edge debounce'in LIVENESS üst sınırı.
 * Her yeni olay pencereyi sıfırladığı için sürekli olay akışı (workspace'e
 * yazan dev-server/build aracı) flushPending'i süresiz geciktirebilirdi
 * ve pending kümesi sınırsız büyüyebilirdi. max-wait dolunca küme
 * mutlaka flush'lanır: varsayılan debounce × 4 (500 ms → 2000 ms).
 */
export const WATCHER_MAX_WAIT_DEFAULT_MULTIPLIER = 4;
/** maxWaitMs için üst sınır (makul bütçe; testler alt değer verir). */
export const WATCHER_MAX_WAIT_MAX_MS = 60_000;

/** Watcher yaşam döngüsü durumları. */
export type WorkspaceWatcherState = "stopped" | "watching" | "degraded";

/** Sayılabilir gözlemlenebilirlik sayaçları (test ve tanı için). */
export interface WorkspaceWatcherStats {
  /** Politika süzgecine giren toplam fs.watch olayı (null filename dahil). */
  readonly eventsReceived: number;
  /** Politika kararıyla (ignore/escape/null-ad) düşürülen olay sayısı. */
  readonly eventsFiltered: number;
  /** Fingerprint karması değişmediği için iş AÇILMAYAN olay kümesi üyesi. */
  readonly noOpSkipped: number;
  /** Açılan reindex iş sayısı (incremental + full/reconciliation). */
  readonly jobsEnqueued: number;
  /** Kurulum/çalışma hatası sayısı (degrade epizotları). */
  readonly errors: number;
  /** Debounce penceresinde bekleyen yol sayısı. */
  readonly pendingPaths: number;
}

/**
 * Watch handle yapısal tipi: node:fs.FSWatcher'ın kullanılan yüzeyi.
 * `watchFactory` seam'i testlere sahte handle takma izni verir; motor
 * davranışı gerçek fs.watch ile test edilir (factory verilmezse).
 */
export interface WatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type WatchFactory = (
  root: string,
  listener: (event: string, filename: string | null) => void,
) => WatchHandle;

export interface WorkspaceWatcherOptions {
  /** İzlenecek kök; policy allowRoot'larında olmalıdır. */
  readonly rootPath: string;
  readonly policy: WorkspaceAccessPolicy;
  /** Debounce sonrası iş açılan kuyruk (serial işletim sahibi). */
  readonly jobManager: IndexJobManager;
  /** Fingerprint kaynağı: done işi sonrası files tablosu buradan okunur. */
  readonly repository: GraphRepository;
  readonly workspaceId: string;
  /** ISO-8601 log damgası; paket saat okumaz. */
  readonly clock: () => string;
  /** TŞ §9 bandında [300,1000] tam sayı; dışı RangeError. Varsayılan 500. */
  readonly debounceMs?: number;
  /**
   * Güvenlik bulgusu 2: debounce max-wait liveness bütçesi (ms). Sürekli
   * olay akışında trailing-edge pencere süresiz sıfırlanabildiğinden,
   * pending kümesi İLK olayından itibaren bu süre dolunca mutlaka
   * flush'lanır. Tam sayı, ≥ debounceMs ve ≤ 60_000; dışı RangeError.
   * Varsayılan: debounceMs × 4.
   */
  readonly maxWaitMs?: number;
  /** Varsayılan: stderr'e tek satır yazar (kırmızı çizgi: stdout MCP'dir). */
  readonly log?: (line: string) => void;
  /** Degrade epizotunda çağrılır; watcher hatayı yine de kendi loglar. */
  readonly onError?: (error: Error) => void;
  /** Varsayılan: node:fs.watch(recursive: true). Test seam. */
  readonly watchFactory?: WatchFactory;
}

/**
 * TŞ §9 invalidation tetikleyicileri: "package.json/tsconfig/.sln/.csproj
 * ve policy değişince bağımlı alanlar invalid edilir". Bu dosyalara dokunan
 * değişim kümesi FULL rebuild açar; diğerleri incremental işlettir.
 */
const TS_JS_CONFIG_TRIGGER_PATTERN = /^(?:ts|js)config(?:\..+|-.*)?\.json$/i;

function isInvalidationTrigger(relativePosix: string): boolean {
  const base = path.posix.basename(relativePosix).toLowerCase();
  return (
    base === "package.json" ||
    TS_JS_CONFIG_TRIGGER_PATTERN.test(base) ||
    base.endsWith(".sln") ||
    base.endsWith(".csproj")
  );
}

function toPosix(nativeRelative: string): string {
  return nativeRelative.split(path.sep).join("/");
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Tek dosyanın güncel içerik karması. TŞ §19 TOCTOU sözleşmesi bu açma
 * noktasında da uygulanır (workspace-access-policy.ts:27-32; envanterdeki
 * karşılığı inventory.ts:75-121): (1) leksik sınır + null byte koruması,
 * (2) `O_RDONLY | O_NOFOLLOW` ile tek fd açılıp `fstatSync` + sınırlı
 * `readSync` (≤ `maxFileBytes + 1`) okuması (TOCTOU yarış penceresi yok),
 * (3) okuma sonrası `policy.checkFile` ile YENİDEN denetim (realpath kapsamı
 * + ignore + boyut). checkPath ile hash arasında symlink takasıyla kök
 * dışına çıkan dosya hash'LENMEZ.
 *
 * Dönüş: string = içerik karması; null = yok/dizin/kural-dışı (silinme-
 * benzeri semantik: indekslenmişse değişim sayılır, hiç indekslenmemişse
 * geçici dosya sayılır); undefined = okunamaz/boyut aşımı (konservatif
 * değişim).
 */
export function hashWorkspaceFile(
  policy: WorkspaceAccessPolicy,
  canonicalRoot: string,
  relativePosix: string,
  maxFileBytes: number,
): string | undefined | null {
  // Leksik + null byte koruması (savunma derinliği): olay anındaki
  // checkPath `..`/mutlak yolu zaten reddeder; hash kendi girdisinde de
  // zorunlu kılar (açma, policy kararından farklı zamanda olur).
  if (
    relativePosix.length === 0 ||
    relativePosix.includes("\0") ||
    relativePosix.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  const absolute = path.resolve(canonicalRoot, relativePosix);
  if (absolute !== canonicalRoot && !absolute.startsWith(canonicalRoot + path.sep)) {
    return null;
  }
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(absolute, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "ELOOP"
    ) {
      return null; // yok/dizin/symlink → yok sayılır (silinme fingerprints tarafında)
    }
    return undefined; // açılamadı: konservatif değişim
  }
  let content: string;
  let sizeBytes: number;
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null; // dosya değil (dizin/FIFO vb.) → yok sayılır
    if (fdStat.size > maxFileBytes) return undefined; // okunmaz: konservatif değişim
    const chunks: Buffer[] = [];
    let totalRead = 0;
    const hardCap = maxFileBytes + 1;
    while (totalRead < hardCap) {
      const toRead = Math.min(READ_CHUNK_BYTES, hardCap - totalRead);
      const chunk = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(fd, chunk, 0, toRead, null);
      if (bytesRead <= 0) break;
      chunks.push(bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead));
      totalRead += bytesRead;
    }
    if (totalRead > maxFileBytes) {
      return undefined; // okuma sırasında boyut sınırı aşıldı: konservatif değişim
    }
    content = Buffer.concat(chunks, totalRead).toString("utf8");
    sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > maxFileBytes) {
      return undefined;
    }
  } catch {
    return undefined; // okunamadı: konservatif değişim
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Kapatma hatası yutulur.
    }
  }
  // TŞ §19 "file handle sonrası path tekrar kontrolü": okunan gerçek
  // boyutla politika kararı YENİDEN alınır; deny → workspace dışı içerik.
  const postDecision = policy.checkFile(canonicalRoot, relativePosix, sizeBytes);
  if (!postDecision.allowed) {
    return null;
  }
  return sha256Hex(utf8Encode(content));
}

const DEFAULT_LOG = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Varsayılan factory: gerçek node:fs.watch (recursive). */
function defaultWatchFactory(root: string, listener: (event: string, filename: string | null) => void): WatchHandle {
  const watcher: FSWatcher = fsWatch(root, { recursive: true }, (event, filename) => {
    // Kodlanamayan dosya adı (Buffer) null'a düşer: watcher bunu
    // "politika kararı verilemez" kovasına sayar (eventsFiltered).
    listener(event, typeof filename === "string" ? filename : null);
  });
  return watcher;
}

export class WorkspaceWatcher {
  private readonly rootPath: string;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly jobManager: IndexJobManager;
  private readonly repository: GraphRepository;
  private readonly workspaceId: string;
  private readonly clock: () => string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly log: (line: string) => void;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly watchFactory: WatchFactory;

  private watcherState: WorkspaceWatcherState = "stopped";
  private canonicalRoot: string | undefined;
  private handle: WatchHandle | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce penceresindeki aday yollar (POSIX kök-göreceli). */
  private readonly pending = new Set<string>();
  /**
   * Güncel bekleyen kümenin İLK olayının monotonic ms damgası (Date.now;
   * setTimeout ile aynı gerçek-zaman tabanı). max-wait liveness bütçesi
   * bunun üzerinden ölçülür; flush/stop/degrade'de temizlenir.
   */
  private pendingSince: number | undefined;
  /** En son indekslenen durum: relativePath → contentHash (TŞ fingerprint). */
  private fingerprints = new Map<string, string>();

  private eventsReceived = 0;
  private eventsFiltered = 0;
  private noOpSkipped = 0;
  private jobsEnqueued = 0;
  private errors = 0;

  constructor(options: WorkspaceWatcherOptions) {
    const debounceMs = options.debounceMs ?? WATCHER_DEBOUNCE_DEFAULT_MS;
    if (
      !Number.isInteger(debounceMs) ||
      debounceMs < WATCHER_DEBOUNCE_MIN_MS ||
      debounceMs > WATCHER_DEBOUNCE_MAX_MS
    ) {
      throw new RangeError(
        `debounceMs must be an integer within [${String(WATCHER_DEBOUNCE_MIN_MS)}, ${String(WATCHER_DEBOUNCE_MAX_MS)}] ms; received: ${String(debounceMs)}`,
      );
    }
    const maxWaitMs =
      options.maxWaitMs ?? debounceMs * WATCHER_MAX_WAIT_DEFAULT_MULTIPLIER;
    if (
      !Number.isInteger(maxWaitMs) ||
      maxWaitMs < debounceMs ||
      maxWaitMs > WATCHER_MAX_WAIT_MAX_MS
    ) {
      throw new RangeError(
        `maxWaitMs must be an integer within [debounceMs, ${String(WATCHER_MAX_WAIT_MAX_MS)}] (>= ${String(debounceMs)}); received: ${String(maxWaitMs)}`,
      );
    }
    this.rootPath = options.rootPath;
    this.policy = options.policy;
    this.jobManager = options.jobManager;
    this.repository = options.repository;
    this.workspaceId = options.workspaceId;
    this.clock = options.clock;
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.log = options.log ?? DEFAULT_LOG;
    this.onError = options.onError;
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
  }

  /** Gözlemlenebilirlik: sayaçların donmuş kopyası. */
  stats(): WorkspaceWatcherStats {
    return Object.freeze({
      eventsReceived: this.eventsReceived,
      eventsFiltered: this.eventsFiltered,
      noOpSkipped: this.noOpSkipped,
      jobsEnqueued: this.jobsEnqueued,
      errors: this.errors,
      pendingPaths: this.pending.size,
    });
  }

  /** Yaşam döngüsü durumu (test ve tanı yüzeyi). */
  get state(): WorkspaceWatcherState {
    return this.watcherState;
  }

  /* ---------------------------------------------------------------- */
  /* Seam dayanıklılığı (denetim bulgusu 1)                           */
  /* ---------------------------------------------------------------- */

  /**
   * Enjekte edilebilir log seam'i fırlatabilir (kapalı pipe'a stderr
   * yazımı Windows'ta EPIPE fırlatır). Bu fırlama fs.watch 'error' olay
   * zincirinden veya setTimeout callback'inden process düzeyinde
   * uncaughtException olarak sıçrar ve motoru düşürürdü — dilimin
   * "watcher callback'i ASLA exception sızdırmaz" invariant'ı (sınıf
   * başlığı; TŞ §16A.5/6 "watcher hatası motoru düşürmez") log kusurundan
   * bağımsız tutulur: seam fırlatması sessizce yutulur.
   */
  private safeLog(line: string): void {
    try {
      this.log(line);
    } catch {
      // log seam'inin kusuru: yutulur, invariant önceliklidir.
    }
  }

  /** safeLog ile aynı gerekçe — onError seam'i için. */
  private safeOnError(error: Error): void {
    try {
      this.onError?.(error);
    } catch {
      // yutulur
    }
  }

  /**
   * İzlemeyi başlatır. Kök yetkisizse IndexingError ile reddedilir (senkron
   * sözleşme, IndexJobManager ile aynı). Kurulum hatası FIRLATMAZ: degrade
   * + log + reconciliation full işi (TŞ §16A.5/6; motor etkilenmez).
   */
  start(): void {
    if (this.watcherState !== "stopped") {
      throw new Error(`WorkspaceWatcher is already ${this.watcherState}; call stop() first`);
    }
    const decision = this.policy.authorizeRoot(this.rootPath);
    if (!decision.allowed) {
      throw new IndexingError(
        "indexing/root-not-authorized",
        `root to watch is not authorized (${decision.code}): ${decision.reason}`,
      );
    }
    this.canonicalRoot = decision.canonicalRoot;
    this.seedFingerprints();
    let handle: WatchHandle;
    try {
      handle = this.watchFactory(this.canonicalRoot, (event, filename) =>
        this.onWatchEvent(event, filename),
      );
    } catch (error) {
      this.degrade(error instanceof Error ? error : new Error(String(error)), "watch-kurulumu");
      return;
    }
    handle.on("error", (error) => this.handleWatcherError(error));
    this.handle = handle;
    this.watcherState = "watching";
    this.safeLog(`[${this.clock()}] [causoryn-watch] watching started: ${this.canonicalRoot} (debounce ${String(this.debounceMs)} ms)`);
  }

  /**
   * İzlemeyi durdurur; idempotent. Zaten kuyruğa girmiş işler JobManager
   * sahipliğinde tamamlanır (watcher yalnızca tetikleyicidir).
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.handle !== undefined) {
      try {
        this.handle.close();
      } catch (error) {
        this.safeLog(`[${this.clock()}] [causoryn-watch] close error (ignored): ${error instanceof Error ? error.message : String(error)}`);
      }
      this.handle = undefined;
    }
    this.pending.clear();
    this.pendingSince = undefined;
    this.watcherState = "stopped";
  }

  /* ---------------------------------------------------------------- */
  /* İç akış                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * fs.watch olayı: policy süzgeci + pending kümesi + debounce zamanlayıcı.
   * Olay türü (rename/change) ayrımına girilmez: debounce penceresi her iki
   * türü tek değişiklik kümesinde birleştirir (TŞ §16A.5/1).
   */
  private onWatchEvent(_event: string, filename: string | null): void {
    // Kurallı sözleşme: watcher callback'i ASLA exception sızdırmaz —
    // sızan hata process düzeyinde uncaught exception olurdu.
    try {
      if (this.watcherState !== "watching") return;
      this.eventsReceived += 1;
      if (filename === null || filename.length === 0) {
        // Platform dosya adı veremedi: politika kararı verilemez → düşürülür.
        this.eventsFiltered += 1;
        return;
      }
      const relativePosix = toPosix(filename);
      const decision = this.policy.checkPath(this.canonicalRoot as string, relativePosix);
      if (!decision.allowed) {
        this.eventsFiltered += 1;
        return;
      }
      this.pending.add(decision.relativePath);
      if (this.pendingSince === undefined) {
        this.pendingSince = Date.now();
      }
      this.scheduleDebounce();
    } catch (error) {
      this.errors += 1;
      this.safeLog(`[${this.clock()}] [causoryn-watch] event handling error (event dropped, engine keeps running): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Trailing-edge debounce (TŞ §9) + max-wait liveness sınırı (güvenlik
   * bulgusu 2): her yeni olay pencereyi debounceMs'e sıfırlar; ancak
   * pendingSince'den bu yana maxWaitMs dolduysa gecikme min(debounce,
   * kalan-max-wait)'e kırpılır — sürekli olay akışı flush'u süresiz
   * geciktiremez, pending kümesi sınırsız büyüyemez.
   */
  private scheduleDebounce(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const pendingSince = this.pendingSince ?? Date.now();
    const remainingMaxWait = this.maxWaitMs - (Date.now() - pendingSince);
    const delay = Math.min(this.debounceMs, Math.max(0, remainingMaxWait));
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.flushPending();
      },
      delay,
    );
    // Timer process'i tek başına ayakta tutmasın (in-process bileşen).
    this.timer.unref?.();
  }

  /** Debounce penceresi kapandı: pending kümesini fingerprint'ten geçir. */
  private flushPending(): void {
    try {
      if (this.watcherState !== "watching") {
        this.pending.clear();
        this.pendingSince = undefined;
        return;
      }
      if (this.pending.size === 0) return;
      // Küme tüketildi: max-wait ölçümü yeni batch için sıfırlanır.
      this.pendingSince = undefined;
      const candidates = [...this.pending].sort();
      this.pending.clear();
      const evaluated = candidates.map((relativePosix) => ({
        relativePosix,
        ...this.resolveChange(relativePosix),
      }));
      const changed = evaluated.filter((entry) => entry.changed);
      const skipped = candidates.length - changed.length;
      if (skipped > 0) this.noOpSkipped += skipped;
      if (changed.length === 0) {
        this.safeLog(`[${this.clock()}] [causoryn-watch] no content change in the debounce batch (no-op skip: ${String(skipped)})`);
        return;
      }
      const mode = changed.some((entry) => isInvalidationTrigger(entry.relativePosix))
        ? "full"
        : "incremental";
      // Optimist fingerprint (denetim bulgusu 3): flush'lanan yolların
      // beklenen karması iş KUYRUĞA GİRMEDEN işlenir — iş kuyrukta/yolda
      // iken gelen mükerrer (straggler) olay aynı karmayı bulur ve no-op
      // düşer; ikinci iş AÇILMAZ. İş başarısız olursa trackJob geri alır.
      const rollback = new Map<string, string | undefined>();
      for (const entry of changed) {
        rollback.set(entry.relativePosix, this.fingerprints.get(entry.relativePosix));
        if (typeof entry.hash === "string") {
          this.fingerprints.set(entry.relativePosix, entry.hash);
        }
      }
      try {
        // JobManager işi SERİ kuyrukta koşturur; watcher await ETMEZ.
        const job = this.jobManager.refreshIndex(this.rootPath, { mode, changeSet: changed.map((entry) => entry.relativePosix) });
        this.jobsEnqueued += 1;
        this.safeLog(`[${this.clock()}] [causoryn-watch] ${mode} job queued (${job.jobId}; ${String(changed.length)} paths)`);
        this.trackJob(job.jobId, rollback);
      } catch (enqueueError) {
        // İş açılamadı: optimist yazımı geri al — aynı dosyanın sonraki
        // olayı yeniden iş açabilsin (kayıp değişiklik yok).
        for (const [relativePosix, previous] of rollback) {
          if (previous === undefined) this.fingerprints.delete(relativePosix);
          else this.fingerprints.set(relativePosix, previous);
        }
        throw enqueueError;
      }
    } catch (error) {
      // refreshIndex reddi (ör. kök artık yetkili değil) motoru düşürmez.
      this.errors += 1;
      this.safeLog(`[${this.clock()}] [causoryn-watch] flush error (engine keeps running): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * TŞ §9 fingerprint adımı: karma değişmeyen (touch/geçici) aday iş
   * AÇMAZ. Dosya yok ama fingerprint'te VAR → silinme = değişim; dosya
   * yok ve hiç indekslenmemiş → geçici dosya, atlanır. Dönen hash,
   * flushPending'in optimist fingerprint yazımı içindir (denetim
   * bulgusu 3).
   */
  private resolveChange(relativePosix: string): {
    changed: boolean;
    hash: string | undefined | null;
  } {
    const previous = this.fingerprints.get(relativePosix);
    const current = hashWorkspaceFile(
      this.policy,
      this.canonicalRoot as string,
      relativePosix,
      this.policy.config.maxFileBytes,
    );
    let changed: boolean;
    if (current === null) {
      changed = previous !== undefined; // yok/kural-dışı: indekslenmişse değişti
    } else if (current === undefined) {
      changed = true; // okunamadı/boyut aşımı: konservatif değişim
    } else {
      changed = previous !== current;
    }
    return { changed, hash: current };
  }

  /** start'ta ve done işi sonrası files tablosundan karma tablosu tazele. */
  private seedFingerprints(): void {
    try {
      this.fingerprints = new Map(
        this.repository
          .listFiles(this.workspaceId)
          .map((record) => [record.relativePath, record.contentHash]),
      );
    } catch (error) {
      // İzleme fingerprint'siz de çalışır (konservatif: her olay değişim);
      // hata motoru düşürmez.
      this.fingerprints = new Map();
      this.safeLog(`[${this.clock()}] [causoryn-watch] could not seed fingerprints (conservative mode): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * done işinden sonra karma tablosunu tazeler; reddedilen promise sessizdir.
   * İş BAŞARISIZ olursa flushPending'in optimist fingerprint yazımı geri
   * alınır: aynı dosyanın bir sonraki olayı yeniden iş açar (kayıp
   * değişiklik yok; denetim bulgusu 3'ün yarım-kalma durumu).
   */
  private trackJob(jobId: string, rollback: ReadonlyMap<string, string | undefined>): void {
    this.jobManager
      .waitForJob(jobId)
      .then((record) => {
        // `done` (published) and `reused` (no new snapshot needed) both mean
        // the indexed state matches; only `failed` rolls back.
        if (record.status === "done" || record.status === "reused") {
          this.seedFingerprints();
          return;
        }
        // failed: optimist karmaları geri al.
        for (const [relativePosix, previous] of rollback) {
          if (previous === undefined) this.fingerprints.delete(relativePosix);
          else this.fingerprints.set(relativePosix, previous);
        }
      })
      .catch(() => undefined); // kayıt evict edildi/bilinmiyor: yok sayılır
  }

  /** Çalışma anı error olayı: degrade + reconciliation full işi. */
  private handleWatcherError(event: Error): void {
    if (this.watcherState !== "watching") return;
    this.degrade(event, "watch-error");
  }

  /**
   * Degrade epizotu: handle kapatılır, state "degraded" olur, log + onError
   * + TEK reconciliation full işi (TŞ §9 "overflow ... reconciliation scan";
   * TŞ §16A.5/6 "yeni snapshot hazır olana dek eski stale=true okunur").
   */
  private degrade(error: Error, phase: string): void {
    this.errors += 1;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    this.pendingSince = undefined;
    if (this.handle !== undefined) {
      try {
        this.handle.close();
      } catch {
        // close hatası degrade'i değiştirmez
      }
      this.handle = undefined;
    }
    this.watcherState = "degraded";
    this.safeLog(`[${this.clock()}] [causoryn-watch] ${phase} error: ${error.message}; watcher degraded (engine unaffected), queuing a full reconciliation job`);
    this.safeOnError(error);
    try {
      const job = this.jobManager.refreshIndex(this.rootPath, { mode: "full" });
      this.jobsEnqueued += 1;
      this.trackJob(job.jobId, new Map());
    } catch (enqueueError) {
      this.safeLog(`[${this.clock()}] [causoryn-watch] could not queue the reconciliation job: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`);
    }
  }
}
