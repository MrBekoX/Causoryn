import {
  EDGE_KINDS,
  EDGE_KIND_SET,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type Resolution,
  type SnapshotGraph,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";

/**
 * causoryn_analyze_impact çekirdeği — TŞ v2.1 §13 (Sayfa 12) Impact
 * sözleşmesi, §10.2 (Sayfa 10) araç girdisi (targets/depth/edgeKinds),
 * §10.3 (Sayfa 11) certainty/pathEvidenceIds örneği, §20 (Sayfa 22)
 * results resource budget, §22 (Sayfa 22) "BFS impact" test stratejisi.
 *
 * Sözleşme (TŞ §13): "Değişen symbol/file/contract tespit edilir; reverse
 * edges üzerinde bounded BFS, endpoint/test/consumer yüzeylerine bağlanan
 * explainable impactPaths döner. direct | indirect | possible ve verified
 * | heuristic | unresolved ayrıdır; '%100 etkilenecek' ifadesi üretilmez."
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu):
 * - Ters BFS: kenarlar `to → from` yönünde izlenir (bir node'u ÇAĞIRAN/
 *   İÇEREN/test EDEN üst bağımlılar bulunur). Kenar tür filtresi yoksa
 *   tüm EDGE_KINDS katılır; CONTAINS/IMPORTS/CALLS/TESTS ... yüzeyleri
 *   (endpoint/test/consumer) böylece doğal olarak çıkar.
 * - certainty (doğrudan/dolaylı/olası) YAPISAL bir sınıflamadır:
 *   yolda en az bir `unresolved` kenar varsa "possible"; aksi halde
 *   depth === 1 → "direct", depth ≥ 2 → "indirect". `heuristic` kenar
 *   certainty'i değiştirmez: güven düzeyi `resolution` alanında AYRI
 *   taşınır; iki eksen asla birleştirilmez (TŞ §13 "ayrıdır").
 * - Yol resolution'ı zincirin en zayıf halkasıdır:
 *   unresolved < heuristic < verified.
 * - Enumerasyon: hedef(ler)den BFS kuyruğu, kenar sırası edge.id kanonik
 *   düzeninde; basit yol (yol kendi içinde node tekrar etmez); hedef
 *   node'lar bilinçli olarak etki kümesine girmez ve yol üzerine
 *   yazılmaz. Sınırlar (TŞ §20 resource budget): maxDepth (yol uzunluğu),
 *   maxPaths (tutulacak yol sayısı), maxNodes (ayrık etki node sayısı).
 *   Bir yol sınırlar yüzünden devam edemeiyorsa `truncated=true` taşır;
 *   sonuç düzeyinde `truncatedBy` hangi tavanın vurulduğunu raporlar.
 * - Kırmızı çizgi: çıktıda mutlak etki iddiası ÜRETİLMEZ. Sonuç yalnızca
 *   yol başına certainty + resolution + truncated taşır; "%100 etkilenecek"
 *   benzeri hiçbir alan/metin yoktur (test impact.test.ts ile denetlenir).
 * - Saf fonksiyon: girdi yalnızca SnapshotGraph + AnalyzeImpactInput;
 *   saat okumaz, rastgelelik kullanmaz, MCP türlerini import etmez. Tüm
 *   çıktı dizileri kanonik sıralı → aynı girdi iki koşumda bit-bit aynı
 *   JSON üretir (TŞ §8 invariant vi'nin sorgu katmanındaki karşılığı).
 */

/** TŞ v2.1 §20 (Sayfa 22) `results` resource budget tavanları. */
export const IMPACT_LIMIT_CEILINGS: ImpactAppliedLimits = {
  maxDepth: 8,
  maxPaths: 20,
  maxNodes: 250,
};

/**
 * Default reverse-impact traversal edge kinds (Ekstazi ISSTA 2015 + CHA ECOOP 1995):
 * - Excludes `CONTAINS` so upward containment (`Workspace --CONTAINS--> File`,
 *   `Package --CONTAINS--> File`, `File --CONTAINS--> Symbol`) never pollutes impact
 *   results with container roots or unrelated siblings.
 * - Includes `INHERITS` and `IMPLEMENTS` so interface / base-class changes propagate
 *   to subclasses, implementors, and their transitive callers.
 * Callers may still explicitly opt into `CONTAINS` via `input.edgeKinds`.
 */
export const DEFAULT_IMPACT_EDGE_KINDS: readonly EdgeKind[] = EDGE_KINDS.filter(
  (kind): kind is EdgeKind => kind !== "CONTAINS",
);

const DEFAULT_IMPACT_EDGE_KIND_SET: ReadonlySet<string> = new Set(
  DEFAULT_IMPACT_EDGE_KINDS,
);

/** Deduplicated per-edge and per-path evidence ID payload caps. */
export const MAX_IMPACT_EDGE_EVIDENCE_IDS = 8;
export const MAX_IMPACT_PATH_EVIDENCE_IDS = 16;

/** Structural container kinds excluded from downward File-target symbol seeding. */
const CONTAINER_NODE_KINDS: ReadonlySet<string> = new Set([
  "Workspace",
  "Repository",
  "Project",
  "Module",
  "Package",
  "File",
]);

/** Max downward containment depth when seeding symbols declared inside a changed File. */
const FILE_FORWARD_SEED_MAX_DEPTH = 2;

/** Etki sınıflaması (TŞ §13): direct | indirect | possible. */
export type ImpactCertainty = "direct" | "indirect" | "possible";

/** Kesme nedeni: hangi resource budget tavanı vuruldu (TŞ §20). */
export type ImpactTruncatedBy = "maxDepth" | "maxNodes" | "maxPaths";

/** Uygulanan sınırlar; istek tavanı aşarsa tavana kırpılır. */
export interface ImpactAppliedLimits {
  readonly maxDepth: number;
  readonly maxPaths: number;
  readonly maxNodes: number;
}

/**
 * analyzeImpact girdisi (TŞ §10.2 `causoryn_analyze_impact`: targets,
 * depth, edgeKinds çekirdek karşılığı). Hedefler yayımlanmış node kimliği
 * (`node:...`) veya TAM qualifiedName'dir; çekirdek otomatik kesinleştirme
 * yapmaz (TŞ §10.3), belirsiz ad adaylarıyla `unresolvedTargets`'a yazılır.
 */
export interface AnalyzeImpactInput {
  readonly targets: readonly string[];
  readonly maxDepth?: number;
  readonly maxPaths?: number;
  readonly maxNodes?: number;
  /** Traversal'a girecek kenar türleri; EDGE_KINDS alt kümesi. */
  readonly edgeKinds?: readonly string[];
}

/** Yoldaki tek kenar referansı: uçlar snapshot yönünde aynen taşınır. */
export interface ImpactEdgeRef {
  readonly edgeId: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly resolution: Resolution;
  /** Kenarın kanıt kimlikleri (açıklanabilirlik; get_evidence ile çözülür). */
  readonly evidenceIds: readonly string[];
}

/** Tek etkilenme yolu: hedeften dışa kenar zinciri + ayrı sınıflamalar. */
export interface ImpactPath {
  readonly pathId: string;
  /** Yolun kõi hedef node kimliği. */
  readonly targetNodeId: string;
  readonly endpointNodeId: string;
  readonly endpointQualifiedName: string;
  readonly endpointKind: NodeKind;
  /** Yoldaki kenar sayısı (hedef depth 0'dır; ilk bağımlı depth 1). */
  readonly depth: number;
  readonly certainty: ImpactCertainty;
  /** Zincirin en zayıf halkası: unresolved < heuristic < verified. */
  readonly resolution: Resolution;
  /** Sınırlar yüzünden devamı kesilen yol mı (TŞ §20 truncated). */
  readonly truncated: boolean;
  /** Kenar referansları hedeften dışa doğru sıralı. */
  readonly edges: readonly ImpactEdgeRef[];
  /** Yolun birleşik kanıt kimlikleri: tekrarsız, id kanonik sırada. */
  readonly evidenceIds: readonly string[];
}

/** Etkilenen node özeti: en güçlü temsilî yolun sınıflamasıyla. */
export interface ImpactAffectedNode {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  /** Bu node'a ulaşan en kısa tutulan yolun derinliği. */
  readonly minDepth: number;
  /** Bu node'a ulaşan tutulan yol sayısı (alternatif zincirler). */
  readonly pathCount: number;
  readonly certainty: ImpactCertainty;
  readonly resolution: Resolution;
  /** Temsilî yol truncated ise true. */
  readonly truncated: boolean;
  /** Temsilî yolun kanıtları (TŞ §10.3 pathEvidenceIds karşılığı). */
  readonly pathEvidenceIds: readonly string[];
  /** Bu node'a ulaşan hedef kimlikleri: tekrarsız, kanonik sırada. */
  readonly targetNodeIds: readonly string[];
}

/** certainty × resolution sayım hücresi (iki eksen ayrı tutulur). */
export interface ImpactSummaryCell {
  readonly verified: number;
  readonly heuristic: number;
  readonly unresolved: number;
}

/** Etki özeti: yol/node sayımları, certainty × resolution matrisiyle. */
export interface ImpactSummary {
  readonly paths: Readonly<Record<ImpactCertainty, number>>;
  readonly affectedNodes: Readonly<Record<ImpactCertainty, ImpactSummaryCell>>;
  readonly totalPaths: number;
  readonly totalAffectedNodes: number;
}

/** Çözümlenmiş hedef (TŞ §10.3 identifiedTargets karşılığı). */
export interface ImpactTargetRef {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
}

/** Çözülemeyen hedef + neden (otomatik kesinleştirme yapılmaz, TŞ §10.3). */
export interface ImpactUnresolvedTarget {
  readonly target: string;
  readonly reason: string;
}

/**
 * Etki analizi sonucu. Sözleşme: mutlak etki iddiası YOKTUR; her yol
 * certainty + resolution + truncated taşır; `rationales` sınırlamaları
 * açıkça raporlar (TŞ §20 "Her analiz sonucu ... warnings, truncated
 * sunar" sorgu-katmanı karşılığı).
 */
export interface ImpactResult {
  readonly snapshotId: string;
  readonly targets: readonly ImpactTargetRef[];
  readonly unresolvedTargets: readonly ImpactUnresolvedTarget[];
  readonly affectedNodes: readonly ImpactAffectedNode[];
  readonly paths: readonly ImpactPath[];
  readonly summary: ImpactSummary;
  readonly truncated: boolean;
  readonly truncatedBy: readonly ImpactTruncatedBy[];
  readonly limits: ImpactAppliedLimits;
  readonly rationales: readonly string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Güç sıralaması: verified en güçlü, unresolved en zayıf (TŞ §13). */
const RESOLUTION_STRENGTH: Readonly<Record<Resolution, number>> = {
  verified: 3,
  heuristic: 2,
  unresolved: 1,
};

const CERTAINTY_STRENGTH_MAP: Readonly<Record<ImpactCertainty, number>> = {
  direct: 3,
  indirect: 2,
  possible: 1,
};

function weakestResolution(a: Resolution, b: Resolution): Resolution {
  return RESOLUTION_STRENGTH[a] <= RESOLUTION_STRENGTH[b] ? a : b;
}

function requireLimit(
  name: string,
  requested: number | undefined,
  ceiling: number,
  rationales: string[],
): number {
  if (requested === undefined) return ceiling;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new GraphRepositoryError(
      "graph/impact-invalid-input",
      `${name} pozitif tam sayı olmalı: ${String(requested)}`,
    );
  }
  if (requested > ceiling) {
    rationales.push(
      `${name}=${String(requested)} istenen değeri tavana (${String(ceiling)}) indirildi (TŞ §20 resource budget)`,
    );
    return ceiling;
  }
  return requested;
}

/** BFS kuyruğundaki kısmi yol: hedeften bugüne kadarki kenar zinciri. */
interface PartialPath {
  readonly targetNodeId: string;
  /** [hedef, ...etkilenen]; basit yol: içinde node tekrarı yok. */
  readonly nodes: readonly string[];
  readonly edgeRefs: readonly ImpactEdgeRef[];
  readonly weakest: Resolution;
  readonly hasUnresolved: boolean;
}

interface KeptPath {
  readonly pathId: string;
  readonly partial: PartialPath;
  readonly certainty: ImpactCertainty;
  readonly truncated: boolean;
}

function toEdgeRef(edge: GraphEdge): ImpactEdgeRef {
  return {
    edgeId: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    resolution: edge.resolution,
    evidenceIds: [...new Set(edge.evidenceIds)]
      .sort(cmp)
      .slice(0, MAX_IMPACT_EDGE_EVIDENCE_IDS),
  };
}

/**
 * Etki analizini çalıştırır: hedef(ler) → ters kenar BFS (bounded) →
 * açıklanabilir impactPaths + certainty×resolution ayrık sınıflaması.
 * Determinizmin bozulmaması için girdi dizilerinin sırasına BAĞIMLI
 * DEĞİLDİR: komşuluklar edge.id, çıktılar kanonik anahtar sırasıyla
 * üretilir.
 */
export function analyzeImpact(
  snapshot: SnapshotGraph,
  input: AnalyzeImpactInput,
): ImpactResult {
  // 1) Snapshot durumu: yalnızca yayımlanabilir snapshot sorgulanır
  //    (TŞ §9: building okuma yollarında görünmez, failed yayın akışına girmez).
  const state = snapshot.meta?.state;
  if (state !== "ready" && state !== "partial") {
    throw new GraphRepositoryError(
      "graph/impact-snapshot-state",
      `etki analizi yalnızca ready/partial snapshot üzerinde çalışır; snapshot durumu: ${String(state)}`,
    );
  }

  // 2) Hedef girdisi: boş/blank reddedilir; yinelenen hedef tekilleşir.
  const requestedTargets = input.targets;
  if (requestedTargets === undefined || requestedTargets.length === 0) {
    throw new GraphRepositoryError(
      "graph/impact-invalid-input",
      "targets boş olamaz: en az bir node kimliği veya tam qualifiedName gerekli",
    );
  }
  for (const target of requestedTargets) {
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new GraphRepositoryError(
        "graph/impact-invalid-input",
        `targets üyesi boş/blanks olamaz: ${String(target)}`,
      );
    }
  }
  const uniqueTargets = [...new Set(requestedTargets)].sort(cmp);

  // 3) Sınırlar: tavan (TŞ §20) aşılırsa kırpılır ve rationale düşer.
  const rationales: string[] = [];
  const limits: ImpactAppliedLimits = {
    maxDepth: requireLimit("maxDepth", input.maxDepth, IMPACT_LIMIT_CEILINGS.maxDepth, rationales),
    maxPaths: requireLimit("maxPaths", input.maxPaths, IMPACT_LIMIT_CEILINGS.maxPaths, rationales),
    maxNodes: requireLimit("maxNodes", input.maxNodes, IMPACT_LIMIT_CEILINGS.maxNodes, rationales),
  };

  // 4) edgeKinds semantic validation: default excludes CONTAINS (includes INHERITS/IMPLEMENTS);
  //    explicit caller edgeKinds must be a subset of EDGE_KINDS and may opt into CONTAINS.
  let allowedKinds: ReadonlySet<string> = DEFAULT_IMPACT_EDGE_KIND_SET;
  const explicitContains =
    input.edgeKinds !== undefined && input.edgeKinds.includes("CONTAINS");
  if (input.edgeKinds !== undefined) {
    const invalid = input.edgeKinds.filter((kind) => !EDGE_KIND_SET.has(kind));
    if (invalid.length > 0) {
      throw new GraphRepositoryError(
        "graph/impact-invalid-input",
        `geçersiz edgeKinds üyesi(leri): ${invalid.join(", ")}; edgeKinds EDGE_KINDS alt kümesi olmalı`,
      );
    }
    allowedKinds = new Set(input.edgeKinds);
  }

  // 5) Node/evidence maps + reverse dependency adjacency + forward File containment map
  //    (canonical edge.id ordering for determinism).
  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);
  const incomingByNode = new Map<string, GraphEdge[]>();
  const forwardContainsByNode = new Map<string, GraphEdge[]>();
  const edgeRefById = new Map<string, ImpactEdgeRef>();
  const danglingEdgeIds: string[] = [];
  for (const edge of snapshot.edges) {
    const isForwardContain = edge.kind === "CONTAINS" || edge.kind === "DECLARES";
    const isAllowedReverse = allowedKinds.has(edge.kind);
    if (!isAllowedReverse && !isForwardContain) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) {
      if (isAllowedReverse) {
        danglingEdgeIds.push(edge.id);
      }
      continue;
    }
    if (isForwardContain) {
      const fwdList = forwardContainsByNode.get(edge.from);
      if (fwdList === undefined) {
        forwardContainsByNode.set(edge.from, [edge]);
      } else {
        fwdList.push(edge);
      }
    }
    if (isAllowedReverse) {
      const list = incomingByNode.get(edge.to);
      if (list === undefined) {
        incomingByNode.set(edge.to, [edge]);
      } else {
        list.push(edge);
      }
    }
  }
  for (const list of incomingByNode.values()) list.sort((a, b) => cmp(a.id, b.id));
  for (const list of forwardContainsByNode.values()) list.sort((a, b) => cmp(a.id, b.id));
  const uniqueDangling = [...new Set(danglingEdgeIds)].sort(cmp);
  for (const edgeId of uniqueDangling) {
    rationales.push(
      `kenar yok sayıldı: ucu snapshot node kümesinde olmayan kenar (edge:${edgeId})`,
    );
  }
  const getEdgeRef = (edge: GraphEdge): ImpactEdgeRef => {
    const cached = edgeRefById.get(edge.id);
    if (cached !== undefined) return cached;
    const created = toEdgeRef(edge);
    edgeRefById.set(edge.id, created);
    return created;
  };

  // 6) Hedef çözümleme: önce node kimliği, sonra tam qualifiedName.
  //    0 eşleşme → unresolved; >1 eşleşme → belirsiz (adaylarla raporlanır;
  //    çekirdek otomatik kesinleştirme yapmaz — TŞ §10.3).
  const targets: ImpactTargetRef[] = [];
  const unresolvedTargets: ImpactUnresolvedTarget[] = [];
  for (const target of uniqueTargets) {
    const byId = nodeById.get(target);
    if (byId !== undefined) {
      targets.push({
        nodeId: byId.id,
        kind: byId.kind,
        qualifiedName: byId.qualifiedName,
      });
      continue;
    }
    const byName = snapshot.nodes.filter((node) => node.qualifiedName === target);
    if (byName.length === 1) {
      const node = byName[0] as GraphNode;
      targets.push({ nodeId: node.id, kind: node.kind, qualifiedName: node.qualifiedName });
      continue;
    }
    if (byName.length === 0) {
      unresolvedTargets.push({
        target,
        reason: `hedef çözülemedi: "${target}" — node kimliği veya tam qualifiedName olarak yayınlanmış snapshot'ta bulunamadı`,
      });
    } else {
      const candidateIds = byName.map((node) => node.id).sort(cmp);
      unresolvedTargets.push({
        target,
        reason: `hedef belirsiz: "${target}" tam qualifiedName ${String(byName.length)} node ile eşleşti (${candidateIds.join(", ")}); node kimliği ile hedefleyin`,
      });
    }
  }
  for (const entry of unresolvedTargets) {
    rationales.push(`${entry.reason}`);
  }
  const targetIdSet = new Set(targets.map((target) => target.nodeId));

  // 7) Bounded reverse BFS: simple paths, canonical edge.id expansion order.
  //    For changed File targets (when caller did not explicitly request CONTAINS),
  //    forward-seed symbols declared inside that File (downward CONTAINS/DECLARES up to
  //    2 hops into non-container symbols) so callers/implementors of symbols defined in
  //    the changed file are discovered WITHOUT traversing upward CONTAINS to Workspace.
  const keptPaths: KeptPath[] = [];
  const truncatedBy = new Set<ImpactTruncatedBy>();
  const seedsByTarget = new Map<string, string[]>();
  const containedSeedIds = new Set<string>();
  if (targets.length > 0) {
    const affectedSeen = new Set<string>();
    const queue: PartialPath[] = [];
    for (const target of targets) {
      const targetSeeds: string[] = [target.nodeId];
      queue.push({
        targetNodeId: target.nodeId,
        nodes: [target.nodeId],
        edgeRefs: [],
        weakest: "verified",
        hasUnresolved: false,
      });

      if (target.kind === "File" && !explicitContains && allowedKinds.size > 0) {
        const discoveredSymbols = new Set<string>();
        const seedFrontier: Array<{ id: string; depth: number }> = [
          { id: target.nodeId, depth: 0 },
        ];
        let seedHead = 0;
        while (seedHead < seedFrontier.length) {
          const item = seedFrontier[seedHead]!;
          seedHead += 1;
          if (item.depth >= FILE_FORWARD_SEED_MAX_DEPTH) continue;
          for (const fwdEdge of forwardContainsByNode.get(item.id) ?? []) {
            const childId = fwdEdge.to;
            if (discoveredSymbols.has(childId) || targetIdSet.has(childId)) continue;
            const childNode = nodeById.get(childId);
            if (childNode === undefined || CONTAINER_NODE_KINDS.has(childNode.kind)) continue;
            discoveredSymbols.add(childId);
            seedFrontier.push({ id: childId, depth: item.depth + 1 });
          }
        }
        const sortedContained = [...discoveredSymbols].sort(cmp);
        for (const childId of sortedContained) {
          containedSeedIds.add(childId);
          targetSeeds.push(childId);
          queue.push({
            targetNodeId: target.nodeId,
            nodes: [childId],
            edgeRefs: [],
            weakest: "verified",
            hasUnresolved: false,
          });
        }
      }
      seedsByTarget.set(target.nodeId, targetSeeds);
    }

    let head = 0;
    while (head < queue.length) {
      const partial = queue[head] as PartialPath;
      head += 1;
      const isSeed = partial.nodes.length === 1;
      if (!isSeed && keptPaths.length >= limits.maxPaths) {
        truncatedBy.add("maxPaths");
        break;
      }

      // Genişleme: ters kenarlar (to → from), edge.id sırasıyla.
      const current = partial.nodes[partial.nodes.length - 1] as string;
      const nextDepth = partial.nodes.length; // mevcut kenar sayısı + 1
      const extensions: PartialPath[] = [];
      let hasUntakenNeighbor = false;
      for (const edge of incomingByNode.get(current) ?? []) {
        const next = edge.from;
        // Basit yol + hedef/file-seed dışlaması: hedefler etki kümesine girmez,
        // yol üzerine yazılmaz (bilinçli kural, truncated SAYILMAZ).
        if (
          partial.nodes.includes(next) ||
          targetIdSet.has(next) ||
          containedSeedIds.has(next)
        ) {
          continue;
        }
        if (nextDepth > limits.maxDepth) {
          hasUntakenNeighbor = true;
          truncatedBy.add("maxDepth");
          continue;
        }
        if (!affectedSeen.has(next) && affectedSeen.size >= limits.maxNodes) {
          hasUntakenNeighbor = true;
          truncatedBy.add("maxNodes");
          continue;
        }
        affectedSeen.add(next); // kuyruğa alınan uçlar bütçeye yazılır
        extensions.push({
          targetNodeId: partial.targetNodeId,
          nodes: [...partial.nodes, next],
          edgeRefs: [...partial.edgeRefs, getEdgeRef(edge)],
          weakest: weakestResolution(partial.weakest, edge.resolution),
          hasUnresolved: partial.hasUnresolved || edge.resolution === "unresolved",
        });
      }

      if (!isSeed) {
        const depth = partial.edgeRefs.length;
        const certainty: ImpactCertainty = partial.hasUnresolved
          ? "possible"
          : depth === 1
            ? "direct"
            : "indirect";
        keptPaths.push({
          pathId: `impactpath:${String(keptPaths.length + 1).padStart(4, "0")}`,
          partial,
          certainty,
          truncated: hasUntakenNeighbor,
        });
      }
      queue.push(...extensions);
    }
  }

  // 8) ImpactPath çıktısı: kanonik yol sırası (BFS emission), kanıt
  //    birleşimi tekrarsız + sıralı + tavanlı.
  const paths: ImpactPath[] = [];
  for (const kept of keptPaths) {
    const endpointId = kept.partial.nodes[kept.partial.nodes.length - 1] as string;
    const endpoint = nodeById.get(endpointId);
    if (endpoint === undefined) continue; // savunma: snapshot'tan gelen id
    const evidenceSet = new Set<string>();
    for (const ref of kept.partial.edgeRefs) {
      for (const id of ref.evidenceIds) evidenceSet.add(id);
    }
    paths.push({
      pathId: kept.pathId,
      targetNodeId: kept.partial.targetNodeId,
      endpointNodeId: endpoint.id,
      endpointQualifiedName: endpoint.qualifiedName,
      endpointKind: endpoint.kind,
      depth: kept.partial.edgeRefs.length,
      certainty: kept.certainty,
      resolution: kept.partial.weakest,
      truncated: kept.truncated,
      edges: kept.partial.edgeRefs,
      evidenceIds: [...evidenceSet].sort(cmp).slice(0, MAX_IMPACT_PATH_EVIDENCE_IDS),
    });
  }

  // 9) Etkilenen node özetleri: en güçlü temsilî yol seçimi
  //    (certainty ↓, resolution ↓, depth ↑, pathId ↑) — deterministik.
  const candidatesByNode = new Map<string, { path: ImpactPath; targetNodeId: string }[]>();
  for (const path of paths) {
    const list = candidatesByNode.get(path.endpointNodeId);
    if (list === undefined) {
      candidatesByNode.set(path.endpointNodeId, [{ path, targetNodeId: path.targetNodeId }]);
    } else {
      list.push({ path, targetNodeId: path.targetNodeId });
    }
  }
  const affectedNodes: ImpactAffectedNode[] = [];
  for (const [nodeId, candidates] of candidatesByNode) {
    const sorted = [...candidates].sort((a, b) => {
      const certaintyGap =
        CERTAINTY_STRENGTH_MAP[b.path.certainty] - CERTAINTY_STRENGTH_MAP[a.path.certainty];
      if (certaintyGap !== 0) return certaintyGap;
      const resolutionGap =
        RESOLUTION_STRENGTH[b.path.resolution] - RESOLUTION_STRENGTH[a.path.resolution];
      if (resolutionGap !== 0) return resolutionGap;
      if (a.path.depth !== b.path.depth) return a.path.depth - b.path.depth;
      return cmp(a.path.pathId, b.path.pathId);
    });
    const representative = sorted[0];
    if (representative === undefined) continue;
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    affectedNodes.push({
      nodeId: node.id,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      minDepth: Math.min(...sorted.map((entry) => entry.path.depth)),
      pathCount: sorted.length,
      certainty: representative.path.certainty,
      resolution: representative.path.resolution,
      truncated: representative.path.truncated,
      pathEvidenceIds: representative.path.evidenceIds,
      targetNodeIds: [...new Set(sorted.map((entry) => entry.targetNodeId))].sort(cmp),
    });
  }
  affectedNodes.sort((a, b) => {
    const nameGap = cmp(a.qualifiedName, b.qualifiedName);
    return nameGap !== 0 ? nameGap : cmp(a.nodeId, b.nodeId);
  });

  // 10) İzolasyon rationale'i: ters kenarı hiç olmayan hedef açıkça raporlanır.
  for (const target of targets) {
    const targetSeeds = seedsByTarget.get(target.nodeId) ?? [target.nodeId];
    const hasIncoming = targetSeeds.some(
      (seedId) => (incomingByNode.get(seedId) ?? []).length > 0,
    );
    if (!hasIncoming) {
      rationales.push(
        `hedef izole: "${target.qualifiedName}" (${target.nodeId}) için ters kenar yok — doğrudan bağımlı node bulunamadı, etki adayı üretilmedi`,
      );
    }
  }

  // 11) Summary matrisi: certainty × resolution AYRI hücreler (TŞ §13).
  type MutableCell = { verified: number; heuristic: number; unresolved: number };
  const emptyCell = (): MutableCell => ({ verified: 0, heuristic: 0, unresolved: 0 });
  const pathCounts: Record<ImpactCertainty, number> = { direct: 0, indirect: 0, possible: 0 };
  const nodeMatrix: Record<ImpactCertainty, MutableCell> = {
    direct: emptyCell(),
    indirect: emptyCell(),
    possible: emptyCell(),
  };
  for (const path of paths) pathCounts[path.certainty] += 1;
  for (const node of affectedNodes) nodeMatrix[node.certainty][node.resolution] += 1;

  // 12) Kesme raporu: truncatedBy sabit kanonik sırada (TŞ §20).
  const truncatedByOrder: ImpactTruncatedBy[] = ["maxDepth", "maxNodes", "maxPaths"];
  const truncatedByList = truncatedByOrder.filter((reason) => truncatedBy.has(reason));

  const uniqueRationales = [...new Set(rationales)].sort(cmp);

  return {
    snapshotId: snapshot.meta.id,
    targets,
    unresolvedTargets,
    affectedNodes,
    paths,
    summary: {
      paths: pathCounts,
      affectedNodes: nodeMatrix,
      totalPaths: paths.length,
      totalAffectedNodes: affectedNodes.length,
    },
    truncated: truncatedByList.length > 0 || paths.some((path) => path.truncated),
    truncatedBy: truncatedByList,
    limits,
    rationales: uniqueRationales,
  };
}
