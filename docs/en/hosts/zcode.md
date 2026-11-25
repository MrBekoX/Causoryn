# Connecting Causoryn to ZCode (GLM) (CLI Config + Plugin Marketplace)

> **Language:** [Türkçe](../../hosts/zcode.md) | **English** · [Documentation Hub](../README.md) · [Compatibility Matrix](../compatibility-matrix.md)

> **Status:** reflects Causoryn 0.3.2 (default `core` tool profile with 11 tools; one shared per-workspace `graph.sqlite` for all hosts). Interactive ZCode desktop GUI installation is **`NOT RUN`** (see the verification section).

> **Sources checked for this page:** `packages/causoryn/src/{setup.ts,doctor.ts,cli.ts,runtime-stage.ts}`, root `marketplace.json`, `packages/causoryn/.zcode-plugin/plugin.json`, `packages/causoryn/scripts/plugin-mcp-launcher.mjs`, `integrations/zcode/.claude-plugin/marketplace.json`, `integrations/zcode/causoryn/{.zcode-plugin/plugin.json,README.md}`, `packages/mcp-server/src/{runtime-cli.ts,cli-stdio.ts,stdio.ts}`.

Causoryn is a local, deterministic MCP server for code intelligence. It makes no LLM or network API calls. On ZCode (GLM) it offers **two installation surfaces**:

1. **CLI setup (recommended):** `npx causoryn@0.3.2 setup --client zcode --yes` configures `~/.zcode/cli/config.json` (`mcp.servers.causoryn`) and `~/.zcode/skills/`.
2. **ZCode plugin marketplace:** the repository root `marketplace.json` (npm source) and the packaged `.zcode-plugin/plugin.json`, version-pinned through `plugin-mcp-launcher.mjs --expected-version 0.3.2`.

## Verification status — desktop GUI (`NOT RUN`) vs automated schema and CLI tests

- **Interactive ZCode desktop GUI installation: `NOT RUN`.** ZCode exposes no command-line plugin installer (`zcode --help` / `zcode plugin --help` are not available; marketplace installation happens only in the desktop GUI). Automated verification never modifies a developer's real ZCode desktop profile, so in-GUI installation and in-GUI `tools/list` observation were not run.
- **Automatically verified (0.3.0 code):** the root `marketplace.json`, the packaged `packages/causoryn/.zcode-plugin/plugin.json`, the monorepo development fixture (`integrations/zcode/.claude-plugin/marketplace.json` + `integrations/zcode/causoryn/`), the packaged `setup` / `doctor` / `--uninstall` lifecycle in an isolated temporary `$HOME` (including the `~/.agents/mcp.json` fallback copy), and the packed `.tgz` `stdio` handshake (`tools/list` returns exactly the 11 core tools, under 15,000 characters, without `outputSchema`). Suites: `integrations/zcode/causoryn/test/plugin-package.test.ts`, `integrations/zcode/causoryn/test/plugin-dev-marketplace.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts`, `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `tests/open-source-distribution.test.ts`.

---

## 1. Primary setup — one-command CLI

```bash
# Preview the planned changes without writing anything
npx causoryn@0.3.2 setup --client zcode --dry-run

# Configure ~/.zcode/cli/config.json (mcp.servers.causoryn) + ~/.zcode/skills/
npx causoryn@0.3.2 setup --client zcode --yes

# Read-only health and alignment check
npx causoryn@0.3.2 doctor --client zcode

# Clean removal (mcp.servers.causoryn + the 5 Causoryn skills)
npx causoryn@0.3.2 setup --client zcode --uninstall --yes
```

### What `setup --client zcode` does (`packages/causoryn/src/setup.ts`)

1. **Persistent runtime staging.** When `setup` runs from an ephemeral location (an `_npx` cache directory or anything under the OS temp directory), it copies the package (compiled bundle, indexing worker, native sidecar worker sources, skills, manifests) into a temporary directory under `~/.causoryn/` and swaps it into `~/.causoryn/runtime` with a rename. The configured entrypoint therefore stays valid after the `npx` cache is evicted.
2. **Atomic `~/.zcode/cli/config.json` update.** If the file exists, its original is first copied to `~/.zcode/cli/config.json.causoryn.backup` (never overwritten later; further changes create `config.json.causoryn.<timestamp>-<nonce>.backup` copies). The file is then written atomically (temporary file + rename, existing mode kept, new files `0600`) with this entry; other keys are kept:

   ```json
   {
     "mcp": {
       "servers": {
         "causoryn": {
           "type": "stdio",
           "command": "/path/to/node",
           "args": [
             "/home/you/.causoryn/runtime/scripts/causoryn.mjs",
             "mcp",
             "--allow-cwd",
             "--auto-data-dir",
             "--client",
             "zcode"
           ]
         }
       }
     }
   }
   ```

   `command` is the absolute `process.execPath` of the Node.js (≥ 24) that ran `setup`.
3. **`~/.agents/mcp.json` fallback preservation.** ZCode falls back to `~/.agents/mcp.json` (`mcpServers`) only while `mcp.servers` is absent from `~/.zcode/cli/config.json`, so creating `mcp.servers` would hide those servers. When `setup` creates `mcp.servers` for the first time and `~/.agents/mcp.json` exists, it copies every entry except `causoryn` into `mcp.servers`, adding `type: "stdio"` to entries that have a `command` but no `type`. A malformed `~/.agents/mcp.json` stops the run with `cli/malformed-json` before anything is written.
4. **Five canonical skills.** `causoryn`, `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` are written to `~/.zcode/skills/<name>/SKILL.md` (`--no-skill` skips them). `architecture-blueprint` guides ZCode in drafting optional `annotations` from MCP evidence; to export without annotations, call `causoryn_export_documentation` directly ([architecture export contract](../tool-contracts.md)). Skills are guidance text for the host model: a tool a skill mentions can only be called if the active tool profile registers it.
5. **Clean uninstall.** `--uninstall` deletes `mcp.servers.causoryn`, removes an emptied `mcp.servers` and then an emptied `mcp` object, deletes the five skill directories, and removes `~/.causoryn/runtime` if no other host config references it. Servers that were copied from `~/.agents/mcp.json` stay in `mcp.servers`.

Common behaviour: ZCode counts as detected when `~/.zcode` or `~/.zcode/cli/config.json` exists; without `--yes` (and without `--dry-run`) an interactive terminal asks `Continue? [y/N]` and a non-interactive shell stops with a "confirmation required" error; an identical second run reports `noop`; invalid JSON or non-object `mcp` / `mcp.servers` values stop the run with `cli/malformed-json`; symbolic-link targets are refused; `setup` exits `0` on success, `1` when no host was detected and none was named, and `2` on error.

### `doctor` checks

`causoryn doctor` is read-only. For ZCode it parses `~/.zcode/cli/config.json`, requires `mcp.servers.causoryn` with a non-empty `command`, checks that the entry script exists when `command` is a Node binary, and checks the five skills. Host status is `OK`, `WARN`, `NOT-CONFIGURED`, or `ERROR`. `doctor` also checks Node.js ≥ 24, runtime files, and the `dotnet` / `python` / `go` / `cargo` toolchains (missing ones are reported as `l0-l1-fallback`: file-level analysis for that language). The overall result is `HEALTHY`, `DEGRADED`, `NOT CONFIGURED`, or `UNHEALTHY`, and the exit code is `0` only for `HEALTHY`.

---

## 2. ZCode plugin marketplace (`marketplace.json` + `.zcode-plugin/plugin.json`)

Add the repository marketplace in the ZCode desktop UI (**Settings → Plugin Management → Discover → +**) from the GitHub repository (`https://github.com/MrBekoX/Causoryn`) or a local checkout. The root `marketplace.json` declares an npm plugin source (`{ "source": "npm", "package": "causoryn", "version": "0.3.2" }`) with English and Turkish `description_i18n` metadata. (This GUI step is `NOT RUN` in verification.)

The packaged `packages/causoryn/.zcode-plugin/plugin.json` ships the skills (`"skills": "skills"`) and wires the server as:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.3.2",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "zcode"
      ],
      "cwd": "${ZCODE_PROJECT_DIR}"
    }
  }
}
```

`plugin-mcp-launcher.mjs` checks that the installed `package.json` is `causoryn` at exactly `--expected-version` (and agrees with `CAUSORYN_EXPECTED_VERSION` if set) without spawning a nested `npx` process, exits `2` with a `[causoryn-launcher]` message on `stderr` on any mismatch or missing bundle, and otherwise imports `dist/mcp-server.mjs` directly.

### ZCode environment variables and safety boundaries

- **`ZCODE_PLUGIN_ROOT`:** read-only installation root of the plugin. `deriveForbiddenPluginDirs` (`packages/mcp-server/src/runtime-cli.ts`) never lets `ZCODE_PLUGIN_ROOT` or `~/.zcode/plugins` be authorized as an analyzed project root.
- **`ZCODE_PROJECT_DIR`:** the active project directory, passed as `cwd`. `--allow-cwd` checks it with `inspectProjectRootSafety` before authorizing it. Refused candidates include UNC and device paths, filesystem roots, `$HOME` and its ancestors, OS system directories, sensitive directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), plugin install directories, and Causoryn data directories. When the directory is refused, the server starts with no authorized root and binds the first safe `file://` root the client reports through MCP `roots/list` (also on `notifications/roots/list_changed`); until then workspace tools return `WORKSPACE_NOT_AUTHORIZED`.
- **`ZCODE_PLUGIN_DATA`:** ZCode uses the same base data directory as every other host (`--data-dir` > `~/.causoryn`), so all hosts share one index per workspace. `ZCODE_PLUGIN_DATA` is only a fallback, used when `~/.causoryn` cannot be created or written; when set it must be an absolute path (UNC/device paths are rejected) and is validated even when it is not used. Existing ZCode users whose index lived under `ZCODE_PLUGIN_DATA` re-index once. Causoryn verifies that the data directory lies strictly outside every authorized workspace before creating anything; the analyzed source tree is never written.

---

## 3. Tool profiles, shared data directory, and first run

**Tool profiles.** The server starts with the `core` profile: 11 tools (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`), with `outputSchema` omitted from `tools/list` by default (`--output-schema full` adds it; responses are validated either way).

| Profile | Adds |
|---|---|
| `wiki` | the 7 `causoryn_wiki_*` tools |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | all 29 legacy tools plus `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 tools); superseded legacy tools carry a deprecation note |

Profiles combine with commas (`wiki,history`). Precedence is `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`; every supplied value is validated and an unknown name stops the server at startup.

- **Entry written by `setup`:** run `npx causoryn@latest setup --client zcode --tool-profile wiki,history --yes`, or append `"--tool-profile", "wiki,history"` to `mcp.servers.causoryn.args` in `~/.zcode/cli/config.json` by hand. Re-running `setup` keeps the entry's `env`, `--tool-profile` and `--output-schema` arguments and other keys you added; pass `setup --tool-profile <list>` to change the profile.
- **Development fixture (bare entrypoint, no CLI flags):** add `"CAUSORYN_TOOL_PROFILE": "full"` to the `env` block of the fixture manifest.
- **Marketplace plugin:** the manifest lives in the installed plugin and should not be edited. Whether ZCode forwards `CAUSORYN_TOOL_PROFILE` from its environment to plugin servers has not been verified; use the CLI setup path if you need a non-default profile.

**Shared data directory.** With `--auto-data-dir`, the index lives at `<base>/workspaces/<slug>-<hash12>/graph.sqlite`, with export output under `.../exports/`; the base is `--data-dir` > `~/.causoryn` for every host, ZCode included (`ZCODE_PLUGIN_DATA` only as a fallback when `~/.causoryn` is unusable). All hosts therefore share one database per workspace; `--client zcode` is only a diagnostic label (`build_leases.host_label`), and a `build_leases` single-writer lease prevents two processes from publishing a snapshot at the same time. Per-host `graph-<client>.sqlite` files from releases before 0.3.0 are copied once into a missing `graph.sqlite` (the newest valid one) and left in place for `causoryn doctor` to list. Directories are created `0700`.

**First run.** Indexing runs in a `worker_threads` worker. With the packaged entrypoint (CLI setup and marketplace plugin), a tool call made before the first index is published waits up to `CAUSORYN_INDEX_WAIT_MS` (default `15000`; `0` = do not wait) and then returns `status: "partial"` with `data.status: "indexing"`, `jobId`, `progress`, and `retryAfterMs`; `causoryn_status` answers immediately.

---

## 4. Monorepo development fixture (`integrations/zcode/`)

For contributors testing from a source checkout, `integrations/zcode/` provides a local development marketplace (`causoryn-dev` in `integrations/zcode/.claude-plugin/marketplace.json`, plugin source `./causoryn`) and the plugin fixture `integrations/zcode/causoryn/.zcode-plugin/plugin.json`, which ships the single routing skill `skills/map-system/SKILL.md`.

```bash
# Build the deterministic bundle: bundle-manifest.json (36 entries) + mcp-server.mjs +
# index-worker.mjs + mcp-server.mjs.LEGAL.txt + vendored node_modules/better-sqlite3/
npm run build:bundle --workspace packages/mcp-server
```

The fixture manifest launches the compiled monorepo bundle and hands the user configuration to it as `CAUSORYN_CONFIG` (excerpt):

```json
{
  "userConfig": {
    "config_json": {
      "type": "string",
      "default": "{\"allowRoots\":[]}"
    }
  },
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs"
      ],
      "cwd": "${CLAUDE_PROJECT_DIR}",
      "env": {
        "CAUSORYN_CONFIG": "${user_config.config_json}"
      }
    }
  }
}
```

- The bundle is `mcp-server.mjs` plus its adjacent vendored `node_modules/better-sqlite3/` (native `.node` prebuilds cannot be inlined), so the whole `packages/mcp-server/dist/` directory must stay together.
- This bare entrypoint reads no CLI flags. The default `{"allowRoots":[]}` is fail-closed: workspace tools return `WORKSPACE_NOT_AUTHORIZED` until a root is declared, for example `{"allowRoots":["/path/to/your-project"],"workspaceId":"my-app"}`. Without `storage.dataDbPath` the graph is kept in memory.
- The manual desktop GUI steps (adding `integrations/zcode` through **Settings → Plugin Management → Discover → +** and setting `userConfig.config_json`) are documented in `integrations/zcode/causoryn/README.md`. As stated above, interactive GUI execution is `NOT RUN` in automated suites.

## 5. `stdout` / `stderr` hygiene

Across `causoryn.mjs mcp`, `plugin-mcp-launcher.mjs`, and the bare `mcp-server.mjs`, `stdout` carries **only JSON-RPC 2.0 MCP frames**. All diagnostics and start-up logs go to `stderr` with a `[causoryn]` or `[causoryn-launcher]` prefix, keeping ZCode's `stdio` transport clean.

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Servers from `~/.agents/mcp.json` are not available in ZCode | ZCode reads `~/.agents/mcp.json` only while `mcp.servers` is absent. `setup` copies those entries only when it creates `mcp.servers` itself; if `mcp.servers` already existed, copy the entries into it manually. |
| `setup` stops with `cli/malformed-json` | `~/.zcode/cli/config.json` or `~/.agents/mcp.json` is not valid JSON, or `mcp` / `mcp.servers` is not an object. Fix it or restore the `.causoryn.backup`; nothing was written. |
| `doctor` shows `ERROR` for the entry script | `~/.causoryn/runtime` or the original install was removed. Re-run `npx causoryn@0.3.2 setup --client zcode --yes`. |
| `[causoryn-launcher]` version mismatch (exit `2`) | The installed plugin package does not match `--expected-version`. Update or reinstall the plugin. |
| Server exits at start with "Unsupported Node.js version" | Node.js < 24. Install Node.js 24+ and re-run `setup`. |
| Workspace tools return `WORKSPACE_NOT_AUTHORIZED` | `ZCODE_PROJECT_DIR` was refused and no safe root came from `roots/list`, or the fixture has no `allowRoots`. Open the project folder itself in ZCode, or declare the root. |
| Wiki or history tools are missing from `tools/list` | Default `core` profile. See section 3. |

## Related pages

- [5-Minute Quickstart](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md) · [MCP Tool Contracts](../tool-contracts.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/zcode.md)
- Other host guides: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [Antigravity](antigravity.md)
- Monorepo fixture reference: `integrations/zcode/causoryn/README.md`
