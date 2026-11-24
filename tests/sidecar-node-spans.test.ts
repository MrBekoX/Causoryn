import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GraphNode, SnapshotGraph } from "@causoryn/domain";
import { generateAgentContext, InMemoryGraphRepository } from "@causoryn/graph";
import { IndexService } from "@causoryn/indexing";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { isCargoAvailable } from "../adapters/rust/src/cargo.js";
import { buildRoslynWorkerBinary } from "./roslyn-worker-build.js";
import {
  bootstrapRustWorkerBinary,
  buildRustWorkerBinary,
  RUST_WORKER_BINARY_PATH,
  RUST_WORKER_DIR,
} from "./rust-worker-build.js";

/**
 * End-to-end: real indexes of small C#, Python, Go and Rust sources through the
 * real native workers (IndexService.runIndexAsync).
 *
 * 1. Stored symbol nodes carry their real 1-based declaration span instead of
 *    the `1:1` file anchor, and the span equals the union of the CONTAINS
 *    evidence spans that point at the node (one evidence per declaration).
 * 2. A node with several declarations (C# overloads, a Python property getter
 *    and setter, two Go `init` functions, one Rust method name in two impl
 *    blocks) is widened to cover all of them.
 * 3. `generateAgentContext` reports the declaration span.
 *
 * Fixtures are written only under os.tmpdir() and removed afterwards; the
 * index lives in memory. A language whose toolchain is missing is skipped and
 * reported on stderr (it could not be run); a failing worker build fails.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROSLYN_WORKER_DLL = path.join(
  REPO_ROOT,
  "native",
  "roslyn-worker",
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);
const GO_BINARY = process.env["CAUSORYN_GO_BINARY"]?.trim() || "go";

function toolAvailable(command: string, args: readonly string[]): boolean {
  return spawnSync(command, args, { encoding: "utf8", shell: false }).status === 0;
}

const dotnetAvailable = toolAvailable("dotnet", ["--version"]);
const pythonAvailable = toolAvailable("python", ["--version"]);
const goAvailable = toolAvailable(GO_BINARY, ["version"]);
const cargoAvailable = isCargoAvailable();
for (const [name, available] of [
  ["dotnet", dotnetAvailable],
  ["python", pythonAvailable],
  ["go", goAvailable],
  ["cargo", cargoAvailable],
] as const) {
  if (!available) {
    console.error(`[sidecar-node-spans] ${name} not found — its block is skipped (could not be run)`);
  }
}

const CSHARP_LEDGER = [
  "namespace Demo.Billing;", // 1
  "", // 2
  "public class InvoiceLedger", // 3
  "{", // 4
  "    public int Record(int amount)", // 5
  "    {", // 6
  "        return Compute(amount);", // 7
  "    }", // 8
  "", // 9
  "    public int Record(int amount, int tax)", // 10
  "    {", // 11
  "        return Compute(amount + tax);", // 12
  "    }", // 13
  "", // 14
  "    private static int Compute(int value)", // 15
  "    {", // 16
  "        return value * 2;", // 17
  "    }", // 18
  "}", // 19
  "",
].join("\n");

const PYTHON_LEDGER = [
  '"""Ledger module."""', // 1
  "", // 2
  "", // 3
  "def compute_total(items):", // 4
  "    total = 0", // 5
  "    for item in items:", // 6
  "        total += item", // 7
  "    return total", // 8
  "", // 9
  "", // 10
  "class InvoiceLedger:", // 11
  "    def __init__(self):", // 12
  "        self._amount = 0", // 13
  "", // 14
  "    @property", // 15
  "    def amount(self):", // 16
  "        return self._amount", // 17
  "", // 18
  "    @amount.setter", // 19
  "    def amount(self, value):", // 20
  "        self._amount = value", // 21
  "", // 22
  "    def record(self, items):", // 23
  "        return compute_total(items)", // 24
  "",
].join("\n");

const GO_LEDGER = [
  "package billing", // 1
  "", // 2
  "// ComputeTotal sums the items.", // 3
  "func ComputeTotal(items []int) int {", // 4
  "\ttotal := 0", // 5
  "\tfor _, item := range items {", // 6
  "\t\ttotal += item", // 7
  "\t}", // 8
  "\treturn total", // 9
  "}", // 10
  "", // 11
  "// InvoiceLedger records invoices.", // 12
  "type InvoiceLedger struct {", // 13
  "\tamount int", // 14
  "}", // 15
  "", // 16
  "// Record stores the total.", // 17
  "func (l *InvoiceLedger) Record(items []int) int {", // 18
  "\tl.amount = ComputeTotal(items)", // 19
  "\treturn l.amount", // 20
  "}", // 21
  "", // 22
  "func init() {", // 23
  "}", // 24
  "", // 25
  "func init() {", // 26
  "\t_ = ComputeTotal(nil)", // 27
  "}", // 28
  "",
].join("\n");

const RUST_LEDGER = [
  "/// Sums the items.", // 1
  "pub fn compute_total(items: &[u32]) -> u32 {", // 2
  "    items.iter().sum()", // 3
  "}", // 4
  "", // 5
  "pub struct InvoiceLedger {", // 6
  "    amount: u32,", // 7
  "}", // 8
  "", // 9
  "impl InvoiceLedger {", // 10
  "    pub fn record(&mut self, items: &[u32]) -> u32 {", // 11
  "        self.amount = compute_total(items);", // 12
  "        self.amount", // 13
  "    }", // 14
  "}", // 15
  "", // 16
  "impl std::fmt::Display for InvoiceLedger {", // 17
  "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {", // 18
  '        write!(f, "{}", self.amount)', // 19
  "    }", // 20
  "}", // 21
  "", // 22
  "impl std::fmt::Debug for InvoiceLedger {", // 23
  "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {", // 24
  '        write!(f, "ledger {}", self.amount)', // 25
  "    }", // 26
  "}", // 27
  "",
].join("\n");

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-sidecar-spans-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

type LanguageOptions = Pick<
  ConstructorParameters<typeof IndexService>[0],
  "csharp" | "python" | "go" | "rust"
>;

async function indexFixture(
  files: Readonly<Record<string, string>>,
  options: LanguageOptions,
): Promise<SnapshotGraph> {
  const root = writeFixture(files);
  const service = new IndexService({
    workspaceId: "ws-sidecar-spans",
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository: new InMemoryGraphRepository(),
    clock: () => "2026-11-24T00:00:00.000Z",
    limits: { maxFiles: 1_000 },
    ...options,
  });
  const run = await service.runIndexAsync(root);
  return run.snapshot;
}

function findNode(snapshot: SnapshotGraph, kind: string, qualifiedName: string): GraphNode {
  const node = snapshot.nodes.find(
    (candidate) => candidate.kind === kind && candidate.qualifiedName === qualifiedName,
  );
  expect(node, `${kind} ${qualifiedName} not found`).toBeDefined();
  return node as GraphNode;
}

/**
 * The stored node span is the declaration span, it agrees with the CONTAINS
 * evidence that points at the node (widened over every declaration), and its
 * source hash is the inventory hash of the same file.
 */
function expectDeclarationSpan(
  snapshot: SnapshotGraph,
  kind: string,
  qualifiedName: string,
  expected: { readonly relativePath: string; readonly startLine: number; readonly endLine: number },
): void {
  const node = findNode(snapshot, kind, qualifiedName);
  expect(node.location, `${qualifiedName} location`).toMatchObject(expected);

  const evidenceById = new Map(snapshot.evidence.map((evidence) => [evidence.id, evidence]));
  const containsSpans = snapshot.edges
    .filter((edge) => edge.kind === "CONTAINS" && edge.to === node.id)
    .flatMap((edge) => edge.evidenceIds)
    .map((id) => evidenceById.get(id)?.span)
    .filter((span) => span !== undefined);
  expect(containsSpans.length, `${qualifiedName} CONTAINS evidence`).toBeGreaterThan(0);
  expect({
    startLine: Math.min(...containsSpans.map((span) => span.startLine)),
    endLine: Math.max(...containsSpans.map((span) => span.endLine)),
  }).toEqual({ startLine: expected.startLine, endLine: expected.endLine });
  for (const span of containsSpans) {
    expect(span.relativePath).toBe(expected.relativePath);
    expect(span.sourceHash).toBe(node.location?.sourceHash);
  }
  const fileNode = findNode(snapshot, "File", expected.relativePath);
  expect(node.location?.sourceHash).toBe(fileNode.location?.sourceHash);
}

function expectAgentContextSpan(
  snapshot: SnapshotGraph,
  task: string,
  qualifiedName: string,
  expected: { readonly startLine: number; readonly endLine: number },
): void {
  const context = generateAgentContext(snapshot, { task, tokenBudget: 4096 });
  const item = context.contextItems.find((candidate) => candidate.qualifiedName === qualifiedName);
  expect(item, `${qualifiedName} context item`).toBeDefined();
  expect(item?.span).toEqual(expected);
}

describe.skipIf(!dotnetAvailable)("C# symbol node spans (Roslyn worker)", { timeout: 300_000 }, () => {
  let snapshot: SnapshotGraph | null = null;

  beforeAll(async () => {
    const build = buildRoslynWorkerBinary();
    if (build.status !== 0 || !existsSync(ROSLYN_WORKER_DLL)) {
      throw new Error(
        `Roslyn worker build failed (exit=${String(build.status)}): ${build.stdout.slice(-400)}`,
      );
    }
    snapshot = await indexFixture(
      { "src/InvoiceLedger.cs": CSHARP_LEDGER },
      { csharp: { workerDllPath: ROSLYN_WORKER_DLL } },
    );
  }, 300_000);

  it("stores class, method and overload spans and reports them in agent context", () => {
    const graph = snapshot as SnapshotGraph;
    const file = "src/InvoiceLedger.cs";
    expectDeclarationSpan(graph, "Class", "Demo.Billing.InvoiceLedger", {
      relativePath: file,
      startLine: 3,
      endLine: 19,
    });
    expectDeclarationSpan(graph, "Method", "Demo.Billing.InvoiceLedger.Compute", {
      relativePath: file,
      startLine: 15,
      endLine: 18,
    });
    // Two overloads share one node: the span covers both declarations.
    expectDeclarationSpan(graph, "Method", "Demo.Billing.InvoiceLedger.Record", {
      relativePath: file,
      startLine: 5,
      endLine: 13,
    });
    expect(findNode(graph, "File", file).location).toMatchObject({ startLine: 1, endLine: 1 });
    expectAgentContextSpan(graph, "Compute", "Demo.Billing.InvoiceLedger.Compute", {
      startLine: 15,
      endLine: 18,
    });
  });
});

describe.skipIf(!pythonAvailable)("Python symbol node spans (python worker)", { timeout: 120_000 }, () => {
  let snapshot: SnapshotGraph | null = null;

  beforeAll(async () => {
    snapshot = await indexFixture({ "billing/ledger.py": PYTHON_LEDGER }, {});
  }, 120_000);

  it("stores function, class, method and property spans and reports them in agent context", () => {
    const graph = snapshot as SnapshotGraph;
    const file = "billing/ledger.py";
    expectDeclarationSpan(graph, "Function", "billing.ledger.compute_total", {
      relativePath: file,
      startLine: 4,
      endLine: 8,
    });
    expectDeclarationSpan(graph, "Class", "billing.ledger.InvoiceLedger", {
      relativePath: file,
      startLine: 11,
      endLine: 24,
    });
    expectDeclarationSpan(graph, "Method", "billing.ledger.InvoiceLedger.record", {
      relativePath: file,
      startLine: 23,
      endLine: 24,
    });
    // Property getter + setter share one node: the span covers both `def`s.
    expectDeclarationSpan(graph, "Method", "billing.ledger.InvoiceLedger.amount", {
      relativePath: file,
      startLine: 16,
      endLine: 21,
    });
    expectAgentContextSpan(graph, "compute_total", "billing.ledger.compute_total", {
      startLine: 4,
      endLine: 8,
    });
  });
});

describe.skipIf(!goAvailable)("Go symbol node spans (go worker)", { timeout: 300_000 }, () => {
  let snapshot: SnapshotGraph | null = null;

  beforeAll(async () => {
    snapshot = await indexFixture(
      { "billing/ledger.go": GO_LEDGER },
      { go: { goBinaryPath: GO_BINARY } },
    );
  }, 300_000);

  it("stores function, struct and method spans and reports them in agent context", () => {
    const graph = snapshot as SnapshotGraph;
    const file = "billing/ledger.go";
    expectDeclarationSpan(graph, "Function", "billing.ComputeTotal", {
      relativePath: file,
      startLine: 4,
      endLine: 10,
    });
    expectDeclarationSpan(graph, "Class", "billing.InvoiceLedger", {
      relativePath: file,
      startLine: 13,
      endLine: 15,
    });
    expectDeclarationSpan(graph, "Method", "billing.InvoiceLedger.Record", {
      relativePath: file,
      startLine: 18,
      endLine: 21,
    });
    // Two `init` functions share one node: the span covers both.
    expectDeclarationSpan(graph, "Function", "billing.init", {
      relativePath: file,
      startLine: 23,
      endLine: 28,
    });
    expectAgentContextSpan(graph, "ComputeTotal", "billing.ComputeTotal", {
      startLine: 4,
      endLine: 10,
    });
  });
});

describe.skipIf(!cargoAvailable)("Rust symbol node spans (rust worker)", { timeout: 900_000 }, () => {
  let snapshot: SnapshotGraph | null = null;

  beforeAll(async () => {
    bootstrapRustWorkerBinary({
      cargoAvailable,
      binaryExists: () => existsSync(RUST_WORKER_BINARY_PATH),
      runBuild: buildRustWorkerBinary,
    });
    snapshot = await indexFixture(
      { "src/ledger.rs": RUST_LEDGER },
      { rust: { workerDir: RUST_WORKER_DIR } },
    );
  }, 900_000);

  it("stores fn, struct and impl method spans and reports them in agent context", () => {
    const graph = snapshot as SnapshotGraph;
    const file = "src/ledger.rs";
    // syn item spans include outer attributes and doc comments (`///`).
    expectDeclarationSpan(graph, "Function", "crate::ledger::compute_total", {
      relativePath: file,
      startLine: 1,
      endLine: 4,
    });
    expectDeclarationSpan(graph, "Class", "crate::ledger::InvoiceLedger", {
      relativePath: file,
      startLine: 6,
      endLine: 8,
    });
    expectDeclarationSpan(graph, "Method", "crate::ledger::InvoiceLedger::record", {
      relativePath: file,
      startLine: 11,
      endLine: 14,
    });
    // `fmt` is declared in two impl blocks: the span covers both.
    expectDeclarationSpan(graph, "Method", "crate::ledger::InvoiceLedger::fmt", {
      relativePath: file,
      startLine: 18,
      endLine: 26,
    });
    expectAgentContextSpan(graph, "compute_total", "crate::ledger::compute_total", {
      startLine: 1,
      endLine: 4,
    });
  });
});
