# 5 Dilli Analizörler, Dürüst Çözümleme Disiplini ve Sidecar Protokolü

> **Dil / Language:** **Türkçe** | [English](en/language-analyzers.md) · [Dokümantasyon Merkezi](README.md)
>
> **Durum:** Causoryn 0.3.2'i yansıtır (1.0 öncesi). İç analizör sürümleri `0.1.0` olarak kalır (bkz. §6).
>
> **Kaynak modüller:** `packages/indexing/src/{index.ts,index-service.ts,job-manager.ts,inventory.ts,fingerprint.ts}`, `packages/workspace/src/ignore-matcher.ts`, `packages/mcp-server/src/{services.ts,workspace-ignore-discovery.ts}`, `packages/sidecar-ipc/src/index.ts`, `adapters/typescript/src/{analyzer.ts,tsconfig-loader.ts}`, `adapters/{csharp-roslyn,python,go,rust}/src/*`, `native/{roslyn-worker,python-worker,go-worker,rust-worker}`.

Causoryn, **TypeScript / JavaScript**, **C# (.NET / Roslyn)**, **Python**, **Go** ve **Rust** analizlerini tek bir Birleşik Kanıt ve Bilgi Grafiğinde (Unified Evidence & Knowledge Graph) birleştirir. Analizörler hiçbir model çağrısı yapmadan sonuçlarını sözdiziminden, sembollerden ve desteklenen framework kurallarından türetir. Her `verified` kenar kaynak kanıtı taşır; diğer her eşleşme çözümleme durumunu (`ambiguity` ile `heuristic` ya da `unresolved`) açıkça belirtir. Her MCP envelope'u dil başına doğruluk düzeyini `coverage.byLanguage` içinde raporlar; böylece güçlü TypeScript kapsamı, başka bir dildeki L0 düşüşünü asla gizlemez.

Polyglot indeksleme, analizörler arasında aynı kimliği paylaşan yolsuz (pathless) dış veya sanal düğümleri (örneğin `UnknownExternal`) tek bir kanonik kayıtta birleştirir; dosyaya bağlı düğümler arasındaki kimlik çakışmaları hata olarak raporlanır (`packages/indexing/src/index-service.ts`). Eşit sonuçlar eşit girdiler gerektirir: dosya içerikleri, etkin yapılandırma ve aynı analizör ve araç zinciri koşulları. Eksik bir çalışma zamanı, değişmiş bir referans paketi veya bir zaman aşımı, kapsamı ve tanıları değiştirebilir.

---

## 1. Yetenek Matrisi (`INDEXED_ADAPTERS`)

`causoryn_status` (`action: "inspect"`; `full` profilinde ayrıca `causoryn_get_capabilities`) bu tabloyu doğrudan `INDEXED_ADAPTERS`'tan (`packages/indexing/src/index.ts`) yayımlar:

| Dil | `analyzerId` (`version`) | Çalışma modeli | `astParse` | `symbolResolution` | `frameworkLinkers` (rotalar ve testler) | Üretilen kenar türleri |
|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | `ts-adapter` (`0.1.0`) | Süreç içi TypeScript Compiler API `5.9.3` (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`; `allowJs: true`, `checkJs: false`, `jsx: Preserve`) | `L1` | `L2` (`TypeChecker`; ESM + CommonJS; CHA) | `express+nextjs` + genel `<x>.<verb>` rotaları + BDD `Test` düğümleri / `TESTS` kenarları | `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO`, `TESTS` |
| **C# / .NET** | `roslyn-worker` (`0.1.0`) | Sidecar: `adapters/csharp-roslyn` ↔ `native/roslyn-worker` (`dotnet exec`) | `L1` | `L2` (Roslyn `SemanticModel`; CHA) | `aspnet-core-route-attributes (L3)` (controller `[Route]`/`[Http*]` + Minimal API `MapGet`/…) | `CONTAINS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO` (`importEdges: false`) |
| **Python** | `python-worker` (`0.1.0`) | Sidecar: `adapters/python` ↔ `native/python-worker/worker.py` | `L1` | `L2` (sözcüksel/sınıf kapsamı; tür çıkarımı yok) | `decorator-route-pattern (L3)` (FastAPI/Starlette `@app.get`/… + Flask `@app.route`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Go** | `go-worker` (`0.1.0`) | Sidecar: `adapters/go` ↔ `native/go-worker/cmd/worker` | `L1` | `heuristic-only (no semantic L2)` (`symbolResolution: false`, `go/types` yok) | `http-router-registration (L3)` (`net/http` `Handle`/`HandleFunc` + gin/echo/chi) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Rust** | `rust-worker` (`0.1.0`) | Sidecar: `adapters/rust` ↔ `native/rust-worker` | `L1` | `heuristic-heavy` (`syn` 3 AST + sembol tablosu) | `attribute-macro-route (L3)` (Actix-Web / Axum / Rocket fiil makroları) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |

Go etiketi `heuristic-only (no semantic L2)`, çalışma zamanının döndürdüğü birebir dizgedir ("semantik L2 yok").

### Yetenek Katmanları ve Envelope Kapsamı

- **`L0` (envanter ve dosya kökeni):** politikanın kabul ettiği her dosya, UTF-8 SHA-256 `sourceHash` taşıyan bir `File` düğümüne ve `verified` bir `Workspace → File` `CONTAINS` kenarına dönüşür.
- **`L1` (AST ve bildirimler):** yapısal `CONTAINS` kenarlarıyla birlikte `Class`, `Interface` (arayüzler/trait'ler), `Type` (struct'lar/enum'lar/takma adlar), `Function` ve `Method` bildirimleri.
- **`L2` (sembol, hiyerarşi ve çağrı çözümlemesi):** workspace içi sembollere veya açık `UnknownExternal` düğümlerine çözümlenen `CALLS`, `IMPORTS` (TS/JS) ve sınıf hiyerarşisi `INHERITS`/`IMPLEMENTS` (TS/JS ve C#) kenarları.
- **`L3` (framework rotaları ve test bağları):** HTTP `Endpoint` düğümleri, `Endpoint → Handler` `ROUTES_TO` kenarları ve TS/JS BDD `Test → Target` `TESTS` kenarları.
- **`coverage.tier` (`coverageOf`, `packages/mcp-server/src/services.ts`):** snapshot TypeScript, JavaScript, C# veya Python'da AST/sembol düğümleri içeriyorsa `L2`; yalnızca Go veya Rust AST/sembol düğümleri varsa `L1`; yalnızca envanter `File` düğümleri varsa `L0`. `coverage.coverageRatio` değeri `(verified + heuristic) / totalEdges` formülüyle hesaplanır.
- **`coverage.byLanguage`:** dil başına (sıralı anahtarlarla) `{ tier, files, verifiedEdges, heuristicEdges, unresolvedEdges, coverageRatio }`; dosyası olan ama AST/sembol düğümü olmayan bir dil `L0` raporlar.
- **C# proje modeli:** her `.csproj` (ve en yakın `Directory.Build.props`; salt okunur okunur, workspace kökünün üstüne çıkılmaz) kendi `ProjectReference` kapanışıyla ayrı bir Roslyn compilation olur. SDK implicit global using'leri (`Microsoft.NET.Sdk`, `.Web`, `.Worker` ve Windows masaüstü SDK'ları için `<ImplicitUsings>enable</ImplicitUsings>`; Microsoft Learn tablosuna göre) ve `<Using Include/Remove/Alias/Static>` öğeleri MSBuild içe aktarma sırasıyla uygulanır. Açık bir uyarıyla değerlendirilmeyenler: çoğu MSBuild koşulu, `$(...)` özellikleri, `<Choose>`, `<Import>`, `Directory.Build.targets` ve bu tablonun dışındaki SDK'lar (ör. Razor, BlazorWebAssembly, MSTest). Hiçbir projeye ait olmayan kaynaklar ortak bir yedek compilation paylaşır. Bir proje en çok 512 global using (önce SDK varsayılanları) ve 512 `ProjectReference` tutar; sınırlardan biri aşılınca bir uyarı yazılır, böylece aşırı büyük bir proje worker'ın tüm isteği reddetmesine artık yol açmaz. Global using olamayan bir girdi (noktalı bir C# adı değil, tek bir tanımlayıcı olmayan bir alias, alias ile birlikte static veya C# tanımlayıcılarının içeremeyeceği Basic Multilingual Plane dışı karakterler) bir uyarıyla atılır; istek reddedilmez.
- **Node konumları:** her dilde sembol node'ları gerçek, 1 tabanlı bildirim span'ini taşır (TypeScript/JavaScript derleyiciden; C#, Python, Go ve Rust worker'ların isteğe bağlı `span` node alanından, adapter tarafından doğrulanarak — analiz edilen dosyanın içinde olmayan span uyarıyla düşürülür ve node dosya çapasını korur). Birden çok kez bildirilen bir sembol (overload'lar, `partial` sınıflar, property getter/setter, iki Go `init` fonksiyonu, iki `impl` bloğundaki aynı Rust metot adı) tüm bildirimleri kapsayacak şekilde genişletilir. Rust span'leri, syn kanıt span'leri gibi doc yorumundan ya da attribute'tan başlar. File, Endpoint ve UnknownExternal node'ları dosya çapasını (`startLine = endLine = 1`) korur.
- **Senkron köprü ve tam pipeline:** senkron `runIndex` köprüsü (yalnızca programatik, ertelenmemiş başlatmada kullanılır) hiçbir zaman sidecar başlatmaz: TS/JS tam derinlikte çalışırken `.cs`/`.py`/`.go`/`.rs` dosyaları `sync-run-degraded` parmak izi durumu ve açık bir uyarıyla `L0` `File` düğümleri olarak görünür. stdio sunucusu başlatmayı erteler ve tam asenkron pipeline'ı (`runIndexAsync` / `runIncrementalIndexAsync`) arka planda çalıştırır; bu pipeline beş adapter'ın tamamını yürütür ve sonuçları tek bir snapshot'ta birleştirir.

---

## 2. TypeScript / JavaScript, Yapılandırma Yükleme ve Envanter

### 2.1 TypeScript, JavaScript, CommonJS ve Monorepo Workspace'leri (`ts-adapter`)

- **Uzantılar ve dil etiketleri:** `.ts`, `.tsx`, `.mts`, `.cts` → `language: "typescript"`; `.js`, `.jsx`, `.mjs`, `.cjs` → `language: "javascript"`. `checkJs: false`, tiplenmemiş JavaScript'i tip denetimi gürültüsünden uzak tutar.
- **Dosya başına modül biçimi:** her dosya, TypeScript'in karar verdiği şekilde (`impliedNodeFormat`) ESM veya CommonJS kabul edilir: uzantıya göre (`.mts`/`.mjs` ESM, `.cts`/`.cjs` CommonJS), aksi hâlde kök içindeki en yakın `package.json` dosyasının `type` alanına göre. Sınırlandırılmış compiler host her workspace manifest'inin yalnızca bu alanını gösterir; böylece `"type": "module"` paketleri artık `import.meta` için yanlış `TS1470` tanıları almaz.
- **Bildirim span'leri:** sembol node'ları (`Function`, `Method`, `Class`, `Interface`, `Type`, `Handler`, …) gerçek bildirim span'lerini (1 tabanlı `startLine`/`endLine`) taşır; `location` dosyanın başını değil bildirimi gösterir.
- **ESM + CommonJS:** `import`/`export` ifadelerinin yanında, literal bir `require("./module")` bir `IMPORTS` kenarı üretir; üst düzey `exports.<fn> = …`, `module.exports.<fn> = …` ve `module.exports = function <name>(…)` atamaları dışa aktarılan fonksiyon düğümleri üretir.
- **Monorepo workspace'leri:** kök içindeki `package.json` manifest'leri (`name`, `exports`, `types`, `main`, `workspaces`; en fazla 256 manifest, tarama derinliği 4), `@scope/pkg` gibi workspace paket importlarının ve subpath export'larının bellek içi workspace kaynaklarına çözümlenmesini sağlar. Kökün dışına kaçan symlink'ler reddedilir. Kök `workspaces` dahil etme ve hariç tutma desenleri tekilleştirilir ve 256 ile sınırlanır (sınırın ötesinde uyarı), desen açılımı 256 manifest adayı bulunduğunda durur ve bir keşif koşusu en çok 2.048 farklı dizin listeler (bütçe bitince tek bir uyarı).
- **Sınıf Hiyerarşisi Analizi (CHA):** `TypeChecker` ile çözümlenen `INHERITS` (`class A extends B`, `interface X extends Y`) ve `IMPLEMENTS` (`class A implements C`) kenarları; etki analizi ve `causoryn_preflight_change` bu kenarları izler.
- **Artımlı yeniden kullanım:** artımlı koşumlar önceki `ts.Program`'ı `oldProgram` olarak geçirir ve bunu `file_facts` erken kesme (early cutoff) önbelleğiyle birleştirir (bkz. [Mimari Genel Bakış](architecture.md)).
- **Girdi sınırları:** her program kaynak dosyası (paketli `lib*.d.ts` dosyaları hariç) ayrıştırıcı, binder ve checker görmeden önce iteratif bir iç içelik denetiminden geçer. `MAX_SYNTAX_NESTING_DEPTH` (TypeScript'in özyinelemeli işlediği yapılardan 500 düzey: ikili operatörlerden yalnızca `&&`, `||`, `??`, bunların atama biçimleri ve destructuring atamaları sayılır; virgül, düz atama, üs, aritmetik, bitsel ve karşılaştırma zincirleri sayılmaz, bu yüzden tsc/Babel CommonJS çıktısının `exports.a = exports.b = … = void 0` başlığı normal analiz edilir; üye ve çağrı zincirleri ile diğer iç içelikler sayılmaya devam eder) değerinden derin iç içe bir dosya veya ayrıştırması yığını taşıran bir dosya programa boş bir modül olarak ulaşır ve yalnızca dosya düzeyinde, bir `ADAPTER_LIMIT` tanılamasıyla indekslenir (artımlı koşumlarda da); analiz edilen kaynakların dışındaki böyle bir bildirim dosyası yalnızca bir uyarı alır. Type checker oluşturulurken yine de hata fırlatılırsa koşu başarısız olmak yerine her kaynak bir `ADAPTER_INTERNAL` tanılamasıyla dosya düzeyinde indekslenir. 512 karakterden uzun qualified name'ler (`MAX_QUALIFIED_NAME_CHARS`; File node'ları hariç) 200 karakterlik bir baş ve `...<N chars, sha256 <16 hex>>` işaretine kısaltılır; daha kısa adlar ve dolayısıyla mevcut çıktılar değişmez. Dosyaların tamamını yürüyen analiz aşamaları (çağrılar ve route'lar, heritage cümleleri, Express tespiti ve route toplama) açık bir yığın kullanır; böylece uzun zincirler bir aşamayı da taşıramaz.

### 2.2 Kökle Sınırlandırılmış `tsconfig.json` / `jsconfig.json` Yükleyicisi (`tsconfig-loader.ts`)

- **Ayrıştırma:** `ts.parseConfigFileTextToJson` ile JSONC (yorumlar, sondaki virgüller); `eval` yok, plugin yürütme yok. Yalnızca güvenli `compilerOptions` okunur (`baseUrl`, en fazla 200 girdili `paths`, `moduleResolution`, `module`, `target`, `jsx`, `experimentalDecorators`, `verbatimModuleSyntax`). Açık bir `moduleResolution` olmadan `baseUrl` veya `paths` varsa `Bundler`, aksi hâlde `NodeNext` seçilir. `__proto__`, `constructor` ve `prototype` anahtarları reddedilir. Yapılandırma dosyaları 256 KiB ile sınırlıdır.
- **Kökle sınırlandırılmış `extends`:** en fazla 64 dizin kapsamlı yapılandırma; `extends` zincirleri workspace kökünün içinde kalır (derinlik ≤ 5, dosya başına ≤ 16 girdi, toplam 128 çözümleme ziyareti, döngü tespiti).
- **`paths` alias yoklaması:** bellek içi alias hedefleri modül belirteci başına en çok 64, analiz koşusu başına en çok 50.000 kez yoklanır (`MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER`, `MAX_VIRTUAL_ALIAS_PROBES_PER_RUN`); sonuçlar (kapsamlı config, belirteç) başına, modül çözümlemesi ise (içeren dosya, belirteç) başına önbelleğe alınır; böylece program kancası ve `IMPORTS` aşaması her çifti iki kez çözümlemez. Biten bir bütçe import'u çözümlenmemiş bırakır ve tek bir uyarı kaydeder; analiz devam eder. Artımlı koşumlar önceki programın AST'lerini yeniden kullanır ama modül çözümlemelerini kullanmaz; bunlar bu koşunun önbelleğinden program sırasıyla yeniden oynatılır; böylece bütçe tam koşudakiyle aynı sırayla harcanır ve bütçe bittiğinde ikisi aynı `IMPORTS` sonucunu üretir.
- **Sınırlandırılmış derleyici konağı (`configureConfinedCompilerHost`):** derleyici ve modül çözümleme okumaları şunlarla sınırlıdır: (a) politikanın onayladığı workspace girdileri, (b) paketlenmiş `lib*.d.ts` bildirimleri ve (c) kök içindeki `node_modules` altında bulunan `.d.ts`/`.d.mts`/`.d.cts`/`package.json` dosyaları. Diske geri düşüş yolu `lstat` + `realpath` + `O_NOFOLLOW` ile açma + `fstat` (`dev`, `ino`, boyut) kimlik kontrolleri kullanır.
- **Önbellek geçersizleştirme:** `tsconfig.json`, `jsconfig.json`, `go.mod` veya bir workspace `package.json` dosyasını düzenlemek ya da silmek, değişikliği indeks açısından ilgili olarak işaretler ve önbelleğe alınmış olguları geçersiz kılar.

### 2.3 Bloklamayan `collectInventoryAsync` ve Dışlama Motoru

- **`collectInventoryAsync`** (`packages/indexing/src/inventory.ts`) her 64 girdide bir (`yieldEvery = 64`) event loop'a (`setImmediate`) kontrolü bırakır ve senkron `collectInventory` ile aynı sıralı `InventoryEntry[]` çıktısını üretir.
- **Dışlama keşfi** (`packages/mcp-server/src/workspace-ignore-discovery.ts`) kök `.gitignore` dosyasını, symlink olmayan bir `.git/info/exclude` dosyasını ve bütçeyle sınırlı iç içe `.gitignore` dosyalarını birleştirir. `ignore` geçersiz kılınmadıkça kaba `**/bin/**` kuralı .NET çıktı desenlerine daraltılır (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` artı tespit edilen `.csproj`/`.fsproj`/`.vbproj` için `<projDir>/bin/**`); böylece Node `bin/*.ts|js` ve Rust `src/bin/*.rs` dosyaları indekslenmeye devam eder. Bir keşif koşusu eşleştiricinin gerçekten attığı adımları sayar: budama denetimlerini `MAX_DISCOVERY_MATCH_WORK` (300.000.000 adım), negasyon çakışma denetimini `MAX_DISCOVERY_NEGATION_WORK` (20.000.000 adım), incelenen her dizin girdisini `MAX_DISCOVERY_DIRECTORY_ENTRIES` (200.000) bütçesine yazar. Eşleştirme veya dizin girdisi bütçesini harcayan koşu orada durur ve kabul ettiği desenleri korur; negasyon bütçesini harcayan koşu sonraki girdileri çakışma denetimi olmadan tutar (daha fazlası yok sayılır) ve devam eder. Her iki durumda `stderr`'e ne olduğunu söyleyen bir `[causoryn] ignore discovery …` satırı yazılır.
- **Eşleyici:** `packages/workspace/src/ignore-matcher.ts`, hiçbir `RegExp` yürütmeyen (ReDoS geri izlemesi yok), iki işaretçili ve polinom zamanlı bir glob eşleyicisidir. Bir politika kararı yolu ve tüm üst dizinlerini desen başına tek geçişte (çapalı desenler segmentler üzerinde bir otomat olarak) eşler; kararın her ignore geçişi (sözcüksel, kanonik, native) kendi `IGNORE_MATCH_WORK_BUDGET` (1.000.000 adım) bütçesiyle sınırlıdır; bütçesi tükenen bir geçiş yolu reddeder (kural `ignore-match-budget`). Envanter bir koşunun toplam ignore işini sınırlar (`MAX_INVENTORY_IGNORE_WORK`, 10.000.000.000 adım) ve karar veremediği bir yolu asla atmaz: koşu bu durumda `indexing/limit-exceeded` ile biter. Yapılandırılmışlarsa `**/.git/**`, `**/.env*` ve `**/*.pem` reddetme kuralları her platformda benzer görünüm katlamasıyla (NFKD; birleşik işaretler ve ZWJ, ZWSP, yumuşak tire, word joiner ve BOM gibi varsayılan olarak yok sayılabilir kod noktaları atılır; önce büyük sonra küçük harf) yeniden eşlenir; böylece `.GIT`, `.ENV.local` veya `.gıt` da reddedilir. History envanter filtresi aynı derlenmiş kararı kullanır (`compileIgnoreRuleSet`).

---

## 3. Dürüst Kenar Çözümleme Disiplini

Hiçbir analizör makul bir tahmini `verified` düzeyine yükseltmez ve hiçbir worker düğüm, kenar veya kanıt kimliği üretmez: kanonik SHA-256 kimlikleri `createSnapshot` sırasında merkezi olarak `packages/domain` içinde hesaplanır.

1. **`verified`:** bir derleyici semantik modeli veya doğrudan sözdizimsel bağlılık ile statik olarak kanıtlanmıştır. Her `verified` kenar en az bir `Evidence` öğesi (`relativePath`, 1 tabanlı `startLine`/`endLine`, `sourceHash`, `analyzerId`, `analyzerVersion`, `rationale`) taşımak zorundadır; domain kurucuları, Zod şemaları ve SQLite deposu ihlalleri reddeder.
2. **`heuristic` (+ `ambiguity`):** tam statik tür kanıtı olmadan deterministik sözcüksel, import veya benzersiz ad kurallarına dayanır; `ambiguity: { candidates: [...], reason: "..." }` taşır.
3. **`unresolved` (`UnknownExternal`):** çözümlenemeyen ifadeler, dinamik dispatch veya analiz edilmemiş koda yapılan çağrılar açık bir `UnknownExternal` düğümüne işaret eder; böylece sarkan (dangling) kenar ve uydurulmuş hedef olmaz.

### 3.1 Dil Başına `CALLS` ve Hiyerarşi Kuralları

| Dil | `verified` | `heuristic` (+ `ambiguity`) | `unresolved` (`UnknownExternal`) |
|---|---|---|---|
| **TypeScript / JavaScript** | `TypeChecker`, ESM ve CommonJS genelinde çağrı/kurucu imzasını, workspace importunu veya `INHERITS`/`IMPLEMENTS` hedefini analiz edilmiş bir sembole çözümler (paketlenmiş `lib*.d.ts` veya `node_modules` içindeki bildirimler `UnknownExternal` hedefleri olur). | `IMPORTS` kenarlarında göreli modül adayı veya `node:*` yerleşik modül eşleşmesi. | `TypeChecker` hiçbir sembol çözümleyemez (`any` veya dinamik alıcı). |
| **C# (Roslyn)** | `SemanticModel` metodu/kurucuyu ve `BaseType`/`Interfaces` (`INHERITS`/`IMPLEMENTS`) hedeflerini çözümler; referans assembly'ler .NET referans paketlerinden ve mevcutsa salt okunur `obj/project.assets.json` NuGet keşfinden gelir. | Referans assembly'ler eksik olduğunda bilinen ad kuralına geri düşüş. | Aşırı yükleme (overload) belirsizliği, hata sembolleri, `dynamic`/reflection çağrıları. |
| **Python** | Hedef **aynı modülde** tanımlıdır: modül düzeyinde `def`/`class`, `self.<method>` veya `SameModuleClass.<method>`. | İçe aktarılmış sembol (`import` / `from … import`, analiz edilen kümenin içinde veya dışında; bağlamalar dinamiktir ve tür çıkarımı çalışmaz). | Yerel değişkenler/parametreler üzerindeki çağrılar, yerleşikler (`len`, `list`), tanımsız adlar. |
| **Go** | (a) Aynı paketteki üst düzey bir `func`'a çıplak tanımlayıcı çağrısı; paketler **dizine** göre anahtarlanır (çok dosyalı paketler çözümlenir; ayrı `package main` dizinleri asla birbirine bağlanmaz). (b) Import yolu bir `go.mod` **modül yolu** üzerinden, `Func`'ı tanımlayan tam olarak bir paket içeren analiz edilmiş bir dizine çözümlendiğinde `pkg.Func()`. Yerel değişken gölgelemesi yalnızca AST'den ayırt edilemez; Go yerleşikleri (`len`, `make`) kenar üretmez. | Yöneten bir `go.mod` olmadan: dizin soneki veya paket adı eşleşmesi (asla `verified` değil); analiz edilen kümede benzersiz metot adı (`x.M()`); arayüz metodu adı; içe aktarılmış dış paket üzerindeki selector; dizini analiz edilen kümenin dışında kalan, `go.mod` ile çözümlenmiş import. | Çözümlenen pakette bulunmayan fonksiyon, tek dizinde birden fazla paket, belirsiz `x.M()` (adaylar listelenir), bilinmeyen tanımlayıcı veya selector. |
| **Rust** | **Aynı modülde** tanımlı çıplak `fn` çağrısı. | Nitelikli yollar (`Type::method`, `mod::fn`): son iki segmentte tek eşleşme, modül önekleri ve `use` importları doğrulanmadığı için `unverified-module-prefix-suffix-match` belirsizliğiyle `heuristic` olur; tek adaylı alıcı metot çağrısı (`x.foo()`, trait dispatch yok) ve tek adaylı dosyalar arası çıplak çağrı da `heuristic` olur. | Analiz edilen kaynaklarda aday yok (`std::env::var`, `Vec::new`, …). Birden fazla aday (çıplak, nitelikli yol veya metot çağrısı): `unresolved`; hiçbir adaya kenar çizilmez, tüm adaylar `ambiguity.candidates` içinde listelenir. |

Kaynaklar: `adapters/typescript/src/analyzer.ts`, `native/roslyn-worker/WorkerAnalyzer.cs`, `native/python-worker/worker.py`, `native/go-worker/internal/analyze/analyze.go`, `native/rust-worker/src/analyzer.rs`.

### 3.2 Dil Başına `ROUTES_TO` ve `TESTS` Kuralları

`ROUTES_TO` her yerde aynı biçimde `verified` değildir; her analizör, statik kanıtının desteklediği düzeyi atar:

- **TypeScript / JavaScript (`verified`):**
  - Genel `<receiver>.<verb>("/path", handler)` çağrıları (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`).
  - **Express (`express`):** dosya içi ESM/CJS `express()`, `express.Router()` ve isimli `Router()` bağlamaları `framework: "express"` ekler. Başka bir dosyadan içe aktarılan Express örnekleri yine framework özniteliği olmayan genel rotalar üretir.
  - **Next.js App Router (`nextjs`):** `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` içinde (ayrıca `src/app/` altında) dışa aktarılan HTTP fiil handler'ları ve `page.{ts,tsx,js,jsx}` içindeki isimli default-export bileşenleri. Anonim default export'lar veya tanınmayan dosyalar sembol uydurmaz ve `FRAMEWORK_PATTERN_UNKNOWN` tanıları kaydeder.
- **Python (`verified`):** FastAPI/Starlette `@carrier.get("/path")` dekoratörleri ve Flask `@carrier.route("/path", methods=[…])` dekoratörleri, dekore edilen `def`/`async def` bildirimine sözdizimsel olarak bağlanır (`route-attribute` kanıtı). Literal olmayan yollar veya karmaşık taşıyıcılar açık uyarılar üretir.
- **Rust (`verified`):** Actix-Web, Axum ve Rocket öznitelik makroları (`#[get("/path")]`, `#[route("…", method = …)]`, …) doğrudan `fn` öğesine bağlanır.
- **C# ASP.NET Core (`verified` veya `heuristic`):** controller `[Route]` + `[HttpGet]`/`[HttpPost]`/… öznitelikleri ve Minimal API `MapGet`/`MapPost`/… çağrıları, Roslyn öznitelik veya extension türlerini `Microsoft.AspNetCore.*` olarak çözümlediğinde `verified` olur; `Microsoft.AspNetCore.App.Ref` paketi olmadan bilinen ad kuralıyla `heuristic` (+ `ambiguity`) düzeyine geri düşer.
- **Go (`verified`, `heuristic` veya `unresolved`):** `net/http` `Handle`/`HandleFunc` (metot `"*"`) ve gin/echo/chi fiil kayıtlarında (`native/go-worker/internal/analyze/routes.go`), aynı paketteki isimli bir handler `verified` olur; selector handler yukarıdaki `CALLS` tablosunu izler; bilinmeyen çıplak handler `unresolved` olur; satır içi `func` literal'i `Endpoint` düğümünü korur ama `ROUTES_TO` kenarı üretmez ve bir uyarı kaydeder.
- **Testler (`Test` ve `TESTS`):** TypeScript analizörü BDD test bloklarını `Test` düğümleri olarak çıkarır ve bir test gövdesi test olmayan bir workspace sembolünü çağırdığında `verified` `TESTS` kenarları üretir; bu, `causoryn_preflight_change` içindeki test planı türetmenin `direct` sinyalini besler. C#, Python, Go ve Rust sidecar'ları henüz `TESTS` kenarı çıkarmaz.

---

## 4. Sidecar Protokolü (NDJSON v1) ve Süreç Yalıtımı

Dört sidecar adapter'ın tamamı sıfır bağımlılıklı `@causoryn/sidecar-ipc` çalıştırıcısını (`packages/sidecar-ipc/src/index.ts`) kullanır:

- **İstek başına taze süreç:** her `analyze` koşumu için kısa ömürlü bir worker; ilk tam JSON yanıt satırı ayrıştırılır ayrıştırılmaz sonlandırılır; istekler arasında hiçbir durum taşınmaz.
- **Sabit komut, kabuk yok:** her süreç başlatma `shell: false` ve `windowsHide: true` kullanır. Dosya yolları ve içerikleri asla komut satırına konmaz; yük `stdin` üzerinden tek bir UTF-8 JSON satırı (`type: "analyze"`, `protocolVersion: "1"`) olarak taşınır. Boş veya NUL içeren bir `cwd`, süreç başlatılmadan reddedilir; her adapter, analiz edilen depoyu değil, Causoryn'in kendi worker dizini içindeki güvenilir bir `cwd`'yi geçirir.
- **İzin listeli ortam (`buildAllowlistedWorkerEnv`):** üst süreçteki sırlar, bulut kimlik bilgileri ve API anahtarları miras alınmaz. Her adapter küçük, sabit bir liste iletir: `PATH`, `SystemRoot`, `COMSPEC`, `TEMP`, `TMP`, `USERPROFILE`, `HOME`, artı `DOTNET_ROOT`/`DOTNET_CLI_HOME` (C#) veya `APPDATA`/`LOCALAPPDATA`/`GOPATH`/`GOROOT`/`GOCACHE`/`GOMODCACHE` (Go). Cargo derlemesi ek olarak `CARGO_HOME`/`RUSTUP_HOME` (yalnızca mutlak yerel yollar) ve doğrulanmış bir `CARGO_TARGET_DIR` iletir.
- **Araç zinciri başına sertleştirme:**
  - **C#:** `cwd` = worker DLL dizini olacak şekilde `dotnet exec`; `DOTNET_STARTUP_HOOKS=""`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`, `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`. NuGet keşfi `obj/project.assets.json` dosyasını salt okunur, symlink izlemeden, UNC korumalarıyla ve 8 MB boyut sınırıyla, her assets dosyasının en çok 10.000'ini harcayabildiği 20.000 dosya sistemi yoklaması bütçesi içinde okur (her paket klasörü/dizin çifti bir kez yoklanır; 256'dan fazla yol bileşenli `packageFolders` girdileri hiçbir yoklama yapılmadan bir uyarıyla yok sayılır; assets dosyası başına en çok 8 kullanılabilir `packageFolders` girdisi incelenir, kalanlar için bir uyarı yazılır).
  - **Python:** `cwd` = worker dizini ve `PYTHONIOENCODING=utf-8` ile `python -I -B -X utf8 worker.py` (POSIX'te `python`'dan önce `python3` denenir); `PYTHONPATH` asla iletilmez. Yalıtılmış mod (`-I`), `-E`, `-P` ve `-s` seçeneklerini de içerir ([Python komut satırı dokümantasyonu](https://docs.python.org/3/using/cmdline.html)); bu nedenle `PYTHON*` ortam değişkenleri yok sayılır ve ne betik dizini (`sys._path0`) ne de kullanıcı site-packages'ı `sys.path`'e eklenir; `-B` `.pyc` yazımını engeller.
  - **Go:** `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; `GOENV` iletilmez; `cwd` = `native/go-worker`. Adapter, worker'ın modül yollarını çözümleyebilmesi için `go.mod` dosyalarını `moduleFiles` olarak gönderir.
  - **Rust:** `cargo` kendi dizininden yoklanır; `cargo build --locked`, worker crate'inin derleme önbelleğindeki (`CAUSORYN_RUST_TARGET_DIR`, varsayılan `~/.causoryn/cache/rust-worker-target`) hazırlanmış bir kopyası (`Cargo.toml`, `Cargo.lock`, `build.rs`, `src/**`) üzerinde, `cwd` olarak o kopya ve onun içinde yeni bir `--target-dir` ile çalışır; böylece cargo ve rustup config keşfi asla analiz edilen depoya veya paket dizinine yürümez. Workspace içindeki bir önbellek dizini reddedilir ve açıkça yapılandırılmış bir worker dizini (`CAUSORYN_RUST_WORKER_DIR`) asla yerinde derlenmez. İkisi de `CARGO_BUILD_RUSTC_WRAPPER=""` ve `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=""` ayarlarıyla çalışır. Önbelleğe alınmış bir worker ikilisi başlatılmadan önce, `O_NOFOLLOW` ile normal dosya olarak okunan `<binary>.sha256.json` yan dosyasıyla (`sourceFingerprint` + `binarySha256`) eşleşmelidir. Hazırlanan `Cargo.toml` kendi `[workspace]` tablosunu alır; böylece cargo derleme önbelleğinin üstündeki bir `Cargo.toml`'u asla workspace kökü olarak benimsemez. Windows'ta derleme önbelleği kullanıcı profilinin içine çözümlenmelidir (Node orada ACL inceleyemez); başka yerdeki bir önbellek reddedilir ve Rust bir `Rust analyzer unavailable: …` uyarısıyla L0/L1 düzeyine düşer.
- **Süreç ağacı sonlandırma ve `EPIPE` güvenliği:** worker'ın erken çıkması, işlenmemiş bir `EPIPE` yoluyla MCP sunucusunu çökertemez. Zaman aşımında worker sonlandırılır; Windows'ta `go run` ve `cargo build` torun süreçleri (`worker.exe`, `rustc.exe`) `%SystemRoot%\System32\taskkill.exe /pid <pid> /T /F` (mutlak yol) ile temizlenir. Bir indeks işi worker iş parçacığı başlattığı sidecar süreçlerini paylaşılan bir kayda bildirir. İş yöneticisi kapandığında (kök yeniden bağlama, oturum sonu) worker'dan önce `cancel` istenir (adapter'ları sidecar'larını durdurur) ve worker yanıtında veya 1 sn sonra sonlandırılır; bir worker'dan her vazgeçildiğinde (kapatma, çökme, hata veya biten iş) hâlâ bildirdiği her sidecar PID'i ana iş parçacığından öldürülür; history analiz worker'ıyla aynı yol kullanılır.
- **Mutlak çalıştırılabilirler:** `dotnet`, `python`, `go`, `cargo` ve `git`, `PATH` taranarak mutlak yollara çözümlenir (`packages/sidecar-ipc/src/executable.ts`; `git` için `packages/graph` içinde kendi kendine yeten bir kopyası vardır); boş, göreli, UNC/aygıt ve workspace içindeki `PATH` girdileri atlanır. Böylece sunucunun kendi `cwd`'si depo olsa bile analiz edilen depoya commit edilmiş bir dosya gerçek aracın yerine asla başlatılamaz.
- **İngilizce çıktı:** worker uyarıları, gerekçeleri ve tanıları sade İngilizcedir (örneğin Roslyn worker'ından `reference pack loaded: <pack> <version> (<tfmDir>)`).

### Protokol Kotaları ve Zaman Aşımları

| Kota / parametre | Sınır | Davranış |
|---|---|---|
| Azami istek satırı (`MaxRequestLineBytes` / `MaxRequestLineChars`) | Yaklaşık 64 MB: `64,000,000` (Go karakter, Rust bayt) veya `64 MiB` (C# karakter, Python bayt) | Fazla büyük satır `\n`'e kadar atılır; worker `id: null` + `LIMIT_EXCEEDED` ile yanıt verir ve çalışmaya devam eder. |
| `MaxFileCount` | İstek başına 5,000 dosya | İstek `LIMIT_EXCEEDED` ile reddedilir. |
| `MaxFileContentBytes` | Dosya başına 2,000,000 bayt | Varsayılan `maxFileBytes` ile eşleşir; `LIMIT_EXCEEDED` ile reddedilir. |
| `MaxResponseNodes` (`maxNodes`) | Yanıt başına 250,000 düğüm (`1..250000`) | Fazla düğümler ve bunlara dokunan kenarlar düşürülür (sarkan kenar yok); `RESPONSE_TRUNCATED` + `status: "partial"`. |
| `responseMaxChars` / `stderrMaxChars` | Her biri 64 MiB (`67,108,864` karakter) | Herhangi birinin aşılması worker'ı sonlandırır ve L0/L1 geri düşüşünü tetikler. |
| Ad başına kopyalanan kaynak metni | Go: çağrı metni için 200 bayt, bildirilen adlar, import yolları, paket adları ve dizinler için 512 bayt · Python: işlenmiş ifadeler için 200 karakter, qualified name'ler ve route yolları için 512 · Roslyn: adlar, çağrı metni, taban türleri, route yolları ve adaylar için 1.024 karakter | Daha uzun bir metin bir önek ve SHA-256 işaretine kısaltılır (Go ve Python'da `...#<12 hex>`, Roslyn'de `~<16 hex>`); böylece sınırlanmış metinler ayrık ve deterministik kalır. Sıradan kod etkilenmez. |
| Belirsizlik adayları | Çağrı noktası başına 64 (Go, Roslyn); Go ayrıca en çok 4.096 etiket baytı | Go sıralı ilk adayları listeler ve `candidatesTruncated` ile `candidateCount` ekler; Roslyn kendi aday sırasındaki ilk 64'ü listeler. İkisi de bunu gerekçede belirtir. |
| Yanıt boyutu (Go, Python) | Serileştirilmiş node, kenar, evidence (iki kez sayılır) ve uyarılar için 40.000.000 bayt; 60.000.000 baytı aşan bir yanıt satırı | Bütçe bitince başka hiçbir şey kabul edilmez (File node'ları hariç; kenarlar asla sarkmaz), çağrı çıkarımı durur ve yanıt `RESPONSE_TRUNCATED` + `status: "partial"` alır. Aşırı uzun satır `LIMIT_EXCEEDED` ile yanıtlanır. |
| Yanıt boyutu (Roslyn) | 60.000.000 serileştirilmiş karakter (üretilen her şey ve zarf), en çok 16.000.000'i derleyici tanılamaları için | Sonraki aşamalar durur ve kalan çıktı atılır: `RESPONSE_TRUNCATED` (`response size budget reached …`) + `status: "partial"`. |
| Kesilmiş yanıt ve file facts | Yolu olmayan herhangi bir tanılama | O koşunun her dosyası `file_facts` önbelleğinin dışında kalır (önbellekteki facts silinir); böylece artımlı bir koşu kesilmiş facts'i asla yeniden kullanmaz. |
| Python route `methods` | Dekoratör başına 16 farklı girdi | Yinelenenler kaldırılır; 16'nın ötesindeki girdiler bir uyarıyla atılır. |
| Zaman aşımları | 30 sn (C#, Python, Rust analizi) · 120 sn (Go `go run`) · 600 sn (soğuk Rust `cargo build`) | Süreç ağacı sonlandırılır ve dil L0/L1 düzeyine düşer. |

### Zarif L0/L1 Geri Düşüşü

`dotnet`, `python`, `go` veya `cargo` eksik olduğunda, çöktüğünde ya da zaman aşımına uğradığında sunucu çalışmaya devam eder: etkilenen dosyalar snapshot'ta `sourceHash` kanıtlı `File` düğümleri olarak kalır, snapshot durumu `partial` olur, o dilin `coverage.byLanguage` girdisi daha düşük katmanı gösterir ve `warnings` nedeni kaydeder. `npx causoryn@latest doctor` hangi araç zincirlerinin mevcut olduğunu raporlar.

---

## 5. Çalışma Zamanı Ön Koşulları

| Bileşen | Çalışma zamanı | Derleme modeli | Ağ davranışı |
|---|---|---|---|
| **TypeScript / JavaScript + SQLite çekirdeği** | Node.js >= 24 | Yok (`dist/mcp-server.mjs` + `better-sqlite3` prebuild'leri + paketlenmiş `dist/typescript-lib/lib*.d.ts`) | Kurulumdan sonra yerel |
| **C# / Roslyn** | .NET 10 runtime (`dotnet exec`) | Önceden derlenmiş deterministik Release `Causoryn.RoslynWorker.dll` (`net10.0`, `Microsoft.CodeAnalysis.CSharp` `5.12.0`; `.pdb` veya `.resources.dll` dosyası yok) | Kurulumdan sonra yerel |
| **Python** | Python 3.10+ (CI 3.12 kullanır) | Yok (`worker.py`, yalnızca stdlib `ast`, pip paketi yok, `__pycache__` yazımı yok) | Kurulumdan sonra yerel |
| **Go** | `native/go-worker/go.mod` gereksinimini (`go 1.26`) karşılayan Go araç zinciri (`GOTOOLCHAIN=local` ile daha yeni araç zinciri indirilmez) | `go run ./cmd/worker` (`GOCACHE` içinde önbelleğe alınır) veya önceden derlenmiş bir `CAUSORYN_GO_WORKER_BIN`; yalnızca stdlib, dış modül yok | Kurulumdan sonra yerel |
| **Rust** | Rust / Cargo (`edition = 2021`) | İhtiyaç anında `~/.causoryn/cache/rust-worker-target` (veya `CAUSORYN_RUST_TARGET_DIR`) içine `cargo build --locked` | İlk derleme, önbellekte olmayan `Cargo.lock` crate'lerini (`syn` 3, `serde_json`, `proc-macro2`) crates.io'dan indirebilir; sonrasında sabitlenmiş ikili yerel olarak çalışır |

---

## 6. `fp3` `analyzerFingerprint` ve İç Analizör Sürümleri

### 6.1 Parmak İzi Şeması

`packages/indexing/src/fingerprint.ts`, kalıcı snapshot'ların ve `file_facts` kayıtlarının araç zinciri veya referans paketi değişiklikleri arasında yeniden kullanılmaması için konumsal `fp3` parmak izini hesaplar:

```text
fp3|ts-adapter@0.1.0|roslyn-worker@0.1.0|refpack=<pack>@<version>@<tfm>;...|refsrc=<source>|opts=<sha256-16>
   [|python-worker@0.1.0|pystate=<status>|pyopts=<sha256-16>]
   [|go-worker@0.1.0|gostate=<status>|goopts=<sha256-16>]
   [|rust-worker@0.1.0|ruststate=<status>|rustopts=<sha256-16>]
```

- **Koşullu bloklar:** workspace'te o dilde dosya yoksa Python, Go ve Rust blokları yazılmaz; böylece TS/C# parmak izleri değişmeden kalır.
- **Referans paketleri ve koşum durumu:** C#, yüklenen .NET / ASP.NET Core referans paketlerini (paket, sürüm ve yalnızca `net8.0` gibi hedef framework dizin adıyla `refpack=…` — kullanıcı adını içerebilen ve doküman export'larına ulaşacak olan mutlak referans paketi dizini asla yazılmaz —, `fallback-corelib` veya `unavailable`) ve keşif kaynağını (`refsrc=`, örneğin `worker-unavailable`, `discovery-unknown`, `sync-run-degraded`) kaydeder; Python, Go ve Rust worker durumlarını (`ready`, `worker-unavailable`, `sync-run-degraded`) ve etkin adapter seçeneklerinin SHA-256 özetinin ilk 16 hex karakterini kaydeder.
- **Geçersizleştirme:** snapshot kimliği `[workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]` dizisini hash'ler; bu nedenle eksik bir araç zincirini kurmak (`worker-unavailable` → `ready`) veya .NET referans paketlerini değiştirmek yeni bir parmak izi ve taze bir derleme üretir.
- **`fp3` (0.3.0) şema yükseltmesi:** 0.3.0'da gerçek TypeScript bildirim span'leri, ESM/CJS modül biçimi algılama ve İngilizce kanıt metinleri analizör çıktısını değiştirdiği için şema öneki `fp2`'den `fp3`'e yükseltildi; önceki derlemelerden kalan kalıcı snapshot'lar ve `file_facts` kayıtları yeniden kullanılmaz, ilk indeksleme tam (full) derleme olarak yapılır.

### 6.2 İç Analizör Sürümleri Neden `0.1.0` Olarak Kalır?

Paket ve MCP sunucusu sürümleri sürümlemeyi izler (0.3.0), ancak `ts-adapter`, `roslyn-worker`, `python-worker`, `go-worker` ve `rust-worker` (ve `native/rust-worker/Cargo.toml`) `0.1.0`'da kalır:

1. `analyzerVersion` her kanıt kaydının (dolayısıyla kanıt kimliklerinin) ve `fp3` parmak izinin bir parçasıdır.
2. Çıkarım semantiği ve NDJSON `protocolVersion: "1"` değişmemişken yalnızca paketlemeye ilişkin sürümlerde bunu artırmak, kalıcı her grafı geçersiz kılar ve kanıt hash'lerini gereksiz yere değiştirir.
3. Bu nedenle iç analizör sürümleri, paket sürümünden bağımsız olarak çıkarım semantiğini izler.

---

## İlgili Belgeler

- [Dokümantasyon Merkezi](README.md) · [Mimari Genel Bakış](architecture.md)
- [CLI ve Yapılandırma Başvurusu](cli-and-configuration.md) · [MCP Araç Sözleşmeleri](tool-contracts.md)
- [No-LLM karar kaydı](adr/ADR-002-no-llm.md) · [Güvenlik Denetimi](security-pass.md) · [Performans Benchmark'ları](benchmarks.md)
