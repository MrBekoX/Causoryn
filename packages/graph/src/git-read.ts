import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { GraphRepositoryError } from "./errors.js";
import {
  collectUntrustedRoots,
  resolveExecutable,
  sanitizePathValue,
  trustedWorkingDirectory,
} from "./executable-resolution.js";
import { validateRepositoryLayout, type RepositoryLayout } from "./git-repository-layout.js";

/**
 * Git okuma katmanı — causoryn_compare_architecture spawn yardımcısı
 * (sprint-3 C3, TŞ v2.1 §13).
 *
 * TŞ §13 güven sözleşmesi: dışarıdan gelen ref'ler argv DİZİSİ ve
 * doğrulama ile işlenir; shell interpolation YOKTUR, `git checkout`,
 * `git reset`, `git clean` ve diğer yazan/yan etkili alt komutlar yürütme
 * ÖNCESİ reddedilir. Beyaz liste yalnızca salt-okunur alt komutları
 * içerir: `ls-tree` (ağaç listeleme) ve `cat-file blob` (yalnızca blob
 * türü okunur; ağaç/gitlink yolları reddedilir).
 * Kullanıcı girdisi asla bir komut dizgisine interpole edilmez; yalnızca
 * doğrulanmış ref/blob yolu olarak sabit pozisyonlarda argv'ya girer.
 *
 * `working-tree` özel referansı TŞ §13'teki "working-tree" tarafını
 * destekler: bu durumda git yerine izinli depo kökünden salt-okunur dosya
 * okuması yapılır (git nesnesi DEĞİL, çalışma ağacı). Sembolik bağlar
 * İZLENMEZ: ağaç listelemesi bağları atlar; blob okuması son bileşeni bağ
 * olan yolu reddeder ve ara bileşen bağlarıyla depo kökünden kaçışı
 * gerçek yol (realpath) sınırlamasıyla engeller (TŞ §19 tehdit modeli:
 * depo güvenilmez girdi sayılır).
 *
 * Hata kodları (GraphRepositoryError.code):
 * - compare/invalid-ref: ref biçimi güvenlik desenine uymuyor.
 * - compare/invalid-repo-root: repo kökü mutlak dizin değil.
 * - compare/invalid-blob-path: blob yolu traversal/mutlak/backslash vb.
 * - compare/git-command-not-allowed: beyaz liste dışı alt komut (yürütülmez).
 * - compare/git-unavailable: git çalıştırılabilir bulunamadı.
 * - compare/repository-refused: the repository layout would read outside the analyzed root (see git-repository-layout.ts).
 * - compare/git-command-failed: git sıfır olmayan çıkış kodu döndü.
 * - compare/ref-not-found: doğrulanmış ref depoda çözümlenemedi.
 * - compare/blob-not-found: ref:path nesnesi okunamadı.
 * - compare/blob-too-large: çalışma ağacı blob boyutu maxBufferBytes sınırını aştı.
 * - compare/tree-too-large: ağaç girişi sayısı sınırı aşıldı.
 * - compare/git-unexpected-output: git çıktısı beklenen biçimde değil.
 */

const execFile = promisify(execFileCallback);

/**
 * Git-compatible null device path: POSIX `/dev/null`, Windows `NUL`.
 * Note: Node's `os.devNull` is `\\.\nul` on Windows, which Git for Windows
 * rejects in `GIT_CONFIG_GLOBAL` (`fatal: unable to access '\\.\nul': Invalid argument`).
 */
export const GIT_DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * İzinli salt-okunur git alt komutları. Bu setin DIŞINDAKİ hiçbir alt komut
 * exec'e ulaşamaz — checkout/reset/clean dahil. `rev-parse` ek olarak
 * yalnızca `--verify --end-of-options <validatedRef>^{commit}` biçiminde
 * çalışabilir.
 */
const GIT_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "cat-file",
  "ls-tree",
  "rev-parse",
]);

/**
 * Exact argument shapes per subcommand. `cat-file` runs only as
 * `cat-file <type> <object>` / `cat-file -t <object>`: forms such as
 * `--textconv`, `--filters`, `--path` or the batch modes apply
 * repository-configured diff/filter drivers (commands) and are refused.
 * `ls-tree` accepts only `-r`, `--full-tree`, `-z` and one ref.
 */
const CAT_FILE_MODES: ReadonlySet<string> = new Set(["blob", "commit", "tag", "tree", "-t"]);
const LS_TREE_FLAGS: ReadonlySet<string> = new Set(["-r", "--full-tree", "-z"]);

/**
 * Per-invocation `-c` overrides placed BEFORE the subcommand so malicious
 * `.git/config` entries (`core.fsmonitor`, `core.sshCommand`, `diff.external`,
 * `core.hooksPath`, `protocol.ext.allow`, etc.) can never execute external
 * commands (CVE-2022-24765, CVE-2022-39253, CVE-2024-32465).
 */
const GIT_HARDENED_CONFIG_FLAGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${GIT_DEV_NULL}`,
  "-c",
  "core.pager=cat",
  "-c",
  "core.sshCommand=false",
  "-c",
  "core.askPass=",
  // An empty credential.helper resets the helper list collected from the
  // repository config (gitcredentials(7)); no transport is reachable anyway.
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=false",
  "-c",
  "protocol.allow=never",
  // Per-protocol keys: a repository-level protocol.<name>.allow is NOT
  // overridden by protocol.allow, but a command-line value of the same key is.
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.git.allow=never",
  "-c",
  "protocol.ssh.allow=never",
  "-c",
  "protocol.http.allow=never",
  "-c",
  "protocol.https.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.ftp.allow=never",
  "-c",
  "protocol.ftps.allow=never",
  // Defense in depth only: GIT_ALLOW_PROTOCOL="" in the child env (see
  // buildGitEnv) is what also covers every other protocol name.
  "-c",
  "safe.bareRepository=explicit",
];

/**
 * Global options of every repository-bound git call: `-C <root>`, `--no-pager`
 * (a `pager.<cmd>` / core.pager value never starts, even on a terminal) and
 * the hardened `-c` overrides. All precede the subcommand. `root` is the
 * canonical root validateRepositoryLayout checked, so git runs in the
 * directory that was validated even if a link in the given spelling changes.
 */
function repositoryGlobalOptions(root: string): string[] {
  return ["-C", root, "--no-pager", ...GIT_HARDENED_CONFIG_FLAGS];
}

/**
 * Safe Git ref grammar (linear-time O(n), zero ReDoS):
 * base ref `[A-Za-z0-9._/-]+` optionally followed by safe ancestry suffixes
 * (`~`, `~1`, `~10`, `^`, `^0`, `^2`, `^^`, `~1^2`), total length 1–200.
 */
const MAX_REF_LENGTH = 200;
const REF_PATTERN = /^[A-Za-z0-9._/-]+(?:[~^][0-9]{0,6})*$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** TŞ §13: commit/tag/branch/commit sha yanında "working-tree" tarafı. */
export const WORKING_TREE_REF = "working-tree";

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TREE_ENTRIES = 200_000;
const MAX_BLOB_PATH_LENGTH = 1024;

/**
 * Ref adı güvenlik doğrulaması. Desen + git-check-ref-format'tan
 * uyarlanmış ek retler: '-' ile başlama ('--' dahil — argv seçenek
 * enjeksiyonu riski), '.' veya '/' ile başlama, ".." içeriği, "@{", "//",
 * taban ref'te sondaki "/" veya ".lock" soneki ve `~`/`^` sonrası sayı
 * olmayan karakterler. Uzunluk 200 ile sınırlıdır.
 */
export function assertValidGitRef(ref: string): string {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    !REF_PATTERN.test(ref)
  ) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Invalid ref format (pattern: [A-Za-z0-9._/-]+(?:[~^][0-9]{0,6})*, length 1–${String(MAX_REF_LENGTH)}): ${String(ref)}`,
    );
  }
  if (ref.startsWith("-")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not start with '-' (including '--'; it could be read as a command-line option): ${ref}`,
    );
  }
  if (ref.startsWith(".")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not start with '.': ${ref}`,
    );
  }
  if (ref.startsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not start with '/': ${ref}`,
    );
  }
  if (ref.includes("..")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not contain '..': ${ref}`,
    );
  }
  if (ref.includes("@{")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not contain '@{': ${ref}`,
    );
  }
  if (ref.includes("//")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not contain '//': ${ref}`,
    );
  }
  const suffixStart = ref.search(/[~^]/);
  const baseRef = suffixStart >= 0 ? ref.slice(0, suffixStart) : ref;
  if (baseRef.endsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not end with '/': ${ref}`,
    );
  }
  if (baseRef.endsWith(".lock")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref must not end with '.lock': ${ref}`,
    );
  }
  return ref;
}

/**
 * Blob yolu güvenlik doğrulaması: git yolu '/' ayıracı kullanır; mutlak yol,
 * sürücü harfi (':' ile cat-file arg belirsizliği), ".." segmenti, boş
 * segment, '-' ile başlama, backslash ve kontrol karakterleri reddedilir.
 */
export function assertValidBlobPath(blobPath: string): string {
  if (
    typeof blobPath !== "string" ||
    blobPath.length === 0 ||
    blobPath.length > MAX_BLOB_PATH_LENGTH
  ) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path must be non-empty and at most ${MAX_BLOB_PATH_LENGTH} characters: ${String(blobPath)}`,
    );
  }
  if (blobPath.includes("\\")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path must not contain a backslash (git paths use '/'): ${blobPath}`,
    );
  }
  if (blobPath.startsWith("-")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path must not start with '-' (it could be read as a command-line option): ${blobPath}`,
    );
  }
  if (blobPath.startsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path must not be absolute: ${blobPath}`,
    );
  }
  if (blobPath.includes(":")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path must not contain ':' (drive letter / cat-file separator): ${blobPath}`,
    );
  }
  for (const segment of blobPath.split("/")) {
    if (segment.length === 0) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob path must not contain an empty segment (double or trailing '/'): ${blobPath}`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob path must not contain a '.' or '..' segment: ${blobPath}`,
      );
    }
  }
  for (const character of blobPath) {
    if (character.charCodeAt(0) < 0x20) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        "Blob path must not contain control characters",
      );
    }
  }
  return blobPath;
}

const GIT_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
] as const;

/**
 * Git test knob that can only make git STRICTER (every repository is treated
 * as owned by someone else, so only protected safe.directory entries allow
 * access). Passing it through can never relax isolation; it lets the
 * safe.directory forwarding be exercised in tests.
 */
const GIT_STRICTER_ONLY_PASSTHROUGH = ["GIT_TEST_ASSUME_DIFFERENT_OWNER"] as const;

function lookupEnv(
  sourceEnv: NodeJS.ProcessEnv,
  key: string,
  lowerIndex: ReadonlyMap<string, string | undefined> | null,
): string | undefined {
  return sourceEnv[key] ?? (lowerIndex !== null ? lowerIndex.get(key.toLowerCase()) : undefined);
}

/**
 * Git alt sürecine geçilecek daraltılmış ortamı kurar: yalnızca temel çalışma
 * değişkenleri (allowlist) korunur; üst süreçteki gizli anahtar/token'lar
 * miraslanmaz ve sistem git yapılandırması ile etkileşimli istem zorla kapatılır.
 * (runGit additionally replaces PATH with a sanitized copy.)
 */
export function buildGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const lowerIndex =
    process.platform === "win32"
      ? new Map(Object.entries(sourceEnv).map(([k, v]) => [k.toLowerCase(), v]))
      : null;

  for (const key of [...GIT_ENV_ALLOWLIST, ...GIT_STRICTER_ONLY_PASSTHROUGH]) {
    const raw = lookupEnv(sourceEnv, key, lowerIndex);
    if (typeof raw === "string" && raw.length > 0) {
      env[key] = raw;
    }
  }
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = GIT_DEV_NULL;
  env["GIT_ATTR_NOSYSTEM"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_NO_LAZY_FETCH"] = "1";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_LFS_SKIP_SMUDGE"] = "1";
  env["GIT_ALLOW_PROTOCOL"] = GIT_ALLOW_NO_PROTOCOL;
  return env;
}

/**
 * Empty protocol allowlist. git(1), ENVIRONMENT: "GIT_ALLOW_PROTOCOL: If set
 * to a colon-separated list of protocols, behave as if protocol.allow is set
 * to never, and each of the listed protocols has protocol.<name>.allow set to
 * always (overriding any existing configuration)." An empty list therefore
 * disables every transport, including protocol names a repository could
 * re-enable with its own protocol.<name>.allow (e.g. ftp, or helper-based
 * `<name>::` URLs). Source: Git for Windows 2.53 installed docs,
 * mingw64/share/doc/git-doc/git.html; https://git-scm.com/docs/git#Documentation/git.txt-GITALLOWPROTOCOL
 */
const GIT_ALLOW_NO_PROTOCOL = "";

export interface RunGitOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

/* ------------------------------------------------------------------ */
/* git process runtime: absolute executable, trusted cwd, test seam    */
/* ------------------------------------------------------------------ */

/** Options every git child process receives. */
export interface GitProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeout: number;
  readonly maxBuffer: number;
}

/** Starts one git process (absolute `file`, argv array, no shell). */
export type GitProcessRunner = (
  file: string,
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** Default runner: node:child_process.execFile (shell:false). */
export const defaultGitProcessRunner: GitProcessRunner = async (file, args, options) => {
  const result = await execFile(file, [...args], { ...options, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

let gitProcessRunner: GitProcessRunner = defaultGitProcessRunner;

/** Test seam: replaces the git process runner (undefined restores the default). */
export function setGitProcessRunnerForTesting(runner?: GitProcessRunner): void {
  gitProcessRunner = runner ?? defaultGitProcessRunner;
}

interface GitRuntime {
  readonly gitPath: string;
  readonly cwd: string;
  readonly untrustedRoots: readonly string[];
  /** process PATH without empty, relative and untrusted-root entries. */
  readonly sanitizedPath: string;
}

const MAX_RUNTIME_CACHE_ENTRIES = 32;
const gitRuntimeCache = new Map<string, GitRuntime>();
const gitVersionCache = new Map<string, GitVersion>();
const safeDirectoryCache = new Map<string, readonly string[]>();

/** Test seam: clears the cached git path, version and safe.directory values. */
export function resetGitRuntimeCachesForTesting(): void {
  gitRuntimeCache.clear();
  gitVersionCache.clear();
  safeDirectoryCache.clear();
}

function cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_RUNTIME_CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
}

/**
 * Resolves git to an absolute path from PATH (never the cwd, never a PATH
 * entry inside the analyzed repository) and picks a cwd outside it. The
 * repository itself is addressed only through `-C <canonical root>`.
 */
function resolveGitRuntime(repoRoot: string): GitRuntime {
  const untrustedRoots = collectUntrustedRoots([repoRoot]);
  const pathValue = process.env["PATH"] ?? "";
  const cacheKey = [pathValue, tmpdir(), ...untrustedRoots].join("\0");
  const cached = gitRuntimeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const gitPath = resolveExecutable("git", { env: process.env, untrustedRoots });
  if (gitPath === null) {
    throw new GraphRepositoryError(
      "compare/git-unavailable",
      "git could not be run: no git executable was found on PATH outside the analyzed repository",
    );
  }
  const gitDir = path.dirname(gitPath);
  const runtime: GitRuntime = {
    gitPath,
    cwd: trustedWorkingDirectory([tmpdir(), gitDir], untrustedRoots) ?? gitDir,
    untrustedRoots,
    sanitizedPath: sanitizePathValue(pathValue, untrustedRoots),
  };
  cacheSet(gitRuntimeCache, cacheKey, runtime);
  return runtime;
}

/**
 * Hardened git env for one repository read (PATH replaced by the sanitized
 * copy). GIT_CEILING_DIRECTORIES = parent of the canonical root, so git's
 * repository discovery never continues above the analyzed root (e.g. when the
 * root's .git directory is not a valid git directory). git(1), ENVIRONMENT:
 * "GIT_CEILING_DIRECTORIES ... Git should not chdir up into while looking for
 * a repository directory"; https://git-scm.com/docs/git#Documentation/git.txt-GITCEILINGDIRECTORIES
 */
function gitEnvFor(runtime: GitRuntime, layout: RepositoryLayout): Record<string, string> {
  const env = buildGitEnv(process.env);
  if (runtime.sanitizedPath.length > 0) env["PATH"] = runtime.sanitizedPath;
  else delete env["PATH"];
  const parent = path.dirname(layout.root);
  if (parent !== layout.root) {
    if (parent.includes(path.delimiter)) {
      throw new GraphRepositoryError(
        "compare/git-unavailable",
        `Refusing to read the git repository at ${layout.root}: the parent directory contains the path list ` +
          `separator ${JSON.stringify(path.delimiter)}, so repository discovery above the root cannot be blocked`,
      );
    }
    env["GIT_CEILING_DIRECTORIES"] = parent;
  }
  return env;
}

function notAllowed(message: string): GraphRepositoryError {
  return new GraphRepositoryError("compare/git-command-not-allowed", message);
}

/** `<ref>` or `<ref>:<path>` for cat-file; ref and path use the read-API grammars. */
function assertValidObjectName(objectName: string | undefined): void {
  if (objectName === undefined || objectName.length === 0 || objectName.startsWith("-")) {
    throw notAllowed(`git cat-file needs one object name that does not start with '-': ${String(objectName)}`);
  }
  const separator = objectName.indexOf(":");
  if (separator < 0) {
    assertValidGitRef(objectName);
    return;
  }
  assertValidGitRef(objectName.slice(0, separator));
  assertValidBlobPath(objectName.slice(separator + 1));
}

/** Refuses every argument shape the read APIs do not use (see CAT_FILE_MODES). */
function assertReadOnlyArguments(subcommand: string, args: readonly string[]): void {
  if (subcommand === "rev-parse") {
    if (
      args.length !== 4 ||
      args[1] !== "--verify" ||
      args[2] !== "--end-of-options" ||
      args[3] === undefined
    ) {
      throw notAllowed(
        "git rev-parse may only run in the read-only form ['rev-parse', '--verify', '--end-of-options', '<ref>^{commit}']",
      );
    }
    const rawTarget = args[3];
    const refToValidate = rawTarget.endsWith("^{commit}")
      ? rawTarget.slice(0, -"^{commit}".length)
      : rawTarget;
    assertValidGitRef(refToValidate);
    return;
  }
  if (subcommand === "cat-file") {
    if (args.length !== 3 || !CAT_FILE_MODES.has(args[1] ?? "")) {
      throw notAllowed(
        "git cat-file may only run as ['cat-file', 'blob'|'commit'|'tag'|'tree'|'-t', '<object>']; " +
          `rejected: ${JSON.stringify(args)}`,
      );
    }
    assertValidObjectName(args[2]);
    return;
  }
  if (subcommand === "ls-tree") {
    const flags = args.slice(1, -1);
    const ref = args.length >= 2 ? args[args.length - 1] : undefined;
    if (
      ref === undefined ||
      ref.startsWith("-") ||
      flags.some((flag) => !LS_TREE_FLAGS.has(flag)) ||
      new Set(flags).size !== flags.length
    ) {
      throw notAllowed(
        "git ls-tree may only run as ['ls-tree', ('-r'|'--full-tree'|'-z')..., '<ref>']; " +
          `rejected: ${JSON.stringify(args)}`,
      );
    }
    assertValidGitRef(ref);
  }
}

function processOptions(
  runtime: GitRuntime,
  env: Readonly<Record<string, string>>,
  options?: RunGitOptions,
): GitProcessOptions {
  return {
    cwd: runtime.cwd,
    env,
    shell: false,
    windowsHide: true,
    timeout: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };
}

/* ------------------------------------------------------------------ */
/* safe.directory: forward the user's protected entries                */
/* ------------------------------------------------------------------ */

/**
 * GIT_CONFIG_GLOBAL=<null device> and GIT_CONFIG_NOSYSTEM=1 (needed so a
 * hostile global/system config cannot run commands) also drop the user's
 * `safe.directory` entries, which makes repositories owned by another user
 * fail with "dubious ownership". The user's system + global values of ONLY
 * that key are read once (real environment, trusted cwd, no repository) and
 * forwarded as `-c safe.directory=<value>`. Command-line (`-c`) config is a
 * protected scope, and safe.directory is honored only in protected config:
 * https://git-scm.com/docs/git-config#SCOPES ("Protected configuration
 * refers to the system, global, and command scopes") and
 * https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory
 */
const MAX_FORWARDED_SAFE_DIRECTORIES = 512;
const SAFE_DIRECTORY_KEEP_GIT_ENV: ReadonlySet<string> = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
]);
const SAFE_DIRECTORY_CACHE_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "PROGRAMDATA",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/** git's boolean parsing for environment values (`git_env_bool`): true/yes/on/1 and non-zero integers. */
function isGitBooleanTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  if (normalized === "true" || normalized === "yes" || normalized === "on") return true;
  const asNumber = Number(normalized);
  return Number.isInteger(asNumber) && asNumber !== 0;
}

function buildUserConfigReadEnv(untrustedRoots: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") && !SAFE_DIRECTORY_KEEP_GIT_ENV.has(upper)) continue;
    env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      const sanitized = sanitizePathValue(env[key] ?? "", untrustedRoots);
      if (sanitized.length > 0) env[key] = sanitized;
      else delete env[key];
    }
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_OPTIONAL_LOCKS"] = "0";
  env["GIT_ALLOW_PROTOCOL"] = GIT_ALLOW_NO_PROTOCOL;
  return env;
}

async function readProtectedSafeDirectories(runtime: GitRuntime): Promise<readonly string[]> {
  const cacheKey = [
    runtime.gitPath,
    ...SAFE_DIRECTORY_CACHE_ENV_KEYS.map((key) => process.env[key] ?? ""),
  ].join("\0");
  const cached = safeDirectoryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const env = buildUserConfigReadEnv(runtime.untrustedRoots);
  const values: string[] = [];
  // `git config --system` reads the system file even when the user's
  // environment sets GIT_CONFIG_NOSYSTEM, but git itself then ignores that file
  // for every normal operation. Mirror git: with GIT_CONFIG_NOSYSTEM set, the
  // system scope is not part of the user's protected configuration.
  const scopes = isGitBooleanTrue(process.env["GIT_CONFIG_NOSYSTEM"])
    ? ["--global"]
    : ["--system", "--global"];
  for (const scope of scopes) {
    try {
      const { stdout } = await gitProcessRunner(
        runtime.gitPath,
        ["config", scope, "--includes", "-z", "--get-all", "safe.directory"],
        processOptions(runtime, env, { maxBufferBytes: 1024 * 1024 }),
      );
      const parts = stdout.split("\0");
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      values.push(...parts);
    } catch {
      // Exit status 1 = key not set; any other failure forwards nothing.
    }
  }
  const forwarded =
    values.length > MAX_FORWARDED_SAFE_DIRECTORIES
      ? values.slice(values.length - MAX_FORWARDED_SAFE_DIRECTORIES)
      : values;
  cacheSet(safeDirectoryCache, cacheKey, forwarded);
  return forwarded;
}

function safeDirectoryFlags(values: readonly string[]): string[] {
  const flags: string[] = [];
  for (const value of values) {
    flags.push("-c", `safe.directory=${value}`);
  }
  return flags;
}

/* ------------------------------------------------------------------ */
/* git >= 2.45 for partial clones (GIT_NO_LAZY_FETCH)                  */
/* ------------------------------------------------------------------ */

/**
 * `GIT_NO_LAZY_FETCH` / `git --no-lazy-fetch` first shipped in git 2.45.0:
 * https://github.com/git/git/blob/master/Documentation/RelNotes/2.45.0.adoc
 * ("git --no-lazy-fetch cmd" allows to run "cmd" while disabling lazy
 * fetching of objects from the promisor remote) and
 * https://github.com/git/git/blob/v2.45.0/Documentation/git.txt
 * (GIT_NO_LAZY_FETCH; absent from v2.44.0's git.txt). Older git ignores the
 * variable, so a read of a missing object in a partial clone could contact
 * the promisor remote. Such repositories are refused on git < 2.45.
 */
export const GIT_MIN_VERSION_FOR_PARTIAL_CLONE = { major: 2, minor: 45, patch: 0 } as const;

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses `git version X.Y[.Z]...` output; null when unrecognized. */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/m.exec(output.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function isAtLeast(version: GitVersion, minimum: GitVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

async function probeGitVersion(
  runtime: GitRuntime,
  env: Readonly<Record<string, string>>,
): Promise<GitVersion | null> {
  const cached = gitVersionCache.get(runtime.gitPath);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await gitProcessRunner(
      runtime.gitPath,
      ["--version"],
      processOptions(runtime, env, { maxBufferBytes: 64 * 1024 }),
    );
    const parsed = parseGitVersion(stdout);
    if (parsed !== null) cacheSet(gitVersionCache, runtime.gitPath, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Keys whose presence in the repository's effective config marks a partial clone. */
const PARTIAL_CLONE_KEY_PATTERN =
  "^(extensions\\.partialclone|remote\\..+\\.promisor|remote\\..+\\.partialclonefilter)$";

async function assertPartialCloneSupported(
  runtime: GitRuntime,
  root: string,
  env: Readonly<Record<string, string>>,
  safeFlags: readonly string[],
): Promise<void> {
  const version = await probeGitVersion(runtime, env);
  if (version !== null && isAtLeast(version, GIT_MIN_VERSION_FOR_PARTIAL_CLONE)) return;
  let partialClone: boolean;
  try {
    // `git config` only reads config files; it never fetches objects. No
    // scope flag: the EFFECTIVE config is read (repository config, worktree
    // config when extensions.worktreeConfig is set, includes and the
    // command line; global/system are already nulled by the env), so a
    // promisor remote declared in config.worktree is detected too.
    await gitProcessRunner(
      runtime.gitPath,
      [
        ...repositoryGlobalOptions(root),
        ...safeFlags,
        "config",
        "--includes",
        "-z",
        "--get-regexp",
        PARTIAL_CLONE_KEY_PATTERN,
      ],
      processOptions(runtime, env, { maxBufferBytes: 1024 * 1024 }),
    );
    partialClone = true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) {
      partialClone = false;
    } else {
      throw mapGitSpawnError(error, "config");
    }
  }
  if (!partialClone) return;
  const found =
    version === null
      ? "an unrecognized git version"
      : `git ${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  throw new GraphRepositoryError(
    "compare/git-unavailable",
    `This repository is a partial clone (promisor remote configured) and ${found} cannot read it safely: ` +
      "git 2.45 or newer is required for partial-clone repositories, because older versions may fetch " +
      "missing objects from the remote during a read. Upgrade git or analyze a full clone.",
  );
}

function mapGitSpawnError(error: unknown, subcommand: string): GraphRepositoryError {
  if (error instanceof GraphRepositoryError) return error;
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (candidate.code === "ENOENT") {
    gitRuntimeCache.clear();
    return new GraphRepositoryError(
      "compare/git-unavailable",
      "git could not be run: the resolved git executable was not found",
    );
  }
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  if (/dubious ownership/i.test(stderr)) {
    // The user may fix their config and retry; re-read it next time.
    safeDirectoryCache.clear();
    return new GraphRepositoryError(
      "compare/git-unavailable",
      "git refused to read the repository because it is owned by a different user (dubious ownership). " +
        "If you trust it, add it to safe.directory in your global or system git config " +
        "(git config --global --add safe.directory <path>) and retry.",
    );
  }
  const detail =
    stderr.length > 0 ? stderr : String(candidate.message ?? String(error));
  return new GraphRepositoryError(
    "compare/git-command-failed",
    `git ${subcommand} failed: ${detail}`,
  );
}

/**
 * Salt-okunur git çalıştırması: argv dizisi + alt komut beyaz listesi +
 * alt komut öncesi sertleştirilmiş `-c` yapılandırma geçersiz kılmaları.
 * `args[0]` beyaz listede değilse komut YÜRÜTÜLMEDEN reddedilir; shell
 * her koşulda kapalıdır (shell interpolation imkânsız). git is started by
 * absolute path with a cwd outside the repository.
 */
export async function runGit(
  repoRoot: string,
  args: readonly string[],
  options?: RunGitOptions,
): Promise<string> {
  if (!path.isAbsolute(repoRoot)) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot must be an absolute path: ${repoRoot}`,
    );
  }
  const subcommand = args[0];
  if (subcommand === undefined || !GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GraphRepositoryError(
      "compare/git-command-not-allowed",
      `Only read-only git commands are allowed ` +
        `(${[...GIT_ALLOWED_SUBCOMMANDS].join(", ")}); rejected: ` +
        `${subcommand === undefined ? "<none>" : subcommand}`,
    );
  }
  assertReadOnlyArguments(subcommand, args);
  // Before any git process touches the repository: the .git entry, gitdir
  // pointer and redirections must stay local and belong to this root.
  const layout = await validateRepositoryLayout(repoRoot, subcommand);
  const runtime = resolveGitRuntime(repoRoot);
  const env = gitEnvFor(runtime, layout);
  const safeFlags = safeDirectoryFlags(await readProtectedSafeDirectories(runtime));
  await assertPartialCloneSupported(runtime, layout.root, env, safeFlags);
  try {
    const result = await gitProcessRunner(
      runtime.gitPath,
      [...repositoryGlobalOptions(layout.root), ...safeFlags, ...args],
      processOptions(runtime, env, options),
    );
    return result.stdout;
  } catch (error) {
    throw mapGitSpawnError(error, subcommand);
  }
}

/**
 * Doğrulanmış bir Git revizyonunu (güvenli göreli biçimler dahil: `HEAD~1`,
 * `HEAD^`, `main~1`, `v0.2.4^0`) salt-okunur `git rev-parse --verify --end-of-options <ref>^{commit}`
 * ile kanonik commit SHA'sına çözümler.
 */
export async function resolveGitCommitRef(
  repoRoot: string,
  ref: string,
  options?: RunGitOptions,
): Promise<string> {
  assertValidGitRef(ref);
  if (ref === WORKING_TREE_REF) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `working-tree is not a Git commit ref: ${ref}`,
    );
  }
  assertRepoRoot(repoRoot);
  let output: string;
  try {
    output = await runGit(
      repoRoot,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      options,
    );
  } catch (error) {
    if (error instanceof GraphRepositoryError && error.code === "compare/git-command-failed") {
      throw new GraphRepositoryError(
        "compare/ref-not-found",
        `Ref could not be resolved: ${ref} — ${error.message}`,
      );
    }
    throw error;
  }
  const sha = output.trim();
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new GraphRepositoryError(
      "compare/git-unexpected-output",
      `rev-parse did not return a valid commit SHA (${ref}): ${sha}`,
    );
  }
  return sha;
}

export type GitTreeEntryType = "blob" | "tree" | "commit";

/** `git ls-tree` girişi; working-tree okumalarında sha yoktur. */
export interface GitTreeEntry {
  readonly mode: string;
  readonly type: GitTreeEntryType;
  readonly sha?: string;
  readonly path: string;
}

export interface ReadGitTreeOptions extends RunGitOptions {
  readonly maxEntries?: number;
}

function compareByPath(a: GitTreeEntry, b: GitTreeEntry): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function assertRepoRoot(repoRoot: string): void {
  if (!path.isAbsolute(repoRoot)) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot must be an absolute path: ${repoRoot}`,
    );
  }
}

function assertResolvedWithinRepoRoot(repoRoot: string, blobPath: string): string {
  const rootResolved = path.resolve(repoRoot);
  const resolved = path.resolve(repoRoot, blobPath);
  if (resolved === rootResolved || !resolved.startsWith(rootResolved + path.sep)) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path could not be confined to the repository root: ${blobPath}`,
    );
  }
  return resolved;
}

/** Çalışma ağacı listelemesi: .git hariç, sembolik bağlar izlenmez. */
async function listWorkingTree(
  repoRoot: string,
  maxEntries: number,
): Promise<GitTreeEntry[]> {
  assertRepoRoot(repoRoot);
  const rootStat = await stat(repoRoot).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot is not a directory: ${repoRoot}`,
    );
  }
  const rootResolved = path.resolve(repoRoot);
  const entries: GitTreeEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (entries.length > maxEntries) return;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (dirent.name === ".git") continue;
        await walk(path.join(dir, dirent.name));
        continue;
      }
      if (!dirent.isFile()) continue;
      const relative = path
        .relative(rootResolved, path.join(dir, dirent.name))
        .split(path.sep)
        .join("/");
      entries.push({ mode: "100644", type: "blob", path: relative });
    }
  };
  await walk(rootResolved);
  if (entries.length > maxEntries) {
    throw new GraphRepositoryError(
      "compare/tree-too-large",
      `Tree entry limit exceeded: ${entries.length} > ${maxEntries}`,
    );
  }
  entries.sort(compareByPath);
  return entries;
}

/**
 * Bir ref'in (commit/tag/branch/sha veya "working-tree") tam ağacını
 * listeler. Sonuç yol sırasına göre kanonik düzendedir (determinizm).
 */
export async function readGitTree(
  repoRoot: string,
  ref: string,
  options?: ReadGitTreeOptions,
): Promise<GitTreeEntry[]> {
  assertValidGitRef(ref);
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_TREE_ENTRIES;
  if (ref === WORKING_TREE_REF) {
    return listWorkingTree(repoRoot, maxEntries);
  }
  assertRepoRoot(repoRoot);
  let output: string;
  try {
    output = await runGit(
      repoRoot,
      ["ls-tree", "-r", "--full-tree", "-z", ref],
      options,
    );
  } catch (error) {
    if (error instanceof GraphRepositoryError) {
      // Dürüst hata ayrıştırıcı (denetim bulgusu): ls-tree çıktısının spawn
      // buffer sınırını aşması (Node: 'stdout maxBuffer length exceeded')
      // ağaç boyutu sorunudur — ref bulunamadı olarak YANLIŞ etiketlenmez.
      if (
        error.code === "compare/git-command-failed" &&
        /maxBuffer/i.test(error.message)
      ) {
        throw new GraphRepositoryError(
          "compare/tree-too-large",
          `Tree listing incomplete: ls-tree output exceeded the buffer limit (tree too large) — ${error.message}`,
        );
      }
      if (error.code === "compare/git-command-failed") {
        throw new GraphRepositoryError(
          "compare/ref-not-found",
          `Ref could not be resolved: ${ref} — ${error.message}`,
        );
      }
    }
    throw error;
  }

  const entries: GitTreeEntry[] = [];
  for (const line of output.split("\0")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      throw new GraphRepositoryError(
        "compare/git-unexpected-output",
        `ls-tree line has no metadata/path separator: ${line}`,
      );
    }
    const meta = line.slice(0, tab).split(" ");
    const mode = meta[0];
    const type = meta[1];
    const sha = meta[2];
    if (mode === undefined || type === undefined || sha === undefined) {
      throw new GraphRepositoryError(
        "compare/git-unexpected-output",
        `ls-tree line has an unexpected format: ${line}`,
      );
    }
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      throw new GraphRepositoryError(
        "compare/git-unexpected-output",
        `Unknown ls-tree entry type: ${type}`,
      );
    }
    entries.push({ mode, type, sha, path: line.slice(tab + 1) });
  }
  if (entries.length > maxEntries) {
    throw new GraphRepositoryError(
      "compare/tree-too-large",
      `Tree entry limit exceeded: ${entries.length} > ${maxEntries}`,
    );
  }
  entries.sort(compareByPath);
  return entries;
}

function isStrictlyWithinRealRoot(realRoot: string, realTarget: string): boolean {
  const boundary = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (process.platform === "win32") {
    const rootLower = realRoot.toLowerCase();
    const targetLower = realTarget.toLowerCase();
    const boundaryLower = boundary.toLowerCase();
    return targetLower !== rootLower && targetLower.startsWith(boundaryLower);
  }
  return realTarget !== realRoot && realTarget.startsWith(boundary);
}

async function readWorkingTreeBlob(
  repoRoot: string,
  blobPath: string,
  maxBytes: number,
): Promise<string> {
  const resolved = assertResolvedWithinRepoRoot(repoRoot, blobPath);
  const preLstat = await lstat(resolved).catch(() => undefined);
  if (preLstat === undefined) {
    throw new GraphRepositoryError(
      "compare/blob-not-found",
      `Working-tree file not found: ${blobPath}`,
    );
  }
  if (preLstat.isSymbolicLink()) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path is a symbolic link (links are not followed): ${blobPath}`,
    );
  }
  if (!preLstat.isFile()) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path is not a regular file: ${blobPath}`,
    );
  }

  // Ara bileşenlerdeki bağlarla depo kökünden dışarı çıkışa karşı gerçek
  // yol sınırlaması (lexical confinement tek başına yetmez).
  const [realRoot, realResolved] = await Promise.all([
    realpath(repoRoot),
    realpath(resolved).catch(() => undefined),
  ]);
  if (
    realResolved === undefined ||
    !isStrictlyWithinRealRoot(realRoot, realResolved)
  ) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob path escapes the repository root through a symbolic link: ${blobPath}`,
    );
  }

  // O_NONBLOCK: a FIFO swapped in after the lstat opens at once instead of
  // tying up a threadpool thread until a writer appears; the handle check
  // below then refuses it. O_NOCTTY: a terminal device never becomes the
  // controlling terminal. Neither is defined on Windows (?? 0).
  const openFlags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0) |
    (fsConstants.O_NOCTTY ?? 0);

  let handle;
  try {
    handle = await open(resolved, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new GraphRepositoryError(
        "compare/blob-not-found",
        `Working-tree file not found: ${blobPath}`,
      );
    }
    if (code === "ELOOP" || code === "EISDIR") {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob path could not be opened as a regular file: ${blobPath}`,
      );
    }
    throw error;
  }

  try {
    const openStat = await handle.stat();
    if (!openStat.isFile()) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Opened blob handle is not a regular file: ${blobPath}`,
      );
    }
    if (openStat.size > maxBytes) {
      throw new GraphRepositoryError(
        "compare/blob-too-large",
        `Working-tree file exceeds the size limit (${openStat.size} > ${maxBytes} bytes): ${blobPath}`,
      );
    }

    // Açma sonrası TOCTOU doğrulaması: gerçek yol hâlâ depo kökünde ve
    // açılan dosya tanıtıcısı aynı dosya düğümüne işaret ediyor olmalı.
    const [postLstat, postReal] = await Promise.all([
      lstat(resolved).catch(() => undefined),
      realpath(resolved).catch(() => undefined),
    ]);
    if (
      postLstat === undefined ||
      postLstat.isSymbolicLink() ||
      !postLstat.isFile() ||
      postReal === undefined ||
      !isStrictlyWithinRealRoot(realRoot, postReal) ||
      (openStat.ino !== 0 &&
        postLstat.ino !== 0 &&
        (postLstat.dev !== openStat.dev || postLstat.ino !== openStat.ino))
    ) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob path failed post-open verification (TOCTOU / link change): ${blobPath}`,
      );
    }

    const chunkSize = Math.min(Math.max(maxBytes, 1), 64 * 1024);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remainingAllowance = maxBytes - totalBytes + 1;
      const toRead = Math.min(chunkSize, remainingAllowance);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new GraphRepositoryError(
          "compare/blob-too-large",
          `Working-tree file exceeded the size limit while reading (> ${maxBytes} bytes): ${blobPath}`,
        );
      }
      chunks.push(buf.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Bir ref'teki tek bir blob'un metin içeriğini okur. `working-tree`
 * referansında izinli depo kökünden salt-okunur dosya okuması yapılır.
 * Sembolik bağlar her iki modda da izlenmez: son bileşeni bağ olan yol
 * reddedilir; ara bileşen bağlarıyla kök dışına kaçış realpath sınırlaması
 * ve açma sonrası tanıtıcı doğrulamasıyla engellenir.
 */
export async function readGitBlob(
  repoRoot: string,
  ref: string,
  blobPath: string,
  options?: RunGitOptions,
): Promise<string> {
  assertValidGitRef(ref);
  assertValidBlobPath(blobPath);
  assertRepoRoot(repoRoot);
  if (ref === WORKING_TREE_REF) {
    const effectiveMaxBytes =
      options?.maxBufferBytes !== undefined && Number.isFinite(options.maxBufferBytes)
        ? Math.max(0, Math.floor(options.maxBufferBytes))
        : DEFAULT_MAX_BUFFER_BYTES;
    return readWorkingTreeBlob(repoRoot, blobPath, effectiveMaxBytes);
  }
  try {
    // Yalnızca blob türü okunur: ağaç yolunda 'cat-file blob' tür uyuşmazlığı
    // ile reddeder; '-p' ise ağaç listesini metin olarak döndürecekti.
    return await runGit(
      repoRoot,
      ["cat-file", "blob", `${ref}:${blobPath}`],
      options,
    );
  } catch (error) {
    if (error instanceof GraphRepositoryError && error.code === "compare/git-command-failed") {
      throw new GraphRepositoryError(
        "compare/blob-not-found",
        `Blob could not be read: ${ref}:${blobPath} — ${error.message}`,
      );
    }
    throw error;
  }
}
