# Connecting Causoryn to Claude Code (`stdio` MCP)

> **Language:** [Türkçe](../../hosts/claude-code.md) | **English** · [Documentation Hub](../README.md) · [Compatibility Matrix](../compatibility-matrix.md)

> **Status:** reflects Causoryn 0.3.2 (default `core` tool profile with 11 tools; one shared per-workspace `graph.sqlite` for all hosts). See [CLI & Configuration](../cli-and-configuration.md) for the full flag reference and [MCP Tool Contracts](../tool-contracts.md) for the tool catalog.

> **Sources checked for this page:** `packages/causoryn/src/{setup.ts,doctor.ts,cli.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs}`, `packages/causoryn/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`.

Causoryn is a local, deterministic MCP server for code intelligence. It makes no LLM or network API calls. If Claude Code is not installed yet, install it with `npm install -g @anthropic-ai/claude-code`.

## Verification record

Live Claude Code CLI runs (all on builds **before 0.3.0**; a live re-run against 0.3.0 is not recorded yet):

| Date | Claude Code | What was executed | Result |
|---|---|---|---|
| `2026-11-08` | `2.1.319` | `claude mcp --help`, `claude mcp add --help` syntax check; manual `stdout` check on `causoryn@0.1.0` | Syntax confirmed; `stdout` carried 2 pure JSON-RPC lines (`initialize`, `tools/list` with the 29-tool catalog of that release) |
| `2026-11-10` | `2.1.322` | `claude mcp add` → `claude mcp list` → `claude mcp remove` inside a redirected temporary `CLAUDE_CONFIG_DIR` (monorepo bundle) | `✔ Connected`; `sha256sum ~/.claude.json` identical before and after; invalid path probe reported `✘ Failed to connect — CONNECTION_CLOSED` |
| `2026-11-19` | `2.1.328` | `claude plugin validate --strict` against the root `.claude-plugin/marketplace.json`; packaged `causoryn setup`; `claude mcp list` | Validation passed; `√ Connected` |

Automated coverage of the 0.3.0 code paths used on this page: `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts` (isolated temporary `$HOME`), `tests/open-source-distribution.test.ts` (packed `.tgz` handshake), `tests/mcp-tool-surface-budget.test.ts` (core `tools/list` size), and `tests/hosts-docs.test.ts` (monorepo bundle presence and manifest hash).

## Choose an installation path

| Path | Who it is for | What runs |
|---|---|---|
| **A. `npx causoryn@0.3.2 setup`** (recommended) | End users | Packaged entrypoint `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client claude-code`, registered in `~/.claude.json` with the absolute Node binary |
| **B. Claude Code plugin marketplace** | End users who prefer `/plugin` | Packaged `plugin-mcp-launcher.mjs` from the installed npm package |
| **C. Manual registration** (`.mcp.json` or `claude mcp add`) | Contributors working from a source checkout | Monorepo bundle `packages/mcp-server/dist/mcp-server.mjs` (configured only through `CAUSORYN_CONFIG`) |

---

## 1. Option A — One-command setup

```bash
# Preview the planned changes without writing anything
npx causoryn@0.3.2 setup --client claude-code --dry-run

# Register the MCP server in ~/.claude.json and install the 5 skills into ~/.claude/skills/
npx causoryn@0.3.2 setup --client claude-code --yes

# Read-only health and alignment check
npx causoryn@0.3.2 doctor --client claude-code

# Clean removal (mcpServers.causoryn + the 5 Causoryn skills)
npx causoryn@0.3.2 setup --client claude-code --uninstall --yes
```

### What `setup --client claude-code` writes

`setup` adds the `causoryn` key to the **top-level** `mcpServers` object of `~/.claude.json`, or updates only the keys it owns (`command`, `args`, `type`) in an existing entry (Claude Code's user scope, so the server is available in every project; `--allow-cwd` then binds the project directory Claude Code was started in). Other keys in the file are kept:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": [
        "/home/you/.causoryn/runtime/scripts/causoryn.mjs",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "claude-code"
      ]
    }
  }
}
```

- **Absolute Node binary:** `command` is the `process.execPath` of the Node.js that ran `setup` (Node.js ≥ 24 is required), not a bare `node` looked up on `PATH`.
- **Persistent runtime:** when `setup` runs from an ephemeral location (an `_npx` cache directory or anything under the OS temp directory), it first copies the package to `~/.causoryn/runtime` (staged in a temporary directory and swapped in with a rename) and points `args[0]` there, so the registration survives `npx` cache eviction. When run from a regular install, `args[0]` points at that install.
- **`CLAUDE_CONFIG_DIR`:** when this variable is set, `setup` and `doctor` use `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/skills/` instead of `~/.claude.json` and `~/.claude/skills/` (`resolveEffectiveClaudeConfigDir` in `packages/causoryn/src/setup.ts`). Use it for multiple profiles and for isolated smoke runs.
- **Skills:** the five canonical skills `causoryn`, `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` are written to `~/.claude/skills/<name>/SKILL.md`. Pass `--no-skill` to register only the MCP server. `architecture-blueprint` guides Claude in drafting optional `annotations` from MCP evidence; to export without annotations, call `causoryn_export_documentation` directly ([architecture export contract](../tool-contracts.md)). Skills are guidance text for the host model: a tool a skill mentions can only be called if the active tool profile registers it. An existing `SKILL.md` that setup cannot prove Causoryn installed (your own skill with the same name, or a Causoryn skill you edited) is kept and reported as `skipped skill …`; the install record is `~/.causoryn/installed-skills.json` ([CLI & Configuration](../cli-and-configuration.md)).

### How `setup` behaves (all hosts)

- **Detection:** without `--client` or `--all`, `setup` configures only detected hosts. Claude Code counts as detected when `~/.claude.json` or `~/.claude` exists (or, with `CLAUDE_CONFIG_DIR`, that directory or its `.claude.json`). If nothing is detected, no file is written, the command prints how to pick a client on `stderr`, and it exits `1`.
- **Confirmation:** without `--yes` (and without `--dry-run`), an interactive terminal shows the plan and asks `Continue? [y/N]`. In a non-interactive shell the command stops with a "confirmation required" error and writes nothing.
- **Backups:** before an existing config is modified for the first time, the original is copied to `~/.claude.json.causoryn.backup`. That file is never overwritten; later modifications create additional `~/.claude.json.causoryn.<timestamp>-<nonce>.backup` copies. A newly created file gets no backup.
- **Atomic, idempotent writes:** each file is written to a temporary sibling and renamed into place, keeping the existing file mode (new config files are created `0600`). A second identical run reports `noop` and touches no file or backup.
- **Fail-closed parsing:** a config that is not valid JSON, or whose `mcpServers` is not an object, stops the run with `cli/malformed-json` before anything is written. Symbolic-link targets and non-regular files are refused.
- **Exit codes:** `setup` exits `0` on success (including dry runs, no-ops, and a declined prompt), `1` when no host was detected and none was named (nothing is written), and `2` on any error.
- **Uninstall:** `--uninstall` deletes `mcpServers.causoryn` (an empty `mcpServers` object remains) and the Causoryn skills whose ownership is proven (an edited or foreign `SKILL.md` is kept and reported), and removes `~/.causoryn/runtime` only when no other host config still references it.

### `doctor` checks

`causoryn doctor` is read-only. It checks Node.js ≥ 24, the runtime files (`dist/mcp-server.mjs`, the `better-sqlite3` prebuild for the current platform, the bundled TypeScript library, and the native sidecar worker sources) in the package root and in `~/.causoryn/runtime`, probes `dotnet`, `python`, `go`, and `cargo` (a missing toolchain is reported as `l0-l1-fallback`, meaning that language falls back to file-level analysis), and inspects each host:

- Claude Code host status is `OK` (valid config, `mcpServers.causoryn` present, entry script exists when `command` is a Node binary, all five skills present), `WARN` (MCP entry without all skills, or skills without the entry), `NOT-CONFIGURED`, or `ERROR` (unparsable config or missing entry script — re-run `setup`).
- The overall result is `HEALTHY`, `DEGRADED`, `NOT CONFIGURED`, or `UNHEALTHY`. `doctor` exits `0` only for `HEALTHY` and `1` otherwise. `--client claude-code` limits the overall result to Claude Code.

## 2. Option B — Native Claude Code plugin marketplace

```text
/plugin marketplace add MrBekoX/Causoryn
/plugin install causoryn@causoryn
```

The root `.claude-plugin/marketplace.json` declares an npm source (`{ "source": "npm", "package": "causoryn", "version": "0.3.2" }`). The installed package's `.claude-plugin/plugin.json` ships the skills (`"skills": "./skills"`) and registers the server as:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.3.2",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "claude-code"
      ]
    }
  }
}
```

`plugin-mcp-launcher.mjs` checks that the installed `package.json` is `causoryn` at exactly the `--expected-version` (and that `CAUSORYN_EXPECTED_VERSION`, if set, agrees). It does not spawn a nested `npx` process. On a mismatch or a missing bundle it exits `2` with a `[causoryn-launcher]` message on `stderr`. Otherwise it sets `CAUSORYN_ASSET_ROOT` and imports `dist/mcp-server.mjs` directly, keeping `stdout` reserved for MCP frames. `${CLAUDE_PLUGIN_ROOT}` is never accepted as an analyzed project root. Claude Code's plugin MCP config has no `cwd` field, so Claude Code chooses the directory the server starts in (the session directory, bound through `--allow-cwd` or MCP `roots/list`); the entry script is anchored at `${CLAUDE_PLUGIN_ROOT}`, and how Claude Code resolves the bare `node` command is up to the host. `causoryn setup` (Option A) writes the absolute Node binary instead.

## 3. Tool profiles in Claude Code

The server starts with the `core` profile: 11 tools (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`). The core `tools/list` response stays under 15,000 characters because `outputSchema` is omitted by default (`--output-schema full` adds it back; responses are validated against their schemas either way).

| Profile | Adds |
|---|---|
| `wiki` | the 7 `causoryn_wiki_*` tools |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | all 29 legacy tools plus `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 tools); superseded legacy tools carry a deprecation note |

Profiles combine with commas (`wiki,history`). Precedence is `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`; every supplied value is validated and an unknown name stops the server at startup. In Claude Code:

- **Entry written by `setup`:** run `npx causoryn@latest setup --client claude-code --tool-profile wiki,history --yes`, or append `"--tool-profile", "wiki,history"` to `args` or add `"env": { "CAUSORYN_TOOL_PROFILE": "full" }` to the `causoryn` entry in `~/.claude.json` by hand. Re-running `setup` keeps the entry's `env`, `--tool-profile` and `--output-schema` arguments and other keys you added (for example `disabled`); pass `setup --tool-profile <list>` to change the profile.
- **`claude mcp add`:** packaged entrypoint (installed npm package): `claude mcp add causoryn -s local -- node /path/to/node_modules/causoryn/scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client claude-code --tool-profile full`. Monorepo bundle (reads no CLI flags): `claude mcp add causoryn -s local -e CAUSORYN_TOOL_PROFILE=full -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs`.
- **Marketplace plugin:** the manifest lives in the installed plugin and should not be edited. `CAUSORYN_TOOL_PROFILE` takes effect only if Claude Code passes it from its own environment to plugin MCP servers; this has not been verified. Use Option A or C if you need a non-default profile.

## 4. Data directory and first run

- With `--auto-data-dir` (or `--data-dir <abs>`), the index lives at `<base>/workspaces/<slug>-<hash12>/graph.sqlite`, with export output under `<base>/workspaces/<slug>-<hash12>/exports/`. The base is `--data-dir` > `~/.causoryn`, the same for every host (`ZCODE_PLUGIN_DATA` is only a fallback when `~/.causoryn` cannot be created or written).
- **One database per workspace for all hosts.** Claude Code, Codex, Antigravity, and ZCode open the same `graph.sqlite` when they use the same base directory. `--client claude-code` is only a diagnostic label (recorded as `build_leases.host_label`). A `build_leases` single-writer lease prevents two processes from publishing a snapshot at the same time.
- Releases before 0.3.0 used per-host `graph-<client>.sqlite` files. When `graph.sqlite` does not exist yet, the first 0.3.0 start copies the newest valid one into it once; the legacy files stay in place and `causoryn doctor` lists them so you can delete them. The `fp3` analyzer fingerprint still makes the first 0.3.0 start re-index once.
- Directories are created with mode `0700` and must lie strictly outside every authorized project root (lexical and real-path checks, symlinked ancestors refused). Nothing is written into the analyzed source tree.
- Indexing runs in a `worker_threads` worker. With the packaged entrypoint (Options A and B), a tool call made before the first index is published waits up to `CAUSORYN_INDEX_WAIT_MS` (default `15000`; `0` = do not wait) and then returns `status: "partial"` with `data.status: "indexing"`, `jobId`, `progress`, and `retryAfterMs`. `causoryn_status` answers immediately.
- `--allow-cwd` refuses unsafe start directories (for example `$HOME`, a filesystem root, system directories, `~/.claude`, plugin install directories, or the Causoryn data directory). In that case the server starts with no authorized root and binds the first safe `file://` root the host reports through MCP `roots/list`; until then workspace tools return `WORKSPACE_NOT_AUTHORIZED`. Start Claude Code inside the project, or pass `--root /path/to/your-project`.

---

## 5. Option C — Manual registration from a source checkout

### 5.1 Build the bundle

```bash
npm run build:bundle --workspace packages/mcp-server
```

The script exists only in `packages/mcp-server/package.json`; running it at the repository root without `--workspace` fails with `Missing script`. The output is deterministic across builds and is described by a 36-entry `bundle-manifest.json` (sorted SHA-256 per file):

```text
packages/mcp-server/dist/
├── bundle-manifest.json         ← sorted SHA-256 manifest (36 entries)
├── mcp-server.mjs               ← stdio entrypoint (built from src/stdio.ts)
├── index-worker.mjs             ← indexing worker_threads entrypoint
├── mcp-server.mjs.LEGAL.txt     ← third-party license notices emitted by esbuild
└── node_modules/better-sqlite3/ ← native module (LICENSE, package.json, lib/, prebuilds/)
```

Do **not** move `mcp-server.mjs` on its own. `better-sqlite3` ships native `.node` prebuilds that esbuild cannot inline, so the whole `dist/` directory must stay together.

This bundle is the bare entrypoint: it reads **no command-line flags**. Its only configuration source is the `CAUSORYN_CONFIG` environment variable (strict JSON schema, `parseCausorynServerConfig` in `packages/mcp-server/src/config.ts`), plus `CAUSORYN_TOOL_PROFILE`. Without `CAUSORYN_CONFIG` it starts fail-closed with `allowRoots: []`, so workspace tools return `WORKSPACE_NOT_AUTHORIZED`. Without `storage.dataDbPath` the graph is kept in memory and rebuilt on every start.

### 5.2 Method A — project-scoped `.mcp.json` (shareable with your team)

Place `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[\"/path/to/your-project\"]}"
      }
    }
  }
}
```

- Use an **absolute** path in `args` when Causoryn lives outside the target project.
- Claude Code marks `.mcp.json` servers as pending approval on first use; `claude mcp list` shows the approval state, and `claude mcp reset-project-choices` resets project approval choices.

### 5.3 Method B — `claude mcp add` (local scope)

`claude mcp add` defaults to the **local** scope (`-s local` / `--scope local` writes the entry under the current project key in `~/.claude.json` without affecting other projects):

```bash
cd /path/to/your-project
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

- Everything after `--` is the server launch command; `stdio` is the default transport (`-t stdio` is optional).
- `-s user` registers the server for all projects. This guide recommends `local` (least privilege).

To persist the index on disk, also declare a database path outside the project, for example `{"allowRoots":["/path/to/your-project"],"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"},"wiki":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}}` (the parent directory must exist and lie outside every authorized root).

### 5.4 Verification

```bash
claude mcp list
claude mcp get causoryn
```

`claude mcp list` spawns the server and performs an MCP handshake. The `2026-11-10` run (`2.1.322`) printed `causoryn: node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs - ✔ Connected`; the `2026-11-19` run (`2.1.328`) printed `√ Connected`.

**Negative behaviour (`2.1.322`, `2026-11-10`):** a server registered with a non-existent script (`node Z:/definitely/not/here.mjs`) is listed as `✘ Failed to connect — CONNECTION_CLOSED`. `claude mcp add` does not validate the path at registration time; errors surface in the `list` / `get` health check.

### 5.5 Cleanup

```bash
claude mcp remove causoryn
```

Without `-s`, Claude Code removes the server from whichever scope holds it.

### 5.6 Smoke test protocol (no residue in your real config)

**Redirected protocol (recommended; executed end-to-end on `2026-11-10` with `2.1.322`).** `CLAUDE_CONFIG_DIR` sends every configuration write to a temporary directory:

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$TMP_CFG"                 # Git Bash on Windows: "$(cygpath -w "$TMP_CFG")"

claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
# → output shows "File modified: $TMP_CFG/.claude.json"
claude mcp list                                      # → causoryn … ✔ Connected
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Cleanliness proof: `sha256sum ~/.claude.json` is identical before and after the run. The same variable isolates `causoryn setup` / `causoryn doctor` runs.

**Residue note for unredirected runs.** Running `claude mcp add` / `claude mcp remove` without `CLAUDE_CONFIG_DIR` can leave an empty project entry in `~/.claude.json` for the temporary directory (`"mcpServers": {}` plus bookkeeping fields such as `allowedTools` and `hasTrustDialogAccepted`). `remove` deletes the `causoryn` entry itself completely, but Claude Code (`2.1.319` / `2.1.322`) has no CLI subcommand to prune an empty project entry. Any unredirected `claude` invocation may also update global counters such as `pluginUsage`; that is host behaviour, not part of the MCP registration.

## 6. `stdout` hygiene

Every Causoryn entrypoint (`causoryn.mjs mcp`, `plugin-mcp-launcher.mjs`, and the bare `mcp-server.mjs`) writes **only MCP JSON-RPC 2.0 frames** to `stdout`. Diagnostics go to `stderr` with a `[causoryn]` or `[causoryn-launcher]` prefix, so log lines cannot corrupt Claude Code's JSON-RPC stream.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `setup` stops with `cli/malformed-json` | `~/.claude.json` is not valid JSON or `mcpServers` is not an object. Fix the file or restore `~/.claude.json.causoryn.backup`; nothing was written. |
| `setup` refuses to write to a symbolic link | Symlinked config files are refused on purpose. Point `CLAUDE_CONFIG_DIR` at the real directory or replace the link with a regular file. |
| `setup` reports "confirmation required" | Non-interactive shell without `--yes`. Re-run with `--dry-run` to review, then `--yes`. |
| `doctor` shows `ERROR` for the entry script | `~/.causoryn/runtime` or the original install was removed. Re-run `npx causoryn@0.3.2 setup --client claude-code --yes`. |
| `setup` reports `skipped skill <name>: … was not created by Causoryn` (or `… was changed after Causoryn installed it`) | A `SKILL.md` with a Causoryn skill name exists that setup cannot prove it installed: your own skill, or a Causoryn skill you edited. It was kept. Leave it, or move it away and re-run setup to install Causoryn's version. |
| `setup` stops with `Refusing to use <dir>: it is writable by other users` or `… it is owned by another user` | On POSIX an existing `~/.causoryn` must belong to you and must not be writable by group or others, because it holds the staged runtime and the skill install record. Run `chmod go-w ~/.causoryn`, or remove the directory or give it to your user, then re-run setup; nothing was changed. |
| `setup` stops with `<file> changed while setup was running, so it was left as it is` | A skill file that setup planned to replace or remove changed during the run (for example while the confirmation prompt was open), and it was left as it is. Run setup again. |
| Server exits at start with "Unsupported Node.js version" | Node.js < 24. Install Node.js 24+ and re-run `setup` so `command` points at it. |
| `[causoryn-launcher]` version mismatch (exit `2`) | The installed plugin package does not match `--expected-version`. Update or reinstall the plugin. |
| Workspace tools return `WORKSPACE_NOT_AUTHORIZED` | `--allow-cwd` rejected the start directory and the host has not reported a usable root, or the bare bundle has no `allowRoots`. See section 4 or 5.1. |
| Wiki or history tools are missing from `tools/list` | Default `core` profile. See section 3. |
| First call returns `status: "partial"` with `data.status: "indexing"` | The first index is still being built. Retry after `retryAfterMs`, or call `causoryn_status`. |

## Related pages

- [5-Minute Quickstart](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md) · [MCP Tool Contracts](../tool-contracts.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/claude-code.md)
- Other host guides: [Codex CLI](codex.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
