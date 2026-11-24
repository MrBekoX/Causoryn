#!/usr/bin/env node
/**
 * `causoryn` CLI giriş noktası (`mcp`, `setup`, `doctor`, `--version`, `--help`).
 *
 * Kırmızı çizgi: `mcp` alt komutunda `stdout` YALNIZCA MCP JSON-RPC protokolüne
 * aittir; hiçbir başlık/log `stdout`'a yazılmaz, doğrudan `dist/mcp-server.mjs`
 * modülüne saf devir yapılır.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  process.env["CAUSORYN_ASSET_ROOT"] ??= PKG_ROOT;
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
