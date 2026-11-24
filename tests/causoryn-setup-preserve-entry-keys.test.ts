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
  readCodexMcpServer,
  runCli,
  runSetup,
  validateTomlStructure,
  type HostClientId,
} from "../packages/causoryn/src/index.js";

/**
 * Re-running `causoryn setup` must keep every key of an existing Causoryn entry
 * that Causoryn does not own: JSON host keys such as `disabled`, `autoApprove`,
 * `alwaysAllow`, `timeout` or any unknown key (in their original order), and in
 * Codex TOML every unknown key of `[mcp_servers.causoryn]` plus a user-set
 * `startup_timeout_sec` (raised only when it is below Causoryn's minimum, which
 * the setup output then reports). An up-to-date entry is still a no-op.
 */

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-setup-keys-${prefix}-`));
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
  const pkgRoot = path.join(sandbox, "pkg");
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
  return {
    sandbox,
    home,
    codexHome: path.join(home, ".codex"),
    pkgRoot,
    cliScript: path.join(pkgRoot, "scripts", "causoryn.mjs"),
  };
}

type JsonHost = Exclude<HostClientId, "codex">;
const JSON_HOSTS: readonly JsonHost[] = ["antigravity", "claude-code", "zcode"];

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

function baseArgs(sb: Sandbox, client: HostClientId): string[] {
  return [sb.cliScript, "mcp", "--allow-cwd", "--auto-data-dir", "--client", client];
}

function wrapJsonEntry(client: JsonHost, entryJson: string): string {
  return client === "zcode"
    ? `{\n  "theme": "dark",\n  "mcp": {\n    "servers": {\n      "causoryn": ${entryJson}\n    }\n  }\n}\n`
    : `{\n  "userKey": 1,\n  "mcpServers": {\n    "causoryn": ${entryJson}\n  }\n}\n`;
}

/** Raw entry (written as text so the `__proto__` key stays an own JSON key). */
function userJsonEntry(sb: Sandbox, client: JsonHost, command: string): string {
  const args = JSON.stringify([...baseArgs(sb, client), "--tool-profile", "wiki"]);
  const typeLine = client === "antigravity" ? "" : `"type": "stdio", `;
  return [
    "{",
    `"disabled": false, ${typeLine}"command": ${JSON.stringify(command)},`,
    `"autoApprove": ["causoryn_map_system"], "args": ${args},`,
    `"alwaysAllow": ["causoryn_preflight_change"], "timeout": 120000,`,
    `"env": { "FOO": "bar" }, "x-custom": { "nested": [1, { "deep": true }] }, "__proto__": { "kept": 1 }`,
    "}",
  ].join(" ");
}

function readJsonEntry(sb: Sandbox, client: JsonHost): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(configPathFor(sb, client), "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
    mcp?: { servers?: Record<string, Record<string, unknown>> };
  };
  const entry = client === "zcode" ? doc.mcp?.servers?.["causoryn"] : doc.mcpServers?.["causoryn"];
  if (entry === undefined) throw new Error(`no causoryn entry for ${client}`);
  return entry;
}

function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes(".causoryn.") && f.endsWith(".backup"));
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

function setupAll(sb: Sandbox, clients: readonly HostClientId[]) {
  return runSetup({
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: sb.pkgRoot,
    ephemeralTmpDir: path.join(sb.sandbox, "unused-tmp"),
    clients: [...clients],
    installSkills: false,
    yes: true,
  });
}

describe("causoryn setup keeps the keys Causoryn does not own (JSON hosts)", () => {
  it.each(JSON_HOSTS)(
    "%s: keeps disabled/autoApprove/alwaysAllow/timeout/env/unknown keys in their order while updating command and args",
    async (client) => {
      const sb = createSandbox(`json-${client}`);
      const target = configPathFor(sb, client);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, wrapJsonEntry(client, userJsonEntry(sb, client, "/opt/old-node/bin/node")), "utf8");
      const keyOrderBefore = Object.keys(readJsonEntry(sb, client));

      const result = await setupAll(sb, [client]);
      expect(result.applied).toBe(true);

      const entry = readJsonEntry(sb, client);
      expect(Object.keys(entry)).toEqual(keyOrderBefore);
      expect(entry["command"]).toBe(process.execPath);
      expect(entry["args"]).toEqual([...baseArgs(sb, client), "--tool-profile", "wiki"]);
      expect(entry["disabled"]).toBe(false);
      expect(entry["autoApprove"]).toEqual(["causoryn_map_system"]);
      expect(entry["alwaysAllow"]).toEqual(["causoryn_preflight_change"]);
      expect(entry["timeout"]).toBe(120000);
      expect(entry["env"]).toEqual({ FOO: "bar" });
      expect(entry["x-custom"]).toEqual({ nested: [1, { deep: true }] });
      expect(Object.prototype.hasOwnProperty.call(entry, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
      if (client === "antigravity") {
        expect(entry["type"]).toBeUndefined();
      } else {
        expect(entry["type"]).toBe("stdio");
      }

      // Unrelated content of the host file is untouched.
      const doc = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
      expect(client === "zcode" ? doc["theme"] : doc["userKey"]).toBe(client === "zcode" ? "dark" : 1);

      // Re-running is a no-op: no write, no backup, identical bytes and mtime.
      const backupsBefore = listBackups(path.dirname(target));
      const raw = readFileSync(target, "utf8");
      const mtimeMs = statSync(target).mtimeMs;
      const again = await setupAll(sb, [client]);
      expect(again.applied).toBe(false);
      expect(again.actions.every((a) => a.operation === "noop" && a.backupPath === null)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(raw);
      expect(statSync(target).mtimeMs).toBe(mtimeMs);
      expect(listBackups(path.dirname(target))).toEqual(backupsBefore);
    },
  );

  it("an entry that is already up to date and carries user keys is not rewritten (no backup)", async () => {
    const sb = createSandbox("json-noop");
    for (const client of JSON_HOSTS) {
      const target = configPathFor(sb, client);
      mkdirSync(path.dirname(target), { recursive: true });
      const entry = userJsonEntry(sb, client, process.execPath);
      // Byte-identical to what the JSON writer produces for this document.
      const pretty = `${JSON.stringify(JSON.parse(wrapJsonEntry(client, entry)), null, 2)}\n`;
      writeFileSync(target, pretty, "utf8");
    }
    const before = new Map(
      JSON_HOSTS.map((client) => {
        const file = configPathFor(sb, client);
        return [client, { raw: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs }] as const;
      }),
    );
    const res = await runCliIn(sb, ["setup", "--client", JSON_HOSTS.join(","), "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("NO CHANGES");
    for (const client of JSON_HOSTS) {
      const file = configPathFor(sb, client);
      expect(readFileSync(file, "utf8"), client).toBe(before.get(client)?.raw);
      expect(statSync(file).mtimeMs, client).toBe(before.get(client)?.mtimeMs);
      expect(listBackups(path.dirname(file)), client).toEqual([]);
    }
  });

  it("claude-code / zcode: a user-changed `type` is owned by Causoryn and reset to stdio in place", async () => {
    const sb = createSandbox("json-type");
    for (const client of ["claude-code", "zcode"] as const) {
      const target = configPathFor(sb, client);
      mkdirSync(path.dirname(target), { recursive: true });
      const args = JSON.stringify(baseArgs(sb, client));
      writeFileSync(
        target,
        wrapJsonEntry(
          client,
          `{ "command": ${JSON.stringify(process.execPath)}, "type": "sse", "args": ${args}, "disabled": true }`,
        ),
        "utf8",
      );
    }
    await setupAll(sb, ["claude-code", "zcode"]);
    for (const client of ["claude-code", "zcode"] as const) {
      const entry = readJsonEntry(sb, client);
      expect(Object.keys(entry), client).toEqual(["command", "type", "args", "disabled"]);
      expect(entry["type"], client).toBe("stdio");
      expect(entry["disabled"], client).toBe(true);
    }
  });
});

function writeCodexConfig(sb: Sandbox, lines: readonly string[]): string {
  const target = configPathFor(sb, "codex");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  return target;
}

function q(value: string): string {
  return JSON.stringify(value);
}

describe("causoryn setup keeps the keys Causoryn does not own (Codex TOML)", () => {
  it("keeps unknown keys, comments and a user-set startup_timeout_sec of [mcp_servers.causoryn] verbatim, then is idempotent", async () => {
    const sb = createSandbox("codex-keys");
    const args = [...baseArgs(sb, "codex"), "--output-schema", "full"];
    const target = writeCodexConfig(sb, [
      'model = "gpt-5"',
      "",
      "[mcp_servers.causoryn]",
      "enabled = false # paused by me",
      `command = ${q("/opt/old-node/bin/node")}`,
      "# my note about this server",
      `args = [${args.map(q).join(", ")}]`,
      "startup_timeout_sec = 120",
      "tool_timeout_sec = 90",
      "enabled_tools = [",
      '  "causoryn_map_system",',
      '  "causoryn_preflight_change",',
      "]",
      "custom_unknown_key = { a = 1, b = 'two' }",
      "",
      "[mcp_servers.causoryn.env]",
      'FOO = "bar"',
    ]);

    const res = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("APPLIED");

    const raw = readFileSync(target, "utf8");
    expect(() => validateTomlStructure(raw)).not.toThrow();
    expect(raw).toBe(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.causoryn]",
        "enabled = false # paused by me",
        `command = ${q(process.execPath)}`,
        "# my note about this server",
        `args = [${args.map(q).join(", ")}]`,
        "startup_timeout_sec = 120",
        "tool_timeout_sec = 90",
        "enabled_tools = [",
        '  "causoryn_map_system",',
        '  "causoryn_preflight_change",',
        "]",
        "custom_unknown_key = { a = 1, b = 'two' }",
        "",
        "[mcp_servers.causoryn.env]",
        'FOO = "bar"',
        "",
      ].join("\n"),
    );
    const parsed = readCodexMcpServer(raw);
    expect(parsed?.command).toBe(process.execPath);
    expect(parsed?.args).toEqual(args);
    expect(parsed?.startupTimeoutSec).toBe(120);
    expect(parsed?.env).toEqual({ FOO: "bar" });

    // Re-running: no write, no extra backup.
    const backups = listBackups(sb.codexHome);
    const mtimeMs = statSync(target).mtimeMs;
    const again = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("NO CHANGES");
    expect(readFileSync(target, "utf8")).toBe(raw);
    expect(statSync(target).mtimeMs).toBe(mtimeMs);
    expect(listBackups(sb.codexHome)).toEqual(backups);
  });

  it("an up-to-date table with user keys and a higher startup_timeout_sec is a no-op (no backup)", async () => {
    const sb = createSandbox("codex-noop");
    const target = writeCodexConfig(sb, [
      "[mcp_servers.causoryn]",
      `command = ${q(process.execPath)}`,
      `args = [${baseArgs(sb, "codex").map(q).join(", ")}]`,
      "startup_timeout_sec = 45.5",
      "enabled = true",
    ]);
    const raw = readFileSync(target, "utf8");
    const mtimeMs = statSync(target).mtimeMs;
    const result = await setupAll(sb, ["codex"]);
    expect(result.applied).toBe(false);
    expect(result.actions.every((a) => a.operation === "noop" && a.backupPath === null)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(raw);
    expect(statSync(target).mtimeMs).toBe(mtimeMs);
    expect(listBackups(sb.codexHome)).toEqual([]);
  });

  it("raises a startup_timeout_sec below the minimum to 30 in place and says so in the setup output", async () => {
    const sb = createSandbox("codex-low-timeout");
    const target = writeCodexConfig(sb, [
      "[mcp_servers.causoryn]",
      `command = ${q(process.execPath)}`,
      `args = [${baseArgs(sb, "codex").map(q).join(", ")}]`,
      "startup_timeout_sec = 10",
      "enabled = true",
    ]);
    const res = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/raised startup_timeout_sec from 10 to the required minimum of 30/);
    expect(res.stdout).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    const raw = readFileSync(target, "utf8");
    expect(raw).toBe(
      [
        "[mcp_servers.causoryn]",
        `command = ${q(process.execPath)}`,
        `args = [${baseArgs(sb, "codex").map(q).join(", ")}]`,
        "startup_timeout_sec = 30",
        "enabled = true",
        "",
      ].join("\n"),
    );

    const again = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(again.stdout).toContain("NO CHANGES");
    expect(readFileSync(target, "utf8")).toBe(raw);
  });

  it("replaces an unusable startup_timeout_sec value with 30 and says so; a missing one is added after the owned keys", async () => {
    const sb = createSandbox("codex-bad-timeout");
    const target = writeCodexConfig(sb, [
      "[mcp_servers.causoryn]",
      `command = ${q(process.execPath)}`,
      'startup_timeout_sec = "soon"',
      `args = [${baseArgs(sb, "codex").map(q).join(", ")}]`,
    ]);
    const res = await runCliIn(sb, ["setup", "--client", "codex", "--no-skill", "--yes"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/replaced the unusable startup_timeout_sec value "soon" with 30/);
    expect(readCodexMcpServer(readFileSync(target, "utf8"))?.startupTimeoutSec).toBe(30);
    expect(readFileSync(target, "utf8")).toContain('command = ' + q(process.execPath) + '\nstartup_timeout_sec = 30\nargs = [');

    const sb2 = createSandbox("codex-missing-timeout");
    const target2 = writeCodexConfig(sb2, [
      "[mcp_servers.causoryn]",
      "enabled = true",
      `command = ${q("/old/node")}`,
      `args = [${baseArgs(sb2, "codex").map(q).join(", ")}]`,
      "tool_timeout_sec = 60",
    ]);
    await setupAll(sb2, ["codex"]);
    expect(readFileSync(target2, "utf8")).toBe(
      [
        "[mcp_servers.causoryn]",
        "enabled = true",
        `command = ${q(process.execPath)}`,
        `args = [${baseArgs(sb2, "codex").map(q).join(", ")}]`,
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 60",
        "",
      ].join("\n"),
    );
  });

  it("treats quoted spellings of owned keys as owned (no duplicate keys; an unchanged owned value keeps its spelling)", async () => {
    const sb = createSandbox("codex-quoted-keys");
    const argsLine = `'args' = [${[...baseArgs(sb, "codex"), "--tool-profile", "history"].map(q).join(", ")}]`;
    const target = writeCodexConfig(sb, [
      "[mcp_servers.causoryn]",
      `"command" = ${q("/old/node")}`,
      argsLine,
      '"startup_timeout_sec" = 60',
      '"enabled" = true',
    ]);
    await setupAll(sb, ["codex"]);
    const raw = readFileSync(target, "utf8");
    expect(raw).toBe(
      [
        "[mcp_servers.causoryn]",
        `command = ${q(process.execPath)}`,
        argsLine,
        '"startup_timeout_sec" = 60',
        '"enabled" = true',
        "",
      ].join("\n"),
    );
    const parsed = readCodexMcpServer(raw);
    expect(parsed?.args).toEqual([...baseArgs(sb, "codex"), "--tool-profile", "history"]);
    expect(parsed?.startupTimeoutSec).toBe(60);
  });
});
