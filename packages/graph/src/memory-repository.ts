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
  PublishableState,
  SnapshotBuildInfo,
  SnapshotBuildInput,
  SnapshotRead,
  WorkspaceRecord,
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

export class InMemoryGraphRepository implements GraphRepository {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly files = new Map<string, FileRecord>();
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
        `Workspace zaten kayıtlı: ${record.id}`,
      );
    }
    this.workspaces.set(record.id, { ...record });
  }

  upsertFile(record: FileRecord): void {
    if (!this.workspaces.has(record.workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Bilinmeyen workspace: ${record.workspaceId}`,
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
        `file.sizeBytes negatif olmayan tam sayı olmalı: ${String(record.sizeBytes)}`,
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
        `Bilinmeyen workspace: ${workspaceId}`,
      );
    }
    const records: FileRecord[] = [];
    for (const record of this.files.values()) {
      if (record.workspaceId === workspaceId) records.push(record);
    }
    records.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return records;
  }

  beginBuild(input: SnapshotBuildInput): SnapshotBuildInfo {
    if (!this.workspaces.has(input.workspaceId)) {
      throw new GraphRepositoryError(
        "graph/unknown-workspace",
        `Bilinmeyen workspace: ${input.workspaceId}`,
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
          `Aynı revizyon için aktif build var: ${input.workspaceId}#${input.revision.id}@${input.revision.sequence}`,
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
        `Aynı node kimliği build içinde zaten var: ${node.id}`,
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
          `Kenar ucu bilinmeyen node'a işaret ediyor (${missing}): ${endpoint}`,
        );
      }
    }
    validateEdgeIdentity(build.input.workspaceId, edge);
    if (build.edges.has(edge.id)) {
      throw new GraphRepositoryError(
        "graph/duplicate-edge",
        `Aynı edge kimliği build içinde zaten var: ${edge.id}`,
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

  private requireActiveBuild(buildId: string): MemoryBuild {
    const build = this.builds.get(buildId);
    if (build === undefined || build.state !== "building") {
      throw new GraphRepositoryError(
        "graph/build-not-active",
        `Aktif build yok: ${buildId}`,
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
