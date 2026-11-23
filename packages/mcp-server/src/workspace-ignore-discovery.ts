import { Buffer } from "node:buffer";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

import {
  DEFAULT_IGNORE_PATTERNS,
  findMatchingIgnorePattern,
  matchesIgnorePattern,
} from "@causoryn/workspace";

// Causoryn v0.2.3 — Modüler, salt-okunur, deterministik workspace ignore keşfi
// ve akıllı `bin/` ayrımı (AC-3, AC-4).
//
// Kaynaklar (deterministik birleştirme sırası):
//   1. Kök `.gitignore` (negasyon-güvenli, symlink yok, <= 256 KB)
//   2. `.git/info/exclude` (yalnızca `.git` gerçek non-symlink dizinse; CWE-59)
//   3. İç içe (nested) `.gitignore` dosyaları (sınırlı BFS yürüyüşü:
//      derinlik <= 6, en fazla 64 dosya, en fazla 4.000 dizin, her desen kendi
//      alt dizinine kapsamlandırılır, dosya-bazlı negasyon-güvenli)
//   4. Akıllı `bin/` ayrımı (yalnızca çağıran açık `ignore` vermediğinde):
//      TŞ §20 `DEFAULT_IGNORE_PATTERNS` dokunulmadan, auto-config içinde kaba
//      `**/bin/**` yerine `**/bin/{Debug,Release,x64,x86,AnyCPU}/**` ve derinlik
//      <= 4 sınırlı taramada bulunan `.csproj`/`.fsproj`/`.vbproj` dizinlerinin
//      `<dir>/bin/**` desenleri konur; böylece Node (`bin/cli.ts`) ve Rust
//      (`src/bin/main.rs`) kaynakları gizlenmez.

export const MAX_IGNORE_FILE_BYTES = 256 * 1024;
export const MAX_NESTED_GITIGNORE_DEPTH = 6;
export const MAX_NESTED_GITIGNORE_FILES = 64;
export const MAX_NESTED_WALK_DIRS = 4_000;
export const MAX_DISCOVERED_IGNORE_PATTERNS = 1_000;
export const MAX_CSPROJ_SCAN_DEPTH = 4;
export const MAX_CSPROJ_SCAN_DIRS = 2_000;

const MAX_NEGATED_MATCH_TARGETS = 64;
const MAX_PATTERN_LENGTH = 512;
const MAX_GLOBSTAR_SEGMENTS = 4;
const IS_WIN = process.platform === "win32";
const DOTNET_PROJECT_FILE_RE = /\.(?:csproj|fsproj|vbproj)$/i;

const SMART_BIN_SUBDIR_PATTERNS: readonly string[] = [
  "**/bin/Debug/**",
  "**/bin/Release/**",
  "**/bin/x64/**",
  "**/bin/x86/**",
  "**/bin/AnyCPU/**",
];

export interface WorkspaceIgnoreDiscoveryOptions {
  readonly hasExplicitIgnore?: boolean;
}

export interface WorkspaceIgnoreDiscoveryResult {
  readonly extraIgnore: readonly string[];
  readonly refinedDefaultIgnore?: readonly string[];
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

function isRegularNonSymlinkDirectory(targetPath: string): boolean {
  try {
    const st = lstatSync(targetPath);
    return !st.isSymbolicLink() && st.isDirectory();
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
 * en fazla `maxBytes` bayt olacak şekilde salt-okunur okur (CWE-59 + TOCTOU
 * boyut koruması). Koşul sağlanmazsa `null` döner ve fırlatmaz.
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

    const fd = openSync(realFile, "r");
    try {
      const fdStat = fstatSync(fd);
      if (!fdStat.isFile() || fdStat.size > maxBytes) {
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

function readSortedDirents(dirPath: string): Dirent[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => compareLex(a.name, b.name));
  } catch {
    return [];
  }
}

function scopeNestedPattern(
  subDirPosix: string,
  body: string,
  hasLeadingSlash: boolean,
  dirOnly: boolean,
): string {
  if (body === "**") {
    return `${subDirPosix}/**`;
  }
  const hasInternalSlash = body.includes("/");
  const isAnchored = hasLeadingSlash || hasInternalSlash;
  if (isAnchored) {
    if (dirOnly) {
      return body.endsWith("/**") ? `${subDirPosix}/${body}` : `${subDirPosix}/${body}/**`;
    }
    return `${subDirPosix}/${body}`;
  }
  if (dirOnly) {
    return `${subDirPosix}/**/${body}/**`;
  }
  return `${subDirPosix}/**/${body}`;
}

interface NegatedTarget {
  readonly targetPath: string;
  readonly isDir: boolean;
  readonly ancestors: readonly string[];
}

function wouldOverIgnoreNegatedTarget(
  rawLocalPattern: string,
  target: NegatedTarget,
): boolean {
  for (const ancestor of target.ancestors) {
    if (matchesIgnorePattern(ancestor, true, rawLocalPattern)) {
      return true;
    }
  }
  return matchesIgnorePattern(target.targetPath, target.isDir, rawLocalPattern);
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

/**
 * Tek bir `.gitignore` veya `.git/info/exclude` dosyasının metnini negasyon-güvenli
 * ve deterministik biçimde ayrıştırır. `subDirPosix === ""` ise kök seviyesinde
 * tutar; aksi hâlde her deseni `<subDirPosix>` altına kapsamlandırır.
 */
function parseSafeIgnoreFileContent(
  raw: string,
  subDirPosix: string,
  maxPatterns: number,
): string[] {
  if (maxPatterns <= 0) {
    return [];
  }
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  const negatedPrefixes = new Set<string>();
  const negatedTargets: NegatedTarget[] = [];
  const rawEntries: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.includes("\0")) {
      continue;
    }
    if (trimmed.startsWith("!")) {
      const rawNeg = trimmed.slice(1).split("\\").join("/");
      const isDir = rawNeg.endsWith("/");
      const cleaned = rawNeg.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
      if (cleaned.length > 0 && cleaned.length <= MAX_PATTERN_LENGTH) {
        const segments = cleaned.split("/").filter((s) => s.length > 0);
        const ancestors: string[] = [];
        for (let i = 1; i <= segments.length; i += 1) {
          const prefix = segments.slice(0, i).join("/");
          negatedPrefixes.add(comparableToken(prefix));
          if (i < segments.length) {
            ancestors.push(prefix);
          }
        }
        if (negatedTargets.length < MAX_NEGATED_MATCH_TARGETS) {
          negatedTargets.push({ targetPath: cleaned, isDir, ancestors });
        }
      }
      continue;
    }
    rawEntries.push(trimmed);
  }

  const patterns: string[] = [];
  const seen = new Set<string>();

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
    if (countGlobstarSegments(posix) > MAX_GLOBSTAR_SEGMENTS) {
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
      let conflictsWithNegation = false;
      for (const target of negatedTargets) {
        if (wouldOverIgnoreNegatedTarget(posix, target)) {
          conflictsWithNegation = true;
          break;
        }
      }
      if (conflictsWithNegation) {
        continue;
      }
    }

    const finalPattern =
      subDirPosix === ""
        ? posix
        : collapseConsecutiveGlobstars(
            scopeNestedPattern(subDirPosix, body, hasLeadingSlash, dirOnly),
          );
    if (
      finalPattern.length > MAX_PATTERN_LENGTH ||
      countGlobstarSegments(finalPattern) > MAX_GLOBSTAR_SEGMENTS
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

function readGitInfoExclude(canonicalRoot: string, maxPatterns: number): string[] {
  const gitDir = path.join(canonicalRoot, ".git");
  if (!isRegularNonSymlinkDirectory(gitDir)) {
    return [];
  }
  const infoDir = path.join(gitDir, "info");
  if (!isRegularNonSymlinkDirectory(infoDir)) {
    return [];
  }
  const excludeFile = path.join(infoDir, "exclude");
  const content = readSafeRegularFileUtf8(excludeFile, canonicalRoot, MAX_IGNORE_FILE_BYTES);
  if (content === null) {
    return [];
  }
  return parseSafeIgnoreFileContent(content, "", maxPatterns);
}

interface WalkQueueItem {
  readonly absDir: string;
  readonly relPosix: string;
  readonly depth: number;
}

function scanDotnetProjectDirs(
  canonicalRoot: string,
  prunePatterns: readonly string[],
): string[] {
  const foundDirs = new Set<string>();
  const queue: WalkQueueItem[] = [{ absDir: canonicalRoot, relPosix: "", depth: 0 }];
  let head = 0;
  let visitedDirs = 0;

  while (head < queue.length) {
    const current = queue[head] as WalkQueueItem;
    head += 1;
    visitedDirs += 1;
    if (visitedDirs > MAX_CSPROJ_SCAN_DIRS) {
      break;
    }

    const dirents = readSortedDirents(current.absDir);
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
      if (current.depth < MAX_CSPROJ_SCAN_DEPTH && dirent.isDirectory()) {
        const childAbs = path.join(current.absDir, dirent.name);
        if (!isRegularNonSymlinkDirectory(childAbs)) {
          continue;
        }
        const childRelPosix =
          current.relPosix === "" ? dirent.name : `${current.relPosix}/${dirent.name}`;
        if (findMatchingIgnorePattern(childRelPosix, true, prunePatterns) !== undefined) {
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
  const pushUnique = (pattern: string): void => {
    if (!seen.has(pattern)) {
      seen.add(pattern);
      result.push(pattern);
    }
  };

  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    if (pattern === "**/bin/**") {
      for (const smartSubdir of SMART_BIN_SUBDIR_PATTERNS) {
        pushUnique(smartSubdir);
      }
      for (const dirPosix of dotnetProjectDirs) {
        pushUnique(dirPosix === "" ? "bin/**" : `${dirPosix}/bin/**`);
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
): void {
  if (extraIgnore.length >= MAX_DISCOVERED_IGNORE_PATTERNS) {
    return;
  }

  const prunePatterns: string[] = [...initialPrunePatterns];
  const pruneSeen = new Set<string>(prunePatterns);
  const queue: WalkQueueItem[] = [{ absDir: canonicalRoot, relPosix: "", depth: 0 }];
  let head = 0;
  let visitedDirs = 0;
  let nestedFilesRead = 0;

  while (head < queue.length) {
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
    }

    const dirents = readSortedDirents(current.absDir);

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
          const scopedPatterns = parseSafeIgnoreFileContent(content, current.relPosix, remaining);
          appendCappedUnique(
            extraIgnore,
            seenExtra,
            scopedPatterns,
            MAX_DISCOVERED_IGNORE_PATTERNS,
          );
          for (const p of scopedPatterns) {
            if (!pruneSeen.has(p)) {
              pruneSeen.add(p);
              prunePatterns.push(p);
            }
          }
          if (
            nestedFilesRead >= MAX_NESTED_GITIGNORE_FILES ||
            extraIgnore.length >= MAX_DISCOVERED_IGNORE_PATTERNS
          ) {
            break;
          }
        }
      }
    }

    if (current.depth < MAX_NESTED_GITIGNORE_DEPTH) {
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) {
          continue;
        }
        const childAbs = path.join(current.absDir, dirent.name);
        if (!isRegularNonSymlinkDirectory(childAbs)) {
          continue;
        }
        const childRelPosix =
          current.relPosix === "" ? dirent.name : `${current.relPosix}/${dirent.name}`;
        if (findMatchingIgnorePattern(childRelPosix, true, prunePatterns) !== undefined) {
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
      parseSafeIgnoreFileContent(rootGitignoreRaw, "", MAX_DISCOVERED_IGNORE_PATTERNS),
      MAX_DISCOVERED_IGNORE_PATTERNS,
    );
  }

  // Kaynak 2: .git/info/exclude (yalnızca .git gerçek non-symlink dizinse)
  if (extraIgnore.length < MAX_DISCOVERED_IGNORE_PATTERNS) {
    appendCappedUnique(
      extraIgnore,
      seenExtra,
      readGitInfoExclude(canonicalRoot, MAX_DISCOVERED_IGNORE_PATTERNS - extraIgnore.length),
      MAX_DISCOVERED_IGNORE_PATTERNS,
    );
  }

  // Kaynak 4: Akıllı bin/ ayrımı (yalnızca açık ignore verilmediğinde)
  let refinedDefaultIgnore: readonly string[] | undefined;
  if (options.hasExplicitIgnore !== true) {
    const csprojPrunePatterns: readonly string[] = [...DEFAULT_IGNORE_PATTERNS, ...extraIgnore];
    const dotnetProjectDirs = scanDotnetProjectDirs(canonicalRoot, csprojPrunePatterns);
    refinedDefaultIgnore = buildRefinedDefaultIgnore(dotnetProjectDirs);
  }

  // Kaynak 3: İç içe (nested) .gitignore yürüyüşü
  const nestedPruneBase = refinedDefaultIgnore ?? DEFAULT_IGNORE_PATTERNS;
  collectNestedGitignorePatterns(
    canonicalRoot,
    extraIgnore,
    seenExtra,
    [...nestedPruneBase, ...extraIgnore],
  );

  return refinedDefaultIgnore !== undefined
    ? { extraIgnore, refinedDefaultIgnore }
    : { extraIgnore };
}
