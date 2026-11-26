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
 * - Rename matching is bounded (RENAME_MATCHING_BUDGET, security scan F5):
 *   above the pair or token-comparison budget it is skipped as a whole and
 *   reported through `DiffContentSetsOptions.onWarning`
 *   (`rename-matching-skipped`); the tokenizer is a linear scan (F25).
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
      `Unknown node kind: ${String(identity.kind)}`,
    );
  }
  if (
    typeof identity.qualifiedName !== "string" ||
    identity.qualifiedName.trim().length === 0
  ) {
    throw new GraphRepositoryError(
      "compare/empty-qualified-name",
      `qualifiedName must not be empty: ${String(identity.qualifiedName)}`,
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
        `language must not be empty: ${key}`,
      );
    }
    if (node.signature !== undefined && node.signature.trim().length === 0) {
      throw new GraphRepositoryError(
        "compare/invalid-node-field",
        `signature must not be empty: ${key}`,
      );
    }
    try {
      canonicalJson((node.attributes ?? {}) as JsonValue);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new GraphRepositoryError(
          "compare/non-json-attribute",
          `attributes cannot be serialized to JSON (${key}): ${error.message}`,
        );
      }
      throw error;
    }
    if (nodesByKey.has(key)) {
      throw new GraphRepositoryError(
        "compare/duplicate-node",
        `Duplicate node identity in the same content set: ${key}`,
      );
    }
    nodesByKey.set(key, { key, node, identity: identityOfNode(node) });
  }

  const edgeKeys = new Set<string>();
  for (const edge of set.edges) {
    if (!EDGE_KIND_SET.has(edge.kind)) {
      throw new GraphRepositoryError(
        "compare/unknown-edge-kind",
        `Unknown edge kind: ${String(edge.kind)}`,
      );
    }
    if (!RESOLUTION_SET.has(edge.resolution)) {
      throw new GraphRepositoryError(
        "compare/unknown-resolution",
        `Unknown resolution value: ${String(edge.resolution)}`,
      );
    }
    const fromKey = compareIdentityKey(edge.from);
    const toKey = compareIdentityKey(edge.to);
    if (!nodesByKey.has(fromKey) || !nodesByKey.has(toKey)) {
      const missing = nodesByKey.has(fromKey) ? edge.to : edge.from;
      throw new GraphRepositoryError(
        "compare/dangling-edge",
        `Edge endpoint does not match any node in the set (${edge.kind}): ${compareIdentityKey(missing)}`,
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
        `Duplicate edge identity in the same content set: ${edgeKey}`,
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

function isAsciiUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isAsciiLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Camel-case word boundary before index `i` (> 0): an ASCII uppercase letter
 * that follows a lowercase letter or digit ("createPurchase" → create|Purchase),
 * or that ends an uppercase run and is followed by a lowercase letter
 * ("HTTPServer" → HTTP|Server). `charCodeAt` past the end is NaN (no match).
 */
function isCamelCaseBoundary(text: string, i: number): boolean {
  if (!isAsciiUpper(text.charCodeAt(i))) return false;
  const previous = text.charCodeAt(i - 1);
  return (
    isAsciiLower(previous) ||
    isAsciiDigit(previous) ||
    (isAsciiUpper(previous) && isAsciiLower(text.charCodeAt(i + 1)))
  );
}

/** Appends the runs of ASCII lowercase letters and digits in `lowered`. */
function collectAsciiWords(lowered: string, tokens: string[]): void {
  let start = -1;
  for (let i = 0; i < lowered.length; i += 1) {
    const code = lowered.charCodeAt(i);
    if (isAsciiLower(code) || isAsciiDigit(code)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      tokens.push(lowered.slice(start, i));
      start = -1;
    }
  }
  if (start >= 0) tokens.push(lowered.slice(start));
}

/**
 * Camel-case aware tokenizer: "createPurchaseOrder" → [create, purchase,
 * order], "HTTPServer" → [http, server]. The text is split at camel-case
 * boundaries, each piece is lowercased (full Unicode `toLowerCase`) and the
 * runs of ASCII letters and digits become tokens, in order (deterministic).
 *
 * One linear scan, no regular expression (security scan F25, CWE-1333): the
 * signature and qualifiedName come from the analysed repository with no
 * length limit, and the former `/([A-Z]+)([A-Z][a-z])/g` pass backtracked
 * quadratically on a long uppercase run. The tokens are identical to the
 * former `replace(/([a-z0-9])([A-Z])/g, "$1 $2")` +
 * `replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")` + `toLowerCase()` +
 * `match(/[a-z0-9]+/g)` pipeline: both put a separator at exactly these
 * boundaries, and lowercasing per piece equals lowercasing the joined text
 * because the only context-dependent lowercase mapping (Final_Sigma) does
 * not look across a separator.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let pieceStart = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i < text.length && !isCamelCaseBoundary(text, i)) continue;
    collectAsciiWords(text.slice(pieceStart, i).toLowerCase(), tokens);
    pieceStart = i;
  }
  return tokens;
}

/**
 * Jaccard similarity of two interned token sets; 1 when both are empty (no
 * signal → counted as agreement). The intersection loop runs over the smaller
 * set, so one call costs min(|a|, |b|) lookups (the unit of the rename work
 * budget). |a ∪ b| = |a| + |b| − |a ∩ b|, so the value equals the former
 * union-set computation exactly.
 */
function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** qualifiedName'in taban adı: son '/' ve son '.' sonrası bölüm. */
function baseNameOf(qualifiedName: string): string {
  const afterSlash = qualifiedName.slice(qualifiedName.lastIndexOf("/") + 1);
  return afterSlash.slice(afterSlash.lastIndexOf(".") + 1);
}

/**
 * Rename matching work budget (security scan F5, CWE-407). The node lists of a
 * content set come from the analysed repository (a committed snapshot blob or
 * the engine's analysis of its source) and diffContentSets runs synchronously
 * on the MCP main thread, so rename matching must not grow without bound:
 * - `maxCandidatePairs`: same-kind removed × added node pairs one diff may
 *   score (Σ over kinds of |removed| · |added|; different kinds are never
 *   rename candidates).
 * - `maxTokenComparisons`: upper bound of the token-set lookups those pairs
 *   need: one per pair plus, per kind, min(|added| · Σ cost(removed),
 *   |removed| · Σ cost(added)), where cost(node) is its number of base-name
 *   tokens + signature tokens + path segments.
 * Both counts are computed before any pair is scored. Above either limit
 * rename matching is skipped as a whole: no renamed/uncertain entries, every
 * removed and added node is reported as removed or added, edges are compared
 * without rename remapping, and a `rename-matching-skipped` warning goes to
 * `DiffContentSetsOptions.onWarning`. Inputs under the limits produce exactly
 * the diff an unbounded run would.
 */
export const RENAME_MATCHING_BUDGET: Readonly<{
  readonly maxCandidatePairs: number;
  readonly maxTokenComparisons: number;
}> = Object.freeze({
  maxCandidatePairs: 2_000_000,
  maxTokenComparisons: 50_000_000,
});

/** Warning code (prefix of the warning text) when rename matching is skipped. */
export const COMPARE_WARNING_RENAME_MATCHING_SKIPPED = "rename-matching-skipped";

/**
 * A rename matching budget shared by every diff of one call that runs several
 * (security scan F5: a timeline runs up to TIMELINE_CEILINGS.maxRevisions − 1
 * = 59 diffs on the MCP main thread, each one allowed RENAME_MATCHING_BUDGET;
 * see TIMELINE_RENAME_MATCHING_BUDGET). The per-diff
 * budget still applies to each diff; on top of it, a diff whose pair count or
 * token-comparison bound exceeds what is left here skips rename matching
 * with the same `rename-matching-skipped` warning. A diff that runs rename
 * matching adds its two pre-computed counts to the `used*` fields; a skipped
 * diff adds nothing. Diffs are charged in call order, so the outcome is
 * deterministic.
 */
export interface SharedRenameMatchingBudget {
  readonly maxCandidatePairs: number;
  readonly maxTokenComparisons: number;
  usedCandidatePairs: number;
  usedTokenComparisons: number;
}

/** A fresh shared budget with nothing used yet. */
export function createSharedRenameMatchingBudget(limits: {
  readonly maxCandidatePairs: number;
  readonly maxTokenComparisons: number;
}): SharedRenameMatchingBudget {
  return {
    maxCandidatePairs: limits.maxCandidatePairs,
    maxTokenComparisons: limits.maxTokenComparisons,
    usedCandidatePairs: 0,
    usedTokenComparisons: 0,
  };
}

/** Options of {@link diffContentSets}. */
export interface DiffContentSetsOptions {
  /**
   * Receives each warning as deterministic text `<code>: <explanation>`.
   * Today the only code is `rename-matching-skipped` (see
   * RENAME_MATCHING_BUDGET). The diff itself keeps its shape.
   */
  readonly onWarning?: (warning: string) => void;
  /**
   * Cumulative rename matching budget of the calling tool call (see
   * SharedRenameMatchingBudget); absent = only the per-diff budget applies.
   */
  readonly sharedBudget?: SharedRenameMatchingBudget;
}

/**
 * A rename candidate with its text interned once (security scan F5): equal
 * strings get equal ids, so the equality shortcuts of the scoring cost O(1)
 * and token-set lookups compare numbers instead of repository-sized strings.
 */
interface RenameCandidate {
  readonly validated: ValidatedNode;
  readonly baseNameId: number;
  readonly baseNameTokens: ReadonlySet<number>;
  readonly signatureId: number | null;
  readonly signatureTokens: ReadonlySet<number> | null;
  readonly pathId: number | null;
  readonly pathSegments: ReadonlySet<number> | null;
  /** Base-name tokens + signature tokens + path segments (work budget unit). */
  readonly cost: number;
}

type Interner = (text: string) => number;

function createInterner(): Interner {
  const ids = new Map<string, number>();
  return (text) => {
    let id = ids.get(text);
    if (id === undefined) {
      id = ids.size;
      ids.set(text, id);
    }
    return id;
  };
}

function internSet(values: readonly string[], intern: Interner): Set<number> {
  const set = new Set<number>();
  for (const value of values) set.add(intern(value));
  return set;
}

function prepareRenameCandidate(
  validated: ValidatedNode,
  intern: Interner,
): RenameCandidate {
  const { node } = validated;
  const baseName = baseNameOf(node.qualifiedName);
  const baseNameTokens = internSet(tokenize(baseName), intern);
  const signatureTokens =
    node.signature === undefined ? null : internSet(tokenize(node.signature), intern);
  const pathSegments =
    node.relativePath === undefined
      ? null
      : internSet(node.relativePath.split("/"), intern);
  return {
    validated,
    baseNameId: intern(baseName),
    baseNameTokens,
    signatureId: node.signature === undefined ? null : intern(node.signature),
    signatureTokens,
    pathId: node.relativePath === undefined ? null : intern(node.relativePath),
    pathSegments,
    cost:
      baseNameTokens.size + (signatureTokens?.size ?? 0) + (pathSegments?.size ?? 0),
  };
}

/** Equal text → 1, otherwise the Jaccard similarity of its token sets. */
function textSimilarity(
  fromId: number,
  fromTokens: ReadonlySet<number>,
  toId: number,
  toTokens: ReadonlySet<number>,
): number {
  return fromId === toId ? 1 : jaccard(fromTokens, toTokens);
}

interface RenameEvaluation {
  readonly score: number;
  readonly components: RenameComponents;
}

/**
 * Rename skorlaması (TŞ §13 heuristic): taban ad + imza parmak izi + yol
 * benzerliğinin ağırlıklı ortalaması. Adaylar aynı türdendir (tür kovası;
 * farklı tür hiç aday değildir). Eksik alanlar (signature/path yok) skora
 * katılmaz; ağırlık, mevcut alanlara göre yeniden normalize edilir.
 */
function evaluateRename(
  from: RenameCandidate,
  to: RenameCandidate,
): RenameEvaluation {
  const baseName = textSimilarity(
    from.baseNameId,
    from.baseNameTokens,
    to.baseNameId,
    to.baseNameTokens,
  );

  const signature =
    from.signatureId === null ||
    from.signatureTokens === null ||
    to.signatureId === null ||
    to.signatureTokens === null
      ? null
      : textSimilarity(from.signatureId, from.signatureTokens, to.signatureId, to.signatureTokens);

  const path =
    from.pathId === null ||
    from.pathSegments === null ||
    to.pathId === null ||
    to.pathSegments === null
      ? null
      : textSimilarity(from.pathId, from.pathSegments, to.pathId, to.pathSegments);

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

/** Same-kind rename candidates, each list in canonical (sorted key) order. */
interface RenameKindBucket {
  readonly removed: ValidatedNode[];
  readonly added: ValidatedNode[];
}

interface PreparedRenameBucket {
  readonly removed: readonly RenameCandidate[];
  readonly added: readonly RenameCandidate[];
}

const RENAME_SKIPPED_OUTCOME =
  "renames were not detected, so removed and added nodes are reported as they are";

/**
 * Applies RENAME_MATCHING_BUDGET (and the caller's shared budget, if any)
 * before any pair is scored: buckets the candidates by kind, checks the pair
 * count, then interns the candidates' text and checks the token-comparison
 * bound. Returns the buckets to match (charging the shared budget), or null
 * (with one warning) when rename matching is skipped.
 */
function planRenameMatching(
  removedCandidates: readonly ValidatedNode[],
  addedCandidates: readonly ValidatedNode[],
  options: DiffContentSetsOptions,
): readonly PreparedRenameBucket[] | null {
  const { onWarning, sharedBudget } = options;
  const buckets = new Map<NodeKind, RenameKindBucket>();
  const bucketOf = (kind: NodeKind): RenameKindBucket => {
    let bucket = buckets.get(kind);
    if (bucket === undefined) {
      bucket = { removed: [], added: [] };
      buckets.set(kind, bucket);
    }
    return bucket;
  };
  for (const node of removedCandidates) bucketOf(node.node.kind).removed.push(node);
  for (const node of addedCandidates) bucketOf(node.node.kind).added.push(node);

  const paired = [...buckets.values()].filter(
    (bucket) => bucket.removed.length > 0 && bucket.added.length > 0,
  );
  let candidatePairs = 0;
  for (const bucket of paired) candidatePairs += bucket.removed.length * bucket.added.length;
  if (candidatePairs > RENAME_MATCHING_BUDGET.maxCandidatePairs) {
    onWarning?.(
      `${COMPARE_WARNING_RENAME_MATCHING_SKIPPED}: ${String(candidatePairs)} same-kind removed/added ` +
        `candidate pairs exceed the rename matching budget of ` +
        `${String(RENAME_MATCHING_BUDGET.maxCandidatePairs)} pairs; ${RENAME_SKIPPED_OUTCOME}`,
    );
    return null;
  }
  if (sharedBudget !== undefined) {
    const pairsLeft = Math.max(0, sharedBudget.maxCandidatePairs - sharedBudget.usedCandidatePairs);
    if (candidatePairs > pairsLeft) {
      onWarning?.(
        `${COMPARE_WARNING_RENAME_MATCHING_SKIPPED}: ${String(candidatePairs)} same-kind removed/added ` +
          `candidate pairs exceed the ${String(pairsLeft)} pairs left of this call's cumulative rename ` +
          `matching budget of ${String(sharedBudget.maxCandidatePairs)} pairs; ${RENAME_SKIPPED_OUTCOME}`,
      );
      return null;
    }
  }

  const intern = createInterner();
  const prepared: PreparedRenameBucket[] = [];
  let tokenComparisons = candidatePairs;
  for (const bucket of paired) {
    const removed = bucket.removed.map((node) => prepareRenameCandidate(node, intern));
    const added = bucket.added.map((node) => prepareRenameCandidate(node, intern));
    let removedCost = 0;
    for (const candidate of removed) removedCost += candidate.cost;
    let addedCost = 0;
    for (const candidate of added) addedCost += candidate.cost;
    tokenComparisons += Math.min(added.length * removedCost, removed.length * addedCost);
    prepared.push({ removed, added });
  }
  if (tokenComparisons > RENAME_MATCHING_BUDGET.maxTokenComparisons) {
    onWarning?.(
      `${COMPARE_WARNING_RENAME_MATCHING_SKIPPED}: ${String(candidatePairs)} same-kind removed/added ` +
        `candidate pairs need up to ${String(tokenComparisons)} token comparisons, over the rename ` +
        `matching budget of ${String(RENAME_MATCHING_BUDGET.maxTokenComparisons)}; ${RENAME_SKIPPED_OUTCOME}`,
    );
    return null;
  }
  if (sharedBudget !== undefined) {
    const tokensLeft = Math.max(
      0,
      sharedBudget.maxTokenComparisons - sharedBudget.usedTokenComparisons,
    );
    if (tokenComparisons > tokensLeft) {
      onWarning?.(
        `${COMPARE_WARNING_RENAME_MATCHING_SKIPPED}: ${String(candidatePairs)} same-kind removed/added ` +
          `candidate pairs need up to ${String(tokenComparisons)} token comparisons, over the ` +
          `${String(tokensLeft)} left of this call's cumulative rename matching budget of ` +
          `${String(sharedBudget.maxTokenComparisons)}; ${RENAME_SKIPPED_OUTCOME}`,
      );
      return null;
    }
    sharedBudget.usedCandidatePairs += candidatePairs;
    sharedBudget.usedTokenComparisons += tokenComparisons;
  }
  return prepared;
}

/**
 * Saf Architecture Diff çekirdeği: iki içerik kümesi → belgeli, deterministik
 * diff. Girdi sırasından bağımsızdır; sonuç derin dondurulur (ADR-005 geleneği).
 * Rename matching is bounded by RENAME_MATCHING_BUDGET; when it is skipped the
 * diff keeps its shape and `options.onWarning` receives the reason.
 */
export function diffContentSets(
  base: CompareContentSet,
  target: CompareContentSet,
  options: DiffContentSetsOptions = {},
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
    if (node === undefined) throw new Error("internal error: removed rename candidate is missing");
    return node;
  });
  const addedCandidates = targetOnlyKeys.map((key) => {
    const node = targetSet.nodesByKey.get(key);
    if (node === undefined) throw new Error("internal error: added rename candidate is missing");
    return node;
  });

  const renamed: RenameMatch[] = [];
  const uncertain: UncertainMatch[] = [];
  const consumedTargetKeys = new Set<string>();
  const consumedBaseKeys = new Set<string>();
  /** Yalnızca güvenli (low+) rename'ler kenar uçlarını yeniden eşler. */
  const renameMap = new Map<string, CompareNodeIdentity>();

  // Kinds are independent (a different kind is never a candidate), and each
  // bucket keeps the canonical key order: removed nodes are matched in that
  // order, and the first candidate with the strictly highest score wins, which
  // is the smallest key among equal scores (the former tie-break). Skipped
  // over budget → no buckets: every node stays removed/added (see
  // RENAME_MATCHING_BUDGET).
  const buckets = planRenameMatching(removedCandidates, addedCandidates, options) ?? [];
  for (const bucket of buckets) {
    const consumed = new Uint8Array(bucket.added.length);
    for (const removedCandidate of bucket.removed) {
      let bestIndex = -1;
      let best: RenameEvaluation | undefined;
      for (let index = 0; index < bucket.added.length; index += 1) {
        const candidate = bucket.added[index];
        if (candidate === undefined || consumed[index] === 1) continue;
        const evaluation = evaluateRename(removedCandidate, candidate);
        if (evaluation.score < RENAME_THRESHOLD_UNCERTAIN) continue;
        if (best === undefined || evaluation.score > best.score) {
          best = evaluation;
          bestIndex = index;
        }
      }
      const bestCandidate = bucket.added[bestIndex];
      if (best === undefined || bestCandidate === undefined) continue; // bağımsız çıkarma olarak kalır

      const removedNode = removedCandidate.validated;
      const addedNode = bestCandidate.validated;
      consumed[bestIndex] = 1;
      consumedTargetKeys.add(addedNode.key);
      consumedBaseKeys.add(removedNode.key);
      const { score, components } = best;
      if (score >= RENAME_THRESHOLD_LOW) {
        const confidence = confidenceOf(score);
        renamed.push({
          from: removedNode.identity,
          to: addedNode.identity,
          confidence,
          score,
          components,
          reason:
            `rename-evidence baseName=${formatComponent(components.baseName)} ` +
            `signature=${formatComponent(components.signature)} ` +
            `path=${formatComponent(components.path)} ` +
            `score=${score.toFixed(2)} confidence=${confidence}`,
        });
        renameMap.set(removedNode.key, addedNode.identity);
      } else {
        uncertain.push({
          from: removedNode.identity,
          to: addedNode.identity,
          score,
          reason:
            `rename-candidate-below-threshold score=${score.toFixed(2)} ` +
            `renameThreshold=${RENAME_THRESHOLD_LOW.toFixed(2)}`,
        });
      }
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
