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

interface SectionDraft {
  readonly sectionKey: string;
  readonly markdown: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: WikiPageSectionStatus;
}

interface BuildContext {
  readonly graph: SnapshotGraph;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly outEdges: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly inEdges: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly warnings: string[];
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

function resolutionLabel(resolution: string): string {
  return `[${resolution}]`;
}

function nodeDisplayName(ctx: BuildContext, nodeId: string): string {
  return ctx.nodesById.get(nodeId)?.qualifiedName ?? nodeId;
}

/** Kenar kümesinden span'lı kanıt referansları (kanonik: evidenceId sıralı). */
function evidenceRefsForEdges(
  ctx: BuildContext,
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
): SectionDraft {
  return { sectionKey, status, markdown, evidenceRefs };
}

/** no_data bölümün tek gerçek yüzü: boş içerik, boş kanıt (§16A.1). */
function emptyDraft(sectionKey: string): SectionDraft {
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
  ctx: BuildContext,
  kinds: readonly string[],
): GraphEdge[] {
  const kindSet = new Set(kinds);
  return ctx.graph.edges
    .filter((edge) => kindSet.has(edge.kind))
    .sort((a, b) => byString(a.id, b.id));
}

function edgesFrom(ctx: BuildContext, nodeId: string, kinds?: readonly string[]): GraphEdge[] {
  const list = ctx.outEdges.get(nodeId) ?? [];
  return kinds === undefined
    ? [...list].sort((a, b) => byString(a.id, b.id))
    : list
        .filter((edge) => kinds.includes(edge.kind))
        .sort((a, b) => byString(a.id, b.id));
}

function edgesTo(ctx: BuildContext, nodeId: string, kinds?: readonly string[]): GraphEdge[] {
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

function buildRootSections(
  ctx: BuildContext,
  categoryKind: WikiPageKind,
): SectionDraft[] {
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

function buildOverviewSummary(ctx: BuildContext): SectionDraft {
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

function buildOverviewLanguages(ctx: BuildContext): SectionDraft {
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

function buildArchitectureLayers(ctx: BuildContext): SectionDraft {
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

function buildModulesList(ctx: BuildContext): SectionDraft {
  const modules = sortedNodesOfKind(ctx.graph, ["Module"]);
  if (modules.length === 0) return emptyDraft("modules");
  const lines = modules.map(
    (node) =>
      `- ${node.qualifiedName}${node.location === undefined ? "" : ` (${node.location.relativePath})`}`,
  );
  return draft("modules", "ok", lines.join("\n"));
}

function buildEndpointsList(ctx: BuildContext): SectionDraft {
  const endpoints = sortedNodesOfKind(ctx.graph, ["Endpoint"]);
  if (endpoints.length === 0) return emptyDraft("endpoints");
  const lines = endpoints.map((node) => `- ${node.qualifiedName}`);
  return draft("endpoints", "ok", lines.join("\n"));
}

function buildEventsList(ctx: BuildContext): SectionDraft {
  const events = sortedNodesOfKind(ctx.graph, ["Event", "Topic", "Queue"]);
  if (events.length === 0) return emptyDraft("events");
  const lines = events.map(
    (node) => `- ${node.kind.toLowerCase()} ${node.qualifiedName}`,
  );
  return draft("events", "ok", lines.join("\n"));
}

function buildSchemasList(ctx: BuildContext): SectionDraft {
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

function buildContractsList(ctx: BuildContext): SectionDraft {
  const contracts = sortedNodesOfKind(ctx.graph, CONTRACT_NODE_KINDS);
  if (contracts.length === 0) return emptyDraft("contracts");
  const lines = contracts.map(
    (node) => `- ${node.kind} ${node.qualifiedName}`,
  );
  return draft("contracts", "ok", lines.join("\n"));
}

function buildTestsList(ctx: BuildContext): SectionDraft {
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

function buildUnresolvedReport(ctx: BuildContext): SectionDraft {
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

function buildChildSections(
  ctx: BuildContext,
  pageKind: WikiPageKind,
  node: GraphNode,
): SectionDraft[] {
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

interface PageDraft {
  readonly page: WikiPage;
  readonly sections: readonly WikiPageSection[];
}

interface PendingChild {
  readonly categoryKey: string;
  readonly categorySlug: string;
  readonly kind: WikiPageKind;
  readonly node: GraphNode;
}

const CHILD_SOURCES: readonly {
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
  sections: readonly SectionDraft[],
): CoverageStatus {
  const statuses = sections.map((section) => section.status);
  if (statuses.every((status) => status === "no_data")) return "no_data";
  if (statuses.every((status) => status === "ok")) return "complete";
  return "partial";
}

function materializePage(draftInput: {
  pageId: string;
  wikiSnapshotId: string;
  kind: WikiPageKind;
  parentId: string | null;
  title: string;
  slug: string;
  route: string;
  sections: readonly SectionDraft[];
  coverageOverride?: CoverageStatus;
  coverageDetail?: string;
}): PageDraft {
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

  // 3) İndeksler: node/edge/kanıt haritaları + uyarı biriktirici.
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
  const warnings: string[] = [];
  const ctx: BuildContext = {
    graph,
    nodesById,
    evidenceById,
    outEdges,
    inEdges,
    warnings,
  };

  const wikiSnapshotId = `wiki:${sha256Hex(
    utf8Encode(canonicalJson([graph.meta.id, WIKI_TEMPLATE_VERSION])),
  )}`;

  const pages: WikiPage[] = [];
  const sections: WikiPageSection[] = [];

  // 4) Kök kategori sayfaları: taksonomi sırasıyla (§16A.1 ağacı).
  const rootPageIds = new Map<string, string>();
  for (const category of WIKI_ROOT_CATEGORIES) {
    const pageId = deterministicId("page", [
      graph.meta.workspaceId,
      "root",
      category.key,
      category.kind,
    ]);
    rootPageIds.set(category.key, pageId);

    const drafts: SectionDraft[] =
      supportedKinds.has(category.kind)
        ? buildRootSections(ctx, category.kind)
        : WIKI_ROOT_CATEGORY_TEMPLATES.get(category.kind)!.map(emptyDraft);

    if (!supportedKinds.has(category.kind)) {
      warnings.push(
        `Kategori '${category.title}' (${category.kind}): sayfa türü bu adapter kümesi tarafından desteklenmiyor — unsupported`,
      );
    }

    const structuralDetail =
      !supportedKinds.has(category.kind)
        ? undefined
        : STRUCTURAL_NO_DATA_DETAIL[category.kind];

    const materialized = materializePage({
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

    for (const section of materialized.sections) {
      if (section.status === "partial") {
        warnings.push(
          `Sayfa '${category.title}' bölümü '${section.sectionKey}': çözülemeyen kenar içeriyor — partial`,
        );
      }
    }
  }

  // 5) Alt sayfalar: kategori kaynaklarından node eşlemesi (kanonik sıra).
  const pendingChildren: PendingChild[] = [];
  for (const source of CHILD_SOURCES) {
    const category = WIKI_ROOT_CATEGORIES.find((entry) => entry.key === source.categoryKey);
    if (category === undefined) {
      throw new WikiProjectionError(
        "wiki/internal",
        `Taksonomi kategorisi bulunamadı: ${source.categoryKey}`,
      );
    }
    if (!supportedKinds.has(category.kind)) {
      // Desteklenmeyen kategoride alt sayfa üretilmez (veri uydurulmaz);
      // uyarı kök kategori adımında zaten verildi.
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

  // 6) Slug çakışması çözümü: aynı route segmentine düşen alt sayfalara
  //    node kimliğinden türetilen sonek eklenir (deterministik).
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
  const childPageIdOf = (child: PendingChild): string =>
    deterministicId("page", [
      graph.meta.workspaceId,
      "node",
      child.kind,
      child.node.id,
    ]);
  const orderedChildren = [...pendingChildren]
    .map((child) => ({ child, pageId: childPageIdOf(child) }))
    .sort((a, b) => {
      const categoryOrder = (key: string): number =>
        WIKI_ROOT_CATEGORIES.findIndex((category) => category.key === key);
      const orderDiff =
        categoryOrder(a.child.categoryKey) - categoryOrder(b.child.categoryKey);
      return orderDiff !== 0 ? orderDiff : byString(a.pageId, b.pageId);
    });

  for (const { child, pageId } of orderedChildren) {
    const parentId = rootPageIds.get(child.categoryKey);
    if (parentId === undefined) {
      throw new WikiProjectionError(
        "wiki/internal",
        `Kök sayfa kimliği bulunamadı: ${child.categoryKey}`,
      );
    }
    const slug = slugByChild.get(child) ?? wikiSlugify(child.node.qualifiedName);
    const drafts = buildChildSections(ctx, child.kind, child.node);
    const materialized = materializePage({
      pageId,
      wikiSnapshotId,
      kind: child.kind,
      parentId,
      title: child.node.qualifiedName,
      slug,
      route: `/wiki/${child.categorySlug}/${slug}`,
      sections: drafts,
    });
    pages.push(materialized.page);
    sections.push(...materialized.sections);

    for (const section of materialized.sections) {
      if (section.status === "partial") {
        warnings.push(
          `Sayfa '${materialized.page.title}' bölümü '${section.sectionKey}': çözülemeyen kenar içeriyor — partial`,
        );
      }
    }
  }

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

/**
 * Desteklenmeyen kök kategoriler için sabit boş bölüm şablonları:
 * desteklenmeyen türde içerik ÜRETİLMEZ, yalnızca iskelet listelenir.
 */
const WIKI_ROOT_CATEGORY_TEMPLATES: ReadonlyMap<WikiPageKind, readonly string[]> =
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
