<p align="center">
  <img src="https://raw.githubusercontent.com/MrBekoX/Causoryn/main/Causoryn.png" alt="Causoryn — Local, deterministic, zero-LLM code graph and change guard MCP server" width="760" />
</p>

# Causoryn

**Causoryn** is a **local, deterministic, zero-LLM compiler-grade code graph and `preflight -> verify` change guard** for AI coding agents over MCP (`stdio`). It builds evidence-backed graphs for **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust** strictly read-only, defaults to a lean **11-tool `core` profile** (with `--tool-profile wiki`, `history`, and backward-compatible `full` covering all 29 legacy tools), and ships **5 canonical agent skills**.

> **Pre-1.0 release status:** `0.3.0` is a **Pre-1.0** release (not `1.0.0`). The default tool surface is now the 11-tool `core` profile; pass `--tool-profile full` to keep the 29 legacy tool names.
> Package architecture note: `causoryn` is a multi-file runtime package (`dist/mcp-server.mjs`
> + `dist/index-worker.mjs` + vendored N-API v10 `better-sqlite3` prebuild binaries
> + `dist/typescript-lib/` + `native/` sidecar workers + 5 canonical `skills/`),
> not a single-file JS artifact.

---

## Why Causoryn?

- **Zero-LLM static engine:** Analysis, symbol lookup, FTS5 BM25 code localization, verification, and documentation export run locally without model calls, model credentials, or embeddings. The bundled `architecture-blueprint` skill guides your host coding agent to supply optional `annotations`; Causoryn validates schema and graph references fail-closed while prose remains caller-provided.
- **Reproducible exports:** The same snapshot (including metadata) with identical format, view, options, and annotations produces byte-identical artifacts under the same renderer version. Build timestamps, MCP request IDs, job progress, and host-generated annotations can vary ([No-LLM Architecture Policy](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/adr/ADR-002-no-llm.md)).
- **Evidence-backed resolution honesty:** Edges report `verified`, `heuristic`, or `unresolved` resolution. Every `verified` edge carries source-span evidence, and `coverage.byLanguage` reports per-language tiers so one language never masks L0 degradation in another.
- **Read-only source analysis:** Shared workspace SQLite WAL databases (`graph.sqlite`) with heartbeat single-writer leases and per-file `file_facts` early-cutoff caching live strictly outside analyzed roots. Automatic setup also isolates exports outside your workspace; custom `output.allowedOutputDirs` governs explicit export destinations independently of analyzed roots.
- **Offline visual architecture portals:** Zero-JS layered SVG HTML (`view: "architecture"`, default `causoryn-architecture.html`), interactive pan/zoom/search/Evidence Inspector portal (`view: "interactive"`, default `causoryn-architecture-interactive.html`, protected by deterministic `script-src 'sha256-...'` CSP), subgraph Mermaid diagrams, Architecture Brief Markdown, and fail-closed Host-LLM `annotations`.
- **Non-blocking indexing & warm snapshot reads:** Runs background indexing in a dedicated `worker_threads` WAL writer with MCP `notifications/progress`, analyzes `.ts/.tsx/.mts/.cts` and `.js/.jsx/.mjs/.cjs` (ESM + CommonJS) with monorepo workspace resolution and `tsconfig.json`/`jsconfig.json` path aliases, extracts TS & C# `INHERITS`/`IMPLEMENTS` hierarchy edges, honors root/nested `.gitignore` and `.git/info/exclude`, and checks `PRAGMA data_version` before reusing cached snapshots. Historical medians on a 1,000-file TypeScript fixture were `11.8 ms` for `workspace_summary`, `13.0 ms` for `get_symbol_context`, and `10.7 ms` for `map_system` ([Benchmarks](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/benchmarks.md)).

---

## Requirements & Component Runtime Matrix

| Component | Runtime Requirement | Compilation | Offline Behavior |
|---|---|---|---|
| **Core MCP server & SQLite** (`dist/mcp-server.mjs` + `dist/index-worker.mjs` + N-API v10 `better-sqlite3` prebuilds) | **Node.js >= 24** | Zero-compile | 100% offline |
| **TypeScript / JavaScript** (L2 + L3: `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, ESM + CJS, `tsconfig`/`jsconfig` paths, monorepo workspaces, CHA `INHERITS`/`IMPLEMENTS`) | In-process TS Compiler API + bundled `dist/typescript-lib/lib*.d.ts` | Zero-compile | 100% offline |
| **C# / Roslyn** (L2 + L3: CHA `INHERITS`/`IMPLEMENTS`, read-only `obj/project.assets.json` NuGet discovery) | **.NET 10 runtime** (`dotnet exec`, isolated `DOTNET_STARTUP_HOOKS=""`) | Prebuilt deterministic Release Roslyn DLL (zero-compile) | 100% offline |
| **Python** (L2 + L3) | **Python 3.10+** (`python3` then `python` on macOS/Linux, `python` on Windows; run as `-I -B -X utf8`, stdlib `ast`) | Zero-compile | 100% offline |
| **Go** (L1/heuristic + L3: directory + `go.mod` package keying) | **Go 1.26+** (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, stdlib `go/parser`) | On-demand `go run` (or `CAUSORYN_GO_WORKER_BIN`) | 100% offline |
| **Rust** (L1/heuristic + L3: isolated Cargo `cwd` + SHA-256 binary pinning) | **Rust / Cargo** (`syn` 3 sidecar) | On-demand `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` | An uncached build can fetch locked crates from `crates.io`; a populated cache supports offline use |

If an optional language sidecar toolchain (`dotnet`, `python`, `go`, `cargo`) is unavailable on a machine, Causoryn degrades gracefully and honestly to L0/L1 file-level provenance (`npx causoryn@latest doctor` inspects sidecar readiness).

---

## Installation Across All 4 Supported Hosts

You can install Causoryn either via the **interactive/scriptable CLI wizard (`npx causoryn setup`)** or via **each host's native Plugin Marketplace**. For a step-by-step walkthrough, see the **[5-Minute Quickstart Tutorial](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/tutorial-5-minutes.md)**.

### Option A: One-Command CLI Setup (`npx causoryn setup`)

```bash
# Preview planned changes without writing any files
npx causoryn@latest setup --all-detected --dry-run

# Configure all detected hosts (preserves original *.causoryn.backup forever and stages ~/.causoryn/runtime)
npx causoryn@latest setup --all-detected --yes

# Or target specific hosts explicitly
npx causoryn@latest setup --client antigravity --yes
npx causoryn@latest setup --client claude-code --yes
npx causoryn@latest setup --client codex --yes
npx causoryn@latest setup --client zcode --yes

# Opt into extra tool profiles (written into the host entry; kept on later re-runs)
npx causoryn@latest setup --client claude-code --tool-profile core,history --yes

# Verify installation health (read-only; reports HEALTHY, DEGRADED, NOT CONFIGURED, or UNHEALTHY;
# a toolchain below its floor — Python 3.10, Go 1.26, .NET 10 runtime — reports DEGRADED)
npx causoryn@latest doctor

# Cleanly remove Causoryn from a host (cleans up ~/.causoryn/runtime when no remaining host points to it)
npx causoryn@latest setup --client claude-code --uninstall --yes
```

With no detected host and no `--client`/`--all`, `setup` writes nothing and exits with code 1. Re-running `setup` only rewrites the keys it owns (`command`, `args` with your `--tool-profile`/`--output-schema` kept, `type: "stdio"` for Claude Code and ZCode, and Codex `startup_timeout_sec`, raised to at least 30); `env`, `disabled`, `autoApprove`, `alwaysAllow`, `timeout` and any other key you added keep their value and position, and an up-to-date entry is not rewritten.

### Option B: Native Host Plugin Marketplaces

1. **Antigravity** (`agy` / Antigravity IDE):
   - Add the repository (`https://github.com/MrBekoX/Causoryn`) or extracted `causoryn` plugin folder containing `plugin.json` and `mcp_config.json`, or run `npx causoryn@latest setup --client antigravity --yes` (writes `~/.gemini/config/mcp_config.json`, updates `~/.gemini/antigravity/mcp_config.json` when present, and installs the 5 skills into `~/.gemini/config/skills/`).
2. **Claude Code**:
   - In Claude Code, register the GitHub marketplace and install the plugin:
     ```text
     /plugin marketplace add MrBekoX/Causoryn
     /plugin install causoryn@causoryn
     ```
   - Or run `npx causoryn@latest setup --client claude-code --yes` (`~/.claude.json` + `~/.claude/skills/`).
3. **Codex** (Codex CLI / Desktop):
   - Add the repository marketplace (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`) via Codex plugin management, or run `npx causoryn@latest setup --client codex --yes` (`$CODEX_HOME/config.toml` `[mcp_servers.causoryn]` with `startup_timeout_sec` of at least 30 — a higher value you set is kept — + `~/.agents/skills/`).
4. **ZCode (GLM)**:
   - Open **Plugin Marketplace -> New / Discover**, add `https://github.com/MrBekoX/Causoryn` (uses root `marketplace.json` and `.zcode-plugin/plugin.json`), and install `causoryn`.
   - Or run `npx causoryn@latest setup --client zcode --yes` (writes `~/.zcode/cli/config.json` `mcp.servers.causoryn` while preserving any existing `~/.agents/mcp.json` fallback servers, plus `~/.zcode/skills/`).

---

## Example Prompts: Deterministic vs. Annotated

- **Deterministic / Pure Structural (no `annotations`):**
  - `"Use Causoryn to run a preflight impact and contract check before modifying src/services/orders-service.ts."`
  - `"Export a purely structural, model-free interactive architecture diagram of this repo using Causoryn without annotations."`
- **Host-LLM Annotated Interactive Portal (no skill name needed):**
  - `"Create a comprehensive, evidence-grounded interactive architecture portal for this project using Causoryn."`
  - `"Causoryn kullanarak bu projenin kapsamlı, kanıta dayalı etkileşimli mimari portalını oluştur."`

Full prompting recipes and `annotations` contract reference:
**[Prompting & Architecture Portals Guide (EN)](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/prompting-and-architecture-portals.md)** · **[Prompt ve Mimari Portal Rehberi (TR)](https://github.com/MrBekoX/Causoryn/blob/main/docs/prompting-and-architecture-portals.md)**

---

## Read-Only Workspace & Zero-Config Authorization

- **Shared external storage and export paths:** Automatic setup provisions a single shared workspace SQLite database (`~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite`, overridable via `--data-dir` or `ZCODE_PLUGIN_DATA`) with heartbeat single-writer leases and orphan-build recovery across hosts. With manual configuration, keep `output.allowedOutputDirs` outside the source tree for an out-of-tree export workflow ([CLI & Configuration](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/cli-and-configuration.md)).
- **Zero-config CLI flags (`--allow-cwd --auto-data-dir`):** When launched inside a safe project directory, `--allow-cwd` authorizes that project root automatically (rejecting UNC/device paths, `$HOME` and its ancestors, OS directories, and plugin/data roots before any filesystem lookup). When launched by a desktop IDE from `$HOME`, filesystem root, or a plugin directory, Causoryn dynamically binds the active workspace via MCP `roots/list` (`notifications/roots/list_changed`).
- **Explicit `CAUSORYN_CONFIG` (`allowRoots`):** Bare `node dist/mcp-server.mjs` without CLI flags preserves strict default-deny (`{"allowRoots":[]}`) until a project path such as `{"allowRoots":["/work/my-service"]}` is explicitly declared.

---

## Tool Profiles & Published MCP Tools

By default (`--tool-profile core` or `CAUSORYN_TOOL_PROFILE=core`), Causoryn publishes a lean **11-tool core catalog** (`tools/list <= 15,000` characters) combining three consolidated dispatchers (**causoryn_status**, **causoryn_trace**, **causoryn_contracts**) with eight focused graph, preflight, verification, evidence, and export tools (`causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_get_evidence`, `causoryn_export_documentation`).

Pass `--tool-profile wiki` (+7 Living Wiki tools), `--tool-profile history` (+2 Git history tools), `--tool-profile wiki,history`, or `--tool-profile full` (all 29 legacy tools below + the 3 consolidated core tools = 32 tools total).

### Complete Legacy & Extension Catalog (29 Tools — `TOOL_NAMES`)

Every tool listed below is genuinely implemented and registered by the compiled server under `--tool-profile full` (or its respective profile):

1. `causoryn_get_capabilities` — Adapter levels (L0–L3), server limits, protocol version, and published tool list *(consolidated into **causoryn_status** in `core`)*.
2. `causoryn_workspace_summary` — Language, project, entrypoint, and edge-resolution summary of the published snapshot *(consolidated into **causoryn_status** in `core`)*.
3. `causoryn_index_status` — Background/completed indexing job status, snapshot freshness, and diagnostics *(consolidated into **causoryn_status** in `core`)*.
4. `causoryn_refresh_index` — Starts a full or incremental workspace indexing job into the external data root *(consolidated into **causoryn_status** `action: "refresh"` in `core`)*.
5. `causoryn_map_system` — Paginated L0–L3 architecture hierarchy map (plus `profile: "onboarding"` in `core`) with kind/path filters and cursor pagination.
6. `causoryn_find_symbols` — Deterministic ranked symbol lookup with candidate disambiguation.
7. `causoryn_get_symbol_context` — Neighborhood graph and source-span evidence around a symbol or node ID.
8. `causoryn_trace_execution` — Bounded deterministic call/route chain tracing with per-edge resolution *(consolidated into **causoryn_trace** `mode: "execution"` in `core`)*.
9. `causoryn_trace_business_flow` — Cross-component business and contract flow tracing with honest `gap` reporting *(consolidated into **causoryn_trace** `mode: "business-flow"` in `core`)*.
10. `causoryn_analyze_impact` — Reverse-edge BFS blast-radius analysis (excluding noisy `CONTAINS` edges, including `INHERITS`/`IMPLEMENTS`) keeping `certainty` and `resolution` separate *(consolidated into `causoryn_preflight_change` in `core`)*.
11. `causoryn_check_architecture` — Evaluates `.causoryn/architecture.rules.yaml` (`no-cycles` SCC + forbidden dependencies) *(consolidated into `causoryn_verify_change` in `core`)*.
12. `causoryn_compare_architecture` — Read-only git ref architectural comparison (`baseRef` vs `targetRef`, `history` profile).
13. `causoryn_get_agent_context` — Ranked, budget-bounded code localization across identifier/path tokenization, SQLite FTS5 BM25, graph proximity, and contract legs.
14. `causoryn_generate_onboarding` — Structural onboarding guide (entrypoints, high-centrality modules, SCC learning order; consolidated into `causoryn_map_system` `profile: "onboarding"` in `core`).
15. `causoryn_export_documentation` — Atomic visual architecture portal & documentation export (`json`, `markdown`, `mermaid`, `html`, `snapshot`; `view: architecture | interactive | full`, optional fail-closed Host-LLM `annotations`) to `output.allowedOutputDirs`.
16. `causoryn_preflight_change` — Candidate-only pre-change impact, contract, and test-plan manifest (`candidateOnly: true`).
17. `causoryn_check_contracts` — Static compatibility classification across OpenAPI, AsyncAPI, JSON Schema, SQL, and Protobuf pairs *(consolidated into **causoryn_contracts** `action: "check"` in `core`)*.
18. `causoryn_detect_contract_drift` — Revision-to-revision contract drift and producer/consumer anchor impact detection *(consolidated into **causoryn_contracts** `action: "drift"` in `core`)*.
19. `causoryn_verify_change` — Deterministic post-change verification across `architecture`, `graph-diff`, `test-plan`, and optional `contracts`, loading Git rules from trusted `baseRef` and labeling host-reported tests as `host_asserted`.
20. `causoryn_derive_test_plan` — Content-addressed (`testplan:<sha256>`) candidate test plan (accepts `changeSet` or `preflightId`) without executing tests *(consolidated into `causoryn_preflight_change` in `core`)*.
21. `causoryn_get_evidence` — Source file, line span, hash, and analyzer provenance lookup for nodes, edges, and findings.
22. `causoryn_architecture_timeline` — Sampled multi-revision architectural evolution over read-only git history (`history` profile).
23. `causoryn_wiki_build` — Projects the published graph snapshot into a deterministic Living Wiki SQLite snapshot (`wiki.dataDbPath`, `wiki` profile).
24. `causoryn_wiki_get_tree` — Paginated 12-category Living Wiki taxonomy tree with freshness and coverage metadata (`wiki` profile).
25. `causoryn_wiki_get_page` — Section-paginated Living Wiki page reader with `evidenceRefs` and `sourceRefs` (`wiki` profile).
26. `causoryn_wiki_search` — Escaped multi-field FTS5 search over Living Wiki pages (`wiki` profile).
27. `causoryn_wiki_get_links` — Outgoing links, reverse-indexed backlinks, and `brokenLinkDiagnostics` (`wiki` profile).
28. `causoryn_wiki_get_versions` — Read-only git/snapshot version availability for Living Wiki pages (`wiki` profile).
29. `causoryn_wiki_diff` — Structural diff (`changedSections`, `coverageDelta`, `contractChanges`) between two Living Wiki snapshots (`wiki` profile).

---

## Envelope Error Codes (`CAUSORYN_TOOL_ERROR_CODES` & Reserved Catalog)

Active envelope error codes exported in `CAUSORYN_TOOL_ERROR_CODES` (15 codes):
- `WORKSPACE_NOT_AUTHORIZED`
- `PATH_DENIED`
- `INDEX_NOT_READY`
- `AMBIGUOUS_SYMBOL`
- `LIMIT_EXCEEDED`
- `INVALID_ARGUMENT`
- `EVIDENCE_NOT_FOUND`
- `SYMBOL_NOT_FOUND`
- `POLICY_INVALID`
- `INVALID_REVISION`
- `EXPORT_NOT_ALLOWED`
- `WIKI_PAGE_NOT_FOUND`
- `CONTRACT_PARSE_FAILED`
- `UNSUPPORTED_LANGUAGE`
- `INTERNAL_ERROR`

Reserved catalog identifiers not emitted as envelope errors in `0.3.0` (6 codes; 21 total identifiers):
- `UNRESOLVED_FLOW`
- `STALE_PREFLIGHT`
- `CANCELLED`
- `WIKI_REVISION_NOT_AVAILABLE`
- `WIKI_BROKEN_LINK`
- `WIKI_NOTE_CONFLICT`

---

## Documentation (English & Türkçe)

- **[English Documentation Hub](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/README.md)** — [5-Minute Quickstart Tutorial](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/tutorial-5-minutes.md) · [Prompting & Architecture Portals](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/prompting-and-architecture-portals.md) · [Architecture](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/architecture.md) · [CLI & Configuration](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/cli-and-configuration.md) · [5-Language Analyzers](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/language-analyzers.md) · [MCP Tool Contracts](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/tool-contracts.md) · [Compatibility Matrix](https://github.com/MrBekoX/Causoryn/blob/main/docs/en/compatibility-matrix.md)
- **[Türkçe Dokümantasyon Merkezi](https://github.com/MrBekoX/Causoryn/blob/main/docs/README.md)** — [Prompt ve Mimari Portal Rehberi](https://github.com/MrBekoX/Causoryn/blob/main/docs/prompting-and-architecture-portals.md) · [Mimari Özeti](https://github.com/MrBekoX/Causoryn/blob/main/docs/architecture.md) · [CLI ve Konfigürasyon](https://github.com/MrBekoX/Causoryn/blob/main/docs/cli-and-configuration.md) · [5-Dil Analizörleri](https://github.com/MrBekoX/Causoryn/blob/main/docs/language-analyzers.md) · [MCP Araç Sözleşmeleri](https://github.com/MrBekoX/Causoryn/blob/main/docs/tool-contracts.md) · [Uyumluluk Matrisi](https://github.com/MrBekoX/Causoryn/blob/main/docs/compatibility-matrix.md)
- **[Bilingual Architecture & Project Overview (TR · EN)](https://github.com/MrBekoX/Causoryn/blob/main/docs/project-overview.tr-en.md)**

---

## Governance, Security & License

- **Security policy:** [SECURITY.md](https://github.com/MrBekoX/Causoryn/blob/main/SECURITY.md)
- **Contributing:** [CONTRIBUTING.md](https://github.com/MrBekoX/Causoryn/blob/main/CONTRIBUTING.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](https://github.com/MrBekoX/Causoryn/blob/main/CODE_OF_CONDUCT.md)
- **Third-party notices:** `THIRD-PARTY-NOTICES.md` (included in package)
- **License:** [MIT](LICENSE)
