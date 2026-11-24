# Engineering Backlog — Delivery Milestones & Open 1.0.0 Release Gates

> **Language:** [Türkçe](../BACKLOG.md) | **English** · [Documentation Hub](README.md)

This document tracks Causoryn's completed pre-1.0 engineering milestones, the genuinely open `1.0.0` release gates (synchronized with [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]` and [Implementation Status](implementation-status.md)), and post-1.0 enhancement candidates.

---

## 1. Completed Pre-1.0 Milestones

| Milestone | Scope | Status |
|---|---|---|
| **Foundation & Core Graph Engine** | Domain schemas (27 node + 20 edge kinds), `WorkspaceAccessPolicy`, TypeScript Compiler API adapter, SQLite + FTS5 repository, MCP `stdio` envelope, and ZCode manifest package | **Done** |
| **Deep Mapping & C# Roslyn** | C# Roslyn `.NET 10` sidecar, Express/Next.js framework linkers, execution tracing, symbol context, background index jobs, and cross-boundary integration tests | **Done** *(in-process FS watcher MCP surface remains **Partial**)* |
| **Architecture Guard, Diff, Timeline & Export** | Reverse-BFS impact analysis, linear-time Architecture Guard YAML policy DSL + Tarjan SCC, read-only Git diff/timeline, Agent GPS context packing, onboarding guide, and atomic exports | **Done** |
| **Living Wiki Engine** | Deterministic 12-category projection, SQLite `wiki_*` schema, 11-kind bidirectional links + `brokenLinkDiagnostics`, FTS5 search, CAS annotation overlay, 7 MCP tools, and offline export | **Done** |
| **Contracts, Preflight & Change Guard** | OpenAPI/AsyncAPI/SQL/JSON Schema/Protobuf discovery & drift, business-flow tracing, candidate-only `preflight_change`, `derive_test_plan`, `verify_change`, and `apps/visualizer` | **Done** |
| **5-Language Deep Analysis & Multi-Host Distribution** | Python (`ast`), Go (`go/parser`), and Rust (`syn` 3) sidecars; unified `packages/causoryn` CLI (`setup`/`doctor`/`mcp`) and 4-host manifests; 5 canonical skills; visual SVG & interactive HTML portals; JS/CJS + confined `tsconfig`/`jsconfig`; CI/CD supply-chain hardening (`zizmor`, 5-language CodeQL, OpenSSF Scorecard, OIDC release) | **Done** |
| **Post-v0.2.4 Remediation (Waves 1–3)** | Untrusted-repo toolchain isolation (Cargo/Git/Go/Python/Roslyn/Doctor), Win32 UNC lexical pre-check + `$HOME` ancestor rejection, SHA-256 interactive CSP, hermetic 3-job release workflow, Go/Rust edge honesty, `verify_change` trusted `baseRef` rules + `host_asserted` test status, shared `graph.sqlite` + `build_leases` orphan recovery, `setup`/`doctor` DX fixes, 11-tool `core` profile (`<= 15K` chars), LocAgent FTS5 localization, `worker_threads` WAL indexing + `notifications/progress`, per-file `file_facts` early-cutoff incremental indexing + TS `oldProgram` reuse, TS monorepo workspaces + CHA `INHERITS`/`IMPLEMENTS` + C# read-only NuGet discovery + `coverage.byLanguage`, 5-minute tutorial, and jargon-free English docs & CLI | **Done** |

---

## 2. Open `1.0.0` Release Gates

`1.0.0` will not be declared until the following open gates are satisfied:

| # | Open `1.0.0` Gate | Current State | Closure Requirement |
|---|---|---|---|
| G1 | **Antigravity `agy` CLI install + smoke** | **Not Run** (direct `stdio` handshake automated in `antigravity-plugin.test.ts`; no `agy` binary on test machine) | Execute `agy plugin validate --strict`, `install`, `list`, tool discovery, and clean uninstall on a machine with `agy` CLI |
| G2 | **ZCode desktop GUI install + `tools/list` smoke** | **Partial (manifest & isolated CLI)** | Run live desktop ZCode GUI installation + tool discovery smoke with user consent |
| G3 | **Live macOS / Linux / ARM64 host smoke** | **Partial** (3-OS GitHub Actions CI passes on `ubuntu-latest`, `windows-latest`, `macos-15`) | Record live interactive CLI/desktop host smoke runs on macOS and Linux (`x64`/`arm64`) |
| G4 | **MCP TypeScript SDK v1.x -> v2 upgrade** | **Open** (`@modelcontextprotocol/sdk` pinned at `^1.32.2`) | Migrate to stable MCP SDK v2 and re-verify all tool profiles and contracts |
| G5 | **Live Architecture watcher MCP surface** | **Partial** (per-file `file_facts` early-cutoff incremental indexing and TS `oldProgram` reuse are shipped; in-process `WorkspaceWatcher` exists) | Expose filesystem watcher lifecycle safely over MCP |
| G6 | **`TESTS` edges in sidecar languages (`C#`, `Python`, `Go`, `Rust`)** | **Partial** (TypeScript/JavaScript BDD `Test`/`TESTS` extraction is active) | Extract test symbols/attributes -> `Test` nodes + `TESTS` edges in Roslyn, Python, Go, and Rust workers |
| G7 | **Contract discovery & drift fidelity extensions** | **Partial** (OpenAPI request schemas + SQL/AsyncAPI/JSON Schema/Protobuf active) | Add OpenAPI **response-schema** drift, event-version mismatch rule, and SQL `RENAME` refinement (`unknown`) |
| G8 | **Read-only snapshot revision workflow ergonomics** | **Partial** (`causoryn_export_documentation(format="snapshot")` writes to authorized output dirs; timeline falls back to SQLite / git-blob reads) | Streamlined cross-revision comparison workflow without ever writing into analyzed workspaces |
| G9 | **Living Wiki surface refinements** | **Partial** (FTS5 search, CAS overlay, and incremental page selection active) | Expose `wiki_search` query filters (`kinds`/`scope`/`language`/…), register `WIKI_NOTE_CONFLICT` in MCP error guidance alongside local note flows, and narrow incremental SQLite link/FTS writes |
| G10 | **Offline interactive portal & visualizer browser acceptance** | **Partial** (DOM/security tests and deterministic SHA-256 CSP verified) | Real-browser acceptance verification of offline interactions |
| G11 | **Bare monorepo bundle default lib (`.d.ts`) scope decision** | **Partial** (`packages/causoryn` already bundles `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`) | Stage default lib `.d.ts` in bare `packages/mcp-server/dist/` or finalize permanent scope boundary |
| G12 | **Rate-limit / concurrency resource budget** | **Open** (size/depth/timeout ceilings enforced; request concurrency limiter deferred) | Add concurrent-call and resource-budget enforcement wrapper across MCP requests |

---

## 3. Post-1.0 Enhancement Candidates

- **Optional deep semantic modes for Go & Rust:** Optional `go/types` type-checked resolution in `native/go-worker` and trait-dispatch semantic resolution in `native/rust-worker`, preserving honest fallback labels when unavailable.
- **Per-language file counters on status payloads:** Surface per-language file counts consistently across all job diagnostics.
- **Optional Antigravity plugin extensions:** Optional `agents/`, `rules/`, and `hooks.json` assets under `integrations/antigravity/causoryn/`.

---

## Related Pages

- [Implementation Status](implementation-status.md) · [CHANGELOG.md](../../CHANGELOG.md)
- [Architecture Overview](architecture.md) · [Host Compatibility Matrix](compatibility-matrix.md)
