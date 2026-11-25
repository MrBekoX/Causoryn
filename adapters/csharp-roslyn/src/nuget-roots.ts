/**
 * Trusted NuGet package roots for compile-reference discovery.
 *
 * `obj/project.assets.json` is workspace content: its `packageFolders` keys
 * are only honoured when they lie inside one of these roots or inside the
 * workspace itself. The trusted roots come from the user's own NuGet setup,
 * never from the workspace:
 * - `NUGET_PACKAGES` (overrides the global packages folder),
 * - `globalPackagesFolder` and `fallbackPackageFolders` of the user-level
 *   NuGet.Config (`%APPDATA%\NuGet\NuGet.Config` on Windows,
 *   `~/.nuget/NuGet/NuGet.Config` and `~/.config/NuGet/NuGet.Config`
 *   elsewhere),
 * - the default global packages folder `~/.nuget/packages`,
 * - `NUGET_FALLBACK_PACKAGES` (semicolon-separated absolute folders).
 * Only fully qualified local paths are used; remote (UNC/device) paths and
 * paths reached through a link to a remote target are ignored.
 */
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { parseMsbuildXml, type XmlElement } from "./msbuild-xml.js";
import {
  canonicalLocalPath,
  isFullyQualifiedLocalPath,
  readBoundedFileNoFollow,
  resolveLocalRealDirectory,
  stripTrailingSeparators,
} from "./safe-fs.js";

/** Maximum size of a user-level NuGet.Config read for the trusted roots (256 KiB). */
export const MAX_NUGET_CONFIG_BYTES = 256 * 1024;

/** Maximum number of trusted NuGet roots considered. */
const MAX_TRUSTED_NUGET_ROOTS = 32;

export interface NugetTrustOptions {
  /** Environment used for NUGET_PACKAGES / NUGET_FALLBACK_PACKAGES / APPDATA (default: process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory of the default `~/.nuget/packages` folder (default: os.homedir()). */
  readonly homeDir?: string;
}

/** One trusted root: the path as configured, its real path and its OS-canonical form. */
export interface TrustedNugetRoot {
  readonly lexical: string;
  readonly real: string;
  readonly canonical: string;
}

function defaultHomeDir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function childElements(element: XmlElement, name: string): XmlElement[] {
  const lower = name.toLowerCase();
  return element.children.filter((child) => child.name.toLowerCase() === lower);
}

function attributeOf(element: XmlElement, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of element.attributes) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Folders configured in a user-level NuGet.Config (absolute values only; no variable expansion). */
function foldersFromNugetConfig(configPath: string): string[] {
  const realDir = resolveLocalRealDirectory(dirname(configPath));
  if (realDir === null) return [];
  const content = readBoundedFileNoFollow(join(realDir, basename(configPath)), realDir, MAX_NUGET_CONFIG_BYTES);
  if (content === null) return [];
  let root: XmlElement;
  try {
    root = parseMsbuildXml(content);
  } catch {
    // A malformed user configuration contributes no trusted folder.
    return [];
  }
  if (root.name.toLowerCase() !== "configuration") return [];
  const folders: string[] = [];
  for (const config of childElements(root, "config")) {
    for (const add of childElements(config, "add")) {
      if (attributeOf(add, "key")?.toLowerCase() !== "globalpackagesfolder") continue;
      const value = attributeOf(add, "value");
      if (value !== undefined) folders.push(value);
    }
  }
  for (const section of childElements(root, "fallbackPackageFolders")) {
    for (const add of childElements(section, "add")) {
      const value = attributeOf(add, "value");
      if (value !== undefined) folders.push(value);
    }
  }
  return folders;
}

function userNugetConfigPaths(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  if (process.platform === "win32") {
    const appData = env["APPDATA"]?.trim();
    const base = appData !== undefined && appData.length > 0 ? appData : home.length > 0 ? join(home, "AppData", "Roaming") : "";
    return base.length > 0 ? [join(base, "NuGet", "NuGet.Config")] : [];
  }
  if (home.length === 0) return [];
  return [join(home, ".nuget", "NuGet", "NuGet.Config"), join(home, ".config", "NuGet", "NuGet.Config")];
}

/**
 * Real paths of the trusted NuGet package roots (deduplicated, in the order
 * listed above). Missing folders are skipped.
 */
export function trustedNugetPackageRoots(options: NugetTrustOptions = {}): TrustedNugetRoot[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? defaultHomeDir();
  const configured: string[] = [];

  const nugetPackages = env["NUGET_PACKAGES"];
  if (nugetPackages !== undefined) configured.push(nugetPackages);
  for (const configPath of userNugetConfigPaths(env, home)) {
    configured.push(...foldersFromNugetConfig(configPath));
  }
  if (home.length > 0) configured.push(join(home, ".nuget", "packages"));
  const fallback = env["NUGET_FALLBACK_PACKAGES"];
  if (fallback !== undefined) configured.push(...fallback.split(";"));

  const roots: TrustedNugetRoot[] = [];
  const seen = new Set<string>();
  for (const raw of configured) {
    if (roots.length >= MAX_TRUSTED_NUGET_ROOTS) break;
    const trimmed = raw.trim();
    if (!isFullyQualifiedLocalPath(trimmed)) continue;
    const lexical = resolve(stripTrailingSeparators(trimmed));
    const real = resolveLocalRealDirectory(lexical);
    if (real === null) continue;
    const canonical = canonicalLocalPath(real);
    if (canonical === null) continue;
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ lexical, real, canonical });
  }
  return roots;
}
