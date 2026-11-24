import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CausorynCliError,
  type StagePersistentRuntimeOptions,
  type StagePersistentRuntimeResult,
} from "./types.js";

/**
 * Geçici `_npx` / `os.tmpdir()` çalışma dizini tespiti ve `~/.causoryn/runtime`
 * altına atomik sahneleme yardımcısı (`K-021`).
 */

const RUNTIME_STAGE_ENTRIES = [
  "package.json",
  "scripts",
  "dist",
  "native",
  "skills",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "licenses",
  "README.md",
  "plugin.json",
  "mcp_config.json",
  ".claude-plugin",
  ".zcode-plugin",
  ".codex-plugin",
] as const;

function normalizeForComparison(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function safeRealpath(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isWithinDir(candidatePath: string, parentDir: string): boolean {
  const cand = normalizeForComparison(candidatePath);
  const parent = normalizeForComparison(parentDir);
  if (cand === parent) return true;
  const boundary = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return cand.startsWith(boundary);
}

export function getPersistentRuntimeDir(homeDir: string): string {
  return path.join(homeDir, ".causoryn", "runtime");
}

export function isSameRuntimeDir(dirA: string, dirB: string): boolean {
  const normA = normalizeForComparison(dirA);
  const normB = normalizeForComparison(dirB);
  if (normA === normB) {
    return true;
  }
  const realA = safeRealpath(dirA);
  const realB = safeRealpath(dirB);
  if (realA !== null && normalizeForComparison(realA) === normB) {
    return true;
  }
  if (realB !== null && normA === normalizeForComparison(realB)) {
    return true;
  }
  if (realA !== null && realB !== null && normalizeForComparison(realA) === normalizeForComparison(realB)) {
    return true;
  }
  return false;
}

export function isEphemeralRuntimeDir(
  runtimeDir: string,
  options?: { readonly tmpDir?: string | undefined },
): boolean {
  const resolved = path.resolve(runtimeDir);
  const segments = resolved.split(/[\\/]+/).map((seg) => seg.toLowerCase());
  if (segments.includes("_npx") || segments.includes(".npx")) {
    return true;
  }

  const effectiveTmp = options?.tmpDir ?? os.tmpdir();
  if (isWithinDir(resolved, effectiveTmp)) {
    return true;
  }

  const realCandidate = safeRealpath(resolved);
  const realTmp = safeRealpath(effectiveTmp);
  if (realCandidate !== null && isWithinDir(realCandidate, effectiveTmp)) {
    return true;
  }
  if (realTmp !== null && isWithinDir(resolved, realTmp)) {
    return true;
  }
  if (realCandidate !== null && realTmp !== null && isWithinDir(realCandidate, realTmp)) {
    return true;
  }

  return false;
}

export function stagePersistentRuntime(
  options: StagePersistentRuntimeOptions,
): StagePersistentRuntimeResult {
  const sourceDir = path.resolve(options.sourcePackageDir);
  const requiredFiles = [
    path.join(sourceDir, "package.json"),
    path.join(sourceDir, "scripts", "causoryn.mjs"),
    path.join(sourceDir, "dist", "mcp-server.mjs"),
  ];

  for (const reqFile of requiredFiles) {
    if (!existsSync(reqFile)) {
      throw new CausorynCliError(
        "cli/runtime-stage-failed",
        `A runtime file required for staging is missing: ${reqFile}`,
      );
    }
  }

  const baseCausorynDir = path.join(path.resolve(options.homeDir), ".causoryn");
  const targetDir = path.join(baseCausorynDir, "runtime");

  if (isSameRuntimeDir(sourceDir, targetDir)) {
    return {
      runtimeDir: targetDir,
      cliEntryPath: path.join(targetDir, "scripts", "causoryn.mjs"),
      launcherPath: path.join(targetDir, "scripts", "plugin-mcp-launcher.mjs"),
    };
  }

  mkdirSync(baseCausorynDir, { recursive: true, mode: 0o700 });

  const stamp = `${String(process.pid)}-${String(Date.now())}`;
  const stagingDir = path.join(baseCausorynDir, `.runtime-stage-${stamp}`);
  const backupDir = path.join(baseCausorynDir, `.runtime-prev-${stamp}`);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  try {
    for (const entry of RUNTIME_STAGE_ENTRIES) {
      const srcEntry = path.join(sourceDir, entry);
      if (!existsSync(srcEntry)) continue;
      cpSync(srcEntry, path.join(stagingDir, entry), { recursive: true });
    }

    const hadPrevious = existsSync(targetDir);
    if (hadPrevious) {
      rmSync(backupDir, { recursive: true, force: true });
      renameSync(targetDir, backupDir);
    }

    try {
      renameSync(stagingDir, targetDir);
    } catch (swapError) {
      if (hadPrevious && existsSync(backupDir) && !existsSync(targetDir)) {
        try {
          renameSync(backupDir, targetDir);
        } catch {
          // Yedek geri yükleme başarısızsa orijinal hatayı yükselt
        }
      }
      throw swapError;
    }

    if (hadPrevious && existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof CausorynCliError) throw error;
    throw new CausorynCliError(
      "cli/runtime-stage-failed",
      `Could not stage the persistent runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    runtimeDir: targetDir,
    cliEntryPath: path.join(targetDir, "scripts", "causoryn.mjs"),
    launcherPath: path.join(targetDir, "scripts", "plugin-mcp-launcher.mjs"),
  };
}
