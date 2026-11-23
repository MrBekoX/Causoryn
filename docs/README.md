# Causoryn Dokümantasyon Merkezi (`v0.2.2` — Pre-1.0 Public Preview)

> **Dil / Language:** **Türkçe** | [English](en/README.md) · [Kök README](../README.md) · [Bilingual Proje Dokümanı (TR · EN)](project-overview.tr-en.md)

**Causoryn**, **yerel ve LLM-free** bir MCP statik analiz motorudur (`ADR-002`). **TypeScript**, **C# / Roslyn**, **Python**, **Go** ve **Rust** için kanıta dayalı bir graph oluşturur. Salt okunur çalışma alanı üzerinden **29 MCP aracı** ve **5 skill** sunar (`ADR-008`). Görsel mimari çıktıları sabit snapshot, seçenekler ve anotasyon girdisiyle tekrarlanabilir. `architecture-blueprint` skill’i, isterse dış host’un ek açıklama sağlamasına yardımcı olur (`K-023`). [ADR-002](adr/ADR-002-no-llm.md)

> **Sürüm dürüstlüğü (`ADR-010`, `K-022`, `K-023`):** `v0.2.2` sürümü bir **Pre-1.0 Public Preview** yayınıdır (`1.0.0` değildir; tarihsel `v0.1.0` etiketi `4c9c188f` üzerinde kilitli tutulur). Açık `1.0.0` kapıları [CHANGELOG.md](../CHANGELOG.md) ve [Uygulama Durumu](implementation-status.md) içinde şeffafça izlenir.

---

## Hızlı Başlangıç Haritası

1. **Tek komutla kurmak veya mevcut kurulumu denetlemek istiyorsanız:** [CLI ve Konfigürasyon Başvurusu](cli-and-configuration.md) (`npx causoryn@0.2.2 setup` & `npx causoryn@0.2.2 doctor`)
2. **Kullandığınız AI kodlama ortamına özel kurulum adımlarını arıyorsanız:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
3. **29 MCP aracının girdi/çıktı zarflarını ve hata kodlarını incelemek istiyorsanız:** [MCP Araç Sözleşmeleri](tool-contracts.md) ve [Living Wiki Belirtimi](wiki-spec.md)
4. **Beş dilin (`TS`, `C#`, `Python`, `Go`, `Rust`) statik çözümleme ve sidecar sınırlarını görmek istiyorsanız:** [5-Dil Analizörleri ve Sidecar Protokolü](language-analyzers.md)

---

## Tam Dokümantasyon Kataloğu (16 Türkçe Belge + İki Dilli Özet)

### 1. Mimari, CLI ve Dil Analizörleri

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Dokümantasyon Merkezi (`docs/README.md`)](README.md) | Tüm teknik, host, güvenlik ve yönetişim belgelerinin ana giriş portalı | [English Hub](en/README.md) |
| [Mimari Özeti (`architecture.md`)](architecture.md) | Pipeline, katmanlı bağımlılık diyagramı, 18 npm workspace paketi, SQLite depolama, 35 dosyalık bundle ve CI/Release mimarisi | [Architecture](en/architecture.md) |
| [CLI ve Konfigürasyon (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, Node >= 24 koruması, `inspectProjectRootSafety`, MCP `roots/list`, `~/.causoryn` veri düzeni ve `CAUSORYN_CONFIG` şeması | [CLI & Configuration](en/cli-and-configuration.md) |
| [5-Dil Analizörleri (`language-analyzers.md`)](language-analyzers.md) | `INDEXED_ADAPTERS` L0–L3 matrisi, `verified`/`heuristic`/`unresolved` kuralları, `@causoryn/sidecar-ipc` NDJSON v1 protokolü ve `fp2` parmak izi | [Language Analyzers](en/language-analyzers.md) |
| [Proje Dokümanı — TR · EN (`project-overview.tr-en.md`)](project-overview.tr-en.md) | Tek dosyada Türkçe ve İngilizce kapsamlı yönetici ve mühendislik özeti | [Bilingual Overview](project-overview.tr-en.md) |

### 2. MCP Araç Sözleşmeleri ve Living Wiki

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [MCP Araç Sözleşmeleri (`tool-contracts.md`)](tool-contracts.md) | 22 çekirdek + 7 Living Wiki = **29 MCP aracının** tam sözleşme tablosu, 10 alanlı zarf, `readOnlyHint` anotasyonları ve hata kodları | [Tool Contracts](en/tool-contracts.md) |
| [Living Wiki Belirtimi (`wiki-spec.md`)](wiki-spec.md) | 12 kategorili Living Wiki taksonomisi, 11 tipli bağlantı çözümlemesi, FTS5 arama, CAS anotasyon katmanı ve deterministik dışa aktarım | [Living Wiki Spec](en/wiki-spec.md) |

### 3. Host Entegrasyon Kılavuzları ve Uyumluluk

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Host Uyumluluk Matrisi (`compatibility-matrix.md`)](compatibility-matrix.md) | 4 host × doğrulama sonucu matrisi (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), `ADR-010` kanıt ve dürüstlük sınırları | [Compatibility Matrix](en/compatibility-matrix.md) |
| [Claude Code Kılavuzu (`hosts/claude-code.md`)](hosts/claude-code.md) | Claude Code plugin pazaryeri (`/plugin marketplace add`) ve `causoryn setup --client claude-code` kurulumu | [Claude Code Guide](en/hosts/claude-code.md) |
| [Codex Kılavuzu (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` ve `$CODEX_HOME/config.toml` kurulumu | [Codex Guide](en/hosts/codex.md) |
| [ZCode (GLM) Kılavuzu (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback koruması ve `ZCODE_PLUGIN_DATA` | [ZCode Guide](en/hosts/zcode.md) |
| [Antigravity Kılavuzu (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity `plugin.json` + `mcp_config.json`, `causoryn setup --client antigravity` ve dürüst doğrulama durumu | [Antigravity Guide](en/hosts/antigravity.md) |

### 4. Güvenlik, Performans, Durum, Backlog ve Mimari Kararlar (ADR)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Güvenlik Denetimi (`security-pass.md`)](security-pass.md) | 9/9 tehdit matrisi, F6 güvenlik süiti (`net-guard.cjs` sıfır-ağ kanıtı), `secret-scan`, CWE-59 symlink/yol kaçışı savunmaları ve bundle SHA-256 pini | [Security Audit](en/security-pass.md) |
| [Performans Ölçümleri (`benchmarks.md`)](benchmarks.md) | 1.000 dosyalık deterministik fixture üzerinde soğuk indeks ve sıcak MCP sorgu medyanları (`11.8` / `13.0` / `10.7` ms) | [Benchmarks](en/benchmarks.md) |
| [Uygulama Durumu (`implementation-status.md`)](implementation-status.md) | Faz A–F, Sprint 1–8 ve `v0.2.2` teslimatlarının kanıtlı durum tablosu (`Done` / `Partial` — `ADR-010`) | [Implementation Status](en/implementation-status.md) |
| [Teknik Backlog (`BACKLOG.md`)](BACKLOG.md) | `1.0.0` sürüm kapıları ve gelecek dilimlerde ele alınacak açık mühendislik kalemleri | [Backlog](en/BACKLOG.md) |
| [ADR-002: No-LLM Strict Boundary (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Motor içinde sıfır LLM/embedding/model API çağrısı ve bağımlılığı kuralının mimari karar kaydı | [ADR-002 (EN)](en/adr/ADR-002-no-llm.md) |

---

## Açık Kaynak Yönetişim ve Paket Dosyaları

- **Sürüm Geçmişi (`Keep a Changelog`):** [CHANGELOG.md](../CHANGELOG.md)
- **Güvenlik Politikası ve Zafiyet Bildirimi:** [SECURITY.md](../SECURITY.md)
- **Katkıda Bulunma Rehberi:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Davranış Kuralları:** [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
- **npm Dağıtım Paketi (`causoryn`) README:** [packages/causoryn/README.md](../packages/causoryn/README.md)
- **Lisans (`MIT`):** [LICENSE](../LICENSE)
