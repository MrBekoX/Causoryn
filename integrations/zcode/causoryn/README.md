# Causoryn for ZCode

> **Monorepo development fixture:** this directory (`integrations/zcode/causoryn`) is a local development and test fixture of the Causoryn monorepo. End users install Causoryn with `npx causoryn@0.3.2 setup --client zcode --yes` or by adding the repository root marketplace (`https://github.com/MrBekoX/Causoryn`, root `marketplace.json`) in ZCode. See the [ZCode host guide](../../../docs/en/hosts/zcode.md).

**Causoryn** is a local, **LLM-free** code-analysis engine exposed to ZCode as a `stdio` MCP server. It builds a read-only graph of an authorized workspace (files, symbols, calls, routes, contracts, tests) in which every edge carries source evidence. The distribution package also ships the `architecture-blueprint` skill for preparing optional, caller-supplied `annotations`. With the same snapshot and export inputs, exported artifacts are reproducible; prose written by the host model can vary.

## What it provides

- One MCP server (`causoryn`, `type: "stdio"`, launched with `node`) declared in
  `.zcode-plugin/plugin.json`.
- One routing skill: `skills/map-system/SKILL.md` teaches the host model when and how to
  call `causoryn_map_system`.
- Tool profiles. The server registers only the tools of the active profile in `tools/list`:

| Profile | Registered tools |
| --- | --- |
| `core` *(default)* | the 11 consolidated tools listed below |
| `wiki` | `core` + the 7 Living Wiki tools (18) |
| `history` | `core` + the 2 architecture-history tools (13) |
| `wiki,history` | `core` + both extensions (20) |
| `full` | the 29 legacy tool names plus `causoryn_status`, `causoryn_trace` and `causoryn_contracts` (32), for backward compatibility |

Empty handlers are never advertised: every registered tool is implemented.

### Default `core` profile (11 tools)

| Tool | Purpose |
| --- | --- |
| `causoryn_status` | Capabilities, coverage tiers, workspace summary and index job progress (`action: "inspect"`, default); queues a background `incremental` or `full` re-index job (`action: "refresh"`). |
| `causoryn_map_system` | Architecture map pages at `level` L0–L3 with `filters`, `maxNodes` and `cursor` pagination; `profile: "onboarding"` returns structured onboarding data (entry points, central modules, learning order, critical flows, risk areas). |
| `causoryn_find_symbols` | Ranked symbol search over qualified names; several exact matches return `AMBIGUOUS_SYMBOL` with candidates. |
| `causoryn_get_symbol_context` | Symbol node, neighboring edges up to the requested depth (`edgeKinds` filter, deterministic order) and the backing evidence records. |
| `causoryn_trace` | Bounded call paths over `CALLS` + `ROUTES_TO` from an endpoint or symbol (`mode: "execution"`, default), or cross-component request/event/contract flows with honest `gap` segments (`mode: "business-flow"`). Every edge keeps its own resolution and evidence. |
| `causoryn_get_agent_context` | Ranked, token-budgeted context package for a task; the task text is used only as a search query and degraded legs are reported explicitly. |
| `causoryn_preflight_change` | Candidate-only Preflight Manifest: impact candidates (certainty and resolution in separate fields), contract checks, test plan, limitations and a read-only source revision. `include: ["impact"]` / `include: ["test-plan"]` return the impact report or the test plan alone. It never writes code. |
| `causoryn_verify_change` | Post-change verification against a preflight manifest or base snapshot: architecture rules, contracts, graph diff and test plan, with the verdict `no_findings`, `review_required`, `blocking_findings` or `inconclusive`. It writes no code and runs no tests; `no_findings` is not a correctness or safety guarantee. |
| `causoryn_contracts` | OpenAPI / AsyncAPI / JSON Schema / SQL / Protobuf compatibility checks (`action: "check"`, default) and producer/consumer drift impact (`action: "drift"`). |
| `causoryn_get_evidence` | Evidence provenance (source file, lines, hash, analyzer, rationale) for a node, edge, evidence or finding ID. |
| `causoryn_export_documentation` | Exports the published snapshot as `json`, `markdown`, `mermaid`, `html` or `snapshot`. Visual formats default to `view: "architecture"`; `"interactive"` is HTML-only and `"full"` returns the raw graph. Optional `annotations` are validated against the projection. Files are written atomically and only under `output.allowedOutputDirs`; other directories return `EXPORT_NOT_ALLOWED`. |

### Opt-in profiles

- **`wiki`** adds the Living Wiki tools: `causoryn_wiki_build` (the only wiki tool that
  writes, and only to the declared `wiki.dataDbPath`), `causoryn_wiki_get_tree`,
  `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links`,
  `causoryn_wiki_get_versions` and `causoryn_wiki_diff`.
- **`history`** adds `causoryn_compare_architecture` (architecture diff between two Git refs,
  read through read-only Git) and `causoryn_architecture_timeline` (sampled architecture
  history over refs or a bounded range).
- **`full`** keeps every legacy tool name from releases before 0.3.0. Legacy tools that a
  core tool replaces are marked deprecated in their description and response warnings; their
  data is unchanged:

| Legacy tool (`full` only) | Core replacement |
| --- | --- |
| `causoryn_get_capabilities` | `causoryn_status` (`action: "inspect"`) |
| `causoryn_workspace_summary` | `causoryn_status` (`action: "inspect"`) |
| `causoryn_index_status` | `causoryn_status` (`action: "inspect"`) |
| `causoryn_refresh_index` | `causoryn_status` (`action: "refresh"`) |
| `causoryn_generate_onboarding` | `causoryn_map_system` (`profile: "onboarding"`) |
| `causoryn_trace_execution` | `causoryn_trace` (`mode: "execution"`) |
| `causoryn_trace_business_flow` | `causoryn_trace` (`mode: "business-flow"`) |
| `causoryn_analyze_impact` | `causoryn_preflight_change` (`include: ["impact"]`) |
| `causoryn_derive_test_plan` | `causoryn_preflight_change` (`include: ["test-plan"]`) |
| `causoryn_check_architecture` | `causoryn_verify_change` (`checks: ["architecture"]`) |
| `causoryn_check_contracts` | `causoryn_contracts` (`action: "check"`) |
| `causoryn_detect_contract_drift` | `causoryn_contracts` (`action: "drift"`) |

The other legacy names (the eight tools that keep their names in `core`, the two `history`
tools and the seven `wiki` tools) are also part of `full`.

**Selecting a profile.** Precedence is `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` >
`CAUSORYN_CONFIG.toolProfile` > `core`; unknown names stop the server at startup.

- This fixture launches the bare bundle entrypoint, which reads **no command-line flags**. To
  get the legacy names, add `"CAUSORYN_TOOL_PROFILE": "full"` (or `wiki`, `history`,
  `wiki,history`) to the `env` block of `mcpServers.causoryn` in `.zcode-plugin/plugin.json`.
- The packaged CLI entry written by `npx causoryn@0.3.2 setup --client zcode --yes` accepts
  the flag: run `npx causoryn@0.3.2 setup --client zcode --tool-profile full --yes`, or append
  `"--tool-profile", "full"` to its `args` in `~/.zcode/cli/config.json`; re-running setup keeps it.
  `--output-schema full` additionally advertises output schemas in `tools/list`.

### Response envelope and error codes

All responses use the standard 10-field envelope: `schemaVersion, requestId, workspaceId,
snapshotId, status, coverage, warnings, data, nextCursor, error`. The fixed envelope error
codes are exported by the compiled server as `CAUSORYN_TOOL_ERROR_CODES`
(`WORKSPACE_NOT_AUTHORIZED`, `PATH_DENIED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`,
`LIMIT_EXCEEDED`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND`,
`POLICY_INVALID`, `INVALID_REVISION`, `EXPORT_NOT_ALLOWED`, `WIKI_PAGE_NOT_FOUND`,
`CONTRACT_PARSE_FAILED`, `UNSUPPORTED_LANGUAGE`, `INTERNAL_ERROR`). This set is exactly what
the server can place in `envelope.error.code` (see `packages/mcp-server/src/errors.ts`).
Domain, policy and authorization errors are returned inside the envelope; they never crash the
MCP connection.

## Requirements

- **Node.js >= 24** (the plugin launches the server with `node`; the monorepo targets the same
  engine via `engines`).
- The compiled server bundle of the Causoryn monorepo:
  `packages/mcp-server/dist/mcp-server.mjs`. The manifest resolves it as
  `${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs`; run
  `npm run build:bundle --workspace packages/mcp-server` if the file is missing. The bundle
  keeps `better-sqlite3` external: its native `.node` binaries cannot be embedded, so the build
  copies the runtime (`lib/` + `prebuilds/`) next to the bundle as
  `dist/node_modules/better-sqlite3/`, together with the `index-worker.mjs` indexing worker.
  The whole `packages/mcp-server/dist/` directory must stay together; it is not a single file.
- A workspace root you authorize (see below).

## Installation

1. Build the monorepo once in the Causoryn checkout that contains this plugin under
   `integrations/zcode/causoryn`: `npm install` (repository root), then
   `npm run build:bundle --workspace packages/mcp-server`.
2. In ZCode, open **Settings → Plugin Management → Discover** and add the marketplace root
   with the **+** button as a local directory: this repository's `integrations/zcode`
   directory. Its `.claude-plugin/marketplace.json` (development marketplace `causoryn-dev`)
   lists `causoryn` with the relative directory source `./causoryn`. ZCode has no plugin CLI
   (`zcode --help` / `zcode plugin --help` are not available; the desktop app manages plugins
   in this GUI), so installation is a GUI step, not a command. This GUI step is not run by the
   automated test suites.
3. Install **causoryn** from the market list and keep it enabled.
4. Configure the workspace root declaration (next section), then reload the plugin so the
   MCP server picks up the new config.

The bundle and its vendored `better-sqlite3` runtime are build artifacts and are never
committed; CI and release steps produce them.

## Workspace root declaration (allowRoots)

The bundle entrypoint reads its entire configuration from the `CAUSORYN_CONFIG` environment
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
    "args": ["${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs"],
    "cwd": "${CLAUDE_PROJECT_DIR}",
    "env": { "CAUSORYN_CONFIG": "${user_config.config_json}" }
  }
}
```

Set **Causoryn server config (JSON)** in the plugin settings, for example:

```json
{"allowRoots":["C:/projects/my-app"], "workspaceId": "my-app"}
```

- `allowRoots[0]` is the single authorized workspace root of the server.
- The default `{"allowRoots":[]}` denies everything: workspace tools answer
  `WORKSPACE_NOT_AUTHORIZED` and nothing is indexed. This is deliberate (explicit
  authorization, default deny).
- `storage.dataDbPath` (optional absolute path) declares the SQLite file for the persistent
  graph index. It must lie outside every `allowRoots` root and its parent directory must
  exist; otherwise the server refuses to start. Without it the graph is kept in memory and
  nothing is written to disk.
- `output.allowedOutputDirs` (optional array) declares the only directories
  `causoryn_export_documentation` may write to. Declared directories must already exist;
  without a declaration (the default) every export answers `EXPORT_NOT_ALLOWED` and nothing
  is written.
- `wiki.dataDbPath` (optional absolute path, `wiki` or `full` profile) declares the only file
  `causoryn_wiki_build` may write. The same rules apply: absolute path, existing parent
  directory, outside the workspace root. Without it `causoryn_wiki_build` answers
  `PATH_DENIED` and the wiki read tools answer `INDEX_NOT_READY`.
- No credentials, tokens or API keys exist in this plugin; the engine is fully local.

## Security model

- **Read-only analysis.** Causoryn reads the authorized source tree and never writes to it.
  SQLite writes go only to the declared data files outside the workspace, and export writes
  require `output.allowedOutputDirs`.
- **Explicit root authorization.** Only roots listed in `allowRoots` are indexable; symlink
  escapes, ignore rules and size/binary filters are enforced by the workspace access policy.
- **LLM-free analysis and rendering.** The MCP server makes no model or embedding calls. The
  host model runs separately and can supply optional annotations.
- **Clean stdio.** The server process writes only MCP protocol traffic to `stdout`; logs go to
  `stderr`.

## Scope note

Causoryn 0.3.0 changed the default tool surface: the `core` profile with 11 consolidated tools
replaces the 29-tool catalog of earlier releases as the default. The legacy names remain
available unchanged with `CAUSORYN_TOOL_PROFILE=full` (this fixture) or `--tool-profile full`
(packaged CLI). Full tool contracts: [MCP Tool Contracts](../../../docs/en/tool-contracts.md).
