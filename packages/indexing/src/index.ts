/**
 * @causoryn/indexing — IndexCoordinator (Faz A dilimi, sprint-1 görev 6;
 * sprint-2 B9 çoklu dil entegrasyonu).
 *
 * Pipeline: dosya envanteri (WorkspaceAccessPolicy ile) → dil adapter'ları
 * (TypeScript senkron, C# Roslyn worker async) → graph inşası (domain
 * deterministik ID'leri) → atomik snapshot publish (TŞ v2.1 §9, §25/4-5).
 *
 * Bağımlılık sınırları (wiki/architecture.md): bu paket workspace/domain/
 * graph/adapter-typescript/adapter-csharp-roslyn + M2 ile adapter-python/
 * adapter-go/adapter-rust'e bağlıdır; MCP paketini import ETMEZ. Adapter
 * metadata'sı (analyzerId/version/levels) uygulama düzeyi bilgi olarak
 * buradan yayımlanır — mcp-server parser paketini doğrudan import etmez;
 * get_capabilities bu metadata'yı INDEXED_ADAPTERS üzerinden okur.
 *
 * Invalidation (FS watcher, 300–1000 ms debounce): `WorkspaceWatcher`
 * (sprint-2 B7). Sprint-2 B6: `IndexJobManager`, refresh_index tool'u için
 * `runIndex` pipeline'ını in-process async iş olarak sarmalar (TŞ §10.2).
 * Sprint-2 B9: `runIndexAsync`/`runIncrementalIndexAsync` — .cs dosyaları
 * analyzeCSharpWorkspace'e yönlendirilir; TS + C# TEK snapshot'a katılır;
 * analyzerFingerprint fp2 şeması (bkz. ./fingerprint.js) ref-pack sürümleri
 * + discovery kaynağı + ayarlar hash'ini taşır (README "Açık borç"
 * kapanışı).
 */
import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_FRAMEWORK_LINKERS,
  TS_ADAPTER_VERSION,
} from "@causoryn/adapter-typescript";
import {
  CSHARP_ROSLYN_ADAPTER_ID,
  CSHARP_ROSLYN_ADAPTER_VERSION,
} from "@causoryn/adapter-csharp-roslyn";
import {
  GO_ADAPTER_ID,
  GO_ADAPTER_VERSION,
} from "@causoryn/adapter-go";
import {
  PYTHON_WORKER_ADAPTER_ID,
  PYTHON_WORKER_ADAPTER_VERSION,
} from "@causoryn/adapter-python";
import {
  RUST_ADAPTER_ID,
  RUST_ADAPTER_VERSION,
} from "@causoryn/adapter-rust";

export { IndexingError } from "./errors.js";
export type { IndexingErrorCode } from "./errors.js";
export { collectInventory } from "./inventory.js";
export type { InventoryEntry } from "./inventory.js";
export {
  ANALYZER_FINGERPRINT_SCHEMA_VERSION,
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
} from "./fingerprint.js";
export type {
  AnalyzerFingerprintInput,
  GoFingerprintContext,
  GoIndexSettings,
  PythonFingerprintContext,
  PythonIndexSettings,
  RoslynAdapterSettings,
  RoslynFingerprintContext,
  RoslynRefPackContext,
  RoslynRefPackEntry,
  RustFingerprintContext,
  RustIndexSettings,
  WorkerRunStatus,
} from "./fingerprint.js";
export { INDEXING_VERSION, IndexService } from "./index-service.js";
export type {
  CsharpIndexOptions,
  GoIndexOptions,
  IndexDiagnostic,
  IndexLimits,
  IndexRunResult,
  IndexServiceOptions,
  PythonIndexOptions,
  RustIndexOptions,
} from "./index-service.js";
export { IndexJobManager } from "./job-manager.js";
export type {
  IndexJobError,
  IndexJobManagerOptions,
  IndexJobMode,
  IndexJobRecord,
  IndexJobStatus,
} from "./job-manager.js";
export {
  hashWorkspaceFile,
  WATCHER_DEBOUNCE_DEFAULT_MS,
  WATCHER_DEBOUNCE_MAX_MS,
  WATCHER_DEBOUNCE_MIN_MS,
  WorkspaceWatcher,
} from "./watcher.js";
export type {
  WatchFactory,
  WatchHandle,
  WorkspaceWatcherOptions,
  WorkspaceWatcherState,
  WorkspaceWatcherStats,
} from "./watcher.js";

/**
 * Adapter linker beyanından türetilen metadata etiketi (denetim bulgusu 1
 * düzeltmesi): hiçbiri yoksa "yok", varsa '+' ile birleşik linker
 * kimlikleri (ör. "express+nextjs"). Sabit kopya TUTULMAZ — adapter'ın
 * TS_ADAPTER_FRAMEWORK_LINKERS beyanıyla birlikte sürüklenir; aksi halde
 * get_capabilities bayat "yok" değerini MCP yüzeyine taşır.
 */
const FRAMEWORK_LINKERS_LABEL =
  TS_ADAPTER_FRAMEWORK_LINKERS.length === 0
    ? "yok"
    : TS_ADAPTER_FRAMEWORK_LINKERS.join("+");

/**
 * Adapter yetenek beyanı (uygulama düzeyi metadata; TŞ §7). Bu üç alan
 * get_capabilities yüzey sözleşmesidir: mcp-server bunları birebir
 * sunar (services.ts adapters map) ve yüzeyin ötesine geçen hiçbir
 * tüketicisi yoktur. Yüzey sözleşmesinde olmayan yetenek alanları
 * (ör. roslyn worker'ın routeDetection beyanı) BURADA beyan edilmez —
 * alan mcp-server (bu dilimin kapsamı dışı) yüzeyine taşınmadığı sürece
 * ölü metadata üretmemek için bilgisi adapter README'sinde yaşar
 * (denetim bulgusu). Yüzeye ekleme, mcp-server sahibinin dilimidir.
 */
export interface IndexedAdapterLevels {
  readonly astParse: string;
  readonly symbolResolution: string;
  /** "yok" veya '+' ile birleşik aktif linker kimlikleri (ör. "express+nextjs"). */
  readonly frameworkLinkers: string;
}

export interface IndexedAdapterInfo {
  readonly language: "typescript" | "csharp" | "python" | "go" | "rust";
  readonly analyzerId: string;
  readonly version: string;
  readonly levels: IndexedAdapterLevels;
  readonly source: string;
}

/**
 * Kayıtlı dil adapter'ları (get_capabilities bu metadata'yı sunar).
 * B9 ile csharp-roslyn kaydı eklendi: TŞ §7 seviye tablosu uyarınca
 * C#/.NET → "Roslyn sidecar: L2 + controller/minimal API L3" — worker
 * astParse (L1) + symbolResolution (L2) + route katmanı (L3) üretir.
 * L3 route yeteneğinin adı ("aspnetcore-controller-attribute-and-minimal-
 * api-call-pattern") Protocol.cs CapabilitiesOut default'udur; yüzey
 * sözleşmesine girmediği için burada sabit kopyalanmaz — ayrıntı
 * adapters/csharp-roslyn/README.md'dedir. frameworkLinkers B1 diliminde
 * açıkça üretilmez (worker frameworkLinkers=false beyanı).
 *
 * M2 ile python/go/rust sidecar adapter kayıtları eklendi (TŞ §7, §23
 * dil planı). Dürüstlük notları (worker CapabilitiesOut beyanlarıyla
 * birebir; PROTOCOL.md v1):
 * - python: symbolResolution L2 (isim bağlamı: aynı modül verified,
 *   import heuristic); L3 dekoratör route katmanı ("python-decorator-
 *   route-pattern", worker.py:1026) frameworkLinkers alanında taşınır.
 * - go: worker symbolResolution=false beyan eder (go/types semantik
 *   çözümleme yok; package adı + benzersiz metot adı kuralları
 *   heuristic — cmd/worker/main.go:80); "L2" UYDURULMAZ, dürüst etiket
 *   yazılır. L3 route katmanı ("go-http-handlefunc-and-gin-echo-chi-
 *   registration-pattern").
 * - rust: syn tabanlı çözümleme heuristic-ağırlıklıdır (trait dispatch
 *   çözülemez, modül önekleri doğrulanmaz — PROTOCOL.md resolution
 *   tablosu); dürüst "heuristic-heavy" etiketi. L3 attribute-macro route
 *   katmanı ("rust-attribute-macro-route-pattern", protocol.rs:23).
 */
export const INDEXED_ADAPTERS: readonly IndexedAdapterInfo[] = [
  {
    language: "typescript",
    analyzerId: TS_ADAPTER_ANALYZER_ID,
    version: TS_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "L2",
      frameworkLinkers: FRAMEWORK_LINKERS_LABEL,
    },
    source: "adapters/typescript",
  },
  {
    language: "csharp",
    analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
    version: CSHARP_ROSLYN_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "L2",
      frameworkLinkers: "yok",
    },
    source: "adapters/csharp-roslyn",
  },
  {
    language: "python",
    analyzerId: PYTHON_WORKER_ADAPTER_ID,
    version: PYTHON_WORKER_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "L2",
      frameworkLinkers: "decorator-route-pattern (L3)",
    },
    source: "adapters/python",
  },
  {
    language: "go",
    analyzerId: GO_ADAPTER_ID,
    version: GO_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "heuristic-only (semantik L2 yok)",
      frameworkLinkers: "http-router-registration (L3)",
    },
    source: "adapters/go",
  },
  {
    language: "rust",
    analyzerId: RUST_ADAPTER_ID,
    version: RUST_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "heuristic-heavy",
      frameworkLinkers: "attribute-macro-route (L3)",
    },
    source: "adapters/rust",
  },
];
