/**
 * analyzerFingerprint fp2 şeması — sprint-2 B9 (README "Açık borç"
 * sözleşmesinin kapatılması) + denetim takip düzeltmeleri.
 *
 * Güvenlik notu (kırmızı çizgi 6): bu modül hiçbir süreci başlatmaz —
 * yalnızca string ayrıştırma ve sha256 hash üretimi yapar. Settings
 * alanları (dotnetCommand vb.) bu modülde asla bir çalıştırma ifadesine
 * gömülmez; yalnızca canonical JSON'a yazılıp hash'lenir. Süreç yönetimi
 * yalnızca adapters/csharp-roslyn worker-process.ts'tedir ve orada LİTERAL
 * "dotnet" + SABİT argüman dizisi + shell:false kuralıyla korunur.
 *
 * Arkaplan (adapters/csharp-roslyn/README.md "Açık borç"): roslyn worker'ın
 * otomatik ref-pack keşfi (DOTNET_ROOT → dotnet host konumu → standart
 * kurulum yolu; native/roslyn-worker/ReferenceResolver.cs CandidateDotNetRoots)
 * derleme referans kümesine ve dolayısıyla semantiğe dokunur — farklı
 * makinelerdeki farklı .NET/ASP.NET Core pack sürümleri farklı çözümleme
 * sonuçları üretebilir. fp1 (`<analyzerId>@<version>`) bu bağlamı taşımadığı
 * için TŞ §8 invariant (vi) ("aynı kod+config+adapter versiyonu aynı Graph
 * JSON") makineler arası tam taahhüt değildi.
 *
 * fp2 şeması: fingerprint, koşumun GERÇEK analyzer bağlamını taşır —
 * "|" ile ayrılmış konumsal segmentler:
 *
 *   fp2|ts-adapter@0.1.0|roslyn-worker@0.1.0|refpack=<pack>@<sürüm>@<tfmDir>;...|refsrc=<kaynak>|opts=<sha256-16>
 *      [|python-worker@0.1.0|pystate=<durum>|pyopts=<sha256-16>
 *       |go-worker@0.1.0|gostate=<durum>|goopts=<sha256-16>
 *       |rust-worker@0.1.0|ruststate=<durum>|rustopts=<sha256-16>]  (M2)
 *
 * - adapter segmentleri: koşuma katılan her dil adapter'ının id@versiyonu.
 * - M2 sidecar dil blokları (python/go/rust): ilgili dilin dosyası YOKSA
 *   blok HİÇ yazılmaz — mevcut TS+C# fingerprint'i bit-bit korunur.
 *   <lang>state: WorkerRunStatus (ready | worker-unavailable |
 *   sync-run-degraded) — worker'ın koşup koşamadığı dürüstçe taşınır
 *   (fp1 dersinin karşılığı: aynı fp, farklı graph uydurulmaz).
 *   <lang>opts: IndexService'in adapter'a GEÇTİĞİ etkin ayarların canonical
 *   JSON sha256 özeti (ilk 16 hex) — csharp opts kuralının aynısı.
 * - refpack: worker'ın GERÇEKTEN yüklediği ref pack'leri (worker yanıt
 *   warnings'inden türetilir — ReferenceResolver.cs:144 canonical satırı
 *   "referans paketi yüklendi: <pack> <sürüm> (<tfmDir>)"); pack hiç
 *   bulunamadıysa "fallback-corelib" (System.Private.CoreLib runtime ref),
 *   keşif bilgisi yoksa "unavailable" — hiçbir koşulda uydurma sürüm
 *   yazılmaz.
 * - refsrc: discovery kaynağı — discovery="performed" iken tfmDir
 *   DOTNET_ROOT altındaysa (sınır ayıracı + Windows büyük/küçük harf
 *   normalizasyonuyla) "env-dotnet-root"; aksi halde host/standart ayrımı
 *   TS tarafından ayırt edilemez → dürüst genel etiket "worker-discovered".
 *   Keşif yapılamayan durumlar nötr dürüst etiketler taşır:
 *   "worker-unavailable" (worker hiç koşamadı), "discovery-unknown"
 *   (worker healthy ama yanıtta keşif bilgisi yok), "sync-run-degraded"
 *   (senkron köprü worker'ı hiç başlatmadı).
 * - opts: IndexService'in C# adapter'a GEÇTİĞİ etkin ayarların
 *   (dotnetCommand, requestTimeoutMs, workerDllPath) canonical JSON
 *   sha256 özeti (ilk 16 hex). Worker yanıt satır bütçesi
 *   (responseMaxChars) adapter içindeki sabittir ve IndexService geçmez;
 *   geçilmeyen bir değerin hash'te "etkin ayar" gibi gösterilmesi
 *   bayatma riski üretirdi (denetim bulgusu) — bu yüzden şemada yer almaz.
 *
 * Sonuç: aynı makinede aynı girdi → aynı fingerprint (determinizm korunur);
 * farklı ref-pack sürümü/kurulumu/ayarı → FARKLI fingerprint — makineler
 * arası Graph JSON eşitliği artık YANLIŞ taahhüt edilmez (borç kapanışı).
 *
 * Determinizm: bu modül saat okumaz, RNG kullanmaz; girdi aynıysa çıktı
 * birebir aynıdır.
 */
import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type JsonValue,
} from "@causoryn/domain";

/**
 * Fingerprint schema version. fp3 (0.3.0) supersedes fp2: node spans, ESM/CJS
 * module-format detection and the English evidence text changed analyzer output,
 * so snapshots and file_facts written by earlier builds must not be reused.
 */
export const ANALYZER_FINGERPRINT_SCHEMA_VERSION = "fp3";

/** Worker'ın yüklediği tek ref-pack kaydı (ReferenceResolver.cs:144). */
export interface RoslynRefPackEntry {
  readonly pack: string;
  readonly version: string;
  /** Yükleme notundaki mutlak ref dizini (discovery sonucunun kendisi). */
  readonly tfmDir: string;
}

/**
 * Worker yanıt warnings'inden türetilen ref-pack bağlamı. `packs` boş ve
 * source "worker-discovered" ise worker koştu ama pack bulamadı
 * (fallback-corelib) — fingerprint'e "fallback-corelib" yazılır.
 */
export interface RoslynRefPackContext {
  readonly packs: readonly RoslynRefPackEntry[];
  readonly source: "env-dotnet-root" | "worker-discovered";
}

/**
 * Ref-pack keşfinin koşum düzeyindeki durumu:
 * - performed: worker healthy koştu ve keşif bilgisi warnings'ten türetildi.
 * - worker-unavailable: worker hiç koşamadı (degradasyon) — keşif yok.
 * - discovery-unknown: worker HEALTHY koştu ama yanıtta keşif bilgisi yok
 *   (sözleşme sapması) — worker'un varlığıyla keşfin bilinmesi aynı şey
 *   değildir; nötr etiket dürüsttür.
 * - sync-run-degraded: senkron köprü worker'ı hiç başlatmadı.
 */
export type RoslynDiscoveryStatus =
  | "performed"
  | "worker-unavailable"
  | "discovery-unknown"
  | "sync-run-degraded";

/** Yükleme notunun canonical başlık öneki (ReferenceResolver.cs:144). */
const REF_PACK_LOADED_PREFIX = "reference pack loaded: ";

/** ReferenceResolver.cs:62-65 fallback satırının ayrıştırıcı imzası. */
const REF_PACK_FALLBACK_PREFIX = "Microsoft.NETCore.App.Ref pack not found;";

/** Sürüm biçimi: X.Y.Z (ReferenceResolver VersionDirRegex karşılığı). */
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/**
 * Tek yükleme satırını ayrıştırır: "reference pack loaded: <pack>
 * <version> (<tfmDir>)". Regex capture yerine adım adım dilimleme kullanılır
 * (saf string işlemi — yürütme ile ilişkisi yoktur).
 */
function parseRefPackWarning(warning: string): RoslynRefPackEntry | null {
  if (!warning.startsWith(REF_PACK_LOADED_PREFIX)) return null;
  const rest = warning.slice(REF_PACK_LOADED_PREFIX.length);
  if (!rest.endsWith(")")) return null;
  const openParen = rest.lastIndexOf(" (");
  if (openParen <= 0) return null;
  const head = rest.slice(0, openParen);
  const tfmDir = rest.slice(openParen + 2, rest.length - 1);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace <= 0) return null;
  const pack = head.slice(0, lastSpace);
  const version = head.slice(lastSpace + 1);
  if (!VERSION_SHAPE.test(version)) return null;
  if (pack.length === 0 || tfmDir.length === 0) return null;
  return { pack, version, tfmDir };
}

/**
 * Worker koşum warnings'lerinden ref-pack bağlamını türetir. Worker hiç
 * koşmadıysa / koşum degradasyona düşüyorsa (ilgili satır hiç yoksa) null
 * döner — çağrı tarafı bunu discovery durum etiketiyle ayırt eder
 * (uydurma yok).
 */
export function extractRoslynRefPackContext(
  warnings: readonly string[],
): RoslynRefPackContext | null {
  const packs: RoslynRefPackEntry[] = [];
  let sawFallback = false;
  for (const warning of warnings) {
    const loaded = parseRefPackWarning(warning);
    if (loaded !== null) {
      packs.push(loaded);
      continue;
    }
    if (warning.startsWith(REF_PACK_FALLBACK_PREFIX)) {
      sawFallback = true;
    }
  }

  if (packs.length === 0 && !sawFallback) {
    return null; // keşif bilgisi yok — çağrı tarafı durumu ayırt eder
  }

  packs.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0));
  return {
    packs,
    source: resolveDiscoverySource(packs),
  };
}

/**
 * Discovery kaynağı etiketi: yükleme dizini DOTNET_ROOT altındaysa env
 * keşfi kesindir (ReferenceResolver ilk aday kök budur). Karşılaştırma
 * DİZİN SINIR AYIRACIYLA yapılır — "C:\dotnet" kökü "C:\dotnet-evil"
 * altındaki yolu env keşfi SANMAMALI (denetim bulgusu). Windows'ta yol
 * harfleri büyük/küçük harf duyarsız olduğundan karşılaştırma case-insensitive;
 * ayraç hem "\" hem "/" olarak kabul edilir. Aksi halde host konumu ile
 * standart yol TS tarafından ayırt edilemez → dürüst genel etiket
 * "worker-discovered" (uydurma ayrım yok).
 */
function resolveDiscoverySource(
  packs: readonly RoslynRefPackEntry[],
): RoslynRefPackContext["source"] {
  const dotnetRoot = process.env["DOTNET_ROOT"];
  if (dotnetRoot === undefined || dotnetRoot.trim().length === 0) {
    return "worker-discovered";
  }
  const root = dotnetRoot.toLowerCase();
  const isUnderRoot = (dir: string): boolean => {
    const lower = dir.toLowerCase();
    return lower === root || lower.startsWith(`${root}\\`) || lower.startsWith(`${root}/`);
  };
  if (packs.some((entry) => isUnderRoot(entry.tfmDir))) {
    return "env-dotnet-root";
  }
  return "worker-discovered";
}

/** fp2'ye giren C# adapter bağlamı (koşum + keşif + ayarlar). */
export interface RoslynFingerprintContext {
  readonly analyzerId: string;
  readonly version: string;
  /** Keşfin koşum düzeyindeki durumu (RoslynDiscoveryStatus). */
  readonly discovery: RoslynDiscoveryStatus;
  /** discovery "performed" ise dolu; diğer durumlarda null. */
  readonly refPacks: RoslynRefPackContext | null;
  readonly settings: RoslynAdapterSettings;
}

/**
 * IndexService'in C# adapter'a GEÇTİĞİ etkin ayarlar (opts hash girdisi).
 * Değerler yapılandırma düzeyidir; bu modülde hiçbiri yürütülmez.
 */
export interface RoslynAdapterSettings {
  readonly dotnetCommand: string;
  readonly requestTimeoutMs: number;
  readonly workerDllPath: string;
}

/**
 * IndexService'in Python adapter'a GEÇTİĞİ etkin ayarlar (M2; pyopts hash
 * girdisi). Adapter'ın PythonAdapterOptions zorunlu alanlarının birebir
 * karşılığıdır — hash'te YALNIZCA geçilen alanlar taşınır.
 */
export interface PythonIndexSettings {
  readonly pythonCommand: string;
  readonly requestTimeoutMs: number;
  readonly workerScriptPath: string;
  readonly responseMaxChars: number;
}

/**
 * IndexService'in Go adapter'a GEÇTİĞİ etkin ayarlar (M2; goopts hash
 * girdisi). goWorkerBinaryPath boş string = "go run" modu (adapter kuralı).
 */
export interface GoIndexSettings {
  readonly goBinaryPath: string;
  readonly goWorkerBinaryPath: string;
  readonly workerDir: string;
  readonly requestTimeoutMs: number;
}

/**
 * IndexService'in Rust adapter'a GEÇTİĞİ etkin ayarlar (M2; rustopts hash
 * girdisi). cargoHomeDir boş string = adapter default keşfi
 * (resolveCargoHomeDir).
 */
export interface RustIndexSettings {
  readonly workerDir: string;
  readonly workerBinaryName: string;
  readonly cargoHomeDir: string;
  readonly requestTimeoutMs: number;
  readonly responseMaxChars: number;
  readonly cargoBuildTimeoutMs: number;
}

/**
 * Sidecar worker tabanlı dillerin (python/go/rust; M2) koşum düzeyi
 * worker durumu — csharp refsrc etiketlerinin karşılığı:
 * - ready: worker healthy koştu, sembol katmanı üretildi.
 * - worker-unavailable: worker başlatılamadı/yanıt veremedi → L0/L1
 *   fallback (adapter içi; motor çökmez).
 * - sync-run-degraded: senkron köprü worker'ı hiç başlatmadı.
 */
export type WorkerRunStatus = "ready" | "worker-unavailable" | "sync-run-degraded";

/** Python adapter fingerprint bağlamı (M2). */
export interface PythonFingerprintContext {
  readonly analyzerId: string;
  readonly version: string;
  readonly status: WorkerRunStatus;
  readonly settings: PythonIndexSettings;
}

/** Go adapter fingerprint bağlamı (M2). */
export interface GoFingerprintContext {
  readonly analyzerId: string;
  readonly version: string;
  readonly status: WorkerRunStatus;
  readonly settings: GoIndexSettings;
}

/** Rust adapter fingerprint bağlamı (M2). */
export interface RustFingerprintContext {
  readonly analyzerId: string;
  readonly version: string;
  readonly status: WorkerRunStatus;
  readonly settings: RustIndexSettings;
}

export interface AnalyzerFingerprintInput {
  /** TS adapter segmenti; workspace'te TS yoksa null. */
  readonly typescript: { readonly analyzerId: string; readonly version: string } | null;
  /** C# adapter segmenti; workspace'te .cs yoksa null. */
  readonly csharp: RoslynFingerprintContext | null;
  /**
   * Python adapter segmenti; workspace'te .py yoksa/tanımsızsa blok
   * yazılmaz (M2; optional — mevcut TS+C# çağıranları etkilenmez).
   */
  readonly python?: PythonFingerprintContext | null;
  /** Go adapter segmenti; workspace'te .go yoksa/tanımsızsa blok yazılmaz (M2). */
  readonly go?: GoFingerprintContext | null;
  /** Rust adapter segmenti; workspace'te .rs yoksa/tanımsızsa blok yazılmaz (M2). */
  readonly rust?: RustFingerprintContext | null;
}

/** Ayarlar özeti: canonical JSON sha256 özetinin ilk 16 hex karakteri. */
function settingsHash(settings: RoslynAdapterSettings): string {
  const payload: JsonValue = {
    dotnetCommand: settings.dotnetCommand,
    requestTimeoutMs: settings.requestTimeoutMs,
    workerDllPath: settings.workerDllPath,
  };
  return sha256Hex(utf8Encode(canonicalJson(payload))).slice(0, 16);
}

/**
 * M2: IndexService'in yeni dil adapter'larına GEÇTİĞİ etkin ayarların
 * özeti — csharp opts kuralının aynısı: hash'te YALNIZCA geçilen alanlar
 * taşınır (geçilmeyen adapter içi sabit kopyalanmaz; bayatma riski yok).
 */
function workerSettingsHash(payload: JsonValue): string {
  return sha256Hex(utf8Encode(canonicalJson(payload))).slice(0, 16);
}

/**
 * fp2 analyzerFingerprint üretir. Segment sırası sabittir: şema, TS, C#
 * (refpack, refsrc, opts), python (state, opts), go (state, opts), rust
 * (state, opts). Hiç adapter koşmadıysa yalnızca şema segmenti kalır
 * ("fp2").
 */
export function buildAnalyzerFingerprint(input: AnalyzerFingerprintInput): string {
  const segments: string[] = [ANALYZER_FINGERPRINT_SCHEMA_VERSION];
  if (input.typescript !== null) {
    segments.push(`${input.typescript.analyzerId}@${input.typescript.version}`);
  }
  if (input.csharp !== null) {
    segments.push(`${input.csharp.analyzerId}@${input.csharp.version}`);
    switch (input.csharp.discovery) {
      case "performed": {
        if (input.csharp.refPacks === null) {
          // Sözleşme savunması: performed'da refPacks zorunludur; gelmezse
          // uydurma sürüm YAZILMAZ — nötr unknown etiketine düşülür.
          segments.push("refpack=unavailable");
          segments.push("refsrc=discovery-unknown");
          break;
        }
        if (input.csharp.refPacks.packs.length === 0) {
          // Worker koştu, pack bulamadı: System.Private.CoreLib fallback
          // (ReferenceResolver.cs:62-65) — dürüst etiket.
          segments.push("refpack=fallback-corelib");
          segments.push(`refsrc=${input.csharp.refPacks.source}`);
        } else {
          const joined = input.csharp.refPacks.packs
            .map((entry) => `${entry.pack}@${entry.version}@${entry.tfmDir}`)
            .join(";");
          segments.push(`refpack=${joined}`);
          segments.push(`refsrc=${input.csharp.refPacks.source}`);
        }
        break;
      }
      case "worker-unavailable":
        segments.push("refpack=unavailable");
        segments.push("refsrc=worker-unavailable");
        break;
      case "discovery-unknown":
        segments.push("refpack=unavailable");
        segments.push("refsrc=discovery-unknown");
        break;
      case "sync-run-degraded":
        segments.push("refpack=unavailable");
        segments.push("refsrc=sync-run-degraded");
        break;
    }
    segments.push(`opts=${settingsHash(input.csharp.settings)}`);
  }
  // M2: sidecar worker dilleri — segment sırası sabittir (python, go,
  // rust); her dil bloğu <id>@<sürüm> | <lang>state=<durum> |
  // <lang>opts=<hash16>. Mevcut TS+C# fingerprint'i bit-bit korunur (yeni
  // bloklar yalnızca ilgili dilin dosyaları varsa eklenir).
  if (input.python ?? null) {
    const python = input.python as PythonFingerprintContext;
    segments.push(`${python.analyzerId}@${python.version}`);
    segments.push(`pystate=${python.status}`);
    segments.push(
      `pyopts=${workerSettingsHash({
        pythonCommand: python.settings.pythonCommand,
        requestTimeoutMs: python.settings.requestTimeoutMs,
        workerScriptPath: python.settings.workerScriptPath,
        responseMaxChars: python.settings.responseMaxChars,
      })}`,
    );
  }
  if (input.go ?? null) {
    const go = input.go as GoFingerprintContext;
    segments.push(`${go.analyzerId}@${go.version}`);
    segments.push(`gostate=${go.status}`);
    segments.push(
      `goopts=${workerSettingsHash({
        goBinaryPath: go.settings.goBinaryPath,
        goWorkerBinaryPath: go.settings.goWorkerBinaryPath,
        workerDir: go.settings.workerDir,
        requestTimeoutMs: go.settings.requestTimeoutMs,
      })}`,
    );
  }
  if (input.rust ?? null) {
    const rust = input.rust as RustFingerprintContext;
    segments.push(`${rust.analyzerId}@${rust.version}`);
    segments.push(`ruststate=${rust.status}`);
    segments.push(
      `rustopts=${workerSettingsHash({
        workerDir: rust.settings.workerDir,
        workerBinaryName: rust.settings.workerBinaryName,
        cargoHomeDir: rust.settings.cargoHomeDir,
        requestTimeoutMs: rust.settings.requestTimeoutMs,
        responseMaxChars: rust.settings.responseMaxChars,
        cargoBuildTimeoutMs: rust.settings.cargoBuildTimeoutMs,
      })}`,
    );
  }
  return segments.join("|");
}
