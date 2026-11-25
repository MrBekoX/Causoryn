import { describe, expect, it } from "vitest";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  TOOL_ERROR_GUIDANCE,
  toolErrorGuidance,
} from "../packages/mcp-server/src/errors.js";
import { createCausorynContext, errorEnvelope, CausorynToolError } from "@causoryn/mcp-server";

describe("Task 1.6d — mcp-server errors.ts guidance honesty and English surface", () => {
  it("WORKSPACE_NOT_AUTHORIZED guidance never suggests nonexistent 'causoryn workspace authorize' and lists real authorization methods", () => {
    const guidance = toolErrorGuidance("WORKSPACE_NOT_AUTHORIZED");
    expect(guidance.retryable).toBe(false);
    expect(guidance.userAction).not.toContain("causoryn workspace authorize");
    expect(guidance.userAction).toContain("--root");
    expect(guidance.userAction).toContain("--allow-cwd");
    expect(guidance.userAction).toContain("roots/list");
    expect(guidance.userAction).toContain("CAUSORYN_CONFIG");
    expect(guidance.userAction).toContain("allowRoots");
  });

  it("provides clear, concise English guidance for every error code while preserving retryable contracts", () => {
    const turkishChars = /[ğüşöçıİĞÜŞÖÇ]/;
    const internalJargon = /TŞ\s*§|K-\d{3}/;

    for (const code of CAUSORYN_TOOL_ERROR_CODES) {
      const entry = TOOL_ERROR_GUIDANCE[code];
      expect(entry, `missing guidance for ${code}`).toBeDefined();
      expect(entry.userAction.trim().length).toBeGreaterThan(10);
      expect(
        turkishChars.test(entry.userAction),
        `${code} guidance contains Turkish characters: ${entry.userAction}`,
      ).toBe(false);
      expect(
        internalJargon.test(entry.userAction),
        `${code} guidance leaks internal spec code: ${entry.userAction}`,
      ).toBe(false);
      expect(toolErrorGuidance(code)).toEqual(entry);
    }

    // Retryable contract preserved
    expect(toolErrorGuidance("INDEX_NOT_READY").retryable).toBe(true);
    expect(toolErrorGuidance("INTERNAL_ERROR").retryable).toBe(true);
    for (const code of CAUSORYN_TOOL_ERROR_CODES) {
      if (code !== "INDEX_NOT_READY" && code !== "INTERNAL_ERROR") {
        expect(toolErrorGuidance(code).retryable, `${code} should not be retryable`).toBe(false);
      }
    }
  });

  it("errorEnvelope attaches honest English WORKSPACE_NOT_AUTHORIZED guidance", () => {
    const ctx = createCausorynContext({ workspaceId: "default", allowRoots: [], autoIndex: false });
    try {
      const env = errorEnvelope(
        "req-err-1",
        ctx.config.workspaceId,
        null,
        new CausorynToolError("WORKSPACE_NOT_AUTHORIZED", "workspace root not authorized"),
      );
      expect(env.status).toBe("error");
      expect(env.error?.code).toBe("WORKSPACE_NOT_AUTHORIZED");
      expect(env.error?.userAction).not.toContain("causoryn workspace authorize");
      expect(env.error?.userAction).toContain("--root");
      expect(env.error?.userAction).toContain("--allow-cwd");
      expect(env.error?.userAction).toContain("roots/list");
      expect(env.error?.userAction).toContain("CAUSORYN_CONFIG");
    } finally {
      ctx.close();
    }
  });
});
