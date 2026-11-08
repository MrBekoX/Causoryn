import type { Evidence, GraphNode, SnapshotGraph, SourceSpan } from "@causoryn/domain";

import { findViolations } from "./guard.js";
import type { GuardFinding } from "./guard.js";
import type {
  ArchitectureBaseline,
  ArchitecturePolicy,
} from "./guard-policy-schema.js";

/**
 * Evidence zinciri helper'ı — sprint-6 E4 (TŞ §16 "selection → get_evidence
 * → kaynak dosya/satır"; §8 Evidence sözleşmesi; §10.2 "node/edge/finding
 * IDs → Evidence Graph provenance").
 *
 * SAF FONKSİYON SÖZLEŞMESİ (guard.ts disiplini): bu modül fs/ağ/saat/
 * rastgelelik okumaz, girdi nesnelerini mutate etmez, MCP tipi import
 * etmez. Aynı (snapshot, target) girdisi her zaman birebir aynı zinciri
 * üretir (TŞ §8 invariant vi — deterministik sıralama).
 *
 * Zincir sözleşmesi (E4):
 * - Her kayıt relativePath + startLine/endLine + sourceHash (span),
 *   analyzerId (+analyzerVersion), rationale ve VARSA bağlı graf bağlam
 *   referanslarını (contextRefs: katkı eden kenar / karşı uç node / bulgu)
 *   taşır.
 * - Eksik alanlar UYDURULMAZ: span'sız veya rationale'suz (boş string)
 *   eski kayıtlar `partial: true` + `missingFields` ile AÇIK işaretlenir.
 * - Kayıt sıralaması kanıt kimliği bayt-artandır (`order:
 *   "evidence-id-asc"`); contextRefs (kind, id) bayt-artan ve tekrarsızdır.
 * - Hedef kimliğin kendisi snapshot'ta yoksa `undefined` döner (servis
 *   katmanı bunu EVIDENCE_NOT_FOUND'a çevirir); kimlik bilinip kanıt
 *   bulunamıyorsa BOŞ zincir (`empty: true`) döner — iki durum ayrıdır.
 *
 * Finding dalı: finding kimlikleri snapshot'ta yaşamaz (guard.ts bulgu
 * kimliği kural + ihlal kimliğinden türetilir); `resolveFindingById`
 * policy/baseline üzerinden findViolations ile DETERMİNİSTİK türetme yapar
 * ve kimliği eşleşen bulguyu döndürür.
 */

/** Bağlam referansı konumu (TŞ §16 "kaynak dosya/satır"; sourceHash taşımaz). */
export interface EvidenceChainLocation {
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Kanıt kaydını taşıyan graf bağlamı: kenar / node / bulgu referansı. */
export interface EvidenceChainContextRef {
  readonly kind: "node" | "edge" | "finding";
  readonly id: string;
  /** İnsan-okur etiket (qualifiedName / kenar özeti / kural kimliği). */
  readonly label: string;
  readonly location?: EvidenceChainLocation;
}

/** Zenginleştirilmiş zincir kaydı (TŞ §8 Evidence alanları + E4 işaretleri). */
export interface EvidenceChainRecord {
  readonly id: string;
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
  /** Eksik sözleşme alanı var mı (missingFields.length > 0). */
  readonly partial: boolean;
  /** Alfabetik eksik alan listesi: "rationale" | "span". */
  readonly missingFields: readonly string[];
  /** Bağlı graf bağlamları (varsa); (kind, id) bayt-artan, tekrarsız. */
  readonly contextRefs: readonly EvidenceChainContextRef[];
}

/** Zincir özeti: deterministik düzen + açık boş/partial durumu (E4). */
export interface EvidenceChain {
  readonly targetKind: "node" | "edge" | "evidence" | "finding";
  readonly targetId: string;
  readonly order: "evidence-id-asc";
  readonly recordCount: number;
  readonly records: readonly EvidenceChainRecord[];
  readonly empty: boolean;
  readonly partialCount: number;
}

/**
 * Finding hedefinin zincir için gereken yüzü. `GuardFinding` bu yapıyı
 * karşılar (structural typing) — çağıran bulguyu doğrudan geçebilir.
 */
export interface FindingChainRef {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: string;
  /** İhlal kaynağı node'un qualifiedName'i (no-cycles'ta SCC temsilcisi). */
  readonly from: string;
  /** İhlal hedefi node'un qualifiedName'i. */
  readonly to: string;
  /** İhlali destekleyen kenar kanıt kimlikleri. */
  readonly evidenceIds: readonly string[];
  readonly cycle?: readonly string[];
}

export type EvidenceChainTarget =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string }
  | { readonly kind: "evidence"; readonly id: string }
  | { readonly kind: "finding"; readonly finding: FindingChainRef };

export interface ResolveFindingInput {
  readonly snapshot: SnapshotGraph;
  readonly policy: ArchitecturePolicy;
  readonly baseline: ArchitectureBaseline;
  readonly findingId: string;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedById<T extends { readonly id: string }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort((a, b) => compareStrings(a.id, b.id));
}

function nodeRefOf(node: GraphNode): EvidenceChainContextRef {
  return {
    kind: "node",
    id: node.id,
    label: node.qualifiedName,
    ...(node.location === undefined
      ? {}
      : {
          location: {
            relativePath: node.location.relativePath,
            startLine: node.location.startLine,
            endLine: node.location.endLine,
          },
        }),
  };
}

function edgeRefOf(edge: GraphEdgeRef, nodesById: ReadonlyMap<string, GraphNode>): EvidenceChainContextRef {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  const fromLabel = from?.qualifiedName ?? edge.from;
  const toLabel = to?.qualifiedName ?? edge.to;
  return {
    kind: "edge",
    id: edge.id,
    label: `${edge.kind} ${fromLabel} → ${toLabel} (${edge.resolution})`,
  };
}

function findingRefOf(finding: FindingChainRef): EvidenceChainContextRef {
  return {
    kind: "finding",
    id: finding.id,
    label: `${finding.ruleId} (${finding.severity}) — ${finding.from} → ${finding.to}`,
  };
}

/** (kind, id) bayt-artan sıralama + kind+id tekrarsızlama (determinizm). */
function dedupeSortedRefs(
  refs: readonly EvidenceChainContextRef[],
): readonly EvidenceChainContextRef[] {
  const seen = new Set<string>();
  const unique: EvidenceChainContextRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}\u0000${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique.sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id));
}

/** TŞ §8 Evidence alanları + E4 partial/missingFields/contextRefs işaretleri. */
function chainRecordOf(
  evidence: Evidence,
  contextRefs: readonly EvidenceChainContextRef[],
): EvidenceChainRecord {
  const missingFields: string[] = [];
  if (evidence.span === undefined) missingFields.push("span");
  if (evidence.rationale.trim().length === 0) missingFields.push("rationale");
  missingFields.sort(compareStrings);
  return {
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.span === undefined ? {} : { span: { ...evidence.span } }),
    analyzerId: evidence.analyzerId,
    analyzerVersion: evidence.analyzerVersion,
    rationale: evidence.rationale,
    partial: missingFields.length > 0,
    missingFields,
    contextRefs: dedupeSortedRefs(contextRefs),
  };
}

interface GraphEdgeRef {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly resolution: string;
  readonly evidenceIds: readonly string[];
}

interface BuildChainContext {
  readonly snapshot: SnapshotGraph;
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
}

function evidenceRecordOf(
  evidenceId: string,
  context: BuildChainContext,
  contextRefs: readonly EvidenceChainContextRef[],
): EvidenceChainRecord | undefined {
  const record = context.evidenceById.get(evidenceId);
  if (record === undefined) return undefined;
  return chainRecordOf(record, contextRefs);
}

/**
 * Verilen hedef için kanıt zincirini üretir. Hedef kimliği snapshot'ta
 * yoksa `undefined` (servis katmanı EVIDENCE_NOT_FOUND verir); kimlik
 * bilinip kanıt çıkmıyorsa BOŞ zincir (`empty: true`) döner.
 */
export function buildEvidenceChain(input: {
  readonly snapshot: SnapshotGraph;
  readonly target: EvidenceChainTarget;
}): EvidenceChain | undefined {
  const { snapshot, target } = input;
  const context: BuildChainContext = {
    snapshot,
    evidenceById: new Map(snapshot.evidence.map((item) => [item.id, item])),
    nodesById: new Map(snapshot.nodes.map((node) => [node.id, node])),
  };

  if (target.kind === "node") {
    const node = context.nodesById.get(target.id);
    if (node === undefined) return undefined;
    // Komşu kenarların kanıtları (get_evidence'ın Faz A semantiği korunur);
    // her kaydın bağlamı: kanıtı taşıyan kenar(lar) + karşı uç node(lar).
    const records: EvidenceChainRecord[] = [];
    for (const evidenceId of nodeEvidenceIdsInOrder(snapshot, target.id)) {
      const contributing = snapshot.edges.filter(
        (edge) =>
          (edge.from === target.id || edge.to === target.id) &&
          edge.evidenceIds.includes(evidenceId),
      );
      const counterpartIds = new Set<string>();
      for (const edge of contributing) {
        if (edge.from !== target.id) counterpartIds.add(edge.from);
        if (edge.to !== target.id) counterpartIds.add(edge.to);
      }
      const refs: EvidenceChainContextRef[] = [
        ...contributing.map((edge) => edgeRefOf(edge, context.nodesById)),
      ];
      for (const counterpartId of counterpartIds) {
        const counterpart = context.nodesById.get(counterpartId);
        if (counterpart !== undefined) refs.push(nodeRefOf(counterpart));
      }
      const record = evidenceRecordOf(evidenceId, context, refs);
      if (record !== undefined) records.push(record);
    }
    return finalizeChain("node", target.id, records);
  }

  if (target.kind === "edge") {
    const edge = snapshot.edges.find((candidate) => candidate.id === target.id);
    if (edge === undefined) return undefined;
    const refs = [edge.from, edge.to]
      .map((endpointId) => context.nodesById.get(endpointId))
      .filter((node): node is GraphNode => node !== undefined)
      .map((node) => nodeRefOf(node));
    const records: EvidenceChainRecord[] = [];
    for (const evidenceId of [...edge.evidenceIds].sort(compareStrings)) {
      const record = evidenceRecordOf(evidenceId, context, refs);
      if (record !== undefined) records.push(record);
    }
    return finalizeChain("edge", target.id, records);
  }

  if (target.kind === "evidence") {
    const record = context.evidenceById.get(target.id);
    if (record === undefined) return undefined;
    // Bağlam: bu kanıtı KULLANAN kenarlar (kim kanıtlıyor) — kimlik sıralı.
    const citing = sortedById(
      snapshot.edges
        .filter((edge) => edge.evidenceIds.includes(target.id))
        .map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          resolution: edge.resolution,
          evidenceIds: edge.evidenceIds,
        })),
    );
    const refs = citing.map((edge) => edgeRefOf(edge, context.nodesById));
    return finalizeChain("evidence", target.id, [chainRecordOf(record, refs)]);
  }

  // finding hedefi: bulgunun kanıt kimlikleri + bulgu/uç node bağlamı.
  const finding = target.finding;
  const refs: EvidenceChainContextRef[] = [findingRefOf(finding)];
  for (const qualifiedName of [finding.from, finding.to]) {
    const node = snapshot.nodes
      .filter((candidate) => candidate.qualifiedName === qualifiedName)
      .sort((a, b) => compareStrings(a.id, b.id))[0];
    if (node !== undefined) refs.push(nodeRefOf(node));
  }
  const records: EvidenceChainRecord[] = [];
  for (const evidenceId of [...finding.evidenceIds].sort(compareStrings)) {
    const record = evidenceRecordOf(evidenceId, context, refs);
    if (record !== undefined) records.push(record);
  }
  return finalizeChain("finding", finding.id, records);
}

/**
 * Node hedefinin kanıt kimlikleri: komşu kenarlardan, kanıt kimliği bayt
 * artan TEKRAKSIZ düzende (get_evidence'ın sprint-1 düzeni korunur).
 */
function nodeEvidenceIdsInOrder(
  snapshot: SnapshotGraph,
  nodeId: string,
): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const edge of snapshot.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    for (const evidenceId of edge.evidenceIds) {
      if (seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      ids.push(evidenceId);
    }
  }
  return ids.sort(compareStrings);
}

function finalizeChain(
  targetKind: EvidenceChain["targetKind"],
  targetId: string,
  records: readonly EvidenceChainRecord[],
): EvidenceChain {
  const ordered = [...records].sort((a, b) => compareStrings(a.id, b.id));
  const partialCount = ordered.filter((record) => record.partial).length;
  return {
    targetKind,
    targetId,
    order: "evidence-id-asc",
    recordCount: ordered.length,
    records: ordered,
    empty: ordered.length === 0,
    partialCount,
  };
}

/**
 * Finding kimliğini policy/baseline üzerinden DETERMİNİSTİK türeterek
 * çözer: findViolations çıktısında kimliği eşleşen bulgu yoksa
 * `undefined` (servis katmanı EVIDENCE_NOT_FOUND verir). Bulgu kimliği
 * yalnızca kural + ihlal kimliğinden türetildiğinden (snapshotId içermez)
 * aynı (snapshot, policy, baseline) girdisi her zaman aynı sonucu verir.
 */
export function resolveFindingById(input: ResolveFindingInput): GuardFinding | undefined {
  const violations = findViolations(input.snapshot, input.policy, input.baseline);
  return violations.find((finding) => finding.id === input.findingId);
}
