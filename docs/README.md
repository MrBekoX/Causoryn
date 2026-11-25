# Causoryn Dokümantasyon Merkezi

> **Dil / Language:** **Türkçe** | [English](en/README.md) · [Kök README](../README.md) · [İki Dilli Proje Dokümanı (TR · EN)](project-overview.tr-en.md)

**Causoryn**, MCP (`stdio`) üzerinden çalışan **yerel, deterministik, sıfır LLM'li, derleyici düzeyinde bir kod grafı ve `preflight -> verify` değişiklik koruyucusudur**. **TypeScript / JavaScript**, **C# / Roslyn**, **Python**, **Go** ve **Rust** için kanıta dayalı bağımlılık, sembol, hiyerarşi, rota, sözleşme ve test grafını tamamen salt okunur biçimde oluşturur; yalın bir **11 araçlık varsayılan `core` profili** (ayrıca isteğe bağlı `wiki`, `history` ve geriye dönük uyumlu `full` profilleri) ile **5 kanonik ajan skill'i** sunar.

> **Durum:** Causoryn 0.3.1'i yansıtır; bu bir pre-1.0 sürümdür (`1.0.0` değildir; tarihsel `v0.1.0` `4c9c188f` üzerinde dondurulmuş olarak kalır). Varsayılan MCP yüzeyi 11 araçlık `core` profilidir. Kalan `1.0.0` sürüm kapıları [Uygulama Durumu](implementation-status.md), [Teknik Backlog](BACKLOG.md) ve [CHANGELOG.md](../CHANGELOG.md) belgelerinde izlenir.

---

## Hızlı Gezinme

1. **Causoryn'e yeni misiniz?** İşe **[5 Dakikalık Hızlı Başlangıç Eğitimi](en/tutorial-5-minutes.md)** (İngilizce) ile başlayın (`examples/fixture-ts-orders` üzerinde `setup -> preflight -> edit -> verify`)
2. **Doğal dil prompt'ları ve etkileşimli mimari portallar:** [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md) (saf deterministik mod vs. Host-LLM anotasyonlu `causoryn-architecture-interactive.html`)
3. **Tek komutla kurulum ve salt okunur tanılama:** [CLI ve Konfigürasyon Başvurusu](cli-and-configuration.md) (`npx causoryn@latest setup` & `npx causoryn@latest doctor`)
4. **Host'a özel kurulum kılavuzları:** [Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
5. **MCP araç profilleri ve 5 dilli analizör katmanları:** [MCP Araç Sözleşmeleri](tool-contracts.md) ve [5-Dil Analizörleri](language-analyzers.md)

---

## Diátaxis Dokümantasyon Kataloğu

Tüm rehberler dört [Diátaxis](https://diataxis.fr/) kategorisinde düzenlenmiştir; her rehberin İngilizce karşılığı `docs/en/` altındadır:

### 1. Eğitimler ve Uygulama Rehberleri (Tutorials & How-To)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| **[5 Dakikalık Hızlı Başlangıç Eğitimi (`tutorial-5-minutes.md`, İngilizce)](en/tutorial-5-minutes.md)** | `examples/fixture-ts-orders` üzerinde kopyala-yapıştır adımlar: `setup`, `doctor`, `causoryn_status`, `causoryn_map_system`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_get_agent_context`, `causoryn_trace` ve `--tool-profile` geçişi | [5-Minute Quickstart Tutorial](en/tutorial-5-minutes.md) *(yalnızca İngilizce)* |
| [Prompt ve Mimari Portal Rehberi (`prompting-and-architecture-portals.md`)](prompting-and-architecture-portals.md) | Saf deterministik mod vs. Host-LLM anotasyonlu etkileşimli mimari portallar, kopyala-yapıştır TR/EN prompt reçeteleri, 9 alanlı `annotations` sözleşmesi ve sorun giderme | [Prompting & Architecture Portals](en/prompting-and-architecture-portals.md) |
| [CLI ve Konfigürasyon (`cli-and-configuration.md`)](cli-and-configuration.md) | `causoryn setup\|doctor\|mcp`, `--tool-profile`, Node >= 24 koruması, `inspectProjectRootSafety`, MCP `roots/list` bağlama, paylaşımlı `~/.causoryn` `graph.sqlite` düzeni, pakete dahil 5 skill ve `CAUSORYN_CONFIG` şeması | [CLI & Configuration](en/cli-and-configuration.md) |
| [Antigravity Kılavuzu (`hosts/antigravity.md`)](hosts/antigravity.md) | Antigravity'nin `$schema`'sız `plugin.json` + `mcp_config.json` yapısı, `causoryn setup --client antigravity` ve doğrulama durumu | [Antigravity Guide](en/hosts/antigravity.md) |
| [Claude Code Kılavuzu (`hosts/claude-code.md`)](hosts/claude-code.md) | Yerel Claude Code plugin pazaryeri (`/plugin marketplace add`) ve `causoryn setup --client claude-code` | [Claude Code Guide](en/hosts/claude-code.md) |
| [Codex Kılavuzu (`hosts/codex.md`)](hosts/codex.md) | Codex CLI/Desktop `.agents/plugins/marketplace.json` ve `$CODEX_HOME/config.toml` kurulumu | [Codex Guide](en/hosts/codex.md) |
| [ZCode (GLM) Kılavuzu (`hosts/zcode.md`)](hosts/zcode.md) | ZCode Plugin Marketplace, `~/.zcode/cli/config.json`, `~/.agents/mcp.json` fallback koruması ve `ZCODE_PLUGIN_DATA` | [ZCode (GLM) Guide](en/hosts/zcode.md) |

### 2. Teknik Referans (Reference)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [MCP Araç Sözleşmeleri (`tool-contracts.md`)](tool-contracts.md) | Varsayılan **11 araçlık `core` profili** (`--tool-profile core\|wiki\|history\|full`), 29 legacy + 3 birleştirilmiş aracın tam belirtimleri, `coverage.byLanguage` içeren 10 alanlı envelope, `readOnlyHint` anotasyonları ve hata kodları | [MCP Tool Contracts](en/tool-contracts.md) |
| [5-Dil Analizörleri (`language-analyzers.md`)](language-analyzers.md) | TypeScript / JavaScript (`tsconfig.json`/`jsconfig.json`, monorepo workspace'leri, CHA `INHERITS`/`IMPLEMENTS`, ESM+CJS), C#/Roslyn (CHA + salt okunur NuGet keşfi), Python (`-I -B`), Go (`go.mod` + dizin anahtarlama) ve Rust (`syn` 3) yetenek matrisi ile `@causoryn/sidecar-ipc` protokolü | [5-Language Analyzers](en/language-analyzers.md) |
| [Living Wiki Belirtimi (`wiki-spec.md`)](wiki-spec.md) | 12 kategorili Living Wiki taksonomisi, 11 türlü bağlantı çözümlemesi, FTS5 arama, CAS anotasyon katmanları ve deterministik çevrimdışı dışa aktarım | [Living Wiki Specification](en/wiki-spec.md) |
| [Host Uyumluluk Matrisi (`compatibility-matrix.md`)](compatibility-matrix.md) | 4 host'lu doğrulama matrisi (`Claude Code`, `Codex`, `ZCode`, `Antigravity`), araç profili davranışı, `stdout` hijyeni ve dürüst doğrulama sınırları | [Host Compatibility Matrix](en/compatibility-matrix.md) |

### 3. Açıklama ve Mimari (Explanation & Architecture)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Mimari Özeti (`architecture.md`)](architecture.md) | Uçtan uca pipeline, `worker_threads` WAL + `build_leases` + `file_facts` erken kesme (early cutoff), 18 npm workspace paketi, SQLite izolasyonu, bundle manifesti ve CI/Güvenlik/Release hatları | [Architecture Overview](en/architecture.md) |
| [No-LLM Mimari Politikası (`adr/ADR-002-no-llm.md`)](adr/ADR-002-no-llm.md) | Causoryn içinde herhangi bir LLM, embedding veya model API bağımlılığını yasaklayan ve Host-LLM ayrım sınırını tanımlayan mimari karar | [No-LLM Architecture Policy](en/adr/ADR-002-no-llm.md) |
| [İki Dilli Proje Dokümanı (`project-overview.tr-en.md`)](project-overview.tr-en.md) | Türkçe ve İngilizce olarak tek dosyada kapsamlı yönetici ve mühendislik sentezi | [Bilingual Project Overview](project-overview.tr-en.md) *(aynı iki dilli dosya)* |

### 4. Güvence, Performans ve Proje Durumu (Assurance, Benchmarks & Project Status)

| Belge | Kapsam | İngilizce Karşılığı |
|---|---|---|
| [Güvenlik Denetimi (`security-pass.md`)](security-pass.md) | Güvenilmeyen depolar için araç zinciri izolasyonu (Cargo/Git/Go/Python/Roslyn), Win32 UNC sözcüksel ön denetimi, SHA-256 tabanlı etkileşimli CSP, 9/9 bundle tehdit matrisi, `secret-scan`, CWE-59 symlink savunmaları ve CI/CD tedarik zinciri sertleştirmesi (`zizmor`, `CodeQL`, `OpenSSF Scorecard`, `harden-runner`, 3 işli release hattı) | [Security Audit](en/security-pass.md) |
| [Performans Ölçümleri (`benchmarks.md`)](benchmarks.md) | 1.000 dosyalık deterministik fixture üzerinde soğuk indeks ve sıcak MCP sorgu gecikmesi medyanları (`11.8` / `13.0` / `10.7` ms) ile sıcak açılış (warm boot) ve gerçek depo değerlendirme rehberi | [Benchmarks](en/benchmarks.md) |
| [Uygulama Durumu (`implementation-status.md`)](implementation-status.md) | Çekirdek yetenekler, son güvenlik/çalışma zamanı/semantik izlekler ve açık `1.0.0` sürüm kapıları genelinde kanıta dayalı teslim durumu | [Implementation Status](en/implementation-status.md) |
| [Teknik Backlog (`BACKLOG.md`)](BACKLOG.md) | Bağımlılık sıralaması, açık `1.0.0` sürüm kapıları ve 1.0 sonrası iyileştirme adayları | [Engineering Backlog](en/BACKLOG.md) |

---

## Depo Yönetişimi ve Paket Dosyaları

- **Sürüm Geçmişi (`Keep a Changelog`):** [CHANGELOG.md](../CHANGELOG.md)
- **Güvenlik Politikası ve Zafiyet Bildirimi:** [SECURITY.md](../SECURITY.md)
- **Katkıda Bulunma Rehberi:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Davranış Kuralları:** [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
- **Yayımlanan npm Paketi (`causoryn`) README:** [packages/causoryn/README.md](../packages/causoryn/README.md)
- **Lisans (`MIT`):** [LICENSE](../LICENSE)
