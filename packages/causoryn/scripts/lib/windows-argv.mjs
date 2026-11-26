/**
 * Windows half of scripts/causoryn.cmd (F20): gives the CLI the arguments the
 * launcher received, without cmd.exe ever parsing them again.
 *
 * npm starts a bin through cmd.exe and cmd-shim's shim, and escapes the
 * arguments for exactly those levels (@npmcli/promise-spawn escape.cmd with
 * doubleEscape); the launcher is one batch level more. So the launcher never
 * puts `%*` on a command line: it echoes `%*` (echo on, a REM line in a FOR
 * body; cmd.exe does not act on the text of a REM) into two files, with the
 * console in UTF-8 (chcp 65001, so no best-fit conversion), and starts
 * `node windows-argv.mjs --launch <dir>`. This script reads those files,
 * splits the text as the C runtime splits a command line (what node.exe did
 * with the same text when the bin was a `#!/usr/bin/env node` script) and
 * imports causoryn.mjs with those arguments.
 *
 * A FOR body expands references to its variable (`%#`, `%~f#`, `%~$PATH:#`)
 * in the echoed text, so the two captures use different variables (`#` and
 * `]`): a reference stays literal in one of them. The text is used only when
 * both captures are identical and contain no `%~`, `%#` or `%]`; otherwise,
 * or when a capture is missing, malformed or not UTF-8, the start is refused
 * (exit 2). Nothing in the text is ever run.
 */
import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CAPTURE_FILES = Object.freeze(["argv-hash.txt", "argv-bracket.txt"]);

const PREFIX = "\r\n#rem CAUSORYN-ARGV: ";
const SUFFIX = ":CAUSORYN-ARGV \r\n";
const REFUSED = "causoryn: refusing to start:";

/** The argument text of one capture (`<CRLF>#rem CAUSORYN-ARGV: <text>:CAUSORYN-ARGV <CRLF>`), or null. */
export function capturedTail(text) {
  if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX) || text.length < PREFIX.length + SUFFIX.length) return null;
  const tail = text.slice(PREFIX.length, text.length - SUFFIX.length);
  return /[\r\n]/.test(tail) ? null : tail;
}

/** The first FOR variable reference the launcher's captures could have expanded (`%~`, `%#`, `%]`), or null. */
export function forReferenceIn(tail) {
  for (const reference of ["%~", "%#", "%]"]) {
    if (tail.includes(reference)) return reference;
  }
  return null;
}

/**
 * Splits command-line text into arguments as the Universal C Runtime does for
 * the arguments after the program name: space and tab separate arguments
 * outside double quotes; 2n backslashes before `"` give n backslashes and the
 * quote toggles quoting, 2n+1 give n backslashes and a literal `"`; `""` inside
 * quotes gives a literal `"`; other backslashes are literal.
 */
export function parseWindowsArguments(tail) {
  const args = [];
  let i = 0;
  const n = tail.length;
  for (;;) {
    while (i < n && (tail[i] === " " || tail[i] === "\t")) i += 1;
    if (i >= n) return args;
    let arg = "";
    let quoted = false;
    for (;;) {
      let backslashes = 0;
      while (i < n && tail[i] === "\\") {
        backslashes += 1;
        i += 1;
      }
      let copy = true;
      if (i < n && tail[i] === '"') {
        if (backslashes % 2 === 0) {
          if (quoted && tail[i + 1] === '"') {
            i += 1;
          } else {
            copy = false;
            quoted = !quoted;
          }
        }
        backslashes = Math.floor(backslashes / 2);
      }
      arg += "\\".repeat(backslashes);
      if (i >= n || (!quoted && (tail[i] === " " || tail[i] === "\t"))) break;
      if (copy) arg += tail[i];
      i += 1;
    }
    args.push(arg);
  }
}

function readCapture(dir, name) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path.join(dir, name)));
  } catch {
    return null;
  }
}

/** The launcher's arguments from the two captures in `dir`, or why they cannot be used. */
export function argumentsFromCaptures(dir) {
  const tails = CAPTURE_FILES.map((name) => {
    const text = readCapture(dir, name);
    return text === null ? null : capturedTail(text);
  });
  if (tails.some((tail) => tail === null)) {
    return { ok: false, message: `${REFUSED} the launcher could not read back its arguments.` };
  }
  const [first, second] = tails;
  const reference = forReferenceIn(first) ?? forReferenceIn(second);
  if (first !== second || reference !== null) {
    return {
      ok: false,
      message: `${REFUSED} an argument contains ${reference ?? "a FOR variable reference"}, which cmd.exe would expand in the launcher.`,
    };
  }
  return { ok: true, args: parseWindowsArguments(first) };
}

/** Removes the launcher's capture files and their directory (only those). */
function removeCaptures(dir) {
  for (const name of CAPTURE_FILES) {
    try {
      unlinkSync(path.join(dir, name));
    } catch {
      // already gone
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // not empty or already gone: left for the launcher
  }
}

if (process.argv[2] === "--launch" && process.argv.length === 4) {
  const dir = path.resolve(process.argv[3]);
  const result = argumentsFromCaptures(dir);
  removeCaptures(dir);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 2;
  } else {
    const cli = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "causoryn.mjs");
    process.argv.splice(1, process.argv.length - 1, cli, ...result.args);
    await import(pathToFileURL(cli).href);
  }
}
