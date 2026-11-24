# Causoryn Dokümantasyon Merkezi

> **Dil / Language:** **Türkçe** | [English](en/README.md) · [Kök README](../README.md) · [Bilingual Proje Dokümanı (TR · EN)](project-overview.tr-en.md)

**Causoryn**, **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go** ve **Rust** kod tabanları için kanıta dayalı bağımlılık, sembol, rota, kontrat ve test grafı oluşturan **yerel, deterministik ve LLM-free** bir MCP statik analiz motorudur (`ADR-002`). Salt okunur çalışma alanı (`ADR-008`) üzerinden **29 MCP aracı** ve **5 skill** sunar; görsel mimari dışa aktarımları saf yapısal modda veya isteğe bağlı Host-LLM `annotations` katmanıyla fail-closed çalışır.

> **Sürüm durumu (`ADR-010`):** `v0.2.4` bir **Pre-1.0 Public Preview** yayınıdır (`1.0.0` değildir; tarihsel `v0.1.0` etiketi `4c9c188f` üzerinde kilitlidir). Açık `1.0.0` kapıları [CHANGELOG.md](../CHANGELOG.md) ve [Uygulama Durumu](implementation-status.md) belgelerinde şeffaf biçimde izlenir.

> **0.3.0 notu:** `0.3.0` sürümünde varsayılan MCP araç yüzeyi 29 araçtan 11 araçlık `core` profiline indi; eski araç adları `--tool-profile full` (veya `CAUSORYN_TOOL_PROFILE=full`) ile, Living Wiki araçları `--tool-profile wiki` ile, mimari geçmiş araçları `--tool-profile history` ile açılır. Tüm host'lar artık çalışma alanı başına tek bir paylaşımlı `graph.sqlite` kullanır. Bu Türkçe belgelerin bir kısmı hâlâ `0.2.4` durumunu (29 araçlık yüzey) anlatır; güncel ayrıntılar için [İngilizce belgelere](en/README.md) ve [CHANGELOG.md](../CHANGELOG.md) geçiş notlarına bakın.

---

## Hızlı Başlangıç Haritası

1. **Doğal dil prompt'ları ve etkileşimli mimari portallar için:** [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md) (saf deterministik mod vs. Host-LLM anotasyonlu `causoryn-architecture-interactive.html`)
2. **Tek komutla kurmak veya mevcut kurulumu denetlemek için:** [CLI ve Konfigürasyon Başvurusu](cli-and-configuration.md) (`npx causoryn@latest setup` & `npx causoryn@latest doctor`)
3. **Kullandığınız AI kodlama ortamına özel kurulum adımları için:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
4. **29 MCP aracının sözleşmeleri ve 5 dilin statik çözümleme sınırları için:** [MCP Araç Sözleşmeleri](tool-contracts.md) ve [5-Dil Analizörleri](language-analyzers.md)

---

## Diátaxis Dokümantasyon Kataloğu (17 TR ↔ EN Belge + İki Dilli Özet)

Bu merkez ([`docs/README.md`](README.md) ↔ [`docs/en/README.md`](en/README.md)) dahil tüm 17 çift dilli rehber ve iki dilli proje özeti dört [Diátaxis](https://diataxis.fr/) kategorisine ayrılmıştır:

### 1. Başlangıç ve Uygulama Rehberleri (Tutorials & How-To)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Prompt ve Mimari Portal Rehberi (`prompting-and-architecture-portals.md`)](prompting-and-architecture-portals.md) | Saf deterministik mod vs. Host-LLM anotasyonlu etkileşimli mimari portallar, kopyala-yapıştır TR/EN prompt reçeteleri, 9 alanlı `annotations` sözleşmesi ve sorun giderme | [Prompting & Architecture Portals](en/prompting-and-architecture-portals.md) |
| [CLI ve Konfigürasyon (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, Node >= 24 koruması, `inspectProjectRootSafety`, MCP `roots/list`, `~/.causoryn` veri düzeni, 5 skill ve `CAUSORYN_CONFIG` şeması | [CLI & Configuration](en/cli-and-configuration.md) |
| [Antigravity Kılavuzu (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity `plugin.json` + `mcp_config.json`, `causoryn setup --client antigravity` ve dürüst doğrulama durumu | [Antigravity Guide](en/hosts/antigravity.md) |
| [Claude Code Kılavuzu (`hosts/claude-code.md`)](hosts/claude-code.md) | Claude Code plugin pazaryeri (`/plugin marketplace add`) ve `causoryn setup --client claude-code` kurulumu | [Claude Code Guide](en/hosts/claude-code.md) |
| [Codex Kılavuzu (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` ve `$CODEX_HOME/config.toml` kurulumu | [Codex Guide](en/hosts/codex.md) |
| [ZCode (GLM) Kılavuzu (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback koruması ve `ZCODE_PLUGIN_DATA` | [ZCode Guide](en/hosts/zcode.md) |

### 2. Teknik Referans (Reference)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [MCP Araç Sözleşmeleri (`tool-contracts.md`)](tool-contracts.md) | 22 çekirdek + 7 Living Wiki = **29 MCP aracının** tam sözleşme tablosu, 10 alanlı zarf, `readOnlyHint` anotasyonları ve hata kodları | [MCP Tool Contracts](en/tool-contracts.md) |
| [5-Dil Analizörleri (`language-analyzers.md`)](language-analyzers.md) | TypeScript / JavaScript (`tsconfig.json`/`jsconfig.json`, ESM+CJS), C#/Roslyn, Python, Go, Rust L0–L3 matrisi, `@causoryn/sidecar-ipc` NDJSON v1 ve `fp2` parmak izi | [5-Language Analyzers](en/language-analyzers.md) |
| [Living Wiki Belirtimi (`wiki-spec.md`)](wiki-spec.md) | 12 kategorili Living Wiki taksonomisi, 11 tipli bağlantı çözümlemesi, FTS5 arama, CAS anotasyon katmanı ve deterministik dışa aktarım | [Living Wiki Spec](en/wiki-spec.md) |
| [Host Uyumluluk Matrisi (`compatibility-matrix.md`)](compatibility-matrix.md) | 4 host × doğrulama sonucu matrisi (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), `stdout` hijyeni ve `ADR-010` kanıt sınırları | [Compatibility Matrix](en/compatibility-matrix.md) |

### 3. Mimari ve Kavramlar (Explanation & Architecture)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Mimari Özeti (`architecture.md`)](architecture.md) | Pipeline, katmanlı bağımlılık diyagramı, 18 npm workspace paketi, SQLite izolasyonu, bundle manifesti ve CI/Güvenlik/Release iş akışları | [Architecture Overview](en/architecture.md) |
| [ADR-002: No-LLM Strict Boundary (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Motor içinde sıfır LLM/embedding/model API çağrısı ve bağımlılığı sınırı ile Host-LLM ayrımı karar kaydı | [ADR-002: No-LLM](en/adr/ADR-002-no-llm.md) |
| [Proje Dokümanı — TR · EN (`project-overview.tr-en.md`)](project-overview.tr-en.md) | Tek dosyada Türkçe ve İngilizce kapsamlı yönetici ve mühendislik sentezi | [Bilingual Project Overview](project-overview.tr-en.md) |

### 4. Güvence, Performans ve Durum (Assurance, Benchmarks & Project Status)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Güvenlik Denetimi (`security-pass.md`)](security-pass.md) | 9/9 tehdit matrisi, F6 güvenlik süiti (`net-guard.cjs` sıfır-ağ kanıtı), `secret-scan`, CWE-59 symlink savunmaları ve CI/CD tedarik zinciri sertleştirmesi (`zizmor`, `CodeQL`, `OpenSSF Scorecard`, `harden-runner`) | [Security Audit](en/security-pass.md) |
| [Performans Ölçümleri (`benchmarks.md`)](benchmarks.md) | 1.000 dosyalık deterministik fixture üzerinde soğuk indeks ve sıcak MCP sorgu medyanları (`11.8` / `13.0` / `10.7` ms) | [Benchmarks](en/benchmarks.md) |
| [Uygulama Durumu (`implementation-status.md`)](implementation-status.md) | Faz A–F, Sprint 1–8 ve güncel teslimatların kanıtlı durum tablosu (`Done` / `Partial` — `ADR-010`) | [Implementation Status](en/implementation-status.md) |
| [Teknik Backlog (`BACKLOG.md`)](BACKLOG.md) | Kalan `1.0.0` sürüm kapıları ve izlenen mühendislik kalemleri | [Engineering Backlog](en/BACKLOG.md) |

---

## Açık Kaynak Yönetişim ve Paket Dosyaları

- **Sürüm Geçmişi (`Keep a Changelog`):** [CHANGELOG.md](../CHANGELOG.md)
- **Güvenlik Politikası ve Zafiyet Bildirimi:** [SECURITY.md](../SECURITY.md)
- **Katkıda Bulunma Rehberi:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Davranış Kuralları:** [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
- **npm Dağıtım Paketi (`causoryn`) README:** [packages/causoryn/README.md](../packages/causoryn/README.md)
- **Lisans (`MIT`):** [LICENSE](../LICENSE)
