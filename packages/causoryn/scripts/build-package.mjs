#!/usr/bin/env node
/**
 * `packages/causoryn/scripts/build-package.mjs` — Dağıtım paketi sahneleyici (`K-021`).
 *
 * Görevleri:
 * 1. `SERVER_VERSION` (SemVer) ile tüm kök ve paket içi manifestlerin sürüm,
 *    `mcpName`, MCP Registry `server.json` ve `--expected-version` eşliğini
 *    fail-closed doğrular.
 * 2. `packages/mcp-server/dist/{mcp-server.mjs,mcp-server.mjs.LEGAL.txt,bundle-manifest.json,node_modules}`
 *    artefaktlarını `packages/causoryn/dist/` içine sahneler (`tsc` çıktılarını korur),
 *    ardından `src/cli-stdio.ts` girişini `legalComments: "linked"` ile paketler.
 * 3. `node_modules/typescript/lib/lib*.d.ts` dosyalarını `packages/causoryn/dist/typescript-lib/`
 *    altına deterministik olarak kopyalar.
 * 4. `native/{python-worker,go-worker,rust-worker,roslyn-worker}` varlıklarını
 *    sahneler; `roslyn-worker` için `bin/`/`obj/`/`*.pdb`/`*.exe`/`*.resources.dll`
 *    olmadan YALNIZCA 5 taşınabilir runtime dosyasını düz `native/roslyn-worker/`
 *    altına fail-closed kopyalar ve deterministik/temiz binary taramasından geçirir.
 * 5. Kök `skills/` -> `packages/causoryn/skills/`, kök `LICENSE` -> `packages/causoryn/LICENSE`,
 *    `packages/causoryn/licenses/` ve deterministik `packages/causoryn/THIRD-PARTY-NOTICES.md`
 *    dosyalarını üretir.
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

import { scanRoslynBinaryClean } from "./verify-package-ready.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PKG_DIR = path.dirname(SCRIPT_DIR);
const DEFAULT_REPO_ROOT = path.dirname(path.dirname(DEFAULT_PKG_DIR));

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const NATIVE_WORKER_DIRS = [
  "python-worker",
  "go-worker",
  "rust-worker",
  "roslyn-worker",
];

const ROSLYN_PORTABLE_RUNTIME_FILES = [
  "Causoryn.RoslynWorker.dll",
  "Causoryn.RoslynWorker.deps.json",
  "Causoryn.RoslynWorker.runtimeconfig.json",
  "Microsoft.CodeAnalysis.dll",
  "Microsoft.CodeAnalysis.CSharp.dll",
];

const EXCLUDED_NATIVE_DIR_NAMES = new Set([
  "target",
  "obj",
  "__pycache__",
  "node_modules",
]);

const EXCLUDED_NATIVE_FILE_NAMES = new Set([
  "test-build.lock",
  "Thumbs.db",
]);

/**
 * Hidden entries (names starting with ".") under the native worker sources
 * are never staged: they are local tool caches, editor state or VCS
 * metadata, not worker runtime files. A hidden entry the package really
 * needs must be added here explicitly (currently none).
 */
export const NATIVE_HIDDEN_ENTRY_ALLOWLIST = new Set([]);

const MIT_LICENSE_TEMPLATE = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n");

function extractServerVersion(versionTsSource) {
  const match = versionTsSource.match(/export const SERVER_VERSION\s*=\s*"([^"]+)"/);
  if (!match || !match[1]) {
    throw new Error(
      "[build:package] SERVER_VERSION not found in packages/mcp-server/src/version.ts",
    );
  }
  return match[1];
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`[build:package] required manifest not found: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `[build:package] version/field parity error (${label}): expected "${String(expected)}", found "${String(actual)}"`,
    );
  }
}

function assertLauncherExpectedVersion(args, expectedVersion, label) {
  if (!Array.isArray(args)) {
    throw new Error(`[build:package] ${label} args array is missing`);
  }
  const idx = args.indexOf("--expected-version");
  if (idx < 0 || args[idx + 1] !== expectedVersion) {
    throw new Error(
      `[build:package] ${label} "--expected-version ${expectedVersion}" pin is missing or does not match`,
    );
  }
}

export function verifyManifestVersionParity(repoRoot, pkgDir) {
  const versionTsPath = path.join(repoRoot, "packages", "mcp-server", "src", "version.ts");
  const expectedVersion = extractServerVersion(readFileSync(versionTsPath, "utf8"));
  if (!SEMVER_PATTERN.test(expectedVersion)) {
    throw new Error(
      `[build:package] SERVER_VERSION is not a valid SemVer version: "${expectedVersion}"`,
    );
  }

  const rootPkg = readJson(path.join(repoRoot, "package.json"));
  assertEqual(rootPkg.version, expectedVersion, "package.json#version");

  const distPkg = readJson(path.join(pkgDir, "package.json"));
  assertEqual(distPkg.version, expectedVersion, "packages/causoryn/package.json#version");

  const serverJson = readJson(path.join(repoRoot, "server.json"));
  assertEqual(serverJson.name, "io.github.mrbekox/causoryn", "server.json#name");
  assertEqual(distPkg.mcpName, serverJson.name, "packages/causoryn/package.json#mcpName");
  assertEqual(serverJson.version, expectedVersion, "server.json#version");
  assertEqual(
    serverJson.packages?.[0]?.version,
    expectedVersion,
    "server.json#packages[0].version",
  );
  assertEqual(
    serverJson.packages?.[0]?.registryBaseUrl,
    "https://registry.npmjs.org",
    "server.json#packages[0].registryBaseUrl",
  );

  const serverPkgArgs = serverJson.packages?.[0]?.packageArguments;
  if (!Array.isArray(serverPkgArgs) || serverPkgArgs.length === 0) {
    throw new Error("[build:package] server.json#packages[0].packageArguments is missing or empty");
  }
  for (const argSpec of serverPkgArgs) {
    if (
      argSpec?.type === "named" &&
      (argSpec?.name === "--allow-cwd" || argSpec?.name === "--auto-data-dir")
    ) {
      throw new Error(
        `[build:package] server.json packageArguments contains a forbidden 'named' flag (${argSpec.name}); it must be a fixed 'positional' argument`,
      );
    }
    if (argSpec?.type !== "positional" || typeof argSpec?.value !== "string" || argSpec.value.length === 0) {
      throw new Error(
        `[build:package] server.json packageArguments must contain only fixed 'positional' arguments: ${JSON.stringify(argSpec)}`,
      );
    }
  }
  const positionalValues = serverPkgArgs.map((item) => item.value);
  for (const requiredArg of ["mcp", "--allow-cwd", "--auto-data-dir"]) {
    if (!positionalValues.includes(requiredArg)) {
      throw new Error(
        `[build:package] server.json packageArguments is missing a required positional argument: ${requiredArg}`,
      );
    }
  }

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
      throw new Error(`[build:package] ${relMkt} plugins[0] is missing`);
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
        `[build:package] ${relMcp} mcpServers.causoryn.args does not contain "${expectedPinnedSpec}"`,
      );
    }
  }

  for (const relPkgManifest of [
    path.join(".claude-plugin", "plugin.json"),
    path.join(".zcode-plugin", "plugin.json"),
    path.join(".codex-plugin", "plugin.json"),
    "plugin.json",
  ]) {
    const doc = readJson(path.join(pkgDir, relPkgManifest));
    assertEqual(doc.version, expectedVersion, `packages/causoryn/${relPkgManifest}#version`);
    if (
      relPkgManifest === path.join(".claude-plugin", "plugin.json") ||
      relPkgManifest === path.join(".zcode-plugin", "plugin.json")
    ) {
      assertLauncherExpectedVersion(
        doc.mcpServers?.causoryn?.args,
        expectedVersion,
        `packages/causoryn/${relPkgManifest}#mcpServers.causoryn.args`,
      );
    }
  }

  const pkgAgyMcp = readJson(path.join(pkgDir, "mcp_config.json"));
  assertLauncherExpectedVersion(
    pkgAgyMcp.mcpServers?.causoryn?.args,
    expectedVersion,
    "packages/causoryn/mcp_config.json#mcpServers.causoryn.args",
  );

  const codexPkgMcp = readJson(path.join(pkgDir, ".codex-plugin", "mcp.json"));
  assertLauncherExpectedVersion(
    codexPkgMcp.mcpServers?.causoryn?.args,
    expectedVersion,
    "packages/causoryn/.codex-plugin/mcp.json#mcpServers.causoryn.args",
  );

  return expectedVersion;
}

export function copyNativeFiltered(srcDir, destDir, workerName) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !NATIVE_HIDDEN_ENTRY_ALLOWLIST.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_NATIVE_DIR_NAMES.has(entry.name)) continue;
      // go-worker/bin yalnızca test sahte ikililerini barındırır;
      // roslyn-worker/bin kopyalanmaz — 5 taşınabilir dosya ayrıca düz sahnelenir.
      if ((workerName === "go-worker" || workerName === "roslyn-worker") && entry.name === "bin") {
        continue;
      }
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
      lower.endsWith(".user") ||
      lower.endsWith(".resources.dll")
    ) {
      continue;
    }
    // Roslyn portable DLL ayrıca düz sahnelenir; Windows-özgü apphost .exe taşınmaz
    if (workerName === "roslyn-worker" && lower.endsWith(".exe")) {
      continue;
    }
    copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
}

function stageRoslynPortableRuntimeFlat(srcRoslynDir, destRoslynDir) {
  const releaseDir = path.join(srcRoslynDir, "bin", "Release", "net10.0");
  const debugDir = path.join(srcRoslynDir, "bin", "Debug", "net10.0");

  let buildOutputDir = null;
  if (existsSync(path.join(releaseDir, "Causoryn.RoslynWorker.dll"))) {
    buildOutputDir = releaseDir;
  } else if (existsSync(path.join(debugDir, "Causoryn.RoslynWorker.dll"))) {
    buildOutputDir = debugDir;
  }

  if (buildOutputDir === null) {
    throw new Error(
      "[build:package] compiled Causoryn.RoslynWorker.dll not found (bin/Release/net10.0 or bin/Debug/net10.0). " +
        "Run `dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en` first.",
    );
  }

  for (const fileName of ROSLYN_PORTABLE_RUNTIME_FILES) {
    const srcFile = path.join(buildOutputDir, fileName);
    if (!existsSync(srcFile)) {
      throw new Error(
        `[build:package] required Roslyn runtime file is missing (${fileName}): ${srcFile}`,
      );
    }
  }

  const workerDllPath = path.join(buildOutputDir, "Causoryn.RoslynWorker.dll");
  scanRoslynBinaryClean(workerDllPath);

  for (const fileName of ROSLYN_PORTABLE_RUNTIME_FILES) {
    copyFileSync(path.join(buildOutputDir, fileName), path.join(destRoslynDir, fileName));
  }

  return buildOutputDir;
}

function normalizeLf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

function resolveBundledNpmPackages(repoRoot, mcpServerPkgDir, metafile) {
  const packageDirs = new Set();
  const inputs = metafile?.inputs ?? {};
  for (const inputKey of Object.keys(inputs)) {
    const segments = inputKey.split("node_modules/");
    if (segments.length <= 1) continue;
    const tail = segments[segments.length - 1];
    const pkgMatch = tail.match(/^(@[^/]+\/[^/]+|[^/]+)\//);
    if (!pkgMatch) continue;
    const prefix = `${segments.slice(0, -1).join("node_modules/")}node_modules/${pkgMatch[1]}`;
    packageDirs.add(path.resolve(mcpServerPkgDir, prefix));
  }
  packageDirs.add(path.join(repoRoot, "node_modules", "better-sqlite3"));

  const byKey = new Map();
  for (const dir of [...packageDirs].sort()) {
    const pkgJsonPath = path.join(dir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      throw new Error(`[build:package] package metadata file not found: ${pkgJsonPath}`);
    }
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const name = String(pkgJson.name ?? "");
    const version = String(pkgJson.version ?? "");
    const license =
      typeof pkgJson.license === "string"
        ? pkgJson.license
        : typeof pkgJson.license?.type === "string"
          ? pkgJson.license.type
          : "UNKNOWN";
    const key = `${name}@${version}`;
    if (byKey.has(key)) continue;

    const licenseCandidate = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE"].find((f) =>
      existsSync(path.join(dir, f)),
    );
    if (!licenseCandidate) {
      throw new Error(`[build:package] license file not found (${key}): ${dir}`);
    }
    const licenseText = normalizeLf(readFileSync(path.join(dir, licenseCandidate), "utf8"));
    const homepage =
      typeof pkgJson.homepage === "string"
        ? pkgJson.homepage
        : typeof pkgJson.repository === "string"
          ? pkgJson.repository
          : typeof pkgJson.repository?.url === "string"
            ? pkgJson.repository.url
            : "";

    byKey.set(key, {
      name,
      version,
      license,
      homepage,
      licenseFile: licenseCandidate,
      licenseText,
    });
  }

  return [...byKey.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
  );
}

function parseRoslynDepsVersions(roslynDepsJsonPath) {
  const deps = readJson(roslynDepsJsonPath);
  const libraries = deps?.libraries ?? {};
  const roslynPackages = [];
  for (const key of Object.keys(libraries).sort()) {
    if (key.startsWith("Microsoft.CodeAnalysis.")) {
      const [name, version] = key.split("/");
      roslynPackages.push({ name, version: version ?? "5.0.0" });
    }
  }
  return roslynPackages;
}

function parseRustCargoLockCrates(cargoLockPath) {
  if (!existsSync(cargoLockPath)) {
    return [];
  }
  const raw = readFileSync(cargoLockPath, "utf8");
  const blocks = raw.split(/\r?\n\[\[package\]\]\r?\n/).slice(1);
  const crates = [];
  for (const block of blocks) {
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    const versionMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    const sourceMatch = block.match(/^source\s*=\s*"([^"]+)"/m);
    if (nameMatch && versionMatch && sourceMatch) {
      crates.push({
        name: nameMatch[1],
        version: versionMatch[1],
        source: sourceMatch[1],
      });
    }
  }
  return crates.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
  );
}

function stageThirdPartyLicensesAndNotices({
  repoRoot,
  pkgDir,
  mcpServerPkgDir,
  metafile,
  roslynDepsJsonPath,
}) {
  const tsDir = path.join(repoRoot, "node_modules", "typescript");
  const sqliteDir = path.join(repoRoot, "node_modules", "better-sqlite3");
  const licensesDestDir = path.join(pkgDir, "licenses");
  rmSync(licensesDestDir, { recursive: true, force: true });
  mkdirSync(licensesDestDir, { recursive: true });

  const standaloneLicenseCopies = [
    [path.join(tsDir, "LICENSE.txt"), path.join(licensesDestDir, "Apache-2.0.txt")],
    [
      path.join(tsDir, "ThirdPartyNoticeText.txt"),
      path.join(licensesDestDir, "TypeScript-ThirdPartyNoticeText.txt"),
    ],
    [path.join(sqliteDir, "LICENSE"), path.join(licensesDestDir, "better-sqlite3-LICENSE.txt")],
  ];
  for (const [src, dest] of standaloneLicenseCopies) {
    if (!existsSync(src)) {
      throw new Error(`[build:package] required third-party license file is missing: ${src}`);
    }
    copyFileSync(src, dest);
  }

  const npmComponents = resolveBundledNpmPackages(repoRoot, mcpServerPkgDir, metafile);
  const roslynComponents = parseRoslynDepsVersions(roslynDepsJsonPath);
  const rustCrates = parseRustCargoLockCrates(
    path.join(repoRoot, "native", "rust-worker", "Cargo.lock"),
  );

  const lines = [
    "# Third-Party Software Notices and Licenses",
    "",
    "Causoryn is licensed under the MIT License (see `LICENSE`).",
    "This published npm package bundles or redistributes the following third-party software components.",
    "All copyright notices, license texts, and attributions below are preserved verbatim.",
    "",
    "Standalone full-text license and notice files shipped in `licenses/`:",
    "- `licenses/Apache-2.0.txt` (Apache License 2.0 — TypeScript)",
    "- `licenses/TypeScript-ThirdPartyNoticeText.txt` (TypeScript Third-Party Notices)",
    "- `licenses/better-sqlite3-LICENSE.txt` (MIT License — better-sqlite3)",
    "",
    "---",
    "",
    "## 1. Bundled & Vendored JavaScript / Native Node.js Components",
    "",
  ];

  for (const comp of npmComponents) {
    lines.push(`### ${comp.name} (${comp.version}) — ${comp.license}`);
    lines.push("");
    if (comp.homepage.length > 0) {
      lines.push(`- Homepage / Repository: ${comp.homepage}`);
    }
    if (comp.name === "typescript") {
      lines.push(
        "- Additional bundled notices: `licenses/Apache-2.0.txt`, `licenses/TypeScript-ThirdPartyNoticeText.txt`, and `dist/mcp-server.mjs.LEGAL.txt`",
      );
    }
    lines.push("");
    lines.push("```text");
    lines.push(comp.licenseText);
    lines.push("```");
    lines.push("");
  }

  lines.push("### SQLite (embedded in better-sqlite3 prebuilt native addons) — Public Domain");
  lines.push("");
  lines.push("- Homepage: https://www.sqlite.org/copyright.html");
  lines.push("");
  lines.push("```text");
  lines.push(
    "All of the code and documentation in SQLite has been dedicated to the public domain by the authors.",
  );
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 2. Redistributed .NET / Roslyn Assemblies (`native/roslyn-worker/`)");
  lines.push("");

  for (const roslynPkg of roslynComponents) {
    lines.push(`### ${roslynPkg.name} (${roslynPkg.version}) — MIT`);
    lines.push("");
    lines.push("- Upstream repository: https://github.com/dotnet/roslyn");
    lines.push(
      "- Upstream third-party notices: https://github.com/dotnet/roslyn/blob/main/ThirdPartyNotices.txt",
    );
    lines.push("");
    lines.push("```text");
    lines.push("The MIT License (MIT)");
    lines.push("");
    lines.push("Copyright (c) .NET Foundation and Contributors");
    lines.push("Copyright (c) Microsoft Corporation. All rights reserved.");
    lines.push("");
    lines.push(MIT_LICENSE_TEMPLATE);
    lines.push("```");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 3. Optional Local-Build Rust Sidecar Crates (`native/rust-worker/Cargo.lock`, Informational)");
  lines.push("");
  lines.push(
    "Causoryn ships source files only for `native/rust-worker/` (no precompiled Rust binaries are bundled in this npm package).",
  );
  lines.push(
    "When a user optionally builds the Rust sidecar locally with Cargo, the locked crates.io dependencies in `Cargo.lock` are:",
  );
  lines.push("");
  for (const crate of rustCrates) {
    lines.push(`- \`${crate.name}\` \`${crate.version}\` (crates.io — see upstream crate license in Cargo.lock / crates.io)`);
  }
  lines.push("");

  const noticesPath = path.join(pkgDir, "THIRD-PARTY-NOTICES.md");
  writeFileSync(noticesPath, `${lines.join("\n")}`, "utf8");
}

export function stageVerifiedBundleArtifacts(options) {
  const resolvedMcpDist = path.resolve(options.mcpDistDir);
  const resolvedPkgDist = path.resolve(options.pkgDistDir);
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 300;

  mkdirSync(resolvedPkgDist, { recursive: true });

  const bundleSrc = path.join(resolvedMcpDist, "mcp-server.mjs");
  const bundleLegalSrc = path.join(resolvedMcpDist, "mcp-server.mjs.LEGAL.txt");
  const workerBundleSrc = path.join(resolvedMcpDist, "index-worker.mjs");
  const bundleManifestSrc = path.join(resolvedMcpDist, "bundle-manifest.json");
  const vendorNodeModulesSrc = path.join(resolvedMcpDist, "node_modules");

  const destBundle = path.join(resolvedPkgDist, "mcp-server.mjs");
  const destLegal = path.join(resolvedPkgDist, "mcp-server.mjs.LEGAL.txt");
  const destWorkerBundle = path.join(resolvedPkgDist, "index-worker.mjs");
  const destManifest = path.join(resolvedPkgDist, "bundle-manifest.json");
  const destVendorNodeModules = path.join(resolvedPkgDist, "node_modules");
  const pkgDistBoundary = resolvedPkgDist.endsWith(path.sep)
    ? resolvedPkgDist
    : `${resolvedPkgDist}${path.sep}`;

  let lastError = null;
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    try {
      for (const [reqPath, label] of [
        [bundleSrc, "packages/mcp-server/dist/mcp-server.mjs (run build:bundle first)"],
        [bundleManifestSrc, "packages/mcp-server/dist/bundle-manifest.json"],
        [path.join(vendorNodeModulesSrc, "better-sqlite3", "package.json"), "vendored better-sqlite3"],
      ]) {
        if (!existsSync(reqPath)) {
          throw new Error(`[build:package] missing prerequisite (${label}) [ENOENT]: ${reqPath}`);
        }
      }

      copyFileSync(bundleSrc, destBundle);
      if (existsSync(bundleLegalSrc)) {
        copyFileSync(bundleLegalSrc, destLegal);
      } else {
        rmSync(destLegal, { force: true });
      }
      if (existsSync(workerBundleSrc)) {
        copyFileSync(workerBundleSrc, destWorkerBundle);
      } else {
        rmSync(destWorkerBundle, { force: true });
      }
      copyFileSync(bundleManifestSrc, destManifest);
      rmSync(destVendorNodeModules, { recursive: true, force: true });
      cpSync(vendorNodeModulesSrc, destVendorNodeModules, { recursive: true });

      const parsed = JSON.parse(readFileSync(destManifest, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("[build:package] the bundle-manifest.json root value is not an object");
      }
      const filesMap = parsed.files;
      if (typeof filesMap !== "object" || filesMap === null || Array.isArray(filesMap)) {
        throw new Error("[build:package] the bundle-manifest.json files field is not an object");
      }
      const entries = Object.entries(filesMap);
      if (entries.length === 0 || typeof filesMap["mcp-server.mjs"] !== "string") {
        throw new Error("[build:package] bundle-manifest.json has no mcp-server.mjs entry");
      }

      const postCopySrcManifest = JSON.parse(readFileSync(bundleManifestSrc, "utf8"));
      if (postCopySrcManifest?.files?.["mcp-server.mjs"] !== filesMap["mcp-server.mjs"]) {
        throw new Error(
          "[build:package] SHA-256 manifest torn read: the source bundle-manifest.json changed while it was being copied",
        );
      }

      for (const [relPath, expectedSha] of entries) {
        if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha)) {
          throw new Error(
            `[build:package] invalid SHA-256 digest (${relPath}): ${String(expectedSha)}`,
          );
        }
        const stagedFile = path.resolve(resolvedPkgDist, ...relPath.split("/"));
        if (!stagedFile.startsWith(pkgDistBoundary)) {
          throw new Error(`[build:package] invalid bundle-manifest path: ${relPath}`);
        }
        const actualSha = createHash("sha256").update(readFileSync(stagedFile)).digest("hex");
        if (actualSha !== expectedSha.toLowerCase()) {
          throw new Error(
            `[build:package] bundle-manifest SHA-256 mismatch (${relPath}): expected ${expectedSha}, found ${actualSha}`,
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
  rmSync(destLegal, { force: true });
  rmSync(destWorkerBundle, { force: true });
  rmSync(destManifest, { force: true });
  rmSync(destVendorNodeModules, { recursive: true, force: true });
  throw new Error(
    `[build:package] bundle verification failed after ${String(maxRetries)} retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function stageCausorynPackage(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const pkgDir = path.resolve(options.pkgDir ?? DEFAULT_PKG_DIR);

  const version = verifyManifestVersionParity(repoRoot, pkgDir);

  const compiledCliEntry = path.join(pkgDir, "dist", "index.js");
  if (!existsSync(compiledCliEntry)) {
    throw new Error(
      `[build:package] missing prerequisite (compiled packages/causoryn CLI; run npm run build first): ${compiledCliEntry}`,
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
    throw new Error(`[build:package] cli-stdio entry point not found: ${cliStdioEntry}`);
  }
  const pkgBundlePath = path.join(pkgDistDir, "mcp-server.mjs");
  const pkgLegalPath = path.join(pkgDistDir, "mcp-server.mjs.LEGAL.txt");
  rmSync(pkgLegalPath, { force: true });
  const buildResult = buildSync({
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
    legalComments: "linked",
    metafile: true,
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
  if (existsSync(pkgLegalPath)) {
    pkgManifestObj.files["mcp-server.mjs.LEGAL.txt"] = createHash("sha256")
      .update(readFileSync(pkgLegalPath))
      .digest("hex");
  } else {
    delete pkgManifestObj.files["mcp-server.mjs.LEGAL.txt"];
  }
  writeFileSync(pkgManifestPath, `${JSON.stringify(pkgManifestObj, null, 2)}\n`, "utf8");

  // 2) TypeScript lib*.d.ts -> packages/causoryn/dist/typescript-lib/
  const tsLibSrcDir = path.join(repoRoot, "node_modules", "typescript", "lib");
  if (!existsSync(tsLibSrcDir)) {
    throw new Error(`[build:package] TypeScript lib directory not found: ${tsLibSrcDir}`);
  }
  const tsLibDestDir = path.join(pkgDistDir, "typescript-lib");
  rmSync(tsLibDestDir, { recursive: true, force: true });
  mkdirSync(tsLibDestDir, { recursive: true });
  const dtsFiles = readdirSync(tsLibSrcDir)
    .filter((name) => /^lib(\..+)?\.d\.ts$/.test(name))
    .sort();
  if (!dtsFiles.includes("lib.es2022.full.d.ts")) {
    throw new Error("[build:package] lib.es2022.full.d.ts not found");
  }
  for (const dtsName of dtsFiles) {
    copyFileSync(path.join(tsLibSrcDir, dtsName), path.join(tsLibDestDir, dtsName));
  }

  // 3) native/{python-worker,go-worker,rust-worker,roslyn-worker} + düz Roslyn runtime
  const pkgNativeDir = path.join(pkgDir, "native");
  rmSync(pkgNativeDir, { recursive: true, force: true });
  mkdirSync(pkgNativeDir, { recursive: true });
  for (const workerName of NATIVE_WORKER_DIRS) {
    const srcWorker = path.join(repoRoot, "native", workerName);
    if (!existsSync(srcWorker)) {
      throw new Error(`[build:package] native worker not found: ${srcWorker}`);
    }
    const destWorker = path.join(pkgNativeDir, workerName);
    copyNativeFiltered(srcWorker, destWorker, workerName);
    if (workerName === "roslyn-worker") {
      stageRoslynPortableRuntimeFlat(srcWorker, destWorker);
    }
  }

  // 4) Kök skills/ -> packages/causoryn/skills/
  const rootSkillsDir = path.join(repoRoot, "skills");
  if (!existsSync(rootSkillsDir)) {
    throw new Error(`[build:package] root skills/ directory not found: ${rootSkillsDir}`);
  }
  const pkgSkillsDir = path.join(pkgDir, "skills");
  rmSync(pkgSkillsDir, { recursive: true, force: true });
  cpSync(rootSkillsDir, pkgSkillsDir, { recursive: true });
  const stagedSkillCount = readdirSync(pkgSkillsDir, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  ).length;

  // 5) Kök LICENSE -> packages/causoryn/LICENSE
  const rootLicense = path.join(repoRoot, "LICENSE");
  if (!existsSync(rootLicense)) {
    throw new Error(`[build:package] root LICENSE not found: ${rootLicense}`);
  }
  copyFileSync(rootLicense, path.join(pkgDir, "LICENSE"));

  // 6) Üçüncü-parti lisans dosyaları ve deterministik THIRD-PARTY-NOTICES.md
  stageThirdPartyLicensesAndNotices({
    repoRoot,
    pkgDir,
    mcpServerPkgDir,
    metafile: buildResult.metafile,
    roslynDepsJsonPath: path.join(
      pkgNativeDir,
      "roslyn-worker",
      "Causoryn.RoslynWorker.deps.json",
    ),
  });

  return {
    version,
    typescriptLibFileCount: dtsFiles.length,
    skillCount: stagedSkillCount,
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    const summary = stageCausorynPackage();
    console.error(
      `[build:package] ok — staged causoryn@${summary.version} (ts-lib: ${String(summary.typescriptLibFileCount)} d.ts, native: 4 worker + flat Roslyn DLL, skills: ${String(summary.skillCount)}, LICENSE + THIRD-PARTY-NOTICES.md)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
