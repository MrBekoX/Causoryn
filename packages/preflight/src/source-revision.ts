import { Buffer } from "node:buffer";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { PreflightSourceRevision } from "./manifest.js";

/**
 * sourceRevision çözümleyici — sprint-5 D4 (TŞ v2.1 §10.3
 * "sourceRevision": {"kind":"working-tree","head":"abc123","dirty":true}).
 *
 * SALT-OKUNUR SÖZLEŞME (kırmızı çizgiler; ADR-008): bu modül çalışma ağacına
 * ve git nesne veritabanına YAZMAZ ve hiçbir ALT KOMUT ÇALIŞTIRMAZ. HEAD
 * çözümlemesi tamamen DOSYA OKUMASIYLA yapılır (.git/HEAD → ref dosyası /
 * packed-refs). graph/src/git-read.ts'in alt komut beyaz listesi
 * (yalnızca ls-tree/cat-file) gibi, bu modülün de spawn yüzeyi YOKTUR.
 *
 * TŞ §10.3 `dirty` alanı bu modülde bilinçli olarak ÜRETİLMEZ (K-012/K-014
 * bilinçli-kullanmama örüntüsü): dirty tespiti için gerekli `git status`,
 * repoda onaylı alt komut beyaz listesinde yer almaz ve komut çalıştırma
 * yüzeyi açmak istenmedi. dirty bilgisi, doğrulanabilir girdi olarak
 * manifest input'unda (PreflightManifestInput.sourceRevision.dirty)
 * sağlanabilir; çekirdek doğrular ve aynen taşır. Bu sınır her başarılı
 * çözümlemede limitation olarak raporlanır (sessiz eksiklik yok).
 *
 * YOL ENJEKSİYONU SÖZLEŞMESİ (TŞ §19 tehdit modeli: depo güvenilmez
 * veridir):
 * - Alt komut çalıştırma YOKTUR; dolayısıyla komut enjeksiyonu yüzeyi yoktur.
 * - .git/HEAD'ten okunan ref adı beyaz liste deseniyle (refs/ + güvenli
 *   karakter kümesi) doğrulanır; ref dosyası yolu gitDir İÇİNE haps edilir
 *   (path.relative sarmalama denetimi — git-read.ts
 *   assertResolvedWithinRepoRoot örüntüsü).
 * - "gitdir:" dosya gösterimi yalnızca repoRoot İÇİNE çözülen gitdir için
 *   kabul edilir; kök dışına çıkan gitdir desteklenmez (limitation ile).
 * - Path hardening: the gitdir pointer text is checked for network/device
 *   forms and lexical containment BEFORE any filesystem call on its target.
 *   Every git metadata path (gitdir, HEAD, ref files, packed-refs) is
 *   lstat'ed component by component below the canonical root: a symbolic
 *   link (or junction) anywhere on the way is not followed, and the opened
 *   handle must be the file that was checked (dev/ino).
 *
 * Dürüstlük sınırları:
 * - git'siz workspace: hata DEĞİLDİR — sourceRevision yok + limitations ile
 *   döner (manifest çekirdeği revizyonsuz manifest üretebilir).
 * - ref dosyası/packed-refs okunamazsa head çözülemez ve dürüst limitation
 *   ile döner; asla uydurma SHA üretilmez.
 */

/** Git commit SHA'sı: SHA-1 (40 hex) veya SHA-256 depoları (64 hex). */
const HEAD_SHA_PATTERN = /^[0-9a-fA-F]{40,64}$/;

/**
 * Git metadata okuma kotası — TŞ §19 "Aşırı büyük repo / kaynak tüketimi →
 * Limit" politikası (depo güvenilmez veridir). packages/contracts
 * parse-safety.ts MAX_SPEC_BYTES (1 MiB) örüntüsüyle hizalı: .git işaretçi
 * dosyası, HEAD, ref dosyası ve packed-refs bu kota üstündeyse hiç
 * okunmaz ve aşım limitation olarak raporlanır (sessiz okuma yok,
 * uydurma telafi yok).
 */
const MAX_GIT_METADATA_BYTES = 1024 * 1024;
const MAX_GIT_METADATA_LABEL = "1 MiB";

/**
 * Network (UNC) and device path forms (`\\host\share`, `//host/share`,
 * `\\?\`, `\\.\`, `\??\`): never accessed. Same forms as
 * packages/graph/src/git-repository-layout.ts isNetworkOrDevicePath.
 */
const NETWORK_OR_DEVICE_PREFIX = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;

function isUnsupportedPointerText(value: string): boolean {
  return (
    value.includes("\0") ||
    NETWORK_OR_DEVICE_PREFIX.test(value) ||
    (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(value))
  );
}

/** Strict lexical containment (case-insensitive on win32 via path.relative). */
function isStrictlyInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

type ComponentCheck =
  | { readonly status: "ok"; readonly final: Stats }
  | { readonly status: "missing" }
  | { readonly status: "link" }
  | { readonly status: "outside" };

/**
 * lstat's every component of `target` below the canonical `realRoot`
 * without following links: a symbolic link (or junction) on the way is
 * reported, never traversed.
 */
async function checkComponentsBelowRoot(realRoot: string, target: string): Promise<ComponentCheck> {
  if (!isStrictlyInside(target, realRoot)) return { status: "outside" };
  const parts = path
    .relative(realRoot, target)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
  let current = realRoot;
  let final: Stats | undefined;
  for (const part of parts) {
    current = path.join(current, part);
    final = await lstat(current).catch(() => undefined);
    if (final === undefined) return { status: "missing" };
    if (final.isSymbolicLink()) return { status: "link" };
  }
  return final === undefined ? { status: "missing" } : { status: "ok", final };
}

/**
 * Ref adı beyaz listesi: yalnızca "refs/" ile başlayan, güvenli karakter
 * kümesine uyan adlar kabul edilir (git ref-name kurallarından uyarlanmış
 * ek retler: "..", "@{", sondaki "/", ".lock" — git-read.ts REF_PATTERN
 * örüntüsüyle aynı ilke). Eşleşmeyen her ad reddedilir.
 */
const SAFE_REF_NAME_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,240}$/;

/** resolveSourceRevision sonucu: revizyon + dürüst sınırlama notları. */
export interface SourceRevisionResolution {
  /** Git deposu çözülebildiyse kayıt; aksi halde undefined. */
  readonly sourceRevision: PreflightSourceRevision | undefined;
  /** Neden revizyon/dirty eksikse onu söyleyen notlar (deterministik sırada). */
  readonly limitations: readonly string[];
}

/** Kod noktası sıralaması (localeCompare ASLA yok — TŞ §8 invariant vi). */
function cmpTr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Bilinçli sınırın sabit gerekçesi: her başarılı çözümlemede limitation
 * olarak raporlanır (sessiz eksiklik yok; K-012 örüntüsü).
 */
const DIRTY_NOT_DETERMINED_NOTE =
  "sourceRevision.dirty not determined: HEAD is resolved only by read-only file reads (no commands are run); a verifiable dirty value can be supplied in the manifest input";

/**
 * Ref adı doğrulaması: beyaz liste desenine uymayan ad reddedilir.
 */
function assertSafeRefName(refName: string): string {
  if (!SAFE_REF_NAME_PATTERN.test(refName) || refName.includes("..")) {
    throw new Error(`unsafe ref name rejected: ${JSON.stringify(refName)}`);
  }
  return refName;
}

/** ref dosyası yolunun gitDir içinde kaldığını sözel + segment düzeyinde doğrular. */
function assertRefPathWithinGitDir(gitDir: string, refName: string): string {
  const refPath = path.join(gitDir, ...refName.split("/"));
  const relative = path.relative(gitDir, refPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`ref path escapes gitDir: ${refName}`);
  }
  return refPath;
}

type GitDirResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported-outside-root" }
  | { readonly kind: "unsupported-link" }
  | { readonly kind: "unsupported-path-form" }
  | { readonly kind: "ok"; readonly gitDir: string };

const READ_CHUNK_BYTES = 64 * 1024;

function quotaNote(label: string): string {
  return `${label} exceeds the size quota (the ${MAX_GIT_METADATA_LABEL} limit); not read because of the resource consumption limit`;
}

/**
 * Kota denetimli fd tabanlı metin okuma: dosya yoksa metin değil; boyutu kota
 * üstündeyse OKUNMAZ (ve okuma sırasında büyüse dahi kota+1 baytla sınırlı
 * kalır) ve aşım notlar'a yazılır (TŞ §19; sessiz okuma yok, TOCTOU yarış
 * penceresi yok). Return undefined hem "yok" hem "kota aşıldı" için
 * mümkündür — ayrım notes'tadır.
 * The path must lie below the canonical root with no symbolic link on the
 * way (checked with lstat before opening), and the opened handle must be the
 * checked file (dev/ino), so a link is never followed on any platform.
 */
async function readTextWithinQuota(
  realRoot: string,
  filePath: string,
  label: string,
  notes: string[],
): Promise<string | undefined> {
  const check = await checkComponentsBelowRoot(realRoot, filePath);
  if (check.status === "link") {
    notes.push(
      `${label} was not read: its path inside the repository passes through a symbolic link, and links are not followed`,
    );
    return undefined;
  }
  if (check.status !== "ok" || !check.final.isFile()) return undefined;
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, openFlags).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const fileStat = await handle.stat().catch(() => undefined);
    if (fileStat === undefined || !fileStat.isFile()) return undefined;
    if (
      fileStat.ino !== 0 &&
      check.final.ino !== 0 &&
      (fileStat.dev !== check.final.dev || fileStat.ino !== check.final.ino)
    ) {
      return undefined; // replaced between the check and the open
    }
    if (fileStat.size > MAX_GIT_METADATA_BYTES) {
      notes.push(quotaNote(label));
      return undefined;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const hardCap = MAX_GIT_METADATA_BYTES + 1;
    while (totalBytes < hardCap) {
      const toRead = Math.min(READ_CHUNK_BYTES, hardCap - totalBytes);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(chunk, 0, toRead, null);
      if (bytesRead <= 0) break;
      chunks.push(bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_GIT_METADATA_BYTES) {
      notes.push(quotaNote(label));
      return undefined;
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * gitdir çözümlemesi: .git dizin olabilir veya "gitdir:" satırlı dosya.
 * `realRoot` is the canonical root. The pointer text is checked (network /
 * device / drive-relative forms, lexical containment) before any filesystem
 * call on its target; the target is then lstat'ed component by component.
 */
async function resolveGitDir(
  realRoot: string,
  notes: string[],
): Promise<GitDirResolution> {
  const dotGit = path.join(realRoot, ".git");
  const dotGitStat = await lstat(dotGit).catch(() => undefined);
  if (dotGitStat === undefined) return { kind: "missing" };
  if (dotGitStat.isSymbolicLink()) return { kind: "unsupported-link" };
  if (dotGitStat.isDirectory()) return { kind: "ok", gitDir: dotGit };
  if (!dotGitStat.isFile()) return { kind: "missing" };
  const content = await readTextWithinQuota(realRoot, dotGit, ".git pointer file", notes);
  if (content === undefined) return { kind: "missing" };
  const match = content.match(/^gitdir:\s*(.+)\s*$/m);
  const gitdir = match?.[1]?.trim();
  if (gitdir === undefined || gitdir.length === 0) return { kind: "missing" };
  if (isUnsupportedPointerText(gitdir)) return { kind: "unsupported-path-form" };
  // Lexical resolution only: no filesystem call on the target yet.
  const resolved = path.resolve(realRoot, gitdir);
  // gitdir kök İÇİNE çözülmeli (submodule/worktree için güvenli biçim);
  // kök dışına çıkan gitdir gösterimi bu çekirdekte desteklenmez.
  if (!isStrictlyInside(resolved, realRoot)) return { kind: "unsupported-outside-root" };
  const check = await checkComponentsBelowRoot(realRoot, resolved);
  if (check.status === "link") return { kind: "unsupported-link" };
  if (check.status !== "ok" || !check.final.isDirectory()) return { kind: "missing" };
  const realGitDir = await realpath(resolved).catch(() => undefined);
  if (realGitDir === undefined || !isStrictlyInside(realGitDir, realRoot)) {
    return { kind: "unsupported-outside-root" };
  }
  return { kind: "ok", gitDir: resolved };
}

/** Ref dosyasından SHA okur; yoksa/geçersizse/kota üstündeyse undefined. */
async function readRefFile(
  realRoot: string,
  gitDir: string,
  refName: string,
  notes: string[],
): Promise<string | undefined> {
  let refPath: string;
  try {
    refPath = assertRefPathWithinGitDir(gitDir, assertSafeRefName(refName));
  } catch {
    return undefined; // güvenlik reddi: ref okunmaz, hata olarak yayılmaz
  }
  const content = await readTextWithinQuota(realRoot, refPath, "ref file", notes);
  if (content === undefined) return undefined;
  const sha = content.trim();
  return HEAD_SHA_PATTERN.test(sha) ? sha.toLowerCase() : undefined;
}

/** packed-refs içinde ref'i arar (ref dosyası yoksa: paketlenmiş dallar). */
async function readPackedRef(
  realRoot: string,
  gitDir: string,
  refName: string,
  notes: string[],
): Promise<string | undefined> {
  if (!SAFE_REF_NAME_PATTERN.test(refName)) return undefined;
  const packedRefsPath = path.join(gitDir, "packed-refs");
  const content = await readTextWithinQuota(realRoot, packedRefsPath, "packed-refs", notes);
  if (content === undefined) return undefined;
  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const sha = line.slice(0, space);
    const name = line.slice(space + 1).trim();
    if (name === refName && HEAD_SHA_PATTERN.test(sha)) return sha.toLowerCase();
  }
  return undefined;
}

/**
 * HEAD'in işaret ettiği commit SHA'sını salt-okunur dosya okumalarıyla
 * çözer. Detached HEAD (doğrudan SHA) ve ref biçimini destekler; ref
 * dosyası yoksa packed-refs'e düşer. Çözülemezse undefined.
 */
async function resolveHeadSha(
  realRoot: string,
  gitDir: string,
  notes: string[],
): Promise<string | undefined> {
  const headPath = path.join(gitDir, "HEAD");
  const head = await readTextWithinQuota(realRoot, headPath, ".git/HEAD", notes);
  if (head === undefined) return undefined;
  const trimmed = head.trim();
  const refMatch = trimmed.match(/^ref:\s+(.+)$/);
  if (refMatch === null) {
    // Detached HEAD: doğrudan SHA.
    return HEAD_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
  }
  const refName = refMatch[1]?.trim() ?? "";
  try {
    assertSafeRefName(refName);
  } catch {
    return undefined; // güvenlik reddi: çözümleme yapılmaz, uydurma yok
  }
  const direct = await readRefFile(realRoot, gitDir, refName, notes);
  if (direct !== undefined) return direct;
  return readPackedRef(realRoot, gitDir, refName, notes);
}

const NOT_A_GIT_REPO_NOTE =
  "sourceRevision not resolved: the root is not a git repository (no .git); the manifest was built without a source revision";

const GITDIR_OUTSIDE_ROOT_NOTE =
  "sourceRevision not resolved: the gitdir pointer in the .git file resolves outside the repository root; this layout is not supported";

const GITDIR_LINK_NOTE =
  "sourceRevision not resolved: the .git entry or its gitdir pointer passes through a symbolic link inside the repository; links are not followed";

const GITDIR_PATH_FORM_NOTE =
  "sourceRevision not resolved: the gitdir pointer in the .git file names a network or device path or a drive-relative path; it is not accessed";

const HEAD_UNRESOLVED_NOTE =
  "sourceRevision not resolved: .git/HEAD could not be read or the ref it points to could not be resolved (detached/ref/packed-refs); the manifest was built without a source revision";

/**
 * Çalışma ağacının kaynak revizyonunu çözer:
 * - head: .git dosya okumalarıyla (salt-okunur; komut yok).
 * - dirty: ÜRETİLMEZ (bilinçli sınır; DIRTY_NOT_DETERMINED_NOTE'a bakın).
 *   Girdiyle sağlanabilir; uydurulmaz.
 * - git'siz kök: hata değil; sourceRevision=undefined + limitation.
 */
export async function resolveSourceRevision(
  repoRoot: string,
): Promise<SourceRevisionResolution> {
  if (typeof repoRoot !== "string" || repoRoot.length === 0 || !path.isAbsolute(repoRoot)) {
    throw new Error(
      `resolveSourceRevision: repoRoot must be an absolute path: ${String(repoRoot)}`,
    );
  }
  const rootStat = await stat(repoRoot).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new Error(
      `resolveSourceRevision: repoRoot is not a directory: ${repoRoot}`,
    );
  }
  // Canonical root: every metadata path below is checked against it.
  const realRoot = await realpath(repoRoot);

  // Kota/okuma notları: deterministik sırada toplanır ve limitation olarak
  // raporlanır (sessiz okuma yok — TŞ §19 dürüstlük ilkesi).
  const notes: string[] = [];
  const gitDirResolution = await resolveGitDir(realRoot, notes);
  const unresolvedNote: Record<Exclude<GitDirResolution["kind"], "ok">, string> = {
    missing: NOT_A_GIT_REPO_NOTE,
    "unsupported-outside-root": GITDIR_OUTSIDE_ROOT_NOTE,
    "unsupported-link": GITDIR_LINK_NOTE,
    "unsupported-path-form": GITDIR_PATH_FORM_NOTE,
  };
  if (gitDirResolution.kind !== "ok") {
    return {
      sourceRevision: undefined,
      limitations: [unresolvedNote[gitDirResolution.kind], ...notes].sort(cmpTr),
    };
  }

  const head = await resolveHeadSha(realRoot, gitDirResolution.gitDir, notes);
  if (head === undefined) {
    return {
      sourceRevision: undefined,
      limitations: [HEAD_UNRESOLVED_NOTE, ...notes].sort(cmpTr),
    };
  }

  // Bilinçli sınır raporlanır: dirty üretilmedi (komut çalıştırma yok).
  return {
    sourceRevision: { kind: "working-tree", head },
    limitations: [DIRTY_NOT_DETERMINED_NOTE],
  };
}
