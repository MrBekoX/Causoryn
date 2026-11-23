# Rust Worker stdin/stdout Protokolü — v1

> Kanıt: TŞ v2.1 §7 (dil sidecar worker'ları), §8 (Unified Evidence &
> Knowledge Graph sözleşmesi), §23 (Faz G/M1-Rust dil planı). Alan adları,
> `packages/domain/src/snapshot.ts`'teki createSnapshot GİRDİ sözleşmesiyle
> (SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput — NodeRef
> uçlu, ID'siz) birebir hizalıdır. Roslyn worker
> (native/roslyn-worker/PROTOCOL.md) ile aynı kablolama desenidir; fark,
> çözümleyicinin `syn` 3 (crates.io, `Cargo.lock` sürümü `3.0.10`) olması ve aşağıdaki DÜRÜST ÇÖZÜM
> SINIRLARIDIR.

**Causoryn Rust sidecar worker** — LLM çalıştırmayan, yerel ve
deterministik Rust çözümleyicisi. Süreç stdin'den satır satır istek okur,
her isteğe tek satır JSON yanıt döner ve analiz boyunca kullanıcı
workspace'ine HİÇBİR YAZMA yapmaz (ADR-008; analiz tamamen bellek-içindedir).

- **Taşıma:** yerel stdio; satır-bazlı JSON (her mesaj birebir tek satır).
- **Kodlama:** BOM'suz UTF-8; JSON içi yeni satırlar `\n` kaçış dizisidir,
  bu yüzden framing bozulmaz.
- **stdout disiplini (kırmızı çizgi):** stdout'ta YALNIZCA protokol
  satırları taşınır; tüm loglar `stderr`'e yazılır (`[rust-worker] `
  öneki ile).
- **Kodlama kuralı:** JSON anahtarları domain'deki alan adlarıyla aynıdır
  (camelCase); opsiyonel alanlar `null` yerine YOK olarak yazılır — tek
  istisna `id` alanıdır (hata yanıtlarında açıkça `null` taşınır).
- **Bağımlılık sözleşmesi.** `syn` 3 AST analizi, `serde_json` JSON çerçeveleme ve
  `proc-macro2` `span-locations` kaynak satırı kanıtı için kullanılır. SHA-256 bağımlılıksız uygulanır
  (`src/sha256.rs`) ve Node `crypto` özetiyle kabul testlerinde
  doğrulanır.

## 1. Mesaj çerçeveleme

```
stdout ← {"id":...,"status":"ready",...}\n     (istek başına tam olarak bir satır)
stderr ← [rust-worker] ...                     (loglar; protokolün parçası değil)
```

- İstemci, worker sürecini başlatır ve stdin'e istek satırları yazar.
- Her boş olmayan satır bir istektir; boş satırlar sessizce atlanır.
- Worker süreci istemci stdin'i kapattığında (EOF) `0` çıkış kodu ile biter.
  Yalnızca stdio kablosu kırılırsa `1` ile biter.
- Süreç, 256 MB stack'li ayrı thread'de koşar: derin iç içe AST'lerde syn
  parse/visit recursion StackOverflow'a düşmeden ya PARSE_ERROR tanısına ya
  da başarıyla tamamlanmış analize dönüşür (roslyn worker'daki iki katmanlı
  savunmanın karşılığı).

## 2. İstek — `type: "analyze"`

```json
{
  "id": "fixture-rust-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "main.rs", "content": "... kaynak kod ..." }
  ]
}
```

| Alan | Tür | Kural |
|---|---|---|
| `id` | string \| sayı | **Zorunlu.** Yanıtta birebir echo edilir. |
| `type` | string | **Zorunlu.** Yalnızca `"analyze"` desteklenir. |
| `protocolVersion` | string | Opsiyonel. Varsa `"1"` olmalıdır. |
| `maxNodes` | tam sayı | Opsiyonel. Yanıt node bütçesi; `1..MaxResponseNodes` aralığında olmalı, dışı `INVALID_ARGUMENT`. Verilmezse `MaxResponseNodes` uygulanır. (bool kabul edilmez — JSON true/false sayı değildir.) |
| `files` | dizi | **Zorunlu, en az 1.** Bellek-içi kaynak çantası. |
| `files[].path` | string | **Zorunlu.** Workspace-relative POSIX yolu. Mutlak yol, `""`/`.`/`..` segmentleri reddedilir. Aynı yol iki kez verilemez. |
| `files[].content` | string | **Zorunlu.** Tam kaynak kod. |

İstek nesnesinde bilinmeyen alan → `INVALID_ARGUMENT` (kesin şema reddi,
Zod strictObject disipliniyle aynı); `files[]` girdisinde bilinmeyen alan
aynı şekilde reddedilir.

### Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri)

| Sınır | Değer | Aşım davranışı |
|---|---|---|
| `MaxRequestLineBytes` | 64.000.000 bayt (UTF-8'de kötümser üst sınır) | Satır newline'a kadar DISCARD edilir; `id: null` + `LIMIT_EXCEEDED` yanıtı yazılır, döngü devam eder. |
| `MaxFileCount` | 5.000 dosya/istek | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2.000.000 bayt/dosya (TŞ §20 `maxFileBytes` ile uyumlu) | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` | 250.000 node/yanıt (`maxNodes` ile altına çekilebilir) | Aşan node'lar YAYINLANMAZ; uçları yayınlanmayan kenarlar da düşer (dangling yok). Yanıta `RESPONSE_TRUNCATED` tanısı düşer ve `status: "partial"` olur — sessiz kesim yoktur. |

Sınırlar sabittir (protokol v1'de istekte yapılandırılamaz) ve aynı
girdiye deterministik davranışı korur.

## 3. Yanıt — `status: "ready" | "partial"`

Analiz tamamlandığında:

```json
{
  "id": "fixture-rust-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "rust-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": true, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "rust-attribute-macro-route-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 1.0,
  "unsupportedConstructs": [...],
  "warnings": [],
  "diagnostics": [{ "relativePath": "...", "code": "PARSE_ERROR", "message": "...", "line": 3 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → tanı yok; `"partial"` → en az bir tanı var (TŞ §7:
  "Parser başarısızsa yalnızca kanıtlanabilen bilgi sunulur"). Tanı kodları
  worker-analiz düzeyidir: `PARSE_ERROR` (syn parse hatası),
  `IMPL_UNKNOWN_TYPE` (bildirimi sette olmayan tipin impl'i modellenmez),
  `MACRO_ITEM_SKIPPED` (makro ile tanımlı üst-düzey öğe atlanır),
  `RESPONSE_TRUNCATED` (yanıt node bütçesi aşıldı — `maxNodes`/MaxResponseNodes;
  uçları yayınlanmayan kenarlar düşer, dangling yok). `line` 1 tabanlıdır,
  bilinmiyorsa 0.
- `coverageRatio` = verified kenar / toplam kenar (4 ondalık; TS adapter
  kuralı). Kenar yoksa 0.
- `evidence` = kenarların taşıdığı kanıtların küme içinde tekil (dedupe)
  listesi. Kenarın kendisi `evidence` alanında aynı kayıtları taşır.

### Node alanları (domain GraphNode karşılığı — ID'siz)

```json
{
  "kind": "Class",
  "qualifiedName": "crate::services::OrdersService",
  "language": "rust",
  "relativePath": "services.rs",
  "attributes": { "sourceHash": "..." }
}
```

- `kind` — TŞ §8 27-node kataloğuyla sınırlıdır. Kullanılanlar: `File`,
  `Class`, `Interface`, `Function`, `Method`, `Endpoint`, `UnknownExternal`.
- `qualifiedName` kuralları (deterministik, kaynaktan türetilen):
  - Modül yolu: relativePath → `.rs` son eki atılır → `/` ile
    segmentlere bölünür → öndeki `src` segmenti atılır → sondaki
    `main`/`lib`/`mod` segmenti atılır → kalanlar `::` ile birleşir ve
    `crate::` öneki alınır (segment kalmadıysa `crate`).
    Örnek: `services.rs` → `crate::services`; `main.rs` → `crate`.
  - Serbest `fn` → `Function`: `<modül>::<fn>`.
  - `struct` ve `enum` → `Class`: `<modül>::<Ad>` (TŞ §8 C# eşlemesinin
    karşılığı; ask sözleşmesi: "struct/enum → Class").
  - `trait` → `Interface`: `<modül>::<Trait>`.
  - impl içindeki `fn` → `Method`: `<modül>::<Tip>::<fn>`; trait içindeki
    metot bildirimi → `Method`: `<modül>::<Trait>::<metot>`.
  - UnknownExternal: çağrı ifadesinin çözümlenen metni (ör.
    `std::env::var`), çözülemeyen metot çağrısında metot adı, yolu
    olmayan çağrıda `(anonim-cağrı)`.
  - Endpoint: `"METHOD PATH"` (ör. `"GET /orders"`); `attributes`:
    `method` + `path` (önde `/` ile).
- `attributes` — File: `sourceHash` (UTF-8 SHA-256, 64 hex); Endpoint:
  `method` + `path`; diğerleri boş nesne.

### Edge alanları (domain GraphEdge karşılığı — ID'siz)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Function", "qualifiedName": "crate::list_orders", "relativePath": "main.rs" },
  "to":   { "kind": "Method", "qualifiedName": "crate::services::OrdersService::list", "relativePath": "services.rs" },
  "resolution": "heuristic",
  "evidence": [ { "kind": "semantic-symbol", "span": {...}, "analyzerId": "rust-worker", "analyzerVersion": "0.1.0", "rationale": "..." } ],
  "ambiguity": { "candidates": ["..."], "reason": "..." }
}
```

- `from`/`to` domain **NodeRef** biçimidir (kind + qualifiedName +
  relativePath); ID alanı YOKTUR — ID'ler TŞ §8 invariant (iii) gereği
  domain normalizer'da (packages/domain `createSnapshot`) deterministik
  üretilir. **Worker KİMLİK ÜRETMEZ** (TŞ §7.1).
- Worker'ın ürettiği kenar türleri: `CONTAINS`, `CALLS`, `ROUTES_TO`.
  (IMPORTS — `use` → IMPORTS kenarı — bu dilimde üretilmez;
  `capabilities.importEdges: false` açık beyan.)
- Aynı (kind, from, to, resolution) anahtarlı kenarlar birleştirilir;
  evidence listeleri küme içinde tekilleşir ve sıralanır.

### Evidence alanları (domain Evidence karşılığı — ID'siz)

```json
{
  "kind": "semantic-symbol",
  "span": { "relativePath": "main.rs", "startLine": 12, "endLine": 12, "sourceHash": "<sha256-hex>" },
  "analyzerId": "rust-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: ... (verified; syn AST, semantik çözümleyici yoktur)."
}
```

- `span` her zaman mevcuttur; satırlar 1 tabanlıdır ve kaynak dosya
  içeriği ile birebir eşleşir (kabul testleri bunu dosya metninden
  hesaplar). Kanıt türleri: `ast-span` (CONTAINS + unresolved CALLS),
  `semantic-symbol` (çözümlenmiş CALLS), `route-attribute` (ROUTES_TO) —
  TŞ §8 kanıt türleri kümesinden.
- **Dürüstlük notu:** syn'in SEMANTİK çözümleyicisi yoktur; "semantic-symbol"
  kanıt türü burada yalnızca TŞ §8 kümesindeki karşılık gelen slotu
  taşır. Dayanak her zaman AST + deterministik isim tablosudur ve
  rationale metni bunu açıkça söyler.

### Resolution kuralı (TŞ §8 — rust-worker karşılığı)

| resolution | Ne zaman |
|---|---|
| `verified` | **(a)** Bare çağrı (`foo()`) AYNI dosyada (modülde) tanımlı `fn` ile eşleşir — ask sözleşmesi. **(b)** Nitelikli yol çağrısı (`a::B::c` / `B::c`) analiz seti isim tablosunda (impl metotları + serbest fn'ler) TEK eşleşme bulur. **(c)** ROUTES_TO: route özniteliği fn'e sözdizimsel olarak bağlıdır. Sınırlama (belgeli): nitelikli çağrının modül önekleri tam doğrulanmaz — eşleşme son iki segment + analiz seti tek adaydır. |
| `heuristic` | **(a)** Metot çağrısı (`x.foo()`) — alıcı türü çözülemez (trait dispatch bu dilimde yok); tek isim adayı hedef gösterilir, çok aday `ambiguity` ile işaretlenir. **(b)** Bare çağrı başka dosyada tek adaya eşleşir (import kanıtı yok). **(c)** Nitelikli yol çağrısı çok aday bulur — `ambiguity` taşıyarak. |
| `unresolved` | Hiçbir aday yok (ör. `std::env::var`, `Vec::new`); hedef açık UnknownExternal node'dur, **uydurma hedef üretilmez**. |

### `unsupportedConstructs` (bu dilimde modellenmeyenler)

`trait-method-dispatch` (metot çağrısı alıcı türü çözülmez → heuristic),
`macro-defined-items` (makro gövdeleri/makro öğeleri gezilmez + tanı),
`use-import-resolution` (IMPORTS yok), `cross-crate-symbol-resolution`
(set dışı semboller UnknownExternal), `nested-fn-items` (fonksiyon içi
nested fn/trait/impl gövdeleri gezilmez), `struct-literal-references`
(`Order { .. }` kenarı üretmez).

## 4. Hata yanıtı — `status: "error"`

```json
{
  "id": null,
  "protocolVersion": "1",
  "status": "error",
  "error": { "code": "INVALID_ARGUMENT", "message": "..." }
}
```

- İstek düzeyi sorunlar (şema ihlali, mutlak yol, `..` kaçışı, duplicate
  yol, bilinmeyen `type`, bilinmeyen `protocolVersion`, bozuk JSON) tüm
  isteği reddeder; döngü DEVAM EDER — sonraki satır işlenir.
- `id`, satır ayrıştırılabilirse istemcinin gönderdiği değerle echo
  edilir; ayrıştırılamazsa `null`. Bozuk satır döngüyü düşürmez.
- Kodlar yalnızca TŞ §10.1 + K-008 kümesinden: `INVALID_ARGUMENT`,
  `INTERNAL_ERROR`, `LIMIT_EXCEEDED` (kaynak sınırları — yukarıdaki
  tablo). Worker kendi hata kodu icat etmez.
- Dosya düzeyi ayrıştırma sorunları HATA DEĞİLDİR → `status:"partial"` +
  `diagnostics` (yukarıda).

## 5. Sürüm alanı

- `protocolVersion` istekte opsiyoneldir; mevcutsa `"1"` olmalıdır.
- Yanıt her zaman `protocolVersion: "1"` taşır; `worker.analyzerVersion`
  Cargo.toml `[package].version` ile senkron tutulur (kabul testi bunu
  manifest'ten okuyarak doğrular) ve `Evidence.analyzerVersion`'a yazılır.
- Kırılabilir değişiklik (alan adı/anlamsal değişim) → sürüm artışı; yeni
  alan eklemek sürüm artışı gerektirmez.

## 6. Determinizm sözleşmesi (TŞ §8 invariant iv/vi)

- Aynı `files` girdisi → birebir aynı yanıt satırı (kabul testi bunu iki
  koşum arasında bayt-bayt doğrular).
- Kaynaklar relativePath'e göre Ordinal sıralanır; node çıktısı
  (kind, qualifiedName, relativePath) kanonik anahtarla, kenar çıktısı
  (kind, from, to, resolution) kanonik anahtarla sıralanır; saat okunmaz;
  BTreeMap/BTreeSet dışı sıralı olmayan yapı kullanılmaz.

## 7. Kabül koşusu (fixture)

`examples/fixture-rust-app/` (3 dosya: main.rs, services.rs,
repositories.rs) stdin üzerinden gönderilir; kabul testleri
`tests/rust-worker.test.ts` (`npx vitest run tests/rust-worker.test.ts`).
Test bootstrap'ı cargo mevcutken derlemeyi HER TURDA koşturur
(incremental) ve başarısız derlemede suite'i AÇIKÇA fail eder — Rust
derleme regresyonu sessiz skip/yeşil ile geçiştirilmez; skip yalnızca
cargo bulunamadığında meşrudur (çalıştırılamadı olarak raporlanır):

- **Pozitif:** `GET /orders → list_orders` ve `POST /orders →
  create_order` ROUTES_TO kenarları verified; `list_orders →
  create_audit_entry` (aynı modül) ve `OrdersService::new →
  OrderRepository::new` (nitelikli yol) CALLS verified; metot çağrısı
  (`service.list()`) heuristic; `save` çağrısı trait + impl adaylarıyla
  heuristic + ambiguity; `std::env::var` unresolved + UnknownExternal;
  evidence satırları fixture metniyle eşleşir; node/edge türleri TŞ §8
  kataloğu içinde.
- **Negatif:** boş `files` / eksik `files` / `..` segmenti / mutlak yol /
  duplicate path / bilinmeyen üst-düzey alan / files[] bilinmeyen alan /
  eksik `id` / bilinmeyen `type` / bilinmeyen `protocolVersion` / bozuk
  JSON / `maxNodes` aralık dışı (0, 250001) ya da tam sayı değil (1.5,
  true) → `INVALID_ARGUMENT` + id echo; bozuk satırdan sonra worker
  yaşamaya devam eder. Sınırlar: 3 MB içerik ve 5001 dosya →
  `LIMIT_EXCEEDED`.
- **Partial:** sözdizimi hatası → `status:"partial"` + dosya/satır
  taşıyan tanılar; graph yine üretilir.
- **Node bütçesi:** `maxNodes` aralık/tam-sayı reddiyeleri `INVALID_ARGUMENT`;
  üst sınır (`250000`) kabul edilir; 13 node'lu kümeye `maxNodes: 5` →
  5 node yayınlanır, uçları yayınlanmayan kenarlar düşer (dangling yok),
  `RESPONSE_TRUNCATED` + `status:"partial"`, evidence yalnızca yayımlanan
  kenarların kanıtlarından oluşur ve kırpılmış yanıt birebir
  tekrarlanır. Sembol-yoğun girdi (8000 ayrı aynı-modül çağrı) tek
  koşumda süre bütçesi içinde tamamlanır (push_edge BTreeMap indeksli —
  O(E²) doğrusal tarama yok).
- **Determinizm:** aynı istek iki koşuda birebir aynı yanıt satırı.
