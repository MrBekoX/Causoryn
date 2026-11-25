import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  escapeMarkdownBlock,
  escapeMarkdownInline,
  escapeMarkdownTableCell,
  escapeMermaidLabel,
  markdownCodeSpan,
  type SnapshotGraph,
} from "@causoryn/domain";

import {
  validateArchitectureAnnotations,
  type ArchitectureAnnotations,
  type ValidatedArchitectureAnnotations,
} from "./architecture-annotations.js";
import {
  computeArchitectureLayout,
  defangHttpUrls,
  escapeSvgText,
  moduleAnchorId,
  renderArchitectureSvg,
  renderFlowStripSvg,
} from "./architecture-layout.js";
import {
  projectArchitecture,
  type ArchitectureProjection,
  type ArchitectureProjectionOptions,
  type ProjectedEvidenceRecord,
  type ProjectedModule,
  type ProjectedModuleEdge,
} from "./architecture-projection.js";

/**
 * Mimari görünüm serializer'ları (Yaklaşım B — v0.2.2):
 * - `view: "architecture"` (varsayılan MCP görünümü):
 *   - `mermaid`: temiz, subgraph gruplu, render edilebilir `flowchart TB`
 *   - `html`: sıfır-JS, katı offline CSP (`default-src 'none'`), katmanlı SVG,
 *     CSS sekmeli/zoomlu, Host-LLM anotasyonlu + tıklanabilir kanıtlı mimari portalı
 *   - `markdown`: gömülü Mermaid + modül/katman/akış/kontrat/risk özeti
 *   - `json`: kompakt kanonik mimari blueprint (`meta.id` korunur)
 * - `view: "interactive"` (yalnızca `format: "html"`):
 *   - E6 etkileşimli offline mimari portalı: pan/zoom, anlık arama/filtre,
 *     sağ Inspector Drawer + 1-hop komşuluk vurgusu + kanıt paneli + Mermaid kopyalama
 *     (`VIEWER_CSP_POLICY`, sıfır `innerHTML`, sıfır `fetch`/CDN).
 * - `view: "full"`: `export.ts`'teki ham snapshot serializer'larına yönlenir.
 */

export const EXPORT_DOCUMENTATION_VIEWS = [
  "architecture",
  "interactive",
  "full",
] as const;

export type ExportDocumentationView = (typeof EXPORT_DOCUMENTATION_VIEWS)[number];
export const exportDocumentationViewSchema = z.enum(EXPORT_DOCUMENTATION_VIEWS);

export const ARCHITECTURE_ZERO_JS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

interface PreparedArchitecture {
  readonly projection: ArchitectureProjection;
  readonly annotations?: ValidatedArchitectureAnnotations;
  readonly evidenceCatalog: Readonly<Record<string, ProjectedEvidenceRecord>>;
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeHtml(value: string): string {
  return escapeSvgText(value).replace(/\|/g, "&#124;");
}

function safeHtmlText(value: string, interactive: boolean): string {
  const escaped = escapeHtml(value);
  return interactive ? escaped : defangHttpUrls(escaped);
}

function escapeJsonForScriptIsland(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Multi-line annotation prose (executive summary, descriptions). Markdown and
 * Mermaid escaping is shared through @causoryn/domain (markup-escape.ts): one
 * helper per output context, so repository- and host-supplied text renders as
 * literal text in every serializer.
 */
function escapeMarkdownProse(value: string): string {
  return escapeMarkdownBlock(value).trim();
}

export function prepareArchitecture(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  rawAnnotations?: ArchitectureAnnotations,
): PreparedArchitecture {
  const projection = projectArchitecture(snapshot, options);
  const annotations =
    rawAnnotations === undefined
      ? undefined
      : validateArchitectureAnnotations(rawAnnotations, projection, snapshot);

  // Merge any additional evidence referenced by annotations.decisions / annotations.risks
  const extraIds = new Set<string>();
  if (annotations !== undefined) {
    for (const d of annotations.decisions) {
      for (const eid of d.evidenceIds ?? []) extraIds.add(eid);
    }
    for (const r of annotations.risks) {
      for (const eid of r.evidenceIds ?? []) extraIds.add(eid);
    }
  }
  const mergedEvidence: Record<string, ProjectedEvidenceRecord> = Object.assign(
    Object.create(null) as Record<string, ProjectedEvidenceRecord>,
    projection.evidenceCatalog,
  );
  if (extraIds.size > 0) {
    const byId = new Map(snapshot.evidence.map((e) => [e.id, e]));
    for (const eid of [...extraIds].sort(cmpStr)) {
      if (Object.hasOwn(mergedEvidence, eid)) continue;
      const ev = byId.get(eid);
      if (ev === undefined) continue;
      mergedEvidence[eid] = {
        id: ev.id,
        kind: ev.kind,
        analyzerId: ev.analyzerId,
        analyzerVersion: ev.analyzerVersion,
        rationale: ev.rationale,
        ...(ev.span === undefined
          ? {}
          : {
              span: {
                relativePath: ev.span.relativePath.replace(/\\/g, "/"),
                startLine: ev.span.startLine,
                endLine: ev.span.endLine,
              },
            }),
      };
    }
  }

  return {
    projection,
    ...(annotations === undefined ? {} : { annotations }),
    evidenceCatalog: mergedEvidence,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Clean Renderable Mermaid Serializer                              */
/* ------------------------------------------------------------------ */

function mermaidClassForModule(mod: ProjectedModule, cycleModIds: ReadonlySet<string>): string {
  if (cycleModIds.has(mod.id)) return "cycleMod";
  if (mod.isTest) return "testMod";
  if (mod.primaryLanguage === "typescript" || mod.primaryLanguage === "javascript") return "tsMod";
  if (mod.primaryLanguage === "csharp") return "csMod";
  if (mod.primaryLanguage === "python") return "pyMod";
  if (mod.primaryLanguage === "go") return "goMod";
  if (mod.primaryLanguage === "rust") return "rsMod";
  return "otherMod";
}

export function renderArchitectureMermaidFromPrepared(prepared: PreparedArchitecture): string {
  const { projection, annotations } = prepared;
  const lines: string[] = ["flowchart TB"];

  if (projection.modules.length === 0) {
    return "flowchart TB\n";
  }

  const mmdIdByModId = new Map<string, string>();
  for (let i = 0; i < projection.modules.length; i++) {
    const m = projection.modules[i];
    if (m !== undefined) mmdIdByModId.set(m.id, `m${String(i)}`);
  }

  // Group modules by Host-LLM domains first, then auto-inferred container group
  const groupBuckets = new Map<string, { readonly title: string; readonly mods: ProjectedModule[] }>();
  const claimed = new Set<string>();
  const modById = new Map(projection.modules.map((m) => [m.id, m]));

  if (annotations !== undefined) {
    for (const dom of annotations.domains) {
      const mods: ProjectedModule[] = [];
      for (const mid of dom.moduleIds) {
        const m = modById.get(mid);
        if (m !== undefined) {
          mods.push(m);
          claimed.add(mid);
        }
      }
      if (mods.length > 0) {
        groupBuckets.set(`dom:${dom.id}`, { title: dom.name, mods });
      }
    }
  }

  for (const m of projection.modules) {
    if (claimed.has(m.id)) continue;
    const key = `grp:${m.group}`;
    let bucket = groupBuckets.get(key);
    if (bucket === undefined) {
      bucket = { title: m.group, mods: [] };
      groupBuckets.set(key, bucket);
    }
    bucket.mods.push(m);
  }

  const cycleModIds = new Set(projection.cycles.flatMap((c) => c.moduleIds));
  const sortedGroupKeys = [...groupBuckets.keys()].sort(cmpStr);
  let sgIndex = 0;

  for (const gKey of sortedGroupKeys) {
    const bucket = groupBuckets.get(gKey);
    if (bucket === undefined || bucket.mods.length === 0) continue;
    const sgId = `sg${String(sgIndex)}`;
    sgIndex += 1;
    lines.push(`  subgraph ${sgId}["${escapeMermaidLabel(bucket.title, 48)}"]`);
    for (const mod of bucket.mods) {
      const mmdId = mmdIdByModId.get(mod.id) ?? "m0";
      const stats = [
        `${String(mod.counts.files)}f`,
        `${String(mod.counts.totalSymbols)}sym`,
        ...(mod.counts.endpoints > 0 ? [`${String(mod.counts.endpoints)}ep`] : []),
        mod.primaryLanguage,
      ].join(" · ");
      const cls = mermaidClassForModule(mod, cycleModIds);
      lines.push(
        `    ${mmdId}["${escapeMermaidLabel(mod.label, 40)}<br/>${escapeMermaidLabel(stats, 40)}"]:::${cls}`,
      );
    }
    lines.push("  end");
  }

  const cycleEdgeIndices: number[] = [];
  let emittedEdgeIdx = 0;
  for (const edge of projection.edges) {
    const fromId = mmdIdByModId.get(edge.from);
    const toId = mmdIdByModId.get(edge.to);
    if (fromId === undefined || toId === undefined) continue;
    const topKind = edge.kinds[0]?.kind ?? "DEPENDS_ON";
    const arrow = edge.resolution === "verified" && !edge.isCycle ? "-->" : "-.->";
    const suffix = edge.isCycle ? " CYCLE" : edge.resolution === "verified" ? "" : ` ${edge.resolution}`;
    const label = `${topKind} ×${String(edge.weight)}${suffix}`;
    lines.push(`  ${fromId} ${arrow}|"${escapeMermaidLabel(label, 36)}"| ${toId}`);
    if (edge.isCycle) cycleEdgeIndices.push(emittedEdgeIdx);
    emittedEdgeIdx += 1;
  }

  lines.push("  classDef tsMod fill:#eff6ff,stroke:#3b82f6,stroke-width:1.5px,color:#1e3a8a");
  lines.push("  classDef csMod fill:#f5f3ff,stroke:#8b5cf6,stroke-width:1.5px,color:#4c1d95");
  lines.push("  classDef pyMod fill:#ecfdf5,stroke:#10b981,stroke-width:1.5px,color:#065f46");
  lines.push("  classDef goMod fill:#ecfeff,stroke:#06b6d4,stroke-width:1.5px,color:#164e63");
  lines.push("  classDef rsMod fill:#fff7ed,stroke:#f97316,stroke-width:1.5px,color:#7c2d12");
  lines.push("  classDef testMod fill:#f8fafc,stroke:#94a3b8,stroke-dasharray:4 3,color:#334155");
  lines.push("  classDef cycleMod fill:#fef2f2,stroke:#ef4444,stroke-width:2px,color:#991b1b");
  lines.push("  classDef otherMod fill:#f8fafc,stroke:#64748b,stroke-width:1.5px,color:#1e293b");

  for (const idx of cycleEdgeIndices) {
    lines.push(`  linkStyle ${String(idx)} stroke:#ef4444,stroke-width:2px,stroke-dasharray:5 3`);
  }

  return `${lines.join("\n")}\n`;
}

export function serializeArchitectureMermaid(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  annotations?: ArchitectureAnnotations,
): string {
  return renderArchitectureMermaidFromPrepared(prepareArchitecture(snapshot, options, annotations));
}

/* ------------------------------------------------------------------ */
/* 2. Architecture Blueprint JSON Serializer                           */
/* ------------------------------------------------------------------ */

export function serializeArchitectureJsonFromPrepared(prepared: PreparedArchitecture): string {
  const { projection, annotations, evidenceCatalog } = prepared;
  const payload = {
    meta: projection.meta,
    view: "architecture" as const,
    summary: projection.summary,
    modules: projection.modules,
    edges: projection.edges,
    cycles: projection.cycles,
    entrypoints: projection.entrypoints,
    contracts: projection.contracts,
    flows: projection.deterministicFlows,
    externalSummary: projection.externalSummary,
    riskHotspots: projection.riskHotspots,
    evidence: evidenceCatalog,
    ...(annotations === undefined ? {} : { annotations }),
  };
  return canonicalJson(payload as never);
}

export function serializeArchitectureJson(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  annotations?: ArchitectureAnnotations,
): string {
  return serializeArchitectureJsonFromPrepared(prepareArchitecture(snapshot, options, annotations));
}

/* ------------------------------------------------------------------ */
/* 3. Architecture Brief Markdown Serializer                           */
/* ------------------------------------------------------------------ */

export function serializeArchitectureMarkdownFromPrepared(prepared: PreparedArchitecture): string {
  const { projection, annotations } = prepared;
  const mermaid = renderArchitectureMermaidFromPrepared(prepared).trimEnd();
  const noteByModId = new Map(
    (annotations?.moduleNotes ?? []).map((n) => [n.moduleId, n]),
  );

  const lines: string[] = [];
  lines.push("# Causoryn Architecture Documentation");
  lines.push("");

  if (annotations?.title !== undefined) {
    lines.push(`> **${escapeMarkdownInline(annotations.title)}**`);
    lines.push("");
  }
  if (annotations?.architectureStyle !== undefined) {
    lines.push(`- **Architecture Style:** ${escapeMarkdownInline(annotations.architectureStyle)}`);
  }
  if (annotations?.executiveSummary !== undefined) {
    lines.push("");
    lines.push("## Executive Summary");
    lines.push("");
    lines.push(escapeMarkdownProse(annotations.executiveSummary));
  }

  lines.push("");
  lines.push("## Snapshot & Coverage");
  lines.push("");
  lines.push(`- id: ${escapeMarkdownInline(projection.meta.id)}`);
  lines.push(`- workspaceId: ${escapeMarkdownInline(projection.meta.workspaceId)}`);
  lines.push(
    `- revision: ${escapeMarkdownInline(projection.meta.revision.id)} (sequence ${String(projection.meta.revision.sequence)})`,
  );
  lines.push(`- state: ${escapeMarkdownInline(projection.meta.state)}`);
  lines.push(`- createdAt: ${escapeMarkdownInline(projection.meta.createdAt)}`);
  lines.push(
    `- analyzed: ${String(projection.summary.analyzedFiles)} files · ${String(projection.summary.moduleCount)} modules · ${String(projection.summary.moduleEdgeCount)} module links · ${String(projection.summary.cycleCount)} circular dependencies · ${String(projection.summary.entrypointCount)} entrypoints`,
  );
  lines.push(
    `- raw graph: ${String(projection.summary.totalRawNodes)} nodes · ${String(projection.summary.totalRawEdges)} edges (${String(projection.summary.resolutionCounts.verified)} verified, ${String(projection.summary.resolutionCounts.heuristic)} heuristic, ${String(projection.summary.resolutionCounts.unresolved)} unresolved) · ${String(projection.externalSummary.nodeCount)} external references excluded from map`,
  );

  if (projection.summary.languages.length > 0) {
    lines.push(
      `- languages: ${projection.summary.languages.map((l) => `${escapeMarkdownInline(l.language)} (${String(l.fileCount)} files)`).join(", ")}`,
    );
  }

  lines.push("");
  lines.push("## Architecture Diagram");
  lines.push("");
  lines.push("```mermaid");
  lines.push(mermaid);
  lines.push("```");
  lines.push("");

  if (annotations !== undefined && annotations.domains.length > 0) {
    lines.push("## Domains & Subsystems");
    lines.push("");
    for (const dom of annotations.domains) {
      lines.push(
        `### ${escapeMarkdownInline(dom.name)}${dom.layer === undefined ? "" : ` (${escapeMarkdownInline(dom.layer)})`}`,
      );
      lines.push("");
      lines.push(escapeMarkdownProse(dom.description));
      lines.push("");
      lines.push(`- Modules: ${dom.moduleIds.map((id) => markdownCodeSpan(id)).join(", ")}`);
      lines.push("");
    }
  }

  lines.push(`## Modules (${String(projection.modules.length)})`);
  lines.push("");
  lines.push("| Module | Group | Layer | Lang | Files | Symbols | Fan-In/Out | Summary / Key Symbols |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const m of projection.modules) {
    const note = noteByModId.get(m.id);
    const keySyms = m.keySymbols.slice(0, 4).map((s) => s.qualifiedName).join(", ");
    const desc =
      note !== undefined
        ? `${note.summary}${keySyms.length > 0 ? ` — Key: ${keySyms}` : ""}`
        : keySyms.length > 0
          ? keySyms
          : m.path;
    lines.push(
      `| ${escapeMarkdownTableCell(m.label)} | ${escapeMarkdownTableCell(m.group)} | L${String(m.layer)} | ${escapeMarkdownTableCell(m.primaryLanguage)} | ${String(m.counts.files)} | ${String(m.counts.totalSymbols)} | ${String(m.fanIn)}/${String(m.fanOut)} | ${escapeMarkdownTableCell(desc)} |`,
    );
  }
  lines.push("");

  if (annotations !== undefined && annotations.flows.length > 0) {
    lines.push(`## Guided Flows (${String(annotations.flows.length)})`);
    lines.push("");
    for (const flow of annotations.flows) {
      lines.push(`### ${escapeMarkdownInline(flow.title)}`);
      lines.push("");
      lines.push(escapeMarkdownProse(flow.description));
      lines.push("");
      for (let i = 0; i < flow.steps.length; i++) {
        const s = flow.steps[i];
        if (s === undefined) continue;
        lines.push(
          `${String(i + 1)}. **${escapeMarkdownInline(s.label)}**${s.moduleId === undefined ? "" : ` (${markdownCodeSpan(s.moduleId)})`} — ${escapeMarkdownInline(s.explanation)}`,
        );
      }
      lines.push("");
    }
  }

  if (projection.deterministicFlows.length > 0) {
    lines.push(`## Deterministic Critical Flows (${String(projection.deterministicFlows.length)})`);
    lines.push("");
    for (const flow of projection.deterministicFlows) {
      const chain = [
        flow.entryQualifiedName,
        ...flow.steps.map((s) => s.qualifiedName),
      ]
        .map(escapeMarkdownInline)
        .join(" -> ");
      lines.push(`- ${chain}`);
    }
    lines.push("");
  }

  if (annotations !== undefined && annotations.guidedTour.length > 0) {
    lines.push(`## Onboarding Guided Tour (${String(annotations.guidedTour.length)} steps)`);
    lines.push("");
    for (const stop of annotations.guidedTour) {
      lines.push(
        `${String(stop.step)}. **${escapeMarkdownInline(stop.title)}**${stop.targetModuleId === undefined ? "" : ` (${markdownCodeSpan(stop.targetModuleId)})`} — ${escapeMarkdownInline(stop.explanation)}`,
      );
    }
    lines.push("");
  }

  if (projection.entrypoints.length > 0) {
    lines.push(`## Entrypoints (${String(projection.entrypoints.length)})`);
    lines.push("");
    lines.push("| Kind | Name | Module | Location |");
    lines.push("| --- | --- | --- | --- |");
    for (const ep of projection.entrypoints.slice(0, 40)) {
      const loc =
        ep.relativePath === undefined
          ? ""
          : `${ep.relativePath}${ep.startLine === undefined ? "" : `:${String(ep.startLine)}`}`;
      lines.push(
        `| ${escapeMarkdownTableCell(ep.kind)} | ${escapeMarkdownTableCell(ep.qualifiedName)} | ${escapeMarkdownTableCell(ep.moduleId)} | ${escapeMarkdownTableCell(loc)} |`,
      );
    }
    lines.push("");
  }

  if (projection.cycles.length > 0 || projection.riskHotspots.length > 0) {
    lines.push("## Cycles & Risk Hotspots");
    lines.push("");
    for (const c of projection.cycles) {
      lines.push(
        `- **Cycle ${escapeMarkdownInline(c.id)}** (${String(c.edgeCount)} edges): ${c.moduleIds.map((id) => markdownCodeSpan(id)).join(" ↔ ")}`,
      );
    }
    for (const h of projection.riskHotspots) {
      lines.push(
        `- **${escapeMarkdownInline(h.label)}** [${escapeMarkdownInline(h.reason)}]: ${escapeMarkdownInline(h.detail)}`,
      );
    }
    lines.push("");
  }

  if (annotations !== undefined && annotations.decisions.length > 0) {
    lines.push("## Architectural Decisions");
    lines.push("");
    for (const d of annotations.decisions) {
      lines.push(`- **${escapeMarkdownInline(d.title)}:** ${escapeMarkdownInline(d.summary)}`);
    }
    lines.push("");
  }

  if (annotations !== undefined && annotations.risks.length > 0) {
    lines.push("## Annotated Risks");
    lines.push("");
    for (const r of annotations.risks) {
      lines.push(
        `- **[${r.severity.toUpperCase()}] ${escapeMarkdownInline(r.title)}:** ${escapeMarkdownInline(r.summary)}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function serializeArchitectureMarkdown(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  annotations?: ArchitectureAnnotations,
): string {
  return serializeArchitectureMarkdownFromPrepared(
    prepareArchitecture(snapshot, options, annotations),
  );
}

/* ------------------------------------------------------------------ */
/* 4. Shared Portal CSS (Zero-JS & Interactive)                        */
/* ------------------------------------------------------------------ */

const PORTAL_BASE_CSS = `
:root {
  color-scheme: dark light;
  --bg: #0b1120;
  --bg-elev: #111827;
  --bg-card: #162033;
  --bg-band: rgba(30, 41, 59, 0.55);
  --border: #26344d;
  --border-strong: #3b4f73;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #3b82f6;
  --accent-soft: rgba(59, 130, 246, 0.16);
  --ok: #10b981;
  --warn: #f59e0b;
  --danger: #ef4444;
  --shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
}
#theme-light:checked ~ .portal-shell {
  --bg: #f8fafc;
  --bg-elev: #ffffff;
  --bg-card: #ffffff;
  --bg-band: rgba(226, 232, 240, 0.52);
  --border: #cbd5e1;
  --border-strong: #94a3b8;
  --text: #0f172a;
  --muted: #475569;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.12);
  --shadow: 0 4px 16px rgba(15, 23, 42, 0.08);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
.portal-shell { min-height: 100vh; background: var(--bg); color: var(--text); padding: 20px 24px 48px; }
.portal-inner { max-width: 1520px; margin: 0 auto; }
.hero {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px 24px;
  box-shadow: var(--shadow);
  margin-bottom: 16px;
}
.hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.hero h1 { margin: 0; font-size: 1.45rem; letter-spacing: -0.02em; }
.hero-sub { margin: 6px 0 0; color: var(--muted); font-size: 0.92rem; max-width: 960px; }
.badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 999px; font-size: 0.76rem; font-weight: 600;
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text);
}
.pill-accent { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.pill-ok { border-color: rgba(16,185,129,.45); color: var(--ok); }
.pill-warn { border-color: rgba(245,158,11,.45); color: var(--warn); }
.pill-danger { border-color: rgba(239,68,68,.45); color: var(--danger); }
.theme-btn {
  cursor: pointer; user-select: none;
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-card); color: var(--text); font-size: 0.82rem; font-weight: 600;
}
.kpi-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px; margin-top: 14px;
}
.kpi {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px;
}
.kpi-val { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
.kpi-lbl { font-size: 0.74rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }

/* Tabs */
.tab-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
.tab-lbl {
  cursor: pointer; padding: 7px 14px; border-radius: 10px; font-size: 0.86rem; font-weight: 600;
  color: var(--muted); border: 1px solid transparent; background: transparent;
}
.tab-lbl:hover { color: var(--text); background: var(--bg-elev); }
.tab-panel { display: none; }
#tab-map:checked ~ .portal-shell .tab-bar label[for="tab-map"],
#tab-flows:checked ~ .portal-shell .tab-bar label[for="tab-flows"],
#tab-modules:checked ~ .portal-shell .tab-bar label[for="tab-modules"],
#tab-risks:checked ~ .portal-shell .tab-bar label[for="tab-risks"],
#tab-mermaid:checked ~ .portal-shell .tab-bar label[for="tab-mermaid"] {
  background: var(--accent-soft); color: var(--accent); border-color: var(--accent);
}
#tab-map:checked ~ .portal-shell #panel-map,
#tab-flows:checked ~ .portal-shell #panel-flows,
#tab-modules:checked ~ .portal-shell #panel-modules,
#tab-risks:checked ~ .portal-shell #panel-risks,
#tab-mermaid:checked ~ .portal-shell #panel-mermaid {
  display: block;
}

/* Diagram canvas & zoom presets */
.toolbar {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
  gap: 10px; padding: 10px 14px; background: var(--bg-elev);
  border: 1px solid var(--border); border-radius: 12px 12px 0 0;
}
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.78rem; color: var(--muted); align-items: center; }
.leg-dot { display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 4px; vertical-align: middle; }
.zoom-group { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.zoom-lbl, .ctrl-btn {
  cursor: pointer; padding: 4px 10px; border-radius: 8px; font-size: 0.78rem; font-weight: 600;
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text);
}
.ctrl-btn:hover, .zoom-lbl:hover { border-color: var(--accent); }
.canvas-wrap {
  background: var(--bg-elev); border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 12px 12px; overflow: auto; max-height: 76vh; padding: 12px;
  position: relative;
}
.arch-svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
#zoom-fit:checked ~ .portal-shell .arch-svg { width: 100%; max-width: 100%; height: auto; }
#zoom-75:checked ~ .portal-shell .arch-svg { width: 75%; max-width: none; height: auto; }
#zoom-100:checked ~ .portal-shell .arch-svg { width: auto; max-width: none; height: auto; }
#zoom-130:checked ~ .portal-shell .arch-svg { width: 130%; max-width: none; height: auto; }
#zoom-fit:checked ~ .portal-shell label[for="zoom-fit"],
#zoom-75:checked ~ .portal-shell label[for="zoom-75"],
#zoom-100:checked ~ .portal-shell label[for="zoom-100"],
#zoom-130:checked ~ .portal-shell label[for="zoom-130"] {
  border-color: var(--accent); background: var(--accent-soft); color: var(--accent);
}

/* SVG elements */
.band-rect { fill: var(--bg-band); stroke: var(--border); stroke-width: 1; }
.band-title { fill: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.node-card { fill: var(--bg-card); stroke: var(--border-strong); stroke-width: 1.4; transition: stroke 0.15s, opacity 0.15s; }
.arch-node:hover .node-card, .arch-node.is-selected .node-card { stroke: var(--accent); stroke-width: 2.5; }
.arch-node.node-cycle .node-card { stroke: var(--danger); stroke-width: 2; }
.arch-node.node-test .node-card { stroke-dasharray: 5 3; }
.arch-node.is-dimmed, .arch-edge.is-dimmed { opacity: 0.18; }
.node-title { fill: var(--text); font-size: 13px; font-weight: 700; }
.node-meta { fill: var(--muted); font-size: 11px; }
.node-sub { fill: var(--muted); font-size: 10.5px; opacity: 0.9; }
.node-badge { font-size: 9px; font-weight: 700; letter-spacing: 0.04em; }
.svg-node-link { text-decoration: none; cursor: pointer; }
.edge-hit { stroke: transparent; stroke-width: 12; cursor: pointer; }
.edge-pill { fill: var(--bg-elev); stroke: var(--border); stroke-width: 1; }
.edge-label { fill: var(--muted); font-size: 9.5px; font-weight: 600; pointer-events: none; }
.arch-edge:hover .edge-path, .arch-edge.is-selected .edge-path { stroke-width: 3.4; }
.svg-empty { fill: var(--muted); font-size: 14px; }

/* Flow strip SVG */
.flow-svg-wrap { overflow-x: auto; padding: 6px 0; }
.flow-box { fill: var(--bg-card); stroke: var(--accent); stroke-width: 1.4; }
.flow-step-title { fill: var(--text); font-size: 12px; font-weight: 700; }
.flow-step-sub { fill: var(--muted); font-size: 10.5px; }
.flow-arrow { stroke: var(--accent); stroke-width: 2; }
.flow-arrow-head { fill: var(--accent); }

/* Cards, grids, details, tables */
.section-card {
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px 20px; margin-top: 14px;
}
.section-card h2 { margin: 0 0 12px; font-size: 1.08rem; }
.section-card h3 { margin: 0 0 8px; font-size: 0.96rem; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
details.mod-detail {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; scroll-margin-top: 20px;
}
details.mod-detail:target { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
details.mod-detail summary {
  cursor: pointer; font-weight: 700; list-style: none; display: flex;
  justify-content: space-between; align-items: center; gap: 8px;
}
details.mod-detail summary::-webkit-details-marker { display: none; }
.detail-body { margin-top: 10px; font-size: 0.85rem; border-top: 1px solid var(--border); padding-top: 10px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; }
.muted { color: var(--muted); }
a.jump { color: var(--accent); text-decoration: none; font-weight: 600; }
a.jump:hover { text-decoration: underline; }
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-top: 8px; }
th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: var(--bg-card); color: var(--muted); font-weight: 600; }
pre.code-block {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; overflow-x: auto; font-size: 0.82rem; line-height: 1.45;
}
.step-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.step-item {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
}

/* Interactive workspace split layout */
.inter-grid { display: grid; grid-template-columns: minmax(0, 1fr) 370px; gap: 14px; align-items: start; }
@media (max-width: 1080px) { .inter-grid { grid-template-columns: 1fr; } }
.inspector-pane {
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px; max-height: 82vh; overflow-y: auto; position: sticky; top: 16px;
}
.filter-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.search-input {
  background: var(--bg-card); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 6px 10px; font-size: 0.82rem; min-width: 210px;
}
.filter-select {
  background: var(--bg-card); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 5px 8px; font-size: 0.8rem;
}
.canvas-stage { cursor: grab; overflow: hidden; height: 68vh; min-height: 440px; }
.canvas-stage.is-panning { cursor: grabbing; }
.stage-inner { transform-origin: 0 0; will-change: transform; }
.ev-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-top: 6px; font-size: 0.78rem; }
`;

/* ------------------------------------------------------------------ */
/* 5. Shared HTML Section Builders                                     */
/* ------------------------------------------------------------------ */

function renderHeroSection(
  prepared: PreparedArchitecture,
  interactive: boolean,
): string {
  const { projection, annotations } = prepared;
  const s = projection.summary;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  const title = annotations?.title ?? `Causoryn Architecture — ${projection.meta.workspaceId}`;
  const summary =
    annotations?.executiveSummary ??
    `Deterministic architecture projection across ${String(s.analyzedFiles)} files, ${String(s.moduleCount)} modules, and ${String(s.moduleEdgeCount)} aggregated cross-module dependencies.`;

  const langPills = s.languages
    .slice(0, 6)
    .map((l) => `<span class="pill">${safe(l.language)}: ${String(l.fileCount)} files</span>`)
    .join("");

  return [
    '<header class="hero">',
    '<div class="hero-top">',
    '<div>',
    `<h1>${safe(title)}</h1>`,
    `<p class="hero-sub">${safe(summary)}</p>`,
    '<div class="badge-row">',
    annotations?.architectureStyle === undefined
      ? ""
      : `<span class="pill pill-accent">${safe(annotations.architectureStyle)}</span>`,
    `<span class="pill ${projection.meta.state === "ready" ? "pill-ok" : "pill-warn"}">Snapshot: ${safe(projection.meta.state)}</span>`,
    annotations === undefined
      ? '<span class="pill">Mode: Deterministic Projection</span>'
      : '<span class="pill pill-accent">Host-LLM Annotated &amp; Grounded</span>',
    `<span class="pill">External refs excluded: ${String(projection.externalSummary.nodeCount)}</span>`,
    langPills,
    "</div>",
    "</div>",
    '<label for="theme-light" class="theme-btn">Toggle Light / Dark</label>',
    "</div>",
    '<div class="kpi-grid">',
    `<div class="kpi"><div class="kpi-val">${String(s.moduleCount)}</div><div class="kpi-lbl">Modules</div></div>`,
    `<div class="kpi"><div class="kpi-val">${String(s.moduleEdgeCount)}</div><div class="kpi-lbl">Module Edges</div></div>`,
    `<div class="kpi"><div class="kpi-val">${String(s.analyzedFiles)}</div><div class="kpi-lbl">Analyzed Files</div></div>`,
    `<div class="kpi"><div class="kpi-val">${String(s.entrypointCount)}</div><div class="kpi-lbl">Entrypoints</div></div>`,
    `<div class="kpi"><div class="kpi-val">${String(s.contractCount)}</div><div class="kpi-lbl">Contracts / Data</div></div>`,
    `<div class="kpi"><div class="kpi-val" style="color:${s.cycleCount > 0 ? "var(--danger)" : "var(--ok)"}">${String(s.cycleCount)}</div><div class="kpi-lbl">Circular Deps</div></div>`,
    `<div class="kpi"><div class="kpi-val">${String(s.resolutionCounts.verified)}</div><div class="kpi-lbl">Verified Edges</div></div>`,
    "</div>",
    "</header>",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

function renderLegendHtml(): string {
  return [
    '<div class="legend">',
    '<span><span class="leg-dot" style="background:#10b981"></span>Verified</span>',
    '<span><span class="leg-dot" style="background:#f59e0b"></span>Heuristic</span>',
    '<span><span class="leg-dot" style="background:#64748b"></span>Unresolved</span>',
    '<span><span class="leg-dot" style="background:#ef4444"></span>Cycle (SCC)</span>',
    '<span><span class="leg-dot" style="background:#3b82f6"></span>TS</span>',
    '<span><span class="leg-dot" style="background:#8b5cf6"></span>C#</span>',
    '<span><span class="leg-dot" style="background:#10b981"></span>Python</span>',
    '<span><span class="leg-dot" style="background:#06b6d4"></span>Go</span>',
    '<span><span class="leg-dot" style="background:#f97316"></span>Rust</span>',
    "</div>",
  ].join("");
}

function renderModuleCardsHtml(
  prepared: PreparedArchitecture,
  interactive: boolean,
  anchorByModId: ReadonlyMap<string, string>,
): string {
  const { projection, annotations, evidenceCatalog } = prepared;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  const noteByModId = new Map((annotations?.moduleNotes ?? []).map((n) => [n.moduleId, n]));
  const modLabelById = new Map(projection.modules.map((m) => [m.id, m.label]));

  const outByMod = new Map<string, ProjectedModuleEdge[]>();
  const inByMod = new Map<string, ProjectedModuleEdge[]>();
  for (const e of projection.edges) {
    let outs = outByMod.get(e.from);
    if (outs === undefined) {
      outs = [];
      outByMod.set(e.from, outs);
    }
    outs.push(e);
    let ins = inByMod.get(e.to);
    if (ins === undefined) {
      ins = [];
      inByMod.set(e.to, ins);
    }
    ins.push(e);
  }

  const cards: string[] = [];
  for (const m of projection.modules) {
    const anchor = anchorByModId.get(m.id) ?? "mod-card-0";
    const note = noteByModId.get(m.id);
    const outs = outByMod.get(m.id) ?? [];
    const ins = inByMod.get(m.id) ?? [];

    const depsHtml: string[] = [];
    if (outs.length > 0) {
      depsHtml.push(
        `<p><strong>Depends on (${String(outs.length)}):</strong> ` +
          outs
            .map((e) => {
              const targetAnchor = anchorByModId.get(e.to) ?? anchor;
              const targetLbl = modLabelById.get(e.to) ?? e.to;
              return `<a class="jump" href="#${targetAnchor}">${safe(targetLbl)}</a> (×${String(e.weight)})`;
            })
            .join(" · ") +
          "</p>",
      );
    }
    if (ins.length > 0) {
      depsHtml.push(
        `<p><strong>Used by (${String(ins.length)}):</strong> ` +
          ins
            .map((e) => {
              const srcAnchor = anchorByModId.get(e.from) ?? anchor;
              const srcLbl = modLabelById.get(e.from) ?? e.from;
              return `<a class="jump" href="#${srcAnchor}">${safe(srcLbl)}</a> (×${String(e.weight)})`;
            })
            .join(" · ") +
          "</p>",
      );
    }

    const symRows = m.keySymbols
      .slice(0, 8)
      .map((s) => {
        const loc =
          s.relativePath === undefined
            ? ""
            : `${s.relativePath}${s.startLine === undefined ? "" : `:${String(s.startLine)}`}`;
        return `<tr><td>${safe(s.kind)}</td><td class="mono">${safe(s.qualifiedName)}</td><td class="mono muted">${safe(loc)}</td></tr>`;
      })
      .join("");

    const evRows = m.evidenceIds
      .slice(0, 5)
      .map((eid) => (Object.hasOwn(evidenceCatalog, eid) ? evidenceCatalog[eid] : undefined))
      .filter((ev): ev is ProjectedEvidenceRecord => ev !== undefined)
      .map((ev) => {
        const loc =
          ev.span === undefined
            ? ""
            : `${ev.span.relativePath}:${String(ev.span.startLine)}-${String(ev.span.endLine)}`;
        return `<tr><td class="mono">${safe(loc)}</td><td>${safe(ev.analyzerId)}</td><td>${safe(ev.rationale)}</td></tr>`;
      })
      .join("");

    cards.push(
      `<details class="mod-detail" id="${anchor}">` +
        `<summary><span>${safe(m.label)} <span class="muted mono">(${safe(m.primaryLanguage)})</span></span>` +
        `<span class="pill">L${String(m.layer)} · ${String(m.counts.files)}f · ${String(m.fanIn)}↓/${String(m.fanOut)}↑</span></summary>` +
        `<div class="detail-body">` +
        `<p class="mono muted">${safe(m.id)} · ${safe(m.path)}</p>` +
        (note === undefined
          ? ""
          : `<p><strong>Summary:</strong> ${safe(note.summary)}</p>` +
            (note.responsibility === undefined
              ? ""
              : `<p><strong>Responsibility:</strong> ${safe(note.responsibility)}</p>`)) +
        depsHtml.join("") +
        (symRows.length > 0
          ? `<table><thead><tr><th>Kind</th><th>Key Symbol</th><th>Location</th></tr></thead><tbody>${symRows}</tbody></table>`
          : "") +
        (evRows.length > 0
          ? `<p style="margin-top:10px"><strong>Source Evidence (${String(m.evidenceIds.length)}):</strong></p>` +
            `<table><thead><tr><th>Span</th><th>Analyzer</th><th>Rationale</th></tr></thead><tbody>${evRows}</tbody></table>`
          : "") +
        `</div></details>`,
    );
  }

  return `<div class="card-grid">${cards.join("\n")}</div>`;
}

function renderFlowsAndTourHtml(
  prepared: PreparedArchitecture,
  interactive: boolean,
): string {
  const { projection, annotations } = prepared;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  const renderModuleRef = (modId: string | undefined, fallback: string): string => {
    if (modId === undefined) return safe(fallback);
    if (interactive) {
      return `<button type="button" class="ctrl-btn mono" data-jump-module="${safe(modId)}">${safe(modId)}</button>`;
    }
    return `<span class="pill mono">${safe(modId)}</span>`;
  };
  const sections: string[] = [];

  if (annotations !== undefined && annotations.guidedTour.length > 0) {
    const items = annotations.guidedTour
      .map(
        (stop) =>
          `<li class="step-item">` +
          `<strong>Step ${String(stop.step)}: ${safe(stop.title)}</strong>` +
          (stop.targetModuleId === undefined
            ? ""
            : ` · ${renderModuleRef(stop.targetModuleId, "")}`) +
          `<p style="margin:6px 0 0">${safe(stop.explanation)}</p>` +
          `</li>`,
      )
      .join("\n");
    sections.push(
      `<section class="section-card"><h2>Onboarding Guided Tour (${String(annotations.guidedTour.length)} steps)</h2><ol class="step-list">${items}</ol></section>`,
    );
  }

  if (annotations !== undefined && annotations.flows.length > 0) {
    const flowBlocks = annotations.flows
      .map((flow) => {
        const strip = renderFlowStripSvg(
          flow.steps.map((s) => ({
            label: s.label,
            sublabel: s.moduleId ?? s.nodeId ?? "step",
          })),
          interactive,
        );
        const stepRows = flow.steps
          .map((s, idx) => {
            const target = renderModuleRef(s.moduleId, s.nodeId ?? "");
            return `<tr><td>${String(idx + 1)}</td><td><strong>${safe(s.label)}</strong></td><td>${target}</td><td>${safe(s.explanation)}</td></tr>`;
          })
          .join("");
        return (
          `<div class="section-card">` +
          `<h3>${safe(flow.title)}</h3>` +
          `<p class="muted">${safe(flow.description)}</p>` +
          `<div class="flow-svg-wrap">${strip}</div>` +
          `<table><thead><tr><th>#</th><th>Step</th><th>Module / Node</th><th>Explanation</th></tr></thead><tbody>${stepRows}</tbody></table>` +
          `</div>`
        );
      })
      .join("\n");
    sections.push(`<section class="section-card"><h2>Annotated Business Flows</h2>${flowBlocks}</section>`);
  }

  if (projection.deterministicFlows.length > 0) {
    const detBlocks = projection.deterministicFlows
      .map((flow) => {
        const strip = renderFlowStripSvg(
          [
            { label: flow.entryQualifiedName, sublabel: flow.entryModuleId ?? "Entrypoint" },
            ...flow.steps.map((s) => ({ label: s.qualifiedName, sublabel: `${s.kind} · d${String(s.depth)}` })),
          ],
          interactive,
        );
        return `<div class="step-item"><strong>${safe(flow.entryQualifiedName)}</strong><div class="flow-svg-wrap">${strip}</div></div>`;
      })
      .join("\n");
    sections.push(
      `<section class="section-card"><h2>Deterministic Critical Flows (${String(projection.deterministicFlows.length)})</h2><div class="step-list">${detBlocks}</div></section>`,
    );
  }

  if (sections.length === 0) {
    sections.push(
      '<section class="section-card"><h2>Flows &amp; Guided Tour</h2><p class="muted">No verified entrypoint flows detected in this snapshot. Use the Causoryn architecture-blueprint skill with your host LLM to synthesize grounded business flows and onboarding tours.</p></section>',
    );
  }
  return sections.join("\n");
}

function renderEntrypointsAndContractsHtml(
  prepared: PreparedArchitecture,
  interactive: boolean,
): string {
  const { projection, annotations } = prepared;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  const out: string[] = [];

  if (annotations !== undefined && annotations.domains.length > 0) {
    const domCards = annotations.domains
      .map(
        (d) =>
          `<div class="step-item"><strong>${safe(d.name)}</strong>${d.layer === undefined ? "" : ` <span class="pill">${safe(d.layer)}</span>`}` +
          `<p style="margin:6px 0">${safe(d.description)}</p>` +
          `<p class="mono muted">${safe(d.moduleIds.join(", "))}</p></div>`,
      )
      .join("\n");
    out.push(`<section class="section-card"><h2>Domains (${String(annotations.domains.length)})</h2><div class="card-grid">${domCards}</div></section>`);
  }

  if (projection.entrypoints.length > 0) {
    const rows = projection.entrypoints
      .map((ep) => {
        const loc =
          ep.relativePath === undefined
            ? ""
            : `${ep.relativePath}${ep.startLine === undefined ? "" : `:${String(ep.startLine)}`}`;
        return `<tr><td>${safe(ep.kind)}</td><td class="mono">${safe(ep.qualifiedName)}</td><td class="mono">${safe(ep.moduleId)}</td><td class="mono muted">${safe(loc)}</td></tr>`;
      })
      .join("");
    out.push(
      `<section class="section-card"><h2>Entrypoints (${String(projection.entrypoints.length)})</h2>` +
        `<table><thead><tr><th>Kind</th><th>Qualified Name</th><th>Module</th><th>Location</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }

  if (projection.contracts.length > 0) {
    const rows = projection.contracts
      .map((c) => {
        const loc =
          c.relativePath === undefined
            ? ""
            : `${c.relativePath}${c.startLine === undefined ? "" : `:${String(c.startLine)}`}`;
        return `<tr><td>${safe(c.kind)}</td><td class="mono">${safe(c.qualifiedName)}</td><td class="mono">${safe(c.moduleId)}</td><td class="mono muted">${safe(loc)}</td></tr>`;
      })
      .join("");
    out.push(
      `<section class="section-card"><h2>Contracts &amp; Data Boundaries (${String(projection.contracts.length)})</h2>` +
        `<table><thead><tr><th>Kind</th><th>Qualified Name</th><th>Module</th><th>Location</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }

  if (out.length === 0) {
    out.push(
      '<section class="section-card"><h2>Entrypoints &amp; Contracts</h2><p class="muted">No Endpoint, Handler, Contract, or Database nodes detected in this snapshot.</p></section>',
    );
  }
  return out.join("\n");
}

function renderRisksAndDecisionsHtml(
  prepared: PreparedArchitecture,
  interactive: boolean,
): string {
  const { projection, annotations } = prepared;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  const out: string[] = [];

  if (projection.cycles.length > 0) {
    const rows = projection.cycles
      .map(
        (c) =>
          `<tr><td class="mono">${safe(c.id)}</td><td>${String(c.edgeCount)}</td><td class="mono">${safe(c.moduleIds.join(" ↔ "))}</td></tr>`,
      )
      .join("");
    out.push(
      `<section class="section-card"><h2>Circular Dependencies (${String(projection.cycles.length)} SCCs)</h2>` +
        `<table><thead><tr><th>Cycle</th><th>Edges</th><th>Participating Modules</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }

  if (projection.riskHotspots.length > 0) {
    const rows = projection.riskHotspots
      .map(
        (h) =>
          `<tr><td><strong>${safe(h.label)}</strong></td><td><span class="pill ${h.reason === "cycle" ? "pill-danger" : "pill-warn"}">${safe(h.reason)}</span></td><td>${safe(h.detail)}</td></tr>`,
      )
      .join("");
    out.push(
      `<section class="section-card"><h2>Structural Hotspots (${String(projection.riskHotspots.length)})</h2>` +
        `<table><thead><tr><th>Module</th><th>Signal</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    );
  }

  if (annotations !== undefined && annotations.decisions.length > 0) {
    const items = annotations.decisions
      .map(
        (d) =>
          `<div class="step-item"><strong>${safe(d.title)}</strong> <span class="mono muted">(${safe(d.id)})</span>` +
          `<p style="margin:6px 0">${safe(d.summary)}</p>` +
          (d.rationale === undefined ? "" : `<p class="muted">${safe(d.rationale)}</p>`) +
          `</div>`,
      )
      .join("\n");
    out.push(`<section class="section-card"><h2>Architectural Decisions</h2><div class="step-list">${items}</div></section>`);
  }

  if (annotations !== undefined && annotations.risks.length > 0) {
    const items = annotations.risks
      .map(
        (r) =>
          `<div class="step-item"><span class="pill ${r.severity === "high" ? "pill-danger" : r.severity === "medium" ? "pill-warn" : "pill-ok"}">${r.severity.toUpperCase()}</span> ` +
          `<strong>${safe(r.title)}</strong><p style="margin:6px 0">${safe(r.summary)}</p></div>`,
      )
      .join("\n");
    out.push(`<section class="section-card"><h2>Annotated Architectural Risks</h2><div class="step-list">${items}</div></section>`);
  }

  const ext = projection.externalSummary;
  const extRows = ext.topExternalTargets
    .map(
      (t) =>
        `<tr><td class="mono">${safe(t.qualifiedName)}</td><td>${safe(t.language ?? "")}</td><td>${String(t.inboundEdgeCount)}</td></tr>`,
    )
    .join("");
  out.push(
    `<section class="section-card"><h2>External &amp; Unresolved Boundaries</h2>` +
      `<p class="muted">${String(ext.nodeCount)} UnknownExternal symbols (${String(ext.unresolvedEdgeCount)} edges) were intentionally kept out of the visual module map to preserve clarity.</p>` +
      (extRows.length > 0
        ? `<table><thead><tr><th>External Reference</th><th>Language</th><th>Inbound Refs</th></tr></thead><tbody>${extRows}</tbody></table>`
        : "") +
      `</section>`,
  );

  return out.join("\n");
}

function renderMermaidAndMetaHtml(
  prepared: PreparedArchitecture,
  mermaidText: string,
  interactive: boolean,
): string {
  const { projection } = prepared;
  const safe = (v: string): string => safeHtmlText(v, interactive);
  return [
    '<section class="section-card">',
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">',
    "<h2>Mermaid Architecture Diagram Source</h2>",
    interactive ? '<button type="button" id="causoryn-copy-mmd" class="ctrl-btn">Copy Mermaid</button>' : "",
    "</div>",
    '<p class="muted">Paste directly into GitHub Markdown, VS Code Mermaid Preview, Notion, or Mermaid Live.</p>',
    `<pre class="code-block mono" id="causoryn-mmd-source">${safe(mermaidText)}</pre>`,
    "</section>",
    '<section class="section-card">',
    "<h2>Snapshot Provenance &amp; Coverage Boundaries</h2>",
    "<table><tbody>",
    `<tr><th>Snapshot ID</th><td class="mono">${safe(projection.meta.id)}</td></tr>`,
    `<tr><th>Workspace</th><td class="mono">${safe(projection.meta.workspaceId)}</td></tr>`,
    `<tr><th>Revision</th><td class="mono">${safe(projection.meta.revision.id)} (seq ${String(projection.meta.revision.sequence)})</td></tr>`,
    `<tr><th>Analyzers</th><td class="mono">${safe(projection.meta.analyzerFingerprint)}</td></tr>`,
    `<tr><th>State</th><td>${safe(projection.meta.state)}</td></tr>`,
    `<tr><th>Created At</th><td class="mono">${safe(projection.meta.createdAt)}</td></tr>`,
    `<tr><th>Raw Graph Totals</th><td>${String(projection.summary.totalRawNodes)} nodes · ${String(projection.summary.totalRawEdges)} edges · ${String(projection.summary.totalRawEvidence)} evidence</td></tr>`,
    "</tbody></table>",
    "</section>",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 6. Zero-JS Strict-CSP Offline Architecture Portal (Default HTML)    */
/* ------------------------------------------------------------------ */

export function serializeArchitectureHtmlFromPrepared(prepared: PreparedArchitecture): string {
  const { projection, annotations } = prepared;
  const layout = computeArchitectureLayout(projection, annotations);
  const svg = renderArchitectureSvg(projection, layout, {
    interactive: false,
    ...(annotations === undefined ? {} : { annotations }),
  });
  const mermaidText = renderArchitectureMermaidFromPrepared(prepared);
  const anchorByModId = new Map<string, string>(
    projection.modules.map((m, i) => [m.id, moduleAnchorId(i)]),
  );
  const pageTitle = safeHtmlText(
    annotations?.title ?? `Causoryn Architecture — ${projection.meta.workspaceId}`,
    false,
  );

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ARCHITECTURE_ZERO_JS_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${pageTitle}</title>`,
    "<style>",
    PORTAL_BASE_CSS,
    "</style>",
    "</head>",
    "<body>",
    '<input type="checkbox" id="theme-light" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-map" class="sr-only" checked>',
    '<input type="radio" name="arch-tab" id="tab-flows" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-modules" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-risks" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-mermaid" class="sr-only">',
    '<input type="radio" name="arch-zoom" id="zoom-fit" class="sr-only" checked>',
    '<input type="radio" name="arch-zoom" id="zoom-75" class="sr-only">',
    '<input type="radio" name="arch-zoom" id="zoom-100" class="sr-only">',
    '<input type="radio" name="arch-zoom" id="zoom-130" class="sr-only">',
    '<div class="portal-shell"><div class="portal-inner">',
    renderHeroSection(prepared, false),
    '<nav class="tab-bar" aria-label="Architecture Views">',
    '<label for="tab-map" class="tab-lbl">Architecture Map</label>',
    '<label for="tab-flows" class="tab-lbl">Flows &amp; Guided Tour</label>',
    '<label for="tab-modules" class="tab-lbl">Entrypoints &amp; Contracts</label>',
    '<label for="tab-risks" class="tab-lbl">Risks, Cycles &amp; Decisions</label>',
    '<label for="tab-mermaid" class="tab-lbl">Mermaid &amp; Metadata</label>',
    "</nav>",
    '<main>',
    '<div id="panel-map" class="tab-panel">',
    '<div class="toolbar">',
    renderLegendHtml(),
    '<div class="zoom-group" aria-label="Zoom presets">',
    '<span class="muted" style="font-size:0.76rem">Zoom:</span>',
    '<label for="zoom-fit" class="zoom-lbl">Fit</label>',
    '<label for="zoom-75" class="zoom-lbl">75%</label>',
    '<label for="zoom-100" class="zoom-lbl">100%</label>',
    '<label for="zoom-130" class="zoom-lbl">130%</label>',
    "</div>",
    "</div>",
    `<div class="canvas-wrap">${svg}</div>`,
    `<section class="section-card"><h2>Module Inspector &amp; Evidence (${String(projection.modules.length)} modules — click any box above to jump)</h2>`,
    renderModuleCardsHtml(prepared, false, anchorByModId),
    "</section>",
    "</div>",
    `<div id="panel-flows" class="tab-panel">${renderFlowsAndTourHtml(prepared, false)}</div>`,
    `<div id="panel-modules" class="tab-panel">${renderEntrypointsAndContractsHtml(prepared, false)}</div>`,
    `<div id="panel-risks" class="tab-panel">${renderRisksAndDecisionsHtml(prepared, false)}</div>`,
    `<div id="panel-mermaid" class="tab-panel">${renderMermaidAndMetaHtml(prepared, mermaidText, false)}</div>`,
    "</main>",
    "</div></div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function serializeArchitectureHtml(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  annotations?: ArchitectureAnnotations,
): string {
  return serializeArchitectureHtmlFromPrepared(prepareArchitecture(snapshot, options, annotations));
}

/* ------------------------------------------------------------------ */
/* 7. Interactive Offline Architecture Portal (E6+ Opt-In)             */
/* ------------------------------------------------------------------ */

/**
 * Sıfır innerHTML / sıfır fetch / sıfır eval gömülü etkileşim betiği.
 * Yalnızca document.createElement + textContent + SVG transform/classList kullanır.
 */
const INTERACTIVE_PORTAL_JS = `(function(){
  "use strict";
  var island = document.getElementById("causoryn-portal-data");
  if (!island) return;
  var data = JSON.parse(island.textContent || "{}");
  var modById = Object.create(null);
  (data.modules || []).forEach(function(m){ modById[m.id] = m; });
  var edgeById = Object.create(null);
  (data.edges || []).forEach(function(e){ edgeById[e.id] = e; });
  var noteByModId = Object.create(null);
  ((data.annotations && data.annotations.moduleNotes) || []).forEach(function(n){ noteByModId[n.moduleId] = n; });
  var evidenceById = Object.create(null);
  if (data.evidence && typeof data.evidence === "object") {
    Object.keys(data.evidence).forEach(function(k){
      if (Object.prototype.hasOwnProperty.call(data.evidence, k)) evidenceById[k] = data.evidence[k];
    });
  }

  var stage = document.getElementById("causoryn-stage");
  var stageInner = document.getElementById("causoryn-stage-inner");
  var inspector = document.getElementById("causoryn-inspector");
  var searchEl = document.getElementById("causoryn-search");
  var langEl = document.getElementById("causoryn-lang-filter");
  var cycleOnlyEl = document.getElementById("causoryn-cycle-only");
  var hideTestsEl = document.getElementById("causoryn-hide-tests");
  var nodeEls = Array.prototype.slice.call(document.querySelectorAll(".arch-node"));
  var edgeEls = Array.prototype.slice.call(document.querySelectorAll(".arch-edge"));

  var scale = 1, tx = 0, ty = 0, dragging = false, startX = 0, startY = 0;
  function applyTransform() {
    if (!stageInner) return;
    stageInner.style.transform = "translate(" + Math.round(tx) + "px," + Math.round(ty) + "px) scale(" + scale.toFixed(3) + ")";
  }
  function fitCanvas() {
    if (!stage) return;
    var svg = document.getElementById("causoryn-arch-svg");
    if (!svg) return;
    var sw = Number(svg.getAttribute("width") || 1200);
    var sh = Number(svg.getAttribute("height") || 700);
    var cw = stage.clientWidth || 900;
    var ch = stage.clientHeight || 560;
    scale = Math.max(0.25, Math.min(1.1, Math.min((cw - 24) / sw, (ch - 24) / sh)));
    tx = Math.max(8, (cw - sw * scale) / 2);
    ty = 12;
    applyTransform();
  }
  var btnIn = document.getElementById("causoryn-zoom-in");
  var btnOut = document.getElementById("causoryn-zoom-out");
  var btnFit = document.getElementById("causoryn-zoom-fit");
  if (btnIn) btnIn.addEventListener("click", function(){ scale = Math.min(2.5, scale * 1.18); applyTransform(); });
  if (btnOut) btnOut.addEventListener("click", function(){ scale = Math.max(0.2, scale / 1.18); applyTransform(); });
  if (btnFit) btnFit.addEventListener("click", fitCanvas);

  if (stage) {
    stage.addEventListener("wheel", function(ev){
      ev.preventDefault();
      var factor = ev.deltaY < 0 ? 1.1 : 0.91;
      scale = Math.max(0.2, Math.min(2.5, scale * factor));
      applyTransform();
    }, { passive: false });
    stage.addEventListener("mousedown", function(ev){
      if (ev.target && ev.target.closest && ev.target.closest(".arch-node, .arch-edge")) return;
      dragging = true;
      startX = ev.clientX - tx;
      startY = ev.clientY - ty;
      stage.classList.add("is-panning");
    });
    window.addEventListener("mousemove", function(ev){
      if (!dragging) return;
      tx = ev.clientX - startX;
      ty = ev.clientY - startY;
      applyTransform();
    });
    window.addEventListener("mouseup", function(){
      dragging = false;
      stage.classList.remove("is-panning");
    });
  }

  function clearEl(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function mk(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }
  function appendEvidenceList(container, ids) {
    container.appendChild(mk("h3", "", "Source-Span Evidence (" + ids.length + ")"));
    if (!ids.length) {
      container.appendChild(mk("p", "muted", "No source-span evidence attached to this item."));
      return;
    }
    ids.forEach(function(eid){
      var ev = evidenceById[eid];
      if (!ev) return;
      var card = mk("div", "ev-card");
      var spanText = ev.span ? (ev.span.relativePath + ":" + ev.span.startLine + "-" + ev.span.endLine) : ev.id;
      card.appendChild(mk("div", "mono", spanText));
      card.appendChild(mk("div", "muted", ev.analyzerId + " (" + ev.kind + ")"));
      card.appendChild(mk("div", "", ev.rationale));
      container.appendChild(card);
    });
  }

  function clearSelection() {
    nodeEls.forEach(function(el){ el.classList.remove("is-selected", "is-dimmed"); });
    edgeEls.forEach(function(el){ el.classList.remove("is-selected", "is-dimmed"); });
  }

  function selectModule(modId) {
    var m = modById[modId];
    if (!m || !inspector) return;
    var neighbors = Object.create(null);
    neighbors[modId] = true;
    var relatedEdges = [];
    (data.edges || []).forEach(function(e){
      if (e.from === modId || e.to === modId) {
        neighbors[e.from] = true;
        neighbors[e.to] = true;
        relatedEdges.push(e);
      }
    });
    nodeEls.forEach(function(el){
      var id = el.getAttribute("data-module-id");
      el.classList.toggle("is-selected", id === modId);
      el.classList.toggle("is-dimmed", !neighbors[id]);
    });
    edgeEls.forEach(function(el){
      var f = el.getAttribute("data-from");
      var t = el.getAttribute("data-to");
      var hit = f === modId || t === modId;
      el.classList.toggle("is-selected", hit);
      el.classList.toggle("is-dimmed", !hit);
    });

    clearEl(inspector);
    var head = mk("div", "");
    head.appendChild(mk("h2", "", m.label));
    head.appendChild(mk("p", "mono muted", m.id + " · " + m.path));
    inspector.appendChild(head);

    var note = noteByModId[modId];
    if (note) {
      var noteBox = mk("div", "ev-card");
      noteBox.appendChild(mk("strong", "", "Host-LLM Summary"));
      noteBox.appendChild(mk("p", "", note.summary));
      if (note.responsibility) noteBox.appendChild(mk("p", "muted", "Responsibility: " + note.responsibility));
      inspector.appendChild(noteBox);
    }

    inspector.appendChild(
      mk("p", "muted", "Layer L" + m.layer + " · " + m.primaryLanguage + " · " + m.counts.files + " files · " + m.counts.totalSymbols + " symbols · fanIn " + m.fanIn + " / fanOut " + m.fanOut)
    );

    if (relatedEdges.length) {
      inspector.appendChild(mk("h3", "", "Connected Modules (" + relatedEdges.length + ")"));
      relatedEdges.forEach(function(e){
        var otherId = e.from === modId ? e.to : e.from;
        var dir = e.from === modId ? "→ " : "← ";
        var other = modById[otherId];
        var btn = mk("button", "ctrl-btn", dir + (other ? other.label : otherId) + " (×" + e.weight + ")");
        btn.type = "button";
        btn.style.margin = "3px 4px 3px 0";
        btn.addEventListener("click", function(){ selectModule(otherId); });
        inspector.appendChild(btn);
      });
    }

    if (m.keySymbols && m.keySymbols.length) {
      inspector.appendChild(mk("h3", "", "Key Symbols (" + m.keySymbols.length + ")"));
      m.keySymbols.forEach(function(s){
        var row = mk("div", "ev-card");
        row.appendChild(mk("div", "mono", s.kind + " :: " + s.qualifiedName));
        if (s.relativePath) row.appendChild(mk("div", "mono muted", s.relativePath + (s.startLine ? ":" + s.startLine : "")));
        inspector.appendChild(row);
      });
    }

    appendEvidenceList(inspector, m.evidenceIds || []);
    var resetBtn = mk("button", "ctrl-btn", "Reset Selection");
    resetBtn.type = "button";
    resetBtn.style.marginTop = "12px";
    resetBtn.addEventListener("click", function(){ clearSelection(); applyFilters(); });
    inspector.appendChild(resetBtn);
  }

  function selectEdge(edgeId) {
    var e = edgeById[edgeId];
    if (!e || !inspector) return;
    nodeEls.forEach(function(el){
      var id = el.getAttribute("data-module-id");
      el.classList.toggle("is-selected", id === e.from || id === e.to);
      el.classList.toggle("is-dimmed", id !== e.from && id !== e.to);
    });
    edgeEls.forEach(function(el){
      var hit = el.getAttribute("data-edge-id") === edgeId;
      el.classList.toggle("is-selected", hit);
      el.classList.toggle("is-dimmed", !hit);
    });
    clearEl(inspector);
    var src = modById[e.from];
    var dst = modById[e.to];
    inspector.appendChild(mk("h2", "", (src ? src.label : e.from) + " → " + (dst ? dst.label : e.to)));
    inspector.appendChild(mk("p", "muted", "Weight: " + e.weight + " · Resolution: " + e.resolution + (e.isCycle ? " · CYCLE" : "")));
    inspector.appendChild(mk("p", "mono muted", "Verified: " + e.resolutionCounts.verified + " · Heuristic: " + e.resolutionCounts.heuristic + " · Unresolved: " + e.resolutionCounts.unresolved));
    appendEvidenceList(inspector, e.evidenceIds || []);
  }

  nodeEls.forEach(function(el){
    var id = el.getAttribute("data-module-id");
    el.addEventListener("click", function(){ if (id) selectModule(id); });
    el.addEventListener("keydown", function(ev){ if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (id) selectModule(id); } });
  });
  edgeEls.forEach(function(el){
    var id = el.getAttribute("data-edge-id");
    el.addEventListener("click", function(){ if (id) selectEdge(id); });
    el.addEventListener("keydown", function(ev){ if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (id) selectEdge(id); } });
  });

  function applyFilters() {
    var q = (searchEl && searchEl.value || "").trim().toLowerCase();
    var lang = langEl ? langEl.value : "";
    var cycleOnly = !!(cycleOnlyEl && cycleOnlyEl.checked);
    var hideTests = !!(hideTestsEl && hideTestsEl.checked);
    var visible = Object.create(null);

    nodeEls.forEach(function(el){
      var id = el.getAttribute("data-module-id") || "";
      var m = modById[id];
      var note = noteByModId[id];
      var ok = true;
      if (lang && el.getAttribute("data-language") !== lang) ok = false;
      if (cycleOnly && el.getAttribute("data-cycle") !== "true") ok = false;
      if (hideTests && el.getAttribute("data-test") === "true") ok = false;
      if (ok && q && m) {
        var hay = (m.label + " " + m.path + " " + m.group + " " + (note ? note.summary : "") + " " + (m.keySymbols || []).map(function(s){ return s.qualifiedName; }).join(" ")).toLowerCase();
        if (hay.indexOf(q) === -1) ok = false;
      }
      el.classList.remove("is-selected");
      el.classList.toggle("is-dimmed", !ok);
      if (ok) visible[id] = true;
    });
    edgeEls.forEach(function(el){
      var f = el.getAttribute("data-from") || "";
      var t = el.getAttribute("data-to") || "";
      var ok = !!(visible[f] && visible[t]);
      if (cycleOnly && el.getAttribute("data-cycle") !== "true") ok = false;
      el.classList.remove("is-selected");
      el.classList.toggle("is-dimmed", !ok);
    });
  }

  if (searchEl) searchEl.addEventListener("input", applyFilters);
  if (langEl) langEl.addEventListener("change", applyFilters);
  if (cycleOnlyEl) cycleOnlyEl.addEventListener("change", applyFilters);
  if (hideTestsEl) hideTestsEl.addEventListener("change", applyFilters);

  var copyBtn = document.getElementById("causoryn-copy-mmd");
  var mmdPre = document.getElementById("causoryn-mmd-source");
  if (copyBtn && mmdPre) {
    copyBtn.addEventListener("click", function(){
      var txt = mmdPre.textContent || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function(){
          copyBtn.textContent = "Copied!";
          setTimeout(function(){ copyBtn.textContent = "Copy Mermaid"; }, 1600);
        });
      }
    });
  }

  var jumpBtns = Array.prototype.slice.call(document.querySelectorAll("[data-jump-module]"));
  var mapRadio = document.getElementById("tab-map");
  jumpBtns.forEach(function(btn){
    btn.addEventListener("click", function(){
      var mid = btn.getAttribute("data-jump-module");
      if (mapRadio) mapRadio.checked = true;
      if (mid) selectModule(mid);
    });
  });

  fitCanvas();
})();`;

function buildInteractiveArchitectureCsp(scriptBody: string): string {
  const scriptSha256 = createHash("sha256").update(scriptBody, "utf8").digest("base64");
  return `default-src 'none'; script-src 'sha256-${scriptSha256}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
}

/**
 * Deterministic SHA-256 CSP for the single-file offline interactive HTML portal:
 * allows ONLY the exact `INTERACTIVE_PORTAL_JS` inline script body (zero
 * `script-src 'unsafe-inline'`); the `<script type="application/json">` data
 * island is non-executable and requires no script execution permission.
 */
export const ARCHITECTURE_INTERACTIVE_CSP =
  buildInteractiveArchitectureCsp(INTERACTIVE_PORTAL_JS);

export function serializeInteractiveArchitectureHtmlFromPrepared(
  prepared: PreparedArchitecture,
): string {
  const { projection, annotations, evidenceCatalog } = prepared;
  const layout = computeArchitectureLayout(projection, annotations);
  const svg = renderArchitectureSvg(projection, layout, {
    interactive: true,
    ...(annotations === undefined ? {} : { annotations }),
  });
  const mermaidText = renderArchitectureMermaidFromPrepared(prepared);
  const pageTitle = safeHtmlText(
    annotations?.title ?? `Causoryn Interactive Architecture — ${projection.meta.workspaceId}`,
    true,
  );

  const langOptions = [
    '<option value="">All languages</option>',
    ...projection.summary.languages.map(
      (l) => `<option value="${escapeHtml(l.language)}">${escapeHtml(l.language)} (${String(l.fileCount)})</option>`,
    ),
  ].join("");

  const dataIsland = escapeJsonForScriptIsland(
    canonicalJson({
      meta: projection.meta,
      modules: projection.modules,
      edges: projection.edges,
      cycles: projection.cycles,
      evidence: evidenceCatalog,
      ...(annotations === undefined ? {} : { annotations }),
    } as never),
  );

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ARCHITECTURE_INTERACTIVE_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${pageTitle}</title>`,
    "<style>",
    PORTAL_BASE_CSS,
    "</style>",
    "</head>",
    "<body>",
    '<input type="checkbox" id="theme-light" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-map" class="sr-only" checked>',
    '<input type="radio" name="arch-tab" id="tab-flows" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-modules" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-risks" class="sr-only">',
    '<input type="radio" name="arch-tab" id="tab-mermaid" class="sr-only">',
    '<div class="portal-shell"><div class="portal-inner">',
    renderHeroSection(prepared, true),
    '<nav class="tab-bar" aria-label="Architecture Views">',
    '<label for="tab-map" class="tab-lbl">Interactive Architecture Map</label>',
    '<label for="tab-flows" class="tab-lbl">Flows &amp; Guided Tour</label>',
    '<label for="tab-modules" class="tab-lbl">Entrypoints &amp; Contracts</label>',
    '<label for="tab-risks" class="tab-lbl">Risks, Cycles &amp; Decisions</label>',
    '<label for="tab-mermaid" class="tab-lbl">Mermaid &amp; Metadata</label>',
    "</nav>",
    "<main>",
    '<div id="panel-map" class="tab-panel">',
    '<div class="toolbar">',
    '<div class="filter-bar">',
    '<input type="search" id="causoryn-search" class="search-input" placeholder="Search modules, symbols, summaries…">',
    `<select id="causoryn-lang-filter" class="filter-select" aria-label="Filter language">${langOptions}</select>`,
    '<label class="ctrl-btn"><input type="checkbox" id="causoryn-cycle-only"> Cycles only</label>',
    '<label class="ctrl-btn"><input type="checkbox" id="causoryn-hide-tests"> Hide tests</label>',
    "</div>",
    '<div class="zoom-group">',
    '<button type="button" id="causoryn-zoom-out" class="ctrl-btn">−</button>',
    '<button type="button" id="causoryn-zoom-fit" class="ctrl-btn">Fit</button>',
    '<button type="button" id="causoryn-zoom-in" class="ctrl-btn">+</button>',
    "</div>",
    "</div>",
    '<div class="inter-grid">',
    '<div>',
    `<div id="causoryn-stage" class="canvas-wrap canvas-stage"><div id="causoryn-stage-inner" class="stage-inner">${svg}</div></div>`,
    `<div style="margin-top:8px">${renderLegendHtml()}</div>`,
    "</div>",
    '<aside id="causoryn-inspector" class="inspector-pane" aria-label="Architecture Inspector">',
    "<h2>Inspector</h2>",
    '<p class="muted">Click any module card or dependency edge on the diagram to inspect its Host-LLM summary, key symbols, 1-hop neighborhood, and source-span Evidence provenance.</p>',
    "</aside>",
    "</div>",
    "</div>",
    `<div id="panel-flows" class="tab-panel">${renderFlowsAndTourHtml(prepared, true)}</div>`,
    `<div id="panel-modules" class="tab-panel">${renderEntrypointsAndContractsHtml(prepared, true)}</div>`,
    `<div id="panel-risks" class="tab-panel">${renderRisksAndDecisionsHtml(prepared, true)}</div>`,
    `<div id="panel-mermaid" class="tab-panel">${renderMermaidAndMetaHtml(prepared, mermaidText, true)}</div>`,
    "</main>",
    "</div></div>",
    `<script type="application/json" id="causoryn-portal-data">${dataIsland}</script>`,
    `<script>${INTERACTIVE_PORTAL_JS}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function serializeInteractiveArchitectureHtml(
  snapshot: SnapshotGraph,
  options?: ArchitectureProjectionOptions,
  annotations?: ArchitectureAnnotations,
): string {
  return serializeInteractiveArchitectureHtmlFromPrepared(
    prepareArchitecture(snapshot, options, annotations),
  );
}
