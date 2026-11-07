import { lstat, readFile, stat } from "node:fs/promises";
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
  "sourceRevision.dirty üretilmedi: HEAD çözümlemesi yalnızca salt-okunur dosya okumasıyla yapılır (komut çalıştırma yok); dirty bilgisi doğrulanabilir girdiyle manifest input'unda verilebilir";

/**
 * Ref adı doğrulaması: beyaz liste desenine uymayan ad reddedilir.
 */
function assertSafeRefName(refName: string): string {
  if (!SAFE_REF_NAME_PATTERN.test(refName) || refName.includes("..")) {
    throw new Error(`güvensiz ref adı reddedildi: ${JSON.stringify(refName)}`);
  }
  return refName;
}

/** ref dosyası yolunun gitDir içinde kaldığını sözel + segment düzeyinde doğrular. */
function assertRefPathWithinGitDir(gitDir: string, refName: string): string {
  const refPath = path.join(gitDir, ...refName.split("/"));
  const relative = path.relative(gitDir, refPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`ref yolu gitDir dışına çıkıyor: ${refName}`);
  }
  return refPath;
}

type GitDirResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported-outside-root" }
  | { readonly kind: "ok"; readonly gitDir: string };

/**
 * Kota denetimli metin okuma: dosya yoksa metin değil; boyutu kota üstündeyse
 * OKUNMAZ ve aşım notlar'a yazılır (TŞ §19; sessiz okuma yok). Return
 * undefined hem "yok" hem "kota aşıldı" için mümkündür — ayrım notes'tadır.
 */
async function readTextWithinQuota(
  filePath: string,
  label: string,
  notes: string[],
): Promise<string | undefined> {
  const fileStat = await stat(filePath).catch(() => undefined);
  if (fileStat === undefined || !fileStat.isFile()) return undefined;
  if (fileStat.size > MAX_GIT_METADATA_BYTES) {
    notes.push(
      `${label} boyut kotası aşıldı (${String(fileStat.size)} bayt > ${String(MAX_GIT_METADATA_BYTES)}); TŞ §19 kaynak tüketimi sınırı gereği okuma yapılmadı`,
    );
    return undefined;
  }
  return readFile(filePath, "utf8").catch(() => undefined);
}

/** gitdir çözümlemesi: .git dizin olabilir veya "gitdir:" satırlı dosya. */
async function resolveGitDir(
  repoRoot: string,
  notes: string[],
): Promise<GitDirResolution> {
  const dotGit = path.join(repoRoot, ".git");
  const dotGitStat = await lstat(dotGit).catch(() => undefined);
  if (dotGitStat === undefined) return { kind: "missing" };
  if (dotGitStat.isDirectory()) return { kind: "ok", gitDir: dotGit };
  if (!dotGitStat.isFile()) return { kind: "missing" };
  const content = await readTextWithinQuota(dotGit, ".git işaretçi dosyası", notes);
  if (content === undefined) return { kind: "missing" };
  const match = content.match(/^gitdir:\s*(.+)\s*$/m);
  const gitdir = match?.[1]?.trim();
  if (gitdir === undefined || gitdir.length === 0) return { kind: "missing" };
  const resolved = path.isAbsolute(gitdir) ? path.normalize(gitdir) : path.resolve(repoRoot, gitdir);
  const resolvedStat = await stat(resolved).catch(() => undefined);
  if (resolvedStat === undefined || !resolvedStat.isDirectory()) return { kind: "missing" };
  // gitdir kök İÇİNE çözülmeli (submodule/worktree için güvenli biçim);
  // kök dışına çıkan gitdir gösterimi bu çekirdekte desteklenmez.
  const relativeToRoot = path.relative(repoRoot, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return { kind: "unsupported-outside-root" };
  }
  return { kind: "ok", gitDir: resolved };
}

/** Ref dosyasından SHA okur; yoksa/geçersizse/kota üstündeyse undefined. */
async function readRefFile(
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
  const content = await readTextWithinQuota(refPath, "ref dosyası", notes);
  if (content === undefined) return undefined;
  const sha = content.trim();
  return HEAD_SHA_PATTERN.test(sha) ? sha.toLowerCase() : undefined;
}

/** packed-refs içinde ref'i arar (ref dosyası yoksa: paketlenmiş dallar). */
async function readPackedRef(
  gitDir: string,
  refName: string,
  notes: string[],
): Promise<string | undefined> {
  if (!SAFE_REF_NAME_PATTERN.test(refName)) return undefined;
  const packedRefsPath = path.join(gitDir, "packed-refs");
  const content = await readTextWithinQuota(packedRefsPath, "packed-refs", notes);
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
  gitDir: string,
  notes: string[],
): Promise<string | undefined> {
  const headPath = path.join(gitDir, "HEAD");
  const head = await readTextWithinQuota(headPath, ".git/HEAD", notes);
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
  const direct = await readRefFile(gitDir, refName, notes);
  if (direct !== undefined) return direct;
  return readPackedRef(gitDir, refName, notes);
}

const NOT_A_GIT_REPO_NOTE =
  "sourceRevision çözülemedi: kök bir git deposu değil (.git yok); manifest kaynak revizyonsuz üretildi";

const GITDIR_OUTSIDE_ROOT_NOTE =
  "sourceRevision çözülemedi: .git dosyasındaki gitdir gösterimi repo kökü dışına çözülüyor; bu biçim desteklenmiyor";

const HEAD_UNRESOLVED_NOTE =
  "sourceRevision çözülemedi: .git/HEAD okunamadı veya işaret ettiği ref çözümlenemedi (detached/ref/packed-refs); manifest kaynak revizyonsuz üretildi";

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
      `resolveSourceRevision: repoRoot mutlak yol olmalı: ${String(repoRoot)}`,
    );
  }
  const rootStat = await stat(repoRoot).catch(() => undefined);
  if (rootStat === undefined || !rootStat.isDirectory()) {
    throw new Error(
      `resolveSourceRevision: repoRoot bir dizin değil: ${repoRoot}`,
    );
  }

  // Kota/okuma notları: deterministik sırada toplanır ve limitation olarak
  // raporlanır (sessiz okuma yok — TŞ §19 dürüstlük ilkesi).
  const notes: string[] = [];
  const gitDirResolution = await resolveGitDir(repoRoot, notes);
  if (gitDirResolution.kind === "missing") {
    return {
      sourceRevision: undefined,
      limitations: [NOT_A_GIT_REPO_NOTE, ...notes].sort(cmpTr),
    };
  }
  if (gitDirResolution.kind === "unsupported-outside-root") {
    return {
      sourceRevision: undefined,
      limitations: [GITDIR_OUTSIDE_ROOT_NOTE, ...notes].sort(cmpTr),
    };
  }

  const head = await resolveHeadSha(gitDirResolution.gitDir, notes);
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
