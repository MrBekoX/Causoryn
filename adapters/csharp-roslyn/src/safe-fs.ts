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
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/|\\\?\?\\)/;

/** UNC (`\\host\share`, mixed separators), Win32 device (`\\.\`, `\\?\`) or NT (`\??\`) path. */
export function isUncOrDevicePath(raw: string): boolean
{
  if (raw.length < 2) return false;
  return UNC_OR_DEVICE_PREFIX.test(raw);
}

/** Fully qualified local path: `C:\...` / `C:/...` on Windows, `/...` elsewhere. */
export function isFullyQualifiedLocalPath(raw: string): boolean
{
  if (raw.length === 0 || raw.includes("\0") || isUncOrDevicePath(raw)) return false;
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(raw) : raw.startsWith("/");
}

/** Maximum number of links resolved while walking one path. */
const MAX_LINK_HOPS = 32;

/** `\\?\C:\`, `//?/C:/` and `\??\C:\` prefixes of an extended-length local drive path. */
const EXTENDED_LOCAL_DRIVE_PREFIX = /^(?:\\\\\?\\|\/\/\?\/|\\\?\?\\)(?=[A-Za-z]:[\\/])/;

/**
 * Walks an absolute local path component by component with `lstat` and
 * resolves links by reading their targets. Returns the link-free path, or
 * null when a component is missing, a link target is a UNC, device, NT or
 * drive-relative path (such a target is never touched), or after too many
 * links. Only components whose parent chain is already verified are
 * inspected, so no remote host is contacted through a link.
 */
export function walkLocalPath(absolute: string): string | null
{
  if (!isFullyQualifiedLocalPath(absolute)) return null;
  let pending = resolve(absolute);
  let hops = 0;
  for (;;)
  {
    const root = parse(pending).root;
    if (root.length === 0 || isUncOrDevicePath(root)) return null;
    const segments = pending.slice(root.length).split(sep).filter((segment) => segment.length > 0);
    let current = root;
    let restartFrom: string | null = null;
    for (let index = 0; index < segments.length; index += 1)
    {
      const next = join(current, segments[index]!);
      let stat;
      try
      {
        stat = lstatSync(next, { throwIfNoEntry: false });
      }
      catch
      {
        return null;
      }
      if (stat === undefined) return null;
      if (stat.isSymbolicLink())
      {
        hops += 1;
        if (hops > MAX_LINK_HOPS) return null;
        let target: string;
        try
        {
          target = readlinkSync(next);
        }
        catch
        {
          return null;
        }
        const local = target.replace(EXTENDED_LOCAL_DRIVE_PREFIX, "");
        if (local.length === 0 || local.includes("\0") || isUncOrDevicePath(local)) return null;
        if (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(local)) return null;
        // Relative and root-relative targets resolve against the link's (verified) parent.
        restartFrom = join(resolve(current, local), ...segments.slice(index + 1));
        break;
      }
      if (index < segments.length - 1 && !stat.isDirectory()) return null;
      current = next;
    }
    if (restartFrom === null) return current;
    pending = restartFrom;
  }
}

/**
 * Real path (`realpathSync`, the form used by the rest of this adapter) of an
 * existing local directory, or null when the path is not fully qualified, is
 * reached through a link to a UNC/device target, is not a directory, or its
 * real path is remote.
 */
export function resolveLocalRealDirectory(absolute: string): string | null
{
  if (walkLocalPath(absolute) === null) return null;
  try
  {
    const real = realpathSync(stripTrailingSeparators(absolute));
    if (isUncOrDevicePath(real)) return null;
    return lstatSync(real).isDirectory() ? real : null;
  }
  catch
  {
    return null;
  }
}

/**
 * Operating-system canonical form of an already link-free real path (on
 * Windows this also expands 8.3 short names), used only for comparisons;
 * null when it cannot be determined or is remote.
 */
export function canonicalLocalPath(realPath: string): string | null
{
  if (!isFullyQualifiedLocalPath(realPath)) return null;
  try
  {
    const canonical = realpathSync.native(realPath);
    return isUncOrDevicePath(canonical) ? null : canonical;
  }
  catch
  {
    return null;
  }
}

/**
 * True when every component of `candidate` below `realBase` exists and is no
 * symbolic link or junction, intermediate components are directories and the
 * leaf has the requested kind. `candidate` must lie lexically inside
 * `realBase`; nothing outside it is inspected and no link is followed.
 */
export function isLinkFreeBelow(
  realBase: string,
  candidate: string,
  leaf: "file" | "directory" | "any" = "any",
): boolean
{
  if (candidate.includes("\0") || isUncOrDevicePath(candidate)) return false;
  const base = resolve(realBase);
  const rel = relative(base, resolve(candidate));
  if (rel.length === 0) return leaf !== "file";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  let current = base;
  const segments = rel.split(sep);
  for (let index = 0; index < segments.length; index += 1)
  {
    current = join(current, segments[index]!);
    let stat;
    try
    {
      stat = lstatSync(current, { throwIfNoEntry: false });
    }
    catch
    {
      return false;
    }
    if (stat === undefined || stat.isSymbolicLink()) return false;
    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) return false;
    if (isLast && leaf === "file" && !stat.isFile()) return false;
    if (isLast && leaf === "directory" && !stat.isDirectory()) return false;
  }
  return true;
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
    // Ancestors are walked first so a link to a remote target is never followed.
    if (walkLocalPath(normalizedRoot) === null) return null;
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
  // No intermediate component may be a link: lstat of the leaf would otherwise
  // traverse it (possibly to a remote host) before the real-path check below.
  if (!isLinkFreeBelow(realRoot, filePath, "file")) return null;
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
