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
1. Call `causoryn_status` (or legacy `causoryn_index_status` + `causoryn_workspace_summary`) to confirm a published snapshot exists (if indexing is pending or `stale: true`, call `causoryn_status` with `action: "refresh"` and wait until ready).
2. Capture exact languages, analyzed file counts, entrypoints, per-language `coverage.byLanguage` tiers (`L0`/`L1`/`L2`), and edge resolution breakdown (`verified` / `heuristic` / `unresolved`).

### Step 2: Map Modules, Centrality, Entrypoints & Risks
1. Call `causoryn_map_system` with `profile: "onboarding"` and `audience: "maintainer"` (or legacy `causoryn_generate_onboarding`) to retrieve deterministic entrypoints, top central modules, learning order (with SCC cycles), critical flows, and risk areas.
2. Call `causoryn_map_system` at `level: "L1"` (and targeted `level: "L2"` / `"L3"` with `filters.pathPrefix` on major subsystems) to inspect module boundaries, controllers, services, and contracts.

### Step 3: Trace Critical Execution & Business Flows + Evidence
1. For the highest-impact endpoints/handlers discovered in Step 2, call `causoryn_trace` (`mode: "business-flow"` and/or `mode: "execution"`) to map real cross-module call chains.
2. Call `causoryn_get_evidence` on key cross-module boundaries or structural risks to collect verified `evidenceId`s and exact source-span locations (`relativePath:startLine-endLine`).
3. If the repo defines `.causoryn/architecture.rules.yaml`, optionally call `causoryn_verify_change` with `checks: ["architecture"]` to surface policy violations honestly.

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

## Full `annotations` JSON Schema & Walkthrough Example

Causoryn validates every field in `annotations` strictly (`strictObject`, fail-closed) against both length/array limits and real snapshot IDs. Unknown keys or unverified IDs are rejected with `INVALID_ARGUMENT`.

### Field Reference & Resource Limits

| Top-level Field | Type & Limit | Description |
|---|---|---|
| `title` | `string` (1–160 chars, optional) | Custom portal / brief title summarizing the target system. |
| `architectureStyle` | `string` (1–120 chars, optional) | Observed pattern label (e.g., `"Modular Monolith"`, `"Clean Architecture + Microservices"`). |
| `executiveSummary` | `string` (1–2,000 chars, optional) | 2–4 sentence synthesis covering core subsystems, stack, and coverage/unresolved caveats. |
| `domains[]` | `array` (max 24, optional) | Disjoint logical subsystem/layer clusters: `{ id (<=80), name (<=120), description (<=1200), layer? (<=80), moduleIds (1..100, verbatim from architectureSummary.moduleIds; each moduleId may appear in at most one domain) }`. |
| `moduleNotes[]` | `array` (max 120, optional) | Per-module explanation cards: `{ moduleId (verbatim), summary (<=1200), responsibility? (<=240), layer? (<=80), keyFiles? (max 12 verified relative file paths belonging to THIS module) }`. |
| `flows[]` | `array` (max 20, optional) | End-to-end traced execution or business flows: `{ id (<=80), title (<=160), description (<=1200), steps (1..24 of { moduleId?, nodeId?, label (<=160), explanation (<=1200) }) }`. |
| `guidedTour[]` | `array` (max 30, optional) | Numbered onboarding walkthrough stops: `{ step (int 1..1000), title (<=160), targetModuleId?, targetNodeId?, explanation (<=1200) }`. |
| `decisions[]` | `array` (max 24, optional) | Observed architectural decisions: `{ id (<=80), title (<=160), summary (<=1200), rationale? (<=1200), relatedModuleIds? (max 24), evidenceIds? (max 24 verified evidenceIds) }`. |
| `risks[]` | `array` (max 24, optional) | Concrete structural or coverage risks: `{ id (<=80), title (<=160), severity ("low" \| "medium" \| "high"), summary (<=1200), relatedModuleIds? (max 24), evidenceIds? (max 24 verified evidenceIds) }`. |

### Copy-Pasteable Walkthrough Example

```json
{
  "format": "html",
  "view": "interactive",
  "outputDir": "/abs/path/to/authorized/exports",
  "options": {
    "maxModules": 32,
    "includeTests": true
  },
  "annotations": {
    "title": "Orders Platform Architecture",
    "architectureStyle": "Layered Modular Monolith",
    "executiveSummary": "TypeScript service exposing HTTP order endpoints backed by a domain service and repository layer. All internal CALLS edges are verified; external runtime helpers remain unresolved and are marked explicitly.",
    "domains": [
      {
        "id": "api",
        "name": "HTTP Entrypoints",
        "description": "Route registration and request dispatch layer.",
        "layer": "Presentation",
        "moduleIds": ["mod:src/routes"]
      },
      {
        "id": "core-orders",
        "name": "Orders Domain",
        "description": "Order creation business rules and persistence boundary.",
        "layer": "Application",
        "moduleIds": ["mod:src/services", "mod:src/repositories"]
      }
    ],
    "moduleNotes": [
      {
        "moduleId": "mod:src/services",
        "summary": "Orchestrates order validation and delegates persistence to OrderRepository.",
        "responsibility": "Order creation workflow",
        "layer": "Application",
        "keyFiles": ["src/services/orders-service.ts"]
      }
    ],
    "flows": [
      {
        "id": "create-order",
        "title": "POST /orders Lifecycle",
        "description": "Traces order creation from HTTP entrypoint to repository persistence.",
        "steps": [
          {
            "moduleId": "mod:src/routes",
            "label": "Dispatch POST /orders",
            "explanation": "Express/Router handler invokes createOrdersRoute."
          },
          {
            "moduleId": "mod:src/services",
            "label": "Validate & create order",
            "explanation": "OrdersService.create validates payload and invokes OrderRepository.save."
          }
        ]
      }
    ],
    "guidedTour": [
      {
        "step": 1,
        "title": "Start at HTTP routes",
        "targetModuleId": "mod:src/routes",
        "explanation": "Begin here to see every public endpoint wired into the service."
      },
      {
        "step": 2,
        "title": "Follow business logic",
        "targetModuleId": "mod:src/services",
        "explanation": "Review core domain orchestration and outgoing repository calls."
      }
    ],
    "decisions": [
      {
        "id": "DEC-01",
        "title": "Repository abstraction boundary",
        "summary": "Services call OrderRepository.save rather than directly touching storage drivers.",
        "rationale": "Keeps domain logic decoupled from persistence implementation.",
        "relatedModuleIds": ["mod:src/services", "mod:src/repositories"],
        "evidenceIds": []
      }
    ],
    "risks": [
      {
        "id": "RISK-01",
        "title": "Unresolved external helpers",
        "summary": "Standard library and dynamic helper calls terminate at unresolved edges.",
        "severity": "low",
        "relatedModuleIds": ["mod:src/services"],
        "evidenceIds": []
      }
    ]
  }
}
```

## Strict Grounding & Error Recovery Rules

- **Zero Fabrication:** Never invent `moduleId`, `nodeId`, `evidenceId`, or `keyFiles` values. Causoryn validates all references fail-closed and rejects unknown IDs with `INVALID_ARGUMENT`.
- **Coverage Honesty:** When `status` is `"partial"` or `externalSummary.nodeCount` / `unresolved` edges are high, state those boundaries explicitly in `executiveSummary` and `risks`.
- **Error Recovery:**
  - `EXPORT_NOT_ALLOWED`: the server has no authorized export directory for this request. Set `output.allowedOutputDirs` or use the `--auto-data-dir` exports directory.
  - `INVALID_ARGUMENT`: inspect the offending `moduleId` / `nodeId` / `evidenceId` / `keyFile` or `view` combination reported in `error.message`, correct from Step 4's blueprint, and retry once.
  - `PATH_DENIED`: check for unsafe paths, including symlink escapes. Use a plain `fileName` with no path separators (`/` or `\`) or parent traversal.
- **Raw Audit Dump:** Only pass `view: "full"` (without `options` or `annotations`) when a user explicitly asks for the unfiltered raw node/edge/evidence snapshot dump.
