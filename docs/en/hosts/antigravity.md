# Antigravity Host Integration — `plugin.json` + `mcp_config.json` + `mcp.json`

> **Language:** [Türkçe](../../hosts/antigravity.md) | **English** · [Documentation Hub](../README.md) · [Compatibility Matrix](../compatibility-matrix.md)

> **Status:** reflects Causoryn 0.3.0 (default `core` tool profile with 11 tools; one shared per-workspace `graph.sqlite` for all hosts). The Antigravity `agy` CLI leg is **`NOT RUN`** (see section 3).

> **Sources checked for this page:** `packages/causoryn/src/{setup.ts,doctor.ts}`, root `plugin.json` / `mcp_config.json` / `mcp.json` / `server.json`, `packages/causoryn/{plugin.json,mcp_config.json}`, `integrations/antigravity/causoryn/{plugin.json,mcp_config.json,mcp.json,README.md}`, `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`. Loader behaviour is taken from the Antigravity built-in plugin documentation (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md`).

Causoryn is a local, deterministic MCP server for code intelligence. It makes no LLM or network API calls. Antigravity uses the model the user selects; Causoryn never selects or overrides models.

## 1. End-user quick setup (`npx causoryn@0.3.0 setup`)

```bash
# Preview the planned changes without writing anything
npx causoryn@0.3.0 setup --client antigravity --dry-run

# Register the server in ~/.gemini/config/mcp_config.json and install the 5 skills into ~/.gemini/config/skills/
npx causoryn@0.3.0 setup --client antigravity --yes

# Read-only health and alignment check
npx causoryn@0.3.0 doctor --client antigravity

# Clean removal (mcpServers.causoryn + the 5 Causoryn skills)
npx causoryn@0.3.0 setup --client antigravity --uninstall --yes
```

### What `setup --client antigravity` writes

`setup` adds or replaces the `causoryn` key in `mcpServers` of the primary `~/.gemini/config/mcp_config.json`, and of the secondary `~/.gemini/antigravity/mcp_config.json` **only if that file already exists**. Other keys are kept. The entry has no `type` field:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "/path/to/node",
      "args": [
        "/path/to/home/.causoryn/runtime/scripts/causoryn.mjs",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "antigravity"
      ]
    }
  }
}
```

- **Detection:** Antigravity counts as detected only when `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json` exists. A bare `~/.gemini` directory (for example from Gemini CLI) is not treated as Antigravity (`detectInstalledClients`, covered by `tests/causoryn-setup.test.ts`).
- **Absolute Node binary:** `command` is the `process.execPath` of the Node.js that ran `setup` (Node.js ≥ 24 is required).
- **Persistent runtime:** when `setup` runs from an `_npx` cache or the OS temp directory, it first copies the package to `~/.causoryn/runtime` and points `args[0]` there, so the registration survives `npx` cache eviction.
- **Skills:** `causoryn`, `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` are written to `~/.gemini/config/skills/<name>/SKILL.md` (`--no-skill` skips them). `architecture-blueprint` guides the selected Antigravity model in drafting optional `annotations` from MCP evidence; the server renders repeatable output from the same snapshot and export inputs. To export without annotations, call `causoryn_export_documentation` directly ([architecture export contract](../tool-contracts.md)). Skills are guidance text for the host model: a tool a skill mentions can only be called if the active tool profile registers it.

### How `setup` and `doctor` behave

- **Confirmation:** without `--yes` (and without `--dry-run`), an interactive terminal shows the plan and asks `Continue? [y/N]`; a non-interactive shell stops with a "confirmation required" error and writes nothing.
- **Backups:** before an existing config is modified for the first time, the original is copied to `mcp_config.json.causoryn.backup` next to it. That file is never overwritten; later modifications create additional `mcp_config.json.causoryn.<timestamp>-<nonce>.backup` copies.
- **Atomic, idempotent, fail-closed:** temporary file + rename with the existing file mode kept (new files `0600`); an identical second run reports `noop`; invalid JSON or a non-object `mcpServers` stops the run with `cli/malformed-json`; symbolic-link targets are refused. `setup` exits `0` on success and `2` on error.
- **Uninstall:** removes `mcpServers.causoryn` from both files (an empty `mcpServers` object remains), the five skill directories, and `~/.causoryn/runtime` when no other host config still references it.
- **`doctor`** (read-only) reports the Antigravity host as `OK`, `WARN`, `NOT-CONFIGURED`, or `ERROR`. The MCP entry is looked up in the primary file; the secondary file, when present, is only checked for being valid JSON with a usable `causoryn.command`. It also checks Node.js ≥ 24, runtime files, and the `dotnet` / `python` / `go` / `cargo` toolchains (missing ones are reported as `l0-l1-fallback`, meaning file-level analysis for that language). The overall result is `HEALTHY`, `DEGRADED`, `NOT CONFIGURED`, or `UNHEALTHY`; the exit code is `0` only for `HEALTHY`.

## 2. Installing from the repository root or the npm package directory

End users can also point Antigravity's plugin loader at the repository root (`https://github.com/MrBekoX/Causoryn`) or at an installed `causoryn` npm package directory. These manifests are validated by `tests/open-source-distribution.test.ts`; loading them inside Antigravity has **not** been executed (section 3).

| Location | `plugin.json` | `mcp_config.json` server launch |
|---|---|---|
| Repository root | `name`, `displayName`, `version` `0.3.0`, `description`, `author`, `homepage`, `repository`, `suggestedPrompts` | `npx -y causoryn@0.3.0 mcp --allow-cwd --auto-data-dir --client antigravity` |
| `packages/causoryn` (published npm package) | Same fields | `node scripts/plugin-mcp-launcher.mjs --expected-version 0.3.0 --allow-cwd --auto-data-dir --client antigravity` |

The package-directory variant uses `plugin-mcp-launcher.mjs`: it checks that the installed `package.json` is `causoryn` at exactly `--expected-version` (and agrees with `CAUSORYN_EXPECTED_VERSION` if set), exits `2` with a `[causoryn-launcher]` message on `stderr` on any mismatch, and otherwise imports `dist/mcp-server.mjs` directly without a nested `npx` process.

Two further root manifests serve other MCP clients: `mcp.json` (portable `mcpServers.causoryn` with `type: "stdio"` and `npx -y causoryn@0.3.0 mcp --allow-cwd --auto-data-dir`) and `server.json` (MCP Registry entry `io.github.mrbekox/causoryn`, npm package `causoryn`, `stdio` transport, arguments `mcp --allow-cwd --auto-data-dir`).

---

## 3. Verification status — `NOT RUN` (`agy` CLI) vs direct `stdio` verification

**The `agy` CLI was not found — CLI plugin installation and smoke tests were `NOT RUN` on the verification host.**

Machine evidence (`2026-11-08` / `2026-11-18`):

- The **Antigravity IDE is installed** (`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`, an Electron desktop app), but the installation directory contains no `agy` binary (no `agy*` match, no `bin/` subdirectory).
- `agy --version` → `bash: line 3: agy: command not found`
- `command -v agy` → empty output.

Rule applied: if the `agy` CLI is absent, report explicitly that the CLI steps were not run.

**Verification boundary:**

1. **Direct `stdio` protocol verification (automated, 0.3.0 code):** after `npm run build:bundle --workspace packages/mcp-server` stages `integrations/antigravity/causoryn/scripts/mcp-server.mjs` (plus `index-worker.mjs` and the vendored `better-sqlite3`), `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` spawns a real child process in the plugin directory with the exact `command`, `args`, and `env` from `mcp_config.json` and checks: `initialize` → `serverInfo.name` `causoryn` and the current `SERVER_VERSION`; `tools/list` → exactly the 11 `core` tools; `causoryn_status` → `status: "ok"` with `data.authorized: false`; `causoryn_map_system` → `WORKSPACE_NOT_AUTHORIZED`; exactly four JSON-RPC 2.0 lines on `stdout`; the ready message on `stderr`; exit code `0`. The test is skipped when the bundle has not been staged.
2. **Packaged `setup` / `doctor` / `--uninstall`:** verified in an isolated temporary `$HOME` (`packages/causoryn/test/setup-and-doctor.test.ts`, `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`). The real `~/.gemini` profile of the verification host was not modified.
3. **`agy` CLI install/smoke commands and in-IDE plugin loading (`NOT RUN`):** the `agy plugin validate --strict`, `agy plugin install`, and `agy plugin list` commands in section 6 are documentation examples. None of them was executed, and no CLI or IDE installation claim is made.

## 4. Prerequisites for the monorepo fixture

1. **`agy` CLI** — required for the CLI `validate` / `install` / `list` workflow; absent on the verification host (`NOT RUN`). The built-in Antigravity plugin loader reads `plugin.json` + `mcp_config.json` directly from the plugin directory.
2. **Node.js ≥ 24** (root `package.json` → `engines.node`).
3. **Compiled and staged bundle:** `npm run build:bundle --workspace packages/mcp-server`. The script is defined only in `packages/mcp-server/package.json`; running it at the root without `--workspace` fails with `Missing script`. It writes `bundle-manifest.json` (36 SHA-256 entries), `mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt`, and `node_modules/better-sqlite3/` (LICENSE, `package.json`, `lib/`, `prebuilds/`) under `packages/mcp-server/dist/`, then copies the same files into `integrations/antigravity/causoryn/scripts/` (gitignored). The artifact is **not a standalone file**: `better-sqlite3` is a native addon whose `.node` binaries esbuild cannot embed, so `mcp-server.mjs` must travel with its adjacent `node_modules/better-sqlite3/` directory.

## 5. Monorepo fixture layout (`integrations/antigravity/causoryn/`)

| Component | Status |
|---|---|
| `plugin.json` | Present (`$schema` omitted; only keys the built-in loader accepts) |
| `mcp_config.json` | Present (primary MCP definition read by the built-in loader; `"scripts/mcp-server.mjs"`) |
| `mcp.json` | Present (portable manifest counterpart; `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`) |
| `README.md` | Present (setup, security model, and `NOT RUN` disclosure) |
| `scripts/mcp-server.mjs` (+ `index-worker.mjs`, `node_modules/better-sqlite3/`, `bundle-manifest.json`) | Staged deterministically by `npm run build:bundle --workspace packages/mcp-server` (gitignored) |
| `skills/` | Not part of the fixture. The five canonical skills are published in the repository `skills/` directory and in the `packages/causoryn` package. |
| `agents/`, `rules/`, `hooks.json` | Not included (optional, not started) |

**Dual manifest and path resolution:**

- The built-in Antigravity plugin loader (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md:200-266`) reads **`mcp_config.json`** at the plugin root and resolves the plugin-relative path `"scripts/mcp-server.mjs"`.
- The portable plugin contract uses **`mcp.json`** with `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`. Both manifests point at the same staged entrypoint without parent-directory traversal.
- MCP server names share one namespace across Antigravity plugins (`plugin/SKILL.md:304-306`), so both manifests use the plugin-specific key **`causoryn`** rather than a generic name.

### `plugin.json` (exact fixture contents)

```json
{
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.3.0",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

| Field | Value | Purpose |
|---|---|---|
| `name` | `causoryn` | Globally unique plugin key |
| `displayName` | `Causoryn` | Loader UI title |
| `version` | `0.3.0` | Kept in sync with `packages/mcp-server/src/version.ts` (`SERVER_VERSION`) |
| `description` | `Local, evidence-backed codebase and change intelligence via MCP.` | Loader card text |
| `suggestedPrompts` | Three starter prompts | Loader card / detail view |

**Why `$schema` is omitted:** the built-in loader (`plugin/SKILL.md:228-266`) accepts only `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`, `homepage`, `repository`, and `disabled` as top-level keys and silently discards unknown fields (including `$schema` and `mcpServers`). The fixture test enforces this allowlist and rejects `$schema` or `mcpServers` in `plugin.json`.

### `mcp_config.json` (primary — built-in loader)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "scripts/mcp-server.mjs"
      ],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

### `mcp.json` (portable counterpart)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/scripts/mcp-server.mjs"
      ],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

| Field | Value | Rule |
|---|---|---|
| `mcpServers.causoryn` | Server key `causoryn` | Avoids collisions in the shared server namespace |
| `command` | `node` | Local `stdio` process; no LLM or external API calls |
| `args[0]` | `mcp_config.json`: `"scripts/mcp-server.mjs"` · `mcp.json`: `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` | Staged compiled esbuild output; raw `.ts` entrypoints, absolute paths, and parent-directory escapes are rejected by the fixture test |
| `env.CAUSORYN_CONFIG` | `{"allowRoots":[]}` | **Default deny**, validated by `parseCausorynServerConfig` (strict object, absolute `allowRoots`); workspace tools return `WORKSPACE_NOT_AUTHORIZED` until a root is authorized |

### Bare `stdio.ts` vs packaged `cli-stdio.ts`

- **Bare monorepo entrypoint (`packages/mcp-server/src/stdio.ts`, used by this fixture):** does not read `process.argv`. Its configuration comes only from `CAUSORYN_CONFIG` and `CAUSORYN_TOOL_PROFILE`, which is why the fixture manifests pass no `--data-dir`; data paths are declared inside `CAUSORYN_CONFIG`. Without `storage.dataDbPath` the graph is kept in memory.
- **Packaged entrypoint (`packages/causoryn/dist/mcp-server.mjs`, built from `packages/mcp-server/src/cli-stdio.ts`):** supports `--allow-cwd`, `--root`, `--auto-data-dir`, `--data-dir`, `--client`, `--tool-profile`, and `--output-schema`, plus dynamic MCP `roots/list` workspace binding. `npx causoryn@0.3.0 setup --client antigravity --yes` registers this entrypoint.

**Cross-host rule:** never copy `mcp.json` verbatim across hosts. Claude Code ([claude-code.md](claude-code.md)), Codex ([codex.md](codex.md)), and ZCode ([zcode.md](zcode.md)) each use their own configuration format and variable tokens.

## 6. Installation steps — documentation example, `NOT RUN`

```bash
# 0) Build the bundle and stage it into the fixture's scripts/ (deterministic;
#    --workspace is required because the root package.json has no build:bundle script)
npm run build:bundle --workspace packages/mcp-server

# 1) Manifest validation — requires the agy CLI; NOT RUN on the verification host
agy plugin validate --strict ./integrations/antigravity/causoryn

# 2) Installation — NOT RUN
agy plugin install ./integrations/antigravity/causoryn

# 3) Listing — NOT RUN
agy plugin list

# 4) Tool discovery — NOT RUN through agy. The direct stdio spawn test verified
#    the 11 core tools (CORE_TOOL_NAMES in packages/mcp-server/src/version.ts).
```

These commands are documentation examples and were not executed while preparing this page. Once the `agy` CLI is available, steps 1–4 will be run live and recorded in the [Compatibility Matrix](../compatibility-matrix.md).

**Cleanup protocol:** a live smoke run must leave no permanent change in the user's real configuration: install in an isolated test scope and **remove the plugin at the end of the smoke run**. The exact `agy` uninstall subcommand is still unverified (`NOT RUN`); it corresponds to `claude mcp remove` and `codex mcp remove` on the other hosts.

## 7. Configuration: `CAUSORYN_CONFIG` (bare entrypoint)

For the bare `stdio.ts` entrypoint, `CAUSORYN_CONFIG` (JSON validated by `parseCausorynServerConfig`) is the single configuration source:

```bash
# Authorize a workspace root (read-only analysis; leaves default deny)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'

# Persist the graph and the Living Wiki in a data root OUTSIDE the workspace
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"],"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"},"wiki":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}}'
```

- `${PLUGIN_ROOT}` is the read-only plugin installation root. It is never an analyzed workspace root; always declare explicit absolute project paths in `allowRoots`.
- Writes happen only inside declared data or output locations outside the workspace. Without a `wiki.dataDbPath`, `causoryn_wiki_build` fails closed with `PATH_DENIED`; without `output.allowedOutputDirs`, `causoryn_export_documentation` fails closed with `EXPORT_NOT_ALLOWED`. Declared paths must exist (parent directory for database files) and lie outside every authorized root.

## 8. Tool profiles, data directory, and first run

**Tool profiles.** The server starts with the `core` profile: 11 tools (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`), with `outputSchema` omitted from `tools/list` by default (responses are still validated). `wiki` adds the 7 `causoryn_wiki_*` tools, `history` adds `causoryn_compare_architecture` and `causoryn_architecture_timeline`, and `full` registers 32 tools (the 29 legacy tools plus `causoryn_status`, `causoryn_trace`, `causoryn_contracts`, with deprecation notes on superseded legacy tools). Precedence is `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `core`; an unknown name stops the server at startup.

- **Entry written by `setup`:** append `"--tool-profile", "wiki,history"` to `args`, or add `"env": { "CAUSORYN_TOOL_PROFILE": "full" }`. Re-running `setup` rewrites the whole `causoryn` entry, so apply the change again afterwards.
- **Fixture (bare entrypoint):** only the environment variable works; add `"CAUSORYN_TOOL_PROFILE": "full"` next to `CAUSORYN_CONFIG` in `env`.

**Data directory.** The packaged entrypoint with `--auto-data-dir` stores the index at `<base>/workspaces/<slug>-<hash12>/graph.sqlite` (exports under `.../exports/`), with base `--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`. All hosts that use the same base share this one database per workspace; `--client antigravity` is only a diagnostic label (`build_leases.host_label`), and the `build_leases` single-writer lease prevents two processes from publishing a snapshot at the same time. Per-host `graph-<client>.sqlite` files from releases before 0.3.0 are not migrated. Directories are created `0700` and must lie strictly outside every authorized root.

**First run.** Indexing runs in a `worker_threads` worker. With the packaged entrypoint, a tool call made before the first index is published waits up to `CAUSORYN_INDEX_WAIT_MS` (default `15000`) and then returns `status: "partial"` with `data.status: "indexing"` and `retryAfterMs`. `--allow-cwd` refuses unsafe start directories (`$HOME`, filesystem roots, system directories, `~/.gemini`, plugin install directories, the data directory) and then binds the first safe root reported through MCP `roots/list`.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `setup` says no supported host was detected | Neither `~/.gemini/antigravity` nor `~/.gemini/config/mcp_config.json` exists (a bare `~/.gemini` does not count). Pass `--client antigravity` explicitly. |
| `setup` stops with `cli/malformed-json` | One of the `mcp_config.json` files is not valid JSON or `mcpServers` is not an object. Fix it or restore the `.causoryn.backup`; nothing was written. |
| `doctor` shows `ERROR` for the entry script | `~/.causoryn/runtime` or the original install was removed. Re-run `npx causoryn@0.3.0 setup --client antigravity --yes`. |
| `[causoryn-launcher]` version mismatch (exit `2`) | The package directory does not match `--expected-version`. Reinstall the matching package version. |
| Workspace tools return `WORKSPACE_NOT_AUTHORIZED` | `--allow-cwd` refused the start directory and no safe root came from `roots/list`, or the fixture still has `allowRoots: []`. Open the project folder, or declare the root (section 7). |
| Wiki or history tools are missing from `tools/list` | Default `core` profile. See the tool profile notes above. |

## 9. Compatibility row — Antigravity

| Integration | Model usage | MCP installation | Conformance tests | Status on the verification host |
|---|---|---|---|---|
| Antigravity | User-selected Antigravity model (Causoryn never selects or overrides models) | `npx causoryn@0.3.0 setup --client antigravity --yes`, or plugin: `plugin.json` + `mcp_config.json` (built-in loader) + `mcp.json` (portable) | Direct `stdio` spawn (11 core tools) and isolated `setup`/`doctor` verified; `agy validate` / `install` / `list` | **`NOT RUN` — `agy` CLI not found** (direct `stdio` handshake verified in automated tests) |

Cross-host parity is defined at the MCP tool schema and contract level. Equivalent host UI or permission behaviour is not claimed, and Causoryn cannot force a host model to call a tool.

## 10. Open items (the `agy` CLI leg stays open and is not marked Done)

1. **Checklist once the `agy` CLI is available (`NOT RUN`):** `agy plugin validate --strict`, `agy plugin install`, `agy plugin list`, live tool discovery inside Antigravity (11 core tools expected with the default profile), representative `causoryn_map_system` / `causoryn_preflight_change` / `causoryn_verify_change` calls, and plugin removal at the end with the user config left untouched.
2. **Optional plugin customizations:** `agents/`, `rules/`, `hooks.json` — not started.

## Related files and guides

- `integrations/antigravity/causoryn/plugin.json` — fixture plugin manifest (`$schema`-free for the built-in loader)
- `integrations/antigravity/causoryn/mcp_config.json` — primary MCP config for the built-in loader
- `integrations/antigravity/causoryn/mcp.json` — portable MCP manifest counterpart
- `integrations/antigravity/causoryn/README.md` — user-facing setup and security documentation
- `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` — manifest schema, staged `stdio` spawn, negative, and honesty tests
- `packages/mcp-server/scripts/build-bundle.mjs` — `dist/` build and deterministic staging into `integrations/antigravity/causoryn/scripts/`
- [5-Minute Quickstart](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md) · [MCP Tool Contracts](../tool-contracts.md)
- Other host guides: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [ZCode](zcode.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/antigravity.md)
