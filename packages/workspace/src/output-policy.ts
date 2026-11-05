import { realpathSync, statSync } from "node:fs";
import path from "node:path";

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

export class OutputAccessPolicy {
  /** Beyanlı output kökleri; kanonik + leksik sıralı (deterministik dizi). */
  private readonly canonicalDirs: readonly string[];

  private constructor(canonicalDirs: readonly string[]) {
    this.canonicalDirs = canonicalDirs;
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
        "output dizin listesi boş olamaz: en az bir explicit beyan zorunludur (default deny)",
      );
    }
    // Kanonik gerçek yol → gösterim eşlemesi (aynı hedefe işaret eden
    // tekrarlı beyanlar tek köke indirgenir; ilk beyan kazanır).
    const displayByComparable = new Map<string, string>();
    for (const declared of allowedOutputDirs) {
      if (typeof declared !== "string" || declared.length === 0) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          "output dizini beyanı boş olamaz",
        );
      }
      if (declared.includes("\0")) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          "output dizini beyanı null byte içeriyor",
        );
      }
      let canonical: string;
      try {
        canonical = realpathSync(declared);
      } catch {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output dizini gerçek yola çözümlenemedi (yok veya erişilemez): ${declared}`,
        );
      }
      let isDirectory = true;
      try {
        isDirectory = statSync(canonical).isDirectory();
      } catch {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output dizini durumu okunamadı: ${declared}`,
        );
      }
      if (!isDirectory) {
        throw new OutputPolicyError(
          "workspace/output-policy-invalid",
          `output dizini beyanı bir dizin değil: ${declared}`,
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
    return new OutputAccessPolicy(canonicalDirs);
  }

  /** Beyanlı kanonik output kökleri (leksik sıralı, deterministik). */
  get canonicalOutputDirs(): readonly string[] {
    return [...this.canonicalDirs];
  }

  /**
   * Dizin yetkilendirmesi: istenen dizin realpath'e çözümlenir ve beyanlı
   * output köklerinden biri içinde (veya kökle aynı) olmalıdır.
   */
  authorizeDirectory(dirPath: string): OutputDecision {
    if (dirPath.length === 0) {
      return deny("workspace/output-path-denied", "output dizini yolu boş");
    }
    if (dirPath.includes("\0")) {
      return deny("workspace/output-path-denied", "output dizini yolu null byte içeriyor");
    }
    let canonical: string;
    try {
      canonical = realpathSync(dirPath);
    } catch {
      return deny(
        "workspace/output-not-authorized",
        "output dizini gerçek yola çözümlenemedi (yok veya erişilemez); doğrulanamayan dizin yazma kaynağı olamaz",
      );
    }
    const declared = this.canonicalDirs.find((canonicalDir) => isInside(canonicalDir, canonical));
    if (declared === undefined) {
      return deny(
        "workspace/output-not-authorized",
        "output dizini kullanıcının beyan ettiği output listesinde değil (explicit authorization, TŞ §16)",
      );
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
      return deny("workspace/output-path-denied", "dosya adı boş");
    }
    if (fileName.includes("\0")) {
      return deny("workspace/output-path-denied", "dosya adı null byte içeriyor");
    }
    if (fileName.includes("/") || fileName.includes("\\")) {
      return deny(
        "workspace/output-path-denied",
        "dosya adı yol ayracı içeremez (alt dizin yazma izni yok)",
        "separator",
      );
    }
    if (fileName === "." || fileName === "..") {
      return deny(
        "workspace/output-path-denied",
        "dosya adı '.' veya '..' tam segmenti olamaz (traversal reddi)",
        "..",
      );
    }
    const absolute = path.resolve(dirDecision.canonicalDir, fileName);
    const relative = path.relative(dirDecision.canonicalDir, absolute);
    if (isLexicalEscape(relative)) {
      return deny(
        "workspace/output-path-denied",
        "yazma hedefi leksik çözümlemede beyanlı dizin dışına çıkıyor",
        "..",
      );
    }
    // realpath sarmalama (CWE-59): mevcut dosya/symlink kendisiyle çözülür;
    // henüz var olmayan hedef için en derin mevcut ata + kalan segment —
    // bu hedef yalnızca son bileşendir (ayraç reddedildi), yine de kural
    // sabit uygulanır.
    const resolved = this.resolveRealpath(absolute);
    if (resolved === undefined) {
      return deny("workspace/output-path-denied", "yazma hedefinin gerçek yolu çözümlenemedi");
    }
    if (!isInside(dirDecision.canonicalDir, resolved)) {
      return deny(
        "workspace/output-path-denied",
        "yazma hedefinin gerçek yolu (symlink/junction) beyanlı dizin dışına çıkıyor",
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
