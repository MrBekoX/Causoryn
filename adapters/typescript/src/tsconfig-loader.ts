import ts from "typescript";

import { utf8Encode } from "@causoryn/domain";

import type { TsAdapterSourceFile } from "./types.js";

/**
 * Salt-okunur, güvenli `tsconfig.json` / `jsconfig.json` yükleyicisi (v0.2.3).
 *
 * Güvenlik sözleşmesi (ADR-008, CWE-59, prototype-pollution koruması):
 * - Birincil kaynak: `input.configFiles` (WorkspaceAccessPolicy'den geçmiş,
 *   bellek-içi, %100 deterministik).
 * - Disk fallback (yalnızca `configFiles === undefined` ve `rootDirOnDisk`
 *   verildiğinde): `lstatSync` ile yol zincirindeki tüm symlink'ler reddedilir,
 *   `realpathSync` ile `rootDirOnDisk` sarmalaması doğrulanır, 256 KB boyut
 *   sınırı okuma öncesi ve sonrası (TOCTOU) uygulanır; hiçbir dosya yazılmaz.
 * - Ayrıştırma yalnızca resmi `ts.parseConfigFileTextToJson` ile yapılır
 *   (JSONC yorumları ve trailing comma destekli; eval / plugin çalıştırma YOK).
 * - Yalnızca güvenli compilerOptions alanları çıkarılır (`baseUrl`, `paths`,
 *   `jsx`, `moduleResolution`, `module`, `target`, `experimentalDecorators`,
 *   `verbatimModuleSyntax`). `__proto__`, `constructor`, `prototype` anahtarları
 *   reddedilir; `paths` Map + null-prototype nesnede tutulur (en fazla 200 girdi).
 * - `extends` zinciri kesinlikle `rootDir` içinde tutulur (en fazla derinlik 5,
 *   döngü tespiti, `..` kaçışı / mutlak yol / çıplak paket zarifçe ayrıştırılır).
 */

export const MAX_TSCONFIG_BYTES = 256 * 1024;
export const MAX_EXTENDS_DEPTH = 5;
export const MAX_PATHS_ENTRIES = 200;
const MAX_PATH_TARGETS_PER_PATTERN = 16;
const MAX_DISK_SCAN_DIRS = 64;

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

interface NodeFsMinimal {
  lstatSync(path: string): {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
  };
  realpathSync(path: string): string;
  readFileSync(path: string, encoding: "utf8"): string;
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
    typeof (mod as Partial<NodeFsMinimal>).readFileSync === "function"
  ) {
    return mod as NodeFsMinimal;
  }
  return undefined;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizePosixAbsolute(p: string): string {
  const posix = toPosix(p);
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

function canonicalKey(p: string): string {
  const normalized = normalizePosixAbsolute(p);
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
  const cleanRoot = rootPosix.replace(/\/+$/, "");
  if (relativePath === "") return cleanRoot === "" ? "/" : cleanRoot;
  return `${cleanRoot}/${relativePath}`;
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
      `tsconfig içinde güvensiz __proto__ anahtarı algılandı ve yoksayıldı: ${contextLabel}`,
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
        `kök dışına çıkan tsconfig baseUrl reddedildi: ${configRelativePath} -> ${rawBaseUrl}`,
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
          `tsconfig paths içinde güvensiz '${key}' anahtarı reddedildi: ${configRelativePath}`,
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
            `tsconfig paths giriş sınırı (${String(MAX_PATHS_ENTRIES)}) aşıldı; kalan girdiler kesildi: ${configRelativePath}`,
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

function sanitizePathsWithinRoot(
  configRelativePath: string,
  rootPosix: string,
  options: PartialSafeOptions,
  addWarning: (msg: string) => void,
): PartialSafeOptions {
  if (options.paths === undefined) return options;
  const effectiveBaseAbs = options.baseUrl ?? options.pathsBasePath ?? rootPosix;
  const cleanRoot = rootPosix.replace(/\/+$/, "");
  const effectiveBaseRel =
    effectiveBaseAbs === cleanRoot
      ? ""
      : effectiveBaseAbs.startsWith(`${cleanRoot}/`)
        ? effectiveBaseAbs.slice(cleanRoot.length + 1)
        : undefined;
  if (effectiveBaseRel === undefined) {
    addWarning(
      `kök dışına çıkan tsconfig paths tabanı reddedildi: ${configRelativePath}`,
    );
    const { paths: _omit, pathsBasePath: _omitBase, ...rest } = options;
    return rest;
  }

  const safePaths = new Map<string, readonly string[]>();
  for (const [pattern, targets] of options.paths.entries()) {
    const safeTargets: string[] = [];
    for (const target of targets) {
      const probe = target.replace(/\*/g, "__wildcard__");
      const check = resolveRelativeWithinRoot(effectiveBaseRel, probe);
      if (!check.ok) {
        addWarning(
          `kök dışına çıkan tsconfig paths hedefi reddedildi: ${configRelativePath} ('${pattern}' -> '${target}')`,
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

function createDiskConfigReader(
  rootDirOnDisk: string,
  addWarning: (msg: string) => void,
): ((relativePath: string) => string | undefined) | undefined {
  const nodeFs = getNodeFs();
  if (nodeFs === undefined) return undefined;

  let rootStat: ReturnType<NodeFsMinimal["lstatSync"]>;
  try {
    rootStat = nodeFs.lstatSync(rootDirOnDisk);
  } catch {
    return undefined;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addWarning(`symlink veya dizin olmayan rootDir için disk tsconfig okuması atlandı`);
    return undefined;
  }

  let realRootPosix: string;
  try {
    realRootPosix = normalizePosixAbsolute(nodeFs.realpathSync(rootDirOnDisk));
  } catch {
    return undefined;
  }
  const realRootKey = canonicalKey(realRootPosix);
  const rootPrefixWithSlash = realRootKey === "/" ? "/" : `${realRootKey}/`;
  const cleanRootNative = toPosix(rootDirOnDisk).replace(/\/+$/, "");

  return (rawRelPath: string): string | undefined => {
    const relPath = validateRelativeConfigPath(rawRelPath);
    if (relPath === undefined) return undefined;

    const segments = relPath.split("/");
    let currentPath = cleanRootNative;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg === undefined) return undefined;
      currentPath = `${currentPath}/${seg}`;
      let stat: ReturnType<NodeFsMinimal["lstatSync"]>;
      try {
        stat = nodeFs.lstatSync(currentPath);
      } catch {
        return undefined;
      }
      if (stat.isSymbolicLink()) {
        addWarning(`symlink tsconfig reddedildi (CWE-59): ${relPath}`);
        return undefined;
      }
      const isLast = i === segments.length - 1;
      if (!isLast) {
        if (!stat.isDirectory()) return undefined;
      } else {
        if (!stat.isFile()) return undefined;
        if (stat.size > MAX_TSCONFIG_BYTES) {
          addWarning(`tsconfig boyutu 256 KB sınırını aşıyor: ${relPath}`);
          return undefined;
        }
      }
    }

    let realTargetPosix: string;
    try {
      realTargetPosix = normalizePosixAbsolute(nodeFs.realpathSync(currentPath));
    } catch {
      return undefined;
    }
    const realTargetKey = canonicalKey(realTargetPosix);
    if (!realTargetKey.startsWith(rootPrefixWithSlash)) {
      addWarning(`kök dışına çıkan tsconfig reddedildi (CWE-59): ${relPath}`);
      return undefined;
    }

    let content: string;
    try {
      content = nodeFs.readFileSync(currentPath, "utf8");
    } catch {
      return undefined;
    }
    if (utf8Encode(content).byteLength > MAX_TSCONFIG_BYTES) {
      addWarning(`tsconfig boyutu okuma sonrası 256 KB sınırını aşıyor: ${relPath}`);
      return undefined;
    }
    return content;
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
  return [...dirs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_DISK_SCAN_DIRS);
}

function segmentDepth(dirPrefix: string): number {
  return dirPrefix === "" ? 0 : dirPrefix.split("/").length;
}

function isTsConfigBasename(relativePath: string): boolean {
  return relativeBasename(relativePath).toLowerCase() === "tsconfig.json";
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
  const normalizedRoot = normalizePosixAbsolute(rootPosix).replace(/\/+$/, "");
  const warnings: string[] = [];
  const warningSeen = new Set<string>();
  const addWarning = (message: string): void => {
    if (warningSeen.has(message)) return;
    warningSeen.add(message);
    warnings.push(message);
  };

  const rawByCanonRel = new Map<string, RawConfigEntry>();
  let readDiskConfigSafe: ((relPath: string) => string | undefined) | undefined;

  if (configFiles !== undefined) {
    // Determinizm: girdi sırasından bağımsız işleme için önce göreli yola göre sırala.
    const sortedInputs = [...configFiles].sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    for (const file of sortedInputs) {
      const validRel = validateRelativeConfigPath(file.relativePath);
      if (validRel === undefined) {
        addWarning(`geçersiz tsconfig yolu yoksayıldı: ${file.relativePath}`);
        continue;
      }
      if (utf8Encode(file.content).byteLength > MAX_TSCONFIG_BYTES) {
        addWarning(`tsconfig boyutu 256 KB sınırını aşıyor: ${validRel}`);
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

  const resolveConfigOptions = (
    entry: RawConfigEntry,
    depth: number,
    visited: ReadonlySet<string>,
  ): PartialSafeOptions | undefined => {
    if (depth > MAX_EXTENDS_DEPTH) {
      addWarning(
        `tsconfig extends derinlik sınırı (${String(MAX_EXTENDS_DEPTH)}) aşıldı: ${entry.relativePath}`,
      );
      return undefined;
    }
    const canonRel = canonicalRelKey(entry.relativePath);
    if (visited.has(canonRel)) {
      addWarning(
        `döngüsel tsconfig extends zinciri algılandı: ${entry.relativePath}`,
      );
      return undefined;
    }

    const parsed = ts.parseConfigFileTextToJson(entry.relativePath, entry.content);
    if (parsed.error !== undefined || !isPlainRecord(parsed.config)) {
      addWarning(`geçersiz tsconfig JSONC yoksayıldı: ${entry.relativePath}`);
      return undefined;
    }
    checkPrototypeInjection(parsed.config, entry.relativePath, addWarning);

    const dirPrefix = relativeDirPrefix(entry.relativePath);
    let accumulated: PartialSafeOptions = {};

    const rawExtends = ownProperty(parsed.config, "extends");
    const extendsList: string[] = [];
    if (typeof rawExtends === "string") {
      extendsList.push(rawExtends);
    } else if (Array.isArray(rawExtends)) {
      for (const item of rawExtends) {
        if (typeof item === "string") extendsList.push(item);
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
            `mutlak/güvensiz tsconfig extends reddedildi: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        if (!isRelativeExtendsSpec(spec)) {
          // Çıplak node_modules paket extends (örn. @tsconfig/node22/...):
          // ağ/dış bağımlılık olmadan zarifçe atlanır, yerel compilerOptions korunur.
          continue;
        }
        const resolved = resolveRelativeWithinRoot(dirPrefix, spec);
        if (!resolved.ok) {
          addWarning(
            `kök dışına çıkan tsconfig extends reddedildi: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        const candidatePaths: string[] = [resolved.relativePath];
        if (!resolved.relativePath.toLowerCase().endsWith(".json")) {
          candidatePaths.push(
            `${resolved.relativePath}.json`,
            `${resolved.relativePath}/tsconfig.json`,
          );
        }
        let parentEntry: RawConfigEntry | undefined;
        for (const candidate of candidatePaths) {
          if (candidate.length === 0) continue;
          parentEntry = getRawConfig(candidate);
          if (parentEntry !== undefined) break;
        }
        if (parentEntry === undefined) {
          addWarning(
            `tsconfig extends hedefi bulunamadı: ${entry.relativePath} -> ${spec}`,
          );
          continue;
        }
        const parentOpts = resolveConfigOptions(
          parentEntry,
          depth + 1,
          nextVisited,
        );
        if (parentOpts !== undefined) {
          accumulated = mergeSafeOptions(accumulated, parentOpts);
        }
      }
    }

    const ownOpts = extractSafeCompilerOptions(
      entry.relativePath,
      dirPrefix,
      normalizedRoot,
      ownProperty(parsed.config, "compilerOptions"),
      addWarning,
    );
    return mergeSafeOptions(accumulated, ownOpts);
  };

  const activeEntries = [...rawByCanonRel.values()]
    .filter((entry) => isActiveProjectConfigFile(entry.relativePath))
    .sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );

  const scopedConfigs: ScopedTsConfig[] = [];
  for (const entry of activeEntries) {
    const rawResolved = resolveConfigOptions(entry, 0, new Set<string>());
    if (rawResolved === undefined) continue;
    const resolved = sanitizePathsWithinRoot(
      entry.relativePath,
      normalizedRoot,
      rawResolved,
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

/** Program düzeyi `ts.CompilerOptions` nesnesini yüklenen kök config'ten üretir. */
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
  if (rootConfig?.experimentalDecorators !== undefined) {
    options.experimentalDecorators = rootConfig.experimentalDecorators;
  }
  if (rootConfig?.verbatimModuleSyntax !== undefined) {
    options.verbatimModuleSyntax = rootConfig.verbatimModuleSyntax;
  }

  return options;
}

/** Verilen `containingFile` kapsamı için izole `ts.CompilerOptions` üretir. */
export function buildScopedResolutionOptions(
  programOptions: ts.CompilerOptions,
  scopedConfig: ScopedTsConfig | undefined,
): ts.CompilerOptions {
  if (scopedConfig === undefined) return programOptions;

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
  if (basePath.endsWith(".js")) {
    const stem = basePath.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`, `${stem}.mjs`, `${stem}.cjs`);
  } else if (basePath.endsWith(".jsx")) {
    const stem = basePath.slice(0, -4);
    candidates.push(`${stem}.tsx`, `${stem}.ts`, `${stem}.js`);
  } else if (basePath.endsWith(".mjs")) {
    const stem = basePath.slice(0, -4);
    candidates.push(`${stem}.mts`, `${stem}.ts`, `${stem}.js`);
  } else if (basePath.endsWith(".cjs")) {
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

function resolveViaVirtualAlias(
  moduleName: string,
  scopedConfig: ScopedTsConfig,
  entries: ReadonlyMap<string, { readonly relativePath: string; readonly absolutePath: string }>,
  rootKeyWithSlash: string,
): ts.ResolvedModuleFull | undefined {
  if (moduleName.includes("\0")) return undefined;

  if (scopedConfig.paths !== undefined) {
    const baseDir = scopedConfig.baseUrl ?? scopedConfig.pathsBasePath;
    if (baseDir !== undefined) {
      for (const match of matchScopedPathPatterns(moduleName, scopedConfig.paths)) {
        for (const rawTarget of match.targets) {
          const substituted = rawTarget.includes("*")
            ? rawTarget.replace("*", match.matchedStar)
            : rawTarget;
          const targetPosix = toPosix(substituted);
          if (targetPosix.startsWith("/") || /^[a-zA-Z]:/.test(targetPosix)) {
            continue;
          }
          const resolved = probeEntryInMemory(
            `${baseDir}/${targetPosix}`,
            rootKeyWithSlash,
            entries,
          );
          if (resolved !== undefined) return resolved;
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
    return probeEntryInMemory(
      `${scopedConfig.baseUrl}/${toPosix(moduleName)}`,
      rootKeyWithSlash,
      entries,
    );
  }

  return undefined;
}

/**
 * Her `containingFile` için en yakın ata `ScopedTsConfig` ile modül çözer;
 * Bundler fallback ve bellek-içi alias eşleşmesiyle uzantısız/alias importları
 * deterministik biçimde `verified` olarak çözümler.
 */
export function resolveScopedModuleName(params: {
  readonly moduleName: string;
  readonly containingFile: string;
  readonly rootPosix: string;
  readonly programOptions: ts.CompilerOptions;
  readonly configs: readonly ScopedTsConfig[];
  readonly resolutionHost: ts.ModuleResolutionHost;
  readonly entries: ReadonlyMap<
    string,
    { readonly relativePath: string; readonly absolutePath: string }
  >;
}): ts.ResolvedModuleFull | undefined {
  const {
    moduleName,
    containingFile,
    rootPosix,
    programOptions,
    configs,
    resolutionHost,
    entries,
  } = params;
  const rootKey = canonicalKey(rootPosix);
  const rootKeyWithSlash = rootKey === "/" ? "/" : `${rootKey}/`;
  const containingKey = canonicalKey(containingFile);
  const containingEntry = entries.get(containingKey);
  const containingRel =
    containingEntry !== undefined
      ? containingEntry.relativePath
      : containingKey.startsWith(rootKeyWithSlash)
        ? normalizePosixAbsolute(containingFile).slice(rootPosix.length + 1)
        : undefined;

  const scopedConfig =
    containingRel !== undefined && configs.length > 0
      ? findScopedTsConfigForFile(configs, containingRel)
      : undefined;
  const scopedOptions = buildScopedResolutionOptions(
    programOptions,
    scopedConfig,
  );

  const primary = ts.resolveModuleName(
    moduleName,
    containingFile,
    scopedOptions,
    resolutionHost,
  ).resolvedModule;
  if (primary !== undefined) return primary;

  if (scopedOptions.moduleResolution !== ts.ModuleResolutionKind.Bundler) {
    const bundlerOptions: ts.CompilerOptions = {
      ...scopedOptions,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const bundlerResolved = ts.resolveModuleName(
      moduleName,
      containingFile,
      bundlerOptions,
      resolutionHost,
    ).resolvedModule;
    if (bundlerResolved !== undefined) return bundlerResolved;
  }

  if (scopedConfig !== undefined) {
    return resolveViaVirtualAlias(
      moduleName,
      scopedConfig,
      entries,
      rootKeyWithSlash,
    );
  }

  return undefined;
}
