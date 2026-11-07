import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  Resolution,
  SnapshotGraph,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";

/**
 * causoryn_trace_business_flow çekirdeği — TŞ v2.1 §14 (Sayfa 12) Business
 * Flow Intelligence sözleşmesi, §10.2 (Sayfa 10) araç girdisi (flowSeed,
 * boundaries?, maxHops), §20 (Sayfa 22) results resource budget, §22
 * "Flow trace: statik kanıt ve bilinmeyen edge'ler ayrı" test stratejisi.
 *
 * TŞ §14 bire bir: "Eşleştirilen sınırlar: UI route/component →
 * fetch/client method → OpenAPI/backend endpoint → handler → domain
 * service → repository/ORM → table; ayrıca producer event → broker/topic
 * → consumer. Her sınır geçişi kendi evidence'ına ve certainty işaretine
 * sahiptir. trace_business_flow bir açıklama hikâyesi değil, graf ve
 * FlowSegment[] döndürür." — Bu çekirdek açıklama hikâyesi ÜRETMEZ;
 * yalnızca yapısal FlowSegment[] döner.
 *
 * Sözcük (sprint-5 D5 görev tanımı): zincirler MEVCUT kenar türleri
 * üzerinde izlenir — ROUTES_TO, CALLS, PRODUCES_CONTRACT,
 * CONSUMES_CONTRACT, CONTAINS. Kontrat kenarları sprint-5 D1 adaylarının
 * kimlik sözleşmesini paylaşır: ContractCandidate.contractId domain
 * nodeId'sidir (packages/contracts/src/types.ts) ve EventContract
 * qualifiedName'i `${topic}#${direction}` (asyncapi-discovery.ts),
 * SchemaContract "table:<name>" (sql-discovery.ts), ApiContract
 * `operationId ?? "<METHOD> <route>"` (openapi-discovery.ts) kalıbındadır;
 * snapshot'a malzeme edildiğinde bu çekirdek onları doğrudan tüketir.
 *
 * Certainty sözleşmesi (TŞ §14 "her sınır geçişi kendi certainty
 * işaretine sahiptir" + TŞ §13 "certainty/resolution ayrıdır" ilkesi):
 * - Segment certainty YAPISALDIR ve akış-bağlamını taşır:
 *     verified  : kendi kenarı verified VE üstteki geçişlerin tümü verified
 *     heuristic : kendi kenarı heuristic (isim benzerliği vb.; TŞ §11:
 *                 isim benzerliği ASLA verified olamaz)
 *     possible  : kesin olmayan bağ: kendi kenarı verified/unresolved AMA
 *                 öncesinde heuristic bir geçiş var — olası köprünün
 *                 sonrası kesin iddia edilemez (TŞ §14: dynamic dispatch,
 *                 eksik kaynaklar altında kesin akış bilinmez)
 *     gap       : düğümler arasında kenar YOK — zincir dürüstçe kesilir;
 *                 uydurma köprü ÜRETİLMEZ (TŞ §8 invariant ii'nin sorgu
 *                 katmanındaki karşılığı)
 * - Segment resolution KENDİ kenarının çözümleme düzeyidir (TŞ §8
 *   verified|heuristic|unresolved); gap segmentinde null'dur. İki eksen
 *   asla birleştirilmez.
 * - Akış düzeyi certainty zincirin en zayıf segmentidir:
 *   gap < possible < heuristic < verified. Resolution en zayıf gerçek
 *   kenar resolution'ıdır (unresolved < heuristic < verified); akışta
 *   gerçek kenar yoksa null.
 *
 * Event zinciri yönü: PRODUCES_CONTRACT/CONSUMES_CONTRACT kenarları
 * "sembol → kontrat" yönünde yazılıdır (TŞ §8/D1). producer →
 * broker(topic) → consumer zinciri için kontrat node'una varınca bu
 * kenarlar TERS yönde izlenir (kontrat → consumer/producer); segment
 * kenarı ham yönüyle aynen taşır ve `direction: "reverse"` ile açıklar.
 * Ters izleme yalnızca kontrat node türlerinde (ApiContract/EventContract)
 * yapılır; SchemaContract (table) belgeli terminaldir.
 *
 * Dürüst kesim kuralları (uydurma köprü yasağı):
 * - Table/Database/SchemaContract node'ları belgeli terminaldir: zincir
 *   temiz kapanır.
 * - Kontrat geçişiyle varılan producer/consumer sembolü devam kenarı
 *   bulamazsa temiz kapanır (event zincirinin belgeli ucu).
 * - Diğer herhangi bir node'da iş akışı sözcüğünde devam kenarı yoksa
 *   `gap` segmenti eklenir: nedeni açık yazılır, `to`/`edge` null'dur.
 * - Döngü: basit yol koruması (yol içinde node tekrarı yok). Kenar VAR
 *   ama tamamı ziyaret edilmiş node'lara dönüyorsa zincir temiz kapanır.
 *   Rationale düğümün türüne göre gerçek durumu adlandırır: kontrat
 *   node'unda "başka producer/consumer kenarı bulunamadı" (devamsızlık),
 *   kontrat olmayan node'da "döngü koruması" (budak); kesintin gerekçesi
 *   eksik kanıt (gap) değildir.
 *
 * Sınırlar (TŞ §20 resource budget, s.22 config): maxHops (flow başına
 * segment sayısı, gap dahil) tavanı 8, maxFlows (tutulan akış sayısı)
 * tavanı 20, maxNodes (BFS'de kuyruğa alınabilecek AYRIK node bütçesi)
 * tavanı 250. maxNodes İKİ KATMANLI uygulanır: (1) AYRIK node kotası —
 * kuyruğa alınmamış yeni node kotası dolduğunda genişleme durur;
 * (2) türetilmiş kuyruğa-alma bütçesi (maxNodes × maxHops) — zaten
 * kuyruğa alınmış node'lara "serbest dönüşler", kapanışsız yoğun
 * çok-parent grafta kuyruğu bütçesiz katlanarak büyütemez (impact.ts
 * affectedSeen karşılığı + kapanış-emisyon farkının kapanışı). İlk
 * vuruşta keşif GENEL olarak durur: kota dolduysa hiçbir kısmi akış
 * artık yeni bilgi alamaz; vurulan kısmi akış truncated=true +
 * truncatedBy=["maxNodes"] ile kapatılır ve KALAN kuyruktaki kısmi
 * akışlar da truncated olarak drained edilir (kısmi bloklar sonucu
 * truncated:false bırakamaz — TŞ §20 truncated sözleşmesi). İstek
 * tavanı aşarsa tavana kırpılır ve rationale düşer; budama ile kopukluk
 * (gap) karışmaz. "%100 akış" benzeri mutlak iddia ÜRETİLMEZ.
 *
 * Saf fonksiyon (Sprint-3 deseni, impact.ts kardeşi): girdi yalnızca
 * SnapshotGraph + TraceBusinessFlowInput; saat okumaz, rastgelelik
 * kullanmaz, MCP/fs türlerini import etmez. Komşuluklar edge.id kanonik
 * düzeninde, emisyon BFS kapanış sırasıyla üretilir → aynı girdi iki
 * koşumda bit-bit aynı JSON'u üretir (TŞ §8 invariant vi sorgu karşılığı).
 */

/** TŞ v2.1 §20 (Sayfa 22) resource budget tavanları (maxDepth/maxPaths/maxNodes). */
export const FLOW_LIMIT_CEILINGS: FlowAppliedLimits = {
  maxHops: 8,
  maxFlows: 20,
  maxNodes: 250,
};

/**
 * İş akışı sözcüğü — sprint-5 D5: zincirler yalnızca bu kenar türleri
 * üzerinde kurulur (ROUTES_TO, CALLS, PRODUCES_CONTRACT,
 * CONSUMES_CONTRACT, CONTAINS). `boundaries` bu kümenin boş olmayan alt
 * kümesidir.
 */
export const BUSINESS_FLOW_EDGE_KINDS: readonly EdgeKind[] = [
  "ROUTES_TO",
  "CALLS",
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
  "CONTAINS",
];

const BUSINESS_FLOW_EDGE_KIND_SET: ReadonlySet<string> = new Set(BUSINESS_FLOW_EDGE_KINDS);

/** Kontrat node türleri: ters yönlü kontrat kenarı izlemesinin açıldığı türler. */
const CONTRACT_NODE_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  "ApiContract",
  "EventContract",
  "SchemaContract",
]);

/** Belgeli zincir uçları: bu türlerde zincir temiz kapanır, gap üretilmez. */
const TERMINAL_NODE_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  "Table",
  "Database",
  "SchemaContract",
]);

/** Kontrat kenarı türleri: ters yön izleme ve event zinciri sınıflaması. */
const CONTRACT_EDGE_KINDS: ReadonlySet<string> = new Set<EdgeKind>([
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
]);

/** Segment/akış certainty sınıflaması (bkz. modül başlığı sözleşmesi). */
export type FlowCertainty = "verified" | "heuristic" | "possible" | "gap";

/** Akış zincir ailesi: request (UI→API→…→DB) ve event (producer→topic→consumer). */
export type FlowChainKind = "request" | "event";

/** Kenarın akış yönünde mi izlendiği. */
export type FlowEdgeDirection = "forward" | "reverse";

/** Kesme nedeni: hangi tavan vuruldu (TŞ §20 truncated karşılığı). */
export type FlowTruncatedBy = "maxHops" | "maxFlows" | "maxNodes";

/** Uygulanan sınırlar; istek tavanı aşarsa tavana kırpılır. */
export interface FlowAppliedLimits {
  readonly maxHops: number;
  readonly maxFlows: number;
  /** BFS'de kuyruğa alınabilecek AYRIK node bütçesi (TŞ §20 maxNodes). */
  readonly maxNodes: number;
}

/** Segment uçlarındaki node referansı (uçlar snapshot yönünde aynen taşınır). */
export interface FlowNodeRef {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
}

/** Segmentin taşıdığı kenar referansı: ham kenar aynen + izleme yönü. */
export interface FlowEdgeRef {
  readonly edgeId: string;
  readonly kind: EdgeKind;
  /** Kenarın HAM from ucu (ters izlemede akıştaki `to` uçtur). */
  readonly from: string;
  /** Kenarın HAM to ucu (ters izlemede akıştaki `from` uçtur). */
  readonly to: string;
  readonly direction: FlowEdgeDirection;
  readonly evidenceIds: readonly string[];
}

/** Tek sınır geçişi (TŞ §14 FlowSegment): kenar + kendi certainty'i. */
export interface FlowSegment {
  readonly segmentId: string;
  readonly certainty: FlowCertainty;
  /** Kendi kenarının çözümleme düzeyi; gap segmentinde null. */
  readonly resolution: Resolution | null;
  /** Geçişte izlenen kenar; gap segmentinde null (uydurma kenar yok). */
  readonly edge: FlowEdgeRef | null;
  /** Geçişin akış yönündeki başlangıç node'u (gap'te kesimin yapıldığı node). */
  readonly from: FlowNodeRef;
  /** Geçişin akış yönündeki varış node'u; gap segmentinde null. */
  readonly to: FlowNodeRef | null;
  /** Yalnızca gap segmentlerinde: dürüst kesimin gerekçesi. */
  readonly reason?: string;
}

/** Seed'den tek uçtan uca zincir: FlowSegment[] + ayrık sınıflamalar. */
export interface FlowTrace {
  readonly flowId: string;
  readonly seedNodeId: string;
  /** Akışın dokunduğu zincir aileleri; sabit kanonik sırada (event, request). */
  readonly chainKinds: readonly FlowChainKind[];
  /** Segment sayısı (gap dahil); bir sınır geçişi = 1 hop. */
  readonly hopCount: number;
  /** Zincirin en zayıf segment certainty'i. */
  readonly certainty: FlowCertainty;
  /** En zayıf gerçek kenar resolution'ı; gerçek kenar yoksa null. */
  readonly resolution: Resolution | null;
  readonly hasGap: boolean;
  /** Hop bütçesiyle kırpılan akış mı (TŞ §20 truncated). */
  readonly truncated: boolean;
  readonly truncatedBy: readonly FlowTruncatedBy[];
  /** Akış sırasındaki son gerçek node; gap'te kesimin yapıldığı node. */
  readonly terminalNode: FlowNodeRef;
  readonly segments: readonly FlowSegment[];
  /** Akışın birleşik kanıt kimlikleri: tekrarsız, kanonik sırada. */
  readonly evidenceIds: readonly string[];
}

/** Çözümlenmiş flowSeed (TŞ §10.3 identifiedTargets karşılığı). */
export interface FlowSeedRef {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
}

/** Çözülemeyen seed + neden (otomatik kesinleştirme yapılmaz). */
export interface FlowUnresolvedSeed {
  readonly seed: string;
  readonly reason: string;
}

/** Vurulan tavanların sabit kanonik sırası (TŞ §20 truncated raporu). */
const TRUNCATED_BY_ORDER: readonly FlowTruncatedBy[] = ["maxFlows", "maxNodes", "maxHops"];

/** Segment certainty sayımı (akış özet matrisi). */
export type FlowSegmentCounts = Readonly<Record<FlowCertainty, number>>;

/**
 * trace_business_flow girdisi (TŞ §10.2: flowSeed, boundaries?, maxHops).
 * `flowSeed` node kimliği veya TAM qualifiedName'dir; çekirdek otomatik
 * kesinleştirme yapmaz (belirsiz ad unresolvedSeed'e yazılır). `boundaries`
 * izlenecek kenar türleri (BUSINESS_FLOW_EDGE_KINDS alt kümesi); verilmezse
 * kümenin tamamı izlenir. `maxHops`/`maxFlows`/`maxNodes` tavanlı
 * sınırlardır (TŞ §20 resource budget).
 */
export interface TraceBusinessFlowInput {
  readonly flowSeed: string;
  readonly boundaries?: readonly string[];
  readonly maxHops?: number;
  readonly maxFlows?: number;
  readonly maxNodes?: number;
}

/** Certainty × gap sayımı + tavan raporuyla iş akışı sonucu (TŞ §20: sonuç
 * düzeyinde truncated sunar; mutlak akış iddiası taşımaz). */
export interface TraceBusinessFlowResult {
  readonly snapshotId: string;
  readonly seed: FlowSeedRef | null;
  readonly unresolvedSeed: FlowUnresolvedSeed | null;
  readonly flows: readonly FlowTrace[];
  readonly summary: {
    readonly totalFlows: number;
    readonly segmentCounts: FlowSegmentCounts;
  };
  /** Herhangi bir akış kırpıldı mı / maxFlows tavanı vuruldu mu. */
  readonly truncated: boolean;
  /** Vurulan tavanlar; sabit kanonik sırada (maxFlows, maxHops). */
  readonly truncatedBy: readonly FlowTruncatedBy[];
  readonly limits: FlowAppliedLimits;
  readonly rationales: readonly string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Güç sıralaması: verified en güçlü, gap en zayıf (akış-bağlamlı certainty). */
const FLOW_CERTAINTY_STRENGTH: Readonly<Record<FlowCertainty, number>> = {
  verified: 4,
  heuristic: 3,
  possible: 2,
  gap: 1,
};

/** Resolution güç sıralaması: verified > heuristic > unresolved (TŞ §13). */
const RESOLUTION_STRENGTH: Readonly<Record<Resolution, number>> = {
  verified: 3,
  heuristic: 2,
  unresolved: 1,
};

function weakestFlowCertainty(a: FlowCertainty, b: FlowCertainty): FlowCertainty {
  return FLOW_CERTAINTY_STRENGTH[a] <= FLOW_CERTAINTY_STRENGTH[b] ? a : b;
}

function weakestResolution(a: Resolution | null, b: Resolution | null): Resolution | null {
  if (a === null) return b;
  if (b === null) return a;
  return RESOLUTION_STRENGTH[a] <= RESOLUTION_STRENGTH[b] ? a : b;
}

const EMPTY_SEGMENT_COUNTS: FlowSegmentCounts = {
  verified: 0,
  heuristic: 0,
  possible: 0,
  gap: 0,
};

function requireLimit(
  name: string,
  requested: number | undefined,
  ceiling: number,
  rationales: string[],
): number {
  if (requested === undefined) return ceiling;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new GraphRepositoryError(
      "graph/business-flow-invalid-input",
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

/** BFS kuyruğundaki kısmi akış: seed'den bugüne kadarki segment zinciri. */
interface PartialFlow {
  /** [seed, ...varışlar]; basit yol: içinde node tekrarı yok. */
  readonly nodes: readonly string[];
  readonly segments: readonly FlowSegment[];
  readonly weakestCertainty: FlowCertainty | null;
  readonly weakestResolution: Resolution | null;
  /** Şu ana kadar heuristic segment görüldü mü (downgrade taşıyıcısı). */
  readonly sawHeuristic: boolean;
  /** Son geçiş bir kontrat kenarıyla mi yapıldı (event zinciri ucu kuralı). */
  readonly reachedByContractEdge: boolean;
}

interface KeptFlow {
  readonly flowId: string;
  readonly partial: PartialFlow;
  readonly terminal: FlowNodeRef;
  readonly truncated: boolean;
  /** Bu akışı kırpın tavan(lar); kırpılmayan akışta boş (TŞ §20). */
  readonly cutBy: readonly FlowTruncatedBy[];
}

/** Kenar genişletme adayı: akış yönünde sıradaki node. */
interface TraversalEntry {
  readonly edge: GraphEdge;
  readonly nextNodeId: string;
  readonly direction: FlowEdgeDirection;
}

function toNodeRef(node: GraphNode): FlowNodeRef {
  return { nodeId: node.id, kind: node.kind, qualifiedName: node.qualifiedName };
}

function makeGapSegment(from: FlowNodeRef, allowedKinds: readonly string[]): FlowSegment {
  return {
    segmentId: "pending", // kapanışta flow kimliğiyle kanonik olarak yeniden yazılır
    certainty: "gap",
    resolution: null,
    edge: null,
    from,
    to: null,
    reason:
      `kopuk zincir: "${from.qualifiedName}" (${from.nodeId}) düğümünden iş akışı devam kenarı bulunamadı ` +
      `(aranan kenar türleri: ${allowedKinds.join(", ")}) — zincir dürüstçe kesildi; uydurma köprü üretilmedi (TŞ §14)`,
  };
}

/**
 * Segment certainty'i (modül başlığındaki sözleşme): kendi kenarının
 * resolution'u + üstteki heuristic geçiş bilgisi birleşiminden türetilir;
 * iki eksen (certainty/resolution) ayrı alanlarda taşınır.
 */
function segmentCertainty(
  resolution: Resolution,
  sawHeuristicUpstream: boolean,
): FlowCertainty {
  if (sawHeuristicUpstream) return "possible";
  if (resolution === "verified") return "verified";
  if (resolution === "heuristic") return "heuristic";
  return "possible"; // unresolved kenar: olası bağlantı, kesin değil
}

/**
 * İş akışı izlemeyi çalıştırır: flowSeed → ileri yön kenar BFS (bounded,
 * basit yol) + kontrat node'larında ters yön kontrat kenarı izlemesi →
 * FlowSegment[] akışları. Girdi dizilerinin sırasına BAĞIMLI DEĞİLDİR:
 * komşuluklar edge.id, emisyon BFS kapanış sırasıyla kanoniktir.
 */
export function traceBusinessFlow(
  snapshot: SnapshotGraph,
  input: TraceBusinessFlowInput,
): TraceBusinessFlowResult {
  // 1) Snapshot durumu: yalnızca yayımlanabilir snapshot sorgulanır
  //    (TŞ §9: building okuma yollarında görünmez, failed yayın akışına girmez).
  const state = snapshot.meta?.state;
  if (state !== "ready" && state !== "partial") {
    throw new GraphRepositoryError(
      "graph/business-flow-snapshot-state",
      `iş akışı izleme yalnızca ready/partial snapshot üzerinde çalışır; snapshot durumu: ${String(state)}`,
    );
  }

  // 2) Seed girdisi: boş/blank reddedilir (TŞ §10.2 flowSeed zorunlu).
  const flowSeed = input.flowSeed;
  if (typeof flowSeed !== "string" || flowSeed.trim().length === 0) {
    throw new GraphRepositoryError(
      "graph/business-flow-invalid-input",
      `flowSeed boş olamaz: node kimliği veya tam qualifiedName gerekli: ${String(flowSeed)}`,
    );
  }

  // 3) Sınırlar: tavan (TŞ §20) aşılırsa kırpılır ve rationale düşer.
  const rationales: string[] = [];
  const limits: FlowAppliedLimits = {
    maxHops: requireLimit("maxHops", input.maxHops, FLOW_LIMIT_CEILINGS.maxHops, rationales),
    maxFlows: requireLimit("maxFlows", input.maxFlows, FLOW_LIMIT_CEILINGS.maxFlows, rationales),
    maxNodes: requireLimit("maxNodes", input.maxNodes, FLOW_LIMIT_CEILINGS.maxNodes, rationales),
  };

  // 4) boundaries doğrulaması: iş akışı sözcüğünün boş olmayan alt kümesi.
  let allowedKinds: readonly string[];
  if (input.boundaries === undefined) {
    allowedKinds = BUSINESS_FLOW_EDGE_KINDS;
  } else {
    if (!Array.isArray(input.boundaries) || input.boundaries.length === 0) {
      throw new GraphRepositoryError(
        "graph/business-flow-invalid-input",
        "boundaries boş olamaz: BUSINESS_FLOW_EDGE_KINDS alt kümesi gerekli ya da alanı hiç vermeyin",
      );
    }
    const invalid = input.boundaries.filter((kind) => !BUSINESS_FLOW_EDGE_KIND_SET.has(kind));
    if (invalid.length > 0) {
      throw new GraphRepositoryError(
        "graph/business-flow-invalid-input",
        `geçersiz boundaries üyesi(leri): ${invalid.join(", ")}; boundaries şu kümenin alt kümesi olmalı: ${BUSINESS_FLOW_EDGE_KINDS.join(", ")}`,
      );
    }
    allowedKinds = [...new Set(input.boundaries)].sort(cmp);
  }

  // 5) Node/kenar haritaları: ileri komşuluk + kontrat node'larında gelen
  //    kontrat kenarları (ters izleme havuzu); hepsi edge.id kanonik sırada.
  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);
  const outgoingByNode = new Map<string, GraphEdge[]>();
  const incomingContractByNode = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (!allowedKinds.includes(edge.kind)) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue; // savunma: dangling yok sayılır
    const out = outgoingByNode.get(edge.from);
    if (out === undefined) {
      outgoingByNode.set(edge.from, [edge]);
    } else {
      out.push(edge);
    }
    if (CONTRACT_EDGE_KINDS.has(edge.kind)) {
      const inc = incomingContractByNode.get(edge.to);
      if (inc === undefined) {
        incomingContractByNode.set(edge.to, [edge]);
      } else {
        inc.push(edge);
      }
    }
  }
  for (const list of outgoingByNode.values()) list.sort((a, b) => cmp(a.id, b.id));
  for (const list of incomingContractByNode.values()) list.sort((a, b) => cmp(a.id, b.id));

  // 6) Seed çözümleme: önce node kimliği, sonra tam qualifiedName. 0 eşleşme
  //    → unresolvedSeed; >1 → belirsiz (adaylarla; otomatik seçim YOK —
  //    TŞ §10.3 çekirdek karşılığı, impact.ts unresolvedTargets deseni).
  let seed: FlowSeedRef | null = null;
  let unresolvedSeed: FlowUnresolvedSeed | null = null;
  const byId = nodeById.get(flowSeed);
  if (byId !== undefined) {
    seed = toNodeRef(byId);
  } else {
    const byName = snapshot.nodes.filter((node) => node.qualifiedName === flowSeed);
    if (byName.length === 1) {
      const node = byName[0] as GraphNode;
      seed = toNodeRef(node);
    } else if (byName.length === 0) {
      unresolvedSeed = {
        seed: flowSeed,
        reason: `seed çözülemedi: "${flowSeed}" — node kimliği veya tam qualifiedName olarak yayınlanmış snapshot'ta bulunamadı`,
      };
    } else {
      const candidateIds = byName.map((node) => node.id).sort(cmp);
      unresolvedSeed = {
        seed: flowSeed,
        reason: `seed belirsiz: "${flowSeed}" tam qualifiedName ${String(byName.length)} node ile eşleşti (${candidateIds.join(", ")}); node kimliği ile hedefleyin`,
      };
    }
  }
  if (unresolvedSeed !== null) {
    rationales.push(unresolvedSeed.reason);
    return {
      snapshotId: snapshot.meta.id,
      seed: null,
      unresolvedSeed,
      flows: [],
      summary: {
        totalFlows: 0,
        segmentCounts: { ...EMPTY_SEGMENT_COUNTS },
      },
      truncated: false,
      truncatedBy: [],
      limits,
      rationales: [...new Set(rationales)].sort(cmp),
    };
  }
  const seedRef = seed as FlowSeedRef;

  // 7) Bounded BFS: her kısmi akış ya genişler ya kapanır; kapanışlar
  //    akış emisyonunu üretir (deterministik kapanış sırası). queuedSeen,
  //    TŞ §20 maxNodes bütçesidir: kuyruğa girmiş AYRIK node sayısını
  //    sınırlar; maxFlows yalnızca kapanan akışları sınırladığından,
  //    bütçe olmadan derin/dallanmalı zincirlerde ilk kapanışlardan önce
  //    kuyruk D^maxHops katlanarak büyüyebilirdi (impact.ts affectedSeen
  //    karşılığı).
  const kept: KeptFlow[] = [];
  let maxFlowsHit = false;
  let maxNodesHit = false;
  let budgetStop = false;
  const markBudgetStop = (): void => {
    budgetStop = true;
    if (maxNodesHit) return;
    maxNodesHit = true;
    rationales.push(
      `maxNodes=${String(limits.maxNodes)} bütçesi doldu (türetilmiş kuyruğa-alma bütçesi maxNodes×maxHops=${String(limits.maxNodes * limits.maxHops)}): genişleme durduruldu, kalan kısmi akışlar truncated kapatıldı (TŞ §20 resource budget)`,
    );
  };
  const closeFlow = (
    partial: PartialFlow,
    truncated: boolean,
    cutBy: readonly FlowTruncatedBy[] = [],
  ): void => {
    if (kept.length >= limits.maxFlows) {
      if (!maxFlowsHit) {
        maxFlowsHit = true;
        rationales.push(
          `maxFlows=${String(limits.maxFlows)} tavanına ulaşıldı: kalan akış adayları tutulmadı (TŞ §20 resource budget)`,
        );
      }
      return;
    }
    const terminalId = partial.nodes[partial.nodes.length - 1] as string;
    const terminal = nodeById.get(terminalId);
    if (terminal === undefined) return; // savunma: snapshot'tan gelen id
    kept.push({
      flowId: `flow:${String(kept.length + 1).padStart(4, "0")}`,
      partial,
      terminal: toNodeRef(terminal),
      truncated,
      cutBy,
    });
  };

  const queuedSeen = new Set<string>([seedRef.nodeId]);
  const enqueueBudget = limits.maxNodes * limits.maxHops;
  let enqueued = 0;
  const queue: PartialFlow[] = [
    {
      nodes: [seedRef.nodeId],
      segments: [],
      weakestCertainty: null,
      weakestResolution: null,
      sawHeuristic: false,
      reachedByContractEdge: false,
    },
  ];
  let head = 0;
  while (head < queue.length) {
    const partial = queue[head] as PartialFlow;
    head += 1;
    if (maxFlowsHit) break;
    if (budgetStop) break;
    const currentId = partial.nodes[partial.nodes.length - 1] as string;
    const current = nodeById.get(currentId);
    if (current === undefined) continue; // savunma

    // 7a) Belgeli terminal (Table/Database/SchemaContract): temiz kapanış;
    //     bu türlerden geriye doğru genişleme YAPILMAZ.
    if (TERMINAL_NODE_KINDS.has(current.kind)) {
      if (partial.segments.length === 0) {
        rationales.push(
          `seed terminal: "${current.qualifiedName}" (${current.id}) belgeli zincir ucudur (Table/Database/SchemaContract); izlenecek sınır geçişi yok — akış üretilmedi`,
        );
        continue;
      }
      closeFlow(partial, false);
      continue;
    }

    // 7b) Genişleme adayları: ileri yön iş akışı kenarları + kontrat
    //     node'unda ters yön kontrat kenarları (consumer/producer bacakları).
    const allEntries: TraversalEntry[] = [];
    for (const edge of outgoingByNode.get(currentId) ?? []) {
      allEntries.push({ edge, nextNodeId: edge.to, direction: "forward" });
    }
    if (CONTRACT_NODE_KINDS.has(current.kind)) {
      for (const edge of incomingContractByNode.get(currentId) ?? []) {
        allEntries.push({ edge, nextNodeId: edge.from, direction: "reverse" });
      }
    }
    const entries = allEntries.filter(
      (entry) => !partial.nodes.includes(entry.nextNodeId), // basit yol koruması
    );
    entries.sort((a, b) => cmp(a.edge.id, b.edge.id));

    if (entries.length === 0) {
      if (partial.segments.length === 0) {
        // Seed'den hiç akış çıkamadı: dürüst gap akışı + rationale.
        rationales.push(
          `seed izole: "${current.qualifiedName}" (${current.id}) düğümünden iş akışı kenarı bulunamadı; kopukluk gap segmentiyle raporlandı`,
        );
        closeFlow(
          {
            ...partial,
            segments: [makeGapSegment(toNodeRef(current), allowedKinds)],
            weakestCertainty: "gap",
          },
          false,
        );
        continue;
      }
      if (allEntries.length > 0) {
        // Kenar VAR ama tamamı ziyaret edilmiş node'lara dönüyor: budak,
        // kopukluk DEĞİL — temiz kapanış, gap üretilmez. Rationale gerçek
        // durumu adlandırır: kontrat node'unda tek devamın gelinen yön
        // olması devamsızlıktır (başka producer/consumer yok), düz node'da
        // döngü korumasıdır.
        if (CONTRACT_NODE_KINDS.has(current.kind)) {
          rationales.push(
            `kontrat devamsız: "${current.qualifiedName}" (${current.id}) kontratından başka producer/consumer kenarı bulunamadı (mevcut kenar yalnızca gelinen yönde); akış temiz kapatıldı`,
          );
        } else {
          rationales.push(
            `döngü koruması: "${current.qualifiedName}" (${current.id}) düğümünden tüm devam kenarları yol içinde ziyaret edilmiş node'lara dönüyor; akış temiz kapatıldı`,
          );
        }
        closeFlow(partial, false);
        continue;
      }
      if (partial.reachedByContractEdge && !CONTRACT_NODE_KINDS.has(current.kind)) {
        // Event zincirinin belgeli ucu (producer/consumer sembolü): temiz.
        closeFlow(partial, false);
        continue;
      }
      // Kopukluk: dürüst gap segmentiyle kes (uydurma köprü YOK).
      const gap = makeGapSegment(toNodeRef(current), allowedKinds);
      closeFlow(
        {
          ...partial,
          segments: [...partial.segments, gap],
          weakestCertainty: weakestFlowCertainty(partial.weakestCertainty ?? "gap", "gap"),
        },
        false,
      );
      continue;
    }

    // 7c) Devam adayı var ama hop bütçesi dolu: truncated kapanış
    //     (budak, kopukluk DEĞİL — gap üretilmez; TŞ §20 truncated).
    if (partial.segments.length >= limits.maxHops) {
      closeFlow(partial, true, ["maxHops"]);
      continue;
    }

    // 7d) Genişlet: her devam bağımsız kısmi akış olur (BFS sırası kanonik).
    //     İki katmanlı bütçe: (1) AYRIK node kotası (maxNodes) — kuyruğa
    //     alınmamış node kotası dolduysa bloke; (2) türetilmiş kuyruğa-alma
    //     bütçesi (maxNodes × maxHops) — zaten kuyruğa alınmış node'lara
    //     serbest dönüşler kapanışsız yoğun grafta kuyruğu bütçesiz
    //     katlanarak büyütemez. İlk vuruşta keşif GENEL olarak durur
    //     (kota dolduysa hiçbir kısmi akış artık yeni bilgi alamaz);
    //     vurulan kısmi akış truncated kapatılır, kalanlar 7e'de
    //     drained edilir — kısmi bloklar sonucu truncated:false
    //     BIRAKAMAZ (TŞ §20 truncated sözleşmesi).
    for (const entry of entries) {
      if (!queuedSeen.has(entry.nextNodeId)) {
        if (queuedSeen.size >= limits.maxNodes) {
          markBudgetStop();
          break;
        }
        queuedSeen.add(entry.nextNodeId);
      }
      if (enqueued >= enqueueBudget) {
        markBudgetStop();
        break;
      }
      const resolution = entry.edge.resolution;
      const certainty = segmentCertainty(resolution, partial.sawHeuristic);
      const segment: FlowSegment = {
        segmentId: "pending", // kapanışta flow kimliğiyle kanonik olarak yeniden yazılır
        certainty,
        resolution,
        edge: {
          edgeId: entry.edge.id,
          kind: entry.edge.kind,
          from: entry.edge.from,
          to: entry.edge.to,
          direction: entry.direction,
          evidenceIds: [...entry.edge.evidenceIds].sort(cmp),
        },
        from: toNodeRef(current),
        to: toNodeRef(nodeById.get(entry.nextNodeId) as GraphNode),
      };
      queue.push({
        nodes: [...partial.nodes, entry.nextNodeId],
        segments: [...partial.segments, segment],
        weakestCertainty:
          partial.weakestCertainty === null
            ? certainty
            : weakestFlowCertainty(partial.weakestCertainty, certainty),
        weakestResolution: weakestResolution(partial.weakestResolution, resolution),
        sawHeuristic: partial.sawHeuristic || resolution === "heuristic",
        reachedByContractEdge: CONTRACT_EDGE_KINDS.has(entry.edge.kind),
      });
      enqueued += 1;
    }
    if (budgetStop) {
      closeFlow(partial, true, ["maxNodes"]);
    }
  }

  // 7e) Bütçe ilk vurduğunda keşif genel olarak durmuştur (kota dolduysa
  //     hiçbir kısmi akış yeni bilgi alamaz); kuyrukta kalan kısmi
  //     akışlar truncated + cutBy ["maxNodes"] ile dürüstçe kapatılır
  //     (maxFlows tavanı burada da geçerlidir).
  if (budgetStop) {
    while (head < queue.length) {
      closeFlow(queue[head] as PartialFlow, true, ["maxNodes"]);
      head += 1;
    }
  }

  // 8) segmentId'leri kapanış akış kimliğine bağla (kanonik, deterministik);
  //    chainKinds/kanıt birleşimi tekrarsız + kanonik sırada.
  const flows: FlowTrace[] = kept.map((entry) => {
    const segments = entry.partial.segments.map((segment, index) => ({
      ...segment,
      segmentId: `${entry.flowId}:seg:${String(index + 1).padStart(2, "0")}`,
    }));
    const evidenceSet = new Set<string>();
    let chainEvent = false;
    let chainRequest = false;
    for (const segment of segments) {
      if (segment.edge !== null) {
        for (const id of segment.edge.evidenceIds) evidenceSet.add(id);
        if (CONTRACT_EDGE_KINDS.has(segment.edge.kind)) {
          // Kontrat kenarının hedefi zincir ailesini belirler: Api/Event
          // kontratı event zinciri; SchemaContract (table) ise request
          // zincirinin belgeli "repository/ORM → table" bacağıdır (TŞ §14).
          if (segment.to?.kind === "SchemaContract") {
            chainRequest = true;
          } else {
            chainEvent = true;
          }
        } else {
          chainRequest = true;
        }
      }
    }
    const chainKinds: FlowChainKind[] = [];
    if (chainEvent) chainKinds.push("event");
    if (chainRequest) chainKinds.push("request");
    return {
      flowId: entry.flowId,
      seedNodeId: entry.partial.nodes[0] as string,
      chainKinds,
      hopCount: segments.length,
      certainty: entry.partial.weakestCertainty ?? "verified",
      resolution: entry.partial.weakestResolution,
      hasGap: segments.at(-1)?.certainty === "gap",
      truncated: entry.truncated,
      truncatedBy: entry.cutBy,
      terminalNode: entry.terminal,
      segments,
      evidenceIds: [...evidenceSet].sort(cmp),
    };
  });

  // 9) Özet: certainty sayımları + tavan raporu (kanonik truncatedBy sırası).
  const segmentCounts: Record<FlowCertainty, number> = { ...EMPTY_SEGMENT_COUNTS };
  for (const flow of flows) {
    for (const segment of flow.segments) segmentCounts[segment.certainty] += 1;
  }
  const truncatedBySet = new Set<FlowTruncatedBy>();
  if (maxFlowsHit) truncatedBySet.add("maxFlows");
  if (maxNodesHit) truncatedBySet.add("maxNodes");
  for (const flow of flows) {
    for (const reason of flow.truncatedBy) truncatedBySet.add(reason);
  }
  const truncatedBy = TRUNCATED_BY_ORDER.filter((reason) => truncatedBySet.has(reason));

  return {
    snapshotId: snapshot.meta.id,
    seed: seedRef,
    unresolvedSeed: null,
    flows,
    summary: {
      totalFlows: flows.length,
      segmentCounts,
    },
    truncated: maxFlowsHit || flows.some((flow) => flow.truncated),
    truncatedBy,
    limits,
    rationales: [...new Set(rationales)].sort(cmp),
  };
}
