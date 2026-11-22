# ADR-002 — No-LLM Strict Boundary

> **Dil / Language:** **Türkçe** | [English](../en/adr/ADR-002-no-llm.md) · [Dokümantasyon Merkezi](../README.md)
>
> Kanıt: TŞ v2.1 §1 (Kırmızı çizgi), §3.1, §3.2, §19, §24 · `wiki/decisions.md` ADR-002 · `wiki/architecture.md`
> Durum: **Kabul edildi** (şartnameden gelen değişmez mimari karar; `v0.2.0` Pre-1.0 Public Preview doğrulama kanıtlarıyla güncellendi)
> Tarih: 2026-11-02 (ilk belgeleme), 2026-11-20 (`v0.2.0` doğrulama güncellemesi); karar TŞ v2.1'den (31.10.2026) gelir

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
   Roslyn, Python `ast`, Go `go/parser`, Rust `syn 2`), şema/konfigürasyon
   ayrıştırıcıları ve doğrulanabilir dosya/commit kaynaklarından gelir; host
   model çıktısı asla `verified` evidence olarak indekslenemez (TŞ §3.2).
2. Arama yetenekleri deterministik bileşenlerle kurulur: derleyici/AST
   sembolleri, sınırlı graph gezinmesi ve SQLite FTS5.
3. `packages/mcp-server` host modeline tek yönlü hizmet verir: `stdout`
   kanalında yalnızca MCP JSON-RPC protokolü taşınır, tüm loglar `stderr`'e
   yazılır (TŞ §10.1).
4. `v0.2.0` monoreposundaki **18 npm workspace paketi + kök monorepo** (toplam
   19 `package.json`) genelinde çalışma zamanı ve derleme bağımlılıklarının
   tamamı deterministik sistem kütüphaneleridir: `zod`,
   `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`,
   `esbuild` (ayrıca yayımlanan `packages/causoryn` paketi `"dependencies": {}`
   sıfır dış npm bağımlılığı beyan eder).

## Gerekçe

- **Determinizm:** Aynı giriş → bayt-bayt aynı Graph JSON (TŞ §8 invariant vi).
  LLM çıktısı olasılıksaldır; graph veya kanıt üretimine girmesi determinizmi
  ve tekrarlanabilirliği bozar.
- **Kanıt bütünlüğü (`ADR-004`):** Her `verified` kenarın dosya, satır aralığı
  ve SHA-256 `sourceHash` kaynaklı doğrulanabilir kanıtı vardır; model çıktısı
  bu standardı karşılayamaz.
- **Gizlilik ve tehdit modeli:** Analiz tamamen yerel çalışır; kaynak kod üçüncü
  taraf model API'sine veya telemetri servisine gönderilmez (TŞ §19).
- **Sorumluluk ayrımı (TŞ §3.1):** Yorum ve planlama host modelde, ölçüm ve
  kanıt Causoryn'dedir; iki katmanın sorumluluk alanı birbirine karışmaz.

## Sonuçlar ve `v0.2.0` Doğrulama Kanıtları

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
  davranışına çevrilir. 29 MCP aracının tamamı koşulduğunda `CAUSORYN_NETLOG`
  dosyası **0 bayt** kalır. *(Dürüst kapsam sınırı: `net-guard.cjs` süreç-içi
  Node ağ API'lerini sarar; alt süreç çalıştırma yüzeyi statik komut
  allowlist'leriyle — salt-okunur `git` ve çevrimdışı sidecar'lar; Rust
  sidecar'da ise yalnızca ilk soğuk `cargo build --locked` derlemesinde kilitli
  `crates.io` bağımlılık indirmesi — sınırlandırılmıştır.)*

## İlgili kararlar ve belgeler

- `ADR-001` Model-agnostic Core · `ADR-004` Evidence First · `ADR-008` Read-only Workspace Default · `ADR-010` Incomplete Feature Never Advertised as Done (TŞ §24; iç kayıt: `wiki/decisions.md`)
- [Mimari Özeti](../architecture.md) · [5-Dil Analizörleri](../language-analyzers.md) · [Güvenlik Denetimi](../security-pass.md)
