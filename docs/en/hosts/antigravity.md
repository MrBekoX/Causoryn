# Antigravity Host Integration — `plugin.json` + `mcp_config.json` + `mcp.json`

> **Language:** [Türkçe](../../hosts/antigravity.md) | **English** · [Compatibility Matrix](../compatibility-matrix.md)

## Quick Setup (Recommended)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@latest setup --client antigravity --dry-run

# Configure ~/.gemini/config/mcp_config.json + ~/.gemini/config/skills/ (preserves original .causoryn.backup)
npx causoryn@latest setup --client antigravity --yes

# Read-only health & alignment check
npx causoryn@latest doctor

# Clean removal (removes mcpServers.causoryn + 5 Causoryn skills)
npx causoryn@latest setup --client antigravity --uninstall --yes
```

- **Detection accuracy:** `causoryn setup` detects Antigravity only when `~/.gemini/antigravity` or `~/.gemini/config/mcp_config.json` exists — a bare `~/.gemini` directory from Gemini CLI is never misdetected as Antigravity.
- **Dual config & absolute Node path:** `setup` writes the absolute Node binary (`process.execPath`), updates `~/.gemini/config/mcp_config.json` (plus `~/.gemini/antigravity/mcp_config.json` if already present), preserves your original `.causoryn.backup` forever, and installs all 5 canonical skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`).
- **Tool profiles:** By default the server exposes the lean **11-tool `core` profile** (`tools/list <= 15,000` chars). Pass `--tool-profile wiki,history` or `--tool-profile full` (or set `CAUSORYN_TOOL_PROFILE`) to enable Living Wiki, Git history, or all legacy tools ([MCP Tool Contracts](../tool-contracts.md)).

End users can also install directly from the repository root (`https://github.com/MrBekoX/Causoryn`, root `plugin.json` + `mcp_config.json`).

---

## Verification Status — `NOT RUN` (`agy` CLI) vs Direct `stdio` Verification

**`agy` CLI was not present on the verification host — CLI plugin installation and smoke tests were `NOT RUN`.**

- Antigravity IDE desktop app (`Antigravity.exe`) is installed without a standalone `agy` CLI binary (`agy --version` -> command not found; `command -v agy` empty).
- **Direct `stdio` protocol verification (AUTOMATED):** After staging `integrations/antigravity/causoryn/scripts/mcp-server.mjs` (+ `index-worker.mjs` and vendored `better-sqlite3`) via `npm run build:bundle --workspace packages/mcp-server`, `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` spawns a real child process using the exact `command`, `args`, and `env` from `mcp_config.json`, verifying `initialize`, `tools/list`, default-deny `WORKSPACE_NOT_AUTHORIZED`, and pure JSON-RPC 2.0 framing on `stdout`.
- **`agy` CLI commands (`NOT RUN`):** `agy plugin validate --strict`, `agy plugin install`, and `agy plugin list` below are documentation examples that were **not** executed on this machine.

---

## Monorepo Fixture Layout (`integrations/antigravity/causoryn/`)

| Component | Status |
|---|---|
| `plugin.json` | Present (`$schema` omitted; strictly restricted to keys accepted by the built-in loader: `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`, `homepage`, `repository`, `disabled`) |
| `mcp_config.json` | Present (primary MCP config read by Antigravity's built-in plugin loader; `"scripts/mcp-server.mjs"`) |
| `mcp.json` | Present (portable manifest counterpart using `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`) |
| `README.md` | Present (setup, security boundaries, and `NOT RUN` disclosure) |
| `scripts/mcp-server.mjs` (+ `index-worker.mjs` + vendored `better-sqlite3` + `bundle-manifest.json`) | Staged deterministically by `npm run build:bundle --workspace packages/mcp-server` (gitignored; multi-file because native `.node` addons cannot be inlined) |
| `skills/` | Published in the repository root `skills/` directory and inside `packages/causoryn` |
| `agents/`, `rules/`, `hooks.json` | Not included in this fixture (tracked as optional post-1.0 extensions) |

### `plugin.json`

```json
{
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.2.4",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

### `mcp_config.json` (built-in loader) & `mcp.json` (portable)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["scripts/mcp-server.mjs"],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

`mcp.json` uses `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`. Both default to fail-closed `{"allowRoots":[]}` on the bare `stdio.ts` entrypoint until a workspace root is explicitly authorized; the packaged `packages/causoryn` entrypoint (`cli-stdio.ts`, wired by `npx causoryn setup`) supports zero-config `--allow-cwd --auto-data-dir` and dynamic MCP `roots/list` workspace binding with shared `graph.sqlite` storage.

---

## CLI Checklist (Documentation Example — `NOT RUN`)

```bash
# 0) Build and stage the multi-file bundle into integrations/antigravity/causoryn/scripts/
npm run build:bundle --workspace packages/mcp-server

# 1–3) Requires agy CLI (NOT RUN on verification host)
agy plugin validate --strict ./integrations/antigravity/causoryn
agy plugin install ./integrations/antigravity/causoryn
agy plugin list
```

## Related Guides

- [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [ZCode](zcode.md)
- [5-Minute Quickstart Tutorial](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/antigravity.md)
