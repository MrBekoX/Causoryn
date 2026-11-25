/**
 * Causoryn offline architecture viewer üreticisi — sprint-6 E6 (TŞ v2.1 §16
 * "Onboarding, görselleştirme ve export", s.14).
 *
 * TŞ §16 viewer sorumlulukları (pdftotext ile s.14'ten okundu):
 * - "Etkileşimli viewer büyük grafik parça parça sorgular; selection →
 *   get_evidence → kaynak dosya/satır."
 * - "resolved/heuristic/unresolved edge tipleri ayrı işaretlenir."
 * - "Export JSON, Mermaid, Markdown, offline/self-contained HTML."
 * - "Viewer server dışında ayrıca paketlenebilir."
 * - "Export güvenliği: ... HTML escaping, mümkünse offline CSP; remote CDN /
 *   analytics yok; proje kaynakları harici servise gönderilmez."
 *
 * Mermaid kararı (görev sözleşmesi): mermaid.js BUNDLE EDİLMEZ ve ağdan
 * YÜKLENMEZ. Bunun yerine bu modül KENDİ basit, deterministik inline SVG
 * graph render'ını üretir: node kutuları + kenar okları, resolution renk
 * kodlu (verified=yeşil düz, heuristic=sarı kesikli, unresolved=gri noktalı).
 * Ayrım çift kanallıdır: kenarlarda sınıf adı (res-verified/...) + stroke
 * stili; node'larda data-res-level özniteliği + kutu kontur rengi (komşu
 * kenarlardan türetilen en iyi çözüm: verified > heuristic > unresolved).
 *
 * C6 desenleri (packages/graph/src/export.ts) KOPYALA-UYARLA, bağımlılıksız:
 * - escapeHtml: aynı karakter kümesi (&, <, >, ", ').
 * - Restrictive CSP meta: `default-src 'none'; base-uri 'none';
 *   form-action 'none'` plus SHA-256 hash sources for the embedded blocks:
 *   `script-src 'sha256-…'` (the viewer is interactive: selection →
 *   evidence panel, served by one static inline script) and
 *   `style-src 'sha256-…'` (one static inline stylesheet). No
 *   'unsafe-inline'; every load path stays closed and no external source
 *   is used.
 * - Kanonik sıra: node/edge/evidence/wiki sayfaları id'ye göre bayt-artan
 *   sıralanır; aynı girdi iki koşumda bit-bit aynı HTML üretir (TŞ §8
 *   invariant vi'nin viewer karşılığı; girdi dizi sırasından bağımsız).
 * - Savunma katmanı: dangling edge sessiz düşürülmez, sabit
 *   `viewer/dangling-edge` koduyla reddedilir (C6 export/dangling-edge
 *   örüntüsü; geçerli snapshot'ta oluşmaz — TŞ §8 invariant ii).
 *
 * Selection → get_evidence akışı (çevrimdışı sunum, TOOL çağrısı DEĞİL):
 * - Node → kanıt kuralı, get_evidence'ın sprint-1/E4 semantiğini aynalar:
 *   packages/graph/src/evidence-chain.ts `nodeEvidenceIdsInOrder` — komşu
 *   kenarların evidenceIds birleşimi, bayt-artan tekrarsız düzen.
 * - Edge → kendi evidenceIds (bayt-artan).
 * - Tüm kanıt kayıtları (id/kind/span/analyzerId/analyzerVersion/rationale)
 *   `<script type="application/json">` veri adasına gömülür; gömülü statik
 *   betik tıklamayı panelde sunar (yalnızca DOM textContent kullanır —
 *   innerHTML YOK, fetch/XHR YOK).
 *
 * Katman sözleşmesi: SAF FONKSİYON — bu modül fs/ağ/saat/rastgelelik
 * okumaz (node:crypto only hashes the static blocks for the CSP), girdiyi
 * mutate etmez, hiçbir @causoryn/* paketini import etmez
 * (apps/ workspaces dışıdır; yapısal tipler yerel tanımlıdır, domain tipleri
 * yapısal olarak uyumludur). Herhangi bir orkestrasyon katmanı bu fonksiyonu
 * çağırıp çıktıyı izinli output dizinine yazabilir (TŞ §16 "Viewer server
 * dışında ayrıca paketlenebilir"; yazma yetkilendirmesi OutputAccessPolicy
 * katmanının işidir — burada tekrarlanmaz).
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Hata türü                                                           */
/* ------------------------------------------------------------------ */

/** Sabit hata kodu taşıyan viewer hatası (graph sözleşme örüntüsü). */
export class ViewerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ViewerError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Yapısal girdi tipleri (@causoryn/* bağımlılığı YOK)                 */
/* ------------------------------------------------------------------ */

/** TŞ §8 Resolution — get_evidence/lejant semantiği. */
export type ViewerResolution = "verified" | "heuristic" | "unresolved";

/** TŞ §8 GraphSnapshot.state ile aynı küme (wiki status kümesiyle birebir). */
export type ViewerSnapshotState = "building" | "ready" | "partial" | "failed";

/** Kaynak konumu (TŞ §8 SourceSpan; sourceHash yapısal olarak opsiyoneldir). */
export interface ViewerSpan {
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceHash?: string;
}

/** Graph düğümü (TŞ §8 GraphNode yapısal aynası; attributes render edilmez). */
export interface ViewerNode {
  readonly id: string;
  readonly kind: string;
  readonly qualifiedName: string;
  readonly language?: string;
  readonly location?: ViewerSpan;
}

/** Graph kenarı (TŞ §8 GraphEdge yapısal aynası). */
export interface ViewerEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly resolution: ViewerResolution;
  readonly evidenceIds: readonly string[];
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

/** Kanıt kaydı (TŞ §8 Evidence yapısal aynası). */
export interface ViewerEvidence {
  readonly id: string;
  readonly kind: string;
  readonly span?: ViewerSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}

/** Üst veri (TŞ §8 GraphSnapshot yapısal aynası). */
export interface ViewerGraphMeta {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: { readonly id: string; readonly sequence: number };
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly state: ViewerSnapshotState;
  readonly createdAt: string;
}

/** Bütün graph girdisi (domain SnapshotGraph yapısal olarak uyumludur). */
export interface ViewerGraphInput {
  readonly meta: ViewerGraphMeta;
  readonly nodes: readonly ViewerNode[];
  readonly edges: readonly ViewerEdge[];
  readonly evidence: readonly ViewerEvidence[];
}

/** Wiki sayfa özeti (packages/wiki WikiPage/WikiSnapshot minimal aynası). */
export interface ViewerWikiPage {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly route: string;
  readonly coverageStatus: string;
}

/** WikiSnapshot özeti (packages/wiki WikiSnapshot minimal yapısal aynası). */
export interface ViewerWikiSummary {
  readonly id: string;
  readonly graphSnapshotId: string;
  readonly status: ViewerSnapshotState;
  readonly revisionRef: string;
  readonly templateVersion: string;
  readonly pages?: readonly ViewerWikiPage[];
}

/** generateViewerHtml girdisi: graph zorunlu, wiki özeti opsiyoneldir. */
export interface ViewerInput {
  readonly graph: ViewerGraphInput;
  readonly wiki?: ViewerWikiSummary;
}

/* ------------------------------------------------------------------ */
/* Sabitler                                                            */
/* ------------------------------------------------------------------ */

/** Çözüm seviyesi renkleri: verified=yeşil, heuristic=sarı, unresolved=gri. */
const RESOLUTION_COLORS: Readonly<Record<ViewerResolution, string>> = {
  verified: "#16a34a",
  heuristic: "#d97706",
  unresolved: "#6b7280",
};

/** Çözüm seviyesi çizgi desenleri: düz / kesikli / noktalı. */
const RESOLUTION_DASH: Readonly<Record<ViewerResolution, string>> = {
  verified: "",
  heuristic: "8 4",
  unresolved: "2 4",
};

/** Deterministik grid yerleşimi sabitleri. */
const SVG_MARGIN = 24;
const SVG_NODE_W = 220;
const SVG_NODE_H = 64;
const SVG_COL_GAP = 48;
const SVG_ROW_GAP = 96;
const SVG_COLUMNS = 4;

/* ------------------------------------------------------------------ */
/* Kaçış yardımcıları (C6 export.ts kopyala-uyarla)                    */
/* ------------------------------------------------------------------ */

/** HTML metin/öznitelik kaçışı: tüm dinamik değerler bu fonksiyondan geçer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Veri adası kaçışı: JSON.stringify çıktısındaki `<`/`>`/`&` güvenli
 * `\uXXXX` kaçışlarına çevrilir; böylece gömülü veri içindeki `</script>`
 * dizgisi belgede ham script kapanışı olarak görünemez (veri bütünlüğü
 * korunur: `\u003c` geçerli JSON kaçışıdır, parse sonrası özgün dizgi geri
 * gelir). U+2028/U+2029 de kaçırılır (ES2019 öncesi ayrıştırıcı uyumu).
 */
function escapeJsonForScriptIsland(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Bayt-artan dizgi karşılaştırması. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** id alanına göre kanonik sıralama karşılaştırıcısı. */
function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return compareStrings(a.id, b.id);
}

/* ------------------------------------------------------------------ */
/* Kanonik görünüm + savunma katmanı                                   */
/* ------------------------------------------------------------------ */

interface OrderedViewerView {
  readonly meta: ViewerGraphMeta;
  readonly nodes: readonly ViewerNode[];
  readonly edges: readonly ViewerEdge[];
  readonly evidence: readonly ViewerEvidence[];
  readonly pages: readonly ViewerWikiPage[];
  readonly wiki: ViewerWikiSummary | undefined;
}

/**
 * Kanonik sıra + savunma: diziler id'ye göre sıralanır (girdi sırasından
 * bağımsız determinizm); dangling kenar sabit kodla reddedilir.
 */
function orderedViewerView(input: ViewerInput): OrderedViewerView {
  const nodeIds = new Set(input.graph.nodes.map((node) => node.id));
  for (const edge of input.graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new ViewerError(
        "viewer/dangling-edge",
        `Edge endpoint points to an unknown node; use a finalized snapshot: ${edge.id}`,
      );
    }
  }
  return {
    meta: input.graph.meta,
    nodes: [...input.graph.nodes].sort(byId),
    edges: [...input.graph.edges].sort(byId),
    evidence: [...input.graph.evidence].sort(byId),
    pages: [...(input.wiki?.pages ?? [])].sort(byId),
    wiki: input.wiki,
  };
}

/**
 * Node kanıt kimlikleri: komşu kenarların evidenceIds birleşimi, bayt-artan
 * tekrarsız düzen (get_evidence sprint-1 düzeni; evidence-chain.ts
 * nodeEvidenceIdsInOrder semantiği).
 */
function nodeEvidenceIdsInOrder(
  edges: readonly ViewerEdge[],
  nodeId: string,
): readonly string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    for (const evidenceId of edge.evidenceIds) {
      if (seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      ids.push(evidenceId);
    }
  }
  return ids.sort(compareStrings);
}

/**
 * Node çözüm seviyesi türetme: komşu kenarların EN İYİ çözümü — öncelik
 * verified > heuristic > unresolved (belgelenmiş deterministik kural).
 */
function nodeResolutionLevel(
  edges: readonly ViewerEdge[],
  nodeId: string,
): ViewerResolution {
  let level: ViewerResolution = "unresolved";
  for (const edge of edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    if (edge.resolution === "verified") return "verified";
    if (edge.resolution === "heuristic") level = "heuristic";
  }
  return level;
}

/* ------------------------------------------------------------------ */
/* Inline SVG graph render (Mermaid kütüphanesi YOK)                   */
/* ------------------------------------------------------------------ */

interface SvgGeometry {
  readonly width: number;
  readonly height: number;
  readonly x: (nodeId: string) => number;
  readonly y: (nodeId: string) => number;
}

/** Deterministik grid geometrisi: id-sıralı node indeksine göre konum. */
function svgGeometry(nodes: readonly ViewerNode[]): SvgGeometry {
  const count = nodes.length;
  const cols = Math.max(1, Math.min(count, SVG_COLUMNS));
  const rows = Math.max(1, Math.ceil(count / SVG_COLUMNS));
  const width = SVG_MARGIN * 2 + cols * SVG_NODE_W + (cols - 1) * SVG_COL_GAP;
  const height = SVG_MARGIN * 2 + rows * SVG_NODE_H + (rows - 1) * SVG_ROW_GAP;
  const indexById = new Map<string, number>();
  for (const [index, node] of nodes.entries()) indexById.set(node.id, index);
  const position = (nodeId: string, axis: "x" | "y"): number => {
    const index = indexById.get(nodeId);
    if (index === undefined) return 0; // savunma: dangling zaten reddedildi
    const col = index % SVG_COLUMNS;
    const row = Math.floor(index / SVG_COLUMNS);
    const step = axis === "x" ? SVG_NODE_W + SVG_COL_GAP : SVG_NODE_H + SVG_ROW_GAP;
    return SVG_MARGIN + (axis === "x" ? col : row) * step;
  };
  return {
    width,
    height,
    x: (nodeId) => position(nodeId, "x"),
    y: (nodeId) => position(nodeId, "y"),
  };
}

/** Çözüm seviyesi ok ucunun marker kimliği. */
function markerId(resolution: ViewerResolution): string {
  return `arrow-${resolution}`;
}

/** `<defs>` ok uçları: her çözüm seviyesi kendi renkli marker'ını taşır. */
function svgDefs(): string {
  const lines: string[] = [];
  lines.push("<defs>");
  for (const resolution of ["verified", "heuristic", "unresolved"] as const) {
    lines.push(
      `<marker id="${markerId(resolution)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
        `<path d="M 0 0 L 10 5 L 0 10 z" fill="${RESOLUTION_COLORS[resolution]}"></path></marker>`,
    );
  }
  lines.push("</defs>");
  return lines.join("");
}

/** Tek kenarın SVG grubu: renk/desenli ok + tıklama isabet çizgisi + etiket. */
function svgEdgeGroup(edge: ViewerEdge, geo: SvgGeometry, labels: ReadonlyMap<string, string>): string {
  const x1 = geo.x(edge.from) + SVG_NODE_W / 2;
  const y1 = geo.y(edge.from) + SVG_NODE_H / 2;
  const x2 = geo.x(edge.to) + SVG_NODE_W / 2;
  const y2 = geo.y(edge.to) + SVG_NODE_H / 2;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const color = RESOLUTION_COLORS[edge.resolution];
  const dash = RESOLUTION_DASH[edge.resolution];
  const dashAttr = dash.length > 0 ? ` stroke-dasharray="${dash}"` : "";
  const label = `${edge.kind}/${edge.resolution}`;
  const aria = `${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to} (${label})`;
  const evidenceIds = [...edge.evidenceIds].sort(compareStrings).join(",");
  const ambiguityTitle =
    edge.ambiguity === undefined
      ? ""
      : `<title>belirsiz: ${escapeHtml(edge.ambiguity.reason)}</title>`;
  return (
    `<g class="viewer-edge res-${edge.resolution}" data-viewer-id="${escapeHtml(edge.id)}"` +
    ` data-evidence-ids="${escapeHtml(evidenceIds)}" data-label="${escapeHtml(label)}"` +
    ` tabindex="0" role="button" aria-label="${escapeHtml(aria)}">` +
    ambiguityTitle +
    `<line class="edge-hit" x1="${String(x1)}" y1="${String(y1)}" x2="${String(x2)}" y2="${String(y2)}"></line>` +
    `<line class="edge-line" x1="${String(x1)}" y1="${String(y1)}" x2="${String(x2)}" y2="${String(y2)}"` +
    ` stroke="${color}"${dashAttr} marker-end="url(#${markerId(edge.resolution)})"></line>` +
    `<text class="edge-label" x="${String(midX)}" y="${String(midY - 6)}" text-anchor="middle">${escapeHtml(label)}</text>` +
    `</g>`
  );
}

/** Tek node'un SVG grubu: kutu + kind/qualifiedName metinleri. */
function svgNodeGroup(node: ViewerNode, geo: SvgGeometry, level: ViewerResolution, evidenceIds: readonly string[]): string {
  const x = geo.x(node.id);
  const y = geo.y(node.id);
  const evidence = [...evidenceIds].sort(compareStrings).join(",");
  const location =
    node.location === undefined
      ? ""
      : ` (${escapeHtml(node.location.relativePath)}:${String(node.location.startLine)}-${String(node.location.endLine)})`;
  const title =
    `<title>${escapeHtml(`${node.kind} :: ${node.qualifiedName}`)}${location}</title>`;
  const stroke =
    level === "verified"
      ? { color: RESOLUTION_COLORS.verified, width: "2.5" }
      : level === "heuristic"
        ? { color: RESOLUTION_COLORS.heuristic, width: "2.5" }
        : { color: RESOLUTION_COLORS.unresolved, width: "1.5" };
  return (
    `<g class="viewer-node" data-viewer-id="${escapeHtml(node.id)}"` +
    ` data-evidence-ids="${escapeHtml(evidence)}" data-label="${escapeHtml(node.qualifiedName)}"` +
    ` data-res-level="${level}"` +
    ` tabindex="0" role="button" aria-label="${escapeHtml(`${node.kind} :: ${node.qualifiedName}`)}">` +
    title +
    `<rect x="${String(x)}" y="${String(y)}" width="${String(SVG_NODE_W)}" height="${String(SVG_NODE_H)}" rx="8"` +
    ` stroke="${stroke.color}" stroke-width="${stroke.width}"></rect>` +
    `<text class="node-kind" x="${String(x + 12)}" y="${String(y + 24)}">${escapeHtml(node.kind)}</text>` +
    `<text class="node-name" x="${String(x + 12)}" y="${String(y + 46)}">${escapeHtml(node.qualifiedName)}</text>` +
    `</g>`
  );
}

/** Bütün SVG gövdesi: boş graph'ta yalnızca iskelet (viewBox'lı boş svg). */
function svgBody(view: OrderedViewerView): string {
  const isEmpty = view.nodes.length === 0;
  const geo = svgGeometry(view.nodes);
  const labels = new Map<string, string>(
    view.nodes.map((node) => [node.id, node.qualifiedName]),
  );
  const lines: string[] = [];
  lines.push(
    `<svg class="viewer-svg" viewBox="0 0 ${String(geo.width)} ${String(geo.height)}"` +
      ` width="${String(geo.width)}" height="${String(geo.height)}" role="img" aria-label="architecture graph">`,
  );
  lines.push(svgDefs());
  if (isEmpty) {
    lines.push("</svg>");
    return lines.join("");
  }
  for (const edge of view.edges) lines.push(svgEdgeGroup(edge, geo, labels));
  for (const node of view.nodes) {
    lines.push(
      svgNodeGroup(
        node,
        geo,
        nodeResolutionLevel(view.edges, node.id),
        nodeEvidenceIdsInOrder(view.edges, node.id),
      ),
    );
  }
  lines.push("</svg>");
  return lines.join("");
}

/* ------------------------------------------------------------------ */
/* Gömülü veri adası (application/json)                                */
/* ------------------------------------------------------------------ */

interface IslandNode {
  readonly id: string;
  readonly kind: string;
  readonly qualifiedName: string;
  readonly resolution: ViewerResolution;
  readonly evidenceIds: readonly string[];
}

interface IslandEdge {
  readonly id: string;
  readonly kind: string;
  readonly resolution: ViewerResolution;
  readonly from: string;
  readonly to: string;
  readonly evidenceIds: readonly string[];
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

interface IslandEvidence {
  readonly id: string;
  readonly kind: string;
  readonly span?: {
    readonly relativePath: string;
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}

interface IslandWiki {
  readonly id: string;
  readonly graphSnapshotId: string;
  readonly status: ViewerSnapshotState;
  readonly revisionRef: string;
  readonly templateVersion: string;
  readonly pages: readonly ViewerWikiPage[];
}

interface ViewerDataIsland {
  readonly nodes: readonly IslandNode[];
  readonly edges: readonly IslandEdge[];
  readonly evidence: readonly IslandEvidence[];
  readonly wiki?: IslandWiki;
}

/** Kanonik veri adası: sabit anahtar sırası + id sıralı diziler. */
function buildDataIsland(view: OrderedViewerView): ViewerDataIsland {
  const islandNodes: IslandNode[] = view.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    resolution: nodeResolutionLevel(view.edges, node.id),
    evidenceIds: nodeEvidenceIdsInOrder(view.edges, node.id),
  }));
  const islandEdges: IslandEdge[] = view.edges.map((edge) => ({
    id: edge.id,
    kind: edge.kind,
    resolution: edge.resolution,
    from: edge.from,
    to: edge.to,
    evidenceIds: [...edge.evidenceIds].sort(compareStrings),
    ...(edge.ambiguity === undefined
      ? {}
      : {
          ambiguity: {
            candidates: [...edge.ambiguity.candidates],
            reason: edge.ambiguity.reason,
          },
        }),
  }));
  const islandEvidence: IslandEvidence[] = view.evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.span === undefined
      ? {}
      : {
          span: {
            relativePath: item.span.relativePath,
            startLine: item.span.startLine,
            endLine: item.span.endLine,
          },
        }),
    analyzerId: item.analyzerId,
    analyzerVersion: item.analyzerVersion,
    rationale: item.rationale,
  }));
  const wiki = view.wiki;
  return {
    nodes: islandNodes,
    edges: islandEdges,
    evidence: islandEvidence,
    ...(wiki === undefined
      ? {}
      : {
          wiki: {
            id: wiki.id,
            graphSnapshotId: wiki.graphSnapshotId,
            status: wiki.status,
            revisionRef: wiki.revisionRef,
            templateVersion: wiki.templateVersion,
            pages: view.pages,
          },
        }),
  };
}

/* ------------------------------------------------------------------ */
/* Gömülü statik uygulama betiği (çevrimdışı selection → evidence)     */
/* ------------------------------------------------------------------ */

/**
 * Statik, ağ-ilkeli betik: yalnızca DOM textContent kullanır (innerHTML
 * YOK), fetch/XHR/beacon YOK; veri adasından JSON.parse ile okur, paneli
 * doldurur. Gömülü betik aynı sabit olduğu için çıktıya bit-bit aynı
 * girer (determinizmin parçası).
 */
const VIEWER_APP_JS = `
(function () {
  "use strict";
  var island = document.getElementById("causoryn-data");
  var panel = document.getElementById("evidence-panel");
  var panelTitle = document.getElementById("evidence-panel-title");
  var panelBody = document.getElementById("evidence-panel-body");
  var closeBtn = document.getElementById("evidence-panel-close");
  if (!island || !panel || !panelTitle || !panelBody || !closeBtn) return;
  var data = {};
  try {
    data = JSON.parse(island.textContent || "{}");
  } catch (err) {
    data = {};
  }
  var nodesById = {};
  var evidenceById = {};
  var i;
  var list = data.nodes || [];
  for (i = 0; i < list.length; i++) nodesById[list[i].id] = list[i];
  list = data.evidence || [];
  for (i = 0; i < list.length; i++) evidenceById[list[i].id] = list[i];

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function addTerm(parent, term, value) {
    var dt = document.createElement("dt");
    var dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    parent.appendChild(dt);
    parent.appendChild(dd);
  }

  function spanText(span) {
    if (!span) return "(span yok)";
    return span.relativePath + ":" + String(span.startLine) + "-" + String(span.endLine);
  }

  function showPanel(targetId, label, ids) {
    clearChildren(panelTitle);
    panelTitle.textContent = label + " — " + targetId;
    clearChildren(panelBody);
    if (!ids.length) {
      var note = document.createElement("p");
      note.className = "panel-note";
      note.textContent = "No embedded evidence for this item.";
      panelBody.appendChild(note);
    }
    for (var j = 0; j < ids.length; j++) {
      var item = document.createElement("article");
      item.className = "evidence-item";
      var head = document.createElement("h3");
      var record = evidenceById[ids[j]];
      if (!record) {
        head.textContent = ids[j] + " — no embedded record";
        item.appendChild(head);
      } else {
        head.textContent = record.id + " (" + record.kind + ")";
        item.appendChild(head);
        var dl = document.createElement("dl");
        addTerm(dl, "Konum", spanText(record.span));
        addTerm(dl, "Analyzer", record.analyzerId + " @ " + record.analyzerVersion);
        addTerm(dl, "Rationale", record.rationale);
        item.appendChild(dl);
      }
      panelBody.appendChild(item);
    }
    panel.hidden = false;
  }

  function onActivate(ev) {
    var el = ev.currentTarget;
    if (!el) return;
    var id = el.getAttribute("data-viewer-id");
    if (!id) return;
    var raw = el.getAttribute("data-evidence-ids") || "";
    var ids = raw.length > 0 ? raw.split(",") : [];
    var label = el.getAttribute("data-label") || id;
    var previous = document.querySelector(".viewer-selected");
    if (previous) previous.classList.remove("viewer-selected");
    el.classList.add("viewer-selected");
    showPanel(id, label, ids);
  }

  function onKeyActivate(ev) {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onActivate(ev);
    }
  }

  var targets = document.querySelectorAll("[data-viewer-id]");
  for (i = 0; i < targets.length; i++) {
    targets[i].addEventListener("click", onActivate);
    targets[i].addEventListener("keydown", onKeyActivate);
  }
  closeBtn.addEventListener("click", function () {
    panel.hidden = true;
    var previous = document.querySelector(".viewer-selected");
    if (previous) previous.classList.remove("viewer-selected");
  });
})();
`.trim();

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

const VIEWER_CSS = [
  ":root { color-scheme: light dark; }",
  "* { box-sizing: border-box; }",
  "body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; line-height: 1.45; }",
  "h1 { border-bottom: 2px solid #64748b; font-size: 1.35rem; }",
  "h2 { border-bottom: 1px solid #94a3b8; font-size: 1.1rem; margin-top: 1.5rem; }",
  "dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0.5rem 0; }",
  "dt { font-weight: 600; }",
  "dd { margin: 0; overflow-wrap: anywhere; }",
  "table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }",
  "th, td { border: 1px solid #94a3b8; padding: 0.3rem 0.5rem; text-align: left; overflow-wrap: anywhere; }",
  "th { background: rgba(100, 116, 139, 0.18); }",
  ".viewer-note { color: #64748b; font-size: 0.85rem; }",
  ".legend { list-style: none; display: flex; gap: 1.5rem; padding: 0; flex-wrap: wrap; font-size: 0.85rem; }",
  ".legend-swatch { display: inline-block; width: 2.2rem; margin-right: 0.4rem; vertical-align: middle; border-top-width: 3px; border-top-style: solid; }",
  ".swatch-verified { border-top-color: #16a34a; }",
  ".swatch-heuristic { border-top-color: #d97706; border-top-style: dashed; }",
  ".swatch-unresolved { border-top-color: #6b7280; border-top-style: dotted; }",
  ".graph-warning { border: 1px solid #d97706; background: rgba(217, 119, 6, 0.12); padding: 0.5rem 0.75rem; margin: 0.5rem 0; }",
  ".viewer-svg { border: 1px solid #94a3b8; max-width: 100%; height: auto; }",
  ".viewer-node rect { fill: rgba(100, 116, 139, 0.14); }",
  ".viewer-node text { font-family: system-ui, sans-serif; fill: currentColor; }",
  ".node-kind { font-size: 11px; opacity: 0.75; }",
  ".node-name { font-size: 13px; font-weight: 600; }",
  ".viewer-edge line.edge-hit { stroke: transparent; stroke-width: 14; pointer-events: stroke; fill: none; }",
  ".viewer-edge text.edge-label { font-size: 11px; fill: currentColor; opacity: 0.85; }",
  ".viewer-node, .viewer-edge { cursor: pointer; outline: none; }",
  ".viewer-selected rect { filter: drop-shadow(0 0 4px #2563eb); }",
  ".viewer-selected text { text-decoration: underline; }",
  "#evidence-panel { position: fixed; right: 1rem; bottom: 1rem; width: min(26rem, 90vw); max-height: 60vh; overflow: auto; border: 1px solid #64748b; background: Canvas; color: CanvasText; padding: 0.75rem; }",
  "#evidence-panel[hidden] { display: none; }",
  "#evidence-panel h2 { margin: 0 0 0.5rem 0; border-bottom: none; font-size: 1rem; overflow-wrap: anywhere; }",
  ".evidence-item { border: 1px solid #94a3b8; padding: 0.5rem; margin-bottom: 0.5rem; }",
  ".evidence-item h3 { margin: 0 0 0.35rem 0; font-size: 0.9rem; overflow-wrap: anywhere; }",
  ".panel-note { color: #d97706; font-size: 0.9rem; }",
  "#evidence-panel-close { margin-bottom: 0.5rem; }",
].join("\n");

/* ------------------------------------------------------------------ */
/* Content Security Policy                                             */
/* ------------------------------------------------------------------ */

/** CSP hash source for one inline block: base64 SHA-256 of its exact text. */
function cspHashSource(blockText: string): string {
  return `'sha256-${createHash("sha256").update(blockText, "utf8").digest("base64")}'`;
}

/**
 * Restrictive offline CSP. default-src 'none' closes every load path
 * (img/font/connect/frame/media/worker); script-src and style-src allow
 * exactly the two embedded blocks by SHA-256 hash, so no other inline
 * script, event handler or style can run ('unsafe-inline' is not used).
 * Both blocks are static constants, which keeps the policy deterministic.
 * The `<script type="application/json">` data island is not executable and
 * needs no script permission.
 */
export const VIEWER_CSP_POLICY = `default-src 'none'; script-src ${cspHashSource(VIEWER_APP_JS)}; style-src ${cspHashSource(VIEWER_CSS)}; base-uri 'none'; form-action 'none'`;

/* ------------------------------------------------------------------ */
/* Statik bölümler                                                     */
/* ------------------------------------------------------------------ */

/** Meta dl satırları: sıralı sabit terim kümesi (determinizm). */
function metaSection(meta: ViewerGraphMeta): string {
  const pairs: readonly (readonly [string, string])[] = [
    ["id", meta.id],
    ["workspaceId", meta.workspaceId],
    ["revision", `${meta.revision.id} (sequence ${String(meta.revision.sequence)})`],
    ["configHash", meta.configHash],
    ["analyzerFingerprint", meta.analyzerFingerprint],
    ["state", meta.state],
    ["createdAt", meta.createdAt],
  ];
  const lines: string[] = [];
  lines.push("<section>");
  lines.push("<h2>Snapshot</h2>");
  lines.push("<dl>");
  for (const [term, value] of pairs) {
    lines.push(`<dt>${escapeHtml(term)}</dt>`);
    lines.push(`<dd>${escapeHtml(value)}</dd>`);
  }
  lines.push("</dl>");
  lines.push("</section>");
  return lines.join("\n");
}

/** Lejant: üç çözüm seviyesi, renk + çizgi biçimi metinsel açıklamayla. */
function legendSection(): string {
  const lines: string[] = [];
  lines.push("<section>");
  lines.push("<h2>Resolution levels</h2>");
  lines.push('<ul class="legend">');
  lines.push(
    '<li><span class="legend-swatch swatch-verified"></span>verified (resolved) — solid green arrow</li>',
  );
  lines.push(
    '<li><span class="legend-swatch swatch-heuristic"></span>heuristic — dashed amber arrow</li>',
  );
  lines.push(
    '<li><span class="legend-swatch swatch-unresolved"></span>unresolved — dotted grey arrow</li>',
  );
  lines.push("</ul>");
  lines.push("</section>");
  return lines.join("\n");
}

/** Wiki özet bölümü: üst veri dl + id-sıralı sayfa tablosu (opsiyonel). */
function wikiSection(view: OrderedViewerView): string {
  const wiki = view.wiki;
  if (wiki === undefined) return "";
  const lines: string[] = [];
  lines.push("<section>");
  lines.push("<h2>Wiki Snapshot</h2>");
  lines.push("<dl>");
  const pairs: readonly (readonly [string, string])[] = [
    ["id", wiki.id],
    ["graphSnapshotId", wiki.graphSnapshotId],
    ["status", wiki.status],
    ["revisionRef", wiki.revisionRef],
    ["templateVersion", wiki.templateVersion],
    ["pages", String(view.pages.length)],
  ];
  for (const [term, value] of pairs) {
    lines.push(`<dt>${escapeHtml(term)}</dt>`);
    lines.push(`<dd>${escapeHtml(value)}</dd>`);
  }
  lines.push("</dl>");
  lines.push("<table>");
  lines.push("<thead><tr><th>id</th><th>kind</th><th>title</th><th>route</th><th>coverage</th></tr></thead>");
  lines.push("<tbody>");
  for (const page of view.pages) {
    lines.push(
      `<tr><td>${escapeHtml(page.id)}</td><td>${escapeHtml(page.kind)}</td>` +
        `<td>${escapeHtml(page.title)}</td><td>${escapeHtml(page.route)}</td>` +
        `<td>${escapeHtml(page.coverageStatus)}</td></tr>`,
    );
  }
  lines.push("</tbody>");
  lines.push("</table>");
  lines.push("</section>");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Ana üretici                                                         */
/* ------------------------------------------------------------------ */

/**
 * Offline, self-contained viewer HTML'i üretir (SAF FONKSİYON).
 *
 * Determinizm sözleşmesi: aynı `ViewerInput` (dizi sırasından bağımsız)
 * her çağrıda bit-bit aynı dizgiyi üretir; saat/rastgelelik/fs yok.
 * Savunma: dangling kenar `viewer/dangling-edge` ile reddedilir.
 */
export function generateViewerHtml(input: ViewerInput): string {
  const view = orderedViewerView(input);
  const island = buildDataIsland(view);
  const islandJson = escapeJsonForScriptIsland(JSON.stringify(island));
  const isEmpty = view.nodes.length === 0;
  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="en">');
  lines.push("<head>");
  lines.push('<meta charset="utf-8">');
  lines.push(`<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP_POLICY}">`);
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push('<meta name="referrer" content="no-referrer">');
  lines.push("<title>Causoryn Architecture Viewer</title>");
  // Each block's text must equal its hashed constant byte for byte (CSP hash).
  lines.push(`<style>${VIEWER_CSS}</style>`);
  lines.push("</head>");
  lines.push("<body>");
  lines.push("<h1>Causoryn Architecture Viewer</h1>");
  lines.push(
    '<p class="viewer-note">Offline viewer — makes no network requests; all content is embedded in this single file.</p>',
  );
  lines.push(metaSection(view.meta));
  lines.push(legendSection());
  lines.push("<section>");
  lines.push(
    `<h2>Graph (${String(view.nodes.length)} node / ${String(view.edges.length)} edge)${isEmpty ? ' data-empty="true"' : ""}</h2>`,
  );
  if (isEmpty) {
    lines.push('<div class="graph-warning" data-empty="true">Empty graph — the snapshot contains no nodes or edges.</div>');
  }
  lines.push(svgBody(view));
  lines.push("</section>");
  const wikiHtml = wikiSection(view);
  if (wikiHtml.length > 0) lines.push(wikiHtml);
  lines.push('<aside id="evidence-panel" hidden>');
  lines.push(
    '<button id="evidence-panel-close" type="button">Kapat</button>',
  );
  lines.push('<h2 id="evidence-panel-title">Evidence</h2>');
  lines.push('<div id="evidence-panel-body"></div>');
  lines.push("</aside>");
  lines.push('<script id="causoryn-data" type="application/json">');
  lines.push(islandJson);
  lines.push("</script>");
  lines.push(`<script>${VIEWER_APP_JS}</script>`);
  lines.push(
    "<noscript><p>The evidence panel needs scripts enabled; no network requests are made.</p></noscript>",
  );
  lines.push("</body>");
  lines.push("</html>");
  return `${lines.join("\n")}\n`;
}
