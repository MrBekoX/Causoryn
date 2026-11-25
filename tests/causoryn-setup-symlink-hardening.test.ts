import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_SKILL_NAMES,
  CausorynCliError,
  runSetup,
  stagePersistentRuntime,
} from "../packages/causoryn/src/index.js";

/**
 * CWE-59 hardening of `causoryn setup` and the persistent runtime stage:
 * no write, backup, stage or removal goes through a symbolic link or
 * junction below the user's home (or below an explicitly configured host
 * config directory, which is resolved once), and `--uninstall` removes only
 * what Causoryn created, never following links.
 *
 * Directory links are junctions on Windows (no privilege needed) and
 * symlinks elsewhere, so every case runs on every OS.
 */

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-setup-link-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function linkDir(target: string, linkPath: string): void {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function createFakePkg(baseDir: string): string {
  const pkgRoot = path.join(baseDir, "pkg");
  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "causoryn", version: "0.3.0" }), "utf8");
  writeFileSync(path.join(pkgRoot, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(path.join(pkgRoot, "dist", "mcp-server.mjs"), "// bundle\n", "utf8");
  for (const skillName of CANONICAL_SKILL_NAMES) {
    const dir = path.join(pkgRoot, "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\nUse causoryn.\n`, "utf8");
  }
  return pkgRoot;
}

function sandbox(prefix: string): {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  readonly pkg: string;
  readonly external: string;
} {
  const root = createTempDir(prefix);
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  const external = path.join(root, "external");
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, "keep.txt"), "user data\n", "utf8");
  return { root, home, codexHome: path.join(home, ".codex"), pkg: createFakePkg(root), external };
}

function listRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    out.push(name);
    if (lstatSync(full).isDirectory()) {
      out.push(...listRecursive(full).map((child) => `${name}/${child}`));
    }
  }
  return out;
}

describe("setup: no writes through linked ancestors below the home directory", () => {
  it("rejects a host config directory that is a link below home and leaves the link target untouched", async () => {
    const sb = sandbox("cfg-ancestor");
    linkDir(sb.external, path.join(sb.home, ".zcode"));

    const error = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: sb.pkg,
      clients: ["zcode"],
      installSkills: false,
      yes: true,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CausorynCliError);
    expect((error as CausorynCliError).code).toBe("cli/io-error");
    expect((error as Error).message).toMatch(/symbolic link or junction.*CWE-59/);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);

    // Dry-run reports the same problem before anything is planned for writing:
    await expect(
      runSetup({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: sb.pkg,
        clients: ["zcode"],
        installSkills: false,
        dryRun: true,
      }),
    ).rejects.toThrow(/CWE-59/);
  });

  it("rejects a linked skills root below home (install) without creating files in the link target", async () => {
    const sb = sandbox("skills-ancestor");
    linkDir(sb.external, path.join(sb.home, ".claude", "skills"));

    await expect(
      runSetup({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: sb.pkg,
        clients: ["claude-code"],
        yes: true,
      }),
    ).rejects.toThrow(/CWE-59/);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);
    expect(existsSync(path.join(sb.home, ".claude.json"))).toBe(false);
  });

  it("accepts links ABOVE the home directory (e.g. macOS /var -> /private/var) and an explicitly configured config dir that is a link", async () => {
    const sb = sandbox("above-home");
    const realHome = path.join(sb.root, "real-home");
    mkdirSync(realHome, { recursive: true });
    const linkedHome = path.join(sb.root, "linked-home");
    linkDir(realHome, linkedHome);

    const res = await runSetup({
      homeDir: linkedHome,
      codexHomeDir: path.join(linkedHome, ".codex"),
      packageRoot: sb.pkg,
      clients: ["zcode"],
      installSkills: false,
      yes: true,
    });
    expect(res.applied).toBe(true);
    expect(existsSync(path.join(realHome, ".zcode", "cli", "config.json"))).toBe(true);

    // CLAUDE_CONFIG_DIR is resolved once: the configured directory itself may be a link.
    const realClaudeDir = path.join(sb.root, "dotfiles", "claude");
    mkdirSync(realClaudeDir, { recursive: true });
    const configuredClaudeDir = path.join(sb.home, ".config-claude");
    linkDir(realClaudeDir, configuredClaudeDir);
    const claudeRes = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      claudeConfigDir: configuredClaudeDir,
      packageRoot: sb.pkg,
      clients: ["claude-code"],
      yes: true,
    });
    expect(claudeRes.applied).toBe(true);
    expect(existsSync(path.join(realClaudeDir, ".claude.json"))).toBe(true);
    expect(existsSync(path.join(realClaudeDir, "skills", "causoryn", "SKILL.md"))).toBe(true);
    expect(realpathSync(path.join(configuredClaudeDir, ".claude.json"))).toBe(
      realpathSync(path.join(realClaudeDir, ".claude.json")),
    );

    // ...but a link BELOW the configured directory is still rejected:
    rmSync(path.join(realClaudeDir, "skills"), { recursive: true, force: true });
    linkDir(sb.external, path.join(realClaudeDir, "skills"));
    await expect(
      runSetup({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        claudeConfigDir: configuredClaudeDir,
        packageRoot: sb.pkg,
        clients: ["claude-code"],
        yes: true,
      }),
    ).rejects.toThrow(/CWE-59/);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);
  });

  it("never overwrites an existing backup: the first .causoryn.backup stays byte-identical across runs", async () => {
    const sb = sandbox("backup");
    const configPath = path.join(sb.home, ".zcode", "cli", "config.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{"theme":"dark"}\n', "utf8");

    const base = { homeDir: sb.home, codexHomeDir: sb.codexHome, packageRoot: sb.pkg, installSkills: false, yes: true } as const;
    await runSetup({ ...base, clients: ["zcode"] });
    const primaryBackup = `${configPath}.causoryn.backup`;
    expect(readFileSync(primaryBackup, "utf8")).toBe('{"theme":"dark"}\n');

    await runSetup({ ...base, clients: ["zcode"], toolProfile: "full" });
    expect(readFileSync(primaryBackup, "utf8")).toBe('{"theme":"dark"}\n');
    const secondary = readdirSync(path.dirname(configPath)).filter(
      (name) => name.startsWith("config.json.causoryn.") && name.endsWith(".backup") && name !== "config.json.causoryn.backup",
    );
    expect(secondary).toHaveLength(1);
    // No temporary files are left behind:
    expect(readdirSync(path.dirname(configPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("setup --uninstall: removes only what Causoryn created and never follows links", () => {
  it("keeps a linked skill directory and its target, keeps foreign skills, and removes only Causoryn's SKILL.md next to user files", async () => {
    const sb = sandbox("uninstall-skills");
    const base = { homeDir: sb.home, codexHomeDir: sb.codexHome, packageRoot: sb.pkg, clients: ["zcode"] as const, yes: true } as const;
    await runSetup({ ...base, clients: ["zcode"] });
    const skillsRoot = path.join(sb.home, ".zcode", "skills");
    const [linkedSkill, foreignSkill, mixedSkill, plainSkill] = CANONICAL_SKILL_NAMES;
    if (!linkedSkill || !foreignSkill || !mixedSkill || !plainSkill) throw new Error("expected skills");

    // 1) A skill directory replaced by a link to user data:
    rmSync(path.join(skillsRoot, linkedSkill), { recursive: true, force: true });
    writeFileSync(path.join(sb.external, "SKILL.md"), `---\nname: ${linkedSkill}\n---\nUse causoryn.\n`, "utf8");
    linkDir(sb.external, path.join(skillsRoot, linkedSkill));
    // 2) A user's own skill with the same directory name:
    writeFileSync(path.join(skillsRoot, foreignSkill, "SKILL.md"), "---\nname: my-own-skill\n---\nMine.\n", "utf8");
    // 3) Causoryn's SKILL.md next to a user file:
    writeFileSync(path.join(skillsRoot, mixedSkill, "notes.md"), "user notes\n", "utf8");

    const res = await runSetup({ ...base, clients: ["zcode"], uninstall: true });
    expect(res.applied).toBe(true);

    expect(lstatSync(path.join(skillsRoot, linkedSkill)).isSymbolicLink()).toBe(true);
    expect(listRecursive(sb.external)).toEqual(["SKILL.md", "keep.txt"]);
    expect(readFileSync(path.join(skillsRoot, foreignSkill, "SKILL.md"), "utf8")).toContain("my-own-skill");
    expect(readdirSync(path.join(skillsRoot, mixedSkill))).toEqual(["notes.md"]);
    expect(existsSync(path.join(skillsRoot, plainSkill))).toBe(false);

    const kept = res.actions.filter((a) => a.kind === "skill" && a.operation === "noop");
    expect(kept.map((a) => path.basename(path.dirname(a.targetPath))).sort()).toEqual(
      [foreignSkill, linkedSkill].sort(),
    );
    expect(kept.every((a) => /not created by Causoryn/.test(a.detail))).toBe(true);
  });

  it("removes the staged runtime without following links inside it, and keeps a runtime directory that is itself a link", async () => {
    const sb = sandbox("uninstall-runtime");
    const ephemeralTmp = path.join(sb.root, "ephemeral");
    const npxPkg = createFakePkg(path.join(ephemeralTmp, "_npx", "abc"));
    const runtimeDir = path.join(sb.home, ".causoryn", "runtime");
    const options = {
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: npxPkg,
      ephemeralTmpDir: ephemeralTmp,
      clients: ["zcode"] as const,
      installSkills: false,
      yes: true,
    };

    await runSetup({ ...options, clients: ["zcode"] });
    expect(existsSync(path.join(runtimeDir, "scripts", "causoryn.mjs"))).toBe(true);

    // A link planted inside the staged runtime must not be followed on removal:
    linkDir(sb.external, path.join(runtimeDir, "dist", "planted-link"));
    const res = await runSetup({ ...options, clients: ["zcode"], uninstall: true });
    expect(res.runtimeCleanedUp).toBe(true);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);

    // A runtime directory replaced by a link (not created by Causoryn) is left alone:
    await runSetup({ ...options, clients: ["zcode"] });
    rmSync(runtimeDir, { recursive: true, force: true });
    linkDir(sb.external, runtimeDir);
    const linkedRes = await runSetup({ ...options, clients: ["zcode"], uninstall: true });
    expect(linkedRes.applied).toBe(true);
    expect(linkedRes.runtimeCleanedUp).toBe(false);
    expect(lstatSync(runtimeDir).isSymbolicLink()).toBe(true);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);
  });
});

describe("stagePersistentRuntime: no staging through links below home", () => {
  it("rejects a linked ~/.causoryn or a linked ~/.causoryn/runtime and leaves both link targets untouched", () => {
    const sb = sandbox("stage");
    linkDir(sb.external, path.join(sb.home, ".causoryn"));
    expect(() => stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: sb.pkg })).toThrow(/CWE-59/);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);

    unlinkSync(path.join(sb.home, ".causoryn"));
    mkdirSync(path.join(sb.home, ".causoryn"), { recursive: true });
    linkDir(sb.external, path.join(sb.home, ".causoryn", "runtime"));
    expect(() => stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: sb.pkg })).toThrow(/CWE-59/);
    expect(listRecursive(sb.external)).toEqual(["keep.txt"]);
    expect(lstatSync(path.join(sb.home, ".causoryn", "runtime")).isSymbolicLink()).toBe(true);
    // No staging leftovers:
    expect(readdirSync(path.join(sb.home, ".causoryn")).sort()).toEqual(["runtime"]);
  });

  it("stages into a fresh directory and replaces a previous runtime without leftovers", () => {
    const sb = sandbox("stage-ok");
    const first = stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: sb.pkg });
    expect(existsSync(first.cliEntryPath)).toBe(true);
    const second = stagePersistentRuntime({ homeDir: sb.home, sourcePackageDir: sb.pkg });
    expect(second.runtimeDir).toBe(first.runtimeDir);
    expect(readdirSync(path.join(sb.home, ".causoryn"))).toEqual(["runtime"]);
  });
});
