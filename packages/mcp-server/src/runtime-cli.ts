import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex, utf8Encode } from "@causoryn/domain";
import type { GraphRepository, SymbolSearchStore } from "@causoryn/graph";
import type { IndexJobManager, IndexService } from "@causoryn/indexing";
import {
  migrateLegacyWorkspaceDatabase,
  readSqliteUserVersion,
  SCHEMA_VERSION as STORAGE_SCHEMA_VERSION,
  type SqliteWikiStore,
} from "@causoryn/storage-sqlite";
import type { WikiSearchStore } from "@causoryn/wiki";
import {
  inspectLinkTargets,
  isUncOrDevicePath,
  LINK_TARGET_INSPECTION_ENABLED,
  readBoundedTextFileSync,
  type OutputAccessPolicy,
  type WorkspaceAccessPolicy,
} from "@causoryn/workspace";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CausorynConfigError,
  parseCausorynServerConfig,
  type CausorynServerConfig,
} from "./config.js";
import {
  createCausorynContext,
  type ActiveIndexJobInfo,
  type CausorynContext,
  type ContextOverrides,
  type WaitForInitialIndexOptions,
} from "./context.js";
import type { PreflightManifestStore } from "./preflight-store.js";
import type { BeforeToolCallContext, OutputSchemaProfile } from "./server.js";
import { tryParseToolProfile } from "./tool-profile.js";
import type { ToolProfile } from "./version.js";
import { discoverWorkspaceIgnoreConfig } from "./workspace-ignore-discovery.js";

/**
 * K-021 — Sıfır-ayar MCP CLI bayrakları, güvenli `--allow-cwd` kök filtresi,
 * `--auto-data-dir` workspace-dışı veri kökü hazırlayıcısı ve masaüstü IDE'ler
 * için dinamik MCP `roots/list` + `notifications/roots/list_changed` bağlayıcısı.
 *
 * Kırmızı çizgiler (TŞ §9, §10.1, §20, ADR-008):
 * - Çıplak `node stdio.ts` / `node dist/mcp-server.mjs` (0 argüman) çağrısında
 *   eski davranış %100 korunur (`allowRoots: []` default deny + `"full"` şema).
 * - `$HOME`, dosya sistemi kökü (`/`, `C:\`), `~/.causoryn`, `ZCODE_PLUGIN_DATA`,
 *   `--data-dir`, Causoryn eklenti/bundle kurulum dizinleri, hassas kullanıcı
 *   dizinleri (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`,
 *   `~/.codex`, `~/.zcode`, `~/.config`, `~/.docker`, `~/.azure`, `~/.gcloud`,
 *   `~/.npm`, `~/.cargo`, `~/Library`, `%APPDATA%`, `%LOCALAPPDATA%`) ve OS
 *   sistem dizinleri ASLA proje kökü olarak yetkilendirilmez.
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
  readonly toolProfile?: string;
}

const KNOWN_FLAGS = new Set([
  "--allow-cwd",
  "--root",
  "--auto-data-dir",
  "--data-dir",
  "--client",
  "--output-schema",
  "--output-schema-profile",
  "--tool-profile",
]);

/**
 * Parses a single or comma-separated tool profile string (e.g., "core", "full",
 * "wiki", "history", "wiki,history"). Throws McpCliUsageError on invalid
 * entries; `source` names the setting in the message (`--tool-profile`,
 * `CAUSORYN_TOOL_PROFILE` or `CAUSORYN_CONFIG.toolProfile`).
 */
export function parseToolProfile(
  raw: string,
  source = "--tool-profile",
): readonly ToolProfile[] {
  const parsed = tryParseToolProfile(raw);
  if (!parsed.ok) {
    throw new McpCliUsageError(`${source}: ${parsed.message}`);
  }
  return parsed.profiles;
}

const SAFE_CLIENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * `stdio.ts` ve `causoryn mcp` CLI argümanlarını ayrıştırır.
 * Geçersiz bayrak, `\0` baytı veya eksik değer `McpCliUsageError` fırlatır.
 */
export function parseMcpCliArgs(argv: readonly string[]): ParsedMcpCliArgs {
  for (const token of argv) {
    if (token.includes("\0")) {
      throw new McpCliUsageError("CLI arguments must not contain a NUL byte");
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
  let toolProfile: string | undefined;
  const roots: string[] = [];

  const readRequiredValue = (flag: string, inlineValue: string | undefined): string => {
    if (inlineValue !== undefined) {
      if (inlineValue.trim().length === 0) {
        throw new McpCliUsageError(`${flag} must not have an empty value`);
      }
      return inlineValue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.trim().length === 0 || KNOWN_FLAGS.has(next)) {
      throw new McpCliUsageError(`${flag} requires a value`);
    }
    index += 1;
    return next;
  };

  for (; index < argv.length; index += 1) {
    const rawToken = argv[index] as string;
    if (!rawToken.startsWith("--")) {
      throw new McpCliUsageError(`Unexpected positional argument or flag: ${rawToken}`);
    }

    const eqPos = rawToken.indexOf("=");
    const flag = eqPos >= 0 ? rawToken.slice(0, eqPos) : rawToken;
    const inlineValue = eqPos >= 0 ? rawToken.slice(eqPos + 1) : undefined;

    switch (flag) {
      case "--allow-cwd": {
        if (inlineValue !== undefined) {
          throw new McpCliUsageError("--allow-cwd does not take a value");
        }
        allowCwd = true;
        break;
      }
      case "--auto-data-dir": {
        if (inlineValue !== undefined) {
          throw new McpCliUsageError("--auto-data-dir does not take a value");
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
            `Invalid --client id (only alphanumerics, '.', '_' and '-' are allowed): ${clientValue}`,
          );
        }
        client = clientValue;
        break;
      }
      case "--output-schema":
      case "--output-schema-profile": {
        const profileValue = readRequiredValue(flag, inlineValue);
        if (profileValue !== "full" && profileValue !== "omit") {
          throw new McpCliUsageError(
            `${flag} must be 'full' or 'omit': ${profileValue}`,
          );
        }
        outputSchemaProfile = profileValue;
        break;
      }
      case "--tool-profile": {
        const rawProfile = readRequiredValue("--tool-profile", inlineValue);
        const normalized = parseToolProfile(rawProfile);
        toolProfile = normalized.join(",");
        break;
      }
      default:
        throw new McpCliUsageError(`Unknown CLI flag: ${flag}`);
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
    ...(toolProfile !== undefined ? { toolProfile } : {}),
  };
}

/**
 * Resolves the effective outputSchemaProfile:
 * `--output-schema` / `--output-schema-profile` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `"omit"`.
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
      `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE must be 'full' or 'omit': ${envRaw}`,
    );
  }
  return "omit";
}

/**
 * Resolves the effective tool profile string:
 * `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile`
 * (`configToolProfile`) > `"core"`. Every supplied value is validated, even
 * when a higher-precedence source wins, so a typo never hides until the
 * higher-precedence setting is removed.
 */
export function resolveEffectiveToolProfile(
  cliArgs: ParsedMcpCliArgs,
  env: NodeJS.ProcessEnv = process.env,
  configToolProfile?: string,
): string {
  const fromConfig =
    configToolProfile === undefined
      ? undefined
      : parseToolProfile(configToolProfile, "CAUSORYN_CONFIG.toolProfile").join(",");
  const envRaw = env["CAUSORYN_TOOL_PROFILE"]?.trim();
  const fromEnv =
    envRaw !== undefined && envRaw.length > 0
      ? parseToolProfile(envRaw, "CAUSORYN_TOOL_PROFILE").join(",")
      : undefined;
  if (cliArgs.toolProfile !== undefined) {
    return parseToolProfile(cliArgs.toolProfile).join(",");
  }
  return fromEnv ?? fromConfig ?? "core";
}

/** Startup settings shared by the bare `stdio.ts` entry and the `causoryn mcp` entry. */
export interface McpServerSettings {
  readonly outputSchemaProfile: OutputSchemaProfile;
  readonly toolProfile: string;
  readonly indexWaitTimeoutMs: number;
}

function configToolProfileOf(rawConfig: unknown): string | undefined {
  if (!isPlainObject(rawConfig) || !Object.hasOwn(rawConfig, "toolProfile")) {
    return undefined;
  }
  const value = rawConfig["toolProfile"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new McpCliUsageError(
      `CAUSORYN_CONFIG.toolProfile must be a string (for example "core" or "wiki,history"), got ${value === null ? "null" : typeof value}`,
    );
  }
  return value;
}

/**
 * The single resolver both MCP entry points use for their startup settings:
 * output schema profile (`--output-schema` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE`
 * > `"omit"`), tool profile (`--tool-profile` > `CAUSORYN_TOOL_PROFILE` >
 * `CAUSORYN_CONFIG.toolProfile` > `"core"`) and the cold-start index wait
 * window (`CAUSORYN_INDEX_WAIT_MS`). `rawConfig` is the parsed
 * `CAUSORYN_CONFIG` JSON (`{}` when unset). The bare entry passes
 * `parseMcpCliArgs([])`. Invalid values throw `McpCliUsageError`.
 */
export function resolveMcpServerSettings(
  cliArgs: ParsedMcpCliArgs,
  env: NodeJS.ProcessEnv = process.env,
  rawConfig: unknown = {},
): McpServerSettings {
  return {
    outputSchemaProfile: resolveEffectiveOutputSchemaProfile(cliArgs, env),
    toolProfile: resolveEffectiveToolProfile(cliArgs, env, configToolProfileOf(rawConfig)),
    indexWaitTimeoutMs: resolveIndexWaitTimeoutMs(env),
  };
}

export const DEFAULT_INDEX_WAIT_MS = 15_000;

/**
 * Resolves the bounded cold-start indexing wait window from `CAUSORYN_INDEX_WAIT_MS`
 * (defaults to 15,000 ms; 0 skips waiting and returns indexing status immediately).
 */
export function resolveIndexWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["CAUSORYN_INDEX_WAIT_MS"]?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_INDEX_WAIT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INDEX_WAIT_MS;
  }
  return Math.floor(parsed);
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
  if (isUncOrDevicePath(inputPath)) {
    return inputPath;
  }
  const abs = path.resolve(inputPath);
  if (isUncOrDevicePath(abs)) {
    return abs;
  }
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

function isSameAsResolvedDirs(
  targetPath: string,
  realTargetPath: string,
  entries: readonly ResolvedDirEntry[],
): boolean {
  for (const entry of entries) {
    if (
      isSameComparablePath(targetPath, entry.raw) ||
      isSameComparablePath(targetPath, entry.real) ||
      isSameComparablePath(realTargetPath, entry.raw) ||
      isSameComparablePath(realTargetPath, entry.real)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Root-safety probe of the entries below a candidate directory (F18 / F23).
 * The directory itself is canonical (a realpath, or an ancestor of one); every
 * entry below it may be planted by the analyzed repository, so:
 * - nothing below a link is touched: components are lstat'd top down;
 * - a link whose target chain reaches a UNC/device path (Windows) is refused
 *   from lstat/readlink alone, before anything follows it (outbound SMB/NTLM);
 * - file contents are read only with the descriptor-bound bounded reader
 *   (no link, regular file, size-capped), never unbounded.
 */

/** What lstat reports for an entry (a link is never followed). */
type ProbedKind = "file" | "directory" | "link" | "other" | "missing";

/** Top-down lstat of `root/<segments...>`: the first link met ends the walk. */
function probeBelow(root: string, segments: readonly string[]): ProbedKind {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    let st: Stats;
    try {
      st = lstatSync(current);
    } catch {
      return "missing";
    }
    if (st.isSymbolicLink()) return "link";
    const isLast = index === segments.length - 1;
    if (isLast) return st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
    if (!st.isDirectory()) return "missing";
  }
  return "missing";
}

/** Why following `target` (below the canonical `root`) is refused, or undefined when its links are local. */
function unsafeLinkReason(root: string, target: string): string | undefined {
  if (!LINK_TARGET_INSPECTION_ENABLED) return undefined;
  const inspection = inspectLinkTargets(target, { startDir: root });
  return inspection.ok ? undefined : inspection.reason;
}

/** Result of probing a plugin/bundle marker, which rejects the root when present. */
type MarkerProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly text?: string }
  | { readonly kind: "unsafe-link"; readonly reason: string };

const ABSENT_MARKER: MarkerProbe = { kind: "absent" };

/**
 * Existence of a marker below `root`, as `existsSync` reported it before, but
 * a link on the way is followed only after its target chain was inspected.
 */
function probeMarkerExists(root: string, segments: readonly string[]): MarkerProbe {
  const kind = probeBelow(root, segments);
  if (kind === "missing") return ABSENT_MARKER;
  if (kind !== "link") return { kind: "present" };
  const target = path.join(root, ...segments);
  const reason = unsafeLinkReason(root, target);
  if (reason !== undefined) return { kind: "unsafe-link", reason };
  return existsSync(target) ? { kind: "present" } : ABSENT_MARKER;
}

const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
/** Root package.json read by the monorepo check (bounded, like the manifests). */
const MAX_ROOT_PACKAGE_JSON_BYTES = 64 * 1024;

/**
 * Text of a plugin manifest below `root` (bounded reader, at most 64 KiB).
 * A manifest reached through a link (a symlinked plugin install, which keeps
 * being detected) is read only after the link's target chain was inspected,
 * through the bounded reader at its resolved location.
 */
function readPluginManifest(root: string, segments: readonly string[]): MarkerProbe {
  const manifestPath = path.join(root, ...segments);
  const direct = readBoundedTextFileSync(manifestPath, MAX_PLUGIN_MANIFEST_BYTES, { root });
  if (direct.status === "ok") return { kind: "present", text: direct.text };
  if (direct.status !== "rejected" || probeBelow(root, segments) !== "link") return ABSENT_MARKER;
  const reason = unsafeLinkReason(root, manifestPath);
  if (reason !== undefined) return { kind: "unsafe-link", reason };
  let resolved: string;
  try {
    resolved = stripWin32DevicePrefix(realpathSync(manifestPath));
  } catch {
    return ABSENT_MARKER;
  }
  if (isUncOrDevicePath(resolved)) return { kind: "unsafe-link", reason: "unc-or-device-link-target" };
  const viaLink = readBoundedTextFileSync(resolved, MAX_PLUGIN_MANIFEST_BYTES, { root: path.dirname(resolved) });
  return viaLink.status === "ok" ? { kind: "present", text: viaLink.text } : ABSENT_MARKER;
}

/**
 * Bir dizinin `package.json` `"workspaces"` + monorepo kaynak işaretleri
 * (`AGENTS.md` veya `packages/` + `adapters/` dizinleri) taşıyan monorepo
 * kaynak kökü olup olmadığını denetler (kök plugin manifesti barındırsa bile
 * geliştirici ve kamuya açık dışa aktarılmış monorepo kökü reddedilmez;
 * ancak `node_modules`, `_npx` veya yasaklı eklenti dizinleri içindeki Git
 * klonları asla monorepo sayılmaz).
 * The markers grant an exemption, so a link never counts as one: they are
 * lstat'd only and package.json is read with the bounded reader (F18 / F23).
 */
function isMonorepoWorkspaceRoot(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): boolean {
  const hasAgentsMd = probeBelow(dirPath, ["AGENTS.md"]) === "file";
  const hasMonorepoDirs =
    probeBelow(dirPath, ["packages"]) === "directory" && probeBelow(dirPath, ["adapters"]) === "directory";
  if (!hasAgentsMd && !hasMonorepoDirs) {
    return false;
  }
  const pkg = readBoundedTextFileSync(path.join(dirPath, "package.json"), MAX_ROOT_PACKAGE_JSON_BYTES, {
    root: dirPath,
  });
  if (pkg.status !== "ok") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(pkg.text);
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

const PLUGIN_MANIFEST_SEGMENTS: readonly (readonly string[])[] = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
  ["plugin.json"],
];

/**
 * Plugin install markers of a directory above the server script. A marker
 * behind a UNC/device link counts as present (fail closed: the directory is
 * forbidden) and is never followed.
 */
function hasPluginInstallMarkers(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): boolean {
  if (isMonorepoWorkspaceRoot(dirPath, forbiddenEntries)) {
    return false;
  }
  const marked = (segments: readonly string[]): boolean => probeMarkerExists(dirPath, segments).kind !== "absent";
  return (
    PLUGIN_MANIFEST_SEGMENTS.slice(0, 3).some(marked) ||
    (marked(["plugin.json"]) && marked(["mcp_config.json"]))
  );
}

/** Whether a candidate (or an ancestor) is a Causoryn plugin/bundle install. */
type CausorynInstallVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "causoryn-install" }
  | { readonly kind: "unsafe-link"; readonly reason: string };

function causorynInstallVerdict(
  dirPath: string,
  forbiddenEntries: readonly ResolvedDirEntry[] = [],
): CausorynInstallVerdict {
  if (isMonorepoWorkspaceRoot(dirPath, forbiddenEntries)) {
    return { kind: "none" };
  }
  const bundleManifest = probeMarkerExists(dirPath, ["bundle-manifest.json"]);
  if (bundleManifest.kind === "unsafe-link") return bundleManifest;
  if (bundleManifest.kind === "present") return { kind: "causoryn-install" };
  for (const segments of PLUGIN_MANIFEST_SEGMENTS) {
    const manifest = readPluginManifest(dirPath, segments);
    if (manifest.kind === "unsafe-link") return manifest;
    if (manifest.kind !== "present" || manifest.text === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(manifest.text);
      if (isPlainObject(parsed) && parsed["name"] === "causoryn") {
        return { kind: "causoryn-install" };
      }
    } catch {
      // Okunamayan aday atlanır.
    }
  }
  return { kind: "none" };
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
      probeMarkerExists(scriptDir, ["bundle-manifest.json"]).kind !== "absent"
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
 * Credential and tool configuration directories below the home directory; the
 * directory itself and everything inside it is rejected as a project root.
 * Platform independent on purpose (deterministic, and harmless where absent).
 */
const SENSITIVE_HOME_SUBDIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".claude",
  ".codex",
  ".zcode",
  ".config",
  ".docker",
  ".azure",
  ".gcloud",
  ".npm",
  ".cargo",
  "Library",
  path.join("AppData", "Roaming"),
  path.join("AppData", "Local"),
] as const;

/** Environment-named per-user application data directories (Windows profile layout). */
const SENSITIVE_ENV_DIR_KEYS = ["APPDATA", "LOCALAPPDATA"] as const;

const POSIX_SYSTEM_DIRS = [
  "/etc",
  "/private/etc",
  "/System",
  "/usr",
  "/proc",
  "/sys",
  "/root",
  "/bin",
  "/sbin",
  "/lib",
  "/dev",
] as const;

/**
 * Exact-match denied directories on POSIX: these bare roots are rejected, while
 * nested project subdirectories (e.g. `/tmp/causoryn-test-xxx` or macOS
 * `/var/folders/.../T/causoryn-test-xxx`) remain allowed.
 */
const POSIX_EXACT_DENIED_DIRS = [
  "/tmp",
  "/private/tmp",
  "/var",
  "/private/var",
  "/var/tmp",
  "/private/var/tmp",
  "/home",
  "/Users",
] as const;

const WINDOWS_FALLBACK_SYSTEM_DIRS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
] as const;

const WINDOWS_SYSTEM_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
] as const;

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  if (process.platform === "win32") {
    const target = key.toLowerCase();
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase() === target) {
        return v;
      }
    }
  }
  return undefined;
}

/** Like `resolveRealOrLexical`, but with the native realpath (8.3 short names expanded). */
function resolveNativeRealOrLexical(inputPath: string): string {
  const abs = path.resolve(inputPath);
  if (isUncOrDevicePath(inputPath) || isUncOrDevicePath(abs)) {
    return abs;
  }
  // Mocked `node:fs` modules may not carry `.native`; fall back to the JS realpath.
  const native = (realpathSync as { native?: (p: string) => string }).native;
  const realpath = typeof native === "function" ? native : realpathSync;
  const tailSegments: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const realAncestor = stripWin32DevicePrefix(realpath(cursor));
      return tailSegments.length === 0 ? realAncestor : path.join(realAncestor, ...tailSegments.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return abs;
      tailSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Every spelling of a directory used by the sensitive-directory comparison:
 * lexical, realpath and native long-name form. A directory reached through a
 * link to a UNC/device target is compared lexically only (never followed).
 */
function sensitivePathForms(dir: string): string[] {
  const lexical = path.resolve(dir);
  if (isUncOrDevicePath(dir) || isUncOrDevicePath(lexical)) {
    return [lexical];
  }
  if (LINK_TARGET_INSPECTION_ENABLED && !inspectLinkTargets(lexical).ok) {
    return [lexical];
  }
  return [lexical, resolveRealOrLexical(lexical), resolveNativeRealOrLexical(lexical)];
}

function deriveSensitiveUserDirs(homeDir: string, env: NodeJS.ProcessEnv): string[][] {
  const rawDirs: string[] = [];
  if (homeDir.trim().length > 0) {
    for (const subdir of SENSITIVE_HOME_SUBDIRS) {
      rawDirs.push(path.join(homeDir, subdir));
    }
  }
  for (const key of SENSITIVE_ENV_DIR_KEYS) {
    const value = readEnvValue(env, key)?.trim();
    if (value !== undefined && value.length > 0 && path.isAbsolute(value)) {
      rawDirs.push(value);
    }
  }
  return rawDirs.map(sensitivePathForms);
}

function anyFormSameOrInside(targets: readonly string[], containers: readonly string[]): boolean {
  return targets.some((target) => containers.some((container) => isSameOrInsideComparable(target, container)));
}

/**
 * Same-or-inside test against the sensitive directories. The OS temp directory
 * may itself live inside one (Windows: %LOCALAPPDATA%\Temp); projects inside the
 * temp directory stay usable there, while the bare temp root is rejected
 * separately as an exact system directory.
 */
function isInsideSensitiveUserDir(
  candidateForms: readonly string[],
  homeDir: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const rawTemp = os.tmpdir().trim();
  const tempForms = rawTemp.length === 0 || isUncOrDevicePath(rawTemp) ? [] : sensitivePathForms(rawTemp);
  for (const entryForms of deriveSensitiveUserDirs(homeDir, env)) {
    if (!anyFormSameOrInside(candidateForms, entryForms)) continue;
    if (
      tempForms.length > 0 &&
      anyFormSameOrInside(tempForms, entryForms) &&
      anyFormSameOrInside(candidateForms, tempForms)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function deriveSystemDirs(env: NodeJS.ProcessEnv): ResolvedDirEntry[] {
  const rawDirs: string[] = [];
  if (process.platform === "win32") {
    for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
      const value = readEnvValue(env, key)?.trim();
      if (value !== undefined && value.length > 0) {
        rawDirs.push(value);
      }
    }
    for (const fallback of WINDOWS_FALLBACK_SYSTEM_DIRS) {
      rawDirs.push(fallback);
    }
  } else {
    for (const dir of POSIX_SYSTEM_DIRS) {
      rawDirs.push(dir);
    }
  }

  const seen = new Set<string>();
  const entries: ResolvedDirEntry[] = [];
  for (const rawDir of rawDirs) {
    if (rawDir.trim().length === 0) continue;
    const comparable = normalizeComparablePath(rawDir);
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    entries.push(toResolvedDirEntry(rawDir));
  }
  return entries;
}

function deriveExactDeniedDirs(): ResolvedDirEntry[] {
  const rawDirs: string[] = [];
  const osTmp = os.tmpdir().trim();
  if (osTmp.length > 0 && !isUncOrDevicePath(osTmp)) {
    rawDirs.push(osTmp);
  }
  if (process.platform !== "win32") {
    for (const dir of POSIX_EXACT_DENIED_DIRS) {
      rawDirs.push(dir);
    }
  }

  const seen = new Set<string>();
  const entries: ResolvedDirEntry[] = [];
  for (const rawDir of rawDirs) {
    const comparable = normalizeComparablePath(rawDir);
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    entries.push(toResolvedDirEntry(rawDir));
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
    return { safe: false, reason: "empty or invalid path" };
  }

  // Lexical UNC / Win32 device path pre-check BEFORE any filesystem syscall
  // (prevents outbound SMB/NTLM handshake via realpathSync / statSync).
  if (isUncOrDevicePath(candidatePath) || isUncOrDevicePath(candidatePath.trim())) {
    return { safe: false, reason: "unc-or-device-path" };
  }

  const lexicalCandidate = path.resolve(candidatePath);
  if (isUncOrDevicePath(lexicalCandidate)) {
    return { safe: false, reason: "unc-or-device-path" };
  }
  // Links whose target is a UNC/device path are rejected before realpathSync follows them.
  if (LINK_TARGET_INSPECTION_ENABLED) {
    const inspection = inspectLinkTargets(lexicalCandidate);
    if (!inspection.ok) {
      return { safe: false, reason: inspection.reason };
    }
  }

  let real: string;
  try {
    real = stripWin32DevicePrefix(realpathSync(lexicalCandidate));
    if (!statSync(real).isDirectory()) {
      return { safe: false, reason: `not a directory: ${real}` };
    }
  } catch {
    return { safe: false, reason: `unresolvable directory: ${candidatePath}` };
  }

  // 1) Dosya sistemi kökleri (/, C:\, D:\ vb.)
  if (path.dirname(real) === real || path.parse(real).root === real) {
    return { safe: false, reason: `filesystem root rejected: ${real}` };
  }

  // 2) Kullanıcı ev dizini ($HOME) ve tüm üst ataları (ör. /home, /Users, C:\Users)
  const rawHome = options.homeDir ?? os.homedir();
  // Native long-name form of the candidate (8.3 short names expanded) for the
  // home and sensitive-directory comparisons below.
  const realNative = resolveNativeRealOrLexical(real);
  if (rawHome.trim().length > 0 && !isUncOrDevicePath(rawHome)) {
    const realHome = resolveRealOrLexical(rawHome);
    const homeForms = sensitivePathForms(rawHome);
    if (
      isSameComparablePath(real, rawHome) ||
      isSameComparablePath(real, realHome) ||
      homeForms.some((homeForm) => isSameComparablePath(realNative, homeForm))
    ) {
      return { safe: false, reason: `user home directory ($HOME) rejected: ${real}` };
    }
    if (
      isSameOrInsideComparable(rawHome, real) ||
      isSameOrInsideComparable(realHome, real) ||
      homeForms.some((homeForm) => isSameOrInsideComparable(homeForm, realNative))
    ) {
      return { safe: false, reason: "home-ancestor-directory" };
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
    if (isUncOrDevicePath(rawDataDir)) continue;
    const realDataDir = resolveRealOrLexical(rawDataDir);
    if (
      isSameOrInsideComparable(real, rawDataDir) ||
      isSameOrInsideComparable(real, realDataDir)
    ) {
      return { safe: false, reason: `Causoryn data directory rejected: ${real}` };
    }
  }

  // 4) Yasaklı eklenti/bundle/runtime kurulum dizinleri (isMonorepoWorkspaceRoot'tan ÖNCE!)
  const forbiddenEntries = deriveForbiddenPluginDirs(rawHome, options);
  if (isInsideResolvedDirs(real, real, forbiddenEntries)) {
    return { safe: false, reason: "plugin-install-directory" };
  }

  // 5) Sensitive credential/tool configuration directories (SENSITIVE_HOME_SUBDIRS,
  //    %APPDATA%, %LOCALAPPDATA%), compared in lexical, realpath and native forms.
  if (isInsideSensitiveUserDir([lexicalCandidate, real, realNative], rawHome, env)) {
    return { safe: false, reason: "sensitive-directory" };
  }

  // 6) OS sistem kök/sistem dizinleri (/etc, /private/etc, /System, /usr, /proc, /sys, /root, /bin, /sbin, /lib, /dev, C:\Windows, Program Files, ProgramData)
  //    ve tam eşleşmeli geçici/sistem kökleri (/tmp, /var, os.tmpdir() — alt dizinlere izin verilir)
  const systemEntries = deriveSystemDirs(env);
  if (isInsideResolvedDirs(lexicalCandidate, real, systemEntries)) {
    return { safe: false, reason: "system-directory" };
  }
  const exactDeniedEntries = deriveExactDeniedDirs();
  if (isSameAsResolvedDirs(lexicalCandidate, real, exactDeniedEntries)) {
    return { safe: false, reason: "system-directory" };
  }

  // Adayın kendisi (veya monorepo olmayan üst atası) Causoryn plugin kurulumuysa reddet.
  // A plugin/bundle marker behind a UNC/device link rejects the root (fail closed, never followed).
  let ancestorCursor = real;
  while (true) {
    const verdict = causorynInstallVerdict(ancestorCursor, forbiddenEntries);
    if (verdict.kind === "unsafe-link") {
      return { safe: false, reason: verdict.reason };
    }
    if (verdict.kind === "causoryn-install") {
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

/** Where a base data directory candidate came from. */
export type DataDirSource = "--data-dir" | "home" | "ZCODE_PLUGIN_DATA";

export interface DataDirCandidate {
  readonly dir: string;
  readonly source: DataDirSource;
}

export interface DataDirCandidates {
  /** The base data directory every host resolves the same way. */
  readonly primary: DataDirCandidate;
  /** Used only when `primary` cannot hold the workspace data directory. */
  readonly fallback?: DataDirCandidate;
}

export interface BaseDataDirOptions {
  readonly dataDir?: string;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Validates `ZCODE_PLUGIN_DATA` when set (fail-closed even when unused). */
function readZcodePluginDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const zcodeDataDir = env["ZCODE_PLUGIN_DATA"]?.trim();
  if (zcodeDataDir === undefined || zcodeDataDir.length === 0) {
    return undefined;
  }
  if (zcodeDataDir.includes("\0")) {
    throw new CausorynConfigError(["ZCODE_PLUGIN_DATA must not contain a NUL byte"]);
  }
  if (isUncOrDevicePath(zcodeDataDir)) {
    throw new CausorynConfigError([
      `ZCODE_PLUGIN_DATA must not be a UNC or Win32 device path: ${zcodeDataDir}`,
    ]);
  }
  if (!path.isAbsolute(zcodeDataDir)) {
    throw new CausorynConfigError([
      `ZCODE_PLUGIN_DATA must be an absolute path: ${zcodeDataDir}`,
    ]);
  }
  return path.resolve(zcodeDataDir);
}

/**
 * Resolves the base data directory candidates. Precedence: `--data-dir`
 * (explicit; no fallback) > `~/.causoryn`. `~/.causoryn` is the base for
 * every host, so Claude Code, Codex, Antigravity and ZCode share one
 * `workspaces/<slug>-<hash12>/graph.sqlite` per workspace. `ZCODE_PLUGIN_DATA`
 * (the ZCode plugin's persistent data directory) is only a fallback for when
 * `~/.causoryn` cannot be created or written; nothing documents a ZCode
 * restriction on writing to `~/.causoryn` (the plugin's MCP server is an
 * ordinary user process).
 */
export function resolveDataDirCandidates(options: BaseDataDirOptions): DataDirCandidates {
  const explicitDataDir = options.dataDir?.trim();
  if (explicitDataDir !== undefined && explicitDataDir.length > 0) {
    if (explicitDataDir.includes("\0")) {
      throw new CausorynConfigError(["--data-dir must not contain a NUL byte"]);
    }
    if (isUncOrDevicePath(explicitDataDir)) {
      throw new CausorynConfigError([
        `--data-dir must not be a UNC or Win32 device path: ${explicitDataDir}`,
      ]);
    }
    if (!path.isAbsolute(explicitDataDir)) {
      throw new CausorynConfigError([`--data-dir must be an absolute path: ${explicitDataDir}`]);
    }
    return { primary: { dir: path.resolve(explicitDataDir), source: "--data-dir" } };
  }

  const env = options.env ?? process.env;
  const zcodeDataDir = readZcodePluginDataDir(env);
  const homeDir = options.homeDir ?? os.homedir();
  if (isUncOrDevicePath(homeDir)) {
    if (zcodeDataDir !== undefined) {
      return { primary: { dir: zcodeDataDir, source: "ZCODE_PLUGIN_DATA" } };
    }
    throw new CausorynConfigError([
      `homeDir must not be a UNC or Win32 device path: ${homeDir}`,
    ]);
  }
  const homeDataDir = path.resolve(homeDir, ".causoryn");
  return {
    primary: { dir: homeDataDir, source: "home" },
    ...(zcodeDataDir !== undefined && !isSameComparablePath(zcodeDataDir, homeDataDir)
      ? { fallback: { dir: zcodeDataDir, source: "ZCODE_PLUGIN_DATA" as const } }
      : {}),
  };
}

/** The primary base data directory (`--data-dir` > `~/.causoryn`). */
export function resolveBaseDataDir(options: BaseDataDirOptions): string {
  return resolveDataDirCandidates(options).primary.dir;
}

/**
 * A data directory that exists as a non-directory or cannot be created or
 * written. Unlike symlink / inside-workspace violations (security errors that
 * always stop startup), this one lets startup move on to a fallback base.
 */
class DataDirUnusableError extends CausorynConfigError {
  readonly reason: string;

  constructor(issue: string, reason: string) {
    super([issue]);
    this.name = "DataDirUnusableError";
    this.reason = reason;
  }
}

function isSlugTrimChar(code: number): boolean {
  return code === 46 /* '.' */ || code === 95 /* '_' */ || code === 45 /* '-' */;
}

function trimSlugEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSlugTrimChar(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isSlugTrimChar(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function deriveWorkspaceSlug(canonicalRoot: string): string {
  const base = path.basename(canonicalRoot).toLowerCase();
  const normalized = base.replace(/[^a-z0-9._-]+/g, "-");
  const cleaned = trimSlugEdges(normalized).slice(0, 48);
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
          `the automatic data directory must not be inside an authorized workspace root: ${target}`,
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
        `the data directory must not be a symbolic link (CWE-59): ${targetDir}`,
      ]);
    }
    if (!st.isDirectory()) {
      throw new DataDirUnusableError(
        `the data directory path is not a directory: ${targetDir}`,
        `${targetDir} is not a directory`,
      );
    }
  } catch (error) {
    if (error instanceof CausorynConfigError) throw error;
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw new CausorynConfigError([
        `the data directory status could not be verified: ${targetDir}`,
      ]);
    }
  }
}

/** The server's uid where the platform has one (POSIX); read at call time. */
function serverUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

const GROUP_OR_OTHER_WRITE = 0o022;
const GROUP_OR_OTHER_ANY = 0o077;

function permissionText(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/**
 * F41: a data directory that exists (just created or reused) must be a real
 * directory, not a link, and on POSIX be owned by the server's uid. A base
 * directory the user supplied (it existed before this run) is refused when
 * group or others can write it, like `setup`'s assertPrivateDirectory (it is
 * never chmod'ed); every directory this run created and Causoryn's own
 * `workspaces`, workspace and `exports` directories are made owner-only
 * (0700). A chmod that fails, or a mode that is still too open afterwards (a
 * file system that ignores chmod), stops startup: another local user could
 * otherwise read or replace the index. Windows ACLs are not inspected here
 * (no uid there; the history cache trusts only a data root inside the user's
 * profile).
 */
function assertPrivateDataDirectory(dir: string, access: "user-supplied" | "owner-only"): void {
  const inspect = (): Stats => {
    let st: Stats;
    try {
      st = lstatSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
      throw new CausorynConfigError([`the data directory status could not be verified: ${dir} (${code})`]);
    }
    if (st.isSymbolicLink()) {
      throw new CausorynConfigError([`the data directory must not be a symbolic link (CWE-59): ${dir}`]);
    }
    if (!st.isDirectory()) {
      throw new DataDirUnusableError(`the data directory path is not a directory: ${dir}`, `${dir} is not a directory`);
    }
    return st;
  };
  const st = inspect();
  const uid = serverUid();
  if (uid === undefined) return;
  const ownerProblem = (owner: number): string | undefined =>
    owner === uid
      ? undefined
      : `the data directory is owned by uid ${String(owner)}, not the server's uid ${String(uid)} (another local user could read or replace the index): ${dir}`;
  const initialOwner = ownerProblem(st.uid);
  if (initialOwner !== undefined) throw new CausorynConfigError([initialOwner]);
  const mode = st.mode;
  if (access === "user-supplied") {
    if ((mode & GROUP_OR_OTHER_WRITE) === 0) return;
    throw new CausorynConfigError([
      `the data directory is writable by group or others (mode ${permissionText(mode)}; another local user could replace the index). Restrict it with \`chmod go-w ${dir}\` or choose another --data-dir: ${dir}`,
    ]);
  }
  if ((mode & GROUP_OR_OTHER_ANY) === 0) return;
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    throw new CausorynConfigError([
      `the data directory permissions could not be restricted (mode ${permissionText(mode)}, ${code}); refusing a data directory other local users can access: ${dir}`,
    ]);
  }
  const after = inspect();
  const afterOwner = ownerProblem(after.uid);
  if (afterOwner !== undefined) throw new CausorynConfigError([afterOwner]);
  if ((after.mode & GROUP_OR_OTHER_ANY) !== 0) {
    throw new CausorynConfigError([
      `the data directory permissions did not change (mode ${permissionText(after.mode)}; the file system may ignore chmod); refusing a data directory other local users can access: ${dir}`,
    ]);
  }
}

/**
 * Sets a directory this run just created to 0700 (POSIX) and verifies it the
 * same way as the data directories; a chmod failure stops startup.
 */
function makeCreatedDirectoryPrivate(dir: string, created: Stats): void {
  const uid = serverUid();
  if (uid === undefined) return;
  // chmod follows links: the entry is lstat'd first and must still be the
  // directory this run created (not a link, owned by the server's uid, the
  // device and inode recorded right after mkdir) before anything is changed.
  assertSameCreatedDirectory(dir, created, uid);
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    throw new CausorynConfigError([
      `the data directory permissions could not be restricted (${code}); refusing a data directory other local users can access: ${dir}`,
    ]);
  }
  assertSameCreatedDirectory(dir, created, uid);
  assertPrivateDataDirectory(dir, "owner-only");
}

/**
 * lstat of a directory created by this run, right after its mkdir: a real
 * directory, not a link, owned by the server's uid (POSIX). Its device and
 * inode then bind every later chmod to it.
 */
function recordCreatedDirectory(dir: string): Stats {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    throw new CausorynConfigError([`the data directory status could not be verified: ${dir} (${code})`]);
  }
  const uid = serverUid();
  if (st.isSymbolicLink()) {
    throw new CausorynConfigError([`the data directory must not be a symbolic link (CWE-59): ${dir}`]);
  }
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new CausorynConfigError([
      `the data directory changed after it was created (not a directory of the server's user); refusing it: ${dir}`,
    ]);
  }
  return st;
}

/** The path still names the directory recorded after mkdir (lstat: not a link, same owner, device and inode). */
function assertSameCreatedDirectory(dir: string, created: Stats, uid: number): void {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    throw new CausorynConfigError([`the data directory status could not be verified: ${dir} (${code})`]);
  }
  if (st.isSymbolicLink()) {
    throw new CausorynConfigError([`the data directory must not be a symbolic link (CWE-59): ${dir}`]);
  }
  if (!st.isDirectory() || st.uid !== uid || st.dev !== created.dev || st.ino !== created.ino) {
    throw new CausorynConfigError([
      `the data directory changed after it was created (another directory or owner); refusing it: ${dir}`,
    ]);
  }
}

/** The components of `dir` that do not exist yet (what a recursive mkdir creates), shortest first. */
function missingPathPrefixes(dir: string): string[] {
  const missing: string[] = [];
  for (const prefix of enumeratePathPrefixes(dir)) {
    if (missing.length > 0) {
      missing.push(prefix);
      continue;
    }
    try {
      lstatSync(prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") missing.push(prefix);
    }
  }
  return missing;
}

/**
 * Creates `dir` when missing (recursively for the base, whose ancestors may
 * not exist yet) and verifies it with assertPrivateDataDirectory. Every
 * directory created here is chmod'ed to 0700 explicitly (POSIX): mkdir's mode
 * is reduced by the umask and shaped by a default ACL of the parent, and is
 * not relied on, so neither leaves a directory Causoryn made itself open or
 * makes such a startup fatal. A directory that cannot be created or written
 * is DataDirUnusableError (fallback allowed).
 */
function ensurePrivateDataDirectory(
  dir: string,
  access: "user-supplied" | "owner-only",
  options: { readonly recursive: boolean; readonly writable: boolean },
): void {
  const unusable = (error: unknown): DataDirUnusableError => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
    return new DataDirUnusableError(
      `the data directory could not be created or is not writable: ${dir} (${code})`,
      `${code} while creating ${dir}`,
    );
  };
  const created = options.recursive ? missingPathPrefixes(dir) : missingPathPrefixes(dir).slice(-1);
  try {
    mkdirSync(dir, { recursive: options.recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw unusable(error);
  }
  // Identities first, recorded right after mkdir (shortest first), then each is narrowed.
  const recorded = created.map((createdDir) => ({ dir: createdDir, stat: recordCreatedDirectory(createdDir) }));
  for (const entry of recorded) {
    makeCreatedDirectoryPrivate(entry.dir, entry.stat);
  }
  const createdNow = created.some((createdDir) => path.resolve(createdDir) === path.resolve(dir));
  assertPrivateDataDirectory(dir, createdNow ? "owner-only" : access);
  if (!options.writable) return;
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch (error) {
    throw unusable(error);
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
        `a data directory ancestor could not be verified: ${prefix}`,
      ]);
    }

    if (st.isSymbolicLink() && !isMacOsSystemFirmlinkPrefix(prefix)) {
      throw new CausorynConfigError([
        `the data directory or an ancestor must not be a symbolic link (CWE-59): ${prefix}`,
      ]);
    }
    if (!st.isSymbolicLink() && !st.isDirectory()) {
      throw new CausorynConfigError([
        `the data directory or an ancestor path is not a directory: ${prefix}`,
      ]);
    }

    let realPrefix: string;
    try {
      realPrefix = stripWin32DevicePrefix(realpathSync(prefix));
    } catch {
      throw new CausorynConfigError([
        `the real location of a data directory ancestor could not be resolved (dangling symlink / CWE-59): ${prefix}`,
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
          `the automatic data directory must not be inside an authorized workspace root: ${targetDir}`,
        ]);
      }
    }
  }
}

/**
 * Ignore discovery of `root`; a run that stopped at one of its total work
 * budgets (F46 / F49) is reported on stderr, and startup goes on with the
 * patterns accepted before that point.
 */
function discoverIgnoreConfigReported(
  root: string,
  hasExplicitIgnore: boolean,
  logger: ((message: string) => void) | undefined,
): ReturnType<typeof discoverWorkspaceIgnoreConfig> {
  const discovery = discoverWorkspaceIgnoreConfig(root, { hasExplicitIgnore });
  if (discovery.limitReached !== undefined) {
    const log =
      logger ??
      ((message: string): void => {
        console.error(message);
      });
    log(
      discovery.limitReached === "negation-work"
        ? `[causoryn] ignore discovery reached its negation-work budget in ${root}; later ignore entries were kept without the negation check, so files that a "!" rule re-includes may be ignored (the workspace has unusually large ignore files)`
        : `[causoryn] ignore discovery stopped at its ${discovery.limitReached} budget in ${root}; the ignore patterns accepted before that point are used and later nested .gitignore files were not read, so files they ignore may be indexed (the workspace has unusually large ignore files or unusually wide directories)`,
    );
  }
  return discovery;
}

function mergeExtraIgnore(
  baseExtraIgnore: unknown,
  gitignorePatterns: readonly string[],
): unknown {
  if (gitignorePatterns.length === 0) {
    return baseExtraIgnore;
  }
  const existing = Array.isArray(baseExtraIgnore) ? baseExtraIgnore : [];
  const merged: unknown[] = [...existing];
  const seen = new Set<string>(existing.filter((x): x is string => typeof x === "string"));
  for (const pattern of gitignorePatterns) {
    if (!seen.has(pattern)) {
      seen.add(pattern);
      merged.push(pattern);
    }
  }
  return merged;
}

export interface WorkspaceAutoConfigOptions {
  readonly roots: readonly string[];
  readonly autoDataDir: boolean;
  readonly dataDir?: string;
  readonly client?: string;
  readonly rawBaseConfig?: unknown;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** stderr logger for data-dir notices (default `console.error`). */
  readonly logger?: (message: string) => void;
}

/** Shared per-workspace database file used by every MCP host client. */
export const SHARED_WORKSPACE_DB_FILE = "graph.sqlite";

/**
 * Version-specific fallback database file name. Used when the shared
 * `graph.sqlite` was stamped by a NEWER schema than this build supports, so
 * two different schema versions never write the same file.
 */
export function versionedWorkspaceDbFileName(
  schemaVersion: number = STORAGE_SCHEMA_VERSION,
): string {
  return `graph.schema-${String(schemaVersion)}.sqlite`;
}

/**
 * Picks the database file inside an (already validated) workspace data dir:
 * the shared `graph.sqlite`, unless its `user_version` is newer than this
 * build's schema, in which case `graph.schema-<N>.sqlite` (N = this build's
 * schema version) is used and one stderr warning is logged. The probe opens
 * the file read-only and never creates, migrates or writes it.
 */
export function selectWorkspaceDbPath(
  workspaceDataDir: string,
  logger: (message: string) => void = (message) => {
    console.error(message);
  },
): string {
  const shared = path.join(workspaceDataDir, SHARED_WORKSPACE_DB_FILE);
  try {
    const st = lstatSync(shared);
    if (!st.isFile()) {
      // Symlinks / non-files are rejected later by validateDataDbPath.
      return shared;
    }
  } catch {
    return shared;
  }
  let version: number | undefined;
  try {
    version = readSqliteUserVersion(shared);
  } catch {
    // Unreadable/corrupt: keep the shared path; opening it fails loudly later.
    return shared;
  }
  if (version !== undefined && version > STORAGE_SCHEMA_VERSION) {
    const fallback = path.join(workspaceDataDir, versionedWorkspaceDbFileName());
    logger(
      `[causoryn] ${shared} uses schema v${String(version)}, newer than this Causoryn build supports (v${String(STORAGE_SCHEMA_VERSION)}); using ${fallback} instead so different schema versions never write the same file`,
    );
    return fallback;
  }
  return shared;
}

/**
 * One-time migration of legacy per-client databases (`graph-<client>.sqlite`,
 * used up to v0.2.4) into the shared `graph.sqlite` before any connection is
 * opened. Only applies when the configured storage DB is the shared file and
 * it does not exist yet. Never throws: failures are logged and startup
 * continues with a fresh shared database. Legacy files are left in place.
 */
export async function prepareWorkspaceDatabase(
  config: CausorynServerConfig,
  options: { readonly logger?: (message: string) => void } = {},
): Promise<void> {
  const log =
    options.logger ??
    ((message: string): void => {
      console.error(message);
    });
  const dbPath = config.storage.dataDbPath;
  if (dbPath === undefined || path.basename(dbPath) !== SHARED_WORKSPACE_DB_FILE) {
    return;
  }
  try {
    const result = await migrateLegacyWorkspaceDatabase(dbPath);
    if (result.migrated) {
      log(
        `[causoryn] migrated legacy database ${path.basename(result.source)} (schema v${String(result.sourceSchemaVersion)}) into ${result.target}; legacy files were left in place`,
      );
    } else if (result.reason === "no-valid-legacy-file") {
      const rejected = result.candidates
        .map((candidate) => `${path.basename(candidate.path)}: ${candidate.reason ?? "invalid"}`)
        .join("; ");
      log(
        `[causoryn] legacy per-client databases found but none could be migrated (${rejected}); starting with a fresh ${SHARED_WORKSPACE_DB_FILE}`,
      );
    }
  } catch (error) {
    log(
      `[causoryn] legacy database migration failed: ${error instanceof Error ? error.message : String(error)}; starting with a fresh ${SHARED_WORKSPACE_DB_FILE}`,
    );
  }
}

interface PreparedWorkspaceDataDir {
  readonly exportsDir: string;
  readonly dbPath: string;
}

/**
 * Validates and creates `<baseDataDir>/workspaces/<workspaceDirName>` and its
 * `exports/` directory, then picks the database file. Every path is checked
 * to lie outside the authorized roots and to contain no symlinked component
 * BEFORE anything is created (ADR-008 + CWE-59), and re-checked by real path
 * afterwards (TOCTOU). A base that cannot be created or written throws
 * `DataDirUnusableError`; security violations throw `CausorynConfigError`.
 */
function prepareWorkspaceDataDir(
  baseDataDir: string,
  workspaceDirName: string,
  effectiveRoots: readonly string[],
  canonicalRoots: readonly string[],
  logger: ((message: string) => void) | undefined,
): PreparedWorkspaceDataDir {
  const workspacesDir = path.join(baseDataDir, "workspaces");
  const workspaceDataDir = path.join(workspacesDir, workspaceDirName);
  const exportsDir = path.join(workspaceDataDir, "exports");
  // Single shared workspace SQLite database across all MCP host clients;
  // the host client id is preserved strictly as a diagnostic/host label.
  const sharedDbPath = path.join(workspaceDataDir, SHARED_WORKSPACE_DB_FILE);

  // Yazmadan ÖNCE hem sözcüksel hem gerçek-ata yollarının workspace dışında
  // kaldığını ve hiçbir önek/ata dizinin sembolik/dangling bağ olmadığını
  // doğrula (ADR-008 + CWE-59: kaynak ağaca tek klasör bile açılamaz).
  assertStrictlyOutsideWorkspaceRoots(
    [baseDataDir, workspacesDir, workspaceDataDir, exportsDir, sharedDbPath],
    effectiveRoots,
    canonicalRoots,
  );
  assertNotSymlinkDirectory(baseDataDir);
  assertNotSymlinkDirectory(workspacesDir);
  assertNotSymlinkDirectory(workspaceDataDir);
  assertNotSymlinkDirectory(exportsDir);
  assertDataDirAncestorsSafe(exportsDir, effectiveRoots, canonicalRoots);

  // F41: created (or reused) top down, each one verified before anything is
  // created inside it: not a link and, on POSIX, owned by the server's uid
  // with no group/other write (the workspace directories owner-only).
  ensurePrivateDataDirectory(baseDataDir, "user-supplied", { recursive: true, writable: false });
  ensurePrivateDataDirectory(workspacesDir, "owner-only", { recursive: false, writable: false });
  ensurePrivateDataDirectory(workspaceDataDir, "owner-only", { recursive: false, writable: true });
  ensurePrivateDataDirectory(exportsDir, "owner-only", { recursive: false, writable: true });

  // Oluşturma sonrası realpath doğrulaması (TOCTOU savunması).
  const realWorkspaceDataDir = stripWin32DevicePrefix(realpathSync(workspaceDataDir));
  const realExportsDir = stripWin32DevicePrefix(realpathSync(exportsDir));
  assertStrictlyOutsideWorkspaceRoots(
    [realWorkspaceDataDir, realExportsDir],
    effectiveRoots,
    canonicalRoots,
  );

  // Schema forward guard (Task 1.7 criterion 4): never share a file with a
  // newer schema version; fall back to graph.schema-<N>.sqlite instead.
  const dbPath = selectWorkspaceDbPath(workspaceDataDir, logger);
  return { exportsDir, dbPath };
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

  const hasExplicitIgnore =
    Object.hasOwn(rawBase, "ignore") && rawBase["ignore"] !== undefined;
  const baseExtraIgnore = Object.hasOwn(rawBase, "extraIgnore")
    ? rawBase["extraIgnore"]
    : undefined;

  const baseAllowRoots =
    Object.hasOwn(rawBase, "allowRoots") && Array.isArray(rawBase["allowRoots"])
      ? (rawBase["allowRoots"] as unknown[])
      : [];
  const rawRoots: string[] =
    options.roots.length > 0
      ? [...options.roots]
      : baseAllowRoots.map((entry) => String(entry));
  for (const rawRoot of rawRoots) {
    if (isUncOrDevicePath(rawRoot) || isUncOrDevicePath(rawRoot.trim())) {
      throw new CausorynConfigError([
        `allowRoot must not be a UNC or Win32 device path: ${rawRoot}`,
      ]);
    }
  }
  const effectiveRoots: string[] =
    options.roots.length > 0
      ? options.roots.map((r) => path.resolve(r))
      : rawRoots;
  for (const resolvedRoot of effectiveRoots) {
    if (isUncOrDevicePath(resolvedRoot)) {
      throw new CausorynConfigError([
        `allowRoot must not be a UNC or Win32 device path: ${resolvedRoot}`,
      ]);
    }
  }

  if (!options.autoDataDir || effectiveRoots.length === 0) {
    const firstRoot = effectiveRoots[0];
    const canDiscoverPrimary =
      firstRoot !== undefined &&
      typeof firstRoot === "string" &&
      !isUncOrDevicePath(firstRoot) &&
      path.isAbsolute(firstRoot) &&
      !firstRoot.includes("\0");
    const discovery = canDiscoverPrimary
      ? discoverIgnoreConfigReported(firstRoot, hasExplicitIgnore, options.logger)
      : undefined;
    const extraIgnore = mergeExtraIgnore(baseExtraIgnore, discovery?.extraIgnore ?? []);
    return parseCausorynServerConfig({
      ...rawBase,
      allowRoots: effectiveRoots,
      ...(!hasExplicitIgnore && discovery?.refinedDefaultIgnore !== undefined
        ? { ignore: [...discovery.refinedDefaultIgnore] }
        : {}),
      ...(extraIgnore !== undefined ? { extraIgnore } : {}),
    });
  }

  if (options.client !== undefined && !SAFE_CLIENT_ID_PATTERN.test(options.client)) {
    throw new CausorynConfigError([
      `invalid client id: ${options.client}`,
    ]);
  }

  const canonicalRoots: string[] = effectiveRoots.map((root) => {
    if (isUncOrDevicePath(root) || !path.isAbsolute(root) || root.includes("\0")) {
      throw new CausorynConfigError([`allowRoot is invalid or not an absolute path: ${root}`]);
    }
    try {
      const resolved = stripWin32DevicePrefix(realpathSync(path.resolve(root)));
      if (!statSync(resolved).isDirectory()) {
        throw new CausorynConfigError([`allowRoot is not a directory: ${root}`]);
      }
      return resolved;
    } catch (error) {
      if (error instanceof CausorynConfigError) throw error;
      throw new CausorynConfigError([
        `allowRoot real path could not be resolved: ${root}`,
      ]);
    }
  });

  const candidates = resolveDataDirCandidates({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  const primaryRoot = canonicalRoots[0] as string;
  const slug = deriveWorkspaceSlug(primaryRoot);
  const hash12 = sha256Hex(utf8Encode(normalizeComparablePath(primaryRoot))).slice(0, 12);
  const workspaceDirName = `${slug}-${hash12}`;

  let prepared: PreparedWorkspaceDataDir;
  try {
    prepared = prepareWorkspaceDataDir(
      candidates.primary.dir,
      workspaceDirName,
      effectiveRoots,
      canonicalRoots,
      options.logger,
    );
  } catch (error) {
    const fallback = candidates.fallback;
    if (fallback === undefined || !(error instanceof DataDirUnusableError)) {
      throw error;
    }
    const log =
      options.logger ??
      ((message: string): void => {
        console.error(message);
      });
    log(
      `[causoryn] ${candidates.primary.dir} cannot hold the index (${error.reason}); using ${fallback.source} (${fallback.dir}) instead. This index is not shared with hosts that use ${candidates.primary.dir}; fix that directory, or pass --data-dir to choose the location explicitly.`,
    );
    prepared = prepareWorkspaceDataDir(
      fallback.dir,
      workspaceDirName,
      effectiveRoots,
      canonicalRoots,
      options.logger,
    );
  }
  const { exportsDir, dbPath } = prepared;

  const baseStorage = isPlainObject(rawBase["storage"]) ? rawBase["storage"] : {};
  const baseWiki = isPlainObject(rawBase["wiki"]) ? rawBase["wiki"] : {};
  const baseOutput = isPlainObject(rawBase["output"]) ? rawBase["output"] : {};
  const discovery = discoverIgnoreConfigReported(primaryRoot, hasExplicitIgnore, options.logger);
  const extraIgnore = mergeExtraIgnore(baseExtraIgnore, discovery.extraIgnore);

  const mergedConfig: Record<string, unknown> = {
    ...rawBase,
    allowRoots: effectiveRoots,
    ...(!hasExplicitIgnore && discovery.refinedDefaultIgnore !== undefined
      ? { ignore: [...discovery.refinedDefaultIgnore] }
      : {}),
    ...(extraIgnore !== undefined ? { extraIgnore } : {}),
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
  /**
   * Runs one unit of work (a tool call) pinned to the context generation that
   * is active when it starts. Every getter read inside `work` — including
   * after awaits — resolves to that generation, and a `rebind` during `work`
   * defers closing it until `work` settles.
   */
  runPinned<T>(work: () => Promise<T> | T): Promise<T>;
}

/** One bound context plus the number of pinned calls still using it. */
interface ContextGeneration {
  readonly context: CausorynContext;
  inFlight: number;
  /** No longer the active binding (rebound away or the wrapper was closed). */
  retired: boolean;
  closed: boolean;
}

/**
 * Getter-based dynamic `CausorynContext` wrapper used by the MCP roots binder.
 *
 * `rebind` atomically switches the binding that NEW work sees. Work started
 * through `runPinned` keeps its generation for its whole lifetime (resolved
 * through AsyncLocalStorage, so awaits inside a tool call cannot observe a
 * rebind), and a retired generation is closed only after its last pinned
 * call settles — an in-flight call never finishes against another workspace
 * or a closed SQLite connection. Reads outside `runPinned` use the current
 * binding.
 */
export function createDynamicCausorynContext(
  initialContext: CausorynContext,
): DynamicCausorynContext {
  const pinnedGeneration = new AsyncLocalStorage<ContextGeneration>();
  let activeGeneration: ContextGeneration = {
    context: initialContext,
    inFlight: 0,
    retired: false,
    closed: false,
  };
  const target = (): CausorynContext =>
    (pinnedGeneration.getStore() ?? activeGeneration).context;
  const closeGeneration = (generation: ContextGeneration): void => {
    if (generation.closed) return;
    generation.closed = true;
    try {
      generation.context.close();
    } catch (error) {
      activeGeneration.context.logger(
        `[causoryn] could not close the previous context: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const retire = (generation: ContextGeneration): void => {
    generation.retired = true;
    if (generation.inFlight === 0) closeGeneration(generation);
  };
  return {
    get current(): CausorynContext {
      return activeGeneration.context;
    },
    get config(): CausorynServerConfig {
      return target().config;
    },
    get policy(): WorkspaceAccessPolicy {
      return target().policy;
    },
    get repository(): GraphRepository {
      return target().repository;
    },
    get symbolSearch(): SymbolSearchStore | null {
      return target().symbolSearch;
    },
    get indexService(): IndexService {
      return target().indexService;
    },
    get jobManager(): IndexJobManager {
      return target().jobManager;
    },
    get outputPolicy(): OutputAccessPolicy | null {
      return target().outputPolicy;
    },
    get wikiStore(): SqliteWikiStore | null {
      return target().wikiStore;
    },
    get wikiSearch(): WikiSearchStore | null {
      return target().wikiSearch;
    },
    get preflightStore(): PreflightManifestStore {
      return target().preflightStore;
    },
    get clock(): () => string {
      return target().clock;
    },
    get logger(): (message: string) => void {
      return target().logger;
    },
    startDeferredIndex(): void {
      target().startDeferredIndex?.();
    },
    waitForInitialIndex(timeoutOrOptions?: number | WaitForInitialIndexOptions): Promise<void> {
      const context = target();
      return context.waitForInitialIndex
        ? context.waitForInitialIndex(timeoutOrOptions)
        : Promise.resolve();
    },
    getActiveIndexJob(): ActiveIndexJobInfo | null {
      const context = target();
      return context.getActiveIndexJob ? context.getActiveIndexJob() : null;
    },
    close(): void {
      // Shutdown: the active generation closes now, or after its in-flight
      // calls settle. Idempotent (a generation is closed at most once).
      retire(activeGeneration);
    },
    rebind(nextContext: CausorynContext): void {
      if (nextContext === activeGeneration.context) return;
      const previous = activeGeneration;
      activeGeneration = { context: nextContext, inFlight: 0, retired: false, closed: false };
      retire(previous);
    },
    async runPinned<T>(work: () => Promise<T> | T): Promise<T> {
      // Nested calls stay on the generation that is already pinned.
      if (pinnedGeneration.getStore() !== undefined) return await work();
      const generation = activeGeneration;
      generation.inFlight += 1;
      try {
        return await pinnedGeneration.run(generation, work);
      } finally {
        generation.inFlight -= 1;
        if (generation.retired && generation.inFlight === 0) closeGeneration(generation);
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
  readonly beforeToolCall: (
    toolName: string,
    hookContext?: BeforeToolCallContext,
  ) => Promise<void>;
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

  const buildRootConfig = (canonicalRoot: string | null): CausorynServerConfig =>
    buildWorkspaceAutoConfig({
      roots: canonicalRoot === null ? [] : [canonicalRoot],
      autoDataDir: options.autoDataDir ?? false,
      ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      ...(options.client !== undefined ? { client: options.client } : {}),
      ...(options.rawBaseConfig !== undefined ? { rawBaseConfig: options.rawBaseConfig } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      logger: log,
    });
  const bindConfig = (nextConfig: CausorynServerConfig): void => {
    const nextContext = createCausorynContext(nextConfig, {
      deferAutoIndex: true,
      ...(options.client === undefined ? {} : { hostLabel: options.client }),
      ...effectiveContextOverrides,
    });
    dynamicContext.rebind(nextContext);
  };
  const rebindRoot = (canonicalRoot: string | null): void => {
    bindConfig(buildRootConfig(canonicalRoot));
  };
  /** Async rebind: migrates legacy per-client DBs before opening the shared DB. */
  const rebindRootAsync = async (canonicalRoot: string | null): Promise<void> => {
    const nextConfig = buildRootConfig(canonicalRoot);
    await prepareWorkspaceDatabase(nextConfig, { logger: log });
    bindConfig(nextConfig);
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
      const clientTag = options.client !== undefined ? `, client=${options.client}` : "";
      log(
        `[causoryn] bound safe workspace via --allow-cwd: ${cwdCheck.canonicalRoot} (workspaceId=${dynamicContext.config.workspaceId}${clientTag})`,
      );
    } else {
      log(
        `[causoryn] --allow-cwd rejected (${cwdCheck.reason}); starting with allowRoots: [] and waiting for MCP roots/list`,
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
        `[causoryn] could not fetch MCP roots/list: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }

    let selectedRoot: string | null = null;
    for (const entry of listedRoots) {
      const localPath = fileUriToLocalPath(entry.uri);
      if (localPath === null) continue;
      const safety = inspectProjectRootSafety(localPath, safetyOptions);
      if (!safety.safe) {
        log(`[causoryn] skipped MCP root candidate (${safety.reason}): ${entry.uri}`);
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
          log("[causoryn] MCP roots/list contains no safe root; reverted to allowRoots: []");
        } catch (error) {
          log(
            `[causoryn] reverting to an empty binding failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return true;
    }

    if (currentBoundRoot !== null && isSameComparablePath(currentBoundRoot, selectedRoot)) {
      return true;
    }

    try {
      await rebindRootAsync(selectedRoot);
      currentBoundRoot = selectedRoot;
      const clientTag = options.client !== undefined ? `, client=${options.client}` : "";
      log(
        `[causoryn] bound workspace via MCP roots/list: ${selectedRoot} (workspaceId=${dynamicContext.config.workspaceId}${clientTag})`,
      );
    } catch (error) {
      log(
        `[causoryn] could not bind the MCP roots/list workspace (${selectedRoot}): ${error instanceof Error ? error.message : String(error)}`,
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

  const NON_BLOCKING_BOOT_TOOLS: ReadonlySet<string> = new Set([
    "causoryn_status",
    "causoryn_get_capabilities",
    "causoryn_index_status",
    "causoryn_refresh_index",
  ]);

  return {
    beforeToolCall: async (
      toolName: string,
      hookContext?: BeforeToolCallContext,
    ): Promise<void> => {
      await syncFromClientRoots(false);
      if (toolName === "causoryn_status" || toolName === "causoryn_index_status") {
        dynamicContext.startDeferredIndex?.();
        return;
      }
      if (!NON_BLOCKING_BOOT_TOOLS.has(toolName)) {
        const timeoutMs = resolveIndexWaitTimeoutMs(options.env ?? process.env);
        await dynamicContext.waitForInitialIndex?.({
          timeoutMs,
          ...(hookContext?.signal === undefined ? {} : { signal: hookContext.signal }),
          ...(hookContext?.progressToken === undefined
            ? {}
            : {
                onProgress: (update) =>
                  hookContext.sendProgress({
                    progress: update.progress,
                    total: update.total,
                    message: update.message,
                  }),
              }),
        });
      }
    },
    syncFromClientRoots,
  };
}
