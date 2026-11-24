/**
 * Strictly read-only, bounded, symlink- and UNC-safe file system helpers shared
 * by the NuGet `obj/project.assets.json` discovery and the MSBuild project model.
 *
 * Every read stays inside the real path of the workspace root: symbolic links
 * are never followed, the opened descriptor must be the same inode that was
 * checked, and the size is capped before and after opening. Nothing is ever
 * written.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/)/;

export function isUncOrDevicePath(raw: string): boolean
{
  if (raw.length < 2) return false;
  return UNC_OR_DEVICE_PREFIX.test(raw);
}

export function stripTrailingSeparators(p: string): string
{
  let end = p.length;
  while (end > 1 && (p.charCodeAt(end - 1) === 47 || p.charCodeAt(end - 1) === 92))
  {
    // Preserve Windows drive root (e.g. "C:\") and POSIX root ("/").
    if (end === 3 && p.charCodeAt(1) === 58) break;
    end -= 1;
  }
  return end === p.length ? p : p.slice(0, end);
}

function comparablePath(p: string): string
{
  const normalized = resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Same path after resolution (case-insensitive on Windows). */
export function isSamePath(a: string, b: string): boolean
{
  return comparablePath(a) === comparablePath(b);
}

export function isInsideRealDir(realParent: string, realCandidate: string): boolean
{
  const parentCmp = comparablePath(realParent);
  const candidateCmp = comparablePath(realCandidate);
  const prefix = parentCmp.endsWith(sep) ? parentCmp : `${parentCmp}${sep}`;
  return candidateCmp === parentCmp || candidateCmp.startsWith(prefix);
}

/**
 * Real path of a workspace root directory, or null when the input is empty,
 * relative, UNC/device-prefixed, a symbolic link or not a directory.
 */
export function resolveSafeRealRoot(rootDir: string): string | null
{
  if (rootDir.length === 0 || rootDir.includes("\0") || isUncOrDevicePath(rootDir) || !isAbsolute(rootDir))
  {
    return null;
  }

  const normalizedRoot = stripTrailingSeparators(rootDir);
  try
  {
    const rootStat = lstatSync(normalizedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const realRoot = realpathSync(normalizedRoot);
    return isUncOrDevicePath(realRoot) ? null : realRoot;
  }
  catch
  {
    return null;
  }
}

/** Reads a regular file inside `realRoot` (no symlinks, ≤ maxBytes); null on any doubt. */
export function readBoundedFileNoFollow(filePath: string, realRoot: string, maxBytes: number): string | null
{
  let leafStat;
  try
  {
    leafStat = lstatSync(filePath);
  }
  catch
  {
    return null;
  }
  if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null;
  if (leafStat.size > maxBytes) return null;

  let realFile: string;
  try
  {
    realFile = realpathSync(filePath);
  }
  catch
  {
    return null;
  }
  if (!isInsideRealDir(realRoot, realFile)) return null;

  const flags =
    (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try
  {
    // Read-only open (no file is created); the mode argument only documents that.
    fd = openSync(realFile, flags, 0o600);
  }
  catch
  {
    return null;
  }

  try
  {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (fdStat.size > maxBytes) return null;
    if (
      leafStat.ino !== 0 &&
      (fdStat.ino !== leafStat.ino || fdStat.dev !== leafStat.dev)
    )
    {
      return null;
    }

    const buffer = Buffer.allocUnsafe(Math.min(fdStat.size + 1, maxBytes + 1));
    let totalRead = 0;
    while (totalRead < buffer.length)
    {
      const bytesRead = readSync(fd, buffer, totalRead, buffer.length - totalRead, null);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    if (totalRead > maxBytes) return null;
    return buffer.subarray(0, totalRead).toString("utf8");
  }
  catch
  {
    return null;
  }
  finally
  {
    try
    {
      closeSync(fd);
    }
    catch
    {
      // Ignore close error.
    }
  }
}
