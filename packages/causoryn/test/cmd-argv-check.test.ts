import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const CHECK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "cmd-argv-check.mjs");
const checkModule: unknown = await import(pathToFileURL(CHECK_SCRIPT).href);

/**
 * F20 round 3: the Windows half of scripts/causoryn.cmd. cmd-shim's shim already
 * parses the arguments once with cmd.exe, and npm escapes them for exactly
 * that level; the launcher is one batch level more, so an argument with a
 * cmd.exe operator outside double quotes would be split or run as a command.
 * Before `%*` reaches a command line, the launcher writes it, unparsed, into
 * a file (an echoed REM line) and this checker refuses to go on when cmd.exe
 * would see `& | < > ^` outside double quotes. cmd.exe does not know
 * backslash escapes, so its quote state is followed exactly as cmd.exe does.
 */

const check = checkModule as {
  capturedTail(text: string): string | null;
  unquotedOperator(tail: string): string | null;
  checkArgvFile(file: string): { ok: boolean; message?: string };
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** The launcher's capture, as cmd.exe writes it with prompt `#`. */
const capture = (tail: string): string => `\r\n#rem CAUSORYN-ARGV:${tail}:CAUSORYN-ARGV \r\n`;

describe("cmd-argv-check", () => {
  it("reads the argument text between the markers, also when it contains them", () => {
    expect(check.capturedTail(capture('mcp "a b" --x'))).toBe('mcp "a b" --x');
    expect(check.capturedTail(capture(""))).toBe("");
    expect(check.capturedTail(capture("x:CAUSORYN-ARGV y"))).toBe("x:CAUSORYN-ARGV y");
    expect(check.capturedTail("no capture here\r\n")).toBeNull();
  });

  it.each([
    ['mcp --allow-cwd --auto-data-dir', null],
    ['"a b" 50% %PATH% (x) !x! "" trail\\', null],
    ['"x & echo y" "a | b" "<y>" "a^b"', null],
    ["a&b", "&"],
    ["a|b", "|"],
    ["<y>", "<"],
    ["2>x", ">"],
    ["a^b", "^"],
    // cmd.exe has no backslash escape: `\"` toggles its quote state.
    ['"q\\"&echo INJECTED&\\"q"', "&"],
    ['"a\\"b" "c & d"', "&"],
    ['"a\\"b" c&d', null],
  ])("%s → %s", (tail, operator) => {
    expect(check.unquotedOperator(tail)).toBe(operator);
  });

  it("refuses when the capture is missing, and says what to do when an operator is unquoted", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-argv-check-"));
    dirs.push(dir);
    const file = path.join(dir, "argv.txt");
    writeFileSync(file, capture("mcp --allow-cwd"), "latin1");
    expect(check.checkArgvFile(file)).toEqual({ ok: true });

    writeFileSync(file, capture("--root C:\\a&b"), "latin1");
    const refused = check.checkArgvFile(file);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/"&" outside double quotes/);
    expect(refused.message).toMatch(/causoryn setup/);

    writeFileSync(file, "garbled", "latin1");
    expect(check.checkArgvFile(file).ok).toBe(false);
    expect(check.checkArgvFile(path.join(dir, "missing.txt")).ok).toBe(false);
  });

  it("run as the launcher runs it (--check), approves only by writing `ok` next to the file", () => {
    for (const [tail, approved] of [["mcp --allow-cwd", true], ["a&b", false]] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-argv-cli-"));
      dirs.push(dir);
      const file = path.join(dir, "argv.txt");
      writeFileSync(file, capture(tail), "latin1");
      const run = spawnSync(process.execPath, [CHECK_SCRIPT, "--check", file], { encoding: "utf8" });
      expect(run.status).toBe(approved ? 0 : 2);
      expect(existsSync(path.join(dir, "ok"))).toBe(approved);
      expect(run.stdout).toBe("");
    }
    // Without --check (imported, or started another way) it approves nothing.
    const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-argv-cli-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "argv.txt"), capture("mcp"), "latin1");
    expect(spawnSync(process.execPath, [CHECK_SCRIPT, path.join(dir, "argv.txt")]).status).toBe(0);
    expect(existsSync(path.join(dir, "ok"))).toBe(false);
  });
});
