/**
 * MSBuild project model for the Roslyn worker: which SDK-style project owns
 * each C# source file, which `global using` directives the .NET SDK generates
 * for that project, and its ProjectReference edges.
 *
 * Sources of truth for the SDK behavior that is modeled here:
 * - Implicit global usings per SDK: Microsoft Learn, ".NET project SDKs —
 *   Implicit using directives",
 *   https://learn.microsoft.com/dotnet/core/project-sdk/overview#implicit-using-directives
 * - `System.Net.Http` is not added for .NET Framework target frameworks
 *   (.NET 8 SDK and later): Microsoft Learn,
 *   https://learn.microsoft.com/dotnet/core/compatibility/sdk/8.0/implicit-global-using-netfx
 * - `ImplicitUsings` values (`true`/`enable`) and the `Using` item with its
 *   `Alias`/`Static` metadata: Microsoft Learn, "MSBuild reference for .NET SDK
 *   projects", https://learn.microsoft.com/dotnet/core/project-sdk/msbuild-props#implicitusings
 *   and https://learn.microsoft.com/dotnet/core/project-sdk/msbuild-props#using
 *
 * Evaluation order mirrors MSBuild: `Directory.Build.props` is imported before
 * the SDK props (so its `Using Remove` cannot remove SDK defaults), the SDK's
 * implicit `Using` items come next, then the project file body. Properties are
 * last-definition-wins with case-insensitive names and values, exactly like the
 * SDK's `'$(ImplicitUsings)' == 'enable'` conditions.
 *
 * Safety: every read is strictly read-only, bounded, symlink-free and inside the
 * workspace root (safe-fs.ts). `Directory.Build.props` is searched from the
 * project directory up to the workspace root and never above it. MSBuild
 * conditions (other than a simple comparison of a modeled property), property
 * functions, `<Choose>` blocks and `<Import>`ed files are not evaluated; when
 * they touch a modeled setting an explicit warning says so.
 *
 * Determinism: source paths, projects and directives are processed in ordinal
 * order; warnings are emitted in that order.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, posix as pathPosix } from "node:path";
import { MsbuildXmlError, parseMsbuildXml, type XmlElement } from "./msbuild-xml.js";
import {
  isInsideRealDir,
  isLinkFreeBelow,
  isSamePath,
  readBoundedFileNoFollow,
  resolveSafeRealRoot,
} from "./safe-fs.js";
import {
  MAX_CSHARP_PROJECTS,
  MAX_GLOBAL_USINGS_PER_PROJECT,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_REFERENCES_PER_PROJECT,
  type CSharpGlobalUsing,
  type CSharpProjectDiscoveryResult,
  type CSharpProjectSpec,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* SDK default namespaces (Microsoft Learn table, see header)          */
/* ------------------------------------------------------------------ */

/** Microsoft.NET.Sdk. */
const SDK_BASE_USINGS: readonly string[] = [
  "System",
  "System.Collections.Generic",
  "System.IO",
  "System.Linq",
  "System.Net.Http",
  "System.Threading",
  "System.Threading.Tasks",
];

/** Microsoft.NET.Sdk.Web: Microsoft.NET.Sdk namespaces plus these. */
const SDK_WEB_USINGS: readonly string[] = [
  "System.Net.Http.Json",
  "Microsoft.AspNetCore.Builder",
  "Microsoft.AspNetCore.Hosting",
  "Microsoft.AspNetCore.Http",
  "Microsoft.AspNetCore.Routing",
  "Microsoft.Extensions.Configuration",
  "Microsoft.Extensions.DependencyInjection",
  "Microsoft.Extensions.Hosting",
  "Microsoft.Extensions.Logging",
];

/** Microsoft.NET.Sdk.Worker: Microsoft.NET.Sdk namespaces plus these. */
const SDK_WORKER_USINGS: readonly string[] = [
  "Microsoft.Extensions.Configuration",
  "Microsoft.Extensions.DependencyInjection",
  "Microsoft.Extensions.Hosting",
  "Microsoft.Extensions.Logging",
];

/** Windows Forms (`UseWindowsForms`): Microsoft.NET.Sdk namespaces plus these. */
const WINDOWS_FORMS_USINGS: readonly string[] = ["System.Drawing", "System.Windows.Forms"];

/** WPF (`UseWPF`): Microsoft.NET.Sdk namespaces without these. */
const WPF_REMOVED_USINGS: readonly string[] = ["System.IO", "System.Net.Http"];

type SdkFamily = "base" | "web" | "worker" | "windowsdesktop";

const MODELED_SDKS: ReadonlyMap<string, SdkFamily> = new Map([
  ["microsoft.net.sdk", "base"],
  ["microsoft.net.sdk.web", "web"],
  ["microsoft.net.sdk.worker", "worker"],
  ["microsoft.net.sdk.windowsdesktop", "windowsdesktop"],
]);

/* ------------------------------------------------------------------ */
/* Limits and patterns                                                 */
/* ------------------------------------------------------------------ */

const PROJECT_EXTENSION = ".csproj";
const DIRECTORY_BUILD_PROPS = "Directory.Build.props";
const MAX_DIRECTORY_PROBES = 20_000;
const MAX_DOTTED_NAME_LENGTH = 512;

/** Same identifier rule as the worker (ProjectModel.cs IdentifierPattern). */
const IDENTIFIER_PATTERN = /^@?[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*$/u;
/** Same assembly name rule as the worker (ProjectModel.cs AssemblyNamePattern). */
const ASSEMBLY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/;
/** `'$(Name)' == 'value'` / `!=`: the only MSBuild condition shape that is evaluated. */
const SIMPLE_CONDITION_PATTERN = /^'\$\(([A-Za-z_][A-Za-z0-9_]*)\)'\s*(==|!=)\s*'([^'$@%]*)'$/;

/** Properties this model reads (MSBuild names are case-insensitive). */
const MODELED_PROPERTIES: ReadonlySet<string> = new Set([
  "implicitusings",
  "usewpf",
  "usewindowsforms",
  "targetframework",
  "targetframeworks",
  "assemblyname",
]);

/** Properties whose value may be compared by SIMPLE_CONDITION_PATTERN. */
const CONDITION_PROPERTIES: ReadonlySet<string> = new Set([
  "implicitusings",
  "usewpf",
  "usewindowsforms",
  "assemblyname",
]);

const SETTING_ELEMENTS: ReadonlySet<string> = new Set([
  "implicitusings",
  "usewpf",
  "usewindowsforms",
  "using",
]);

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

function attribute(element: XmlElement, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of element.attributes) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  return element.children.filter((child) => child.name.toLowerCase() === wanted);
}

function conditionOf(element: XmlElement): string | null {
  const raw = attribute(element, "Condition");
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const MAX_SNIPPET_CHARS = 160;

/** Project-file text quoted in a warning: control characters flattened, length capped. */
function snippet(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS)}...` : flat;
}

function isUnevaluated(value: string): boolean {
  return value.includes("$(") || value.includes("@(") || value.includes("%(");
}

function splitItemList(value: string): string[] {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function containsSettingElement(element: XmlElement, depth = 0): string | null {
  if (depth > 64) return null;
  for (const child of element.children) {
    const name = child.name.toLowerCase();
    if (SETTING_ELEMENTS.has(name)) return child.name;
    const nested = containsSettingElement(child, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* MSBuild evaluation (properties + Using / ProjectReference items)    */
/* ------------------------------------------------------------------ */

type UsingOperation =
  | { readonly kind: "include"; readonly specs: readonly string[]; readonly alias: string | undefined; readonly isStatic: boolean; readonly source: string }
  | { readonly kind: "remove"; readonly specs: readonly string[] };

interface ParsedFile {
  readonly relativePath: string;
  readonly root: XmlElement;
}

/**
 * true/false for a `'$(P)' == 'v'` condition on a modeled property, null when the
 * condition is outside the evaluated subset. MSBuild compares case-insensitively.
 */
function evaluateCondition(condition: string, properties: ReadonlyMap<string, string>): boolean | null {
  const match = SIMPLE_CONDITION_PATTERN.exec(condition);
  if (match === null) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!CONDITION_PROPERTIES.has(name)) return null;
  const current = (properties.get(name) ?? "").trim().toLowerCase();
  const expected = (match[3] ?? "").trim().toLowerCase();
  return match[2] === "==" ? current === expected : current !== expected;
}

function evaluateProperties(
  file: ParsedFile,
  label: string,
  properties: Map<string, string>,
  warnings: string[],
): void {
  for (const group of childrenNamed(file.root, "PropertyGroup")) {
    const groupCondition = conditionOf(group);
    for (const property of group.children) {
      const name = property.name.toLowerCase();
      if (!MODELED_PROPERTIES.has(name)) continue;
      const elementCondition = conditionOf(property);
      const conditions = [groupCondition, elementCondition].filter((c): c is string => c !== null);
      let applies = true;
      for (const condition of conditions) {
        const result = evaluateCondition(condition, properties);
        if (result === null) {
          warnings.push(
            `${label}: <${property.name}> in ${file.relativePath} is set under a condition that is not evaluated (${snippet(condition)}); the setting was ignored`,
          );
          applies = false;
          break;
        }
        if (!result) {
          applies = false;
          break;
        }
      }
      if (!applies) continue;
      const value = property.text.trim();
      if (isUnevaluated(value)) {
        warnings.push(
          `${label}: <${property.name}> in ${file.relativePath} uses an MSBuild expression that is not evaluated (${snippet(value)}); the setting was ignored`,
        );
        continue;
      }
      properties.set(name, value);
    }
  }
}

interface FileItems {
  readonly usingOperations: readonly UsingOperation[];
  readonly projectReferences: readonly string[];
}

function metadataValue(
  item: XmlElement,
  name: string,
  file: ParsedFile,
  label: string,
  warnings: string[],
): { readonly value: string | undefined; readonly ok: boolean } {
  const fromAttribute = attribute(item, name);
  if (fromAttribute !== undefined) return { value: fromAttribute, ok: true };
  const child = childrenNamed(item, name)[0];
  if (child === undefined) return { value: undefined, ok: true };
  if (conditionOf(child) !== null) {
    warnings.push(
      `${label}: <${name}> metadata of a Using item in ${file.relativePath} is conditional and not evaluated; the item was skipped`,
    );
    return { value: undefined, ok: false };
  }
  return { value: child.text, ok: true };
}

function collectItems(file: ParsedFile, label: string, warnings: string[]): FileItems {
  const usingOperations: UsingOperation[] = [];
  const projectReferences: string[] = [];
  for (const group of childrenNamed(file.root, "ItemGroup")) {
    const groupCondition = conditionOf(group);
    for (const item of group.children) {
      const kind = item.name.toLowerCase();
      if (kind === "projectreference") {
        // Conditional references are kept: a wider reference set only widens
        // symbol resolution, it never invents a symbol.
        const include = attribute(item, "Include");
        if (include === undefined) continue;
        for (const spec of splitItemList(include)) {
          if (isUnevaluated(spec) || spec.includes("*") || spec.includes("?")) {
            warnings.push(
              `${label}: ProjectReference '${snippet(spec)}' in ${file.relativePath} uses an MSBuild expression or wildcard that is not evaluated; skipped`,
            );
            continue;
          }
          projectReferences.push(spec);
        }
        continue;
      }
      if (kind !== "using") continue;

      const condition = groupCondition ?? conditionOf(item);
      if (condition !== null) {
        warnings.push(
          `${label}: a Using item in ${file.relativePath} is conditional (${snippet(condition)}) and not evaluated; the item was skipped`,
        );
        continue;
      }
      if (attribute(item, "Update") !== undefined) {
        warnings.push(`${label}: Using Update items are not modeled (${file.relativePath}); the item was skipped`);
        continue;
      }
      const include = attribute(item, "Include");
      const remove = attribute(item, "Remove");
      const raw = include ?? remove;
      if (raw === undefined) continue;
      const specs = splitItemList(raw);
      if (specs.some(isUnevaluated)) {
        warnings.push(
          `${label}: a Using item in ${file.relativePath} uses an MSBuild expression that is not evaluated (${snippet(raw)}); the item was skipped`,
        );
        continue;
      }
      if (include === undefined) {
        usingOperations.push({ kind: "remove", specs });
        continue;
      }
      const alias = metadataValue(item, "Alias", file, label, warnings);
      const isStatic = metadataValue(item, "Static", file, label, warnings);
      if (!alias.ok || !isStatic.ok) continue;
      const aliasText = alias.value?.trim();
      usingOperations.push({
        kind: "include",
        specs,
        alias: aliasText === undefined || aliasText.length === 0 ? undefined : aliasText,
        isStatic: (isStatic.value ?? "").trim().toLowerCase() === "true",
        source: file.relativePath,
      });
    }
  }

  for (const choose of childrenNamed(file.root, "Choose")) {
    const setting = containsSettingElement(choose);
    if (setting !== null) {
      warnings.push(
        `${label}: a <Choose> block in ${file.relativePath} contains <${setting}>; conditional blocks are not evaluated and the setting was ignored`,
      );
      break;
    }
  }
  return { usingOperations, projectReferences };
}

function projectSdks(root: XmlElement): string[] {
  const names: string[] = [];
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
    for (const part of raw.split(";")) {
      const name = (part.split("/")[0] ?? "").trim();
      if (name.length > 0 && !names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
        names.push(name);
      }
    }
  };
  add(attribute(root, "Sdk"));
  for (const sdk of childrenNamed(root, "Sdk")) add(attribute(sdk, "Name"));
  for (const imported of childrenNamed(root, "Import")) add(attribute(imported, "Sdk"));
  return names;
}

function hasPlainImports(root: XmlElement): boolean {
  return childrenNamed(root, "Import").some((element) => attribute(element, "Sdk") === undefined);
}

/* ------------------------------------------------------------------ */
/* Target framework (only `System.Net.Http` depends on it)             */
/* ------------------------------------------------------------------ */

function frameworkScore(tfm: string): readonly [number, number] {
  const base = (tfm.split("-")[0] ?? "").toLowerCase();
  const modern = /^net(\d+)\.(\d+)$/.exec(base);
  if (modern !== null) return [3, Number(modern[1]) * 100 + Number(modern[2])];
  const core = /^netcoreapp(\d+)\.(\d+)$/.exec(base);
  if (core !== null) return [2, Number(core[1]) * 100 + Number(core[2])];
  const standard = /^netstandard(\d+)\.(\d+)$/.exec(base);
  if (standard !== null) return [1, Number(standard[1]) * 100 + Number(standard[2])];
  return [0, 0];
}

function preferredTargetFramework(properties: ReadonlyMap<string, string>): string | undefined {
  const single = properties.get("targetframework")?.trim();
  if (single !== undefined && single.length > 0) return single;
  const multi = splitItemList(properties.get("targetframeworks") ?? "");
  if (multi.length === 0) return undefined;
  return [...multi].sort((a, b) => {
    const [ka, va] = frameworkScore(a);
    const [kb, vb] = frameworkScore(b);
    if (kb !== ka) return kb - ka;
    if (vb !== va) return vb - va;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

/** `TargetFrameworkIdentifier == .NETFramework`: net20 ... net481 (no dot in the version). */
function isNetFrameworkTarget(tfm: string | undefined): boolean {
  if (tfm === undefined) return false;
  return /^net[1-4]\d{1,2}$/i.test(tfm.split("-")[0] ?? "");
}

/* ------------------------------------------------------------------ */
/* Global using list                                                   */
/* ------------------------------------------------------------------ */

/** A UTF-16 surrogate code unit (half of a character outside the Basic Multilingual Plane). */
const SURROGATE_CODE_UNIT = /[\uD800-\uDFFF]/;

/**
 * One C# identifier exactly as the worker accepts it (security finding F22,
 * round 2). The worker's .NET pattern classifies UTF-16 code units, and C#
 * (Roslyn) does too: a letter outside the BMP such as U+1D49C is a surrogate
 * pair (category Cs), no identifier character (CS1056). The `/u` pattern here
 * classifies code points and would accept it, so surrogates are refused first.
 */
function isWorkerIdentifier(value: string): boolean {
  return !SURROGATE_CODE_UNIT.test(value) && IDENTIFIER_PATTERN.test(value);
}

function isDottedName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_DOTTED_NAME_LENGTH) return false;
  return name.split(".").every((segment) => isWorkerIdentifier(segment));
}

/** `source` of the SDK's implicit Using items (also quoted in warnings). */
const SDK_DEFAULTS_SOURCE = "the .NET SDK defaults";

/**
 * At most MAX_GLOBAL_USINGS_PER_PROJECT directives (security finding F22): the
 * worker rejects a whole request when one project has more, which would drop
 * every C# file of the workspace to file-level facts. The SDK defaults are kept
 * first, then the other items in evaluation order; the rest is dropped with a
 * warning, so the project stays analyzable.
 */
function keepWithinGlobalUsingLimit(
  directives: readonly CSharpGlobalUsing[],
  sdkDefaults: ReadonlySet<CSharpGlobalUsing>,
  label: string,
  warnings: string[],
): CSharpGlobalUsing[] {
  if (directives.length <= MAX_GLOBAL_USINGS_PER_PROJECT) return [...directives];
  const prioritized = [
    ...directives.filter((directive) => sdkDefaults.has(directive)),
    ...directives.filter((directive) => !sdkDefaults.has(directive)),
  ];
  const dropped = directives.length - MAX_GLOBAL_USINGS_PER_PROJECT;
  warnings.push(
    `${label}: ${String(directives.length)} global usings exceed the limit of ${String(MAX_GLOBAL_USINGS_PER_PROJECT)} per project; ${String(dropped)} Using items were dropped (${SDK_DEFAULTS_SOURCE} and the first items in evaluation order were kept)`,
  );
  return prioritized.slice(0, MAX_GLOBAL_USINGS_PER_PROJECT);
}

function finalizeUsings(
  operations: readonly UsingOperation[],
  label: string,
  warnings: string[],
): CSharpGlobalUsing[] {
  let items: Array<{ readonly name: string; readonly alias: string | undefined; readonly isStatic: boolean; readonly source: string }> = [];
  for (const operation of operations) {
    if (operation.kind === "remove") {
      const removed = new Set(operation.specs.map((spec) => spec.toLowerCase()));
      items = items.filter((item) => !removed.has(item.name.toLowerCase()));
      continue;
    }
    for (const spec of operation.specs) {
      items.push({ name: spec, alias: operation.alias, isStatic: operation.isStatic, source: operation.source });
    }
  }

  const seen = new Set<string>();
  const result: CSharpGlobalUsing[] = [];
  const sdkDefaults = new Set<CSharpGlobalUsing>();
  for (const item of items) {
    if (!isDottedName(item.name)) {
      warnings.push(`${label}: Using item '${snippet(item.name)}' in ${item.source} is not a dotted C# name; skipped`);
      continue;
    }
    if (item.alias !== undefined && !isWorkerIdentifier(item.alias)) {
      warnings.push(`${label}: Using item '${snippet(item.name)}' in ${item.source} has an alias that is not a C# identifier (${snippet(item.alias)}); skipped`);
      continue;
    }
    if (item.alias !== undefined && item.isStatic) {
      warnings.push(`${label}: Using item '${item.name}' in ${item.source} is both static and aliased, which the .NET SDK rejects; skipped`);
      continue;
    }
    const key = `${item.name}\u0000${item.alias ?? ""}\u0000${item.isStatic ? "1" : "0"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const directive: CSharpGlobalUsing = {
      name: item.name,
      ...(item.alias !== undefined ? { alias: item.alias } : {}),
      ...(item.isStatic ? { static: true } : {}),
    };
    if (item.source === SDK_DEFAULTS_SOURCE) sdkDefaults.add(directive);
    result.push(directive);
  }

  const kept = keepWithinGlobalUsingLimit(result, sdkDefaults, label, warnings);
  const rank = (u: CSharpGlobalUsing): number => (u.alias !== undefined ? 2 : u.static === true ? 1 : 0);
  return kept.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const aliasA = a.alias ?? "";
    const aliasB = b.alias ?? "";
    return aliasA < aliasB ? -1 : aliasA > aliasB ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ */
/* File discovery (read-only, inside the workspace root)               */
/* ------------------------------------------------------------------ */

function absoluteOf(realRoot: string, relativePosix: string): string {
  return relativePosix.length === 0 ? realRoot : join(realRoot, ...relativePosix.split("/"));
}

/**
 * A real directory under the root reached without any symbolic link: the leaf
 * is no link, and its real path equals the lexical path below the real root,
 * so no intermediate component is a link either.
 */
function isSafeDirectory(realRoot: string, relativeDir: string): boolean {
  const absolute = absoluteOf(realRoot, relativeDir);
  // Every component is inspected without following links before realpath runs.
  if (!isLinkFreeBelow(realRoot, absolute, "directory")) return false;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const real = realpathSync(absolute);
    return isInsideRealDir(realRoot, real) && isSamePath(real, absolute);
  } catch {
    return false;
  }
}

/** `missing` when nothing is there; `unsafe` for a link or a non-regular file. */
function regularFileState(absolute: string): "file" | "missing" | "unsafe" {
  try {
    const stat = lstatSync(absolute);
    return !stat.isSymbolicLink() && stat.isFile() ? "file" : "unsafe";
  } catch {
    return "missing";
  }
}

function isRegularFile(absolute: string): boolean {
  try {
    const stat = lstatSync(absolute);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

function readProjectFile(
  realRoot: string,
  relativePath: string,
  label: string,
  warnings: string[],
): ParsedFile | null {
  const content = readBoundedFileNoFollow(absoluteOf(realRoot, relativePath), realRoot, MAX_PROJECT_FILE_BYTES);
  if (content === null) {
    warnings.push(
      `${label}: ${relativePath} could not be read safely (missing, a symbolic link, outside the workspace or larger than ${String(MAX_PROJECT_FILE_BYTES)} bytes); its settings were not modeled`,
    );
    return null;
  }
  try {
    return { relativePath, root: parseMsbuildXml(content) };
  } catch (error) {
    const reason = error instanceof MsbuildXmlError ? error.message : "unexpected parse failure";
    warnings.push(`${label}: ${relativePath} is not valid MSBuild XML (${reason}); its settings were not modeled`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Builds the worker `projects` model for the given workspace-relative C# source
 * paths. Returns no projects (single shared compilation, the historical
 * behavior) when the root is unusable or no source lies under a `.csproj`.
 */
export function resolveCSharpProjects(
  rootDir: string,
  sourcePaths: readonly string[],
): CSharpProjectDiscoveryResult {
  const warnings: string[] = [];
  const realRoot = resolveSafeRealRoot(rootDir);
  if (realRoot === null || sourcePaths.length === 0) {
    return { projects: [], warnings };
  }

  // 1) Owning project of every source: nearest ancestor directory that holds a .csproj.
  const projectInDirectory = new Map<string, string | null>();
  let probes = 0;
  let probeLimitReported = false;
  const projectFileIn = (relativeDir: string): string | null => {
    const cached = projectInDirectory.get(relativeDir);
    if (cached !== undefined) return cached;
    if (probes >= MAX_DIRECTORY_PROBES) {
      if (!probeLimitReported) {
        probeLimitReported = true;
        warnings.push(
          `C# project discovery stopped after ${String(MAX_DIRECTORY_PROBES)} directories; remaining sources were analyzed without a project model`,
        );
      }
      return null;
    }
    probes += 1;
    let found: string | null = null;
    if (isSafeDirectory(realRoot, relativeDir)) {
      let names: string[] = [];
      try {
        names = readdirSync(absoluteOf(realRoot, relativeDir));
      } catch {
        names = [];
      }
      const candidates = names
        .filter(
          (name) =>
            name.length > PROJECT_EXTENSION.length &&
            name.toLowerCase().endsWith(PROJECT_EXTENSION) &&
            isRegularFile(join(absoluteOf(realRoot, relativeDir), name)),
        )
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const first = candidates[0];
      if (first !== undefined) {
        found = relativeDir.length === 0 ? first : `${relativeDir}/${first}`;
        if (candidates.length > 1) {
          warnings.push(
            `C# project discovery: '${relativeDir.length === 0 ? "." : snippet(relativeDir)}' contains ${String(candidates.length)} project files; '${snippet(first)}' owns its sources and the others were ignored`,
          );
        }
      }
    }
    projectInDirectory.set(relativeDir, found);
    return found;
  };

  const owned = new Set<string>();
  for (const sourcePath of [...sourcePaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    let directory = pathPosix.dirname(sourcePath);
    for (;;) {
      const relativeDir = directory === "." ? "" : directory;
      const project = projectFileIn(relativeDir);
      if (project !== null) {
        owned.add(project);
        break;
      }
      if (relativeDir.length === 0) break;
      directory = pathPosix.dirname(directory);
    }
  }

  let projectPaths = [...owned].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (projectPaths.length > MAX_CSHARP_PROJECTS) {
    warnings.push(
      `C# project discovery found ${String(projectPaths.length)} projects; only the first ${String(MAX_CSHARP_PROJECTS)} are modeled`,
    );
    projectPaths = projectPaths.slice(0, MAX_CSHARP_PROJECTS);
  }
  const ownedPaths = new Set(projectPaths);
  // Case-insensitive fallback (Windows-authored references) only when unambiguous.
  const ownedByLowerPath = new Map<string, string | null>();
  for (const path of projectPaths) {
    const key = path.toLowerCase();
    ownedByLowerPath.set(key, ownedByLowerPath.has(key) ? null : path);
  }
  const resolveOwned = (candidate: string): string | undefined =>
    ownedPaths.has(candidate) ? candidate : (ownedByLowerPath.get(candidate.toLowerCase()) ?? undefined);

  // 2) Evaluate every owning project.
  const parsedProps = new Map<string, ParsedFile | null>();
  const projects: CSharpProjectSpec[] = [];
  for (const projectPath of projectPaths) {
    const label = `C# project '${projectPath}'`;
    const projectDir = pathPosix.dirname(projectPath);
    const parsedProject = readProjectFile(realRoot, projectPath, label, warnings);
    if (parsedProject === null) {
      projects.push({ path: projectPath, globalUsings: [], projectReferences: [] });
      continue;
    }

    // Nearest Directory.Build.props between the project directory and the root
    // (inclusive). MSBuild stops at the nearest one, so an unsafe nearest file
    // (a link, a directory, an unsafe parent) stops the search with a warning
    // instead of silently falling back to a farther ancestor's props.
    let propsFile: ParsedFile | null = null;
    let cursor = projectDir;
    for (;;) {
      const relativeDir = cursor === "." ? "" : cursor;
      const candidate = relativeDir.length === 0 ? DIRECTORY_BUILD_PROPS : `${relativeDir}/${DIRECTORY_BUILD_PROPS}`;
      const state = regularFileState(absoluteOf(realRoot, candidate));
      if (state !== "missing") {
        if (state === "unsafe" || !isSafeDirectory(realRoot, relativeDir)) {
          warnings.push(
            `${label}: ${candidate} is not a regular file reached without symbolic links; it was not read and its settings were not modeled`,
          );
          break;
        }
        if (!parsedProps.has(candidate)) {
          parsedProps.set(candidate, readProjectFile(realRoot, candidate, `C# props '${candidate}'`, warnings));
        }
        propsFile = parsedProps.get(candidate) ?? null;
        break;
      }
      if (relativeDir.length === 0) break;
      cursor = pathPosix.dirname(cursor);
    }

    const properties = new Map<string, string>();
    if (propsFile !== null) evaluateProperties(propsFile, label, properties, warnings);
    evaluateProperties(parsedProject, label, properties, warnings);

    const propsItems = propsFile !== null ? collectItems(propsFile, label, warnings) : null;
    const projectItems = collectItems(parsedProject, label, warnings);
    for (const file of [propsFile, parsedProject]) {
      if (file !== null && hasPlainImports(file.root)) {
        warnings.push(
          `${label}: <Import> elements in ${file.relativePath} are not followed; settings in imported files were not modeled`,
        );
      }
    }

    // ProjectReference → owning projects of the analysis set. Items of an
    // imported file (Directory.Build.props) resolve against the project
    // directory, like every MSBuild item Include.
    const projectReferences = new Set<string>();
    for (const include of [...(propsItems?.projectReferences ?? []), ...projectItems.projectReferences]) {
      const raw = include.replace(/\\/g, "/");
      if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
        warnings.push(`${label}: absolute ProjectReference '${snippet(include)}' is not modeled; skipped`);
        continue;
      }
      const joined = pathPosix.normalize(projectDir === "." ? raw : `${projectDir}/${raw}`);
      if (joined === ".." || joined.startsWith("../")) {
        warnings.push(`${label}: ProjectReference '${snippet(include)}' points outside the workspace; skipped`);
        continue;
      }
      const target = resolveOwned(joined);
      if (target !== undefined && target !== projectPath) projectReferences.add(target);
    }

    const assemblyNameValue = properties.get("assemblyname")?.trim();
    const assemblyName =
      assemblyNameValue !== undefined && ASSEMBLY_NAME_PATTERN.test(assemblyNameValue) ? assemblyNameValue : undefined;

    let sortedReferences = [...projectReferences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (sortedReferences.length > MAX_PROJECT_REFERENCES_PER_PROJECT) {
      // Same reason as the global using limit: the worker rejects the whole request above it.
      warnings.push(
        `${label}: ${String(sortedReferences.length)} project references exceed the limit of ${String(MAX_PROJECT_REFERENCES_PER_PROJECT)} per project; the last ${String(sortedReferences.length - MAX_PROJECT_REFERENCES_PER_PROJECT)} in ordinal order were dropped`,
      );
      sortedReferences = sortedReferences.slice(0, MAX_PROJECT_REFERENCES_PER_PROJECT);
    }
    const spec = {
      path: projectPath,
      ...(assemblyName !== undefined ? { assemblyName } : {}),
      projectReferences: sortedReferences,
    };

    // SDK-style projects only: legacy projects have no implicit usings and no
    // GenerateGlobalUsings target.
    const sdks = projectSdks(parsedProject.root);
    if (sdks.length === 0) {
      projects.push({ ...spec, globalUsings: [] });
      continue;
    }
    const families = new Set<SdkFamily>();
    const unmodeled: string[] = [];
    for (const sdk of sdks) {
      const family = MODELED_SDKS.get(sdk.toLowerCase());
      if (family === undefined) unmodeled.push(sdk);
      else families.add(family);
    }
    if (families.size === 0) {
      warnings.push(
        `${label}: SDK '${snippet(unmodeled.join(";"))}' is not modeled; its implicit global usings and Using items were not added`,
      );
      projects.push({ ...spec, globalUsings: [] });
      continue;
    }
    if (unmodeled.length > 0) {
      warnings.push(
        `${label}: additional SDK '${snippet(unmodeled.join(";"))}' is not modeled; implicit global usings it may add were not added`,
      );
    }

    const operations: UsingOperation[] = [...(propsItems?.usingOperations ?? [])];
    const implicitUsings = (properties.get("implicitusings") ?? "").trim().toLowerCase();
    if (implicitUsings === "true" || implicitUsings === "enable") {
      const sdkSource = SDK_DEFAULTS_SOURCE;
      const netFramework = isNetFrameworkTarget(preferredTargetFramework(properties));
      operations.push({
        kind: "include",
        specs: SDK_BASE_USINGS.filter((name) => !(netFramework && name === "System.Net.Http")),
        alias: undefined,
        isStatic: false,
        source: sdkSource,
      });
      if ((properties.get("usewindowsforms") ?? "").trim().toLowerCase() === "true") {
        operations.push({ kind: "include", specs: WINDOWS_FORMS_USINGS, alias: undefined, isStatic: false, source: sdkSource });
      }
      if ((properties.get("usewpf") ?? "").trim().toLowerCase() === "true") {
        operations.push({ kind: "remove", specs: WPF_REMOVED_USINGS });
      }
      if (families.has("web")) {
        operations.push({ kind: "include", specs: SDK_WEB_USINGS, alias: undefined, isStatic: false, source: sdkSource });
      }
      if (families.has("worker")) {
        operations.push({ kind: "include", specs: SDK_WORKER_USINGS, alias: undefined, isStatic: false, source: sdkSource });
      }
    }
    operations.push(...projectItems.usingOperations);

    projects.push({ ...spec, globalUsings: finalizeUsings(operations, label, warnings) });
  }

  return { projects, warnings };
}
