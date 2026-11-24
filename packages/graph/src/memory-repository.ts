import type {
  Evidence,
  GraphEdge,
  GraphNode,
  SnapshotGraph,
} from "@causoryn/domain";

import { deriveBuildId } from "./build-id.js";
import { GraphRepositoryError } from "./errors.js";
import { finalizeSnapshotGraph, type SnapshotMetaInput } from "./finalize.js";
import type {
  FileRecord,
  GraphRepository,
  PruneSnapshotsResult,
  PublishableState,
  SnapshotBuildInfo,
  SnapshotBuildInput,
  SnapshotMetaSummary,
  SnapshotRead,
  WorkspaceLanguageCoverageMeta,
  WorkspaceRecord,
  WorkspaceSummaryMeta,
} from "./repository.js";
import {
  requireNonEmptyField,
  requireTimestamp,
  validateEdgeIdentity,
  validateEdgeShape,
  validateEvidence,
  validateNode,
} from "./validation.js";

/**
 * Bellek içi GraphRepository — GraphRepository sözleşmesinin referans
 * gerçeklemesi (TŞ v2.1 §8/§9, ADR-005; sprint-1 görev 5).
 *
 * Atomik yayımlama: building içerik ayrı `MemoryBuild` kaydında tutulur ve
 * hiçbir okuma yoluna sızmaz; `publish` tek adımda (a) domain
 * `createSnapshot` ile invariant denetimi yapar, (b) dondurulmuş
 * SnapshotGraph'ı yayın haritasına ekler. Denetim başarısızsa harita
 * değişmez ve build `building` kalır — yarım snapshot asla görünmez.
 *
 * stale semantiği (TŞ §9): bir yayın, (1) ondan daha yeni yayın varsa ya da
 * (2) aynı veya daha yeni revizyon sırası için aktif bir `building` varsa
 * stale=true döner. `failed` build mevcut yayını stale yapmaz.
 */

interface MemoryBuild {
  readonly buildId: string;
  readonly input: SnapshotBuildInput;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly evidence: Map<string, Evidence>;
  state: "building" | "failed";
  failureReason?: string;
}

interface PublishedEntry {
  readonly graph: SnapshotGraph;
  readonly publishedAt: string;
  readonly serial: number;
}

function fileKey(workspaceId: string, relativePath: string): string {
  return `${workspaceId}\u0000${relativePath}`;
}

function tupleOf(entry: PublishedEntry): readonly [number, string, number] {
  return [
    entry.graph.meta.revision.sequence,
    entry.publishedAt,
    entry.serial,
  ];
}

function isNewer(candidate: PublishedEntry, than: PublishedEntry): boolean {
  const a = tupleOf(candidate);
  const b = tupleOf(than);
  if (a[0] !== b[0]) return a[0] > (b[0] as number);
  if (a[1] !== b[1]) return a[1] > (b[1] as string);
  return a[2] > (b[2] as number);
}

interface MemoryFileFactRecord {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly analyzerFingerprint: string;
  readonly language: string;
  readonly publicInterfaceHash: string;
  readonly nodesJson: string;
  readonly edgesJson: string;
  readonly evidenceJson: string;
  readonly importedPathsJson: string;
  readonly updatedAt: string;
}

export class InMemoryGraphRepository implements GraphRepository {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly files = new Map<string, FileRecord>();
  private readonly fileFacts = new Map<string, MemoryFileFactRecord>();
  private readonly builds = new Map<string, MemoryBuild>();
  private readonly published = new Map<string, PublishedEntry>();
  private buildSerial = 0;
  private publishSerial = 0;

  registerWorkspace(record: WorkspaceRecord): void {
    requireNonEmptyField("workspace.id", record.id);
    requireNonEmptyField("workspace.rootPath", record.rootPath);
    requireTimestamp("workspace.createdAt", record.createdAt);
    if (this.workspaces.has(record.id)) {
      throw new GraphRepositoryError(
        "graph/duplicate-workspace",
        `Workspace is already registered: ${record.id}`,
      );
    }
    this.workspaces.set(record.id, { ...record });
  }

  upsertFile(record: FileRecord): void {
    if (!this.workspaces.has(record.workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${record.workspaceId}`,
      );
    }
    requireNonEmptyField("file.relativePath", record.relativePath);
    requireNonEmptyField("file.contentHash", record.contentHash);
    requireTimestamp("file.updatedAt", record.updatedAt);
    if (
      typeof record.sizeBytes !== "number" ||
      !Number.isInteger(record.sizeBytes) ||
      record.sizeBytes < 0
    ) {
      throw new GraphRepositoryError(
        "graph/invalid-file-size",
        `file.sizeBytes must be a non-negative integer: ${String(record.sizeBytes)}`,
      );
    }
    this.files.set(fileKey(record.workspaceId, record.relativePath), {
      ...record,
    });
  }

  listFiles(workspaceId: string): readonly FileRecord[] {
    if (!this.workspaces.has(workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${workspaceId}`,
      );
    }
    const records: FileRecord[] = [];
    for (const record of this.files.values()) {
      if (record.workspaceId === workspaceId) records.push(record);
    }
    records.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return records;
  }

  /** Güvenlik bulgusu 3: envanter mutabakatı için kayıt düşürme. */
  deleteFile(workspaceId: string, relativePath: string): boolean {
    if (!this.workspaces.has(workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${workspaceId}`,
      );
    }
    requireNonEmptyField("file.relativePath", relativePath);
    return this.files.delete(fileKey(workspaceId, relativePath));
  }

  beginBuild(input: SnapshotBuildInput): SnapshotBuildInfo {
    if (!this.workspaces.has(input.workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${input.workspaceId}`,
      );
    }
    requireNonEmptyField("build.revision.id", input.revision.id);
    requireTimestamp("build.createdAt", input.createdAt);
    for (const build of this.builds.values()) {
      if (
        build.state === "building" &&
        build.input.workspaceId === input.workspaceId &&
        build.input.revision.id === input.revision.id &&
        build.input.revision.sequence === input.revision.sequence
      ) {
        throw new GraphRepositoryError(
          "graph/build-already-active",
          `An active build already exists for this revision: ${input.workspaceId}#${input.revision.id}@${input.revision.sequence}`,
        );
      }
    }
    this.buildSerial += 1;
    const buildId = deriveBuildId(input, this.buildSerial);
    const build: MemoryBuild = {
      buildId,
      input: { ...input, revision: { ...input.revision } },
      nodes: new Map(),
      edges: new Map(),
      evidence: new Map(),
      state: "building",
    };
    this.builds.set(buildId, build);
    return this.buildInfo(build);
  }

  getBuild(buildId: string): SnapshotBuildInfo | undefined {
    const build = this.builds.get(buildId);
    return build === undefined ? undefined : this.buildInfo(build);
  }

  addNode(buildId: string, node: GraphNode): void {
    const build = this.requireActiveBuild(buildId);
    validateNode(build.input.workspaceId, node);
    if (build.nodes.has(node.id)) {
      throw new GraphRepositoryError(
        "graph/duplicate-node",
        `Node id already exists in this build: ${node.id}`,
      );
    }
    build.nodes.set(node.id, node);
  }

  addEvidence(buildId: string, evidence: Evidence): void {
    const build = this.requireActiveBuild(buildId);
    validateEvidence(build.input.workspaceId, evidence);
    // Aynı kimlik aynı içerikten türediği için sessiz dedup güvenlidir.
    build.evidence.set(evidence.id, evidence);
  }

  addEdge(buildId: string, edge: GraphEdge): void {
    const build = this.requireActiveBuild(buildId);
    validateEdgeShape(edge);
    for (const endpoint of [edge.from, edge.to]) {
      if (!build.nodes.has(endpoint)) {
        const missing = endpoint === edge.from ? "from" : "to";
        throw new GraphRepositoryError(
          "graph/dangling-edge",
          `Edge endpoint points to an unknown node (${missing}): ${endpoint}`,
        );
      }
    }
    validateEdgeIdentity(build.input.workspaceId, edge);
    if (build.edges.has(edge.id)) {
      throw new GraphRepositoryError(
        "graph/duplicate-edge",
        `Edge id already exists in this build: ${edge.id}`,
      );
    }
    build.edges.set(edge.id, edge);
  }

  publish(
    buildId: string,
    state: PublishableState,
    publishedAt: string,
  ): SnapshotGraph {
    const build = this.requireActiveBuild(buildId);
    requireTimestamp("publishedAt", publishedAt);
    const meta: SnapshotMetaInput = {
      workspaceId: build.input.workspaceId,
      revision: { ...build.input.revision },
      configHash: build.input.configHash,
      analyzerFingerprint: build.input.analyzerFingerprint,
      createdAt: build.input.createdAt,
      state,
    };
    // İnvariant denetimi + deterministik ID + derin dondurma; hata durumunda
    // yayın haritasına hiçbir şey yazılmaz, build `building` kalır.
    const graph = finalizeSnapshotGraph(meta, {
      nodes: [...build.nodes.values()],
      edges: [...build.edges.values()],
      evidence: [...build.evidence.values()],
    });
    this.publishSerial += 1;
    this.published.set(graph.meta.id, {
      graph,
      publishedAt,
      serial: this.publishSerial,
    });
    this.builds.delete(buildId);
    return graph;
  }

  failBuild(buildId: string, reason: string): void {
    requireNonEmptyField("reason", reason);
    const build = this.requireActiveBuild(buildId);
    build.state = "failed";
    build.failureReason = reason;
  }

  getSnapshot(snapshotId: string): SnapshotRead | undefined {
    const entry = this.published.get(snapshotId);
    if (entry === undefined) return undefined;
    return { snapshot: entry.graph, stale: this.isStale(entry) };
  }

  getLatestPublished(workspaceId: string): SnapshotRead | undefined {
    let latest: PublishedEntry | undefined;
    for (const entry of this.published.values()) {
      if (entry.graph.meta.workspaceId !== workspaceId) continue;
      if (latest === undefined || isNewer(entry, latest)) latest = entry;
    }
    if (latest === undefined) return undefined;
    return { snapshot: latest.graph, stale: this.isStale(latest) };
  }

  getLatestSnapshotMeta(workspaceId: string): SnapshotMetaSummary | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    let latest: PublishedEntry | undefined;
    for (const entry of this.published.values()) {
      if (entry.graph.meta.workspaceId !== workspaceId) continue;
      if (latest === undefined || isNewer(entry, latest)) latest = entry;
    }
    if (latest === undefined) return undefined;
    const state = latest.graph.meta.state;
    if (state !== "ready" && state !== "partial") return undefined;
    return {
      snapshotId: latest.graph.meta.id,
      workspaceId: latest.graph.meta.workspaceId,
      state,
      revisionId: latest.graph.meta.revision.id,
      revisionSequence: latest.graph.meta.revision.sequence,
      configHash: latest.graph.meta.configHash,
      analyzerFingerprint: latest.graph.meta.analyzerFingerprint,
      createdAt: latest.graph.meta.createdAt,
      publishedAt: latest.publishedAt,
      nodeCount: latest.graph.nodes.length,
      edgeCount: latest.graph.edges.length,
      evidenceCount: latest.graph.evidence.length,
      stale: this.isStale(latest),
    };
  }

  getLatestWorkspaceSummaryMeta(workspaceId: string): WorkspaceSummaryMeta | undefined {
    requireNonEmptyField("workspaceId", workspaceId);
    let latest: PublishedEntry | undefined;
    for (const entry of this.published.values()) {
      if (entry.graph.meta.workspaceId !== workspaceId) continue;
      if (latest === undefined || isNewer(entry, latest)) latest = entry;
    }
    if (latest === undefined) return undefined;
    const state = latest.graph.meta.state;
    if (state !== "ready" && state !== "partial") return undefined;

    const snapshot = latest.graph;
    let fileCount = 0;
    const entrypoints: string[] = [];
    const frameworkSet = new Set<string>();
    const nodeById = new Map<string, GraphNode>();

    interface MutableLangCoverage {
      files: number;
      hasNonFileSymbols: boolean;
      hasSemanticEdges: boolean;
      verifiedEdges: number;
      heuristicEdges: number;
      unresolvedEdges: number;
    }
    const langBuckets = new Map<string, MutableLangCoverage>();
    const ensureLang = (lang: string): MutableLangCoverage => {
      let bucket = langBuckets.get(lang);
      if (bucket === undefined) {
        bucket = {
          files: 0,
          hasNonFileSymbols: false,
          hasSemanticEdges: false,
          verifiedEdges: 0,
          heuristicEdges: 0,
          unresolvedEdges: 0,
        };
        langBuckets.set(lang, bucket);
      }
      return bucket;
    };

    for (const node of snapshot.nodes) {
      nodeById.set(node.id, node);
      if (node.kind === "File") {
        fileCount += 1;
      }
      if (node.kind === "Endpoint" || node.kind === "Handler") {
        entrypoints.push(node.qualifiedName);
        if (node.kind === "Endpoint" && typeof node.attributes.framework === "string") {
          frameworkSet.add(node.attributes.framework);
        }
      }
      if (typeof node.language === "string" && node.language.length > 0) {
        const bucket = ensureLang(node.language);
        if (node.kind === "File") {
          bucket.files += 1;
        } else if (node.kind !== "Workspace" && node.kind !== "UnknownExternal") {
          bucket.hasNonFileSymbols = true;
        }
      }
    }

    const edgeKindCounts = new Map<string, number>();
    let verified = 0;
    let heuristic = 0;
    let unresolved = 0;

    for (const edge of snapshot.edges) {
      edgeKindCounts.set(edge.kind, (edgeKindCounts.get(edge.kind) ?? 0) + 1);
      if (edge.resolution === "verified") {
        verified += 1;
      } else if (edge.resolution === "heuristic") {
        heuristic += 1;
      } else {
        unresolved += 1;
      }

      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (fromNode?.kind === "Workspace" && edge.kind === "CONTAINS") {
        continue;
      }
      const lang =
        typeof fromNode?.language === "string" && fromNode.language.length > 0
          ? fromNode.language
          : typeof toNode?.language === "string" && toNode.language.length > 0
            ? toNode.language
            : undefined;
      if (lang === undefined) continue;
      const bucket = ensureLang(lang);
      if (edge.kind !== "CONTAINS") {
        bucket.hasSemanticEdges = true;
      }
      if (edge.resolution === "verified") {
        bucket.verifiedEdges += 1;
      } else if (edge.resolution === "heuristic") {
        bucket.heuristicEdges += 1;
      } else {
        bucket.unresolvedEdges += 1;
      }
    }

    entrypoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const frameworks = [...frameworkSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const sortedLangs = [...langBuckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const languages: Array<{ readonly language: string; readonly files: number }> = [];
    const languageCoverage: WorkspaceLanguageCoverageMeta[] = [];
    for (const lang of sortedLangs) {
      const bucket = langBuckets.get(lang)!;
      if (bucket.files > 0) {
        languages.push({ language: lang, files: bucket.files });
      }
      languageCoverage.push({
        language: lang,
        files: bucket.files,
        hasNonFileSymbols: bucket.hasNonFileSymbols,
        hasSemanticEdges: bucket.hasSemanticEdges,
        verifiedEdges: bucket.verifiedEdges,
        heuristicEdges: bucket.heuristicEdges,
        unresolvedEdges: bucket.unresolvedEdges,
      });
    }

    const edgesByKind: Record<string, number> = {};
    for (const kind of [...edgeKindCounts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      edgesByKind[kind] = edgeKindCounts.get(kind) ?? 0;
    }

    return {
      snapshotId: snapshot.meta.id,
      workspaceId: snapshot.meta.workspaceId,
      state,
      revisionId: snapshot.meta.revision.id,
      revisionSequence: snapshot.meta.revision.sequence,
      stale: this.isStale(latest),
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      evidenceCount: snapshot.evidence.length,
      fileCount,
      languages,
      frameworks,
      entrypoints,
      edgesByKind,
      resolutions: {
        verified,
        heuristic,
        unresolved,
      },
      languageCoverage,
    };
  }

  pruneOldSnapshots(
    workspaceId: string,
    keepCount = 2,
  ): PruneSnapshotsResult {
    requireNonEmptyField("workspaceId", workspaceId);
    if (!Number.isInteger(keepCount) || keepCount < 1) {
      throw new GraphRepositoryError(
        "graph/invalid-limit",
        `keepCount must be a positive integer: ${String(keepCount)}`,
      );
    }
    const workspacePublished: PublishedEntry[] = [];
    for (const entry of this.published.values()) {
      if (entry.graph.meta.workspaceId === workspaceId) {
        workspacePublished.push(entry);
      }
    }
    workspacePublished.sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));

    let prunedSnapshotSids = 0;
    for (let i = keepCount; i < workspacePublished.length; i += 1) {
      const target = workspacePublished[i]!;
      if (this.published.delete(target.graph.meta.id)) {
        prunedSnapshotSids += 1;
      }
    }

    const failedBuildIds: string[] = [];
    for (const build of this.builds.values()) {
      if (build.state === "failed" && build.input.workspaceId === workspaceId) {
        failedBuildIds.push(build.buildId);
      }
    }
    if (failedBuildIds.length > 2) {
      for (let i = 0; i < failedBuildIds.length - 2; i += 1) {
        if (this.builds.delete(failedBuildIds[i]!)) {
          prunedSnapshotSids += 1;
        }
      }
    }
    return { prunedSnapshotSids, prunedFtsRows: 0 };
  }

  upsertFileFact(record: MemoryFileFactRecord): void {
    if (!this.workspaces.has(record.workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${record.workspaceId}`,
      );
    }
    requireNonEmptyField("fileFact.relativePath", record.relativePath);
    requireNonEmptyField("fileFact.contentHash", record.contentHash);
    requireNonEmptyField("fileFact.analyzerFingerprint", record.analyzerFingerprint);
    requireNonEmptyField("fileFact.language", record.language);
    requireNonEmptyField("fileFact.publicInterfaceHash", record.publicInterfaceHash);
    requireTimestamp("fileFact.updatedAt", record.updatedAt);
    this.fileFacts.set(fileKey(record.workspaceId, record.relativePath), { ...record });
  }

  upsertFileFacts(records: readonly MemoryFileFactRecord[]): void {
    for (const record of records) {
      this.upsertFileFact(record);
    }
  }

  listFileFacts(
    workspaceId: string,
    analyzerFingerprint?: string,
  ): readonly MemoryFileFactRecord[] {
    if (!this.workspaces.has(workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${workspaceId}`,
      );
    }
    const out: MemoryFileFactRecord[] = [];
    for (const record of this.fileFacts.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (
        analyzerFingerprint !== undefined &&
        record.analyzerFingerprint !== analyzerFingerprint
      ) {
        continue;
      }
      out.push({ ...record });
    }
    out.sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );
    return out;
  }

  deleteFileFact(workspaceId: string, relativePath: string): boolean {
    if (!this.workspaces.has(workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${workspaceId}`,
      );
    }
    requireNonEmptyField("fileFact.relativePath", relativePath);
    return this.fileFacts.delete(fileKey(workspaceId, relativePath));
  }

  clearFileFacts(workspaceId: string): number {
    if (!this.workspaces.has(workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Unknown workspace: ${workspaceId}`,
      );
    }
    let deleted = 0;
    for (const [key, record] of this.fileFacts.entries()) {
      if (record.workspaceId === workspaceId) {
        this.fileFacts.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  private requireActiveBuild(buildId: string): MemoryBuild {
    const build = this.builds.get(buildId);
    if (build === undefined || build.state !== "building") {
      throw new GraphRepositoryError(
        "graph/build-not-active",
        `No active build: ${buildId}`,
      );
    }
    return build;
  }

  private buildInfo(build: MemoryBuild): SnapshotBuildInfo {
    return {
      buildId: build.buildId,
      workspaceId: build.input.workspaceId,
      revision: { ...build.input.revision },
      configHash: build.input.configHash,
      analyzerFingerprint: build.input.analyzerFingerprint,
      createdAt: build.input.createdAt,
      state: build.state,
      nodeCount: build.nodes.size,
      edgeCount: build.edges.size,
      evidenceCount: build.evidence.size,
      ...(build.failureReason === undefined
        ? {}
        : { failureReason: build.failureReason }),
    };
  }

  private isStale(entry: PublishedEntry): boolean {
    for (const other of this.published.values()) {
      if (
        other.graph.meta.id !== entry.graph.meta.id &&
        isNewer(other, entry)
      ) {
        return true;
      }
    }
    for (const build of this.builds.values()) {
      if (
        build.state === "building" &&
        build.input.workspaceId === entry.graph.meta.workspaceId &&
        build.input.revision.sequence >= entry.graph.meta.revision.sequence
      ) {
        return true;
      }
    }
    return false;
  }
}
