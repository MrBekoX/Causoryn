# Karar Kaydı: LLM / Embedding / Model Bağımlılığı Yok

> **Dil / Language:** **Türkçe** | [English](../en/adr/ADR-002-no-llm.md) · [Dokümantasyon Merkezi](../README.md)
>
> **Durum:** Kabul edildi — temel motor sınırı; Causoryn 0.3.0 (pre-1.0) için güncel.
> **Tarihler:** 2026-11-02'de kaydedildi; 2026-11-20 ve 2026-11-23'te yeniden doğrulandı (host tarafından yazılan anotasyonlar ve MCP `.describe()` rehberliği); 0.3.0 için yeniden gözden geçirildi (araç profilleri, `worker_threads` indeksleme).

## Bağlam

Causoryn, depolar ve monorepo'lar için kanıta dayalı bir kod grafı ve değişiklik doğrulama motorudur. Kuruluş tasarımı, pazarlığa kapalı tek bir kural koyar:

> Causoryn içinde hiçbir LLM çalıştırılmaz veya çağrılmaz. Causoryn yerel, deterministik analiz, graf, doğrulama ve yapılandırılmış araç çıktısı üretir. LLM API'si, model yönlendirici, model adapter'ı veya provider'ı, inference sunucusu, embedding modeli, API anahtarı istemi ya da host model seçim mantığı içermez.

Sorumluluklar açıkça ayrılmıştır:

- **Host kodlama ajanı** (`Antigravity`, `Claude Code`, `Codex`, `ZCode (GLM)`): host hangi modelle yapılandırılmışsa onu kullanarak yorumlama, planlama, kod düzenleme ve araç orkestrasyonu.
- **Causoryn:** yalnızca yapılandırılmış, kanıta dayalı veri. MCP araçları graf olgularını, kanıtları, doğrulama kararlarını ve deterministik artefaktları döndürür.

MCP sunucusu hiçbir zaman `sampling`, `elicitation` ya da giden herhangi bir model çağrısı başlatmaz; yalnızca `tools` yeteneğini kaydeder (`packages/mcp-server/src/server.ts`). Causoryn hiçbir zaman bir metin üretimi veya embedding servisinin istemcisi değildir.

## Karar

Causoryn motoru **hiçbir LLM, embedding, vektör veritabanı veya model API bağımlılığı içermez** ve hiçbir kod yolunda yerel ya da uzak model çıkarımı (inference) yapmaz.

### Yasaklı Bağımlılıklar ve Yapılar

- `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain` gibi LLM inference veya orkestrasyon SDK'ları ya da eşdeğer herhangi bir istemci kütüphanesi.
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`, otomatik model ağırlığı indirmeleri veya yerel Ollama / vLLM / Transformers çalışma ortamları.
- Model API anahtarı ortam değişkenleri, provider endpoint ayarları veya token/kredi faturalama ekranları.
- Erişim (retrieval) için vektör veritabanları veya embedding modelleri. Sembol ve dokümantasyon araması; derleyici/AST sembol tablolarını, sınırlı graf gezinmesini, tam eşleşmeyi, yol ve tanımlayıcı tokenizasyonunu (`camelCase` / `PascalCase` / `snake_case` / `kebab-case`) ve `bm25` sıralamalı **SQLite FTS5**'i (`symbol_fts`, `wiki_fts`) kullanır.

## Sonuçlar

1. **Kanıt yalnızca statik kaynaklardan gelir.** Graf `Evidence` kayıtları statik analizörlerden (TypeScript Compiler API, C# Roslyn, Python `ast`, Go `go/parser`, Rust `syn` 3), sözleşme/konfigürasyon ayrıştırıcılarından ve doğrulanabilir dosya ya da Git commit aralıklarından gelir. Host modelinin yazdığı metin hiçbir zaman `verified` kanıta dönüşemez.
2. **Deterministik erişim.** Arama ve konumlandırma (localization) sembol tablolarına, graf komşuluklarına ve FTS5'e dayanır — eşit girdiler için sonuçlar tekrarlanabilir.
3. **Tek yönlü `stdio` hizmeti.** `packages/mcp-server` host'a `stdio` üzerinden hizmet verir: `stdout` yalnızca MCP JSON-RPC çerçevelerini taşır; tüm loglar `stderr`'e gider.
4. **Küçük bağımlılık ayak izi.** 18 npm workspace paketi ve monorepo kökü (19 `package.json` manifesti) genelinde tek dış bağımlılıklar analiz, depolama, protokol ve build/test araçlarıdır: `zod`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`, `esbuild`, `vitest`, `eslint`, `typescript-eslint` ve `@types/*`. Yayımlanan `packages/causoryn` paketi `"dependencies": {}` beyan eder.
5. **Statik boşluklar görünür kalır.** Statik analiz bir bağlamayı kanıtlayamadığında Causoryn boşluğu bir tahminle doldurmak yerine bunu `heuristic` (+ `ambiguity`), `unresolved` (`UnknownExternal`), daha düşük `coverage` katmanları ve `warnings` olarak raporlar (bkz. [5-Dil Analizörleri](../language-analyzers.md)).
6. **Semantik sentez host'a aittir.** Modül özetleri veya rehberli turlar gibi anlatılar host ajanından gelmelidir (bkz. sonraki bölüm); Causoryn bunları yalnızca doğrular ve render eder.

### Host Tarafından Yazılan Mimari Anotasyonların Sınırı

`causoryn_export_documentation`, mimari portalları hiçbir model çağrısı yapmadan doğrudan statik kanıt grafından render eder. Bir çağıran — genellikle `skills/architecture-blueprint/SKILL.md` ve her girdi alanındaki `.describe()` belgeleriyle yönlendirilen host kodlama ajanı — isteğe bağlı olarak yapılandırılmış `annotations` (başlık, mimari stil, yönetici özeti, alanlar (domains), modül notları, akışlar, rehberli tur, kararlar, riskler) geçirebilir. Önerilen akış iki geçişlidir: önce `format: "json"` ile `architectureSummary.moduleIds` okunur, ardından kanıta dayalı anotasyonlar `format: "html"`, `view: "interactive"` ile gönderilir.

Sınırın Causoryn tarafı:

- anotasyon şemasını ve boyut bütçelerini doğrular;
- başvurulan her `moduleId`, `nodeId`, `evidenceId` ve `keyFiles` girdisini etkin graf ve projeksiyona karşı fail-closed biçimde denetler; çağrı başına en fazla 25 hatayı `INVALID_ARGUMENT` altında toplar (`packages/graph/src/architecture-annotations.ts`);
- metni asla üretmez, yeniden yazmaz veya "iyileştirmez".

Çağıranın sağladığı metnin olgusal doğruluğu çağıranın sorumluluğunda kalır. Anotasyonlu çıktı da yine deterministik bir renderer tarafından üretilir; anotasyonlar yalnızca onun girdilerinden biridir. Deterministik ve anotasyonlu prompt desenleri için bkz. [Prompt ve Mimari Portal Rehberi](../prompting-and-architecture-portals.md).

### Determinizmin Kapsamı

- Aynı renderer sürümü, snapshot (metadata dahil), format, görünüm, etkin seçenekler ve doğrulanmış anotasyonlar **bayt düzeyinde aynı** mimari artefaktları üretir (`packages/graph/test/architecture-export.test.ts`).
- Statik graf snapshot'ları dosya içeriklerine, workspace ve ignore ayarlarına, analizör sürümlerine ve araç zinciri sürümleri ile bunların kullanılabilirliğine bağlıdır. Snapshot kimlikleri duvar saati zamanını dışarıda bırakan akışlı (streaming) SHA-256 özetleridir (`computeStreamingSnapshotId`); bu yüzden aynı girdilerin temiz bir tam build'i ile erken kesmeli (early cutoff) bir incremental build'i tek bir snapshot kimliğini paylaşır.
- Yeni build'ler `createdAt`, yayın zamanı ve revizyon gibi metadata alanlarını değiştirebilir. MCP `requestId`, arka plan iş ilerlemesi ve gecikme çalışma zamanı durumunu yansıtır. İsteğe bağlı, host tarafından yazılan metin renderer için değişken bir girdidir.

## Gerekçe

- **Tekrarlanabilirlik:** kanonik graf sıralaması ve kimlikleri eşdeğer girdiler için tekrarlanabilir; olasılıksal bir bileşen bunu bozardı.
- **Kanıt bütünlüğü:** her `verified` kenar bir dosya yolunu, 1 tabanlı bir satır aralığını ve bir SHA-256 `sourceHash` değerini gösterir — üretilmiş metnin karşılayamayacağı bir çıta.
- **Gizlilik ve tehdit modeli:** Causoryn workspace'i yerelde analiz eder ve kaynak kodu model API'lerine veya telemetri servislerine göndermez. Harici bir host'un veriyi nasıl işlediği kendi yapılandırmasına ve sağlayıcısına bağlıdır.
- **Sorumlulukların ayrılması:** semantik akıl yürütme ve anlatı sentezi host ajanında; statik ölçüm, fail-closed referans doğrulaması ve deterministik yerleşim Causoryn'de yer alır.

## Uygulama ve Doğrulama

| Kontrol | Neyi kanıtlar | Nerede |
|---|---|---|
| Yasaklı bağımlılık testi | `openai`, `@anthropic-ai/sdk`, `@google/generative-ai` ve `langchain` hiçbir workspace `package.json` dosyasında (kök, tüm paketler ve adapter'lar, `packages/causoryn`, `integrations/zcode/causoryn`) yer almaz | `tests/smoke.test.ts` |
| Bundle manifesti ve bildirimler | 36 girdili `packages/mcp-server/dist/bundle-manifest.json` (`mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt`, vendored `better-sqlite3` ve prebuild'leri), `packages/causoryn/THIRD-PARTY-NOTICES.md` ve `scripts/generate-sbom.mjs` tarafından üretilen CycloneDX 1.5 SBOM hiçbir AI veya inference paketi listelemez | `packages/mcp-server/scripts/build-bundle.mjs`, `scripts/generate-sbom.mjs` |
| Statik ağ taraması | Bundle hiçbir ağ taşıma import'u veya çağrısı içermez (`node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`, `node:dns`, `fetch(`, `XMLHttpRequest`, `WebSocket`) | `tests/security-release/f6-security-release.test.ts` içindeki statik ağ grubu |
| Davranışsal sıfır ağ oturumu | Bundle'lanmış sunucu, süreç içi `dns`, `net`, `tls`, `http`, `https`, `fetch` ve `WebSocket` kullanımını kaydedip reddeden `NODE_OPTIONS="--require …/net-guard.cjs"` ile başlatılır. Oturum `tools/list` ile 32 aracı listeler (`full` profili), `causoryn_workspace_summary` aracını ve bir HTML dışa aktarımını çağırır ve ağ logu **0 bayt** kalır | `tests/security-release/helpers/net-guard.cjs` + aynı test dosyasının ağ reddi grubu; bkz. [Güvenlik Denetimi](../security-pass.md) |
| Sunucu yetenekleri | MCP sunucusu yalnızca `tools` yeteneğini duyurur; sampling veya elicitation işleyicisi yoktur | `packages/mcp-server/src/server.ts` |

Kapsam notu: `net-guard.cjs` süreç içi Node.js ağ API'lerine kanca atar. Alt süreçler ayrıca sabit komut izin listeleriyle (allowlist) sınırlandırılır — salt okunur `git`, çevrimdışı sidecar'lar ve Rust worker'ının crates.io'dan crate indirebilen, isteğe bağlı, tek seferlik soğuk `cargo build --locked` derlemesi.

## İlgili Dokümantasyon

- İlgili tasarım kararları: modelden bağımsız çekirdek, önce kanıt, varsayılan olarak salt okunur workspace ve "tamamlanmamış bir özellik asla Done olarak tanıtılmaz" (bkz. [Mimari Özeti](../architecture.md) ve [Uygulama Durumu](../implementation-status.md)).
- [5-Dil Analizörleri](../language-analyzers.md) · [Prompt ve Mimari Portal Rehberi](../prompting-and-architecture-portals.md) · [Güvenlik Denetimi](../security-pass.md)
