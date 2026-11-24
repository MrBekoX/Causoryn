# Python Worker stdin/stdout Protokolü — v1

> Kanıt: TŞ v2.1 §7 (Python FastAPI/Django — "Python AST + framework
> rules", "L1/L2, seçili L3"), §8 (Unified Evidence & Knowledge Graph
> sözleşmesi), §22 ("Python selected route; unresolved dynamic import;
> deterministic export" golden testleri), §23 (DoD: positive/negative/
> partial fixture + evidence). Desen kaynağı: `native/roslyn-worker/
> PROTOCOL.md` v1. Alan adları, `packages/domain/src/snapshot.ts`'teki
> createSnapshot GİRDİ sözleşmesiyle (SnapshotNodeInput /
> SnapshotEdgeInput / SnapshotEvidenceInput — NodeRef uçlu, ID'siz)
> birebir hizalıdır.

**Causoryn Python sidecar worker** — LLM çalıştırmayan, yerel ve
deterministik Python çözümleyicisi. Yalnızca Python stdlib kullanır
(`ast` + `hashlib` + `json` + `sys` — sıfır dış bağımlılık). Süreç
stdin'den satır satır istek okur, her isteğe tek satır JSON yanıt döner
ve analiz boyunca kullanıcı workspace'ine HİÇBİR YAZMA yapmaz (ADR-008;
analiz tamamen bellek-içindedir).

- **Taşıma:** yerel stdio; satır-bazlı JSON (her mesaj birebir tek satır).
- **Kodlama:** BOM'suz UTF-8; worker binary buffer (`sys.stdin.buffer` /
  `sys.stdout.buffer`) ile çalışır — Windows konsol kod sayfasından
  bağımsızdır. JSON içi yeni satırlar `\n` kaçış dizisidir, framing
  bozulmaz. Adapter env allowlist'i `PYTHONIOENCODING`'i BİLBLİÇLI
  TAŞIMAZ — değer, allowlist dışında parent'tan bağımsız her zaman
  `"utf-8"` olarak sabitlenir (aşağıdaki log kanalı maddesi);
  `PYTHONPATH` de bilinçli taşınmaz (worker saf stdlib'tir).
- **stdout disiplini (kırmızı çizgi):** stdout'ta YALNIZCA protokol
  satırları taşınır; tüm loglar `stderr`'e yazılır (`[python-worker] `
  öneki ile). **Log kanalı UTF-8'dir:** worker kendi stderr'ini
  `reconfigure(encoding="utf-8")` ile sabitler ve adapter spawn env'inde
  `PYTHONIOENCODING=utf-8` değerini parent'tan bağımsız sabitler — piped
  stderr locale kod sayfasına (Windows ANSI) düşemez (takım denetimi
  bulgusu; kabul testi: "stderr UTF-8 kodlanır — PYTHONIOENCODING olmasa
  bile").
- **Kodlama kuralı:** JSON anahtarları domain'deki alan adlarıyla aynıdır
  (camelCase); opsiyonel alanlar `null` yerine YOK olarak yazılır — tek
  istisna `id` alanıdır (hata yanıtlarında açıkça `null` taşınır).
- **Bytecode disiplini:** adapter worker'ı `python -B` ile başlatır;
  worker hiçbir dosyaya yazmaz (`__pycache__` dahil).

## 1. Mesaj çerçeveleme

```
stdout ← {"id":...,"status":"ready",...}\n     (istek başına tam olarak bir satır)
stderr ← [python-worker] ...                   (loglar; protokolün parçası değil)
```

- İstemci, worker sürecini başlatır ve stdin'e istek satırları yazar.
- Her boş olmayan satır bir istektir; boş satırlar sessizce atlanır.
- Worker süreci istemci stdin'i kapattığında (EOF) `0` çıkış kodu ile biter.
  Yalnızca stdio kabuğu kırılırsa (`BrokenPipeError`/`OSError`) `1` ile biter.

## 2. İstek — `type: "analyze"`

```json
{
  "id": "fixture-orders-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "services/orders_service.py", "content": "... kaynak kod ..." }
  ]
}
```

| Alan | Tür | Kural |
|---|---|---|
| `id` | string \| sayı | **Zorunlu.** Yanıtta birebir echo edilir (bool kabul edilmez). |
| `type` | string | **Zorunlu.** Yalnızca `"analyze"` desteklenir. |
| `protocolVersion` | string | Opsiyonel. Varsa `"1"` olmalıdır. |
| `files` | dizi | **Zorunlu, en az 1.** Bellek-içi kaynak çantası. |
| `files[].path` | string | **Zorunlu.** Workspace-relative POSIX yolu. Mutlak yol, sürücü harfi, `\` karakteri, `""`/`.`/`..` segmentleri reddedilir. Aynı yol iki kez verilemez. |
| `files[].content` | string | **Zorunlu.** Tam kaynak kod. |
| `maxNodes` | tam sayı | Opsiyonel (güvenlik bulgusu 4 deseni). Yanıt node bütçesi; `1..250000` aralığında olmalı, dışı `INVALID_ARGUMENT`. Verilmezse `MAX_RESPONSE_NODES` uygulanır. |

İstek nesnesinde bilinmeyen alan → `INVALID_ARGUMENT` (kesin şema reddi);
`files[]` öğesinde bilinmeyen alan → aynı davranış.

### Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri)

| Sınır | Değer | Aşım davranışı |
|---|---|---|
| `MAX_REQUEST_LINE_BYTES` | 64.000.000 bayt | Satır newline'a kadar DISCARD edilir; `id: null` + `LIMIT_EXCEEDED` yanıtı yazılır, döngü devam eder. |
| `MAX_FILE_COUNT` | 5.000 dosya/istek | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MAX_FILE_CONTENT_BYTES` | 2.000.000 bayt/dosya (TŞ §20 `maxFileBytes` ile uyumlu) | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MAX_RESPONSE_NODES` | 250.000 node/yanıt | Sert tavan ya da istek bütçesi dolunca aşan node'lar YAYINLANMAZ; uçları yayınlanmayan kenarlar da düşer (dangling yok). Yanıta `RESPONSE_TRUNCATED` tanısı düşer ve `status: "partial"` olur — sessiz kesim yoktur. |

Sınırlar sabittir (protokol v1'de istekte yapılandırılamaz) ve aynı
girdiye deterministik davranışı korur.

**Derinlik savunması (takım denetimi netleştirmesi):** birincil savunma
CPython parser'ının yapısal sınırlarıdır — aşırı derin iç içe yapılar
`ast.parse` aşamasında `SyntaxError` ("too many levels of indentation" /
"too many nested parentheses") ile reddedilir → dosya başına `SyntaxError`
tanısı + yalnızca File node (L0), analiz `partial` sürer ve süreç yaşamaya
devam eder (kabul testi: tests/python-worker.test.ts "aşırı derin iç içe
yapı"). İkincil katman olarak AST gezinme derinliği 1000'i aşan alt
ağaçlar atlanır ve dosya başına bir kez `ADAPTER_INTERNAL` tanısı yazılır;
bu sayaç tipik koşumda tetiklenmez (parser sınırı daha önce devreye girer).

**Süreç yaşamlılığının gerçek mekanizması (takım denetimi tur-2
netleştirmesi):** bildirim/çağrı gezinmesi REKÜRSİFTİR (`_declare` /
`_walk_calls`) — beklenmedik derinlik `RecursionError` üretebilir ve
geziniğin kendisi "iteratif" değildir. Süreç bununla ölmez çünkü
`handle_line`'ın analiz gövdesini saran `except Exception` savunması her
beklenmeyen istisnayı istek-başına hata yanıtına çevirir ve döngüyü ayakta
tutar. Aynı şekilde derin iç içe JSON satırının `json.loads`'unun
fırlattığı `RecursionError` açıkça yakalanır → `INVALID_ARGUMENT` yanıtı,
döngü devam eder (kabul testi: "derin iç içe JSON satırı").

## 3. Yanıt — `status: "ready" | "partial"`

Analiz tamamlandığında:

```json
{
  "id": "fixture-orders-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "python-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": true, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "python-decorator-route-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 0.64,
  "unsupportedConstructs": [...],
  "warnings": ["app.py: the route path of decorator 'flask_app.get' is not a literal string; ..."],
  "diagnostics": [{ "relativePath": "broken.py", "code": "SyntaxError", "message": "...", "line": 1 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → tanı yok; `"partial"` → en az bir tanı var
  (TŞ §7: "Parser başarısızsa yalnızca kanıtlanabilen bilgi sunulur").
  Tanı kaynakları: dosya başına `SyntaxError` (satır 1 tabanlı; bilinmiyorsa
  0), `ADAPTER_INTERNAL` (derinlik/parse savunması, line 0),
  `RESPONSE_TRUNCATED` (node bütçesi, line 0, relativePath "").
- `coverageRatio` = verified kenar / toplam kenar (4 ondalık; TS adapter
  kuralı). Kenar yoksa 1.0.
- `evidence` = yayımlanan kenarların taşıdığı kanıtların küme içinde tekil
  (dedupe) listesi. Kenarın kendisi `evidence` alanında aynı kayıtları taşır.

### Node alanları (domain GraphNode karşılığı — ID'siz)

```json
{
  "kind": "Function",
  "qualifiedName": "services.orders_service.create_order",
  "language": "python",
  "relativePath": "services/orders_service.py",
  "attributes": { "sourceHash": "...", "method": "POST", "path": "/orders" }
}
```

- `kind` — TŞ §8 27-node kataloğuyla sınırlıdır; worker liste dışı kind
  üretemez (çıkış anında sert doğrulama). Kullanılanlar: `File`,
  `Function`, `Method`, `Class`, `Endpoint`, `UnknownExternal`.
- `qualifiedName` kuralları:
  - **File:** relativePath'in kendisi (roslyn kuralıyla aynı).
  - **Modül adı türetme:** `app.py` → `app`; `services/orders_service.py` →
    `services.orders_service`; `pkg/__init__.py` → `pkg`.
  - **Modül düzeyi fonksiyon:** `<modül>.<ad>` (ör. `app.get_orders`).
  - **Sınıf:** `<modül>.<Sınıf>`; **metot:** `<modül>.<Sınıf>.<ad>`;
    iç içe sınıf noktayla birleşir.
  - **İç içe fonksiyon** (fonksiyon gövdesinde def): `<sarmalayan qn>.<ad>`
    — sınıf üyesi sayılmaz (`Function` kind).
  - **Endpoint:** `"{VERB} {path}"` (ör. `"GET /orders"`) — roslyn Endpoint
    kuralıyla aynı.
  - **UnknownExternal:** çağrı ifadesinin kaynak metni; noktalı zincir
    çözülebiliyorsa zincir (ör. `logger.info`, `_ORDERS.values`), yoksa
    `ast.unparse` çıktısı. **Dil bilgisi olmayan sembol uydurulmaz.**
- `attributes` — File: `sourceHash` (UTF-8 SHA-256, 64 hex); Endpoint:
  `method` + `path` (önde `/` ile). Diğer kind'lerde `{}`.
- `language` — tüm node'larda `"python"` (UnknownExternal dahil; çağrı
  noktası Python kaynağıdır).

### Edge alanları (domain GraphEdge karşılığı — ID'siz)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Function", "qualifiedName": "app.add_order", "relativePath": "app.py" },
  "to":   { "kind": "Function", "qualifiedName": "services.orders_service.create_order",
            "relativePath": "services/orders_service.py" },
  "resolution": "heuristic",
  "evidence": [ { "kind": "ast-span", "span": {...}, "analyzerId": "python-worker",
                  "analyzerVersion": "0.1.0", "rationale": "CALLS: ... (heuristic; ...)." } ],
  "ambiguity": { "candidates": ["services.orders_service.create_order"],
                 "reason": "imported module symbol; Python name binding is dynamic, ..." }
}
```

- `from`/`to` domain **NodeRef** biçimidir (kind + qualifiedName +
  relativePath); ID alanı YOKTUR — ID'ler TŞ §8 invariant (iii) gereği
  domain normalizer'da deterministik üretilir. **Worker KİMLİK ÜRETMEZ.**
- UnknownExternal uçlar relativePath TAŞIMAZ (analiz seti dışı sembol;
  roslyn EnsureExternal kuralı).
- Worker'ın ürettiği kenar türleri: `CONTAINS`, `CALLS`, `ROUTES_TO`.
  (IMPORTS kenarı bu dilimde üretilmez — `capabilities.importEdges: false`
  açık beyan; import tablosu yalnızca CALLS çözümlemesi için tutulur.)
- TŞ §8 invariant (ii): dangling edge yok — UnknownExternal hedef, kenar
  eklenirken açık node olarak node kümesine girer.

### Evidence alanları (domain Evidence karşılığı — ID'siz)

```json
{
  "kind": "ast-span",
  "span": { "relativePath": "...", "startLine": 19, "endLine": 19, "sourceHash": "<sha256-hex>" },
  "analyzerId": "python-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: app.add_order → ... (heuristic; tam type inference yok)."
}
```

- `span` her zaman mevcuttur; satırlar 1 tabanlıdır ve istekteki dosya
  içeriği ile birebir eşleşir (kabul koşusu bunu dosya metninden hesaplar).
- Kanıt türleri: `ast-span` (CONTAINS + CALLS), `route-attribute`
  (ROUTES_TO) — TŞ §8 kanıt türleri kümesinden. Python'da semantik model
  motoru YOKTUR; "semantic-symbol" kanıtı BU worker'da ÜRETİLMEZ (dürüst
  etiket kuralı: AST isim bağlamı semantik çözümleme değildir).

### Resolution kuralı (TŞ §8 — dürüstlük tablosu)

| resolution | Ne zaman |
|---|---|
| `verified` | Hedef AYNI modülde tanımlı: modül düzeyi ad (def/class), `self.<m>` (sarmalayan sınıfın üye tablosu), `AynıModülSınıfı.<m>`. Decorator-handler ilişkisi (ROUTES_TO) her zaman verified'dır — dekoratör handler'ın kendisine sözdizimsel bağlıdır. |
| `heuristic` | Hedef IMPORT EDİLEN modül sembolü (analiz setinde ya da dışında). Kenar `ambiguity` taşır. **Tam type inference YOK — dürüst sınırlama (TŞ §7 Python satırı: monkey-patching, runtime DI).** |
| `unresolved` | Çözülemeyen çağrılar: yerel değişken/parametre üzerinden çağrı, built-in'ler (`list`, `isinstance`), tanımsız adlar. Hedef açık UnknownExternal node'dur; **uydurma hedef/kenar üretilmez**. |

Örnek zincir (fixture): `POST /orders → app.add_order` (ROUTES_TO,
verified) → `services.orders_service.create_order` (heuristic; import) →
`repositories.order_repository.save` (heuristic; import) ve
`create_order → _validate_order` (verified; aynı modül).

### Route kuralları (seçili L3 — "python-decorator-route-pattern")

- `@carrier.get("/path")` / `post` / `put` / `patch` / `delete` / `head` /
  `options` / `trace` → Endpoint `{VERB} {path}`. Taşıyıcı adına (`app`,
  `router`, `api`, `bp`...) kısıt konmaz; dekoratör kullanımında bu adlar
  fiilen rota kaydı içindir (bilinen-ad kuralı).
- `@carrier.route("/path")` / `@carrier.api_route("/path")` → Flask tarzı:
  `methods=["GET","POST"]` kwarg'ındaki her method için bir Endpoint;
  belirtilmezse Flask varsayılanı **GET**.
- **Taşıyıcı basit ad DEĞİLSE** (ör. `@routers["main"].get("/x")`,
  subscript/nitelik zincirli taşıyıcı): endpoint ÜRETİLMEZ ve `warnings`'e
  açık not yazılır — "sessiz kesim yoktur" disiplini (takım denetimi
  bulgusu). HTTP-verb/route adlı attr içermeyen dekoratörler rota adayı
  olmadığından sessiz atlanır.
- Endpoint yolu LİTERAL string sabiti OLMALIDIR (`ast.Constant`); değişken
  / ifadesel yol → endpoint ÜRETİLMEZ + `warnings`'e açık not (sessiz kesim
  yoktur).
- Modül düzeyi çağrılar (`app = FastAPI()` vb.) caller'sızdır → CALLS
  üretilmez (`unsupportedConstructs: "module-level-calls"`).

### `unsupportedConstructs` (bu dilimde modellenmeyenler)

`monkey-patching`, `runtime-dependency-injection`,
`dynamic-import (importlib/__import__)`, `local-variable-type-inference`
(yerel değişkene atanan nesnenin metot çağrısı çözülmez),
`module-level-calls (no caller)`, `decorator-arg-non-literal-path`,
`function-level-imports (module-level import table only)`.

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
  yol, bilinmeyen `type`, bilinmeyen `protocolVersion`, bozuk JSON —
  derin iç içe JSON'un `RecursionError`'u dahil — ve UTF-8 bozuk satır)
  tüm isteği reddeder; döngü DEVAM EDER — sonraki satır işlenir.
- `id`, satır ayrıştırılabilirse istemcinin gönderdiği değerle echo
  edilir; ayrıştırılamazsa/geçersizse `null`. Bozuk satır döngüyü düşürmez.
- Kodlar yalnızca TŞ §10.1 + K-008 kümesinden: `INVALID_ARGUMENT`,
  `INTERNAL_ERROR`, `LIMIT_EXCEEDED` (kaynak sınırları — yukarıdaki
  tablo). Worker kendi hata kodu icat etmez.
- Dosya düzeyi ayrıştırma sorunları HATA DEĞİLDİR → `status:"partial"` +
  `diagnostics`; bozuk dosyadan yalnızca File node (sourceHash'li) yayımlanır,
  sağlam dosyaların grafiği üretilmeye devam eder.

## 5. Sürüm alanı

- `protocolVersion` istekte opsiyoneldir; mevcutsa `"1"` olmalıdır.
  Desteklenmeyen sürüm `INVALID_ARGUMENT` döner.
- Yanıt her zaman `protocolVersion: "1"` taşır; `worker.analyzerVersion`
  worker.py `ANALYZER_VERSION` (0.1.0) ile senkron tutulur ve
  `Evidence.analyzerVersion`'a yazılır. TS adapter sabiti
  (`PYTHON_WORKER_ADAPTER_VERSION`) aynı değeri taşır.
- Kırılabilir değişiklik (alan adı/anlamsal değişim) → sürüm artışı; yeni
  alan eklemek sürüm artışı gerektirmez.

## 6. Determinizm sözleşmesi (TŞ §8 invariant iv/vi)

- Aynı `files` girdisi → birebir aynı yanıt satırı (kabul koşusu bunu iki
  koşum arasında bayt-bayt doğrular — `tests/python-worker.test.ts`).
- Kaynaklar relativePath sırasıyla işlenmez; node/edge/evidence çıktısı
  kanonik anahtarla sıralanır (node: kind+qualifiedName+relativePath;
  edge: kind+uçlar+resolution; evidence: canonical JSON). Saat okunmaz;
  ortam okunmaz (stdlib dışı import yok).
- `ast.parse` deterministiktir; `ast.unparse` (UnknownExternal kaynak
  metni için) aynı sürümde deterministiktir. Çıktı `ensure_ascii=False`,
  kompakt ayraçlarla UTF-8 yazılır.

## 7. Kabül koşusu (fixture)

`examples/fixture-python-app/` (3 dosya: app.py, services/
orders_service.py, repositories/order_repository.py) stdin üzerinden
gönderilir; kabul testleri `tests/python-worker.test.ts` ve
`adapters/python/test/python-adapter.test.ts` (`npx vitest run <dosya>`,
kökten). Test bootstrap'ı python'ı HER TURDA yoklar; worker script yoksa
suite AÇIKÇA fail eder — eksik teslimat sessiz skip/yeşil ile
geçiştirilmez; skip yalnızca python bulunamadığında meşrudur
(çalıştırılamadı olarak raporlanır):

- **Pozitif:** `POST /orders → app.add_order →
  services.orders_service.create_order →
  repositories.order_repository.save` zinciri; `create_order →
  _validate_order`, `self._stamp`, modül fonksiyonu `save` verified CALLS;
  `GET /orders`, `POST /orders` ROUTES_TO verified (route-attribute);
  her verified kenar ≥1 evidence ve span satırı/hash'i fixture metniyle
  eşleşir; node/edge türleri TŞ §8 kataloğu içinde.
- **Negatif:** boş/eksik `files`, eksik `content`, bilinmeyen alanlar,
  `..` segmenti, mutlak yol, sürücü harfi, backslash, boş segment,
  duplicate path, eksik/geçersiz `id`, bilinmeyen `type`,
  bilinmeyen `protocolVersion`, maxNodes aralık dışı → `INVALID_ARGUMENT`
  + id echo; bozuk JSON satırından (5000 katman derin JSON dahil —
  RecursionError catch'i) sonra worker yaşamaya devam eder.
  Sınırlar: 2 MB içerik ve 5001 dosya → `LIMIT_EXCEEDED`.
- **Partial:** sözdizimi hatası → `status:"partial"` + dosya+satır taşıyan
  tanı; bozuk dosyadan uydurma bildirim yok; sağlam dosyanın grafiği
  üretilir. `maxNodes` bütçesi → `RESPONSE_TRUNCATED` + dangling yok.
- **Determinizm:** aynı istek iki koşuda birebir aynı yanıt satırı.
