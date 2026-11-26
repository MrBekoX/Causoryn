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
 * - any other gitdir pointer that leaves the root,
 * - an alternates entry (nested alternates included) whose object directory
 *   does not resolve inside the analyzed root, the git directory or the
 *   common directory: another object store on the machine is never read,
 * - a metadata file that is not a regular file (FIFO, socket, device): it is
 *   never opened, so it cannot block the read before git's timeout starts.
 *
 * Upward discovery is blocked separately by git-read (GIT_CEILING_DIRECTORIES
 * set to the parent of the root); a root without a `.git` entry is reported
 * as "not a git repository" without starting git.
 *
 * Only metadata is read here (bounded, no writes, no commands). Paths are
 * resolved component by component with lstat/readlink, so a link that points
 * to a network path is detected from its text and never opened.
 *
 * A path text from the metadata is joined onto the directory git resolves it
 * against without normalising it, and then read the two ways git builds read
 * it: with ".." applied to the directory a link resolved to (git on POSIX:
 * abspath.c strbuf_realpath and the kernel's open/chdir), and with ".."
 * folded lexically before links are followed (Git for Windows: Win32 path
 * normalisation). A path whose two readings name different locations is
 * refused, so the location validated here is the one git uses on either
 * platform. Separators are the ones git uses: `/` and `\` on Windows, only
 * `/` on POSIX (a backslash is an ordinary file-name character there).
 *
 * Refusal messages name the metadata text as written and paths inside the
 * analyzed root, never a resolved location outside it.
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

/** `value` is shown only when it is metadata text or a link inside the analyzed root. */
function networkRefusal(root: string, where: string, value?: string): GraphRepositoryError {
  const shown = value === undefined ? "" : ` (${JSON.stringify(value)})`;
  return refusal(root, `${where} names a network or device path${shown}; such paths are never accessed`);
}

/** " (<path>)" for a path inside the analyzed root; nothing for one outside it. */
function located(root: string, file: string): string {
  return isSameOrInside(file, root) ? ` (${file})` : "";
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown error";
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

/** Path separators as git splits them on this platform (see module header). */
const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/** Components of a path text, split as git splits them; empty and "." parts dropped, ".." kept. */
function components(text: string): string[] {
  return text.split(SEPARATORS).filter((part) => part.length > 0 && part !== ".");
}

interface SplitPath {
  /** Filesystem root ("/", "C:\"). */
  readonly root: string;
  readonly parts: string[];
}

/** Splits an absolute, already normalised path. */
function splitAbsolute(value: string): SplitPath {
  const root = path.parse(value).root;
  return { root, parts: components(value.slice(root.length)) };
}

/**
 * Splits an absolute path text without normalising it, so its ".." parts stay
 * where they are. Only the filesystem root comes from path.resolve: on Windows
 * a rooted text without a drive (`\x`) takes the drive of `driveOf`.
 */
function splitRaw(driveOf: string, text: string): SplitPath {
  return {
    root: path.parse(path.resolve(driveOf, text)).root,
    parts: components(text.slice(path.parse(text).root.length)),
  };
}

/**
 * Joins metadata text onto the directory git resolves it against, as git
 * does: `<base>/<text>` without normalisation, an absolute text as is.
 */
function joinRaw(base: string, text: string): string {
  if (path.isAbsolute(text)) return text;
  return /[\\/]$/.test(base) ? `${base}${text}` : `${base}${path.sep}${text}`;
}

/** The directory part of a path as git spelled it (config.c: up to the last separator). */
function spelledDirectory(spelled: string): string {
  const index =
    process.platform === "win32"
      ? Math.max(spelled.lastIndexOf("/"), spelled.lastIndexOf("\\"))
      : spelled.lastIndexOf("/");
  return index < 0 ? spelled : spelled.slice(0, index + 1);
}

/**
 * Where a walk over `split` may start: the longest base whose components are
 * a leading run of `split.parts` (a run without ".." parts). Bases are
 * canonical directories without links, so walking that run would end in the
 * base itself.
 */
function startingPoint(split: SplitPath, bases: readonly string[]): { current: string; queue: string[] } {
  let current = split.root;
  let skipped = 0;
  for (const base of bases) {
    const own = splitAbsolute(base);
    if (own.root !== split.root || own.parts.length <= skipped || own.parts.length > split.parts.length) continue;
    if (own.parts.every((part, index) => part === split.parts[index])) {
      current = base;
      skipped = own.parts.length;
    }
  }
  return { current, queue: split.parts.slice(skipped) };
}

interface LocalResolution {
  readonly path: string;
  readonly exists: boolean;
}

/**
 * - "physical": ".." applies to the directory reached so far, after links
 *   (git on POSIX); link text is joined onto the link's directory unnormalised.
 * - "lexical": ".." is folded before links are followed, also in link text
 *   (Win32 path normalisation, Git for Windows).
 */
type Reading = "physical" | "lexical";

interface Walk extends LocalResolution {
  readonly linksFollowed: number;
  /** The walk stopped at a missing component with a ".." still ahead of it. */
  readonly parentAfterMissing: boolean;
}

/**
 * Walks `spelled` component by component, following only links whose target
 * text is a local path. A missing component (ENOENT/ENOTDIR) ends the walk
 * with exists=false and the path the entry would have; any other lstat or
 * readlink failure is a refusal, since git may still be able to read there.
 */
async function walkPath(
  root: string,
  where: string,
  spelled: string,
  bases: readonly string[],
  reading: Reading,
): Promise<Walk> {
  const start = reading === "physical" ? splitRaw(root, spelled) : splitAbsolute(path.resolve(root, spelled));
  let { current, queue } = startingPoint(start, bases);
  // Below a base (the analyzed root, the git or common directory) the walk
  // never starts at a filesystem root, wherever that base lives.
  if (current === start.root && isNetworkOrDevicePath(current)) throw networkRefusal(root, where);
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let entry;
    try {
      entry = await lstat(next);
    } catch (error) {
      if (!isMissingEntryError(error)) {
        throw refusal(root, `${where} could not be checked (${errorCode(error)})`);
      }
      return {
        path: path.join(next, ...queue),
        exists: false,
        linksFollowed: hops,
        parentAfterMissing: queue.includes(".."),
      };
    }
    if (!entry.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      throw refusal(root, `${where} passes through too many symbolic links`);
    }
    const linkWhere = `a symbolic link on the way to ${where}${located(root, next)}`;
    let linkText: string;
    try {
      linkText = await readlink(next);
    } catch (error) {
      throw refusal(root, `${linkWhere} could not be read (${errorCode(error)})`);
    }
    // The text of a link outside the analyzed root is not shown.
    const shownText = isSameOrInside(next, root) ? linkText : undefined;
    if (isNetworkOrDevicePath(linkText)) throw networkRefusal(root, linkWhere, shownText);
    if (isDriveRelative(linkText)) throw refusal(root, `${linkWhere} has a drive-relative target`);
    let target: SplitPath;
    if (reading === "lexical") {
      target = splitAbsolute(path.resolve(current, linkText));
    } else if (path.isAbsolute(linkText)) {
      target = splitRaw(current, linkText);
    } else {
      // Relative text continues from the link's own directory.
      target = { root: current, parts: components(linkText) };
    }
    if (target.root !== current && isNetworkOrDevicePath(target.root)) {
      throw networkRefusal(root, linkWhere, shownText);
    }
    current = target.root;
    queue = [...target.parts, ...queue];
  }
  return { path: current, exists: true, linksFollowed: hops, parentAfterMissing: false };
}

async function sameResolution(a: LocalResolution, b: LocalResolution): Promise<boolean> {
  if (a.exists !== b.exists) return false;
  if (sameLocation(a.path, b.path)) return true;
  if (!a.exists) return false;
  const [realA, realB] = await Promise.all([realpath(a.path).catch(() => a.path), realpath(b.path).catch(() => b.path)]);
  return sameLocation(realA, realB);
}

/**
 * Resolves `spelled` (an absolute path text, see joinRaw) both ways git
 * reads it and refuses it when the two readings name different locations.
 * `bases` are canonical directories known to contain no links; components
 * leading to one of them are not walked again.
 */
async function resolveLocal(
  root: string,
  where: string,
  spelled: string,
  bases: readonly string[],
): Promise<LocalResolution> {
  const physical = await walkPath(root, where, spelled, bases, "physical");
  // Without links every ".." removed a real directory, so both readings agree.
  if (physical.linksFollowed === 0 && !physical.parentAfterMissing) {
    return { path: physical.path, exists: physical.exists };
  }
  const lexical = await walkPath(root, where, spelled, bases, "lexical");
  if (!(await sameResolution(physical, lexical))) {
    throw refusal(
      root,
      `${where} names a different location depending on whether ".." is applied after symbolic links ` +
        "(git on POSIX) or before them (Git for Windows)",
    );
  }
  return { path: physical.path, exists: physical.exists };
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

/**
 * O_NONBLOCK: an open() of a FIFO that replaced the file after lstat returns
 * at once instead of waiting for a writer; the identity check then refuses
 * it. Both flags are undefined (0) on Windows.
 */
const METADATA_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Bounded read of a small metadata file at an already link-checked path.
 * lstat comes first and only a regular file is opened, so a FIFO, socket or
 * device never blocks the read (the git subprocess timeout does not cover
 * this step). The opened handle must be the file the lstat saw (dev, ino).
 * A missing entry (ENOENT/ENOTDIR) or a directory reads as absent; any other
 * lstat failure (EACCES, EPERM, ...) is a refusal: git may still read a file
 * this check could not look at.
 */
async function readBounded(
  root: string,
  file: string,
  label: string,
  maxBytes: number,
): Promise<string | undefined> {
  const shown = `${label}${located(root, file)}`;
  let before;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    if (isMissingEntryError(error)) return undefined;
    throw refusal(root, `${shown} could not be checked (${errorCode(error)})`);
  }
  if (before.isDirectory()) return undefined;
  if (!before.isFile()) {
    throw refusal(root, `${shown} is not a regular file`);
  }
  let handle;
  try {
    handle = await open(file, METADATA_OPEN_FLAGS);
  } catch (error) {
    if (isMissingEntryError(error)) return undefined;
    throw refusal(root, `${shown} could not be opened as a regular file`);
  }
  try {
    const info = await handle.stat({ bigint: true });
    const sameInode = info.ino === 0n || before.ino === 0n || info.ino === before.ino;
    if (!info.isFile() || info.dev !== before.dev || !sameInode) {
      throw refusal(root, `${shown} changed while it was read`);
    }
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

/**
 * Checks objects/info/alternates (nested alternates included). Every
 * alternate object directory must resolve, through any links, inside
 * `scope` (the canonical analyzed root, git directory and common directory):
 * an object store elsewhere on the machine is never read (CAU-06). An entry
 * that does not exist yet is judged by the path it would have, so it cannot
 * be created outside the scope after this check.
 */
async function checkAlternates(
  root: string,
  objectsDir: string,
  depth: number,
  bases: readonly string[],
  scope: readonly string[],
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
    const where = "an objects/info/alternates entry";
    assertLocalPathText(root, where, entry);
    const named = `${where} (${JSON.stringify(entry)})`;
    // git: realpath(<objects dir>) + "/" + entry, resolved component by
    // component (odb.c link_alt_odb_entry, strbuf_realpath).
    const resolved = await resolveLocal(root, named, joinRaw(objectsDir, entry), bases);
    const location = resolved.exists ? await realpath(resolved.path).catch(() => resolved.path) : resolved.path;
    if (!scope.some((dir) => isSameOrInside(location, dir))) {
      throw refusal(
        root,
        `${named} points outside the repository; only object directories inside the analyzed ` +
          "root, its git directory or its common directory are used",
      );
    }
    if (resolved.exists) {
      await checkAlternates(root, location, depth + 1, bases, scope, state);
    }
  }
}

/** Reads the config file at `spelled` (a path as git spells it, see joinRaw). */
async function readConfigEntries(
  root: string,
  spelled: string,
  label: string,
  bases: readonly string[],
): Promise<GitConfigEntry[] | undefined> {
  const resolved = await resolveLocal(root, label, spelled, bases);
  if (!resolved.exists) return undefined;
  const text = await readBounded(root, resolved.path, label, MAX_CONFIG_BYTES);
  if (text === undefined) return undefined;
  const entries = parseGitConfig(text);
  if (entries === null) {
    throw refusal(root, `${label}${located(root, resolved.path)} could not be parsed as git config`);
  }
  return entries;
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
 * `spelled` is the file's path as git spells it: a relative include resolves
 * against its directory part (config.c handle_path_include), not against the
 * target of a linked config file. `gitDir` is the directory relative paths of
 * core.worktree resolve against.
 */
async function checkConfigFile(
  root: string,
  spelled: string,
  label: string,
  gitDir: string,
  depth: number,
  bases: readonly string[],
  state: ScanState,
): Promise<void> {
  // git itself stops with an error beyond MAX_INCLUDE_DEPTH.
  if (depth > MAX_INCLUDE_DEPTH) return;
  countScannedFile(root, state);
  const entries = await readConfigEntries(root, spelled, label, bases);
  if (entries === undefined) return;
  for (const entry of entries) {
    if (isCoreWorktree(entry) && entry.value !== null) {
      const where = `core.worktree in ${label}`;
      assertLocalPathText(root, where, entry.value);
      await resolveLocal(root, `${where} (${JSON.stringify(entry.value)})`, joinRaw(gitDir, entry.value), bases);
      continue;
    }
    if (!isIncludePath(entry)) continue;
    const value = entry.value!;
    const where = `${entry.section}${entry.subsection === null ? "" : `.${entry.subsection}`}.path in ${label}`;
    assertLocalPathText(root, where, value);
    // Home- and prefix-relative includes name the user's own files.
    if (value.startsWith("~") || value.startsWith("%(prefix)/")) continue;
    const include = joinRaw(spelledDirectory(spelled), value);
    const resolved = await resolveLocal(root, `${where} (${JSON.stringify(value)})`, include, bases);
    if (resolved.exists) {
      await checkConfigFile(root, include, `included config ${JSON.stringify(value)}`, gitDir, depth + 1, bases, state);
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
  const named = `the worktree gitdir file (${JSON.stringify(backPointer)})`;
  const target = await canonical(root, named, joinRaw(gitDir, backPointer), bases);
  return target !== undefined && sameLocation(target, dotGit);
}

/** Submodule: a git dir whose core.worktree resolves to the root. */
async function isSubmoduleOf(
  root: string,
  gitDir: string,
  bases: readonly string[],
): Promise<boolean> {
  const entries = await readConfigEntries(root, path.join(gitDir, "config"), "the submodule config", bases);
  if (entries === undefined) return false;
  let worktree: string | null | undefined;
  for (const entry of entries) {
    if (isCoreWorktree(entry)) worktree = entry.value;
  }
  if (worktree === undefined || worktree === null) return false;
  const where = "core.worktree in the submodule config";
  assertLocalPathText(root, where, worktree);
  // git: chdir(<git dir>), then chdir(<core.worktree>) (setup.c).
  const target = await canonical(root, `${where} (${JSON.stringify(worktree)})`, joinRaw(gitDir, worktree), bases);
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
    // git (setup.c read_gitfile_gently): <dir of .git>/<pointer>, then realpath.
    const named = `the gitdir pointer in the .git file (${JSON.stringify(pointer)})`;
    const target = await canonical(root, named, joinRaw(root, pointer), [root]);
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
        `the .git file points to a git directory outside the analyzed root (${JSON.stringify(pointer)}) that is ` +
          "not a linked worktree or submodule git directory of this root",
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
    // git (setup.c get_common_dir_noenv): <git dir>/<commondir>, then realpath.
    const named = `the commondir file (${JSON.stringify(commonPointer)})`;
    const resolved = await canonical(root, named, joinRaw(gitDir, commonPointer), bases);
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
      throw refusal(root, `${named} points outside the repository layout`);
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
  // git reads objects (and resolves relative alternates entries) at the real
  // location of the objects directory, so both checks use its realpath: an
  // objects link that leaves the repository is refused, and a relative entry
  // is judged where git will resolve it, not by its lexical spelling (CAU-06).
  const objectsDir = await canonical(root, "the objects directory", path.join(commonDir, "objects"), allBases);
  if (objectsDir !== undefined) {
    if (!allBases.some((dir) => isSameOrInside(objectsDir, dir))) {
      throw refusal(
        root,
        "the objects directory points outside the repository; only object directories inside the " +
          "analyzed root, its git directory or its common directory are used",
      );
    }
    await checkAlternates(root, objectsDir, 0, allBases, allBases, state);
  }

  return { kind, root, gitDir, commonDir };
}
