import ts from "typescript";

import { utf8Encode } from "@causoryn/domain";

import type { TsAdapterSourceFile } from "./types.js";

/**
 * Salt-okunur, güvenli `tsconfig.json` / `jsconfig.json` yükleyicisi (v0.2.3).
 *
 * Güvenlik sözleşmesi (ADR-008, CWE-59, CWE-22, prototype-pollution, DoS koruması):
 * - Birincil kaynak: `input.configFiles` (WorkspaceAccessPolicy'den geçmiş,
 *   bellek-içi, %100 deterministik).
 * - Disk fallback (yalnızca `configFiles === undefined` ve `rootDirOnDisk`
 *   verildiğinde): `lstatSync` ile yol zincirindeki tüm symlink'ler ve
 *   `.git`/`.env*` segmentleri reddedilir, yalnızca `.json` dosyaları kabul
 *   edilir, `realpathSync` ile `rootDirOnDisk` sarmalaması doğrulanır,
 *   `openSync(O_RDONLY | O_NOFOLLOW)` + `fstatSync` (`dev`/`ino` + boyut) +
 *   sınırlı `readSync` (≤ 256 KB + 1) ile TOCTOU-güvenli okunur; hiçbir dosya
 *   yazılmaz.
 * - Ayrıştırma yalnızca resmi `ts.parseConfigFileTextToJson` ile yapılır
 *   (JSONC yorumları ve trailing comma destekli; eval / plugin çalıştırma YOK).
 * - Yalnızca güvenli compilerOptions alanları çıkarılır (`baseUrl`, `paths`,
 *   `jsx`, `moduleResolution`, `module`, `target`, `experimentalDecorators`,
 *   `verbatimModuleSyntax`). `__proto__`, `constructor`, `prototype` anahtarları
 *   reddedilir; `paths` Map + null-prototype nesnede tutulur (en fazla 200 girdi).
 * - `extends` zinciri kesinlikle `rootDir` içinde tutulur: dosya başına en fazla
 *   16 `extends`, derinlik ≤ 5, döngü tespiti, parsed + resolved memoization,
 *   global 128 ziyaret bütçesi (elmas DAG DoS koruması) ve 100 uyarı tavanı.
 */

export const MAX_TSCONFIG_BYTES = 256 * 1024;
export const MAX_EXTENDS_DEPTH = 5;
export const MAX_EXTENDS_ENTRIES = 16;
export const MAX_TOTAL_RESOLVE_VISITS = 128;
export const MAX_TSCONFIG_WARNINGS = 100;
export const MAX_SCOPED_CONFIGS = 64;
export const MAX_PATHS_ENTRIES = 200;
export const MAX_WORKSPACE_SCAN_DEPTH = 4;
export const MAX_WORKSPACE_MANIFESTS = 256;
export const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_PATH_TARGETS_PER_PATTERN = 16;
const MAX_DISK_SCAN_DIRS = 64;
const MAX_WORKSPACE_DIR_VISITS = 512;
/** Upper bound on distinct root `package.json` workspaces include (and exclude) patterns. */
export const MAX_WORKSPACE_PATTERNS = 256;
/** Upper bound on distinct directory listings of one workspace manifest discovery run. */
export const MAX_WORKSPACE_DIR_LISTINGS = 2048;
/**
 * Upper bound on in-memory alias targets probed for one module specifier (each
 * target checks at most 19 candidate paths). TypeScript itself only tries the
 * targets of the single best-matching `paths` pattern (at most 16).
 */
export const MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER = 64;
/** Upper bound on in-memory alias targets probed in one analysis run. */
export const MAX_VIRTUAL_ALIAS_PROBES_PER_RUN = 50_000;
/** Longer specifiers cannot name a file on any supported platform and are never probed. */
const MAX_VIRTUAL_ALIAS_SPECIFIER_CHARS = 4096;
const MAX_EXPORTS_RECURSION_DEPTH = 6;
const MAX_EXPORTS_CANDIDATES = 16;

const WORKSPACE_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "obj",
  "bin",
]);

const WORKSPACE_OUTPUT_PREFIXES: readonly string[] = [
  "dist/",
  "build/",
  "lib/",
  "out/",
  "esm/",
  "cjs/",
];

const PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;

const EXPORT_CONDITION_PRIORITY: readonly string[] = [
  "source",
  "typescript",
  "import",
  "default",
  "types",
  "require",
  "node",
  "browser",
];

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Tek dizin kapsamındaki ayrıştırılmış ve doğrulanmış TS/JS yapılandırması. */
export interface ScopedTsConfig {
  /** Workspace-relative POSIX dizin öneki ("" kök dizin, "frontend" alt proje). */
  readonly dirPrefix: string;
  /** Yapılandırma dosyasının workspace-relative POSIX yolu. */
  readonly configRelativePath: string;
  /** `rootPosix` altında kalması doğrulanmış normalize mutlak POSIX baseUrl. */
  readonly baseUrl?: string;
  /** Prototype-pollution korumalı path alias haritası (en fazla 200 girdi). */
  readonly paths?: ReadonlyMap<string, readonly string[]>;
  /** `baseUrl` yokken `paths` çözümleme taban dizini (mutlak POSIX, `rootPosix` içinde). */
  readonly pathsBasePath?: string;
  readonly jsx?: ts.JsxEmit;
  readonly moduleResolution?: ts.ModuleResolutionKind;
  readonly module?: ts.ModuleKind;
  readonly target?: ts.ScriptTarget;
  readonly experimentalDecorators?: boolean;
  readonly verbatimModuleSyntax?: boolean;
}

/** `loadWorkspaceTsConfigs` çıktısı: deterministik sıralı config listesi + uyarılar. */
export interface LoadedTsConfigs {
  readonly configs: readonly ScopedTsConfig[];
  readonly warnings: readonly string[];
}

interface RawConfigEntry {
  readonly relativePath: string;
  readonly content: string;
}

interface PartialSafeOptions {
  baseUrl?: string;
  paths?: Map<string, readonly string[]>;
  pathsBasePath?: string;
  jsx?: ts.JsxEmit;
  moduleResolution?: ts.ModuleResolutionKind;
  module?: ts.ModuleKind;
  target?: ts.ScriptTarget;
  experimentalDecorators?: boolean;
  verbatimModuleSyntax?: boolean;
}

interface NodeFsStatMinimal {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
}

interface NodeFsMinimal {
  readonly constants?: {
    readonly O_RDONLY?: number;
    readonly O_NOFOLLOW?: number;
  };
  lstatSync(path: string): NodeFsStatMinimal;
  realpathSync(path: string): string;
  readdirSync?(path: string): string[];
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): NodeFsStatMinimal;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  closeSync(fd: number): void;
}

interface TextDecoderMinimal {
  decode(input?: Uint8Array): string;
}

function getNodeFs(): NodeFsMinimal | undefined {
  const proc = (
    globalThis as {
      readonly process?: {
        readonly getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process;
  const mod = proc?.getBuiltinModule?.("node:fs");
  if (
    typeof mod === "object" &&
    mod !== null &&
    typeof (mod as Partial<NodeFsMinimal>).lstatSync === "function" &&
    typeof (mod as Partial<NodeFsMinimal>).realpathSync === "function" &&
    typeof (mod as Partial<NodeFsMinimal>).openSync === "function" &&
    typeof (mod as Partial<NodeFsMinimal>).fstatSync === "function" &&
    typeof (mod as Partial<NodeFsMinimal>).readSync === "function" &&
    typeof (mod as Partial<NodeFsMinimal>).closeSync === "function"
  ) {
    return mod as NodeFsMinimal;
  }
  return undefined;
}

function decodeUtf8(bytes: Uint8Array): string {
  const DecoderCtor = (
    globalThis as {
      readonly TextDecoder?: new (label?: string) => TextDecoderMinimal;
    }
  ).TextDecoder;
  if (typeof DecoderCtor === "function") {
    return new DecoderCtor("utf-8").decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripWindowsExtendedPrefix(raw: string): string {
  if (raw.startsWith("\\\\?\\UNC\\") || raw.startsWith("//?/UNC/")) {
    return `//${raw.slice(8)}`;
  }
  if (raw.startsWith("\\\\?\\") || raw.startsWith("//?/")) {
    return raw.slice(4);
  }
  return raw;
}

function normalizePosixAbsolute(p: string): string {
  const posix = toPosix(stripWindowsExtendedPrefix(p));
  const drivePrefix = /^[a-zA-Z]:/.test(posix) ? posix.slice(0, 2) : undefined;
  const body = drivePrefix === undefined ? posix : posix.slice(2);
  const isAbsolute = body.startsWith("/");
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== "..") {
        segments.pop();
        continue;
      }
      if (!isAbsolute) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drivePrefix !== undefined) return `${drivePrefix}/${joined}`;
  return isAbsolute ? `/${joined}` : joined;
}

function stripNonRootTrailingSlash(normalized: string): string {
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === normalized.length ? normalized : normalized.slice(0, end);
}

function canonicalKey(p: string): string {
  const normalized = stripNonRootTrailingSlash(normalizePosixAbsolute(p));
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function canonicalRelKey(relativePath: string): string {
  return ts.sys.useCaseSensitiveFileNames
    ? relativePath
    : relativePath.toLowerCase();
}

function validateRelativeConfigPath(raw: string): string | undefined {
  if (raw.includes("\0")) return undefined;
  const posix = toPosix(raw);
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) return undefined;
  const segments = posix.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return undefined;
    }
  }
  return posix;
}

function hasForbiddenDiskSegment(relativePath: string): boolean {
  for (const segment of relativePath.split("/")) {
    const lower = segment.toLowerCase();
    if (lower === ".git" || lower.startsWith(".env")) {
      return true;
    }
  }
  return false;
}

function relativeDirPrefix(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx < 0 ? "" : relativePath.slice(0, idx);
}

function relativeBasename(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx < 0 ? relativePath : relativePath.slice(idx + 1);
}

function isActiveProjectConfigFile(relativePath: string): boolean {
  const base = relativeBasename(relativePath).toLowerCase();
  return base === "tsconfig.json" || base === "jsconfig.json";
}

function joinPosixAbs(rootPosix: string, relativePath: string): string {
  const cleanRoot = stripNonRootTrailingSlash(normalizePosixAbsolute(rootPosix));
  if (relativePath === "") return cleanRoot;
  return cleanRoot.endsWith("/")
    ? `${cleanRoot}${relativePath}`
    : `${cleanRoot}/${relativePath}`;
}

function resolveRelativeWithinRoot(
  fromDirPrefix: string,
  spec: string,
): { readonly ok: true; readonly relativePath: string } | { readonly ok: false } {
  if (spec.includes("\0")) return { ok: false };
  const posix = toPosix(spec);
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) {
    return { ok: false };
  }
  const segments =
    fromDirPrefix === ""
      ? []
      : fromDirPrefix.split("/").filter((s) => s !== "" && s !== ".");
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return { ok: false };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { ok: true, relativePath: segments.join("/") };
}

function isRelativeExtendsSpec(spec: string): boolean {
  const posix = toPosix(spec);
  return (
    posix === "." ||
    posix === ".." ||
    posix.startsWith("./") ||
    posix.startsWith("../")
  );
}

function isAbsoluteOrUnsafeExtendsSpec(spec: string): boolean {
  if (spec.includes("\0")) return true;
  const posix = toPosix(spec);
  return posix.startsWith("/") || /^[a-zA-Z]:/.test(posix);
}

function parseJsxOption(value: unknown): ts.JsxEmit | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "preserve":
      return ts.JsxEmit.Preserve;
    case "react":
      return ts.JsxEmit.React;
    case "react-native":
      return ts.JsxEmit.ReactNative;
    case "react-jsx":
      return ts.JsxEmit.ReactJSX;
    case "react-jsxdev":
      return ts.JsxEmit.ReactJSXDev;
    default:
      return undefined;
  }
}

function parseModuleResolutionOption(
  value: unknown,
): ts.ModuleResolutionKind | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "bundler":
      return ts.ModuleResolutionKind.Bundler;
    case "nodenext":
      return ts.ModuleResolutionKind.NodeNext;
    case "node16":
      return ts.ModuleResolutionKind.Node16;
    case "node":
    case "node10":
      return ts.ModuleResolutionKind.Node10;
    case "classic":
      return ts.ModuleResolutionKind.Classic;
    default:
      return undefined;
  }
}

function parseModuleOption(value: unknown): ts.ModuleKind | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "esnext":
      return ts.ModuleKind.ESNext;
    case "es2022":
      return ts.ModuleKind.ES2022;
    case "es2020":
      return ts.ModuleKind.ES2020;
    case "es2015":
    case "es6":
      return ts.ModuleKind.ES2015;
    case "nodenext":
      return ts.ModuleKind.NodeNext;
    case "node16":
      return ts.ModuleKind.Node16;
    case "commonjs":
      return ts.ModuleKind.CommonJS;
    case "preserve":
      return ts.ModuleKind.Preserve;
    default:
      return undefined;
  }
}

function parseTargetOption(value: unknown): ts.ScriptTarget | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "esnext":
      return ts.ScriptTarget.ESNext;
    case "es2024":
      return ts.ScriptTarget.ES2024;
    case "es2023":
      return ts.ScriptTarget.ES2023;
    case "es2022":
      return ts.ScriptTarget.ES2022;
    case "es2021":
      return ts.ScriptTarget.ES2021;
    case "es2020":
      return ts.ScriptTarget.ES2020;
    case "es2019":
      return ts.ScriptTarget.ES2019;
    case "es2018":
      return ts.ScriptTarget.ES2018;
    case "es2017":
      return ts.ScriptTarget.ES2017;
    case "es2016":
      return ts.ScriptTarget.ES2016;
    case "es2015":
    case "es6":
      return ts.ScriptTarget.ES2015;
    case "es5":
      return ts.ScriptTarget.ES5;
    default:
      return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownProperty(
  record: Record<string, unknown>,
  key: string,
): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function checkPrototypeInjection(
  obj: object,
  contextLabel: string,
  addWarning: (msg: string) => void,
): void {
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    addWarning(
      `unsafe __proto__ key detected in tsconfig and ignored: ${contextLabel}`,
    );
  }
}

function extractSafeCompilerOptions(
  configRelativePath: string,
  dirPrefix: string,
  rootPosix: string,
  rawCompilerOptions: unknown,
  addWarning: (msg: string) => void,
): PartialSafeOptions {
  if (!isPlainRecord(rawCompilerOptions)) return {};
  checkPrototypeInjection(rawCompilerOptions, `${configRelativePath} compilerOptions`, addWarning);

  const out: PartialSafeOptions = {};

  const rawBaseUrl = ownProperty(rawCompilerOptions, "baseUrl");
  if (typeof rawBaseUrl === "string" && rawBaseUrl.trim().length > 0) {
    const resolvedBase = resolveRelativeWithinRoot(dirPrefix, rawBaseUrl.trim());
    if (resolvedBase.ok) {
      out.baseUrl = joinPosixAbs(rootPosix, resolvedBase.relativePath);
    } else {
      addWarning(
        `rejected tsconfig baseUrl that escapes the root: ${configRelativePath} -> ${rawBaseUrl}`,
      );
    }
  }

  const rawPaths = ownProperty(rawCompilerOptions, "paths");
  if (isPlainRecord(rawPaths)) {
    checkPrototypeInjection(rawPaths, `${configRelativePath} paths`, addWarning);
    const pathsMap = new Map<string, readonly string[]>();
    let cappedWarned = false;
    for (const key of Object.getOwnPropertyNames(rawPaths)) {
      if (FORBIDDEN_KEYS.has(key)) {
        addWarning(
          `rejected unsafe '${key}' key in tsconfig paths: ${configRelativePath}`,
        );
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(rawPaths, key)) continue;
      if (key.length === 0 || key.includes("\0")) continue;
      if (key.indexOf("*") !== key.lastIndexOf("*")) continue;
      if (pathsMap.size >= MAX_PATHS_ENTRIES) {
        if (!cappedWarned) {
          cappedWarned = true;
          addWarning(
            `tsconfig paths entry limit (${String(MAX_PATHS_ENTRIES)}) exceeded; remaining entries were dropped: ${configRelativePath}`,
          );
        }
        break;
      }
      const rawTargets = rawPaths[key];
      if (!Array.isArray(rawTargets)) continue;
      const targets: string[] = [];
      for (const item of rawTargets) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (trimmed.length === 0 || trimmed.includes("\0")) continue;
        targets.push(trimmed);
        if (targets.length >= MAX_PATH_TARGETS_PER_PATTERN) break;
      }
      if (targets.length > 0) {
        pathsMap.set(key, targets);
      }
    }
    if (pathsMap.size > 0) {
      out.paths = pathsMap;
      out.pathsBasePath = joinPosixAbs(rootPosix, dirPrefix);
    }
  }

  const jsx = parseJsxOption(ownProperty(rawCompilerOptions, "jsx"));
  if (jsx !== undefined) out.jsx = jsx;

  const moduleResolution = parseModuleResolutionOption(
    ownProperty(rawCompilerOptions, "moduleResolution"),
  );
  if (moduleResolution !== undefined) out.moduleResolution = moduleResolution;

  const moduleKind = parseModuleOption(ownProperty(rawCompilerOptions, "module"));
  if (moduleKind !== undefined) out.module = moduleKind;

  const target = parseTargetOption(ownProperty(rawCompilerOptions, "target"));
  if (target !== undefined) out.target = target;

  const experimentalDecorators = ownProperty(
    rawCompilerOptions,
    "experimentalDecorators",
  );
  if (typeof experimentalDecorators === "boolean") {
    out.experimentalDecorators = experimentalDecorators;
  }

  const verbatimModuleSyntax = ownProperty(
    rawCompilerOptions,
    "verbatimModuleSyntax",
  );
  if (typeof verbatimModuleSyntax === "boolean") {
    out.verbatimModuleSyntax = verbatimModuleSyntax;
  }

  return out;
}

function isSafePathTargetWithinRoot(
  effectiveBaseRel: string,
  target: string,
): boolean {
  if (target.length === 0 || target.includes("\0")) return false;
  // En fazla tek '*' joker karakterine izin verilir.
  const firstStar = target.indexOf("*");
  if (firstStar !== target.lastIndexOf("*")) return false;
  // '*' sonrasındaki sonekte '..' segmenti boş/kısa joker ile kök kaçışına yol açar (SEC-03).
  if (firstStar >= 0) {
    const suffix = toPosix(target.slice(firstStar + 1));
    if (suffix.split("/").includes("..")) return false;
  }
  const emptyProbe = resolveRelativeWithinRoot(
    effectiveBaseRel,
    target.replace(/\*/g, ""),
  );
  if (!emptyProbe.ok) return false;
  const filledProbe = resolveRelativeWithinRoot(
    effectiveBaseRel,
    target.replace(/\*/g, "__wildcard__"),
  );
  return filledProbe.ok;
}

function sanitizePathsWithinRoot(
  configRelativePath: string,
  rootPosix: string,
  options: PartialSafeOptions,
  addWarning: (msg: string) => void,
): PartialSafeOptions {
  if (options.paths === undefined) return options;
  const cleanRoot = stripNonRootTrailingSlash(normalizePosixAbsolute(rootPosix));
  const rootPrefixWithSlash = cleanRoot.endsWith("/") ? cleanRoot : `${cleanRoot}/`;
  const effectiveBaseAbs = stripNonRootTrailingSlash(
    normalizePosixAbsolute(options.baseUrl ?? options.pathsBasePath ?? cleanRoot),
  );
  const effectiveBaseRel =
    effectiveBaseAbs === cleanRoot
      ? ""
      : effectiveBaseAbs.startsWith(rootPrefixWithSlash)
        ? effectiveBaseAbs.slice(rootPrefixWithSlash.length)
        : undefined;
  if (effectiveBaseRel === undefined) {
    addWarning(
      `rejected tsconfig paths base that escapes the root: ${configRelativePath}`,
    );
    const { paths: _omit, pathsBasePath: _omitBase, ...rest } = options;
    return rest;
  }

  const safePaths = new Map<string, readonly string[]>();
  for (const [pattern, targets] of options.paths.entries()) {
    const safeTargets: string[] = [];
    for (const target of targets) {
      if (!isSafePathTargetWithinRoot(effectiveBaseRel, target)) {
        addWarning(
          `rejected tsconfig paths target that escapes the root: ${configRelativePath} ('${pattern}' -> '${target}')`,
        );
        continue;
      }
      safeTargets.push(target);
    }
    if (safeTargets.length > 0) {
      safePaths.set(pattern, safeTargets);
    }
  }
  if (safePaths.size === 0) {
    const { paths: _omit, pathsBasePath: _omitBase, ...rest } = options;
    return rest;
  }
  return { ...options, paths: safePaths };
}

function mergeSafeOptions(
  base: PartialSafeOptions,
  override: PartialSafeOptions,
): PartialSafeOptions {
  const merged: PartialSafeOptions = {};
  const baseUrl = override.baseUrl ?? base.baseUrl;
  if (baseUrl !== undefined) merged.baseUrl = baseUrl;

  if (override.paths !== undefined) {
    merged.paths = new Map(override.paths);
    if (override.pathsBasePath !== undefined) {
      merged.pathsBasePath = override.pathsBasePath;
    }
  } else if (base.paths !== undefined) {
    merged.paths = new Map(base.paths);
    if (base.pathsBasePath !== undefined) {
      merged.pathsBasePath = base.pathsBasePath;
    }
  }

  const jsx = override.jsx ?? base.jsx;
  if (jsx !== undefined) merged.jsx = jsx;

  const moduleResolution = override.moduleResolution ?? base.moduleResolution;
  if (moduleResolution !== undefined) merged.moduleResolution = moduleResolution;

  const moduleKind = override.module ?? base.module;
  if (moduleKind !== undefined) merged.module = moduleKind;

  const target = override.target ?? base.target;
  if (target !== undefined) merged.target = target;

  const experimentalDecorators =
    override.experimentalDecorators ?? base.experimentalDecorators;
  if (experimentalDecorators !== undefined) {
    merged.experimentalDecorators = experimentalDecorators;
  }

  const verbatimModuleSyntax =
    override.verbatimModuleSyntax ?? base.verbatimModuleSyntax;
  if (verbatimModuleSyntax !== undefined) {
    merged.verbatimModuleSyntax = verbatimModuleSyntax;
  }

  return merged;
}

function readBoundedTextFromFd(
  nodeFs: NodeFsMinimal,
  targetPath: string,
  leafStat: NodeFsStatMinimal,
  relPath: string,
  addWarning: (msg: string) => void,
): string | undefined {
  const openFlags =
    (nodeFs.constants?.O_RDONLY ?? 0) | (nodeFs.constants?.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = nodeFs.openSync(targetPath, openFlags);
  } catch {
    return undefined;
  }
  try {
    const fdStat = nodeFs.fstatSync(fd);
    if (!fdStat.isFile()) return undefined;
    if (fdStat.size > MAX_TSCONFIG_BYTES) {
      addWarning(`config file exceeds the 256 KB limit: ${relPath}`);
      return undefined;
    }
    if (
      leafStat.ino !== undefined &&
      leafStat.ino !== 0 &&
      (fdStat.ino !== leafStat.ino || fdStat.dev !== leafStat.dev)
    ) {
      addWarning(`config file changed while being read (TOCTOU): ${relPath}`);
      return undefined;
    }
    const buf = new Uint8Array(MAX_TSCONFIG_BYTES + 1);
    let totalRead = 0;
    while (totalRead < buf.length) {
      const bytesRead = nodeFs.readSync(
        fd,
        buf,
        totalRead,
        buf.length - totalRead,
        null,
      );
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    if (totalRead > MAX_TSCONFIG_BYTES) {
      addWarning(`config file exceeds the 256 KB limit after reading: ${relPath}`);
      return undefined;
    }
    return decodeUtf8(buf.subarray(0, totalRead));
  } catch {
    return undefined;
  } finally {
    try {
      nodeFs.closeSync(fd);
    } catch {
      // Kapatma hatası yutulur.
    }
  }
}

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/)/;

function isUncOrDevicePath(raw: string): boolean {
  if (raw.length < 2) {
    return false;
  }
  return UNC_OR_DEVICE_PREFIX.test(raw);
}

function createDiskConfigReader(
  rootDirOnDisk: string,
  addWarning: (msg: string) => void,
): ((relativePath: string) => string | undefined) | undefined {
  if (isUncOrDevicePath(rootDirOnDisk) || rootDirOnDisk.includes("\0")) {
    addWarning(`disk read refused for a UNC/device rootDir`);
    return undefined;
  }
  const nodeFs = getNodeFs();
  if (nodeFs === undefined) return undefined;

  let rootStat: NodeFsStatMinimal;
  try {
    rootStat = nodeFs.lstatSync(rootDirOnDisk);
  } catch {
    return undefined;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addWarning(`skipped disk config read: rootDir is a symlink or not a directory`);
    return undefined;
  }

  let rawRealRoot: string;
  try {
    rawRealRoot = nodeFs.realpathSync(rootDirOnDisk);
  } catch {
    return undefined;
  }
  if (isUncOrDevicePath(rawRealRoot)) {
    addWarning(`disk read refused for a UNC/device rootDir`);
    return undefined;
  }
  const realRootPosix = stripNonRootTrailingSlash(
    normalizePosixAbsolute(rawRealRoot),
  );
  const realRootKey = canonicalKey(realRootPosix);
  const rootPrefixWithSlash = realRootKey.endsWith("/") ? realRootKey : `${realRootKey}/`;
  const cleanRootNative = stripNonRootTrailingSlash(
    toPosix(stripWindowsExtendedPrefix(rootDirOnDisk)),
  );

  return (rawRelPath: string): string | undefined => {
    const relPath = validateRelativeConfigPath(rawRelPath);
    if (relPath === undefined) return undefined;
    if (!relPath.toLowerCase().endsWith(".json")) return undefined;
    if (hasForbiddenDiskSegment(relPath)) {
      addWarning(`rejected config path with a forbidden segment: ${relPath}`);
      return undefined;
    }

    const segments = relPath.split("/");
    let currentPath = cleanRootNative;
    let leafStat: NodeFsStatMinimal | undefined;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg === undefined) return undefined;
      currentPath = currentPath.endsWith("/")
        ? `${currentPath}${seg}`
        : `${currentPath}/${seg}`;
      let stat: NodeFsStatMinimal;
      try {
        stat = nodeFs.lstatSync(currentPath);
      } catch {
        return undefined;
      }
      if (stat.isSymbolicLink()) {
        addWarning(`rejected symlinked config file (CWE-59): ${relPath}`);
        return undefined;
      }
      const isLast = i === segments.length - 1;
      if (!isLast) {
        if (!stat.isDirectory()) return undefined;
      } else {
        if (!stat.isFile()) return undefined;
        if (stat.size > MAX_TSCONFIG_BYTES) {
          addWarning(`config file exceeds the 256 KB limit: ${relPath}`);
          return undefined;
        }
        leafStat = stat;
      }
    }
    if (leafStat === undefined) return undefined;

    let realTargetRaw: string;
    try {
      realTargetRaw = nodeFs.realpathSync(currentPath);
    } catch {
      return undefined;
    }
    const realTargetKey = canonicalKey(realTargetRaw);
    if (!realTargetKey.startsWith(rootPrefixWithSlash)) {
      addWarning(`rejected config file that resolves outside the root (CWE-59): ${relPath}`);
      return undefined;
    }

    return readBoundedTextFromFd(
      nodeFs,
      realTargetRaw,
      leafStat,
      relPath,
      addWarning,
    );
  };
}

function collectCandidateDiskDirs(
  sourceRelativePaths?: readonly string[],
): string[] {
  const dirs = new Set<string>([""]);
  if (sourceRelativePaths !== undefined) {
    const sortedSources = [...sourceRelativePaths].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const rel of sortedSources) {
      const valid = validateRelativeConfigPath(rel);
      if (valid === undefined) continue;
      let dir = relativeDirPrefix(valid);
      while (dir.length > 0) {
        dirs.add(dir);
        dir = relativeDirPrefix(dir);
      }
    }
  }
  // Sığ monorepo kökleri derin alt dizinlerin gerisinde kesilmesin diye
  // önce derinlik artan, eşitlikte sözlük sırasıyla sıralanır.
  return [...dirs]
    .sort((a, b) => {
      const depthDiff = segmentDepth(a) - segmentDepth(b);
      if (depthDiff !== 0) return depthDiff;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, MAX_DISK_SCAN_DIRS);
}

function segmentDepth(dirPrefix: string): number {
  return dirPrefix === "" ? 0 : dirPrefix.split("/").length;
}

function isTsConfigBasename(relativePath: string): boolean {
  return relativeBasename(relativePath).toLowerCase() === "tsconfig.json";
}

interface ResolveOutcome {
  readonly options: PartialSafeOptions | undefined;
  readonly globallyCacheable: boolean;
}

/**
 * Workspace içindeki `tsconfig.json` / `jsconfig.json` dosyalarını güvenli ve
 * deterministik biçimde yükler, `extends` zincirlerini kök içinde çözümler ve
 * en derin dizin önde olacak şekilde sıralı `ScopedTsConfig[]` döndürür.
 */
export function loadWorkspaceTsConfigs(
  rootPosix: string,
  configFiles?: readonly TsAdapterSourceFile[],
  rootDirOnDisk?: string,
  sourceRelativePaths?: readonly string[],
): LoadedTsConfigs {
  const normalizedRoot = stripNonRootTrailingSlash(normalizePosixAbsolute(rootPosix));
  const warnings: string[] = [];
  const warningSeen = new Set<string>();
  const addWarning = (message: string): void => {
    if (warnings.length >= MAX_TSCONFIG_WARNINGS) return;
    if (warningSeen.has(message)) return;
    warningSeen.add(message);
    warnings.push(message);
  };

  const rawByCanonRel = new Map<string, RawConfigEntry>();
  let readDiskConfigSafe: ((relPath: string) => string | undefined) | undefined;

  if (configFiles !== undefined) {
    const sortedInputs = [...configFiles].sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    for (const file of sortedInputs) {
      const validRel = validateRelativeConfigPath(file.relativePath);
      if (validRel === undefined) {
        addWarning(`ignored invalid tsconfig path: ${file.relativePath}`);
        continue;
      }
      if (utf8Encode(file.content).byteLength > MAX_TSCONFIG_BYTES) {
        addWarning(`tsconfig exceeds the 256 KB limit: ${validRel}`);
        continue;
      }
      const key = canonicalRelKey(validRel);
      if (!rawByCanonRel.has(key)) {
        rawByCanonRel.set(key, { relativePath: validRel, content: file.content });
      }
    }
  } else if (rootDirOnDisk !== undefined) {
    readDiskConfigSafe = createDiskConfigReader(rootDirOnDisk, addWarning);
    if (readDiskConfigSafe !== undefined) {
      const candidateDirs = collectCandidateDiskDirs(sourceRelativePaths);
      for (const dir of candidateDirs) {
        for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
          const relPath = dir === "" ? fileName : `${dir}/${fileName}`;
          const content = readDiskConfigSafe(relPath);
          if (content !== undefined) {
            rawByCanonRel.set(canonicalRelKey(relPath), {
              relativePath: relPath,
              content,
            });
          }
        }
      }
    }
  }

  const getRawConfig = (relPath: string): RawConfigEntry | undefined => {
    const key = canonicalRelKey(relPath);
    const existing = rawByCanonRel.get(key);
    if (existing !== undefined) return existing;
    if (readDiskConfigSafe === undefined) return undefined;
    const diskContent = readDiskConfigSafe(relPath);
    if (diskContent === undefined) return undefined;
    const loaded: RawConfigEntry = { relativePath: relPath, content: diskContent };
    rawByCanonRel.set(key, loaded);
    return loaded;
  };

  // SEC-02: JSONC parse + çözümlenmiş options memoization ve global ziyaret bütçesi.
  const parsedCache = new Map<string, Record<string, unknown> | null>();
  const resolvedGlobalCache = new Map<string, PartialSafeOptions | null>();
  const resolvedDepthCache = new Map<string, PartialSafeOptions | null>();
  let totalVisits = 0;

  const getParsedConfig = (
    entry: RawConfigEntry,
    canonRel: string,
  ): Record<string, unknown> | undefined => {
    if (parsedCache.has(canonRel)) {
      return parsedCache.get(canonRel) ?? undefined;
    }
    const parsed = ts.parseConfigFileTextToJson(entry.relativePath, entry.content);
    if (parsed.error !== undefined || !isPlainRecord(parsed.config)) {
      addWarning(`ignored invalid tsconfig JSONC: ${entry.relativePath}`);
      parsedCache.set(canonRel, null);
      return undefined;
    }
    checkPrototypeInjection(parsed.config, entry.relativePath, addWarning);
    parsedCache.set(canonRel, parsed.config);
    return parsed.config;
  };

  const resolveConfigOptions = (
    entry: RawConfigEntry,
    depth: number,
    visited: ReadonlySet<string>,
  ): ResolveOutcome => {
    if (depth > MAX_EXTENDS_DEPTH) {
      addWarning(
        `tsconfig extends depth limit (${String(MAX_EXTENDS_DEPTH)}) exceeded: ${entry.relativePath}`,
      );
      return { options: undefined, globallyCacheable: false };
    }
    const canonRel = canonicalRelKey(entry.relativePath);
    if (visited.has(canonRel)) {
      addWarning(
        `circular tsconfig extends chain detected: ${entry.relativePath}`,
      );
      return { options: undefined, globallyCacheable: false };
    }

    if (resolvedGlobalCache.has(canonRel)) {
      return {
        options: resolvedGlobalCache.get(canonRel) ?? undefined,
        globallyCacheable: true,
      };
    }
    const depthKey = `${canonRel}@${String(depth)}`;
    if (resolvedDepthCache.has(depthKey)) {
      return {
        options: resolvedDepthCache.get(depthKey) ?? undefined,
        globallyCacheable: false,
      };
    }

    if (totalVisits >= MAX_TOTAL_RESOLVE_VISITS) {
      addWarning(
        `tsconfig extends visit budget (${String(MAX_TOTAL_RESOLVE_VISITS)}) exceeded; the remaining chain was cut`,
      );
      return { options: undefined, globallyCacheable: false };
    }
    totalVisits += 1;

    const parsedConfig = getParsedConfig(entry, canonRel);
    if (parsedConfig === undefined) {
      resolvedGlobalCache.set(canonRel, null);
      return { options: undefined, globallyCacheable: true };
    }

    const dirPrefix = relativeDirPrefix(entry.relativePath);
    let accumulated: PartialSafeOptions = {};
    let globallyCacheable = true;

    const rawExtends = ownProperty(parsedConfig, "extends");
    const extendsList: string[] = [];
    if (typeof rawExtends === "string") {
      extendsList.push(rawExtends);
    } else if (Array.isArray(rawExtends)) {
      for (const item of rawExtends) {
        if (typeof item !== "string") continue;
        if (extendsList.length >= MAX_EXTENDS_ENTRIES) {
          addWarning(
            `tsconfig extends entry limit (${String(MAX_EXTENDS_ENTRIES)}) exceeded: ${entry.relativePath}`,
          );
          break;
        }
        extendsList.push(item);
      }
    }

    if (extendsList.length > 0) {
      const nextVisited = new Set(visited);
      nextVisited.add(canonRel);
      for (const rawSpec of extendsList) {
        const spec = rawSpec.trim();
        if (spec.length === 0) continue;
        if (isAbsoluteOrUnsafeExtendsSpec(spec)) {
          addWarning(
            `rejected absolute/unsafe tsconfig extends: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        if (!isRelativeExtendsSpec(spec)) {
          // Çıplak node_modules paket extends zarifçe atlanır.
          continue;
        }
        const resolved = resolveRelativeWithinRoot(dirPrefix, spec);
        if (!resolved.ok) {
          addWarning(
            `rejected tsconfig extends that escapes the root: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        // Yalnızca .json adayları yoklanır (SEC-06); boş göreli yol kök `tsconfig.json`'dur.
        const candidatePaths: string[] =
          resolved.relativePath === ""
            ? ["tsconfig.json"]
            : resolved.relativePath.toLowerCase().endsWith(".json")
              ? [resolved.relativePath]
              : [
                  `${resolved.relativePath}.json`,
                  `${resolved.relativePath}/tsconfig.json`,
                ];
        let parentEntry: RawConfigEntry | undefined;
        for (const candidate of candidatePaths) {
          if (candidate.length === 0) continue;
          parentEntry = getRawConfig(candidate);
          if (parentEntry !== undefined) break;
        }
        if (parentEntry === undefined) {
          addWarning(
            `tsconfig extends target not found: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        const parentOutcome = resolveConfigOptions(
          parentEntry,
          depth + 1,
          nextVisited,
        );
        if (!parentOutcome.globallyCacheable) {
          globallyCacheable = false;
        }
        if (parentOutcome.options !== undefined) {
          accumulated = mergeSafeOptions(accumulated, parentOutcome.options);
        }
      }
    }

    const ownOpts = extractSafeCompilerOptions(
      entry.relativePath,
      dirPrefix,
      normalizedRoot,
      ownProperty(parsedConfig, "compilerOptions"),
      addWarning,
    );
    const merged = mergeSafeOptions(accumulated, ownOpts);
    if (globallyCacheable) {
      resolvedGlobalCache.set(canonRel, merged);
    } else {
      resolvedDepthCache.set(depthKey, merged);
    }
    return { options: merged, globallyCacheable };
  };

  const sortedActiveEntries = [...rawByCanonRel.values()]
    .filter((entry) => isActiveProjectConfigFile(entry.relativePath))
    .sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
  const activeEntries = sortedActiveEntries.slice(0, MAX_SCOPED_CONFIGS);
  if (sortedActiveEntries.length > MAX_SCOPED_CONFIGS) {
    addWarning(
      `active tsconfig/jsconfig limit (${String(MAX_SCOPED_CONFIGS)}) exceeded; remaining configs were dropped`,
    );
  }

  const scopedConfigs: ScopedTsConfig[] = [];
  for (const entry of activeEntries) {
    const outcome = resolveConfigOptions(entry, 0, new Set<string>());
    if (outcome.options === undefined) continue;
    const resolved = sanitizePathsWithinRoot(
      entry.relativePath,
      normalizedRoot,
      outcome.options,
      addWarning,
    );
    const dirPrefix = relativeDirPrefix(entry.relativePath);
    const scoped: ScopedTsConfig = {
      dirPrefix,
      configRelativePath: entry.relativePath,
      ...(resolved.baseUrl === undefined ? {} : { baseUrl: resolved.baseUrl }),
      ...(resolved.paths === undefined ? {} : { paths: resolved.paths }),
      ...(resolved.pathsBasePath === undefined
        ? {}
        : { pathsBasePath: resolved.pathsBasePath }),
      ...(resolved.jsx === undefined ? {} : { jsx: resolved.jsx }),
      ...(resolved.moduleResolution === undefined
        ? {}
        : { moduleResolution: resolved.moduleResolution }),
      ...(resolved.module === undefined ? {} : { module: resolved.module }),
      ...(resolved.target === undefined ? {} : { target: resolved.target }),
      ...(resolved.experimentalDecorators === undefined
        ? {}
        : { experimentalDecorators: resolved.experimentalDecorators }),
      ...(resolved.verbatimModuleSyntax === undefined
        ? {}
        : { verbatimModuleSyntax: resolved.verbatimModuleSyntax }),
    };
    scopedConfigs.push(scoped);
  }

  // En derin dizin öneki önce; aynı dizinde tsconfig.json > jsconfig.json;
  // eşitlikte sözlük sırası (100% deterministik).
  scopedConfigs.sort((a, b) => {
    const depthDiff = segmentDepth(b.dirPrefix) - segmentDepth(a.dirPrefix);
    if (depthDiff !== 0) return depthDiff;
    const lenDiff = b.dirPrefix.length - a.dirPrefix.length;
    if (lenDiff !== 0) return lenDiff;
    const aIsTs = isTsConfigBasename(a.configRelativePath) ? 0 : 1;
    const bIsTs = isTsConfigBasename(b.configRelativePath) ? 0 : 1;
    if (aIsTs !== bIsTs) return aIsTs - bIsTs;
    return a.configRelativePath < b.configRelativePath
      ? -1
      : a.configRelativePath > b.configRelativePath
        ? 1
        : 0;
  });

  return { configs: scopedConfigs, warnings };
}

/**
 * Verilen workspace-relative dosya yolu için en yakın ata `ScopedTsConfig`
 * kaydını seçer (`configs` derinlik azalan sırada beklenir).
 */
export function findScopedTsConfigForFile(
  configs: readonly ScopedTsConfig[],
  fileRelativePath: string,
): ScopedTsConfig | undefined {
  const fileKey = canonicalRelKey(toPosix(fileRelativePath));
  for (const config of configs) {
    if (config.dirPrefix === "") {
      return config;
    }
    const prefixKey = canonicalRelKey(config.dirPrefix);
    if (fileKey.startsWith(`${prefixKey}/`)) {
      return config;
    }
  }
  return undefined;
}

/**
 * `ScopedTsConfig.paths` haritasını prototype-pollution korumalı
 * (null-prototype) `ts.MapLike<string[]>` nesnesine çevirir.
 */
export function toCompilerPathsObject(
  paths: ReadonlyMap<string, readonly string[]>,
): ts.MapLike<string[]> {
  const result = Object.create(null) as ts.MapLike<string[]>;
  for (const [pattern, targets] of paths.entries()) {
    if (FORBIDDEN_KEYS.has(pattern)) continue;
    result[pattern] = [...targets];
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Scoped CompilerOptions & modül çözümleme yardımcıları                */
/* ------------------------------------------------------------------ */

function compatibleModuleForResolution(
  resolution: ts.ModuleResolutionKind,
  preferred: ts.ModuleKind | undefined,
): ts.ModuleKind {
  if (resolution === ts.ModuleResolutionKind.NodeNext) {
    return ts.ModuleKind.NodeNext;
  }
  if (resolution === ts.ModuleResolutionKind.Node16) {
    return ts.ModuleKind.Node16;
  }
  if (resolution === ts.ModuleResolutionKind.Bundler) {
    if (
      preferred === ts.ModuleKind.ES2015 ||
      preferred === ts.ModuleKind.ES2020 ||
      preferred === ts.ModuleKind.ES2022 ||
      preferred === ts.ModuleKind.ESNext ||
      preferred === ts.ModuleKind.Preserve
    ) {
      return preferred;
    }
    return ts.ModuleKind.ESNext;
  }
  if (
    preferred !== undefined &&
    preferred !== ts.ModuleKind.NodeNext &&
    preferred !== ts.ModuleKind.Node16
  ) {
    return preferred;
  }
  return ts.ModuleKind.ESNext;
}

/** Program düzeyi `ts.CompilerOptions` nesnesini yüklenen config'lerden üretir. */
export function buildProgramCompilerOptions(
  configs: readonly ScopedTsConfig[],
): ts.CompilerOptions {
  const rootConfig = configs.find((config) => config.dirPrefix === "");
  const firstJsx = configs.find((config) => config.jsx !== undefined)?.jsx;

  const hasExplicitResolution = rootConfig?.moduleResolution !== undefined;
  const hasRootAliasOrBase =
    rootConfig?.paths !== undefined || rootConfig?.baseUrl !== undefined;

  const moduleResolution = hasExplicitResolution
    ? (rootConfig.moduleResolution as ts.ModuleResolutionKind)
    : hasRootAliasOrBase
      ? ts.ModuleResolutionKind.Bundler
      : ts.ModuleResolutionKind.NodeNext;
  const moduleKind = compatibleModuleForResolution(
    moduleResolution,
    rootConfig?.module,
  );

  const options: ts.CompilerOptions = {
    strict: true,
    allowJs: true,
    checkJs: false,
    jsx: rootConfig?.jsx ?? firstJsx ?? ts.JsxEmit.Preserve,
    target: rootConfig?.target ?? ts.ScriptTarget.ES2022,
    module: moduleKind,
    moduleResolution,
    skipLibCheck: true,
    noEmit: true,
  };

  if (rootConfig?.baseUrl !== undefined) {
    options.baseUrl = rootConfig.baseUrl;
  }
  if (rootConfig?.paths !== undefined) {
    options.paths = toCompilerPathsObject(rootConfig.paths);
    if (rootConfig.baseUrl === undefined && rootConfig.pathsBasePath !== undefined) {
      options["pathsBasePath"] = rootConfig.pathsBasePath;
    }
  }
  // MEDIUM-5: Monorepo alt projesindeki `experimentalDecorators: true` program düzeyine taşınır.
  const experimentalDecorators =
    rootConfig?.experimentalDecorators ??
    (configs.some((config) => config.experimentalDecorators === true)
      ? true
      : undefined);
  if (experimentalDecorators !== undefined) {
    options.experimentalDecorators = experimentalDecorators;
  }
  if (rootConfig?.verbatimModuleSyntax !== undefined) {
    options.verbatimModuleSyntax = rootConfig.verbatimModuleSyntax;
  }

  return options;
}

const scopedResolutionCache = new WeakMap<
  ts.CompilerOptions,
  WeakMap<ScopedTsConfig, ts.CompilerOptions>
>();

/** Verilen `containingFile` kapsamı için izole (önbellekli) `ts.CompilerOptions` üretir. */
export function buildScopedResolutionOptions(
  programOptions: ts.CompilerOptions,
  scopedConfig: ScopedTsConfig | undefined,
): ts.CompilerOptions {
  if (scopedConfig === undefined) return programOptions;

  let perProgram = scopedResolutionCache.get(programOptions);
  const cached = perProgram?.get(scopedConfig);
  if (cached !== undefined) return cached;

  const hasAliasOrBase =
    scopedConfig.paths !== undefined || scopedConfig.baseUrl !== undefined;
  const moduleResolution =
    scopedConfig.moduleResolution ??
    (hasAliasOrBase
      ? ts.ModuleResolutionKind.Bundler
      : (programOptions.moduleResolution ?? ts.ModuleResolutionKind.NodeNext));
  const moduleKind = compatibleModuleForResolution(
    moduleResolution,
    scopedConfig.module ?? programOptions.module,
  );

  const scoped: ts.CompilerOptions = {
    ...programOptions,
    module: moduleKind,
    moduleResolution,
  };
  delete scoped.baseUrl;
  delete scoped.paths;
  delete scoped["pathsBasePath"];

  if (scopedConfig.baseUrl !== undefined) {
    scoped.baseUrl = scopedConfig.baseUrl;
  }
  if (scopedConfig.paths !== undefined) {
    scoped.paths = toCompilerPathsObject(scopedConfig.paths);
    if (scopedConfig.baseUrl === undefined && scopedConfig.pathsBasePath !== undefined) {
      scoped["pathsBasePath"] = scopedConfig.pathsBasePath;
    }
  }

  if (perProgram === undefined) {
    perProgram = new WeakMap<ScopedTsConfig, ts.CompilerOptions>();
    scopedResolutionCache.set(programOptions, perProgram);
  }
  perProgram.set(scopedConfig, scoped);
  return scoped;
}

const VIRTUAL_PROBE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const VIRTUAL_INDEX_CANDIDATES: readonly string[] = [
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.d.ts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
];

/** Uzantısız veya .js/.mjs/.cjs/.jsx referansları için deterministik aday yolları üretir. */
export function expandCandidatePaths(basePath: string): string[] {
  const candidates: string[] = [basePath];
  const lower = basePath.toLowerCase();
  if (lower.endsWith(".js")) {
    const stem = basePath.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`, `${stem}.mjs`, `${stem}.cjs`);
  } else if (lower.endsWith(".jsx")) {
    const stem = basePath.slice(0, -4);
    candidates.push(`${stem}.tsx`, `${stem}.ts`, `${stem}.js`);
  } else if (lower.endsWith(".mjs")) {
    const stem = basePath.slice(0, -4);
    candidates.push(`${stem}.mts`, `${stem}.ts`, `${stem}.js`);
  } else if (lower.endsWith(".cjs")) {
    const stem = basePath.slice(0, -4);
    candidates.push(`${stem}.cts`, `${stem}.ts`, `${stem}.js`);
  } else {
    for (const ext of VIRTUAL_PROBE_EXTENSIONS) {
      candidates.push(`${basePath}${ext}`);
    }
    for (const indexSuffix of VIRTUAL_INDEX_CANDIDATES) {
      candidates.push(`${basePath}${indexSuffix}`);
    }
  }
  return candidates;
}

function tsExtensionForPath(relativePath: string): ts.Extension {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".d.mts")) return ts.Extension.Dmts;
  if (lower.endsWith(".d.cts")) return ts.Extension.Dcts;
  if (lower.endsWith(".d.ts")) return ts.Extension.Dts;
  if (lower.endsWith(".tsx")) return ts.Extension.Tsx;
  if (lower.endsWith(".mts")) return ts.Extension.Mts;
  if (lower.endsWith(".cts")) return ts.Extension.Cts;
  if (lower.endsWith(".ts")) return ts.Extension.Ts;
  if (lower.endsWith(".jsx")) return ts.Extension.Jsx;
  if (lower.endsWith(".mjs")) return ts.Extension.Mjs;
  if (lower.endsWith(".cjs")) return ts.Extension.Cjs;
  if (lower.endsWith(".js")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function matchScopedPathPatterns(
  moduleName: string,
  paths: ReadonlyMap<string, readonly string[]>,
): readonly { readonly matchedStar: string; readonly targets: readonly string[] }[] {
  const exact = paths.get(moduleName);
  const matches: Array<{
    readonly prefixLen: number;
    readonly pattern: string;
    readonly matchedStar: string;
    readonly targets: readonly string[];
  }> = [];
  if (exact !== undefined) {
    matches.push({
      prefixLen: Number.MAX_SAFE_INTEGER,
      pattern: moduleName,
      matchedStar: "",
      targets: exact,
    });
  }
  for (const [pattern, targets] of paths.entries()) {
    const starIdx = pattern.indexOf("*");
    if (starIdx < 0) continue;
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (
      moduleName.length >= prefix.length + suffix.length &&
      moduleName.startsWith(prefix) &&
      moduleName.endsWith(suffix)
    ) {
      const matchedStar = moduleName.slice(
        prefix.length,
        suffix.length === 0 ? moduleName.length : moduleName.length - suffix.length,
      );
      matches.push({ prefixLen: prefix.length, pattern, matchedStar, targets });
    }
  }
  matches.sort((a, b) => {
    if (b.prefixLen !== a.prefixLen) return b.prefixLen - a.prefixLen;
    return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
  });
  return matches;
}

function probeEntryInMemory(
  candidateBaseAbs: string,
  rootKeyWithSlash: string,
  entries: ReadonlyMap<string, { readonly relativePath: string; readonly absolutePath: string }>,
): ts.ResolvedModuleFull | undefined {
  const normalizedBase = normalizePosixAbsolute(candidateBaseAbs);
  if (!canonicalKey(normalizedBase).startsWith(rootKeyWithSlash)) {
    return undefined;
  }
  for (const candidate of expandCandidatePaths(normalizedBase)) {
    const hit = entries.get(canonicalKey(candidate));
    if (hit !== undefined) {
      return {
        resolvedFileName: hit.absolutePath,
        extension: tsExtensionForPath(hit.relativePath),
        isExternalLibraryImport: false,
      };
    }
  }
  return undefined;
}

/**
 * Work state of the in-memory alias fallback for ONE analysis run (it assumes a
 * fixed source set): memoized outcomes per (scoped config, specifier), the
 * alias targets probed so far against the run budget, and the warnings the
 * budgets produced (deduplicated, in first-occurrence order).
 */
export interface VirtualAliasResolutionState {
  readonly maxProbes: number;
  probes: number;
  readonly warnings: string[];
  readonly outcomes: WeakMap<ScopedTsConfig, Map<string, ts.ResolvedModuleFull | null>>;
}

/** Creates the alias fallback work state of one analysis run. */
export function createVirtualAliasResolutionState(
  maxProbes: number = MAX_VIRTUAL_ALIAS_PROBES_PER_RUN,
): VirtualAliasResolutionState {
  return { maxProbes, probes: 0, warnings: [], outcomes: new WeakMap() };
}

function addVirtualAliasWarning(state: VirtualAliasResolutionState, message: string): void {
  if (!state.warnings.includes(message)) state.warnings.push(message);
}

function resolveViaVirtualAlias(
  moduleName: string,
  scopedConfig: ScopedTsConfig,
  entries: ReadonlyMap<string, { readonly relativePath: string; readonly absolutePath: string }>,
  rootKeyWithSlash: string,
  state: VirtualAliasResolutionState | undefined,
): ts.ResolvedModuleFull | undefined {
  if (moduleName.includes("\0")) return undefined;
  if (moduleName.length > MAX_VIRTUAL_ALIAS_SPECIFIER_CHARS) return undefined;

  let outcomes: Map<string, ts.ResolvedModuleFull | null> | undefined;
  if (state !== undefined) {
    outcomes = state.outcomes.get(scopedConfig);
    if (outcomes === undefined) {
      outcomes = new Map<string, ts.ResolvedModuleFull | null>();
      state.outcomes.set(scopedConfig, outcomes);
    }
    const known = outcomes.get(moduleName);
    if (known !== undefined) return known ?? undefined;
  }
  const resolved = probeVirtualAliasTargets(
    moduleName,
    scopedConfig,
    entries,
    rootKeyWithSlash,
    state,
  );
  outcomes?.set(moduleName, resolved ?? null);
  return resolved;
}

function probeVirtualAliasTargets(
  moduleName: string,
  scopedConfig: ScopedTsConfig,
  entries: ReadonlyMap<string, { readonly relativePath: string; readonly absolutePath: string }>,
  rootKeyWithSlash: string,
  state: VirtualAliasResolutionState | undefined,
): ts.ResolvedModuleFull | undefined {
  // Every alias target probe (up to 19 candidate lookups) is charged to the
  // per-specifier cap and to the run budget; a spent budget ends the fallback
  // with a controlled "unresolved" outcome and a warning.
  let probesLeft = MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER;
  let stopped = false;
  const probe = (candidateBaseAbs: string): ts.ResolvedModuleFull | undefined => {
    if (state !== undefined && state.probes >= state.maxProbes) {
      addVirtualAliasWarning(
        state,
        `tsconfig paths alias probe budget (${String(state.maxProbes)}) exhausted; remaining alias imports were not probed and stay unresolved`,
      );
      stopped = true;
      return undefined;
    }
    if (probesLeft <= 0) {
      if (state !== undefined) {
        addVirtualAliasWarning(
          state,
          `tsconfig paths alias probing stopped after ${String(MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER)} targets for one import; its remaining targets were not probed: ${scopedConfig.configRelativePath}`,
        );
      }
      stopped = true;
      return undefined;
    }
    probesLeft -= 1;
    if (state !== undefined) state.probes += 1;
    return probeEntryInMemory(candidateBaseAbs, rootKeyWithSlash, entries);
  };

  if (scopedConfig.paths !== undefined) {
    const baseDir = scopedConfig.baseUrl ?? scopedConfig.pathsBasePath;
    if (baseDir !== undefined) {
      for (const match of matchScopedPathPatterns(moduleName, scopedConfig.paths)) {
        for (const rawTarget of match.targets) {
          // SEC-11: Dilimleme ikamesi '$&' / "$'" özel kalıp genişlemesini önler ve tek '*' semantiğini korur.
          const starIdx = rawTarget.indexOf("*");
          const substituted =
            starIdx >= 0
              ? `${rawTarget.slice(0, starIdx)}${match.matchedStar}${rawTarget.slice(starIdx + 1)}`
              : rawTarget;
          const targetPosix = toPosix(substituted);
          if (targetPosix.startsWith("/") || /^[a-zA-Z]:/.test(targetPosix)) {
            continue;
          }
          const resolved = probe(
            baseDir.endsWith("/")
              ? `${baseDir}${targetPosix}`
              : `${baseDir}/${targetPosix}`,
          );
          if (resolved !== undefined) return resolved;
          if (stopped) return undefined;
        }
      }
    }
  }

  if (
    scopedConfig.baseUrl !== undefined &&
    !moduleName.startsWith("./") &&
    !moduleName.startsWith("../") &&
    !moduleName.startsWith("/") &&
    !/^[a-zA-Z]:/.test(moduleName)
  ) {
    return probe(
      scopedConfig.baseUrl.endsWith("/")
        ? `${scopedConfig.baseUrl}${toPosix(moduleName)}`
        : `${scopedConfig.baseUrl}/${toPosix(moduleName)}`,
    );
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Monorepo Workspace Package Discovery & Confined Resolution (v0.3)   */
/* ------------------------------------------------------------------ */

/** Discovered in-repo workspace package manifest (strictly root-confined). */
export interface WorkspacePackageManifest {
  readonly name: string;
  /** Workspace-relative POSIX directory prefix ("" for root, "packages/domain" for subpkg). */
  readonly dirPrefix: string;
  readonly manifestRelativePath: string;
  readonly exports?: unknown;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly typings?: string;
}

/** Deterministic result of workspace `package.json` manifest discovery. */
export interface LoadedWorkspacePackages {
  readonly packages: ReadonlyMap<string, WorkspacePackageManifest>;
  readonly warnings: readonly string[];
}

function isWorkspacePackageJsonPath(relativePath: string): boolean {
  const base = relativeBasename(relativePath).toLowerCase();
  if (base !== "package.json") return false;
  for (const segment of relativePath.split("/")) {
    if (segment.toLowerCase() === "node_modules") return false;
  }
  return true;
}

function isSkippedWorkspaceScanDir(name: string): boolean {
  if (name.length === 0 || name.startsWith(".")) return true;
  return WORKSPACE_SKIP_DIRS.has(name.toLowerCase());
}

function trimSlashes(str: string): string {
  let start = 0;
  let end = str.length;
  while (start < end && str.charCodeAt(start) === 47) start += 1;
  while (end > start && str.charCodeAt(end - 1) === 47) end -= 1;
  return str.slice(start, end);
}

function extractRootWorkspacePatterns(
  rootPkg: Record<string, unknown>,
  addWarning: (message: string) => void,
): {
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
} {
  const rawWorkspaces = ownProperty(rootPkg, "workspaces");
  let rawList: unknown[] = [];
  if (Array.isArray(rawWorkspaces)) {
    rawList = rawWorkspaces;
  } else if (isPlainRecord(rawWorkspaces)) {
    const packagesField = ownProperty(rawWorkspaces, "packages");
    if (Array.isArray(packagesField)) {
      rawList = packagesField;
    }
  }

  // Duplicates are dropped and each list is capped: every include pattern costs
  // directory scans and every exclude is matched against every candidate.
  const includes: string[] = [];
  const excludes: string[] = [];
  const seenIncludes = new Set<string>();
  const seenExcludes = new Set<string>();
  let capped = false;
  const addPattern = (list: string[], seen: Set<string>, pattern: string): void => {
    if (seen.has(pattern)) return;
    if (list.length >= MAX_WORKSPACE_PATTERNS) {
      capped = true;
      return;
    }
    seen.add(pattern);
    list.push(pattern);
  };
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const trimmed = toPosix(item.trim());
    if (trimmed.length === 0 || trimmed.includes("\0")) continue;
    if (trimmed.startsWith("!")) {
      const cleaned = trimSlashes(trimmed.slice(1));
      if (cleaned.length > 0 && !cleaned.split("/").includes("..")) {
        addPattern(excludes, seenExcludes, cleaned);
      }
    } else {
      const cleaned = trimSlashes(trimmed.replace(/^\.\/+/, ""));
      if (cleaned.length > 0 && !cleaned.split("/").includes("..")) {
        addPattern(includes, seenIncludes, cleaned);
      }
    }
  }
  if (capped) {
    addWarning(
      `package.json workspaces pattern limit (${String(MAX_WORKSPACE_PATTERNS)}) exceeded; remaining patterns were ignored: package.json`,
    );
  }
  return { includes, excludes };
}

function matchGlobSegment(patternSegment: string, name: string): boolean {
  if (patternSegment === "*") return true;
  const starIdx = patternSegment.indexOf("*");
  if (starIdx < 0) {
    return ts.sys.useCaseSensitiveFileNames
      ? patternSegment === name
      : patternSegment.toLowerCase() === name.toLowerCase();
  }
  if (starIdx !== patternSegment.lastIndexOf("*")) return false;
  const prefix = patternSegment.slice(0, starIdx);
  const suffix = patternSegment.slice(starIdx + 1);
  if (name.length < prefix.length + suffix.length) return false;
  if (ts.sys.useCaseSensitiveFileNames) {
    return name.startsWith(prefix) && name.endsWith(suffix);
  }
  const lowerName = name.toLowerCase();
  return lowerName.startsWith(prefix.toLowerCase()) && lowerName.endsWith(suffix.toLowerCase());
}

function isExcludedByWorkspacePatterns(
  dirRel: string,
  excludes: readonly string[],
): boolean {
  if (excludes.length === 0) return false;
  const dirSegments = dirRel.split("/");
  for (const pattern of excludes) {
    const patSegments = pattern.split("/").filter((s) => s.length > 0);
    if (patSegments.length !== dirSegments.length) continue;
    let allMatch = true;
    for (let i = 0; i < patSegments.length; i += 1) {
      if (!matchGlobSegment(patSegments[i]!, dirSegments[i]!)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

/**
 * Root-confined directory scanner of one discovery run. Each directory is
 * listed at most once (results are memoized) and at most
 * `MAX_WORKSPACE_DIR_LISTINGS` distinct directories are listed; past that
 * budget a listing returns no children and one warning is recorded.
 */
function createConfinedDirScanner(
  rootDirOnDisk: string,
  addWarning: (message: string) => void,
): {
  readonly listSafeChildDirs: (dirRel: string) => readonly string[];
} | undefined {
  if (isUncOrDevicePath(rootDirOnDisk) || rootDirOnDisk.includes("\0")) {
    return undefined;
  }
  const nodeFs = getNodeFs();
  if (nodeFs === undefined || typeof nodeFs.readdirSync !== "function") {
    return undefined;
  }

  let rootStat: NodeFsStatMinimal;
  try {
    rootStat = nodeFs.lstatSync(rootDirOnDisk);
  } catch {
    return undefined;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return undefined;
  }

  let rawRealRoot: string;
  try {
    rawRealRoot = nodeFs.realpathSync(rootDirOnDisk);
  } catch {
    return undefined;
  }
  if (isUncOrDevicePath(rawRealRoot)) {
    return undefined;
  }
  const realRootPosix = stripNonRootTrailingSlash(
    normalizePosixAbsolute(rawRealRoot),
  );
  const realRootKey = canonicalKey(realRootPosix);
  const realRootPrefixWithSlash = realRootKey.endsWith("/")
    ? realRootKey
    : `${realRootKey}/`;
  const cleanRootNative = stripNonRootTrailingSlash(
    toPosix(stripWindowsExtendedPrefix(rootDirOnDisk)),
  );
  const readdirSync = nodeFs.readdirSync.bind(nodeFs);
  const listings = new Map<string, readonly string[]>();

  const listSafeChildDirsUncached = (dirRel: string): string[] => {
    const absDir =
      dirRel === ""
        ? cleanRootNative
        : cleanRootNative.endsWith("/")
          ? `${cleanRootNative}${dirRel}`
          : `${cleanRootNative}/${dirRel}`;
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      return [];
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const safeChildren: string[] = [];
    for (const name of names) {
      if (name.includes("\0") || name === "." || name === "..") continue;
      if (isSkippedWorkspaceScanDir(name)) continue;
      const childAbs = absDir.endsWith("/") ? `${absDir}${name}` : `${absDir}/${name}`;
      let stat: NodeFsStatMinimal;
      try {
        stat = nodeFs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      let realChild: string;
      try {
        realChild = nodeFs.realpathSync(childAbs);
      } catch {
        continue;
      }
      if (!canonicalKey(realChild).startsWith(realRootPrefixWithSlash)) {
        continue;
      }
      safeChildren.push(name);
    }
    return safeChildren;
  };

  return {
    listSafeChildDirs(dirRel: string): readonly string[] {
      const listed = listings.get(dirRel);
      if (listed !== undefined) return listed;
      if (listings.size >= MAX_WORKSPACE_DIR_LISTINGS) {
        addWarning(
          `workspace package scan stopped after ${String(MAX_WORKSPACE_DIR_LISTINGS)} directory listings; remaining directories were not scanned`,
        );
        return [];
      }
      const safeChildren = listSafeChildDirsUncached(dirRel);
      listings.set(dirRel, safeChildren);
      return safeChildren;
    },
  };
}

function expandWorkspacePatternDirs(
  pattern: string,
  scanner: { readonly listSafeChildDirs: (dirRel: string) => readonly string[] },
  excludes: readonly string[],
): string[] {
  const segments = pattern.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.length > MAX_WORKSPACE_SCAN_DEPTH) {
    return [];
  }
  if (segments.some((s) => s === ".." || s === "**" || s.toLowerCase() === "node_modules")) {
    return [];
  }
  let currentDirs: string[] = [""];
  for (const seg of segments) {
    const nextDirs: string[] = [];
    for (const dirRel of currentDirs) {
      const children = scanner.listSafeChildDirs(dirRel);
      for (const child of children) {
        if (!matchGlobSegment(seg, child)) continue;
        const nextRel = dirRel === "" ? child : `${dirRel}/${child}`;
        nextDirs.push(nextRel);
        if (nextDirs.length >= MAX_WORKSPACE_MANIFESTS) break;
      }
      if (nextDirs.length >= MAX_WORKSPACE_MANIFESTS) break;
    }
    currentDirs = nextDirs;
    if (currentDirs.length === 0) break;
  }
  return currentDirs.filter((dir) => !isExcludedByWorkspacePatterns(dir, excludes));
}

function parseSafePackageManifest(
  relativePath: string,
  content: string,
  addWarning: (msg: string) => void,
): { readonly manifest?: WorkspacePackageManifest; readonly rawRecord?: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    addWarning(invalidPackageJsonWarning(relativePath));
    return {};
  }
  if (!isPlainRecord(parsed)) return {};
  checkPrototypeInjection(parsed, relativePath, addWarning);

  const rawName = ownProperty(parsed, "name");
  if (typeof rawName !== "string") {
    return { rawRecord: parsed };
  }
  const name = rawName.trim();
  if (
    name.length === 0 ||
    name.includes("\0") ||
    FORBIDDEN_KEYS.has(name) ||
    !PACKAGE_NAME_PATTERN.test(name)
  ) {
    return { rawRecord: parsed };
  }

  const readOptString = (field: string): string | undefined => {
    const value = ownProperty(parsed, field);
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 && !trimmed.includes("\0") ? trimmed : undefined;
  };

  const exportsField = ownProperty(parsed, "exports");
  const main = readOptString("main");
  const moduleField = readOptString("module");
  const types = readOptString("types");
  const typings = readOptString("typings");

  return {
    rawRecord: parsed,
    manifest: {
      name,
      dirPrefix: relativeDirPrefix(relativePath),
      manifestRelativePath: relativePath,
      ...(exportsField === undefined ? {} : { exports: exportsField }),
      ...(main === undefined ? {} : { main }),
      ...(moduleField === undefined ? {} : { module: moduleField }),
      ...(types === undefined ? {} : { types }),
      ...(typings === undefined ? {} : { typings }),
    },
  };
}

function directoryHasAnalyzedSources(
  dirPrefix: string,
  sourceDirs: ReadonlySet<string>,
): boolean {
  if (dirPrefix === "") return sourceDirs.size > 0;
  return sourceDirs.has(canonicalRelKey(dirPrefix));
}

function shouldPreferManifest(
  candidate: WorkspacePackageManifest,
  existing: WorkspacePackageManifest,
  sourceDirs: ReadonlySet<string>,
): boolean {
  const candHas = directoryHasAnalyzedSources(candidate.dirPrefix, sourceDirs);
  const existHas = directoryHasAnalyzedSources(existing.dirPrefix, sourceDirs);
  if (candHas !== existHas) return candHas;
  const depthDiff = segmentDepth(candidate.dirPrefix) - segmentDepth(existing.dirPrefix);
  if (depthDiff !== 0) return depthDiff < 0;
  return candidate.dirPrefix < existing.dirPrefix;
}

/**
 * Discovers workspace `package.json` manifests inside `rootPosix` strictly
 * read-only, bounded to max depth 4 and max 256 manifests, rejecting all
 * symlinks and `node_modules` paths.
 */
export function loadWorkspacePackages(
  rootPosix: string,
  packageFiles?: readonly TsAdapterSourceFile[],
  rootDirOnDisk?: string,
  sourceRelativePaths?: readonly string[],
): LoadedWorkspacePackages {
  void rootPosix;
  const warnings: string[] = [];
  const warningSeen = new Set<string>();
  const addWarning = (message: string): void => {
    if (warnings.length >= MAX_TSCONFIG_WARNINGS) return;
    if (warningSeen.has(message)) return;
    warningSeen.add(message);
    warnings.push(message);
  };

  const sourceDirs = new Set<string>();
  const ancestorDirs = new Set<string>([""]);
  if (sourceRelativePaths !== undefined) {
    const sortedSources = [...sourceRelativePaths].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const rel of sortedSources) {
      const valid = validateRelativeConfigPath(rel);
      if (valid === undefined) continue;
      if (valid.split("/").some((seg) => seg.toLowerCase() === "node_modules")) {
        continue;
      }
      let dir = relativeDirPrefix(valid);
      while (dir.length > 0) {
        sourceDirs.add(canonicalRelKey(dir));
        ancestorDirs.add(dir);
        dir = relativeDirPrefix(dir);
      }
    }
  }

  const rawByCanonRel = new Map<string, RawConfigEntry>();

  if (packageFiles !== undefined) {
    const sortedInputs = [...packageFiles].sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    for (const file of sortedInputs) {
      const validRel = validateRelativeConfigPath(file.relativePath);
      if (validRel === undefined || !isWorkspacePackageJsonPath(validRel)) {
        continue;
      }
      if (utf8Encode(file.content).byteLength > MAX_PACKAGE_JSON_BYTES) {
        addWarning(`package.json exceeds the 256 KB limit: ${validRel}`);
        continue;
      }
      if (rawByCanonRel.size >= MAX_WORKSPACE_MANIFESTS) break;
      const key = canonicalRelKey(validRel);
      if (!rawByCanonRel.has(key)) {
        rawByCanonRel.set(key, { relativePath: validRel, content: file.content });
      }
    }
  } else if (rootDirOnDisk !== undefined) {
    const readDiskJson = createDiskConfigReader(rootDirOnDisk, addWarning);
    if (readDiskJson !== undefined) {
      const candidateDirs = new Set<string>();
      const addCandidateDir = (dirRel: string): void => {
        if (candidateDirs.size >= MAX_WORKSPACE_MANIFESTS) return;
        if (segmentDepth(dirRel) > MAX_WORKSPACE_SCAN_DEPTH) return;
        candidateDirs.add(dirRel);
      };

      const scanner = createConfinedDirScanner(rootDirOnDisk, addWarning);
      const rootContent = readDiskJson("package.json");
      let excludes: readonly string[] = [];
      if (rootContent !== undefined) {
        rawByCanonRel.set(canonicalRelKey("package.json"), {
          relativePath: "package.json",
          content: rootContent,
        });
        const rootParsed = parseSafePackageManifest("package.json", rootContent, addWarning);
        if (rootParsed.rawRecord !== undefined && scanner !== undefined) {
          const patterns = extractRootWorkspacePatterns(rootParsed.rawRecord, addWarning);
          excludes = patterns.excludes;
          for (const pat of patterns.includes) {
            // A full candidate set cannot grow: further patterns would only scan.
            if (candidateDirs.size >= MAX_WORKSPACE_MANIFESTS) break;
            for (const matchedDir of expandWorkspacePatternDirs(pat, scanner, excludes)) {
              addCandidateDir(matchedDir);
            }
          }
        }
      }

      // Ancestor directories of all policy-approved analyzed TS/JS sources.
      const sortedAncestors = [...ancestorDirs].sort((a, b) => {
        const depthDiff = segmentDepth(a) - segmentDepth(b);
        if (depthDiff !== 0) return depthDiff;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const dir of sortedAncestors) {
        if (dir === "") continue;
        if (!isExcludedByWorkspacePatterns(dir, excludes)) {
          addCandidateDir(dir);
        }
      }

      // Bounded BFS fallback scan (max depth 4, max 512 dirs, max 256 manifests).
      if (scanner !== undefined && candidateDirs.size < MAX_WORKSPACE_MANIFESTS) {
        const queue: Array<{ readonly dirRel: string; readonly depth: number }> = [
          { dirRel: "", depth: 0 },
        ];
        const visitedDirs = new Set<string>([""]);
        let dirVisits = 0;
        while (
          queue.length > 0 &&
          dirVisits < MAX_WORKSPACE_DIR_VISITS &&
          candidateDirs.size < MAX_WORKSPACE_MANIFESTS
        ) {
          const current = queue.shift()!;
          dirVisits += 1;
          if (current.depth >= MAX_WORKSPACE_SCAN_DEPTH) continue;
          const children = scanner.listSafeChildDirs(current.dirRel);
          for (const child of children) {
            const nextRel = current.dirRel === "" ? child : `${current.dirRel}/${child}`;
            const nextKey = canonicalRelKey(nextRel);
            if (visitedDirs.has(nextKey)) continue;
            visitedDirs.add(nextKey);
            if (isExcludedByWorkspacePatterns(nextRel, excludes)) continue;
            addCandidateDir(nextRel);
            queue.push({ dirRel: nextRel, depth: current.depth + 1 });
            if (candidateDirs.size >= MAX_WORKSPACE_MANIFESTS) break;
          }
        }
      }

      const sortedCandidateDirs = [...candidateDirs].sort((a, b) => {
        const depthDiff = segmentDepth(a) - segmentDepth(b);
        if (depthDiff !== 0) return depthDiff;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const dir of sortedCandidateDirs) {
        if (rawByCanonRel.size >= MAX_WORKSPACE_MANIFESTS) break;
        const relPath = dir === "" ? "package.json" : `${dir}/package.json`;
        const key = canonicalRelKey(relPath);
        if (rawByCanonRel.has(key)) continue;
        const content = readDiskJson(relPath);
        if (content !== undefined) {
          rawByCanonRel.set(key, { relativePath: relPath, content });
        }
      }
    }
  }

  const packages = new Map<string, WorkspacePackageManifest>();
  const sortedRaw = [...rawByCanonRel.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  for (const raw of sortedRaw) {
    const { manifest } = parseSafePackageManifest(raw.relativePath, raw.content, addWarning);
    if (manifest === undefined) continue;
    const existing = packages.get(manifest.name);
    if (existing === undefined || shouldPreferManifest(manifest, existing, sourceDirs)) {
      packages.set(manifest.name, manifest);
    }
  }

  return { packages, warnings };
}

/**
 * Module-format scope of one workspace `package.json`: TypeScript decides
 * whether a `.ts`/`.tsx`/`.js`/`.jsx` file is ESM or CommonJS under
 * `module: node16/nodenext` from the `"type"` field of the nearest
 * `package.json` (`.mts`/`.cts` force the format by extension).
 */
export interface PackageModuleScope {
  /** Workspace-relative POSIX directory prefix ("" for the workspace root). */
  readonly dirPrefix: string;
  readonly manifestRelativePath: string;
  /** `"module"` or `"commonjs"`; absent when the field is missing or has another value. */
  readonly moduleType?: "module" | "commonjs";
}

/** Deterministic result of `loadPackageModuleScopes`. */
export interface LoadedPackageModuleScopes {
  /** Sorted by `manifestRelativePath`. */
  readonly scopes: readonly PackageModuleScope[];
  readonly warnings: readonly string[];
}

/** Upper bound on ancestor directories probed for a `package.json`. */
const MAX_PACKAGE_SCOPE_DIRS = 4096;

function invalidPackageJsonWarning(relativePath: string): string {
  return `ignored invalid package.json: ${relativePath}`;
}

/**
 * Collects the module-format scopes (`package.json` `"type"`) for every
 * workspace directory that is an ancestor of an analyzed source file — exactly
 * the directories TypeScript walks when it computes a file's
 * `impliedNodeFormat`. Unlike `loadWorkspacePackages`, nameless manifests count
 * (the `"type"` field applies regardless of `"name"`).
 *
 * Read-only and root-confined: in-memory `packageFiles` are used when given;
 * otherwise each ancestor `package.json` is read through the same symlink- and
 * size-guarded disk reader as tsconfig files. `node_modules` paths are skipped
 * (the compiler host already serves those declaration package manifests).
 */
export function loadPackageModuleScopes(
  packageFiles: readonly TsAdapterSourceFile[] | undefined,
  rootDirOnDisk: string | undefined,
  sourceRelativePaths: readonly string[],
): LoadedPackageModuleScopes {
  const warnings: string[] = [];
  const warningSeen = new Set<string>();
  const addWarning = (message: string): void => {
    if (warnings.length >= MAX_TSCONFIG_WARNINGS) return;
    if (warningSeen.has(message)) return;
    warningSeen.add(message);
    warnings.push(message);
  };

  const dirByKey = new Map<string, string>([[canonicalRelKey(""), ""]]);
  for (const rel of sourceRelativePaths) {
    const valid = validateRelativeConfigPath(rel);
    if (valid === undefined) continue;
    if (valid.split("/").some((seg) => seg.toLowerCase() === "node_modules")) continue;
    let dir = relativeDirPrefix(valid);
    while (dir.length > 0) {
      const key = canonicalRelKey(dir);
      if (dirByKey.has(key)) break;
      dirByKey.set(key, dir);
      dir = relativeDirPrefix(dir);
    }
  }
  const sortedDirs = [...dirByKey.values()].sort((a, b) => {
    const depthDiff = segmentDepth(a) - segmentDepth(b);
    if (depthDiff !== 0) return depthDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (sortedDirs.length > MAX_PACKAGE_SCOPE_DIRS) {
    addWarning(
      `package.json module-format lookup limited to ${String(MAX_PACKAGE_SCOPE_DIRS)} of ${String(sortedDirs.length)} source directories; deeper directories inherit the nearest probed scope`,
    );
    sortedDirs.length = MAX_PACKAGE_SCOPE_DIRS;
  }

  let readManifest: ((relativePath: string) => string | undefined) | undefined;
  if (packageFiles !== undefined) {
    const contentByKey = new Map<string, { relativePath: string; content: string }>();
    const sortedInputs = [...packageFiles].sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    for (const file of sortedInputs) {
      const validRel = validateRelativeConfigPath(file.relativePath);
      if (validRel === undefined || !isWorkspacePackageJsonPath(validRel)) continue;
      if (utf8Encode(file.content).byteLength > MAX_PACKAGE_JSON_BYTES) {
        addWarning(`package.json exceeds the 256 KB limit: ${validRel}`);
        continue;
      }
      const key = canonicalRelKey(validRel);
      if (!contentByKey.has(key)) {
        contentByKey.set(key, { relativePath: validRel, content: file.content });
      }
    }
    readManifest = (relativePath) => contentByKey.get(canonicalRelKey(relativePath))?.content;
  } else if (rootDirOnDisk !== undefined) {
    readManifest = createDiskConfigReader(rootDirOnDisk, addWarning);
  }

  const scopes: PackageModuleScope[] = [];
  if (readManifest !== undefined) {
    for (const dir of sortedDirs) {
      const manifestRelativePath = dir === "" ? "package.json" : `${dir}/package.json`;
      const content = readManifest(manifestRelativePath);
      if (content === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        addWarning(invalidPackageJsonWarning(manifestRelativePath));
        continue;
      }
      if (!isPlainRecord(parsed)) continue;
      const rawType = ownProperty(parsed, "type");
      const moduleType =
        rawType === "module" || rawType === "commonjs" ? rawType : undefined;
      scopes.push({
        dirPrefix: dir,
        manifestRelativePath,
        ...(moduleType === undefined ? {} : { moduleType }),
      });
    }
  }
  scopes.sort((a, b) =>
    a.manifestRelativePath < b.manifestRelativePath
      ? -1
      : a.manifestRelativePath > b.manifestRelativePath
        ? 1
        : 0,
  );
  return { scopes, warnings };
}

function parseBarePackageSpecifier(
  moduleName: string,
): { readonly packageName: string; readonly subpath: string } | undefined {
  if (
    moduleName.length === 0 ||
    moduleName.includes("\0") ||
    moduleName.includes("\\") ||
    moduleName.startsWith(".") ||
    moduleName.startsWith("/") ||
    /^[a-zA-Z]:/.test(moduleName)
  ) {
    return undefined;
  }
  const segments = moduleName.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return undefined;
  }
  if (moduleName.startsWith("@")) {
    if (segments.length < 2) return undefined;
    const packageName = `${segments[0]}/${segments[1]}`;
    if (FORBIDDEN_KEYS.has(packageName)) return undefined;
    const subpath = segments.length === 2 ? "." : `./${segments.slice(2).join("/")}`;
    return { packageName, subpath };
  }
  const packageName = segments[0]!;
  if (FORBIDDEN_KEYS.has(packageName)) return undefined;
  const subpath = segments.length === 1 ? "." : `./${segments.slice(1).join("/")}`;
  return { packageName, subpath };
}

function collectExportTargetStrings(
  node: unknown,
  depth: number,
  out: string[],
): void {
  if (depth > MAX_EXPORTS_RECURSION_DEPTH || out.length >= MAX_EXPORTS_CANDIDATES) {
    return;
  }
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed.length > 0 && !trimmed.includes("\0") && !out.includes(trimmed)) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectExportTargetStrings(item, depth + 1, out);
      if (out.length >= MAX_EXPORTS_CANDIDATES) break;
    }
    return;
  }
  if (!isPlainRecord(node)) return;

  const seen = new Set<string>();
  for (const condition of EXPORT_CONDITION_PRIORITY) {
    if (Object.prototype.hasOwnProperty.call(node, condition)) {
      seen.add(condition);
      collectExportTargetStrings(node[condition], depth + 1, out);
    }
  }
  const remaining = Object.getOwnPropertyNames(node)
    .filter((k) => !FORBIDDEN_KEYS.has(k) && !seen.has(k) && !k.startsWith("."))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of remaining) {
    collectExportTargetStrings(node[key], depth + 1, out);
    if (out.length >= MAX_EXPORTS_CANDIDATES) break;
  }
}

function substituteSingleStar(target: string, matched: string): string | undefined {
  const starIdx = target.indexOf("*");
  if (starIdx < 0) return target;
  if (starIdx !== target.lastIndexOf("*")) return undefined;
  if (matched.includes("\0") || matched.split("/").includes("..")) return undefined;
  return `${target.slice(0, starIdx)}${matched}${target.slice(starIdx + 1)}`;
}

function resolvePackageExportsTargets(
  exportsField: unknown,
  subpath: string,
): readonly string[] {
  const targets: string[] = [];
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    if (subpath === ".") {
      collectExportTargetStrings(exportsField, 0, targets);
    }
    return targets;
  }
  if (!isPlainRecord(exportsField)) return targets;

  const keys = Object.getOwnPropertyNames(exportsField).filter(
    (k) => !FORBIDDEN_KEYS.has(k) && Object.prototype.hasOwnProperty.call(exportsField, k),
  );
  const isSubpathMap = keys.some((k) => k.startsWith("."));

  if (!isSubpathMap) {
    if (subpath === ".") {
      collectExportTargetStrings(exportsField, 0, targets);
    }
    return targets;
  }

  // 1) Exact subpath match
  if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
    const exactVal = exportsField[subpath];
    if (exactVal === null) return [];
    collectExportTargetStrings(exactVal, 0, targets);
    return targets;
  }

  // 2) Single-star pattern match ("./*" or "./sub/*.js"), longest prefix first
  const patternMatches: Array<{
    readonly prefixLen: number;
    readonly suffixLen: number;
    readonly key: string;
    readonly matched: string;
    readonly value: unknown;
  }> = [];
  for (const key of keys) {
    if (!key.startsWith(".")) continue;
    const starIdx = key.indexOf("*");
    if (starIdx >= 0) {
      if (starIdx !== key.lastIndexOf("*")) continue;
      const prefix = key.slice(0, starIdx);
      const suffix = key.slice(starIdx + 1);
      if (
        subpath.length >= prefix.length + suffix.length &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix)
      ) {
        const matched = subpath.slice(
          prefix.length,
          suffix.length === 0 ? subpath.length : subpath.length - suffix.length,
        );
        patternMatches.push({
          prefixLen: prefix.length,
          suffixLen: suffix.length,
          key,
          matched,
          value: exportsField[key],
        });
      }
    } else if (key.endsWith("/") && subpath.startsWith(key)) {
      const matched = subpath.slice(key.length);
      patternMatches.push({
        prefixLen: key.length,
        suffixLen: 0,
        key,
        matched,
        value: exportsField[key],
      });
    }
  }
  patternMatches.sort((a, b) => {
    if (b.prefixLen !== a.prefixLen) return b.prefixLen - a.prefixLen;
    if (b.suffixLen !== a.suffixLen) return b.suffixLen - a.suffixLen;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  for (const match of patternMatches) {
    if (match.value === null) return [];
    const rawTargets: string[] = [];
    collectExportTargetStrings(match.value, 0, rawTargets);
    for (const rawTarget of rawTargets) {
      let substituted: string | undefined;
      if (match.key.includes("*")) {
        substituted = substituteSingleStar(rawTarget, match.matched);
      } else if (match.key.endsWith("/") && rawTarget.endsWith("/")) {
        substituted = `${rawTarget}${match.matched}`;
      } else {
        substituted = rawTarget;
      }
      if (substituted !== undefined && !targets.includes(substituted)) {
        targets.push(substituted);
      }
    }
    if (targets.length > 0) break;
  }

  return targets;
}

function expandWorkspaceSourceProbePaths(basePath: string): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string): void => {
    if (!candidates.includes(value)) candidates.push(value);
  };
  const lower = basePath.toLowerCase();
  if (lower.endsWith(".d.ts")) {
    const stem = basePath.slice(0, -5);
    pushUnique(`${stem}.ts`);
    pushUnique(`${stem}.tsx`);
    pushUnique(basePath);
  } else if (lower.endsWith(".d.mts")) {
    const stem = basePath.slice(0, -6);
    pushUnique(`${stem}.mts`);
    pushUnique(`${stem}.ts`);
    pushUnique(basePath);
  } else if (lower.endsWith(".d.cts")) {
    const stem = basePath.slice(0, -6);
    pushUnique(`${stem}.cts`);
    pushUnique(`${stem}.ts`);
    pushUnique(basePath);
  }
  for (const expanded of expandCandidatePaths(basePath)) {
    pushUnique(expanded);
  }
  return candidates;
}

function expandWorkspaceTargetVariants(
  rawTarget: string,
  isRootSubpath: boolean,
): string[] {
  const cleaned = toPosix(rawTarget).replace(/^\.\/+/, "");
  if (cleaned.length === 0 || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) {
    return [];
  }
  const variants: string[] = [cleaned];
  const lower = cleaned.toLowerCase();
  let matchedOutputPrefix = false;
  for (const prefix of WORKSPACE_OUTPUT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      matchedOutputPrefix = true;
      const rest = cleaned.slice(prefix.length);
      if (rest.length > 0) {
        variants.push(`src/${rest}`);
        variants.push(rest);
      }
      break;
    }
  }
  if (isRootSubpath && matchedOutputPrefix) {
    variants.push("src/index", "index");
  }
  return variants;
}

function isWithinPackagePrefix(relativePath: string, dirPrefix: string): boolean {
  if (dirPrefix === "") return true;
  const relKey = canonicalRelKey(relativePath);
  const dirKey = canonicalRelKey(dirPrefix);
  return relKey === dirKey || relKey.startsWith(`${dirKey}/`);
}

function resolveWorkspacePackageModule(params: {
  readonly moduleName: string;
  readonly rootPosix: string;
  readonly rootKeyWithSlash: string;
  readonly workspacePackages: ReadonlyMap<string, WorkspacePackageManifest>;
  readonly entries: ReadonlyMap<
    string,
    { readonly relativePath: string; readonly absolutePath: string }
  >;
}): ts.ResolvedModuleFull | undefined {
  const { moduleName, rootPosix, rootKeyWithSlash, workspacePackages, entries } = params;
  const parsed = parseBarePackageSpecifier(moduleName);
  if (parsed === undefined) return undefined;

  const pkg = workspacePackages.get(parsed.packageName);
  if (pkg === undefined) return undefined;

  const isRootSubpath = parsed.subpath === ".";
  const rawTargets: string[] = [];
  if (pkg.exports !== undefined) {
    rawTargets.push(...resolvePackageExportsTargets(pkg.exports, parsed.subpath));
  } else if (isRootSubpath) {
    for (const field of [pkg.module, pkg.main, pkg.types, pkg.typings]) {
      if (field !== undefined && !rawTargets.includes(field)) {
        rawTargets.push(field);
      }
    }
    rawTargets.push("./src/index", "./index");
  } else {
    const subRest = parsed.subpath.slice(2);
    rawTargets.push(parsed.subpath, `./src/${subRest}`);
  }

  for (const rawTarget of rawTargets) {
    for (const variant of expandWorkspaceTargetVariants(rawTarget, isRootSubpath)) {
      const resolvedRel = resolveRelativeWithinRoot(pkg.dirPrefix, variant);
      if (!resolvedRel.ok) continue;
      if (!isWithinPackagePrefix(resolvedRel.relativePath, pkg.dirPrefix)) continue;
      if (resolvedRel.relativePath.split("/").some((s) => s.toLowerCase() === "node_modules")) {
        continue;
      }
      const candidateBaseAbs = joinPosixAbs(rootPosix, resolvedRel.relativePath);
      const normalizedBase = normalizePosixAbsolute(candidateBaseAbs);
      if (!canonicalKey(normalizedBase).startsWith(rootKeyWithSlash)) continue;

      for (const candidate of expandWorkspaceSourceProbePaths(normalizedBase)) {
        const hit = entries.get(canonicalKey(candidate));
        if (hit !== undefined) {
          if (hit.relativePath.split("/").some((s) => s.toLowerCase() === "node_modules")) {
            continue;
          }
          return {
            resolvedFileName: hit.absolutePath,
            extension: tsExtensionForPath(hit.relativePath),
            isExternalLibraryImport: false,
          };
        }
      }
    }
  }

  return undefined;
}

/** Cached real-path root keys (workspace roots are few; realpath runs once per root). */
const REAL_ROOT_KEY_CACHE = new Map<string, string | undefined>();
const MAX_REAL_ROOT_KEY_CACHE = 64;

/**
 * Returns `<canonical real root>/` when the root's real path differs from the
 * given root key, or `undefined` when it is the same or cannot be determined.
 */
function realRootKeyWithSlashOf(normalizedRoot: string, rootKeyWithSlash: string): string | undefined {
  if (REAL_ROOT_KEY_CACHE.has(normalizedRoot)) return REAL_ROOT_KEY_CACHE.get(normalizedRoot);
  let result: string | undefined;
  try {
    const real = ts.sys?.realpath?.(normalizedRoot);
    if (typeof real === "string" && real.length > 0 && !real.includes("\0")) {
      const realKey = canonicalKey(stripNonRootTrailingSlash(normalizePosixAbsolute(real)));
      const withSlash = realKey.endsWith("/") ? realKey : `${realKey}/`;
      result = withSlash === rootKeyWithSlash ? undefined : withSlash;
    }
  } catch {
    result = undefined;
  }
  if (REAL_ROOT_KEY_CACHE.size >= MAX_REAL_ROOT_KEY_CACHE) REAL_ROOT_KEY_CACHE.clear();
  REAL_ROOT_KEY_CACHE.set(normalizedRoot, result);
  return result;
}

/**
 * Her `containingFile` için en yakın ata `ScopedTsConfig` ile modül çözer;
 * monorepo workspace paket çözümlemesi, Bundler fallback ve bellek-içi alias
 * eşleşmesiyle uzantısız/alias/workspace importlarını deterministik biçimde
 * `verified` olarak çözümler ve kök dışına kaçışı engeller.
 */
export function resolveScopedModuleName(params: {
  readonly moduleName: string;
  readonly containingFile: string;
  readonly rootPosix: string;
  readonly allowedLibDir?: string;
  readonly programOptions: ts.CompilerOptions;
  readonly configs: readonly ScopedTsConfig[];
  readonly workspacePackages?: ReadonlyMap<string, WorkspacePackageManifest>;
  readonly resolutionHost: ts.ModuleResolutionHost;
  readonly entries: ReadonlyMap<
    string,
    { readonly relativePath: string; readonly absolutePath: string }
  >;
  /**
   * Alias fallback work state shared by every resolution of one analysis run
   * (memo + probe budget). Without it each call is still capped per specifier.
   */
  readonly virtualAliasState?: VirtualAliasResolutionState;
}): ts.ResolvedModuleFull | undefined {
  const {
    moduleName,
    containingFile,
    rootPosix,
    allowedLibDir,
    programOptions,
    configs,
    workspacePackages,
    resolutionHost,
    entries,
    virtualAliasState,
  } = params;
  // SEC-10: Null-byte enjeksiyonuna karşı erken red.
  if (moduleName.includes("\0")) return undefined;

  const normalizedRoot = stripNonRootTrailingSlash(normalizePosixAbsolute(rootPosix));
  const normalizedRootWithSlash = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  const rootKey = canonicalKey(normalizedRoot);
  const rootKeyWithSlash = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  const allowedLibKeyWithSlash =
    allowedLibDir === undefined
      ? undefined
      : (() => {
          const libKey = canonicalKey(allowedLibDir);
          return libKey.endsWith("/") ? libKey : `${libKey}/`;
        })();

  // TypeScript realpaths resolved files, so a root given by an alias of its real
  // path (for example a Windows 8.3 short name such as C:\Users\RUNNER~1\...)
  // must also accept files under the real root; otherwise every node_modules
  // import of such a workspace becomes a false TS2307.
  const realRootKeyWithSlash = realRootKeyWithSlashOf(normalizedRoot, rootKeyWithSlash);

  // SEC-03: Çözümlenen dosya mutlaka workspace kökü veya TS lib dizini içinde kalmalıdır.
  const isAllowedResolved = (
    resolved: ts.ResolvedModuleFull | undefined,
  ): ts.ResolvedModuleFull | undefined => {
    if (resolved === undefined) return undefined;
    const resolvedKey = canonicalKey(resolved.resolvedFileName);
    if (resolvedKey.startsWith(rootKeyWithSlash)) return resolved;
    if (realRootKeyWithSlash !== undefined && resolvedKey.startsWith(realRootKeyWithSlash)) {
      return resolved;
    }
    if (
      allowedLibKeyWithSlash !== undefined &&
      resolvedKey.startsWith(allowedLibKeyWithSlash)
    ) {
      return resolved;
    }
    return undefined;
  };

  const normalizedContaining = normalizePosixAbsolute(containingFile);
  const containingKey = canonicalKey(normalizedContaining);
  const containingEntry = entries.get(containingKey);
  const containingRel =
    containingEntry !== undefined
      ? containingEntry.relativePath
      : containingKey.startsWith(rootKeyWithSlash)
        ? normalizedContaining.slice(normalizedRootWithSlash.length)
        : undefined;

  const scopedConfig =
    containingRel !== undefined && configs.length > 0
      ? findScopedTsConfigForFile(configs, containingRel)
      : undefined;
  const scopedOptions = buildScopedResolutionOptions(
    programOptions,
    scopedConfig,
  );

  // Respect explicit tsconfig.json `paths` aliases before workspace package map.
  const hasExplicitTsconfigPathMatch =
    scopedConfig?.paths !== undefined &&
    matchScopedPathPatterns(moduleName, scopedConfig.paths).length > 0;

  if (
    !hasExplicitTsconfigPathMatch &&
    workspacePackages !== undefined &&
    workspacePackages.size > 0
  ) {
    const workspaceResolved = isAllowedResolved(
      resolveWorkspacePackageModule({
        moduleName,
        rootPosix: normalizedRoot,
        rootKeyWithSlash,
        workspacePackages,
        entries,
      }),
    );
    if (workspaceResolved !== undefined) return workspaceResolved;
  }

  const primary = isAllowedResolved(
    ts.resolveModuleName(
      moduleName,
      containingFile,
      scopedOptions,
      resolutionHost,
    ).resolvedModule,
  );
  if (primary !== undefined) return primary;

  if (scopedOptions.moduleResolution !== ts.ModuleResolutionKind.Bundler) {
    const bundlerOptions: ts.CompilerOptions = {
      ...scopedOptions,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const bundlerResolved = isAllowedResolved(
      ts.resolveModuleName(
        moduleName,
        containingFile,
        bundlerOptions,
        resolutionHost,
      ).resolvedModule,
    );
    if (bundlerResolved !== undefined) return bundlerResolved;
  }

  if (scopedConfig !== undefined) {
    const virtualAlias = resolveViaVirtualAlias(
      moduleName,
      scopedConfig,
      entries,
      rootKeyWithSlash,
      virtualAliasState,
    );
    if (virtualAlias !== undefined) return virtualAlias;
  }

  if (
    hasExplicitTsconfigPathMatch &&
    workspacePackages !== undefined &&
    workspacePackages.size > 0
  ) {
    return isAllowedResolved(
      resolveWorkspacePackageModule({
        moduleName,
        rootPosix: normalizedRoot,
        rootKeyWithSlash,
        workspacePackages,
        entries,
      }),
    );
  }

  return undefined;
}
