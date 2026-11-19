import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListRootsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  CausorynConfigError,
  EnvelopeSchema,
  McpCliUsageError,
  attachMcpRootsWorkspaceBinder,
  buildWorkspaceAutoConfig,
  createCausorynContext,
  createCausorynMcpServer,
  createDynamicCausorynContext,
  inspectProjectRootSafety,
  isSafeProjectRoot,
  parseMcpCliArgs,
  resolveBaseDataDir,
  resolveEffectiveOutputSchemaProfile,
} from "../src/index.js";

/**
 * K-021 Track 2 — Sıfır-ayar MCP CLI bayrakları, güvenli --allow-cwd,
 * dinamik MCP roots/list bağlaması, --auto-data-dir ve outputSchemaProfile
 * test süiti.
 *
 * Kırmızı çizgiler:
 * - Kaynak workspace dizinlerine tek bayt bile yazılmaz (ADR-008).
 * - Tüm geçici dizinler os.tmpdir() altında oluşturulur ve temizlenir.
 * - Gerçek MCP Client + InMemoryTransport ve gerçek stdio child process kullanılır.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(TEST_DIR);
const REPO_ROOT = path.dirname(path.dirname(PKG_DIR));
const STDIO_ENTRY = path.join(PKG_DIR, "src", "cli-stdio.ts");
const LOADER_ENTRY = path.join(TEST_DIR, "loader", "register-strip.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const READY_MARKER = "causoryn mcp server hazir";
const UP_DIR_TOKEN = "." + ".";

interface TempSandbox {
  readonly rootDir: string;
  readonly fakeHome: string;
  readonly dataDir: string;
  readonly projectADir: string;
  readonly projectBDir: string;
  readonly pluginDir: string;
  readonly cleanup: () => void;
}

function createTempSandbox(): TempSandbox {
  const rootDir = mkdtempSync(path.join(tmpdir(), "causoryn-cli-roots-"));
  const fakeHome = path.join(rootDir, "home");
  const dataDir = path.join(rootDir, "custom-data");
  const projectADir = path.join(fakeHome, "projects", "alpha-service");
  const projectBDir = path.join(fakeHome, "projects", "beta-billing");
  const pluginDir = path.join(fakeHome, "plugins", "causoryn-installed");

  mkdirSync(path.join(projectADir, "src"), { recursive: true });
  mkdirSync(path.join(projectBDir, "src"), { recursive: true });
  mkdirSync(path.join(pluginDir, ".zcode-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(
    path.join(projectADir, "src", "alpha.ts"),
    "export function computeAlphaScore(seed: number): number { return seed + 1; }\n",
    "utf8",
  );
  writeFileSync(
    path.join(projectBDir, "src", "beta.ts"),
    "export function settleBetaInvoice(amount: number): number { return amount * 2; }\n",
    "utf8",
  );
  writeFileSync(
    path.join(pluginDir, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "causoryn", version: "0.1.0" }),
    "utf8",
  );
  writeFileSync(
    path.join(pluginDir, "scripts", "bundle-manifest.json"),
    JSON.stringify({ files: {} }),
    "utf8",
  );
  writeFileSync(
    path.join(pluginDir, "scripts", "mcp-server.mjs"),
    "// dummy bundle placeholder\n",
    "utf8",
  );

  return {
    rootDir,
    fakeHome,
    dataDir,
    projectADir,
    projectBDir,
    pluginDir,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function listTreeRelative(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("parseMcpCliArgs — sıfır-ayar CLI ayrıştırıcısı", () => {
  it("boş argv iken hasCliActivation=false ve tüm bayraklar devre dışı döner", () => {
    const parsed = parseMcpCliArgs([]);
    expect(parsed).toEqual({
      hasCliActivation: false,
      allowCwd: false,
      roots: [],
      autoDataDir: false,
    });
  });

  it("isteğe bağlı öndeki 'mcp' alt komutunu ve tüm desteklenen bayrakları ayrıştırır", () => {
    const parsed = parseMcpCliArgs([
      "mcp",
      "--allow-cwd",
      "--root",
      "/workspace/one",
      "--root",
      "/workspace/two",
      "--auto-data-dir",
      "--client",
      "zcode",
      "--output-schema-profile",
      "omit",
    ]);
    expect(parsed).toEqual({
      hasCliActivation: true,
      allowCwd: true,
      roots: ["/workspace/one", "/workspace/two"],
      autoDataDir: true,
      client: "zcode",
      outputSchemaProfile: "omit",
    });
  });

  it("--data-dir verilirse --auto-data-dir otomatik true olur", () => {
    const parsed = parseMcpCliArgs(["--data-dir", "/var/tmp/causoryn-data"]);
    expect(parsed.hasCliActivation).toBe(true);
    expect(parsed.autoDataDir).toBe(true);
    expect(parsed.dataDir).toBe("/var/tmp/causoryn-data");
  });

  it("bilinmeyen bayrak, null byte, eksik değer veya geçersiz profil için McpCliUsageError fırlatır", () => {
    expect(() => parseMcpCliArgs(["--unknown"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["setup"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--root"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--data-dir"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--client"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--client", `${UP_DIR_TOKEN}/bad`])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--output-schema-profile"])).toThrow(McpCliUsageError);
    expect(() => parseMcpCliArgs(["--output-schema-profile", "invalid"])).toThrow(
      McpCliUsageError,
    );
    expect(() => parseMcpCliArgs(["--root", "/tmp/bad\0null"])).toThrow(McpCliUsageError);
  });

  it("resolveEffectiveOutputSchemaProfile: bayrak > CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE > mod varsayılanı sırasını uygular", () => {
    const bare = parseMcpCliArgs([]);
    expect(resolveEffectiveOutputSchemaProfile(bare, {})).toBe("full");
    expect(
      resolveEffectiveOutputSchemaProfile(bare, { CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "omit" }),
    ).toBe("omit");

    const cli = parseMcpCliArgs(["mcp", "--allow-cwd"]);
    expect(resolveEffectiveOutputSchemaProfile(cli, {})).toBe("omit");
    expect(
      resolveEffectiveOutputSchemaProfile(cli, { CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "full" }),
    ).toBe("full");

    const explicitFlag = parseMcpCliArgs(["mcp", "--output-schema-profile", "full"]);
    expect(
      resolveEffectiveOutputSchemaProfile(explicitFlag, {
        CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "omit",
      }),
    ).toBe("full");

    expect(() =>
      resolveEffectiveOutputSchemaProfile(bare, { CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "bogus" }),
    ).toThrow(McpCliUsageError);
  });
});

describe("isSafeProjectRoot — güvenli proje kökü filtresi", () => {
  it("normal kullanıcı proje dizinini kabul eder; kök dizin, $HOME, veri dizinleri ve plugin kurulumunu reddeder", () => {
    const sandbox = createTempSandbox();
    try {
      const homeCausoryn = path.join(sandbox.fakeHome, ".causoryn");
      const homeRuntime = path.join(homeCausoryn, "runtime");
      const zcodeData = path.join(sandbox.rootDir, "zcode-plugin-data");
      const zcodeSub = path.join(zcodeData, "nested");
      mkdirSync(homeRuntime, { recursive: true });
      mkdirSync(zcodeSub, { recursive: true });

      const opts = {
        homeDir: sandbox.fakeHome,
        baseDataDir: sandbox.dataDir,
        zcodePluginDataDir: zcodeData,
        scriptPath: path.join(sandbox.pluginDir, "scripts", "mcp-server.mjs"),
      };

      // Pozitif: normal proje dizinleri ($HOME altında olsa bile kendisi $HOME değil).
      expect(isSafeProjectRoot(sandbox.projectADir, opts)).toBe(true);
      expect(isSafeProjectRoot(sandbox.projectBDir, opts)).toBe(true);

      // Negatif 1: dosya sistemi kökü (/ veya C:\)
      const fsRoot = path.parse(sandbox.rootDir).root;
      expect(isSafeProjectRoot(fsRoot, opts)).toBe(false);

      // Negatif 2: $HOME kendisi
      expect(isSafeProjectRoot(sandbox.fakeHome, opts)).toBe(false);

      // Negatif 3: ~/.causoryn, ~/.causoryn/runtime, ZCODE_PLUGIN_DATA, --data-dir ve alt dizinleri
      expect(isSafeProjectRoot(homeCausoryn, opts)).toBe(false);
      expect(isSafeProjectRoot(homeRuntime, opts)).toBe(false);
      expect(isSafeProjectRoot(sandbox.dataDir, opts)).toBe(false);
      const dataSub = path.join(sandbox.dataDir, "workspaces", "foo");
      mkdirSync(dataSub, { recursive: true });
      expect(isSafeProjectRoot(dataSub, opts)).toBe(false);
      expect(isSafeProjectRoot(zcodeData, opts)).toBe(false);
      expect(isSafeProjectRoot(zcodeSub, opts)).toBe(false);

      // Negatif 4: bundle-manifest.json bulunan script dizini ve üst plugin dizini
      expect(isSafeProjectRoot(path.join(sandbox.pluginDir, "scripts"), opts)).toBe(false);
      expect(isSafeProjectRoot(sandbox.pluginDir, opts)).toBe(false);

      // Negatif 5: var olmayan yol veya dosya yolu
      expect(isSafeProjectRoot(path.join(sandbox.rootDir, "missing"), opts)).toBe(false);
      expect(isSafeProjectRoot(path.join(sandbox.projectADir, "src", "alpha.ts"), opts)).toBe(
        false,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("AGENTS.md + package.json workspaces içeren monorepo kökünü plugin manifesti olsa bile reddetmez", () => {
    const sandbox = createTempSandbox();
    try {
      // Gerçek Causoryn monorepo kökü kabul edilmeli:
      expect(isSafeProjectRoot(REPO_ROOT)).toBe(true);

      // Sentetik monorepo: hem kök plugin.json/mcp_config.json hem AGENTS.md + workspaces içeriyor
      const monoDir = path.join(sandbox.fakeHome, "projects", "causoryn-dev-clone");
      mkdirSync(path.join(monoDir, "packages", "mcp-server", "src"), { recursive: true });
      writeFileSync(path.join(monoDir, "AGENTS.md"), "# AGENTS\n", "utf8");
      writeFileSync(
        path.join(monoDir, "package.json"),
        JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }),
        "utf8",
      );
      writeFileSync(
        path.join(monoDir, "plugin.json"),
        JSON.stringify({ name: "causoryn" }),
        "utf8",
      );
      writeFileSync(
        path.join(monoDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: {} }),
        "utf8",
      );
      const scriptInMono = path.join(monoDir, "packages", "mcp-server", "src", "stdio.ts");
      writeFileSync(scriptInMono, "// entry\n", "utf8");

      expect(
        isSafeProjectRoot(monoDir, {
          homeDir: sandbox.fakeHome,
          scriptPath: scriptInMono,
        }),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("AGENTS.md + workspaces içerse bile ~/.gemini, ~/.antigravity, ~/.claude/plugins, ~/.zcode/plugins, ~/.codex/plugins, ~/.agents/plugins ve CLAUDE_PLUGIN_ROOT / ZCODE_PLUGIN_ROOT altındaki Git klonu eklenti dizinlerini plugin-install-directory gerekçesiyle reddeder", () => {
    const sandbox = createTempSandbox();
    try {
      const populateGitClonePlugin = (targetDir: string): string => {
        mkdirSync(path.join(targetDir, "packages", "mcp-server", "src"), { recursive: true });
        writeFileSync(path.join(targetDir, "AGENTS.md"), "# AGENTS\n", "utf8");
        writeFileSync(
          path.join(targetDir, "package.json"),
          JSON.stringify({ name: "causoryn", private: true, workspaces: ["packages/*"] }),
          "utf8",
        );
        writeFileSync(
          path.join(targetDir, "plugin.json"),
          JSON.stringify({ name: "causoryn", version: "0.1.0" }),
          "utf8",
        );
        writeFileSync(
          path.join(targetDir, "mcp_config.json"),
          JSON.stringify({ mcpServers: {} }),
          "utf8",
        );
        const entryScript = path.join(targetDir, "packages", "mcp-server", "src", "stdio.ts");
        writeFileSync(entryScript, "// entry\n", "utf8");
        return entryScript;
      };

      const homePluginClones = [
        path.join(sandbox.fakeHome, ".gemini", "extensions", "causoryn"),
        path.join(sandbox.fakeHome, ".antigravity", "extensions", "causoryn"),
        path.join(sandbox.fakeHome, ".claude", "plugins", "causoryn"),
        path.join(sandbox.fakeHome, ".zcode", "plugins", "causoryn"),
        path.join(sandbox.fakeHome, ".codex", "plugins", "causoryn"),
        path.join(sandbox.fakeHome, ".agents", "plugins", "causoryn"),
      ];

      for (const cloneDir of homePluginClones) {
        const scriptPath = populateGitClonePlugin(cloneDir);
        const check = inspectProjectRootSafety(cloneDir, {
          homeDir: sandbox.fakeHome,
          scriptPath,
          env: {},
        });
        expect(check).toEqual({ safe: false, reason: "plugin-install-directory" });
        expect(isSafeProjectRoot(cloneDir, { homeDir: sandbox.fakeHome, scriptPath, env: {} })).toBe(
          false,
        );
      }

      const claudeEnvClone = path.join(sandbox.rootDir, "external-claude-plugin-clone");
      const claudeScript = populateGitClonePlugin(claudeEnvClone);
      expect(
        inspectProjectRootSafety(claudeEnvClone, {
          homeDir: sandbox.fakeHome,
          scriptPath: claudeScript,
          env: { CLAUDE_PLUGIN_ROOT: claudeEnvClone },
        }),
      ).toEqual({ safe: false, reason: "plugin-install-directory" });

      const zcodeEnvClone = path.join(sandbox.rootDir, "external-zcode-plugin-clone");
      const zcodeScript = populateGitClonePlugin(zcodeEnvClone);
      expect(
        inspectProjectRootSafety(zcodeEnvClone, {
          homeDir: sandbox.fakeHome,
          scriptPath: zcodeScript,
          env: { ZCODE_PLUGIN_ROOT: zcodeEnvClone },
        }),
      ).toEqual({ safe: false, reason: "plugin-install-directory" });
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("buildWorkspaceAutoConfig — otomatik veri dizini ve çoklu-istemci izolasyonu", { timeout: 30_000 }, () => {
  it("taban veri dizini önceliğini (--data-dir > ZCODE_PLUGIN_DATA > ~/.causoryn) uygular ve SQLite/wiki/exports yollarını hazırlar", () => {
    const sandbox = createTempSandbox();
    try {
      const treeBefore = listTreeRelative(sandbox.projectADir);

      // 1) --data-dir en yüksek öncelik + --client zcode
      const cfg1 = buildWorkspaceAutoConfig({
        roots: [sandbox.projectADir],
        autoDataDir: true,
        dataDir: sandbox.dataDir,
        client: "zcode",
        homeDir: sandbox.fakeHome,
        env: { ZCODE_PLUGIN_DATA: path.join(sandbox.rootDir, "ignored-zcode-data") },
      });

      expect(cfg1.workspaceId).toBe("alpha-service");
      expect(cfg1.allowRoots.length).toBe(1);
      expect(cfg1.storage.dataDbPath).toBeDefined();
      expect(cfg1.storage.dataDbPath?.startsWith(path.join(sandbox.dataDir, "workspaces"))).toBe(
        true,
      );
      expect(path.basename(cfg1.storage.dataDbPath ?? "")).toBe("graph-zcode.sqlite");
      expect(cfg1.wiki.dataDbPath).toBe(cfg1.storage.dataDbPath);
      expect(cfg1.output.allowedOutputDirs.length).toBe(1);
      const exportsDir = cfg1.output.allowedOutputDirs[0] as string;
      expect(path.basename(exportsDir)).toBe("exports");
      expect(existsSync(exportsDir)).toBe(true);

      if (process.platform !== "win32") {
        const wsDataDir = path.dirname(cfg1.storage.dataDbPath as string);
        expect(statSync(wsDataDir).mode & 0o777).toBe(0o700);
        expect(statSync(exportsDir).mode & 0o777).toBe(0o700);
      }

      // 2) --data-dir yokken ZCODE_PLUGIN_DATA ikinci öncelik + client verilmezse graph.sqlite
      const zcodeDataDir = path.join(sandbox.rootDir, "zcode-data");
      const cfg2 = buildWorkspaceAutoConfig({
        roots: [sandbox.projectADir],
        autoDataDir: true,
        homeDir: sandbox.fakeHome,
        env: { ZCODE_PLUGIN_DATA: zcodeDataDir },
      });
      expect(cfg2.storage.dataDbPath?.startsWith(path.join(zcodeDataDir, "workspaces"))).toBe(
        true,
      );
      expect(path.basename(cfg2.storage.dataDbPath ?? "")).toBe("graph.sqlite");

      // 3) İkisi de yokken ~/.causoryn üçüncü öncelik + CAUSORYN_CONFIG içindeki açık alanlar korunur
      const cfg3 = buildWorkspaceAutoConfig({
        roots: [sandbox.projectADir],
        autoDataDir: true,
        homeDir: sandbox.fakeHome,
        env: {},
        rawBaseConfig: {
          workspaceId: "custom-ws-id",
          results: { maxNodes: 42, maxSymbols: 21, maxDepth: 2, maxPaths: 10 },
        },
      });
      expect(cfg3.workspaceId).toBe("custom-ws-id");
      expect(cfg3.results.maxNodes).toBe(42);
      expect(
        cfg3.storage.dataDbPath?.startsWith(path.join(sandbox.fakeHome, ".causoryn", "workspaces")),
      ).toBe(true);

      // Gerçek CausorynContext ile açılıp kapanabilmeli ve kaynak ağaca hiçbir şey yazmamalı!
      const ctx = createCausorynContext(cfg1, { logger: () => {} });
      ctx.close();
      expect(existsSync(cfg1.storage.dataDbPath as string)).toBe(true);
      expect(listTreeRelative(sandbox.projectADir)).toEqual(treeBefore);
    } finally {
      sandbox.cleanup();
    }
  });

  it("veri dizini yetkili workspace kökünün içindeyse tek bir dizin bile oluşturmadan CausorynConfigError fırlatır", () => {
    const sandbox = createTempSandbox();
    try {
      const treeBefore = listTreeRelative(sandbox.projectADir);
      const illegalInsideWorkspace = path.join(sandbox.projectADir, ".causoryn-illegal");

      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: illegalInsideWorkspace,
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);

      // Kaynak ağaçta .causoryn-illegal dahil hiçbir klasör/dosya oluşmamış olmalı!
      expect(existsSync(illegalInsideWorkspace)).toBe(false);
      expect(listTreeRelative(sandbox.projectADir)).toEqual(treeBefore);
    } finally {
      sandbox.cleanup();
    }
  });

  it("baseDataDir sembolik bağ/junction olduğunda veya workspace içine işaret eden dangling symlink/junction üst dizini içerdiğinde mkdirSync öncesi CausorynConfigError fırlatır", () => {
    const sandbox = createTempSandbox();
    try {
      const treeBefore = listTreeRelative(sandbox.projectADir);
      const symlinkType = process.platform === "win32" ? "junction" : "dir";

      const directLinkToExternal = path.join(sandbox.rootDir, "symlink-base-data");
      try {
        symlinkSync(sandbox.dataDir, directLinkToExternal, symlinkType);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
          return;
        }
        throw err;
      }

      // 1) baseDataDir doğrudan sembolik bağ / junction ise (hedef workspace dışında olsa bile) CWE-59 gereği reddedilmeli!
      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: directLinkToExternal,
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);
      expect(existsSync(path.join(sandbox.dataDir, "workspaces"))).toBe(false);

      // 2) baseDataDir'in bir üst dizini sembolik bağ / junction olup workspace içine çıkıyorsa mkdirSync ÖNCESİ reddedilmeli!
      const junctionIntoWorkspace = path.join(sandbox.rootDir, "junction-into-workspace");
      symlinkSync(sandbox.projectADir, junctionIntoWorkspace, symlinkType);
      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: path.join(junctionIntoWorkspace, "sneaky-subdir"),
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);
      expect(existsSync(path.join(sandbox.projectADir, "sneaky-subdir"))).toBe(false);

      // 3) Dangling symlink/junction: hedef dizin henüz diskte yokken workspace içine işaret ediyorsa
      // mkdirSync(recursive:true) hedefi workspace içinde YARATMADAN ÖNCE reddedilmeli!
      const transientTargetInWorkspace = path.join(sandbox.projectADir, "dangling-escape-dir");
      mkdirSync(transientTargetInWorkspace, { recursive: true });
      const danglingJunction = path.join(sandbox.rootDir, "dangling-junction");
      symlinkSync(transientTargetInWorkspace, danglingJunction, symlinkType);
      rmSync(transientTargetInWorkspace, { recursive: true, force: true });
      expect(existsSync(transientTargetInWorkspace)).toBe(false);

      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: path.join(danglingJunction, "nested-auto-data"),
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);

      expect(existsSync(transientTargetInWorkspace)).toBe(false);
      expect(listTreeRelative(sandbox.projectADir)).toEqual(treeBefore);
    } finally {
      sandbox.cleanup();
    }
  });

  it("baseDataDir kendisi veya üst önek yolu dizin değilse ya da çok katmanlı derin alt yolla workspace içine giriyorsa mkdirSync öncesi CausorynConfigError fırlatır", () => {
    const sandbox = createTempSandbox();
    try {
      const treeBefore = listTreeRelative(sandbox.projectADir);

      // 1) baseDataDir doğrudan normal bir dosyaysa assertNotSymlinkDirectory(baseDataDir) ile reddedilmeli
      const fileAsBaseDataDir = path.join(sandbox.rootDir, "base-data-is-file");
      writeFileSync(fileAsBaseDataDir, "not-a-directory\n", "utf8");
      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: fileAsBaseDataDir,
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);

      // 2) baseDataDir henüz var olmayan alt dizin olup üst öneki normal bir dosyaysa önek tarayıcısı mkdirSync öncesi reddetmeli
      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: path.join(fileAsBaseDataDir, "nested", "auto-data"),
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);

      // 3) Çok katmanlı henüz var olmayan alt yol (workspace/a/b/c) üst önek realpath kontrolüyle tek klasör açılmadan reddedilmeli
      const deepInsideWorkspace = path.join(sandbox.projectADir, "deep-a", "deep-b", "deep-c");
      expect(() =>
        buildWorkspaceAutoConfig({
          roots: [sandbox.projectADir],
          autoDataDir: true,
          dataDir: deepInsideWorkspace,
          homeDir: sandbox.fakeHome,
        }),
      ).toThrow(CausorynConfigError);
      expect(existsSync(path.join(sandbox.projectADir, "deep-a"))).toBe(false);
      expect(listTreeRelative(sandbox.projectADir)).toEqual(treeBefore);
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("createCausorynMcpServer — outputSchemaProfile ve beforeToolCall", { timeout: 30_000 }, () => {
  it("varsayılan full modda outputSchema yayınlar; omit modunda gizler ama sunucu tarafında Zod doğrulamayı ve beforeToolCall kancasını çalıştırır", async () => {
    const fullCtx = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: false },
      { logger: () => {} },
    );
    const omitLogs: string[] = [];
    const omitCtx = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: false },
      { logger: (msg) => omitLogs.push(msg) },
    );
    const seenToolCalls: string[] = [];

    const fullServer = createCausorynMcpServer(fullCtx);
    const omitServer = createCausorynMcpServer(omitCtx, {
      outputSchemaProfile: "omit",
      beforeToolCall: async (toolName) => {
        seenToolCalls.push(toolName);
      },
    });

    const [fullClientTx, fullServerTx] = InMemoryTransport.createLinkedPair();
    const [omitClientTx, omitServerTx] = InMemoryTransport.createLinkedPair();
    const fullClient = new Client({ name: "full-client", version: "0.1.0" });
    const omitClient = new Client({ name: "omit-client", version: "0.1.0" });

    await fullServer.connect(fullServerTx);
    await fullClient.connect(fullClientTx);
    await omitServer.connect(omitServerTx);
    await omitClient.connect(omitClientTx);

    try {
      const fullList = await fullClient.listTools();
      const omitList = await omitClient.listTools();

      expect(fullList.tools.length).toBe(29);
      expect(omitList.tools.length).toBe(29);
      for (const tool of fullList.tools) {
        expect(tool.outputSchema).toBeDefined();
      }
      for (const tool of omitList.tools) {
        expect(tool.outputSchema).toBeUndefined();
      }

      // Tel yükü karşılaştırması: omit modunda tools/list belirgin biçimde daha küçüktür.
      const fullBytes = JSON.stringify(fullList).length;
      const omitBytes = JSON.stringify(omitList).length;
      expect(omitBytes).toBeLessThan(fullBytes * 0.65);

      // Araç çağrısı: beforeToolCall çalışır ve geçerli envelope döner.
      const capRes = (await omitClient.callTool({
        name: "causoryn_get_capabilities",
        arguments: {},
      })) as CallToolResult;
      expect(seenToolCalls).toEqual(["causoryn_get_capabilities"]);
      expect(EnvelopeSchema.safeParse(capRes.structuredContent).success).toBe(true);

      // Sunucu tarafı outputSchema.parse doğrulama kanıtı (omit modunda bile aktif):
      // config.index.maxFiles değerini şema-dışı negatif sayıya bozduğumuzda
      // causoryn_get_capabilities CapabilitiesDataSchema positive() kısıtına takılır
      // ve bozuk veri istemciye sızmadan INTERNAL_ERROR döner!
      (omitCtx.config.index as { maxFiles: number }).maxFiles = -5;
      const brokenRes = (await omitClient.callTool({
        name: "causoryn_get_capabilities",
        arguments: {},
      })) as CallToolResult;
      const brokenEnv = brokenRes.structuredContent as {
        status?: string;
        error?: { code?: string };
      };
      expect(brokenEnv.status).toBe("error");
      expect(brokenEnv.error?.code).toBe("INTERNAL_ERROR");
      expect(omitLogs.some((line) => line.includes("causoryn_get_capabilities"))).toBe(true);
    } finally {
      await fullClient.close();
      await fullServer.close();
      await omitClient.close();
      await omitServer.close();
      fullCtx.close();
      omitCtx.close();
    }
  });
});

describe("DynamicCausorynContext + attachMcpRootsWorkspaceBinder — dinamik MCP roots/list bağlaması", { timeout: 30_000 }, () => {
  it("reddedilen cwd ($HOME / PLUGIN_DIR) ile allowRoots:[] başlar; istemci roots/list üzerinden ilk güvenli file:// kökünü bağlar ve roots/list_changed ile canlı geçiş yapar", async () => {
    const sandbox = createTempSandbox();
    try {
      let closedCount = 0;
      const baseInitial = createCausorynContext(
        { allowRoots: [], autoIndex: true },
        { logger: () => {} },
      );
      const origClose = baseInitial.close;
      const trackedInitial = {
        ...baseInitial,
        close: () => {
          closedCount += 1;
          origClose();
        },
      };

      const dynamicContext = createDynamicCausorynContext(trackedInitial);
      const hookRef: { current?: (toolName: string) => Promise<void> } = {};
      const server = createCausorynMcpServer(dynamicContext, {
        outputSchemaProfile: "omit",
        beforeToolCall: async (toolName) => {
          await hookRef.current?.(toolName);
        },
      });

      const binderLogs: string[] = [];
      const binder = attachMcpRootsWorkspaceBinder(server, dynamicContext, {
        allowCwd: true,
        cwd: sandbox.fakeHome, // $HOME -> isSafeProjectRoot reddeder!
        autoDataDir: true,
        dataDir: sandbox.dataDir,
        client: "antigravity",
        homeDir: sandbox.fakeHome,
        scriptPath: path.join(sandbox.pluginDir, "scripts", "mcp-server.mjs"),
        logger: (msg) => binderLogs.push(msg),
      });
      hookRef.current = binder.beforeToolCall;

      // Bağlantı öncesi allowRoots boş kalmalı (güvenli başlangıç).
      expect(dynamicContext.config.allowRoots).toEqual([]);

      // İstemci ilk başta güvensiz kök dizin + $HOME + pluginDir + güvenli projectADir bildirir:
      // sunucu güvensizleri atlayıp ilk güvenli kök olan projectADir'i seçmelidir.
      let advertisedRoots = [
        { uri: pathToFileURL(path.parse(sandbox.rootDir).root).href, name: "fs-root" },
        { uri: pathToFileURL(sandbox.fakeHome).href, name: "home" },
        { uri: pathToFileURL(sandbox.pluginDir).href, name: "plugin" },
        { uri: pathToFileURL(sandbox.projectADir).href, name: "alpha" },
      ];
      let listRootsCallCount = 0;

      const client = new Client(
        { name: "desktop-ide-client", version: "1.0.0" },
        { capabilities: { roots: { listChanged: true } } },
      );
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        listRootsCallCount += 1;
        return { roots: advertisedRoots };
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      try {
        // İlk araç çağrısı: single-flight senkronizasyon tamamlanır ve alpha-service bağlanır!
        const summaryA = (await client.callTool({
          name: "causoryn_workspace_summary",
          arguments: { workspaceId: "alpha-service" },
        })) as CallToolResult;
        const envA = summaryA.structuredContent as {
          status?: string;
          workspaceId?: string;
        };
        expect(envA.status, JSON.stringify({ envA, binderLogs })).toBe("ok");
        expect(envA.workspaceId).toBe("alpha-service");
        expect(closedCount).toBe(1); // İlk boş context kapatıldı
        expect(listRootsCallCount).toBe(1); // Single-flight: tek listRoots çağrısı!

        const alphaSym = (await client.callTool({
          name: "causoryn_find_symbols",
          arguments: { workspaceId: "alpha-service", query: "computeAlphaScore" },
        })) as CallToolResult;
        const alphaData = (alphaSym.structuredContent as { data?: { hits?: unknown[] } }).data;
        expect((alphaData?.hits ?? []).length).toBeGreaterThan(0);

        // Ardışık araç çağrısı gereksiz ikinci listRoots yapmamalı.
        expect(listRootsCallCount).toBe(1);

        // Şimdi IDE'de kullanıcı klasör değiştirir -> notifications/roots/list_changed!
        advertisedRoots = [{ uri: pathToFileURL(sandbox.projectBDir).href, name: "beta" }];
        await client.sendRootsListChanged();

        const betaSym = (await client.callTool({
          name: "causoryn_find_symbols",
          arguments: { workspaceId: "beta-billing", query: "settleBetaInvoice" },
        })) as CallToolResult;
        const betaEnv = betaSym.structuredContent as {
          status?: string;
          workspaceId?: string;
          data?: { hits?: unknown[] };
        };
        expect(betaEnv.status).toBe("ok");
        expect(betaEnv.workspaceId).toBe("beta-billing");
        expect((betaEnv.data?.hits ?? []).length).toBeGreaterThan(0);
        expect(listRootsCallCount).toBe(2);
      } finally {
        await client.close();
        await server.close();
        dynamicContext.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it("~/.gemini/extensions/causoryn ve CLAUDE_PLUGIN_ROOT altındaki Git klonu monorepo cwd'sini reddedip MCP roots/list ile gerçek projeyi dinamik bağlar", async () => {
    const sandbox = createTempSandbox();
    try {
      const makeClonedRepo = (dir: string): string => {
        mkdirSync(path.join(dir, "packages", "mcp-server", "src"), { recursive: true });
        writeFileSync(path.join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
        writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ name: "causoryn", private: true, workspaces: ["packages/*"] }),
          "utf8",
        );
        writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "causoryn" }), "utf8");
        const entry = path.join(dir, "packages", "mcp-server", "src", "stdio.ts");
        writeFileSync(entry, "// entry\n", "utf8");
        return entry;
      };

      const geminiCloneDir = path.join(sandbox.fakeHome, ".gemini", "extensions", "causoryn");
      const geminiScript = makeClonedRepo(geminiCloneDir);
      const claudeCloneDir = path.join(sandbox.rootDir, "claude-marketplace-clone");
      makeClonedRepo(claudeCloneDir);

      const dynamicContext = createDynamicCausorynContext(
        createCausorynContext({ allowRoots: [], autoIndex: true }, { logger: () => {} }),
      );
      try {
        const hookRef: { current?: (toolName: string) => Promise<void> } = {};
        const server = createCausorynMcpServer(dynamicContext, {
          outputSchemaProfile: "omit",
          beforeToolCall: async (toolName) => {
            await hookRef.current?.(toolName);
          },
        });

        const binderLogs: string[] = [];
        const binder = attachMcpRootsWorkspaceBinder(server, dynamicContext, {
          allowCwd: true,
          cwd: geminiCloneDir,
          autoDataDir: true,
          dataDir: sandbox.dataDir,
          client: "antigravity",
          homeDir: sandbox.fakeHome,
          scriptPath: geminiScript,
          env: { CLAUDE_PLUGIN_ROOT: claudeCloneDir },
          logger: (msg) => binderLogs.push(msg),
        });
        hookRef.current = binder.beforeToolCall;

        // Git klonu plugin dizini cwd olarak reddedilmiş olmalı!
        expect(dynamicContext.config.allowRoots).toEqual([]);
        expect(binderLogs.some((m) => m.includes("plugin-install-directory"))).toBe(true);

        const client = new Client(
          { name: "antigravity-git-plugin-host", version: "1.0.0" },
          { capabilities: { roots: { listChanged: true } } },
        );
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [
            { uri: pathToFileURL(geminiCloneDir).href, name: "gemini-plugin" },
            { uri: pathToFileURL(claudeCloneDir).href, name: "claude-plugin" },
            { uri: pathToFileURL(sandbox.projectADir).href, name: "real-project" },
          ],
        }));

        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTx);
        await client.connect(clientTx);

        try {
          const res = (await client.callTool({
            name: "causoryn_workspace_summary",
            arguments: { workspaceId: "alpha-service" },
          })) as CallToolResult;
          const env = res.structuredContent as { status?: string; workspaceId?: string };
          expect(env.status, JSON.stringify({ env, binderLogs })).toBe("ok");
          expect(env.workspaceId).toBe("alpha-service");
        } finally {
          await client.close();
          await server.close();
        }
      } finally {
        dynamicContext.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it("asılı kalan (hanging) roots/list yanıtında listRootsTimeoutMs (50ms) sonunda takılmadan fail-closed (WORKSPACE_NOT_AUTHORIZED) döner", async () => {
    const sandbox = createTempSandbox();
    try {
      const dynamicContext = createDynamicCausorynContext(
        createCausorynContext({ allowRoots: [], autoIndex: true }, { logger: () => {} }),
      );
      const hookRef: { current?: (toolName: string) => Promise<void> } = {};
      const server = createCausorynMcpServer(dynamicContext, {
        outputSchemaProfile: "omit",
        beforeToolCall: async (toolName) => {
          await hookRef.current?.(toolName);
        },
      });

      const binderLogs: string[] = [];
      const binder = attachMcpRootsWorkspaceBinder(server, dynamicContext, {
        allowCwd: true,
        cwd: sandbox.fakeHome,
        homeDir: sandbox.fakeHome,
        listRootsTimeoutMs: 50,
        logger: (msg) => binderLogs.push(msg),
      });
      hookRef.current = binder.beforeToolCall;

      const client = new Client(
        { name: "hanging-roots-client", version: "1.0.0" },
        { capabilities: { roots: { listChanged: true } } },
      );
      client.setRequestHandler(
        ListRootsRequestSchema,
        () => new Promise<{ roots: never[] }>(() => {}),
      );

      const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTx);
      await client.connect(clientTx);

      try {
        const startMs = performance.now();
        const res = (await client.callTool({
          name: "causoryn_workspace_summary",
          arguments: {},
        })) as CallToolResult;
        const elapsedMs = performance.now() - startMs;

        // Varsayılan 5000ms yerine 50ms timeout ile hızla sonuçlanmalı ve fail-closed kalmalı!
        expect(elapsedMs).toBeLessThan(1_000);
        const env = res.structuredContent as {
          status?: string;
          error?: { code?: string };
        };
        expect(env.status).toBe("error");
        expect(env.error?.code).toBe("WORKSPACE_NOT_AUTHORIZED");
        expect(dynamicContext.config.allowRoots).toEqual([]);
      } finally {
        await client.close();
        await server.close();
        dynamicContext.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("stdio.ts — gerçek alt-süreç CLI modları ve geriye dönük uyumluluk", { timeout: 180_000 }, () => {
  it("geçersiz CLI bayrağında sıfır stdout ve exit code 2 ile stderr üzerinden çıkar", async () => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        pathToFileURL(LOADER_ENTRY).href,
        STDIO_ENTRY,
        "--invalid-flag",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin?.end();

    const guard = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(guard);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("createCausorynContext: storage.dataDbPath beyanlıyken çoklu-süreç SQLite yarış kurtarmasını etkinleştirir", () => {
    const sandbox = createTempSandbox();
    try {
      const dbPath = path.join(sandbox.dataDir, "shared-context.sqlite");
      const rawCfg = {
        workspaceId: "alpha-service",
        allowRoots: [sandbox.projectADir],
        autoIndex: false,
        storage: { dataDbPath: dbPath },
      };
      const ctxA = createCausorynContext(rawCfg, { logger: () => {} });
      const ctxB = createCausorynContext(rawCfg, { logger: () => {} });
      try {
        const resA = ctxA.indexService.runIndex(sandbox.projectADir);
        expect(resA.published).toBe(true);
        const resB = ctxB.indexService.runIndex(sandbox.projectADir);
        expect(resB.published).toBe(false);
        expect(resB.snapshotId).toBe(resA.snapshotId);
        expect(resB.stale).toBe(false);
      } finally {
        ctxA.close();
        ctxB.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it("mcp --allow-cwd --auto-data-dir --client zcode ile güvenli proje cwd'sini otomatik bağlar, omit profili kullanır ve stdout'u saf JSON-RPC tutar", async () => {
    const sandbox = createTempSandbox();
    try {
      const treeBefore = listTreeRelative(sandbox.projectADir);
      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--import",
          pathToFileURL(LOADER_ENTRY).href,
          STDIO_ENTRY,
          "mcp",
          "--allow-cwd",
          "--auto-data-dir",
          "--data-dir",
          sandbox.dataDir,
          "--client",
          "zcode",
        ],
        {
          cwd: sandbox.projectADir,
          env: {
            ...process.env,
            CAUSORYN_CONFIG: "",
            CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const pending = new Map<
        number,
        { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
      >();
      const waitFor = (id: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });

      const pInit = waitFor(1);
      const pList = waitFor(2);
      const pSummary = waitFor(3);

      let sent = false;
      const sendHandshake = (): void => {
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
              clientInfo: { name: "cli-stdio-test", version: "0.1.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "causoryn_workspace_summary",
              arguments: { workspaceId: "alpha-service" },
            },
          },
        ];
        for (const frame of frames) {
          child.stdin?.write(`${JSON.stringify(frame)}\n`);
        }
      };

      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 150_000);

      const exitPromise = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });

      child.on("close", () => {
        for (const entry of pending.values()) {
          entry.reject(new Error("stdio child erken kapandı"));
        }
        pending.clear();
      });

      let stdoutBuffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let idx = stdoutBuffer.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          idx = stdoutBuffer.indexOf("\n");
          if (line.length === 0) continue;
          stdoutLines.push(line);
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = typeof msg["id"] === "number" ? msg["id"] : undefined;
          if (id !== undefined && pending.has(id)) {
            pending.get(id)?.resolve(msg);
            pending.delete(id);
          }
        }
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        for (const rawLine of chunk.split("\n")) {
          const trimmed = rawLine.trim();
          if (trimmed.length === 0) continue;
          stderrLines.push(trimmed);
          if (trimmed.includes(READY_MARKER)) {
            sendHandshake();
          }
        }
      });

      const [initMsg, listMsg, summaryMsg] = await Promise.all([pInit, pList, pSummary]);
      child.stdin?.end();
      const exitCode = await exitPromise;
      clearTimeout(killTimer);

      expect(exitCode).toBe(0);
      expect(stdoutLines.length).toBe(3);
      for (const line of stdoutLines) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }
      expect(initMsg["id"]).toBe(1);

      // CLI aktivasyonunda varsayılan outputSchemaProfile === "omit" olmalı.
      const tools = (
        listMsg["result"] as { tools?: Array<{ name?: string; outputSchema?: unknown }> }
      ).tools ?? [];
      expect(tools.length).toBe(29);
      expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);

      // Workspace otomatik bağlandı ve indeks hazır!
      const callResult = summaryMsg["result"] as {
        isError?: boolean;
        structuredContent?: { status?: string; workspaceId?: string };
      };
      expect(callResult.isError).toBeFalsy();
      expect(callResult.structuredContent?.status).toBe("ok");
      expect(callResult.structuredContent?.workspaceId).toBe("alpha-service");

      // SQLite dosyası workspace DIŞINDA oluştu; kaynak ağaca dokunulmadı!
      const workspacesParent = path.join(sandbox.dataDir, "workspaces");
      const entries = readdirSync(workspacesParent);
      expect(entries.length).toBe(1);
      const wsDirName = entries[0] as string;
      expect(wsDirName.startsWith("alpha-service-")).toBe(true);
      expect(existsSync(path.join(workspacesParent, wsDirName, "graph-zcode.sqlite"))).toBe(true);
      expect(listTreeRelative(sandbox.projectADir)).toEqual(treeBefore);
    } finally {
      sandbox.cleanup();
    }
  });

  it("çıplak stdio.ts (0 CLI argümanı, CAUSORYN_CONFIG yok): proje dizininde bile allowRoots:[] default deny ve full outputSchema profilini korur", async () => {
    const sandbox = createTempSandbox();
    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv["CAUSORYN_CONFIG"];
      delete childEnv["CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE"];

      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--import",
          pathToFileURL(LOADER_ENTRY).href,
          STDIO_ENTRY,
        ],
        {
          cwd: sandbox.projectADir,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const pending = new Map<
        number,
        { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
      >();
      const waitFor = (id: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });

      const pInit = waitFor(1);
      const pList = waitFor(2);
      const pSummary = waitFor(3);

      let sent = false;
      const sendFrames = (): void => {
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
              clientInfo: { name: "bare-stdio-test", version: "0.1.0" },
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
        ];
        for (const frame of frames) {
          child.stdin?.write(`${JSON.stringify(frame)}\n`);
        }
      };

      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 150_000);
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      child.on("close", () => {
        for (const entry of pending.values()) {
          entry.reject(new Error("bare stdio erken kapandı"));
        }
        pending.clear();
      });

      let stdoutBuffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let idx = stdoutBuffer.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          idx = stdoutBuffer.indexOf("\n");
          if (line.length === 0) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = typeof msg["id"] === "number" ? msg["id"] : undefined;
          if (id !== undefined && pending.has(id)) {
            pending.get(id)?.resolve(msg);
            pending.delete(id);
          }
        }
      });

      let bareStderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        bareStderr += chunk;
        if (bareStderr.includes(READY_MARKER)) {
          sendFrames();
        }
      });

      const [, listMsg, summaryMsg] = await Promise.all([pInit, pList, pSummary]);
      child.stdin?.end();
      const exitCode = await exitPromise;
      clearTimeout(killTimer);

      expect(exitCode).toBe(0);
      const tools = (
        listMsg["result"] as { tools?: Array<{ name?: string; outputSchema?: unknown }> }
      ).tools ?? [];
      expect(tools.length).toBe(29);
      expect(tools.every((t) => t.outputSchema !== undefined)).toBe(true);

      const summaryEnv = (
        summaryMsg["result"] as {
          structuredContent?: { status?: string; error?: { code?: string } };
        }
      ).structuredContent;
      expect(summaryEnv?.status).toBe("error");
      expect(summaryEnv?.error?.code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      sandbox.cleanup();
    }
  });

  it("masaüstü IDE stdio.ts: cwd=$HOME reddedildiğinde JSON-RPC roots/list üzerinden projeyi dinamik bağlar", async () => {
    const sandbox = createTempSandbox();
    try {
      const childEnv: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        const upper = k.toUpperCase();
        if (
          upper === "HOME" ||
          upper === "USERPROFILE" ||
          upper === "HOMEDRIVE" ||
          upper === "HOMEPATH" ||
          upper === "CAUSORYN_CONFIG"
        ) {
          continue;
        }
        childEnv[k] = v;
      }
      childEnv["HOME"] = sandbox.fakeHome;
      childEnv["USERPROFILE"] = sandbox.fakeHome;

      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--import",
          pathToFileURL(LOADER_ENTRY).href,
          STDIO_ENTRY,
          "mcp",
          "--allow-cwd",
          "--data-dir",
          sandbox.dataDir,
        ],
        {
          cwd: sandbox.fakeHome,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      const pending = new Map<
        number,
        { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
      >();
      const waitFor = (id: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
        });

      const pInit = waitFor(10);
      const pSummary = waitFor(11);

      let sent = false;
      const sendFrames = (): void => {
        if (sent) return;
        sent = true;
        const frames = [
          {
            jsonrpc: "2.0",
            id: 10,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: { roots: { listChanged: true } },
              clientInfo: { name: "ide-stdio-test", version: "0.1.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: {
              name: "causoryn_workspace_summary",
              arguments: { workspaceId: "alpha-service" },
            },
          },
        ];
        for (const frame of frames) {
          child.stdin?.write(`${JSON.stringify(frame)}\n`);
        }
      };

      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 150_000);
      const exitPromise = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      child.on("close", () => {
        for (const entry of pending.values()) {
          entry.reject(new Error("ide stdio erken kapandı"));
        }
        pending.clear();
      });

      let stdoutBuffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let idx = stdoutBuffer.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          idx = stdoutBuffer.indexOf("\n");
          if (line.length === 0) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          // Sunucudan istemciye gelen roots/list isteğini yanıtla!
          if (msg["method"] === "roots/list" && msg["id"] !== undefined) {
            const reply = {
              jsonrpc: "2.0",
              id: msg["id"],
              result: {
                roots: [{ uri: pathToFileURL(sandbox.projectADir).href, name: "alpha" }],
              },
            };
            child.stdin?.write(`${JSON.stringify(reply)}\n`);
            continue;
          }
          const id = typeof msg["id"] === "number" ? msg["id"] : undefined;
          if (id !== undefined && pending.has(id)) {
            pending.get(id)?.resolve(msg);
            pending.delete(id);
          }
        }
      });

      let ideStderrRaw = "";
      const ideStderr: string[] = [];
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        ideStderrRaw += chunk;
        ideStderr.push(chunk.trim());
        if (ideStderrRaw.includes(READY_MARKER)) {
          sendFrames();
        }
      });

      const [, summaryMsg] = await Promise.all([pInit, pSummary]);
      child.stdin?.end();
      const exitCode = await exitPromise;
      clearTimeout(killTimer);

      expect(exitCode).toBe(0);
      const summaryEnv = (
        summaryMsg["result"] as {
          structuredContent?: { status?: string; workspaceId?: string };
        }
      ).structuredContent;
      expect(summaryEnv?.status, JSON.stringify({ summaryEnv, ideStderr })).toBe("ok");
      expect(summaryEnv?.workspaceId).toBe("alpha-service");
    } finally {
      sandbox.cleanup();
    }
  });

  it("göreli ZCODE_PLUGIN_DATA değerini --data-dir ile simetrik olarak fail-closed reddeder", () => {
    const sandbox = createTempSandbox();
    try {
      expect(() =>
        resolveBaseDataDir({
          homeDir: sandbox.fakeHome,
          env: { ZCODE_PLUGIN_DATA: "relative-zcode-data" },
        }),
      ).toThrow(/ZCODE_PLUGIN_DATA mutlak yol olmalı/);
    } finally {
      sandbox.cleanup();
    }
  });
});
