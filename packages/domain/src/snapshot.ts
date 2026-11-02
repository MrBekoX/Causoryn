import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import { SnapshotSchema } from "./graph-schema.js";
import type {
  Evidence,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  RevisionRef,
  SourceSpan,
} from "./graph-types.js";
import type { EdgeKind, NodeKind, Resolution } from "./graph-kinds.js";
import { createEdge, evidenceId, nodeId } from "./ids.js";
import { sha256Hex } from "./sha256.js";
import { utf8Encode } from "./utf8.js";

/**
 * Değişmez GraphSnapshot inşası — TŞ v2.1 §8 invariant (ii), (iv), (v), (vi)
 * ve sprint-1 görev 3 kompoziti.
 *
 * Tasarım kararları:
 * - Domain katmanı SAAT OKUMAZ: `createdAt` kurucuya zorunlu girdidir ve
 *   yalnızca meta'da taşınır. Snapshot ID'si tamamen deterministik
 *   girdilerden türetilir; `createdAt` ve `state` ID'ye KATILMAZ.
 * - Snapshot ID = "snapshot:" + SHA-256( canonical JSON([workspaceId,
 *   revision.id, revision.sequence, configHash, analyzerFingerprint,
 *   contentHash]) ); contentHash, node/edge/evidence kümelerinin canonical
 *   JSON karmasıdır. Karma, FIPS vektörleriyle kanıtlanmış paket içi
 *   sha256Hex üzerinden üretilir (bkz. sha256.ts başlığı).
 * - Kurucu, dangling edge'i (invariant ii) kenar uçlarını node kimlik
 *   haritasında çözerken engeller; SnapshotSchema.superRefine ayrıca
 *   bütün snapshot üzerinde savunma katmanı olarak çalışır.
 * - Sonuç derin dondurulur (ADR-005); diziler ID'ye göre kanonik düzende
 *   tutulur (invariant iv) — böylece aynı girdi her zaman aynı Graph JSON
 *   üretir (invariant vi).
 */

/** Node kimlik referansı: kurucuya ham (ID'siz) node kimliği. */
export interface NodeRef {
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly relativePath?: string;
}

/** Snapshot'a eklenecek node tanımı (TŞ §8 GraphNode, ID'siz). */
export interface SnapshotNodeInput extends NodeRef {
  readonly language?: string;
  readonly location?: SourceSpan;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Snapshot'a eklenecek kanıt tanımı (TŞ §8 Evidence, ID'siz). */
export interface SnapshotEvidenceInput {
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}

/** Snapshot'a eklenecek kenar tanımı; uçlar NodeRef ile çözülür. */
export interface SnapshotEdgeInput {
  readonly kind: EdgeKind;
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly resolution: Resolution;
  readonly evidence?: readonly SnapshotEvidenceInput[];
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

/** createSnapshot girdisi. `createdAt` zorunludur: domain saat okumaz. */
export interface SnapshotInput {
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly state: GraphSnapshot["state"];
  readonly createdAt: string;
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence?: readonly SnapshotEvidenceInput[];
}

/**
 * Bütün snapshot içerik kümesi: TŞ §8 GraphSnapshot üst verisi (`meta`) +
 * node/edge/evidence dizileri. Sprint-1 görev 3 kompozitidir; `meta`
 * bire bir TŞ §8 GraphSnapshot arayüzüdür.
 */
export interface SnapshotGraph {
  readonly meta: GraphSnapshot;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly evidence: readonly Evidence[];
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function nodeKey(ref: NodeRef): string {
  return canonicalJson([ref.kind, ref.qualifiedName, ref.relativePath ?? null]);
}

function makeNode(workspaceId: string, input: SnapshotNodeInput): GraphNode {
  return {
    id: nodeId({
      workspaceId,
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(input.relativePath === undefined
        ? {}
        : { relativePath: input.relativePath }),
    }),
    kind: input.kind,
    qualifiedName: input.qualifiedName,
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.location === undefined
      ? {}
      : { location: { ...input.location } }),
    attributes: { ...(input.attributes ?? {}) },
  };
}

function makeEvidence(
  workspaceId: string,
  input: SnapshotEvidenceInput,
): Evidence {
  return {
    id: evidenceId({
      workspaceId,
      kind: input.kind,
      ...(input.span === undefined ? {} : { span: input.span }),
      analyzerId: input.analyzerId,
      analyzerVersion: input.analyzerVersion,
      rationale: input.rationale,
    }),
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: { ...input.span } }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  };
}

/**
 * Rastgele bir değeri JSON uyumlu kanonik temsile çevirir. JSON dışı
 * değerler (undefined, fonksiyon, sembol, bigint) sessiz düşürülmez;
 * determinizm ihlali olarak reddedilir.
 */
function asJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new DomainError(
          "domain/non-finite-number",
          `Snapshot JSON'e sonlu olmayan sayı yazılamaz: ${String(value)}`,
        );
      }
      return value;
    case "object": {
      if (Array.isArray(value)) {
        return value.map(asJsonValue);
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(record)) {
        out[key] = asJsonValue(child);
      }
      return out;
    }
    default:
      throw new DomainError(
        "domain/non-json-value",
        `Snapshot JSON'e serileştirilemez değer: ${typeof value}`,
      );
  }
}

function spanJsonValue(span: SourceSpan): JsonValue {
  return {
    relativePath: span.relativePath,
    startLine: span.startLine,
    endLine: span.endLine,
    sourceHash: span.sourceHash,
  };
}

function nodesJsonValue(nodes: readonly GraphNode[]): JsonValue {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(node.location === undefined
      ? {}
      : { location: spanJsonValue(node.location) }),
    attributes: asJsonValue(node.attributes),
  }));
}

function edgesJsonValue(edges: readonly GraphEdge[]): JsonValue {
  return edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    resolution: edge.resolution,
    evidenceIds: [...edge.evidenceIds],
    ...(edge.ambiguity === undefined
      ? {}
      : {
          ambiguity: {
            candidates: [...edge.ambiguity.candidates],
            reason: edge.ambiguity.reason,
          },
        }),
  }));
}

function evidenceJsonValue(evidence: readonly Evidence[]): JsonValue {
  return evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.span === undefined ? {} : { span: spanJsonValue(item.span) }),
    analyzerId: item.analyzerId,
    analyzerVersion: item.analyzerVersion,
    rationale: item.rationale,
  }));
}

function metaJsonValue(meta: GraphSnapshot): JsonValue {
  return {
    id: meta.id,
    workspaceId: meta.workspaceId,
    revision: {
      id: meta.revision.id,
      sequence: meta.revision.sequence,
    },
    configHash: meta.configHash,
    analyzerFingerprint: meta.analyzerFingerprint,
    state: meta.state,
    createdAt: meta.createdAt,
  };
}

/** Snapshot'ın meta + içerik kümelerinin kanonik JSON'u (invariant vi). */
export function snapshotCanonicalJson(snapshot: SnapshotGraph): string {
  return canonicalJson({
    meta: metaJsonValue(snapshot.meta),
    nodes: nodesJsonValue(snapshot.nodes),
    edges: edgesJsonValue(snapshot.edges),
    evidence: evidenceJsonValue(snapshot.evidence),
  });
}

function graphContentJsonValue(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  evidence: readonly Evidence[],
): JsonValue {
  return {
    nodes: nodesJsonValue(nodes),
    edges: edgesJsonValue(edges),
    evidence: evidenceJsonValue(evidence),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Snapshot'ı deterministik olarak inşa eder: ID'leri üretir, dangling
 * edge'i ve duplicate kimlikleri engeller, kanonik düzende sıralar,
 * invariant'ları snapshot şemasıyla yeniden doğrular ve derin dondurulmuş
 * bir sonuç döner.
 */
export function createSnapshot(input: SnapshotInput): SnapshotGraph {
  // 1) Node'lar: kimlik anahtarı → node haritası (duplicate reddedilir).
  const nodesByKey = new Map<string, GraphNode>();
  for (const nodeInput of input.nodes) {
    const key = nodeKey(nodeInput);
    if (nodesByKey.has(key)) {
      throw new DomainError(
        "domain/duplicate-node",
        `Aynı kimlikte birden fazla node: ${key}`,
      );
    }
    nodesByKey.set(key, makeNode(input.workspaceId, nodeInput));
  }

  // 2) Bağımsız kanıt kayıtları: aynı içerik → aynı ID → sessiz dedup.
  const evidenceById = new Map<string, Evidence>();
  for (const evidenceInput of input.evidence ?? []) {
    const evidence = makeEvidence(input.workspaceId, evidenceInput);
    evidenceById.set(evidence.id, evidence);
  }

  // 3) Kenarlar: uçlar node haritasında çözülür — dangling kurucu düzeyde
  //    engellenir (invariant ii); verified kanıt şartı createEdge'dedir
  //    (invariant i).
  const edges: GraphEdge[] = [];
  const seenEdgeIds = new Set<string>();
  for (const edgeInput of input.edges) {
    const from = nodesByKey.get(nodeKey(edgeInput.from));
    const to = nodesByKey.get(nodeKey(edgeInput.to));
    if (from === undefined || to === undefined) {
      const missing = from === undefined ? "from" : "to";
      const ref = from === undefined ? edgeInput.from : edgeInput.to;
      throw new DomainError(
        "domain/dangling-edge",
        `Kenar ucu bilinmeyen node'a işaret ediyor (${missing}): ${nodeKey(ref)}`,
      );
    }
    const evidenceIds: string[] = [];
    for (const evidenceInput of edgeInput.evidence ?? []) {
      const evidence = makeEvidence(input.workspaceId, evidenceInput);
      evidenceById.set(evidence.id, evidence);
      evidenceIds.push(evidence.id);
    }
    const edge = createEdge({
      workspaceId: input.workspaceId,
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
    if (seenEdgeIds.has(edge.id)) {
      throw new DomainError(
        "domain/duplicate-edge",
        `Aynı kimlikte birden fazla edge: ${edge.id}`,
      );
    }
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }

  // 4) Kanonik düzen (invariant iv): ID'ye göre artan sıralama.
  const sortedNodes = [...nodesByKey.values()].sort(byId);
  const sortedEdges = [...edges].sort(byId);
  const sortedEvidence = [...evidenceById.values()].sort(byId);

  // 5) Deterministik ID: içerik karması + deterministik girdiler.
  //    `createdAt` ve `state` bilinçli olarak DIŞARIDA bırakılır.
  const contentHash = sha256Hex(
    utf8Encode(
      canonicalJson(
        graphContentJsonValue(sortedNodes, sortedEdges, sortedEvidence),
      ),
    ),
  );
  const snapshotId = `snapshot:${sha256Hex(
    utf8Encode(
      canonicalJson([
        input.workspaceId,
        input.revision.id,
        input.revision.sequence,
        input.configHash,
        input.analyzerFingerprint,
        contentHash,
      ]),
    ),
  )}`;

  const meta: GraphSnapshot = {
    id: snapshotId,
    workspaceId: input.workspaceId,
    revision: { id: input.revision.id, sequence: input.revision.sequence },
    configHash: input.configHash,
    analyzerFingerprint: input.analyzerFingerprint,
    state: input.state,
    createdAt: input.createdAt,
  };

  // 6) Savunma katmanı: snapshot düzeyi refine (dangling/duplicate/
  //    verified-kanıt kurucuda zaten engellendi; şema kalıcı depodan
  //    gelecek veri için de aynı invariant'ı kodlar).
  const parsed = SnapshotSchema.safeParse({
    meta,
    nodes: sortedNodes,
    edges: sortedEdges,
    evidence: sortedEvidence,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new DomainError(
      "domain/snapshot-invariant-violation",
      `Snapshot invariant ihlali: ${detail}`,
    );
  }

  // 7) Değişmez sonuç (ADR-005): tüm nesne grafiği dondurulur.
  return deepFreeze({
    meta,
    nodes: sortedNodes,
    edges: sortedEdges,
    evidence: sortedEvidence,
  });
}
