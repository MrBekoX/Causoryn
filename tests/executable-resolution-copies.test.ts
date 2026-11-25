/**
 * The absolute-executable resolver exists in three self-contained copies
 * (packages that must not depend on each other). Their code below the
 * header comment must stay identical, and the child-environment helper
 * behaves the same in each.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as cliCopy from "../packages/causoryn/src/executable-resolution.js";
import * as graphCopy from "../packages/graph/src/executable-resolution.js";
import * as sidecarCopy from "../packages/sidecar-ipc/src/executable.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [
  "packages/sidecar-ipc/src/executable.ts",
  "packages/graph/src/executable-resolution.ts",
  "packages/causoryn/src/executable-resolution.ts",
] as const;

/** Source text after the leading header comment, with normalized line endings. */
function codeBelowHeader(relativePath: string): string {
  const text = readFileSync(path.join(REPO_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");
  const headerEnd = text.indexOf("*/\n");
  expect(text.startsWith("/**")).toBe(true);
  expect(headerEnd).toBeGreaterThan(0);
  return text.slice(headerEnd + 3);
}

describe("executable resolver copies", () => {
  it("are identical below their header comment", () => {
    const [reference, ...others] = COPIES.map((copy) => codeBelowHeader(copy));
    for (const [index, other] of others.entries()) {
      expect(other, `${COPIES[index + 1]} differs from ${COPIES[0]}`).toBe(reference);
    }
  });

  for (const [label, impl] of [
    ["sidecar-ipc", sidecarCopy],
    ["graph copy", graphCopy],
    ["cli copy", cliCopy],
  ] as const) {
    it(`withoutCwdExecutableSearch (${label}) sets NoDefaultCurrentDirectoryInExePath=1 on win32 only and never mutates its input`, () => {
      const input = { PATH: "C:\\tools", nodefaultcurrentdirectoryinexepath: "0" };
      const win = impl.withoutCwdExecutableSearch(input, "win32");
      expect(win).toEqual({ PATH: "C:\\tools", NoDefaultCurrentDirectoryInExePath: "1" });
      expect(input).toEqual({ PATH: "C:\\tools", nodefaultcurrentdirectoryinexepath: "0" });
      const posix = impl.withoutCwdExecutableSearch({ PATH: "/usr/bin" }, "linux");
      expect(posix).toEqual({ PATH: "/usr/bin" });
    });
  }
});
