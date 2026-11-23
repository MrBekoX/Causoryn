# MCP Tool Contracts — All 29 Published Tools (Technical Specification v2.1 §10.2 + §16A.8)

> **Language:** [Türkçe](../tool-contracts.md) | **English**
>
> **Evidence:** `packages/mcp-server/src/version.ts` `TOOL_NAMES` (29 tools; `tools/list` exposes **exclusively** this set — zero stub handlers, ADR-010) · `packages/mcp-server/src/server.ts` (tool registrations + Zod input/output schemas) · `packages/mcp-server/src/errors.ts` (fixed 15-code error table) · `packages/mcp-server/src/runtime-cli.ts` (`--output-schema-profile`, `--allow-cwd`, MCP `roots/list`, `--auto-data-dir`) · `wiki/mcp-tools.md` (historical catalog) · Verification suite: `tests/release-docs.test.ts` (asserts exact 1-to-1 set parity between the tables below and `TOOL_NAMES`).

This document is a **concise reference**: the authoritative contract is defined in source code via each tool's Zod `inputSchema` and `outputSchema` (published as JSON Schema when `outputSchemaProfile` is `"full"` and enforced server-side in all modes). These tables provide a fast lookup surface for host models and integrators; in case of any discrepancy, the source Zod schemas prevail.

## Standard Envelope (Technical Specification §10.1)

Every tool response returns the complete 10-field `EnvelopeSchema` (`z.strictObject`):

1. `schemaVersion` (`"2.0"`, locked via `SCHEMA_VERSION` in `packages/mcp-server/src/version.ts`)
2. `requestId` (string correlation ID from the MCP transport request)
3. `workspaceId` (`string | null`)
4. `snapshotId` (`string | null` — `GraphSnapshot` ID for core tools; served `WikiSnapshot` ID for Wiki tools)
5. `status` (`"ok" | "partial" | "error"`)
6. `coverage` (`{ tier: "L0"|"L1"|"L2"|"L3"|"L4", resolvedEdges, unresolvedEdges, totalEdges, coverageRatio } | null`)
7. `warnings` (`string[]`)
8. `data` (tool-specific payload, candidate list on `AMBIGUOUS_SYMBOL`, or `null` on other errors)
9. `nextCursor` (`string | null`)
10. `error` (`null` when `status` is `"ok"` or `"partial"`; `{ code, message, retryable, userAction }` when `status` is `"error"`)

Domain and authorization errors are returned as structured envelope payloads (`isError: false` in the MCP `CallToolResult`), never as unhandled protocol crashes. Error codes come from the Technical Specification §10.1 fixed list plus three documented project extensions (`packages/mcp-server/src/errors.ts` `CAUSORYN_TOOL_ERROR_CODES`, 15 codes total; extensions governed by K-008 and K-011, with `UNSUPPORTED_LANGUAGE` retained as a reserved fixed code). Every error carries deterministic `retryable` and `userAction` guidance.

In addition, `packages/mcp-server/src/server.ts` declares structured MCP `annotations` (`readOnlyHint`, `destructiveHint: false`, `openWorldHint: false`) across all 29 tools: the 3 write-capable tools (`causoryn_refresh_index`, `causoryn_export_documentation`, `causoryn_wiki_build`) advertise `readOnlyHint: false`, while the remaining 26 tools advertise `readOnlyHint: true`. `stdout` carries **only** MCP JSON-RPC protocol frames; operational logs go exclusively to `stderr` with a `[causoryn]` prefix (Red Line 4).

**Universal error handling (outside per-tool columns):** `INTERNAL_ERROR` is the catch-all bucket for unexpected internal failures on every tool (raw driver/library messages and filesystem paths are logged only to `stderr`, never leaked to the client; the client receives a generic message correlated by `requestId`). Wire-level input schema mismatches are rejected by the MCP SDK with protocol `isError: true`, whereas inputs that pass schema parsing but violate semantic constraints return an envelope `INVALID_ARGUMENT` error.

The same published snapshot and equivalent query inputs produce consistently ordered analysis data. The MCP `requestId` comes from the request. Job progress, timestamps, and `stale` reflect runtime state.

## Error Code Methodology Note (Honesty)

Per-tool typical error codes in the tables below were compiled from two sources: (1) static inspection of `services*.ts` handlers and their error-mapping helpers (`graphErrorToToolError`, `wikiErrorToToolError`, `contractErrorToToolError`, `preflightErrorToToolError`, `verificationErrorToToolError`, `indexingErrorToToolError`), and (2) first-use governance records in `errors.ts` and `wiki/decisions.md` (K-008, K-011, K-012, K-014, K-015). Because shared helpers map broader error families, static inspection can be slightly conservative; the exact per-tool error behavior is pinned by negative unit and integration tests (see [Implementation Status](implementation-status.md)).

## Core Tools (22 — Technical Specification §10.2 Catalog Order)

| Tool | Inputs (primary fields) | Output (`data` summary) | Typical error codes |
|---|---|---|---|
| `causoryn_get_capabilities` | `workspace?` | Adapter capability levels L0–L4 across 5 languages (including C# `frameworkLinkers: "aspnet-core-route-attributes (L3)"`), server identity (`SERVER_VERSION = "0.2.3"`, `SCHEMA_VERSION = "2.0"`), server limits, protocol revision, and the 29 published tool names; requires no snapshot | `WORKSPACE_NOT_AUTHORIZED` |
| `causoryn_workspace_summary` | `workspaceId?` | Project, language, framework, entrypoint, and coverage summary derived strictly from the latest published `GraphSnapshot`; empty workspace returns `partial` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_index_status` | `jobId?` | Progress, snapshot ID, `stale` flag, and diagnostics for the specified or latest index job. Job diagnostics and warnings are each capped at 50 entries, with a truncation summary appended to warnings when needed. Returns null `job` and `jobId` when no job exists, and an actionable warning when no published snapshot exists | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_refresh_index` | `mode` (`full` \| `incremental` — content-hash comparative refresh; B7 per-file parse reuse and file-watcher MCP surface remain open), `scope?` (explicitly rejected) | Returns `jobId` immediately while indexing runs asynchronously; writes **only** to Causoryn's authorized graph repository (`InMemoryGraphRepository` or `storage.dataDbPath` SQLite) | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_map_system` | `level` (`L0`–`L3`; `L3` covers `Function`/`Method`/`Handler`/`Endpoint`/`Test`), `filters?`, `maxNodes`, `cursor?` | Deterministically ordered node + edge pages with opaque cursor pagination | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_find_symbols` | `query`, `kind?`, `limit?` | Ranked exact / prefix / substring search over `qualifiedName`; ambiguous matches return disambiguation candidates | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_symbol_context` | `symbolId` (node ID or `qualifiedName`), `edgeKinds?`, `depth?` | Target symbol node + deterministically ordered neighbor edges up to `depth` + backing evidence records | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_trace_execution` | `entrypoint` (endpoint name such as `'POST /orders'` or symbol ID/name), `maxDepth?`, `maxPaths?` | Bounded deterministic call paths over `CALLS` + `ROUTES_TO`; per-edge `resolution` + `evidence` kept separate; chain halts at `unresolved` edges (`status: "partial"`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_trace_business_flow` | `flowSeed`, `boundaries?` | End-to-end business flow chains (`ROUTES_TO`/`CALLS`/`PRODUCES_CONTRACT`/`CONSUMES_CONTRACT`/`CONTAINS`, bounded BFS + reverse contract tracing); discontinuities are honestly reported via `gap` segments rather than fabricated bridges | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `INVALID_REVISION`, `CONTRACT_PARSE_FAILED` |
| `causoryn_analyze_impact` | `targets`/`diff`, `depth?`, `edgeKinds?` | Reverse-edge bounded BFS impact paths; `certainty` (`direct`\|`indirect`\|`possible`) and `resolution` (`verified`\|`heuristic`\|`unresolved`) are distinct fields; never claims "100% impacted"; unresolvable targets listed in `unresolvedTargets` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID` |
| `causoryn_check_architecture` | `policyId?`, `scope?` | Evaluates `.causoryn/architecture.rules.yaml` against the published snapshot: `no-cycles` (Tarjan SCC) + `forbidden-dependency` glob findings, baseline suppressions, and `orphanSuppressions`; reports findings without making CI exit-code decisions | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID`, `INVALID_REVISION` |
| `causoryn_compare_architecture` | `baseRef`, `targetRef` | Architectural diff between two Git refs (or `working-tree`): added/removed/changed nodes, confidence-scored rename matches, edge diffs, and API surface changes via read-only Git blob reads | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |
| `causoryn_get_agent_context` | `task`, `candidateScope?`, `tokenBudget` (required) | Ranked context pack (`exact-symbol` → `graph-proximity` → `contract` → `freshness` → `fts`; `symbol_fts` `fts` leg active when `storage.dataDbPath` SQLite is configured, honestly degraded in memory mode) with `estimatedTokens`, `omittedCount`, and degraded legs | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_generate_onboarding` | `audience` (`beginner`\|`intermediate`\|`maintainer`) | Structured onboarding data: entrypoints, top 5 central modules, topological learning order (cycles collapsed via SCC), critical flows, tests, and risk areas; natural-language prose is left to the host model | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_export_documentation` | `format` (`json`\|`markdown`\|`mermaid`\|`html`\|`snapshot`), `outputDir` (required), `fileName?`, `view?` (`architecture` [default for formats other than snapshot] \| `interactive` [HTML only] \| `full`; `wiki` explicitly rejected with `INVALID_ARGUMENT`), `options?` (`maxModules`, `pathPrefix`, `includeTests`), `annotations?` (optional caller annotations with validated references) | Deterministic visual architecture portal/diagram or raw snapshot export (`view="architecture"`: zero-JS layered SVG HTML portal, subgraph Mermaid, Architecture Brief Markdown, compact JSON + `architectureSummary.moduleIds`; `view="interactive"`: offline pan/zoom/search/evidence-drawer HTML portal; `view="full"`: raw dump; `snapshot`: canonical `architecture-snapshot.json`); atomic `.tmp` + rename writes **only** into declared `output.allowedOutputDirs` (strict offline CSP, zero CDN/analytics) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EXPORT_NOT_ALLOWED`, `PATH_DENIED` |
| `causoryn_preflight_change` | `intent`, `targetSymbols?`/`targetFiles?`, `baseSnapshot?` | Candidate Preflight Manifest: `impactCandidates` (`certainty`/`resolution` separate), `contractChecks`, content-addressed `testPlanId`, `limitations`, `sourceRevision`; **writes nothing to disk or workspace** (`candidateOnly: true`; cached only in in-process `PreflightManifestStore` FIFO 200) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_check_contracts` | `contracts?` (`{name?, base, target}` spec pairs), `snapshotId?` | Evaluates contract version pairs (`backward-safe`\|`risk`\|`breaking_candidate`\|`unknown`) with rule names, old/new line-span evidence, and unpaired diagnostics | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_detect_contract_drift` | `base`, `target`, `scope?`, `anchorFiles?` | Canonical drift report: `contractChanges` (`{contractId, changeKind, summary}`), separated `breaking_candidate`/`risk`/`unknown` buckets, `PRODUCES_CONTRACT`/`CONSUMES_CONTRACT` impact graph, and `unconsumedChanges` (unresolved consumers) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_verify_change` | `preflightId?` / `baseSnapshot?` (at least one), `target?` | Byte-deterministic four-check verification report (`architecture`, `contracts`, `graph-diff`, `test-plan`); deterministic verdict (`no_findings` \| `review_required` \| `blocking_findings` \| `inconclusive`); test run status defaults to `not_run` (`observed` requires `evidenceRef` + sha256); **never modifies code or runs tests** | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `POLICY_INVALID` |
| `causoryn_derive_test_plan` | `changeSet` (`changedSymbols`/`changedFiles`) / `preflightId?` (explicitly rejected on this surface) | Deterministic test candidates: `direct` (`TESTS` edges) + `call-site` (reverse `CALLS` BFS) + `naming` (heuristic), with `reason` + `evidenceIds` + `matchLevel` and `missingCoverageCandidates`; never executes tests; content-addressed `testplan:<sha256>` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_evidence` | `nodeId`/`edgeId`/`evidenceId`/`findingId` | Provenance chain (`relativePath`, `startLine`/`endLine`, `sourceHash`, `analyzerId`, `rationale`, `contextRefs`) + deterministic `chain` summary; `finding:<sha256>` IDs are re-derived from `.causoryn/architecture.rules.yaml` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_architecture_timeline` | `refs`/`range`, `granularity?` | Deterministically sampled architectural diff timeline across Git points + Phase E violation trends (`no-cycles` and `forbidden-dependency` tracked separately per milestone, never collapsed into a fake quality score); skipped points listed explicitly | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |

### Architecture Export Details

- `architecture` is the MCP default for `json`, `markdown`, `mermaid`, and `html` (default HTML filename: `causoryn-architecture.html`). `interactive` is available for `html` only and defaults to `causoryn-architecture-interactive.html` (`EXPORT_INTERACTIVE_HTML_FILE_NAME`) when `fileName` is omitted, preventing silent overwrite of the zero-JS `causoryn-architecture.html` artifact. Select `view="full"` for the legacy raw dump. With `view` omitted or set to `full`, `format="snapshot"` emits the canonical `CompareContentSet` used by comparison tools.
- `options` and `annotations` are accepted only for `architecture` and `interactive`. `maxModules` defaults to 32 and accepts 2–100. The summary's `architectureSummary.moduleIds` provides the exact canonical module IDs for annotating the same projection.
- **MCP JSON Schema `.describe()` guidance & natural-language triggering (`K-026`):** `causoryn_export_documentation` exposes descriptive Zod `.describe()` documentation across all top-level input fields (`workspaceId`, `format`, `outputDir`, `fileName`, `view`, `options`, `annotations`) and nested schema objects (`domains`, `moduleNotes`, `flows`, `guidedTour`, `decisions`, `risks`). Both the tool description and the `architecture-blueprint` skill (triggered from natural-language prompts in English or Turkish without naming the skill) guide the host LLM through the 2-step workflow (`format: "json", view: "architecture"` → inspect `architectureSummary.moduleIds` → `format: "html", view: "interactive"` with validated `annotations`), or omitting `annotations` for a purely structural deterministic export. Causoryn validates the schema, budgets, and supplied `moduleId`, `nodeId`, `evidenceId`, and `keyFiles` references fail-closed; free-form commentary remains the caller's interpretation. See [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md).
- Byte equality applies to file contents for the same snapshot, format, view, effective options, and validated annotations. `packages/graph/test/architecture-export.test.ts` covers equality across four formats and both HTML views when the same graph's arrays are reversed.

## Wiki Tools (7 — Technical Specification §16A.8; `wiki_build` Is the Sole Writer)

| Tool | Inputs (primary fields) | Output (`data` summary) | Typical error codes |
|---|---|---|---|
| `causoryn_wiki_build` | `workspaceId?`, `mode` (`full`\|`incremental`), `revision?`, `scope?` (explicitly rejected) | Projects the published `GraphSnapshot` into a deterministic `WikiSnapshot` and atomically publishes **only** to the authorized data-root SQLite (`wiki.dataDbPath` or `--auto-data-dir`); falls back gracefully to `full` + `fallbackReason` when incremental preconditions are unavailable | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `PATH_DENIED`, `EXPORT_NOT_ALLOWED` |
| `causoryn_wiki_get_tree` | `parentId?`, `depth?`, `limit?`, `cursor?` | 12-root-category hierarchy in taxonomy order with `childCount`, `coverage`, and `freshness`; empty categories remain `no_data` without filler prose | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_page` | `pageId`, `sections?` (`sectionKey` filter), `limit?`, `cursor?` | Single page: generated Markdown sections, `evidenceRefs` + deduplicated `sourceRefs` provenance, `coverage`, and `freshness`; overlay annotations are not returned on this MCP surface (§16A.6 local UI/CLI flow) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_search` | `query`, `snapshotId?`, `limit?`, `cursor?` (extra filter fields return explicit `INVALID_ARGUMENT` in `v0.2.3`) | Phrase-escaped multi-column FTS5 search ranked by exact symbol/route > title > module > BM25 > graph proximity; returns `matchedFields`, `evidenceIds`, `snippet`, and `skippedRankLegs`; zero embeddings (Red Line 1) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `LIMIT_EXCEEDED` |
| `causoryn_wiki_get_links` | `pageId`, `direction?`, `linkKinds?`, `limit?`, `cursor?` | `outgoing` + `incoming` (reverse-index backlinks) with `resolution` + `evidenceRefs`; unresolved targets preserved with `toPageId: null` + `brokenLinkDiagnostics` (K-013 #4) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_versions` | `pageId?`, `refs?`, `limit?`, `cursor?` | Reports stored `WikiSnapshot` revisions as `available` (`contentHash`, `linkSetHash`, `templateVersion`, `coverage`); resolves Git branch/tag/commit aliases via read-only `git cat-file -t` (`working-tree` resolves without requiring `.git`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION` |
| `causoryn_wiki_diff` | `base`, `target`, `pageId?` | `addedPages`, `removedPages`, `changedSections`, `addedLinks`, `removedLinks`, `coverageDelta` (`{pageId, previous, current, reason?}`), `unresolvedDifferences`, and `contractChanges` (`{contractId, changeKind, summary}`, K-013 #7) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `PATH_DENIED`, `LIMIT_EXCEEDED` |

## Server Identity, 5-Language Capability Matrix & Fixed 15 Error Codes

### 1. Server Identity & Protocol Constants (`packages/mcp-server/src/version.ts`)

- `SERVER_NAME = "causoryn"` — reported as `serverInfo.name` in the MCP `initialize` handshake.
- `SERVER_VERSION = "0.2.3"` — Pre-1.0 Public Preview version (K-022 / K-024; locked across root `package.json`, `packages/causoryn/package.json`, and `server.json`; per ADR-010, `1.0.0` is not declared while `[Unreleased]` 1.0.0 release gates remain open).
- `SCHEMA_VERSION = "2.0"` — populated in `envelope.schemaVersion` across all 29 tools.
- `protocol.revision` — `LATEST_PROTOCOL_VERSION` re-exported from `@modelcontextprotocol/sdk`.

### 2. `causoryn_get_capabilities` 5-Language Adapter Matrix (`INDEXED_ADAPTERS`)

`causoryn_get_capabilities` projects `INDEXED_ADAPTERS` (`packages/indexing/src/index.ts:168-223`) without requiring an indexed snapshot. Internal per-language worker protocol versions intentionally remain `"0.1.0"` to preserve persistent SQLite `analyzerFingerprint` backward compatibility (K-022):

| Language (`language`) | `analyzerId` | `astParse` | `symbolResolution` | `frameworkLinkers` | Execution Model |
|---|---|---|---|---|---|
| `typescript` | `ts-adapter` | `L1` | `L2` | `express+nextjs` | In-process TypeScript Compiler API (`TypeChecker`, TS/JS/CJS + confined `tsconfig.json`/`jsconfig.json` + Express/Next.js App Router L3 + BDD `Test`/`TESTS`) |
| `csharp` | `roslyn-worker` | `L1` | `L2` | `aspnet-core-route-attributes (L3)` | `dotnet exec` Roslyn sidecar (`@causoryn/sidecar-ipc`; ASP.NET Core controller attributes + Minimal API `MapGet`/`MapPost`) |
| `python` | `python-worker` | `L1` | `L2` | `decorator-route-pattern (L3)` | `python -B` stdlib `ast` sidecar (zero third-party dependencies) |
| `go` | `go-worker` | `L1` | `heuristic-only (semantik L2 yok)` | `http-router-registration (L3)` | Go stdlib `go/parser` + `go/ast` sidecar (`net/http`, `gin`, `echo`, `chi`) |
| `rust` | `rust-worker` | `L1` | `heuristic-heavy` | `attribute-macro-route (L3)` | Rust `syn` 3 sidecar (`axum`, `actix-web`, `rocket` attribute macros) |

### 3. Fixed 15 Error Codes (`CAUSORYN_TOOL_ERROR_CODES`)

All domain, policy, and workspace errors travel inside `envelope.error` (`{ code, message, retryable, userAction }`) with `isError: false`. Only `INDEX_NOT_READY` and `INTERNAL_ERROR` set `retryable: true`:

| Error Code (`code`) | `retryable` | Origin / Governance | Meaning & Client Action (`userAction`) |
|---|---|---|---|
| `WORKSPACE_NOT_AUTHORIZED` | `false` | Spec §10.1 fixed base | `workspaceId` mismatch or unauthorized/empty `allowRoots`; authorize the workspace root |
| `PATH_DENIED` | `false` | Spec §10.1 fixed base | Ignored/secret path, path traversal/null-byte rejection, or unconfigured `wiki.dataDbPath` write attempt |
| `INDEX_NOT_READY` | `true` | Spec §10.1 fixed base | No published `ready`/`partial` `GraphSnapshot` or `WikiSnapshot` yet; retry after `causoryn_refresh_index` or `causoryn_wiki_build` |
| `AMBIGUOUS_SYMBOL` | `false` | Spec §10.1 fixed base | Multiple symbol candidates matched; `envelope.data` carries candidates (narrow by `kind`/`limit` or pass exact node ID) |
| `LIMIT_EXCEEDED` | `false` | Spec §10.1 fixed base | Request exceeded `maxNodes`, `maxSymbols`, `maxDepth`, `maxPaths`, or Wiki `limit` (cap 200) |
| `INVALID_ARGUMENT` | `false` | Project extension (K-008) | Semantic validation failure after schema parsing, malformed `cursor`, unsupported export view or combination, invalid annotation reference, or explicitly rejected `scope` and extra Wiki search filters |
| `EVIDENCE_NOT_FOUND` | `false` | Project extension (K-008) | Unknown `nodeId`, `edgeId`, `evidenceId`, `findingId`, or `wikiSnapshotId` |
| `SYMBOL_NOT_FOUND` | `false` | Project extension (K-011) | Symbol ID, `qualifiedName`, `entrypoint`, or `flowSeed` not present in the published snapshot |
| `POLICY_INVALID` | `false` | Spec §10.1 fixed base (K-012) | Missing or invalid `.causoryn/architecture.rules.yaml` or `.causoryn/architecture.baseline.yaml` |
| `INVALID_REVISION` | `false` | Spec §10.1 fixed base (K-012 / K-013 #6) | Unresolvable Git ref/alias or missing `.causoryn/architecture-snapshot.json` blob at that revision |
| `EXPORT_NOT_ALLOWED` | `false` | Spec §10.1 fixed base (K-012) | Target `outputDir` is outside declared `output.allowedOutputDirs` (default deny) |
| `WIKI_PAGE_NOT_FOUND` | `false` | Spec §10.1 fixed base (K-014) | Requested `pageId` or `parentId` does not exist in the target `WikiSnapshot` |
| `CONTRACT_PARSE_FAILED` | `false` | Spec §10.1 fixed base (K-015) | OpenAPI/AsyncAPI/JSON Schema/SQL/Proto spec failed parsing or exceeded byte/quota limits |
| `UNSUPPORTED_LANGUAGE` | `false` | Spec §10.1 reserved fixed code | Retained for Spec §10.1 schema parity; currently not thrown because missing sidecars degrade gracefully to L0/L1 file nodes |
| `INTERNAL_ERROR` | `true` | Spec §10.1 fixed base | Unexpected internal failure; raw details are logged only to `stderr` while the client receives a sanitized message with `requestId` |

### 4. Pagination & Server Limits

- **Opaque cursors (`packages/mcp-server/src/cursor.ts`):** Base64url-encoded `{ "v": 1, "o": <int> }` offset tokens. Undecodable or tampered cursors return `INVALID_ARGUMENT`; on the final page, both `envelope.nextCursor` and `data.nextCursor` are `null`.
- **Configured server limits (`causoryn_get_capabilities.data.limits`):** `maxFiles`, `maxFileBytes`, `maxNodes` (default 250), `maxSymbols` (default 100), `maxDepth` (default 3), `maxPaths` (default 50); paginated Wiki tools default to `limit = 50` with a hard cap of `200` (K-013 #5).

## Write-Permission Matrix (Red Line 2)

| Tool | MCP `readOnlyHint` | Permitted Write Target / In-Memory Side Effect |
|---|---|---|
| `causoryn_refresh_index` | `false` | Causoryn's own graph index repository only — defaults to in-process `InMemoryGraphRepository` in bare stdio wiring, or writes to `storage.dataDbPath` SQLite data-root (absolute path strictly outside `allowRoots`, via `CAUSORYN_CONFIG` or `--auto-data-dir`). Source workspace is scanned strictly read-only; first-run Rust/Go sidecar builds default to external toolchain `target`/cache directories (e.g., `~/.causoryn/cache/rust-worker-target`) |
| `causoryn_export_documentation` | `false` | Declared `output.allowedOutputDirs` only (atomic `.tmp` + rename; bare default `[]` → `EXPORT_NOT_ALLOWED`; `--auto-data-dir` provisions an external workspace-scoped `exports/` directory) |
| `causoryn_wiki_build` | `false` | Declared `wiki.dataDbPath` SQLite data-root only (strictly outside `allowRoots`; `--auto-data-dir` wires `wiki.dataDbPath` to the external workspace SQLite database; `openWikiStores` also initializes the single workspace row in `wiki.dataDbPath` on server startup) |
| `causoryn_preflight_change` / `causoryn_verify_change` | `true` | **Writes zero bytes to disk or the working tree** (`candidateOnly` locked to `true`, verify-only type guard); `preflight_change` caches its manifest solely in the in-process `PreflightManifestStore` (FIFO cap 200) so `verify_change(preflightId)` can resolve it |
| All other tools (24 tools) | `true` | Strictly read-only (the user's source workspace is never modified under any condition — ADR-008) |

## Reuse Principle (No Duplicate Wiki Refresh/Export Tools)

`causoryn_refresh_index` does not automatically rebuild the `WikiSnapshot` in v0.2.3; regenerating the Wiki projection is performed explicitly via `causoryn_wiki_build`. `causoryn_export_documentation` supports `view: "architecture" | "interactive" | "full"`, `options`, and fail-closed `annotations`, while `view: "wiki"` remains explicitly rejected with `INVALID_ARGUMENT` (ADR-010: incomplete surfaces are never silently ignored). Separate `wiki_refresh` or `wiki_export` tools are intentionally **not** introduced, keeping the tool catalog locked at 22 + 7 = 29 tools.

## Zero-Config CLI, Dynamic Root Binding & `outputSchemaProfile` Contract

`packages/mcp-server/src/runtime-cli.ts` and `packages/mcp-server/src/server.ts` support deterministic programmatic embedding, bare stdio execution, CLI coding agents, and desktop IDE plugins under identical fail-closed security invariants:

1. **`--output-schema-profile omit|full` and Server-Side Schema Enforcement:**
   - Precedence (`resolveEffectiveOutputSchemaProfile`): `--output-schema-profile <full|omit>` CLI flag > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` environment variable > (`hasCliActivation ? "omit" : "full"`).
   - **Programmatic & bare stdio mode (`outputSchemaProfile: "full"`):** `createCausorynMcpServer(context)` and zero-argument `node dist/mcp-server.mjs` publish the full JSON Schema `outputSchema` on all 29 tools in `tools/list` and enforce `allowRoots: []` (default deny) when `CAUSORYN_CONFIG` is absent.
   - **CLI / Plugin activation mode (`causoryn mcp --allow-cwd --auto-data-dir [--client <id>]`):** Defaults to `outputSchemaProfile: "omit"` so `tools/list` omits bulky per-tool `outputSchema` JSON definitions over the wire, saving substantial LLM context-window tokens in CLI clients (override anytime via `--output-schema-profile full` or `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full`). **Even in `omit` mode, the server executes `registration.outputSchema.parse(envelope)` (`server.ts:562-564`) on every response before returning**.
2. **Safe `--allow-cwd` Filter & Dynamic MCP `roots/list` Binding (`attachMcpRootsWorkspaceBinder`):**
   - `inspectProjectRootSafety` rejects unsafe candidate roots fail-closed: filesystem roots (`/`, `C:\`), `$HOME`, Causoryn data directories (`~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`), plugin/bundle installation directories (`~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, `bundle-manifest.json`), sensitive user directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), and OS system directories (`/etc`, `/usr`, `/System`, `C:\Windows`, `C:\Program Files`).
   - When `cwd` is a safe project directory (typical CLI sessions), Causoryn binds immediately at startup. When launched with an unsafe `cwd` (typical desktop IDEs starting in `$HOME`, `/`, or the plugin install folder), Causoryn starts safely with `allowRoots: []` and performs single-flight MCP `roots/list` synchronization on `oninitialized`, `beforeToolCall`, and live `notifications/roots/list_changed` events, atomically rebinding `DynamicCausorynContext` to the first safe `file://` workspace root.
3. **Out-of-Tree `--auto-data-dir` Provisioning (`buildWorkspaceAutoConfig`):**
   - Resolves the base data directory (`--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`), derives a deterministic `<slug>-<hash12>` folder from the canonical primary root, and wires `storage.dataDbPath` + `wiki.dataDbPath` (`graph[-<client>].sqlite`) and `output.allowedOutputDirs` (`exports/`) under `~/.causoryn/workspaces/<slug>-<hash12>/`.
   - Before creating a single directory, every ancestor prefix is checked against symlink/dangling-link escapes (CWE-59) and verified to reside strictly outside all `allowRoots` (ADR-008); directories are created with `0o700` permissions and re-verified via `realpathSync` after creation against TOCTOU races.

## Related Documentation

- [Documentation Index](README.md) — entry point for all English and Turkish documentation
- [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md) — deterministic and Host-LLM annotated architecture portal guide
- [Architecture Overview](architecture.md) — monorepo package map and dependency boundaries
- [CLI & Configuration](cli-and-configuration.md) — CLI flags, environment variables, and `CAUSORYN_CONFIG` reference
- [Language Analyzers](language-analyzers.md) — 5-language AST/semantic adapters and resolution honesty
- [Living Wiki Specification](wiki-spec.md) — Living Wiki Engine design contract and current status
- [Implementation Status](implementation-status.md) — phase-by-phase verification evidence
- [Compatibility Matrix](compatibility-matrix.md) — host × verification result matrix
- Historical/source references: `wiki/mcp-tools.md` · `packages/mcp-server/src/errors.ts`
