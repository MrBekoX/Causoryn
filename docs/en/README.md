# Causoryn Documentation Hub

> **Language:** [Türkçe](../README.md) | **English** · [Root README](../../README.md) · [Bilingual Project Overview (TR · EN)](../project-overview.tr-en.md)

**Causoryn** is a **local, deterministic, zero-LLM compiler-grade code graph and `preflight -> verify` change guard** over MCP (`stdio`). It builds an evidence-backed dependency, symbol, hierarchy, route, contract, and test graph for **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust** strictly read-only, exposing a lean **11-tool default `core` profile** (plus optional `wiki`, `history`, and backward-compatible `full` profiles) and **5 canonical agent skills**.

> **Status:** reflects Causoryn 0.3.2, a pre-1.0 release (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). The default MCP surface is the 11-tool `core` profile. Remaining `1.0.0` release gates are tracked in [Implementation Status](implementation-status.md), the [Engineering Backlog](BACKLOG.md) and [CHANGELOG.md](../../CHANGELOG.md).

---

## Quick Navigation

1. **New to Causoryn?** Start with the **[5-Minute Quickstart Tutorial](tutorial-5-minutes.md)** (`setup -> preflight -> edit -> verify` on `examples/fixture-ts-orders`)
2. **Natural-language prompting & interactive architecture portals:** [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md) (pure deterministic mode vs. Host-LLM annotated `causoryn-architecture-interactive.html`)
3. **One-command installation & read-only diagnostics:** [CLI & Configuration Reference](cli-and-configuration.md) (`npx causoryn@latest setup` & `npx causoryn@latest doctor`)
4. **Host-specific installation guides:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
5. **MCP tool profiles & 5-language analyzer tiers:** [MCP Tool Contracts](tool-contracts.md) and [5-Language Analyzers](language-analyzers.md)

---

## Diátaxis Documentation Catalog

All guides are organized into the four [Diátaxis](https://diataxis.fr/) quadrants, paired with Turkish counterparts under `docs/`:

### 1. Tutorials & How-To Guides

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| **[5-Minute Quickstart Tutorial (`tutorial-5-minutes.md`)](tutorial-5-minutes.md)** | Copy-paste walkthrough on `examples/fixture-ts-orders`: `setup`, `doctor`, `causoryn_status`, `causoryn_map_system`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_get_agent_context`, `causoryn_trace`, and `--tool-profile` switching | *(English-first quickstart)* |
| [Prompting & Architecture Portals (`prompting-and-architecture-portals.md`)](prompting-and-architecture-portals.md) | Pure deterministic mode vs. Host-LLM annotated interactive architecture portals, copy-paste EN/TR prompt recipes, 9-field `annotations` contract, and troubleshooting | [Prompt ve Mimari Portal Rehberi](../prompting-and-architecture-portals.md) |
| [CLI & Configuration (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, `--tool-profile`, Node >= 24 guard, `inspectProjectRootSafety`, MCP `roots/list` binding, shared `~/.causoryn` `graph.sqlite` layout, 5 bundled skills, and `CAUSORYN_CONFIG` schema | [CLI ve Konfigürasyon](../cli-and-configuration.md) |
| [Antigravity Guide (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity schema-less `plugin.json` + `mcp_config.json`, `causoryn setup --client antigravity`, and verification status | [Antigravity (TR)](../hosts/antigravity.md) |
| [Claude Code Guide (`hosts/claude-code.md`)](hosts/claude-code.md) | Native Claude Code plugin marketplace (`/plugin marketplace add`) and `causoryn setup --client claude-code` | [Claude Code (TR)](../hosts/claude-code.md) |
| [Codex Guide (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` and `$CODEX_HOME/config.toml` setup | [Codex (TR)](../hosts/codex.md) |
| [ZCode (GLM) Guide (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback preservation, and `ZCODE_PLUGIN_DATA` | [ZCode (TR)](../hosts/zcode.md) |

### 2. Technical Reference

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [MCP Tool Contracts (`tool-contracts.md`)](tool-contracts.md) | Default **11-tool `core` profile** (`--tool-profile core\|wiki\|history\|full`), full 29 legacy + 3 consolidated tool specifications, 10-field envelope with `coverage.byLanguage`, `readOnlyHint` annotations, and error codes | [Araç Sözleşmeleri](../tool-contracts.md) |
| [5-Language Analyzers (`language-analyzers.md`)](language-analyzers.md) | TypeScript / JavaScript (`tsconfig.json`/`jsconfig.json`, monorepo workspaces, CHA `INHERITS`/`IMPLEMENTS`, ESM+CJS), C#/Roslyn (CHA + read-only NuGet discovery), Python (`-I -B`), Go (`go.mod` + dir keying), and Rust (`syn` 3) capability matrix & `@causoryn/sidecar-ipc` protocol | [5-Dil Analizörleri](../language-analyzers.md) |
| [Living Wiki Specification (`wiki-spec.md`)](wiki-spec.md) | 12-category Living Wiki taxonomy, 11-kind link resolution, FTS5 search, CAS annotation overlays, and deterministic offline export | [Living Wiki Belirtimi](../wiki-spec.md) |
| [Host Compatibility Matrix (`compatibility-matrix.md`)](compatibility-matrix.md) | 4-host verification matrix (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), tool profile behavior, `stdout` hygiene, and honest verification boundaries | [Uyumluluk Matrisi](../compatibility-matrix.md) |

### 3. Explanation & Architecture

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Architecture Overview (`architecture.md`)](architecture.md) | End-to-end pipeline, `worker_threads` WAL + `build_leases` + `file_facts` early cutoff, 18 npm workspace packages, SQLite isolation, bundle manifest, and CI/Security/Release pipelines | [Mimari Özeti](../architecture.md) |
| [No-LLM Architecture Policy (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Architectural decision prohibiting any LLM, embedding, or model API dependency inside Causoryn and defining the Host-LLM separation boundary | [No-LLM Politikası (TR)](../adr/ADR-002-no-llm.md) |
| [Bilingual Project Overview (`project-overview.tr-en.md`)](../project-overview.tr-en.md) | Single-file comprehensive executive and engineering synthesis in both Turkish and English | [TR · EN Proje Dokümanı](../project-overview.tr-en.md) |

### 4. Assurance, Benchmarks & Project Status

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Security Audit (`security-pass.md`)](security-pass.md) | Untrusted-repo toolchain isolation (Cargo/Git/Go/Python/Roslyn), Win32 UNC lexical pre-check, SHA-256 interactive CSP, 9/9 bundle threat matrix, `secret-scan`, CWE-59 symlink defenses, and CI/CD supply-chain hardening (`zizmor`, `CodeQL`, `OpenSSF Scorecard`, `harden-runner`, 3-job release pipeline) | [Güvenlik Denetimi](../security-pass.md) |
| [Benchmarks (`benchmarks.md`)](benchmarks.md) | Deterministic 1,000-file fixture cold-index and warm MCP query latency medians (`11.8` / `13.0` / `10.7` ms) plus warm-boot & real-repo evaluation guidance | [Performans Ölçümleri](../benchmarks.md) |
| [Implementation Status (`implementation-status.md`)](implementation-status.md) | Evidence-backed delivery status across core capabilities, recent security/runtime/semantic tracks, and open `1.0.0` release gates | [Uygulama Durumu](../implementation-status.md) |
| [Engineering Backlog (`BACKLOG.md`)](BACKLOG.md) | Dependency ordering, open `1.0.0` release gates, and post-1.0 enhancement candidates | [Teknik Backlog](../BACKLOG.md) |

---

## Repository Governance & Package Files

- **Release Changelog (`Keep a Changelog`):** [CHANGELOG.md](../../CHANGELOG.md)
- **Security Policy & Vulnerability Reporting:** [SECURITY.md](../../SECURITY.md)
- **Contributing Guide:** [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)
- **Published npm Package (`causoryn`) README:** [packages/causoryn/README.md](../../packages/causoryn/README.md)
- **License (`MIT`):** [LICENSE](../../LICENSE)
