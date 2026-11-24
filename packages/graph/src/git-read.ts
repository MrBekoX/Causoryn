import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { GraphRepositoryError } from "./errors.js";

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
  "-c",
  "diff.external=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "safe.bareRepository=explicit",
];

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
      `Ref biçimi geçersiz (desen: [A-Za-z0-9._/-]+(?:[~^][0-9]{0,6})*, uzunluk 1–${String(MAX_REF_LENGTH)}): ${String(ref)}`,
    );
  }
  if (ref.startsWith("-")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '-' ile başlayamaz ('--' dahil argv seçenek riski): ${ref}`,
    );
  }
  if (ref.startsWith(".")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '.' ile başlayamaz: ${ref}`,
    );
  }
  if (ref.startsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '/' ile başlayamaz: ${ref}`,
    );
  }
  if (ref.includes("..")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '..' içeremez: ${ref}`,
    );
  }
  if (ref.includes("@{")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '@{' içeremez: ${ref}`,
    );
  }
  if (ref.includes("//")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '//' içeremez: ${ref}`,
    );
  }
  const suffixStart = ref.search(/[~^]/);
  const baseRef = suffixStart >= 0 ? ref.slice(0, suffixStart) : ref;
  if (baseRef.endsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '/' ile bitemez: ${ref}`,
    );
  }
  if (baseRef.endsWith(".lock")) {
    throw new GraphRepositoryError(
      "compare/invalid-ref",
      `Ref '.lock' ile bitemez: ${ref}`,
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
      `Blob yolu boş olamaz ve ${MAX_BLOB_PATH_LENGTH} karakteri geçemez: ${String(blobPath)}`,
    );
  }
  if (blobPath.includes("\\")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu backslash içeremez (git yolları '/' kullanır): ${blobPath}`,
    );
  }
  if (blobPath.startsWith("-")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu '-' ile başlayamaz (argv seçenek riski): ${blobPath}`,
    );
  }
  if (blobPath.startsWith("/")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu mutlak olamaz: ${blobPath}`,
    );
  }
  if (blobPath.includes(":")) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu ':' içeremez (sürücü harfi / cat-file ayırıcısı): ${blobPath}`,
    );
  }
  for (const segment of blobPath.split("/")) {
    if (segment.length === 0) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob yolu boş segment içeremez (çift veya sondaki '/'): ${blobPath}`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob yolu '.' veya '..' segmenti içeremez: ${blobPath}`,
      );
    }
  }
  for (const character of blobPath) {
    if (character.charCodeAt(0) < 0x20) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        "Blob yolu kontrol karakteri içeremez",
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
 * Git alt sürecine geçilecek daraltılmış ortamı kurar: yalnızca temel çalışma
 * değişkenleri (allowlist) korunur; üst süreçteki gizli anahtar/token'lar
 * miraslanmaz ve sistem git yapılandırması ile etkileşimli istem zorla kapatılır.
 */
export function buildGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const lowerIndex =
    process.platform === "win32"
      ? new Map(Object.entries(sourceEnv).map(([k, v]) => [k.toLowerCase(), v]))
      : null;

  for (const key of GIT_ENV_ALLOWLIST) {
    const raw =
      sourceEnv[key] ??
      (lowerIndex !== null ? lowerIndex.get(key.toLowerCase()) : undefined);
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
  return env;
}

export interface RunGitOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

function mapGitSpawnError(error: unknown, subcommand: string): GraphRepositoryError {
  if (error instanceof GraphRepositoryError) return error;
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (candidate.code === "ENOENT") {
    return new GraphRepositoryError(
      "compare/git-unavailable",
      "git çalıştırılamadı: çalıştırılabilir bulunamadı (PATH)",
    );
  }
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  const detail =
    stderr.length > 0 ? stderr : String(candidate.message ?? String(error));
  return new GraphRepositoryError(
    "compare/git-command-failed",
    `git ${subcommand} başarısız: ${detail}`,
  );
}

/**
 * Salt-okunur git çalıştırması: argv dizisi + alt komut beyaz listesi +
 * alt komut öncesi sertleştirilmiş `-c` yapılandırma geçersiz kılmaları.
 * `args[0]` beyaz listede değilse komut YÜRÜTÜLMEDEN reddedilir; shell
 * her koşulda kapalıdır (shell interpolation imkânsız).
 */
export async function runGit(
  repoRoot: string,
  args: readonly string[],
  options?: RunGitOptions,
): Promise<string> {
  if (!path.isAbsolute(repoRoot)) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot mutlak yol olmalı: ${repoRoot}`,
    );
  }
  const subcommand = args[0];
  if (subcommand === undefined || !GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GraphRepositoryError(
      "compare/git-command-not-allowed",
      `Yalnızca salt-okunur git komutlarına izin var ` +
        `(${[...GIT_ALLOWED_SUBCOMMANDS].join(", ")}); reddedilen: ` +
        `${subcommand === undefined ? "<yok>" : subcommand}`,
    );
  }
  if (subcommand === "rev-parse") {
    if (
      args.length !== 4 ||
      args[1] !== "--verify" ||
      args[2] !== "--end-of-options" ||
      args[3] === undefined
    ) {
      throw new GraphRepositoryError(
        "compare/git-command-not-allowed",
        "git rev-parse yalnızca read-only ['rev-parse', '--verify', '--end-of-options', '<ref>^{commit}'] biçiminde çalıştırılabilir",
      );
    }
    const rawTarget = args[3];
    const refToValidate = rawTarget.endsWith("^{commit}")
      ? rawTarget.slice(0, -"^{commit}".length)
      : rawTarget;
    assertValidGitRef(refToValidate);
  }
  try {
    const result = await execFile(
      "git",
      ["-C", repoRoot, ...GIT_HARDENED_CONFIG_FLAGS, ...args],
      {
        shell: false,
        windowsHide: true,
        env: buildGitEnv(process.env),
        timeout: options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      },
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
      `working-tree bir Git commit ref'i değildir: ${ref}`,
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
        `Ref çözümlenemedi: ${ref} — ${error.message}`,
      );
    }
    throw error;
  }
  const sha = output.trim();
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new GraphRepositoryError(
      "compare/git-unexpected-output",
      `rev-parse geçerli bir commit SHA döndürmedi (${ref}): ${sha}`,
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
      `repoRoot mutlak yol olmalı: ${repoRoot}`,
    );
  }
}

function assertResolvedWithinRepoRoot(repoRoot: string, blobPath: string): string {
  const rootResolved = path.resolve(repoRoot);
  const resolved = path.resolve(repoRoot, blobPath);
  if (resolved === rootResolved || !resolved.startsWith(rootResolved + path.sep)) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu depo köküne haps edilemedi: ${blobPath}`,
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
      `repoRoot bir dizin değil: ${repoRoot}`,
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
      `Ağaç girişi sınırı aşıldı: ${entries.length} > ${maxEntries}`,
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
          `Ağaç listesi tamamlanamadı: ls-tree çıktısı buffer sınırını aştı (ağaç çok büyük) — ${error.message}`,
        );
      }
      if (error.code === "compare/git-command-failed") {
        throw new GraphRepositoryError(
          "compare/ref-not-found",
          `Ref çözümlenemedi: ${ref} — ${error.message}`,
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
        `ls-tree satırında meta/yol ayracı yok: ${line}`,
      );
    }
    const meta = line.slice(0, tab).split(" ");
    const mode = meta[0];
    const type = meta[1];
    const sha = meta[2];
    if (mode === undefined || type === undefined || sha === undefined) {
      throw new GraphRepositoryError(
        "compare/git-unexpected-output",
        `ls-tree satırı beklenen biçimde değil: ${line}`,
      );
    }
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      throw new GraphRepositoryError(
        "compare/git-unexpected-output",
        `Bilinmeyen ls-tree giriş türü: ${type}`,
      );
    }
    entries.push({ mode, type, sha, path: line.slice(tab + 1) });
  }
  if (entries.length > maxEntries) {
    throw new GraphRepositoryError(
      "compare/tree-too-large",
      `Ağaç girişi sınırı aşıldı: ${entries.length} > ${maxEntries}`,
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
      `Çalışma ağacı dosyası bulunamadı: ${blobPath}`,
    );
  }
  if (preLstat.isSymbolicLink()) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu sembolik bağ (bağlar izlenmez): ${blobPath}`,
    );
  }
  if (!preLstat.isFile()) {
    throw new GraphRepositoryError(
      "compare/invalid-blob-path",
      `Blob yolu normal dosya değil: ${blobPath}`,
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
      `Blob yolu sembolik bağ ile depo kökünden dışarı çıkıyor: ${blobPath}`,
    );
  }

  const openFlags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

  let handle;
  try {
    handle = await open(resolved, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new GraphRepositoryError(
        "compare/blob-not-found",
        `Çalışma ağacı dosyası bulunamadı: ${blobPath}`,
      );
    }
    if (code === "ELOOP" || code === "EISDIR") {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Blob yolu normal dosya olarak açılamadı: ${blobPath}`,
      );
    }
    throw error;
  }

  try {
    const openStat = await handle.stat();
    if (!openStat.isFile()) {
      throw new GraphRepositoryError(
        "compare/invalid-blob-path",
        `Açılan blob tanıtıcısı normal dosya değil: ${blobPath}`,
      );
    }
    if (openStat.size > maxBytes) {
      throw new GraphRepositoryError(
        "compare/blob-too-large",
        `Çalışma ağacı dosyası boyut sınırını aşıyor (${openStat.size} > ${maxBytes} bayt): ${blobPath}`,
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
        `Blob yolu açma sonrası doğrulamadan geçemedi (TOCTOU/bağ değişimi): ${blobPath}`,
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
          `Çalışma ağacı dosyası okuma sırasında boyut sınırını aştı (> ${maxBytes} bayt): ${blobPath}`,
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
        `Blob okunamadı: ${ref}:${blobPath} — ${error.message}`,
      );
    }
    throw error;
  }
}
