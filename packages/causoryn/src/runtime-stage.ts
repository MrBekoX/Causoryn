import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertNoLinkedComponents,
  assertPrivateDirectory,
  removeTreeNoFollow,
  restrictTreeToOwner,
} from "./fs-guard.js";
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

/** lstat-based existence check (a dangling link counts as existing). */
function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isWithinDir(candidatePath: string, parentDir: string): boolean {
  const cand = normalizeForComparison(candidatePath);
  const parent = normalizeForComparison(parentDir);
  if (cand === parent) return true;
  const boundary = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return cand.startsWith(boundary);
}

/**
 * True when `candidatePath` is `dir` or lies below it, compared as given and
 * with links resolved (case-insensitive on Windows).
 */
export function isAtOrBelowDir(candidatePath: string, dir: string): boolean {
  if (isWithinDir(candidatePath, dir)) return true;
  const realCandidate = safeRealpath(candidatePath);
  const realDir = safeRealpath(dir);
  return (
    (realCandidate !== null && isWithinDir(realCandidate, dir)) ||
    (realDir !== null && isWithinDir(candidatePath, realDir)) ||
    (realCandidate !== null && realDir !== null && isWithinDir(realCandidate, realDir))
  );
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

  const homeDir = path.resolve(options.homeDir);
  const baseCausorynDir = path.join(homeDir, ".causoryn");
  const targetDir = path.join(baseCausorynDir, "runtime");

  if (isSameRuntimeDir(sourceDir, targetDir)) {
    return {
      runtimeDir: targetDir,
      cliEntryPath: path.join(targetDir, "scripts", "causoryn.mjs"),
      launcherPath: path.join(targetDir, "scripts", "plugin-mcp-launcher.mjs"),
    };
  }

  // CWE-59: neither ~/.causoryn nor ~/.causoryn/runtime may be a link (links
  // above the home directory are fine). Checked again after mkdir.
  assertNoLinkedComponents(targetDir, homeDir, { includeTarget: true });
  mkdirSync(baseCausorynDir, { recursive: true, mode: 0o700 });
  assertNoLinkedComponents(targetDir, homeDir, { includeTarget: true });
  // CWE-732: mkdir applies 0700 only to a directory it creates. An existing
  // ~/.causoryn that another user owns or may write to would let that user
  // swap the staged runtime every host config points at, so it is refused.
  assertPrivateDirectory(baseCausorynDir, "cli/runtime-stage-failed", options.directoryProbe);

  const stamp = `${String(process.pid)}-${String(Date.now())}-${randomBytes(6).toString("hex")}`;
  const stagingDir = path.join(baseCausorynDir, `.runtime-stage-${stamp}`);
  const backupDir = path.join(baseCausorynDir, `.runtime-prev-${stamp}`);

  // Non-recursive mkdir fails with EEXIST if anything already sits at the
  // (unpredictable) staging name, so a planted entry is never reused.
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
  } catch (error) {
    throw new CausorynCliError(
      "cli/runtime-stage-failed",
      `Could not create the runtime staging directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    for (const entry of RUNTIME_STAGE_ENTRIES) {
      const srcEntry = path.join(sourceDir, entry);
      if (!existsSync(srcEntry)) continue;
      cpSync(srcEntry, path.join(stagingDir, entry), { recursive: true });
    }
    // cpSync keeps the source's modes, which follow the umask the package was
    // unpacked with (0775 directories under umask 002). Uninstall removes only
    // a private tree (F39), and no other user may change the runtime every
    // host config runs, so the staged tree is made private before it is
    // published; the staging name is unpredictable and ~/.causoryn private.
    restrictTreeToOwner(stagingDir, options.stagedModeFs);

    const hadPrevious = pathExists(targetDir);
    if (hadPrevious) {
      if (pathExists(backupDir)) {
        throw new CausorynCliError(
          "cli/runtime-stage-failed",
          `Refusing to reuse an existing runtime backup path: ${backupDir}`,
        );
      }
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

    if (hadPrevious) {
      removeTreeNoFollow(backupDir);
    }
  } catch (error) {
    try {
      removeTreeNoFollow(stagingDir);
    } catch {
      // Best-effort cleanup; the original error is reported below.
    }
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
