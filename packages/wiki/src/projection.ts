import {
  canonicalJson,
  sha256Hex,
  SnapshotSchema,
  utf8Encode,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";
import { z } from "zod";

import { wikiPageContentHash } from "./content-hash.js";
import { WikiProjectionError } from "./errors.js";
import { WIKI_ROOT_CATEGORIES, WIKI_TEMPLATE_VERSION } from "./taxonomy.js";
import {
  WikiPageKindSchema,
  WikiProjectionSchema,
  type CoverageStatus,
  type EvidenceRef,
  type WikiPage,
  type WikiPageKind,
  type WikiPageSection,
  type WikiPageSectionStatus,
  type WikiProjection,
  type WikiSnapshot,
} from "./schema.js";

/**
 * WikiProjectionEngine — GraphSnapshot → WikiSnapshot deterministik
 * projeksiyonu (TŞ v2.1 §16A.1 sayfa taksonomisi, §16A.5 canlı güncelleme
 * akışı, §16A.7 veri modeli; ADR-011 Graph Projection, ADR-012
 * Generated/Overlay Separation; docs/wiki-spec.md §3.0–§3.2; K-013).
 *
 * Sözleşme kuralları:
 * - Saf çekirdektir: yalnızca @causoryn/domain + zod'a bağlıdır; MCP türü
 *   import etmez; saat okumaz (`builtAt` zorunlu girdidir — domain deseni).
 * - Yalnızca `ready`/`partial` GraphSnapshot projeksiyona girer (TŞ §9);
 *   `building`/`failed` reddedilir.
 * - Boş kategori `no_data` görünümü taşır ve ASLA doldurulmaz (§16A.1):
 *   no_data bölümlerin generatedMarkdown'u daima "" olur, kanıt uydurulmaz.
 * - Adapter desteklemeyen sayfa türleri `unsupported` + açık uyarı alır
 *   (§16A.1: "Bir sayfa türü adapter tarafından desteklenmiyorsa
 *   unsupported veya partial döner").
 * - Kanıt: bölümler, katkıda bulunan kenarların Evidence kayıtlarından
 *   span'lı referanslar taşır (§16A.7: verified link ≥1 Evidence;
 *   span'sız kanıt referansa çevrilmez).
 * - Determinizm: aynı graph + aynı girdiler → bit-bit aynı WikiSnapshot
 *   JSON; sayfa/bölüm kimlikleri canonical identity'den sha256 ile
 *   türetilir (§16A.1 pageId kuralı).
 *
 * WikiLink kasıtlı olarak bu sürümde üretilmez: çift yönlü link + backlink
 * ters indeksi sprint-4 W3 görevidir (TŞ §16A.2).
 */

/** projectWiki girdisi. `builtAt` zorunludur: motor saat okumaz. */
export interface WikiProjectionInput {
  /** ISO 8601 UTC zaman etiketi; kimliğe katılmaz. */
  readonly builtAt: string;
  /**
   * Kalıcı revision kimliği (commit SHA veya dirty working-tree descriptor,
   * TŞ §16A.4). Verilmezse graph meta revision.id taşınır.
   */
  readonly revisionRef?: string;
  /**
   * Adapter destek kümesi: üretilebilecek sayfa türleri (§16A.1 unsupported
   * kuralı). Verilmezse tüm türler destekli sayılır; dışarıda kalan türdeki
   * kategoriler `unsupported` olur + uyarı üretilir, alt sayfaları üretilmez.
   */
  readonly supportedPageKinds?: readonly WikiPageKind[];
}

const BuiltAtSchema = z.iso.datetime();
const SupportedKindsSchema = z.array(WikiPageKindSchema);

/** §16A.10 "açık no_data" kategorileri: W1 projeksiyonunda veri kaynağı yok. */
const STRUCTURAL_NO_DATA_DETAIL: Partial<Record<WikiPageKind, string>> = {
  business_flow:
    "uçtan uca iş akışı (execution flow) verisi GraphSnapshot'ta taşınmıyor",
  timeline: "git geçmiş verisi GraphSnapshot'ta taşınmıyor (wiki_diff/C3 sağlar)",
  onboarding: "onboarding öğrenme patikası ayrı motor çıktısıdır",
};

export interface WikiSectionDraft {
  readonly sectionKey: string;
  readonly markdown: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: WikiPageSectionStatus;
}

/**
 * Bölüm şablonlarının paylaşılan build bağlamı — projectWiki ile W6
 * incremental motorunun AYNI indeksler üzerinde çalışmasını garanti eder
 * (TŞ §16A.5 madde 4: yalnızca ilişkili pageId'ler güncellenir).
 */
export interface WikiBuildContext {
  readonly graph: SnapshotGraph;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly outEdges: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly inEdges: ReadonlyMap<string, readonly GraphEdge[]>;
}

/** SnapshotGraph → indekslenmiş build bağlamı (deterministik). */
export function wikiBuildContext(graph: SnapshotGraph): WikiBuildContext {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const fromList = outEdges.get(edge.from) ?? [];
    fromList.push(edge);
    outEdges.set(edge.from, fromList);
    const toList = inEdges.get(edge.to) ?? [];
    toList.push(edge);
    inEdges.set(edge.to, toList);
  }
  return { graph, nodesById, evidenceById, outEdges, inEdges };
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new WikiProjectionError(
      "wiki/invalid-input",
      `Zorunlu alan boş olamaz: ${field}`,
    );
  }
}

function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

/** Route/slug güvenli normalize: [a-z0-9-] dışı her karakter "-" olur. */
export function wikiSlugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "page";
}

function deterministicId(prefix: "page" | "section", parts: readonly unknown[]): string {
  return `${prefix}:${sha256Hex(utf8Encode(canonicalJson(parts as never)))}`;
}

/**
 * §16A.1 pageId türetimi — kök kategori sayfası. Slug/başlık değişse bile
 * kimlik korunur; W6 incremental motoru AYNI türetimi kullanır.
 */
export function wikiRootPageIdFor(
  workspaceId: string,
  categoryKey: string,
  categoryKind: WikiPageKind,
): string {
  return deterministicId("page", [workspaceId, "root", categoryKey, categoryKind]);
}

/** §16A.1 pageId türetimi — node tabanlı alt sayfa. */
export function wikiChildPageId(
  workspaceId: string,
  pageKind: WikiPageKind,
  nodeId: string,
): string {
  return deterministicId("page", [workspaceId, "node", pageKind, nodeId]);
}

/**
 * WikiSnapshot kimliği: kaynak graphSnapshotId + şablon sürümünden
 * deterministik türetim (TŞ §16A.4 iki düzey sürüm; K-013).
 */
export function deriveWikiSnapshotId(graphSnapshotId: string): string {
  return `wiki:${sha256Hex(
    utf8Encode(canonicalJson([graphSnapshotId, WIKI_TEMPLATE_VERSION])),
  )}`;
}

function resolutionLabel(resolution: string): string {
  return `[${resolution}]`;
}

function nodeDisplayName(ctx: WikiBuildContext, nodeId: string): string {
  return ctx.nodesById.get(nodeId)?.qualifiedName ?? nodeId;
}

/** Kenar kümesinden span'lı kanıt referansları (kanonik: evidenceId sıralı). */
function evidenceRefsForEdges(
  ctx: WikiBuildContext,
  edges: readonly GraphEdge[],
): EvidenceRef[] {
  const refs = new Map<string, EvidenceRef>();
  for (const edge of edges) {
    for (const evidenceId of edge.evidenceIds) {
      const evidence = ctx.evidenceById.get(evidenceId);
      if (evidence?.span === undefined) continue;
      if (!refs.has(evidence.id)) {
        refs.set(evidence.id, {
          evidenceId: evidence.id,
          relativePath: evidence.span.relativePath,
          startLine: evidence.span.startLine,
          endLine: evidence.span.endLine,
          sourceHash: evidence.span.sourceHash,
        });
      }
    }
  }
  return [...refs.values()].sort((a, b) => byString(a.evidenceId, b.evidenceId));
}

/**
 * Kenar tabanlı bölüm durumu: en az bir çözülemeyen kenar → `partial`
 * (§16A.10 Belirsizlik: doğrulanmış link taklidi yapılmaz); aksi halde ok.
 */
function statusForEdges(edges: readonly GraphEdge[]): WikiPageSectionStatus {
  return edges.some((edge) => edge.resolution === "unresolved")
    ? "partial"
    : "ok";
}

function draft(
  sectionKey: string,
  status: WikiPageSectionStatus,
  markdown: string,
  evidenceRefs: readonly EvidenceRef[] = [],
): WikiSectionDraft {
  return { sectionKey, status, markdown, evidenceRefs };
}

/** no_data bölümün tek gerçek yüzü: boş içerik, boş kanıt (§16A.1). */
function emptyDraft(sectionKey: string): WikiSectionDraft {
  return draft(sectionKey, "no_data", "", []);
}

function sortedNodesOfKind(
  graph: SnapshotGraph,
  kinds: readonly string[],
): GraphNode[] {
  const kindSet = new Set(kinds);
  return graph.nodes
    .filter((node) => kindSet.has(node.kind))
    .sort((a, b) => byString(a.qualifiedName, b.qualifiedName));
}

function edgesOfKind(
  ctx: WikiBuildContext,
  kinds: readonly string[],
): GraphEdge[] {
  const kindSet = new Set(kinds);
  return ctx.graph.edges
    .filter((edge) => kindSet.has(edge.kind))
    .sort((a, b) => byString(a.id, b.id));
}

function edgesFrom(ctx: WikiBuildContext, nodeId: string, kinds?: readonly string[]): GraphEdge[] {
  const list = ctx.outEdges.get(nodeId) ?? [];
  return kinds === undefined
    ? [...list].sort((a, b) => byString(a.id, b.id))
    : list
        .filter((edge) => kinds.includes(edge.kind))
        .sort((a, b) => byString(a.id, b.id));
}

function edgesTo(ctx: WikiBuildContext, nodeId: string, kinds?: readonly string[]): GraphEdge[] {
  const list = ctx.inEdges.get(nodeId) ?? [];
  return kinds === undefined
    ? [...list].sort((a, b) => byString(a.id, b.id))
    : list
        .filter((edge) => kinds.includes(edge.kind))
        .sort((a, b) => byString(a.id, b.id));
}

/* ---------------------------------------------------------------------------
 * Kök kategori bölüm şablonları (sabit — WIKI_TEMPLATE_VERSION ile
 * sürümlenir; TŞ §16A.7 "generated Markdown şablonları sabit sürümlenir").
 * ------------------------------------------------------------------------- */

export function buildWikiRootCategorySections(
  ctx: WikiBuildContext,
  categoryKind: WikiPageKind,
): WikiSectionDraft[] {
  switch (categoryKind) {
    case "overview": {
      const summary = buildOverviewSummary(ctx);
      const languages = buildOverviewLanguages(ctx);
      return [summary, languages];
    }
    case "architecture":
      return [buildArchitectureLayers(ctx)];
    case "project":
      return [buildModulesList(ctx)];
    case "api":
      return [buildEndpointsList(ctx)];
    case "business_flow":
      return [emptyDraft("flows")];
    case "event":
      return [buildEventsList(ctx)];
    case "data":
      return [buildSchemasList(ctx)];
    case "contract":
      return [buildContractsList(ctx)];
    case "test":
      return [buildTestsList(ctx), emptyDraft("coverage-gaps")];
    case "timeline":
      return [emptyDraft("commits")];
    case "onboarding":
      return [emptyDraft("path")];
    case "coverage":
      return [buildUnresolvedReport(ctx)];
    default:
      return [emptyDraft("summary")];
  }
}

function buildOverviewSummary(ctx: WikiBuildContext): WikiSectionDraft {
  const workspaceNodes = sortedNodesOfKind(ctx.graph, ["Workspace", "Repository"]);
  const projectNodes = sortedNodesOfKind(ctx.graph, ["Project"]);
  if (workspaceNodes.length === 0 && projectNodes.length === 0) {
    return emptyDraft("summary");
  }
  const lines = [
    ...workspaceNodes.map((node) => `- Workspace: ${node.qualifiedName}`),
    ...projectNodes.map((node) => `- Project: ${node.qualifiedName}`),
    `- Graph: ${ctx.graph.nodes.length} node, ${ctx.graph.edges.length} edge, ${ctx.graph.evidence.length} evidence`,
  ];
  return draft("summary", "ok", lines.join("\n"));
}

function buildOverviewLanguages(ctx: WikiBuildContext): WikiSectionDraft {
  const counts = new Map<string, number>();
  for (const node of ctx.graph.nodes) {
    if (node.language === undefined) continue;
    counts.set(node.language, (counts.get(node.language) ?? 0) + 1);
  }
  if (counts.size === 0) return emptyDraft("languages");
  const lines = [...counts.entries()]
    .sort((a, b) => byString(a[0], b[0]))
    .map(([language, count]) => `- ${language}: ${count} node`);
  return draft("languages", "ok", lines.join("\n"));
}

/** L0–L4 katman sayımı — TŞ §16 harita hiyerarşisi. */
const LAYER_KINDS: readonly { readonly level: number; readonly kinds: readonly string[] }[] = [
  { level: 0, kinds: ["Repository", "Workspace"] },
  { level: 1, kinds: ["Project", "Module", "Package"] },
  { level: 2, kinds: ["Class", "Interface", "Type"] },
  { level: 3, kinds: ["Method", "Function", "Endpoint", "Handler"] },
  {
    level: 4,
    kinds: ["ApiContract", "EventContract", "SchemaContract", "ContractVersion"],
  },
];

function buildArchitectureLayers(ctx: WikiBuildContext): WikiSectionDraft {
  const lines: string[] = [];
  for (const layer of LAYER_KINDS) {
    const counts = new Map<string, number>();
    for (const node of ctx.graph.nodes) {
      if (!layer.kinds.includes(node.kind)) continue;
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const parts = [...counts.entries()]
      .sort((a, b) => byString(a[0], b[0]))
      .map(([kind, count]) => `${count} ${kind.toLowerCase()}`);
    lines.push(`- L${layer.level}: ${parts.join(", ")}`);
  }
  if (lines.length === 0) return emptyDraft("layers");
  return draft("layers", "ok", lines.join("\n"));
}

function buildModulesList(ctx: WikiBuildContext): WikiSectionDraft {
  const modules = sortedNodesOfKind(ctx.graph, ["Module"]);
  if (modules.length === 0) return emptyDraft("modules");
  const lines = modules.map(
    (node) =>
      `- ${node.qualifiedName}${node.location === undefined ? "" : ` (${node.location.relativePath})`}`,
  );
  return draft("modules", "ok", lines.join("\n"));
}

function buildEndpointsList(ctx: WikiBuildContext): WikiSectionDraft {
  const endpoints = sortedNodesOfKind(ctx.graph, ["Endpoint"]);
  if (endpoints.length === 0) return emptyDraft("endpoints");
  const lines = endpoints.map((node) => `- ${node.qualifiedName}`);
  return draft("endpoints", "ok", lines.join("\n"));
}

function buildEventsList(ctx: WikiBuildContext): WikiSectionDraft {
  const events = sortedNodesOfKind(ctx.graph, ["Event", "Topic", "Queue"]);
  if (events.length === 0) return emptyDraft("events");
  const lines = events.map(
    (node) => `- ${node.kind.toLowerCase()} ${node.qualifiedName}`,
  );
  return draft("events", "ok", lines.join("\n"));
}

function buildSchemasList(ctx: WikiBuildContext): WikiSectionDraft {
  const counts = new Map<string, number>();
  for (const kind of ["Database", "Table", "Column"]) {
    const count = ctx.graph.nodes.filter((node) => node.kind === kind).length;
    if (count > 0) counts.set(kind, count);
  }
  if (counts.size === 0) return emptyDraft("schemas");
  const lines = [...counts.entries()]
    .sort((a, b) => byString(a[0], b[0]))
    .map(([kind, count]) => `- ${kind}: ${count}`);
  return draft("schemas", "ok", lines.join("\n"));
}

const CONTRACT_NODE_KINDS: readonly string[] = [
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
];

function buildContractsList(ctx: WikiBuildContext): WikiSectionDraft {
  const contracts = sortedNodesOfKind(ctx.graph, CONTRACT_NODE_KINDS);
  if (contracts.length === 0) return emptyDraft("contracts");
  const lines = contracts.map(
    (node) => `- ${node.kind} ${node.qualifiedName}`,
  );
  return draft("contracts", "ok", lines.join("\n"));
}

function buildTestsList(ctx: WikiBuildContext): WikiSectionDraft {
  const testNodes = sortedNodesOfKind(ctx.graph, ["Test"]);
  const testEdges = edgesOfKind(ctx, ["TESTS"]);
  if (testNodes.length === 0 && testEdges.length === 0) {
    return emptyDraft("tests");
  }
  const lines = [
    `- Test: ${testNodes.length} test node, ${testEdges.length} TESTS kenarı`,
  ];
  return draft("tests", "ok", lines.join("\n"));
}

function buildUnresolvedReport(ctx: WikiBuildContext): WikiSectionDraft {
  const unresolvedEdges = ctx.graph.edges
    .filter((edge) => edge.resolution === "unresolved")
    .sort((a, b) => byString(a.id, b.id));
  const unknownExternals = sortedNodesOfKind(ctx.graph, ["UnknownExternal"]);
  if (unresolvedEdges.length === 0 && unknownExternals.length === 0) {
    return emptyDraft("unresolved");
  }
  const lines = unresolvedEdges.map(
    (edge) =>
      `- ${edge.kind} ${nodeDisplayName(ctx, edge.from)} → ${nodeDisplayName(ctx, edge.to)} ${resolutionLabel(edge.resolution)}`,
  );
  lines.push(`- Çözülemeyen kenar: ${unresolvedEdges.length}`);
  if (unknownExternals.length > 0) {
    lines.push(`- UnknownExternal: ${unknownExternals.length} node`);
  }
  // Çözülemeyen kenar genellikle kanıtsızdır; kanıt varsa dürüstçe taşınır,
  // yoksa referans UYDURULMAZ (§16A.10: doğrulanmış taklit yok).
  return draft(
    "unresolved",
    "ok",
    lines.join("\n"),
    evidenceRefsForEdges(ctx, unresolvedEdges),
  );
}

/* ---------------------------------------------------------------------------
 * Alt sayfa bölüm şablonları
 * ------------------------------------------------------------------------- */

export function buildWikiNodePageSections(
  ctx: WikiBuildContext,
  pageKind: WikiPageKind,
  node: GraphNode,
): WikiSectionDraft[] {
  switch (pageKind) {
    case "module": {
      const contains = edgesFrom(ctx, node.id, ["CONTAINS"]);
      const componentLines = contains.map(
        (edge) =>
          `- ${nodeDisplayName(ctx, edge.to)} ${resolutionLabel(edge.resolution)}`,
      );
      const components =
        contains.length === 0
          ? emptyDraft("components")
          : draft(
              "components",
              statusForEdges(contains),
              componentLines.join("\n"),
              evidenceRefsForEdges(ctx, contains),
            );
      const depends = [
        ...edgesFrom(ctx, node.id, ["DEPENDS_ON"]).map(
          (edge) =>
            ({
              edge,
              line: `- DEPENDS_ON → ${nodeDisplayName(ctx, edge.to)} ${resolutionLabel(edge.resolution)}`,
            }) as const,
        ),
        ...edgesTo(ctx, node.id, ["DEPENDS_ON"]).map(
          (edge) =>
            ({
              edge,
              line: `- DEPENDS_ON ← ${nodeDisplayName(ctx, edge.from)} ${resolutionLabel(edge.resolution)}`,
            }) as const,
        ),
      ].sort((a, b) => byString(a.edge.id, b.edge.id));
      const dependencies =
        depends.length === 0
          ? emptyDraft("dependencies")
          : draft(
              "dependencies",
              statusForEdges(depends.map((entry) => entry.edge)),
              depends.map((entry) => entry.line).join("\n"),
              evidenceRefsForEdges(
                ctx,
                depends.map((entry) => entry.edge),
              ),
            );
      return [components, dependencies];
    }
    case "api": {
      const routeLines = [
        `- ${node.qualifiedName}`,
        ...(node.language === undefined
          ? []
          : [`- dil: ${node.language}`]),
        ...(node.location === undefined
          ? []
          : [`- kaynak: ${node.location.relativePath}`]),
      ];
      const route = draft("route", "ok", routeLines.join("\n"));
      const routes = edgesFrom(ctx, node.id, ["ROUTES_TO", "HANDLES"]);
      const handler =
        routes.length === 0
          ? emptyDraft("handler")
          : draft(
              "handler",
              statusForEdges(routes),
              routes
                .map(
                  (edge) =>
                    `- → ${nodeDisplayName(ctx, edge.to)} ${resolutionLabel(edge.resolution)}`,
                )
                .join("\n"),
              evidenceRefsForEdges(ctx, routes),
            );
      return [route, handler];
    }
    case "event": {
      const publishes = edgesFrom(ctx, node.id, ["PUBLISHES"]);
      const publisherLines = publishes.map(
        (edge) =>
          `- PUBLISHES → ${nodeDisplayName(ctx, edge.to)} ${resolutionLabel(edge.resolution)}`,
      );
      const publishers =
        publishes.length === 0
          ? emptyDraft("publishers")
          : draft(
              "publishers",
              statusForEdges(publishes),
              publisherLines.join("\n"),
              evidenceRefsForEdges(ctx, publishes),
            );
      const subscribes = edgesTo(ctx, node.id, ["SUBSCRIBES"]);
      const subscriberLines = subscribes.map(
        (edge) =>
          `- SUBSCRIBES ← ${nodeDisplayName(ctx, edge.from)} ${resolutionLabel(edge.resolution)}`,
      );
      const subscribers =
        subscribes.length === 0
          ? emptyDraft("subscribers")
          : draft(
              "subscribers",
              statusForEdges(subscribes),
              subscriberLines.join("\n"),
              evidenceRefsForEdges(ctx, subscribes),
            );
      return [publishers, subscribers];
    }
    case "data": {
      const access = [
        ...edgesTo(ctx, node.id, ["READS", "WRITES"]).map(
          (edge) =>
            ({
              edge,
              line: `- ${edge.kind} ← ${nodeDisplayName(ctx, edge.from)} ${resolutionLabel(edge.resolution)}`,
            }) as const,
        ),
      ].sort((a, b) => byString(a.edge.id, b.edge.id));
      if (access.length === 0) return [emptyDraft("readers-writers")];
      return [
        draft(
          "readers-writers",
          statusForEdges(access.map((entry) => entry.edge)),
          access.map((entry) => entry.line).join("\n"),
          evidenceRefsForEdges(
            ctx,
            access.map((entry) => entry.edge),
          ),
        ),
      ];
    }
    case "contract": {
      const lines = [`- ${node.kind} ${node.qualifiedName}`];
      const attributeKeys = Object.keys(node.attributes);
      if (attributeKeys.length > 0) {
        lines.push(`- attributes: ${canonicalJson(node.attributes as never)}`);
      }
      return [draft("definition", "ok", lines.join("\n"))];
    }
    default:
      return [emptyDraft("summary")];
  }
}

/* ---------------------------------------------------------------------------
 * Sayfa inşası
 * ------------------------------------------------------------------------- */

/** materializeWikiPage çıktısı: sayfa + bölüm satırları (kanonik). */
export interface WikiPageDraft {
  readonly page: WikiPage;
  readonly sections: readonly WikiPageSection[];
}

interface PendingChild {
  readonly categoryKey: string;
  readonly categorySlug: string;
  readonly kind: WikiPageKind;
  readonly node: GraphNode;
}

/**
 * Alt sayfa kaynakları: kategori anahtarı → node türleri → sayfa türü
 * (projectWiki ile W6 incremental motorunun bölüm → sayfa eşlemesinin
 * TEK kaynağı; TŞ §16A.5 madde 4).
 */
export const WIKI_CHILD_PAGE_SOURCES: readonly {
  readonly categoryKey: string;
  readonly kinds: readonly string[];
  readonly pageKind: WikiPageKind;
}[] = [
  { categoryKey: "projects-modules", kinds: ["Module"], pageKind: "module" },
  { categoryKey: "apis-entry-points", kinds: ["Endpoint"], pageKind: "api" },
  { categoryKey: "events-integrations", kinds: ["Event", "Topic", "Queue"], pageKind: "event" },
  { categoryKey: "data-schemas", kinds: ["Table"], pageKind: "data" },
  {
    categoryKey: "contracts-policies",
    kinds: CONTRACT_NODE_KINDS,
    pageKind: "contract",
  },
];

function sectionStatusSummary(
  sections: readonly WikiSectionDraft[],
): CoverageStatus {
  const statuses = sections.map((section) => section.status);
  if (statuses.every((status) => status === "no_data")) return "no_data";
  if (statuses.every((status) => status === "ok")) return "complete";
  return "partial";
}

/**
 * Bölüm taslaklarını kanonik WikiPage + WikiPageSection satırlarına
 * çevirir (section id = sha256([pageId, sectionKey]); contentHash bölüm
 * içeriklerinden; projectWiki ve W6 incremental motoru AYNI
 * materializasyonu paylaşır).
 */
export function materializeWikiPage(draftInput: {
  pageId: string;
  wikiSnapshotId: string;
  kind: WikiPageKind;
  parentId: string | null;
  title: string;
  slug: string;
  route: string;
  sections: readonly WikiSectionDraft[];
  coverageOverride?: CoverageStatus;
  coverageDetail?: string;
}): WikiPageDraft {
  const sections: WikiPageSection[] = draftInput.sections.map((section) => ({
    id: deterministicId("section", [draftInput.pageId, section.sectionKey]),
    pageId: draftInput.pageId,
    sectionKey: section.sectionKey,
    generatedMarkdown: section.markdown,
    evidenceRefs: [...section.evidenceRefs],
    status: section.status,
  }));
  const summaryStatus = sectionStatusSummary(draftInput.sections);
  const coverageStatus = draftInput.coverageOverride ?? summaryStatus;
  const detail =
    draftInput.coverageDetail ??
    (coverageStatus === "no_data" ? "kategoride graph verisi yok (no_data doldurulmaz)" : undefined);
  const page: WikiPage = {
    id: draftInput.pageId,
    wikiSnapshotId: draftInput.wikiSnapshotId,
    kind: draftInput.kind,
    parentId: draftInput.parentId,
    title: draftInput.title,
    slug: draftInput.slug,
    route: draftInput.route,
    contentHash: wikiPageContentHash(sections),
    freshness: "fresh",
    coverage: {
      status: coverageStatus,
      ...(detail === undefined ? {} : { detail }),
    },
  };
  return { page, sections };
}

/**
 * GraphSnapshot → WikiSnapshot deterministik projeksiyon. Ayrıntılı sözleşme
 * kuralları modül başlığında belgelenmiştir (TŞ §16A.1/§16A.5/§16A.7, K-013).
 */
export function projectWiki(
  graph: SnapshotGraph,
  input: WikiProjectionInput,
): WikiProjection {
  // 1) Girdi savunma katmanı: graph domain şemasından geçmeli (dangling/
  //    duplicate invariant'ları kalıcı depodan gelen veri için de geçerli).
  const graphParse = SnapshotSchema.safeParse(graph);
  if (!graphParse.success) {
    const detail = graphParse.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/invalid-graph",
      `GraphSnapshot şema doğrulaması başarısız: ${detail}`,
    );
  }
  const builtAtParse = BuiltAtSchema.safeParse(input.builtAt);
  if (!builtAtParse.success) {
    throw new WikiProjectionError(
      "wiki/invalid-input",
      "builtAt ISO 8601 UTC datetime olmalıdır",
    );
  }
  const revisionRef = input.revisionRef ?? graph.meta.revision.id;
  requireNonEmpty("revisionRef", revisionRef);

  const supportedKinds: ReadonlySet<WikiPageKind> = new Set(
    input.supportedPageKinds === undefined
      ? WikiPageKindSchema.options
      : (() => {
          const kindsParse = SupportedKindsSchema.safeParse(input.supportedPageKinds);
          if (!kindsParse.success) {
            throw new WikiProjectionError(
              "wiki/invalid-input",
              "supportedPageKinds geçerli WikiPageKind değerleri içermelidir",
            );
          }
          return kindsParse.data;
        })(),
  );

  // 2) Yalnızca ready/partial kaynak snapshot projeksiyona girer (TŞ §9).
  const sourceState = graph.meta.state;
  if (sourceState !== "ready" && sourceState !== "partial") {
    throw new WikiProjectionError(
      "wiki/snapshot-not-projectable",
      `Yalnızca ready/partial GraphSnapshot WikiSnapshot'a projeksiyonlanabilir (TŞ §9); gelen durum: ${sourceState}`,
    );
  }

  // 3) İndeksler: node/edge/kanıt haritaları (paylaşılan build bağlamı —
  //    W6 incremental motoru da aynı kurucuyu kullanır).
  const ctx: WikiBuildContext = wikiBuildContext(graph);

  const wikiSnapshotId = deriveWikiSnapshotId(graph.meta.id);

  const pages: WikiPage[] = [];
  const sections: WikiPageSection[] = [];

  // 4) Kök kategori sayfaları: taksonomi sırasıyla (§16A.1 ağacı).
  for (const category of WIKI_ROOT_CATEGORIES) {
    const pageId = wikiRootPageIdFor(
      graph.meta.workspaceId,
      category.key,
      category.kind,
    );

    const drafts: WikiSectionDraft[] =
      supportedKinds.has(category.kind)
        ? buildWikiRootCategorySections(ctx, category.kind)
        : wikiUnsupportedRootSections(category.kind);

    // Yapısal no_data detayı yalnızca DESTEKLENEN kategoriye girer:
    // desteklenmeyen türde coverage.detail "desteklenmiyor" mesajıdır ve
    // alttaki structural spread onu EZEMEZ (HEAD semantiği; denetim
    // bulgusu 1 regresyon testi wiki-incremental.test.ts'te).
    const structuralDetail = supportedKinds.has(category.kind)
      ? wikiStructuralNoDataDetail(category.kind)
      : undefined;

    const materialized = materializeWikiPage({
      pageId,
      wikiSnapshotId,
      kind: category.kind,
      parentId: null,
      title: category.title,
      slug: category.slug,
      route: `/wiki/${category.slug}`,
      sections: drafts,
      ...(supportedKinds.has(category.kind)
        ? {}
        : {
            coverageOverride: "unsupported" as CoverageStatus,
            coverageDetail: `sayfa türü '${category.kind}' bu adapter kümesi tarafından desteklenmiyor`,
          }),
      ...(structuralDetail === undefined ? {} : { coverageDetail: structuralDetail }),
    });
    pages.push(materialized.page);
    sections.push(...materialized.sections);
  }

  // 5) Alt sayfalar: kategori kaynaklarından node eşlemesi + slug çakışması
  //    çözümü + kanonik sıra — paylaşılan planlayıcı (W6 aynı planı kullanır).
  const childPlan = planWikiChildPages(graph, supportedKinds);

  for (const entry of childPlan) {
    const drafts = buildWikiNodePageSections(ctx, entry.kind, entry.node);
    const materialized = materializeWikiPage({
      pageId: entry.pageId,
      wikiSnapshotId,
      kind: entry.kind,
      parentId: entry.parentId,
      title: entry.node.qualifiedName,
      slug: entry.slug,
      route: entry.route,
      sections: drafts,
    });
    pages.push(materialized.page);
    sections.push(...materialized.sections);
  }

  // 6) Uyarılar: tek noktadan üretilir (W6 incremental motoru da AYNI
  //    üreticiyi kullanır — canonical eşitlik için).
  const warnings = wikiProjectionWarnings(
    pages,
    sections,
    supportedKinds,
    graph.meta.workspaceId,
  );

  // 7) Snapshot üst verisi: K-013 (1) durum eşlemesi bire bir (graph state
  //    ready/partial → WikiSnapshot.status; hata bildirimi warnings ile).
  const snapshot: WikiSnapshot = {
    id: wikiSnapshotId,
    workspaceId: graph.meta.workspaceId,
    graphSnapshotId: graph.meta.id,
    revisionRef,
    status: sourceState,
    builtAt: input.builtAt,
    templateVersion: WIKI_TEMPLATE_VERSION,
  };

  const projection: WikiProjection = {
    snapshot,
    pages,
    sections,
    warnings,
  };

  // 8) Savunma katmanı: bütün projeksiyon şemadan geçmeli (dangling
  //    pageId/parentId, duplicate kimlik reddi).
  const projectionParse = WikiProjectionSchema.safeParse(projection);
  if (!projectionParse.success) {
    const detail = projectionParse.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/projection-invariant-violation",
      `WikiProjection invariant ihlali: ${detail}`,
    );
  }

  return deepFreeze(projection);
}

/* ---------------------------------------------------------------------------
 * Paylaşılan planlayıcı ve uyarı üreticisi (W6 incremental invalidation;
 * projectWiki ile AYNI kod — canonical eşitliğin tek kaynağı).
 * ------------------------------------------------------------------------- */

/** planWikiChildPages çıktısı: alt sayfanın tam kimlik planı. */
export interface WikiChildPagePlanEntry {
  readonly categoryKey: string;
  readonly categorySlug: string;
  readonly kind: WikiPageKind;
  readonly node: GraphNode;
  readonly pageId: string;
  readonly parentId: string;
  readonly slug: string;
  readonly route: string;
}

/**
 * Graph → alt sayfa planı (kanonik sıra: kategori sırası, sonra pageId).
 * Slug çakışması çözümü dahil — projectWiki ile W6 incremental motoru
 * AYNI planı kullanır; değişmeyen node'ların slug/route değerleri
 * sürümler arasında korunur.
 */
export function planWikiChildPages(
  graph: SnapshotGraph,
  supportedKinds: ReadonlySet<WikiPageKind>,
): readonly WikiChildPagePlanEntry[] {
  // Kategori kaynaklarından node eşlemesi (kanonik sıra).
  const pendingChildren: PendingChild[] = [];
  for (const source of WIKI_CHILD_PAGE_SOURCES) {
    const category = WIKI_ROOT_CATEGORIES.find((entry) => entry.key === source.categoryKey);
    if (category === undefined) {
      throw new WikiProjectionError(
        "wiki/internal",
        `Taksonomi kategorisi bulunamadı: ${source.categoryKey}`,
      );
    }
    if (!supportedKinds.has(category.kind)) {
      // Desteklenmeyen kategoride alt sayfa üretilmez (veri uydurulmaz);
      // uyarı kök kategori adımında verilir.
      continue;
    }
    for (const node of sortedNodesOfKind(graph, source.kinds)) {
      pendingChildren.push({
        categoryKey: category.key,
        categorySlug: category.slug,
        kind: source.pageKind,
        node,
      });
    }
  }

  // Slug çakışması çözümü: aynı route segmentine düşen alt sayfalara
  // node kimliğinden türetilen sonek eklenir (deterministik).
  const slugGroups = new Map<string, PendingChild[]>();
  for (const child of pendingChildren) {
    const slug = wikiSlugify(child.node.qualifiedName);
    const group = slugGroups.get(`${child.categoryKey}/${slug}`) ?? [];
    group.push(child);
    slugGroups.set(`${child.categoryKey}/${slug}`, group);
  }
  const slugByChild = new Map<PendingChild, string>();
  for (const group of slugGroups.values()) {
    if (group.length === 1) {
      const only = group[0]!;
      slugByChild.set(only, wikiSlugify(only.node.qualifiedName));
      continue;
    }
    for (const child of group) {
      slugByChild.set(child, `${wikiSlugify(child.node.qualifiedName)}-${child.node.id.slice(5, 13)}`);
    }
  }

  // Alt sayfalar kanonik sırada: kategori sırası, sonra pageId.
  return [...pendingChildren]
    .map((child) => ({
      child,
      pageId: wikiChildPageId(graph.meta.workspaceId, child.kind, child.node.id),
    }))
    .sort((a, b) => {
      const categoryOrder = (key: string): number =>
        WIKI_ROOT_CATEGORIES.findIndex((category) => category.key === key);
      const orderDiff =
        categoryOrder(a.child.categoryKey) - categoryOrder(b.child.categoryKey);
      return orderDiff !== 0 ? orderDiff : byString(a.pageId, b.pageId);
    })
    .map(({ child, pageId }) => {
      const parentCategory = WIKI_ROOT_CATEGORIES.find(
        (category) => category.key === child.categoryKey,
      );
      if (parentCategory === undefined) {
        throw new WikiProjectionError(
          "wiki/internal",
          `Kök kategori bulunamadı: ${child.categoryKey}`,
        );
      }
      const slug = slugByChild.get(child) ?? wikiSlugify(child.node.qualifiedName);
      return {
        categoryKey: child.categoryKey,
        categorySlug: child.categorySlug,
        kind: child.kind,
        node: child.node,
        pageId,
        parentId: wikiRootPageIdFor(
          graph.meta.workspaceId,
          parentCategory.key,
          parentCategory.kind,
        ),
        slug,
        route: `/wiki/${child.categorySlug}/${slug}`,
      };
    });
}

/**
 * Desteklenmeyen kök kategori için sabit boş bölüm şablonları:
 * desteklenmeyen türde içerik ÜRETİLMEZ, yalnızca iskelet listelenir.
 */
export function wikiUnsupportedRootSections(
  categoryKind: WikiPageKind,
): WikiSectionDraft[] {
  const template = WIKI_ROOT_CATEGORY_TEMPLATES.get(categoryKind);
  if (template === undefined) {
    throw new WikiProjectionError(
      "wiki/internal",
      `Desteklenmeyen kök kategori şablonu yok: ${categoryKind}`,
    );
  }
  return template.map(emptyDraft);
}

/** Yapısal no_data kategorisi için dürüst degrade detayı (varsa). */
export function wikiStructuralNoDataDetail(
  categoryKind: WikiPageKind,
): string | undefined {
  return STRUCTURAL_NO_DATA_DETAIL[categoryKind];
}

/**
 * Projeksiyon uyarılarının TEK üreticisi: desteklenmeyen kategori uyarıları
 * (taksonomi sırasıyla, sayfa başına unsupported önce) + partial bölüm
 * uyarıları (kökler taksonomi sırasıyla, alt sayfalar kategori+pageId
 * sırasıyla). projectWiki ve W6 incremental motoru aynı diziyi üretir —
 * canonical eşitlik uyarılar dahil korunur.
 */
export function wikiProjectionWarnings(
  pages: readonly WikiPage[],
  sections: readonly WikiPageSection[],
  supportedKinds: ReadonlySet<WikiPageKind>,
  workspaceId: string,
): string[] {
  const warnings: string[] = [];
  const sectionsByPage = new Map<string, WikiPageSection[]>();
  for (const section of sections) {
    const list = sectionsByPage.get(section.pageId) ?? [];
    list.push(section);
    sectionsByPage.set(section.pageId, list);
  }

  for (const category of WIKI_ROOT_CATEGORIES) {
    const pageId = wikiRootPageIdFor(workspaceId, category.key, category.kind);
    if (!supportedKinds.has(category.kind)) {
      warnings.push(
        `Kategori '${category.title}' (${category.kind}): sayfa türü bu adapter kümesi tarafından desteklenmiyor — unsupported`,
      );
    }
    for (const section of sectionsByPage.get(pageId) ?? []) {
      if (section.status === "partial") {
        warnings.push(
          `Sayfa '${category.title}' bölümü '${section.sectionKey}': çözülemeyen kenar içeriyor — partial`,
        );
      }
    }
  }

  const rootCategoryIndexByPageId = new Map<string, number>(
    WIKI_ROOT_CATEGORIES.map((category, index) => [
      wikiRootPageIdFor(workspaceId, category.key, category.kind),
      index,
    ]),
  );
  const children = pages
    .filter((page) => page.parentId !== null)
    .sort((a, b) => {
      const orderA = rootCategoryIndexByPageId.get(a.parentId ?? "") ?? Number.MAX_SAFE_INTEGER;
      const orderB = rootCategoryIndexByPageId.get(b.parentId ?? "") ?? Number.MAX_SAFE_INTEGER;
      return orderA !== orderB ? orderA - orderB : byString(a.id, b.id);
    });
  for (const page of children) {
    for (const section of sectionsByPage.get(page.id) ?? []) {
      if (section.status === "partial") {
        warnings.push(
          `Sayfa '${page.title}' bölümü '${section.sectionKey}': çözülemeyen kenar içeriyor — partial`,
        );
      }
    }
  }

  return warnings;
}

/**
 * Desteklenmeyen kök kategoriler için sabit boş bölüm şablonları:
 * desteklenmeyen türde içerik ÜRETİLMEZ, yalnızca iskelet listelenir.
 */
export const WIKI_ROOT_CATEGORY_TEMPLATES: ReadonlyMap<WikiPageKind, readonly string[]> =
  new Map([
    ["overview", ["summary", "languages"]],
    ["architecture", ["layers"]],
    ["project", ["modules"]],
    ["api", ["endpoints"]],
    ["business_flow", ["flows"]],
    ["event", ["events"]],
    ["data", ["schemas"]],
    ["contract", ["contracts"]],
    ["test", ["tests", "coverage-gaps"]],
    ["timeline", ["commits"]],
    ["onboarding", ["path"]],
    ["coverage", ["unresolved"]],
  ]);
