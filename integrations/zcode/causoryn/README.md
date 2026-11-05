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
- Nine published tools (exactly what the compiled server registers — empty handlers are
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
| `causoryn_get_evidence` | Evidence provenance (source file/line records) for a node or edge id. |

All responses use the standard envelope: `schemaVersion, requestId, workspaceId,
snapshotId, status, coverage, warnings, data, nextCursor`, with the fixed envelope
error codes exported by the compiled server as `CAUSORYN_TOOL_ERROR_CODES`
(`WORKSPACE_NOT_AUTHORIZED`, `PATH_DENIED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`,
`LIMIT_EXCEEDED`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND`,
`UNSUPPORTED_LANGUAGE`, `INTERNAL_ERROR`). Of these, `INVALID_ARGUMENT`,
`EVIDENCE_NOT_FOUND` and `SYMBOL_NOT_FOUND` are project extensions beyond the TŞ
§10.1 base list (see the header note in `packages/mcp-server/src/errors.ts`); the set
is exactly what the server can place in `envelope.error.code`.

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

- `allowRoots[0]` is the single authorized workspace root of the Faz A server.
- The default `{"allowRoots":[]}` denies everything: workspace tools answer
  `WORKSPACE_NOT_AUTHORIZED` and nothing is indexed. This is deliberate (explicit
  authorization, default deny).
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

Faz A publishes the five core tools above; sprint-2 Faz B adds `causoryn_index_status`
and `causoryn_refresh_index` (index job management), `causoryn_get_symbol_context`
(Code Explorer relations + evidence) and `causoryn_trace_execution` (bounded
deterministic call-chain paths with per-edge resolution and evidence). Later phases add
impact analysis, preflight and wiki tooling per `wiki/mcp-tools.md`; this plugin's
manifest and skill are updated only when those tools actually exist in the compiled
server.
