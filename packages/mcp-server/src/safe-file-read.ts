import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Result of a bounded, descriptor-based optional text read (TŞ §19/§20
 * per-file byte budget; CWE-59 link following and CWE-367 TOCTOU hardening).
 */
export type BoundedTextReadResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large"; readonly bytes: number };

export interface BoundedTextReadOptions {
  /**
   * Directory the file must stay inside. Any spelling is accepted (a path
   * under a symlinked ancestor such as macOS `/var`, or a Windows 8.3 short
   * path): the root is canonicalised with realpath, only the segments below
   * it are checked, and containment is decided on canonical forms.
   *
   * When omitted, the filesystem root is used: every segment of
   * `absolutePath` must then be a real directory, which holds for paths
   * joined onto a realpath'd workspace root (the production call pattern).
   */
  readonly root?: string;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * O_NOFOLLOW refuses a final-component symlink, O_NONBLOCK keeps open(2) on a
 * FIFO from waiting for a writer, O_NOCTTY keeps a terminal from becoming the
 * controlling tty. All three are POSIX-only (undefined on Windows), where the
 * lstat walk plus the descriptor identity check provide the guarantee.
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOCTTY ?? 0);

/** Path verification plan: the normalised target and how far to walk. */
interface ReadPlan {
  readonly target: string;
  /** Canonical root for an explicit `root`; undefined walks to the filesystem root. */
  readonly canonicalRoot: string | undefined;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isUsablePath(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

function normalizedTarget(absolutePath: string, options: BoundedTextReadOptions | undefined): string | undefined {
  if (!isUsablePath(absolutePath)) return undefined;
  if (options?.root !== undefined && !isUsablePath(options.root)) return undefined;
  // The lexically normalised path is both what gets verified and what gets
  // opened, so '..' segments cannot be resolved differently by the OS.
  return path.resolve(absolutePath);
}

/**
 * Verifies the target with lstat, bottom-up: the file itself must be a
 * regular file (not a symlink, FIFO, device, socket or directory) and every
 * ancestor below the root must be a real directory, not a symlink or
 * junction. With an explicit root the walk stops at the first ancestor whose
 * realpath is the canonical root, and the file's realpath must lie strictly
 * inside that root. Returns the file's lstat identity, or undefined.
 */
function verifyPathSync(plan: ReadPlan): BigIntStats | undefined {
  const fileStat = lstatSync(plan.target, { bigint: true });
  if (!fileStat.isFile()) return undefined;
  let dir = path.dirname(plan.target);
  for (;;) {
    const parent = path.dirname(dir);
    if (plan.canonicalRoot === undefined) {
      if (parent === dir) break;
    } else if (realpathSync.native(dir) === plan.canonicalRoot) {
      break;
    }
    const dirStat = lstatSync(dir, { bigint: true });
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined;
    if (parent === dir) return undefined;
    dir = parent;
  }
  if (
    plan.canonicalRoot !== undefined &&
    !isStrictlyInside(plan.canonicalRoot, realpathSync.native(plan.target))
  ) {
    return undefined;
  }
  return fileStat;
}

/** Async counterpart of {@link verifyPathSync} (fs/promises realpath is the native one). */
async function verifyPath(plan: ReadPlan): Promise<BigIntStats | undefined> {
  const fileStat = await lstat(plan.target, { bigint: true });
  if (!fileStat.isFile()) return undefined;
  let dir = path.dirname(plan.target);
  for (;;) {
    const parent = path.dirname(dir);
    if (plan.canonicalRoot === undefined) {
      if (parent === dir) break;
    } else if ((await realpath(dir)) === plan.canonicalRoot) {
      break;
    }
    const dirStat = await lstat(dir, { bigint: true });
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return undefined;
    if (parent === dir) return undefined;
    dir = parent;
  }
  if (
    plan.canonicalRoot !== undefined &&
    !isStrictlyInside(plan.canonicalRoot, await realpath(plan.target))
  ) {
    return undefined;
  }
  return fileStat;
}

/**
 * Descriptor checks shared by both variants: the opened object must be a
 * regular file with the same (dev, ino) as the pre-open lstat and as a
 * re-verification of the path after open. A path component swapped for a
 * symlink around open(2) therefore cannot hand over a different file.
 */
function descriptorMatches(
  opened: BigIntStats,
  before: BigIntStats,
  after: BigIntStats | undefined,
): boolean {
  return (
    opened.isFile() &&
    sameIdentity(opened, before) &&
    after !== undefined &&
    sameIdentity(opened, after)
  );
}

function decodeBounded(
  chunks: readonly Buffer[],
  totalBytes: number,
  maxBytes: number,
): BoundedTextReadResult {
  if (totalBytes > maxBytes) {
    return { status: "too-large", bytes: totalBytes };
  }
  const text = Buffer.concat(chunks, totalBytes).toString("utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    return { status: "too-large", bytes };
  }
  return { status: "ok", text };
}

/**
 * Reads an optional text file that must stay inside a root, through a single
 * descriptor with at most `maxBytes + 1` bytes read.
 *
 * Order: lstat walk + realpath containment (no open of a non-regular file),
 * open with O_NOFOLLOW|O_NONBLOCK|O_NOCTTY where available, fstat identity
 * match against the pre-open lstat and a post-open re-verification, size
 * check from fstat, bounded read, UTF-8 decode.
 *
 * - `{ status: "missing" }`: the file does not exist, is not a regular file,
 *   is reached through a symlink/junction below the root, resolves outside
 *   the root, changed identity around open, or could not be read.
 * - `{ status: "too-large", bytes }`: the fstat size, the bytes read or the
 *   decoded UTF-8 length exceeds `maxBytes`.
 */
export async function readOptionalBoundedTextFile(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedTextReadOptions,
): Promise<BoundedTextReadResult> {
  const target = normalizedTarget(absolutePath, options);
  if (target === undefined) return { status: "missing" };

  let plan: ReadPlan;
  let before: BigIntStats | undefined;
  try {
    plan = {
      target,
      canonicalRoot: options?.root === undefined ? undefined : await realpath(options.root),
    };
    before = await verifyPath(plan);
  } catch {
    return { status: "missing" };
  }
  if (before === undefined) return { status: "missing" };

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, OPEN_FLAGS);
  } catch {
    return { status: "missing" };
  }

  try {
    const opened = await handle.stat({ bigint: true });
    const after = await verifyPath(plan);
    if (!descriptorMatches(opened, before, after)) {
      return { status: "missing" };
    }
    const size = Number(opened.size);
    if (size > maxBytes) {
      return { status: "too-large", bytes: size };
    }

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, maxRead));
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < maxRead) {
      const toRead = Math.min(chunkSize, maxRead - totalBytes);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return decodeBounded(chunks, totalBytes, maxBytes);
  } catch {
    return { status: "missing" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Synchronous counterpart of {@link readOptionalBoundedTextFile} (same
 * checks with lstatSync/realpathSync.native, openSync, fstatSync, bounded
 * readSync and closeSync in `finally`).
 */
export function readOptionalBoundedTextFileSync(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedTextReadOptions,
): BoundedTextReadResult {
  const target = normalizedTarget(absolutePath, options);
  if (target === undefined) return { status: "missing" };

  let plan: ReadPlan;
  let before: BigIntStats | undefined;
  try {
    plan = {
      target,
      canonicalRoot:
        options?.root === undefined ? undefined : realpathSync.native(options.root),
    };
    before = verifyPathSync(plan);
  } catch {
    return { status: "missing" };
  }
  if (before === undefined) return { status: "missing" };

  let fd: number;
  try {
    fd = openSync(target, OPEN_FLAGS);
  } catch {
    return { status: "missing" };
  }

  try {
    const opened = fstatSync(fd, { bigint: true });
    const after = verifyPathSync(plan);
    if (!descriptorMatches(opened, before, after)) {
      return { status: "missing" };
    }
    const size = Number(opened.size);
    if (size > maxBytes) {
      return { status: "too-large", bytes: size };
    }

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, maxRead));
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < maxRead) {
      const toRead = Math.min(chunkSize, maxRead - totalBytes);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return decodeBounded(chunks, totalBytes, maxBytes);
  } catch {
    return { status: "missing" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure is not actionable for an optional read.
    }
  }
}
