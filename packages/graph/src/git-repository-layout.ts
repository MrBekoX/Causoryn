/**
 * Repository layout validation for git-read: decides, BEFORE git is started,
 * which git directory a read at the analyzed root may use.
 *
 * Accepted layouts:
 * - `<root>/.git` is a directory (a regular checkout).
 * - `<root>/.git` is a gitdir pointer file whose target lies inside the root
 *   (e.g. `git init --separate-git-dir` into the root).
 * - `<root>/.git` points outside the root to a linked worktree git directory
 *   (`<common>/worktrees/<name>`) whose `gitdir` back-pointer names exactly
 *   this `<root>/.git` and whose `commondir` resolves to `<common>`.
 * - `<root>/.git` points outside the root to a submodule git directory whose
 *   `core.worktree` resolves exactly to this root.
 *
 * Refused before git starts:
 * - a `.git` entry that is a symbolic link or junction (not followed),
 * - a gitdir pointer, `commondir`, alternates entry (nested alternates
 *   included), config include path (`include.path`, `includeIf.*.path`,
 *   nested includes included) or `core.worktree` that names a network (UNC)
 *   or device path (`\\host\share`, `//host/share`, `\\?\`, `\\.\`, `\??\`),
 * - any symbolic link on the way to those targets, or at fixed git directory
 *   entries (HEAD, config, refs, objects, packed-refs, ...), whose target is
 *   such a path,
 * - any other gitdir pointer that leaves the root.
 *
 * Upward discovery is blocked separately by git-read (GIT_CEILING_DIRECTORIES
 * set to the parent of the root); a root without a `.git` entry is reported
 * as "not a git repository" without starting git.
 *
 * Only metadata is read here (bounded, no writes, no commands). Paths are
 * resolved component by component with lstat/readlink, so a link that points
 * to a network path is detected from its text and never opened.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { GraphRepositoryError } from "./errors.js";

export type RepositoryLayoutKind =
  | "git-directory"
  | "gitfile-within-root"
  | "linked-worktree"
  | "submodule";

export interface RepositoryLayout {
  readonly kind: RepositoryLayoutKind;
  /** Canonical analyzed root. */
  readonly root: string;
  /** Canonical git directory git will use for the root. */
  readonly gitDir: string;
  /** Canonical common directory (objects, refs, config). */
  readonly commonDir: string;
}

const MAX_POINTER_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ALTERNATES_BYTES = 1024 * 1024;
const MAX_LINK_HOPS = 32;
/** git follows at most 5 levels of alternates (sha1-file.c / odb.c). */
const MAX_ALTERNATE_DEPTH = 5;
/** git's include depth limit is 10 (config.c MAX_INCLUDE_DEPTH). */
const MAX_INCLUDE_DEPTH = 10;
const MAX_SCANNED_FILES = 64;
const READ_CHUNK_BYTES = 64 * 1024;

/** Git directory entries whose links are checked (relative to gitDir / commonDir). */
const GIT_DIR_ENTRIES = ["HEAD", "commondir", "config.worktree", "gitdir"] as const;
const COMMON_DIR_ENTRIES = [
  "config",
  "packed-refs",
  "shallow",
  "refs",
  "refs/heads",
  "refs/tags",
  "refs/remotes",
  "reftable",
  "objects",
  "objects/info",
  "objects/info/alternates",
  "objects/pack",
  "info",
  "info/grafts",
] as const;

const NETWORK_OR_DEVICE_PREFIX = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;

/**
 * True for network (UNC) and device path forms: `\\host\share`,
 * `//host/share`, mixed separators, `\\?\...`, `\\.\...` and the NT object
 * prefix `\??\...` (also with forward slashes). Checked on every platform:
 * the text comes from repository metadata, and Git for Windows treats these
 * forms as remote or device paths.
 */
export function isNetworkOrDevicePath(value: string): boolean {
  return NETWORK_OR_DEVICE_PREFIX.test(value);
}

/** Windows drive-relative form (`C:foo`): resolved against a per-drive cwd. */
function isDriveRelative(value: string): boolean {
  return process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(value);
}

function refusal(root: string, reason: string): GraphRepositoryError {
  return new GraphRepositoryError(
    "compare/repository-refused",
    `Refusing to read the git repository at ${root}: ${reason}. ` +
      "Only the repository at the analyzed root is read: a .git directory, a .git file pointing inside the root, " +
      "or a linked worktree or submodule git directory that points back to the root.",
  );
}

function networkRefusal(root: string, where: string, value: string): GraphRepositoryError {
  return refusal(
    root,
    `${where} names a network or device path (${JSON.stringify(value)}); such paths are never accessed`,
  );
}

/** Lexical containment (both sides absolute; case-insensitive on win32 via path.relative). */
export function isSameOrInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function sameLocation(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

function splitAbsolute(value: string): { readonly root: string; readonly parts: string[] } {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  const parts = resolved
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
  return { root, parts };
}

interface LocalResolution {
  readonly path: string;
  readonly exists: boolean;
}

/**
 * Resolves an absolute path component by component, following only links
 * whose target text is a local path. `bases` are canonical directories known
 * to contain no links; when the target lies inside one, only the components
 * below it are walked. A missing component ends the walk (exists=false).
 */
async function resolveLocal(
  root: string,
  where: string,
  target: string,
  bases: readonly string[],
): Promise<LocalResolution> {
  const absolute = path.resolve(target);
  const base = bases.find((candidate) => isSameOrInside(absolute, candidate));
  let current: string;
  let queue: string[];
  if (base !== undefined) {
    current = base;
    queue = path
      .relative(base, absolute)
      .split(/[\\/]+/)
      .filter((part) => part.length > 0);
  } else {
    const split = splitAbsolute(absolute);
    if (isNetworkOrDevicePath(split.root)) throw networkRefusal(root, where, absolute);
    current = split.root;
    queue = split.parts;
  }
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let entry;
    try {
      entry = await lstat(next);
    } catch {
      return { path: path.join(next, ...queue), exists: false };
    }
    if (!entry.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      throw refusal(root, `${where} passes through too many symbolic links`);
    }
    const linkText = await readlink(next);
    if (isNetworkOrDevicePath(linkText)) {
      throw networkRefusal(root, `a symbolic link on the way to ${where} (${next})`, linkText);
    }
    const split = splitAbsolute(path.resolve(current, linkText));
    if (isNetworkOrDevicePath(split.root)) {
      throw networkRefusal(root, `a symbolic link on the way to ${where} (${next})`, linkText);
    }
    current = split.root;
    queue = [...split.parts, ...queue];
  }
  return { path: current, exists: true };
}

async function canonical(
  root: string,
  where: string,
  target: string,
  bases: readonly string[],
): Promise<string | undefined> {
  const resolved = await resolveLocal(root, where, target, bases);
  if (!resolved.exists) return undefined;
  try {
    return await realpath(resolved.path);
  } catch {
    return undefined;
  }
}

/** Bounded read of a small metadata file at an already link-checked path. */
async function readBounded(
  root: string,
  file: string,
  label: string,
  maxBytes: number,
): Promise<string | undefined> {
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(file, openFlags);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    const hardCap = maxBytes + 1;
    while (total < hardCap) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, hardCap - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw refusal(root, `${label} is larger than the ${String(maxBytes)}-byte limit`);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads a metadata file after resolving its path without network links. */
async function readMetadata(
  root: string,
  file: string,
  label: string,
  maxBytes: number,
  bases: readonly string[],
): Promise<string | undefined> {
  const resolved = await resolveLocal(root, label, file, bases);
  if (!resolved.exists) return undefined;
  return readBounded(root, resolved.path, label, maxBytes);
}

/* ------------------------------------------------------------------ */
/* git config parsing (subset of config.c, fail closed)                */
/* ------------------------------------------------------------------ */

export interface GitConfigEntry {
  /** Lower-cased section name (legacy dotted names kept as written, lower-cased). */
  readonly section: string;
  /** Subsection as written, or null. */
  readonly subsection: string | null;
  /** Lower-cased key. */
  readonly key: string;
  /** Value, or null for a key without '=' (boolean true). */
  readonly value: string | null;
}

function isAlpha(c: string): boolean {
  return /^[A-Za-z]$/.test(c);
}

function isKeyChar(c: string): boolean {
  return /^[A-Za-z0-9-]$/.test(c);
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\v" || c === "\f";
}

/**
 * Parses git config text the way git's config.c does for the parts that
 * matter here: section headers (`[s]`, `[s "sub"]`, `[s.sub]`, entries on the
 * header line), comments, quoting, escapes and line continuations. Returns
 * null on any syntax git itself rejects.
 */
export function parseGitConfig(text: string): GitConfigEntry[] | null {
  const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
  const n = src.length;
  let i = 0;
  const next = (): string => (i < n ? src[i++]! : "\n");
  const atEnd = (): boolean => i >= n;
  let section: string | null = null;
  let subsection: string | null = null;
  const entries: GitConfigEntry[] = [];

  const parseValue = (): string | null => {
    let quote = false;
    let comment = false;
    let trimLength = 0;
    let value = "";
    for (;;) {
      const c = next();
      if (c === "\n") {
        if (quote) return null;
        return trimLength > 0 ? value.slice(0, trimLength) : value;
      }
      if (comment) continue;
      if (isSpace(c) && !quote) {
        if (trimLength === 0) trimLength = value.length;
        if (value.length > 0) value += c;
        continue;
      }
      if (!quote && (c === ";" || c === "#")) {
        comment = true;
        continue;
      }
      if (trimLength > 0) trimLength = 0;
      if (c === "\\") {
        const escaped = next();
        if (escaped === "\n") continue; // line continuation
        if (escaped === "t") value += "\t";
        else if (escaped === "b") value += "\b";
        else if (escaped === "n") value += "\n";
        else if (escaped === "\\" || escaped === '"') value += escaped;
        else return null;
        continue;
      }
      if (c === '"') {
        quote = !quote;
        continue;
      }
      value += c;
    }
  };

  const parseHeader = (): boolean => {
    let name = "";
    for (;;) {
      const c = next();
      if (c === "\n") return false;
      if (c === "]") {
        section = name.toLowerCase();
        subsection = null;
        return name.length > 0;
      }
      if (isSpace(c)) {
        // Extended form: [section "subsection"]
        let d = next();
        while (isSpace(d)) d = next();
        if (d !== '"') return false;
        let sub = "";
        for (;;) {
          let e = next();
          if (e === "\n") return false;
          if (e === '"') break;
          if (e === "\\") {
            e = next();
            if (e === "\n") return false;
          }
          sub += e;
        }
        if (next() !== "]") return false;
        section = name.toLowerCase();
        subsection = sub;
        return name.length > 0;
      }
      if (!/^[A-Za-z0-9.-]$/.test(c)) return false;
      name += c;
    }
  };

  let lineComment = false;
  while (!atEnd()) {
    const c = next();
    if (c === "\n") {
      lineComment = false;
      continue;
    }
    if (lineComment) continue;
    if (isSpace(c)) continue;
    if (c === "#" || c === ";") {
      lineComment = true;
      continue;
    }
    if (c === "[") {
      if (!parseHeader()) return null;
      continue;
    }
    if (!isAlpha(c) || section === null) return null;
    let key = c.toLowerCase();
    let d = next();
    while (isKeyChar(d)) {
      key += d.toLowerCase();
      d = next();
    }
    while (d === " " || d === "\t") d = next();
    if (d === "\n") {
      entries.push({ section, subsection, key, value: null });
      continue;
    }
    if (d !== "=") return null;
    const value = parseValue();
    if (value === null) return null;
    entries.push({ section, subsection, key, value });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* metadata checks                                                     */
/* ------------------------------------------------------------------ */

/** git's gitfile format: "gitdir: <path>" with trailing CR/LF stripped. */
function parseGitfile(content: string): string | undefined {
  if (!content.startsWith("gitdir: ")) return undefined;
  const value = content.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
  if (value.length === 0 || /[\r\n\0]/.test(value)) return undefined;
  return value;
}

function assertLocalPathText(root: string, where: string, value: string): void {
  if (value.includes("\0")) throw refusal(root, `${where} contains a NUL character`);
  if (isNetworkOrDevicePath(value)) throw networkRefusal(root, where, value);
  if (isDriveRelative(value)) {
    throw refusal(root, `${where} uses a drive-relative path (${JSON.stringify(value)})`);
  }
}

/** Minimal C-style unquoting as used by git for quoted alternates entries. */
function unquoteCStyle(value: string): string | null {
  if (!value.startsWith('"')) return value;
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const c = value[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    i += 1;
    const e = value[i];
    if (e === undefined) return null;
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
    };
    if (simple[e] !== undefined) {
      out += simple[e];
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(value.slice(i));
    if (octal === null) return null;
    out += String.fromCharCode(parseInt(octal[0], 8));
    i += 2;
  }
  return null;
}

interface ScanState {
  scannedFiles: number;
}

/** Fails closed when include/alternates files form an unusually large graph. */
function countScannedFile(root: string, state: ScanState): void {
  state.scannedFiles += 1;
  if (state.scannedFiles > MAX_SCANNED_FILES) {
    throw refusal(root, `more than ${String(MAX_SCANNED_FILES)} config include or alternates files would have to be checked`);
  }
}

async function checkAlternates(
  root: string,
  objectsDir: string,
  depth: number,
  bases: readonly string[],
  state: ScanState,
): Promise<void> {
  // git ignores alternates nested deeper than MAX_ALTERNATE_DEPTH.
  if (depth > MAX_ALTERNATE_DEPTH) return;
  countScannedFile(root, state);
  const file = path.join(objectsDir, "info", "alternates");
  const text = await readMetadata(root, file, "objects/info/alternates", MAX_ALTERNATES_BYTES, bases);
  if (text === undefined) return;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const entry = unquoteCStyle(line);
    if (entry === null) throw refusal(root, `objects/info/alternates has a malformed quoted entry`);
    assertLocalPathText(root, "an objects/info/alternates entry", entry);
    const target = path.resolve(objectsDir, entry);
    const resolved = await canonical(root, "an objects/info/alternates entry", target, bases);
    if (resolved !== undefined) {
      await checkAlternates(root, resolved, depth + 1, bases, state);
    }
  }
}

async function readConfigEntries(
  root: string,
  file: string,
  label: string,
  bases: readonly string[],
): Promise<{ readonly file: string; readonly entries: GitConfigEntry[] } | undefined> {
  const resolved = await resolveLocal(root, label, file, bases);
  if (!resolved.exists) return undefined;
  const text = await readBounded(root, resolved.path, label, MAX_CONFIG_BYTES);
  if (text === undefined) return undefined;
  const entries = parseGitConfig(text);
  if (entries === null) {
    throw refusal(root, `${label} (${resolved.path}) could not be parsed as git config`);
  }
  return { file: resolved.path, entries };
}

function isIncludePath(entry: GitConfigEntry): boolean {
  if (entry.key !== "path" || entry.value === null) return false;
  return (
    (entry.section === "include" && entry.subsection === null) ||
    (entry.section === "includeif" && entry.subsection !== null)
  );
}

function isCoreWorktree(entry: GitConfigEntry): boolean {
  return entry.section === "core" && entry.subsection === null && entry.key === "worktree";
}

/**
 * Checks include paths (recursively) and core.worktree in one config file.
 * `gitDir` is the directory relative paths of core.worktree resolve against.
 */
async function checkConfigFile(
  root: string,
  file: string,
  label: string,
  gitDir: string,
  depth: number,
  bases: readonly string[],
  state: ScanState,
): Promise<void> {
  // git itself stops with an error beyond MAX_INCLUDE_DEPTH.
  if (depth > MAX_INCLUDE_DEPTH) return;
  countScannedFile(root, state);
  const parsed = await readConfigEntries(root, file, label, bases);
  if (parsed === undefined) return;
  for (const entry of parsed.entries) {
    if (isCoreWorktree(entry) && entry.value !== null) {
      assertLocalPathText(root, `core.worktree in ${label}`, entry.value);
      await resolveLocal(root, `core.worktree in ${label}`, path.resolve(gitDir, entry.value), bases);
      continue;
    }
    if (!isIncludePath(entry)) continue;
    const value = entry.value!;
    const where = `${entry.section}${entry.subsection === null ? "" : `.${entry.subsection}`}.path in ${label}`;
    assertLocalPathText(root, where, value);
    // Home- and prefix-relative includes name the user's own files.
    if (value.startsWith("~") || value.startsWith("%(prefix)/")) continue;
    const target = path.resolve(path.dirname(parsed.file), value);
    const resolved = await canonical(root, where, target, bases);
    if (resolved !== undefined) {
      await checkConfigFile(root, resolved, `included config ${resolved}`, gitDir, depth + 1, bases, state);
    }
  }
}

async function readPointer(
  root: string,
  file: string,
  label: string,
  bases: readonly string[],
): Promise<string | undefined> {
  const text = await readMetadata(root, file, label, MAX_POINTER_BYTES, bases);
  if (text === undefined) return undefined;
  const value = text.replace(/[\r\n]+$/, "");
  if (value.length === 0 || /[\r\n\0]/.test(value)) return undefined;
  return value;
}

/** Linked worktree: <common>/worktrees/<name> whose gitdir file names <root>/.git. */
async function isLinkedWorktreeOf(
  root: string,
  gitDir: string,
  dotGit: string,
  bases: readonly string[],
): Promise<boolean> {
  const parentName = path.basename(path.dirname(gitDir));
  const matches =
    process.platform === "win32" ? parentName.toLowerCase() === "worktrees" : parentName === "worktrees";
  if (!matches) return false;
  const backPointer = await readPointer(root, path.join(gitDir, "gitdir"), "the worktree gitdir file", bases);
  if (backPointer === undefined) return false;
  assertLocalPathText(root, "the worktree gitdir file", backPointer);
  const target = await canonical(root, "the worktree gitdir file", path.resolve(gitDir, backPointer), bases);
  return target !== undefined && sameLocation(target, dotGit);
}

/** Submodule: a git dir whose core.worktree resolves to the root. */
async function isSubmoduleOf(
  root: string,
  gitDir: string,
  bases: readonly string[],
): Promise<boolean> {
  const parsed = await readConfigEntries(root, path.join(gitDir, "config"), "the submodule config", bases);
  if (parsed === undefined) return false;
  let worktree: string | null | undefined;
  for (const entry of parsed.entries) {
    if (isCoreWorktree(entry)) worktree = entry.value;
  }
  if (worktree === undefined || worktree === null) return false;
  assertLocalPathText(root, "core.worktree in the submodule config", worktree);
  const target = await canonical(root, "core.worktree in the submodule config", path.resolve(gitDir, worktree), bases);
  return target !== undefined && sameLocation(target, root);
}

/**
 * Validates the repository layout at `repoRoot` (see module header) and
 * returns the canonical root, git directory and common directory.
 */
export async function validateRepositoryLayout(
  repoRoot: string,
  subcommand: string,
): Promise<RepositoryLayout> {
  let root: string;
  try {
    root = await realpath(repoRoot);
  } catch {
    throw new GraphRepositoryError(
      "compare/git-command-failed",
      `git ${subcommand} failed: the analyzed root does not exist or cannot be read: ${repoRoot}`,
    );
  }
  const dotGit = path.join(root, ".git");
  let entry;
  try {
    entry = await lstat(dotGit);
  } catch {
    throw new GraphRepositoryError(
      "compare/git-command-failed",
      `git ${subcommand} failed: not a git repository: the analyzed root has no .git entry (${root}); ` +
        "repositories above the analyzed root are not used",
    );
  }

  let kind: RepositoryLayoutKind;
  let gitDir: string;
  if (entry.isSymbolicLink()) {
    throw refusal(root, "the .git entry is a symbolic link or junction and is not followed");
  } else if (entry.isDirectory()) {
    kind = "git-directory";
    gitDir = dotGit;
  } else if (entry.isFile()) {
    const content = await readBounded(root, dotGit, "the .git file", MAX_POINTER_BYTES);
    const pointer = content === undefined ? undefined : parseGitfile(content);
    if (pointer === undefined) {
      throw refusal(root, "the .git file is not a valid 'gitdir: <path>' pointer");
    }
    assertLocalPathText(root, "the gitdir pointer in the .git file", pointer);
    const target = await canonical(root, "the gitdir pointer in the .git file", path.resolve(root, pointer), [root]);
    if (target === undefined) {
      throw refusal(root, `the .git file points to a directory that does not exist (${JSON.stringify(pointer)})`);
    }
    gitDir = target;
    if (isSameOrInside(target, root)) {
      kind = "gitfile-within-root";
    } else if (await isLinkedWorktreeOf(root, target, dotGit, [root])) {
      kind = "linked-worktree";
    } else if (await isSubmoduleOf(root, target, [root])) {
      kind = "submodule";
    } else {
      throw refusal(
        root,
        `the .git file points to a git directory outside the analyzed root (${target}) that is not a linked ` +
          "worktree or submodule git directory of this root",
      );
    }
  } else {
    throw refusal(root, "the .git entry is neither a directory nor a regular file");
  }

  const bases = [root, gitDir];
  let commonDir = gitDir;
  const commonPointer = await readPointer(root, path.join(gitDir, "commondir"), "the commondir file", bases);
  if (commonPointer !== undefined) {
    assertLocalPathText(root, "the commondir file", commonPointer);
    const resolved = await canonical(root, "the commondir file", path.resolve(gitDir, commonPointer), bases);
    if (resolved === undefined) {
      throw refusal(root, `the commondir file points to a directory that does not exist`);
    }
    const expectedCommon =
      kind === "linked-worktree" ? await realpath(path.dirname(path.dirname(gitDir))).catch(() => undefined) : undefined;
    const accepted =
      kind === "linked-worktree"
        ? expectedCommon !== undefined && sameLocation(resolved, expectedCommon)
        : isSameOrInside(resolved, root);
    if (!accepted) {
      throw refusal(root, `the commondir file points outside the repository layout (${resolved})`);
    }
    commonDir = resolved;
  } else if (kind === "linked-worktree") {
    throw refusal(root, "the linked worktree git directory has no commondir file");
  }
  const allBases = commonDir === gitDir ? bases : [...bases, commonDir];

  for (const name of GIT_DIR_ENTRIES) {
    await resolveLocal(root, `${name} in the git directory`, path.join(gitDir, name), allBases);
  }
  for (const name of COMMON_DIR_ENTRIES) {
    await resolveLocal(root, `${name} in the git directory`, path.join(commonDir, name), allBases);
  }

  const state: ScanState = { scannedFiles: 0 };
  await checkConfigFile(root, path.join(commonDir, "config"), "the repository config", gitDir, 0, allBases, state);
  await checkConfigFile(root, path.join(gitDir, "config.worktree"), "the worktree config", gitDir, 0, allBases, state);
  await checkAlternates(root, path.join(commonDir, "objects"), 0, allBases, state);

  return { kind, root, gitDir, commonDir };
}
