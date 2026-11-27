import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * F20 review round 4: the Windows half of scripts/causoryn.cmd.
 *
 * cmd-shim's shim is a batch level, npm escapes the arguments for exactly
 * that level, and the launcher is one level more. So the launcher never puts
 * `%*` on a command line again: it echoes `%*` unparsed (a REM line in a FOR
 * body, echo on) into two files, in UTF-8 (chcp 65001), and node takes the
 * arguments from those files. A FOR body expands references to its own
 * variable (`%#`, `%~f#`, `%~$X:#`), so the two captures use different
 * variables (`#` and `]`): a reference to either variable stays literal in
 * the other capture, so the captures are used only when they are identical and
 * contain no `%~`, `%#` or `%]`; then both equal the text cmd.exe received.
 * The text is split as the C runtime splits a command line, which is what
 * node.exe did with the same text when the bin was a `#!/usr/bin/env node`
 * script.
 */

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "windows-argv.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  capturedTail(text: string): string | null;
  forReferenceIn(tail: string): string | null;
  parseWindowsArguments(tail: string): string[];
  argumentsFromCaptures(dir: string): { ok: true; args: string[] } | { ok: false; message: string };
  removeStaleCaptures(root: string, options?: { maxAgeMs?: number }): string[];
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A capture as cmd.exe writes it (prompt `#`, echoed REM line, trailing space). */
const capture = (tail: string): string => `\r\n#rem CAUSORYN-ARGV: ${tail}:CAUSORYN-ARGV \r\n`;

function captureDir(first: string, second: string = first): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "argv-hash.txt"), first, "utf8");
  writeFileSync(path.join(dir, "argv-bracket.txt"), second, "utf8");
  return dir;
}

describe("windows-argv: reading the captures", () => {
  it("reads the text between the markers exactly, also when it contains a marker", () => {
    expect(mod.capturedTail(capture('mcp "a b" --x'))).toBe('mcp "a b" --x');
    expect(mod.capturedTail(capture(""))).toBe("");
    expect(mod.capturedTail(capture("x:CAUSORYN-ARGV y"))).toBe("x:CAUSORYN-ARGV y");
    expect(mod.capturedTail(capture("＂&＂ “”„ ʺ ″ 日本語 Çağrı /? a/?b"))).toBe("＂&＂ “”„ ʺ ″ 日本語 Çağrı /? a/?b");
    expect(mod.capturedTail("Records comments (remarks) in a batch file\r\n")).toBeNull();
  });

  it.each([
    ["%~$X&echo,INJECTED&:#", "%~"],
    ["%~f#", "%~"],
    ["%#", "%#"],
    ["%]", "%]"],
    ["x%~dpa", "%~"],
    ["%a %PATH% 50% %%", null],
    ["plain", null],
  ])("FOR variable references in %s → %s", (tail, found) => {
    expect(mod.forReferenceIn(tail)).toBe(found);
  });

  it("uses identical, reference-free captures", () => {
    const dir = captureDir(capture('mcp "a b" a&b ＂&＂'));
    expect(mod.argumentsFromCaptures(dir)).toEqual({ ok: true, args: ["mcp", "a b", "a&b", "＂&＂"] });
  });

  it.each([
    ["captures that differ (a FOR reference was expanded in one)", capture("1"), capture("%#"), /contains %#/],
    ["a %~ reference", capture("%~$X&echo,INJECTED&:a"), undefined, /contains %~/],
    // Review round 5: captures that differ without a reference (written in different code pages) are not called a FOR reference.
    ["captures that differ without a reference", capture("日本語"), capture("???"), /captures of the arguments differ/],
    ["a missing capture line", "Records comments (remarks)\r\n", undefined, /could not read back/],
  ])("refuses %s", (_label, first, second, message) => {
    const dir = captureDir(first, second);
    const result = mod.argumentsFromCaptures(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/^causoryn: refusing to start/);
      expect(result.message).toMatch(message);
    }
  });

  it("refuses when a capture file is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "sub"));
    expect(mod.argumentsFromCaptures(dir).ok).toBe(false);
  });
});

describe("windows-argv: splitting like the C runtime", () => {
  it.each([
    ['a b "c d" e', ["a", "b", "c d", "e"]],
    ['"a\\"b"', ['a"b']],
    ['a\\\\b', ["a\\\\b"]],
    ['"a\\\\" b', ["a\\", "b"]],
    ['a\\\\\\"b', ['a\\"b']],
    ['"" x', ["", "x"]],
    ['"a""b"', ['a"b']],
    ["  lead\ttab  ", ["lead", "tab"]],
    ['"unterminated arg', ["unterminated arg"]],
  ])("%s", (tail, expected) => {
    expect(mod.parseWindowsArguments(tail)).toEqual(expected);
  });

  // Differential check against node.exe itself on the same command-line text.
  const CORPUS = [
    'mcp --allow-cwd --auto-data-dir',
    '"a b" "a\\"b" "tab\tx" "trail\\\\" "\\\\\\"q" "" x',
    'a"b"c "d""e" "f"""g" h\\"i \\\\"j k"',
    '"c:\\dir with space\\\\" ＂&＂ 日本語 "Çağrı ğüşöıİ"',
    'x\\\\\\\\"y z" \\" "\\\\\\\\"',
  ];
  it.runIf(process.platform === "win32").each(CORPUS)("matches node.exe for %s", (tail) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-node-"));
    dirs.push(dir);
    const script = path.join(dir, "argv.cjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const run = spawnSync(process.execPath, [`"${script}"`, tail], { windowsVerbatimArguments: true, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(mod.parseWindowsArguments(tail)).toEqual(JSON.parse(run.stdout) as string[]);
  });
});

/**
 * Review round 5: the launcher serializes its code page window with a lock
 * directory (`<root>\lock`, taken by `--lock`), and removes capture
 * directories that a start which never reached `--launch` left behind.
 */
describe("windows-argv: the console lock and stale captures", () => {
  function argvRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-root-"));
    dirs.push(root);
    return root;
  }
  const age = (target: string, ms: number): void => {
    const then = new Date(Date.now() - ms);
    utimesSync(target, then, then);
  };

  /**
   * Runs `acquireLock(root, options)` in a child process (a lock loop that
   * spins would otherwise hang this test runner) with a 10 s limit; `setup`
   * and `beforeBreak` are module source run there with `root` and `lock`.
   */
  function lockScenario(
    root: string,
    options: Record<string, unknown>,
    code: { readonly setup?: string; readonly beforeBreak?: string; readonly restore?: boolean } = {},
  ): { result: { acquired?: boolean; message?: string; restoredCodePage?: number } | null; elapsed: number; status: number | null; stderr: string } {
    const program = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const mod = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
      "const root = process.argv[1];",
      'const lock = path.join(root, "lock");',
      code.setup ?? "",
      `const options = ${JSON.stringify(options)};`,
      code.beforeBreak === undefined ? "" : `options.beforeBreak = () => { ${code.beforeBreak} };`,
      code.restore === true ? "options.restoreCodePage = (cp) => cp;" : "",
      "const started = Date.now();",
      "const result = mod.acquireLock(root, options);",
      'process.stdout.write(JSON.stringify({ result, elapsed: Date.now() - started }));',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", program, root], { encoding: "utf8", timeout: 10_000 });
    const parsed = run.status === 0 ? (JSON.parse(run.stdout) as { result: { acquired?: boolean }; elapsed: number }) : null;
    return { result: parsed?.result ?? null, elapsed: parsed?.elapsed ?? -1, status: run.status, stderr: run.stderr };
  }
  const OLD = 'const old = new Date(Date.now() - 3600000); fs.utimesSync(lock, old, old);';

  it("takes a free lock and records its owner", () => {
    const root = argvRoot();
    const run = lockScenario(root, { token: "c-1-1", timeoutMs: 200 });
    expect(run.result, run.stderr).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, "lock"))).toEqual(["owner-c-1-1"]);
  });

  it("waits for a held lock and then refuses, naming it", () => {
    const root = argvRoot();
    mkdirSync(path.join(root, "lock"));
    writeFileSync(path.join(root, "lock", "owner-c-2-2"), "");
    const run = lockScenario(root, { token: "c-3-3", timeoutMs: 300, staleMs: 60_000 });
    expect(run.result?.acquired, run.stderr).toBe(false);
    expect(run.result?.message).toMatch(/kept the launcher's console lock/);
    expect(run.elapsed).toBeGreaterThanOrEqual(250);
    expect(readdirSync(path.join(root, "lock"))).toEqual(["owner-c-2-2"]);
  });

  // Review round 6 (1): a stale lock that is not empty made rmdir throw, and the loop spun forever.
  it("breaks a stale lock that is not empty, and reports the code page it recorded", () => {
    const root = argvRoot();
    const run = lockScenario(
      root,
      { token: "c-4-4", timeoutMs: 2_000, staleMs: 60_000 },
      { setup: `fs.mkdirSync(lock); for (const f of ["owner-c-5-5", "cp-857", "unknown.txt"]) fs.writeFileSync(path.join(lock, f), ""); ${OLD}`, restore: true },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.result).toEqual({ acquired: true, restoredCodePage: 857 });
    expect(readdirSync(path.join(root, "lock"))).toEqual(["owner-c-4-4"]);
  });

  // Review round 6 (1, 3): a `lock` that is a file or a link to a deleted directory: refused at once, never a spin.
  it.each([
    ["a file", 'fs.writeFileSync(lock, "");'],
    ["a link to a deleted directory", 'const t = path.join(root, "gone"); fs.mkdirSync(t); fs.symlinkSync(t, lock, "junction"); fs.rmdirSync(t);'],
  ])("refuses at once when the lock is %s", (_label, setup) => {
    const root = argvRoot();
    const run = lockScenario(root, { token: "c-6-6", timeoutMs: 3_000 }, { setup });
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.acquired).toBe(false);
    expect(run.result?.message).toMatch(/lock is not a directory/);
    expect(run.result?.message).toContain(path.join(root, "lock"));
    expect(run.elapsed).toBeLessThan(1_000);
  });

  it("refuses a lock root that does not exist", () => {
    const run = lockScenario(path.join(argvRoot(), "missing"), { token: "c-7-7", timeoutMs: 100 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.acquired).toBe(false);
  });

  // Review round 6 (1): a stale lock that cannot be moved (here a process's working directory) counts as held.
  it.runIf(process.platform === "win32")("treats a stale lock it cannot move as held and refuses after the deadline", async () => {
    const root = argvRoot();
    const lock = path.join(root, "lock");
    mkdirSync(lock);
    age(lock, 3_600_000);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: lock, stdio: "ignore" });
    const exited = new Promise((resolve) => holder.once("exit", resolve));
    try {
      const run = lockScenario(root, { token: "c-8-8", timeoutMs: 500, staleMs: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(run.result?.acquired).toBe(false);
      expect(run.elapsed).toBeGreaterThanOrEqual(450);
      expect(run.elapsed).toBeLessThan(3_000);
      expect(existsSync(lock)).toBe(true);
    } finally {
      holder.kill();
      await exited;
    }
  });

  // Review round 6 (5): two starts breaking one stale lock must not both hold it.
  it("puts back a lock that another start took between seeing it stale and moving it", () => {
    const root = argvRoot();
    const run = lockScenario(
      root,
      { token: "c-9-9", timeoutMs: 400, staleMs: 60_000 },
      {
        setup: `fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner-c-10-10"), ""); ${OLD}`,
        // The other start breaks the stale lock first and takes a fresh one.
        beforeBreak: 'if (!fs.existsSync(path.join(root, "other-broke"))) { fs.renameSync(lock, path.join(root, "other-broke")); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner-c-11-11"), ""); }',
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.result?.acquired).toBe(false);
    expect(readdirSync(path.join(root, "lock"))).toEqual(["owner-c-11-11"]);
  });

  it("removes only old capture directories holding only capture files", () => {
    const root = argvRoot();
    const make = (name: string, files: readonly string[], ageMs: number): string => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      for (const file of files) writeFileSync(path.join(dir, file), "x");
      age(dir, ageMs);
      return dir;
    };
    const stale = make("c-123-1", ["argv-hash.txt", "argv-bracket.txt", "cp.txt"], 3_600_000);
    const staleEmpty = make("c-456-2", [], 3_600_000);
    const fresh = make("c-789-3", ["argv-hash.txt"], 0);
    const foreign = make("c-111-4", ["argv-hash.txt", "other.txt"], 3_600_000);
    const otherName = make("keep-me", [], 3_600_000);
    // A broken lock that could not be removed at once (round 6): only lock files in it.
    const brokenLock = make("stale-c-222-5-1", ["owner-c-1-1", "cp-857"], 3_600_000);
    const brokenForeign = make("stale-c-333-6-1", ["owner-c-1-1", "other.txt"], 3_600_000);
    expect(mod.removeStaleCaptures(root, { maxAgeMs: 600_000 }).sort()).toEqual(["c-123-1", "c-456-2", "stale-c-222-5-1"]);
    for (const gone of [stale, staleEmpty, brokenLock]) expect(existsSync(gone)).toBe(false);
    for (const kept of [fresh, foreign, otherName, brokenForeign]) expect(existsSync(kept)).toBe(true);
  });
});

describe("windows-argv: --launch", () => {
  it("starts causoryn.mjs next to it with the captured arguments, and refuses without captures", () => {
    const pkg = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-launch-"));
    dirs.push(pkg);
    mkdirSync(path.join(pkg, "scripts", "lib"), { recursive: true });
    writeFileSync(path.join(pkg, "scripts", "lib", "windows-argv.mjs"), readFileSync(SCRIPT));
    // The CLI sees itself as argv[1] (it reads process.argv.slice(2)), and sets the exit code.
    writeFileSync(
      path.join(pkg, "scripts", "causoryn.mjs"),
      'import { fileURLToPath } from "node:url";\n' +
        'console.log("CLI " + JSON.stringify(process.argv.slice(2)) + " self=" + (process.argv[1] === fileURLToPath(import.meta.url)));\n' +
        "process.exitCode = 4;\n",
    );
    const dir = captureDir(capture('mcp "a b"'));
    // The launcher's code page reading lives in the same directory and goes with it.
    writeFileSync(path.join(dir, "cp.txt"), "Active code page: 65001\r\n");
    const run = spawnSync(process.execPath, [path.join(pkg, "scripts", "lib", "windows-argv.mjs"), "--launch", dir], { encoding: "utf8" });
    expect(run.stdout).toContain('CLI ["mcp","a b"] self=true');
    expect(run.status).toBe(4);
    expect(existsSync(dir)).toBe(false);

    const empty = mkdtempSync(path.join(os.tmpdir(), "causoryn-winargv-"));
    dirs.push(empty);
    const refused = spawnSync(process.execPath, [path.join(pkg, "scripts", "lib", "windows-argv.mjs"), "--launch", empty], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stdout).not.toContain("CLI");
    expect(refused.stderr).toMatch(/refusing to start/);
  });
});
