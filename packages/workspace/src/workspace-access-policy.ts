import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { findMatchingIgnorePattern } from "./ignore-matcher.js";
import {
  describeLinkInspectionFailure,
  describeWindowsPathSegmentIssue,
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  LINK_TARGET_INSPECTION_ENABLED,
} from "./path-safety.js";
import {
  effectiveIgnorePatterns,
  parseWorkspacePolicyConfig,
  type WorkspacePolicyConfig,
} from "./policy-config.js";
import { WorkspacePolicyError, type PolicyErrorCode } from "./policy-error.js";

/**
 * WorkspaceAccessPolicy — Workspace Gateway'in erişim karar mercii
 * (TŞ v2.1 §5 WorkspaceAccess modülü, §9 "explicit izin olmadan indeksleme
 * başlamaz", §19 tehdit modeli, §25/2; sprint-1 görev 2).
 *
 * Karar sırası her aday için sabittir (determinizm, TŞ §6):
 *   1. kök yetkilendirmesi (realpath canonicalization + allowlist)
 *   2. null byte reddi
 *   3. leksik `..`/mutlak yol sarmalama kontrolü (OWASP normalize)
 *   4. ignore kuralları (atalar dahil)
 *   5. realpath (symlink/junction) sarmalama kontrolü (CWE-59; TŞ §19)
 *   5b. kanonik gerçek yola ignore kurallarının YENİDEN uygulanması
 *       (kök-içi symlink'in secret-deny listini bypass etmesi engellenir)
 *   6. uzantı filtresi + boyut limiti (yalnızca checkFile)
 *
 * TŞ §19 "file handle sonrası path tekrar kontrolü" SÖZLEŞMESİ: bu sınıfın
 * kararları dosya açılışından ÖNCE üretilir; realpath ile check arasındaki
 * TOCTOU penceresi bu modülde kapatılamaz. Dosyayı açan katman (file
 * inventory / indexing) açma sonrası dosyanın gerçek yolunu bu politika
 * üzerinden YENİDEN denetlemek ZORUNDADIR — bu gereklilik downstream kabul
 * ölçütüdür ve backlog'a işlenmelidir (bkz. sprint görevleri).
 */

const IS_WIN = process.platform === "win32";

/**
 * Volumes that alias names (Windows 8.3 short names and letter case, macOS letter
 * case) need ignore rules re-applied to the native canonical long-name path:
 * `fs.realpathSync` keeps the spelling it was given (`GIT~1`, `.GIT`), while
 * `fs.realpathSync.native` reports the name stored on disk.
 */
const CHECK_NATIVE_NAME_ALIASES = IS_WIN || process.platform === "darwin";

/** Upper bound for the per-instance root caches (roots are few in practice). */
const ROOT_CACHE_CAP = 256;

function nativeRealpath(target: string): string {
  // Mocked `node:fs` modules may not carry `.native`; fall back to the JS realpath.
  const native = (realpathSync as { native?: (p: string) => string }).native;
  return typeof native === "function" ? native(target) : realpathSync(target);
}

function rememberBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= ROOT_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export type PolicyAllow = {
  readonly allowed: true;
  /** realpath ile çözümlenmiş, doğrulanmış kök. */
  readonly canonicalRoot: string;
  /** POSIX ayraçlı kök-göreceli yol; kök kendisi için ".". */
  readonly relativePath: string;
};

export type PolicyDeny = {
  readonly allowed: false;
  readonly code: PolicyErrorCode;
  readonly reason: string;
  /** Kararı üreten kural (ignore deseni, uzantı, "maxFileBytes"). */
  readonly rule?: string;
};

export type PolicyDecision = PolicyAllow | PolicyDeny;

function deny(code: PolicyErrorCode, reason: string, rule?: string): PolicyDeny {
  return rule === undefined ? { allowed: false, code, reason } : { allowed: false, code, reason, rule };
}

/** `\\?\C:\...` ve `\\?\UNC\srv\share` öneklerini karşılaştırılabilir forma indirger. */
function stripWin32DevicePrefix(p: string): string {
  if (!IS_WIN) return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** Sarmalama karşılaştırmaları için platform-normalize anahtar üretir. */
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

function toPosixRelative(nativeRelative: string): string {
  const posix = nativeRelative.split(path.sep).join("/");
  return posix.length === 0 ? "." : posix;
}

/**
 * Boundary-duyarlı traversal kararı: `path.relative` çıktısında yalnızca
 * tam ".." segmenti veya "../" öneki kök dışına çıkıştır; "..foo" yasal bir
 * dosya/dizin adıdır ve reddedilmez (over-deny düzeltmesi, bypass değil).
 */
function isLexicalEscape(nativeRelative: string): boolean {
  return (
    nativeRelative === ".." ||
    nativeRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(nativeRelative)
  );
}

/** Windows-only lexical check shared by root and candidate paths. */
function windowsSegmentDeny(code: PolicyErrorCode, rawPath: string, label: string): PolicyDeny | undefined {
  if (!IS_WIN) return undefined;
  const finding = findWindowsUnsafePathSegment(rawPath);
  if (finding === undefined) return undefined;
  return deny(code, `${label}: ${describeWindowsPathSegmentIssue(finding)}`, `windows-${finding.issue}`);
}

export class WorkspaceAccessPolicy {
  private readonly canonicalRoots: readonly string[];
  private readonly ignorePatterns: readonly string[];
  /** Root paths whose components were inspected for UNC/device link targets. */
  private readonly linkSafeRoots = new Map<string, true>();
  /** canonicalRoot → native canonical (long-name, on-disk case) root. */
  private readonly nativeRoots = new Map<string, string>();

  private constructor(readonly config: WorkspacePolicyConfig) {
    this.canonicalRoots = config.allowRoots.map((root) => {
      if (isUncOrDevicePath(root)) {
        throw new WorkspacePolicyError(
          "workspace/policy-invalid",
          `allowRoot must not be a UNC or Win32 device path (rejected before filesystem access): ${root}`,
        );
      }
      if (LINK_TARGET_INSPECTION_ENABLED) {
        const inspection = inspectLinkTargets(root);
        if (!inspection.ok) {
          throw new WorkspacePolicyError(
            "workspace/policy-invalid",
            `allowRoot is not usable: ${describeLinkInspectionFailure(inspection)}`,
          );
        }
      }
      try {
        return realpathSync(root);
      } catch {
        // Beyan edilmiş ama diskte olmayan kök: leksik normalize formla tutulur;
        // authorizeRoot realpath doğrulaması gerektirdiği için yine reddeder.
        return path.resolve(root);
      }
    });
    this.ignorePatterns = effectiveIgnorePatterns(config);
  }

  /** Şemayı doğrulayıp politikayı kurar; geçersiz config → POLICY_INVALID hatası. */
  static create(input: unknown): WorkspaceAccessPolicy {
    const parsed = parseWorkspacePolicyConfig(input);
    if (!parsed.ok) {
      throw new WorkspacePolicyError(
        parsed.code,
        `Invalid policy configuration (POLICY_INVALID): ${parsed.issues.join("; ")}`,
      );
    }
    return new WorkspaceAccessPolicy(parsed.config);
  }

  /**
   * Kök yetkilendirmesi: yalnızca kullanıcının config'te beyan ettiği
   * allowRoot'lar (veya bunların alt dizinleri) kabul edilir; kök gerçek
   * yola (realpath) çözümlenemiyorsa ve bir dizin değilse reddedilir
   * (TŞ §20: MCP isteği tek başına kök ekleyemez).
   */
  authorizeRoot(rootPath: string): PolicyDecision {
    if (rootPath.length === 0) {
      return deny("workspace/root-not-authorized", "root path is empty");
    }
    if (rootPath.includes("\0")) {
      return deny("workspace/root-not-authorized", "root path contains a null byte");
    }
    if (isUncOrDevicePath(rootPath)) {
      return deny(
        "workspace/root-not-authorized",
        "root path must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    const aliasDeny = windowsSegmentDeny("workspace/root-not-authorized", rootPath, "root path is not usable");
    if (aliasDeny !== undefined) {
      return aliasDeny;
    }
    const linkDeny = this.inspectRootLinks(rootPath);
    if (linkDeny !== undefined) {
      return linkDeny;
    }
    let canonical: string;
    try {
      canonical = realpathSync(rootPath);
    } catch {
      return deny(
        "workspace/root-not-authorized",
        "root could not be resolved to a real path (missing or inaccessible); an unverifiable root cannot be trusted",
      );
    }
    let isDirectory = true;
    try {
      isDirectory = statSync(canonical).isDirectory();
    } catch {
      return deny("workspace/root-not-authorized", "root status could not be read");
    }
    if (!isDirectory) {
      return deny("workspace/root-not-authorized", "root is not a directory");
    }
    const declared = this.canonicalRoots.find((canonicalRoot) => isInside(canonicalRoot, canonical));
    if (declared === undefined) {
      return deny(
        "workspace/root-not-authorized",
        "root is not in the user-declared allowRoots list (explicit authorization required)",
      );
    }
    return { allowed: true, canonicalRoot: canonical, relativePath: "." };
  }

  /** Yol erişim kararı: yetki → null byte → traversal → ignore → symlink escape. */
  checkPath(rootPath: string, candidatePath: string): PolicyDecision {
    const rootDecision = this.authorizeRoot(rootPath);
    if (!rootDecision.allowed) {
      return rootDecision;
    }
    if (candidatePath.includes("\0")) {
      return deny("workspace/path-denied", "candidate path contains a null byte (OWASP %00 bypass)");
    }
    if (isUncOrDevicePath(candidatePath)) {
      return deny(
        "workspace/path-denied",
        "candidate path must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    // 2b) Windows name aliases: `a.pem::$DATA`, `a.pem.`, `a.pem ` and device names
    //     (NUL, CON, ...) would name a different object than the deny rules see.
    const aliasDeny = windowsSegmentDeny("workspace/path-denied", candidatePath, "candidate path is not usable");
    if (aliasDeny !== undefined) {
      return aliasDeny;
    }

    // 3) Leksik çözümleme: `..` ve mutlak yollar normalize edilir (OWASP: normalize before IO).
    //    `\\?\` aygıt önekleri path işlemlerinden ÖNCE sıyırılır (win32 path.resolve
    //    önekli yolu kökten farklı bir kimlik olarak görür).
    //    Üst dizini OS symlink'i olan yetkili köklerde (örn. macOS `/var` → `/private/var`),
    //    çağıranın verdiği `rootPath` altındaki mutlak aday yol önce `canonicalRoot`,
    //    gerekirse yetkili `lexicalRoot` üzerinden göreli çözülüp `canonicalRoot`'a
    //    bağlanır; ardından ignore + CWE-59 realpath containment aynı sıkılıkla koşar.
    const candidateNormalized = stripWin32DevicePrefix(candidatePath);
    let absolute = path.isAbsolute(candidateNormalized)
      ? path.resolve(candidateNormalized)
      : path.resolve(rootDecision.canonicalRoot, candidateNormalized);
    let relative = path.relative(rootDecision.canonicalRoot, absolute);
    if (isLexicalEscape(relative) && path.isAbsolute(candidateNormalized)) {
      const lexicalRoot = path.resolve(stripWin32DevicePrefix(rootPath));
      if (lexicalRoot !== rootDecision.canonicalRoot) {
        const relativeFromCallerRoot = path.relative(lexicalRoot, absolute);
        if (!isLexicalEscape(relativeFromCallerRoot)) {
          relative = relativeFromCallerRoot;
          absolute = path.resolve(rootDecision.canonicalRoot, relativeFromCallerRoot);
        }
      }
    }
    if (isLexicalEscape(relative)) {
      return deny(
        "workspace/path-denied",
        "candidate path escapes the root after lexical resolution (`..` traversal or a different root)",
        "..",
      );
    }

    // 3b) Links below the (already canonical) root whose target is a UNC/device path
    //     are rejected from lstat/readlink alone, before any stat/realpath follows them.
    if (LINK_TARGET_INSPECTION_ENABLED) {
      const inspection = inspectLinkTargets(absolute, { startDir: rootDecision.canonicalRoot });
      if (!inspection.ok) {
        return deny(
          "workspace/path-denied",
          `candidate path is not usable: ${describeLinkInspectionFailure(inspection)}`,
          inspection.reason,
        );
      }
    }

    // 4) Ignore kuralları: dosyanın kendisi VE ata dizinleri değerlendirilir.
    const lexicalPosix = toPosixRelative(relative);
    if (lexicalPosix !== ".") {
      const matched = this.matchIgnoreRules(lexicalPosix, absolute);
      if (matched !== undefined) {
        return deny("workspace/path-denied", "candidate path matches an ignore rule", matched);
      }
    }

    // 5) Symlink/junction escape: gerçek yol kök sarmalanmış mı? (CWE-59, TŞ §19)
    const resolved = this.resolveRealpath(absolute);
    if (resolved === undefined) {
      return deny("workspace/path-denied", "the real path of the candidate could not be resolved");
    }
    if (!isInside(rootDecision.canonicalRoot, resolved)) {
      return deny(
        "workspace/path-denied",
        "the real path of the candidate (symlink/junction) escapes the root",
        "realpath-containment",
      );
    }
    // 5b) Kanonik gerçek yola ignore re-check (TŞ §19 secret exclusion):
    // kök içine işaret eden bir junction/symlink, leksik adıyla ignore
    // deny-list'ini BYPASS edemez — gerçek hedef yolu (ve atalarını) aynı
    // kurallara tabidir (örn. link → .git, '.git/HEAD' gibi reddedilir).
    const canonicalRelative = path.relative(rootDecision.canonicalRoot, resolved);
    const canonicalPosix = toPosixRelative(canonicalRelative);
    if (canonicalPosix !== "." && canonicalPosix !== lexicalPosix) {
      const matched = this.matchIgnoreRules(canonicalPosix, resolved);
      if (matched !== undefined) {
        return deny(
          "workspace/path-denied",
          "the canonical real path matches an ignore rule (ignore bypass through a symlink was blocked)",
          matched,
        );
      }
    }
    // 5c) Native long-name re-check: an 8.3 short name (`GIT~1`) or a letter-case
    //     alias survives `realpathSync` unchanged; the native real path expands it
    //     to the stored name, so ignore rules see `.git` and containment is
    //     verified on the same canonical form.
    if (CHECK_NATIVE_NAME_ALIASES) {
      const nativeDeny = this.checkNativeNameAliases(rootDecision.canonicalRoot, absolute, canonicalPosix);
      if (nativeDeny !== undefined) {
        return nativeDeny;
      }
    }
    // Dönen relativePath canonical'dır: kök içine işaret eden symlink'in
    // gerçek hedefi raporlanır (inventory gerçek dosyayı okur).
    return {
      allowed: true,
      canonicalRoot: rootDecision.canonicalRoot,
      relativePath: canonicalPosix,
    };
  }

  /**
   * Dosya erişim kararı: checkPath + uzantı filtresi + boyut limiti.
   * `sizeBytes` verilmezse mevcut dosyanın gerçek boyutu okunur; dosya yoksa
   * boyut adımı atlanır (planlanan dosya yalnızca yol kurallarına tabidir).
   */
  checkFile(rootPath: string, candidatePath: string, sizeBytes?: number): PolicyDecision {
    // Girdi doğrulaması (config'in aksine bu bir runtime argümanıdır):
    // NaN/Infinity, `NaN > maxFileBytes === false` olduğundan boyut limitini
    // SESSİZCE geçebilirdi — deterministik red zorunludur.
    if (sizeBytes !== undefined && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
      return deny(
        "workspace/path-denied",
        "invalid sizeBytes: a finite, non-negative number is expected",
        "sizeBytes",
      );
    }
    const decision = this.checkPath(rootPath, candidatePath);
    if (!decision.allowed) {
      return decision;
    }

    // 6a) Uzantı filtresi (binary kara liste / beyaz liste).
    const extension = path.extname(decision.relativePath).toLowerCase();
    if (this.config.extensionFilterMode === "blacklist") {
      if (extension !== "" && this.config.binaryExtensions.includes(extension)) {
        return deny(
          "workspace/path-denied",
          `extension is on the binary blacklist: ${extension}`,
          extension,
        );
      }
    } else {
      const allowed = this.config.allowedExtensions.includes(extension);
      if (!allowed) {
        return deny(
          "workspace/path-denied",
          extension === "" ? "files without an extension are not allowed in whitelist mode" : `extension is not in the whitelist: ${extension}`,
          extension === "" ? "(no extension)" : extension,
        );
      }
    }

    // 6b) Boyut limiti (TŞ §19 kaynak tüketimi; §20 index.maxFileBytes).
    let effectiveSize = sizeBytes;
    if (effectiveSize === undefined) {
      const statTarget =
        decision.relativePath === "." ? decision.canonicalRoot : path.resolve(decision.canonicalRoot, decision.relativePath);
      effectiveSize = this.readFileBytesIfFile(statTarget);
    }
    if (effectiveSize !== undefined && effectiveSize > this.config.maxFileBytes) {
      return deny(
        "workspace/limit-exceeded",
        `file size (${String(effectiveSize)} bytes) exceeds the maxFileBytes limit (${String(this.config.maxFileBytes)})`,
        "maxFileBytes",
      );
    }
    return decision;
  }

  /**
   * First ignore rule matching `posixRelative` or any of its ancestors; the last
   * segment is treated as a directory unless `absoluteForFileCheck` is a file.
   */
  private matchIgnoreRules(posixRelative: string, absoluteForFileCheck: string): string | undefined {
    const segments = posixRelative.split("/");
    const isFile = this.existsAsFile(absoluteForFileCheck);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      const isDirectoryCandidate = depth < segments.length || !isFile;
      const matched = findMatchingIgnorePattern(prefix, isDirectoryCandidate, this.ignorePatterns);
      if (matched !== undefined) {
        return matched;
      }
    }
    return undefined;
  }

  /**
   * Inspects every component of a root path for UNC/device link targets before the
   * first realpath/stat. The verdict for a root is cached per instance: the path
   * down to the root is the user's own environment, while every candidate below
   * the root is inspected again on each call.
   */
  private inspectRootLinks(rootPath: string): PolicyDeny | undefined {
    if (!LINK_TARGET_INSPECTION_ENABLED) {
      return undefined;
    }
    const key = comparablePath(path.resolve(rootPath));
    if (this.linkSafeRoots.has(key)) {
      return undefined;
    }
    const inspection = inspectLinkTargets(rootPath);
    if (!inspection.ok) {
      return deny(
        "workspace/root-not-authorized",
        `root path is not usable: ${describeLinkInspectionFailure(inspection)}`,
        inspection.reason,
      );
    }
    rememberBounded(this.linkSafeRoots, key, true);
    return undefined;
  }

  /** Native canonical form of an authorized canonical root (cached per instance). */
  private nativeRootOf(canonicalRoot: string): string | undefined {
    const cached = this.nativeRoots.get(canonicalRoot);
    if (cached !== undefined) {
      return cached;
    }
    let nativeRoot: string;
    try {
      nativeRoot = nativeRealpath(canonicalRoot);
    } catch {
      return undefined;
    }
    rememberBounded(this.nativeRoots, canonicalRoot, nativeRoot);
    return nativeRoot;
  }

  private checkNativeNameAliases(
    canonicalRoot: string,
    absolute: string,
    canonicalPosix: string,
  ): PolicyDeny | undefined {
    const nativeRoot = this.nativeRootOf(canonicalRoot);
    const nativeResolved = this.resolveRealpath(absolute, nativeRealpath);
    if (nativeRoot === undefined || nativeResolved === undefined) {
      return deny(
        "workspace/path-denied",
        "the native canonical path of the candidate could not be resolved",
        "native-realpath",
      );
    }
    if (!isInside(nativeRoot, nativeResolved)) {
      return deny(
        "workspace/path-denied",
        "the native canonical path of the candidate escapes the root",
        "realpath-containment",
      );
    }
    const nativePosix = toPosixRelative(path.relative(nativeRoot, nativeResolved));
    if (nativePosix === "." || comparablePath(nativePosix) === comparablePath(canonicalPosix)) {
      return undefined;
    }
    const matched = this.matchIgnoreRules(nativePosix, nativeResolved);
    if (matched === undefined) {
      return undefined;
    }
    return deny(
      "workspace/path-denied",
      "the native canonical long-name path matches an ignore rule (a short-name or letter-case alias was blocked)",
      matched,
    );
  }

  private existsAsFile(absolutePath: string): boolean {
    try {
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  }

  private readFileBytesIfFile(absolutePath: string): number | undefined {
    try {
      const st = statSync(absolutePath);
      return st.isFile() ? st.size : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * realpath çözümlemesi: aday varsa kendisi; yoksa en derin mevcut atanın
   * gerçek yolu + kalan segmentler (henüz var olmayan planlanan dosya,
   * symlink'li ata üzerinden kaçışa yine kapatıktır — CWE-59).
   */
  private resolveRealpath(
    absolutePath: string,
    realpath: (target: string) => string = realpathSync,
  ): string | undefined {
    try {
      return realpath(absolutePath);
    } catch {
      // yok: ata zincirinde ilerle
    }
    let prefix = absolutePath;
    const missing: string[] = [];
    for (;;) {
      const parent = path.dirname(prefix);
      const base = path.basename(prefix);
      if (parent === prefix) {
        return undefined; // dosya sistemi köküne ulaşıldı, hiçbir ata çözümlenemedi
      }
      missing.unshift(base);
      prefix = parent;
      try {
        return path.join(realpath(prefix), ...missing);
      } catch {
        // ata da yok: zincire devam
      }
    }
  }
}
