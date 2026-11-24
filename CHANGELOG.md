# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Lean English-first MCP surface & `--tool-profile` (`core|full|wiki|history`):**
  - Default `--tool-profile core` (and `CAUSORYN_TOOL_PROFILE`) registers **11 consolidated tools** (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`) keeping `tools/list <= 15,000` characters (`--output-schema omit` by default, server-side Zod validation always active).
  - Extension profiles add Living Wiki (`--tool-profile wiki`, 7 tools) and Git architecture history (`--tool-profile history`, 2 tools), while `--tool-profile full` preserves all 29 legacy tool names plus the 3 consolidated core tools (32 total) with deprecation notices.
- **Non-blocking `worker_threads` WAL indexing & MCP progress notifications:**
  - Dedicated background indexing worker (`packages/indexing/src/index-worker.ts` / `dist/index-worker.mjs`) runs full and incremental analysis off the MCP event loop over SQLite WAL (`PRAGMA busy_timeout=5000`), streaming `notifications/progress` when clients send `_meta.progressToken` and returning structured `{ status: "indexing", jobId, progress, retryAfterMs }` on cold-start timeouts.
- **Per-file incremental indexing with early cutoff (`file_facts`):**
  - SQLite schema v4 adds the `file_facts` table (`content_hash`, `public_interface_hash`, `imported_paths_json`, serialized per-file graph facts) and TypeScript `oldProgram` reuse so body/comment edits re-analyze only the changed file (early cutoff) while preserving byte-identical deterministic snapshot IDs.
- **Warm boot, streaming SHA-256 snapshot IDs & SQLite retention GC:**
  - Streaming SHA-256 snapshot hashing (`computeStreamingSnapshotId`) removes monolithic string allocation; lightweight `getLatestSnapshotMeta` avoids full graph hydration on boot; `MAX_PUBLISHED_CACHE_ENTRIES = 1` reduces warm RSS; `pruneOldSnapshots` retains the latest 2 published snapshots and cleans orphan `symbol_fts` entries.
- **Shared workspace SQLite DB (`graph.sqlite`) with heartbeat single-writer leases:**
  - All MCP hosts share a single `<slug>-<hash12>/graph.sqlite` per workspace (`--client` stays a diagnostic label), coordinated by the `build_leases` table (`lease_id`, `owner_pid`, `host_label`, `heartbeat_at`, `expires_at`), dead-PID / expired orphan `building` recovery (`recoverOrphanBuilds`), and explicit `waiting_for_peer` reporting.
- **Semantic fidelity & code localization upgrades:**
  - TypeScript monorepo workspace package resolution (`package.json` `name`/`exports`/`types`/`main`/`workspaces` confined strictly inside `rootDir`).
  - Class Hierarchy Analysis (`INHERITS` and `IMPLEMENTS` edges) for TypeScript (`TypeChecker`) and C# Roslyn (`INamedTypeSymbol.BaseType` / `Interfaces`), propagated through `analyze_impact` and `preflight_change`.
  - Read-only C# NuGet reference discovery from `obj/project.assets.json` (bounded, symlink/UNC-guarded).
  - Per-language `coverage.byLanguage` breakdown in MCP envelopes so one language never hides L0 degradation in another.
  - Identifier + path tokenization (`camelCase`, `PascalCase`, `snake_case`, `kebab-case`) with SQLite FTS5 BM25 + structural degree ranking in `causoryn_get_agent_context`.
- **Real-repo evaluation & open-source developer documentation:**
  - Added the 5-minute copy-paste tutorial ([`docs/en/tutorial-5-minutes.md`](docs/en/tutorial-5-minutes.md)) on `examples/fixture-ts-orders`, cleaned internal specification/sprint jargon from `README.md`, `packages/causoryn/README.md`, and `docs/en/**`, translated root `CHANGELOG.md` and `packages/causoryn/src/cli.ts` outputs to English, and added a real-repository precision/recall/latency benchmark harness plus SQLite/git-blob timeline fallbacks.

### Changed

- **Edge resolution honesty & verification accuracy:**
  - Go adapter keys packages by directory path + `go.mod` module path (fixing multi-file package resolution and preventing false cross-directory `verified` matches across separate `package main` directories).
  - Rust adapter labels 2-segment suffix matches (`Type::method` / `mod::fn`) honestly as `heuristic` with `unverified-module-prefix-suffix-match` ambiguity instead of `verified`.
  - `causoryn_verify_change` defaults `checks` to `["architecture", "graph-diff", "test-plan"]` (running `contracts` only when requested or contract pairs exist), projects working trees asynchronously across all languages (`runIndexAsync`), loads `.causoryn/architecture.rules.yaml` and `architecture.baseline.yaml` from trusted Git `baseRef` (`HEAD` by default) with an explicit `trustWarning` when falling back to an untrusted working tree, and records host-supplied test runs strictly as `state: "host_asserted"` (`engineVerified: false`, `hostAssertedPassed`).
  - `causoryn_derive_test_plan` resolves saved `preflightId` manifests from `PreflightManifestStore`; `analyze_impact` excludes noisy `CONTAINS` edges from reverse BFS; `causoryn_trace` clamps oversized `maxDepth`/`maxPaths` with warnings; `find_symbols` excludes `UnknownExternal` placeholders when real project symbols match; `architecture-annotations.ts` collects up to 25 validation errors in a single pass; `errors.ts` provides accurate English `userAction` guidance.
- **CLI `setup` & `doctor` ergonomics:**
  - `setup` no longer false-positives on bare `~/.gemini` (requires `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json`), writes zero files when zero hosts are detected without `--client`/`--all`, is strictly idempotent (`noop`), preserves the first original `*.causoryn.backup` forever (writing timestamped secondary backups on later edits), cleans `.tmp` files in `try/finally`, and writes the absolute Node binary (`process.execPath`) instead of bare `"node"`.
  - `doctor` accepts absolute Node executable paths and reports `NOT CONFIGURED` (0 configured hosts) and `DEGRADED` (host/probe warnings) instead of false `HEALTHY`.

### Security

- **Untrusted-repository toolchain isolation:**
  - Cargo probes/builds run in trusted `native/rust-worker` `cwd` with `CARGO_BUILD_RUSTC_WRAPPER=""` and `causoryn-rust-worker.sha256.json` source-fingerprint + `O_NOFOLLOW` binary SHA-256 verification.
  - Read-only Git invocations enforce `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<devNull>`, `GIT_ATTR_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_OPTIONAL_LOCKS=0`, and pre-subcommand `-c` overrides (`core.fsmonitor=false`, `core.hooksPath`, `core.sshCommand=false`, `diff.external=false`, `protocol.allow=never`, `protocol.ext.allow=never`, `safe.bareRepository=explicit`) plus safe `rev-parse --verify --end-of-options` support for `HEAD~N`/`HEAD^`.
  - Go worker forces `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off` and removes `GOENV` from the env allowlist; Python worker launches with `["-I", "-B", "-X", "utf8", scriptPath]` in the worker directory; Roslyn worker pins `cwd` and `DOTNET_STARTUP_HOOKS=""`; `doctor` probes run in `os.tmpdir()`; `sidecar-ipc` enforces `shell: false`, `windowsHide: true`, and non-empty `cwd`.
- **Win32 UNC lexical pre-check, `$HOME` ancestor rejection & SHA-256 CSP:**
  - Shared `assertNotUncOrDevicePath` rejects `\\host\share`, `//host/share`, and `\\?\`/`\\.\` paths lexically before any `fs.*` syscall (preventing SMB/NTLM credential leaks); `inspectProjectRootSafety` also rejects `$HOME` ancestors (`C:\Users`, `/home`, `/Users`) and `/tmp`, `/var`, `/bin`, `/sbin`, `/lib`, `/dev`.
  - Interactive HTML architecture portal replaces `script-src 'unsafe-inline'` with a deterministic `script-src 'sha256-<hash>'` Content Security Policy.
  - Hermetic 3-job release workflow separation (`verify-and-test` -> clean `build-and-pack` with `verify-package-ready.mjs` immediately before `npm pack` -> `publish`).

### Remaining 1.0.0 Release Gates (Pre-1.0 Honesty Policy — `1.0.0` Not Declared)

`1.0.0` will not be declared until the remaining open gates below are closed (see [`docs/en/implementation-status.md`](docs/en/implementation-status.md) and [`docs/en/BACKLOG.md`](docs/en/BACKLOG.md)):

- Live Antigravity `agy` CLI installation and smoke run (requires `agy` CLI on the host machine; currently reported `NOT RUN`).
- Live ZCode desktop GUI installation and `tools/list` smoke run (deferred so automated runs never mutate user desktop profiles).
- Live macOS and Linux ARM64 interactive host CLI/GUI smoke verification (3-OS GitHub Actions CI runs green on `ubuntu-latest`, `windows-latest`, and `macos-15`).
- MCP TypeScript SDK upgrade from v1.x (`^1.32.2`) to stable v2.
- Live Architecture watcher MCP surface (per-file incremental `file_facts` caching with early cutoff and TypeScript `oldProgram` reuse are now implemented; exposing the in-process file watcher over MCP remains open).
- `Test` node and `TESTS` edge extraction in the 4 sidecar languages (C#, Python, Go, Rust; currently active for TypeScript/JavaScript only).
- Contract discovery & drift fidelity extensions: OpenAPI response-schema drift, event-version mismatch rule, and SQL RENAME classification refinement (`unknown`).
- Automated read-only workflow ergonomics for `.causoryn/architecture-snapshot.json` comparisons across Git revisions without writing into analyzed workspaces.
- Living Wiki surface refinements: exposing `wiki_search` query filters (`kinds`/`scope`/`language`/…), registering `WIKI_NOTE_CONFLICT` in MCP error guidance alongside consented local note write flows, and narrowing incremental wiki link/FTS rewrites.
- Real-browser acceptance verification of the offline visualizer (`apps/visualizer`) alongside the existing `causoryn_export_documentation(format="html", view="interactive")` MCP surface.
- Bare monorepo bundle default lib (`.d.ts`) scope decision (`packages/causoryn` already bundles `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`).
- Rate-limit/concurrency resource budget enforcement across concurrent MCP requests (`scripts/secret-scan.mjs` across 13 roots + 13 root files and `npm audit` with **0 vulnerabilities** are already closed).

## [0.2.4] - 2026-11-24

### Added

- **Natural-language skill triggering & 17-pair bilingual documentation hub:** Added `docs/prompting-and-architecture-portals.md` and `docs/en/prompting-and-architecture-portals.md` (Deterministic vs. Host-LLM Annotated portal recipes), bilingual natural-language triggers and Host-LLM guidance in `skills/architecture-blueprint/SKILL.md`, visual portal routing in `skills/causoryn/SKILL.md`, and `L3`/`Test` + 10-field envelope updates in `skills/map-system/SKILL.md` and ZCode's `map-system` skill.
- **Rich MCP schema descriptions:** Added Zod `.describe()` JSON Schema descriptions across `causoryn_export_documentation` top-level fields (`view`, `options`, `annotations`) and nested annotation objects (`domains`, `moduleNotes`, `flows`, `guidedTour`, `decisions`, `risks`).

### Changed

- **Diátaxis documentation refresh:** Cleaned version noise from `README.md`, `packages/causoryn/README.md`, and the 17-pair `docs/` + `docs/en/` documentation hub; aligned Quick Start (`npx causoryn@latest setup|doctor`) and Deterministic vs. Annotated example prompts.
- **CI runner & Dependabot stability:** Pinned CI macOS jobs to `macos-15`, upgraded `actions/attest-build-provenance` to `v4.2.2`, unified Dependabot npm workspaces under `directory: "/"` with a TypeScript major-bump guard, and aligned workflow tests with Dependabot SHA + `# vX.Y.Z` comments.

### Security

- **27 CodeQL HIGH alerts resolved (0 open alerts):**
  - Replaced 13 polynomial ReDoS backtracking regexes across `adapters/typescript`, `packages/contracts` (SQL/Protobuf), `packages/graph`, `packages/mcp-server`, and `packages/wiki` with linear-time `O(n)` scanners.
  - Hardened `packages/contracts/src/json-schema-discovery.ts` with strict WHATWG `URL` hostname validation (`json-schema.org` / `*.json-schema.org`) and linear wildcard substitution in `tsconfig-loader.ts`.
  - Eliminated 9 production filesystem race (TOCTOU) findings via shared `packages/mcp-server/src/safe-file-read.ts` (`O_NOFOLLOW` + `fstat` + bounded chunked reads) and single-fd atomic writes in `watcher.ts`, `source-revision.ts`, `runtime-cli.ts`, `setup.ts`, and `export-public-tree.mjs`.
  - Hardened temporary test files in `tests/bench-release/{benchmark.test,fixture}.ts` (`mkdtempSync`, `flag: "wx"`, `0o600`/`0o700`).
- **CI/CD & supply-chain security hardening:**
  - Added `.github/workflows/security.yml` (`zizmor`, PR `dependency-review-action`, `npm audit --audit-level=high`, fail-closed `--locked-mode` NuGet JSON audit), `.github/workflows/codeql.yml` (5-language CodeQL v4 SAST), `.github/workflows/scorecard.yml` (OpenSSF Scorecard SARIF), `step-security/harden-runner`, `-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp --ref HEAD`, 7-day Dependabot cooldown, and `tests/ci-workflow.test.ts` contract guards.

## [0.2.3] - 2026-11-23

### Added

- **JavaScript & modern TS extensions (`adapters/typescript`, `packages/indexing`):** Extended the in-process `ts-adapter` to analyze `.js`, `.jsx`, `.mjs`, `.cjs` alongside `.ts`, `.tsx`, `.mts`, `.cts` (`allowJs: true`, `checkJs: false`, `jsx: Preserve`), supporting ESM + CommonJS (`require`, `exports`, `module.exports`) and JS/CJS Express and Next.js App Router routes.
- **Root-confined `tsconfig.json` / `jsconfig.json` loader (`adapters/typescript/src/tsconfig-loader.ts`):** Deterministic read-only loading of `baseUrl`, `paths`, `jsx`, `moduleResolution`, `experimentalDecorators`, JSONC comments, in-root `extends` chains, and nested monorepo configs with incremental cache invalidation.
- **Universal ignore discovery & smart `bin/` handling (`packages/workspace`, `packages/mcp-server`):** Added ecosystem cache/vendor directories and binary/ML/sourcemap extensions, read `.gitignore` + `.git/info/exclude` + bounded nested `.gitignore` files, and replaced blunt `**/bin/**` with `.NET`-specific output globs so Node `bin/*.ts|js` and Rust `src/bin/*.rs` sources remain indexed.
- **Non-blocking `collectInventoryAsync` (`packages/indexing`):** Yields to the event loop every 64 entries while producing byte-identical sorted inventory output.

### Changed

- **Distinct interactive HTML default filename (`packages/graph`):** `causoryn_export_documentation(format="html", view="interactive")` defaults to `causoryn-architecture-interactive.html` so it never overwrites the zero-JS `causoryn-architecture.html`.

### Security

- **Polynomial zero-RegExp glob matcher (`packages/workspace/src/ignore-matcher.ts`):** Replaced backtracking regex compilation with a deterministic two-pointer glob matcher.
- **Confined TS compiler host & `O_NOFOLLOW` reads:** `configureConfinedCompilerHost` restricts compiler reads to `rootDir` and bundled `typescript-lib`; `tsconfig`/`jsconfig`, ignore files, and inventory enforce `O_NOFOLLOW` + `(dev, ino)` verification; `writeDocumentation` uses `flag: "wx"` + `EEXIST` guards.

## [0.2.2] - 2026-11-22

### Added

- **Visual architecture projection & layered SVG layout (`packages/graph`):** Adaptive directory-tree module clustering (`maxModules` default `32`, Tarjan SCC cycle detection) and zero-dependency Sugiyama-style layered SVG layout (`computeArchitectureLayout`, `renderArchitectureSvg`, `renderFlowStripSvg`).
- **Multi-view `causoryn_export_documentation` & fail-closed Host-LLM `annotations`:** Default `view: "architecture"` (zero-JS offline HTML portal, subgraph Mermaid, Architecture Brief Markdown, compact JSON blueprint), opt-in `view: "interactive"` offline HTML portal, optional fail-closed 9-field `annotations`, and legacy `view: "full"`.
- **Fifth canonical skill (`skills/architecture-blueprint/SKILL.md`):** Guides host coding agents through grounded visual portal synthesis while keeping Causoryn 100% LLM-free.

### Performance & Fixed

- **`PRAGMA data_version`-guarded SQLite snapshot cache (`packages/storage-sqlite`, `packages/mcp-server`):** Cached warm snapshots across reads with cross-connection invalidation and deferred persistent snapshot loading into `startDeferredIndex()`.
- **Dynamic `causoryn doctor` version (`packages/causoryn`):** Reads `CAUSORYN_PACKAGE_VERSION` dynamically from `packages/causoryn/package.json`.

## [0.2.1] - 2026-11-22

### Fixed

- **Non-blocking MCP startup (`cli-stdio.ts`, `runtime-cli.ts`, `context.ts`):** Deferred initial indexing until after MCP `initialize` (`deferAutoIndex: true`), keeping handshake latency under `< 500 ms` on large repositories.
- **Real-world build/venv/cache exclusions & root `.gitignore` support:** Added `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__`, `target`, `coverage`, `.vs`, `.dotnet`, and binary exclusions merged with root `.gitignore`.
- **Polyglot shared external node deduplication (`packages/indexing`):** Shared pathless `UnknownExternal` nodes merge cleanly across language adapters while file-bound collisions still fail closed.
- **O(1) SQLite position counters & bulk transactions (`packages/storage-sqlite`):** Replaced O(N^2) `MAX(position)` subqueries with O(1) counters inside atomic transactions.
- **Response budget protection (`packages/mcp-server`):** Capped `causoryn_index_status` `job.diagnostics` and `job.warnings` to 50 entries with a truncation summary.
- **Release workflow (`release.yml`):** Prefixed local tarball publish argument (`./$TGZ_FILE`) so npm treats it as a local archive.

## [0.2.0] - 2026-11-20

### Release Decision

**`0.2.0` Pre-1.0 release — explicitly NOT `1.0.0`.** Because historical `v0.1.0` remains frozen at `4c9c188f` and multi-language analysis, persistent SQLite indexing, 4-host CLI/plugin distribution, and open-source supply-chain governance substantially expanded the product surface, minor version `0.2.0` was published while keeping `1.0.0` gated on the open items in `[Unreleased]`.

### Added

- **5-language deep analysis:** Added `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), and `native/rust-worker` (`syn`) sidecars with `adapters/{python,go,rust}`, unified 5-language `INDEXED_ADAPTERS`, and MCP `readOnlyHint` tool annotations.
- **Persistent SQLite storage & incremental refresh:** Optional `storage.dataDbPath` SQLite graph store + `symbol_fts`, `causoryn_refresh_index(mode="incremental")`, TypeScript BDD `Test`/`TESTS` extraction, `causoryn_export_documentation(format="snapshot")`, shared `@causoryn/sidecar-ipc`, and GitHub Actions CI.
- **Multi-host open-source distribution (`packages/causoryn`):** Unified npm package (`causoryn setup|doctor|mcp`), 4-host marketplace manifests (Antigravity, Claude Code, Codex, ZCode/GLM), canonical `skills/`, zero-config `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, bundled `dist/typescript-lib/lib*.d.ts`, and MCP Registry identity (`io.github.mrbekox/causoryn`).
- **Governance & supply-chain provenance:** `MIT` license, `THIRD-PARTY-NOTICES.md` + `licenses/`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github` templates & Dependabot, SHA-pinned 3-OS CI, CycloneDX 1.5 SBOM + `SHA256SUMS.txt` + OIDC Trusted Publishing, and clean public-tree exporter (`scripts/export-public-tree.mjs`).

### Changed

- Clarified C# `frameworkLinkers` label as `"aspnet-core-route-attributes (L3)"`.
- Replaced generic "zero-compile" wording with a component-level runtime, compilation, and offline matrix (explicitly documenting Go `go run` and cold Rust `cargo build --locked` `crates.io` behavior).
- Cleaned local paths and personal identifiers from all user-facing docs.

### Security

- Expanded `scripts/secret-scan.mjs` across 13 directory roots + 13 root text files.
- Upgraded `eslint@10.15.0` and `typescript-eslint@8.73.0`, reaching **0 vulnerabilities** in `npm audit`.
- Enabled deterministic Release Roslyn compilation (`-p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`) with zero PDB path leakage.

## [0.1.0] - 2026-11-09

### Release Decision

**`0.1.0` public snapshot — NOT `1.0.0`.** Root `package.json` and `SERVER_VERSION` remained `0.1.0` because all 29 tools, the 9/9 security matrix, benchmarks, and initial host smoke runs shipped while full cross-host verification (Antigravity `NOT RUN`), multi-platform live smoke, and documented fidelity boundaries remained open for `1.0.0`.

### Added

- **MCP server engine:** 29 implemented tools (22 core + 7 Living Wiki; zero stub handlers), standard 10-field envelope (`schemaVersion: "2.0"`), fixed error code catalog with deterministic `retryable`/`userAction` guidance.
- **Core architecture & graph features:** Capability/workspace/index inspection, L0–L3 architecture map, symbol lookup and neighborhood context, execution tracing, reverse-BFS impact analysis, Architecture Guard YAML policy DSL + Tarjan SCC, read-only Git diff/timeline, Agent GPS context packing, onboarding reports, and deterministic exports.
- **Living Wiki engine:** `WikiProjectionEngine`, SQLite `wiki_*` schema, 11-kind bidirectional links + `brokenLinkDiagnostics`, FTS5 search, Git/snapshot versions and diffs (including `contractChanges`), incremental invalidation, CAS annotation overlay, and offline Markdown/HTML export.
- **Contracts, preflight & change guard:** OpenAPI, AsyncAPI, SQL DDL, JSON Schema, and Protobuf discovery + compatibility/drift evaluation; business-flow tracing; candidate-only `causoryn_preflight_change`; `causoryn_derive_test_plan` (no test execution); and byte-deterministic `causoryn_verify_change` with honest test-status tracking.
- **Offline visualizer & C# Roslyn support:** Zero-dependency offline HTML+SVG viewer (`apps/visualizer`) and C# Roslyn sidecar (`native/roslyn-worker`) with graceful L0/L1 fallback.
- **Multi-file deterministic bundle & host guides:** `esbuild` bundle (`packages/mcp-server/dist/mcp-server.mjs`) + external vendored `better-sqlite3` (`dist/bundle-manifest.json`; intentionally multi-file because native `.node` addons cannot be inlined); Claude Code live CLI smoke (`claude 2.1.322`, re-verified 2026-11-10), Codex CLI registration smoke (`codex-cli 0.163.0`, 2026-11-10), ZCode manifest validation, and Antigravity manifest docs (`agy` CLI absent — `NOT RUN`).
- **Packaged-bundle security audit (9/9 PASS):** Symlink/path traversal, secret leakage (static canary + behavioral baits), symlink TOCTOU, poisoned comments / prompt injection, oversized files, malicious Git refs (live bundle `git cat-file` proof + `INVALID_REVISION`), network denied (`net-guard.cjs` preload, zero egress), offline HTML XSS/CSP, and `stdout` framing discipline (**5 independent spawn** sessions; 32/32 bundle tests, 36/36 total security suite on 2026-11-10).
- **1,000-file TypeScript benchmarks (2026-11-10 run):** MCP protocol-layer medians of `11.8 ms` (`workspace_summary`), `13.0 ms` (`get_symbol_context`), and `10.7 ms` (`map_system`, 200 nodes) via `npm run bench`.

### Documentation

- Added `docs/architecture.md`, `docs/tool-contracts.md`, `docs/compatibility-matrix.md`, `docs/hosts/*`, `docs/security-pass.md`, `docs/benchmarks.md`, `docs/implementation-status.md`, and this changelog.

### Security

- Strictly read-only workspace analysis; explicit root authorization with default deny; symlink/junction escape and post-open TOCTOU re-checks; parameterized SQL; sanitized `INTERNAL_ERROR` responses; shell-free read-only Git allowlist; strict offline CSP + HTML escaping; zero LLM/embedding dependencies and zero runtime network egress.

## Related Documentation

- [docs/en/implementation-status.md](docs/en/implementation-status.md) — implementation status and open 1.0.0 gates
- [docs/en/compatibility-matrix.md](docs/en/compatibility-matrix.md) — host verification matrix
- [docs/en/security-pass.md](docs/en/security-pass.md) · [docs/en/benchmarks.md](docs/en/benchmarks.md)
