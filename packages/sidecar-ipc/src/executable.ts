/**
 * Absolute executable resolution for every child process Causoryn starts.
 *
 * Why: when Node/libuv is given a bare command name on Windows it searches
 * the child's working directory BEFORE PATH (unless the
 * `NoDefaultCurrentDirectoryInExePath` environment variable happens to be
 * set). On POSIX an empty or "." PATH entry has the same effect. When the
 * server runs with cwd = the analyzed repository (`--allow-cwd`), a file
 * committed to that repository could therefore be started instead of the
 * real tool. Every external tool is resolved here to an ABSOLUTE path by
 * scanning PATH ourselves:
 * - empty, relative, drive-relative, UNC and device PATH entries are skipped,
 * - PATH entries inside an untrusted root (the analyzed workspace) are skipped,
 * - on win32 the name is tried as-is (only when it already has an extension)
 *   and then with `.com` / `.exe` appended, mirroring libuv's search order;
 *   `.cmd` / `.bat` are never candidates (they cannot run with shell:false),
 * - on POSIX the candidate must be an executable regular file.
 *
 * NOTE: `packages/graph/src/executable-resolution.ts` is a self-contained
 * copy of this module (graph does not depend on sidecar-ipc). Keep the two
 * in sync; `tests/executable-resolution.test.ts` runs one suite against both.
 */
import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExecutableSearchEnv = Readonly<Record<string, string | undefined>>;

export interface ResolveExecutableOptions {
  /** Environment whose PATH is searched; defaults to process.env. */
  readonly env?: ExecutableSearchEnv;
  /** PATH entries inside these roots are never searched. */
  readonly untrustedRoots?: readonly string[];
  /** Extra directories searched before PATH (same filtering rules). */
  readonly prependDirs?: readonly string[];
  /** Platform semantics to apply; defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

type PathApi = typeof path.win32;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function isUncOrDevicePath(value: string): boolean {
  return /^(?:\\\\|\/\/|\\\/|\/\\)/.test(value);
}

/** Fully qualified local path: `C:\...` on win32, `/...` on POSIX. */
export function isFullyQualifiedPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(value);
  return value.startsWith("/");
}

/** Reads PATH from an env object (case-insensitive key lookup on win32). */
export function readPathVariable(
  env: ExecutableSearchEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const direct = env["PATH"];
  if (typeof direct === "string") return direct;
  if (platform === "win32") {
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === "PATH" && typeof value === "string") {
        return value;
      }
    }
  }
  return "";
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  let resolved = api.resolve(value);
  const root = api.parse(resolved).root;
  while (resolved.length > root.length && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.slice(0, -1);
  }
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  const c = comparable(candidate, platform);
  const r = comparable(root, platform);
  if (c === r) return true;
  const sep = platform === "win32" ? "\\" : "/";
  const boundary = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(boundary);
}

function realpathOrSelf(value: string, platform: NodeJS.Platform): string {
  if (platform !== process.platform) return value;
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * True when `candidate` equals or lies inside any untrusted root, compared
 * both lexically and after resolving symlinks/junctions.
 */
export function isWithinUntrustedRoots(
  candidate: string,
  untrustedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (untrustedRoots.length === 0) return false;
  const candidates = [candidate, realpathOrSelf(candidate, platform)];
  for (const root of untrustedRoots) {
    if (!isFullyQualifiedPath(root, platform)) continue;
    const roots = [root, realpathOrSelf(root, platform)];
    for (const c of candidates) {
      for (const r of roots) {
        if (isSameOrInside(c, r, platform)) return true;
      }
    }
  }
  return false;
}

/**
 * Filters a list of search directories: keeps only fully qualified local
 * directories that are outside every untrusted root (deduplicated, order
 * preserved).
 */
export function trustedSearchDirectories(
  entries: readonly string[],
  untrustedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    let entry = raw;
    if (platform === "win32") {
      entry = entry.trim();
      if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
        entry = entry.slice(1, -1);
      }
    }
    if (entry.length === 0 || entry.includes("\0")) continue;
    if (isUncOrDevicePath(entry)) continue;
    if (!isFullyQualifiedPath(entry, platform)) continue;
    if (isWithinUntrustedRoots(entry, untrustedRoots, platform)) continue;
    const key = comparable(entry, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** PATH value with untrusted / relative / empty entries removed. */
export function sanitizePathValue(
  pathValue: string,
  untrustedRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return trustedSearchDirectories(
    pathValue.split(pathDelimiter(platform)),
    untrustedRoots,
    platform,
  ).join(pathDelimiter(platform));
}

function candidateFileNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  const names = path.win32.extname(name).length > 0 ? [name] : [];
  names.push(`${name}.com`, `${name}.exe`);
  return names;
}

function isRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    if (platform !== "win32") {
      accessSync(candidate, fsConstants.X_OK);
    }
    return true;
  } catch (error) {
    if (platform !== "win32") return false;
    // Windows app execution aliases (WindowsApps\python.exe etc.) are reparse
    // points that stat() cannot open (EACCES) but CreateProcess can start.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "UNKNOWN") return false;
    try {
      return lstatSync(candidate).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/**
 * Resolves `command` to an absolute executable path, or null.
 * - A fully qualified path is returned unchanged (explicit configuration).
 * - A bare name is searched in `prependDirs` + PATH with the filtering rules
 *   described in the module header.
 * - Anything else (relative path, drive-relative path, UNC/device path,
 *   empty or NUL-containing value) is refused (null).
 */
export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    return null;
  }
  if (command.trim() !== command) return null;
  if (isUncOrDevicePath(command)) return null;
  if (isFullyQualifiedPath(command, platform)) return command;
  if (
    command.includes("/") ||
    (platform === "win32" && (command.includes("\\") || command.includes(":"))) ||
    command === "." ||
    command === ".."
  ) {
    return null;
  }

  const api = pathApi(platform);
  const untrustedRoots = options.untrustedRoots ?? [];
  const env = options.env ?? process.env;
  const searchDirs = trustedSearchDirectories(
    [
      ...(options.prependDirs ?? []),
      ...readPathVariable(env, platform).split(pathDelimiter(platform)),
    ],
    untrustedRoots,
    platform,
  );
  for (const dir of searchDirs) {
    for (const fileName of candidateFileNames(command, platform)) {
      const candidate = api.join(dir, fileName);
      if (!isRunnableFile(candidate, platform)) continue;
      if (isWithinUntrustedRoots(candidate, untrustedRoots, platform)) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * The process cwd as an untrusted root (the default `--allow-cwd` setup
 * analyzes the cwd). A filesystem root, the home directory and any ancestor
 * of the home directory are NOT treated as untrusted: excluding them would
 * hide every user-level toolchain (e.g. ~/.cargo/bin) without protecting a
 * specific workspace.
 */
export function processCwdUntrustedRoot(): string | null {
  let cwd: string;
  try {
    cwd = path.resolve(process.cwd());
  } catch {
    return null;
  }
  if (path.dirname(cwd) === cwd) return null;
  const home = os.homedir();
  if (home.length > 0 && isSameOrInside(home, cwd, process.platform)) return null;
  return cwd;
}

/**
 * Untrusted roots for PATH filtering: the explicitly analyzed workspace
 * root(s) plus the process cwd (see processCwdUntrustedRoot).
 */
export function collectUntrustedRoots(
  explicitRoots: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const key = comparable(value, process.platform);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(path.resolve(value));
  };
  for (const root of explicitRoots) {
    if (typeof root === "string" && isFullyQualifiedPath(root)) add(root);
  }
  const cwdRoot = processCwdUntrustedRoot();
  if (cwdRoot !== null) add(cwdRoot);
  return roots;
}

/**
 * First candidate that is an existing absolute directory outside every
 * untrusted root; null when none qualifies.
 */
export function trustedWorkingDirectory(
  candidates: ReadonlyArray<string | null | undefined>,
  untrustedRoots: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isFullyQualifiedPath(candidate)) continue;
    if (isWithinUntrustedRoots(candidate, untrustedRoots)) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not usable
    }
  }
  return null;
}

/**
 * Absolute path of a Windows system tool such as `taskkill.exe`:
 * `%SystemRoot%\System32\<fileName>`, falling back to
 * `C:\Windows\System32\<fileName>` when SystemRoot is missing or malformed.
 */
export function resolveWindowsSystemExecutable(
  fileName: string,
  env: ExecutableSearchEnv = process.env,
): string {
  let systemRoot: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if ((upper === "SYSTEMROOT" || upper === "WINDIR") && typeof value === "string") {
      if (systemRoot === undefined || upper === "SYSTEMROOT") systemRoot = value;
    }
  }
  const valid =
    systemRoot !== undefined &&
    /^[A-Za-z]:\\[^;"<>|?*\0]*$/.test(systemRoot) &&
    !systemRoot.split(/[\\/]/).includes("..");
  const root = valid ? systemRoot!.replace(/[\\/]+$/, "") : "C:\\Windows";
  return path.win32.join(root, "System32", fileName);
}
