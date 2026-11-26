import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalJson, sha256Hex, utf8Encode, type JsonValue } from "@causoryn/domain";
import {
  assertValidBlobPath,
  describeManifestShapeError,
  GraphRepositoryError,
  readGitBlob,
  readGitTree,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  type CompareContentSet,
} from "@causoryn/graph";
import {
  ANALYZER_FINGERPRINT_SCHEMA_VERSION,
  INDEXING_VERSION,
  IndexingError,
  InventoryAnalysisWorkerError,
  runInventoryAnalysisInWorker,
  type InventoryEntry,
} from "@causoryn/indexing";

import {
  compileIgnoreRuleSet,
  effectiveIgnorePatterns,
  IGNORE_MATCH_WORK_BUDGET,
  isUncOrDevicePath,
  type WorkspacePolicyConfig,
} from "@causoryn/workspace";

import type { ServiceDeps } from "./services.js";
import { SERVER_VERSION } from "./version.js";

/**
 * Symbol-level analysis of a git commit from its objects, for the history
 * tools (`causoryn_compare_architecture`, `causoryn_architecture_timeline`).
 *
 * The commit tree is listed and its blobs are read with the hardened
 * read-only helpers of `@causoryn/graph` (`readGitTree` / `readGitBlob`): no
 * checkout, nothing is materialized on disk. Only the paths the workspace
 * policy would put into the inventory are read (same ignore, extension and
 * size rules; symlinks, submodules and the committed architecture snapshot
 * are never read). The files are analyzed by a scratch `IndexService` over an
 * `InMemoryGraphRepository` with the same policy and limits as the real index,
 * so a commit point has the same granularity as an index point. The scratch
 * index runs off the MCP thread, in the index worker's inventory analysis
 * mode (`runInventoryAnalysisInWorker`, the same worker entry and bundle as
 * background index jobs; an idle worker is reused for the next analysis), so
 * its synchronous analyzer phases never block other tool calls and its
 * memory lives in the worker's capped heap.
 *
 * Known approximation: source files come from the commit, while project and
 * build inputs outside the inventory (C# `.csproj` / `Directory.Build.props`
 * read by the project model, installed `node_modules` / NuGet packages) and
 * the workspace rules themselves come from the current working tree and
 * configuration.
 *
 * Resource budgets (the analysis runs inside the MCP server process): besides
 * the per-file (`maxFileBytes`) and file-count (`index.maxFiles`) limits, one
 * analysis accepts at most `maxCommitBytes` of source text and one tool call
 * at most `maxRequestBytes` across its fresh analyses; the analysis worker's
 * V8 heap is capped by historyAnalysisWorkerHeapMb(`maxCommitBytes`); an
 * analysis stops at its wall-clock deadline (`maxAnalysisMs`, bounded by the
 * call's `maxRequestMs`), checked between tree entries and blob reads (each
 * git process also gets the time left as its timeout), at each progress
 * message of the worker, and by a timer that stops the worker together with
 * its sidecar processes (runInventoryAnalysisInWorker); and at
 * most `maxConcurrentAnalyses` fresh analyses run in the process at a time (a
 * call waits at most `busyWaitMs` for a slot). A limit that is hit, or a
 * worker that runs out of memory, crashes or exits, raises
 * HistoryBudgetError, whose code becomes the point's unanalyzed reason (see
 * trusted-history.ts); the slot is released once the worker has exited.
 * Defaults (DEFAULT_HISTORY_RESOURCE_LIMITS) and the `CAUSORYN_HISTORY_*`
 * overrides: resolveHistoryResourceLimits.
 *
 * Cache: with a data root (`storage.dataDbPath`), a result is stored at
 * `<dir of dataDbPath>/history/<commitSha>-<cacheKey>.json`, written through a
 * unique temporary file (flag "wx", owner-only mode) and a rename, never
 * inside an authorized workspace root. The key covers the Causoryn and
 * indexing versions, the analyzer fingerprint schema, the policy
 * configuration and the analyzed workspace (id and canonical root), so
 * analyzer or rule changes start a new entry. An analysis that ran without an
 * available language worker records that worker; its entry is analyzed again
 * once the latest published index ran the worker (the toolchain is available
 * now). A corrupt entry is removed and the commit is analyzed again.
 *
 * Cache trust (a manually chosen data root may be shared): the cache
 * directory is used only when it is a real directory (not a symlink or
 * junction) directly inside the data directory and, on POSIX, owned by the
 * server's uid and not writable by group or others; an entry is read only
 * when it is a regular file with the same owner and mode rules, checked on
 * the path and again on the opened descriptor (same file, so a later swap is
 * not read), and is used only when its recorded source identity (workspace id
 * and canonical root) matches. Anything else is ignored with a log line,
 * never served. The device and inode the directory check saw are checked
 * again (lstat: not a link, same identity) right before each temporary file
 * create, rename and unlink; a directory that changed in between is not
 * written to or removed from. Windows has no uid and Node cannot read a DACL
 * without native code, so there the cache directory is trusted only when its
 * real path lies inside the user's profile or %LOCALAPPDATA% (private to the
 * user by default) and its path has no link or junction below them; a data
 * root anywhere else gets fresh analyses, never a cache (windowsTrustProblem).
 *
 * Retention: after a store, entries beyond `maxEntries` or `maxTotalBytes`
 * (all entries of the directory, whatever their key) are evicted oldest
 * modification time first, ties by file name; temporary files of writes that
 * never finished (older than an hour) are removed.
 */

/** Environment override of the fresh analyses one history tool call may run. */
export const HISTORY_ANALYSIS_BUDGET_ENV = "CAUSORYN_HISTORY_MAX_ANALYSES";
/** Source text (UTF-8 bytes) one fresh commit analysis may accept. */
export const HISTORY_MAX_COMMIT_BYTES_ENV = "CAUSORYN_HISTORY_MAX_COMMIT_BYTES";
/** Source text (UTF-8 bytes) the fresh analyses of one tool call may accept together. */
export const HISTORY_MAX_REQUEST_BYTES_ENV = "CAUSORYN_HISTORY_MAX_REQUEST_BYTES";
/** Wall-clock milliseconds one fresh commit analysis may take. */
export const HISTORY_MAX_ANALYSIS_MS_ENV = "CAUSORYN_HISTORY_MAX_ANALYSIS_MS";
/** Wall-clock milliseconds the fresh analyses of one tool call may take together. */
export const HISTORY_MAX_REQUEST_MS_ENV = "CAUSORYN_HISTORY_MAX_REQUEST_MS";
/** Fresh commit analyses that may run at the same time in this server process. */
export const HISTORY_MAX_CONCURRENT_ENV = "CAUSORYN_HISTORY_MAX_CONCURRENT";
/** Milliseconds a call waits for a free analysis slot (0: do not wait). */
export const HISTORY_BUSY_WAIT_MS_ENV = "CAUSORYN_HISTORY_BUSY_WAIT_MS";
/** Total bytes of the history cache directory's entries. */
export const HISTORY_CACHE_MAX_BYTES_ENV = "CAUSORYN_HISTORY_CACHE_MAX_BYTES";
/** Entries kept in the history cache directory. */
export const HISTORY_CACHE_MAX_ENTRIES_ENV = "CAUSORYN_HISTORY_CACHE_MAX_ENTRIES";
/** Default fresh analyses per `causoryn_compare_architecture` call (one per side). */
export const DEFAULT_COMPARE_FRESH_ANALYSES = 2;
/** Default fresh analyses per `causoryn_architecture_timeline` call. */
export const DEFAULT_TIMELINE_FRESH_ANALYSES = 4;

/** Note attached to every point analyzed from git objects (the documented approximation). */
export const COMMIT_ANALYSIS_NOTE =
  "was analyzed from its git objects (source files from the commit; project files and installed packages from the working tree)";
export const HISTORY_CACHE_NOTE = "served from the history cache";

/** Resource limits of the fresh commit analyses (see the module comment). */
export interface HistoryResourceLimits {
  /** Source text (UTF-8 bytes) one analysis may accept. */
  readonly maxCommitBytes: number;
  /** Source text (UTF-8 bytes) the fresh analyses of one call may accept together. */
  readonly maxRequestBytes: number;
  /** Wall-clock milliseconds of one analysis. */
  readonly maxAnalysisMs: number;
  /** Wall-clock milliseconds of all fresh analyses of one call, waiting for a slot included. */
  readonly maxRequestMs: number;
  /** Fresh analyses running at the same time in this process. */
  readonly maxConcurrentAnalyses: number;
  /** Milliseconds a call waits for a free analysis slot (0: no waiting). */
  readonly busyWaitMs: number;
}

/**
 * Defaults. The byte budgets bound the memory of a fresh analysis: the
 * accepted source text is held on the main thread (as strings) and copied
 * once into the analysis worker, whose heap limit grows with the per-commit
 * budget (historyAnalysisWorkerHeapMb: 1024 MiB for 32 MiB). 32 MiB of
 * analyzable source text is already a very large commit (about a million
 * lines); 64 MiB per call covers both sides of a compare. Larger
 * repositories raise them with `CAUSORYN_HISTORY_MAX_COMMIT_BYTES` /
 * `CAUSORYN_HISTORY_MAX_REQUEST_BYTES`.
 */
export const DEFAULT_HISTORY_RESOURCE_LIMITS: HistoryResourceLimits = Object.freeze({
  maxCommitBytes: 32 * 1024 * 1024,
  maxRequestBytes: 64 * 1024 * 1024,
  maxAnalysisMs: 120_000,
  maxRequestMs: 300_000,
  maxConcurrentAnalyses: 1,
  busyWaitMs: 30_000,
});

/** Total retention of the history cache directory. */
export interface HistoryCacheQuota {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_HISTORY_CACHE_QUOTA: HistoryCacheQuota = Object.freeze({
  maxEntries: 256,
  maxTotalBytes: 1024 * 1024 * 1024,
});

const HISTORY_CACHE_FORMAT = "causoryn-history-commit-analysis";
/** 2: entries carry `sourceIdentity`; the key covers the workspace root. */
const HISTORY_CACHE_FORMAT_VERSION = 2;
const HISTORY_DIR_NAME = "history";
/** Upper bound for one cache entry (read and write). */
const MAX_HISTORY_CACHE_ENTRY_BYTES = 256 * 1024 * 1024;
const HISTORY_ENTRY_FILE_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}\.json$/;
/** Temporary file of a store (`.<entry>.<pid>.<random>.tmp`). */
const HISTORY_TEMPORARY_FILE_PATTERN = /^\.(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/;
/** A temporary file older than this was left by a write that never finished. */
const ORPHANED_TEMPORARY_FILE_AGE_MS = 60 * 60 * 1000;
/** Read-only open that refuses a final symlink and never blocks on a FIFO (POSIX flags). */
const ENTRY_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const ENTRY_READ_CHUNK_BYTES = 64 * 1024;
const BLOB_READ_CONCURRENCY = 6;
/** The synchronous policy checks yield to the event loop after this many tree entries. */
const POLICY_YIELD_EVERY = 64;
/** Timeout of one git process when the deadline is further away (the git helpers' default). */
const GIT_PROCESS_TIMEOUT_MS = 15_000;
/** Calls that may wait for an analysis slot at the same time; more are busy at once. */
const MAX_WAITING_ANALYSES = 16;
/** setTimeout's largest delay. */
const MAX_TIMER_MS = 2_147_483_647;
/** Permission bits for group and others write. */
const GROUP_OR_OTHER_WRITE = 0o022;
const SYMLINK_MODE = "120000";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** Result of one commit analysis (fresh or from the cache). */
export interface CommitContentAnalysis {
  readonly contentSet: CompareContentSet;
  readonly state: "ready" | "partial";
  /** Files of the commit that were analyzed. */
  readonly fileCount: number;
  /**
   * Files the ignore/extension rules allow that were not analyzed: above
   * maxFileBytes, an unusable git path, or refused by the working-tree part of
   * the policy (a link on the path, a Windows name alias).
   */
  readonly skippedFiles: number;
  /**
   * Languages whose sidecar worker could not run ("C#", "Python", "Go",
   * "Rust"): their files were analyzed at a lower level, so the result
   * depends on this machine's toolchain.
   */
  readonly degradedWorkers: readonly string[];
}

/** analyzerFingerprint key that records a sidecar worker's run state → language. */
const WORKER_STATE_KEYS: ReadonlyMap<string, string> = new Map([
  ["refsrc", "C#"],
  ["pystate", "Python"],
  ["gostate", "Go"],
  ["ruststate", "Rust"],
]);
const DEGRADED_WORKER_STATES: ReadonlySet<string> = new Set(["worker-unavailable", "sync-run-degraded"]);
const WORKER_LANGUAGES: ReadonlySet<string> = new Set(WORKER_STATE_KEYS.values());

/** Language → whether its worker ran, for every worker the fingerprint records. */
function workerStatesOf(analyzerFingerprint: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const segment of analyzerFingerprint.split("|")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const language = WORKER_STATE_KEYS.get(segment.slice(0, separator));
    if (language === undefined) continue;
    states.set(language, !DEGRADED_WORKER_STATES.has(segment.slice(separator + 1)));
  }
  return states;
}

function degradedWorkersOf(analyzerFingerprint: string): string[] {
  return [...workerStatesOf(analyzerFingerprint)]
    .filter(([, ran]) => !ran)
    .map(([language]) => language)
    .sort();
}

/** A failure that is reported as the point's reason as is (no internal detail). */
export class CommitAnalysisLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitAnalysisLimitError";
  }
}

/**
 * Fresh analyses one call may run: the context override (test seam; 0
 * disables fresh analysis), then `CAUSORYN_HISTORY_MAX_ANALYSES` (positive
 * integer; an invalid value is logged and ignored), then the tool default.
 */
export function resolveHistoryAnalysisBudget(
  deps: Pick<ServiceDeps, "historyMaxFreshAnalyses" | "logger">,
  toolDefault: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (deps.historyMaxFreshAnalyses !== undefined) return deps.historyMaxFreshAnalyses;
  return readIntegerEnv(env, HISTORY_ANALYSIS_BUDGET_ENV, toolDefault, "positive", deps.logger);
}

/**
 * An integer setting from the environment; unset or empty keeps `fallback`,
 * an invalid value is logged and ignored (the same handling for every
 * `CAUSORYN_HISTORY_*` setting).
 */
function readIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  kind: "positive" | "non-negative",
  logger: (message: string) => void,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const pattern = kind === "positive" ? POSITIVE_INTEGER_PATTERN : NON_NEGATIVE_INTEGER_PATTERN;
  const parsed = pattern.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    logger(`history: ${name} must be a ${kind} integer; ignoring ${JSON.stringify(raw)} and using ${String(fallback)}`);
    return fallback;
  }
  return parsed;
}

/** Resource limits from the `CAUSORYN_HISTORY_*` settings over the defaults. */
export function resolveHistoryResourceLimits(
  logger: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): HistoryResourceLimits {
  const defaults = DEFAULT_HISTORY_RESOURCE_LIMITS;
  const positive = (name: string, fallback: number): number =>
    readIntegerEnv(env, name, fallback, "positive", logger);
  return {
    maxCommitBytes: positive(HISTORY_MAX_COMMIT_BYTES_ENV, defaults.maxCommitBytes),
    maxRequestBytes: positive(HISTORY_MAX_REQUEST_BYTES_ENV, defaults.maxRequestBytes),
    maxAnalysisMs: positive(HISTORY_MAX_ANALYSIS_MS_ENV, defaults.maxAnalysisMs),
    maxRequestMs: positive(HISTORY_MAX_REQUEST_MS_ENV, defaults.maxRequestMs),
    maxConcurrentAnalyses: positive(HISTORY_MAX_CONCURRENT_ENV, defaults.maxConcurrentAnalyses),
    busyWaitMs: readIntegerEnv(env, HISTORY_BUSY_WAIT_MS_ENV, defaults.busyWaitMs, "non-negative", logger),
  };
}

/** History cache retention from the `CAUSORYN_HISTORY_CACHE_*` settings over the defaults. */
export function resolveHistoryCacheQuota(
  logger: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): HistoryCacheQuota {
  return {
    maxEntries: readIntegerEnv(
      env,
      HISTORY_CACHE_MAX_ENTRIES_ENV,
      DEFAULT_HISTORY_CACHE_QUOTA.maxEntries,
      "positive",
      logger,
    ),
    maxTotalBytes: readIntegerEnv(
      env,
      HISTORY_CACHE_MAX_BYTES_ENV,
      DEFAULT_HISTORY_CACHE_QUOTA.maxTotalBytes,
      "positive",
      logger,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Budgets of the fresh analyses                                       */
/* ------------------------------------------------------------------ */

/**
 * Reason codes of a point that a resource limit (or the analysis worker)
 * kept from being analyzed.
 */
export type HistoryLimitCode =
  | "commit-byte-budget-exceeded"
  | "request-byte-budget-exceeded"
  | "analysis-deadline-exceeded"
  | "request-deadline-exceeded"
  | "analysis-busy"
  /** The analysis worker reached its heap limit (historyAnalysisWorkerHeapMb). */
  | "analysis-memory-exceeded"
  /** The analysis worker could not start, crashed or exited without a result. */
  | "analysis-worker-failed";

/** Heap of the analysis worker without any source text (the analyzers and their libraries). */
const WORKER_BASE_HEAP_MB = 256;
/** Additional worker heap per MiB of the per-commit source text budget. */
const WORKER_HEAP_MB_PER_SOURCE_MIB = 24;
/**
 * Hard ceiling of the analysis worker heap (MiB), whatever the per-commit
 * budget: 8 GiB is far above what the default budget needs (1024 MiB) and
 * keeps a mistyped CAUSORYN_HISTORY_MAX_COMMIT_BYTES from asking V8 for an
 * absurd heap.
 */
export const HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB = 8192;
/**
 * Share of the machine's memory (`os.totalmem()`) the analysis worker heap
 * may take at most: the rest is left for the MCP server's main thread (which
 * holds the accepted source text too) and the rest of the machine.
 */
const WORKER_MAX_HEAP_SHARE_OF_TOTAL_MEMORY = 0.5;
const MIB = 1024 * 1024;

/**
 * V8 old-generation heap limit (MiB) of the analysis worker for a per-commit
 * budget of `maxCommitBytes`: 256 MiB plus 24 MiB per started MiB of source
 * text (1024 MiB for the default 32 MiB), at most half of the machine's
 * memory (`totalMemoryBytes`, default `os.totalmem()`) and at most
 * HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB, but never below the 256 MiB base. A
 * worker above it is stopped by V8 and the point becomes
 * `analysis-memory-exceeded`.
 */
export function historyAnalysisWorkerHeapMb(
  maxCommitBytes: number,
  totalMemoryBytes: number = os.totalmem(),
): number {
  const fromBudget =
    WORKER_BASE_HEAP_MB + WORKER_HEAP_MB_PER_SOURCE_MIB * Math.max(1, Math.ceil(maxCommitBytes / MIB));
  const machineShare = Math.floor((totalMemoryBytes / MIB) * WORKER_MAX_HEAP_SHARE_OF_TOTAL_MEMORY);
  return Math.max(WORKER_BASE_HEAP_MB, Math.min(fromBudget, machineShare, HISTORY_ANALYSIS_WORKER_MAX_HEAP_MB));
}

/** A resource limit stopped (or prevented) a fresh analysis; reported as the point's reason. */
export class HistoryBudgetError extends Error {
  readonly code: HistoryLimitCode;

  constructor(code: HistoryLimitCode, message: string) {
    super(message);
    this.name = "HistoryBudgetError";
    this.code = code;
  }

  /** The unanalyzed reason of the point: `<code>: <detail>`. */
  get reason(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** Budget of one running analysis (bytes and deadline), handed to analyzeCommitContentSet. */
export interface CommitAnalysisMeter {
  /** Throws HistoryBudgetError once the analysis or call deadline has passed. */
  readonly checkDeadline: () => void;
  /** The deadline error once the deadline has passed, otherwise undefined. */
  readonly deadlineError: () => HistoryBudgetError | undefined;
  /** Counts source text accepted into the analysis; throws HistoryBudgetError above a byte budget. */
  readonly acceptBytes: (bytes: number) => void;
  /** Timeout for the next git process: the time left, at most the git default. */
  readonly gitTimeoutMs: () => number;
  /** Milliseconds until the deadline (0 once it has passed). */
  readonly remainingMs: () => number;
  /** The error that reports this analysis' deadline (whichever of analysis and call deadline comes first). */
  readonly expiredError: () => HistoryBudgetError;
  /** Heap limit of the analysis worker (historyAnalysisWorkerHeapMb of the per-commit budget). */
  readonly workerHeapMb: number;
}

export function historyBusyError(limits: HistoryResourceLimits): HistoryBudgetError {
  return new HistoryBudgetError(
    "analysis-busy",
    `another fresh commit analysis is running in this server process (at most ${String(limits.maxConcurrentAnalyses)} at a time, ${HISTORY_MAX_CONCURRENT_ENV}); run the tool again`,
  );
}

/**
 * Byte and time budget of one tool call, shared by its fresh analyses. The
 * call's clock starts when the budget is created.
 */
export class HistoryRequestBudget {
  readonly limits: HistoryResourceLimits;
  private readonly now: () => number;
  private readonly deadline: number;
  private bytesAccepted = 0;

  constructor(limits: HistoryResourceLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
    this.deadline = now() + limits.maxRequestMs;
  }

  /** Milliseconds left for this call's analyses (0 once the deadline has passed). */
  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  /** Throws HistoryBudgetError when this call may not start another fresh analysis. */
  assertCanStart(): void {
    if (this.now() >= this.deadline) throw this.requestDeadlineError();
    if (this.bytesAccepted >= this.limits.maxRequestBytes) throw this.requestBytesError();
  }

  /** Budget of an analysis that starts now (throws like assertCanStart). */
  startAnalysis(): CommitAnalysisMeter {
    this.assertCanStart();
    const analysisDeadline = this.now() + this.limits.maxAnalysisMs;
    const deadline = Math.min(analysisDeadline, this.deadline);
    const analysisLimitFirst = analysisDeadline <= this.deadline;
    let commitBytes = 0;
    const expiredError = (): HistoryBudgetError =>
      analysisLimitFirst
        ? new HistoryBudgetError(
            "analysis-deadline-exceeded",
            `the analysis took longer than ${HISTORY_MAX_ANALYSIS_MS_ENV} (${String(this.limits.maxAnalysisMs)} ms); raise ${HISTORY_MAX_ANALYSIS_MS_ENV} to analyze this commit`,
          )
        : this.requestDeadlineError();
    const deadlineError = (): HistoryBudgetError | undefined =>
      this.now() < deadline ? undefined : expiredError();
    const checkDeadline = (): void => {
      const error = deadlineError();
      if (error !== undefined) throw error;
    };
    return {
      checkDeadline,
      deadlineError,
      acceptBytes: (bytes) => {
        commitBytes += bytes;
        this.bytesAccepted += bytes;
        if (commitBytes > this.limits.maxCommitBytes) {
          throw new HistoryBudgetError(
            "commit-byte-budget-exceeded",
            `the commit's analyzable files hold more than ${HISTORY_MAX_COMMIT_BYTES_ENV} (${String(this.limits.maxCommitBytes)} bytes) of source text; raise ${HISTORY_MAX_COMMIT_BYTES_ENV} to analyze it`,
          );
        }
        if (this.bytesAccepted > this.limits.maxRequestBytes) throw this.requestBytesError();
        checkDeadline();
      },
      gitTimeoutMs: () => Math.max(1, Math.min(GIT_PROCESS_TIMEOUT_MS, Math.ceil(deadline - this.now()))),
      remainingMs: () => Math.max(0, deadline - this.now()),
      expiredError,
      workerHeapMb: historyAnalysisWorkerHeapMb(this.limits.maxCommitBytes),
    };
  }

  private requestDeadlineError(): HistoryBudgetError {
    return new HistoryBudgetError(
      "request-deadline-exceeded",
      `this call's fresh commit analyses took longer than ${HISTORY_MAX_REQUEST_MS_ENV} (${String(this.limits.maxRequestMs)} ms); run the tool again or raise ${HISTORY_MAX_REQUEST_MS_ENV}`,
    );
  }

  private requestBytesError(): HistoryBudgetError {
    return new HistoryBudgetError(
      "request-byte-budget-exceeded",
      `this call's fresh commit analyses read more than ${HISTORY_MAX_REQUEST_BYTES_ENV} (${String(this.limits.maxRequestBytes)} bytes) of source text; run the tool again (analyzed commits are cached with a data root) or raise ${HISTORY_MAX_REQUEST_BYTES_ENV}`,
    );
  }
}

/* Process-wide limit of running fresh analyses (FIFO, bounded waiting). */

interface SlotWaiter {
  readonly maxRunning: number;
  readonly grant: (release: () => void) => void;
  timer?: NodeJS.Timeout;
}

let runningAnalyses = 0;
const slotWaiters: SlotWaiter[] = [];

function slotRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runningAnalyses -= 1;
    grantWaitingSlots();
  };
}

function grantWaitingSlots(): void {
  for (;;) {
    const next = slotWaiters[0];
    if (next === undefined || runningAnalyses >= next.maxRunning) return;
    slotWaiters.shift();
    clearTimeout(next.timer);
    runningAnalyses += 1;
    next.grant(slotRelease());
  }
}

/**
 * Takes one of the process-wide fresh analysis slots (at most `maxRunning`
 * analyses run at a time), waiting at most `waitMs` behind earlier callers.
 * Resolves to the release function, or undefined when no slot became free in
 * time or too many calls are already waiting.
 */
export function acquireHistoryAnalysisSlot(
  maxRunning: number,
  waitMs: number,
): Promise<(() => void) | undefined> {
  if (slotWaiters.length === 0 && runningAnalyses < maxRunning) {
    runningAnalyses += 1;
    return Promise.resolve(slotRelease());
  }
  if (!(waitMs > 0) || slotWaiters.length >= MAX_WAITING_ANALYSES) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const waiter: SlotWaiter = { maxRunning, grant: resolve };
    waiter.timer = setTimeout(() => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      resolve(undefined);
      grantWaitingSlots();
    }, Math.min(waitMs, MAX_TIMER_MS));
    waiter.timer.unref();
    slotWaiters.push(waiter);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Path-only part of the workspace policy for a file path: true when an ignore
 * rule matches the file or one of its directories, or the extension filter
 * excludes it. The ignore decision is the policy's own (compileIgnoreRuleSet:
 * look-alike folded secret / VCS rules, a work budget per decision); a decision
 * that runs out of budget excludes the file. Exported for tests.
 */
export function pathRuleFilter(config: WorkspacePolicyConfig): (relativePath: string) => boolean {
  const ignoreRules = compileIgnoreRuleSet(effectiveIgnorePatterns(config));
  return (relativePath) => {
    const outcome = ignoreRules.match(relativePath, false, { remaining: IGNORE_MATCH_WORK_BUDGET });
    if (outcome.kind !== "none") {
      return true;
    }
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (config.extensionFilterMode === "blacklist") {
      return extension !== "" && config.binaryExtensions.includes(extension);
    }
    return !config.allowedExtensions.includes(extension);
  };
}

/**
 * Policy-allowed files of `commitSha`, read from git objects into inventory
 * entries (same hash as the on-disk inventory: sha256 of the UTF-8 re-encoded
 * text). Throws CommitAnalysisLimitError above `maxFiles` and
 * HistoryBudgetError when `meter` stops the analysis (a byte budget, or the
 * deadline: checked between tree entries and blob reads; a git process
 * killed by its deadline-bounded timeout is reported as the deadline).
 */
async function collectCommitInventory(
  deps: ServiceDeps,
  canonicalRoot: string,
  commitSha: string,
  maxFiles: number,
  meter: CommitAnalysisMeter,
): Promise<{ readonly entries: InventoryEntry[]; readonly skippedFiles: number }> {
  meter.checkDeadline();
  let tree: Awaited<ReturnType<typeof readGitTree>>;
  try {
    tree = await readGitTree(canonicalRoot, commitSha, { timeoutMs: meter.gitTimeoutMs() });
  } catch (error) {
    meter.checkDeadline();
    throw error;
  }
  const maxFileBytes = deps.policy.config.maxFileBytes;
  const excludedByRules = pathRuleFilter(deps.policy.config);
  const candidates: string[] = [];
  let skippedFiles = 0;
  let visited = 0;
  for (const entry of tree) {
    visited += 1;
    if (visited % POLICY_YIELD_EVERY === 0) {
      await yieldToEventLoop();
      meter.checkDeadline();
    }
    // Submodules (gitlinks) are "commit" entries; symlinks are blobs with mode 120000.
    if (entry.type !== "blob" || entry.mode === SYMLINK_MODE) continue;
    if (entry.path === TIMELINE_SNAPSHOT_BLOB_PATH) continue;
    // A path git can hold but the read API refuses (':', '\', control
    // characters, leading '-') never reaches the policy's filesystem checks.
    try {
      assertValidBlobPath(entry.path);
    } catch {
      skippedFiles += 1;
      continue;
    }
    // Ignore rules and extension filter on the commit's own path: such a file
    // is not part of the inventory in any checkout, so it is left out silently.
    if (excludedByRules(entry.path)) continue;
    // The full policy decision also depends on the working tree (a link on the
    // path, a Windows name alias): a file it refuses is reported as skipped.
    const decision = deps.policy.checkFile(canonicalRoot, path.resolve(canonicalRoot, entry.path), 0);
    if (!decision.allowed) {
      skippedFiles += 1;
      continue;
    }
    candidates.push(entry.path);
    if (candidates.length > maxFiles) {
      throw new CommitAnalysisLimitError(
        `the commit has more than index.maxFiles (${String(maxFiles)}) files the workspace rules would analyze`,
      );
    }
  }

  const read: Array<InventoryEntry | undefined> = new Array<InventoryEntry | undefined>(candidates.length);
  let next = 0;
  // The first failure stops every reader at its next file; it is rethrown
  // once all readers have returned, so no read outlives the analysis.
  const state: { failure?: { readonly error: unknown } } = {};
  const readNext = async (): Promise<void> => {
    while (state.failure === undefined) {
      const index = next;
      next += 1;
      const relativePath = candidates[index];
      if (relativePath === undefined) return;
      let content: string;
      try {
        meter.checkDeadline();
        content = await readGitBlob(canonicalRoot, commitSha, relativePath, {
          maxBufferBytes: maxFileBytes,
          timeoutMs: meter.gitTimeoutMs(),
        });
      } catch (error) {
        if (error instanceof GraphRepositoryError && /maxBuffer/i.test(error.message)) {
          skippedFiles += 1;
          continue;
        }
        state.failure ??= { error: meter.deadlineError() ?? error };
        return;
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      try {
        meter.acceptBytes(sizeBytes);
      } catch (error) {
        state.failure ??= { error };
        return;
      }
      read[index] = { relativePath, sizeBytes, contentHash: sha256Hex(utf8Encode(content)), content };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BLOB_READ_CONCURRENCY, candidates.length) }, () => readNext()),
  );
  if (state.failure !== undefined) throw state.failure.error;
  return {
    entries: read.filter((entry): entry is InventoryEntry => entry !== undefined),
    skippedFiles,
  };
}

/** Worker entry replacing the index worker of fresh analyses (test seam). */
let analysisWorkerEntryOverride: string | undefined;

/**
 * Replaces the worker entry that fresh commit analyses run in (a test seam,
 * like setGitProcessRunnerForTesting); undefined restores the index worker.
 */
export function setHistoryAnalysisWorkerEntryForTesting(entryPath: string | undefined): void {
  analysisWorkerEntryOverride = entryPath;
}

/** The point's limit error for a worker that produced no result (details go to the log). */
function workerFailureError(
  deps: ServiceDeps,
  commitSha: string,
  error: InventoryAnalysisWorkerError,
  heapMb: number,
): HistoryBudgetError {
  deps.logger(`history: the analysis worker of commit ${commitSha} produced no result (${error.failure}): ${error.message}`);
  if (error.failure === "out-of-memory") {
    return new HistoryBudgetError(
      "analysis-memory-exceeded",
      `the analysis worker reached its heap limit of ${String(heapMb)} MiB, derived from ${HISTORY_MAX_COMMIT_BYTES_ENV}; raise ${HISTORY_MAX_COMMIT_BYTES_ENV} to give the analysis more memory`,
    );
  }
  return new HistoryBudgetError(
    "analysis-worker-failed",
    error.failure === "unavailable"
      ? "the analysis worker could not be started (see the server log)"
      : "the analysis worker stopped without a result (see the server log); run the tool again",
  );
}

/**
 * A fresh analysis slot is given back at the latest this long after its
 * analysis ended, even when the worker thread of a failed analysis has not
 * exited yet (logged); a thread blocked in a synchronous call normally exits
 * well within it (a cargo probe times out after 15 s).
 */
const WORKER_RELEASE_MAX_WAIT_MS = 60_000;

/**
 * Analyzes `commitSha` from its git objects (see the module comment) within
 * the budget of `meter`: the inventory is read on this thread, the scratch
 * index runs in the index worker's inventory analysis mode
 * (runInventoryAnalysisInWorker) with `meter.workerHeapMb` as its heap
 * limit. The worker is stopped at the deadline (a timer, and a check at
 * each of its progress messages), its sidecar processes included. Throws
 * GraphRepositoryError (git reads), IndexingError (analysis),
 * CommitAnalysisLimitError or HistoryBudgetError (a byte budget, the
 * deadline, or a worker that ran out of memory, crashed or exited); the
 * caller decides how a failure is reported.
 *
 * `holdSlotUntil` is called (before the worker starts) with a promise that
 * resolves once the analysis no longer occupies a worker thread: right away
 * for a worker that answered, but for a failed or stopped one only when its
 * thread has exited, which can be after this function has thrown (a thread
 * blocked in a synchronous call cannot be stopped before it returns), at
 * the latest WORKER_RELEASE_MAX_WAIT_MS after. The caller keeps its analysis
 * slot until then.
 */
export async function analyzeCommitContentSet(
  deps: ServiceDeps,
  workspaceId: string,
  canonicalRoot: string,
  commitSha: string,
  meter: CommitAnalysisMeter,
  holdSlotUntil?: (threadReleased: Promise<void>) => void,
): Promise<CommitContentAnalysis> {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new GraphRepositoryError("compare/invalid-ref", `not a canonical commit SHA: ${commitSha}`);
  }
  const maxFiles = deps.config.index.maxFiles;
  const inventory = await collectCommitInventory(deps, canonicalRoot, commitSha, maxFiles, meter);
  meter.checkDeadline();
  const fileCount = inventory.entries.length;
  const heapMb = meter.workerHeapMb;
  const controller = new AbortController();
  const stop = (error: HistoryBudgetError): void => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const timer = setTimeout(() => {
    stop(meter.expiredError());
  }, Math.min(MAX_TIMER_MS, Math.ceil(meter.remainingMs())));
  deps.logger(
    `history: analyzing commit ${commitSha} in a worker thread (${String(fileCount)} file(s), heap limit ${String(heapMb)} MiB)`,
  );
  let threadReleased = false;
  let markThreadReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    markThreadReleased = (): void => {
      threadReleased = true;
      resolve();
    };
  });
  holdSlotUntil?.(released);
  let result: Awaited<ReturnType<typeof runInventoryAnalysisInWorker>>;
  try {
    result = await runInventoryAnalysisInWorker(
      {
        workspaceId,
        rootPath: canonicalRoot,
        policyConfig: deps.policy.config,
        limits: { maxFiles },
        entries: inventory.entries,
        fixedClockIso: deps.clock(),
      },
      {
        maxHeapMb: heapMb,
        signal: controller.signal,
        // Phase boundaries of the scratch index (also an injected clock's deadline).
        onProgress: () => {
          const error = meter.deadlineError();
          if (error !== undefined) stop(error);
        },
        ...(analysisWorkerEntryOverride === undefined ? {} : { workerEntryPath: analysisWorkerEntryOverride }),
        onWorkerReleased: ({ orphanedSidecarPids }) => {
          if (orphanedSidecarPids.length > 0) {
            deps.logger(
              `history: the analysis worker of commit ${commitSha} left ${String(orphanedSidecarPids.length)} sidecar process(es) running; they were killed (pid ${orphanedSidecarPids.join(", ")})`,
            );
          }
          markThreadReleased();
        },
      },
    );
  } catch (error) {
    if (error instanceof InventoryAnalysisWorkerError) throw workerFailureError(deps, commitSha, error, heapMb);
    throw error;
  } finally {
    clearTimeout(timer);
    if (!threadReleased) {
      const bound = setTimeout(() => {
        deps.logger(
          `history: the analysis worker of commit ${commitSha} has not exited ${String(WORKER_RELEASE_MAX_WAIT_MS)} ms after its analysis ended; its analysis slot is released anyway`,
        );
        markThreadReleased();
      }, WORKER_RELEASE_MAX_WAIT_MS);
      bound.unref();
      void released.then(() => {
        clearTimeout(bound);
      });
    }
  }
  const contentSet = JSON.parse(result.contentSetJson) as CompareContentSet;
  const degradedWorkers = degradedWorkersOf(result.analyzerFingerprint);
  deps.logger(
    `history: commit ${commitSha} analyzed from git objects: ${String(fileCount)} file(s), state ${result.state}, ${String(result.warningCount)} warning(s)${degradedWorkers.length === 0 ? "" : `, worker(s) that could not run: ${degradedWorkers.join(", ")}`}`,
  );
  return {
    contentSet,
    state: result.state,
    fileCount,
    skippedFiles: inventory.skippedFiles,
    degradedWorkers,
  };
}

/** Client-safe failure reason (details go to the server log). */
export function describeCommitAnalysisFailure(error: unknown): string {
  if (error instanceof CommitAnalysisLimitError) return error.message;
  if (error instanceof IndexingError) {
    return error.code === "indexing/limit-exceeded"
      ? error.message
      : `${error.code} (see the server log)`;
  }
  if (error instanceof GraphRepositoryError) {
    return error.code === "compare/tree-too-large"
      ? "the commit tree is too large to list"
      : `${error.code} (see the server log)`;
  }
  return "unexpected error (see the server log)";
}

/* ------------------------------------------------------------------ */
/* History cache under the data root                                   */
/* ------------------------------------------------------------------ */

interface HistoryCacheEntry {
  readonly format: typeof HISTORY_CACHE_FORMAT;
  readonly formatVersion: typeof HISTORY_CACHE_FORMAT_VERSION;
  readonly commitSha: string;
  readonly cacheKey: string;
  /** The workspace the commit was analyzed in (historySourceIdentity). */
  readonly sourceIdentity: string;
  readonly state: "ready" | "partial";
  readonly fileCount: number;
  readonly skippedFiles: number;
  readonly degradedWorkers: readonly string[];
  readonly contentSet: CompareContentSet;
}

/** What the cache needs to know about a file system entry (a subset of fs.Stats). */
export interface HistoryCacheStat {
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Device and inode of the cache directory as its trust check saw it. */
interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** File system view of the cache (injectable, e.g. to emulate POSIX owners on Windows). */
export interface HistoryCacheFileSystem {
  /** The server's uid; undefined where there is none (Windows): owner and mode are not checked. */
  readonly getuid?: () => number | undefined;
  /** Platform whose trust rules apply (default process.platform). */
  readonly platform?: NodeJS.Platform;
  /**
   * Windows: the per-user directories whose default ACL is private to the
   * server's user (default: the profile, os.homedir(), and %LOCALAPPDATA%).
   */
  readonly privateProfileDirs?: () => readonly string[];
  /** lstat (never follows a final link). */
  readonly lstat?: (target: string) => Promise<HistoryCacheStat>;
  /** Stat of an opened entry (`target` is the path it was opened by). */
  readonly fstat?: (handle: FileHandle, target: string) => Promise<HistoryCacheStat>;
}

export interface HistoryCacheOptions {
  /** Retention; default resolveHistoryCacheQuota (environment over the defaults). */
  readonly quota?: HistoryCacheQuota;
  readonly fileSystem?: HistoryCacheFileSystem;
}

/** A cache hit; `stale` marks an analysis the current toolchain could improve. */
export interface CachedCommitAnalysis {
  readonly analysis: CommitContentAnalysis;
  /**
   * True when the analysis ran without a worker that the latest published
   * index ran: analyze again when the budget allows, otherwise use it as is.
   */
  readonly stale: boolean;
}

export interface HistoryCache {
  /** Cached analysis of `commitSha`, or undefined (a corrupt entry is removed). */
  readonly lookup: (commitSha: string) => Promise<CachedCommitAnalysis | undefined>;
  /** Stores an analysis; returns false when it could not be written (logged). */
  readonly store: (commitSha: string, analysis: CommitContentAnalysis) => Promise<boolean>;
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isSameOrInside(target: string, root: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Identity of the analyzed source: the workspace id and its canonical root.
 * Recorded in every entry and part of the key, so an entry is only used for
 * the repository it was analyzed from.
 */
function historySourceIdentity(workspaceId: string, canonicalRoot: string): string {
  const input: JsonValue = {
    format: HISTORY_CACHE_FORMAT,
    workspaceId,
    root: comparable(path.resolve(canonicalRoot)),
  };
  return sha256Hex(utf8Encode(canonicalJson(input)));
}

/** Cache key: versions, analyzer fingerprint schema, source identity and the rules that shape the inventory. */
function historyCacheKey(deps: ServiceDeps, workspaceId: string, sourceIdentity: string): string {
  const policy = deps.policy.config;
  const input: JsonValue = {
    format: HISTORY_CACHE_FORMAT,
    formatVersion: HISTORY_CACHE_FORMAT_VERSION,
    causorynVersion: SERVER_VERSION,
    indexingVersion: INDEXING_VERSION,
    analyzerFingerprintSchema: ANALYZER_FINGERPRINT_SCHEMA_VERSION,
    workspaceId,
    sourceIdentity,
    maxFiles: deps.config.index.maxFiles,
    ignore: [...policy.ignore],
    extraIgnore: [...policy.extraIgnore],
    binaryExtensions: [...policy.binaryExtensions],
    extensionFilterMode: policy.extensionFilterMode,
    allowedExtensions: [...policy.allowedExtensions],
    maxFileBytes: policy.maxFileBytes,
  };
  return sha256Hex(utf8Encode(canonicalJson(input))).slice(0, 16);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validated cache entry, or a description of what is wrong with it. */
function parseHistoryCacheEntry(
  text: string,
  commitSha: string,
  cacheKey: string,
  sourceIdentity: string,
): CommitContentAnalysis | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.format !== HISTORY_CACHE_FORMAT || entry.formatVersion !== HISTORY_CACHE_FORMAT_VERSION) {
    return "unknown format";
  }
  if (entry.commitSha !== commitSha || entry.cacheKey !== cacheKey) {
    return "commit or cache key mismatch";
  }
  if (entry.sourceIdentity !== sourceIdentity) {
    return "source identity mismatch: not analyzed from this workspace root";
  }
  if (entry.state !== "ready" && entry.state !== "partial") return "invalid state";
  if (!isNonNegativeInteger(entry.fileCount) || !isNonNegativeInteger(entry.skippedFiles)) {
    return "invalid file counts";
  }
  const degradedWorkers = entry.degradedWorkers;
  if (
    !Array.isArray(degradedWorkers) ||
    !degradedWorkers.every((language) => typeof language === "string" && WORKER_LANGUAGES.has(language))
  ) {
    return "invalid degraded worker list";
  }
  const shapeError = describeManifestShapeError(entry.contentSet);
  if (shapeError !== null) return `invalid content set: ${shapeError}`;
  return {
    contentSet: entry.contentSet as CompareContentSet,
    state: entry.state,
    fileCount: entry.fileCount,
    skippedFiles: entry.skippedFiles,
    degradedWorkers: degradedWorkers as string[],
  };
}

function defaultGetuid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** The user's profile and %LOCALAPPDATA% (absolute, never a UNC/device path). */
function defaultPrivateProfileDirs(): readonly string[] {
  const candidates = [os.homedir(), process.env["LOCALAPPDATA"] ?? ""];
  return candidates.filter((dir) => dir.trim().length > 0 && path.isAbsolute(dir) && !isUncOrDevicePath(dir));
}

/** Every prefix of an absolute path below its root, shortest first. */
function pathPrefixes(target: string): string[] {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const prefixes: string[] = [];
  let current = root;
  for (const segment of resolved.slice(root.length).split(/[\\/]/)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

/**
 * F43 — why a cache directory is not trusted on Windows, or undefined. Node
 * cannot read a DACL without native code and the server never spawns icacls,
 * so ownership cannot be checked there. The cache is trusted only inside a
 * per-user directory whose default ACL grants access to the user (and
 * SYSTEM/Administrators) alone: its native real path must lie inside one of
 * them, and no component of the path it is used by may be a link or junction
 * (one could be retargeted after the check), except the private directory
 * itself or a directory above it (a relocated profile). Anywhere else, such as
 * a --data-dir in a new folder at a drive root (which inherits write access
 * for every authenticated user), every commit is analyzed fresh instead.
 */
async function windowsTrustProblem(
  target: string,
  realTarget: string,
  privateDirs: readonly string[],
  lstatFn: (target: string) => Promise<HistoryCacheStat>,
): Promise<string | undefined> {
  const lexicalPrivate = privateDirs.map((dir) => path.resolve(dir));
  for (const prefix of pathPrefixes(target)) {
    const stat = await lstatFn(prefix);
    if (!stat.isSymbolicLink()) continue;
    if (lexicalPrivate.some((dir) => isSameOrInside(dir, prefix))) continue;
    return `reached through a link or junction (${prefix}); Windows ACLs are not inspected, so only a path of real directories inside the user's profile is trusted`;
  }
  for (const dir of lexicalPrivate) {
    const realPrivate = await realpath(dir).catch(() => undefined);
    if (realPrivate !== undefined && isSameOrInside(realTarget, realPrivate)) return undefined;
  }
  return "outside the user's profile; Windows ACLs are not inspected, so only a data root inside the profile (the default ~/.causoryn) is trusted and every commit is analyzed fresh";
}

/**
 * Why a cache directory or entry is not trusted on POSIX (another owner, or
 * group/other write permission), or undefined. Without a uid (Windows)
 * nothing is checked.
 */
function ownershipProblem(stat: HistoryCacheStat, uid: number | undefined): string | undefined {
  if (uid === undefined) return undefined;
  if (stat.uid !== uid) return `owned by uid ${String(stat.uid)}, not the server's uid ${String(uid)}`;
  if ((stat.mode & GROUP_OR_OTHER_WRITE) !== 0) {
    return `writable by group or others (mode ${(stat.mode & 0o777).toString(8).padStart(3, "0")})`;
  }
  return undefined;
}

/**
 * History cache of this workspace, or null without a data root
 * (`storage.dataDbPath`): then commits are analyzed without caching.
 */
export function openHistoryCache(
  deps: ServiceDeps,
  workspaceId: string,
  canonicalRoot: string,
  options: HistoryCacheOptions = {},
): HistoryCache | null {
  const dataDbPath = deps.config.storage.dataDbPath;
  if (dataDbPath === undefined) return null;
  const fileSystemLstat = options.fileSystem?.lstat ?? ((target: string) => lstat(target));
  const fileSystemFstat = options.fileSystem?.fstat ?? ((handle: FileHandle) => handle.stat());
  const getuid = options.fileSystem?.getuid ?? defaultGetuid;
  const platform = options.fileSystem?.platform ?? process.platform;
  const privateProfileDirs = options.fileSystem?.privateProfileDirs ?? defaultPrivateProfileDirs;
  const quota = options.quota ?? resolveHistoryCacheQuota(deps.logger);
  const dataDir = path.dirname(path.resolve(dataDbPath));
  const dir = path.join(dataDir, HISTORY_DIR_NAME);
  const sourceIdentity = historySourceIdentity(workspaceId, canonicalRoot);
  const cacheKey = historyCacheKey(deps, workspaceId, sourceIdentity);
  const fileFor = (commitSha: string): string => path.join(dir, `${commitSha}-${cacheKey}.json`);

  // One line per distinct problem and cache handle (a call looks up several points).
  const logged = new Set<string>();
  const logOnce = (message: string): void => {
    if (logged.has(message)) return;
    logged.add(message);
    deps.logger(message);
  };

  /**
   * `target` must be a real directory (not a link) whose lexical and real
   * paths are outside every authorized workspace root. For the cache
   * directory itself (`trusted`) it must also be the `history` directory of
   * the real data directory and pass the POSIX owner and mode checks.
   * Returns the identity (device and inode) it checked, or undefined.
   */
  const usableDirIdentity = async (target: string, trusted: boolean): Promise<DirIdentity | undefined> => {
    try {
      const stat = await fileSystemLstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        logOnce(`history: the history cache path is a link or not a directory and is not used: ${target}`);
        return undefined;
      }
      const realTarget = await realpath(target);
      for (const root of [canonicalRoot, ...deps.config.allowRoots]) {
        const realRoot = await realpath(root).catch(() => path.resolve(root));
        if (isSameOrInside(realTarget, realRoot) || isSameOrInside(target, path.resolve(root))) {
          logOnce(`history: the history cache directory is inside a workspace root and is not used: ${target}`);
          return undefined;
        }
      }
      const identity: DirIdentity = { dev: stat.dev, ino: stat.ino };
      if (!trusted) return identity;
      const expected = path.join(await realpath(dataDir), HISTORY_DIR_NAME);
      if (comparable(realTarget) !== comparable(expected)) {
        logOnce(`history: the history cache directory does not resolve inside the data directory and is not used: ${target}`);
        return undefined;
      }
      if (platform === "win32") {
        const windowsProblem = await windowsTrustProblem(target, realTarget, privateProfileDirs(), fileSystemLstat);
        if (windowsProblem !== undefined) {
          logOnce(`history: the history cache directory is ${windowsProblem}; it is not trusted: ${target}`);
          return undefined;
        }
      }
      const problem = ownershipProblem(stat, getuid());
      if (problem !== undefined) {
        logOnce(`history: the history cache directory is ${problem} and is not trusted: ${target}`);
        return undefined;
      }
      return identity;
    } catch {
      return undefined;
    }
  };
  /** Trust check of the cache directory; its identity binds every later write, rename and unlink. */
  const verifyDir = (): Promise<DirIdentity | undefined> => usableDirIdentity(dir, true);

  /**
   * True when the cache directory is still the one `verified` describes: not
   * a link, a directory, same device and inode. Checked with lstat right
   * before each temporary file create, rename and unlink, so a directory
   * swapped for a link or another directory after its trust check is never
   * written through (the operations are path-based; this narrows the window
   * to the single file system call).
   */
  const dirUnchanged = async (verified: DirIdentity, operation: string): Promise<boolean> => {
    let current: HistoryCacheStat;
    try {
      current = await fileSystemLstat(dir);
    } catch {
      logOnce(`history: the history cache directory disappeared after its trust check; skipping ${operation}: ${dir}`);
      return false;
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== verified.dev ||
      current.ino !== verified.ino
    ) {
      logOnce(`history: the history cache directory changed after its trust check (a link or another directory); skipping ${operation}: ${dir}`);
      return false;
    }
    return true;
  };

  /** Worker run states of the latest published index (read once per cache handle). */
  let indexWorkerStates: Map<string, boolean> | undefined;
  const indexWorkers = (): Map<string, boolean> => {
    if (indexWorkerStates === undefined) {
      let fingerprint: string | undefined;
      try {
        fingerprint =
          typeof deps.repository.getLatestSnapshotMeta === "function"
            ? deps.repository.getLatestSnapshotMeta(workspaceId)?.analyzerFingerprint
            : deps.repository.getLatestPublished(workspaceId)?.snapshot.meta.analyzerFingerprint;
      } catch {
        fingerprint = undefined;
      }
      indexWorkerStates = fingerprint === undefined ? new Map() : workerStatesOf(fingerprint);
    }
    return indexWorkerStates;
  };

  /** Unlinks `file`; true when it is gone afterwards. Callers check the directory first. */
  const unlinkFile = async (file: string): Promise<boolean> => {
    try {
      await unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
      deps.logger(`history: could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  /**
   * Removes `file` of the cache directory checked as `verified`; true when it
   * is gone afterwards. Nothing is removed once the directory has changed.
   */
  const remove = async (file: string, verified: DirIdentity): Promise<boolean> =>
    (await dirUnchanged(verified, "a removal")) && (await unlinkFile(file));

  /**
   * Evicts entries (every entry file of the directory, whatever its key),
   * oldest modification time first and ties by name, until at most
   * `maxEntries` entries and `maxTotalBytes` bytes remain; `keep` (the entry
   * just written) is never evicted. Temporary files older than an hour (a
   * write that never finished) are removed as well. Every removal requires
   * the directory to still be the one checked as `verified`.
   */
  const enforceQuota = async (keep: string, verified: DirIdentity): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const entries: Array<{ readonly name: string; readonly size: number; readonly mtimeMs: number }> = [];
    for (const name of names) {
      const isEntry = HISTORY_ENTRY_FILE_PATTERN.test(name);
      if (!isEntry && !HISTORY_TEMPORARY_FILE_PATTERN.test(name)) continue;
      try {
        const stat = await fileSystemLstat(path.join(dir, name));
        if (!stat.isFile()) continue;
        if (isEntry) {
          entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
        } else if (Date.now() - stat.mtimeMs > ORPHANED_TEMPORARY_FILE_AGE_MS) {
          await remove(path.join(dir, name), verified);
        }
      } catch {
        // Gone in the meantime.
      }
    }
    let count = entries.length;
    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const withinQuota = (): boolean => count <= quota.maxEntries && totalBytes <= quota.maxTotalBytes;
    if (withinQuota()) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let evicted = 0;
    for (const entry of entries) {
      if (withinQuota()) break;
      if (entry.name === keep) continue;
      if (!(await dirUnchanged(verified, "eviction"))) break;
      if (await unlinkFile(path.join(dir, entry.name))) {
        count -= 1;
        totalBytes -= entry.size;
        evicted += 1;
      }
    }
    deps.logger(
      `history: evicted ${String(evicted)} history cache entr${evicted === 1 ? "y" : "ies"} (oldest first) to keep at most ${String(quota.maxEntries)} entries (${HISTORY_CACHE_MAX_ENTRIES_ENV}) and ${String(quota.maxTotalBytes)} bytes (${HISTORY_CACHE_MAX_BYTES_ENV})`,
    );
  };

  /**
   * Reads an entry through one descriptor: the opened file must be the one
   * `checked` describes (same device and inode, so a link or a swapped file
   * is refused) and pass the owner and mode checks itself, so a swap of the
   * entry or of a directory above it after the path checks is never read.
   */
  const readEntry = async (
    file: string,
    checked: HistoryCacheStat,
  ): Promise<
    | { readonly status: "ok"; readonly text: string }
    | { readonly status: "missing" }
    | { readonly status: "untrusted"; readonly problem: string }
    | { readonly status: "too-large" }
  > => {
    let handle: FileHandle;
    try {
      handle = await open(file, ENTRY_OPEN_FLAGS);
    } catch {
      return { status: "missing" };
    }
    try {
      const opened = await fileSystemFstat(handle, file);
      if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) {
        return { status: "untrusted", problem: "the opened file is not the checked entry" };
      }
      const problem = ownershipProblem(opened, getuid());
      if (problem !== undefined) return { status: "untrusted", problem };
      if (opened.size > MAX_HISTORY_CACHE_ENTRY_BYTES) return { status: "too-large" };
      const limit = MAX_HISTORY_CACHE_ENTRY_BYTES + 1;
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < limit) {
        const buffer = Buffer.allocUnsafe(Math.min(ENTRY_READ_CHUNK_BYTES, limit - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > MAX_HISTORY_CACHE_ENTRY_BYTES) return { status: "too-large" };
      return { status: "ok", text: Buffer.concat(chunks, total).toString("utf8") };
    } catch {
      return { status: "missing" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const lookup = async (commitSha: string): Promise<CachedCommitAnalysis | undefined> => {
    // The SHA becomes a file name: only canonical commit SHAs are looked up.
    if (!COMMIT_SHA_PATTERN.test(commitSha)) return undefined;
    const verified = await verifyDir();
    if (verified === undefined) return undefined;
    const file = fileFor(commitSha);
    let entryStat: HistoryCacheStat;
    try {
      entryStat = await fileSystemLstat(file);
    } catch {
      return undefined;
    }
    if (!entryStat.isFile()) {
      logOnce(`history: ignoring a history cache entry that is not a regular file: ${file}`);
      return undefined;
    }
    const problem = ownershipProblem(entryStat, getuid());
    if (problem !== undefined) {
      logOnce(`history: ignoring an untrusted history cache entry (${problem}): ${file}`);
      return undefined;
    }
    const read = await readEntry(file, entryStat);
    if (read.status === "missing") return undefined;
    if (read.status === "untrusted") {
      logOnce(`history: ignoring an untrusted history cache entry (${read.problem}): ${file}`);
      return undefined;
    }
    if (read.status === "too-large") {
      deps.logger(`history: ignoring and removing an oversized history cache entry: ${file}`);
      await remove(file, verified);
      return undefined;
    }
    const parsed = parseHistoryCacheEntry(read.text, commitSha, cacheKey, sourceIdentity);
    if (typeof parsed === "string") {
      deps.logger(`history: ignoring and removing a corrupt or foreign history cache entry (${parsed}): ${file}`);
      await remove(file, verified);
      return undefined;
    }
    // An entry analyzed without a worker is stale once an index build ran that
    // worker; a fresh analysis (when the budget allows) then replaces it.
    const nowAvailable = parsed.degradedWorkers.filter((language) => indexWorkers().get(language) === true);
    if (nowAvailable.length > 0) {
      deps.logger(
        `history: the cached analysis of commit ${commitSha} ran without the ${nowAvailable.join(", ")} worker, which the current index ran; it is analyzed again when the budget allows`,
      );
      return { analysis: parsed, stale: true };
    }
    return { analysis: parsed, stale: false };
  };

  const store = async (commitSha: string, analysis: CommitContentAnalysis): Promise<boolean> => {
    // The SHA becomes a file name: anything but a canonical commit SHA is never written.
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      deps.logger(`history: refusing to cache an entry for a value that is not a commit SHA: ${JSON.stringify(commitSha.slice(0, 80))}`);
      return false;
    }
    // The data directory is checked before anything is created in it.
    if ((await usableDirIdentity(dataDir, false)) === undefined) {
      deps.logger(`history: the data directory is not usable for the history cache: ${dataDir}`);
      return false;
    }
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        deps.logger(`history: could not create ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    const verified = await verifyDir();
    if (verified === undefined) {
      deps.logger(`history: the history cache directory is not usable: ${dir}`);
      return false;
    }
    const entry: HistoryCacheEntry = {
      format: HISTORY_CACHE_FORMAT,
      formatVersion: HISTORY_CACHE_FORMAT_VERSION,
      commitSha,
      cacheKey,
      sourceIdentity,
      state: analysis.state,
      fileCount: analysis.fileCount,
      skippedFiles: analysis.skippedFiles,
      degradedWorkers: analysis.degradedWorkers,
      contentSet: analysis.contentSet,
    };
    const json = JSON.stringify(entry);
    const entryBytes = Buffer.byteLength(json, "utf8");
    if (entryBytes > MAX_HISTORY_CACHE_ENTRY_BYTES || entryBytes > quota.maxTotalBytes) {
      deps.logger(
        `history: the analysis of commit ${commitSha} is too large to cache (${String(entryBytes)} bytes; ${HISTORY_CACHE_MAX_BYTES_ENV} is ${String(quota.maxTotalBytes)})`,
      );
      return false;
    }
    const file = fileFor(commitSha);
    const temporary = path.join(
      dir,
      `.${path.basename(file)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const writeFailed = async (error: unknown): Promise<false> => {
      await remove(temporary, verified);
      deps.logger(
        `history: could not write the history cache entry ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    };
    // The temporary file and the rename go into the directory the trust check saw, or nowhere.
    if (!(await dirUnchanged(verified, "the entry write"))) return false;
    try {
      await writeFile(temporary, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      return writeFailed(error);
    }
    // After a change the temporary file is left where it is: it is neither
    // renamed nor removed through the changed path.
    if (!(await dirUnchanged(verified, "the entry rename"))) return false;
    try {
      await rename(temporary, file);
    } catch (error) {
      return writeFailed(error);
    }
    await enforceQuota(path.basename(file), verified);
    return true;
  };

  return { lookup, store };
}
