# CLI, Zero-Config Workspace Discovery & Configuration Reference

> **Language:** [Türkçe](../cli-and-configuration.md) | **English** · [Documentation Hub](README.md)
>
> **Source modules:** `packages/causoryn/src/{cli.ts,setup.ts,doctor.ts,runtime-stage.ts,types.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs,verify-package-ready.mjs}`, `packages/mcp-server/src/{cli-stdio.ts,stdio.ts,runtime-cli.ts,config.ts,context.ts,workspace-ignore-discovery.ts}`, `packages/workspace/src/{path-safety.ts,policy-config.ts}`.

This reference covers every `causoryn` (`v0.2.4` — Pre-1.0) CLI subcommand and flag, MCP tool profiles, the pre-import Node.js `>= 24` runtime guard, the version-pinned plugin launcher, zero-config workspace discovery and root-safety filtering, the shared out-of-tree SQLite data layout, and the strict `CAUSORYN_CONFIG` JSON schema.

---

## 1. CLI Subcommands & Flags (`causoryn`)

For quick setup and read-only health verification, use `@latest` (exact version pinning such as `@0.2.4` is also supported in CI):

```bash
npx causoryn@latest setup --all-detected --yes   # Installs MCP server + 5 canonical skills for detected hosts
npx causoryn@latest doctor                       # Read-only check of Node.js >= 24, runtime, 4 sidecars & hosts
```

The `causoryn` binary (`packages/causoryn/scripts/causoryn.mjs`) exposes:

```text
causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--tool-profile <core|full|wiki|history>] [--output-schema <omit|full>]
causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all] [--all-detected] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
causoryn --version
causoryn --help
```

### 1.1 `causoryn setup` — 4-Host Installer & Uninstaller

Configures or removes Causoryn MCP server entries and the 5 canonical workflow skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`) across all 4 supported hosts (`antigravity`, `claude-code`, `codex`, `zcode`) with atomic writes and permanent preservation of your original config backup.

| Flag | Description |
|---|---|
| `--client <id>` | Target host identifier (`antigravity`, `claude-code`, `codex`, `zcode`). Repeatable (`--client claude-code --client codex`) or comma-separated (`--client=claude-code,zcode`). |
| `--all` | Explicitly configures all 4 supported hosts even if they are not yet detected on disk. |
| `--all-detected` | Targets only hosts detected on the current machine. If zero hosts are detected and neither `--client` nor `--all` is passed, `setup` writes **0 files** and prints actionable `--client <id>` / `--all` instructions. |
| `--dry-run` | Previews all planned operations (`create`, `update`, `remove`, `noop`) without writing or deleting any files. |
| `--yes`, `-y` | Applies changes without interactive confirmation. In interactive TTY sessions without `--yes`, prompts `Continue? [y/N]` over `stderr`. |
| `--skill` / `--no-skill` | Enables or disables installing/removing the 5 canonical `SKILL.md` directories (default: `--skill`). |
| `--uninstall` | Removes the `causoryn` MCP registration and installed skills from selected hosts; cleans up `~/.causoryn/runtime` automatically once no remaining host references it. |
| `--json` | Emits the structured `SetupResult` object as formatted JSON on `stdout`. |
| `--help`, `-h` | Prints CLI usage and exits `0`. |

#### Per-Host Detection, Target Paths & Safety Guarantees

| Host (`--client`) | Detection Marker | MCP Config File | Skills Directory | Host-Specific Behavior |
|---|---|---|---|---|
| `antigravity` | `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json` *(bare `~/.gemini` from Gemini CLI does NOT false-positive)* | `~/.gemini/config/mcp_config.json` (+ `~/.gemini/antigravity/mcp_config.json` when present) | `~/.gemini/config/skills/` | Omits `type` inside `mcpServers.causoryn` for compatibility with Antigravity's local MCP loader. |
| `claude-code` | `~/.claude.json` or `~/.claude` (or `$CLAUDE_CONFIG_DIR`) | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`) | Writes `mcpServers.causoryn` with `type: "stdio"`. |
| `codex` | `$CODEX_HOME` (default `~/.codex`) | `$CODEX_HOME/config.toml` | `~/.agents/skills/` | Surgically patches `[mcp_servers.causoryn]` with `startup_timeout_sec = 30` while preserving comments and neighbor TOML sections. |
| `zcode` | `~/.zcode` | `~/.zcode/cli/config.json` | `~/.zcode/skills/` | Writes `mcp.servers.causoryn` (`type: "stdio"`); preserves any existing fallback servers from `~/.agents/mcp.json` when initializing `mcp.servers`. |

- **Absolute Node executable:** Generated host configs write the absolute Node binary path (`process.execPath`) rather than bare `"node"` so desktop hosts with stripped `PATH` environments launch reliably.
- **Strict idempotency & permanent original backup:** When the rendered config matches the existing file byte-for-byte, `setup` performs zero writes and creates zero backups (`noop`). On the first modification, `<targetPath>.causoryn.backup` captures your original config and is **never overwritten** on subsequent updates (later modifications write timestamped `<targetPath>.causoryn.<timestamp>.backup` files). Temporary `.tmp` files are always cleaned up in `try/finally` if atomic `renameSync` fails.
- **Symlink overwrite protection (`CWE-59`):** If a target config file, backup file, or destination `SKILL.md` is a symbolic link, `setup` aborts fail-closed with `cli/io-error` (exit code `2`).

### 1.2 `causoryn doctor` — Read-Only Health & Alignment Auditor

`causoryn doctor` is **100% read-only**: it never creates, modifies, or deletes files, and runs toolchain probes in `cwd: os.tmpdir()` so untrusted project configs (such as `.cargo/config.toml` or `global.json`) in the current working directory can never be executed.

| Flag | Description |
|---|---|
| `--client <id>` | Restricts displayed host rows and exit evaluation to the specified host(s). |
| `--json` | Emits the full `DoctorReport` JSON object on `stdout`. |
| `--help`, `-h` | Prints CLI usage and exits `0`. |

Four audited subsystems:
1. **Node.js runtime (`node`):** Verifies Node.js major version `>= 24`.
2. **Package & staged runtime integrity (`runtime`):** Verifies `dist/mcp-server.mjs`, `dist/index-worker.mjs`, the OS/arch/libc-matched (`glibc` vs `linuxmusl`) `better-sqlite3` prebuild, `dist/typescript-lib/lib.es2022.full.d.ts`, all 4 `native/` workers, and compiled `Causoryn.RoslynWorker.dll`.
3. **Sidecar toolchains (`toolchains`):** Probes `dotnet`, `python`/`python3`, `go`, and `cargo` using `shell: false`, `cwd: os.tmpdir()`, a 5 s timeout, and an allowlisted environment (`DOCTOR_PROBE_ENV_ALLOWLIST`). Missing optional toolchains report `l0-l1-fallback`.
4. **Host alignment (`hosts`):** Validates JSON/TOML syntax, accepts both bare `"node"` and absolute Node binary paths (`process.execPath`, `/usr/local/bin/node`, `node.exe`) when verifying `entrypointExists`, and audits all 5 canonical skills.

**Honest overall status & exit codes:**
- `HEALTHY` (exit `0`): Node `>= 24`, runtime complete, at least one configured host, and zero host errors or warnings.
- `DEGRADED` (exit `1`): One or more configured hosts or probes report warnings (for example, missing skills).
- `NOT CONFIGURED` (exit `1`): Core runtime is valid, but zero MCP hosts are configured yet (`configuredCount === 0`).
- `UNHEALTHY` (exit `1`): Node `< 24`, missing runtime artifacts, or a host config error.
- Exit `2`: Invalid CLI arguments.

### 1.3 `causoryn mcp` — Zero-Config MCP `stdio` Server

`scripts/causoryn.mjs mcp` hands off directly to `dist/mcp-server.mjs` (`cli-stdio.ts`) with **zero bytes** of banner or log text on `stdout`.

| Flag | Description |
|---|---|
| `--allow-cwd` | Evaluates `process.cwd()` via `inspectProjectRootSafety` when no explicit `--root` or `CAUSORYN_CONFIG.allowRoots` is supplied; falls back to dynamic MCP `roots/list` binding when `cwd` is unsafe. |
| `--root <path>` | Explicitly authorizes a workspace root directory (repeatable; overrides `CAUSORYN_CONFIG.allowRoots`). |
| `--auto-data-dir` | Provisions an isolated out-of-tree workspace directory (`~/.causoryn/workspaces/<slug>-<hash12>/`) containing shared `graph.sqlite` and `exports/`. |
| `--data-dir <absPath>` | Overrides the base directory used by `--auto-data-dir` (defaults to `~/.causoryn`; must be absolute; implicitly enables `--auto-data-dir`). |
| `--client <id>` | Diagnostic/host label recorded on `build_leases` and logs (validated against `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`); all hosts share the same workspace `graph.sqlite`. |
| `--tool-profile <list>` | Selects the active MCP tool profile: `core` (default, 11 tools), `wiki` (+7), `history` (+2), `wiki,history` (20), or `full` (all 29 legacy + 3 consolidated = 32 tools). Precedence: `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `"core"`. |
| `--output-schema <omit\|full>` *(alias `--output-schema-profile`)* | Controls per-tool JSON `outputSchema` advertisement in `tools/list`. Precedence: CLI flag > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `"omit"`. Server-side Zod validation always runs on every response regardless of wire profile. |

### 1.4 `causoryn --version` & `causoryn --help`

- `causoryn --version` (`-v`, `version`): Prints `0.2.4` to `stdout` and exits `0`.
- `causoryn --help` (`-h`, `help`, or bare `causoryn`): Prints English usage help to `stdout` and exits `0`.

---

## 2. Pre-Import Node.js `>= 24` Guard & Plugin Launcher

- **`scripts/lib/node-version-guard.mjs`:** Runs before importing any compiled bundle or native `better-sqlite3` addon. On Node.js `< 24`, writes a clear diagnostic to `stderr`, emits **zero bytes on `stdout`**, and exits `2`.
- **`scripts/plugin-mcp-launcher.mjs`:** Invoked directly by native host marketplace manifests without spawning nested `npx` subprocesses; verifies `--expected-version` / `CAUSORYN_EXPECTED_VERSION` against `package.json`, sets `CAUSORYN_ASSET_ROOT`, and imports `dist/mcp-server.mjs`.

---

## 3. Zero-Config Workspace Discovery & Safety Model

### 3.1 Non-Blocking Boot, Warm Reads & `worker_threads` WAL Indexing

- **Warm startup:** When a published snapshot already exists in shared `graph.sqlite`, `getLatestSnapshotMeta` reads lightweight snapshot metadata without hydrating the full graph into RAM, so MCP `initialize`, `tools/list`, and initial tool calls respond immediately while any incremental refresh runs in a background `worker_threads` worker (`index-worker.ts`).
- **Cold startup:** Indexing runs off the main event loop in `worker_threads` over SQLite WAL (`PRAGMA busy_timeout=5000`), streaming MCP `notifications/progress` when the client supplies `_meta.progressToken`. Snapshot-dependent calls wait up to `CAUSORYN_INDEX_WAIT_MS` (default `15,000` ms) and return structured `{ indexing: true, status: "indexing", jobId, progress, retryAfterMs }` rather than a hard failure if indexing is still running.
- **Ignore discovery:** `buildWorkspaceAutoConfig` + `workspace-ignore-discovery.ts` merge root `.gitignore`, `.git/info/exclude`, and bounded nested `.gitignore` files (depth `<= 6`, up to `64` files, `4,000` dirs) on a zero-RegExp polynomial-time glob engine (`ignore-matcher.ts`), refining blunt `**/bin/**` into `.NET`-specific output patterns so Node `bin/*.ts|js` and Rust `src/bin/*.rs` sources stay indexed.

### 3.2 `inspectProjectRootSafety` — Rejected Unsafe Roots

Before touching the filesystem, every candidate path passes the lexical **`assertNotUncOrDevicePath`** check (`packages/workspace/src/path-safety.ts`) rejecting `\\host\share`, `//host/share`, `\\?\...`, and `\\.\...` paths so Windows never triggers outbound SMB/NTLM connections. Remaining paths are canonicalized via `realpathSync` and rejected fail-closed if they match:

1. Empty, null-byte (`\0`), unresolvable, or non-directory paths.
2. Filesystem roots (`/`, `C:\`).
3. `$HOME` / `%USERPROFILE%` **and all ancestor directories of `$HOME`** (`C:\Users`, `/home`, `/Users`).
4. Causoryn data directories (`~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`).
5. Plugin, bundle, and ephemeral cache directories (`~/.causoryn/runtime`, `~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, `node_modules`, `_npx`, or directories containing `bundle-manifest.json`).
6. Sensitive user directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`).
7. OS system and shared scratch directories (`/etc`, `/private/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/tmp`, `/var`, `/bin`, `/sbin`, `/lib`, `/dev` on POSIX; `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` on Windows).

### 3.3 Dynamic MCP `roots/list` Binding

When launched with `--allow-cwd` from an unsafe `cwd` (common in desktop IDEs), Causoryn boots cleanly with `allowRoots: []` and synchronizes via single-flight MCP `roots/list` on `oninitialized`, `beforeToolCall`, and `notifications/roots/list_changed`, atomically binding to the first safe `file://` root.

---

## 4. Shared Out-of-Tree Data Directory Layout

Causoryn never writes into analyzed source repositories. All MCP hosts accessing the same repository share a single external SQLite WAL database (`graph.sqlite`) coordinated by heartbeat single-writer leases (`build_leases`) and orphan-build recovery (`recoverOrphanBuilds`):

```text
~/.causoryn/                                    # Base dir (overridable via --data-dir or ZCODE_PLUGIN_DATA)
├── runtime/                                    # Persistent runtime staged atomically from ephemeral _npx caches
│   ├── package.json
│   ├── scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs}
│   ├── dist/{mcp-server.mjs,index-worker.mjs,bundle-manifest.json,node_modules/better-sqlite3,typescript-lib}
│   ├── native/{roslyn-worker,python-worker,go-worker,rust-worker}
│   └── skills/{causoryn,map-system,preflight-change,verify-change,architecture-blueprint}
├── workspaces/
│   └── <slug>-<hash12>/                        # POSIX mode 0o700 (basename slug + first 12 hex of canonical SHA-256)
│       ├── graph.sqlite                        # Shared WAL DB (graph + file_facts + build_leases + symbol_fts + wiki)
│       └── exports/                            # POSIX mode 0o700 (output.allowedOutputDirs target)
└── cache/
    └── rust-worker-target/                     # Writable Rust sidecar target cache + causoryn-rust-worker.sha256.json
```

- **Base data directory precedence:** `--data-dir <abs-path>` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`.
- **Pre-mkdir & post-mkdir symlink/containment guards:** Every ancestor prefix is verified against symlinks (`CWE-59`, allowing macOS system firmlinks `/var`, `/tmp`, `/etc`), dangling links, and `allowRoots` containment before and after `mkdirSync`.
- **Retention GC:** Publishing a snapshot runs `pruneOldSnapshots` (keeping the latest 2 published snapshots and removing orphan `symbol_fts` rows) with periodic `PRAGMA wal_checkpoint(TRUNCATE)`.

---

## 5. Full `CAUSORYN_CONFIG` JSON Schema

`CAUSORYN_CONFIG` is validated against `causorynServerConfigSchema` (`z.strictObject`; unknown keys fail closed at startup).

```json
{
  "workspaceId": "orders-service",
  "allowRoots": ["/work/orders-service"],
  "ignore": [
    "**/.git/**",
    "**/node_modules/**",
    "**/bin/**",
    "**/obj/**",
    "**/dist/**",
    "**/.env*",
    "**/*.pem"
  ],
  "extraIgnore": ["**/coverage/**", "**/generated/**"],
  "extensionFilterMode": "blacklist",
  "allowedExtensions": [],
  "maxFileBytes": 2000000,
  "index": {
    "maxFiles": 50000
  },
  "results": {
    "maxNodes": 250,
    "maxSymbols": 100,
    "maxDepth": 3,
    "maxPaths": 50
  },
  "autoIndex": true,
  "output": {
    "allowedOutputDirs": ["/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/exports"]
  },
  "storage": {
    "dataDbPath": "/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/graph.sqlite"
  },
  "wiki": {
    "dataDbPath": "/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/graph.sqlite"
  }
}
```

| Field | Type | Default | Semantics |
|---|---|---|---|
| `workspaceId` | `string` (`min(1)`) | `"default"` (`<slug>` under `--auto-data-dir`) | Opaque identifier for the authorized workspace. |
| `allowRoots` | `string[]` | `[]` | Absolute non-UNC directory paths. Empty array = default-deny (`WORKSPACE_NOT_AUTHORIZED`). |
| `ignore` | `string[]` | 38 default patterns | Core secret/build/venv/cache patterns; automatic config refines `**/bin/**` to `.NET` output globs unless overridden. |
| `extraIgnore` | `string[]` | `[]` | Additional ignore globs appended after `ignore`. |
| `binaryExtensions` | `string[]` | 68 extensions | Lowercased binary/ML/sourcemap denylist. |
| `extensionFilterMode` | `"blacklist" \| "whitelist"` | `"blacklist"` | `"blacklist"` skips `binaryExtensions`; `"whitelist"` admits only `allowedExtensions`. |
| `allowedExtensions` | `string[]` | `[]` | Permitted extensions in whitelist mode. |
| `maxFileBytes` | positive int | `2_000_000` (2 MB) | Per-file byte ceiling. |
| `index.maxFiles` | positive int | `50_000` | Maximum inventory files per workspace. |
| `results.maxNodes` / `maxSymbols` / `maxDepth` / `maxPaths` | positive int | `250` / `100` / `3` / `50` | Per-query result ceilings. |
| `autoIndex` | `boolean` | `true` | Opens existing snapshot or defers initial background index until after MCP initialization. |
| `output.allowedOutputDirs` | `string[]` | `[]` | Explicit allowlist for `causoryn_export_documentation` (empty returns `EXPORT_NOT_ALLOWED`). |
| `storage.dataDbPath` | optional `string` | `undefined` (`InMemoryGraphRepository`) | Absolute external SQLite path strictly outside `allowRoots`. |
| `wiki.dataDbPath` | optional `string` | `undefined` | Absolute external Living Wiki SQLite path strictly outside `allowRoots` (may share `graph.sqlite`). |

---

## 6. Environment Variables Reference

| Environment Variable | Consuming Layer | Purpose & Default Behavior |
|---|---|---|
| `CAUSORYN_CONFIG` | `mcp-server` | JSON server configuration string (merged with CLI flags when both are used). |
| `CAUSORYN_TOOL_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `core`, `wiki`, `history`, `wiki,history`, or `full` (default `core` when `--tool-profile` is omitted). |
| `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `omit` (default) or `full`. |
| `CAUSORYN_INDEX_WAIT_MS` | `mcp-server` (`runtime-cli.ts`) | Bounded cold-start wait window in milliseconds (default `15000`; `0` returns structured indexing status immediately). |
| `CAUSORYN_EXPECTED_VERSION` | `plugin-mcp-launcher.mjs` | Pins expected `causoryn` SemVer (`exit 2` on mismatch). |
| `CAUSORYN_ASSET_ROOT` | `sidecar-ipc`, launchers | Overrides discovery root for `native/` sidecar worker assets. |
| `CAUSORYN_TS_LIB_DIR` | `adapters/typescript` | Overrides discovery of bundled TypeScript `lib.*.d.ts` declarations. |
| `CLAUDE_CONFIG_DIR` | `causoryn` (`setup`, `doctor`) | Redirects Claude Code config/skills to `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/skills/`. |
| `CODEX_HOME` | `causoryn` (`setup`, `doctor`) | Redirects Codex config to `$CODEX_HOME/config.toml` (default `~/.codex`). |
| `ZCODE_PLUGIN_DATA` | `mcp-server` (`runtime-cli.ts`) | Base data directory for `--auto-data-dir` when `--data-dir` is omitted. |
| `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` | Host loaders & `runtime-cli.ts` | Resolves launcher script paths and marks plugin install directories off-limits as workspace roots. |
| `DOTNET_ROOT` | `adapters/csharp-roslyn`, `native/roslyn-worker` | Primary root for `.NET` runtime and reference-pack discovery. |
| `CAUSORYN_ROSLYN_WORKER_DLL` | `adapters/csharp-roslyn` | Overrides path to compiled `Causoryn.RoslynWorker.dll`. |
| `CAUSORYN_PYTHON_WORKER_SCRIPT` | `adapters/python` | Overrides path to `native/python-worker/worker.py`. |
| `CAUSORYN_GO_WORKER_BIN` / `CAUSORYN_GO_WORKER_DIR` | `adapters/go` | Points to a precompiled Go worker binary or custom `native/go-worker` directory. |
| `CAUSORYN_RUST_WORKER_DIR` / `CAUSORYN_RUST_TARGET_DIR` / `CAUSORYN_CARGO_HOME` | `adapters/rust` | Configures Rust worker binary location, writable Cargo target cache (with `.sha256.json` integrity pinning), and Cargo home. |

---

## Related Documentation

- [5-Minute Quickstart Tutorial](tutorial-5-minutes.md) · [Documentation Hub](README.md)
- [Architecture Overview](architecture.md) · [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)
- [5-Language Analyzers](language-analyzers.md) · [MCP Tool Contracts](tool-contracts.md)
- [Host Setup Guides: Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
- [Security Audit](security-pass.md) · [Host Compatibility Matrix](compatibility-matrix.md)
