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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * Returns the asset root the server must use: this verified package when
 * CAUSORYN_ASSET_ROOT is unset or blank, otherwise the realpath of the override
 * after checking it is an absolute path to a directory holding the same
 * `causoryn@<verifiedVersion>` package with a `native/` directory. Exits 2 otherwise.
 */
function resolveAssetRoot(rawValue, verifiedVersion) {
  const value = rawValue?.trim();
  if (value === undefined || value.length === 0) {
    return PKG_ROOT;
  }
  const reject = (reason) => {
    console.error(`[causoryn-launcher] CAUSORYN_ASSET_ROOT rejected (${reason}): ${value}`);
    process.exit(2);
  };
  if (!path.isAbsolute(value)) {
    return reject("must be an absolute path");
  }
  let resolved;
  try {
    resolved = realpathSync(value);
  } catch {
    return reject("does not exist");
  }
  if (!statSync(resolved).isDirectory()) {
    return reject("is not a directory");
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(path.join(resolved, "package.json"), "utf8"));
  } catch {
    return reject("has no readable package.json");
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    marker.name !== "causoryn" ||
    marker.version !== verifiedVersion
  ) {
    return reject(`is not the causoryn@${verifiedVersion} package`);
  }
  const nativeDir = path.join(resolved, "native");
  if (!existsSync(nativeDir) || !statSync(nativeDir).isDirectory()) {
    return reject("has no native/ directory");
  }
  return resolved;
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
