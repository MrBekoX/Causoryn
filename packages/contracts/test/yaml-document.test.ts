import { describe, expect, it, vi } from "vitest";
import { parseDocument, type Document } from "yaml";

import { ContractDiscoveryError, parseStructuredSpec } from "../src/index.js";
import { describeSpecSyntaxError } from "../src/parse-safety.js";
import { parseYamlDocument } from "../src/yaml-document.js";

/**
 * CAU-04: the `yaml` library's default duplicate-key check scans every earlier
 * key of a map for each new key (O(k²) per map — ~37 s for a 250 KB map of
 * 20k keys). parseYamlDocument must return what parseDocument(text) returns —
 * same tree, same errors (code, position, line/column, order), same warnings —
 * while comparing each key once. Differential test against the library.
 */

function errorView(document: Document.Parsed): unknown {
  return {
    errors: document.errors.map((error) => ({ code: error.code, pos: error.pos, linePos: error.linePos })),
    warnings: document.warnings.map((warning) => ({ code: warning.code, pos: warning.pos, linePos: warning.linePos })),
  };
}

/**
 * Structural form of a toJS() value. Merge keys (`<<`) become a fresh Symbol
 * on every parse, even for two parseDocument calls, so symbols compare by
 * description; Maps and Sets keep their entry order.
 */
function canonical(value: unknown): unknown {
  if (typeof value === "symbol") return `Symbol(${value.description ?? ""})`;
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value instanceof Map) return ["Map", [...value.entries()].map(([k, v]) => [canonical(k), canonical(v)])];
  if (value instanceof Set) return ["Set", [...value.values()].map(canonical)];
  if (value instanceof Date) return ["Date", value.toISOString()];
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string | symbol, unknown>;
    const entries = Reflect.ownKeys(record).map((key) => [canonical(key), canonical(record[key])]);
    return ["Object", entries];
  }
  return value;
}

function jsView(document: Document.Parsed): unknown {
  try {
    return { js: canonical(document.toJS()) };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
}

const CORPUS: readonly string[] = [
  "",
  "a: 1",
  "a: 1\na: 2",
  "a: 1\nb: 2\na: 3\nb: 4\nc: 5",
  "x:\n  a: 1\n  b: 2\n  a: 3",
  "x:\n  a: 1\n\n  # comment\n  a: 3",
  '{"a": 1, "b": 2, "a": 3}',
  '{\n  "a": 1,\n  "a": 2\n}',
  "x: {a: 1, a: 2}",
  "x: {a: 1,   a: 2, b: {c: 1, c: 2}}",
  "&k a: 1\na: 2",
  "a: 1\n&k a: 2",
  "a: 1\n!!str a: 2",
  "? a\n: 1\n? a\n: 2",
  "1: x\n'1': y\n1: z",
  ": 1\n: 2",
  "? \n: 1\n? \n: 2",
  "x: [a: 1, a: 2]",
  "{? a : 1, ? a : 2}",
  "x:\n  - a: 1\n    a: 2\n  - a: 1\n    a: 2",
  'a: 1\n"a": 2',
  "a: 1 # c\na: 2",
  "x:\n  y:\n    a: 1\n    a: 2\n  y: 3",
  "? {a: 1, a: 2}\n: v\n? {a: 1, a: 2}\n: w",
  "a:\n  - 1\na: 2",
  "a: |\n  t\na: 2",
  "\n\n  a: 1\n  a: 2",
  "a: 1\r\na: 2\r\n",
  ".nan: 1\n.nan: 2",
  "null: 1\n~: 2",
  "true: 1\nTrue: 2",
  "0x10: a\n16: b",
  "*alias : 1\n*alias : 2",
  "base: &b {a: 1}\nx: *b\ny: *b",
  "a: 1\nb\na: 2",
  "a: [1, 2\nb: 1\nb: 2",
  "a: 1\n  b: 2\na: 3",
  "a:\tb\na: c",
  "- a: 1\n  a: 2\n- {b: 1, b: 2}\n- [c: 1, c: 2]",
  "a: 1\n---\na: 1\na: 2",
  "a: 1\na: 2\n---\nb: 1\nb: 2",
  "%YAML 1.1\n---\n!!set\n? a\n? b\n? a",
  "%YAML 1.1\n---\n!!omap\n- a: 1\n- a: 2",
  "%YAML 1.1\n---\n<<: {a: 1}\n<<: {b: 2}\nc: 3",
  "{a: 1, b: 2, a: 3, : 4, : 5}",
  "key with spaces: 1\nkey with spaces: 2",
  "'quoted': 1\nquoted: 2\n\"quoted\": 3",
  "a: !!int 1\na: !!str 1",
  "? - 1\n  - 2\n: a\n? - 1\n  - 2\n: b",
  "a: 1\n... \nb: 2",
  "!!map\na: 1\na: 2",
  "a: {x: 1, x: 2\nb: 3",
  // Ordered maps (YAML 1.1 tag list and the YAML 1.2 known-tags path), pairs, sets.
  "x: !!omap\n  - a: 1\n  - b: 2\n  - a: 3\n  - b: 4",
  "%YAML 1.1\n---\nx: !!omap\n  - a: 1\n  - b: 2\n  - a: 3",
  "x: !!omap\n  - a: 1\n    b: 2\n  - c",
  "x: !!omap {a: 1}",
  "x: !!omap [a: 1, a: 2, 1: x, '1': y]",
  "%TAG !e! tag:yaml.org,2002:\n---\nx: !e!omap\n  - a: 1\n  - a: 2",
  "x: !!pairs\n  - a: 1\n  - a: 2",
  "x: !!set\n  ? a\n  ? b\n  ? a",
  "x: !!set {a: 1}",
  "%YAML 1.1\n---\nx: !!set\n  ? a\n  ? a",
  "%YAML 1.1\n---\nx: !!omap\n  - <<: {a: 1}\n  - <<: {b: 2}",
  "x: !!omap\n  - .nan: 1\n  - .nan: 2\n  - null: 3\n  - ~: 4",
];

/** Deterministic xorshift32 generator (seeded; no Math.random). */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Small structured documents with frequent duplicate keys, flow/block mixes and occasional errors. */
function generatedDocuments(count: number, seed: number): string[] {
  const random = seeded(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const keys = ["a", "b", "c", "'a'", '"b"', "1", "'1'", "null", "~", "? a", "&k a", "!!str a"];
  const scalars = ["1", "x", "[1, 2]", "{p: 1, p: 2}", "{q: 1}", "*k", "'s'", "", "[r: 1, r: 2]"];
  const documents: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lines: string[] = [];
    if (random() < 0.1) lines.push("%YAML 1.1", "---");
    const entries = 1 + Math.floor(random() * 6);
    for (let entry = 0; entry < entries; entry += 1) {
      const key = pick(keys);
      if (random() < 0.25) {
        lines.push(`${key.startsWith("?") ? key + "\n:" : key + ":"}`);
        const nested = 1 + Math.floor(random() * 3);
        for (let child = 0; child < nested; child += 1) lines.push(`  ${pick(keys.slice(0, 7))}: ${pick(scalars)}`);
      } else if (random() < 0.15) {
        lines.push(`${key}: !!omap`, `  - ${pick(keys.slice(0, 4))}: 1`, `  - ${pick(keys.slice(0, 4))}: 2`);
      } else {
        lines.push(key.startsWith("?") ? `${key}\n: ${pick(scalars)}` : `${key}: ${pick(scalars)}`);
      }
    }
    if (random() < 0.1) lines.push("---", `${pick(keys)}: 1`, `${pick(keys)}: 2`);
    if (random() < 0.05) lines.push("bad: [unclosed");
    documents.push(lines.join(random() < 0.2 ? "\r\n" : "\n"));
  }
  return documents;
}

/** Sum of array lengths scanned by Array.prototype.includes while `fn` runs. */
function includesScanWork(fn: () => void): number {
  const original = Array.prototype.includes;
  let scanned = 0;
  const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (
    this: unknown[],
    ...args: [unknown, number?]
  ) {
    scanned += this.length;
    return original.apply(this, args);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return scanned;
}

function omapDocument(entries: number, directive: boolean): string {
  const lines = directive ? ["%YAML 1.1", "---"] : [];
  lines.push("openapi: 3.0.0", "paths: {}", "x: !!omap");
  for (let index = 0; index < entries; index += 1) lines.push(`  - k${String(index)}: 1`);
  return lines.join("\n");
}

describe("parseYamlDocument (linear duplicate-key check)", () => {
  it("returns the same tree, errors and warnings as yaml's parseDocument for every corpus document", () => {
    for (const text of CORPUS) {
      const expected = parseDocument(text);
      const actual = parseYamlDocument(text);
      expect({ text, ...(errorView(actual) as object) }).toEqual({ text, ...(errorView(expected) as object) });
      expect({ text, ...(jsView(actual) as object) }).toEqual({ text, ...(jsView(expected) as object) });
    }
  });

  it("matches parseDocument on a larger generated document with scattered duplicates", () => {
    const lines = ["root:"];
    for (let index = 0; index < 400; index += 1) {
      lines.push(`  k${String(index % 350)}: ${String(index)}`, `  m${String(index)}: {a: 1, b: 2${index % 97 === 0 ? ", a: 3" : ""}}`);
    }
    const text = lines.join("\n");
    expect(errorView(parseYamlDocument(text))).toEqual(errorView(parseDocument(text)));
  });

  it("parseStructuredSpec still rejects duplicate keys with the same syntax-error message as before", () => {
    const text = ["openapi: 3.1.0", "paths:", "  /a: {get: {}}", "  /b: {get: {}}", "  /a: {put: {}}"].join("\n");
    const reference = parseDocument(text).errors[0];
    expect(reference?.code).toBe("DUPLICATE_KEY");
    let caught: unknown;
    try {
      parseStructuredSpec("dup/openapi.yaml", text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContractDiscoveryError);
    expect((caught as ContractDiscoveryError).code).toBe("contracts/spec-yaml-invalid");
    expect((caught as ContractDiscoveryError).message).toBe(
      `Spec YAML/JSON syntax error: ${describeSpecSyntaxError(reference)}`,
    );
    expect((caught as ContractDiscoveryError).message).toContain("DUPLICATE_KEY at line 5, column 3");
  });

  it("matches parseDocument on 600 seeded generated documents (duplicates, flow/block, multi-document, errors)", () => {
    for (const text of generatedDocuments(600, 0xca04)) {
      const expected = parseDocument(text);
      const actual = parseYamlDocument(text);
      expect({ text, ...(errorView(actual) as object) }).toEqual({ text, ...(errorView(expected) as object) });
      expect({ text, ...(jsView(actual) as object) }).toEqual({ text, ...(jsView(expected) as object) });
    }
  });

  it("resolves a large ordered map (!!omap) with linear duplicate checking, in YAML 1.2 and 1.1", () => {
    const ENTRIES = 3000;
    for (const directive of [false, true]) {
      const text = omapDocument(ENTRIES, directive);
      let document: Document.Parsed | undefined;
      const scanned = includesScanWork(() => {
        document = parseYamlDocument(text);
      });
      expect(document?.errors).toEqual([]);
      // The library's own resolver rescans every earlier key per entry (~4.5M here).
      expect(scanned).toBeLessThanOrEqual(10 * ENTRIES);
    }
  });

  it("releases the per-parse comparator state and leaves default-valued document options", () => {
    const document = parseYamlDocument("a: 1\nb: {c: 1}");
    expect(document.options.uniqueKeys).toBe(true);
    expect(document.options.prettyErrors).toBe(true);
  });

  it("restores Error.stackTraceLimit after parsing", () => {
    const before = Error.stackTraceLimit;
    parseYamlDocument("a: 1\nb: 2\nc: 3");
    expect(Error.stackTraceLimit).toBe(before);
  });

  it("restores Error.stackTraceLimit when the parser throws", () => {
    const before = Error.stackTraceLimit;
    expect(() => parseYamlDocument(5 as unknown as string)).toThrow(TypeError);
    expect(Error.stackTraceLimit).toBe(before);
  });
});
