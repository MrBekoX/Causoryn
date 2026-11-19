import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex, utf8Encode } from "@causoryn/domain";
import type { GraphRepository, SymbolSearchStore } from "@causoryn/graph";
import type { IndexJobManager, IndexService } from "@causoryn/indexing";
import type { SqliteWikiStore } from "@causoryn/storage-sqlite";
import type { WikiSearchStore } from "@causoryn/wiki";
import type { OutputAccessPolicy, WorkspaceAccessPolicy } from "@causoryn/workspace";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CausorynConfigError,
  parseCausorynServerConfig,
  type CausorynServerConfig,
} from "./config.js";
import {
  createCausorynContext,
  type CausorynContext,
  type ContextOverrides,
} from "./context.js";
import type { PreflightManifestStore } from "./preflight-store.js";
import type { OutputSchemaProfile } from "./server.js";

/**
 * K-021 — Sıfır-ayar MCP CLI bayrakları, güvenli `--allow-cwd` kök filtresi,
 * `--auto-data-dir` workspace-dışı veri kökü hazırlayıcısı ve masaüstü IDE'ler
 * için dinamik MCP `roots/list` + `notifications/roots/list_changed` bağlayıcısı.
 *
 * Kırmızı çizgiler (TŞ §9, §10.1, §20, ADR-008):
 * - Çıplak `node stdio.ts` / `node dist/mcp-server.mjs` (0 argüman) çağrısında
 *   eski davranış %100 korunur (`allowRoots: []` default deny + `"full"` şema).
 * - `$HOME`, dosya sistemi kökü (`/`, `C:\`), `~/.causoryn`, `ZCODE_PLUGIN_DATA`,
 *   `--data-dir` ve Causoryn eklenti/bundle kurulum dizinleri ASLA proje kökü
 *   olarak yetkilendirilmez.
 * - Analiz edilen kaynak ağaca tek bayt bile yazılmaz; `--auto-data-dir`
 *   dizinleri oluşturulmadan ÖNCE yetkili köklerin dışında kaldığı doğrulanır.
 */

export class McpCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCliUsageError";
  }
}

export interface ParsedMcpCliArgs {
  readonly hasCliActivation: boolean;
  readonly allowCwd: boolean;
  readonly roots: readonly string[];
  readonly autoDataDir: boolean;
  readonly dataDir?: string;
  readonly client?: string;
  readonly outputSchemaProfile?: OutputSchemaProfile;
}

const KNOWN_FLAGS = new Set([
  "--allow-cwd",
  "--root",
  "--auto-data-dir",
  "--data-dir",
  "--client",
  "--output-schema-profile",
]);

const SAFE_CLIENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * `stdio.ts` ve `causoryn mcp` CLI argümanlarını ayrıştırır.
 * Geçersiz bayrak, `\0` baytı veya eksik değer `McpCliUsageError` fırlatır.
 */
export function parseMcpCliArgs(argv: readonly string[]): ParsedMcpCliArgs {
  for (const token of argv) {
    if (token.includes("\0")) {
      throw new McpCliUsageError("CLI argümanları null byte içeremez");
    }
  }

  if (argv.length === 0) {
    return {
      hasCliActivation: false,
      allowCwd: false,
      roots: [],
      autoDataDir: false,
    };
  }

  let index = 0;
  if (argv[0] === "mcp") {
    index = 1;
  }

  let allowCwd = false;
  let autoDataDir = false;
  let dataDir: string | undefined;
  let client: string | undefined;
  let outputSchemaProfile: OutputSchemaProfile | undefined;
  const roots: string[] = [];

  const readRequiredValue = (flag: string, inlineValue: string | undefined): string => {
    if (inlineValue !== undefined) {
      if (inlineValue.trim().length === 0) {
        throw new McpCliUsageError(`${flag} bayrağı boş değer alamaz`);
      }
      return inlineValue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.trim().length === 0 || KNOWN_FLAGS.has(next)) {
      throw new McpCliUsageError(`${flag} bayrağı bir değer gerektirir`);
    }
    index += 1;
    return next;
  };

  for (; index < argv.length; index += 1) {
    const rawToken = argv[index] as string;
    if (!rawToken.startsWith("--")) {
      throw new McpCliUsageError(`Beklenmeyen konumsal argüman veya bayrak: ${rawToken}`);
    }

    const eqPos = rawToken.indexOf("=");
    const flag = eqPos >= 0 ? rawToken.slice(0, eqPos) : rawToken;
    const inlineValue = eqPos >= 0 ? rawToken.slice(eqPos + 1) : undefined;

    switch (flag) {
      case "--allow-cwd": {
        if (inlineValue !== undefined) {
          throw new McpCliUsageError("--allow-cwd bayrağı değer almaz");
        }
        allowCwd = true;
        break;
      }
      case "--auto-data-dir": {
        if (inlineValue !== undefined) {
          throw new McpCliUsageError("--auto-data-dir bayrağı değer almaz");
        }
        autoDataDir = true;
        break;
      }
      case "--root": {
        const rootValue = readRequiredValue("--root", inlineValue);
        roots.push(rootValue);
        break;
      }
      case "--data-dir": {
        const dirValue = readRequiredValue("--data-dir", inlineValue);
        dataDir = dirValue;
        autoDataDir = true;
        break;
      }
      case "--client": {
        const clientValue = readRequiredValue("--client", inlineValue);
        if (!SAFE_CLIENT_ID_PATTERN.test(clientValue)) {
          throw new McpCliUsageError(
            `Geçersiz --client kimliği (yalnızca alfasayısal, '.', '_', '-' karakterleri): ${clientValue}`,
          );
        }
        client = clientValue;
        break;
      }
      case "--output-schema-profile": {
        const profileValue = readRequiredValue("--output-schema-profile", inlineValue);
        if (profileValue !== "full" && profileValue !== "omit") {
          throw new McpCliUsageError(
            `--output-schema-profile yalnızca 'full' veya 'omit' olabilir: ${profileValue}`,
          );
        }
        outputSchemaProfile = profileValue;
        break;
      }
      default:
        throw new McpCliUsageError(`Bilinmeyen CLI bayrağı: ${flag}`);
    }
  }

  return {
    hasCliActivation: true,
    allowCwd,
    roots,
    autoDataDir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(client !== undefined ? { client } : {}),
    ...(outputSchemaProfile !== undefined ? { outputSchemaProfile } : {}),
  };
}

/**
 * Etkin `outputSchemaProfile` kararını çözer:
 * `--output-schema-profile` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > (`hasCliActivation ? "omit" : "full"`).
 */
export function resolveEffectiveOutputSchemaProfile(
  cliArgs: ParsedMcpCliArgs,
  env: NodeJS.ProcessEnv = process.env,
): OutputSchemaProfile {
  if (cliArgs.outputSchemaProfile !== undefined) {
    return cliArgs.outputSchemaProfile;
  }
  const envRaw = env["CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE"]?.trim();
  if (envRaw !== undefined && envRaw.length > 0) {
    if (envRaw === "full" || envRaw === "omit") {
      return envRaw;
    }
    throw new McpCliUsageError(
      `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE yalnızca 'full' veya 'omit' olabilir: ${envRaw}`,
    );
  }
  return cliArgs.hasCliActivation ? "omit" : "full";
}

function stripWin32DevicePrefix(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function normalizeComparablePath(value: string): string {
  const resolved = stripWin32DevicePrefix(path.resolve(value));
  const root = path.parse(resolved).root;
  const trimmed =
    resolved.length > root.length && resolved.endsWith(path.sep)
      ? resolved.slice(0, -1)
      : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isSameComparablePath(a: string, b: string): boolean {
  return normalizeComparablePath(a) === normalizeComparablePath(b);
}

function isSameOrInsideComparable(targetPath: string, containerPath: string): boolean {
  const target = normalizeComparablePath(targetPath);
  const container = normalizeComparablePath(containerPath);
  if (target === container) return true;
  const boundary = container.endsWith(path.sep) ? container : `${container}${path.sep}`;
  return target.startsWith(boundary);
}

/**
 * Henüz diskte oluşmamış alt yolların bile üst mevcut atasını `realpathSync`
 * ile çözerek symlink/8.3 kısa yol kaçışlarını yakalar.
 */
function resolveRealOrLexical(inputPath: string): string {
  const abs = path.resolve(inputPath);
  const tailSegments: string[] = [];
  let cursor = abs;
  while (true) {
    try {
      const realAncestor = stripWin32DevicePrefix(realpathSync(cursor));
      return tailSegments.length === 0
        ? realAncestor
        : path.join(realAncestor, ...tailSegments.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return abs;
      }
      tailSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasInstallCacheSegment(targetPath: string): boolean {
  const normalized = stripWin32DevicePrefix(path.resolve(targetPath));
  const segments = normalized.split(/[/\\]+/);
  for (const segment of segments) {
    const lowered = process.platform === "win32" ? segment.toLowerCase() : segment;
    if (lowered === "node_modules" || lowered === "_npx") {
      return true;
    }
  }
  return false;
}

interface ResolvedDirEntry {
  readonly raw: string;
  readonly real: string;
}

function toResolvedDirEntry(dir: string): ResolvedDirEntry {
  return { raw: dir, real: resolveRealOrLexical(dir) };
}

function isInsideResolvedDirs(
  targetPath: string,
  realTargetPath: string,
  entries: readonly ResolvedDirEntry[],
): boolean {
  for (const entry of entries) {
    if (
      isSameOrInsideComparable(targetPath, entry.raw) ||
      isSameOrInsideComparable(targetPath, entry.real) ||
      isSameOrInsideComparable(realTargetPath, entry.raw) ||
      isSameOrInsideComparable(realTargetPath, entry.real)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Bir dizinin `AGENTS.md` + `package.json` `"workspaces"` taşıyan monorepo
 * kaynak kökü olup olmadığını denetler (kök plugin manifesti barındırsa bile
 * geliştirici monorepo kökü reddedilmez; ancak `node_modules`, `_npx` veya
 * yasaklı eklenti dizinleri içindeki Git klonları asla monorepo sayılmaz).
 */
function isMonorepoWorkspaceRoot(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): boolean {
  try {
    if (!statSync(path.join(dirPath, "AGENTS.md")).isFile()) {
      return false;
    }
    const pkgRaw = readFileSync(path.join(dirPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(pkgRaw);
    if (!isPlainObject(parsed)) {
      return false;
    }
    const workspaces = parsed["workspaces"];
    if (!Array.isArray(workspaces) && !isPlainObject(workspaces)) {
      return false;
    }
  } catch {
    return false;
  }

  const realDir = resolveRealOrLexical(dirPath);
  if (
    hasInstallCacheSegment(dirPath) ||
    hasInstallCacheSegment(realDir) ||
    isInsideResolvedDirs(dirPath, realDir, forbiddenEntries)
  ) {
    return false;
  }
  return true;
}

function hasPluginInstallMarkers(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): boolean {
  if (isMonorepoWorkspaceRoot(dirPath, forbiddenEntries)) {
    return false;
  }
  return (
    existsSync(path.join(dirPath, ".zcode-plugin", "plugin.json")) ||
    existsSync(path.join(dirPath, ".claude-plugin", "plugin.json")) ||
    existsSync(path.join(dirPath, ".codex-plugin", "plugin.json")) ||
    (existsSync(path.join(dirPath, "plugin.json")) &&
      existsSync(path.join(dirPath, "mcp_config.json")))
  );
}

function hasCausorynNamedPluginManifest(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): boolean {
  if (isMonorepoWorkspaceRoot(dirPath, forbiddenEntries)) {
    return false;
  }
  if (existsSync(path.join(dirPath, "bundle-manifest.json"))) {
    return true;
  }
  const manifestCandidates = [
    path.join(dirPath, ".zcode-plugin", "plugin.json"),
    path.join(dirPath, ".claude-plugin", "plugin.json"),
    path.join(dirPath, ".codex-plugin", "plugin.json"),
    path.join(dirPath, "plugin.json"),
  ];
  for (const manifestPath of manifestCandidates) {
    try {
      if (!statSync(manifestPath).isFile()) continue;
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isPlainObject(parsed) && parsed["name"] === "causoryn") {
        return true;
      }
    } catch {
      // Okunamayan aday atlanır.
    }
  }
  return false;
}

export interface SafeProjectRootOptions {
  readonly homeDir?: string;
  readonly baseDataDir?: string;
  readonly dataDir?: string;
  readonly zcodePluginDataDir?: string;
  readonly forbiddenDirs?: readonly string[];
  readonly scriptPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ProjectRootSafetyResult =
  | { readonly safe: true; readonly canonicalRoot: string }
  | { readonly safe: false; readonly reason: string };

function deriveForbiddenPluginDirs(
  homeDir: string,
  options: SafeProjectRootOptions,
): ResolvedDirEntry[] {
  const env = options.env ?? process.env;
  const rawDirs: string[] = [...(options.forbiddenDirs ?? [])];

  if (homeDir.trim().length > 0) {
    rawDirs.push(
      path.join(homeDir, ".causoryn", "runtime"),
      path.join(homeDir, ".gemini"),
      path.join(homeDir, ".antigravity"),
      path.join(homeDir, ".claude", "plugins"),
      path.join(homeDir, ".zcode", "plugins"),
      path.join(homeDir, ".codex", "plugins"),
      path.join(homeDir, ".agents", "plugins"),
    );
  }

  for (const envKey of ["CLAUDE_PLUGIN_ROOT", "ZCODE_PLUGIN_ROOT"] as const) {
    const envDir = env[envKey]?.trim();
    if (envDir !== undefined && envDir.length > 0) {
      rawDirs.push(envDir);
    }
  }

  const entries: ResolvedDirEntry[] = [];
  for (const rawDir of rawDirs) {
    if (rawDir.trim().length === 0) continue;
    entries.push(toResolvedDirEntry(rawDir));
  }

  const scriptCandidate = options.scriptPath ?? process.argv[1];
  if (scriptCandidate !== undefined && scriptCandidate.trim().length > 0) {
    const resolvedScript = resolveRealOrLexical(scriptCandidate);
    let scriptDir = resolvedScript;
    try {
      if (!statSync(resolvedScript).isDirectory()) {
        scriptDir = path.dirname(resolvedScript);
      }
    } catch {
      scriptDir = path.dirname(resolvedScript);
    }

    if (
      !isMonorepoWorkspaceRoot(scriptDir, entries) &&
      existsSync(path.join(scriptDir, "bundle-manifest.json"))
    ) {
      entries.push(toResolvedDirEntry(scriptDir));
    }

    let cursor = scriptDir;
    while (true) {
      if (hasPluginInstallMarkers(cursor, entries)) {
        entries.push(toResolvedDirEntry(cursor));
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  return entries;
}

/**
 * Aday çalışma dizininin güvenli bir proje kökü olup olmadığını ayrıntılı
 * gerekçesiyle denetler.
 */
export function inspectProjectRootSafety(
  candidatePath: string,
  options: SafeProjectRootOptions = {},
): ProjectRootSafetyResult {
  if (candidatePath.trim().length === 0 || candidatePath.includes("\0")) {
    return { safe: false, reason: "boş veya geçersiz yol" };
  }

  let real: string;
  try {
    real = stripWin32DevicePrefix(realpathSync(path.resolve(candidatePath)));
    if (!statSync(real).isDirectory()) {
      return { safe: false, reason: `dizin değil: ${real}` };
    }
  } catch {
    return { safe: false, reason: `çözümlenemeyen dizin: ${candidatePath}` };
  }

  // 1) Dosya sistemi kökleri (/, C:\, D:\ vb.)
  if (path.dirname(real) === real || path.parse(real).root === real) {
    return { safe: false, reason: `dosya sistemi kökü reddedildi: ${real}` };
  }

  // 2) Kullanıcı ev dizini ($HOME)
  const rawHome = options.homeDir ?? os.homedir();
  if (rawHome.trim().length > 0) {
    const realHome = resolveRealOrLexical(rawHome);
    if (isSameComparablePath(real, rawHome) || isSameComparablePath(real, realHome)) {
      return { safe: false, reason: `kullanıcı ev dizini ($HOME) reddedildi: ${real}` };
    }
  }

  // 3) Veri dizinleri (~/.causoryn, ZCODE_PLUGIN_DATA, --data-dir, baseDataDir) ve alt dizinleri
  const env = options.env ?? process.env;
  const dataDirs = [
    rawHome.trim().length > 0 ? path.join(rawHome, ".causoryn") : undefined,
    options.baseDataDir,
    options.dataDir,
    options.zcodePluginDataDir ?? env["ZCODE_PLUGIN_DATA"],
  ];
  for (const rawDataDir of dataDirs) {
    if (rawDataDir === undefined || rawDataDir.trim().length === 0) continue;
    const realDataDir = resolveRealOrLexical(rawDataDir);
    if (
      isSameOrInsideComparable(real, rawDataDir) ||
      isSameOrInsideComparable(real, realDataDir)
    ) {
      return { safe: false, reason: `Causoryn veri dizini reddedildi: ${real}` };
    }
  }

  // 4) Yasaklı eklenti/bundle/runtime kurulum dizinleri (isMonorepoWorkspaceRoot'tan ÖNCE!)
  const forbiddenEntries = deriveForbiddenPluginDirs(rawHome, options);
  if (isInsideResolvedDirs(real, real, forbiddenEntries)) {
    return { safe: false, reason: "plugin-install-directory" };
  }

  // Adayın kendisi (veya monorepo olmayan üst atası) Causoryn plugin kurulumuysa reddet
  let ancestorCursor = real;
  while (true) {
    if (hasCausorynNamedPluginManifest(ancestorCursor, forbiddenEntries)) {
      return {
        safe: false,
        reason: "plugin-install-directory",
      };
    }
    const parent = path.dirname(ancestorCursor);
    if (parent === ancestorCursor) break;
    ancestorCursor = parent;
  }

  return { safe: true, canonicalRoot: real };
}

/**
 * Aday dizinin `--allow-cwd` veya MCP `roots/list` üzerinden yetkilendirilebilecek
 * güvenli bir kullanıcı proje kökü olup olmadığını döndürür.
 */
export function isSafeProjectRoot(
  candidatePath: string,
  options: SafeProjectRootOptions = {},
): boolean {
  return inspectProjectRootSafety(candidatePath, options).safe;
}

export function resolveBaseDataDir(options: {
  readonly dataDir?: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const explicitDataDir = options.dataDir?.trim();
  if (explicitDataDir !== undefined && explicitDataDir.length > 0) {
    if (explicitDataDir.includes("\0")) {
      throw new CausorynConfigError(["--data-dir null byte içeremez"]);
    }
    if (!path.isAbsolute(explicitDataDir)) {
      throw new CausorynConfigError([`--data-dir mutlak yol olmalı: ${explicitDataDir}`]);
    }
    return path.resolve(explicitDataDir);
  }

  const env = options.env ?? process.env;
  const zcodeDataDir = env["ZCODE_PLUGIN_DATA"]?.trim();
  if (zcodeDataDir !== undefined && zcodeDataDir.length > 0) {
    if (zcodeDataDir.includes("\0")) {
      throw new CausorynConfigError(["ZCODE_PLUGIN_DATA null byte içeremez"]);
    }
    if (!path.isAbsolute(zcodeDataDir)) {
      throw new CausorynConfigError([
        `ZCODE_PLUGIN_DATA mutlak yol olmalı: ${zcodeDataDir}`,
      ]);
    }
    return path.resolve(zcodeDataDir);
  }

  const homeDir = options.homeDir ?? os.homedir();
  return path.resolve(homeDir, ".causoryn");
}

function deriveWorkspaceSlug(canonicalRoot: string): string {
  const base = path.basename(canonicalRoot).toLowerCase();
  const cleaned = base
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return "workspace";
  }
  return cleaned;
}

function assertStrictlyOutsideWorkspaceRoots(
  targetPaths: readonly string[],
  roots: readonly string[],
  canonicalRoots: readonly string[],
): void {
  for (const target of targetPaths) {
    const lexicalTarget = path.resolve(target);
    const realTarget = resolveRealOrLexical(lexicalTarget);
    for (let i = 0; i < roots.length; i += 1) {
      const lexicalRoot = path.resolve(roots[i] as string);
      const canonicalRoot = canonicalRoots[i] as string;
      if (
        isSameOrInsideComparable(lexicalTarget, lexicalRoot) ||
        isSameOrInsideComparable(lexicalTarget, canonicalRoot) ||
        isSameOrInsideComparable(realTarget, lexicalRoot) ||
        isSameOrInsideComparable(realTarget, canonicalRoot)
      ) {
        throw new CausorynConfigError([
          `otomatik veri dizini yetkili workspace kökünün içinde olamaz (ADR-008): ${target}`,
        ]);
      }
    }
  }
}

function assertNotSymlinkDirectory(targetDir: string): void {
  try {
    const st = lstatSync(targetDir);
    if (st.isSymbolicLink()) {
      throw new CausorynConfigError([
        `veri dizini sembolik bağ olamaz (CWE-59): ${targetDir}`,
      ]);
    }
    if (!st.isDirectory()) {
      throw new CausorynConfigError([
        `veri dizini bir dizin değil: ${targetDir}`,
      ]);
    }
  } catch (error) {
    if (error instanceof CausorynConfigError) throw error;
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw new CausorynConfigError([
        `veri dizini durumu doğrulanamadı: ${targetDir}`,
      ]);
    }
  }
}

function enumeratePathPrefixes(targetPath: string): string[] {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const remainder = resolved.slice(parsed.root.length);
  const segments = remainder.split(path.sep).filter((segment) => segment.length > 0);
  const prefixes: string[] = [parsed.root];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    prefixes.push(current);
  }
  return prefixes;
}

function isMacOsSystemFirmlinkPrefix(prefix: string): boolean {
  return (
    process.platform === "darwin" &&
    (prefix === "/var" || prefix === "/tmp" || prefix === "/etc")
  );
}

/**
 * `mkdirSync` çağrılmadan ÖNCE `targetDir` yolunun tüm önek/ata dizinlerini
 * yürür: var olan her önek için sembolik bağ (CWE-59), çözümlenemeyen/dangling
 * bağ, dizin-olmayan dosya ve yetkili `allowRoots` içine düşen gerçek yol
 * durumlarını reddeder (ADR-008: kaynak ağaca tek klasör bile açılamaz).
 */
function assertDataDirAncestorsSafe(
  targetDir: string,
  roots: readonly string[],
  canonicalRoots: readonly string[],
): void {
  for (const prefix of enumeratePathPrefixes(targetDir)) {
    let st;
    try {
      st = lstatSync(prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      throw new CausorynConfigError([
        `veri dizini üst yolu doğrulanamadı: ${prefix}`,
      ]);
    }

    if (st.isSymbolicLink() && !isMacOsSystemFirmlinkPrefix(prefix)) {
      throw new CausorynConfigError([
        `veri dizini veya üst dizini sembolik bağ olamaz (CWE-59): ${prefix}`,
      ]);
    }
    if (!st.isSymbolicLink() && !st.isDirectory()) {
      throw new CausorynConfigError([
        `veri dizini veya üst yolu bir dizin değil: ${prefix}`,
      ]);
    }

    let realPrefix: string;
    try {
      realPrefix = stripWin32DevicePrefix(realpathSync(prefix));
    } catch {
      throw new CausorynConfigError([
        `veri dizini üst yolunun gerçek konumu çözümlenemedi (dangling symlink / CWE-59): ${prefix}`,
      ]);
    }

    for (let i = 0; i < roots.length; i += 1) {
      const lexicalRoot = path.resolve(roots[i] as string);
      const canonicalRoot = canonicalRoots[i] as string;
      if (
        isSameOrInsideComparable(realPrefix, lexicalRoot) ||
        isSameOrInsideComparable(realPrefix, canonicalRoot)
      ) {
        throw new CausorynConfigError([
          `otomatik veri dizini yetkili workspace kökünün içinde olamaz (ADR-008): ${targetDir}`,
        ]);
      }
    }
  }
}

export interface WorkspaceAutoConfigOptions {
  readonly roots: readonly string[];
  readonly autoDataDir: boolean;
  readonly dataDir?: string;
  readonly client?: string;
  readonly rawBaseConfig?: unknown;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * CLI köklerini, `--auto-data-dir` / `--data-dir` kurulumunu ve isteğe bağlı
 * `CAUSORYN_CONFIG` taban alanlarını birleştirerek doğrulanmış `CausorynServerConfig`
 * üretir. Kaynak ağaca yazma tehlikesi varsa tek bir dizin bile oluşturmadan
 * `CausorynConfigError` ile reddeder.
 */
export function buildWorkspaceAutoConfig(
  options: WorkspaceAutoConfigOptions,
): CausorynServerConfig {
  const rawBase = options.rawBaseConfig ?? {};
  if (!isPlainObject(rawBase)) {
    return parseCausorynServerConfig(rawBase);
  }

  const baseAllowRoots = Array.isArray(rawBase["allowRoots"])
    ? (rawBase["allowRoots"] as unknown[])
    : [];
  const effectiveRoots: string[] =
    options.roots.length > 0
      ? options.roots.map((r) => path.resolve(r))
      : baseAllowRoots.map((entry) => String(entry));

  if (!options.autoDataDir || effectiveRoots.length === 0) {
    return parseCausorynServerConfig({
      ...rawBase,
      allowRoots: effectiveRoots,
    });
  }

  if (options.client !== undefined && !SAFE_CLIENT_ID_PATTERN.test(options.client)) {
    throw new CausorynConfigError([
      `geçersiz client kimliği: ${options.client}`,
    ]);
  }

  const canonicalRoots: string[] = effectiveRoots.map((root) => {
    try {
      const resolved = stripWin32DevicePrefix(realpathSync(path.resolve(root)));
      if (!statSync(resolved).isDirectory()) {
        throw new CausorynConfigError([`allowRoot bir dizin değil: ${root}`]);
      }
      return resolved;
    } catch (error) {
      if (error instanceof CausorynConfigError) throw error;
      throw new CausorynConfigError([
        `allowRoot gerçek yolu çözümlenemedi: ${root}`,
      ]);
    }
  });

  const baseDataDir = resolveBaseDataDir({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const primaryRoot = canonicalRoots[0] as string;
  const slug = deriveWorkspaceSlug(primaryRoot);
  const hash12 = sha256Hex(utf8Encode(normalizeComparablePath(primaryRoot))).slice(0, 12);
  const workspacesDir = path.join(baseDataDir, "workspaces");
  const workspaceDataDir = path.join(workspacesDir, `${slug}-${hash12}`);
  const exportsDir = path.join(workspaceDataDir, "exports");
  const dbFileName =
    options.client !== undefined
      ? `graph-${options.client.toLowerCase()}.sqlite`
      : "graph.sqlite";
  const dbPath = path.join(workspaceDataDir, dbFileName);

  // Yazmadan ÖNCE hem sözcüksel hem gerçek-ata yollarının workspace dışında
  // kaldığını ve hiçbir önek/ata dizinin sembolik/dangling bağ olmadığını
  // doğrula (ADR-008 + CWE-59: kaynak ağaca tek klasör bile açılamaz).
  assertStrictlyOutsideWorkspaceRoots(
    [baseDataDir, workspacesDir, workspaceDataDir, exportsDir, dbPath],
    effectiveRoots,
    canonicalRoots,
  );
  assertNotSymlinkDirectory(baseDataDir);
  assertNotSymlinkDirectory(workspacesDir);
  assertNotSymlinkDirectory(workspaceDataDir);
  assertNotSymlinkDirectory(exportsDir);
  assertDataDirAncestorsSafe(exportsDir, effectiveRoots, canonicalRoots);

  mkdirSync(workspaceDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(workspaceDataDir, 0o700);
      chmodSync(exportsDir, 0o700);
    } catch {
      // Dosya sistemi izin daraltmayı desteklemiyorsa sessiz geçilir.
    }
  }

  // Oluşturma sonrası realpath doğrulaması (TOCTOU savunması).
  const realWorkspaceDataDir = stripWin32DevicePrefix(realpathSync(workspaceDataDir));
  const realExportsDir = stripWin32DevicePrefix(realpathSync(exportsDir));
  assertStrictlyOutsideWorkspaceRoots(
    [realWorkspaceDataDir, realExportsDir],
    effectiveRoots,
    canonicalRoots,
  );

  const baseStorage = isPlainObject(rawBase["storage"]) ? rawBase["storage"] : {};
  const baseWiki = isPlainObject(rawBase["wiki"]) ? rawBase["wiki"] : {};
  const baseOutput = isPlainObject(rawBase["output"]) ? rawBase["output"] : {};

  const mergedConfig: Record<string, unknown> = {
    ...rawBase,
    allowRoots: effectiveRoots,
    workspaceId: Object.hasOwn(rawBase, "workspaceId") ? rawBase["workspaceId"] : slug,
    storage: {
      ...baseStorage,
      ...(Object.hasOwn(baseStorage, "dataDbPath") && baseStorage["dataDbPath"] !== undefined
        ? {}
        : { dataDbPath: dbPath }),
    },
    wiki: {
      ...baseWiki,
      ...(Object.hasOwn(baseWiki, "dataDbPath") && baseWiki["dataDbPath"] !== undefined
        ? {}
        : { dataDbPath: dbPath }),
    },
    output: {
      ...baseOutput,
      ...(Object.hasOwn(baseOutput, "allowedOutputDirs")
        ? {}
        : { allowedOutputDirs: [exportsDir] }),
    },
  };

  return parseCausorynServerConfig(mergedConfig);
}

export interface DynamicCausorynContext extends CausorynContext {
  readonly current: CausorynContext;
  rebind(nextContext: CausorynContext): void;
}

/**
 * Getter tabanlı dinamik `CausorynContext` sarmalayıcısı; `rebind` çağrısında
 * tüm araçların okuduğu aktif bağlamı atomik değiştirir ve eski bağlamı kapatır.
 */
export function createDynamicCausorynContext(
  initialContext: CausorynContext,
): DynamicCausorynContext {
  let active = initialContext;
  return {
    get current(): CausorynContext {
      return active;
    },
    get config(): CausorynServerConfig {
      return active.config;
    },
    get policy(): WorkspaceAccessPolicy {
      return active.policy;
    },
    get repository(): GraphRepository {
      return active.repository;
    },
    get symbolSearch(): SymbolSearchStore | null {
      return active.symbolSearch;
    },
    get indexService(): IndexService {
      return active.indexService;
    },
    get jobManager(): IndexJobManager {
      return active.jobManager;
    },
    get outputPolicy(): OutputAccessPolicy | null {
      return active.outputPolicy;
    },
    get wikiStore(): SqliteWikiStore | null {
      return active.wikiStore;
    },
    get wikiSearch(): WikiSearchStore | null {
      return active.wikiSearch;
    },
    get preflightStore(): PreflightManifestStore {
      return active.preflightStore;
    },
    get clock(): () => string {
      return active.clock;
    },
    get logger(): (message: string) => void {
      return active.logger;
    },
    close(): void {
      active.close();
    },
    rebind(nextContext: CausorynContext): void {
      if (nextContext === active) return;
      const previous = active;
      active = nextContext;
      try {
        previous.close();
      } catch (error) {
        active.logger(
          `[causoryn] önceki bağlam kapatılamadı: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export interface AttachMcpRootsBinderOptions {
  readonly allowCwd?: boolean;
  readonly explicitRoots?: readonly string[];
  readonly cwd?: string;
  readonly autoDataDir?: boolean;
  readonly dataDir?: string;
  readonly client?: string;
  readonly rawBaseConfig?: unknown;
  readonly homeDir?: string;
  readonly forbiddenDirs?: readonly string[];
  readonly scriptPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly contextOverrides?: ContextOverrides;
  readonly listRootsTimeoutMs?: number;
  readonly logger?: (message: string) => void;
}

export interface McpRootsWorkspaceBinder {
  readonly beforeToolCall: (toolName: string) => Promise<void>;
  readonly syncFromClientRoots: (force?: boolean) => Promise<void>;
}

const DEFAULT_LIST_ROOTS_TIMEOUT_MS = 5_000;

function hasExplicitBaseAllowRoots(rawBaseConfig: unknown): boolean {
  if (!isPlainObject(rawBaseConfig)) return false;
  const allowRoots = rawBaseConfig["allowRoots"];
  return Array.isArray(allowRoots) && allowRoots.length > 0;
}

function fileUriToLocalPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") {
      return null;
    }
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

/**
 * `--allow-cwd` etkin ve açık `--root` / `CAUSORYN_CONFIG.allowRoots` verilmemişken:
 * - `cwd` güvenliyse anında bağlar,
 * - `cwd` reddedildiyse (`$HOME`, `/`, `PLUGIN_DIR` vb.) `allowRoots: []` ile
 *   güvenli başlar ve `oninitialized`, `notifications/roots/list_changed` ile
 *   `beforeToolCall` kancalarında single-flight `listRoots` üzerinden ilk güvenli
 *   `file://` köküne geçiş yapar.
 */
export function attachMcpRootsWorkspaceBinder(
  server: McpServer,
  dynamicContext: DynamicCausorynContext,
  options: AttachMcpRootsBinderOptions = {},
): McpRootsWorkspaceBinder {
  const allowCwd = options.allowCwd ?? true;
  const hasExplicitRoots =
    (options.explicitRoots !== undefined && options.explicitRoots.length > 0) ||
    hasExplicitBaseAllowRoots(options.rawBaseConfig);

  if (!allowCwd || hasExplicitRoots) {
    return {
      beforeToolCall: async (): Promise<void> => {},
      syncFromClientRoots: async (): Promise<void> => {},
    };
  }

  const log =
    options.logger ??
    ((message: string): void => {
      dynamicContext.logger(message);
    });

  const effectiveContextOverrides: ContextOverrides = {
    ...options.contextOverrides,
    ...(options.logger !== undefined && options.contextOverrides?.logger === undefined
      ? { logger: options.logger }
      : {}),
  };

  const safetyOptions: SafeProjectRootOptions = {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.forbiddenDirs !== undefined ? { forbiddenDirs: options.forbiddenDirs } : {}),
    ...(options.scriptPath !== undefined ? { scriptPath: options.scriptPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  };

  const rebindRoot = (canonicalRoot: string | null): void => {
    const nextConfig = buildWorkspaceAutoConfig({
      roots: canonicalRoot === null ? [] : [canonicalRoot],
      autoDataDir: options.autoDataDir ?? false,
      ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.rawBaseConfig !== undefined ? { rawBaseConfig: options.rawBaseConfig } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    const nextContext = createCausorynContext(nextConfig, effectiveContextOverrides);
    dynamicContext.rebind(nextContext);
  };

  let currentBoundRoot: string | null =
    dynamicContext.config.allowRoots.length > 0
      ? resolveRealOrLexical(dynamicContext.config.allowRoots[0] as string)
      : null;
  let initialSyncDone = currentBoundRoot !== null;

  if (currentBoundRoot === null && options.cwd !== undefined) {
    const cwdCheck = inspectProjectRootSafety(options.cwd, safetyOptions);
    if (cwdCheck.safe) {
      rebindRoot(cwdCheck.canonicalRoot);
      currentBoundRoot = cwdCheck.canonicalRoot;
      initialSyncDone = true;
      log(
        `[causoryn] --allow-cwd ile güvenli çalışma alanı bağlandı: ${cwdCheck.canonicalRoot} (workspaceId=${dynamicContext.config.workspaceId})`,
      );
    } else {
      log(
        `[causoryn] --allow-cwd reddedildi (${cwdCheck.reason}); allowRoots: [] ile başlanıyor, MCP roots/list bekleniyor`,
      );
    }
  }

  const listRootsTimeoutMs =
    options.listRootsTimeoutMs !== undefined &&
    Number.isFinite(options.listRootsTimeoutMs) &&
    options.listRootsTimeoutMs > 0
      ? options.listRootsTimeoutMs
      : DEFAULT_LIST_ROOTS_TIMEOUT_MS;

  const performRootsSyncOnce = async (): Promise<boolean> => {
    let clientCaps = server.server.getClientCapabilities();
    if (clientCaps === undefined) {
      // Pipelined stdio akışında notifications/initialized, async _oninitialize'dan
      // bir microtask önce çalışabilir; yeteneklerin yazılması için bir tick bekle.
      await Promise.resolve();
      clientCaps = server.server.getClientCapabilities();
    }
    if (clientCaps === undefined) {
      return false;
    }
    if (!clientCaps.roots) {
      return true;
    }

    let listedRoots: ReadonlyArray<{ readonly uri: string; readonly name?: string | undefined }>;
    try {
      const response = await server.server.listRoots(undefined, {
        timeout: listRootsTimeoutMs,
      });
      listedRoots = response.roots;
    } catch (error) {
      log(
        `[causoryn] MCP roots/list alınamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }

    let selectedRoot: string | null = null;
    for (const entry of listedRoots) {
      const localPath = fileUriToLocalPath(entry.uri);
      if (localPath === null) continue;
      const safety = inspectProjectRootSafety(localPath, safetyOptions);
      if (!safety.safe) {
        log(`[causoryn] MCP root adayı atlandı (${safety.reason}): ${entry.uri}`);
        continue;
      }
      selectedRoot = safety.canonicalRoot;
      break;
    }

    if (selectedRoot === null) {
      if (currentBoundRoot !== null) {
        try {
          rebindRoot(null);
          currentBoundRoot = null;
          log("[causoryn] MCP roots/list güvenli kök içermiyor; allowRoots: [] durumuna dönüldü");
        } catch (error) {
          log(
            `[causoryn] boş bağlama dönüş başarısız: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return true;
    }

    if (currentBoundRoot !== null && isSameComparablePath(currentBoundRoot, selectedRoot)) {
      return true;
    }

    try {
      rebindRoot(selectedRoot);
      currentBoundRoot = selectedRoot;
      log(
        `[causoryn] MCP roots/list ile çalışma alanı bağlandı: ${selectedRoot} (workspaceId=${dynamicContext.config.workspaceId})`,
      );
    } catch (error) {
      log(
        `[causoryn] MCP roots/list çalışma alanı bağlanamadı (${selectedRoot}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  };

  let inFlight: Promise<void> | null = null;
  let pendingResync = false;

  const syncFromClientRoots = (force = false): Promise<void> => {
    if (!force && initialSyncDone && !pendingResync) {
      return inFlight ?? Promise.resolve();
    }
    if (force) {
      pendingResync = true;
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = (async (): Promise<void> => {
      try {
        while (pendingResync || !initialSyncDone) {
          const wasForced = pendingResync;
          pendingResync = false;
          const completed = await performRootsSyncOnce();
          if (completed) {
            initialSyncDone = true;
          } else if (!wasForced) {
            // Henüz initialize tamamlanmadıysa sonsuz döngüye girmeden çık;
            // sonraki oninitialized veya beforeToolCall tekrar deneyecek.
            break;
          }
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = (): void => {
    previousOnInitialized?.();
    if (!initialSyncDone) {
      void syncFromClientRoots(false);
    }
  };

  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await syncFromClientRoots(true);
  });

  return {
    beforeToolCall: async (_toolName: string): Promise<void> => {
      await syncFromClientRoots(false);
    },
    syncFromClientRoots,
  };
}
