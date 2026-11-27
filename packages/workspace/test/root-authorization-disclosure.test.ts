import {
  lstatSync,
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

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Root authorization and link-inspection messages must not disclose anything
 * about paths outside the authorized area:
 *
 * - authorizeRoot decides lexically against the declared allowRoots before any
 *   filesystem access, so a root outside them cannot be used as an existence or
 *   file-type oracle (Claude Security F21 / F73).
 * - Link-inspection denials never echo readlink targets, and name a link path
 *   only when it lies inside the authorized directory (Claude Security F42).
 *
 * `node:fs` is wrapped to record every metadata call and to fake links, so the
 * Windows-only link checks can be exercised without creating real UNC links.
 */

const io = vi.hoisted(() => ({
  recording: false,
  calls: [] as string[],
  /** Lower-cased absolute path → raw link target reported by readlink. */
  fakeLinks: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const nodePath = await import("node:path");
  const record = (op: string, target: unknown): void => {
    if (io.recording) io.calls.push(`${op} ${String(target)}`);
  };
  const fakeTarget = (target: unknown): string | undefined =>
    io.fakeLinks.get(nodePath.resolve(String(target)).toLowerCase());
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    record("lstat", args[0]);
    if (fakeTarget(args[0]) !== undefined) {
      return { isSymbolicLink: () => true };
    }
    return actual.lstatSync(...args);
  }) as typeof actual.lstatSync;
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) => {
    record("readlink", args[0]);
    const fake = fakeTarget(args[0]);
    return fake ?? actual.readlinkSync(...args);
  }) as typeof actual.readlinkSync;
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    record("stat", args[0]);
    return actual.statSync(...args);
  }) as typeof actual.statSync;
  const realpathSync = Object.assign(
    ((...args: Parameters<typeof actual.realpathSync>) => {
      record("realpath", args[0]);
      return actual.realpathSync(...args);
    }) as typeof actual.realpathSync,
    {
      native: ((...args: Parameters<typeof actual.realpathSync.native>) => {
        record("realpath.native", args[0]);
        return actual.realpathSync.native(...args);
      }) as typeof actual.realpathSync.native,
    },
  );
  const overrides = { lstatSync, readlinkSync, statSync, realpathSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

import { describeLinkInspectionFailure, OutputAccessPolicy, WorkspaceAccessPolicy } from "../src/index.js";
import type { OutputDecision, PolicyDecision } from "../src/index.js";
import { normalizeRootLevelAlias, readRootLevelLinks } from "../src/path-safety.js";
import type { RootLevelLinkFs } from "../src/path-safety.js";

const IS_WIN = process.platform === "win32";

const cleanups: string[] = [];

afterEach(() => {
  io.recording = false;
  io.calls = [];
  io.fakeLinks.clear();
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function denyOf(decision: PolicyDecision): { code: string; reason: string; rule?: string } {
  if (decision.allowed) {
    throw new Error(`expected a deny decision, got allowed: ${decision.canonicalRoot}`);
  }
  return decision.rule === undefined
    ? { code: decision.code, reason: decision.reason }
    : { code: decision.code, reason: decision.reason, rule: decision.rule };
}

/** Runs `fn` while recording the `node:fs` metadata calls it makes. */
function recordFsCalls<T>(fn: () => T): { result: T; calls: string[] } {
  io.calls = [];
  io.recording = true;
  try {
    return { result: fn(), calls: [...io.calls] };
  } finally {
    io.recording = false;
  }
}

function fakeLink(linkPath: string, target: string): void {
  io.fakeLinks.set(path.resolve(linkPath).toLowerCase(), target);
}

const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-rootauth-probe-"));
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

describe("authorizeRoot — lexical authorization before filesystem access (F21)", () => {
  it("denies a root outside every allowRoot without touching the filesystem", () => {
    const root = makeDir("causoryn-rootauth-root-");
    const outside = makeDir("causoryn-rootauth-outside-");
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "file.txt"), "x");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    for (const probe of [
      path.join(outside, "dir"),
      path.join(outside, "file.txt"),
      path.join(outside, "missing"),
      path.join(root, "..", path.basename(outside), "dir"),
    ]) {
      const { result, calls } = recordFsCalls(() => policy.authorizeRoot(probe));
      expect(result.allowed, probe).toBe(false);
      expect(calls, `filesystem calls for ${probe}`).toEqual([]);
    }
  });

  it("returns one fixed reason for every root outside the allowRoots (no existence or file-type oracle)", () => {
    const root = makeDir("causoryn-rootauth-root-");
    const outside = makeDir("causoryn-rootauth-outside-");
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "file.txt"), "x");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const denials = [
      path.join(outside, "dir"),
      path.join(outside, "file.txt"),
      path.join(outside, "missing", "deeper"),
    ].map((probe) => denyOf(policy.authorizeRoot(probe)));
    for (const denial of denials) {
      expect(denial.code).toBe("workspace/root-not-authorized");
      expect(denial).toEqual(denials[0]);
      expect(denial.reason).not.toContain(outside);
    }
  });

  it("denies a link spelled outside the allowRoots even when it resolves into them", () => {
    const root = makeDir("causoryn-rootauth-root-");
    const outside = makeDir("causoryn-rootauth-outside-");
    const alias = path.join(outside, "alias-to-root");
    symlinkSync(root, alias, "junction");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const { result, calls } = recordFsCalls(() => policy.authorizeRoot(alias));
    expect(denyOf(result).code).toBe("workspace/root-not-authorized");
    expect(calls).toEqual([]);
  });

  it("keeps authorizing declared roots, nested roots and both declared and canonical spellings", () => {
    const base = makeDir("causoryn-rootauth-base-");
    const real = path.join(base, "real");
    mkdirSync(path.join(real, "packages", "app"), { recursive: true });
    const alias = path.join(base, "alias");
    symlinkSync(real, alias, "junction");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [alias] });

    for (const accepted of [alias, path.join(alias, "packages", "app"), real, path.join(real, "packages")]) {
      expect(policy.authorizeRoot(accepted).allowed, accepted).toBe(true);
    }
  });

  it("keeps the detailed reasons for roots inside the allowRoots (missing, not a directory)", () => {
    const root = makeDir("causoryn-rootauth-root-");
    writeFileSync(path.join(root, "file.txt"), "x");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    expect(denyOf(policy.authorizeRoot(path.join(root, "missing"))).reason).toMatch(/missing or inaccessible/);
    expect(denyOf(policy.authorizeRoot(path.join(root, "file.txt"))).reason).toMatch(/not a directory/);
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)(
    "does not report the file type of a link target outside the allowRoots",
    () => {
      const root = makeDir("causoryn-rootauth-root-");
      const outside = makeDir("causoryn-rootauth-outside-");
      writeFileSync(path.join(outside, "id_ed25519"), "key");
      mkdirSync(path.join(outside, "dir"));
      symlinkSync(path.join(outside, "id_ed25519"), path.join(root, "to-file"), "file");
      symlinkSync(path.join(outside, "dir"), path.join(root, "to-dir"), "junction");
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const toFile = denyOf(policy.authorizeRoot(path.join(root, "to-file")));
      const toDir = denyOf(policy.authorizeRoot(path.join(root, "to-dir")));
      expect(toFile).toEqual(toDir);
      expect(toFile.reason).not.toMatch(/not a directory/);
    },
  );
});

describe("describeLinkInspectionFailure — no readlink targets in client messages (F42)", () => {
  const uncFailure = {
    ok: false,
    reason: "unc-or-device-link-target",
    linkPath: "D:\\outside-victim\\Links\\share",
    target: "\\\\fileserver\\finance$",
  } as const;

  it("names neither the link path nor its target by default", () => {
    const message = describeLinkInspectionFailure(uncFailure);
    expect(message).toMatch(/UNC or Win32 device target/);
    expect(message).not.toContain("fileserver");
    expect(message).not.toContain("finance$");
    expect(message).not.toContain("victim");
  });

  it("names a link path inside the authorized directory relative to it, never the target", () => {
    const inside = describeLinkInspectionFailure(
      { ...uncFailure, linkPath: "C:\\work\\repo\\share" },
      { within: "C:\\work\\repo", pathApi: path.win32 },
    );
    expect(inside).toContain("share");
    expect(inside).not.toContain("C:\\work");
    expect(inside).not.toContain("fileserver");

    const nested = describeLinkInspectionFailure(
      { ok: false, reason: "too-many-links", linkPath: "/work/repo/a/b" },
      { within: "/work/repo", pathApi: path.posix },
    );
    expect(nested).toContain("a/b");
    expect(nested).not.toContain("/work/repo");
  });

  it("leaves out a link path outside the authorized directory", () => {
    const outside = describeLinkInspectionFailure(uncFailure, { within: "C:\\work\\repo", pathApi: path.win32 });
    expect(outside).not.toContain("victim");
    expect(outside).not.toContain("fileserver");
    const unreadable = describeLinkInspectionFailure(
      { ok: false, reason: "link-target-unreadable", linkPath: "/etc/elsewhere" },
      { within: "/work/repo", pathApi: path.posix },
    );
    expect(unreadable).toMatch(/could not be read/);
    expect(unreadable).not.toContain("/etc/elsewhere");
  });
});

describe("WorkspaceAccessPolicy — link denials do not echo targets (F42)", () => {
  it.skipIf(!IS_WIN)("names only the in-root link path for candidate and root denials", () => {
    const root = makeDir("causoryn-rootauth-root-");
    mkdirSync(path.join(root, "src"));
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    fakeLink(path.join(root, "share"), "\\\\fileserver.example\\finance$\\");

    const candidate = denyOf(policy.checkPath(root, "share/report.ts"));
    expect(candidate.rule).toBe("unc-or-device-link-target");
    expect(candidate.reason).toContain("share");
    expect(candidate.reason).not.toContain("fileserver");
    expect(candidate.reason).not.toContain(root);

    const nestedRoot = denyOf(policy.authorizeRoot(path.join(root, "share", "sub")));
    expect(nestedRoot.rule).toBe("unc-or-device-link-target");
    expect(nestedRoot.reason).not.toContain("fileserver");
    expect(nestedRoot.reason).not.toContain(root);
  });

  it.skipIf(!IS_WIN)("does not name a hop outside the root when a link chain leaves it", () => {
    const root = makeDir("causoryn-rootauth-root-");
    const outside = makeDir("causoryn-rootauth-outside-");
    const hop = path.join(outside, "hop");
    fakeLink(path.join(root, "out"), hop);
    fakeLink(hop, "\\\\fileserver.example\\share");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const denial = denyOf(policy.checkPath(root, "out/x.ts"));
    expect(denial.rule).toBe("unc-or-device-link-target");
    expect(denial.reason).not.toContain(outside);
    expect(denial.reason).not.toContain("fileserver");
  });
});

const ROOT_NOT_DECLARED = "root is not inside a user-declared allowRoot (explicit authorization required)";

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, IS_WIN ? "junction" : "dir");
}

function outputDenyOf(decision: OutputDecision): { code: string; reason: string; rule?: string } {
  if (decision.allowed) {
    throw new Error(`expected a deny decision, got allowed: ${decision.canonicalPath}`);
  }
  return decision.rule === undefined
    ? { code: decision.code, reason: decision.reason }
    : { code: decision.code, reason: decision.reason, rule: decision.rule };
}

/** Recorded calls that touched `dir` or anything below it (case-folded on Windows). */
function callsUnder(calls: readonly string[], dir: string): string[] {
  const needle = IS_WIN ? dir.toLowerCase() : dir;
  return calls.filter((call) => (IS_WIN ? call.toLowerCase() : call).includes(needle));
}

describe("OutputAccessPolicy.authorizeDirectory — lexical authorization first (F21 / F73)", () => {
  it("denies a directory outside the declared output dirs without filesystem access and with one reason", () => {
    const declared = makeDir("causoryn-outauth-declared-");
    const outside = makeDir("causoryn-outauth-outside-");
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "file.txt"), "x");
    const policy = OutputAccessPolicy.create([declared]);

    const denials = [path.join(outside, "dir"), path.join(outside, "file.txt"), path.join(outside, "missing")].map(
      (probe) => {
        const { result, calls } = recordFsCalls(() => policy.authorizeDirectory(probe));
        expect(calls, `filesystem calls for ${probe}`).toEqual([]);
        return outputDenyOf(result);
      },
    );
    for (const denial of denials) {
      expect(denial.code).toBe("workspace/output-not-authorized");
      expect(denial).toEqual(denials[0]);
      expect(denial.reason).not.toContain(outside);
    }
  });

  it("gives a dangling link inside a declared dir the same answer as a link to an existing outside dir", () => {
    const holder = makeDir("causoryn-outauth-dangling-");
    const declared = path.join(holder, "exports");
    mkdirSync(declared);
    mkdirSync(path.join(holder, "outside-existing"));
    linkDirectory(path.join(holder, "outside", "missing"), path.join(declared, "gone"));
    linkDirectory(path.join(holder, "outside-existing"), path.join(declared, "there"));
    const policy = OutputAccessPolicy.create([declared]);

    const toMissing = outputDenyOf(policy.authorizeDirectory(path.join(declared, "gone")));
    const toExisting = outputDenyOf(policy.authorizeDirectory(path.join(declared, "there")));
    expect(toMissing).toEqual(toExisting);
    expect(toMissing.code).toBe("workspace/output-not-authorized");
  });

  it("keeps authorizing declared dirs and their subdirectories, and the detailed reason for a missing one", () => {
    const declared = makeDir("causoryn-outauth-declared-");
    mkdirSync(path.join(declared, "sub"));
    const policy = OutputAccessPolicy.create([declared]);
    expect(policy.authorizeDirectory(declared).allowed).toBe(true);
    expect(policy.authorizeDirectory(path.join(declared, "sub")).allowed).toBe(true);
    expect(outputDenyOf(policy.authorizeDirectory(path.join(declared, "not-yet"))).reason).toMatch(
      /missing or inaccessible/,
    );
  });
});

describe("link chains that leave the authorized area are not followed (F21 / F73, Windows)", () => {
  it.skipIf(!IS_WIN)("authorizeRoot: a repository link chain leaving the allowRoot gets the not-declared reason", () => {
    const root = makeDir("causoryn-rootauth-root-");
    const outside = makeDir("causoryn-rootauth-outside-");
    const hop = path.join(outside, "hop");
    fakeLink(path.join(root, "out"), hop);
    fakeLink(hop, "\\\\fileserver.example\\share");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const { result, calls } = recordFsCalls(() => policy.authorizeRoot(path.join(root, "out", "sub")));
    expect(denyOf(result)).toEqual({ code: "workspace/root-not-authorized", reason: ROOT_NOT_DECLARED });
    expect(callsUnder(calls, outside)).toEqual([]);
  });

  it.skipIf(!IS_WIN)("authorizeDirectory: a link chain leaving the declared dir gets the not-declared reason", () => {
    const declared = makeDir("causoryn-outauth-declared-");
    const outside = makeDir("causoryn-outauth-outside-");
    const hop = path.join(outside, "hop");
    fakeLink(path.join(declared, "out"), hop);
    fakeLink(hop, "\\\\fileserver.example\\share");
    const policy = OutputAccessPolicy.create([declared]);
    const notDeclared = outputDenyOf(policy.authorizeDirectory(path.join(outside, "elsewhere")));

    const { result, calls } = recordFsCalls(() => policy.authorizeDirectory(path.join(declared, "out", "x")));
    expect(outputDenyOf(result)).toEqual(notDeclared);
    expect(callsUnder(calls, outside)).toEqual([]);
  });

  it.skipIf(!IS_WIN)("still names an in-area link to a UNC target as such, without the target", () => {
    const declared = makeDir("causoryn-outauth-declared-");
    fakeLink(path.join(declared, "share"), "\\\\fileserver.example\\share");
    const policy = OutputAccessPolicy.create([declared]);
    const denial = outputDenyOf(policy.authorizeDirectory(path.join(declared, "share")));
    expect(denial.rule).toBe("unc-or-device-link-target");
    expect(denial.reason).not.toContain("fileserver");
    expect(denial.reason).not.toContain(declared);
  });
});

/* ------------------------------------------------------------------ */
/* Root-level link aliases (macOS /var -> /private/var, /tmp, /etc)   */
/* ------------------------------------------------------------------ */

/** In-memory filesystem root for readRootLevelLinks: name -> link target, or null for a directory. */
function fakeRoot(entries: Record<string, string | null>, unreadable: readonly string[] = []): RootLevelLinkFs {
  return {
    readdirSync: () =>
      Object.entries(entries).map(([name, target]) => ({ name, isSymbolicLink: () => target !== null })),
    readlinkSync: (linkPath) => {
      const name = path.posix.basename(linkPath);
      if (unreadable.includes(name)) throw new Error("EACCES");
      const target = entries[name];
      if (target === undefined || target === null) throw new Error("EINVAL");
      return target;
    },
  };
}

describe("readRootLevelLinks / normalizeRootLevelAlias", () => {
  it("maps each root-level link to its lexically resolved target, following root-level chains", () => {
    const links = readRootLevelLinks({
      root: "/",
      pathApi: path.posix,
      fs: fakeRoot(
        {
          var: "private/var",
          tmp: "/private/tmp",
          etc: "private/etc",
          private: null,
          Users: null,
          a: "/b/x",
          b: "/c",
          loop1: "/loop2",
          loop2: "/loop1/y",
          secret: "ignored",
        },
        ["secret"],
      ),
    });
    expect(Object.fromEntries(links)).toEqual({
      "/var": "/private/var",
      "/tmp": "/private/tmp",
      "/etc": "/private/etc",
      "/a": "/c/x",
      "/b": "/c",
    });
  });

  it("rewrites only a whole leading root-level component", () => {
    const links = new Map([
      ["/var", "/private/var"],
      ["/tmp", "/private/tmp"],
    ]);
    expect(normalizeRootLevelAlias("/tmp/proj/src", links, path.posix)).toBe("/private/tmp/proj/src");
    expect(normalizeRootLevelAlias("/var", links, path.posix)).toBe("/private/var");
    expect(normalizeRootLevelAlias("/tmpx/proj", links, path.posix)).toBe("/tmpx/proj");
    expect(normalizeRootLevelAlias("/private/tmp/proj", links, path.posix)).toBe("/private/tmp/proj");
    expect(normalizeRootLevelAlias("/", links, path.posix)).toBe("/");
    expect(normalizeRootLevelAlias("/srv/work/tmp/x", links, path.posix)).toBe("/srv/work/tmp/x");
  });
});

/**
 * A miniature macOS layout below a temporary directory: `<holder>/var` is a link to
 * `<holder>/private/var`, and the policy is told so through an injected root-link
 * map, so every host exercises what macOS CI sees with the real `/var`.
 */
function simulatedMacLayout(): { holder: string; rootLinks: Map<string, string>; varFolders: string; privateFolders: string } {
  const holder = realpathSync(makeDir("causoryn-rootalias-"));
  mkdirSync(path.join(holder, "private", "var", "folders"), { recursive: true });
  linkDirectory(path.join(holder, "private", "var"), path.join(holder, "var"));
  return {
    holder,
    rootLinks: new Map([[path.join(holder, "var"), path.join(holder, "private", "var")]]),
    varFolders: path.join(holder, "var", "folders"),
    privateFolders: path.join(holder, "private", "var", "folders"),
  };
}

describe("WorkspaceAccessPolicy / OutputAccessPolicy — roots spelled through a root-level link (simulated macOS)", () => {
  it("accepts the other spelling of an allowRoot and of a root reached through an alias of it", () => {
    const { rootLinks, varFolders, privateFolders } = simulatedMacLayout();
    const real = path.join(varFolders, "base", "real");
    mkdirSync(path.join(real, "packages", "app"), { recursive: true });
    const alias = path.join(varFolders, "base", "alias");
    linkDirectory(real, alias);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [alias] }, { rootLinks });

    for (const accepted of [alias, real, path.join(real, "packages", "app"), path.join(privateFolders, "base", "real")]) {
      expect(policy.authorizeRoot(accepted).allowed, accepted).toBe(true);
    }

    // `/private/tmp/proj` declared, `/tmp/proj` passed by the client.
    mkdirSync(path.join(privateFolders, "proj", "src"), { recursive: true });
    const declaredCanonical = WorkspaceAccessPolicy.create(
      { allowRoots: [path.join(privateFolders, "proj")] },
      { rootLinks },
    );
    expect(declaredCanonical.authorizeRoot(path.join(varFolders, "proj")).allowed).toBe(true);
    expect(declaredCanonical.checkPath(path.join(varFolders, "proj"), "src").allowed).toBe(true);
  });

  it("still decides a root outside the normalized allowRoots without filesystem access", () => {
    const { rootLinks, varFolders } = simulatedMacLayout();
    const root = path.join(varFolders, "proj");
    mkdirSync(root);
    mkdirSync(path.join(varFolders, "elsewhere"));
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] }, { rootLinks });
    for (const probe of [path.join(varFolders, "elsewhere"), path.join(varFolders, "missing")]) {
      const { result, calls } = recordFsCalls(() => policy.authorizeRoot(probe));
      expect(denyOf(result)).toEqual({ code: "workspace/root-not-authorized", reason: ROOT_NOT_DECLARED });
      expect(calls, probe).toEqual([]);
    }
  });

  it("OutputAccessPolicy accepts the other spelling of a declared output dir and gates the rest lexically", () => {
    const { rootLinks, varFolders, privateFolders } = simulatedMacLayout();
    mkdirSync(path.join(privateFolders, "exports", "sub"), { recursive: true });
    mkdirSync(path.join(privateFolders, "elsewhere"));
    const policy = OutputAccessPolicy.create([path.join(privateFolders, "exports")], { rootLinks });

    expect(policy.authorizeDirectory(path.join(varFolders, "exports")).allowed).toBe(true);
    expect(policy.authorizeDirectory(path.join(varFolders, "exports", "sub")).allowed).toBe(true);
    const notDeclared = outputDenyOf(policy.authorizeDirectory(path.join(privateFolders, "missing")));
    for (const probe of [path.join(varFolders, "elsewhere"), path.join(varFolders, "missing")]) {
      const { result, calls } = recordFsCalls(() => policy.authorizeDirectory(probe));
      expect(outputDenyOf(result)).toEqual(notDeclared);
      expect(calls, probe).toEqual([]);
    }
  });
});

/** True when the first component of the temp directory is itself a root-level link (macOS `/var`). */
const TMP_BELOW_ROOT_LEVEL_LINK: boolean = (() => {
  if (IS_WIN) return false;
  const first = path.resolve(tmpdir()).split(path.sep).filter((part) => part.length > 0)[0];
  if (first === undefined) return false;
  try {
    return lstatSync(path.join(path.sep, first)).isSymbolicLink();
  } catch {
    return false;
  }
})();

describe("roots spelled through the real filesystem root's links (macOS)", () => {
  it.skipIf(!TMP_BELOW_ROOT_LEVEL_LINK)("accepts the tmpdir spelling of an allowRoot declared by its real path", () => {
    const root = makeDir("causoryn-rootalias-real-");
    const canonical = realpathSync(root);
    expect(canonical).not.toBe(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [canonical] });
    expect(policy.authorizeRoot(root).allowed).toBe(true);
    const outputs = OutputAccessPolicy.create([canonical]);
    expect(outputs.authorizeDirectory(root).allowed).toBe(true);
    const { result, calls } = recordFsCalls(() => policy.authorizeRoot(path.join(path.dirname(root), "causoryn-none")));
    expect(denyOf(result).reason).toBe(ROOT_NOT_DECLARED);
    expect(calls).toEqual([]);
  });
});
