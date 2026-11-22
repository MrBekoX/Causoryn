import type { Resolution } from "@causoryn/domain";

import type { ValidatedArchitectureAnnotations } from "./architecture-annotations.js";
import type {
  ArchitectureProjection,
  ProjectedModule,
  ProjectedModuleEdge,
} from "./architecture-projection.js";

/**
 * Saf, deterministik, sıfır-bağımlılıklı katmanlı SVG mimari yerleşim motoru.
 *
 * Sugiyama tarzı katmanlı düzen:
 * 1. Topolojik `layer` sıraları + maksimum satır genişliği (`MAX_PER_ROW = 5`)
 *    ile büyük repolarda bile okunabilir, aşırı yatay taşmayan kanvas.
 * 2. Her katmanda deterministik 2 geçişli barycenter kesişim azaltımı
 *    (eşitliklerde domain/group + moduleId bayt sırası).
 * 3. Kübik Bezier eğrileri + port dağıtımı + döngü kenarları (cycle) için
 *    ayrı kırmızı yay yönlendirmesi.
 * 4. Hem sıfır-JS portalda (`<a href="#...">`) hem etkileşimli portalda
 *    (`data-module-id`, `data-edge-id`, `data-evidence-ids`) ortak SVG iskeleti.
 */

export interface PositionedModuleNode {
  readonly module: ProjectedModule;
  readonly domainId: string;
  readonly domainName: string;
  readonly anchorId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly row: number;
  readonly col: number;
}

export interface PositionedModuleEdge {
  readonly edge: ProjectedModuleEdge;
  readonly pathD: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelText: string;
  readonly isBackEdge: boolean;
}

export interface LayoutBand {
  readonly index: number;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ArchitectureSvgLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PositionedModuleNode[];
  readonly edges: readonly PositionedModuleEdge[];
  readonly bands: readonly LayoutBand[];
}

const CANVAS_PAD_X = 48;
const CANVAS_PAD_Y = 36;
const CARD_W = 256;
const CARD_H = 92;
const COL_GAP = 36;
const ROW_GAP = 76;
const BAND_PAD_X = 20;
const BAND_PAD_TOP = 34;
const BAND_PAD_BOTTOM = 18;
const BAND_GAP_Y = 36;
const MAX_PER_ROW = 5;

const LANGUAGE_ACCENTS: Readonly<Record<string, string>> = {
  typescript: "#3b82f6",
  javascript: "#eab308",
  csharp: "#8b5cf6",
  python: "#10b981",
  go: "#06b6d4",
  rust: "#f97316",
  sql: "#ec4899",
  yaml: "#6366f1",
  json: "#64748b",
  unknown: "#64748b",
};

const RESOLUTION_STROKE: Readonly<Record<Resolution, string>> = {
  verified: "#10b981",
  heuristic: "#f59e0b",
  unresolved: "#64748b",
};

const CYCLE_STROKE = "#ef4444";

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Metin içindeki ham `http(s)://` dizgilerini HTML/SVG entity ile zararsızlaştırır. */
export function defangHttpUrls(escapedText: string): string {
  return escapedText.replace(/(https?):\/\//gi, "$1&#58;//");
}

function truncateText(text: string, maxLen: number): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`;
}

/** Deterministik, güvenli HTML fragment kimliği (`#mod-0`, `#mod-1`...). */
export function moduleAnchorId(index: number): string {
  return `mod-card-${String(index)}`;
}

function resolveDomainForModule(
  mod: ProjectedModule,
  annotations?: ValidatedArchitectureAnnotations,
): { readonly id: string; readonly name: string } {
  if (annotations !== undefined) {
    for (const dom of annotations.domains) {
      if (dom.moduleIds.includes(mod.id)) {
        return { id: dom.id, name: dom.name };
      }
    }
  }
  return { id: `grp:${mod.group}`, name: mod.group };
}

function bandTitleForLayer(layerIndex: number, totalLayers: number, mods: readonly ProjectedModule[]): string {
  if (mods.every((m) => m.isTest)) {
    return `Layer ${String(layerIndex)} — Verification & Tests`;
  }
  if (layerIndex === 0 && mods.some((m) => m.counts.endpoints > 0 || m.counts.handlers > 0)) {
    return `Layer ${String(layerIndex)} — Entrypoints, UI & Presentation`;
  }
  if (layerIndex === 0) {
    return `Layer ${String(layerIndex)} — Top-Level & Orchestration`;
  }
  if (layerIndex === totalLayers - 1 && totalLayers > 1) {
    return `Layer ${String(layerIndex)} — Core, Data & Shared Foundations`;
  }
  return `Layer ${String(layerIndex)} — Application & Services`;
}

export function computeArchitectureLayout(
  projection: ArchitectureProjection,
  annotations?: ValidatedArchitectureAnnotations,
): ArchitectureSvgLayout {
  if (projection.modules.length === 0) {
    return {
      width: 640,
      height: 180,
      nodes: [],
      edges: [],
      bands: [],
    };
  }

  const anchorByModId = new Map<string, string>();
  for (let i = 0; i < projection.modules.length; i++) {
    const m = projection.modules[i];
    if (m !== undefined) anchorByModId.set(m.id, moduleAnchorId(i));
  }

  const domainByModId = new Map<string, { readonly id: string; readonly name: string }>();
  for (const m of projection.modules) {
    domainByModId.set(m.id, resolveDomainForModule(m, annotations));
  }

  // Group modules by topological layer, placing isolated test-only modules in their own bottom band if other layers exist
  const layerMap = new Map<number, ProjectedModule[]>();
  let maxLayer = 0;
  for (const mod of projection.modules) {
    if (mod.layer > maxLayer) maxLayer = mod.layer;
  }
  const hasNonTest = projection.modules.some((m) => !m.isTest);

  for (const mod of projection.modules) {
    const targetLayer =
      hasNonTest && mod.isTest && mod.fanIn === 0 ? maxLayer + 1 : mod.layer;
    let list = layerMap.get(targetLayer);
    if (list === undefined) {
      list = [];
      layerMap.set(targetLayer, list);
    }
    list.push(mod);
  }

  const sortedLayerNums = [...layerMap.keys()].sort((a, b) => a - b);

  // Initial deterministic sort within each layer: domain/group -> primaryLanguage -> id
  for (const layerNum of sortedLayerNums) {
    const list = layerMap.get(layerNum);
    if (list === undefined) continue;
    list.sort((a, b) => {
      const da = domainByModId.get(a.id)?.name ?? a.group;
      const db = domainByModId.get(b.id)?.name ?? b.group;
      const dg = cmpStr(da, db);
      if (dg !== 0) return dg;
      const dl = cmpStr(a.primaryLanguage, b.primaryLanguage);
      if (dl !== 0) return dl;
      return cmpStr(a.id, b.id);
    });
  }

  // Adjacency for barycenter crossing reduction
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of projection.edges) {
    let p = parentsOf.get(edge.to);
    if (p === undefined) {
      p = [];
      parentsOf.set(edge.to, p);
    }
    p.push(edge.from);
    let c = childrenOf.get(edge.from);
    if (c === undefined) {
      c = [];
      childrenOf.set(edge.from, c);
    }
    c.push(edge.to);
  }

  // 2-pass barycenter sweep (downward then upward)
  const orderIndex = new Map<string, number>();
  const refreshOrder = (): void => {
    orderIndex.clear();
    for (const layerNum of sortedLayerNums) {
      const list = layerMap.get(layerNum) ?? [];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m !== undefined) orderIndex.set(m.id, i);
      }
    }
  };
  refreshOrder();

  const barycenterSort = (list: ProjectedModule[], neighborMap: ReadonlyMap<string, string[]>): void => {
    const scoreOf = new Map<string, number>();
    for (let i = 0; i < list.length; i++) {
      const mod = list[i];
      if (mod === undefined) continue;
      const nbrs = neighborMap.get(mod.id) ?? [];
      const indices: number[] = [];
      for (const nid of nbrs) {
        const idx = orderIndex.get(nid);
        if (idx !== undefined) indices.push(idx);
      }
      const avg =
        indices.length > 0
          ? indices.reduce((s, v) => s + v, 0) / indices.length
          : i;
      scoreOf.set(mod.id, avg);
    }
    list.sort((a, b) => {
      const sa = scoreOf.get(a.id) ?? 0;
      const sb = scoreOf.get(b.id) ?? 0;
      if (Math.abs(sa - sb) > 1e-6) return sa - sb;
      const da = domainByModId.get(a.id)?.name ?? a.group;
      const db = domainByModId.get(b.id)?.name ?? b.group;
      const dg = cmpStr(da, db);
      return dg !== 0 ? dg : cmpStr(a.id, b.id);
    });
  };

  for (let i = 1; i < sortedLayerNums.length; i++) {
    const ln = sortedLayerNums[i];
    if (ln === undefined) continue;
    const list = layerMap.get(ln);
    if (list !== undefined) barycenterSort(list, parentsOf);
    refreshOrder();
  }
  for (let i = sortedLayerNums.length - 2; i >= 0; i--) {
    const ln = sortedLayerNums[i];
    if (ln === undefined) continue;
    const list = layerMap.get(ln);
    if (list !== undefined) barycenterSort(list, childrenOf);
    refreshOrder();
  }

  // Compute max columns across all wrapped rows to center bands cleanly
  let maxCols = 1;
  for (const ln of sortedLayerNums) {
    const list = layerMap.get(ln) ?? [];
    maxCols = Math.max(maxCols, Math.min(list.length, MAX_PER_ROW));
  }
  const innerBandWidth = maxCols * CARD_W + (maxCols - 1) * COL_GAP;
  const bandWidth = innerBandWidth + BAND_PAD_X * 2;

  const positionedNodes: PositionedModuleNode[] = [];
  const nodePosById = new Map<string, PositionedModuleNode>();
  const bands: LayoutBand[] = [];

  let cursorY = CANVAS_PAD_Y;
  let globalRow = 0;

  for (let bIdx = 0; bIdx < sortedLayerNums.length; bIdx++) {
    const ln = sortedLayerNums[bIdx];
    if (ln === undefined) continue;
    const list = layerMap.get(ln) ?? [];
    if (list.length === 0) continue;

    const subRows = Math.ceil(list.length / MAX_PER_ROW);
    const bandHeight =
      BAND_PAD_TOP +
      subRows * CARD_H +
      Math.max(0, subRows - 1) * ROW_GAP +
      BAND_PAD_BOTTOM;

    bands.push({
      index: bIdx,
      title: bandTitleForLayer(bIdx, sortedLayerNums.length, list),
      x: CANVAS_PAD_X,
      y: cursorY,
      width: bandWidth,
      height: bandHeight,
    });

    for (let r = 0; r < subRows; r++) {
      const slice = list.slice(r * MAX_PER_ROW, (r + 1) * MAX_PER_ROW);
      const rowWidth = slice.length * CARD_W + (slice.length - 1) * COL_GAP;
      const startX = CANVAS_PAD_X + BAND_PAD_X + Math.floor((innerBandWidth - rowWidth) / 2);
      const y = cursorY + BAND_PAD_TOP + r * (CARD_H + ROW_GAP);

      for (let c = 0; c < slice.length; c++) {
        const mod = slice[c];
        if (mod === undefined) continue;
        const dom = domainByModId.get(mod.id) ?? { id: `grp:${mod.group}`, name: mod.group };
        const pos: PositionedModuleNode = {
          module: mod,
          domainId: dom.id,
          domainName: dom.name,
          anchorId: anchorByModId.get(mod.id) ?? moduleAnchorId(positionedNodes.length),
          x: startX + c * (CARD_W + COL_GAP),
          y,
          width: CARD_W,
          height: CARD_H,
          row: globalRow,
          col: c,
        };
        positionedNodes.push(pos);
        nodePosById.set(mod.id, pos);
      }
      globalRow += 1;
    }

    cursorY += bandHeight + BAND_GAP_Y;
  }

  const totalHeight = Math.max(220, cursorY - BAND_GAP_Y + CANVAS_PAD_Y);
  let hasAnyUpwardEdge = false;
  for (const edge of projection.edges) {
    const src = nodePosById.get(edge.from);
    const dst = nodePosById.get(edge.to);
    if (src !== undefined && dst !== undefined && dst.y < src.y) {
      hasAnyUpwardEdge = true;
      break;
    }
  }
  const rightGutter = hasAnyUpwardEdge ? 92 : 0;
  const totalWidth = CANVAS_PAD_X * 2 + bandWidth + rightGutter;

  // Port spreading for edges leaving / entering each node
  const outEdgesByNode = new Map<string, ProjectedModuleEdge[]>();
  const inEdgesByNode = new Map<string, ProjectedModuleEdge[]>();
  for (const edge of projection.edges) {
    let outs = outEdgesByNode.get(edge.from);
    if (outs === undefined) {
      outs = [];
      outEdgesByNode.set(edge.from, outs);
    }
    outs.push(edge);
    let ins = inEdgesByNode.get(edge.to);
    if (ins === undefined) {
      ins = [];
      inEdgesByNode.set(edge.to, ins);
    }
    ins.push(edge);
  }
  for (const list of outEdgesByNode.values()) {
    list.sort((a, b) => {
      const xa = nodePosById.get(a.to)?.x ?? 0;
      const xb = nodePosById.get(b.to)?.x ?? 0;
      return xa !== xb ? xa - xb : cmpStr(a.id, b.id);
    });
  }
  for (const list of inEdgesByNode.values()) {
    list.sort((a, b) => {
      const xa = nodePosById.get(a.from)?.x ?? 0;
      const xb = nodePosById.get(b.from)?.x ?? 0;
      return xa !== xb ? xa - xb : cmpStr(a.id, b.id);
    });
  }

  const portOffset = (index: number, count: number, span: number): number => {
    if (count <= 1) return span / 2;
    const pad = Math.min(28, span * 0.16);
    const usable = span - pad * 2;
    return pad + (usable * index) / (count - 1);
  };

  let backEdgeSlot = 0;
  const positionedEdges: PositionedModuleEdge[] = [];

  for (const edge of projection.edges) {
    const src = nodePosById.get(edge.from);
    const dst = nodePosById.get(edge.to);
    if (src === undefined || dst === undefined) continue;

    const outs = outEdgesByNode.get(edge.from) ?? [edge];
    const ins = inEdgesByNode.get(edge.to) ?? [edge];
    const outIdx = Math.max(0, outs.indexOf(edge));
    const inIdx = Math.max(0, ins.indexOf(edge));

    const isBackEdge = dst.y < src.y || (dst.y === src.y && edge.isCycle && dst.x < src.x);
    let pathD: string;
    let labelX: number;
    let labelY: number;

    if (dst.y > src.y) {
      // Standard downward layered Bezier
      const x1 = Math.round(src.x + portOffset(outIdx, outs.length, src.width));
      const y1 = src.y + src.height;
      const x2 = Math.round(dst.x + portOffset(inIdx, ins.length, dst.width));
      const y2 = dst.y;
      const dy = Math.max(36, Math.round((y2 - y1) * 0.48));
      pathD = `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(y1 + dy)}, ${String(x2)} ${String(y2 - dy)}, ${String(x2)} ${String(y2)}`;
      labelX = Math.round((x1 + x2) / 2);
      labelY = Math.round((y1 + y2) / 2);
    } else if (dst.y === src.y) {
      // Same-row arc above or below cards
      const goingRight = dst.x >= src.x;
      const x1 = goingRight ? src.x + src.width : src.x;
      const y1 = src.y + Math.round(src.height * (edge.isCycle ? 0.68 : 0.35));
      const x2 = goingRight ? dst.x : dst.x + dst.width;
      const y2 = dst.y + Math.round(dst.height * (edge.isCycle ? 0.68 : 0.35));
      const arch = edge.isCycle ? 34 : -28;
      const midX = Math.round((x1 + x2) / 2);
      const ctrlY = Math.round(y1 + arch);
      pathD = `M ${String(x1)} ${String(y1)} Q ${String(midX)} ${String(ctrlY)}, ${String(x2)} ${String(y2)}`;
      labelX = midX;
      labelY = Math.round((y1 + ctrlY) / 2);
    } else {
      // Upward / back-edge (cycle): clean curved arc on the right gutter
      backEdgeSlot += 1;
      const x1 = src.x + src.width;
      const y1 = src.y + Math.round(src.height * 0.5);
      const x2 = dst.x + dst.width;
      const y2 = dst.y + Math.round(dst.height * 0.5);
      const gutterX = CANVAS_PAD_X + bandWidth + 18 + ((backEdgeSlot - 1) % 4) * 14;
      pathD = `M ${String(x1)} ${String(y1)} C ${String(gutterX)} ${String(y1)}, ${String(gutterX)} ${String(y2)}, ${String(x2)} ${String(y2)}`;
      labelX = gutterX - 8;
      labelY = Math.round((y1 + y2) / 2);
    }

    const topKind = edge.kinds[0]?.kind ?? "DEPENDS_ON";
    const labelText = edge.weight > 1 ? `×${String(edge.weight)}` : topKind;

    positionedEdges.push({
      edge,
      pathD,
      labelX,
      labelY,
      labelText,
      isBackEdge,
    });
  }

  return {
    width: totalWidth,
    height: totalHeight,
    nodes: positionedNodes,
    edges: positionedEdges,
    bands,
  };
}

export interface RenderArchitectureSvgOptions {
  readonly interactive: boolean;
  readonly annotations?: ValidatedArchitectureAnnotations;
}

export function renderArchitectureSvg(
  projection: ArchitectureProjection,
  layout: ArchitectureSvgLayout,
  options: RenderArchitectureSvgOptions,
): string {
  const safeText = (raw: string): string =>
    options.interactive ? escapeSvgText(raw) : defangHttpUrls(escapeSvgText(raw));

  const noteByModId = new Map<string, string>();
  if (options.annotations !== undefined) {
    for (const note of options.annotations.moduleNotes) {
      noteByModId.set(note.moduleId, note.responsibility ?? note.summary);
    }
  }

  const parts: string[] = [];
  parts.push(
    `<svg id="causoryn-arch-svg" class="arch-svg" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}"` +
      ` width="${String(layout.width)}" height="${String(layout.height)}" role="img" aria-label="Causoryn Architecture Map">`,
  );

  // Arrow markers
  parts.push("<defs>");
  for (const res of ["verified", "heuristic", "unresolved"] as const) {
    parts.push(
      `<marker id="arr-${res}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
        `<path d="M 0 0 L 10 5 L 0 10 z" fill="${RESOLUTION_STROKE[res]}"></path></marker>`,
    );
  }
  parts.push(
    `<marker id="arr-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="${CYCLE_STROKE}"></path></marker>`,
  );
  parts.push("</defs>");

  if (layout.nodes.length === 0) {
    parts.push(
      `<text x="${String(Math.round(layout.width / 2))}" y="95" text-anchor="middle" class="svg-empty">No internal modules in current snapshot/scope.</text>`,
    );
    parts.push("</svg>");
    return parts.join("\n");
  }

  // Layer swimlane bands
  parts.push('<g class="arch-bands">');
  for (const band of layout.bands) {
    parts.push(
      `<g class="arch-band" data-band="${String(band.index)}">` +
        `<rect x="${String(band.x)}" y="${String(band.y)}" width="${String(band.width)}" height="${String(band.height)}" rx="14" class="band-rect"></rect>` +
        `<text x="${String(band.x + 16)}" y="${String(band.y + 22)}" class="band-title">${safeText(band.title)}</text>` +
        `</g>`,
    );
  }
  parts.push("</g>");

  // Edges (drawn below cards)
  const modLabelById = new Map(projection.modules.map((m) => [m.id, m.label]));
  parts.push('<g class="arch-edges">');
  for (const pe of layout.edges) {
    const e = pe.edge;
    const stroke = e.isCycle ? CYCLE_STROKE : RESOLUTION_STROKE[e.resolution];
    const dash = e.isCycle
      ? ' stroke-dasharray="6 4"'
      : e.resolution === "heuristic"
        ? ' stroke-dasharray="7 4"'
        : e.resolution === "unresolved"
          ? ' stroke-dasharray="2 4"'
          : "";
    const marker = e.isCycle ? "arr-cycle" : `arr-${e.resolution}`;
    const strokeWidth = e.weight >= 20 ? "2.6" : e.weight >= 5 ? "2.0" : "1.5";
    const kindsText = e.kinds.map((k) => `${k.kind}:${String(k.count)}`).join(", ");
    const resText = `${String(e.resolutionCounts.verified)}v/${String(e.resolutionCounts.heuristic)}h/${String(e.resolutionCounts.unresolved)}u`;
    const tooltip = `${modLabelById.get(e.from) ?? e.from} → ${modLabelById.get(e.to) ?? e.to} (${String(e.weight)} edges: ${kindsText}; ${resText}${e.isCycle ? "; CYCLE" : ""})`;
    const classes = `arch-edge res-${e.resolution}${e.isCycle ? " edge-cycle" : ""}`;

    parts.push(
      `<g class="${classes}" data-edge-id="${safeText(e.id)}" data-from="${safeText(e.from)}" data-to="${safeText(e.to)}" data-resolution="${e.resolution}" data-cycle="${e.isCycle ? "true" : "false"}" data-evidence-ids="${safeText(e.evidenceIds.join(","))}" tabindex="0" role="button" aria-label="${safeText(tooltip)}">` +
        `<title>${safeText(tooltip)}</title>` +
        `<path class="edge-hit" d="${pe.pathD}" fill="none"></path>` +
        `<path class="edge-path" d="${pe.pathD}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dash} marker-end="url(#${marker})"></path>` +
        `<rect class="edge-pill" x="${String(pe.labelX - 18)}" y="${String(pe.labelY - 10)}" width="36" height="18" rx="9"></rect>` +
        `<text class="edge-label" x="${String(pe.labelX)}" y="${String(pe.labelY + 3)}" text-anchor="middle">${safeText(truncateText(pe.labelText, 8))}</text>` +
        `</g>`,
    );
  }
  parts.push("</g>");

  // Module cards
  const cycleModSet = new Set(projection.cycles.flatMap((c) => c.moduleIds));
  parts.push('<g class="arch-nodes">');
  for (const pn of layout.nodes) {
    const m = pn.module;
    const accent = Object.hasOwn(LANGUAGE_ACCENTS, m.primaryLanguage)
      ? (LANGUAGE_ACCENTS[m.primaryLanguage] ?? "#64748b")
      : "#64748b";
    const isCycle = cycleModSet.has(m.id);
    const hasNote = noteByModId.has(m.id);
    const titleStr = truncateText(m.label, 28);
    const subParts: string[] = [
      `${String(m.counts.files)}f`,
      `${String(m.counts.totalSymbols)}sym`,
    ];
    if (m.counts.endpoints > 0) subParts.push(`${String(m.counts.endpoints)}ep`);
    subParts.push(m.primaryLanguage);
    const metaLine = subParts.join(" · ");
    const extraLine = truncateText(
      noteByModId.get(m.id) ?? `${pn.domainName} · in:${String(m.fanIn)} out:${String(m.fanOut)}`,
      34,
    );
    const tooltip = `${m.label} (${m.path}) — ${String(m.counts.files)} files, ${String(m.counts.totalSymbols)} symbols, ${String(m.counts.endpoints)} endpoints, fanIn=${String(m.fanIn)}, fanOut=${String(m.fanOut)}${isCycle ? " [CYCLE]" : ""}`;

    const badgeText = isCycle ? "CYCLE" : m.isTest ? "TEST" : hasNote ? "NOTES" : "";
    const badgeColor = isCycle ? CYCLE_STROKE : m.isTest ? "#64748b" : "#3b82f6";

    const cardInner =
      `<title>${safeText(tooltip)}</title>` +
      `<rect class="node-card" x="${String(pn.x)}" y="${String(pn.y)}" width="${String(pn.width)}" height="${String(pn.height)}" rx="10"></rect>` +
      `<rect x="${String(pn.x)}" y="${String(pn.y)}" width="${String(pn.width)}" height="5" rx="3" fill="${accent}"></rect>` +
      `<text class="node-title" x="${String(pn.x + 12)}" y="${String(pn.y + 28)}">${safeText(titleStr)}</text>` +
      `<text class="node-meta" x="${String(pn.x + 12)}" y="${String(pn.y + 49)}">${safeText(metaLine)}</text>` +
      `<text class="node-sub" x="${String(pn.x + 12)}" y="${String(pn.y + 70)}">${safeText(extraLine)}</text>` +
      (badgeText.length > 0
        ? `<rect x="${String(pn.x + pn.width - 54)}" y="${String(pn.y + 12)}" width="44" height="16" rx="8" fill="${badgeColor}" opacity="0.18"></rect>` +
          `<text class="node-badge" x="${String(pn.x + pn.width - 32)}" y="${String(pn.y + 23)}" text-anchor="middle" fill="${badgeColor}">${badgeText}</text>`
        : "");

    const gOpen =
      `<g class="arch-node${isCycle ? " node-cycle" : ""}${m.isTest ? " node-test" : ""}"` +
      ` data-module-id="${safeText(m.id)}" data-group="${safeText(pn.domainName)}"` +
      ` data-language="${safeText(m.primaryLanguage)}" data-layer="${String(m.layer)}"` +
      ` data-test="${m.isTest ? "true" : "false"}" data-cycle="${isCycle ? "true" : "false"}"` +
      ` data-evidence-ids="${safeText(m.evidenceIds.join(","))}" tabindex="0" role="button"` +
      ` aria-label="${safeText(tooltip)}">`;

    if (options.interactive) {
      parts.push(`${gOpen}${cardInner}</g>`);
    } else {
      parts.push(`${gOpen}<a href="#${pn.anchorId}" class="svg-node-link">${cardInner}</a></g>`);
    }
  }
  parts.push("</g>");
  parts.push("</svg>");
  return parts.join("\n");
}

export interface FlowStripStep {
  readonly label: string;
  readonly sublabel: string;
}

/** Kritik akış veya Host-LLM iş akışı için kompakt yatay inline SVG akış şeridi. */
export function renderFlowStripSvg(
  steps: readonly FlowStripStep[],
  interactive: boolean,
): string {
  if (steps.length === 0) return "";
  const safeText = (raw: string): string =>
    interactive ? escapeSvgText(raw) : defangHttpUrls(escapeSvgText(raw));

  const boxW = 186;
  const boxH = 56;
  const gap = 36;
  const pad = 12;
  const width = pad * 2 + steps.length * boxW + Math.max(0, steps.length - 1) * gap;
  const height = pad * 2 + boxH;

  const out: string[] = [
    `<svg class="flow-svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" aria-label="Execution Flow">`,
  ];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const x = pad + i * (boxW + gap);
    const y = pad;
    out.push(
      `<g class="flow-step">` +
        `<rect class="flow-box" x="${String(x)}" y="${String(y)}" width="${String(boxW)}" height="${String(boxH)}" rx="8"></rect>` +
        `<text class="flow-step-title" x="${String(x + 10)}" y="${String(y + 23)}">${safeText(truncateText(step.label, 22))}</text>` +
        `<text class="flow-step-sub" x="${String(x + 10)}" y="${String(y + 42)}">${safeText(truncateText(step.sublabel, 26))}</text>` +
        `</g>`,
    );
    if (i < steps.length - 1) {
      const x1 = x + boxW;
      const x2 = x + boxW + gap - 4;
      const ym = y + Math.round(boxH / 2);
      out.push(
        `<line class="flow-arrow" x1="${String(x1)}" y1="${String(ym)}" x2="${String(x2)}" y2="${String(ym)}"></line>` +
          `<polygon class="flow-arrow-head" points="${String(x2)},${String(ym - 5)} ${String(x2 + 6)},${String(ym)} ${String(x2)},${String(ym + 5)}"></polygon>`,
      );
    }
  }
  out.push("</svg>");
  return out.join("");
}
