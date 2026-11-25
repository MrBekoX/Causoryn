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
  HOST_CLIENT_IDS,
  readCodexMcpServer,
  runCli,
  runSetup,
  upsertCodexMcpServer,
  type HostClientId,
} from "../packages/causoryn/src/index.js";
import { SETUP_TOOL_PROFILES } from "../packages/causoryn/src/types.js";
import { TOOL_PROFILES } from "../packages/mcp-server/src/version.js";

/**
 * `causoryn setup --tool-profile` and preservation of user customizations of an
 * existing Causoryn entry (`--tool-profile` / `--output-schema` arguments and
 * `env` keys) across re-runs, for the three JSON host formats and Codex TOML.
 */

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-setup-profile-${prefix}-`));
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

function createFakePkg(baseDir: string): string {
  const pkgRoot = path.join(baseDir, "pkg");
  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(path.join(pkgRoot, "package.json"), '{"name":"causoryn","version":"0.3.0"}', "utf8");
  writeFileSync(path.join(pkgRoot, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(path.join(pkgRoot, "dist", "mcp-server.mjs"), "// bundle\n", "utf8");
  for (const skillName of CANONICAL_SKILL_NAMES) {
    const dir = path.join(pkgRoot, "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf8");
  }
  return pkgRoot;
}

interface Sandbox {
  readonly sandbox: string;
  readonly home: string;
  readonly codexHome: string;
  readonly pkgRoot: string;
  readonly cliScript: string;
}

function createSandbox(prefix: string): Sandbox {
  const sandbox = createTempDir(prefix);
  const home = path.join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  const pkgRoot = createFakePkg(sandbox);
  return {
    sandbox,
    home,
    codexHome: path.join(home, ".codex"),
    pkgRoot,
    cliScript: path.join(pkgRoot, "scripts", "causoryn.mjs"),
  };
}

function configPathFor(sb: Sandbox, client: HostClientId): string {
  switch (client) {
    case "antigravity":
      return path.join(sb.home, ".gemini", "config", "mcp_config.json");
    case "claude-code":
      return path.join(sb.home, ".claude.json");
    case "codex":
      return path.join(sb.codexHome, "config.toml");
    case "zcode":
      return path.join(sb.home, ".zcode", "cli", "config.json");
  }
}

interface ReadEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, unknown>> | undefined;
}

function readEntry(sb: Sandbox, client: HostClientId): ReadEntry {
  const raw = readFileSync(configPathFor(sb, client), "utf8");
  if (client === "codex") {
    const parsed = readCodexMcpServer(raw);
    if (parsed === null) throw new Error("no [mcp_servers.causoryn] table");
    return {
      command: parsed.command,
      args: parsed.args,
      env: Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
    };
  }
  const doc = JSON.parse(raw) as {
    mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, unknown> }>;
    mcp?: { servers?: Record<string, { command: string; args: string[]; env?: Record<string, unknown> }> };
  };
  const entry = client === "zcode" ? doc.mcp?.servers?.["causoryn"] : doc.mcpServers?.["causoryn"];
  if (entry === undefined) throw new Error(`no causoryn entry for ${client}`);
  return { command: entry.command, args: entry.args, env: entry.env };
}

function baseArgs(sb: Sandbox, client: HostClientId): string[] {
  return [sb.cliScript, "mcp", "--allow-cwd", "--auto-data-dir", "--client", client];
}

/** Writes a host config whose causoryn entry looks like an older `setup` run plus user edits. */
function writeCustomizedEntry(
  sb: Sandbox,
  client: HostClientId,
  params: {
    readonly command: string;
    readonly extraArgs: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  },
): void {
  const target = configPathFor(sb, client);
  mkdirSync(path.dirname(target), { recursive: true });
  const args = [...baseArgs(sb, client), ...params.extraArgs];
  if (client === "codex") {
    const q = (s: string): string => JSON.stringify(s);
    const lines = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.causoryn]",
      `command = ${q(params.command)}`,
      `args = [${args.map(q).join(", ")}]`,
      "startup_timeout_sec = 30",
    ];
    if (params.env !== undefined) {
      lines.push("", "[mcp_servers.causoryn.env]");
      for (const [k, v] of Object.entries(params.env)) lines.push(`${k} = ${q(v)}`);
    }
    writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
    return;
  }
  const entry: Record<string, unknown> = {
    ...(client === "antigravity" ? {} : { type: "stdio" }),
    command: params.command,
    args,
    ...(params.env !== undefined ? { env: { ...params.env } } : {}),
  };
  const doc =
    client === "zcode"
      ? { theme: "dark", mcp: { servers: { causoryn: entry } } }
      : { userKey: 1, mcpServers: { other: { command: "npx", args: ["other"] }, causoryn: entry } };
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

async function runCliIn(
  sb: Sandbox,
  argv: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: sb.pkgRoot,
    ephemeralTmpDir: path.join(sb.sandbox, "unused-tmp"),
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  });
  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".causoryn.") && f.endsWith(".backup"));
}

describe("causoryn setup --tool-profile", () => {
  it("pins its profile list to the profiles exported by @causoryn/mcp-server", () => {
    expect([...SETUP_TOOL_PROFILES]).toEqual([...TOOL_PROFILES]);
  });

  it("writes `--tool-profile <list>` into the generated `causoryn mcp` args of every host format (JSON and Codex TOML)", async () => {
    const sb = createSandbox("write-all");
    const res = await runCliIn(sb, [
      "setup",
      "--all",
      "--no-skill",
      "--yes",
      "--tool-profile",
      " wiki , history,wiki ",
    ]);
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    for (const client of HOST_CLIENT_IDS) {
      const entry = readEntry(sb, client);
      expect(entry.command).toBe(process.execPath);
      expect(entry.args).toEqual([...baseArgs(sb, client), "--tool-profile", "wiki,history"]);
    }

    // The `--tool-profile=<value>` spelling and the programmatic option behave the same.
    const sb2 = createSandbox("write-inline");
    expect((await runCliIn(sb2, ["setup", "--client", "codex", "--no-skill", "--yes", "--tool-profile=full"])).exitCode).toBe(0);
    expect(readEntry(sb2, "codex").args).toEqual([...baseArgs(sb2, "codex"), "--tool-profile", "full"]);
    const result = await runSetup({
      homeDir: sb2.home,
      codexHomeDir: sb2.codexHome,
      packageRoot: sb2.pkgRoot,
      ephemeralTmpDir: path.join(sb2.sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: false,
      toolProfile: "history",
      yes: true,
    });
    expect(result.applied).toBe(true);
    expect(readEntry(sb2, "claude-code").args).toEqual([
      ...baseArgs(sb2, "claude-code"),
      "--tool-profile",
      "history",
    ]);
  });

  it("rejects an invalid, empty or missing --tool-profile value with exit code 2 and writes nothing", async () => {
    const sb = createSandbox("invalid");
    for (const argv of [
      ["setup", "--all", "--yes", "--tool-profile", "bogus"],
      ["setup", "--all", "--yes", "--tool-profile", "wiki,nope"],
      ["setup", "--all", "--yes", "--tool-profile=  "],
      ["setup", "--all", "--yes", "--tool-profile"],
      ["setup", "--all", "--yes", "--tool-profile", "--json"],
      ["setup", "--all", "--uninstall", "--yes", "--tool-profile", "wiki"],
    ]) {
      const res = await runCliIn(sb, argv);
      expect(res.exitCode, argv.join(" ")).toBe(2);
      expect(res.stderr).toContain("[causoryn] error:");
      expect(res.stderr).toContain("--tool-profile");
      expect(res.stderr).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
    const invalid = await runCliIn(sb, ["setup", "--all", "--yes", "--tool-profile", "bogus"]);
    expect(invalid.stderr).toContain("core, full, wiki, history");
    expect(readdirSync(sb.home)).toEqual([]);

    await expect(
      runSetup({
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: sb.pkgRoot,
        ephemeralTmpDir: path.join(sb.sandbox, "unused-tmp"),
        all: true,
        toolProfile: "bogus",
        yes: true,
      }),
    ).rejects.toThrow(/Invalid --tool-profile value "bogus"/);
    expect(readdirSync(sb.home)).toEqual([]);
  });

  it("keeps a user-added --tool-profile / --output-schema argument and env keys when setup is re-run (JSON hosts and Codex TOML)", async () => {
    const sb = createSandbox("preserve");
    const userEnv = { FOO: "bar", CAUSORYN_INDEX_WAIT_MS: "30000" };
    for (const client of HOST_CLIENT_IDS) {
      writeCustomizedEntry(sb, client, {
        command: "/opt/old-node/bin/node",
        extraArgs: ["--tool-profile", "wiki,history", "--output-schema=full"],
        env: userEnv,
      });
    }

    // The old Node path forces a real update of every entry.
    const result = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: sb.pkgRoot,
      ephemeralTmpDir: path.join(sb.sandbox, "unused-tmp"),
      clients: [...HOST_CLIENT_IDS],
      installSkills: false,
      yes: true,
    });
    expect(result.applied).toBe(true);

    for (const client of HOST_CLIENT_IDS) {
      const entry = readEntry(sb, client);
      expect(entry.command, client).toBe(process.execPath);
      expect(entry.args, client).toEqual([
        ...baseArgs(sb, client),
        "--tool-profile",
        "wiki,history",
        "--output-schema=full",
      ]);
      expect(entry.env, client).toEqual(userEnv);
    }

    // Unrelated content of the host files is untouched.
    const claudeDoc = JSON.parse(readFileSync(configPathFor(sb, "claude-code"), "utf8")) as {
      userKey: number;
      mcpServers: Record<string, unknown>;
    };
    expect(claudeDoc.userKey).toBe(1);
    expect(claudeDoc.mcpServers["other"]).toEqual({ command: "npx", args: ["other"] });
    expect(readFileSync(configPathFor(sb, "codex"), "utf8")).toContain('model = "gpt-5"');
  });

  it("keeps inline Codex env tables and the --output-schema-profile spelling", async () => {
    const sb = createSandbox("codex-inline-env");
    mkdirSync(sb.codexHome, { recursive: true });
    const q = (s: string): string => JSON.stringify(s);
    const args = [...baseArgs(sb, "codex"), "--output-schema-profile", "full"];
    writeFileSync(
      configPathFor(sb, "codex"),
      [
        "[mcp_servers.causoryn]",
        `command = ${q("/opt/old-node/bin/node")}`,
        `args = [${args.map(q).join(", ")}]`,
        `env = { "MY.KEY" = 'literal value', CAUSORYN_TOOL_PROFILE = "history" }`,
        "startup_timeout_sec = 30",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(0);
    const entry = readEntry(sb, "codex");
    expect(entry.args).toEqual([...baseArgs(sb, "codex"), "--output-schema-profile", "full"]);
    expect(entry.env).toEqual({ "MY.KEY": "literal value", CAUSORYN_TOOL_PROFILE: "history" });
  });

  it("readCodexMcpServer reads dotted env keys and the env sub-table as own properties, and rejects non-string env values", () => {
    const parsed = readCodexMcpServer(
      [
        "[mcp_servers.causoryn]",
        'command = "node"',
        'args = ["causoryn.mjs", "mcp"]',
        'env.DOTTED = "d"',
        "env . \"Q.K\" = 'q'",
        "",
        "[mcp_servers.causoryn.env]",
        '"__proto__" = "p"',
        'PLAIN = "v"',
        "",
      ].join("\n"),
    );
    expect(parsed?.env).toEqual({ DOTTED: "d", "Q.K": "q", PLAIN: "v", ["__proto__"]: "p" });
    expect(Object.getPrototypeOf(parsed?.env)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed?.env, "__proto__")).toBe(true);

    expect(() =>
      readCodexMcpServer('[mcp_servers.causoryn]\ncommand = "node"\nenv = { N = 1 }\n'),
    ).toThrow(/env values must be TOML strings/);
  });

  it("upsertCodexMcpServer rewrites an existing env sub-table in place (position, comment, key order), so an unchanged entry is byte-identical", () => {
    const original = [
      "[mcp_servers.causoryn]",
      'command = "node"',
      'args = ["causoryn.mjs", "mcp", "--tool-profile", "wiki"]',
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.causoryn.tools.causoryn_map_system]",
      'approval_mode = "always_allow"',
      "",
      "# my env",
      "[mcp_servers.causoryn.env]",
      'ZED = "1"',
      'ALPHA = "2"',
      "",
    ].join("\n");
    const parsed = readCodexMcpServer(original);
    expect(parsed).not.toBeNull();
    const same = upsertCodexMcpServer(original, {
      command: "node",
      args: parsed?.args ?? [],
      startupTimeoutSec: 30,
      env: parsed?.env,
    });
    expect(same).toBe(original);

    const changed = upsertCodexMcpServer(original, {
      command: "/usr/bin/node",
      args: parsed?.args ?? [],
      env: { ...parsed?.env, NEW: "3" },
    });
    expect(changed).toContain('# my env\n[mcp_servers.causoryn.env]\nZED = "1"\nALPHA = "2"\nNEW = "3"\n');
    expect(changed.indexOf("[mcp_servers.causoryn.tools.causoryn_map_system]")).toBeLessThan(
      changed.indexOf("[mcp_servers.causoryn.env]"),
    );
    expect(changed.match(/\[mcp_servers\.causoryn\.env\]/g)).toHaveLength(1);
  });

  it("an explicit --tool-profile replaces the existing one (any spelling) but keeps --output-schema and env", async () => {
    const sb = createSandbox("override");
    for (const client of HOST_CLIENT_IDS) {
      writeCustomizedEntry(sb, client, {
        command: process.execPath,
        extraArgs: ["--tool-profile=full", "--output-schema", "full"],
        env: { KEEP_ME: "1" },
      });
    }
    const res = await runCliIn(sb, ["setup", "--all", "--no-skill", "--yes", "--tool-profile", "history"]);
    expect(res.exitCode).toBe(0);
    for (const client of HOST_CLIENT_IDS) {
      const entry = readEntry(sb, client);
      expect(entry.args, client).toEqual([
        ...baseArgs(sb, client),
        "--tool-profile",
        "history",
        "--output-schema",
        "full",
      ]);
      expect(entry.args.filter((a) => a.startsWith("--tool-profile")), client).toHaveLength(1);
      expect(entry.env, client).toEqual({ KEEP_ME: "1" });
    }
  });

  it("is idempotent with customizations: an up-to-date customized entry is not rewritten and gets no backup", async () => {
    const sb = createSandbox("idempotent");
    for (const client of HOST_CLIENT_IDS) {
      writeCustomizedEntry(sb, client, {
        command: process.execPath,
        extraArgs: ["--tool-profile", "wiki", "--output-schema", "full"],
        env: { FOO: "bar" },
      });
    }
    const before = new Map(
      HOST_CLIENT_IDS.map((client) => {
        const file = configPathFor(sb, client);
        return [client, { raw: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs }] as const;
      }),
    );

    // Without --tool-profile and with the same --tool-profile, the entry is already up to date.
    for (const argv of [
      ["setup", "--all", "--no-skill", "--yes"],
      ["setup", "--all", "--no-skill", "--yes", "--tool-profile", "wiki"],
    ]) {
      const res = await runCliIn(sb, argv);
      expect(res.exitCode, argv.join(" ")).toBe(0);
      expect(res.stdout, argv.join(" ")).toContain("NO CHANGES");
      for (const client of HOST_CLIENT_IDS) {
        const file = configPathFor(sb, client);
        expect(readFileSync(file, "utf8"), client).toBe(before.get(client)?.raw);
        expect(statSync(file).mtimeMs, client).toBe(before.get(client)?.mtimeMs);
        expect(listBackups(path.dirname(file)), client).toEqual([]);
      }
    }

    // Changing the profile writes once (with a backup); repeating it is a no-op again.
    const first = await runCliIn(sb, ["setup", "--all", "--no-skill", "--yes", "--tool-profile", "full"]);
    expect(first.stdout).toContain("APPLIED");
    const afterFirst = HOST_CLIENT_IDS.map((client) => readFileSync(configPathFor(sb, client), "utf8"));
    const second = await runSetup({
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: sb.pkgRoot,
      ephemeralTmpDir: path.join(sb.sandbox, "unused-tmp"),
      clients: [...HOST_CLIENT_IDS],
      installSkills: false,
      toolProfile: "full",
      yes: true,
    });
    expect(second.applied).toBe(false);
    expect(second.actions.every((a) => a.operation === "noop" && a.backupPath === null)).toBe(true);
    expect(HOST_CLIENT_IDS.map((client) => readFileSync(configPathFor(sb, client), "utf8"))).toEqual(
      afterFirst,
    );
  });

  it("rejects a non-object env on an existing JSON entry instead of silently dropping it", async () => {
    const sb = createSandbox("bad-env");
    writeFileSync(
      configPathFor(sb, "claude-code"),
      `${JSON.stringify({ mcpServers: { causoryn: { command: "node", args: [], env: ["A=1"] } } }, null, 2)}\n`,
      "utf8",
    );
    const before = readFileSync(configPathFor(sb, "claude-code"), "utf8");
    const res = await runCliIn(sb, ["setup", "--client", "claude-code", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mcpServers.causoryn.env");
    expect(readFileSync(configPathFor(sb, "claude-code"), "utf8")).toBe(before);
  });

  it("documents --tool-profile for setup in `causoryn --help`", async () => {
    const sb = createSandbox("help");
    const res = await runCliIn(sb, ["--help"]);
    expect(res.exitCode).toBe(0);
    const setupUsage = res.stdout.split("\n").find((line) => line.trim().startsWith("causoryn setup"));
    expect(setupUsage).toContain("--tool-profile");
    expect(res.stdout).toMatch(/--tool-profile <list>.*\n(?:.*\n)*?.*(existing|kept|keeps)/i);
  });
});

describe("causoryn setup --all-detected", () => {
  it("is documented in `causoryn --help` as an explicit alias of the default host detection", async () => {
    const sb = createSandbox("all-detected-help");
    const res = await runCliIn(sb, ["--help"]);
    expect(res.exitCode).toBe(0);
    const line = res.stdout.split("\n").find((l) => l.trim().startsWith("--all-detected"));
    expect(line).toBeDefined();
    expect(line).toMatch(/default/i);
  });

  it("behaves exactly like the default (no host flag), with and without detected hosts", async () => {
    // No host detected: both exit 1 with the same guidance and write nothing.
    const empty = createSandbox("all-detected-empty");
    const plain = await runCliIn(empty, ["setup", "--yes"]);
    const alias = await runCliIn(empty, ["setup", "--all-detected", "--yes"]);
    expect(plain.exitCode).toBe(1);
    expect(alias).toEqual(plain);
    expect(readdirSync(empty.home)).toEqual([]);

    // Two hosts detected (Claude Code + Codex): identical plans, then identical results.
    const make = (prefix: string): Sandbox => {
      const sb = createSandbox(prefix);
      writeFileSync(path.join(sb.home, ".claude.json"), "{}\n", "utf8");
      mkdirSync(sb.codexHome, { recursive: true });
      return sb;
    };
    const a = make("all-detected-a");
    const b = make("all-detected-b");
    const normalize = (text: string, sb: Sandbox): string =>
      text.split(sb.sandbox).join("<SANDBOX>").split(JSON.stringify(sb.sandbox).slice(1, -1)).join("<SANDBOX>");

    const planPlain = await runCliIn(a, ["setup", "--dry-run", "--json"]);
    const planAlias = await runCliIn(b, ["setup", "--all-detected", "--dry-run", "--json"]);
    expect(planPlain.exitCode).toBe(0);
    expect(planAlias.exitCode).toBe(0);
    expect(normalize(planAlias.stdout, b)).toBe(normalize(planPlain.stdout, a));
    const parsed = JSON.parse(planAlias.stdout) as { selectedClients: string[] };
    expect(parsed.selectedClients).toEqual(["claude-code", "codex"]);

    const applyPlain = await runCliIn(a, ["setup", "--yes"]);
    const applyAlias = await runCliIn(b, ["setup", "--all-detected", "--yes"]);
    expect(applyAlias.exitCode).toBe(applyPlain.exitCode);
    expect(normalize(applyAlias.stdout, b)).toBe(normalize(applyPlain.stdout, a));
    expect(existsSync(configPathFor(b, "antigravity"))).toBe(false);
    expect(existsSync(configPathFor(b, "zcode"))).toBe(false);
  });
});
