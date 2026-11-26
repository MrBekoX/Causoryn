import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type Dir,
  type Dirent,
} from "node:fs";
import path from "node:path";

import { DEFAULT_IGNORE_PATTERNS, matchesIgnorePattern } from "@causoryn/workspace";

// Causoryn v0.2.3 — Modüler, salt-okunur, deterministik workspace ignore keşfi
// ve akıllı `bin/` ayrımı (AC-3, AC-4).
//
// Kaynaklar (deterministik birleştirme sırası):
//   1. Kök `.gitignore` (negasyon-güvenli, symlink yok, <= 256 KB)
//   2. `.git/info/exclude` (yalnızca `.git` gerçek non-symlink dizinse; CWE-59)
//   3. İç içe (nested) `.gitignore` dosyaları (sınırlı BFS yürüyüşü:
//      derinlik <= 6, en fazla 64 dosya, en fazla 4.000 dizin, her desen kendi
//      alt dizinine kapsamlandırılır, dirOnly `/` korunur, dosya-bazlı negasyon-güvenli)
//   4. Akıllı `bin/` ayrımı (yalnızca çağıran açık `ignore` vermediğinde):
//      TŞ §20 `DEFAULT_IGNORE_PATTERNS` dokunulmadan, auto-config içinde kaba
//      `**/bin/**` yerine `**/bin/{Debug,Release,x64,x86,AnyCPU}/**` ve derinlik
//      <= 4 sınırlı taramada bulunan `.csproj`/`.fsproj`/`.vbproj` dizinlerinin
//      en fazla 128 `<dir>/bin/**` deseni konur; böylece Node (`bin/cli.ts`) ve
//      Rust (`src/bin/main.rs`) kaynakları gizlenmez.
//
// Total work budgets of one discovery run (F46 / F49): the per-file and
// per-walk caps above are each bounded, but their product is not. Every
// pattern match (the negation-conflict check of every parsed entry, kept or
// dropped, and the prune check of every child directory, pruned or not) is
// charged to MAX_DISCOVERY_MATCH_WORK, and every directory entry the walks
// examine is charged to MAX_DISCOVERY_DIRECTORY_ENTRIES. When a budget runs
// out, discovery stops right there: the patterns accepted so far are kept
// (each passed the full negation check), the remaining sources are skipped and
// `limitReached` names the budget. The charges depend only on the workspace
// content, so the same input always stops at the same place.

export const MAX_IGNORE_FILE_BYTES = 256 * 1024;
export const MAX_NESTED_GITIGNORE_DEPTH = 6;
export const MAX_NESTED_GITIGNORE_FILES = 64;
export const MAX_NESTED_WALK_DIRS = 4_000;
export const MAX_DISCOVERED_IGNORE_PATTERNS = 1_000;
export const MAX_CSPROJ_SCAN_DEPTH = 4;
export const MAX_CSPROJ_SCAN_DIRS = 2_000;
export const MAX_CSPROJ_BIN_PATTERNS = 128;
export const MAX_LINES_PER_IGNORE_FILE = 4_000;
export const MAX_NEGATED_ANCESTOR_DEPTH = 16;
export const MAX_WILDCARDS_PER_PATTERN = 16;

/** Directory entries (files and directories, pruned or not) all walks of one run may examine. */
export const MAX_DISCOVERY_DIRECTORY_ENTRIES = 200_000;
/**
 * Match work one run may spend, in matcher step units (see matchWorkCost). At
 * the measured worst case of a few nanoseconds per unit this keeps a hostile
 * workspace to a stall of about a second; a large monorepo uses a few percent
 * of it.
 */
export const MAX_DISCOVERY_MATCH_WORK = 250_000_000;
/** Fixed charge of one matcher call (normalisation, pattern cache lookup, splitting). */
export const DISCOVERY_MATCH_CALL_COST = 100;

const MAX_NEGATED_MATCH_TARGETS = 64;
const MAX_PATTERN_LENGTH = 512;
const MAX_GLOBSTAR_SEGMENTS = 4;
const IS_WIN = process.platform === "win32";
const DOTNET_PROJECT_FILE_RE = /\.(?:csproj|fsproj|vbproj)$/i;

const OPEN_READ_NOFOLLOW_FLAGS =
  fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);

const SMART_BIN_SUBDIR_PATTERNS: readonly string[] = [
  "**/bin/Debug/**",
  "**/bin/Release/**",
  "**/bin/x64/**",
  "**/bin/x86/**",
  "**/bin/AnyCPU/**",
];

/** The total work budget of a discovery run that ran out. */
export type IgnoreDiscoveryLimit = "directory-entries" | "match-work";

/** Total work budgets of one run; omitted fields use the MAX_DISCOVERY_* defaults. */
export interface IgnoreDiscoveryBudgets {
  readonly maxDirectoryEntries?: number;
  readonly maxMatchWork?: number;
}

export interface WorkspaceIgnoreDiscoveryOptions {
  readonly hasExplicitIgnore?: boolean;
  /** Lower total budgets than the defaults (tests and tuning). */
  readonly budgets?: IgnoreDiscoveryBudgets;
}

export interface WorkspaceIgnoreDiscoveryResult {
  readonly extraIgnore: readonly string[];
  readonly refinedDefaultIgnore?: readonly string[];
  /**
   * Set when a total work budget ran out: discovery stopped there, kept the
   * patterns it had accepted and skipped the remaining sources.
   */
  readonly limitReached?: IgnoreDiscoveryLimit;
}

/** A pattern with its match weight (see patternMatchWeight), computed once. */
interface WeightedPattern {
  readonly pattern: string;
  readonly weight: number;
}

/**
 * Factor of the candidate length in the worst-case step count of one
 * matchesIgnorePattern call (two-pointer glob, SEC-01): a literal pattern scans
 * the candidate once; a pattern whose only wildcards are whole `**` segments
 * backtracks per segment; any other wildcard can backtrack per character.
 */
function patternMatchWeight(pattern: string): number {
  if (!hasWildcardChars(pattern)) return 1;
  const segments = pattern.split(/[\\/]/);
  const globstarOnly = segments.every((segment) => segment === "**" || !hasWildcardChars(segment));
  return globstarOnly ? segments.length + 1 : pattern.length + 1;
}

function weighPatterns(patterns: readonly string[]): WeightedPattern[] {
  return patterns.map((pattern) => ({ pattern, weight: patternMatchWeight(pattern) }));
}

/** Upper bound of the work of one matcher call, in step units. */
function matchWorkCost(candidate: string, pattern: WeightedPattern): number {
  return DISCOVERY_MATCH_CALL_COST + pattern.weight * (candidate.length + 1) + pattern.pattern.length;
}

/** The two total budgets of one discovery run; once one runs out every later charge fails. */
class DiscoveryBudget {
  private matchWork: number;
  private directoryEntries: number;
  limitReached: IgnoreDiscoveryLimit | undefined;

  constructor(budgets: IgnoreDiscoveryBudgets | undefined) {
    this.matchWork = budgets?.maxMatchWork ?? MAX_DISCOVERY_MATCH_WORK;
    this.directoryEntries = budgets?.maxDirectoryEntries ?? MAX_DISCOVERY_DIRECTORY_ENTRIES;
  }

  get exhausted(): boolean {
    return this.limitReached !== undefined;
  }

  /** Pays for one examined directory entry; false once the budget is gone. */
  chargeDirectoryEntry(): boolean {
    if (this.limitReached !== undefined) return false;
    if (this.directoryEntries <= 0) {
      this.limitReached = "directory-entries";
      return false;
    }
    this.directoryEntries -= 1;
    return true;
  }

  /** One charged match; undefined (and no match is run) once the budget cannot pay for it. */
  match(candidate: string, isDirectory: boolean, pattern: WeightedPattern): boolean | undefined {
    if (this.limitReached !== undefined) return undefined;
    const cost = matchWorkCost(candidate, pattern);
    if (cost > this.matchWork) {
      this.limitReached = "match-work";
      return undefined;
    }
    this.matchWork -= cost;
    return matchesIgnorePattern(candidate, isDirectory, pattern.pattern);
  }

  /**
   * Whether any pattern matches, tried in order like findMatchingIgnorePattern
   * with every attempt charged; undefined when the budget ran out first.
   */
  matchesAny(candidate: string, isDirectory: boolean, patterns: readonly WeightedPattern[]): boolean | undefined {
    for (const pattern of patterns) {
      const matched = this.match(candidate, isDirectory, pattern);
      if (matched !== false) return matched;
    }
    return false;
  }
}

function stripWin32DevicePrefix(p: string): string {
  if (!IS_WIN) return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

function comparablePath(p: string): string {
  const stripped = stripWin32DevicePrefix(p);
  return IS_WIN ? stripped.toLowerCase() : stripped;
}

function comparableToken(token: string): string {
  return IS_WIN ? token.toLowerCase() : token;
}

function isStrictlyInside(canonicalRoot: string, target: string): boolean {
  const rootCmp = comparablePath(canonicalRoot);
  const targetCmp = comparablePath(target);
  const boundary = rootCmp.endsWith(path.sep) ? rootCmp : rootCmp + path.sep;
  return targetCmp.startsWith(boundary);
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isGitignoreFileName(name: string): boolean {
  return IS_WIN ? name.toLowerCase() === ".gitignore" : name === ".gitignore";
}

/**
 * Bir dizin adının kapsamlı ignore deseni veya `<dir>/bin/**` kuralı üretiminde
 * glob enjeksiyonu (`*`, `?`) veya yol kaçışı (`..`, `/`, `\`, `\0`) taşımadığını
 * doğrular (SEC-08).
 */
export function isSafeIgnoreDirSegment(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (ch === "*" || ch === "?" || ch === "\0" || ch === "/" || ch === "\\") {
      return false;
    }
  }
  return true;
}

function isSafeRelativeDirPosix(dirPosix: string): boolean {
  if (dirPosix === "") return true;
  return dirPosix.split("/").every((seg) => isSafeIgnoreDirSegment(seg));
}

function isRegularNonSymlinkDirectory(targetPath: string): boolean {
  try {
    const st = lstatSync(targetPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function isVerifiedChildDirectory(absDir: string, canonicalRoot: string): boolean {
  if (!isRegularNonSymlinkDirectory(absDir)) {
    return false;
  }
  try {
    const realDir = stripWin32DevicePrefix(realpathSync(absDir));
    return isStrictlyInside(canonicalRoot, realDir);
  } catch {
    return false;
  }
}

function isRegularNonSymlinkFile(targetPath: string): boolean {
  try {
    const st = lstatSync(targetPath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Tek bir normal (symlink olmayan), `canonicalRoot` içine sarmalanmış dosyayı
 * `O_NOFOLLOW` + `(dev, ino)` eşleşmesiyle en fazla `maxBytes` bayt olacak şekilde
 * salt-okunur okur (CWE-59 + TOCTOU koruması, SEC-07). Koşul sağlanmazsa `null`
 * döner ve fırlatmaz.
 */
function readSafeRegularFileUtf8(
  filePath: string,
  canonicalRoot: string,
  maxBytes: number,
): string | null {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) {
      return null;
    }
    const realFile = stripWin32DevicePrefix(realpathSync(filePath));
    if (!isStrictlyInside(canonicalRoot, realFile)) {
      return null;
    }

    const fd = openSync(filePath, OPEN_READ_NOFOLLOW_FLAGS);
    try {
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile() || fdStat.size > maxBytes) {
        return null;
      }
      if (st.ino !== 0 && (fdStat.dev !== st.dev || fdStat.ino !== st.ino)) {
        return null;
      }
      const buf = Buffer.allocUnsafe(maxBytes + 1);
      let totalRead = 0;
      while (totalRead <= maxBytes) {
        const chunk = readSync(fd, buf, totalRead, maxBytes + 1 - totalRead, totalRead);
        if (chunk === 0) break;
        totalRead += chunk;
      }
      if (totalRead > maxBytes) {
        return null;
      }
      return buf.subarray(0, totalRead).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Entries of `dirPath` sorted by name, each one charged to the directory-entry
 * budget as it is read; undefined once the budget runs out (the partial
 * listing is dropped, so the outcome does not depend on the directory order).
 * An unreadable directory has no entries.
 */
function readSortedDirents(dirPath: string, budget: DiscoveryBudget): Dirent[] | undefined {
  const entries: Dirent[] = [];
  let dir: Dir;
  try {
    dir = opendirSync(dirPath);
  } catch {
    return entries;
  }
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (!budget.chargeDirectoryEntry()) return undefined;
      entries.push(entry);
    }
  } catch {
    return [];
  } finally {
    try {
      dir.closeSync();
    } catch {
      // A close failure of a read-only directory handle is not actionable.
    }
  }
  return entries.sort((a, b) => compareLex(a.name, b.name));
}

function scopeNestedPattern(
  subDirPosix: string,
  body: string,
  hasLeadingSlash: boolean,
  dirOnly: boolean,
): string | null {
  if (!isSafeRelativeDirPosix(subDirPosix)) {
    return null;
  }
  if (body === "**") {
    return `${subDirPosix}/**`;
  }
  const hasInternalSlash = body.includes("/");
  const isAnchored = hasLeadingSlash || hasInternalSlash;
  if (isAnchored) {
    if (dirOnly) {
      return body.endsWith("/**") ? `${subDirPosix}/${body}` : `${subDirPosix}/${body}/`;
    }
    return `${subDirPosix}/${body}`;
  }
  if (dirOnly) {
    return `${subDirPosix}/**/${body}/`;
  }
  return `${subDirPosix}/**/${body}`;
}

function hasWildcardChars(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function countWildcards(pattern: string): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" || ch === "?") {
      count += 1;
    }
  }
  return count;
}

function collapseConsecutiveGlobstars(posixPattern: string): string {
  const parts = posixPattern.split("/");
  const collapsed: string[] = [];
  for (const part of parts) {
    if (part === "**" && collapsed[collapsed.length - 1] === "**") {
      continue;
    }
    collapsed.push(part);
  }
  return collapsed.join("/");
}

function countGlobstarSegments(posixPattern: string): number {
  let count = 0;
  for (const seg of posixPattern.split("/")) {
    if (seg === "**") count += 1;
  }
  return count;
}

interface NegatedTarget {
  readonly targetPath: string;
  readonly isDir: boolean;
  readonly ancestors: readonly string[];
  readonly negPattern: WeightedPattern;
  readonly hasWildcard: boolean;
}

/**
 * True when the entry could ignore the negated target (or one of its
 * ancestors), or when the match budget ran out before that was settled (the
 * entry is then dropped like a conflicting one; the caller stops the parse).
 */
function wouldOverIgnoreNegatedTarget(
  localPattern: WeightedPattern,
  body: string,
  dirOnly: boolean,
  target: NegatedTarget,
  budget: DiscoveryBudget,
): boolean {
  for (const ancestor of target.ancestors) {
    if (budget.match(ancestor, true, localPattern) !== false) {
      return true;
    }
  }
  if (budget.match(target.targetPath, target.isDir, localPattern) !== false) {
    return true;
  }
  if (target.hasWildcard || target.isDir) {
    if (budget.match(body, dirOnly, target.negPattern) !== false) {
      return true;
    }
    const bodySegments = body.split("/").filter((s) => s.length > 0);
    const maxAnc = Math.min(bodySegments.length - 1, MAX_NEGATED_ANCESTOR_DEPTH);
    for (let i = 1; i <= maxAnc; i += 1) {
      const anc = bodySegments.slice(0, i).join("/");
      if (budget.match(anc, true, target.negPattern) !== false) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Tek bir `.gitignore` veya `.git/info/exclude` dosyasının metnini negasyon-güvenli,
 * satır/joker/derinlik tavanlı ve deterministik biçimde ayrıştırır.
 * `subDirPosix === ""` ise kök seviyesinde tutar; aksi hâlde her deseni
 * `<subDirPosix>` altına kapsamlandırır.
 * Every negation-conflict match is charged to `budget`; once it runs out the
 * parse stops and returns the patterns accepted before that point.
 */
function parseSafeIgnoreFileContent(
  raw: string,
  subDirPosix: string,
  maxPatterns: number,
  budget: DiscoveryBudget,
): string[] {
  if (maxPatterns <= 0 || budget.exhausted) {
    return [];
  }
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  const lineLimit = Math.min(lines.length, MAX_LINES_PER_IGNORE_FILE);

  const negatedPrefixes = new Set<string>();
  const seenNegatedPatterns = new Set<string>();
  const negatedTargets: NegatedTarget[] = [];
  let negatedTargetsOverflowed = false;
  const rawEntries: string[] = [];

  for (let lineIdx = 0; lineIdx < lineLimit; lineIdx += 1) {
    const rawLine = lines[lineIdx];
    if (rawLine === undefined) continue;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.includes("\0")) {
      continue;
    }
    if (trimmed.startsWith("!")) {
      const rawNeg = collapseConsecutiveGlobstars(
        trimmed.slice(1).split("\\").join("/").replace(/\/{2,}/g, "/"),
      );
      const isDir = rawNeg.endsWith("/");
      const cleaned = rawNeg.replace(/^\/+/, "").replace(/\/+$/, "");
      if (cleaned.length > 0 && cleaned.length <= MAX_PATTERN_LENGTH) {
        const segments = cleaned.split("/").filter((s) => s.length > 0);
        const ancestors: string[] = [];
        const maxPrefixSegs = Math.min(segments.length, MAX_NEGATED_ANCESTOR_DEPTH);
        for (let i = 1; i <= maxPrefixSegs; i += 1) {
          const prefix = segments.slice(0, i).join("/");
          negatedPrefixes.add(comparableToken(prefix));
          if (i < segments.length) {
            ancestors.push(prefix);
          }
        }
        negatedPrefixes.add(comparableToken(cleaned));

        const negKey = comparableToken(rawNeg);
        if (!seenNegatedPatterns.has(negKey)) {
          seenNegatedPatterns.add(negKey);
          const negHasWildcard = hasWildcardChars(rawNeg);
          if (
            negHasWildcard &&
            (countWildcards(rawNeg) > MAX_WILDCARDS_PER_PATTERN ||
              countGlobstarSegments(rawNeg) > MAX_GLOBSTAR_SEGMENTS)
          ) {
            negatedTargetsOverflowed = true;
          } else if (negatedTargets.length < MAX_NEGATED_MATCH_TARGETS) {
            negatedTargets.push({
              targetPath: cleaned,
              isDir,
              ancestors,
              negPattern: { pattern: rawNeg, weight: patternMatchWeight(rawNeg) },
              hasWildcard: negHasWildcard,
            });
          } else {
            negatedTargetsOverflowed = true;
          }
        }
      }
      continue;
    }
    rawEntries.push(trimmed);
  }

  const patterns: string[] = [];
  const seen = new Set<string>();
  const seenNormalizedEntries = new Set<string>();

  for (const entry of rawEntries) {
    if (patterns.length >= maxPatterns) {
      break;
    }
    if (entry.length > MAX_PATTERN_LENGTH) {
      continue;
    }
    const posix = collapseConsecutiveGlobstars(
      entry.split("\\").join("/").replace(/\/{2,}/g, "/"),
    );
    // Yinelenen ham satırları negasyon/joker denetiminden ÖNCE O(1) ele (SEC-05).
    if (seenNormalizedEntries.has(posix)) {
      continue;
    }
    seenNormalizedEntries.add(posix);

    if (
      countGlobstarSegments(posix) > MAX_GLOBSTAR_SEGMENTS ||
      countWildcards(posix) > MAX_WILDCARDS_PER_PATTERN
    ) {
      continue;
    }
    const hasLeadingSlash = posix.startsWith("/");
    const dirOnly = posix.endsWith("/");
    const stripped = posix.replace(/^\/+/, "");
    const body = stripped.replace(/\/+$/, "");

    if (body.length === 0 || body === ".") {
      continue;
    }
    if (subDirPosix !== "" && body.split("/").some((seg) => seg === "..")) {
      continue;
    }

    if (negatedPrefixes.size > 0) {
      if (body === "*" || body === "**" || body === "**/*") {
        continue;
      }
      if (negatedTargetsOverflowed && hasWildcardChars(posix)) {
        continue;
      }
      const baseTarget = body.endsWith("/**")
        ? body.slice(0, -3)
        : body.endsWith("/*")
          ? body.slice(0, -2)
          : body;
      if (baseTarget.length > 0 && negatedPrefixes.has(comparableToken(baseTarget))) {
        continue;
      }
      const firstSeg = stripped.split("/")[0]?.trim() ?? "";
      if (
        firstSeg.length > 0 &&
        negatedPrefixes.has(comparableToken(firstSeg)) &&
        (stripped === firstSeg ||
          stripped === `${firstSeg}/` ||
          stripped === `${firstSeg}/*` ||
          stripped === `${firstSeg}/**`)
      ) {
        continue;
      }
      const localPattern: WeightedPattern = { pattern: posix, weight: patternMatchWeight(posix) };
      let conflictsWithNegation = false;
      for (const target of negatedTargets) {
        if (wouldOverIgnoreNegatedTarget(localPattern, body, dirOnly, target, budget)) {
          conflictsWithNegation = true;
          break;
        }
      }
      if (budget.exhausted) {
        break;
      }
      if (conflictsWithNegation) {
        continue;
      }
    }

    const scoped =
      subDirPosix === ""
        ? posix
        : scopeNestedPattern(subDirPosix, body, hasLeadingSlash, dirOnly);
    if (scoped === null) {
      continue;
    }
    const finalPattern = collapseConsecutiveGlobstars(scoped);
    if (
      finalPattern.length > MAX_PATTERN_LENGTH ||
      countGlobstarSegments(finalPattern) > MAX_GLOBSTAR_SEGMENTS ||
      countWildcards(finalPattern) > MAX_WILDCARDS_PER_PATTERN
    ) {
      continue;
    }
    if (!seen.has(finalPattern)) {
      seen.add(finalPattern);
      patterns.push(finalPattern);
    }
  }

  return patterns;
}

function readGitInfoExclude(canonicalRoot: string, maxPatterns: number, budget: DiscoveryBudget): string[] {
  const gitDir = path.join(canonicalRoot, ".git");
  if (!isVerifiedChildDirectory(gitDir, canonicalRoot)) {
    return [];
  }
  const infoDir = path.join(gitDir, "info");
  if (!isVerifiedChildDirectory(infoDir, canonicalRoot)) {
    return [];
  }
  const excludeFile = path.join(infoDir, "exclude");
  const content = readSafeRegularFileUtf8(excludeFile, canonicalRoot, MAX_IGNORE_FILE_BYTES);
  if (content === null) {
    return [];
  }
  return parseSafeIgnoreFileContent(content, "", maxPatterns, budget);
}

interface WalkQueueItem {
  readonly absDir: string;
  readonly relPosix: string;
  readonly depth: number;
}

/**
 * .NET project directories of the bounded scan. It stops early when a total
 * budget runs out; the caller then does not apply the incomplete result.
 */
function scanDotnetProjectDirs(
  canonicalRoot: string,
  prunePatterns: readonly WeightedPattern[],
  budget: DiscoveryBudget,
): string[] {
  const foundDirs = new Set<string>();
  const queue: WalkQueueItem[] = [{ absDir: canonicalRoot, relPosix: "", depth: 0 }];
  let head = 0;
  let visitedDirs = 0;

  while (head < queue.length && !budget.exhausted) {
    const current = queue[head] as WalkQueueItem;
    head += 1;
    visitedDirs += 1;
    if (visitedDirs > MAX_CSPROJ_SCAN_DIRS) {
      break;
    }
    if (current.depth > 0 && !isVerifiedChildDirectory(current.absDir, canonicalRoot)) {
      continue;
    }

    const dirents = readSortedDirents(current.absDir, budget);
    if (dirents === undefined) break;
    let hasProjectFile = false;

    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isFile() && !hasProjectFile && DOTNET_PROJECT_FILE_RE.test(dirent.name)) {
        const candidateFile = path.join(current.absDir, dirent.name);
        if (isRegularNonSymlinkFile(candidateFile)) {
          hasProjectFile = true;
          foundDirs.add(current.relPosix);
        }
        continue;
      }
      if (
        current.depth < MAX_CSPROJ_SCAN_DEPTH &&
        dirent.isDirectory() &&
        queue.length < MAX_CSPROJ_SCAN_DIRS
      ) {
        if (!isSafeIgnoreDirSegment(dirent.name)) {
          continue;
        }
        const childAbs = path.join(current.absDir, dirent.name);
        if (!isRegularNonSymlinkDirectory(childAbs)) {
          continue;
        }
        const childRelPosix =
          current.relPosix === "" ? dirent.name : `${current.relPosix}/${dirent.name}`;
        const pruned = budget.matchesAny(childRelPosix, true, prunePatterns);
        if (pruned === undefined) {
          break;
        }
        if (pruned) {
          continue;
        }
        queue.push({
          absDir: childAbs,
          relPosix: childRelPosix,
          depth: current.depth + 1,
        });
      }
    }
  }

  return [...foundDirs].sort(compareLex);
}

function buildRefinedDefaultIgnore(dotnetProjectDirs: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (pattern: string): boolean => {
    if (!seen.has(pattern)) {
      seen.add(pattern);
      result.push(pattern);
      return true;
    }
    return false;
  };

  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    if (pattern === "**/bin/**") {
      for (const smartSubdir of SMART_BIN_SUBDIR_PATTERNS) {
        pushUnique(smartSubdir);
      }
      let csprojBinCount = 0;
      for (const dirPosix of dotnetProjectDirs) {
        if (csprojBinCount >= MAX_CSPROJ_BIN_PATTERNS) {
          break;
        }
        if (!isSafeRelativeDirPosix(dirPosix)) {
          continue;
        }
        const rule = dirPosix === "" ? "bin/**" : `${dirPosix}/bin/**`;
        if (pushUnique(rule)) {
          csprojBinCount += 1;
        }
      }
      continue;
    }
    pushUnique(pattern);
  }

  return result;
}

function appendCappedUnique(
  target: string[],
  seen: Set<string>,
  incoming: readonly string[],
  cap: number,
): void {
  for (const pattern of incoming) {
    if (target.length >= cap) break;
    if (!seen.has(pattern)) {
      seen.add(pattern);
      target.push(pattern);
    }
  }
}

function collectNestedGitignorePatterns(
  canonicalRoot: string,
  extraIgnore: string[],
  seenExtra: Set<string>,
  initialPrunePatterns: readonly string[],
  budget: DiscoveryBudget,
): void {
  if (extraIgnore.length >= MAX_DISCOVERED_IGNORE_PATTERNS) {
    return;
  }

  const prunePatterns: WeightedPattern[] = weighPatterns(initialPrunePatterns);
  const pruneSeen = new Set<string>(initialPrunePatterns);
  const queue: WalkQueueItem[] = [{ absDir: canonicalRoot, relPosix: "", depth: 0 }];
  const maxQueueSize = MAX_NESTED_WALK_DIRS + 1;
  let head = 0;
  let visitedDirs = 0;
  let nestedFilesRead = 0;

  while (head < queue.length && !budget.exhausted) {
    if (
      nestedFilesRead >= MAX_NESTED_GITIGNORE_FILES ||
      extraIgnore.length >= MAX_DISCOVERED_IGNORE_PATTERNS
    ) {
      break;
    }

    const current = queue[head] as WalkQueueItem;
    head += 1;
    if (current.depth > 0) {
      visitedDirs += 1;
      if (visitedDirs > MAX_NESTED_WALK_DIRS) {
        break;
      }
      if (!isVerifiedChildDirectory(current.absDir, canonicalRoot)) {
        continue;
      }
    }

    const dirents = readSortedDirents(current.absDir, budget);
    if (dirents === undefined) {
      break;
    }

    if (current.depth > 0) {
      const gitignoreEntry = dirents.find(
        (d) => !d.isSymbolicLink() && d.isFile() && isGitignoreFileName(d.name),
      );
      if (gitignoreEntry !== undefined) {
        const content = readSafeRegularFileUtf8(
          path.join(current.absDir, gitignoreEntry.name),
          canonicalRoot,
          MAX_IGNORE_FILE_BYTES,
        );
        if (content !== null) {
          nestedFilesRead += 1;
          const remaining = MAX_DISCOVERED_IGNORE_PATTERNS - extraIgnore.length;
          const scopedPatterns = parseSafeIgnoreFileContent(content, current.relPosix, remaining, budget);
          appendCappedUnique(
            extraIgnore,
            seenExtra,
            scopedPatterns,
            MAX_DISCOVERED_IGNORE_PATTERNS,
          );
          for (const p of scopedPatterns) {
            if (!pruneSeen.has(p)) {
              pruneSeen.add(p);
              prunePatterns.push({ pattern: p, weight: patternMatchWeight(p) });
            }
          }
          if (
            budget.exhausted ||
            nestedFilesRead >= MAX_NESTED_GITIGNORE_FILES ||
            extraIgnore.length >= MAX_DISCOVERED_IGNORE_PATTERNS
          ) {
            break;
          }
        }
      }
    }

    if (current.depth < MAX_NESTED_GITIGNORE_DEPTH && queue.length < maxQueueSize) {
      for (const dirent of dirents) {
        if (queue.length >= maxQueueSize) {
          break;
        }
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) {
          continue;
        }
        if (!isSafeIgnoreDirSegment(dirent.name)) {
          continue;
        }
        const childAbs = path.join(current.absDir, dirent.name);
        if (!isRegularNonSymlinkDirectory(childAbs)) {
          continue;
        }
        const childRelPosix =
          current.relPosix === "" ? dirent.name : `${current.relPosix}/${dirent.name}`;
        const pruned = budget.matchesAny(childRelPosix, true, prunePatterns);
        if (pruned === undefined) {
          return;
        }
        if (pruned) {
          continue;
        }
        queue.push({
          absDir: childAbs,
          relPosix: childRelPosix,
          depth: current.depth + 1,
        });
      }
    }
  }
}

/**
 * Yetkili bir çalışma alanı kökünden deterministik, salt-okunur ve CWE-59 güvenli
 * ignore yapılandırması keşfeder (kök `.gitignore`, `.git/info/exclude`, sınırlı
 * iç içe `.gitignore` ve isteğe bağlı akıllı `bin/` ayrımı).
 */
export function discoverWorkspaceIgnoreConfig(
  rootDir: string,
  options: WorkspaceIgnoreDiscoveryOptions = {},
): WorkspaceIgnoreDiscoveryResult {
  let canonicalRoot: string;
  try {
    canonicalRoot = stripWin32DevicePrefix(realpathSync(path.resolve(rootDir)));
    if (!statSync(canonicalRoot).isDirectory()) {
      return { extraIgnore: [] };
    }
  } catch {
    return { extraIgnore: [] };
  }

  const extraIgnore: string[] = [];
  const seenExtra = new Set<string>();
  const budget = new DiscoveryBudget(options.budgets);

  // Kaynak 1: Kök .gitignore
  const rootGitignoreRaw = readSafeRegularFileUtf8(
    path.join(canonicalRoot, ".gitignore"),
    canonicalRoot,
    MAX_IGNORE_FILE_BYTES,
  );
  if (rootGitignoreRaw !== null) {
    appendCappedUnique(
      extraIgnore,
      seenExtra,
      parseSafeIgnoreFileContent(rootGitignoreRaw, "", MAX_DISCOVERED_IGNORE_PATTERNS, budget),
      MAX_DISCOVERED_IGNORE_PATTERNS,
    );
  }

  // Kaynak 2: .git/info/exclude (yalnızca .git gerçek non-symlink dizinse)
  if (extraIgnore.length < MAX_DISCOVERED_IGNORE_PATTERNS && !budget.exhausted) {
    appendCappedUnique(
      extraIgnore,
      seenExtra,
      readGitInfoExclude(canonicalRoot, MAX_DISCOVERED_IGNORE_PATTERNS - extraIgnore.length, budget),
      MAX_DISCOVERED_IGNORE_PATTERNS,
    );
  }

  // Kaynak 4: Akıllı bin/ ayrımı (yalnızca açık ignore verilmediğinde). The
  // refinement replaces `**/bin/**` as a whole, so it is applied only when
  // the scan completed within the budgets; otherwise the defaults stay.
  let refinedDefaultIgnore: readonly string[] | undefined;
  if (options.hasExplicitIgnore !== true && !budget.exhausted) {
    const csprojPrunePatterns = weighPatterns([...DEFAULT_IGNORE_PATTERNS, ...extraIgnore]);
    const dotnetProjectDirs = scanDotnetProjectDirs(canonicalRoot, csprojPrunePatterns, budget);
    if (!budget.exhausted) {
      refinedDefaultIgnore = buildRefinedDefaultIgnore(dotnetProjectDirs);
    }
  }

  // Kaynak 3: İç içe (nested) .gitignore yürüyüşü
  if (!budget.exhausted) {
    const nestedPruneBase = refinedDefaultIgnore ?? DEFAULT_IGNORE_PATTERNS;
    collectNestedGitignorePatterns(
      canonicalRoot,
      extraIgnore,
      seenExtra,
      [...nestedPruneBase, ...extraIgnore],
      budget,
    );
  }

  return {
    extraIgnore,
    ...(refinedDefaultIgnore !== undefined ? { refinedDefaultIgnore } : {}),
    ...(budget.limitReached !== undefined ? { limitReached: budget.limitReached } : {}),
  };
}
