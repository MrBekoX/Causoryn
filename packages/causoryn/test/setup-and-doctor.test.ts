import {
  chmodSync,
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
  },
): string {
  const pkgRoot = path.join(baseDir, folderName);
  const includePrebuild = options?.includePrebuild ?? true;
  const includeTsLib = options?.includeTsLib ?? true;
  const includeNative = options?.includeNative ?? true;

  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });

  writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({ name: "causoryn", version: "0.1.0", type: "module" }, null, 2),
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
      path.join(prebuildsDir, `${process.platform}-${process.arch}.node`),
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
    expect(CAUSORYN_PACKAGE_VERSION).toBe("0.1.0");
    expect(HOST_CLIENT_IDS).toEqual(["antigravity", "claude-code", "codex", "zcode"]);
    expect(CANONICAL_SKILL_NAMES).toEqual([
      "causoryn",
      "map-system",
      "preflight-change",
      "verify-change",
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
    expect(liveRerun.applied).toBe(true);
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
        command: "node",
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
      command: "node",
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
      command: "node",
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
    expect(outChunks.join("").trim()).toBe("0.1.0");

    outChunks.length = 0;
    const setupExit = await runCli(
      ["setup", "--client", "claude-code", "--no-skill", "--yes", "--json"],
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
    const doctorJson = JSON.parse(outChunks.join("")) as { healthy: boolean };
    expect(doctorJson.healthy).toBe(true);
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
