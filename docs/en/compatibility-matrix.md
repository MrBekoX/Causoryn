# Compatibility Matrix — Host × Outcome

> **Language / Dil:** [Türkçe](../compatibility-matrix.md) · English

> Evidence: Sprint 7 F2–F5 · Architecture Decisions K-021/K-022/K-025/K-026 ·
> [docs/en/hosts/claude-code.md](hosts/claude-code.md), [docs/en/hosts/codex.md](hosts/codex.md),
> [docs/en/hosts/zcode.md](hosts/zcode.md), [docs/en/hosts/antigravity.md](hosts/antigravity.md),
> `integrations/zcode/causoryn/README.md` · Technical Specification v2.1 §22 (Cross-host smoke:
> "Antigravity plugin validate/list, Claude Code /mcp, Codex mcp list … if `agy` CLI is absent,
> explicitly report not run") and §23 Phase F gate · Red Rule 5 (unexecuted smoke tests are
> explicitly reported as `NOT RUN`) and Red Rule 6 (never leave permanent residue in user configs) ·
> Verification suite: `tests/release-docs.test.ts` (Antigravity row strictly `NOT RUN`; ZCode row
> claims manifest + isolated CLI verification while desktop GUI remains `NOT RUN`).

Engine identity: `causoryn@0.2.3` (`SERVER_VERSION` — Pre-1.0 Public Preview; historical F1–F9 runs
were recorded against `causoryn@0.1.0`), `stdio` MCP, `tools/list` publishes **exactly 29 tools**
(`TOOL_NAMES`, `packages/mcp-server/src/version.ts`). Both the distribution package
`packages/causoryn` (`npx causoryn@0.2.3 setup`) and the monorepo F1 bundle
(`packages/mcp-server/dist/mcp-server.mjs` + vendored `node_modules/better-sqlite3/`) execute the
same engine (the artifact is intentionally not a standalone single file because native `.node`
addons cannot be embedded, ADR-010). Local live host verification environment: Windows 10.0.26300
x64, Node ≥ 24; 3-OS GitHub Actions CI matrix (`.github/workflows/ci.yml`: `ubuntu-latest`,
`windows-latest`, `macos-latest`) verified green across all three operating systems with K-022/K-025 security and leak gates.

## Current Runtime Behavior (`v0.2.3`)

- All four hosts launch the same MCP engine on Node.js ≥ 24. Default package setup installs five canonical skills, including natural-language-triggered `architecture-blueprint`. The packaged CLI starts initial automatic indexing in the background after the handshake using non-blocking `collectInventoryAsync`. Poll `causoryn_index_status` until a snapshot is available. [CLI and Configuration](cli-and-configuration.md)
- Visual export runs without a model call; `view="interactive"` writes `causoryn-architecture-interactive.html` by default. The user or host model can supply optional `annotations` (guided by `K-026` MCP Zod `.describe()` schema descriptions). The same snapshot, format, view, options, and annotations render the same artifact; host prose can vary across runs. [Prompting & Architecture Portals](prompting-and-architecture-portals.md) · [Architecture export contract](tool-contracts.md)
- The security guide documents the interactive HTML portal's CSP and output boundaries in source and tests. This matrix's live host results come from the dated runs below. [Security pass](security-pass.md)

## Historical Host × Outcome Matrix (initial run `2026-11-08` · F8 final `2026-11-10` · K-021/K-022 CLI verification `2026-11-19`)

| Host | Installation | Smoke / Verification | `stdout` Cleanliness | Outcome |
|---|---|---|---|---|
| Claude Code | ✅ CLI **2.1.322** (`2026-11-10`) & **2.1.328** (`2026-11-19`) installed (syntax first verified `2026-11-08` on `2.1.319`); `claude mcp add -s local` with `CLAUDE_CONFIG_DIR` redirected to temp dir + K-021 packaged CLI setup & root `.claude-plugin/marketplace.json` | ✅ `claude mcp list` → `causoryn … ✔ Connected` executed end-to-end — **first `2026-11-08` (`2.1.319`), re-verified `2026-11-10` (`2.1.322`), and confirmed `2026-11-19` on `claude 2.1.328` with `plugin validate --strict` + `mcp list √ Connected`**; removed cleanly (`sha256sum ~/.claude.json` identical before/after); negative probe verified: invalid script path reports `✘ Failed to connect — CONNECTION_CLOSED` ([docs/en/hosts/claude-code.md](hosts/claude-code.md)) | ✅ Manual verification + K-021 `.tgz` E2E: pure JSON-RPC on `stdout` (`initialize` + `tools/list` → 29 tools), logs strictly on `stderr` | EXECUTED (F3 + K-021) |
| Codex CLI | ✅ CLI `0.163.0` (`2026-11-10`) & **0.169.0** (`2026-11-19`) installed; `codex mcp add causoryn-smoke` + K-021 packaged CLI setup + `.agents/plugins/marketplace.json`; **`~/.codex/config.toml` backed up prior to `2026-11-10` re-run** because `codex mcp add/remove` re-serializes TOML ([docs/en/hosts/codex.md](hosts/codex.md) §5) | ✅ `add` → `codex mcp list` (present) → `codex mcp remove` → `codex mcp list` (absent) with clean config proof — **first `2026-11-08`, re-run `2026-11-10`, and verified `2026-11-19` on `codex-cli 0.169.0` via `plugin marketplace add` + `mcp add/list`**; honest boundary: `codex mcp list` performs no live process health check — registration-level smoke; spawn/handshake verified via Claude live run and `.tgz` E2E | ✅ Manual verification + K-021 `.tgz` E2E: pure JSON-RPC on `stdout` (`initialize` + `tools/list` → 29 tools), `[causoryn]` logs strictly on `stderr` | EXECUTED (F4 + K-021) |
| ZCode (plugin) | ⚠️ No ZCode plugin CLI exists (marketplace installation is a desktop GUI step); K-021 packaged CLI setup (`~/.zcode/cli/config.json` + `~/.agents/mcp.json` fallback preservation) verified in isolated temp `$HOME`; **real desktop GUI profile is intentionally untouched** (Red Rule 6, [docs/en/hosts/zcode.md](hosts/zcode.md)) | ⚠️ **Manifest & isolated CLI verification executed**: root `marketplace.json` + packaged `.zcode-plugin/plugin.json` (version pin) + dev marketplace (`integrations/zcode/.claude-plugin/marketplace.json`) + `plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts`, and `open-source-distribution.test.ts` all green; interactive desktop GUI install + `tools/list` observation documented, `NOT RUN` | ✅ Same-engine `stdio` hygiene (`stdio-stdout.test.ts` + K-021 `.tgz` E2E); in-UI host observation `NOT RUN` | MANIFEST & CLI VERIFIED — GUI install `NOT RUN` (F2 + K-021) |
| Antigravity | ❌ **NOT RUN** — `agy` CLI is absent on this machine (`agy --version` → command not found; `command -v agy` empty; Antigravity IDE is installed without a standalone CLI binary); K-021 packaged CLI setup verified inside an isolated temp `$HOME` | ❌ **NOT RUN** — `agy plugin validate/install/list` and host tool discovery were none executed (Spec §22 rule: explicitly report not run when `agy` CLI is missing); schema + direct `stdio` handshake (29 tools) on `plugin.json` (`$schema`-free built-in loader compatible) + `mcp_config.json` + `mcp.json` + `README.md` + staged `scripts/mcp-server.mjs` verified by `antigravity-plugin.test.ts`; `agy` CLI install/smoke NOT RUN ([docs/en/hosts/antigravity.md](hosts/antigravity.md)) | ❌ **NOT RUN** — in-UI host stdout observation could not be run (server process stdio hygiene is unit-tested) | NOT RUN (F5 — `agy` CLI absent; ADR-010: unexecuted checks are never marked Done) |

## Historical Host-Agnostic Package Checks

| Check | Result | Evidence |
|---|---|---|
| F1 bundle determinism | ✅ Bit-for-bit identical across consecutive builds; `bundle-manifest.json` (35 files: `mcp-server.mjs`, `mcp-server.mjs.LEGAL.txt`, `node_modules/better-sqlite3/LICENSE` + runtime/prebuilds, sorted sha256) matches `mcp-server.mjs` (`60735ff` + K-022 license notices) | `packages/mcp-server/test/bundle.test.ts`; `tests/hosts-docs.test.ts` manifest sha256 guard |
| K-021/K-022 `packages/causoryn` distribution package | ✅ `build-package.mjs` + `verify-package-ready.mjs` + isolated `npm pack` `.tgz` E2E (4-host `setup`/`doctor` + `mcp` `stdio` handshake + `THIRD-PARTY-NOTICES.md` / `licenses/`) | `tests/open-source-distribution.test.ts`; `packages/causoryn/test/setup-and-doctor.test.ts` |
| 3-OS GitHub Actions CI & K-025 supply chain | ✅ Green across `ubuntu-latest`, `windows-latest`, and `macos-latest` running Node 24 + .NET 10 (`-p:RestoreLockedMode=true`) + Python 3.12 + Go + Rust (`--locked`) builds, bundle, distribution package readiness, `npm audit --audit-level=high`, `export-public-tree.mjs --verify-temp --ref HEAD`, lint, secret-scan, and full Vitest suite, paired with dedicated `zizmor`, 5-language CodeQL, and OpenSSF Scorecard workflows | `.github/workflows/{ci,security,codeql,scorecard,release}.yml`; `tests/ci-workflow.test.ts` |
| F6 security release audit (packaged bundle, Spec §22 matrix) | ✅ 9/9 rows PASS (traversal/symlink, secret leakage, TOCTOU, prompt injection, oversized files, malicious git refs, network denied, offline XSS/CSP, `stdout` hygiene); **final round (`e3d0bc2`, `2026-11-10`)** upgraded row 6 to bundle-level behavioral proof (real commit SHA resolved via `git cat-file`, 3 malicious refs → `INVALID_REVISION`) | `docs/en/security-pass.md`; `npx vitest run tests/security-release/f6-security-release.test.ts` → **32/32**; full directory `npx vitest run tests/security-release/` → **36/36** |
| F7 performance benchmarks (1k-file fixture, MCP protocol layer) | ✅ Medians (**`2026-11-10` final run**): `workspace_summary` 11.8 ms, symbol context 13.0 ms, 200-node map 10.7 ms — well within Spec §21 reference targets (design budgets, not hard claims) | `docs/en/benchmarks.md`; `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (`vitest.bench.config.ts`) |
| `stdio` `stdout` hygiene (unit) | ✅ `stdout` carries exclusively MCP protocol frames; logs go to `stderr` prefixed with `[causoryn]` | `packages/mcp-server/test/stdio-stdout.test.ts` |

## Honesty Notes

1. **2 of the 3 CLI hosts were verified via live host CLI execution; Antigravity `agy` CLI could not be run.**
   The Spec §23 Phase F gate item ("3-host installation tests") is therefore reported honestly as
   `2/3`, keeping the remaining `1/3` explicitly `NOT RUN` with a ready-to-execute command checklist
   in [docs/en/hosts/antigravity.md](hosts/antigravity.md).
2. **The ZCode row is deliberately scoped to manifest validation and isolated CLI config setup:**
   Red Rule 6 prohibits smoke tests from leaving permanent residue in a developer's real ZCode
   installation, and ZCode marketplace installation is GUI-only. Setup instructions
   ([docs/en/hosts/zcode.md](hosts/zcode.md), `integrations/zcode/causoryn/README.md`, and
   `npx causoryn@0.2.3 setup --client zcode --yes`) are documented while interactive desktop GUI
   execution remains `NOT RUN`.
3. **Two-layer `stdout` hygiene:** Because all four hosts spawn the exact same engine, process-level
   `stdout` discipline carries across hosts (unit suite + F6's 5 independent spawn sessions + Claude
   Code / Codex manual runs + K-021 `.tgz` E2E); live host CLI observation was performed on Claude
   Code and Codex.
4. **Platform verification boundary:** Live interactive host CLI smoke tests in this matrix were run
   on Windows x64; `.github/workflows/ci.yml` executes all build, bundle, package, lint,
   secret-scan, and test gates green on `ubuntu-latest`, `windows-latest`, and `macos-latest`
   (K-022), while live interactive macOS/ARM64 host CLI/GUI smoke (Spec §22 Release row) remains
   `NOT RUN` as an explicit `1.0.0` gate.
5. **Compatibility & trust principle (Spec §17.4):** Cross-host parity is guaranteed through MCP
   tool schemas and contract tests; host UI/permission equivalence is never claimed, and Causoryn
   cannot force a host model to select a tool.

## Related Pages

- [docs/en/hosts/claude-code.md](hosts/claude-code.md) · [docs/en/hosts/codex.md](hosts/codex.md) · [docs/en/hosts/zcode.md](hosts/zcode.md) · [docs/en/hosts/antigravity.md](hosts/antigravity.md) · `integrations/zcode/causoryn/README.md` · `integrations/antigravity/causoryn/README.md`
- [docs/en/security-pass.md](security-pass.md) · [docs/en/benchmarks.md](benchmarks.md) · [docs/en/tool-contracts.md](tool-contracts.md) · [docs/en/prompting-and-architecture-portals.md](prompting-and-architecture-portals.md) · [docs/en/implementation-status.md](implementation-status.md)
- [Türkçe sürüm](../compatibility-matrix.md)
