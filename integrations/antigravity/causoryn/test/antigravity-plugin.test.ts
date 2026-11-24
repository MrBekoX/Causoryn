import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CausorynConfigError,
  CORE_TOOL_NAMES,
  parseCausorynServerConfig,
  SCHEMA_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
} from "@causoryn/mcp-server";

/**
 * Antigravity host eklenti paketi testleri:
 * - plugin.json (yerel Antigravity yükleyicisi izinli alan şeması — $schema yok)
 * - mcp_config.json (yerel Antigravity eklenti keşfi birincil dosyası)
 * - mcp.json (TŞ v2.1 §17.1 taşınabilir manifest karşılığı, PLUGIN_ROOT token + /scripts/mcp-server.mjs)
 * - README.md (kullanıcı dokümanı + dürüst NOT RUN beyanı)
 * - Sahnelenmiş scripts/mcp-server.mjs üzerinde gerçek child_process.spawn stdio el sıkışması
 * - docs/hosts/antigravity.md dürüstlük ve denetim gardları (TŞ §17.1, §17.4, §22, ADR-010)
 */

/** Üst-dizin çift-nokta dizgesi kaynakta tek parça string literal olarak yazılmaz (güvenlik kuralı). */
const DOT_DOT = "." + ".";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  DOT_DOT,
  DOT_DOT,
  DOT_DOT,
  DOT_DOT,
);

const PLUGIN_DIR = path.join(REPO_ROOT, "integrations", "antigravity", "causoryn");
const PLUGIN_JSON_PATH = path.join(PLUGIN_DIR, "plugin.json");
const MCP_CONFIG_JSON_PATH = path.join(PLUGIN_DIR, "mcp_config.json");
const MCP_JSON_PATH = path.join(PLUGIN_DIR, "mcp.json");
const README_PATH = path.join(PLUGIN_DIR, "README.md");
const DOC_PATH = path.join(REPO_ROOT, "docs", "hosts", "antigravity.md");

const STAGED_SCRIPTS_DIR = path.join(PLUGIN_DIR, "scripts");
const STAGED_BUNDLE_PATH = path.join(STAGED_SCRIPTS_DIR, "mcp-server.mjs");
const STAGED_MANIFEST_PATH = path.join(STAGED_SCRIPTS_DIR, "bundle-manifest.json");
const STAGED_VENDOR_PKG_PATH = path.join(
  STAGED_SCRIPTS_DIR,
  "node_modules",
  "better-sqlite3",
  "package.json",
);

/**
 * Yerleşik Antigravity eklenti yükleyicisinin (plugin/SKILL.md:228-266)
 * izin verdiği üst-düzey plugin.json anahtarları. Bilinmeyen üst-düzey
 * alanlar ($schema, mcpServers vb.) yükleyici tarafından sessizce atıldığı
 * için doğrulayıcı bunları açık hatayla reddeder.
 */
const ALLOWED_PLUGIN_KEYS: ReadonlySet<string> = new Set([
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

/** TŞ §17.1 örnek manifest'inin önerilen prompt'ları — birebir üçlü. */
const EXPECTED_SUGGESTED_PROMPTS = [
  "Map this workspace and show evidence for critical dependencies",
  "Run a change preflight for the selected endpoint",
  "Verify my working-tree changes against architecture contracts",
] as const;

/**
 * Dürüstlük beyanı — birebir metin. Dokümanda AYNEN bu cümle bulunmalıdır;
 * agy CLI bulunamadığından kurulum/smoke koşulmamıştır.
 */
const NOT_RUN_STATEMENT = "agy CLI bulunamadı — bu hostta kurulum/smoke koşulmadı";

/**
 * Plugin manifest'inde YASAK kalıplar (görev sözleşmesi): manifest hiçbir
 * kimlik bilgisi taşıyamaz; tüm yetkilendirme CAUSORYN_CONFIG ile
 * kullanıcı beyanıdır (TŞ §9/§20 default deny).
 */
const CREDENTIAL_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

/** Negatif yüzey taraması kalıpları (tests/hosts-docs.test.ts ile birebir). */
const ROOT_GRANT =
  /allowRoots["']?\s*:\s*\[\s*["']?(\/|[A-Za-z]:[\/\\]?)["']?\s*\]/;
const SECRET =
  /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,})/;
const SINGLE_FILE_CLAIM =
  /(tek[- ]dosya dağıt|single[- ]file (distribution|bundle))/i;

/** "dolar süslü" kalıbı: kaynakta tek parça yazılmaz (güvenlik taraması;
 * zcode plugin testi konvansiyonu — bulgu 5). */
const DOLLAR_BRACE = "$" + "{";
/** Plugin kök token'ı — Antigravity taşınabilir manifest şeması (TŞ §17.1). */
const PLUGIN_ROOT_TOKEN = DOLLAR_BRACE + "PLUGIN_ROOT}";

const EXPECTED_SERVER_KEY = "causoryn";
const EXPECTED_LOCAL_ENTRY = "scripts/mcp-server.mjs";
const EXPECTED_PORTABLE_ENTRY = `${PLUGIN_ROOT_TOKEN}/${EXPECTED_LOCAL_ENTRY}`;
const READY_MARKER = "causoryn mcp server hazir";

/* ------------------------------------------------------------------ */
/* Yardımcılar: katı JSON parse + şema doğrulayıcılar                  */
/* ------------------------------------------------------------------ */

function parseJsonStrict(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: JSON parse başarısız — ${reason}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface AntigravityPluginManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  suggestedPrompts: string[];
  logo?: string;
  author?: string | { name: string; url?: string };
  homepage?: string;
  repository?: string | { type: string; url: string };
  disabled?: boolean;
}

export interface AntigravityMcpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AntigravityMcpManifest {
  mcpServers: Record<string, AntigravityMcpServerEntry>;
}

export type McpManifestMode = "portable" | "local";

/**
 * Antigravity plugin.json alan sözleşmesi (plugin/SKILL.md + TŞ §17.1):
 * - Yalnızca ALLOWED_PLUGIN_KEYS içindeki üst-düzey alanlara izin verilir
 *   ($schema ve mcpServers dahil bilinmeyen alanlar açıkça reddedilir).
 * - Zorunlu Causoryn alanları doğrulanır.
 */
function validatePluginManifest(value: unknown, label: string): AntigravityPluginManifest {
  const rec = asRecord(value);
  if (rec === undefined) {
    throw new Error(`${label}: manifest bir JSON nesnesi olmalı`);
  }
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_PLUGIN_KEYS.has(key)) {
      if (key === "mcpServers") {
        throw new Error(
          `${label}: plugin.json mcpServers TAŞIMAZ — sunucu kablolaması mcp_config.json / mcp.json dosyasındadır`,
        );
      }
      throw new Error(
        `${label}: izin verilmeyen üst-düzey alan "${key}" — yerel Antigravity yükleyicisi bilinmeyen alanları sessizce atar`,
      );
    }
  }
  const stringFields: ReadonlyArray<[string, string]> = [
    ["name", "causoryn"],
    ["displayName", "Causoryn"],
  ];
  for (const [field, expected] of stringFields) {
    const actual = rec[field];
    if (typeof actual !== "string" || actual.length === 0) {
      throw new Error(`${label}: zorunlu string alan eksik veya boş — "${field}"`);
    }
    if (actual !== expected) {
      throw new Error(
        `${label}: "${field}" beklenen "${expected}", gelen "${actual}" (TŞ §17.1)`,
      );
    }
  }
  if (typeof rec.version !== "string" || !/^\d+\.\d+\.\d+$/.test(rec.version)) {
    throw new Error(`${label}: "version" semver olmalı (TŞ §17.1 örneği 0.2.0)`);
  }
  if (typeof rec.description !== "string" || rec.description.length === 0) {
    throw new Error(`${label}: "description" zorunlu (TŞ §17.1)`);
  }
  const prompts = rec.suggestedPrompts;
  if (
    !Array.isArray(prompts) ||
    prompts.length !== EXPECTED_SUGGESTED_PROMPTS.length ||
    prompts.some((p) => typeof p !== "string" || p.length === 0)
  ) {
    throw new Error(
      `${label}: "suggestedPrompts" TŞ §17.1 üçlüsüyle eşit uzunlukta string dizisi olmalı`,
    );
  }
  return rec as unknown as AntigravityPluginManifest;
}

/**
 * Antigravity MCP manifest doğrulayıcısı:
 * - mode === "local"    → mcp_config.json ("scripts/mcp-server.mjs" eklenti-içi göreli yol)
 * - mode === "portable" → mcp.json (PLUGIN_ROOT token + "/scripts/mcp-server.mjs" TŞ §17.1 yolu)
 * - Sunucu anahtarı eklenti adıyla ("causoryn") eşleşmeli; generic "engine" reddedilir.
 * - env.CAUSORYN_CONFIG gerçek sunucu şemasıyla (parseCausorynServerConfig:
 *   z.strictObject + mutlak allowRoots) doğrulanır.
 */
function validateMcpManifest(
  value: unknown,
  label: string,
  mode: McpManifestMode = "portable",
): AntigravityMcpManifest {
  const rec = asRecord(value);
  if (rec === undefined) {
    throw new Error(`${label}: manifest bir JSON nesnesi olmalı`);
  }
  const servers = asRecord(rec.mcpServers);
  if (servers === undefined) {
    throw new Error(`${label}: zorunlu alan eksik — "mcpServers"`);
  }
  if ("engine" in servers) {
    throw new Error(
      `${label}: generic "engine" sunucu anahtarı YASAK — global MCP ad çakışmasını önlemek için "${EXPECTED_SERVER_KEY}" kullanılmalı`,
    );
  }
  const serverEntry = asRecord(servers[EXPECTED_SERVER_KEY]);
  if (serverEntry === undefined) {
    throw new Error(`${label}: mcpServers altında "${EXPECTED_SERVER_KEY}" girdisi yok`);
  }
  if (Object.keys(servers).length !== 1) {
    throw new Error(`${label}: mcpServers yalnızca "${EXPECTED_SERVER_KEY}" sunucusunu tanımlamalı`);
  }
  if (serverEntry.command !== "node") {
    throw new Error(
      `${label}: ${EXPECTED_SERVER_KEY}.command "node" olmalı, gelen "${String(serverEntry.command)}"`,
    );
  }
  const args = serverEntry.args;
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== "string")) {
    throw new Error(`${label}: ${EXPECTED_SERVER_KEY}.args boş olmayan string dizisi olmalı`);
  }
  if (args.some((a) => a === "--data-dir")) {
    throw new Error(
      `${label}: "--data-dir" yayımlanan sunucuda argv olarak OKUNMAZ (stdio.ts) — konfigürasyon CAUSORYN_CONFIG'tir`,
    );
  }
  if (args.some((a) => a.includes("src/") || a.endsWith(".ts"))) {
    throw new Error(
      `${label}: kaynak TS dosyasına işaret YASAK — derlenmiş bundle zorunlu (TŞ §17.1)`,
    );
  }
  if (args.some((a) => a.includes(DOT_DOT))) {
    throw new Error(`${label}: üst-dizin kaçışı (${DOT_DOT}) YASAK — sahnelenmiş scripts/ kullanılmalı`);
  }

  const entry = args[0] as string;
  if (mode === "portable") {
    const requiredPrefix = `${PLUGIN_ROOT_TOKEN}/`;
    if (!entry.startsWith(requiredPrefix)) {
      throw new Error(
        `${label}: ilk arg "${requiredPrefix}" önekiyle başlamalı (yol dilimleme güvenliği, TŞ §17.1)`,
      );
    }
    const relativeAfterToken = entry.slice(requiredPrefix.length);
    if (relativeAfterToken !== EXPECTED_LOCAL_ENTRY) {
      throw new Error(
        `${label}: taşınabilir giriş noktası "${EXPECTED_PORTABLE_ENTRY}" olmalı, gelen "${entry}"`,
      );
    }
  } else {
    if (
      path.isAbsolute(entry) ||
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      /^[A-Za-z]:/.test(entry) ||
      entry.includes(DOLLAR_BRACE)
    ) {
      throw new Error(
        `${label}: yerel giriş noktası eklenti-içi göreli yol olmalı (mutlak yol veya token yasak), gelen "${entry}"`,
      );
    }
    if (entry !== EXPECTED_LOCAL_ENTRY) {
      throw new Error(
        `${label}: yerel giriş noktası "${EXPECTED_LOCAL_ENTRY}" olmalı, gelen "${entry}"`,
      );
    }
  }

  const env = asRecord(serverEntry.env);
  if (env === undefined) {
    throw new Error(
      `${label}: ${EXPECTED_SERVER_KEY}.env eksik — CAUSORYN_CONFIG default-deny beyanı gerekli`,
    );
  }
  const rawConfig = env["CAUSORYN_CONFIG"];
  if (typeof rawConfig !== "string" || rawConfig.length === 0) {
    throw new Error(`${label}: env.CAUSORYN_CONFIG zorunlu`);
  }
  const parsedConfig = asRecord(parseJsonStrict(rawConfig, `${label} CAUSORYN_CONFIG`));
  if (parsedConfig === undefined) {
    throw new Error(`${label}: CAUSORYN_CONFIG bir JSON nesnesi olmalı`);
  }
  if (!Array.isArray(parsedConfig["allowRoots"])) {
    throw new Error(`${label}: CAUSORYN_CONFIG.allowRoots dizi olmalı (default deny: [])`);
  }
  try {
    parseCausorynServerConfig(parsedConfig);
  } catch (error) {
    const reason = error instanceof CausorynConfigError ? error.message : String(error);
    throw new Error(`${label}: CAUSORYN_CONFIG sunucu şemasına uymuyor — ${reason}`);
  }

  return rec as unknown as AntigravityMcpManifest;
}

function readPluginJsonRaw(): string {
  expect(existsSync(PLUGIN_JSON_PATH), "plugin.json mevcut olmalı").toBe(true);
  return readFileSync(PLUGIN_JSON_PATH, "utf8");
}

function readMcpConfigJsonRaw(): string {
  expect(existsSync(MCP_CONFIG_JSON_PATH), "mcp_config.json mevcut olmalı").toBe(true);
  return readFileSync(MCP_CONFIG_JSON_PATH, "utf8");
}

function readMcpJsonRaw(): string {
  expect(existsSync(MCP_JSON_PATH), "mcp.json mevcut olmalı").toBe(true);
  return readFileSync(MCP_JSON_PATH, "utf8");
}

function readReadmeRaw(): string {
  expect(existsSync(README_PATH), "integrations/antigravity/causoryn/README.md mevcut olmalı").toBe(
    true,
  );
  return readFileSync(README_PATH, "utf8");
}

const DIST_BUNDLE_PATH = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "dist",
  "mcp-server.mjs",
);

/**
 * Sahnelenmiş bundle commit edilmez (.gitignore: integrations/antigravity/causoryn/scripts/) —
 * diskte (veya paralel rebuild anında kararlı dist/mcp-server.mjs üzerinde) VARSA gerçek
 * spawn entegrasyon testi tam koşar; ikisi de YOKSA açık skip sebebiyle atlanır.
 */
const STAGED_BUNDLE_PRESENT = existsSync(STAGED_BUNDLE_PATH) || existsSync(DIST_BUNDLE_PATH);
const STAGED_BUNDLE_SKIP_REASON = STAGED_BUNDLE_PRESENT
  ? false
  : ("sahnelenmiş bundle yok — önce npm run build:bundle --workspace packages/mcp-server" as const);

/** mcp.json'daki ilk arg'ın eklenti köküne göre çözümlenmiş yolu. */
function resolvedPortableBundleArg(manifest: AntigravityMcpManifest): string {
  const firstArg = manifest.mcpServers[EXPECTED_SERVER_KEY]?.args[0] ?? "";
  const requiredPrefix = `${PLUGIN_ROOT_TOKEN}/`;
  expect(firstArg.startsWith(requiredPrefix)).toBe(true);
  return path.resolve(PLUGIN_DIR, firstArg.slice(requiredPrefix.length));
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PluginSpawnHandshakeResult {
  readonly exitCode: number | null;
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  readonly responseOf: (id: number) => JsonRpcMessage;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Paralel vitest koşumunda bundle.test.ts yeniden-sahneleme (rmSync + sıralı cpSync)
 * penceresine karşı senkron doğrulama yeniden-deneme yardımcısı.
 */
export function withStagingRetrySync<T>(
  check: () => T,
  options: { readonly attempts?: number; readonly sleep?: (ms: number) => void } = {},
): T {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? sleepSync;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return check();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) sleep(1_500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runMcpConfigHandshakeOnce(
  server: AntigravityMcpServerEntry,
): Promise<PluginSpawnHandshakeResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...server.env };
  const child: ChildProcess = spawn(server.command, server.args, {
    cwd: PLUGIN_DIR,
    env: childEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const responses = new Map<number, JsonRpcMessage>();
  const pending = new Map<number, (message: JsonRpcMessage) => void>();

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`sahnelenmiş bundle hazır olmadı (30s). stderr=${JSON.stringify(stderrLines)}`),
        ),
      30_000,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        stderrLines.push(trimmed);
        if (trimmed.includes(READY_MARKER)) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(
        new Error(
          `sahnelenmiş bundle başlamadan kapandı. stderr=${JSON.stringify(stderrLines)}`,
        ),
      );
    });
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  child.stdout?.setEncoding("utf8");
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      stdoutLines.push(trimmed);
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        const id = typeof message.id === "number" ? message.id : undefined;
        if (id !== undefined && pending.has(id)) {
          pending.get(id)?.(message);
          pending.delete(id);
        }
      } catch {
        // saf olmayan satır: çağıran test stdout saflık assert'inde yakalar
      }
    }
  });

  try {
    await readyPromise;

    const requestCount = 4;
    const allResponses = Promise.all(
      Array.from({ length: requestCount }, (_v, index) => index + 1).map(
        (id) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`id=${String(id)} yanıtı 30s içinde gelmedi`)),
              30_000,
            );
            pending.set(id, (message) => {
              clearTimeout(timer);
              responses.set(id, message);
              resolve();
            });
          }),
      ),
    );

    const requests: readonly unknown[] = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "antigravity-plugin-smoke", version: "0.2.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "causoryn_status", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "causoryn_map_system", arguments: {} },
      },
    ];

    for (const req of requests) {
      child.stdin?.write(`${JSON.stringify(req)}\n`);
    }
    await allResponses;
    child.stdin?.end();
    const exitCode = await exitPromise;
    return {
      exitCode,
      stdoutLines,
      stderrLines,
      responseOf: (id: number): JsonRpcMessage => {
        const message = responses.get(id);
        if (message === undefined) {
          throw new Error(`id=${String(id)} yanıtı yok; stdout=${JSON.stringify(stdoutLines)}`);
        }
        return message;
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

/** Paralel vitest koşumunda bundle.test.ts yeniden-sahneleme penceresine dayanıklı sarmalayıcı. */
async function runMcpConfigHandshake(
  server: AntigravityMcpServerEntry,
): Promise<PluginSpawnHandshakeResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runMcpConfigHandshakeOnce(server);
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync(1_500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* ------------------------------------------------------------------ */
/* Pozitif: gerçek manifest'ler — JSON parse + Antigravity/TŞ alanları */
/* ------------------------------------------------------------------ */

describe("antigravity plugin.json (yerel yükleyici izinli alanlar + TŞ §17.1)", () => {
  it("geçerli JSON'dur, $schema TAŞIMAZ ve izinli Causoryn alanlarını birebir taşır", () => {
    const raw = readPluginJsonRaw();
    const parsed = parseJsonStrict(raw, "plugin.json");
    const rec = asRecord(parsed);
    expect(rec?.["$schema"]).toBeUndefined();

    const manifest = validatePluginManifest(parsed, "plugin.json");
    expect(manifest.name).toBe("causoryn");
    expect(manifest.displayName).toBe("Causoryn");
    expect(manifest.version).toBe("0.2.4");
    expect(manifest.description).toBe(
      "Local, evidence-backed codebase and change intelligence via MCP.",
    );
  });

  it("suggestedPrompts TŞ §17.1 üçlüsüyle birebir eşleşir", () => {
    const manifest = validatePluginManifest(
      parseJsonStrict(readPluginJsonRaw(), "plugin.json"),
      "plugin.json",
    );
    expect(manifest.suggestedPrompts).toEqual([...EXPECTED_SUGGESTED_PROMPTS]);
  });

  it("sunucu kablolamasını İÇERMEZ — mcp_config.json ve mcp.json ayrı dosyalardır", () => {
    expect(readPluginJsonRaw().includes("mcpServers")).toBe(false);
  });

  it("kimlik bilgisi kalıbı TAŞIMAZ — yetkilendirme CAUSORYN_CONFIG ile kullanıcıdadır", () => {
    expect(CREDENTIAL_PATTERN.test(readPluginJsonRaw())).toBe(false);
    expect(CREDENTIAL_PATTERN.test(readMcpConfigJsonRaw())).toBe(false);
    expect(CREDENTIAL_PATTERN.test(readMcpJsonRaw())).toBe(false);
  });
});

describe("antigravity mcp_config.json (yerel Antigravity eklenti yükleyicisi birincil tanımı)", () => {
  it("mcpServers.causoryn altında node + scripts/mcp-server.mjs + default-deny CAUSORYN_CONFIG tanımlar", () => {
    const manifest = validateMcpManifest(
      parseJsonStrict(readMcpConfigJsonRaw(), "mcp_config.json"),
      "mcp_config.json",
      "local",
    );
    const server = manifest.mcpServers["causoryn"];
    expect(server?.command).toBe("node");
    expect(server?.args).toEqual(["scripts/mcp-server.mjs"]);
    expect(server?.env["CAUSORYN_CONFIG"]).toBe('{"allowRoots":[]}');

    const parsedServerConfig = parseCausorynServerConfig(
      JSON.parse(server?.env["CAUSORYN_CONFIG"] ?? ""),
    );
    expect(parsedServerConfig.allowRoots).toEqual([]);
  });
});

describe("antigravity mcp.json (TŞ §17.1 taşınabilir manifest + gerçek sunucu sözleşmesi)", () => {
  it("geçerli JSON'dur; mcpServers.causoryn stdio node sürecini tanımlar (generic engine YOK)", () => {
    const manifest = validateMcpManifest(
      parseJsonStrict(readMcpJsonRaw(), "mcp.json"),
      "mcp.json",
      "portable",
    );
    expect(manifest.mcpServers["causoryn"]?.command).toBe("node");
    expect(manifest.mcpServers["causoryn"]?.args).toEqual([EXPECTED_PORTABLE_ENTRY]);
    expect(manifest.mcpServers["engine"]).toBeUndefined();
  });

  it(`giriş noktası ${EXPECTED_PORTABLE_ENTRY}'tir; kırılgan üst-dizin yolu ve kaynak .ts YASAK`, () => {
    const manifest = validateMcpManifest(
      parseJsonStrict(readMcpJsonRaw(), "mcp.json"),
      "mcp.json",
      "portable",
    );
    const args = manifest.mcpServers["causoryn"]?.args ?? [];
    expect(args).toEqual([EXPECTED_PORTABLE_ENTRY]);
    expect(args.some((a) => a.endsWith(".ts") || a.includes("src/") || a.includes(DOT_DOT))).toBe(
      false,
    );
  });

  it("--data-dir argv TAŞIMAZ — yayımlanan sunucu argv okumaz (stdio.ts CAUSORYN_CONFIG okur)", () => {
    const manifest = validateMcpManifest(
      parseJsonStrict(readMcpJsonRaw(), "mcp.json"),
      "mcp.json",
      "portable",
    );
    const args = manifest.mcpServers["causoryn"]?.args ?? [];
    expect(args.includes("--data-dir")).toBe(false);
  });

  it("env.CAUSORYN_CONFIG gerçek sunucu şemasından (parseCausorynServerConfig) geçer ve default-deny taşır", () => {
    const manifest = validateMcpManifest(
      parseJsonStrict(readMcpJsonRaw(), "mcp.json"),
      "mcp.json",
      "portable",
    );
    const rawConfig = manifest.mcpServers["causoryn"]?.env["CAUSORYN_CONFIG"] ?? "";
    const parsedConfig = parseCausorynServerConfig(JSON.parse(rawConfig));
    expect(parsedConfig.allowRoots).toEqual([]);
  });
});

describe("integrations/antigravity/causoryn/README.md (kullanıcı dokümanı + negatif yüzey)", () => {
  it("Node >= 24, default-deny allowRoots, salt-okunur garanti, çift manifest, build:bundle ve NOT RUN beyanını içerir", () => {
    const readme = readReadmeRaw();
    expect(readme).toMatch(/Node\.js\s*>=\s*24|Node\.js\s*≥\s*24/);
    expect(readme).toContain("CAUSORYN_CONFIG");
    expect(readme).toContain("allowRoots");
    expect(readme).toContain("WORKSPACE_NOT_AUTHORIZED");
    expect(readme).toMatch(/read-only|salt[- ]okunur/i);
    expect(readme).toContain("mcp_config.json");
    expect(readme).toContain("mcp.json");
    expect(readme).toContain("npm run build:bundle --workspace packages/mcp-server");
    expect(readme).toContain("scripts/mcp-server.mjs");
    expect(readme).toContain("better-sqlite3");
    expect(readme).toContain("NOT RUN");
    expect(readme).toContain("agy");

    const bareBuild = readme.match(/npm run build:bundle(?!\s+--workspace packages\/mcp-server)/g);
    expect(bareBuild ?? []).toEqual([]);
  });

  it("README.md kök allowRoots örneği, sır veya 'tek dosya dağıtım' iddiası İÇERMEZ", () => {
    const readme = readReadmeRaw();
    expect(readme).not.toMatch(ROOT_GRANT);
    expect(readme).not.toMatch(SECRET);
    expect(readme).not.toMatch(SINGLE_FILE_CLAIM);
  });
});

describe("sahnelenmiş bundle bağlantısı + gerçek stdio el sıkışması (cwd: PLUGIN_DIR, disk-bağlı)", () => {
  it.skipIf(STAGED_BUNDLE_SKIP_REASON)(
    "mcp.json ve mcp_config.json giriş yolları sahnelenmiş scripts/mcp-server.mjs (+ vendored better-sqlite3) artefaktına çözülür",
    () => {
      const portableManifest = validateMcpManifest(
        parseJsonStrict(readMcpJsonRaw(), "mcp.json"),
        "mcp.json",
        "portable",
      );
      const localManifest = validateMcpManifest(
        parseJsonStrict(readMcpConfigJsonRaw(), "mcp_config.json"),
        "mcp_config.json",
        "local",
      );
      expect(resolvedPortableBundleArg(portableManifest)).toBe(STAGED_BUNDLE_PATH);
      const localArg = localManifest.mcpServers["causoryn"]?.args[0] ?? "";
      expect(path.resolve(PLUGIN_DIR, localArg)).toBe(STAGED_BUNDLE_PATH);
      withStagingRetrySync(() => {
        expect(existsSync(STAGED_BUNDLE_PATH)).toBe(true);
        expect(existsSync(STAGED_MANIFEST_PATH)).toBe(true);
        expect(existsSync(STAGED_VENDOR_PKG_PATH)).toBe(true);
      });
    },
  );

  it("withStagingRetrySync: geçici yarım-sahneleme hatasında bekleyip yakınsar, denemeler tükenirse fırlatır", () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const converged = withStagingRetrySync(
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error("yarım sahneleme penceresi");
        return "ok";
      },
      { attempts: 3, sleep: (ms) => sleeps.push(ms) },
    );
    expect(converged).toBe("ok");
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([1_500]);

    let failedCalls = 0;
    expect(() =>
      withStagingRetrySync(
        () => {
          failedCalls += 1;
          throw new Error("kalıcı eksik");
        },
        { attempts: 2, sleep: () => undefined },
      ),
    ).toThrow(/kalıcı eksik/);
    expect(failedCalls).toBe(2);
  });

  it.skipIf(STAGED_BUNDLE_SKIP_REASON)(
    "mcp_config.json command+args+env ile gerçek spawn: initialize, tools/list (11 core araç), causoryn_status (ok), causoryn_map_system (WORKSPACE_NOT_AUTHORIZED), saf JSON-RPC stdout",
    async () => {
      const localManifest = validateMcpManifest(
        parseJsonStrict(readMcpConfigJsonRaw(), "mcp_config.json"),
        "mcp_config.json",
        "local",
      );
      const server = localManifest.mcpServers["causoryn"];
      expect(server).toBeDefined();

      const session = await runMcpConfigHandshake(server as AntigravityMcpServerEntry);

      expect(session.stdoutLines.length).toBe(4);
      for (const line of session.stdoutLines) {
        let parsedLine: JsonRpcMessage | undefined;
        expect(() => {
          parsedLine = JSON.parse(line) as JsonRpcMessage;
        }).not.toThrow();
        expect(parsedLine?.jsonrpc, `stdout protokol dışı satır: ${line}`).toBe("2.0");
      }

      const initResult = session.responseOf(1).result as {
        serverInfo?: { name?: string; version?: string };
      };
      expect(initResult.serverInfo?.name).toBe(SERVER_NAME);
      expect(initResult.serverInfo?.version).toBe(SERVER_VERSION);

      const listResult = session.responseOf(2).result as {
        tools?: Array<{ name?: string }>;
      };
      const listedNames = listResult.tools?.map((t) => t.name).sort();
      expect(TOOL_NAMES.length).toBe(29);
      expect(CORE_TOOL_NAMES.length).toBe(11);
      expect(listedNames).toEqual([...CORE_TOOL_NAMES].sort());

      const statusResult = session.responseOf(3).result as {
        structuredContent?: {
          status?: string;
          schemaVersion?: string;
          data?: { authorized?: boolean };
        };
        isError?: boolean;
      };
      expect(statusResult.isError).toBeFalsy();
      expect(statusResult.structuredContent?.schemaVersion).toBe(SCHEMA_VERSION);
      expect(statusResult.structuredContent?.status).toBe("ok");
      expect(statusResult.structuredContent?.data?.authorized).toBe(false);

      const mapResult = session.responseOf(4).result as {
        structuredContent?: {
          status?: string;
          error?: { code?: string };
        };
      };
      expect(mapResult.structuredContent?.status).toBe("error");
      expect(mapResult.structuredContent?.error?.code).toBe("WORKSPACE_NOT_AUTHORIZED");

      expect(session.stderrLines.some((line) => line.includes(READY_MARKER))).toBe(true);
      expect(session.exitCode).toBe(0);
    },
    120_000,
  );
});

/* ------------------------------------------------------------------ */
/* Negatif: bozuk JSON ve yapısal/şemasal olarak geçersiz manifest'ler */
/* ------------------------------------------------------------------ */

describe("negatif durumlar: bozuk/eksik/yasak manifest alanları açık reddedilir", () => {
  it("bozuk JSON (kesik manifest) etiketli açık hatayla reddedilir", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-antigravity-neg-"));
    try {
      const brokenPath = path.join(tmpRoot, "plugin-broken.json");
      writeFileSync(brokenPath, '{ "name": "causoryn", "version": ', "utf8");
      const raw = readFileSync(brokenPath, "utf8");
      expect(() => parseJsonStrict(raw, brokenPath)).toThrowError(/JSON parse başarısız/);
      expect(() => parseJsonStrict(raw, brokenPath)).toThrowError(/plugin-broken\.json/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("geçerli JSON ama zorunlu alan eksik veya sunucu anahtarı generic 'engine' → reddedilir", () => {
    const missingName = { displayName: "Causoryn", version: "0.2.0" };
    expect(() => validatePluginManifest(missingName, "sentetik-plugin.json")).toThrowError(
      /"name"/,
    );
    const missingServer = { mcpServers: {} };
    expect(() => validateMcpManifest(missingServer, "sentetik-mcp.json")).toThrowError(
      /"causoryn"/,
    );
    const legacyEngineKey = {
      mcpServers: {
        engine: {
          command: "node",
          args: [EXPECTED_PORTABLE_ENTRY],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() => validateMcpManifest(legacyEngineKey, "sentetik-mcp.json")).toThrowError(
      /engine.*YASAK/i,
    );
    const missingCommand = { mcpServers: { causoryn: { args: [EXPECTED_PORTABLE_ENTRY] } } };
    expect(() => validateMcpManifest(missingCommand, "sentetik-mcp.json")).toThrowError(
      /causoryn\.command/u,
    );
  });

  it("plugin.json içinde $schema, mcpServers veya bilinmeyen üst-düzey alan → reddedilir", () => {
    const withSchema = {
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.2.0",
      description: "x",
      suggestedPrompts: [...EXPECTED_SUGGESTED_PROMPTS],
    };
    expect(() => validatePluginManifest(withSchema, "sentetik-plugin.json")).toThrowError(
      /\$schema/,
    );

    const withMcpServers = {
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.2.0",
      description: "x",
      suggestedPrompts: [...EXPECTED_SUGGESTED_PROMPTS],
      mcpServers: {},
    };
    expect(() => validatePluginManifest(withMcpServers, "sentetik-plugin.json")).toThrowError(
      /mcpServers/,
    );

    const withUnknownField = {
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.2.0",
      description: "x",
      suggestedPrompts: [...EXPECTED_SUGGESTED_PROMPTS],
      customUnknownKey: true,
    };
    expect(() => validatePluginManifest(withUnknownField, "sentetik-plugin.json")).toThrowError(
      /customUnknownKey/,
    );

    const wrongPrompts = {
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.2.0",
      description: "x",
      suggestedPrompts: ["tek prompt"],
    };
    expect(() => validatePluginManifest(wrongPrompts, "sentetik-plugin.json")).toThrowError(
      /suggestedPrompts/,
    );
  });

  it("kaynak TS dosyasına, eğik çizgisiz token'a, üst-dizin kaçışına veya mutlak yola işaret eden MCP manifest'leri reddedilir", () => {
    const tsPointer = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [`${PLUGIN_ROOT_TOKEN}/src/stdio.ts`],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() => validateMcpManifest(tsPointer, "sentetik-mcp.json", "portable")).toThrowError(
      /derlenmiş|\.ts/,
    );

    const missingSlashAfterToken = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [`${PLUGIN_ROOT_TOKEN}scripts/mcp-server.mjs`],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() =>
      validateMcpManifest(missingSlashAfterToken, "sentetik-mcp.json", "portable"),
    ).toThrowError(/önekiyle başlamalı/);

    const parentEscapePortable = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [`${PLUGIN_ROOT_TOKEN}/${DOT_DOT}/packages/mcp-server/dist/mcp-server.mjs`],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() =>
      validateMcpManifest(parentEscapePortable, "sentetik-mcp.json", "portable"),
    ).toThrowError(/kaçışı|YASAK/);

    const localEscape = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [`${DOT_DOT}/scripts/mcp-server.mjs`],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() => validateMcpManifest(localEscape, "sentetik-mcp-config.json", "local")).toThrowError(
      /kaçışı|YASAK/,
    );

    const localAbsolute = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: ["C:/plugins/causoryn/scripts/mcp-server.mjs"],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() =>
      validateMcpManifest(localAbsolute, "sentetik-mcp-config.json", "local"),
    ).toThrowError(/göreli yol olmalı/);
  });

  it("env.CAUSORYN_CONFIG bozuk JSON, bilinmeyen anahtar (dataDir) veya göreli allowRoots içerdiğinde reddedilir", () => {
    const badJsonEnv = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [EXPECTED_PORTABLE_ENTRY],
          env: { CAUSORYN_CONFIG: "{not-json" },
        },
      },
    };
    expect(() => validateMcpManifest(badJsonEnv, "sentetik-mcp.json")).toThrowError(
      /JSON parse başarısız/,
    );

    const unknownConfigKey = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [EXPECTED_LOCAL_ENTRY],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[],"dataDir":"/tmp"}' },
        },
      },
    };
    expect(() =>
      validateMcpManifest(unknownConfigKey, "sentetik-mcp-config.json", "local"),
    ).toThrowError(/CAUSORYN_CONFIG sunucu şemasına uymuyor.*dataDir/s);

    const relativeAllowRoot = {
      mcpServers: {
        causoryn: {
          command: "node",
          args: [EXPECTED_PORTABLE_ENTRY],
          env: { CAUSORYN_CONFIG: '{"allowRoots":["goreli"]}' },
        },
      },
    };
    expect(() =>
      validateMcpManifest(relativeAllowRoot, "sentetik-mcp.json", "portable"),
    ).toThrowError(/CAUSORYN_CONFIG sunucu şemasına uymuyor.*must be an absolute path/s);
  });
});

/* ------------------------------------------------------------------ */
/* Partial (dürüstlük): dokümandaki birebir NOT RUN beyanı + yeni durum */
/* ------------------------------------------------------------------ */

describe("docs/hosts/antigravity.md — dürüstlük beyanı ve çift manifest gerçekliği (TŞ §22)", () => {
  it("agy CLI bulunamadı beyanını BİREBİR taşır — kurulum/smoke koşulmadı", () => {
    const docRaw = readFileSync(DOC_PATH, "utf8");
    expect(docRaw.includes(NOT_RUN_STATEMENT)).toBe(true);
  });

  it("TŞ §17.1 agy komutlarını doküman örneği olarak listeler ve koşulmadığını söyler", () => {
    const docRaw = readFileSync(DOC_PATH, "utf8");
    expect(docRaw.includes("agy plugin validate --strict")).toBe(true);
    expect(docRaw.includes("agy plugin install")).toBe(true);
    expect(docRaw.includes("agy plugin list")).toBe(true);
    expect(docRaw.includes("NOT RUN")).toBe(true);
  });

  it("plugin.json ($schema'sız), mcp_config.json, mcp.json, README.md ve sahnelenmiş scripts/mcp-server.mjs gerçekliğini belgeler; bayat engine/üst-dizin iddialarını taşımaz", () => {
    const docRaw = readFileSync(DOC_PATH, "utf8");
    expect(docRaw.includes("integrations/antigravity/causoryn/mcp_config.json")).toBe(true);
    expect(docRaw.includes("integrations/antigravity/causoryn/README.md")).toBe(true);
    expect(docRaw.includes('"scripts/mcp-server.mjs"')).toBe(true);
    expect(docRaw.includes(`${PLUGIN_ROOT_TOKEN}/scripts/mcp-server.mjs`)).toBe(true);
    expect(docRaw.includes("bundle-manifest.json")).toBe(true);
    expect(docRaw.includes("CAUSORYN_CONFIG")).toBe(true);
    expect(docRaw.includes("$schema")).toBe(true);
    expect(docRaw.includes("sessizce")).toBe(true);
    expect(docRaw.includes("stdio")).toBe(true);
    // Bayat örnek bloklar (generic "engine": { ve kırılgan üst-dizin packages/mcp-server/dist yolu) kaldırılmış olmalı
    expect(docRaw.includes('"engine": {')).toBe(false);
    expect(docRaw.includes("packages/mcp-server/dist/mcp-server.mjs\"")).toBe(false);
    expect(docRaw.includes("henüz pakete vendor edilmedi")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Takım denetimi düzeltmeleri (bulgu 1–4): doküman içerik sözleşmesi  */
/* ------------------------------------------------------------------ */

describe("docs/hosts/antigravity.md — takım denetimi düzeltmeleri", () => {
  it("bulgu 1: TŞ §17.1 alıntısı birebir 'çalıştırılmış değildir'; çift olumsuz ('çalıştırılmamış değildir') YASAK", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText.includes("bu doküman hazırlanırken çalıştırılmış değildir")).toBe(true);
    expect(docText.includes("çalıştırılmamış değildir")).toBe(false);
  });

  it("bulgu 2: build:bundle talimatı kök script ile çelişmez — kök script yokken çıplak kök koşumu talimat edilmez", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPkg.scripts?.["build:bundle"]).toBeUndefined();
    const bare = docText.match(/npm run build:bundle(?!\s+--workspace packages\/mcp-server)/g);
    expect(bare ?? []).toEqual([]);
    expect(docText.includes("npm run build:bundle --workspace packages/mcp-server")).toBe(true);
  });

  it("bulgu 3: agy kuralının bölüm atfı §22'dir — PDF s.23'te cümle §22 'Dikey dilim kabul testi' paragrafını kapatır, hemen ardından '23.' başlığı gelir", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText.includes("TŞ §22 kuralı uygulanır")).toBe(true);
    expect(docText.includes('§22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla"')).toBe(true);
    expect(docText.includes("TŞ §23 kuralı uygulanır")).toBe(false);
  });

  it("bulgu 4: TŞ §17.4 kavramı birebir 'özdeşliği iddia edilmez'; 'özelliği iddia edilmez' anlam kayması YASAK", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText.includes("host UI/permission özdeşliği iddia edilmez")).toBe(true);
    expect(docText.includes("özelliği iddia edilmez")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Test kaynağı taraması (bulgu 5): token kalıbı tek parça yazılmaz    */
/* ------------------------------------------------------------------ */

describe("test kaynağı taraması (bulgu 5): PLUGIN_ROOT token'ı ve çift-nokta dizgesi tek parça olarak YAZILMAZ", () => {
  it("bu dosyanın kaynağında tek parça PLUGIN_ROOT token'ı veya spread (...) dışı çift-nokta bulunmaz", () => {
    const forbiddenToken = DOLLAR_BRACE + "PLUGIN_ROOT}";
    const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(selfSource.includes(forbiddenToken)).toBe(false);
    expect(selfSource.includes('"$" + "{"')).toBe(true);
    expect(/(?<!\.)\.\.(?!\.)/.test(selfSource)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Takım denetimi 2. tur (2026-11-10): bulgu 6–8                       */
/* ------------------------------------------------------------------ */

describe("docs/hosts/antigravity.md — smoke temizlik protokolü (kırmızı kural 6, denetim bulgu 6)", () => {
  it("smoke dizisi kurulumun geri alınmasını belgeler: smoke sonunda plugin kaldırılır", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText.includes("smoke sonunda plugin kaldırılır")).toBe(true);
  });

  it("kural 6 disiplini açık yazılır: kullanıcı config'ine kalıcı değişiklik bırakılmaz", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText.includes("kalıcı değişiklik bırakılmaz")).toBe(true);
  });
});

describe("stdio kaynak gardı (denetim bulgu 7): mcp.json sapma notunun canlı temeli", () => {
  const STDIO_SOURCE = readFileSync(
    path.join(REPO_ROOT, "packages", "mcp-server", "src", "stdio.ts"),
    "utf8",
  );

  it("stdio girişi konfigürasyonu yalnızca CAUSORYN_CONFIG env'sinden okur; argv işlemeği YOKTUR", () => {
    expect(STDIO_SOURCE.includes("process.env.CAUSORYN_CONFIG")).toBe(true);
    expect(STDIO_SOURCE.includes("process.argv")).toBe(false);
  });
});

describe("docs/hosts/antigravity.md — negatif yüzey taraması (denetim bulgu 8; claude/codex paritesi)", () => {
  it("antigravity.md: kök allowRoots yetkisi, sır ve 'tek dosya' dağıtım iddiası YOK", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(docText).not.toMatch(ROOT_GRANT);
    expect(docText).not.toMatch(SECRET);
    expect(docText).not.toMatch(SINGLE_FILE_CLAIM);
  });
});
