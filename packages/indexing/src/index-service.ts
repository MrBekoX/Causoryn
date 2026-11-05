import path, { dirname, join, resolve } from "node:path";
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
import { GraphRepositoryError, type GraphRepository, type PublishableState } from "@causoryn/graph";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import {
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
  type RoslynAdapterSettings,
  type RoslynDiscoveryStatus,
  type RoslynRefPackContext,
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
 * B9 çoklu dil sözleşmesi (iki koşum yolu):
 * - `runIndexAsync` / `runIncrementalIndexAsync`: TAM pipeline — .cs
 *   dosyaları analyzeCSharpWorkspace'e yönlendirilir; TS + C# çıktıları
 *   TEK snapshot'a katılır (dangling yok — cross-boundary sözleşmesi).
 *   Worker kullanılamıyorsa adapter'ın L0/L1 fallback'i ile motor çökmez
 *   (partial + explicit warning).
 * - `runIndex` / `runIncrementalIndex` (SENKRON köprü): Roslyn worker
 *   async koştuğu için senkron imza C# derin analizini BEKLEYEMEZ; .cs'li
 *   workspace'te C# yalnızca L0 envanter düzeyinde (File node'ları,
 *   uydurma sembol/kenar yok) temsil edilir ve bu dürüstçe partial +
 *   explicit warning ile raporlanır (TŞ §7 "yalnızca kanıtlanabilen
 *   L0/L1 bilgisi sunulur"). Senkron yol hiçbir koşulda worker'ı
 *   başlatmaz — spawn çağrısı yalnızca adapter'ın async API'sindedir.
 */
/**
 * Pipeline sürümü; envanter evidence `analyzerVersion` alanına yazılır.
 * Manifest hizası (denetim bulgusu): bu sabit packages/indexing
 * package.json sürümüyle KİLİTLİDİR (test: index-service-csharp.test.ts
 * "INDEXING_VERSION packages/indexing manifest sürümüyle aynıdır") —
 * mcp-server iç workspace bağımlılıklarını exact "0.1.0" pinlediğinden
 * (packages/mcp-server/package.json:13) sürüm yükseltmesi manifest-first
 * yapılmalıdır; aksi halde npm çözümlemesi kırılır. Pipeline davranış
 * kimliği, bu sürümden bağımsız olarak analyzerFingerprint fp2 şemasıyla
 * taşınır (fp1→fp2 geçişi snapshot meta'da ayrışır).
 */
export const INDEXING_VERSION = "0.1.0";

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

export interface IndexServiceOptions {
  readonly workspaceId: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  /** ISO-8601 üretir; domain saat okumaz. */
  readonly clock: () => string;
  readonly limits: IndexLimits;
  /** C# (roslyn worker) adapter ayarları; tanımsızsa defaults. */
  readonly csharp?: CsharpIndexOptions;
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

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const CS_EXTENSIONS = new Set([".cs"]);

/** src/ ve dist/ aynı derinlikte → iki derleme modunda da repo kökü. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export class IndexService {
  private readonly workspaceId: string;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly repository: GraphRepository;
  private readonly clock: () => string;
  private readonly limits: IndexLimits;
  private readonly configHash: string;
  /** C# adapter'a geçilen etkin ayarlar (opts fingerprint hash'i). */
  private readonly csharpSettings: RoslynAdapterSettings;
  /** C# analiz seam'i: prod analyzeCSharpWorkspace; testler stub enjekte eder. */
  private readonly analyzeCSharpFn: AnalyzeCSharpFunction;
  private workspaceRegistered = false;
  private runCount = 0;

  constructor(options: IndexServiceOptions) {
    this.workspaceId = options.workspaceId;
    this.policy = options.policy;
    this.repository = options.repository;
    this.clock = options.clock;
    this.limits = options.limits;
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
    // Etkin C# ayarları: açık option > ortam değişkeni (worker DLL yolu) >
    // adapter varsayılanı. Ortam değişkeni kuralı adapter ile aynıdır
    // (CAUSORYN_ROSLYN_WORKER_DLL) — fingerprint gerçekten kullanılan
    // DLL yolunu yansıtır. Bu sınıf yolu yalnızca adapter option'ına ve
    // opts hash'ine taşır; süreç başlatma yalnızca adapter'dadır.
    const envWorkerDll = process.env["CAUSORYN_ROSLYN_WORKER_DLL"];
    const defaultWorkerDll =
      envWorkerDll !== undefined && envWorkerDll.trim().length > 0
        ? envWorkerDll
        : join(REPO_ROOT, WORKER_DLL_RELATIVE_PATH);
    const csharpOptions = options.csharp ?? {};
    this.csharpSettings = {
      dotnetCommand: csharpOptions.dotnetCommand ?? DEFAULT_DOTNET_COMMAND,
      requestTimeoutMs: csharpOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      workerDllPath: csharpOptions.workerDllPath ?? defaultWorkerDll,
    };
    // Yalnızca test enjeksiyonu; opts fingerprint hash'ine girmez.
    this.analyzeCSharpFn = csharpOptions.analyzeCSharp ?? analyzeCSharpWorkspace;
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
    return this.runPipeline(
      prepared.canonicalRoot,
      prepared.entries,
      prepared.tsEntries,
      prepared.csEntries,
    );
  }

  /**
   * TAM pipeline (B9): kökü yetkilendirir, envanteri çıkarır, TS ve .cs
   * kaynaklarını sırayla kendi adapter'larından geçirir ve iki dilin
   * çıktısını TEK snapshot'a katıp atomik yayımlar. Worker kullanılamıyorsa
   * adapter L0/L1'e düşer (partial + warning) — motor çökmez.
   */
  async runIndexAsync(rootPath: string): Promise<IndexRunResult> {
    const prepared = this.prepareRun(rootPath);
    return this.runPipelineAsync(
      prepared.canonicalRoot,
      prepared.entries,
      prepared.tsEntries,
      prepared.csEntries,
    );
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
    return this.runPipeline(
      prepared.canonicalRoot,
      prepared.entries,
      prepared.tsEntries,
      prepared.csEntries,
    );
  }

  /**
   * TAM incremental pipeline (B9): TS + C# karma karşılaştırması; her iki
   * dilde de anlamlı değişim yoksa mevcut snapshot korunur (published=false),
   * varsa iki dilin tam analiziyle YENİ snapshot türetilir ve atomik
   * yayımlanır.
   */
  async runIncrementalIndexAsync(
    rootPath: string,
    changeSet: readonly string[] = [],
  ): Promise<IndexRunResult> {
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
    return this.runPipelineAsync(
      prepared.canonicalRoot,
      prepared.entries,
      prepared.tsEntries,
      prepared.csEntries,
    );
  }

  /**
   * Karma tabanlı değişim analizi (senkron + async ortak karar girdisi):
   * önceki files tablosu karmalarıyla güncel envanter karşılaştırılır.
   * TS ve C# kümeleri birlikte değerlendirilir (ikisi de graph'a katkı
   * verir); TS/CS-dışı dosyalar kararı etkilemez (bkz. noOpResult).
   */
  private analyzeChanges(entries: readonly InventoryEntry[]): boolean {
    const previousHashes = new Map(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => [record.relativePath, record.contentHash]),
    );
    const tsEntries = entries.filter((entry) =>
      TS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const csEntries = entries.filter((entry) =>
      CS_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase()),
    );
    const changedTs = tsEntries.filter(
      (entry) => previousHashes.get(entry.relativePath) !== entry.contentHash,
    );
    const deletedTs = [...previousHashes.keys()].filter(
      (relativePath) =>
        TS_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) &&
        !tsEntries.some((entry) => entry.relativePath === relativePath),
    );
    const changedCs = csEntries.filter(
      (entry) => previousHashes.get(entry.relativePath) !== entry.contentHash,
    );
    const deletedCs = [...previousHashes.keys()].filter(
      (relativePath) =>
        CS_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) &&
        !csEntries.some((entry) => entry.relativePath === relativePath),
    );
    return (
      changedTs.length > 0 || deletedTs.length > 0 || changedCs.length > 0 || deletedCs.length > 0
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
  private prepareRun(rootPath: string): {
    readonly canonicalRoot: string;
    readonly entries: InventoryEntry[];
    readonly tsEntries: InventoryEntry[];
    readonly csEntries: InventoryEntry[];
  } {
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
    return { canonicalRoot, entries, tsEntries, csEntries };
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
   * SENKRON pipeline (runIndex/runIncrementalIndex gövdesi). C# derin
   * analizi YOKTUR: worker async koşar, senkron imza onu bekleyemez ve bu
   * yol worker'ı hiç başlatmaz — C# L0 File node'ları envanterden türetilir
   * (adapter L0/L1 fallback node şemasıyla birebir: kind File, language
   * csharp, attributes.sourceHash) ve durum partial'a zorlanır.
   *
   * Girdi aynıysa çıktı graph JSON'ı birebir aynıdır (TŞ §8 invariant vi);
   * mod bilgisi graph meta'sına girmez.
   */
  private runPipeline(
    canonicalRoot: string,
    entries: InventoryEntry[],
    tsEntries: InventoryEntry[],
    csEntries: InventoryEntry[],
  ): IndexRunResult {
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
    });
    const opened = this.openBuild(fingerprint, createdAt, canonicalRoot);

    try {
      // Erken çıkış: analiz edilebilir dil kaynağı yok (orijinal davranış,
      // genelleştirilmiş uyarı; tek Workspace node'uyla partial publish).
      if (tsEntries.length === 0 && csEntries.length === 0) {
        // Envanter mutabakatı: bu dalda adapter koşumu YOK, sıralama
        // tehlikesi yok — build'e girmeden mutabakat yapılır (async yol
        // sözleşmesiyle aynı mutabakat garantisi).
        this.syncInventoryRecords(entries);
        warnings.push(
          "workspace analiz edilebilir TypeScript/TSX/C# kaynağı içermiyor; coverage sıfır (partial yayınlendi)",
        );
        for (const entry of entries) {
          warnings.push(`dosya envanterde ama dil adapter kapsamı dışında: ${entry.relativePath}`);
        }
        const publishedAt = this.clock();
        const snapshot = this.repository.publish(opened.buildId, "partial", publishedAt);
        this.runCount += 1;
        const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
        return {
          snapshotId: snapshot.meta.id,
          snapshot,
          stale,
          fileCount: entries.length,
          tsFileCount: 0,
          csFileCount: 0,
          state: "partial",
          warnings,
          diagnostics: [],
          published: true,
        };
      }

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

      // Envanter mutabakatı ADAPTER KOŞUMLARINDAN SONRA (async yolun B10
      // sözleşmesiyle aynı sıralama — denetim bulgusu): adapter sözleşme
      // dışı fırlatırsa files tablosu güncellenmez; aksi hâlde güncellenen
      // envanter sonraki incremental koşumu "değişiklik yok" no-op'una
      // itip bayat graph'ı korur.
      this.syncInventoryRecords(entries);

      const state: PublishableState =
        tsState === "ready" && csState === "ready" && diagnostics.length === 0
          ? "ready"
          : "partial";

      const publishedAt = this.clock();
      const snapshot = this.repository.publish(opened.buildId, state, publishedAt);
      this.runCount += 1;
      const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
      return {
        snapshotId: snapshot.meta.id,
        snapshot,
        stale,
        fileCount: entries.length,
        tsFileCount: tsEntries.length,
        csFileCount: csEntries.length,
        state,
        warnings,
        diagnostics,
        published: true,
      };
    } catch (error) {
      this.failBuild(opened.buildId, error);
    }
  }

  /**
   * TAM pipeline (runIndexAsync/runIncrementalIndexAsync gövdesi; B9).
   * .cs dosyaları analyzeCSharpWorkspace'e yönlendirilir; TS + C# çıktıları
   * TEK build'e katılır (dangling yok — cross-boundary sözleşmesi). Worker
   * kullanılamazsa adapter L0/L1'e düşer; partial + warning ile yayımlanır.
   *
   * Fingerprint: worker healthy yanıttan ref-pack keşfi türetilir
   * (extractRoslynRefPackContext) ve build'in analyzerFingerprint alanına
   * yazılır — adapters/csharp-roslyn/README.md "Açık borç" sözleşmesinin
   * fp2 kapanışı.
   */
  private async runPipelineAsync(
    canonicalRoot: string,
    entries: InventoryEntry[],
    tsEntries: InventoryEntry[],
    csEntries: InventoryEntry[],
  ): Promise<IndexRunResult> {
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
    });

    // Envanter mutabakatı ADAPTER KOŞUMULARINDAN sonra (yukarıdaki sıralama
    // sözleşmesi); build açılışından önce.
    this.syncInventoryRecords(entries);

    const opened = this.openBuild(fingerprint, createdAt, canonicalRoot);

    try {
      // Erken çıkış: analiz edilebilir dil kaynağı yok — senkron yolun
      // aynı dürüstlük sözleşmesi (denetim bulgusu): coverage sıfırken
      // 'ready' uydurulmaz; partial + explicit kapsam uyarıları yayımlanır.
      if (tsEntries.length === 0 && csEntries.length === 0) {
        warnings.push(
          "workspace analiz edilebilir TypeScript/TSX/C# kaynağı içermiyor; coverage sıfır (partial yayınlendi)",
        );
        for (const entry of entries) {
          warnings.push(`dosya envanterde ama dil adapter kapsamı dışında: ${entry.relativePath}`);
        }
        const publishedAt = this.clock();
        const snapshot = this.repository.publish(opened.buildId, "partial", publishedAt);
        this.runCount += 1;
        const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
        return {
          snapshotId: snapshot.meta.id,
          snapshot,
          stale,
          fileCount: entries.length,
          tsFileCount: 0,
          csFileCount: 0,
          state: "partial",
          warnings,
          diagnostics: [],
          published: true,
        };
      }

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
      if (tsState !== "ready") state = "partial";
      if (diagnostics.length > 0) state = "partial";

      const publishedAt = this.clock();
      const snapshot = this.repository.publish(opened.buildId, state, publishedAt);
      this.runCount += 1;
      const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
      return {
        snapshotId: snapshot.meta.id,
        snapshot,
        stale,
        fileCount: entries.length,
        tsFileCount: tsEntries.length,
        csFileCount: csEntries.length,
        state,
        warnings,
        diagnostics,
        published: true,
      };
    } catch (error) {
      this.failBuild(opened.buildId, error);
    }
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
