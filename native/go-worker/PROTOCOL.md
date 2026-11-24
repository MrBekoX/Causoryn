# Go Worker stdin/stdout Protokolü — v1

> Kanıt: TŞ v2.1 §7 (dil adapter'ları), §8 (Unified Evidence & Knowledge
> Graph sözleşmesi), §23 (dil planı — M1-Go dilimi). Alan adları,
> `packages/domain/src/snapshot.ts`'teki createSnapshot GİRDİ sözleşmesiyle
> (SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput — NodeRef
> uçlu, ID'siz) birebir hizalıdır. Desen kaynağı:
> `native/roslyn-worker/PROTOCOL.md` v1 (kanıtlanmış sidecar örüntüsü).

**Causoryn Go sidecar worker** — LLM çalıştırmayan, yerel ve deterministik
Go çözümleyicisi. Süreç stdin'den satır satır istek okur, her isteğe tek
satır JSON yanıt döner ve analiz boyunca kullanıcı workspace'ine HİÇBİR
YAZMA yapmaz (ADR-008; analiz tamamen bellek-içindedir — go/parser kaynakları
stdin'den alır, diskte hiçbir şey derlemez).

- **Taşıma:** yerel stdio; satır-bazlı JSON (her mesaj birebir tek satır).
- **Kodlama:** BOM'suz UTF-8; JSON içi yeni satırlar `\n` kaçış dizisidir,
  bu yüzden framing bozulmaz.
- **stdout disiplini (kırmızı çizgi):** stdout'ta YALNIZCA protokol satırları
  taşınır; tüm loglar `stderr`'e yazılır (`[go-worker] ` öneki ile).
- **Kodlama kuralı:** JSON anahtarları domain'deki alan adlarıyla aynıdır
  (camelCase); opsiyonel alanlar `null` yerine YOK olarak yazılır — tek
  istisna `id` alanıdır (hata yanıtlarında açıkça `null` taşınır).
- **Bağımlılık:** Yalnızca Go stdlib (`go/parser` + `go/ast` + `go/token` +
  `crypto/sha256` + `encoding/json`); go.mod'da dış modül YOKTUR.

## 1. Mesaj çerçeveleme

```
stdout ← {"id":...,"status":"ready",...}\n     (istek başına tam olarak bir satır)
stderr ← [go-worker] ...                       (loglar; protokolün parçası değil)
```

- İstemci, worker sürecini başlatır ve stdin'e istek satırları yazar.
- Her boş olmayan satır bir istektir; boş satırlar sessizce atlanır.
- Worker süreci istemci stdin'i kapattığında (EOF) `0` çıkış kodu ile biter.
  Yalnızca stdio kablosu kırılırsa `1` ile biter.
- Son satırda newline olmasa da boş olmayan satır istek olarak işlenir.

## 2. İstek — `type: "analyze"`

```json
{
  "id": "fixture-go-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "cmd/app/main.go", "content": "... kaynak kod ..." }
  ],
  "maxNodes": 100000
}
```

| Alan | Tür | Kural |
|---|---|---|
| `id` | string \| sayı | **Zorunlu.** Yanıtta birebir (ham JSON olarak) echo edilir. |
| `type` | string | **Zorunlu.** Yalnızca `"analyze"` desteklenir. |
| `protocolVersion` | string | Opsiyonel. Varsa `"1"` olmalıdır. |
| `files` | dizi | **Zorunlu, en az 1.** Bellek-içi kaynak çantası. |
| `files[].path` | string | **Zorunlu.** Workspace-relative POSIX yolu. Mutlak yol, `""`/`.`/`..` segmentleri reddedilir. Aynı yol iki kez verilemez. |
| `files[].content` | string | **Zorunlu.** Tam kaynak kod. |
| `maxNodes` | tam sayı | Opsiyonel. Yanıt node bütçesi; `1..MaxResponseNodes` aralığında olmalı, dışı `INVALID_ARGUMENT`. Verilmezse `MaxResponseNodes` uygulanır. |

İstek nesnesinde (ve `files[]` öğelerinde) bilinmeyen alan →
`INVALID_ARGUMENT` (kesin şema reddi, Zod strictObject disipliniyle aynı).

### Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri)

| Sınır | Değer | Aşım davranışı |
|---|---|---|
| `MaxRequestLineChars` | 64.000.000 char | Satır newline'a kadar DISCARD edilir; `id: null` + `LIMIT_EXCEEDED` yanıtı yazılır, döngü devam eder. |
| `MaxFileCount` | 5.000 dosya/istek | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2.000.000 bayt/dosya (UTF-8) | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` | 250.000 node/yanıt | Sert tavan ya da istek bütçesi dolunca aşan node'lar YAYINLANMAZ; uçları yayınlanmayan kenarlar da düşer (dangling yok). Yanıta `RESPONSE_TRUNCATED` tanısı düşer ve `status: "partial"` olur — sessiz kesim yoktur. |

Sınırlar sabittir (protokol v1'de istekte yapılandırılamaz) ve aynı girdiye
deterministik davranışı korur. AST gezinme derinliği 1000'i aşan gövdeler
çağrı çıkarımına DAHİL EDİLMEZ; dosya başına bir kez `GO_AST_DEPTH` tanısı +
uyarı verilir ve analiz `partial` olur (Go yığınları büyüdüğü için çökme
riski düşüktür; sınırın amacı sınırlı iş + dürüst rapordur).

## 3. Yanıt — `status: "ready" | "partial"`

```json
{
  "id": "fixture-go-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "go-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": false, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "go-http-handlefunc-and-gin-echo-chi-registration-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 0.6923,
  "unsupportedConstructs": [
    "semantic-type-resolution", "inline-anonymous-route-handlers",
    "builtin-function-calls", "closure-call-attribution"
  ],
  "warnings": ["..."],
  "diagnostics": [{ "relativePath": "...", "code": "GOPARSE", "message": "...", "line": 12 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → tanı ve uyarı yok; `"partial"` → en az bir tanı/uyarı
  var (TŞ §7: "Parser başarısızsa yalnızca kanıtlanabilen bilgi sunulur").
  Tanılar go/parser `scanner.ErrorList`'ten (kod `GOPARSE`, satır 1 tabanlı,
  bilinmiyorsa 0) ve `RESPONSE_TRUNCATED`/`GO_AST_DEPTH`'ten toplanır.
- `coverageRatio` = verified kenar / toplam kenar (4 ondalık; kenar yoksa
  1.0 — boş kümede vacuous truthful, bilinçli karar).
- `evidence` = YAYINLANAN kenarların taşıdığı kanıtların küme içinde tekil
  (dedupe) listesi. Kenarın kendisi `evidence` alanında aynı kayıtları taşır.
- `capabilities.symbolResolution: false` **dürüstlük beyanıdır**: go/types
  semantik model KULLANILMAZ; aşağıdaki tablodaki kurallar AST + ad
  kuralıdır (heuristic).

### Node alanları (domain GraphNode karşılığı — ID'siz)

```json
{
  "kind": "Function",
  "qualifiedName": "services.OrdersService",
  "language": "go",
  "relativePath": "services/orders_service.go",
  "attributes": { "sourceHash": "..." }
}
```

- `kind` — TŞ §8 27-node kataloğuyla sınırlıdır; worker liste dışı kind
  üretemez. Kullanılanlar: `File`, `Class` (struct), `Interface`,
  `Type` (diğer type decl), `Function` (top-level func), `Method`
  (alıcılı func), `Endpoint`, `UnknownExternal`.
- `qualifiedName` kuralları:
  - Top-level func: `<package>.<FuncAd>` (ör. `main.ordersHandler`).
  - Metot: `<package>.<TipAd>.<MetotAd>` (pointer alıcı `*T` → `T`;
    generic alıcı `T[...]` → temel ad; ör. `services.OrdersService.GetOrders`).
  - Tip: `<package>.<TipAd>` (struct → Class, interface → Interface,
    diğer → Type).
  - File: relativePath'in kendisi.
  - Endpoint: `"<METHOD> <path>"` (ör. `"* /orders"`, `"GET /users"`).
  - UnknownExternal: çağrı ifadesinin kaynak metni (ör.
    `json.NewEncoder(w).Encode`) veya bare ident adı.
- `attributes` — File: `sourceHash` (UTF-8 SHA-256, 64 hex); Endpoint:
  `method` + `path` (`http.HandleFunc` HTTP fiili taşımadığından method
  `"*"` olur). Diğer türlerde `{}`.

### Edge alanları (domain GraphEdge karşılığı — ID'siz)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Function", "qualifiedName": "main.ordersHandler", "relativePath": "main.go" },
  "to":   { "kind": "Method", "qualifiedName": "services.OrdersService.GetOrders", "relativePath": "services/orders_service.go" },
  "resolution": "heuristic",
  "evidence": [ { "kind": "ast-span", "span": {...}, "analyzerId": "go-worker", "analyzerVersion": "0.1.0", "rationale": "..." } ],
  "ambiguity": { "candidates": ["services.OrdersService.GetOrders"], "reason": "unique method name rule; ..." }
}
```

- `from`/`to` domain **NodeRef** biçimidir (kind + qualifiedName +
  relativePath); ID alanı YOKTUR — ID'ler domain normalizer'da
  (`createSnapshot`) deterministik üretilir. **Worker KİMLİK ÜRETMEZ.**
- Worker'ın ürettiği kenar türleri: `CONTAINS`, `CALLS`, `ROUTES_TO`.
  (IMPORTS üretülmez — `import` → IMPORTS kenarı bu dilimde yoktur;
  `capabilities.importEdges: false` açık beyan. import bilgisi yalnızca
  çağrı çözümlemede "analiz seti dışı package" ayrımı için kullanılır.)
- UnknownExternal node'lar `relativePath` TAŞIMAZ (set dışı sembolün
  dosyası yoktur).
- Aynı (kind, from, to) üçlüsü tek kenarda birleşir; kanıtlar birleştirilir
  (dedupe).

### Evidence alanları (domain Evidence karşılığı — ID'siz)

```json
{
  "kind": "ast-span",
  "span": { "relativePath": "main.go", "startLine": 38, "endLine": 38, "sourceHash": "<sha256-hex>" },
  "analyzerId": "go-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: ... (verified)."
}
```

- `span` her zaman mevcuttur; satırlar 1 tabanlıdır ve kaynak dosya
  içeriği ile birebir eşleşir.
- Kanıt türleri: `ast-span` (CONTAINS + CALLS) ve `route-registration`
  (ROUTES_TO). `route-registration`, Go route kayıt ÇAĞRI kalıbı için
  dürüst addır — C#'ın `route-attribute` (öznitelik) kanıtıyla karıştırılmaz;
  `Evidence.kind` domain şemasında bilinçli olarak serbest string'dir
  (packages/domain graph-schema.ts notu).

### Resolution kuralı (TŞ §8) — dürüstlük tablosu

| # | Kalıp | resolution | Hedef |
|---|---|---|---|
| 1 | Bare ident çağrı; ad aynı package'ta tanımlı top-level func | `verified` | Function node (go/ast declaration eşleşmesi — kaynak-içi sembol) |
| 2 | Bare ident çağrı; ad builtin (`len`, `make`, ...) | — | Kenar ÜRETİLMEZ (unsupportedConstructs'ta beyan) |
| 3 | Bare ident çağrı; ad bulunamadı | `unresolved` | UnknownExternal(ad) — uydurma hedef yok |
| 4 | `pkg.Func`; pkg analiz setindeki package clause adı VE Func tanımlı | `heuristic` + ambiguity | Function node (ad kuralı; go/types yok) |
| 5 | `pkg.X`; pkg analiz setinde ama X tanımlı değil | `unresolved` | UnknownExternal("pkg.X") |
| 6 | Selector; temel ident bir import local adı (set dışı package; zincirli akış dahil) | `heuristic` + ambiguity | UnknownExternal(çağrı metni) |
| 7 | `x.M()` / `x.field.M()`; M adı sette tam bir metotta benzersiz | `heuristic` + ambiguity | Method node (benzersiz metot adı kuralı) |
| 8 | `x.M()`; M birden fazla metotta | `unresolved` + ambiguity (adaylar) | UnknownExternal(çağrı metni) |
| 9 | `x.M()`; M bir arayüz metodu adı (somut gerçekleme sette yok) | `heuristic` + ambiguity | UnknownExternal(çağrı metni; aday = arayüz.M) |
| 10 | Hiç eşleşmeyen selector / zincir | `unresolved` | UnknownExternal(çağrı metni) |

`verified` yalnızca #1'de (ve route kaydında named handler için) kullanılır:
go/ast, adı aynı package scope'undaki bir top-level func declaration ile
birebir eşler (gölgeleme uyumsuzluğu AST'ten ayırt edilemez; bilinçli,
belgelenmiş yaklaşımdır — semantic-type-resolution unsupportedConstructs'ta).

### Route tespiti (L3)

Tanınan kayıt kalıpları: `Handle`, `HandleFunc` (method `"*"`), `GET`,
`POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS` (büyük/küçük harf
duyarsız — chi `Get`, gin/echo `GET` aynen). İki koruma şarttır: (1) ilk
argüman string literal ve `/` önekli, (2) en az iki argüman. Tanınan kayıt
çağrıları CALLS ÜRETMEZ (semantikleri Endpoint + ROUTES_TO ile tam temsil
edilir). Handler çözümü: named func (aynı package) → `verified`; selector →
yukarıdaki tablo (heuristic/unresolved); func literal → inline anonim
handler: Endpoint KORUNUR, ROUTES_TO ÜRETİLMEZ + uyarı
(`inline-anonymous-route-handlers`).

### unsupportedConstructs (bu dilimde modellenmeyenler)

`semantic-type-resolution` (go/types yok — ad kuralı heuristic'leri),
`inline-anonymous-route-handlers`, `builtin-function-calls`,
`closure-call-attribution` (func literal içindeki çağrılar kapsayan adlı
fonksiyona yazılır).

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
- `id`, satır ayrıştırılabilirse istemcinin gönderdiği değerle echo edilir;
  ayrıştırılamazsa `null`. Bozuk satır döngüyü düşürmez.
- Kodlar yalnızca TŞ §10.1 + K-008 kümesinden: `INVALID_ARGUMENT`,
  `INTERNAL_ERROR`, `LIMIT_EXCEEDED`. Worker kendi hata kodu icat etmez.
  Beklenmeyen panic `recover` ile yakalanır → `INTERNAL_ERROR` yanıtı;
  süreç yaşar.
- Dosya düzeyi ayrıştırma sorunları HATA DEĞİLDİR → `status:"partial"` +
  `diagnostics`; graph yine üretilir (parse edilebilen kısımlar katkı verir).

## 5. Sürüm alanı

- `protocolVersion` istekte opsiyoneldir; mevcutsa `"1"` olmalıdır.
- Yanıt her zaman `protocolVersion: "1"` taşır; `worker.analyzerVersion`
  model.go `AnalyzerVersion` (0.1.0) sabitiyle senkronudur ve
  `Evidence.analyzerVersion`'a yazılır.
- Kırılabilir değişiklik → sürüm artışı; yeni alan eklemek sürüm artışı
  gerektirmez.

## 6. Determinizm sözleşmesi (TŞ §8 invariant iv/vi)

- Aynı `files` girdisi → birebir aynı yanıt satırı (test bunu iki koşum
  arasında bayt-bayt doğrular; `go run` ve binary modu aynı graph'ı üretir).
- Kaynaklar relativePath'e göre sıralanır; node/edge/evidence çıktısı
  kanonik anahtarla sıralanır; saat okunmaz; map yineleme sırası çıktıya
  sırtlanmaz.

## 7. Kabül koşusu (fixture)

`examples/fixture-go-app/` (4 dosya: go.mod, main.go, services/
orders_service.go, repositories/orders_repository.go) stdin üzerinden
gönderilir; kabul testleri `adapters/go/test/go-adapter.test.ts`
(`npx vitest run adapters/go/test/go-adapter.test.ts`). Test bootstrap'ı go
mevcutken worker derlemesini HER TURDA koşturur (`go build ./...` ve `-o
bin/go-worker-test.exe`) ve başarısız derlemede suite'i AÇIKÇA fail eder —
derleme regresyonu sessiz skip/yeşil ile geçiştirilmez; skip yalnızca Go
toolchain bulunamadığında meşrudur (koşulamadı olarak raporlanır):

- **Pozitif:** `ordersHandler → newOrderService → OrdersService.GetOrders →
  OrdersRepository.FindAll` ve `createOrderHandler → ... → Save` zincirleri;
  bare-ident verified, package-qualified + benzersiz metot adı heuristic,
  tip çözümsüz selector unresolved; `"* /orders"`, `"* /orders/create"`,
  `"* /health"` ROUTES_TO verified; node/edge türleri TŞ §8 kataloğu içinde;
  evidence satırları fixture metniyle eşleşir.
- **Negatif:** boş `files` / eksik `files` / `..` segmenti / mutlak yol /
  duplicate path / bilinmeyen üst-düzey alan / files[] bilinmeyen alan /
  eksik `id` / bilinmeyen `type` / bilinmeyen `protocolVersion` / bozuk
  JSON → `INVALID_ARGUMENT` + id echo; bozuk satırdan sonra worker
  yaşamaya devam eder. Sınırlar: 2 MB içerik ve 5001 dosya →
  `LIMIT_EXCEEDED`; `maxNodes` aralık dışı → `INVALID_ARGUMENT`.
- **Partial:** sözdizimi hatası → `status:"partial"` + `GOPARSE` tanıları,
  graph yine üretilir; `maxNodes` kırpma → `RESPONSE_TRUNCATED` + dangling
  kenar yok; 1000+ derinlik → `GO_AST_DEPTH`; inline anonim handler →
  Endpoint korunur + uyarı.
- **Determinizm:** aynı istek iki koşumda birebir aynı yanıt satırı.

## 8. Spawn kararı (adapter tarafı)

- **Varsayılan: `go run ./cmd/worker`** (cwd = native/go-worker). Gerekçe:
  worker kaynağı repo-içi tek doğruluk kaynağıdır; derleme GOCACHE'te
  cache'lenir (ısınmış koşum saniyeler içindedir); derleme hatası stderr'de
  açıkça görünür ve unavailable fallback gerekçesine yazılır; release
  paketinde binary artefaktı taşımaya gerek bırakmaz. İlk soğuk derleme
  dakikayı aşabilir → adapter default timeout 120 sn (Roslyn'deki 30 sn'den
  farklı, belgeli sapma).
- **Önceden derlenmiş binary:** `goWorkerBinaryPath` opsiyonu ya da
  `CAUSORYN_GO_WORKER_BIN` env → spawn [binaryPath, []]. Test konvansiyonu:
  `go build -o native/go-worker/bin/go-worker-test.exe ./cmd/worker`
  (bin/ gitignore kapsamındadır). Release paketlemesi bu yolu kullanır.
- Her iki modda komut config sabitidir; argüman dizisi SABİT; shell YOK;
  istek içeriği yalnızca stdin'de taşınır.
