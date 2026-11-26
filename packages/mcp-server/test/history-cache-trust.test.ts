import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Stats } from "node:fs";

import {
  openHistoryCache,
  type CommitContentAnalysis,
  type HistoryCacheFileSystem,
  type HistoryCacheStat,
} from "../src/history-commit-analysis.js";
import type { ServiceDeps } from "../src/services.js";

/**
 * History cache under the data root:
 * - CAU-01: a total retention quota (entries and bytes) with deterministic
 *   oldest-first eviction when an entry is stored.
 * - CAU-07: in a manually chosen (possibly co-writable) data root the cache
 *   directory and its entries are trusted only when they are not links, sit
 *   inside the data root and, on POSIX, are owned by the server's uid and not
 *   writable by group or others; every entry is bound to the workspace root it
 *   was analyzed from. An untrusted cache is ignored (logged), never served.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

interface Fixture {
  readonly root: string;
  readonly dataDir: string;
  readonly historyDir: string;
  readonly logs: string[];
  readonly deps: ServiceDeps;
}

function makeFixture(): Fixture {
  const root = makeTempDir("causoryn-hct-root-");
  const dataDir = makeTempDir("causoryn-hct-data-");
  const logs: string[] = [];
  const deps = {
    config: {
      storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
      allowRoots: [root],
      index: { maxFiles: 100 },
    },
    policy: {
      config: {
        ignore: [],
        extraIgnore: [],
        binaryExtensions: [],
        extensionFilterMode: "allowlist",
        allowedExtensions: [".ts"],
        maxFileBytes: 1000,
      },
    },
    logger: (message: string) => logs.push(message),
    repository: { getLatestPublished: () => undefined },
  } as unknown as ServiceDeps;
  return { root, dataDir, historyDir: path.join(dataDir, "history"), logs, deps };
}

const ANALYSIS: CommitContentAnalysis = {
  state: "ready",
  fileCount: 1,
  skippedFiles: 0,
  degradedWorkers: [],
  contentSet: {
    nodes: [{ kind: "Function", qualifiedName: "alpha", relativePath: "src/a.ts", signature: "alpha(): number" }],
    edges: [],
  } as unknown as CommitContentAnalysis["contentSet"],
};

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function entryFile(historyDir: string, sha: string): string {
  const name = readdirSync(historyDir).find((candidate) => candidate.startsWith(`${sha}-`));
  expect(name, `no cache entry for ${sha}`).toBeDefined();
  return path.join(historyDir, name as string);
}

function setMtime(file: string, isoDate: string): void {
  const time = new Date(isoDate);
  utimesSync(file, time, time);
}

const SERVER_UID = 4242;
const OTHER_UID = 5151;

interface StatOverride {
  readonly uid?: number;
  readonly perm?: number;
}

/**
 * Injected POSIX view of the cache files: owner and permission bits per
 * path (anything else is the real stat), separately for the path lstat and
 * for the stat of the opened descriptor. On Windows the server has no uid,
 * so the ownership checks run only through this injection there.
 */
function posixView(
  overrides: Map<string, StatOverride>,
  openedOverrides: Map<string, StatOverride> = new Map(),
): HistoryCacheFileSystem {
  const view = (real: Stats, override: StatOverride | undefined): HistoryCacheStat => {
    const typeBits = real.isDirectory() ? 0o040000 : real.isSymbolicLink() ? 0o120000 : 0o100000;
    const perm = override?.perm ?? (real.isDirectory() ? 0o700 : 0o600);
    return {
      isFile: () => real.isFile(),
      isDirectory: () => real.isDirectory(),
      isSymbolicLink: () => real.isSymbolicLink(),
      uid: override?.uid ?? SERVER_UID,
      mode: typeBits | perm,
      size: real.size,
      mtimeMs: real.mtimeMs,
      dev: real.dev,
      ino: real.ino,
    };
  };
  return {
    getuid: () => SERVER_UID,
    lstat: async (target) => view(await lstat(target), overrides.get(target)),
    fstat: async (handle, target) => view(await handle.stat(), openedOverrides.get(target) ?? overrides.get(target)),
  };
}

describe("history cache retention quota (CAU-01)", () => {
  it("evicts the oldest entries (by modification time) once maxEntries is exceeded; hits and misses keep working", async () => {
    const fixture = makeFixture();
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root, {
      quota: { maxEntries: 2, maxTotalBytes: 64 * 1024 * 1024 },
    });
    expect(cache).not.toBeNull();
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(true);
    expect(await cache!.store(SHA_B, ANALYSIS)).toBe(true);
    // B is older than A although it was stored later.
    setMtime(entryFile(fixture.historyDir, SHA_A), "2021-01-01T00:00:00Z");
    setMtime(entryFile(fixture.historyDir, SHA_B), "2020-01-01T00:00:00Z");

    expect(await cache!.store(SHA_C, ANALYSIS)).toBe(true);
    const names = readdirSync(fixture.historyDir).sort();
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.startsWith(`${SHA_B}-`))).toBe(false);
    expect(await cache!.lookup(SHA_B)).toBeUndefined();
    expect((await cache!.lookup(SHA_A))?.analysis.contentSet).toEqual(ANALYSIS.contentSet);
    expect((await cache!.lookup(SHA_C))?.analysis.contentSet).toEqual(ANALYSIS.contentSet);
    expect(fixture.logs.some((line) => line.includes("evicted"))).toBe(true);
  });

  it("breaks modification-time ties by file name, so eviction is deterministic", async () => {
    const fixture = makeFixture();
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root, {
      quota: { maxEntries: 2, maxTotalBytes: 64 * 1024 * 1024 },
    });
    await cache!.store(SHA_B, ANALYSIS);
    await cache!.store(SHA_A, ANALYSIS);
    setMtime(entryFile(fixture.historyDir, SHA_A), "2020-01-01T00:00:00Z");
    setMtime(entryFile(fixture.historyDir, SHA_B), "2020-01-01T00:00:00Z");
    expect(await cache!.store(SHA_C, ANALYSIS)).toBe(true);
    const names = readdirSync(fixture.historyDir).sort();
    expect(names.map((name) => name.slice(0, 1))).toEqual(["b", "c"]);
  });

  it("keeps the total size within maxTotalBytes and refuses an entry larger than the quota", async () => {
    const fixture = makeFixture();
    const probe = openHistoryCache(fixture.deps, "ws", fixture.root, {
      quota: { maxEntries: 100, maxTotalBytes: 64 * 1024 * 1024 },
    });
    await probe!.store(SHA_A, ANALYSIS);
    const entryBytes = statSync(entryFile(fixture.historyDir, SHA_A)).size;
    setMtime(entryFile(fixture.historyDir, SHA_A), "2020-01-01T00:00:00Z");

    const cache = openHistoryCache(fixture.deps, "ws", fixture.root, {
      quota: { maxEntries: 100, maxTotalBytes: 2 * entryBytes + Math.floor(entryBytes / 2) },
    });
    await cache!.store(SHA_B, ANALYSIS);
    setMtime(entryFile(fixture.historyDir, SHA_B), "2021-01-01T00:00:00Z");
    await cache!.store(SHA_C, ANALYSIS);
    const names = readdirSync(fixture.historyDir).sort();
    expect(names.map((name) => name.slice(0, 1))).toEqual(["b", "c"]);

    const tiny = openHistoryCache(fixture.deps, "ws", fixture.root, {
      quota: { maxEntries: 100, maxTotalBytes: entryBytes - 1 },
    });
    expect(await tiny!.store(SHA_A, ANALYSIS)).toBe(false);
    expect(readdirSync(fixture.historyDir).some((name) => name.startsWith(`${SHA_A}-`))).toBe(false);
  });
});

describe("history cache temporary files", () => {
  it("removes temporary files a crashed write left behind (older than an hour) and keeps recent ones", async () => {
    const fixture = makeFixture();
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root);
    await cache!.store(SHA_A, ANALYSIS);
    const entryName = path.basename(entryFile(fixture.historyDir, SHA_A));
    const stale = path.join(fixture.historyDir, `.${entryName}.4711.0123456789abcdef.tmp`);
    const recent = path.join(fixture.historyDir, `.${entryName}.4712.fedcba9876543210.tmp`);
    writeFileSync(stale, "{", "utf8");
    writeFileSync(recent, "{", "utf8");
    setMtime(stale, "2020-01-01T00:00:00Z");

    expect(await cache!.store(SHA_B, ANALYSIS)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});

describe("history cache trust checks (CAU-07)", () => {
  it("an entry is bound to the workspace root it was analyzed from", async () => {
    const fixture = makeFixture();
    const otherRoot = makeTempDir("causoryn-hct-other-root-");
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root);
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(true);
    expect(await cache!.lookup(SHA_A)).toBeDefined();
    // Same data root and workspace id, other repository: not served.
    const other = openHistoryCache(fixture.deps, "ws", otherRoot);
    expect(await other!.lookup(SHA_A)).toBeUndefined();
  });

  it("an entry whose source identity does not match is ignored, logged and removed", async () => {
    const fixture = makeFixture();
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root);
    await cache!.store(SHA_A, ANALYSIS);
    const file = entryFile(fixture.historyDir, SHA_A);
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(typeof entry.sourceIdentity).toBe("string");
    writeFileSync(file, JSON.stringify({ ...entry, sourceIdentity: "f".repeat(64) }), "utf8");
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
    expect(fixture.logs.some((line) => line.includes("source identity"))).toBe(true);
    expect(existsSync(file)).toBe(false);

    await cache!.store(SHA_A, ANALYSIS);
    const { sourceIdentity: _dropped, ...withoutIdentity } = JSON.parse(
      readFileSync(entryFile(fixture.historyDir, SHA_A), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(entryFile(fixture.historyDir, SHA_A), JSON.stringify(withoutIdentity), "utf8");
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
  });

  it("a cache directory owned by another uid is not trusted: entries are not served and nothing is written", async () => {
    const fixture = makeFixture();
    const trusted = openHistoryCache(fixture.deps, "ws", fixture.root, { fileSystem: posixView(new Map()) });
    expect(await trusted!.store(SHA_A, ANALYSIS)).toBe(true);
    expect(await trusted!.lookup(SHA_A)).toBeDefined();

    const foreign = openHistoryCache(fixture.deps, "ws", fixture.root, {
      fileSystem: posixView(new Map([[fixture.historyDir, { uid: OTHER_UID }]])),
    });
    expect(await foreign!.lookup(SHA_A)).toBeUndefined();
    expect(await foreign!.store(SHA_B, ANALYSIS)).toBe(false);
    expect(readdirSync(fixture.historyDir).some((name) => name.startsWith(`${SHA_B}-`))).toBe(false);
    expect(fixture.logs.some((line) => line.includes(`uid ${String(OTHER_UID)}`))).toBe(true);
  });

  it("a cache directory writable by group or others is not trusted", async () => {
    const fixture = makeFixture();
    const trusted = openHistoryCache(fixture.deps, "ws", fixture.root, { fileSystem: posixView(new Map()) });
    await trusted!.store(SHA_A, ANALYSIS);
    for (const perm of [0o770, 0o707, 0o777]) {
      const shared = openHistoryCache(fixture.deps, "ws", fixture.root, {
        fileSystem: posixView(new Map([[fixture.historyDir, { perm }]])),
      });
      expect(await shared!.lookup(SHA_A), perm.toString(8)).toBeUndefined();
      expect(await shared!.store(SHA_B, ANALYSIS), perm.toString(8)).toBe(false);
    }
    expect(fixture.logs.some((line) => line.includes("writable by group or others"))).toBe(true);
  });

  it("an entry owned by another uid or writable by group or others is not served", async () => {
    const fixture = makeFixture();
    const trusted = openHistoryCache(fixture.deps, "ws", fixture.root, { fileSystem: posixView(new Map()) });
    await trusted!.store(SHA_A, ANALYSIS);
    const file = entryFile(fixture.historyDir, SHA_A);
    for (const override of [{ uid: OTHER_UID }, { perm: 0o620 }, { perm: 0o666 }]) {
      const view = openHistoryCache(fixture.deps, "ws", fixture.root, {
        fileSystem: posixView(new Map([[file, override]])),
      });
      expect(await view!.lookup(SHA_A), JSON.stringify(override)).toBeUndefined();
    }
    expect(fixture.logs.some((line) => line.includes("untrusted history cache entry"))).toBe(true);
    // The entry itself is still there and served once it is trusted again.
    expect(await trusted!.lookup(SHA_A)).toBeDefined();
  });

  it("the owner and mode checks also apply to the file actually opened (a swap after the path check is not served)", async () => {
    const fixture = makeFixture();
    const trusted = openHistoryCache(fixture.deps, "ws", fixture.root, { fileSystem: posixView(new Map()) });
    await trusted!.store(SHA_A, ANALYSIS);
    const file = entryFile(fixture.historyDir, SHA_A);
    for (const opened of [{ uid: OTHER_UID }, { perm: 0o666 }]) {
      // The path looks trusted; the descriptor that would be read is not.
      const swapped = openHistoryCache(fixture.deps, "ws", fixture.root, {
        fileSystem: posixView(new Map(), new Map([[file, opened]])),
      });
      expect(await swapped!.lookup(SHA_A), JSON.stringify(opened)).toBeUndefined();
    }
    expect(fixture.logs.some((line) => line.includes("untrusted history cache entry"))).toBe(true);
    expect(await trusted!.lookup(SHA_A)).toBeDefined();
  });

  it.skipIf(process.platform === "win32")("real POSIX permissions: a group/world-writable directory or entry is ignored", async () => {
    const fixture = makeFixture();
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root);
    await cache!.store(SHA_A, ANALYSIS);
    expect(await cache!.lookup(SHA_A)).toBeDefined();
    const file = entryFile(fixture.historyDir, SHA_A);

    chmodSync(file, 0o666);
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
    chmodSync(file, 0o600);
    expect(await cache!.lookup(SHA_A)).toBeDefined();

    chmodSync(fixture.historyDir, 0o777);
    try {
      expect(await cache!.lookup(SHA_A)).toBeUndefined();
      expect(await cache!.store(SHA_B, ANALYSIS)).toBe(false);
    } finally {
      chmodSync(fixture.historyDir, 0o700);
    }
    expect(await cache!.lookup(SHA_A)).toBeDefined();
  });

  it("a cache directory that is a link (symlink or junction) is not used", async () => {
    const fixture = makeFixture();
    const elsewhere = makeTempDir("causoryn-hct-elsewhere-");
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(elsewhere, fixture.historyDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // links cannot be created here
    }
    const cache = openHistoryCache(fixture.deps, "ws", fixture.root);
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    mkdirSync(path.join(elsewhere, "probe"));
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
  });
});
