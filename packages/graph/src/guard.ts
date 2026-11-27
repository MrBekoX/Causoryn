import {
  NODE_KINDS,
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";

import type {
  ArchitectureBaseline,
  ArchitecturePolicy,
  ForbiddenDependencyRule,
  GuardGlob,
  GuardSeverity,
  NoCyclesRule,
  SuppressionEntry,
} from "./guard-policy-schema.js";
import { GuardError } from "./guard-policy-schema.js";

/**
 * Architecture Guard değerlendirme çekirdeği — TŞ v2.1 §12, sprint-3 C2
 * (`causoryn_check_architecture` motoru; MCP zarfı mcp-server katmanındadır).
 *
 * SAF FONKSİYON SÖZLEŞMESİ: bu modül fs/ağ/saat/rastgelelik okumaz, girdi
 * nesnelerini mutate etmez, MCP tipi import etmez. Aynı (snapshot, policy,
 * baseline) girdisi her zaman birebir aynı bulgu listesini üretir.
 *
 * Determinizm kararları:
 * - Tarjan SCC (Tarjan 1972, SIAM J. Comput. 1(2):146–160; kanıt:
 *   raw/context-inject/papers/tarjan-scc-dfs-siam-joc-1972.md) YINELEMELİ
 *   (iterative) gerçeklenir; dolaşım sırası sıralı node ID'leridir.
 * - Bulgu sırası (ruleId, from, to, id) bayt sıralıdır; node/edge dizi
 *   sırası sonucu etkilemez.
 * - Bulgu kimliği `finding:<sha256>` biçimindedir ve yalnızca kural + ihlal
 *   kimliğinden türetilir (snapshotId içermez; ihlal kimliği
 *   snapshot'lar arası karşılaştırılabilir kalır).
 * - Suppression eşleşmesi baseline dizi sırasındaki İLK uyan giriştir.
 *
 * no-cycles bulgu biçimi (TŞ §12 finding sözleşmesi): SCC üyelerinin
 * lexical en küçük qualifiedName'i temsilcidir; `from` ve `to` temsilciye,
 * `cycle` sıralı üye listesine eşittir. Kenar türü filtresi
 * (rule.edgeKinds) hem SCC grafına hem kanıt birleşimine uygulanır.
 * Suppression'ın from/to glob'ları SCC üye kümesinden EN AZ BİR üyeye
 * eşleşiyorsa döngü baskılanır (belgelenmiş yönetişim kuralı).
 */

/** TŞ §12 finding sözleşmesindeki suppression bloğu (neden/sahip/tarih). */
export interface GuardFindingSuppression {
  readonly reason: string;
  readonly owner: string;
  readonly date: string;
}

/** Tek guard bulgusu (TŞ §12: {id, ruleId, severity, from, to, evidenceIds, suppression?, snapshotId}). */
export interface GuardFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleType: "no-cycles" | "forbidden-dependency";
  readonly severity: GuardSeverity;
  /** İhlal kaynağı node'un qualifiedName'i (no-cycles'ta SCC temsilcisi). */
  readonly from: string;
  /** İhlal hedefi node'un qualifiedName'i (no-cycles'ta SCC temsilcisi). */
  readonly to: string;
  /** location.relativePath varsa taşınır (path tabanlı gerekçeler için). */
  readonly fromPath?: string;
  readonly toPath?: string;
  /** İhlali destekleyen kenar kanıt ID'leri (sıralı, tekrarsız). */
  readonly evidenceIds: readonly string[];
  /** Yalnızca no-cycles: SCC üyelerinin qualifiedName'leri (sıralı). */
  readonly cycle?: readonly string[];
  /** Suppression eşleşti mi (yönetişim raporlaması için her zaman taşınır). */
  readonly suppressed: boolean;
  /** Yalnızca suppressed=true iken taşınır; eşleşme gerekçesi. */
  readonly suppression?: GuardFindingSuppression;
  readonly snapshotId: string;
}

/**
 * scope etiketinin node tür kümelerine anlamı (belgelenmiş yorum — TŞ §12
 * örneğindeki `scope: modules` değerinin karşılığı; "all" varsayılandır).
 */
const SCOPE_NODE_KINDS: Readonly<
  Record<"modules" | "files" | "all", ReadonlySet<GraphNode["kind"]>>
> = {
  modules: new Set<GraphNode["kind"]>(["Module", "Package", "Namespace"]),
  files: new Set<GraphNode["kind"]>(["File"]),
  all: new Set<GraphNode["kind"]>(NODE_KINDS),
};

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Appends `values` one by one. The analysed repository sets how many evidence
 * ids one edge carries (one per merged call site); spreading them into
 * `push(...values)` above V8's argument limit throws RangeError (security
 * scan F47).
 */
function appendAll(target: string[], values: readonly string[]): void {
  for (const value of values) target.push(value);
}

function normalizeSeparators(value: string): string {
  return value.includes("\\") ? value.replaceAll("\\", "/") : value;
}

/**
 * Node iki aday yüzeyden biriyle eşleşir: `location.relativePath`
 * (`\` → `/` normalize) veya `qualifiedName` — belgelenmiş eşleşme yüzeyi.
 */
function nodeMatches(node: GraphNode, glob: GuardGlob): boolean {
  if (glob.matches(node.qualifiedName)) return true;
  const relativePath = node.location?.relativePath;
  if (
    relativePath !== undefined &&
    glob.matches(normalizeSeparators(relativePath))
  ) {
    return true;
  }
  return false;
}

/** Baseline'da ruleId'si uyan ve koşulu geçen İLK suppression girişi. */
function findSuppression(
  baseline: ArchitectureBaseline,
  ruleId: string,
  satisfies: (entry: SuppressionEntry) => boolean,
): SuppressionEntry | undefined {
  return baseline.suppressions.find(
    (entry) => entry.ruleId === ruleId && satisfies(entry),
  );
}

function makeFindingId(
  ruleId: string,
  ruleType: string,
  from: string,
  to: string,
  cycle: readonly string[] | undefined,
): string {
  const hash = sha256Hex(
    utf8Encode(canonicalJson([ruleId, ruleType, from, to, cycle ?? null])),
  );
  return `finding:${hash}`;
}

function buildFinding(input: {
  readonly ruleId: string;
  readonly ruleType: GuardFinding["ruleType"];
  readonly severity: GuardSeverity;
  readonly fromNode: GraphNode;
  readonly toNode: GraphNode;
  readonly evidenceIds: readonly string[];
  readonly cycle?: readonly string[];
  readonly snapshotId: string;
  readonly suppression: SuppressionEntry | undefined;
}): GuardFinding {
  const fromPath = input.fromNode.location?.relativePath;
  const toPath = input.toNode.location?.relativePath;
  const { suppression } = input;
  return {
    id: makeFindingId(
      input.ruleId,
      input.ruleType,
      input.fromNode.qualifiedName,
      input.toNode.qualifiedName,
      input.cycle,
    ),
    ruleId: input.ruleId,
    ruleType: input.ruleType,
    severity: input.severity,
    from: input.fromNode.qualifiedName,
    to: input.toNode.qualifiedName,
    ...(fromPath === undefined ? {} : { fromPath }),
    ...(toPath === undefined ? {} : { toPath }),
    evidenceIds: input.evidenceIds,
    ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
    suppressed: suppression !== undefined,
    ...(suppression === undefined
      ? {}
      : {
          suppression: {
            reason: suppression.reason,
            owner: suppression.owner,
            date: suppression.date,
          },
        }),
    snapshotId: input.snapshotId,
  };
}

function findingComparator(a: GuardFinding, b: GuardFinding): number {
  return (
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Yayınlanmış snapshot üzerinde policy kurallarını değerlendirir.
 * Girdiler `parseArchitecturePolicy`/`parseArchitectureBaseline` çıktısı
 * olmalıdır (globlar burada yeniden derlenmez). Çıktı deterministik
 * sıralıdır; girdiler mutate edilmez.
 */
export function findViolations(
  snapshot: SnapshotGraph,
  policy: ArchitecturePolicy,
  baseline: ArchitectureBaseline,
): GuardFinding[] {
  if (
    typeof snapshot?.meta?.id !== "string" ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.edges)
  ) {
    throw new GuardError(
      "guard/invalid-input",
      "findViolations: invalid snapshot input (meta.id, nodes and edges are required)",
    );
  }

  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);

  const orderedEdges = [...snapshot.edges].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const orderedNodes = [...snapshot.nodes].sort((a, b) =>
    compareStrings(a.id, b.id),
  );

  const findings: GuardFinding[] = [];

  for (const rule of policy.rules) {
    if (rule.type === "no-cycles") {
      findings.push(
        ...evaluateNoCycles(rule, orderedNodes, orderedEdges, snapshot, baseline),
      );
    } else {
      findings.push(
        ...evaluateForbiddenDependency(
          rule,
          orderedEdges,
          nodeById,
          snapshot,
          baseline,
        ),
      );
    }
  }

  return findings.sort(findingComparator);
}

/**
 * Yönetişim yüzeyi: policy'de karşılığı olmayan `ruleId`'li suppression
 * girişlerini döndürür (bayat baseline denetimi). Bulgu üretimi bu
 * girişleri zaten sessizce yok sayar — bu işlev onları görünür kılar;
 * MCP katmanı çıktı metadata'sında raporlayabilir. Saf ve deterministiktir;
 * sıra baseline dizi sırasıdır.
 */
export function findOrphanSuppressions(
  policy: ArchitecturePolicy,
  baseline: ArchitectureBaseline,
): SuppressionEntry[] {
  const ruleIds = new Set(policy.rules.map((rule) => rule.id));
  return baseline.suppressions.filter((entry) => !ruleIds.has(entry.ruleId));
}

/** SCC üyeleri arasında kalan, kuralın kenar türlerinden kenar kanıtları. */
function cycleEvidenceIds(
  edges: readonly GraphEdge[],
  members: ReadonlySet<string>,
  edgeKinds: ReadonlySet<EdgeKind>,
): string[] {
  const collected: string[] = [];
  for (const edge of edges) {
    if (!edgeKinds.has(edge.kind)) continue;
    if (!members.has(edge.from) || !members.has(edge.to)) continue;
    appendAll(collected, edge.evidenceIds);
  }
  return sortedUnique(collected);
}

function evaluateNoCycles(
  rule: NoCyclesRule,
  orderedNodes: readonly GraphNode[],
  orderedEdges: readonly GraphEdge[],
  snapshot: SnapshotGraph,
  baseline: ArchitectureBaseline,
): GuardFinding[] {
  const scopeKinds = SCOPE_NODE_KINDS[rule.scope];
  const scopedNodes = orderedNodes.filter((node) => scopeKinds.has(node.kind));
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const edgeKinds = new Set<EdgeKind>(rule.edgeKinds);

  // Kenarlar: iki ucu da kapsam içinde ve türü kuralın listesinde.
  const scopedEdges = orderedEdges.filter(
    (edge) =>
      edgeKinds.has(edge.kind) &&
      scopedIds.has(edge.from) &&
      scopedIds.has(edge.to),
  );

  const adjacency = new Map<string, string[]>();
  for (const node of scopedNodes) adjacency.set(node.id, []);
  for (const edge of scopedEdges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort(compareStrings); // deterministik dolaşım sırası
  }

  const findings: GuardFinding[] = [];
  for (const component of tarjanStronglyConnectedComponents(
    scopedNodes.map((node) => node.id),
    adjacency,
  )) {
    const isSelfLoop =
      component.length === 1 &&
      component[0] !== undefined &&
      scopedEdges.some(
        (edge) => edge.from === component[0] && edge.to === component[0],
      );
    if (component.length < 2 && !isSelfLoop) continue;

    const members = new Set(component);
    const memberNodes = component
      .map((id) => nodeByIdFrom(scopedNodes, id))
      .filter((node): node is GraphNode => node !== undefined)
      .sort(
        (a, b) =>
          compareStrings(a.qualifiedName, b.qualifiedName) ||
          compareStrings(a.id, b.id),
      );
    const representative = memberNodes[0];
    if (representative === undefined) continue;

    const cycleNames = sortedUnique(
      memberNodes.map((node) => node.qualifiedName),
    );
    const evidenceIds = cycleEvidenceIds(scopedEdges, members, edgeKinds);

    const suppression = findSuppression(baseline, rule.id, (entry) =>
      isCycleSuppressed(entry, memberNodes),
    );

    findings.push(
      buildFinding({
        ruleId: rule.id,
        ruleType: "no-cycles",
        severity: rule.severity,
        fromNode: representative,
        toNode: representative,
        evidenceIds,
        cycle: cycleNames,
        snapshotId: snapshot.meta.id,
        suppression,
      }),
    );
  }
  return findings;
}

/** Suppression'ın from/to glob'u SCC üyelerinden en az birine eşleşmeli. */
function isCycleSuppressed(
  entry: SuppressionEntry,
  memberNodes: readonly GraphNode[],
): boolean {
  // Const yereller: kapanış (closure) içinde daralma (narrowing) korunur.
  const from = entry.from;
  const to = entry.to;
  return (
    (from === undefined || memberNodes.some((node) => nodeMatches(node, from))) &&
    (to === undefined || memberNodes.some((node) => nodeMatches(node, to)))
  );
}

function nodeByIdFrom(
  nodes: readonly GraphNode[],
  id: string,
): GraphNode | undefined {
  return nodes.find((node) => node.id === id);
}

function evaluateForbiddenDependency(
  rule: ForbiddenDependencyRule,
  orderedEdges: readonly GraphEdge[],
  nodeById: ReadonlyMap<string, GraphNode>,
  snapshot: SnapshotGraph,
  baseline: ArchitectureBaseline,
): GuardFinding[] {
  const edgeKinds = new Set<EdgeKind>(rule.edgeKinds);

  // (fromId, toId) çiftine grupla: aynı çiftte birden çok uygun kenar tek
  // bulguda birleşir (kanıt ID'leri birleşir) — deterministik.
  const matched = new Map<
    string,
    { from: GraphNode; to: GraphNode; evidence: string[] }
  >();

  for (const edge of orderedEdges) {
    if (!edgeKinds.has(edge.kind)) continue;
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    // Savunmalı: finalized snapshot'ta dangling kenar olamaz; yine de atla.
    if (fromNode === undefined || toNode === undefined) continue;
    if (!nodeMatches(fromNode, rule.from)) continue;
    if (!nodeMatches(toNode, rule.to)) continue;

    const key = `${edge.from}\u0000${edge.to}`;
    const bucket = matched.get(key);
    if (bucket === undefined) {
      matched.set(key, {
        from: fromNode,
        to: toNode,
        evidence: [...edge.evidenceIds],
      });
    } else {
      appendAll(bucket.evidence, edge.evidenceIds);
    }
  }

  const findings: GuardFinding[] = [];
  for (const bucket of matched.values()) {
    const { from, to } = bucket;
    const suppression = findSuppression(
      baseline,
      rule.id,
      (entry) =>
        (entry.from === undefined || nodeMatches(from, entry.from)) &&
        (entry.to === undefined || nodeMatches(to, entry.to)),
    );
    findings.push(
      buildFinding({
        ruleId: rule.id,
        ruleType: "forbidden-dependency",
        severity: rule.severity,
        fromNode: from,
        toNode: to,
        evidenceIds: sortedUnique(bucket.evidence),
        snapshotId: snapshot.meta.id,
        suppression,
      }),
    );
  }
  return findings;
}

/**
 * Yinelemeli Tarjan SCC — derin özyineleme yığını olmadan; deterministik
 * dolaşım çağıranın verdiği (sıralı) node listesini izler. Dönüş: SCC
 * listesi (keşif sırası; bulgu aşaması sıralamadan bağımsızdır).
 */
function tarjanStronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const orderIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  interface DfsFrame {
    readonly node: string;
    readonly children: readonly string[];
    next: number;
  }

  for (const root of nodes) {
    if (orderIndex.has(root)) continue;
    orderIndex.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    const frames: DfsFrame[] = [
      { node: root, children: adjacency.get(root) ?? [], next: 0 },
    ];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break; // erişilemez; döngü güvencesi

      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next];
        frame.next += 1;
        if (child === undefined) continue;
        if (!orderIndex.has(child)) {
          orderIndex.set(child, counter);
          lowLink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({
            node: child,
            children: adjacency.get(child) ?? [],
            next: 0,
          });
        } else if (onStack.has(child)) {
          const childLow = lowLink.get(child) ?? 0;
          const currentLow = lowLink.get(frame.node) ?? 0;
          if (childLow < currentLow) lowLink.set(frame.node, childLow);
        }
        continue;
      }

      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        if (parent !== undefined) {
          const frameLow = lowLink.get(frame.node) ?? 0;
          const parentLow = lowLink.get(parent.node) ?? 0;
          if (frameLow < parentLow) lowLink.set(parent.node, frameLow);
        }
      }
      if (lowLink.get(frame.node) === orderIndex.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }

  return components;
}
