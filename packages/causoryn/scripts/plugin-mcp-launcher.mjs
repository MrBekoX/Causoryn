#!/usr/bin/env node
/**
 * Plugin pazaryeri başlatıcısı (`plugin-mcp-launcher.mjs`, K-021).
 *
 * İç içe `npx` alt-süreci açmadan kurulu plugin dizinindeki `package.json`
 * sürüm bütünlüğünü doğrular, `CAUSORYN_ASSET_ROOT` ortamını bağlar ve saf
 * `stdout` disipliniyle doğrudan `dist/mcp-server.mjs` modülünü yükler.
 *
 * `CAUSORYN_ASSET_ROOT`, sunucunun sidecar worker kaynaklarını (`native/`)
 * yüklediği kökü seçer. Tanımsız/boşsa doğrulanmış paket köküne bağlanır;
 * miras alınan bir değer (geliştirme override'ı) yalnızca mutlak, var olan ve
 * aynı doğrulanmış sürümdeki `causoryn` paketini (`native/` ile) gösteriyorsa
 * kabul edilir, aksi halde başlatıcı `2` ile fail-closed çıkar.
 *
 * `--project-dir <dir>`: hosts start this launcher with the plugin root as the
 * working directory, so the bare `node` command is never resolved against the
 * analyzed repository (Windows searches the cwd before PATH). The project
 * directory arrives as this argument instead. A usable value (fully qualified,
 * not UNC/device, an existing directory) becomes the server's working directory
 * just before the bundle loads, so `--allow-cwd` applies its usual project-root
 * safety check to it. Any other value is ignored with a stderr note; the server
 * then starts in the plugin root, which `--allow-cwd` refuses, and waits for MCP
 * `roots/list`. The flag is never forwarded to the server.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveAssetRootOverride } from "./lib/asset-root.mjs";
import { assertSupportedNodeVersion } from "./lib/node-version-guard.mjs";

assertSupportedNodeVersion();

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_JSON_PATH = path.join(PKG_ROOT, "package.json");
const MCP_BUNDLE_PATH = path.join(PKG_ROOT, "dist", "mcp-server.mjs");

function parseLauncherArgs(argv) {
  let cliExpectedVersion;
  /** undefined: flag absent; { value: undefined }: flag without a value. */
  let projectDirArg;
  const forwardedArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--project-dir") {
      const next = argv[i + 1];
      // A host that drops an empty substitution leaves the next flag here.
      if (next === undefined || next.startsWith("-")) {
        projectDirArg = { value: undefined };
      } else {
        projectDirArg = { value: next };
        i += 1;
      }
      continue;
    }
    if (token.startsWith("--project-dir=")) {
      projectDirArg = { value: token.slice("--project-dir=".length) };
      continue;
    }
    if (token === "--expected-version") {
      const next = argv[i + 1];
      if (next === undefined || next.trim().length === 0 || next.startsWith("-")) {
        console.error("[causoryn-launcher] --expected-version requires a valid version value");
        process.exit(2);
      }
      cliExpectedVersion = next.trim();
      i += 1;
      continue;
    }
    if (token.startsWith("--expected-version=")) {
      const inlineVal = token.slice("--expected-version=".length).trim();
      if (inlineVal.length === 0 || inlineVal.startsWith("-")) {
        console.error("[causoryn-launcher] --expected-version does not accept an empty or invalid value");
        process.exit(2);
      }
      cliExpectedVersion = inlineVal;
      continue;
    }
    forwardedArgs.push(token);
  }

  return { cliExpectedVersion, projectDirArg, forwardedArgs };
}

/** `C:\...` / `C:/...` on win32, `/...` elsewhere; never UNC (`\\host`, `//host`) or device paths. */
function isFullyQualifiedLocalPath(value) {
  if (/^(?:\\\\|\/\/|\\\/|\/\\)/.test(value)) return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(value);
  return value.startsWith("/");
}

/**
 * Checks a `--project-dir` value lexically first (so a UNC value never reaches
 * the filesystem, which would open an SMB connection), then on disk.
 */
function checkProjectDir(value) {
  if (value === undefined) return { ok: false, reason: "no value" };
  if (value.trim().length === 0) return { ok: false, reason: "empty value" };
  if (value.includes("\0")) return { ok: false, reason: "NUL byte" };
  if (value.includes("${")) return { ok: false, reason: "unexpanded host variable" };
  if (!isFullyQualifiedLocalPath(value)) {
    return { ok: false, reason: "not a fully qualified local path" };
  }
  try {
    if (!statSync(value).isDirectory()) return { ok: false, reason: "not a directory" };
  } catch {
    return { ok: false, reason: "directory not found" };
  }
  return { ok: true, dir: value };
}

function enterProjectDir(projectDirArg) {
  if (projectDirArg === undefined) return;
  const check = checkProjectDir(projectDirArg.value);
  let reason = check.ok ? undefined : check.reason;
  if (check.ok) {
    try {
      process.chdir(check.dir);
    } catch (error) {
      reason = `cannot enter it: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (reason !== undefined) {
    console.error(
      `[causoryn-launcher] --project-dir ignored (${reason}); the server starts in ${process.cwd()}`,
    );
  }
}

/**
 * Returns the asset root the server must use (see lib/asset-root.mjs): this
 * verified package when CAUSORYN_ASSET_ROOT is unset or blank, otherwise the
 * realpath of a valid same-version override. Exits 2 otherwise.
 */
function resolveAssetRoot(rawValue, verifiedVersion) {
  const result = resolveAssetRootOverride(rawValue, PKG_ROOT, verifiedVersion);
  if (!result.ok) {
    console.error(`[causoryn-launcher] CAUSORYN_ASSET_ROOT rejected (${result.reason}): ${rawValue?.trim()}`);
    process.exit(2);
  }
  return result.root;
}

const { cliExpectedVersion, projectDirArg, forwardedArgs } = parseLauncherArgs(
  process.argv.slice(2),
);

let verifiedVersion;
try {
  const pkgRaw = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
  if (
    typeof pkgRaw !== "object" ||
    pkgRaw === null ||
    pkgRaw.name !== "causoryn" ||
    typeof pkgRaw.version !== "string"
  ) {
    console.error(`[causoryn-launcher] invalid plugin package.json: ${PKG_JSON_PATH}`);
    process.exit(2);
  }

  const envExpectedVersion = process.env["CAUSORYN_EXPECTED_VERSION"]?.trim();
  if (
    cliExpectedVersion !== undefined &&
    envExpectedVersion !== undefined &&
    envExpectedVersion.length > 0 &&
    cliExpectedVersion !== envExpectedVersion
  ) {
    console.error(
      `[causoryn-launcher] conflicting version pins: --expected-version=${cliExpectedVersion}, CAUSORYN_EXPECTED_VERSION=${envExpectedVersion}`,
    );
    process.exit(2);
  }

  const expectedVersion =
    cliExpectedVersion ??
    (envExpectedVersion !== undefined && envExpectedVersion.length > 0
      ? envExpectedVersion
      : undefined);

  if (expectedVersion !== undefined && pkgRaw.version !== expectedVersion) {
    console.error(
      `[causoryn-launcher] version mismatch: expected ${expectedVersion}, found ${pkgRaw.version}`,
    );
    process.exit(2);
  }
  verifiedVersion = pkgRaw.version;
} catch (error) {
  console.error(
    `[causoryn-launcher] could not read package.json: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

if (!existsSync(MCP_BUNDLE_PATH)) {
  console.error(`[causoryn-launcher] MCP server bundle not found: ${MCP_BUNDLE_PATH}`);
  process.exit(2);
}

process.env["CAUSORYN_ASSET_ROOT"] = resolveAssetRoot(
  process.env["CAUSORYN_ASSET_ROOT"],
  verifiedVersion,
);

const mcpArgs =
  forwardedArgs.length === 0 || forwardedArgs[0] === "mcp"
    ? forwardedArgs
    : ["mcp", ...forwardedArgs];
process.argv = [process.argv[0] ?? process.execPath, MCP_BUNDLE_PATH, ...mcpArgs];

// Last step before the bundle loads: every path above is absolute or derived
// from this file's location, so the directory change affects only the server.
enterProjectDir(projectDirArg);

await import(pathToFileURL(MCP_BUNDLE_PATH).href);
