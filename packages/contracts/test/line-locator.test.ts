import { describe, expect, it } from "vitest";

import { createLineLocator } from "../src/spec-index.js";

/** Reference: the per-lookup newline count the line table replaces (CAU-04). */
function naiveLine(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

describe("createLineLocator", () => {
  it("matches a naive newline count for every offset, including out-of-range ones", () => {
    const texts = ["", "a", "\n", "a\nb", "a\r\nb\r\n", "\n\n\nx\n", "no newline at all", "x\ny\n\nz", "\r\r\n\n"];
    for (const text of texts) {
      const lineAt = createLineLocator(text);
      for (let offset = -2; offset <= text.length + 2; offset += 1) {
        expect(lineAt(offset)).toBe(naiveLine(text, offset));
      }
      expect(lineAt(Number.NaN)).toBe(naiveLine(text, Number.NaN));
      expect(lineAt(Number.POSITIVE_INFINITY)).toBe(naiveLine(text, Number.POSITIVE_INFINITY));
    }
  });

  it("answers offsets of a large text consistently with the naive count", () => {
    const text = Array.from({ length: 5000 }, (_, index) => `line ${String(index)}`).join("\n");
    const lineAt = createLineLocator(text);
    for (let offset = 0; offset <= text.length; offset += 997) {
      expect(lineAt(offset)).toBe(naiveLine(text, offset));
    }
    expect(lineAt(text.length)).toBe(5000);
  });
});
