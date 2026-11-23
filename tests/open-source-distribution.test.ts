import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
} from "@causoryn/mcp-server";

/**
 * K-021 Açık Kaynak Çoklu-Host Dağıtım Sözleşme ve Uçtan Uca Paket Testi.
 *
 * Kapsam:
 * 1. Kanonik `skills/{causoryn,map-system,preflight-change,verify-change}/SKILL.md`
 *    YAML frontmatter + ADR-010 `TOOL_NAMES` dürüstlüğü + `map-system` derin sözleşmesi.
 * 2. Repo kökü (7 manifest) + `packages/causoryn` paket içi (6 manifest) 4-host
 *    pazaryeri şemaları, `0.1.0` sürüm eşliği ve sıfır kimlik-bilgisi kalıbı.
 * 3. `packages/causoryn/README.md`: 29 `TOOL_NAMES`, 21 hata kodu (15 aktif
 *    `CAUSORYN_TOOL_ERROR_CODES` + 6 TŞ §10.1 rezerve kod), `Node.js >= 24`,
 *    salt-okunur garanti, 4 host (`Antigravity`, `Claude Code`, `Codex`,
 *    `ZCode (GLM)`) için hem `npx causoryn setup` hem yerel pazaryeri kurulumu.
 * 4. `build-package.mjs` sahneleme bütünlüğü + gerçek `npm pack` `.tgz` arşivinden
 *    izole `os.tmpdir()` dizininde `setup`, `doctor --json`, `plugin-mcp-launcher.mjs`
 *    ve `causoryn.mjs mcp` saf JSON-RPC `stdio` el sıkışması.
 */

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_DIR = path.join(REPO_ROOT, "packages", "causoryn");
const MCP_SERVER_BUNDLE = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "mcp-server.mjs");

const DOLLAR_BRACE = "$" + "{";
const CLAUDE_PLUGIN_ROOT_TOKEN = DOLLAR_BRACE + "CLAUDE_PLUGIN_ROOT}";
const ZCODE_PLUGIN_ROOT_TOKEN = DOLLAR_BRACE + "ZCODE_PLUGIN_ROOT}";
const ZCODE_PROJECT_DIR_TOKEN = DOLLAR_BRACE + "ZCODE_PROJECT_DIR}";

const CREDENTIAL_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

const BACKTICK_CAUSORYN_TOOL = /`(causoryn_[a-z0-9_]+)`/g;

const ALL_21_ERROR_CODES: readonly string[] = [
  ...CAUSORYN_TOOL_ERROR_CODES,
  "UNRESOLVED_FLOW",
  "STALE_PREFLIGHT",
  "CANCELLED",
  "WIKI_REVISION_NOT_AVAILABLE",
  "WIKI_BROKEN_LINK",
  "WIKI_NOTE_CONFLICT",
];

const ALLOWED_ANTIGRAVITY_PLUGIN_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "logo",
  "suggestedPrompts",
  "displayName",
  "version",
  "author",
  "homepage",
  "repository",
  "disabled",
]);

const EXPECTED_SKILLS = [
  "causoryn",
  "map-system",
  "preflight-change",
  "verify-change",
  "architecture-blueprint",
] as const;

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-dist-${prefix}-`));
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

function readJsonObject(absPath: string): Record<string, unknown> {
  expect(existsSync(absPath), `eksik JSON dosyası: ${absPath}`).toBe(true);
  const raw = readFileSync(absPath, "utf8");
  expect(
    CREDENTIAL_PATTERN.test(raw),
    `manifest yasaklı kimlik bilgisi kalıbı içeriyor: ${absPath}`,
  ).toBe(false);
  const parsed: unknown = JSON.parse(raw);
  expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
  return parsed as Record<string, unknown>;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isCausorynPackageAlreadyStaged(): boolean {
  const srcManifestPath = path.join(
    REPO_ROOT,
    "packages",
    "mcp-server",
    "dist",
    "bundle-manifest.json",
  );
  const stagedBundlePath = path.join(PKG_DIR, "dist", "mcp-server.mjs");
  const stagedManifestPath = path.join(PKG_DIR, "dist", "bundle-manifest.json");
  const requiredPaths = [
    srcManifestPath,
    stagedBundlePath,
    stagedManifestPath,
    path.join(PKG_DIR, "dist", "mcp-server.mjs.LEGAL.txt"),
    path.join(PKG_DIR, "dist", "node_modules", "better-sqlite3", "package.json"),
    path.join(PKG_DIR, "dist", "node_modules", "better-sqlite3", "LICENSE"),
    path.join(PKG_DIR, "dist", "typescript-lib", "lib.es2022.full.d.ts"),
    path.join(PKG_DIR, "native", "python-worker", "worker.py"),
    path.join(PKG_DIR, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
    path.join(PKG_DIR, "native", "roslyn-worker", "Microsoft.CodeAnalysis.CSharp.dll"),
    path.join(PKG_DIR, "skills", "causoryn", "SKILL.md"),
    path.join(PKG_DIR, "LICENSE"),
    path.join(PKG_DIR, "THIRD-PARTY-NOTICES.md"),
    path.join(PKG_DIR, "licenses", "Apache-2.0.txt"),
    path.join(PKG_DIR, "licenses", "TypeScript-ThirdPartyNoticeText.txt"),
    path.join(PKG_DIR, "licenses", "better-sqlite3-LICENSE.txt"),
  ];
  for (const req of requiredPaths) {
    if (!existsSync(req)) {
      return false;
    }
  }
  try {
    const srcManifest = JSON.parse(readFileSync(srcManifestPath, "utf8")) as {
      files?: Record<string, string>;
    };
    const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8")) as {
      files?: Record<string, string>;
    };
    const expectedSqlitePkgSha = srcManifest.files?.["node_modules/better-sqlite3/package.json"];
    const stagedBundleSha = stagedManifest.files?.["mcp-server.mjs"];
    if (
      typeof expectedSqlitePkgSha !== "string" ||
      typeof stagedBundleSha !== "string" ||
      stagedBundleSha.length !== 64
    ) {
      return false;
    }
    if (
      stagedManifest.files?.["node_modules/better-sqlite3/package.json"] !== expectedSqlitePkgSha
    ) {
      return false;
    }
    return sha256File(stagedBundlePath) === stagedBundleSha.toLowerCase();
  } catch {
    return false;
  }
}

function ensureCausorynPackageStaged(): void {
  if (isCausorynPackageAlreadyStaged()) {
    return;
  }
  execFileSync(process.execPath, [path.join(PKG_DIR, "scripts", "build-package.mjs")], {
    cwd: PKG_DIR,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listAllFilesRelative(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(rootDir);
  return results.sort();
}

function snapshotDirectoryState(rootDir: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        entries.push(`d:${rel}`);
        walk(full);
      } else if (entry.isFile()) {
        entries.push(`f:${rel}:${sha256File(full)}`);
      }
    }
  };
  walk(rootDir);
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function packAndUnpackCausorynTarball(sandbox: string): string {
  ensureCausorynPackageStaged();
  const packDest = path.join(sandbox, "pack-out");
  const unpackRoot = path.join(sandbox, "unpacked");
  mkdirSync(packDest, { recursive: true });
  mkdirSync(unpackRoot, { recursive: true });

  const bundledNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const packCommand = existsSync(bundledNpmCli) ? process.execPath : "npm";
  const packArgs = existsSync(bundledNpmCli)
    ? [bundledNpmCli, "pack", "--pack-destination", packDest]
    : ["pack", "--pack-destination", packDest];
  const packStdout = execFileSync(packCommand, packArgs, {
    cwd: PKG_DIR,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tgzName = packStdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".tgz"))
    .pop();
  expect(tgzName).toBeDefined();

  const tgzPath = path.join(packDest, tgzName ?? `causoryn-${SERVER_VERSION}.tgz`);
  execFileSync("tar", ["-xzf", tgzPath, "-C", unpackRoot], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return path.join(unpackRoot, "package");
}

interface JsonRpcLine {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

async function runStdioSequence(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  requests: ReadonlyArray<Record<string, unknown>>,
): Promise<{
  readonly stdoutLines: readonly string[];
  readonly responses: ReadonlyMap<number, JsonRpcLine>;
}> {
  const child: ChildProcess = spawn(command, [...args], {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  const responses = new Map<number, JsonRpcLine>();
  const waiters = new Map<number, (msg: JsonRpcLine) => void>();

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  child.stdout?.setEncoding("utf8");
  let buffer = "";
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.length === 0) continue;
      stdoutLines.push(line);
      const parsed = JSON.parse(line) as JsonRpcLine;
      if (typeof parsed.id === "number") {
        responses.set(parsed.id, parsed);
        if (waiters.has(parsed.id)) {
          waiters.get(parsed.id)?.(parsed);
          waiters.delete(parsed.id);
        }
      }
    }
  });

  const closePromise = new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });

  const pendingById = new Map<number, Promise<JsonRpcLine>>();
  const waitForId = (id: number): Promise<JsonRpcLine> => {
    const cached = pendingById.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const existing = responses.get(id);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const promise = new Promise<JsonRpcLine>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `JSON-RPC id=${String(id)} zaman aşımı. stderr=${stderrChunks.join("")}`,
          ),
        );
      }, 30_000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    pendingById.set(id, promise);
    return promise;
  };

  try {
    const expectedIds = requests
      .map((req) => req["id"])
      .filter((id): id is number => typeof id === "number");
    const responsePromises = expectedIds.map((id) => waitForId(id));

    for (const req of requests) {
      child.stdin?.write(`${JSON.stringify(req)}\n`);
      if (req["method"] === "initialize" && typeof req["id"] === "number") {
        await waitForId(req["id"]);
      }
    }

    await Promise.all(responsePromises);
    child.stdin?.end();
    await closePromise;
    return { stdoutLines, responses };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function runStdioHandshake(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly stdoutLines: readonly string[];
  readonly responses: ReadonlyMap<number, JsonRpcLine>;
}> {
  return runStdioSequence(command, args, cwd, env, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "causoryn-dist-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "causoryn_get_capabilities", arguments: {} },
    },
  ]);
}

describe("1. Canonical skills/ (YAML frontmatter + ADR-010 tool honesty)", () => {
  const knownTools = new Set<string>(TOOL_NAMES);

  it("ships all 5 canonical skills with valid frontmatter and strictly real published tools", () => {
    for (const skillName of EXPECTED_SKILLS) {
      const skillPath = path.join(REPO_ROOT, "skills", skillName, "SKILL.md");
      expect(existsSync(skillPath), `eksik skill: ${skillPath}`).toBe(true);
      const content = readFileSync(skillPath, "utf8");
      expect(content.startsWith("---\n") || content.startsWith("---\r\n")).toBe(true);
      const closingIdx = content.indexOf("\n---", 3);
      expect(closingIdx).toBeGreaterThan(3);

      const frontmatter = content.slice(3, closingIdx);
      expect(new RegExp(`^name:\\s*${skillName}\\s*$`, "m").test(frontmatter)).toBe(true);
      expect(/^description:\s*\S+/m.test(frontmatter)).toBe(true);

      const referencedTools = [...content.matchAll(BACKTICK_CAUSORYN_TOOL)].map(
        (m) => m[1] ?? "",
      );
      expect(referencedTools.length).toBeGreaterThan(0);
      for (const tool of referencedTools) {
        expect(knownTools.has(tool), `${skillName}/SKILL.md sahte araç anıyor: ${tool}`).toBe(
          true,
        );
      }
    }
  });

  it("preserves full argument, envelope, L4, and error-code contract in skills/map-system/SKILL.md", () => {
    const mapSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "map-system", "SKILL.md"),
      "utf8",
    );
    const requiredTokens = [
      "causoryn_map_system",
      "level",
      "filters",
      "maxNodes",
      "cursor",
      "L4",
      "nextCursor",
      "status",
      "WORKSPACE_NOT_AUTHORIZED",
      "INDEX_NOT_READY",
      "INVALID_ARGUMENT",
      "LIMIT_EXCEEDED",
    ];
    for (const required of requiredTokens) {
      expect(mapSkill, `map-system eksik terim: ${required}`).toContain(required);
    }
  });

  it("preserves Host-LLM visual architecture synthesis protocol in skills/architecture-blueprint/SKILL.md", () => {
    const blueprintSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "architecture-blueprint", "SKILL.md"),
      "utf8",
    );
    const requiredTokens = [
      "causoryn_workspace_summary",
      "causoryn_map_system",
      "causoryn_generate_onboarding",
      "causoryn_export_documentation",
      "architectureSummary.moduleIds",
      "annotations",
      "interactive",
      "EXPORT_NOT_ALLOWED",
      "INVALID_ARGUMENT",
    ];
    for (const required of requiredTokens) {
      expect(blueprintSkill, `architecture-blueprint eksik terim: ${required}`).toContain(required);
    }
  });

  it("exposes bilingual natural-language triggers and Host-LLM non-refusal guidance without requiring users to name skills (K-026)", () => {
    const blueprintSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "architecture-blueprint", "SKILL.md"),
      "utf8",
    );
    const bpEnd = blueprintSkill.indexOf("\n---", 3);
    expect(bpEnd).toBeGreaterThan(3);
    const bpFrontmatter = blueprintSkill.slice(3, bpEnd);

    for (const trigger of [
      "architecture diagram",
      "interactive architecture portal",
      "system blueprint",
      "visual onboarding guide",
      "mimari diyagram",
      "görsel mimari harita",
      "etkileşimli mimari portal",
      "sistem haritası",
    ]) {
      expect(
        bpFrontmatter.toLowerCase(),
        `architecture-blueprint frontmatter eksik doğal dil tetikleyicisi: ${trigger}`,
      ).toContain(trigger.toLowerCase());
    }
    expect(blueprintSkill).toMatch(/Never refuse because Causoryn is LLM-free/i);
    expect(blueprintSkill).toMatch(/YOU are the host LLM/i);
    expect(blueprintSkill).toContain("causoryn-architecture-interactive.html");
    expect(blueprintSkill).toContain("<slug>-<hash12>/exports");
    expect(blueprintSkill).not.toMatch(/call `causoryn_get_capabilities` if unsure/i);
    expect(blueprintSkill).toMatch(/keyFiles[^\n]*belonging to that module/i);

    const causorynSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "causoryn", "SKILL.md"),
      "utf8",
    );
    const cEnd = causorynSkill.indexOf("\n---", 3);
    expect(cEnd).toBeGreaterThan(3);
    const cFrontmatter = causorynSkill.slice(3, cEnd);
    expect(cFrontmatter).toMatch(/architecture diagram|interactive architecture portal|visual architecture/i);
    expect(causorynSkill).toContain("architecture-blueprint");
    expect(causorynSkill).toContain("causoryn-architecture-interactive.html");
    expect(causorynSkill).toContain("deferAutoIndex");
    expect(causorynSkill).toMatch(/tsconfig|jsconfig/i);
    expect(causorynSkill).toContain("nextCursor, error");

    const mapSkill = readFileSync(
      path.join(REPO_ROOT, "skills", "map-system", "SKILL.md"),
      "utf8",
    );
    expect(mapSkill).toMatch(/L3[^\n]*Test/);
    expect(mapSkill).toContain("nextCursor, error");

    const zcodeMapSkill = readFileSync(
      path.join(REPO_ROOT, "integrations", "zcode", "causoryn", "skills", "map-system", "SKILL.md"),
      "utf8",
    );
    expect(zcodeMapSkill).not.toContain("Faz A");
    expect(zcodeMapSkill).toContain("architecture-blueprint");
    expect(zcodeMapSkill).toContain("causoryn_trace_execution");
    expect(zcodeMapSkill).toMatch(/L3[^\n]*Test/);
    expect(zcodeMapSkill).toContain("nextCursor, error");
  });
});

describe("2. Repo-root & packages/causoryn 4-host manifests (0.2.4 parity + zero credentials)", () => {
  it("validates ZCode, Claude Code, Codex, Antigravity, and MCP Registry root manifests", () => {
    expect(SERVER_VERSION).toBe("0.2.4");

    const pkgJson = readJsonObject(path.join(PKG_DIR, "package.json"));
    expect(pkgJson["version"]).toBe("0.2.4");

    const zcodeMkt = readJsonObject(path.join(REPO_ROOT, "marketplace.json"));
    expect(zcodeMkt["name"]).toBe("causoryn");
    const zcodePlugins = zcodeMkt["plugins"] as Array<Record<string, unknown>>;
    expect(zcodePlugins).toHaveLength(1);
    expect(zcodePlugins[0]?.["name"]).toBe("causoryn");
    expect(zcodePlugins[0]?.["version"]).toBe(SERVER_VERSION);
    expect(zcodePlugins[0]?.["category"]).toBe("developer-tools");
    expect(zcodePlugins[0]?.["license"]).toBe("MIT");
    expect(zcodePlugins[0]?.["source"]).toEqual({
      source: "npm",
      package: "causoryn",
      version: "0.2.4",
    });

    const claudeMkt = readJsonObject(
      path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"),
    );
    expect(claudeMkt["$schema"]).toBe(
      "https://anthropic.com/claude-code/marketplace.schema.json",
    );
    const claudePlugins = claudeMkt["plugins"] as Array<Record<string, unknown>>;
    expect(claudePlugins[0]?.["source"]).toEqual({
      source: "npm",
      package: "causoryn",
      version: "0.2.4",
    });

    const codexMkt = readJsonObject(
      path.join(REPO_ROOT, ".agents", "plugins", "marketplace.json"),
    );
    expect(codexMkt["interface"]).toBeDefined();
    const codexPlugins = codexMkt["plugins"] as Array<Record<string, unknown>>;
    expect(codexPlugins[0]?.["source"]).toEqual({
      source: "npm",
      package: "causoryn",
      version: "0.2.4",
    });
    expect(codexPlugins[0]?.["policy"]).toEqual({
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    });

    const rootAgyPlugin = readJsonObject(path.join(REPO_ROOT, "plugin.json"));
    expect(rootAgyPlugin["$schema"]).toBeUndefined();
    for (const key of Object.keys(rootAgyPlugin)) {
      expect(ALLOWED_ANTIGRAVITY_PLUGIN_KEYS.has(key), `yasak plugin.json alanı: ${key}`).toBe(
        true,
      );
    }
    expect(rootAgyPlugin["version"]).toBe(SERVER_VERSION);

    const rootAgyMcp = readJsonObject(path.join(REPO_ROOT, "mcp_config.json"));
    const agyServers = rootAgyMcp["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(agyServers["causoryn"]?.["command"]).toBe("npx");
    expect(agyServers["causoryn"]?.["args"]).toEqual([
      "-y",
      "causoryn@0.2.4",
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "antigravity",
    ]);

    const rootMcp = readJsonObject(path.join(REPO_ROOT, "mcp.json"));
    const portableServers = rootMcp["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(portableServers["causoryn"]?.["command"]).toBe("npx");
    expect(portableServers["causoryn"]?.["args"]).toContain("causoryn@0.2.4");

    const serverJson = readJsonObject(path.join(REPO_ROOT, "server.json"));
    expect(serverJson["name"]).toBe("io.github.mrbekox/causoryn");
    expect(pkgJson["mcpName"]).toBe(serverJson["name"]);
    expect(serverJson["version"]).toBe("0.2.4");
    expect(serverJson["websiteUrl"]).toBe("https://github.com/MrBekoX/Causoryn");
    const serverPackages = serverJson["packages"] as Array<Record<string, unknown>>;
    expect(serverPackages).toHaveLength(1);
    expect(serverPackages[0]?.["version"]).toBe("0.2.4");
    expect(serverPackages[0]?.["registryBaseUrl"]).toBe("https://registry.npmjs.org");
    const pkgArgs = serverPackages[0]?.["packageArguments"] as Array<Record<string, unknown>>;
    expect(pkgArgs).toEqual([
      { type: "positional", value: "mcp" },
      { type: "positional", value: "--allow-cwd" },
      { type: "positional", value: "--auto-data-dir" },
    ]);
  });

  it("validates all 6 package-internal manifests in packages/causoryn/", () => {
    const zcodePlugin = readJsonObject(path.join(PKG_DIR, ".zcode-plugin", "plugin.json"));
    expect(zcodePlugin["version"]).toBe("0.2.4");
    expect(zcodePlugin["skills"]).toBe("skills");
    const zcodeServers = zcodePlugin["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(zcodeServers["causoryn"]?.["command"]).toBe("node");
    expect(zcodeServers["causoryn"]?.["cwd"]).toBe(ZCODE_PROJECT_DIR_TOKEN);
    expect(zcodeServers["causoryn"]?.["args"]).toEqual([
      `${ZCODE_PLUGIN_ROOT_TOKEN}/scripts/plugin-mcp-launcher.mjs`,
      "--expected-version",
      "0.2.4",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "zcode",
    ]);

    const claudePlugin = readJsonObject(path.join(PKG_DIR, ".claude-plugin", "plugin.json"));
    expect(claudePlugin["version"]).toBe("0.2.4");
    const claudeServers = claudePlugin["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(claudeServers["causoryn"]?.["command"]).toBe("node");
    expect(claudeServers["causoryn"]?.["args"]).toEqual([
      `${CLAUDE_PLUGIN_ROOT_TOKEN}/scripts/plugin-mcp-launcher.mjs`,
      "--expected-version",
      "0.2.4",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "claude-code",
    ]);

    const codexPlugin = readJsonObject(path.join(PKG_DIR, ".codex-plugin", "plugin.json"));
    expect(codexPlugin["version"]).toBe("0.2.4");
    expect(codexPlugin["mcpServers"]).toBe("./.codex-plugin/mcp.json");
    expect(codexPlugin["skills"]).toBe("./skills");

    const codexMcp = readJsonObject(path.join(PKG_DIR, ".codex-plugin", "mcp.json"));
    const codexServers = codexMcp["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(codexServers["causoryn"]?.["command"]).toBe("npx");
    expect(codexServers["causoryn"]?.["startup_timeout_sec"]).toBe(30);
    expect(codexServers["causoryn"]?.["args"]).toEqual([
      "-y",
      "--package",
      "causoryn@0.2.4",
      "causoryn",
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "codex",
    ]);

    const pkgAgyPlugin = readJsonObject(path.join(PKG_DIR, "plugin.json"));
    expect(pkgAgyPlugin["$schema"]).toBeUndefined();
    for (const key of Object.keys(pkgAgyPlugin)) {
      expect(ALLOWED_ANTIGRAVITY_PLUGIN_KEYS.has(key)).toBe(true);
    }
    expect(pkgAgyPlugin["version"]).toBe("0.2.4");

    const pkgAgyMcp = readJsonObject(path.join(PKG_DIR, "mcp_config.json"));
    const pkgAgyServers = pkgAgyMcp["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(pkgAgyServers["causoryn"]?.["command"]).toBe("node");
    expect(pkgAgyServers["causoryn"]?.["args"]).toEqual([
      "scripts/plugin-mcp-launcher.mjs",
      "--expected-version",
      "0.2.4",
      "--allow-cwd",
      "--auto-data-dir",
      "--client",
      "antigravity",
    ]);
  });
});

describe("3. packages/causoryn/README.md (ADR-010 29 tools + 21 error codes + 4 hosts)", () => {
  it("documents all 29 TOOL_NAMES in backticks, all 21 error codes, Node.js >= 24, read-only guarantee, and 4 hosts", () => {
    const readmePath = path.join(PKG_DIR, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");

    const backtickTools = [
      ...new Set([...readme.matchAll(BACKTICK_CAUSORYN_TOOL)].map((m) => m[1] ?? "")),
    ].sort();
    expect(backtickTools).toEqual([...TOOL_NAMES].sort());

    expect(ALL_21_ERROR_CODES).toHaveLength(21);
    for (const errCode of ALL_21_ERROR_CODES) {
      expect(readme, `README eksik hata kodu: ${errCode}`).toContain(errCode);
    }

    expect(readme).toContain("Node.js >= 24");
    expect(readme).toMatch(/read-only/i);
    expect(readme).toContain("npx causoryn setup");
    for (const hostLabel of ["Antigravity", "Claude Code", "Codex", "ZCode (GLM)"]) {
      expect(readme, `README eksik host: ${hostLabel}`).toContain(hostLabel);
    }
    expect(readme).not.toMatch(/single[- ]file (distribution|bundle)/i);
  });
});

describe("4. build-package.mjs + isolated npm pack end-to-end verification", () => {
  const bundlePresent = existsSync(MCP_SERVER_BUNDLE);

  it("rejects manifest version drift fail-closed in verifyManifestVersionParity", async () => {
    const mod = (await import(
      pathToFileURL(path.join(PKG_DIR, "scripts", "build-package.mjs")).href
    )) as {
      verifyManifestVersionParity: (repoRoot: string, pkgDir: string) => string;
    };
    const sandbox = createTempDir("version-parity");
    const fakePkgDir = path.join(sandbox, "pkg");
    mkdirSync(path.join(fakePkgDir, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(fakePkgDir, ".zcode-plugin"), { recursive: true });
    mkdirSync(path.join(fakePkgDir, ".codex-plugin"), { recursive: true });

    const writeDrifted = (rel: string, obj: Record<string, unknown>): void => {
      const target = path.join(fakePkgDir, rel);
      const raw = JSON.stringify(obj, null, 2);
      rmSync(target, { force: true });
      execFileSync(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8')",
          target,
          raw,
        ],
        { shell: false },
      );
    };

    writeDrifted("package.json", { name: "causoryn", version: "0.9.9" });
    expect(() => mod.verifyManifestVersionParity(REPO_ROOT, fakePkgDir)).toThrow(/0\.2\.4/);
  });

  it("verifies every file in bundle-manifest.json via SHA-256 and recovers from torn reads before failing closed", async () => {
    const mod = (await import(
      pathToFileURL(path.join(PKG_DIR, "scripts", "build-package.mjs")).href
    )) as {
      stageVerifiedBundleArtifacts?: (options: {
        readonly mcpDistDir: string;
        readonly pkgDistDir: string;
        readonly maxRetries?: number;
        readonly retryDelayMs?: number;
      }) => { readonly verifiedFileCount: number; readonly bundleSha256: string };
    };
    expect(typeof mod.stageVerifiedBundleArtifacts).toBe("function");
    const stageVerified = mod.stageVerifiedBundleArtifacts!;

    const sandbox = createTempDir("bundle-sha-retry");
    const mcpDistDir = path.join(sandbox, "mcp-dist");
    const pkgDistDir = path.join(sandbox, "pkg-dist");
    const sqliteDir = path.join(mcpDistDir, "node_modules", "better-sqlite3");
    mkdirSync(path.join(sqliteDir, "lib"), { recursive: true });
    mkdirSync(pkgDistDir, { recursive: true });
    writeFileSync(path.join(pkgDistDir, "index.js"), "// keep tsc output\n", "utf8");

    const finalBundleBody = "// deterministic esbuild bundle\n";
    const sqlitePkgBody = JSON.stringify({ name: "better-sqlite3", version: "12.0.0" });
    const sqliteIndexBody = "module.exports = {};\n";

    writeFileSync(path.join(sqliteDir, "package.json"), sqlitePkgBody, "utf8");
    writeFileSync(path.join(sqliteDir, "lib", "index.js"), sqliteIndexBody, "utf8");
    // Start with torn partial bundle content in mcpDistDir
    const bundleSrcPath = path.join(mcpDistDir, "mcp-server.mjs");
    writeFileSync(bundleSrcPath, "// torn partial write", "utf8");

    const shaOf = (text: string): string =>
      createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

    const manifestObj = {
      files: {
        "mcp-server.mjs": shaOf(finalBundleBody),
        "node_modules/better-sqlite3/package.json": shaOf(sqlitePkgBody),
        "node_modules/better-sqlite3/lib/index.js": shaOf(sqliteIndexBody),
      },
    };
    writeFileSync(
      path.join(mcpDistDir, "bundle-manifest.json"),
      `${JSON.stringify(manifestObj, null, 2)}\n`,
      "utf8",
    );

    // Spawn a real concurrent writer that heals mcp-server.mjs at ~80ms while Atomics.wait(300ms) pauses
    const healer = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8'); }, 80);",
        bundleSrcPath,
        finalBundleBody,
      ],
      { shell: false, stdio: "ignore" },
    );
    const healerDone = new Promise<void>((resolve) => {
      healer.on("close", () => resolve());
    });

    const verified = stageVerified({ mcpDistDir, pkgDistDir });
    await healerDone;

    expect(verified.verifiedFileCount).toBe(3);
    expect(verified.bundleSha256).toBe(shaOf(finalBundleBody));
    expect(readFileSync(path.join(pkgDistDir, "mcp-server.mjs"), "utf8")).toBe(finalBundleBody);
    expect(readFileSync(path.join(pkgDistDir, "index.js"), "utf8")).toBe("// keep tsc output\n");

    // Persistent SHA-256 mismatch fails closed after exhausting all 5 retries and preserves tsc output
    writeFileSync(bundleSrcPath, "// permanently corrupted\n", "utf8");
    expect(() =>
      stageVerified({
        mcpDistDir,
        pkgDistDir,
        maxRetries: 5,
        retryDelayMs: 5,
      }),
    ).toThrow(/SHA-256/);
    expect(existsSync(path.join(pkgDistDir, "mcp-server.mjs"))).toBe(false);
    expect(existsSync(path.join(pkgDistDir, "index.js"))).toBe(true);
  });

  it.runIf(bundlePresent)(
    "stages package assets cleanly, packs a real .tgz archive, and passes isolated setup, doctor, and stdio MCP handshake",
    { timeout: 60_000 },
    async () => {
      const sandbox = createTempDir("npm-pack-e2e");
      const fakeHome = path.join(sandbox, "fake-home");
      const fakeCodexHome = path.join(fakeHome, ".codex");
      mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      mkdirSync(fakeCodexHome, { recursive: true });

      const unpackedPkg = packAndUnpackCausorynTarball(sandbox);
      const files = listAllFilesRelative(unpackedPkg);

      expect(files).toContain("dist/mcp-server.mjs");
      expect(files).toContain("dist/mcp-server.mjs.LEGAL.txt");
      expect(files).toContain("dist/bundle-manifest.json");
      expect(files).toContain("dist/node_modules/better-sqlite3/package.json");
      expect(files).toContain("dist/node_modules/better-sqlite3/LICENSE");
      expect(files).toContain("dist/typescript-lib/lib.es2022.full.d.ts");
      expect(files).toContain("scripts/lib/node-version-guard.mjs");
      expect(files).toContain("native/python-worker/worker.py");
      expect(files).toContain("native/go-worker/cmd/worker/main.go");
      expect(files).toContain("native/rust-worker/Cargo.toml");
      expect(files).toContain("native/roslyn-worker/Causoryn.RoslynWorker.csproj");
      expect(files).toContain("native/roslyn-worker/Causoryn.RoslynWorker.dll");
      expect(files).toContain("native/roslyn-worker/Causoryn.RoslynWorker.deps.json");
      expect(files).toContain("native/roslyn-worker/Causoryn.RoslynWorker.runtimeconfig.json");
      expect(files).toContain("native/roslyn-worker/Microsoft.CodeAnalysis.dll");
      expect(files).toContain("native/roslyn-worker/Microsoft.CodeAnalysis.CSharp.dll");
      expect(files).toContain("skills/causoryn/SKILL.md");
      expect(files).toContain("skills/map-system/SKILL.md");
      expect(files).toContain("skills/preflight-change/SKILL.md");
      expect(files).toContain("skills/verify-change/SKILL.md");
      expect(files).toContain("skills/architecture-blueprint/SKILL.md");
      expect(files).toContain("LICENSE");
      expect(files).toContain("THIRD-PARTY-NOTICES.md");
      expect(files).toContain("licenses/Apache-2.0.txt");
      expect(files).toContain("licenses/TypeScript-ThirdPartyNoticeText.txt");
      expect(files).toContain("licenses/better-sqlite3-LICENSE.txt");

      // Excluded build artifacts, localized satellite DLLs, and sourcemaps must never leak into the npm tarball
      for (const rel of files) {
        expect(rel.includes("/target/")).toBe(false);
        expect(rel.includes("/obj/")).toBe(false);
        expect(rel.startsWith("native/roslyn-worker/bin/")).toBe(false);
        expect(rel.toLowerCase().endsWith(".resources.dll")).toBe(false);
        expect(rel.endsWith("test-build.lock")).toBe(false);
        expect(rel.includes("__pycache__")).toBe(false);
        expect(rel.endsWith(".pdb")).toBe(false);
        expect(rel.startsWith("dist/") && rel.endsWith(".map")).toBe(false);
        expect(rel.includes(".mimosa/")).toBe(false);
      }

      // Pure LF line endings on executable scripts in the packed tarball
      for (const relScript of [
        "scripts/causoryn.mjs",
        "scripts/plugin-mcp-launcher.mjs",
        "scripts/lib/node-version-guard.mjs",
      ]) {
        const scriptBytes = readFileSync(path.join(unpackedPkg, relScript));
        expect(scriptBytes.includes(0x0d), `${relScript} contains CR bytes in tarball`).toBe(false);
      }

      // Deterministic Release Roslyn DLL binary scan: zero local user paths or .pdb references
      const roslynDllBytes = readFileSync(
        path.join(unpackedPkg, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
      );
      const roslynLatin1 = roslynDllBytes.toString("latin1");
      const roslynUtf16 = roslynDllBytes.toString("utf16le");
      for (const forbiddenPattern of [/[A-Za-z]:\\Users\\/i, /\/Users\//, /\/home\//, /\.pdb\b/i]) {
        expect(forbiddenPattern.test(roslynLatin1)).toBe(false);
        expect(forbiddenPattern.test(roslynUtf16)).toBe(false);
      }

      // Third-party license notices verification
      const noticesContent = readFileSync(path.join(unpackedPkg, "THIRD-PARTY-NOTICES.md"), "utf8");
      for (const requiredAttribution of [
        "Apache License",
        "Gary Court",
        "Anthropic, PBC",
        "Colin McDonnell",
        "Evgeny Poberezkin",
        "Joshua Wise",
        "Microsoft Corporation",
        "Eemeli Aro",
        "Stefan Terdell",
        "SQLite",
      ]) {
        expect(noticesContent).toContain(requiredAttribution);
      }

      const isolatedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CODEX_HOME: fakeCodexHome,
        CAUSORYN_CONFIG: '{"allowRoots":[]}',
      };
      delete isolatedEnv["CLAUDE_CONFIG_DIR"];

      // 1. CLI setup in isolated fake home
      execFileSync(
        process.execPath,
        [path.join(unpackedPkg, "scripts", "causoryn.mjs"), "setup", "--all-detected", "--yes"],
        {
          cwd: unpackedPkg,
          env: isolatedEnv,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(existsSync(path.join(fakeHome, ".claude.json"))).toBe(true);
      expect(existsSync(path.join(fakeCodexHome, "config.toml"))).toBe(true);
      expect(existsSync(path.join(fakeHome, ".causoryn", "runtime", "scripts", "causoryn.mjs"))).toBe(
        true,
      );

      // 2. CLI doctor --json in isolated fake home
      const doctorOut = execFileSync(
        process.execPath,
        [path.join(unpackedPkg, "scripts", "causoryn.mjs"), "doctor", "--json"],
        {
          cwd: unpackedPkg,
          env: isolatedEnv,
          shell: false,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const doctorJson = JSON.parse(doctorOut) as { healthy: boolean };
      expect(doctorJson.healthy).toBe(true);

      // 3. Unpacked plugin-mcp-launcher.mjs over pure JSON-RPC stdio (with --expected-version)
      const launcherHandshake = await runStdioHandshake(
        process.execPath,
        [
          path.join(unpackedPkg, "scripts", "plugin-mcp-launcher.mjs"),
          "--expected-version",
          SERVER_VERSION,
        ],
        unpackedPkg,
        isolatedEnv,
      );
      expect(launcherHandshake.stdoutLines.length).toBe(3);
      const initMsg = launcherHandshake.responses.get(1)?.result as {
        serverInfo?: { name?: string; version?: string };
      };
      expect(initMsg.serverInfo?.name).toBe(SERVER_NAME);
      expect(initMsg.serverInfo?.version).toBe(SERVER_VERSION);

      const listMsg = launcherHandshake.responses.get(2)?.result as {
        tools?: Array<{ name?: string }>;
      };
      expect(listMsg.tools?.map((t) => t.name)).toEqual([...TOOL_NAMES]);

      // 4. Unpacked causoryn.mjs mcp over pure JSON-RPC stdio
      const cliHandshake = await runStdioHandshake(
        process.execPath,
        [path.join(unpackedPkg, "scripts", "causoryn.mjs"), "mcp"],
        unpackedPkg,
        isolatedEnv,
      );
      expect(cliHandshake.stdoutLines.length).toBe(3);
      const cliInitMsg = cliHandshake.responses.get(1)?.result as {
        serverInfo?: { name?: string; version?: string };
      };
      expect(cliInitMsg.serverInfo?.name).toBe(SERVER_NAME);
      expect(cliInitMsg.serverInfo?.version).toBe(SERVER_VERSION);
    },
  );

  it.runIf(bundlePresent)(
    "indexes a TypeScript project zero-config from unpacked .tgz (--allow-cwd --auto-data-dir) with zero TS2318 errors, omitted outputSchema, read-only workspace, and external SQLite + exports",
    { timeout: 60_000 },
    async () => {
      const sandbox = createTempDir("tgz-zeroconf-ts-e2e");
      const unpackedPkg = packAndUnpackCausorynTarball(sandbox);

      const fakeHome = path.join(sandbox, "fake-home");
      const fakeCodexHome = path.join(fakeHome, ".codex");
      const dataDir = path.join(fakeHome, ".causoryn");
      mkdirSync(fakeHome, { recursive: true });

      // (a) Create sample TypeScript project using Promise<Record<string, ReadonlyArray<Map<string, Set<number>>>>>
      const sampleProjectDir = path.join(sandbox, "sample-ts-project");
      mkdirSync(path.join(sampleProjectDir, "src"), { recursive: true });
      writeFileSync(
        path.join(sampleProjectDir, "package.json"),
        JSON.stringify({ name: "sample-ts-project", version: "1.0.0", type: "module" }, null, 2),
        "utf8",
      );
      writeFileSync(
        path.join(sampleProjectDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
            },
            include: ["src"],
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(
        path.join(sampleProjectDir, "src", "order-service.ts"),
        [
          "export async function aggregateOrderBuckets(",
          "  tenantId: string,",
          "): Promise<Record<string, ReadonlyArray<Map<string, Set<number>>>>> {",
          "  const bucket = new Map<string, Set<number>>();",
          "  bucket.set(tenantId, new Set<number>([101, 202]));",
          "  return { [tenantId]: [bucket] };",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      // (b) Snapshot all files and directories inside sample-ts-project BEFORE running Causoryn
      const beforeProjectSnapshot = snapshotDirectoryState(sampleProjectDir);

      // (c) Build env with CAUSORYN_CONFIG explicitly UNSET
      const zeroConfigEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CODEX_HOME: fakeCodexHome,
      };
      delete zeroConfigEnv["CAUSORYN_CONFIG"];
      delete zeroConfigEnv["CAUSORYN_ASSET_ROOT"];
      delete zeroConfigEnv["CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE"];

      // (d) Spawn unpacked .tgz CLI in zero-config mode with cwd = sampleProjectDir
      const session = await runStdioSequence(
        process.execPath,
        [
          path.join(unpackedPkg, "scripts", "causoryn.mjs"),
          "mcp",
          "--allow-cwd",
          "--auto-data-dir",
          "--data-dir",
          dataDir,
          "--client",
          "claude-code",
        ],
        sampleProjectDir,
        zeroConfigEnv,
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "claude-code", version: "1.0.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "causoryn_workspace_summary", arguments: {} },
          },
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "causoryn_find_symbols",
              arguments: { query: "aggregateOrderBuckets" },
            },
          },
        ],
      );

      // Pure JSON-RPC stdout discipline (4 responses, zero log noise)
      expect(session.stdoutLines).toHaveLength(4);

      // tools/list: 29 tools AND outputSchema omitted on wire
      const listResult = session.responses.get(2)?.result as {
        tools?: Array<Record<string, unknown>>;
      };
      expect(listResult.tools).toBeDefined();
      expect(listResult.tools?.map((t) => t["name"])).toEqual([...TOOL_NAMES]);
      for (const toolDef of listResult.tools ?? []) {
        expect("outputSchema" in toolDef).toBe(false);
      }

      // causoryn_workspace_summary: status === "ok" and snapshotState === "ready" (zero TS2318 errors!)
      const summaryCallResult = session.responses.get(3)?.result as {
        structuredContent?: {
          status?: string;
          data?: {
            snapshotState?: string;
            fileCount?: number;
            languages?: Array<{ language: string; files: number }>;
          };
        };
      };
      expect(summaryCallResult.structuredContent?.status).toBe("ok");
      expect(summaryCallResult.structuredContent?.data?.snapshotState).toBe("ready");
      expect(summaryCallResult.structuredContent?.data?.languages).toContainEqual({
        language: "typescript",
        files: 1,
      });

      // causoryn_find_symbols: locates aggregateOrderBuckets in src/order-service.ts
      const findCallResult = session.responses.get(4)?.result as {
        structuredContent?: {
          status?: string;
          data?: {
            returned?: number;
            hits?: Array<{
              qualifiedName?: string;
              kind?: string;
              language?: string;
              relativePath?: string;
            }>;
          };
        };
      };
      expect(findCallResult.structuredContent?.status).toBe("ok");
      expect(findCallResult.structuredContent?.data?.returned).toBeGreaterThanOrEqual(1);
      expect(
        findCallResult.structuredContent?.data?.hits?.some(
          (hit) =>
            hit.qualifiedName?.includes("aggregateOrderBuckets") === true &&
            hit.language === "typescript" &&
            hit.relativePath === "src/order-service.ts",
        ),
      ).toBe(true);

      // (e) Assert 100% read-only workspace + external graph-claude-code.sqlite & exports/
      expect(snapshotDirectoryState(sampleProjectDir)).toEqual(beforeProjectSnapshot);

      const workspacesRoot = path.join(dataDir, "workspaces");
      expect(existsSync(workspacesRoot)).toBe(true);
      const workspaceDirs = readdirSync(workspacesRoot, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      );
      expect(workspaceDirs).toHaveLength(1);
      const createdWsDir = path.join(workspacesRoot, workspaceDirs[0]!.name);
      expect(existsSync(path.join(createdWsDir, "graph-claude-code.sqlite"))).toBe(true);
      expect(existsSync(path.join(createdWsDir, "exports"))).toBe(true);
      expect(statSync(path.join(createdWsDir, "exports")).isDirectory()).toBe(true);
    },
  );
});
