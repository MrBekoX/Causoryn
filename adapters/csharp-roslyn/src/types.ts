/**
 * @causoryn/adapter-csharp-roslyn — sözleşme tipleri (TŞ v2.1 §7, §7.1;
 * sprint-2 / B2).
 *
 * Bu adapter, native/roslyn-worker (B1) süreç yönetir: stdin/stdout satır
 * bazlı JSON protokol (PROTOCOL.md v1). Çıktı, packages/domain
 * createSnapshot GİRDİ sözleşmesiyle (SnapshotNodeInput / SnapshotEdgeInput /
 * SnapshotEvidenceInput) birebir uyumludur — ID üretmez, normalizer
 * merkezi kuraldır (TŞ §7.1).
 *
 * Güvenlik (proje kırmızı çizgisi 6): süreç yalnızca LİTERAL "dotnet"
 * komutu + SABİT argüman dizisi ["exec", workerDllPath] ile başlatılır;
 * kaynak içerikleri asla komut satırına gitmez — yalnızca stdin JSON'da
 * taşınır.
 */
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type {
  SnapshotEdgeInput,
  SnapshotEvidenceInput,
  SnapshotNodeInput,
} from "@causoryn/domain";

/** TŞ §8 Evidence.analyzerId karşılığı — B1 worker sabitiyle aynı. */
export const CSHARP_ROSLYN_ADAPTER_ID = "roslyn-worker";

/** Adapter sürümü; analyzerFingerprint kurgusunda kullanılır. */
export const CSHARP_ROSLYN_ADAPTER_VERSION = "0.1.0";

/** Tek analyze isteği için varsayılan üst sınır (TŞ §9 resource budget). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Güvenlik bulgusu 4: tek yanıt satırı için varsayılan üst sınır (char).
 * Protocol.cs MaxRequestLineChars'ın (64M) ayna değeridir — istek ve yanıt
 * bacakları aynı bütçeyi paylaşır. Aşım → süreç kill + L0/L1 fallback
 * (sınırsız buffer + sınırsız JSON.parse yerine).
 */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

/** Default "dotnet" komutu — PATH'ten çözülür; opsiyonla override edilebilir. */
export const DEFAULT_DOTNET_COMMAND = "dotnet";

/**
 * Worker DLL repo-relative sabit bölümü — repo kökü import.meta.url'den
 * türetilir (dist/ ve src/ aynı derinlikte olduğundan iki derleme modunda
 * da aynı köke çözülür). Ortam değişkeniyle override edilebilir (config
 * kuralı): CAUSORYN_ROSLYN_WORKER_DLL.
 */
export const WORKER_DLL_RELATIVE_PATH = join(
  "native",
  "roslyn-worker",
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);

/**
 * Worker alt sürecine geçilen ortam değişkeni allowlist'i (güvenlik
 * bulgusu 1, savunma derinliği): stdio tek-kullanıcı modelinde worker
 * parent'ın TÜM env'ini miraslamamalı — anahtar/token gibi allowlist dışı
 * değerler süreç listesinden/çökme dump'ından okunabilir. Listenin amacı
 * dotnet'in ÇALIŞMASI için gereken küçüktür:
 * - PATH: çalıştırılabilir çözümleme + dotnet runtime konumu,
 * - DOTNET_ROOT: ReferenceResolver'ın okuduğu tek açık değişken
 *   (ReferenceResolver.cs CandidateDotNetRoots),
 * - DOTNET_CLI_HOME, USERPROFILE, HOME: dotnet ilk-çalıştırma/nuget konumları,
 * - SystemRoot, COMSPEC, TEMP, TMP: Windows yükleyici/süreç altyapısı.
 */
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "DOTNET_ROOT",
  "DOTNET_CLI_HOME",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
] as const;

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["pipe", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
  },
) => ChildProcess;

/** Adapter'a verilen tek kaynak dosya (bellek-içi, salt-okunur). */
export interface RoslynSourceFile {
  /** Workspace-relative POSIX yolu; ".." ve mutlak yol DomainError ile reddedilir. */
  readonly path: string;
  readonly content: string;
}

export interface RoslynAdapterOptions {
  /** Worker DLL mutlak yolu — SABİT/config'den; kullanıcı girdisi değildir. */
  readonly workerDllPath: string;
  /** dotnet çalıştırılabilirinin yolu/adı. */
  readonly dotnetCommand: string;
  /** Tek istek üst sınırı (ms); aşım → süreç kill + L0/L1 fallback. */
  readonly requestTimeoutMs: number;
  /**
   * Güvenlik bulgusu 4: tek yanıt satırı üst sınırı (char). Aşım → süreç
   * kill + L0/L1 fallback. Varsayılan DEFAULT_RESPONSE_MAX_CHARS.
   */
  readonly responseMaxChars: number;
  /** Spawn enjeksiyonu (yalnızca testler); default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export interface AnalyzeCSharpWorkspaceInput {
  /** Opaque workspace kimliği; boş/boşluk DomainError ile reddedilir. */
  readonly workspaceId: string;
  readonly files: readonly RoslynSourceFile[];
  readonly options?: Partial<RoslynAdapterOptions>;
}

/** Tek dosya tanısı (TS adapter DiagnosticOut kuralıyla aynı). */
export interface RoslynAdapterDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  /** Bilinmiyorsa 0. */
  readonly line: number;
}

/**
 * Adapter yetenek beyanı (TŞ §7: "Her adapter çıktısında capabilities,
 * unsupportedConstructs, coverageRatio, warnings bulunur") — TS adapter
 * sözleşmesinin karşılığı; alanlar B1 worker CapabilitiesOut ile birebir.
 */
export interface RoslynAdapterCapabilities {
  readonly astParse: boolean;
  readonly symbolResolution: boolean;
  readonly containsEdges: boolean;
  readonly callEdges: boolean;
  readonly importEdges: boolean;
  readonly routeDetection: string;
  readonly frameworkLinkers: boolean;
}

/** L0/L1 fallback durumundaki yetenek beyanı — hiçbir sembol düzeyi yok. */
export const WORKER_UNAVAILABLE_CAPABILITIES: RoslynAdapterCapabilities = {
  astParse: false,
  symbolResolution: false,
  containsEdges: false,
  callEdges: false,
  importEdges: false,
  routeDetection: "worker-unavailable",
  frameworkLinkers: false,
};

/** analyzeCSharpWorkspace çıktısı — createSnapshot girdisiyle birebir uyumlu. */
export interface RoslynAdapterResult {
  readonly analyzerId: typeof CSHARP_ROSLYN_ADAPTER_ID;
  readonly analyzerVersion: string;
  /** Worker sağlıklı yanıt verdiyse true; değilse L0/L1 fallback. */
  readonly workerAvailable: boolean;
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: RoslynAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly RoslynAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}
