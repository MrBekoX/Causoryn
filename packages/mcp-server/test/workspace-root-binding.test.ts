import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import type { SqliteWikiStore } from "@causoryn/storage-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CausorynConfigError, createCausorynContext } from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

/**
 * CAU-03 (CWE-863): a persisted graph/wiki database is bound to the CANONICAL
 * workspace root it was recorded for, not only to the workspace id.
 *
 * Reusing an explicit `storage.dataDbPath` / `wiki.dataDbPath` with a different
 * root under the same `workspaceId` must refuse at open (CausorynConfigError):
 * otherwise tool authorization passes for the new root while the snapshot, wiki
 * pages and annotations recorded for the previous root are served. The same root
 * spelled differently (trailing separator, letter case on Windows, a link to the
 * same directory) keeps warm-starting, and databases written by 0.3.2 (which
 * stored `allowRoots[0]` verbatim) keep opening when the root is canonically equal;
 * that open replaces the verbatim spelling with the canonical root, so a legacy
 * link spelling cannot follow the link to another directory later.
 *
 * Every database and workspace lives in a fresh os.tmpdir() directory.
 */

const WS = "shared-ws";
const FIXED_NOW = "2026-11-26T10:00:00.000Z";
const LEGACY_CREATED_AT = "2026-11-20T08:00:00.000Z";
const IS_WIN = process.platform === "win32";

let tempRoot: string;
let rootA: string;
let rootB: string;
let dataDir: string;

function writeWorkspace(root: string, fileName: string, body: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", fileName), body);
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-root-binding-"));
  rootA = path.join(tempRoot, "ws-a");
  rootB = path.join(tempRoot, "ws-b");
  dataDir = path.join(tempRoot, "data");
  writeWorkspace(rootA, "only-in-a.ts", "export function onlyInA(): number {\n  return 1;\n}\n");
  writeWorkspace(rootB, "only-in-b.ts", "export function onlyInB(): number {\n  return 2;\n}\n");
  mkdirSync(dataDir);
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function graphDbPath(): string {
  return path.join(dataDir, "graph.sqlite");
}

function wikiDbPath(): string {
  return path.join(dataDir, "wiki.sqlite");
}

function graphConfig(root: string): Record<string, unknown> {
  return {
    workspaceId: WS,
    allowRoots: [root],
    autoIndex: true,
    storage: { dataDbPath: graphDbPath() },
  };
}

function wikiConfig(root: string): Record<string, unknown> {
  return {
    workspaceId: WS,
    allowRoots: [root],
    autoIndex: false,
    wiki: { dataDbPath: wikiDbPath() },
  };
}

function open(rawConfig: Record<string, unknown>, logs: string[] = []): CausorynContext {
  return createCausorynContext(rawConfig, {
    clock: () => FIXED_NOW,
    logger: (message: string): void => {
      logs.push(message);
    },
  });
}

/** What a context opened for `rawConfig` would serve for WS (undefined when it refuses). */
interface OpenOutcome {
  readonly error?: unknown;
  readonly served?: {
    readonly graphNodes: string;
    readonly wikiSnapshotId: string | undefined;
    readonly annotationIds: readonly string[];
  };
}

function tryOpen(rawConfig: Record<string, unknown>): OpenOutcome {
  let context: CausorynContext;
  try {
    context = open(rawConfig);
  } catch (error) {
    return { error };
  }
  try {
    const graph = context.repository.getLatestPublished(WS);
    const wiki = context.wikiStore;
    return {
      served: {
        graphNodes: JSON.stringify(graph?.snapshot.nodes ?? []),
        wikiSnapshotId: wiki?.getLatestPublishedWiki(WS)?.snapshot.id,
        annotationIds: (wiki?.listAnnotations(WS) ?? []).map((annotation) => annotation.id),
      },
    };
  } finally {
    context.close();
  }
}

/** Publishes a one-page WikiSnapshot plus a human annotation for WS. */
function publishWikiWithAnnotation(store: SqliteWikiStore): string {
  const sid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: "snapshot:recorded-for-a",
    revisionRef: "rev-a",
    templateVersion: "tpl-test",
    createdAt: FIXED_NOW,
  });
  store.addWikiPage(sid, {
    id: "page_root_overview",
    kind: "overview",
    parentId: null,
    title: "Overview of A",
    slug: "overview",
    route: "/wiki/overview",
    contentHash: "hash-a",
    freshness: "fresh",
    coverage: { status: "complete" },
  });
  const published = store.publishWiki(sid, "wiki:recorded-for-a", "ready", FIXED_NOW);
  store.writeAnnotation(WS, {
    id: "annot-a",
    stablePageId: "page_root_overview",
    sectionKey: "dependencies",
    authorKind: "human",
    origin: "human_note",
    body: "note written while the root was A",
    annotationVersion: 0,
    updatedAt: FIXED_NOW,
  });
  return published.snapshot.id;
}

/** Other spellings of rootA that name the same directory. */
function sameDirectorySpellings(): string[] {
  const spellings = [`${rootA}${path.sep}`];
  if (IS_WIN) {
    spellings.push(rootA.toUpperCase(), rootA.toLowerCase());
  }
  const link = path.join(tempRoot, "link-to-a");
  symlinkSync(rootA, link, IS_WIN ? "junction" : "dir");
  spellings.push(link);
  return spellings;
}

/** The canonical form a record stores for `root` (native realpath). */
function canonicalRoot(root: string): string {
  return realpathSync.native(root);
}

function storedRootPath(dbFile: string): string | undefined {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.prepare("SELECT root_path FROM workspaces WHERE id = ?").get(WS) as
      | { root_path: string }
      | undefined;
    return row?.root_path;
  } finally {
    db.close();
  }
}

/** The workspace row as stored, including the canonical-root mark (schema v6). */
function storedRecord(dbFile: string): { readonly rootPath: string; readonly rootCanonical: number } | undefined {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.prepare("SELECT root_path, root_canonical FROM workspaces WHERE id = ?").get(WS) as
      | { root_path: string; root_canonical: number }
      | undefined;
    return row === undefined ? undefined : { rootPath: row.root_path, rootCanonical: row.root_canonical };
  } finally {
    db.close();
  }
}

function userVersion(dbFile: string): unknown {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.pragma("user_version", { simple: true });
  } finally {
    db.close();
  }
}

/**
 * A database exactly as 0.3.2 left it: schema v5 (the workspaces table has no
 * root_canonical column) and the workspace row holding allowRoots[0] verbatim.
 */
function writeLegacy032Database(dbFile: string, recordedRoot: string): void {
  const legacy = new SqliteGraphRepository(dbFile);
  try {
    legacy.registerWorkspace({ id: WS, rootPath: recordedRoot, createdAt: LEGACY_CREATED_AT });
  } finally {
    legacy.close();
  }
  const raw = new Database(dbFile);
  try {
    raw.exec("ALTER TABLE workspaces DROP COLUMN root_canonical; PRAGMA user_version = 5;");
  } finally {
    raw.close();
  }
}

/** Moves the directory at `dirPath` aside and puts a link to `target` in its place. */
function replaceWithLinkTo(dirPath: string, target: string): void {
  renameSync(dirPath, `${dirPath}-moved-away`);
  symlinkSync(target, dirPath, IS_WIN ? "junction" : "dir");
}

function expectRootMismatchRefusal(
  outcome: OpenOutcome,
  fieldName: "storage.dataDbPath" | "wiki.dataDbPath",
): void {
  expect(outcome.error).toBeInstanceOf(CausorynConfigError);
  const message = (outcome.error as Error).message;
  expect(message).toContain(fieldName);
  expect(message).toContain(WS);
  expect(message).toMatch(/different (workspace )?root/);
  // The refusal does not repeat the root the database was recorded for.
  expect(message.toLowerCase()).not.toContain(rootA.toLowerCase());
}

describe("CAU-03 — graph DB bound to the canonical workspace root", { timeout: 60_000 }, () => {
  it("same workspaceId + a different root refuses at open; the snapshot indexed for root A is never served", () => {
    let snapshotA: string;
    const first = open(graphConfig(rootA));
    try {
      const read = first.repository.getLatestPublished(WS);
      expect(read).toBeDefined();
      expect(JSON.stringify(read?.snapshot.nodes)).toContain("only-in-a.ts");
      snapshotA = read?.snapshot.meta.id as string;
    } finally {
      first.close();
    }

    const outcome = tryOpen(graphConfig(rootB));
    expect(outcome.served?.graphNodes ?? "").not.toContain("only-in-a.ts");
    expectRootMismatchRefusal(outcome, "storage.dataDbPath");

    // The refusal changed nothing: root A still warm-starts its own snapshot.
    const logs: string[] = [];
    const again = open(graphConfig(rootA), logs);
    try {
      expect(again.repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(snapshotA);
      expect(logs.some((line) => line.includes(`persistent index loaded: workspace=${WS} snapshot=${snapshotA}`))).toBe(true);
    } finally {
      again.close();
    }
  });

  it("the record binds to the directory the root resolved to: a link retargeted to another directory is refused", () => {
    const link = path.join(tempRoot, "moving-link");
    symlinkSync(rootA, link, IS_WIN ? "junction" : "dir");
    const first = open(graphConfig(link));
    first.close();

    rmSync(link, { force: true });
    // Removing the link left the directory it pointed to intact.
    expect(existsSync(path.join(rootA, "src", "only-in-a.ts"))).toBe(true);
    symlinkSync(rootB, link, IS_WIN ? "junction" : "dir");

    const outcome = tryOpen(graphConfig(link));
    expect(outcome.served?.graphNodes ?? "").not.toContain("only-in-a.ts");
    expectRootMismatchRefusal(outcome, "storage.dataDbPath");
  });

  it("the same root spelled differently (trailing separator, letter case on Windows, a link to it) warm-starts the stored snapshot", () => {
    let snapshotA: string;
    const first = open(graphConfig(rootA));
    try {
      snapshotA = first.repository.getLatestPublished(WS)?.snapshot.meta.id as string;
      expect(snapshotA).toMatch(/^snapshot:/);
    } finally {
      first.close();
    }

    for (const spelling of sameDirectorySpellings()) {
      const logs: string[] = [];
      const context = open(graphConfig(spelling), logs);
      try {
        expect(context.repository.getLatestPublished(WS)?.snapshot.meta.id, spelling).toBe(snapshotA);
        expect(
          logs.some((line) => line.includes(`persistent index loaded: workspace=${WS} snapshot=${snapshotA}`)),
          spelling,
        ).toBe(true);
      } finally {
        context.close();
      }
    }
  });

  it("a 0.3.2 database (allowRoots[0] stored verbatim, non-canonical spelling) keeps opening for the canonically equal root and its record is upgraded to the canonical root", () => {
    const legacySpelling = IS_WIN ? `${rootA.toUpperCase()}${path.sep}` : `${rootA}${path.sep}`;
    // 0.3.2 wrote the workspace row exactly like this at open time.
    const legacy = new SqliteGraphRepository(graphDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: legacySpelling, createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }

    let snapshotA: string;
    const first = open(graphConfig(rootA));
    try {
      const read = first.repository.getLatestPublished(WS);
      expect(JSON.stringify(read?.snapshot.nodes)).toContain("only-in-a.ts");
      snapshotA = read?.snapshot.meta.id as string;
    } finally {
      first.close();
    }

    const logs: string[] = [];
    const again = open(graphConfig(rootA), logs);
    try {
      expect(again.repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(snapshotA);
      expect(logs.some((line) => line.includes("persistent index loaded"))).toBe(true);
    } finally {
      again.close();
    }
    // The verbatim spelling is replaced by the canonical root on the first
    // matching open: a link spelling kept verbatim would follow the link to
    // wherever it points later (see the retarget test below).
    expect(storedRootPath(graphDbPath())).toBe(canonicalRoot(rootA));
  });

  it("a 0.3.2 record holding a link spelling is bound to the directory it resolved to on first open; retargeting the link later is refused", () => {
    const link = path.join(tempRoot, "legacy-link");
    symlinkSync(rootA, link, IS_WIN ? "junction" : "dir");
    // 0.3.2 stored allowRoots[0] verbatim: here the link itself.
    const legacy = new SqliteGraphRepository(graphDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: link, createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }

    const first = open(graphConfig(link));
    try {
      expect(JSON.stringify(first.repository.getLatestPublished(WS)?.snapshot.nodes)).toContain("only-in-a.ts");
    } finally {
      first.close();
    }
    expect(storedRootPath(graphDbPath())).toBe(canonicalRoot(rootA));

    rmSync(link, { force: true });
    symlinkSync(rootB, link, IS_WIN ? "junction" : "dir");

    const outcome = tryOpen(graphConfig(link));
    expect(outcome.served?.graphNodes ?? "").not.toContain("only-in-a.ts");
    expectRootMismatchRefusal(outcome, "storage.dataDbPath");
    expect(storedRootPath(graphDbPath())).toBe(canonicalRoot(rootA));
  });

  it("a record that already holds the canonical root is left as it is", () => {
    const legacy = new SqliteGraphRepository(graphDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: canonicalRoot(rootA), createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }
    open(graphConfig(`${rootA}${path.sep}`)).close();
    expect(storedRootPath(graphDbPath())).toBe(canonicalRoot(rootA));
  });

  it("a 0.3.2 database recorded for another root is refused", () => {
    const legacy = new SqliteGraphRepository(graphDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: rootA, createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }
    expectRootMismatchRefusal(tryOpen(graphConfig(rootB)), "storage.dataDbPath");
    expect(storedRootPath(graphDbPath())).toBe(rootA);
  });

  it("a record whose root no longer exists, or names a network/device path, is refused for the authorized root", () => {
    const recordedRoots = [
      path.join(tempRoot, "deleted-root"),
      IS_WIN ? "\\\\server.invalid\\share\\ws-a" : "//server.invalid/share/ws-a",
    ];
    for (const recordedRoot of recordedRoots) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${graphDbPath()}${suffix}`, { force: true });
      }
      const legacy = new SqliteGraphRepository(graphDbPath());
      try {
        legacy.registerWorkspace({ id: WS, rootPath: recordedRoot, createdAt: LEGACY_CREATED_AT });
      } finally {
        legacy.close();
      }
      const outcome = tryOpen(graphConfig(rootA));
      expect(outcome.error, recordedRoot).toBeInstanceOf(CausorynConfigError);
      expect((outcome.error as Error).message, recordedRoot).toMatch(/different root/);
      expect((outcome.error as Error).message, recordedRoot).not.toContain(recordedRoot);
    }
  });

  it("a new record holds the canonical root and is marked; a warm start with the same root leaves it as written", () => {
    let snapshotA: string;
    const first = open(graphConfig(rootA));
    try {
      snapshotA = first.repository.getLatestPublished(WS)?.snapshot.meta.id as string;
      expect(snapshotA).toMatch(/^snapshot:/);
    } finally {
      first.close();
    }
    expect(storedRecord(graphDbPath())).toEqual({ rootPath: canonicalRoot(rootA), rootCanonical: 1 });

    const logs: string[] = [];
    const again = open(graphConfig(rootA), logs);
    try {
      expect(again.repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(snapshotA);
      expect(logs.some((line) => line.includes(`persistent index loaded: workspace=${WS} snapshot=${snapshotA}`))).toBe(true);
    } finally {
      again.close();
    }
    expect(storedRecord(graphDbPath())).toEqual({ rootPath: canonicalRoot(rootA), rootCanonical: 1 });
  });

  it("a marked record is compared as recorded: once its root path is turned into a link to another directory, the database is refused for the link and for that directory", () => {
    open(graphConfig(rootA)).close();
    const recorded = storedRecord(graphDbPath());
    expect(recorded).toEqual({ rootPath: canonicalRoot(rootA), rootCanonical: 1 });

    // The recorded path itself now names root B.
    replaceWithLinkTo(rootA, rootB);
    for (const declared of [rootA, rootB]) {
      const outcome = tryOpen(graphConfig(declared));
      expect(outcome.served?.graphNodes ?? "", declared).not.toContain("only-in-a.ts");
      expectRootMismatchRefusal(outcome, "storage.dataDbPath");
    }
    // Never rewritten to the directory the link names.
    expect(storedRecord(graphDbPath())).toEqual(recorded);
  });

  it("a marked record is refused once a parent directory of its root is turned into a link to another tree", () => {
    const parentA = path.join(tempRoot, "tree-a");
    const parentB = path.join(tempRoot, "tree-b");
    const projectA = path.join(parentA, "proj");
    writeWorkspace(projectA, "only-in-a.ts", "export function onlyInA(): number {\n  return 1;\n}\n");
    writeWorkspace(path.join(parentB, "proj"), "only-in-b.ts", "export function onlyInB(): number {\n  return 2;\n}\n");
    open(graphConfig(projectA)).close();
    const recorded = storedRecord(graphDbPath());
    expect(recorded).toEqual({ rootPath: canonicalRoot(projectA), rootCanonical: 1 });

    replaceWithLinkTo(parentA, parentB);
    const outcome = tryOpen(graphConfig(projectA));
    expect(outcome.served?.graphNodes ?? "").not.toContain("only-in-a.ts");
    expect(outcome.error).toBeInstanceOf(CausorynConfigError);
    expect((outcome.error as Error).message).toMatch(/different root/);
    expect(storedRecord(graphDbPath())).toEqual(recorded);
  });

  it("a 0.3.2 database (schema v5, no root_canonical column) migrates on open; its verbatim record is upgraded to the canonical root and marked, so it is compared as recorded from then on", () => {
    const legacySpelling = IS_WIN ? `${rootA.toUpperCase()}${path.sep}` : `${rootA}${path.sep}`;
    writeLegacy032Database(graphDbPath(), legacySpelling);
    expect(userVersion(graphDbPath())).toBe(5);

    let snapshotA: string;
    const first = open(graphConfig(rootA));
    try {
      const read = first.repository.getLatestPublished(WS);
      expect(JSON.stringify(read?.snapshot.nodes)).toContain("only-in-a.ts");
      snapshotA = read?.snapshot.meta.id as string;
    } finally {
      first.close();
    }
    const canonicalA = canonicalRoot(rootA);
    expect(userVersion(graphDbPath())).toBe(6);
    expect(storedRecord(graphDbPath())).toEqual({ rootPath: canonicalA, rootCanonical: 1 });

    const logs: string[] = [];
    const again = open(graphConfig(rootA), logs);
    try {
      expect(again.repository.getLatestPublished(WS)?.snapshot.meta.id).toBe(snapshotA);
      expect(logs.some((line) => line.includes("persistent index loaded"))).toBe(true);
    } finally {
      again.close();
    }

    replaceWithLinkTo(rootA, rootB);
    for (const declared of [rootA, rootB]) {
      const outcome = tryOpen(graphConfig(declared));
      expect(outcome.served?.graphNodes ?? "", declared).not.toContain("only-in-a.ts");
      expectRootMismatchRefusal(outcome, "storage.dataDbPath");
    }
    expect(storedRecord(graphDbPath())).toEqual({ rootPath: canonicalA, rootCanonical: 1 });
  });

  it("a 0.3.2 database recorded for another root is refused without being upgraded or marked", () => {
    writeLegacy032Database(graphDbPath(), rootA);
    expectRootMismatchRefusal(tryOpen(graphConfig(rootB)), "storage.dataDbPath");
    expect(storedRecord(graphDbPath())).toEqual({ rootPath: rootA, rootCanonical: 0 });
  });
});

describe("CAU-03 — wiki DB bound to the canonical workspace root", { timeout: 60_000 }, () => {
  it("same workspaceId + a different root refuses at open; root A's wiki pages and annotations are never served", () => {
    let wikiSnapshotA: string;
    const first = open(wikiConfig(rootA));
    try {
      wikiSnapshotA = publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }

    const outcome = tryOpen(wikiConfig(rootB));
    expect(outcome.served?.wikiSnapshotId).not.toBe(wikiSnapshotA);
    expect(outcome.served?.annotationIds ?? []).not.toContain("annot-a");
    expectRootMismatchRefusal(outcome, "wiki.dataDbPath");
  });

  it("the same root spelled differently keeps serving its wiki pages and annotations", () => {
    let wikiSnapshotA: string;
    const first = open(wikiConfig(rootA));
    try {
      wikiSnapshotA = publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }

    for (const spelling of sameDirectorySpellings()) {
      const outcome = tryOpen(wikiConfig(spelling));
      expect(outcome.error, spelling).toBeUndefined();
      expect(outcome.served?.wikiSnapshotId, spelling).toBe(wikiSnapshotA);
      expect(outcome.served?.annotationIds, spelling).toEqual(["annot-a"]);
    }
  });

  it("a 0.3.2 wiki database keeps opening for the canonically equal root and is refused for another root", () => {
    const legacySpelling = `${rootA}${path.sep}`;
    const legacy = new SqliteGraphRepository(wikiDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: legacySpelling, createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }

    let wikiSnapshotA: string;
    const first = open(wikiConfig(rootA));
    try {
      wikiSnapshotA = publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }
    const reopened = tryOpen(wikiConfig(rootA));
    expect(reopened.error).toBeUndefined();
    expect(reopened.served?.wikiSnapshotId).toBe(wikiSnapshotA);

    const other = tryOpen(wikiConfig(rootB));
    expect(other.served?.annotationIds ?? []).not.toContain("annot-a");
    expectRootMismatchRefusal(other, "wiki.dataDbPath");
    // Upgraded to the canonical root by the first matching open (not by the refusal).
    expect(storedRootPath(wikiDbPath())).toBe(canonicalRoot(rootA));
  });

  it("a 0.3.2 wiki record holding a link spelling is bound on first open; retargeting the link later is refused", () => {
    const link = path.join(tempRoot, "legacy-wiki-link");
    symlinkSync(rootA, link, IS_WIN ? "junction" : "dir");
    const legacy = new SqliteGraphRepository(wikiDbPath());
    try {
      legacy.registerWorkspace({ id: WS, rootPath: link, createdAt: LEGACY_CREATED_AT });
    } finally {
      legacy.close();
    }
    const first = open(wikiConfig(link));
    try {
      publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }
    expect(storedRootPath(wikiDbPath())).toBe(canonicalRoot(rootA));

    rmSync(link, { force: true });
    symlinkSync(rootB, link, IS_WIN ? "junction" : "dir");

    const outcome = tryOpen(wikiConfig(link));
    expect(outcome.served?.annotationIds ?? []).not.toContain("annot-a");
    expectRootMismatchRefusal(outcome, "wiki.dataDbPath");
  });

  it("a marked wiki record is compared as recorded: once its root path is turned into a link to another directory, the wiki DB is refused for the link and for that directory", () => {
    let wikiSnapshotA: string;
    const first = open(wikiConfig(rootA));
    try {
      wikiSnapshotA = publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }
    const recorded = storedRecord(wikiDbPath());
    expect(recorded).toEqual({ rootPath: canonicalRoot(rootA), rootCanonical: 1 });

    // Warm start with the same root keeps serving the pages and annotations.
    const warm = tryOpen(wikiConfig(rootA));
    expect(warm.error).toBeUndefined();
    expect(warm.served?.wikiSnapshotId).toBe(wikiSnapshotA);
    expect(warm.served?.annotationIds).toEqual(["annot-a"]);
    expect(storedRecord(wikiDbPath())).toEqual(recorded);

    replaceWithLinkTo(rootA, rootB);
    for (const declared of [rootA, rootB]) {
      const outcome = tryOpen(wikiConfig(declared));
      expect(outcome.served?.wikiSnapshotId, declared).not.toBe(wikiSnapshotA);
      expect(outcome.served?.annotationIds ?? [], declared).not.toContain("annot-a");
      expectRootMismatchRefusal(outcome, "wiki.dataDbPath");
    }
    expect(storedRecord(wikiDbPath())).toEqual(recorded);
  });

  it("a 0.3.2 wiki database (schema v5, no root_canonical column) migrates on open and its record is upgraded and marked", () => {
    const legacySpelling = `${rootA}${path.sep}`;
    writeLegacy032Database(wikiDbPath(), legacySpelling);
    expect(userVersion(wikiDbPath())).toBe(5);

    let wikiSnapshotA: string;
    const first = open(wikiConfig(rootA));
    try {
      wikiSnapshotA = publishWikiWithAnnotation(first.wikiStore as SqliteWikiStore);
    } finally {
      first.close();
    }
    const canonicalA = canonicalRoot(rootA);
    expect(userVersion(wikiDbPath())).toBe(6);
    expect(storedRecord(wikiDbPath())).toEqual({ rootPath: canonicalA, rootCanonical: 1 });

    const reopened = tryOpen(wikiConfig(rootA));
    expect(reopened.error).toBeUndefined();
    expect(reopened.served?.wikiSnapshotId).toBe(wikiSnapshotA);

    replaceWithLinkTo(rootA, rootB);
    const outcome = tryOpen(wikiConfig(rootA));
    expect(outcome.served?.annotationIds ?? []).not.toContain("annot-a");
    expectRootMismatchRefusal(outcome, "wiki.dataDbPath");
    expect(storedRecord(wikiDbPath())).toEqual({ rootPath: canonicalA, rootCanonical: 1 });
  });
});
