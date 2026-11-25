# CLI, Zero-Config Workspace Discovery & Configuration Reference

> **Language:** [Türkçe](../cli-and-configuration.md) | **English** · [Documentation Hub](README.md)
>
> **Status:** reflects Causoryn 0.3.0 (default `core` tool profile, one shared `graph.sqlite` per workspace; see [MCP Tool Contracts](tool-contracts.md) for the tools themselves).
>
> **Source modules:** `packages/causoryn/src/{cli.ts,setup.ts,doctor.ts,runtime-stage.ts,types.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs,verify-package-ready.mjs}`, `packages/mcp-server/src/{cli-stdio.ts,stdio.ts,runtime-cli.ts,config.ts,context.ts,workspace-ignore-discovery.ts}`, `packages/workspace/src/{policy-config.ts,path-safety.ts,ignore-matcher.ts,output-policy.ts}`.

This reference covers every `causoryn` CLI subcommand and flag, the MCP tool profiles, the pre-import Node.js `>= 24` guard, the version-pinned plugin launcher, workspace root discovery and the root-safety filter, the out-of-tree data directory, the strict `CAUSORYN_CONFIG` schema, every environment variable, and the output/logging policy.

---

## 1. CLI Subcommands & Flags (`causoryn`)

For quick setup and a read-only health check, use `@latest` (an exact pin such as `@0.3.0` also works and is recommended for CI):

```bash
npx causoryn@latest setup --yes        # register the MCP server + 5 skills for the hosts detected on this machine
npx causoryn@latest doctor             # read-only check of Node.js, runtime files, sidecar toolchains and host configs
# Exact pin: npx causoryn@0.3.0 setup --yes && npx causoryn@0.3.0 doctor
```

The `causoryn` binary (`packages/causoryn/scripts/causoryn.mjs`) exposes:

```text
causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--tool-profile <core|full|wiki|history>] [--output-schema <omit|full>]
causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all] [--all-detected] [--tool-profile <list>] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
causoryn --version
causoryn --help
```

`causoryn mcp` is handed straight to `dist/mcp-server.mjs`; `setup`, `doctor`, `--version` and `--help` run in `dist/index.js` (`runCli`). Unknown subcommands and unknown `setup`/`doctor` flags exit with code `2` and an `[causoryn] error: ...` line on `stderr`; `mcp` argument errors exit `2` with `[causoryn] CLI argument error: ...`.

### 1.1 `causoryn setup` — 4-Host Installer & Uninstaller

Registers (or removes) the `causoryn` MCP server entry and the 5 canonical skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`) for the 4 supported hosts (`antigravity`, `claude-code`, `codex`, `zcode`).

| Flag | Description |
|---|---|
| `--client <id>` | Target host. Repeatable (`--client claude-code --client codex`) or comma-separated (`--client=claude-code,zcode`). Only the 4 host IDs are accepted. Takes precedence over `--all` and detection. |
| `--all` | Configures all 4 hosts even if they are not detected. |
| `--all-detected` | Explicit alias of the default: targets the hosts detected on this machine (the behavior when neither `--client` nor `--all` is given). If no host is detected, `setup` writes **0 files**, prints guidance on `stderr` (name the host with `--client <id>`, or use `--all`), and exits `1`. |
| `--tool-profile <list>` | Writes `--tool-profile <list>` into every generated `causoryn mcp` entry: `core`, `full`, `wiki`, `history`, or a comma list such as `wiki,history` (validated; an invalid value exits `2`). Cannot be combined with `--uninstall`. Without this flag an existing entry keeps the `--tool-profile` it already has. |
| `--dry-run` | Lists the planned operations (`create`, `update`, `remove`, `noop`) and the runtime staging directory, if any, without writing or deleting anything. |
| `--yes`, `-y` | Applies changes without confirmation. Without `--yes`, an interactive TTY session is asked `Continue? [y/N]` on `stderr`; a non-interactive session with pending changes fails with `cli/confirmation-required` (exit `2`). |
| `--skill` / `--no-skill` | Installs (default) or skips the 5 skill directories (`SKILL.md`). With `--uninstall`, controls whether skills are removed. |
| `--uninstall` | Removes the `causoryn` MCP entry and the installed skills from the selected hosts. `~/.causoryn/runtime` is deleted once no remaining host configuration references it. |
| `--json` | Prints the `SetupResult` object as formatted JSON on `stdout`. |
| `--help`, `-h` | Prints usage and exits `0`. |

**Exit codes:** `0` when the run completes (including "no changes" and a declined prompt), `1` when no host was detected and none was named (nothing is changed), `2` for invalid arguments, malformed host configs (`cli/malformed-json`), symlinked targets or other I/O errors (`cli/io-error`), missing confirmation, or a failed runtime staging step.

#### Per-host detection, target paths & behavior

| Host (`--client`) | Detected when | MCP config file | Skills directory | Host-specific behavior |
|---|---|---|---|---|
| `antigravity` | `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json` exists (a bare `~/.gemini` from Gemini CLI is not enough) | `~/.gemini/config/mcp_config.json` (and `~/.gemini/antigravity/mcp_config.json` when present) | `~/.gemini/config/skills/` | Writes `mcpServers.causoryn` without a `type` field, for Antigravity's local MCP loader. |
| `claude-code` | `~/.claude.json` or `~/.claude` exists (or `$CLAUDE_CONFIG_DIR` / its `.claude.json`) | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`) | Writes `mcpServers.causoryn` with `type: "stdio"`. |
| `codex` | `$CODEX_HOME` (default `~/.codex`) or its `config.toml` exists | `$CODEX_HOME/config.toml` | `~/.agents/skills/` | Patches only the `[mcp_servers.causoryn]` table, keeping comments, other TOML sections, and the table's other keys and sub-tables. `startup_timeout_sec` is written as `30`; a user value of `30` or more is kept as written, and a lower or unusable value is raised to `30` (the setup output says so). |
| `zcode` | `~/.zcode` or `~/.zcode/cli/config.json` exists | `~/.zcode/cli/config.json` | `~/.zcode/skills/` | Writes `mcp.servers.causoryn` (`type: "stdio"`); when `mcp.servers` is created for the first time, existing servers from `~/.agents/mcp.json` are carried over. |

- **Generated server entry:** `command` is the absolute Node.js binary that ran `setup` (`process.execPath`), so desktop hosts with a reduced `PATH` still start it. `args` are `<runtime>/scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client <host>`, plus `--tool-profile <list>` when `setup --tool-profile <list>` is used; otherwise hosts start with the `core` profile unless `CAUSORYN_TOOL_PROFILE` or `CAUSORYN_CONFIG.toolProfile` is set for them.
- **Re-running `setup` keeps your edits to the Causoryn entry:** setup owns only `command`, `args` (in which your `--tool-profile` and `--output-schema` / `--output-schema-profile` arguments are kept), `type: "stdio"` in the Claude Code and ZCode JSON entries, and Codex `startup_timeout_sec` (see the table above). Every other key — `env`, `disabled`, `autoApprove`, `alwaysAllow`, `timeout`, and unknown keys — keeps its value and its position, and an entry that is already up to date is not rewritten. Pass `--tool-profile <list>` to change the profile.
- **Persistent runtime staging:** when `setup` runs from an ephemeral location (a path with an `_npx` or `.npx` segment, or inside `os.tmpdir()`), it copies the runtime into `~/.causoryn/.runtime-stage-<pid>-<timestamp>` and swaps it atomically into `~/.causoryn/runtime` (the previous copy is kept as `.runtime-prev-*` and restored on failure). Host configs then point at `~/.causoryn/runtime`, so they keep working after the npx cache is cleared.
- **Idempotent writes & original backup:** if the rendered file is byte-identical to the existing one, nothing is written and no backup is made (`noop`). The first real change writes `<file>.causoryn.backup` with your original content; that file is never overwritten. Later changes write a timestamped `<file>.causoryn.<timestamp>-<nonce>.backup`. Files are replaced through a temporary file and `rename`, keeping the existing permissions (new configs `0o600`, skills `0o644`).
- **Symlink protection (CWE-59):** if a target config, a backup path or a destination `SKILL.md` is a symbolic link, `setup` stops with `cli/io-error` (exit `2`) before writing.

### 1.2 `causoryn doctor` — Read-Only Health Check

`causoryn doctor` never creates, modifies or deletes files. Toolchain probes run with `cwd: os.tmpdir()`, so project-local files such as `.cargo/config.toml` or `global.json` in the current directory are not picked up.

| Flag | Description |
|---|---|
| `--client <id>` | Limits the host rows and the status evaluation to the given host(s). |
| `--json` | Prints the full `DoctorReport` JSON on `stdout`. |
| `--help`, `-h` | Prints usage and exits `0`. |

Checked subsystems:

1. **Node.js (`node`):** major version `>= 24`.
2. **Package runtime (`runtime`):** `dist/mcp-server.mjs`, the platform/arch/libc-matched `better-sqlite3` prebuild (`glibc` vs `linuxmusl`) under `dist/node_modules/better-sqlite3/prebuilds/`, `dist/typescript-lib/lib.es2022.full.d.ts`, the 4 `native/` worker sources, and a compiled `Causoryn.RoslynWorker.dll`; the staged `~/.causoryn/runtime` is checked too when it exists. (`dist/index-worker.mjs` is checked at build time by `scripts/verify-package-ready.mjs`, not by `doctor`.)
3. **Sidecar toolchains (`toolchains`):** `dotnet --list-runtimes` (a Microsoft.NETCore.App **10.x** runtime is required; the Roslyn worker targets `net10.0` and does not roll forward to another major version), `python3 --version` then `python --version` on POSIX, `python --version` on Windows (the same default command order as the Python adapter; minimum **3.10**), `go version` (minimum **1.26**), `cargo --version` (no pinned minimum), each with `shell: false`, a 5 s timeout and an allowlisted environment (`DOCTOR_PROBE_ENV_ALLOWLIST` plus `PYTHONIOENCODING=utf-8`). Each toolchain reports `status` (`ok`, `warn` or `absent`), `minimumVersion`, `version` and `mode` (`sidecar-ready` or `l0-l1-fallback`). `absent` (not installed) is informational: that language drops to file-level `L0`/`L1` analysis. `warn` (installed but below the minimum, unreadable version, or a probe that timed out or could not start) makes the report `DEGRADED`.
4. **Host alignment (`hosts`):** JSON/TOML syntax, presence of the `causoryn` entry, whether the configured entry script exists on disk (both bare `node` and absolute Node paths are accepted as `command`), and the 5 skills. Each host is `ok`, `warn` (MCP entry without all skills, or skills without the entry), `not-configured` or `error` (broken config or missing entry script).
5. **Legacy index files (`legacyIndexFiles`):** a read-only scan of `~/.causoryn/workspaces/*/` for per-host `graph-<client>.sqlite` files from releases before 0.3.0. Each file is listed with its `-wal`/`-shm` side files and whether the shared `graph.sqlite` already exists next to it (then it can be deleted). This check only warns: it does not change the overall status or the exit code, and `doctor` never deletes files.

**Overall status & exit codes:**

- `HEALTHY` (exit `0`): Node `>= 24`, runtime complete, at least one configured host, no host warnings or errors.
- `DEGRADED` (exit `1`): runtime is fine but a configured host reports `warn` (for example missing skills), or a sidecar toolchain reports `warn`.
- `NOT CONFIGURED` (exit `1`): runtime is fine but no host has Causoryn configured yet.
- `UNHEALTHY` (exit `1`): Node `< 24`, missing runtime files, or a host config `error`.
- Exit `2`: invalid CLI arguments.

### 1.3 `causoryn mcp` — MCP `stdio` Server

`scripts/causoryn.mjs mcp` sets `CAUSORYN_ASSET_ROOT` (if unset) and imports `dist/mcp-server.mjs` (built from `cli-stdio.ts`) without printing anything to `stdout`.

| Flag | Description |
|---|---|
| `--allow-cwd` | If no `--root` and no `CAUSORYN_CONFIG.allowRoots` are given, checks `process.cwd()` with `inspectProjectRootSafety` and binds it when safe. When it is unsafe, the server starts with `allowRoots: []` and binds the first safe MCP `roots/list` entry instead ([§3.4](#34-dynamic-mcp-rootslist-binding)). Takes no value. |
| `--root <path>` | Authorizes a workspace root explicitly. Repeatable; the first root is the indexed workspace. Relative paths are resolved against the current directory. Replaces `CAUSORYN_CONFIG.allowRoots` when given. UNC and Win32 device paths are rejected. |
| `--auto-data-dir` | Creates the workspace data directory `<base>/workspaces/<slug>-<hash12>/` outside the workspace and wires `storage.dataDbPath` and `wiki.dataDbPath` to its `graph.sqlite` and `output.allowedOutputDirs` to its `exports/` ([§4](#4-out-of-tree-data-directory-layout)). Takes no value. Applied when a root is bound — at startup, or later when `roots/list` supplies one. |
| `--data-dir <absPath>` | Base directory for `--auto-data-dir` (default `~/.causoryn`). Must be absolute, without NUL bytes, and not a UNC/device path. Implies `--auto-data-dir`. |
| `--client <id>` | Diagnostic host label (pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`), written to `build_leases.host_label` and log lines. It does not change any path: all hosts share the workspace's `graph.sqlite`. |
| `--tool-profile <list>` | Active MCP tool profile: `core` (default, 11 tools), `wiki` (+7), `history` (+2), a comma list such as `wiki,history` (20), or `full` (29 legacy + 3 consolidated = 32). Order of precedence: `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`. Every supplied value is validated, even one a higher-precedence source overrides; unknown names fail startup. |
| `--output-schema <omit\|full>` *(alias `--output-schema-profile`)* | Whether `tools/list` includes each tool's JSON `outputSchema`. Order of precedence: flag > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `omit`. The server validates every response envelope in both modes. |

**Flag syntax:** `--flag value` and `--flag=value` both work. Positional arguments, unknown flags, empty values, a value that is itself a known flag, and any argument containing a NUL byte are rejected.

**Startup exit codes:** `2` for CLI argument errors, invalid `CAUSORYN_TOOL_PROFILE` / `CAUSORYN_CONFIG.toolProfile` / `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` values, `CAUSORYN_CONFIG` that is not valid JSON, or a configuration that fails validation (`CausorynConfigError`, for example a data path inside the workspace); `1` if the stdio transport cannot start. All diagnostics go to `stderr`.

### 1.4 `causoryn --version` & `causoryn --help`

- `causoryn --version` (also `-v`, `version`): prints the package version (`0.3.0` for this release) and exits `0`.
- `causoryn --help` (also `-h`, `help`, or no arguments): prints the usage text above and exits `0`.

---

## 2. Pre-Import Node.js `>= 24` Guard & Plugin Launcher

### 2.1 `scripts/lib/node-version-guard.mjs` (`assertSupportedNodeVersion`)

Both `scripts/causoryn.mjs` and `scripts/plugin-mcp-launcher.mjs` run this dependency-free guard **before** importing any bundle or the native `better-sqlite3` addon. On Node.js `< 24` it writes `[causoryn] Unsupported Node.js version (...). Causoryn requires Node.js >= 24.` to `stderr`, writes nothing to `stdout`, and exits `2`. This keeps MCP stdio framing clean and avoids opaque native-addon load errors on old runtimes.

### 2.2 `scripts/plugin-mcp-launcher.mjs` & version pinning

Host plugin manifests (`.claude-plugin/plugin.json`, `.zcode-plugin/plugin.json`, `packages/causoryn/mcp_config.json`) start `scripts/plugin-mcp-launcher.mjs` with `node` directly instead of a nested `npx` process:

- Accepts `--expected-version <semver>` (or `--expected-version=<semver>`) and/or `CAUSORYN_EXPECTED_VERSION`; all other arguments are forwarded to the server.
- Exits `2` on `stderr` if the two pins disagree, if `package.json#name` is not `causoryn`, if `package.json#version` differs from the pin, or if `dist/mcp-server.mjs` is missing. This stops a stale cached plugin copy from running silently.
- Sets `CAUSORYN_ASSET_ROOT` to the package root when unset or blank and imports `dist/mcp-server.mjs`. An inherited value is kept only when it is an absolute path to an existing directory holding the same `causoryn` package version (its `package.json`) with a `native/` directory; anything else exits `2` with `[causoryn-launcher] CAUSORYN_ASSET_ROOT rejected …` on `stderr`.

---

## 3. Startup Modes, Workspace Discovery & Safety Model

### 3.1 Startup modes

| Mode | How it starts | Root source | Initial index |
|---|---|---|---|
| **Bare** | `node dist/mcp-server.mjs` with no arguments (or `packages/mcp-server/src/stdio.ts`) | `CAUSORYN_CONFIG.allowRoots` only; without it, `allowRoots: []` and a `stderr` note, so workspace tools return `WORKSPACE_NOT_AUTHORIZED` | If `autoIndex` is on and a root is set: reuses the published snapshot from `storage.dataDbPath` when one exists, otherwise indexes **synchronously before** the server connects. |
| **CLI activation** | Any `causoryn mcp ...` argument | `--root` / `CAUSORYN_CONFIG.allowRoots` > safe cwd with `--allow-cwd` > MCP `roots/list` with `--allow-cwd` > none | Deferred: started about 100 ms after MCP `initialized`, or on the first `causoryn_status` call, so `initialize` and `tools/list` return immediately. If the SQLite store already has a published snapshot, it is served at once and a background incremental refresh is queued. |

Both modes resolve their startup settings through the same resolver (`resolveMcpServerSettings`): tool profile `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`, output schema profile `--output-schema` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `omit`, and `CAUSORYN_INDEX_WAIT_MS`. Bare mode takes no flags, so only the environment and `CAUSORYN_CONFIG` apply.

### 3.2 Non-blocking indexing, warm reads & freshness

- **Worker thread:** index jobs run in a `worker_threads` worker (`dist/index-worker.mjs`) with an in-process async fallback, so the MCP event loop keeps answering while a large repository is analyzed.
- **Warm start:** with an existing `graph.sqlite`, `getLatestSnapshotMeta` reads snapshot metadata without loading the whole graph, the published snapshot is served immediately, and a background incremental refresh (reusing unchanged per-file facts from `file_facts`) picks up files edited while the server was not running. After later code changes, call `causoryn_status` with `action: "refresh"`.
- **Bounded wait:** snapshot-dependent tools wait up to `CAUSORYN_INDEX_WAIT_MS` (default `15000`, `0` = no wait) for the first index, then return a structured `{ indexing: true, status: "indexing", jobId, progress, retryAfterMs }` payload with `status: "partial"` instead of failing. Clients that send `_meta.progressToken` receive `notifications/progress`.
- **Stale reads:** while a re-index runs, responses carry a `stale=true` warning and serve the latest published snapshot.
- **SQLite settings:** WAL journal mode, `busy_timeout = 5000`, `page_size = 4096` set on new databases (SQLite's default page size; a configuration fact, not a security control). Causoryn opens only database files in its own data directory, never database or WAL files from an analyzed workspace.

### 3.3 `inspectProjectRootSafety` — rejected roots

Before any filesystem call, `isUncOrDevicePath` (`packages/workspace/src/path-safety.ts`) rejects `\\host\share`, `//host/share`, `\\?\...` and `\\.\...` paths, so a candidate root can never trigger an outbound SMB/NTLM connection. The remaining path is canonicalized with `realpathSync` (Win32 `\\?\` prefixes stripped) and rejected if it matches any rule below. Every candidate from `--allow-cwd` or `roots/list` goes through this check; explicit `--root` / `allowRoots` values are trusted as given (they are only checked for UNC/device form and, with `--auto-data-dir`, for being existing directories).

1. Empty, NUL-containing, unresolvable or non-directory paths.
2. Filesystem and drive roots (`/`, `C:\` and any other drive root).
3. The home directory (`$HOME` / `%USERPROFILE%`) **and every ancestor of it** (`/home`, `/Users`, `C:\Users` ...).
4. Causoryn data directories and their subdirectories: `~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`.
5. Plugin, bundle and install-cache directories: `~/.causoryn/runtime`, `~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, paths with `node_modules` or `_npx` segments, directories with plugin install markers such as `bundle-manifest.json`, and any directory inside a `causoryn` plugin installation (monorepo workspace roots are recognized and not rejected for this reason).
6. Sensitive user directories: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`.
7. System directories, including everything below them: `/etc`, `/private/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/bin`, `/sbin`, `/lib`, `/dev` on POSIX; `SystemRoot`, `WINDIR`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramData` and the fallbacks `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` on Windows.
8. Shared scratch roots, as exact matches only (project subdirectories inside them stay allowed): `os.tmpdir()`, and on POSIX `/tmp`, `/private/tmp`, `/var`, `/private/var`, `/var/tmp`, `/private/var/tmp`.

### 3.4 Dynamic MCP `roots/list` binding

With `--allow-cwd` and no explicit roots, `attachMcpRootsWorkspaceBinder` manages the root:

1. If the cwd is unsafe (typical for desktop IDEs that start servers in `$HOME`, `/` or a plugin folder), the server starts with `allowRoots: []` instead of failing.
2. On `oninitialized`, before the first tool call, and on every `notifications/roots/list_changed`, it runs a single-flight `roots/list` request (5,000 ms timeout) if the client advertises the `roots` capability.
3. The `file://` URIs are checked in order with `inspectProjectRootSafety`; the first safe directory is bound atomically through `DynamicCausorynContext.rebind()` (provisioning its data directory when `--auto-data-dir` is on and closing the previous SQLite handles).
4. If a later list contains no safe root, the server rebinds to `allowRoots: []`. A cwd that was bound at startup can also be replaced when the client sends `roots/list_changed`.

### 3.5 Ignore discovery & smart `bin/` handling

When the server builds its configuration from CLI flags (`buildWorkspaceAutoConfig` + `workspace-ignore-discovery.ts`), it merges ignore patterns from the primary root into `extraIgnore`, in this order:

1. The root `.gitignore` (at most 256 KB, read with `O_NOFOLLOW` and a `(dev, ino)` check, so symlinks are not followed).
2. `.git/info/exclude`, only if `.git` is a real directory (not a symlink).
3. Nested `.gitignore` files found by a bounded walk: depth ≤ 6, at most 64 files and 4,000 directories; each pattern is scoped to its own subdirectory; at most 1,000 discovered patterns in total. Negations are handled conservatively (broad directory patterns that could hide a negated file are left out).

If the caller does not pass its own `ignore` list, the blunt default `**/bin/**` is replaced by `.NET` output patterns (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` plus `<projectDir>/bin/**` for up to 128 `.csproj`/`.fsproj`/`.vbproj` projects found within depth 4), so Node `bin/*.ts|js` and Rust `src/bin/*.rs` sources stay indexed. Matching runs on a linear-time, regex-free glob matcher (`packages/workspace/src/ignore-matcher.ts`). See [Language Analyzers](language-analyzers.md).

---

## 4. Out-of-Tree Data Directory Layout

Causoryn never writes into the analyzed source tree. With `--auto-data-dir`, every MCP host that opens the same repository uses the same SQLite database (`graph.sqlite`, WAL mode). Single-writer coordination uses heartbeat leases in the `build_leases` table (`lease_id`, `owner_pid`, `host_label`, `hostname`, `owner_instance`, `heartbeat_at`, `expires_at`; default TTL 120 s, heartbeat every 10 s from the main thread and at phase boundaries), which prevents two concurrent publishers. On the same host a holder counts as alive while its PID is alive (the TTL is secondary); on another host only the TTL counts; a heartbeat older than 10 minutes (`CAUSORYN_LEASE_STALE_CEILING_MS`) always counts as dead. A run that finds a live holder waits for it (`waiting_for_peer`, up to `CAUSORYN_PEER_WAIT_TIMEOUT_MS`) and reuses its snapshot when the inputs match. `recoverOrphanBuilds` marks builds left in `building` state by a crashed process as recovered orphans.

```text
~/.causoryn/                                    # base dir for every host (override: --data-dir; ZCODE_PLUGIN_DATA only as a fallback)
├── runtime/                                    # persistent runtime staged by `setup` from an ephemeral npx cache
│   ├── package.json
│   ├── scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs}
│   ├── dist/{mcp-server.mjs,index-worker.mjs,index.js,bundle-manifest.json,node_modules/better-sqlite3,typescript-lib}
│   ├── native/{roslyn-worker,python-worker,go-worker,rust-worker}
│   └── skills/{causoryn,map-system,preflight-change,verify-change,architecture-blueprint}
├── workspaces/
│   └── <slug>-<hash12>/                        # mode 0o700 on POSIX
│       ├── graph.sqlite                        # storage.dataDbPath + wiki.dataDbPath: graph, file_facts, build_leases, symbol_fts, wiki store
│       ├── graph.schema-<N>.sqlite             # only when graph.sqlite has a newer schema than this build (never written by this build)
│       └── exports/                            # mode 0o700; output.allowedOutputDirs (e.g. causoryn-architecture-interactive.html)
└── cache/
    └── rust-worker-target/                     # writable Cargo target dir (CAUSORYN_RUST_TARGET_DIR) + causoryn-rust-worker.sha256.json pin
```

- **Base directory precedence** (`resolveBaseDataDir`): `--data-dir <absPath>` > `~/.causoryn`, the same for every host, so ZCode shares the index with the other hosts. `ZCODE_PLUGIN_DATA` is only a fallback, used when `~/.causoryn` cannot be created or written (an explicit `--data-dir` never falls back). `--data-dir` and `ZCODE_PLUGIN_DATA` must be absolute and must not be UNC/device paths; a set `ZCODE_PLUGIN_DATA` is validated even when it is not used.
- **Workspace folder name:** `<slug>` is the root's base name, lowercased, with characters outside `[a-z0-9._-]` replaced by `-`, trimmed of leading/trailing `.`, `_`, `-`, and cut to 48 characters (`workspace` if empty). `<hash12>` is the first 12 hex characters of the SHA-256 of the canonical root path. The slug is also the default `workspaceId`.
- **Shared database and legacy files:** earlier releases created one `graph-<client>.sqlite` per host. When `graph.sqlite` does not exist yet, the first start copies the newest valid legacy file into it once (each candidate is opened read-only and must pass `PRAGMA quick_check` with a supported `user_version`; the copy uses SQLite's online backup and is published without overwriting a file another process created first). Legacy files are left in place; `causoryn doctor` lists them so you can delete them. `--client` no longer changes the file name.
- **Newer-schema guard:** if `graph.sqlite` was stamped by a newer Causoryn schema than this build supports, this build never writes it and uses `graph.schema-<N>.sqlite` (N = its own schema version) instead, logging one `stderr` line.
- **Containment checks before and after `mkdir`:** before creating anything, every existing ancestor of the target is checked (`assertDataDirAncestorsSafe`, `assertNotSymlinkDirectory`, `assertStrictlyOutsideWorkspaceRoots`): symlinks (CWE-59; the macOS system firmlinks `/var`, `/tmp`, `/etc` are allowed), dangling links, non-directories, and any path that resolves inside an authorized root are rejected with `CausorynConfigError`. After creation, `realpathSync` re-checks containment against TOCTOU races.
- **`CAUSORYN_CONFIG` wins:** if `CAUSORYN_CONFIG` already sets `storage.dataDbPath`, `wiki.dataDbPath`, `output.allowedOutputDirs` or `workspaceId`, `--auto-data-dir` keeps those values and only fills the missing ones.
- **Retention:** each publish prunes old snapshots in the same transaction (`pruneOldSnapshots` keeps the newest 2 published snapshots and deletes orphan `symbol_fts` rows), then runs a passive WAL checkpoint. Snapshot IDs are a streaming SHA-256 over the canonical snapshot bytes, so they stay identical to the canonical form.
- **Without `--auto-data-dir`:** unless `CAUSORYN_CONFIG` declares the paths, the graph lives in an in-process `InMemoryGraphRepository` (lost on exit), exports return `EXPORT_NOT_ALLOWED`, and wiki tools are unavailable (`PATH_DENIED` / `INDEX_NOT_READY`).

---

## 5. Full `CAUSORYN_CONFIG` Schema

`CAUSORYN_CONFIG` is a JSON string parsed at startup and validated against `causorynServerConfigSchema` (`packages/mcp-server/src/config.ts`, which extends `workspacePolicyConfigSchema` from `packages/workspace/src/policy-config.ts`).

> **Strict schema:** both levels are `z.strictObject`, so unknown keys fail startup with `CausorynConfigError` (exit `2`). Use the exact key names: `extensionFilterMode` (not `extensionMode`), `index.maxFiles` (not a top-level `maxFiles`), `output.allowedOutputDirs` (not `outputAllowRoots`).

**Merging with CLI flags:** in CLI mode the JSON supplies the base values; `--root` replaces `allowRoots`; `--auto-data-dir` fills `workspaceId`, `storage.dataDbPath`, `wiki.dataDbPath` and `output.allowedOutputDirs` only where the JSON leaves them unset; discovered ignore patterns are appended to `extraIgnore`. A non-empty `allowRoots` in the JSON counts as an explicit root, so `--allow-cwd` and `roots/list` binding are then skipped.

### 5.1 Complete example

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
  },
  "toolProfile": "core"
}
```

### 5.2 Field reference

| Field | Type | Default | Validation & runtime behavior |
|---|---|---|---|
| `workspaceId` | `string` (min 1) | `"default"` (the `<slug>` under `--auto-data-dir`) | Opaque ID of the single authorized workspace; tool calls with a different `workspaceId` return `WORKSPACE_NOT_AUTHORIZED`. |
| `allowRoots` | `string[]` | `[]` | Absolute directory paths without NUL bytes (UNC/device paths are rejected in CLI mode). Empty = default deny (`WORKSPACE_NOT_AUTHORIZED`). `allowRoots[0]` is the indexed root. |
| `ignore` | `string[]` | 38 patterns (`DEFAULT_IGNORE_PATTERNS`) | `**/.git/**`, `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/dist/**`, `**/.env*`, `**/*.pem`, plus build, virtual-env and cache folders (`.next`, `.venv`, `__pycache__`, `target`, `coverage`, `vendor`, `Pods`, `.gradle`, `.vite`, ...) and `**/*.min.js` / `**/*.min.mjs`. Setting it replaces the defaults and disables the smart `bin/` refinement. |
| `extraIgnore` | `string[]` | `[]` | Added after `ignore` without replacing it; CLI-mode ignore discovery appends here. |
| `binaryExtensions` | `string[]` | 68 extensions (`DEFAULT_BINARY_EXTENSIONS`) | Lowercased denylist used in `blacklist` mode (images, archives, executables and libraries, `.pyc`, `.wasm`, `.sqlite`, `.db`, office files, `.map`, `.whl`, `.parquet`, `.onnx`, `.pt`, `.safetensors`, `.gguf`, ...). Each entry must match `^\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+$`. |
| `extensionFilterMode` | `"blacklist" \| "whitelist"` | `"blacklist"` | `blacklist` skips `binaryExtensions`; `whitelist` admits only `allowedExtensions`. |
| `allowedExtensions` | `string[]` | `[]` | Allowed extensions in `whitelist` mode (same format rule). |
| `maxFileBytes` | positive integer | `2000000` | Per-file size limit. Larger files are skipped by the indexer and rejected by the file policy (`workspace/limit-exceeded`); it also bounds policy/baseline file reads. |
| `index.maxFiles` | positive integer | `50000` | Maximum inventory size; exceeding it fails the index job with `LIMIT_EXCEEDED`. |
| `results.maxNodes` | positive integer | `250` | Page ceiling for `causoryn_map_system` (`maxNodes` above it → `LIMIT_EXCEEDED`) and the node cap for symbol context. |
| `results.maxSymbols` | positive integer | `100` | Ceiling and default for `causoryn_find_symbols` `limit`. |
| `results.maxDepth` | positive integer | `3` | Ceiling for symbol-context `depth` (above → `LIMIT_EXCEEDED`); execution traces are clamped to it. |
| `results.maxPaths` | positive integer | `50` | Ceiling to which execution-trace `maxPaths` is clamped. |
| `autoIndex` | `boolean` | `true` | Index (or reuse the stored snapshot) at startup when a root is set; deferred in CLI mode, synchronous in bare mode. `false` = tools return `INDEX_NOT_READY` until a refresh is requested. |
| `output.allowedOutputDirs` | `string[]` | `[]` | Existing directories (and their descendants) that `causoryn_export_documentation` may write to. They are resolved at startup; an unresolvable entry stops the server. Independent of `allowRoots`. Empty = `EXPORT_NOT_ALLOWED`. See [Prompting & Portals](prompting-and-architecture-portals.md). |
| `storage.dataDbPath` | optional `string` | unset (`InMemoryGraphRepository`) | SQLite file for the graph, `file_facts`, `build_leases` and `symbol_fts`. Must be absolute, without NUL bytes, with an existing parent directory, with a non-empty `allowRoots`, and strictly outside every root both lexically and after `realpath`; otherwise startup fails. Enables the shared-database lease coordination. |
| `wiki.dataDbPath` | optional `string` | unset (`causoryn_wiki_build` → `PATH_DENIED`, wiki reads → `INDEX_NOT_READY`) | SQLite file for the Living Wiki store (`wiki_fts`). Same checks as `storage.dataDbPath`; may be the same file. |
| `toolProfile` | optional `string` | unset | Tool profile used when neither `--tool-profile` nor `CAUSORYN_TOOL_PROFILE` is given (`core`, `full`, `wiki`, `history`, or a comma list). Validated by the same parser as the flag and the environment variable; an invalid value stops startup. Applies to `causoryn mcp`, the bare `stdio.ts` entry, and programmatic embedding. |

> **Programmatic sidecar options (`IndexServiceOptions`):** library callers that create `IndexService` directly can pass `csharp` (`dotnetCommand`, `requestTimeoutMs`, `workerDllPath`), `python` (`pythonCommand`, `requestTimeoutMs`, `workerScriptPath`), `go` (`goBinaryPath`, `goWorkerBinaryPath`, `workerDir`, `requestTimeoutMs`) and `rust` (`workerDir`, `cargoHomeDir`, `requestTimeoutMs`, `cargoBuildTimeoutMs`). In MCP server deployments, sidecar locations come from the environment variables below.

---

## 6. Environment Variables

| Variable | Read by | Purpose & default |
|---|---|---|
| `CAUSORYN_CONFIG` | `mcp-server` (`cli-stdio.ts`, `stdio.ts`) | JSON server configuration ([§5](#5-full-causoryn_config-schema)). Invalid JSON exits `2`. |
| `CAUSORYN_TOOL_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `core`, `wiki`, `history`, `full` or a comma list; used when `--tool-profile` is absent and takes precedence over `CAUSORYN_CONFIG.toolProfile` (default `core`). Invalid values fail startup. |
| `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `omit` (default) or `full`; used when `--output-schema` is absent. Invalid values fail startup. |
| `CAUSORYN_INDEX_WAIT_MS` | `mcp-server` (`runtime-cli.ts`) | Wait window for the first index in milliseconds (default `15000`; `0` returns the indexing status immediately; negative or non-numeric values fall back to the default). |
| `CAUSORYN_HISTORY_MAX_ANALYSES` | `mcp-server` (`history-commit-analysis.ts`) | How many commits one `causoryn_compare_architecture` / `causoryn_architecture_timeline` call may analyze fresh from their git objects (positive integer; defaults: compare `2`, timeline `4`; an invalid value is logged and ignored). Cached commits do not count; points over the budget report `analysis-budget-exceeded` and are analyzed on a later call. |
| `CAUSORYN_PEER_WAIT_TIMEOUT_MS` | `indexing` (`index-service.ts`) | How long an index run waits for a live peer that holds the build lease (default `900000` = 15 min; `0` disables waiting). On timeout the job ends `failed` with outcome `peer_busy` and the existing snapshot stays served. |
| `CAUSORYN_PEER_POLL_INTERVAL_MS` | `indexing` (`index-service.ts`) | Initial poll interval while waiting for a peer (default `100`; grows with exponential backoff). |
| `CAUSORYN_LEASE_STALE_CEILING_MS` | `indexing` (`index-service.ts`) | Hard staleness ceiling for lease heartbeats (default `600000` = 10 min); an older heartbeat counts as dead even when its PID is alive. |
| `CAUSORYN_EXPECTED_VERSION` | `plugin-mcp-launcher.mjs` | Exact package version the launcher must find (exit `2` on mismatch). |
| `CAUSORYN_ASSET_ROOT` | `sidecar-ipc`, `causoryn.mjs`, `plugin-mcp-launcher.mjs` | Root used to find `native/` sidecar assets; set to the package root by the launchers when unset. `plugin-mcp-launcher.mjs` accepts an inherited value only for the same `causoryn` version's package directory (section 2.2). |
| `CAUSORYN_TS_LIB_DIR` | `adapters/typescript` | Location of the bundled TypeScript `lib.*.d.ts` files (`lib.es2022.full.d.ts`). |
| `CLAUDE_CONFIG_DIR` | `causoryn` (`setup`, `doctor`) | Moves Claude Code config and skills to `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/skills/`. |
| `CODEX_HOME` | `causoryn` (`setup`, `doctor`) | Codex config directory (`$CODEX_HOME/config.toml`, default `~/.codex`). |
| `ZCODE_PLUGIN_DATA` | `mcp-server` (`runtime-cli.ts`) | Fallback base data directory for `--auto-data-dir`, used only when `~/.causoryn` cannot be created or written and `--data-dir` is absent; validated whenever it is set and never accepted as a project root. |
| `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` | host plugin loaders, `runtime-cli.ts` | Used by plugin manifests to locate the launcher; these directories are never accepted as project roots. |
| `DOTNET_ROOT` | `adapters/csharp-roslyn`, `native/roslyn-worker`, `indexing` | Primary root for the .NET runtime and the `Microsoft.NETCore.App.Ref` / `Microsoft.AspNetCore.App.Ref` reference packs. |
| `CAUSORYN_ROSLYN_WORKER_DLL` | `adapters/csharp-roslyn`, `indexing` | Path to a compiled `Causoryn.RoslynWorker.dll`. |
| `CAUSORYN_PYTHON_WORKER_SCRIPT` | `adapters/python`, `indexing` | Path to `native/python-worker/worker.py`. |
| `CAUSORYN_GO_WORKER_BIN` | `adapters/go`, `indexing` | Path to a prebuilt Go worker binary (skips `go run ./cmd/worker`). |
| `CAUSORYN_GO_WORKER_DIR` | `adapters/go`, `indexing` | Location of the `native/go-worker` module. At runtime the Go command is `go` from `PATH` (or `go.goBinaryPath` programmatically); `CAUSORYN_GO_BINARY` is only a helper for the Go adapter test suite. |
| `CAUSORYN_RUST_WORKER_DIR` | `adapters/rust`, `indexing` | Directory that holds a compiled `causoryn-rust-worker` binary. An explicitly configured directory is never built in place; if the binary is missing there, the Rust analyzer falls back to L0/L1. |
| `CAUSORYN_RUST_TARGET_DIR` | `adapters/rust` | Build cache for the on-demand `cargo build --locked` (default `~/.causoryn/cache/rust-worker-target`). The worker crate is copied into a staging directory there and built with `--target-dir` inside it; the built binary is pinned by `causoryn-rust-worker.sha256.json`. A cache directory inside the analyzed workspace is refused. |
| `CAUSORYN_CARGO_HOME` | `adapters/rust` | Directory prepended to the child `PATH` to find `cargo` (default `~/.cargo/bin`, validated as a safe command path). |

Every child process the MCP server starts (sidecars, `git`, `cargo`; on Windows `taskkill` from `System32`) is started from an absolute executable path resolved from `PATH` entries outside the analyzed workspace, with `shell: false` and a trusted working directory, and gets a reduced, hardened environment (for example `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off` for Go, `python -I -B -X utf8` for Python, an empty `DOTNET_STARTUP_HOOKS` for Roslyn, an empty `CARGO_BUILD_RUSTC_WRAPPER` for Cargo). The Python adapter (and `causoryn doctor`) tries `python3` and then `python` on POSIX and uses `python` on Windows; an explicitly configured `pythonCommand` is used as is. Details: [Security Pass](security-pass.md).

---

## 7. Output Channels & Logging Policy

- **`causoryn mcp`:** `stdout` carries only MCP JSON-RPC frames. Every log line, warning and startup diagnostic goes to `stderr` with a `[causoryn]` prefix. The Node guard and the launchers keep the same rule.
- **`setup` / `doctor`:** human-readable text (or JSON with `--json`) goes to `stdout`; confirmation prompts and errors go to `stderr`.
- **Tool responses:** each result carries the envelope as `structuredContent` and as JSON text. `--output-schema omit|full` only controls whether `tools/list` advertises the JSON `outputSchema`; the envelope is validated against the Zod schema in both modes.
- **Files:** exports are written only inside `output.allowedOutputDirs`, through a `.tmp` file and `rename`; the graph and wiki stores are written only to their declared SQLite files outside the workspace.

---

## 8. Examples

**Typical host entry written by `setup` (Claude Code, `~/.claude.json`):**

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/Users/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "claude-code"]
    }
  }
}
```

**Explicit root with the wiki and history tools:**

```bash
npx causoryn@0.3.0 mcp --root /work/orders-service --auto-data-dir --client ci --tool-profile wiki,history
```

**Full legacy catalog with published output schemas, via environment variables:**

```bash
CAUSORYN_TOOL_PROFILE=full CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full npx causoryn@0.3.0 mcp --allow-cwd --auto-data-dir
```

**Root from `CAUSORYN_CONFIG` with an in-memory graph (no data directory, no exports, no wiki):**

```bash
CAUSORYN_CONFIG='{"allowRoots":["/work/orders-service"]}' npx causoryn@0.3.0 mcp
```

**Root from `CAUSORYN_CONFIG` with persistence, exports and the wiki:**

```bash
CAUSORYN_CONFIG='{"allowRoots":["/work/orders-service"],"results":{"maxDepth":6}}' npx causoryn@0.3.0 mcp --auto-data-dir --tool-profile wiki
```

**Preview and remove:**

```bash
npx causoryn@latest setup --client codex --dry-run
npx causoryn@latest setup --uninstall --all --yes
npx causoryn@latest doctor --client claude-code --json
```

---

## Related Documentation

- [5-Minute Quickstart Tutorial](tutorial-5-minutes.md) · [Documentation Hub](README.md)
- [Architecture Overview](architecture.md) · [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)
- [Language Analyzers](language-analyzers.md) · [MCP Tool Contracts](tool-contracts.md)
- [Host Setup Guides: Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
- [Security Pass](security-pass.md) · [Compatibility Matrix](compatibility-matrix.md)
