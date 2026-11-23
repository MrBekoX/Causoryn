# ADR-002 — No-LLM Strict Boundary

> **Dil / Language:** **Türkçe** | [English](../en/adr/ADR-002-no-llm.md) · [Dokümantasyon Merkezi](../README.md)
>
> Kanıt: TŞ v2.1 §1 (Kırmızı çizgi), §3.1, §3.2, §19, §24 · `wiki/decisions.md` ADR-002, K-023 · `wiki/architecture.md`
> Durum: **Kabul edildi** (şartnameden gelen değişmez motor sınırı; `v0.2.2` Pre-1.0 Public Preview hibrit mimari sınırı `K-023` ve doğrulama kanıtlarıyla güncellendi)
> Tarih: 2026-11-02 (ilk belgeleme), 2026-11-20 (`v0.2.0` doğrulaması), 2026-11-23 (`v0.2.2` / `K-023` hibrit sınır netleştirmesi); karar TŞ v2.1'den (31.10.2026) gelir

## Bağlam

Causoryn, repository/monorepo kodunu kanıta bağlanan bir Unified Evidence &
Knowledge Graph motorudur (TŞ v2.1 §1). Teknik Şartname'nin birinci sayfasında
değişmez kırmızı çizgi olarak yazılıdır:

> "Causoryn içinde hiçbir LLM çalıştırılmayacak veya çağrılmayacak. …
> Causoryn, yerel ve deterministik analiz, grafik, doğrulama ve araç çıktısı
> üretir. LLM API, model yönlendirici, model adapter/provider, inference
> sunucusu, embedding modeli, API anahtarı veya host model seçme fonksiyonu
> bulunmaz." (TŞ v2.1, s.1)

Yorumlama, planlama, kod yazma ve araç seçimi host modelin (`Antigravity`,
`Claude Code`, `Codex`, `ZCode (GLM)`) sorumluluğudur (TŞ §3.1 sorumluluk
matrisi). Causoryn yalnızca **kanıta dayalı veri** üretir: MCP aracından dönen
sonuç yapısal veridir; MCP sunucusu host modeline `sampling`, `elicitation`
veya başka bir yolla model çağrısı başlatmaz; Causoryn herhangi bir metin
üretim ya da embedding servisinin istemcisi değildir (TŞ §3.1 sınır sözleşmesi).

## Karar

Causoryn motoru **hiçbir LLM, embedding, vektör veritabanı veya model API
bağımlılığı içermez** ve hiçbir kod yolunda yerel ya da uzak model çağrısı
yapmaz.

### Yasaklı bağımlılıklar (TŞ §3.2, değişmez)

- `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain` vb. LLM
  inference/provider bağımlılıkları (isimler örnektir; aynı işlevdeki her
  bağımlılık yasaktır).
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`,
  otomatik model indirme, Ollama/vLLM/Transformers çalışma servisleri.
- Model API key ortam değişkeni, provider endpoint ayarı, kredi/billing ekranı.
- RAG için vektör DB veya embedding modeli. Arama; derleyici sembolleri, graph
  traversal, exact matching, **SQLite FTS5** (`symbol_fts` ve `wiki_fts`) ve
  belgeli sözcüksel sıralama (lexical ranking) ile yapılır.

### Bu kararın kod ve dağıtım tarafındaki pratik sonuçları

1. Graph kanıtı (`Evidence`) yalnızca dil analizörleri (TS Compiler API, C#
   Roslyn, Python `ast`, Go `go/parser`, Rust `syn 3`), şema/konfigürasyon
   ayrıştırıcıları ve doğrulanabilir dosya/commit kaynaklarından gelir; host
   model çıktısı asla `verified` evidence olarak indekslenemez (TŞ §3.2).
2. Arama yetenekleri deterministik bileşenlerle kurulur: derleyici/AST
   sembolleri, sınırlı graph gezinmesi ve SQLite FTS5.
3. `packages/mcp-server` host modeline tek yönlü hizmet verir: `stdout`
   kanalında yalnızca MCP JSON-RPC protokolü taşınır, tüm loglar `stderr`'e
   yazılır (TŞ §10.1).
4. `v0.2.2` monoreposundaki **18 npm workspace paketi + kök monorepo** (toplam
   19 `package.json`) genelinde çalışma zamanı ve derleme bağımlılıklarının
   analiz ve paketleme için gereken altyapı kütüphaneleridir: `zod`,
   `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`,
   `esbuild` (ayrıca yayımlanan `packages/causoryn` paketi `"dependencies": {}`
   sıfır dış npm bağımlılığı beyan eder).

### `v0.2.2` (`K-023`) Mimari Dışa Aktarım ve Opsiyonel Anotasyonlar

`causoryn_export_documentation`, graph'taki statik kanıtla kendi başına bir portal
üretir. Çağıran, isteğe bağlı `annotations` alanıyla özet, domain grupları, akışlar,
tur, karar ve risk notları ekleyebilir. `architecture-blueprint` skill’i harici host
LLM’ine bu girdiyi hazırlamada yol gösterir. Doğrulayıcı şemayı ve referansların
ilgili graph veya projeksiyondaki varlığını ve aidiyetini denetler (`moduleId`,
`nodeId`, `evidenceId`, `keyFiles`). Geçersiz girdi `INVALID_ARGUMENT` ile
reddedilir. Serbest metnin doğruluğu çağıranın sorumluluğundadır.

### Determinizmin Kapsamı

Aynı renderer sürümü, metadata dahil aynı snapshot, format, görünüm, seçenekler
ve anotasyon girdisi, desteklenen mimari çıktılarda bayt düzeyinde aynı sonucu
üretir. Graph analizinin girdileri arasında dosya içeriği, çalışma alanı ve ignore
ayarları, analizör ve araç zinciri sürümleri ile bunların kullanılabilirliği yer alır.
Yeni build’ler `createdAt`, yayın zamanı ve revision gibi metadata alanlarını
değiştirebilir. MCP `requestId`, indeks işi ilerlemesi ve gecikmeler çalışma zamanına
bağlıdır. Opsiyonel host LLM anlatısı, renderer için değişken bir girdidir.
Bkz. `packages/graph/test/architecture-export.test.ts` ve
`packages/mcp-server/src/{context.ts,server.ts,services.ts}`.

## Gerekçe

- **Çekirdek determinizmi:** Kanonik graph sıralaması ve kimlikleri eşdeğer
  girdilerle tekrarlanabilir (TŞ §8 invariant vi). Dışa aktarımda anotasyonlar
  renderer girdisidir. Graph’taki `verified` kanıtlar statik kaynaklardan gelir.
- **Kanıt bütünlüğü (`ADR-004`):** Her `verified` kenarın dosya, satır aralığı
  ve SHA-256 `sourceHash` kaynaklı doğrulanabilir kanıtı vardır; model çıktısı
  bu standardı karşılayamaz.
- **Gizlilik ve tehdit modeli:** Causoryn analizi yerelde yürütür ve kaynak kodu
  model API’sine veya telemetri servisine göndermez (TŞ §19). Harici host’un
  veri işleme davranışı kendi yapılandırmasına ve sağlayıcısına bağlıdır.
- **Sorumluluk ayrımı (TŞ §3.1, K-023):** Semantik sentez ve anlatı host modelde,
  statik ölçüm, fail-closed kanıt doğrulaması ve görsel yerleşim Causoryn'dedir;
  iki katmanın sorumluluk alanı birbirine karışmaz.

## Sonuçlar ve `v0.2.2` Doğrulama Kanıtları

- **Dürüst kapsama (`ADR-010`):** Eksik statik çözümleme LLM tahminiyle
  doldurulmaz; `heuristic` (+ `ambiguity`), `unresolved` (`UnknownExternal`),
  `coverage` ve `warnings` alanlarıyla şeffafça raporlanır (bkz.
  [5-Dil Analizörleri](../language-analyzers.md)).
- **Manifest ve SBOM denetimi:** `tests/smoke.test.ts` ("yasak LLM
  bağımlılıkları" testi) yasaklı paketlerin workspace manifestolarında yer
  almadığını doğrular. `packages/mcp-server/dist/bundle-manifest.json` içindeki
  **35** dosyalık deterministik bundle (`mcp-server.mjs`,
  `mcp-server.mjs.LEGAL.txt`, `node_modules/better-sqlite3/LICENSE` ve N-API v10
  prebuild ikilileri), `packages/causoryn/THIRD-PARTY-NOTICES.md` ve
  `scripts/generate-sbom.mjs` tarafından üretilen CycloneDX 1.5 SBOM hiçbir
  AI/model bileşeni barındırmaz.
- **F6 davranışsal sıfır-ağ kanıtı (`net-guard.cjs`):** Güvenlik test süitinde
  (`tests/security-release/helpers/net-guard.cjs`, [Güvenlik Denetimi](../security-pass.md))
  sunucu süreci `NODE_OPTIONS="--require .../net-guard.cjs"` preload kancasıyla
  başlatılır; süreç-içi tüm giden Node.js ağ API'leri (`dns`, `net`, `tls`,
  `http`, `https`, `fetch`, `WebSocket`) kayıt + anında red (`CAUSORYN_NETWORK_DENIED`)
  davranışına çevrilir. F6 oturumu `tools/list` ile 29 kaydı keşfeder ve
  `causoryn_workspace_summary` ile HTML dışa aktarımını çağırır. Bu oturumda
  `CAUSORYN_NETLOG` **0 bayt** kalır. *(`net-guard.cjs` süreç-içi
  Node ağ API'lerini sarar; alt süreç çalıştırma yüzeyi statik komut
  allowlist'leriyle — salt-okunur `git` ve çevrimdışı sidecar'lar; Rust
  sidecar'da ise yalnızca ilk soğuk `cargo build --locked` derlemesinde kilitli
  `crates.io` bağımlılık indirmesi — sınırlandırılmıştır.)*

## İlgili kararlar ve belgeler

- `ADR-001` Model-agnostic Core · `ADR-004` Evidence First · `ADR-008` Read-only Workspace Default · `ADR-010` Incomplete Feature Never Advertised as Done (TŞ §24; iç kayıt: `wiki/decisions.md`)
- [Mimari Özeti](../architecture.md) · [5-Dil Analizörleri](../language-analyzers.md) · [Güvenlik Denetimi](../security-pass.md)
