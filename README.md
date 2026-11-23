<p align="center">
  <img src="Causoryn.png" alt="Causoryn — Local, deterministic, LLM-free code intelligence MCP server" width="760" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/causoryn"><img src="https://img.shields.io/npm/v/causoryn?color=2563eb&label=npm" alt="npm version" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/ci.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/security.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/security.yml/badge.svg" alt="Security & zizmor status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/codeql.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/codeql.yml/badge.svg" alt="CodeQL status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/scorecard.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/scorecard.yml/badge.svg" alt="OpenSSF Scorecard status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933" alt="Node.js >= 24" />
  <img src="https://img.shields.io/badge/MCP%20engine-LLM--free-1d4ed8" alt="LLM-free MCP engine" />
</p>

# Causoryn

**Causoryn** is a local, deterministic, LLM-free MCP codebase and change intelligence engine (`ADR-002`) for **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust**. It exposes **29 MCP tools** and **5 agent skills** over strictly read-only workspace analysis (`ADR-008`), grounding coding agents in verified dependency, symbol, route, contract, and test graphs.

> **Release status (`ADR-010`):** `0.2.3` is a **Pre-1.0 Public Preview** (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). Remaining `1.0.0` release gates are tracked transparently in [`CHANGELOG.md`](CHANGELOG.md).

---

## Why Causoryn?

AI coding agents often explore large repositories with ad-hoc `grep` and partial file reads — missing downstream callers, breaking API or schema contracts, or violating architectural boundaries.

- **Zero-LLM engine (`ADR-002`):** Static analysis, search, blast-radius preflight, verification, and documentation export run locally with zero model calls, zero API keys, and zero embeddings.
- **Evidence-backed honesty (`ADR-010`):** Every graph edge reports `verified`, `heuristic`, or `unresolved` resolution; every `verified` edge carries source-span evidence.
- **Read-only workspace (`ADR-008`):** Persistent SQLite graph and wiki databases live outside analyzed repositories. Automatic setup also isolates exports outside your source tree; custom `output.allowedOutputDirs` governs explicit export targets ([CLI & Configuration](docs/en/cli-and-configuration.md)).
- **Offline visual architecture portals:** Generate zero-JS layered SVG portals (`causoryn-architecture.html`), interactive pan/zoom/search/Evidence Inspector portals (`causoryn-architecture-interactive.html`), subgraph Mermaid diagrams, Architecture Briefs, and fail-closed Host-LLM `annotations`.
- **Universal repository compatibility & warm snapshot reads:** Analyzes `.ts/.tsx/.mts/.cts` and `.js/.jsx/.mjs/.cjs` (ESM + CommonJS) with read-only `tsconfig.json`/`jsconfig.json` path-alias resolution, respects nested `.gitignore` and `.git/info/exclude`, preserves `bin/*.ts|js` and `src/bin/*.rs` while ignoring `.NET` `bin/` outputs, yields during async inventory scans, and checks SQLite `PRAGMA data_version` before reusing cached snapshots.
- **End-to-end engineering loop:** `Discover → Preflight → Edit → Verify → Explain` across 4 coding agent hosts.

```mermaid
flowchart LR
  WS["Your Repository<br/>(Read-Only · ADR-008)"] --> AN["Deterministic Zero-LLM Core<br/>TS/JS · C#/Roslyn · Python · Go · Rust"]
  AN --> DB["External Data Root<br/>SQLite Graph · FTS5 · Living Wiki"]
  DB --> MCP["Causoryn MCP Server<br/>29 Tools · 5 Skills (stdio)"]
  MCP <-->|"MCP evidence and optional annotations"| AGENT["Your Host Coding Agent<br/>Claude Code · Codex · Antigravity · ZCode"]
  MCP -->|"Fail-Closed Validation + Layout"| PORTAL["Offline Visual Portals<br/>Interactive · Zero-JS SVG · Mermaid · Brief"]
```

---

## Quick Start

### Option 1: One-Command CLI Setup (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files
npx causoryn@latest setup --all-detected --dry-run

# Configure all detected hosts (backs up existing configs to *.causoryn.backup and stages a persistent ~/.causoryn/runtime copy)
npx causoryn@latest setup --all-detected --yes

# Or configure a specific host
npx causoryn@latest setup --client antigravity --yes
npx causoryn@latest setup --client claude-code --yes
npx causoryn@latest setup --client codex --yes
npx causoryn@latest setup --client zcode --yes

# Verify runtime, language sidecars, and host config/skill alignment (100% read-only)
npx causoryn@latest doctor

# Uninstall cleanly from a host
npx causoryn@latest setup --client claude-code --uninstall --yes
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
  Register the repository marketplace (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`) or run `npx causoryn@latest setup --client codex --yes`.
- **Antigravity:**
  Install from `https://github.com/MrBekoX/Causoryn` (`plugin.json` + `mcp_config.json`) or run `npx causoryn@latest setup --client antigravity --yes`.
- **Standalone Skills (`skills.sh`):**
  ```bash
  npx skills add MrBekoX/Causoryn
  ```

---

## Example Prompts: Deterministic Analysis vs. Annotated Architecture Portals

Causoryn supports two complementary workflows — you never need to memorize MCP tool names or skill names. For everyday engineering and pure structural diagrams, Causoryn runs **100% deterministically without any annotations** (`annotations` omitted).

When you want rich onboarding guides, domain groupings, request flows, and structural risk narratives, Causoryn **still stays 100% LLM-free (`ADR-002`)**: your host coding agent (Claude Code, Codex, Antigravity, or ZCode) acts as the host LLM, queries Causoryn MCP evidence, drafts structured `annotations`, and lets Causoryn validate every reference fail-closed before rendering `causoryn-architecture-interactive.html`.

### 1. Deterministic / Zero-LLM Prompts (Pure Static Graph — `annotations` omitted)

| Workflow | Copy-Paste Prompt | Underlying MCP Tools |
|---|---|---|
| **Codebase Map & Symbol Lookup** | `"Use Causoryn to map the main modules and entrypoints of this repo and locate the symbol definition for createOrder."` | `causoryn_map_system`, `causoryn_find_symbols` |
| **Pre-Edit Blast Radius & Contracts** | `"Before editing createOrder in orders-service.ts, run Causoryn preflight to inspect impact candidates and contract compatibility."` | `causoryn_preflight_change`, `causoryn_check_contracts` |
| **Post-Edit Architecture & Drift Verify** | `"Verify my working-tree changes with Causoryn for architecture rule violations, new cycles, and contract drift."` | `causoryn_verify_change` |
| **Pure Structural Export (EN)** | `"Export a purely structural, model-free interactive architecture diagram of this repo using Causoryn without annotations."` | `causoryn_export_documentation` (`annotations` omitted) |
| **Saf Yapısal Dışa Aktarım (TR)** | `"Causoryn ile anotasyon eklemeden bu reponun tamamen yapısal, modelsiz etkileşimli mimari diyagramını dışa aktar."` | `causoryn_export_documentation` (`annotations` yok) |

### 2. Host-LLM Annotated Interactive Architecture Portals (Natural Language — No Skill Name Needed)

Just ask your coding agent in plain English or Turkish — Causoryn's bilingual skill triggers and MCP JSON Schema descriptions automatically orchestrate the 2-step Blueprint → Fail-Closed Render workflow:

```text
# English
"Create a comprehensive, evidence-grounded interactive architecture portal for this project using Causoryn."
"Build a visual onboarding architecture guide with core domains, request flows, and structural risks using Causoryn."

# Türkçe
"Causoryn kullanarak bu projenin kapsamlı, kanıta dayalı etkileşimli mimari portalını oluştur."
"Causoryn ile projenin görsel mimari haritasını, ana iş akışlarını ve yapısal risklerini çıkar."
```

See the full recipe book, 9-field `annotations` schema, and troubleshooting guide:
**[Prompting & Architecture Portals Guide (EN)](docs/en/prompting-and-architecture-portals.md)** · **[Prompt ve Mimari Portal Rehberi (TR)](docs/prompting-and-architecture-portals.md)**

---

## Visual Architecture Exports

The architecture renderer produces byte-identical artifacts for the same snapshot (including metadata), format, view, options, and annotation input under the same renderer version. A new index build can change timestamps and revision metadata; MCP request IDs and host-generated prose can vary between sessions. See [ADR-002](docs/en/adr/ADR-002-no-llm.md) for the exact reproducibility boundary.

`causoryn_export_documentation` renders directly from the static graph and accepts optional structured `annotations` (domains, module notes, flows, guided tours, decisions, and risks). The renderer checks schema validity and graph membership fail-closed and rejects unknown IDs or paths with `INVALID_ARGUMENT`.

| Format & `view` | Generated Artifact | Key Capabilities & Offline Security |
|---|---|---|
| `html` · `view: "interactive"` | `causoryn-architecture-interactive.html` *(default)* | Offline interactive portal with zoom, pan, live search, filters, floating Evidence Inspector Drawer, 1-hop neighborhood highlighting, and Copy Mermaid. Distinct default filename avoids overwriting `causoryn-architecture.html`. |
| `html` · `view: "architecture"` *(default)* | `causoryn-architecture.html` | **Zero JS**, strict offline CSP (`default-src 'none'`), 5 pure-CSS tabs (Overview, Architecture Map, Flows, Modules & Dependencies, Risks & Contracts), layered Sugiyama SVG diagram, zoom presets, Tarjan SCC cycle highlights, inline SVG flow strips |
| `mermaid` · `view: "architecture"` | `causoryn-architecture.mmd` | Adaptive directory-tree clustering (`maxModules`, default `32`), domain subgraphs, weighted cross-module call edges, cycle styling |
| `markdown` · `view: "architecture"` | `causoryn-architecture.md` | Architecture Brief with executive summary, embedded Mermaid diagram, domain breakdown, critical flows, contracts & risks |
| `json` · `view: "architecture"` | `causoryn-architecture.json` | Compact blueprint returning canonical `architectureSummary.moduleIds` and `evidenceCatalog` |
| `snapshot` · raw | `architecture-snapshot.json` | Canonical snapshot for read-only Git architecture comparison |
| `html`, `mermaid`, `markdown`, `json` · `view: "full"` | Raw graph artifact | Unfiltered legacy node, edge, and evidence dump |

### Bundled Canonical Skills (`skills/`)

Installing Causoryn via `npx causoryn@latest setup` or native host marketplaces ships **5 canonical agent skills**:

1. **`causoryn`** — End-to-end `Discover → Preflight → Edit → Verify → Explain` orchestration runbook
2. **`map-system`** — Paginated L0–L3 codebase structure and symbol navigation
3. **`preflight-change`** — Pre-edit blast radius, contract compatibility, and candidate test plan
4. **`verify-change`** — Post-edit deterministic architecture rule and contract drift verification
5. **`architecture-blueprint`** — 6-step Host-LLM + Causoryn MCP workflow for generating grounded offline visual architecture portals

---

## Measured Performance (1,000 TypeScript Files)

Historical measurements from 2026-11-10 used `InMemoryTransport`, including input validation and MCP envelope serialization, on a deterministic 1,000-file TypeScript fixture ([Benchmarks](docs/en/benchmarks.md)):

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

Causoryn ships as a multi-file npm distribution package (`causoryn` `0.2.3`) and multi-host plugin repository supporting:

1. **Antigravity** (`agy` / Antigravity IDE)
2. **Claude Code**
3. **Codex** (Codex CLI / Desktop)
4. **ZCode (GLM)** — Z.ai's official GLM coding environment & ZCode Plugin Marketplace

---

## Runtime, Zero-Compile & Offline Matrix

Causoryn is **not** a single-file JS artifact (`ADR-010`) — its runtime properties vary transparently by component:

| Component | Runtime Requirement | Compilation | Offline Behavior |
|---|---|---|---|
| **Core MCP server & SQLite** (`dist/mcp-server.mjs` + N-API v10 `better-sqlite3` prebuilds) | **Node.js >= 24** | Zero-compile | 100% offline |
| **TypeScript / JavaScript** (L2 + L3: `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, ESM + CJS, `tsconfig`/`jsconfig` paths) | In-process TS Compiler API + bundled `dist/typescript-lib/lib*.d.ts` | Zero-compile | 100% offline |
| **C# / Roslyn** (L2 + L3) | **.NET 10 runtime** (`dotnet exec`) | Prebuilt deterministic Release Roslyn DLL (zero-compile) | 100% offline |
| **Python** (L2 + L3) | **Python 3.10+** (`python -B`, stdlib `ast`) | Zero-compile | 100% offline |
| **Go** (L1/heuristic + L3) | **Go 1.22+** (stdlib `go/parser`, zero external modules) | On-demand `go run` (or prebuilt `CAUSORYN_GO_WORKER_BIN`) | 100% offline |
| **Rust** (L1/heuristic + L3) | **Rust / Cargo** (`syn` 3 sidecar) | On-demand `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` | An uncached build can fetch locked crates from `crates.io`; a populated cache supports offline use |

Missing optional sidecar toolchains (`dotnet`, `python`, `go`, `cargo`) never crash the server — they degrade honestly to L0/L1 file-level provenance (`npx causoryn@latest doctor` inspects sidecar readiness).

---

## Core Product Loop (`Discover → Preflight → Edit → Verify → Explain`)

- **Discover:** `causoryn_map_system`, `causoryn_get_agent_context`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace_execution`, `causoryn_trace_business_flow`
- **Preflight:** `causoryn_preflight_change` (`candidateOnly: true`), `causoryn_analyze_impact`, `causoryn_check_contracts`, `causoryn_detect_contract_drift`, `causoryn_derive_test_plan`
- **Verify:** `causoryn_verify_change`, `causoryn_check_architecture` (`.causoryn/architecture.rules.yaml`)
- **Explain, Visual Portals & Living Wiki:** `causoryn_get_evidence`, `causoryn_compare_architecture`, `causoryn_architecture_timeline`, `causoryn_generate_onboarding`, `causoryn_export_documentation`, and 7 `causoryn_wiki_*` tools

See [`packages/causoryn/README.md`](packages/causoryn/README.md) for the standalone npm package reference.

---

## Documentation (English & Türkçe)

Full bilingual engineering documentation is organized by [Diátaxis](https://diataxis.fr/) under `docs/`:

| Category | English (`docs/en/`) | Türkçe (`docs/`) |
|---|---|---|
| **Documentation Hubs** | [English Documentation Hub](docs/en/README.md) | [Türkçe Dokümantasyon Merkezi](docs/README.md) |
| **Tutorials & How-To** | [Prompting & Architecture Portals](docs/en/prompting-and-architecture-portals.md) · [CLI & Configuration](docs/en/cli-and-configuration.md) · [Host Setup Guides](docs/en/README.md#1-tutorials--how-to-guides) | [Prompt ve Mimari Portal Rehberi](docs/prompting-and-architecture-portals.md) · [CLI ve Konfigürasyon](docs/cli-and-configuration.md) · [Host Kurulum Kılavuzları](docs/README.md#1-başlangıç-ve-uygulama-rehberleri-tutorials--how-to) |
| **Reference** | [MCP Tool Contracts (29 Tools)](docs/en/tool-contracts.md) · [5-Language Analyzers](docs/en/language-analyzers.md) · [Living Wiki Spec](docs/en/wiki-spec.md) · [Compatibility Matrix](docs/en/compatibility-matrix.md) | [MCP Araç Sözleşmeleri (29 Araç)](docs/tool-contracts.md) · [5-Dil Analizörleri](docs/language-analyzers.md) · [Living Wiki Belirtimi](docs/wiki-spec.md) · [Uyumluluk Matrisi](docs/compatibility-matrix.md) |
| **Explanation & Architecture** | [Architecture Overview](docs/en/architecture.md) · [ADR-002: No-LLM](docs/en/adr/ADR-002-no-llm.md) | [Mimari Özeti](docs/architecture.md) · [ADR-002: No-LLM](docs/adr/ADR-002-no-llm.md) |
| **Assurance & Benchmarks** | [Security Audit](docs/en/security-pass.md) · [Benchmarks](docs/en/benchmarks.md) · [Implementation Status](docs/en/implementation-status.md) | [Güvenlik Denetimi](docs/security-pass.md) · [Performans Ölçümleri](docs/benchmarks.md) · [Uygulama Durumu](docs/implementation-status.md) |
| **Single-File Bilingual Overview** | [Bilingual Architecture & Project Overview (TR · EN)](docs/project-overview.tr-en.md) | [İki Dilli Proje ve Mimari Özeti (TR · EN)](docs/project-overview.tr-en.md) |

---

## Development (Monorepo)

Matches [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (`ubuntu-latest`, `windows-latest`, `macos-15`):

```bash
# Install dependencies with --ignore-scripts (blocks untrusted lifecycle scripts;
# Causoryn ships verified better-sqlite3 prebuilds) and run dependency audit
npm ci --ignore-scripts
npm audit --audit-level=high

# Build native sidecar workers with locked dependency graphs
dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en -p:RestoreLockedMode=true
cargo build --manifest-path native/rust-worker/Cargo.toml --locked

# Run full build, packaging, leak-gate, and quality checks
npm run typecheck
npm run build
npm run build:bundle --workspace packages/mcp-server
npm run build:package --workspace packages/causoryn
node packages/causoryn/scripts/verify-package-ready.mjs
npm run lint
npm run secret-scan
node scripts/export-public-tree.mjs --verify-temp --ref HEAD
npm test
```

---

## Governance, Security & License

- **Security policy & vulnerability reporting:** [`SECURITY.md`](SECURITY.md)
- **Contributing guide:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- **Third-party notices & licenses:** Generated and bundled inside the published npm package as `THIRD-PARTY-NOTICES.md` and `licenses/` (reproducible locally via `npm run build:package --workspace packages/causoryn`)
- **License:** [MIT](LICENSE)
