import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CausorynConfigError } from "../packages/mcp-server/src/config.js";
import {
  buildWorkspaceAutoConfig,
  resolveBaseDataDir,
} from "../packages/mcp-server/src/runtime-cli.js";

/**
 * One index per workspace across hosts: the ZCode plugin (which runs with
 * `ZCODE_PLUGIN_DATA` set) must resolve the same `~/.causoryn` base as Claude
 * Code, Codex and Antigravity, so all hosts share
 * `~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite`. `ZCODE_PLUGIN_DATA`
 * is only a fallback for when `~/.causoryn` cannot be used, and `--data-dir`
 * remains the explicit opt-in for a different location.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "mcp-server", "src", "cli-stdio.ts");
const LOADER_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "test",
  "loader",
  "register-strip.mjs",
);
const READY_MARKER = "causoryn mcp server ready";

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly zcodeData: string;
}

const sandboxes: string[] = [];

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-zcode-shared-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "orders-api");
  const zcodeData = path.join(root, "zcode-plugin-data");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(
    path.join(project, "src", "orders.ts"),
    "export function createOrder(id: string): string {\n  return id;\n}\n",
    "utf8",
  );
  return { root, home, project, zcodeData };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    try {
      chmodSync(path.join(dir, "home", ".causoryn"), 0o700);
    } catch {
      // Not every test restricts permissions.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function sharedDbPathUnder(base: string, dbPath: string | undefined): boolean {
  return dbPath !== undefined && dbPath.startsWith(path.join(base, "workspaces") + path.sep);
}

describe("ZCode shares the per-workspace index with the other hosts", () => {
  it("resolves ~/.causoryn as the base data directory even when ZCODE_PLUGIN_DATA is set", () => {
    const sandbox = makeSandbox();
    expect(
      resolveBaseDataDir({ homeDir: sandbox.home, env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData } }),
    ).toBe(path.join(sandbox.home, ".causoryn"));
    // --data-dir is still the explicit, highest-precedence choice.
    const explicit = path.join(sandbox.root, "explicit-data");
    expect(
      resolveBaseDataDir({
        dataDir: explicit,
        homeDir: sandbox.home,
        env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
      }),
    ).toBe(explicit);
  });

  it("gives ZCode (ZCODE_PLUGIN_DATA set) and Claude Code / Codex the same graph.sqlite", () => {
    const sandbox = makeSandbox();
    const zcode = buildWorkspaceAutoConfig({
      roots: [sandbox.project],
      autoDataDir: true,
      client: "zcode",
      homeDir: sandbox.home,
      env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
      logger: () => {},
    });
    const claude = buildWorkspaceAutoConfig({
      roots: [sandbox.project],
      autoDataDir: true,
      client: "claude-code",
      homeDir: sandbox.home,
      env: {},
      logger: () => {},
    });
    const codex = buildWorkspaceAutoConfig({
      roots: [sandbox.project],
      autoDataDir: true,
      client: "codex",
      homeDir: sandbox.home,
      env: {},
      logger: () => {},
    });

    expect(zcode.storage.dataDbPath).toBe(claude.storage.dataDbPath);
    expect(zcode.storage.dataDbPath).toBe(codex.storage.dataDbPath);
    expect(zcode.wiki.dataDbPath).toBe(claude.wiki.dataDbPath);
    expect(path.basename(zcode.storage.dataDbPath ?? "")).toBe("graph.sqlite");
    expect(sharedDbPathUnder(path.join(sandbox.home, ".causoryn"), zcode.storage.dataDbPath)).toBe(
      true,
    );
    expect(zcode.output.allowedOutputDirs).toEqual(claude.output.allowedOutputDirs);
    // Nothing is created under the plugin data directory.
    expect(existsSync(sandbox.zcodeData)).toBe(false);
  });

  it("falls back to ZCODE_PLUGIN_DATA only when ~/.causoryn cannot be used, and says so on stderr", () => {
    const sandbox = makeSandbox();
    // ~/.causoryn exists as a regular file: it cannot hold the data directory.
    writeFileSync(path.join(sandbox.home, ".causoryn"), "not a directory\n", "utf8");
    const messages: string[] = [];
    const config = buildWorkspaceAutoConfig({
      roots: [sandbox.project],
      autoDataDir: true,
      client: "zcode",
      homeDir: sandbox.home,
      env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
      logger: (message) => messages.push(message),
    });
    expect(sharedDbPathUnder(sandbox.zcodeData, config.storage.dataDbPath)).toBe(true);
    const notice = messages.join("\n");
    expect(notice).toContain(path.join(sandbox.home, ".causoryn"));
    expect(notice).toContain("ZCODE_PLUGIN_DATA");
    expect(notice).toContain("not shared");

    // Without a fallback the unusable base stays a hard configuration error.
    expect(() =>
      buildWorkspaceAutoConfig({
        roots: [sandbox.project],
        autoDataDir: true,
        homeDir: sandbox.home,
        env: {},
        logger: () => {},
      }),
    ).toThrow(CausorynConfigError);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "falls back to ZCODE_PLUGIN_DATA when ~/.causoryn is read-only (POSIX permissions)",
    () => {
      const sandbox = makeSandbox();
      const causorynHome = path.join(sandbox.home, ".causoryn");
      mkdirSync(causorynHome, { recursive: true });
      chmodSync(causorynHome, 0o500);
      const messages: string[] = [];
      const config = buildWorkspaceAutoConfig({
        roots: [sandbox.project],
        autoDataDir: true,
        client: "zcode",
        homeDir: sandbox.home,
        env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
        logger: (message) => messages.push(message),
      });
      expect(sharedDbPathUnder(sandbox.zcodeData, config.storage.dataDbPath)).toBe(true);
      expect(messages.join("\n")).toContain("not shared");
      expect(readdirSync(causorynHome)).toEqual([]);
    },
  );

  it("never falls back when --data-dir was given explicitly", () => {
    const sandbox = makeSandbox();
    const explicitFile = path.join(sandbox.root, "explicit-data");
    writeFileSync(explicitFile, "not a directory\n", "utf8");
    expect(() =>
      buildWorkspaceAutoConfig({
        roots: [sandbox.project],
        autoDataDir: true,
        dataDir: explicitFile,
        homeDir: sandbox.home,
        env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
        logger: () => {},
      }),
    ).toThrow(CausorynConfigError);
    expect(existsSync(sandbox.zcodeData)).toBe(false);
  });

  it("does not use the fallback to bypass the symlink guard on ~/.causoryn", () => {
    const sandbox = makeSandbox();
    const elsewhere = path.join(sandbox.root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    try {
      symlinkSync(
        elsewhere,
        path.join(sandbox.home, ".causoryn"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() =>
      buildWorkspaceAutoConfig({
        roots: [sandbox.project],
        autoDataDir: true,
        homeDir: sandbox.home,
        env: { ZCODE_PLUGIN_DATA: sandbox.zcodeData },
        logger: () => {},
      }),
    ).toThrow(/symbolic link/);
    expect(existsSync(sandbox.zcodeData)).toBe(false);
  });

  it(
    "the packaged ZCode invocation (--allow-cwd --auto-data-dir --client zcode) opens ~/.causoryn/.../graph.sqlite",
    { timeout: 180_000 },
    async () => {
      const sandbox = makeSandbox();
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of [
        "CAUSORYN_CONFIG",
        "CAUSORYN_TOOL_PROFILE",
        "CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE",
      ]) {
        delete env[key];
      }
      env["HOME"] = sandbox.home;
      env["USERPROFILE"] = sandbox.home;
      env["ZCODE_PLUGIN_DATA"] = sandbox.zcodeData;

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--experimental-transform-types",
            "--import",
            pathToFileURL(LOADER_ENTRY).href,
            CLI_ENTRY,
            "mcp",
            "--allow-cwd",
            "--auto-data-dir",
            "--client",
            "zcode",
          ],
          { cwd: sandbox.project, env, stdio: ["pipe", "pipe", "pipe"], shell: false },
        );
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 150_000);
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes(READY_MARKER)) {
            child.stdin.end();
          }
        });
        child.stdout.resume();
        child.on("error", (error) => {
          clearTimeout(killTimer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(killTimer);
          if (code !== 0) {
            reject(new Error(`cli-stdio exited with ${String(code)}: ${stderr}`));
            return;
          }
          resolve(code);
        });
      });
      expect(exitCode).toBe(0);

      const workspaces = path.join(sandbox.home, ".causoryn", "workspaces");
      const entries = readdirSync(workspaces);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.startsWith("orders-api-")).toBe(true);
      expect(existsSync(path.join(workspaces, entries[0] as string, "graph.sqlite"))).toBe(true);
      expect(existsSync(sandbox.zcodeData)).toBe(false);
      // The analyzed project is never written.
      expect(readdirSync(sandbox.project).sort()).toEqual(["src"]);
    },
  );
});
