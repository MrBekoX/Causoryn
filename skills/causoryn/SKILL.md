---
name: causoryn
description: Primary orchestration runbook for the Causoryn local, deterministic, LLM-free codebase and change intelligence MCP server across the Discover, Preflight, Edit, Verify, and Explain workflow. Use before architectural exploration, cross-file refactoring, API/contract changes, or post-edit architectural verification.
---

# causoryn — Deterministic Codebase & Change Intelligence Workflow

Causoryn is a **local, deterministic, LLM-free** static and architectural analysis engine
served over MCP. It **never writes to your source tree** (strictly read-only workspace access;
SQLite snapshots and wiki indexes live only in the authorized Causoryn data root) and every
verified edge carries source-span provenance.

## 5-Stage Engineering Workflow

### 1. Readiness & Snapshot Health
1. Call `causoryn_get_capabilities` once when uncertain about active language adapters (L0–L3), configured limits, or published tools.
2. Call `causoryn_index_status` to check whether a published snapshot exists and whether it is `stale`.
3. If no published snapshot exists (`INDEX_NOT_READY`) or files changed on disk, trigger `causoryn_refresh_index` and poll `causoryn_index_status` with the returned `jobId`.
4. Call `causoryn_workspace_summary` for a fast overview of languages, entrypoints, projects, and edge resolution coverage.

### 2. Discover (Map, Symbols, Flows & Ranked Context)
- **System hierarchy:** Call `causoryn_map_system` (`level`: `"L0"`–`"L3"`, `filters`, `maxNodes`, `cursor`) to map packages, modules, classes, and handlers before reading raw files.
- **Task-focused context:** Call `causoryn_get_agent_context` with your task query to obtain a ranked, budget-bounded context package (`exact-symbol` -> `graph-proximity` -> `contract` -> `freshness` -> `fts`).
- **Symbol inspection:** Locate candidates with `causoryn_find_symbols`, then inspect direct neighbors and incoming/outgoing edges with `causoryn_get_symbol_context`.
- **Call & business flows:** Trace bounded call chains with `causoryn_trace_execution` and cross-component contract/route flows with `causoryn_trace_business_flow`.
- **Provenance:** Inspect exact file/line evidence for any node or edge ID with `causoryn_get_evidence`.

### 3. Preflight (Before Editing Code)
Before modifying shared symbols, endpoints, schemas, or modules:
1. Run `causoryn_preflight_change` with `intent` plus `targetSymbols` and/or `targetFiles` (`candidateOnly` is always `true`; retain the returned `preflightId` for step 5).
2. For deeper blast-radius inspection over reverse edges, call `causoryn_analyze_impact` (note that `certainty` and edge `resolution` remain separate — never claim 100% impact certainty).
3. If OpenAPI, AsyncAPI, JSON Schema, SQL, or Protobuf specs are involved, evaluate compatibility with `causoryn_check_contracts` or revision drift with `causoryn_detect_contract_drift`.
4. To inspect candidate test suites without running them, call `causoryn_derive_test_plan`.

### 4. Edit (Using Host Tools)
Perform code changes with your host environment's own editing and test-runner tools. Causoryn itself never edits source files and never executes test commands.

### 5. Verify & Explain (After Editing Code)
1. Call `causoryn_verify_change` passing the `preflightId` from step 3 (or `baseSnapshot`) to compare the working tree against architecture guard rules (`architecture`), `graph-diff`, and `test-plan`.
2. Run standalone policy checks via `causoryn_check_architecture` (`.causoryn/architecture.rules.yaml`) or git-ref diffs via `causoryn_compare_architecture` and `causoryn_architecture_timeline`.
3. For onboarding, exports, and persistent architecture documentation:
   - Structural onboarding guide: `causoryn_generate_onboarding`
   - Authorized artifact export (`output.allowedOutputDirs` required): `causoryn_export_documentation`
   - Living Wiki (`wiki.dataDbPath` in authorized data root): `causoryn_wiki_build`, `causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links`, `causoryn_wiki_get_versions`, `causoryn_wiki_diff`.

## Envelope & Error Recovery Rules

Every tool returns `{ schemaVersion, requestId, workspaceId, snapshotId, status, coverage, warnings, data, nextCursor }`:
- Always check `status` (`"ok"` | `"partial"` | `"error"`), `coverage`, and `warnings`. When `status` is `"partial"`, state explicitly that results reflect partial coverage or heuristic/gap boundaries.
- On `WORKSPACE_NOT_AUTHORIZED`: ensure the server was started in a project workspace (`--allow-cwd` / MCP `roots`) or an explicit `allowRoots` root is configured.
- On `AMBIGUOUS_SYMBOL`: disambiguate using the returned candidate IDs rather than guessing.
- On `LIMIT_EXCEEDED`: reduce `maxNodes` / `maxDepth` / `maxPaths` and paginate with `nextCursor`.
- Never fabricate symbol IDs, evidence spans, or test execution claims (`not_run` is never `"passed"`).
