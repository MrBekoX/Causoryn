---
name: architecture-blueprint
description: Orchestrate the host LLM and Causoryn MCP tools to generate a comprehensive, evidence-grounded visual architecture portal (layered SVG offline HTML, clean renderable Mermaid, Architecture Brief Markdown, and JSON blueprint) with validated domain groupings, module responsibilities, guided flows, and onboarding tours. Use when the user asks for an architecture diagram, system blueprint, visual onboarding guide, or comprehensive architecture documentation.
---

# architecture-blueprint — Host-LLM + Causoryn Visual Architecture Workflow

Causoryn itself is **100% local, deterministic, and LLM-free** — it never calls external
model APIs and never writes to your source repository. Instead, **you (the host LLM)**
discover verified structural facts via Causoryn's MCP tools and pass grounded `annotations`
to `causoryn_export_documentation`, which validates every referenced ID fail-closed and
renders self-contained offline visual diagrams and portals.

## 6-Step Deterministic Architecture Synthesis Protocol

### Step 1: Verify Snapshot Health & Coverage Boundaries
1. Call `causoryn_index_status` to confirm a published snapshot exists (if `INDEX_NOT_READY` or `stale: true`, call `causoryn_refresh_index` and wait until ready).
2. Call `causoryn_workspace_summary` to capture exact languages, analyzed file counts, entrypoints, edge resolution breakdown (`verified` / `heuristic` / `unresolved`), and coverage tier (`L0`/`L1`/`L2`).

### Step 2: Map Modules, Centrality, Entrypoints & Risks
1. Call `causoryn_generate_onboarding` with `audience: "maintainer"` to retrieve deterministic entrypoints, top central modules, learning order (with SCC cycles), critical flows, and risk areas.
2. Call `causoryn_map_system` at `level: "L1"` (and targeted `level: "L2"` / `"L3"` with `filters.pathPrefix` on major subsystems) to inspect module boundaries, controllers, services, and contracts.

### Step 3: Trace Critical Execution & Business Flows + Evidence
1. For the highest-impact endpoints/handlers discovered in Step 2, call `causoryn_trace_business_flow` and/or `causoryn_trace_execution` to map real cross-module call chains.
2. Call `causoryn_get_evidence` on key cross-module boundaries or structural risks to collect verified `evidenceId`s and exact source-span locations (`relativePath:startLine-endLine`).
3. If the repo defines `.causoryn/architecture.rules.yaml`, optionally call `causoryn_check_architecture` to surface policy violations honestly.

### Step 4: Extract Exact Canonical `moduleId`s (Blueprint Pass)
Call `causoryn_export_documentation` with:
- `format: "json"`
- `view: "architecture"`
- `outputDir`: an authorized directory configured in `output.allowedOutputDirs` (typically the workspace's Causoryn exports directory reported by runtime setup, e.g., `<data-dir>/exports`)
- Optional `options`: `{ maxModules: 32, pathPrefix?, includeTests? }`

Inspect the returned `data.architectureSummary.moduleIds` (and the exported JSON blueprint if deeper module/edge/cycle detail is needed). **Every `moduleId` in your annotations MUST come verbatim from `architectureSummary.moduleIds`.**

### Step 5: Synthesize Grounded Host-LLM `annotations`
Build a concise, accurate `annotations` object strictly grounded in Steps 1–4:
- `title`: clear system title
- `architectureStyle`: observed architecture pattern (e.g., `"Clean Architecture + Multi-Service"`)
- `executiveSummary`: 2–4 sentence synthesis covering core subsystems, tech stack, and explicit coverage/unresolved caveats
- `domains`: disjoint logical subsystem/layer clusters (`id`, `name`, `description`, `layer`, `moduleIds[]` — every `moduleId` must belong to at most one domain)
- `moduleNotes`: per-module `summary`, `responsibility`, optional `layer`, and verified `keyFiles[]` (must match real relative file paths in the snapshot)
- `flows`: 2–6 end-to-end business/request flows (`id`, `title`, `description`, `steps[]` with verified `moduleId`/`nodeId`, `label`, `explanation`)
- `guidedTour`: numbered onboarding reading order (`step`, `title`, `targetModuleId`, optional `targetNodeId`, `explanation`)
- `decisions` & `risks`: observed architectural decisions and concrete risks (circular dependencies, fan-in hotspots, unresolved boundaries) linked to verified `relatedModuleIds` and `evidenceIds`

### Step 6: Render the Visual Architecture Pack
Call `causoryn_export_documentation` with the same `options` and your validated `annotations`:
1. **Interactive Offline Portal (recommended for browser exploration):**
   `format: "html"`, `view: "interactive"`, `fileName: "causoryn-architecture-interactive.html"` (layered SVG, mouse-wheel zoom & drag pan, live search, filters, floating Evidence Inspector Drawer, Copy Mermaid — offline CSP, zero CDN, zero `innerHTML`).
2. **Zero-JS Strict-CSP Portal (for restricted viewers / email / static archiving):**
   `format: "html"`, `view: "architecture"`, `fileName: "causoryn-architecture.html"` (layered SVG, CSS tabs & zoom presets, click-to-jump module & evidence cards — 0 `<script>` tags).
3. **Clean Renderable Mermaid Diagram (for GitHub / VS Code / PRs):**
   `format: "mermaid"`, `view: "architecture"`, `fileName: "causoryn-architecture.mmd"` (subgraph-grouped `flowchart TB`, bounded nodes, cycle styling).
4. **Comprehensive Architecture Brief:**
   `format: "markdown"`, `view: "architecture"`, `fileName: "causoryn-architecture.md"` (embedded Mermaid diagram, domains, modules, flows, tour, entrypoints, cycles, decisions, risks).

## Strict Grounding & Error Recovery Rules

- **Zero Fabrication:** Never invent `moduleId`, `nodeId`, `evidenceId`, or `keyFiles` values. Causoryn validates all references fail-closed and rejects unknown IDs with `INVALID_ARGUMENT`.
- **Coverage Honesty:** When `status` is `"partial"` or `externalSummary.nodeCount` / `unresolved` edges are high, state those boundaries explicitly in `executiveSummary` and `risks`.
- **Error Recovery:**
  - `EXPORT_NOT_ALLOWED`: `outputDir` is not in `output.allowedOutputDirs` — use the configured Causoryn exports directory instead of writing inside the source repo.
  - `INVALID_ARGUMENT`: inspect the offending `moduleId` / `nodeId` / `evidenceId` / `keyFile` or `view` combination reported in `error.message`, correct from Step 4's blueprint, and retry once.
  - `PATH_DENIED`: `fileName` must be a plain filename with no path separators (`/` or `\`) or `..`.
- **Raw Audit Dump:** Only pass `view: "full"` (without `options` or `annotations`) when a user explicitly asks for the unfiltered raw node/edge/evidence snapshot dump.
