import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { IndexService } from "../src/index.js";

/**
 * A worker that hits its response budget (Go/Python/Roslyn RESPONSE_TRUNCATED,
 * or a node budget) reports it with one diagnostic that names no file
 * (`relativePath: ""`): the facts of every file in that response may be
 * incomplete. Such facts must never reach the per-file cache, or a later
 * incremental run with no dirty file of that language would reuse them and
 * report the analysis as complete.
 */

const WS = "ws_truncated_facts";
const pythonAvailable = spawnSync("python", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!pythonAvailable) {
  console.error("[truncated-response-facts] python not found — the real-worker test is skipped (not run)");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

describe("IndexService — a truncated worker response is not cached per file", () => {
  it.skipIf(!pythonAvailable)(
    "keeps the facts of a RESPONSE_TRUNCATED Python response out of the file-facts cache",
    async () => {
      const root = tempDir("causoryn-truncated-root-");
      mkdirSync(path.join(root, "pkg"), { recursive: true });
      // One long caller name copied into the evidence of every call: the
      // worker's response budget is reached long before the file ends.
      const big = [`def ${"A".repeat(600)}():`, ...Array.from({ length: 40_000 }, () => " a()"), ""].join("\n");
      writeFileSync(path.join(root, "pkg", "big.py"), big, "utf8");
      writeFileSync(path.join(root, "pkg", "small.py"), "def helper():\n    return 1\n", "utf8");

      const dbPath = path.join(tempDir("causoryn-truncated-db-"), "index.sqlite");
      const repository = new SqliteGraphRepository(dbPath);
      cleanups.push(() => repository.close());
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
        repository,
        clock: () => "2026-11-26T00:00:00.000Z",
        limits: { maxFiles: 1_000 },
        python: { pythonCommand: "python" },
      });

      const result = await service.runIndexAsync(root);

      expect(result.published).toBe(true);
      expect(result.warnings.some((line) => line.includes("RESPONSE_TRUNCATED"))).toBe(true);
      expect(repository.getLatestPublished(WS)?.snapshot.meta.state).toBe("partial");
      const cached = repository.listFileFacts(WS).map((fact) => fact.relativePath);
      expect(cached).not.toContain("pkg/big.py");
      expect(cached).not.toContain("pkg/small.py");
    },
    180_000,
  );
});
