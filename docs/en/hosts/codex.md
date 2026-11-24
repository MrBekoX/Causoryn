# Connecting Causoryn to Codex CLI (`stdio` MCP)

> **Language:** [Türkçe](../../hosts/codex.md) | **English** · [Compatibility Matrix](../compatibility-matrix.md)

**Verification record:** Live Codex CLI runs verified `codex mcp add` -> `list` -> `remove` -> `list` on `codex-cli 0.163.0` (`2026-11-10`) and `codex plugin marketplace add` + `mcp add/list` on `codex-cli 0.169.0` (`2026-11-19`).

Causoryn is a local, deterministic, zero-LLM MCP code graph and change-guard engine (`causoryn@0.2.4`). Unlike Claude Code, `codex mcp add` writes to user-wide `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) rather than a per-project scope.

---

## 1. Quick Setup (Recommended)

### Option A — One-Command CLI (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@latest setup --client codex --dry-run

# Surgically patch $CODEX_HOME/config.toml [mcp_servers.causoryn] + install 5 skills into ~/.agents/skills/
npx causoryn@latest setup --client codex --yes

# Read-only health & alignment check
npx causoryn@latest doctor

# Clean removal (removes [mcp_servers.causoryn] + 5 Causoryn skills)
npx causoryn@latest setup --client codex --uninstall --yes
```

- **Surgical TOML patching & permanent backup:** Unlike `codex mcp add` (which re-serializes the entire `config.toml`), `causoryn setup` patches only `[mcp_servers.causoryn]` with `startup_timeout_sec = 30` and the absolute Node binary (`process.execPath`), preserves comments, neighbor servers, and `[mcp_servers.causoryn.tools.*]` sub-tables, and preserves your original `config.toml.causoryn.backup` forever.
- **`CODEX_HOME` support:** Respects `$CODEX_HOME/config.toml` when set, defaulting to `~/.codex/config.toml`.
- **Default lean tool profile:** Boots with the **11-tool `core` profile** (`tools/list <= 15,000` chars). Pass `--tool-profile wiki,history` or `--tool-profile full` (or set `CAUSORYN_TOOL_PROFILE`) for extended catalogs ([MCP Tool Contracts](../tool-contracts.md)).

### Option B — Native Codex Plugin Marketplace

The repository root `.agents/plugins/marketplace.json` and packaged `packages/causoryn/.codex-plugin/plugin.json` (+ `.codex-plugin/mcp.json`) follow the Codex plugin marketplace schema (`startup_timeout_sec: 30`, `--allow-cwd --auto-data-dir --client codex`).

---

## 2. Monorepo Developer Workflow (`packages/mcp-server/dist/`)

```bash
npm run build:bundle --workspace packages/mcp-server
```

Keep the full `packages/mcp-server/dist/` directory intact (`mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt`, `bundle-manifest.json`, and vendored `node_modules/better-sqlite3/`).

### Method A — Manual `config.toml` Entry

```toml
[mcp_servers.causoryn]
command = "node"
args = ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
startup_timeout_sec = 30
```

### Method B — `codex mcp add`

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### Verification & Cleanup

```bash
codex mcp list
codex mcp get causoryn
codex mcp remove causoryn
```

**Honest Codex CLI limitations:**
- `codex mcp list` reads `config.toml` without spawning the server process; live process spawn happens inside an active Codex session.
- `codex mcp add`/`remove` re-serialize `~/.codex/config.toml` from scratch (which may alter formatting of neighboring tables). Back up `config.toml` before manual smoke runs.

### `stdout` Hygiene

Causoryn writes exclusively MCP JSON-RPC 2.0 frames to `stdout`; all operational diagnostics go to `stderr` prefixed with `[causoryn]`.

## Related Pages

- [5-Minute Quickstart Tutorial](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/codex.md)
- Other host guides: [Claude Code](claude-code.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
