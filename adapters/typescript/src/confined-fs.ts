/**
 * Read-only, link-aware file system probe used by the confined TypeScript
 * compiler host (see `configureConfinedCompilerHost` in analyzer.ts).
 *
 * The host never hands a path to a following file system call (`stat`,
 * `realpath`, `readFile`) before it has walked the path itself: every
 * component is inspected with `lstat`, symbolic links and junctions are
 * resolved by reading their target lexically, and a target that is a UNC,
 * device or NT-namespace path, or that leaves the allowed regions, is never
 * touched. This module provides the primitive operations of that walk and the
 * lexical classification of link targets; it never writes anything.
 */

/** Kind of a directory entry as reported by `lstat` (links are never followed). */
export type ConfinedFsEntryKind = "file" | "directory" | "symlink" | "other";

export interface ConfinedFsStat {
  readonly kind: ConfinedFsEntryKind;
  /** Size in bytes (meaningful for regular files). */
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
}

export type ConfinedReadResult =
  | { readonly status: "ok"; readonly text: string; readonly bytes: number }
  | { readonly status: "too-large" }
  | { readonly status: "unreadable" };

/**
 * File system operations the confined host may perform. Every method is
 * read-only and must not follow a link at the last path component, except
 * `realpath`, which is used only for the trusted region bases (the workspace
 * root and the bundled TypeScript lib directory).
 */
export interface ConfinedFsProbe {
  /** Real path of a trusted base directory; undefined when it cannot be resolved. */
  realpath(path: string): string | undefined;
  /** `lstat` of the path; undefined when it does not exist or cannot be inspected. */
  lstat(path: string): ConfinedFsStat | undefined;
  /** Raw target of a symbolic link or junction; undefined when it cannot be read. */
  readlink(path: string): string | undefined;
  /** Entry names of a directory; undefined when it cannot be listed. */
  readdir(path: string): readonly string[] | undefined;
  /**
   * Reads a regular file whose `lstat` result is `expected`. Implementations
   * must refuse non-regular files (FIFOs, devices, sockets), a file that was
   * replaced after `expected` was taken, and files larger than `maxBytes`.
   */
  readText(path: string, expected: ConfinedFsStat, maxBytes: number): ConfinedReadResult;
}

/** Maximum size of one declaration / package.json file read from disk (16 MiB). */
export const MAX_CONFINED_DISK_FILE_BYTES = 16 * 1024 * 1024;

/** Maximum total bytes the confined host reads from disk in one analysis run (512 MiB). */
export const MAX_CONFINED_DISK_TOTAL_BYTES = 512 * 1024 * 1024;

/** Maximum number of symbolic links resolved while walking one path. */
export const MAX_CONFINED_LINK_HOPS = 32;

const UNC_DEVICE_OR_NT_PREFIX = /^(?:[\\/]{2}|\\\?\?\\)/;

/**
 * True for UNC (`\\host\share`, `//host/share`, mixed separators), Win32
 * device / extended-length (`\\.\`, `\\?\`) and NT-namespace (`\??\`) paths.
 * Such paths are never passed to the file system by the confined host.
 */
export function isUncDeviceOrNtPath(raw: string): boolean {
  return raw.length >= 2 && UNC_DEVICE_OR_NT_PREFIX.test(raw);
}

const EXTENDED_LOCAL_DRIVE_PREFIX = /^(?:\\\\\?\\|\/\/\?\/|\\\?\?\\)(?=[a-zA-Z]:[\\/])/;

/**
 * Classifies the raw target of a link. Returns the target with `\` turned
 * into `/` when it is a local path (absolute POSIX, drive-absolute or
 * relative), `undefined` when it is a UNC, device or NT-namespace path or a
 * drive-relative path such as `C:foo`. Extended-length local drive paths
 * (`\\?\C:\x`, `\??\C:\x`) are accepted as `C:/x`.
 */
export function classifyLinkTarget(raw: string): string | undefined {
  if (raw.length === 0 || raw.includes("\0")) return undefined;
  const withoutExtendedPrefix = raw.replace(EXTENDED_LOCAL_DRIVE_PREFIX, "");
  if (isUncDeviceOrNtPath(withoutExtendedPrefix)) return undefined;
  const posix = withoutExtendedPrefix.replace(/\\/g, "/");
  if (/^[a-zA-Z]:(?!\/)/.test(posix)) return undefined;
  return posix;
}

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

/**
 * True when a path segment may be passed to the file system. On Windows-style
 * paths (drive anchor) alternate data streams (`name:stream`) and reserved
 * device names (`CON`, `NUL.d.ts`, `COM1`, ...) are refused.
 */
export function isSafePathSegment(segment: string, windowsStyle: boolean): boolean {
  if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("\0")) {
    return false;
  }
  if (!windowsStyle) return true;
  if (segment.includes(":")) return false;
  const dot = segment.indexOf(".");
  const stem = (dot < 0 ? segment : segment.slice(0, dot)).replace(/[ .]+$/, "");
  return !WINDOWS_RESERVED_DEVICE_NAME.test(stem);
}

/* ------------------------------------------------------------------ */
/* Node.js implementation                                              */
/* ------------------------------------------------------------------ */

interface NodeStatLike {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
}

interface NodeFsLike {
  readonly constants?: {
    readonly O_RDONLY?: number;
    readonly O_NOFOLLOW?: number;
    readonly O_NONBLOCK?: number;
  };
  lstatSync(path: string, options?: { readonly throwIfNoEntry?: boolean }): NodeStatLike | undefined;
  readlinkSync(path: string): string;
  readdirSync(path: string): string[];
  realpathSync: { native(path: string): string };
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): NodeStatLike;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
}

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

type TextDecoderCtor = new (
  label?: string,
  options?: { readonly ignoreBOM?: boolean },
) => TextDecoderLike;

function loadNodeFs(): NodeFsLike | undefined {
  const proc = (
    globalThis as { readonly process?: { readonly getBuiltinModule?: (id: string) => unknown } }
  ).process;
  const mod = proc?.getBuiltinModule?.("node:fs") as Partial<NodeFsLike> | undefined;
  if (
    typeof mod === "object" &&
    mod !== null &&
    typeof mod.lstatSync === "function" &&
    typeof mod.readlinkSync === "function" &&
    typeof mod.readdirSync === "function" &&
    typeof mod.realpathSync?.native === "function" &&
    typeof mod.openSync === "function" &&
    typeof mod.fstatSync === "function" &&
    typeof mod.readSync === "function" &&
    typeof mod.closeSync === "function"
  ) {
    return mod as NodeFsLike;
  }
  return undefined;
}

function toConfinedStat(stat: NodeStatLike): ConfinedFsStat {
  const kind: ConfinedFsEntryKind = stat.isSymbolicLink()
    ? "symlink"
    : stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : "other";
  return {
    kind,
    size: stat.size,
    ...(stat.dev === undefined ? {} : { dev: stat.dev }),
    ...(stat.ino === undefined ? {} : { ino: stat.ino }),
  };
}

/**
 * Decodes file bytes the way `ts.sys.readFile` does: UTF-16 BE/LE and UTF-8
 * byte order marks are honoured and stripped; everything else is UTF-8.
 */
export function decodeTypeScriptSourceBytes(bytes: Uint8Array): string {
  const Decoder = (globalThis as { readonly TextDecoder?: TextDecoderCtor }).TextDecoder;
  if (Decoder === undefined) {
    throw new Error("TextDecoder is not available in this runtime");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const evenLength = bytes.length & ~1;
    const swapped = new Uint8Array(Math.max(0, evenLength - 2));
    for (let i = 2; i + 1 < evenLength; i += 2) {
      swapped[i - 2] = bytes[i + 1] ?? 0;
      swapped[i - 1] = bytes[i] ?? 0;
    }
    return new Decoder("utf-16le", { ignoreBOM: true }).decode(swapped);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new Decoder("utf-16le", { ignoreBOM: true }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new Decoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(3));
  }
  return new Decoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * Probe backed by `node:fs`. Returns undefined when the runtime does not
 * expose the required synchronous API (disk access is then disabled).
 */
export function createNodeConfinedFsProbe(): ConfinedFsProbe | undefined {
  const fs = loadNodeFs();
  if (fs === undefined) return undefined;

  return {
    realpath(path: string): string | undefined {
      if (path.includes("\0") || isUncDeviceOrNtPath(path)) return undefined;
      try {
        const real = fs.realpathSync.native(path);
        return real.length === 0 || isUncDeviceOrNtPath(real) ? undefined : real;
      } catch {
        return undefined;
      }
    },
    lstat(path: string): ConfinedFsStat | undefined {
      if (path.includes("\0") || isUncDeviceOrNtPath(path)) return undefined;
      try {
        const stat = fs.lstatSync(path, { throwIfNoEntry: false });
        return stat === undefined ? undefined : toConfinedStat(stat);
      } catch {
        return undefined;
      }
    },
    readlink(path: string): string | undefined {
      if (path.includes("\0") || isUncDeviceOrNtPath(path)) return undefined;
      try {
        return fs.readlinkSync(path);
      } catch {
        return undefined;
      }
    },
    readdir(path: string): readonly string[] | undefined {
      if (path.includes("\0") || isUncDeviceOrNtPath(path)) return undefined;
      try {
        return fs.readdirSync(path);
      } catch {
        return undefined;
      }
    },
    readText(path: string, expected: ConfinedFsStat, maxBytes: number): ConfinedReadResult {
      if (path.includes("\0") || isUncDeviceOrNtPath(path)) return { status: "unreadable" };
      if (expected.kind !== "file") return { status: "unreadable" };
      if (expected.size > maxBytes) return { status: "too-large" };
      // O_NONBLOCK keeps a FIFO swapped in after the lstat from blocking open().
      const flags =
        (fs.constants?.O_RDONLY ?? 0) |
        (fs.constants?.O_NOFOLLOW ?? 0) |
        (fs.constants?.O_NONBLOCK ?? 0);
      let fd: number;
      try {
        fd = fs.openSync(path, flags);
      } catch {
        return { status: "unreadable" };
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { status: "unreadable" };
        if (stat.size > maxBytes) return { status: "too-large" };
        if (
          expected.ino !== undefined &&
          expected.ino !== 0 &&
          (stat.ino !== expected.ino || stat.dev !== expected.dev)
        ) {
          return { status: "unreadable" };
        }
        const buffer = new Uint8Array(stat.size + 1);
        let total = 0;
        while (total < buffer.length) {
          const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
          if (read <= 0) break;
          total += read;
        }
        // More bytes than fstat reported: the file grew while it was read.
        if (total > stat.size) return { status: "unreadable" };
        const bytes = buffer.subarray(0, total);
        return { status: "ok", text: decodeTypeScriptSourceBytes(bytes), bytes: total };
      } catch {
        return { status: "unreadable" };
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // A close failure does not change the read result.
        }
      }
    },
  };
}
