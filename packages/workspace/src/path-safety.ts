import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

/**
 * Lexical UNC and Win32 device path guard (ADR-008 + CWE-22 / SMB NTLM relay defense).
 *
 * MUST be called BEFORE any fs.realpathSync / fs.lstatSync / fs.statSync call.
 * On Windows, resolving a UNC path (`\\host\share`, `//host/share`, `\\?\UNC\...`)
 * via realpathSync/statSync triggers an outbound SMB/NTLM authentication handshake
 * before authorization policies can inspect the resolved path.
 *
 * The NT object-manager prefix `\??\` is treated the same way: some Win32 APIs pass
 * it through unnormalized, and `readlinkSync` reports device link targets in this form.
 */

/** The `node:path` API (`path`, `path.win32` or `path.posix`). */
type PathApi = typeof path;

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/|[\\/]\?\?[\\/])/;

/**
 * Returns true if `rawPath` is a UNC network path (`\\host\share`, `//host/share`),
 * Win32 extended/device path (`\\?\...`, `\\.\...`), NT object-namespace path
 * (`\??\...`), or mixed-slash network prefix.
 * Purely lexical — performs zero filesystem or network I/O.
 */
export function isUncOrDevicePath(rawPath: string): boolean {
  if (rawPath.length < 2) {
    return false;
  }
  return UNC_OR_DEVICE_PREFIX.test(rawPath);
}

/**
 * Throws an Error with an actionable message if `rawPath` is a UNC or Win32
 * device path. Callers with typed policy errors can check `isUncOrDevicePath`
 * directly before calling `realpathSync` / `lstatSync`.
 */
export function assertNotUncOrDevicePath(rawPath: string, label = "path"): void {
  if (isUncOrDevicePath(rawPath)) {
    throw new Error(
      `Refusing UNC or Win32 device ${label} before filesystem access: ${rawPath}`,
    );
  }
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * True for a drive-letter absolute Windows path (`C:\...`, `c:/...`). Rooted paths
 * without a drive (`\work`) depend on the current drive and are not accepted.
 */
export function isWindowsDriveAbsolutePath(rawPath: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE.test(rawPath);
}

/** Why a path segment is not a stable Windows file name. */
export type WindowsPathSegmentIssue =
  /** `:` after the drive prefix: an alternate data stream (`a.pem::$DATA`) or a drive-relative form (`C:x`). */
  | "colon"
  /** Win32 name normalization drops a trailing `.` or space, so `a.pem.` aliases `a.pem`. */
  | "trailing-dot-or-space"
  /** CON, PRN, AUX, NUL, COM1-9, LPT1-9 (also with superscript digits and with any extension). */
  | "reserved-device-name";

export interface WindowsPathSegmentFinding {
  readonly segment: string;
  readonly issue: WindowsPathSegmentIssue;
}

/**
 * Reserved device names (Microsoft Learn, "Naming Files, Paths, and Namespaces"),
 * plus the console names CONIN$ / CONOUT$ accepted by CreateFile.
 */
const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "conin$",
  "conout$",
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3"].flatMap((digit) => [
    `com${digit}`,
    `lpt${digit}`,
  ]),
]);

function isReservedDeviceName(segment: string): boolean {
  const dot = segment.indexOf(".");
  const stem = dot === -1 ? segment : segment.slice(0, dot);
  let end = stem.length;
  while (end > 0 && stem.charCodeAt(end - 1) === 32) {
    end -= 1;
  }
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem.slice(0, end).toLowerCase());
}

/**
 * Returns the first segment of `rawPath` that Windows would not treat as a plain,
 * stable file name, or undefined. A leading drive prefix (`C:\`) is skipped; empty,
 * `.` and `..` segments are left to lexical path resolution. Purely lexical and
 * platform independent; callers apply it on Windows.
 */
export function findWindowsUnsafePathSegment(rawPath: string): WindowsPathSegmentFinding | undefined {
  const body = WINDOWS_DRIVE_ABSOLUTE.test(rawPath) ? rawPath.slice(3) : rawPath;
  for (const segment of body.split(/[\\/]/)) {
    if (segment === "" || segment === "." || segment === "..") {
      continue;
    }
    if (segment.includes(":")) {
      return { segment, issue: "colon" };
    }
    const last = segment.charCodeAt(segment.length - 1);
    if (last === 46 /* . */ || last === 32 /* space */) {
      return { segment, issue: "trailing-dot-or-space" };
    }
    if (isReservedDeviceName(segment)) {
      return { segment, issue: "reserved-device-name" };
    }
  }
  return undefined;
}

/** Human-readable explanation for a {@link WindowsPathSegmentIssue}. */
export function describeWindowsPathSegmentIssue(finding: WindowsPathSegmentFinding): string {
  switch (finding.issue) {
    case "colon":
      return `path segment contains a colon (alternate data stream or drive-relative form): ${finding.segment}`;
    case "trailing-dot-or-space":
      return `path segment ends with a dot or a space (Windows would resolve it to a different name): ${finding.segment}`;
    case "reserved-device-name":
      return `path segment is a reserved Windows device name: ${finding.segment}`;
  }
}

/** Minimal filesystem surface used by {@link inspectLinkTargets} (injectable for tests). */
export interface LinkInspectionFs {
  readonly lstatSync: (target: string) => { isSymbolicLink(): boolean };
  readonly readlinkSync: (target: string) => string;
}

export interface LinkInspectionOptions {
  /**
   * Already-canonical directory the path lies in. Components at or above it are
   * trusted and not inspected again; only the part below it is walked.
   */
  readonly startDir?: string;
  readonly fs?: LinkInspectionFs;
  readonly pathApi?: PathApi;
  /** Maximum number of links followed before failing closed (default 40). */
  readonly maxLinks?: number;
}

export type LinkInspectionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "unc-or-device-link-target";
      readonly linkPath: string;
      readonly target: string;
    }
  | {
      readonly ok: false;
      readonly reason: "link-target-unreadable" | "too-many-links";
      readonly linkPath: string;
    };

/** Link-target inspection is needed where following a UNC target opens a network session. */
export const LINK_TARGET_INSPECTION_ENABLED = process.platform === "win32";

const DEFAULT_MAX_LINKS = 40;

const NODE_LINK_FS: LinkInspectionFs = {
  lstatSync: (target) => lstatSync(target),
  readlinkSync: (target) => readlinkSync(target),
};

function splitSegments(relative: string): string[] {
  return relative.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== ".");
}

function isSameOrInside(pathApi: PathApi, container: string, target: string): boolean {
  const fold = pathApi.sep === "\\";
  const c = fold ? container.toLowerCase() : container;
  const t = fold ? target.toLowerCase() : target;
  if (t === c) return true;
  const boundary = c.endsWith(pathApi.sep) ? c : c + pathApi.sep;
  return t.startsWith(boundary);
}

/**
 * Walks `absolutePath` component by component with `lstat` and, for every symbolic
 * link or junction met on the way, reads the link target with `readlink` and rejects
 * UNC / Win32 device targets BEFORE anything follows the link. Local link chains are
 * followed lexically (bounded by `maxLinks`); ordinary links (e.g. `/var` →
 * `/private/var`) are followed, never rejected. Targets are never stat'ed or opened.
 *
 * A missing component ends the walk successfully: nothing beyond it can be followed,
 * so the caller's own `realpath` / `stat` fails locally.
 */
export function inspectLinkTargets(
  absolutePath: string,
  options: LinkInspectionOptions = {},
): LinkInspectionResult {
  const pathApi = options.pathApi ?? path;
  const fsImpl = options.fs ?? NODE_LINK_FS;
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;
  const trusted = options.startDir === undefined ? undefined : pathApi.resolve(options.startDir);
  if (isUncOrDevicePath(absolutePath)) {
    return { ok: false, reason: "unc-or-device-link-target", linkPath: absolutePath, target: absolutePath };
  }
  let target = pathApi.resolve(absolutePath);
  let linksFollowed = 0;
  for (;;) {
    let current: string;
    let remaining: string[];
    if (trusted !== undefined && isSameOrInside(pathApi, trusted, target)) {
      current = trusted;
      remaining = splitSegments(pathApi.relative(trusted, target));
    } else {
      current = pathApi.parse(target).root;
      remaining = splitSegments(target.slice(current.length));
    }
    let redirected = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const next = pathApi.join(current, remaining[index] as string);
      let isLink: boolean;
      try {
        isLink = fsImpl.lstatSync(next).isSymbolicLink();
      } catch {
        return { ok: true };
      }
      if (!isLink) {
        current = next;
        continue;
      }
      linksFollowed += 1;
      if (linksFollowed > maxLinks) {
        return { ok: false, reason: "too-many-links", linkPath: next };
      }
      let linkTarget: string;
      try {
        linkTarget = fsImpl.readlinkSync(next);
      } catch {
        return { ok: false, reason: "link-target-unreadable", linkPath: next };
      }
      if (isUncOrDevicePath(linkTarget)) {
        return { ok: false, reason: "unc-or-device-link-target", linkPath: next, target: linkTarget };
      }
      const resolvedTarget = pathApi.resolve(current, linkTarget);
      if (isUncOrDevicePath(resolvedTarget)) {
        return { ok: false, reason: "unc-or-device-link-target", linkPath: next, target: linkTarget };
      }
      target = pathApi.join(resolvedTarget, ...remaining.slice(index + 1));
      redirected = true;
      break;
    }
    if (!redirected) {
      return { ok: true };
    }
  }
}

/** Human-readable explanation for a failed {@link inspectLinkTargets} result. */
export function describeLinkInspectionFailure(
  result: Exclude<LinkInspectionResult, { readonly ok: true }>,
): string {
  switch (result.reason) {
    case "unc-or-device-link-target":
      return `a link resolves to a UNC or Win32 device target (rejected before the link is followed): ${result.linkPath} -> ${result.target}`;
    case "link-target-unreadable":
      return `a link target could not be read (refusing to follow it): ${result.linkPath}`;
    case "too-many-links":
      return `too many links while resolving the path (refusing to follow further): ${result.linkPath}`;
  }
}
