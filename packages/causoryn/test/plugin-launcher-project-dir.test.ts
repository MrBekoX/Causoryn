import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `plugin-mcp-launcher.mjs --project-dir <dir>` (security scan F2).
 *
 * A host now starts the launcher with the plugin root as its working
 * directory, so the bare `node` command is never resolved against the analyzed
 * repository. The project directory arrives as an argument instead. A usable
 * value becomes the server's working directory before the bundle loads, so
 * `--allow-cwd` checks it exactly as before; any other value is ignored with a
 * stderr note and the server starts where the host started it (then waits for
 * MCP roots/list). The flag is never forwarded to the server.
 */

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOLLAR_BRACE = "$" + "{";

let sandbox = "";
let launcher = "";
let pluginRoot = "";
let projectDir = "";

interface StubOutput {
  readonly argv: string[];
  readonly cwd: string;
}

function canonical(dir: string): string {
  return realpathSync.native(dir);
}

function runLauncher(args: readonly string[]): {
  readonly status: number | null;
  readonly stub: StubOutput | undefined;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: pluginRoot,
    encoding: "utf8",
    shell: false,
  });
  const stdout = result.stdout.trim();
  return {
    status: result.status,
    stub: stdout.length > 0 ? (JSON.parse(stdout) as StubOutput) : undefined,
    stderr: result.stderr,
  };
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "causoryn-launcher-project-dir-"));
  pluginRoot = path.join(sandbox, "plugin");
  projectDir = path.join(sandbox, "project");
  mkdirSync(path.join(pluginRoot, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ name: "causoryn", version: "0.2.0", type: "module" }),
    "utf8",
  );
  copyFileSync(
    path.join(PKG_DIR, "scripts", "plugin-mcp-launcher.mjs"),
    path.join(pluginRoot, "scripts", "plugin-mcp-launcher.mjs"),
  );
  for (const lib of ["node-version-guard.mjs", "asset-root.mjs"]) {
    copyFileSync(
      path.join(PKG_DIR, "scripts", "lib", lib),
      path.join(pluginRoot, "scripts", "lib", lib),
    );
  }
  // Stub server: reports the argv it received and the directory it runs in.
  writeFileSync(
    path.join(pluginRoot, "dist", "mcp-server.mjs"),
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
    "utf8",
  );
  writeFileSync(path.join(projectDir, "not-a-dir.txt"), "x", "utf8");
  launcher = path.join(pluginRoot, "scripts", "plugin-mcp-launcher.mjs");
});

afterAll(() => {
  if (sandbox.length > 0) rmSync(sandbox, { recursive: true, force: true });
});

describe("plugin-mcp-launcher --project-dir", () => {
  it("starts the server in a usable project directory and does not forward the flag", () => {
    for (const args of [
      ["--expected-version", "0.2.0", "--project-dir", projectDir, "--allow-cwd", "--client", "zcode"],
      ["--project-dir=" + projectDir, "--expected-version=0.2.0", "--allow-cwd", "--client", "zcode"],
    ]) {
      const run = runLauncher(args);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stub?.argv).toEqual(["mcp", "--allow-cwd", "--client", "zcode"]);
      expect(canonical(run.stub?.cwd ?? "")).toBe(canonical(projectDir));
      expect(run.stderr).not.toContain("--project-dir");
    }
  });

  it("ignores an unusable value, stays in the plugin root and says why on stderr", () => {
    const unusable: ReadonlyArray<[string, string]> = [
      ["empty", ""],
      ["unexpanded host variable", DOLLAR_BRACE + "ZCODE_PROJECT_DIR}"],
      ["relative path", path.join("relative", "project")],
      ["missing directory", path.join(sandbox, "does-not-exist")],
      ["file", path.join(projectDir, "not-a-dir.txt")],
      ["UNC path", "\\\\causoryn-unreachable-host\\share\\project"],
      ["forward-slash UNC path", "//causoryn-unreachable-host/share/project"],
    ];
    for (const [label, value] of unusable) {
      const run = runLauncher(["--project-dir", value, "--allow-cwd"]);
      expect(run.status, `${label}: ${run.stderr}`).toBe(0);
      expect(run.stub?.argv, label).toEqual(["mcp", "--allow-cwd"]);
      expect(canonical(run.stub?.cwd ?? ""), label).toBe(canonical(pluginRoot));
      expect(run.stderr, label).toContain("--project-dir ignored");
    }
  });

  it("does not consume a following flag when the value is missing", () => {
    const flagNext = runLauncher(["--project-dir", "--allow-cwd", "--auto-data-dir"]);
    expect(flagNext.status, flagNext.stderr).toBe(0);
    expect(flagNext.stub?.argv).toEqual(["mcp", "--allow-cwd", "--auto-data-dir"]);
    expect(canonical(flagNext.stub?.cwd ?? "")).toBe(canonical(pluginRoot));
    expect(flagNext.stderr).toContain("--project-dir ignored");

    const atEnd = runLauncher(["--allow-cwd", "--project-dir"]);
    expect(atEnd.status, atEnd.stderr).toBe(0);
    expect(atEnd.stub?.argv).toEqual(["mcp", "--allow-cwd"]);
    expect(canonical(atEnd.stub?.cwd ?? "")).toBe(canonical(pluginRoot));
    expect(atEnd.stderr).toContain("--project-dir ignored");
  });

  it("still fails closed on a version mismatch before changing directory", () => {
    const run = runLauncher(["--expected-version", "9.9.9", "--project-dir", projectDir]);
    expect(run.status).toBe(2);
    expect(run.stub).toBeUndefined();
    expect(run.stderr).toContain("version mismatch");
  });
});
