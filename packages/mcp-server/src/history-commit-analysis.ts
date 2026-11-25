import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex, utf8Encode, type JsonValue } from "@causoryn/domain";
import {
  assertValidBlobPath,
  describeManifestShapeError,
  GraphRepositoryError,
  InMemoryGraphRepository,
  readGitBlob,
  readGitTree,
  serializeSnapshotContentSet,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  type CompareContentSet,
} from "@causoryn/graph";
import {
  ANALYZER_FINGERPRINT_SCHEMA_VERSION,
  INDEXING_VERSION,
  IndexingError,
  IndexService,
  type InventoryEntry,
} from "@causoryn/indexing";

import { readOptionalBoundedTextFile } from "./safe-file-read.js";
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
 * so a commit point has the same granularity as an index point.
 *
 * Known approximation: source files come from the commit, while project and
 * build inputs outside the inventory (C# `.csproj` / `Directory.Build.props`
 * read by the project model, installed `node_modules` / NuGet packages) and
 * the workspace rules themselves come from the current working tree and
 * configuration.
 *
 * Cache: with a data root (`storage.dataDbPath`), a result is stored at
 * `<dir of dataDbPath>/history/<commitSha>-<cacheKey>.json`, written through a
 * unique temporary file (flag "wx", owner-only mode) and a rename, never
 * inside an authorized workspace root. The key covers the Causoryn and
 * indexing versions, the analyzer fingerprint schema and the policy
 * configuration, so analyzer or rule changes start a new entry. Entries whose
 * analysis ran without an available language worker are not cached (they
 * depend on this machine's toolchain). A corrupt entry is removed and the
 * commit is analyzed again.
 */

/** Environment override of the fresh analyses one history tool call may run. */
export const HISTORY_ANALYSIS_BUDGET_ENV = "CAUSORYN_HISTORY_MAX_ANALYSES";
/** Default fresh analyses per `causoryn_compare_architecture` call (one per side). */
export const DEFAULT_COMPARE_FRESH_ANALYSES = 2;
/** Default fresh analyses per `causoryn_architecture_timeline` call. */
export const DEFAULT_TIMELINE_FRESH_ANALYSES = 4;

/** Note attached to every point analyzed from git objects (the documented approximation). */
export const COMMIT_ANALYSIS_NOTE =
  "was analyzed from its git objects (source files from the commit; project files and installed packages from the working tree)";
export const HISTORY_CACHE_NOTE = "served from the history cache";

const HISTORY_CACHE_FORMAT = "causoryn-history-commit-analysis";
const HISTORY_CACHE_FORMAT_VERSION = 1;
const HISTORY_DIR_NAME = "history";
/** Upper bound for one cache entry (read and write). */
const MAX_HISTORY_CACHE_ENTRY_BYTES = 256 * 1024 * 1024;
const BLOB_READ_CONCURRENCY = 6;
const SYMLINK_MODE = "120000";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/** Result of one commit analysis (fresh or from the cache). */
export interface CommitContentAnalysis {
  readonly contentSet: CompareContentSet;
  readonly state: "ready" | "partial";
  /** Files of the commit that were analyzed. */
  readonly fileCount: number;
  /** Policy-allowed files that were not analyzed: above maxFileBytes or with an unusable git path. */
  readonly skippedFiles: number;
  /** True when a language worker could not run (the result depends on this machine's toolchain). */
  readonly toolchainDegraded: boolean;
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
  const raw = env[HISTORY_ANALYSIS_BUDGET_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return toolDefault;
  const parsed = POSITIVE_INTEGER_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    deps.logger(
      `history: ${HISTORY_ANALYSIS_BUDGET_ENV} must be a positive integer; ignoring ${JSON.stringify(raw)} and using ${String(toolDefault)}`,
    );
    return toolDefault;
  }
  return parsed;
}

/**
 * Policy-allowed files of `commitSha`, read from git objects into inventory
 * entries (same hash as the on-disk inventory: sha256 of the UTF-8 re-encoded
 * text). Throws CommitAnalysisLimitError above `maxFiles`.
 */
async function collectCommitInventory(
  deps: ServiceDeps,
  canonicalRoot: string,
  commitSha: string,
  maxFiles: number,
): Promise<{ readonly entries: InventoryEntry[]; readonly skippedFiles: number }> {
  const tree = await readGitTree(canonicalRoot, commitSha);
  const maxFileBytes = deps.policy.config.maxFileBytes;
  const candidates: string[] = [];
  let skippedFiles = 0;
  for (const entry of tree) {
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
    // Path-only decision (ignore rules + extension filter), as for the on-disk inventory.
    const decision = deps.policy.checkFile(canonicalRoot, path.resolve(canonicalRoot, entry.path), 0);
    if (!decision.allowed) continue;
    candidates.push(entry.path);
    if (candidates.length > maxFiles) {
      throw new CommitAnalysisLimitError(
        `the commit has more than index.maxFiles (${String(maxFiles)}) files the workspace rules would analyze`,
      );
    }
  }

  const read: Array<InventoryEntry | undefined> = new Array<InventoryEntry | undefined>(candidates.length);
  let next = 0;
  let failed = false;
  const readNext = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      const relativePath = candidates[index];
      if (relativePath === undefined) return;
      let content: string;
      try {
        content = await readGitBlob(canonicalRoot, commitSha, relativePath, {
          maxBufferBytes: maxFileBytes,
        });
      } catch (error) {
        if (error instanceof GraphRepositoryError && /maxBuffer/i.test(error.message)) {
          skippedFiles += 1;
          continue;
        }
        // The other readers stop at their next file instead of reading the rest.
        failed = true;
        throw error;
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      read[index] = { relativePath, sizeBytes, contentHash: sha256Hex(utf8Encode(content)), content };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BLOB_READ_CONCURRENCY, candidates.length) }, () => readNext()),
  );
  return {
    entries: read.filter((entry): entry is InventoryEntry => entry !== undefined),
    skippedFiles,
  };
}

/**
 * Analyzes `commitSha` from its git objects (see the module comment). Throws
 * GraphRepositoryError (git reads), IndexingError (analysis) or
 * CommitAnalysisLimitError; the caller decides how a failure is reported.
 */
export async function analyzeCommitContentSet(
  deps: ServiceDeps,
  workspaceId: string,
  canonicalRoot: string,
  commitSha: string,
): Promise<CommitContentAnalysis> {
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new GraphRepositoryError("compare/invalid-ref", `not a canonical commit SHA: ${commitSha}`);
  }
  const maxFiles = deps.config.index.maxFiles;
  const inventory = await collectCommitInventory(deps, canonicalRoot, commitSha, maxFiles);
  const scratch = new IndexService({
    workspaceId,
    policy: deps.policy,
    repository: new InMemoryGraphRepository(),
    clock: deps.clock,
    limits: { maxFiles },
    inventorySource: () => Promise.resolve(inventory.entries),
  });
  const run = await scratch.runIndexAsync(canonicalRoot);
  const contentSet = JSON.parse(serializeSnapshotContentSet(run.snapshot)) as CompareContentSet;
  const fingerprint = run.snapshot.meta.analyzerFingerprint;
  const toolchainDegraded =
    fingerprint.includes("worker-unavailable") || fingerprint.includes("sync-run-degraded");
  deps.logger(
    `history: commit ${commitSha} analyzed from git objects: ${String(inventory.entries.length)} file(s), state ${run.state}, ${String(run.warnings.length)} warning(s)${toolchainDegraded ? ", a language worker was unavailable" : ""}`,
  );
  return {
    contentSet,
    state: run.state,
    fileCount: inventory.entries.length,
    skippedFiles: inventory.skippedFiles,
    toolchainDegraded,
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
  readonly state: "ready" | "partial";
  readonly fileCount: number;
  readonly skippedFiles: number;
  readonly contentSet: CompareContentSet;
}

export interface HistoryCache {
  /** Cached analysis of `commitSha`, or undefined (a corrupt entry is removed). */
  readonly lookup: (commitSha: string) => Promise<CommitContentAnalysis | undefined>;
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

/** Cache key: versions, analyzer fingerprint schema and the rules that shape the inventory. */
function historyCacheKey(deps: ServiceDeps, workspaceId: string): string {
  const policy = deps.policy.config;
  const input: JsonValue = {
    format: HISTORY_CACHE_FORMAT,
    formatVersion: HISTORY_CACHE_FORMAT_VERSION,
    causorynVersion: SERVER_VERSION,
    indexingVersion: INDEXING_VERSION,
    analyzerFingerprintSchema: ANALYZER_FINGERPRINT_SCHEMA_VERSION,
    workspaceId,
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
  if (entry.state !== "ready" && entry.state !== "partial") return "invalid state";
  if (!isNonNegativeInteger(entry.fileCount) || !isNonNegativeInteger(entry.skippedFiles)) {
    return "invalid file counts";
  }
  const shapeError = describeManifestShapeError(entry.contentSet);
  if (shapeError !== null) return `invalid content set: ${shapeError}`;
  return {
    contentSet: entry.contentSet as CompareContentSet,
    state: entry.state,
    fileCount: entry.fileCount,
    skippedFiles: entry.skippedFiles,
    toolchainDegraded: false,
  };
}

/**
 * History cache of this workspace, or null without a data root
 * (`storage.dataDbPath`): then commits are analyzed without caching.
 */
export function openHistoryCache(
  deps: ServiceDeps,
  workspaceId: string,
  canonicalRoot: string,
): HistoryCache | null {
  const dataDbPath = deps.config.storage.dataDbPath;
  if (dataDbPath === undefined) return null;
  const dataDir = path.dirname(path.resolve(dataDbPath));
  const dir = path.join(dataDir, HISTORY_DIR_NAME);
  const cacheKey = historyCacheKey(deps, workspaceId);
  const fileFor = (commitSha: string): string => path.join(dir, `${commitSha}-${cacheKey}.json`);

  /**
   * `target` must be a real directory (not a link) whose lexical and real
   * paths are outside every authorized workspace root.
   */
  const isUsableDir = async (target: string): Promise<boolean> => {
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const realTarget = await realpath(target);
      for (const root of [canonicalRoot, ...deps.config.allowRoots]) {
        const realRoot = await realpath(root).catch(() => path.resolve(root));
        if (isSameOrInside(realTarget, realRoot) || isSameOrInside(target, path.resolve(root))) {
          deps.logger(`history: the history cache directory is inside a workspace root and is not used: ${target}`);
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  const verifyDir = (): Promise<boolean> => isUsableDir(dir);

  const remove = async (file: string): Promise<void> => {
    await unlink(file).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        deps.logger(`history: could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  const lookup = async (commitSha: string): Promise<CommitContentAnalysis | undefined> => {
    if (!(await verifyDir())) return undefined;
    const file = fileFor(commitSha);
    const read = await readOptionalBoundedTextFile(file, MAX_HISTORY_CACHE_ENTRY_BYTES, { root: dir });
    if (read.status === "missing") return undefined;
    if (read.status === "too-large") {
      deps.logger(`history: ignoring and removing an oversized history cache entry: ${file}`);
      await remove(file);
      return undefined;
    }
    const parsed = parseHistoryCacheEntry(read.text, commitSha, cacheKey);
    if (typeof parsed === "string") {
      deps.logger(`history: ignoring and removing a corrupt history cache entry (${parsed}): ${file}`);
      await remove(file);
      return undefined;
    }
    return parsed;
  };

  const store = async (commitSha: string, analysis: CommitContentAnalysis): Promise<boolean> => {
    // The data directory is checked before anything is created in it.
    if (!(await isUsableDir(dataDir))) {
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
    if (!(await verifyDir())) {
      deps.logger(`history: the history cache directory is not usable: ${dir}`);
      return false;
    }
    const entry: HistoryCacheEntry = {
      format: HISTORY_CACHE_FORMAT,
      formatVersion: HISTORY_CACHE_FORMAT_VERSION,
      commitSha,
      cacheKey,
      state: analysis.state,
      fileCount: analysis.fileCount,
      skippedFiles: analysis.skippedFiles,
      contentSet: analysis.contentSet,
    };
    const json = JSON.stringify(entry);
    if (Buffer.byteLength(json, "utf8") > MAX_HISTORY_CACHE_ENTRY_BYTES) {
      deps.logger(`history: the analysis of commit ${commitSha} is too large to cache`);
      return false;
    }
    const file = fileFor(commitSha);
    const temporary = path.join(
      dir,
      `.${path.basename(file)}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporary, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, file);
      return true;
    } catch (error) {
      await remove(temporary);
      deps.logger(
        `history: could not write the history cache entry ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  return { lookup, store };
}
