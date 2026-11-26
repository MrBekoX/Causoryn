import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { inspectLinkTargets, isUncOrDevicePath, LINK_TARGET_INSPECTION_ENABLED } from "./path-safety.js";

/**
 * Descriptor-based bounded text reader shared by every layer that reads
 * workspace files (inventory, contract discovery, MCP optional reads).
 * CWE-59 link following and CWE-367 check-then-open hardening (TŞ §19/§20).
 *
 * Order of operations:
 *   1. lexical checks (absolute, no NUL, no UNC/device path on Windows);
 *   2. TOP-DOWN path verification from the canonical root: every component
 *      below the root is lstat'd in order and must be a real directory (not
 *      a symlink or junction) before anything deeper is touched; the final
 *      component must be a regular file per lstat. A rejected component ends
 *      the walk, so no I/O reaches a path below a link;
 *   3. open of the verified path with O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY
 *      where defined (POSIX; Windows relies on steps 2 and 4);
 *   4. fstat: a regular file with the same (dev, ino) as the pre-open lstat;
 *   5. Linux only: the kernel's current path of the descriptor
 *      (readlink of /proc/self/fd/<fd>) must be exactly the verified canonical
 *      path; a deleted file (" (deleted)" suffix) or any other path is refused;
 *   6. size bound from fstat, then a read capped at maxBytes + 1 bytes and a
 *      UTF-8 decode whose byte length must also fit;
 *   7. the caller's `authorize` decision, made while the descriptor is open;
 *   8. a post-open re-verification of the path whose final (dev, ino) must
 *      match the descriptor again.
 *
 * The content is returned only when every step passes, so an authorization
 * decision made on the path is bound to the file actually read.
 *
 * Guarantee per platform (Node has no openat/O_RESOLVE_BENEATH, so open(2)
 * itself still traverses whatever the path names at that instant):
 * - Linux with procfs: step 5 is bound to the descriptor, not to a path, so a
 *   file outside the root is never returned, even to an attacker who toggles
 *   a component between a directory and a link (a renameat2(RENAME_EXCHANGE)
 *   loop) and wins every path-based check. Its location is checked before its
 *   size is reported. A readlink failure while /proc/self/fd exists is a
 *   rejection; only when procfs is not mounted at all do steps 2, 4 and 8
 *   decide alone, as on the platforms below.
 * - macOS, other POSIX systems and Windows: no descriptor path is available
 *   to Node (macOS F_GETPATH and Windows GetFinalPathNameByHandle are not
 *   exposed), so steps 2, 4 and 8 are path-based. They reject a single swap
 *   that persists across open (a component swapped for a link before open
 *   and restored after it, a file replaced around open), but an attacker who
 *   can toggle a component between a directory and a link fast enough to
 *   win every check's timing can still have a file outside the root read.
 *   On Windows such an open can also contact a network share named by a
 *   junction before any rejection.
 * lstat reports only symlinks, junctions and app-exec links as links on
 * Windows; other reparse points look like plain directories. Identity checks
 * assume the filesystem reports real inodes; a filesystem reporting inode 0
 * for every file makes the descriptor comparison vacuous (the alias slow path
 * never matches on it). On a case-insensitive Linux filesystem, a path
 * spelled in another letter case than on disk fails step 5 and is refused.
 */

/** (dev, ino) of the opened file. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** What `authorize` sees: the descriptor-verified decoded byte length and identity. */
export interface OpenedFileInfo {
  readonly bytes: number;
  readonly identity: FileIdentity;
}

export type BoundedFileReadRejection =
  /** Not an absolute path, contains NUL, a UNC/device path, or an unusable `root`. */
  | "invalid-path"
  /** Not strictly inside the root (includes the root itself). */
  | "outside-root"
  /** A component, the file or the root does not exist or cannot be inspected. */
  | "not-found"
  /** A component below the root is a symlink, a junction or not a directory. */
  | "unsafe-component"
  /** The final component is not a regular file (symlink, FIFO, device, directory...). */
  | "not-regular-file"
  /**
   * The opened descriptor is not the verified file (swapped around open or
   * read; on Linux also: its kernel path is not the verified path).
   */
  | "identity-changed"
  /** The caller's `authorize` callback refused the opened file. */
  | "not-authorized"
  /** open/fstat/read failed (on Linux also: the descriptor's path could not be read). */
  | "read-failed";

export type BoundedFileReadResult =
  | {
      readonly status: "ok";
      readonly text: string;
      /** UTF-8 byte length of `text` (never above maxBytes). */
      readonly bytes: number;
      readonly identity: FileIdentity;
    }
  | { readonly status: "too-large"; readonly bytes: number }
  | { readonly status: "rejected"; readonly reason: BoundedFileReadRejection };

export interface BoundedFileReadOptions {
  /**
   * Directory the file must stay strictly inside. Any spelling is accepted (a
   * path under a symlinked ancestor such as macOS `/var`, a Windows 8.3 short
   * path, or a link to the root): the root is canonicalised with the native
   * realpath and only the components below it are walked. When omitted, the
   * walk starts at the filesystem root and every component of the target must
   * be a real directory.
   */
  readonly root?: string;
  /**
   * Authorization decision bound to the descriptor. Called once, after the
   * bounded read and before the post-open re-verification; returning false
   * drops the content (`rejected` / `not-authorized`). Must not throw.
   */
  readonly authorize?: (opened: OpenedFileInfo) => boolean;
}

const READ_CHUNK_BYTES = 64 * 1024;
const IS_WIN = process.platform === "win32";

/** Links followed while locating a root reached through an alias spelling. */
const MAX_ROOT_ALIAS_LINKS = 40;

/**
 * O_NOFOLLOW refuses a final-component symlink, O_NONBLOCK keeps open(2) on a
 * FIFO from waiting for a writer, O_NOCTTY keeps a terminal from becoming the
 * controlling tty. All three are POSIX-only (undefined on Windows).
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOCTTY ?? 0);

/** Linux procfs directory of this process's open descriptors. */
const PROC_SELF_FD = "/proc/self/fd";

/**
 * Read at call time (not cached) so the Linux-only descriptor check can be
 * exercised on every host by tests that present the reader a Linux platform.
 */
function descriptorPathCheckApplies(): boolean {
  return process.platform === "linux";
}

/** Verified walk: start directory (not itself inspected) and the components below it. */
interface ReadPlan {
  readonly base: string;
  readonly segments: readonly string[];
  readonly openPath: string;
}

type Step<T> = T | BoundedFileReadRejection;

function rejected(reason: BoundedFileReadRejection): BoundedFileReadResult {
  return { status: "rejected", reason };
}

function isRejection<T>(value: Step<T>): value is BoundedFileReadRejection {
  return typeof value === "string";
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Root match by identity in the alias slow path. Some Windows network/virtual
 * filesystems report inode 0 for everything; such an identity proves nothing,
 * so it never matches (the target is then treated as outside the root).
 */
function isRootByIdentity(stat: BigIntStats, rootStat: BigIntStats): boolean {
  return stat.ino !== 0n && sameIdentity(stat, rootStat);
}

/** The byte budget is a caller invariant; NaN/Infinity would disable the bound. */
function requireByteBudget(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

function isUsablePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    !(IS_WIN && isUncOrDevicePath(value))
  );
}

function splitSegments(relative: string): string[] {
  return relative.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== ".");
}

/** Components of `target` below `base` ([] for `base` itself), or undefined when outside. */
function segmentsBelow(base: string, target: string): string[] | undefined {
  const relative = path.relative(base, target);
  if (relative === "") return [];
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return splitSegments(relative);
}

function makePlan(base: string, segments: readonly string[]): Step<ReadPlan> {
  if (segments.length === 0) return "outside-root";
  return { base, segments, openPath: path.join(base, ...segments) };
}

function nativeRealpathSync(target: string): string {
  // Mocked `node:fs` modules may not carry `.native`; fall back to the JS realpath.
  const native = (realpathSync as { native?: (p: string) => string }).native;
  return typeof native === "function" ? native(target) : realpathSync(target);
}

function lstatOrUndefinedSync(target: string): BigIntStats | undefined {
  try {
    return lstatSync(target, { bigint: true });
  } catch {
    return undefined;
  }
}

async function lstatOrUndefined(target: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(target, { bigint: true });
  } catch {
    return undefined;
  }
}

/**
 * Lexical normalisation: the normalised path is what gets verified, so `..`
 * segments cannot be resolved differently by the OS later.
 */
function normalizedTarget(absolutePath: string, options: BoundedFileReadOptions | undefined): string | undefined {
  if (typeof absolutePath !== "string" || !isUsablePath(absolutePath)) return undefined;
  if (options?.root !== undefined && (typeof options.root !== "string" || !isUsablePath(options.root))) {
    return undefined;
  }
  return path.resolve(absolutePath);
}

/** A link met while locating the root through an alias spelling. */
type AliasStep =
  | { readonly kind: "found"; readonly segments: string[] }
  | { readonly kind: "continue"; readonly current: string }
  | { readonly kind: "reject"; readonly reason: BoundedFileReadRejection };

/**
 * Decides where a link above the root leads. Windows UNC/device link targets
 * are refused from readlink alone, before the link is followed. The link must
 * resolve to the root itself or to one of its ancestors (e.g. `/var` ->
 * `/private/var`); a link that leads into the root from outside or away from
 * it is refused.
 */
function aliasStep(real: string | undefined, rest: readonly string[], canonicalRoot: string): AliasStep {
  if (real === undefined) return { kind: "reject", reason: "not-found" };
  if (IS_WIN && isUncOrDevicePath(real)) return { kind: "reject", reason: "unsafe-component" };
  if (segmentsBelow(real, canonicalRoot) === undefined) {
    return {
      kind: "reject",
      reason: segmentsBelow(canonicalRoot, real) === undefined ? "outside-root" : "unsafe-component",
    };
  }
  const rebased = segmentsBelow(canonicalRoot, path.join(real, ...rest));
  if (rebased !== undefined) return { kind: "found", segments: rebased };
  return { kind: "continue", current: real };
}

function linkTargetIsUnsafe(link: string, current: string): boolean {
  return LINK_TARGET_INSPECTION_ENABLED && !inspectLinkTargets(link, { startDir: current }).ok;
}

/**
 * Slow path for a target not lexically below either spelling of the root:
 * walks the target top-down until a component is the root (same identity) or
 * a link resolves to the root or one of its ancestors. Nothing below the root
 * is touched here; the caller then walks the components below the root.
 */
function locateThroughAliasSync(target: string, canonicalRoot: string): Step<string[]> {
  const rootStat = lstatOrUndefinedSync(canonicalRoot);
  if (rootStat === undefined || !rootStat.isDirectory()) return "not-found";
  let current = path.parse(target).root;
  let remaining = splitSegments(target.slice(current.length));
  let links = 0;
  while (remaining.length > 0) {
    const [head, ...rest] = remaining as [string, ...string[]];
    const next = path.join(current, head);
    const stat = lstatOrUndefinedSync(next);
    if (stat === undefined) return "not-found";
    if (stat.isSymbolicLink()) {
      links += 1;
      if (links > MAX_ROOT_ALIAS_LINKS || linkTargetIsUnsafe(next, current)) return "unsafe-component";
      let real: string | undefined;
      try {
        real = nativeRealpathSync(next);
      } catch {
        real = undefined;
      }
      const step = aliasStep(real, rest, canonicalRoot);
      if (step.kind === "reject") return step.reason;
      if (step.kind === "found") return step.segments;
      current = step.current;
      remaining = rest;
      continue;
    }
    if (!stat.isDirectory()) return "outside-root";
    if (isRootByIdentity(stat, rootStat)) return rest;
    current = next;
    remaining = rest;
  }
  return "outside-root";
}

/** Async counterpart of {@link locateThroughAliasSync}. */
async function locateThroughAlias(target: string, canonicalRoot: string): Promise<Step<string[]>> {
  const rootStat = await lstatOrUndefined(canonicalRoot);
  if (rootStat === undefined || !rootStat.isDirectory()) return "not-found";
  let current = path.parse(target).root;
  let remaining = splitSegments(target.slice(current.length));
  let links = 0;
  while (remaining.length > 0) {
    const [head, ...rest] = remaining as [string, ...string[]];
    const next = path.join(current, head);
    const stat = await lstatOrUndefined(next);
    if (stat === undefined) return "not-found";
    if (stat.isSymbolicLink()) {
      links += 1;
      if (links > MAX_ROOT_ALIAS_LINKS || linkTargetIsUnsafe(next, current)) return "unsafe-component";
      let real: string | undefined;
      try {
        real = await realpath(next);
      } catch {
        real = undefined;
      }
      const step = aliasStep(real, rest, canonicalRoot);
      if (step.kind === "reject") return step.reason;
      if (step.kind === "found") return step.segments;
      current = step.current;
      remaining = rest;
      continue;
    }
    if (!stat.isDirectory()) return "outside-root";
    if (isRootByIdentity(stat, rootStat)) return rest;
    current = next;
    remaining = rest;
  }
  return "outside-root";
}

/**
 * Plan for a target lexically below either spelling of the root, or undefined
 * when the target is spelled through another alias of the root. The canonical
 * root may itself be a network path (a mapped drive resolves to `\\server\...`
 * with the native realpath); that is the caller's authorized root, while every
 * link BELOW it is still refused before it is followed.
 */
function lexicalPlan(target: string, rootSpelling: string, canonicalRoot: string): Step<ReadPlan> | undefined {
  const lexical = segmentsBelow(canonicalRoot, target) ?? segmentsBelow(rootSpelling, target);
  return lexical === undefined ? undefined : makePlan(canonicalRoot, lexical);
}

function planWithoutRoot(target: string): Step<ReadPlan> {
  const base = path.parse(target).root;
  return makePlan(base, splitSegments(target.slice(base.length)));
}

function planSync(target: string, root: string | undefined): Step<ReadPlan> {
  if (root === undefined) return planWithoutRoot(target);
  const rootSpelling = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = nativeRealpathSync(rootSpelling);
  } catch {
    return "not-found";
  }
  const lexical = lexicalPlan(target, rootSpelling, canonicalRoot);
  if (lexical !== undefined) return lexical;
  const located = locateThroughAliasSync(target, canonicalRoot);
  return isRejection(located) ? located : makePlan(canonicalRoot, located);
}

/** Async counterpart of {@link planSync} (fs/promises realpath is the native one). */
async function plan(target: string, root: string | undefined): Promise<Step<ReadPlan>> {
  if (root === undefined) return planWithoutRoot(target);
  const rootSpelling = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(rootSpelling);
  } catch {
    return "not-found";
  }
  const lexical = lexicalPlan(target, rootSpelling, canonicalRoot);
  if (lexical !== undefined) return lexical;
  const located = await locateThroughAlias(target, canonicalRoot);
  return isRejection(located) ? located : makePlan(canonicalRoot, located);
}

/**
 * Top-down walk of a plan: each intermediate component is lstat'd in order
 * and must be a real directory before the next one is touched; the final
 * component must be a regular file. Returns the file's lstat.
 */
function walkSync(readPlan: ReadPlan): Step<BigIntStats> {
  let current = readPlan.base;
  const last = readPlan.segments.length - 1;
  for (let index = 0; index < last; index += 1) {
    current = path.join(current, readPlan.segments[index] as string);
    const stat = lstatOrUndefinedSync(current);
    if (stat === undefined) return "not-found";
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe-component";
  }
  const fileStat = lstatOrUndefinedSync(readPlan.openPath);
  if (fileStat === undefined) return "not-found";
  return fileStat.isFile() ? fileStat : "not-regular-file";
}

/** Async counterpart of {@link walkSync}. */
async function walk(readPlan: ReadPlan): Promise<Step<BigIntStats>> {
  let current = readPlan.base;
  const last = readPlan.segments.length - 1;
  for (let index = 0; index < last; index += 1) {
    current = path.join(current, readPlan.segments[index] as string);
    const stat = await lstatOrUndefined(current);
    if (stat === undefined) return "not-found";
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe-component";
  }
  const fileStat = await lstatOrUndefined(readPlan.openPath);
  if (fileStat === undefined) return "not-found";
  return fileStat.isFile() ? fileStat : "not-regular-file";
}

function decodeBounded(
  chunks: readonly Buffer[],
  totalBytes: number,
  maxBytes: number,
): { readonly text: string; readonly bytes: number } | { readonly tooLarge: number } {
  if (totalBytes > maxBytes) return { tooLarge: totalBytes };
  const text = Buffer.concat(chunks, totalBytes).toString("utf8");
  // Invalid sequences decode to U+FFFD (3 bytes), so the decoded length is re-checked.
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > maxBytes ? { tooLarge: bytes } : { text, bytes };
}

/**
 * Decodes the bytes and asks `authorize` while the descriptor is still open.
 * An "ok" result is provisional until {@link confirmIdentity} has run.
 */
function decodeAndAuthorize(
  opened: BigIntStats,
  chunks: readonly Buffer[],
  totalBytes: number,
  maxBytes: number,
  options: BoundedFileReadOptions | undefined,
): BoundedFileReadResult {
  const decoded = decodeBounded(chunks, totalBytes, maxBytes);
  if ("tooLarge" in decoded) return { status: "too-large", bytes: decoded.tooLarge };
  const identity: FileIdentity = { dev: opened.dev, ino: opened.ino };
  if (options?.authorize !== undefined && !options.authorize({ bytes: decoded.bytes, identity })) {
    return rejected("not-authorized");
  }
  return { status: "ok", text: decoded.text, bytes: decoded.bytes, identity };
}

/** The post-open re-verification of the path must still name the descriptor's file. */
function confirmIdentity(
  opened: BigIntStats,
  after: Step<BigIntStats>,
  provisional: BoundedFileReadResult,
): BoundedFileReadResult {
  if (isRejection(after) || !sameIdentity(opened, after)) return rejected("identity-changed");
  return provisional;
}

/** The fstat result must be a regular file with the pre-open lstat's identity. */
function isVerifiedFile(opened: BigIntStats, before: BigIntStats): boolean {
  return opened.isFile() && sameIdentity(opened, before);
}

/** Size verdict from fstat: a terminal result, or undefined to continue reading. */
function sizeVerdict(opened: BigIntStats, maxBytes: number): BoundedFileReadResult | undefined {
  const size = Number(opened.size);
  return size > maxBytes ? { status: "too-large", bytes: size } : undefined;
}

/**
 * The kernel's path of the descriptor must be the verified path exactly. A
 * file deleted after open reads back as "<path> (deleted)" and is refused like
 * any other path; a file legitimately named "... (deleted)" matches itself.
 */
function locationVerdict(kernelPath: string, expectedPath: string): BoundedFileReadRejection | undefined {
  return kernelPath === expectedPath ? undefined : "identity-changed";
}

/**
 * Linux step 5: where the descriptor actually is. A rejection reason, or
 * undefined when the path matches or procfs is not mounted. A readlink
 * failure with procfs mounted (e.g. ENAMETOOLONG for a very long real path)
 * is refused, so it cannot be used to fall back to the path-based checks.
 */
function descriptorLocationSync(fd: number, expectedPath: string): BoundedFileReadRejection | undefined {
  if (!descriptorPathCheckApplies()) return undefined;
  let kernelPath: string;
  try {
    kernelPath = readlinkSync(`${PROC_SELF_FD}/${fd}`);
  } catch {
    return lstatOrUndefinedSync(PROC_SELF_FD)?.isDirectory() === true ? "read-failed" : undefined;
  }
  return locationVerdict(kernelPath, expectedPath);
}

/** Async counterpart of {@link descriptorLocationSync}. */
async function descriptorLocation(fd: number, expectedPath: string): Promise<BoundedFileReadRejection | undefined> {
  if (!descriptorPathCheckApplies()) return undefined;
  let kernelPath: string;
  try {
    kernelPath = await readlink(`${PROC_SELF_FD}/${fd}`);
  } catch {
    return (await lstatOrUndefined(PROC_SELF_FD))?.isDirectory() === true ? "read-failed" : undefined;
  }
  return locationVerdict(kernelPath, expectedPath);
}

/**
 * Reads a text file through one descriptor bound to the verified path, with
 * at most `maxBytes + 1` bytes read. Filesystem conditions never throw; a
 * RangeError is thrown only for a `maxBytes` that is not a non-negative safe
 * integer (caller invariant).
 */
export function readBoundedTextFileSync(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedFileReadOptions,
): BoundedFileReadResult {
  requireByteBudget(maxBytes);
  const target = normalizedTarget(absolutePath, options);
  if (target === undefined) return rejected("invalid-path");
  const readPlan = planSync(target, options?.root);
  if (isRejection(readPlan)) return rejected(readPlan);
  const before = walkSync(readPlan);
  if (isRejection(before)) return rejected(before);

  let fd: number;
  try {
    fd = openSync(readPlan.openPath, OPEN_FLAGS);
  } catch {
    return rejected("read-failed");
  }
  try {
    let opened: BigIntStats;
    try {
      opened = fstatSync(fd, { bigint: true });
    } catch {
      return rejected("read-failed");
    }
    if (!isVerifiedFile(opened, before)) return rejected("identity-changed");
    // Located before the size is reported or any byte is read.
    const misplaced = descriptorLocationSync(fd, readPlan.openPath);
    if (misplaced !== undefined) return rejected(misplaced);
    const tooLarge = sizeVerdict(opened, maxBytes);
    if (tooLarge !== undefined) return tooLarge;

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, maxRead);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < maxRead) {
        const toRead = Math.min(chunkSize, maxRead - totalBytes);
        const buffer = Buffer.allocUnsafe(toRead);
        const bytesRead = readSync(fd, buffer, 0, toRead, null);
        if (bytesRead === 0) break;
        chunks.push(bytesRead === toRead ? buffer : buffer.subarray(0, bytesRead));
        totalBytes += bytesRead;
      }
    } catch {
      return rejected("read-failed");
    }
    const provisional = decodeAndAuthorize(opened, chunks, totalBytes, maxBytes, options);
    if (provisional.status !== "ok") return provisional;
    return confirmIdentity(opened, walkSync(readPlan), provisional);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure is not actionable for a read-only descriptor.
    }
  }
}

/** Async counterpart of {@link readBoundedTextFileSync} (fs/promises; FileHandle closed in `finally`). */
export async function readBoundedTextFile(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedFileReadOptions,
): Promise<BoundedFileReadResult> {
  requireByteBudget(maxBytes);
  const target = normalizedTarget(absolutePath, options);
  if (target === undefined) return rejected("invalid-path");
  const readPlan = await plan(target, options?.root);
  if (isRejection(readPlan)) return rejected(readPlan);
  const before = await walk(readPlan);
  if (isRejection(before)) return rejected(before);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(readPlan.openPath, OPEN_FLAGS);
  } catch {
    return rejected("read-failed");
  }
  try {
    let opened: BigIntStats;
    try {
      opened = await handle.stat({ bigint: true });
    } catch {
      return rejected("read-failed");
    }
    if (!isVerifiedFile(opened, before)) return rejected("identity-changed");
    // Located before the size is reported or any byte is read.
    const misplaced = await descriptorLocation(handle.fd, readPlan.openPath);
    if (misplaced !== undefined) return rejected(misplaced);
    const tooLarge = sizeVerdict(opened, maxBytes);
    if (tooLarge !== undefined) return tooLarge;

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, maxRead);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < maxRead) {
        const toRead = Math.min(chunkSize, maxRead - totalBytes);
        const buffer = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(buffer, 0, toRead, null);
        if (bytesRead === 0) break;
        chunks.push(bytesRead === toRead ? buffer : buffer.subarray(0, bytesRead));
        totalBytes += bytesRead;
      }
    } catch {
      return rejected("read-failed");
    }
    const provisional = decodeAndAuthorize(opened, chunks, totalBytes, maxBytes, options);
    if (provisional.status !== "ok") return provisional;
    return confirmIdentity(opened, await walk(readPlan), provisional);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
