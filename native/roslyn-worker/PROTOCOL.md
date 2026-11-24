# Roslyn Worker stdin/stdout Protokolü — v1

> Kanıt: TŞ v2.1 §7 (Roslyn sidecar, "L2, controller/minimal API L3"), §8
> (Unified Evidence & Knowledge Graph sözleşmesi), §23 (Faz B). Alan adları,
> `packages/domain/src/snapshot.ts`'teki createSnapshot GİRDİ sözleşmesiyle
> (SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput — NodeRef
> uçlu, ID'siz) birebir hizalıdır; graph-schema.ts'teki GraphNode'tan fark,
> kimlik alanının `location` yerine `relativePath` olmasıdır.

**Causoryn Roslyn sidecar worker** — LLM çalıştırmayan, yerel ve
deterministik C#/ASP.NET Core çözümleyicisi. Süreç stdin'den satır satır
istek okur, her isteğe tek satır JSON yanıt döner ve analiz boyunca kullanıcı
workspace'ine HİÇBİR YAZMA yapmaz (ADR-008; derleme tamamen bellek-içindedir).

- **Çalışma zamanı ve derleyici.** Worker `net10.0` hedefler ve `.NET 10` ile çalışır.
  `Causoryn.RoslynWorker.csproj`, `Microsoft.CodeAnalysis.CSharp` sürümünü `5.12.0` olarak sabitler.
- **Taşıma:** yerel stdio; satır-bazlı JSON (her mesaj birebir tek satır).
- **Kodlama:** BOM'suz UTF-8; JSON içi yeni satırlar `\n` kaçış dizisidir,
  bu yüzden framing bozulmaz.
- **stdout disiplini (kırmızı çizgi):** stdout'ta YALNIZCA protokol satırları
  taşınır; tüm loglar `stderr`'e yazılır (`[roslyn-worker] ` öneki ile).
- **Kodlama kuralı:** JSON anahtarları domain'deki alan adlarıyla aynıdır
  (camelCase); opsiyonel alanlar `null` yerine YOK olarak yazılır — tek
  istisna `id` alanıdır (hata yanıtlarında açıkça `null` taşınır).

## 1. Mesaj çerçeveleme

```
stdout ← {"id":...,"status":"ready",...}\n     (istek başına tam olarak bir satır)
stderr ← [roslyn-worker] ...                   (loglar; protokolün parçası değil)
```

- İstemci, worker sürecini başlatır ve stdin'e istek satırları yazar.
- Her boş olmayan satır bir istektir; boş satırlar sessizce atlanır.
- Worker süreci istemci stdin'i kapattığında (EOF) `0` çıkış kodu ile biter.
  Yalnızca stdio kablosu kırılırsa (`IOException`) `1` ile biter.

## 2. İstek — `type: "analyze"`

```json
{
  "id": "fixture-orders-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "Controllers/OrdersController.cs", "content": "... kaynak kod ..." }
  ],
  "referenceDirs": ["C:/dizin/dll/ler"]
}
```

| Alan | Tür | Kural |
|---|---|---|
| `id` | string \| sayı | **Zorunlu.** Yanıtta birebir echo edilir. |
| `type` | string | **Zorunlu.** Yalnızca `"analyze"` desteklenir. |
| `protocolVersion` | string | Opsiyonel. Varsa `"1"` olmalıdır. |
| `files` | dizi | **Zorunlu, en az 1.** Bellek-içi kaynak çantası. |
| `files[].path` | string | **Zorunlu.** Workspace-relative POSIX yolu. Mutlak yol, `""`/`.`/`..` segmentleri reddedilir. Aynı yol iki kez verilemez. |
| `files[].content` | string | **Zorunlu.** Tam kaynak kod. |
| `referenceDirs` | string[] | Opsiyonel. Ek MetadataReference dizinleri (ör. NuGet DLL'leri). Mevcut olmayan dizin uyarı üretir, hata değil. |
| `maxNodes` | tam sayı | Opsiyonel (güvenlik bulgusu 4). Yanıt node bütçesi; `1..MaxResponseNodes` aralığında olmalı, dışı `INVALID_ARGUMENT`. Verilmezse `MaxResponseNodes` uygulanır. |
| `projects` | dizi | Optional MSBuild project model (see "Projects" below). Absent → every file shares one compilation. |

İstek nesnesinde bilinmeyen alan → `INVALID_ARGUMENT` (kesin şema reddi,
Zod strictObject disipliniyle aynı).

### Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri)

| Sınır | Değer | Aşım davranışı |
|---|---|---|
| `MaxRequestLineChars` | 64.000.000 char (UTF-8'de kötümser bayt üst sınırı; 64 MB bayt bütçesini aşamaz) | Satır newline'a kadar DISCARD edilir; `id: null` + `LIMIT_EXCEEDED` yanıtı yazılır, döngü devam eder. |
| `MaxFileCount` | 5.000 dosya/istek | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2.000.000 bayt/dosya (TŞ §20 `maxFileBytes` ile uyumlu) | İstek reddedilir: `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` | 250.000 node/yanıt (güvenlik bulgusu 4; istek `maxNodes` ile altında seçilebilir) | Sert tavan ya da istek bütçesi dolunca aşan node'lar YAYINLANMAZ; uçları yayınlanmayan kenarlar da düşer (dangling yok). Yanıta `RESPONSE_TRUNCATED` tanısı düşer ve `status: "partial"` olur — sessiz kesim yoktur. |

Sınırlar sabittir (protokol v1'de istekte yapılandırılamaz) ve aynı girdiye
deterministik davranışı korur. Çalışma zamanı ayrıca parser/gezinme için
geniş stack'li thread kullanır; AST gezinme derinliği 1000'i aşan alt
ağaçlar atlanır ve dosya başına bir kez `ADAPTER_INTERNAL` tanısı + uyarı
verilir (analiz `partial` olur — süreç StackOverflow ile ölmez).

### Referans keşfi (otomatik)

Worker, istekte `referenceDirs` yoksa kurulum kökünden iki ref-pack'i arar:
`packs/Microsoft.NETCore.App.Ref/<en-yeni>/ref/netX.Y` ve
`packs/Microsoft.AspNetCore.App.Ref/<en-yeni>/ref/netX.Y`. Kök adayları
sırayla: `DOTNET_ROOT` ortam değişkeni → dotnet host konumu (yalnızca host
`dotnet(.exe)` ise) → standart kurulum yolu (Windows: `%ProgramFiles%\dotnet`;
Unix: `/usr/share/dotnet`, `/usr/lib/dotnet`).

- Pack'ler bulunursa tüm üst-dizin DLL'leri referans olarak eklenir ve
  `warnings`'e açık not yazılır.
- BCL pack'i yoksa: yalnızca `System.Private.CoreLib` eklenir (çalışma
  zamanı düşüşü) — kaynak-içi CALLS/CONTAINS etkilenmez, BCL türevleri
  çözümsüz kalır ve uyarı yazılır.
- ASP.NET pack'i yoksa: controller/minimal API öznitelikleri semantik
  çözümlenemez → bilinen-ad kuralı heuristic ROUTES_TO üretir (aşağıda).
  Bu bir uyarı olarak da bildirilir.

### Projects (optional `projects` field)

SDK-style projects get `global using` directives generated by the .NET SDK at
build time (`<ImplicitUsings>enable</ImplicitUsings>`, `Using` items), and
MSBuild compiles every project separately. The adapter
(`adapters/csharp-roslyn/src/project-model.ts`) evaluates `.csproj` and
`Directory.Build.props` files read-only inside the workspace and sends the
result; the worker never reads project files itself.

```json
"projects": [
  {
    "path": "src/App/App.csproj",
    "assemblyName": "App",
    "globalUsings": [
      { "name": "System" },
      { "name": "System.Math", "static": true },
      { "name": "System.Text.StringBuilder", "alias": "SB" }
    ],
    "projectReferences": ["src/Lib/Lib.csproj"]
  }
]
```

| Field | Type | Rule |
|---|---|---|
| `path` | string | **Required.** Workspace-relative POSIX path of a `.csproj` file; same path rules as `files[].path`. Paths are unique and at most one project per directory. |
| `assemblyName` | string | Optional; `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$`. Default: the project file name without extension (duplicates get a `.2`, `.3` suffix and a warning). |
| `globalUsings` | object[] | Optional, ≤ 512. `name`: dotted C# name (identifier segments only); `alias`: one identifier; `static`: boolean. `static` together with `alias` is rejected. |
| `projectReferences` | string[] | Optional, ≤ 512. Workspace-relative `.csproj` paths. |

Unknown fields, invalid names or paths → `INVALID_ARGUMENT`; more than 1024
projects or a list over its bound → `LIMIT_EXCEEDED`.

Semantics:

- A source file belongs to the project whose directory is its nearest ancestor
  (MSBuild default compile globbing). Files outside every project share one
  compilation, exactly as when `projects` is absent.
- Every project is its own compilation, so global usings, entry points
  (top-level statements vs `Main`, CS7022) and duplicate type names of one
  project never leak into another.
- `globalUsings` become one synthetic in-memory tree per project
  (`global using global::Name;`, `global using static global::Name;`,
  `global using Alias = global::Name;`), generated only from the validated
  names and sorted (plain, static, alias; then ordinal). The tree is not a
  workspace file: it produces no File node, and an Error/Warning diagnostic
  inside it (for example a namespace whose reference pack is missing) is
  reported in `warnings` as `generated global using of project '<path>'
  reported <code>: <message>` instead of being dropped.
- `projectReferences` and their transitive closure (the SDK default) are added
  as compilation references, dependencies first. References to projects that
  own no analyzed source are skipped; references to paths not in `projects`
  are skipped with a warning; a reference that closes a cycle is ignored with
  a `ProjectReference cycle` warning. All compilations share the same metadata
  references, so a call into a referenced project resolves to that project's
  own source symbol (verified CALLS edge to its Method node).

## 3. Yanıt — `status: "ready" | "partial"`

Analiz tamamlandığında:

```json
{
  "id": "fixture-orders-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "roslyn-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": true, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "aspnetcore-controller-attribute-and-minimal-api-call-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 1.0,
  "unsupportedConstructs": [...],
  "warnings": ["reference pack loaded: ..."],
  "diagnostics": [{ "relativePath": "...", "code": "CS0246", "message": "...", "line": 15 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → tanı yok; `"partial"` → en az bir Warning/Error tanısı
  var (TŞ §7: "Parser başarısızsa yalnızca kanıtlanabilen bilgi sunulur").
  Tanılar Roslyn `GetDiagnostics` (parse+declaration+semantic+body) içinden
  Warning+Error seviyesinde toplanır; `line` 1 tabanlıdır, bilinmiyorsa 0.
- `coverageRatio` = verified kenar / toplam kenar (4 ondalık; TS adapter
  kuralı). Analiz seti dışı çağrılar (ör. `List<T>.Add`) UnknownExternal
  üzerinde **verified** sayılır (checker dayanaklı — TS adapter kuralı),
  yani coverage onları düşürmez.
- `evidence` = kenarların taşıdığı kanıtların küme içinde tekil (dedupe)
  listesi. Kenarın kendisi `evidence` alanında aynı kayıtları taşır.

### Node alanları (domain GraphNode karşılığı — ID'siz)

```json
{
  "kind": "Class",
  "qualifiedName": "Causoryn.Fixture.Orders.Services.OrdersService",
  "language": "csharp",
  "relativePath": "Services/OrdersService.cs",
  "attributes": { "sourceHash": "...", "method": "GET", "path": "/api/Orders/{id}" }
}
```

- `kind` — TŞ §8 27-node kataloğuyla sınırlıdır; worker liste dışı kind
  üretemez (çıkış anında sert doğrulama). Kullanılanlar: `File`, `Class`,
  `Interface`, `Type`, `Function`, `Method`, `Endpoint`, `UnknownExternal`.
- `qualifiedName` kuralları:
  - Tip: `AdAlani.TipAdi` (global namespace'te: `TipAdi`); nested tipler
    noktayla birleşir. `record` → `Class`, `record struct`/`struct`/`enum` →
    `Type`, `interface` → `Interface`. Generic arity eki taşınmaz
    (bilinçli yaklaşım, dedupe anahtarı qualifiedName olduğundan aşırı
    yüklemeler gibi davranır).
  - Metot: `AdAlani.Tip.MetotAdi`; kurucular `AdAlani.Tip.constructor`;
    property'ler `AdAlani.Tip.OzellikAdi`.
  - Top-level local function: `Program.<ad>` (sentetik Program sınıfı kuralı).
  - UnknownExternal: `AdAlani.Tip.Uye` (analiz seti dışı sembol) veya çağrı
    ifadesinin kaynak metni (hiç çözümlenemeyen çağrılar).
- `attributes` — File: `sourceHash` (UTF-8 SHA-256, 64 hex); Endpoint:
  `method` + `path` (önde `/` ile, ör. `"/api/Orders/{id}"`).

### Edge alanları (domain GraphEdge karşılığı — ID'siz)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Method", "qualifiedName": "...OrdersController.GetById", "relativePath": "..." },
  "to":   { "kind": "Method", "qualifiedName": "...OrdersService.GetById", "relativePath": "..." },
  "resolution": "verified",
  "evidence": [ { "kind": "semantic-symbol", "span": {...}, "analyzerId": "roslyn-worker", "analyzerVersion": "0.1.0", "rationale": "..." } ],
  "ambiguity": { "candidates": ["HttpGet"], "reason": "..." }
}
```

- `from`/`to` domain **NodeRef** biçimidir (kind + qualifiedName +
  relativePath); ID alanı YOKTUR — ID'ler TŞ §8 invariant (iii) gereği
  domain normalizer'da (packages/domain `createSnapshot`) deterministik
  üretilir. **Worker KİMLİK ÜRETMEZ** (TŞ §7.1: canonical ID merkezi
  normalizer'dadır). B2'deki TS adapter bu çıktıyı workspaceId ile
  `createSnapshot`'a besler; dangling edge bütünlüğü orada zorlanır.
- Worker'ın ürettiği kenar türleri: `CONTAINS`, `CALLS`, `ROUTES_TO`.
  (IMPORTS — `using` → IMPORTS kenarı — B1 kapsamında üretilmez;
  `capabilities.importEdges: false` açık beyan).

### Evidence alanları (domain Evidence karşılığı — ID'siz)

```json
{
  "kind": "semantic-symbol",
  "span": { "relativePath": "...", "startLine": 31, "endLine": 31, "sourceHash": "<sha256-hex>" },
  "analyzerId": "roslyn-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: ... Roslyn semantic model ile ... sembolüne çözümlendi (verified)."
}
```

- `span` her zaman mevcuttur; satırlar 1 tabanlıdır ve kaynak dosya içeriği
  ile birebir eşleşir (kabul koşusu bunu dosya metninden hesaplar).
- Kanıt türleri: `ast-span` (CONTAINS + çözümlenemeyen CALLS), `semantic-symbol`
  (çözümlenmiş CALLS), `route-attribute` (ROUTES_TO) — TŞ §8 kanıt türleri
  kümesinden.

### Resolution kuralı (TŞ §8)

| resolution | Ne zaman |
|---|---|
| `verified` | Semantic model kaynak sembolü çözümledi (set içinde ya da dışında — dış kaynaklar açık UnknownExternal node'da); controller/minimal API öznitelik/uzantı tipleri Microsoft.* köküne semantik çözümlendi. |
| `heuristic` | Bilinen ad kuralı dayanağı var, semantik çözümleme yok (ör. ASP.NET ref pack'i bulunamadığında `[HttpGet]` adı); kenar `ambiguity` taşıyarak işaretlenir. |
| `unresolved` | Hiç çözümlenemedi (hata tipi/dinamik/aşırı yükleme belirsizliği); hedef açık UnknownExternal node'dur, **uydurma hedef üretilmez**. |

### `unsupportedConstructs` (bu dilimde modellenmeyenler)

`reflection/dynamic-dispatch`, `dynamic-di-configuration`, `source-generators`,
`function-local-declarations` (metot İÇİ local function; top-level olanlar
`Program.<ad>` Function node'u olur), `inline-anonymous-route-handlers`
(lambda handler → Endpoint korunur, kenar üretilmez + uyarı),
`constructor-initializer-chains` (`this(...)`/`base(...)`), `field-initializer-calls`
(caller'sız çağrılar) ve `convention-routing-templates` ([Route] özniteliği
olmayan controller'da endpoint üretilmez + uyarı).

## 4. Hata yanıtı — `status: "error"`

```json
{
  "id": null,
  "protocolVersion": "1",
  "status": "error",
  "error": { "code": "INVALID_ARGUMENT", "message": "..." }
}
```

- İstek düzeyi sorunlar (şema ihlali, mutlak yol, `..` kaçışı, duplicate yol,
  bilinmeyen `type`, bilinmeyen `protocolVersion`, bozuk JSON) tüm isteği
  reddeder; döngü DEVAM EDER — sonraki satır işlenir.
- `id`, satır ayrıştırılabilirse istemcinin gönderdiği değerle echo edilir;
  ayrıştırılamazsa `null`. Bozuk satır döngüyü düşürmez.
- Kodlar yalnızca TŞ §10.1 + K-008 kümesinden: `INVALID_ARGUMENT`,
  `INTERNAL_ERROR`, `LIMIT_EXCEEDED` (kaynak sınırları — yukarıdaki tablo).
  Worker kendi hata kodu icat etmez.
- Dosya düzeyi ayrıştırma/semantik sorunlar HATA DEĞİLDİR → `status:"partial"`
  + `diagnostics` (yukarıda).

## 5. Sürüm alanı

- `protocolVersion` istekte opsiyoneldir; mevcutsa `"1"` olmalıdır.
  Desteklenen sürüm desteklenmiyorsa `INVALID_ARGUMENT` döner.
- Yanıt her zaman `protocolVersion: "1"` taşır; `worker.analyzerVersion`
  csproj `<Version>0.1.0</Version>` ile senkron tutulur ve
  `Evidence.analyzerVersion`'a yazılır.
- Kırılabilir değişiklik (alan adı/anlamsal değişim) → sürüm artışı; yeni
  alan eklemek sürüm artışı gerektirmez.

## 6. Determinizm sözleşmesi (TŞ §8 invariant iv/vi)

- Aynı `files` girdisi → birebir aynı yanıt satırı (kabul koşusu bunu iki
  koşu arasında bayt-bayt doğrular).
- Kaynaklar relativePath'e göre Ordinal sıralanır; node/edge/evidence çıktısı
  kanonik anahtarla sıralanır; saat okunmaz; `referenceDirs` işlenme sırası
  sabittir.
- `projects`, their `globalUsings` and `projectReferences` are sorted
  ordinally before compilations are built; the same project model yields the
  same compilations and the same output.
- Referans DLL kümesi (otomatik keşif veya referenceDirs) semantiği
  etkileyebilir — analyzerFingerprint'e girme sorumluluğu B2 normalizer'dadır.

## 7. Kabül koşusu (fixture)

`examples/fixture-csharp-orders/` (4 dosya: Program.cs, Controllers/
OrdersController.cs, Services/OrdersService.cs, Repositories/OrderRepository.cs)
stdin üzerinden gönderilir; kabul testleri `tests/roslyn-worker.test.ts`
(`npx vitest run tests/roslyn-worker.test.ts`). Test bootstrap'ı dotnet
mevcutken derlemeyi HER TURDA koşturur (incremental) ve başarısız derlemede
suite'i AÇIKÇA fail eder — C# derleme regresyonu sessiz skip/yeşil ile
geçiştirilmez; skip yalnızca dotnet SDK bulunamadığında meşrudur
(çalıştırılamadı olarak raporlanır):

- **Pozitif:** `OrdersController.GetById → OrdersService.GetById →
  OrderRepository.GetAll` ve `.Create → .Save` CALLS zincirleri verified +
  evidence satırları fixture metniyle eşleşir; `GET /api/Orders/{id}`,
  `POST /api/Orders` (controller) ve `GET /health` (minimal API) ROUTES_TO
  kenarları verified; node/edge türleri TŞ §8 kataloğu içinde.
- **Negatif:** boş `files` / eksik `files` / `..` segmenti / mutlak yol /
  duplicate path / bilinmeyen üst-düzey alan / files[] bilinmeyen alan /
  eksik `id` / bilinmeyen `type` / bilinmeyen `protocolVersion` /
  bozuk JSON → `INVALID_ARGUMENT` + id echo; bozuk satırdan sonra worker
  yaşamaya devam eder. Sınırlar: 3 MB içerik ve 5001 dosya → `LIMIT_EXCEEDED`.
- **Partial:** sözdizimi hatası → `status:"partial"` + dosya/satır taşımayan
  değil, dosya+satır taşımaya devam eden tanılar; graph yine üretilir.
- **Determinizm:** aynı istek iki koşuda birebir aynı yanıt satırı.
