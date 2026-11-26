import Database from "better-sqlite3";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import { GraphRepositoryError, InMemoryGraphRepository } from "@causoryn/graph";
import type { GraphRepository, SymbolSearchStore } from "@causoryn/graph";
import {
  IndexJobManager,
  IndexService,
  isTerminalIndexJobStatus,
  type IndexJobStatus,
} from "@causoryn/indexing";
import {
  describeLinkInspectionFailure,
  describeWindowsPathSegmentIssue,
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  LINK_TARGET_INSPECTION_ENABLED,
  OutputAccessPolicy,
  WorkspaceAccessPolicy,
} from "@causoryn/workspace";
import {
  hardenSqliteConnection,
  SqliteGraphRepository,
  SqliteWikiStore,
  WikiStoreError,
} from "@causoryn/storage-sqlite";
import { WikiSearchStore } from "@causoryn/wiki";

import {
  CausorynConfigError,
  parseCausorynServerConfig,
  type CausorynServerConfig,
} from "./config.js";
import { PreflightManifestStore } from "./preflight-store.js";

/**
 * Uygulama bağlamı: konfigürasyon → WorkspaceAccessPolicy → GraphRepository
 * → IndexService → IndexJobManager (+ isteğe bağlı otomatik ilk indeksleme)
 * → OutputAccessPolicy (sprint-3 C6/C8: export çıktı yetkilendirmesi)
 * → Wiki veri kökü (sprint-4 W5: wiki.dataDbPath beyanı → SqliteWikiStore +
 * WikiSearchStore; TŞ §16A.8 "yalnızca izinli Causoryn data-root'a yazar").
 * MCP handler'ları yalnızca bu bağlamın uygulama servis arayüzlerini tüketir;
 * parser detayı bu pakete sızmaz (wiki/architecture.md sınır 3).
 *
 * IndexJobManager (sprint-2 B6): causoryn_refresh_index'in in-process async
 * snapshot işlerini yönetir (TŞ §10.2); başlangıç autoIndex'i KAPSAMAZ —
 * o, sunucu kullanılabilirlik koşulu olarak senkron koşmaya devam eder.
 *
 * OutputAccessPolicy (sprint-3 C6): config.output.allowedOutputDirs beyanı
 * boşsa NULL'dur (default deny) — causoryn_export_documentation o durumda
 * EXPORT_NOT_ALLOWED döner, hiçbir dizine yazmaz. Beyan varsa politika
 * başlangıçta kurulur; çözümlenemeyen/bulunmayan beyanlı dizin
 * OutputPolicyError ile sunucu başlangıcını düşürür (güven kaynağı
 * kurulamıyorsa sessiz devam yoktur — WorkspaceAccessPolicy ile aynı ilke).
 *
 * Wiki veri kökü (sprint-4 W5): config.wiki.dataDbPath beyanı YOKSA
 * wikiStore/wikiSearch NULL'dur (default deny) — causoryn_wiki_build
 * PATH_DENIED ile yazamaz, wiki okuma araçları INDEX_NOT_READY döner.
 * Beyan VARSA: mutlak yol + üst dizin mevcut + allowRoot köklerinin
 * DIŞINDA doğrulanır (kaynak ağacına yazım yasak, ADR-008/TŞ §16A.8);
 * ihlal CausorynConfigError ile sunucuyu düşürür. Wiki SQLite dosyasında
 * workspace kaydı yoksa tek workspace (config.workspaceId) kaydedilir —
 * SqliteWikiStore FK sözleşmesi workspace satırı ister. Arama, WikiSearchStore
 * (W4 çekirdeği) ile AYRI salt-okunur bir SQLite bağlantısı üzerinden yürür
 * (WAL: yazan bağlantı publish'i committed görür).
 *
 * Loglar her zaman enjekte edilen logger'a gider; stdio modunda bu
 * console.error'dur (stderr) — stdout YALNIZCA MCP protokolüdür (TŞ §10.1).
 */

export interface IndexWaitProgress {
  readonly jobId: string;
  readonly status: IndexJobStatus;
  readonly phase?: string;
  readonly progress: number;
  readonly total: number;
  readonly message: string;
}

export interface WaitForInitialIndexOptions {
  readonly timeoutMs?: number;
  readonly onProgress?: (update: IndexWaitProgress) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
}

export interface ActiveIndexJobInfo {
  readonly jobId: string;
  readonly status: "queued" | "running";
  readonly progressPercent: number;
  readonly phase: string;
}

export interface CausorynContext {
  readonly config: CausorynServerConfig;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  /**
   * Agent GPS FTS5 sembol arama yüzeyi (TŞ §9/§15). storage.dataDbPath
   * beyanlıysa (veya SymbolSearchStore destekleyen override verildiyse)
   * doludur; varsayılan bellek-içi depoda null'dur.
   */
  readonly symbolSearch: SymbolSearchStore | null;
  readonly indexService: IndexService;
  readonly jobManager: IndexJobManager;
  /**
   * Export çıktı yetkilendirmesi (sprint-3 C6). Beyanlı output dizini yoksa
   * null — export aracı EXPORT_NOT_ALLOWED döner (default deny).
   */
  readonly outputPolicy: OutputAccessPolicy | null;
  /**
   * Wiki projeksiyon deposu (sprint-4 W5; TŞ §16A.8). wiki.dataDbPath beyanı
   * yoksa null — wiki_build PATH_DENIED döner (default deny), wiki okuma
   * araçları INDEX_NOT_READY döner.
   */
  readonly wikiStore: SqliteWikiStore | null;
  /** Wiki FTS5 arama yüzeyi (sprint-4 W4 çekirdeği); wikiStore null ise null. */
  readonly wikiSearch: WikiSearchStore | null;
  /**
   * Sprint-6 Faz E: süreç-içi Preflight Manifest deposu. causoryn_preflight_
   * change manifesti buraya kaydeder; causoryn_verify_change preflightId'yi
   * buradan çözer (TŞ §1 ürün döngüsü Preflight → Verify). Bellek-içidir:
   * sunucu yeniden başlatınca kayıtlar düşer, bilinmeyen kimlik
   * INVALID_ARGUMENT ile reddedilir; kaynak ağaca/veri köküne yazma yoktur.
   */
  readonly preflightStore: PreflightManifestStore;
  /**
   * Saat kaynağı (domain deseni: motor saat okumaz, saat ENJEKTE edilir).
   * IndexService/jobManager ile aynı örnek; wiki_build builtAt buradan okur.
   */
  readonly clock: () => string;
  /** stderr'e yazan logger (stdio modunda console.error). */
  readonly logger: (message: string) => void;
  /**
   * Sahipliğindeki kaynakları kapatır (wiki SQLite bağlantıları). Testler
   * ve olası bir graceful-shutdown yoludur; stdio süreç çıkışında işletim
   * sistemi kalan tanıtıcıları serbest bırakır.
   */
  readonly close: () => void;
  /**
   * Starts deferred background indexing idempotently (invoked after MCP
   * `oninitialized` so `initialize` / `tools/list` never block). Cold start:
   * a full index job. Warm start (a published snapshot exists): tools keep
   * answering from that snapshot immediately (labelled stale while the check
   * runs) and a background incremental freshness check is queued in the
   * indexing worker so edited files are picked up without an explicit refresh.
   */
  readonly startDeferredIndex?: () => void;
  /**
   * Waits for cold-start background indexing up to `timeoutMs` while forwarding
   * optional progress updates; returns immediately on warm starts when a
   * published snapshot already exists.
   */
  readonly waitForInitialIndex?: (
    timeoutOrOptions?: number | WaitForInitialIndexOptions,
  ) => Promise<void>;
  /** Returns active queued/running indexing job info, or null if idle/terminal. */
  readonly getActiveIndexJob?: () => ActiveIndexJobInfo | null;
  /** Per-call fresh commit analysis budget of the history tools (ContextOverrides). */
  readonly historyMaxFreshAnalyses?: number;
}

export interface ContextOverrides {
  readonly repository?: GraphRepository;
  readonly clock?: () => string;
  readonly logger?: (message: string) => void;
  /**
   * v0.2.1: true iken kalıcı snapshot yoksa senkron `runIndex()` çağırmak
   * yerine `jobManager.refreshIndex(..., { mode: "full" })` ile non-blocking
   * arka plan tam indeks başlatır — MCP `initialize` el sıkışması asla
   * büyük repolar tarafından bloklanmaz.
   */
  readonly deferAutoIndex?: boolean;
  /** Optional MCP host client identifier recorded in SQLite build_leases.host_label. */
  readonly hostLabel?: string;
  /**
   * Fresh commit analyses one history tool call may run (non-negative
   * integer; 0 disables them, so commit points come only from the local
   * index, the history cache or the committed snapshot file). Takes
   * precedence over `CAUSORYN_HISTORY_MAX_ANALYSES` and the tool defaults.
   */
  readonly historyMaxFreshAnalyses?: number;
}

/**
 * Ham konfigürasyonu ayrıştırır, politikayı kurar, depoyu ve IndexService'i
 * hazırlar. `autoIndex` açık ve allowRoot doluysa ilk indeksleme koşusu
 * yapılır. Konfigürasyon geçersizse CausorynConfigError, indeksleme
 * reddiyse IndexingError fırlatır (çünkü tek workspace'in ilk indeksi
 * sunucunun kullanılabilirlik koşuludur).
 */
export function createCausorynContext(
  rawConfig: unknown,
  overrides: ContextOverrides = {},
): CausorynContext {
  const config = parseCausorynServerConfig(rawConfig);
  if (
    overrides.historyMaxFreshAnalyses !== undefined &&
    (!Number.isSafeInteger(overrides.historyMaxFreshAnalyses) || overrides.historyMaxFreshAnalyses < 0)
  ) {
    throw new CausorynConfigError([
      `historyMaxFreshAnalyses must be a non-negative integer: ${String(overrides.historyMaxFreshAnalyses)}`,
    ]);
  }
  const policy = WorkspaceAccessPolicy.create({
    allowRoots: [...config.allowRoots],
    ignore: [...config.ignore],
    extraIgnore: [...config.extraIgnore],
    binaryExtensions: [...config.binaryExtensions],
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: [...config.allowedExtensions],
    maxFileBytes: config.maxFileBytes,
  });
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const logger =
    overrides.logger ??
    ((message: string): void => {
      console.error(message);
    });
  const storage = openStorageRepository(config, overrides, clock, logger);
  let wiki: ReturnType<typeof openWikiStores> | undefined;
  try {
    const repository = storage.repository;
    const indexService = new IndexService({
      workspaceId: config.workspaceId,
      policy,
      repository,
      clock,
      limits: { maxFiles: config.index.maxFiles },
      tolerateConcurrentPublishRace: config.storage.dataDbPath !== undefined,
      ...(overrides.hostLabel === undefined ? {} : { hostLabel: overrides.hostLabel }),
    });
    // Sprint-2 B6: refresh_index işleri için yönetici; jobId per-manager
    // monoton sayaçtır (işletim kaydı — snapshot determinizmine girmez).
    const jobManager = new IndexJobManager({
      indexService,
      policy,
      clock,
    });

    // Sprint-3 C6/C8: export çıktı yetkilendirmesi — explicit beyanlı liste
    // (default [] → null politika = default deny, EXPORT_NOT_ALLOWED).
    const outputPolicy =
      config.output.allowedOutputDirs.length === 0
        ? null
        : OutputAccessPolicy.create([...config.output.allowedOutputDirs]);

    // Sprint-4 W5: wiki veri kökü — explicit beyan (default: null = default
    // deny, TŞ §16A.8 yazma sınırı).
    wiki = openWikiStores(config, clock, logger);

    let initialBootJobId: string | undefined;
    let deferredBootRoot: string | undefined;
    if (config.autoIndex && config.allowRoots.length > 0) {
      if (overrides.deferAutoIndex === true) {
        deferredBootRoot = config.allowRoots[0] as string;
      } else {
        const existing =
          overrides.repository === undefined && config.storage.dataDbPath !== undefined
            ? repository.getLatestPublished(config.workspaceId)
            : undefined;
        if (existing !== undefined) {
          logger(
            `persistent index loaded: workspace=${config.workspaceId} snapshot=${existing.snapshot.meta.id} state=${existing.snapshot.meta.state}`,
          );
        } else {
          const run = indexService.runIndex(config.allowRoots[0] as string);
          logger(
            `index ready: workspace=${config.workspaceId} snapshot=${run.snapshotId} files=${String(run.fileCount)} state=${run.state}`,
          );
        }
      }
    }

    const hasPublishedSnapshotFast = (): boolean => {
      const maybeMeta = (
        repository as unknown as {
          getLatestSnapshotMeta?: (wsId: string) => unknown;
        }
      ).getLatestSnapshotMeta;
      if (typeof maybeMeta === "function") {
        return maybeMeta.call(repository, config.workspaceId) !== undefined;
      }
      return repository.getLatestPublished(config.workspaceId) !== undefined;
    };

    const getActiveIndexJob = (): ActiveIndexJobInfo | null => {
      const jobs = jobManager.jobs();
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        const job = jobs[i];
        if (job !== undefined && (job.status === "running" || job.status === "queued")) {
          return {
            jobId: job.jobId,
            status: job.status,
            progressPercent: job.progressPercent,
            phase: job.progress?.phase ?? (job.status === "queued" ? "queued" : "indexing"),
          };
        }
      }
      return null;
    };

    const startDeferredIndex = (): void => {
      if (deferredBootRoot === undefined || initialBootJobId !== undefined) return;
      const rootToIndex = deferredBootRoot;
      deferredBootRoot = undefined;
      try {
        if (
          overrides.repository === undefined &&
          config.storage.dataDbPath !== undefined &&
          hasPublishedSnapshotFast()
        ) {
          // Warm start: never block; verify freshness in the background.
          const freshnessJob = jobManager.refreshIndex(rootToIndex, { mode: "incremental" });
          logger(
            `persistent index loaded: workspace=${config.workspaceId}; background freshness check started (jobId=${freshnessJob.jobId})`,
          );
          return;
        }
        const bootJob = jobManager.refreshIndex(rootToIndex, { mode: "full" });
        initialBootJobId = bootJob.jobId;
        logger(
          `background initial index started: workspace=${config.workspaceId} jobId=${bootJob.jobId}`,
        );
      } catch (error) {
        logger(
          `background initial index failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const waitForInitialIndex = async (
      timeoutOrOptions: number | WaitForInitialIndexOptions = 15_000,
    ): Promise<void> => {
      const opts: WaitForInitialIndexOptions =
        typeof timeoutOrOptions === "number"
          ? { timeoutMs: timeoutOrOptions }
          : timeoutOrOptions;
      // Warm start fast-path: if a published snapshot already exists, serve immediately.
      if (hasPublishedSnapshotFast()) {
        return;
      }
      startDeferredIndex();
      if (hasPublishedSnapshotFast()) {
        return;
      }
      const targetJobId = initialBootJobId ?? getActiveIndexJob()?.jobId;
      if (targetJobId === undefined) return;
      const initialRecord = jobManager.status(targetJobId);
      if (initialRecord === undefined || isTerminalIndexJobStatus(initialRecord.status)) {
        return;
      }
      if (opts.signal?.aborted) return;

      const rawTimeout = opts.timeoutMs;
      const boundedMs =
        rawTimeout !== undefined && Number.isFinite(rawTimeout) && rawTimeout >= 0
          ? rawTimeout
          : 15_000;

      const emitProgress = async (
        status: IndexJobStatus,
        progress: number,
        message: string,
        phase?: string,
      ): Promise<void> => {
        if (opts.onProgress === undefined) return;
        try {
          await opts.onProgress({
            jobId: targetJobId,
            status,
            ...(phase === undefined ? {} : { phase }),
            progress,
            total: 100,
            message,
          });
        } catch {
          // Ignore progress consumer failures.
        }
      };

      const formatPhaseMessage = (
        phase: string,
        detail: string | undefined,
        percent: number,
      ): string => {
        if (detail !== undefined && detail.length > 0) {
          return `[${phase}] ${detail}`;
        }
        return `[${phase}] Indexing workspace (${String(percent)}%)`;
      };

      let lastStatus: IndexJobStatus = initialRecord.status;
      let lastProgress: number = initialRecord.progressPercent;
      let lastPhase: string = initialRecord.progress?.phase ?? initialRecord.status;

      if (boundedMs === 0) {
        await emitProgress(
          lastStatus,
          lastProgress,
          formatPhaseMessage(lastPhase, initialRecord.progress?.message, lastProgress),
          lastPhase,
        );
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeProgress: (() => void) | undefined;
      let abortCleanup: (() => void) | undefined;
      let completed = false;
      const pendingProgress = new Set<Promise<void>>();
      const scheduleProgress = (promise: Promise<void>): void => {
        pendingProgress.add(promise);
        void promise.finally(() => {
          pendingProgress.delete(promise);
        });
      };

      try {
        if (
          opts.onProgress !== undefined &&
          typeof (jobManager as { subscribeProgress?: unknown }).subscribeProgress === "function"
        ) {
          unsubscribeProgress = jobManager.subscribeProgress(targetJobId, (event) => {
            const snap = jobManager.status(targetJobId);
            const status: IndexJobStatus =
              snap?.status ??
              (event.phase === "done"
                ? "done"
                : event.phase === "reused"
                  ? "reused"
                  : event.phase === "failed"
                    ? "failed"
                    : event.phase === "queued"
                      ? "queued"
                      : "running");
            const progress = snap?.progressPercent ?? lastProgress;
            lastStatus = status;
            lastProgress = progress;
            lastPhase = event.phase;
            scheduleProgress(
              emitProgress(
                status,
                progress,
                formatPhaseMessage(event.phase, event.message, progress),
                event.phase,
              ),
            );
          });
        }

        await emitProgress(
          lastStatus,
          lastProgress,
          formatPhaseMessage(lastPhase, initialRecord.progress?.message, lastProgress),
          lastPhase,
        );

        const racers: Promise<void>[] = [
          jobManager.waitForJob(targetJobId).then(
            () => {
              completed = true;
            },
            () => {
              completed = true;
            },
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, boundedMs);
            timer.unref();
          }),
        ];
        if (opts.signal !== undefined) {
          const signal = opts.signal;
          if (signal.aborted) {
            return;
          }
          racers.push(
            new Promise<void>((resolve) => {
              const onAbort = (): void => resolve();
              signal.addEventListener("abort", onAbort, { once: true });
              abortCleanup = () => signal.removeEventListener("abort", onAbort);
            }),
          );
        }
        await Promise.race(racers);
        if (pendingProgress.size > 0) {
          let flushTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all([...pendingProgress]),
              new Promise<void>((resolve) => {
                flushTimer = setTimeout(resolve, 50);
                flushTimer.unref();
              }),
            ]);
          } finally {
            if (flushTimer !== undefined) clearTimeout(flushTimer);
          }
        }
        if (completed) {
          const finalRecord = jobManager.status(targetJobId);
          const finalPhase = finalRecord?.progress?.phase ?? finalRecord?.status;
          if (
            finalRecord !== undefined &&
            (finalRecord.status !== lastStatus ||
              finalRecord.progressPercent !== lastProgress ||
              finalPhase !== lastPhase)
          ) {
            await emitProgress(
              finalRecord.status,
              finalRecord.progressPercent,
              finalRecord.status === "done"
                ? `[${finalPhase ?? "done"}] Workspace indexing complete`
                : finalRecord.status === "reused"
                  ? `[${finalPhase ?? "reused"}] Workspace index is current; no new snapshot was published`
                  : `[${finalPhase ?? finalRecord.status}] Workspace indexing ${finalRecord.status}`,
              finalPhase,
            );
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribeProgress?.();
        abortCleanup?.();
      }
    };

    const activeWiki = wiki;
    return {
      config,
      policy,
      repository,
      symbolSearch: storage.symbolSearch,
      indexService,
      jobManager,
      outputPolicy,
      wikiStore: activeWiki.store,
      wikiSearch: activeWiki.search,
      preflightStore: new PreflightManifestStore(),
      clock,
      logger,
      startDeferredIndex,
      waitForInitialIndex,
      getActiveIndexJob,
      ...(overrides.historyMaxFreshAnalyses === undefined
        ? {}
        : { historyMaxFreshAnalyses: overrides.historyMaxFreshAnalyses }),
      close: (): void => {
        try {
          (jobManager as { close?: () => void }).close?.();
        } catch (error) {
          logger(`could not close the index job manager: ${errorText(error)}`);
        } finally {
          try {
            activeWiki.close();
          } finally {
            storage.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      wiki?.close();
    } finally {
      storage.close();
    }
    throw error;
  }
}

/**
 * storage.dataDbPath ve wiki.dataDbPath için ORTAK fail-closed güvenlik
 * doğrulayıcısı (TŞ §9/§16A.8/§20 + ADR-008):
 * - mutlak yol olmalı,
 * - null byte içeremez,
 * - allowRoots boş olamaz,
 * - sözcüksel olarak tüm allowRoots dışında olmalı,
 * - üst dizin diskte mevcut bir dizin olmalı,
 * - üst dizinin (ve dosya mevcutsa dosyanın kendisinin) realpath'i TÜM
 *   allowRoots realpath'lerinin kesinlikle dışında olmalı.
 */
function validateDataDbPath(
  fieldName: "storage.dataDbPath" | "wiki.dataDbPath",
  declared: string,
  allowRoots: readonly string[],
): string {
  // UNC / Win32 device declarations are rejected before any filesystem call
  // (resolving them on Windows would open an outbound SMB session).
  if (isUncOrDevicePath(declared)) {
    throw new CausorynConfigError([
      `${fieldName} must not be a UNC or Win32 device path (rejected before filesystem access): ${declared}`,
    ]);
  }
  const issues: string[] = [];
  if (!path.isAbsolute(declared)) {
    issues.push(`${fieldName} must be an absolute path: ${declared}`);
  }
  if (declared.includes("\0")) {
    issues.push(`${fieldName} must not contain a NUL byte`);
  }
  if (process.platform === "win32") {
    const finding = findWindowsUnsafePathSegment(declared);
    if (finding !== undefined) {
      issues.push(`${fieldName} is not usable: ${describeWindowsPathSegmentIssue(finding)}`);
    }
  }
  const declaredResolved = path.resolve(declared);
  const stripWin32DevicePrefix = (value: string): string => {
    if (process.platform !== "win32") return value;
    if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
    if (value.startsWith("\\\\?\\")) return value.slice(4);
    return value;
  };
  const normalizeComparable = (value: string): string => {
    const stripped = stripWin32DevicePrefix(value);
    return process.platform === "win32" ? stripped.toLowerCase() : stripped;
  };
  const isSameOrInside = (targetComparable: string, rootComparable: string): boolean => {
    if (targetComparable === rootComparable) return true;
    const boundary = rootComparable.endsWith(path.sep)
      ? rootComparable
      : rootComparable + path.sep;
    return targetComparable.startsWith(boundary);
  };
  const declaredComparable = normalizeComparable(declaredResolved);
  for (const root of allowRoots) {
    const rootComparable = normalizeComparable(path.resolve(root));
    if (isSameOrInside(declaredComparable, rootComparable)) {
      issues.push(
        `${fieldName} must not be inside an authorized workspace root (writing to source files is forbidden): ${declared}`,
      );
      break;
    }
  }
  if (issues.length > 0) {
    throw new CausorynConfigError(issues);
  }
  if (allowRoots.length === 0) {
    throw new CausorynConfigError([
      `${fieldName} is declared but no workspace root is authorized (allowRoots is empty): ${declared}`,
    ]);
  }
  const parentDir = path.dirname(declaredResolved);
  const sqliteArtifacts = [
    declaredResolved,
    `${declaredResolved}-wal`,
    `${declaredResolved}-shm`,
    `${declaredResolved}-journal`,
  ];
  // Links on the way to the database (or a side file that is itself a link) whose
  // target is a UNC/device path are rejected from lstat/readlink alone, before the
  // stat/realpath calls below follow them.
  if (LINK_TARGET_INSPECTION_ENABLED) {
    for (const artifactPath of sqliteArtifacts) {
      const inspection = inspectLinkTargets(artifactPath);
      if (!inspection.ok) {
        throw new CausorynConfigError([
          `${fieldName} is not usable: ${describeLinkInspectionFailure(inspection)}`,
        ]);
      }
    }
  }
  let parentStat: Stats;
  try {
    parentStat = statSync(parentDir);
  } catch {
    throw new CausorynConfigError([
      `${fieldName} parent directory does not exist: ${parentDir} (declared directories must already exist on disk)`,
    ]);
  }
  if (!parentStat.isDirectory()) {
    throw new CausorynConfigError([
      `${fieldName} parent path is not a directory: ${parentDir}`,
    ]);
  }

  const realTargets: string[] = [];
  try {
    realTargets.push(realpathSync(parentDir));
  } catch (error) {
    throw new CausorynConfigError([
      `${fieldName} parent directory real path could not be resolved (refusing to continue): ${parentDir} — ${errorText(error)}`,
    ]);
  }
  // CWE-59 savunması: SQLite ana dosyası ve WAL/SHM/journal yan dosyaları için
  // lstatSync + fail-closed realpathSync denetimi (sarkan symlink ve dizin reddi).
  for (const artifactPath of sqliteArtifacts) {
    let artifactLstat: Stats | undefined;
    try {
      artifactLstat = lstatSync(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw new CausorynConfigError([
          `${fieldName} target/side file status could not be verified: ${artifactPath} — ${errorText(error)}`,
        ]);
      }
    }
    if (artifactLstat !== undefined) {
      if (artifactLstat.isDirectory()) {
        throw new CausorynConfigError([
          `${fieldName} target/side path must not be a directory: ${artifactPath}`,
        ]);
      }
      try {
        const realArtifact = realpathSync(artifactPath);
        realTargets.push(realArtifact);
        realTargets.push(realpathSync(path.dirname(realArtifact)));
      } catch (error) {
        throw new CausorynConfigError([
          `${fieldName} real path could not be resolved (dangling/broken symlink rejected): ${artifactPath} — ${errorText(error)}`,
        ]);
      }
    }
  }
  for (const root of allowRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(path.resolve(root));
    } catch (error) {
      throw new CausorynConfigError([
        `${fieldName} could not be verified: the allowRoot real path could not be resolved (refusing to continue): ${root} — ${errorText(error)}`,
      ]);
    }
    const realRootComparable = normalizeComparable(realRoot);
    for (const realTarget of realTargets) {
      const realTargetComparable = normalizeComparable(realTarget);
      if (isSameOrInside(realTargetComparable, realRootComparable)) {
        throw new CausorynConfigError([
          `${fieldName} real path is inside a workspace root (symlink escape rejected): ${declared}`,
        ]);
      }
    }
  }
  return declaredResolved;
}

function extractSymbolSearch(repository: GraphRepository): SymbolSearchStore | null {
  if (
    "searchSymbols" in repository &&
    typeof (repository as { searchSymbols?: unknown }).searchSymbols === "function"
  ) {
    return repository as unknown as SymbolSearchStore;
  }
  return null;
}

function stripWin32DevicePrefix(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

/**
 * Whether `root` may be resolved on disk. A recorded root is read back from a
 * database, so it gets the same pre-filesystem checks as a declared allowRoot:
 * resolving a UNC/device path, or a link whose target is one, would open an
 * outbound SMB session on Windows.
 */
function isResolvableRoot(root: string): boolean {
  if (!path.isAbsolute(root) || root.includes("\0") || isUncOrDevicePath(root)) return false;
  if (process.platform === "win32" && findWindowsUnsafePathSegment(root) !== undefined) return false;
  return !LINK_TARGET_INSPECTION_ENABLED || inspectLinkTargets(root).ok;
}

/**
 * Canonical form of a workspace root (CAU-03): the real path when it resolves
 * (native realpath first, so Windows 8.3 short names and letter case resolve to
 * the on-disk name), otherwise the lexically resolved path. A root that is not
 * absolute stays as given, so it never equals an authorized root.
 */
function canonicalWorkspaceRoot(root: string): string {
  if (!path.isAbsolute(root)) return root;
  const resolved = path.resolve(root);
  if (isResolvableRoot(root)) {
    const resolvers: ReadonlyArray<(target: string) => string> = [
      (target) => realpathSync.native(target),
      (target) => realpathSync(target),
    ];
    for (const resolve of resolvers) {
      try {
        return stripWin32DevicePrefix(resolve(resolved));
      } catch {
        // Missing root, or a native call the platform does not support: try the next form.
      }
    }
  }
  return stripWin32DevicePrefix(resolved);
}

/** Comparison key of an already canonical root: no trailing separator, case-folded on win32. */
function comparisonKey(canonical: string): string {
  const fsRoot = path.parse(canonical).root;
  const trimmed =
    canonical.length > fsRoot.length && canonical.endsWith(path.sep)
      ? canonical.slice(0, -1)
      : canonical;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Comparison key of a root: canonical form, no trailing separator, case-folded on win32. */
function comparableWorkspaceRoot(root: string): string {
  return comparisonKey(canonicalWorkspaceRoot(root));
}

/**
 * CAU-03 (CWE-863): binds the persisted workspace record to the authorized
 * primary root. Data in a graph/wiki database is keyed by workspace id only, so
 * a database recorded for another root under the same id would otherwise be
 * served once tool authorization passes for the new root. A new record stores
 * the canonical root; an existing record (including a 0.3.2 record, which holds
 * `allowRoots[0]` verbatim) must name the same directory canonically, or the
 * database is refused before any of its rows are read. The refusal does not
 * repeat the recorded root, and the database is left unchanged.
 *
 * A matching record that does not hold the canonical root yet (a 0.3.2
 * verbatim spelling: trailing separator, letter case, a link) is rewritten to
 * the canonical root it matched. Kept verbatim, a link spelling would be
 * re-resolved on every open and follow the link to whatever directory it
 * names later, so the old data would be served for that directory.
 */
function bindWorkspaceRecord(
  repository: SqliteGraphRepository,
  fieldName: "storage.dataDbPath" | "wiki.dataDbPath",
  workspaceId: string,
  declaredRoot: string,
  clock: () => string,
): void {
  // Resolved once: the root that is compared is the root that is recorded.
  const canonicalRoot = canonicalWorkspaceRoot(declaredRoot);
  const declaredKey = comparisonKey(canonicalRoot);
  const mismatch = (): CausorynConfigError =>
    new CausorynConfigError([
      `${fieldName} holds workspace "${workspaceId}" recorded for a different root than allowRoots[0]; refusing to open it so data indexed for another directory is not served. Use a separate ${fieldName} for this root, or a different workspaceId.`,
    ]);
  let existing = repository.getWorkspace(workspaceId);
  if (existing === undefined) {
    try {
      repository.registerWorkspace({
        id: workspaceId,
        rootPath: canonicalRoot,
        createdAt: clock(),
      });
      return;
    } catch (error) {
      if (!(error instanceof GraphRepositoryError && error.code === "graph/duplicate-workspace")) {
        throw error;
      }
      // Another process registered the id between the read and the insert:
      // check the root it recorded like any existing record.
      existing = repository.getWorkspace(workspaceId);
      if (existing === undefined) throw error;
    }
  }
  if (comparableWorkspaceRoot(existing.rootPath) !== declaredKey) throw mismatch();
  if (existing.rootPath === canonicalRoot) return;
  if (repository.updateWorkspaceRootPath(workspaceId, existing.rootPath, canonicalRoot)) return;
  // The row changed between the read and the update (another process): check
  // the root it holds now like any existing record.
  const current = repository.getWorkspace(workspaceId);
  if (current === undefined || comparableWorkspaceRoot(current.rootPath) !== declaredKey) throw mismatch();
}

function openStorageRepository(
  config: CausorynServerConfig,
  overrides: ContextOverrides,
  clock: () => string,
  logger: (message: string) => void,
): {
  readonly repository: GraphRepository;
  readonly symbolSearch: SymbolSearchStore | null;
  readonly close: () => void;
} {
  if (overrides.repository !== undefined) {
    return {
      repository: overrides.repository,
      symbolSearch: extractSymbolSearch(overrides.repository),
      close: (): void => {},
    };
  }
  const declared = config.storage.dataDbPath;
  if (declared === undefined) {
    return {
      repository: new InMemoryGraphRepository(),
      symbolSearch: null,
      close: (): void => {},
    };
  }
  const resolvedStoragePath = validateDataDbPath(
    "storage.dataDbPath",
    declared,
    config.allowRoots,
  );
  let sqliteRepo: SqliteGraphRepository;
  try {
    sqliteRepo = new SqliteGraphRepository(resolvedStoragePath);
  } catch (error) {
    throw new CausorynConfigError([
      `storage.dataDbPath could not be opened: ${errorText(error)}`,
    ]);
  }
  const declaredRoot = config.allowRoots[0];
  if (declaredRoot !== undefined) {
    try {
      bindWorkspaceRecord(sqliteRepo, "storage.dataDbPath", config.workspaceId, declaredRoot, clock);
    } catch (error) {
      sqliteRepo.close();
      if (error instanceof CausorynConfigError) throw error;
      throw new CausorynConfigError([
        `storage.dataDbPath workspace record could not be written: ${errorText(error)}`,
      ]);
    }
  }
  logger(`storage data root ready: ${resolvedStoragePath}`);
  return {
    repository: sqliteRepo,
    symbolSearch: sqliteRepo,
    close: (): void => {
      try {
        sqliteRepo.close();
      } catch (error) {
        logger(`could not close the storage data root: ${errorText(error)}`);
      }
    },
  };
}

/**
 * wiki.dataDbPath beyanını doğrular ve (beyan varsa) SqliteWikiStore +
 * WikiSearchStore'u açar. Tamamen SENKRONDUR (context kuruluşu senkron
 * sözleşmedir). Doğrulama disiplini OutputAccessPolicy ile aynıdır: güven
 * kaynağı kurulamıyorsa sunucu başlamaz (sessiz devam yoktur).
 */
function openWikiStores(
  config: CausorynServerConfig,
  clock: () => string,
  logger: (message: string) => void,
): {
  readonly store: SqliteWikiStore | null;
  readonly search: WikiSearchStore | null;
  readonly close: () => void;
} {
  const declared = config.wiki.dataDbPath;
  if (declared === undefined) {
    return { store: null, search: null, close: (): void => {} };
  }
  const declaredResolved = validateDataDbPath(
    "wiki.dataDbPath",
    declared,
    config.allowRoots,
  );

  let store: SqliteWikiStore;
  try {
    store = new SqliteWikiStore(declaredResolved);
  } catch (error) {
    const detail =
      error instanceof WikiStoreError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CausorynConfigError([`wiki.dataDbPath could not be opened: ${detail}`]);
  }

  // SqliteWikiStore FK sözleşmesi workspace satırı ister; tek workspace
  // modeli gereği config.workspaceId kaydı yoksa açılışta yazılır. Kayıt
  // varsa kanonik kökü yetkili köke eşit olmalıdır (CAU-03).
  const declaredRoot = config.allowRoots[0];
  if (declaredRoot !== undefined) {
    let graphStore: SqliteGraphRepository | undefined;
    try {
      graphStore = new SqliteGraphRepository(declaredResolved);
      bindWorkspaceRecord(graphStore, "wiki.dataDbPath", config.workspaceId, declaredRoot, clock);
    } catch (error) {
      store.close();
      if (error instanceof CausorynConfigError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new CausorynConfigError([
        `wiki.dataDbPath workspace record could not be written: ${detail}`,
      ]);
    } finally {
      graphStore?.close();
    }
  }

  // Arama salt-okunur ikinci bağlantı (WAL): yazan SqliteWikiStore
  // publish'ini committed düzeyde görür.
  let search: WikiSearchStore;
  let readDb: Database.Database;
  try {
    readDb = new Database(declaredResolved, { readonly: true });
    try {
      // Same connection hardening as the writing stores (trusted_schema = OFF).
      hardenSqliteConnection(readDb);
      search = new WikiSearchStore(readDb);
    } catch (error) {
      readDb.close();
      throw error;
    }
  } catch (error) {
    store.close();
    const detail = error instanceof Error ? error.message : String(error);
    throw new CausorynConfigError([`wiki search connection could not be opened: ${detail}`]);
  }
  logger(`wiki data root ready: ${declaredResolved}`);
  return {
    store,
    search,
    close: (): void => {
      try {
        readDb.close();
      } catch (error) {
        logger(`could not close the wiki search connection: ${errorText(error)}`);
      }
      try {
        store.close();
      } catch (error) {
        logger(`could not close the wiki data root: ${errorText(error)}`);
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
