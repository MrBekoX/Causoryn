import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_SKILL_NAMES,
  detectInstalledClients,
  readCodexMcpServer,
  runSetup,
} from "../packages/causoryn/src/index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-t18-setup-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createFakePkg(baseDir: string, folderName = "pkg"): string {
  const pkgRoot = path.join(baseDir, folderName);
  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "causoryn", version: "0.2.5" }), "utf8");
  writeFileSync(path.join(pkgRoot, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(path.join(pkgRoot, "dist", "mcp-server.mjs"), "// bundle\n", "utf8");
  for (const skillName of CANONICAL_SKILL_NAMES) {
    const dir = path.join(pkgRoot, "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf8");
  }
  return pkgRoot;
}

describe("Task 1.8a — setup.ts DX hardening", () => {
  it("detectInstalledClients does NOT false-positive on bare ~/.gemini (Gemini CLI), only real Antigravity markers", () => {
    const sandbox = createTempDir("detect-gemini");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");

    // 1) Bare ~/.gemini (Gemini CLI user) -> NOT antigravity
    mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".gemini", "settings.json"), "{}\n", "utf8");
    expect(detectInstalledClients(fakeHome, fakeCodex, null)).toEqual([]);

    // 2) Bare ~/.gemini/config dir without mcp_config.json -> still NOT antigravity
    mkdirSync(path.join(fakeHome, ".gemini", "config"), { recursive: true });
    expect(detectInstalledClients(fakeHome, fakeCodex, null)).toEqual([]);

    // 3) Real Antigravity marker #1: ~/.gemini/config/mcp_config.json
    writeFileSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"), "{}\n", "utf8");
    expect(detectInstalledClients(fakeHome, fakeCodex, null)).toEqual(["antigravity"]);

    // 4) Real Antigravity marker #2: ~/.gemini/antigravity
    rmSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"));
    expect(detectInstalledClients(fakeHome, fakeCodex, null)).toEqual([]);
    mkdirSync(path.join(fakeHome, ".gemini", "antigravity"), { recursive: true });
    expect(detectInstalledClients(fakeHome, fakeCodex, null)).toEqual(["antigravity"]);
  });

  it("writes 0 files when no --client / --all is passed and 0 clients are detected, returning actionable instructions", async () => {
    const sandbox = createTempDir("zero-write-default");
    const fakeHome = path.join(sandbox, "home");
    mkdirSync(fakeHome, { recursive: true });
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);

    const result = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      yes: true,
    });

    expect(result.applied).toBe(false);
    expect(result.selectedClients).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(readdirSync(fakeHome)).toEqual([]);
    expect(result.message).toBeDefined();
    expect(result.message).toContain("--client");
    expect(result.message).toContain("--all");

    // Passing all: true explicitly configures all 4 hosts
    const allResult = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      all: true,
      installSkills: false,
      yes: true,
    });
    expect(allResult.applied).toBe(true);
    expect(allResult.selectedClients).toEqual(["antigravity", "claude-code", "codex", "zcode"]);
  });

  it("is truly idempotent (second identical run writes 0 files, touches 0 backups, reports noop/unchanged)", async () => {
    const sandbox = createTempDir("idempotent");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);

    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeCodex, { recursive: true });
    mkdirSync(path.join(fakeHome, ".gemini", "config"), { recursive: true });
    mkdirSync(path.join(fakeHome, ".zcode", "cli"), { recursive: true });

    const originalClaude = JSON.stringify({ numStartups: 1, mcpServers: {} }, null, 2) + "\n";
    const originalCodex = 'model = "gpt-5"\n';
    const originalAgy = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
    const originalZcode = JSON.stringify({ theme: "dark" }, null, 2) + "\n";

    writeFileSync(path.join(fakeHome, ".claude.json"), originalClaude, "utf8");
    writeFileSync(path.join(fakeCodex, "config.toml"), originalCodex, "utf8");
    writeFileSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"), originalAgy, "utf8");
    writeFileSync(path.join(fakeHome, ".zcode", "cli", "config.json"), originalZcode, "utf8");

    const first = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["antigravity", "claude-code", "codex", "zcode"],
      yes: true,
    });
    expect(first.applied).toBe(true);

    const claudeBackupPath = path.join(fakeHome, ".claude.json.causoryn.backup");
    expect(readFileSync(claudeBackupPath, "utf8")).toBe(originalClaude);
    const claudeMtimeAfterFirst = statSync(path.join(fakeHome, ".claude.json")).mtimeMs;
    const backupMtimeAfterFirst = statSync(claudeBackupPath).mtimeMs;

    // Second run with identical inputs: MUST be a true no-op!
    const second = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["antigravity", "claude-code", "codex", "zcode"],
      yes: true,
    });
    expect(second.applied).toBe(false);
    expect(second.actions.every((a) => a.operation === "noop")).toBe(true);
    expect(second.actions.every((a) => a.backupPath === null)).toBe(true);
    expect(statSync(path.join(fakeHome, ".claude.json")).mtimeMs).toBe(claudeMtimeAfterFirst);
    expect(statSync(claudeBackupPath).mtimeMs).toBe(backupMtimeAfterFirst);
    expect(readFileSync(claudeBackupPath, "utf8")).toBe(originalClaude);
  });

  it("preserves the original .causoryn.backup forever across subsequent modifications and cleans up .tmp files on renameSync failure", async () => {
    const sandbox = createTempDir("preserve-backup");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);
    mkdirSync(fakeHome, { recursive: true });

    const originalClaude = JSON.stringify({ userKey: "original-v0", mcpServers: {} }, null, 2) + "\n";
    const claudePath = path.join(fakeHome, ".claude.json");
    const primaryBackupPath = `${claudePath}.causoryn.backup`;
    writeFileSync(claudePath, originalClaude, "utf8");

    // 1st run creates primary .causoryn.backup with v0
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: false,
      nodeExecutable: "/opt/node/v24.0.0/bin/node",
      yes: true,
    });
    expect(readFileSync(primaryBackupPath, "utf8")).toBe(originalClaude);
    const v1Content = readFileSync(claudePath, "utf8");

    // 2nd run with a different nodeExecutable actually modifies claude.json:
    // Primary .causoryn.backup MUST STILL equal original-v0!
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: false,
      nodeExecutable: "/opt/node/v24.1.0/bin/node",
      yes: true,
    });
    expect(readFileSync(primaryBackupPath, "utf8")).toBe(originalClaude);
    const secondaryBackups = readdirSync(fakeHome).filter(
      (f) => f.startsWith(".claude.json.causoryn.") && f.endsWith(".backup") && f !== ".claude.json.causoryn.backup",
    );
    expect(secondaryBackups.length).toBe(1);
    expect(readFileSync(path.join(fakeHome, secondaryBackups[0]!), "utf8")).toBe(v1Content);

    // 3rd: renameSync failure cleans up all .tmp files in try/finally
    await expect(
      runSetup({
        homeDir: fakeHome,
        codexHomeDir: fakeCodex,
        packageRoot: pkgRoot,
        ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
        clients: ["claude-code"],
        installSkills: false,
        nodeExecutable: "/opt/node/v24.2.0/bin/node",
        renameFile: () => {
          throw new Error("simulated renameSync EACCES");
        },
        yes: true,
      }),
    ).rejects.toThrow(/simulated renameSync EACCES/);

    const leftoverTmps = readdirSync(fakeHome).filter((f) => f.endsWith(".tmp"));
    expect(leftoverTmps).toEqual([]);
  });

  it("writes absolute node binary (options.nodeExecutable ?? process.execPath) instead of bare 'node' across all 4 host configs", async () => {
    const sandbox = createTempDir("abs-node");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);
    mkdirSync(fakeHome, { recursive: true });

    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["antigravity", "claude-code", "codex", "zcode"],
      installSkills: false,
      yes: true,
    });

    const agy = JSON.parse(
      readFileSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"), "utf8"),
    ) as { mcpServers: { causoryn: { command: string } } };
    expect(agy.mcpServers.causoryn.command).toBe(process.execPath);
    expect(path.isAbsolute(agy.mcpServers.causoryn.command)).toBe(true);

    const claude = JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8")) as {
      mcpServers: { causoryn: { command: string } };
    };
    expect(claude.mcpServers.causoryn.command).toBe(process.execPath);

    const zcode = JSON.parse(
      readFileSync(path.join(fakeHome, ".zcode", "cli", "config.json"), "utf8"),
    ) as { mcp: { servers: { causoryn: { command: string } } } };
    expect(zcode.mcp.servers.causoryn.command).toBe(process.execPath);

    const codex = readCodexMcpServer(readFileSync(path.join(fakeCodex, "config.toml"), "utf8"));
    expect(codex?.command).toBe(process.execPath);
    expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(true);
  });
});
