/**
 * @causoryn/adapter-python — sözleşme tipleri (TŞ v2.1 §7, §7.1; M1-Python).
 *
 * Bu adapter, native/python-worker (saf stdlib Python sidecar) süreç
 * yönetir: stdin/stdout satır bazlı JSON protokol (native/python-worker/
 * PROTOCOL.md v1 — roslyn-worker PROTOCOL.md v1 deseni). Çıktı,
 * packages/domain createSnapshot GİRDİ sözleşmesiyle (SnapshotNodeInput /
 * SnapshotEdgeInput / SnapshotEvidenceInput) birebir uyumludur — ID
 * üretmez, normalizer merkezi kuraldır (TŞ §7.1).
 *
 * Güvenlik (proje kırmızı çizgisi 6): süreç yalnızca LİTERAL "python"
 * komutu + SABİT argüman dizisi ["-B", workerScriptPath] ile başlatılır;
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

/** TŞ §8 Evidence.analyzerId karşılığı — worker sabitiyle aynı. */
export const PYTHON_WORKER_ADAPTER_ID = "python-worker";

/** Adapter sürümü; worker ANALYZER_VERSION (0.1.0) ile senkron tutulur. */
export const PYTHON_WORKER_ADAPTER_VERSION = "0.1.0";

/** Tek analyze isteği için varsayılan üst sınır (TŞ §9 resource budget). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Tek yanıt satırı için varsayılan üst sınır (char). Worker MaxRequestLineBytes
 * (64 MB) bütçesinin aynasıdır. Aşım → süreç kill + L0/L1 fallback (sınırsız
 * buffer + sınırsız JSON.parse yerine; güvenlik bulgusu 4 deseni).
 */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

/** Default "python" komutu — PATH'ten çözülür; opsiyonla override edilebilir. */
export const DEFAULT_PYTHON_COMMAND = "python";

/**
 * Worker script repo-relative sabit bölümü — repo kökü import.meta.url'den
 * türetilir (dist/ ve src/ aynı derinlikte olduğundan iki derleme modunda da
 * aynı köke çözülür). Ortam değişkeniyle override edilebilir (config kuralı):
 * CAUSORYN_PYTHON_WORKER_SCRIPT.
 */
export const WORKER_SCRIPT_RELATIVE_PATH = join("native", "python-worker", "worker.py");

/**
 * Worker alt sürecine geçilen ortam değişkeni allowlist'i (csharp-roslyn
 * WORKER_ENV_ALLOWLIST deseni): worker parent'ın TÜM env'ini miraslamamalı.
 * - PATH: python çalıştırılabilir çözümlemesi,
 * - SystemRoot, COMSPEC, TEMP, TMP: Windows yükleyici/süreç altyapısı,
 * - USERPROFILE, HOME: kullanıcı düzeyi konumlar.
 * PYTHONPATH BİLBLİÇLI OLARAK TAŞINMAZ: worker saf stdlib'tir; ortamdaki
 * arama yolları determinizmi etkileyemez.
 * PYTHONIOENCODING allowlist'te DEĞİLDİR: parent değerinden bağımsız olarak
 * buildWorkerEnv tarafından her zaman "utf-8" sabitlenir (takım denetimi
 * bulgusu — worker stderr'inin locale kod sayfasına düşmesini engeller).
 */
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
] as const;

/** Worker log kanalının kodlaması — parent env'den bağımsız sabittir. */
export const WORKER_IO_ENCODING = "utf-8";

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["pipe", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
  },
) => ChildProcess;

/** Adapter'a verilen tek kaynak dosya (bellek-içi, salt-okunur). */
export interface PythonSourceFile {
  /** Workspace-relative POSIX yolu; ".." ve mutlak yol DomainError ile reddedilir. */
  readonly path: string;
  readonly content: string;
}

export interface PythonAdapterOptions {
  /** Worker script mutlak yolu — SABİT/config'den; kullanıcı girdisi değildir. */
  readonly workerScriptPath: string;
  /** python çalıştırılabilirinin yolu/adı. */
  readonly pythonCommand: string;
  /** Tek istek üst sınırı (ms); aşım → süreç kill + L0/L1 fallback. */
  readonly requestTimeoutMs: number;
  /** Tek yanıt satırı üst sınırı (char); aşım → süreç kill + L0/L1 fallback. */
  readonly responseMaxChars: number;
  /** Spawn enjeksiyonu (yalnızca testler); default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export interface AnalyzePythonWorkspaceInput {
  /** Opaque workspace kimliği; boş/boşluk DomainError ile reddedilir. */
  readonly workspaceId: string;
  readonly files: readonly PythonSourceFile[];
  readonly options?: Partial<PythonAdapterOptions>;
}

/** Tek dosya tanısı (worker DiagnosticOut kuralıyla aynı). */
export interface PythonAdapterDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  /** Bilinmiyorsa 0. */
  readonly line: number;
}

/**
 * Adapter yetenek beyanı (TŞ §7: "Her adapter çıktısında capabilities,
 * unsupportedConstructs, coverageRatio, warnings bulunur") — alanlar worker
 * CapabilitiesOut ile birebir.
 */
export interface PythonAdapterCapabilities {
  readonly astParse: boolean;
  readonly symbolResolution: boolean;
  readonly containsEdges: boolean;
  readonly callEdges: boolean;
  readonly importEdges: boolean;
  readonly routeDetection: string;
  readonly frameworkLinkers: boolean;
}

/** L0/L1 fallback durumundaki yetenek beyanı — hiçbir sembol düzeyi yok. */
export const WORKER_UNAVAILABLE_CAPABILITIES: PythonAdapterCapabilities = {
  astParse: false,
  symbolResolution: false,
  containsEdges: false,
  callEdges: false,
  importEdges: false,
  routeDetection: "worker-unavailable",
  frameworkLinkers: false,
};

/** analyzePythonWorkspace çıktısı — createSnapshot girdisiyle birebir uyumlu. */
export interface PythonAdapterResult {
  readonly analyzerId: typeof PYTHON_WORKER_ADAPTER_ID;
  readonly analyzerVersion: string;
  /** Worker sağlıklı yanıt verdiyse true; değilse L0/L1 fallback. */
  readonly workerAvailable: boolean;
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: PythonAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly PythonAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}
