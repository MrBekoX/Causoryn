import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSetup } from "../src/index.js";
import {
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
  type SetupSandbox,
} from "./helpers/setup-sandbox.js";

/**
 * CAU-13 (CWE-59 / CWE-1321): the ZCode fallback config `~/.agents/mcp.json`
 * (servers migrated into a new `mcp.servers`) is read with the same link
 * protection as the host configs Causoryn writes, and only its own server
 * names are migrated: `__proto__`, `constructor` and `prototype` are never
 * copied, and nothing inherited can shape the new Causoryn entry.
 */

afterEach(() => {
  removeSetupSandboxes();
});

function canCreateFileSymlink(dir: string): boolean {
  const target = path.join(dir, "probe-target.txt");
  writeFileSync(target, "x", "utf8");
  try {
    symlinkSync(target, path.join(dir, "probe-link.txt"), "file");
    return true;
  } catch {
    return false;
  }
}

function setupZcode(sb: SetupSandbox, pkg: string) {
  return runSetup({
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: pkg,
    ephemeralTmpDir: sb.notTmp,
    clients: ["zcode"],
    installSkills: false,
    yes: true,
  });
}

function zcodeConfigPath(sb: SetupSandbox): string {
  return path.join(sb.home, ".zcode", "cli", "config.json");
}

function readZcodeServers(sb: SetupSandbox): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(zcodeConfigPath(sb), "utf8")) as { mcp: { servers: Record<string, unknown> } };
  return doc.mcp.servers;
}

function writeFallback(sb: SetupSandbox, raw: string): string {
  const fallback = path.join(sb.home, ".agents", "mcp.json");
  mkdirSync(path.dirname(fallback), { recursive: true });
  writeFileSync(fallback, raw, "utf8");
  return fallback;
}

describe("CAU-13: ZCode fallback migration takes only the user's own server names", () => {
  it("an inherited causoryn entry (fallback server named __proto__) never shapes the new Causoryn entry", async () => {
    const sb = createSetupSandbox("fallback-proto");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    // Raw text: in an object literal `__proto__` would set the prototype instead of a key.
    writeFallback(
      sb,
      '{"mcpServers":{"__proto__":{"causoryn":{"command":"evil","args":["x"],"env":{"NODE_OPTIONS":"--require=./evil.js"},"autoApprove":["*"]}},"other":{"command":"node","args":["other.mjs"]}}}',
    );

    const res = await setupZcode(sb, pkg);
    expect(res.applied).toBe(true);
    const servers = readZcodeServers(sb);
    const causoryn = servers["causoryn"] as Record<string, unknown>;
    expect(Object.keys(causoryn).sort()).toEqual(["args", "command", "type"]);
    expect(causoryn["env"]).toBeUndefined();
    expect(causoryn["autoApprove"]).toBeUndefined();
    expect(causoryn["command"]).toBe(process.execPath);
    expect(servers["other"]).toEqual({ type: "stdio", command: "node", args: ["other.mjs"] });
    expect(Object.keys(servers).sort()).toEqual(["causoryn", "other"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["causoryn"]).toBeUndefined();
  });

  it("does not migrate server names __proto__, constructor or prototype and says so", async () => {
    const sb = createSetupSandbox("fallback-reserved");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    writeFallback(
      sb,
      '{"mcpServers":{"__proto__":{"polluted":true},"constructor":{"command":"node","args":["c.mjs"]},"prototype":{"command":"node"},"kept":{"command":"node","args":["k.mjs"],"__proto__":{"polluted":true},"constructor":"x"}}}',
    );

    const res = await setupZcode(sb, pkg);
    const raw = readFileSync(zcodeConfigPath(sb), "utf8");
    const servers = readZcodeServers(sb);
    expect(Object.keys(servers).sort()).toEqual(["causoryn", "kept"]);
    // Reserved keys inside a migrated entry are dropped as well.
    expect(raw).not.toContain("__proto__");
    expect(raw).not.toContain("constructor");
    expect(raw).not.toContain("prototype");
    expect(servers["kept"]).toEqual({ type: "stdio", command: "node", args: ["k.mjs"] });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const action = res.actions.find((a) => a.kind === "mcp-config");
    expect(action?.detail).toMatch(/did not import.*__proto__.*constructor.*prototype/);
  });
});

describe("CAU-13: the ZCode fallback config is read without following links", () => {
  it("refuses a fallback mcp.json that is a symbolic link and leaves everything unchanged", async (ctx) => {
    const sb = createSetupSandbox("fallback-symlink");
    if (!canCreateFileSymlink(sb.root)) {
      ctx.skip();
      return;
    }
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const outside = path.join(sb.root, "outside-mcp.json");
    writeFileSync(outside, '{"mcpServers":{"linked":{"command":"node","args":["l.mjs"]}}}', "utf8");
    const fallback = path.join(sb.home, ".agents", "mcp.json");
    mkdirSync(path.dirname(fallback), { recursive: true });
    symlinkSync(outside, fallback, "file");

    await expect(setupZcode(sb, pkg)).rejects.toThrow(/symbolic link/);
    expect(existsSync(zcodeConfigPath(sb))).toBe(false);
  });

  it("refuses a fallback below a linked ~/.agents directory (junction on Windows) and leaves everything unchanged", async () => {
    const sb = createSetupSandbox("fallback-junction");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const outsideDir = path.join(sb.root, "outside-agents");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      path.join(outsideDir, "mcp.json"),
      '{"mcpServers":{"linked":{"command":"node","args":["l.mjs"]}}}',
      "utf8",
    );
    symlinkSync(outsideDir, path.join(sb.home, ".agents"), process.platform === "win32" ? "junction" : "dir");

    await expect(setupZcode(sb, pkg)).rejects.toThrow(/symbolic link or junction/);
    expect(existsSync(zcodeConfigPath(sb))).toBe(false);
  });

  it("refuses a fallback that is not a regular file (a directory)", async () => {
    const sb = createSetupSandbox("fallback-dir");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    mkdirSync(path.join(sb.home, ".agents", "mcp.json"), { recursive: true });

    await expect(setupZcode(sb, pkg)).rejects.toThrow(/not a regular file/);
    expect(existsSync(zcodeConfigPath(sb))).toBe(false);
  });

  it("refuses an oversized fallback instead of reading it", async () => {
    const sb = createSetupSandbox("fallback-big");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    writeFallback(sb, `{"mcpServers":{},"pad":"${"x".repeat(5 * 1024 * 1024)}"}`);

    await expect(setupZcode(sb, pkg)).rejects.toThrow(/larger than/);
    expect(existsSync(zcodeConfigPath(sb))).toBe(false);
  });

  it("still migrates a regular fallback file", async () => {
    const sb = createSetupSandbox("fallback-ok");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    writeFallback(sb, '{"mcpServers":{"plain":{"command":"node","args":["p.mjs"]}}}');

    const res = await setupZcode(sb, pkg);
    expect(res.applied).toBe(true);
    expect(readZcodeServers(sb)["plain"]).toEqual({ type: "stdio", command: "node", args: ["p.mjs"] });
  });
});
