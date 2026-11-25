/**
 * File integrity helpers for the Rust worker build cache.
 *
 * - Files are read with lstat + O_NOFOLLOW + fstat identity matching, so a
 *   symlink, a special file or a file swapped between lstat and open is
 *   rejected.
 * - A cached file is only trusted when it is a regular file with exactly
 *   one hard link and, on POSIX, owned by the current user and not
 *   writable by group/other users.
 * - The cache directory is private to the current user (POSIX 0700) and
 *   lies below ancestors that other users cannot rename entries in.
 * - The identity (device, inode, size, mtime) of a hashed file is recorded
 *   so the file can be re-checked right before it is executed.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const PRIVATE_DIR_MODE = 0o700;
const STICKY_BIT = 0o1000;

/** Identity of a file at the time it was hashed. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

function identityOf(st: BigIntStats): FileIdentity {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs };
}

/** True when both identities describe the same, unchanged file. */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/**
 * Current identity of a single-link regular file (symlinks are not
 * followed); null when the path is missing, not a regular file or has more
 * than one hard link.
 */
export function readFileIdentity(filePath: string): FileIdentity | null {
  try {
    const st = lstatSync(filePath, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) return null;
    return identityOf(st);
  } catch {
    return null;
  }
}

function currentUid(): number | undefined {
  return process.platform === "win32" ? undefined : process.getuid?.();
}

/**
 * Why a cached file must not be trusted, or null when it may be: it must be
 * a regular file with exactly one hard link (another link could be changed
 * through a path outside the cache) and, on POSIX, owned by the current user
 * and not writable by group/other users.
 */
export function untrustedFileReason(st: Stats, label: string): string | null {
  if (st.isSymbolicLink() || !st.isFile()) {
    return `${label} is a symlink or not a regular file (rejected)`;
  }
  if (st.nlink !== 1) {
    return `${label} has more than one hard link (rejected)`;
  }
  const uid = currentUid();
  if (uid !== undefined) {
    if (st.uid !== uid) return `${label} is not owned by the current user (rejected)`;
    if ((st.mode & 0o022) !== 0) return `${label} is writable by other users (rejected)`;
  }
  return null;
}

/**
 * Reads a regular file with lstat + O_NOFOLLOW + fstat identity matching.
 * Symlinks, special files and files swapped between lstat and open yield
 * null, as does a file larger than `maxBytes`.
 */
export function readRegularFileBytesNoFollow(filePath: string, maxBytes?: number): Buffer | null {
  let st: Stats;
  try {
    st = lstatSync(filePath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (maxBytes !== undefined && st.size > maxBytes) return null;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (st.ino !== 0 && (fdStat.dev !== st.dev || fdStat.ino !== st.ino)) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      total += read;
      if (maxBytes !== undefined && total > maxBytes) return null;
      chunks.push(Buffer.from(buf.subarray(0, read)));
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

/**
 * Streams a regular file through SHA-256 (lstat + O_NOFOLLOW + fstat
 * identity matching) and returns the digest together with the identity of
 * the file that was hashed; null for symlinks, special files or a swap
 * between lstat and open.
 */
export function hashRegularFileNoFollow(
  filePath: string,
): { readonly sha256: string; readonly identity: FileIdentity } | null {
  let st: BigIntStats;
  try {
    st = lstatSync(filePath, { bigint: true });
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) return null;
    if (st.ino !== 0n && (fdStat.dev !== st.dev || fdStat.ino !== st.ino)) return null;
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
    // The identity is taken after reading: a write during hashing changes mtime.
    return { sha256: hash.digest("hex"), identity: identityOf(fstatSync(fd, { bigint: true })) };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

/** SHA-256 hex digest of a regular file read with O_NOFOLLOW; null when rejected. */
export function readRegularFileSha256NoFollow(filePath: string): string | null {
  return hashRegularFileNoFollow(filePath)?.sha256 ?? null;
}

/**
 * Makes `dir` a private cache directory and checks that it can be trusted.
 * Returns null when it can, otherwise an English reason.
 * - `create`: a missing directory is created (mode 0700); otherwise a
 *   missing directory is reported as such.
 * - POSIX: the directory must be owned by the current user; group/other
 *   permission bits are removed. Every ancestor must be owned by root or by
 *   the current user, and a world-writable ancestor must have the sticky
 *   bit, so no other user can rename the cache away and put another one in
 *   its place. (Group-writable ancestors are accepted.)
 * - The directory itself must not be a symlink.
 */
export function preparePrivateDirectory(dir: string, create: boolean): string | null {
  if (create) {
    try {
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `the directory could not be created (${dir}): ${detail}`;
    }
  }
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch {
    return `the directory does not exist (${dir})`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return `the path is a symlink or not a directory (${dir})`;
  }
  const uid = currentUid();
  if (uid === undefined) return null;
  if (st.uid !== uid) {
    return `the directory is not owned by the current user (${dir})`;
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, PRIVATE_DIR_MODE);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `the directory permissions could not be restricted to the current user (${dir}): ${detail}`;
    }
    const after = lstatSync(dir);
    if ((after.mode & 0o077) !== 0) {
      return `the directory permissions could not be restricted to the current user (${dir})`;
    }
  }
  let current: string;
  try {
    current = realpathSync.native(dir);
  } catch {
    return `the directory could not be resolved (${dir})`;
  }
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    let ancestor: Stats;
    try {
      ancestor = lstatSync(current);
    } catch {
      return `an ancestor directory could not be inspected (${current})`;
    }
    if (ancestor.uid !== 0 && ancestor.uid !== uid) {
      return `an ancestor directory is owned by another user (${current})`;
    }
    if ((ancestor.mode & 0o002) !== 0 && (ancestor.mode & STICKY_BIT) === 0) {
      return `an ancestor directory is writable by all users without the sticky bit (${current})`;
    }
  }
  return null;
}
