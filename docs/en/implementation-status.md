# Implementation Status

> **Language:** [Türkçe](../implementation-status.md) | **English** · [Documentation Hub](README.md)

**Honesty policy:** Unimplemented, unexecuted, or partially complete features are never marked `Done`. Every status below reflects verified on-disk code, automated test coverage, and dated verification runs; all remaining `1.0.0` release gates are listed explicitly.

---

## Current Pre-1.0 Capabilities & Recent Engineering Tracks

| Track / Version | Delivered Capabilities | Status | Key Verification Suites |
|---|---|---|---|
| **Post-v0.2.4 Security & Runtime Hardening** | Untrusted-repo toolchain isolation (Cargo `cwd` + `CARGO_BUILD_RUSTC_WRAPPER=""` + `.sha256.json` binary pinning; Git `GIT_NO_LAZY_FETCH=1` + hardened `-c` overrides + `HEAD~N`/`HEAD^`; Go `GOTOOLCHAIN=local`/`GOWORK=off`/`GOPROXY=off`; Python `-I -B -X utf8`; Roslyn `DOTNET_STARTUP_HOOKS=""` + worker `cwd`; `doctor` `os.tmpdir()` probes); Win32 UNC lexical pre-check (`path-safety.ts`) + `$HOME` ancestor rejection; interactive HTML deterministic `script-src 'sha256-...'` CSP; hermetic 3-job `release.yml`; Go directory+`go.mod` keying & Rust 2-segment suffix `heuristic` honesty; `verify_change` default checks + async projection + trusted `baseRef` rule loading + `state: "host_asserted"` test status; `derive_test_plan(preflightId)` resolution; shared workspace `graph.sqlite` with `build_leases` heartbeat + orphan `building` recovery; `setup` & `doctor` DX fixes (`NOT CONFIGURED` / `DEGRADED`, permanent original `.causoryn.backup`, zero false `~/.gemini` detection, `process.execPath`). | **Done** | `tests/toolchain-isolation.test.ts`, `tests/git-read.test.ts`, `tests/path-safety.test.ts`, `tests/sqlite-orphan-recovery.test.ts`, `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `tests/verify-change.test.ts` |
| **Post-v0.2.4 Lean Agent Surface, Non-Blocking Worker & Semantic Fidelity** | Default **11-tool `core` profile** (`--tool-profile core\|wiki\|history\|full`, `CAUSORYN_TOOL_PROFILE`, `tools/list <= 15,000` chars, English descriptions, `outputSchemaProfile` default `"omit"`, 32 tools in `full`); tool ergonomics (`CONTAINS` removed from reverse-BFS impact, deduplicated `evidenceMap`, `trace` clamping with warnings, `find_symbols` excluding `UnknownExternal` noise, single-pass 25-error annotation validation); LocAgent-style `get_agent_context` localization (path + `camelCase`/`snake_case` tokenization + FTS5 BM25 + structural degree + production-source priority + 1-hop caller propagation); warm boot (`getLatestSnapshotMeta`, zero-hydration `getLatestWorkspaceSummaryMeta`, `MAX_PUBLISHED_CACHE_ENTRIES = 1`, streaming SHA-256 snapshot IDs, `pruneOldSnapshots` GC); non-blocking `worker_threads` WAL indexing (`index-worker.mjs`) + MCP `notifications/progress` + structured indexing responses; per-file `file_facts` incremental indexing with early cutoff + TS `oldProgram` reuse; TypeScript monorepo workspace resolution + anonymous `CallSignatureDeclaration` resolution + TS & C# CHA `INHERITS`/`IMPLEMENTS` edges + C# read-only `obj/project.assets.json` NuGet discovery + per-language `coverage.byLanguage`. | **Done** | `tests/mcp-tool-surface-budget.test.ts`, `tests/agent-context-localization.test.ts`, `packages/graph/test/agent-context.test.ts`, `tests/snapshot-streaming-and-gc.test.ts`, `tests/non-blocking-indexing.test.ts`, `tests/incremental-early-cutoff.test.ts`, `tests/ts-workspace-and-cha.test.ts` |
| **Post-v0.2.4 Benchmarks & OSS Polish** | Real-repository precision/recall/latency packed-tarball benchmark harness (`scripts/bench/real-repo-eval.mjs`), timeline SQLite/git-tree fallback with explicit `trustWarning`, 5-minute copy-paste tutorial ([`tutorial-5-minutes.md`](tutorial-5-minutes.md)), jargon-free public English docs, English `CHANGELOG.md`, and English CLI output (`packages/causoryn/src/cli.ts`). | **Done** | `tests/timeline-fallback.test.ts`, `tests/release-docs.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts` |
| **`v0.2.4` (2026-11-24)** | CI/CD & supply-chain hardening (`zizmor`, PR `dependency-review-action`, 5-language `CodeQL` v4 with 0 open alerts, OpenSSF Scorecard, OIDC provenance, `-p:RestoreLockedMode=true`, 7-day Dependabot cooldown); bilingual natural-language skill triggers (`architecture-blueprint`, `causoryn`, `map-system`); Diátaxis documentation hub. | **Done** | `tests/ci-workflow.test.ts`, `tests/release-docs.test.ts`, `tests/open-source-distribution.test.ts` |
| **`v0.2.3` (2026-11-23)** | Universal JavaScript & CommonJS (`.js`/`.jsx`/`.mjs`/`.cjs`, `require`/`exports`/`module.exports`, JS Express/Next.js) in `ts-adapter`; confined `tsconfig.json`/`jsconfig.json` loader; zero-RegExp polynomial glob engine + `.git/info/exclude` + nested `.gitignore` + smart `.NET` `bin/` handling; non-blocking `collectInventoryAsync`; distinct `causoryn-architecture-interactive.html` default filename. | **Done** | `adapters/typescript/test/`, `packages/workspace/test/`, `packages/indexing/test/`, `packages/graph/test/` |
| **`v0.2.0`–`v0.2.2` (2026-11-20..22)** | 5-language analysis (`typescript`, `csharp`, `python`, `go`, `rust`), unified `packages/causoryn` npm distribution (`setup`/`doctor`/`mcp`, 4 host manifests, 5 canonical skills, bundled `typescript-lib`), visual layered SVG & interactive HTML portals with optional fail-closed Host-LLM `annotations`, SQLite `PRAGMA data_version` snapshot cache, 13-root `scripts/secret-scan.mjs`, CycloneDX 1.5 SBOM, and `npm audit` = **0 vulnerabilities**. | **Done** | `packages/causoryn/test/setup-and-doctor.test.ts`, `tests/open-source-distribution.test.ts`, `tests/secret-scan.test.ts`, `tests/public-export.test.ts` |

---

## Core Subsystem Status Matrix

| Subsystem | Scope | Status | Honest Boundaries |
|---|---|---|---|
| **Domain Graph & Evidence Model** | 27 node kinds, 20 edge kinds, Zod schemas, streaming SHA-256 deterministic snapshot IDs, verified-edge evidence invariant | **Done** | Static compiler/AST certainty only — never a runtime execution guarantee |
| **Workspace Gateway & Path Safety** | Lexical Win32 UNC/device pre-check, `allowRoots`, polynomial zero-RegExp ignore matcher, symlink/TOCTOU guards, `OutputAccessPolicy` | **Done** | Bare `stdio` defaults to fail-closed `allowRoots: []` |
| **TypeScript / JavaScript Analyzer** | In-process TS Compiler API (`5.9.3`), JS/CJS, monorepo workspace resolution, CHA `INHERITS`/`IMPLEMENTS`, `tsconfig`/`jsconfig`, Express/Next.js L3, BDD `Test`/`TESTS` | **Done** | Cross-file imported Express receivers emit generic routes without the `express` attribute |
| **C# / Roslyn Sidecar** | Isolated deterministic Release `.NET 10` DLL, `SemanticModel`, CHA `INHERITS`/`IMPLEMENTS`, read-only `obj/project.assets.json` NuGet discovery, ASP.NET Core routes | **Done** | Missing `.NET` runtime degrades honestly to L0/L1; C# `TESTS` edge extraction remains open for 1.0 |
| **Python / Go / Rust Sidecars** | Isolated `python -I -B -X utf8` (`ast`), Go (`go/parser`, directory + `go.mod` keying), Rust (`syn` 3, isolated Cargo `cwd` + SHA-256 binary pin, honest 2-segment `heuristic`) | **Done** | Go has no `go/types` L2; Rust has no trait-dispatch resolver; sidecar `TESTS` edges remain open for 1.0 |
| **Live Architecture & Incremental Indexing** | Non-blocking `worker_threads` WAL pipeline, per-file `file_facts` early-cutoff caching, TS `oldProgram` reuse, shared `graph.sqlite` + `build_leases` orphan recovery, in-process `WorkspaceWatcher` | **Partial** | Per-file `file_facts` early-cutoff indexing is complete; exposing the in-process filesystem watcher as an MCP tool remains open for 1.0 |
| **Contracts, Preflight & Change Guard** | OpenAPI/AsyncAPI/SQL/JSON Schema/Protobuf discovery & drift, candidate-only `preflight_change`, `derive_test_plan(preflightId)`, byte-deterministic `verify_change` with trusted `baseRef` rules and `host_asserted` test status | **Done** | OpenAPI response-schema drift, event-version mismatch rules, and SQL `RENAME` refinement remain open for 1.0 |
| **Living Wiki Engine** | 12-category taxonomy, 11 link kinds + `brokenLinkDiagnostics`, FTS5 search, Git/snapshot versions & diffs (`contractChanges`), CAS annotation overlay, offline export | **Done** | Extra `wiki_search` filters, `WIKI_NOTE_CONFLICT` MCP guidance, and narrowed incremental SQLite link/FTS writes remain open for 1.0 |
| **Visual Architecture Portals & Offline Visualizer** | Layered Sugiyama SVG zero-JS HTML, interactive SHA-256 CSP HTML portal, subgraph Mermaid, Architecture Brief Markdown, JSON blueprint, `apps/visualizer` | **Done** *(browser acceptance open)* | Automated DOM/security tests pass; real headless/interactive browser acceptance remains open for 1.0 |
| **4-Host Distribution & Smoke Matrix** | `packages/causoryn` CLI (`setup`/`doctor`/`mcp`), 4 native host manifests, 5 canonical skills, Claude Code & Codex live CLI smoke, ZCode manifest/CLI tests, Antigravity direct `stdio` tests | **Partial** | Antigravity `agy` CLI install/smoke (`NOT RUN`), ZCode desktop GUI install (`NOT RUN`), and live macOS/Linux ARM64 host smoke remain open for 1.0 |

---

## Remaining `1.0.0` Release Gates

`1.0.0` will not be declared until the open gates tracked here and in [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]` are resolved:

1. **Antigravity `agy` CLI live install + smoke** (requires `agy` binary on the host machine; automated direct `stdio` handshake passes, `agy` CLI steps remain `NOT RUN`).
2. **ZCode desktop GUI install + `tools/list` smoke** (deferred so automated runs never mutate a developer's desktop profile).
3. **Live macOS / Linux / ARM64 interactive host smoke** (3-OS GitHub Actions CI passes on `ubuntu-latest`, `windows-latest`, and `macos-15`; live interactive host runs on macOS/ARM64 remain open).
4. **MCP TypeScript SDK v1.x (`^1.32.2`) -> v2 upgrade.**
5. **Live Architecture watcher MCP surface:** per-file incremental `file_facts` caching with early cutoff and TypeScript `oldProgram` reuse are shipped; wrapping the in-process filesystem watcher as an MCP surface remains open (**Partial**).
6. **`Test` / `TESTS` edge extraction in the 4 sidecar languages** (C#, Python, Go, Rust; currently active for TypeScript/JavaScript).
7. **Contract & drift fidelity extensions:** OpenAPI response-schema drift, event-version mismatch rule, and SQL `RENAME` refinement.
8. **Read-only Git revision snapshot comparison workflow ergonomics** without writing into analyzed workspaces.
9. **Living Wiki surface refinements:** exposing `wiki_search` query filters, registering `WIKI_NOTE_CONFLICT` error guidance alongside local note write flows, and narrowing incremental wiki link/FTS rewrites.
10. **Real-browser acceptance verification** for offline interactive HTML portals and `apps/visualizer`.
11. **Bare monorepo bundle default lib (`.d.ts`) scope decision** (`packages/causoryn` already bundles `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`).
12. **Rate-limit / concurrency resource budget wrapper** across concurrent MCP calls.

## Related Pages

- [Architecture Overview](architecture.md) · [MCP Tool Contracts](tool-contracts.md)
- [Host Compatibility Matrix](compatibility-matrix.md) · [Engineering Backlog](BACKLOG.md)
- [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md) · [CHANGELOG.md](../../CHANGELOG.md)
