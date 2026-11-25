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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** O_NONBLOCK keeps an open of a FIFO from waiting; regular-file reads are unaffected. */
const NOFOLLOW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
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
 * Reads a regular file through one descriptor: open (O_NOFOLLOW / O_NONBLOCK
 * where available), then check the descriptor (regular file, size) and the
 * path (lstat: not a link, same dev/ino as the descriptor). Symlinks, special
 * files, a file swapped around the open and a file larger than `maxBytes`
 * yield null; the bytes returned always belong to the checked file.
 */
export function readRegularFileBytesNoFollow(filePath: string, maxBytes?: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (maxBytes !== undefined && fdStat.size > maxBytes) return null;
    const st: Stats = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
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
 * Streams a regular file through SHA-256 and returns the digest together
 * with the identity of the file that was hashed. Same order as
 * {@link readRegularFileBytesNoFollow}: open, check the descriptor, then
 * check the path (not a link, same identity); null for symlinks, special
 * files or a file swapped around the open.
 */
export function hashRegularFileNoFollow(
  filePath: string,
): { readonly sha256: string; readonly identity: FileIdentity } | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) return null;
    const st: BigIntStats = lstatSync(filePath, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) return null;
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

const TOOLCHAIN_CONFIG_FILES = [
  [".cargo", "config.toml"],
  [".cargo", "config"],
  ["rust-toolchain.toml"],
  ["rust-toolchain"],
] as const;

function isSameOrBelow(candidate: string, root: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = relative(normalize(root), normalize(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * cargo reads `.cargo/config.toml` (and the legacy `.cargo/config`) from
 * its working directory and every ancestor, and rustup reads
 * `rust-toolchain.toml` / `rust-toolchain` the same way. Returns the first
 * such file in or above `dir` that cannot be vouched for, or null:
 * - files in or below `trustedRoot` (the user's home directory) are the
 *   user's own configuration,
 * - elsewhere a file is accepted on POSIX only when it and its directory are
 *   owned by root or by the current user; on Windows, where Node exposes no
 *   owner, it is not accepted (e.g. `C:\.cargo\config.toml`, which any
 *   local user can create).
 */
export function untrustedToolchainConfigAbove(
  dir: string,
  trustedRoot: string | null,
): string | null {
  let current: string;
  try {
    current = realpathSync.native(dir);
  } catch {
    current = resolve(dir);
  }
  const uid = currentUid();
  for (;;) {
    for (const segments of TOOLCHAIN_CONFIG_FILES) {
      const candidate = join(current, ...segments);
      let st: Stats;
      try {
        st = lstatSync(candidate);
      } catch {
        continue;
      }
      if (trustedRoot !== null && isSameOrBelow(candidate, trustedRoot)) continue;
      if (uid === undefined) return candidate;
      let parentOwner: number;
      try {
        parentOwner = lstatSync(dirname(candidate)).uid;
      } catch {
        return candidate;
      }
      const owners = [st.uid, parentOwner];
      if (owners.some((owner) => owner !== 0 && owner !== uid)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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
