import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramIncremental,
  analyzeTypeScriptProgramWithFrameworks,
  type TsAdapterSourceFile,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import {
  createTypeCheckerWithinBoundary,
  MAX_QUALIFIED_NAME_CHARS,
  MAX_SYNTAX_NESTING_DEPTH,
} from "../src/analyzer.js";
import type ts from "typescript";

/**
 * Input-size bounds of the TypeScript adapter.
 *
 * - Syntax nesting: a file nested deeper than MAX_SYNTAX_NESTING_DEPTH is
 *   indexed at file level only (File node + ADAPTER_LIMIT diagnostic), so the
 *   recursive TypeScript parser/binder never sees it and the rest of the
 *   workspace is analyzed normally.
 * - Framework detection walks every file iteratively and inside a per-file
 *   error boundary.
 * - Names copied into node identities and evidence rationales are bounded, so
 *   one long identifier or test title cannot be duplicated per call site.
 *
 * Fixtures are generated in memory; nothing is written to disk.
 */

const ROOT = path.resolve(tmpdir(), "causoryn-input-bounds-virtual-root");
const WORKSPACE_ID = "ws_input_bounds";

const HEALTHY_TS = [
  "export function leaf(): number {",
  "  return 1;",
  "}",
  "",
  "export function caller(): number {",
  "  return leaf();",
  "}",
  "",
].join("\n");

function analyze(sources: readonly TsAdapterSourceFile[]): TypeScriptAdapterResult {
  return analyzeTypeScriptProgram({
    workspaceId: WORKSPACE_ID,
    rootDir: ROOT,
    sources,
    configFiles: [],
  });
}

function expectHealthyFileAnalyzed(result: TypeScriptAdapterResult): void {
  const calls = result.edges.find(
    (edge) =>
      edge.kind === "CALLS" &&
      edge.from.qualifiedName === "caller" &&
      edge.to.qualifiedName === "leaf",
  );
  expect(calls?.resolution).toBe("verified");
  expect(result.diagnostics.filter((d) => d.relativePath === "src/healthy.ts")).toEqual([]);
}

function limitDiagnostics(result: TypeScriptAdapterResult, relativePath: string) {
  return result.diagnostics.filter(
    (d) => d.relativePath === relativePath && d.code === "ADAPTER_LIMIT",
  );
}

function memberChain(links: number): string {
  return `declare const a: any;\nexport const v = a${".b".repeat(links)};\n`;
}

describe("syntax nesting limit (TypeScript parser/binder recursion)", { timeout: 120_000 }, () => {
  it("indexes a file whose member-access chain overflows the binder at file level instead of aborting", () => {
    const result = analyze([
      { relativePath: "src/deep.ts", content: memberChain(20_000) },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);

    expect(result.state).toBe("partial");
    expect(limitDiagnostics(result, "src/deep.ts")).toHaveLength(1);
    expect(
      result.nodes.some((node) => node.kind === "File" && node.qualifiedName === "src/deep.ts"),
    ).toBe(true);
    expectHealthyFileAnalyzed(result);
  });

  it("indexes a file whose nesting overflows the TypeScript parser at file level instead of aborting", () => {
    const depth = 5_000;
    const result = analyze([
      { relativePath: "src/nested.ts", content: `export const q = ${"[".repeat(depth)}1${"]".repeat(depth)};\n` },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);

    expect(limitDiagnostics(result, "src/nested.ts")).toHaveLength(1);
    expectHealthyFileAnalyzed(result);
  });

  it("applies the nesting limit as a fixed bound, not as a stack-size accident", () => {
    const over = analyze([
      { relativePath: "src/over.ts", content: memberChain(MAX_SYNTAX_NESTING_DEPTH + 10) },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);
    expect(limitDiagnostics(over, "src/over.ts")).toHaveLength(1);
    expect(over.nodes.filter((node) => node.relativePath === "src/over.ts").map((n) => n.kind)).toEqual([
      "File",
    ]);

    const under = analyze([
      { relativePath: "src/under.ts", content: memberChain(MAX_SYNTAX_NESTING_DEPTH - 100) },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);
    expect(limitDiagnostics(under, "src/under.ts")).toEqual([]);
  });

  it("reports the same file-level degradation on an incremental run that reuses the program", () => {
    const input = {
      workspaceId: WORKSPACE_ID,
      rootDir: ROOT,
      configFiles: [],
      sources: [
        { relativePath: "src/deep.ts", content: memberChain(20_000) },
        { relativePath: "src/healthy.ts", content: HEALTHY_TS },
      ],
    };
    const first = analyzeTypeScriptProgramIncremental(input);
    const second = analyzeTypeScriptProgramIncremental({
      ...input,
      incrementalState: first.nextIncrementalState,
    });

    expect(limitDiagnostics(second.result, "src/deep.ts")).toHaveLength(1);
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
  });

  it("turns a type checker that cannot be created into a controlled outcome", () => {
    const failingProgram = {
      getTypeChecker: (): ts.TypeChecker => {
        throw new RangeError("Maximum call stack size exceeded");
      },
    } as unknown as ts.Program;

    const outcome = createTypeCheckerWithinBoundary(failingProgram);

    expect(outcome.checker).toBeUndefined();
    expect(outcome.failure).toContain("Maximum call stack size exceeded");
  });
});

/**
 * TypeScript (5.9.3) parses `,` and the other left-associative operators in a
 * loop, parses `=`/`**` chains with one cheap self-call per link, and binds and
 * checks every binary operator on a trampoline — except `&&`, `||`, `??` (and
 * their assignment forms), which the binder handles recursively. Generated code
 * with long comma or assignment chains must therefore stay fully analysed.
 */
describe("binary operator chains the TypeScript binder walks iteratively", { timeout: 120_000 }, () => {
  const CHAIN = 5_000;

  function fileDiagnostics(result: TypeScriptAdapterResult, relativePath: string) {
    return result.diagnostics.filter((d) => d.relativePath === relativePath);
  }

  it("keeps a 5000-term comma chain (minified/generated JavaScript) fully analysed", () => {
    const result = analyze([
      {
        relativePath: "src/bundle.js",
        content: [
          "function f() { return 1; }",
          "export function run() {",
          `  ${Array.from({ length: CHAIN }, () => "f()").join(",\n  ")};`,
          "}",
          "",
        ].join("\n"),
      },
    ]);

    expect(fileDiagnostics(result, "src/bundle.js")).toEqual([]);
    const calls = result.edges.find(
      (edge) => edge.kind === "CALLS" && edge.from.qualifiedName === "run" && edge.to.qualifiedName === "f",
    );
    expect(calls?.resolution).toBe("verified");
    expect(calls?.evidence).toHaveLength(CHAIN);
  });

  it("keeps a 5000-link CommonJS export assignment chain (tsc/Babel output) fully analysed", () => {
    const result = analyze([
      {
        relativePath: "src/exports.js",
        content: [
          '"use strict";',
          'Object.defineProperty(exports, "__esModule", { value: true });',
          `${Array.from({ length: CHAIN }, (_, i) => `exports.e${String(i)} = `).join("")}void 0;`,
          "function helper() { return 1; }",
          "function e0() { return helper(); }",
          "exports.e0 = e0;",
          "",
        ].join("\n"),
      },
    ]);

    expect(fileDiagnostics(result, "src/exports.js")).toEqual([]);
    expect(result.nodes.some((n) => n.kind === "Function" && n.qualifiedName === "e0")).toBe(true);
    const calls = result.edges.find(
      (edge) => edge.kind === "CALLS" && edge.from.qualifiedName === "e0" && edge.to.qualifiedName === "helper",
    );
    expect(calls?.resolution).toBe("verified");
  });

  it("still indexes logical-operator chains past the nesting limit at file level only", () => {
    const result = analyze([
      {
        relativePath: "src/logical.ts",
        content: `declare const c: boolean;\nexport const v = c${" || c".repeat(MAX_SYNTAX_NESTING_DEPTH + 10)};\n`,
      },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);

    expect(limitDiagnostics(result, "src/logical.ts")).toHaveLength(1);
    expectHealthyFileAnalyzed(result);
  });

  it("still indexes member/call chains past the nesting limit at file level only", () => {
    const result = analyze([
      {
        relativePath: "src/builder.ts",
        content: `const m = new Map<number, number>();\nexport const r = m${".set(1, 1)".repeat(MAX_SYNTAX_NESTING_DEPTH)};\n`,
      },
      { relativePath: "src/healthy.ts", content: HEALTHY_TS },
    ]);

    expect(limitDiagnostics(result, "src/builder.ts")).toHaveLength(1);
    expectHealthyFileAnalyzed(result);
  });

  /**
   * Test files: describe/it extraction walks the file on an explicit stack, so
   * the Test nodes of a file with such a chain do not depend on the stack size
   * of the thread the adapter runs on (vitest runs this on a process main
   * thread, the in-process IndexService path).
   */
  function testsOf(result: TypeScriptAdapterResult, relativePath: string) {
    return {
      tests: result.nodes
        .filter((n) => n.kind === "Test" && n.relativePath === relativePath)
        .map((n) => n.qualifiedName)
        .sort(),
      testsEdges: result.edges
        .filter((e) => e.kind === "TESTS" && e.from.relativePath === relativePath)
        .map((e) => `${e.from.qualifiedName} -> ${e.to.qualifiedName} (${e.resolution})`)
        .sort(),
    };
  }

  function commaChainTestFile(links: number): string {
    return [
      "function f() { return 1; }",
      'describe("bundle", () => {',
      '  it("runs the chain", () => {',
      `    ${Array.from({ length: links }, () => "f()").join(",\n    ")};`,
      "  });",
      '  it("after the chain", () => {',
      "    f();",
      "  });",
      "});",
      "",
    ].join("\n");
  }

  function assignmentChainTestFile(links: number): string {
    return [
      '"use strict";',
      `${Array.from({ length: links }, (_, i) => `exports.e${String(i)} = `).join("")}void 0;`,
      "function e0() { return 1; }",
      "exports.e0 = e0;",
      'describe("exports", () => {',
      '  it("calls e0", () => {',
      "    e0();",
      "  });",
      "});",
      "",
    ].join("\n");
  }

  it("extracts describe/it Test nodes of a test file holding a 5000-term comma chain", () => {
    const result = analyze([{ relativePath: "src/bundle.test.js", content: commaChainTestFile(CHAIN) }]);

    expect(fileDiagnostics(result, "src/bundle.test.js")).toEqual([]);
    expect(testsOf(result, "src/bundle.test.js")).toEqual({
      tests: ["bundle > after the chain", "bundle > runs the chain"],
      testsEdges: [
        "bundle > after the chain -> f (verified)",
        "bundle > runs the chain -> f (verified)",
      ],
    });
  });

  it("extracts describe/it Test nodes of a test file holding a 5000-link export assignment chain", () => {
    const result = analyze([{ relativePath: "src/exports.test.js", content: assignmentChainTestFile(CHAIN) }]);

    expect(fileDiagnostics(result, "src/exports.test.js")).toEqual([]);
    expect(testsOf(result, "src/exports.test.js")).toEqual({
      tests: ["exports > calls e0"],
      testsEdges: ["exports > calls e0 -> e0 (verified)"],
    });
  });

  it("yields the same Test nodes for a test file whatever the depth of its chains", () => {
    for (const [relativePath, build] of [
      ["src/bundle.test.js", commaChainTestFile],
      ["src/exports.test.js", assignmentChainTestFile],
    ] as const) {
      const shallow = analyze([{ relativePath, content: build(3) }]);
      const deep = analyze([{ relativePath, content: build(CHAIN) }]);
      expect(testsOf(deep, relativePath)).toEqual(testsOf(shallow, relativePath));
      expect(fileDiagnostics(deep, relativePath)).toEqual(fileDiagnostics(shallow, relativePath));
    }
  });
});

describe("framework detection on deeply nested expressions", { timeout: 120_000 }, () => {
  it("survives a left-deep binary chain deeper than the call stack in a file without imports", () => {
    const chain = `export const n = 1${"+1".repeat(8_000)};\n`;
    const run = analyzeTypeScriptProgramWithFrameworks({
      workspaceId: WORKSPACE_ID,
      rootDir: ROOT,
      configFiles: [],
      sources: [
        {
          relativePath: "src/app.ts",
          content: [
            'import express from "express";',
            "const app = express();",
            "export function health(): number {",
            "  return 1;",
            "}",
            'app.get("/health", health);',
            "",
          ].join("\n"),
        },
        { relativePath: "src/chain.ts", content: chain },
        { relativePath: "src/healthy.ts", content: HEALTHY_TS },
      ],
    });

    expect(run.framework.detections.map((d) => d.framework)).toEqual(["express"]);
    expect(
      run.result.nodes.some((node) => node.kind === "File" && node.qualifiedName === "src/chain.ts"),
    ).toBe(true);
    expectHealthyFileAnalyzed(run.result);
  });
});

describe("bounded names in node identities and evidence rationales", { timeout: 120_000 }, () => {
  const LONG = 20_000;
  /** A rationale holds at most two bounded names plus fixed text and a relative path. */
  const MAX_RATIONALE_CHARS = 2 * MAX_QUALIFIED_NAME_CHARS + 400;

  function expectBoundedOutput(result: TypeScriptAdapterResult): void {
    for (const node of result.nodes) {
      if (node.kind === "File") continue;
      expect(node.qualifiedName.length).toBeLessThanOrEqual(MAX_QUALIFIED_NAME_CHARS);
    }
    for (const edge of result.edges) {
      for (const evidence of edge.evidence ?? []) {
        expect(evidence.rationale.length).toBeLessThanOrEqual(MAX_RATIONALE_CHARS);
      }
    }
  }

  it("does not copy a very long caller name into every per-call-site CALLS rationale", () => {
    const callerName = `A${"a".repeat(LONG)}`;
    const result = analyze([
      {
        relativePath: "src/a.ts",
        content: [
          "function b(): void {}",
          `export function ${callerName}(): void {`,
          ...Array.from({ length: 40 }, () => "  b();"),
          "}",
          "",
        ].join("\n"),
      },
    ]);

    expectBoundedOutput(result);
    const caller = result.nodes.find((n) => n.kind === "Function" && n.qualifiedName.startsWith("Aaaa"));
    expect(caller).toBeDefined();
    const calls = result.edges.find(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === caller!.qualifiedName &&
        edge.to.qualifiedName === "b",
    );
    expect(calls?.resolution).toBe("verified");
    expect(calls?.evidence).toHaveLength(40);
  });

  it("truncates over-long names with a stable, content-derived marker and keeps distinct names distinct", () => {
    const nameX = `${"Q".repeat(LONG)}X`;
    const nameY = `${"Q".repeat(LONG)}Y`;
    const sources = [
      {
        relativePath: "src/names.ts",
        content: `export function ${nameX}(): void {}\nexport function ${nameY}(): void {}\n`,
      },
    ];
    const first = analyze(sources);
    const second = analyze(sources);

    const names = first.nodes.filter((n) => n.kind === "Function").map((n) => n.qualifiedName);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.startsWith("QQQQ")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(MAX_QUALIFIED_NAME_CHARS);
    }
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps names up to the limit verbatim and truncates only longer ones", () => {
    const atLimit = `f${"x".repeat(MAX_QUALIFIED_NAME_CHARS - 1)}`;
    const overLimit = `g${"x".repeat(MAX_QUALIFIED_NAME_CHARS)}`;
    const result = analyze([
      {
        relativePath: "src/limit.ts",
        content: `export function ${atLimit}(): void {}\nexport function ${overLimit}(): void {}\n`,
      },
    ]);

    const names = result.nodes.filter((n) => n.kind === "Function").map((n) => n.qualifiedName);
    expect(names).toContain(atLimit);
    expect(names).not.toContain(overLimit);
    expect(names.some((n) => n.startsWith("gxxx") && n.length <= MAX_QUALIFIED_NAME_CHARS)).toBe(true);
  });

  it("bounds Test identities and rationales under a very long describe title", () => {
    const title = "T".repeat(LONG);
    const result = analyze([
      { relativePath: "src/helper.ts", content: "export function helper(): number {\n  return 1;\n}\n" },
      {
        relativePath: "src/long.test.ts",
        content: [
          'import { helper } from "./helper.js";',
          "declare function describe(title: string, fn: () => void): void;",
          "declare function it(title: string, fn: () => void): void;",
          `describe("${title}", () => {`,
          ...Array.from({ length: 30 }, (_, i) => `  it("case ${String(i)}", () => { helper(); });`),
          "});",
          "",
        ].join("\n"),
      },
    ]);

    expectBoundedOutput(result);
    const tests = result.nodes.filter((n) => n.kind === "Test");
    expect(tests).toHaveLength(30);
    expect(new Set(tests.map((t) => t.qualifiedName)).size).toBe(30);
    const testsEdges = result.edges.filter(
      (edge) => edge.kind === "TESTS" && edge.to.qualifiedName === "helper",
    );
    expect(testsEdges).toHaveLength(30);
  });

  it("bounds method identities of a class with a very long name", () => {
    const className = `C${"c".repeat(LONG)}`;
    const result = analyze([
      {
        relativePath: "src/klass.ts",
        content: [
          "function b(): void {}",
          `export class ${className} {`,
          ...Array.from({ length: 30 }, (_, i) => `  m${String(i)}(): void { b(); }`),
          "}",
          "",
        ].join("\n"),
      },
    ]);

    expectBoundedOutput(result);
    const methods = result.nodes.filter((n) => n.kind === "Method");
    expect(methods).toHaveLength(30);
    expect(new Set(methods.map((m) => m.qualifiedName)).size).toBe(30);
    expect(
      result.edges.filter((edge) => edge.kind === "CALLS" && edge.to.qualifiedName === "b"),
    ).toHaveLength(30);
  });

  it("leaves normal-length names, test titles and rationales unchanged", () => {
    const result = analyze([
      { relativePath: "src/helper.ts", content: "export function helper(): number {\n  return 1;\n}\n" },
      {
        relativePath: "src/short.test.ts",
        content: [
          'import { helper } from "./helper.js";',
          "declare function describe(title: string, fn: () => void): void;",
          "declare function it(title: string, fn: () => void): void;",
          'describe("suite", () => {',
          '  describe("inner", () => {',
          '    it("case", () => { helper(); });',
          "  });",
          "});",
          "",
        ].join("\n"),
      },
    ]);

    const test = result.nodes.find((n) => n.kind === "Test");
    expect(test?.qualifiedName).toBe("suite > inner > case");
    const contains = result.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.to.qualifiedName === "suite > inner > case",
    );
    expect(contains?.evidence?.[0]?.rationale).toBe(
      "CONTAINS: test definition 'suite > inner > case' in src/short.test.ts, matched by AST span evidence.",
    );
    const testsEdge = result.edges.find((edge) => edge.kind === "TESTS");
    expect(testsEdge?.evidence?.[0]?.rationale).toBe(
      "TESTS: call expression in test suite > inner > case was resolved by the TypeChecker to symbol helper (verified).",
    );
  });
});
