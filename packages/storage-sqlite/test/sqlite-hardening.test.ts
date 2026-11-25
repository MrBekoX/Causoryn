import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteGraphRepository,
  SqliteWikiStore,
  applySchema,
  hardenSqliteConnection,
  readSqliteUserVersion,
} from "../src/index.js";

/**
 * SQLite connection and file hardening:
 * - database files Causoryn creates are private to the owner (0o600; the
 *   SQLite unix VFS gives -wal/-shm the mode of the main file);
 * - every connection runs with `PRAGMA trusted_schema = OFF`;
 * - a negative `user_version` is refused before anything writes the file;
 * - the schema version is checked before any journal/WAL change.
 */

const WS = "ws_sqlite_hardening";
const T0 = "2026-11-25T08:00:00.000Z";
const IS_WINDOWS = process.platform === "win32";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "causoryn-sqlite-hardening-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

/** Reads a pragma on the repository's own connection (test-only access). */
function repositoryPragma(repo: SqliteGraphRepository, pragma: string): unknown {
  return (repo as unknown as { db: Database.Database }).db.pragma(pragma, { simple: true });
}

function stampUserVersion(file: string, version: number): void {
  const db = new Database(file);
  try {
    db.pragma(`user_version = ${String(version)}`);
  } finally {
    db.close();
  }
}

function probe(file: string): { userVersion: unknown; journalMode: unknown; tables: unknown[] } {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      userVersion: db.pragma("user_version", { simple: true }),
      journalMode: db.pragma("journal_mode", { simple: true }),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    };
  } finally {
    db.close();
  }
}

describe("database file permissions (POSIX)", () => {
  it.skipIf(IS_WINDOWS)("graph repository creates graph.sqlite, -wal and -shm as 0o600", () => {
    const file = path.join(tempDir, "graph.sqlite");
    const previousUmask = process.umask(0o022);
    try {
      const repo = new SqliteGraphRepository(file);
      try {
        repo.registerWorkspace({ id: WS, rootPath: "/tmp/ws", createdAt: T0 });
        for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
          expect(existsSync(candidate), candidate).toBe(true);
          expect(modeOf(candidate).toString(8), candidate).toBe("600");
        }
      } finally {
        repo.close();
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(IS_WINDOWS)("wiki store opened by path creates its database as 0o600", () => {
    const file = path.join(tempDir, "wiki.sqlite");
    const previousUmask = process.umask(0o022);
    try {
      const store = new SqliteWikiStore(file);
      store.close();
      expect(modeOf(file).toString(8)).toBe("600");
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(IS_WINDOWS)("an existing database keeps its permissions", () => {
    const file = path.join(tempDir, "graph.sqlite");
    new Database(file).close();
    const before = modeOf(file);
    new SqliteGraphRepository(file).close();
    expect(modeOf(file)).toBe(before);
  });
});

describe("PRAGMA trusted_schema = OFF on every connection", () => {
  it("hardenSqliteConnection turns trusted_schema off", () => {
    const db = new Database(path.join(tempDir, "raw.sqlite"));
    try {
      expect(db.pragma("trusted_schema", { simple: true })).toBe(1);
      hardenSqliteConnection(db);
      expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it("graph repository connection runs with trusted_schema off", () => {
    const repo = new SqliteGraphRepository(path.join(tempDir, "graph.sqlite"));
    try {
      expect(repositoryPragma(repo, "trusted_schema")).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("wiki store hardens both its own and an injected connection", () => {
    const owned = new SqliteWikiStore(path.join(tempDir, "owned.sqlite"));
    try {
      const db = (owned as unknown as { db: Database.Database }).db;
      expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
    } finally {
      owned.close();
    }
    const injected = new Database(path.join(tempDir, "injected.sqlite"));
    try {
      new SqliteWikiStore(injected);
      expect(injected.pragma("trusted_schema", { simple: true })).toBe(0);
    } finally {
      injected.close();
    }
  });

  it("a schema object that calls an application function cannot run it", () => {
    const repo = new SqliteGraphRepository(path.join(tempDir, "graph.sqlite"));
    try {
      const db = (repo as unknown as { db: Database.Database }).db;
      let calls = 0;
      db.function("probe_side_effect", () => {
        calls += 1;
        return 1;
      });
      db.exec("CREATE VIEW probe_view AS SELECT probe_side_effect() AS v");
      expect(() => db.prepare("SELECT v FROM probe_view").get()).toThrow(/unsafe use of/i);
      expect(calls).toBe(0);
    } finally {
      repo.close();
    }
  });
});

describe("user_version validation", () => {
  it("graph repository refuses a negative user_version without touching the file", () => {
    const file = path.join(tempDir, "negative.sqlite");
    stampUserVersion(file, -1);
    expect(() => new SqliteGraphRepository(file)).toThrowError(
      expect.objectContaining({ code: "storage/schema-corrupt" }),
    );
    const after = probe(file);
    expect(after.userVersion).toBe(-1);
    expect(after.journalMode).not.toBe("wal");
    expect(after.tables).toEqual([]);
  });

  it("wiki store refuses a negative user_version without touching the file", () => {
    const file = path.join(tempDir, "negative-wiki.sqlite");
    stampUserVersion(file, -7);
    expect(() => new SqliteWikiStore(file)).toThrowError(
      expect.objectContaining({ code: "wiki/schema-corrupt" }),
    );
    const after = probe(file);
    expect(after.userVersion).toBe(-7);
    expect(after.journalMode).not.toBe("wal");
    expect(after.tables).toEqual([]);
  });

  it("applySchema refuses a negative user_version and creates nothing", () => {
    const db = new Database(path.join(tempDir, "apply.sqlite"));
    try {
      db.pragma("user_version = -3");
      expect(() => applySchema(db)).toThrow(/user_version/);
      expect(db.pragma("user_version", { simple: true })).toBe(-3);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("readSqliteUserVersion reports a negative user_version as unreadable", () => {
    const file = path.join(tempDir, "probe.sqlite");
    stampUserVersion(file, -2);
    expect(() => readSqliteUserVersion(file)).toThrow(/user_version/);
  });

  it("a newer schema is still refused before the journal mode changes (fallback contract)", () => {
    const file = path.join(tempDir, "future.sqlite");
    stampUserVersion(file, 99);
    expect(() => new SqliteWikiStore(file)).toThrowError(
      expect.objectContaining({ code: "wiki/schema-too-new" }),
    );
    expect(() => new SqliteGraphRepository(file)).toThrowError(
      expect.objectContaining({ code: "storage/schema-too-new" }),
    );
    const after = probe(file);
    expect(after.userVersion).toBe(99);
    expect(after.journalMode).not.toBe("wal");
    expect(readSqliteUserVersion(file)).toBe(99);
  });
});
