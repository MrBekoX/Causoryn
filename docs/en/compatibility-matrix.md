# Compatibility Matrix — Host × Outcome

> **Language:** [Türkçe](../compatibility-matrix.md) | **English** · [Documentation Hub](README.md)

**Engine identity:** `causoryn@0.2.4` (Pre-1.0; historical baseline runs were recorded against `causoryn@0.1.0`), `stdio` MCP. By default (`--tool-profile core` or `CAUSORYN_TOOL_PROFILE=core`), `tools/list` publishes **11 consolidated core tools** (`<= 15,000` characters); `--tool-profile wiki` (+7), `--tool-profile history` (+2), and `--tool-profile full` (all 29 legacy tools + 3 consolidated core aliases = **32 tools**) are selectable via CLI flag or environment variable.

Both the npm distribution package `packages/causoryn` (`npx causoryn setup`) and the monorepo bundle (`packages/mcp-server/dist/mcp-server.mjs` + `dist/index-worker.mjs` + vendored `node_modules/better-sqlite3/`) execute the exact same engine (intentionally multi-file because native `.node` addons cannot be inlined into a single JS file). All 4 hosts share a single out-of-tree workspace SQLite WAL database (`~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite`) coordinated by heartbeat single-writer leases (`build_leases`).

Local live host verification environment: Windows 10.0.26300 x64, Node `>= 24`. The 3-OS GitHub Actions CI matrix (`.github/workflows/ci.yml`: `ubuntu-latest`, `windows-latest`, `macos-15`) runs full build, package, security, and test gates across all three operating systems.

## Current Runtime Behavior

- All four hosts launch the same MCP engine on Node.js `>= 24` via the absolute Node binary (`process.execPath`) written by `causoryn setup`.
- Default setup installs all 5 canonical skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`).
- Background indexing runs off the MCP event loop in a `worker_threads` WAL writer (`dist/index-worker.mjs`), streaming `notifications/progress` when the host supplies `_meta.progressToken` and responding immediately from warm snapshots (`getLatestSnapshotMeta`).
- Interactive HTML exports (`causoryn-architecture-interactive.html`) enforce a deterministic `script-src 'sha256-...'` CSP with zero external network access.

## Host × Outcome Verification Matrix

| Host | Installation | Smoke / Verification | `stdout` Cleanliness | Outcome |
|---|---|---|---|---|
| **Claude Code** | CLI **2.1.322** (`2026-11-10`) & **2.1.328** (`2026-11-19`) installed; `claude mcp add -s local` with `CLAUDE_CONFIG_DIR` redirected to temp dir + packaged CLI setup & root `.claude-plugin/marketplace.json` | `claude mcp list` -> `causoryn ... Connected` executed end-to-end (`2026-11-08`, re-verified `2026-11-10` on `2.1.322`, confirmed `2026-11-19` on `2.1.328` with `plugin validate --strict`); removed cleanly (`sha256sum ~/.claude.json` identical before/after); negative invalid-path probe reports `Failed to connect — CONNECTION_CLOSED` ([Claude Code Guide](hosts/claude-code.md)) | Manual verification + `.tgz` E2E: pure JSON-RPC on `stdout`, logs strictly on `stderr` | **EXECUTED** |
| **Codex CLI** | CLI `0.163.0` (`2026-11-10`) & **0.169.0** (`2026-11-19`) installed; `codex mcp add causoryn-smoke` + packaged CLI setup + `.agents/plugins/marketplace.json` (`~/.codex/config.toml` backed up before manual smoke; see [Codex Guide](hosts/codex.md)) | `add` -> `codex mcp list` (present) -> `codex mcp remove` -> `codex mcp list` (absent) verified (`2026-11-08`, `2026-11-10`, and `2026-11-19` on `0.169.0` via `plugin marketplace add`); honest boundary: `codex mcp list` reads config without live process probing — spawn/handshake verified via Claude live run and `.tgz` E2E | Manual verification + `.tgz` E2E: pure JSON-RPC on `stdout`, `[causoryn]` logs strictly on `stderr` | **EXECUTED** |
| **ZCode (plugin)** | No ZCode plugin CLI exists (marketplace installation is a desktop GUI step); packaged CLI setup (`~/.zcode/cli/config.json` + `~/.agents/mcp.json` fallback preservation) verified in isolated temp `$HOME`; real desktop GUI profile intentionally untouched ([ZCode Guide](hosts/zcode.md)) | **Manifest & isolated CLI verification executed:** root `marketplace.json`, packaged `.zcode-plugin/plugin.json`, dev marketplace, `plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts`, and `open-source-distribution.test.ts` all green; interactive desktop GUI install + in-UI `tools/list` observation: **`NOT RUN`** | Same-engine `stdio` hygiene verified in automated tests + `.tgz` E2E; in-UI observation `NOT RUN` | **MANIFEST & CLI VERIFIED — GUI `NOT RUN`** |
| **Antigravity** | **`NOT RUN`** — `agy` CLI is absent on the verification machine (`agy --version` -> command not found; Antigravity IDE desktop app has no standalone CLI binary); packaged CLI setup verified inside isolated temp `$HOME` | **`NOT RUN`** — `agy plugin validate/install/list` and in-host discovery were not executed; manifest schema (`$schema`-free `plugin.json` + `mcp_config.json` + `mcp.json` + `README.md`) and direct `stdio` child-process handshake verified in `antigravity-plugin.test.ts` ([Antigravity Guide](hosts/antigravity.md)) | **`NOT RUN`** — in-UI host stdout observation could not be run (server `stdio` hygiene is unit-tested) | **`NOT RUN`** (`agy` CLI absent) |

## Host-Agnostic Package & Assurance Checks

| Check | Result | Evidence |
|---|---|---|
| Deterministic multi-file bundle | Bit-for-bit identical across builds; 36-file `bundle-manifest.json` (`mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt`, vendored `better-sqlite3` runtime + prebuilds) | `packages/mcp-server/test/bundle.test.ts`; `tests/hosts-docs.test.ts` |
| `packages/causoryn` distribution package | `build-package.mjs` + `verify-package-ready.mjs` + isolated `npm pack` `.tgz` E2E (4-host `setup`/`doctor` + `mcp` `stdio` handshake + `THIRD-PARTY-NOTICES.md` / `licenses/`) | `tests/open-source-distribution.test.ts`; `packages/causoryn/test/setup-and-doctor.test.ts` |
| 3-OS GitHub Actions CI & supply-chain suite | `ubuntu-latest`, `windows-latest`, `macos-15` across all 5 language toolchains, plus dedicated `zizmor`, 5-language CodeQL, OpenSSF Scorecard, and hermetic 3-job OIDC release pipeline | `.github/workflows/{ci,security,codeql,scorecard,release}.yml`; `tests/ci-workflow.test.ts` |
| Packaged-bundle security suite | 9/9 threat classes PASS (`32/32` bundle suite, `36/36` full `tests/security-release/`) + untrusted-repo toolchain isolation (`tests/toolchain-isolation.test.ts`) + Win32 UNC lexical pre-check (`tests/path-safety.test.ts`) | [Security Audit](security-pass.md) |
| 1,000-file TS fixture benchmarks (`2026-11-10`) | Medians: `workspace_summary` `11.8 ms`, `get_symbol_context` `13.0 ms`, `map_system` (200 nodes) `10.7 ms` via `npm run bench` | [Benchmarks](benchmarks.md) |
| `stdio` `stdout` hygiene | `stdout` carries exclusively JSON-RPC 2.0 frames; logs go strictly to `stderr` prefixed with `[causoryn]` | `packages/mcp-server/test/stdio-stdout.test.ts` |

## Honesty Notes

1. **2 of 3 CLI hosts verified live; Antigravity `agy` CLI remains `NOT RUN`** until `agy` CLI is available (ready-to-execute checklist in [Antigravity Guide](hosts/antigravity.md)).
2. **ZCode verification covers manifests and isolated CLI setup only** so automated suites never modify a developer's real desktop ZCode installation.
3. **Platform boundary:** Live interactive host CLI runs were executed on Windows x64; `.github/workflows/ci.yml` executes all build/test/security gates across Linux, Windows, and `macos-15`, while live interactive macOS/ARM64 host smoke remains an open `1.0.0` gate.
4. **Cross-host parity boundary:** Parity is guaranteed at the MCP tool schema and contract layer; host UI/permission equivalence is never claimed, and Causoryn never forces a host model to invoke a tool.

## Related Pages

- [Claude Code](hosts/claude-code.md) · [Codex CLI](hosts/codex.md) · [ZCode](hosts/zcode.md) · [Antigravity](hosts/antigravity.md)
- [MCP Tool Contracts](tool-contracts.md) · [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md)
- [Implementation Status](implementation-status.md) · [Türkçe sürüm](../compatibility-matrix.md)
