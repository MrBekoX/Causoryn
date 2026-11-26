import { describe, expect, it, vi } from "vitest";

/**
 * CAU-04 criterion 1: key and line lookups of a parsed spec are indexed once
 * per document and reused. The `yaml` module is wrapped so the test can count
 * how many YAML key nodes the source code inspects (`isScalar` calls made by
 * the contracts package itself; yaml's internal calls bypass this wrapper). A
 * per-route linear scan of the `paths` map inspects ~N²/2 keys; an index
 * inspects each key once.
 */
const counters = vi.hoisted(() => ({ isScalar: 0, defaultKeyCheckParses: 0, keyComparisons: 0 }));

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  type ParseOptions = NonNullable<Parameters<typeof actual.parseDocument>[1]>;
  return {
    ...actual,
    isScalar: (node: unknown) => {
      counters.isScalar += 1;
      return actual.isScalar(node);
    },
    // Counts the duplicate-key comparisons the library makes on behalf of the
    // contracts code. Without a comparator function the library falls back to
    // its own O(k²) per-map scan (counted as a default-check parse).
    parseDocument: (source: string, options?: ParseOptions) => {
      const uniqueKeys = options?.uniqueKeys;
      if (typeof uniqueKeys !== "function") {
        counters.defaultKeyCheckParses += 1;
        return actual.parseDocument(source, options);
      }
      return actual.parseDocument(source, {
        ...options,
        uniqueKeys: (a, b) => {
          counters.keyComparisons += 1;
          return uniqueKeys(a, b);
        },
      });
    },
  };
});

import { discoverAsyncApiContracts, discoverOpenApiContracts, parseStructuredSpec } from "../src/index.js";

import { generateAsyncApi, generateOpenApi, routeName } from "./large-spec-fixtures.js";

describe("ParsedSpec.lineOf index reuse", () => {
  const ROUTES = 2000;
  const spec = generateOpenApi(ROUTES, 2);

  it("looks up every route line with a linear number of key inspections", () => {
    const parsed = parseStructuredSpec("big/openapi.yaml", spec.text);
    counters.isScalar = 0;
    for (const [route, line] of spec.keyLines) {
      expect(parsed.lineOf("paths", route)).toBe(line);
    }
    expect(counters.isScalar).toBeLessThanOrEqual(2 * ROUTES + 50);
  });

  it("parsing makes at most one duplicate-key comparison per key (no O(k²) library scan)", () => {
    counters.defaultKeyCheckParses = 0;
    counters.keyComparisons = 0;
    const flat = ["openapi: 3.1.0", "paths:", ...Array.from({ length: ROUTES }, (_, index) => `  ${routeName(index)}: 1`)];
    const parsed = parseStructuredSpec("flat/openapi.yaml", flat.join("\n"));
    expect(Object.keys(parsed.root["paths"] as object)).toHaveLength(ROUTES);
    expect(counters.defaultKeyCheckParses).toBe(0);
    expect(counters.keyComparisons).toBeLessThanOrEqual(ROUTES + 2);
  });

  it("keeps the strict key semantics: missing keys and non-string segments find nothing", () => {
    const parsed = parseStructuredSpec(
      "keys.yaml",
      ["root:", "  200: numeric", '  "300": quoted', "  .nan: notanumber", "list:", "  - first", "  - second"].join("\n"),
    );
    expect(parsed.lineOf("root", 200)).toBe(2);
    expect(parsed.lineOf("root", "200")).toBeUndefined();
    expect(parsed.lineOf("root", "300")).toBe(3);
    expect(parsed.lineOf("root", 300)).toBeUndefined();
    expect(parsed.lineOf("root", Number.NaN)).toBeUndefined();
    expect(parsed.lineOf("root", "missing")).toBeUndefined();
    expect(parsed.lineOf("list", 1)).toBe(7);
    expect(parsed.lineOf("list", "0")).toBe(6);
    expect(parsed.lineOf("list", 2)).toBeUndefined();
    expect(parsed.lineOf("missing", "x")).toBeUndefined();
    expect(parsed.lineOf()).toBeUndefined();
  });

  // Discovery also parses, and parsing inspects each key once for the
  // duplicate-key check; every line of the generated documents holds one key.
  const keysIn = (text: string): number => text.split("\n").length;

  it("OpenAPI discovery inspects each key a constant number of times", () => {
    counters.isScalar = 0;
    const out = discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text);
    expect(out.contracts).toHaveLength(ROUTES);
    expect(out.contracts.find((contract) => contract.route === routeName(ROUTES - 1))?.evidence.startLine).toBe(
      spec.keyLines.get(routeName(ROUTES - 1)),
    );
    expect(counters.isScalar).toBeLessThanOrEqual(2 * keysIn(spec.text));
  });

  it("AsyncAPI discovery inspects each key a constant number of times", () => {
    const channels = generateAsyncApi(ROUTES, 2);
    counters.isScalar = 0;
    const out = discoverAsyncApiContracts("ws", "big/asyncapi.yaml", channels.text);
    expect(out.contracts).toHaveLength(ROUTES);
    expect(counters.isScalar).toBeLessThanOrEqual(2 * keysIn(channels.text));
  });
});
