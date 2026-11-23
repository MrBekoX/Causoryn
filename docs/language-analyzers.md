# 5-Dil Analizörleri, Dürüst Çözümleme Disiplini ve Sidecar Protokolü

> **Dil / Language:** **Türkçe** | [English](en/language-analyzers.md)
>
> **Kanıt:** `packages/indexing/src/{index.ts,index-service.ts,inventory.ts,fingerprint.ts}`, `packages/workspace/src/ignore-matcher.ts`, `packages/mcp-server/src/workspace-ignore-discovery.ts`, `packages/sidecar-ipc/src/index.ts`, `adapters/typescript/src/{analyzer.ts,tsconfig-loader.ts}`, `adapters/{csharp-roslyn,python,go,rust}/src/*`, `native/{roslyn-worker,python-worker,go-worker,rust-worker}/PROTOCOL.md` (TŞ v2.1 §6, §7, §8, §9, §15, §23 · `ADR-004` · `ADR-010` · `K-018`..`K-024`).

Causoryn, **TypeScript / JavaScript**, **C# (.NET / Roslyn)**, **Python**, **Go** ve **Rust** analizlerini tek bir birleşik kanıt grafiğinde (`Unified Evidence & Knowledge Graph`) toplar. Analizörler model çağrısı yapmadan sözdizimi, semboller ve desteklenen framework kurallarından sonuç üretir (`ADR-002`). `verified` kenarlar kaynak kanıtı gerektirir, diğer eşleşmeler çözümleme durumunu açıkça taşır (`ADR-004`, `ADR-010`, `K-018`).

Polyglot indeksleme, birden fazla analizörün ürettiği aynı kimlikli ve dosyaya bağlı olmayan dış/sanal düğümleri kanonik bir kayıtta birleştirir. Dosyaya bağlı çakışmalar hata olarak raporlanır (`packages/indexing/src/index-service.ts`). Eşdeğer analiz için dosya girdileri ve etkin yapılandırmanın yanında analizör/araç zinciri koşulları da eşdeğer olmalıdır. Eksik çalışma zamanı, değişen referans paketleri veya zaman aşımı farklı kapsam ve tanılara yol açabilir.

---

## 1. 5-Dil Yetenek Matrisi (`INDEXED_ADAPTERS`)

`causoryn_get_capabilities` aracının sunduğu `INDEXED_ADAPTERS` (`packages/indexing/src/index.ts`) kayıtları ve çıkarım katmanları:

| Dil | `analyzerId` (`version`) | Çalışma Modu | `astParse` (`L1`) | `symbolResolution` (`L2`) | `frameworkLinkers` / Route & Test (`L3`) | Üretilen Kenar Türleri |
|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | `ts-adapter` (`0.1.0`) | Süreç-içi (`adapters/typescript`, TS Compiler API `5.9.3`; `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, `allowJs: true`, `checkJs: false`, `jsx: Preserve`, kök-hapsedilmiş `tsconfig.json`/`jsconfig.json`) | `L1` | `L2` (`TypeChecker` tam semantik çözümleme; ESM + CommonJS `require`/`exports`/`module.exports`) | `express+nextjs` (TS/JS/CJS) + genel `<x>.<verb>` kalıbı + BDD `Test` düğümü ve `TESTS` kenarı | `CONTAINS`, `IMPORTS`, `CALLS`, `ROUTES_TO`, `TESTS` |
| **C# / .NET** | `roslyn-worker` (`0.1.0`) | Sidecar (`adapters/csharp-roslyn` ↔ `native/roslyn-worker`) | `L1` | `L2` (Roslyn `SemanticModel` — tek tam semantik sidecar) | `aspnet-core-route-attributes (L3)` (Controller `[Route]`/`[Http*]` + Minimal API `MapGet`/…) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Python** | `python-worker` (`0.1.0`) | Sidecar (`adapters/python` ↔ `native/python-worker/worker.py`) | `L1` | `L2` (AST ad kapsamı; tam type inference yok) | `decorator-route-pattern (L3)` (FastAPI/Starlette `@app.get`/… + Flask `@app.route`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Go** | `go-worker` (`0.1.0`) | Sidecar (`adapters/go` ↔ `native/go-worker/cmd/worker`) | `L1` | `heuristic-only (semantik L2 yok)` (`symbolResolution: false`) | `http-router-registration (L3)` (`net/http` `Handle`/`HandleFunc` + `gin`/`echo`/`chi`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Rust** | `rust-worker` (`0.1.0`) | Sidecar (`adapters/rust` ↔ `native/rust-worker`) | `L1` | `heuristic-heavy` (`syn 3.0.10` AST + deterministik isim tablosu) | `attribute-macro-route (L3)` (Actix-Web / Axum / Rocket HTTP fiil makroları) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |

### Katman Tanımları (`L0` – `L3`) ve `coverage.tier` Hesabı

- **`L0` (Envanter / Dosya Kanıtı):** `WorkspaceAccessPolicy` tarafından doğrulanan her kaynak dosya için `sourceHash` (UTF-8 SHA-256) kanıtlı `File` düğümü ve `Workspace → File` `CONTAINS` kenarı.
- **`L1` (AST ve Bildirim Çıkarımı):** Sınıf (`Class`), arayüz/trait (`Interface`), tip (`Type`), fonksiyon (`Function`) ve metot (`Method`) bildirimleri ile hiyerarşik `CONTAINS` kenarları.
- **`L2` (Sembol ve Çağrı Çözümlemesi):** Çağrı (`CALLS`) ve modül içe aktarma (`IMPORTS`) ifadelerinin hedef sembollere veya açık `UnknownExternal` düğümlerine bağlanması.
- **`L3` (Framework Rotaları ve Test Bağları):** HTTP `Endpoint` düğümleri, `Endpoint → Handler` (`ROUTES_TO`) kenarları ve TypeScript BDD `Test → Hedef` (`TESTS`) kenarları.
- **Zarf `coverage.tier` hesabı (`coverageOf`):** Yayımlanan snapshot içinde TS/JS/C#/Python AST/sembol düğümü varsa `L2`, yalnızca Go/Rust AST/sembol düğümü varsa `L1`, yalnızca `File` envanter düğümleri varsa `L0` raporlanır.
- **Senkron açılış vs asenkron yenileme nüansı:** Sunucu açılışındaki senkron `runIndex` köprüsü alt süreç başlatmaz; TypeScript ve JavaScript tam analiz edilirken sidecar dilleri başlangıçta `L0` `File` düğümleri (`sync-run-degraded` + açık uyarı) olarak yayımlanır. `causoryn_refresh_index` (`runIndexAsync` / `runIncrementalIndexAsync`) çalıştığında 5 dilin tamamı tek birleşik snapshot içinde tam derinlikte birleştirilir.

---

## 2. TypeScript / JavaScript Evrensel Analizi, `tsconfig.json` / `jsconfig.json` ve Non-Blocking Envanter

### 2.1 TypeScript, JavaScript ve CommonJS (`ts-adapter`)

`adapters/typescript` aynı süreç-içi TypeScript Compiler API (`5.9.3`) motoruyla tüm modern ve klasik JS/TS projelerini eksiksiz analiz eder:

- **Tam uzantı kapsamı ve dil ayrımı:** `.ts`, `.tsx`, `.mts`, `.cts` dosyaları `language: "typescript"`, `.js`, `.jsx`, `.mjs`, `.cjs` dosyaları ise `language: "javascript"` olarak etiketlenir. Derleyici programı `allowJs: true`, `checkJs: false` ve `jsx: Preserve` ayarlarıyla açılır; böylece tiplenmemiş JavaScript dosyalarında sahte tip-denetimi gürültüsü üretilmeden AST, sembol ve çağrı grafiği çıkarılır.
- **ESM + CommonJS çözümlemesi:** Standart `import`/`export` ifadelerinin yanı sıra literal `require("./module")` çağrıları `IMPORTS` kenarına, üst düzey `exports.<fn> = ...`, `module.exports.<fn> = ...` ve `module.exports = function <name>(...)` atamaları ise dışa aktarılan fonksiyon/sembol düğümlerine dönüştürülür.
- **JS/CJS Express ve Next.js App Router linker'ları:** Express linker'ı hem ESM `import express from "express"` hem de CommonJS `const express = require("express")` / `express.Router()` / `Router()` akışlarını izleyerek `Endpoint → Handler` (`ROUTES_TO`) kenarları üretir; Next.js App Router linker'ı `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` ve `page.{ts,tsx,js,jsx}` dosyalarını destekler.

### 2.2 Kök-Hapsedilmiş `tsconfig.json` / `jsconfig.json` Yükleyicisi (`tsconfig-loader.ts`)

`adapters/typescript/src/tsconfig-loader.ts`, gerçek dünya monorepo ve frontend/backend projelerindeki yol alias'larını ve derleyici ayarlarını güvenlik sınırları içinde (`ADR-008`, `CWE-22`, `CWE-59`) çözümler:

- **Desteklenen ayarlar ve JSONC:** Yalnızca güvenli `compilerOptions` alanları (`baseUrl`, `paths` — ör. `@/*`, `~/*`, en fazla 200 girdi — `moduleResolution`, `module`, `target`, `jsx`, `experimentalDecorators`, `verbatimModuleSyntax`) resmi `ts.parseConfigFileTextToJson` ile (JSONC yorumları ve trailing comma destekli; `eval`/plugin yürütme olmadan) okunur. `baseUrl` veya `paths` mevcutsa açık `moduleResolution` yokken `Bundler`, aksi hâlde `NodeNext` seçilir. `__proto__`, `constructor` ve `prototype` anahtarları reddedilir.
- **Kök-hapsedilmiş `extends` ve monorepo alt yapılandırmaları:** En fazla 64 dizin kapsamlı (`ScopedTsConfig`) iç-içe `tsconfig.json`/`jsconfig.json` dosyası desteklenir. `extends` zinciri kesinlikle çalışma alanı kökünde hapsedilir (derinlik ≤ 5, dosya başına ≤ 16 `extends`, global 128 ziyaret bütçesi, döngü tespiti).
- **Hapsedilmiş derleyici konağı (`configureConfinedCompilerHost`):** TypeScript'in `ts.sys` üzerinden yetkisiz disk dosyalarına kaçışı kapatılır. Disk erişimine yalnızca (a) `WorkspaceAccessPolicy` onaylı bellek-içi dosya girdileri (`entries`), (b) paketli `lib*.d.ts` dizini (`CAUSORYN_TS_LIB_DIR`) ve (c) kök içindeki `node_modules` altındaki `.d.ts`/`.d.mts`/`.d.cts`/`package.json` dosyaları için izin verilir.
- **TOCTOU-güvenli disk okuması ve artımlı önbellek geçersizleştirme:** Disk fallback yolu `lstatSync` + `realpathSync` + `openSync(O_RDONLY | O_NOFOLLOW)` + `fstatSync` (`dev`, `ino` ve boyut ≤ 256 KB doğrulaması) kullanır. `packages/indexing/src/index-service.ts` içindeki `isIndexRelevantFile`, `tsconfig.json` veya `jsconfig.json` dosyalarındaki her değişiklik ya da silinmede artımlı indeks önbelleğini otomatik geçersiz kılarak yeniden analiz tetikler.

### 2.3 Non-Blocking `collectInventoryAsync` ve Akıllı Dışlama Motoru

- **Event-loop dostu tarama (`collectInventoryAsync`):** `packages/indexing/src/inventory.ts` içindeki `collectInventoryAsync`, senkron `collectInventory` ile bayt düzeyinde aynı sıralı `InventoryEntry[]` çıktısını üretirken her 64 girdide (`yieldEvery = 64`) `setImmediate` ile Node.js event loop'una nefes verir; böylece büyük repolarda arka plan indekslemesi MCP isteklerini bloklamaz.
- **Akıllı `.gitignore` + `.git/info/exclude` + iç-içe `.gitignore` ve `bin/` ayrımı:** `packages/mcp-server/src/workspace-ignore-discovery.ts` kök `.gitignore`, non-symlink `.git/info/exclude` ve bütçe-sınırlı iç-içe `.gitignore` desenlerini birleştirir; açık `ignore` verilmediğinde kaba `**/bin/**` yerine yalnızca `.NET` çıktı dizinlerini (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` ve `.csproj`/`.fsproj`/`.vbproj` altındaki `<proje>/bin/**`) dışlayarak `bin/*.ts|js` ve Rust `src/bin/*.rs` kaynaklarını korur.
- **Polinom zamanlı sıfır-RegExp eşleyici (`ignore-matcher.ts`):** `packages/workspace/src/ignore-matcher.ts` geri izleme (backtracking) patlamasına yapısal olarak bağışık iki-işaretçili glob algoritması kullanır (sıfır `RegExp`, sıfır ReDoS).

---

## 3. Dürüst Kenar Çözümleme Disiplini (`K-018`, `ADR-004`, `ADR-010`)

Causoryn'de hiçbir analizör belirsiz bir çağrıyı "en olası" iç sembole sessizce `verified` olarak bağlamaz ve kendi düğüm/kenar ID'sini üretmez (tüm kanonik SHA-256 kimlikler merkezi `packages/domain` normalizer katmanında hesaplanır).

1. **`verified`:** Statik derleyici veya sözdizimsel bağlam hedefi kesin olarak kanıtlar. Her `verified` kenar en az 1 `Evidence` (`relativePath`, 1-tabanlı `startLine`/`endLine`, `sourceHash`, `analyzerId`, `analyzerVersion`, `rationale`) taşımak zorundadır; aksi durum domain, Zod şeması ve SQLite depo katmanlarında reddedilir.
2. **`heuristic` (+ `ambiguity`):** Ad tablosu, import eşleşmesi veya benzersiz metot adı gibi kurallara dayanır; kenar üzerinde `ambiguity: { candidates: [...], reason: "..." }` alanı ile neden kesin olmadığı açıkça taşınır.
3. **`unresolved` (`UnknownExternal`):** Çözümlenemeyen çağrılar, dinamik ifadeler veya analiz kümesi dışındaki tanımsız hedefler açık bir `UnknownExternal` düğümüne bağlanır. Grafikte asla kopuk kenar (`dangling edge`) oluşmaz.

### 3.1 Dil Başına `CALLS` Çözümleme Kuralları

| Dil | `verified` Koşulu | `heuristic` (+ `ambiguity`) Koşulu | `unresolved` (`UnknownExternal`) Koşulu |
|---|---|---|---|
| **TypeScript / JavaScript** | `TypeChecker` imzayı analiz kümesindeki sembole (veya `lib*.d.ts` / `node_modules` bildirimli `UnknownExternal` düğümüne) çözdüğünde (ESM + CJS `require`/`exports` dahil). *(Not: `IMPORTS` için relative aday ve Node yerleşik modülleri `heuristic` etiketlenir.)* | `IMPORTS` relative dosya adayı / `node:*` yerleşik modül eşleşmesi. | `TypeChecker` sembol bulamadığında (`any`/dinamik ifade → `UnknownExternal`). |
| **C# (Roslyn)** | Roslyn `SemanticModel` hedef metodu/kurucuyu (küme içi veya BCL/NuGet `UnknownExternal`) çözdüğünde. | Semantik referans eksikliğinde bilinen-ad kuralı devreye girdiğinde. | Aşırı yükleme belirsizliği, hata tipi veya dinamik çağrılar. |
| **Python** | Hedef **aynı modülde** tanımlı fonksiyon/sınıf, `self.<metot>` veya `AynıModülSınıfı.<metot>` olduğunda. | Hedef `import` / `from ... import` ile getirilen sembol olduğunda (Python dinamik ad bağlamı; tam type inference yoktur). | Yerel değişken üzerinden metot çağrısı, yerleşik fonksiyonlar (`len`, `list`) ve tanımsız adlar. |
| **Go** | Yalnızca **aynı package** kapsamındaki üst-düzey fonksiyonlara yapılan çıplak (`bare ident`) çağrılar *(yerel değişken gölgelemesi AST'ten ayırt edilemez — belgeli sınır)*. *(Yerleşik `len`/`make` için kenar üretilmez.)* | Küme içi `pkg.Func` çağrısı, set dışı import selector'ı, analiz kümesinde tekil metot adı (`x.M()`) veya arayüz metodu. | Birden fazla metoda uyan belirsiz `x.M()` (aday listesiyle) veya tanımsız ad/selector. |
| **Rust** | (a) Aynı dosyada tanımlı serbest `fn` çağrısı; (b) analiz kümesi isim tablosunda **tek** eşleşmesi olan nitelikli yol (`A::b`, `mod::A::b` — önek modül zinciri tam semantik doğrulanmaz, belgeli). | Alıcı metot çağrısı (`x.foo()` — trait dispatch çözülmez), farklı dosyadaki tekil çıplak `fn` adayı veya çok adaylı nitelikli yol. | Hiçbir aday bulunamayan çağrılar (`std::env::var`, `Vec::new` vb.). |

### 3.2 Dil Başına `ROUTES_TO` ve `TESTS` Kuralları

`ROUTES_TO` kenarları beş dilin tamamında otomatik olarak `verified` **değildir**; her dil kendi kanıt gücüne göre etiket üretir:

- **TypeScript / JavaScript (`verified`):**
  - Genel `<taşıyıcı>.<verb>("/path", handler)` çağrıları (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`).
  - **Express linker (`express`):** Dosyadaki ESM/CJS `express()`, `express.Router()` ve isimli `Router()` örneklerini izler (`framework: "express"`). *(Dosyalar arası aktarılan receiver örneklerinde genel rota korunur, yalnızca framework etiketi eklenmez.)*
  - **Next.js App Router linker (`nextjs`):** `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` ve `src/app/**/route.{ts,tsx,js,jsx,mjs,cjs}` içindeki export edilen HTTP fiil fonksiyon/sabitlerini ve `page.{ts,tsx,js,jsx}` içindeki isimli `default export` bileşenlerini `TypeChecker` ile çözer. Tanınmayan veya anonim default export'larda sembol uydurulmaz; `FRAMEWORK_PATTERN_UNKNOWN` tanısı düşülür.
- **Python (`verified`):** `@carrier.get("/path")` vb. FastAPI/Starlette dekoratörleri ile `@carrier.route("/path", methods=[...])` Flask dekoratörleri doğrudan altlarındaki `def`/`async def` bildirimine sözdizimsel bağlı olduğundan daima `verified` (`route-attribute`) üretir. Literal olmayan rota yolları veya karmaşık taşıyıcı ifadeleri sessizce atlanmaz, `warnings` listesine yazılır.
- **Rust (`verified`):** Actix-Web, Axum ve Rocket öznitelik makroları (`#[get("/path")]`, `#[post("/path")]` vb.) doğrudan hedef `fn` öğesine bağlı olduğundan daima `verified` (`route-attribute`) üretir.
- **C# ASP.NET Core (`verified` veya `heuristic`):** Controller `[Route]` + `[HttpGet]`/`[HttpPost]`/… öznitelikleri ve Minimal API `MapGet`/`MapPost`/… çağrıları (`WorkerAnalyzer.cs:1475-1508`), Roslyn `Microsoft.AspNetCore.*` tiplerini semantik olarak çözebildiğinde `verified` üretir. Ortamda `Microsoft.AspNetCore.App.Ref` paketi bulunamazsa bilinen-ad kuralıyla dürüstçe **`heuristic` (+ `ambiguity`)** düzeyine düşer.
- **Go (`verified`, `heuristic` veya `unresolved`):** `net/http` (`Handle`, `HandleFunc` → metot `"*"`) ve `gin`/`echo`/`chi` HTTP fiil kayıtlarında (`routes.go:120-170`) aynı package'taki isimli handler `verified`, selector handler ifadesi **`heuristic` veya `unresolved`**, tanımsız çıplak handler **`unresolved` (`UnknownExternal`)** üretir; satır-içi anonim `func(...)` literal handler'larda `Endpoint` düğümü korunur, kenar üretilmez ve açık uyarı düşülür.
- **BDD Test Çıkarımı (`Test` ve `TESTS`):** TypeScript analizörü BDD test bloklarını `Test` düğümü olarak çıkarır ve bir `Test` gövdesinden test-olmayan sembollere yapılan çözümlenmiş çağrılar için `verified` `TESTS` kenarı üretir (`causoryn_derive_test_plan` `direct` sinyali). C#, Python, Go ve Rust sidecar'larında `TESTS` kenarı üretimi `v0.2.3` itibarıyla açık kalem olarak izlenmektedir.

---

## 4. `@causoryn/sidecar-ipc` NDJSON Protokolü (v1) ve Süreç Güvenliği

Dört sidecar adapter (`csharp-roslyn`, `python`, `go`, `rust`) süreç yaşam döngüsünü sıfır dış npm bağımlılıklı `@causoryn/sidecar-ipc` paketi üzerinden paylaşır:

- **İstek başına taze süreç:** Uzun ömürlü arka plan daemon'u tutulmaz; her analiz koşumu temiz bellek durumuyla başlar ve ilk tam JSON yanıt satırında sonlandırılır.
- **Kabuksuz sabit komut disiplini (`shell: false`):** Kaynak dosya yolları veya içerikleri **asla** komut satırı argümanlarına yazılmaz; tüm girdi `stdin` üzerinden tek satır UTF-8 JSON (`type: "analyze"`, `protocolVersion: "1"`) olarak gönderilir.
- **Allowlist tabanlı minimal ortam (`buildAllowlistedWorkerEnv`):** Üst süreçteki API anahtarları, bulut kimlik bilgileri veya token'lar alt sürece miras bırakılmaz; yalnızca ilgili araç zincirinin çalışması için zorunlu olan ortam değişkenleri (`PATH`, `HOME`/`USERPROFILE`, `TEMP`/`TMP`, `DOTNET_ROOT`, `GOPATH`/`GOCACHE`, `CARGO_HOME`/`RUSTUP_HOME` vb.) geçirilir. Python adapter'ı `PYTHONPATH` değişkenini determinizm için bilerek dışlar ve `PYTHONIOENCODING=utf-8` değerini sabitler.
- **Ağaç sonlandırma ve `EPIPE` koruması:** Erken kapanan alt süreçlerde `stdin` `EPIPE` hataları yutulur. Zaman aşımında süreç sonlandırılır; Windows üzerinde `go run` ve `cargo build` alt süreçlerinin ürettiği torun süreçler (`worker.exe`, `rustc.exe`) arka planda yetim kalmaması için sabit `taskkill /pid <pid> /T /F` kancasıyla temizlenir.

### Protokol Kaynak Bütçeleri ve Zaman Aşımları (`PROTOCOL.md` v1)

| Sınır / Parametre | Değer | Aşım Davranışı |
|---|---|---|
| `MaxRequestLine` (`MaxRequestLineBytes` / `MaxRequestLineChars`) | **64 MB** (`64.000.000` / `64 MiB`) | Aşan satır `\n` karakterine kadar atılır; worker `id: null` + `LIMIT_EXCEEDED` döner ve döngü ayakta kalır. |
| `MaxFileCount` | **5.000** dosya / istek | İstek `LIMIT_EXCEEDED` hatasıyla reddedilir. |
| `MaxFileContentBytes` | **2.000.000** bayt (2 MB) / dosya | `CAUSORYN_CONFIG.maxFileBytes` varsayılanıyla uyumlu; aşım `LIMIT_EXCEEDED` döner. |
| `MaxResponseNodes` (`maxNodes`) | **250.000** düğüm / yanıt (`1..250000`) | Tavan aşıldığında fazla düğümler ve uçları dışarıda kalan kenarlar düşürülür (kopuk kenar oluşmaz); `RESPONSE_TRUNCATED` tanısı ve `status: "partial"` döner. |
| `responseMaxChars` & `stderrMaxChars` (`sidecar-ipc`) | **64 MiB** (`67.108.864` karakter) | Yanıt satırı veya `stderr` birikimi bütçeyi aşarsa süreç sonlandırılır ve adapter `L0`/`L1` fallback moduna geçer. |
| Zaman Aşımları (`requestTimeoutMs`) | **30 sn** (C#, Python, Rust analiz) · **120 sn** (Go `go run`) · **600 sn** (Rust soğuk `cargo build`) | Süre aşımında alt süreç ağacı sonlandırılır ve ilgili dil `L0`/`L1` fallback ile raporlanır. |

### Zarif `L0`/`L1` Düşüşü (Graceful Fallback)

Makinede `.NET`, `Python`, `Go` veya `Cargo` kurulu değilse ya da worker zaman aşımına uğrarsa sunucu **asla çökmez**:
- İlgili dilin dosyaları envanter karması (`sourceHash`) doğrulanmış `File` düğümleri olarak snapshot'ta korunur (`WORKER_UNAVAILABLE_CAPABILITIES`).
- Snapshot durumu `partial`, adapter `coverageRatio` değeri `0` olur ve `warnings` dizisine neden kullanılamadığı açıkça yazılır (`npx causoryn@latest doctor` ile önceden denetlenebilir).

---

## 5. Çalışma Zamanı, Derleme ve Çevrimdışı (Offline) Matrisi

| Bileşen / Analizör | Çalışma Zamanı Gereksinimi | Derleme Modeli | Ağ / Çevrimdışı Davranışı |
|---|---|---|---|
| **TypeScript / JavaScript + Çekirdek SQLite** | **Node.js >= 24** | Sıfır-derleme (`dist/mcp-server.mjs` + N-API v10 `better-sqlite3` prebuild'leri + `dist/typescript-lib/lib*.d.ts`) | Kurulum sonrası yerel çalışma |
| **C# / Roslyn** (`roslyn-worker`) | **.NET 10 runtime** (`dotnet exec`) | Paket içinde önceden derlenmiş deterministik Release `Causoryn.RoslynWorker.dll` (`Microsoft.CodeAnalysis.CSharp` `5.12.0`, sıfır `.pdb`/`.resources.dll`) | Kurulum sonrası yerel çalışma |
| **Python** (`python-worker`) | **Python 3.10+** (önerilen / CI: **Python 3.11+ / 3.12**) | Sıfır-derleme (`python -B worker.py`, saf stdlib `ast`, sıfır pip paketi, `__pycache__` üretmez) | Kurulum sonrası yerel çalışma |
| **Go** (`go-worker`) | **Go 1.22+** | İstek anında yerel `go run ./cmd/worker` (`GOCACHE` önbellekli) veya önceden derlenmiş `CAUSORYN_GO_WORKER_BIN` (saf stdlib `go/parser`, `go.mod` dış modül içermez) | Kurulum sonrası yerel çalışma |
| **Rust** (`rust-worker`) | **Rust / Cargo** (`edition = 2021`) | İstek anında `cargo build --locked` → `~/.causoryn/cache/rust-worker-target` (veya `CAUSORYN_RUST_TARGET_DIR`) | İlk derleme, önbellekte bulunmayan `Cargo.lock` bağımlılıklarını (`syn 3`, `serde_json`, `proc-macro2` vb.) indirmek için ağ gerektirebilir. Hazır worker binary'si yerelde çalışır. |

---

## 6. `fp2` `analyzerFingerprint` Önbellek Geçersiz Kılma ve İç `0.1.0` Sürüm Kararı

### 6.1 Deterministik `fp2` Parmak İzi Şeması

Kalıcı SQLite önbelleğinin farklı çalışma zamanı veya referans paketi ortamlarında bayat sonuç döndürmesini önlemek için `packages/indexing/src/fingerprint.ts` konumsal `fp2` parmak izini üretir:

```text
fp2|ts-adapter@0.1.0|roslyn-worker@0.1.0|refpack=<pack>@<sürüm>@<tfmDir>;...|refsrc=<kaynak>|opts=<sha256-16>
   [|python-worker@0.1.0|pystate=<durum>|pyopts=<sha256-16>]
   [|go-worker@0.1.0|gostate=<durum>|goopts=<sha256-16>]
   [|rust-worker@0.1.0|ruststate=<durum>|rustopts=<sha256-16>]
```

- **Koşullu dil segmentleri:** Çalışma alanında `.py`, `.go` veya `.rs` dosyası yoksa ilgili dil bloğu parmak izine yazılmaz; yalnızca TS/C# içeren projelerin parmak izi bit-bit korunur.
- **Gerçek referans ve durum takibi:** C# için yüklenen gerçek `.NET` / `ASP.NET Core` referans paketleri (`refpack=...` veya `fallback-corelib` / `unavailable`) ve keşif kaynağı (`env-dotnet-root`, `worker-discovered`, `worker-unavailable`, `sync-run-degraded`), diğer sidecar'lar için ise `WorkerRunStatus` (`ready`, `worker-unavailable`, `sync-run-degraded`) ve etkin ayarların kanonik JSON SHA-256 özeti (`opts`, ilk 16 hex) parmak izine girer.
- **Otomatik önbellek yenileme:** `snapshotId = SHA-256(canonicalJson([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))` formülü sayesinde kullanıcı sonradan `.NET`, `Python`, `Go` veya `Rust` araç zincirini kurduğunda `worker-unavailable` → `ready` geçişi `analyzerFingerprint` değerini değiştirir ve eski kısmi (`partial`) snapshot yerine tam semantik snapshot üretilmesini tetikler.

### 6.2 Neden İç Analizör Sürümleri `0.1.0` Olarak Kalır?

Dağıtım paketi (`causoryn`), MCP sunucusu (`SERVER_VERSION`) ve indeksleme orkestratörü (`INDEXING_VERSION`) `0.2.3` sürümündeyken; beş dil analizörünün iç protokol sürümleri (`ts-adapter@0.1.0`, `roslyn-worker@0.1.0`, `python-worker@0.1.0`, `go-worker@0.1.0`, `rust-worker@0.1.0` ile `Causoryn.RoslynWorker.csproj` ve `native/rust-worker/Cargo.toml`) bilinçli olarak **`0.1.0`** seviyesinde kilitli tutulur:

1. `analyzerVersion` alanı hem her `Evidence` kaydının SHA-256 kimliğine (`evidenceId`) hem de `fp2` `analyzerFingerprint` dizgesine doğrudan girer.
2. Analizörlerin AST/semantik çıkarım kurallarında veya NDJSON `protocolVersion: "1"` şemasında kırıcı bir değişiklik olmadıkça bu sabitin paket sürümüyle birlikte artırılması, diskteki tüm geçerli SQLite snapshot önbelleklerini gereksiz yere geçersiz kılar ve kanıt kimliklerini değiştirir.
3. Bu nedenle iç analizör sürümü **çıkarım motoru semantiğini**, `0.2.3` ise **MCP/CLI dağıtım paketini** temsil eder.

---

## İlgili Belgeler

- [Dokümantasyon Merkezi](README.md) · [Mimari Özeti](architecture.md)
- [CLI ve Konfigürasyon Başvurusu](cli-and-configuration.md) · [MCP Araç Sözleşmeleri](tool-contracts.md)
- [ADR-002: No-LLM Sınırı](adr/ADR-002-no-llm.md) · [Güvenlik Denetimi](security-pass.md) · [Performans Ölçümleri](benchmarks.md)
