<p align="center">
  <img src="Causoryn.png" alt="Causoryn — Local, deterministic, zero-LLM code graph and change guard MCP server" width="760" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/causoryn"><img src="https://img.shields.io/npm/v/causoryn?color=2563eb&label=npm" alt="npm version" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/ci.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/security.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/security.yml/badge.svg" alt="Security & zizmor status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/codeql.yml"><img src="https://github.com/MrBekoX/Causoryn/actions/workflows/codeql.yml/badge.svg" alt="CodeQL status" /></a>
  <a href="https://github.com/MrBekoX/Causoryn/actions/workflows/scorecard.yml"><img src="https://img.shields.io/badge/OpenSSF-Scorecard-1d4ed8" alt="OpenSSF Scorecard status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933" alt="Node.js >= 24" />
  <img src="https://img.shields.io/badge/MCP%20engine-zero--LLM-1d4ed8" alt="Zero-LLM MCP engine" />
</p>

# Causoryn

**Causoryn** is a **local, deterministic, zero-LLM compiler-grade code graph and `preflight -> verify` change guard** for AI coding agents over MCP (`stdio`). It analyzes **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust** strictly read-only, exposes a lean **11-tool default `core` profile** (with optional `wiki`, `history`, and backward-compatible `full` profiles), and ships **5 canonical agent skills**.

> **Pre-1.0 Release Status:** `0.3.2` is a **Pre-1.0** release (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). Since `0.3.0` the default MCP tool surface is the 11-tool `core` profile (previously 29 tools); start the server with `--tool-profile full` to keep the legacy tool names (see the migration notes in [`CHANGELOG.md`](CHANGELOG.md)). Remaining `1.0.0` release gates are tracked transparently in [`CHANGELOG.md`](CHANGELOG.md) and [`docs/en/implementation-status.md`](docs/en/implementation-status.md).
>
> **New here?** Follow the **[5-Minute Quickstart Tutorial](docs/en/tutorial-5-minutes.md)** on [`examples/fixture-ts-orders`](examples/fixture-ts-orders/README.md) to run `setup -> preflight -> edit -> verify` end to end.

---

## Why Causoryn?

AI coding agents frequently explore repositories with ad-hoc `grep` and partial file reads — missing downstream callers, interface implementations, API or schema contract breaks, and architectural boundary violations.

- **Zero-LLM static engine:** Analysis, symbol lookup, FTS5 BM25 code localization, blast-radius preflight, change verification, and documentation exports run locally with zero model calls, zero API keys, and zero embeddings ([No-LLM Architecture Policy](docs/en/adr/ADR-002-no-llm.md)).
- **Evidence-backed resolution honesty:** Every graph edge carries `verified`, `heuristic`, or `unresolved` resolution; every `verified` edge cites verifiable file/line/SHA-256 provenance, and `coverage.byLanguage` reports per-language fidelity so one strong language never masks degradation in another.
- **Read-only workspace guarantee:** Analyzed repositories are never modified. A single shared SQLite WAL index (`graph.sqlite`, the same for every host) with heartbeat single-writer leases (PID liveness on the same host), non-blocking `worker_threads` indexing, and per-file `file_facts` early-cutoff caching lives strictly outside your source tree; automatic setup isolates exports there too, while manual `output.allowedOutputDirs` governs explicit export destinations ([CLI & Configuration](docs/en/cli-and-configuration.md)).
- **Lean agent surface (`--tool-profile`):** Defaults to **11 consolidated `core` tools** (`tools/list <= 15,000` chars) to reduce prompt overhead and tool confusion, while `--tool-profile wiki`, `--tool-profile history`, and `--tool-profile full` (all 29 legacy tools + 3 consolidated aliases) remain one flag away.
- **Offline visual architecture portals:** Generate zero-JS layered SVG portals (`causoryn-architecture.html`), interactive pan/zoom/search/Evidence Inspector portals (`causoryn-architecture-interactive.html` protected by deterministic `script-src 'sha256-...'` CSP), subgraph Mermaid diagrams, Architecture Briefs, and fail-closed Host-LLM `annotations`.
- **End-to-end change guard:** `Discover -> Preflight -> Edit -> Verify -> Explain` across 4 coding agent hosts, including trusted baseline-commit rule loading and honest `host_asserted` test-status reporting.

```mermaid
flowchart LR
  WS["Your Repository<br/>(Strictly Read-Only)"] --> AN["Deterministic Zero-LLM Engine<br/>TS/JS · C#/Roslyn · Python · Go · Rust"]
  AN --> DB["External Data Root<br/>Shared graph.sqlite (WAL · Leases · file_facts · FTS5)"]
  DB --> MCP["Causoryn MCP Server<br/>11 Core Tools (core|wiki|history|full) · 5 Skills"]
  MCP <-->|"MCP evidence & optional annotations"| AGENT["Your Host Coding Agent<br/>Claude Code · Codex · Antigravity · ZCode"]
  MCP -->|"Fail-Closed Validation + Layout"| PORTAL["Offline Visual Portals<br/>Interactive (SHA-256 CSP) · Zero-JS SVG · Mermaid · Brief"]
```

---

## Quick Start

Start with the **[5-Minute Quickstart Tutorial](docs/en/tutorial-5-minutes.md)** or configure your host directly below.

### Option 1: One-Command CLI Setup (`npx causoryn setup`)

```bash
# Preview planned changes without modifying any files
npx causoryn@latest setup --all-detected --dry-run

# Configure all detected hosts (preserves original *.causoryn.backup forever and stages ~/.causoryn/runtime)
npx causoryn@latest setup --all-detected --yes

# Or configure a specific host explicitly (setup exits 1 with guidance when no host is detected and none is named)
npx causoryn@latest setup --client antigravity --yes
npx causoryn@latest setup --client claude-code --yes
npx causoryn@latest setup --client codex --yes
npx causoryn@latest setup --client zcode --yes

# Register an optional tool profile; re-running setup keeps your env, --tool-profile and other entry keys
npx causoryn@latest setup --client claude-code --tool-profile wiki,history --yes

# Verify runtime, sidecar toolchain minimums (.NET 10, Python 3.10, Go 1.26), host alignment and legacy index files (100% read-only)
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
  Open **Settings -> Plugin Management / Marketplace -> Discover -> + (New)**, enter `https://github.com/MrBekoX/Causoryn` (reads root `marketplace.json` + `.zcode-plugin/plugin.json`), and install `causoryn`.
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

When you want rich onboarding guides, domain groupings, request flows, and structural risk narratives, Causoryn **still stays 100% zero-LLM**: your host coding agent (Claude Code, Codex, Antigravity, or ZCode) acts as the host LLM, queries Causoryn MCP evidence, drafts structured `annotations`, and lets Causoryn validate every reference fail-closed before rendering `causoryn-architecture-interactive.html`.

### 1. Deterministic / Zero-LLM Prompts (Pure Static Graph — `annotations` omitted)

| Workflow | Copy-Paste Prompt | Underlying MCP Tools (`core` profile) |
|---|---|---|
| **Codebase Map & Symbol Lookup** | `"Use Causoryn to map the main modules and entrypoints of this repo and locate the symbol definition for OrdersService.create."` | `causoryn_map_system`, `causoryn_find_symbols` |
| **Pre-Edit Blast Radius & Contracts** | `"Before editing OrdersService.create in src/services/orders-service.ts, run Causoryn preflight to inspect impact candidates and contract compatibility."` | `causoryn_preflight_change`, `causoryn_contracts` |
| **Post-Edit Architecture & Drift Verify** | `"Verify my working-tree changes with Causoryn for architecture rule violations, new cycles, and contract drift."` | `causoryn_verify_change` |
| **Natural-Language Localization & Trace** | `"Locate where POST /orders is handled and trace its full execution chain with evidence."` | `causoryn_get_agent_context`, `causoryn_trace` |
| **Pure Structural Export (EN)** | `"Export a purely structural, model-free interactive architecture diagram of this repo using Causoryn without annotations."` | `causoryn_export_documentation` (`annotations` omitted) |
| **Saf Yapısal Dışa Aktarım (TR)** | `"Causoryn ile anotasyon eklemeden bu reponun tamamen yapısal, modelsiz etkileşimli mimari diyagramını dışa aktar."` | `causoryn_export_documentation` (`annotations` yok) |

### 2. Host-LLM Annotated Interactive Architecture Portals (Natural Language — No Skill Name Needed)

Just ask your coding agent in plain English or Turkish — Causoryn's bilingual skill triggers automatically orchestrate the two-step Blueprint -> Fail-Closed Render workflow:

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

The architecture renderer produces byte-identical artifacts for the same snapshot (including metadata), format, view, options, and annotation input under the same renderer version. A new index build can change timestamps and revision metadata; MCP request IDs and host-generated prose can vary between sessions. See [No-LLM Architecture Policy](docs/en/adr/ADR-002-no-llm.md) for the exact reproducibility boundary.

`causoryn_export_documentation` renders directly from the static graph and accepts optional structured `annotations` (domains, module notes, flows, guided tours, decisions, and risks). The validator checks schema and graph references fail-closed in a single pass, returning up to 25 actionable errors together under `INVALID_ARGUMENT`.

| Format & `view` | Generated Artifact | Key Capabilities & Offline Security |
|---|---|---|
| `html` · `view: "interactive"` | `causoryn-architecture-interactive.html` *(default)* | Offline interactive portal with zoom, pan, live search, filters, floating Evidence Inspector Drawer, 1-hop neighborhood highlighting, and Copy Mermaid. Protected by deterministic `script-src 'sha256-...'` CSP (zero `'unsafe-inline'` script permission). |
| `html` · `view: "architecture"` *(default)* | `causoryn-architecture.html` | **Zero JS**, strict offline CSP (`default-src 'none'`), 5 pure-CSS tabs (Overview, Architecture Map, Flows, Modules & Dependencies, Risks & Contracts), layered Sugiyama SVG diagram, zoom presets, Tarjan SCC cycle highlights, inline SVG flow strips |
| `mermaid` · `view: "architecture"` | `causoryn-architecture.mmd` | Adaptive directory-tree clustering (`maxModules`, default `32`), domain subgraphs, weighted cross-module call edges, cycle styling |
| `markdown` · `view: "architecture"` | `causoryn-architecture.md` | Architecture Brief with executive summary, embedded Mermaid diagram, domain breakdown, critical flows, contracts & risks |
| `json` · `view: "architecture"` | `causoryn-architecture.json` | Compact blueprint returning canonical `architectureSummary.moduleIds` and `evidenceCatalog` |
| `snapshot` · raw | `architecture-snapshot.json` | Canonical snapshot for read-only Git architecture comparison |
| `html`, `mermaid`, `markdown`, `json` · `view: "full"` | Raw graph artifact | Unfiltered legacy node, edge, and evidence dump |

### Bundled Canonical Skills (`skills/`)

Installing Causoryn via `npx causoryn@latest setup` or native host marketplaces ships **5 canonical agent skills**:

1. **`causoryn`** — End-to-end `Discover -> Preflight -> Edit -> Verify -> Explain` orchestration runbook
2. **`map-system`** — Paginated L0–L3 codebase structure and symbol navigation
3. **`preflight-change`** — Pre-edit blast radius, contract compatibility, and candidate test plan
4. **`verify-change`** — Post-edit deterministic architecture rule and contract drift verification
5. **`architecture-blueprint`** — Host-LLM + Causoryn MCP workflow for generating grounded offline visual architecture portals

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
    "coverageRatio": 0.9677,
    "byLanguage": {
      "typescript": {
        "tier": "L2",
        "files": 5,
        "verifiedEdges": 30,
        "heuristicEdges": 0,
        "unresolvedEdges": 1,
        "coverageRatio": 0.9677
      }
    }
  },
  "data": {
    "intentLabel": "Add idempotencyKey parameter to OrdersService.create",
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

Causoryn ships as a multi-file npm distribution package (`causoryn` `0.3.2`) and multi-host plugin repository supporting:

1. **Antigravity** (`agy` / Antigravity IDE)
2. **Claude Code**
3. **Codex** (Codex CLI / Desktop)
4. **ZCode (GLM)** — Z.ai's official GLM coding environment & ZCode Plugin Marketplace

---

## Runtime, Compilation & Offline Matrix

Causoryn is **not** a single-file JS artifact — its runtime properties vary transparently by component:

| Component | Runtime Requirement | Compilation | Offline Behavior |
|---|---|---|---|
| **Core MCP server & SQLite** (`dist/mcp-server.mjs` + `dist/index-worker.mjs` + N-API v10 `better-sqlite3` prebuilds) | **Node.js >= 24** | Zero-compile | 100% offline |
| **TypeScript / JavaScript** (L2 + L3: `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, ESM + CJS, `tsconfig`/`jsconfig`, monorepo workspaces, CHA `INHERITS`/`IMPLEMENTS`) | In-process TS Compiler API + bundled `dist/typescript-lib/lib*.d.ts` | Zero-compile | 100% offline |
| **C# / Roslyn** (L2 + L3: `SemanticModel`, CHA `INHERITS`/`IMPLEMENTS`, read-only `obj/project.assets.json` NuGet discovery) | **.NET 10 runtime** (`dotnet exec`, isolated `DOTNET_STARTUP_HOOKS=""`) | Prebuilt deterministic Release Roslyn DLL (zero-compile) | 100% offline |
| **Python** (L2 + L3) | **Python 3.10+** (`python -I -B -X utf8`, `python3` tried first on POSIX, stdlib `ast`) | Zero-compile | 100% offline |
| **Go** (L1/heuristic + L3: directory + `go.mod` package keying) | **Go 1.26+** (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, stdlib `go/parser`) | On-demand `go run` (or prebuilt `CAUSORYN_GO_WORKER_BIN`) | 100% offline |
| **Rust** (L1/heuristic + L3: staged crate build outside the workspace + SHA-256 binary pinning) | **Rust / Cargo** (`syn` 3 sidecar) | On-demand `cargo build --locked` of a staged crate copy in `~/.causoryn/cache/rust-worker-target` | An uncached build can fetch locked crates from `crates.io`; a populated cache supports offline use |

Missing optional sidecar toolchains (`dotnet`, `python`, `go`, `cargo`) never crash the server — they degrade honestly to L0/L1 file-level provenance (`npx causoryn@latest doctor` inspects sidecar readiness). Every tool the MCP server starts is resolved to an absolute path outside the analyzed workspace.

---

## Core Product Loop & Tool Profiles (`Discover -> Preflight -> Edit -> Verify -> Explain`)

Default **`--tool-profile core`** registers **11 consolidated tools**:

- **Status & Indexing:** `causoryn_status` (`action: "inspect" | "refresh"`)
- **Discover & Localize:** `causoryn_map_system` (`profile: "default" | "onboarding"`), `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace` (`mode: "execution" | "business-flow"`), `causoryn_get_agent_context`
- **Preflight & Contracts:** `causoryn_preflight_change` (`candidateOnly: true`, optional `include: ["impact", "test-plan"]`), `causoryn_contracts` (`action: "check" | "drift"`)
- **Verify:** `causoryn_verify_change` (`.causoryn/architecture.rules.yaml` loaded from trusted `baseRef`)
- **Explain & Export:** `causoryn_get_evidence`, `causoryn_export_documentation`

Optional profiles add Living Wiki (`--tool-profile wiki`, 7 tools), Git architecture history (`--tool-profile history`, 2 tools), or full legacy compatibility (`--tool-profile full`, all 29 legacy tool names + 3 consolidated core tools). See [`packages/causoryn/README.md`](packages/causoryn/README.md) for the standalone npm package reference.

---

## Documentation (English & Türkçe)

Full bilingual engineering documentation is organized by [Diátaxis](https://diataxis.fr/) under `docs/`:

| Category | English (`docs/en/`) | Türkçe (`docs/`) |
|---|---|---|
| **Documentation Hubs** | [English Documentation Hub](docs/en/README.md) | [Türkçe Dokümantasyon Merkezi](docs/README.md) |
| **Tutorials & How-To** | **[5-Minute Quickstart Tutorial](docs/en/tutorial-5-minutes.md)** · [Prompting & Architecture Portals](docs/en/prompting-and-architecture-portals.md) · [CLI & Configuration](docs/en/cli-and-configuration.md) · [Host Setup Guides](docs/en/README.md#1-tutorials--how-to-guides) | [Prompt ve Mimari Portal Rehberi](docs/prompting-and-architecture-portals.md) · [CLI ve Konfigürasyon](docs/cli-and-configuration.md) · [Host Kurulum Kılavuzları](docs/README.md#1-başlangıç-ve-uygulama-rehberleri-tutorials--how-to) |
| **Reference** | [MCP Tool Contracts (11 Core / 32 Full)](docs/en/tool-contracts.md) · [5-Language Analyzers](docs/en/language-analyzers.md) · [Living Wiki Spec](docs/en/wiki-spec.md) · [Compatibility Matrix](docs/en/compatibility-matrix.md) | [MCP Araç Sözleşmeleri](docs/tool-contracts.md) · [5-Dil Analizörleri](docs/language-analyzers.md) · [Living Wiki Belirtimi](docs/wiki-spec.md) · [Uyumluluk Matrisi](docs/compatibility-matrix.md) |
| **Explanation & Architecture** | [Architecture Overview](docs/en/architecture.md) · [No-LLM Architecture Policy](docs/en/adr/ADR-002-no-llm.md) | [Mimari Özeti](docs/architecture.md) · [No-LLM Politikası](docs/adr/ADR-002-no-llm.md) |
| **Assurance & Benchmarks** | [Security Audit](docs/en/security-pass.md) · [Benchmarks](docs/en/benchmarks.md) · [Implementation Status](docs/en/implementation-status.md) | [Güvenlik Denetimi](docs/security-pass.md) · [Performans Ölçümleri](docs/benchmarks.md) · [Uygulama Durumu](docs/implementation-status.md) |
| **Single-File Bilingual Overview** | [Bilingual Architecture & Project Overview (TR · EN)](docs/project-overview.tr-en.md) | [İki Dilli Proje ve Mimari Özeti (TR · EN)](docs/project-overview.tr-en.md) |

---

## Development (Monorepo)

Matches [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (`ubuntu-latest`, `windows-latest`, `macos-26-intel`; a nightly run adds Apple Silicon `macos-26`):

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
