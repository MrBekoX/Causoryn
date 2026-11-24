import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { SCHEMA_VERSION } from "./schema.js";

/**
 * One-time migration from the legacy per-client workspace databases
 * (`graph-<client>.sqlite`, used up to v0.2.4) into the shared
 * `graph.sqlite` (Task 1.7).
 *
 * - Runs only when the target does not exist yet.
 * - Candidates are regular files (never symlinks) in the target's directory
 *   whose name matches `graph-<client>.sqlite`. Each is opened READ-ONLY and
 *   must pass `PRAGMA quick_check` and have `1 <= user_version <= SCHEMA_VERSION`.
 * - The newest valid candidate (max mtime of the file and its `-wal`) is
 *   copied with better-sqlite3's online `backup()` into a temp file next to
 *   the target, then published atomically without clobbering: `link()` (fails
 *   with EEXIST if another process won the race) or, where hard links are not
 *   supported, `rename()` when the target is still absent.
 * - Legacy files are left in place (doctor lists them). Schema migrations run
 *   later, when `SqliteGraphRepository` opens the new target.
 */

/** Legacy per-client DB name: `graph-${client.toLowerCase()}.sqlite`. */
export const LEGACY_WORKSPACE_DB_PATTERN = /^graph-[a-z0-9][a-z0-9._-]{0,63}\.sqlite$/;

export interface LegacyDbCandidateReport {
  readonly path: string;
  readonly valid: boolean;
  readonly reason?: string;
  readonly userVersion?: number;
  readonly mtimeMs?: number;
}

export type LegacyMigrationResult =
  | {
      readonly migrated: true;
      readonly source: string;
      readonly target: string;
      readonly sourceSchemaVersion: number;
      readonly candidates: readonly LegacyDbCandidateReport[];
    }
  | {
      readonly migrated: false;
      readonly reason:
        | "target-exists"
        | "no-legacy-files"
        | "no-valid-legacy-file"
        | "lost-race";
      readonly target: string;
      readonly candidates: readonly LegacyDbCandidateReport[];
    };

/** Lists legacy `graph-<client>.sqlite` files in `dataDir` (sorted by name). */
export function listLegacyWorkspaceDatabases(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => LEGACY_WORKSPACE_DB_PATTERN.test(name))
    .sort()
    .map((name) => path.join(dataDir, name));
}

function mtimeOf(filePath: string): number {
  let newest = statSync(filePath).mtimeMs;
  const walPath = `${filePath}-wal`;
  try {
    newest = Math.max(newest, statSync(walPath).mtimeMs);
  } catch {
    // No WAL side file.
  }
  return newest;
}

function inspectCandidate(filePath: string): LegacyDbCandidateReport {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { path: filePath, valid: false, reason: "not a regular file" };
    }
  } catch (error) {
    return { path: filePath, valid: false, reason: `stat failed: ${errorText(error)}` };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const version = db.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return { path: filePath, valid: false, reason: "unreadable user_version" };
    }
    if (version < 1) {
      return { path: filePath, valid: false, reason: "not a Causoryn database (user_version 0)", userVersion: version };
    }
    if (version > SCHEMA_VERSION) {
      return {
        path: filePath,
        valid: false,
        reason: `schema v${String(version)} is newer than supported v${String(SCHEMA_VERSION)}`,
        userVersion: version,
      };
    }
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") {
      return { path: filePath, valid: false, reason: `quick_check failed: ${String(check)}`, userVersion: version };
    }
    return { path: filePath, valid: true, userVersion: version, mtimeMs: mtimeOf(filePath) };
  } catch (error) {
    return { path: filePath, valid: false, reason: `open failed: ${errorText(error)}` };
  } finally {
    db?.close();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Migrates the newest valid legacy per-client DB into `targetPath` once.
 * Never throws for an invalid/absent legacy file; I/O failures while
 * publishing the copy propagate after the temp file is removed.
 */
export async function migrateLegacyWorkspaceDatabase(
  targetPath: string,
): Promise<LegacyMigrationResult> {
  const target = path.resolve(targetPath);
  if (existsSync(target)) {
    return { migrated: false, reason: "target-exists", target, candidates: [] };
  }
  const dataDir = path.dirname(target);
  const files = listLegacyWorkspaceDatabases(dataDir);
  if (files.length === 0) {
    return { migrated: false, reason: "no-legacy-files", target, candidates: [] };
  }
  const candidates = files.map(inspectCandidate);
  const valid = candidates
    .filter((candidate) => candidate.valid)
    .sort((a, b) => {
      const byTime = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
      return byTime !== 0 ? byTime : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  const chosen = valid[0];
  if (chosen === undefined) {
    return { migrated: false, reason: "no-valid-legacy-file", target, candidates };
  }

  const tempPath = path.join(
    dataDir,
    `.${path.basename(target)}.migrating-${String(process.pid)}-${randomUUID()}`,
  );
  const source = new Database(chosen.path, { readonly: true, fileMustExist: true });
  try {
    await source.backup(tempPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  } finally {
    source.close();
  }

  try {
    if (existsSync(target)) {
      return { migrated: false, reason: "lost-race", target, candidates };
    }
    try {
      linkSync(tempPath, target);
    } catch (error) {
      const code = errnoOf(error);
      if (code === "EEXIST") {
        return { migrated: false, reason: "lost-race", target, candidates };
      }
      // Filesystems without hard links: rename, still refusing to clobber.
      if (existsSync(target)) {
        return { migrated: false, reason: "lost-race", target, candidates };
      }
      renameSync(tempPath, target);
    }
  } finally {
    rmSync(tempPath, { force: true });
  }

  return {
    migrated: true,
    source: chosen.path,
    target,
    sourceSchemaVersion: chosen.userVersion ?? 0,
    candidates,
  };
}
