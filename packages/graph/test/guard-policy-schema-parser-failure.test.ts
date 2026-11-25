import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GuardError,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
} from "../src/guard-policy-schema.js";

/**
 * Any failure of the YAML parser, not only YAMLParseError and alias
 * ReferenceErrors, must surface as the guard's own YAML error code (mapped to
 * POLICY_INVALID by the MCP layer) and must not carry the original message.
 */
const failure = vi.hoisted(() => ({ next: undefined as Error | undefined }));

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  const parse = ((...args: Parameters<typeof actual.parse>) => {
    const error = failure.next;
    failure.next = undefined;
    if (error !== undefined) throw error;
    return actual.parse(...args);
  }) as typeof actual.parse;
  return { ...actual, default: { ...actual, parse }, parse };
});

afterEach(() => {
  failure.next = undefined;
});

const MARKER = "PARSER_INTERNAL_DETAIL_91C2";

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

describe("guard policy parsing maps unexpected parser failures", () => {
  for (const make of [
    () => new RangeError(`Maximum call stack size exceeded ${MARKER}`),
    () => new TypeError(`unexpected ${MARKER}`),
  ]) {
    it(`policy: ${make().name} → guard/policy-yaml-invalid without the original message`, () => {
      failure.next = make();
      const error = guardErrorOf(() => parseArchitecturePolicy("version: 1\nrules: []\n"));
      expect(error.code).toBe("guard/policy-yaml-invalid");
      expect(error.message).not.toContain(MARKER);
    });

    it(`baseline: ${make().name} → guard/baseline-yaml-invalid without the original message`, () => {
      failure.next = make();
      const error = guardErrorOf(() =>
        parseArchitectureBaseline("version: 1\nsuppressions: []\n"),
      );
      expect(error.code).toBe("guard/baseline-yaml-invalid");
      expect(error.message).not.toContain(MARKER);
    });
  }

  it("the unmocked parser path still works", () => {
    expect(parseArchitecturePolicy("version: 1\nrules: []\n").rules).toEqual([]);
  });
});
