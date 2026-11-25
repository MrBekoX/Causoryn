#!/usr/bin/env node
/**
 * `causoryn` CLI giriş noktası (`mcp`, `setup`, `doctor`, `--version`, `--help`).
 *
 * Kırmızı çizgi: `mcp` alt komutunda `stdout` YALNIZCA MCP JSON-RPC protokolüne
 * aittir; hiçbir başlık/log `stdout`'a yazılmaz, doğrudan `dist/mcp-server.mjs`
 * modülüne saf devir yapılır.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveAssetRootOverride } from "./lib/asset-root.mjs";
import { assertSupportedNodeVersion } from "./lib/node-version-guard.mjs";

assertSupportedNodeVersion();

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rawArgs = process.argv.slice(2);

if (rawArgs[0] === "mcp") {
  const mcpBundlePath = path.join(PKG_ROOT, "dist", "mcp-server.mjs");
  if (!existsSync(mcpBundlePath)) {
    console.error(
      `[causoryn] compiled MCP server bundle not found: ${mcpBundlePath} (run build:package first)`,
    );
    process.exit(2);
  }
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    pkgVersion = undefined;
  }
  if (typeof pkgVersion !== "string") {
    console.error(`[causoryn] package.json of ${PKG_ROOT} has no readable version`);
    process.exit(2);
  }
  const assetRoot = resolveAssetRootOverride(process.env["CAUSORYN_ASSET_ROOT"], PKG_ROOT, pkgVersion);
  if (!assetRoot.ok) {
    console.error(
      `[causoryn] CAUSORYN_ASSET_ROOT rejected (${assetRoot.reason}): ${process.env["CAUSORYN_ASSET_ROOT"]?.trim()}`,
    );
    process.exit(2);
  }
  process.env["CAUSORYN_ASSET_ROOT"] = assetRoot.root;
  process.argv = [process.argv[0] ?? process.execPath, mcpBundlePath, ...rawArgs];
  await import(pathToFileURL(mcpBundlePath).href);
} else {
  const cliModulePath = path.join(PKG_ROOT, "dist", "index.js");
  if (!existsSync(cliModulePath)) {
    console.error(`[causoryn] CLI module is not compiled: ${cliModulePath} (run npm run build first)`);
    process.exit(2);
  }
  const { runCli } = await import(pathToFileURL(cliModulePath).href);
  const exitCode = await runCli(rawArgs);
  process.exitCode = exitCode;
}
