/**
 * Roslyn worker output bounds (security scan findings F9 and F29).
 *
 * The worker copies source-derived text (namespace prefixes, qualified names,
 * call texts) into nodes, keys, rationales and warnings. These tests prove that
 * a crafted .cs file cannot make one emitted string, the declaration walk or the
 * whole response grow without bound:
 * - every emitted name is capped at 1024 characters; a longer one keeps its
 *   first characters plus a `~<16 hex>` SHA-256 suffix, so distinct names stay
 *   distinct and the result is deterministic,
 * - the declaration walk stops at the traversal depth limit with one
 *   diagnostic per file,
 * - the response text has a total budget; reaching it truncates explicitly
 *   (RESPONSE_TRUNCATED, status "partial"), well below the adapter's default
 *   64M-character response cap.
 * Names at or below the cap are emitted unchanged (normal code is unaffected).
 *
 * Process safety: the worker runs as the literal `dotnet` executable with a
 * fixed argument array and shell:false; inputs only travel over stdin.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRoslynWorkerBinary } from "./roslyn-worker-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DLL = join(REPO_ROOT, "native", "roslyn-worker", "bin", "Debug", "net10.0", "Causoryn.RoslynWorker.dll");

const MAX_NAME = 1024;
const CAPPED = /~[0-9a-f]{16}$/;
/** The adapter's default response cap (adapters/csharp-roslyn DEFAULT_RESPONSE_MAX_CHARS). */
const ADAPTER_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

interface NodeRef {
  kind: string;
  qualifiedName: string;
  relativePath?: string | null;
}

interface WorkerResponse {
  id: unknown;
  status: string;
  diagnostics?: Array<{ relativePath: string; code: string; message: string; line: number }>;
  nodes?: Array<NodeRef & { attributes: Record<string, unknown> }>;
  edges?: Array<{
    kind: string;
    from: NodeRef;
    to: NodeRef;
    resolution: string;
    evidence: Array<{ rationale: string }>;
    ambiguity?: { candidates: string[]; reason: string };
  }>;
  evidence?: Array<{ rationale: string }>;
  warnings?: string[];
  error?: { code: string; message: string };
}

const dotnetAvailable = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!dotnetAvailable) {
  console.error("[roslyn-worker-limits] dotnet SDK not found: worker limit tests were not run (reported as not executed)");
}

function analyzeRaw(id: string, files: ReadonlyArray<{ path: string; content: string }>): string {
  const run = spawnSync("dotnet", ["exec", WORKER_DLL], {
    input: `${JSON.stringify({ id, type: "analyze", protocolVersion: "1", files })}\n`,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    shell: false,
  });
  if (run.status !== 0) {
    throw new Error(`worker exited with ${String(run.status)}: ${String(run.stderr).slice(-400)}`);
  }
  const line = String(run.stdout).split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) throw new Error("worker wrote no response line");
  return line;
}

function analyze(id: string, files: ReadonlyArray<{ path: string; content: string }>): WorkerResponse {
  return JSON.parse(analyzeRaw(id, files)) as WorkerResponse;
}

function allEmittedNames(response: WorkerResponse): string[] {
  return [
    ...(response.nodes ?? []).map((node) => node.qualifiedName),
    ...(response.edges ?? []).flatMap((edge) => [edge.from.qualifiedName, edge.to.qualifiedName]),
  ];
}

function longest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

/** `count` dotted segments of `segmentLength` characters: no identifier exceeds the C# 512-character limit. */
function longNamespace(count: number, segmentLength: number): string {
  return Array.from({ length: count }, (_, index) => `S${String(index)}${"x".repeat(segmentLength - 1 - String(index).length)}`).join(".");
}

describe.skipIf(!dotnetAvailable)("roslyn-worker emitted text bounds (F9 / F29)", () => {
  beforeAll(() => {
    const build = buildRoslynWorkerBinary();
    if (build.status !== 0 || !existsSync(WORKER_DLL)) {
      throw new Error(`worker build failed (exit=${String(build.status)}): ${build.stdout.slice(-400)}`);
    }
  }, 300_000);

  it("F29: declarations nested deeper than the traversal limit are skipped with one diagnostic per file", () => {
    const depth = 1100;
    const content = `${"namespace a { ".repeat(depth)}class Deep { void M() { } }${" }".repeat(depth)}\n`;
    const response = analyze("nesting-depth", [{ path: "Deep/Nested.cs", content }]);
    expect(response.status).toBe("partial");
    const depthDiagnostics = (response.diagnostics ?? []).filter((diag) =>
      diag.message.includes("declaration nesting depth exceeded the 1000 limit"),
    );
    expect(depthDiagnostics).toHaveLength(1);
    expect(depthDiagnostics[0]?.relativePath).toBe("Deep/Nested.cs");
    expect(depthDiagnostics[0]?.code).toBe("ADAPTER_INTERNAL");
    expect((response.nodes ?? []).some((node) => node.qualifiedName.endsWith("Deep"))).toBe(false);
    expect(longest(allEmittedNames(response))).toBeLessThanOrEqual(MAX_NAME);
  }, 120_000);

  it("F29: a long namespace prefix is shared by nested declarations as one bounded, distinct name each", () => {
    const content = [
      `namespace ${"N".repeat(100_000)} {`,
      `${"namespace a { ".repeat(300)}class Inner { void M() { } }${" }".repeat(300)}`,
      "class Outer { void M() { } }",
      "}",
      "",
    ].join("\n");
    const raw = analyzeRaw("long-prefix", [{ path: "Long/Prefix.cs", content }]);
    expect(analyzeRaw("long-prefix", [{ path: "Long/Prefix.cs", content }])).toBe(raw);
    const response = JSON.parse(raw) as WorkerResponse;
    const classes = (response.nodes ?? []).filter((node) => node.kind === "Class");
    const methods = (response.nodes ?? []).filter((node) => node.kind === "Method");
    expect(classes).toHaveLength(2);
    expect(methods).toHaveLength(2);
    for (const node of [...classes, ...methods]) {
      expect(node.qualifiedName.length).toBeLessThanOrEqual(MAX_NAME);
      expect(node.qualifiedName).toMatch(CAPPED);
      expect(node.qualifiedName.startsWith("NNNN")).toBe(true);
    }
    expect(new Set(classes.map((node) => node.qualifiedName)).size).toBe(2);
    expect(new Set(methods.map((node) => node.qualifiedName)).size).toBe(2);
    expect(longest(allEmittedNames(response))).toBeLessThanOrEqual(MAX_NAME);
    expect(longest((response.evidence ?? []).map((e) => e.rationale))).toBeLessThanOrEqual(3 * MAX_NAME);
  }, 120_000);

  it("F9: members of a type inside a long namespace get bounded names and rationales", () => {
    const ns = longNamespace(40, 400);
    const content = [
      `namespace ${ns};`,
      "public class Holder",
      "{",
      "    public Holder() { }",
      "    public int Value { get; set; }",
      "    public void First() { }",
      "    public void Second() { }",
      `    public void ${"L".repeat(3000)}() { }`,
      "}",
      "",
    ].join("\n");
    const response = analyze("long-members", [{ path: "Long/Members.cs", content }]);
    const members = (response.nodes ?? []).filter((node) => node.kind === "Method");
    expect(members).toHaveLength(5);
    expect(new Set(members.map((node) => node.qualifiedName)).size).toBe(5);
    for (const node of members) {
      expect(node.qualifiedName.length).toBe(MAX_NAME);
      expect(node.qualifiedName).toMatch(CAPPED);
    }
    const contains = (response.edges ?? []).filter((edge) => edge.kind === "CONTAINS" && edge.to.kind === "Method");
    expect(contains).toHaveLength(5);
    for (const edge of response.edges ?? []) {
      for (const evidence of edge.evidence) expect(evidence.rationale.length).toBeLessThanOrEqual(3 * MAX_NAME);
    }
    expect(longest(allEmittedNames(response))).toBeLessThanOrEqual(MAX_NAME);
  }, 120_000);

  it("F9: names at the cap are emitted unchanged; one character more is capped", () => {
    const atCap = `${"a".repeat(MAX_NAME - "N.".length)}`;
    const content = [`namespace N { class ${atCap} { } }`, `namespace N { class ${atCap}b { } }`, ""].join("\n");
    const response = analyze("cap-boundary", [{ path: "Cap/Boundary.cs", content }]);
    const names = (response.nodes ?? []).filter((node) => node.kind === "Class").map((node) => node.qualifiedName).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(`N.${atCap}`);
    const capped = names.find((name) => name !== `N.${atCap}`) ?? "";
    expect(capped.length).toBe(MAX_NAME);
    expect(capped).toMatch(CAPPED);
    expect(capped.startsWith(`N.${atCap.slice(0, MAX_NAME - 2 - 17)}`)).toBe(true);
  }, 120_000);

  it("F9: unresolved fluent call chains emit bounded call texts, rationales and warnings", () => {
    const chain = `missing${".Next(arg)".repeat(400)}`;
    const content = ["class Chains", "{", "    void Run(int arg)", "    {", `        ${chain};`, "    }", "}", ""].join("\n");
    const response = analyze("call-chain", [{ path: "Chains/Chain.cs", content }]);
    const externals = (response.nodes ?? []).filter((node) => node.kind === "UnknownExternal");
    expect(externals.length).toBeGreaterThan(100);
    expect(longest(externals.map((node) => node.qualifiedName))).toBeLessThanOrEqual(MAX_NAME);
    expect(externals.some((node) => CAPPED.test(node.qualifiedName))).toBe(true);
    expect(longest(allEmittedNames(response))).toBeLessThanOrEqual(MAX_NAME);
    expect(longest((response.evidence ?? []).map((e) => e.rationale))).toBeLessThanOrEqual(3 * MAX_NAME);
    expect(longest(response.warnings ?? [])).toBeLessThanOrEqual(MAX_NAME + 256);
  }, 120_000);

  it("F9: an ambiguous call lists a bounded number of bounded candidates and says how many were left out", () => {
    const count = 100;
    const ns = longNamespace(4, 400);
    const content = [
      `namespace ${ns};`,
      ...Array.from({ length: count }, (_, index) => `class A${String(index)} { }`),
      "class Host",
      "{",
      ...Array.from({ length: count }, (_, index) => `    static void M(A${String(index)} a) { }`),
      "    void Run() { M(null); }",
      "}",
      "",
    ].join("\n");
    const response = analyze("ambiguity", [{ path: "Amb/Amb.cs", content }]);
    const ambiguous = (response.edges ?? []).find((edge) => edge.kind === "CALLS" && edge.ambiguity !== undefined);
    expect(ambiguous?.resolution).toBe("unresolved");
    expect(ambiguous?.ambiguity?.candidates).toHaveLength(64);
    expect(longest(ambiguous?.ambiguity?.candidates ?? [])).toBeLessThanOrEqual(MAX_NAME);
    expect(ambiguous?.ambiguity?.reason).toContain("first 64 of 100 candidates");
  }, 120_000);

  it("F9: the response size budget truncates explicitly instead of growing with the input", () => {
    const methods = Array.from({ length: 20_000 }, (_, index) => `    public void m${String(index).padStart(5, "0")}() { }`);
    const content = [`namespace ${longNamespace(2, 500)};`, "public class Wide", "{", ...methods, "}", ""].join("\n");
    const raw = analyzeRaw("text-budget", [{ path: "Wide/Wide.cs", content }]);
    expect(raw.length).toBeLessThan(ADAPTER_RESPONSE_MAX_CHARS);
    const response = JSON.parse(raw) as WorkerResponse;
    expect(response.status).toBe("partial");
    const truncated = (response.diagnostics ?? []).find((diag) => diag.code === "RESPONSE_TRUNCATED");
    expect(truncated?.message).toContain("response size budget");
    const nodes = response.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(1000);
    expect(nodes.length).toBeLessThan(20_000);
    expectNoDanglingEdges(response);
  }, 300_000);

  // Round 2: the budget is the SERIALIZED response size (field names, kinds, spans,
  // source hashes and escaping included), so a truncated response stays below the
  // adapter's 64M-character line cap for short and medium names as well.
  it.each([
    ["short names", "Short", 45_000],
    ["medium (~100-character) names", longNamespace(2, 45), 30_000],
  ])("F9: with %s a truncated response still fits the adapter's response cap", (_label, ns, count) => {
    const methods = Array.from({ length: count }, (_, index) => {
      const name = `m${String(index).padStart(5, "0")}`;
      const next = `m${String(index + 1).padStart(5, "0")}`;
      return index + 1 < count ? `    public void ${name}() { ${next}(); }` : `    public void ${name}() { }`;
    });
    const content = [`namespace ${ns};`, "public class Chain", "{", ...methods, "}", ""].join("\n");
    const raw = analyzeRaw(`size-budget-${String(count)}`, [{ path: "Chain/Chain.cs", content }]);
    expect(raw.length).toBeLessThan(ADAPTER_RESPONSE_MAX_CHARS);
    const response = JSON.parse(raw) as WorkerResponse;
    expect(response.status).toBe("partial");
    expect((response.diagnostics ?? []).some((diag) => diag.code === "RESPONSE_TRUNCATED")).toBe(true);
    expect((response.nodes ?? []).length).toBeGreaterThan(1000);
    expectNoDanglingEdges(response);
  }, 600_000);

  it("F9: compiler diagnostics and unresolved-call warnings are part of the response size budget", () => {
    const calls = Array.from({ length: 60_000 }, (_, index) => `        u${String(index).padStart(5, "0")}();`);
    const content = ["class Unresolved", "{", "    void Run()", "    {", ...calls, "    }", "}", ""].join("\n");
    const raw = analyzeRaw("size-budget-unresolved", [{ path: "Bad/Unresolved.cs", content }]);
    expect(raw.length).toBeLessThan(ADAPTER_RESPONSE_MAX_CHARS);
    const response = JSON.parse(raw) as WorkerResponse;
    expect(response.status).toBe("partial");
    expect((response.diagnostics ?? []).some((diag) => diag.code === "RESPONSE_TRUNCATED")).toBe(true);
    expect((response.diagnostics ?? []).some((diag) => diag.code === "CS0103")).toBe(true);
    expectNoDanglingEdges(response);
  }, 600_000);
});

function expectNoDanglingEdges(response: WorkerResponse): void {
  const key = (node: NodeRef): string => `${node.kind}\u001f${node.qualifiedName}\u001f${node.relativePath ?? ""}`;
  const emitted = new Set((response.nodes ?? []).map(key));
  for (const edge of response.edges ?? []) {
    expect(emitted.has(key(edge.from))).toBe(true);
    expect(emitted.has(key(edge.to))).toBe(true);
  }
}
