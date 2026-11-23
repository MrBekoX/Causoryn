# Causoryn Documentation Hub

> **Language:** [Türkçe](../README.md) | **English** · [Root README](../../README.md) · [Bilingual Project Overview (TR · EN)](../project-overview.tr-en.md)

**Causoryn** is a **local, deterministic, LLM-free** static analysis MCP engine (`ADR-002`) that builds an evidence-backed dependency, symbol, route, contract, and test graph for **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust**. It exposes **29 MCP tools** and **5 skills** over read-only workspace access (`ADR-008`), supporting both pure structural architecture exports and fail-closed Host-LLM `annotations`.

> **Release status (`ADR-010`):** `v0.2.3` is a **Pre-1.0 Public Preview** (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). Remaining `1.0.0` release gates are tracked transparently in [CHANGELOG.md](../../CHANGELOG.md) and [Implementation Status](implementation-status.md).

---

## Quick Navigation

1. **Natural-language prompting & interactive architecture portals:** [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md) (pure deterministic mode vs. Host-LLM annotated `causoryn-architecture-interactive.html`)
2. **One-command installation & read-only diagnostics:** [CLI & Configuration Reference](cli-and-configuration.md) (`npx causoryn@latest setup` & `npx causoryn@latest doctor`)
3. **Host-specific installation guides:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
4. **Full 29-tool schema reference & 5-language analyzer tiers:** [MCP Tool Contracts](tool-contracts.md) and [5-Language Analyzers](language-analyzers.md)

---

## Diátaxis Documentation Catalog (17 TR ↔ EN Guides + Bilingual Overview)

All 17 bilingual document pairs — including this hub ([`docs/en/README.md`](README.md) ↔ [`docs/README.md`](../README.md)) — plus the bilingual project overview are organized into the four [Diátaxis](https://diataxis.fr/) quadrants:

### 1. Tutorials & How-To Guides

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Prompting & Architecture Portals (`prompting-and-architecture-portals.md`)](prompting-and-architecture-portals.md) | Pure deterministic mode vs. Host-LLM annotated interactive architecture portals, copy-paste EN/TR prompt recipes, 9-field `annotations` contract, and troubleshooting | [Prompt ve Mimari Portal Rehberi](../prompting-and-architecture-portals.md) |
| [CLI & Configuration (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, Node >= 24 guard, `inspectProjectRootSafety`, MCP `roots/list` binding, `~/.causoryn` layout, 5 bundled skills, and `CAUSORYN_CONFIG` schema | [CLI ve Konfigürasyon](../cli-and-configuration.md) |
| [Antigravity Guide (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity schema-less `plugin.json` + `mcp_config.json`, `causoryn setup --client antigravity`, and verification status | [Antigravity (TR)](../hosts/antigravity.md) |
| [Claude Code Guide (`hosts/claude-code.md`)](hosts/claude-code.md) | Native Claude Code plugin marketplace (`/plugin marketplace add`) and `causoryn setup --client claude-code` | [Claude Code (TR)](../hosts/claude-code.md) |
| [Codex Guide (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` and `$CODEX_HOME/config.toml` setup | [Codex (TR)](../hosts/codex.md) |
| [ZCode (GLM) Guide (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback preservation, and `ZCODE_PLUGIN_DATA` | [ZCode (TR)](../hosts/zcode.md) |

### 2. Technical Reference

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [MCP Tool Contracts (`tool-contracts.md`)](tool-contracts.md) | Complete specification of **29 MCP tools** (22 core + 7 Living Wiki), 10-field response envelope, `readOnlyHint` annotations, and error codes | [Araç Sözleşmeleri](../tool-contracts.md) |
| [5-Language Analyzers (`language-analyzers.md`)](language-analyzers.md) | TypeScript / JavaScript (`tsconfig.json`/`jsconfig.json`, ESM+CJS), C#/Roslyn, Python, Go, and Rust L0–L3 capability matrix, `@causoryn/sidecar-ipc` NDJSON v1, and `fp2` cache fingerprinting | [5-Dil Analizörleri](../language-analyzers.md) |
| [Living Wiki Specification (`wiki-spec.md`)](wiki-spec.md) | 12-category Living Wiki taxonomy, 11-kind link resolution, FTS5 search, CAS annotation overlays, and deterministic offline export | [Living Wiki Belirtimi](../wiki-spec.md) |
| [Host Compatibility Matrix (`compatibility-matrix.md`)](compatibility-matrix.md) | 4-host verification matrix (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), `stdout` hygiene, and `ADR-010` verification boundaries | [Uyumluluk Matrisi](../compatibility-matrix.md) |

### 3. Explanation & Architecture

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Architecture Overview (`architecture.md`)](architecture.md) | End-to-end pipeline, layered Mermaid diagram, 18 npm workspace packages, SQLite isolation, bundle manifest, and CI/Security/Release pipelines | [Mimari Özeti](../architecture.md) |
| [ADR-002: No-LLM Strict Boundary (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Architectural decision record prohibiting any LLM, embedding, or model API dependency inside Causoryn and defining the Host-LLM separation boundary | [ADR-002 (TR)](../adr/ADR-002-no-llm.md) |
| [Bilingual Project Overview (`project-overview.tr-en.md`)](../project-overview.tr-en.md) | Single-file comprehensive executive and engineering synthesis in both Turkish and English | [TR · EN Proje Dokümanı](../project-overview.tr-en.md) |

### 4. Assurance, Benchmarks & Project Status

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Security Audit (`security-pass.md`)](security-pass.md) | 9/9 threat matrix, F6 security suite (`net-guard.cjs` behavioral zero-network proof), `secret-scan`, CWE-59 symlink defenses, and CI/CD supply-chain hardening (`zizmor`, `CodeQL`, `OpenSSF Scorecard`, `harden-runner`) | [Güvenlik Denetimi](../security-pass.md) |
| [Benchmarks (`benchmarks.md`)](benchmarks.md) | Deterministic 1,000-file fixture cold-index and warm MCP query latency medians (`11.8` / `13.0` / `10.7` ms) | [Performans Ölçümleri](../benchmarks.md) |
| [Implementation Status (`implementation-status.md`)](implementation-status.md) | Evidence-backed phase-by-phase delivery matrix across Phases A–F, Sprints 1–8, and current milestones (`Done` / `Partial` — `ADR-010`) | [Uygulama Durumu](../implementation-status.md) |
| [Engineering Backlog (`BACKLOG.md`)](BACKLOG.md) | Remaining `1.0.0` release gates and tracked engineering items | [Teknik Backlog](../BACKLOG.md) |

---

## Repository Governance & Package Files

- **Release Changelog (`Keep a Changelog`):** [CHANGELOG.md](../../CHANGELOG.md)
- **Security Policy & Vulnerability Reporting:** [SECURITY.md](../../SECURITY.md)
- **Contributing Guide:** [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)
- **Published npm Package (`causoryn`) README:** [packages/causoryn/README.md](../../packages/causoryn/README.md)
- **License (`MIT`):** [LICENSE](../../LICENSE)
