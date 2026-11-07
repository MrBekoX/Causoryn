# Causoryn for ZCode

> Evidence: TŞ v2.1 §17, §25/8 · wiki/decisions.md K-002 (ZCode as fourth host adapter) · wiki/mcp-tools.md (tool catalog) · packages/mcp-server (implemented tools)

**Causoryn** is a local, deterministic, **LLM-free** code-analysis engine exposed to
ZCode as a stdio MCP server, packaged as this plugin. It builds a read-only graph of an
authorized workspace (files, symbols, calls) with per-edge evidence, and answers
architecture questions without any model API, network service or credential.

## What it provides

- One MCP server (`causoryn`, `type: "stdio"`, launched with `node`) from
  `.zcode-plugin/plugin.json`.
- One routing skill: `skills/map-system/SKILL.md` teaches the host model when and how to
  call `causoryn_map_system`.
- Twenty-three published tools (exactly what the compiled server registers — empty handlers are
  never advertised):

| Tool | Purpose |
| --- | --- |
| `causoryn_get_capabilities` | Adapter levels (L0–L4), server limits, protocol revision, published tool list. Needs no snapshot. |
| `causoryn_workspace_summary` | Project / language / entrypoint / edge-coverage summary derived from the published graph snapshot. |
| `causoryn_index_status` | Index job status: latest (or given `jobId`) job progress, published snapshot, stale flag and diagnostics. |
| `causoryn_refresh_index` | Starts a new snapshot indexing job (`mode: full`): returns a `jobId` immediately, the job runs in the background; writes only to the authorized Causoryn data root. |
| `causoryn_map_system` | Architecture map pages at `level` L0–L3 with `filters`, `maxNodes` and `cursor` pagination. |
| `causoryn_find_symbols` | Ranked symbol search over qualified names, with `AMBIGUOUS_SYMBOL` candidate disambiguation. |
| `causoryn_get_symbol_context` | Symbol node + neighboring edges to the requested depth (`edgeKinds` filter, deterministic ordering) + evidence records; accepts a node id or a qualified name (ambiguous names return `AMBIGUOUS_SYMBOL` candidates). |
| `causoryn_trace_execution` | Call-chain paths from an entrypoint (framework endpoint name like `POST /orders`, a symbol name or node id) over `CALLS` + `ROUTES_TO` edges with bounded deterministic DFS: per-edge resolution + evidence stay in separate fields, a chain carrying a heuristic edge is labeled `heuristic` (never presented as verified), chains stop at `unresolved` edges (status `partial`); `maxDepth`/`maxPaths` are config-capped and truncation is reported via `truncated` + warnings. |
| `causoryn_analyze_impact` | Impact analysis from target symbols over reverse edges with bounded BFS: explainable `impactPaths` where certainty (`direct|indirect|possible`) and resolution (`verified|heuristic|unresolved`) stay in separate fields; no "100% affected" claims; unresolved targets are reported, not guessed (TŞ §13). |
| `causoryn_check_architecture` | Architecture Guard: evaluates `.causoryn/architecture.rules.yaml` (no-cycles via Tarjan SCC, forbidden-dependency glob rules) against the published snapshot; findings follow the TŞ §12 contract with optional baseline suppressions (reason/owner/date) and orphan-suppression reporting. Reports findings only — never decides CI outcomes. |
| `causoryn_compare_architecture` | Architecture diff between two git refs (`baseRef`/`targetRef`): added/removed/changed nodes, documented-confidence rename matching, edge changes and API-surface changes. Snapshot blobs are read via read-only git (cat-file; no checkout/reset/clean); an unanalyzable revision answers `INVALID_REVISION`. |
| `causoryn_get_agent_context` | AI Agent GPS: the task text is used as a search query only (never echoed into output); ranked context package (`exact-symbol` → `graph-proximity` → `contract` → `freshness` → `fts` legs) with `tokenBudget`, `estimatedTokens`, `omittedCount` and explicitly reported degraded legs. |
| `causoryn_generate_onboarding` | Onboarding data for `audience` beginner/intermediate/maintainer: entry points, top-5 high-centrality modules, learning order (cycles collapsed via SCC), critical flows, tests, unknown edges and risk areas — structural data with template rationales only. |
| `causoryn_export_documentation` | Documentation export (`format` json/markdown/mermaid/html) of the published snapshot; writes ONLY to a directory declared in `output.allowedOutputDirs` via atomic `.tmp` + rename. Unauthorized target answers `EXPORT_NOT_ALLOWED` (fixed TŞ §10.1 code). HTML is offline self-contained: escaping + CSP, no CDN/analytics. |
| `causoryn_get_evidence` | Evidence provenance (source file/line records) for a node or edge id. |
| `causoryn_architecture_timeline` | Architecture timeline over git `refs` or a bounded history `range`: deterministic even-interval sampling (`maxRevisions`, ends preserved, skipped points listed explicitly) and per-interval diff summaries derived from the compare core; unanalyzable points/intervals are reported explicitly, no numbers are fabricated. |
| `causoryn_wiki_build` | **The only writing wiki tool**: projects the published graph snapshot into a deterministic `WikiSnapshot` (page tree, bidirectional links + broken-link diagnostics, page versions, FTS index) and publishes it atomically into the SQLite file declared at `wiki.dataDbPath` — the ONLY writable target (the authorized Causoryn data root; never the source tree; undeclared servers deny writes). `mode: full` runs; incremental invalidation is a later phase (explicit rejection). |
| `causoryn_wiki_get_tree` | Wiki page tree (read-only): 12 root categories + child pages in taxonomy order with `childCount`, coverage/freshness, subtree `depth` cap and cursor/limit pagination; empty categories are listed as `no_data`, never filled in. |
| `causoryn_wiki_get_page` | Single wiki page (read-only): generated-layer sections (with `sectionKey` filter + section pagination), `evidenceRefs` provenance, page-level `sourceRefs`, coverage and freshness. Overlay annotations are not served here (TŞ §16A.6: separate local UI/CLI flow with explicit user consent). |
| `causoryn_wiki_search` | Wiki search (read-only): escaped multi-field FTS5 query ranked exact symbol/route > title > module > BM25 > graph proximity, with `matchedFields` + `evidenceIds` relevance explanation, snippets and cursor pagination. No embedding/vector score exists (the engine is LLM-free); the proximity leg is reported as skipped when no proximity data is provided. |
| `causoryn_wiki_get_links` | Page links (read-only): outgoing + incoming (backlinks derived from the reverse index, never duplicated) with resolution + evidence; links whose target could not be resolved are preserved with `toPageId: null` and surfaced in `brokenLinkDiagnostics` (never silently dropped). |
| `causoryn_wiki_get_versions` | Accessible git/snapshot revisions (read-only): the published wiki revision is `available` (per-page versions carry `contentHash`/`linkSetHash`/`templateVersion`/`coverage`); `refs` aliases (commit/tag/branch) are resolved via read-only git (`cat-file`, no checkout/reset/clean) — an unresolvable alias answers `INVALID_REVISION`, a resolved revision without a stored wiki build answers `not_available` with the reason. |
| `causoryn_wiki_diff` | Wiki snapshot diff (read-only; the working tree is never touched): `addedPages`/`removedPages`, `changedSections`, `addedLinks`/`removedLinks`, per-page `coverageDelta` (`{previous, current, reason?}`) and `unresolvedDifferences`. `contractChanges` stays `[]` until the contracts phase and the degradation is reported in `warnings`. |

All responses use the standard envelope: `schemaVersion, requestId, workspaceId,
snapshotId, status, coverage, warnings, data, nextCursor`, with the fixed envelope
error codes exported by the compiled server as `CAUSORYN_TOOL_ERROR_CODES`
(`WORKSPACE_NOT_AUTHORIZED`, `PATH_DENIED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`,
`LIMIT_EXCEEDED`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND`,
`POLICY_INVALID`, `INVALID_REVISION`, `EXPORT_NOT_ALLOWED`,
`WIKI_PAGE_NOT_FOUND`, `UNSUPPORTED_LANGUAGE`, `INTERNAL_ERROR`). Of these,
`INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND` and `SYMBOL_NOT_FOUND` are project
extensions beyond the TŞ §10.1 base list, while `POLICY_INVALID`,
`INVALID_REVISION`, `EXPORT_NOT_ALLOWED` and `WIKI_PAGE_NOT_FOUND` are TŞ
§10.1 base codes first exercised by the Faz C guard / git-revision /
export-authorization tools and the Faz C2 wiki tools respectively (see the
header note in `packages/mcp-server/src/errors.ts`); the set is exactly what
the server can place in `envelope.error.code`.

## Requirements

- **Node.js >= 24** (the plugin launches the server with `node`; the monorepo targets
  the same engine via `engines`).
- The compiled server entry of the Causoryn monorepo:
  `packages/mcp-server/dist/stdio.js`. In this source layout the manifest resolves it as
  `${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/stdio.js` — run `npm run
  build` in the monorepo root if the file is missing.
- A workspace root you authorize (see below).

## Installation

1. Build the monorepo once: `npm install` / `npm run build` in the Causoryn checkout
   that contains this plugin under `integrations/zcode/causoryn`.
2. In ZCode, open **Plugin Marketplace → Add → Add Plugin Marketplace** and add the
   directory that contains this plugin (for local testing, a marketplace root with
   `.claude-plugin/marketplace.json` listing `causoryn`).
3. Install **causoryn** from the market list and keep it enabled.
4. Configure the workspace root declaration (next section), then reload the plugin so
   the MCP server picks up the new config.

A packaged (bundled) release would copy the compiled server into the plugin itself and
rewrite the `args` path accordingly; this source-layout manifest intentionally points at
the monorepo build output so Sprint-1 development stays a single source of truth.

## Workspace root declaration (allowRoots)

The server reads its entire configuration from the `CAUSORYN_CONFIG` environment
variable (JSON). The plugin wires it through user configuration:

```json
"userConfig": {
  "config_json": {
    "type": "string",
    "default": "{\"allowRoots\":[]}"
  }
},
"mcpServers": {
  "causoryn": {
    "type": "stdio",
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/stdio.js"],
    "cwd": "${CLAUDE_PROJECT_DIR}",
    "env": { "CAUSORYN_CONFIG": "${user_config.config_json}" }
  }
}
```

Set **Causoryn server config (JSON)** in the plugin settings to, for example:

```json
{"allowRoots":["C:/projects/my-app"], "workspaceId": "my-app"}
```

- `allowRoots[0]` is the single authorized workspace root of the server.
- The default `{"allowRoots":[]}` denies everything: workspace tools answer
  `WORKSPACE_NOT_AUTHORIZED` and nothing is indexed. This is deliberate (explicit
  authorization, default deny).
- `output.allowedOutputDirs` (optional array) declares the ONLY directories
  `causoryn_export_documentation` may write to. Declared directories must already
  exist; with no declaration (the default) every export answers
  `EXPORT_NOT_ALLOWED` and nothing is written (explicit output authorization,
  default deny — TŞ §16 export security).
- `wiki.dataDbPath` (optional absolute path) declares the ONLY file
  `causoryn_wiki_build` may write (the authorized Causoryn data root SQLite
  database, TŞ §16A.8). The path must be absolute, its parent directory must
  exist, and it must lie OUTSIDE the `allowRoots` workspace root (the source
  tree is never written; violations refuse to start the server). With no
  declaration (the default) `causoryn_wiki_build` answers `PATH_DENIED` and
  the wiki read tools answer `INDEX_NOT_READY` — explicit data-root
  authorization, default deny.
- No credentials, tokens or API keys exist in this plugin — the engine is fully local.

## Security model

- **Read-only workspace.** Causoryn never writes to your source tree; analysis writes
  only to its own authorized data root outside the workspace (ADR-008).
- **Explicit root authorization.** Only roots listed in `allowRoots` are indexable;
  symlink escapes, ignore rules and size/binary filters are enforced by the workspace
  access policy (TŞ §9).
- **No LLM anywhere.** The engine contains no model, embedding or network dependency
  (ADR-002); the skill text only routes the host model, it cannot change it.
- **Clean stdio.** The server process writes only MCP protocol traffic to stdout; logs
  go to stderr.

## Scope note

Faz A published the five core tools; sprint-2 Faz B added `causoryn_index_status`
and `causoryn_refresh_index` (index job management), `causoryn_get_symbol_context`
(Code Explorer relations + evidence) and `causoryn_trace_execution` (bounded
deterministic call-chain paths with per-edge resolution and evidence). Sprint-3
Faz C added `causoryn_analyze_impact`, `causoryn_check_architecture`,
`causoryn_compare_architecture`, `causoryn_get_agent_context`,
`causoryn_generate_onboarding`, `causoryn_export_documentation` and
`causoryn_architecture_timeline`. Sprint-4 Faz C2 (Living Wiki, TŞ §16A)
added the seven wiki tools with `causoryn_wiki_build` as the only writing tool
(23 tools total). Later phases add preflight and contract drift tooling per
`wiki/mcp-tools.md`; this plugin's manifest and skill are updated only when
those tools actually exist in the compiled server.
