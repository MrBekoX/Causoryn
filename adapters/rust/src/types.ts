/**
 * @causoryn/adapter-rust — sözleşme tipleri (TŞ v2.1 §7; M1-Rust).
 *
 * Bu adapter, native/rust-worker süreç yönetir: stdin/stdout satır bazlı
 * JSON protokol (PROTOCOL.md v1). Çıktı, packages/domain createSnapshot
 * GİRDİ sözleşmesiyle (SnapshotNodeInput / SnapshotEdgeInput /
 * SnapshotEvidenceInput) birebir uyumludur — ID ÜRETMEZ; canonical ID /
 * de-duplication merkezi normalizer'dadır (TŞ §7.1).
 *
 * Güvenlik (proje kırmızı çizgisi 6): süreç, LİTERAL binary adı
 * ("causoryn-rust-worker") + BOŞ sabit argüman dizisiyle başlatılır;
 * binary dizini child env PATH'ine öneklemeyle verilir. Kaynak içerikleri
 * asla komut satırına gitmez — yalnızca stdin JSON'da taşınır.
 */
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SnapshotEdgeInput,
  SnapshotEvidenceInput,
  SnapshotNodeInput,
} from "@causoryn/domain";
import { resolveCausorynAssetRoot } from "@causoryn/sidecar-ipc";

/** TŞ §8 Evidence.analyzerId karşılığı — worker sabitiyle aynı. */
export const RUST_ADAPTER_ID = "rust-worker";

/** Adapter sürümü; analyzerFingerprint kurgusunda kullanılır. */
export const RUST_ADAPTER_VERSION = "0.1.0";

/** Tek analyze isteği için varsayılan üst sınır (TŞ §9 resource budget). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Tek yanıt satırı için varsayılan üst sınır (char) — 64 MiB
 * (67.108.864). NOT (bayat yorum düzeltmesi): bu değer worker sabitinin
 * BİREBİR aynası DEĞİLDİR — rust worker istek satırı üst sınırı
 * MAX_REQUEST_LINE_BYTES = 64_000_000 desimaldir (protocol.rs), python
 * worker'da 64 MiB'tır (worker.py MAX_REQUEST_LINE_BYTES). Amaç aynıdır
 * (istek bütçesinin yanıt karşılığı; aşım → süreç kill + L0/L1
 * fallback) ancak üç taraftaki sayısal değerler bilinçli olarak 64
 * mertebesinde, birebir eşitlik iddiası OLMADAN seçilmiştir.
 */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

/** Varsayılan cargo build üst sınırı (ilk derleme crates.io fetch'i dakikalar sürebilir). */
export const DEFAULT_CARGO_BUILD_TIMEOUT_MS = 600_000;

/**
 * Worker binary dizini repo-relative sabit bölümü. Ortam değişkeniyle
 * override edilebilir (config kuralı): CAUSORYN_RUST_WORKER_DIR.
 */
export const WORKER_DIR_RELATIVE_PATH = join(
  "native",
  "rust-worker",
  "target",
  "debug",
);

/** LİTERAL worker binary adı (platforma göre). */
export const WORKER_BINARY_NAME =
  process.platform === "win32"
    ? "causoryn-rust-worker.exe"
    : "causoryn-rust-worker";

/** Worker Cargo.toml repo-relative sabit bölümü (cargo build girdisi). */
export const WORKER_MANIFEST_RELATIVE_PATH = join(
  "native",
  "rust-worker",
  "Cargo.toml",
);

/**
 * Worker binary'nin TAM yolu dinamik asset kökünden türetilir. Override:
 * CAUSORYN_RUST_WORKER_DIR.
 */
export function defaultWorkerDir(): string {
  const override = process.env["CAUSORYN_RUST_WORKER_DIR"];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  return join(resolveCausorynAssetRoot(import.meta.url), WORKER_DIR_RELATIVE_PATH);
}

/**
 * Worker Cargo.toml TAM yolu — cargo build girdisi (dinamik asset kökü;
 * kullanıcı girdisi değildir).
 */
export function defaultWorkerManifestPath(): string {
  return join(
    resolveCausorynAssetRoot(import.meta.url),
    WORKER_MANIFEST_RELATIVE_PATH,
  );
}

/**
 * Salt-okunur paket kurulumlarında cargo derleme çıktısı için yazılabilir
 * hedef dizin. CAUSORYN_RUST_TARGET_DIR ile override edilebilir.
 */
export function defaultWritableRustTargetDir(
  env?: NodeJS.ProcessEnv,
): string {
  return (
    (env ?? process.env)["CAUSORYN_RUST_TARGET_DIR"]?.trim() ||
    join(homedir(), ".causoryn", "cache", "rust-worker-target")
  );
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["pipe", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
  },
) => ChildProcess;

/** Adapter'a verilen tek kaynak dosya (bellek-içi, salt-okunur). */
export interface RustSourceFile {
  /** Workspace-relative POSIX yolu; ".." ve mutlak yol DomainError ile reddedilir. */
  readonly path: string;
  readonly content: string;
}

export interface RustAdapterOptions {
  /**
   * Worker binary DİZİNİ — SABİT repo-içi yol / config override'ı;
   * kullanıcı girdisi değildir. Varsayılan: defaultWorkerDir().
   */
  readonly workerDir: string;
  /**
   * LİTERAL binary adı — sabit constant; opsiyonla değiştirilmez
   * (config kuralı: binary adı platform sabitidir).
   */
  readonly workerBinaryName: string;
  /**
   * cargo çalıştırılabilirinin KONUM İPUCU değil, cargo-home dizini
   * override'ı: verilirse child PATH bu dizinle öneklenir (LİTERAL
   * "cargo" komutuyla). Varsayılan: resolveCargoHomeDir().
   */
  readonly cargoHomeDir?: string;
  /** Tek istek üst sınırı (ms); aşım → süreç kill + L0/L1 fallback. */
  readonly requestTimeoutMs: number;
  /** Tek yanıt satırı üst sınırı (char); aşım → süreç kill + fallback. */
  readonly responseMaxChars: number;
  /** cargo build üst sınırı (ms); ilk derleme dakikalar sürebilir. */
  readonly cargoBuildTimeoutMs: number;
  /** Spawn enjeksiyonu (yalnızca testler); default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export interface AnalyzeRustWorkspaceInput {
  /** Opaque workspace kimliği; boş/boşluk DomainError ile reddedilir. */
  readonly workspaceId: string;
  readonly files: readonly RustSourceFile[];
  readonly options?: Partial<RustAdapterOptions>;
}

/** Tek dosya tanısı (TS adapter DiagnosticOut kuralıyla aynı). */
export interface RustAdapterDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  /** Bilinmiyorsa 0. */
  readonly line: number;
}

/**
 * Adapter yetenek beyanı (TŞ §7: "Her adapter çıktısında capabilities,
 * unsupportedConstructs, coverageRatio, warnings bulunur") — alanlar
 * worker CapabilitiesOut ile birebirdir.
 */
export interface RustAdapterCapabilities {
  readonly astParse: boolean;
  readonly symbolResolution: boolean;
  readonly containsEdges: boolean;
  readonly callEdges: boolean;
  readonly importEdges: boolean;
  readonly routeDetection: string;
  readonly frameworkLinkers: boolean;
}

/** L0/L1 fallback durumundaki yetenek beyanı — hiçbir sembol düzeyi yok. */
export const WORKER_UNAVAILABLE_CAPABILITIES: RustAdapterCapabilities = {
  astParse: false,
  symbolResolution: false,
  containsEdges: false,
  callEdges: false,
  importEdges: false,
  routeDetection: "worker-unavailable",
  frameworkLinkers: false,
};

/** analyzeRustWorkspace çıktısı — createSnapshot girdisiyle birebir uyumlu. */
export interface RustAdapterResult {
  readonly analyzerId: typeof RUST_ADAPTER_ID;
  readonly analyzerVersion: string;
  /** Worker sağlıklı yanıt verdiyse true; değilse L0/L1 fallback. */
  readonly workerAvailable: boolean;
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: RustAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly RustAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}
