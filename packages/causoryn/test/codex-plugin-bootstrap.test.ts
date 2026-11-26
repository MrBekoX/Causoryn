import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Codex plugin bootstrap (`.codex-plugin/mcp.json`).
 *
 * Codex expands no variables in a plugin MCP config and starts the server in
 * the session directory when `cwd` is omitted (codex-rs rmcp-client
 * stdio_server_launcher.rs, core session/mcp.rs). The manifest therefore runs
 * `node --input-type=module --eval <bootstrap> -- <launcher args>` in the
 * project. The bootstrap uses only `node:` builtins and reaches the launcher by
 * an absolute path derived from trusted inputs: CODEX_HOME (forwarded through
 * `env_vars`) or `<home>/.codex`, then Codex's fixed install layout
 * `plugins/cache/<marketplace>/<plugin>/<version>` (core-plugins store.rs,
 * core-plugin-common installed.rs). It refuses a missing or invalid version, a
 * relative CODEX_HOME, a link below the cache, and an install inside the
 * workspace; the server then stays in the project, so `--allow-cwd` binds it
 * after its usual safety check.
 */

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = path.join(PKG_DIR, ".codex-plugin", "mcp.json");

interface CodexEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: unknown;
  readonly env_vars?: unknown;
}

function codexEntry(): CodexEntry {
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    mcpServers: Record<string, CodexEntry>;
  };
  const entry = parsed.mcpServers["causoryn"];
  if (entry === undefined) throw new Error("no causoryn server in the Codex manifest");
  return entry;
}

/** The launcher arguments after `--`, exactly as the manifest passes them. */
function launcherArgs(entry: CodexEntry): string[] {
  return entry.args.slice(entry.args.indexOf("--") + 1);
}

function manifestVersion(entry: CodexEntry): string {
  const args = launcherArgs(entry);
  return args[args.indexOf("--expected-version") + 1] ?? "";
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-codex-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A Codex plugin install with the real launcher and a stub server that reports argv and cwd. */
function stageInstall(codexHome: string, version: string, packageVersion = version): string {
  const root = path.join(codexHome, "plugins", "cache", "causoryn", "causoryn", version);
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "causoryn", version: packageVersion, type: "module" }),
  );
  copyFileSync(
    path.join(PKG_DIR, "scripts", "plugin-mcp-launcher.mjs"),
    path.join(root, "scripts", "plugin-mcp-launcher.mjs"),
  );
  for (const lib of ["node-version-guard.mjs", "asset-root.mjs"]) {
    copyFileSync(path.join(PKG_DIR, "scripts", "lib", lib), path.join(root, "scripts", "lib", lib));
  }
  writeFileSync(
    path.join(root, "dist", "mcp-server.mjs"),
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
  );
  return root;
}

/**
 * An analyzed repository that tries every way the old forms let it pick the
 * code: a relative launcher, a committed node_modules/causoryn, .npmrc,
 * node.config.json, .env and package.json imports. Each writes a marker.
 */
function plantProject(dir: string, version: string): string {
  const marker = path.join(dir, "PLANTED-CODE-RAN");
  const payload = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`;
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", "causoryn", "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(dir, "evil.cjs"), payload);
  writeFileSync(
    path.join(dir, "scripts", "plugin-mcp-launcher.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");\n`,
  );
  writeFileSync(
    path.join(dir, "node_modules", "causoryn", "package.json"),
    JSON.stringify({ name: "causoryn", version, bin: { causoryn: "scripts/causoryn.mjs" } }),
  );
  writeFileSync(path.join(dir, "node_modules", "causoryn", "scripts", "causoryn.mjs"), payload);
  writeFileSync(path.join(dir, ".npmrc"), "node-options=--require ./evil.cjs\nscript-shell=./evil.cjs\n");
  writeFileSync(path.join(dir, "node.config.json"), JSON.stringify({ nodeOptions: { require: "./evil.cjs" } }));
  writeFileSync(path.join(dir, ".env"), "NODE_OPTIONS=--require ./evil.cjs\n");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "victim", type: "commonjs", imports: { "#launcher": "./evil.cjs" } }),
  );
  return marker;
}

/** Codex forwards only its default variables plus the manifest's env_vars (rmcp-client utils.rs). */
function codexLikeEnv(overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // process.env lookups are case-insensitive on Windows, so one spelling each.
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runBootstrap(
  entry: CodexEntry,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = entry.args,
): { status: number | null; stub: { argv: string[]; cwd: string } | undefined; stderr: string } {
  const result = spawnSync(process.execPath, [...args], { cwd, env, encoding: "utf8", shell: false });
  const out = result.stdout.trim();
  return {
    status: result.status,
    stub: out.length > 0 ? (JSON.parse(out) as { argv: string[]; cwd: string }) : undefined,
    stderr: result.stderr,
  };
}

describe("Codex plugin manifest bootstrap", () => {
  it("runs node with an inline bootstrap in the session directory and forwards CODEX_HOME", () => {
    const entry = codexEntry();
    expect(entry.command).toBe("node");
    expect(entry.cwd).toBeUndefined();
    expect(entry.env_vars).toEqual(["CODEX_HOME"]);
    expect(entry.args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
    expect(entry.args[3]).toBe("--");
    expect(launcherArgs(entry)).toEqual([
      "--expected-version",
      "0.3.2",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "codex",
    ]);
  });

  it("imports only node: builtins and no relative or bare module specifier", () => {
    const bootstrap = codexEntry().args[2] ?? "";
    const specifiers = [...bootstrap.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
    expect(bootstrap).not.toMatch(/\brequire\s*\(/);
    expect(bootstrap).not.toMatch(/import\s*\(\s*["'`]/);
  });

  it("starts the installed launcher from CODEX_HOME and leaves the server in the project", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const codexHome = tempDir("home");
    stageInstall(codexHome, version);
    const project = tempDir("project");
    const marker = plantProject(project, version);

    const run = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: codexHome }));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stub?.argv).toEqual(["mcp", "--allow-cwd", "--auto-data-dir", "--client", "codex"]);
    expect(realpathSync(run.stub?.cwd ?? "")).toBe(realpathSync(project));
    expect(existsSync(marker), "project-planted code ran").toBe(false);
  });

  it("falls back to <home>/.codex when CODEX_HOME is unset", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const home = tempDir("userhome");
    stageInstall(path.join(home, ".codex"), version);
    const project = tempDir("project");
    const marker = plantProject(project, version);

    const run = runBootstrap(entry, project, codexLikeEnv({ HOME: home, USERPROFILE: home, CODEX_HOME: undefined }));
    expect(run.status, run.stderr).toBe(0);
    expect(realpathSync(run.stub?.cwd ?? "")).toBe(realpathSync(project));
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed when the install is missing, CODEX_HOME is relative, or the version is invalid", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const project = tempDir("project");
    const marker = plantProject(project, version);
    const emptyHome = tempDir("empty");

    const missing = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: emptyHome }));
    expect(missing.status).toBe(2);
    expect(missing.stub).toBeUndefined();
    expect(missing.stderr).toContain("[causoryn-codex]");

    const relative = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: ".codex" }));
    expect(relative.status).toBe(2);
    expect(relative.stderr).toContain("CODEX_HOME");

    const badArgs = entry.args.map((arg, i) => (entry.args[i - 1] === "--expected-version" ? "../x" : arg));
    const badVersion = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: emptyHome }), badArgs);
    expect(badVersion.status).toBe(2);
    expect(badVersion.stderr).toContain("--expected-version");

    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an install inside the analyzed workspace", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const project = tempDir("project");
    const marker = plantProject(project, version);
    // The repository ships its own ".codex" install and CODEX_HOME points at it.
    stageInstall(path.join(project, ".codex"), version);

    const run = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: path.join(project, ".codex") }));
    expect(run.status).toBe(2);
    expect(run.stub).toBeUndefined();
    expect(run.stderr).toContain("inside the workspace");
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "refuses an install inside the workspace even when cwd and CODEX_HOME are spelled differently (8.3 short names)",
    () => {
      const entry = codexEntry();
      const version = manifestVersion(entry);
      const project = tempDir("project");
      const marker = plantProject(project, version);
      stageInstall(path.join(project, ".codex"), version);
      const comspec = path.join(process.env["SYSTEMROOT"] ?? "C:\\Windows", "System32", "cmd.exe");
      const short = (
        spawnSync(comspec, ["/d", "/s", "/c", `"for %I in ("${project}") do @echo %~sI"`], {
          encoding: "utf8",
          shell: false,
          windowsVerbatimArguments: true,
        }).stdout ?? ""
      ).trim();
      if (short.length === 0 || short.toLowerCase() === project.toLowerCase()) {
        return; // the volume has no 8.3 names; nothing to compare
      }
      const run = runBootstrap(entry, short, codexLikeEnv({ CODEX_HOME: path.join(project, ".codex") }));
      expect(run.status, run.stderr).toBe(2);
      expect(run.stub).toBeUndefined();
      expect(run.stderr).toContain("inside the workspace");
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("refuses a link below the plugin cache", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const elsewhere = tempDir("elsewhere");
    const realInstall = stageInstall(elsewhere, version);
    const codexHome = tempDir("home");
    const linkedParent = path.join(codexHome, "plugins", "cache", "causoryn", "causoryn");
    mkdirSync(linkedParent, { recursive: true });
    symlinkSync(realInstall, path.join(linkedParent, version), "junction");
    const project = tempDir("project");

    const run = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: codexHome }));
    expect(run.status).toBe(2);
    expect(run.stub).toBeUndefined();
    expect(run.stderr).toContain("link");
  });

  it("lets the launcher reject an install whose package version differs", () => {
    const entry = codexEntry();
    const version = manifestVersion(entry);
    const codexHome = tempDir("home");
    stageInstall(codexHome, version, "9.9.9");
    const project = tempDir("project");

    const run = runBootstrap(entry, project, codexLikeEnv({ CODEX_HOME: codexHome }));
    expect(run.status).toBe(2);
    expect(run.stub).toBeUndefined();
    expect(run.stderr).toContain("version mismatch");
  });
});
