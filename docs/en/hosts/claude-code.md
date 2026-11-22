# Connecting Causoryn to Claude Code (stdio MCP)

> **Language / Dil:** [Türkçe](../../hosts/claude-code.md) · English · [Compatibility Matrix](../compatibility-matrix.md)

> Evidence: **K-021/K-022 distribution (`2026-11-19`):** `claude --version` → `2.1.328 (Claude Code)`
> verified `claude plugin validate --strict` (repository root `.claude-plugin/marketplace.json`),
> `claude mcp list` `√ Connected`, and `npx causoryn@0.2.1 setup --client claude-code`.
> **Historical F3 monorepo bundle smoke evidence:** `claude --version` → `2.1.322 (Claude Code)`;
> `claude mcp --help` and `claude mcp add --help` outputs (syntax first checked on `2026-11-08`
> with `2.1.319`, **re-verified end-to-end on `2026-11-10` with `2.1.322`**: `mcp add` → `mcp list`
> `✔ Connected` → `mcp remove` inside a redirected temporary config directory; `sha256sum ~/.claude.json`
> identical before and after smoke). Monorepo bundle artifact:
> `packages/mcp-server/dist/mcp-server.mjs` (F1 esbuild output; external `better-sqlite3` prebuilds
> live under `dist/node_modules/` — not a standalone single file; distribute the entire `dist/`
> directory). Verification test: `tests/hosts-docs.test.ts`.

Causoryn is a local, deterministic, LLM-free MCP code-intelligence engine (`causoryn@0.2.1`). If
Claude Code is not installed yet, install it with `npm install -g @anthropic-ai/claude-code`.

## 0. End-User Quick Setup (Recommended — K-021 / `v0.2.1`)

### Option 0A — One-Command CLI (`npx causoryn@0.2.1 setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@0.2.1 setup --client claude-code --dry-run

# Configure ~/.claude.json + ~/.claude/skills/ (with .causoryn.backup and persistent ~/.causoryn/runtime)
npx causoryn@0.2.1 setup --client claude-code --yes

# Read-only health & alignment check
npx causoryn@0.2.1 doctor

# Clean removal (removes mcpServers.causoryn + 4 routing skills)
npx causoryn@0.2.1 setup --client claude-code --uninstall --yes
```

**`v0.2.1` `CLAUDE_CONFIG_DIR` support:** When `CLAUDE_CONFIG_DIR` is set in the environment, both
`causoryn setup --client claude-code` and `causoryn doctor` target `$CLAUDE_CONFIG_DIR/.claude.json`
and `$CLAUDE_CONFIG_DIR/skills/` instead of `~/.claude.json` and `~/.claude/skills/`
(`resolveEffectiveClaudeConfigDir` in `packages/causoryn/src/setup.ts`). Multi-profile setups and
isolated CI/smoke runs never touch the user's primary home configuration.

### Option 0B — Native Claude Code Plugin Marketplace

```text
/plugin marketplace add MrBekoX/Causoryn
/plugin install causoryn@causoryn
```

- **Marketplace manifest & `--expected-version 0.2.1` launcher guard:** The root
  `.claude-plugin/marketplace.json` (`source: { "source": "npm", "package": "causoryn", "version": "0.2.1" }`)
  and packaged `packages/causoryn/.claude-plugin/plugin.json` launch the server via
  `${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs --expected-version 0.2.1 --allow-cwd --auto-data-dir --client claude-code`.
  `plugin-mcp-launcher.mjs` verifies `package.json` `version === "0.2.1"` (and cross-checks
  `CAUSORYN_EXPECTED_VERSION` if set) without spawning a nested `npx` child process, exits `2` with
  a diagnostic on `stderr` on any version mismatch, sets `CAUSORYN_ASSET_ROOT`, and imports
  `dist/mcp-server.mjs` directly while keeping `stdout` strictly reserved for MCP JSON-RPC frames.

> **`2026-11-19` live CLI evidence (`claude 2.1.328`):** `claude plugin validate --strict` succeeded
> against the root `.claude-plugin/marketplace.json`, and the registered server reported
> `√ Connected` in `claude mcp list`.

---

## Monorepo Developer Workflow (F1 Bundle — `packages/mcp-server/dist/`)

The steps below are for contributors wiring the local esbuild bundle directly from a source checkout.

### 1. Prerequisite: build the bundle

```bash
cd packages/mcp-server
npm run build:bundle   # deterministic esbuild output + external native binding copy
```

Output contract (bit-for-bit deterministic across builds, 35-file `bundle-manifest.json`):

```
packages/mcp-server/dist/
├── bundle-manifest.json              ← sorted sha256 manifest (35 entries)
├── mcp-server.mjs                    ← stdio entrypoint (sha256 pinned in bundle-manifest.json)
├── mcp-server.mjs.LEGAL.txt          ← bundled third-party license notices emitted by esbuild
└── node_modules/better-sqlite3/      ← external native module (LICENSE + package.json + lib/ + prebuilds/)
```

Do **not** move `mcp-server.mjs` by itself; always keep the `dist/` directory intact (native
`.node` prebuilds plus `mcp-server.mjs.LEGAL.txt` and `better-sqlite3/LICENSE` are required alongside
the entrypoint, totaling 35 tracked files in `bundle-manifest.json`).

### 2. Method A — project-scoped `.mcp.json` (shareable with your team)

Place a `.mcp.json` file at your project root:

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

- Use an **absolute** path in `args` whenever Causoryn lives outside the target project directory.
- On first use, Claude Code marks `.mcp.json` servers as "Pending approval"; `claude mcp list`
  reflects approval status. Project approval choices can be reset via
  `claude mcp reset-project-choices` (`claude mcp --help`).

### 3. Method B — `claude mcp add` (local scope)

The default scope of `claude mcp add` is **local** (`-s local` / `--scope local` writes the entry
under the current project key in `~/.claude.json` without affecting other projects):

```bash
cd /path/to/your-project
claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Notes:

- Everything after `--` is the server launch command (`claude mcp add --help`).
- `stdio` is the default transport (`-t stdio` is optional).
- Pass `-s user` only if you want a user-wide registration; **this guide recommends `local`**
  (least-privilege principle).

### 4. Verification

```bash
claude mcp list
```

Expected: `causoryn` appears in the list with a connected health-check indicator. `claude mcp list`
actually spawns the server process and performs an MCP handshake — the live `2.1.322` run returned
`causoryn: node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs - ✔ Connected`
(re-confirmed as `√ Connected` on `2026-11-19` with `2.1.328`). To inspect a single server entry:

```bash
claude mcp get causoryn
```

**Negative behavior (`2.1.322` live evidence, `2026-11-10`):** A server registered with a
non-existent script path (`node Z:/definitely/not/here.mjs`) is reported by `claude mcp list` as
`✘ Failed to connect — CONNECTION_CLOSED`; the host never masks startup failures silently. Note
that `claude mcp add` itself does not validate the command path at registration time — errors
surface during the `list` / `get` health check.

### 5. Cleanup

```bash
claude mcp remove causoryn
```

When `-s` is omitted, Claude Code removes the server from whichever scope holds it
(`claude mcp remove --help`).

### 6. `stdout` hygiene (Red Rule 4)

The Causoryn server process writes **only MCP protocol frames** to `stdout`; all operational logs
are emitted with the `[causoryn]` prefix on **`stderr`**, guaranteeing that log lines never corrupt
the host JSON-RPC stream. Manual verification (`2026-11-08` on `causoryn@0.1.0`; preserved in
`causoryn@0.2.1`):

- `stdout`: 2 lines of pure JSON-RPC (`initialize` response + `tools/list` → **29 tools**)
- `stderr`: only `[causoryn]` default-deny startup notice + ready log

### 7. Configuration: `CAUSORYN_CONFIG` (Spec §20)

The bare monorepo entrypoint `packages/mcp-server/dist/mcp-server.mjs` (`src/stdio.ts`) reads
authorized workspace roots from the `CAUSORYN_CONFIG` environment variable (JSON). When unset,
fail-closed default deny applies (`allowRoots: []` → workspace tools return
`WORKSPACE_NOT_AUTHORIZED`; no directory is authorized implicitly):

```bash
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### 8. Smoke test protocol (zero residue in user config)

#### 8a. Redirected protocol (recommended; re-verified end-to-end on `2026-11-10` with `claude 2.1.322`)

Setting `CLAUDE_CONFIG_DIR` redirects all Claude Code configuration writes into a temporary
directory so not a single byte touches your real `~/.claude.json`:

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$(cygpath -w "$TMP_CFG")"   # Windows / Git Bash

claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
# → output shows "File modified: $TMP_CFG/.claude.json"

claude mcp list          # → causoryn … ✔ Connected
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Cleanliness proof: `sha256sum ~/.claude.json` is bit-for-bit identical before and after the run.

#### 8b. Honest residue note (unredirected workflow)

Running `claude mcp add` / `claude mcp remove` **without** `CLAUDE_CONFIG_DIR` can leave an empty
project-ledger key inside `~/.claude.json` (`"mcpServers": {}` plus `allowedTools` /
`hasTrustDialogAccepted` bookkeeping fields) for the temporary directory. While the `causoryn`
server entry itself is deleted completely by `remove`, Claude Code (`2.1.319` / `2.1.322`) exposes
no CLI subcommand to prune an empty project ledger key. Always use the `CLAUDE_CONFIG_DIR`
redirection in §8a for smoke testing.

Note: any `claude` CLI invocation may update global session telemetry counters (such as
`pluginUsage`) when unredirected; that behavior belongs to the host CLI rather than MCP registration.

## Related pages

- [Türkçe sürüm](../../hosts/claude-code.md)
- [Compatibility Matrix](../compatibility-matrix.md)
- Other host guides: [Codex CLI](codex.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
