import { TIMELINE_MAX_REFS } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import { ArchitectureTimelineToolInputSchema } from "../src/schemas.js";

/**
 * MCP tool input bounds: every free-form string and array accepted by a tool
 * has a finite upper bound, so a single call cannot make the server do
 * unbounded work (e.g. one git process per timeline ref) or hold unbounded
 * input in memory.
 */

describe("causoryn_architecture_timeline input bounds", () => {
  const refsOf = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `v${String(index)}`);

  it("accepts up to TIMELINE_MAX_REFS refs and rejects one more at the schema boundary", () => {
    expect(
      ArchitectureTimelineToolInputSchema.safeParse({ refs: refsOf(TIMELINE_MAX_REFS) }).success,
    ).toBe(true);
    expect(
      ArchitectureTimelineToolInputSchema.safeParse({ refs: refsOf(TIMELINE_MAX_REFS + 1) })
        .success,
    ).toBe(false);
  });
});
