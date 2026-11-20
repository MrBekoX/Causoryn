# Connecting Causoryn to Codex CLI (stdio MCP)

> **Language / Dil:** [Türkçe](../../hosts/codex.md) · English · [Compatibility Matrix](../compatibility-matrix.md)

> Evidence: **K-021/K-022 distribution (`2026-11-19`):** `codex --version` → `codex-cli 0.169.0`
> verified `codex plugin marketplace add` (`.agents/plugins/marketplace.json`), `codex mcp add/list`,
> and `npx causoryn@0.2.0 setup --client codex`. **Historical F4 monorepo bundle smoke evidence:**
> `codex --version` → `codex-cli 0.163.0`; `codex mcp --help`, `codex mcp add --help`,
> `codex mcp list --help`, and `codex mcp remove --help` outputs (syntax checked on `2026-11-08` and
> **re-run live on `2026-11-10`**: `mcp add causoryn-smoke` → visible in `mcp list` → `mcp remove` →
> absent in `mcp list`; `config.toml` restored from backup afterward — see §5 re-serialization note).
> Monorepo bundle artifact: `packages/mcp-server/dist/mcp-server.mjs` (F1 esbuild output; external
> `better-sqlite3` prebuilds live under `dist/node_modules/` — not a standalone single file;
> distribute the entire `dist/` directory). Verification test: `tests/hosts-docs.test.ts`.

Causoryn is a local, deterministic, LLM-free MCP code-intelligence engine (`causoryn@0.2.0`). Unlike
Claude Code, Codex CLI **has no project/local scope option** in `codex mcp add` — registrations write
to user-wide `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Always use an explicit name such
as `causoryn-smoke` for temporary smoke runs and clean up via `codex mcp remove`.

## 0. End-User Quick Setup (Recommended — K-021 / `v0.2.0`)

### Option 0A — One-Command CLI (`npx causoryn@0.2.0 setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@0.2.0 setup --client codex --dry-run

# Configure $CODEX_HOME/config.toml [mcp_servers.causoryn] + ~/.agents/skills/ (with .causoryn.backup)
npx causoryn@0.2.0 setup --client codex --yes

# Read-only health & alignment check
npx causoryn@0.2.0 doctor

# Clean removal (removes [mcp_servers.causoryn] + 4 routing skills)
npx causoryn@0.2.0 setup --client codex --uninstall --yes
```

**`v0.2.0` `CODEX_HOME` and `startup_timeout_sec = 30` details:**

- **`CODEX_HOME` support:** When `CODEX_HOME` is set in the environment, both
  `causoryn setup --client codex` and `causoryn doctor` read and update `$CODEX_HOME/config.toml`,
  defaulting to `~/.codex/config.toml` when unset (`resolveEffectiveCodexHomeDir` in
  `packages/causoryn/src/setup.ts`). The 4 canonical routing skills (`causoryn`, `map-system`,
  `preflight-change`, `verify-change`) are installed into `~/.agents/skills/`.
- **Surgical TOML patching + `startup_timeout_sec = 30`:** Unlike `codex mcp add`, `causoryn setup`
  patches only the `[mcp_servers.causoryn]` table (`upsertCodexMcpServer`) without re-serializing
  neighboring TOML sections, writes an atomic `.causoryn.backup` copy first, and sets
  `startup_timeout_sec = 30` so cold Node.js + SQLite initialization has reliable headroom.

### Option 0B — Native Codex Plugin Marketplace

The repository root `.agents/plugins/marketplace.json` and packaged
`packages/causoryn/.codex-plugin/plugin.json` (+ `.codex-plugin/mcp.json`) conform to the Codex
plugin marketplace schema (verified on `2026-11-19` with `codex-cli 0.169.0` via
`codex plugin marketplace add` + `codex mcp add/list`):

- `.agents/plugins/marketplace.json` declares `source: { "source": "npm", "package": "causoryn", "version": "0.2.0" }` along with `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` (Causoryn requires no external credentials or API keys; `"ON_INSTALL"` satisfies the Codex marketplace policy schema for install-time confirmation).
- `packages/causoryn/.codex-plugin/mcp.json` launches `causoryn@0.2.0` with `--allow-cwd --auto-data-dir --client codex` and `"startup_timeout_sec": 30`.

---

## Monorepo Developer Workflow (F1 Bundle — `packages/mcp-server/dist/`)

### 1. Prerequisite: build the bundle

```bash
cd packages/mcp-server
npm run build:bundle   # deterministic esbuild output + external native binding copy
```

Output contract (35-file `bundle-manifest.json`):

```
packages/mcp-server/dist/
├── bundle-manifest.json              ← sorted sha256 manifest (35 entries)
├── mcp-server.mjs                    ← stdio entrypoint
├── mcp-server.mjs.LEGAL.txt          ← bundled third-party license notices emitted by esbuild
└── node_modules/better-sqlite3/      ← external native module (LICENSE + package.json + lib/ + prebuilds/)
```

### 2. Method A — `config.toml` block (manual edit)

Add the following TOML table to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

```toml
[mcp_servers.causoryn]
command = "node"
args = ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
startup_timeout_sec = 30
```

- Use an **absolute** path in `args` (Codex spawns MCP servers regardless of current working directory).
- To pass environment variables, prefer `--env <KEY=VALUE>` via `codex mcp add` (see §3 and §6) or
  consult your Codex CLI version's `config.toml` environment table schema (`env` / `env_vars`).

### 3. Method B — `codex mcp add` (recommended over manual TOML edits)

```bash
codex mcp add causoryn -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Syntax (`codex mcp add --help`):
`codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`. Everything after `--` is the server
launch command; pass `--env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'` to authorize
a workspace root (see §6).

### 4. Verification

```bash
codex mcp list            # human-readable output
codex mcp list --json     # machine-readable JSON output
codex mcp get causoryn    # inspect single server entry
```

Expected: `causoryn` appears with command `node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs`.

**Honest limitations (`0.163.0` live evidence, `2026-11-10`; unchanged in `0.169.0`):**

- `codex mcp list` **performs no live health check** — it reads `config.toml` without spawning the
  server process. Unlike Claude Code, there is no `✔/✘ Connected` probe in `mcp list`; actual
  process spawn and handshake occur inside a live Codex session (and are verified separately by our
  automated stdio spawn tests and Claude Code handshake runs).
- `codex mcp add` does not validate the script path at registration time: registering an invalid path
  (`node Z:/definitely/not/here.mjs`) succeeds and displays as `enabled` in `list`, failing only at
  session startup.
- Querying an unregistered server name returns a hard error:
  `codex mcp get no-such-server-xyz` → `Error: No MCP server named 'no-such-server-xyz' found.`
  (exit 1).

### 5. Cleanup

```bash
codex mcp remove causoryn
```

Verify that `causoryn` no longer appears in `codex mcp list`. **Smoke test discipline:** for
non-permanent tests, register under a dedicated name such as `causoryn-smoke` and confirm removal
afterward:

```bash
codex mcp add causoryn-smoke -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # ← causoryn-smoke is gone (user config clean)
```

**TOML re-serialization warning (`0.163.0` live finding, `2026-11-10`):** `codex mcp add` and
`codex mcp remove` parse and **re-serialize** `~/.codex/config.toml` from scratch. While the
`causoryn` block is cleanly added and removed, formatting of neighboring `[mcp_servers.*]` tables
may change (for example, key ordering inside `env` or `startup_timeout_sec = 120` rewritten as
`120.0`) — **byte-level invariance is not guaranteed** by `codex mcp`. Back up `config.toml` before
manual smoke tests and compare hashes afterward:

```bash
cp ~/.codex/config.toml /tmp/config.toml.bak
sha256sum ~/.codex/config.toml   # before
# ... add → list → remove → list ...
sha256sum ~/.codex/config.toml   # after; restore backup if formatting drifted
```

### 6. Configuration: `CAUSORYN_CONFIG` (Spec §20)

`CAUSORYN_CONFIG` is supplied as a JSON string; when unset, fail-closed default deny `allowRoots: []`
is active (workspace tools return `WORKSPACE_NOT_AUTHORIZED`):

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### 7. `stdout` hygiene (Red Rule 4)

The Causoryn server process writes **only MCP protocol frames** to `stdout`; all operational logs go
to **`stderr`** prefixed with `[causoryn]` so log lines never interfere with Codex's JSON-RPC pipe.
Manual verification (`2026-11-08` on `causoryn@0.1.0`; preserved in `causoryn@0.2.0`): 2 lines of
pure JSON-RPC on `stdout` (`initialize` + `tools/list` → **29 tools**), `[causoryn]` logs strictly
on `stderr`.

## Related pages

- [Türkçe sürüm](../../hosts/codex.md)
- [Compatibility Matrix](../compatibility-matrix.md)
- Other host guides: [Claude Code](claude-code.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
