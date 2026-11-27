import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSetup, type DirectoryOwnershipProbe } from "../src/index.js";
import { restrictTreeToOwner, type StagedModeFs } from "../src/fs-guard.js";
import {
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
} from "./helpers/setup-sandbox.js";

/**
 * F39 review round 2: uninstall removes the staged runtime only when every
 * directory of it is private, but staging created only the runtime root
 * 0700; `cpSync` copied the subdirectories (`dist`, `scripts`, `native`, …)
 * with the source's modes, which follow the umask the package was unpacked
 * with. Under umask 002 (the default for user-private groups on Fedora/RHEL)
 * they were 0775, so every uninstall left the runtime in place.
 *
 * Staging now clears the group/other write bits of every staged directory and
 * file (links are left alone), whatever the umask; a runtime staged before
 * that is still refused, with a message that says what to run.
 *
 * Windows has no POSIX modes; there the umask is emulated: an injected file
 * system and probe give every entry a mode keyed by its identity (so modes
 * survive the staging rename), 0775/0664 for what staging copies and 0700
 * for what it creates with mkdir(0o700).
 */

afterEach(() => {
  removeSetupSandboxes();
});

const CURRENT_UID = 1000;

function viewWithMode(real: Stats, mode: number): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, {
    uid: CURRENT_UID,
    mode: (real.mode & ~0o7777) | mode,
  });
}

/** A umask-002 view of `home`: copies into the staged tree are 0775/0664 until chmod'ed. */
function umask002Emulation(home: string) {
  const causorynDir = path.join(home, ".causoryn");
  const modes = new Map<bigint, number>();
  const identity = (entryPath: string): bigint => lstatSync(entryPath, { bigint: true }).ino;
  const inStagedTree = (entryPath: string): boolean => {
    const rel = path.relative(causorynDir, path.resolve(entryPath));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const parts = rel.split(path.sep);
    return parts.length >= 2 && /^(runtime|\.runtime-(stage|prev)-.+)$/.test(parts[0] ?? "");
  };
  const modeOf = (entryPath: string, real: Stats): number =>
    modes.get(identity(entryPath)) ??
    (inStagedTree(entryPath) ? (real.isDirectory() ? 0o775 : 0o664) : real.isDirectory() ? 0o700 : 0o600);
  const view = (entryPath: string): Stats => {
    const real = lstatSync(entryPath);
    return viewWithMode(real, modeOf(entryPath, real));
  };
  const fs: StagedModeFs = {
    platform: "linux",
    lstat: view,
    readdir: (dirPath) => readdirSync(dirPath),
    chmod: (entryPath, mode) => {
      modes.set(identity(entryPath), mode & 0o7777);
    },
  };
  const probe: DirectoryOwnershipProbe = { platform: "linux", uid: CURRENT_UID, lstat: view };
  return { fs, probe, modeOf: (entryPath: string) => view(entryPath).mode & 0o7777 };
}

function allEntries(root: string): string[] {
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);
      out.push(entry);
      if (lstatSync(entry).isDirectory()) pending.push(entry);
    }
  }
  return out;
}

function sandboxOptions(prefix: string) {
  const sb = createSetupSandbox(prefix);
  const pkg = writeFakePackage(path.join(sb.root, "_npx", "pkg"), causorynSkillBody("v1"));
  mkdirSync(path.join(pkg, "native", "worker"), { recursive: true });
  writeFileSync(path.join(pkg, "native", "worker", "worker.dll"), "native", "utf8");
  return {
    sb,
    runtimeDir: path.join(sb.home, ".causoryn", "runtime"),
    options: {
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: pkg,
      ephemeralTmpDir: path.dirname(pkg),
      clients: ["claude-code"] as const,
      installSkills: false,
      yes: true,
    },
  };
}

describe("F39 round 2: the staged runtime is private whatever the umask", () => {
  it("clears group/other write bits on every staged directory and file, so uninstall can remove it", async () => {
    const { sb, runtimeDir, options } = sandboxOptions("stage-umask-emulated");
    const emulation = umask002Emulation(sb.home);
    const setup = await runSetup({
      ...options,
      clients: ["claude-code"],
      directoryProbe: emulation.probe,
      stagedModeFs: emulation.fs,
    });
    expect(setup.stagedRuntimeDir).toBe(runtimeDir);
    const entries = allEntries(runtimeDir);
    expect(entries.length).toBeGreaterThan(5);
    const loose = entries.filter((entry) => (emulation.modeOf(entry) & 0o022) !== 0);
    expect(loose).toEqual([]);

    const res = await runSetup({ ...options, clients: ["claude-code"], uninstall: true, directoryProbe: emulation.probe });
    expect(res.message).toBeUndefined();
    expect(res.runtimeCleanedUp).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("stages private modes under a real umask 002 and uninstall removes it", async (ctx) => {
    let previous: number;
    try {
      previous = process.umask(0o002);
    } catch {
      ctx.skip();
      return;
    }
    let runtimeDir: string;
    let options: ReturnType<typeof sandboxOptions>["options"];
    try {
      ({ runtimeDir, options } = sandboxOptions("stage-umask-real"));
      expect(statSync(path.join(options.packageRoot, "dist")).mode & 0o020).toBe(0o020);
      await runSetup({ ...options, clients: ["claude-code"] });
    } finally {
      process.umask(previous);
    }
    for (const entry of allEntries(runtimeDir)) {
      const st = lstatSync(entry);
      if (!st.isSymbolicLink()) expect(st.mode & 0o022, entry).toBe(0);
    }
    const res = await runSetup({ ...options, clients: ["claude-code"], uninstall: true });
    expect(res.runtimeCleanedUp).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
  });
});

describe("F39 round 2: a runtime staged before the fix is refused with an actionable message", () => {
  async function stagedWithoutFix(prefix: string) {
    const { runtimeDir, options } = sandboxOptions(prefix);
    await runSetup({ ...options, clients: ["claude-code"] });
    return { runtimeDir, options };
  }

  function probeWith(overrides: ReadonlyMap<string, { owner: number; mode: number }>): DirectoryOwnershipProbe {
    return {
      platform: "linux",
      uid: CURRENT_UID,
      lstat: (dirPath) => {
        const real = lstatSync(dirPath);
        const override = overrides.get(path.resolve(dirPath));
        const view = viewWithMode(real, override?.mode ?? 0o700);
        return Object.assign(view, { uid: override?.owner ?? CURRENT_UID });
      },
    };
  }

  it("a group-writable directory inside the runtime: says to run chmod -R go-w on the runtime, then uninstall again", async () => {
    const { runtimeDir, options } = await stagedWithoutFix("legacy-tree");
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: probeWith(new Map([[path.join(runtimeDir, "dist"), { owner: CURRENT_UID, mode: 0o775 }]])),
    });
    expect(res.runtimeCleanedUp).toBe(false);
    expect(res.message).toContain(`chmod -R go-w ${runtimeDir}`);
    expect(res.message).toContain("causoryn setup --uninstall");
    expect(res.message).not.toContain("run setup again");
  });

  it("a group-writable ~/.causoryn: says to run chmod go-w on it, then uninstall again", async () => {
    const { runtimeDir, options } = await stagedWithoutFix("legacy-parent");
    const causorynDir = path.dirname(runtimeDir);
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: probeWith(new Map([[causorynDir, { owner: CURRENT_UID, mode: 0o770 }]])),
    });
    expect(res.runtimeCleanedUp).toBe(false);
    expect(res.message).toContain(`chmod go-w ${causorynDir}`);
    expect(res.message).toContain("causoryn setup --uninstall");
  });

  it("a directory owned by another user: no chmod advice, check and remove it yourself", async () => {
    const { runtimeDir, options } = await stagedWithoutFix("legacy-owner");
    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: probeWith(new Map([[path.join(runtimeDir, "scripts"), { owner: 1001, mode: 0o755 }]])),
    });
    expect(res.runtimeCleanedUp).toBe(false);
    expect(res.message).toMatch(/owned by another user/);
    expect(res.message).not.toContain("chmod");
    expect(res.message).toContain(`remove ${runtimeDir} yourself`);
  });
});

describe("restrictTreeToOwner", () => {
  it("never changes or enters a link, and leaves private entries alone", () => {
    const sb = createSetupSandbox("restrict-links");
    const root = path.join(sb.root, "tree");
    mkdirSync(path.join(root, "dir"), { recursive: true });
    writeFileSync(path.join(root, "dir", "file"), "x", "utf8");
    writeFileSync(path.join(root, "private"), "x", "utf8");
    const linkPath = path.join(root, "link");
    mkdirSync(linkPath);
    writeFileSync(path.join(linkPath, "behind-link"), "x", "utf8");
    const modes = new Map<string, number>([
      [path.join(root, "private"), 0o600],
      [root, 0o700],
    ]);
    const chmods: string[] = [];
    const fs: StagedModeFs = {
      platform: "linux",
      lstat: (entryPath) => {
        const real = lstatSync(entryPath);
        const resolved = path.resolve(entryPath);
        const view = viewWithMode(real, modes.get(resolved) ?? (real.isDirectory() ? 0o775 : 0o664));
        // `link` is reported as a symbolic link: it must be neither chmod'ed nor entered.
        if (resolved === linkPath) return Object.assign(view, { isSymbolicLink: () => true, isDirectory: () => false });
        return view;
      },
      readdir: (dirPath) => readdirSync(dirPath),
      chmod: (entryPath, mode) => {
        chmods.push(`${path.relative(root, entryPath) || "."}:${(mode & 0o7777).toString(8)}`);
      },
    };
    restrictTreeToOwner(root, fs);
    expect(chmods.sort()).toEqual(["dir/file:644", "dir:755"].map((entry) => entry.split("/").join(path.sep)).sort());
  });

  it("does nothing on Windows (no POSIX modes)", () => {
    const sb = createSetupSandbox("restrict-win");
    const chmods: string[] = [];
    restrictTreeToOwner(sb.root, {
      platform: "win32",
      lstat: (entryPath) => lstatSync(entryPath),
      readdir: (dirPath) => readdirSync(dirPath),
      chmod: (entryPath) => {
        chmods.push(entryPath);
      },
    });
    expect(chmods).toEqual([]);
  });
});
