import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import {
  describeLinkInspectionFailure,
  describeWindowsPathSegmentIssue,
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  LINK_TARGET_INSPECTION_ENABLED,
  pathCrossesLink,
} from "./path-safety.js";

/**
 * OutputAccessPolicy — export_documentation çıktı yetkilendirmesi
 * (TŞ v2.1 §16 "Export güvenliği: yalnızca explicit izinli output dizini,
 * atomik write..."; sprint-3 C6; wiki/mcp-tools.md yazma izin matrisi:
 * "export_documentation: yalnızca explicit izinli output klasörü").
 *
 * WorkspaceAccessPolicy'nin izin kök mantığından BİLEREK bağımsızdır: okuma
 * allowRoot'ları ile yazma output dizinleri ayrı beyan edilir (kullanıcı
 * workspace'i salt okunur kalır; yazma yalnızca kullanıcının ayrıca beyan
 * ettiği output dizinlerine açılır — TŞ kırmızı çizgisi "izinli export dışına
 * dosya yazılmaz").
 *
 * Karar sırası her aday için sabittir (determinizm, TŞ §6):
 *   1. girdi biçimi reddi (boş yol / null byte)
 *   1b. leksik beyan üyeliği: beyanlı dizin dışında yazılmış yol dosya
 *      sistemine dokunulmadan tek sabit gerekçeyle reddedilir (F21 / F73)
 *   2. dizin realpath çözümlemesi (dizin var olmak zorundadır; MCP isteği
 *      tek başına output kökü EKLEYEMEZ — TŞ §9/§20 explicit authorization)
 *   3. beyanlı output dizin listesi üyeliği (comparable, win32 büyük/küçük
 *      harf duyarsız — WorkspaceAccessPolicy ile aynı karşılaştırma kuralı)
 *   4. dosya adı biçimi: ayraç YOK, "." / ".." tam segment reddi
 *      ("a..b" gibi nokta içeren dosya adı geçerlidir — over-deny yok)
 *   5. realpath sarmalama: hedefin gerçek yolu (mevcut dosya/symlink çözümü
 *      veya en derin mevcut ata + kalan segment) beyanlı dizin içinde kalmalı
 *      (CWE-59 symlink/junction escape reddi)
 *
 * MCP hata kodlarına eşleme (dürüstlük notu, denetim sonrası güncel):
 * `workspace/output-not-authorized` TŞ §10.1 sabit kod listesinde YOKTUR;
 * ancak bunun için YENİ bir uzantı kodu (OUTPUT_NOT_AUTHORIZED) İSTENMEDİ —
 * takım denetimi kararıyla MCP yüzeyi bu reddi TŞ §10.1 SABİT kodu
 * EXPORT_NOT_ALLOWED ile raporlar (export yazma yetkilendirmesinin adı ve
 * TŞ §16 konusu tam karşılığıdır; "TŞ listesinde uygun kod yok" önkoşulu
 * sağlanmaz). Eşleme packages/mcp-server/src/services-architecture.ts'te;
 * yönetişim ADR kaydı (wiki/decisions.md) orkestratöre aittir (bu ajan
 * wiki yazamaz).
 */

const IS_WIN = process.platform === "win32";

/** Output policy hata kodları (`workspace/...` ad alanı; MCP eşlemesi üst katman). */
export type OutputPolicyErrorCode =
  /** Beyanlı output dizin listesi geçersiz (boş, null byte, var olmayan dizin). */
  | "workspace/output-policy-invalid"
  /** İstenen dizin kullanıcının beyan ettiği output listesinde değil / çözümlenemedi. */
  | "workspace/output-not-authorized"
  /** Null byte, ayraçlı dosya adı, tam ".." segmenti veya realpath kaçışı. */
  | "workspace/output-path-denied";

/** Output policy hatası; deterministik koşullarda fırlatılır. */
export class OutputPolicyError extends Error {
  constructor(
    readonly code: OutputPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutputPolicyError";
  }
}

export type OutputAllow = {
  readonly allowed: true;
  /** realpath ile çözümlenmiş, beyanlı ve doğrulanmış çıktı dizini. */
  readonly canonicalDir: string;
  /** Yazma hedefinin tam gerçek yolu (authorizeDirectory için canonicalDir ile aynı). */
  readonly canonicalPath: string;
};

export type OutputDeny = {
  readonly allowed: false;
  readonly code: OutputPolicyErrorCode;
  readonly reason: string;
  /** Kararı üreten kural ("separator", "..", "realpath-containment"). */
  readonly rule?: string;
};

export type OutputDecision = OutputAllow | OutputDeny;

/** `\\?\C:\...` öneklerini karşılaştırılabilir forma indirger. */
function stripWin32DevicePrefix(p: string): string {
  if (!IS_WIN) return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** Sarmalama karşılaştırmaları için platform-normalize anahtar (win32 case-insensitive). */
function comparablePath(p: string): string {
  const stripped = stripWin32DevicePrefix(p);
  return IS_WIN ? stripped.toLowerCase() : stripped;
}

/** `target`ın `root` altında (veya root ile aynı) olduğunu belirler. */
function isInside(root: string, target: string): boolean {
  const r = comparablePath(root);
  const t = comparablePath(target);
  if (t === r) return true;
  const boundary = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(boundary);
}

/**
 * Tam ".." segmenti veya mutlak yol kaçışı; "..foo" yasal addır (over-deny yok —
 * WorkspaceAccessPolicy.isLexicalEscape ile aynı boundary-duyarlı kural).
 */
function isLexicalEscape(nativeRelative: string): boolean {
  return (
    nativeRelative === ".." ||
    nativeRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(nativeRelative)
  );
}

function deny(code: OutputPolicyErrorCode, reason: string, rule?: string): OutputDeny {
  return rule === undefined ? { allowed: false, code, reason } : { allowed: false, code, reason, rule };
}

/**
 * The one answer for every output directory outside the declared ones, whatever
 * the filesystem holds there (Claude Security F21 / F73: no existence oracle
 * through the export tools' `outputDir`).
 */
function outputNotDeclared(): OutputDeny {
  return deny(
    "workspace/output-not-authorized",
    "output directory is not in the user-declared output list (explicit authorization required)",
  );
}

/**
 * Mode of a publication temp file, and so of the published file (the mode
 * survives the rename): Node's default 0o666, narrowed by the process umask
 * (0o644 under the usual 022), as for the exports before CAU-08. The security
 * property is the exclusive create of an owned, random-named temp file; an
 * owner-only mode would make shared or served export directories unreadable
 * and tighten an existing export on every re-export.
 */
const PUBLISH_FILE_MODE = 0o666;

/** Filesystem identity of a directory or file (bigint: exact on Windows file ids). */
interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

function identityOf(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

function directoryChanged(dir: string): OutputPolicyError {
  return new OutputPolicyError(
    "workspace/output-path-denied",
    `the output directory changed after authorization (replaced, moved or reached through a link); nothing was published: ${dir}`,
  );
}

/**
 * Identity of `dir` when it is a real directory reached without links: lstat
 * (the last component is not a link or junction) and realpath (no component
 * is) agree that `dir` is itself.
 */
function boundDirectoryIdentity(dir: string): FileIdentity | undefined {
  const stats = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return undefined;
  }
  return comparablePath(real) === comparablePath(dir) ? identityOf(stats) : undefined;
}

/** Removes the temp file only while it is still the file this process created. */
function removeOwnTempFile(tmpPath: string, identity: FileIdentity): void {
  try {
    const current = lstatSync(tmpPath, { bigint: true, throwIfNoEntry: false });
    if (current !== undefined && current.isFile() && sameIdentity(current, identity)) unlinkSync(tmpPath);
  } catch {
    // Best effort: the caller reports the original error.
  }
}

/**
 * Windows-only hardening shared by directory paths and file names: alternate data
 * streams, trailing dots/spaces and reserved device names (NUL, CON, COM1, ...),
 * then UNC/device link targets (lstat/readlink only, before any realpath/stat).
 */
function windowsOutputPathDeny(
  rawPath: string,
  label: string,
  inspectFrom?: {
    readonly absolute: string;
    readonly startDir?: string;
    /** Authorized directories: a link leading out of them is not followed (see inspectLinkTargets). */
    readonly confineTo?: readonly string[];
  },
): OutputDeny | undefined {
  if (IS_WIN) {
    const finding = findWindowsUnsafePathSegment(rawPath);
    if (finding !== undefined) {
      return deny(
        "workspace/output-path-denied",
        `${label}: ${describeWindowsPathSegmentIssue(finding)}`,
        `windows-${finding.issue}`,
      );
    }
  }
  if (LINK_TARGET_INSPECTION_ENABLED && inspectFrom !== undefined) {
    const inspection = inspectLinkTargets(inspectFrom.absolute, {
      ...(inspectFrom.startDir === undefined ? {} : { startDir: inspectFrom.startDir }),
      ...(inspectFrom.confineTo === undefined ? {} : { confineTo: inspectFrom.confineTo }),
    });
    if (!inspection.ok && inspection.reason === "link-leaves-area") {
      return outputNotDeclared();
    }
    if (!inspection.ok) {
      return deny(
        "workspace/output-path-denied",
        `${label}: ${describeLinkInspectionFailure(
          inspection,
          inspectFrom.startDir === undefined ? {} : { within: inspectFrom.startDir },
        )}`,
        inspection.reason,
      );
    }
  }
  return undefined;
}

export class OutputAccessPolicy {
  /** Beyanlı output kökleri; kanonik + leksik sıralı (deterministik dizi). */
  private readonly canonicalDirs: readonly string[];
  /**
   * The authorized area for the lexical gate and the link walk: every declared
   * directory in its declared spelling (inspected in `create`) and in its canonical
   * real path.
   */
  private readonly areaDirs: readonly string[];

  private constructor(canonicalDirs: readonly string[], declaredDirs: readonly string[]) {
    this.canonicalDirs = canonicalDirs;
    this.areaDirs = [...declaredDirs, ...canonicalDirs];
  }

  /**
   * Kullanıcının AÇIK BEYANLI output dizin listesiyle politika kurar
   * (default deny). Her beyan: boş olmayan, null byte içermeyen, diskte VAR
   * OLAN bir dizin olmalı ve realpath'e çözümlenmelidir — çözümlenemeyen kök
   * güven kaynağı olamaz. Beyansız dizin kesinlikle reddedilir.
   */
  static create(allowedOutputDirs: readonly string[]): OutputAccessPolicy {
    if (allowedOutputDirs.length === 0) {
      throw new OutputPolicyError(
        "workspace/output-policy-invalid",
        "the output directory list must not be empty: at least one explicit declaration is required (default deny)",
      );
    }
    // Kanonik gerçek yol → gösterim eşlemesi (aynı hedefe işaret eden
    // tekrarlı beyanlar tek köke indirgenir; ilk beyan kazanır).
    const displayByComparable = new Map<string, string>();
    for (const declared of allowedOutputDirs) {
      if (typeof declared !== "string" || declared.length === 0) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          "an output directory declaration must not be empty",
        );
      }
      if (declared.includes("\0")) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          "an output directory declaration contains a null byte",
        );
      }
      if (isUncOrDevicePath(declared)) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `an output directory declaration must not be a UNC or Win32 device path (rejected before filesystem access): ${declared}`,
        );
      }
      const hardeningDeny = windowsOutputPathDeny(declared, "output directory declaration is not usable", {
        absolute: path.resolve(declared),
      });
      if (hardeningDeny !== undefined) {
        throw new OutputPolicyError("workspace/output-policy-invalid", `${hardeningDeny.reason} (${declared})`);
      }
      let canonical: string;
      try {
        canonical = realpathSync(declared);
      } catch {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output directory could not be resolved to a real path (missing or inaccessible): ${declared}`,
        );
      }
      let isDirectory = true;
      try {
        isDirectory = statSync(canonical).isDirectory();
      } catch {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output directory status could not be read: ${declared}`,
        );
      }
      if (!isDirectory) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output directory declaration is not a directory: ${declared}`,
        );
      }
      const key = comparablePath(canonical);
      if (!displayByComparable.has(key)) {
        displayByComparable.set(key, canonical);
      }
    }
    // Karar üyelik temellidir; dizi leksik sıralı tutulur ki politika
    // örneği (canonicalOutputDirs) deterministik olsun.
    const canonicalDirs = [...displayByComparable.values()].sort((a, b) =>
      comparablePath(a) < comparablePath(b) ? -1 : comparablePath(a) > comparablePath(b) ? 1 : 0,
    );
    return new OutputAccessPolicy(
      canonicalDirs,
      allowedOutputDirs.map((declared) => path.resolve(declared)),
    );
  }

  /** Beyanlı kanonik output kökleri (leksik sıralı, deterministik). */
  get canonicalOutputDirs(): readonly string[] {
    return [...this.canonicalDirs];
  }

  /**
   * Dizin yetkilendirmesi: istenen dizin realpath'e çözümlenir ve beyanlı
   * output köklerinden biri içinde (veya kökle aynı) olmalıdır.
   *
   * The decision is lexical first (Claude Security F21 / F73): a directory not
   * spelled inside a declared output directory (declared or canonical form) gets
   * one fixed answer before any lstat/readlink/realpath. Inside, links are not
   * followed out of the declared directories, and a directory below a link that
   * cannot be resolved gets that same answer, so the export tools' `outputDir`
   * tells nothing about what exists outside the declared directories.
   */
  authorizeDirectory(dirPath: string): OutputDecision {
    if (dirPath.length === 0) {
      return deny("workspace/output-path-denied", "output directory path is empty");
    }
    if (dirPath.includes("\0")) {
      return deny("workspace/output-path-denied", "output directory path contains a null byte");
    }
    if (isUncOrDevicePath(dirPath)) {
      return deny(
        "workspace/output-path-denied",
        "output directory path must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    const label = "output directory path is not usable";
    // Lexical name checks first (no filesystem access).
    const segmentDeny = windowsOutputPathDeny(dirPath, label);
    if (segmentDeny !== undefined) {
      return segmentDeny;
    }
    const lexical = path.resolve(dirPath);
    const area = this.areaDirs.find((areaDir) => isInside(areaDir, lexical));
    if (area === undefined) {
      return outputNotDeclared();
    }
    const linkDeny = windowsOutputPathDeny(dirPath, label, {
      absolute: lexical,
      startDir: area,
      confineTo: this.areaDirs,
    });
    if (linkDeny !== undefined) {
      return linkDeny;
    }
    let canonical: string;
    try {
      canonical = realpathSync(lexical);
    } catch {
      if (pathCrossesLink(lexical, area)) {
        return outputNotDeclared();
      }
      return deny(
        "workspace/output-not-authorized",
        "output directory could not be resolved to a real path (missing or inaccessible); an unverifiable directory cannot be a write target",
      );
    }
    const declared = this.canonicalDirs.find((canonicalDir) => isInside(canonicalDir, canonical));
    if (declared === undefined) {
      return outputNotDeclared();
    }
    return { allowed: true, canonicalDir: canonical, canonicalPath: canonical };
  }

  /**
   * Yazma hedefi yetkilendirmesi: dizin kararı + dosya adı biçimi +
   * realpath sarmalama. `fileName` SAF bir dosya adıdır: ayraç içeremez,
   * "." / ".." tam segmenti olamaz ("rapor..v2.md" geçerlidir).
   */
  authorizeFile(dirPath: string, fileName: string): OutputDecision {
    const dirDecision = this.authorizeDirectory(dirPath);
    if (!dirDecision.allowed) {
      return dirDecision;
    }
    if (fileName.length === 0) {
      return deny("workspace/output-path-denied", "file name is empty");
    }
    if (fileName.includes("\0")) {
      return deny("workspace/output-path-denied", "file name contains a null byte");
    }
    if (isUncOrDevicePath(fileName)) {
      return deny(
        "workspace/output-path-denied",
        "file name must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    if (fileName.includes("/") || fileName.includes("\\")) {
      return deny(
        "workspace/output-path-denied",
        "file name must not contain a path separator (writing to subdirectories is not allowed)",
        "separator",
      );
    }
    if (fileName === "." || fileName === "..") {
      return deny(
        "workspace/output-path-denied",
        "file name must not be '.' or '..' (path traversal rejected)",
        "..",
      );
    }
    const absolute = path.resolve(dirDecision.canonicalDir, fileName);
    const relative = path.relative(dirDecision.canonicalDir, absolute);
    if (isLexicalEscape(relative)) {
      return deny(
        "workspace/output-path-denied",
        "write target escapes the declared directory after lexical resolution",
        "..",
      );
    }
    // Windows name aliases in the file name, and a write target that is itself a
    // link to a UNC/device path (a write would follow it to the network).
    const hardeningDeny = windowsOutputPathDeny(fileName, "file name is not usable", {
      absolute,
      startDir: dirDecision.canonicalDir,
    });
    if (hardeningDeny !== undefined) {
      return hardeningDeny;
    }
    // realpath sarmalama (CWE-59): mevcut dosya/symlink kendisiyle çözülür;
    // henüz var olmayan hedef için en derin mevcut ata + kalan segment —
    // bu hedef yalnızca son bileşendir (ayraç reddedildi), yine de kural
    // sabit uygulanır.
    const resolved = this.resolveRealpath(absolute);
    if (resolved === undefined) {
      return deny("workspace/output-path-denied", "the real path of the write target could not be resolved");
    }
    if (!isInside(dirDecision.canonicalDir, resolved)) {
      return deny(
        "workspace/output-path-denied",
        "the real path of the write target (symlink/junction) escapes the declared directory",
        "realpath-containment",
      );
    }
    return {
      allowed: true,
      canonicalDir: dirDecision.canonicalDir,
      canonicalPath: resolved,
    };
  }

  /**
   * Publishes `content` at a target authorized by {@link authorizeFile}
   * (CAU-08). Call it right after the authorization:
   * 1. the target's directory is bound: its identity (dev, ino) is taken,
   *    and it must be a real directory reached without links;
   * 2. the content goes to a temp file this call creates itself in that
   *    directory: crypto-random name, `wx` (O_CREAT|O_EXCL, an existing entry
   *    is never followed or reused), mode 0o666 narrowed by the umask (the
   *    published file's mode, as for any file the process writes);
   * 3. right after the temp file is created (before any content is written)
   *    and again just before the atomic rename, the directory must still be
   *    the bound one and the entry at the temp path in it must be the file
   *    the descriptor from step 2 refers to (fstat identity). Otherwise the
   *    publication is refused.
   * On failure only that temp file is removed, and only while it is still the
   * file this call created; a file it did not create is never removed.
   *
   * The bind is taken here rather than inside authorizeFile: callers invoke
   * this right after authorizeFile, and a directory replaced before the bind
   * must still be a real, link-free directory at the authorized canonical
   * path, so it cannot lead outside the declared output roots.
   *
   * Throws OutputPolicyError (`workspace/output-not-authorized` for a
   * decision outside this policy, `workspace/output-path-denied` when the
   * directory or temp file changed); filesystem errors are passed through.
   * Residuals: Node has no openat(2)/renameat(2)/unlinkat(2), so a swap in
   * the few instructions between a check and the open, rename or cleanup is
   * not detectable here; a temp file created through a directory swapped for
   * a link and back stays (empty) where the link pointed, since removing it
   * by a path outside the bound directory is not safe. Identity is (dev, ino),
   * so a file that replaces a deleted temp file and reuses its inode number
   * looks like the temp file.
   */
  publishFile(decision: OutputAllow, content: string): void {
    const targetPath = decision.canonicalPath;
    const targetDir = path.dirname(targetPath);
    if (
      !decision.allowed ||
      !isInside(decision.canonicalDir, targetDir) ||
      !this.canonicalDirs.some((canonicalDir) => isInside(canonicalDir, targetDir))
    ) {
      throw new OutputPolicyError(
        "workspace/output-not-authorized",
        "the write target was not authorized by this output policy (explicit authorization required)",
      );
    }
    const directory = boundDirectoryIdentity(targetDir);
    if (directory === undefined) throw directoryChanged(targetDir);

    const tmpPath = path.join(targetDir, `.${path.basename(targetPath)}.${randomBytes(12).toString("hex")}.tmp`);
    const fd = openSync(tmpPath, "wx", PUBLISH_FILE_MODE);
    let temp: FileIdentity | undefined;
    let closed = false;
    const assertDirectoryUnchanged = (): void => {
      const current = boundDirectoryIdentity(targetDir);
      if (current === undefined || current.dev !== directory.dev || current.ino !== directory.ino) {
        throw directoryChanged(targetDir);
      }
    };
    const assertTempInPlace = (created: FileIdentity): void => {
      const tempNow = lstatSync(tmpPath, { bigint: true, throwIfNoEntry: false });
      if (tempNow === undefined || !tempNow.isFile() || !sameIdentity(tempNow, created)) {
        throw new OutputPolicyError(
          "workspace/output-path-denied",
          `the temporary export file is not the one this export created in the output directory (replaced, or created through a replaced directory); nothing was published: ${targetPath}`,
        );
      }
    };
    try {
      temp = identityOf(fstatSync(fd, { bigint: true }));
      // A swap between the bind and the open would have created the temp file
      // elsewhere: refuse before any content is written there. The directory
      // check alone misses a swap that was undone again; the entry at the temp
      // path in the bound directory must also be the opened descriptor's file.
      assertDirectoryUnchanged();
      assertTempInPlace(temp);
      writeFileSync(fd, content, "utf8");
      closed = true;
      closeSync(fd);
      assertDirectoryUnchanged();
      assertTempInPlace(temp);
      renameSync(tmpPath, targetPath);
    } catch (error) {
      if (!closed) {
        try {
          closeSync(fd);
        } catch {
          // The original error is reported below.
        }
      }
      // Without a known identity the temp file cannot be told apart from a
      // replacement, so it is left in place rather than risk removing one.
      if (temp !== undefined) removeOwnTempFile(tmpPath, temp);
      throw error;
    }
  }

  /**
   * realpath çözümlemesi: aday varsa kendisi; yoksa en derin mevcut atanın
   * gerçek yolu + kalan segmentler (WorkspaceAccessPolicy ile aynı strateji;
   * planlanan dosya symlink'li ata üzerinden kaçışa kapatıktır).
   */
  private resolveRealpath(absolutePath: string): string | undefined {
    try {
      return realpathSync(absolutePath);
    } catch {
      // yok: ata zincirinde ilerle
    }
    let prefix = absolutePath;
    const missing: string[] = [];
    for (;;) {
      const parent = path.dirname(prefix);
      const base = path.basename(prefix);
      if (parent === prefix) {
        return undefined;
      }
      missing.unshift(base);
      prefix = parent;
      try {
        return path.join(realpathSync(prefix), ...missing);
      } catch {
        // ata da yok: zincire devam
      }
    }
  }
}
