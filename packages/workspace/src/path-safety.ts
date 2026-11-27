import { lstatSync, readdirSync, readlinkSync } from "node:fs";
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
  /**
   * Authorized directories. A local link whose target lies outside all of them is
   * not followed: the walk stops with `link-leaves-area`, so nothing outside the
   * authorized area is lstat'ed or read through a link planted inside it. A UNC /
   * device target is still reported as such first. When the walk is redirected
   * inside the area it continues from the containing directory (trusted, like
   * `startDir`).
   */
  readonly confineTo?: readonly string[];
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
      readonly reason: "link-target-unreadable" | "too-many-links" | "link-leaves-area";
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
  let trusted = options.startDir === undefined ? undefined : pathApi.resolve(options.startDir);
  const areas = options.confineTo?.map((area) => pathApi.resolve(area));
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
      if (areas !== undefined) {
        const area = areas.find((candidate) => isSameOrInside(pathApi, candidate, target));
        if (area === undefined) {
          return { ok: false, reason: "link-leaves-area", linkPath: next };
        }
        trusted = area;
      }
      redirected = true;
      break;
    }
    if (!redirected) {
      return { ok: true };
    }
  }
}

export interface LinkInspectionDescriptionOptions {
  /**
   * Directory the reader of the message is authorized for. A link path inside it
   * is named relative to it; a link path outside it is left out.
   */
  readonly within?: string;
  readonly pathApi?: PathApi;
}

/** `linkPath` relative to `within` (POSIX separators), or undefined when it lies outside. */
function linkPathInside(linkPath: string, options: LinkInspectionDescriptionOptions): string | undefined {
  if (options.within === undefined || isUncOrDevicePath(linkPath)) {
    return undefined;
  }
  const pathApi = options.pathApi ?? path;
  const within = pathApi.resolve(options.within);
  const resolved = pathApi.resolve(linkPath);
  if (!isSameOrInside(pathApi, within, resolved)) {
    return undefined;
  }
  const relative = splitSegments(pathApi.relative(within, resolved)).join("/");
  return relative.length === 0 ? "." : relative;
}

/**
 * Human-readable explanation for a failed {@link inspectLinkTargets} result, safe to
 * return to an MCP client (Claude Security F42): the readlink target is never
 * included, and the link path only when it lies inside `options.within` (named
 * relative to it). Without `within` the message names no path at all.
 */
export function describeLinkInspectionFailure(
  result: Exclude<LinkInspectionResult, { readonly ok: true }>,
  options: LinkInspectionDescriptionOptions = {},
): string {
  const inside = linkPathInside(result.linkPath, options);
  const where = inside === undefined ? "" : `: ${inside}`;
  switch (result.reason) {
    case "unc-or-device-link-target":
      return `a path component is a link to a UNC or Win32 device target (rejected before the link is followed)${where}`;
    case "link-target-unreadable":
      return `a link target could not be read (refusing to follow it)${where}`;
    case "too-many-links":
      return `too many links while resolving the path (refusing to follow further)${where}`;
    case "link-leaves-area":
      return `a link leads outside the authorized directory (not followed)${where}`;
  }
}

/**
 * True when an existing component of `lexicalPath` strictly below `trustedStart`
 * is a symbolic link or junction. Purely lstat-based; it stops at the first
 * missing component (nothing below it exists to be a link). Used to give a path
 * that cannot be resolved because it lies below a (dangling) link the same answer
 * as a path outside the authorized area.
 */
export function pathCrossesLink(lexicalPath: string, trustedStart: string, pathApi: PathApi = path): boolean {
  const relative = pathApi.relative(trustedStart, lexicalPath);
  // Segment-aware: a directory named "..x" is inside trustedStart.
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return false;
  }
  let current = trustedStart;
  for (const part of relative.split(pathApi.sep)) {
    if (part.length === 0) continue;
    current = pathApi.join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return false;
    }
    if (isLink) {
      return true;
    }
  }
  return false;
}

/** Creation-time environment of WorkspaceAccessPolicy / OutputAccessPolicy. */
export interface PolicyEnvironment {
  /**
   * Root-level link aliases (link path -> target) used to normalize spellings
   * before the lexical containment check. Defaults to {@link readRootLevelLinks}
   * of the filesystem root (none on Windows); tests inject a map to simulate
   * another platform's layout.
   */
  readonly rootLinks?: ReadonlyMap<string, string>;
}

/** Minimal filesystem surface used by {@link readRootLevelLinks} (injectable for tests). */
export interface RootLevelLinkFs {
  readonly readdirSync: (dir: string) => ReadonlyArray<{ readonly name: string; isSymbolicLink(): boolean }>;
  readonly readlinkSync: (target: string) => string;
}

const NODE_ROOT_LINK_FS: RootLevelLinkFs = {
  readdirSync: (dir) => readdirSync(dir, { withFileTypes: true }),
  readlinkSync: (target) => readlinkSync(target),
};

/** Bound on root-level link chains (`/a` -> `/b/x`, `/b` -> `/c`); longer chains or loops are dropped. */
const MAX_ROOT_LINK_HOPS = 8;

/**
 * The filesystem root's own links (macOS `/var`, `/tmp`, `/etc` -> `/private/...`;
 * merged-usr `/bin` -> `/usr/bin`), each mapped to its target resolved lexically
 * against the root, root-level chains followed. Only the root directory is listed
 * and only its link entries are read (readdir file types, then readlink): no
 * candidate path is involved and nothing is followed, stat'ed or opened, so a
 * target on an automounted or network path is not contacted. An entry whose target
 * cannot be read, or whose chain loops, is left out (its spelling is then simply
 * not normalized: a lexical denial, never a wider grant).
 */
export function readRootLevelLinks(
  options: { readonly root?: string; readonly fs?: RootLevelLinkFs; readonly pathApi?: PathApi } = {},
): ReadonlyMap<string, string> {
  const pathApi = options.pathApi ?? path;
  const fsImpl = options.fs ?? NODE_ROOT_LINK_FS;
  const root = options.root ?? pathApi.sep;
  const raw = new Map<string, string>();
  let entries: ReadonlyArray<{ readonly name: string; isSymbolicLink(): boolean }>;
  try {
    entries = fsImpl.readdirSync(root);
  } catch {
    return raw;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = pathApi.join(root, entry.name);
    try {
      const target = fsImpl.readlinkSync(linkPath);
      if (isUncOrDevicePath(target)) continue;
      raw.set(linkPath, pathApi.resolve(root, target));
    } catch {
      // Unreadable link: left out.
    }
  }
  const resolved = new Map<string, string>();
  for (const [linkPath, target] of raw) {
    let current = target;
    let stable = false;
    for (let hop = 0; hop < MAX_ROOT_LINK_HOPS; hop += 1) {
      const next = normalizeRootLevelAlias(current, raw, pathApi, 1);
      if (next === current) {
        stable = true;
        break;
      }
      current = next;
    }
    if (stable) {
      resolved.set(linkPath, current);
    }
  }
  return resolved;
}

/**
 * Rewrites a leading `rootLinks` prefix of `absolutePath` (a whole component, e.g.
 * `/tmp/proj` with `/tmp` -> `/private/tmp` becomes `/private/tmp/proj`). Purely
 * lexical. Used before a lexical containment check, so a path spelled through a
 * root-level link of the system compares with the real-path form of a declared
 * directory; the real-path containment check that follows still decides.
 */
export function normalizeRootLevelAlias(
  absolutePath: string,
  rootLinks: ReadonlyMap<string, string>,
  pathApi: PathApi = path,
  maxRewrites = MAX_ROOT_LINK_HOPS,
): string {
  let current = absolutePath;
  for (let rewrite = 0; rewrite < maxRewrites; rewrite += 1) {
    let rewritten: string | undefined;
    for (const [linkPath, target] of rootLinks) {
      if (isSameOrInside(pathApi, linkPath, current)) {
        const rest = pathApi.relative(linkPath, current);
        rewritten = rest.length === 0 ? target : pathApi.join(target, rest);
        break;
      }
    }
    if (rewritten === undefined || rewritten === current) {
      return current;
    }
    current = rewritten;
  }
  return current;
}
