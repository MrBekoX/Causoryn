import {
  DomainError,
  canonicalJson,
  EDGE_KIND_SET,
  NODE_KIND_SET,
  RESOLUTION_SET,
  type EdgeKind,
  type JsonValue,
  type NodeKind,
  type Resolution,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";

/**
 * causoryn_compare_architecture saf çekirdeği (sprint-3 C3, TŞ v2.1 §13).
 *
 * Architecture Diff: iki kaynak içerik kümesi (base/target node+edge
 * kayıtları) → node eklenen/çıkarsan/değişen kümeleri + belgeli güven
 * (confidence) taşıyan yeniden adlandırma eşleşmeleri + API yüzeyi
 * (endpoint/contract) değişimleri. Bu modül SAFTIR: saat okumaz, dosya
 * okumaz, süreç başlatmaz; aynı girdi her zaman aynı JSON'u üretir.
 * Git okuma (cat-file/ls-tree, salt-okunur) `git-read.ts` spawn katmanındadır.
 *
 * TŞ §13 sözleşmesi (birincil metin): "Rename matching qualifiedName,
 * signature fingerprint, path similarity ile heuristic yapılır, confidence
 * belgelidir." Ref güvenliği ve working-tree referansı da §13'ün açık
 * gereklilikleridir; bunlar git-read.ts spawn katmanında uygulanır.
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu — aşağıdaki eşik ve
 * ağırlık SAYILARI TŞ'de sabitlenmemiştir; bu modül tarafından sabitlenir ve
 * testlerle kanıtlanır):
 * - Rename skorlama: taban ad + imza parmak izi + yol benzerliğinin
 *   ağırlıklı ortalaması (0.40/0.35/0.25). Bantlar: high ≥ 0.75,
 *   medium ≥ 0.55, low ≥ 0.30; 0.15–0.30 arası zayıf aday "renamed"
 *   İDDİA EDİLMEZ, `uncertain` olarak sınıflanır (partial davranış);
 *   < 0.15 bağımsız ekleme/çıkarma sayılır. Türü farklı node çiftleri hiç
 *   aday değildir.
 * - Konum (satır aralığı) karşılaştırmaya BİLİNÇLİ olarak dahil değildir:
 *   satır kayması mimari değişiklik değildir.
 * - API yüzeyi: Endpoint + sözleşme türleri (ApiContract, EventContract,
 *   SchemaContract, ContractVersion) — TŞ §11 sözleşme yüzeyiyle uyumlu.
 * - Sadece "low/medium/high" rename'ler edge uçlarını yeniden eşler
 *   (remap); `uncertain` çiftler bu varsayımı taşımaz.
 *
 * Hata kodları (GraphRepositoryError.code, MCP eşlemesi mcp-server'da):
 * - compare/unknown-node-kind, compare/unknown-edge-kind,
 *   compare/unknown-resolution: tür kataloğu dışı değer.
 * - compare/non-json-attribute: attributes canonical JSON'a çevrilemez.
 * - compare/empty-qualified-name: boş/boşluklu qualifiedName.
 * - compare/invalid-node-field: boş language/signature.
 * - compare/duplicate-node: aynı içerik kümesinde tekrar node kimliği.
 * - compare/duplicate-edge: aynı (kind,from,to) kimliğinde tekrar kenar
 *   (domain duplicate-edge invariant'ıyla uyumlu; aksi hâlde kova eşleşmesi
 *   girdi sırasına bağımlı kalıp determinizmi bozar).
 * - compare/dangling-edge: kenar ucu kümedeki node'a eşleşmiyor.
 */

/** Node kimliği — domain nodeId türetim dörtlüsünün workspaceId'siz hâli. */
export interface CompareNodeIdentity {
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly relativePath?: string;
}

/**
 * Diff girdisi node kaydı. `signature` adapter/çıkarım katmanının ürettiği
 * imza parmak izidir (ör. normalize edilmiş imza metni); kimliğe dahil
 * değildir, yalnızca değişiklik/rename sinyalidir. `attributes` canonical
 * JSON'a çevrilebilir değerler olmalıdır (çevrilemezse girdi reddedilir).
 */
export interface CompareNode extends CompareNodeIdentity {
  readonly language?: string;
  readonly signature?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Diff girdisi kenar kaydı; uçlar kimlikle (ID'siz) referanslanır. */
export interface CompareEdge {
  readonly kind: EdgeKind;
  readonly from: CompareNodeIdentity;
  readonly to: CompareNodeIdentity;
  readonly resolution: Resolution;
}

/** Bir revizyonun içerik kümesi (ör. bir ref'in analiz çıktısı). */
export interface CompareContentSet {
  readonly nodes: readonly CompareNode[];
  readonly edges: readonly CompareEdge[];
}

/**
 * API yüzeyine sayılan node türleri: uç noktalar ve sözleşme düğümleri
 * (TŞ §11 Architecture Contracts yüzeyi + §13 "API yüzeyi değişimleri").
 */
export const API_SURFACE_NODE_KINDS: readonly NodeKind[] = [
  "Endpoint",
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
];

const API_SURFACE_NODE_KIND_SET: ReadonlySet<string> = new Set(
  API_SURFACE_NODE_KINDS,
);

/** Rename güven bantları (belgeli eşikler — bkz. modül başlığı). */
const RENAME_THRESHOLD_HIGH = 0.75;
const RENAME_THRESHOLD_MEDIUM = 0.55;
const RENAME_THRESHOLD_LOW = 0.3;
const RENAME_THRESHOLD_UNCERTAIN = 0.15;

/** Ağırlıklı skor bileşenleri; toplam ağırlık 1.0'dır. */
const RENAME_WEIGHT_BASE_NAME = 0.4;
const RENAME_WEIGHT_SIGNATURE = 0.35;
const RENAME_WEIGHT_PATH = 0.25;

export type RenameConfidence = "high" | "medium" | "low";

/** Rename skor bileşenleri; null = o alan iki tarafta da yok (skora katılmaz). */
export interface RenameComponents {
  readonly baseName: number;
  readonly signature: number | null;
  readonly path: number | null;
}

/** Belgeli güven taşıyan yeniden adlandırma eşleşmesi. */
export interface RenameMatch {
  readonly from: CompareNodeIdentity;
  readonly to: CompareNodeIdentity;
  readonly confidence: RenameConfidence;
  readonly score: number;
  readonly components: RenameComponents;
  readonly reason: string;
}

/**
 * Rename eşiğinin altında kalan zayıf aday: ne rename iddia edilir ne de
 * çift sessizce added+removed'a dağıtılır (TŞ §13 — iddia üretilmez).
 */
export interface UncertainMatch {
  readonly from: CompareNodeIdentity;
  readonly to: CompareNodeIdentity;
  readonly score: number;
  readonly reason: string;
}

export interface NodeChange {
  readonly classification: "added" | "removed" | "changed";
  readonly node: CompareNodeIdentity;
  /** Yalnızca `changed`: değişen alanlar (ör. "signature", "signature+attributes"). */
  readonly changeType?: string;
  /** Yalnızca `changed` ve attributes değişimi varsa: sıralı değişen anahtarlar. */
  readonly changedAttributeKeys?: readonly string[];
}

export interface EdgeChange {
  readonly changeType: "added" | "removed" | "resolution-changed";
  readonly kind: EdgeKind;
  readonly from: CompareNodeIdentity;
  readonly to: CompareNodeIdentity;
  /** `removed` ve `resolution-changed` için taban tarafın çözünürlüğü. */
  readonly baseResolution?: Resolution;
  /** `added` ve `resolution-changed` için hedef tarafın çözünürlüğü. */
  readonly targetResolution?: Resolution;
}

export interface ArchitectureDiff {
  readonly added: readonly NodeChange[];
  readonly removed: readonly NodeChange[];
  readonly changed: readonly NodeChange[];
  readonly renamed: readonly RenameMatch[];
  readonly uncertain: readonly UncertainMatch[];
  readonly unchangedNodeCount: number;
  readonly edges: {
    readonly added: readonly EdgeChange[];
    readonly removed: readonly EdgeChange[];
    readonly changed: readonly EdgeChange[];
    readonly unchangedCount: number;
  };
  readonly apiSurface: {
    readonly added: readonly NodeChange[];
    readonly removed: readonly NodeChange[];
    readonly changed: readonly NodeChange[];
    readonly renamed: readonly RenameMatch[];
    readonly uncertain: readonly UncertainMatch[];
  };
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly renamed: number;
    readonly uncertain: number;
    readonly unchangedNodes: number;
    readonly edgeAdded: number;
    readonly edgeRemoved: number;
    readonly edgeChanged: number;
    readonly edgeUnchanged: number;
    readonly apiSurfaceChanges: number;
  };
}

/**
 * Node kimliğinin canonical anahtarı: [kind, qualifiedName, relativePath|null]
 * kanonik JSON'u. Eş zamanlı olarak kimlik doğrulamasını da yapar.
 */
export function compareIdentityKey(identity: CompareNodeIdentity): string {
  if (!NODE_KIND_SET.has(identity.kind)) {
    throw new GraphRepositoryError(
      "compare/unknown-node-kind",
      `Bilinmeyen node türü: ${String(identity.kind)}`,
    );
  }
  if (
    typeof identity.qualifiedName !== "string" ||
    identity.qualifiedName.trim().length === 0
  ) {
    throw new GraphRepositoryError(
      "compare/empty-qualified-name",
      `qualifiedName boş olamaz: ${String(identity.qualifiedName)}`,
    );
  }
  return canonicalJson([
    identity.kind,
    identity.qualifiedName,
    identity.relativePath ?? null,
  ]);
}

function identityOfNode(node: CompareNode): CompareNodeIdentity {
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
  };
}

function copyIdentity(identity: CompareNodeIdentity): CompareNodeIdentity {
  return {
    kind: identity.kind,
    qualifiedName: identity.qualifiedName,
    ...(identity.relativePath === undefined
      ? {}
      : { relativePath: identity.relativePath }),
  };
}

interface ValidatedNode {
  readonly key: string;
  readonly node: CompareNode;
  readonly identity: CompareNodeIdentity;
}

interface ValidatedSet {
  readonly nodesByKey: Map<string, ValidatedNode>;
  /** Sıralı kimlik anahtarları — deterministik yineleme düzeni. */
  readonly sortedKeys: readonly string[];
  readonly edges: readonly CompareEdge[];
}

/** İçerik kümesi sözleşme doğrulaması (bkz. modül başlığındaki hata kodları). */
function validateContentSet(set: CompareContentSet): ValidatedSet {
  const nodesByKey = new Map<string, ValidatedNode>();
  for (const node of set.nodes) {
    const key = compareIdentityKey(node);
    if (node.language !== undefined && node.language.trim().length === 0) {
      throw new GraphRepositoryError(
        "compare/invalid-node-field",
        `language boş olamaz: ${key}`,
      );
    }
    if (node.signature !== undefined && node.signature.trim().length === 0) {
      throw new GraphRepositoryError(
        "compare/invalid-node-field",
        `signature boş olamaz: ${key}`,
      );
    }
    try {
      canonicalJson((node.attributes ?? {}) as JsonValue);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new GraphRepositoryError(
          "compare/non-json-attribute",
          `attributes JSON'e serileştirilemiyor (${key}): ${error.message}`,
        );
      }
      throw error;
    }
    if (nodesByKey.has(key)) {
      throw new GraphRepositoryError(
        "compare/duplicate-node",
        `Aynı içerik kümesinde tekrarlanan node kimliği: ${key}`,
      );
    }
    nodesByKey.set(key, { key, node, identity: identityOfNode(node) });
  }

  const edgeKeys = new Set<string>();
  for (const edge of set.edges) {
    if (!EDGE_KIND_SET.has(edge.kind)) {
      throw new GraphRepositoryError(
        "compare/unknown-edge-kind",
        `Bilinmeyen edge türü: ${String(edge.kind)}`,
      );
    }
    if (!RESOLUTION_SET.has(edge.resolution)) {
      throw new GraphRepositoryError(
        "compare/unknown-resolution",
        `Bilinmeyen resolution değeri: ${String(edge.resolution)}`,
      );
    }
    const fromKey = compareIdentityKey(edge.from);
    const toKey = compareIdentityKey(edge.to);
    if (!nodesByKey.has(fromKey) || !nodesByKey.has(toKey)) {
      const missing = nodesByKey.has(fromKey) ? edge.to : edge.from;
      throw new GraphRepositoryError(
        "compare/dangling-edge",
        `Kenar ucu kümedeki node ile eşleşmiyor (${edge.kind}): ${compareIdentityKey(missing)}`,
      );
    }
    // Kenar kimliği (kind, from, to): domain'deki duplicate-edge invariant'ı
    // gibi tekrar reddedilir. Aksi hâlde aynı anahtarı paylaşan farklı
    // resolution'lı kenarlar eşleşme sırasına girer ve çıktı girdi sırasına
    // bağlanır (determinizm ihlali).
    const edgeKey = canonicalJson([edge.kind, fromKey, toKey]);
    if (edgeKeys.has(edgeKey)) {
      throw new GraphRepositoryError(
        "compare/duplicate-edge",
        `Aynı içerik kümesinde tekrarlanan kenar kimliği: ${edgeKey}`,
      );
    }
    edgeKeys.add(edgeKey);
  }

  return {
    nodesByKey,
    sortedKeys: [...nodesByKey.keys()].sort(compareStrings),
    edges: set.edges,
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * CamelCase sınırını de ayracı sayan tokenleştirici: "createPurchaseOrder" →
 * [create, purchase, order]. Token sırası korunduğundan sonuç deterministiktir.
 */
function tokenize(text: string): string[] {
  const bounded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return bounded.match(/[a-z0-9]+/g) ?? [];
}

function tokenizeSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Jaccard benzerliği; iki küme de boşsa 1 (sinyal yok → çakışma sayılır). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const union = new Set<string>();
  for (const token of a) union.add(token);
  for (const token of b) union.add(token);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

/** qualifiedName'in taban adı: son '/' ve son '.' sonrası bölüm. */
function baseNameOf(qualifiedName: string): string {
  const afterSlash = qualifiedName.slice(qualifiedName.lastIndexOf("/") + 1);
  return afterSlash.slice(afterSlash.lastIndexOf(".") + 1);
}

function pathSegmentSet(relativePath: string): Set<string> {
  return new Set(relativePath.split("/"));
}

interface RenameEvaluation {
  readonly score: number;
  readonly components: RenameComponents;
}

/**
 * Rename skorlaması (TŞ §13 heuristic): taban ad + imza parmak izi + yol
 * benzerliğinin ağırlıklı ortalaması. İki tarafın türü farklıysa aday değildir
 * (null). Eksik alanlar (signature/path yok) skora katılmaz; ağırlık, mevcut
 * alanlara göre yeniden normalize edilir.
 */
function evaluateRename(
  from: CompareNode,
  to: CompareNode,
): RenameEvaluation | null {
  if (from.kind !== to.kind) return null;

  const fromBase = baseNameOf(from.qualifiedName);
  const toBase = baseNameOf(to.qualifiedName);
  const baseName =
    fromBase === toBase
      ? 1
      : jaccard(tokenizeSet(fromBase), tokenizeSet(toBase));

  const signature =
    from.signature === undefined || to.signature === undefined
      ? null
      : from.signature === to.signature
        ? 1
        : jaccard(tokenizeSet(from.signature), tokenizeSet(to.signature));

  const path =
    from.relativePath === undefined || to.relativePath === undefined
      ? null
      : from.relativePath === to.relativePath
        ? 1
        : jaccard(
            pathSegmentSet(from.relativePath),
            pathSegmentSet(to.relativePath),
          );

  let weighted = RENAME_WEIGHT_BASE_NAME * baseName;
  let weight = RENAME_WEIGHT_BASE_NAME;
  if (signature !== null) {
    weighted += RENAME_WEIGHT_SIGNATURE * signature;
    weight += RENAME_WEIGHT_SIGNATURE;
  }
  if (path !== null) {
    weighted += RENAME_WEIGHT_PATH * path;
    weight += RENAME_WEIGHT_PATH;
  }
  return {
    score: weighted / weight,
    components: { baseName, signature, path },
  };
}

function confidenceOf(score: number): RenameConfidence {
  if (score >= RENAME_THRESHOLD_HIGH) return "high";
  if (score >= RENAME_THRESHOLD_MEDIUM) return "medium";
  return "low";
}

function formatComponent(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

interface NodeDelta {
  readonly changeType: string;
  readonly changedAttributeKeys: readonly string[];
}

/**
 * Aynı kimlikte iki node'un içerik farkı: language + signature + attributes.
 * Fark yoksa null döner. Konum bilinçli olarak karşılaştırılmaz (satır
 * kayması mimari değişiklik değildir — bkz. modül başlığı).
 */
function describeNodeDelta(from: CompareNode, to: CompareNode): NodeDelta | null {
  const parts: string[] = [];
  if (from.language !== to.language) parts.push("language");
  if (from.signature !== to.signature) parts.push("signature");

  const fromAttributes = from.attributes ?? {};
  const toAttributes = to.attributes ?? {};
  const allKeys = [
    ...new Set([
      ...Object.keys(fromAttributes),
      ...Object.keys(toAttributes),
    ]),
  ].sort(compareStrings);
  const changedAttributeKeys = allKeys.filter((key) => {
    const inFrom = Object.prototype.hasOwnProperty.call(fromAttributes, key);
    const inTo = Object.prototype.hasOwnProperty.call(toAttributes, key);
    if (inFrom !== inTo) return true;
    if (!inFrom) return false;
    return (
      canonicalJson(fromAttributes[key] as JsonValue) !==
      canonicalJson(toAttributes[key] as JsonValue)
    );
  });
  if (changedAttributeKeys.length > 0) parts.push("attributes");

  if (parts.length === 0) return null;
  return { changeType: parts.join("+"), changedAttributeKeys };
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

function edgeKeyOf(
  kind: EdgeKind,
  from: CompareNodeIdentity,
  to: CompareNodeIdentity,
): string {
  return canonicalJson([
    kind,
    compareIdentityKey(from),
    compareIdentityKey(to),
  ]);
}

function nodeChangeSortKey(change: NodeChange): string {
  return compareIdentityKey(change.node);
}

function edgeChangeSortKey(change: EdgeChange): string {
  return canonicalJson([
    change.changeType,
    change.kind,
    compareIdentityKey(change.from),
    compareIdentityKey(change.to),
  ]);
}

function renameSortKey(match: RenameMatch | UncertainMatch): string {
  return canonicalJson([
    compareIdentityKey(match.from),
    compareIdentityKey(match.to),
  ]);
}

/**
 * Saf Architecture Diff çekirdeği: iki içerik kümesi → belgeli, deterministik
 * diff. Girdi sırasından bağımsızdır; sonuç derin dondurulur (ADR-005 geleneği).
 */
export function diffContentSets(
  base: CompareContentSet,
  target: CompareContentSet,
): ArchitectureDiff {
  const baseSet = validateContentSet(base);
  const targetSet = validateContentSet(target);

  // 1) Ortak kimlikler: değişen/değişmeyen; yalnız tabanda/yalnız hedefte olanlar.
  const changed: NodeChange[] = [];
  const changedByKey = new Map<string, NodeChange>();
  let unchangedNodeCount = 0;
  const baseOnlyKeys: string[] = [];
  for (const key of baseSet.sortedKeys) {
    const own = baseSet.nodesByKey.get(key);
    if (own === undefined) continue; // imkânsız; savunma katmanı
    const counterpart = targetSet.nodesByKey.get(key);
    if (counterpart === undefined) {
      baseOnlyKeys.push(key);
      continue;
    }
    const delta = describeNodeDelta(own.node, counterpart.node);
    if (delta === null) {
      unchangedNodeCount += 1;
      continue;
    }
    const change: NodeChange = {
      classification: "changed",
      node: counterpart.identity,
      ...(delta.changeType.length === 0 ? {} : { changeType: delta.changeType }),
      ...(delta.changedAttributeKeys.length === 0
        ? {}
        : { changedAttributeKeys: delta.changedAttributeKeys }),
    };
    changed.push(change);
    changedByKey.set(key, change);
  }
  const targetOnlyKeys = targetSet.sortedKeys.filter(
    (key) => !baseSet.nodesByKey.has(key),
  );

  // 2) Rename matching: taban çıkarılanları sırayla, en iyi hedef adayla eşle.
  const removedCandidates = baseOnlyKeys.map((key) => {
    const node = baseSet.nodesByKey.get(key);
    if (node === undefined) throw new Error("remove adayı kayboldu");
    return node;
  });
  const addedCandidates = targetOnlyKeys.map((key) => {
    const node = targetSet.nodesByKey.get(key);
    if (node === undefined) throw new Error("add adayı kayboldu");
    return node;
  });

  const renamed: RenameMatch[] = [];
  const uncertain: UncertainMatch[] = [];
  const consumedTargetKeys = new Set<string>();
  const consumedBaseKeys = new Set<string>();
  /** Yalnızca güvenli (low+) rename'ler kenar uçlarını yeniden eşler. */
  const renameMap = new Map<string, CompareNodeIdentity>();

  for (const removed of removedCandidates) {
    let best: { candidate: ValidatedNode; evaluation: RenameEvaluation } | undefined;
    for (const candidate of addedCandidates) {
      if (consumedTargetKeys.has(candidate.key)) continue;
      const evaluation = evaluateRename(removed.node, candidate.node);
      if (evaluation === null || evaluation.score < RENAME_THRESHOLD_UNCERTAIN) {
        continue;
      }
      if (
        best === undefined ||
        evaluation.score > best.evaluation.score ||
        (evaluation.score === best.evaluation.score &&
          candidate.key < best.candidate.key)
      ) {
        best = { candidate, evaluation };
      }
    }
    if (best === undefined) continue; // bağımsız çıkarma olarak kalır

    consumedTargetKeys.add(best.candidate.key);
    consumedBaseKeys.add(removed.key);
    const { score, components } = best.evaluation;
    if (score >= RENAME_THRESHOLD_LOW) {
      const confidence = confidenceOf(score);
      renamed.push({
        from: removed.identity,
        to: best.candidate.identity,
        confidence,
        score,
        components,
        reason:
          `rename-evidence baseName=${formatComponent(components.baseName)} ` +
          `signature=${formatComponent(components.signature)} ` +
          `path=${formatComponent(components.path)} ` +
          `score=${score.toFixed(2)} confidence=${confidence}`,
      });
      renameMap.set(removed.key, best.candidate.identity);
    } else {
      uncertain.push({
        from: removed.identity,
        to: best.candidate.identity,
        score,
        reason:
          `rename-candidate-below-threshold score=${score.toFixed(2)} ` +
          `renameThreshold=${RENAME_THRESHOLD_LOW.toFixed(2)}`,
      });
    }
  }

  // 3) Eşleşmeyen artıklar: bağımsız ekleme/çıkarma.
  const added: NodeChange[] = [];
  for (const key of targetOnlyKeys) {
    if (consumedTargetKeys.has(key)) continue;
    const node = targetSet.nodesByKey.get(key);
    if (node === undefined) continue;
    added.push({ classification: "added", node: node.identity });
  }
  const removed: NodeChange[] = [];
  for (const key of baseOnlyKeys) {
    if (consumedBaseKeys.has(key)) continue;
    const node = baseSet.nodesByKey.get(key);
    if (node === undefined) continue;
    removed.push({ classification: "removed", node: node.identity });
  }

  // 4) Kenarlar: taban kenarları güvenli rename'lerle hedef kimlik uzayına
  //    çevrilir; sonra doğrudan anahtar karşılaştırması yapılır. Kenar
  //    kimlikleri her iki kümede de tekil zorlandığından (compare/duplicate-edge)
  //    eşleşme kova sırasına değil yalnızca anahtara bağlıdır.
  const translate = (identity: CompareNodeIdentity): CompareNodeIdentity => {
    const mapped = renameMap.get(compareIdentityKey(identity));
    return mapped === undefined ? copyIdentity(identity) : copyIdentity(mapped);
  };
  const baseEdgeIndex = new Map<string, CompareEdge>();
  for (const edge of baseSet.edges) {
    baseEdgeIndex.set(edgeKeyOf(edge.kind, translate(edge.from), translate(edge.to)), edge);
  }

  const edgeAdded: EdgeChange[] = [];
  const edgeRemoved: EdgeChange[] = [];
  const edgeChanged: EdgeChange[] = [];
  let edgeUnchangedCount = 0;
  for (const edge of targetSet.edges) {
    const key = edgeKeyOf(edge.kind, edge.from, edge.to);
    const counterpart = baseEdgeIndex.get(key);
    if (counterpart !== undefined) baseEdgeIndex.delete(key);
    if (counterpart === undefined) {
      edgeAdded.push({
        changeType: "added",
        kind: edge.kind,
        from: copyIdentity(edge.from),
        to: copyIdentity(edge.to),
        targetResolution: edge.resolution,
      });
      continue;
    }
    if (counterpart.resolution === edge.resolution) {
      edgeUnchangedCount += 1;
    } else {
      edgeChanged.push({
        changeType: "resolution-changed",
        kind: edge.kind,
        from: copyIdentity(edge.from),
        to: copyIdentity(edge.to),
        baseResolution: counterpart.resolution,
        targetResolution: edge.resolution,
      });
    }
  }
  for (const edge of baseEdgeIndex.values()) {
    edgeRemoved.push({
      changeType: "removed",
      kind: edge.kind,
      from: copyIdentity(edge.from),
      to: copyIdentity(edge.to),
      baseResolution: edge.resolution,
    });
  }

  // 5) Kanonik düzen: her dizi belirleyici anahtarla sıralanır (girdi sırası
  //    sonucu etkilemez — determinizm invariant'ı).
  added.sort((a, b) => compareStrings(nodeChangeSortKey(a), nodeChangeSortKey(b)));
  removed.sort((a, b) => compareStrings(nodeChangeSortKey(a), nodeChangeSortKey(b)));
  changed.sort((a, b) => compareStrings(nodeChangeSortKey(a), nodeChangeSortKey(b)));
  renamed.sort((a, b) => compareStrings(renameSortKey(a), renameSortKey(b)));
  uncertain.sort((a, b) => compareStrings(renameSortKey(a), renameSortKey(b)));
  edgeAdded.sort((a, b) => compareStrings(edgeChangeSortKey(a), edgeChangeSortKey(b)));
  edgeRemoved.sort((a, b) => compareStrings(edgeChangeSortKey(a), edgeChangeSortKey(b)));
  edgeChanged.sort((a, b) => compareStrings(edgeChangeSortKey(a), edgeChangeSortKey(b)));

  // 6) API yüzeyi: endpoint/contract türlerindeki değişimlerin izdüşümü.
  const inSurface = (identity: CompareNodeIdentity): boolean =>
    API_SURFACE_NODE_KIND_SET.has(identity.kind);
  const apiSurface = {
    added: added.filter((change) => inSurface(change.node)),
    removed: removed.filter((change) => inSurface(change.node)),
    changed: changed.filter((change) => inSurface(change.node)),
    renamed: renamed.filter((match) => inSurface(match.from)),
    uncertain: uncertain.filter((match) => inSurface(match.from)),
  };

  return deepFreeze({
    added,
    removed,
    changed,
    renamed,
    uncertain,
    unchangedNodeCount,
    edges: {
      added: edgeAdded,
      removed: edgeRemoved,
      changed: edgeChanged,
      unchangedCount: edgeUnchangedCount,
    },
    apiSurface,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      renamed: renamed.length,
      uncertain: uncertain.length,
      unchangedNodes: unchangedNodeCount,
      edgeAdded: edgeAdded.length,
      edgeRemoved: edgeRemoved.length,
      edgeChanged: edgeChanged.length,
      edgeUnchanged: edgeUnchangedCount,
      apiSurfaceChanges:
        apiSurface.added.length +
        apiSurface.removed.length +
        apiSurface.changed.length +
        apiSurface.renamed.length +
        apiSurface.uncertain.length,
    },
  });
}
