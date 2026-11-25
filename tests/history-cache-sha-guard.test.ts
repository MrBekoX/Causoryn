import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openHistoryCache } from "../packages/mcp-server/src/history-commit-analysis.js";
import type { ServiceDeps } from "../packages/mcp-server/src/services.js";

/**
 * The history cache names its files after the commit SHA. Only canonical
 * 40/64-hex commit SHAs may become file names: anything else is never looked
 * up or written, so a malformed value cannot address a path outside the cache.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeDeps(root: string, dataDir: string): ServiceDeps {
  return {
    config: { storage: { dataDbPath: path.join(dataDir, "graph.sqlite") }, allowRoots: [root], index: { maxFiles: 100 } },
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
    logger: () => {},
    repository: { getLatestPublished: () => undefined },
  } as unknown as ServiceDeps;
}

describe("history cache — commit SHA guard", () => {
  it("refuses to look up or store an entry for a value that is not a canonical commit SHA", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-hc-root-"));
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-hc-data-"));
    dirs.push(root, dataDir);
    mkdirSync(path.join(dataDir, "history"), { mode: 0o700 });
    const cache = openHistoryCache(fakeDeps(root, dataDir), "ws", root);
    expect(cache).not.toBeNull();
    const analysis = {
      state: "ready",
      fileCount: 0,
      skippedFiles: 0,
      degradedWorkers: [],
      contentSet: { nodes: [], edges: [] },
    } as unknown as Parameters<NonNullable<typeof cache>["store"]>[1];

    for (const bad of ["../escape", "..\\escape", "HEAD", "0123456789abcdef", `${"a".repeat(40)}/x`]) {
      expect(await cache!.lookup(bad), bad).toBeUndefined();
      expect(await cache!.store(bad, analysis), bad).toBe(false);
    }
    expect(readdirSync(path.join(dataDir, "history"))).toEqual([]);
    expect(existsSync(path.join(dataDir, "escape-"))).toBe(false);
    expect(readdirSync(dataDir).sort()).toEqual(["history"]);

    // A canonical SHA is accepted.
    const sha = "b".repeat(40);
    expect(await cache!.store(sha, analysis)).toBe(true);
    expect(readdirSync(path.join(dataDir, "history")).some((name) => name.startsWith(`${sha}-`))).toBe(true);
  });
});
