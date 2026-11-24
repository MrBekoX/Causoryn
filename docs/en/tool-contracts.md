# MCP Tool Contracts — Core & Extension Profiles

> **Language:** [Türkçe](../tool-contracts.md) | **English** · [Documentation Hub](README.md)
>
> **Authoritative source:** `packages/mcp-server/src/version.ts` (`CORE_TOOL_NAMES`, `WIKI_TOOL_NAMES`, `HISTORY_TOOL_NAMES`, `TOOL_NAMES`), `packages/mcp-server/src/schemas.ts`, `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/errors.ts`, and `packages/mcp-server/src/runtime-cli.ts`.

This reference documents Causoryn's MCP tool profiles, standard response envelope, fixed error catalog, and write-permission matrix. The authoritative wire contract is defined in source via each tool's Zod input and output schemas (enforced server-side in all modes, regardless of `outputSchemaProfile`).

---

## Tool Profiles (`--tool-profile` & `CAUSORYN_TOOL_PROFILE`)

To keep agent context windows lean and tool selection accurate, Causoryn defaults to the **11-tool `core` profile** (`tools/list <= 15,000` characters). Select profiles via `--tool-profile <value>` or the `CAUSORYN_TOOL_PROFILE` environment variable (`--tool-profile` takes precedence):

| Profile | Registered Tools | Notes |
|---|---|---|
| `core` *(default)* | **11 tools** (`CORE_TOOL_NAMES`) | Consolidated everyday surface (`tools/list <= 15K` chars, concise 1-line English `.describe()` on every input field, `outputSchemaProfile: "omit"` by default) |
| `wiki` | **18 tools** (`11 core + 7 wiki`) | Adds the 7 Living Wiki tools (`WIKI_TOOL_NAMES`) |
| `history` | **13 tools** (`11 core + 2 history`) | Adds `causoryn_compare_architecture` and `causoryn_architecture_timeline` (`HISTORY_TOOL_NAMES`) |
| `wiki,history` | **20 tools** (`11 core + 7 wiki + 2 history`) | Comma-separated profile combination |
| `full` | **32 tools** (`29 legacy + 3 consolidated`) | Backward-compatible catalog preserving all 29 legacy tool names (with deprecation warnings pointing to their consolidated `core` replacements) alongside `causoryn_status`, `causoryn_trace`, and `causoryn_contracts` |

---

## Standard Envelope & Per-Language Coverage

Every tool returns the strict 10-field `EnvelopeSchema` (`packages/mcp-server/src/envelope.ts`):

1. `schemaVersion` (`"2.0"`)
2. `requestId` (string correlation ID from the MCP request)
3. `workspaceId` (`string | null`)
4. `snapshotId` (`string | null` — `GraphSnapshot` ID for core tools; served `WikiSnapshot` ID for Wiki tools)
5. `status` (`"ok" | "partial" | "error"`)
6. `coverage` (`{ tier: "L0"|"L1"|"L2"|"L3"|"L4", resolvedEdges, unresolvedEdges, totalEdges, coverageRatio, byLanguage? } | null`)
   - **`coverage.byLanguage`** reports per-language `{ tier, files, verifiedEdges, heuristicEdges, unresolvedEdges, coverageRatio }` (sorted keys) so strong TypeScript coverage never hides `L0` fallback in C#, Python, Go, or Rust.
7. `warnings` (`string[]`)
8. `data` (tool payload, candidate list on `AMBIGUOUS_SYMBOL`, structured `{ indexing: true, status: "indexing", jobId, progress: { phase, completed, total }, retryAfterMs }` during cold-start indexing, or `null` on errors)
9. `nextCursor` (`string | null`)
10. `error` (`null` when `status` is `"ok"` or `"partial"`; `{ code, message, retryable, userAction }` when `status` is `"error"`)

Domain and authorization errors travel inside `envelope.error` (`isError: false`), never as unhandled protocol crashes. Every tool declares MCP `annotations` (`readOnlyHint`, `destructiveHint: false`, `openWorldHint: false`). `stdout` carries exclusively MCP JSON-RPC frames; operational logs go to `stderr` prefixed with `[causoryn]`.

During cold-start background indexing, clients passing `_meta.progressToken` receive live MCP `notifications/progress` updates from the indexing `worker_threads` worker. If the bounded wait window (`CAUSORYN_INDEX_WAIT_MS`, default `15,000` ms) expires before indexing completes, snapshot-dependent tools return a structured `{ indexing: true, status: "indexing", jobId, progress, retryAfterMs }` payload instead of crashing.

---

## Default Core Profile (11 Tools — `--tool-profile core`)

| Tool | `readOnlyHint` | Inputs (primary fields) | Output (`data` summary) | Typical error codes |
|---|---|---|---|---|
| `causoryn_status` | `false` | `action?` (`"inspect"` [default] \| `"refresh"`), `mode?` (`"incremental"` \| `"full"`), `jobId?`, `workspace?`, `workspaceId?` | In `inspect` mode: combines capabilities, active tool list, authorization state, index job progress/freshness, and workspace summary (including `coverage.byLanguage`). In `refresh` mode: queues a non-blocking incremental or full `worker_threads` build and returns `jobId` immediately. | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_map_system` | `true` | `profile?` (`"default"` \| `"onboarding"`), `level?` (`L0`–`L3`, default `L2`), `filters?` (`kinds`, `pathPrefix`), `maxNodes?`, `cursor?`, `audience?` (`beginner`\|`intermediate`\|`maintainer`), `limits?` | In `default` profile: paginated, deterministically ordered node + edge map. In `onboarding` profile: entrypoints, central modules, topological learning order (SCC-collapsed), critical flows, tests, and risk areas. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_find_symbols` | `true` | `query`, `kind?`, `limit?`, `workspaceId?` | Ranked exact / prefix / substring lookup over `qualifiedName`; excludes `UnknownExternal` placeholders from ambiguity candidates whenever real project symbols (`Function`/`Class`/`Method`/`Interface`) match. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_symbol_context` | `true` | `symbolId` (node ID or exact `qualifiedName`), `edgeKinds?`, `depth?`, `workspaceId?` | Target symbol node, deterministically ordered neighbor edges up to `depth`, and backing source-span evidence records. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_trace` | `true` | `mode?` (`"execution"` [default] \| `"business-flow"`), `entrypoint?` / `flowSeed?`, `maxDepth?` (default `6`, clamped), `maxPaths?` (default `25`, clamped), `boundaries?`, `maxHops?`, `maxFlows?`, `maxNodes?` | In `execution` mode: bounded call/route chains over `CALLS` + `ROUTES_TO` with per-edge resolution and evidence (halts at `unresolved`). In `business-flow` mode: cross-component request/event/contract flows with honest `gap` segments. Oversized `maxDepth`/`maxPaths` are clamped with warnings rather than failing. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_get_agent_context` | `true` | `task`, `tokenBudget` (required), `maxProximityDepth?`, `workspaceId?` | Ranked, budget-bounded code localization combining path + `camelCase`/`PascalCase`/`snake_case`/`kebab-case` tokenization, SQLite FTS5 BM25 + structural degree ranking, graph proximity (excluding `Workspace --CONTAINS--> File` noise), contract, and freshness legs. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_preflight_change` | `true` | `intent?`, `targetSymbols?`, `targetFiles?`, `include?` (`["impact", "test-plan"]`), `baseSnapshot?`, `preflightId?`, `edgeKinds?`, `maxDepth?`, `maxPaths?`, `maxNodes?`, `maxCandidates?` | Candidate-only pre-change manifest (`candidateOnly: true`, zero disk writes; cached in in-process `PreflightManifestStore`): reverse-BFS impact candidates (excluding `CONTAINS`, including `INHERITS`/`IMPLEMENTS` with deduplicated `evidenceMap`), contract checks, and content-addressed candidate `testPlanId`. Supports focused `include: ["impact"]` or `["test-plan"]` queries. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_verify_change` | `true` | `preflightId?` / `baseSnapshot?`, `baseRef?` (trusted Git ref for rules, default `HEAD`), `targetRevision?` (`"working-tree"`), `checks?` (default `["architecture", "graph-diff", "test-plan"]`; `"contracts"` opt-in), `observedTestRun?` | Byte-deterministic post-change verification across all languages (`runIndexAsync`), loading `.causoryn/architecture.rules.yaml` and `architecture.baseline.yaml` from trusted Git `baseRef` (adding `trustWarning` if read from an untrusted working tree). Verdict: `no_findings` \| `review_required` \| `blocking_findings` \| `inconclusive`. Host-supplied test runs are always recorded as `state: "host_asserted"` with `engineVerified: false`. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `POLICY_INVALID` |
| `causoryn_contracts` | `true` | `action?` (`"check"` [default] \| `"drift"`), `contracts?` (`{name?, base, target}`), `snapshotId?`, `base?`, `target?`, `scope?`, `anchorFiles?` | In `check` mode: static compatibility classification (`backward-safe` \| `risk` \| `breaking_candidate` \| `unknown`) across OpenAPI, AsyncAPI, JSON Schema, SQL DDL, and Protobuf pairs. In `drift` mode: revision-to-revision drift and producer/consumer anchor impact. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_get_evidence` | `true` | `id` (`nodeId`, `edgeId`, `evidenceId`, or `finding:<sha256>`), `workspaceId?` | Source file, 1-based line span, SHA-256 `sourceHash`, analyzer provenance, rationale, and deterministic evidence chain summary. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_export_documentation` | `false` | `format` (`json`\|`markdown`\|`mermaid`\|`html`\|`snapshot`), `outputDir`, `fileName?`, `view?` (`architecture` [default] \| `interactive` [HTML only] \| `full`), `options?` (`maxModules`, `pathPrefix`, `includeTests`), `annotations?` | Deterministic offline architecture portal or snapshot export written atomically (`flag: "wx"` + rename) strictly inside `output.allowedOutputDirs`. Interactive HTML (`causoryn-architecture-interactive.html`) enforces deterministic `script-src 'sha256-...'` CSP; invalid `annotations` collect up to 25 schema + graph-reference errors in a single pass. | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EXPORT_NOT_ALLOWED`, `PATH_DENIED` |

---

## Full Profile: Core & Legacy Tools (22 Tools — `--tool-profile full`)

Under `--tool-profile full`, Causoryn preserves every legacy tool name for backward compatibility alongside the 3 consolidated core dispatchers (`causoryn_status`, `causoryn_trace`, `causoryn_contracts` — 32 tools total). Superseded tools return identical data with a deprecation warning pointing to their consolidated replacement:

| Tool | Inputs (primary fields) | Output (`data` summary) | Typical error codes |
|---|---|---|---|
| `causoryn_get_capabilities` | `workspace?` | Adapter capability tiers L0–L4 across 5 languages, server identity (`0.2.4`, schema `2.0`), limits, and active tool names *(superseded by `causoryn_status`)* | `WORKSPACE_NOT_AUTHORIZED` |
| `causoryn_workspace_summary` | `workspaceId?` | Project, language, framework, entrypoint, and coverage summary from the latest published snapshot *(superseded by `causoryn_status`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_index_status` | `jobId?` | Snapshot ID, `stale` flag, and bounded diagnostics/warnings (50-entry cap) for the latest or requested job *(superseded by `causoryn_status`)* | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_refresh_index` | `mode` (`full` \| `incremental` — backed by `file_facts` early-cutoff caching), `scope?` (rejected) | Queues non-blocking `worker_threads` indexing into the shared external SQLite store and returns `jobId` immediately *(superseded by `causoryn_status` `action="refresh"`)* | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_map_system` | `level` (`L0`–`L3`), `filters?`, `maxNodes?`, `cursor?`, `profile?` | Paginated L0–L3 architecture map (or onboarding guide when `profile="onboarding"`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_find_symbols` | `query`, `kind?`, `limit?` | Ranked symbol search with disambiguation candidates (excluding `UnknownExternal` noise when real symbols match) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_symbol_context` | `symbolId`, `edgeKinds?`, `depth?` | Target symbol node + ordered neighbor edges + evidence records | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_trace_execution` | `entrypoint`, `maxDepth?` (clamped), `maxPaths?` (clamped) | Bounded `CALLS` + `ROUTES_TO` execution chains with per-edge resolution and evidence *(superseded by `causoryn_trace`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_trace_business_flow` | `flowSeed`, `boundaries?` | End-to-end business and contract flow chains with honest `gap` segments *(superseded by `causoryn_trace` `mode="business-flow"`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `INVALID_REVISION`, `CONTRACT_PARSE_FAILED` |
| `causoryn_analyze_impact` | `targets`, `depth?`, `edgeKinds?` | Reverse-edge BFS impact paths (excluding `CONTAINS`, including `INHERITS`/`IMPLEMENTS`, deduplicated `evidenceMap`) *(superseded by `causoryn_preflight_change`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID` |
| `causoryn_check_architecture` | `policyId?`, `scope?` | Evaluates `.causoryn/architecture.rules.yaml` (`no-cycles` SCC + `forbidden-dependency`) + baseline suppressions *(superseded by `causoryn_verify_change`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID`, `INVALID_REVISION` |
| `causoryn_compare_architecture` | `baseRef`, `targetRef` | Architectural diff across two Git refs (supporting `HEAD~N`/`HEAD^`) or `working-tree` via read-only Git blob reads *(also available via `--tool-profile history`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |
| `causoryn_get_agent_context` | `task`, `candidateScope?`, `tokenBudget` | Budget-bounded code localization across path/identifier FTS5 BM25, graph proximity, contract, and freshness legs | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_generate_onboarding` | `audience` (`beginner`\|`intermediate`\|`maintainer`) | Structured onboarding guide (entrypoints, central modules, topological learning order, risks) *(superseded by `causoryn_map_system` `profile="onboarding"`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_export_documentation` | `format`, `outputDir`, `fileName?`, `view?`, `options?`, `annotations?` | Offline architecture portal/diagram or snapshot export into `output.allowedOutputDirs` (`view: "wiki"` explicitly rejected) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EXPORT_NOT_ALLOWED`, `PATH_DENIED` |
| `causoryn_preflight_change` | `intent`, `targetSymbols?`/`targetFiles?`, `baseSnapshot?`, `include?` | Candidate-only preflight manifest (`candidateOnly: true`, zero disk writes) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_check_contracts` | `contracts`, `snapshotId?` | Static compatibility evaluation across OpenAPI, AsyncAPI, JSON Schema, SQL, and Protobuf pairs *(superseded by `causoryn_contracts`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_detect_contract_drift` | `base`, `target`, `scope?`, `anchorFiles?` | Revision-to-revision contract drift and producer/consumer impact *(superseded by `causoryn_contracts` `action="drift"`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_verify_change` | `preflightId?` / `baseSnapshot?`, `baseRef?`, `targetRevision?`, `checks?`, `observedTestRun?` | Byte-deterministic verification report; trusted `baseRef` rule loading; host test runs always normalized to `state: "host_asserted"` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `POLICY_INVALID` |
| `causoryn_derive_test_plan` | `changeSet` (`changedSymbols`/`changedFiles`) or `preflightId` | Content-addressed candidate test plan (`direct` / `call-site` / `naming`) resolving saved `preflightId` manifests; never executes tests *(superseded by `causoryn_preflight_change`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_evidence` | `id` (`nodeId`/`edgeId`/`evidenceId`/`findingId`) | Source span, SHA-256 hash, analyzer provenance, and deterministic evidence chain | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_architecture_timeline` | `refs`/`range`, `granularity?` | Sampled multi-revision architecture diff timeline + violation trends over read-only Git history / SQLite snapshots *(also available via `--tool-profile history`)* | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |

### Architecture Export Details

- `architecture` is the default `view` for `json`, `markdown`, `mermaid`, and `html` (default HTML filename: `causoryn-architecture.html`). `interactive` is HTML-only and defaults to `causoryn-architecture-interactive.html` so it never overwrites the zero-JS artifact.
- Interactive HTML exports enforce a deterministic `script-src 'sha256-...'` Content Security Policy (zero `'unsafe-inline'` script permission).
- Optional `annotations` are validated in a single pass, collecting up to 25 schema and graph-membership errors together in `INVALID_ARGUMENT` rather than stopping on the first error. See [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md) and `skills/architecture-blueprint/SKILL.md`.

---

## Wiki Profile Tools (7 Tools — `--tool-profile wiki` or `full`)

`causoryn_wiki_build` is the sole write-capable Wiki tool (writing strictly to Causoryn's external SQLite data-root).

| Tool | Inputs (primary fields) | Output (`data` summary) | Typical error codes |
|---|---|---|---|
| `causoryn_wiki_build` | `workspaceId?`, `mode` (`full`\|`incremental`), `revision?`, `scope?` (rejected) | Projects the published `GraphSnapshot` into a deterministic `WikiSnapshot` in external SQLite (`wiki.dataDbPath` or `--auto-data-dir`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `PATH_DENIED`, `EXPORT_NOT_ALLOWED` |
| `causoryn_wiki_get_tree` | `parentId?`, `depth?`, `limit?`, `cursor?` | 12-root-category taxonomy tree with `childCount`, `coverage`, and `freshness`; empty categories remain `no_data` without filler prose | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_page` | `pageId`, `sections?`, `limit?`, `cursor?` | Generated Markdown sections, `evidenceRefs` + deduplicated `sourceRefs`, `coverage`, and `freshness` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_search` | `query`, `snapshotId?`, `limit?`, `cursor?` (extra filter fields return `INVALID_ARGUMENT` in `0.2.4`) | Phrase-escaped multi-column FTS5 search ranked by exact symbol/route > title > module > BM25; zero embeddings | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `LIMIT_EXCEEDED` |
| `causoryn_wiki_get_links` | `pageId`, `direction?`, `linkKinds?`, `limit?`, `cursor?` | Outgoing + reverse-indexed backlinks with resolution + `brokenLinkDiagnostics` for unresolved targets (`toPageId: null`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_versions` | `pageId?`, `refs?`, `limit?`, `cursor?` | Stored `WikiSnapshot` revision availability (`contentHash`, `linkSetHash`, `templateVersion`, `coverage`); resolves Git aliases read-only (`working-tree` works without `.git`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION` |
| `causoryn_wiki_diff` | `base`, `target`, `pageId?` | `addedPages`, `removedPages`, `changedSections`, `addedLinks`, `removedLinks`, `coverageDelta`, `unresolvedDifferences`, and `contractChanges` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `PATH_DENIED`, `LIMIT_EXCEEDED` |

---

## Server Identity, 5-Language Matrix & Fixed Error Codes

### 1. Server Identity (`packages/mcp-server/src/version.ts`)

- `SERVER_NAME = "causoryn"` · `SERVER_VERSION = "0.2.4"` (Pre-1.0) · `SCHEMA_VERSION = "2.0"`.

### 2. 5-Language Adapter Matrix (`INDEXED_ADAPTERS`)

| Language | `analyzerId` | `astParse` | `symbolResolution` | `frameworkLinkers` | Execution Model |
|---|---|---|---|---|---|
| `typescript` | `ts-adapter` | `L1` | `L2` | `express+nextjs` | In-process TS Compiler API (`TypeChecker`, TS/JS/CJS, monorepo workspace resolution, CHA `INHERITS`/`IMPLEMENTS`, confined `tsconfig`/`jsconfig`, Express/Next.js L3, BDD `Test`/`TESTS`) |
| `csharp` | `roslyn-worker` | `L1` | `L2` | `aspnet-core-route-attributes (L3)` | Isolated `dotnet exec` Roslyn sidecar (`SemanticModel`, CHA `INHERITS`/`IMPLEMENTS`, read-only `obj/project.assets.json` NuGet discovery, ASP.NET Core routes) |
| `python` | `python-worker` | `L1` | `L2` | `decorator-route-pattern (L3)` | Isolated `python -I -B -X utf8` stdlib `ast` sidecar |
| `go` | `go-worker` | `L1` | `heuristic-only (semantik L2 yok)` | `http-router-registration (L3)` | Isolated Go stdlib `go/parser` + `go/ast` sidecar (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, directory + `go.mod` package keying) |
| `rust` | `rust-worker` | `L1` | `heuristic-heavy` | `attribute-macro-route (L3)` | Isolated Rust `syn` 3 sidecar (trusted Cargo `cwd` + SHA-256 binary pinning; 2-segment suffix matches honestly labeled `heuristic`) |

### 3. Fixed 15 Active Error Codes (`CAUSORYN_TOOL_ERROR_CODES`)

Only `INDEX_NOT_READY` and `INTERNAL_ERROR` set `retryable: true`; all `userAction` strings are clear English instructions:

| Error Code | `retryable` | Meaning & Client Action |
|---|---|---|
| `WORKSPACE_NOT_AUTHORIZED` | `false` | Authorize the workspace root using `--root <path>`, `--allow-cwd`, MCP `roots/list`, or `allowRoots` in `CAUSORYN_CONFIG` |
| `PATH_DENIED` | `false` | Path escapes workspace, matches UNC/device pre-check, hits ignore/binary rules, or attempts an unconfigured `wiki.dataDbPath` write |
| `INDEX_NOT_READY` | `true` | No published snapshot exists yet; wait for background indexing or run `causoryn_status(action="refresh")` / `causoryn_wiki_build` |
| `AMBIGUOUS_SYMBOL` | `false` | Multiple symbol candidates matched; `envelope.data` lists candidates (narrow by `kind`/`limit` or pass an exact node ID) |
| `LIMIT_EXCEEDED` | `false` | Request exceeded configured ceiling (`maxNodes`, `maxSymbols`, `maxFileBytes`, or Wiki `limit` cap 200) |
| `INVALID_ARGUMENT` | `false` | Semantic validation failure, malformed cursor, unsupported view combination, or invalid annotation references |
| `EVIDENCE_NOT_FOUND` | `false` | Unknown `nodeId`, `edgeId`, `evidenceId`, `findingId`, or `wikiSnapshotId` |
| `SYMBOL_NOT_FOUND` | `false` | Symbol ID, `qualifiedName`, `entrypoint`, or `flowSeed` not found in the published snapshot |
| `POLICY_INVALID` | `false` | Missing or invalid `.causoryn/architecture.rules.yaml` or `.causoryn/architecture.baseline.yaml` |
| `INVALID_REVISION` | `false` | Unresolvable or disallowed Git ref/alias or missing snapshot blob at that revision |
| `EXPORT_NOT_ALLOWED` | `false` | Target `outputDir` is outside declared `output.allowedOutputDirs` (default deny) |
| `WIKI_PAGE_NOT_FOUND` | `false` | Requested `pageId` or `parentId` does not exist in the target `WikiSnapshot` |
| `CONTRACT_PARSE_FAILED` | `false` | Contract spec failed parsing or exceeded parser safety quotas |
| `UNSUPPORTED_LANGUAGE` | `false` | Reserved catalog code; missing sidecars degrade gracefully to L0/L1 file nodes instead of throwing |
| `INTERNAL_ERROR` | `true` | Unexpected internal failure; raw details stay on `stderr` while the client receives a generic `requestId`-correlated message |

### 4. Pagination, Limits & Write Permissions

- **Opaque cursors:** Base64url-encoded `{ "v": 1, "o": <int> }` offset tokens; tampered cursors return `INVALID_ARGUMENT`.
- **Write permissions:** Only index refresh (`causoryn_status` `action="refresh"` / `causoryn_refresh_index`), `causoryn_export_documentation`, and `causoryn_wiki_build` advertise `readOnlyHint: false`, and all three write strictly to authorized external data-root or `output.allowedOutputDirs` locations — never into analyzed source files.
- **`outputSchemaProfile`:** Defaults to `"omit"` (`--output-schema full` or `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full` re-enables full wire `outputSchema`). Server-side `outputSchema.parse(envelope)` runs on every response in both modes.

---

## Related Documentation

- [5-Minute Quickstart Tutorial](tutorial-5-minutes.md) · [Documentation Hub](README.md)
- [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)
- [CLI & Configuration](cli-and-configuration.md) · [Architecture Overview](architecture.md)
- [5-Language Analyzers](language-analyzers.md) · [Living Wiki Specification](wiki-spec.md)
- [Implementation Status](implementation-status.md) · [Compatibility Matrix](compatibility-matrix.md)
