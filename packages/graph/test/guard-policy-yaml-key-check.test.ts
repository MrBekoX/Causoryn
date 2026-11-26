import { describe, expect, it, vi } from "vitest";

/**
 * CWE-407: `.causoryn/architecture.rules.yaml` and
 * `.causoryn/architecture.baseline.yaml` are repository input of up to
 * `maxFileBytes` (2,000,000 bytes by default). The `yaml` library's default
 * duplicate-key check compares every new key of a map with every earlier key
 * (O(k²) per map; about 100 s for a 560 KB flat map of 40,000 keys), so the
 * guard must parse with the linear check (`parseYamlDocument`) while keeping
 * the same errors. The `yaml` module is wrapped so the test counts, instead
 * of timing, how the guard parses: a parse without a comparator function is
 * a default (O(k²)) key-check parse; with one, each comparison is counted.
 */
const counters = vi.hoisted(() => ({ defaultKeyCheckParses: 0, keyComparisons: 0 }));

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  type ParseOptions = NonNullable<Parameters<typeof actual.parseDocument>[1]>;
  const parse = ((...args: Parameters<typeof actual.parse>) => {
    const options = args.find((arg) => typeof arg === "object" && arg !== null) as ParseOptions | undefined;
    if (typeof options?.uniqueKeys !== "function") counters.defaultKeyCheckParses += 1;
    return actual.parse(...args);
  }) as typeof actual.parse;
  const parseDocument = ((source: string, options?: ParseOptions) => {
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
  }) as typeof actual.parseDocument;
  return { ...actual, default: { ...actual, parse, parseDocument }, parse, parseDocument };
});

import { GuardError, parseArchitectureBaseline, parseArchitecturePolicy } from "../src/guard-policy-schema.js";

function resetCounters(): void {
  counters.defaultKeyCheckParses = 0;
  counters.keyComparisons = 0;
}

function guardErrorOf(run: () => unknown): GuardError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GuardError);
  return caught as GuardError;
}

const KEYS = 5000;

/** A document with one flat map of `KEYS` keys below `field`. */
function flatMapDocument(header: string, field: string): string {
  const lines = [header, `${field}:`];
  for (let index = 0; index < KEYS; index += 1) lines.push(`  k${String(index).padStart(6, "0")}: 1`);
  return `${lines.join("\n")}\n`;
}

describe("guard policy and baseline YAML use a linear duplicate-key check", () => {
  it("policy: a flat map of many keys is parsed with at most one comparison per key", () => {
    resetCounters();
    const error = guardErrorOf(() => parseArchitecturePolicy(flatMapDocument("version: 1", "rules")));
    // The YAML parses; only the schema rejects a map where a rule list belongs.
    expect(error.code).toBe("guard/policy-invalid");
    expect(counters.defaultKeyCheckParses).toBe(0);
    expect(counters.keyComparisons).toBeLessThanOrEqual(KEYS + 2);
  });

  it("baseline: a flat map of many keys is parsed with at most one comparison per key", () => {
    resetCounters();
    const error = guardErrorOf(() => parseArchitectureBaseline(flatMapDocument("version: 1", "suppressions")));
    expect(error.code).toBe("guard/baseline-invalid");
    expect(counters.defaultKeyCheckParses).toBe(0);
    expect(counters.keyComparisons).toBeLessThanOrEqual(KEYS + 2);
  });

  it("a valid policy and baseline still parse", () => {
    const policy = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        '  - {id: r1, type: forbidden-dependency, from: "src/a/**", to: "src/b/**", edgeKinds: [IMPORTS], severity: error}',
        "  - {id: r2, type: no-cycles, severity: warning}",
        "",
      ].join("\n"),
    );
    expect(policy.rules.map((rule) => rule.id)).toEqual(["r1", "r2"]);
    const baseline = parseArchitectureBaseline(
      ['version: 1', "suppressions:", '  - {ruleId: r1, reason: "legacy", owner: "team", date: "2026-01-01"}', ""].join(
        "\n",
      ),
    );
    expect(baseline.suppressions.map((entry) => entry.ruleId)).toEqual(["r1"]);
  });
});

describe("guard YAML errors are the ones the library's default parse reports", () => {
  /** The guard's message for the first error of yaml's own default `parse` (code, line, column). */
  async function expectedFirstError(text: string): Promise<{ code: string; where: string }> {
    const actual = await vi.importActual<typeof import("yaml")>("yaml");
    try {
      actual.parse(text, { maxAliasCount: 0, logLevel: "error" });
    } catch (error) {
      if (error instanceof actual.YAMLParseError) {
        const position = error.linePos?.[0];
        return {
          code: error.code,
          where: position === undefined ? "" : ` at line ${String(position.line)}, column ${String(position.col)}`,
        };
      }
      throw error;
    }
    throw new Error("expected a YAML parse error");
  }

  const cases: ReadonlyArray<readonly [string, string]> = [
    ["top-level duplicate key", "version: 1\nrules: []\nrules: []\n"],
    ["duplicate key after many keys", `${flatMapDocument("version: 1", "rules").trimEnd()}\n  k000042: 2\n`],
    ["nested duplicate key", "version: 1\nrules:\n  - {id: a, id: b}\n"],
    ["duplicate quoted and plain key", 'version: 1\n"x": 1\nx: 2\n'],
    ["numeric keys", "version: 1\nm:\n  1: a\n  01: b\n"],
    ["flow syntax error", "version: 1\nrules: [x: a: b\n"],
    ["bad indentation", "version: 1\nrules:\n  - a\n - b\n"],
    ["tab indentation", "version: 1\nrules:\n\t- a\n"],
    ["multiple documents", "version: 1\nrules: []\n---\nx: 1\n"],
    ["unterminated quote", 'version: 1\nrules: "abc\n'],
  ];

  for (const [label, text] of cases) {
    it(`policy and baseline: ${label}`, async () => {
      const expected = await expectedFirstError(text);
      const policyError = guardErrorOf(() => parseArchitecturePolicy(text));
      expect(policyError.code).toBe("guard/policy-yaml-invalid");
      expect(policyError.message).toMatch(new RegExp(`^YAML could not be parsed: ${expected.code} \\(`));
      expect(policyError.message.endsWith(`)${expected.where}`)).toBe(true);

      const baselineError = guardErrorOf(() => parseArchitectureBaseline(text));
      expect(baselineError.code).toBe("guard/baseline-yaml-invalid");
      expect(baselineError.message).toBe(policyError.message);
    });
  }

  it("non-duplicate keys that only look alike are accepted, as by the default parse", () => {
    // `1` and `"1"` are different keys (number vs string), as are `null` and
    // `"null"`: the YAML parses and only the strict schema rejects the extra field.
    const error = guardErrorOf(() =>
      parseArchitecturePolicy('version: 1\nrules: []\nm: {1: a, "1": b, null: c, "null": d}\n'),
    );
    expect(error.code).toBe("guard/policy-invalid");
  });
});
