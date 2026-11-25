import { describe, expect, it } from "vitest";

import { EDGE_KINDS } from "@causoryn/domain";

import {
  GuardError,
  MAX_BASELINE_SUPPRESSIONS,
  MAX_GUARD_IDENTIFIER_LENGTH,
  MAX_GUARD_TEXT_LENGTH,
  MAX_POLICY_RULES,
  MAX_REPORTED_SCHEMA_ISSUES,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
} from "../src/guard-policy-schema.js";

/**
 * Resource and disclosure bounds of the Architecture Guard policy DSL
 * (TŞ §12 policy file, TŞ §19 untrusted repository input, TŞ §20 budgets):
 * YAML parse errors carry position and a generic reason but no source text,
 * YAML aliases are rejected as a policy error, and list sizes, string
 * lengths and the reported schema issues are capped.
 */

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

function policyYaml(rules: readonly string[]): string {
  return ["version: 1", "rules:", ...rules].join("\n") + "\n";
}

function forbiddenRule(id: string): string {
  return `  - {id: ${id}, type: forbidden-dependency, from: "src/a/**", to: "src/b/**", edgeKinds: [IMPORTS], severity: error}`;
}

function baselineYaml(entries: readonly string[]): string {
  return ["version: 1", "suppressions:", ...entries].join("\n") + "\n";
}

function suppression(ruleId: string, overrides: { reason?: string; owner?: string } = {}): string {
  const reason = overrides.reason ?? "legacy";
  const owner = overrides.owner ?? "team";
  return `  - {ruleId: ${ruleId}, reason: "${reason}", owner: "${owner}", date: "2026-01-01"}`;
}

const MARKER = "CONFIDENTIAL_MARKER_7F3A";

describe("guard policy YAML errors do not echo source text", () => {
  it("policy syntax error → guard/policy-yaml-invalid with code, line and column only", () => {
    const error = guardErrorOf(() =>
      parseArchitecturePolicy(`version: 1\nrules: [${MARKER}: a: b\n`),
    );
    expect(error.code).toBe("guard/policy-yaml-invalid");
    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain("rules: [");
    expect(error.message).toMatch(/line 2, column \d+/);
    expect(error.message).toContain("BLOCK_IN_FLOW");
  });

  it("baseline syntax error → guard/baseline-yaml-invalid with code, line and column only", () => {
    const error = guardErrorOf(() =>
      parseArchitectureBaseline(`version: 1\n${MARKER}: x: y\n`),
    );
    expect(error.code).toBe("guard/baseline-yaml-invalid");
    expect(error.message).not.toContain(MARKER);
    expect(error.message).toMatch(/line 2, column \d+/);
  });

  it("duplicate keys and multiple documents are reported without source text", () => {
    const duplicate = guardErrorOf(() =>
      parseArchitecturePolicy(`version: 1\n${MARKER}: 1\n${MARKER}: 2\n`),
    );
    expect(duplicate.code).toBe("guard/policy-yaml-invalid");
    expect(duplicate.message).not.toContain(MARKER);
    expect(duplicate.message).toContain("DUPLICATE_KEY");

    const multiple = guardErrorOf(() =>
      parseArchitecturePolicy(`version: 1\nrules: []\n---\n${MARKER}: 1\n`),
    );
    expect(multiple.code).toBe("guard/policy-yaml-invalid");
    expect(multiple.message).not.toContain(MARKER);
  });

  it("deeply nested input → guard/policy-yaml-invalid (RESOURCE_EXHAUSTION) without source text", () => {
    const depth = 20_000;
    const error = guardErrorOf(() =>
      parseArchitecturePolicy(`version: 1\n${MARKER}: ${"[".repeat(depth)}${"]".repeat(depth)}\n`),
    );
    expect(error.code).toBe("guard/policy-yaml-invalid");
    expect(error.message).toContain("RESOURCE_EXHAUSTION");
    expect(error.message).not.toContain("[[");
    expect(error.message).not.toContain(MARKER);
  });
});

describe("guard policy YAML aliases are rejected as a policy error", () => {
  const aliasCases: ReadonlyArray<readonly [string, string]> = [
    ["resolvable alias", `version: 1\nshared: &${MARKER} []\nrules: *${MARKER}\n`],
    ["unresolved alias", `version: 1\nrules: *${MARKER}\n`],
    [
      "nested alias expansion",
      [
        "version: 1",
        "a: &a [x, x, x, x, x, x, x, x, x]",
        "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
        "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
        "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
        "rules: *d",
        "",
      ].join("\n"),
    ],
  ];

  for (const [label, text] of aliasCases) {
    it(`policy: ${label} → guard/policy-yaml-invalid (not a ReferenceError)`, () => {
      const error = guardErrorOf(() => parseArchitecturePolicy(text));
      expect(error.code).toBe("guard/policy-yaml-invalid");
      expect(error.message).not.toContain(MARKER);
      expect(error.message).toMatch(/alias/i);
    });

    it(`baseline: ${label} → guard/baseline-yaml-invalid (not a ReferenceError)`, () => {
      const error = guardErrorOf(() =>
        parseArchitectureBaseline(text.replace("rules:", "suppressions:")),
      );
      expect(error.code).toBe("guard/baseline-yaml-invalid");
      expect(error.message).not.toContain(MARKER);
    });
  }

  it("an anchor without any alias is still accepted", () => {
    const policy = parseArchitecturePolicy(`version: 1\nrules: &all []\n`);
    expect(policy.rules).toEqual([]);
  });
});

describe("guard policy list caps", () => {
  it(`accepts exactly ${String(500)} rules and rejects one more`, () => {
    expect(MAX_POLICY_RULES).toBe(500);
    const rules = Array.from({ length: MAX_POLICY_RULES }, (_, i) => forbiddenRule(`r${String(i)}`));
    expect(parseArchitecturePolicy(policyYaml(rules)).rules).toHaveLength(MAX_POLICY_RULES);

    const error = guardErrorOf(() =>
      parseArchitecturePolicy(policyYaml([...rules, forbiddenRule("one-more")])),
    );
    expect(error.code).toBe("guard/policy-invalid");
    expect(error.message).toContain(String(MAX_POLICY_RULES));
  });

  it(`accepts exactly ${String(1000)} suppressions and rejects one more`, () => {
    expect(MAX_BASELINE_SUPPRESSIONS).toBe(1000);
    const entries = Array.from({ length: MAX_BASELINE_SUPPRESSIONS }, (_, i) =>
      suppression(`r${String(i)}`),
    );
    expect(parseArchitectureBaseline(baselineYaml(entries)).suppressions).toHaveLength(
      MAX_BASELINE_SUPPRESSIONS,
    );

    const error = guardErrorOf(() =>
      parseArchitectureBaseline(baselineYaml([...entries, suppression("one-more")])),
    );
    expect(error.code).toBe("guard/baseline-invalid");
    expect(error.message).toContain(String(MAX_BASELINE_SUPPRESSIONS));
  });

  it("edgeKinds may list every edge kind once but not more entries than there are kinds", () => {
    const all = EDGE_KINDS.join(", ");
    const ok = parseArchitecturePolicy(
      policyYaml([`  - {id: c, type: no-cycles, edgeKinds: [${all}], severity: error}`]),
    );
    expect(ok.rules[0]?.edgeKinds).toHaveLength(EDGE_KINDS.length);

    const tooMany = `${all}, CALLS`;
    expect(
      guardErrorOf(() =>
        parseArchitecturePolicy(
          policyYaml([`  - {id: c, type: no-cycles, edgeKinds: [${tooMany}], severity: error}`]),
        ),
      ).code,
    ).toBe("guard/policy-invalid");
    expect(
      guardErrorOf(() =>
        parseArchitecturePolicy(
          policyYaml([
            `  - {id: f, type: forbidden-dependency, from: "a/**", to: "b/**", edgeKinds: [${tooMany}], severity: error}`,
          ]),
        ),
      ).code,
    ).toBe("guard/policy-invalid");
  });
});

describe("guard policy string length caps", () => {
  it(`rule id: ${String(256)} characters accepted, one more rejected`, () => {
    expect(MAX_GUARD_IDENTIFIER_LENGTH).toBe(256);
    const id = "r".repeat(MAX_GUARD_IDENTIFIER_LENGTH);
    expect(parseArchitecturePolicy(policyYaml([forbiddenRule(id)])).rules[0]?.id).toBe(id);
    expect(guardErrorOf(() => parseArchitecturePolicy(policyYaml([forbiddenRule(`${id}r`)]))).code).toBe(
      "guard/policy-invalid",
    );
  });

  it(`description: ${String(2048)} characters accepted, one more rejected`, () => {
    expect(MAX_GUARD_TEXT_LENGTH).toBe(2048);
    const rule = (description: string): string =>
      `  - {id: c, type: no-cycles, severity: info, description: "${description}"}`;
    const text = "d".repeat(MAX_GUARD_TEXT_LENGTH);
    expect(parseArchitecturePolicy(policyYaml([rule(text)])).rules[0]?.description).toBe(text);
    expect(guardErrorOf(() => parseArchitecturePolicy(policyYaml([rule(`${text}d`)]))).code).toBe(
      "guard/policy-invalid",
    );
  });

  it("suppression ruleId, owner and reason are capped", () => {
    const longId = "r".repeat(MAX_GUARD_IDENTIFIER_LENGTH + 1);
    const longOwner = "o".repeat(MAX_GUARD_IDENTIFIER_LENGTH + 1);
    const longReason = "x".repeat(MAX_GUARD_TEXT_LENGTH + 1);
    for (const entry of [
      suppression(longId),
      suppression("r1", { owner: longOwner }),
      suppression("r1", { reason: longReason }),
    ]) {
      expect(guardErrorOf(() => parseArchitectureBaseline(baselineYaml([entry]))).code).toBe(
        "guard/baseline-invalid",
      );
    }
    const atLimit = suppression("r".repeat(MAX_GUARD_IDENTIFIER_LENGTH), {
      owner: "o".repeat(MAX_GUARD_IDENTIFIER_LENGTH),
      reason: "x".repeat(MAX_GUARD_TEXT_LENGTH),
    });
    expect(parseArchitectureBaseline(baselineYaml([atLimit])).suppressions).toHaveLength(1);
  });
});

describe("guard policy schema errors stay bounded", () => {
  it(`reports at most ${String(20)} issues and states how many were omitted`, () => {
    expect(MAX_REPORTED_SCHEMA_ISSUES).toBe(20);
    const rules = Array.from(
      { length: 200 },
      (_, i) => `  - {id: r${String(i)}, type: no-cycles, severity: critical}`,
    );
    const error = guardErrorOf(() => parseArchitecturePolicy(policyYaml(rules)));
    expect(error.code).toBe("guard/policy-invalid");
    expect(error.issues).toHaveLength(MAX_REPORTED_SCHEMA_ISSUES);
    expect(error.message).toContain("180 more issue");
  });

  it("truncates an oversized issue text (e.g. a very long unknown key)", () => {
    const longKey = "k".repeat(20_000);
    const error = guardErrorOf(() =>
      parseArchitecturePolicy(`version: 1\nrules: []\n? ${longKey}\n: 1\n`),
    );
    expect(error.code).toBe("guard/policy-invalid");
    expect(error.message.length).toBeLessThan(1_000);
  });
});
