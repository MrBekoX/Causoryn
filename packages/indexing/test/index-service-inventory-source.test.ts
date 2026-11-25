import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex, utf8Encode } from "@causoryn/domain";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { IndexService, IndexingError, type InventoryEntry } from "../src/index.js";

/**
 * IndexServiceOptions.inventorySource: an injected inventory replaces the
 * on-disk walk (used to analyze a git commit from its objects). Root
 * authorization, partitioning and the analyzers stay the same; the on-disk
 * sources of the root are never read as sources.
 */

const FIXED_NOW = "2026-11-25T00:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "causoryn-inventory-source-")));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "disk.ts"), "export function onDisk(): number {\n  return 1;\n}\n", "utf8");
  return root;
}

function entryOf(relativePath: string, content: string): InventoryEntry {
  return {
    relativePath,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentHash: sha256Hex(utf8Encode(content)),
    content,
  };
}

function makeService(
  root: string,
  inventorySource: (canonicalRoot: string, maxFiles: number) => Promise<readonly InventoryEntry[]>,
  maxFiles = 50,
): IndexService {
  return new IndexService({
    workspaceId: "inventory-source",
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository: new InMemoryGraphRepository(),
    clock: () => FIXED_NOW,
    limits: { maxFiles },
    inventorySource,
  });
}

const MEMORY_SOURCE = "export class MemoryService {\n  run(): string {\n    return \"memory\";\n  }\n}\n";

describe("IndexService inventorySource", { timeout: 60_000 }, () => {
  it("analyzes the injected entries instead of walking the root", async () => {
    const root = makeRoot();
    const calls: Array<{ root: string; maxFiles: number }> = [];
    const service = makeService(root, async (canonicalRoot, maxFiles) => {
      calls.push({ root: canonicalRoot, maxFiles });
      // Deliberately unsorted: the service sorts like the on-disk inventory.
      return [
        entryOf("src/memory.ts", MEMORY_SOURCE),
        entryOf("README.md", "# memory\n"),
      ];
    });

    const run = await service.runIndexAsync(root);

    expect(calls).toEqual([{ root, maxFiles: 50 }]);
    const names = run.snapshot.nodes.map((node) => node.qualifiedName);
    expect(names).toContain("MemoryService");
    expect(names).toContain("MemoryService.run");
    expect(names).not.toContain("onDisk");
    expect(run.snapshot.nodes.some((node) => node.location?.relativePath === "src/disk.ts")).toBe(false);
    expect(run.fileCount).toBe(2);
    const memoryFile = run.snapshot.nodes.find(
      (node) => node.kind === "File" && node.location?.relativePath === "src/memory.ts",
    );
    expect(memoryFile?.location?.sourceHash).toBe(sha256Hex(utf8Encode(MEMORY_SOURCE)));
  });

  it("enforces index.maxFiles on the injected entries", async () => {
    const root = makeRoot();
    const service = makeService(
      root,
      async () => [entryOf("src/a.ts", "export const a = 1;\n"), entryOf("src/b.ts", "export const b = 2;\n")],
      1,
    );
    const error = await service.runIndexAsync(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexingError);
    expect((error as IndexingError).code).toBe("indexing/limit-exceeded");
  });

  it("rejects duplicate paths in the injected entries", async () => {
    const root = makeRoot();
    const service = makeService(root, async () => [
      entryOf("src/a.ts", "export const a = 1;\n"),
      entryOf("src/a.ts", "export const a = 2;\n"),
    ]);
    const error = await service.runIndexAsync(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexingError);
    expect((error as IndexingError).code).toBe("indexing/internal");
  });

  it("still authorizes the root before the source is consulted", async () => {
    const root = makeRoot();
    let consulted = false;
    const service = new IndexService({
      workspaceId: "inventory-source",
      policy: WorkspaceAccessPolicy.create({ allowRoots: [] }),
      repository: new InMemoryGraphRepository(),
      clock: () => FIXED_NOW,
      limits: { maxFiles: 50 },
      inventorySource: async () => {
        consulted = true;
        return [];
      },
    });
    const error = await service.runIndexAsync(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexingError);
    expect((error as IndexingError).code).toBe("indexing/root-not-authorized");
    expect(consulted).toBe(false);
  });

  it("refuses the synchronous pipeline and off-thread execution with an injected source", () => {
    const root = makeRoot();
    const service = makeService(root, async () => [entryOf("src/memory.ts", MEMORY_SOURCE)]);
    let caught: unknown;
    try {
      service.runIndex(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingError);
    expect((caught as IndexingError).code).toBe("indexing/internal");
    expect(service.getWorkerConfig()).toBeUndefined();
  });
});
