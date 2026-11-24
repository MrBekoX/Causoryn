# Causoryn Architecture Overview (Code-Facing)

> **Language:** [Türkçe](../architecture.md) | **English** · [Documentation Hub](README.md)
>
> **Status:** reflects Causoryn 0.3.0 (pre-1.0; default `core` tool profile, one shared `graph.sqlite` per workspace, `worker_threads` indexing). Status columns follow the project honesty rule — nothing that does not work is called Done — and are cross-checked against [Implementation Status](implementation-status.md).
>
> **Scope:** the monorepo has **18 npm workspace packages** (`12 packages/*` + `5 adapters/*` + `1 integrations/zcode/causoryn`; **19 `package.json` manifests** including the monorepo root), the standalone `apps/visualizer`, 4 `native/*` language sidecars, root 4-host plugin marketplace manifests, 5 GitHub Actions workflows (`.github/workflows/{ci,release,security,codeql,scorecard}.yml`), `.github/dependabot.yml`, and `integrations/antigravity/causoryn`. The historical `v0.1.0` tag stays frozen at `4c9c188f`.

This page maps the packages in this repository to the architecture they implement: which package owns what, which way dependencies may point, how data flows from a workspace to an MCP response, and which build, determinism, and packaging contracts hold.

## End-to-End Pipeline

```text
Workspace Gateway (UNC/device pre-check + allowRoots + root-safety checks)
  -> File Inventory (collectInventoryAsync, ignore rules, size/binary filters)
  -> Language/Framework Adapters (TS/JS in-process; C#/Python/Go/Rust sidecars)
  -> Normalization & Symbol / Hierarchy (CHA) / Contract Resolution
  -> Unified Evidence Graph -> Immutable Snapshot (streaming SHA-256 ID)
  -> Published in the shared graph.sqlite (single writer via build_leases)
  -> Domain Queries & Verification -> MCP structuredContent (11-tool core profile)
  -> Host-selected model (external MCP client)
```

All analysis runs locally inside Causoryn with no LLM, embedding, or model dependency. The host coding agent is an external MCP client that reads the structured output ([No-LLM decision record](adr/ADR-002-no-llm.md)).

## Data Flow

1. **Startup and root authorization.** `causoryn mcp` (or the host plugin launcher) starts the stdio server. `--root <path>`, `--allow-cwd`, or MCP `roots/list` supply candidate roots; every root passes the Workspace Gateway, which rejects UNC/device paths lexically before any filesystem call. For `--allow-cwd` and `roots/list` candidates, `inspectProjectRootSafety` (`packages/mcp-server/src/runtime-cli.ts`) also rejects filesystem roots, `$HOME` and its ancestors, Causoryn data and plugin install directories, sensitive user directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), and OS system directories.
2. **Storage selection.** With `--auto-data-dir` or `--data-dir` (both registered by `causoryn setup`), `buildWorkspaceAutoConfig` places one SQLite file per workspace at `<base>/workspaces/<slug>-<hash12>/graph.sqlite` plus an `exports/` directory, and sets both `storage.dataDbPath` and `wiki.dataDbPath` to that file. The base directory is `--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`. Directories are created with mode `0700` and must lie strictly outside the authorized roots. Without a declared `storage.dataDbPath`, the server uses the process-local `InMemoryGraphRepository`.
3. **Non-blocking first index.** The stdio entry point defers the first index (`deferAutoIndex`): `initialize` and `tools/list` answer immediately, and a background full index starts unless a published snapshot already exists. When the graph store is a SQLite file, `IndexJobManager` (`packages/indexing/src/job-manager.ts`) runs the job in a `worker_threads` worker (`index-worker-core.ts`, bundled as `dist/index-worker.mjs`); with the in-memory repository, or if the worker entry cannot be used, it runs the same pipeline in-process and asynchronously. Clients that send `_meta.progressToken` receive `notifications/progress`.
4. **Inventory and analysis.** `collectInventoryAsync` yields to the event loop every 64 entries. TypeScript/JavaScript run in-process; `.cs`, `.py`, `.go`, and `.rs` files are routed to their sidecar adapters, and all outputs merge into one snapshot. Shared pathless external or virtual nodes (for example `UnknownExternal`) are merged across analyzers; identity collisions between file-bound nodes are rejected.
5. **Incremental re-index.** `causoryn_status` with `action: "refresh"` (`mode: "incremental" | "full"`) queues a job. Incremental runs read per-file facts from `file_facts` (content hash, analyzer fingerprint, public-interface hash, imported paths, serialized nodes/edges/evidence). Only changed files, and their direct reverse dependents when the public interface changed, are re-analyzed (early cutoff); TypeScript reuses the previous `ts.Program` (`oldProgram`). When the invalidation cascade does not converge or cached facts are inconsistent, the run falls back to a full build. `tests/incremental-early-cutoff.test.ts` asserts that incremental snapshot IDs equal a clean full build.
6. **Publish.** A build starts as a `building` row that no reader can see, then transitions to `ready` or `partial` in one SQLite transaction. Publishing requires the workspace's `build_leases` row (`lease_id`, `owner_pid`, `host_label`, `heartbeat_at`, `expires_at`; default TTL 30 s, heartbeat every 10 s), so two processes cannot publish to the same workspace concurrently. `recoverOrphanBuilds` marks `building` rows that are not owned by a live lease as `failed` (`orphan-build-recovered`) and deletes the stale lease. After a publish, `pruneOldSnapshots` keeps the newest 2 published snapshots (and the last 2 failed builds), deletes orphaned `symbol_fts` rows, and runs a best-effort WAL checkpoint.
7. **Query.** Tools other than `causoryn_status` wait up to `CAUSORYN_INDEX_WAIT_MS` (default 15000 ms; `0` means do not wait) for the first index. If it is still running they return `status: "partial"` with `data.status: "indexing"`, `jobId`, `progress`, and `retryAfterMs`. While a re-index runs, responses carry a `stale=true` warning and serve the latest published snapshot. Warm startup reads `getLatestSnapshotMeta` instead of hydrating the full graph.
8. **Respond.** Each tool returns the 10-field envelope (`schemaVersion: "2.0"`) as MCP `structuredContent`, including `coverage.tier` and per-language `coverage.byLanguage`. Errors use the fixed catalog of 15 codes (`packages/mcp-server/src/errors.ts`). See [MCP Tool Contracts](tool-contracts.md).
9. **Export.** `causoryn_export_documentation` writes only into authorized output directories (`output.allowedOutputDirs`, or the auto-configured `exports/` directory) using exclusive temp files and atomic renames.

### MCP Surface: Tool Profiles and `outputSchema`

- **Profiles** (`packages/mcp-server/src/version.ts`): the default `core` profile registers 11 tools (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`). `wiki` adds the 7 `causoryn_wiki_*` tools; `history` adds `causoryn_compare_architecture` and `causoryn_architecture_timeline`; profiles combine with commas (`--tool-profile wiki,history`). `full` registers the 29 legacy tool names plus `causoryn_status`, `causoryn_trace`, and `causoryn_contracts` (32 tools); in `full`, superseded legacy tools carry `(Deprecated: use <replacement>)` in their description and a deprecation warning in the envelope.
- **Selection:** `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` > `core`. Invalid names are rejected at startup.
- **`outputSchema`** is omitted from `tools/list` by default (`--output-schema omit|full`, alias `--output-schema-profile`; env `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE`). In `omit` mode the server still parses every response envelope with the tool's Zod output schema before returning it. The core `tools/list` payload stays within a 15,000-character budget (`tests/mcp-tool-surface-budget.test.ts`).
- **Tool annotations:** every tool carries MCP `annotations` (`readOnlyHint`, `destructiveHint`).
- **`--client <id>`** is only a diagnostic label stored in `build_leases.host_label`; all hosts that open the same workspace share one `graph.sqlite` (earlier releases used per-host `graph-<client>.sqlite` files).

### Visual Architecture Portals

`packages/graph` produces offline architecture artifacts through adaptive module projection, Tarjan SCC, and Sugiyama-style SVG layout. `view="architecture"` writes zero-JS `causoryn-architecture.html` (`default-src 'none'`); `view="interactive"` writes `causoryn-architecture-interactive.html` with a `script-src 'sha256-...'` CSP computed from the embedded script (no `'unsafe-inline'` script permission). Optional host-written `annotations` are validated against the schema, size budgets, and graph/projection IDs (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`), collecting up to 25 errors per call under `INVALID_ARGUMENT` (`packages/graph/src/architecture-annotations.ts`). See [Prompting & Architecture Portals](prompting-and-architecture-portals.md).

## Layered Dependency & Distribution Diagram

```mermaid
flowchart TD
    subgraph L0["Layer 0 — Leaf Domain & Security Gateways"]
        DOM["packages/domain<br/>Zod schemas, canonical JSON, streaming SHA-256 IDs"]
        IPC["packages/sidecar-ipc<br/>NDJSON framing, shell:false, timeouts, allowlisted env"]
        WS["packages/workspace<br/>path-safety (UNC pre-check), WorkspaceAccessPolicy, OutputAccessPolicy"]
    end

    subgraph L1["Layer 1 — Language Adapters, Storage & Contracts"]
        TSA["adapters/typescript<br/>In-process TS/JS/CJS + workspaces + CHA INHERITS/IMPLEMENTS + Test"]
        CSA["adapters/csharp-roslyn<br/>↔ native/roslyn-worker (.NET 10 DLL, CHA, read-only NuGet)"]
        PYA["adapters/python<br/>↔ native/python-worker (python -I -B -X utf8, stdlib ast)"]
        GOA["adapters/go<br/>↔ native/go-worker (GOTOOLCHAIN=local, directory + go.mod keying)"]
        RSA["adapters/rust<br/>↔ native/rust-worker (syn 3, trusted Cargo cwd + SHA-256 pin)"]
        SQL["packages/storage-sqlite<br/>SQLite WAL schema v4 (build_leases, file_facts, symbol_fts, wiki_*)"]
        CON["packages/contracts<br/>OpenAPI / AsyncAPI / SQL / JSON Schema / Protobuf discovery & drift"]
    end

    subgraph L2["Layer 2 — Orchestration, Querying, Verification & Projection"]
        IDX["packages/indexing<br/>IndexService, IndexJobManager (worker_threads), file_facts, fp3 fingerprint"]
        GR["packages/graph<br/>Traversal, impact, guard, read-only git, agent context, portals"]
        PRE["packages/preflight<br/>candidateOnly manifest + derive_test_plan"]
        VER["packages/verification<br/>verify_change core (4 checks, host_asserted tests)"]
        WIK["packages/wiki<br/>Living Wiki projection, 11 link kinds, FTS5 search"]
        VIS["apps/visualizer<br/>Offline HTML+SVG viewer generator (strict CSP)"]
    end

    subgraph L3["Layer 3 — MCP Protocol, CLI & 4-Host Distribution"]
        MCP["packages/mcp-server<br/>stdio transport, tool profiles (11 core / 32 full), 10-field envelope"]
        CLI["packages/causoryn<br/>causoryn setup | doctor | mcp + plugin-mcp-launcher.mjs"]
        HOSTS["4 Host Environments<br/>Antigravity · Claude Code · Codex · ZCode (GLM)"]
    end

    DOM --> TSA & CSA & PYA & GOA & RSA & SQL & CON & GR & PRE & VER & WIK
    IPC --> CSA & PYA & GOA & RSA
    WS --> IDX & MCP
    TSA & CSA & PYA & GOA & RSA --> IDX
    SQL --> MCP
    CON --> PRE & VER & MCP
    GR --> PRE & VER & WIK & MCP
    IDX & PRE & VER & WIK --> MCP
    DOM --> VIS
    MCP --> CLI --> HOSTS
```

## Dependency Rules (Fixed Boundaries)

1. `packages/domain` never imports any MCP, language adapter, or host package; it depends only on its own modules and `zod`.
2. Language adapters implement fixed input/output snapshot contracts. If an adapter or sidecar crashes, times out, or its toolchain is missing, the engine keeps running and degrades that language to L0/L1 file provenance (`partial` + explicit `warnings` + `coverage.byLanguage`).
3. `packages/mcp-server` consumes application-level service interfaces only; compiler/AST internals never leak into MCP tool handlers.
4. Visualization renders published graph JSON as-is and never invents edges or evidence.
5. Plugin skills (`skills/*/SKILL.md`) guide the host-selected model's workflow; they never select, route, or call models.
6. Workspaces are read-only: Causoryn writes only to its own data directory and to explicitly authorized export directories. Git access is read-only (`cat-file`, `ls-tree`, constrained `rev-parse`); `checkout`, `reset`, and `clean` cannot be reached.
7. `stdout` carries only MCP JSON-RPC frames; all logs go to `stderr`.

## Package & Directory Responsibility Map

| Package / Directory | Role | Status |
|---|---|---|
| `packages/domain` | Graph and evidence contracts, Zod schemas, canonical JSON, deterministic SHA-256 IDs, streaming snapshot hash (`computeStreamingSnapshotId`), deep-frozen snapshots; 27 node kinds and 20 edge kinds (`graph-kinds.ts`) | Done |
| `packages/sidecar-ipc` | Shared sidecar IPC core (zero external npm dependencies): line-delimited NDJSON framing, per-request timeout, `responseMaxChars`/`stderrMaxChars` budgets (64 MiB each by default), `stdin` EPIPE suppression, `shell: false` + `windowsHide: true` on every spawn, rejection of an empty or NUL-containing `cwd`, `buildAllowlistedWorkerEnv`, `resolveCausorynAssetRoot` | Done |
| `packages/workspace` | Workspace Gateway: lexical `assertNotUncOrDevicePath` (`path-safety.ts`), trusted `allowRoots`, file inventory filters, zero-RegExp polynomial-time `ignore-matcher.ts`, symlink-escape rejection, binary/size filters (`DEFAULT_MAX_FILE_BYTES = 2_000_000`), `OutputAccessPolicy` | Done |
| `packages/indexing` | 5-language pipeline orchestration (`INDEXED_ADAPTERS`, 5 entries), `collectInventoryAsync`, `IndexJobManager` with `worker_threads` execution and in-process fallback, `file_facts` incremental planner with early cutoff, build-lease acquisition/heartbeat and orphan recovery, `fp3` analyzer fingerprint, `tsconfig`/`jsconfig`/`go.mod`/workspace `package.json` change detection, `symbol_fts` population | Partial: the in-process `WorkspaceWatcher` exists but is not exposed as an MCP tool; re-indexing is triggered through `causoryn_status` `action: "refresh"` |
| `packages/graph` | Snapshot queries, bounded traversal and cursor pagination, reverse-BFS impact (excludes `CONTAINS` by default, includes `INHERITS`/`IMPLEMENTS`), architecture guard (YAML policy DSL, Tarjan SCC), read-only `git-read.ts` (compare/timeline, `HEAD~N`/`HEAD^`), agent context with identifier/path tokenization over FTS5, evidence chains, multi-format export (`json`/`markdown`/`mermaid`/`html`/`snapshot`; `view: architecture\|interactive\|full`) | Done |
| `packages/storage-sqlite` | SQLite WAL + FTS5 persistence: `SqliteGraphRepository` (schema `user_version = 4`; `build_leases`, `file_facts`, `symbol_fts` ranked with `bm25`), `PRAGMA data_version`-guarded published-snapshot cache (`MAX_PUBLISHED_CACHE_ENTRIES = 1`), `getLatestSnapshotMeta`, `pruneOldSnapshots`, O(1) position counters for batched writes, and `SqliteWikiStore` (`wiki_*` tables, `wiki_fts`, annotation CAS) | Done |
| `packages/contracts` | Read-only contract discovery (OpenAPI, AsyncAPI, SQL DDL, JSON Schema, Protobuf) with parser quotas (1 MiB, depth, YAML alias cap) and static compatibility/drift classification | Partial: OpenAPI response schemas are discovered but response-schema drift is not classified; event-version rules are open |
| `packages/preflight` | Candidate-only Preflight Manifest (`candidateOnly: true`, never edits sources) + `derive_test_plan` (`direct` / `call-site` / `naming` signals; `preflightId` lookup) | Done for TS/JS `TESTS` edges; sidecar `TESTS` edges are not extracted yet |
| `packages/verification` | Pure `verify_change` engine: 4 checks (`architecture`, `graph-diff`, `test-plan`, optional `contracts`), 8-rule deterministic verdict chain, architecture rules read from the trusted Git `baseRef` (default `HEAD`; working-tree fallback emits `trustWarning`), caller-supplied test results recorded as `state: "host_asserted"` with `engineVerified: false` | Done (a `passed` test status relies on the caller's assertion, not on Causoryn running tests) |
| `packages/wiki` | Living Wiki projection: 11-kind typed link resolution, FTS5 search, incremental invalidation, CAS annotation overlay, offline Markdown + HTML export | Done; incremental publish still rebuilds link/FTS indexes from the full graph |
| `packages/mcp-server` | `stdio` transport, Zod input validation with `.describe()` guidance, workspace authorization, deferred non-blocking startup, `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, persistent `storage.dataDbPath` or default `InMemoryGraphRepository`, tool profiles, `outputSchema` profile, `notifications/progress`, 10-field envelope + 15 error codes, bundle entry (`src/stdio.ts`) and worker entry (`src/index-worker-entry.ts`) | Done (`@modelcontextprotocol/sdk` 1.32.2, v1.x line) |
| `packages/causoryn` | Publishable CLI and plugin package (`causoryn`, `MIT`, `"dependencies": {}`): `causoryn mcp\|setup\|doctor`, `plugin-mcp-launcher.mjs`, staged `dist/mcp-server.mjs` + `dist/index-worker.mjs` + `mcp-server.mjs.LEGAL.txt` + vendored `better-sqlite3` + `dist/typescript-lib/lib*.d.ts` + 4 `native/` workers + 5 `skills/` (`architecture-blueprint`, `causoryn`, `map-system`, `preflight-change`, `verify-change`) + host manifests + `THIRD-PARTY-NOTICES.md` | Done |
| `adapters/typescript` | In-process TypeScript Compiler API + `TypeChecker`: TS and JS/CJS (`require`/`exports`/`module.exports`), in-root monorepo workspace package resolution, confined `tsconfig.json`/`jsconfig.json` loader, CHA `INHERITS`/`IMPLEMENTS`, `oldProgram` reuse, Express/Next.js L3 routes, BDD `Test`/`TESTS` | Done (cross-file Express receivers emit generic routes without the framework label) |
| `adapters/csharp-roslyn` + `native/roslyn-worker` | `dotnet exec` sidecar (worker `cwd`, `DOTNET_STARTUP_HOOKS=""`): Roslyn `SemanticModel`, CHA `INHERITS`/`IMPLEMENTS`, bounded read-only NuGet reference discovery from `obj/project.assets.json`, ASP.NET Core controller and Minimal API routes; deterministic Release DLL with no `.pdb` or `.resources.dll` files | Done; missing .NET runtime degrades to L0/L1 |
| `adapters/python` + `native/python-worker` | `python -I -B -X utf8 worker.py` sidecar (pure stdlib `ast`, zero pip packages), decorator L3 routes | Done; same-module calls `verified`, imported symbols `heuristic` |
| `adapters/go` + `native/go-worker` | Go stdlib `go/parser` + `go/ast` sidecar (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; packages keyed by directory, imports resolved through the `go.mod` module path), `net/http` + gin/echo/chi L3 routes; `go run ./cmd/worker` or a prebuilt `CAUSORYN_GO_WORKER_BIN` | Done; `symbolResolution: false` (no `go/types`) |
| `adapters/rust` + `native/rust-worker` | `syn` 3 + `serde_json` sidecar: `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` (or `CAUSORYN_RUST_TARGET_DIR`) from a trusted `cwd` with `CARGO_BUILD_RUSTC_WRAPPER=""`, binary pinned by a `.sha256.json` side file, attribute-macro L3 routes | Done; `heuristic-heavy` (qualified-path matches are `heuristic`) |
| `apps/visualizer` | Zero-dependency offline HTML+SVG graph viewer generator (inline CSS/JS, strict CSP, resolution color coding, selection-to-evidence panel) | Partial: verified by DOM-level Vitest and static inspection; a real headless-browser run has not been executed |
| `integrations/zcode/causoryn` | ZCode developer plugin package: `.zcode-plugin/plugin.json` (`mcpServers` + `userConfig`), skills, dev marketplace (`.claude-plugin/marketplace.json`) | Partial: manifests validated by tests; a live ZCode GUI install has not been executed |
| `integrations/antigravity/causoryn` | Antigravity plugin directory: `plugin.json`, `mcp_config.json` (primary local loader config), `mcp.json` (portable manifest), `README.md`, and `build:bundle`-staged `scripts/mcp-server.mjs` + `scripts/index-worker.mjs` + vendored `better-sqlite3` | Partial: direct `stdio` handshake verified; `agy` CLI install/smoke NOT RUN |
| `scripts/` | `scripts/secret-scan.mjs` (13 directory roots + 13 root text files), `scripts/generate-sbom.mjs` (CycloneDX 1.5 SBOM + `SHA256SUMS.txt`), `scripts/export-public-tree.mjs` (clean public tree export with leak verification) | Done |
| `examples/fixture-*` (8 directories) | Deterministic fixtures: `ts-orders`, `ts-express`, `ts-nextjs`, `csharp-orders`, `contract-drift`, `python-app`, `go-app`, `rust-app` | Done |
| `tests/` | Integration, smoke, packaged-bundle security, toolchain isolation, benchmark, secret-scan, public export, SBOM/release workflow, distribution, and bilingual doc-parity suites | Done (`tests/bench-release` is excluded from the default run) |

Root distribution manifests: `marketplace.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `plugin.json` + `mcp_config.json`, `mcp.json`, `server.json`, and `skills/`.

## Unified Evidence & Knowledge Graph Contract

- **Node kinds (27):** `Workspace`, `Repository`, `Project`, `Module`, `Package`, `File`, `Namespace`, `Class`, `Interface`, `Type`, `Function`, `Method`, `Endpoint`, `Handler`, `Event`, `Topic`, `Queue`, `Database`, `Table`, `Column`, `ApiContract`, `EventContract`, `SchemaContract`, `ContractVersion`, `Test`, `Config`, `UnknownExternal` (`packages/domain/src/graph-kinds.ts`).
- **Edge kinds (20):** `CONTAINS`, `IMPORTS`, `DECLARES`, `CALLS`, `REFERENCES`, `IMPLEMENTS`, `INHERITS`, `INJECTS`, `ROUTES_TO`, `READS`, `WRITES`, `PUBLISHES`, `SUBSCRIBES`, `HANDLES`, `PRODUCES_CONTRACT`, `CONSUMES_CONTRACT`, `VALIDATES`, `TESTS`, `DEPENDS_ON`, `CONFIGURES`.
- **Resolution levels:** `verified | heuristic | unresolved`. `verified` means a static compiler/AST binding, never a runtime execution guarantee (see [5-Language Analyzers](language-analyzers.md)).
- **Evidence records** carry `relativePath`, `startLine`/`endLine`, `sourceHash`, `analyzerId`, `analyzerVersion`, and `rationale`; every `verified` edge needs at least one evidence item.
- **Invariants:** no dangling edges (unresolved targets become explicit `UnknownExternal` nodes; the SQLite schema enforces edge→node foreign keys); deep-frozen immutable snapshots; identical inputs give byte-identical graph JSON.

## Determinism Rules

1. **IDs are content-derived.** Node, edge, evidence, and snapshot IDs are SHA-256 over canonical JSON; wall-clock time never enters an ID. The snapshot ID is `snapshot:` + SHA-256 of `[workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]`.
2. **Streaming hash, same bytes.** `computeStreamingSnapshotId` feeds the canonical JSON of sorted edges, evidence, and nodes into an incremental SHA-256 one record at a time; the digest equals hashing the full canonical string, so IDs did not change when streaming was introduced.
3. **Incremental equals full.** An early-cutoff incremental build must produce the same snapshot ID as a clean full build of the same inputs (`tests/incremental-early-cutoff.test.ts`, `packages/indexing/test/job-manager.test.ts`).
4. **Stable ordering and cursors.** Results are sorted canonically; pagination cursors are opaque base64url records `{v:1,o:<int>}` (`packages/mcp-server/src/cursor.ts`).
5. **Analyzer and toolchain state are inputs.** The `fp3` `analyzerFingerprint` encodes adapter versions, loaded .NET reference packs, worker run status, and option hashes, so installing a missing toolchain produces a new snapshot. Internal analyzer versions stay at `0.1.0` while extraction semantics are unchanged, independent of the package version.
6. **Artifacts.** The same renderer, snapshot (including metadata), format, view, options, and validated annotations produce byte-identical architecture artifacts. New builds can change metadata such as `createdAt`, publication time, and revision; `requestId`, job progress, and latency are runtime state.
7. **Bundle.** Two `build:bundle` runs over the same sources produce the same `bundle-manifest.json`.

## Storage & Read-Only Workspace Isolation

SQLite + FTS5 via `better-sqlite3` 13.2.0 (bundled SQLite 3.54.1). Connection settings (`packages/storage-sqlite/src/sqlite-repository.ts`): `busy_timeout = 5000`, `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, `temp_store = MEMORY`, `cache_size = -16000`; new databases get `page_size = 4096` (SQLite's default page size) before the first table is created. Schema `user_version = 4` (`schema.ts`).

- **Graph tables:** `workspaces`, `files`, `file_facts`, `snapshots`, `build_leases`, `nodes`, `edges`, `evidence`, and the FTS5 table `symbol_fts` (`symbol`, `search_text`, `node_id`, `snapshot_sid`; default `detail=full`). Edge→evidence links are stored in `edges.evidence_ids_json` and checked at publish.
- **Wiki tables:** `wiki_snapshots`, `wiki_pages`, `wiki_page_sections`, `wiki_links`, `wiki_page_versions`, `wiki_annotations`, `wiki_aliases`, and FTS5 `wiki_fts` (`wiki-schema.ts`).
- **Indexes** cover `(snapshot_sid, kind)`, `(snapshot_sid, from_id)`, `(snapshot_sid, to_id)`, and `(snapshot_sid, relative_path)`; a partial unique index allows only one `building` row per workspace revision.
- **Migrations:** v1/v2/v3 databases upgrade to v4 in one transaction (`symbol_fts` is rebuilt with the path + identifier tokenization).
- **Write boundaries:** Causoryn never writes into the analyzed workspace. Persistent graph and wiki database paths are validated outside authorized roots; automatic configuration also places `exports/` outside the workspace. An explicitly configured `output.allowedOutputDirs` is governed by its own allowlist. See [CLI & Configuration](cli-and-configuration.md).
- **SQL safety:** all external inputs are bound as prepared-statement parameters (`?`); DDL is static literal text.

## Packaging & Bundle Layout

`packages/mcp-server/scripts/build-bundle.mjs` uses `esbuild` with `better-sqlite3` kept external, because native `.node` addons cannot be inlined into an ESM file. The bundle is therefore a multi-file artifact, recorded in a **36-entry** `dist/bundle-manifest.json` that maps each file to its SHA-256:

```text
packages/mcp-server/dist/
  mcp-server.mjs                 # stdio server (entry: src/stdio.ts)
  index-worker.mjs               # worker_threads indexing entry (src/index-worker-entry.ts)
  mcp-server.mjs.LEGAL.txt       # third-party license notices extracted by esbuild
  bundle-manifest.json           # { files: { <path>: <sha256> } }, sorted keys
  node_modules/better-sqlite3/   # 33 files: LICENSE, package.json, lib/** (23 files),
                                 # prebuilds/{darwin,linux,linuxmusl,win32}-{arm64,x64}.node (8 files)
```

The same outputs are staged atomically into `integrations/antigravity/causoryn/scripts/`.

`packages/causoryn/scripts/build-package.mjs` assembles the npm package. It first checks that `SERVER_VERSION` and every manifest version agree, stages the bare bundle artifacts (`index-worker.mjs`, `bundle-manifest.json`, vendored `better-sqlite3`), and then re-bundles `dist/mcp-server.mjs` from the zero-config CLI entry `src/cli-stdio.ts` (the bare bundle's `src/stdio.ts` entry expects a `CAUSORYN_CONFIG` JSON instead). It also stages TypeScript default library declarations (`dist/typescript-lib/lib*.d.ts`), the portable Release Roslyn runtime files (`native/roslyn-worker/`), Python/Go/Rust sidecar sources, the 5 `skills/`, host plugin manifests, `LICENSE`, `licenses/`, and a generated `THIRD-PARTY-NOTICES.md`. `verify-package-ready.mjs` (run before `npm pack`) checks that every staged manifest entry matches its SHA-256, that license notices are present, that published entry scripts are LF-only, and that the Roslyn binaries are clean (no user-profile paths, `.pdb` references, or `.resources.dll` files). The Rust worker ships as source only and is built locally on first use.

## CI/CD & Supply-Chain Workflows

Every GitHub Action is pinned to a 40-character commit SHA, and every Linux job runs `step-security/harden-runner` with `egress-policy: audit` (and `disable-sudo-and-containers: true` everywhere except the Scorecard job, whose Docker-based action needs the container runtime):

- **`.github/workflows/ci.yml`:** 3-OS matrix (`ubuntu-latest`, `windows-latest`, `macos-15`) that installs all 5 language toolchains and runs `npm ci --ignore-scripts`, `npm audit --audit-level=high`, a locked deterministic Roslyn build (`-p:RestoreLockedMode=true`), `cargo build --locked`, typecheck, build, bundle, package build + `verify-package-ready.mjs`, lint, `npm run secret-scan`, `node scripts/export-public-tree.mjs --verify-temp --ref HEAD`, and `npm test`.
- **`.github/workflows/release.yml`:** three jobs. `verify-and-test` (`contents: read`) checks the tag format, the tag/package version match, and `origin/main` ancestry, then runs the same build, lint, secret-scan, export, and test gates. `build-and-pack` (no tests) builds from a clean checkout, runs `verify-package-ready.mjs`, packs the tarball, writes `SHA256SUMS.txt` and the CycloneDX 1.5 SBOM, and smoke-tests the packed tarball in an isolated prefix (CLI `--version`, `doctor --json`, MCP `initialize`). `publish` (`environment: release`, `id-token: write`, `attestations: write`) verifies `sha256sum -c SHA256SUMS.txt`, attests build provenance, publishes with npm OIDC Trusted Publishing (`npm publish --provenance --access public`, `--tag next` for prereleases), and uploads the GitHub Release assets.
- **`.github/workflows/security.yml`:** `zizmor` workflow audit, PR `dependency-review` (high+ advisories and a copyleft license denylist), and a dependency audit (`npm audit --audit-level=high` + a fail-closed NuGet audit with `dotnet restore --locked-mode`).
- **`.github/workflows/codeql.yml`:** CodeQL for `javascript-typescript`, `python`, `csharp`, `actions`, and `go` (manual build of `native/go-worker`) with `security-extended` queries.
- **`.github/workflows/scorecard.yml`:** OpenSSF Scorecard with SARIF upload to code scanning.
- **`.github/dependabot.yml`:** weekly grouped updates for npm (root workspace), Cargo (`/native/rust-worker`), NuGet (`/native/roslyn-worker`), and GitHub Actions, with a 7-day cooldown (`semver-major-days: 14` on package ecosystems). The Python and Go workers use only their standard libraries.

## Technology Stack (Locked Versions)

| Domain | Choice | Locked in repository |
|---|---|---|
| Core runtime | TypeScript strict, Node.js | TypeScript `5.9.3`, Node.js `>= 24` |
| MCP protocol | Official `@modelcontextprotocol/sdk` | `^1.32.2` (v1.x line, `packages/mcp-server`) |
| Bundling | Multi-file deterministic ESM bundle | `esbuild` `^0.28.2` (`better-sqlite3` external) |
| Validation | Zod + JSON Schema | `zod` `^4` |
| TypeScript analysis | In-process TypeScript Compiler API | `adapters/typescript` + bundled `dist/typescript-lib/lib*.d.ts` |
| Sidecars | C# Roslyn, Python `ast`, Go `go/parser`, Rust `syn` 3 | `native/{roslyn,python,go,rust}-worker` + `adapters/*` + `packages/sidecar-ipc`; Roslyn `Microsoft.CodeAnalysis.CSharp` `5.12.0` on `net10.0` |
| Graph & wiki store | SQLite + FTS5, WAL | `better-sqlite3` `^13.2.0` (SQLite 3.54.1) |
| Git | Read-only CLI | `packages/graph/src/git-read.ts` (`execFile`, `shell: false`, allowlist `cat-file`/`ls-tree`/constrained `rev-parse`) |
| Testing | Vitest + golden fixtures + MCP stdio integration | `vitest` `5.1.0` |
| Linting | `typescript-eslint` recommended | `eslint` `^10.15.0` + `typescript-eslint` `^8.73.0` |

TypeScript `5.9.3` is pinned because `typescript-eslint` requires `typescript >=4.8.4 <6.1.0`.

## Build, Typecheck, Test & Security Gate Contract

- `npm run test` -> Vitest across `packages/*/test`, `adapters/*/test`, `integrations/**`, and `tests/**`, **excluding `tests/bench-release/**`** (wall-clock latency measurements, not a correctness gate).
- `npm run bench` -> runs `tests/bench-release/` only (`vitest.bench.config.ts`); `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` refreshes the benchmark docs.
- `npm run build` -> `tsc -b` over the root `tsconfig.json`, which has **14** direct project references: 9 packages (`domain`, `sidecar-ipc`, `workspace`, `indexing`, `graph`, `storage-sqlite`, `mcp-server`, `causoryn`, `wiki`) and 5 adapters (`typescript`, `csharp-roslyn`, `rust`, `python`, `go`); `contracts`, `preflight`, and `verification` compile transitively.
- `npm run build:bundle --workspace packages/mcp-server` -> `dist/mcp-server.mjs`, `dist/index-worker.mjs`, `dist/mcp-server.mjs.LEGAL.txt`, vendored `better-sqlite3`, `dist/bundle-manifest.json`, and the staged Antigravity `scripts/` copy.
- `npm run build:package` (`--workspace packages/causoryn`) + `node packages/causoryn/scripts/verify-package-ready.mjs` -> stage and verify the publishable package.
- `npm run typecheck` -> `tsc -p tsconfig.typecheck.json` (`noEmit` over sources, tests, and configs).
- `npm run lint` -> ESLint flat config (`typescript-eslint` recommended).
- `npm run secret-scan` -> `node scripts/secret-scan.mjs` scans 13 directory roots and 13 root text files for credentials, API tokens, personal emails, and local user-profile paths; it exits `1` on any match or missing root.
- Module resolution is `NodeNext`: relative TypeScript imports use explicit `.js` specifiers.

## Related Documentation

- [5-Minute Quickstart Tutorial](tutorial-5-minutes.md) · [Documentation Hub](README.md) · [Bilingual Project Overview (TR · EN)](../project-overview.tr-en.md)
- [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)
- [CLI & Configuration Reference](cli-and-configuration.md) · [5-Language Analyzers & Sidecar Protocol](language-analyzers.md)
- [MCP Tool Contracts](tool-contracts.md) · [Living Wiki Specification](wiki-spec.md)
- [Host Compatibility Matrix](compatibility-matrix.md) · [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md)
- [Implementation Status](implementation-status.md) · [No-LLM decision record](adr/ADR-002-no-llm.md)
