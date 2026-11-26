import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CausorynCliError, type CausorynCliErrorCode, type DirectoryOwnershipProbe } from "./types.js";

/**
 * CWE-59 guards for `causoryn setup` and the persistent runtime stage.
 *
 * Trust model: the user's home directory and explicitly configured host
 * directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are trusted *bases*. A base
 * itself may be reached through links (for example macOS `/var` ->
 * `/private/var`, or a configured directory that is a link: it is resolved
 * once by the OS), but no existing path component *below* a base may be a
 * symbolic link or a Windows junction. Removal never follows links.
 */

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function relativeSegments(baseDir: string, targetPath: string): string[] | null {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

/** The most specific trusted base that contains `targetPath`, or `null`. */
export function findTrustedBase(targetPath: string, bases: readonly string[]): string | null {
  let best: string | null = null;
  let bestDepth = -1;
  for (const base of bases) {
    if (relativeSegments(base, targetPath) === null) continue;
    const depth = path.resolve(base).split(path.sep).length;
    if (depth > bestDepth) {
      best = base;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Throws `cli/io-error` when an existing component strictly below `baseDir`
 * on the way to `targetPath` is a symbolic link / junction or not a
 * directory. The target itself is included when `includeTarget` is set
 * (directories that are created, replaced or removed as a whole).
 * Components that do not exist yet end the walk (they will be created as
 * real directories).
 */
export function assertNoLinkedComponents(
  targetPath: string,
  baseDir: string,
  options: { readonly includeTarget?: boolean; readonly purpose?: "write" | "read" } = {},
): void {
  const verb = options.purpose ?? "write";
  const segments = relativeSegments(baseDir, targetPath);
  if (segments === null) {
    throw new CausorynCliError(
      "cli/io-error",
      `Refusing to ${verb} outside the home directory or a configured host directory: ${targetPath}`,
    );
  }
  const checkCount = options.includeTarget === true ? segments.length : segments.length - 1;
  let current = path.resolve(baseDir);
  for (let index = 0; index < checkCount; index += 1) {
    current = path.join(current, segments[index] ?? "");
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return;
      throw new CausorynCliError(
        "cli/io-error",
        `Could not read the path status (${current}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (st.isSymbolicLink()) {
      throw new CausorynCliError(
        "cli/io-error",
        `Refusing to ${verb} through a symbolic link or junction for security reasons (CWE-59): ${current}. ` +
          "Point the host configuration (for example CLAUDE_CONFIG_DIR or CODEX_HOME) at the real directory instead.",
      );
    }
    if (!st.isDirectory()) {
      throw new CausorynCliError("cli/io-error", `A path component is not a directory: ${current}`);
    }
  }
}

/** Like {@link assertNoLinkedComponents} with the base picked from `bases`. */
export function assertSafeWritePath(
  targetPath: string,
  bases: readonly string[],
  options: { readonly includeTarget?: boolean; readonly purpose?: "write" | "read" } = {},
): void {
  const base = findTrustedBase(targetPath, bases);
  if (base === null) {
    throw new CausorynCliError(
      "cli/io-error",
      `Refusing to ${options.purpose ?? "write"} outside the home directory or a configured host directory: ${targetPath}`,
    );
  }
  assertNoLinkedComponents(targetPath, base, options);
}

/** The real process and file system (POSIX uid; none on Windows). */
export function defaultDirectoryOwnershipProbe(): DirectoryOwnershipProbe {
  return {
    platform: process.platform,
    uid: process.platform === "win32" ? undefined : process.getuid?.(),
    lstat: (dirPath) => lstatSync(dirPath),
  };
}

/**
 * CWE-732: throws `code` unless `dir` is a real directory (not a symbolic
 * link or junction) that, on POSIX, is owned by the current user and not
 * writable by group or other users, so no other local user can plant,
 * rename or replace entries in it. Windows ACLs are not inspected (there is
 * no uid / mode); only the link and type checks apply there.
 */
export function assertPrivateDirectory(
  dir: string,
  code: CausorynCliErrorCode,
  probe: DirectoryOwnershipProbe = defaultDirectoryOwnershipProbe(),
): void {
  let st;
  try {
    st = probe.lstat(dir);
  } catch (err) {
    throw new CausorynCliError(
      code,
      `Could not read the directory status (${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new CausorynCliError(
      code,
      `Refusing to use a directory that is a symbolic link or junction for security reasons (CWE-59): ${dir}`,
    );
  }
  if (!st.isDirectory()) {
    throw new CausorynCliError(code, `Refusing to use ${dir}: it is not a directory`);
  }
  if (probe.platform === "win32" || probe.uid === undefined) return;
  if (st.uid !== probe.uid) {
    throw new CausorynCliError(
      code,
      `Refusing to use ${dir}: it is owned by another user (uid ${String(st.uid)}, current uid ${String(probe.uid)}). ` +
        "Remove it or give it to the current user, then run setup again.",
    );
  }
  if ((st.mode & 0o022) !== 0) {
    throw new CausorynCliError(
      code,
      `Refusing to use ${dir}: it is writable by other users (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}). ` +
        `Restrict it with \`chmod go-w ${dir}\` and run setup again.`,
    );
  }
}

/** Non-throwing variant for removals: true when no component below a base is a link. */
export function isFreeOfLinkedComponents(
  targetPath: string,
  bases: readonly string[],
  options: { readonly includeTarget?: boolean } = {},
): boolean {
  try {
    assertSafeWritePath(targetPath, bases, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a file or directory tree without following links: a symbolic
 * link or junction is unlinked itself, its target is never touched.
 */
export function removeTreeNoFollow(targetPath: string): void {
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    unlinkSync(targetPath);
    return;
  }
  for (const name of readdirSync(targetPath)) {
    removeTreeNoFollow(path.join(targetPath, name));
  }
  rmdirSync(targetPath);
}

/**
 * Writes `data` to `tmpPath` with an exclusive create (`wx`), so an entry
 * planted at the temporary name is never followed or overwritten.
 */
export function writeExclusiveFile(tmpPath: string, data: string | Buffer, mode: number): void {
  if (typeof data === "string") {
    writeFileSync(tmpPath, data, { encoding: "utf8", mode, flag: "wx" });
  } else {
    writeFileSync(tmpPath, data, { mode, flag: "wx" });
  }
}

/**
 * Publishes a fully written temporary file at `destPath` without ever
 * replacing an existing entry: a hard link is atomic and fails with
 * `EEXIST`; file systems without hard links fall back to an exclusive copy.
 * Returns false when `destPath` already exists.
 */
export function publishFileNoClobber(tmpPath: string, destPath: string): boolean {
  try {
    linkSync(tmpPath, destPath);
    return true;
  } catch (err) {
    const code = errnoCode(err);
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS" && code !== "EINVAL") {
      throw err;
    }
  }
  try {
    copyFileSync(tmpPath, destPath, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
}

/**
 * Publishes a fully written temporary file at `destPath` with an exclusive
 * copy (`COPYFILE_EXCL`): an existing entry is never replaced. Unlike
 * {@link publishFileNoClobber} no hard link is made, so the file can later be
 * replaced by a rename again (on Windows a freshly hard-linked file briefly
 * makes such a rename fail with EPERM). Returns false when `destPath` exists.
 */
export function copyFileNoClobber(tmpPath: string, destPath: string): boolean {
  try {
    copyFileSync(tmpPath, destPath, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return false;
    throw err;
  }
}

/** Outcome of {@link readRegularFileText}. */
export type RegularFileTextRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "not-regular" };

const NO_FOLLOW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Reads a regular file's UTF-8 text through one descriptor: open first
 * (O_NOFOLLOW / O_NONBLOCK where available), then check the descriptor
 * (regular file, at most `maxBytes`) and the path (not a link, same
 * identity as the descriptor). The text returned always belongs to the
 * file that was checked; a link, special file or swapped file is
 * `not-regular`.
 */
export function readRegularFileText(filePath: string, maxBytes = 1024 * 1024): RegularFileTextRead {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, NO_FOLLOW_READ_FLAGS);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "not-regular" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return { kind: "not-regular" };
    const atPath = lstatSync(filePath);
    if (atPath.isSymbolicLink() || !atPath.isFile()) return { kind: "not-regular" };
    if (atPath.ino !== 0 && (atPath.dev !== opened.dev || atPath.ino !== opened.ino)) {
      return { kind: "not-regular" };
    }
    return { kind: "ok", text: readFileSync(fd, "utf8") };
  } catch {
    return { kind: "not-regular" };
  } finally {
    closeSync(fd);
  }
}
