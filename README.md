<p align="center">
  <img src="Causoryn.png" alt="Causoryn — Local, deterministic, LLM-free code intelligence MCP server" width="760" />
</p>

# Causoryn (`v0.2.2` — Pre-1.0 Public Preview)

**Causoryn** is an open-source, **local, deterministic, LLM-free** codebase and change intelligence engine exposed over the Model Context Protocol (`stdio`). It builds an evidence-backed dependency, symbol, route, contract, and test graph across your project (**TypeScript**, **C# / Roslyn**, **Python**, **Go**, **Rust**) and serves **29 structured MCP tools** to your AI coding agent — while enforcing a strict **read-only workspace guarantee** (`ADR-008`: zero bytes written to your repository source tree).

> **Release status (`ADR-010`):** `v0.2.2` is a **Pre-1.0 Public Preview** (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). Remaining `1.0.0` gates are tracked transparently in [`CHANGELOG.md`](CHANGELOG.md).

---

## Why Causoryn?

AI coding agents typically explore large codebases with ad-hoc `grep` and partial file reads — missing downstream callers, breaking API/schema contracts, or skipping architecture boundaries.

- **Zero LLM & zero API keys (`ADR-002`):** 100% deterministic static analysis — no embeddings, no token burn, no hallucinated call edges.
- **Evidence-backed & honest (`ADR-010`):** Every graph edge reports its exact resolution (`verified`, `heuristic`, `unresolved`) and source-span evidence ID.
- **Strictly read-only workspace (`ADR-008`):** Snapshots, SQLite indexes, and Living Wiki databases live outside your repository (`~/.causoryn/workspaces/...`).
- **Built for the full change loop:** `Discover → Preflight → Edit → Verify → Explain` across 4 coding agent hosts.

```mermaid
flowchart LR
  WS["Your Repository<br/>(Read-Only · ADR-008)"] --> AN["5-Language Analyzers<br/>TS · C#/Roslyn · Python · Go · Rust"]
  AN --> DB["External Data Root<br/>SQLite Graph · FTS5 · Living Wiki"]
  DB --> MCP["Causoryn MCP Server<br/>29 Structured Tools (stdio)"]
  MCP --> AGENT["AI Coding Agent<br/>Claude Code · Codex · Antigravity · ZCode"]
  AGENT -. "Discover → Preflight → Verify → Explain" .-> MCP
```

---

## Measured Performance (1,000 TypeScript Files)

Measured end-to-end over MCP protocol (`InMemoryTransport`, input validation + envelope serialization included) on the deterministic 1,000-file TypeScript fixture ([`docs/en/benchmarks.md`](docs/en/benchmarks.md)):

| Benchmark | MCP Tool Call | Median Latency |
|---|---|---|
| Warm workspace summary | `causoryn_workspace_summary` | **11.8 ms** |
| Local symbol neighborhood (`depth: 1`) | `causoryn_get_symbol_context` | **13.0 ms** |
| Architecture map (`L2`, `maxNodes: 200`) | `causoryn_map_system` | **10.7 ms** |

---

## Real MCP Output Example (`examples/fixture-ts-orders`)

Running `causoryn_preflight_change` before editing `src/services/orders-service.ts` returns deterministic, evidence-backed blast-radius candidates (trimmed for readability):

```json
{
  "schemaVersion": "2.0",
  "status": "ok",
  "coverage": {
    "tier": "L2",
    "resolvedEdges": 30,
    "unresolvedEdges": 1,
    "totalEdges": 31,
    "coverageRatio": 0.9677
  },
  "data": {
    "intentLabel": "Add idempotencyKey parameter to createOrder",
    "candidateOnly": true,
    "identifiedTargets": [
      { "kind": "File", "qualifiedName": "src/services/orders-service.ts", "origin": "file" }
    ],
    "impactCandidates": [
      {
        "kind": "File",
        "qualifiedName": "src/routes/orders.ts",
        "certainty": "direct",
        "resolution": "verified",
        "minDepth": 1,
        "pathEvidenceIds": ["evidence:7d09d378..."]
      },
      {
        "kind": "File",
        "qualifiedName": "src/app.ts",
        "certainty": "direct",
        "resolution": "verified",
        "minDepth": 1,
        "pathEvidenceIds": ["evidence:7847f95a..."]
      }
    ]
  }
}
```

---

## Supported Hosts

Causoryn ships as a multi-file npm distribution package (`causoryn` v`0.2.2`) and multi-host plugin repository supporting:

1. **Antigravity** (`agy` / Antigravity IDE)
2. **Claude Code**
3. **Codex** (Codex CLI / Desktop)
4. **ZCode (GLM)** — Z.ai's official GLM coding environment & ZCode Plugin Marketplace

---

## Runtime, Zero-Compile & Offline Matrix

Causoryn is **not** a single-file JS bundle (`ADR-010`) — its runtime properties vary transparently by component:

| Component | Runtime Requirement | Compilation | Offline Behavior |
|---|---|---|---|
| **Core MCP server & SQLite** (`dist/mcp-server.mjs` + N-API v10 `better-sqlite3` prebuilds) | **Node.js >= 24** | Zero-compile | 100% offline |
| **TypeScript / JavaScript** (L2 + L3) | In-process TS Compiler API + bundled `dist/typescript-lib/lib*.d.ts` | Zero-compile | 100% offline |
| **C# / Roslyn** (L2 + L3) | **.NET 10 runtime** (`dotnet exec`) | Prebuilt deterministic Release Roslyn DLL (zero-compile) | 100% offline |
| **Python** (L2 + L3) | **Python 3.10+** (`python -B`, stdlib `ast`) | Zero-compile | 100% offline |
| **Go** (L1/heuristic + L3) | **Go 1.22+** (stdlib `go/parser`, zero external modules) | On-demand `go run` (or prebuilt `CAUSORYN_GO_WORKER_BIN`) | 100% offline |
| **Rust** (L1/heuristic + L3) | **Rust / Cargo** (`syn` 2 sidecar) | On-demand `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` | First cold build fetches 12 locked crates from `crates.io`; cached builds run offline |

Missing optional sidecar toolchains (`dotnet`, `python`, `go`, `cargo`) never crash the server — they degrade honestly to L0/L1 file-level provenance (`npx causoryn@0.2.2 doctor` inspects sidecar readiness).

---

## Quick Start

### Option 1: One-Command CLI Setup (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files
npx causoryn@0.2.2 setup --all-detected --dry-run

# Configure all detected hosts (backs up existing configs to *.causoryn.backup and stages a persistent ~/.causoryn/runtime copy)
npx causoryn@0.2.2 setup --all-detected --yes

# Or configure a specific host
npx causoryn@0.2.2 setup --client antigravity --yes
npx causoryn@0.2.2 setup --client claude-code --yes
npx causoryn@0.2.2 setup --client codex --yes
npx causoryn@0.2.2 setup --client zcode --yes

# Verify runtime, sidecars, and host config/skill alignment (100% read-only)
npx causoryn@0.2.2 doctor

# Uninstall cleanly from a host
npx causoryn@0.2.2 setup --client claude-code --uninstall --yes
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
  Register the repository marketplace (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`) or run `npx causoryn@0.2.2 setup --client codex --yes`.
- **Antigravity:**
  Install from `https://github.com/MrBekoX/Causoryn` (`plugin.json` + `mcp_config.json`) or run `npx causoryn@0.2.2 setup --client antigravity --yes`.
- **Standalone Skills (`skills.sh`):**
  ```bash
  npx skills add MrBekoX/Causoryn
  ```

---

## Core Product Loop (`Discover → Preflight → Edit → Verify → Explain`)

- **Discover:** `causoryn_map_system`, `causoryn_get_agent_context`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace_execution`, `causoryn_trace_business_flow`
- **Preflight:** `causoryn_preflight_change` (`candidateOnly: true`), `causoryn_analyze_impact`, `causoryn_check_contracts`, `causoryn_detect_contract_drift`, `causoryn_derive_test_plan`
- **Verify:** `causoryn_verify_change`, `causoryn_check_architecture` (`.causoryn/architecture.rules.yaml`)
- **Explain, Visual Architecture Portal & Living Wiki:** `causoryn_get_evidence`, `causoryn_compare_architecture`, `causoryn_architecture_timeline`, `causoryn_generate_onboarding`, `causoryn_export_documentation` (layered SVG offline HTML portals, subgraph Mermaid diagrams, Architecture Brief Markdown, and fail-closed Host-LLM `annotations` guided by the bundled `architecture-blueprint` skill), and 7 `causoryn_wiki_*` tools

See [`packages/causoryn/README.md`](packages/causoryn/README.md) for the standalone npm package reference.

---

## Documentation (English & Türkçe)

Full bilingual engineering, CLI, analyzer, security, and host documentation is available under `docs/`:

- **[English Documentation Hub](docs/en/README.md)** — [Architecture](docs/en/architecture.md) · [CLI & Configuration](docs/en/cli-and-configuration.md) · [5-Language Analyzers](docs/en/language-analyzers.md) · [MCP Tool Contracts (29 Tools)](docs/en/tool-contracts.md) · [Living Wiki Spec](docs/en/wiki-spec.md) · [Compatibility Matrix](docs/en/compatibility-matrix.md) · [Security Audit](docs/en/security-pass.md) · [Benchmarks](docs/en/benchmarks.md) · [ADR-002: No-LLM](docs/en/adr/ADR-002-no-llm.md)
- **[Türkçe Dokümantasyon Merkezi](docs/README.md)** — [Mimari Özeti](docs/architecture.md) · [CLI ve Konfigürasyon](docs/cli-and-configuration.md) · [5-Dil Analizörleri](docs/language-analyzers.md) · [MCP Araç Sözleşmeleri (29 Araç)](docs/tool-contracts.md) · [Living Wiki Belirtimi](docs/wiki-spec.md) · [Uyumluluk Matrisi](docs/compatibility-matrix.md) · [Güvenlik Denetimi](docs/security-pass.md) · [Performans Ölçümleri](docs/benchmarks.md) · [ADR-002: No-LLM](docs/adr/ADR-002-no-llm.md)
- **[Bilingual Architecture & Project Overview (TR · EN)](docs/project-overview.tr-en.md)**

---

## Development (Monorepo)

Matches [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (`ubuntu-latest`, `windows-latest`, `macos-latest`):

```bash
# Install dependencies with --ignore-scripts (blocks untrusted lifecycle scripts;
# Causoryn ships verified better-sqlite3 prebuilds)
npm ci --ignore-scripts

# Build native sidecar workers
dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en
cargo build --manifest-path native/rust-worker/Cargo.toml --locked

# Run full build and quality gates
npm run typecheck
npm run build
npm run build:bundle --workspace packages/mcp-server
npm run build:package --workspace packages/causoryn
node packages/causoryn/scripts/verify-package-ready.mjs
npm run lint
npm run secret-scan
npm test
```

---

## Governance, Security & License

- **Security policy & vulnerability reporting:** [`SECURITY.md`](SECURITY.md)
- **Contributing guide:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- **Third-party notices & licenses:** Generated and bundled inside the published npm package as `THIRD-PARTY-NOTICES.md` and `licenses/` (reproducible locally via `npm run build:package --workspace packages/causoryn`)
- **License:** [MIT](LICENSE)
