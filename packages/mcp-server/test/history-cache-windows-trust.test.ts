import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openHistoryCache,
  type CommitContentAnalysis,
  type HistoryCacheFileSystem,
} from "../src/history-commit-analysis.js";
import type { ServiceDeps } from "../src/services.js";

/**
 * F43 — the history cache trust check on Windows. Node cannot read a Windows
 * DACL without native code (and the server never spawns icacls), so on Windows
 * the cache is trusted only inside a per-user location whose default ACL is
 * private to the user (the profile, os.homedir(), and %LOCALAPPDATA%):
 * - the cache directory must resolve (native realpath) inside one of them;
 * - no component of its path may be a link or junction, except the profile
 *   directory itself or one above it (a relocated profile).
 * Anywhere else the cache is not trusted: nothing is served or written and
 * every commit is analyzed fresh (logged once). The Windows rules are applied
 * through the injected platform, so they also run on POSIX hosts.
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

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

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

interface Fixture {
  readonly root: string;
  readonly logs: string[];
  deps(dataDir: string): ServiceDeps;
}

function makeFixture(): Fixture {
  const root = makeTempDir("causoryn-hwt-root-");
  const logs: string[] = [];
  return {
    root,
    logs,
    deps: (dataDir) =>
      ({
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
      }) as unknown as ServiceDeps,
  };
}

/** The Windows view: no uid, and the given per-user private directories. */
function windowsView(privateDirs: readonly string[]): HistoryCacheFileSystem {
  return { platform: "win32", getuid: () => undefined, privateProfileDirs: () => privateDirs };
}

describe("history cache trust on Windows (F43)", () => {
  it("a data root outside the per-user profile is not trusted: nothing is written or served", async () => {
    const fixture = makeFixture();
    const profile = makeTempDir("causoryn-hwt-profile-");
    const shared = makeTempDir("causoryn-hwt-shared-");
    const cache = openHistoryCache(fixture.deps(shared), "ws", fixture.root, { fileSystem: windowsView([profile]) });
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(false);
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
    expect(readdirSync(shared).filter((name) => name !== "history")).toEqual([]);
    const historyDir = path.join(shared, "history");
    expect(readdirSync(shared).includes("history") ? readdirSync(historyDir) : []).toEqual([]);
    expect(fixture.logs.some((line) => line.includes("outside the user's profile"))).toBe(true);
  });

  it("a data root inside the per-user profile is trusted", async () => {
    const fixture = makeFixture();
    const profile = makeTempDir("causoryn-hwt-profile-");
    const dataDir = path.join(profile, ".causoryn", "workspaces", "app-0123456789ab");
    mkdirSync(dataDir, { recursive: true });
    const cache = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root, { fileSystem: windowsView([profile]) });
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(true);
    expect(await cache!.lookup(SHA_A)).toBeDefined();
  });

  it("a data root reached through a link or junction below the profile is not trusted", async () => {
    const fixture = makeFixture();
    const profile = makeTempDir("causoryn-hwt-profile-");
    const realData = path.join(profile, "real-data");
    mkdirSync(path.join(realData, "workspace"), { recursive: true });
    const linked = path.join(profile, "linked-data");
    symlinkSync(realData, linked, DIR_LINK_TYPE);
    // The data directory itself is real; a component above it is the link.
    const dataDir = path.join(linked, "workspace");
    const cache = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root, { fileSystem: windowsView([profile]) });
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(false);
    expect(await cache!.lookup(SHA_A)).toBeUndefined();
    expect(fixture.logs.some((line) => line.includes("link or junction"))).toBe(true);
  });

  it("a relocated profile (the profile directory itself is a link) stays trusted", async () => {
    const fixture = makeFixture();
    const realProfile = makeTempDir("causoryn-hwt-real-profile-");
    const holder = makeTempDir("causoryn-hwt-holder-");
    const profileLink = path.join(holder, "profile");
    symlinkSync(realProfile, profileLink, DIR_LINK_TYPE);
    const dataDir = path.join(profileLink, ".causoryn");
    mkdirSync(dataDir, { recursive: true });
    const cache = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root, { fileSystem: windowsView([profileLink]) });
    expect(await cache!.store(SHA_A, ANALYSIS)).toBe(true);
    expect(await cache!.lookup(SHA_A)).toBeDefined();
  });

  it("an entry written while trusted is not served once the data root is no longer inside a private directory", async () => {
    const fixture = makeFixture();
    const profile = makeTempDir("causoryn-hwt-profile-");
    const dataDir = path.join(profile, "data");
    mkdirSync(dataDir, { recursive: true });
    const trusted = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root, { fileSystem: windowsView([profile]) });
    expect(await trusted!.store(SHA_A, ANALYSIS)).toBe(true);
    const elsewhere = makeTempDir("causoryn-hwt-elsewhere-");
    const untrusted = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root, { fileSystem: windowsView([elsewhere]) });
    expect(await untrusted!.lookup(SHA_A)).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "real Windows defaults: a data root under the user's profile (os.tmpdir() here) is trusted",
    async () => {
      const fixture = makeFixture();
      const dataDir = makeTempDir("causoryn-hwt-default-");
      const home = realpathSync.native(os.homedir());
      const inProfile = path.relative(home.toLowerCase(), realpathSync.native(dataDir).toLowerCase());
      if (inProfile.startsWith("..") || path.isAbsolute(inProfile)) return; // TEMP relocated outside the profile
      const cache = openHistoryCache(fixture.deps(dataDir), "ws", fixture.root);
      expect(await cache!.store(SHA_A, ANALYSIS)).toBe(true);
      expect(await cache!.lookup(SHA_A)).toBeDefined();
    },
  );
});
