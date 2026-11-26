import { describe, expect, it } from "vitest";

import { ContractDiscoveryError, discoverContractsFromTexts, parseStructuredSpec } from "../src/index.js";
import { parseYamlDocument } from "../src/yaml-document.js";

/**
 * F24 (CWE-407): the `yaml` library's toJS() can spend unbounded time on a
 * small spec, and the text prechecks (size, bracket nesting, alias count) do
 * not bound that work. Measured with yaml 2.9.1 before the fix:
 * - an alias to an anchor whose alias count stays 0 (`&e []`, or a sequence of
 *   aliases to it) recomputes the count on every use, walking the whole
 *   document once per alias inside it: 1.2 KB took 2.3 s, 40 KB took 6.5 s;
 * - every collection-valued map key loops over every anchor seen so far:
 *   20,000 anchors and 3,000 such keys (300 KB) took 16 s;
 * - the first use of an anchor that holds many aliases walks the whole
 *   document once per alias it holds.
 * Each spec must now be refused with `contracts/limit-exceeded` before toJS
 * runs, while normal specs convert exactly as toJS converts them.
 */

/**
 * The refusal must cost about one parse of the text, not a conversion: the
 * bound is relative to the parse time so it holds on a loaded runner (before
 * the fix these specs took 17 s, 4.8 s and 18 s, against parses well under 1 s).
 */
function fastBound(text: string): number {
  const started = performance.now();
  parseYamlDocument(text);
  return 2 * (performance.now() - started) + 1_000;
}

function refusal(fn: () => unknown): { code: string; ms: number } {
  const started = performance.now();
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractDiscoveryError);
    return { code: (error as ContractDiscoveryError).code, ms: performance.now() - started };
  }
  throw new Error(`expected a ContractDiscoveryError, but the spec was accepted after ${String(performance.now() - started)} ms`);
}

function list(count: number, item: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => item(index)).join(",");
}

/** `&e []` keeps an alias count of 0, so every `*b` walks the document once per `*e` inside b. */
function zeroWeightAnchorSpec(inner: number, outer: number): string {
  return [
    'openapi: "3.0.0"',
    "e: &e []",
    `b: &b [${list(inner, () => "*e")}]`,
    `c: [${list(outer, () => "*b")}]`,
    "paths: {}",
  ].join("\n");
}

/** Each collection-valued key loops over every anchor converted before it. */
function collectionKeysSpec(anchors: number, keys: number): string {
  return [
    'openapi: "3.0.0"',
    "anchors:",
    ...Array.from({ length: anchors }, (_, index) => `  - &a${String(index)} 0`),
    `keys: {${list(keys, (index) => `[${String(index)}]: 0`)}}`,
    "paths: {}",
  ].join("\n");
}

/**
 * The first use of `b` walks the whole document once for each alias b holds
 * (each alias names its own anchor, so the library's 100-uses-per-anchor
 * limit never fires).
 */
function nestedAliasesSpec(aliases: number, padding: number): string {
  return [
    'openapi: "3.0.0"',
    `s: [${list(aliases, (index) => `&s${String(index)} 1`)}]`,
    `b: &b [1,${list(aliases, (index) => `*s${String(index)}`)}]`,
    "c: *b",
    `pad: [${list(padding, () => "0")}]`,
    "paths: {}",
  ].join("\n");
}

describe("F24: yaml toJS work is bounded before conversion", () => {
  it("refuses an alias to an anchor whose alias count stays 0, in the .yaml sniff and the .json parse", () => {
    const spec = zeroWeightAnchorSpec(250, 250);
    const viaYaml = refusal(() => discoverContractsFromTexts("ws-1", [{ relativePath: "api/openapi.yaml", text: spec }]));
    expect(viaYaml.code).toBe("contracts/limit-exceeded");
    expect(viaYaml.ms).toBeLessThan(fastBound(spec));

    const viaJson = refusal(() => parseStructuredSpec("api/schema.json", spec));
    expect(viaJson.code).toBe("contracts/limit-exceeded");
    expect(viaJson.ms).toBeLessThan(fastBound(spec));
  });

  it("refuses many collection-valued keys after many anchors (no aliases at all)", () => {
    const spec = collectionKeysSpec(10_000, 2_000);
    const result = refusal(() => parseStructuredSpec("api/openapi.yaml", spec));
    expect(result.code).toBe("contracts/limit-exceeded");
    expect(result.ms).toBeLessThan(fastBound(spec));
  });

  it("refuses an anchor holding many aliases in a large document", () => {
    const spec = nestedAliasesSpec(2_000, 40_000);
    const result = refusal(() => parseStructuredSpec("api/openapi.yaml", spec));
    expect(result.code).toBe("contracts/limit-exceeded");
    expect(result.ms).toBeLessThan(fastBound(spec));
  });

  /**
   * Review round 2: the library stringifies a collection-valued key with
   * key.toString(), and a key nested in a key is stringified again at every
   * level, with growing indentation (about K × D²). 98 `{` and one `[` stay
   * under the bracket-nesting precheck; measured before this fix: K = 10,000
   * (20 KB) took 8.4 s in parseStructuredSpec and 16.8 s in discovery.
   */
  it("refuses nested collection-valued keys (no aliases), in the .yaml sniff and the parse", () => {
    const depth = 98;
    const spec = [
      'openapi: "3.0.0"',
      `k: ${"{".repeat(depth)}[${list(10_000, () => "0")}]: 0${"}: 0".repeat(depth - 1)}}`,
      "paths: {}",
    ].join("\n");
    const viaYaml = refusal(() => discoverContractsFromTexts("ws-1", [{ relativePath: "api/openapi.yaml", text: spec }]));
    expect(viaYaml.code).toBe("contracts/limit-exceeded");
    expect(viaYaml.ms).toBeLessThan(fastBound(spec));

    const viaParse = refusal(() => parseStructuredSpec("api/openapi.yaml", spec));
    expect(viaParse.code).toBe("contracts/limit-exceeded");
    expect(viaParse.ms).toBeLessThan(fastBound(spec));
  });

  it.each([
    ["an explicit sequence key", ["? [a, b]", ": pair"]],
    ["an explicit mapping key", ["? {k: v}", ": map"]],
    ["a flow sequence key", ["m: {[0]: 0}"]],
    ["a collection key inside a sequence of pairs", ["p: !!pairs [? [a] : 1]"]],
  ])("refuses %s, which no OpenAPI, AsyncAPI or JSON Schema document uses", (_label, lines) => {
    const spec = ['openapi: "3.0.0"', "paths: {}", ...lines].join("\n");
    const result = refusal(() => parseStructuredSpec("api/openapi.yaml", spec));
    expect(result.code).toBe("contracts/limit-exceeded");
  });

  it("refuses many keys that convert to objects (dates) after many anchors, by the work bound", () => {
    const spec = [
      "%YAML 1.1",
      "---",
      'openapi: "3.0.0"',
      "anchors:",
      ...Array.from({ length: 10_000 }, (_, index) => `  - &a${String(index)} 0`),
      "dates:",
      ...Array.from({ length: 2_000 }, (_, index) => `  ${String(2001 + Math.floor(index / 365))}-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:${String(index % 60).padStart(2, "0")}Z: ${String(index)}`),
      "paths: {}",
    ].join("\n");
    const result = refusal(() => parseStructuredSpec("api/openapi.yaml", spec));
    expect(result.code).toBe("contracts/limit-exceeded");
    expect(result.ms).toBeLessThan(fastBound(spec));
  });
});

/** Structural form of a converted value (Maps, Sets, Dates, symbols, NaN compare by content). */
function canonical(value: unknown): unknown {
  if (typeof value === "symbol") return `Symbol(${value.description ?? ""})`;
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value instanceof Map) return ["Map", [...value.entries()].map(([k, v]) => [canonical(k), canonical(v)])];
  if (value instanceof Set) return ["Set", [...value.values()].map(canonical)];
  if (value instanceof Date) return ["Date", value.toISOString()];
  if (value instanceof Uint8Array) return ["Uint8Array", [...value]];
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string | symbol, unknown>;
    return ["Object", Reflect.ownKeys(record).map((key) => [canonical(key), canonical(record[key])])];
  }
  return value;
}

const NORMAL_SPECS: ReadonlyArray<readonly [string, string]> = [
  [
    "openapi.yaml",
    [
      "openapi: 3.1.0",
      "info: {title: Orders, version: 1.0.0}",
      "x-defaults: &defaults {type: string, maxLength: 64}",
      "paths:",
      "  /orders:",
      "    get:",
      "      responses:",
      "        '200': {description: ok}",
      "components:",
      "  schemas:",
      "    Id: *defaults",
      "    Name: *defaults",
      "    Tags: {type: array, items: *defaults}",
      "    Empty: &empty []",
      "    AlsoEmpty: *empty",
    ].join("\n"),
  ],
  [
    "merge-1.1.yaml",
    [
      "%YAML 1.1",
      "---",
      "openapi: 3.0.0",
      "base: &base {a: 1, b: 2}",
      "derived: {<<: *base, c: 3}",
      "multi: {<<: [*base, {d: 4}], e: 5}",
      "when: 2001-12-14",
      "flag: yes",
    ].join("\n"),
  ],
  ["explicit-merge.yaml", ["base: &b {x: 1}", "child:", "  !!merge <<: *b", "  y: 2"].join("\n")],
  // Keys that convert to objects but are not collections: the library still
  // stringifies them (an alias key prints as `*l`, a date or binary scalar once).
  [
    "object-keys.yaml",
    [
      "%YAML 1.1",
      "---",
      "list: &l [a, b]",
      "? *l",
      ": aliased-collection",
      "2001-12-14: date-key",
      "? !!binary aGVsbG8=",
      ": binary-key",
      "&k plain: 1",
      "again: *k",
    ].join("\n"),
  ],
  ["tags.yaml", ["bin: !!binary aGVsbG8=", "set: !!set {a, b}", "omap: !!omap [{a: 1}, {b: 2}]", "big: 12345678901234567890"].join("\n")],
  ["schema.json", JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "x", properties: { a: { type: "string" } } }, null, 2)],
];

describe("F24: normal specs convert exactly as yaml's toJS converts them", () => {
  it.each(NORMAL_SPECS)("%s", (relativePath, text) => {
    const expected = canonical(parseYamlDocument(text).toJS());
    expect(canonical(parseStructuredSpec(relativePath, text).root)).toEqual(expected);
  });

  it("still converts a spec with 4,000 anchors each aliased once", () => {
    const count = 4_000;
    const text = [
      'openapi: "3.0.0"',
      "defs:",
      ...Array.from({ length: count }, (_, index) => `  d${String(index)}: &d${String(index)} v${String(index)}`),
      "uses:",
      ...Array.from({ length: count }, (_, index) => `  u${String(index)}: *d${String(index)}`),
      "paths: {}",
    ].join("\n");
    const root = parseStructuredSpec("api/openapi.yaml", text).root as { uses: Record<string, string> };
    expect(root.uses["u3999"]).toBe("v3999");
  });

  it("still converts a 1 MiB-class plain spec", () => {
    const lines = ['{"openapi": "3.0.0", "paths": {}, "x": {'];
    const entries = Array.from({ length: 40_000 }, (_, index) => `"k${String(index)}": "value-${String(index)}"`);
    const text = `${lines.join("")}${entries.join(", ")}}}`;
    expect(text.length).toBeGreaterThan(900_000);
    const root = parseStructuredSpec("api/openapi.json", text).root as { x: Record<string, string> };
    expect(root.x["k39999"]).toBe("value-39999");
  });
});
