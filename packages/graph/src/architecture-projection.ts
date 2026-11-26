import { z } from "zod";

import type {
  Evidence,
  GraphNode,
  Resolution,
  SnapshotGraph,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";

function normalizePosixPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) === 47) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) === 47) end -= 1;
  return normalized.slice(start, end);
}

/**
 * Deterministik adaptif mimari projeksiyonu (`packages/graph`).
 *
 * Ham AST/sembol grafı büyük repolarda on binlerce düğüm (`UnknownExternal`,
 * tekil metotlar, yüzlerce dosya) içerebilir. Bu modül herhangi bir SnapshotGraph'ı
 * sıfır repo-özel varsayımla, byte-deterministik biçimde okunabilir bir modül/katman
 * mimari modeline indirger:
 * - `UnknownExternal` ve `Workspace`/`Repository` düğümleri mimari kutu olarak
 *   gürültü üretmez; dış sınırlar `externalSummary` içinde dürüstçe özetlenir.
 * - İç düğümler göreceli dosya yolu ağacında adaptif bölme ile `maxModules`
 *   tavanı içinde kalacak en bilgilendirici modül/bileşen sınırlarına toplanır.
 * - Modüller arası kenarlar ağırlıklı tek okta birleştirilir, çözüm dağılımı
 *   (`verified` / `heuristic` / `unresolved`) ve temsilî kanıtlar korunur.
 * - Tarjan SCC ile modül düzeyi döngüsel bağımlılıklar tespit edilir ve yoğunlaşmış
 *   DAG üzerinde topolojik katman sırası (`layer 0..L`) hesaplanır.
 */

export const ARCHITECTURE_DEFAULT_MAX_MODULES = 32;
export const ARCHITECTURE_MIN_MODULES = 2;
export const ARCHITECTURE_MAX_MODULES = 100;

export const ArchitectureProjectionOptionsSchema = z
  .strictObject({
    maxModules: z
      .number()
      .int()
      .min(ARCHITECTURE_MIN_MODULES)
      .max(ARCHITECTURE_MAX_MODULES)
      .optional()
      .describe(
        `Maximum number of aggregated architecture modules (${ARCHITECTURE_MIN_MODULES}–${ARCHITECTURE_MAX_MODULES}, default ${ARCHITECTURE_DEFAULT_MAX_MODULES}).`,
      ),
    pathPrefix: z
      .string()
      .min(1)
      .max(260)
      .refine(
        (v) =>
          v.trim().length > 0 &&
          !v.includes("..") &&
          !v.includes("\0") &&
          normalizePosixPath(v).length > 0,
        {
          message: "pathPrefix must be a valid relative path prefix",
        },
      )
      .optional()
      .describe("Optional relative POSIX directory prefix to focus the architecture projection on a subsystem (e.g., 'src/api' or 'packages/domain')."),
    includeTests: z
      .boolean()
      .optional()
      .describe(
        "Include test files and test modules in the projected architecture graph (default true; set false to exclude test files and test modules).",
      ),
  })
  .describe("Optional deterministic projection settings for 'architecture' and 'interactive' views.");

export type ArchitectureProjectionOptions = z.infer<typeof ArchitectureProjectionOptionsSchema>;

export interface ProjectedSymbolRef {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
  readonly startLine?: number;
}

export interface ProjectedModuleCounts {
  readonly files: number;
  readonly classes: number;
  readonly interfaces: number;
  readonly functions: number;
  readonly methods: number;
  readonly endpoints: number;
  readonly handlers: number;
  readonly tests: number;
  readonly contracts: number;
  readonly totalSymbols: number;
}

export interface ProjectedModule {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly group: string;
  readonly primaryLanguage: string;
  readonly languages: readonly string[];
  readonly isTest: boolean;
  readonly layer: number;
  readonly counts: ProjectedModuleCounts;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly internalEdges: number;
  readonly unresolvedEdges: number;
  readonly files: readonly string[];
  readonly keySymbols: readonly ProjectedSymbolRef[];
  readonly evidenceIds: readonly string[];
}

export interface ProjectedEdgeKindCount {
  readonly kind: string;
  readonly count: number;
}

export interface ProjectedResolutionCounts {
  readonly verified: number;
  readonly heuristic: number;
  readonly unresolved: number;
}

export interface ProjectedModuleEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly resolution: Resolution;
  readonly resolutionCounts: ProjectedResolutionCounts;
  readonly kinds: readonly ProjectedEdgeKindCount[];
  readonly isCycle: boolean;
  readonly evidenceIds: readonly string[];
}

export interface ProjectedCycle {
  readonly id: string;
  readonly moduleIds: readonly string[];
  readonly edgeCount: number;
}

export interface ProjectedEntrypoint {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly moduleId: string;
  readonly language?: string;
  readonly relativePath?: string;
  readonly startLine?: number;
}

export interface ProjectedContract {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly moduleId: string;
  readonly relativePath?: string;
  readonly startLine?: number;
}

export interface ProjectedFlowStep {
  readonly nodeId: string;
  readonly moduleId?: string;
  readonly kind: string;
  readonly qualifiedName: string;
  readonly depth: number;
}

export interface ProjectedFlow {
  readonly id: string;
  readonly entryNodeId: string;
  readonly entryModuleId?: string;
  readonly entryQualifiedName: string;
  readonly steps: readonly ProjectedFlowStep[];
}

export interface ExternalTargetSummary {
  readonly qualifiedName: string;
  readonly language?: string;
  readonly inboundEdgeCount: number;
}

export interface ExternalBoundarySummary {
  readonly nodeCount: number;
  readonly unresolvedEdgeCount: number;
  readonly topExternalTargets: readonly ExternalTargetSummary[];
}

export interface RiskHotspot {
  readonly moduleId: string;
  readonly label: string;
  readonly reason: "cycle" | "high-fan-in" | "high-fan-out" | "unresolved-edges";
  readonly score: number;
  readonly detail: string;
}

export interface ProjectedEvidenceRecord {
  readonly id: string;
  readonly kind: string;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
  readonly span?: {
    readonly relativePath: string;
    readonly startLine: number;
    readonly endLine: number;
  };
}

export interface ProjectedLanguageCount {
  readonly language: string;
  readonly fileCount: number;
  readonly nodeCount: number;
}

export interface ArchitectureSummaryStats {
  readonly totalRawNodes: number;
  readonly totalRawEdges: number;
  readonly totalRawEvidence: number;
  readonly analyzedFiles: number;
  readonly moduleCount: number;
  readonly moduleEdgeCount: number;
  readonly cycleCount: number;
  readonly entrypointCount: number;
  readonly contractCount: number;
  readonly flowCount: number;
  readonly resolutionCounts: ProjectedResolutionCounts;
  readonly languages: readonly ProjectedLanguageCount[];
  readonly maxModulesApplied: number;
  readonly pathPrefixApplied?: string;
}

export interface ArchitectureProjection {
  readonly meta: SnapshotGraph["meta"];
  readonly summary: ArchitectureSummaryStats;
  readonly modules: readonly ProjectedModule[];
  readonly edges: readonly ProjectedModuleEdge[];
  readonly cycles: readonly ProjectedCycle[];
  readonly entrypoints: readonly ProjectedEntrypoint[];
  readonly contracts: readonly ProjectedContract[];
  readonly deterministicFlows: readonly ProjectedFlow[];
  readonly externalSummary: ExternalBoundarySummary;
  readonly riskHotspots: readonly RiskHotspot[];
  readonly evidenceCatalog: Readonly<Record<string, ProjectedEvidenceRecord>>;
}

const META_ROOT_KINDS: ReadonlySet<GraphNode["kind"]> = new Set([
  "Workspace",
  "Repository",
]);

const CONTRACT_AND_DATA_KINDS: ReadonlySet<GraphNode["kind"]> = new Set([
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
  "Database",
  "Table",
  "Event",
  "Topic",
  "Queue",
]);

const ENTRYPOINT_KINDS: ReadonlySet<GraphNode["kind"]> = new Set([
  "Endpoint",
  "Handler",
]);

const SYMBOL_PRIORITY: Readonly<Partial<Record<GraphNode["kind"], number>>> = {
  Endpoint: 100,
  ApiContract: 95,
  EventContract: 95,
  SchemaContract: 92,
  Handler: 90,
  Database: 85,
  Table: 82,
  Event: 80,
  Topic: 80,
  Queue: 80,
  Class: 70,
  Interface: 68,
  Module: 65,
  Project: 65,
  Function: 60,
  Method: 55,
  Type: 45,
  Test: 35,
  Config: 30,
  File: 10,
};

const MAX_KEY_SYMBOLS_PER_MODULE = 12;
const MAX_EVIDENCE_PER_MODULE = 12;
const MAX_EVIDENCE_PER_EDGE = 8;
const MAX_ENTRYPOINTS = 100;
const MAX_CONTRACTS = 100;
const MAX_TOP_EXTERNALS = 20;
const MAX_RISK_HOTSPOTS = 15;

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function matchesPrefix(relativePath: string, normalizedPrefix: string): boolean {
  return (
    relativePath === normalizedPrefix ||
    relativePath.startsWith(`${normalizedPrefix}/`)
  );
}

function isTestPathOrNodes(clusterPath: string, nodes: readonly GraphNode[]): boolean {
  const lower = clusterPath.toLowerCase();
  if (
    /(^|\/|\.)(tests?|specs?|__tests__|e2e)(\/|\.|$)/.test(lower) ||
    lower.endsWith(".tests") ||
    lower.endsWith(".test")
  ) {
    return true;
  }
  const nonFile = nodes.filter((n) => n.kind !== "File");
  if (nonFile.length === 0) return false;
  const testCount = nonFile.filter((n) => n.kind === "Test").length;
  return testCount * 2 >= nonFile.length && testCount > 0;
}

function sanitizeExternalName(raw: string): string {
  const flattened = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flattened.length > 96 ? `${flattened.slice(0, 93)}...` : flattened;
}

/* ------------------------------------------------------------------ */
/* Adaptive directory trie clustering                                  */
/* ------------------------------------------------------------------ */

interface DirTreeNode {
  readonly path: string;
  readonly children: Map<string, DirTreeNode>;
  readonly directFiles: Set<string>;
  totalFiles: number;
}

function makeDirNode(dirPath: string): DirTreeNode {
  return {
    path: dirPath,
    children: new Map(),
    directFiles: new Set(),
    totalFiles: 0,
  };
}

function buildFileTree(filePaths: readonly string[]): DirTreeNode {
  const root = makeDirNode("");
  for (const fp of filePaths) {
    const normalized = normalizePosixPath(fp);
    const parts = normalized.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? "";
      const nextPath = cur.path.length === 0 ? seg : `${cur.path}/${seg}`;
      let child = cur.children.get(seg);
      if (child === undefined) {
        child = makeDirNode(nextPath);
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.directFiles.add(normalized);
  }
  const computeCounts = (node: DirTreeNode): number => {
    let total = node.directFiles.size;
    for (const child of node.children.values()) {
      total += computeCounts(child);
    }
    node.totalFiles = total;
    return total;
  };
  computeCounts(root);
  return root;
}

/** Tek çocuklu boş sarmalayıcı dizinleri (örn. `src/`, `Infrastructure/Infrastructure/`) açar. */
function unwrapSingleChild(node: DirTreeNode): DirTreeNode {
  let cur = node;
  while (cur.directFiles.size === 0 && cur.children.size === 1) {
    const only = cur.children.values().next().value as DirTreeNode | undefined;
    if (only === undefined) break;
    cur = only;
  }
  return cur;
}

/**
 * Every file under `node`, sorted. Walks the subtree with an explicit stack and
 * appends one by one: a directory can hold more files than V8 accepts as
 * spread call arguments (`push(...files)` threw RangeError, security scan F47
 * variant), and the repository sets the tree's depth. One final sort gives
 * the same order the former per-level sorts produced (the paths are unique).
 */
function collectFiles(node: DirTreeNode): string[] {
  const out: string[] = [];
  const pending: DirTreeNode[] = [node];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const file of current.directFiles) out.push(file);
    for (const child of current.children.values()) pending.push(child);
  }
  return out.sort(cmpStr);
}

interface RawCluster {
  readonly key: string;
  readonly isFileLeaf: boolean;
  readonly files: readonly string[];
  readonly treeNode?: DirTreeNode;
}

function splitCandidateChildren(cluster: RawCluster, totalRepoFiles: number, maxModules: number): RawCluster[] | null {
  if (cluster.isFileLeaf || cluster.treeNode === undefined) return null;
  const node = unwrapSingleChild(cluster.treeNode);

  if (node.children.size > 0) {
    const parts: RawCluster[] = [];
    const childKeys = [...node.children.keys()].sort(cmpStr);
    for (const k of childKeys) {
      const child = node.children.get(k);
      if (child === undefined || child.totalFiles === 0) continue;
      const unwrapped = unwrapSingleChild(child);
      parts.push({
        key: unwrapped.path,
        isFileLeaf: false,
        files: collectFiles(unwrapped),
        treeNode: unwrapped,
      });
    }
    if (node.directFiles.size > 0) {
      const direct = [...node.directFiles].sort(cmpStr);
      parts.push({
        key: node.path.length > 0 ? node.path : ".",
        isFileLeaf: true,
        files: direct,
      });
    }
    return parts.length >= 2 ? parts : null;
  }

  // Yaprak dizin: yalnızca toplam repo küçükse ve tavan aşımı yoksa dosya düzeyine böl.
  if (node.directFiles.size >= 2 && totalRepoFiles <= maxModules) {
    const files = [...node.directFiles].sort(cmpStr);
    return files.map((f) => ({
      key: f,
      isFileLeaf: true,
      files: [f],
    }));
  }
  return null;
}

function adaptiveClusterFiles(
  filePaths: readonly string[],
  maxModules: number,
): readonly RawCluster[] {
  if (filePaths.length === 0) return [];
  const root = buildFileTree(filePaths);
  const startNode = unwrapSingleChild(root);

  let clusters: RawCluster[] = [
    {
      key: startNode.path.length > 0 ? startNode.path : ".",
      isFileLeaf: false,
      files: collectFiles(startNode),
      treeNode: startNode,
    },
  ];

  // Öncelik kuyruğu mantığı: en çok dosyaya sahip bölünebilir kümeyi bütçe içinde böl.
  while (clusters.length < maxModules) {
    let bestIdx = -1;
    let bestParts: RawCluster[] | null = null;
    let bestFileCount = -1;
    let bestKey = "";

    for (let i = 0; i < clusters.length; i++) {
      const candidate = clusters[i];
      if (candidate === undefined) continue;
      const parts = splitCandidateChildren(candidate, filePaths.length, maxModules);
      if (parts === null) continue;
      const nextCount = clusters.length - 1 + parts.length;
      if (nextCount > maxModules) continue;

      const count = candidate.files.length;
      if (
        count > bestFileCount ||
        (count === bestFileCount && (bestIdx === -1 || cmpStr(candidate.key, bestKey) < 0))
      ) {
        bestIdx = i;
        bestParts = parts;
        bestFileCount = count;
        bestKey = candidate.key;
      }
    }

    if (bestIdx === -1 || bestParts === null) break;
    clusters = [
      ...clusters.slice(0, bestIdx),
      ...bestParts,
      ...clusters.slice(bestIdx + 1),
    ];
  }

  clusters.sort((a, b) => cmpStr(a.key, b.key));
  return clusters;
}

/** Modül yollarından ortak ön eki atarak kısa, okunur ve çakışmasız etiket üretir. */
function buildModuleLabelsAndGroups(
  paths: readonly string[],
): {
  readonly labels: ReadonlyMap<string, string>;
  readonly groups: ReadonlyMap<string, string>;
} {
  const splitPaths = paths.map((p) => p.split("/"));
  let commonPrefixLen = 0;
  if (splitPaths.length > 1) {
    const first = splitPaths[0] ?? [];
    for (let i = 0; i < first.length - 1; i++) {
      const seg = first[i];
      if (splitPaths.every((sp) => sp.length > i + 1 && sp[i] === seg)) {
        commonPrefixLen = i + 1;
      } else {
        break;
      }
    }
  }

  const trimmedByPath = new Map<string, string[]>();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i] ?? "";
    const segs = splitPaths[i] ?? [p];
    const trimmed = segs.slice(commonPrefixLen);
    trimmedByPath.set(p, trimmed.length > 0 ? trimmed : segs);
  }

  // Grup: ortak ön ek sonrası ilk 1-2 anlamlı konteyner segmenti
  const groups = new Map<string, string>();
  const firstSegCounts = new Map<string, number>();
  for (const segs of trimmedByPath.values()) {
    const first = segs[0] ?? "root";
    firstSegCounts.set(first, (firstSegCounts.get(first) ?? 0) + 1);
  }

  for (const p of paths) {
    const segs = trimmedByPath.get(p) ?? [p];
    const first = segs[0] ?? "root";
    // Çok büyük tek konteyner (örn. backend altında 6+ alt modül) ise 2 segmentli grup kullan
    if (segs.length >= 3 && (firstSegCounts.get(first) ?? 0) >= 6) {
      groups.set(p, `${first}/${segs[1] ?? ""}`);
    } else {
      groups.set(p, first);
    }
  }

  // Ardışık tekrarlı klasör adlarını (örn. Infrastructure/Infrastructure) etiket için sadeleştir
  const collapsedSegs = (segs: readonly string[]): string[] => {
    const out: string[] = [];
    for (const s of segs) {
      if (out.length === 0 || out[out.length - 1] !== s) out.push(s);
    }
    return out.length > 0 ? out : [...segs];
  };

  // Etiket: son 2 benzersiz segment; çakışmada tam kırpılmış yol
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const p of paths) {
    const segs = collapsedSegs(trimmedByPath.get(p) ?? [p]);
    const candidate =
      p === "."
        ? "root"
        : segs.length >= 2
          ? segs.slice(-2).join("/")
          : segs.join("/");
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  for (const p of paths) {
    const rawSegs = trimmedByPath.get(p) ?? [p];
    const segs = collapsedSegs(rawSegs);
    const candidate =
      p === "."
        ? "root"
        : segs.length >= 2
          ? segs.slice(-2).join("/")
          : segs.join("/");
    if ((counts.get(candidate) ?? 0) <= 1) {
      labels.set(p, candidate);
    } else {
      labels.set(p, rawSegs.join("/"));
    }
  }

  return { labels, groups };
}

/* ------------------------------------------------------------------ */
/* Iterative Tarjan SCC + Topological Layer Assignment                 */
/* ------------------------------------------------------------------ */

interface SccResult {
  readonly components: readonly (readonly string[])[];
  readonly compOf: ReadonlyMap<string, number>;
  readonly cycleModuleIds: ReadonlySet<string>;
}

/**
 * Yinelemeli (iterative) Tarjan SCC — derin zincirlerde çağrı yığını taşmaz.
 */
function computeModuleSccs(
  moduleIds: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
): SccResult {
  const sortedIds = [...moduleIds].sort(cmpStr);
  let nextIndex = 0;
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const tarjanStack: string[] = [];
  const rawComponents: string[][] = [];

  interface Frame {
    readonly node: string;
    readonly neighbors: readonly string[];
    nextNeighbor: number;
  }

  for (const startId of sortedIds) {
    if (indexMap.has(startId)) continue;
    indexMap.set(startId, nextIndex);
    lowlink.set(startId, nextIndex);
    nextIndex += 1;
    tarjanStack.push(startId);
    onStack.add(startId);

    const callStack: Frame[] = [
      { node: startId, neighbors: adj.get(startId) ?? [], nextNeighbor: 0 },
    ];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (frame === undefined) break;

      if (frame.nextNeighbor < frame.neighbors.length) {
        const w = frame.neighbors[frame.nextNeighbor];
        frame.nextNeighbor += 1;
        if (w === undefined) continue;

        if (!indexMap.has(w)) {
          indexMap.set(w, nextIndex);
          lowlink.set(w, nextIndex);
          nextIndex += 1;
          tarjanStack.push(w);
          onStack.add(w);
          callStack.push({ node: w, neighbors: adj.get(w) ?? [], nextNeighbor: 0 });
        } else if (onStack.has(w)) {
          const lowV = lowlink.get(frame.node) ?? 0;
          const idxW = indexMap.get(w) ?? 0;
          lowlink.set(frame.node, Math.min(lowV, idxW));
        }
      } else {
        callStack.pop();
        const v = frame.node;
        const lowV = lowlink.get(v) ?? 0;

        if (lowV === indexMap.get(v)) {
          const comp: string[] = [];
          for (;;) {
            const w = tarjanStack.pop();
            if (w === undefined) break;
            onStack.delete(w);
            comp.push(w);
            if (w === v) break;
          }
          comp.sort(cmpStr);
          rawComponents.push(comp);
        }

        const parent = callStack[callStack.length - 1];
        if (parent !== undefined) {
          const lowP = lowlink.get(parent.node) ?? 0;
          lowlink.set(parent.node, Math.min(lowP, lowV));
        }
      }
    }
  }

  rawComponents.sort((a, b) => cmpStr(a[0] ?? "", b[0] ?? ""));
  const compOf = new Map<string, number>();
  const cycleModuleIds = new Set<string>();
  for (let i = 0; i < rawComponents.length; i++) {
    const comp = rawComponents[i];
    if (comp === undefined) continue;
    for (const id of comp) {
      compOf.set(id, i);
      if (comp.length >= 2) cycleModuleIds.add(id);
    }
  }

  return { components: rawComponents, compOf, cycleModuleIds };
}

function computeTopologicalLayers(
  scc: SccResult,
  edges: readonly ProjectedModuleEdge[],
): ReadonlyMap<string, number> {
  const compCount = scc.components.length;
  const dagOut = new Map<number, Set<number>>();
  const inDeg = new Array<number>(compCount).fill(0);
  for (let i = 0; i < compCount; i++) dagOut.set(i, new Set());

  for (const edge of edges) {
    const cu = scc.compOf.get(edge.from);
    const cv = scc.compOf.get(edge.to);
    if (cu === undefined || cv === undefined || cu === cv) continue;
    const outSet = dagOut.get(cu);
    if (outSet !== undefined && !outSet.has(cv)) {
      outSet.add(cv);
      inDeg[cv] = (inDeg[cv] ?? 0) + 1;
    }
  }

  // Kahn topological order + longest-path rank assignment (entry/callers at rank 0 -> targets deeper)
  const queue: number[] = [];
  for (let i = 0; i < compCount; i++) {
    if ((inDeg[i] ?? 0) === 0) queue.push(i);
  }
  const rank = new Array<number>(compCount).fill(0);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head];
    head += 1;
    if (u === undefined) continue;
    const outs = [...(dagOut.get(u) ?? [])].sort((a, b) => a - b);
    for (const v of outs) {
      rank[v] = Math.max(rank[v] ?? 0, (rank[u] ?? 0) + 1);
      inDeg[v] = (inDeg[v] ?? 1) - 1;
      if (inDeg[v] === 0) queue.push(v);
    }
  }

  const layerByModule = new Map<string, number>();
  for (let i = 0; i < compCount; i++) {
    const comp = scc.components[i];
    if (comp === undefined) continue;
    const r = rank[i] ?? 0;
    for (const modId of comp) {
      layerByModule.set(modId, r);
    }
  }
  return layerByModule;
}

/* ------------------------------------------------------------------ */
/* Main projection entry point                                         */
/* ------------------------------------------------------------------ */

function aggregateResolution(counts: ProjectedResolutionCounts): Resolution {
  if (counts.verified > 0) return "verified";
  if (counts.heuristic > 0) return "heuristic";
  return "unresolved";
}

function assertNoDanglingEdges(snapshot: SnapshotGraph): void {
  const ids = new Set(snapshot.nodes.map((n) => n.id));
  for (const edge of snapshot.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new GraphRepositoryError(
        "export/dangling-edge",
        `Edge endpoint points to an unknown node: ${edge.id}`,
      );
    }
  }
}

export function projectArchitecture(
  snapshot: SnapshotGraph,
  rawOptions?: ArchitectureProjectionOptions,
): ArchitectureProjection {
  const parsedOpts = ArchitectureProjectionOptionsSchema.safeParse(rawOptions ?? {});
  if (!parsedOpts.success) {
    const issue = parsedOpts.error.issues[0];
    throw new GraphRepositoryError(
      "export/invalid-options",
      `Invalid architecture projection options: ${issue?.message ?? parsedOpts.error.message}`,
    );
  }
  assertNoDanglingEdges(snapshot);

  const maxModules = parsedOpts.data.maxModules ?? ARCHITECTURE_DEFAULT_MAX_MODULES;
  const includeTests = parsedOpts.data.includeTests ?? true;
  const normalizedPrefix =
    parsedOpts.data.pathPrefix === undefined
      ? undefined
      : normalizePosixPath(parsedOpts.data.pathPrefix);

  // Canonical sort of inputs for strict byte-determinism
  const sortedNodes = [...snapshot.nodes].sort((a, b) => cmpStr(a.id, b.id));
  const sortedEdges = [...snapshot.edges].sort((a, b) => cmpStr(a.id, b.id));
  const sortedEvidence = [...snapshot.evidence].sort((a, b) => cmpStr(a.id, b.id));

  const nodeById = new Map<string, GraphNode>(sortedNodes.map((n) => [n.id, n]));
  const evidenceById = new Map<string, Evidence>(sortedEvidence.map((e) => [e.id, e]));

  // Raw resolution counts & external tracking
  const totalResCounts = { verified: 0, heuristic: 0, unresolved: 0 };
  const externalInboundCounts = new Map<string, number>();
  let externalEdgeCount = 0;

  for (const edge of sortedEdges) {
    totalResCounts[edge.resolution] += 1;
    const toNode = nodeById.get(edge.to);
    if (toNode?.kind === "UnknownExternal") {
      externalEdgeCount += 1;
      externalInboundCounts.set(toNode.id, (externalInboundCounts.get(toNode.id) ?? 0) + 1);
    }
  }

  const externalNodes = sortedNodes.filter((n) => n.kind === "UnknownExternal");
  const topExternalTargets: ExternalTargetSummary[] = externalNodes
    .map((n) => ({
      qualifiedName: sanitizeExternalName(n.qualifiedName),
      ...(n.language === undefined ? {} : { language: n.language }),
      inboundEdgeCount: externalInboundCounts.get(n.id) ?? 0,
    }))
    .sort((a, b) =>
      b.inboundEdgeCount !== a.inboundEdgeCount
        ? b.inboundEdgeCount - a.inboundEdgeCount
        : cmpStr(a.qualifiedName, b.qualifiedName),
    )
    .slice(0, MAX_TOP_EXTERNALS);

  // Filter internal nodes (exclude Workspace/Repository/UnknownExternal)
  const internalNodes: GraphNode[] = [];
  const fileSet = new Set<string>();
  const pathlessNodes: GraphNode[] = [];

  for (const node of sortedNodes) {
    if (META_ROOT_KINDS.has(node.kind) || node.kind === "UnknownExternal") continue;
    const rawRel = node.location?.relativePath;
    if (rawRel !== undefined) {
      const rel = normalizePosixPath(rawRel);
      if (normalizedPrefix !== undefined && !matchesPrefix(rel, normalizedPrefix)) continue;
      internalNodes.push(node);
      fileSet.add(rel);
    } else if (normalizedPrefix === undefined) {
      internalNodes.push(node);
      pathlessNodes.push(node);
    }
  }

  // Language summary across internal files/nodes
  const langFiles = new Map<string, Set<string>>();
  const langNodes = new Map<string, number>();
  for (const node of internalNodes) {
    const lang = node.language ?? "unknown";
    langNodes.set(lang, (langNodes.get(lang) ?? 0) + 1);
    if (node.location?.relativePath !== undefined) {
      let set = langFiles.get(lang);
      if (set === undefined) {
        set = new Set();
        langFiles.set(lang, set);
      }
      set.add(normalizePosixPath(node.location.relativePath));
    }
  }
  const languages: ProjectedLanguageCount[] = [...langNodes.entries()]
    .map(([language, nodeCount]) => ({
      language,
      fileCount: langFiles.get(language)?.size ?? 0,
      nodeCount,
    }))
    .sort((a, b) =>
      b.fileCount !== a.fileCount
        ? b.fileCount - a.fileCount
        : b.nodeCount !== a.nodeCount
          ? b.nodeCount - a.nodeCount
          : cmpStr(a.language, b.language),
    );

  // Adaptive file clustering (strictly respects maxModules even with pathless nodes)
  const sortedFiles = [...fileSet].sort(cmpStr);
  const distinctPathlessKinds = [...new Set(pathlessNodes.map((n) => n.kind))].sort(cmpStr);
  const pathlessReserve =
    pathlessNodes.length === 0
      ? 0
      : sortedFiles.length === 0
        ? maxModules
        : Math.min(Math.max(1, Math.min(distinctPathlessKinds.length, 4)), maxModules - 1);
  const pathBudget = sortedFiles.length === 0 ? 0 : Math.max(1, maxModules - pathlessReserve);
  const fileClusters =
    pathBudget > 0 ? adaptiveClusterFiles(sortedFiles, pathBudget) : [];

  // Assign each internal node to its module cluster
  const fileToClusterKey = new Map<string, string>();
  const clusterFilesByKey = new Map<string, readonly string[]>();
  for (const c of fileClusters) {
    clusterFilesByKey.set(c.key, c.files);
    for (const f of c.files) {
      fileToClusterKey.set(f, c.key);
    }
  }

  // Remaining slots for pathless internal nodes (strictly bounded within maxModules)
  const remainingVirtualSlots = Math.max(0, maxModules - fileClusters.length);
  const pathlessKeyByNodeId = new Map<string, string>();
  if (pathlessNodes.length > 0 && remainingVirtualSlots > 0) {
    const sortedPathless = [...pathlessNodes].sort((a, b) => {
      const k = cmpStr(a.kind, b.kind);
      if (k !== 0) return k;
      const q = cmpStr(a.qualifiedName, b.qualifiedName);
      return q !== 0 ? q : cmpStr(a.id, b.id);
    });
    const distinctVirtualNames = [...new Set(sortedPathless.map((n) => n.qualifiedName))].sort(cmpStr);
    if (distinctVirtualNames.length <= remainingVirtualSlots) {
      for (const n of sortedPathless) {
        pathlessKeyByNodeId.set(n.id, `virtual:${n.qualifiedName}`);
      }
    } else if (distinctPathlessKinds.length <= remainingVirtualSlots) {
      for (const n of sortedPathless) {
        pathlessKeyByNodeId.set(n.id, `virtual:${n.kind}`);
      }
    } else {
      const directKinds = new Set(
        distinctPathlessKinds.slice(0, Math.max(0, remainingVirtualSlots - 1)),
      );
      for (const n of sortedPathless) {
        pathlessKeyByNodeId.set(
          n.id,
          directKinds.has(n.kind) ? `virtual:${n.kind}` : "virtual:other",
        );
      }
    }
  }

  const clusterNodesByKey = new Map<string, GraphNode[]>();
  const nodeIdToClusterKey = new Map<string, string>();

  for (const node of internalNodes) {
    let key: string | undefined;
    if (node.location?.relativePath !== undefined) {
      key = fileToClusterKey.get(normalizePosixPath(node.location.relativePath));
    } else {
      key = pathlessKeyByNodeId.get(node.id);
    }
    if (key === undefined) continue;
    let bucket = clusterNodesByKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      clusterNodesByKey.set(key, bucket);
    }
    bucket.push(node);
    nodeIdToClusterKey.set(node.id, key);
  }

  // Optional test-module filtering
  const activeClusterKeys: string[] = [];
  for (const key of [...clusterNodesByKey.keys()].sort(cmpStr)) {
    const nodes = clusterNodesByKey.get(key) ?? [];
    if (!includeTests && isTestPathOrNodes(key, nodes)) {
      for (const n of nodes) nodeIdToClusterKey.delete(n.id);
      continue;
    }
    activeClusterKeys.push(key);
  }

  const { labels: labelByKey, groups: groupByKey } = buildModuleLabelsAndGroups(activeClusterKeys);
  const moduleIdByKey = new Map<string, string>(activeClusterKeys.map((k) => [k, `mod:${k}`]));
  const nodeToModuleId = new Map<string, string>();
  for (const [nid, key] of nodeIdToClusterKey.entries()) {
    const mid = moduleIdByKey.get(key);
    if (mid !== undefined) nodeToModuleId.set(nid, mid);
  }

  // Compute per-node degree for keySymbol ranking, and aggregate module edges
  const nodeDegree = new Map<string, number>();
  const internalEdgeCountByMod = new Map<string, number>();
  const unresolvedCountByMod = new Map<string, number>();
  const evidenceIdsByMod = new Map<string, Set<string>>();

  interface EdgeAcc {
    readonly from: string;
    readonly to: string;
    weight: number;
    verified: number;
    heuristic: number;
    unresolved: number;
    readonly kinds: Map<string, number>;
    readonly evidenceIds: Set<string>;
  }
  const edgeAccMap = new Map<string, EdgeAcc>();

  const recordModEvidence = (modId: string, evIds: readonly string[]): void => {
    let set = evidenceIdsByMod.get(modId);
    if (set === undefined) {
      set = new Set();
      evidenceIdsByMod.set(modId, set);
    }
    for (const id of evIds) {
      if (evidenceById.has(id)) set.add(id);
    }
  };

  for (const edge of sortedEdges) {
    const fromMod = nodeToModuleId.get(edge.from);
    const toMod = nodeToModuleId.get(edge.to);

    if (fromMod !== undefined) {
      nodeDegree.set(edge.from, (nodeDegree.get(edge.from) ?? 0) + 1);
      if (edge.resolution === "unresolved") {
        unresolvedCountByMod.set(fromMod, (unresolvedCountByMod.get(fromMod) ?? 0) + 1);
      }
      recordModEvidence(fromMod, edge.evidenceIds);
    }
    if (toMod !== undefined) {
      nodeDegree.set(edge.to, (nodeDegree.get(edge.to) ?? 0) + 1);
      recordModEvidence(toMod, edge.evidenceIds);
    }

    if (edge.kind === "CONTAINS") continue;
    if (fromMod === undefined || toMod === undefined) continue;

    if (fromMod === toMod) {
      internalEdgeCountByMod.set(fromMod, (internalEdgeCountByMod.get(fromMod) ?? 0) + 1);
      continue;
    }

    const pairKey = `${fromMod}\0${toMod}`;
    let acc = edgeAccMap.get(pairKey);
    if (acc === undefined) {
      acc = {
        from: fromMod,
        to: toMod,
        weight: 0,
        verified: 0,
        heuristic: 0,
        unresolved: 0,
        kinds: new Map(),
        evidenceIds: new Set(),
      };
      edgeAccMap.set(pairKey, acc);
    }
    acc.weight += 1;
    acc[edge.resolution] += 1;
    acc.kinds.set(edge.kind, (acc.kinds.get(edge.kind) ?? 0) + 1);
    for (const evId of edge.evidenceIds) {
      if (evidenceById.has(evId)) acc.evidenceIds.add(evId);
    }
  }

  // Adjacency for SCC & cycles
  const activeModuleIds = activeClusterKeys.map((k) => `mod:${k}`);
  const adj = new Map<string, string[]>();
  for (const mid of activeModuleIds) adj.set(mid, []);
  for (const acc of edgeAccMap.values()) {
    adj.get(acc.from)?.push(acc.to);
  }
  for (const list of adj.values()) list.sort(cmpStr);

  const scc = computeModuleSccs(activeModuleIds, adj);

  const fanInMap = new Map<string, number>();
  const fanOutMap = new Map<string, number>();

  const projectedEdges: ProjectedModuleEdge[] = [...edgeAccMap.values()]
    .map((acc) => {
      fanOutMap.set(acc.from, (fanOutMap.get(acc.from) ?? 0) + 1);
      fanInMap.set(acc.to, (fanInMap.get(acc.to) ?? 0) + 1);
      const fromComp = scc.compOf.get(acc.from);
      const toComp = scc.compOf.get(acc.to);
      const isCycle =
        fromComp !== undefined &&
        toComp !== undefined &&
        fromComp === toComp &&
        (scc.components[fromComp]?.length ?? 0) >= 2;
      const resolutionCounts: ProjectedResolutionCounts = {
        verified: acc.verified,
        heuristic: acc.heuristic,
        unresolved: acc.unresolved,
      };
      const kinds: ProjectedEdgeKindCount[] = [...acc.kinds.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => (b.count !== a.count ? b.count - a.count : cmpStr(a.kind, b.kind)));
      const evIds = [...acc.evidenceIds].sort(cmpStr).slice(0, MAX_EVIDENCE_PER_EDGE);
      return {
        id: `medge:${acc.from}->${acc.to}`,
        from: acc.from,
        to: acc.to,
        weight: acc.weight,
        resolution: aggregateResolution(resolutionCounts),
        resolutionCounts,
        kinds,
        isCycle,
        evidenceIds: evIds,
      };
    })
    .sort((a, b) => cmpStr(a.id, b.id));

  const layerByMod = computeTopologicalLayers(scc, projectedEdges);

  // Build cycles list
  const cycles: ProjectedCycle[] = [];
  let cycleIndex = 0;
  for (const comp of scc.components) {
    if (comp.length < 2) continue;
    cycleIndex += 1;
    const compSet = new Set(comp);
    let edgeCount = 0;
    for (const e of projectedEdges) {
      if (compSet.has(e.from) && compSet.has(e.to)) edgeCount += 1;
    }
    cycles.push({
      id: `cycle:${String(cycleIndex)}`,
      moduleIds: comp,
      edgeCount,
    });
  }

  // Build projected modules
  const projectedModules: ProjectedModule[] = activeClusterKeys.map((key) => {
    const id = `mod:${key}`;
    const nodes = clusterNodesByKey.get(key) ?? [];
    const files = clusterFilesByKey.get(key) ?? [];
    const langCounts = new Map<string, number>();
    let classes = 0;
    let interfaces = 0;
    let functions = 0;
    let methods = 0;
    let endpoints = 0;
    let handlers = 0;
    let tests = 0;
    let contracts = 0;

    for (const n of nodes) {
      if (n.language !== undefined) {
        langCounts.set(n.language, (langCounts.get(n.language) ?? 0) + 1);
      }
      if (n.kind === "Class") classes += 1;
      else if (n.kind === "Interface") interfaces += 1;
      else if (n.kind === "Function") functions += 1;
      else if (n.kind === "Method") methods += 1;
      else if (n.kind === "Endpoint") endpoints += 1;
      else if (n.kind === "Handler") handlers += 1;
      else if (n.kind === "Test") tests += 1;
      else if (CONTRACT_AND_DATA_KINDS.has(n.kind)) contracts += 1;
    }

    const sortedLangs = [...langCounts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : cmpStr(a[0], b[0])))
      .map(([l]) => l);
    const primaryLanguage = sortedLangs[0] ?? "unknown";

    const keySymbols: ProjectedSymbolRef[] = nodes
      .filter((n) => n.kind !== "File")
      .sort((a, b) => {
        const pa = SYMBOL_PRIORITY[a.kind] ?? 20;
        const pb = SYMBOL_PRIORITY[b.kind] ?? 20;
        if (pb !== pa) return pb - pa;
        const da = nodeDegree.get(a.id) ?? 0;
        const db = nodeDegree.get(b.id) ?? 0;
        if (db !== da) return db - da;
        const q = cmpStr(a.qualifiedName, b.qualifiedName);
        return q !== 0 ? q : cmpStr(a.id, b.id);
      })
      .slice(0, MAX_KEY_SYMBOLS_PER_MODULE)
      .map((n) => ({
        nodeId: n.id,
        kind: n.kind,
        qualifiedName: n.qualifiedName,
        ...(n.location?.relativePath === undefined
          ? {}
          : { relativePath: normalizePosixPath(n.location.relativePath) }),
        ...(n.location?.startLine === undefined ? {} : { startLine: n.location.startLine }),
      }));

    const evIds = [...(evidenceIdsByMod.get(id) ?? [])]
      .sort(cmpStr)
      .slice(0, MAX_EVIDENCE_PER_MODULE);

    return {
      id,
      label: labelByKey.get(key) ?? key,
      path: key,
      group: groupByKey.get(key) ?? key,
      primaryLanguage,
      languages: sortedLangs,
      isTest: isTestPathOrNodes(key, nodes),
      layer: layerByMod.get(id) ?? 0,
      counts: {
        files: files.length,
        classes,
        interfaces,
        functions,
        methods,
        endpoints,
        handlers,
        tests,
        contracts,
        totalSymbols: nodes.filter((n) => n.kind !== "File").length,
      },
      fanIn: fanInMap.get(id) ?? 0,
      fanOut: fanOutMap.get(id) ?? 0,
      internalEdges: internalEdgeCountByMod.get(id) ?? 0,
      unresolvedEdges: unresolvedCountByMod.get(id) ?? 0,
      files,
      keySymbols,
      evidenceIds: evIds,
    };
  });

  // Entrypoints & Contracts
  const entrypoints: ProjectedEntrypoint[] = internalNodes
    .filter((n) => ENTRYPOINT_KINDS.has(n.kind) && nodeToModuleId.has(n.id))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "Endpoint" ? -1 : 1;
      const q = cmpStr(a.qualifiedName, b.qualifiedName);
      return q !== 0 ? q : cmpStr(a.id, b.id);
    })
    .slice(0, MAX_ENTRYPOINTS)
    .map((n) => ({
      nodeId: n.id,
      kind: n.kind,
      qualifiedName: n.qualifiedName,
      moduleId: nodeToModuleId.get(n.id) ?? "",
      ...(n.language === undefined ? {} : { language: n.language }),
      ...(n.location?.relativePath === undefined
        ? {}
        : { relativePath: normalizePosixPath(n.location.relativePath) }),
      ...(n.location?.startLine === undefined ? {} : { startLine: n.location.startLine }),
    }));

  const contracts: ProjectedContract[] = internalNodes
    .filter((n) => CONTRACT_AND_DATA_KINDS.has(n.kind) && nodeToModuleId.has(n.id))
    .sort((a, b) => {
      const k = cmpStr(a.kind, b.kind);
      if (k !== 0) return k;
      const q = cmpStr(a.qualifiedName, b.qualifiedName);
      return q !== 0 ? q : cmpStr(a.id, b.id);
    })
    .slice(0, MAX_CONTRACTS)
    .map((n) => ({
      nodeId: n.id,
      kind: n.kind,
      qualifiedName: n.qualifiedName,
      moduleId: nodeToModuleId.get(n.id) ?? "",
      ...(n.location?.relativePath === undefined
        ? {}
        : { relativePath: normalizePosixPath(n.location.relativePath) }),
      ...(n.location?.startLine === undefined ? {} : { startLine: n.location.startLine }),
    }));

  // Direct O(V + E) verified ROUTES_TO/CALLS critical flow BFS (avoids full onboarding learningOrder O(C^2) work)
  const deterministicFlows: ProjectedFlow[] = [];
  if (snapshot.meta.state === "ready" || snapshot.meta.state === "partial") {
    const flowAdj = new Map<string, string[]>();
    for (const edge of sortedEdges) {
      if (edge.resolution !== "verified") continue;
      if (edge.kind !== "ROUTES_TO" && edge.kind !== "CALLS") continue;
      let list = flowAdj.get(edge.from);
      if (list === undefined) {
        list = [];
        flowAdj.set(edge.from, list);
      }
      list.push(edge.to);
    }
    for (const list of flowAdj.values()) {
      list.sort((a, b) => {
        const na = nodeById.get(a);
        const nb = nodeById.get(b);
        const qa = na?.qualifiedName ?? a;
        const qb = nb?.qualifiedName ?? b;
        const c = cmpStr(qa, qb);
        return c !== 0 ? c : cmpStr(a, b);
      });
    }

    const endpointSeeds = entrypoints.filter((ep) => ep.kind === "Endpoint");
    const MAX_FLOWS = 8;
    const MAX_FLOW_DEPTH = 3;
    const MAX_FLOW_VISITS = 500;
    let totalVisits = 0;

    for (const ep of endpointSeeds) {
      if (deterministicFlows.length >= MAX_FLOWS || totalVisits >= MAX_FLOW_VISITS) break;
      const visited = new Set<string>([ep.nodeId]);
      const queue: Array<{ readonly id: string; readonly depth: number }> = [
        { id: ep.nodeId, depth: 0 },
      ];
      const steps: ProjectedFlowStep[] = [];
      let qHead = 0;

      while (qHead < queue.length && totalVisits < MAX_FLOW_VISITS) {
        const cur = queue[qHead];
        qHead += 1;
        if (cur === undefined || cur.depth >= MAX_FLOW_DEPTH) continue;
        for (const nextId of flowAdj.get(cur.id) ?? []) {
          if (visited.has(nextId)) continue;
          visited.add(nextId);
          totalVisits += 1;
          const stNode = nodeById.get(nextId);
          if (stNode === undefined || stNode.kind === "UnknownExternal") continue;
          const stMod = nodeToModuleId.get(nextId);
          steps.push({
            nodeId: nextId,
            ...(stMod === undefined ? {} : { moduleId: stMod }),
            kind: stNode.kind,
            qualifiedName: stNode.qualifiedName,
            depth: cur.depth + 1,
          });
          queue.push({ id: nextId, depth: cur.depth + 1 });
          if (steps.length >= 10 || totalVisits >= MAX_FLOW_VISITS) break;
        }
      }

      if (steps.length > 0) {
        deterministicFlows.push({
          id: `flow:det-${String(deterministicFlows.length + 1)}`,
          entryNodeId: ep.nodeId,
          entryModuleId: ep.moduleId,
          entryQualifiedName: ep.qualifiedName,
          steps,
        });
      }
    }
  }

  // Risk hotspots (cycles, high fan-in, high fan-out, unresolved hotspots)
  const hotspots: RiskHotspot[] = [];
  for (const mod of projectedModules) {
    if (scc.cycleModuleIds.has(mod.id)) {
      hotspots.push({
        moduleId: mod.id,
        label: mod.label,
        reason: "cycle",
        score: 100 + mod.fanIn + mod.fanOut,
        detail: `Part of circular dependency (fanIn=${String(mod.fanIn)}, fanOut=${String(mod.fanOut)})`,
      });
    }
    if (mod.fanIn >= 4) {
      hotspots.push({
        moduleId: mod.id,
        label: mod.label,
        reason: "high-fan-in",
        score: 50 + mod.fanIn * 5,
        detail: `High incoming coupling: ${String(mod.fanIn)} modules depend on this module`,
      });
    }
    if (mod.fanOut >= 5) {
      hotspots.push({
        moduleId: mod.id,
        label: mod.label,
        reason: "high-fan-out",
        score: 40 + mod.fanOut * 4,
        detail: `High outgoing coupling: depends on ${String(mod.fanOut)} modules`,
      });
    }
    if (mod.unresolvedEdges >= 10) {
      hotspots.push({
        moduleId: mod.id,
        label: mod.label,
        reason: "unresolved-edges",
        score: 20 + Math.min(80, mod.unresolvedEdges),
        detail: `${String(mod.unresolvedEdges)} unresolved outgoing references`,
      });
    }
  }
  hotspots.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : cmpStr(a.moduleId, b.moduleId) !== 0
        ? cmpStr(a.moduleId, b.moduleId)
        : cmpStr(a.reason, b.reason),
  );
  const riskHotspots = hotspots.slice(0, MAX_RISK_HOTSPOTS);

  // Build compact evidence catalog (only referenced IDs)
  const referencedEvidenceIds = new Set<string>();
  for (const m of projectedModules) {
    for (const eid of m.evidenceIds) referencedEvidenceIds.add(eid);
  }
  for (const e of projectedEdges) {
    for (const eid of e.evidenceIds) referencedEvidenceIds.add(eid);
  }
  const evidenceCatalog: Record<string, ProjectedEvidenceRecord> = Object.create(null) as Record<
    string,
    ProjectedEvidenceRecord
  >;
  for (const eid of [...referencedEvidenceIds].sort(cmpStr)) {
    const ev = evidenceById.get(eid);
    if (ev === undefined) continue;
    evidenceCatalog[eid] = {
      id: ev.id,
      kind: ev.kind,
      analyzerId: ev.analyzerId,
      analyzerVersion: ev.analyzerVersion,
      rationale: ev.rationale,
      ...(ev.span === undefined
        ? {}
        : {
            span: {
              relativePath: normalizePosixPath(ev.span.relativePath),
              startLine: ev.span.startLine,
              endLine: ev.span.endLine,
            },
          }),
    };
  }

  return {
    meta: snapshot.meta,
    summary: {
      totalRawNodes: sortedNodes.length,
      totalRawEdges: sortedEdges.length,
      totalRawEvidence: sortedEvidence.length,
      analyzedFiles: sortedFiles.length,
      moduleCount: projectedModules.length,
      moduleEdgeCount: projectedEdges.length,
      cycleCount: cycles.length,
      entrypointCount: entrypoints.length,
      contractCount: contracts.length,
      flowCount: deterministicFlows.length,
      resolutionCounts: totalResCounts,
      languages,
      maxModulesApplied: maxModules,
      ...(normalizedPrefix === undefined ? {} : { pathPrefixApplied: normalizedPrefix }),
    },
    modules: projectedModules,
    edges: projectedEdges,
    cycles,
    entrypoints,
    contracts,
    deterministicFlows,
    externalSummary: {
      nodeCount: externalNodes.length,
      unresolvedEdgeCount: externalEdgeCount,
      topExternalTargets,
    },
    riskHotspots,
    evidenceCatalog,
  };
}
