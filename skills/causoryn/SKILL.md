---
name: causoryn
description: Primary orchestration runbook for the Causoryn local, deterministic, LLM-free codebase and change intelligence MCP server across the Discover, Preflight, Edit, Verify, and Explain workflow — including routing visual architecture diagram and interactive architecture portal requests to architecture-blueprint. Use before architectural exploration, visual architecture generation, cross-file refactoring, API/contract changes, or post-edit architectural verification.
---

# causoryn — Deterministic Codebase & Change Intelligence Workflow

Causoryn is a **local, deterministic, LLM-free** static and architectural analysis engine
served over MCP across TypeScript/JavaScript (ESM & CommonJS, `tsconfig.json`/`jsconfig.json`),
C# (Roslyn), Python, Go, and Rust. Analysis reads workspace files, and every verified edge
carries source-span provenance. SQLite snapshots and wiki indexes use the authorized data root
outside the workspace. Artifact writes require a separately authorized output directory. The
automatic data directory places exports outside the source tree. Repeatable analysis requires
the same workspace inputs, effective configuration, and available toolchains. For exports, keep
the published snapshot and export arguments fixed. Optional `annotations` are caller-supplied
text synthesized by the host LLM — omit them to export directly from the graph without a model.

## Tool Surface (default `core` profile)

`causoryn setup` registers the server without `--tool-profile` unless it is run with
`--tool-profile <list>`, so by default the host sees the `core` profile: exactly the 11 tools
below. Call only these tools by default.

| Tool | Use it for |
| --- | --- |
| `causoryn_status` | Capabilities, workspace summary, and index/job state (`action: "inspect"`, default), or queue a re-index (`action: "refresh"`). |
| `causoryn_map_system` | Architecture map by level (`L0`–`L3`), or `profile: "onboarding"` for entrypoints, central modules, learning order, and risk areas. |
| `causoryn_find_symbols` | Find symbols by exact, prefix, or substring name match. |
| `causoryn_get_symbol_context` | One symbol with its neighbor edges and source-span evidence. |
| `causoryn_trace` | Call paths (`mode: "execution"`, default) or cross-component flows (`mode: "business-flow"`). |
| `causoryn_get_agent_context` | Ranked, budget-bounded context for a task (`task` and `tokenBudget` are required). |
| `causoryn_preflight_change` | Pre-edit manifest with impact candidates and a test plan; `include: ["impact"]` or `include: ["test-plan"]` for focused results. |
| `causoryn_verify_change` | Post-edit verification (architecture rules, graph diff, test plan); `checks: ["architecture"]` alone runs a standalone rule check. |
| `causoryn_contracts` | Contract compatibility (`action: "check"`, default) or drift (`action: "drift"`). |
| `causoryn_get_evidence` | Source-span provenance for a node, edge, evidence, or finding ID. |
| `causoryn_export_documentation` | Export the snapshot (JSON, Markdown, Mermaid, HTML) into an authorized output directory. |

`data.capabilities.tools` in the `causoryn_status` response lists the tools that are actually
active. Never call a tool that is missing from that list: the server answers `Tool <name> not found`.

### Optional profiles (off by default)

- Architecture history: `causoryn_compare_architecture` (diff two git refs) and `causoryn_architecture_timeline` (evolution across refs) require `--tool-profile history` (also part of `--tool-profile full`).
- Living Wiki: `causoryn_wiki_build`, `causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links`, `causoryn_wiki_get_versions`, and `causoryn_wiki_diff` require `--tool-profile wiki` plus `wiki.dataDbPath` in the authorized data root.
- To enable a profile, add it to the `causoryn mcp` arguments of the host's MCP server entry (for example `--tool-profile history`, or a comma-separated combination such as `--tool-profile wiki,history`), or set the `CAUSORYN_TOOL_PROFILE` environment variable in that entry, then restart the host. `causoryn setup --tool-profile <list>` (for example `causoryn setup --tool-profile history`) writes the flag for every configured host; re-running `causoryn setup` without the flag keeps the profile, `env`, and other keys already in the entry.
- Call an optional tool only after `data.capabilities.tools` lists it; otherwise tell the user which profile is needed instead of calling it.
- Older prompts may name legacy tools such as `causoryn_index_status` or `causoryn_analyze_impact`; those exist only under `--tool-profile full`. Use the core tool from the table above instead.

## 5-Stage Engineering Workflow

### 1. Readiness & Snapshot Health
1. Call `causoryn_status` `{"action": "inspect"}` once. Read `data.capabilities` (language adapters and their L0–L3 levels, server limits, active `tools`), `data.index.latestSnapshot` (`snapshotId`, `stale`), `data.index.job` (`status`, `progressPercent`), and `data.summary` (languages, file counts, entrypoints, edge `resolutions`).
2. With `deferAutoIndex`, indexing may start lazily on the first snapshot-dependent call or an explicit refresh. While `data.indexing` is `true`, wait `data.retryAfterMs` and poll `causoryn_status` `{"action": "inspect", "jobId": "<jobId>"}` until the job reaches a terminal status: `done` (a new snapshot was published), `reused` (nothing changed, or a concurrent build already published an identical snapshot — keep using it) or `failed` (read its error).
3. If no snapshot is published (`INDEX_NOT_READY`) and no job is active, or `data.index.latestSnapshot.stale` is `true`, call `causoryn_status` `{"action": "refresh", "mode": "incremental"}` and poll the returned `data.jobId` as in step 2.

### 2. Discover (Map, Symbols, Flows & Ranked Context)
- **System hierarchy:** `causoryn_map_system` `{"level": "L2"}` maps packages, modules, classes, and handlers before you read raw files. Narrow with `filters` (`kinds`, `pathPrefix`) and page with `maxNodes` and `cursor`.
- **Task-focused context:** `causoryn_get_agent_context` `{"task": "<task or symbol query>", "tokenBudget": 4000}` returns a ranked, budget-bounded context package (`exact-symbol` -> `graph-proximity` -> `contract` -> `freshness` -> `fts`).
- **Symbol inspection:** locate candidates with `causoryn_find_symbols` `{"query": "<name>"}`, then inspect neighbors and incoming/outgoing edges with `causoryn_get_symbol_context` `{"symbolId": "<node id or exact qualifiedName>"}`.
- **Call flows:** `causoryn_trace` `{"mode": "execution", "entrypoint": "<node id, symbol, or endpoint>"}` traces bounded call chains.
- **Business flows:** `causoryn_trace` `{"mode": "business-flow", "entrypoint": "<seed symbol or endpoint>"}` traces cross-component route, event, and contract flows; gaps are reported as gap segments.
- **Provenance:** `causoryn_get_evidence` `{"id": "<node, edge, evidence, or finding id>"}` returns exact file/line evidence.

### 3. Preflight (Before Editing Code)
Before modifying shared symbols, endpoints, schemas, or modules:
1. Call `causoryn_preflight_change` `{"intent": "<planned change>", "targetSymbols": ["<symbol>"]}` (use `targetFiles` for workspace-relative paths). Keep the returned `preflightId` for stage 5; `candidateOnly` is always `true`.
2. For reverse-dependency impact paths only, call `causoryn_preflight_change` `{"include": ["impact"], "targetSymbols": ["<symbol>"]}`. `certainty` and edge `resolution` stay separate fields — never claim 100% impact certainty.
3. For the candidate test plan of an existing preflight, call `causoryn_preflight_change` `{"include": ["test-plan"], "preflightId": "<preflightId>"}` (the full preflight in step 1 already embeds it as `testPlan`).
4. If OpenAPI, AsyncAPI, JSON Schema, SQL, or Protobuf specs are involved, check compatibility with `causoryn_contracts` `{"action": "check", "contracts": [{"base": "<old spec path>", "target": "<new spec path>"}]}`.
5. For revision drift with producer/consumer impact, call `causoryn_contracts` `{"action": "drift", "base": ["<old spec path>"], "target": ["<new spec path>"]}`.

### 4. Edit (Using Host Tools)
Perform code changes with your host environment's own editing and test-runner tools. Causoryn itself never edits source files and never executes test commands.

### 5. Verify & Explain (After Editing Code)
1. Call `causoryn_verify_change` `{"preflightId": "<preflightId>"}` (or pass `baseSnapshot`) to compare the working tree against architecture guard rules (`architecture`), `graph-diff`, and `test-plan`.
2. For a standalone policy check of `.causoryn/architecture.rules.yaml` against the latest snapshot, call `causoryn_verify_change` `{"checks": ["architecture"]}`.
3. Git-ref architecture diffs and timelines belong to the optional history profile (see "Optional profiles"); do not call them unless `data.capabilities.tools` lists them.
4. For onboarding, visual architecture portals, and exports:
   - Structural onboarding guide: `causoryn_map_system` `{"profile": "onboarding", "audience": "maintainer"}`.
   - Visual architecture diagrams & interactive portals (`output.allowedOutputDirs` required): whenever the user asks for an architecture diagram, interactive architecture portal, system blueprint, or visual onboarding guide (in English or Turkish), follow the `architecture-blueprint` skill with `causoryn_export_documentation`. It defaults to `view: "architecture"` (zero-JS layered SVG HTML, clean Mermaid, Architecture Brief Markdown, compact JSON blueprint with `architectureSummary.moduleIds`), supports `view: "interactive"` (pan/zoom/search/evidence drawer, default filename `causoryn-architecture-interactive.html`) with optional Host-LLM `annotations` validated fail-closed (or omit `annotations` for pure structural export), and `view: "full"` for raw audit dumps.

## Envelope & Error Recovery Rules

Every tool returns `{ schemaVersion, requestId, workspaceId, snapshotId, status, coverage, warnings, data, nextCursor, error }`:
- Always check `status` (`"ok"` | `"partial"` | `"error"`), `coverage`, and `warnings`. When `status` is `"partial"`, state explicitly that results reflect partial coverage or heuristic/gap boundaries.
- On `Tool <name> not found`: the tool is not in the active profile. Switch to the core tool from the table above; never retry the missing name.
- On `WORKSPACE_NOT_AUTHORIZED`: ensure the server was started in a project workspace (`--allow-cwd` / MCP `roots`) or an explicit `allowRoots` root is configured.
- On `AMBIGUOUS_SYMBOL`: disambiguate using the returned candidate IDs rather than guessing.
- On `LIMIT_EXCEEDED`: reduce `maxNodes` / `maxDepth` / `maxPaths` and paginate with `nextCursor`.
- Never fabricate symbol IDs, evidence spans, or test execution claims (`not_run` is never `"passed"`).
