/**
 * Windows half of scripts/causoryn.cmd (F20): decides whether the launcher may
 * hand its arguments (`%*`) to a cmd.exe command line.
 *
 * npm starts a bin through cmd.exe and cmd-shim's shim, and escapes the
 * arguments for exactly those levels (@npmcli/promise-spawn escape.cmd with
 * doubleEscape). The launcher is one batch level more: on its command line
 * cmd.exe would act again on `&`, `|`, `<`, `>` and `^` outside double quotes,
 * splitting an argument or running the rest as a command. So before `%*` is
 * used, the launcher echoes it, unparsed, in a REM line into a file (cmd.exe
 * does not act on the text of a REM), and this script refuses to go on when
 * that text has such a character outside double quotes. cmd.exe has no
 * backslash escape, so every `"` toggles its quote state. Text without them
 * reaches node unchanged, so the CLI gets exactly the arguments npm passed.
 *
 * The file is written in the console code page, so characters outside it read
 * as `?`; only the ASCII quote and operator characters matter here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BEGIN = "CAUSORYN-ARGV:";
const END = ":CAUSORYN-ARGV";
const OPERATORS = new Set(["&", "|", "<", ">", "^"]);
const UNREADABLE = "causoryn: refusing to start: the launcher could not read back its arguments.";

/** The argument text of the launcher's echoed `rem CAUSORYN-ARGV:<args>:CAUSORYN-ARGV` line, or null. */
export function capturedTail(text) {
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(`rem ${BEGIN}`);
    if (at === -1) continue;
    const from = at + "rem ".length + BEGIN.length;
    const to = line.lastIndexOf(END);
    return to >= from ? line.slice(from, to) : null;
  }
  return null;
}

/** The first cmd.exe operator outside double quotes (cmd.exe's own quote state), or null. */
export function unquotedOperator(tail) {
  let quoted = false;
  for (const ch of tail) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && OPERATORS.has(ch)) return ch;
  }
  return null;
}

/** `{ ok: true }`, or `{ ok: false, message }` when the launcher must not use the arguments. */
export function checkArgvFile(file) {
  let text;
  try {
    text = readFileSync(file, "latin1");
  } catch {
    return { ok: false, message: UNREADABLE };
  }
  const tail = capturedTail(text);
  if (tail === null) return { ok: false, message: UNREADABLE };
  const operator = unquotedOperator(tail);
  if (operator !== null) {
    return {
      ok: false,
      message:
        `causoryn: refusing to start: an argument has "${operator}" outside double quotes. Started through npm on ` +
        "Windows, the causoryn launcher would pass it through cmd.exe once more, which would treat it as a command " +
        "operator instead of text. Quote that argument, or run Causoryn as `node <path>\\scripts\\causoryn.mjs ...` " +
        "(the form `causoryn setup` writes into host configurations).",
    };
  }
  return { ok: true };
}

/**
 * `node cmd-argv-check.mjs --check <argv.txt>` (what the launcher runs). The
 * approval is a file `ok` written next to argv.txt; the launcher goes on only
 * when it exists, so a run that did not check anything (or failed) stops it.
 * The explicit `--check` (not a main-module test) keeps this working when npm
 * reaches the package through a link, where the module's own URL is the real
 * path and argv[1] is not.
 */
if (process.argv[2] === "--check") {
  const file = process.argv[3] ?? "";
  const result = checkArgvFile(file);
  if (result.ok) {
    writeFileSync(path.join(path.dirname(file), "ok"), "", { flag: "wx" });
  } else {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 2;
  }
}
