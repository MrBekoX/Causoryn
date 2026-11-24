# Connecting Causoryn to ZCode (GLM) (CLI Config + Plugin Marketplace)

> **Language:** [Türkçe](../../hosts/zcode.md) | **English** · [Compatibility Matrix](../compatibility-matrix.md)

Causoryn is a local, deterministic, zero-LLM MCP code graph and change-guard engine (`causoryn@0.2.4`). On ZCode (GLM), it supports two installation methods:

1. **One-Command CLI Setup (recommended):** Configures `~/.zcode/cli/config.json` (`mcp.servers.causoryn`) and `~/.zcode/skills/` via `npx causoryn@latest setup --client zcode --yes`.
2. **ZCode Plugin Marketplace:** Repository root `marketplace.json` and packaged `.zcode-plugin/plugin.json` (version-pinned via `plugin-mcp-launcher.mjs --expected-version 0.2.4`).

---

## Verification Status — Desktop GUI (`NOT RUN`) vs Automated Schema & CLI Tests

- **Interactive ZCode desktop GUI installation: `NOT RUN`.** ZCode has no command-line plugin installer (marketplace installation is a desktop GUI workflow), and automated suites never mutate a developer's real desktop ZCode profile.
- **Automated verification (PASS):** Root `marketplace.json`, packaged `packages/causoryn/.zcode-plugin/plugin.json`, monorepo dev fixture (`integrations/zcode/`), isolated temporary-`$HOME` `setup`/`doctor`/`--uninstall` lifecycle, and unpacked `.tgz` `stdio` handshakes are covered by `plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts`, and `open-source-distribution.test.ts`.

---

## 1. Primary Setup — One-Command CLI (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files (read-only)
npx causoryn@latest setup --client zcode --dry-run

# Configure ~/.zcode/cli/config.json (mcp.servers.causoryn) + ~/.zcode/skills/
npx causoryn@latest setup --client zcode --yes

# Read-only health & alignment check
npx causoryn@latest doctor

# Clean removal (removes mcp.servers.causoryn + 5 Causoryn skills)
npx causoryn@latest setup --client zcode --uninstall --yes
```

What `causoryn setup --client zcode` does:

1. **Persistent runtime staging:** When executed from an ephemeral `npx` cache, stages the compiled bundle and sidecar workers atomically into `~/.causoryn/runtime` so ZCode's configured path survives `npx` cache eviction.
2. **Atomic config update with absolute Node binary:** Preserves your original `~/.zcode/cli/config.json.causoryn.backup` forever, writes the absolute Node binary (`process.execPath`), and registers `mcp.servers.causoryn`:
   ```json
   {
     "mcp": {
       "servers": {
         "causoryn": {
           "type": "stdio",
           "command": "/abs/path/to/node",
           "args": [
             "/path/to/.causoryn/runtime/scripts/causoryn.mjs",
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
3. **Automatic `~/.agents/mcp.json` fallback preservation:** Because ZCode stops falling back to `~/.agents/mcp.json` once `mcp.servers` is created in `~/.zcode/cli/config.json`, `setup` automatically copies existing `mcpServers` entries into `mcp.servers` when initializing `mcp.servers` for the first time.
4. **Five canonical skills & default lean profile:** Installs `causoryn`, `map-system`, `preflight-change`, `verify-change`, and `architecture-blueprint` under `~/.zcode/skills/`. The server boots with the **11-tool `core` profile** (`--tool-profile wiki,history` or `--tool-profile full` enables optional catalogs).

---

## 2. ZCode Plugin Marketplace (`marketplace.json` + `.zcode-plugin/plugin.json`)

Add `https://github.com/MrBekoX/Causoryn` in **Settings -> Plugin Management -> Discover -> +** to install from the repository marketplace. The packaged `.zcode-plugin/plugin.json` invokes:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.2.4",
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

### Environment Variables & Safety Boundaries

- **`ZCODE_PLUGIN_ROOT`:** Read-only plugin install root; blocked from ever being authorized as an analyzed workspace root.
- **`ZCODE_PROJECT_DIR`:** Active project working directory checked by `inspectProjectRootSafety` (rejecting UNC/device paths, `$HOME` and its ancestors, OS directories, and plugin/data roots).
- **`ZCODE_PLUGIN_DATA`:** Base external data directory used by `--auto-data-dir` (when `--data-dir` is omitted) to store shared `<slug>-<hash12>/graph.sqlite` and `exports/` strictly outside analyzed source trees.

---

## 3. Monorepo Development Fixture (`integrations/zcode/`)

Contributors testing from source can build the multi-file bundle:

```bash
npm run build:bundle --workspace packages/mcp-server
```

and point ZCode's local marketplace at `integrations/zcode/` (defaults to fail-closed `{"allowRoots":[]}` via `userConfig.config_json` until a project path is declared; see `integrations/zcode/causoryn/README.md`).

### `stdout` / `stderr` Hygiene

Across `causoryn.mjs mcp`, `plugin-mcp-launcher.mjs`, and bare `mcp-server.mjs`, `stdout` carries exclusively MCP JSON-RPC 2.0 frames; all diagnostics go to `stderr` prefixed with `[causoryn]` / `[causoryn-launcher]`.

## Related Pages

- [5-Minute Quickstart Tutorial](../tutorial-5-minutes.md) · [CLI & Configuration](../cli-and-configuration.md)
- [Compatibility Matrix](../compatibility-matrix.md) · [Türkçe sürüm](../../hosts/zcode.md)
- Other host guides: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [Antigravity](antigravity.md)
