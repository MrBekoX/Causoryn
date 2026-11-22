import type {
  Evidence,
  GraphEdge,
  GraphNode,
  RevisionRef,
  SnapshotGraph,
} from "@causoryn/domain";

/**
 * GraphRepository sözleşmesi — TŞ v2.1 §8/§9, ADR-004/005; sprint-1 görev 5.
 *
 * Depo katmanı saat okumaz: `createdAt`/`publishedAt` çağıran tarafından
 * taşınır (determinizm; domain paketindeki aynı ilkenin devamı).
 *
 * Atomik yayımlama semantiği (TŞ §9):
 * - `beginBuild` yeni indekslemeyi `building` durumunda açar; building
 *   snapshot hiçbir okuma yolunda görünmez (yarım snapshot asla görünmez).
 * - Build sürerken `getLatestPublished` eski yayını döndürür ve
 *   `stale=true` bayrağıyla işaretler; eski snapshot ID ile sorgulanmaya
 *   devam eder.
 * - `publish(buildId, state, publishedAt)` bütünlük kontrolünden sonra
 *   snapshot'ı atomik olarak `ready`/`partial` yayımlar; tek işlemde
 *   gerçekleşir, yarım durum bırakmaz.
 * - `failBuild` başarısız denemeyi `failed` olarak kaydeder; failed kayıt
 *   yayın akışına girmez ve mevcut yayını stale yapmaz.
 */

/** Yayımlanabilir snapshot durumları; `building`/`failed` yayımlanamaz. */
export type PublishableState = "ready" | "partial";

/** Kayıtlı workspace kaydı (TŞ §9 workspaces tablosu). */
export interface WorkspaceRecord {
  readonly id: string;
  readonly rootPath: string;
  readonly createdAt: string;
}

/** Dosya envanteri kaydı (TŞ §9 files tablosu). */
export interface FileRecord {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

/** Snapshot inşası girdisi (TŞ §8 GraphSnapshot meta alanları). */
export interface SnapshotBuildInput {
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly createdAt: string;
}

/** Aktif/başarısız build bilgisi; publish sonrası build tüketilir. */
export interface SnapshotBuildInfo {
  readonly buildId: string;
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly createdAt: string;
  readonly state: "building" | "failed";
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly evidenceCount: number;
  readonly failureReason?: string;
}

/** Snapshot okuma sonucu: değişmez graph + staleness bayrağı (TŞ §9). */
export interface SnapshotRead {
  readonly snapshot: SnapshotGraph;
  readonly stale: boolean;
}

/**
 * symbol_fts indeks girdisi: sembol adı → node eşlemesi (TŞ §9 FTS5
 * sembol/ad arama; Faz A dilimi yalnızca tablo + temel ekleme/arama).
 */
export interface SymbolIndexEntry {
  readonly symbol: string;
  readonly nodeId: string;
}

/** Sembol arama isabeti; yalnızca yayımlanmış snapshot'lardan döner. */
export interface SymbolSearchHit {
  readonly symbol: string;
  readonly nodeId: string;
  readonly snapshotId: string;
}

/**
 * Graph deposu sözleşmesi. `packages/storage-sqlite` bu arayüzün SQLite
 * gerçeklemesini verir; bellek içi gerçekleme test ve küçük iş yükleri
 * içindir. Bağımlılık sınırı: bu arayüz hiçbir adapter/MCP paketini
 * import etmez (TŞ §5 sınır 1/3).
 */
export interface GraphRepository {
  registerWorkspace(record: WorkspaceRecord): void;
  upsertFile(record: FileRecord): void;
  listFiles(workspaceId: string): readonly FileRecord[];
  /**
   * Güvenlik bulgusu 3: silinen kaynak dosyanın files kaydını düşürür
   * (envanter mutabakatı). Dönüş: kayıt vardı ve silindi → true; kayıt
   * yok → false (idempotent). Graph tam türetildiğinden ghost kayıt kenar
   * üretmez; ama files/fingerprint metadata'sı bayat kalırdı (TŞ §9 files
   * tablosu = güncel envanter karşılığı).
   */
  deleteFile(workspaceId: string, relativePath: string): boolean;

  beginBuild(input: SnapshotBuildInput): SnapshotBuildInfo;
  getBuild(buildId: string): SnapshotBuildInfo | undefined;
  addNode(buildId: string, node: GraphNode): void;
  addEdge(buildId: string, edge: GraphEdge): void;
  addEvidence(buildId: string, evidence: Evidence): void;
  publish(
    buildId: string,
    state: PublishableState,
    publishedAt: string,
  ): SnapshotGraph;
  failBuild(buildId: string, reason: string): void;

  /** Yalnızca yayımlanmış (ready/partial) snapshot ID ile sorgulanır. */
  getSnapshot(snapshotId: string): SnapshotRead | undefined;
  /** Varsayılan sorgu yolu: en son kullanılabilir snapshot (TŞ §9). */
  getLatestPublished(workspaceId: string): SnapshotRead | undefined;
  /**
   * Opsiyonel toplu yazma işlemi sarmalayıcısı (SQLite transaction): binlerce
   * node/edge/evidence/file yazımını tek atomik commit'te yürütür.
   */
  runInTransaction?<T>(fn: () => T): T;
}

/**
 * Sembol arama yeteneği: yalnızca SQLite gerçeklemesi (FTS5) sunar;
 * bellek içi gerçekleme bu arayüzü uygulamaz (Faz A kapsamı).
 */
export interface SymbolSearchStore {
  /**
   * `snapshotId` yayımlanmış snapshot ID'si ya da aktif build kimliği
   * olabilir; arama yalnızca yayımlanmış satırları döndürür.
   */
  indexSymbols(snapshotId: string, entries: readonly SymbolIndexEntry[]): void;
  searchSymbols(
    query: string,
    limit?: number,
    snapshotId?: string,
  ): readonly SymbolSearchHit[];
}
