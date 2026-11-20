/**
 * @causoryn/adapter-go — sözleşme tipleri (TŞ v2.1 §7, §7.1; M1-Go dilimi).
 *
 * Bu adapter, native/go-worker sürecini yönetir: stdin/stdout satır bazlı
 * JSON protokolü (native/go-worker/PROTOCOL.md v1; Roslyn worker deseninin
 * Go karşılığı). Çıktı, packages/domain createSnapshot GİRDİ sözleşmesiyle
 * (SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput) birebir
 * uyumludur — adapter ID ÜRETMEZ; canonical ID / de-duplication merkezi
 * normalizer kuraldır (TŞ §7.1).
 *
 * Güvenlik (kırmızı çizgi 6): süreç yalnızca config'den SABİT go binary
 * yolu (default literal "go") + SABİT argüman dizisi ["run", "./cmd/worker"]
 * ile SABİT cwd (native/go-worker) üzerinden başlatılır; kaynak içerikleri
 * asla komut satırına taşınmaz — yalnızca stdin JSON'da yaşar.
 */
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type {
  SnapshotEdgeInput,
  SnapshotEvidenceInput,
  SnapshotNodeInput,
} from "@causoryn/domain";

/** TŞ §8 Evidence.analyzerId karşılığı — Go worker sabitiyle aynı. */
export const GO_ADAPTER_ID = "go-worker";

/** Adapter sürümü; analyzerFingerprint kurgusunda kullanılır. */
export const GO_ADAPTER_VERSION = "0.1.0";

/**
 * Tek analyze isteği için varsayılan üst sınır (ms). `go run` her koşumda
 * derleme yapar: soğuk GOCACHE'te ilk derleme 30 sn'yi aşabilir — Roslyn
 * adapter'ındaki 30 sn yerine 120 sn seçildi (gerekçe README "spawn
 * kararı" bölümünde; ısınmış cache'te koşum saniyeler içindedir).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Tek yanıt satırı için varsayılan üst sınır (char). Roslyn adapter'ındaki
 * DEFAULT_RESPONSE_MAX_CHARS aynasıdır (istek/yanıt aynı bütçeyi paylaşır).
 * Aşım → süreç kill + L0/L1 fallback.
 */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

/** Default "go" komutu — PATH'ten çözülür; opsiyonla override edilebilir. */
export const DEFAULT_GO_BINARY_PATH = "go";

/**
 * Worker modül repo-relative sabit bölümü — repo kökü import.meta.url'den
 * türetilir (src/ ve dist/ aynı derinlikte). Ortam değişkeniyle override:
 * CAUSORYN_GO_WORKER_DIR.
 */
export const WORKER_DIR_RELATIVE_PATH = join("native", "go-worker");

/**
 * Worker alt sürecine geçilen ortam değişkeni allowlist'i (güvenlik
 * bulgusu 1 savunma derinliği; Roslyn adapter deseni). go toolchain'inin
 * ÇALIŞMASI için gerekenler taşınır:
 * - PATH: çalıştırılabilir çözümleme,
 * - SystemRoot, COMSPEC: Windows yükleyici/süreç altyapısı,
 * - TEMP, TMP: go build geçici dizinleri,
 * - USERPROFILE, HOME: GOPATH default'u (%USERPROFILE%\go),
 * - APPDATA: go env config dosyası (%APPDATA%\go\env),
 * - LOCALAPPDATA: GOCACHE default'u (%LOCALAPPDATA%\go-build),
 * - GOPATH, GOROOT, GOCACHE, GOMODCACHE, GOENV: açık go konum değişkenleri.
 * Allowlist dışı değerler (anahtar/token vb.) worker'a MİRASLANMAZ.
 */
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "GOENV",
] as const;

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["pipe", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
    /**
     * Worker spawn'ında zorunlu (SABİT workerDir); ağaç-kill yardımcı
     * spawn'ında (taskkill) anlamsızdır — opsiyoneldir.
     */
    readonly cwd?: string;
  },
) => ChildProcess;

/** Adapter'a verilen tek kaynak dosya (bellek-içi, salt-okunur). */
export interface GoSourceFile {
  /** Workspace-relative POSIX yolu; ".." ve mutlak yol DomainError ile reddedilir. */
  readonly path: string;
  readonly content: string;
}

export interface GoAdapterOptions {
  /**
   * go çalıştırılabilirinin yolu/adı. Default literal "go" (PATH); özel
   * kurulumlarda (ör. `/usr/local/go/bin/go` veya `C:/Program Files/Go/bin/go.exe`)
   * açık yol verilebilir. Değer kullanıcı girdisi DEĞİLDİR: config
   * sabitidir ve komut satırına aynen geçirilir (interpolasyon yok).
   */
  readonly goBinaryPath?: string;
  /**
   * Önceden derlenmiş worker binary yolu (release/paketli kurulum modu).
   * Verilirse spawn [binaryPath, []] olur ("go run" atlanır). Env override:
   * CAUSORYN_GO_WORKER_BIN. Test binary konvansiyonu:
   * native/go-worker/bin/go-worker-test.exe (bin/ gitignore'dadır).
   */
  readonly goWorkerBinaryPath?: string;
  /** go module kökü (native/go-worker); env override CAUSORYN_GO_WORKER_DIR. */
  readonly workerDir?: string;
  /** Tek istek üst sınırı (ms); aşım → süreç kill + L0/L1 fallback. */
  readonly requestTimeoutMs?: number;
  /** Tek yanıt satırı üst sınırı (char); aşım → süreç kill + fallback. */
  readonly responseMaxChars?: number;
  /** Spawn enjeksiyonu (yalnızca testler); default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export interface AnalyzeGoWorkspaceInput {
  /** Opaque workspace kimliği; boş/boşluk DomainError ile reddedilir. */
  readonly workspaceId: string;
  readonly files: readonly GoSourceFile[];
  readonly options?: Partial<GoAdapterOptions>;
}

/** Tek dosya tanısı (TS adapter DiagnosticOut kuralıyla aynı). */
export interface GoAdapterDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  /** Bilinmiyorsa 0. */
  readonly line: number;
}

/**
 * Adapter yetenek beyanı (TŞ §7) — alanlar go-worker CapabilitiesOut ile
 * birebir. Dürüstlük notu: symbolResolution=false — go/types semantik
 * çözümleme yoktur; package adı ve benzersiz metot adı kuralları
 * heuristic'tir (PROTOCOL.md resolution tablosu).
 */
export interface GoAdapterCapabilities {
  readonly astParse: boolean;
  readonly symbolResolution: boolean;
  readonly containsEdges: boolean;
  readonly callEdges: boolean;
  readonly importEdges: boolean;
  readonly routeDetection: string;
  readonly frameworkLinkers: boolean;
}

/** Worker kullanılamadığındaki yetenek beyanı — hiçbir sembol düzeyi yok. */
export const WORKER_UNAVAILABLE_CAPABILITIES: GoAdapterCapabilities = {
  astParse: false,
  symbolResolution: false,
  containsEdges: false,
  callEdges: false,
  importEdges: false,
  routeDetection: "worker-unavailable",
  frameworkLinkers: false,
};

/** analyzeGoWorkspace çıktısı — createSnapshot girdisiyle birebir uyumlu. */
export interface GoAdapterResult {
  readonly analyzerId: typeof GO_ADAPTER_ID;
  readonly analyzerVersion: string;
  /** Worker sağlıklı yanıt verdiyse true; değilse L0/L1 fallback. */
  readonly workerAvailable: boolean;
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: GoAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly GoAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}
