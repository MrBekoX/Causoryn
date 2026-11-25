/**
 * leak-scan — shared credential and privacy-leak detectors.
 *
 * Used by `scripts/secret-scan.mjs` (working-tree gate) and
 * `scripts/export-public-tree.mjs` (published-tree gate) so both gates apply
 * the exact same rules.
 *
 * Design rules:
 * - Content-based: a file is treated as binary when it contains a NUL byte;
 *   binary files are still scanned through their printable string runs.
 *   There is no extension allowlist, so `.tsx`, `.env`, `Dockerfile`,
 *   `.TS` and extensionless files are all covered.
 * - Every regular expression is anchored on a literal prefix and uses a
 *   single quantified character class per position (no nested quantifiers
 *   over overlapping classes), keeping matching linear (ReDoS-safe).
 * - This file is written so that it does not match its own rules (no
 *   self-skip is needed); tests build their bait values at runtime.
 * - Private terms (names or paths that must never be published but cannot
 *   be committed as patterns) are read from an untracked local file and/or
 *   an environment variable; findings never print the term itself.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

/** Environment variable holding extra private terms (comma or newline separated). */
export const PRIVATE_TERMS_ENV = "CAUSORYN_PRIVATE_TERMS";

/** Untracked private-term file, resolved with `git rev-parse --git-path`. */
export const PRIVATE_TERMS_GIT_PATH = "info/causoryn-private-terms";

const MIN_PRIVATE_TERM_LENGTH = 3;
const MIN_BINARY_STRING_RUN = 8;

/**
 * Secret rules. `check` (optional) receives the match and returns false for
 * documented placeholders so obvious examples do not fail the gate.
 */
export const SECRET_RULES = Object.freeze([
  { id: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: "gitlab-token", re: /\bgl(?:pat|rt|dt|ptt|ft|soat|imt|cbt|oas)-[A-Za-z0-9_-]{20,}/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}/ },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  {
    id: "jwt-token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  { id: "aws-access-key", re: /\b(?:AKIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: "aws-temporary-access-key", re: /\bASIA[0-9A-Z]{16}\b/ },
  { id: "slack-token", re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
  { id: "huggingface-token", re: /\b(?:hf|api_org)_[A-Za-z]{34}\b/ },
  { id: "supabase-token", re: /\b(?:sbp_[a-f0-9]{40}\b|sb_secret_[A-Za-z0-9_-]{20,})/ },
  { id: "stripe-live-key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  { id: "nuget-api-key", re: /\boy2[a-z0-9]{43}\b/ },
  { id: "pypi-token", re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/ },
  { id: "crates-io-token", re: /\bcio[A-Za-z0-9]{32}\b/ },
  {
    id: "connection-string-credentials",
    // The user part may be empty (`redis://:password@host`).
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/([^\s:/@'"`]*):([^\s@/'"`]+)@/i,
    check: (match) => !isPlaceholderValue(match[2] ?? "", { minLength: 1, requireDigit: false }),
  },
  {
    id: "authorization-bearer",
    re: /\bAuthorization["']?\s*[:=]\s*["']?Bearer\s+([A-Za-z0-9._~+/-]{20,})/i,
    check: (match) => !isPlaceholderValue(match[1] ?? "", { minLength: 20, requireDigit: true }),
  },
  {
    id: "assigned-secret-literal",
    re: /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["']([^"']{12,})["']/i,
    check: (match) => !isPlaceholderValue(match[1] ?? "", { minLength: 12, requireDigit: false }),
  },
  {
    id: "dotenv-secret-assignment",
    re: /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S+)/,
    check: (match) => {
      if (!SECRET_NAME_RE.test(match[1] ?? "")) return false;
      const value = stripMatchingQuotes(match[2] ?? "");
      return !isPlaceholderValue(value, { minLength: 12, requireDigit: true });
    },
  },
  {
    id: "personal-email",
    // The lookbehind pins the match to the start of the local part, so a long
    // run without "@" is scanned once instead of once per start position.
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|aol|protonmail|proton|yandex|gmx|mail)\.(?:com|me|net|de|ru)\b/i,
  },
]);

const SECRET_NAME_RE =
  /(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|AUTH_KEY)/i;

const PLACEHOLDER_WORD_RE =
  /(?:your|example|placeholder|changeme|change-me|dummy|redacted|sample|xxxx|\*\*\*|<|>|\$\{|\{\{|%[A-Za-z_])/i;

const GENERIC_PASSWORD_PLACEHOLDERS = new Set([
  "password",
  "pass",
  "passwd",
  "pwd",
  "secret",
  "token",
  "changeme",
]);

function stripMatchingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * True when `value` is an obvious documentation placeholder (or a reference
 * to another variable) rather than a literal credential.
 */
function isPlaceholderValue(value, { minLength, requireDigit }) {
  if (value.length < minLength) return true;
  const first = value[0] ?? "";
  if ("$<{%*(".includes(first)) return true;
  if (value.includes("://")) return true;
  if (GENERIC_PASSWORD_PLACEHOLDERS.has(value.toLowerCase())) return true;
  if (PLACEHOLDER_WORD_RE.test(value)) return true;
  if (requireDigit && !(/[0-9]/.test(value) && /[A-Za-z]/.test(value))) return true;
  return false;
}

/** Placeholder user names that are not personal (CI runners, docs, system profiles). */
export const GENERIC_PROFILE_USERS = new Set([
  "you",
  "your-user",
  "your-username",
  "your-name",
  "yourname",
  "username",
  "user",
  "name",
  "runner",
  "runneradmin",
  "node",
  "demo",
  "dev",
  "example",
  "public",
  "default",
]);

/**
 * Windows (`X:\Users\<name>`, `X:/Users/<name>`, `X:\\Users\\<name>`),
 * macOS (`/Users/<name>`), Linux (`/home/<name>`) and WSL
 * (`/mnt/x/Users/<name>`) user-profile paths. Group 1 is the user segment.
 */
const USER_PROFILE_PATH_RE =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)[Uu][Ss][Ee][Rr][Ss]|(?<![A-Za-z0-9._~%-])(?:\/mnt\/[A-Za-z]\/[Uu]sers|\/Users|\/home))(?:\\{1,2}|\/)(<[^<>\r\n]{1,64}>|[^\s\\/"'`<>|:*?,;()[\]]+)/g;

/**
 * Absolute drive-letter path (`X:\segment`, `X:/segment`, `X:\\segment`).
 * Group 1 is the first path segment.
 */
const DRIVE_PATH_RE =
  /(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)(<[^<>\r\n]{1,64}>|[^\s\\/"'`<>|:*?,;()[\]]+)/g;

/**
 * First path segments that are documented, non-personal example roots.
 * `Users` is handled by the user-profile detector.
 */
export const EXAMPLE_DRIVE_ROOTS = new Set([
  "users",
  "windows",
  "program",
  "programdata",
  "projects",
  "project",
  "path",
  "dizin",
  "definitely",
  "example",
  "examples",
]);

/** Extensions whose content is documentation/configuration (drive-path policy applies). */
const DOCUMENT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".html", ".htm", ".svg", ".csv", ".tsv", ".plist", ".properties",
  ".gitignore", ".gitattributes", ".npmrc", ".editorconfig",
]);

const DOCUMENT_BASENAMES = new Set([
  "license", "licence", "notice", "readme", "changelog", "authors", "codeowners",
]);

/** True for documentation/configuration files where absolute drive paths are reported. */
export function isDocumentLikePath(relPosix) {
  const base = path.posix.basename(relPosix).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (DOCUMENT_BASENAMES.has(base)) return true;
  const ext = base.startsWith(".") && !base.slice(1).includes(".") ? base : path.posix.extname(base);
  return DOCUMENT_EXTENSIONS.has(ext);
}

function isPlaceholderSegment(segment) {
  const first = segment[0] ?? "";
  if ("<%${".includes(first)) return true;
  if (/^\.+$/.test(segment)) return true;
  return false;
}

/** Number of non-generic user-profile paths in `line`. */
export function countUserProfilePaths(line) {
  let count = 0;
  USER_PROFILE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = USER_PROFILE_PATH_RE.exec(line)) !== null) {
    const segment = match[1] ?? "";
    if (isPlaceholderSegment(segment)) continue;
    // Windows 8.3 short names (`RUNNER~1`) are compared by their long-name prefix.
    const normalized = segment.toLowerCase().replace(/~[0-9]+$/, "");
    if (GENERIC_PROFILE_USERS.has(normalized)) continue;
    count += 1;
  }
  return count;
}

/** Number of absolute drive-letter paths whose first segment is not a documented example root. */
export function countLocalDrivePaths(line) {
  let count = 0;
  DRIVE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = DRIVE_PATH_RE.exec(line)) !== null) {
    const segment = match[1] ?? "";
    if (isPlaceholderSegment(segment)) continue;
    if (EXAMPLE_DRIVE_ROOTS.has(segment.toLowerCase())) continue;
    count += 1;
  }
  return count;
}

/** Upstream license notices legitimately carry third-party author e-mail addresses. */
export function isThirdPartyLicenseNoticeFile(relPosix) {
  const base = path.posix.basename(relPosix);
  if (base === "THIRD-PARTY-NOTICES.md") return true;
  return relPosix.startsWith("licenses/") || relPosix.includes("/licenses/");
}

/**
 * Parses a private-term list: one term per line or comma separated,
 * `#` starts a comment line. Terms shorter than 3 characters are rejected
 * (fail-closed) because they would match almost everything.
 */
export function parsePrivateTerms(raw, sourceLabel) {
  const terms = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) continue;
    for (const part of trimmedLine.split(",")) {
      const term = part.trim();
      if (term.length === 0) continue;
      if (term.length < MIN_PRIVATE_TERM_LENGTH) {
        throw new Error(
          `Private term list (${sourceLabel}) contains a term shorter than ${String(MIN_PRIVATE_TERM_LENGTH)} characters.`,
        );
      }
      terms.push(term.toLowerCase());
    }
  }
  return terms;
}

/**
 * Loads private terms from `CAUSORYN_PRIVATE_TERMS` and from the untracked
 * file `<git-dir>/info/causoryn-private-terms` of `repoRoot` (when given).
 * A missing file means no extra terms; any other read error is fatal.
 */
export function loadPrivateTerms({ repoRoot, env = process.env } = {}) {
  const terms = [];
  const fromEnv = env[PRIVATE_TERMS_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    terms.push(...parsePrivateTerms(fromEnv, PRIVATE_TERMS_ENV));
  }
  if (repoRoot) {
    const gitPath = execFileSync("git", ["rev-parse", "--git-path", PRIVATE_TERMS_GIT_PATH], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const termsFile = path.resolve(repoRoot, gitPath);
    let raw = null;
    try {
      raw = readFileSync(termsFile, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (raw !== null) {
      terms.push(...parsePrivateTerms(raw, PRIVATE_TERMS_GIT_PATH));
    }
  }
  return [...new Set(terms)];
}

/** True when the buffer is binary (contains a NUL byte). */
export function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

/** Printable ASCII runs of a binary buffer, one per entry (like `strings`). */
function binaryStringRuns(buffer) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buffer.length; i += 1) {
    const byte = i < buffer.length ? buffer[i] : 0;
    const printable = byte === 0x09 || (byte >= 0x20 && byte <= 0x7e);
    if (printable) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= MIN_BINARY_STRING_RUN) {
        runs.push({ offset: start, text: buffer.toString("latin1", start, i) });
      }
      start = -1;
    }
  }
  return runs;
}

function scanLine(line, context, push) {
  for (const rule of SECRET_RULES) {
    if (context.allowUpstreamEmail && rule.id === "personal-email") continue;
    const match = rule.re.exec(line);
    if (match === null) continue;
    if (rule.check && !rule.check(match)) continue;
    push(rule.id);
  }
  if (countUserProfilePaths(line) > 0) push("local-user-profile-path");
  if (context.documentLike && countLocalDrivePaths(line) > 0) push("local-drive-path");
  if (context.privateTerms.length > 0) {
    const lower = line.toLowerCase();
    context.privateTerms.forEach((term, index) => {
      if (lower.includes(term)) push(`private-term-${String(index + 1)}`);
    });
  }
}

/**
 * Scans one file's content. Returns findings as `{ location, rule }` where
 * `location` is `path:line` (text), `path:@offset` (binary) or `path:path`
 * (the file name itself). Matched values are never returned.
 *
 * @param {string} relPosix repository-relative POSIX path
 * @param {Buffer | string} content
 * @param {{ privateTerms?: readonly string[] }} [options]
 */
export function scanContent(relPosix, content, options = {}) {
  const findings = [];
  const context = {
    allowUpstreamEmail: isThirdPartyLicenseNoticeFile(relPosix),
    documentLike: isDocumentLikePath(relPosix),
    privateTerms: options.privateTerms ?? [],
  };
  const pathContext = { ...context, documentLike: false, allowUpstreamEmail: true };
  scanLine(relPosix, pathContext, (rule) => findings.push({ location: `${relPosix}:path`, rule }));

  const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (isBinaryBuffer(buffer)) {
    const binaryContext = { ...context, documentLike: false };
    for (const run of binaryStringRuns(buffer)) {
      scanLine(run.text, binaryContext, (rule) =>
        findings.push({ location: `${relPosix}:@${String(run.offset)}`, rule }),
      );
    }
    return findings;
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    scanLine(lines[index] ?? "", context, (rule) =>
      findings.push({ location: `${relPosix}:${String(index + 1)}`, rule }),
    );
  }
  return findings;
}

function runGitZ(repoRoot, args) {
  const out = execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/**
 * Repository files to scan, as sorted repository-relative POSIX paths:
 * tracked files plus (unless `trackedOnly`) untracked files that are not
 * ignored by `.gitignore` / `.git/info/exclude` / `core.excludesFile`.
 * Tracked files deleted from the working tree are reported separately.
 */
export function listRepoFiles(repoRoot, { trackedOnly = false } = {}) {
  const listArgs = trackedOnly
    ? ["ls-files", "-z", "--cached"]
    : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const files = [...new Set(runGitZ(repoRoot, listArgs))].sort();
  const deleted = new Set(runGitZ(repoRoot, ["ls-files", "-z", "--deleted"]));
  return { files, deleted };
}

/**
 * Reads one working-tree file for scanning without following symbolic
 * links: a link is scanned as its target string (what Git publishes).
 * Returns `null` for a tracked file deleted from the working tree; throws
 * on any other error (fail-closed).
 */
export function readWorkingTreeFile(repoRoot, relPosix, deleted) {
  const fullPath = path.join(repoRoot, ...relPosix.split("/"));
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT" &&
      deleted.has(relPosix)
    ) {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return Buffer.from(readlinkSync(fullPath), "utf8");
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file (submodule or special entry): ${relPosix}`);
  }
  return readFileSync(fullPath);
}

/** Formats findings for stderr (no matched values are printed). */
export function formatFindings(findings) {
  return findings.map((finding) => `${finding.location} — ${finding.rule}`);
}
