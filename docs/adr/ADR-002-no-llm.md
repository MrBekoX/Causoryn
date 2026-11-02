# ADR-002 — No-LLM Strict Boundary

> Kanıt: TŞ v2.1 §1 (Kırmızı çizgi), §3.1, §3.2, §24 · wiki/decisions.md ADR-002 · wiki/architecture.md
> Durum: **Kabul edildi** (şartnameden gelen karar; bu repoda Sprint-1 görev 1 ile belgelendi)
> Tarih: 2026-11-02 (belgeleme), karar TŞ v2.1'den (31.10.2026) gelir

## Bağlam

Causoryn, repository/monorepo kodunu kanıta bağlanan bir Unified Evidence &
Knowledge Graph motorudur (TŞ v2.1 §1). TŞ'nin birinci sayfasında kırmızı
çizgi olarak yazılıdır:

> "Causoryn içinde hiçbir LLM çalıştırılmayacak veya çağrılmayacak. …
> Causoryn, yerel ve deterministik analiz, grafik, doğrulama ve araç çıktısı
> üretir. LLM API, model yönlendirici, model adapter/provider, inference
> sunucusu, embedding modeli, API anahtarı veya host model seçme fonksiyonu
> bulunmaz." (TŞ v2.1, s.1)

Yorumlama, planlama, kod yazma ve tool seçimi, host modelin (ZCode, Claude
Code, Codex, Antigravity) sorumluluğudur (TŞ §3.1 sorumluluk matrisi).
Causoryn yalnızca **veri** üretir: MCP aracından dönen sonuç veridir; MCP
server host modeline sampling, elicitation veya başka bir yolla model çağrısı
başlatmaz; Causoryn herhangi bir metin üretim servisinin istemcisi değildir
(TŞ §3.1 sınır sözleşmesi).

## Karar

Causoryn motoru **hiçbir LLM/embedding/model API bağımlılığı içermez** ve
hiçbir kod yolunda model çağrısı yapmaz.

### Yasaklı bağımlılıklar (TŞ §3.2, değişmez)

- `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain` vb. LLM
  inference/provider bağımlılıkları (isimler örnektir; aynı işlevdeki her
  bağımlılık yasaktır).
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`,
  otomatik model indirme, Ollama/vLLM/Transformers çalışma servisi.
- Model API key ortam değişkeni, provider endpoint ayarı, kredi/billing ekranı.
- RAG için vektör DB veya embedding modeli. Arama; compiler sembolleri, graph
  traversal, exact matching, **SQLite FTS5** ve belgeli lexical ranking ile
  yapılır.

### Bu kararın kod tarafındaki pratik sonuçları

1. Graph kanıtı (evidence) yalnızca analyzer, schema/config ve doğrulanabilir
   dosya/commit kaynaklarından gelir; host model çıktısı asla `verified`
   evidence olarak indekslenemez (TŞ §3.2).
2. Arama yetenekleri deterministik bileşenlerle kurulur: TypeScript Compiler
   API sembolleri, graph traversal, SQLite FTS5.
3. `packages/mcp-server` host modeline tek yönlü hizmet verir: stdout'ta
   yalnızca MCP protokolü, loglar stderr (TŞ §10.1).
4. Kullanılan her runtime bağımlılığı bu kararla uyumlu olmalıdır. Sprint-1
   iskelet diliminde kilitlenen bağımlılıklar: `zod`, `@modelcontextprotocol/sdk`,
   `better-sqlite3` — hiçbiri model çağrısı yapmaz, hiçbiri inference servisi
   değildir.

## Gerekçe

- **Determinizm:** Aynı giriş → aynı Graph JSON (TŞ §8 invariant vi). LLM
  çıktısı deterministik değildir; graph/kanıt üretimine girmesi determinizmi
  ve tekrarlanabilirliği bozar.
- **Kanıt bütünlüğü (ADR-004):** Her `verified` kenarın dosya/satır kaynaklı,
  doğrulanabilir kanıtı vardır; model çıktısı bu standardı karşılayamaz.
- **Gizlilik/tehdit modeli:** Analiz yerel çalışır; kod üçüncü taraf model
  API'sine gönderilmez (TŞ §19 tehdit modeliyle uyumlu).
- **Sorumluluk ayrımı (TŞ §3.1):** Yorum/planlama host modelde, ölçüm/kanıt
  Causoryn'de; iki tarafın sorumluluk alanı karışmaz.

## Sonuçlar (Consequences)

- Eksik statik çözümleme dürüstçe raporlanır: `unresolved`/`heuristic`
  resolution, `coverage`, `warnings` alanlarıyla (TŞ §7, §10.1). Motor
  "bilmediğini bilir"; tahmini modelden doldurmaz.
- Coverage eksikliği olan dil/framework desteği açıkça raporlanır; sessizce
  LLM ile "tamamlanmaz" (TŞ §2.3 kapsam ilkesi).
- Bu kararın doğrulanabilirliği: smoke test, yasak bağımlılık adlarının
  hiçbir workspace `package.json` manifestosunda geçmediğini kontrol eder
  (`tests/smoke.test.ts`, "yasak LLM bağımlılıkları" testi).

## İlgili kararlar

ADR-001 Model-agnostic Core · ADR-004 Evidence First · ADR-008 Read-only
Workspace Default · ADR-010 Incomplete Feature Never Advertised as Done
(kaynak: TŞ §24; indeks: wiki/decisions.md).
