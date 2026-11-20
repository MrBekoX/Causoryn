#!/usr/bin/env node
/**
 * Fail-closed `prepack` readiness gate for `packages/causoryn` (K-021 / F-P0-02 / F-P1-01).
 *
 * Verifies every release artifact BEFORE `npm pack` or `npm publish`:
 * 1. `dist/mcp-server.mjs`, `dist/bundle-manifest.json`, `dist/node_modules/better-sqlite3/LICENSE`,
 *    and `dist/typescript-lib/lib.es2022.full.d.ts` exist and every `bundle-manifest.json` entry
 *    matches its recorded SHA-256.
 * 2. `THIRD-PARTY-NOTICES.md` and `licenses/{Apache-2.0.txt,TypeScript-ThirdPartyNoticeText.txt,better-sqlite3-LICENSE.txt}`
 *    exist and preserve all required copyright/license notices.
 * 3. `native/roslyn-worker/{Causoryn.RoslynWorker.dll,Microsoft.CodeAnalysis.CSharp.dll}` exist,
 *    ZERO localized `*.resources.dll` files exist under `native/roslyn-worker`, and binary scan
 *    of `Causoryn.RoslynWorker.dll` finds ZERO leaked user paths (`Users\`, `/Users/`, `/home/`)
 *    or `.pdb` references.
 * 4. `package.json#mcpName === "io.github.mrbekox/causoryn"`.
 * 5. Published entry scripts (`causoryn.mjs`, `plugin-mcp-launcher.mjs`, `lib/node-version-guard.mjs`)
 *    contain ZERO `\r` (0x0d) bytes (pure LF).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PKG_DIR = path.dirname(SCRIPT_DIR);

const EXPECTED_MCP_NAME = "io.github.mrbekox/causoryn";

const REQUIRED_NOTICE_STRINGS = [
  "Apache License",
  "Gary Court",
  "Anthropic, PBC",
  "Colin McDonnell",
  "Evgeny Poberezkin",
  "Joshua Wise",
  "Microsoft Corporation",
];

const REQUIRED_LICENSE_FILES = [
  path.join("licenses", "Apache-2.0.txt"),
  path.join("licenses", "TypeScript-ThirdPartyNoticeText.txt"),
  path.join("licenses", "better-sqlite3-LICENSE.txt"),
];

const PURE_LF_SCRIPTS = [
  path.join("scripts", "causoryn.mjs"),
  path.join("scripts", "plugin-mcp-launcher.mjs"),
  path.join("scripts", "lib", "node-version-guard.mjs"),
];

const LEAKED_BINARY_PATTERNS = [
  { label: "Windows user path", pattern: /[A-Za-z]:\\Users\\/i },
  { label: "macOS user path", pattern: /\/Users\// },
  { label: "Linux home path", pattern: /\/home\// },
  { label: "PDB reference", pattern: /\.pdb\b/i },
];

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function collectFilesRecursive(rootDir) {
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  };
  walk(rootDir);
  return results;
}

export function scanRoslynBinaryClean(dllPath) {
  const raw = readFileSync(dllPath);
  const latin1 = raw.toString("latin1");
  const utf16 = raw.toString("utf16le");
  for (const check of LEAKED_BINARY_PATTERNS) {
    if (check.pattern.test(latin1) || check.pattern.test(utf16)) {
      throw new Error(
        `[verify-package-ready] Roslyn binary contains leaked ${check.label} (${dllPath}) — rebuild with Release + -p:DebugType=none -p:ContinuousIntegrationBuild=true`,
      );
    }
  }
}

export function verifyPackageReady(pkgDir = DEFAULT_PKG_DIR) {
  const resolvedPkgDir = path.resolve(pkgDir);

  // 1) package.json#mcpName check
  const pkgJsonPath = path.join(resolvedPkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`[verify-package-ready] missing package.json: ${pkgJsonPath}`);
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (pkgJson?.mcpName !== EXPECTED_MCP_NAME) {
    throw new Error(
      `[verify-package-ready] package.json#mcpName mismatch: expected "${EXPECTED_MCP_NAME}", found "${String(pkgJson?.mcpName)}"`,
    );
  }

  const rootLicensePath = path.join(resolvedPkgDir, "LICENSE");
  if (!existsSync(rootLicensePath)) {
    throw new Error(`[verify-package-ready] missing package LICENSE: ${rootLicensePath}`);
  }

  // 2) Required dist files + bundle-manifest.json SHA-256 verification
  const distDir = path.join(resolvedPkgDir, "dist");
  const requiredDistPaths = [
    path.join(distDir, "index.js"),
    path.join(distDir, "mcp-server.mjs"),
    path.join(distDir, "mcp-server.mjs.LEGAL.txt"),
    path.join(distDir, "bundle-manifest.json"),
    path.join(distDir, "node_modules", "better-sqlite3", "LICENSE"),
    path.join(distDir, "typescript-lib", "lib.es2022.full.d.ts"),
  ];
  for (const reqPath of requiredDistPaths) {
    if (!existsSync(reqPath)) {
      throw new Error(`[verify-package-ready] missing required dist artifact: ${reqPath}`);
    }
  }

  const manifestPath = path.join(distDir, "bundle-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const filesMap = manifest?.files;
  if (typeof filesMap !== "object" || filesMap === null || Array.isArray(filesMap)) {
    throw new Error("[verify-package-ready] bundle-manifest.json files field must be an object");
  }
  const entries = Object.entries(filesMap);
  if (
    entries.length === 0 ||
    typeof filesMap["mcp-server.mjs"] !== "string" ||
    typeof filesMap["node_modules/better-sqlite3/LICENSE"] !== "string"
  ) {
    throw new Error(
      "[verify-package-ready] bundle-manifest.json must record mcp-server.mjs and node_modules/better-sqlite3/LICENSE",
    );
  }

  const distBoundary = distDir.endsWith(path.sep) ? distDir : `${distDir}${path.sep}`;
  for (const [relPath, expectedSha] of entries) {
    if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/i.test(expectedSha)) {
      throw new Error(
        `[verify-package-ready] invalid SHA-256 digest in bundle-manifest.json (${relPath}): ${String(expectedSha)}`,
      );
    }
    const targetFile = path.resolve(distDir, ...relPath.split("/"));
    if (!targetFile.startsWith(distBoundary)) {
      throw new Error(`[verify-package-ready] unsafe bundle-manifest path: ${relPath}`);
    }
    if (!existsSync(targetFile)) {
      throw new Error(`[verify-package-ready] bundle-manifest entry missing on disk: ${relPath}`);
    }
    const actualSha = sha256File(targetFile);
    if (actualSha !== expectedSha.toLowerCase()) {
      throw new Error(
        `[verify-package-ready] SHA-256 mismatch for ${relPath}: expected ${expectedSha}, found ${actualSha}`,
      );
    }
  }

  // 3) Third-party notices and standalone license texts
  const noticesPath = path.join(resolvedPkgDir, "THIRD-PARTY-NOTICES.md");
  if (!existsSync(noticesPath)) {
    throw new Error(`[verify-package-ready] missing THIRD-PARTY-NOTICES.md: ${noticesPath}`);
  }
  const noticesText = readFileSync(noticesPath, "utf8");
  for (const requiredNotice of REQUIRED_NOTICE_STRINGS) {
    if (!noticesText.includes(requiredNotice)) {
      throw new Error(
        `[verify-package-ready] THIRD-PARTY-NOTICES.md missing required attribution: "${requiredNotice}"`,
      );
    }
  }
  for (const relLic of REQUIRED_LICENSE_FILES) {
    const licPath = path.join(resolvedPkgDir, relLic);
    if (!existsSync(licPath)) {
      throw new Error(`[verify-package-ready] missing required license file: ${licPath}`);
    }
  }

  // 4) Flat Roslyn worker DLL staging, zero localized *.resources.dll, zero leaked user paths / .pdb
  const roslynDir = path.join(resolvedPkgDir, "native", "roslyn-worker");
  const roslynWorkerDll = path.join(roslynDir, "Causoryn.RoslynWorker.dll");
  const requiredRoslynFiles = [
    "Causoryn.RoslynWorker.dll",
    "Causoryn.RoslynWorker.deps.json",
    "Causoryn.RoslynWorker.runtimeconfig.json",
    "Microsoft.CodeAnalysis.dll",
    "Microsoft.CodeAnalysis.CSharp.dll",
  ];
  for (const fileName of requiredRoslynFiles) {
    const filePath = path.join(roslynDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`[verify-package-ready] missing Roslyn runtime artifact: ${filePath}`);
    }
  }
  const roslynFiles = collectFilesRecursive(roslynDir);
  for (const rf of roslynFiles) {
    const lower = rf.toLowerCase();
    if (lower.endsWith(".resources.dll")) {
      throw new Error(
        `[verify-package-ready] localized satellite assembly (*.resources.dll) must not be packaged: ${rf}`,
      );
    }
    if (lower.endsWith(".pdb")) {
      throw new Error(`[verify-package-ready] PDB debug symbols must not be packaged: ${rf}`);
    }
  }
  scanRoslynBinaryClean(roslynWorkerDll);

  // 5) Pure LF (zero 0x0d CR bytes) on executable CLI & launcher scripts
  for (const relScript of PURE_LF_SCRIPTS) {
    const scriptPath = path.join(resolvedPkgDir, relScript);
    if (!existsSync(scriptPath)) {
      throw new Error(`[verify-package-ready] missing entry script: ${scriptPath}`);
    }
    const rawBytes = readFileSync(scriptPath);
    if (rawBytes.includes(0x0d)) {
      throw new Error(
        `[verify-package-ready] ${relScript} contains CRLF (\\r) line endings; pure LF is required for POSIX shebangs`,
      );
    }
  }

  return {
    ok: true,
    verifiedFiles: entries.length,
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    const result = verifyPackageReady();
    console.error(
      `[verify-package-ready] ok — package ready (${String(result.verifiedFiles)} manifest files verified, licenses/NOTICE present, Roslyn DLL clean, scripts LF)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
