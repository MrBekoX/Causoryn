import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  isWindowsDriveAbsolutePath,
  OutputAccessPolicy,
  parseWorkspacePolicyConfig,
  WorkspaceAccessPolicy,
  WorkspacePolicyError,
} from "../src/index.js";
import type { LinkInspectionFs, OutputDecision, PolicyDecision } from "../src/index.js";

/**
 * Path confinement hardening: NT object-namespace prefixes, Windows name
 * aliases (alternate data streams, trailing dots/spaces, reserved device
 * names, 8.3 short names) and links whose target is a UNC/device path.
 *
 * The lexical helpers and the link walker are tested with injected fs
 * functions so every platform exercises them; real-filesystem checks run
 * where the platform can produce the condition.
 */

const IS_WIN = process.platform === "win32";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop() as string;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeRoot(prefix = "causoryn-confine-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function denyRule(decision: PolicyDecision | OutputDecision): string | undefined {
  if (decision.allowed) {
    throw new Error("expected a deny decision but the path was allowed");
  }
  return decision.rule;
}

/** Windows 8.3 short name of an existing path, or null when the volume has none. */
function shortNameOf(longPath: string): string | null {
  if (!IS_WIN) return null;
  try {
    const out = spawnSync(
      process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    )
      .stdout.trim()
      .replace(/^"|"$/g, "");
    return out.length > 0 && !out.includes('"') && out.toLowerCase() !== longPath.toLowerCase()
      ? out
      : null;
  } catch {
    return null;
  }
}

/** Whether this process can create a file symbolic link (Windows needs developer mode). */
const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-confine-probe-"));
  try {
    writeFileSync(path.join(probe, "t.txt"), "probe");
    symlinkSync(path.join(probe, "t.txt"), path.join(probe, "l.txt"), "file");
    return readFileSync(path.join(probe, "l.txt"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

/** Whether the temp volume folds letter case (default on Windows and macOS). */
const TEMP_VOLUME_FOLDS_CASE: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-confine-case-"));
  try {
    writeFileSync(path.join(probe, "lower.txt"), "x");
    return existsSync(path.join(probe, "LOWER.TXT"));
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

/** Whether the temp volume hands out 8.3 short names (Windows, per-volume setting). */
const SHORT_NAMES_AVAILABLE: boolean = (() => {
  if (!IS_WIN) return false;
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-confine-8dot3-"));
  try {
    const longDir = path.join(probe, "LongProbeDirectoryName");
    mkdirSync(longDir);
    return shortNameOf(longDir) !== null;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

/* ------------------------------------------------------------------ */
/* Lexical helpers (platform independent)                             */
/* ------------------------------------------------------------------ */

describe("isUncOrDevicePath — NT object namespace prefix", () => {
  it("detects \\??\\ and /??/ prefixes without filesystem access", () => {
    for (const raw of ["\\??\\C:\\secret", "\\??\\UNC\\host\\share", "/??/C:/secret", "\\??/pipe/x"]) {
      expect(isUncOrDevicePath(raw), raw).toBe(true);
    }
    for (const raw of ["??\\x", "src/??/x", "C:\\??\\x", "\\?x"]) {
      expect(isUncOrDevicePath(raw), raw).toBe(false);
    }
  });
});

describe("isWindowsDriveAbsolutePath", () => {
  it("accepts only drive-letter absolute forms", () => {
    expect(isWindowsDriveAbsolutePath("C:\\work\\repo")).toBe(true);
    expect(isWindowsDriveAbsolutePath("d:/work/repo")).toBe(true);
    expect(isWindowsDriveAbsolutePath("C:\\")).toBe(true);
    for (const raw of ["\\work\\repo", "/work/repo", "C:work", "\\\\host\\share", "\\\\?\\C:\\x", "work"]) {
      expect(isWindowsDriveAbsolutePath(raw), raw).toBe(false);
    }
  });
});

describe("findWindowsUnsafePathSegment", () => {
  it("flags alternate data stream and drive-relative colons after the drive prefix", () => {
    expect(findWindowsUnsafePathSegment("secret.pem::$DATA")).toEqual({
      segment: "secret.pem::$DATA",
      issue: "colon",
    });
    expect(findWindowsUnsafePathSegment("src/app.ts:hidden")?.issue).toBe("colon");
    expect(findWindowsUnsafePathSegment("C:\\repo\\a.ts:zone")?.issue).toBe("colon");
    expect(findWindowsUnsafePathSegment("C:relative")?.issue).toBe("colon");
    expect(findWindowsUnsafePathSegment("C:\\repo\\src\\a.ts")).toBeUndefined();
    expect(findWindowsUnsafePathSegment("C:/repo/src/a.ts")).toBeUndefined();
  });

  it("flags segments that end with a dot or a space", () => {
    expect(findWindowsUnsafePathSegment("secret.pem.")?.issue).toBe("trailing-dot-or-space");
    expect(findWindowsUnsafePathSegment("secret.pem ")?.issue).toBe("trailing-dot-or-space");
    expect(findWindowsUnsafePathSegment(".git./config")).toEqual({
      segment: ".git.",
      issue: "trailing-dot-or-space",
    });
    expect(findWindowsUnsafePathSegment(".git /config")?.issue).toBe("trailing-dot-or-space");
    expect(findWindowsUnsafePathSegment("src/.../x")?.issue).toBe("trailing-dot-or-space");
  });

  it("flags reserved device names, also with extensions and trailing spaces before the extension", () => {
    for (const name of [
      "CON",
      "prn",
      "Aux",
      "NUL",
      "nul.txt",
      "NUL.tar.gz",
      "nul .txt",
      "COM1",
      "com9.log",
      "LPT1",
      "lpt9.md",
      "COM\u00b9",
      "lpt\u00b3.txt",
      "CONIN$",
      "conout$",
      "src/aux/x.ts",
    ]) {
      expect(findWindowsUnsafePathSegment(name)?.issue, name).toBe("reserved-device-name");
    }
  });

  it("does not flag ordinary names that merely resemble the rules", () => {
    for (const name of [
      ".env",
      ".git/config",
      "a..b.ts",
      "..foo",
      "CONSOLE.ts",
      "com10.ts",
      "COM0x.ts",
      "lpt.ts",
      "nul-check.ts",
      "auxiliary/x.ts",
      "src/./a.ts",
      "src/../a.ts",
      "src//a.ts",
      "my file.ts",
      ".",
      "",
    ]) {
      expect(findWindowsUnsafePathSegment(name), name).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Link walker with an injected filesystem (platform independent)     */
/* ------------------------------------------------------------------ */

interface FakeNode {
  readonly link?: string;
}

/** In-memory win32 tree: keys are lower-cased absolute paths. */
function fakeFs(tree: Record<string, FakeNode>): LinkInspectionFs & { readonly calls: string[] } {
  const calls: string[] = [];
  const lookup = (p: string): FakeNode | undefined => tree[path.win32.resolve(p).toLowerCase()];
  return {
    calls,
    lstatSync(p: string) {
      calls.push(`lstat ${p}`);
      const node = lookup(p);
      if (node === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      return { isSymbolicLink: () => node.link !== undefined };
    },
    readlinkSync(p: string) {
      calls.push(`readlink ${p}`);
      const node = lookup(p);
      if (node?.link === undefined) {
        throw Object.assign(new Error(`EINVAL: ${p}`), { code: "EINVAL" });
      }
      return node.link;
    },
  };
}

const BASE_TREE: Record<string, FakeNode> = {
  "c:\\": {},
  "c:\\work": {},
  "c:\\work\\repo": {},
  "c:\\work\\repo\\src": {},
  "c:\\work\\repo\\src\\app.ts": {},
};

describe("inspectLinkTargets — injected filesystem", () => {
  it("accepts a link-free path using lstat only", () => {
    const fs = fakeFs(BASE_TREE);
    expect(
      inspectLinkTargets("C:\\work\\repo\\src\\app.ts", { fs, pathApi: path.win32 }),
    ).toEqual({ ok: true });
    expect(fs.calls.every((call) => call.startsWith("lstat "))).toBe(true);
  });

  it("rejects a link whose target is a UNC share without following it", () => {
    const fs = fakeFs({ ...BASE_TREE, "c:\\work\\repo\\share": { link: "\\\\host.example\\share\\" } });
    const result = inspectLinkTargets("C:\\work\\repo\\share\\data\\x.ts", { fs, pathApi: path.win32 });
    expect(result).toEqual({
      ok: false,
      reason: "unc-or-device-link-target",
      linkPath: "C:\\work\\repo\\share",
      target: "\\\\host.example\\share\\",
    });
    expect(fs.calls.some((call) => call.includes("host.example"))).toBe(false);
  });

  it("rejects an NT object-namespace device target as returned by readlink for device links", () => {
    const fs = fakeFs({ ...BASE_TREE, "c:\\work\\repo\\pipe": { link: "\\??\\pipe\\name" } });
    const result = inspectLinkTargets("C:\\work\\repo\\pipe", { fs, pathApi: path.win32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unc-or-device-link-target");
  });

  it("follows a local link chain and rejects the UNC hop at its end", () => {
    const fs = fakeFs({
      ...BASE_TREE,
      "c:\\work\\repo\\a": { link: "C:\\work\\hop" },
      "c:\\work\\hop": { link: "..\\hop2" },
      "c:\\hop2": { link: "//host.example/share" },
    });
    const result = inspectLinkTargets("C:\\work\\repo\\a\\file.ts", { fs, pathApi: path.win32 });
    expect(result).toEqual({
      ok: false,
      reason: "unc-or-device-link-target",
      linkPath: "C:\\hop2",
      target: "//host.example/share",
    });
  });

  it("accepts an in-root link to a local directory", () => {
    const fs = fakeFs({ ...BASE_TREE, "c:\\work\\repo\\alias": { link: "src" } });
    expect(
      inspectLinkTargets("C:\\work\\repo\\alias\\app.ts", { fs, pathApi: path.win32 }),
    ).toEqual({ ok: true });
  });

  it("stops at the first missing component (nothing beyond it can be followed)", () => {
    const fs = fakeFs(BASE_TREE);
    expect(
      inspectLinkTargets("C:\\work\\repo\\missing\\deeper\\x.ts", { fs, pathApi: path.win32 }),
    ).toEqual({ ok: true });
    expect(fs.calls.some((call) => call.includes("deeper"))).toBe(false);
  });

  it("does not inspect components at or above a trusted start directory", () => {
    const fs = fakeFs({ ...BASE_TREE, "c:\\work": { link: "\\\\host.example\\above" } });
    const result = inspectLinkTargets("C:\\work\\repo\\src\\app.ts", {
      fs,
      pathApi: path.win32,
      startDir: "C:\\WORK\\REPO",
    });
    expect(result).toEqual({ ok: true });
    expect(fs.calls).toEqual(["lstat C:\\WORK\\REPO\\src", "lstat C:\\WORK\\REPO\\src\\app.ts"]);
  });

  it("re-walks from the filesystem root when a link leaves the trusted start directory", () => {
    const fs = fakeFs({
      ...BASE_TREE,
      "c:\\work\\repo\\out": { link: "C:\\elsewhere\\x" },
      "c:\\elsewhere": { link: "\\\\host.example\\share" },
    });
    const result = inspectLinkTargets("C:\\work\\repo\\out\\y.ts", {
      fs,
      pathApi: path.win32,
      startDir: "C:\\work\\repo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.linkPath).toBe("C:\\elsewhere");
  });

  it("fails closed on link loops and unreadable link targets", () => {
    const loop = fakeFs({ ...BASE_TREE, "c:\\work\\repo\\a": { link: "b" }, "c:\\work\\repo\\b": { link: "a" } });
    const loopResult = inspectLinkTargets("C:\\work\\repo\\a\\x", { fs: loop, pathApi: path.win32 });
    expect(loopResult.ok).toBe(false);
    if (!loopResult.ok) expect(loopResult.reason).toBe("too-many-links");

    const unreadable: LinkInspectionFs = {
      lstatSync: () => ({ isSymbolicLink: () => true }),
      readlinkSync: () => {
        throw new Error("EPERM");
      },
    };
    const unreadableResult = inspectLinkTargets("C:\\work", { fs: unreadable, pathApi: path.win32 });
    expect(unreadableResult.ok).toBe(false);
    if (!unreadableResult.ok) expect(unreadableResult.reason).toBe("link-target-unreadable");
  });

  it("works with POSIX paths and never rejects ordinary links above the root (e.g. /var -> /private/var)", () => {
    const tree: Record<string, FakeNode> = {
      "/": {},
      "/var": { link: "private/var" },
      "/private": {},
      "/private/var": {},
      "/private/var/folders": {},
      "/private/var/folders/repo": {},
    };
    const posixFs: LinkInspectionFs = {
      lstatSync(p) {
        const node = tree[path.posix.resolve(p)];
        if (node === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isSymbolicLink: () => node.link !== undefined };
      },
      readlinkSync(p) {
        const node = tree[path.posix.resolve(p)];
        if (node?.link === undefined) throw new Error("EINVAL");
        return node.link;
      },
    };
    expect(
      inspectLinkTargets("/var/folders/repo", { fs: posixFs, pathApi: path.posix }),
    ).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ */
/* Policy integration (real filesystem)                               */
/* ------------------------------------------------------------------ */

function seedSecrets(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "server-key.pem"), "-----BEGIN\n");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "config"), "[core]\n");
}

describe("WorkspaceAccessPolicy — Windows name aliases", () => {
  it.skipIf(!IS_WIN)("denies alternate data streams, trailing dots/spaces and reserved device names", () => {
    const root = makeRoot();
    seedSecrets(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    expect(denyRule(policy.checkFile(root, "server-key.pem::$DATA"))).toBe("windows-colon");
    expect(denyRule(policy.checkFile(root, path.join(root, "src", "app.ts:zone")))).toBe("windows-colon");
    expect(denyRule(policy.checkFile(root, "C:relative.ts"))).toBe("windows-colon");
    expect(denyRule(policy.checkFile(root, "server-key.pem."))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.checkFile(root, "server-key.pem "))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.checkPath(root, ".git./config"))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.checkFile(root, "NUL"))).toBe("windows-reserved-device-name");
    expect(denyRule(policy.checkFile(root, "src/con.ts"))).toBe("windows-reserved-device-name");
    expect(denyRule(policy.checkFile(root, "\\??\\" + path.join(root, "src", "app.ts")))).toBe(
      "unc-or-device-path",
    );
    // Ordinary paths keep working.
    expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
    expect(policy.checkFile(root, path.join(root, "src", "app.ts")).allowed).toBe(true);
  });

  it.skipIf(!IS_WIN)("denies the same name aliases in the root path", () => {
    const root = makeRoot();
    seedSecrets(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    expect(denyRule(policy.authorizeRoot(`${root}.`))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.authorizeRoot(`${root}::$INDEX_ALLOCATION`))).toBe("windows-colon");
    expect(policy.authorizeRoot(root).allowed).toBe(true);
  });

  it.skipIf(!IS_WIN)("requires drive-letter absolute allowRoots and rejects aliased root names", () => {
    expect(parseWorkspacePolicyConfig({ allowRoots: ["\\work\\repo"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["/work/repo"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["C:\\work\\repo."] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["C:\\work\\repo::$DATA"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["C:\\work\\nul"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["C:\\work\\repo"] }).ok).toBe(true);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["c:/work/repo"] }).ok).toBe(true);
  });

  it.skipIf(!SHORT_NAMES_AVAILABLE)("denies an 8.3 short-name alias of .git through its canonical long name", () => {
    const root = makeRoot();
    seedSecrets(root);
    mkdirSync(path.join(root, "LongSourceDirectoryName"));
    writeFileSync(path.join(root, "LongSourceDirectoryName", "app.ts"), "export const b = 2;\n");
    const shortGit = shortNameOf(path.join(root, ".git"));
    expect(shortGit, "the temp volume generated 8.3 names for the probe").not.toBeNull();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const shortGitName = path.basename(shortGit as string);
    expect(denyRule(policy.checkFile(root, `${shortGitName}/config`))).toBe("**/.git/**");
    expect(denyRule(policy.checkFile(root, path.join(root, shortGitName, "config")))).toBe("**/.git/**");
    expect(denyRule(policy.checkPath(root, shortGitName))).toBe("**/.git/**");
    // A short alias of an ordinary directory is still allowed.
    const shortSrc = shortNameOf(path.join(root, "LongSourceDirectoryName"));
    expect(shortSrc).not.toBeNull();
    expect(policy.checkFile(root, `${path.basename(shortSrc as string)}/app.ts`).allowed).toBe(true);
  });

  it.skipIf(!TEMP_VOLUME_FOLDS_CASE)("denies a letter-case alias of .git on a case-folding volume", () => {
    const root = makeRoot();
    seedSecrets(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    // Windows matches ignore rules case-insensitively; elsewhere the policy relies
    // on the platform's native realpath reporting the on-disk letter case.
    const nativeReportsDiskCase = path.basename(realpathSync.native(path.join(root, ".GIT"))) === ".git";
    if (IS_WIN || nativeReportsDiskCase) {
      expect(policy.checkFile(root, ".GIT/config").allowed).toBe(false);
      expect(policy.checkFile(root, "SERVER-KEY.PEM").allowed).toBe(false);
    }
    expect(policy.checkFile(root, "SRC/app.ts").allowed).toBe(true);
  });
});

describe("WorkspaceAccessPolicy — links to UNC/device targets", () => {
  it.skipIf(!IS_WIN || !CAN_CREATE_FILE_SYMLINK)(
    "denies a candidate below a directory link to a UNC share before the link is followed",
    () => {
      const root = makeRoot();
      seedSecrets(root);
      // Explicit link types: the default type detection would stat the target.
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\", path.join(root, "share"), "dir");
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\x.ts", path.join(root, "remote.ts"), "file");
      symlinkSync("\\\\.\\pipe\\causoryn-none", path.join(root, "pipe"), "dir");
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      expect(denyRule(policy.checkPath(root, "share/sub/x.ts"))).toBe("unc-or-device-link-target");
      expect(denyRule(policy.checkFile(root, "remote.ts"))).toBe("unc-or-device-link-target");
      expect(denyRule(policy.checkPath(root, "pipe"))).toBe("unc-or-device-link-target");
      expect(denyRule(policy.authorizeRoot(path.join(root, "share")))).toBe("unc-or-device-link-target");
      expect(() => WorkspaceAccessPolicy.create({ allowRoots: [path.join(root, "share")] })).toThrowError(
        WorkspacePolicyError,
      );
      expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
    },
  );

  it("keeps accepting a root reached through an ordinary directory link (canonical forms)", () => {
    const base = makeRoot();
    const realRoot = path.join(base, "real");
    seedSecrets(realRoot);
    const alias = path.join(base, "alias");
    symlinkSync(realRoot, alias, "junction");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [alias] });
    const decision = policy.authorizeRoot(alias);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.canonicalRoot).toBe(realpathSync(alias));
    }
    const file = policy.checkFile(alias, path.join(alias, "src", "app.ts"));
    expect(file.allowed).toBe(true);
    if (file.allowed) expect(file.relativePath).toBe("src/app.ts");
  });
});

describe("OutputAccessPolicy — Windows name aliases and link targets", () => {
  it.skipIf(!IS_WIN)("rejects data streams, device names and trailing dots/spaces in file names", () => {
    const dir = makeRoot();
    const policy = OutputAccessPolicy.create([dir]);
    expect(denyRule(policy.authorizeFile(dir, "report.md:hidden"))).toBe("windows-colon");
    expect(denyRule(policy.authorizeFile(dir, "report.md::$DATA"))).toBe("windows-colon");
    expect(denyRule(policy.authorizeFile(dir, "NUL"))).toBe("windows-reserved-device-name");
    expect(denyRule(policy.authorizeFile(dir, "con.md"))).toBe("windows-reserved-device-name");
    expect(denyRule(policy.authorizeFile(dir, "COM1.html"))).toBe("windows-reserved-device-name");
    expect(denyRule(policy.authorizeFile(dir, "report.md."))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.authorizeFile(dir, "report.md "))).toBe("windows-trailing-dot-or-space");
    expect(denyRule(policy.authorizeDirectory(`${dir}.`))).toBe("windows-trailing-dot-or-space");
    expect(policy.authorizeFile(dir, "report.md").allowed).toBe(true);
    expect(() => OutputAccessPolicy.create([`${dir}::$INDEX_ALLOCATION`])).toThrowError(/colon|data stream/);
  });

  it.skipIf(!IS_WIN || !CAN_CREATE_FILE_SYMLINK)(
    "rejects a write target or output directory that is a link to a UNC share",
    () => {
      const dir = makeRoot();
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\x.md", path.join(dir, "remote.md"), "file");
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\", path.join(dir, "share"), "dir");
      const policy = OutputAccessPolicy.create([dir]);
      expect(denyRule(policy.authorizeFile(dir, "remote.md"))).toBe("unc-or-device-link-target");
      expect(denyRule(policy.authorizeDirectory(path.join(dir, "share")))).toBe("unc-or-device-link-target");
      expect(() => OutputAccessPolicy.create([path.join(dir, "share")])).toThrowError(/UNC or Win32 device/);
    },
  );
});
