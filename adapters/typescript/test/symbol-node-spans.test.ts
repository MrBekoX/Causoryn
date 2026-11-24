import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { sha256Hex, utf8Encode, type NodeKind } from "@causoryn/domain";

import {
  analyzeTypeScriptProgram,
  type TypeScriptAdapterResult,
} from "../src/index.js";

/**
 * Symbol nodes must carry their real declaration span (1-based start/end
 * lines of the declaration), not a `1:1` placeholder. Spans live on the node
 * itself (`location`) so downstream consumers such as agent context can report
 * a narrow, truthful range without re-reading evidence rows.
 *
 * The workspace is purely in-memory (virtual root that does not exist on disk);
 * nothing is written anywhere.
 */

const VIRTUAL_ROOT = path.resolve(tmpdir(), "causoryn-symbol-spans-virtual-root");

const BILLING = [
  "/** Computes an order total. */", // 1
  "export function computeTotal(items: readonly number[]): number {", // 2
  "  let total = 0;", // 3
  "  for (const item of items) total += item;", // 4
  "  return total;", // 5
  "}", // 6
  "", // 7
  "export interface Priced {", // 8
  "  price(): number;", // 9
  "}", // 10
  "", // 11
  "export class Invoice implements Priced {", // 12
  "  constructor(private readonly lines: number[]) {}", // 13
  "", // 14
  "  price(): number {", // 15
  "    return computeTotal(this.lines);", // 16
  "  }", // 17
  "}", // 18
  "", // 19
  "export const handleInvoice = (lines: number[]): number =>", // 20
  "  new Invoice(lines).price();", // 21
  "", // 22
  "export function parse(input: string): number;", // 23
  "export function parse(input: number): number;", // 24
  "export function parse(input: string | number): number {", // 25
  "  return Number(input);", // 26
  "}", // 27
  "",
].join("\n");

const ROUTES = [
  'import { handleInvoice } from "./billing.js";', // 1
  "", // 2
  "interface Router {", // 3
  "  post(path: string, handler: (lines: number[]) => number): void;", // 4
  "}", // 5
  "", // 6
  "export function registerRoutes(router: Router): void {", // 7
  "  router.post(", // 8
  '    "/invoices",', // 9
  "    handleInvoice,", // 10
  "  );", // 11
  "}", // 12
  "",
].join("\n");

/** Nodes created on demand while resolving calls (no File→symbol CONTAINS edge). */
const LEDGER = [
  "export class Ledger {", // 1
  '  readonly label = (): string => "ledger";', // 2
  "", // 3
  "  total(lines: number[]): number {", // 4
  "    this.label();", // 5
  "    return lines.length;", // 6
  "  }", // 7
  "}", // 8
  "export function useLedger(): number {", // 9
  "  const local = (n: number): number => n + 1;", // 10
  "  function nested(): number {", // 11
  "    return local(1);", // 12
  "  }", // 13
  "  return nested() + new Ledger().total([1]);", // 14
  "}", // 15
  "",
].join("\n");

const BILLING_TEST = [
  'import { computeTotal } from "./billing.js";', // 1
  "", // 2
  'describe("billing", () => {', // 3
  '  it("sums items", () => {', // 4
  "    computeTotal([1, 2]);", // 5
  "  });", // 6
  "});", // 7
  "",
  "declare function describe(name: string, fn: () => void): void;",
  "declare function it(name: string, fn: () => void): void;",
  "",
].join("\n");

function analyze(): TypeScriptAdapterResult {
  return analyzeTypeScriptProgram({
    workspaceId: "ws-symbol-spans",
    rootDir: VIRTUAL_ROOT,
    sources: [
      { relativePath: "src/billing.ts", content: BILLING },
      { relativePath: "src/routes.ts", content: ROUTES },
      { relativePath: "src/ledger.ts", content: LEDGER },
      { relativePath: "src/billing.test.ts", content: BILLING_TEST },
    ],
    configFiles: [],
    packageFiles: [],
  });
}

function spanOf(
  result: TypeScriptAdapterResult,
  kind: NodeKind,
  qualifiedName: string,
): { readonly startLine: number; readonly endLine: number } | undefined {
  const node = result.nodes.find(
    (candidate) => candidate.kind === kind && candidate.qualifiedName === qualifiedName,
  );
  expect(node, `${kind} ${qualifiedName} node exists`).toBeDefined();
  const location = node?.location;
  return location === undefined
    ? undefined
    : { startLine: location.startLine, endLine: location.endLine };
}

// CPU-bound ts.createProgram runs: explicit budget for parallel-suite load
// (same convention as framework-linkers.test.ts); assertions are not relaxed.
describe("TypeScript adapter: symbol node declaration spans", { timeout: 60_000 }, () => {
  it("top-level declarations carry their real 1-based declaration line range", () => {
    const result = analyze();
    expect(spanOf(result, "Function", "computeTotal")).toEqual({ startLine: 2, endLine: 6 });
    expect(spanOf(result, "Interface", "Priced")).toEqual({ startLine: 8, endLine: 10 });
    expect(spanOf(result, "Class", "Invoice")).toEqual({ startLine: 12, endLine: 18 });
    expect(spanOf(result, "Handler", "handleInvoice")).toEqual({ startLine: 20, endLine: 21 });
    expect(spanOf(result, "Function", "registerRoutes")).toEqual({ startLine: 7, endLine: 12 });
  });

  it("members, endpoints and tests carry their own spans", () => {
    const result = analyze();
    expect(spanOf(result, "Method", "Priced.price")).toEqual({ startLine: 9, endLine: 9 });
    expect(spanOf(result, "Method", "Invoice.price")).toEqual({ startLine: 15, endLine: 17 });
    // Endpoint span is the route registration call expression.
    expect(spanOf(result, "Endpoint", "POST /invoices")).toEqual({ startLine: 8, endLine: 11 });
    expect(spanOf(result, "Test", "billing > sums items")).toEqual({ startLine: 4, endLine: 6 });
  });

  it("nodes derived while resolving calls (no CONTAINS edge) carry their declaration span", () => {
    const result = analyze();
    expect(spanOf(result, "Method", "Ledger.label")).toEqual({ startLine: 2, endLine: 2 });
    expect(spanOf(result, "Handler", "local")).toEqual({ startLine: 10, endLine: 10 });
    expect(spanOf(result, "Function", "nested")).toEqual({ startLine: 11, endLine: 13 });
    expect(spanOf(result, "Method", "Ledger.total")).toEqual({ startLine: 4, endLine: 7 });
  });

  it("overloaded declarations merge into one span covering every signature and the body", () => {
    const result = analyze();
    expect(spanOf(result, "Function", "parse")).toEqual({ startLine: 23, endLine: 27 });
  });

  it("every file-bound symbol node points at its own file with that file's content hash", () => {
    const result = analyze();
    const hashByPath = new Map<string, string>([
      ["src/billing.ts", sha256Hex(utf8Encode(BILLING))],
      ["src/routes.ts", sha256Hex(utf8Encode(ROUTES))],
      ["src/ledger.ts", sha256Hex(utf8Encode(LEDGER))],
      ["src/billing.test.ts", sha256Hex(utf8Encode(BILLING_TEST))],
    ]);
    const symbolNodes = result.nodes.filter(
      (node) => node.kind !== "File" && node.relativePath !== undefined,
    );
    expect(symbolNodes.length).toBeGreaterThanOrEqual(10);
    for (const node of symbolNodes) {
      const location = node.location;
      expect(location, `${node.kind} ${node.qualifiedName} has a location`).toBeDefined();
      if (location === undefined) continue;
      expect(location.relativePath).toBe(node.relativePath);
      expect(location.sourceHash).toBe(hashByPath.get(node.relativePath ?? ""));
      expect(location.startLine).toBeGreaterThanOrEqual(1);
      expect(location.endLine).toBeGreaterThanOrEqual(location.startLine);
    }
  });

  it("spans are deterministic across runs", () => {
    expect(JSON.stringify(analyze().nodes)).toBe(JSON.stringify(analyze().nodes));
  });
});
