import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    ["captures that differ (a FOR reference was expanded in one)", capture("1"), capture("%#")],
    ["a %~ reference", capture("%~$X&echo,INJECTED&:a"), undefined],
    ["a missing capture line", "Records comments (remarks)\r\n", undefined],
  ])("refuses %s", (_label, first, second) => {
    const dir = captureDir(first, second);
    const result = mod.argumentsFromCaptures(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^causoryn: refusing to start/);
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
