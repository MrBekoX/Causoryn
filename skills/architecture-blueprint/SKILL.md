---
name: architecture-blueprint
description: Orchestrate the host LLM and Causoryn MCP tools to generate a comprehensive, evidence-grounded visual architecture portal (interactive offline HTML, layered SVG, Mermaid, Architecture Brief Markdown, and JSON blueprint) with validated domains, module notes, flows, guided onboarding tours, decisions, and risks. Use whenever the user asks in English or Turkish for an architecture diagram, interactive architecture portal, system blueprint, codebase visual map, visual onboarding guide, comprehensive architecture documentation, mimari diyagram, görsel mimari harita, etkileşimli mimari portal, sistem haritası, görsel onboarding rehberi, or mimari dokümantasyon — even if they do not name this skill. Never refuse because Causoryn is LLM-free; YOU are the host LLM who synthesizes annotations from Causoryn MCP evidence.
---

# architecture-blueprint — Host-LLM + Causoryn Visual Architecture Workflow

**Never refuse because Causoryn is LLM-free — YOU are the host LLM.**
Causoryn's analysis and export engine runs locally with zero model calls or embeddings (`ADR-002`).
Its structural export is byte-reproducible for the same published snapshot, view, format,
options, and supplied `annotations`. As the host LLM, you gather verified facts from Causoryn's
MCP tools and synthesize the optional `annotations` payload; Causoryn validates every reference
fail-closed and renders the offline portal into an authorized output directory.
If the user explicitly asks for a purely deterministic / model-free export, simply omit
`annotations` and call `causoryn_export_documentation` directly.

## Architecture Discovery and Export

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
Determine an authorized `outputDir` configured in `output.allowedOutputDirs` (when started with `--auto-data-dir`, Causoryn automatically authorizes `<data-dir>/workspaces/<slug>-<hash12>/exports`, e.g., `~/.causoryn/workspaces/<slug>-<hash12>/exports` — inspect `~/.causoryn/workspaces/` or `$ZCODE_PLUGIN_DATA/workspaces/` for the matching `<slug>-<hash12>/exports` folder, or inspect the server's `CAUSORYN_CONFIG` `output.allowedOutputDirs`).
Call `causoryn_export_documentation` with:
- `format: "json"`
- `view: "architecture"`
- `outputDir`: authorized export directory
- Optional `options`: `{ maxModules: 32, pathPrefix?, includeTests? }`

Inspect the returned `data.architectureSummary.moduleIds` (and the exported JSON blueprint if deeper module/edge/cycle detail is needed). **Every `moduleId` in your annotations MUST come verbatim from `architectureSummary.moduleIds`.**

### Step 5: Synthesize Grounded Host-LLM `annotations`
Build a concise, accurate `annotations` object strictly grounded in Steps 1–4:
- `title`: clear system title
- `architectureStyle`: observed architecture pattern (e.g., `"Clean Architecture + Multi-Service"`)
- `executiveSummary`: 2–4 sentence synthesis covering core subsystems, tech stack, and explicit coverage/unresolved caveats
- `domains`: disjoint logical subsystem/layer clusters (`id`, `name`, `description`, `layer`, `moduleIds[]` — every `moduleId` must belong to at most one domain)
- `moduleNotes`: per-module `summary`, `responsibility`, optional `layer`, and verified `keyFiles[]` (must match real relative file paths belonging to that module in the Step 4 blueprint)
- `flows`: 2–6 end-to-end business/request flows (`id`, `title`, `description`, `steps[]` with verified `moduleId`/`nodeId`, `label`, `explanation`)
- `guidedTour`: numbered onboarding reading order (`step`, `title`, `targetModuleId`, optional `targetNodeId`, `explanation`)
- `decisions` & `risks`: observed architectural decisions and concrete risks (circular dependencies, fan-in hotspots, unresolved boundaries) linked to verified `relatedModuleIds` and `evidenceIds`

### Step 6: Render the Visual Architecture Pack
Call `causoryn_export_documentation` with the same `options` and your validated `annotations`:
1. **Interactive Offline Portal (recommended for browser exploration):**
   `format: "html"`, `view: "interactive"` (defaults automatically to `fileName: "causoryn-architecture-interactive.html"` so it does not overwrite the static zero-JS portal; layered SVG, mouse-wheel zoom & drag pan, live search, filters, floating Evidence Inspector Drawer, Copy Mermaid — offline CSP, zero CDN, zero `innerHTML`).
2. **Zero-JS Strict-CSP Portal (for restricted viewers / email / static archiving):**
   `format: "html"`, `view: "architecture"` (defaults to `fileName: "causoryn-architecture.html"`; layered SVG, CSS tabs & zoom presets, click-to-jump module & evidence cards — 0 `<script>` tags).
3. **Clean Renderable Mermaid Diagram (for GitHub / VS Code / PRs):**
   `format: "mermaid"`, `view: "architecture"` (defaults to `fileName: "causoryn-architecture.mmd"`; subgraph-grouped `flowchart TB`, bounded nodes, cycle styling).
4. **Comprehensive Architecture Brief:**
   `format: "markdown"`, `view: "architecture"` (defaults to `fileName: "causoryn-architecture.md"`; embedded Mermaid diagram, domains, modules, flows, tour, entrypoints, cycles, decisions, risks).

## Strict Grounding & Error Recovery Rules

- **Zero Fabrication:** Never invent `moduleId`, `nodeId`, `evidenceId`, or `keyFiles` values. Causoryn validates all references fail-closed and rejects unknown IDs with `INVALID_ARGUMENT`.
- **Coverage Honesty:** When `status` is `"partial"` or `externalSummary.nodeCount` / `unresolved` edges are high, state those boundaries explicitly in `executiveSummary` and `risks`.
- **Error Recovery:**
  - `EXPORT_NOT_ALLOWED`: the server has no authorized export directory for this request. Set `output.allowedOutputDirs` or use the `--auto-data-dir` exports directory.
  - `INVALID_ARGUMENT`: inspect the offending `moduleId` / `nodeId` / `evidenceId` / `keyFile` or `view` combination reported in `error.message`, correct from Step 4's blueprint, and retry once.
  - `PATH_DENIED`: check for unsafe paths, including symlink escapes. Use a plain `fileName` with no path separators (`/` or `\`) or parent traversal.
- **Raw Audit Dump:** Only pass `view: "full"` (without `options` or `annotations`) when a user explicitly asks for the unfiltered raw node/edge/evidence snapshot dump.
