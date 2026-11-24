import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeTypeScriptProgram } from "../src/index.js";

/**
 * Windows can hand out 8.3 short names for directories (GitHub's Windows
 * runners report `os.tmpdir()` as `C:\Users\RUNNER~1\...`). TypeScript
 * realpaths resolved module files to their long name, so a workspace root
 * given by its short name must still accept modules resolved under its long
 * name — otherwise every `node_modules` import becomes a false TS2307.
 */
function shortNameOf(longPath: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = spawnSync(
      process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    )
      .stdout.trim()
      .replace(/^"|"$/g, "");
    // 8.3 names can be disabled per volume; then there is nothing to test.
    return out.length > 0 && !out.includes('"') && out.toLowerCase() !== longPath.toLowerCase()
      ? out
      : null;
  } catch {
    return null;
  }
}

describe("TypeScript analysis with a Windows 8.3 short-name workspace root", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "causoryn-short-"));
  const longRoot = path.join(base, "LongWorkspaceDirectoryName");
  mkdirSync(path.join(longRoot, "node_modules", "fake-dep"), { recursive: true });
  const shortRoot = shortNameOf(longRoot);

  it.skipIf(shortRoot === null)("resolves node_modules types without a false TS2307", () => {
    try {
      writeFileSync(
        path.join(longRoot, "node_modules", "fake-dep", "package.json"),
        JSON.stringify({ name: "fake-dep", version: "1.0.0", types: "./index.d.ts" }),
        "utf8",
      );
      writeFileSync(
        path.join(longRoot, "node_modules", "fake-dep", "index.d.ts"),
        "export declare function greet(name: string): string;\n",
        "utf8",
      );
      const result = analyzeTypeScriptProgram({
        workspaceId: "ws_short_root",
        rootDir: shortRoot as string,
        configFiles: [],
        sources: [
          {
            relativePath: "src/app.ts",
            content: 'import { greet } from "fake-dep";\nexport const hello = greet("x");\n',
          },
        ],
      });
      expect(result.diagnostics).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
