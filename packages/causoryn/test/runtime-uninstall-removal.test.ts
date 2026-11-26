import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CausorynCliError, runSetup, type DirectoryOwnershipProbe } from "../src/index.js";
import { NODE_TREE_REMOVAL_FS, removeTreeNoFollow, type TreeRemovalFs } from "../src/fs-guard.js";
import {
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
} from "./helpers/setup-sandbox.js";

/**
 * F39 (CWE-367): `causoryn setup --uninstall` removed ~/.causoryn/runtime
 * recursively by path, inside a ~/.causoryn it never checked for privacy, and
 * the walk re-resolved every path component on each call. Another local user
 * who could write ~/.causoryn could plant a runtime tree and swap one of its
 * directories for a link while it was being removed, so the remaining names
 * were deleted inside the link target.
 *
 * Now the runtime is removed only when ~/.causoryn and every directory of
 * the runtime tree are private (POSIX owner and mode, as for staging), and
 * the removal checks each directory's identity before listing it, after
 * listing it and before removing anything in it, so a swapped directory stops
 * the removal. Windows has no uid/mode; the POSIX rule is exercised there with
 * an injected probe, and the identity checks run on every platform.
 */

afterEach(() => {
  removeSetupSandboxes();
});

const CURRENT_UID = 1000;

/** A POSIX view of the real directory: `override(dirPath)` gives owner and mode, default private. */
function posixProbe(override: (dirPath: string) => { owner: number; mode: number } | undefined): DirectoryOwnershipProbe {
  return {
    platform: "linux",
    uid: CURRENT_UID,
    lstat: (dirPath: string): Stats => {
      const real = lstatSync(dirPath);
      const view = override(path.resolve(dirPath)) ?? { owner: CURRENT_UID, mode: 0o700 };
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, {
        uid: view.owner,
        mode: (real.mode & ~0o7777) | view.mode,
      });
    },
  };
}

async function installedSandbox(prefix: string) {
  const sb = createSetupSandbox(prefix);
  // A package in an ephemeral (npx-like) directory is staged to ~/.causoryn/runtime.
  const pkg = writeFakePackage(path.join(sb.root, "_npx", "pkg"), causorynSkillBody("v1"));
  const options = {
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: pkg,
    ephemeralTmpDir: path.dirname(pkg),
    clients: ["claude-code"] as const,
    installSkills: false,
    yes: true,
  };
  const setup = await runSetup({ ...options, clients: ["claude-code"] });
  const runtimeDir = path.join(sb.home, ".causoryn", "runtime");
  expect(setup.stagedRuntimeDir).toBe(runtimeDir);
  expect(existsSync(path.join(runtimeDir, "package.json"))).toBe(true);
  return { sb, options, runtimeDir, causorynDir: path.dirname(runtimeDir) };
}

describe("F39: uninstall removes the staged runtime only from a private ~/.causoryn", () => {
  it.each([
    ["world-writable", CURRENT_UID, 0o777, /writable by other users/],
    ["group-writable", CURRENT_UID, 0o770, /writable by other users/],
    ["owned by another user", 1001, 0o700, /owned by another user/],
  ])("leaves the runtime in place when ~/.causoryn is %s, and says why", async (_label, owner, mode, reason) => {
    const { options, runtimeDir, causorynDir } = await installedSandbox("uninstall-parent");
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: posixProbe((dir) => (dir === causorynDir ? { owner, mode } : undefined)),
    });
    expect(res.applied).toBe(true);
    expect(res.runtimeCleanedUp).toBe(false);
    expect(existsSync(path.join(runtimeDir, "package.json"))).toBe(true);
    expect(res.message).toMatch(reason);
    expect(res.message).toContain(runtimeDir);
  });

  it.each([
    ["the runtime directory itself", "", 0o777, CURRENT_UID],
    ["a directory inside the runtime", "dist", 0o777, CURRENT_UID],
    ["a directory inside the runtime owned by another user", "scripts", 0o755, 1001],
  ])("leaves the whole runtime in place when %s is not private", async (_label, rel, mode, owner) => {
    const { options, runtimeDir } = await installedSandbox("uninstall-tree");
    const loose = path.resolve(runtimeDir, rel);
    const before = readdirSync(runtimeDir).sort();
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: posixProbe((dir) => (dir === loose ? { owner, mode } : undefined)),
    });
    expect(res.applied).toBe(true);
    expect(res.runtimeCleanedUp).toBe(false);
    // Checked before anything is removed: nothing of the runtime is gone.
    expect(readdirSync(runtimeDir).sort()).toEqual(before);
    expect(existsSync(path.join(runtimeDir, "dist", "mcp-server.mjs"))).toBe(true);
    expect(res.message).toContain(runtimeDir);
  });

  it("still removes a private runtime", async () => {
    const { options, runtimeDir } = await installedSandbox("uninstall-private");
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: posixProbe(() => undefined),
    });
    expect(res.runtimeCleanedUp).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
  });
});

/** A directory link that needs no privilege: a junction on Windows. */
function linkDirectory(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** Victim files the swap points the removal at. */
function victimDir(root: string): string {
  const victim = path.join(root, "victim");
  mkdirSync(victim, { recursive: true });
  for (const name of ["f1", "f2", "f3", ".ssh"]) writeFileSync(path.join(victim, name), "keep", "utf8");
  return victim;
}

/**
 * Real file system calls, except that `swapDir` is swapped for a link to
 * `linkTarget` right after its `listing`-th listing, or after the first entry
 * in it is removed.
 */
function swappingFs(
  swapDir: string,
  linkTarget: string,
  when: "after-list" | "after-first-unlink",
  listing = 1,
): TreeRemovalFs {
  let swapped = false;
  let listings = 0;
  const swap = (): void => {
    if (swapped) return;
    swapped = true;
    renameSync(swapDir, `${swapDir}-moved`);
    linkDirectory(linkTarget, swapDir);
  };
  return {
    ...NODE_TREE_REMOVAL_FS,
    readdir: (dirPath) => {
      const names = NODE_TREE_REMOVAL_FS.readdir(dirPath);
      if (when === "after-list" && path.resolve(dirPath) === path.resolve(swapDir)) {
        listings += 1;
        if (listings === listing) swap();
      }
      return names;
    },
    unlink: (entryPath) => {
      NODE_TREE_REMOVAL_FS.unlink(entryPath);
      if (when === "after-first-unlink" && path.dirname(path.resolve(entryPath)) === path.resolve(swapDir)) swap();
    },
  };
}

function plantTree(root: string): string {
  const tree = path.join(root, "runtime");
  mkdirSync(path.join(tree, "a"), { recursive: true });
  for (const name of ["f1", "f2", "f3", ".ssh"]) writeFileSync(path.join(tree, "a", name), "attacker", "utf8");
  writeFileSync(path.join(tree, "package.json"), JSON.stringify({ name: "causoryn" }), "utf8");
  return tree;
}

describe("F39: the tree removal never follows a directory swapped for a link", () => {
  it.each(["after-list", "after-first-unlink"] as const)(
    "stops when a listed directory becomes a link (%s) and leaves the link target untouched",
    (when) => {
      const sb = createSetupSandbox(`swap-${when}`);
      const victim = victimDir(sb.root);
      const tree = plantTree(sb.root);
      let caught: unknown;
      try {
        removeTreeNoFollow(tree, { fs: swappingFs(path.join(tree, "a"), victim, when) });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CausorynCliError);
      expect((caught as CausorynCliError).code).toBe("cli/io-error");
      expect((caught as Error).message).toMatch(/changed while it was being removed/);
      for (const name of ["f1", "f2", "f3", ".ssh"]) {
        expect(readFileSync(path.join(victim, name), "utf8")).toBe("keep");
      }
    },
  );

  it("uninstall stops when a runtime directory is swapped for a link during the removal", async () => {
    const { options, runtimeDir } = await installedSandbox("uninstall-swap");
    const victim = victimDir(path.dirname(path.dirname(runtimeDir)));
    for (const name of ["f1", "f2", "f3", ".ssh"]) writeFileSync(path.join(runtimeDir, "dist", name), "x", "utf8");
    // Listing 1 is the privacy check; listing 2 is the removal itself.
    const fs = swappingFs(path.join(runtimeDir, "dist"), victim, "after-list", 2);
    await expect(
      runSetup({
        ...options,
        clients: ["claude-code"],
        uninstall: true,
        directoryProbe: posixProbe(() => undefined),
        treeRemovalFs: fs,
      }),
    ).rejects.toThrow(/changed while it was being removed/);
    for (const name of ["f1", "f2", "f3", ".ssh"]) {
      expect(readFileSync(path.join(victim, name), "utf8")).toBe("keep");
    }
  });

  it("removes an unchanged tree, and a link inside it is removed without touching its target", () => {
    const sb = createSetupSandbox("remove-plain");
    const victim = victimDir(sb.root);
    const tree = plantTree(sb.root);
    linkDirectory(victim, path.join(tree, "a", "linked"));
    removeTreeNoFollow(tree);
    expect(existsSync(tree)).toBe(false);
    expect(readdirSync(victim).sort()).toEqual([".ssh", "f1", "f2", "f3"]);
  });
});
