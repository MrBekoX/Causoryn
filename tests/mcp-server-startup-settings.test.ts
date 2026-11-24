import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CausorynConfigError,
  createCausorynContext,
  parseCausorynServerConfig,
  parseMcpCliArgs,
} from "../packages/mcp-server/src/index.js";
import {
  McpCliUsageError,
  resolveEffectiveToolProfile,
  resolveMcpServerSettings,
} from "../packages/mcp-server/src/runtime-cli.js";
import { HISTORY_TOOL_NAMES } from "../packages/mcp-server/src/version.js";

/**
 * Startup settings shared by both MCP entry points:
 * - `CAUSORYN_CONFIG.toolProfile` is honored with the documented precedence
 *   `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > config `toolProfile` > `core`
 *   and validated with the same profile parser as the CLI flag.
 * - The bare `stdio.ts` entry (bundled as `dist/mcp-server.mjs`) and the
 *   `causoryn mcp` entry (`cli-stdio.ts`) resolve output schema profile, tool
 *   profile and index wait window through one shared function.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SRC = path.join(REPO_ROOT, "packages", "mcp-server", "src");
const BARE_ENTRY = path.join(MCP_SRC, "stdio.ts");
const CLI_ENTRY = path.join(MCP_SRC, "cli-stdio.ts");
const LOADER_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "test",
  "loader",
  "register-strip.mjs",
);
const READY_MARKER = "causoryn mcp server ready";

/** Environment keys that would otherwise leak profile settings from the parent shell. */
const SETTINGS_ENV_KEYS = [
  "CAUSORYN_CONFIG",
  "CAUSORYN_TOOL_PROFILE",
  "CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE",
  "CAUSORYN_INDEX_WAIT_MS",
] as const;

function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SETTINGS_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

interface ListedTool {
  readonly name: string;
  readonly outputSchema?: unknown;
}

interface SpawnOutcome {
  readonly exitCode: number | null;
  readonly tools: readonly ListedTool[] | undefined;
  readonly stderr: string;
  readonly stdoutLines: readonly string[];
}

/**
 * Starts an MCP entry point from source, performs initialize + tools/list and
 * closes stdin. When the process exits before becoming ready (startup
 * failure) the outcome carries the exit code and stderr only.
 */
function runEntry(
  entry: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        pathToFileURL(LOADER_ENTRY).href,
        entry,
        ...argv,
      ],
      { cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    const stdoutLines: string[] = [];
    const stderrChunks: string[] = [];
    let tools: ListedTool[] | undefined;
    let sent = false;

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 120_000);

    const send = (): void => {
      if (sent) return;
      sent = true;
      const frames = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "startup-settings-test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ];
      for (const frame of frames) {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      }
    };

    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (line.length === 0) continue;
        stdoutLines.push(line);
        const message = JSON.parse(line) as { id?: unknown; result?: { tools?: ListedTool[] } };
        if (message.id === 2) {
          tools = message.result?.tools ?? [];
          child.stdin.end();
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      if (stderrChunks.join("").includes(READY_MARKER)) {
        send();
      }
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ exitCode: code, tools, stderr: stderrChunks.join(""), stdoutLines });
    });
  });
}

describe("CAUSORYN_CONFIG.toolProfile — validation and precedence", () => {
  it("accepts valid single and comma-separated profiles in the config schema", () => {
    expect(parseCausorynServerConfig({ toolProfile: "history" }).toolProfile).toBe("history");
    expect(parseCausorynServerConfig({ toolProfile: "wiki,history" }).toolProfile).toBe(
      "wiki,history",
    );
    expect(parseCausorynServerConfig({}).toolProfile).toBeUndefined();
  });

  it("rejects an unknown or malformed config toolProfile with a clear validation error", () => {
    for (const bad of ["bogus", "wiki,,history", "core,unknown", " "]) {
      let caught: unknown;
      try {
        parseCausorynServerConfig({ toolProfile: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught, `toolProfile ${JSON.stringify(bad)} must be rejected`).toBeInstanceOf(
        CausorynConfigError,
      );
      const issues = (caught as CausorynConfigError).issues.join("; ");
      expect(issues).toContain("toolProfile");
      expect(issues).toContain("valid profiles: core, full, wiki, history");
    }
    expect(() => createCausorynContext({ toolProfile: "bogus" })).toThrow(CausorynConfigError);
  });

  it("applies --tool-profile > CAUSORYN_TOOL_PROFILE > config toolProfile > core", () => {
    const bare = parseMcpCliArgs([]);
    const cli = parseMcpCliArgs(["mcp", "--tool-profile", "full"]);
    const config = { toolProfile: "history" };

    expect(resolveMcpServerSettings(bare, {}, {}).toolProfile).toBe("core");
    expect(resolveMcpServerSettings(bare, {}, config).toolProfile).toBe("history");
    expect(resolveMcpServerSettings(bare, { CAUSORYN_TOOL_PROFILE: "wiki" }, config).toolProfile).toBe(
      "wiki",
    );
    expect(
      resolveMcpServerSettings(cli, { CAUSORYN_TOOL_PROFILE: "wiki" }, config).toolProfile,
    ).toBe("full");
    // An empty env value means "unset" and falls through to the config value.
    expect(resolveMcpServerSettings(bare, { CAUSORYN_TOOL_PROFILE: "  " }, config).toolProfile).toBe(
      "history",
    );
    // The lower-level resolver applies the same precedence.
    expect(resolveEffectiveToolProfile(bare, {}, "wiki, history")).toBe("wiki,history");
    expect(resolveEffectiveToolProfile(bare, { CAUSORYN_TOOL_PROFILE: "core" }, "wiki")).toBe(
      "core",
    );
  });

  it("rejects invalid config toolProfile values in the shared resolver with the config field named", () => {
    const bare = parseMcpCliArgs([]);
    expect(() => resolveMcpServerSettings(bare, {}, { toolProfile: "bogus" })).toThrow(
      McpCliUsageError,
    );
    expect(() => resolveMcpServerSettings(bare, {}, { toolProfile: "bogus" })).toThrow(
      /CAUSORYN_CONFIG\.toolProfile/,
    );
    expect(() => resolveMcpServerSettings(bare, {}, { toolProfile: 7 })).toThrow(
      /CAUSORYN_CONFIG\.toolProfile must be a string/,
    );
    // A higher-precedence source does not hide an invalid lower-precedence value.
    expect(() =>
      resolveMcpServerSettings(bare, { CAUSORYN_TOOL_PROFILE: "wiki" }, { toolProfile: "bogus" }),
    ).toThrow(/CAUSORYN_CONFIG\.toolProfile/);
  });

  it("resolves output schema profile and index wait window from the same function", () => {
    const bare = parseMcpCliArgs([]);
    const settings = resolveMcpServerSettings(
      bare,
      { CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "full", CAUSORYN_INDEX_WAIT_MS: "250" },
      {},
    );
    expect(settings.outputSchemaProfile).toBe("full");
    expect(settings.indexWaitTimeoutMs).toBe(250);
    const defaults = resolveMcpServerSettings(bare, {}, {});
    expect(defaults.outputSchemaProfile).toBe("omit");
    expect(defaults.indexWaitTimeoutMs).toBe(15_000);
    expect(() =>
      resolveMcpServerSettings(bare, { CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "bogus" }, {}),
    ).toThrow(McpCliUsageError);
  });
});

describe("MCP entry points resolve the same startup settings", { timeout: 300_000 }, () => {
  it("bare stdio.ts honors CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE and CAUSORYN_CONFIG.toolProfile like cli-stdio.ts", async () => {
    const env = cleanEnv({
      CAUSORYN_CONFIG: JSON.stringify({ allowRoots: [], toolProfile: "history" }),
      CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    });
    const [bare, cli] = await Promise.all([
      runEntry(BARE_ENTRY, [], env),
      runEntry(CLI_ENTRY, ["mcp"], env),
    ]);

    for (const [label, outcome] of [
      ["stdio.ts", bare],
      ["cli-stdio.ts", cli],
    ] as const) {
      expect(outcome.exitCode, `${label} stderr: ${outcome.stderr}`).toBe(0);
      expect(outcome.tools, `${label} must answer tools/list`).toBeDefined();
      const names = (outcome.tools ?? []).map((tool) => tool.name);
      for (const historyTool of HISTORY_TOOL_NAMES) {
        expect(names, `${label} must expose ${historyTool}`).toContain(historyTool);
      }
      expect(
        (outcome.tools ?? []).every((tool) => tool.outputSchema !== undefined),
        `${label} must publish outputSchema when CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full`,
      ).toBe(true);
      for (const line of outcome.stdoutLines) {
        expect((JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc).toBe("2.0");
      }
    }
    const bareNames = (bare.tools ?? []).map((tool) => tool.name);
    const cliNames = (cli.tools ?? []).map((tool) => tool.name);
    expect(bareNames).toEqual(cliNames);
  });

  it("CAUSORYN_TOOL_PROFILE still overrides config toolProfile in the bare entry", async () => {
    const outcome = await runEntry(
      BARE_ENTRY,
      [],
      cleanEnv({
        CAUSORYN_CONFIG: JSON.stringify({ allowRoots: [], toolProfile: "history" }),
        CAUSORYN_TOOL_PROFILE: "core",
      }),
    );
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const names = (outcome.tools ?? []).map((tool) => tool.name);
    for (const historyTool of HISTORY_TOOL_NAMES) {
      expect(names).not.toContain(historyTool);
    }
    expect((outcome.tools ?? []).every((tool) => tool.outputSchema === undefined)).toBe(true);
  });

  it("both entries stop with exit code 2 and a clear stderr message for an invalid config toolProfile", async () => {
    const env = cleanEnv({
      CAUSORYN_CONFIG: JSON.stringify({ allowRoots: [], toolProfile: "bogus" }),
    });
    const [bare, cli] = await Promise.all([
      runEntry(BARE_ENTRY, [], env),
      runEntry(CLI_ENTRY, ["mcp"], env),
    ]);
    for (const outcome of [bare, cli]) {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.tools).toBeUndefined();
      expect(outcome.stdoutLines).toEqual([]);
      expect(outcome.stderr).toContain("CAUSORYN_CONFIG.toolProfile");
      expect(outcome.stderr).toContain('Invalid tool profile "bogus"');
    }
  });
});
