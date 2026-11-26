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
 *
 * The captures live in a new directory under `%LOCALAPPDATA%\causoryn\argv`
 * (not `%TEMP%`, which other accounts may be able to write): whoever can write
 * there can choose the CLI's arguments, and can already change the launcher in
 * npm's cache under `%LOCALAPPDATA%`. Before it changes the console code page
 * the launcher runs `node windows-argv.mjs --lock <root>`, which takes the
 * lock directory `<root>\lock` (the launcher removes it after restoring the
 * code page), so starts that share a console do not switch the code page
 * under each other, and removes capture directories that earlier starts left
 * behind.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Files the launcher writes into a capture directory (the two captures and its code page reading). */
export const CAPTURE_FILES = Object.freeze(["argv-hash.txt", "argv-bracket.txt", "cp.txt"]);
/** Capture directory names (`c-<random>-<attempt>`) under the capture root. */
export const CAPTURE_DIR_PATTERN = /^c-\d+-\d+$/;
const LOCK_NAME = "lock";

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
  const tails = CAPTURE_FILES.slice(0, 2).map((name) => {
    const text = readCapture(dir, name);
    return text === null ? null : capturedTail(text);
  });
  if (tails.some((tail) => tail === null)) {
    return { ok: false, message: `${REFUSED} the launcher could not read back its arguments.` };
  }
  const [first, second] = tails;
  const reference = forReferenceIn(first) ?? forReferenceIn(second);
  if (reference !== null) {
    return { ok: false, message: `${REFUSED} an argument contains ${reference}, which cmd.exe would expand in the launcher.` };
  }
  if (first !== second) {
    return { ok: false, message: `${REFUSED} the two captures of the arguments differ (the console code page changed while they were written).` };
  }
  return { ok: true, args: parseWindowsArguments(first) };
}

/** Removes the launcher's capture files and then their directory; true when the directory is gone. */
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
    return true;
  } catch {
    // Not empty (a file the launcher does not write) or held open: a later start's
    // --lock removes it once it is old, if it then holds only capture files.
    return false;
  }
}

/**
 * Removes capture directories under `root` that a start left behind (it never
 * reached `--launch`, node crashed, or removal failed): real directories named
 * like a capture directory, unchanged for `maxAgeMs`, that hold nothing but
 * capture files. Returns the names removed.
 */
export function removeStaleCaptures(root, { maxAgeMs = 10 * 60_000 } = {}) {
  const removed = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const name of names) {
    if (!CAPTURE_DIR_PATTERN.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      if (readdirSync(dir).some((entry) => !CAPTURE_FILES.includes(entry))) continue;
    } catch {
      continue;
    }
    if (removeCaptures(dir)) removed.push(name);
  }
  return removed;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Takes the lock directory `<root>\lock`: true once this call created it.
 * Waits while another start holds it, breaks a lock unchanged for `staleMs`
 * (a start killed inside its code page window), and gives up after
 * `timeoutMs` or when `root` cannot hold it.
 */
export function acquireLock(root, { timeoutMs = 15_000, staleMs = 15_000 } = {}) {
  const lock = path.join(root, LOCK_NAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
    }
    try {
      const info = statSync(lock);
      if (info.isDirectory() && Date.now() - info.mtimeMs > staleMs) {
        rmdirSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return false;
    sleep(10 + Math.floor(Math.random() * 20));
  }
}

if (process.argv[2] === "--lock" && process.argv.length === 4) {
  const root = path.resolve(process.argv[3]);
  if (!acquireLock(root)) {
    process.stderr.write(`${REFUSED} another start kept the launcher's console lock (${path.join(root, LOCK_NAME)}).\n`);
    process.exitCode = 2;
  } else {
    removeStaleCaptures(root);
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
