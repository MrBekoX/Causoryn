import path from "node:path";

import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_VERSION,
  analyzeTypeScriptProgram,
  type TypeScriptAdapterDiagnostic,
} from "@causoryn/adapter-typescript";
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
  type SnapshotGraph,
  type SourceSpan,
} from "@causoryn/domain";
import { GraphRepositoryError, type GraphRepository, type PublishableState } from "@causoryn/graph";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import { collectInventory, type InventoryEntry } from "./inventory.js";

/**
 * IndexService — minimal indeksleme pipeline'ı (TŞ v2.1 §9, §25/4-5;
 * sprint-1 görev 6'nın indexing dilimi):
 *
 *   dosya envanteri (WorkspaceAccessPolicy ile) → TS Language Adapter
 *   → graph inşası (deterministik domain ID'leri) → atomik snapshot publish
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
 */

/** Pipeline sürümü; envanter evidence `analyzerVersion` alanına yazılır. */
export const INDEXING_VERSION = "0.1.0";

/** Envanter/adaptasyon limitleri (TŞ §20 index bölümünün Faz A dilimi). */
export interface IndexLimits {
  readonly maxFiles: number;
}

export interface IndexServiceOptions {
  readonly workspaceId: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  /** ISO-8601 üretir; domain saat okumaz. */
  readonly clock: () => string;
  readonly limits: IndexLimits;
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
  readonly state: PublishableState;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly IndexDiagnostic[];
  /**
   * true: yeni snapshot yayımlandı. false: incremental no-op — değişiklik
   * TS analizi için anlamlı değildi; graph korunup mevcut snapshot
   * yeniden kullanıldı (yalnızca files tablosu tazelendi).
   */
  readonly published: boolean;
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

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);

export class IndexService {
  private readonly workspaceId: string;
  private readonly policy: WorkspaceAccessPolicy;
  private readonly repository: GraphRepository;
  private readonly clock: () => string;
  private readonly limits: IndexLimits;
  private readonly configHash: string;
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
  }

  /**
   * Kökü yetkilendirir, envanteri çıkarır, TS kaynaklarını adapter'dan
   * geçirir ve snapshot'ı atomik yayımlar. Yetkisiz kök / limit aşımı
   * IndexingError ile reddedilir; hiçbir kısmi yayın yapılmaz.
   */
  runIndex(rootPath: string): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    return this.runPipeline(prepared.canonicalRoot, prepared.entries, prepared.tsEntries);
  }

  /**
   * Incremental yeniden indeksleme (TŞ v2.1 §9 "Incremental pipeline";
   * sprint-2 B7 Live Architecture).
   *
   * Karar yetkilisi DEĞİŞİKLİK KARMASIDIR (TŞ §9 "fingerprint" adımı),
   * olay kümesi değil: envanter tam taranır, files tablosunun önceki
   * karmalarıyla karşılaştırılır. TS analizi için anlamlı değişim yoksa
   * (yalnızca TS-dışı dosya eklendi/değişti/touch edildi) graph KORUNUR,
   * mevcut snapshot yeniden kullanılır ve yalnızca files tablosu
   * tazelenir (published=false). TS kaynaklarında değişim varsa (ekleme,
   * içerik değişimi, silme) tam deterministik pipeline'dan YENİ snapshot
   * türetilip atomik yayımlanır — değişen dosyaların güncel içerikle
   * yeniden analizi bu yayına akar (ask şartı 3).
   *
   * Dürüstlük notu: per-file parse önbelleği yoktur — TS adapter'ı
   * program-geniş çözümleme yapar; bu dilimin incrementalliği change-set
   * takibi + karma tabanlı no-op atlaması + mod seçimidir (ayrıntı
   * WorkspaceWatcher sınıf başlığında).
   *
   * `changeSet` karar yetkilisi DEĞİLDİR: kayıt/izlenebilirlik içindir
   * (IndexJobRecord.changeSet). Yetkisi olmayan bir olay kümesi geldiğinde
   * bile karma karşılaştırması kaçan olayları yakalar (reconciliation
   * davranışı, TŞ §9 "overflow ... reconciliation scan").
   */
  runIncrementalIndex(rootPath: string, changeSet: readonly string[] = []): IndexRunResult {
    const prepared = this.prepareRun(rootPath);
    // Önceki durum, files tablosu upsert'lerinden ÖNCE okunur: karar
    // yetkilisi bu karşılaştırmadır (upsert'ler sonrası okuma her şeyi
    // "değişmemiş" gösterirdi).
    const previousHashes = new Map(
      this.repository
        .listFiles(this.workspaceId)
        .map((record) => [record.relativePath, record.contentHash]),
    );
    const previousTsPaths = [...previousHashes.keys()].filter((relativePath) =>
      TS_EXTENSIONS.has(path.extname(relativePath).toLowerCase()),
    );
    const changedTs = prepared.tsEntries.filter(
      (entry) => previousHashes.get(entry.relativePath) !== entry.contentHash,
    );
    const deletedTs = previousTsPaths.filter(
      (relativePath) => !prepared.tsEntries.some((entry) => entry.relativePath === relativePath),
    );
    const latest = this.repository.getLatestPublished(this.workspaceId);

    // No-op koşulu: TS analizi için anlamlı değişim yok VE kullanılabilir
    // bir yayın var (no-op yalnızca mevcut snapshot'ı yeniden kullanabilir).
    if (
      changedTs.length === 0 &&
      deletedTs.length === 0 &&
      latest !== undefined &&
      (latest.snapshot.meta.state === "ready" || latest.snapshot.meta.state === "partial")
    ) {
      const updatedAt = this.clock();
      for (const entry of prepared.entries) {
        this.repository.upsertFile({
          workspaceId: this.workspaceId,
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          sizeBytes: entry.sizeBytes,
          updatedAt,
        });
      }
      return {
        snapshotId: latest.snapshot.meta.id,
        snapshot: latest.snapshot,
        stale: latest.stale,
        fileCount: prepared.entries.length,
        tsFileCount: prepared.tsEntries.length,
        state: latest.snapshot.meta.state,
        warnings: [
          "incremental no-op: TS analizi için anlamlı değişiklik yok; mevcut snapshot korundu, files tablosu tazelendi",
          `değişiklik kümesi: ${changeSet.length === 0 ? "(boş)" : changeSet.join(", ")}`,
        ],
        diagnostics: [],
        published: false,
      };
    }

    return this.runPipeline(prepared.canonicalRoot, prepared.entries, prepared.tsEntries);
  }

  /** Ortak hazırlık: yetki + workspace kaydı + tam envanter (Discover). */
  private prepareRun(rootPath: string): {
    readonly canonicalRoot: string;
    readonly entries: InventoryEntry[];
    readonly tsEntries: InventoryEntry[];
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
    return { canonicalRoot, entries, tsEntries };
  }

  /**
   * Deterministik build+publish pipeline'ı (runIndex/runIncrementalIndex
   * ortak gövdesi). Girdi aynıysa çıktı graph JSON'ı birebir aynıdır
   * (TŞ §8 invariant vi); mod bilgisi graph meta'sına girmez.
   */
  private runPipeline(
    canonicalRoot: string,
    entries: InventoryEntry[],
    tsEntries: InventoryEntry[],
  ): IndexRunResult {
    const warnings: string[] = [];
    const contentHashByPath = new Map<string, string>(
      entries.map((entry) => [entry.relativePath, entry.contentHash]),
    );

    // Envanter kayıtları (TŞ §9 files tablosu karşılığı).
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

    const revision = { id: "working-tree", sequence: this.runCount + 1 };
    const createdAt = this.clock();

    // Build akışı: her hata failBuild ile kaydedilir; yarım snapshot asla
    // yayın haritasına girmez (ADR-005).
    const build = this.repository.beginBuild({
      workspaceId: this.workspaceId,
      revision,
      configHash: this.configHash,
      analyzerFingerprint: `${TS_ADAPTER_ANALYZER_ID}@${TS_ADAPTER_VERSION}`,
      createdAt,
    });

    try {
      // 1) Workspace node (her zaman; boş workspace için tek node).
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

      if (tsEntries.length === 0) {
        warnings.push(
          "workspace analiz edilebilir TypeScript/TSX kaynağı içermiyor; coverage sıfır (partial yayınlendi)",
        );
        for (const entry of entries) {
          warnings.push(`dosya envanterde ama TS adapter kapsamı dışında: ${entry.relativePath}`);
        }
        const publishedAt = this.clock();
        const snapshot = this.repository.publish(build.buildId, "partial", publishedAt);
        this.runCount += 1;
        const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
        return {
          snapshotId: snapshot.meta.id,
          snapshot,
          stale,
          fileCount: entries.length,
          tsFileCount: 0,
          state: "partial",
          warnings,
          diagnostics: [],
          published: true,
        };
      }

      // 2) TS adapter (salt-okunur kaynak çantası; rootDir çözümleme
      //    çapasıdır, adapter diske YAZMAZ — ADR-008).
      const adapterResult = analyzeTypeScriptProgram({
        workspaceId: this.workspaceId,
        rootDir: canonicalRoot,
        sources: tsEntries.map((entry) => ({
          relativePath: entry.relativePath,
          content: entry.content,
        })),
      });

      // 3) Graph inşası: node'lar → kanıtlar → kenarlar (dangling yok).
      const nodeByKey = new Map<string, GraphNode>();
      for (const nodeInput of adapterResult.nodes) {
        const node = toGraphNode(this.workspaceId, nodeInput, contentHashByPath);
        nodeByKey.set(nodeRefKey(nodeInput), node);
        this.repository.addNode(build.buildId, node);
      }

      for (const edgeInput of adapterResult.edges) {
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
          this.repository.addEvidence(build.buildId, evidence);
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
        this.repository.addEdge(build.buildId, edge);
      }

      // 4) CONTAINS: Workspace → her File node (envanter kanıtlı).
      for (const nodeInput of adapterResult.nodes) {
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
        this.repository.addEvidence(build.buildId, inventoryEvidence);
        this.repository.addEdge(
          build.buildId,
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

      // 5) Durum: adapter diagnostics → partial; aksi halde ready.
      const diagnostics: IndexDiagnostic[] = adapterResult.diagnostics.map(
        (diagnostic: TypeScriptAdapterDiagnostic) => ({
          relativePath: diagnostic.relativePath,
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
        }),
      );
      for (const diagnostic of diagnostics) {
        warnings.push(
          `tanı: ${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
        );
      }
      warnings.push(...adapterResult.warnings);
      const state: PublishableState =
        adapterResult.state === "ready" && diagnostics.length === 0 ? "ready" : "partial";

      const publishedAt = this.clock();
      const snapshot = this.repository.publish(build.buildId, state, publishedAt);
      this.runCount += 1;
      const stale = this.repository.getLatestPublished(this.workspaceId)?.stale ?? false;
      return {
        snapshotId: snapshot.meta.id,
        snapshot,
        stale,
        fileCount: entries.length,
        tsFileCount: tsEntries.length,
        state,
        warnings,
        diagnostics,
        published: true,
      };
    } catch (error) {
      if (error instanceof IndexingError) {
        this.repository.failBuild(build.buildId, `${error.code}: ${error.message}`);
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.repository.failBuild(build.buildId, reason);
      if (error instanceof GraphRepositoryError) {
        throw new IndexingError("indexing/internal", `graph deposu reddetti: ${reason}`);
      }
      throw error;
    }
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
