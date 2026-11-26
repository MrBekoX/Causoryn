/**
 * CAU-08 (CWE-367 / CWE-459): publishing an authorized export file.
 *
 * OutputAccessPolicy.publishFile writes through a temp file it creates itself
 * (crypto-random name in the target directory, O_CREAT|O_EXCL `wx`, default
 * mode 0o666 narrowed by the umask), never removes a file it did not create,
 * and binds the authorized
 * directory's identity (dev, ino; no link; same real path) to the rename:
 * a directory replaced between authorization and publication is refused.
 *
 * The directory swaps are injected through a pass-through mock of node:fs
 * (after the temp file is closed: Windows cannot rename a directory that holds
 * an open file), so they run on every platform.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OutputAccessPolicy, OutputPolicyError, type OutputAllow } from "../src/output-policy.js";

const fsHooks = vi.hoisted(() => ({
  opened: [] as Array<{ readonly file: string; readonly flags: unknown; readonly mode: unknown }>,
  /** Number of writeFileSync calls that wrote to a file descriptor. */
  fdWrites: 0,
  /** One-shot: runs before the next openSync. */
  beforeOpen: undefined as undefined | (() => void),
  /** One-shot: runs after the next openSync returned its descriptor. */
  afterOpen: undefined as undefined | (() => void),
  /** One-shot: runs after the next closeSync. */
  afterClose: undefined as undefined | (() => void),
  /** One-shot: runs before the next renameSync. */
  beforeRename: undefined as undefined | ((from: string, to: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (file: import("node:fs").PathLike, flags?: import("node:fs").OpenMode, mode?: import("node:fs").Mode | null) => {
    const hook = fsHooks.beforeOpen;
    fsHooks.beforeOpen = undefined;
    hook?.();
    fsHooks.opened.push({ file: String(file), flags, mode });
    const fd = actual.openSync(file, flags ?? "r", mode);
    const after = fsHooks.afterOpen;
    fsHooks.afterOpen = undefined;
    after?.();
    return fd;
  };
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>) => {
    if (typeof args[0] === "number") fsHooks.fdWrites += 1;
    actual.writeFileSync(...args);
  };
  const closeSync = (fd: number) => {
    actual.closeSync(fd);
    const hook = fsHooks.afterClose;
    fsHooks.afterClose = undefined;
    hook?.();
  };
  const renameSync = (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
    const hook = fsHooks.beforeRename;
    fsHooks.beforeRename = undefined;
    hook?.(String(from), String(to));
    actual.renameSync(from, to);
  };
  return { ...actual, openSync, writeFileSync, closeSync, renameSync };
});

const created: string[] = [];
afterEach(() => {
  fsHooks.opened.length = 0;
  fsHooks.fdWrites = 0;
  fsHooks.beforeOpen = undefined;
  fsHooks.afterOpen = undefined;
  fsHooks.afterClose = undefined;
  fsHooks.beforeRename = undefined;
  for (const dir of created.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeTempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `causoryn-publish-${label}-`)));
  created.push(dir);
  return dir;
}

function allow(policy: OutputAccessPolicy, dir: string, fileName: string): OutputAllow {
  const decision = policy.authorizeFile(dir, fileName);
  if (!decision.allowed) throw new Error(`fixture: authorization unexpectedly denied: ${decision.reason}`);
  return decision;
}

function tempOpens(dir: string): Array<{ readonly file: string; readonly flags: unknown; readonly mode: unknown }> {
  return fsHooks.opened.filter((entry) => path.relative(dir, path.dirname(entry.file)) === "");
}

/** Moves `dir` away and leaves a directory link to `outside` at its path. */
function swapForLink(dir: string, outside: string): string {
  const moved = `${dir}-moved`;
  renameSync(dir, moved);
  created.push(moved);
  symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
  return moved;
}

/** Moves `dir` away and creates a different, empty directory at its path. */
function swapForNewDirectory(dir: string): string {
  const moved = `${dir}-moved`;
  renameSync(dir, moved);
  created.push(moved);
  mkdirSync(dir);
  return moved;
}

function policyError(action: () => unknown): OutputPolicyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OutputPolicyError);
    return error as OutputPolicyError;
  }
  throw new Error("expected an OutputPolicyError");
}

describe("OutputAccessPolicy.publishFile (CAU-08)", () => {
  it("publishes through one unique temp file created exclusively, with the default 0o666 mode the umask narrows", () => {
    const dir = makeTempDir("basic");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");

    policy.publishFile(decision, "CONTENT");

    expect(readFileSync(path.join(dir, "out.json"), "utf8")).toBe("CONTENT");
    const opens = tempOpens(dir);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.flags).toBe("wx");
    // The temp file's mode survives the rename, so it is the published file's
    // mode: 0o666 minus the umask, as for any file the process writes (0o644
    // under the usual 022). The exclusive, owned, random-named create is the
    // security property; an owner-only mode would make shared or served
    // export directories unreadable and tighten a re-exported file.
    expect(opens[0]!.mode).toBe(0o666);
    expect(path.basename(opens[0]!.file)).toMatch(/^\.out\.json\.[0-9a-f]{24}\.tmp$/);
    expect(readdirSync(dir)).toEqual(["out.json"]);
  });

  // Windows keeps only the read-only attribute of a mode, so the bits are POSIX-only.
  it.skipIf(process.platform === "win32")(
    "the published file gets the umask-derived default mode, also when it replaces an existing export",
    () => {
      const dir = makeTempDir("mode");
      // A file created with Node's default mode: 0o666 minus this process's umask.
      const reference = path.join(makeTempDir("mode-reference"), "reference.txt");
      writeFileSync(reference, "", "utf8");
      const defaultMode = lstatSync(reference).mode & 0o777;
      const policy = OutputAccessPolicy.create([dir]);
      const target = path.join(dir, "out.json");

      policy.publishFile(allow(policy, dir, "out.json"), "FIRST");
      expect(lstatSync(target).mode & 0o777).toBe(defaultMode);

      // Re-exporting over an existing export does not tighten it.
      policy.publishFile(allow(policy, dir, "out.json"), "SECOND");
      expect(lstatSync(target).mode & 0o777).toBe(defaultMode);
      expect(readFileSync(target, "utf8")).toBe("SECOND");
    },
  );

  it("uses a different temp name for every publication", () => {
    const dir = makeTempDir("names");
    const policy = OutputAccessPolicy.create([dir]);
    policy.publishFile(allow(policy, dir, "out.json"), "ONE");
    policy.publishFile(allow(policy, dir, "out.json"), "TWO");
    const names = tempOpens(dir).map((entry) => entry.file);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(readFileSync(path.join(dir, "out.json"), "utf8")).toBe("TWO");
  });

  it("never touches pre-existing files named like a temp file", () => {
    const dir = makeTempDir("foreign");
    writeFileSync(path.join(dir, "out.json.tmp"), "FOREIGN-FIXED", "utf8");
    writeFileSync(path.join(dir, ".out.json.tmp"), "FOREIGN-DOTTED", "utf8");
    const policy = OutputAccessPolicy.create([dir]);

    policy.publishFile(allow(policy, dir, "out.json"), "CONTENT");

    expect(readFileSync(path.join(dir, "out.json.tmp"), "utf8")).toBe("FOREIGN-FIXED");
    expect(readFileSync(path.join(dir, ".out.json.tmp"), "utf8")).toBe("FOREIGN-DOTTED");
    expect(readdirSync(dir).sort()).toEqual([".out.json.tmp", "out.json", "out.json.tmp"]);
  });

  it("two publications to one target interleaved at the rename both succeed", () => {
    const dir = makeTempDir("interleaved");
    const policy = OutputAccessPolicy.create([dir]);
    const first = allow(policy, dir, "out.json");
    const second = allow(policy, dir, "out.json");
    let secondDone = false;
    fsHooks.beforeRename = () => {
      policy.publishFile(second, "SECOND");
      secondDone = true;
    };

    policy.publishFile(first, "FIRST");

    expect(secondDone).toBe(true);
    // The first publication renamed last.
    expect(readFileSync(path.join(dir, "out.json"), "utf8")).toBe("FIRST");
    expect(readdirSync(dir)).toEqual(["out.json"]);
  });

  it("refuses when the directory is replaced by a link after authorization; nothing is written outside", () => {
    const dir = makeTempDir("swap-link");
    const outside = makeTempDir("swap-link-outside");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");
    let moved: string | undefined;
    fsHooks.afterClose = () => {
      moved = swapForLink(dir, outside);
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    expect(error.message).toContain("changed after authorization");
    expect(moved).toBeDefined();
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(moved!, "out.json"))).toBe(false);
  });

  it("writes no content when the directory is replaced by a link before the temp file is created", () => {
    const dir = makeTempDir("swap-before-open");
    const outside = makeTempDir("swap-before-open-outside");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");
    fsHooks.beforeOpen = () => {
      swapForLink(dir, outside);
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    // The temp file landed in the link target: it is refused before any
    // content is written, and removed again (it is still this call's file).
    expect(fsHooks.fdWrites).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("writes no content when the directory is swapped for a link around the temp file's creation and swapped back", () => {
    const dir = makeTempDir("swap-and-back");
    const outside = makeTempDir("swap-and-back-outside");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");
    let moved: string | undefined;
    fsHooks.beforeOpen = () => {
      moved = swapForLink(dir, outside);
    };
    // The temp file now exists in `outside`; the original directory is put
    // back before the checks, so the directory identity alone matches again.
    fsHooks.afterOpen = () => {
      unlinkSync(dir);
      renameSync(moved!, dir);
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    expect(error.message).toContain("temporary export file");
    // The descriptor is not the entry at the temp path in the bound
    // directory: refused before any content is written through it.
    expect(fsHooks.fdWrites).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    // Residual (no openat in Node): the empty temp created through the link
    // stays where the link pointed; it is not removed by path, since that
    // path is outside the bound directory.
    const strays = readdirSync(outside);
    expect(strays).toHaveLength(1);
    expect(readFileSync(path.join(outside, strays[0]!), "utf8")).toBe("");
  });

  it("refuses when the directory is replaced by another directory after authorization", () => {
    const dir = makeTempDir("swap-dir");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");
    let moved: string | undefined;
    fsHooks.afterClose = () => {
      moved = swapForNewDirectory(dir);
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    expect(moved).toBeDefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(path.join(moved!, "out.json"))).toBe(false);
  });

  it("refuses when an ancestor of the directory is replaced by a link to the moved tree", () => {
    const base = makeTempDir("swap-ancestor");
    const parent = path.join(base, "parent");
    const dir = path.join(parent, "out");
    mkdirSync(dir, { recursive: true });
    const policy = OutputAccessPolicy.create([base]);
    const decision = allow(policy, dir, "out.json");
    const elsewhere = makeTempDir("swap-ancestor-elsewhere");
    fsHooks.afterClose = () => {
      // Same directory object (same dev/ino), now reached through a link that
      // leaves the authorized tree.
      renameSync(parent, path.join(elsewhere, "parent"));
      symlinkSync(path.join(elsewhere, "parent"), parent, process.platform === "win32" ? "junction" : "dir");
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    expect(existsSync(path.join(elsewhere, "parent", "out", "out.json"))).toBe(false);
  });

  it("removes its own temp file when the rename fails, and nothing else", () => {
    const dir = makeTempDir("rename-fails");
    mkdirSync(path.join(dir, "out.json"));
    writeFileSync(path.join(dir, "out.json.tmp"), "FOREIGN", "utf8");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");

    let thrown: unknown;
    try {
      policy.publishFile(decision, "CONTENT");
    } catch (error) {
      thrown = error;
    }

    // The rename's own filesystem error (EISDIR / EPERM ...), passed through.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(OutputPolicyError);
    expect(typeof (thrown as NodeJS.ErrnoException).code).toBe("string");
    expect(tempOpens(dir)).toHaveLength(1);
    expect(lstatSync(path.join(dir, "out.json")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(dir, "out.json.tmp"), "utf8")).toBe("FOREIGN");
    expect(readdirSync(dir).sort()).toEqual(["out.json", "out.json.tmp"]);
  });

  it("does not remove or publish a file that replaced its temp file", () => {
    const dir = makeTempDir("temp-replaced");
    const policy = OutputAccessPolicy.create([dir]);
    const decision = allow(policy, dir, "out.json");
    let tempPath: string | undefined;
    fsHooks.afterClose = () => {
      tempPath = tempOpens(dir)[0]?.file;
      if (tempPath === undefined) throw new Error("fixture: no temp file was opened");
      // Moved aside rather than unlinked: the original stays alive, so the
      // filesystem cannot hand its inode number to the replacement.
      renameSync(tempPath, `${tempPath}.orig`);
      writeFileSync(tempPath, "FOREIGN", "utf8");
    };

    const error = policyError(() => policy.publishFile(decision, "CONTENT"));

    expect(error.code).toBe("workspace/output-path-denied");
    expect(readFileSync(tempPath!, "utf8")).toBe("FOREIGN");
    expect(existsSync(path.join(dir, "out.json"))).toBe(false);
  });

  it("refuses a decision for a directory this policy does not authorize", () => {
    const declared = makeTempDir("declared");
    const other = makeTempDir("other");
    const otherPolicy = OutputAccessPolicy.create([other]);
    const policy = OutputAccessPolicy.create([declared]);

    const error = policyError(() => policy.publishFile(allow(otherPolicy, other, "out.json"), "CONTENT"));

    expect(error.code).toBe("workspace/output-not-authorized");
    expect(readdirSync(other)).toEqual([]);
    expect(fsHooks.opened).toEqual([]);
  });
});
