# Engineering Backlog — Phase Ordering and Open `1.0.0` Gates

> **Language:** [Türkçe](../BACKLOG.md) | **English** · [Documentation Hub](README.md)

> **Status:** reflects Causoryn 0.3.0 (default `core` tool profile with 11 tools). `1.0.0` is not declared.

This page records the dependency order of the original delivery phases, what was delivered after that plan, the open `1.0.0` release gates with their closure requirements, and post-1.0 candidates. Evidence for every status is in [Implementation Status](implementation-status.md); the release notes are in [CHANGELOG.md](../../CHANGELOG.md). Nothing that does not work is marked `Done`.

## 1. Delivery Phases and Current Status

| Order | Phase | Issue | Depends on | Primary components | Acceptance gate | Status at 0.3.0 |
|---|---|---|---|---|---|---|
| 0 | **Foundation** | *(delivered directly)* | — | `packages/domain`, `packages/workspace`, `packages/indexing`, `packages/graph`, `packages/storage-sqlite`, `packages/mcp-server`, `adapters/typescript` | Live tool calls, fixture golden files, security tests | **Done** (11/11, PR #7) |
| 1 | **Deep mapping** | [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Foundation (hard) | `native/roslyn-worker/`, `adapters/csharp-roslyn/`, `packages/indexing`, `packages/graph`, `packages/mcp-server` | C# + TypeScript cross-boundary evidence chain | **7/8 Done · Live Architecture watcher Partial** (per-file reuse shipped in 0.3.0 through `file_facts`; the watcher is still not an MCP surface) |
| 2 | **Architecture intelligence** | [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Foundation + Deep mapping (hard); Living Wiki and contracts (soft, degrade cleanly) | `packages/graph`, `packages/mcp-server`, `packages/workspace` (`OutputAccessPolicy`) | Architecture and change-intelligence features on real fixtures | **Done** (PR #9) |
| 3 | **Living Wiki** | [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Foundation (hard); Deep mapping (recommended order, not hard) | `packages/wiki`, `packages/storage-sqlite`, `packages/mcp-server` | 7 wiki tools live-tested; manual notes survive two re-indexes | **Done** (8/8, PR #10) |
| 4 | **Contracts, preflight and business flow** | [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Foundation + Deep mapping + Architecture intelligence (hard); Living Wiki (soft) | `packages/contracts`, `packages/preflight`, `packages/indexing`, `packages/mcp-server` | Contract/drift fixtures and candidate-only preflight | **Done** (PR #11) |
| 5 | **Agent change guard** | [#5](https://github.com/MrBekoX/Causoryn/issues/5) | All above, with a **hard** dependency on the preflight manifest (`preflightId`); Living Wiki (soft) | `packages/verification`, `apps/visualizer`, `packages/mcp-server` | Byte-deterministic `verify_change`; never claims tests ran | **Done** (PR #12) |
| 6 | **Cross-host release** | [#6](https://github.com/MrBekoX/Causoryn/issues/6) | All previous phases (gate: all modules and the Living Wiki Done) | `packages/mcp-server` (esbuild bundle), `integrations/*`, `docs/` | Release security and benchmark matrix, changelog, version decision | **Done** (PR #13 → `v0.1.0` snapshot `4c9c188`; Antigravity `agy` CLI `NOT RUN`) |

## 2. Dependency Graph and Ordering Rationale

```text
Foundation
└─► Deep mapping (#1)                     ← hard dependency on Foundation only
    └─► Architecture intelligence (#2)    ← Foundation + Deep mapping; impact analysis feeds preflight
        └─► Living Wiki (#3)              ← hard dependency on Foundation only; sequenced after the vertical slice
            └─► Contracts & preflight (#4)   ← route edges + impact analysis; internal order: discovery → compatibility → drift → business flow → test plan → preflight manifest
                └─► Agent change guard (#5)  ← the preflight ID is a HARD dependency
                    └─► Cross-host release (#6) ← all previous phases
```

Hard dependency spine: **Foundation → Deep mapping → Architecture intelligence → Contracts & preflight → Agent change guard → Cross-host release**. The Living Wiki depends strictly only on Foundation.

1. **Foundation first:** every phase builds on `GraphSnapshot`, `WorkspaceAccessPolicy` and the MCP stdio envelope.
2. **Deep mapping second:** without Roslyn (C#) and framework `Endpoint` edges, contract discovery and business-flow tracing have no route anchors, and impact analysis misses API boundaries.
3. **Architecture intelligence third:** Architecture Guard, diff/timeline, agent context, onboarding and deterministic exports deliver value on top of the graph, and impact analysis feeds the preflight manifest.
4. **Living Wiki fourth:** projection needs only `GraphSnapshot` and SQLite; placing it after deep mapping reflects the vertical-slice-first priority (a deferral, not a cancellation).
5. **Contracts and preflight fifth:** the preflight manifest combines impact candidates, contract checks and a test-plan ID.
6. **Agent change guard sixth:** `causoryn_verify_change` needs a `preflightId`; only the evidence-chain enrichment of `causoryn_get_evidence` could stand alone.
7. **Cross-host release last:** release tagging follows the honesty policy — `1.0.0` is not declared while host or fidelity gates are open (the decision was a `0.1.0` public snapshot, later `0.2.0`, now `0.3.0`).

## 3. Delivered After the Original Plan

| Delivery | Scope | Status |
|---|---|---|
| **Multi-language deep analysis** (PR #14) | `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), `native/rust-worker` (`syn`), `adapters/{python,go,rust}`, unified 5-language `INDEXED_ADAPTERS` | **Done** |
| **External audit closure** | 5-language `ROUTES_TO` resolution accuracy; Antigravity `$schema`-free `plugin.json`, `mcp_config.json`, `scripts/mcp-server.mjs` staging; structured MCP tool annotations (`readOnlyHint`); `scripts/secret-scan.mjs` | **Done** |
| **Pre-1.0 engineering improvements** | Optional persistent SQLite store (`storage.dataDbPath`) + `symbol_fts` agent-context leg; incremental `refresh_index`; TypeScript BDD `Test` / `TESTS` extraction; `export_documentation(format="snapshot")`; `@causoryn/sidecar-ipc`; GitHub Actions CI | **Done** |
| **Open-source multi-host distribution** (`packages/causoryn`) | Publishable `causoryn` npm package (`setup` / `doctor` / `mcp`), 4 host marketplace manifests and canonical `skills/`, zero-config `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, bundled `dist/typescript-lib/lib*.d.ts` | **Done** |
| **Open-source governance and supply chain** (`0.2.0`) | `MIT` + `THIRD-PARTY-NOTICES.md` + `licenses/`, deterministic Release Roslyn build, governance files and templates, clean public exporter, SHA-pinned 3-OS `ci.yml`, OIDC `release.yml` with CycloneDX SBOM, 13-root secret scan, root denylist and Git TOCTOU/env hardening, `npm audit` = 0 vulnerabilities | **Done** |
| **`0.2.1` — startup and indexing** | Background indexing after the MCP handshake, build/cache exclusions and root `.gitignore`, external-node de-duplication, bulk SQLite transactions, bounded job diagnostics | **Done** |
| **`0.2.2` — visual architecture exports** | Layered SVG, Mermaid, Markdown and JSON views, HTML-only interactive portal, validated caller annotations, the `architecture-blueprint` skill, `PRAGMA data_version`-guarded snapshot cache, `doctor` version from the manifest | **Done** |
| **`0.2.3` — JavaScript/CommonJS and confined analysis** | `.js` / `.jsx` / `.mjs` / `.cjs` + CommonJS + JavaScript Express/Next.js in `ts-adapter`; root-confined `tsconfig.json` / `jsconfig.json`; polynomial-time glob matcher, `.git/info/exclude`, nested `.gitignore`, `bin/` handling; `collectInventoryAsync`; default `causoryn-architecture-interactive.html` | **Done** |
| **`0.2.4` — CI/CD and supply-chain hardening** | `security.yml` (`zizmor`, `dependency-review-action`, `npm audit --audit-level=high`, locked-mode NuGet scan), CodeQL, OpenSSF Scorecard, provenance release pipeline, `-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp --ref HEAD`, 7-day Dependabot cooldown, `tests/ci-workflow.test.ts` | **Done** |
| **`0.2.4` — skills and documentation** | Bilingual natural-language skill triggers, Zod `.describe()` docs on `causoryn_export_documentation`, TR/EN documentation hub including [Prompting & Architecture Portals](prompting-and-architecture-portals.md), deterministic vs. annotated prompt examples | **Done** |
| **`0.3.0` — lean MCP surface** | 11-tool `core` default, `wiki` / `history` / `full` profiles (`--tool-profile`, `CAUSORYN_TOOL_PROFILE`), consolidated `causoryn_status` / `causoryn_trace` / `causoryn_contracts`, `outputSchema` omitted by default, English tool descriptions | **Done** |
| **`0.3.0` — runtime** | `worker_threads` indexing with progress notifications and a bounded first-index wait; per-file `file_facts` early cutoff and TypeScript `oldProgram` reuse; streaming snapshot IDs, light warm boot and snapshot retention | **Done** |
| **`0.3.0` — shared workspace database** | One `graph.sqlite` per workspace for all hosts, `build_leases` single-writer publishing, orphan `building` recovery | **Partial** (scope note in [Implementation Status](implementation-status.md)) |
| **`0.3.0` — security hardening** | Toolchain isolation for analyzed repositories (Git, Go, Python, Roslyn, Cargo, `doctor`), lexical UNC/device-path rejection, `$HOME` and ancestor rejection as project roots, SHA-256 CSP for the interactive portal, three-job release workflow | **Done** |
| **`0.3.0` — analysis accuracy** | Go directory + `go.mod` package keying; Rust suffix matches labelled `heuristic`; `verify_change` trusted-base rules and `host_asserted` test status; preflight-based test plans; agent-context localization ranking; TypeScript monorepo workspaces, call signatures, class-hierarchy edges for TypeScript and C#; read-only NuGet discovery; `coverage.byLanguage` | **Done** |
| **`0.3.0` — architecture timeline trust warning** | MCP timeline points from committed snapshot blobs carry `snapshot-loaded-from-committed-git-blob`; library seams for local SQLite / git-tree reconstruction exist but are not wired to MCP | **Partial** |
| **`0.3.0` — evaluation and docs** | Real-repository precision/recall/latency harness (`scripts/bench/real-repo-eval.mjs`), [5-minute tutorial](tutorial-5-minutes.md), English public docs, `CHANGELOG.md` and CLI output | **Done** |

## 4. Open `1.0.0` Release Gates

| # | Gate | Current state | Closure requirement |
|---|---|---|---|
| 1 | **Antigravity `agy` CLI install + smoke** | **NOT RUN** — no `agy` binary on the verification machine; the direct stdio handshake (11 core tools) is covered by `antigravity-plugin.test.ts` | Run `agy plugin validate --strict`, `install`, `list`, in-host tool discovery and a clean uninstall on a machine with the `agy` CLI |
| 2 | **ZCode desktop GUI install + `tools/list` smoke** | **Partial** — manifests and isolated CLI configuration verified by tests | Run a live desktop ZCode installation and tool-discovery smoke with the user's consent |
| 3 | **Live macOS / Linux / ARM64 host smoke** | **Partial** — 3-OS CI is green on `ubuntu-latest`, `windows-latest`, `macos-15`; live host runs exist only for Windows x64 and predate 0.3.0 | Record live CLI/desktop host smoke runs on macOS and Linux (`x64` / `arm64`) |
| 4 | **MCP TypeScript SDK v1.x → v2** | **Open** — `@modelcontextprotocol/sdk` `^1.32.2` | Migrate to the stable v2 SDK and re-verify every tool profile and contract |
| 5 | **Live Architecture watcher MCP surface** | **Partial** — `file_facts` early cutoff and `oldProgram` reuse shipped; `WorkspaceWatcher` is in-process only | Expose the filesystem watcher lifecycle safely over MCP |
| 6 | **`Test` / `TESTS` extraction in sidecar languages** (C#, Python, Go, Rust) | **Partial** — active for TypeScript/JavaScript only; the sidecars only list the kinds in their protocol enums | Emit `Test` nodes and `TESTS` edges from the Roslyn, Python, Go and Rust workers |
| 7 | **Contract and drift fidelity** | **Partial** — OpenAPI request schemas, SQL, AsyncAPI, JSON Schema and Protobuf active | Add OpenAPI response-schema drift, the event-version mismatch rule, and SQL `RENAME` classification (today `unknown`) |
| 8 | **Read-only snapshot revision workflow** | **Partial** — `causoryn_export_documentation(format="snapshot")` writes to authorized output directories; MCP timeline/compare read committed `.causoryn/architecture-snapshot.json` blobs | Wire local SQLite / git-tree reconstruction into the MCP history tools so revisions can be compared without committed snapshots and without writing into analyzed workspaces |
| 9 | **Living Wiki surface** | **Partial** — FTS5 search, CAS overlay and incremental page selection active; `wiki_search` declares `kinds` / `scope` / `language` / `revision` / `resolution` but rejects them | Accept those filters, add `WIKI_NOTE_CONFLICT` to MCP error guidance together with a consented note-writing flow, and narrow incremental link/FTS rewrites |
| 10 | **Interactive portal and visualizer browser acceptance** | **Partial** — DOM and security tests and the SHA-256 CSP verified | Real-browser acceptance of the offline interactions |
| 11 | **Bare monorepo bundle default-lib scope** | **Partial** — `packages/causoryn` bundles `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`; `packages/mcp-server/dist/` does not | Stage default-lib `.d.ts` files in the bare bundle or document the boundary as permanent |
| 12 | **Rate-limit / concurrency budget** | **Open** — size, depth and timeout ceilings enforced; no request concurrency limiter | Add concurrent-call and resource-budget enforcement across MCP requests |

### Known 0.3.0 boundaries outside the gate list

- **Shared workspace database:** single-writer publishing and orphan recovery are in place; job-state reporting for a host that loses the publish race, waiting for a peer's lease before analysis, and migration of files from earlier per-host database layouts are not claimed.
- **Rust protocol document:** `native/rust-worker/PROTOCOL.md` still describes the earlier single-match `verified` rule for qualified paths; `native/rust-worker/src/analyzer.rs` (heuristic) is authoritative.
- **Host smoke freshness:** the Claude Code and Codex live CLI runs were recorded before 0.3.0; the 0.3.0 tool profiles are covered only by automated tests ([compatibility matrix](compatibility-matrix.md)).

## 5. Post-1.0 Candidates and Minor Technical Debt

- **Optional deeper semantics for Go and Rust:** optional `go/types` resolution in `native/go-worker` and trait-dispatch resolution in `native/rust-worker`, keeping the honest labels when unavailable.
- **Per-language file counters:** surface `csFileCount` (tracked in the job record) and Python / Go / Rust counts next to `tsFileCount` in status payloads.
- **Optional Antigravity plugin extensions:** `agents/`, `rules/` or `hooks.json` under `integrations/antigravity/causoryn/` (`skills/` already ship at the repository root and inside `packages/causoryn`).
- **Internal cleanups:** re-export `overlay` from `packages/wiki/src/index.ts`, add a standalone Zod schema for `candidateStatuses`, and share one iterative Tarjan SCC helper between `guard.ts` and `onboarding.ts`.

## 6. GitHub Issue References

| Issue | Phase |
|---|---|
| [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Deep mapping |
| [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Architecture intelligence (original features) |
| [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Living Wiki |
| [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Contracts, preflight and business flow (differentiation) |
| [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Agent change guard |
| [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Cross-host release |

## Related Pages

- [Implementation Status](implementation-status.md) — per-phase evidence tables and the 0.3.0 capability table
- [CHANGELOG.md](../../CHANGELOG.md) — release notes
- [Architecture Overview](architecture.md) — workspace packages and native sidecars
- [Host Compatibility Matrix](compatibility-matrix.md) — host × outcome matrix
