# Connecting Causoryn to Claude Code (`stdio` MCP)

> **Language:** [Türkçe](../../hosts/claude-code.md) | **English** · [Compatibility Matrix](../compatibility-matrix.md)

**Verification record:** Live Claude Code CLI runs verified `claude plugin validate --strict` (root `.claude-plugin/marketplace.json`), `claude mcp list` (`Connected`), and clean removal on `claude 2.1.322` (`2026-11-10`) and `claude 2.1.328` (`2026-11-19`) using an isolated `CLAUDE_CONFIG_DIR` (`sha256sum ~/.claude.json` identical before and after).

Causoryn is a local, deterministic, zero-LLM MCP code graph and change-guard engine (`causoryn@0.2.4`).

---

## 1. Quick Setup (Recommended)

### Option A — One-Command CLI (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@latest setup --client claude-code --dry-run

# Configure ~/.claude.json + ~/.claude/skills/ (preserves original .causoryn.backup forever)
npx causoryn@latest setup --client claude-code --yes

# Read-only health & alignment check
npx causoryn@latest doctor

# Clean removal (removes mcpServers.causoryn + 5 Causoryn skills)
npx causoryn@latest setup --client claude-code --uninstall --yes
```

- **Absolute Node binary & shared DB:** `setup` writes the absolute Node executable (`process.execPath`), installs all 5 canonical skills (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`), and shares `~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite` cleanly across hosts via heartbeat single-writer leases.
- **Default lean tool profile:** Boots with the **11-tool `core` profile** (`tools/list <= 15,000` chars). Pass `--tool-profile wiki,history` or `--tool-profile full` (or set `CAUSORYN_TOOL_PROFILE`) if you want Living Wiki, Git history, or all legacy tools ([MCP Tool Contracts](../tool-contracts.md)).
- **`CLAUDE_CONFIG_DIR` support:** When `CLAUDE_CONFIG_DIR` is set, both `causoryn setup` and `causoryn doctor` target `$CLAUDE_CONFIG_DIR/.claude.json` and `$CLAUDE_CONFIG_DIR/skills/` without touching your primary home config.

### Option B — Native Claude Code Plugin Marketplace

```text
/plugin marketplace add MrBekoX/Causoryn
/plugin install causoryn@causoryn
```

The marketplace manifest launches `${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs --expected-version 0.2.4 --allow-cwd --auto-data-dir --client claude-code` directly via `node` without spawning nested `npx` subprocesses, failing closed (exit `2` on `stderr`) on any version mismatch while keeping `stdout` purely JSON-RPC 2.0.

---

## 2. Monorepo Developer Workflow (`packages/mcp-server/dist/`)

Contributors wiring a local checkout directly:

```bash
npm run build:bundle --workspace packages/mcp-server
```

Output directory (`packages/mcp-server/dist/` — multi-file because `better-sqlite3` native `.node` prebuilds cannot be inlined; 36 files tracked in `bundle-manifest.json`):

```text
packages/mcp-server/dist/
├── bundle-manifest.json
├── mcp-server.mjs
├── index-worker.mjs
├── mcp-server.mjs.LEGAL.txt
└── node_modules/better-sqlite3/
```

### Method A — Project-scoped `.mcp.json`

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
    }
  }
}
```

### Method B — `claude mcp add` (local scope)

```bash
cd /path/to/your-project
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### Verification & Cleanup

```bash
claude mcp list           # Spawns server and reports Connected (invalid path reports CONNECTION_CLOSED)
claude mcp get causoryn
claude mcp remove causoryn
```

### Isolated Smoke Protocol (Zero Residue in `~/.claude.json`)

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$TMP_CFG"

claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
claude mcp list
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Always redirect `CLAUDE_CONFIG_DIR` for smoke runs; unredirected `claude mcp add`/`remove` can leave an empty project-ledger entry inside `~/.claude.json`.

### `stdout` Hygiene

Causoryn writes exclusively MCP JSON-RPC 2.0 frames to `stdout`; all operational diagnostics go to `stderr` prefixed with `[causoryn]`.

## Related Pages

- [5-Minute Quickstart Tutorial](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/claude-code.md)
- Other host guides: [Codex CLI](codex.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
