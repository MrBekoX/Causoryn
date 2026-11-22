# CLI, Zero-Config Workspace Discovery & Configuration Reference

> **Language:** [Türkçe](../cli-and-configuration.md) | **English**
>
> **Evidence base:** `packages/causoryn/src/{cli.ts,setup.ts,doctor.ts,runtime-stage.ts,types.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs,verify-package-ready.mjs}`, `packages/mcp-server/src/{cli-stdio.ts,stdio.ts,runtime-cli.ts,config.ts,context.ts}`, `packages/workspace/src/policy-config.ts` (TS v2.1 §9, §10.1, §17, §20 · `ADR-008` · `K-021` · `K-022`).

This reference documents every `causoryn` (`v0.2.2` — Pre-1.0 Public Preview) CLI subcommand and flag, the pre-import Node.js `>= 24` runtime guard, the version-pinned plugin marketplace launcher, the zero-config workspace discovery and root-safety filter, the out-of-tree data directory layout, and the strict `CAUSORYN_CONFIG` JSON schema.

---

## 1. CLI Subcommands & Flags (`causoryn`)

The `causoryn` binary (`packages/causoryn/scripts/causoryn.mjs`) exposes the following commands:

```text
causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--output-schema-profile <full|omit>]
causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all-detected] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
causoryn --version
causoryn --help
```

### 1.1 `causoryn setup` — 4-Host Installer & Uninstaller

Configures or removes Causoryn MCP server entries and the 4 canonical workflow skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`) across all 4 supported hosts (`antigravity`, `claude-code`, `codex`, `zcode`) with atomic writes and automatic backups.

| Flag | Description |
|---|---|
| `--client <id>` | Target host identifier (`antigravity`, `claude-code`, `codex`, `zcode`). Repeatable (`--client claude-code --client codex`) or comma-separated (`--client=claude-code,zcode`). |
| `--all-detected` | Targets only hosts detected on the current machine. When neither `--client` nor `--all-detected` is passed, detected hosts are selected (falling back to all 4 hosts if none are detected yet). |
| `--dry-run` | Previews all planned operations (`create`, `update`, `remove`, `noop`) and any persistent runtime staging directory without writing or deleting any files. |
| `--yes`, `-y` | Applies changes without interactive confirmation. In interactive TTY sessions without `--yes`, confirmation is prompted over `stderr` (`[y/N]`). |
| `--skill` / `--no-skill` | Enables or disables installing/removing the 4 canonical `SKILL.md` directories (default: `--skill` enabled). |
| `--uninstall` | Cleanly removes the `causoryn` MCP server registration and installed skills from selected hosts; deletes `~/.causoryn/runtime` automatically once no remaining host configuration references it. |
| `--json` | Emits the structured `SetupResult` object as formatted JSON on `stdout`. |
| `--help`, `-h` | Prints CLI usage and exits with `0`. |

#### Per-Host Target Paths & Safety Guarantees

| Host (`--client`) | MCP Config File | Skills Directory | Host-Specific Behavior |
|---|---|---|---|
| `antigravity` | `~/.gemini/config/mcp_config.json` (+ `~/.gemini/antigravity/mcp_config.json` when present) | `~/.gemini/config/skills/` | Omits `type` inside `mcpServers.causoryn` for compatibility with Antigravity's local MCP loader. |
| `claude-code` | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`) | Writes `mcpServers.causoryn` with `type: "stdio"`. |
| `codex` | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | `~/.agents/skills/` | Upserts `[mcp_servers.causoryn]` with `startup_timeout_sec = 30` while preserving unrelated TOML sections. |
| `zcode` | `~/.zcode/cli/config.json` | `~/.zcode/skills/` | Writes `mcp.servers.causoryn` (`type: "stdio"`); when initializing `mcp.servers` for the first time, preserves any existing fallback servers from `~/.agents/mcp.json`. |

- **Atomic writes & backups:** Before modifying any existing host config file, `setup` writes an atomic `<file>.causoryn.backup` copy preserving file permissions (default `0o600` for configs, `0o644` for skills) and swaps the updated file in via temporary-file `renameSync`.
- **Symlink overwrite protection (`CWE-59`):** If a target config file, `.causoryn.backup` file, or destination `SKILL.md` is a symbolic link (`lstatSync().isSymbolicLink()`), `setup` aborts fail-closed with `cli/io-error` (exit code `2`).

### 1.2 `causoryn doctor` — Read-Only Health & Alignment Auditor

`causoryn doctor` is **100% read-only**: it never creates, modifies, or deletes any file or directory.

| Flag | Description |
|---|---|
| `--client <id>` | Restricts displayed host rows and host-error exit evaluation to the specified host(s) (`antigravity`, `claude-code`, `codex`, `zcode`). |
| `--json` | Outputs the complete `DoctorReport` JSON object to `stdout`. |
| `--help`, `-h` | Prints CLI usage and exits with `0`. |

Four audited subsystems:
1. **Node.js runtime (`node`):** Verifies Node.js major version `>= 24`.
2. **Package & staged runtime integrity (`runtime`):** Verifies `dist/mcp-server.mjs`, the OS/arch/libc-matched (`glibc` vs `linuxmusl`) `dist/node_modules/better-sqlite3/prebuilds/<target>-<arch>.node` binary, `dist/typescript-lib/lib.es2022.full.d.ts`, all 4 `native/` worker sources, and compiled `Causoryn.RoslynWorker.dll` (also verifying `~/.causoryn/runtime` when present).
3. **Sidecar toolchains (`toolchains`):** Probes `dotnet --version`, `python --version` (with POSIX fallback to `python3 --version`), `go version`, and `cargo --version` using `shell: false`, a 5 s timeout, and an allowlisted child environment (`DOCTOR_PROBE_ENV_ALLOWLIST` + `PYTHONIOENCODING=utf-8`). Missing optional toolchains report `l0-l1-fallback` without marking the server unhealthy.
4. **Host alignment (`hosts`):** Validates JSON/TOML syntax, checks whether the configured `causoryn` entrypoint exists on disk (`entrypointExists`), and checks all 4 skills (`ok`, `warn`, `not-configured`, `error`).

**Exit codes:** `0` = `healthy: true`, `1` = `healthy: false` (unsupported Node.js, missing core runtime artifact, or `error` on a targeted host), `2` = invalid CLI arguments.

### 1.3 `causoryn mcp` — Zero-Config MCP `stdio` Server

When invoked as `causoryn mcp`, `scripts/causoryn.mjs` hands off directly to `dist/mcp-server.mjs` (`cli-stdio.ts`) while writing **zero bytes** of banner or log text to `stdout`.

| Flag | Description |
|---|---|
| `--allow-cwd` | Evaluates `process.cwd()` via `inspectProjectRootSafety` when no explicit `--root` or `CAUSORYN_CONFIG.allowRoots` is supplied; if `cwd` is unsafe, enables dynamic MCP `roots/list` workspace binding. |
| `--root <path>` | Explicitly authorizes a workspace root directory (repeatable; overrides `CAUSORYN_CONFIG.allowRoots`). |
| `--auto-data-dir` | Automatically provisions an isolated out-of-tree workspace data directory for SQLite (`storage.dataDbPath` + `wiki.dataDbPath`) and exports (`output.allowedOutputDirs`). |
| `--data-dir <absPath>` | Overrides the base directory used by `--auto-data-dir` (defaults to `~/.causoryn`; must be absolute; implicitly enables `--auto-data-dir`). |
| `--client <id>` | Namespaces the SQLite database file per host (`graph-<client>.sqlite`; validated against `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`). |
| `--output-schema-profile <full\|omit>` | Controls per-tool JSON `outputSchema` advertisement in `tools/list`. Precedence: `--output-schema-profile` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > (`hasCliActivation ? "omit" : "full"`). `"omit"` reduces `tools/list` context-window overhead in host agents while keeping server-side envelope validation intact. |

### 1.4 `causoryn --version` & `causoryn --help`

- `causoryn --version` (`-v`, `version`): Prints `0.2.2` to `stdout` and exits `0`.
- `causoryn --help` (`-h`, `help`, or bare `causoryn` with no arguments): Prints usage help to `stdout` and exits `0`.

---

## 2. Pre-Import Node.js `>= 24` Guard & Plugin Launcher

### 2.1 `node-version-guard.mjs` (`assertSupportedNodeVersion`)

Both `scripts/causoryn.mjs` and `scripts/plugin-mcp-launcher.mjs` execute the zero-dependency guard in `scripts/lib/node-version-guard.mjs` **before** importing any compiled bundle or native `better-sqlite3` addon:
- On Node.js `< 24`, the process writes a clear diagnostic exclusively to `stderr` (`Unsupported Node.js version ... Causoryn requires Node.js >= 24.`), emits **zero bytes on `stdout`**, and exits with code **`2`**.
- This preserves strict MCP JSON-RPC `stdio` framing and prevents cryptic N-API loader failures on older Node runtimes.

### 2.2 `plugin-mcp-launcher.mjs` & Version Pinning

Host marketplace manifests (`.claude-plugin/plugin.json`, `.zcode-plugin/plugin.json`, `packages/causoryn/mcp_config.json`) invoke `scripts/plugin-mcp-launcher.mjs` directly via `node` rather than spawning nested `npx` subprocesses:
- Accepts `--expected-version <semver>` and/or `CAUSORYN_EXPECTED_VERSION`.
- Fails closed (`exit 2` on `stderr`) if both are set to conflicting values, if `package.json#name !== "causoryn"`, or if `package.json#version` does not match the pinned version — preventing stale cached plugin copies from running silently.
- Sets `CAUSORYN_ASSET_ROOT` to the package root when unset and imports `dist/mcp-server.mjs` directly.

---

## 3. Zero-Config Workspace Discovery & Safety Model

### 3.1 Bare `stdio` vs CLI Activation

- **Bare invocation (`node dist/mcp-server.mjs` with 0 CLI args):** Preserves strict default-deny (`allowRoots: []`) and `outputSchemaProfile: "full"`. Unless `CAUSORYN_CONFIG` declares `allowRoots`, workspace tools return `WORKSPACE_NOT_AUTHORIZED`.
- **Zero-config invocation (`causoryn mcp --allow-cwd --auto-data-dir`):** Evaluates candidate workspace roots through `inspectProjectRootSafety`.

### 3.2 `inspectProjectRootSafety` — Rejected Unsafe Roots

Every candidate path (from `process.cwd()` or an MCP `roots/list` `file://` URI) is canonicalized via `realpathSync` (stripping Win32 `\\?\` device prefixes) and **rejected fail-closed** if it matches any of the following rules:

1. **Empty, null-byte (`\0`), unresolvable, or non-directory paths.**
2. **Filesystem roots:** `/`, `C:\`, etc. (`path.parse(real).root === real`).
3. **User home directory (`$HOME` / `%USERPROFILE%`):** Prevents accidental indexing of an entire user profile when a desktop IDE spawns MCP servers from `$HOME`.
4. **Causoryn data directories & subdirectories:** `~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`.
5. **Plugin, bundle & ephemeral cache directories:** `~/.causoryn/runtime`, `~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, any path containing `node_modules` or `_npx` segments, and non-monorepo directories containing `bundle-manifest.json` or a `causoryn` plugin manifest.
6. **Sensitive user credential/config directories:** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`.
7. **Operating system directories:** `/etc`, `/private/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root` on POSIX; `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` (plus `SystemRoot`, `WINDIR`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramData` environment targets) on Windows.

### 3.3 Dynamic MCP `roots/list` Binding for Desktop IDEs

When launched with `--allow-cwd` (and no explicit `--root` or `CAUSORYN_CONFIG.allowRoots`) from an unsafe `cwd` such as `$HOME` or a plugin install directory, `attachMcpRootsWorkspaceBinder` manages dynamic binding:

1. The server boots safely with `allowRoots: []` instead of crashing.
2. On `oninitialized`, before the first tool invocation (`beforeToolCall`), and whenever the client emits `notifications/roots/list_changed`, Causoryn runs a single-flight `server.listRoots()` query (default 5,000 ms timeout).
3. Candidate `file://` URIs are checked in order via `inspectProjectRootSafety`; the **first safe project directory** is bound atomically via `DynamicCausorynContext.rebind()` (provisioning its out-of-tree data directory when `--auto-data-dir` is active and closing any previous SQLite handles).
4. If a subsequent `roots/list` update contains no safe roots, Causoryn rebinds cleanly back to `allowRoots: []`.

---

## 4. Out-of-Tree Data Directory Layout (`ADR-008`)

Causoryn **never** writes a single byte into the analyzed repository source tree. All SQLite databases, exports, staged runtimes, and Cargo build artifacts live strictly outside authorized workspaces:

```text
~/.causoryn/                                    # Base dir (overridable via --data-dir or ZCODE_PLUGIN_DATA)
├── runtime/                                    # Persistent runtime staged atomically from ephemeral _npx caches
│   ├── package.json
│   ├── scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs}
│   ├── dist/{mcp-server.mjs,bundle-manifest.json,node_modules/better-sqlite3,typescript-lib}
│   ├── native/{roslyn-worker,python-worker,go-worker,rust-worker}
│   └── skills/{causoryn,map-system,preflight-change,verify-change}
├── workspaces/
│   └── <slug>-<hash12>/                        # POSIX mode 0o700 (basename slug + first 12 hex of canonical SHA-256)
│       ├── graph-<client>.sqlite               # storage.dataDbPath + wiki.dataDbPath (graph.sqlite when --client omitted)
│       └── exports/                            # POSIX mode 0o700 (wired into output.allowedOutputDirs)
└── cache/
    └── rust-worker-target/                     # Writable Rust sidecar target cache (CAUSORYN_RUST_TARGET_DIR)
```

- **Base data directory precedence (`resolveBaseDataDir`):** `--data-dir <abs-path>` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`.
- **Pre-mkdir & post-mkdir symlink/containment guards:** Before calling `mkdirSync`, Causoryn walks every ancestor prefix (`assertDataDirAncestorsSafe`, `assertNotSymlinkDirectory`, `assertStrictlyOutsideWorkspaceRoots`) to reject symlinks (`CWE-59`, allowing macOS system firmlinks `/var`, `/tmp`, `/etc`), dangling links, and any path resolving inside `allowRoots`. After directory creation, `realpathSync` re-verifies containment against TOCTOU races.
- **Persistent runtime staging (`stagePersistentRuntime`):** When `npx causoryn@0.2.2 setup` executes from an ephemeral `_npx`, `.npx`, or `os.tmpdir()` cache, it copies the runtime into `~/.causoryn/.runtime-stage-<pid>-<ts>` and atomically swaps it into `~/.causoryn/runtime` (rolling back `.runtime-prev-*` on failure) so host MCP configurations survive `_npx` cache eviction.

---

## 5. Full `CAUSORYN_CONFIG` JSON Schema

`CAUSORYN_CONFIG` is parsed as JSON and validated against `causorynServerConfigSchema` (`z.strictObject`).

> **Strict schema note (`z.strictObject`):** Unknown keys are rejected fail-closed at startup (`CausorynConfigError`). Always use the exact schema keys — for example, `extensionFilterMode` (not `extensionMode`), `index.maxFiles` (not top-level `maxFiles`), and `output.allowedOutputDirs` (not `outputAllowRoots`).

### 5.1 Complete Configuration Example

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

### 5.2 Configuration Field Reference

| Field | Type | Default | Validation & Runtime Semantics |
|---|---|---|---|
| `workspaceId` | `string` (`min(1)`) | `"default"` (`<slug>` under `--auto-data-dir`) | Opaque identifier for the server's authorized workspace. |
| `allowRoots` | `string[]` | `[]` | Absolute directory paths (no `\0` bytes). Empty array = default-deny (`WORKSPACE_NOT_AUTHORIZED`). `allowRoots[0]` is the indexed workspace root. |
| `ignore` | `string[]` | 7 patterns (`DEFAULT_IGNORE_PATTERNS`) | `**/.git/**`, `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/dist/**`, `**/.env*`, `**/*.pem`. |
| `extraIgnore` | `string[]` | `[]` | Additional ignore globs appended after `ignore` without replacing the defaults. |
| `binaryExtensions` | `string[]` | 45 binary extensions (`DEFAULT_BINARY_EXTENSIONS`) | Lowercased binary extension denylist (`.png`, `.pdf`, `.zip`, `.exe`, `.dll`, `.so`, `.dylib`, `.pyc`, `.wasm`, `.sqlite`, `.db`, etc.). |
| `extensionFilterMode` | `"blacklist" \| "whitelist"` | `"blacklist"` | `"blacklist"` skips `binaryExtensions`; `"whitelist"` admits only files matching `allowedExtensions`. |
| `allowedExtensions` | `string[]` | `[]` | Permitted extensions when `extensionFilterMode === "whitelist"` (`^\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+$`). |
| `maxFileBytes` | `number` (positive int) | `2_000_000` (2 MB) | Per-file byte ceiling; oversized files trigger `LIMIT_EXCEEDED`. |
| `index.maxFiles` | `number` (positive int) | `50_000` | Maximum number of inventory files permitted per workspace. |
| `results.maxNodes` | `number` (positive int) | `250` | Maximum nodes per page in `causoryn_map_system`. |
| `results.maxSymbols` | `number` (positive int) | `100` | Maximum symbols returned by `causoryn_find_symbols`. |
| `results.maxDepth` | `number` (positive int) | `3` | Maximum neighborhood traversal depth in `causoryn_get_symbol_context`. |
| `results.maxPaths` | `number` (positive int) | `50` | Maximum execution paths returned by `causoryn_trace_execution`. |
| `autoIndex` | `boolean` | `true` | When `true` and `allowRoots` is non-empty, loads an existing published SQLite snapshot or runs initial synchronous indexing at startup; when `false`, tools return `INDEX_NOT_READY` until `causoryn_refresh_index` runs. |
| `output.allowedOutputDirs` | `string[]` | `[]` | Permitted directories for `causoryn_export_documentation`. Empty = `EXPORT_NOT_ALLOWED`. Declared directories must exist on disk at startup (`OutputAccessPolicy`). |
| `storage.dataDbPath` | `string` (optional) | `undefined` (`InMemoryGraphRepository`) | Persistent SQLite graph + `symbol_fts` database path. Must be absolute, have an existing parent directory, and resolve strictly outside all `allowRoots` both lexically and via `realpathSync` (`ADR-008`). Enables `tolerateConcurrentPublishRace`. |
| `wiki.dataDbPath` | `string` (optional) | `undefined` (`PATH_DENIED` / `INDEX_NOT_READY`) | Persistent Living Wiki SQLite (`SqliteWikiStore` + `wiki_fts`) database path. Subject to the same `ADR-008` containment checks as `storage.dataDbPath` and may share the same SQLite file. |

> **Programmatic Sidecar Options (`IndexServiceOptions`):** Library callers instantiating `IndexService` directly can pass `csharp` (`dotnetCommand`, `requestTimeoutMs`, `workerDllPath`), `python` (`pythonCommand`, `requestTimeoutMs`, `workerScriptPath`), `go` (`goBinaryPath`, `goWorkerBinaryPath`, `workerDir`, `requestTimeoutMs`), and `rust` (`workerDir`, `cargoHomeDir`, `requestTimeoutMs`, `cargoBuildTimeoutMs`). In MCP server deployments, sidecar paths are configured via the environment variables below.

---

## 6. Environment Variables Reference

| Environment Variable | Consuming Layer | Purpose & Default Behavior |
|---|---|---|
| `CAUSORYN_CONFIG` | `mcp-server` (`stdio.ts`, `cli-stdio.ts`) | JSON server configuration string. When combined with CLI flags, supplies base settings while `--root` and `--auto-data-dir` populate/override workspace and storage paths. |
| `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `full` or `omit`. Sets the `tools/list` output schema profile when `--output-schema-profile` is not passed. |
| `CAUSORYN_EXPECTED_VERSION` | `plugin-mcp-launcher.mjs` | Pins the exact `causoryn` package SemVer expected by a host plugin launcher (`exit 2` on mismatch). |
| `CAUSORYN_ASSET_ROOT` | `sidecar-ipc`, `causoryn.mjs`, `plugin-mcp-launcher.mjs` | Overrides root directory discovery for `native/` sidecar worker assets. |
| `CAUSORYN_TS_LIB_DIR` | `adapters/typescript` | Overrides discovery of bundled TypeScript `lib.*.d.ts` (`lib.es2022.full.d.ts`) declaration files. |
| `CLAUDE_CONFIG_DIR` | `causoryn` (`setup`, `doctor`) | Redirects Claude Code configuration and skills to `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/skills/`. |
| `CODEX_HOME` | `causoryn` (`setup`, `doctor`) | Redirects Codex configuration to `$CODEX_HOME/config.toml` (default `~/.codex`). |
| `ZCODE_PLUGIN_DATA` | `mcp-server` (`runtime-cli.ts`) | Base data directory for `--auto-data-dir` when `--data-dir` is omitted; also excluded from safe project roots by `inspectProjectRootSafety`. |
| `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` | Host plugin loaders & `runtime-cli.ts` | Resolves plugin launcher script paths in marketplace manifests and marks plugin install directories off-limits as project roots. |
| `DOTNET_ROOT` | `adapters/csharp-roslyn`, `native/roslyn-worker`, `indexing` | Primary root for `.NET` runtime and `Microsoft.NETCore.App.Ref` / `Microsoft.AspNetCore.App.Ref` pack discovery (`fp2` `refsrc=env-dotnet-root`). |
| `CAUSORYN_ROSLYN_WORKER_DLL` | `adapters/csharp-roslyn`, `indexing` | Overrides the path to compiled `Causoryn.RoslynWorker.dll`. |
| `CAUSORYN_PYTHON_WORKER_SCRIPT` | `adapters/python`, `indexing` | Overrides the path to `native/python-worker/worker.py`. |
| `CAUSORYN_GO_WORKER_BIN` | `adapters/go`, `indexing` | Path to a precompiled Go worker binary (bypasses `go run ./cmd/worker`). |
| `CAUSORYN_GO_WORKER_DIR` | `adapters/go`, `indexing` | Overrides the `native/go-worker` module directory. *(Note: At runtime the `go` compiler command resolves `"go"` via `PATH` or programmatic `go.goBinaryPath`; `CAUSORYN_GO_BINARY` is a test-suite helper variable used by Go adapter tests to point to custom Go installations.)* |
| `CAUSORYN_RUST_WORKER_DIR` | `adapters/rust`, `indexing` | Overrides the directory containing the compiled `causoryn-rust-worker` binary. |
| `CAUSORYN_RUST_TARGET_DIR` | `adapters/rust` | Overrides the writable `CARGO_TARGET_DIR` used by on-demand `cargo build --locked` (default `~/.causoryn/cache/rust-worker-target`). |
| `CAUSORYN_CARGO_HOME` | `adapters/rust` | Overrides the directory prepended to child `PATH` to locate `cargo` (default `~/.cargo/bin`, validated by `isSafeCommandPath`). |

---

## Related Documentation

- [Documentation Hub](README.md) · [Architecture Overview](architecture.md)
- [5-Language Analyzers & Sidecar Protocol](language-analyzers.md) · [MCP Tool Contracts](tool-contracts.md)
- [Host Setup Guides: Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
- [Security Audit](security-pass.md) · [Host Compatibility Matrix](compatibility-matrix.md)
