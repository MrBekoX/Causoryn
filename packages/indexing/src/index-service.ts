import { existsSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_VERSION,
  analyzeTypeScriptProgram,
} from "@causoryn/adapter-typescript";
import {
  CSHARP_ROSLYN_ADAPTER_ID,
  CSHARP_ROSLYN_ADAPTER_VERSION,
  DEFAULT_DOTNET_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WORKER_DLL_RELATIVE_PATH,
  analyzeCSharpWorkspace,
  type AnalyzeCSharpWorkspaceInput,
  type RoslynAdapterDiagnostic,
  type RoslynAdapterResult,
} from "@causoryn/adapter-csharp-roslyn";
import {
  DEFAULT_GO_BINARY_PATH,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_GO_REQUEST_TIMEOUT_MS,
  GO_ADAPTER_ID,
  GO_ADAPTER_VERSION,
  WORKER_DIR_RELATIVE_PATH as GO_WORKER_DIR_RELATIVE_PATH,
  analyzeGoWorkspace,
  type GoAdapterResult,
} from "@causoryn/adapter-go";
import {
  DEFAULT_PYTHON_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_PY_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS as DEFAULT_PY_RESPONSE_MAX_CHARS,
  PYTHON_WORKER_ADAPTER_ID,
  PYTHON_WORKER_ADAPTER_VERSION,
  WORKER_SCRIPT_RELATIVE_PATH,
  analyzePythonWorkspace,
  type PythonAdapterResult,
} from "@causoryn/adapter-python";
import {
  DEFAULT_CARGO_BUILD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_RS_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS as DEFAULT_RS_RESPONSE_MAX_CHARS,
  RUST_ADAPTER_ID,
  RUST_ADAPTER_VERSION,
  WORKER_BINARY_NAME,
  defaultWorkerDir,
  analyzeRustWorkspace,
  type RustAdapterResult,
} from "@causoryn/adapter-rust";
import {
  canonicalJson,
  createEdge,
  evidenceId,
  nodeId,
  sha256Hex,
  utf8Encode,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type NodeKind,
  type NodeRef,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
  type SourceSpan,
} from "@causoryn/domain";
import {
  GraphRepositoryError,
  type GraphRepository,
  type PublishableState,
  type SymbolIndexEntry,
  type SymbolSearchStore,
} from "@causoryn/graph";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import {
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
  type GoIndexSettings,
  type PythonIndexSettings,
  type RoslynAdapterSettings,
  type RoslynDiscoveryStatus,
  type RoslynRefPackContext,
  type RustIndexSettings,
  type WorkerRunStatus,
} from "./fingerprint.js";
import { collectInventory, type InventoryEntry } from "./inventory.js";

/**
 * IndexService — indeksleme pipeline'ı (TŞ v2.1 §9, §25/4-5; sprint-1
 * görev 6 + sprint-2 B7 Live Architecture + sprint-2 B9 çoklu dil
 * entegrasyonu):
 *
 *   dosya envanteri (WorkspaceAccessPolicy ile) → dil adapter'ları
 *   (TypeScript senkron, C# Roslyn worker async) → graph inşası
 *   (deterministik domain ID'leri) → atomik snapshot publish
 *
 * - Envanter: `collectInventory` (politika izinli, deterministik sıralı).
 * - Adapter: salt-okunur kaynak çantası; tek dosyanın parse hatası analizi
 *   düşürmez (diagnostics + state partial).
 * - Graph: node/edge/evidence kimlikleri domain katmanında türetilir
 *   (TŞ §8 invariant iii); her node'un kimlik `relativePath` bileşeni
 *   graph kongresi gereği `node.location.relativePath` ile aynıdır.
 * - Publish: repository `beginBuild → add* → publish` atomik akışı
 *   (ADR-005); hata durumunda `failBuild` ile kayıt `failed` olur ve
 *   yayın akışına hiçbir şey girmez.
 * - Bu paket saat okumaz: `createdAt`/`publishedAt` enjekte edilen
 *   `clock`'tan gelir (domain/repository ile aynı determinizm ilkesi).
 *
 * B9 çoklu dil sözleşmesi (iki koşum yolu) + M2 ile beş dil:
 * - `runIndexAsync` / `runIncrementalIndexAsync`: TAM pipeline — .cs
 *   dosyaları analyzeCSharpWorkspace'e; .py/.go/.rs dosyaları
 *   analyzePythonWorkspace/analyzeGoWorkspace/analyzeRustWorkspace'e
 *   yönlendirilir; beş dilin çıktıları TEK snapshot'a katılır (dangling
 *   yok — cross-boundary sözleşmesi). Bir worker kullanılamıyorsa o
 *   adapter'ın L0/L1 fallback'i ile motor çökmez (partial + explicit
 *   warning); diğer dillerin analizi yaşar.
 * - `runIndex` / `runIncrementalIndex` (SENKRON köprü): Roslyn/python/go/
 *   rust worker'lar async koştuğu için senkron imza derin analizi
 *   BEKLEYEMEZ; TS dışındaki dil dosyaları yalnızca L0 envanter düzeyinde
 *   (File node'ları, uydurma sembol/kenar yok) temsil edilir ve bu
 *   dürüstçe partial + explicit warning ile raporlanır (TŞ §7 "yalnızca
 *   kanıtlanabilen L0/L1 bilgisi sunulur"). Senkron yol hiçbir koşulda
 *   worker başlatmaz — spawn çağrısı yalnızca adapter'ların async
 *   API'sindedir.
 */
/**
 * Pipeline sürümü; envanter evidence `analyzerVersion` alanına yazılır.
 * Manifest hizası (denetim bulgusu): bu sabit packages/indexing
 * package.json sürümüyle KİLİTLİDİR (test: index-service-csharp.test.ts
 * "INDEXING_VERSION packages/indexing manifest sürümüyle aynıdır") —
 * mcp-server iç workspace bağımlılıklarını exact manifest sürümüne pinlediğinden
 * (packages/mcp-server/package.json) sürüm yükseltmesi manifest-first
 * yapılmalıdır; aksi halde npm çözümlemesi kırılır. Pipeline davranış
 * kimliği, bu sürümden bağımsız olarak analyzerFingerprint fp2 şemasıyla
 * taşınır (fp1→fp2 geçişi snapshot meta'da ayrışır).
 */
export const INDEXING_VERSION = "0.2.0";

/** Envanter/adaptasyon limitleri (TŞ §20 index bölümü). */
export interface IndexLimits {
  readonly maxFiles: number;
}

/**
 * C# adapter ayarları (IndexService düzeyi yapılandırma; MCP araç girdisi
 * değildir). Tanımsız alanlar adapter varsayılanlarına düşer; etkin
 * değerler fingerprint opts hash'ine girer.
 */
export interface CsharpIndexOptions {
  readonly dotnetCommand?: string;
  readonly requestTimeoutMs?: number;
  readonly workerDllPath?: string;
  /**
   * Yalnızca test enjeksiyonu (adapter RoslynAdapterOptions.spawnProcess
   * precedens'iyle aynı kural): analiz fonksiyonu seam'i. Prod yol
   * analyzeCSharpWorkspace'dir; opts fingerprint hash'ine GİRMEZ.
   */
  readonly analyzeCSharp?: AnalyzeCSharpFunction;
}

/** analyzeCSharpWorkspace ile aynı imza (seam tipi). */
export type AnalyzeCSharpFunction = (
  input: AnalyzeCSharpWorkspaceInput,
) => Promise<RoslynAdapterResult>;

/**
 * Python adapter ayarları (IndexService düzeyi yapılandırma; MCP araç
 * girdisi değildir; M2). Tanımsız alanlar adapter varsayılanlarına düşer
 * (env override'ları dahil); etkin değerler fingerprint pyopts hash'ine
 * girer.
 */
export interface PythonIndexOptions {
  readonly pythonCommand?: string;
  readonly requestTimeoutMs?: number;
  readonly workerScriptPath?: string;
}

/**
 * Go adapter ayarları (M2). goWorkerBinaryPath verilirse önceden
 * derlenmiş binary modu ("go run" atlanır); env override'ları
 * (CAUSORYN_GO_WORKER_BIN / CAUSORYN_GO_WORKER_DIR) option verilmediyse
 * uygulanır.
 */
export interface GoIndexOptions {
  readonly goBinaryPath?: string;
  readonly goWorkerBinaryPath?: string;
  readonly workerDir?: string;
  readonly requestTimeoutMs?: number;
}

/** Rust adapter ayarları (M2); workerDir env override (CAUSORYN_RUST_WORKER_DIR) adapter default'u. */
export interface RustIndexOptions {
  readonly workerDir?: string;
  readonly cargoHomeDir?: string;
  readonly requestTimeoutMs?: number;
  readonly cargoBuildTimeoutMs?: number;
}

export interface IndexServiceOptions {
  readonly workspaceId: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  /** ISO-8601 üretir; domain saat okumaz. */
  readonly clock: () => string;
  readonly limits: IndexLimits;
  /** C# (roslyn worker) adapter ayarları; tanımsızsa defaults. */
  readonly csharp?: CsharpIndexOptions;
  /** Python (stdlib ast sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly python?: PythonIndexOptions;
  /** Go (go/parser sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly go?: GoIndexOptions;
  /** Rust (syn sidecar) adapter ayarları; tanımsızsa defaults (M2). */
  readonly rust?: RustIndexOptions;
  /**
   * K-021: Aynı SQLite veri kökünü paylaşan çoklu süreç yarışlarında
   * (graph/build-already-active ve graph/publish-failed) kaybeden build'i
   * failBuild ile temizleyip yayımlanmış mevcut snapshot'a zarifçe düşer.
   * Varsayılan false.
   */
  readonly tolerateConcurrentPublishRace?: boolean;
}

/** Adapter tanı kaydının uygulama düzeyi karşılığı (parser detayı sızmaz). */
export interface IndexDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  readonly line: number;
}

/** Tek indeksleme koşusunun sonucu. */
export interface IndexRunResult {
  readonly snapshotId: string;
  readonly snapshot: SnapshotGraph;
  readonly stale: boolean;
  /** Envanterdeki toplam dosya sayısı (uzantıdan bağımsız). */
  readonly fileCount: number;
  /** Adapter'a verilen TS/TSX dosya sayısı. */
  readonly tsFileCount: number;
  /** Adapter'a verilen .cs dosya sayısı (B9). */
  readonly csFileCount: number;
  readonly state: PublishableState;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly IndexDiagnostic[];
  /**
   * true: yeni snapshot yayımlandı. false: incremental no-op — değişiklik
   * dil analizleri için anlamlı değildi; graph korunup mevcut snapshot
   * yeniden kullanıldı (yalnızca files tablosu tazelendi).
   */
  readonly published: boolean;
}

/** Adapter çıktısının pipeline graph inşasına verilen ortak biçimi. */
interface AdapterOutput {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly state: "ready" | "partial";
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  /** Üst düzey kanıt listesi (yalnızca roslyn worker taşır — PROTOCOL.md v1). */
  readonly evidence: readonly SnapshotEvidenceInput[];
}

/** Adapter node girdisini graph kongresine uygun GraphNode'a çevirir. */
function toGraphNode(
  workspaceId: string,
  input: {
    readonly kind: NodeKind;
    readonly qualifiedName: string;
    readonly relativePath?: string;
    readonly language?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  },
  contentHashByPath: ReadonlyMap<string, string>,
): GraphNode {
  const relativePath = input.relativePath;
  const location: SourceSpan | undefined =
    relativePath === undefined
      ? undefined
      : {
          relativePath,
          startLine: 1,
          endLine: 1,
          // Envanter karması: node'un geldiği dosyanın bütünlük kanıtı.
          // Envanter dışı bir path bu aşamada sözleşme ihlalidir.
          sourceHash: contentHashByPath.get(relativePath) ?? "",
        };
  if (location !== undefined && location.sourceHash.length === 0) {
    throw new IndexingError(
      "indexing/internal",
      `adapter node'u envanterde olmayan dosyaya işaret ediyor: ${relativePath ?? "?"}`,
    );
  }
  return {
    id: nodeId({
      workspaceId,
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(relativePath === undefined ? {} : { relativePath }),
    }),
    kind: input.kind,
    qualifiedName: input.qualifiedName,
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(location === undefined ? {} : { location }),
    attributes: {
      ...(input.attributes ?? {}),
      // Provenance kongresi: sembol node'unun geldiği dosya (arama/ambiguity
      // adaylarında relativePath raporlamak için).
      ...(relativePath === undefined ? {} : { relativePath }),
    },
  };
}

/** Domain NodeRef kimlik anahtarı (snapshot.ts ile aynı formül). */
function nodeRefKey(ref: NodeRef): string {
  return canonicalJson([ref.kind, ref.qualifiedName, ref.relativePath ?? null]);
}

function isSymbolSearchStore(
  repository: GraphRepository,
): repository is GraphRepository & SymbolSearchStore {
  return (
    "indexSymbols" in repository &&
    typeof (repository as { indexSymbols?: unknown }).indexSymbols === "function"
  );
}

function toEvidence(workspaceId: string, input: {
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}): Evidence {
  const id = evidenceId({
    workspaceId,
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: input.span }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  });
  return {
    id,
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: input.span }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  };
}

/** Roslyn tanısını uygulama düzeyi kayda çevirir (alanlar birebir). */
function toDiagnostic(diagnostic: RoslynAdapterDiagnostic): IndexDiagnostic {
  return {
    relativePath: diagnostic.relativePath,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
  };
}

/**
 * M2: senkron köprü L0 File node'larının analyzer provenance'ı — dilin
 * kayıtlı sidecar adapter kimliği (INDEXED_ADAPTERS ile aynı sabitler).
 */
function l0LanguageAnalyzerId(language: string): string {
  switch (language) {
    case "python":
      return PYTHON_WORKER_ADAPTER_ID;
    case "go":
      return GO_ADAPTER_ID;
    case "rust":
      return RUST_ADAPTER_ID;
    default:
      return "causoryn-indexing";
  }
}

/** M2: L0 provenance sürümü — dil adapter sürüm sabiti. */
function l0LanguageAnalyzerVersion(language: string): string {
  switch (language) {
    case "python":
      return PYTHON_WORKER_ADAPTER_VERSION;
    case "go":
      return GO_ADAPTER_VERSION;
    case "rust":
      return RUST_ADAPTER_VERSION;
    default:
      return INDEXING_VERSION;
  }
}

/** prepareRun çıktısı (pipeline girdisi; M2 ile beş dil kümesi taşır). */
interface PreparedRun {
  readonly canonicalRoot: string;
  readonly entries: InventoryEntry[];
  readonly tsEntries: InventoryEntry[];
  readonly csEntries: InventoryEntry[];
  readonly pyEntries: InventoryEntry[];
  readonly goEntries: InventoryEntry[];
  readonly rsEntries: InventoryEntry[];
}

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const CS_EXTENSIONS = new Set([".cs"]);
/** M2: sidecar worker dil uzantıları (python/go/rust). */
const PY_EXTENSIONS = new Set([".py"]);
const GO_EXTENSIONS = new Set([".go"]);
const RS_EXTENSIONS = new Set([".rs"]);

/**
 * Dinamik sidecar asset kökü çözümleyicisi:
 * 1) CAUSORYN_ASSET_ROOT ortam değişkeni doluysa mutlak yolunu döner,
 * 2) import.meta.url dizininden yukarı 0..4 ata dizinde native/python-worker/worker.py
 *    arar (monorepo derinlik-3 ve paketlenmiş bundle derinlik-1 düzenleri),
 * 3) bulunamazsa 3-seviye üst ata dizine geri düşer.
 */
function resolveIndexingAssetRoot(): string {
  const envAssetRoot = process.env["CAUSORYN_ASSET_ROOT"]?.trim();
  if (envAssetRoot !== undefined && envAssetRoot.length > 0) {
    return path.resolve(envAssetRoot);
  }
  const startDir = dirname(fileURLToPath(import.meta.url));
  let current = startDir;
  for (let depth = 0; depth <= 4; depth += 1) {
    if (existsSync(join(current, "native", "python-worker", "worker.py"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirname(dirname(dirname(startDir)));
}

export class IndexService {
  private readonly workspaceId: string;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly repository: GraphRepository;
  private readonly clock: () => string;
  private readonly limits: IndexLimits;
  private readonly configHash: string;
  /** C# adapter'a geçilen etkin ayarlar (opts fingerprint hash'i). */
  private readonly csharpSettings: RoslynAdapterSettings;
  /** Python adapter'a geçilen etkin ayarlar (pyopts fingerprint hash'i; M2). */
  private readonly pythonSettings: PythonIndexSettings;
  /** Go adapter'a geçilen etkin ayarlar (goopts fingerprint hash'i; M2). */
  private readonly goSettings: GoIndexSettings;
  /** Rust adapter'a geçilen etkin ayarlar (rustopts fingerprint hash'i; M2). */
  private readonly rustSettings: RustIndexSettings;
  /** Rust workerDir yalnızca açıkça override edildiğinde adapter'a iletilir. */
  private readonly hasExplicitRustWorkerDir: boolean;
  /** C# analiz seam'i: prod analyzeCSharpWorkspace; testler stub enjekte eder. */
  private readonly analyzeCSharpFn: AnalyzeCSharpFunction;
  /** K-021: çoklu-süreç SQLite yarış kurtarma modu. */
  private readonly tolerateConcurrentPublishRace: boolean;
  private workspaceRegistered = false;
  private runCount = 0;

  constructor(options: IndexServiceOptions) {
    this.workspaceId = options.workspaceId;
    this.policy = options.policy;
    this.repository = options.repository;
    this.clock = options.clock;
    this.limits = options.limits;
    this.tolerateConcurrentPublishRace = options.tolerateConcurrentPublishRace ?? false;
    const policyConfig = options.policy.config;
    const hashInput: JsonValue = {
      workspaceId: this.workspaceId,
      maxFiles: options.limits.maxFiles,
      allowRoots: [...policyConfig.allowRoots],
      ignore: [...policyConfig.ignore],
      extraIgnore: [...policyConfig.extraIgnore],
      binaryExtensions: [...policyConfig.binaryExtensions],
      extensionFilterMode: policyConfig.extensionFilterMode,
      allowedExtensions: [...policyConfig.allowedExtensions],
      maxFileBytes: policyConfig.maxFileBytes,
    };
    this.configHash = sha256Hex(utf8Encode(canonicalJson(hashInput)));
    const assetRoot = resolveIndexingAssetRoot();
    // Etkin C# ayarları: açık option > ortam değişkeni (worker DLL yolu) >
    // düz paketlenmiş DLL > B1 build çıktısı varsayılanı. Ortam değişkeni
    // kuralı adapter ile aynıdır (CAUSORYN_ROSLYN_WORKER_DLL) — fingerprint
    // gerçekten kullanılan DLL yolunu yansıtır.
    const envWorkerDll = process.env["CAUSORYN_ROSLYN_WORKER_DLL"];
    let defaultWorkerDll: string;
    if (envWorkerDll !== undefined && envWorkerDll.trim().length > 0) {
      defaultWorkerDll = envWorkerDll;
    } else {
      const flatWorkerDll = join(
        assetRoot,
        "native",
        "roslyn-worker",
        "Causoryn.RoslynWorker.dll",
      );
      defaultWorkerDll = existsSync(flatWorkerDll)
        ? flatWorkerDll
        : join(assetRoot, WORKER_DLL_RELATIVE_PATH);
    }
    const csharpOptions = options.csharp ?? {};
    this.csharpSettings = {
      dotnetCommand: csharpOptions.dotnetCommand ?? DEFAULT_DOTNET_COMMAND,
      requestTimeoutMs: csharpOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      workerDllPath: csharpOptions.workerDllPath ?? defaultWorkerDll,
    };
    // Yalnızca test enjeksiyonu; opts fingerprint hash'ine girmez.
    this.analyzeCSharpFn = csharpOptions.analyzeCSharp ?? analyzeCSharpWorkspace;
    // M2: Python/Go/Rust etkin ayarları — açık option > ortam değişkeni
    // (adapter override kuralıyla aynı) > adapter varsayılanı. Ortam
    // değişkeni adları adapter'ların default çözümlemesiyle birebir:
    // CAUSORYN_PYTHON_WORKER_SCRIPT, CAUSORYN_GO_WORKER_BIN,
    // CAUSORYN_GO_WORKER_DIR, CAUSORYN_RUST_WORKER_DIR (rust default'u
    // adapter'ın defaultWorkerDir'iyle çözülür). Fingerprint, GERÇEKTEN
    // kullanılan yolları taşır.
    const pythonOptions = options.python ?? {};
    const envPythonScript = process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"];
    this.pythonSettings = {
      pythonCommand: pythonOptions.pythonCommand ?? DEFAULT_PYTHON_COMMAND,
      requestTimeoutMs: pythonOptions.requestTimeoutMs ?? DEFAULT_PY_REQUEST_TIMEOUT_MS,
      workerScriptPath:
        pythonOptions.workerScriptPath ??
        (envPythonScript !== undefined && envPythonScript.trim().length > 0
          ? envPythonScript
          : join(assetRoot, WORKER_SCRIPT_RELATIVE_PATH)),
      responseMaxChars: DEFAULT_PY_RESPONSE_MAX_CHARS,
    };
    const goOptions = options.go ?? {};
    const envGoWorkerBin = process.env["CAUSORYN_GO_WORKER_BIN"];
    const envGoWorkerDir = process.env["CAUSORYN_GO_WORKER_DIR"];
    this.goSettings = {
      goBinaryPath: goOptions.goBinaryPath ?? DEFAULT_GO_BINARY_PATH,
      goWorkerBinaryPath:
        goOptions.goWorkerBinaryPath ??
        (envGoWorkerBin !== undefined && envGoWorkerBin.trim().length > 0 ? envGoWorkerBin : ""),
      workerDir:
        goOptions.workerDir ??
        (envGoWorkerDir !== undefined && envGoWorkerDir.trim().length > 0
          ? envGoWorkerDir
          : join(assetRoot, GO_WORKER_DIR_RELATIVE_PATH)),
      requestTimeoutMs: goOptions.requestTimeoutMs ?? DEFAULT_GO_REQUEST_TIMEOUT_MS,
    };
    const rustOptions = options.rust ?? {};
    this.hasExplicitRustWorkerDir =
      rustOptions.workerDir !== undefined ||
      Boolean(process.env["CAUSORYN_RUST_WORKER_DIR"]?.trim());
    this.rustSettings = {
      workerDir: rustOptions.workerDir ?? defaultWorkerDir(),
      workerBinaryName: WORKER_BINARY_NAME,
      cargoHomeDir: rustOptions.cargoHomeDir ?? "",
      requestTimeoutMs: rustOptions.requestTimeoutMs ?? DEFAULT_RS_REQUEST_TIMEOUT_MS,
      responseMaxChars: DEFAULT_RS_RESPONSE_MAX_CHARS,
      cargoBuildTimeoutMs: rustOptions.cargoBuildTimeoutMs ?? DEFAULT_CARGO_BUILD_TIMEOUT_MS,
    };
    this.runCount = this.readInitialRunCount();
  }

  /**
   * Depoda yayımlanmış bir snapshot varsa revision.sequence değerini okur;
   * kalıcı SQLite yeniden açılışlarında sequence sıfırlanmasını ve UNIQUE(id)
   * çakışmasını önler. Kayıtlı olmayan workspace'lerde güvenli biçimde 0 döner.
   */
  private readInitialRunCount(): number {
    if (this.workspaceId.trim().length === 0) return 0;
    try {
      const existing = this.repository.getLatestPublished(this.workspaceId);
      return existing?.snapshot.meta.revision.sequence ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Depo SymbolSearchStore destekliyorsa yayımlanan snapshot'ın sembol
   * düğümlerini (Workspace/File/UnknownExternal hariç) symbol_fts tablosuna
   * yazar (Agent GPS FTS5 ayağı, TŞ §9/§15).
   */
  private indexPublishedSymbols(snapshot: SnapshotGraph): void {
    if (!isSymbolSearchStore(this.repository)) return;
    const symbolEntries: SymbolIndexEntry[] = [];
    for (const node of snapshot.nodes) {
      if (
        node.kind !== "Workspace" &&
        node.kind !== "File" &&
        node.kind !== "UnknownExternal"
      ) {
        symbolEntries.push({ symbol: node.qualifiedName, nodeId: node.id });
      }
    }
    if (symbolEntries.length > 0) {
      this.repository.indexSymbols(snapshot.meta.id, symbolEntries);
    }
  }

  /**
   * Kökü yetkilendirir, envanteri çıkarır, TS kaynaklarını adapter'dan
   * geçirir ve snapshot'ı atomik yayımlar. Yetkisiz kök / limit aşımı
   * IndexingError ile reddedilir; hiçbir kısmi yayın yapılmaz.
   *
   * SENKRON köprü: .cs dosyaları varsa C# derin analiz YÜRÜTÜLMEZ (Roslyn
   * worker async koşar; senkron imza onu bekleyemez ve bu yol worker'ı
   * hiç başlatmaz) — C# L0 envanter düzeyinde temsil edilir ve durum
   * partial + explicit warning ile raporlanır. Tam birleşik analiz için
   * `runIndexAsync` / refresh işi kullanılmalıdır.
   */
  runIndex(rootPath: string): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    return this.runPipeline(prepared);
  }

  /**
   * TAM pipeline (B9): kökü yetkilendirir, envanteri çıkarır, TS ve .cs
   * kaynaklarını sırayla kendi adapter'larından geçirir ve iki dilin
   * çıktısını TEK snapshot'a katıp atomik yayımlar. Worker kullanılamıyorsa
   * adapter L0/L1'e düşer (partial + warning) — motor çökmez.
   */
  async runIndexAsync(rootPath: string): Promise<IndexRunResult> {
    const prepared = this.prepareRun(rootPath);
    return this.runPipelineAsync(prepared);
  }

  /**
   * SENKRON incremental yeniden indeksleme (TŞ v2.1 §9; sprint-2 B7).
   *
   * Karar yetkilisi DEĞİŞİKLİK KARMASIDIR (TŞ §9 "fingerprint" adımı):
   * envanter tam taranır, files tablosunun önceki karmalarıyla
   * karşılaştırılır. Dil kapsamındaki kaynaklarda (TS + C#) anlamlı
   * değişim yoksa graph KORUNUR, mevcut snapshot yeniden kullanılır ve
   * yalnızca files tablosu tazelenir (published=false). B9 notu: senkron
   * graph C#'ı L0 File node'larıyla (sourceHash attribute'lu) temsil
   * ettiği için .cs karma değişimi de yeniden yayın tetikler — aksi halde
   * L0 node'ların bütünlük kanıtı bayat kalırdı.
   */
  runIncrementalIndex(rootPath: string, changeSet: readonly string[] = []): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    const change = this.analyzeChanges(prepared.entries);
    const latest = this.repository.getLatestPublished(this.workspaceId);
    if (
      !change &&
      latest !== undefined &&
      (latest.snapshot.meta.state === "ready" || latest.snapshot.meta.state === "partial")
    ) {
      return this.noOpResult(
        prepared.entries,
        prepared.tsEntries.length,
        prepared.csEntries.length,
        latest,
        changeSet,
      );
    }
    return this.runPipeline(prepared);
  }

  /**
   * TAM incremental pipeline (B9 + M2): dil karma karşılaştırması (TS, C#,
   * python, go, rust); hiçbir dilde anlamlı değişim yoksa mevcut snapshot
   * korunur (published=false), varsa tüm dillerin tam analiziyle YENİ
   * snapshot türetilir ve atomik yayımlanır.
   */
  async runIncrementalIndexAsync(
    rootPath: string,
    changeSet: readonly string[] = [],
  ): Promise<IndexRunResult> {
    const prepared = this.prepareRun(rootPath);
    const change = this.analyzeChanges(prepared.entries);
    const latest = this.repository.getLatestPublished(this.workspaceId);
    const degradedSyncSnapshot =
      latest !== undefined &&
      latest.snapshot.meta.analyzerFingerprint.includes("sync-run-degraded");
    if (
      !change &&
      !degradedSyncSnapshot &&
      latest !== undefined &&
      (latest.snapshot.meta.state === "ready" || latest.snapshot.meta.state === "partial")
    ) {
      return this.noOpResult(
        prepared.entries,
        prepared.tsEntries.length,
        prepared.csEntries.length,
        latest,
        changeSet,
      );
    }
    return this.runPipelineAsync(prepared);
  }

  /**
   * Karma tabanlı değişim analizi (senkron + async ortak karar girdisi):
   * önceki files tablosu karmalarıyla güncel envanter karşılaştırılır.
   * Dil kümeleri (TS, C# ve M2 ile python/go/rust) birlikte değerlendirilir
   * (hepsi graph'a katkı verir); dil-dışı dosyalar kararı etkilemez (bkz.
   * noOpResult).
   */
  private analyzeChanges(entries: readonly InventoryEntry[]): boolean {
    const previousHashes = new Map(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => [record.relativePath, record.contentHash]),
    );
    const languageEntries = entries.filter((entry) =>
      this.isLanguageSource(path.extname(entry.relativePath).toLowerCase()),
    );
    const changedSources = languageEntries.filter(
      (entry) => previousHashes.get(entry.relativePath) !== entry.contentHash,
    );
    const deletedSources = [...previousHashes.keys()].filter(
      (relativePath) =>
        this.isLanguageSource(path.extname(relativePath).toLowerCase()) &&
        !languageEntries.some((entry) => entry.relativePath === relativePath),
    );
    return changedSources.length > 0 || deletedSources.length > 0;
  }

  /** Uzantının dil pipeline kapsamında olup olmadığı (senkron + async ortak). */
  private isLanguageSource(extension: string): boolean {
    return (
      TS_EXTENSIONS.has(extension) ||
      CS_EXTENSIONS.has(extension) ||
      PY_EXTENSIONS.has(extension) ||
      GO_EXTENSIONS.has(extension) ||
      RS_EXTENSIONS.has(extension)
    );
  }

  /**
   * No-op koşumu (senkron + async ortak): graph korunur, files tablosu
   * tazelenir, published=false. Güvenlik bulgusu 3 mutabakatı burada da
   * uygulanır: envanterde karşılığı olmayan kayıtlar düşürülür.
   */
  private noOpResult(
    entries: readonly InventoryEntry[],
    tsFileCount: number,
    csFileCount: number,
    latest: NonNullable<ReturnType<GraphRepository["getLatestPublished"]>>,
    changeSet: readonly string[],
  ): IndexRunResult {
    // Güvenlik bulgusu 3: mutabakat upsert'lerden ÖNCE okunur.
    const previousFilePaths = new Set(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => record.relativePath),
    );
    const currentPaths = new Set(entries.map((entry) => entry.relativePath));
    const updatedAt = this.clock();
    for (const entry of entries) {
      this.repository.upsertFile({
        workspaceId: this.workspaceId,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
        sizeBytes: entry.sizeBytes,
        updatedAt,
      });
    }
    for (const previousPath of previousFilePaths) {
      if (!currentPaths.has(previousPath)) {
        this.repository.deleteFile(this.workspaceId, previousPath);
      }
    }
    return {
      snapshotId: latest.snapshot.meta.id,
      snapshot: latest.snapshot,
      stale: latest.stale,
      fileCount: entries.length,
      tsFileCount,
      csFileCount,
      // Bu dala girmenin ön koşulu meta.state ready|partial'dır; derin
      // özellik zinciri TS daraltmasını taşımadığı için açık daraltma.
      state: latest.snapshot.meta.state === "ready" ? "ready" : "partial",
      warnings: [
        "incremental no-op: dil analizleri için anlamlı değişiklik yok; mevcut snapshot korundu, files tablosu tazelendi",
        `değişiklik kümesi: ${changeSet.length === 0 ? "(boş)" : changeSet.join(", ")}`,
      ],
      diagnostics: [],
      published: false,
    };
  }

  /** Ortak hazırlık: yetki + workspace kaydı + tam envanter (Discover). */
  private prepareRun(rootPath: string): PreparedRun {
    const rootDecision = this.policy.authorizeRoot(rootPath);
    if (!rootDecision.allowed) {
      throw new IndexingError(
        "indexing/root-not-authorized",
        `kök yetkilendirilmedi (${rootDecision.code}): ${rootDecision.reason}`,
      );
    }
    const canonicalRoot = rootDecision.canonicalRoot;
    this.ensureWorkspaceRegistered();
    const entries = collectInventory(this.policy, canonicalRoot, this.limits.maxFiles);
    const tsEntries = entries.filter((entry) =>
      TS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const csEntries = entries.filter((entry) =>
      CS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const pyEntries = entries.filter((entry) =>
      PY_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const goEntries = entries.filter((entry) =>
      GO_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const rsEntries = entries.filter((entry) =>
      RS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    return { canonicalRoot, entries, tsEntries, csEntries, pyEntries, goEntries, rsEntries };
  }

  /**
   * Envanter kayıtlarını files tablosuna yansıtır (TŞ §9 files tablosu =
   * güncel envanter karşılığı); silme mutabakatı güvenlik bulgusu 3.
   */
  private syncInventoryRecords(entries: readonly InventoryEntry[]): void {
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );
    // upsert'lerden ÖNCE okunur (mutabakat temeli).
    const previousFilePaths = new Set(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => record.relativePath),
    );
    const updatedAt = this.clock();
    for (const entry of entries) {
      this.repository.upsertFile({
        workspaceId: this.workspaceId,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
        sizeBytes: entry.sizeBytes,
        updatedAt,
      });
    }
    for (const previousPath of previousFilePaths) {
      if (!contentHashByPath.has(previousPath)) {
        this.repository.deleteFile(this.workspaceId, previousPath);
      }
    }
  }

  /** Build açar + Workspace node'unu ekler (her koşumun ortak başlangıcı). */
  private openBuild(
    analyzerFingerprint: string,
    createdAt: string,
    canonicalRoot: string,
  ): {
    readonly buildId: string;
    readonly workspaceNode: GraphNode;
    readonly build: ReturnType<GraphRepository["beginBuild"]>;
  } {
    const revision = { id: "working-tree", sequence: this.runCount + 1 };
    const build = this.repository.beginBuild({
      workspaceId: this.workspaceId,
      revision,
      configHash: this.configHash,
      analyzerFingerprint,
      createdAt,
    });
    const workspaceNode: GraphNode = {
      id: nodeId({
        workspaceId: this.workspaceId,
        kind: "Workspace",
        qualifiedName: this.workspaceId,
      }),
      kind: "Workspace",
      qualifiedName: this.workspaceId,
      attributes: { rootPath: canonicalRoot },
    };
    this.repository.addNode(build.buildId, workspaceNode);
    return { buildId: build.buildId, workspaceNode, build };
  }

  /**
   * Eşzamanlı build/publish yarışında yayımlanmış snapshot üzerinden zarif
   * sonuç üretir ve yerel sequence sayacını ileri hizalar.
   */
  private concurrentReuseResult(
    latest: NonNullable<ReturnType<GraphRepository["getLatestPublished"]>>,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: readonly string[],
    diagnostics: readonly IndexDiagnostic[],
    raceWarning: string,
  ): IndexRunResult {
    this.runCount = Math.max(this.runCount, latest.snapshot.meta.revision.sequence);
    return {
      snapshotId: latest.snapshot.meta.id,
      snapshot: latest.snapshot,
      stale: latest.stale,
      fileCount,
      tsFileCount,
      csFileCount,
      state: latest.snapshot.meta.state === "ready" ? "ready" : "partial",
      warnings: [...warnings, raceWarning],
      diagnostics,
      published: false,
    };
  }

  /**
   * Çoklu-süreç SQLite yarış modunda build açmadan hemen önce yayımlanmış
   * en güncel snapshot'ı kontrol eder:
   * - Birebir aynı dosya/karma + analyzerFingerprint + configHash kopyasıysa
   *   `runCount = latest.sequence - 1` ile UNIQUE(id) tekilleştirmesini korur,
   * - Aksi hâlde (başka süreç ilerledikten sonra dosyalar/ayarlar değiştiyse)
   *   `runCount = latest.sequence` ile yayını `N + 1` olarak monotonik ilerletir.
   */
  private syncRunCountBeforeBuild(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
  ): void {
    if (!this.tolerateConcurrentPublishRace) return;
    const latest = this.repository.getLatestPublished(this.workspaceId);
    if (latest === undefined || latest.snapshot.meta.revision.sequence <= this.runCount) {
      return;
    }
    if (this.matchesPublishedSnapshotInputs(entries, analyzerFingerprint, latest.snapshot)) {
      this.runCount = latest.snapshot.meta.revision.sequence - 1;
    } else {
      this.runCount = latest.snapshot.meta.revision.sequence;
    }
  }

  private matchesPublishedSnapshotInputs(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
    snapshot: SnapshotGraph,
  ): boolean {
    if (snapshot.meta.configHash !== this.configHash) return false;
    if (snapshot.meta.analyzerFingerprint !== analyzerFingerprint) return false;

    const repoFiles = this.repository.listFiles(this.workspaceId);
    if (repoFiles.length !== entries.length) return false;
    const repoHashByPath = new Map(
      repoFiles.map((record) => [record.relativePath, record.contentHash]),
    );
    const entryHashByPath = new Map<string, string>();
    let languageEntryCount = 0;
    for (const entry of entries) {
      if (repoHashByPath.get(entry.relativePath) !== entry.contentHash) {
        return false;
      }
      entryHashByPath.set(entry.relativePath, entry.contentHash);
      if (this.isLanguageSource(path.extname(entry.relativePath).toLowerCase())) {
        languageEntryCount += 1;
      }
    }

    let snapshotFileNodeCount = 0;
    for (const node of snapshot.nodes) {
      if (node.kind !== "File") continue;
      snapshotFileNodeCount += 1;
      if (
        node.location === undefined ||
        entryHashByPath.get(node.location.relativePath) !== node.location.sourceHash
      ) {
        return false;
      }
    }
    return snapshotFileNodeCount === languageEntryCount;
  }

  /**
   * Build açar; tolerateConcurrentPublishRace aktifken graph/build-already-active
   * yarışında mevcut yayımlanmış snapshot varsa ona zarifçe düşer.
   */
  private openBuildOrRecover(
    entries: readonly InventoryEntry[],
    analyzerFingerprint: string,
    createdAt: string,
    canonicalRoot: string,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: readonly string[],
    diagnostics: readonly IndexDiagnostic[],
  ):
    | { readonly kind: "opened"; readonly opened: ReturnType<IndexService["openBuild"]> }
    | { readonly kind: "reused"; readonly result: IndexRunResult } {
    this.syncRunCountBeforeBuild(entries, analyzerFingerprint);
    try {
      return {
        kind: "opened",
        opened: this.openBuild(analyzerFingerprint, createdAt, canonicalRoot),
      };
    } catch (error) {
      if (
        this.tolerateConcurrentPublishRace &&
        error instanceof GraphRepositoryError &&
        (error.code === "graph/build-already-active" ||
          (error.code === "storage/driver-error" &&
            error.message.includes("snapshots.workspace_id")))
      ) {
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          return {
            kind: "reused",
            result: this.concurrentReuseResult(
              latest,
              fileCount,
              tsFileCount,
              csFileCount,
              warnings,
              diagnostics,
              "concurrent index build race (graph/build-already-active): reused existing published snapshot",
            ),
          };
        }
      }
      throw error;
    }
  }

  /**
   * Build'i yayımlar; tolerateConcurrentPublishRace aktifken graph/publish-failed
   * yarışında önce kaybeden build satırını failBuild ile temizler, ardından
   * mevcut yayımlanmış snapshot varsa onu döner (yoksa normal hata yolu).
   */
  private finalizePublish(
    buildId: string,
    state: PublishableState,
    fileCount: number,
    tsFileCount: number,
    csFileCount: number,
    warnings: string[],
    diagnostics: IndexDiagnostic[],
  ): IndexRunResult {
    const publishedAt = this.clock();
    let snapshot: SnapshotGraph;
    try {
      snapshot = this.repository.publish(buildId, state, publishedAt);
    } catch (error) {
      if (
        this.tolerateConcurrentPublishRace &&
        error instanceof GraphRepositoryError &&
        error.code === "graph/publish-failed"
      ) {
        try {
          this.repository.failBuild(buildId, "concurrent snapshot publish race");
        } catch {
          // Build satırı zaten aktif değilse yutulur.
        }
        const latest = this.repository.getLatestPublished(this.workspaceId);
        if (latest !== undefined) {
          return this.concurrentReuseResult(
            latest,
            fileCount,
            tsFileCount,
            csFileCount,
            warnings,
            diagnostics,
            "concurrent snapshot publish race (graph/publish-failed): reused existing published snapshot",
          );
        }
        throw new IndexingError("indexing/internal", `graph deposu reddetti: ${error.message}`);
      }
      this.failBuild(buildId, error);
    }
    try {
      this.indexPublishedSymbols(snapshot);
    } catch (error) {
      if (error instanceof GraphRepositoryError) {
        throw new IndexingError("indexing/internal", `graph deposu reddetti: ${error.message}`);
      }
      throw error;
    }
    this.runCount += 1;
    const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
    return {
      snapshotId: snapshot.meta.id,
      snapshot,
      stale,
      fileCount,
      tsFileCount,
      csFileCount,
      state,
      warnings,
      diagnostics,
      published: true,
    };
  }

  /**
   * SENKRON pipeline (runIndex/runIncrementalIndex gövdesi). C# derin
   * analizi YOKTUR: worker async koşar, senkron imza onu bekleyemez ve bu
   * yol worker'ı hiç başlatmaz — C# L0 File node'ları envanterden türetilir
   * (adapter L0/L1 fallback node şemasıyla birebir: kind File, language
   * csharp, attributes.sourceHash) ve durum partial'a zorlanır.
   *
   * M2: python/go/rust dosyaları için aynı köprü sözleşmesi geçerlidir —
   * sidecar worker'lar async koşar; senkron yol onları SPAWN ETMEZ, L0
   * envanter düzeyinde temsil eder ve bunu explicit warning + partial
   * fingerprint etiketiyle (pystate/gostate/ruststate=sync-run-degraded)
   * raporlar.
   *
   * Girdi aynıysa çıktı graph JSON'ı birebir aynıdır (TŞ §8 invariant vi);
   * mod bilgisi graph meta'sına girmez.
   */
  private runPipeline(prepared: PreparedRun): IndexRunResult {
    const { canonicalRoot, entries, tsEntries, csEntries, pyEntries, goEntries, rsEntries } =
      prepared;
    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );

    const createdAt = this.clock();
    const fingerprint = buildAnalyzerFingerprint({
      typescript:
        tsEntries.length > 0
          ? { analyzerId: TS_ADAPTER_ANALYZER_ID, version: TS_ADAPTER_VERSION }
          : null,
      csharp:
        csEntries.length > 0
          ? {
              analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
              version: CSHARP_ROSLYN_ADAPTER_VERSION,
              discovery: "sync-run-degraded",
              refPacks: null,
              settings: this.csharpSettings,
            }
          : null,
      python:
        pyEntries.length > 0
          ? {
              analyzerId: PYTHON_WORKER_ADAPTER_ID,
              version: PYTHON_WORKER_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.pythonSettings,
            }
          : null,
      go:
        goEntries.length > 0
          ? {
              analyzerId: GO_ADAPTER_ID,
              version: GO_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.goSettings,
            }
          : null,
      rust:
        rsEntries.length > 0
          ? {
              analyzerId: RUST_ADAPTER_ID,
              version: RUST_ADAPTER_VERSION,
              status: "sync-run-degraded",
              settings: this.rustSettings,
            }
          : null,
    });
    const buildAttempt = this.openBuildOrRecover(
      entries,
      fingerprint,
      createdAt,
      canonicalRoot,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const opened = buildAttempt.opened;

    let finalState: PublishableState = "partial";
    let emptyLanguageRun = false;
    try {
      // Erken çıkış: analiz edilebilir dil kaynağı yok (orijinal davranış,
      // genelleştirilmiş uyarı; tek Workspace node'uyla partial publish).
      // M2 denetim bulgusu düzeltmesi: kapsam beş dile genişlediğinden
      // uyarı metni de beş dili sayar (yalnızca hiçbir dil dosyası yokken
      // bu dala girilir).
      if (
        tsEntries.length === 0 &&
        csEntries.length === 0 &&
        pyEntries.length === 0 &&
        goEntries.length === 0 &&
        rsEntries.length === 0
      ) {
        // Envanter mutabakatı: bu dalda adapter koşumu YOK, sıralama
        // tehlikesi yok — build'e girmeden mutabakat yapılır (async yol
        // sözleşmesiyle aynı mutabakat garantisi).
        this.syncInventoryRecords(entries);
        warnings.push(
          "workspace analiz edilebilir TypeScript/TSX/C#/Python/Go/Rust kaynağı içermiyor; coverage sıfır (partial yayınlendi)",
        );
        for (const entry of entries) {
          warnings.push(`dosya envanterde ama dil adapter kapsamı dışında: ${entry.relativePath}`);
        }
        emptyLanguageRun = true;
      } else {

      const nodeByKey = new Map<string, GraphNode>();
      let tsState: "ready" | "partial" = "ready";
      if (tsEntries.length > 0) {
        // TS adapter (salt-okunur kaynak çantası; rootDir çözümleme
        // çapasıdır, adapter diske YAZMAZ — ADR-008).
        const adapterResult = analyzeTypeScriptProgram({
          workspaceId: this.workspaceId,
          rootDir: canonicalRoot,
          sources: tsEntries.map((entry) => ({
            relativePath: entry.relativePath,
            content: entry.content,
          })),
        });
        tsState = adapterResult.state;
        for (const diagnostic of adapterResult.diagnostics) {
          const converted: IndexDiagnostic = {
            relativePath: diagnostic.relativePath,
            code: diagnostic.code,
            message: diagnostic.message,
            line: diagnostic.line,
          };
          diagnostics.push(converted);
          warnings.push(
            `tanı: ${converted.relativePath}:${String(converted.line)} ${converted.code} ${converted.message}`,
          );
        }
        warnings.push(...adapterResult.warnings);
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: TS_ADAPTER_ANALYZER_ID,
            analyzerVersion: TS_ADAPTER_VERSION,
            state: tsState,
            nodes: adapterResult.nodes,
            edges: adapterResult.edges,
            evidence: [],
          },
          contentHashByPath,
          nodeByKey,
        );
      }

      let csState: "ready" | "partial" = "ready";
      if (csEntries.length > 0) {
        // Senkron köprü: derin analiz yok — L0 envanter düzeyi + explicit
        // warning. worker başlatılmaz; uydurma sembol/kenar üretilmez.
        warnings.push(
          `senkron koşum C# derin sembol analizini yürütemez (Roslyn worker async koşar): ${String(csEntries.length)} dosya L0 envanter düzeyinde listelendi; tam birleşik analiz için runIndexAsync/refresh işi kullanın`,
        );
        const l0Nodes: SnapshotNodeInput[] = csEntries.map((entry) => ({
          kind: "File",
          qualifiedName: entry.relativePath,
          language: "csharp",
          relativePath: entry.relativePath,
          attributes: { sourceHash: entry.contentHash },
        }));
        csState = "partial";
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
            analyzerVersion: CSHARP_ROSLYN_ADAPTER_VERSION,
            state: csState,
            nodes: l0Nodes,
            edges: [],
            evidence: [],
          },
          contentHashByPath,
          nodeByKey,
        );
      }

      // M2: python/go/rust senkron köprü — worker SPAWN EDİLMEZ; L0
      // envanter düzeyi File node'ları (sourceHash attribute'lu) + explicit
      // warning. csharp köprü sözleşmesinin birebir karşılığı.
      const syncL0Languages: ReadonlyArray<{
        readonly label: string;
        readonly language: string;
        readonly workerName: string;
        readonly entries: InventoryEntry[];
      }> = [
        { label: "Python", language: "python", workerName: "python worker", entries: pyEntries },
        { label: "Go", language: "go", workerName: "go worker", entries: goEntries },
        { label: "Rust", language: "rust", workerName: "Rust worker", entries: rsEntries },
      ];
      let syncHasL0Language = csEntries.length > 0;
      for (const l0 of syncL0Languages) {
        if (l0.entries.length === 0) continue;
        warnings.push(
          `senkron koşum ${l0.label} derin sembol analizini yürütemez (${l0.workerName} async koşar): ${String(l0.entries.length)} dosya L0 envanter düzeyinde listelendi; tam birleşik analiz için runIndexAsync/refresh işi kullanın`,
        );
        const l0Nodes: SnapshotNodeInput[] = l0.entries.map((entry) => ({
          kind: "File",
          qualifiedName: entry.relativePath,
          language: l0.language,
          relativePath: entry.relativePath,
          attributes: { sourceHash: entry.contentHash },
        }));
        syncHasL0Language = true;
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: l0LanguageAnalyzerId(l0.language),
            analyzerVersion: l0LanguageAnalyzerVersion(l0.language),
            state: "partial",
            nodes: l0Nodes,
            edges: [],
            evidence: [],
          },
          contentHashByPath,
          nodeByKey,
        );
      }

      // Envanter mutabakatı ADAPTER KOŞUMLARINDAN SONRA (async yolun B10
      // sözleşmesiyle aynı sıralama — denetim bulgusu): adapter sözleşme
      // dışı fırlatırsa files tablosu güncellenmez; aksi hâlde güncellenen
      // envanter sonraki incremental koşumu "değişiklik yok" no-op'una
      // itip bayat graph'ı korur.
      this.syncInventoryRecords(entries);

      finalState =
        tsState === "ready" &&
        csState === "ready" &&
        !syncHasL0Language &&
        diagnostics.length === 0
          ? "ready"
          : "partial";
      }
    } catch (error) {
      this.failBuild(opened.buildId, error);
    }

    if (emptyLanguageRun) {
      return this.finalizePublish(
        opened.buildId,
        "partial",
        entries.length,
        0,
        0,
        warnings,
        [],
      );
    }
    return this.finalizePublish(
      opened.buildId,
      finalState,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
    );
  }

  /**
   * TAM pipeline (runIndexAsync/runIncrementalIndexAsync gövdesi; B9+M2).
   * .cs dosyaları analyzeCSharpWorkspace'e; .py/.go/.rs dosyaları ilgili
   * analyzeXWorkspace'e yönlendirilir; beş dilin çıktısı TEK build'e
   * katılır (dangling yok — cross-boundary sözleşmesi). Bir worker
   * kullanılamazsa ilgili adapter L0/L1'e düşer (motor çökmez; diğer
   * dillerin analizi yaşar); partial + explicit warning ile yayımlanır.
   *
   * Fingerprint: C# worker healthy yanıttan ref-pack keşfi türetilir
   * (extractRoslynRefPackContext); python/go/rust worker durumları
   * (ready/worker-unavailable) pystate/gostate/ruststate segmentlerine
   * yazılır — build'in analyzerFingerprint alanı koşuma katılan beş
   * analyzer'ı dürüstçe taşır.
   */
  private async runPipelineAsync(prepared: PreparedRun): Promise<IndexRunResult> {
    const { canonicalRoot, entries, tsEntries, csEntries, pyEntries, goEntries, rsEntries } =
      prepared;
    const warnings: string[] = [];
    const diagnostics: IndexDiagnostic[] = [];
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );

    // Sıralama sözleşmesi (denetim bulgusu): adapter koşumları files
    // upsert'lerinden ÖNCE yapılır. Adapter koşumu build'den ÖNCE olduğundan
    // (fp2 ref-pack gereği) sözleşme dışı bir adapter hatası envanter
    // mutabakatını BOZMADAN rethrow edilir — yoksa güncellenen files
    // tablosu sonraki incremental koşumu "değişiklik yok" kararıyla bayat
    // graph'ı korumaya iterdi.
    let tsState: "ready" | "partial" = "ready";
    let tsNodes: readonly SnapshotNodeInput[] = [];
    let tsEdges: readonly SnapshotEdgeInput[] = [];
    if (tsEntries.length > 0) {
      const adapterResult = analyzeTypeScriptProgram({
        workspaceId: this.workspaceId,
        rootDir: canonicalRoot,
        sources: tsEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
      });
      tsState = adapterResult.state;
      tsNodes = adapterResult.nodes;
      tsEdges = adapterResult.edges;
      for (const diagnostic of adapterResult.diagnostics) {
        const converted: IndexDiagnostic = {
          relativePath: diagnostic.relativePath,
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
        };
        diagnostics.push(converted);
        warnings.push(
          `tanı: ${converted.relativePath}:${String(converted.line)} ${converted.code} ${converted.message}`,
        );
      }
      warnings.push(...adapterResult.warnings);
    }

    let csharpResult: RoslynAdapterResult | undefined;
    if (csEntries.length > 0) {
      // C# adapter (async worker; graceful fallback adapter içindedir).
      csharpResult = await this.analyzeCSharpFn({
        workspaceId: this.workspaceId,
        files: csEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          dotnetCommand: this.csharpSettings.dotnetCommand,
          requestTimeoutMs: this.csharpSettings.requestTimeoutMs,
          workerDllPath: this.csharpSettings.workerDllPath,
        },
      });
      for (const diagnostic of csharpResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `tanı: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...csharpResult.warnings);
    }

    // M2: python/go/rust adapter koşumları (sıra sabittir: python, go,
    // rust — INDEXED_ADAPTERS kayıt sırası). Graceful fallback ADAPTER
    // İÇİNDEDİR: worker yoksa sonuç workerAvailable=false + L0/L1 File
    // node'ları ile döner; motor çökmez, diğer dillerin analizi yaşar.
    let pythonResult: PythonAdapterResult | undefined;
    if (pyEntries.length > 0) {
      pythonResult = await analyzePythonWorkspace({
        workspaceId: this.workspaceId,
        files: pyEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          pythonCommand: this.pythonSettings.pythonCommand,
          requestTimeoutMs: this.pythonSettings.requestTimeoutMs,
          workerScriptPath: this.pythonSettings.workerScriptPath,
          responseMaxChars: this.pythonSettings.responseMaxChars,
        },
      });
      for (const diagnostic of pythonResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `tanı: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...pythonResult.warnings);
    }
    let goResult: GoAdapterResult | undefined;
    if (goEntries.length > 0) {
      goResult = await analyzeGoWorkspace({
        workspaceId: this.workspaceId,
        files: goEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          goBinaryPath: this.goSettings.goBinaryPath,
          ...(this.goSettings.goWorkerBinaryPath.length > 0
            ? { goWorkerBinaryPath: this.goSettings.goWorkerBinaryPath }
            : {}),
          workerDir: this.goSettings.workerDir,
          requestTimeoutMs: this.goSettings.requestTimeoutMs,
        },
      });
      for (const diagnostic of goResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `tanı: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...goResult.warnings);
    }
    let rustResult: RustAdapterResult | undefined;
    if (rsEntries.length > 0) {
      rustResult = await analyzeRustWorkspace({
        workspaceId: this.workspaceId,
        files: rsEntries.map((entry) => ({
          path: entry.relativePath,
          content: entry.content,
        })),
        options: {
          ...(this.hasExplicitRustWorkerDir
            ? { workerDir: this.rustSettings.workerDir }
            : {}),
          workerBinaryName: this.rustSettings.workerBinaryName,
          ...(this.rustSettings.cargoHomeDir.length > 0
            ? { cargoHomeDir: this.rustSettings.cargoHomeDir }
            : {}),
          requestTimeoutMs: this.rustSettings.requestTimeoutMs,
          responseMaxChars: this.rustSettings.responseMaxChars,
          cargoBuildTimeoutMs: this.rustSettings.cargoBuildTimeoutMs,
        },
      });
      for (const diagnostic of rustResult.diagnostics) {
        diagnostics.push(toDiagnostic(diagnostic));
        warnings.push(
          `tanı: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...rustResult.warnings);
    }

    // fp2 ref-pack keşfi: worker healthy koştuysa yanıt warnings'inden
    // türetilir; healthy yanıtta keşif bilgisi yoksa nötr "discovery-unknown"
    // etiketi kullanılır — worker'un VARLIĞI ile keşfin BİLİNMESİ aynı
    // şey değildir (denetim bulgusu).
    let discovery: RoslynDiscoveryStatus;
    let refPacks: RoslynRefPackContext | null;
    if (csharpResult === undefined || !csharpResult.workerAvailable) {
      discovery = "worker-unavailable";
      refPacks = null;
    } else {
      refPacks = extractRoslynRefPackContext(csharpResult.warnings);
      discovery = refPacks === null ? "discovery-unknown" : "performed";
    }

    // M2: sidecar worker durumları — koşuma katılan her dilin GERÇEK
    // worker durumu fingerprint'e yazılır (fp1 dersi: worker'ın koşup
    // koşamadığı graph'ı değiştirir; fp bunu dürüstçe taşımalıdır).
    const pythonStatus: WorkerRunStatus =
      pythonResult === undefined ? "ready" : pythonResult.workerAvailable ? "ready" : "worker-unavailable";
    const goStatus: WorkerRunStatus =
      goResult === undefined ? "ready" : goResult.workerAvailable ? "ready" : "worker-unavailable";
    const rustStatus: WorkerRunStatus =
      rustResult === undefined ? "ready" : rustResult.workerAvailable ? "ready" : "worker-unavailable";

    const createdAt = this.clock();
    const fingerprint = buildAnalyzerFingerprint({
      typescript:
        tsEntries.length > 0
          ? { analyzerId: TS_ADAPTER_ANALYZER_ID, version: TS_ADAPTER_VERSION }
          : null,
      csharp:
        csEntries.length > 0
          ? {
              analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
              version: CSHARP_ROSLYN_ADAPTER_VERSION,
              discovery,
              refPacks,
              settings: this.csharpSettings,
            }
          : null,
      python:
        pyEntries.length > 0
          ? {
              analyzerId: PYTHON_WORKER_ADAPTER_ID,
              version: PYTHON_WORKER_ADAPTER_VERSION,
              status: pythonStatus,
              settings: this.pythonSettings,
            }
          : null,
      go:
        goEntries.length > 0
          ? {
              analyzerId: GO_ADAPTER_ID,
              version: GO_ADAPTER_VERSION,
              status: goStatus,
              settings: this.goSettings,
            }
          : null,
      rust:
        rsEntries.length > 0
          ? {
              analyzerId: RUST_ADAPTER_ID,
              version: RUST_ADAPTER_VERSION,
              status: rustStatus,
              settings: this.rustSettings,
            }
          : null,
    });

    const buildAttempt = this.openBuildOrRecover(
      entries,
      fingerprint,
      createdAt,
      canonicalRoot,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
    );
    if (buildAttempt.kind === "reused") {
      return buildAttempt.result;
    }
    const opened = buildAttempt.opened;

    let finalState: PublishableState = "ready";
    let emptyLanguageRun = false;
    try {
      // Envanter mutabakatı ADAPTER KOŞUMULARINDAN ve build açılışından sonra:
      // başka sürecin aktif build'i nedeniyle önceki snapshot'a düşülürse
      // files tablosu yayımlanmamış karmalarla kirlenmez.
      this.syncInventoryRecords(entries);

      // Erken çıkış: analiz edilebilir dil kaynağı yok — senkron yolun
      // aynı dürüstlük sözleşmesi (denetim bulgusu): coverage sıfırken
      // 'ready' uydurulmaz; partial + explicit kapsam uyarıları yayımlanır.
      if (
        tsEntries.length === 0 &&
        csEntries.length === 0 &&
        pyEntries.length === 0 &&
        goEntries.length === 0 &&
        rsEntries.length === 0
      ) {
        warnings.push(
          "workspace analiz edilebilir TypeScript/TSX/C#/Python/Go/Rust kaynağı içermiyor; coverage sıfır (partial yayınlendi)",
        );
        for (const entry of entries) {
          warnings.push(`dosya envanterde ama dil adapter kapsamı dışında: ${entry.relativePath}`);
        }
        emptyLanguageRun = true;
      } else {

      const nodeByKey = new Map<string, GraphNode>();
      let state: PublishableState = "ready";

      if (tsEntries.length > 0) {
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: TS_ADAPTER_ANALYZER_ID,
            analyzerVersion: TS_ADAPTER_VERSION,
            state: tsState,
            nodes: tsNodes,
            edges: tsEdges,
            evidence: [],
          },
          contentHashByPath,
          nodeByKey,
        );
      }
      if (csharpResult !== undefined) {
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: csharpResult.analyzerId,
            analyzerVersion: csharpResult.analyzerVersion,
            state: csharpResult.state,
            nodes: csharpResult.nodes,
            edges: csharpResult.edges,
            evidence: csharpResult.evidence,
          },
          contentHashByPath,
          nodeByKey,
        );
        if (csharpResult.state !== "ready") state = "partial";
      }
      // M2: python/go/rust çıktıları aynı addAdapterGraph sözleşmesiyle
      // TEK build'e katılır (node kimliği çakışması açık hatadır; kenar
      // uçları node haritasından çözülür — dangling yok).
      for (const result of [pythonResult, goResult, rustResult]) {
        if (result === undefined) continue;
        this.addAdapterGraph(
          opened.buildId,
          opened.workspaceNode,
          {
            analyzerId: result.analyzerId,
            analyzerVersion: result.analyzerVersion,
            state: result.state,
            nodes: result.nodes,
            edges: result.edges,
            evidence: result.evidence,
          },
          contentHashByPath,
          nodeByKey,
        );
        if (result.state !== "ready") state = "partial";
      }
      if (tsState !== "ready") state = "partial";
      if (diagnostics.length > 0) state = "partial";
      finalState = state;
      }
    } catch (error) {
      this.failBuild(opened.buildId, error);
    }

    if (emptyLanguageRun) {
      return this.finalizePublish(
        opened.buildId,
        "partial",
        entries.length,
        0,
        0,
        warnings,
        [],
      );
    }
    return this.finalizePublish(
      opened.buildId,
      finalState,
      entries.length,
      tsEntries.length,
      csEntries.length,
      warnings,
      diagnostics,
    );
  }

  /**
   * Adapter çıktısını build'e katıyor: node'lar (dil crossed duplicate
   * kimlik reddedilir) → kenarlar (uçlar node haritasından çözülür —
   * dangling yok) → üst düzey kanıtlar → Workspace→File CONTAINS kenarları
   * (envanter kanıtlı; her iki dilin File node'ları için).
   */
  private addAdapterGraph(
    buildId: string,
    workspaceNode: GraphNode,
    output: AdapterOutput,
    contentHashByPath: ReadonlyMap<string, string>,
    nodeByKey: Map<string, GraphNode>,
  ): void {
    // 1) Node'lar: iki dil TEK kimlik haritasında; çakışma açık hatadır
    //    (cross-boundary sözleşmesi — nodeId language içermez).
    for (const nodeInput of output.nodes) {
      const key = nodeRefKey(nodeInput);
      if (nodeByKey.has(key)) {
        throw new IndexingError(
          "indexing/internal",
          `iki adapter aynı node kimliğini üretti: ${key}`,
        );
      }
      const node = toGraphNode(this.workspaceId, nodeInput, contentHashByPath);
      nodeByKey.set(key, node);
      this.repository.addNode(buildId, node);
    }

    // 2) Kenarlar: uçlar node haritasından çözülür (dangling yok).
    for (const edgeInput of output.edges) {
      const from = nodeByKey.get(nodeRefKey(edgeInput.from));
      const to = nodeByKey.get(nodeRefKey(edgeInput.to));
      if (from === undefined || to === undefined) {
        const missing = from === undefined ? edgeInput.from : edgeInput.to;
        throw new IndexingError(
          "indexing/internal",
          `adapter kenarı bilinmeyen node'a işaret ediyor: ${nodeRefKey(missing)}`,
        );
      }
      const evidenceIds: string[] = [];
      for (const evidenceInput of edgeInput.evidence ?? []) {
        const evidence = toEvidence(this.workspaceId, evidenceInput);
        this.repository.addEvidence(buildId, evidence);
        evidenceIds.push(evidence.id);
      }
      const edge: GraphEdge = createEdge({
        workspaceId: this.workspaceId,
        kind: edgeInput.kind,
        from: from.id,
        to: to.id,
        resolution: edgeInput.resolution,
        evidenceIds,
        ...(edgeInput.ambiguity === undefined
          ? {}
          : {
              ambiguity: {
                candidates: [...edgeInput.ambiguity.candidates],
                reason: edgeInput.ambiguity.reason,
              },
            }),
      });
      this.repository.addEdge(buildId, edge);
    }

    // 3) Üst düzey kanıtlar (roslyn worker PROTOCOL.md v1; repository
    //    aynı kimliği sessiz dedup eder).
    for (const evidenceInput of output.evidence) {
      this.repository.addEvidence(buildId, toEvidence(this.workspaceId, evidenceInput));
    }

    // 4) CONTAINS: Workspace → her File node (envanter kanıtlı).
    for (const nodeInput of output.nodes) {
      if (nodeInput.kind !== "File" || nodeInput.relativePath === undefined) continue;
      const fileNode = nodeByKey.get(nodeRefKey(nodeInput));
      const sourceHash = contentHashByPath.get(nodeInput.relativePath);
      if (fileNode === undefined || sourceHash === undefined) {
        throw new IndexingError(
          "indexing/internal",
          `File node envanterle eşleşmedi: ${nodeInput.relativePath}`,
        );
      }
      const inventoryEvidence = toEvidence(this.workspaceId, {
        kind: "inventory",
        span: {
          relativePath: nodeInput.relativePath,
          startLine: 1,
          endLine: 1,
          sourceHash,
        },
        analyzerId: "causoryn-indexing",
        analyzerVersion: INDEXING_VERSION,
        rationale: "dosya envanteri: WorkspaceAccessPolicy izinli kaynak dosya",
      });
      this.repository.addEvidence(buildId, inventoryEvidence);
      this.repository.addEdge(
        buildId,
        createEdge({
          workspaceId: this.workspaceId,
          kind: "CONTAINS",
          from: workspaceNode.id,
          to: fileNode.id,
          resolution: "verified",
          evidenceIds: [inventoryEvidence.id],
        }),
      );
    }
  }

  /** Build'i failed yapar ve hatayı sınıf sözleşmesine çevirip fırlatır. */
  private failBuild(buildId: string, error: unknown): never {
    if (error instanceof IndexingError) {
      this.repository.failBuild(buildId, `${error.code}: ${error.message}`);
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.repository.failBuild(buildId, reason);
    if (error instanceof GraphRepositoryError) {
      throw new IndexingError("indexing/internal", `graph deposu reddetti: ${reason}`);
    }
    throw error;
  }

  private ensureWorkspaceRegistered(): void {
    if (this.workspaceRegistered) return;
    try {
      this.repository.registerWorkspace({
        id: this.workspaceId,
        rootPath: this.policy.config.allowRoots[0] ?? "(root yetkilendirmesi runIndex'te yapılır)",
        createdAt: this.clock(),
      });
      this.workspaceRegistered = true;
    } catch (error) {
      if (error instanceof GraphRepositoryError && error.code === "graph/duplicate-workspace") {
        // Aynı workspace zaten kayıtlı: idempotent kabul edilir.
        this.workspaceRegistered = true;
        return;
      }
      throw error;
    }
  }
}
