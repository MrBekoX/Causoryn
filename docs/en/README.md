# Causoryn Documentation Hub (`v0.2.1` — Pre-1.0 Public Preview)

> **Language:** [Türkçe](../README.md) | **English** · [Root README](../../README.md) · [Bilingual Project Overview (TR · EN)](../project-overview.tr-en.md)

**Causoryn** is an open-source, **local, deterministic, LLM-free** (`ADR-002`) codebase and change intelligence engine exposed over the Model Context Protocol (`stdio`). It builds an evidence-backed **Unified Evidence & Knowledge Graph** across **TypeScript**, **C# / Roslyn**, **Python**, **Go**, and **Rust** repositories and serves **29 structured MCP tools** to AI coding agents — while enforcing a strict **read-only workspace guarantee** (`ADR-008`: zero bytes written into your source tree).

> **Release honesty (`ADR-010`, `K-022`):** `v0.2.1` is a **Pre-1.0 Public Preview** (not `1.0.0`; historical `v0.1.0` remains frozen at `4c9c188f`). Remaining `1.0.0` gates are tracked transparently in [CHANGELOG.md](../../CHANGELOG.md) and [Implementation Status](implementation-status.md).

---

## Quick Navigation

1. **Install in one command or audit an existing setup:** [CLI & Configuration Reference](cli-and-configuration.md) (`npx causoryn@0.2.1 setup` & `npx causoryn@0.2.1 doctor`)
2. **Follow host-specific setup guides:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
3. **Explore all 29 MCP tool schemas, envelopes, and error codes:** [MCP Tool Contracts](tool-contracts.md) and [Living Wiki Specification](wiki-spec.md)
4. **Understand static resolution tiers (`L0`–`L3`) and sidecar boundaries:** [5-Language Analyzers & Sidecar Protocol](language-analyzers.md)

---

## Complete Documentation Catalog (16 English Guides + Bilingual Overview)

### 1. Core Architecture, CLI & Language Analyzers

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Documentation Hub (`docs/en/README.md`)](README.md) | Master portal across architecture, CLI, language analyzers, host guides, security, benchmarks, and governance | [Türkçe Merkez](../README.md) |
| [Architecture Overview (`architecture.md`)](architecture.md) | End-to-end pipeline, layered Mermaid diagram, 18 npm workspace packages, SQLite isolation, 35-file bundle manifest, and CI/Release pipelines | [Mimari Özeti](../architecture.md) |
| [CLI & Configuration (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, Node >= 24 guard, `inspectProjectRootSafety`, MCP `roots/list` binding, `~/.causoryn` layout, and `CAUSORYN_CONFIG` schema | [CLI ve Konfigürasyon](../cli-and-configuration.md) |
| [5-Language Analyzers (`language-analyzers.md`)](language-analyzers.md) | `INDEXED_ADAPTERS` L0–L3 capability matrix, `verified`/`heuristic`/`unresolved` edge rules, `@causoryn/sidecar-ipc` NDJSON v1 protocol, and `fp2` cache fingerprinting | [5-Dil Analizörleri](../language-analyzers.md) |
| [Bilingual Project Overview (`project-overview.tr-en.md`)](../project-overview.tr-en.md) | Single-file comprehensive executive and engineering synthesis in both Turkish and English | [TR · EN Proje Dokümanı](../project-overview.tr-en.md) |

### 2. MCP Tool Contracts & Living Wiki

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [MCP Tool Contracts (`tool-contracts.md`)](tool-contracts.md) | Complete specification of **29 MCP tools** (22 core + 7 Living Wiki), 10-field response envelope, `readOnlyHint` annotations, and error codes | [Araç Sözleşmeleri](../tool-contracts.md) |
| [Living Wiki Specification (`wiki-spec.md`)](wiki-spec.md) | 12-category Living Wiki taxonomy, 11-kind link resolution, FTS5 search, CAS annotation overlays, and offline Markdown/HTML export | [Living Wiki Belirtimi](../wiki-spec.md) |

### 3. Host Setup Guides & Compatibility Matrix

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Host Compatibility Matrix (`compatibility-matrix.md`)](compatibility-matrix.md) | 4-host verification matrix (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), `stdout` hygiene, and `ADR-010` verification evidence | [Uyumluluk Matrisi](../compatibility-matrix.md) |
| [Claude Code Guide (`hosts/claude-code.md`)](hosts/claude-code.md) | Native Claude Code plugin marketplace (`/plugin marketplace add`) and `causoryn setup --client claude-code` | [Claude Code (TR)](../hosts/claude-code.md) |
| [Codex Guide (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` and `$CODEX_HOME/config.toml` setup | [Codex (TR)](../hosts/codex.md) |
| [ZCode (GLM) Guide (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback preservation, and `ZCODE_PLUGIN_DATA` | [ZCode (TR)](../hosts/zcode.md) |
| [Antigravity Guide (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity schema-less `plugin.json` + `mcp_config.json`, `causoryn setup --client antigravity`, and verification status | [Antigravity (TR)](../hosts/antigravity.md) |

### 4. Security, Benchmarks, Status, Backlog & Architecture Decisions

| Guide | Scope | Turkish Counterpart |
|---|---|---|
| [Security Audit (`security-pass.md`)](security-pass.md) | 9/9 threat matrix, F6 security suite (`net-guard.cjs` behavioral zero-network proof), `secret-scan`, CWE-59 symlink defenses, and bundle SHA-256 verification | [Güvenlik Denetimi](../security-pass.md) |
| [Benchmarks (`benchmarks.md`)](benchmarks.md) | Deterministic 1,000-file fixture cold-index and warm MCP query latency medians (`11.8` / `13.0` / `10.7` ms) | [Performans Ölçümleri](../benchmarks.md) |
| [Implementation Status (`implementation-status.md`)](implementation-status.md) | Evidence-backed phase-by-phase delivery matrix across Phases A–F, Sprints 1–8, and `v0.2.1` (`Done` / `Partial` — `ADR-010`) | [Uygulama Durumu](../implementation-status.md) |
| [Engineering Backlog (`BACKLOG.md`)](BACKLOG.md) | Remaining `1.0.0` release gates and tracked post-`0.2.1` engineering items | [Teknik Backlog](../BACKLOG.md) |
| [ADR-002: No-LLM Strict Boundary (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Architectural decision record prohibiting any LLM, embedding, or model API dependency inside Causoryn | [ADR-002 (TR)](../adr/ADR-002-no-llm.md) |

---

## Repository Governance & Package Files

- **Release Changelog (`Keep a Changelog`):** [CHANGELOG.md](../../CHANGELOG.md)
- **Security Policy & Vulnerability Reporting:** [SECURITY.md](../../SECURITY.md)
- **Contributing Guide:** [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)
- **Published npm Package (`causoryn`) README:** [packages/causoryn/README.md](../../packages/causoryn/README.md)
- **License (`MIT`):** [LICENSE](../../LICENSE)
