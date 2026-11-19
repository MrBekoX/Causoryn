# Causoryn

**Causoryn** is an open-source, **local, deterministic, LLM-free** codebase and change intelligence engine exposed over the Model Context Protocol (`stdio`). It builds an evidence-backed dependency, symbol, route, contract, and test graph across your project (**TypeScript**, **C# / Roslyn**, **Python**, **Go**, **Rust**) and serves **29 structured MCP tools** to your AI coding agent — while enforcing a strict **read-only workspace guarantee** (`ADR-008`: zero bytes written to your repository source tree).

---

## Supported Hosts

Causoryn ships as a single zero-compile npm package (`causoryn` v`0.1.0`) and multi-host plugin repository supporting:

1. **Antigravity** (`agy` / Antigravity IDE)
2. **Claude Code**
3. **Codex** (Codex CLI / Desktop)
4. **ZCode (GLM)** — Z.ai's official GLM coding environment & ZCode Plugin Marketplace

---

## Quick Start

### Requirements
- **Node.js >= 24**
- Optional sidecar toolchains for multi-language L2/L3 analysis: `dotnet` (.NET 10), `python` (3.10+), `go`, `cargo`. TypeScript runs in-process with bundled `.d.ts` standard libraries; missing sidecar toolchains degrade gracefully and honestly to L0/L1 file-level provenance (`npx causoryn@0.1.0 doctor` inspects readiness).

### Option 1: One-Command CLI Setup (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files
npx causoryn@0.1.0 setup --all-detected --dry-run

# Configure all detected hosts (backs up existing configs to *.causoryn.backup and stages a persistent ~/.causoryn/runtime copy)
npx causoryn@0.1.0 setup --all-detected --yes

# Or configure a specific host
npx causoryn@0.1.0 setup --client antigravity --yes
npx causoryn@0.1.0 setup --client claude-code --yes
npx causoryn@0.1.0 setup --client codex --yes
npx causoryn@0.1.0 setup --client zcode --yes

# Verify runtime, sidecars, and host config/skill alignment (100% read-only)
npx causoryn@0.1.0 doctor

# Uninstall cleanly from a host
npx causoryn@0.1.0 setup --client claude-code --uninstall --yes
```

### Option 2: Native Host Plugin Marketplaces

- **Claude Code:**
  ```text
  /plugin marketplace add MrBekoX/Causoryn
  /plugin install causoryn@causoryn
  ```
- **ZCode (GLM):**
  Open **Settings → Plugin Management / Marketplace → Discover → + (New)**, enter `https://github.com/MrBekoX/Causoryn` (reads root `marketplace.json` + `.zcode-plugin/plugin.json`), and install `causoryn`.
- **Codex:**
  Register the repository marketplace (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`) or run `npx causoryn@0.1.0 setup --client codex --yes`.
- **Antigravity:**
  Install from `https://github.com/MrBekoX/Causoryn` (`plugin.json` + `mcp_config.json`) or run `npx causoryn@0.1.0 setup --client antigravity --yes`.
- **Standalone Skills (`skills.sh`):**
  ```bash
  npx skills add MrBekoX/Causoryn
  ```

---

## Core Product Loop (`Discover → Preflight → Edit → Verify → Explain`)

- **Discover:** `causoryn_map_system`, `causoryn_get_agent_context`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace_execution`, `causoryn_trace_business_flow`
- **Preflight:** `causoryn_preflight_change` (`candidateOnly: true`), `causoryn_analyze_impact`, `causoryn_check_contracts`, `causoryn_detect_contract_drift`, `causoryn_derive_test_plan`
- **Verify:** `causoryn_verify_change`, `causoryn_check_architecture` (`.causoryn/architecture.rules.yaml`)
- **Explain & Living Wiki:** `causoryn_get_evidence`, `causoryn_compare_architecture`, `causoryn_architecture_timeline`, `causoryn_generate_onboarding`, `causoryn_export_documentation`, and 7 `causoryn_wiki_*` tools

See [`packages/causoryn/README.md`](packages/causoryn/README.md), [`docs/architecture.md`](docs/architecture.md), [`docs/tool-contracts.md`](docs/tool-contracts.md), and [`docs/project-overview.tr-en.md`](docs/project-overview.tr-en.md) for complete architecture and contract documentation.

## Development (Monorepo)

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run build:bundle --workspace packages/mcp-server
npm run build:package --workspace packages/causoryn
npm run lint
npm run secret-scan
npm test
```

## License

[MIT](LICENSE)
