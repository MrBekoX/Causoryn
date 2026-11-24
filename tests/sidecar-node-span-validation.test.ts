import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sha256Hex, utf8Encode, type SnapshotNodeInput } from "@causoryn/domain";
import { analyzeCSharpWorkspace } from "../adapters/csharp-roslyn/src/index.js";
import { analyzeGoWorkspace } from "../adapters/go/src/index.js";
import { analyzePythonWorkspace } from "../adapters/python/src/index.js";
import { analyzeRustWorkspace } from "../adapters/rust/src/index.js";

/**
 * The C#, Python, Go and Rust adapters map the optional worker node `span`
 * ({ startLine, endLine }, 1-based) to the node `location`, bound to the file
 * and source hash the adapter itself sent. Worker output is not trusted: a span
 * that is not a pair of positive integers, runs backwards, ends past the last
 * line of the file, sits on a File node or on a node without an analyzed file
 * is dropped (the node keeps its file anchor) and one warning reports it.
 *
 * Every worker here is a fake child process (no toolchain is needed): it
 * answers the analyze request with a fixed protocol response.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Six lines: five with text and an empty one after the final newline. */
const SOURCE = "one\ntwo\nthree\nfour\nfive\n";
const SOURCE_HASH = sha256Hex(utf8Encode(SOURCE));

interface AdapterCase {
  readonly language: string;
  readonly relativePath: string;
  readonly run: (
    workspaceId: string,
    spawnProcess: () => ChildProcess,
  ) => Promise<{
    readonly workerAvailable: boolean;
    readonly nodes: readonly SnapshotNodeInput[];
    readonly warnings: readonly string[];
  }>;
}

const CASES: readonly AdapterCase[] = [
  {
    language: "csharp",
    relativePath: "src/Ledger.cs",
    run: (workspaceId, spawnProcess) =>
      analyzeCSharpWorkspace({
        workspaceId,
        files: [{ path: "src/Ledger.cs", content: SOURCE }],
        options: {
          dotnetCommand: process.execPath,
          workerDllPath: path.join(os.tmpdir(), "causoryn-fake-roslyn-worker.dll"),
          requestTimeoutMs: 10_000,
          spawnProcess,
        },
      }),
  },
  {
    language: "python",
    relativePath: "billing/ledger.py",
    run: (workspaceId, spawnProcess) =>
      analyzePythonWorkspace({
        workspaceId,
        files: [{ path: "billing/ledger.py", content: SOURCE }],
        options: {
          pythonCommand: process.execPath,
          requestTimeoutMs: 10_000,
          spawnProcess,
        },
      }),
  },
  {
    language: "go",
    relativePath: "billing/ledger.go",
    run: (workspaceId, spawnProcess) =>
      analyzeGoWorkspace({
        workspaceId,
        files: [{ path: "billing/ledger.go", content: SOURCE }],
        options: {
          goWorkerBinaryPath: process.execPath,
          workerDir: REPO_ROOT,
          requestTimeoutMs: 10_000,
          spawnProcess,
        },
      }),
  },
  {
    language: "rust",
    relativePath: "src/ledger.rs",
    run: (workspaceId, spawnProcess) =>
      analyzeRustWorkspace({
        workspaceId,
        files: [{ path: "src/ledger.rs", content: SOURCE }],
        options: {
          workerDir: path.join(os.tmpdir(), "causoryn-fake-rust-worker-dir"),
          requestTimeoutMs: 10_000,
          spawnProcess,
        },
      }),
  },
];

/** A child process that answers with one protocol line and never exits on its own. */
function fakeWorker(responseLine: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  const record = child as unknown as Record<string, unknown>;
  record.stdout = stdout;
  record.stderr = stderr;
  record.stdin = Object.assign(stdin, { write: () => true, end: () => {} });
  record.killed = false;
  record.exitCode = null;
  record.signalCode = null;
  record.kill = () => true;
  queueMicrotask(() => {
    stdout.emit("data", Buffer.from(`${responseLine}\n`, "utf8"));
  });
  return child;
}

function workerResponse(id: string, language: string, file: string): string {
  const symbol = (qualifiedName: string, span?: unknown) => ({
    kind: "Function",
    qualifiedName,
    language,
    relativePath: file,
    attributes: {},
    ...(span === undefined ? {} : { span }),
  });
  return JSON.stringify({
    id,
    protocolVersion: "1",
    status: "ready",
    worker: { analyzerId: `${language}-worker`, analyzerVersion: "0.1.0" },
    capabilities: { astParse: true, symbolResolution: true, containsEdges: true },
    coverageRatio: 1,
    unsupportedConstructs: [],
    warnings: [],
    diagnostics: [],
    nodes: [
      {
        kind: "File",
        qualifiedName: file,
        language,
        relativePath: file,
        attributes: { sourceHash: SOURCE_HASH },
        span: { startLine: 1, endLine: 2 },
      },
      symbol("valid", { startLine: 2, endLine: 3 }),
      symbol("lastLine", { startLine: 6, endLine: 6 }),
      symbol("noSpan"),
      symbol("zeroStart", { startLine: 0, endLine: 3 }),
      symbol("fraction", { startLine: 1.5, endLine: 3 }),
      symbol("textLines", { startLine: "2", endLine: "3" }),
      symbol("backwards", { startLine: 4, endLine: 2 }),
      symbol("pastEnd", { startLine: 2, endLine: 7 }),
      symbol("notAnObject", "2-3"),
      { ...symbol("otherFile", { startLine: 1, endLine: 1 }), relativePath: "elsewhere/x.src" },
      {
        kind: "UnknownExternal",
        qualifiedName: "fmt.Println",
        language,
        attributes: {},
        span: { startLine: 1, endLine: 1 },
      },
    ],
    edges: [],
    evidence: [],
  });
}

describe("sidecar adapters: worker node spans are validated before they become node locations", () => {
  for (const adapter of CASES) {
    it(`${adapter.language}: keeps valid spans and drops invalid ones with one warning`, async () => {
      const workspaceId = `span-validation-${adapter.language}`;
      const response = workerResponse(`analyze:${workspaceId}`, adapter.language, adapter.relativePath);
      const result = await adapter.run(workspaceId, () => fakeWorker(response));

      expect(result.workerAvailable).toBe(true);
      // Spans are dropped, nodes are not.
      expect(result.nodes).toHaveLength(12);
      const byName = new Map(result.nodes.map((node) => [node.qualifiedName, node]));

      expect(byName.get("valid")?.location).toEqual({
        relativePath: adapter.relativePath,
        startLine: 2,
        endLine: 3,
        sourceHash: SOURCE_HASH,
      });
      expect(byName.get("lastLine")?.location).toEqual({
        relativePath: adapter.relativePath,
        startLine: 6,
        endLine: 6,
        sourceHash: SOURCE_HASH,
      });
      for (const name of [
        adapter.relativePath,
        "noSpan",
        "zeroStart",
        "fraction",
        "textLines",
        "backwards",
        "pastEnd",
        "notAnObject",
        "otherFile",
        "fmt.Println",
      ]) {
        expect(byName.get(name), name).toBeDefined();
        expect(byName.get(name)?.location, name).toBeUndefined();
      }

      const spanWarnings = result.warnings.filter((warning) => warning.includes("node span"));
      expect(spanWarnings).toHaveLength(1);
      expect(spanWarnings[0]).toMatch(/^dropped 9 invalid node spans from the worker/);
      expect(spanWarnings[0]).toContain(`File ${adapter.relativePath}`);
    });
  }

  it("a worker-provided name quoted in the span warning is bounded", async () => {
    const adapter = CASES[2] as AdapterCase;
    const workspaceId = "span-validation-long-name";
    const longName = "x".repeat(5_000);
    const response = JSON.stringify({
      id: `analyze:${workspaceId}`,
      protocolVersion: "1",
      status: "ready",
      nodes: [
        {
          kind: "Function",
          qualifiedName: longName,
          language: "go",
          relativePath: adapter.relativePath,
          attributes: {},
          span: { startLine: 0, endLine: 0 },
        },
      ],
      edges: [],
    });
    const result = await adapter.run(workspaceId, () => fakeWorker(response));
    const warning = result.warnings.find((candidate) => candidate.includes("node span"));
    expect(warning).toBeDefined();
    expect(warning?.length).toBeLessThan(400);
    expect(warning).toContain(`Function ${"x".repeat(200)}...:`);
  });

  it("a response without node spans produces no span warning", async () => {
    const adapter = CASES[1] as AdapterCase;
    const workspaceId = "span-validation-absent";
    const response = JSON.stringify({
      id: `analyze:${workspaceId}`,
      protocolVersion: "1",
      status: "ready",
      nodes: [
        {
          kind: "Function",
          qualifiedName: "plain",
          language: "python",
          relativePath: adapter.relativePath,
          attributes: {},
        },
      ],
      edges: [],
    });
    const result = await adapter.run(workspaceId, () => fakeWorker(response));
    expect(result.workerAvailable).toBe(true);
    expect(result.nodes[0]?.location).toBeUndefined();
    expect(result.warnings.filter((warning) => warning.includes("node span"))).toEqual([]);
  });
});
