import { describe, expect, it } from "vitest";

import { ContractDiscoveryError, discoverContractsFromTexts } from "../src/index.js";

/**
 * A spec that fails to parse must not echo its source text: the YAML
 * library's default message quotes the offending lines, and that text reaches
 * the agent (CONTRACT_PARSE_FAILED) and the server log. Config files such as
 * appsettings.json can hold credentials on exactly those lines, so the error
 * carries the error code and the position only.
 */
const CANARY = "QZXCANARY_7731";

function errorOf(relativePath: string, text: string): ContractDiscoveryError {
  try {
    discoverContractsFromTexts("w_redaction", [{ relativePath, text }]);
  } catch (error) {
    if (error instanceof ContractDiscoveryError) return error;
    throw error;
  }
  throw new Error("expected a ContractDiscoveryError");
}

describe("contract spec parse errors — no source text in the message", () => {
  it("a malformed JSON spec reports code and position without the offending line", () => {
    const text = `{\n  "$schema": "https://json-schema.org/draft/2020-12/schema",\n  "ConnectionStrings": { "Db": "Server=db;Password=${CANARY}", }\n  oops\n}\n`;
    const error = errorOf("config/appsettings.json", text);
    expect(error.code).toBe("contracts/spec-json-invalid");
    expect(error.message).not.toContain(CANARY);
    expect(error.message).not.toContain("Password");
    expect(error.message).toMatch(/line \d+, column \d+/);
  });

  it("a malformed YAML spec (sniff path) reports code and position without the offending line", () => {
    // The canary sits on the line the parser rejects (an unterminated flow mapping).
    const text = `openapi: 3.1.0\ninfo:\n  title: api\nx-config: { token: ${CANARY}, broken\n`;
    const error = errorOf("specs/openapi.yaml", text);
    expect(error.code).toBe("contracts/spec-yaml-invalid");
    expect(error.message).not.toContain(CANARY);
    expect(error.message).toMatch(/line \d+, column \d+/);
    expect(error.message.startsWith("specs/openapi.yaml: ")).toBe(true);
  });
});
