# Connecting Causoryn to ZCode (GLM) (CLI Config + Plugin Marketplace)

> **Language / Dil:** [Türkçe](../../hosts/zcode.md) · English · [Compatibility Matrix](../compatibility-matrix.md)

> Evidence: Technical Specification v2.1 §17, §22, §25/8 · K-002 (ZCode as fourth host adapter) ·
> K-021/K-022 (`causoryn@0.2.2` CLI setup wizard + npm plugin marketplace) · `marketplace.json` ·
> `packages/causoryn/.zcode-plugin/plugin.json` · `packages/causoryn/src/{setup.ts,doctor.ts}` ·
> `integrations/zcode/causoryn/README.md` · Verification suites: `plugin-package.test.ts`,
> `plugin-dev-marketplace.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts`,
> `tests/open-source-distribution.test.ts`, `tests/hosts-docs.test.ts`.

Causoryn is a local, deterministic, LLM-free MCP code-intelligence engine (`causoryn@0.2.2`). On
ZCode (GLM), it provides **two complementary installation surfaces**:

1. **Primary CLI Setup (recommended):** One-command configuration of `~/.zcode/cli/config.json`
   (`mcp.servers.causoryn`) + `~/.zcode/skills/` via `npx causoryn@0.2.2 setup --client zcode --yes`.
2. **Experimental ZCode Plugin Marketplace:** Repository root `marketplace.json` (`source: "npm"`)
   and packaged `.zcode-plugin/plugin.json` (guarded by `--expected-version 0.2.2`).

## Honesty Statement — Desktop GUI Installation (`NOT RUN`) vs Automated Schema & CLI Verification

- **Interactive ZCode desktop GUI installation: `NOT RUN` (ADR-010, Red Rules 5 & 6).** ZCode
  exposes no command-line plugin installer (`zcode --help` / `zcode plugin --help` do not exist;
  marketplace plugin installation is performed exclusively inside the desktop GUI). Per Red Rule 6,
  automated verification never mutates a developer's real ZCode desktop profile, so interactive
  in-GUI installation and in-GUI `tools/list` observation were **`NOT RUN`**.
- **Automatically verified surfaces:** The root `marketplace.json`, packaged
  `packages/causoryn/.zcode-plugin/plugin.json`, monorepo dev fixture
  (`integrations/zcode/.claude-plugin/marketplace.json` + `integrations/zcode/causoryn/`), isolated
  temporary-`$HOME` lifecycle of packaged `setup` / `doctor` / `--uninstall`, and `.tgz`
  `stdio` handshakes (all 29 tools) are covered by
  `plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts`, and
  `open-source-distribution.test.ts`.

---

## 1. Primary Setup — One-Command CLI (`npx causoryn@0.2.2 setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@0.2.2 setup --client zcode --dry-run

# Configure ~/.zcode/cli/config.json (mcp.servers.causoryn) + ~/.zcode/skills/
npx causoryn@0.2.2 setup --client zcode --yes

# Read-only health & alignment check
npx causoryn@0.2.2 doctor

# Clean removal (removes mcp.servers.causoryn + 5 Causoryn skills)
npx causoryn@0.2.2 setup --client zcode --uninstall --yes
```

`architecture-blueprint` guides ZCode in drafting optional `annotations` from MCP evidence. The server renders repeatable output with the same snapshot and export inputs. To export without annotations, call `causoryn_export_documentation` directly. [Architecture export contract](../tool-contracts.md)

### What `causoryn setup --client zcode` configures (`packages/causoryn/src/setup.ts`)

1. **Persistent runtime staging:** When launched from an ephemeral `npx` cache directory, `setup`
   stages the compiled server bundle and native sidecar workers under `~/.causoryn/runtime` so
   ZCode's configured entrypoint remains valid even if the `npx` cache is later evicted.
2. **Atomic `~/.zcode/cli/config.json` (`mcp.servers.causoryn`) update:** If `~/.zcode/cli/config.json`
   already exists, `setup` writes `~/.zcode/cli/config.json.causoryn.backup` first (`0o600`
   permissions on POSIX) and registers `mcp.servers.causoryn`:

   ```json
   {
     "mcp": {
       "servers": {
         "causoryn": {
           "type": "stdio",
           "command": "node",
           "args": [
             "/path/to/runtime/scripts/causoryn.mjs",
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

3. **Automatic `~/.agents/mcp.json` fallback preservation:** ZCode falls back to `~/.agents/mcp.json`
   (`mcpServers`) only while `mcp.servers` is absent in `~/.zcode/cli/config.json`; creating
   `mcp.servers` for the first time would otherwise shadow those fallback servers. When `mcp.servers`
   is initialized for the first time and `~/.agents/mcp.json` exists, `causoryn setup` automatically
   copies existing `mcpServers` entries into `mcp.servers` (normalizing `type: "stdio"` on entries
   with a `command` field) so no previously configured server is lost.
4. **Five canonical skills (`~/.zcode/skills/`).** By default, setup installs `causoryn`,
   `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` under `~/.zcode/skills/<name>/SKILL.md`.
5. **Clean uninstall (`--uninstall`):** `npx causoryn@0.2.2 setup --client zcode --uninstall --yes`
   deletes `mcp.servers.causoryn` (cleaning up empty `mcp.servers` / `mcp` wrapper objects when no
   other servers remain), removes the five Causoryn skill directories from `~/.zcode/skills/`, and
   removes `~/.causoryn/runtime` if no other host config references it.

---

## 2. Experimental ZCode Plugin Marketplace (`marketplace.json` + `.zcode-plugin/plugin.json`)

The repository root `marketplace.json` can be added in the ZCode desktop UI (**Settings → Plugin
Management → Discover → +**) via the GitHub repository (`https://github.com/MrBekoX/Causoryn`) or a
local checkout; it declares an `npm` plugin source
(`source: { "source": "npm", "package": "causoryn", "version": "0.2.2" }`) with bilingual `en`/`tr`
`description_i18n` metadata.

The packaged `packages/causoryn/.zcode-plugin/plugin.json` wires `mcpServers.causoryn` as:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.2.2",
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

### ZCode environment variables and safety boundaries

- **`ZCODE_PLUGIN_ROOT`:** Read-only installation root of the ZCode plugin. `plugin-mcp-launcher.mjs`
  validates `package.json` against `--expected-version 0.2.2` without spawning a nested `npx`
  subprocess and loads `dist/mcp-server.mjs` directly. `deriveForbiddenPluginDirs`
  (`packages/mcp-server/src/runtime-cli.ts`) strictly blocks `ZCODE_PLUGIN_ROOT` and
  `~/.zcode/plugins` from ever being authorized as an analyzed project root.
- **`ZCODE_PROJECT_DIR`:** Working directory passed by ZCode for the active user project (`cwd`).
  `--allow-cwd` checks it with `inspectProjectRootSafety` before authorizing it (rejecting `$HOME`,
  OS system directories, `~/.zcode`, `~/.causoryn`, etc.) and supports dynamic MCP `roots/list`
  workspace rebinding during desktop sessions.
- **`ZCODE_PLUGIN_DATA`:** When `--auto-data-dir` is enabled (and `--data-dir` is not explicitly
  passed), `resolveBaseDataDir` (`packages/mcp-server/src/runtime-cli.ts`) uses `ZCODE_PLUGIN_DATA`
  when set to an absolute path (otherwise defaulting to `~/.causoryn`) for SQLite graph index and
  Living Wiki databases. In all cases, Causoryn verifies that the data directory lies **strictly
  outside** every authorized `allowRoots` workspace before creating any directory (ADR-008: zero
  bytes are ever written to the analyzed source tree).

---

## 3. Monorepo Development Fixture (`integrations/zcode/`)

For contributors testing directly from the monorepo checkout, `integrations/zcode/` provides a local
development marketplace (`causoryn-dev` in `integrations/zcode/.claude-plugin/marketplace.json`) and
plugin fixture (`integrations/zcode/causoryn/.zcode-plugin/plugin.json`):

```bash
# Build deterministic 35-file F1 bundle (bundle-manifest.json + mcp-server.mjs +
# mcp-server.mjs.LEGAL.txt + vendored node_modules/better-sqlite3/LICENSE,lib,prebuilds)
npm run build:bundle --workspace packages/mcp-server
```

- The fixture launches the compiled `packages/mcp-server/dist/` directory (`mcp-server.mjs` plus its
  adjacent vendored `node_modules/better-sqlite3/` — not a standalone single file) using
  `userConfig.config_json` → `CAUSORYN_CONFIG` (defaulting to fail-closed `{"allowRoots":[]}`, which
  returns `WORKSPACE_NOT_AUTHORIZED` until a root is explicitly configured).
- Manual desktop GUI steps (adding `integrations/zcode` via `Settings → Plugin Management →
  Discover → +` and setting `userConfig.config_json` to e.g.
  `{"allowRoots":["/path/to/your-project"],"workspaceId":"my-app"}`) are documented in
  `integrations/zcode/causoryn/README.md`; per the honesty statement above, interactive GUI
  execution remains `NOT RUN` in automated suites.

---

## 4. `stdout` / `stderr` hygiene (Red Rule 4)

Across `causoryn.mjs mcp`, `plugin-mcp-launcher.mjs`, and bare `mcp-server.mjs`, `stdout` carries
**exclusively JSON-RPC 2.0 MCP frames** (`initialize` + `tools/list` → **29 tools**); all
diagnostics and startup logs go to **`stderr`** prefixed with `[causoryn]` / `[causoryn-launcher]`,
keeping ZCode's stdio transport completely clean.

## Related pages

- [Türkçe sürüm](../../hosts/zcode.md)
- [Compatibility Matrix](../compatibility-matrix.md)
- Other host guides: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [Antigravity](antigravity.md)
- Monorepo fixture reference: `integrations/zcode/causoryn/README.md`
