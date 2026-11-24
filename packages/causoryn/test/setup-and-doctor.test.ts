import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDoctorProbeEnv,
  CAUSORYN_PACKAGE_NAME,
  CAUSORYN_PACKAGE_VERSION,
  CausorynCliError,
  CANONICAL_SKILL_NAMES,
  HOST_CLIENT_IDS,
  isEphemeralRuntimeDir,
  readCodexMcpServer,
  removeCodexMcpServer,
  runCli,
  runDoctor,
  runSetup,
  stagePersistentRuntime,
  upsertCodexMcpServer,
  validateTomlStructure,
} from "../src/index.js";
import { isLinuxMusl } from "../src/doctor.js";

const CAUSORYN_PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Track 3 TDD Suite — `packages/causoryn` (`toml-patch`, `runtime-stage`,
 * `setup`, `doctor`, `cli`).
 *
 * Güvenlik garantisi: HİÇBİR test kullanıcının gerçek ev dizinine
 * (`~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.zcode`, `~/.causoryn`)
 * dokunmaz; her test `os.tmpdir()` altında izole sahte `homeDir` ve
 * `codexHomeDir` yaratır ve `afterEach` içinde temizler.
 */

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-t3-${prefix}-`));
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

/** Test için minimal, geçerli bir sahnelenmiş `causoryn` paket dizini kurar. */
function createFakePackageRoot(
  baseDir: string,
  folderName = "fake-pkg",
  options?: {
    readonly includePrebuild?: boolean;
    readonly includeTsLib?: boolean;
    readonly includeNative?: boolean;
    readonly includeRoslynDll?: boolean;
    readonly prebuildFilename?: string;
  },
): string {
  const pkgRoot = path.join(baseDir, folderName);
  const includePrebuild = options?.includePrebuild ?? true;
  const includeTsLib = options?.includeTsLib ?? true;
  const includeNative = options?.includeNative ?? true;
  const includeRoslynDll = options?.includeRoslynDll ?? true;

  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });

  writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: "causoryn", version: "0.2.0", type: "module" }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "scripts", "causoryn.mjs"),
    "#!/usr/bin/env node\n",
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "scripts", "plugin-mcp-launcher.mjs"),
    "#!/usr/bin/env node\n",
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "dist", "mcp-server.mjs"),
    "// compiled mcp-server bundle\n",
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "dist", "bundle-manifest.json"),
    JSON.stringify({ files: { "mcp-server.mjs": "0".repeat(64) } }, null, 2),
    "utf8",
  );

  if (includePrebuild) {
    const prebuildsDir = path.join(
      pkgRoot,
      "dist",
      "node_modules",
      "better-sqlite3",
      "prebuilds",
    );
    mkdirSync(prebuildsDir, { recursive: true });
    writeFileSync(
      path.join(pkgRoot, "dist", "node_modules", "better-sqlite3", "package.json"),
      JSON.stringify({ name: "better-sqlite3", version: "12.0.0" }),
      "utf8",
    );
    writeFileSync(
      path.join(prebuildsDir, options?.prebuildFilename ?? `${process.platform}-${process.arch}.node`),
      "fake-binary",
      "utf8",
    );
  }

  if (includeTsLib) {
    const tsLibDir = path.join(pkgRoot, "dist", "typescript-lib");
    mkdirSync(tsLibDir, { recursive: true });
    writeFileSync(
      path.join(tsLibDir, "lib.es2022.full.d.ts"),
      "interface Array<T> {}\n",
      "utf8",
    );
  }

  if (includeNative) {
    mkdirSync(path.join(pkgRoot, "native", "python-worker"), { recursive: true });
    writeFileSync(
      path.join(pkgRoot, "native", "python-worker", "worker.py"),
      "# python worker\n",
      "utf8",
    );
    mkdirSync(path.join(pkgRoot, "native", "go-worker", "cmd", "worker"), {
      recursive: true,
    });
    writeFileSync(
      path.join(pkgRoot, "native", "go-worker", "cmd", "worker", "main.go"),
      "package main\n",
      "utf8",
    );
    mkdirSync(path.join(pkgRoot, "native", "rust-worker", "src"), { recursive: true });
    writeFileSync(
      path.join(pkgRoot, "native", "rust-worker", "Cargo.toml"),
      '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\n',
      "utf8",
    );
    mkdirSync(path.join(pkgRoot, "native", "roslyn-worker"), { recursive: true });
    writeFileSync(
      path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.csproj"),
      "<Project />\n",
      "utf8",
    );
    if (includeRoslynDll) {
      writeFileSync(
        path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
        "fake-roslyn-dll",
        "utf8",
      );
    }
  }

  for (const skillName of CANONICAL_SKILL_NAMES) {
    const skillDir = path.join(pkgRoot, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Routing skill for ${skillName}\n---\n\nUse \`causoryn_map_system\`.\n`,
      "utf8",
    );
  }

  return pkgRoot;
}

function snapshotTree(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      if (item.isDirectory()) {
        entries.push(`d:${rel}`);
        walk(full);
      } else if (item.isFile()) {
        const st = statSync(full);
        entries.push(`f:${rel}:${String(st.size)}`);
      }
    }
  };
  walk(rootDir);
  return entries.sort();
}

describe("exports & metadata", () => {
  it("exports canonical package metadata and 4 host client ids", () => {
    expect(CAUSORYN_PACKAGE_NAME).toBe("causoryn");
    const expectedPkgVersion = (
      JSON.parse(
        readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    expect(CAUSORYN_PACKAGE_VERSION).toBe(expectedPkgVersion);
    expect(HOST_CLIENT_IDS).toEqual(["antigravity", "claude-code", "codex", "zcode"]);
    expect(CANONICAL_SKILL_NAMES).toEqual([
      "causoryn",
      "map-system",
      "preflight-change",
      "verify-change",
      "architecture-blueprint",
    ]);
  });
});

describe("toml-patch (Codex config.toml fail-closed + preservation)", () => {
  it("rejects malformed TOML fail-closed with cli/malformed-toml", () => {
    const malformedInputs = [
      '[mcp_servers.causoryn\ncommand = "node"\n',
      '[mcp_servers.causoryn]\ncommand = "unterminated\n',
      "[mcp_servers.causoryn]\nthis line has no equals sign\n",
      '[mcp_servers.causoryn]\nargs = ["unclosed"\n',
      "[]\ncommand = \"node\"\n",
      '[mcp_servers.causoryn]\ncommand = "node"\n\n[mcp_servers.causoryn]\ncommand = "node"\n',
    ];
    for (const raw of malformedInputs) {
      expect(() => validateTomlStructure(raw)).toThrow(CausorynCliError);
      expect(() => upsertCodexMcpServer(raw, { command: "node", args: ["a.mjs"] })).toThrow(
        /TOML/i,
      );
      expect(() => removeCodexMcpServer(raw)).toThrow(CausorynCliError);
    }
  });

  it("upserts [mcp_servers.causoryn] with startup_timeout_sec = 30 while preserving comments, neighbor servers, and [mcp_servers.causoryn.tools.*] sub-tables", () => {
    const initial = [
      "# Global user settings",
      'model = "gpt-5"',
      "",
      "# Keep neighbor comment",
      "[mcp_servers.other_server]",
      'command = "npx"',
      'args = ["-y", "other-mcp"]',
      "",
      "[mcp_servers.causoryn]",
      'command = "legacy-node"',
      'args = ["legacy.mjs"]',
      "",
      "# Tool-level approval preferences must survive updates",
      "[mcp_servers.causoryn.tools.causoryn_map_system]",
      'approval_mode = "always_allow"',
      "",
      "[mcp_servers.trailing]",
      'command = "node"',
      'args = ["trailing.mjs"]',
      "",
    ].join("\n");

    const updated = upsertCodexMcpServer(initial, {
      command: "node",
      args: [
        "C:\\Users\\demo\\.causoryn\\runtime\\scripts\\causoryn.mjs",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "codex",
      ],
    });

    expect(updated).toContain("# Global user settings");
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain("# Keep neighbor comment");
    expect(updated).toContain("[mcp_servers.other_server]");
    expect(updated).toContain("[mcp_servers.trailing]");
    expect(updated).toContain("[mcp_servers.causoryn.tools.causoryn_map_system]");
    expect(updated).toContain('approval_mode = "always_allow"');
    expect(updated).toContain("startup_timeout_sec = 30");
    expect(updated).not.toContain("legacy-node");

    const parsed = readCodexMcpServer(updated);
    expect(parsed).not.toBeNull();
    expect(parsed?.command).toBe("node");
    expect(parsed?.startupTimeoutSec).toBe(30);
    expect(parsed?.args).toEqual([
      "C:\\Users\\demo\\.causoryn\\runtime\\scripts\\causoryn.mjs",
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "codex",
    ]);
  });

  it("removes [mcp_servers.causoryn] cleanly while preserving comments and neighbor tables", () => {
    const withCausoryn = [
      "# Header comment",
      "[mcp_servers.alpha]",
      'command = "npx"',
      'args = ["alpha"]',
      "",
      "[mcp_servers.causoryn]",
      'command = "node"',
      'args = ["causoryn.mjs", "mcp"]',
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.causoryn.tools.causoryn_map_system]",
      'approval_mode = "always_allow"',
      "",
      "# Beta comment",
      "[mcp_servers.beta]",
      'command = "npx"',
      'args = ["beta"]',
      "",
    ].join("\n");

    const removed = removeCodexMcpServer(withCausoryn);
    expect(removed.removed).toBe(true);
    expect(removed.content).toContain("# Header comment");
    expect(removed.content).toContain("[mcp_servers.alpha]");
    expect(removed.content).toContain("# Beta comment");
    expect(removed.content).toContain("[mcp_servers.beta]");
    expect(removed.content).not.toContain("[mcp_servers.causoryn]");
    expect(removed.content).not.toContain("mcp_servers.causoryn.tools");
    expect(readCodexMcpServer(removed.content)).toBeNull();
  });
});

describe("runtime-stage (_npx / tmpdir detection + atomic persistent staging)", () => {
  it("identifies _npx cache paths and os.tmpdir() paths as ephemeral, and persistent paths as non-ephemeral", () => {
    const sandbox = createTempDir("ephemeral");
    const customTmp = path.join(sandbox, "sys-tmp");
    mkdirSync(customTmp, { recursive: true });

    expect(
      isEphemeralRuntimeDir(
        path.join("/home/dev/.npm/_npx/9f8a1b/node_modules/causoryn"),
        { tmpDir: customTmp },
      ),
    ).toBe(true);
    expect(
      isEphemeralRuntimeDir(path.join(customTmp, "ephemeral-extract", "causoryn"), {
        tmpDir: customTmp,
      }),
    ).toBe(true);
    expect(
      isEphemeralRuntimeDir(path.join(sandbox, "usr-local-lib", "node_modules", "causoryn"), {
        tmpDir: customTmp,
      }),
    ).toBe(false);
  });

  it("stages runtime atomically into <homeDir>/.causoryn/runtime and replaces prior staged runtime cleanly", () => {
    const sandbox = createTempDir("stage");
    const fakeHome = path.join(sandbox, "home");
    const sourcePkg = createFakePackageRoot(sandbox, "npx-source");

    const first = stagePersistentRuntime({
      homeDir: fakeHome,
      sourcePackageDir: sourcePkg,
    });
    expect(first.runtimeDir).toBe(path.join(fakeHome, ".causoryn", "runtime"));
    expect(existsSync(first.cliEntryPath)).toBe(true);
    expect(existsSync(first.launcherPath)).toBe(true);
    expect(existsSync(path.join(first.runtimeDir, "dist", "mcp-server.mjs"))).toBe(true);

    writeFileSync(
      path.join(sourcePkg, "dist", "mcp-server.mjs"),
      "// updated bundle v2\n",
      "utf8",
    );
    const second = stagePersistentRuntime({
      homeDir: fakeHome,
      sourcePackageDir: sourcePkg,
    });
    expect(readFileSync(path.join(second.runtimeDir, "dist", "mcp-server.mjs"), "utf8")).toContain(
      "updated bundle v2",
    );
  });

  it("no-ops self-staging idempotently when setup or stagePersistentRuntime runs from <fakeHome>/.causoryn/runtime inside os.tmpdir()", async () => {
    const sandbox = createTempDir("self-stage-guard");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const npxPkg = createFakePackageRoot(path.join(sandbox, "_npx", "init"), "causoryn");

    const initialSetup = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: npxPkg,
      clients: ["claude-code", "codex"],
      yes: true,
    });
    const stagedDir = path.join(fakeHome, ".causoryn", "runtime");
    expect(initialSetup.stagedRuntimeDir).toBe(stagedDir);

    // Place a sentinel file inside <fakeHome>/.causoryn/runtime outside RUNTIME_STAGE_ENTRIES:
    // if self-staging erroneously renames targetDir onto itself, this sentinel would be lost!
    const sentinelPath = path.join(stagedDir, ".self-stage-sentinel");
    writeFileSync(sentinelPath, "keep-alive\n", "utf8");

    const directNoop = stagePersistentRuntime({
      homeDir: fakeHome,
      sourcePackageDir: stagedDir,
    });
    expect(directNoop.runtimeDir).toBe(stagedDir);
    expect(existsSync(sentinelPath)).toBe(true);

    const dryRerun = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: stagedDir,
      clients: ["claude-code", "codex"],
      dryRun: true,
      yes: false,
    });
    expect(dryRerun.stagedRuntimeDir).toBeNull();

    const liveRerun = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: stagedDir,
      clients: ["claude-code", "codex"],
      yes: true,
    });
    expect(liveRerun.applied).toBe(false);
    expect(liveRerun.actions.every((a) => a.operation === "noop")).toBe(true);
    expect(liveRerun.stagedRuntimeDir).toBeNull();
    expect(existsSync(sentinelPath)).toBe(true);

    const claudeJson = JSON.parse(readFileSync(path.join(fakeHome, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(claudeJson.mcpServers["causoryn"]?.args[0]).toBe(
      path.join(stagedDir, "scripts", "causoryn.mjs"),
    );
  });
});

describe("setup wizard (4 hosts, backups, fail-closed, ZCode fallback, Antigravity dual-path, uninstall)", () => {
  it("supports --dry-run without creating any files, backups, skills, or staged runtime", async () => {
    const sandbox = createTempDir("dry-run");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    const npxPkg = createFakePackageRoot(path.join(sandbox, "_npx", "abc"), "causoryn");

    const before = snapshotTree(fakeHome);
    const result = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: npxPkg,
      clients: ["antigravity", "claude-code", "codex", "zcode"],
      dryRun: true,
      yes: false,
    });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.actions.length).toBeGreaterThanOrEqual(4);
    expect(snapshotTree(fakeHome)).toEqual(before);
    expect(existsSync(path.join(fakeHome, ".causoryn", "runtime"))).toBe(false);
  });

  it("refuses to write when yes is false and no confirmation callback approves", async () => {
    const sandbox = createTempDir("confirm-gate");
    const fakeHome = path.join(sandbox, "home");
    mkdirSync(fakeHome, { recursive: true });
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");

    await expect(
      runSetup({
        homeDir: fakeHome,
        codexHomeDir: path.join(fakeHome, ".codex"),
        packageRoot: pkgRoot,
        ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
        clients: ["claude-code"],
        yes: false,
      }),
    ).rejects.toThrow(CausorynCliError);

    expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(false);
  });

  it("installs all 4 hosts, creates .causoryn.backup on pre-existing configs, preserves ZCode ~/.agents/mcp.json fallback and Antigravity dual mcp_config.json", async () => {
    const sandbox = createTempDir("install-4-hosts");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(path.join(sandbox, "_npx", "hash1"), "causoryn");

    // Pre-existing Antigravity primary + secondary ~/.gemini/antigravity/mcp_config.json
    mkdirSync(path.join(fakeHome, ".gemini", "config"), { recursive: true });
    mkdirSync(path.join(fakeHome, ".gemini", "antigravity"), { recursive: true });
    const initialAgyConfig = JSON.stringify(
      { mcpServers: { existingAgy: { command: "npx", args: ["existing-agy"] } } },
      null,
      2,
    );
    writeFileSync(
      path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
      initialAgyConfig,
      "utf8",
    );
    writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity", "mcp_config.json"),
      initialAgyConfig,
      "utf8",
    );

    // Pre-existing Claude Code config
    const initialClaudeConfig = JSON.stringify(
      {
        numStartups: 7,
        mcpServers: { existingClaude: { command: "npx", args: ["existing-claude"] } },
      },
      null,
      2,
    );
    writeFileSync(path.join(fakeHome, ".claude.json"), initialClaudeConfig, "utf8");

    // Pre-existing Codex config with sub-table
    mkdirSync(fakeCodexHome, { recursive: true });
    const initialCodexToml = [
      "# Codex user config",
      "[mcp_servers.neighbor]",
      'command = "npx"',
      'args = ["neighbor"]',
      "",
      "[mcp_servers.causoryn.tools.causoryn_map_system]",
      'approval_mode = "always_allow"',
      "",
    ].join("\n");
    writeFileSync(path.join(fakeCodexHome, "config.toml"), initialCodexToml, "utf8");

    // Pre-existing ZCode fallback ~/.agents/mcp.json while ~/.zcode/cli/config.json has NO mcp.servers yet!
    mkdirSync(path.join(fakeHome, ".agents"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".agents", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            fallbackDocs: {
              command: "npx",
              args: ["-y", "docs-mcp"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".zcode", "cli"), { recursive: true });
    writeFileSync(
      path.join(fakeHome, ".zcode", "cli", "config.json"),
      JSON.stringify({ theme: "dark" }, null, 2),
      "utf8",
    );

    const result = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      allDetected: true,
      yes: true,
    });

    expect(result.applied).toBe(true);
    expect(result.stagedRuntimeDir).toBe(path.join(fakeHome, ".causoryn", "runtime"));

    const expectedCliScript = path.join(
      fakeHome,
      ".causoryn",
      "runtime",
      "scripts",
      "causoryn.mjs",
    );
    expect(existsSync(expectedCliScript)).toBe(true);

    // Backups exist for all modified pre-existing files
    expect(
      existsSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json.causoryn.backup")),
    ).toBe(true);
    expect(
      existsSync(
        path.join(fakeHome, ".gemini", "antigravity", "mcp_config.json.causoryn.backup"),
      ),
    ).toBe(true);
    expect(existsSync(path.join(fakeHome, ".claude.json.causoryn.backup"))).toBe(true);
    expect(existsSync(path.join(fakeCodexHome, "config.toml.causoryn.backup"))).toBe(true);
    expect(
      existsSync(path.join(fakeHome, ".zcode", "cli", "config.json.causoryn.backup")),
    ).toBe(true);

    // Antigravity primary & secondary both updated with neighbor preserved
    for (const agySub of ["config", "antigravity"]) {
      const agyJson = JSON.parse(
        readFileSync(path.join(fakeHome, ".gemini", agySub, "mcp_config.json"), "utf8"),
      ) as { mcpServers: Record<string, { command: string; args: string[] }> };
      expect(agyJson.mcpServers["existingAgy"]).toBeDefined();
      expect(agyJson.mcpServers["causoryn"]).toEqual({
        command: process.execPath,
        args: [
          expectedCliScript,
          "mcp",
          "--allow-cwd",
          "--auto-data-dir",
          "--client",
          "antigravity",
        ],
      });
    }

    // Claude Code updated with neighbor & top-level fields preserved
    const claudeJson = JSON.parse(
      readFileSync(path.join(fakeHome, ".claude.json"), "utf8"),
    ) as {
      numStartups: number;
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(claudeJson.numStartups).toBe(7);
    expect(claudeJson.mcpServers["existingClaude"]).toBeDefined();
    expect(claudeJson.mcpServers["causoryn"]).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [
        expectedCliScript,
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "claude-code",
      ],
    });

    // Codex updated with startup_timeout_sec = 30, neighbor & sub-table preserved
    const codexRaw = readFileSync(path.join(fakeCodexHome, "config.toml"), "utf8");
    expect(codexRaw).toContain("[mcp_servers.neighbor]");
    expect(codexRaw).toContain("[mcp_servers.causoryn.tools.causoryn_map_system]");
    const parsedCodex = readCodexMcpServer(codexRaw);
    expect(parsedCodex?.startupTimeoutSec).toBe(30);
    expect(parsedCodex?.args).toEqual([
      expectedCliScript,
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "codex",
    ]);

    // ZCode updated AND fallbackDocs from ~/.agents/mcp.json preserved in mcp.servers!
    const zcodeJson = JSON.parse(
      readFileSync(path.join(fakeHome, ".zcode", "cli", "config.json"), "utf8"),
    ) as {
      theme: string;
      mcp: {
        servers: Record<string, { type?: string; command: string; args: string[] }>;
      };
    };
    expect(zcodeJson.theme).toBe("dark");
    expect(zcodeJson.mcp.servers["fallbackDocs"]).toMatchObject({
      command: "npx",
      args: ["-y", "docs-mcp"],
    });
    expect(zcodeJson.mcp.servers["causoryn"]).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [expectedCliScript, "mcp", "--allow-cwd", "--auto-data-dir", "--client", "zcode"],
    });

    // All 4 skills installed in each of the 4 hosts' skill roots
    const skillRoots = [
      path.join(fakeHome, ".gemini", "config", "skills"),
      path.join(fakeHome, ".claude", "skills"),
      path.join(fakeHome, ".agents", "skills"),
      path.join(fakeHome, ".zcode", "skills"),
    ];
    for (const skillRoot of skillRoots) {
      for (const skillName of CANONICAL_SKILL_NAMES) {
        expect(existsSync(path.join(skillRoot, skillName, "SKILL.md"))).toBe(true);
      }
    }

    // Partial uninstall (3 hosts) keeps ~/.causoryn/runtime because zcode still points to it
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      clients: ["antigravity", "claude-code", "codex"],
      uninstall: true,
      yes: true,
    });
    expect(existsSync(path.join(fakeHome, ".causoryn", "runtime"))).toBe(true);

    // Final uninstall (zcode) cleans up ~/.causoryn/runtime AND keeps fallbackDocs intact!
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      clients: ["zcode"],
      uninstall: true,
      yes: true,
    });
    expect(existsSync(path.join(fakeHome, ".causoryn", "runtime"))).toBe(false);

    const zcodeAfterUninstall = JSON.parse(
      readFileSync(path.join(fakeHome, ".zcode", "cli", "config.json"), "utf8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(zcodeAfterUninstall.mcp?.servers?.["causoryn"]).toBeUndefined();
    expect(zcodeAfterUninstall.mcp?.servers?.["fallbackDocs"]).toBeDefined();
  });

  it("does NOT create ~/.gemini/antigravity/mcp_config.json when absent, and supports --no-skill", async () => {
    const sandbox = createTempDir("agy-single-noskill");
    const fakeHome = path.join(sandbox, "home");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");

    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: path.join(fakeHome, ".codex"),
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "ephemeral-only"),
      clients: ["antigravity"],
      installSkills: false,
      yes: true,
    });

    expect(existsSync(path.join(fakeHome, ".gemini", "config", "mcp_config.json"))).toBe(true);
    expect(existsSync(path.join(fakeHome, ".gemini", "antigravity", "mcp_config.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(fakeHome, ".gemini", "config", "skills"))).toBe(false);
  });

  it("fails closed with zero writes on malformed JSON or malformed TOML across multi-client setup", async () => {
    const sandbox = createTempDir("fail-closed");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    mkdirSync(fakeCodexHome, { recursive: true });
    writeFileSync(path.join(fakeHome, ".claude.json"), '{"mcpServers":{}}', "utf8");
    writeFileSync(path.join(fakeCodexHome, "config.toml"), "[broken_header\nx = 1\n", "utf8");

    const pkgRoot = createFakePackageRoot(path.join(sandbox, "_npx", "bad"), "causoryn");
    const beforeClaude = readFileSync(path.join(fakeHome, ".claude.json"), "utf8");

    await expect(
      runSetup({
        homeDir: fakeHome,
        codexHomeDir: fakeCodexHome,
        packageRoot: pkgRoot,
        clients: ["claude-code", "codex"],
        yes: true,
      }),
    ).rejects.toThrow(CausorynCliError);

    // Zero writes to claude.json and zero staged runtime!
    expect(readFileSync(path.join(fakeHome, ".claude.json"), "utf8")).toBe(beforeClaude);
    expect(existsSync(path.join(fakeHome, ".causoryn", "runtime"))).toBe(false);
  });
});

describe("doctor (strictly read-only health check + injectable toolchain seam + CLI --json)", () => {
  it("is 100% read-only and reports healthy status when Node >= 24, runtime complete, and hosts aligned", async () => {
    const sandbox = createTempDir("doctor-ok");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");

    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["antigravity", "claude-code", "codex", "zcode"],
      yes: true,
    });

    const beforeSnapshot = snapshotTree(fakeHome);
    const seenProbes: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];

    const report = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      nodeVersion: "24.19.2",
      probeToolchain: (command, args, timeoutMs) => {
        seenProbes.push({ command, args, timeoutMs });
        if (command === "cargo") {
          return { available: false, version: null, detail: "ENOENT" };
        }
        return { available: true, version: `${command} 1.0.0`, detail: "ok" };
      },
    });

    // Strictly read-only: zero files created or modified
    expect(snapshotTree(fakeHome)).toEqual(beforeSnapshot);

    expect(report.healthy).toBe(true);
    expect(report.node.ok).toBe(true);
    expect(report.runtime.ok).toBe(true);
    expect(seenProbes.every((p) => p.timeoutMs === 5_000)).toBe(true);
    expect(report.toolchains["dotnet"].mode).toBe("sidecar-ready");
    expect(report.toolchains["cargo"].mode).toBe("l0-l1-fallback");
    for (const client of HOST_CLIENT_IDS) {
      expect(report.hosts[client].aligned).toBe(true);
      expect(report.hosts[client].status).toBe("ok");
    }
  });

  it("flags Node < 24, missing runtime files, and malformed host config as unhealthy without touching disk", () => {
    const sandbox = createTempDir("doctor-unhealthy");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(path.join(fakeHome, ".claude.json"), "{ invalid json", "utf8");

    const brokenPkg = createFakePackageRoot(sandbox, "broken-pkg", {
      includePrebuild: false,
      includeTsLib: false,
    });

    const beforeSnapshot = snapshotTree(fakeHome);
    const report = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: brokenPkg,
      nodeVersion: "22.11.0",
      probeToolchain: () => ({ available: false, version: null, detail: "missing" }),
    });

    expect(snapshotTree(fakeHome)).toEqual(beforeSnapshot);
    expect(report.healthy).toBe(false);
    expect(report.node.ok).toBe(false);
    expect(report.runtime.ok).toBe(false);
    expect(report.hosts["claude-code"].configValid).toBe(false);
    expect(report.hosts["claude-code"].status).toBe("error");
  });

  it("rejects missing/empty command in JSON host causoryn entries and non-object mcpServers in secondary Antigravity config", async () => {
    const sandbox = createTempDir("doctor-config-parity");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");

    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["antigravity", "claude-code", "zcode"],
      yes: true,
    });

    // 1) Overwrite JSON host causoryn entries with missing / empty / whitespace command
    writeFileSync(
      path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { causoryn: { command: "" } } }, null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { causoryn: { type: "stdio", args: ["mcp"] } } }, null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(fakeHome, ".zcode", "cli", "config.json"),
      JSON.stringify({ mcp: { servers: { causoryn: { command: "   ", args: [] } } } }, null, 2),
      "utf8",
    );

    const missingCmdReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      nodeVersion: "24.19.2",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });

    expect(missingCmdReport.healthy).toBe(false);
    for (const client of ["antigravity", "claude-code", "zcode"] as const) {
      expect(missingCmdReport.hosts[client].mcpConfigured).toBe(false);
      expect(missingCmdReport.hosts[client].configValid).toBe(false);
      expect(missingCmdReport.hosts[client].status).toBe("error");
      expect(missingCmdReport.hosts[client].detail).toMatch(/command/i);
    }

    // 2) Restore valid primary Antigravity config, then test secondary ~/.gemini/antigravity/mcp_config.json
    //    with array and primitive mcpServers values
    writeFileSync(
      path.join(fakeHome, ".gemini", "config", "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            causoryn: {
              command: "node",
              args: [path.join(pkgRoot, "scripts", "causoryn.mjs"), "mcp"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    mkdirSync(path.join(fakeHome, ".gemini", "antigravity"), { recursive: true });
    const secondaryPath = path.join(fakeHome, ".gemini", "antigravity", "mcp_config.json");

    for (const badSecondary of [
      { mcpServers: ["not-an-object"] },
      { mcpServers: "primitive-string" },
    ]) {
      writeFileSync(secondaryPath, JSON.stringify(badSecondary, null, 2), "utf8");
      const secReport = runDoctor({
        homeDir: fakeHome,
        codexHomeDir: fakeCodexHome,
        packageRoot: pkgRoot,
        clients: ["antigravity"],
        nodeVersion: "24.19.2",
        probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
      });
      expect(secReport.healthy).toBe(false);
      expect(secReport.hosts["antigravity"].configValid).toBe(false);
      expect(secReport.hosts["antigravity"].status).toBe("error");
      expect(secReport.hosts["antigravity"].detail).toMatch(/mcpServers/);
    }
  });

  it("supports CLI --version, --help, setup --json, and doctor --json with pure stdout JSON", async () => {
    const sandbox = createTempDir("cli-json");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");

    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const io = {
      stdout: (text: string) => outChunks.push(text),
      stderr: (text: string) => errChunks.push(text),
    };

    const versionExit = await runCli(["--version"], { io, homeDir: fakeHome });
    expect(versionExit).toBe(0);
    const pkgJsonVersion = (
      JSON.parse(
        readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    expect(outChunks.join("").trim()).toBe(pkgJsonVersion);

    outChunks.length = 0;
    const setupExit = await runCli(
      ["setup", "--client", "claude-code", "--yes", "--json"],
      {
        io,
        homeDir: fakeHome,
        codexHomeDir: fakeCodexHome,
        packageRoot: pkgRoot,
        ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      },
    );
    expect(setupExit).toBe(0);
    const setupJson = JSON.parse(outChunks.join("")) as { applied: boolean };
    expect(setupJson.applied).toBe(true);

    outChunks.length = 0;
    const doctorExit = await runCli(["doctor", "--client", "claude-code", "--json"], {
      io,
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(doctorExit).toBe(0);
    const doctorJson = JSON.parse(outChunks.join("")) as { healthy: boolean; overallStatus: string };
    expect(doctorJson.healthy).toBe(true);
    expect(doctorJson.overallStatus).toBe("HEALTHY");
    expect(errChunks).toEqual([]);
  });

  it("strips ambient secrets and loader-injection env vars in buildDoctorProbeEnv", () => {
    const filtered = buildDoctorProbeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/fake-home",
      OPENAI_API_KEY: "test-placeholder-redacted",
      GITHUB_TOKEN: "test-placeholder-redacted",
      PYTHONPATH: "/tmp/injected-py",
      LD_PRELOAD: "/tmp/injected.so",
      DOTNET_STARTUP_HOOKS: "/tmp/injected.dll",
      RUSTC_WRAPPER: "/tmp/injected-rustc",
    });

    expect(filtered["PATH"]).toBe("/usr/bin:/bin");
    expect(filtered["HOME"]).toBe("/tmp/fake-home");
    expect(filtered["PYTHONIOENCODING"]).toBe("utf-8");
    expect(filtered["OPENAI_API_KEY"]).toBeUndefined();
    expect(filtered["GITHUB_TOKEN"]).toBeUndefined();
    expect(filtered["PYTHONPATH"]).toBeUndefined();
    expect(filtered["LD_PRELOAD"]).toBeUndefined();
    expect(filtered["DOTNET_STARTUP_HOOKS"]).toBeUndefined();
    expect(filtered["RUSTC_WRAPPER"]).toBeUndefined();
  });

  it("rejects non-regular / symlink config or backup targets fail-closed and preserves restrictive file modes", async () => {
    const sandbox = createTempDir("setup-perms-and-symlinks");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");
    mkdirSync(fakeHome, { recursive: true });

    // 1) Directory masquerading as ~/.claude.json -> fail closed with cli/io-error
    const claudeConfigPath = path.join(fakeHome, ".claude.json");
    mkdirSync(claudeConfigPath, { recursive: true });
    await expect(
      runSetup({
        homeDir: fakeHome,
        codexHomeDir: fakeCodexHome,
        packageRoot: pkgRoot,
        ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
        clients: ["claude-code"],
        yes: true,
      }),
    ).rejects.toThrow(CausorynCliError);
    rmSync(claudeConfigPath, { recursive: true, force: true });

    // 2) Symlinked config or backup (when OS allows creating file/dir symlinks) -> fail closed
    let symlinkCreated = false;
    const dotfileTarget = path.join(sandbox, "external-claude.json");
    writeFileSync(dotfileTarget, '{"mcpServers":{}}\n', "utf8");
    try {
      symlinkSync(dotfileTarget, claudeConfigPath);
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      await expect(
        runSetup({
          homeDir: fakeHome,
          codexHomeDir: fakeCodexHome,
          packageRoot: pkgRoot,
          ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
          clients: ["claude-code"],
          yes: true,
        }),
      ).rejects.toThrow(/sembolik bağlantı|CWE-59/);
      rmSync(claudeConfigPath, { force: true });
    }

    // 3) Restrictive 0o600 permissions preserved on POSIX for config & .causoryn.backup
    writeFileSync(claudeConfigPath, '{"mcpServers":{}}\n', { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(claudeConfigPath, 0o600);
    }
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: false,
      yes: true,
    });
    if (process.platform !== "win32") {
      expect(statSync(claudeConfigPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${claudeConfigPath}.causoryn.backup`).mode & 0o777).toBe(0o600);
    }
  });
});

describe(
  "release hardening: Node >= 24 guard, launcher --expected-version, Roslyn DLL + musl doctor, CLAUDE_CONFIG_DIR, prepack gate",
  { timeout: 20_000 },
  () => {
  it("node-version-guard accepts Node >= 24 and rejects Node < 24 with exit code 2 and pure LF scripts", async () => {
    const guardPath = path.join(CAUSORYN_PKG_DIR, "scripts", "lib", "node-version-guard.mjs");
    expect(existsSync(guardPath)).toBe(true);

    const guardMod = (await import(pathToFileURL(guardPath).href)) as {
      assertSupportedNodeVersion: (
        nodeVersion?: string,
        minMajor?: number,
      ) => { readonly ok: boolean; readonly major: number };
    };
    expect(guardMod.assertSupportedNodeVersion("24.0.0")).toEqual({ ok: true, major: 24 });
    expect(guardMod.assertSupportedNodeVersion("25.1.0")).toEqual({ ok: true, major: 25 });

    // Subprocess exit-2 check for Node 22
    const rejectRun = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { assertSupportedNodeVersion } from ${JSON.stringify(pathToFileURL(guardPath).href)}; assertSupportedNodeVersion("22.14.0", 24);`,
      ],
      { encoding: "utf8", shell: false },
    );
    expect(rejectRun.status).toBe(2);
    expect(rejectRun.stdout).toBe("");
    expect(rejectRun.stderr).toMatch(/Node\.js\s*>=\s*24|22\.14\.0/);

    // Pure LF (zero CR 0x0d) on all published CLI/launcher scripts
    for (const relScript of [
      path.join("scripts", "causoryn.mjs"),
      path.join("scripts", "plugin-mcp-launcher.mjs"),
      path.join("scripts", "lib", "node-version-guard.mjs"),
    ]) {
      const rawBytes = readFileSync(path.join(CAUSORYN_PKG_DIR, relScript));
      expect(rawBytes.includes(0x0d), `${relScript} contains CR (\\r) bytes`).toBe(false);
    }
  });

  it("plugin-mcp-launcher enforces --expected-version (passes & strips matching flag, exits 2 on mismatch or missing value)", () => {
    const sandbox = createTempDir("launcher-version");
    const fakePkg = path.join(sandbox, "pkg");
    mkdirSync(path.join(fakePkg, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(fakePkg, "dist"), { recursive: true });

    writeFileSync(
      path.join(fakePkg, "package.json"),
      JSON.stringify({ name: "causoryn", version: "0.2.0", type: "module" }, null, 2),
      "utf8",
    );
    copyFileSync(
      path.join(CAUSORYN_PKG_DIR, "scripts", "plugin-mcp-launcher.mjs"),
      path.join(fakePkg, "scripts", "plugin-mcp-launcher.mjs"),
    );
    copyFileSync(
      path.join(CAUSORYN_PKG_DIR, "scripts", "lib", "node-version-guard.mjs"),
      path.join(fakePkg, "scripts", "lib", "node-version-guard.mjs"),
    );
    // Stub MCP server prints forwarded argv to stdout
    writeFileSync(
      path.join(fakePkg, "dist", "mcp-server.mjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );

    const launcher = path.join(fakePkg, "scripts", "plugin-mcp-launcher.mjs");

    // 1) Matching --expected-version passes and is stripped before forwarding
    const okRun = spawnSync(
      process.execPath,
      [launcher, "--expected-version", "0.2.0", "--allow-cwd", "--auto-data-dir", "--client", "claude-code"],
      { encoding: "utf8", shell: false },
    );
    expect(okRun.status).toBe(0);
    expect(JSON.parse(okRun.stdout)).toEqual([
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "claude-code",
    ]);

    // 2) Matching --expected-version=0.2.0 inline syntax
    const okInline = spawnSync(
      process.execPath,
      [launcher, "--expected-version=0.2.0", "--allow-cwd"],
      { encoding: "utf8", shell: false },
    );
    expect(okInline.status).toBe(0);
    expect(JSON.parse(okInline.stdout)).toEqual(["mcp", "--allow-cwd"]);

    // 3) Mismatched --expected-version fails closed with exit 2
    const mismatchRun = spawnSync(
      process.execPath,
      [launcher, "--expected-version", "9.9.9", "--allow-cwd"],
      { encoding: "utf8", shell: false },
    );
    expect(mismatchRun.status).toBe(2);
    expect(mismatchRun.stdout).toBe("");
    expect(mismatchRun.stderr).toContain("9.9.9");
    expect(mismatchRun.stderr).toContain("0.2.0");

    // 4) Missing value for --expected-version fails closed with exit 2
    const missingValRun = spawnSync(
      process.execPath,
      [launcher, "--expected-version"],
      { encoding: "utf8", shell: false },
    );
    expect(missingValRun.status).toBe(2);
    expect(missingValRun.stdout).toBe("");
    expect(missingValRun.stderr).toContain("--expected-version");

    const flagAsValRun = spawnSync(
      process.execPath,
      [launcher, "--expected-version", "--allow-cwd"],
      { encoding: "utf8", shell: false },
    );
    expect(flagAsValRun.status).toBe(2);
    expect(flagAsValRun.stdout).toBe("");
    expect(flagAsValRun.stderr).toContain("--expected-version");
  });

  it("doctor flags missing compiled Causoryn.RoslynWorker.dll as unhealthy and checks linuxmusl prebuild via isLinuxMusl()", () => {
    // 1) isLinuxMusl() unit checks
    expect(isLinuxMusl("linux", () => ({ header: {} }))).toBe(true);
    expect(isLinuxMusl("linux", () => ({ header: { glibcVersionRuntime: "" } }))).toBe(true);
    expect(isLinuxMusl("linux", () => ({ header: { glibcVersionRuntime: "2.39" } }))).toBe(false);
    expect(isLinuxMusl("win32", () => ({ header: {} }))).toBe(false);
    expect(isLinuxMusl("darwin", () => ({ header: {} }))).toBe(false);

    // 2) Missing Roslyn DLL -> nativeWorkersPresent = false, healthy = false
    const sandbox = createTempDir("doctor-roslyn-musl");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    mkdirSync(fakeHome, { recursive: true });
    const noDllPkg = createFakePackageRoot(sandbox, "no-dll-pkg", {
      includeRoslynDll: false,
    });
    const noDllReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: noDllPkg,
      nodeVersion: "24.16.0",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(noDllReport.runtime.nativeWorkersPresent).toBe(false);
    expect(noDllReport.runtime.ok).toBe(false);
    expect(noDllReport.healthy).toBe(false);
    expect(
      noDllReport.runtime.missingPaths.some((p) => p.endsWith("Causoryn.RoslynWorker.dll")),
    ).toBe(true);

    // 3) Release DLL path accepted as valid compiled Roslyn worker
    const releaseDllPath = path.join(
      noDllPkg,
      "native",
      "roslyn-worker",
      "bin",
      "Release",
      "net10.0",
      "Causoryn.RoslynWorker.dll",
    );
    mkdirSync(path.dirname(releaseDllPath), { recursive: true });
    writeFileSync(releaseDllPath, "fake-release-dll", "utf8");
    const releaseDllReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: noDllPkg,
      nodeVersion: "24.16.0",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(releaseDllReport.runtime.nativeWorkersPresent).toBe(true);
    expect(releaseDllReport.runtime.ok).toBe(true);
    expect(releaseDllReport.overallStatus).toBe("NOT CONFIGURED");
    expect(releaseDllReport.healthy).toBe(false);

    // 4) Linux musl checks linuxmusl-x64.node instead of linux-x64.node
    const glibcOnlyPkg = createFakePackageRoot(sandbox, "glibc-only-pkg", {
      prebuildFilename: "linux-x64.node",
    });
    const muslMissingReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: glibcOnlyPkg,
      platform: "linux",
      arch: "x64",
      isMusl: true,
      nodeVersion: "24.16.0",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(muslMissingReport.runtime.sqlitePrebuildPresent).toBe(false);
    expect(muslMissingReport.overallStatus).toBe("UNHEALTHY");
    expect(muslMissingReport.healthy).toBe(false);
    expect(
      muslMissingReport.runtime.missingPaths.some((p) => p.endsWith("linuxmusl-x64.node")),
    ).toBe(true);

    const muslPkg = createFakePackageRoot(sandbox, "musl-pkg", {
      prebuildFilename: "linuxmusl-x64.node",
    });
    const muslOkReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: muslPkg,
      platform: "linux",
      arch: "x64",
      isMusl: true,
      nodeVersion: "24.16.0",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(muslOkReport.runtime.sqlitePrebuildPresent).toBe(true);
    expect(muslOkReport.runtime.ok).toBe(true);
    expect(muslOkReport.overallStatus).toBe("NOT CONFIGURED");
    expect(muslOkReport.healthy).toBe(false);
  });

  it("setup, doctor, and runtime-stage respect CLAUDE_CONFIG_DIR and preserve THIRD-PARTY-NOTICES.md + licenses/", async () => {
    const sandbox = createTempDir("claude-config-dir");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const customClaudeDir = path.join(sandbox, "custom-claude-cfg");
    mkdirSync(customClaudeDir, { recursive: true });

    const npxPkg = createFakePackageRoot(path.join(sandbox, "_npx", "ccdir"), "causoryn");
    writeFileSync(path.join(npxPkg, "THIRD-PARTY-NOTICES.md"), "# Third-Party Notices\n", "utf8");
    mkdirSync(path.join(npxPkg, "licenses"), { recursive: true });
    writeFileSync(path.join(npxPkg, "licenses", "Apache-2.0.txt"), "Apache License 2.0\n", "utf8");

    const envWithClaudeDir: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: customClaudeDir,
    };

    const setupResult = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: npxPkg,
      env: envWithClaudeDir,
      allDetected: true,
      yes: true,
    });
    expect(setupResult.applied).toBe(true);
    expect(setupResult.selectedClients).toEqual(["claude-code"]);

    // Configured under CLAUDE_CONFIG_DIR, NOT homeDir/.claude.json or homeDir/.claude/skills
    expect(existsSync(path.join(customClaudeDir, ".claude.json"))).toBe(true);
    expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(false);
    for (const skillName of CANONICAL_SKILL_NAMES) {
      expect(existsSync(path.join(customClaudeDir, "skills", skillName, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(fakeHome, ".claude", "skills", skillName, "SKILL.md"))).toBe(
        false,
      );
    }

    // Persistent runtime staging preserves THIRD-PARTY-NOTICES.md + licenses/
    const stagedRuntime = path.join(fakeHome, ".causoryn", "runtime");
    expect(existsSync(path.join(stagedRuntime, "THIRD-PARTY-NOTICES.md"))).toBe(true);
    expect(existsSync(path.join(stagedRuntime, "licenses", "Apache-2.0.txt"))).toBe(true);

    // Doctor reads CLAUDE_CONFIG_DIR and reports aligned
    const doctorReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: npxPkg,
      env: envWithClaudeDir,
      nodeVersion: "24.16.0",
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(doctorReport.healthy).toBe(true);
    expect(doctorReport.hosts["claude-code"].detected).toBe(true);
    expect(doctorReport.hosts["claude-code"].configPath).toBe(
      path.join(customClaudeDir, ".claude.json"),
    );
    expect(doctorReport.hosts["claude-code"].skillsDir).toBe(path.join(customClaudeDir, "skills"));
    expect(doctorReport.hosts["claude-code"].aligned).toBe(true);
    expect(doctorReport.hosts["claude-code"].status).toBe("ok");

    // Uninstall cleans up CLAUDE_CONFIG_DIR entry and staged runtime
    const uninstallResult = await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      packageRoot: npxPkg,
      env: envWithClaudeDir,
      clients: ["claude-code"],
      uninstall: true,
      yes: true,
    });
    expect(uninstallResult.runtimeCleanedUp).toBe(true);
    expect(existsSync(stagedRuntime)).toBe(false);
  });

  it("verify-package-ready.mjs passes on valid staged package and fails closed on missing licenses, SHA drift, resource DLLs, user paths, mcpName mismatch, or CRLF scripts", async () => {
    const verifyScriptPath = path.join(CAUSORYN_PKG_DIR, "scripts", "verify-package-ready.mjs");
    expect(existsSync(verifyScriptPath)).toBe(true);
    const verifyMod = (await import(pathToFileURL(verifyScriptPath).href)) as {
      verifyPackageReady: (pkgDir: string) => { readonly ok: boolean; readonly verifiedFiles: number };
    };

    const buildReadyPkg = (name: string): string => {
      const sandbox = createTempDir(`prepack-${name}`);
      const pkgDir = path.join(sandbox, "causoryn");
      mkdirSync(path.join(pkgDir, "dist", "node_modules", "better-sqlite3"), { recursive: true });
      mkdirSync(path.join(pkgDir, "dist", "typescript-lib"), { recursive: true });
      mkdirSync(path.join(pkgDir, "licenses"), { recursive: true });
      mkdirSync(path.join(pkgDir, "native", "roslyn-worker"), { recursive: true });
      mkdirSync(path.join(pkgDir, "scripts", "lib"), { recursive: true });

      const bundleContent = "// bundle\n";
      const sqliteLicContent = "MIT License\nCopyright (c) 2017 Joshua Wise\n";
      const shaOf = (s: string): string =>
        createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "causoryn",
            mcpName: "io.github.mrbekox/causoryn",
            version: "0.2.0",
            type: "module",
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(path.join(pkgDir, "dist", "mcp-server.mjs"), bundleContent, "utf8");
      writeFileSync(
        path.join(pkgDir, "dist", "node_modules", "better-sqlite3", "LICENSE"),
        sqliteLicContent,
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "dist", "bundle-manifest.json"),
        JSON.stringify(
          {
            files: {
              "mcp-server.mjs": shaOf(bundleContent),
              "node_modules/better-sqlite3/LICENSE": shaOf(sqliteLicContent),
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(path.join(pkgDir, "LICENSE"), "MIT License\n", "utf8");
      writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {};\n", "utf8");
      writeFileSync(
        path.join(pkgDir, "dist", "index-worker.mjs"),
        "export {};\n",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "dist", "mcp-server.mjs.LEGAL.txt"),
        "/*! legal notices */\n",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "dist", "typescript-lib", "lib.es2022.full.d.ts"),
        "interface Array<T> {}\n",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "THIRD-PARTY-NOTICES.md"),
        [
          "# Third-Party Notices",
          "Apache License",
          "Gary Court",
          "Anthropic, PBC",
          "Colin McDonnell",
          "Evgeny Poberezkin",
          "Joshua Wise",
          "Microsoft Corporation",
        ].join("\n") + "\n",
        "utf8",
      );
      writeFileSync(path.join(pkgDir, "licenses", "Apache-2.0.txt"), "Apache License\n", "utf8");
      writeFileSync(
        path.join(pkgDir, "licenses", "TypeScript-ThirdPartyNoticeText.txt"),
        "Third Party\n",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "licenses", "better-sqlite3-LICENSE.txt"),
        sqliteLicContent,
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
        "clean-deterministic-roslyn-binary",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "native", "roslyn-worker", "Causoryn.RoslynWorker.deps.json"),
        '{"runtimeTarget":{}}\n',
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "native", "roslyn-worker", "Causoryn.RoslynWorker.runtimeconfig.json"),
        '{"runtimeOptions":{}}\n',
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "native", "roslyn-worker", "Microsoft.CodeAnalysis.dll"),
        "roslyn-core-dll",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "native", "roslyn-worker", "Microsoft.CodeAnalysis.CSharp.dll"),
        "roslyn-csharp-dll",
        "utf8",
      );
      writeFileSync(path.join(pkgDir, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
      writeFileSync(
        path.join(pkgDir, "scripts", "plugin-mcp-launcher.mjs"),
        "#!/usr/bin/env node\n",
        "utf8",
      );
      writeFileSync(
        path.join(pkgDir, "scripts", "lib", "node-version-guard.mjs"),
        "export function assertSupportedNodeVersion() {}\n",
        "utf8",
      );
      return pkgDir;
    };

    // Positive
    const okDir = buildReadyPkg("ok");
    const res = verifyMod.verifyPackageReady(okDir);
    expect(res.ok).toBe(true);
    expect(res.verifiedFiles).toBe(2);

    // Negative 1: SHA-256 mismatch
    const badShaDir = buildReadyPkg("bad-sha");
    writeFileSync(path.join(badShaDir, "dist", "mcp-server.mjs"), "// tampered\n", "utf8");
    expect(() => verifyMod.verifyPackageReady(badShaDir)).toThrow(/SHA-256/i);

    // Negative 2: missing notice entry
    const badNoticeDir = buildReadyPkg("bad-notice");
    writeFileSync(path.join(badNoticeDir, "THIRD-PARTY-NOTICES.md"), "Apache License\n", "utf8");
    expect(() => verifyMod.verifyPackageReady(badNoticeDir)).toThrow(/Gary Court/i);

    // Negative 3: stray localized *.resources.dll
    const badResDllDir = buildReadyPkg("bad-res-dll");
    mkdirSync(path.join(badResDllDir, "native", "roslyn-worker", "tr"), { recursive: true });
    writeFileSync(
      path.join(badResDllDir, "native", "roslyn-worker", "tr", "Microsoft.CodeAnalysis.resources.dll"),
      "locale",
      "utf8",
    );
    expect(() => verifyMod.verifyPackageReady(badResDllDir)).toThrow(/resources\.dll/i);

    // Negative 4: embedded user path / .pdb in RoslynWorker.dll
    const badPdbDir = buildReadyPkg("bad-pdb");
    writeFileSync(
      path.join(badPdbDir, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
      "MZ...C:\\Users\\alice\\repo\\Causoryn.RoslynWorker.pdb",
      "utf8",
    );
    expect(() => verifyMod.verifyPackageReady(badPdbDir)).toThrow(/Users|pdb/i);

    // Negative 5: wrong mcpName
    const badMcpNameDir = buildReadyPkg("bad-mcpname");
    writeFileSync(
      path.join(badMcpNameDir, "package.json"),
      JSON.stringify({ name: "causoryn", mcpName: "io.github.other/wrong", version: "0.2.0" }),
      "utf8",
    );
    expect(() => verifyMod.verifyPackageReady(badMcpNameDir)).toThrow(/mcpName/i);

    // Negative 6: CRLF in scripts/causoryn.mjs
    const badCrlfDir = buildReadyPkg("bad-crlf");
    writeFileSync(
      path.join(badCrlfDir, "scripts", "causoryn.mjs"),
      "#!/usr/bin/env node\r\n",
      "utf8",
    );
    expect(() => verifyMod.verifyPackageReady(badCrlfDir)).toThrow(/CRLF|\\r|LF/i);

    // Negative 7: missing package root LICENSE, dist/index.js, mcp-server.mjs.LEGAL.txt, or Roslyn deps.json
    for (const relMissing of [
      "LICENSE",
      path.join("dist", "index.js"),
      path.join("dist", "mcp-server.mjs.LEGAL.txt"),
      path.join("native", "roslyn-worker", "Causoryn.RoslynWorker.deps.json"),
      path.join("native", "roslyn-worker", "Causoryn.RoslynWorker.runtimeconfig.json"),
      path.join("native", "roslyn-worker", "Microsoft.CodeAnalysis.dll"),
    ]) {
      const badMissingDir = buildReadyPkg(`missing-${relMissing.replace(/[^a-z0-9]/gi, "-")}`);
      rmSync(path.join(badMissingDir, relMissing));
      expect(() => verifyMod.verifyPackageReady(badMissingDir), `missing ${relMissing} must fail`).toThrow(
        /missing/i,
      );
    }
  });

  it("güvenlik (#25): kaynak SKILL.md eksik veya dizin olduğunda fd tabanlı okuma aynı cli/io-error hatasını fırlatır", async () => {
    const base = createTempDir("skill-fd-check");
    const fakeHome = path.join(base, "home");
    mkdirSync(fakeHome, { recursive: true });

    // 1) Eksik SKILL.md -> CausorynCliError("cli/io-error", "Kaynak skill dosyası bulunamadı: ...")
    const missingPkg = createFakePackageRoot(base, "pkg-missing-skill");
    const missingSkillFile = path.join(missingPkg, "skills", CANONICAL_SKILL_NAMES[0], "SKILL.md");
    rmSync(missingSkillFile);

    let missingErr: unknown;
    try {
      await runSetup({
        clients: ["claude-code"],
        homeDir: fakeHome,
        packageRoot: missingPkg,
        dryRun: true,
      });
    } catch (err) {
      missingErr = err;
    }
    expect(missingErr).toBeInstanceOf(CausorynCliError);
    expect((missingErr as CausorynCliError).code).toBe("cli/io-error");
    expect((missingErr as CausorynCliError).message).toContain(
      `Kaynak skill dosyası bulunamadı: ${missingSkillFile}`,
    );

    // 2) Dizin olan SKILL.md -> aynı CausorynCliError
    const dirPkg = createFakePackageRoot(base, "pkg-dir-skill");
    const dirSkillFile = path.join(dirPkg, "skills", CANONICAL_SKILL_NAMES[0], "SKILL.md");
    rmSync(dirSkillFile);
    mkdirSync(dirSkillFile, { recursive: true });

    let dirErr: unknown;
    try {
      await runSetup({
        clients: ["claude-code"],
        homeDir: fakeHome,
        packageRoot: dirPkg,
        dryRun: true,
      });
    } catch (err) {
      dirErr = err;
    }
    expect(dirErr).toBeInstanceOf(CausorynCliError);
    expect((dirErr as CausorynCliError).code).toBe("cli/io-error");
    expect((dirErr as CausorynCliError).message).toContain(
      `Kaynak skill dosyası bulunamadı: ${dirSkillFile}`,
    );

    // 3) Symlink'li kaynak SKILL.md (OS izin veriyorsa) O_NOFOLLOW olmadan başarıyla okunur
    const symlinkPkg = createFakePackageRoot(base, "pkg-symlink-skill");
    const symlinkSkillFile = path.join(symlinkPkg, "skills", CANONICAL_SKILL_NAMES[0], "SKILL.md");
    const realSkillTarget = path.join(base, "shared-skill.md");
    writeFileSync(realSkillTarget, "---\nname: causoryn\n---\nSymlinked skill content.\n", "utf8");
    rmSync(symlinkSkillFile);
    let symlinkCreated = false;
    try {
      symlinkSync(realSkillTarget, symlinkSkillFile, "file");
      symlinkCreated = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "EPERM") {
        throw err;
      }
    }
    if (symlinkCreated) {
      const setupRes = await runSetup({
        clients: ["claude-code"],
        homeDir: fakeHome,
        packageRoot: symlinkPkg,
        dryRun: true,
      });
      expect(setupRes.actions.some((a) => a.kind === "skill")).toBe(true);
    }
  });

  it("CLI emits clear English help, setup status text, confirmation prompt, and argument error messages", async () => {
    const sandbox = createTempDir("cli-english");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodexHome = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePackageRoot(sandbox, "pkg");
    mkdirSync(fakeHome, { recursive: true });

    const runCaptured = async (
      argv: readonly string[],
      extraIo?: { readonly isInteractive?: boolean; readonly confirm?: (prompt: string) => Promise<boolean> },
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
      const out: string[] = [];
      const err: string[] = [];
      const exitCode = await runCli(argv, {
        homeDir: fakeHome,
        codexHomeDir: fakeCodexHome,
        packageRoot: pkgRoot,
        ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
        io: {
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
          ...extraIo,
        },
      });
      return { exitCode, stdout: out.join(""), stderr: err.join("") };
    };

    const helpRes = await runCaptured(["--help"]);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("--tool-profile");

    const dryRunRes = await runCaptured(["setup", "--client", "claude-code", "--dry-run"]);
    expect(dryRunRes.exitCode).toBe(0);
    expect(dryRunRes.stdout).toContain("DRY-RUN PREVIEW");
    expect(dryRunRes.stdout).toContain("Planned / Applied Actions:");
    expect(dryRunRes.stdout).not.toMatch(/ÖNİZLEME|İşlemler|hiçbir değişiklik/);

    const prompts: string[] = [];
    const interactiveRes = await runCaptured(["setup", "--client", "claude-code"], {
      isInteractive: true,
      confirm: async (promptText) => {
        prompts.push(promptText);
        return true;
      },
    });
    expect(interactiveRes.exitCode).toBe(0);
    expect(interactiveRes.stderr).toContain("The following changes will be applied:");
    expect(prompts[0]).toBe("Continue? [y/N] ");
    expect(interactiveRes.stdout).toContain("APPLIED");
    expect(interactiveRes.stdout).not.toMatch(/UYGULANDI|Devam edilsin/);

    const noopRes = await runCaptured(["setup", "--client", "claude-code", "--yes"]);
    expect(noopRes.exitCode).toBe(0);
    expect(noopRes.stdout).toContain("NO CHANGES");
    expect(noopRes.stdout).not.toContain("DEĞİŞİKLİK YOK");

    const uninstallRes = await runCaptured([
      "setup",
      "--client",
      "claude-code",
      "--uninstall",
      "--yes",
    ]);
    expect(uninstallRes.exitCode).toBe(0);
    expect(uninstallRes.stdout).toContain("UNINSTALLED");
    expect(uninstallRes.stdout).not.toContain("KALDIRILDI");

    const badSubcmd = await runCaptured(["bogus"]);
    expect(badSubcmd.exitCode).toBe(2);
    expect(badSubcmd.stderr).toContain("[causoryn] error:");
    expect(badSubcmd.stderr).toContain('Unknown subcommand: "bogus"');
    expect(badSubcmd.stderr).not.toMatch(/Bilinmeyen|hata:/);

    const badClient = await runCaptured(["setup", "--client", "invalid-host"]);
    expect(badClient.exitCode).toBe(2);
    expect(badClient.stderr).toContain('Invalid --client value "invalid-host"');

    const badSetupArg = await runCaptured(["setup", "--unknown-flag"]);
    expect(badSetupArg.exitCode).toBe(2);
    expect(badSetupArg.stderr).toContain("Unknown setup argument: --unknown-flag");

    const badDoctorArg = await runCaptured(["doctor", "--unknown-flag"]);
    expect(badDoctorArg.exitCode).toBe(2);
    expect(badDoctorArg.stderr).toContain("Unknown doctor argument: --unknown-flag");
  });
});
