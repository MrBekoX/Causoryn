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
          `Cannot write a non-finite number to snapshot JSON: ${String(value)}`,
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
        // `out[key] = value` yerine defineProperty: `key === "__proto__"`
        // olduğunda normal atama Object.prototype'ın inherited setter'ına
        // gider ve own anahtar sessizce düşer (veri kaybı). defineProperty
        // setter çağırmaz; anahtar adı ne olursa olsun own data property
        // olarak yazılır.
        Object.defineProperty(out, key, {
          configurable: true,
          enumerable: true,
          value: asJsonValue(child),
          writable: true,
        });
      }
      return out;
    }
    default:
      throw new DomainError(
        "domain/non-json-value",
        `Value cannot be serialized to snapshot JSON: ${typeof value}`,
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

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_IV: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Zero-giant-allocation streaming FIPS 180-4 SHA-256 hasher.
 * Keeps peak hashing memory at 64 bytes (+ reusable 256-byte schedule) so large
 * snapshots never construct monolithic canonical JSON strings or byte buffers.
 */
class StreamingSha256 {
  private readonly state = new Uint32Array(SHA256_IV);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private readonly schedule = new Uint32Array(64);
  private blockOffset = 0;
  private totalBytes = 0;

  private pushByte(byte: number): void {
    this.block[this.blockOffset] = byte;
    this.blockOffset += 1;
    this.totalBytes += 1;
    if (this.blockOffset === 64) {
      this.compress();
      this.blockOffset = 0;
    }
  }

  updateUtf8(text: string): void {
    const len = text.length;
    for (let i = 0; i < len; i += 1) {
      let codePoint = text.charCodeAt(i);
      if (codePoint < 0x80) {
        this.pushByte(codePoint);
        continue;
      }
      if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < len) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          i += 1;
        }
      }
      if (codePoint < 0x800) {
        this.pushByte(0xc0 | (codePoint >> 6));
        this.pushByte(0x80 | (codePoint & 0x3f));
      } else if (codePoint < 0x10000) {
        this.pushByte(0xe0 | (codePoint >> 12));
        this.pushByte(0x80 | ((codePoint >> 6) & 0x3f));
        this.pushByte(0x80 | (codePoint & 0x3f));
      } else {
        this.pushByte(0xf0 | (codePoint >> 18));
        this.pushByte(0x80 | ((codePoint >> 12) & 0x3f));
        this.pushByte(0x80 | ((codePoint >> 6) & 0x3f));
        this.pushByte(0x80 | (codePoint & 0x3f));
      }
    }
  }

  private compress(): void {
    const w = this.schedule;
    const view = this.blockView;
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }

    const st = this.state;
    let a = st[0] as number;
    let b = st[1] as number;
    let c = st[2] as number;
    let d = st[3] as number;
    let e = st[4] as number;
    let f = st[5] as number;
    let g = st[6] as number;
    let h = st[7] as number;

    for (let t = 0; t < 64; t += 1) {
      const bigSigma1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + (SHA256_K[t] as number) + (w[t] as number)) >>> 0;
      const bigSigma0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    st[0] = ((st[0] as number) + a) >>> 0;
    st[1] = ((st[1] as number) + b) >>> 0;
    st[2] = ((st[2] as number) + c) >>> 0;
    st[3] = ((st[3] as number) + d) >>> 0;
    st[4] = ((st[4] as number) + e) >>> 0;
    st[5] = ((st[5] as number) + f) >>> 0;
    st[6] = ((st[6] as number) + g) >>> 0;
    st[7] = ((st[7] as number) + h) >>> 0;
  }

  digestHex(): string {
    const finalBytes = this.totalBytes;
    this.pushByte(0x80);
    while (this.blockOffset !== 56) {
      this.pushByte(0);
    }
    const highBits = Math.floor(finalBytes / 0x2000_0000) >>> 0;
    const lowBits = ((finalBytes & 0x1fff_ffff) * 8) >>> 0;
    this.blockView.setUint32(56, highBits, false);
    this.blockView.setUint32(60, lowBits, false);
    this.compress();
    this.blockOffset = 0;

    let hex = "";
    for (let i = 0; i < 8; i += 1) {
      hex += (this.state[i] as number).toString(16).padStart(8, "0");
    }
    return hex;
  }
}

function nodeJsonValue(node: GraphNode): JsonValue {
  return {
    id: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(node.location === undefined
      ? {}
      : { location: spanJsonValue(node.location) }),
    attributes: asJsonValue(node.attributes),
  };
}

function edgeJsonValue(edge: GraphEdge): JsonValue {
  return {
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
  };
}

function evidenceItemJsonValue(item: Evidence): JsonValue {
  return {
    id: item.id,
    kind: item.kind,
    ...(item.span === undefined ? {} : { span: spanJsonValue(item.span) }),
    analyzerId: item.analyzerId,
    analyzerVersion: item.analyzerVersion,
    rationale: item.rationale,
  };
}

function nodesJsonValue(nodes: readonly GraphNode[]): JsonValue {
  return nodes.map(nodeJsonValue);
}

function edgesJsonValue(edges: readonly GraphEdge[]): JsonValue {
  return edges.map(edgeJsonValue);
}

function evidenceJsonValue(evidence: readonly Evidence[]): JsonValue {
  return evidence.map(evidenceItemJsonValue);
}

/**
 * Streams canonical JSON bytes of sorted edges, evidence, and nodes directly into
 * an incremental SHA-256 hasher (one record at a time). Produces the exact bit-for-bit
 * digest of `canonicalJson({ edges, evidence, nodes })` without allocating a giant string.
 */
export function computeStreamingContentHash(
  sortedNodes: readonly GraphNode[],
  sortedEdges: readonly GraphEdge[],
  sortedEvidence: readonly Evidence[],
): string {
  const hasher = new StreamingSha256();
  hasher.updateUtf8('{"edges":[');
  for (let i = 0; i < sortedEdges.length; i += 1) {
    if (i > 0) hasher.updateUtf8(",");
    hasher.updateUtf8(canonicalJson(edgeJsonValue(sortedEdges[i]!)));
  }
  hasher.updateUtf8('],"evidence":[');
  for (let i = 0; i < sortedEvidence.length; i += 1) {
    if (i > 0) hasher.updateUtf8(",");
    hasher.updateUtf8(canonicalJson(evidenceItemJsonValue(sortedEvidence[i]!)));
  }
  hasher.updateUtf8('],"nodes":[');
  for (let i = 0; i < sortedNodes.length; i += 1) {
    if (i > 0) hasher.updateUtf8(",");
    hasher.updateUtf8(canonicalJson(nodeJsonValue(sortedNodes[i]!)));
  }
  hasher.updateUtf8("]}");
  return hasher.digestHex();
}

/** Computes the deterministic `snapshot:<64-hex>` ID via streaming SHA-256. */
export function computeStreamingSnapshotId(input: {
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly sortedNodes: readonly GraphNode[];
  readonly sortedEdges: readonly GraphEdge[];
  readonly sortedEvidence: readonly Evidence[];
}): string {
  const contentHash = computeStreamingContentHash(
    input.sortedNodes,
    input.sortedEdges,
    input.sortedEvidence,
  );
  return `snapshot:${sha256Hex(
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
        `Duplicate node id: ${key}`,
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
        `Edge endpoint points to an unknown node (${missing}): ${nodeKey(ref)}`,
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
        `Duplicate edge id: ${edge.id}`,
      );
    }
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }

  // 4) Kanonik düzen (invariant iv): ID'ye göre artan sıralama.
  const sortedNodes = [...nodesByKey.values()].sort(byId);
  const sortedEdges = [...edges].sort(byId);
  const sortedEvidence = [...evidenceById.values()].sort(byId);

  // 5) Deterministik ID: akışlı SHA-256 içerik karması + deterministik girdiler.
  //    `createdAt` ve `state` bilinçli olarak DIŞARIDA bırakılır; monolitik
  //    string tahsisi yapılmaz.
  const snapshotId = computeStreamingSnapshotId({
    workspaceId: input.workspaceId,
    revision: input.revision,
    configHash: input.configHash,
    analyzerFingerprint: input.analyzerFingerprint,
    sortedNodes,
    sortedEdges,
    sortedEvidence,
  });

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
      `Snapshot invariant violation: ${detail}`,
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
