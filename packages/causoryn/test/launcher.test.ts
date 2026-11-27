import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * F20 review round 4: how scripts/causoryn.cmd starts node.
 *
 * Worker threads inherit the node options of the process that starts them
 * (process.execArgv). The CLI indexes in worker threads, so a node option on
 * the launcher's command line (round 3 passed `--input-type=commonjs`, and
 * every Worker failed with ERR_INPUT_TYPE_NOT_ALLOWED) breaks indexing.
 * The launcher therefore passes node no option except the `-e` of its POSIX
 * branch, and these tests run that exact command to check that the CLI it
 * starts can start worker threads.
 */

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(PKG_DIR, "scripts", "causoryn.cmd");
const LINES = readFileSync(LAUNCHER, "utf8").split("\n");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** The words between `exec "$n"` and `-- "$0" "$@"` in the POSIX branch (sh single quotes or bare words). */
function posixNodeWords(): string[] {
  const execLines = LINES.filter((line) => line.startsWith(":;") && /\bexec\b/.test(line));
  expect(execLines).toHaveLength(1);
  const match = /^:; exec "\$n" (.*) -- "\$0" "\$@" #$/.exec(execLines[0] as string);
  expect(match, execLines[0]).not.toBeNull();
  const words: string[] = [];
  for (const word of (match as RegExpExecArray)[1]?.matchAll(/'([^']*)'|(\S+)/g) ?? []) words.push(word[1] ?? word[2] ?? "");
  return words;
}

/** A package with the shipped launcher and a CLI that starts a worker thread (both call shapes the bundle uses). */
function workerPackage(cli: "worker" | "plain"): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-launcher-"));
  dirs.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(LAUNCHER, path.join(root, "scripts", "causoryn.cmd"));
  writeFileSync(path.join(root, "scripts", "worker.mjs"), 'import { parentPort } from "node:worker_threads";\nparentPort.postMessage("OK");\n');
  writeFileSync(
    path.join(root, "scripts", "causoryn.mjs"),
    cli === "plain"
      ? 'console.log("CLI " + JSON.stringify(process.argv.slice(2)));\n'
      : [
          'import { Worker } from "node:worker_threads";',
          'import { fileURLToPath } from "node:url";',
          'const entry = new URL("./worker.mjs", import.meta.url);',
          "for (const target of [entry, fileURLToPath(entry)]) {",
          "  const worker = new Worker(target);",
          '  worker.on("message", (m) => console.log("WORKER " + m + " " + JSON.stringify(process.argv.slice(2))));',
          '  worker.on("error", (e) => { console.log("WORKER-ERROR " + (e.code ?? e.message)); process.exitCode = 3; });',
          "}",
          "",
        ].join("\n"),
  );
  return path.join(root, "scripts", "causoryn.cmd");
}

describe("launcher: node options", () => {
  it("the POSIX branch passes node no option but -e", () => {
    const words = posixNodeWords();
    expect(words).toHaveLength(2);
    expect(words[0]).toBe("-e");
  });

  it("the CLI the POSIX branch starts can start worker threads", () => {
    const launcher = workerPackage("worker");
    const run = spawnSync(process.execPath, [...posixNodeWords(), "--", launcher, "mcp", "a b"], { encoding: "utf8" });
    expect(run.stdout, run.stderr).not.toContain("WORKER-ERROR");
    expect(run.stdout.match(/^WORKER OK \["mcp","a b"\]$/gm)).toHaveLength(2);
    expect(run.status).toBe(0);
  });

  it("the POSIX branch's eval code also runs when node evaluates it as an ES module", () => {
    const launcher = workerPackage("plain");
    const run = spawnSync(process.execPath, ["--input-type=module", ...posixNodeWords(), "--", launcher, "--flag"], { encoding: "utf8" });
    expect(run.stdout, run.stderr).toContain('CLI ["--flag"]');
  });

  // Review round 5 (B3): `for /f ... in ('command')` runs the command through %COMSPEC% /c without /d, so the
  // user's cmd.exe AutoRun would run on every start (npm and cmd-shim pass /d on purpose).
  it("the Windows branch starts no cmd.exe of its own (no for /f over a command)", () => {
    expect(LINES.filter((line) => /\bfor\s+\/f\b[^\n]*\bin\s*\(\s*'/i.test(line))).toEqual([]);
    expect(LINES.filter((line) => /%COMSPEC%\s*\/c|\bcmd(\.exe)?\s+\/c/i.test(line))).toEqual([]);
  });

  it("the Windows branch passes node no option and never puts %* on a command line", () => {
    // %* only in the REM lines of the captures (a parse probe of each, then each capture).
    const withArgs = LINES.filter((line) => line.includes("%*"));
    const hash = "  for %%# in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV";
    const bracket = "  for %%] in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV";
    expect(withArgs).toEqual([hash, bracket, hash, bracket]);
    const nodeLines = LINES.filter((line) => line.includes('"%CAUSORYN_NODE%"'));
    expect(nodeLines.length).toBeGreaterThan(0);
    for (const line of nodeLines) {
      expect(line).toMatch(
        /"%CAUSORYN_NODE%" "%~dp0lib\\windows-argv\.mjs" --(lock "%CAUSORYN_ARGV_ROOT%" "%CAUSORYN_TOKEN%"|launch "%CAUSORYN_ARGV_DIR%")( \|\| \(|$)/,
      );
    }
    expect(nodeLines.at(-1)).toMatch(/--launch "%CAUSORYN_ARGV_DIR%"$/);
  });
});
