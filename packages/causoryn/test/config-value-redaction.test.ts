import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CausorynCliError,
  readCodexMcpServer,
  runCli,
  runDoctor,
  runSetup,
  type ToolchainProbeFn,
} from "../src/index.js";
import {
  captureIo,
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
  type SetupSandbox,
} from "./helpers/setup-sandbox.js";

/**
 * CAU-12 (CWE-209): a malformed or unusable value in a host config file
 * (Codex `config.toml`, JSON host configs) is never echoed by `causoryn setup`
 * or `causoryn doctor` — not in errors, not in the text output and not in
 * the JSON output. Messages name the file, the line (where known) and the
 * key, never the value: env values are often credentials.
 */

afterEach(() => {
  removeSetupSandboxes();
});

/** Every assertion checks the prefix, so a truncated echo ("SENTINEL-V...") is caught as well. */
const SENTINEL = "SENTINEL-VALUE-123";
const SENTINEL_PREFIX = "SENTINEL";

const absentToolchains: ToolchainProbeFn = () => ({
  available: false,
  version: null,
  detail: "not installed",
  failure: "not-found",
});

function writeCodexConfig(sb: SetupSandbox, lines: readonly string[]): string {
  mkdirSync(sb.codexHome, { recursive: true });
  const target = path.join(sb.codexHome, "config.toml");
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

async function runCliIn(sb: SetupSandbox, pkg: string, argv: readonly string[]) {
  const cap = captureIo();
  const exitCode = await runCli(argv, {
    io: cap.io,
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: pkg,
    ephemeralTmpDir: sb.notTmp,
    probeToolchain: absentToolchains,
  });
  return { exitCode, stdout: cap.stdout(), stderr: cap.stderr(), all: cap.stdout() + cap.stderr() };
}

function errorOf(fn: () => unknown): CausorynCliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CausorynCliError) return error;
    throw error;
  }
  throw new Error("expected a CausorynCliError");
}

const HEADER = ["[mcp_servers.causoryn]", 'command = "node"', 'args = ["a.mjs"]'];

/** Codex configs whose bad value is the sentinel, with the key the message must name and the line. */
const MALFORMED_CODEX_CASES: ReadonlyArray<{
  readonly name: string;
  readonly lines: readonly string[];
  readonly key: RegExp;
  readonly line: number;
  /** Extra text that must not appear (a value fragment the sentinel prefix would not catch). */
  readonly fragment?: string;
}> = [
  {
    name: "a bare env sub-table value",
    lines: [...HEADER, "", "[mcp_servers.causoryn.env]", `API_TOKEN = ${SENTINEL}`],
    key: /mcp_servers\.causoryn\.env\.API_TOKEN/,
    line: 6,
  },
  {
    name: "a quoted env value with trailing garbage",
    lines: [...HEADER, "", "[mcp_servers.causoryn.env]", `API_TOKEN = "${SENTINEL}" trailing`],
    key: /mcp_servers\.causoryn\.env\.API_TOKEN/,
    line: 6,
  },
  {
    name: "a bare value in an inline env table",
    lines: [...HEADER, `env = { API_TOKEN = ${SENTINEL} }`],
    key: /mcp_servers\.causoryn\.env\.API_TOKEN/,
    line: 4,
  },
  {
    name: "an inline env table entry without '='",
    lines: [...HEADER, `env = { ${SENTINEL} }`],
    key: /mcp_servers\.causoryn\.env/,
    line: 4,
  },
  {
    name: "an env value that is not an inline table",
    lines: [...HEADER, `env = "${SENTINEL}"`],
    key: /mcp_servers\.causoryn\.env/,
    line: 4,
  },
  {
    name: "a dotted env key with a bare value",
    lines: [...HEADER, `env.API_TOKEN = ${SENTINEL}`],
    key: /mcp_servers\.causoryn\.env\.API_TOKEN/,
    line: 4,
  },
  {
    name: "an invalid \\u escape in an env value",
    lines: [...HEADER, "", "[mcp_servers.causoryn.env]", `API_TOKEN = "\\uQZXW${SENTINEL}"`],
    key: /mcp_servers\.causoryn\.env\.API_TOKEN/,
    line: 6,
    fragment: "QZXW",
  },
  {
    name: "a bare command",
    lines: ["[mcp_servers.causoryn]", `command = ${SENTINEL}`, 'args = ["a.mjs"]'],
    key: /mcp_servers\.causoryn\.command/,
    line: 2,
  },
  {
    name: "a non-array args value",
    lines: ["[mcp_servers.causoryn]", 'command = "node"', `args = "${SENTINEL}"`],
    key: /mcp_servers\.causoryn\.args/,
    line: 3,
  },
  {
    name: "a bare args item",
    lines: ["[mcp_servers.causoryn]", 'command = "node"', `args = ["a.mjs", ${SENTINEL}]`],
    key: /mcp_servers\.causoryn\.args/,
    line: 3,
  },
];

describe("CAU-12: TOML value errors name the key and line, never the value", () => {
  for (const testCase of MALFORMED_CODEX_CASES) {
    it(`readCodexMcpServer: ${testCase.name}`, () => {
      const error = errorOf(() => readCodexMcpServer(`${testCase.lines.join("\n")}\n`));
      expect(error.code).toBe("cli/malformed-toml");
      expect(error.message).not.toContain(SENTINEL_PREFIX);
      expect(error.message).not.toContain(testCase.fragment ?? SENTINEL_PREFIX);
      expect(error.message).toMatch(testCase.key);
      expect(error.message).toContain(`line ${String(testCase.line)}`);
    });
  }

  it("setup (text and --json) and doctor (text and --json) report the key and file but not the value", async () => {
    for (const testCase of MALFORMED_CODEX_CASES) {
      const sb = createSetupSandbox("codex-redact");
      const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
      const target = writeCodexConfig(sb, testCase.lines);

      for (const argv of [
        ["setup", "--client", "codex", "--no-skill", "--yes"],
        ["setup", "--client", "codex", "--no-skill", "--yes", "--json"],
        ["setup", "--client", "codex", "--no-skill", "--dry-run", "--json"],
      ]) {
        const res = await runCliIn(sb, pkg, argv);
        expect(res.exitCode, `${testCase.name}: ${argv.join(" ")}`).toBe(2);
        expect(res.all, testCase.name).not.toContain(SENTINEL_PREFIX);
        expect(res.all, testCase.name).not.toContain(testCase.fragment ?? SENTINEL_PREFIX);
        expect(res.stderr, testCase.name).toMatch(testCase.key);
        expect(res.stderr, testCase.name).toContain(target);
      }

      for (const argv of [
        ["doctor", "--client", "codex"],
        ["doctor", "--client", "codex", "--json"],
      ]) {
        const res = await runCliIn(sb, pkg, argv);
        expect(res.all, `${testCase.name}: ${argv.join(" ")}`).not.toContain(SENTINEL_PREFIX);
        expect(res.all, testCase.name).not.toContain(testCase.fragment ?? SENTINEL_PREFIX);
        expect(res.stdout, testCase.name).toMatch(testCase.key);
      }

      const report = runDoctor({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: pkg,
        clients: ["codex"],
        probeToolchain: absentToolchains,
      });
      expect(report.hosts.codex.configValid).toBe(false);
      expect(JSON.stringify(report)).not.toContain(SENTINEL_PREFIX);
      expect(JSON.stringify(report)).not.toContain(testCase.fragment ?? SENTINEL_PREFIX);
      expect(report.hosts.codex.detail).toMatch(testCase.key);
    }
  });

  it("setup does not echo an unusable startup_timeout_sec value (text and --json)", async () => {
    const sb = createSetupSandbox("codex-timeout-redact");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const lines = ["[mcp_servers.causoryn]", 'command = "node"', 'args = ["a.mjs"]', `startup_timeout_sec = "${SENTINEL}"`];

    writeCodexConfig(sb, lines);
    const dry = await runCliIn(sb, pkg, ["setup", "--client", "codex", "--no-skill", "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.all).not.toContain(SENTINEL_PREFIX);
    expect(dry.stdout).toMatch(/replaced the unusable startup_timeout_sec value with 30/);

    const applied = await runCliIn(sb, pkg, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.all).not.toContain(SENTINEL_PREFIX);
    expect(applied.stdout).toMatch(/replaced the unusable startup_timeout_sec value with 30/);
  });
});

describe("CAU-12: JSON syntax errors report the position, never the source text", () => {
  it("setup and doctor do not echo the offending JSON text of a host config", async () => {
    const sb = createSetupSandbox("json-redact");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const claudeJson = path.join(sb.home, ".claude.json");
    writeFileSync(claudeJson, `{\n  "mcpServers": {\n    "other": { "env": { "TOKEN": ${SENTINEL} } }\n  }\n}\n`, "utf8");

    await expect(
      runSetup({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: pkg,
        ephemeralTmpDir: sb.notTmp,
        clients: ["claude-code"],
        installSkills: false,
        dryRun: true,
      }),
    ).rejects.toThrow(/Malformed JSON configuration file/);

    for (const argv of [
      ["setup", "--client", "claude-code", "--no-skill", "--yes"],
      ["setup", "--client", "claude-code", "--no-skill", "--yes", "--json"],
    ]) {
      const res = await runCliIn(sb, pkg, argv);
      expect(res.exitCode).toBe(2);
      expect(res.all).not.toContain(SENTINEL_PREFIX);
      expect(res.stderr).toContain(claudeJson);
    }

    for (const argv of [
      ["doctor", "--client", "claude-code"],
      ["doctor", "--client", "claude-code", "--json"],
    ]) {
      const res = await runCliIn(sb, pkg, argv);
      expect(res.all).not.toContain(SENTINEL_PREFIX);
      expect(res.stdout).toMatch(/invalid JSON/);
    }
  });

  it("reports line and column when the JSON parser knows them", async () => {
    const sb = createSetupSandbox("json-position");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    writeFileSync(path.join(sb.home, ".claude.json"), `{\n  "mcpServers": { "a": "${SENTINEL}", }\n}\n`, "utf8");

    const res = await runCliIn(sb, pkg, ["setup", "--client", "claude-code", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(2);
    expect(res.all).not.toContain(SENTINEL_PREFIX);
    expect(res.stderr).toMatch(/line 2, column \d+/);
  });
});
