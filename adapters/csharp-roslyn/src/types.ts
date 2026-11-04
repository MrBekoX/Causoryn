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

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: ["pipe", "pipe", "pipe"] },
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
