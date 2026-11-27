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
 * behind. The lock holds its owner's token (`owner-<capture directory name>`)
 * and the console code page that owner recorded before switching
 * (`cp-<n>`); see acquireLock.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Files the launcher writes into a capture directory (the two captures and its code page reading). */
export const CAPTURE_FILES = Object.freeze(["argv-hash.txt", "argv-bracket.txt", "cp.txt"]);
/** Capture directory names (`c-<random>-<attempt>`) under the capture root; a start's name is also its lock token. */
export const CAPTURE_DIR_PATTERN = /^c-\d+-\d+$/;
const TOKEN_PATTERN = CAPTURE_DIR_PATTERN;
const LOCK_NAME = "lock";
/** A broken lock moved aside by the start that broke it (`stale-<its token>-<attempt>`). */
const BROKEN_LOCK_PATTERN = /^stale-c-\d+-\d+-\d+$/;
/** Files a lock holds: its owner's token and the console code page the owner recorded. */
const LOCK_FILE_PATTERN = /^(owner-c-\d+-\d+|cp-\d+)$/;

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
  return removeEntriesAndDir(dir, CAPTURE_FILES);
}

/** Unlinks `entries` in `dir`, then removes `dir`; true when it is gone (it is kept when anything else is in it or it is held open). */
function removeEntriesAndDir(dir, entries) {
  for (const name of entries) {
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
    // --lock removes it once it is old, if it then holds only the launcher's files.
    return false;
  }
}

/**
 * Removes directories under `root` that starts left behind, once unchanged for
 * `maxAgeMs`: capture directories (the start never reached `--launch`, node
 * crashed, or removal failed) holding only capture files, and broken locks
 * moved aside (`stale-…`) holding only lock files. Returns the names removed.
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
    const allowed = CAPTURE_DIR_PATTERN.test(name)
      ? (entry) => CAPTURE_FILES.includes(entry)
      : BROKEN_LOCK_PATTERN.test(name)
        ? (entry) => LOCK_FILE_PATTERN.test(entry)
        : null;
    if (allowed === null) continue;
    const dir = path.join(root, name);
    let entries;
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.some((entry) => !allowed(entry))) continue;
    if (removeEntriesAndDir(dir, entries)) removed.push(name);
  }
  return removed;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Creates `<lock>` with this start's owner file: true, false when it exists, or why it cannot be taken. */
function tryTakeLock(lock, token) {
  try {
    mkdirSync(lock);
  } catch (error) {
    return error?.code === "EEXIST" ? false : `${REFUSED} could not create the launcher's lock ${lock} (${error?.code ?? error}).`;
  }
  try {
    writeFileSync(path.join(lock, `owner-${token}`), "", { flag: "wx" });
    return true;
  } catch (error) {
    try {
      rmdirSync(lock);
    } catch {
      // left: it goes stale
    }
    return `${REFUSED} could not write the owner of the launcher's lock ${lock} (${error?.code ?? error}).`;
  }
}

/**
 * Moves a stale lock aside (`<root>\stale-<token>-<n>`, a rename only one
 * start can win) and removes it. If what was moved is not the lock that was
 * seen stale (another start broke it and took a fresh one in between), it is
 * put back and nothing is broken. Returns the code page the stale lock
 * recorded (`cp-<n>`, undefined when none), or null when nothing was broken.
 */
function breakStaleLock(root, lock, token, attempt, staleMs, beforeBreak) {
  let seen;
  try {
    seen = readdirSync(lock).sort();
  } catch {
    return null;
  }
  beforeBreak?.();
  const moved = path.join(root, `stale-${token}-${attempt}`);
  try {
    renameSync(lock, moved);
  } catch {
    // Released, taken again, or held open (an open handle, antivirus): counts as held.
    return null;
  }
  let same = false;
  let names = [];
  try {
    const info = lstatSync(moved);
    names = readdirSync(moved).sort();
    same = info.isDirectory() && Date.now() - info.mtimeMs > staleMs && names.join("/") === seen.join("/");
  } catch {
    same = false;
  }
  if (!same) {
    try {
      renameSync(moved, lock);
    } catch {
      // The lock was taken again meanwhile; the moved one stays aside and its owner's token check keeps it from removing the new one.
    }
    return null;
  }
  const recorded = names.map((name) => /^cp-(\d+)$/.exec(name)?.[1]).find((value) => value !== undefined);
  removeEntriesAndDir(
    moved,
    names.filter((name) => LOCK_FILE_PATTERN.test(name)),
  );
  return { codePage: recorded === undefined ? undefined : Number(recorded) };
}

/**
 * Takes the lock directory `<root>\lock` for `token` (the start's capture
 * directory name, written into it as `owner-<token>`; the launcher releases the
 * lock only while that file is still in it). Waits while another start holds
 * the lock; breaks one unchanged for `staleMs` (a start killed inside its code
 * page window, or one slower than that) and hands the code page it recorded
 * to `restoreCodePage`; treats a stale lock it cannot move as held. Every way
 * round the loop checks the deadline and waits, so it ends after `timeoutMs`
 * at the latest. A `lock` that is not a directory (a file, or a link) is
 * refused at once. Returns `{ acquired: true, restoredCodePage? }` or
 * `{ acquired: false, message }`.
 */
export function acquireLock(root, { token, timeoutMs = 15_000, staleMs = 15_000, beforeBreak, restoreCodePage } = {}) {
  const lock = path.join(root, LOCK_NAME);
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return { acquired: false, message: `${REFUSED} the launcher passed no valid lock token.` };
  }
  const deadline = Date.now() + timeoutMs;
  let restoredCodePage;
  for (let attempt = 1; ; attempt += 1) {
    const taken = tryTakeLock(lock, token);
    if (taken === true) return restoredCodePage === undefined ? { acquired: true } : { acquired: true, restoredCodePage };
    if (typeof taken === "string") return { acquired: false, message: taken };
    let info = null;
    try {
      info = lstatSync(lock);
    } catch {
      // released meanwhile: taken on the next round
    }
    if (info !== null && !info.isDirectory()) {
      return { acquired: false, message: `${REFUSED} the launcher's lock is not a directory (a file or a link): ${lock}. Remove it to start.` };
    }
    if (info !== null && Date.now() - info.mtimeMs > staleMs) {
      const broken = breakStaleLock(root, lock, token, attempt, staleMs, beforeBreak);
      if (broken?.codePage !== undefined && restoreCodePage !== undefined) {
        const restored = restoreCodePage(broken.codePage);
        if (restored !== undefined) restoredCodePage = restored;
      }
    }
    if (Date.now() >= deadline) {
      return {
        acquired: false,
        message: `${REFUSED} another start kept the launcher's console lock ${lock} for ${Math.round(timeoutMs / 1000)} s (a stale lock that cannot be moved counts as held).`,
      };
    }
    sleep(5 + Math.floor(Math.random() * 20));
  }
}

/** The console's code page (chcp.com by absolute path, attached to this process's console), or null. */
function consoleCodePage(chcp) {
  try {
    const out = execFileSync(chcp, [], { encoding: "latin1", stdio: ["ignore", "pipe", "ignore"] });
    const match = /(\d+)\D*$/.exec(out.trim());
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * After breaking the stale lock of a start killed inside its UTF-8 window:
 * switches this console back to the code page that start recorded, but only
 * while the console is still at 65001 (otherwise the stale lock came from
 * another console or the code page was restored already). Returns the code
 * page set, or undefined.
 */
export function restoreConsoleCodePage(codePage) {
  const systemRoot = process.env["SystemRoot"];
  if (!Number.isInteger(codePage) || codePage <= 0 || codePage > 65535 || codePage === 65001) return undefined;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) return undefined;
  const chcp = path.win32.join(systemRoot, "System32", "chcp.com");
  if (consoleCodePage(chcp) !== 65001) return undefined;
  try {
    execFileSync(chcp, [String(codePage)], { stdio: "ignore" });
  } catch {
    return undefined;
  }
  return consoleCodePage(chcp) === codePage ? codePage : undefined;
}

if (process.argv[2] === "--lock" && process.argv.length === 5) {
  const root = path.resolve(process.argv[3]);
  const result = acquireLock(root, {
    token: process.argv[4],
    ...(process.platform === "win32" ? { restoreCodePage: restoreConsoleCodePage } : {}),
  });
  if (!result.acquired) {
    process.stderr.write(`${result.message}\n`);
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
