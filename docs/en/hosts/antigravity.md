# Antigravity Host Integration — plugin.json + mcp_config.json + mcp.json

> **Language / Dil:** [Türkçe](../../hosts/antigravity.md) · English · [Compatibility Matrix](../compatibility-matrix.md)

> Evidence: Technical Specification v2.1 §17.1 ("Antigravity plugin (primary package)"), §17.4
> compatibility/trust matrix, §22 ("if `agy` CLI is absent, explicitly report not run") ·
> Antigravity built-in plugin documentation (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md`) ·
> `packages/causoryn` (K-021 unified distribution package) ·
> `integrations/antigravity/causoryn/plugin.json` ·
> `integrations/antigravity/causoryn/mcp_config.json` ·
> `integrations/antigravity/causoryn/mcp.json` ·
> `integrations/antigravity/causoryn/README.md` ·
> `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`

## End-User Quick Setup (Recommended — K-021 / `v0.2.2`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@0.2.2 setup --client antigravity --dry-run

# Configure ~/.gemini/config/mcp_config.json + ~/.gemini/config/skills/ (with .causoryn.backup)
npx causoryn@0.2.2 setup --client antigravity --yes

# Read-only health & alignment check
npx causoryn@0.2.2 doctor

# Clean removal (removes mcpServers.causoryn + 4 routing skills)
npx causoryn@0.2.2 setup --client antigravity --uninstall --yes
```

Note: When a secondary `~/.gemini/antigravity/mcp_config.json` file already exists on disk,
`causoryn setup` and `causoryn doctor` synchronize and validate it alongside the primary
`~/.gemini/config/mcp_config.json`. End users can also install directly from the repository root
(`https://github.com/MrBekoX/Causoryn`, root `plugin.json` + `mcp_config.json`). The
`integrations/antigravity/causoryn/` section below documents the monorepo F1 staged bundle fixture
and Spec §17.1 / §22 verification records.

## Honesty Statement — NOT RUN (`agy` CLI) vs Direct `stdio` Protocol Verification

**`agy` CLI was not found — CLI plugin installation and smoke tests were NOT RUN on this host.**

Machine evidence (`2026-11-08` / `2026-11-18`):

- **Antigravity IDE is installed** (`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`, Electron
  desktop app), but no `agy` CLI binary exists in the installation directory (`agy*` search empty,
  no `bin/` subdirectory).
- `agy --version` → `bash: line 3: agy: command not found`
- `command -v agy` → empty output.

Spec §22 applies directly: *"If `agy` CLI is absent, explicitly report that it was not run."*

**Honest verification boundary (ADR-010, Red Rule 5):**

1. **Direct `stdio` protocol verification (EXECUTED IN AUTOMATED TESTS):** After staging
   `integrations/antigravity/causoryn/scripts/mcp-server.mjs` (+ vendored `better-sqlite3`) via
   `npm run build:bundle --workspace packages/mcp-server`, `antigravity-plugin.test.ts` spawns a
   real `child_process.spawn` session in `cwd: PLUGIN_DIR` using the exact `command` + `args` +
   `env` from `mcp_config.json`: `initialize` → `causoryn@0.2.2`, `tools/list` → 29 tools,
   `causoryn_get_capabilities` → `status: "ok"`, `causoryn_workspace_summary` →
   `WORKSPACE_NOT_AUTHORIZED`, and pure JSON-RPC 2.0 lines on `stdout`.
2. **`agy` CLI install/smoke commands (`NOT RUN`):** The `agy plugin validate --strict`,
   `agy plugin install`, and `agy plugin list` commands below are **documentation examples from
   Spec §17.1; because `agy` CLI is unavailable on this machine, none of them were executed**
   (`NOT RUN`) and no CLI/IDE installation claim is made.

## Prerequisites

1. **`agy` CLI (Antigravity command-line tool)** — required for CLI `validate` / `install` / `list`
   workflows; absent on this verification host (`NOT RUN`). The built-in Antigravity plugin loader
   reads `plugin.json` + `mcp_config.json` directly from the plugin directory.
2. **Node.js ≥ 24** (root `package.json` → `engines.node`).
3. **Compiled and staged bundle**: `npm run build:bundle --workspace packages/mcp-server` (this
   script is defined in `packages/mcp-server/package.json` → `scripts.build:bundle`, not in root
   `package.json` — running it without `--workspace packages/mcp-server` fails with
   `Missing script`). It produces the 35-entry `bundle-manifest.json` + `mcp-server.mjs` +
   `mcp-server.mjs.LEGAL.txt` + `node_modules/better-sqlite3/` under `packages/mcp-server/dist/` and
   deterministically stages identical copies into `integrations/antigravity/causoryn/scripts/`
   (`scripts/mcp-server.mjs`, `scripts/mcp-server.mjs.LEGAL.txt`,
   `scripts/node_modules/better-sqlite3/{LICENSE,package.json,lib,prebuilds}`,
   `scripts/bundle-manifest.json`; gitignored). Honest packaging statement (ADR-010): the artifact
   is **not a standalone single file** — `better-sqlite3` is a native addon whose `.node` binaries
   cannot be embedded by `esbuild`; `mcp-server.mjs` must always travel together with its adjacent
   vendored `node_modules/better-sqlite3` directory.

## Package Layout — Spec §17.1 + Built-in Antigravity Loader Dual Compatibility

| Target component (`integrations/antigravity/causoryn/`) | Status |
|---|---|
| `plugin.json` | ✅ Present (`$schema` omitted; strictly restricted to keys accepted by the built-in loader) |
| `mcp_config.json` | ✅ Present (primary MCP definition read by the built-in Antigravity plugin loader; `"scripts/mcp-server.mjs"`) |
| `mcp.json` | ✅ Present (Spec §17.1 portable manifest counterpart; `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`) |
| `README.md` | ✅ Present (user-facing setup, security model, and `NOT RUN` disclosure) |
| `scripts/mcp-server.mjs` (+ `scripts/node_modules/better-sqlite3/` + `scripts/bundle-manifest.json`) | ✅ Staged deterministically by `npm run build:bundle --workspace packages/mcp-server` (gitignored) |
| `skills/` (`causoryn`, `map-system`, `preflight-change`, `verify-change`) | ⚠️ Omitted in the monorepo fixture; all 4 canonical skills are published at root `skills/` and in `packages/causoryn` |
| `agents/`, `rules/`, `hooks.json` | ❌ Not included (separate slice) |

**Dual-manifest and path resolution rationale:**

- The built-in Antigravity plugin loader (`agy-customizations/docs/plugins.md`,
  `plugin/SKILL.md:200-266`) reads **`mcp_config.json`** at the plugin root and resolves the
  plugin-relative path `"scripts/mcp-server.mjs"`.
- Spec §17.1's portable plugin contract specifies **`mcp.json`** with
  `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`. Both manifests converge on the staged
  `scripts/mcp-server.mjs` entrypoint with zero parent-directory traversal.
- Because MCP server names share a global namespace across Antigravity plugins
  (`plugin/SKILL.md:304-306`), both manifests use the plugin-specific key **`causoryn`** rather than
  a generic name.

## `plugin.json` (exact repository contents)

```json
{
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.2.2",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

Fields and why `$schema` is omitted:

| Field | Value | Source |
|---|---|---|
| `name` | `causoryn` | Built-in loader globally unique key + Spec §17.1 |
| `displayName` | `Causoryn` | Built-in loader UI title + Spec §17.1 |
| `version` | `0.2.2` | Spec §17.1 + `packages/mcp-server/src/version.ts` (`SERVER_VERSION`) |
| `description` | `Local, evidence-backed codebase and change intelligence via MCP.` | Spec §17.1 |
| `suggestedPrompts` | Three starter prompts from Spec §17.1 | Built-in loader card/detail UI + Spec §17.1 |

**Why is `$schema` omitted?** The built-in Antigravity plugin loader (`plugin/SKILL.md:228-266`)
accepts only `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`,
`homepage`, `repository`, and `disabled` as top-level keys; unknown top-level fields (including
`$schema` and `mcpServers`) are **silently discarded** by the loader. Our test suite enforces this
exact allowlist and rejects `$schema` or `mcpServers` inside `plugin.json`.

## `mcp_config.json` (primary — built-in Antigravity plugin loader)

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

## `mcp.json` (Spec §17.1 portable plugin manifest counterpart)

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

Field contract rules:

| Field | Value | Source |
|---|---|---|
| `mcpServers.causoryn` | Server key `causoryn` (prevents global namespace collisions) | `plugin/SKILL.md` + Spec §17.1 |
| `command` | `node` — local `stdio` process; zero LLM or external API calls | Spec §17.1 + Red Rule 1 |
| `args[0]` | `mcp_config.json`: `"scripts/mcp-server.mjs"` · `mcp.json`: `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` — staged compiled `esbuild` output; raw `.ts` entrypoints and parent-directory escapes are forbidden | Built-in loader + Spec §17.1 |
| `env.CAUSORYN_CONFIG` | `{"allowRoots":[]}` — **default deny**: validated by `parseCausorynServerConfig` (`z.strictObject` + absolute `allowRoots`); workspace tools return `WORKSPACE_NOT_AUTHORIZED` until a root is explicitly authorized | Spec §9/§20; `packages/mcp-server/src/config.ts` + `stdio.ts` |

**Bare `stdio.ts` vs Packaged `cli-stdio.ts` distinction (`--data-dir` / `--allow-cwd`):**

- **Bare F1 monorepo entrypoint (`packages/mcp-server/src/stdio.ts`, used by the
  `integrations/antigravity/causoryn/` fixture):** Does not parse `process.argv` — its sole
  configuration source is the `CAUSORYN_CONFIG` environment variable (therefore fixture manifests do
  not pass `--data-dir`; data roots are declared inside `CAUSORYN_CONFIG`).
- **Packaged distribution entrypoint (`packages/causoryn/dist/mcp-server.mjs`,
  `packages/mcp-server/src/cli-stdio.ts`):** Supports K-021 zero-config CLI flags (`--allow-cwd`,
  `--auto-data-dir`, `--data-dir`, `--client antigravity`) and dynamic desktop IDE MCP `roots/list`
  workspace binding (`npx causoryn@0.2.2 setup --client antigravity --yes` wires this packaged
  entrypoint).

**Cross-host rule (Spec §17.1):** *"Never copy `mcp.json` verbatim across hosts."* Claude Code
(`.mcp.json` → [claude-code.md](claude-code.md)), Codex (`.codex/config.toml` / `codex mcp add` →
[codex.md](codex.md)), and ZCode (`.zcode/cli/config.json` / `.zcode-plugin/plugin.json` →
[zcode.md](zcode.md)) each use their own host-specific configuration and variable tokens.

## Installation Steps — Documentation Example, NOT RUN

```bash
# 0) Build the bundle and stage into Antigravity scripts/ — deterministic
#    (--workspace is mandatory; root package.json has no build:bundle script)
npm run build:bundle --workspace packages/mcp-server

# 1) Manifest validation (Spec §17.1) — requires agy CLI; NOT RUN on this host
agy plugin validate --strict ./integrations/antigravity/causoryn

# 2) Installation — NOT RUN
agy plugin install ./integrations/antigravity/causoryn

# 3) Listing — NOT RUN
agy plugin list

# 4) Tool discovery — NOT RUN via agy CLI. Direct stdio spawn test verified
#    all 29 tools (TOOL_NAMES, packages/mcp-server/src/version.ts).
```

Per Spec §17.1: *"Commands are documentation examples and were not executed while preparing this
document."* Once `agy` CLI becomes available, steps 1–4 will be executed live and recorded in the
compatibility matrix.

**Cleanup protocol (Red Rule 6):** When live smoke tests are run, zero permanent changes may remain
in the user's real configuration: install under an isolated test scope and **remove the plugin at
the end of smoke** (the exact `agy` uninstall subcommand remains `NOT RUN` pending `agy` CLI
availability, matching `claude mcp remove` and `codex mcp remove` on the other hosts).

## Configuration: `CAUSORYN_CONFIG`

For the bare `stdio.ts` entrypoint, `CAUSORYN_CONFIG` (JSON validated by `parseCausorynServerConfig`)
is the single source of truth:

```bash
# Authorize a workspace root (read-only analysis; exits default deny)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'

# Declare Living Wiki SQLite path — authorized data-root OUTSIDE the workspace (Spec §16A.8)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"],"wiki":{"dataDbPath":"/path/to/causoryn-data/wiki.sqlite3"}}'
```

- `${PLUGIN_ROOT}` is the read-only plugin installation root; never confuse it with an analyzed
  workspace root, and always declare explicit absolute project paths in `allowRoots` (Spec §17.1).
- Red Rule 2: writes occur strictly inside authorized data-root / output directories outside the
  workspace (`wiki_build` and `export_documentation` fail closed with `PATH_DENIED` /
  `EXPORT_NOT_ALLOWED` when undeclared).

## Compatibility / Trust Matrix — Antigravity Row (Spec §17.4)

| Integration | Model usage | MCP installation | Conformance tests | Status on this machine |
|---|---|---|---|---|
| Antigravity | User-selected Antigravity model (Causoryn never selects or overrides models) | Plugin: `plugin.json` + `mcp_config.json` (built-in loader) + `mcp.json` (Spec §17.1) or `npx causoryn@0.2.2 setup --client antigravity --yes` | Direct `stdio` spawn verified (29 tools); `agy validate` / `install` / `list` | **NOT RUN — `agy` CLI not found** (direct `stdio` protocol handshake verified in automated tests) |

Spec §17.4: Cross-host behavioral parity is guaranteed at the MCP tool schema and contract layer;
host UI/permission equivalence is never claimed, and Causoryn cannot force a host model to invoke a
tool.

## Open Items (F5 `agy` CLI leg remains open — never marked Done per ADR-010)

1. **Checklist once `agy` CLI is available (`NOT RUN`):** `agy plugin validate --strict`,
   `agy plugin install`, `agy plugin list`, live tool discovery inside the Antigravity host
   (29 tools expected), representative `map_system` / `preflight_change` / `verify_change` calls,
   and post-smoke plugin removal leaving user config untouched.
2. **Optional plugin customizations:** `agents/`, `rules/`, `hooks.json` — separate slice.

## Related Files & Guides

- `integrations/antigravity/causoryn/plugin.json` — published plugin manifest (`$schema`-free for built-in loader compatibility)
- `integrations/antigravity/causoryn/mcp_config.json` — primary MCP config for the built-in Antigravity plugin loader
- `integrations/antigravity/causoryn/mcp.json` — Spec §17.1 portable MCP manifest counterpart
- `integrations/antigravity/causoryn/README.md` — user-facing setup and security documentation
- `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` — manifest schema, staged `stdio` spawn, negative, and honesty tests
- `packages/mcp-server/scripts/build-bundle.mjs` — `dist/` build + deterministic staging into `integrations/antigravity/causoryn/scripts/`
- Other host guides: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [ZCode](zcode.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/antigravity.md)
