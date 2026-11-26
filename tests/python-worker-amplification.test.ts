/**
 * Python worker output-amplification and serialization limits:
 * - declared qualified names and import-derived names are bounded wherever they
 *   are copied (node names, edge endpoints, evidence rationales, ambiguity),
 * - a Flask-style route decorator dedupes and caps its methods list and bounds
 *   its literal path,
 * - lone surrogates (in route literals or in request fields) never crash the
 *   worker: route literals get a deterministic escape, and the loop keeps running.
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

interface NodeRefOut {
  kind: string;
  qualifiedName: string;
  relativePath?: string;
}

interface WorkerResponse {
  id: unknown;
  status: string;
  warnings?: string[];
  diagnostics?: Array<{ relativePath: string; code: string; message: string; line: number }>;
  nodes?: Array<NodeRefOut & { attributes?: Record<string, unknown> }>;
  edges?: Array<{
    kind: string;
    from: NodeRefOut;
    to: NodeRefOut;
    resolution: string;
    evidence: Array<{ rationale: string; span?: { startLine: number } }>;
    ambiguity?: { candidates: string[]; reason: string };
  }>;
  evidence?: Array<{ rationale: string }>;
  error?: { code: string; message: string };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const pythonAvailable = spawnSync("python", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!pythonAvailable) {
  console.error("[python-worker-amplification] python not found: tests were not run (reported as not executed)");
}

function runWorker(input: string, timeoutMs = 120_000): RunResult {
  const result = spawnSync("python", ["-B", WORKER_SCRIPT], {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function request(id: string, files: Array<{ path: string; content: string }>): string {
  return `${JSON.stringify({ id, type: "analyze", protocolVersion: "1", files })}\n`;
}

function responseLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trim().length > 0);
}

function analyze(files: Array<{ path: string; content: string }>): { response: WorkerResponse; raw: string } {
  const run = runWorker(request("amplification", files));
  expect(run.status).toBe(0);
  const raw = responseLines(run.stdout)[0] ?? "";
  return { response: JSON.parse(raw) as WorkerResponse, raw };
}

function responseTexts(response: WorkerResponse): string[] {
  return [
    ...(response.nodes ?? []).flatMap((node) => [
      node.qualifiedName,
      ...Object.values(node.attributes ?? {}).filter((value): value is string => typeof value === "string"),
    ]),
    ...(response.edges ?? []).flatMap((edge) => [
      edge.from.qualifiedName,
      edge.to.qualifiedName,
      ...edge.evidence.map((item) => item.rationale),
      ...(edge.ambiguity ? [edge.ambiguity.reason, ...edge.ambiguity.candidates] : []),
    ]),
    ...(response.evidence ?? []).map((item) => item.rationale),
    ...(response.warnings ?? []),
  ];
}

function longest(texts: readonly string[]): number {
  return texts.reduce((max, text) => (text.length > max ? text.length : max), 0);
}

/** A bounded text: a prefix, "...#" and 12 hex digits of the SHA-256 of the full text. */
const TRUNCATED = /\.\.\.#[0-9a-f]{12}$/;

/** True when `text` holds no lone UTF-16 surrogate (String.prototype.isWellFormed is ES2024). */
function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe.skipIf(!pythonAvailable)("python worker output amplification", () => {
  it("bounds long declared names and import-derived names in every copy", () => {
    const longName = `A${"a".repeat(20_000)}`;
    const longModule = `m${"m".repeat(20_000)}`;
    const content = [
      `import ${longModule}.sub as mm`,
      `from ${longModule} import sym`,
      "",
      `def ${longName}():`,
      ...Array.from({ length: 300 }, (_, i) => `    a${String(i)}()`),
      "",
      "def short_caller():",
      ...Array.from({ length: 100 }, (_, i) => `    mm.f${String(i)}()`),
      ...Array.from({ length: 100 }, (_, i) => `    sym.k${String(i)}()`),
      "",
    ].join("\n");
    const files = [{ path: "big.py", content }];

    const { response, raw } = analyze(files);

    expect(response.error).toBeUndefined();
    // Every copied text is bounded: a qualified name is at most 512 + 16 chars,
    // a rationale embeds at most two of them.
    expect(longest(responseTexts(response))).toBeLessThan(1_500);
    // Unbounded, this request produced tens of MB (300 calls x 3 copies of a 20k name).
    expect(raw.length).toBeLessThan(2_000_000);

    const longNode = (response.nodes ?? []).find((node) => node.kind === "Function" && node.qualifiedName.startsWith("big.Aa"));
    expect(longNode?.qualifiedName).toMatch(TRUNCATED);
    expect(longNode?.qualifiedName.length).toBeLessThanOrEqual(528);
    // Every edge of the long function refers to the node's bounded name.
    const fromLong = (response.edges ?? []).filter((edge) => edge.kind === "CALLS" && edge.from.qualifiedName.startsWith("big.Aa"));
    expect(fromLong).toHaveLength(300);
    expect(fromLong.every((edge) => edge.from.qualifiedName === longNode?.qualifiedName)).toBe(true);

    // Import-derived targets: the candidate equals the UnknownExternal node name.
    const imported = (response.edges ?? []).filter((edge) => edge.kind === "CALLS" && edge.from.qualifiedName === "big.short_caller");
    expect(imported).toHaveLength(200);
    for (const edge of imported) {
      expect(edge.resolution).toBe("heuristic");
      expect(edge.to.qualifiedName).toMatch(TRUNCATED);
      expect(edge.ambiguity?.candidates).toEqual([edge.to.qualifiedName]);
    }

    // Deterministic: the same request gives a byte-identical response line.
    expect(analyze(files).raw).toBe(raw);
  });

  it("merging the evidence of one edge is linear and keeps first-seen order and de-duplication", () => {
    const calls = 30_000;
    const content = [
      "def a():",
      "    return 1",
      "",
      "def f():", // line 4; the calls start on line 5
      ...Array.from({ length: calls }, () => "    a()"),
      "    a(); a()", // two calls on one line → one evidence record
      "",
    ].join("\n");

    // Quadratic merging (re-serializing the edge's whole list per call) needs minutes here.
    const run = runWorker(request("merge", [{ path: "merge.py", content }]), 60_000);

    expect(run.status).toBe(0);
    const response = JSON.parse(responseLines(run.stdout)[0] ?? "{}") as WorkerResponse;
    const edge = (response.edges ?? []).find(
      (item) => item.kind === "CALLS" && item.from.qualifiedName === "merge.f" && item.to.qualifiedName === "merge.a",
    );
    expect(edge?.resolution).toBe("verified");
    const lines = (edge?.evidence ?? []).map((item) => item.span?.startLine);
    expect(lines).toHaveLength(calls + 1);
    expect(lines.every((line, index) => line === 5 + index)).toBe(true);
  }, 90_000);

  it("dedupes and caps a route decorator's methods list and bounds its path", () => {
    const longPath = `/${"p".repeat(20_000)}`;
    const verbs = [...Array.from({ length: 600 }, (_, i) => `"V${String(i)}"`), '"get"', '"GET"', '" post "'];
    const content = [
      `@app.route("${longPath}", methods=[${verbs.join(", ")}])`,
      "def flood():",
      "    pass",
      "",
      '@app.route("/items", methods=["get", "POST", "GET"])',
      "def items():",
      "    pass",
      "",
    ].join("\n");

    const { response, raw } = analyze([{ path: "routes.py", content }]);

    expect(response.error).toBeUndefined();
    const endpoints = (response.nodes ?? []).filter((node) => node.kind === "Endpoint");
    const flood = endpoints.filter((node) => !node.qualifiedName.endsWith(" /items"));
    expect(flood).toHaveLength(16);
    for (const node of flood) {
      expect(node.qualifiedName.length).toBeLessThan(800);
      expect(String(node.attributes?.["path"])).toMatch(TRUNCATED);
    }
    expect(raw.length).toBeLessThan(1_000_000);
    expect(
      (response.warnings ?? []).some((warning) => warning.includes("routes.flood") && warning.includes("methods list")),
    ).toBe(true);

    // A normal methods list is unchanged: upper-cased and de-duplicated.
    expect(endpoints.filter((node) => node.qualifiedName.endsWith(" /items")).map((node) => node.qualifiedName).sort()).toEqual([
      "GET /items",
      "POST /items",
    ]);
    const routes = (response.edges ?? []).filter((edge) => edge.kind === "ROUTES_TO" && edge.to.qualifiedName === "routes.items");
    expect(routes.map((edge) => edge.from.qualifiedName).sort()).toEqual(["GET /items", "POST /items"]);
  });

  it("a lone-surrogate route literal gets a deterministic escape and the batch is still analyzed", () => {
    const files = [
      {
        path: "surrogate.py",
        content: [
          '@app.get("\\ud800")',
          "def lone():",
          "    pass",
          "",
          '@app.route("/r", methods=["\\udfff"])',
          "def verb():",
          "    pass",
          "",
        ].join("\n"),
      },
      { path: "healthy.py", content: "def helper():\n    return 1\n\ndef run():\n    return helper()\n" },
    ];

    const run = runWorker(request("surrogate", files));

    expect(run.status).toBe(0);
    const lines = responseLines(run.stdout);
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0] ?? "{}") as WorkerResponse;
    expect(response.error).toBeUndefined();
    const endpoints = (response.nodes ?? []).filter((node) => node.kind === "Endpoint").map((node) => node.qualifiedName).sort();
    expect(endpoints).toEqual(["GET \\ud800", "\\udfff /r"]);
    expect((response.nodes ?? []).find((node) => node.qualifiedName === "GET \\ud800")?.attributes?.["path"]).toBe("\\ud800");
    const lone = (response.edges ?? []).find((edge) => edge.kind === "ROUTES_TO" && edge.from.qualifiedName === "GET \\ud800");
    expect(lone?.to.qualifiedName).toBe("surrogate.lone");
    expect(
      (response.edges ?? []).some((edge) => edge.from.qualifiedName === "healthy.run" && edge.to.qualifiedName === "healthy.helper"),
    ).toBe(true);
    // Every string of the response is well-formed UTF-16 (no lone surrogate reached the output).
    expect(responseTexts(response).every((text) => isWellFormed(text))).toBe(true);
    // Deterministic.
    expect(responseLines(runWorker(request("surrogate", files)).stdout)[0]).toBe(lines[0]);
  });

  it("the response stays under a size budget and says so (RESPONSE_TRUNCATED, partial, deterministic)", () => {
    // Every call quotes the bounded 512+16-character caller name twice
    // (edge evidence + top-level evidence), so one 5-byte line yields ~1.5 KB.
    const content = [`def ${"A".repeat(600)}():`, ...Array.from({ length: 40_000 }, () => " a()"), ""].join("\n");
    const files = [{ path: "big.py", content }];

    const { response, raw } = analyze(files);

    expect(raw.length).toBeLessThan(41_000_000);
    expect(response.status).toBe("partial");
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({ relativePath: "", code: "RESPONSE_TRUNCATED", line: 0 }),
    );
    const nodeKeys = new Set((response.nodes ?? []).map((node) => `${node.kind}\u0000${node.qualifiedName}\u0000${node.relativePath ?? ""}`));
    for (const edge of response.edges ?? []) {
      expect(nodeKeys.has(`${edge.from.kind}\u0000${edge.from.qualifiedName}\u0000${edge.from.relativePath ?? ""}`)).toBe(true);
      expect(nodeKeys.has(`${edge.to.kind}\u0000${edge.to.qualifiedName}\u0000${edge.to.relativePath ?? ""}`)).toBe(true);
    }
    const call = (response.edges ?? []).find((edge) => edge.kind === "CALLS" && edge.to.qualifiedName === "a");
    expect(call?.evidence[0]?.span?.startLine).toBe(2);
    expect(analyze(files).raw).toBe(raw);
  }, 120_000);

  it("a serialization failure is answered with a fixed INTERNAL_ERROR line, no traceback, and the loop continues", () => {
    // Fault injection: the response of an analysis cannot be serialized (MemoryError).
    const harness = [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('causoryn_python_worker', sys.argv[1])",
      "worker = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "real_dumps = json.dumps",
      "def failing_dumps(value, *args, **kwargs):",
      "    if isinstance(value, dict) and value.get('status') in ('ready', 'partial'):",
      "        raise MemoryError()",
      "    return real_dumps(value, *args, **kwargs)",
      "json.dumps = failing_dumps",
      "sys.exit(worker.main())",
    ].join("\n");
    const input = `${request("first", [{ path: "ok.py", content: "def a():\n    return 1\n" }])}not json\n`;

    const result = spawnSync("python", ["-I", "-B", "-c", harness, WORKER_SCRIPT], { input, encoding: "utf8", shell: false, timeout: 60_000 });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Traceback");
    expect(result.stderr).not.toContain("worker.py");
    const responses = responseLines(result.stdout).map((line) => JSON.parse(line) as WorkerResponse);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      id: "first",
      protocolVersion: "1",
      status: "error",
      error: { code: "INTERNAL_ERROR", message: "the response could not be serialized" },
    });
    expect(responses[1]).toMatchObject({ id: null, status: "error", error: { code: "INVALID_ARGUMENT" } });
  });

  it("an error outside request handling ends the worker without a traceback", () => {
    const harness = [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('causoryn_python_worker', sys.argv[1])",
      "worker = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "def broken_read_line(stream):",
      "    raise RuntimeError('read failed at /opt/private-install-marker/worker')",
      "worker.read_line = broken_read_line",
      "sys.exit(worker.main())",
    ].join("\n");

    const result = spawnSync("python", ["-I", "-B", "-c", harness, WORKER_SCRIPT], { input: "", encoding: "utf8", shell: false, timeout: 60_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Traceback");
    expect(result.stderr).not.toContain("private-install-marker");
    expect(result.stderr).toContain("RuntimeError");
  });

  it("an oversized response line is replaced by a LIMIT_EXCEEDED error line", () => {
    const harness = [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('causoryn_python_worker', sys.argv[1])",
      "worker = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(worker)",
      "line = worker.encode_response({'id': 'big', 'protocolVersion': '1', 'status': 'partial', 'warnings': ['w' * 61_000_000]})",
      "sys.stdout.write(str(len(line)) + '\\n' + line.decode('utf-8'))",
    ].join("\n");

    const result = spawnSync("python", ["-I", "-B", "-c", harness, WORKER_SCRIPT], { encoding: "utf8", shell: false, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });

    expect(result.status).toBe(0);
    const [length, line] = result.stdout.split("\n");
    expect(Number(length)).toBeLessThan(1_000);
    expect(JSON.parse(line ?? "{}")).toMatchObject({ id: "big", status: "error", error: { code: "LIMIT_EXCEEDED" } });
  });

  it("lone surrogates in request fields are answered with an error line and the loop keeps running", () => {
    const healthy = { path: "ok.py", content: "def a():\n    return 1\n" };
    // JSON escapes keep the request lines valid UTF-8; json.loads turns them into lone surrogates.
    const input = [
      `{"id":"content","type":"analyze","files":[{"path":"ok.py","content":"x = 1  # \\ud800"}]}`,
      `{"id":"\\ud800","type":"analyze","files":[{"path":"ok.py","content":"x = 1\\n"}]}`,
      `{"id":"unknown-key","type":"analyze","files":[{"path":"ok.py","content":"x = 1\\n"}],"\\udfff":1}`,
      `{"id":"path","type":"analyze","files":[{"path":"a\\ud800.py","content":"x = 1\\n"}]}`,
      request("after", [healthy]).trim(),
      "",
    ].join("\n");

    const run = runWorker(input);

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("Traceback");
    const responses = responseLines(run.stdout).map((line) => JSON.parse(line) as WorkerResponse);
    expect(responses).toHaveLength(5);
    expect(responses[0]).toMatchObject({ id: "content", status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(responses[1]).toMatchObject({ id: null, status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(responses[2]).toMatchObject({ id: "unknown-key", status: "error", error: { code: "INTERNAL_ERROR" } });
    expect(responses[3]).toMatchObject({ id: "path", status: "error", error: { code: "INVALID_ARGUMENT" } });
    expect(responses[4]).toMatchObject({ id: "after", status: "ready" });
    for (const response of responses) {
      expect(isWellFormed(JSON.stringify(response))).toBe(true);
    }
  });
});
