import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { findMatchingIgnorePattern } from "./ignore-matcher.js";
import { isUncOrDevicePath } from "./path-safety.js";
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

export class WorkspaceAccessPolicy {
  private readonly canonicalRoots: readonly string[];
  private readonly ignorePatterns: readonly string[];

  private constructor(readonly config: WorkspacePolicyConfig) {
    this.canonicalRoots = config.allowRoots.map((root) => {
      if (isUncOrDevicePath(root)) {
        throw new WorkspacePolicyError(
          "workspace/policy-invalid",
          `allowRoot must not be a UNC or Win32 device path (rejected before filesystem access): ${root}`,
        );
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

    // 4) Ignore kuralları: dosyanın kendisi VE ata dizinleri değerlendirilir.
    const lexicalPosix = toPosixRelative(relative);
    if (lexicalPosix !== ".") {
      const segments = lexicalPosix.split("/");
      const isFile = this.existsAsFile(absolute);
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const prefix = segments.slice(0, depth).join("/");
        const isDirectoryCandidate = depth < segments.length || !isFile;
        const matched = findMatchingIgnorePattern(prefix, isDirectoryCandidate, this.ignorePatterns);
        if (matched !== undefined) {
          return deny("workspace/path-denied", "candidate path matches an ignore rule", matched);
        }
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
      const canonicalSegments = canonicalPosix.split("/");
      const canonicalIsFile = this.existsAsFile(resolved);
      for (let depth = 1; depth <= canonicalSegments.length; depth += 1) {
        const prefix = canonicalSegments.slice(0, depth).join("/");
        const isDirectoryCandidate = depth < canonicalSegments.length || !canonicalIsFile;
        const matched = findMatchingIgnorePattern(prefix, isDirectoryCandidate, this.ignorePatterns);
        if (matched !== undefined) {
          return deny(
            "workspace/path-denied",
            "the canonical real path matches an ignore rule (ignore bypass through a symlink was blocked)",
            matched,
          );
        }
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
        return undefined; // dosya sistemi köküne ulaşıldı, hiçbir ata çözümlenemedi
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
