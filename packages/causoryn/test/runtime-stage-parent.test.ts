import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSetup, stagePersistentRuntime, type DirectoryOwnershipProbe } from "../src/index.js";
import {
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
} from "./helpers/setup-sandbox.js";

/**
 * CAU-14 (CWE-732): the npx runtime is staged below `~/.causoryn`. An
 * existing `~/.causoryn` is reused only when it is a real directory and, on
 * POSIX, owned by the current user and not writable by group or other users:
 * otherwise another local user could swap the staged runtime that every host
 * config points at. Windows has no uid/mode; the POSIX rule is exercised
 * there with an injected probe.
 */

afterEach(() => {
  removeSetupSandboxes();
});

const CURRENT_UID = 1000;

/** A POSIX view of the real directory with the given owner and mode bits. */
function posixProbe(owner: number, mode: number): DirectoryOwnershipProbe {
  return {
    platform: "linux",
    uid: CURRENT_UID,
    lstat: (dirPath: string): Stats => {
      const real = lstatSync(dirPath);
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, {
        uid: owner,
        mode: (real.mode & ~0o7777) | mode,
      });
    },
  };
}

function stageSandbox(prefix: string) {
  const sb = createSetupSandbox(prefix);
  const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
  const causorynDir = path.join(sb.home, ".causoryn");
  // Private regardless of the runner's umask; the probe decides what the check sees.
  mkdirSync(causorynDir, { recursive: true, mode: 0o700 });
  return { sb, pkg, causorynDir };
}

describe("CAU-14: an existing staging parent must be private", () => {
  it.each([
    ["world-writable", CURRENT_UID, 0o777, /writable by other users/],
    ["group-writable", CURRENT_UID, 0o770, /writable by other users/],
    ["owned by another user", 1001, 0o700, /owned by another user/],
  ])("refuses a %s ~/.causoryn and stages nothing", (_label, owner, mode, message) => {
    const { sb, pkg, causorynDir } = stageSandbox("stage-parent");
    expect(() =>
      stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: pkg, directoryProbe: posixProbe(owner, mode) }),
    ).toThrow(message);
    expect(readdirSync(causorynDir)).toEqual([]);
  });

  it("reuses a private ~/.causoryn owned by the current user", () => {
    const { sb, pkg } = stageSandbox("stage-parent-ok");
    const staged = stagePersistentRuntime({
      homeDir: sb.home,
      sourcePackageDir: pkg,
      directoryProbe: posixProbe(CURRENT_UID, 0o700),
    });
    expect(existsSync(staged.cliEntryPath)).toBe(true);
  });

  it("setup refuses a non-private ~/.causoryn while planning (dry-run included), before any mutation", async () => {
    const { sb, pkg, causorynDir } = stageSandbox("setup-parent");
    const ephemeral = path.dirname(pkg);
    for (const dryRun of [true, false]) {
      await expect(
        runSetup({
          homeDir: sb.home,
          codexHomeDir: sb.codexHome,
          packageRoot: pkg,
          ephemeralTmpDir: ephemeral,
          clients: ["claude-code"],
          yes: true,
          dryRun,
          directoryProbe: posixProbe(CURRENT_UID, 0o777),
        }),
      ).rejects.toThrow(/writable by other users/);
      expect(readdirSync(causorynDir)).toEqual([]);
      expect(existsSync(path.join(sb.home, ".claude.json"))).toBe(false);
    }
  });

  it.each([
    ["the staged runtime itself (~/.causoryn/runtime)", "runtime"],
    ["another package below ~/.causoryn", "pkg"],
  ])(
    "setup run from %s without skills refuses a non-private ~/.causoryn, since host configs would point into it",
    async (_label, dirName) => {
      const sb = createSetupSandbox("setup-from-home");
      const causorynDir = path.join(sb.home, ".causoryn");
      mkdirSync(causorynDir, { recursive: true, mode: 0o700 });
      const pkg = writeFakePackage(path.join(causorynDir, dirName), causorynSkillBody("v1"));
      for (const dryRun of [true, false]) {
        await expect(
          runSetup({
            homeDir: sb.home,
            codexHomeDir: sb.codexHome,
            packageRoot: pkg,
            ephemeralTmpDir: sb.notTmp,
            clients: ["claude-code"],
            installSkills: false,
            yes: true,
            dryRun,
            directoryProbe: posixProbe(CURRENT_UID, 0o777),
          }),
        ).rejects.toThrow(/writable by other users/);
        expect(existsSync(path.join(sb.home, ".claude.json"))).toBe(false);
      }
    },
  );

  it("setup run from ~/.causoryn/runtime without skills uses a private ~/.causoryn and points the host config into it", async () => {
    const sb = createSetupSandbox("setup-from-runtime-ok");
    const causorynDir = path.join(sb.home, ".causoryn");
    mkdirSync(causorynDir, { recursive: true, mode: 0o700 });
    const runtime = writeFakePackage(path.join(causorynDir, "runtime"), causorynSkillBody("v1"));
    const res = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: runtime,
      ephemeralTmpDir: sb.notTmp,
      clients: ["claude-code"],
      installSkills: false,
      yes: true,
      directoryProbe: posixProbe(CURRENT_UID, 0o700),
    });
    expect(res.applied).toBe(true);
    expect(res.stagedRuntimeDir).toBeNull();
    expect(readFileSync(path.join(sb.home, ".claude.json"), "utf8")).toContain(
      JSON.stringify(path.join(runtime, "scripts", "causoryn.mjs")).slice(1, -1),
    );

    // Uninstall writes no reference into ~/.causoryn, so it is not refused.
    const uninstall = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: runtime,
      ephemeralTmpDir: sb.notTmp,
      clients: ["claude-code"],
      installSkills: false,
      uninstall: true,
      yes: true,
      directoryProbe: posixProbe(CURRENT_UID, 0o777),
    });
    expect(uninstall.applied).toBe(true);
  });

  it("uninstall still works with a non-private ~/.causoryn: the install record there is neither trusted nor rewritten", async () => {
    const { sb, pkg, causorynDir } = stageSandbox("uninstall-loose");
    const options = {
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: pkg,
      ephemeralTmpDir: sb.notTmp,
      clients: ["claude-code"] as const,
      yes: true,
    };
    await runSetup({ ...options, clients: ["claude-code"] });
    const recordPath = path.join(causorynDir, "installed-skills.json");
    const recordBefore = readFileSync(recordPath, "utf8");
    const skillFile = path.join(sb.home, ".claude", "skills", "causoryn", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);

    const res = await runSetup({
      ...options,
      clients: ["claude-code"],
      uninstall: true,
      directoryProbe: posixProbe(CURRENT_UID, 0o777),
    });
    expect(res.applied).toBe(true);
    const claude = JSON.parse(readFileSync(path.join(sb.home, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(claude.mcpServers, "causoryn")).toBe(false);
    // Skills that are exactly the shipped content are still proven Causoryn's.
    expect(existsSync(skillFile)).toBe(false);
    expect(readFileSync(recordPath, "utf8")).toBe(recordBefore);
  });

  it.skipIf(process.platform === "win32")("refuses a real world-writable ~/.causoryn on POSIX", () => {
    const { sb, pkg, causorynDir } = stageSandbox("stage-parent-posix");
    chmodSync(causorynDir, 0o777);
    try {
      expect(() => stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: pkg })).toThrow(
        /writable by other users/,
      );
      expect(readdirSync(causorynDir)).toEqual([]);
    } finally {
      chmodSync(causorynDir, 0o700);
    }
  });
});

describe("CAU-14: setup writes an absolute Node executable", () => {
  it("rejects a bare or relative nodeExecutable instead of writing it into host configs", async () => {
    for (const nodeExecutable of ["node", "bin/node", "./node"]) {
      const sb = createSetupSandbox("bare-node");
      const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
      await expect(
        runSetup({
          homeDir: sb.home,
          codexHomeDir: sb.codexHome,
          packageRoot: pkg,
          ephemeralTmpDir: sb.notTmp,
          clients: ["claude-code", "codex", "zcode", "antigravity"],
          installSkills: false,
          yes: true,
          nodeExecutable,
        }),
      ).rejects.toThrow(/absolute path/);
      expect(existsSync(path.join(sb.home, ".claude.json"))).toBe(false);
      expect(existsSync(path.join(sb.codexHome, "config.toml"))).toBe(false);
    }
  });
});
