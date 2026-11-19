#!/usr/bin/env node
/**
 * Plugin pazaryeri başlatıcısı (`plugin-mcp-launcher.mjs`, K-021).
 *
 * İç içe `npx` alt-süreci açmadan kurulu plugin dizinindeki `package.json`
 * sürüm bütünlüğünü doğrular, `CAUSORYN_ASSET_ROOT` ortamını bağlar ve saf
 * `stdout` disipliniyle doğrudan `dist/mcp-server.mjs` modülünü yükler.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_JSON_PATH = path.join(PKG_ROOT, "package.json");
const MCP_BUNDLE_PATH = path.join(PKG_ROOT, "dist", "mcp-server.mjs");

try {
  const pkgRaw = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
  if (
    typeof pkgRaw !== "object" ||
    pkgRaw === null ||
    pkgRaw.name !== "causoryn" ||
    typeof pkgRaw.version !== "string"
  ) {
    console.error(`[causoryn-launcher] geçersiz plugin package.json: ${PKG_JSON_PATH}`);
    process.exit(2);
  }
  const expectedVersion = process.env["CAUSORYN_EXPECTED_VERSION"];
  if (
    expectedVersion !== undefined &&
    expectedVersion.length > 0 &&
    pkgRaw.version !== expectedVersion
  ) {
    console.error(
      `[causoryn-launcher] sürüm uyuşmazlığı: beklenen ${expectedVersion}, bulunan ${pkgRaw.version}`,
    );
    process.exit(2);
  }
} catch (error) {
  console.error(
    `[causoryn-launcher] package.json okunamadı: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

if (!existsSync(MCP_BUNDLE_PATH)) {
  console.error(`[causoryn-launcher] MCP sunucu paketi bulunamadı: ${MCP_BUNDLE_PATH}`);
  process.exit(2);
}

process.env["CAUSORYN_ASSET_ROOT"] ??= PKG_ROOT;

const rawArgs = process.argv.slice(2);
const mcpArgs =
  rawArgs.length === 0 || rawArgs[0] === "mcp" ? rawArgs : ["mcp", ...rawArgs];
process.argv = [process.argv[0] ?? process.execPath, MCP_BUNDLE_PATH, ...mcpArgs];

await import(pathToFileURL(MCP_BUNDLE_PATH).href);
