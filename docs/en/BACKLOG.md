# BACKLOG — Phase Dependency Ordering & Open Release Gates

**Language / Dil:** [Türkçe](../BACKLOG.md) | English

> Evidence: `wiki/roadmap.md` (Spec v2.1 §23–§25), `wiki/sprint-1.md` – `wiki/sprint-8.md`, `wiki/decisions.md` (`K-001`..`K-026`), [implementation-status.md](implementation-status.md), and [CHANGELOG.md](../../CHANGELOG.md) · Section 1–2 preserve the original Sprint 1 Task 11 phase-dependency architecture (mapped 1-to-1 to GitHub issues `#1`–`#6`); Sections 3–5 record the post-plan expansions delivered from Sprint 8 through the `v0.2.4` Pre-1.0 Public Preview (`K-025`/`K-026`) baseline alongside the genuinely open `1.0.0` release gates and post-1.0 candidates under strict `ADR-010` honesty.

## 1. Historical Phase → Issue Mapping & Current Status

| Order | Phase | Issue | Phase Dependencies | Primary Components | Acceptance Gate | `v0.2.4` Status (`ADR-010`) |
|---|---|---|---|---|---|---|
| 0 | **A — Foundation** | *Delivered directly in Sprint 1* | — | `packages/domain`, `packages/workspace`, `packages/indexing`, `packages/graph`, `packages/storage-sqlite`, `packages/mcp-server`, `adapters/typescript` | Live tool calls + fixture golden + security tests | **Done** (11/11, PR #7) |
| 1 | **B — Deep Mapping** | [#1](https://github.com/MrBekoX/Causoryn/issues/1) | A (hard) | `native/roslyn-worker/`, `adapters/csharp-roslyn/`, `packages/indexing`, `packages/graph`, `packages/mcp-server` | C# + TS fixture cross-boundary evidence chain | **7/8 Done · `B7` Partial** (PR #8 + B9 + `K-020`; per-file parse reuse & watcher MCP surface remain open) |
| 2 | **C — Original Features** | [#2](https://github.com/MrBekoX/Causoryn/issues/2) | A + B (hard); C2 + D (soft, degrades cleanly) | `packages/graph`, `packages/mcp-server`, `packages/workspace` (`OutputAccessPolicy`) | 10 core architecture & change-intelligence features on real fixtures | **Done** (8/8 + B9, PR #9) |
| 3 | **C2 — Living Wiki** | [#3](https://github.com/MrBekoX/Causoryn/issues/3) | A (hard); B (recommended order, not hard) | `packages/wiki`, `packages/storage-sqlite`, `packages/mcp-server` | 7 Wiki tools live tests + 2× reindex annotation preservation (§16A.10) | **Done** (8/8, PR #10) |
| 4 | **D — Differentiation** | [#4](https://github.com/MrBekoX/Causoryn/issues/4) | A + B + C (hard); C2 (soft) | `packages/contracts`, `packages/preflight`, `packages/indexing`, `packages/mcp-server` | Contract/drift + candidate-only preflight fixtures | **Done** (7/7 + MCP, PR #11) |
| 5 | **E — Agent Change Guard** | [#5](https://github.com/MrBekoX/Causoryn/issues/5) | A + B + C + **D (hard — E1 consumes `preflightId`)**; C2 (soft) | `packages/verification`, `apps/visualizer`, `packages/mcp-server` | Byte-deterministic `verify_change` + no-test-execution honesty | **Done** (6/6 + 29th tool, PR #12) |
| 6 | **F — Cross-host Release** | [#6](https://github.com/MrBekoX/Causoryn/issues/6) | **All of A–E** (gate: 18 modules + Wiki Done) | `packages/mcp-server` (esbuild bundle), `integrations/*`, `docs/` | Release security/benchmark matrix + changelog + version decision | **Done** (9/9, PR #13 → `v0.1.0` snapshot `4c9c188`; F5 `agy` CLI `NOT RUN`) |

## 2. Dependency Graph & Ordering Rationale

```text
A (Foundation, Sprint 1)
└─► B (Deep Mapping)              #1   ← hard dependency on A only
    └─► C (Original Features)     #2   ← A + B; C1 impact feeds D
        └─► C2 (Living Wiki)      #3   ← hard dependency on A only; sequenced per K-003
            └─► D (Differentiation)   #4 ← B endpoint edges + C impact + internal order D1→D2→D3→D6→D4
                └─► E (Agent Change Guard) #5 ← D4 preflightId is a HARD dependency
                    └─► F (Cross-host Release) #6 ← all of A–E + 18 modules + Wiki Done gate
```

Hard dependency spine: **A → B → C → D → E → F** (`C2` depends strictly only on `A`).

1. **A first:** every phase builds on `GraphSnapshot`, `WorkspaceAccessPolicy`, and the MCP `stdio` envelope (`Sprint 1`).
2. **B second:** without Roslyn (C#) and framework `Endpoint` edges, Phase D's contract discovery (`D1`) and business-flow tracing (`D5`) lack route anchors, and Phase C's impact analysis misses API boundaries (`B1–B8`).
3. **C third:** Architecture Guard, diff/timeline, Agent GPS, onboarding, and deterministic exports deliver immediate user value on top of the graph, while `C1` impact feeds `D4` preflight.
4. **C2 fourth:** Wiki projection requires only `GraphSnapshot` + SQLite; sequencing it after B reflects the vertical-slice-first priority (`K-003`, deferral rather than cancellation).
5. **D fifth:** `D4` preflight combines `C1` `impactCandidates` + `D1–D3` `contractChecks` + `D6` `testPlanId` (internal order: **D1 → D2 → D3 → D5 → D6 → D4**).
6. **E sixth:** `causoryn_verify_change` (`E1`) requires `preflightId` (`D → E` hard edge; only `E4` `get_evidence` enrichment can stand alone).
7. **F last:** release tagging is governed by `ADR-010` — `1.0.0` is never declared while host or fidelity gates remain open (`F9`: `0.1.0` public snapshot; `K-022`: `0.2.0` Pre-1.0 Public Preview).

## 3. Delivered Post-Plan Expansions (Sprint 8 → `v0.2.4`)

After completing the initial 7-sprint roadmap, the following expansions were delivered and closed:

- **Sprint 8 — Multi-Language Deep Analysis (`K-018`, PR #14):** `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), `native/rust-worker` (`syn`) sidecars, `adapters/{python,go,rust}`, and unified 5-language `INDEXED_ADAPTERS` (**Done**).
- **K-019 — Audit & Annotation Parity:** 5-language `ROUTES_TO` resolution fidelity, Antigravity `$schema`-free `plugin.json` + `mcp_config.json` + `scripts/mcp-server.mjs` bundle staging, structured MCP `annotations` (`readOnlyHint`) across all 29 tools, and the `scripts/secret-scan.mjs` gate (**Done**).
- **K-020 — Pre-1.0 Engineering Improvements:** optional persistent `storage.dataDbPath` SQLite graph store + `symbol_fts` (`get_agent_context` `fts` leg), `causoryn_refresh_index(mode="incremental")`, TypeScript BDD `Test`/`TESTS` extraction, `causoryn_export_documentation(format="snapshot")`, shared `@causoryn/sidecar-ipc` package, and GitHub Actions CI (**Done**).
- **K-021 — Open-Source Multi-Host Distribution (`packages/causoryn`):** single publishable `causoryn` npm package (`setup`/`doctor`/`mcp`), 4-host marketplace manifests (Antigravity, Claude Code, Codex, ZCode/GLM) + canonical `skills/`, zero-config `--allow-cwd` + dynamic MCP `roots/list` + `--auto-data-dir`, and bundled `dist/typescript-lib/lib*.d.ts` (**Done**).
- **K-022 — Open-Source Governance & Supply Chain (`v0.2.0`):** `MIT` license + `THIRD-PARTY-NOTICES.md` + `licenses/`, deterministic Release Roslyn build, `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `.github/*` templates, Option 1 clean public exporter (`scripts/export-public-tree.mjs`), 40-char SHA-pinned 3-OS `ci.yml` (`ubuntu`/`windows`/`macos`) + OIDC `release.yml` + 13-component CycloneDX 1.5 SBOM (`scripts/generate-sbom.mjs`), 13-root `secret-scan`, `runtime-cli.ts` sensitive/system root denylist + `git-read.ts` TOCTOU/env hardening, atomic `build-bundle.mjs` + 20 s spawn timeouts, and `npm audit` = **0 vulnerabilities** (**Done**).
- **v0.2.1 — Startup and indexing:** Background indexing after the MCP handshake, build/cache exclusions and root `.gitignore` for auto-configured workspaces, polyglot external-node deduplication, bulk SQLite transactions, and bounded job diagnostics (**Done**).
- **v0.2.2 — Visual architecture exports (`K-023`):** Layered SVG, Mermaid, Markdown, and JSON views, an HTML-only interactive portal, validated caller annotations, and the fifth canonical skill, `architecture-blueprint`. This version also introduced the `PRAGMA data_version`-guarded snapshot cache and dynamic `doctor` version (**Done**).
- **v0.2.3 — Universal JS/CJS compatibility and confined analysis (`K-024`):** `.js`/`.jsx`/`.mjs`/`.cjs` + CommonJS + JS Express/Next.js analysis inside the existing `ts-adapter`, root-confined `tsconfig.json`/`jsconfig.json` loader (`configureConfinedCompilerHost`), zero-RegExp polynomial-time glob matcher + `.git/info/exclude` & nested `.gitignore` discovery + smart `bin/` handling, non-blocking `collectInventoryAsync`, and default interactive HTML filename `causoryn-architecture-interactive.html` (`causoryn@0.2.3` live on npm via OIDC) (**Done**).
- **v0.2.4 (`K-025`) — CI/CD & Supply-Chain Security Hardening:** `.github/workflows/security.yml` (`zizmor`, PR `dependency-review-action`, `npm audit --audit-level=high` + fail-closed `--locked-mode` NuGet JSON audit), 5-language `.github/workflows/codeql.yml`, OpenSSF `.github/workflows/scorecard.yml`, 2-job SLSA `.github/workflows/release.yml` (`step-security/harden-runner`, tokenless OIDC), `.github/workflows/ci.yml` (`-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp --ref HEAD`), 4-ecosystem 7-day cooldown `.github/dependabot.yml`, and `tests/ci-workflow.test.ts` regression pins (**Done**).
- **v0.2.4 (`K-026`) — Natural-Language Skill Triggering, MCP Schema Docs & Diátaxis TR/EN Overhaul:** Bilingual canonical skill refinements, Zod `.describe()` documentation on `causoryn_export_documentation`, 17-pair Diátaxis TR/EN documentation hub (including [prompting-and-architecture-portals.md](prompting-and-architecture-portals.md)), and Deterministic vs. Annotated example prompt recipes (**Done**). [Release notes](../../CHANGELOG.md) · [Tool contracts](tool-contracts.md)

## 4. Current Open Backlog — `1.0.0` Release Gates (`ADR-010`)

The gates below mirror [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased]`; `1.0.0` will not be declared until they are satisfied:

| # | Open `1.0.0` Gate | Current State | Closure Requirement |
|---|---|---|---|
| G1 | **Antigravity `agy` CLI install + smoke** | **Not Run** (direct `stdio` 29-tool handshake verified in `antigravity-plugin.test.ts`; no `agy` binary on machine) | Execute `agy plugin validate --strict`, `install`, `list`, 29-tool discovery, and clean uninstall on a machine with `agy` CLI |
| G2 | **ZCode in-GUI install + `tools/list` smoke** | **Partial (manifest-level)** (root and dev `marketplace.json` + `.zcode-plugin/plugin.json` verified by schema tests) | Run live desktop ZCode GUI installation + 29-tool discovery smoke with user consent |
| G3 | **Live macOS / Linux / ARM64 host smoke** | **Partial** (`.github/workflows/ci.yml` runs full build/test gates on `ubuntu-latest`, `windows-latest`, pinned `macos-15`) | Record live CLI/desktop host smoke runs on macOS and Linux (`x64`/`arm64`) |
| G4 | **MCP SDK v1.x → v2 upgrade (`K-009`)** | **Open** (`@modelcontextprotocol/sdk` pinned at `^1.32.2` v1.x) | Migrate to stable MCP TypeScript SDK v2 and re-verify all 29 tool contracts |
| G5 | **B7 Live Architecture full closure** | **Partial** (`refresh_index mode=incremental` and in-process `watcher.ts` active) | Implement **per-file parse reuse** on changed sets and expose FS watcher lifecycle via an MCP surface |
| G6 | **`TESTS` edges in sidecar languages (`C#`, `Python`, `Go`, `Rust`)** | **Partial** (`adapters/typescript` BDD `Test`/`TESTS` extraction enabled in `K-020`) | Extract test symbols/attributes → `Test` nodes + `TESTS` edges in Roslyn, Python, Go, and Rust workers |
| G7 | **Contract discovery & drift fidelity extensions (`K-015`)** | **Partial** (request schemas + SQL/AsyncAPI/JSON Schema/Protobuf active) | Add OpenAPI **response-schema** drift (`K-015(5)`), Spec §11 event-version mismatch rule (`K-015(4)`), and SQL `RENAME` handling (`K-015(3)`) |
| G8 | **Snapshot revision workflow automation** | **Partial** (`export_documentation(format="snapshot")` writes canonical `architecture-snapshot.json` to authorized output dirs) | Ergonomic git-revision snapshot comparison workflow without violating `ADR-008` read-only workspace guarantees |
| G9 | **Living Wiki surface refinements** | **Partial** (FTS5 search, CAS overlay, and incremental page selection active) | Expose `wiki_search` query filters (`pageKind`/`language`/…), add `WIKI_NOTE_CONFLICT` to `TOOL_ERROR_GUIDANCE`, and narrow incremental link/FTS rewrites |
| G10 | **Offline visualizer browser verification (`E6`)** | **Partial** (`causoryn_export_documentation(format="html", view="interactive")` → `causoryn-architecture-interactive.html` available) | Real-browser acceptance of offline interactions |
| G11 | **Bare F1 bundle `.d.ts` scope decision** | **Partial** (`packages/causoryn` stages `dist/typescript-lib/lib*.d.ts` and reaches `state: "ready"`) | Stage default lib `.d.ts` in bare monorepo `packages/mcp-server/dist/` or finalize permanent scope boundary |
| G12 | **Rate-limit / concurrency resource budget (`K-010`)** | **Open** (size/depth/timeout ceilings enforced; request concurrency limiter deferred in Phase A) | Add Spec §10/§20 concurrent-call and resource-budget enforcement wrapper |

## 5. Post-1.0 Enhancement Candidates & Minor Technical Debt

- **Optional deep semantic modes for Go & Rust (`1.0+`):** optional `go/types` type-checked resolution in `native/go-worker` and trait-dispatch / semantic resolution in `native/rust-worker` while preserving honest `PROTOCOL.md` labels when unavailable.
- **Multi-language file counters on `index_status`:** surface `csFileCount` and Python/Go/Rust file counts alongside `tsFileCount` in `causoryn_index_status`.
- **Optional Antigravity plugin extensions:** optional `agents/` / `rules/` / `hooks.json` assets under `integrations/antigravity/causoryn/` (`skills/` already ship at the repository root and inside `packages/causoryn`).
- **Internal module cleanups:** re-export `overlay` from `packages/wiki/src/index.ts`, add a standalone Zod schema for `candidateStatuses`, and deduplicate the iterative Tarjan SCC helper shared in spirit between `guard.ts` and `onboarding.ts`.

## 6. Historical GitHub Issue References

| Issue | Title |
|---|---|
| [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Phase B: Deep Mapping |
| [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Phase C: Original Features |
| [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Phase C2: Living Wiki |
| [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Phase D: Differentiation |
| [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Phase E: Agent Change Guard |
| [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Phase F: Cross-host Release |

## Related Pages

- [implementation-status.md](implementation-status.md) — detailed sprint-by-sprint and `K-019`..`K-026` evidence tables
- [CHANGELOG.md](../../CHANGELOG.md) — `0.2.4` Pre-1.0 Public Preview release notes and `[Unreleased]` 1.0.0 gates
- [architecture.md](architecture.md) — 18-workspace-package and 4-native-sidecar architecture
- [compatibility-matrix.md](compatibility-matrix.md) — 4-host compatibility matrix
