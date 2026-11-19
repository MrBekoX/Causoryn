#!/usr/bin/env node
/**
 * `packages/causoryn/scripts/build-package.mjs` — Dağıtım paketi sahneleyici (`K-021`).
 *
 * Görevleri:
 * 1. `SERVER_VERSION` (`0.1.0`) ile tüm kök ve paket içi manifestlerin sürüm
 *    eşliğini fail-closed doğrular.
 * 2. `packages/mcp-server/dist/{mcp-server.mjs,bundle-manifest.json,node_modules}`
 *    artefaktlarını `packages/causoryn/dist/` içine sahneler (`tsc` çıktılarını korur).
 * 3. `node_modules/typescript/lib/lib*.d.ts` dosyalarını `packages/causoryn/dist/typescript-lib/`
 *    altına deterministik olarak kopyalar.
 * 4. `native/{python-worker,go-worker,rust-worker,roslyn-worker}` varlıklarını
 *    (`target/`, `obj/`, `test-build.lock`, `__pycache__`, `*.pdb`, `.mimosa/` hariç)
 *    `packages/causoryn/native/` altına sahneler.
 * 5. Kök `skills/` -> `packages/causoryn/skills/` ve kök `LICENSE` -> `packages/causoryn/LICENSE`
 *    kopyalarını oluşturur.
 */
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PKG_DIR = path.dirname(SCRIPT_DIR);
const DEFAULT_REPO_ROOT = path.dirname(path.dirname(DEFAULT_PKG_DIR));

const NATIVE_WORKER_DIRS = [
  "python-worker",
  "go-worker",
  "rust-worker",
  "roslyn-worker",
];

const EXCLUDED_NATIVE_DIR_NAMES = new Set([
  "target",
  "obj",
  "__pycache__",
  ".mimosa",
  ".video_agent",
  ".git",
  "node_modules",
]);

const EXCLUDED_NATIVE_FILE_NAMES = new Set([
  "test-build.lock",
  ".DS_Store",
  "Thumbs.db",
]);

function extractServerVersion(versionTsSource) {
  const match = versionTsSource.match(/export const SERVER_VERSION\s*=\s*"([^"]+)"/);
  if (!match || !match[1]) {
    throw new Error("[build:package] packages/mcp-server/src/version.ts içinde SERVER_VERSION bulunamadı");
  }
  return match[1];
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`[build:package] zorunlu manifest bulunamadı: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `[build:package] sürüm/alan eşliği hatası (${label}): beklenen "${String(expected)}", bulunan "${String(actual)}"`,
    );
  }
}

export function verifyManifestVersionParity(repoRoot, pkgDir) {
  const versionTsPath = path.join(repoRoot, "packages", "mcp-server", "src", "version.ts");
  const expectedVersion = extractServerVersion(readFileSync(versionTsPath, "utf8"));
  assertEqual(expectedVersion, "0.1.0", "SERVER_VERSION");

  const rootPkg = readJson(path.join(repoRoot, "package.json"));
  assertEqual(rootPkg.version, expectedVersion, "package.json#version");

  const distPkg = readJson(path.join(pkgDir, "package.json"));
  assertEqual(distPkg.version, expectedVersion, "packages/causoryn/package.json#version");

  for (const relMkt of [
    "marketplace.json",
    path.join(".claude-plugin", "marketplace.json"),
    path.join(".agents", "plugins", "marketplace.json"),
  ]) {
    const mkt = readJson(path.join(repoRoot, relMkt));
    if (mkt.metadata && mkt.metadata.version !== undefined) {
      assertEqual(mkt.metadata.version, expectedVersion, `${relMkt}#metadata.version`);
    }
    const firstPlugin = Array.isArray(mkt.plugins) ? mkt.plugins[0] : undefined;
    if (!firstPlugin) {
      throw new Error(`[build:package] ${relMkt} plugins[0] eksik`);
    }
    assertEqual(firstPlugin.version, expectedVersion, `${relMkt}#plugins[0].version`);
    assertEqual(
      firstPlugin.source?.version,
      expectedVersion,
      `${relMkt}#plugins[0].source.version`,
    );
  }

  const rootPluginJson = readJson(path.join(repoRoot, "plugin.json"));
  assertEqual(rootPluginJson.version, expectedVersion, "plugin.json#version");

  const expectedPinnedSpec = `causoryn@${expectedVersion}`;
  for (const relMcp of ["mcp_config.json", "mcp.json"]) {
    const mcpDoc = readJson(path.join(repoRoot, relMcp));
    const args = mcpDoc.mcpServers?.causoryn?.args ?? [];
    if (!Array.isArray(args) || !args.includes(expectedPinnedSpec)) {
      throw new Error(
        `[build:package] ${relMcp} mcpServers.causoryn.args "${expectedPinnedSpec}" içermiyor`,
      );
    }
  }

  const serverJson = readJson(path.join(repoRoot, "server.json"));
  assertEqual(serverJson.name, "io.github.mrbekox/causoryn", "server.json#name");
  assertEqual(serverJson.version, expectedVersion, "server.json#version");
  assertEqual(
    serverJson.packages?.[0]?.version,
    expectedVersion,
    "server.json#packages[0].version",
  );

  for (const relPkgManifest of [
    path.join(".claude-plugin", "plugin.json"),
    path.join(".zcode-plugin", "plugin.json"),
    path.join(".codex-plugin", "plugin.json"),
    "plugin.json",
  ]) {
    const doc = readJson(path.join(pkgDir, relPkgManifest));
    assertEqual(doc.version, expectedVersion, `packages/causoryn/${relPkgManifest}#version`);
  }

  const codexPkgMcp = readJson(path.join(pkgDir, ".codex-plugin", "mcp.json"));
  const codexArgs = codexPkgMcp.mcpServers?.causoryn?.args ?? [];
  if (!Array.isArray(codexArgs) || !codexArgs.includes(expectedPinnedSpec)) {
    throw new Error(
      `[build:package] packages/causoryn/.codex-plugin/mcp.json "${expectedPinnedSpec}" içermiyor`,
    );
  }

  return expectedVersion;
}

function copyNativeFiltered(srcDir, destDir, workerName) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_NATIVE_DIR_NAMES.has(entry.name)) continue;
      // go-worker/bin yalnızca test sahte ikililerini barındırır
      if (workerName === "go-worker" && entry.name === "bin") continue;
      copyNativeFiltered(
        path.join(srcDir, entry.name),
        path.join(destDir, entry.name),
        workerName,
      );
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_NATIVE_FILE_NAMES.has(entry.name)) continue;
    const lower = entry.name.toLowerCase();
    if (
      lower.endsWith(".pdb") ||
      lower.endsWith(".pyc") ||
      lower.endsWith(".pyo") ||
      lower.endsWith(".user")
    ) {
      continue;
    }
    // Roslyn portable DLL taşınır; Windows-özgü apphost .exe taşınmaz
    if (workerName === "roslyn-worker" && lower.endsWith(".exe")) {
      continue;
    }
    copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
}

export function stageVerifiedBundleArtifacts(options) {
  const resolvedMcpDist = path.resolve(options.mcpDistDir);
  const resolvedPkgDist = path.resolve(options.pkgDistDir);
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 300;

  mkdirSync(resolvedPkgDist, { recursive: true });

  const bundleSrc = path.join(resolvedMcpDist, "mcp-server.mjs");
  const bundleManifestSrc = path.join(resolvedMcpDist, "bundle-manifest.json");
  const vendorNodeModulesSrc = path.join(resolvedMcpDist, "node_modules");

  const destBundle = path.join(resolvedPkgDist, "mcp-server.mjs");
  const destManifest = path.join(resolvedPkgDist, "bundle-manifest.json");
  const destVendorNodeModules = path.join(resolvedPkgDist, "node_modules");
  const pkgDistBoundary = resolvedPkgDist.endsWith(path.sep)
    ? resolvedPkgDist
    : `${resolvedPkgDist}${path.sep}`;

  let lastError = null;
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    try {
      for (const [reqPath, label] of [
        [bundleSrc, "packages/mcp-server/dist/mcp-server.mjs (önce build:bundle)"],
        [bundleManifestSrc, "packages/mcp-server/dist/bundle-manifest.json"],
        [path.join(vendorNodeModulesSrc, "better-sqlite3", "package.json"), "vendored better-sqlite3"],
      ]) {
        if (!existsSync(reqPath)) {
          throw new Error(`[build:package] eksik önkoşul (${label}) [ENOENT]: ${reqPath}`);
        }
      }

      copyFileSync(bundleSrc, destBundle);
      copyFileSync(bundleManifestSrc, destManifest);
      rmSync(destVendorNodeModules, { recursive: true, force: true });
      cpSync(vendorNodeModulesSrc, destVendorNodeModules, { recursive: true });

      const parsed = JSON.parse(readFileSync(destManifest, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("[build:package] bundle-manifest.json kök değeri nesne değil");
      }
      const filesMap = parsed.files;
      if (typeof filesMap !== "object" || filesMap === null || Array.isArray(filesMap)) {
        throw new Error("[build:package] bundle-manifest.json files alanı nesne değil");
      }
      const entries = Object.entries(filesMap);
      if (entries.length === 0 || typeof filesMap["mcp-server.mjs"] !== "string") {
        throw new Error("[build:package] bundle-manifest.json mcp-server.mjs kaydı eksik");
      }

      const postCopySrcManifest = JSON.parse(readFileSync(bundleManifestSrc, "utf8"));
      if (postCopySrcManifest?.files?.["mcp-server.mjs"] !== filesMap["mcp-server.mjs"]) {
        throw new Error(
          "[build:package] SHA-256 manifest torn-read: kaynak bundle-manifest.json kopyalama sırasında değişti",
        );
      }

      for (const [relPath, expectedSha] of entries) {
        if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha)) {
          throw new Error(
            `[build:package] geçersiz SHA-256 özeti (${relPath}): ${String(expectedSha)}`,
          );
        }
        const stagedFile = path.resolve(resolvedPkgDist, ...relPath.split("/"));
        if (!stagedFile.startsWith(pkgDistBoundary)) {
          throw new Error(`[build:package] geçersiz bundle-manifest yolu: ${relPath}`);
        }
        const actualSha = createHash("sha256").update(readFileSync(stagedFile)).digest("hex");
        if (actualSha !== expectedSha.toLowerCase()) {
          throw new Error(
            `[build:package] bundle-manifest SHA-256 uyuşmazlığı (${relPath}): beklenen ${expectedSha}, bulunan ${actualSha}`,
          );
        }
      }

      return {
        verifiedFileCount: entries.length,
        bundleSha256: filesMap["mcp-server.mjs"].toLowerCase(),
      };
    } catch (error) {
      lastError = error;
      if (retry < maxRetries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
      }
    }
  }

  rmSync(destBundle, { force: true });
  rmSync(destManifest, { force: true });
  rmSync(destVendorNodeModules, { recursive: true, force: true });
  throw new Error(
    `[build:package] bundle doğrulama ${String(maxRetries)} yeniden deneme sonunda başarısız: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function stageCausorynPackage(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const pkgDir = path.resolve(options.pkgDir ?? DEFAULT_PKG_DIR);

  const version = verifyManifestVersionParity(repoRoot, pkgDir);

  const compiledCliEntry = path.join(pkgDir, "dist", "index.js");
  if (!existsSync(compiledCliEntry)) {
    throw new Error(
      `[build:package] eksik önkoşul (packages/causoryn derlenmiş CLI (önce npm run build)): ${compiledCliEntry}`,
    );
  }

  const mcpDistDir = path.join(repoRoot, "packages", "mcp-server", "dist");
  const pkgDistDir = path.join(pkgDir, "dist");
  mkdirSync(pkgDistDir, { recursive: true });

  // 1) MCP sunucu vendored better-sqlite3 + manifest (SHA-256 + torn-read korumalı)
  stageVerifiedBundleArtifacts({
    mcpDistDir,
    pkgDistDir,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  });

  // 1b) K-021 sıfır-ayar CLI giriş noktasını (`src/cli-stdio.ts`) `packages/causoryn/dist/mcp-server.mjs`
  //     olarak derle (`src/stdio.ts` ise saf `CAUSORYN_CONFIG` F1 girişi olarak korunur).
  const mcpServerPkgDir = path.join(repoRoot, "packages", "mcp-server");
  const cliStdioEntry = path.join(mcpServerPkgDir, "src", "cli-stdio.ts");
  if (!existsSync(cliStdioEntry)) {
    throw new Error(`[build:package] cli-stdio giriş noktası bulunamadı: ${cliStdioEntry}`);
  }
  const pkgBundlePath = path.join(pkgDistDir, "mcp-server.mjs");
  buildSync({
    absWorkingDir: mcpServerPkgDir,
    entryPoints: ["src/cli-stdio.ts"],
    outfile: pkgBundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["better-sqlite3"],
    banner: {
      js: [
        "/* eslint-disable */",
        'import { createRequire } from "node:module";',
        'import { fileURLToPath as __causorynFileURLToPath } from "node:url";',
        "const require = createRequire(import.meta.url);",
        "const __filename = __causorynFileURLToPath(import.meta.url);",
        'const __dirname = __causorynFileURLToPath(new URL(".", import.meta.url));',
      ].join("\n"),
    },
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  });
  const rawPkgBundle = readFileSync(pkgBundlePath, "utf8");
  const firstNewline = rawPkgBundle.indexOf("\n");
  if (firstNewline >= 0) {
    const headerLine = rawPkgBundle.slice(0, firstNewline + 1);
    const sanitizedBody = rawPkgBundle
      .slice(firstNewline + 1)
      .replace(/(\/\/|\/\*)\s*eslint-(disable|enable)\b/g, "$1 [bundled-lint-directive] $2");
    writeFileSync(pkgBundlePath, headerLine + sanitizedBody, "utf8");
  }
  const pkgManifestPath = path.join(pkgDistDir, "bundle-manifest.json");
  const pkgManifestObj = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
  pkgManifestObj.files["mcp-server.mjs"] = createHash("sha256")
    .update(readFileSync(pkgBundlePath))
    .digest("hex");
  writeFileSync(pkgManifestPath, `${JSON.stringify(pkgManifestObj, null, 2)}\n`, "utf8");

  // 2) TypeScript lib*.d.ts -> packages/causoryn/dist/typescript-lib/
  const tsLibSrcDir = path.join(repoRoot, "node_modules", "typescript", "lib");
  if (!existsSync(tsLibSrcDir)) {
    throw new Error(`[build:package] TypeScript lib dizini bulunamadı: ${tsLibSrcDir}`);
  }
  const tsLibDestDir = path.join(pkgDistDir, "typescript-lib");
  rmSync(tsLibDestDir, { recursive: true, force: true });
  mkdirSync(tsLibDestDir, { recursive: true });
  const dtsFiles = readdirSync(tsLibSrcDir)
    .filter((name) => /^lib(\..+)?\.d\.ts$/.test(name))
    .sort();
  if (!dtsFiles.includes("lib.es2022.full.d.ts")) {
    throw new Error("[build:package] lib.es2022.full.d.ts bulunamadı");
  }
  for (const dtsName of dtsFiles) {
    copyFileSync(path.join(tsLibSrcDir, dtsName), path.join(tsLibDestDir, dtsName));
  }

  // 3) native/{python-worker,go-worker,rust-worker,roslyn-worker}
  const pkgNativeDir = path.join(pkgDir, "native");
  rmSync(pkgNativeDir, { recursive: true, force: true });
  mkdirSync(pkgNativeDir, { recursive: true });
  for (const workerName of NATIVE_WORKER_DIRS) {
    const srcWorker = path.join(repoRoot, "native", workerName);
    if (!existsSync(srcWorker)) {
      throw new Error(`[build:package] native worker bulunamadı: ${srcWorker}`);
    }
    copyNativeFiltered(srcWorker, path.join(pkgNativeDir, workerName), workerName);
  }

  // 4) Kök skills/ -> packages/causoryn/skills/
  const rootSkillsDir = path.join(repoRoot, "skills");
  if (!existsSync(rootSkillsDir)) {
    throw new Error(`[build:package] kök skills/ dizini bulunamadı: ${rootSkillsDir}`);
  }
  const pkgSkillsDir = path.join(pkgDir, "skills");
  rmSync(pkgSkillsDir, { recursive: true, force: true });
  cpSync(rootSkillsDir, pkgSkillsDir, { recursive: true });

  // 5) Kök LICENSE -> packages/causoryn/LICENSE
  const rootLicense = path.join(repoRoot, "LICENSE");
  if (!existsSync(rootLicense)) {
    throw new Error(`[build:package] kök LICENSE bulunamadı: ${rootLicense}`);
  }
  copyFileSync(rootLicense, path.join(pkgDir, "LICENSE"));

  return {
    version,
    typescriptLibFileCount: dtsFiles.length,
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    const summary = stageCausorynPackage();
    console.error(
      `[build:package] ok — causoryn@${summary.version} sahnelendi (ts-lib: ${String(summary.typescriptLibFileCount)} d.ts, native: 4 worker, skills: 4, LICENSE)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
