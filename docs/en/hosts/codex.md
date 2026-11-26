# Connecting Causoryn to Codex CLI (`stdio` MCP)

> **Language:** [Türkçe](../../hosts/codex.md) | **English** · [Documentation Hub](../README.md) · [Compatibility Matrix](../compatibility-matrix.md)

> **Status:** reflects Causoryn 0.3.2 (default `core` tool profile with 11 tools; one shared per-workspace `graph.sqlite` for all hosts). See [CLI & Configuration](../cli-and-configuration.md) for the full flag reference and [MCP Tool Contracts](../tool-contracts.md) for the tool catalog.

> **Sources checked for this page:** `packages/causoryn/src/{setup.ts,toml-patch.ts,doctor.ts,cli.ts}`, `packages/causoryn/.codex-plugin/{plugin.json,mcp.json}`, `.agents/plugins/marketplace.json`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`.

Causoryn is a local, deterministic MCP server for code intelligence. It makes no LLM or network API calls. Unlike Claude Code, `codex mcp add` **has no project or local scope**: registrations go to the user-wide `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Use a dedicated name such as `causoryn-smoke` for temporary smoke runs and clean up with `codex mcp remove`.

## Verification record

Live Codex CLI runs (all on builds **before 0.3.0**; a live re-run against 0.3.0 is not recorded yet):

| Date | Codex CLI | What was executed | Result |
|---|---|---|---|
| `2026-11-08` | `codex-cli 0.163.0` | `codex mcp --help`, `codex mcp add --help`, `codex mcp list --help`, `codex mcp remove --help`; manual `stdout` check on `causoryn@0.1.0` | Syntax confirmed; `stdout` carried 2 pure JSON-RPC lines (`initialize`, `tools/list` with the 29-tool catalog of that release) |
| `2026-11-10` | `codex-cli 0.163.0` | `codex mcp add causoryn-smoke` → `codex mcp list` (present) → `codex mcp remove` → `codex mcp list` (absent), monorepo bundle | Lifecycle confirmed; `config.toml` restored from backup afterwards (see the re-serialization note in section 5.5) |
| `2026-11-19` | `codex-cli 0.169.0` | `codex plugin marketplace add` (root `.agents/plugins/marketplace.json`), `codex mcp add` / `codex mcp list`, packaged `causoryn setup` | Marketplace accepted; registration listed |

Automated coverage of the 0.3.0 code paths used on this page: `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts` (isolated temporary `$HOME`, TOML patching), `tests/open-source-distribution.test.ts` (packed `.tgz` handshake and manifest parity), and `tests/mcp-tool-surface-budget.test.ts` (core `tools/list` size).

## Choose an installation path

| Path | Who it is for | What runs |
|---|---|---|
| **A. `npx causoryn@0.3.2 setup`** (recommended) | End users | Packaged entrypoint `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client codex`, registered in `config.toml` with the absolute Node binary |
| **B. Codex plugin marketplace** | End users who prefer plugins | `node --input-type=module --eval <bootstrap> -- --expected-version 0.3.2 --allow-cwd …` from `.codex-plugin/mcp.json`; the bootstrap loads the launcher from Codex's plugin cache under `CODEX_HOME` |
| **C. Manual registration** (`codex mcp add` or `config.toml`) | Contributors working from a source checkout | Monorepo bundle `packages/mcp-server/dist/mcp-server.mjs` (configured only through `CAUSORYN_CONFIG`) |

---

## 1. Option A — One-command setup

```bash
# Preview the planned changes without writing anything
npx causoryn@0.3.2 setup --client codex --dry-run

# Patch [mcp_servers.causoryn] in $CODEX_HOME/config.toml and install the 5 skills into ~/.agents/skills/
npx causoryn@0.3.2 setup --client codex --yes

# Read-only health and alignment check
npx causoryn@0.3.2 doctor --client codex

# Clean removal ([mcp_servers.causoryn] and its sub-tables + the 5 Causoryn skills)
npx causoryn@0.3.2 setup --client codex --uninstall --yes
```

### What `setup --client codex` writes

`setup` writes exactly this table (`renderCausorynSections` in `packages/causoryn/src/toml-patch.ts`):

```toml
[mcp_servers.causoryn]
command = "/path/to/node"
args = ["/home/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "codex"]
startup_timeout_sec = 30
```

- **Target file:** `$CODEX_HOME/config.toml` when `CODEX_HOME` is set, otherwise `~/.codex/config.toml` (`resolveEffectiveCodexHomeDir`). `doctor` reads the same file. Codex counts as detected when that directory or file exists.
- **Surgical TOML patching:** unlike `codex mcp add`, `setup` does not re-serialize the file. Comments, top-level keys, neighbouring `[mcp_servers.<other>]` tables, and `[mcp_servers.causoryn.tools.*]` approval sub-tables are kept unchanged (only runs of blank lines between tables are normalized), and the file's line-ending style (`\n` or `\r\n`) is preserved. Inside `[mcp_servers.causoryn]`, setup updates only `command`, `args` (keeping your `--tool-profile` and `--output-schema` arguments) and `startup_timeout_sec`; every other key and the `[mcp_servers.causoryn.env]` table keep their values and positions, and an up-to-date table is not rewritten.
- **`startup_timeout_sec = 30`** gives cold Node.js + SQLite start-up enough headroom. A value of `30` or more that you set is kept as written; a lower or unusable value is raised to `30`, and the setup output says so.
- **Absolute Node binary:** `command` is the `process.execPath` of the Node.js that ran `setup` (Node.js ≥ 24 is required).
- **Persistent runtime:** when `setup` runs from an `_npx` cache or the OS temp directory, it first copies the package to `~/.causoryn/runtime` and points `args[0]` there, so the registration survives `npx` cache eviction.
- **Skills:** the five canonical skills `causoryn`, `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` are written to `~/.agents/skills/<name>/SKILL.md` (in your home directory, not under `CODEX_HOME`). Pass `--no-skill` to skip them. `architecture-blueprint` guides Codex in drafting optional `annotations` from MCP evidence; to export without annotations, call `causoryn_export_documentation` directly ([architecture export contract](../tool-contracts.md)). Skills are guidance text for the host model: a tool a skill mentions can only be called if the active tool profile registers it. An existing `SKILL.md` that setup cannot prove Causoryn installed (your own skill with the same name, or a Causoryn skill you edited) is kept and reported as `skipped skill …`; the install record is `~/.causoryn/installed-skills.json` ([CLI & Configuration](../cli-and-configuration.md)).

### How `setup` behaves (all hosts)

- **Detection:** without `--client` or `--all`, only detected hosts are configured; if none is detected, nothing is written and `setup` exits `1` with guidance on `stderr`.
- **Confirmation:** without `--yes` (and without `--dry-run`), an interactive terminal shows the plan and asks `Continue? [y/N]`; a non-interactive shell stops with a "confirmation required" error and writes nothing.
- **Backups:** before an existing `config.toml` is modified for the first time, the original is copied to `config.toml.causoryn.backup`. That file is never overwritten; later modifications create additional `config.toml.causoryn.<timestamp>-<nonce>.backup` copies.
- **Atomic, idempotent writes:** temporary file + rename, existing file mode kept (new files `0600`); an identical second run reports `noop`.
- **Fail-closed parsing:** malformed TOML (unclosed strings, arrays, or tables, a line without `=`, an empty table header, or a duplicated table header such as two `[mcp_servers.causoryn]` tables) stops the run with `cli/malformed-toml` before anything is written. Symbolic-link targets are refused.
- **Exit codes:** `setup` exits `0` on success, `1` when no host was detected and none was named, and `2` on any error.
- **Uninstall:** removes `[mcp_servers.causoryn]` and every `[mcp_servers.causoryn.*]` sub-table, the Causoryn skills whose ownership is proven (an edited or foreign `SKILL.md` is kept and reported), and `~/.causoryn/runtime` when no other host config still references it.

### `doctor` checks

`causoryn doctor` is read-only. It checks Node.js ≥ 24, the runtime files in the package root and in `~/.causoryn/runtime`, the `dotnet` / `python` / `go` / `cargo` toolchains (a missing one is reported as `l0-l1-fallback`: that language falls back to file-level analysis), and each host. For Codex it validates the TOML structure, reads `[mcp_servers.causoryn]`, checks that the entry script exists when `command` is a Node binary, and checks the five skills. Host status is `OK`, `WARN`, `NOT-CONFIGURED`, or `ERROR`; the overall result is `HEALTHY`, `DEGRADED`, `NOT CONFIGURED`, or `UNHEALTHY`, and `doctor` exits `0` only for `HEALTHY` (otherwise `1`).

## 2. Option B — Native Codex plugin marketplace

The root `.agents/plugins/marketplace.json` follows the Codex plugin marketplace schema:

- `source: { "source": "npm", "package": "causoryn", "version": "0.3.2" }`
- `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"`. Causoryn needs no credentials or API keys; `"ON_INSTALL"` satisfies the marketplace policy schema for install-time confirmation.

The installed package's `.codex-plugin/plugin.json` ships the skills (`"skills": "./skills"`) and points `mcpServers` at `./.codex-plugin/mcp.json`:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "--input-type=module",
        "--eval",
        "<bootstrap: see below>",
        "--",
        "--expected-version",
        "0.3.2",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "codex"
      ],
      "env": {
        "NoDefaultCurrentDirectoryInExePath": "1"
      },
      "env_vars": [
        "CODEX_HOME"
      ],
      "startup_timeout_sec": 30
    }
  }
}
```

The manifest has no `cwd`, so Codex starts the server in the session (project) directory and `--allow-cwd` binds the project after its usual safety check. Codex starts the process with a cleared environment that holds its default variables, `CODEX_HOME` (`env_vars`) and the manifest's `env` map, which is applied last. That map sets `NoDefaultCurrentDirectoryInExePath`, so `cmd.exe` (when `PATH` leads to a `.cmd` / `.bat` shim that starts `node` by name) and the server's child processes do not search the current directory for a command. The bare `node` is resolved by Codex from `PATH` only (it does not search the current directory for a command name without a separator), and Node reads no `node.config.json`, `.env` or `package.json` for `--eval` without explicit flags. The inline bootstrap (the full text is in `.codex-plugin/mcp.json`) imports only `node:` built-ins. It stops with exit code `2` and a `[causoryn-codex] …` line on `stderr` when the running `node` binary lies inside the workspace; when a `PATH` entry before the one that supplies `node` is empty or not an absolute local path (on Windows also a drive-relative entry such as `C:tools`, or a UNC or device path); when `--expected-version` is missing or invalid; when `CODEX_HOME` is not absolute; when the cache path passes through a link; when no plugin of that version is installed; or when the install lies inside the workspace. Otherwise it loads the launcher by its absolute real path in Codex's plugin cache, `<CODEX_HOME or ~/.codex>/plugins/cache/causoryn/causoryn/<version>/scripts/plugin-mcp-launcher.mjs` (`env_vars` passes `CODEX_HOME` through), and the launcher checks the package version again. No npm process runs and no project file is loaded.

**Residual:** the bootstrap's checks run inside the `node` that `PATH` selected. An empty or relative `PATH` entry before Node's directory lets a repository that contains a `node` executable supply it; that binary then runs instead of Node and the bootstrap never runs. On a launch where the real Node was found, the bootstrap refuses such a `PATH`, so it is fixed before a repository can use it. Codex resolves an empty or relative entry against its own working directory on Windows and against the server's working directory (the project) on macOS and Linux. The manifest cannot avoid this: Codex expands no variables in a plugin MCP configuration and has no per-platform command, so the manifest cannot name an absolute Node binary. Option A is not affected because it registers the absolute Node binary. A different marketplace name, a remote executor or a changed Codex cache layout makes the bootstrap stop with exit code `2` instead of loading anything else.

## 3. Tool profiles in Codex

The server starts with the `core` profile: 11 tools (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`). The core `tools/list` response stays under 15,000 characters because `outputSchema` is omitted by default (`--output-schema full` adds it back; responses are validated against their schemas either way).

| Profile | Adds |
|---|---|
| `wiki` | the 7 `causoryn_wiki_*` tools |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | all 29 legacy tools plus `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 tools); superseded legacy tools carry a deprecation note |

Profiles combine with commas (`wiki,history`). Precedence is `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`; every supplied value is validated and an unknown name stops the server at startup. In Codex:

```toml
# Either append the flag to the packaged entrypoint's args ...
[mcp_servers.causoryn]
command = "/path/to/node"
args = ["/home/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "codex", "--tool-profile", "wiki,history"]
startup_timeout_sec = 30

# ... or set the environment variable (the only option for the monorepo bundle)
[mcp_servers.causoryn.env]
CAUSORYN_TOOL_PROFILE = "full"
```

- With `codex mcp add`, pass `--env CAUSORYN_TOOL_PROFILE=full`.
- `npx causoryn@latest setup --client codex --tool-profile wiki,history --yes` writes the flag for you. Re-running `causoryn setup` keeps `[mcp_servers.causoryn.env]`, the `--tool-profile` and `--output-schema` arguments, and other keys of the table, and a `startup_timeout_sec` of 30 or more; pass `setup --tool-profile <list>` to change the profile.
- For the marketplace plugin, the manifest lives in the installed plugin and should not be edited. Whether Codex forwards `CAUSORYN_TOOL_PROFILE` from its own environment to plugin servers has not been verified; use Option A or C if you need a non-default profile.

## 4. Data directory and first run

- With `--auto-data-dir` (or `--data-dir <abs>`), the index lives at `<base>/workspaces/<slug>-<hash12>/graph.sqlite`, with export output under `<base>/workspaces/<slug>-<hash12>/exports/`. The base is `--data-dir` > `~/.causoryn`, the same for every host (`ZCODE_PLUGIN_DATA` is only a fallback when `~/.causoryn` cannot be created or written).
- **One database per workspace for all hosts.** Codex, Claude Code, Antigravity, and ZCode open the same `graph.sqlite` when they use the same base directory. `--client codex` is only a diagnostic label (recorded as `build_leases.host_label`). A `build_leases` single-writer lease prevents two processes from publishing a snapshot at the same time.
- Releases before 0.3.0 used per-host `graph-<client>.sqlite` files. When `graph.sqlite` does not exist yet, the first 0.3.0 start copies the newest valid one into it once; the legacy files stay in place and `causoryn doctor` lists them so you can delete them. The `fp3` analyzer fingerprint still makes the first 0.3.0 start re-index once.
- Directories are created with mode `0700` and must lie strictly outside every authorized project root. Nothing is written into the analyzed source tree.
- Indexing runs in a `worker_threads` worker. With the packaged entrypoint (Options A and B), a tool call made before the first index is published waits up to `CAUSORYN_INDEX_WAIT_MS` (default `15000`; `0` = do not wait) and then returns `status: "partial"` with `data.status: "indexing"`, `jobId`, `progress`, and `retryAfterMs`. `causoryn_status` answers immediately.
- `--allow-cwd` binds the directory Codex starts the server in, after a safety check that refuses `$HOME`, filesystem roots, system directories, `~/.codex`, plugin install directories, and the Causoryn data directory. When the start directory is refused, the server waits for a safe root from MCP `roots/list`; until then workspace tools return `WORKSPACE_NOT_AUTHORIZED`. Start Codex inside the project, or add `"--root", "/path/to/your-project"` to `args`.

---

## 5. Option C — Manual registration from a source checkout

### 5.1 Build the bundle

```bash
npm run build:bundle --workspace packages/mcp-server
```

The script exists only in `packages/mcp-server/package.json` (running it at the repository root without `--workspace` fails with `Missing script`). The deterministic output is described by a 36-entry `bundle-manifest.json`:

```text
packages/mcp-server/dist/
├── bundle-manifest.json         ← sorted SHA-256 manifest (36 entries)
├── mcp-server.mjs               ← stdio entrypoint (built from src/stdio.ts)
├── index-worker.mjs             ← indexing worker_threads entrypoint
├── mcp-server.mjs.LEGAL.txt     ← third-party license notices emitted by esbuild
└── node_modules/better-sqlite3/ ← native module (LICENSE, package.json, lib/, prebuilds/)
```

Keep the whole `dist/` directory together: the native `.node` prebuilds cannot be inlined into `mcp-server.mjs`.

This bundle reads **no command-line flags**. Its configuration comes only from `CAUSORYN_CONFIG` (strict JSON schema, `parseCausorynServerConfig` in `packages/mcp-server/src/config.ts`) and `CAUSORYN_TOOL_PROFILE`. Without `CAUSORYN_CONFIG` it starts fail-closed with `allowRoots: []`, so workspace tools return `WORKSPACE_NOT_AUTHORIZED`. Without `storage.dataDbPath` the graph is kept in memory and rebuilt on every start.

### 5.2 Method A — `codex mcp add` (recommended over manual edits)

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Syntax (`codex mcp add --help`): `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`. Everything after `--` is the server launch command.

### 5.3 Method B — `config.toml` table (manual edit)

```toml
[mcp_servers.causoryn]
command = "node"
args = ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
startup_timeout_sec = 30

[mcp_servers.causoryn.env]
CAUSORYN_CONFIG = '{"allowRoots":["/path/to/your-project"]}'
```

- Use an **absolute** path in `args`; Codex spawns MCP servers independently of your current directory.
- To persist the index, extend `CAUSORYN_CONFIG` with `"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}` (and the same path for `"wiki":{"dataDbPath":…}`); the parent directory must exist and lie outside every authorized root.

### 5.4 Verification

```bash
codex mcp list            # human-readable output
codex mcp list --json     # machine-readable output
codex mcp get causoryn    # single entry
```

Expected: `causoryn` is listed with the command `node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs`.

**Honest limitations (`0.163.0` live evidence, `2026-11-10`; unchanged in `0.169.0`):**

- `codex mcp list` performs **no live health check**: it reads `config.toml` without spawning the server, so there is no `Connected` / `Failed` probe as in Claude Code. The actual spawn and handshake happen inside a live Codex session (and are covered separately by the automated `stdio` spawn tests and the Claude Code live runs).
- `codex mcp add` does not validate the script path: registering an invalid path (`node Z:/definitely/not/here.mjs`) succeeds and shows as `enabled` in `list`; it only fails at session start.
- An unknown name is a hard error: `codex mcp get no-such-server-xyz` → `Error: No MCP server named 'no-such-server-xyz' found.` (exit `1`).

### 5.5 Cleanup and smoke discipline

```bash
codex mcp remove causoryn
```

For non-permanent tests, register under a dedicated name and confirm removal afterwards:

```bash
codex mcp add causoryn-smoke -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # causoryn-smoke is gone
```

**TOML re-serialization warning (`0.163.0` live finding, `2026-11-10`):** `codex mcp add` and `codex mcp remove` parse and re-serialize `~/.codex/config.toml` from scratch. The `causoryn` block is added and removed cleanly, but formatting of neighbouring `[mcp_servers.*]` tables may change (for example key order inside `env`, or `startup_timeout_sec = 120` rewritten as `120.0`). Byte-level invariance is not guaranteed by `codex mcp`. Back up the file before manual smoke tests and compare hashes afterwards:

```bash
cp ~/.codex/config.toml /tmp/config.toml.bak
sha256sum ~/.codex/config.toml   # before
# ... add → list → remove → list ...
sha256sum ~/.codex/config.toml   # after; restore the backup if formatting drifted
```

`causoryn setup` avoids this by patching only its own table (section 1).

## 6. `stdout` hygiene

Every Causoryn entrypoint writes **only MCP JSON-RPC 2.0 frames** to `stdout`; all diagnostics go to `stderr` with a `[causoryn]` (or `[causoryn-launcher]`) prefix, so log lines never interfere with Codex's JSON-RPC pipe.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `setup` stops with `cli/malformed-toml` | `config.toml` has a syntax problem or a duplicated table header. Fix it or restore `config.toml.causoryn.backup`; nothing was written. |
| Codex reports a start-up timeout | Cold start exceeded the configured timeout. Keep `startup_timeout_sec = 30` (or higher) on the entry. |
| `doctor` shows `ERROR` for the entry script | `~/.causoryn/runtime` or the original install was removed. Re-run `npx causoryn@0.3.2 setup --client codex --yes`. |
| `setup` reports `skipped skill <name>: … was not created by Causoryn` (or `… was changed after Causoryn installed it`) | A `SKILL.md` with a Causoryn skill name exists that setup cannot prove it installed: your own skill, or a Causoryn skill you edited. It was kept. Leave it, or move it away and re-run setup to install Causoryn's version. |
| `setup` stops with `Refusing to use <dir>: it is writable by other users` or `… it is owned by another user` | On POSIX an existing `~/.causoryn` must belong to you and must not be writable by group or others, because it holds the staged runtime and the skill install record. Run `chmod go-w ~/.causoryn`, or remove the directory or give it to your user, then re-run setup; nothing was changed. |
| `setup` stops with `<file> changed while setup was running, so it was left as it is` | A skill file that setup planned to replace or remove changed during the run (for example while the confirmation prompt was open), and it was left as it is. Run setup again. |
| Server exits at start with "Unsupported Node.js version" | Node.js < 24. Install Node.js 24+ and re-run `setup`. |
| Extra `args` disappeared | Re-running `setup` regenerates the argument list and keeps only your `--tool-profile` and `--output-schema` arguments (plus `[mcp_servers.causoryn.env]` and other keys of the table). Re-apply other arguments, or use `setup --tool-profile <list>` for the profile. |
| Workspace tools return `WORKSPACE_NOT_AUTHORIZED` | The start directory was refused by `--allow-cwd` and no usable root was reported, or the bare bundle has no `allowRoots`. See section 4 or 5.1. |
| The Codex plugin server exits at start with `[causoryn-codex] …` (exit `2`) | The message names the cause. `PATH entry … is empty or not an absolute local path`: remove that entry from `PATH` (an empty entry often comes from `;;` or a trailing separator) or move Node's directory before it. `node runs from inside the workspace`: start Codex with a Node.js installed outside the repository. Otherwise the bootstrap could not prove where the installed plugin is: `CODEX_HOME` is relative, no Causoryn plugin of that version is in `<CODEX_HOME or ~/.codex>/plugins/cache/causoryn/causoryn/`, a link lies on that path, or the install is inside the workspace. Reinstall the plugin, fix `CODEX_HOME`, or use Option A (`npx causoryn@0.3.2 setup --client codex --yes`). |
| Wiki or history tools are missing from `tools/list` | Default `core` profile. See section 3. |

## Related pages

- [5-Minute Quickstart](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md) · [MCP Tool Contracts](../tool-contracts.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/codex.md)
- Other host guides: [Claude Code](claude-code.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
