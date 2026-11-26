import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression guard for the host launch manifests (security scan F1, F2, F3,
 * F19, F20): a shipped manifest must never let the analyzed project decide
 * what code starts the Causoryn server.
 *
 * Two mechanisms did that:
 * - a bare `node`/`npx` started with the analyzed project as its working
 *   directory: on Windows the cwd is searched for `node.exe`/`npx.cmd` before
 *   PATH, and a relative entry script resolves against it;
 * - `npx` resolving the server through the project's npm context: the
 *   project's `.npmrc` (registry, script-shell, node-options), a committed
 *   `node_modules/causoryn` and `<project>/node_modules/.bin` on PATH.
 *
 * Every JSON manifest in the repository that declares MCP servers is scanned
 * (not a fixed list), so a new manifest is held to the same rules. The rules:
 * - the spawn `cwd` is pinned to the plugin root (a plugin-root variable, or a
 *   relative cwd in a Codex native plugin, which Codex joins onto the plugin
 *   root); it never names the project directory;
 * - the command is `node` with an entry script anchored at the plugin root,
 *   or `npx` with `--ignore-scripts` and `--prefix` pinned to a plugin-owned
 *   directory, so npm's project config and local tree are not the project's;
 * - a project-directory variable appears only as the value of the launcher's
 *   `--project-dir` flag (the launcher applies the `--allow-cwd` safety check
 *   to it after the host has started `node` in the plugin root).
 *
 * The exceptions below are host limitations, not safe forms. Each is pinned to
 * its exact shape, so neither can widen silently.
 */

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DOLLAR_BRACE = "$" + "{";
const token = (name: string): string => `${DOLLAR_BRACE}${name}}`;

/** Variables hosts expand to the installed plugin directory. */
const PLUGIN_ROOT_TOKENS: ReadonlySet<string> = new Set([
  token("PLUGIN_ROOT"),
  token("ZCODE_PLUGIN_ROOT"),
  token("CLAUDE_PLUGIN_ROOT"),
]);

/** Variables hosts expand to a plugin-owned directory outside any workspace. */
const PLUGIN_OWNED_TOKENS: ReadonlySet<string> = new Set([
  ...PLUGIN_ROOT_TOKENS,
  token("PLUGIN_DATA"),
  token("ZCODE_PLUGIN_DATA"),
  token("CLAUDE_PLUGIN_DATA"),
]);

/** Variables that name the project or workspace a host has open. */
const PROJECT_DIR_TOKEN = /\$\{[A-Za-z_]*(?:PROJECT|WORKSPACE|workspace|PWD|CWD|cwd)[A-Za-z_:-]*\}/;

const PACKAGE_RUNNERS: ReadonlySet<string> = new Set([
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
]);

/** Directories that hold no shipped manifest (build output, tests, local state). */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".claude",
  "node_modules",
  "dist",
  "coverage",
  "docs",
  "tests",
  "test",
  "raw",
  "wiki",
  "target",
  "bin",
  "obj",
]);

/** Manifests the scan must find; guards against a walk that silently finds nothing. */
const KNOWN_MANIFESTS: readonly string[] = [
  "mcp.json",
  "mcp_config.json",
  "server.json",
  "integrations/antigravity/causoryn/mcp.json",
  "integrations/antigravity/causoryn/mcp_config.json",
  "integrations/zcode/causoryn/.zcode-plugin/plugin.json",
  "packages/causoryn/.claude-plugin/plugin.json",
  "packages/causoryn/.codex-plugin/mcp.json",
  "packages/causoryn/.zcode-plugin/plugin.json",
  "packages/causoryn/mcp_config.json",
];

/**
 * Claude Code's MCP server config has no `cwd` field (only `command`, `args`,
 * `env` are documented and substituted: code.claude.com/docs/en/plugins-reference,
 * "Where each variable resolves"), so the host picks the spawn directory. The
 * entry script is anchored at the plugin root; how the host resolves the bare
 * `node` is host-dependent and is reported as a residual.
 */
const HOST_WITHOUT_CWD_FIELD: Readonly<Record<string, string>> = {
  "packages/causoryn/.claude-plugin/plugin.json": token("CLAUDE_PLUGIN_ROOT"),
};

/**
 * The MCP Registry `server.json` has no working-directory or plugin-root field
 * and must use `npx` for an npm package, and the server binds MCP roots only
 * when `--allow-cwd` is set. This exact argument list is a documented residual.
 */
const REGISTRY_RESIDUAL = {
  file: "server.json",
  runtimeArguments: [{ type: "positional", value: "--ignore-scripts" }],
  packageArguments: [
    { type: "positional", value: "mcp" },
    { type: "positional", value: "--allow-cwd" },
    { type: "positional", value: "--auto-data-dir" },
  ],
} as const;

interface ServerEntry {
  readonly file: string;
  readonly name: string;
  readonly entry: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function listJsonFiles(dir: string, out: string[]): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIPPED_DIRS.has(dirent.name)) continue;
      // Build-staged copies of the bundle (gitignored) are not manifests.
      if (toPosix(path.relative(REPO_ROOT, full)) === "integrations/antigravity/causoryn/scripts") {
        continue;
      }
      listJsonFiles(full, out);
    } else if (dirent.isFile() && dirent.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;
}

/** Repo-relative path of every JSON file that declares MCP servers or registry packages. */
function discoverManifests(): string[] {
  const files: string[] = [];
  listJsonFiles(REPO_ROOT, files);
  const manifests: string[] = [];
  for (const full of files) {
    const rel = toPosix(path.relative(REPO_ROOT, full));
    let parsed: unknown;
    try {
      parsed = readJson(rel);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (isRecord(parsed["mcpServers"]) || Array.isArray(parsed["packages"])) {
      manifests.push(rel);
    }
  }
  return manifests.sort();
}

function serverEntriesOf(file: string): ServerEntry[] {
  const parsed = readJson(file);
  if (!isRecord(parsed) || !isRecord(parsed["mcpServers"])) return [];
  const entries: ServerEntry[] = [];
  for (const [name, entry] of Object.entries(parsed["mcpServers"])) {
    if (isRecord(entry)) entries.push({ file, name, entry });
  }
  return entries;
}

function stringArgs(entry: Record<string, unknown>): string[] {
  const args = entry["args"];
  return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
}

/** Codex joins a relative plugin MCP `cwd` onto the plugin root (codex-rs/codex-mcp/src/plugin_config.rs). */
function isCodexNativePluginManifest(file: string): boolean {
  return file.split("/").includes(".codex-plugin");
}

function isPluginRootCwd(file: string, cwd: unknown): boolean {
  if (typeof cwd !== "string") return false;
  if (PLUGIN_ROOT_TOKENS.has(cwd)) return true;
  return isCodexNativePluginManifest(file) && (cwd === "." || cwd === "./");
}

function anchoredEntryScript(file: string, cwd: unknown, script: string | undefined): boolean {
  if (script === undefined) return false;
  for (const rootToken of PLUGIN_ROOT_TOKENS) {
    if (script.startsWith(`${rootToken}/`)) return true;
  }
  // A relative entry script resolves against the spawn cwd. Only a Codex
  // native plugin, whose relative cwd Codex joins onto the plugin root and
  // which has no plugin-root variable, may use one.
  return (
    script.startsWith("./") &&
    isCodexNativePluginManifest(file) &&
    (cwd === "." || cwd === "./")
  );
}

/** npm options given to npx before the package spec. */
function npxOptions(args: readonly string[]): string[] {
  const options: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) break;
    options.push(arg);
    if (arg === "--prefix" || arg === "--package") {
      const value = args[i + 1];
      if (value !== undefined) options.push(value);
      i += 1;
    }
  }
  return options;
}

/** Every rule violation of one stdio server entry, as readable strings. */
function launchViolations(server: ServerEntry): string[] {
  const { file, name, entry } = server;
  const where = `${file}#mcpServers.${name}`;
  const violations: string[] = [];
  const command = entry["command"];
  if (typeof command !== "string") return violations;
  const args = stringArgs(entry);
  const cwd = entry["cwd"];
  const hostWithoutCwd = HOST_WITHOUT_CWD_FIELD[file];

  if (typeof cwd === "string" && PROJECT_DIR_TOKEN.test(cwd)) {
    violations.push(`${where}: cwd names the project directory (${cwd})`);
  }
  if (hostWithoutCwd === undefined) {
    if (!isPluginRootCwd(file, cwd)) {
      violations.push(`${where}: cwd must be pinned to the plugin root, found ${JSON.stringify(cwd)}`);
    }
  } else if (cwd !== undefined) {
    violations.push(`${where}: this host has no cwd field; remove it or drop the exception`);
  }

  if (command === "node") {
    const script = args[0];
    if (hostWithoutCwd !== undefined) {
      if (script === undefined || !script.startsWith(`${hostWithoutCwd}/`)) {
        violations.push(`${where}: entry script must start with ${hostWithoutCwd}/`);
      }
    } else if (!anchoredEntryScript(file, cwd, script)) {
      violations.push(`${where}: entry script is not anchored at the plugin root (${String(script)})`);
    }
  } else if (command === "npx") {
    const options = npxOptions(args);
    if (!options.includes("--ignore-scripts")) {
      violations.push(`${where}: npx must pass --ignore-scripts`);
    }
    const prefixIdx = options.indexOf("--prefix");
    const prefix = prefixIdx >= 0 ? options[prefixIdx + 1] : undefined;
    if (prefix === undefined || !PLUGIN_OWNED_TOKENS.has(prefix)) {
      violations.push(
        `${where}: npx must pin --prefix to a plugin-owned directory, found ${JSON.stringify(prefix)}`,
      );
    }
  } else if (PACKAGE_RUNNERS.has(command)) {
    violations.push(`${where}: package runner "${command}" is not allowed`);
  } else {
    violations.push(`${where}: command must be "node" or "npx", found "${command}"`);
  }

  args.forEach((arg, index) => {
    if (!PROJECT_DIR_TOKEN.test(arg)) return;
    const viaLauncher =
      args[index - 1] === "--project-dir" &&
      command === "node" &&
      (args[0] ?? "").endsWith("/scripts/plugin-mcp-launcher.mjs");
    if (!viaLauncher) {
      violations.push(`${where}: project directory variable outside --project-dir (${arg})`);
    }
  });
  return violations;
}

describe("host launch manifests never start the server from the analyzed project", () => {
  const manifests = discoverManifests();

  it("scans every shipped manifest, including all known host manifests", () => {
    for (const known of KNOWN_MANIFESTS) {
      expect(manifests, `scan missed ${known}`).toContain(known);
    }
  });

  it("pins every stdio server to the plugin root and keeps npm out of the project context", () => {
    const servers = manifests.flatMap(serverEntriesOf);
    expect(servers.length).toBeGreaterThanOrEqual(9);
    const violations = servers.flatMap(launchViolations);
    expect(violations).toEqual([]);
  });

  it("uses --allow-cwd with npx only where the npm context is pinned or as the documented registry residual", () => {
    const offenders: string[] = [];
    for (const server of manifests.flatMap(serverEntriesOf)) {
      const args = stringArgs(server.entry);
      if (server.entry["command"] === "npx" && args.includes("--allow-cwd")) {
        const options = npxOptions(args);
        const prefix = options[options.indexOf("--prefix") + 1];
        const pinned =
          isPluginRootCwd(server.file, server.entry["cwd"]) &&
          options.includes("--prefix") &&
          prefix !== undefined &&
          PLUGIN_OWNED_TOKENS.has(prefix);
        if (!pinned) offenders.push(`${server.file}#mcpServers.${server.name}`);
      }
    }
    expect(offenders).toEqual([]);

    for (const file of manifests) {
      const parsed = readJson(file);
      if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) continue;
      for (const pkg of parsed["packages"] as unknown[]) {
        if (!isRecord(pkg) || pkg["runtimeHint"] !== "npx") continue;
        const values = (Array.isArray(pkg["packageArguments"]) ? pkg["packageArguments"] : [])
          .filter(isRecord)
          .map((arg) => arg["value"] ?? arg["name"]);
        if (!values.includes("--allow-cwd")) continue;
        expect(file).toBe(REGISTRY_RESIDUAL.file);
        expect(pkg["runtimeArguments"]).toEqual(REGISTRY_RESIDUAL.runtimeArguments);
        expect(pkg["packageArguments"]).toEqual(REGISTRY_RESIDUAL.packageArguments);
      }
    }
  });

  it("rejects the unsafe launch forms the scan was written for", () => {
    const pkg = "causoryn@0.3.2";
    const cases: ReadonlyArray<[string, ServerEntry]> = [
      [
        "bare npx in the host cwd",
        {
          file: "packages/causoryn/.codex-plugin/mcp.json",
          name: "causoryn",
          entry: { command: "npx", args: ["-y", "--ignore-scripts", "--package", pkg, "causoryn", "mcp", "--allow-cwd"] },
        },
      ],
      [
        "node with the project as cwd",
        {
          file: "packages/causoryn/.zcode-plugin/plugin.json",
          name: "causoryn",
          entry: {
            command: "node",
            args: [`${token("ZCODE_PLUGIN_ROOT")}/scripts/plugin-mcp-launcher.mjs`, "--allow-cwd"],
            cwd: token("ZCODE_PROJECT_DIR"),
          },
        },
      ],
      [
        "npx with a pinned cwd but the project's npm prefix",
        {
          file: "mcp_config.json",
          name: "causoryn",
          entry: { command: "npx", args: ["-y", "--ignore-scripts", pkg, "mcp"], cwd: token("PLUGIN_ROOT") },
        },
      ],
      [
        "relative entry script outside a Codex plugin",
        {
          file: "mcp_config.json",
          name: "causoryn",
          entry: { command: "node", args: ["./scripts/plugin-mcp-launcher.mjs"], cwd: "." },
        },
      ],
      [
        "project variable passed as --root",
        {
          file: "packages/causoryn/.zcode-plugin/plugin.json",
          name: "causoryn",
          entry: {
            command: "node",
            args: [`${token("ZCODE_PLUGIN_ROOT")}/scripts/plugin-mcp-launcher.mjs`, "--root", token("ZCODE_PROJECT_DIR")],
            cwd: token("ZCODE_PLUGIN_ROOT"),
          },
        },
      ],
    ];
    for (const [label, server] of cases) {
      expect(launchViolations(server), label).not.toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* End to end: start the staged package exactly as each manifest says  */
/* ------------------------------------------------------------------ */

const PKG_DIR = path.join(REPO_ROOT, "packages", "causoryn");
const STAGED_PACKAGE_PRESENT =
  existsSync(path.join(PKG_DIR, "dist", "mcp-server.mjs")) &&
  existsSync(path.join(PKG_DIR, "dist", "bundle-manifest.json"));

interface LaunchResult {
  readonly authorized: boolean | undefined;
  readonly stderr: string;
}

/** Host substitution of `${NAME}` tokens; unknown tokens stay literal, as hosts leave them. */
function expandTokens(value: string, vars: Readonly<Record<string, string>>): string {
  let out = value;
  for (const [name, replacement] of Object.entries(vars)) {
    out = out.split(token(name)).join(replacement);
  }
  return out;
}

function manifestServer(file: string): Record<string, unknown> {
  const servers = (readJson(file) as Record<string, Record<string, unknown>>)["mcpServers"];
  const server = servers?.["causoryn"];
  if (!isRecord(server)) throw new Error(`${file}: no causoryn server`);
  return server;
}

/**
 * Spawns the server the way a host would, runs initialize + causoryn_status
 * and answers MCP roots/list with `clientRoots` when that capability is
 * declared. Returns whether a workspace root was authorized, plus stderr.
 */
async function launchAndReadStatus(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  clientRoots: readonly string[] | undefined,
): Promise<LaunchResult> {
  const child = spawn(command, [...args], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message["method"] === "roots/list" && message["id"] !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message["id"],
          result: {
            roots: (clientRoots ?? []).map((root) => ({ uri: pathToFileURL(root).href, name: "project" })),
          },
        });
        continue;
      }
      if (typeof message["id"] === "number") waiters.get(message["id"])?.(message);
    }
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out; stderr=${stderr}`)),
        30_000,
      );
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  try {
    await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: clientRoots === undefined ? {} : { roots: { listChanged: false } },
      clientInfo: { name: "causoryn-manifest-launch-test", version: "0.0.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const response = await request(2, "tools/call", { name: "causoryn_status", arguments: {} });
    const result = response["result"] as
      | { structuredContent?: { data?: { authorized?: boolean } }; content?: Array<{ text?: string }> }
      | undefined;
    const data =
      result?.structuredContent?.data ??
      (JSON.parse(result?.content?.[0]?.text ?? "{}") as { data?: { authorized?: boolean } }).data;
    child.stdin.end();
    await closed;
    return { authorized: data?.authorized, stderr };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

describe.runIf(STAGED_PACKAGE_PRESENT)("manifest launch forms start the staged package", () => {
  let sandbox = "";
  let fakeHome = "";
  let projectDir = "";
  let env: NodeJS.ProcessEnv = {};

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "causoryn-manifest-launch-"));
    fakeHome = path.join(sandbox, "home");
    projectDir = path.join(sandbox, "project");
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(path.join(projectDir, "src"), { recursive: true });
    writeFileSync(path.join(projectDir, "package.json"), '{"name":"launch-probe","version":"1.0.0"}\n');
    writeFileSync(path.join(projectDir, "src", "index.ts"), "export const answer = 42;\n");
    env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_HOME: path.join(fakeHome, ".codex") };
    for (const key of [
      "CAUSORYN_CONFIG",
      "CAUSORYN_ASSET_ROOT",
      "CAUSORYN_EXPECTED_VERSION",
      "CLAUDE_PLUGIN_ROOT",
      "ZCODE_PLUGIN_ROOT",
      "ZCODE_PLUGIN_DATA",
    ]) {
      delete env[key];
    }
  });

  afterAll(() => {
    if (sandbox.length > 0) rmSync(sandbox, { recursive: true, force: true });
  });

  it(
    "ZCode: node starts in the plugin root and the launcher binds the project directory through --allow-cwd",
    { timeout: 60_000 },
    async () => {
      const server = manifestServer("packages/causoryn/.zcode-plugin/plugin.json");
      const vars = { ZCODE_PLUGIN_ROOT: PKG_DIR, ZCODE_PROJECT_DIR: projectDir };
      const cwd = expandTokens(String(server["cwd"]), vars);
      expect(realpathSync.native(cwd)).toBe(realpathSync.native(PKG_DIR));
      const run = await launchAndReadStatus(
        String(server["command"]),
        stringArgs(server).map((arg) => expandTokens(arg, vars)),
        cwd,
        env,
        undefined,
      );
      expect(run.authorized, run.stderr).toBe(true);
      expect(run.stderr).toContain(`authorized workspace via --allow-cwd: ${realpathSync.native(projectDir)}`);
    },
  );

  it(
    "ZCode: an unsafe project directory is still refused by the --allow-cwd safety check",
    { timeout: 60_000 },
    async () => {
      const server = manifestServer("packages/causoryn/.zcode-plugin/plugin.json");
      const vars = { ZCODE_PLUGIN_ROOT: PKG_DIR, ZCODE_PROJECT_DIR: fakeHome };
      const run = await launchAndReadStatus(
        String(server["command"]),
        stringArgs(server).map((arg) => expandTokens(arg, vars)),
        expandTokens(String(server["cwd"]), vars),
        env,
        undefined,
      );
      expect(run.authorized, run.stderr).toBe(false);
    },
  );

  it(
    "Codex: a relative cwd joined onto the plugin root starts the launcher; with no MCP roots the workspace stays unauthorized",
    { timeout: 60_000 },
    async () => {
      const server = manifestServer("packages/causoryn/.codex-plugin/mcp.json");
      // codex-rs/codex-mcp/src/plugin_config.rs: relative cwd = plugin_root.join(cwd).
      const cwd = path.join(PKG_DIR, String(server["cwd"]));
      const run = await launchAndReadStatus(String(server["command"]), stringArgs(server), cwd, env, undefined);
      // Codex's MCP client declares no roots capability, so nothing can bind a
      // workspace here; this is the documented host-dependent residual.
      expect(run.authorized, run.stderr).toBe(false);
      expect(run.stderr).toContain("--allow-cwd rejected");
    },
  );

  it(
    "Antigravity package: node starts in the plugin root and binds the workspace from MCP roots/list",
    { timeout: 60_000 },
    async () => {
      const server = manifestServer("packages/causoryn/mcp_config.json");
      const vars = { PLUGIN_ROOT: PKG_DIR };
      const run = await launchAndReadStatus(
        String(server["command"]),
        stringArgs(server).map((arg) => expandTokens(arg, vars)),
        expandTokens(String(server["cwd"]), vars),
        env,
        [projectDir],
      );
      expect(run.authorized, run.stderr).toBe(true);
      expect(run.stderr).toContain(`bound workspace via MCP roots/list: ${realpathSync.native(projectDir)}`);
    },
  );
});
