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
 */
import { existsSync, readFileSync } from "node:fs";
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
  const forwardedArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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

  return { cliExpectedVersion, forwardedArgs };
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

const { cliExpectedVersion, forwardedArgs } = parseLauncherArgs(process.argv.slice(2));

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

await import(pathToFileURL(MCP_BUNDLE_PATH).href);
