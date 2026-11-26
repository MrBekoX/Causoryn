import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { IndexService, type IndexServiceOptions } from "../src/index.js";

/**
 * Two follow-ups to the truncated-response rule (a worker diagnostic that names
 * no file keeps facts out of the per-file cache):
 *
 * - Scope: the rule applied to every language of the run, so one truncated
 *   sidecar response threw away the cached facts of all other languages too
 *   (a full re-analysis of, e.g., every TypeScript file on the next
 *   incremental run). When the call site knows which adapter reported the
 *   path-less diagnostic, only that language's facts stay out of the cache;
 *   a path-less diagnostic no adapter claims still keeps the whole run out.
 * - Volume (F47 variant): an adapter's warnings were appended with
 *   `warnings.push(...result.warnings)`. Workers bound their warnings by bytes
 *   only, so a response can carry hundreds of thousands of them, more than V8
 *   accepts as call arguments (RangeError): the run, and verify_change on the
 *   main thread, failed for that workspace.
 *
 * The C# adapter is a stub here (IndexServiceOptions.csharp.analyzeCSharp), so
 * no .NET toolchain is needed and the adapter's answer is exact.
 */

const WS = "ws_truncation_scope";
const NOW = "2026-11-27T00:00:00.000Z";

type AnalyzeCSharp = NonNullable<NonNullable<IndexServiceOptions["csharp"]>["analyzeCSharp"]>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** A workspace with one TypeScript file and one C# file. */
function mixedWorkspace(): string {
  const root = tempDir("causoryn-trunc-scope-root-");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n", "utf8");
  writeFileSync(path.join(root, "src", "billing.cs"), "namespace Billing { public class Invoice { } }\n", "utf8");
  return root;
}

/** A healthy C# worker answer for src/billing.cs, optionally truncated (a path-less RESPONSE_TRUNCATED) or with extra warnings. */
function csharpStub(options: { readonly truncated?: boolean; readonly warnings?: readonly string[] } = {}): AnalyzeCSharp {
  return async () => ({
    analyzerId: "roslyn-worker" as const,
    analyzerVersion: "0.1.0",
    workerAvailable: true,
    state: options.truncated === true ? ("partial" as const) : ("ready" as const),
    coverageRatio: 1,
    capabilities: {
      astParse: true,
      symbolResolution: true,
      containsEdges: true,
      callEdges: true,
      importEdges: true,
      routeDetection: "attribute-routing",
      frameworkLinkers: false,
    },
    unsupportedConstructs: [],
    nodes: [
      { kind: "File" as const, qualifiedName: "src/billing.cs", language: "csharp", relativePath: "src/billing.cs" },
    ],
    edges: [],
    evidence: [],
    diagnostics:
      options.truncated === true
        ? [
            {
              relativePath: "",
              code: "RESPONSE_TRUNCATED",
              message: "the worker response reached its size budget; the remaining nodes were dropped",
              line: 0,
            },
          ]
        : [],
    warnings: options.warnings ?? [],
  });
}

function makeService(root: string, repository: SqliteGraphRepository, analyzeCSharp: AnalyzeCSharp): IndexService {
  return new IndexService({
    workspaceId: WS,
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository,
    clock: () => NOW,
    limits: { maxFiles: 1_000 },
    csharp: { analyzeCSharp },
  });
}

function openRepository(): SqliteGraphRepository {
  const repository = new SqliteGraphRepository(path.join(tempDir("causoryn-trunc-scope-db-"), "index.sqlite"));
  cleanups.push(() => repository.close());
  return repository;
}

function cachedPaths(repository: SqliteGraphRepository): string[] {
  return repository
    .listFileFacts(WS)
    .map((fact) => fact.relativePath)
    .sort();
}

describe("file-facts cache: a truncated adapter response only drops its own language", { timeout: 120_000 }, () => {
  it("full run: the TypeScript facts are cached although the C# response was truncated; the C# facts are not", async () => {
    const root = mixedWorkspace();
    const repository = openRepository();
    const result = await makeService(root, repository, csharpStub({ truncated: true })).runIndexAsync(root);
    expect(result.published).toBe(true);
    expect(result.diagnostics.some((d) => d.relativePath === "" && d.code === "RESPONSE_TRUNCATED")).toBe(true);
    expect(cachedPaths(repository)).toEqual(["src/app.ts"]);
  });

  it("incremental run: a truncated C# re-analysis keeps the cached TypeScript facts and drops the C# ones", async () => {
    const root = mixedWorkspace();
    const repository = openRepository();
    await makeService(root, repository, csharpStub()).runIndexAsync(root);
    expect(cachedPaths(repository)).toEqual(["src/app.ts", "src/billing.cs"]);

    writeFileSync(path.join(root, "src", "billing.cs"), "namespace Billing { public class Invoice { public int Id; } }\n", "utf8");
    const incremental = await makeService(root, repository, csharpStub({ truncated: true })).runIncrementalIndexAsync(
      root,
      ["src/billing.cs"],
    );
    expect(incremental.published).toBe(true);
    expect(cachedPaths(repository)).toEqual(["src/app.ts"]);
  });
});

const pythonAvailable = spawnSync("python", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!pythonAvailable) {
  console.error("[file-facts-truncation-scope] python not found — the real Python worker test is skipped (not run)");
}

describe("file-facts cache with the real Python worker", () => {
  it.skipIf(!pythonAvailable)(
    "a TypeScript file's facts survive a RESPONSE_TRUNCATED Python response; the Python facts are not cached",
    async () => {
      const root = tempDir("causoryn-trunc-scope-py-");
      mkdirSync(path.join(root, "pkg"), { recursive: true });
      mkdirSync(path.join(root, "src"), { recursive: true });
      // One long caller name copied into the evidence of every call: the
      // worker's response budget is reached long before the file ends.
      const big = [`def ${"A".repeat(600)}():`, ...Array.from({ length: 40_000 }, () => " a()"), ""].join("\n");
      writeFileSync(path.join(root, "pkg", "big.py"), big, "utf8");
      writeFileSync(path.join(root, "pkg", "small.py"), "def helper():\n    return 1\n", "utf8");
      writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 42;\n", "utf8");
      const repository = openRepository();
      const service = new IndexService({
        workspaceId: WS,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
        repository,
        clock: () => NOW,
        limits: { maxFiles: 1_000 },
        python: { pythonCommand: "python" },
      });
      const result = await service.runIndexAsync(root);
      expect(result.published).toBe(true);
      expect(result.diagnostics.some((d) => d.relativePath === "" && d.code === "RESPONSE_TRUNCATED")).toBe(true);
      expect(cachedPaths(repository)).toEqual(["src/app.ts"]);
    },
    180_000,
  );
});

describe("adapter warnings of any volume (F47 variant)", { timeout: 120_000 }, () => {
  it("a run whose adapter reports 400,000 warnings completes and keeps every one of them", async () => {
    const root = mixedWorkspace();
    const repository = openRepository();
    const many = Array.from({ length: 400_000 }, (_, index) => `w${String(index)}`);
    const result = await makeService(root, repository, csharpStub({ warnings: many })).runIndexAsync(root);
    expect(result.published).toBe(true);
    expect(result.warnings.filter((line) => /^w\d+$/.test(line))).toHaveLength(many.length);
  });

  it("an incremental re-analysis whose adapter reports 400,000 warnings completes too", async () => {
    const root = mixedWorkspace();
    const repository = openRepository();
    await makeService(root, repository, csharpStub()).runIndexAsync(root);
    writeFileSync(path.join(root, "src", "billing.cs"), "namespace Billing { public class Receipt { } }\n", "utf8");
    const many = Array.from({ length: 400_000 }, (_, index) => `w${String(index)}`);
    const result = await makeService(root, repository, csharpStub({ warnings: many })).runIncrementalIndexAsync(root, [
      "src/billing.cs",
    ]);
    expect(result.published).toBe(true);
    expect(result.warnings.filter((line) => /^w\d+$/.test(line))).toHaveLength(many.length);
  });
});
