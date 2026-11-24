# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before `1.0.0`, a breaking change bumps the minor version.

## [Unreleased]

### Remaining 1.0.0 Release Gates (Pre-1.0 Honesty Policy — `1.0.0` Not Declared)

`1.0.0` will not be declared until the open gates below are closed (see [`docs/en/implementation-status.md`](docs/en/implementation-status.md) and [`docs/en/BACKLOG.md`](docs/en/BACKLOG.md)):

- Live Antigravity `agy` CLI installation and smoke run (requires the `agy` CLI on the host machine; currently reported `NOT RUN`).
- Live ZCode desktop GUI installation and `tools/list` smoke run (deferred so automated runs never modify user desktop profiles).
- Live macOS and Linux ARM64 interactive host CLI/GUI smoke verification (the 3-OS GitHub Actions CI matrix runs on `ubuntu-latest`, `windows-latest`, and `macos-15`; live macOS/ARM64 host smoke is still open).
- MCP TypeScript SDK upgrade from v1.x (`^1.32.2`) to the stable v2 line.
- Live architecture watcher MCP surface (per-file incremental indexing with `file_facts` early cutoff and TypeScript `oldProgram` reuse is implemented; exposing the in-process file watcher over MCP remains open).
- `Test` node and `TESTS` edge extraction in the four sidecar languages (C#, Python, Go, Rust); today only TypeScript/JavaScript produces them, so `derive_test_plan` has no `direct` signal for the other languages.
- Contract discovery and drift fidelity: OpenAPI response-schema drift, an event-version mismatch rule, and a clearer classification of SQL `RENAME` (currently `unknown`).
- Read-only workflow for `.causoryn/architecture-snapshot.json` comparisons across Git revisions without writing into analyzed workspaces (`causoryn_export_documentation(format="snapshot")` already writes the canonical blob into an allowed `output.allowedOutputDirs` directory). The history tools now use the published local index for the commit it provably matches and for `working-tree`; any other revision still needs a committed snapshot (marked with a trust warning), because the index keeps no per-commit history.
- Living Wiki surface refinements: exposing the `wiki_search` query filters (`kinds`/`scope`/`language`/…), registering `WIKI_NOTE_CONFLICT` in the MCP error guidance together with a consented local note-write flow, and narrowing the incremental wiki publish so link/FTS indexes are not rewritten from the full graph.
- Real-browser acceptance run of the offline visualizer (`apps/visualizer`); the `causoryn_export_documentation(format="html", view="interactive")` MCP surface has been available since `0.2.2`.
- Bundle fidelity decision for the bare monorepo bundle's default lib (`.d.ts`) files (`packages/causoryn` already ships `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`; the bare `packages/mcp-server/dist/` bundle does not include them).
- Rate-limit/concurrency resource budget enforcement across concurrent MCP requests (currently out of scope). Already closed: the dedicated secret-scan gate (`scripts/secret-scan.mjs` over 13 directory roots + 13 root files) and `npm audit` with **0 vulnerabilities**.

## [0.3.0] - 2026-11-24

### Release Decision

**`0.3.0` is a Pre-1.0 release — explicitly NOT `1.0.0`.** The minor version is bumped because the default MCP tool surface changed in a breaking way (29 tools → an 11-tool `core` profile). Root `package.json`, every workspace package, `packages/causoryn/package.json`, `SERVER_VERSION`, `INDEXING_VERSION`, `server.json`, and the four host marketplace/plugin manifests are kept in sync at `0.3.0`. The open gates under `[Unreleased]` keep `1.0.0` closed.

### Breaking Changes

- **Default tool surface reduced from 29 to 11 tools.** Without options, `tools/list` now returns the `core` profile: `causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`. Calls to legacy names that are not in the active profile fail with an MCP "tool not found" error.
- **Living Wiki and architecture-history tools are opt-in.** The 7 `causoryn_wiki_*` tools need `--tool-profile wiki`; `causoryn_compare_architecture` and `causoryn_architecture_timeline` need `--tool-profile history`.
- **`outputSchema` is omitted from `tools/list` by default** to keep the listing small. Responses still carry `structuredContent`, and the server validates every envelope against its schema in both modes.
- **One shared index per workspace.** All hosts now use `<data-dir>/workspaces/<slug>-<hash12>/graph.sqlite` instead of one `graph-<client>.sqlite` file per host; `--client` only labels the host. The SQLite schema moves to `user_version = 5`. When `graph.sqlite` does not exist yet, the newest valid per-host `graph-<client>.sqlite` written by `0.2.x` is copied into it once; the legacy files are left in place and `causoryn doctor` lists them.
- **ZCode shares the index with the other hosts.** The base data directory is now `--data-dir` > `~/.causoryn` for every host; `ZCODE_PLUGIN_DATA` is only a fallback when `~/.causoryn` cannot be created or written. ZCode users whose index lived under `ZCODE_PLUGIN_DATA` re-index once.
- **Index job status `reused`.** Job records (`causoryn_status` `data.index.job`, legacy `causoryn_index_status`) report `status` `queued`, `running`, `done`, `reused`, `failed` plus `outcome` (`published`, `unchanged`, `reused_peer`, `peer_busy`, `failed`) and `published`. A run that publishes nothing is now `reused` (or `failed` with outcome `peer_busy`), never `done`; clients that polled for `done` must also accept `reused`.
- **Analyzer fingerprint `fp3`.** Real TypeScript declaration spans, ESM/CommonJS module-format detection, and English evidence text changed analyzer output, so snapshots and `file_facts` written by earlier releases are not reused: the first `0.3.0` start re-indexes each workspace once.

### Migration

- **Keep the legacy tool names:** start the server with `--tool-profile full` (or set `CAUSORYN_TOOL_PROFILE=full`). This registers all 29 legacy names plus `causoryn_status`, `causoryn_trace`, and `causoryn_contracts` (32 tools). Superseded legacy tools are marked `(Deprecated: use <replacement>)` and add a deprecation warning to their responses.
- **Move to the consolidated names:** `causoryn_get_capabilities`, `causoryn_workspace_summary`, `causoryn_index_status`, `causoryn_refresh_index` → `causoryn_status` (`action: "inspect"` or `action: "refresh"`); `causoryn_generate_onboarding` → `causoryn_map_system`; `causoryn_trace_execution`, `causoryn_trace_business_flow` → `causoryn_trace`; `causoryn_analyze_impact`, `causoryn_derive_test_plan` → `causoryn_preflight_change`; `causoryn_check_architecture` → `causoryn_verify_change`; `causoryn_check_contracts`, `causoryn_detect_contract_drift` → `causoryn_contracts`.
- **Add extensions instead of `full`:** `--tool-profile wiki`, `--tool-profile history`, or a combination such as `--tool-profile wiki,history`. Selection order: `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`; every supplied value is validated and unknown profile names stop the server at startup. `causoryn setup --tool-profile <list>` writes the profile into the host entries.
- **Clients that need `outputSchema` in `tools/list`:** pass `--output-schema full` (alias `--output-schema-profile full`) or set `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full`.
- **Prompts and host configurations** that name legacy tools must either switch to the consolidated names or pass `--tool-profile full` in the host's MCP server arguments.

### Added

- **Tool profiles (`--tool-profile core|full|wiki|history`, `CAUSORYN_TOOL_PROFILE`, `CAUSORYN_CONFIG.toolProfile`):** the `core` listing stays within a 15,000-character `tools/list` budget (`tests/mcp-tool-surface-budget.test.ts`); profiles can be combined with commas. The bare bundle entry (`dist/mcp-server.mjs`) and `causoryn mcp` resolve the tool profile, `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` and `CAUSORYN_INDEX_WAIT_MS` through the same resolver.
- **Non-blocking `worker_threads` indexing and MCP progress notifications:** full and incremental indexing run in a dedicated worker (`packages/indexing/src/index-worker.ts`, bundled as `dist/index-worker.mjs`) over SQLite WAL (`PRAGMA busy_timeout = 5000`), with an in-process async fallback. Clients that send `_meta.progressToken` receive `notifications/progress`. Tools other than `causoryn_status` wait up to `CAUSORYN_INDEX_WAIT_MS` (default 15,000 ms; `0` disables waiting) for the first index and otherwise return `status: "partial"` with `{ status: "indexing", jobId, progress, retryAfterMs }`. While a re-index runs, responses serve the latest published snapshot with a `stale=true` warning.
- **Per-file incremental indexing with early cutoff (`file_facts`):** schema v4 adds the `file_facts` table (`content_hash`, `public_interface_hash`, `imported_paths_json`, serialized per-file graph facts). Together with TypeScript `oldProgram` reuse, body/comment-only edits re-analyze only the changed file, and snapshot IDs stay byte-identical to a full rebuild.
- **Shared workspace database with single-writer leases:** one `graph.sqlite` per workspace for all hosts, coordinated by the `build_leases` table (`lease_id`, `owner_pid`, `host_label`, `hostname`, `owner_instance`, `heartbeat_at`, `expires_at`; default TTL 120 s, heartbeat 10 s). On the same host PID liveness decides and the TTL is secondary; a heartbeat older than the hard staleness ceiling (10 min, `CAUSORYN_LEASE_STALE_CEILING_MS`) counts as dead, which also covers PID reuse; on another host only the TTL counts (it is long because the build write phase can hold the SQLite write lock for tens of seconds). The heartbeat is renewed from the main thread every 10 s and at every phase boundary. `recoverOrphanBuilds` marks `building` rows left by a crashed process as recovered orphans so the next build can publish.
- **Waiting for a live peer build:** async runs claim the build lease before analysis; when a live peer holds it they wait (progress phase `waiting_for_peer`, up to `CAUSORYN_PEER_WAIT_TIMEOUT_MS`, default 15 min) and then reuse the peer's snapshot without re-analysis when the inputs match (`outcome: "reused_peer"`).
- **Schema forward guard and legacy migration:** a `graph.sqlite` stamped by a newer schema is never opened for writing (`storage/schema-too-new`); the CLI uses `graph.schema-<N>.sqlite` instead. Legacy `graph-<client>.sqlite` files are migrated once (read-only `quick_check`, online backup, no-clobber publish).
- **`causoryn setup --tool-profile <list>`** writes `--tool-profile <list>` into every generated entry (`core`, `full`, `wiki`, `history`, or a comma list); `--all-detected` is an explicit alias of the default host selection.
- **`causoryn doctor` toolchain minimums and legacy files:** probes the .NET 10 runtime (`dotnet --list-runtimes`), Python 3.10 and Go 1.22, reports per-toolchain `status` (`ok`, `warn`, `absent`) and `minimumVersion`, and lists legacy `graph-<client>.sqlite` files (read-only; never deletes them).
- **Warm boot, streaming snapshot hashing, and retention GC:** `computeStreamingSnapshotId` hashes the same canonical bytes as before without building one large string (IDs are unchanged); `getLatestSnapshotMeta` avoids hydrating the full graph on startup; `MAX_PUBLISHED_CACHE_ENTRIES = 1` lowers warm memory; `pruneOldSnapshots` keeps the newest 2 published snapshots and removes orphan rows, including orphan `symbol_fts` entries.
- **Semantic fidelity:** TypeScript monorepo workspace package resolution (`package.json` `name`/`exports`/`types`/`main`/`workspaces`, confined to `rootDir`); class-hierarchy edges (`INHERITS`, `IMPLEMENTS`) for TypeScript (`TypeChecker`) and C# Roslyn (`INamedTypeSymbol.BaseType`/`Interfaces`), used by impact analysis and `causoryn_preflight_change`; read-only C# NuGet reference discovery from `obj/project.assets.json` (bounded, symlink/UNC-guarded); per-language `coverage.byLanguage` in envelopes so one language cannot hide degradation in another.
- **Code localization in `causoryn_get_agent_context`:** identifier and path tokenization (`camelCase`, `PascalCase`, `snake_case`, `kebab-case`) with SQLite FTS5 BM25 plus structural-degree ranking; production sources rank above test files and `UnknownExternal` placeholders unless the query asks about tests; matched external concepts propagate one hop back to their production callers.
- **Trusted history sources:** `causoryn_compare_architecture` and `causoryn_architecture_timeline` (`history` profile) prefer the published local index when it provably matches a commit's content (indexed file hashes on disk, git blob IDs equal to the commit tree, every other path excluded by the workspace rules) and use it instead of the working-tree snapshot file for `working-tree`. Points that still come from a committed `.causoryn/architecture-snapshot.json`, which a pull request can change, carry the explicit trust warning `snapshot-loaded-from-committed-git-blob`, and refs served from the index are listed in `warnings`.
- **Real-repository evaluation harness (`scripts/bench/real-repo-eval.mjs`):** evaluates the packed tarball on the Causoryn repository and on small TypeScript/Go/Rust judge fixtures (tool count, `tools/list` size, event-loop stall, warm handshake, unresolved-edge ratio, localization rank).
- **5-minute tutorial:** [`docs/en/tutorial-5-minutes.md`](docs/en/tutorial-5-minutes.md) walks through `setup` → `causoryn_preflight_change` → edit → `causoryn_verify_change` on `examples/fixture-ts-orders`.

### Changed

- **Edge resolution honesty:** the Go adapter keys packages by directory path plus `go.mod` module path (fixing multi-file packages and preventing false cross-directory `verified` matches between separate `package main` directories); the Rust adapter labels 2-segment suffix matches (`Type::method`, `mod::fn`) as `heuristic` with the `unverified-module-prefix-suffix-match` ambiguity instead of `verified`, and calls with several candidates are `unresolved` (no edge to any candidate) with every candidate listed in `ambiguity`.
- **TypeScript analysis:** symbol nodes carry their real declaration spans; each file's ESM/CommonJS format follows the nearest `package.json` `type` field and the `.mts`/`.cts` extensions. C#, Python, Go and Rust symbol nodes still carry a 1:1 file-anchor span (a documented limitation).
- **English runtime text:** all runtime text, including native worker warnings and rationales (for example `reference pack loaded: ...` from the Roslyn worker), is plain English; the stderr ready marker is `causoryn mcp server ready (causoryn@<version>)`; the Living Wiki template version is `1.1.0` (English templates), so wikis built with `1.0.0` are rebuilt on the next build.
- **Warm start refresh:** when a published snapshot exists, it is served immediately and one background incremental refresh picks up files changed while the server was not running.
- **`causoryn_verify_change`:** `checks` defaults to `["architecture", "graph-diff", "test-plan"]` (`contracts` runs when requested or when contract pairs exist); working trees are projected asynchronously for all languages; `.causoryn/architecture.rules.yaml` and `architecture.baseline.yaml` are read from the trusted Git `baseRef` (`HEAD` by default), with an explicit `trustWarning` when the untrusted working tree is used instead; host-supplied test runs are recorded only as `state: "host_asserted"` (`engineVerified: false`).
- **Other tool behaviour:** `derive_test_plan` resolves saved `preflightId` manifests from `PreflightManifestStore`; impact analysis no longer walks noisy `CONTAINS` edges in reverse BFS; `causoryn_trace` clamps oversized `maxDepth`/`maxPaths` with a warning; `find_symbols` drops `UnknownExternal` placeholders when real project symbols match; annotation validation reports up to 25 errors in one pass; `errors.ts` carries English `userAction` guidance.
- **`causoryn setup`:** no longer treats a bare `~/.gemini` as Antigravity (requires `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json`); writes nothing and exits `1` with guidance on `stderr` when no host is detected and neither `--client` nor `--all` is given; repeated runs are no-ops; re-running keeps every key of the existing Causoryn entry that setup does not own (`env`, `disabled`, `autoApprove`, `alwaysAllow`, `timeout`, unknown keys keep their value and position) together with the `--tool-profile` and `--output-schema` arguments, and a Codex `startup_timeout_sec` of 30 or more is kept (a lower or unusable value is raised to 30 and reported); the first original `*.causoryn.backup` is kept and later edits get timestamped backups; temporary files are removed in `try/finally`; host configs use the absolute Node binary (`process.execPath`) instead of a bare `node`.
- **`causoryn doctor`:** accepts absolute Node executable paths and reports `NOT CONFIGURED` (no configured host) or `DEGRADED` (host warnings, or a toolchain that is installed but below its minimum or unusable) instead of a false `HEALTHY`.
- **Python command:** the default is `python3` then `python` on POSIX (`python` on Windows), shared by the Python adapter and `causoryn doctor`; an explicit `pythonCommand` is used as is. Indexes with Python files rebuild once after the upgrade.
- **Typecheck coverage:** `npm run typecheck` now also covers `integrations/*/causoryn/test` and `apps/*/src`.
- **Release workflow:** three jobs (`verify-and-test` → hermetic `build-and-pack`, with `verify-package-ready.mjs` immediately before `npm pack` → `publish`); `SHA256SUMS.txt` and the CycloneDX SBOM are generated immediately after `npm pack`, before the packed tarball is smoke-tested.

### Fixed

- **TypeScript call resolution:** calls through anonymous call signatures (lib, external, and workspace functions such as `String`, `expect`, injected handlers) no longer produce false `unresolved` edges; genuinely unresolved callees stay `unresolved`, and multi-line chained call text is collapsed to at most 120 characters.
- **Status without graph hydration:** workspace summaries are served from snapshot metadata instead of loading the full graph.
- **C# implicit global usings:** C# analysis now models SDK implicit global usings (`<ImplicitUsings>enable</ImplicitUsings>` plus `<Using Include/Remove>` items), so SDK-style projects no longer get false `CS0246`/`CS0103` diagnostics for BCL types such as `Console` or `Thread`. Each `.csproj` is compiled as its own Roslyn compilation (with its `ProjectReference` closure and the nearest `Directory.Build.props`), which also removes false `CS7022` warnings caused by merging several projects into one compilation.
- **Declaration spans for every language:** C#, Python, Go and Rust symbol nodes now carry their real declaration lines (an optional `span` field in the worker protocol, validated by the adapters) instead of a `1:1` file anchor, so agent context and symbol tools point at the declaration in every language. The Go worker's limit message now reads `file count limit exceeded`, matching the other workers.
- **C# external call names:** `UnknownExternal` names for library calls no longer repeat the namespace (previously for example `System.System.Console.WriteLine`).
- **False `TS1470` in ESM projects:** the confined compiler host now exposes each workspace `package.json` `type` field, so files in `"type": "module"` packages are no longer analyzed as CommonJS.
- **Honest job states:** an index run that publishes nothing is no longer reported as `done`; a host whose peer published first reports `reused` with outcome `reused_peer`.
- **Publish under concurrency:** the publish transaction takes the SQLite write lock up front (`BEGIN IMMEDIATE`), and lease heartbeats are renewed from the main thread while the indexing worker is busy, so a live build is not mistaken for an orphan.

### Security

- **Toolchain isolation when analyzing untrusted repositories:**
  - Cargo builds run with `CARGO_BUILD_RUSTC_WRAPPER=""` outside the analyzed repository, and the compiled worker is pinned by `causoryn-rust-worker.sha256.json` (source fingerprint + `O_NOFOLLOW` binary SHA-256 check before spawn).
  - Read-only Git calls set `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<devNull>`, `GIT_ATTR_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1` (honoured by git 2.45 and later), `GIT_LFS_SKIP_SMUDGE=1`, `GIT_OPTIONAL_LOCKS=0`, and pre-subcommand `-c` overrides (`core.fsmonitor=false`, `core.hooksPath`, `core.sshCommand=false`, `diff.external=false`, `protocol.allow=never`, `protocol.ext.allow=never`, `safe.bareRepository=explicit`); relative revisions such as `HEAD~N` and `HEAD^` are resolved with `rev-parse --verify --end-of-options`.
  - The Go worker forces `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off` and drops `GOENV` from its environment allowlist; the Python worker starts with `-I -B -X utf8` from its own directory; the Roslyn worker pins its working directory and sets `DOTNET_STARTUP_HOOKS=""`; `doctor` probes run in `os.tmpdir()`; `sidecar-ipc` enforces `shell: false`, `windowsHide: true`, and a non-empty `cwd`.
  - Every tool the MCP server starts (`git`, `dotnet`, `python`, `go`, `cargo`) is resolved to an absolute path from `PATH` entries outside the analyzed workspace and started from a trusted working directory; on Windows `taskkill` is taken from `System32`.
  - The Rust worker is built from a staged copy of its crate in Causoryn's build cache (`CAUSORYN_RUST_TARGET_DIR`; a cache inside the workspace is refused); an explicitly configured worker directory is never built in place.
  - Git children additionally get an empty `GIT_ALLOW_PROTOCOL` and per-protocol `protocol.<name>.allow=never` pins; partial-clone (promisor) repositories are refused on git older than 2.45; the user's system and global `safe.directory` entries are forwarded with `-c`.
- **Path safety:** a shared lexical check rejects UNC and Win32 device paths (`\\host\share`, `//host/share`, `\\?\`, `\\.\`) before any filesystem call; project-root safety also rejects `$HOME` ancestors (`C:\Users`, `/home`, `/Users`) and `/tmp`, `/var`, `/bin`, `/sbin`, `/lib`, `/dev`.
- **Interactive HTML portal:** `script-src 'unsafe-inline'` is replaced by a deterministic `script-src 'sha256-<hash>'` Content Security Policy.

### Documentation

- English reference documentation under `docs/en/` restored to full technical depth and updated for `0.3.0` (tool profiles, shared index, worker-thread indexing); internal planning codes removed from public English docs; root `CHANGELOG.md` is English-first.
- English and Turkish reference docs, skills and adapter READMEs synced with the final `0.3.0` behaviour (lease liveness, peer waiting, job outcomes, schema v5 and legacy migration, ZCode data directory, setup/doctor changes, trusted history sources, `fp3`, process hardening); the generated Turkish `docs/benchmarks.md` template no longer contains internal planning codes.

## [0.2.4] - 2026-11-24

### Added

- **Natural-language skill triggering and the 17-pair bilingual documentation hub:** added `docs/prompting-and-architecture-portals.md` and `docs/en/prompting-and-architecture-portals.md` (recipes for deterministic vs. host-LLM annotated architecture portals); bilingual (TR/EN) natural-language triggers and a "do not refuse host-LLM annotation" rule in the `skills/architecture-blueprint/SKILL.md` front matter; visual portal routing in `skills/causoryn/SKILL.md`; `L3`/`Test` and the 10-field envelope mapping in `skills/map-system/SKILL.md` and `integrations/zcode/causoryn/skills/map-system/SKILL.md`.
- **MCP schema descriptions:** the `causoryn_export_documentation` description and Zod schema gained `.describe()` JSON Schema text for every `view`, `options` (`includeTests` default `true`) and `annotations` field (`title`, `architectureStyle`, `executiveSummary`, `domains`, `moduleNotes` with per-module `keyFiles`, `flows`, `guidedTour`, `decisions`, `risks`).

### Changed

- **Diátaxis documentation refresh:** removed version noise from `README.md`, `packages/causoryn/README.md`, and the 17-pair `docs/` + `docs/en/` hub; aligned the quick start (`npx causoryn@latest setup|doctor`) and the deterministic vs. annotated example prompts.
- **CI runner and Dependabot stability (PR #20, #23):** CI macOS jobs pinned to `macos-15`; `actions/attest-build-provenance` upgraded to `v4.2.2`; Dependabot npm workspaces unified under one root `directory: "/"` with a TypeScript `version-update:semver-major` guard; `tests/ci-workflow.test.ts` aligned with Dependabot (allowlisted action repositories, 40-character SHA pins, and `# vX.Y.Z` comments).

### Security

- **27 CodeQL HIGH alerts resolved (PR #24, 0 open alerts):**
  - 13 `js/polynomial-redos` fixes: backtracking regexes in `adapters/typescript`, `packages/contracts` (SQL/Protobuf), `packages/graph`, `packages/mcp-server`, and `packages/wiki` replaced by linear-time `O(n)` scanners and non-overlapping prefix/slice checks.
  - URL host validation and wildcard hardening: `packages/contracts/src/json-schema-discovery.ts` replaces `includes("json-schema.org")` with strict WHATWG `URL` validation (`http:`/`https:`, empty `username`/`password`/`port`, host `json-schema.org` or `*.json-schema.org`); `adapters/typescript/src/tsconfig-loader.ts` performs the single `*` substitution with `O(n)` `indexOf`/`slice`.
  - 9 production `js/file-system-race` (TOCTOU) fixes: the shared `packages/mcp-server/src/safe-file-read.ts` (`open`/`openSync` + `O_NOFOLLOW` + `fstat` + bounded chunked reads) is used by all MCP policy/verification services; `packages/indexing/src/watcher.ts`, `packages/preflight/src/source-revision.ts`, `packages/mcp-server/src/runtime-cli.ts`, `packages/causoryn/src/setup.ts`, and `scripts/export-public-tree.mjs` (`O_RDWR | O_NOFOLLOW` + `ftruncateSync` + explicit-offset `writeSync`) moved to single-fd atomic reads/writes.
  - 3 `js/insecure-temporary-file` fixes: `tests/bench-release/{benchmark.test,fixture}.ts` create temporary directories with `mkdtempSync` and files with `flag: "wx"`, `mode: 0o600` / `0o700`.
- **CI/CD and supply-chain hardening:**
  - `.github/workflows/security.yml`: fail-closed `zizmor` workflow audit, PR `dependency-review-action` (blocks `high`+ advisories and modern SPDX copyleft licenses), multi-ecosystem `npm audit --audit-level=high`, and a fail-closed `--locked-mode` NuGet JSON vulnerability audit.
  - `.github/workflows/codeql.yml` and `.github/workflows/scorecard.yml`: 5-language CodeQL v4 SAST (`javascript-typescript`, `python`, `csharp`, `go`, `actions`) and OpenSSF Scorecard (`publish_results: true`, SARIF upload).
  - `.github/workflows/release.yml` and `.github/workflows/ci.yml`: 2-job SLSA release split (read-only `build-and-verify` with `step-security/harden-runner` → `attest-and-publish` with OIDC provenance and no `NPM_TOKEN`), `-p:RestoreLockedMode=true` (`packages.lock.json`), the `export-public-tree.mjs --verify-temp --ref HEAD` gate, a 7-day Dependabot cooldown across 4 ecosystems (`.github/dependabot.yml`), and `tests/ci-workflow.test.ts` contract tests.

## [0.2.3] - 2026-11-23

### Added

- **JavaScript and modern TypeScript extensions (`adapters/typescript`, `packages/indexing`; no new language adapter):** the in-process `ts-adapter` now analyzes `.js`, `.jsx`, `.mjs`, `.cjs` alongside `.ts`, `.tsx`, `.mts`, `.cts` with `allowJs: true`, `checkJs: false`, and default `jsx: ts.JsxEmit.Preserve`; JS files/symbols are labelled `language: "javascript"` and TS ones `language: "typescript"`. Besides ESM `import`/`export ... from`, it extracts CommonJS `require("literal")`, `exports.<fn>`, `module.exports.<fn>`, `module.exports = function ...`, and JS/CJS Express and Next.js App Router routes.
- **Read-only, root-confined `tsconfig.json` / `jsconfig.json` loader (`adapters/typescript/src/tsconfig-loader.ts`):** deterministic reading of `baseUrl`, `paths` (`@/*`, `~/*`), `jsx`, `moduleResolution` (`Bundler` / `NodeNext`), `experimentalDecorators`, JSONC comments, in-root `extends` chains, and nested monorepo configs (e.g. `frontend/tsconfig.json`). `IndexService` passes policy-approved config files to the analyzer and invalidates the incremental cache when `tsconfig*`/`jsconfig*` files change.
- **Universal ignore discovery and smart `bin/` handling (`packages/workspace`, `packages/mcp-server`):**
  - While keeping the 7 baseline default patterns (including `**/bin/**`) and the reachability of `src/build/keep.ts`, 14 ecosystem cache/vendor entries (`vendor`, `Pods`, `.gradle`, `.angular`, `.expo`, `.idea`, `.dart_tool`, `.terraform`, `.tox`, `.nox`, `.parcel-cache`, `.vite`, `*.min.js`, `*.min.mjs`) and 20 binary/ML/sourcemap extensions (`.map`, `.whl`, `.parquet`, `.onnx`, `.pt`, `.safetensors`, `.gguf`, …) were added to the defaults.
  - `workspace-ignore-discovery.ts` reads `.git/info/exclude` and depth/budget-bounded nested `.gitignore` files in addition to the root `.gitignore`.
  - When no explicit `ignore` is given, `buildWorkspaceAutoConfig` replaces the blunt `**/bin/**` with .NET output globs only (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` and `<project>/bin/**` under detected `.csproj`/`.fsproj`/`.vbproj`), so Node/CLI `bin/*.ts|js` and Rust `src/bin/*.rs` sources stay indexed.
- **Non-blocking `collectInventoryAsync` (`packages/indexing`):** the inventory scan yields to the event loop with `setImmediate` every 64 entries so large repositories do not delay the MCP handshake or concurrent requests; its sorted output is byte-identical to the synchronous `collectInventory`.

### Changed

- **Distinct interactive HTML default filename (`packages/graph`):** when `fileName` is omitted, `causoryn_export_documentation(format="html", view="interactive")` writes `causoryn-architecture-interactive.html` (`EXPORT_INTERACTIVE_HTML_FILE_NAME`), so it never silently overwrites the zero-JS `causoryn-architecture.html`.

### Security

- **Polynomial-time, RegExp-free glob matcher (`packages/workspace/src/ignore-matcher.ts`):** backtracking RegExp compilation was replaced by a deterministic two-pointer glob matcher (closing a ReDoS risk and a pattern-cache loop).
- **Root-confined TypeScript compiler host and bounded `O_NOFOLLOW` reads (`adapters/typescript`, `packages/mcp-server`, `packages/indexing`):** `configureConfinedCompilerHost` limits the compiler and module-resolution host to the authorized `rootDir` and the bundled `typescript-lib` (blocking reads through `ts.sys` and `..` escapes hidden behind wildcards); `tsconfig`/`jsconfig`, `.gitignore`/`.git/info/exclude`, and inventory reads use `O_NOFOLLOW`, `fstat` `(dev, ino)` checks, and loop/DAG budgets; `writeDocumentation` creates temporary files with `flag: "wx"` and an `EEXIST` guard.

## [0.2.2] - 2026-11-22

### Added

- **Visual architecture projection and layered SVG layout (`packages/graph`):** adaptive directory-tree module clustering (`projectArchitecture`, default `maxModules: 32`; `UnknownExternal` noise is excluded from modules and summarized honestly in `externalSummary`; Tarjan SCC detects dependency cycles) and a zero-dependency Sugiyama-style layered SVG layout with Bezier edge routing (`computeArchitectureLayout`, `renderArchitectureSvg`, `renderFlowStripSvg`).
- **Multi-view `causoryn_export_documentation` and fail-closed host-LLM `annotations` (`packages/graph`, `packages/mcp-server`):**
  - Default `view: "architecture"`: a **zero-JS, strict offline CSP** (`default-src 'none'`) 5-tab layered SVG architecture portal (`html`), a subgraph-grouped renderable `flowchart TB` (`mermaid`), an Architecture Brief with embedded Mermaid and module/flow/contract/risk summary (`markdown`), and a compact blueprint keyed by `meta.id` (`json`); responses return `data.architectureSummary.moduleIds`.
  - Opt-in `view: "interactive"` (`format: "html"` only): offline interactive portal with pan/zoom, instant search, language/cycle/test filters, a right-hand inspector drawer with 1-hop neighbourhood highlighting, clickable source-line evidence, and Mermaid copy (`VIEWER_CSP_POLICY`, no `innerHTML`, no `fetch`/CDN).
  - Optional fail-closed `annotations` (`title`, `architectureStyle`, `executiveSummary`, `domains`, `moduleNotes`, `flows`, `guidedTour`, `decisions`, `risks`): the host's LLM can embed the architecture narrative it derived from Causoryn MCP tools; every `moduleId`/`nodeId`/`evidenceId`/`keyFiles` reference is validated, and the Causoryn core stays 100% LLM-free ([no-LLM decision record](docs/en/adr/ADR-002-no-llm.md)).
  - `view: "full"` keeps the legacy raw snapshot dump for backward compatibility; the 29-tool catalog was unchanged.
- **Optional host-LLM skill (`skills/architecture-blueprint/SKILL.md`):** a fifth canonical skill helps the host's model prepare annotations from MCP evidence on all four hosts. The export is reproducible for the same snapshot, format, view, options, and annotation input; the narrative written by the model may vary.

### Performance & Fixed

- **`PRAGMA data_version`-guarded SQLite snapshot cache (`packages/storage-sqlite`, `packages/mcp-server`):** a bounded (max 4 entries) `SnapshotGraph` cache avoids rebuilding 80k+-row snapshots on warm reads, with cross-connection invalidation, and persistent snapshot loading moved into `startDeferredIndex()` (warm queries on large full-stack repositories became roughly 100–300x faster).
- **Dynamic `causoryn doctor` package version (`packages/causoryn`):** `CAUSORYN_PACKAGE_VERSION` is read from `packages/causoryn/package.json` at runtime.

## [0.2.1] - 2026-11-22

### Fixed

- **Non-blocking MCP startup (`cli-stdio.ts`, `runtime-cli.ts`, `context.ts`):** `causoryn mcp --allow-cwd --auto-data-dir` no longer indexes synchronously before the MCP `initialize` / `tools/list` handshake (`deferAutoIndex: true` plus background async indexing after `oninitialized`); on large full-stack projects `initialize` dropped from a timeout to `< 500 ms`.
- **Real-world build/venv/cache exclusions and root `.gitignore` support (`packages/workspace`, `runtime-cli.ts`):** `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `target`, `coverage`, `.vs`, `.dotnet`, `.dotnet-home`, `.codex-build` and `.nupkg`/`.snupkg`/`.pdb` binaries are excluded by default; `buildWorkspaceAutoConfig` merges root `.gitignore` patterns negation-safely through `extraIgnore`.
- **Polyglot shared external node deduplication (`packages/indexing`):** when two or more language analyzers emit the same pathless (`relativePath=null`) external/virtual node (`UnknownExternal`, e.g. `Request`), snapshot creation no longer crashes; the canonical node is shared while file-bound collisions still fail closed.
- **O(1) SQLite position counters and bulk transactions (`packages/storage-sqlite`, `packages/graph`, `packages/indexing`):** the O(N²) `MAX(position)` subqueries in `SqliteGraphRepository` `addNode`/`addEdge`/`addEvidence` were replaced by O(1) counters, and bulk build/inventory writes run in one atomic `runInTransaction`.
- **Response budget protection (`packages/mcp-server`):** `causoryn_index_status` caps `job.diagnostics` and `job.warnings` at 50 entries plus a truncation summary so large projects do not overflow the MCP context window.
- **Release workflow (`release.yml`):** `npm publish "./$TGZ_FILE"` prefixes the local tarball path so npm no longer mistakes it for a GitHub repository shorthand.

## [0.2.0] - 2026-11-20

### Release Decision

**`0.2.0` Pre-1.0 release — explicitly NOT `1.0.0`.** Because the historical `v0.1.0` tag remains frozen at `4c9c188f`, and multi-language analysis, persistent SQLite indexing, 4-host CLI/plugin distribution, and open-source supply-chain governance substantially expanded the product surface, the new minor version `0.2.0` was published (`package.json`, `packages/causoryn/package.json`, `SERVER_VERSION`, `server.json`, and the 4 host marketplace manifests in sync). `1.0.0` stays gated on the open items in `[Unreleased]`.

### Added

- **5-language deep analysis:** `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), and `native/rust-worker` (`syn`) sidecars with `adapters/{python,go,rust}`, a unified 5-language `INDEXED_ADAPTERS`, and honest resolution/tier labels (`workspace_summary.languages`, `coverageOf.tier`, and `annotations`/`readOnlyHint` on all 29 MCP tools).
- **Pre-1.0 engineering improvements:** optional persistent SQLite graph store (`storage.dataDbPath`) with the `symbol_fts` leg of agent-context search, `causoryn_refresh_index(mode="incremental")`, TypeScript BDD `Test`/`TESTS` extraction, `causoryn_export_documentation(format="snapshot")`, the shared `@causoryn/sidecar-ipc` process core, and the GitHub Actions CI workflow.
- **Multi-host open-source distribution (`packages/causoryn`):** the single `causoryn` npm package (`setup`/`doctor`/`mcp`), 4 host marketplace manifests (Antigravity, Claude Code, Codex, ZCode/GLM), 4 canonical `skills/`, zero-config `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, staged `dist/typescript-lib/lib*.d.ts`, and the `mcpName` + `server.json` MCP Registry identity (`io.github.mrbekox/causoryn`).
- **Open-source release governance and supply chain:**
  - `MIT` license (`Causoryn Contributors`), `THIRD-PARTY-NOTICES.md`, and bundled third-party license texts (`licenses/`).
  - `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/dependabot.yml`.
  - `.github/workflows/ci.yml`: every action pinned to a 40-character commit SHA; `ubuntu-latest` + `windows-latest` + `macos-latest` matrix, deterministic Release Roslyn build, `cargo build --locked`, and `verify-package-ready.mjs`.
  - `.github/workflows/release.yml`: SHA-pinned tag/version verification, `SHA256SUMS.txt`, CycloneDX SBOM (`causoryn-sbom.cdx.json`), `actions/attest-build-provenance`, and OIDC Trusted Publishing without `NPM_TOKEN` (`npm publish --provenance --access public`).
  - `scripts/export-public-tree.mjs`: clean public-repository exporter (excludes `raw/`, `wiki/`, `docs/superpowers/`, and internal prompt files, strips internal tool lines from `.gitignore`, and runs a fail-closed leak check).

### Changed

- Clarified the C# `INDEXED_ADAPTERS` `frameworkLinkers` label as `"aspnet-core-route-attributes (L3)"` and synchronized `docs/project-overview.tr-en.md` (TR & EN).
- Replaced the generic "zero-compile" wording in `README.md` and `packages/causoryn/README.md` with a component-level runtime / compilation / offline matrix (explicitly documenting Go `go run` and cold Rust `cargo build --locked` `crates.io` behavior).
- Added the `owner` field to `integrations/zcode/.claude-plugin/marketplace.json` (for `claude plugin validate --strict`) and dev-fixture warnings; removed local machine paths and personal user names from all user-facing docs.

### Security

- Expanded `scripts/secret-scan.mjs` to 13 directory roots (including `.github`, `.claude-plugin`, `.agents`, `docs`, `skills`) + 13 root text files, with extended token and local-profile-path patterns.
- Upgraded `eslint@10.15.0` and `typescript-eslint@8.73.0`, reaching **0 vulnerabilities** in `npm audit`.
- Enabled deterministic Release Roslyn compilation (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`) so local PDB paths no longer leak into the DLL.

## [0.1.0] - 2026-11-09

### Release Decision

**`0.1.0` public snapshot — NOT `1.0.0`.** The root `package.json` `version` stayed `0.1.0` (the decision was to keep it) and matched `SERVER_VERSION`. Rationale (pre-1.0 honesty policy: an incomplete feature is never declared done): all 29 tools were real implementations and the release test matrix (security 9/9, benchmarks, 2 of 3 host smoke runs) plus this changelog were in place, but `1.0.0` required every host to be verified by a real run (Antigravity `NOT RUN`), broader platform distribution (only Windows was verified), and the documented fidelity boundaries to be closed.

### Added

- **MCP engine:** 29 real tools in `tools/list` (22 core + 7 Living Wiki; no stub handlers), the standard 10-field envelope (`schemaVersion: "2.0"`), a fixed error-code catalog with 3 project extensions (`INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND`), and deterministic `retryable`/`userAction` guidance.
- **Core architecture and graph features:** capability/workspace summary/index jobs; architecture map plus symbol search, symbol context, and call tracing; impact analysis, Architecture Guard (YAML policy DSL, Tarjan SCC), read-only Git diff/timeline, agent context packing, onboarding reports, and deterministic exports.
- **Living Wiki engine:** `WikiProjectionEngine`, SQLite `wiki_*` schema, bidirectional links with `brokenLinkDiagnostics`, multi-leg FTS5 search, versions and diffs (including `contractChanges`), incremental invalidation (bounded at link level), CAS annotation overlay (`WIKI_NOTE_CONFLICT`), and offline Markdown + HTML export; 7 wiki tools, of which `wiki_build` is the only write tool.
- **Contracts, preflight, and business flows:** OpenAPI, AsyncAPI, SQL DDL, JSON Schema, and Protobuf discovery (with parse safety quotas), compatibility and drift cores, business-flow tracing, the candidate-only `causoryn_preflight_change` manifest (writes no code), and `causoryn_derive_test_plan` (runs no tests and never claims "passed").
- **Agent change guard (`causoryn_verify_change`):** 4 checks, a deterministic 8-rule verdict chain (`no_findings` | `review_required` | `blocking_findings` | `inconclusive`), honest test status (`not_run` by default; `observed` only with `evidenceRef` + `sha256` proof), and byte-deterministic reports (same input → bit-identical report).
- **Offline visualizer (`apps/visualizer`):** zero-dependency deterministic HTML+SVG viewer (inline CSS/JS, restrictive CSP, verified/heuristic/unresolved distinction, selection → evidence panel).
- **C# support:** Roslyn sidecar worker (`native/roslyn-worker`, `dotnet build` with 0 errors) with graceful fallback (no worker → L0/L1 with an explicit coverage report) and analyzer fingerprint `fp2`.
- **Packaging:** `esbuild` bundle `packages/mcp-server/dist/mcp-server.mjs` plus externally vendored `better-sqlite3` (`dist/node_modules/`); deterministic output (two builds are bit-identical; `dist/bundle-manifest.json` lists sorted SHA-256 digests). The artifact is honestly "bundle + vendored runtime", not a single file, because native `.node` addons cannot be inlined.
- **Host integrations:** ZCode dev marketplace and plugin manifest validation; Claude Code `.mcp.json`/`claude mcp add` guide and a real smoke run with a temporary config directory (user config left clean; re-verified end-to-end with `claude 2.1.322` on 2026-11-10); Codex `config.toml`/`codex mcp add` guide and a real add → list → remove smoke run (`codex-cli 0.163.0`, cleanup proven with `config.toml` backup/restore, re-run on 2026-11-10); Antigravity `plugin.json` + `mcp.json` documentation example (`agy` CLI absent — install/smoke `NOT RUN`).
- **Packaged-bundle security pass (9/9 PASS):** symlink/path traversal, secret leakage (static canary + behavioral baits), symlink TOCTOU, poisoned source comments / prompt injection, oversized files, malicious Git refs (live bundle `git cat-file` proof; bad refs → `INVALID_REVISION`), network denied (`net-guard.cjs` preload, zero egress), offline HTML XSS/CSP, and `stdout` framing discipline (**5 independent spawn** sessions); 32/32 bundle tests and 36/36 across the security suite on 2026-11-10.
- **1,000-file TypeScript benchmarks (2026-11-10 run):** MCP protocol-layer medians of `11.8 ms` (`workspace_summary`), `13.0 ms` (small `get_symbol_context`), and `10.7 ms` (`map_system`, 200 nodes) via `npm run bench` (the reference figures in the design are targets, not results).

### Documentation

- Added `docs/architecture.md` (package map), `docs/tool-contracts.md` (29-tool contract summary), `docs/compatibility-matrix.md` (host × result, with honest not-run rows), `docs/hosts/*` (3 host guides + ZCode README), `docs/security-pass.md`, `docs/benchmarks.md`, `docs/implementation-status.md`, and this changelog.

### Security

- Strictly read-only workspace analysis; writes only to the declared data root / output directory; explicit root authorization with default deny; symlink/junction escape checks and post-open TOCTOU re-checks; parameterized SQL; no information leakage in `INTERNAL_ERROR`; shell-free read-only Git allowlist (`cat-file`/`ls-tree`); HTML exports with CSP, full escaping, and no external resources; no LLM/embedding/model dependencies and zero runtime network egress (proven behaviorally with the network guard).

## Related Documentation

- [docs/en/implementation-status.md](docs/en/implementation-status.md) — implementation status and open 1.0.0 gates
- [docs/en/compatibility-matrix.md](docs/en/compatibility-matrix.md) — host verification matrix
- [docs/en/security-pass.md](docs/en/security-pass.md) · [docs/en/benchmarks.md](docs/en/benchmarks.md)
