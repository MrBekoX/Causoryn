/**
 * Python worker resource limits: deep expressions are isolated per file
 * (a RecursionError never fails the whole batch) and rendered expression
 * text (`ast.unparse`) is bounded in names, rationales and warnings.
 *
 * Processes run via spawnSync with a literal "python" executable, an argument
 * array and shell: false; request content travels on stdin only.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SCRIPT = join(REPO_ROOT, "native", "python-worker", "worker.py");

interface WorkerResponse {
  status: string;
  warnings?: string[];
  diagnostics?: Array<{ relativePath: string; code: string; message: string; line: number }>;
  nodes?: Array<{ kind: string; qualifiedName: string }>;
  edges?: Array<{
    kind: string;
    from: { qualifiedName: string };
    to: { qualifiedName: string };
    resolution: string;
    evidence: Array<{ rationale: string }>;
  }>;
  error?: { code: string; message: string };
}

const pythonAvailable = spawnSync("python", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!pythonAvailable) {
  console.error("[python-worker-limits] python not found: limit tests were not run (reported as not executed)");
}

function analyze(files: Array<{ path: string; content: string }>): WorkerResponse {
  const result = spawnSync("python", [WORKER_SCRIPT], {
    input: `${JSON.stringify({ id: "limits", type: "analyze", protocolVersion: "1", files })}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  expect(result.status).toBe(0);
  const line = (typeof result.stdout === "string" ? result.stdout : "").split("\n").find((l) => l.trim().length > 0);
  return JSON.parse(line ?? "{}") as WorkerResponse;
}

/** `g() + g() + ...` with `terms` operands: a left-nested BinOp chain `terms` levels deep. */
function deepSum(terms: number): string {
  return Array.from({ length: terms }, () => "g()").join(" + ");
}

const HEALTHY = { path: "healthy.py", content: "def helper():\n    return 1\n\ndef run():\n    return helper()\n" };

describe.skipIf(!pythonAvailable)("python worker limits", () => {
  it("a file whose call walk exceeds the recursion budget is partial; the rest of the batch is analyzed", () => {
    const response = analyze([
      { path: "deep.py", content: `def deep():\n    return ${deepSum(1500)}\n` },
      HEALTHY,
    ]);
    expect(response.error).toBeUndefined();
    expect(response.status).toBe("partial");
    const deepDiagnostics = (response.diagnostics ?? []).filter((d) => d.relativePath === "deep.py");
    expect(deepDiagnostics.length).toBeGreaterThan(0);
    expect(deepDiagnostics.every((d) => d.code === "ADAPTER_INTERNAL")).toBe(true);
    const healthyCall = (response.edges ?? []).find(
      (edge) => edge.kind === "CALLS" && edge.from.qualifiedName === "healthy.run" && edge.to.qualifiedName === "healthy.helper",
    );
    expect(healthyCall?.resolution).toBe("verified");
  });

  it("a call target too deep to render does not fail the batch", () => {
    const response = analyze([
      { path: "target.py", content: `def caller():\n    (${deepSum(1200)})()\n` },
      HEALTHY,
    ]);
    expect(response.error).toBeUndefined();
    expect(["ready", "partial"]).toContain(response.status);
    expect(
      (response.edges ?? []).some((edge) => edge.from.qualifiedName === "healthy.run" && edge.to.qualifiedName === "healthy.helper"),
    ).toBe(true);
  });

  it("bounds rendered expression text in names, rationales and warnings", () => {
    const longText = "x".repeat(20_000);
    const response = analyze([
      {
        path: "long.py",
        content: [
          "def caller():",
          `    (lambda: "${longText}")()`,
          "",
          `@routers["${longText}"].get("/x")`,
          "def handler():",
          "    return 1",
          "",
        ].join("\n"),
      },
    ]);
    expect(response.error).toBeUndefined();
    const texts = [
      ...(response.nodes ?? []).map((node) => node.qualifiedName),
      ...(response.edges ?? []).flatMap((edge) => [edge.to.qualifiedName, ...edge.evidence.map((e) => e.rationale)]),
      ...(response.warnings ?? []),
    ];
    expect(texts.length).toBeGreaterThan(0);
    const longest = Math.max(...texts.map((text) => text.length));
    expect(longest).toBeLessThan(1_000);
    // Truncated renderings stay distinguishable (content digest suffix).
    expect(texts.some((text) => /\.\.\.#[0-9a-f]{12}/.test(text))).toBe(true);
  });
});
