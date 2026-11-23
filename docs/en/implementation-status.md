# Implementation Status

**Language / Dil:** [Türkçe](../implementation-status.md) | English

> Sprint and release status tables across **Sprint 1 (Phase A: Foundation)**, **Sprint 2 (Phase B: Deep Mapping)**, **Sprint 3 (Phase C: Original Features)**, **Sprint 4 (Phase C2: Living Wiki)**, **Sprint 5 (Phase D: Differentiation)**, **Sprint 6 (Phase E: Agent Change Guard)**, **Sprint 7 (Phase F: Cross-host Release — final)**, **Sprint 8 (Multi-Language Deep Analysis: Python/Go/Rust sidecars + M2 integration)**, and **`v0.2.0`–`v0.2.2` Pre-1.0 Public Preview** · Spec v2.1 §25, §7/§8/§9/§10/§11/§12/§13/§14/§15/§16/§16A/§17/§22/§23.

> **ADR-010 rule (Spec):** Nothing broken or unimplemented is advertised as `Done`. Every status in the tables below reflects verified on-disk reality and recorded gate runs at the time of each milestone; every remaining limitation is stated explicitly.

## Evidence Markers (Legend)

| Marker | Meaning | Verified By |
|---|---|---|
| **[D]** | Verified directly on disk (`read`, `grep`, `ls`, `git diff`, or live command run recorded in that session) | Authoring agent |
| **[R]** | Task-outcome report verified by the orchestrator (executed during the task with red→green evidence) | Orchestrator |
| **[K]** | Gate result: `npm run test` / `typecheck` / `build` / `lint` — **executed green by the orchestrator**; the authoring agent did not re-run the full suite in that session | Orchestrator |
| **[S]** | Static count of `it(`/`test(` blocks via `grep` — **not** an executed test count | Authoring agent |

## v0.2.2 Pre-1.0 Public Preview — Current Implementation

| Version | Delivered behavior | Source and test coverage |
|---|---|---|
| v0.2.1 | CLI automatic indexing runs after MCP initialization. Auto-configured workspaces use root `.gitignore` rules and build/cache exclusions. The indexer merges shared external/virtual nodes and groups SQLite bulk writes in transactions. Job diagnostics and warnings are each capped at 50 response entries. | **[D]** `runtime-cli.ts`, `cli-stdio.ts`, `services.ts`, `index-service.ts`; `runtime-cli-and-roots.test.ts`, `index-service.test.ts`, `sqlite-repository.test.ts`. |
| v0.2.2 | The catalog still has 29 tools. Architecture exports provide default clustered HTML/Mermaid/Markdown/JSON views, an HTML-only interactive portal, and the legacy raw dump. The fifth canonical skill, `architecture-blueprint`, can use caller-supplied `annotations` for an optional host narrative. The SQLite published-snapshot cache uses `PRAGMA data_version` to detect changes from other connections. `doctor` reads its version from the package manifest. | **[D]** `architecture-projection.ts`, `architecture-annotations.ts`, `architecture-export.ts`, `services-architecture.ts`, `sqlite-repository.ts`, `packages/causoryn/src/types.ts`; `architecture-export.test.ts`, `architecture-export-tool.test.ts`, `sqlite-repository.test.ts`, `setup-and-doctor.test.ts`. |

The core produces the evidence graph and artifacts without calling a model. Equivalent snapshots, formats, views, effective options, and validated annotations produce identical architecture export bytes. Export tests check this with fixed annotations and reversed node, edge, and evidence arrays from the same graph. Caller prose is an input and can change the output. MCP request IDs, runtime diagnostics, and progress are tracked separately. [ADR-002](adr/ADR-002-no-llm.md) · [Tool contracts](tool-contracts.md) · [Release notes](../../CHANGELOG.md)

The v0.2.1 and v0.2.2 table entries are based on inspection of the source and test coverage. See the [compatibility matrix](compatibility-matrix.md) for live browser and host acceptance status.

## K-020 / K-021 / K-022 — v0.2.0 Pre-1.0 Public Preview Record (2026-11-18..20)

> Evidence: `wiki/decisions.md` `K-019`..`K-022` · [CHANGELOG.md](../../CHANGELOG.md) `[0.2.0] - 2026-11-20` & `[Unreleased]` · [security-pass.md](security-pass.md) · [compatibility-matrix.md](compatibility-matrix.md) · `.github/workflows/ci.yml` · `.github/workflows/release.yml` · `packages/causoryn/` · `scripts/secret-scan.mjs` · `scripts/generate-sbom.mjs` · `scripts/export-public-tree.mjs`.

Following Sprint 8, four engineering and open-source release-readiness tracks (`K-019`..`K-022`) layered persistent SQLite indexing, multi-host CLI/plugin distribution, supply-chain provenance, and open-source governance onto the 29-tool, 5-language engine. With historical tag `v0.1.0` frozen at `4c9c188f`, the project ships as **`0.2.0` Pre-1.0 Public Preview** (`SERVER_VERSION === "0.2.0"`, **explicitly NOT `1.0.0` per ADR-010**):

| Track | Scope | Status | Evidence Summary |
|---|---|---|---|
| **K-019** (2026-11-18) | Independent external audit closure: 5-language `ROUTES_TO` resolution accuracy (TS/Python/Rust `verified`; C# semantic `verified` or known-name `heuristic`; Go same-package `verified`, selector/unknown `heuristic`/`unresolved`), Antigravity `$schema`-free `plugin.json` + `mcp_config.json` + `mcp.json` + `README.md` + `build:bundle` staging of `scripts/mcp-server.mjs`, 5-language `workspace_summary.languages` & `coverageOf.tier` (`L2`/`L1`/`L0`), structured MCP `annotations` (`readOnlyHint`) across all 29 tools | **Done** | **[D]** `WorkerAnalyzer.cs:1475-1508`, `routes.go:120-170`, `packages/mcp-server/src/server.ts:154-164,555`, `packages/mcp-server/src/services.ts:138-190,362-387`, `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` (1155 lines; live `stdio` handshake — `agy` CLI install/smoke remains `NOT RUN`). |
| **K-020** (2026-11-18) | Pre-1.0 engineering improvements: optional persistent SQLite graph store (`storage.dataDbPath`, fail-closed `validateDataDbPath` outside `allowRoots`, `MAX(sid)` & `revision.sequence` restart continuity) + `symbol_fts` Agent GPS `fts` leg; `causoryn_refresh_index(mode="incremental")` (`scope` explicitly rejected; `B7` honestly stays **Partial** pending per-file parse reuse & watcher MCP surface); TypeScript BDD `Test` node + `TESTS`/`CALLS` extraction (`derive_test_plan` `direct` signal active for TS); `causoryn_export_documentation(format="snapshot")` (`architecture-snapshot.json` under `OutputAccessPolicy`); shared zero-dep `@causoryn/sidecar-ipc`; GitHub Actions CI | **Done** | **[D]** `packages/mcp-server/src/context.ts:139-185,230-357`, `packages/mcp-server/test/sqlite-persistence.test.ts`, `packages/mcp-server/test/pre-1-0-e2e.test.ts`, `adapters/typescript/test/test-intelligence.test.ts`, `packages/sidecar-ipc/test/sidecar-ipc.test.ts`. |
| **K-021** (2026-11-19) | Open-source multi-host distribution (`packages/causoryn`): single publishable npm package (`"name": "causoryn"`, `MIT`, zero external npm `dependencies`), `causoryn setup\|doctor\|mcp` CLI (`_npx` → `~/.causoryn/runtime` atomic staging, `.causoryn.backup` backups), 4-host marketplace manifests (Antigravity, Claude Code, Codex, ZCode/GLM) + 4 canonical `skills/`, zero-config `--allow-cwd` + dynamic MCP `roots/list` (`notifications/roots/list_changed`) + `0o700` CWE-59 `--auto-data-dir` + multi-process SQLite race recovery, `dist/typescript-lib/lib*.d.ts` bundling (`resolveTypeScriptLibDir` → standalone `state: "ready"`), dynamic sidecar asset discovery (`resolveCausorynAssetRoot`), writable Rust `~/.causoryn/cache/rust-worker-target` + `cargo build --locked`, `server.json` + `mcpName` (`io.github.mrbekox/causoryn`) | **Done** | **[D]** `packages/causoryn/package.json`, `packages/causoryn/test/setup-and-doctor.test.ts`, `packages/mcp-server/src/runtime-cli.ts`, `packages/mcp-server/test/runtime-cli-and-roots.test.ts`, `packages/indexing/test/multiprocess-race.test.ts`, `adapters/typescript/test/standalone-lib-resolution.test.ts`, `tests/open-source-distribution.test.ts`. |
| **K-022** (2026-11-20) | Open-source governance, supply chain & `v0.2.0` closure: **`0.2.0` Pre-1.0 Public Preview** version decision (`v0.1.0` frozen at `4c9c188f`; internal analyzer protocol versions kept at `0.1.0` for persistent SQLite `analyzerFingerprint` continuity); `MIT` license (`Causoryn Contributors`) + generated `THIRD-PARTY-NOTICES.md` & `licenses/`; deterministic Release Roslyn build (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en` — zero PDB path leaks); `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml`; Option 1 clean public exporter (`scripts/export-public-tree.mjs`); 40-char SHA-pinned 3-OS `.github/workflows/ci.yml` (`ubuntu-latest`, `windows-latest`, `macos-latest`) + OIDC `.github/workflows/release.yml` (`SHA256SUMS.txt` + 13-component CycloneDX 1.5 SBOM via `scripts/generate-sbom.mjs` + `actions/attest-build-provenance` + tokenless `npm publish --provenance --access public`); `runtime-cli.ts` sensitive/system root denylist + `git-read.ts` minimal env allowlist & post-open `fstat`/TOCTOU check + pre-import Node `>=24` guard + `--expected-version` pin; `scripts/secret-scan.mjs` across **13 roots + 13 root text files** (0 matches); atomic `build-bundle.mjs` + explicit 20 s spawn timeouts (**89 default-suite test files** + 1 bench file, **`1600+` tests**); `eslint@10.15.0` & `typescript-eslint@8.73.0` upgrade bringing `npm audit` to **0 vulnerabilities** | **Done** | **[D]** `package.json`, `packages/causoryn/THIRD-PARTY-NOTICES.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/generate-sbom.mjs`, `scripts/export-public-tree.mjs`, `scripts/secret-scan.mjs`, `tests/ci-workflow.test.ts`, `tests/public-export.test.ts`, `tests/secret-scan.test.ts`, `tests/release-docs.test.ts`. |

## Remaining 1.0.0 Gates as of v0.2.2 (ADR-010)

`K-020`..`K-022` closed `npm audit` (`0 vulnerabilities`), `secret-scan` (13 roots + 13 root files), the 3-OS CI matrix (`ubuntu`/`windows`/`macos`), `refresh_index(mode="incremental")`, TypeScript `Test`/`TESTS`, `export_documentation(format="snapshot")`, and `packages/causoryn` `dist/typescript-lib/lib*.d.ts`. The following gates tracked under [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]` remain open before `1.0.0` can be declared:

1. **Antigravity `agy` CLI live install + smoke** (requires `agy` binary on the host machine; direct `stdio` handshake is automated, `agy` CLI steps remain `NOT RUN`).
2. **ZCode in-GUI install + `tools/list` smoke** (deferred under red line 6 to avoid mutating user desktop installations).
3. **Live macOS / Linux / ARM64 host smoke** (3-OS CI runs on every push/PR; live desktop/CLI host smoke on macOS/ARM64 remains open).
4. **MCP SDK v1.x (`1.32.2`) → v2 upgrade** (closes `K-009`).
5. **B7 Live Architecture full completion:** per-file parse reuse and exposing the FS watcher as an MCP tool (`B7` therefore remains **Partial**).
6. **`Test`/`TESTS` extraction in the 4 sidecar languages** (`csharp`, `python`, `go`, `rust`; `derive_test_plan` `direct` signal is currently active for TypeScript only).
7. **Contract/drift fidelity extensions:** OpenAPI response-schema drift (`K-015(5)`), event-version rule (`K-015(4)`), and SQL `RENAME` handling (`K-015(3)`).
8. **`.causoryn/architecture-snapshot.json` revision workflow automation** (`export_documentation(format="snapshot")` writes to authorized output dirs; automatic writes into the source tree remain forbidden under `ADR-008`).
9. **Living Wiki surface refinements:** `wiki_search` query filters (`pageKind`/`language`/…), `WIKI_NOTE_CONFLICT` `TOOL_ERROR_GUIDANCE` entry, and narrowing incremental wiki link/FTS rewrites.
10. **E6 offline visualizer real-browser verification.** Interactive HTML is available through `causoryn_export_documentation(format="html", view="interactive")` in v0.2.2. Browser interaction acceptance remains open.
11. **Bare F1 `packages/mcp-server/dist/` `.d.ts` scope decision** (solved in `packages/causoryn` via `dist/typescript-lib/`; bare F1 clone boundary remains documented).
12. **Rate-limit / concurrency resource budget (`K-010`).**

## Sprint 8 — Multi-Language Deep Analysis: M1-Python · M1-Go · M1-Rust + M2 Integration (2026-11-15/16, branch: `feat/multi-language-deep-analysis`)

> Evidence: Spec v2.1 §7 (language adapters), §8 (node/edge kinds + evidence requirement: verified edge ≥ 1 evidence — `relativePath`, `span`, `sourceHash`, `analyzerId`), §23 (language plan) · Roslyn sidecar pattern (stdin/stdout line-JSON protocol + `PROTOCOL.md` + timeout + graceful fallback → L0/L1; live reference: `adapters/csharp-roslyn` + `native/roslyn-worker`) · Sprint-8 task-outcome reports (orchestrator-verified: m1-python round-2, m1-go, m1-rust, m2) · live toolchain builds/spawns and 6 test suites executed directly on 2026-11-16 (summarized below under "Sprint Gate").

> Marker usage in this section: **[D]** direct disk checks (`read`, `grep`, `ls`, `git log/show/diff`, `npm ls --package-lock-only`, `sha256sum`) **and live toolchain executions** (`go build`, `cargo build`, manual spawns of all three workers + 6 Vitest suites) run on 2026-11-16; **[R]** orchestrator-verified task reports (test counts in those reports reflect pre-security-pass trees); **[K]** orchestrator gate results (`npm run test`/`typecheck`/`build`/`lint` — **all green**) + security review (**3 findings, all resolved, gates re-verified green**). Honesty note: the authoring agent ran **195 tests across 6 files** (26+48+43+30+9+39, all green) + 3 direct worker spawns against the post-security-fix working tree rather than re-running the full suite; `go-adapter` (48 vs 44) and `rust-worker` (43 vs 37) counts are higher than the earlier task reports due to the added security-pass tests.

> **[D] Sprint 8 commit map (`git log --oneline` + `git show --stat`):** `9a159a3` **feat(adapters): python, go and rust deep-analysis sidecars with fixtures** (2026-11-15; 58 files, +13,734 — `native/{python,go,rust}-worker`, `adapters/{python,go,rust}`, `examples/fixture-{python,go,rust}-app`, `tests/{python,rust}-worker.test.ts`, `.gitignore`) → `9ec264e` **feat(indexing,mcp-server): route py/go/rs sources through language adapters** (9 files, +1,273/−103 — `INDEXED_ADAPTERS` expanded to 5 entries, `index-service` pipeline routing, `packages/indexing/test/index-service-multilang.test.ts` +500 lines, `packages/mcp-server/test/mcp-server.test.ts` +27), followed by security-review fixes across 12 files (+879/−37) merged in PR #14 (`5d6357c`).

### Sprint 8 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| M1-Python | `native/python-worker` (stdlib `ast` sidecar, line-JSON protocol v1 + `PROTOCOL.md`) + `adapters/python` (spawn, timeout, graceful fallback) + round-2 audit closure (deep-JSON `RecursionError`, stale `PYTHONIOENCODING` note, accurate liveness rationale) | **Done** | **[D]** Verified on disk: `native/python-worker/worker.py:1064` (`except (RecursionError, MemoryError, ValueError)`) and `:1098-1100` (`except (ValueError, RecursionError)` in `handle_line`); `tests/python-worker.test.ts:670` deep-nested JSON survivor test; `native/python-worker/PROTOCOL.md:24-34,104-109,280,337`. **[D] LIVE SPAWN RUN:** fed `examples/fixture-python-app` (`app.py`, `services/orders_service.py`, `repositories/order_repository.py`) to `native/python-worker/worker.py` → **exit 0**, `id` echoed verbatim, `status=ready`, `protocolVersion=1`, **21 nodes** (3 File / 1 Class / 8 Function / 2 Method / 2 Endpoint / 5 UnknownExternal), **25 edges**, 25 evidence items, `coverageRatio=0.64`. **[D] LIVE RESILIENCE RUN:** 5,000-nested JSON array followed by valid request on the same process → line 1 `id=null` + `status=error` + `INVALID_ARGUMENT`; line 2 `status=ready` + 21 nodes — **worker survived and served subsequent request**. **[D]** `npx vitest run tests/python-worker.test.ts` → **26/26 passed** (2.02 s); `adapters/rust/test/rust-adapter.test.ts` + `adapters/python/test/python-adapter.test.ts` → **30/30** (rust 13 + python 17). **[R/K]** Failing-first red→green verified; gates green. |
| M1-Go | `native/go-worker` (stdlib `go/parser`+`go/ast` sidecar, `PROTOCOL.md` v1 — 5-pattern honesty table §3, 120 s cold-compile timeout §8) + `adapters/go` (default `go run` + `goWorkerBinaryPath` binary mode; L0/L1 fallback) + `examples/fixture-go-app` (handler→service→repo + route) | **Done** | **[D]** `native/go-worker/cmd/worker/main.go:75-86` `defaultCapabilities` declares `SymbolResolution:false` (no `go/types` semantic resolution in this slice); `native/go-worker/PROTOCOL.md:91,115,194-218,226-231,309` documents all 5 call patterns (same-package bare-ident top-level func → `verified` with local-shadowing boundary noted; builtins → no edge emitted; unknown → `unresolved` + `UnknownExternal`; `pkg.Func` qualified → `heuristic` + ambiguity; undefined `pkg.X` → `unresolved`) plus Handle/HandleFunc and chi/gin/echo route registrations. **[D] LIVE GO RUN:** `go1.27.4 windows/amd64`; `go build -C native/go-worker ./...` → **BUILD_OK**; binary run on `examples/fixture-go-app` → **exit 0**, `status=ready`, `pv=1`, **27 nodes** (3 File / 3 Class / 8 Function / 4 Method / 3 Endpoint / 6 UnknownExternal), **39 edges**, **`coverageRatio=0.6923`**. **[D]** `npx vitest run adapters/go/test/go-adapter.test.ts` → **48/48 passed** (9.56 s; includes spawn-safety tests). Surface capability label in `packages/indexing/src/index.ts:208` is `"heuristic-only (semantik L2 yok)"`. **[R/K]** Determinism across `go run` ×2 and binary mode proven; gates green. |
| M1-Rust | `native/rust-worker` (`syn` 2 + `serde_json` Cargo project, line-JSON protocol v1 + `PROTOCOL.md`) + `adapters/rust` (`cargo build` + spawn + framing/timeout + fallback) + `examples/fixture-rust-app` (route→service→repo) | **Done** | **[D]** `native/rust-worker/PROTOCOL.md:188,206-212` documents deterministic symbol-table matching (`verified` for same-module bare fn and single-match qualified path with module-prefix limit documented; `heuristic` for `x.foo()` method calls without trait dispatch; rationale explicitly notes syn AST has no semantic resolver); `native/rust-worker/src/analyzer.rs:1076-1094` + `src/protocol.rs:29-32,203` enforce `MaxResponseNodes`/`RESPONSE_TRUNCATED` budget. **[D] LIVE RUST RUN:** `cargo 1.100.0`; `cargo build --manifest-path native/rust-worker/Cargo.toml` → finished `dev` profile; binary run on `examples/fixture-rust-app` → **exit 0**, `status=ready`, `pv=1`, **25 nodes** (3 File / 3 Class / 1 Interface / 4 Function / 8 Method / 2 Endpoint / 4 UnknownExternal), **31 edges (23 verified / 4 heuristic / 4 unresolved)**, `coverageRatio=0.7419`, `diagnostics: []`. **[D] LIVE NEGATIVE RUN:** `maxNodes:0` request + valid request on same process → line 1 `INVALID_ARGUMENT`; line 2 `ready` + 25 nodes (survivor). **[D]** `npx vitest run tests/rust-worker.test.ts` → **43/43 passed** (15.69 s); `adapters/rust/test/rust-adapter.test.ts` → **13/13**; 5,000-deep parens survived via 256 MB stack thread. **[R/K]** Gates green. |
| M2 | Unified 5-language snapshot pipeline: `INDEXED_ADAPTERS` 5 entries; `runIndexAsync`/`runIncrementalIndexAsync` routing `.py`/`.go`/`.rs` to real worker spawns; adapter-internal L0/L1 fallback when worker unavailable; synchronous bridge never spawns workers (source-hashed L0 File nodes + explicit warning); `fp2` fingerprint per-language worker state + config hash | **Done** (`npm ci` clean install verified 2026-11-16) | **[D]** `packages/indexing/src/index.ts:168-224` holds **5 entries** (`typescript`, `csharp`, `python`, `go`, `rust`) with honest labels (`"heuristic-only (semantik L2 yok)"` for Go, `"heuristic-heavy"` for Rust, `"decorator-route-pattern (L3)"` for Python — no fabricated `"L2"` claims); `packages/indexing/src/index-service.ts:957-994,1125,1148,1173`. **[D]** `npx vitest run packages/indexing/test/index-service-multilang.test.ts` → **9/9 passed** (13.79 s; mixed 5-language fixture → single `ready` snapshot; missing-worker degradation → L0/L1 + explicit warning while remaining languages stay full; incremental `.py` change vs no-op) + `npx vitest run packages/mcp-server/test/mcp-server.test.ts` → **39/39 passed** (22.99 s). **[D]** Orchestrator executed a clean `npm ci --ignore-scripts` install (exit 0) and verified **76 files / 1,424 tests passed** on 2026-11-16. |

**Sprint 8 Overall: M1-Python, M1-Go, M1-Rust, M2 — 4/4 Done (clean `npm ci --ignore-scripts` verified 76 files / 1,424 tests passed; zero `Not Started` or broken core slices).** Quality gates (`test`/`typecheck`/`build`/`lint`) green [K]; security review surfaced 3 findings, all resolved and re-verified green [K].

### Sprint Gate — Live Runs Executed by the Authoring Agent on 2026-11-16 [D]

Live toolchain runs (all three sidecar languages independently) and test suites — command → output summary:

1. **Python worker spawn:** `native/python-worker/worker.py` + `fixture-python-app` payload → exit 0, `ready`, `pv=1`, 21 nodes / 25 edges / `coverageRatio` 0.64; **deep-JSON survivor:** 5,000-layer nested array + valid request → `id=null INVALID_ARGUMENT` + `ready` (zero crash).
2. **Go build + run:** `go version` → `go1.27.4`; `go build -C native/go-worker ./...` → `BUILD_OK`; binary run → exit 0, `ready`, 27 nodes / 39 edges / `coverageRatio` 0.6923 (matches task report digit-for-digit).
3. **Rust build + run:** `cargo --version` → `1.100.0`; `cargo build --manifest-path native/rust-worker/Cargo.toml` → finished `dev` profile; binary run → exit 0, `ready`, 25 nodes / 31 edges (23v/4h/4u) / `coverageRatio` 0.7419; **`maxNodes:0` → `INVALID_ARGUMENT` + survivor** (response budget active).
4. **Test suites (all green):** `tests/python-worker.test.ts` 26/26 (2.02 s) · `adapters/go/test/go-adapter.test.ts` 48/48 (9.56 s) · `tests/rust-worker.test.ts` 43/43 (15.69 s) · `adapters/rust/test/rust-adapter.test.ts` + `adapters/python/test/python-adapter.test.ts` 30/30 · `packages/indexing/test/index-service-multilang.test.ts` 9/9 (13.79 s; real 5-language worker runs) · `packages/mcp-server/test/mcp-server.test.ts` 39/39 (22.99 s). Total: 6 files, 195 tests.
5. **Read-only lockfile check:** `npm ls --package-lock-only` exit 0 (zero UNMET/invalid) + `sha256sum package-lock.json` identical before/after (`0d391b76975ae402`), subsequently confirmed by the orchestrator's full `npm ci --ignore-scripts` clean install.
6. **Honesty note:** full `npm run test` was owned and run green by the orchestrator [K]; higher `go-adapter` (48 vs 44) and `rust-worker` (43 vs 37) counts reflect post-security-review test additions.

### K-018 Proposal — Multi-Language Resolution Honesty (Decision Text; Written to `wiki/decisions.md` by Orchestrator)

Prepared in the `K-001`..`K-017` decision-table convention (later recorded in `wiki/decisions.md` as `K-018` and refined for C#/Go `ROUTES_TO` in `K-019(1)`):

> **K-018: Multi-language `CALLS` resolution honesty — resolution labels are fixed per language by `PROTOCOL.md` tables; capability declarations never claim more than actual analyzer behavior** (2026-11-16)
>
> (1) **Python** (`native/python-worker/PROTOCOL.md:230-232`): `verified` = target defined in the SAME module (module-level `def`/`class`, `self.<m>` member table, `SameModuleClass.<m>`); `ROUTES_TO` always `verified` (syntactic decorator→handler binding); `heuristic` = imported module symbol (edge carries `ambiguity`; no full type inference — Spec §7 monkey-patching/runtime DI limits); `unresolved` = local variable/builtin/unknown name → `UnknownExternal` node, zero fabricated targets.
> (2) **Go** (`native/go-worker/PROTOCOL.md:194-212`): same-package bare-ident top-level `func` match → `verified` (local variable shadowing is indistinguishable from AST alone — documented boundary); `pkg.Func` qualified call / unique method name / interface method candidate / out-of-set import chain → `heuristic` + ambiguity (no `go/types`); builtins → NO edge emitted; multi-candidate/unresolved selector → `unresolved` + candidate list; `capabilities.symbolResolution:false` projects onto the MCP surface as `"heuristic-only (semantik L2 yok)"` (`packages/indexing/src/index.ts:208`).
> (3) **Rust** (`native/rust-worker/PROTOCOL.md:206-207`): same-module bare call → `verified`; qualified path call `verified` ONLY on a SINGLE match in the analyzed symbol table (module prefixes not fully validated — documented); method call `x.foo()` → `heuristic` (no trait dispatch; multi-candidate carries `ambiguity`); zero candidates → `unresolved` + `UnknownExternal`; `verified` reflects deterministic symbol-table matching rather than a semantic type model, stated explicitly in evidence rationales.
> (4) **Shared principle:** L3 route detection in Python/Go/Rust is syntactic (Python decorators / Go `HandleFunc` + chi-gin-echo registrations / Rust attribute macros) and carries span + `sourceHash` + `analyzerId` evidence *(see `K-019(1)` for C# and Go `ROUTES_TO` resolution nuances)*; missing/unbuildable workers degrade inside the adapter to L0/L1 with explicit warnings — the engine never fabricates semantic targets.

Note: two shorthand phrases in the initial orchestrator brief did not match on-disk code and were corrected in `K-018` per `ADR-010`: (a) Go package-qualified calls are `heuristic`+ambiguity, NOT `verified`; (b) Rust is not purely heuristic — same-module bare calls and single-match qualified paths are `verified`.

### Sprint 8 Open Items (Notes for Orchestrator / User)

1. **~~M2 clean `npm ci` verification~~ → CLOSED (2026-11-16 orchestrator):** `npm ci --ignore-scripts` ran clean (exit 0, 76 files / 1,424 tests passed).
2. **~~Uncommitted security-pass fixes~~ → CLOSED (PR #14 `5d6357c`):** 12 modified files (+879/−37) committed and merged.
3. **~~Wiki records~~ → CLOSED:** `wiki/sprint-8.md`, `wiki/decisions.md` (`K-018`), and `wiki/log.md` updated by orchestrator.
4. **1 skipped test in suite** [D]: `packages/graph/test/compare.test.ts:720` (`ctx.skip()`) — pre-existing documented skip since Sprint 7, unrelated to Sprint 8.
5. **Cosmetic notes** (non-blocking): `IndexRunResult` lacks dedicated `.py`/`.go`/`.rs` counter fields (counts are derivable from snapshot `File` nodes and `workspace_summary.languages`); early-exit warning text was expanded to `"TypeScript/TSX/C#/Python/Go/Rust"` [R].
6. **Sprint 7 open items remain active** [D]: F9's `1.0.0` gate count carried forward (later narrowed by `K-020`..`K-022` as recorded at the top of this document).

## Sprint 7 — Phase F: Cross-host Release (2026-11-08/09 · Final Wave 2026-11-10, FINAL)

> Evidence: Spec v2.1 §17 (packaging; §17.1 requires `scripts/mcp-server.mjs` to be a genuinely compiled runnable entrypoint), §22 (cross-host smoke + security matrix + explicit `NOT RUN` reporting if `agy` CLI is absent), §23 (Phase F gate: "18 modules + Living Wiki Done + release test matrix + changelog") · `wiki/sprint-7.md` F1–F9 · orchestrator-verified F1–F7 reports + `tests/release-docs.test.ts` executed directly · [security-pass.md](security-pass.md) · [benchmarks.md](benchmarks.md) · [compatibility-matrix.md](compatibility-matrix.md).

> **Phase F commit map — two waves [D, `git log`]:** Wave 1 (2026-11-08/09): `806c719` (F1 bundle) → `88743fd` (F2–F5 integrations) → `9236cb7` (F6+F7) → `b85ffff` (F8 docs + F9 version decision). **Final wave (2026-11-09/10):** `60735ff` (bundle rebuild + `npm run bench` script + `tests/bench-release` default-suite exclusion) → `1d2a450` (host docs: `claude 2.1.322` re-run, Codex TOML re-serialization warning, Antigravity cleanup protocol) → `e3d0bc2` (F6 security re-run + `F6-K7` bundle-level git-refs behavioral proof + F7 final benchmark medians). Stale wave-1 claims are locked out by `tests/release-docs.test.ts`.

> Marker usage in this section: **[D]** direct disk checks and `npx vitest run tests/release-docs.test.ts` red→green runs (wave 1: `18 failed | 4 passed` → `22/22`; final wave: `5 failed | 22 passed` → `27/27`; audit loop: `4 failed | 27 passed` → `33/33`); **[R]** orchestrator-verified F1–F7 reports across both waves; **[K]** orchestrator full-suite gates.

### Sprint 7 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| F1 | Packaging: esbuild bundle `packages/mcp-server/dist/mcp-server.mjs` (external `better-sqlite3`; native `.node` cannot be inlined) + vendored runtime copy + deterministic `dist/bundle-manifest.json` | **Done** (with documented boundary) | **[R]** Two builds are bit-for-bit identical; sorted SHA-256 manifest matches `mcp-server.mjs` byte-for-byte. **[D]** Zero "single-file" exaggeration: artifact is `mcp-server.mjs + dist/node_modules/better-sqlite3/` (`ADR-010`); verified in `tests/hosts-docs.test.ts`. Rebuilt in final wave `60735ff` (initial wave `806c719`). |
| F2 | ZCode plugin: dev marketplace (`integrations/zcode/.claude-plugin/marketplace.json`) + manifest validation | **Done** (manifest-level; GUI install not run) | **[D]** `plugin-dev-marketplace.test.ts` (338 lines) + `plugin-package.test.ts` (+243) on disk. **[R]** ZCode has no CLI installer (desktop GUI flow); live user installation left untouched under red line 6; manifest schema tests green (`88743fd`). |
| F3 | Claude Code: `.mcp.json` example + live `/mcp` CLI smoke | **Done** | **[R]** Live CLI smoke in TWO waves: initial 2026-11-08 on `claude 2.1.319`, **re-verified 2026-11-10 on `claude 2.1.322`** — isolated `CLAUDE_CONFIG_DIR` (`add -s local` → `list` showing `causoryn ✔ Connected` → `remove`); `~/.claude.json` `sha256sum` identical before/after; negative invalid-command check surfaces `✘ Failed to connect — CONNECTION_CLOSED` ([hosts/claude-code.md](hosts/claude-code.md), `1d2a450`). `stdout` purity: 2 lines of pure JSON-RPC, `tools/list` → 29 tools. **[D]** `tests/hosts-docs.test.ts` F3 blocks green. |
| F4 | Codex: `config.toml` / `codex mcp add` + `codex mcp list` smoke | **Done** | **[R]** Live `codex-cli 0.163.0` smoke in TWO waves (2026-11-08 and **2026-11-10**): `codex mcp add causoryn-smoke` → `list` (visible) → `remove` → `list` (clean); documented `config.toml` re-serialization backup/hash-restore discipline and honest boundary that `codex mcp list` performs no live health-check ([hosts/codex.md](hosts/codex.md)). **[D]** F4 test blocks green. |
| F5 | Antigravity: `plugin.json` + `mcp_config.json` + `mcp.json` (report `NOT RUN` when `agy` CLI is absent) | **Not Run** (artifacts + direct `stdio` spawn ready; `agy` install/smoke not run) | **[D]** No `agy` CLI on machine (`agy --version` command not found; [hosts/antigravity.md](hosts/antigravity.md)). Shipped `$schema`-free `plugin.json` + `mcp_config.json` + portable `mcp.json` (Spec §17.1) + `README.md` + `build:bundle`-staged `scripts/mcp-server.mjs` (+ vendored `better-sqlite3`), verified by `antigravity-plugin.test.ts` (1155 lines: manifest schema, live `stdio` 29-tool handshake, negative/honesty guards). Per Spec §22 & `ADR-010`, **all `agy` CLI install/smoke commands are reported `NOT RUN`**. |
| F6 | Security pass: Spec §22 matrix against the packaged bundle | **Done** (9/9 PASS) | **[R]** `symlink/traversal`, `secret leakage` (8-pattern static scan + canary self-test + behavioral baits), `symlink TOCTOU`, `poisoned source comment`, `oversized files`, `malicious Git refs`, `network denied` (`net-guard.cjs` preload — empty netlog), `offline HTML XSS/CSP`, `stdout` purity (5 independent spawn sessions). **Final wave (2026-11-10, `e3d0bc2`):** re-verified end-to-end and elevated row 6 to bundle-spawn behavioral proof (`F6-K7`: real commit SHA resolved via `git cat-file` inside bundle; `..%2Fevil`, `main; rm -rf /`, unknown branch → `INVALID_REVISION`). `f6-security-release.test.ts` → **32/32**; full `tests/security-release/` → **36/36**; `tsc` exit 0. See [security-pass.md](security-pass.md) (`9236cb7`, `e3d0bc2`). |
| F7 | Performance benchmark: 1k-file deterministic TS fixture | **Done** (with measured medians) | **[R]** MCP protocol-level medians across two runs, both far below Spec §21 design targets (`<1000` / `<500` / `<2000` ms): initial 2026-11-08 (`5.3 / 8.2 / 5.7 ms`), **final 2026-11-10 (`11.8 / 13.0 / 10.7 ms`; cold index `16370.3 ms` — canonical record in [benchmarks.md](benchmarks.md))**. **[D]** Separated from `npm run test` in `60735ff` via `npm run bench` + `vitest.bench.config.ts` (`CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench`). |
| F8 | Docs: `architecture.md`, `tool-contracts.md`, `compatibility-matrix.md`, `CHANGELOG.md`, `implementation-status.md` | **Done** | **[D]** Authored in wave 1 and updated in final wave (2026-11-10) with `claude 2.1.322`, F6 `32/32` (`36/36`), F7 final medians, and `npm run bench` build-contract separation; verified red→green via `tests/release-docs.test.ts`. |
| F9 | Version tag decision: `0.1.0` public snapshot vs `1.0.0` | **Done** (decision: **`0.1.0` public snapshot**) | **[D]** Synchronized across root `package.json` (`0.1.0` === `SERVER_VERSION` at F9), `CHANGELOG.md` `[0.1.0] - 2026-11-09` + `[Unreleased]` 1.0.0 gates, and `compatibility-matrix.md`. Zero published `## [1.0.0]` heading (`ADR-010`). *(Later incremented to `0.2.0` Pre-1.0 Public Preview in `K-022` while keeping `v0.1.0` frozen at `4c9c188f`.)* |

### Sprint Gate (F8) — Verification Test Runs

**[D] Executed directly** via `npx vitest run tests/release-docs.test.ts`:

1. **Wave-1 red run (before docs existed):** `Tests 18 failed | 4 passed (22)` — failing-first proof enumerating missing F8 deliverables.
2. **Wave-1 green run:** **22/22 passed** — positive inventory, `TOOL_NAMES` set equality, 4 host rows, `## [0.1.0]` changelog entry, and negative honesty guards (no unpublished tools, Antigravity `NOT RUN` without `PASS`, ZCode manifest-only, no `## [1.0.0]`, `B7` still `Partial`).
3. **Final-wave red run (2026-11-10, after adding staleness guards):** `Tests 5 failed | 22 passed (27)` — caught wave-1 leftovers (`2.1.319`, `26/26`, `4` spawns, `5.3/8.2/5.7 ms`).
4. **Final-wave green run:** **27/27 passed** (expanded to **33/33** in the 2026-11-10 audit loop pinning all 12 F9 gates in `CHANGELOG.md` `[Unreleased]`, and **46/46** in `K-022` bilingual parity).
5. **Complementary suites [R/K]:** `tests/hosts-docs.test.ts`, `tests/security-release/` (36/36), `npm run bench`, and full orchestrator gate (`70 files / 1,266 tests passed` at Sprint 7 close).

### F9 Version Decision — Rationale (ADR-010)

**Historical Sprint-7 Decision: `0.1.0` public snapshot (`1.0.0` NOT declared; updated to `0.2.0` Pre-1.0 Public Preview in `K-022`).**

- **Delivered at F9:** 29/29 real MCP tools (zero stub handlers); F6 security matrix 9/9 PASS; F7 measured benchmarks; deterministic bundle + host smoke documentation; Keep a Changelog release notes.
- **The 12 honesty items that blocked `1.0.0` at F9 (with post-Sprint-8 `K-020`..`K-022` updates noted):**
  1. Host CLI run coverage 2/3: Antigravity `agy` CLI install/smoke `NOT RUN` (F5).
  2. ZCode in-GUI install/smoke not run (red line 6; manifest-level validation only).
  3. Platform distribution verification limited to Windows x64 at F9 *(3-OS CI `ubuntu`/`windows`/`macos` added in `K-020`/`K-022`; live macOS/ARM64 host smoke remains open)*.
  4. MCP SDK `1.32.2` (v1.x line) vs Spec §6 SDK v2 target (`K-009`).
  5. B7 Live Architecture `Partial` remainders: no per-file parse reuse; watcher not wrapped as an MCP tool *(`refresh_index mode=incremental` opened in `K-020`)*.
  6. `derive_test_plan` `direct` signal dormant in C#/Python/Go/Rust sidecars *(TypeScript BDD `Test`/`TESTS` extraction added in `K-020`)*.
  7. OpenAPI discovery omits response-schema drift (`K-015(5)`); Spec §11 event-version rule deferred (`K-015(4)`); SQL `RENAME` → `unknown` (`K-015(3)`).
  8. `.causoryn/architecture-snapshot.json` workflow automation *(`export_documentation(format="snapshot")` producer added in `K-020` under `OutputAccessPolicy`; automatic workspace writes remain forbidden per `ADR-008`)*.
  9. `wiki_search` query filters (`pageKind`/`language`/…) absent on tool surface; `WIKI_NOTE_CONFLICT` missing from `TOOL_ERROR_GUIDANCE`; incremental wiki publish rewrites link/FTS indexes from the full graph.
  10. Rate-limit/concurrency resource budget out of scope (`K-010`); dedicated secret-scan script *(closed in `K-019`/`K-022` via 13-root `scripts/secret-scan.mjs`)*; `npm audit` dev-toolchain moderates *(closed in `K-022` via `eslint@10.15.0` + `typescript-eslint@8.73.0` → **0 vulnerabilities**)*.
  11. E6 offline visualizer verified without a GUI browser run; no MCP tool wrapper writing viewer HTML to output dirs.
  12. Bare F1 bundle omits default-lib `.d.ts` files *(solved for `packages/causoryn` open-source distribution via `dist/typescript-lib/lib*.d.ts` in `K-021`)*.

### Sprint 7 Open Items (Notes for Orchestrator / User)

1. **F5 Antigravity `agy` CLI run** [D]: execute the `NOT RUN` checklist in [hosts/antigravity.md](hosts/antigravity.md) once `agy` CLI is installed (`README.md`, `mcp_config.json`, and `build:bundle` staging of `scripts/mcp-server.mjs` + live `stdio` handshake were completed in `K-019`).
2. **ZCode GUI install + `tools/list` smoke** [D]: run with user approval in desktop ZCode and update [compatibility-matrix.md](compatibility-matrix.md).
3. **~~Commit/push + wiki records~~ → CLOSED (`PR #13`, `v0.1.0` tag `4c9c188`):** `wiki/sprint-7.md`, `K-017`, and F8 final docs committed.
4. **Cross-platform verification** [D]: 3-OS CI (`ubuntu`/`windows`/`macos`) added in `K-020`/`K-022`; live macOS/ARM64 host smoke remains open.
5. **Bundle `.d.ts` fidelity** [R→D]: solved in `packages/causoryn` (`K-021`); bare F1 `packages/mcp-server/dist/` boundary remains documented in [security-pass.md](security-pass.md).
6. **Carry-over items from earlier sprints** [D]: all open items from F9's 12-point list are cross-pinned into [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]` by `tests/release-docs.test.ts`.

## Sprint 6 — Phase E: Agent Change Guard (2026-11-08)

> Evidence: Sprint-6 task reports `e1`–`e6` + MCP audit rounds + direct disk spot-checks and 7 gate test files (89 tests) run on 2026-11-08 · Spec v2.1 §10.4 (`verify_change`; p.11), §13 (Impact/Diff/Timeline trends), §16 (Export/visualizer), §23 (Phase E plan) · `K-015` · `wiki/sprint-6.md`.

> **[D] Phase E commit map (`git log`):** `3358137` **E1+E2+E3 core + E5 graph surface** (`packages/verification` + `timeline.ts` violation trend) → `b28c3d9` **E6** (`apps/visualizer` offline HTML+SVG viewer) → `a1ec173` **MCP surface** (`causoryn_verify_change` 29th tool, `services-verification.ts`, `faz-e-verify-change.test.ts`, `preflight-store.ts`, E4 `get_evidence` finding-chain description) → `f5fd425` **Phase E security-review fixes** (**61 files / 1,116 tests passed**).

### Sprint 6 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| E1 | `packages/verification` — pure `verify_change` core: `preflightId` (D4 manifest via injected resolver) OR explicit scope vs working-tree projection; 4 checks (`architecture`, `contracts`, `graph-diff`, `test-plan`); byte-deterministic `serializeVerificationReport` | **Done** | **[D/R]** `packages/verification/src/{errors,types,verify-change,index,test-status-schema}.ts`; `NO_FINDINGS_CORE_DISCLAIMER` (`types.ts:114`), `OBSERVED_TEST_RUN_SCHEMA` (`test-status-schema.ts:61`); input array order permutation leaves output unchanged (Spec §8 invariant vi); `verify-change.test.ts` **34/34 passed**. **[K]** gates green. |
| E2 | Verdict semantics: deterministic 8-rule priority chain (`VERIFY_VERDICT_RULES`: `blocking_findings` > `inconclusive` > `review_required` > `no_findings`), mandatory core disclaimer on every report, `verdictRationale` (`[0]` is deciding rule), `incompleteChecks` | **Done** | **[D/R]** `types.ts:81,114,246,259`; red→green across all 4 verdict outcomes (suppressed/unresolved/warning elevated to `review_required`, missing policy/drift to `inconclusive`). **[K]** gates green. |
| E3 | Test-status honesty: default `not_run` (`candidateStatuses`); `observed` accepted ONLY with mandatory `evidenceRef` + `evidenceSha256` (`OBSERVED_TEST_RUN_SCHEMA`); `passed: true` emitted only when observed + evidenced + passing (`passed: false` key physically absent on failing observed runs); `not_run` branch forbids `passed`/`evidenceRef` at compile time (`@ts-expect-error`); engine never runs tests | **Done** | **[R/D]** Failing-first 9 red → 31/31 green; also fixed an E1 scope-derivation bug when `verify_change` ran without explicit scope on a non-empty diff. **[K]** gates green. |
| E4 | `causoryn_get_evidence` chain enrichment (Spec §10.2): `finding:` ID branch (deterministic derivation from `check_architecture` policy), `targetId`, `partial`/`missingFields`/`contextRefs`/`chain`, updated `tools/list` description | **Done** | **[D/R]** `server.ts:387`, `services.ts:1765,1965`; `packages/mcp-server/test/evidence-chain.test.ts` **15/15 passed**; canonical byte-ascending ordering (`K-016(2)`). **[K]** gates green. |
| E5 | `causoryn_architecture_timeline` violation trend (Spec §13): each ref evaluated against C2 guard rules (`no-cycles`/`forbidden-dependency`); separate per-metric trend arrays; zero composite quality score (`qualityScore` forbidden); read-only `git cat-file` blob reads | **Done** (with documented boundary) | **[D/R]** `timeline.ts:1096` `buildTimelineViolationTrend`; `timeline-trend.test.ts` + `faz-e-timeline-trend.test.ts` **16/16 passed**; byte-identical across repeated runs. **[K]** gates green. |
| E6 | Offline visualizer (`apps/visualizer`): zero-`@causoryn`-dependency deterministic `generate-viewer.ts`; self-contained offline HTML (inline CSS+JS, strict CSP, zero external URLs), custom inline SVG (`verified` solid green / `heuristic` dashed yellow / `unresolved` dotted gray), selection→evidence panel from embedded JSON island | **Done** (with documented boundary) | **[D/R]** Zero `import` lines in `apps/visualizer/src/generate-viewer.ts`; `tests/visualizer-viewer.test.ts` **11/11 passed** (`<script>` node-name escaping, 17 external-resource patterns = 0, dangling-edge rejection, permutation determinism). Documented boundaries: no GUI browser run; standalone module without MCP export tool wrapper. |
| MCP | Phase E MCP surface: `causoryn_verify_change` stdio wiring (`TOOL_NAMES` 28 → **29**), error-code mapping, `PreflightManifestStore` injection, `architectureFindings` serialization fidelity | **Done** | **[D/R]** `faz-e-verify-change.test.ts` **10/10 passed** + `preflight-store.test.ts` **3/3 passed**. **[K]** gates green. |

**Sprint 6 Overall: E1–E6 + MCP surface 7/7 Done (E5 and E6 with documented boundaries).**

### Sprint Gate (Spec) — Verification Test Runs

Gate contract: **identical working-tree + identical `baseSnapshot` → byte-deterministic verify report; if tests were not run, the report NEVER claims tests passed.** Verified directly across 7 files (89 tests, all green) [D]:

1. **`packages/verification/test/verify-change.test.ts` → 34/34 passed**: byte-identical `serializeVerificationReport` across runs and shuffled input arrays (`:438`, `:899`), zero false pass strings across all `not_run` candidate reasons/limitations/unknowns (`:1124`), physical absence of `'passed' in tests` on failing observed runs.
2. **`packages/mcp-server/test/faz-e-verify-change.test.ts` → 10/10 passed**: end-to-end `preflight → edit → verify ×2` bit-identical MCP `structuredContent` with `tests.state = "not_run"`.
3. **`tests/visualizer-viewer.test.ts` → 11/11 passed** (+ `evidence-chain.test.ts` **15/15** = 26/26).
4. **`packages/graph/test/timeline-trend.test.ts` + `packages/mcp-server/test/faz-e-timeline-trend.test.ts` → 16/16 passed**.
5. **`packages/mcp-server/test/preflight-store.test.ts` → 3/3 passed**.

### Security Analysis (Phase E Branch)

Orchestrator security review **[K]** found **2 issues**, both fixed in `f5fd425` with regression tests: (1) `OBSERVED_RUN_ARRAY_CEILING = 200` (`packages/verification/src/test-status-schema.ts`) capping `observedTestRun.testNames`/`evidenceIds` fail-closed against unbounded `limitations` growth; (2) `PREFLIGHT_MANIFEST_STORE_LIMIT = 200` FIFO eviction (`packages/mcp-server/src/preflight-store.ts`) preventing unbounded in-memory growth in long-lived stdio processes.

### Sprint 6 Open Items (Notes for Orchestrator / User)

1. **~~Commit plan~~ → CLOSED (2026-11-08, `f5fd425`):** clean working tree, **61 files / 1,116 tests passed**.
2. **~~Timeline tool description missing trend mention~~ → CLOSED (2026-11-08):** updated in `server.ts`.
3. **Standalone Zod schema for `candidateStatuses` not split out** [R]: enforced via TypeScript discriminated union + `TEST_RUN_STATUS_SCHEMA.superRefine`.
4. **E3 `passedCount`/`failedCount` relies on host declaration** [R]: pure verification core reads no files (`K-016(3)`).
5. **E6 remainders** [R]: real browser run + optional MCP viewer export surface remain open 1.0.0 gates.
6. **`packages/verification/dist` layout** [D]: compiled transitively via `tsc -b`.
7. **~~Wiki records~~ → CLOSED:** `wiki/sprint-6.md` and `K-016` recorded by orchestrator.
8. **Sibling error-code subset constants (`DIFFERENTIATION_TOOL_ERROR_CODES_USED` / `WIKI_TOOL_ERROR_CODES_USED`)**: informational constants in adjacent service modules.

## Sprint 5 — Phase D: Differentiation (2026-11-08)

> Evidence: Sprint-5 task reports `d1`–`d7` + `mcp` + disk spot-checks · Spec v2.1 §11 (contract discovery/evaluation/drift), §10.2/§10.3 (`preflight_change`), §14 (`trace_business_flow`), §15 (`derive_test_plan`), §19 (resource consumption), §23 (Phase D plan) · `K-013(7)` · `K-015` · `wiki/sprint-5.md`.

> **[D] Phase D commit map (`git log`):** `31bcc86` (D1 discovery + D6 test-plan core) → `7c5de99` (D2+D3+D5 compatibility, drift, business-flow) → `bb8630b` (D4 preflight manifest + `K-013(7)` `wiki_diff.contractChanges` + Agent GPS `contract` leg) → `eebb9f9` (5 Phase D MCP tools wired to stdio; **54 files / 1,024 tests passed** after clean `npm ci --ignore-scripts`).

### Sprint 5 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| D1 | `packages/contracts/`: read-only discovery for OpenAPI, AsyncAPI, SQL migrations, JSON Schema, and Protobuf; `PRODUCES`/`CONSUMES_CONTRACT` edges; parse-safety quotas (size/depth/YAML aliases) | **Done** | **[D/R]** 15 modules + 6 test files (109 `[S]` blocks); `MAX_SPEC_BYTES = 1_048_576` (1 MiB) across OpenAPI/AsyncAPI/JSON Schema/SQL/Protobuf (`parse-safety.ts:34,48-72`, `discover.ts:72,95-96`); unresolved `$ref` → `contracts/openapi-ref-unresolved` + `partial` certainty. **[K]** gates green. |
| D2 | Contract compatibility core (`compatibility.ts`: `checkContractCompatibility` + `evaluateContractPair`) — Spec §11 rules (`breaking_candidate`, `risk`, `backward-safe`, `unknown`) | **Done** | **[D/R]** `contract-compatibility.test.ts` **16/16** on `examples/fixture-contract-drift` (OpenAPI v1↔v2 backward-safe optional/relaxed request fields, SQL `DROP COLUMN` → `breaking_candidate`, Protobuf unknown serializer → `unknown`). Documented boundaries (`K-015`): OpenAPI candidate carries request-schema properties only; event-version rule deferred; SQL `RENAME` → `unknown`. |
| D3 | Contract drift core (`contract-drift.ts`): canonical schema diff → compatibility rules → `PRODUCES`/`CONSUMES_CONTRACT` impact graph; `assertEdges` evidence check; `unknowns` | **Done** | **[D/R]** `contract-drift.test.ts` **22/22** (6 red-first validator tests for span/edge invariants + SQL rename-only → `column-renamed` `unknown`). |
| D4 | Preflight Manifest (`packages/preflight/`): `intent` + targets → candidate manifest (`impactCandidates`, `contractChecks`, `testPlanId`, `limitations`, `sourceRevision`); `candidateOnly: true` fixed; unresolved target → `requiresDisambiguation` | **Done** | **[D/R]** `packages/preflight/test/` **33/33** (16 test-plan + 17 manifest); total-order comparator tie-breaker + `MAX_GIT_METADATA_BYTES = 1 MiB` (`source-revision.ts`); client-supplied `contractChecks` rejected to prevent classification injection. |
| D5 | Business flow tracing (`business-flow.ts`): UI→API→handler→service→repo→DB + producer→broker→consumer; `FlowSegment[]` boundary certainty; two-layer `maxNodes`/`maxHops` queue budget (cap 2,000) | **Done** | **[D/R]** `business-flow.test.ts` **27/27** (partial blocks never leave `truncated: false`). |
| D6 | `derive_test_plan` core (`test-plan.ts`): `direct` (`TESTS` edge) > `call-site` (reverse `CALLS` BFS) > `naming` (`X.test`/`X.spec`/`XTests` fixed suffixes — zero regex/ReDoS); `missingCoverageCandidates`; zero test-execution claims; Spec §20 budgets (`maxDepth` 6 / `maxCandidates` 50) | **Done** (with documented boundary) | **[D/R]** `test-plan.test.ts` **16/16** (output scanned against `/passed\|was run\|executed/i` → 0 matches). *(TypeScript `Test`/`TESTS` extraction later enabled in `K-020`; non-TS sidecar `TESTS` edges remain open.)* |
| D7 | Sprint-5 integration closure: `wiki/invalid-contract-surface` → `INVALID_ARGUMENT` mapping + `package-lock.json` workspace-link sync | **Done** (`npm ci --ignore-scripts` verified 2026-11-08) | **[D/R]** `wiki-tools.test.ts:1506` prevents `INTERNAL_ERROR` bucket leak; clean `npm ci --ignore-scripts` resolved `@causoryn/contracts`, `@causoryn/preflight`, and `@causoryn/wiki` (**54 files / 1,024 tests passed**). |
| MCP | Phase D MCP surface: 5 tools (`check_contracts`, `detect_contract_drift`, `preflight_change`, `trace_business_flow`, `derive_test_plan`); `TOOL_NAMES` 23 → 28; first use of `CONTRACT_PARSE_FAILED` | **Done** | **[D/R]** `faz-d-tools.test.ts` **33/33**; working-tree SHA-256 unchanged across `preflight_change`; live 28-tool `stdio` child-process test green. |

**Sprint 5 Overall: D1–D7 + MCP surface all Done (54 files / 1,024 tests passed).**

### K-013(7) `contractChanges` Finalization & Agent GPS Contract-Leg Enrichment — Verification Tests

Delivered in `bb8630b` and locked by tests [D/K]:

1. **`K-013(7)` — `wiki_diff.contractChanges` finalized as `{contractId, changeKind: added|removed|modified, summary}`:**
   - Code: `packages/wiki/src/contract-changes.ts:18,89` (`ContractChangeRecord`, canonical code-point sort) + `services-wiki.ts:1836,2111`.
   - Tests: `wiki-tools.test.ts:1707,1806,1829` (exact 3-key shape `["changeKind","contractId","summary"]`, graceful fallback when backing graph snapshot is unavailable, `pageScope` filtering) and `faz-d-tools.test.ts:609,1293` (empty contract diff returns `[]` without stale placeholder warning).
2. **Agent GPS `contract` leg self-population (`causoryn_get_agent_context`):**
   - Code: `packages/graph/src/agent-context.ts:131,138,447-467`.
   - Tests: `faz-d-tools.test.ts:1229,1247` — reports `"contract"` in `degradedLegs` when no contract nodes exist, and self-populates (`legsApplied` includes `"contract"`, absent from `degradedLegs`) when `ApiContract` nodes are present.

### Security Analysis (Phase D Branch)

Orchestrator security review **[K]** surfaced **2 findings**, both resolved with green gates. Verified controls **[D]**: 1 MiB size + nesting depth + YAML alias quotas (`parse-safety.ts:34-81` → `contracts/limit-exceeded` / `contracts/depth-exceeded`), `candidateOnly: true` type lock + working-tree SHA-256 invariance on `preflight_change`, `PATH_DENIED` on out-of-policy spec/anchor reads (`faz-d-tools.test.ts:551,757`), and zero LLM/embedding dependencies across `packages/contracts` and `packages/preflight`.

### Sprint 5 Open Items (Notes for Orchestrator / User)

1. **~~`package-lock.json` sync~~ → CLOSED (2026-11-08):** clean `npm ci --ignore-scripts` passed (54 files / 1,024 tests).
2. **~~Commit plan & wiki records~~ → CLOSED (`PR #11`):** D1/MCP audit fixes, `wiki/sprint-5.md`, and `K-015` committed.
3. **D6 `TESTS` edge producer gap** [R]: TypeScript `Test`/`TESTS` extraction closed in `K-020`; C#/Python/Go/Rust sidecars remain open for 1.0.0.
4. **OpenAPI response-schema drift (`K-015(5)`) & Spec §11 event-version rule (`K-015(4)`)** [R]: remain open 1.0.0 gates.
5. **~~Dedicated `secret-scan` script~~ → CLOSED (2026-11-17/18 & `K-022`):** `scripts/secret-scan.mjs` (`npm run secret-scan`, 13 roots + 13 root text files).

## Sprint 4 — Phase C2: Living Wiki (2026-11-07)

> Evidence: Sprint-4 task reports `w1`–`w8` + Spec §16A.10 overlay tests run directly (`24/24 passed`) · Spec v2.1 §16A (pp.14–18), §10.1/§10.2, §8/§9 · `K-013`/`K-014` · [wiki-spec.md](wiki-spec.md) §3.0–3.7 · `wiki/sprint-4.md`.

> **[D] Phase C2 commit map (`git log`):** `c942118` (`K-013` recorded in `wiki-spec` §8) → `711b22f` (W1+W2 `WikiProjectionEngine` + SQLite schema) → `6e2fee1` (W3+W4 bidirectional links + FTS5 search) → `1cb6294` (W5 7 wiki MCP tools) → `64e8e39` (W6+W8 incremental invalidation + offline export) → `090a9e8` (W7 annotation overlay) → `dc5a89a` (**43 files / 800 tests passed**).

### Sprint 4 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| W1 | `WikiProjectionEngine` deterministic `GraphSnapshot → WikiSnapshot` projection + root `tsconfig.json` project reference | **Done** | **[D/R]** `tsconfig.json` `packages/wiki` reference; full canonical JSON determinism (`wikiProjectionCanonicalJson` including reversed node order) in `wiki-projection.test.ts` (**18/18**). |
| W2 | Wiki SQLite layer: `wiki-schema.ts` DDL + `WikiStore` (`begin`/`addPage`/`publish`, FTS + alias indexes, `requireBuildingWikiRow` guards) | **Done** | **[D/R]** Post-publish `indexWikiFts` rejected with `wiki/build-not-active`; UNIQUE conflict → `wiki/build-already-active`; parameterized static SQL in `searchWiki`; `wiki-store.test.ts` (**14/14**), `storage-sqlite` (**37/37**). |
| W3 | `WikiLink` resolution: 11 link kinds, `brokenLinkDiagnostics` (`K-013 #4`: `toPageId=null` preserved + diagnostic record), O(1) backlink reverse index (`ADR-013`) | **Done** | **[D/R]** Pure `packages/wiki/src/links.ts` (imports only `zod`+`errors`+`schema`); `wiki-links.test.ts` (**18/18**). |
| W4 | Wiki FTS5 search: query phrase escaping, `K-013` multi-leg ranking (`exact route > title > module > BM25/FTS5 > graph proximity`), opaque cursor (`50` default / `200` max) | **Done** | **[D/R]** `wiki-search.test.ts` (**19/19**; unpublished `building` snapshots invisible to search; `'"()*` metacharacters safely escaped). Surface query filters (`pageKind`/`language`/…) remain an open 1.0.0 gate. |
| W5 | MCP wiki tool surface (7 tools): `direction` filter, first use of fixed Spec code `WIKI_PAGE_NOT_FOUND`, `envelope.nextCursor === data.nextCursor`, `dataDbPath` symlink checks, `refs` 200 ceiling, real two-commit git `wiki_diff` | **Done** | **[D/R]** `wiki-tools.test.ts` (**32 `[S]` blocks**); working-tree SHA-256 fingerprint proven unchanged before/after git-commit `wiki_diff`. |
| W6 | Incremental invalidation engine + `causoryn_wiki_build(mode="incremental")` MCP wiring with graceful full fallback | **Done** (with link-index rewrite note) | **[D/R]** `wiki-incremental.test.ts` (**17/17**) + `wiki-build-incremental.test.ts` (**4/4**: `1 <= pagesRegenerated < totalNodes`, previous snapshot marked `stale=true`, missing prior snapshot falls back cleanly to `full`). |
| W7 | Annotation overlay: `AnnotationOverlayEngine` + `WikiAnnotation` Zod schema (`human \| host_model_proposal`), CAS update (`wiki/annotation-conflict` / Spec `WIKI_NOTE_CONFLICT`), `orphan=true` preservation + automatic recovery on matching deterministic `pageId` | **Done** | **[D/R]** `wiki-overlay.test.ts` (**17/17**) + `wiki-annotation-overlay.test.ts` (**7/7**); host proposals labeled unverified outside generated content (`ADR-012`). |
| W8 | Offline export: self-contained Markdown + HTML (strict CSP meta, full HTML escaping, zero scripts/CDNs, Windows reserved device-name collision suffixing `con`/`nul`/`lpt1`, `file://` inertness) | **Done** | **[D/R]** `wiki-export.test.ts` (**16/16**). |

**Sprint 4 Overall: W1–W8 8/8 Done (43 files / 800 tests passed).**

### Spec §16A.10 Exit Criterion — "Two Consecutive Reindexes Leave Manual Notes UNCHANGED"

Verified directly via `npx vitest run packages/wiki/test/wiki-overlay.test.ts packages/storage-sqlite/test/wiki-annotation-overlay.test.ts` → **24/24 passed** (2.63 s) [D/R]:

1. **`packages/wiki/test/wiki-overlay.test.ts:864`**:
   - **Full reindex (`:865`):** add annotation → full `projectWiki` rebuild + atomic publish → `body`, `version`, and `updatedAt` remain bit-for-bit identical; `renderWikiPageWithOverlay` renders overlay strictly outside generated sections.
   - **Incremental reindex (`:948`):** incremental rebuild preserves annotation rows bit-for-bit on regenerated pages.
   - **Orphan & recovery (`:744`, `:783`):** removed target page marks `orphan=true` without deleting the row; restoring the same deterministic `pageId` automatically reconnects (`orphan=false`) with zero mutation.
   - **CAS conflict (`:466`):** stale `annotationVersion` throws `wiki/annotation-conflict` without modifying the stored row.
2. **`packages/storage-sqlite/test/wiki-annotation-overlay.test.ts:307`**: two full `begin`/`add`/`publish` SQLite reindex cycles leave raw annotation table dumps bit-for-bit identical.

### Security Analysis (Phase C2 Branch)

Orchestrator security review **[K]** found **3 issues**, all fixed with negative regression tests (`wiki-tools.test.ts` +82 lines, `wiki-annotation-overlay.test.ts` +90 lines): (1) multi-root `allowRoots[1..]` `realpath` containment check on `wiki.dataDbPath` in `context.ts` (fail-closed if `realpath` fails); (2) mapping `wiki/output-not-authorized` → `EXPORT_NOT_ALLOWED` and `wiki/output-path-denied` → `PATH_DENIED` in `services-wiki.ts`; (3) deterministic `wiki/duplicate-annotation` error on `SELECT`-then-`INSERT` races in `wiki-store.ts`.

### Sprint 4 Open Items (Notes for Orchestrator / User)

1. **~~Commit plan & `@causoryn/wiki` lockfile sync~~ → CLOSED (2026-11-07, `dc5a89a`):** `npm install --ignore-scripts` synced lockfile and **43 files / 800 tests passed**.
2. **~~Wiki records (`K-014`, `sprint-4.md`)~~ → CLOSED:** recorded by orchestrator.
3. **`WIKI_NOTE_CONFLICT` `TOOL_ERROR_GUIDANCE` entry** [D]: deferred until an annotation-writing MCP tool is exposed (`wiki-spec` §4.1); tracked in 1.0.0 gates.
4. **`overlay` barrel re-export in `packages/wiki/src/index.ts`** [D]: consumers import `overlay.js` directly; minor cleanup candidate.
5. **`wiki_search` query filters (`pageKind`/`language`/…) & incremental link/FTS narrowing** [D/R]: tracked in 1.0.0 gates.

## Sprint 3 — Phase C: Original Features (2026-11-05)

> Evidence: Sprint-3 task reports `c1`–`c7`, `b9`, `mcp` + 8 Phase C test suites (`191/191 passed`) run directly · Spec v2.1 §12 (Architecture Guard + policy DSL), §13 (Impact/Diff/Timeline), §15 (Agent GPS), §16 (Export/Onboarding), §10.2–§10.3, §20, §23 · `K-012` · `wiki/sprint-3.md`.

> **Spec section-number note [D]:** Spec v2.1 §12 covers Architecture Guard & YAML policy DSL, while Impact analysis lives in §13 ("Change Intelligence & Architecture Diff/Timeline", p.12: bounded reverse-edge BFS with orthogonal `direct | indirect | possible` certainty and `verified | heuristic | unresolved` resolution, never claiming `"100%"` impact). Source headers cite §13 accurately (`impact.ts:14-24`).

### Sprint 3 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| C1 | `causoryn_analyze_impact` core: reverse-edge bounded BFS, orthogonal `certainty × resolution` classification, evidence-referenced `impactPaths`, zero `"100%"` claims (Spec §13, §20 ceilings) | **Done** | **[D/R]** `packages/graph/src/impact.ts`; `impact.test.ts` **14/14 passed** (permutation determinism + absence of `'100%'` asserted). |
| C2 | Architecture Guard core (`guard.ts`): YAML policy DSL, iterative Tarjan SCC `no-cycles`, `forbidden-dependency`, baseline + orphan suppressions, **linear-time** NFA glob matcher (Spec §12) | **Done** | **[D/R]** Zero `RegExp` backtracking in `guard.ts`; pathological `**/`×20 glob dropped from `6,744 ms` / `>120 s` hang to **~6 ms**; `guard.test.ts` **52/52 passed**. |
| C3 | Architecture Diff (`compare.ts`) + read-only git layer (`git-read.ts`) (Spec §13) | **Done** | **[D/R]** `GIT_ALLOWED_SUBCOMMANDS` restricted to `cat-file`/`ls-tree` (argv array, zero shell, symlinks rejected); `compare.test.ts` **14/14 passed**. |
| C4 | Agent GPS (`agent-context.ts`): deterministic `contract → freshness → fts` multi-leg context ranking within mandatory `tokenBudget` (Spec §15) | **Done** | **[D/R]** `agent-context.test.ts` **18/18 passed**; zero fabricated evidence (`resolveEvidenceIds` returns `[]` honestly when edges are heuristic-only). |
| C5 | Onboarding report core (`onboarding.ts`): `audience → profile` (`beginner`/`intermediate`/`maintainer`), limit ceilings, permutation-invariant determinism (Spec §16) | **Done** | **[D/R]** `onboarding.test.ts` **18/18 passed** (`focus` explicitly rejected on MCP surface per `K-012`). |
| C6 | Documentation export (`export.ts`): pure `json`/`markdown`/`mermaid`/`html` serializers + atomic `.tmp`→rename writes via `OutputAccessPolicy` (Spec §16) | **Done** | **[D/R]** `export.test.ts` **26/26 passed** (CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`, `<script>` XSS escaping, `..` traversal rejection). |
| C7 | Architecture Timeline (`timeline.ts`): sampled git-point diff timeline, bounded tag-peel (6-layer git tag chain test), `maxRangeWalk` (`100` default / `500` cap) (Spec §13) | **Done** | **[D/R]** `timeline.test.ts` **23/23 passed**. |
| C8 | Phase C MCP surface: 7 Phase C tools wired to stdio (`TOOL_NAMES` 9 → 16), fixed Spec §10.1 `EXPORT_NOT_ALLOWED` adopted (`K-012`), two-stage `maxFileBytes` policy/baseline budget | **Done** | **[D/R]** `faz-c-tools.test.ts` **26/26 passed** (**627/627** full suite at C8). |
| B9 | Sprint-2 debt closure: C# live pipeline integration (`INDEXED_ADAPTERS` + `.cs` → `analyzeCSharpWorkspace` + async `IndexJobManager`) and `fp2` Roslyn ref-pack `analyzerFingerprint` | **Done** | **[D/R]** `index-service-csharp.test.ts` **20/20 passed** with live `.NET 10.0.400` worker runs; `fp1` remnants forbidden by test. |

**Sprint 3 Overall: C1–C8 + B9 all Done (634 tests passed at PR #9).**

### Security Analysis (Sprint 3 Branch)

Orchestrator security review **[K]** found **3 issues**, all fixed and re-verified green: read-only allowlisted `git-read.ts` (`cat-file`/`ls-tree`, zero shell interpolation), symlink/junction escape rejection in `git-read.ts` and `output-policy.ts`, linear-time NFA glob matching eliminating ReDoS in `guard.ts`, strict CSP + HTML/GFM escaping on exports, and read-only workspace invariance.

### Status of Sprint 2 Open Items Across Phase C Slices

1. **~~`K-011` ADR entry (`SYMBOL_NOT_FOUND`)~~ → CLOSED (2026-11-05)**.
2. **~~B2 debt: `analyzerFingerprint` Roslyn ref-pack~~ → CLOSED (B9, 2026-11-05)** via `fp2` schema (`packages/indexing/src/fingerprint.ts:63,135,233`).
3. **~~C# live pipeline integration~~ → CLOSED (B9, 2026-11-05)** (`csFileCount` surface projection on `index_status` noted as minor cosmetic item).
4. **~~Workspace package links in `package-lock.json`~~ → CLOSED (`2c61feb`, `63ffdd2`)**.
5. **~~Framework-linkers determinism timeout~~ → CLOSED (2026-11-05)** via explicit `30_000` ms timeout.
6. **Retained B7 open items:** (a) per-file parse reuse (still open); (b) wrapping FS watcher as an MCP tool (still open); (c) `refresh_index(mode="incremental")` *(subsequently CLOSED in `K-020` on 2026-11-18)*.

### Sprint 3 Open Items (Notes for Orchestrator / User)

1. **~~Commit plan, `wiki/sprint-3.md`, `K-012`, stale header comments & `errors.ts` namespace list~~ → CLOSED (`PR #9`)**.
2. **`index_status` `csFileCount` surface field** [D]: tracked internally in `IndexJobRecord`, optional surface addition for 1.0+.
3. **~~Compare/timeline snapshot blob producer gap~~ → PRODUCER ADDED IN `K-020` (2026-11-18):** `causoryn_export_documentation(format="snapshot")` writes canonical `architecture-snapshot.json` to authorized output dirs (git-revision workflow automation remains an open 1.0.0 gate).
4. **Low-priority deduplication notes** [R]: dual iterative Tarjan SCC helpers (`guard.ts` + `onboarding.ts`) deferred to avoid out-of-scope refactoring.

## Sprint 2 — Phase B: Deep Mapping (2026-11-05)

> Evidence: Sprint-2 task reports `b1`–`b8` + direct disk spot-checks and `cross-boundary` / `framework-linkers` runs (`48/48 passed`) · Spec v2.1 §7 (adapters), §9 (storage), §23 (Phase B plan) · `wiki/sprint-2.md`.

### Sprint 2 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| B1 | C# Roslyn sidecar worker (`native/roslyn-worker/`) + non-silent build-regression test discipline | **Done** | **[D/R]** `Causoryn.RoslynWorker.csproj`, `Program.cs`, `Protocol.cs`, `ReferenceResolver.cs`, `WorkerAnalyzer.cs`, `PROTOCOL.md`; `tests/roslyn-worker.test.ts` (`dotnet` absent → explicit skip reason; `dotnet build` failure → hard throw, proven red-first when `PackageReference` was intentionally broken; 31 worker + 4 bootstrap unit tests green). |
| B2 | `adapters/csharp-roslyn/`: TS sidecar adapter (spawn, NDJSON request/response, timeout, stdin `EPIPE` guard, graceful L0/L1 fallback) | **Done** (ref-pack debt closed in B9) | **[D/R]** `csharp-roslyn-adapter.test.ts` **12/12 passed** (`workerAvailable: false` fallback, `status: "error"` warning propagation, `..`/duplicate input rejection). |
| B3 | TypeScript framework linkers: Express routes → `Endpoint`, Next.js App Router (`app/**/route.ts`, `page.tsx`) → `Endpoint`; `extractFrameworkEdges` | **Done** | **[D/R]** Single-pass `analyzeTypeScriptProgramWithFrameworks`; receiver scoping prevents false `'express'` attribution on non-Express `client.get`; `framework-linkers.test.ts` **30/30 passed**. |
| B4 | `causoryn_trace_execution`: deterministic DFS call-chain tracing from entrypoint (`maxDepth`, `maxPaths`; `verified`/`heuristic`/`unresolved` kept distinct) | **Done** | **[D/R]** `trace-execution.test.ts` **9/9 passed** (`unresolved` edge halts path with `stoppedReason='unresolved-edge'` and `status='partial'`). |
| B5 | `causoryn_get_symbol_context`: symbol relations + evidence + catalog consistency guards (`K-011` `SYMBOL_NOT_FOUND`) | **Done** (`K-011` recorded 2026-11-05) | **[D/R]** `plugin-package.test.ts` **16/16 passed** locking docstring count === `TOOL_NAMES.length` and the exact 3-code extension set. |
| B6 | `causoryn_refresh_index` + `causoryn_index_status`: background snapshot job management (`IndexJobManager`, FIFO cap 100) | **Done** | **[D/R]** `jobId` excluded from `snapshotId` (bit-identical snapshot JSON across producers); unauthorized root opens zero job records. |
| B7 | Live Architecture: FS watcher (`300–1000 ms` debounce), incremental reindex, config invalidation (`package.json`/`tsconfig`/`.sln`/`.csproj`), atomic snapshot publish, `stale=true` | **Partial** | **[D/R]** `packages/indexing/src/watcher.ts` + `watcher.test.ts` (13 blocks: `safeLog`/`safeOnError` exception isolation, `hashWorkspaceFile` Spec §19 post-open TOCTOU recheck, straggler coalescing, EMFILE `degraded` reconciliation). **Why Partial (`ADR-010`):** "incremental" operates at the job/content-hash accounting level (**no per-file parse reuse** — cross-file `IMPORTS`/`CALLS` consistency triggers full adapter derivation on changed sets, `watcher.ts:26-35`), and the FS watcher is an in-process API **not wrapped as an MCP tool** (`watcher.ts:42-44`; `refresh_index mode=incremental` was later opened in `K-020`). |
| B8 | Cross-boundary integration test: TS fixture + C# fixture `endpoint → service → repository` evidence chain | **Done** | **[D/R]** `tests/cross-boundary.test.ts` **18/18 passed** (single atomic snapshot across TS + C#, zero dangling edges, `span.sourceHash === sha256(disk file)`, worker-less L0/L1 survival, `stale=true` on superseded revision). |

**Sprint 2 Overall: 7/8 Done, 1 Partial (`B7`); 0 Not Started (419 tests passed at PR #8).**

### Phase B Exit Criteria (`wiki/sprint-2.md`) — Verification Tests

1. **"If the Roslyn worker fails or is absent, the engine does not crash; coverage is reported explicitly"** — verified in `tests/cross-boundary.test.ts:759-819` (`workerAvailable=false`, `state=partial`, `coverageRatio=0`, explicit warning, snapshot still queryable by ID; **18/18 passed** [D]).
2. **"Snapshot publish is atomic; superseded snapshots remain queryable with `stale=true`"** — verified in `tests/cross-boundary.test.ts:705-748,846-884` (`rev1` flips to `stale=true` once `rev2` publishes while `getLatestPublished` returns `rev2` with `stale=false`; **18/18 passed** [D]).

### Security Analysis (Sprint 2 Branch)

Orchestrator security review **[K]** found **5 issues**, all fixed red-first and re-verified green: fixed-argv sidecar spawning (`worker-process.ts` — zero shell interpolation), `stdin` EPIPE handling, post-open TOCTOU recheck in `hashWorkspaceFile`, zero LLM dependencies, and strict read-only workspace enforcement.

### Sprint 2 Open Items (Notes for Orchestrator / User)

1. **~~Commit plan, `K-011` ADR, `fp2` ref-pack, C# live pipeline routing, lockfile sync, and timeout stability~~ → ALL CLOSED across PR #8 and Sprint 3 B9**.
2. **Carried forward from `B7` to 1.0.0 gates:** per-file parse reuse (`watcher.ts:26-35`) and wrapping the FS watcher as an MCP tool (`watcher.ts:42-44`).

### Independent Audit Pass (Two Auditors, 2026-11-05) — Finding Mapping

12 findings across two independent auditors (9 deduplicated): **7 resolved immediately** with red-first tests (`skipIf` response-budget discipline, `get_capabilities` `maxDepth`/`maxPaths` exposure, `package.json` tool-count description sync, `refresh_index` message clarity, accurate `status: "error"` fallback wording, legitimate `skipIf` when `dotnet` is absent); **2 tracked cleanly** (`K-011` recorded in `wiki/decisions.md` and C# pipeline routing delivered in B9; brace-style uniformity deferred to avoid out-of-scope mechanical restyling).

## Sprint 1 — Phase A: Foundation

> Evidence: Sprint-1 task reports (`t1`–`t8`, orchestrator-verified) + direct disk spot-checks (2026-11-03) + gate results · Spec v2.1 §25, `ADR-010` · `wiki/sprint-1.md`.

## Sprint 1 Task Table

| # | Task | Status | Evidence |
|---|---|---|---|
| 1 | Repository/workspace tooling; [architecture.md](architecture.md), [adr/ADR-002-no-llm.md](adr/ADR-002-no-llm.md) | **Done** | **[D/R/K]** Root `package.json` (`workspaces`, `engines.node >= 24`, strict `nodenext` TypeScript `5.9.3`), `tests/smoke.test.ts` (13 blocks), SQLite FTS5 verified (`FTS5_OK`). |
| 2 | `WorkspaceAccessPolicy`: explicit root authorization, ignore rules, symlink escape, binary/size filter | **Done** | **[D/R]** Fixed 6-step decision order including **step 5b canonical-path ignore recheck** and Spec §19 post-open TOCTOU contract (`workspace-access-policy.test.ts`, 53 blocks). |
| 3 | `GraphNode`/`GraphEdge`/`Evidence`/`GraphSnapshot` — Zod schemas + deterministic SHA-256 IDs | **Done** | **[D/R]** `NODE_KINDS = 27`, `EDGE_KINDS = 20` (Spec §8); 3-layer verified-edge ≥ 1 evidence invariant, `deepFreeze`, canonical JSON (`packages/domain/test/`, 75 blocks). |
| 4 | TypeScript Compiler API adapter + `POST /orders → OrdersService → repository` fixture proof | **Done** | **[D/R]** `examples/fixture-ts-orders` (5 files); `CONTAINS`/`IMPORTS`/`CALLS`/`ROUTES_TO` spans match disk `sourceHash`; `broken.ts` isolated as `state=partial`; `typescript-adapter.test.ts` (22/22). |
| 5 | `InMemoryGraphRepository` + SQLite adapter; atomic snapshot publish tests | **Done** | **[D/R]** `WAL` + `foreign_keys=1` + FTS5 parameterized `MATCH`; `building` invisible to readers; rollback on failure; memory ↔ SQLite `snapshotCanonicalJson` bit-identical (`repository.test.ts` 16 + `storage-sqlite` 19 blocks). |
| 6 | MCP `stdio` server: `get_capabilities`, `workspace_summary`, `map_system`, `find_symbols` | **Done** | **[D/R/K]** 10-field strict envelope, deterministic `(retryable, userAction)` table, empty-workspace `partial` handling (`mcp-server.test.ts` 21 + `stdio-stdout.test.ts` 1). |
| 7 | End-to-end file/line verification of a `CALLS` edge via `causoryn_get_evidence` | **Done** | **[D/R/K]** `find_symbols → map_system → get_evidence` verified against disk `OrderRepository.save` span + `sha256` (`EVIDENCE_NOT_FOUND` extension `K-008`). |
| 8 | ZCode plugin package: `plugin.json` (`mcpServers` + `skills`), `map-system` skill, `README.md` | **Done** | **[D/R]** Default `allowRoots: []` fail-closed config; `plugin-package.test.ts` (12/12). |
| 9 | Unit/integration/security test suites; initial `docs/implementation-status.md` | **Done** | **[D/K]** 16 test files, 238 `[S]` blocks (247 executed tests in PR #7); `__proto__` own-property hardening and `INTERNAL_ERROR` stderr-only redaction verified. |
| 10 | [wiki-spec.md](wiki-spec.md): 16 page kinds, snapshot/page/link/annotation Zod schemas, 7 Wiki tool contracts | **Done** | **[D]** ~37 KB design specification on disk with explicit `ADR-010` draft banner (subsequently implemented in Sprint 4). |
| 11 | Dependency-ordered phase & GitHub issue backlog ([BACKLOG.md](BACKLOG.md)) | **Done** | **[D]** Phase chain `A → B → C → D → E → F` mapped 1-to-1 to GitHub issues `#1`–`#6`. |

**Sprint 1 Overall: 11/11 tasks Done.**

## Test Coverage (Task 9 Inventory)

Static block count `[S]` at Sprint 1 close (`grep -cE "^\s*(it|test)\("` per file; orchestrator gate green [K]):

| Area | Files | `[S]` Blocks |
|---|---|---|
| `packages/domain` | `canonical-json` 7, `graph-schema` 39, `ids` 17, `sha256` 4, `snapshot-attributes` 3, `utf8` 5 | 75 |
| `packages/workspace` | `workspace-access-policy` 53 | 53 |
| `packages/indexing` | `index-service` 6 | 6 |
| `packages/graph` | `repository` 16 | 16 |
| `packages/storage-sqlite` | `sqlite-repository` 16, `round-trip` 3 | 19 |
| `packages/mcp-server` | `mcp-server` 21, `stdio-stdout` 1 | 22 |
| `adapters/typescript` | `typescript-adapter` 22 | 22 |
| `integrations/zcode/causoryn` | `plugin-package` 12 | 12 |
| `tests` | `smoke` 13 | 13 |
| **Sprint 1 Total** | **16 files** *(grown to **89 default-suite files + 1 bench file / `1600+` tests** in `v0.2.0`)* | **238** |

Test categories: unit (domain/workspace/graph schemas & policies), integration (adapter → `createSnapshot` → repository; memory ↔ SQLite round-trip; MCP client ↔ server `InMemoryTransport`; `stdio` `stdout` purity), security (path traversal, symlink/junction escape, `__proto__` attribute hardening, `INTERNAL_ERROR` redaction, SQL parameterization, `allowRoots` default-deny).

## Security Analysis Results (Task 9)

Orchestrator security review [K] surfaced 2 findings, both resolved and verified on disk [D]:

1. **`__proto__` attribute integrity** — `packages/domain/src/snapshot.ts`: replaced `out[key] = value` with `Object.defineProperty` inside `asJsonValue` so `"__proto__"` own keys are preserved without triggering `Object.prototype` setters (`packages/domain/test/snapshot-attributes.test.ts`, 3 blocks).
2. **`INTERNAL_ERROR` information-leak prevention** — `packages/mcp-server/src/server.ts`: raw driver messages, SQLite constraint names, and internal filesystem paths (`/secret/internal/path`) are logged exclusively to `stderr`, returning only a generic `requestId`-correlated message to the MCP client (`packages/mcp-server/test/mcp-server.test.ts`, +2 blocks).

## Open Items (Non-Blocking Notes for Orchestrator / User)

1. **~~Commit plan & Sprint-1 ADR entries (`K-008`..`K-010`)~~ → CLOSED (`PR #7`)**.
2. **~~`npm audit`~~ → CLOSED (2026-11-20, `K-022`):** upgrading to `eslint@10.15.0` and `typescript-eslint@8.73.0` brought `npm audit` to **0 vulnerabilities** (closing the historical Sprint-1 `minimatch` dev-toolchain moderate advisories without downgrading ESLint).
3. **Historical Sprint-1 scope notes** [R]: `wiki-spec.md` §8 open questions were later resolved in `K-013` (Sprint 4), and multi-process SQLite race recovery was added in `K-021`.

## Related Pages

- [architecture.md](architecture.md) — package map and dependency boundaries
- [tool-contracts.md](tool-contracts.md) — 29-tool contract summary (cross-checked against `TOOL_NAMES`)
- [compatibility-matrix.md](compatibility-matrix.md) — host × result matrix (honest `NOT RUN` rows)
- [CHANGELOG.md](../../CHANGELOG.md) — `0.2.0` Pre-1.0 Public Preview + `0.1.0` public snapshot + `[Unreleased]` 1.0.0 gates
- [security-pass.md](security-pass.md) — F6 packaged-bundle security pass & `v0.2.0` defense-in-depth hardening
- [benchmarks.md](benchmarks.md) — F7 performance measurements
- [BACKLOG.md](BACKLOG.md) — phase dependency ordering and open 1.0.0 gates
- [wiki-spec.md](wiki-spec.md) — Living Wiki design contract (Task 10 output)
- [adr/ADR-002-no-llm.md](adr/ADR-002-no-llm.md) — strict no-LLM architecture boundary
- [project-overview.tr-en.md](../project-overview.tr-en.md) — comprehensive bilingual (TR · EN) project overview
- Historical working records: `wiki/sprint-1.md` · `wiki/sprint-2.md` · `wiki/sprint-3.md` · `wiki/sprint-7.md` · `wiki/sprint-8.md` · `wiki/architecture.md` · `wiki/decisions.md`
