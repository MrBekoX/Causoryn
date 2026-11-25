import type { GraphNode, SnapshotGraph } from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";
import { nodeIdentityRelativePath } from "./validation.js";

/**
 * causoryn_generate_onboarding çekirdeği (TŞ v2.1 §16 Onboarding Mode; §8
 * çıktı tablosu "Öğrenme yolu, kritik entrypoint'ler, önemli modüller,
 * riskli/belirsiz alanlar"; sprint-3 C5).
 *
 * Saf ve deterministik yapısal veri üretici: saat okumaz, rastgelelik
 * kullanmaz, girdi dizilerinin sırasına dayanmaz. Aynı SnapshotGraph girdisi
 * her zaman bit düzeyinde aynı JSON'u üretir; her belirsiz karşılaştırmada
 * leksik tie-break ([qualifiedName, kind, nodeId]) uygulanır. Açıklayıcı
 * doğal dil host modelin görevidir; burada yalnızca yapısal veri ve şablon
 * uyarı metinleri üretilir (TŞ §16).
 *
 * Profil içerik setleri (TŞ §16 içerik listesi — giriş noktaları, ilk 5
 * yüksek merkezi modül, kritik iş akışları, testler, bilinmeyen kenarlar,
 * öğrenme sırası):
 * - beginner:     giriş noktaları + ilk modüller + öğrenme sırası (10 adım)
 * - intermediate: + bilinmeyen kenarlar; öğrenme sırası 25 adım
 * - maintainer:   + kritik akışlar ve testler; öğrenme sırası 50 adım
 *
 * TŞ §10.2 araç yüzeyi girdisi "audience, focus?"tür; çekirdek API'de
 * audience karşılığı "profile" olarak adlandırılır ve C8 MCP araç kaydında
 * audience→profile eşlemesi yapılmalıdır. "focus" MCP yüzey parametresi
 * çekirdeğe henüz eklenmedi: yapısal seçim focus'suz tanımlıdır; C8'in
 * eklenmesini gerekçelendirmesi beklenir (denetim bulgusu 5 kararı).
 *
 * Yapısal hesaplar:
 * - Derece merkeziliği: Module node'larının toplam derecesi (gelen + giden,
 *   tüm kenar türleri, tüm çözüm düzeyleri); normalize: degree / (n - 1).
 * - Öğrenme sırası: bağımlılık yönlü yapısal sıra. Kenar türleri
 *   DEPENDS_ON/IMPORTS/CALLS/INHERITS/IMPLEMENTS/ROUTES_TO ve çözümü
 *   verified/heuristic kenarlar kısıt verir; unresolved kenarlar spekülatif
 *   olduğundan kısıt VERMEZ (risk alanı olarak raporlanır). Döngülere karşı
 *   dayanıklılık: Tarjan SCC (SIAM J. Comput. 1(2):146-160, 1972 — bkz.
 *   raw/context-inject/papers/tarjan-scc-dfs-siam-joc-1972.md) ile yoğunlaştırılmış
 *   graf üzerinde Kahn topolojik sırası; her SCC tek öğrenme adımıdır ve
 *   üyeleri leksik sıralıdır.
 * - Giriş noktaları: Endpoint node'ları + giriş derecesi 0 (hiçbir kenar
 *   kendisine gelmez) ve giden akışı olan "düşük dereeli yüksek önemli"
 *   sınıflar. Endpoint yüzeyi hiç yoksa sınıf tabanlı giriş noktası
 *   türetimi spekülatif olduğundan YAPILMAZ; yerine riskli alanlar uyarısı
 *   döner (kırmızı çizgi: uydurma geçiş yok).
 * - Kritik akışlar: endpoint'ten verified ROUTES_TO/CALLS zinciri, derinlik
 *   3, komşular leksik sırayla taranır (sınır: MAX_CRITICAL_FLOW_NODES).
 */

/** Onboarding hedef kitlesi (TŞ §16 profilleri). */
export type OnboardingProfile = "beginner" | "intermediate" | "maintainer";

/** Profil başına öğrenme adımı tavanı (bağlı yapısal içerik seviyesi). */
const PROFILE_LEARNING_STEPS: Readonly<
  Record<OnboardingProfile, number>
> = {
  beginner: 10,
  intermediate: 25,
  maintainer: 50,
};

/** Kritik akış tavanları: akış sayısı ve toplam BFS ziyareti. */
const DEFAULT_MAX_CRITICAL_FLOWS = 3;
const MAX_CRITICAL_FLOW_NODES = 500;
const MAX_CRITICAL_FLOW_DEPTH = 3;

/** Diğer bölüm tavanları (sabit, belgelenmiş). */
const MAX_TEST_ENTRIES = 10;
const MAX_UNKNOWN_EDGE_NODES = 10;
const MAX_RISK_AREAS = 5;

/** Çağıranın üzerine yazabileceği hesap sınırları. */
export interface OnboardingLimits {
  /** Giriş noktası kaydı tavanı (endpoint + sınıf toplamı). */
  readonly entryPointLimit: number;
  /** Raporlanacak yüksek merkezili modül sayısı (TŞ: ilk 5). */
  readonly topModuleCount: number;
  /** Öğrenme sırası adım tavanı (profiller 10/25/50 ile başlar). */
  readonly maxLearningSteps: number;
  /** Raporlanacak kritik akış sayısı tavanı. */
  readonly maxCriticalFlows: number;
}

const DEFAULT_LIMITS: Omit<OnboardingLimits, "maxLearningSteps"> = {
  entryPointLimit: 5,
  topModuleCount: 5,
  maxCriticalFlows: DEFAULT_MAX_CRITICAL_FLOWS,
};

/**
 * Upper bounds for caller-supplied limits. A larger request is clamped to the
 * ceiling with an `onboarding/limit-clamped` warning (same contract as the
 * trace tool's maxDepth/maxPaths clamping), so a single call cannot ask for
 * an unbounded report.
 */
export const ONBOARDING_LIMIT_CEILINGS: Readonly<OnboardingLimits> = Object.freeze({
  entryPointLimit: 100,
  topModuleCount: 100,
  maxLearningSteps: 500,
  maxCriticalFlows: 50,
});

/** Fixed key order for validation and clamp warnings (deterministic output). */
const LIMIT_KEYS: readonly (keyof OnboardingLimits)[] = [
  "entryPointLimit",
  "topModuleCount",
  "maxLearningSteps",
  "maxCriticalFlows",
];

export interface GenerateOnboardingInput {
  readonly profile: OnboardingProfile;
  readonly limits?: Partial<OnboardingLimits>;
}

/** Giriş noktası / modül adayı gibi tek node'a bağlı yapısal kayıt. */
export interface OnboardingEntry {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
  /** Şablon gerekçe: "endpoint-node" | "low-degree-high-importance-class". */
  readonly reason: string;
}

/** Yüksek merkezili modül kaydı (derece merkeziliği). */
export interface OnboardingModuleStat {
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly relativePath?: string;
  readonly degree: number;
  readonly inDegree: number;
  readonly outDegree: number;
  /** degree / max(1, toplam node sayısı - 1). */
  readonly centrality: number;
}

/** Öğrenme sırası adımı; döngü üyeleri tek bileşende (SCC) birleştirilir. */
export interface LearningStep {
  /** 1'den başlayan artan sıra numarası. */
  readonly order: number;
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
  /** Yoğunlaştırılmış bileşen kimliği (rep leksik sırasına göre 0-based). */
  readonly componentId: number;
  /** Bileşen boyutu; > 1 = döngü kümesi tek adımda öğrenilir. */
  readonly componentSize: number;
}

/** Endpoint'ten verified çağırma zinciriyle inen kritik akış. */
export interface OnboardingCriticalFlow {
  readonly entryNodeId: string;
  readonly entryQualifiedName: string;
  readonly steps: readonly {
    readonly nodeId: string;
    readonly qualifiedName: string;
    /** 1'den başlayan zincir derinliği. */
    readonly depth: number;
  }[];
}

/** Test node'u ve hedeflediği semboller (TESTS kenarları). */
export interface OnboardingTestEntry {
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly testedQualifiedNames: readonly string[];
}

/** Çözüm düzeyine göre bilinmeyen (heuristic/unresolved) kenar özeti. */
export interface OnboardingUnknownEdges {
  readonly resolution: "heuristic" | "unresolved";
  readonly edgeCount: number;
  /** Kenar uçlarının qualifiedName'leri, leksik, tavanlı. */
  readonly affectedNodes: readonly string[];
}

/** Unresolved kenar ucunun işaret ettiği riskli/belirsiz alan. */
export interface OnboardingRiskArea {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly unresolvedEdgeCount: number;
}

/** Şablon uyarı; açıklayıcı doğal dil host modelin işidir (TŞ §16). */
export interface OnboardingWarning {
  readonly code:
    | "onboarding/no-entry-endpoint"
    | "onboarding/learning-order-truncated"
    | "onboarding/limit-clamped";
  readonly message: string;
}

/** Onboarding raporu: tüm bölümler her profilde anahtar olarak bulunur;
 * profilin içerik setine girmeyen bölümler boş dizidir. */
export interface OnboardingReport {
  readonly profile: OnboardingProfile;
  readonly snapshotId: string;
  readonly snapshotState: SnapshotGraph["meta"]["state"];
  readonly entryPoints: readonly OnboardingEntry[];
  readonly topModules: readonly OnboardingModuleStat[];
  readonly learningOrder: readonly LearningStep[];
  readonly criticalFlows: readonly OnboardingCriticalFlow[];
  readonly tests: readonly OnboardingTestEntry[];
  readonly unknownEdges: readonly OnboardingUnknownEdges[];
  readonly riskAreas: readonly OnboardingRiskArea[];
  readonly warnings: readonly OnboardingWarning[];
}

/** Öğrenme sırasına giren yapısal node türleri (TŞ §16 harita katmanları). */
const LEARNING_NODE_KINDS: ReadonlySet<GraphNode["kind"]> = new Set([
  "Module",
  "Class",
  "Interface",
  "Type",
  "Function",
  "Method",
  "Endpoint",
  "Handler",
]);

/** Öğrenme sırasına kısıt veren bağımlılık kenar türleri. */
const DEPENDENCY_EDGE_KINDS: ReadonlySet<string> = new Set([
  "DEPENDS_ON",
  "IMPORTS",
  "CALLS",
  "INHERITS",
  "IMPLEMENTS",
  "ROUTES_TO",
]);

/** Kritik akışta izlenen kenar türleri (yalnızca verified). */
const FLOW_EDGE_KINDS: ReadonlySet<string> = new Set(["ROUTES_TO", "CALLS"]);

/** Leksik tie-break: [qualifiedName, kind, nodeId] karşılaştırması. */
function compareNodeKey(a: GraphNode, b: GraphNode): number {
  if (a.qualifiedName !== b.qualifiedName) {
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/** Node kaydına koşullu relativePath ekler (exactOptionalPropertyTypes). */
function withRelativePath<T extends object>(
  node: GraphNode,
  rest: T,
): T & { relativePath?: string } {
  const relativePath = nodeIdentityRelativePath(node);
  return relativePath === undefined
    ? { ...rest }
    : { ...rest, relativePath };
}

function assertValidProfile(profile: OnboardingProfile): void {
  if (
    profile !== "beginner" &&
    profile !== "intermediate" &&
    profile !== "maintainer"
  ) {
    throw new GraphRepositoryError(
      "graph/onboarding-invalid-input",
      `Unknown onboarding profile: ${String(profile)}`,
    );
  }
}

/**
 * Limit birleşimi tek noktadan (denetim bulgusu 4): default + çağıran
 * override'ı + profil öğrenme tavanı; geçersiz değer burada reddedilir.
 * Hata kodu düzeni kardeş modüllerle aynıdır: graph/<modül>-invalid-input.
 */
function resolveLimits(
  profile: OnboardingProfile,
  overrides?: Partial<OnboardingLimits>,
): { readonly limits: OnboardingLimits; readonly clampWarnings: readonly OnboardingWarning[] } {
  const requested = {
    ...DEFAULT_LIMITS,
    ...overrides,
    maxLearningSteps:
      overrides?.maxLearningSteps ?? PROFILE_LEARNING_STEPS[profile],
  };
  for (const [key, value] of Object.entries(requested)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new GraphRepositoryError(
        "graph/onboarding-invalid-input",
        `Onboarding limit must be a positive integer (${key}): ${String(value)}`,
      );
    }
  }
  // Validation guaranteed positive integers; oversized values are clamped.
  const limits: Record<keyof OnboardingLimits, number> = { ...requested };
  const clampWarnings: OnboardingWarning[] = [];
  for (const key of LIMIT_KEYS) {
    const ceiling = ONBOARDING_LIMIT_CEILINGS[key];
    if (limits[key] > ceiling) {
      clampWarnings.push({
        code: "onboarding/limit-clamped",
        message: `${key}=${String(limits[key])} exceeds the ceiling ${String(ceiling)}; clamped to ${String(ceiling)}`,
      });
      limits[key] = ceiling;
    }
  }
  return { limits, clampWarnings };
}

/**
 * Binary min-heap of component indices. Component indices follow the
 * representative's lexical order (orderedReps is sorted with
 * compareNodeKey), so "smallest index" is exactly the previous
 * "lexically smallest ready representative" tie-break.
 */
class ComponentMinHeap {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentValue = items[parent] as number;
      if (parentValue <= value) break;
      items[index] = parentValue;
      index = parent;
    }
    items[index] = value;
  }

  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const leftValue = items[left] as number;
      const rightValue = right < items.length ? (items[right] as number) : Number.POSITIVE_INFINITY;
      const child = rightValue < leftValue ? right : left;
      const childValue = items[child] as number;
      if (last <= childValue) break;
      items[index] = childValue;
      index = child;
    }
    items[index] = last;
    return top;
  }
}

/** Tarjan SCC — iterative DFS (yığın taşması yok; bounded V+E). */
function tarjanStronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const indexOf = new Map<string, number>();
  const lowOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  for (const root of adjacency.keys()) {
    if (indexOf.has(root)) continue;
    indexOf.set(root, nextIndex);
    lowOf.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);
    const callStack: {
      readonly node: string;
      readonly children: readonly string[];
      childIndex: number;
    }[] = [
      { node: root, children: adjacency.get(root) ?? [], childIndex: 0 },
    ];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (frame === undefined) break;
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex];
        frame.childIndex += 1;
        if (child === undefined) continue;
        if (!indexOf.has(child)) {
          indexOf.set(child, nextIndex);
          lowOf.set(child, nextIndex);
          nextIndex += 1;
          stack.push(child);
          onStack.add(child);
          callStack.push({
            node: child,
            children: adjacency.get(child) ?? [],
            childIndex: 0,
          });
        } else if (onStack.has(child)) {
          const childLow = indexOf.get(child) ?? 0;
          lowOf.set(frame.node, Math.min(lowOf.get(frame.node) ?? 0, childLow));
        }
        continue;
      }
      callStack.pop();
      const parent = callStack[callStack.length - 1];
      if (parent !== undefined) {
        lowOf.set(
          parent.node,
          Math.min(
            lowOf.get(parent.node) ?? 0,
            lowOf.get(frame.node) ?? 0,
          ),
        );
      }
      if ((lowOf.get(frame.node) ?? 0) === (indexOf.get(frame.node) ?? -1)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Onboarding raporu üretir: saf, deterministik, JSON'a serileştirilebilir.
 * Girdi node/edge dizilerinin sırası çıktıyı etkilemez; tüm bölümler
 * kanonik (leksik veya sayısal, tie-break leksik) sıradadır.
 */
export function generateOnboarding(
  snapshot: SnapshotGraph,
  input: GenerateOnboardingInput,
): OnboardingReport {
  assertValidProfile(input.profile);
  const { limits, clampWarnings } = resolveLimits(input.profile, input.limits);
  // Snapshot durumu: yalnızca yayımlanabilir snapshot işlenir (TŞ §9:
  // building okuma yollarında görünmez, failed yayın akışına girmez).
  // Bellek deposu bunu publish'te garanti eder; saf çekirdek doğrudan
  // çağrılabildiğinden aynı koruma burada da vardır (kardeş analyzeImpact:
  // graph/impact-snapshot-state — denetim bulgusu 1).
  const state = snapshot.meta.state;
  if (state !== "ready" && state !== "partial") {
    throw new GraphRepositoryError(
      "graph/onboarding-snapshot-state",
      `onboarding only runs on a ready or partial snapshot; snapshot state: ${String(state)}`,
    );
  }

  // 1) Node indeksi ve dereceler: O(V+E); tüm kenar türleri/çözümler sayılır.
  const nodesById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodesById.set(node.id, node);
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const node of snapshot.nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }
  for (const edge of snapshot.edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const warnings: OnboardingWarning[] = [...clampWarnings];

  // 2) Giriş noktaları: endpoint node'ları + giriş derecesi 0, giden akışı
  //    olan sınıflar (düşük dereeli yüksek önemli). Endpoint yoksa uyarı.
  const sortedNodes = [...snapshot.nodes].sort(compareNodeKey);
  const endpointEntries: OnboardingEntry[] = [];
  const classCandidates: { node: GraphNode; outDegree: number }[] = [];
  for (const node of sortedNodes) {
    const outgoing = outDegree.get(node.id) ?? 0;
    const incoming = inDegree.get(node.id) ?? 0;
    if (node.kind === "Endpoint") {
      endpointEntries.push({
        ...withRelativePath(node, {
          nodeId: node.id,
          kind: node.kind,
          qualifiedName: node.qualifiedName,
          reason: "endpoint-node",
        }),
      });
    } else if (node.kind === "Class" && incoming === 0 && outgoing > 0) {
      classCandidates.push({ node, outDegree: outgoing });
    }
  }
  const entryPoints: OnboardingEntry[] = [...endpointEntries];
  if (endpointEntries.length > 0) {
    const classSlots = Math.max(0, limits.entryPointLimit - entryPoints.length);
    const selectedClasses = classCandidates
      .sort(
        (a, b) =>
          b.outDegree - a.outDegree || compareNodeKey(a.node, b.node),
      )
      .slice(0, classSlots)
      .map(({ node }) => ({
        ...withRelativePath(node, {
          nodeId: node.id,
          kind: node.kind,
          qualifiedName: node.qualifiedName,
          reason: "low-degree-high-importance-class",
        }),
      }));
    entryPoints.push(...selectedClasses);
  } else if (snapshot.nodes.length > 0) {
    warnings.push({
      code: "onboarding/no-entry-endpoint",
      message:
        "No Endpoint node was found in the snapshot, so entry points could not be derived. " +
        "Unresolved edge endpoints are reported in the riskAreas section.",
    });
  }
  entryPoints.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    if (a.qualifiedName !== b.qualifiedName) {
      return a.qualifiedName < b.qualifiedName ? -1 : 1;
    }
    return a.nodeId < b.nodeId ? -1 : 1;
  });

  // 3) İlk N yüksek merkezili modül: derece merkeziliği, tie-break leksik.
  const totalNodes = snapshot.nodes.length;
  const moduleCandidates = sortedNodes
    .filter((node) => node.kind === "Module")
    .map((node) => {
      const incoming = inDegree.get(node.id) ?? 0;
      const outgoing = outDegree.get(node.id) ?? 0;
      return {
        node,
        degree: incoming + outgoing,
        inDegree: incoming,
        outDegree: outgoing,
      };
    });
  const topModules: OnboardingModuleStat[] = moduleCandidates
    .sort(
      (a, b) =>
        b.degree - a.degree ||
        compareNodeKey(a.node, b.node),
    )
    .slice(0, limits.topModuleCount)
    .map(({ node, degree, inDegree: incoming, outDegree: outgoing }) => ({
      ...withRelativePath(node, {
        nodeId: node.id,
        qualifiedName: node.qualifiedName,
        degree,
        inDegree: incoming,
        outDegree: outgoing,
        centrality: degree / Math.max(1, totalNodes - 1),
      }),
    }));

  // 4) Öğrenme sırası: bağımlılık önce; SCC'ler tek adım (Tarjan + Kahn).
  const learningCandidates = sortedNodes.filter((node) =>
    LEARNING_NODE_KINDS.has(node.kind),
  );
  const dependencyAdjacency = new Map<string, string[]>();
  const dependencyEdges: { from: string; to: string }[] = [];
  for (const node of learningCandidates) dependencyAdjacency.set(node.id, []);
  for (const edge of snapshot.edges) {
    if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) continue;
    if (edge.resolution === "unresolved") continue; // spekülatif kısıt yok
    if (!dependencyAdjacency.has(edge.from)) continue;
    if (!dependencyAdjacency.has(edge.to)) continue;
    dependencyAdjacency.get(edge.from)?.push(edge.to);
    dependencyEdges.push({ from: edge.from, to: edge.to });
  }
  // Komşu listelerini kanonik sıraya sabitle (DFS sırası deterministik).
  for (const neighbors of dependencyAdjacency.values()) {
    neighbors.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const rawComponents = tarjanStronglyConnectedComponents(dependencyAdjacency);
  const membersOf = new Map<string, GraphNode[]>();
  for (const component of rawComponents) {
    const members = component
      .map((id) => nodesById.get(id))
      .filter((node): node is GraphNode => node !== undefined)
      .sort(compareNodeKey);
    const representative = members[0];
    if (representative === undefined) continue;
    membersOf.set(representative.id, members);
  }
  // Bileşen kimlikleri: representative leksik sırasına göre 0-based.
  const orderedReps = [...membersOf.keys()].sort((a, b) => {
    const nodeA = nodesById.get(a);
    const nodeB = nodesById.get(b);
    if (nodeA === undefined || nodeB === undefined) return a < b ? -1 : 1;
    return compareNodeKey(nodeA, nodeB);
  });
  const componentIdOf = new Map<string, number>();
  const componentMembers = new Map<number, readonly GraphNode[]>();
  orderedReps.forEach((repId, index) => {
    componentIdOf.set(repId, index);
    componentMembers.set(index, membersOf.get(repId) ?? []);
    for (const member of membersOf.get(repId) ?? []) {
      componentIdOf.set(member.id, index);
    }
  });

  // Yoğunlaştırılmış "öğrenme-sonrası" kenarları: A→B bağımlılık kenarı,
  // B bileşeni A bileşeninden önce öğrenilir (B_comp → A_comp).
  const condensationEdges = new Set<string>();
  const condensationOut = new Map<number, number[]>();
  const condensationIn = new Map<number, number>();
  for (let index = 0; index < orderedReps.length; index += 1) {
    condensationOut.set(index, []);
    condensationIn.set(index, 0);
  }
  for (const { from, to } of dependencyEdges) {
    const fromComp = componentIdOf.get(from);
    const toComp = componentIdOf.get(to);
    if (fromComp === undefined || toComp === undefined || fromComp === toComp) {
      continue;
    }
    // from (bağımlı) to'dan SONRA öğrenilir: to_comp → from_comp.
    const key = `${toComp}->${fromComp}`;
    if (condensationEdges.has(key)) continue;
    condensationEdges.add(key);
    condensationOut.get(toComp)?.push(fromComp);
    condensationIn.set(fromComp, (condensationIn.get(fromComp) ?? 0) + 1);
  }
  for (const neighbors of condensationOut.values()) neighbors.sort((a, b) => a - b);

  // Kahn: among the ready components the one whose representative is
  // lexically smallest is taken next (deterministic tie-break). Component
  // ids are assigned in that lexical order, so a min-heap on the id gives the
  // same order in O((V + E) log V) instead of re-sorting the ready list on
  // every step.
  const ready = new ComponentMinHeap();
  for (const [comp, incomingCount] of condensationIn) {
    if (incomingCount === 0) ready.push(comp);
  }
  const orderedComponents: number[] = [];
  while (ready.size > 0) {
    const next = ready.pop();
    if (next === undefined) break;
    orderedComponents.push(next);
    for (const neighbor of condensationOut.get(next) ?? []) {
      const remaining = (condensationIn.get(neighbor) ?? 1) - 1;
      condensationIn.set(neighbor, remaining);
      if (remaining === 0) ready.push(neighbor);
    }
  }

  const learningOrder: LearningStep[] = [];
  let orderNumber = 0;
  for (const comp of orderedComponents) {
    const members = componentMembers.get(comp) ?? [];
    for (const member of members) {
      orderNumber += 1;
      if (learningOrder.length >= limits.maxLearningSteps) break;
      learningOrder.push({
        ...withRelativePath(member, {
          order: orderNumber,
          nodeId: member.id,
          kind: member.kind,
          qualifiedName: member.qualifiedName,
          componentId: comp,
          componentSize: members.length,
        }),
      });
    }
    if (learningOrder.length >= limits.maxLearningSteps) break;
  }
  const totalLearningSteps = orderedComponents.reduce(
    (sum, comp) => sum + (componentMembers.get(comp)?.length ?? 0),
    0,
  );
  if (totalLearningSteps > limits.maxLearningSteps) {
    warnings.push({
      code: "onboarding/learning-order-truncated",
      message: `Learning order was clamped to the ceiling: showing ${limits.maxLearningSteps}/${totalLearningSteps} steps.`,
    });
  }

  // 5) Kritik akışlar (yalnızca maintainer): endpoint → verified zincir.
  // Tek zincir izlenir: her derinlikte leksik en küçük komşu seçilir
  // (deterministik; tüm komşu ağacı raporlanmaz, o trace/explorer işidir).
  const outgoingFlow = new Map<string, { to: string; name: string }[]>();
  if (input.profile === "maintainer") {
    for (const edge of snapshot.edges) {
      if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;
      if (edge.resolution !== "verified") continue;
      const toNode = nodesById.get(edge.to);
      if (toNode === undefined) continue;
      const list = outgoingFlow.get(edge.from) ?? [];
      list.push({ to: edge.to, name: toNode.qualifiedName });
      outgoingFlow.set(edge.from, list);
    }
    for (const list of outgoingFlow.values()) {
      list.sort((a, b) =>
        a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.to < b.to ? -1 : 1,
      );
    }
  }
  const criticalFlows: OnboardingCriticalFlow[] = [];
  if (input.profile === "maintainer") {
    let visitedBudget = MAX_CRITICAL_FLOW_NODES;
    for (const endpoint of sortedNodes) {
      if (criticalFlows.length >= limits.maxCriticalFlows) break;
      if (endpoint.kind !== "Endpoint") continue;
      if (visitedBudget <= 0) break;
      const steps: { nodeId: string; qualifiedName: string; depth: number }[] = [];
      const visited = new Set<string>([endpoint.id]);
      let current: { id: string; name: string } | undefined = {
        id: endpoint.id,
        name: endpoint.qualifiedName,
      };
      for (let depth = 1; depth <= MAX_CRITICAL_FLOW_DEPTH; depth += 1) {
        const nextStep = (outgoingFlow.get(current?.id ?? "") ?? []).find(
          (neighbor) => !visited.has(neighbor.to),
        );
        if (nextStep === undefined) break;
        visited.add(nextStep.to);
        visitedBudget -= 1;
        const target = nodesById.get(nextStep.to);
        if (target === undefined) break;
        steps.push({
          nodeId: target.id,
          qualifiedName: target.qualifiedName,
          depth,
        });
        current = { id: target.id, name: target.qualifiedName };
      }
      if (steps.length > 0) {
        criticalFlows.push({
          entryNodeId: endpoint.id,
          entryQualifiedName: endpoint.qualifiedName,
          steps,
        });
      }
    }
  }

  // 6) Testler (yalnızca maintainer): Test node'ları + TESTS hedefleri.
  const tests: OnboardingTestEntry[] = [];
  if (input.profile === "maintainer") {
    const testedTargets = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      if (edge.kind !== "TESTS") continue;
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (fromNode?.kind !== "Test" || toNode === undefined) continue;
      const list = testedTargets.get(fromNode.id) ?? [];
      if (!list.includes(toNode.qualifiedName)) {
        list.push(toNode.qualifiedName);
      }
      testedTargets.set(fromNode.id, list);
    }
    for (const node of sortedNodes) {
      if (tests.length >= MAX_TEST_ENTRIES) break;
      if (node.kind !== "Test") continue;
      tests.push({
        nodeId: node.id,
        qualifiedName: node.qualifiedName,
        testedQualifiedNames: (testedTargets.get(node.id) ?? []).sort(),
      });
    }
  }

  // 7) Bilinmeyen kenarlar (intermediate/maintainer): çözüm düzeyine göre.
  const unknownEdges: OnboardingUnknownEdges[] = [];
  if (input.profile === "intermediate" || input.profile === "maintainer") {
    for (const resolution of ["heuristic", "unresolved"] as const) {
      const affected = new Set<string>();
      let count = 0;
      for (const edge of snapshot.edges) {
        if (edge.resolution !== resolution) continue;
        count += 1;
        const fromNode = nodesById.get(edge.from);
        const toNode = nodesById.get(edge.to);
        if (fromNode !== undefined) affected.add(fromNode.qualifiedName);
        if (toNode !== undefined) affected.add(toNode.qualifiedName);
      }
      if (count === 0) continue;
      unknownEdges.push({
        resolution,
        edgeCount: count,
        affectedNodes: [...affected].sort().slice(0, MAX_UNKNOWN_EDGE_NODES),
      });
    }
  }

  // 8) Riskli alanlar: unresolved kenar uçları (her profilde).
  const unresolvedCount = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (edge.resolution !== "unresolved") continue;
    for (const endpointId of [edge.from, edge.to]) {
      unresolvedCount.set(
        endpointId,
        (unresolvedCount.get(endpointId) ?? 0) + 1,
      );
    }
  }
  const riskAreas: OnboardingRiskArea[] = sortedNodes
    .filter((node) => (unresolvedCount.get(node.id) ?? 0) > 0)
    .map((node) => ({
      nodeId: node.id,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      unresolvedEdgeCount: unresolvedCount.get(node.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.unresolvedEdgeCount - a.unresolvedEdgeCount ||
        (a.qualifiedName !== b.qualifiedName
          ? a.qualifiedName < b.qualifiedName
            ? -1
            : 1
          : a.nodeId < b.nodeId
            ? -1
            : 1),
    )
    .slice(0, MAX_RISK_AREAS);

  return {
    profile: input.profile,
    snapshotId: snapshot.meta.id,
    snapshotState: snapshot.meta.state,
    entryPoints,
    topModules,
    learningOrder,
    criticalFlows,
    tests,
    unknownEdges,
    riskAreas,
    warnings,
  };
}
