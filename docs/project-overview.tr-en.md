# Causoryn — Proje Dokümanı / Project Document (TR · EN)

---

# Causoryn — Kapsamlı Proje Dokümanı (v0.1.0 snapshot)

> Kanıt temeli: main branch, v0.1.0 snapshot (HEAD `5d6357c`; tag `v0.1.0` → `4c9c188`). Belge, beş analist turunun disk okumalarını ve canlı koşum kayıtlarını sentezler; ADR-010 disipliniyle yazılmıştır: kanıtsız iddia "öneri"dir, çalışmayan şey "Done" yazılmaz. Yazar, yük taşıyan sayıları (29 araç, v0.1.0, LLM bağımlılığı yokluğu) bu oturumda diskte yeniden doğrulamıştır; diğer koşum kanıtları analist turundandır.

## 1. Yönetici Özeti

Causoryn; repository kodunu, her iddianın dosya+satır+sourceHash taşımak zorunda olduğu **Unified Evidence & Knowledge Graph**'a dönüştüren, **model bağımsız ve LLM çalıştırmayan** yerel MCP motorudur; yorumu host-selected model yapar, Causoryn yalnızca kanıtlı deterministik bağlam üretir (kanıt: wiki/overview.md:7-23). LLM bağımlılığı yokluğu komutla doğrulandı: `grep -rin "openai\|anthropic\|langchain\|embedding" packages/*/package.json adapters/*/package.json` boş döner (kanıt: grep exit=1, bu oturumda koşuldu); tüm bağımlılıklar yerel `@causoryn/*` + zod + better-sqlite3 + yaml + MCP SDK ^1.32.2'dir (ADR-002).

Sayısal kimlik: **29 MCP aracı** — `TOOL_NAMES` tekil katalog, `SERVER_VERSION="0.1.0"` (kanıt: packages/mcp-server/src/version.ts:10-13,36-66 — okundu); **5 dil adapter'ı** (TS in-process + 4 sidecar); **1424 test / 76 dosya** (bench ayrık; vitest.config.ts:19-25); **9/9 güvenlik matrisi + 36/36 security süiti** (docs/security-pass.md:21-33; canlı EXIT=0); benchmark medyanları **11.8/13.0/10.7 ms** — TŞ §21 hedeflerinin ~80-180× altı (docs/benchmarks.md:18-22). Sürüm bilinçli olarak **0.1.0 public snapshot**'tır, 1.0.0 değil: üç kapı (Antigravity smoke, ZCode GUI smoke, macOS/Linux/ARM) sağlanmadı (kanıt: wiki/decisions.md:43 K-017; CHANGELOG.md:7-23 — okundu). Bu dokümanın eklediği dürüst kalem: paralel tam-süitte timeout-sınıfı flaky kırmızılar koşumdan koşuma değişir ama izolede yeşile döner (§8); kalem docs'ta açık değildir — backlog önerisi (öneri).

## 2. Çözülen Problem: AI Ajanlarının Kör Kodlaması

LLM tabanlı ajanlar depoyu "kör" düzenler: sembol adlarını tahmin eder, çağrı zincirlerini uydurur, etkiyi ölçemez, kanıt üretemez. Causoryn bu boşluğu ajanın **kanıtlı duyu organı** olarak kapatır: her node/edge/finding `(relativePath, startLine, endLine, sourceHash)` span'lı ve `analyzerId+rationale`'lı kanıta bağlıdır (kanıt: packages/domain/src/graph-schema.ts:35-56). Uydurma hedef yoktur: çözülemeyen çağrı `unresolved` → `UnknownExternal` node'una düşer, asla "muhtemel" hedefe bağlanmaz (kanıt: native/python-worker/PROTOCOL.md:226-232; K-018). Kırmızı çizgiler kimliktir: LLM çağrısı yok, yerel+deterministik (aynı giriş → aynı graph JSON), workspace salt-okunur, ilk transport local stdio (kanıt: wiki/overview.md:7-23).

## 3. Ürün Döngüsü

Döngü **Discover → Preflight → Agent Edits → Verify → Explain**'dir (kanıt: wiki/overview.md:7-23):

| Adım | Causoryn'in rolü | Temsilci araçlar | Yazar mı? |
|---|---|---|---|
| Discover | Kanıtlı mimari/sembol bağlamı | `map_system`, `trace_*`, `get_agent_context` | Hayır |
| Preflight | Aday manifest + mimari/kontrat denetimi | `preflight_change` (candidateOnly, kod yazmaz), `check_architecture`, `check_contracts` | Hayır |
| Agent Edits | Düzenleme host modelde; Causoryn katılmaz | — | Hayır |
| Verify | Çalışma ağacını dört denetimde doğrular; test ÇALIŞTIRMAZ | `verify_change`, `derive_test_plan`, `detect_contract_drift` | Hayır |
| Explain | Kanıt zinciri + kalıcı bilgi yüzeyi | `get_evidence`, `wiki_*`, `export_documentation` | Yalnız `wiki_build`/`export_documentation` kendi data-root'una |

Kalıcı hafıza **Living Wiki**'dir: 18 çekirdek özelliğin yerine geçmez, çapraz kesen #19 katmanıdır, 7 araçla sunulur (kanıt: wiki/scope.md:5-37; wiki/mcp-tools.md:36-38).

## 4. Mimari

### 4.1 Pipeline

Yedi aşama tamamen yerel+deterministiktir: **Workspace Gateway → File Inventory → Language/Framework Adapters → Normalization → Symbol/Contract Resolution → Unified Evidence Graph → Immutable Snapshot → Domain Queries → MCP structuredContent → host-selected model** (kanıt: wiki/architecture.md:7-11; docs/architecture.md:11-18).

### 4.2 Paketler ve bağımlılık sınırları

| Paket | Sorumluluk |
|---|---|
| `domain` | Graph/Evidence sözleşmeleri, Zod şemaları, canonical JSON, deterministik ID |
| `workspace` | Gateway: trusted roots, inventory, ignore, symlink escape, OutputAccessPolicy |
| `indexing` | IndexCoordinator orkestrasyonu |
| `graph` | Snapshot sorguları, traversal/impact/guard/compare |
| `storage-sqlite` | SQLite+FTS5 store + WikiStore |
| `contracts` | Salt-okunur sözleşme keşfi |
| `preflight` | Candidate-only manifest; kod yazmaz |
| `verification` | `verify_change` saf çekirdeği |
| `wiki` | GraphSnapshot→WikiSnapshot projeksiyonu |
| `mcp-server` | stdio + 29 araç |

(kanıt: docs/architecture.md:22-41 + paket description alanları)

Üç sınır komutla doğrulandı: (1) `domain` **yaprak pakettir** — tüm import'lar kendi modülleri + `zod` (tek dep); (2) `workspace` yalnızca node built-in + zod; (3) parser detayı mcp-server'a sızmaz — `@causoryn/adapter-*` import edilmez, erişim yalnız `@causoryn/indexing`'den; tek "adapter" geçişi `INDEXED_ADAPTERS` metadata'sıdır (kanıt: `grep "^import"` domain/workspace çıktıları; `grep "from \"@causoryn/\"` mcp-server — adapter girdisi yok). `verification` saf fonksiyon disiplinindedir: `grep "node:fs\|Date\|Math.random" packages/verification/src` boş; fs/saat/rastgelelik okumaz, test koşucusu çalıştırmaz, `observed` yalnızca kanıtla kabul edilir (kanıt: grep çıktısı; verify-change.ts sözleşmesi).

### 4.3 Evidence modeli ve deterministik kimlik

`Evidence = {id, kind, span?, analyzerId, analyzerVersion, rationale}`; `SourceSpan = {relativePath, startLine≥1, endLine≥startLine, sourceHash}`; indexing her File node'a `inventory` evidence'lı verified CONTAINS kenarı ekler, envanter dışı path `indexing/internal` ile reddedilir (kanıt: graph-schema.ts:35-56; index-service.ts:267-284). `verified` kenar ≥1 evidence invariant'ı **üç katmanda** zorlanır: kurucu `domain/verified-edge-requires-evidence` hatası, `superRefine` şema reddi; `heuristic/unresolved` kanıtsız kalabilir (bilinçli tasarım). Snapshot invariant'ları (dangling edge, duplicate ID, bilinmeyen evidence) kurucu+şema+repository'de denetlenir; ID uyuşmazlığı `graph/*-id-mismatch` reddidir (kanıt: ids.ts:163-189; graph-schema.ts:84-93,119-186; validation.ts:10-14).

ID'ler canonical JSON + SHA-256'dır: node `(workspaceId, kind, qualifiedName, relativePath|null)`, edge `(workspaceId, kind, from, to)`; snapshot ID `SHA-256(canonical JSON([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))` — **saat ID'ye girmez**, `clock: () => string` enjekte edilir, `createdAt` yalnız meta'da (kanıt: ids.ts:14-50,92-135; snapshot.ts:8-21; index-service.ts:202). Sonuç deep-frozen immutable snapshot'tır (ADR-005); diziler ID'ye göre kanonik sırada tutulur.

### 4.4 Depolama ve yayın disiplini

SQLite: `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`; `symbol_fts`+`wiki_fts` FTS5 araması embedding'siz; şema `user_version=2`, DDL tek statik literal, veri parametreli (kanıt: sqlite-repository.ts:150-153; schema.ts:24-38). Yayın atomiktir: `beginBuild` `building` açar, building satırları hiçbir okuma yolunda çözülemez; `publish` tek transaction'da `ready|partial` yapar; `failed` build akışa girmez; yayımsız okuma `storage/corrupt-row` reddidir (kanıt: repository.ts:15-25; sqlite-repository.ts:41-46,443-470). Stale iki koşulludur: daha yeni yayın var ya da `revision_sequence >=` building build aktifse `stale=true` (kanıt: sqlite-repository.ts:815-839,513-528).

IndexService yetki → envanter → adapter → merge → atomik publish sırasını kodlar; her hata `failBuild`'e düşer, akışa hiçbir şey girmez (kanıt: index-service.ts:86-104,679-706). Degrade motoru çökertmez: senkron köprü worker spawn etmez, L0 File node'larını `sync-run-degraded` fingerprint + warning ile `partial` yayınlar; async fallback adapter içindedir — diğer diller yaşar (kanıt: index-service.ts:114-122,926-998). Incremental karar content-hash'tir: değişim yoksa graph korunur; envanter mutabakatı adapter koşumlarından SONRA yapılır ki sözleşme dışı hata bayat graph'ı kilitlemesin (kanıt: index-service.ts:526-576,1059-1064).

## 5. MCP Araç Kataloğu

`tools/list` TAM OLARAK 29 araç sunar; boş handler yayınlanmaz (ADR-010). Gruplar 7+6+3+3+3+7=29 (kanıt: version.ts:36-66 — sayıldı; wiki/mcp-tools.md:1 "22+7=29"):

| Grup | Adet | Araçlar |
|---|---|---|
| Keşif & indeks | 7 | `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index`, `find_symbols`, `get_symbol_context`, `get_evidence` |
| Mimari | 6 | `map_system`, `trace_execution`, `trace_business_flow`, `analyze_impact`, `compare_architecture`, `architecture_timeline` |
| Gezinti/rapor | 3 | `get_agent_context`, `generate_onboarding`, `export_documentation` (json/markdown/mermaid/html deterministik) |
| Kontratlar | 3 | `check_contracts`, `detect_contract_drift`, `derive_test_plan` (test ÇALIŞTIRILMAZ) |
| Guard | 3 | `check_architecture` (bulgu raporlar, CI kararı vermez), `preflight_change`, `verify_change` |
| Wiki | 7 | `wiki_build` (yazan TEK wiki aracı) + 6 salt-okunur (`search` = FTS5, embedding yok) |

**Envelope**: 10 alanlı `z.strictObject` — `schemaVersion, requestId, workspaceId, snapshotId, status(ok|partial|error), coverage(tier L0-L4 + coverageRatio 0-1), warnings, data, nextCursor, error`; tümü her yanıtta (kanıt: envelope.ts:24-55,84-105). Envelope hataları `isError=false` structuredContent ile taşınır (statü sözleşmesi, protokol hatası değil); stack trace sonuca girmez, beklenmeyen hata `INTERNAL_ERROR`+requestId ile döner, detay yalnızca stderr'de; `AMBIGUOUS_SYMBOL` yolunda `data` aday listesi taşır (kanıt: server.ts:135-137,513-529; TŞ §10.3).

**Hata kodları**: 15 sabit kod; kod→(retryable, userAction) eşlemesi `TOOL_ERROR_GUIDANCE`'da deterministiktir. `retryable=true` yalnız 2 kodda: `INDEX_NOT_READY`, `INTERNAL_ERROR`; öteki 13 `retryable:false`. Uzantı dürüstlüğü: `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND` TŞ §10.1'de yok — ilk ikisi K-008 ile kararlı, `SYMBOL_NOT_FOUND` kayıtsız (yeni ADR orkestratörde); beş uzay kodu (`POLICY_INVALID`, `INVALID_REVISION`, `EXPORT_NOT_ALLOWED`, `WIKI_PAGE_NOT_FOUND`, `CONTRACT_PARSE_FAILED`) TŞ listesinden seçildi, yeni kod basılmadı (kanıt: errors.ts:7-84,93-172; wiki/decisions.md K-008/K-011).

**Yazma matrisi** — 3 araç yazar, 26 salt-okunur (kanıt: wiki/mcp-tools.md:42-45; server.ts:333/367 beyanları):

| Araç | Hedef | Sınır |
|---|---|---|
| `refresh_index` | Yalnızca Causoryn indeksi | allowRoots[0] salt-okunur tarar; kablolada `InMemoryGraphRepository` (context.ts:133) |
| `export_documentation` | `output.allowedOutputDirs` | Default boş → deny → `EXPORT_NOT_ALLOWED`; atomik (.tmp+rename) (services-architecture.ts:1016-1043) |
| `wiki_build` | `wiki.dataDbPath` | Mutlak yol zorunlu, allowRoots İÇİNDE olamaz (symlink-kaçışlı; ADR-008); beyansız `PATH_DENIED`; kaynak ağaca yazım yasak (services-wiki.ts:136-145; context.ts:184-309) |

**Cursor/limit**: cursor opak sürümlü codec (`{v:1,o:<int>}` → base64url); bozuk cursor → null → `INVALID_ARGUMENT`; `nextCursor` son sayfada null ve envelope-düzeyi = `data.nextCursor` (kanıt: cursor.ts:13-41; services-wiki.ts:102-105,210-220). Limitler: `map_system` maxNodes 250, `find_symbols` 100, wiki default 50/tavan 200 (K-013), aşım `LIMIT_EXCEEDED`; `maxDepth`=3, `maxPaths`=50 (kanıt: services.ts:728-732,888-892; config.ts:26-37).

## 6. Dil Desteği

### 6.1 İki eksen, beş adapter

"L0-L4" iki eksendir: (1) **adapter yetenek ekseni** — L0 dosya/manifest → L4 flow/contract cross-link; ilk hedef TS L2 + seçili Next.js/Express L3 (wiki/scope.md:37); (2) **harita hiyerarşisi** (TŞ §16) — L0 Workspace → L3 Function/Endpoint; L4 akış haritası Faz A'da açık ret (services.ts:655-671,722-725). Bu bölüm birincisidir. TypeScript süreç-içidir (Compiler API: Program+AST+TypeChecker; analyzer.ts 1976 satır); öteki dört dil sidecar'dır: python saf stdlib `ast`, go `go/parser`, rust syn 2, csharp Roslyn (`dotnet exec`). `INDEXED_ADAPTERS` 5 kayıt, `get_capabilities` metadata'yı birebir taşır (kanıt: index.ts:168-224; services.ts:260-269):

| Dil | Motor | Resolution beyanı | L3 route |
|---|---|---|---|
| TypeScript | TS Compiler API (in-process) | L2 (TypeChecker verified) | `<x>.<verb>` kalıbı + express linker + Next.js App Router kuralı |
| C# | Roslyn semantic model | L2 — tek gerçek semantik sidecar | HttpGet/… fiilleri + MapGet/… minimal API |
| Python | stdlib `ast` | L2 + "tam type inference YOK" | `@carrier.get/…` + Flask `route` |
| Go | stdlib `go/parser` | "heuristic-only (semantik L2 yok)", `SymbolResolution:false` | Handle/HandleFunc + chi/gin/echo |
| Rust | syn 2 | "heuristic-heavy" | attribute-macro: 9 fiil + axum/actix/rocket |

(kanıt: index.ts:158-162 "'L2' UYDURULMAZ, dürüst etiket yazılır" + :168-224; go main.go:79-86)

### 6.2 Resolution dürüstlüğü (K-018)

K-018 etiketleri dil başına PROTOCOL.md tablosuyla sabitler (wiki/decisions.md:44): **python** — `verified` yalnız aynı modül (`self.<m>`, `Sınıf.<m>` dahil); import edilen `heuristic`+ambiguity; tanımsız `unresolved`→UnknownExternal. **go** — `verified` yalnız aynı-package bare-ident (yerel değişken gölgelemesi AST'ten ayırt edilemez — belgeli); `pkg.Func`/benzersiz metot/arayüz metodu `heuristic`; builtin kenar ÜRETİLMEZ. **rust** — aynı modül bare ve tek-eşleşmeli nitelikli çağrı `verified` (modül önekleri tam doğrulanmaz — belgeli); metot çağrısı `heuristic` (trait dispatch yok). **csharp** — Roslyn semantic çözümlediği her çağrı (set içi/dışı) `verified`; bilinen-ad `heuristic`. ROUTES_TO **her dilde daima verified+evidence**; çözülemeyen handler'da Endpoint korunur, kenar ÜRETİLMEZ (kanıt: native/*/PROTOCOL.md; worker.py:898-901; routes.go:14-17; analyzer.rs:618-650; analyzer.ts:1422-1464; WorkerAnalyzer.cs:1476-1490).

Nüanslar: (1) wiki/sprint-8.md:4 özeti ("Go L2+L3 · Rust L1.5/L3") gevşek kısaltmadır; bağlayıcı tablo INDEXED_ADAPTERS + PROTOCOL.md'lerdir. (2) C#'ın L3'ü yüzeyde frameworkLinkers:"yok" görünür çünkü routeDetection yüzey sözleşmesine kasıtlı girmedi; gerçek beyan Protocol.cs:234'te. (3) coverageRatio = verified/toplam kenar (python PROTOCOL.md:141-142; go analyze.go:499-507); C#'ta set-dışı çağrılar checker dayanaklı verified (roslyn PROTOCOL.md:125-128). K-018 ayrıca orkestratör brief'indeki iki hatalı ifadeyi (go pkg-qualified=verified; rust tamamen heuristic) disk gerçeğiyle düzeltip sapmayı kayda geçirdi.

### 6.3 Degrade katmanları

Üç düzey: (1) **adapter** — 4 sidecar'da özdeş fallback: `workerAvailable:false, state:"partial", coverageRatio:0`, sourceHash'li File node'ları korunur, yetenekler tümü false (kanıt: adapters/go/src/analyzer.ts:398-434; types.ts:164-172). (2) **toolchain** — spawn'lar literal komut + sabit args + env allowlist: python `python -I -B` (`-B` __pycache__ yazımını kapatır), go `go run ./cmd/worker` (timeout 120 sn), rust literal `cargo` (yoksa available=false + gerekçe), csharp `dotnet exec` (kanıt: adapters/*/src/worker-process.ts; adapters/rust/src/analyzer.ts:153-198). (3) **dosya/pipeline** — SyntaxError hata değil: `partial` + dosya+satır tanısı, sağlam dosyaların grafiği sürer (python PROTOCOL.md:339-341); canlı doğrulandı: broken.py+ok.py → exit 0, partial, `diagnostics[{code:"SyntaxError",line:1}]` (analist elle spawn, 2026-11-16).

Degradasyon uçtan uca kanıtlandı: `npx vitest run packages/indexing/test/index-service-multilang.test.ts` ilk koşumda `spawn dotnet ENOENT` → C# adapter L0/L1'e düştü (log: "L0/L1 dosya düzeyine düşüldü"), diğer 4 dil TAM üretildi, snapshot `partial` yayımlandı, motor ayaktaydı; PATH düzeltmesiyle 9/9 passed (kanıt: analist iki vitest koşumu, 55.97s).

### 6.4 Örnek senaryo: bir Python projesi verilirse ne olur?

Kullanıcı `examples/fixture-python-app`'i (3 dosya) allowRoot beyan edip `causoryn_refresh_index` çağırır. Akış: WorkspaceAccessPolicy yetkilendirir → envanter → worker `python -I -B native/python-worker/worker.py` spawn'ı → stdlib `ast` parse → tek build'e katma → `ready` publish. Analist bu koşumu bizzat çalıştırdı (kanıt: canlı çıktı, 2026-11-16; implementation-status.md Sprint 8 kaydıyla birebir):

- **exit 0, ready** — 21 node (3 File, 1 Class, 8 Function, 2 Method, 2 Endpoint, 5 UnknownExternal), 25 edge (11 CONTAINS/verified, 3 CALLS/verified, 4 CALLS/heuristic, 5 CALLS/unresolved, 2 ROUTES_TO/verified), coverageRatio 0.64, capabilities `{astParse:true, symbolResolution:true, routeDetection:"python-decorator-route-pattern", frameworkLinkers:false}`.
- Kurallar K-018 §1'e birebir uyar: `@app.get("/x")` → Endpoint + ROUTES_TO verified; aynı modül `helper()` → CALLS verified; `utils.run()` import'u → heuristic+ambiguity; çözülemeyen ad → UnknownExternal + unresolved — uydurma hedef yok.
- Host modeli `find_symbols`/`get_symbol_context` ile bağlamı, `get_evidence` ile span+sourceHash'li zinciri okur; `wiki_build` yalnız beyanlı dataDbPath'e yazar.
- Python hiç olmasaydı: spawn başarısız → L0/L1 düşüş, sourceHash'li File node'lar + warning ile `partial` publish; graph boş dönmez ama sembol katmanı yok olur — motor çökmez.

## 7. Güvenlik Modeli

**WorkspaceAccessPolicy** sabit 6 adımlıdır: (1) kök yetkilendirmesi — yalnız config beyanlı allowRoot'lar, realpath canonicalization ("MCP isteği tek başına kök ekleyemez", TŞ §9/§20); (2) null byte reddi; (3) leksik `..`/mutlak yol reddi; (4) ignore (atalar dahil); (5) realpath symlink/junction escape reddi (CWE-59); (5b) kanonik yola ignore yeniden uygulaması — symlink secret-deny bypass edemez; (6) uzantı + maxFileBytes (kanıt: packages/workspace/src/workspace-access-policy.ts:17-33,135-252). Okuma ve yazma **ayrı policy sınıflarıdır**: OutputAccessPolicy yalnız kullanıcı beyanlı output dizinlerine, aynı realpath containment ile yazar; workspace salt-okunur kalır (kanıt: output-policy.ts:11-48).

Spawn güvenliği: 4 worker literal komut + sabit args + env allowlist, shell interpolation yok (kırmızı çizgi 3/6; adapters/*/src/worker-process.ts). stdout yalnız MCP protokolü, loglar stderr. `wiki.dataDbPath` sıkı doğrulanır: mutlak yol, null byte yasak, allowRoots içinde olamaz; ihlal `CausorynConfigError` ile düşüş — sessiz devam yok (kanıt: context.ts:184-309). TŞ §22 matrisi **9/9 PASS**: symlink/traversal, secret leakage, TOCTOU, poisoned comment, oversized files, malicious refs, network denied, offline HTML XSS/CSP, stdout disiplini; "0 başarısız, 0 not run" (docs/security-pass.md:21-33; komutlar :44-65). Security süiti canlı: `npx vitest run tests/security-release/` → 36/36, EXIT=0 (analist koşumu, 2026-11-16). Çalışma zamanı bundle taramalarda temiz; npm audit moderate'ları yalnız dev-toolchain (security-pass.md:24,29).

## 8. Kalite ve Testler

Repoda **77 `*.test.ts`** var: packages 56 (mcp-server 13, graph 10, wiki 7, contracts/domain/indexing 6'şar, storage-sqlite 4, preflight 2, verification 1, workspace 1), adapters 6, integrations 3, tests 12; varsayılan süit 76 dosya çünkü `tests/bench-release/` ayrı config'tedir (config yorumu: "paralel süit yükü altında 30 s deadline aşılıp flaky-potansiyellidir"; kanıt: vitest.config.ts:9-25; `find` sayımı). Kapılar script'te mevcut: `test`, `test:watch`, `bench`, `build`, `typecheck`, `lint` (package.json).

| Kapı | Komut | Sonuç (2026-11-16, analist koşumu) |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 |
| build | `npm run build` | BUILD_EXIT=0 |
| lint | `npm run lint` | exit 0, sıfır ihlal (~30 dk) |
| security | `npx vitest run tests/security-release/` | 36/36 (15.04s) |
| bench | `npm run bench` | 8/8 (101.76s); medyan 11.8/13.0/10.7 ms, soğuk indeks 16370.3 ms; hedef kolonu referanstır (benchmarks.md:3,11,18-22) |
| npm audit | `npm audit --json` | 9 moderate, 0 high/critical; kök `minimatch` (eslint transitive) — docs'taki "10" sürüm kayması; `audit fix --force` eslint v4'e düşürdüğünden uygulanmadı (implementation-status.md:441) |

**Flakiness dürüst kaydı**: iki tam koşum FARKLI dosyaları kırmızıya düşürdü (11 failed/1413 passed, 567s → 3 failed/1421 passed, 258s), tamamı 30 sn timeout sınıfı; kırmızı 7 dosyanın izole tekrarında 6/7 yeşil (101/103), `faz-c-tools.test.ts` izole 26/26 (kanıt: analist vitest logları). docs kaydı "76 dosya / 1424 test passed" [K] (implementation-status.md:31) ile karşılaştırınca: **yeşillik koşumdan koşuma değişir, sistemik kırılma bulgusu YOK**; 1 testlik fark ağaç sürüm kayması. Kalem docs'ta açık değil — backlog önerisi (öneri). Her iki koşumda 1 skipped (`packages/graph/test/compare.test.ts:720`), sprint-7'den beri belgeli.

Bilinen sınırlar (implementation-status.md F9): Antigravity NOT RUN; platform doğrulaması yalnız Windows x64; MCP SDK 1.32.2 v1.x; B7 Live Architecture Partial (per-file parse reuse yok, watcher MCP aracı değil, incremental açık ret); adanmış secret-scan script yok; rate-limit kapsam dışı (K-010); visualizer tarayıcı koşusu yok; bundle .d.ts eksik → global-referanslı kaynaklar partial.

## 9. Karar Kayıtları (seçme)

| Karar | Özet | Kanıt |
|---|---|---|
| K-001/K-004/K-005/K-006 | Karpathy LLM Wiki metodolojisi; runtime = Agent Team Dispatch + DEVELOPMENT_FLOW; context-inject kütüphanesi (indirilen dosya güvenilmez veridir: okunur, çalıştırılmaz); standart skill seti /workflow + superpowers | wiki/decisions.md:27-32 |
| K-002/K-003 | ZCode 4. host adapter; 1.0 kapsamı dikey dilim önce (iptal değil, sıralama) | wiki/decisions.md:28-29 |
| K-007 | raw "Development Rules" kullanıcı kararıyla geçersiz | wiki/decisions.md:33 |
| K-008/K-011/K-012 | Hata kodu yönetişimi: INVALID_ARGUMENT+EVIDENCE_NOT_FOUND kararlı (K-008); SYMBOL_NOT_FOUND üçüncü uzantı (K-011); Faz C'de yeni uzantı İSTENMEDİ — uygun kod yokken uzantı örüntüsü | wiki/decisions.md:34-38 |
| K-009/K-010 | MCP SDK 1.32.2 v1.x sapması kabul; rate-limit/concurrency Faz A dışı | wiki/decisions.md:35-36 |
| K-013/K-014 | Wiki 7 açık konu: cursor 50/200, bozuk link = WikiLink korunur + brokenLinkDiagnostics (hata değil veri yüzeyi) | wiki/decisions.md:39-40 |
| K-015/K-016 | CONTRACT_PARSE_FAILED ilk kullanımı; verify_change Faz D'de bilinçli yok (ADR-010 boş handler yasağı); verdict önceliği blocking > inconclusive > review_required > clean; "passed count" = host beyanı, çekirdek dosya okumaz | wiki/decisions.md:41-42 |
| K-017 | **0.1.0 public snapshot** (kapılar açık); bundle "mcp-server.mjs + vendored better-sqlite3", tek dosya iddiası yok; TOOL_NAMES 29 kilitli | wiki/decisions.md:43 |
| K-018 | Çok-dil resolution etiketleri PROTOCOL.md tablosuyla sabit; orkestratör brief sapması kayda geçti | wiki/decisions.md:44 |

## 10. Durum ve Sürüm

**v0.1.0 public snapshot (2026-11-09, 1.0.0 DEĞİL)**: annotated tag `v0.1.0` → `4c9c188` (PR #13, "7-sprint plan complete — 1.0.0 gates deferred"); HEAD sprint-8 merge'i `5d6357c` (PR #14) (kanıt: CHANGELOG.md:25-30; `git show v0.1.0`). Sprint zinciri test süitini 247'den 1424'e büyüttü: Faz A (11/11, 247) → Faz B (B7 **Partial** kalır, 419) → Faz C+C2 Living Wiki (634→800) → Faz D (28 araç, 1024) → Faz E (**29 araç — katalog tamam**, 1116) → Faz F (v0.1.0 etiketi, plan TAMAM, 1266) → Sprint-8 plan-dışı çok-dil genişlemesi (1424) (kanıt: wiki/sprint-1..8.md:4). Fazlar A-F Done; hiçbir sprint 1.0.0 ilan etmedi (implementation-status.md [D]/[R]/[K]/[S] kanıt işaret efsanesi).

**Host matrisi** (docs/compatibility-matrix.md:23-47): Claude Code ✔ gerçek handshake (CLI 2.1.322, `claude mcp list → ✔ Connected`); Codex ✔ add→list→remove (health-check yapmaz — dürüst kayıt); ZCode ⚠ manifest-düzeyi (GUI kurulumu kırmızı çizgi 6 gereği kasıtlı yapılmadı); Antigravity ❌ NOT RUN (agy yok) — 2/3 gerçek koşum. Tüm koşumlar Windows 10.0.26300 x64; tüm hostlar aynı bundle'ı çalıştırır (dist/mcp-server.mjs + vendored better-sqlite3); kılavuzlar docs/hosts/ + integrations/zcode/'ta.

**1.0.0 kapıları (CHANGELOG [Unreleased])**: Antigravity smoke; ZCode GUI smoke; macOS/Linux/ARM; MCP SDK v1→v2 (K-009 kapanışı); `refresh_index mode=incremental` + per-file parse reuse (B7); TS/C# TESTS kenarı; OpenAPI yanıt-şeması drift + event-version kuralı; wiki_search filtreleri; E6 tarayıcı koşusu; bundle .d.ts fidelity; rate-limit budget + secret-scan script; npm audit çözümü. ADR-010 gereği kapılar sağlanmadan 1.0.0 ilan edilmez (CHANGELOG.md:7-23 — okundu). Ek öneri: paralel süit flakiness'ının izole-yeşil doğrulaması ve izolasyon stratejisi (öneri, backlog).

**Genel değerlendirme**: motor yüzeyi sağlamdır — typecheck/build/lint/security/bench beş kanıt bu turda bizzat yeşil koşuldu; mimari sınırlar komutla doğrulandı; tek yeni kalem paralel süitteki timeout-sınıfı flaky kırmızılar (izolede yeşil, sistemik kırılma yok). Açık kalemler §8-§10'da sayılı; hiçbiri "Done" yazılmadı.

---

# English

# Causoryn — Comprehensive Project Document

*Scope: Causoryn v0.1.0 snapshot, `main` branch (HEAD `5d6357c`), eight completed sprints. Evidence appears as `file:lines` or command/output summaries from the analysis session; anything that session did not execute is labeled as such. TŞ denotes the project's technical specification (Teknik Şartname).*

## 1. Executive Summary

Causoryn is a **local, deterministic code-analysis engine for AI coding agents**, shipped as an MCP (Model Context Protocol) server over stdio. It converts a repository into a **Unified Evidence & Knowledge Graph** and serves it through **29 structured MCP tools**. No LLM, embedding, or model API exists anywhere in the engine — the host-selected model writes the prose, Causoryn supplies checkable facts (evidence: `wiki/overview.md:7-23`; a grep for `openai|anthropic|langchain|embedding` across every package and adapter manifest returned zero matches; ADR-002).

Five languages are analyzed — TypeScript in-process, C#/Python/Go/Rust via sidecar workers — and every relationship carries an honest resolution label (`verified` / `heuristic` / `unresolved`), every verified edge backed by evidence with file, line span, and source hash (`domain/src/ids.ts:163-189`; `indexing/src/index.ts:168-224`). The release is deliberately **0.1.0, not 1.0.0**: three release gates remain open (`wiki/decisions.md:43`; `CHANGELOG.md:7-23`). Typecheck, build, lint, the security suite (36/36), and the benchmark suite (8/8) all ran green in the authoring session; the full parallel test suite shows load-sensitive, timeout-class flakiness — different tests fail run to run, all pass in isolation (§8).

## 2. Problem Statement — AI Agents Code Blind

An AI coding agent on a private repository has no reliable map of what it is editing. It invents symbols and call relationships, cites files that do not exist, and cannot prove an edit preserved an architectural boundary — confident, fluent, unverified code. Conventional indexers (ctags, LSP) answer narrow queries but yield no auditable world model an agent can be forced to respect. Causoryn makes repository structure **computable and checkable before, during, and after agent edits**: a deterministic graph where every relationship carries a truth label and every verified claim carries evidence at an exact file and line with a content hash — holding the host model to what is in the tree, not what it recalls from training data (evidence: `wiki/overview.md:7-23`; `wiki/scope.md:5-37` — 18 core features plus the cross-cutting #19 Living Wiki Engine, which complements rather than replaces them).

## 3. Product Loop

Agent work is structured as **Discover → Preflight → Agent Edits → Verify → Explain** (`wiki/overview.md:7-23`):

| Stage | Causoryn's role | Representative tools |
|---|---|---|
| Discover | Deterministic architecture map, symbol context, impact paths, context packs | `map_system`, `get_symbol_context`, `analyze_impact`, `get_agent_context` |
| Preflight | Candidate-only manifest of what a change would touch; writes no code | `preflight_change` (`candidateOnly` fixed `true`, `server.ts:333`) |
| Agent Edits | Host model edits the tree; Causoryn stays read-only | — |
| Verify | Re-checks the working tree under four audits; writes no code | `verify_change` (`server.ts:367`) |
| Explain | Living wiki, deterministic exports, architecture diff/timeline | 7 `wiki_*` tools, `export_documentation`, `compare_architecture` |

The honesty boundary is explicit: `derive_test_plan` proposes candidates from TESTS edges and call sites but never runs tests; `verify_change` never claims "tests passed" (verdict chain per K-016) (`server.ts:340-382`; `wiki/decisions.md:42`).

## 4. Architecture

### 4.1 Pipeline

Seven fully local, deterministic stages: Workspace Gateway → File Inventory → Language/Framework Adapters → Normalization → Symbol/Contract Resolution → Unified Evidence Graph → Immutable Snapshot → Domain Queries → MCP `structuredContent` → host-selected model (evidence: `wiki/architecture.md:7-11`; `docs/architecture.md:11-18`).

### 4.2 Packages

| Package | Responsibility |
|---|---|
| `domain` | Graph/evidence contracts, Zod schemas, canonical JSON, deterministic IDs |
| `workspace` | Gateway: trusted roots, inventory, ignore rules, symlink escape, output policy |
| `indexing` | IndexCoordinator orchestration |
| `graph` | Snapshot queries, traversal/impact/guard/compare |
| `storage-sqlite` | SQLite + FTS5 store and wiki store |
| `contracts` | Read-only contract discovery |
| `preflight` | Candidate-only manifest (writes no code) |
| `verification` | Pure `verify_change` core |
| `wiki` | GraphSnapshot → WikiSnapshot projection |
| `mcp-server` | stdio transport + 29 tools |

(evidence: `docs/architecture.md:22-41` and each package's `description`.)

### 4.3 Dependency boundaries

1. **`domain` is a leaf**: imports only its own modules and `zod` — no `@causoryn/*`, no MCP SDK, no Node APIs (grep over `packages/domain/src`; sole dependency `zod ^4.6.7`).
2. **`workspace` touches only Node built-ins and zod** (grep over `packages/workspace/src`; sole dependency zod).
3. **Parser detail never leaks into `mcp-server`**: it imports no `@causoryn/adapter-*`; adapters are reached only via `@causoryn/indexing`, and "adapter" appears there only as string metadata (`INDEXED_ADAPTERS`, `services.ts:260`).

### 4.4 Determinism and the evidence model

- **Injected clock**: the repository layer never reads the wall clock; `IndexService` injects `clock: () => string` (`repository.ts:10-13`; `index-service.ts:202`).
- **Deterministic IDs**: node/edge/evidence IDs are `<type>:<sha256-hex-64>` over canonical JSON — node keys on `(workspaceId, kind, qualifiedName, relativePath|null)`, edge on `(workspaceId, kind, from, to)` with resolution deliberately excluded (`ids.ts:14-50, 92-135`). Snapshot IDs exclude timestamps; snapshots are deep-frozen (ADR-005) in canonical ID order (`snapshot.ts:8-21`).
- **Verified-edge invariant, three layers**: the `createEdge` constructor throws `verified-edge-requires-evidence`; the Zod `superRefine` rejects violations; `heuristic`/`unresolved` edges may stay evidence-free by design (`ids.ts:163-189`; `graph-schema.ts:84-93`).
- **Snapshot invariants** — dangling edges, duplicate IDs, unknown evidence references — are checked in the schema (`graph-schema.ts:119-186`) and again by the repository, which re-derives every ID and rejects mismatches (`validation.ts:10-14`). Evidence spans carry `{relativePath, startLine≥1, endLine≥startLine, sourceHash}`; targets outside the inventory are rejected with `indexing/internal` (`graph-schema.ts:35-56`; `index-service.ts:1460-1495`).
- **Pure verification core**: no `node:fs`/`Date`/`Math.random` in `packages/verification/src` (grep empty); reports are byte-deterministic; a test runner is never executed and `observed` counts are accepted only from evidence.
- **IndexService order**: authorize root → inventory → sync TS plus async C#/Python/Go/Rust workers → merge into one build → publish; any error lands in `failBuild` and nothing enters the publish stream (`index-service.ts:86-104, 679-706`).

### 4.5 Storage

SQLite runs WAL, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`, with FTS5 tables (`symbol_fts`, `wiki_fts`) and `PRAGMA user_version=2`; all DDL is one static literal, all data bound via prepared-statement parameters (`sqlite-repository.ts:150-153`; `schema.ts:24-38`). **Atomic publish**: builds open as `building`, invisible to every read path; `publish` flips to `ready`/`partial` in one transaction; `failed` never publishes; reading an unpublished snapshot is rejected with `storage/corrupt-row` (`repository.ts:15-25`; `sqlite-repository.ts:443-470`). **Stale semantics**: stale if a newer publication exists or a `building` build with `revision_sequence >=` is active, so old-publication queries keep working during rebuilds (`sqlite-repository.ts:815-839`). **Incremental indexing** is content-hash based: with no meaningful change across the five languages the graph is kept and only the files table refreshed; reconciliation runs *after* adapter runs, so an out-of-contract adapter error cannot lock a stale graph behind a "no changes" verdict (`index-service.ts:526-576, 594-612`).

## 5. MCP Tool Catalog — 29 Tools

`TOOL_NAMES` (`version.ts:36-66`) holds exactly 29 unique `causoryn_*` names — re-read and confirmed this session, with `SERVER_VERSION = "0.1.0"` (:10) and envelope `SCHEMA_VERSION = "2.0"` (:13); the registration loop (`server.ts:484-533`) registers each one, and empty handlers are forbidden (ADR-010).

| Group | Tools | # |
|---|---|---|
| Discovery & Index | `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index`, `find_symbols`, `get_symbol_context`, `get_evidence` | 7 |
| Architecture | `map_system`, `trace_execution`, `trace_business_flow`, `analyze_impact`, `compare_architecture`, `architecture_timeline` | 6 |
| Navigation & Report | `get_agent_context` (task text → context pack up to `tokenBudget`), `generate_onboarding`, `export_documentation` (json/markdown/mermaid/html) | 3 |
| Contracts | `check_contracts` (backward-safe/risk/breaking_candidate/unknown), `detect_contract_drift`, `derive_test_plan` | 3 |
| Guard | `check_architecture` (SCC no-cycles + forbidden-dep over `.causoryn/architecture.rules.yaml`; reports findings, no CI verdict), `preflight_change`, `verify_change` | 3 |
| Wiki | `wiki_build` (the only wiki writer) + read-only `wiki_get_tree`, `wiki_get_page`, `wiki_search` (FTS5, no embeddings), `wiki_get_links` (backlinks + broken-link diagnostics), `wiki_get_versions`, `wiki_diff` | 7 |

(evidence: `version.ts:37-66`; `server.ts:159-480`; `wiki/mcp-tools.md:9-45`.)

**Envelope**: every response is a `z.strictObject` with all ten fields present — `schemaVersion`, `requestId`, `workspaceId`, `snapshotId`, `status` (`ok|partial|error`), `coverage` (tier L0–L4, edge resolution counts, coverageRatio), `warnings`, `data`, `nextCursor`, `error` (`envelope.ts:24-55`). Errors travel *inside* the envelope (`isError=false`), never as protocol faults; stack traces never reach the client — unexpected failures return `INTERNAL_ERROR` with a generic message and `requestId`, raw detail goes to stderr only; `AMBIGUOUS_SYMBOL` carries candidates in `data` (`server.ts:135-137, 513-529`).

**Error codes**: a fixed table of 15 codes with static `retryable` + `userAction` guidance; only `INDEX_NOT_READY` and `INTERNAL_ERROR` are retryable (`errors.ts:68-84, 93-164`). Governance: `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `SYMBOL_NOT_FOUND` are project extensions beyond the TŞ §10.1 list — K-008 covers the first two, `SYMBOL_NOT_FOUND` is recorded but not yet ADR-covered; later phases invented no new codes where fixed ones sufficed (K-012) (`errors.ts:7-66`; `wiki/decisions.md:34-38`).

**Write-permission matrix** — exactly three tools write, each narrowly:

| Tool | Writes to | Guard |
|---|---|---|
| `refresh_index` | Causoryn's own index (graph repository) | Scans `allowRoots[0]` read-only |
| `export_documentation` | `config.output.allowedOutputDirs` only; atomic (.tmp + rename) | Empty list ⇒ default deny ⇒ `EXPORT_NOT_ALLOWED` |
| `wiki_build` | `config.wiki.dataDbPath` SQLite data-root; atomic publish | Unset ⇒ `PATH_DENIED`; never writes workspace sources |

(evidence: `services-architecture.ts:1016-1043`; `config.ts:48-52`; `services-wiki.ts:136-145`.) The declared `wiki.dataDbPath` is strictly validated at startup — absolute, no null bytes, outside every authorized workspace root (symlink-escape checked, per ADR-008), parent must exist; violations crash the server with `CausorynConfigError` rather than continuing silently (`context.ts:184-309`). The other 26 tools are read-only (`wiki/mcp-tools.md:45`).

**Pagination and limits**: cursors are opaque, versioned offsets (`{v:1,o:<int>` as base64url); undecodable cursors become `INVALID_ARGUMENT` ("reuse the previous `nextCursor` verbatim"); `nextCursor` is null on the last page at both envelope and data level (`cursor.ts:13-41`; `services-wiki.ts:210-220, 102-105`). Defaults: `map_system` maxNodes 250, `find_symbols` 100, wiki tools 50 with a 200 cap (K-013); breaches raise `LIMIT_EXCEEDED`; `maxDepth`=3 and `maxPaths`=50 cap trace tools (`config.ts:26-37`; `services-wiki.ts:114-116`; `services.ts:728-732`).

## 6. Language Support — Five Adapters, Honest Labels

### 6.1 Two patterns, one registry

TypeScript runs **in-process** on the Compiler API (Program + AST + TypeChecker; `analyzer.ts`, 1,976 lines). C#, Python, Go, and Rust run as **sidecar workers**: C# on Roslyn via `dotnet exec` (`WorkerAnalyzer.cs`, 1,669 lines); Python on stdlib-only `ast` (`worker.py`, 1,190 lines; "zero external dependencies"); Go on stdlib `go/parser`+`go/ast`; Rust on `syn` 2 + serde_json (`analyzer.rs`, 1,209 lines). All five register in `INDEXED_ADAPTERS` (`index.ts:168-224`), which `get_capabilities` surfaces verbatim (`services.ts:260-269`). Note the two distinct L0–L4 axes: the *adapter capability* axis (L0 file discovery → L4 flow/contract cross-linking; `wiki/scope.md:37`) versus the *map hierarchy* axis of `map_system` (L0 Workspace … L3 Function/Endpoint; L4 flow maps explicitly unsupported in Phase A, `services.ts:722-725`).

### 6.2 Resolution honesty per language

| Language | Symbol resolution (honest label) | Route detection (L3) |
|---|---|---|
| TypeScript | L2 — TypeChecker: internal/external imports verified; Node builtins and relative guesses heuristic; unknown unresolved | Generic `<x>.<verb>("/path", handler)` + Express linker + Next.js App Router file conventions |
| C# | **True semantic resolution** (Roslyn) — verified wherever the checker resolves, in-set or out-of-set; known-name rules heuristic; nothing fabricated | HttpGet/HttpPost/… attributes + MapGet/MapPost/… minimal APIs; `[Route]`-less controllers produce no endpoints, by warning |
| Python | L2 — same-module verified; imported heuristic + ambiguity; locals/builtins/unknown → UnknownExternal (unresolved) | `@carrier.get/post/…` decorators + Flask-style `route`/`api_route` |
| Go | **"heuristic-only (no semantic L2)"** — verified only for same-package bare identifiers; builtins produce no edge; `pkg.Func` and method names heuristic; multi-candidate unresolved; `SymbolResolution:false` declared | Handle/HandleFunc (`"*"`) + chi/gin/echo verbs, guarded by literal `/`-prefix + ≥2 args; recognized registrations emit no CALLS |
| Rust | **"heuristic-heavy"** — same-module bare and single-match qualified verified (module prefixes not fully validated, documented limit); method calls heuristic (no trait dispatch); no-candidate unresolved | Attribute macros: 9 verbs + axum/actix/rocket `#[route(…)]` forms |

(evidence: PROTOCOL.md resolution tables fixed by K-018 — python :226-232, go :194-212, rust :204-208, roslyn :202-208; `wiki/decisions.md:44`; code at `worker.py:606-834`, `analyze.go:586-703`, `analyzer.rs:435-563`, `WorkerAnalyzer.cs:1050-1490`, `analyzer.ts:1035-1129`.)

Three nuances keep this honest: (1) Go declares `SymbolResolution:false` while the others declare true — the truthful context is surface labels plus rationales ("syn has no semantic resolver", rust PROTOCOL.md:188). (2) C#'s surface shows `frameworkLinkers: "none"` only because routeDetection deliberately never entered the surface contract; the real declaration is `aspnetcore-controller-attribute-and-minimal-api-call-pattern` (`Protocol.cs:234`). (3) `coverageRatio` = verified/total edges everywhere; C# counts out-of-set checker-backed calls as verified (roslyn PROTOCOL.md:125-128). Also recorded: `wiki/sprint-8.md:4` loosely says Go "L2+L3" and Rust "L1.5/L3", but the binding metadata refuses to fabricate an L2 for Go — `INDEXED_ADAPTERS` and the PROTOCOL.md tables are authoritative (`index.ts:158-162, 208, 219`). ROUTES_TO edges are **always verified + evidenced** in all five languages, because decorator→handler binding is syntactic (`worker.py:898-901`; `routes.go:14-17`; `analyzer.rs:618-650`; `analyzer.ts:1422`; `WorkerAnalyzer.cs:1476-1490`).

### 6.3 Degradation never kills the engine

If a worker is missing, crashes, times out, or returns malformed output, that adapter falls back to L0/L1 file-level nodes — `workerAvailable:false`, `partial`, `coverageRatio:0`, source-hashed File nodes kept, explicit warning, capabilities all false — and the other languages' analysis survives (`adapters/go/src/analyzer.ts:398-434` and equivalents; `index-service.ts:1119-1122`). The synchronous bridge never spawns workers and publishes L0 File nodes with a `sync-run-degraded` fingerprint (`index-service.ts:114-122, 957-998`). In-file syntax errors are diagnostics, not failures: a broken file yields a lone File node while healthy files' graph persists (`python PROTOCOL.md:339-341`) — verified live with a broken+ok fixture (exit 0, `partial`, `SyntaxError` at line 1, both File nodes present).

### 6.4 Worked example: hand it a Python project

Given the `examples/fixture-python-app` fixture (three files) — **run live** in the analysis session:

1. A host calls `causoryn_refresh_index`; `IndexService` authorizes the root, collects inventory, and spawns the worker as the literal command `python -I -B native/python-worker/worker.py` (fixed args; `-B` disables `__pycache__` writes) (`worker-process.ts:19-23`).
2. The worker parses each file with stdlib `ast`. A decorator like `@app.get("/x")` yields an Endpoint node plus a **verified** ROUTES_TO edge; same-module calls get **verified** CALLS; imported symbols get **heuristic** CALLS with ambiguity notes; unknown names become UnknownExternal nodes with **unresolved** edges — never fabricated targets (`python PROTOCOL.md:226-232`; `worker.py:606-834`).
3. Live result: exit 0, `ready`, 21 nodes (3 File / 1 Class / 8 Function / 2 Method / 2 Endpoint / 5 UnknownExternal), 25 edges (11 CONTAINS verified, 3 CALLS verified, 4 heuristic, 5 unresolved, 2 ROUTES_TO verified), coverageRatio 0.64 — matching `docs/implementation-status.md:28` digit for digit.
4. If a toolchain is absent, the same flow degrades gracefully — demonstrated for real: a vitest run with `dotnet` missing from PATH saw the C# adapter fall to L0/L1 with an explicit warning while the other four languages produced full layers, the snapshot published as `partial`, and the engine stayed up; with toolchains restored it went 9/9 green (two runs of `npx vitest run packages/indexing/test/index-service-multilang.test.ts`: 3F/6P, then 9/9 in 55.97 s).

## 7. Security Model

Red lines: no LLM/embedding dependency; workspace read-only; writes only to user-declared output/data roots; stdout carries MCP protocol only (logs to stderr); no empty stub tools (`wiki/overview.md:7-23`).

**WorkspaceAccessPolicy** applies a fixed six-step decision order: (1) root authorization against config-declared allowRoots only — an MCP request cannot add a root (realpath canonicalized); (2) null-byte rejection; (3) lexical `..`/absolute-path traversal rejection; (4) ignore rules including ancestors; (5) realpath symlink/junction escape rejection (CWE-59); (5b) ignore rules re-applied to the canonical real path so an in-root symlink cannot bypass the secret-deny list; (6) extension filter + max file size (`workspace-access-policy.ts:17-33, 135-168, 171-252`). **OutputAccessPolicy is deliberately separate**: read roots and write directories are declared independently, and writes land only in declared output directories under the same realpath containment check (`output-policy.ts:11-15, 27-48`).

**Worker spawn security**: every sidecar launches a literal command with fixed arguments and an environment allowlist — `python -I -B <script>`; `go run ./cmd/worker` (or a configured binary; 120 s default timeout for cold compiles); literal `cargo` build for Rust, with an honest distinction when the binary lands elsewhere; `dotnet exec <dll>` for C#. No shell interpolation anywhere (`worker-process.ts` per language; `adapters/rust/src/analyzer.ts:153-198`).

The TŞ §22 security matrix is recorded **9/9 PASS** (`docs/security-pass.md:21-31`) — symlink/path traversal, secret leakage, symlink TOCTOU, poisoned source comments, oversized files, malicious Git refs, network denied, offline HTML XSS/CSP, stdout discipline — with "0 failed, 0 not run" (:33) and reproducible commands (:44-65). Re-run live: `npx vitest run tests/security-release/` → **36/36 passed**, 15.04 s, exit 0.

## 8. Quality and Tests

**Organization**: 77 `*.test.ts` files on disk (56 under `packages/*/test`, 6 adapters, 3 integrations, 12 under `tests/`); the default suite runs 76 files, excluding `tests/bench-release/**`, which runs separately because bench tests are flaky-prone under parallel 30 s deadlines (`vitest.config.ts:9-25`; `vitest.bench.config.ts:13`).

**Gates run green this session**:

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 |
| build | `npm run build` | exit 0 |
| lint | `npm run lint` | exit 0, zero violations (~30 min on this machine) |
| security | `npx vitest run tests/security-release/` | 36/36, 15.04 s |
| benchmark | `npm run bench` | 8/8, 101.76 s (docs not written — env flag unset, ADR-008 read-only discipline) |

**Full-suite flakiness — reported honestly.** Two full runs produced *different* failures, all timeout-class: run 1 → 11 failed / 1,413 passed (8 files red); run 2 (`npm run test`, exit 1) → 3 failed / 1,421 passed (csharp-roslyn, python-adapter, timeline). Isolated reruns of the red files passed 6/7 (101/103 tests); `faz-c-tools.test.ts` passed 26/26 alone — the same tests that time out under suite load. `docs/implementation-status.md:31` records a fully green 76-file/1,424-test run the same day after a clean `npm ci`; this session could **not** reproduce fully green (1,425 total — a one-test drift). Verdict per ADR-010: **no systemic breakage; load-sensitive timeout flakiness in the parallel suite** — an item not yet in docs (recommended for the backlog). One test is deliberately skipped (`graph/test/compare.test.ts:720`, documented since Sprint 7). `tests/cross-boundary.test.ts` defines gate criteria — two languages merging into one snapshot without dangling edges, `span.sourceHash = sha256(disk content)`, identical canonical JSON from independent installs, worker-less L0/L1 survival — read, but not run, this session (:1-38).

**Benchmarks** (`docs/benchmarks.md:18-22`, re-confirmed live 8/8): medians **11.8 / 13.0 / 10.7 ms** for `workspace_summary` / `get_symbol_context` / `map_system` (200-node) — roughly 80–180× under the TŞ §21 targets (<1000/<500/<2000 ms), which the doc correctly labels as reference targets, not achieved results (:3); cold index 16,370 ms on the 1,000-file fixture.

**Supply chain**: `npm audit --json` → **9 moderate**, 0 high/critical; single root `minimatch 7.0.0–11.0.0` (glob-parts amplification) via the eslint dev toolchain only — the runtime bundle is clean per static and behavioral scans (`security-pass.md:24, 29`). Honest drift: `implementation-status.md:441` records "10 moderate"; the current measure is 9 (version drift, same root). `npm audit fix --force` was **not** applied — it would downgrade eslint to v4; the item stays open for the 1.0.0 gate (`CHANGELOG.md:23`).

**Known limits** (`implementation-status.md:107-120`): Windows x64 validation only; Antigravity install/smoke not run (no `agy` CLI); MCP SDK pinned at 1.32.2 (v1.x); `refresh_index mode=incremental` explicitly declined; watcher not an MCP tool; no dedicated secret-scan script; rate-limit/concurrency out of scope (K-010); no real-browser visualizer run; bundle `.d.ts` fidelity partial.

## 9. Decision Records (K-001..K-018, selected)

All decisions live in `wiki/decisions.md` (K-001..K-007 at :27-33; K-008..K-012 at :34-38; K-013..K-016 at :39-42; K-017 at :43; K-018 at :44):

| ID | Decision |
|---|---|
| K-001 | Karpathy LLM Wiki pattern adopted as development methodology |
| K-002/K-005/K-006 | ZCode added as fourth host; `raw/context-inject` library (downloaded files are untrusted data: read, never execute); standard skill set `/workflow` + superpowers |
| K-003 | 1.0 scope re-sequenced vertical-slice-first — deferral, not cancellation |
| K-004 | Runtime behavior fixed: Agent Team Dispatch + 10-step DEVELOPMENT_FLOW (no passing tests by deletion; an unrun check never counts as passed) |
| K-007 | "Development Rules" section of the raw source voided by explicit user decision |
| K-008/K-011 | Error-code extensions `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND`; `SYMBOL_NOT_FOUND` added later, still ADR-uncovered |
| K-009 | MCP SDK divergence accepted (1.32.2, v1.x, vs TŞ "SDK v2" target) |
| K-010 | Rate-limit/concurrency out of Phase A scope |
| K-012 | Phase D added no fourth extension — existing `EXPORT_NOT_ALLOWED` sufficed (no suitable code ⇒ no invention) |
| K-013/K-014 | Wiki questions fixed: states building/ready/partial/failed; opaque cursor 50/200; broken links preserved as data + diagnostics, not errors; alias failures → `INVALID_REVISION` |
| K-015/K-016 | `CONTRACT_PARSE_FAILED` first use; SQL RENAME → `unknown`; verify verdict priority chain; byte-deterministic evidence ordering; "passed count = host claim, core reads no files" |
| K-017 | **0.1.0 public snapshot, explicitly not 1.0.0** — three gates unmet; bundle honestly "mcp-server.mjs + vendored better-sqlite3", not single-file; 4-host matrix approved; TOOL_NAMES locked at 29 |
| K-018 | Per-language resolution labels fixed by PROTOCOL.md tables; two inaccurate orchestrator claims corrected on disk (Go pkg-qualified = heuristic, not verified; Rust not wholly heuristic), deviation explicitly logged |

## 10. Status and Version

`CHANGELOG.md:25` titles `[0.1.0] - 2026-11-09` "public snapshot — not 1.0.0". Git holds annotated tag `v0.1.0` ("7-sprint plan complete (ADR-010: 1.0.0 gates deferred)") at `4c9c188` (PR #13); HEAD is `5d6357c` (PR #14, Sprint 8) (`git show v0.1.0 --no-patch`). Sprint trajectory, showing suite growth:

| Sprint | Phase | Status | Tests |
|---|---|---|---|
| 1 | A | 11/11 Done | 247 |
| 2 | B | 7/8 — B7 Live Architecture **Partial** | 419 |
| 3 | C | 8/8 | 634 |
| 4 | C2 Living Wiki | 8/8 | 800 |
| 5 | D | 7/7 — 28 tools | 1,024 |
| 6 | E | 6/6 — **29 tools, core catalog complete** | 1,116 |
| 7 | F | 9/9 — `v0.1.0` tagged, 7-sprint plan complete | 1,266 |
| 8 | unplanned multi-language expansion | 4/4 — Python/Go/Rust sidecars | 1,424 |

(evidence: `wiki/sprint-1.md:4` through `sprint-8.md:4`.) The project wiki is 18 files — index, overview, scope, architecture, mcp-tools, roadmap, working-model, decisions, sprint-1..8, append-only log — mapped in `wiki/index.md:5-27`; host guides live in `docs/hosts/` (claude-code, codex, antigravity) and `integrations/zcode/causoryn/README.md`, verified on disk.

**Host support** (`docs/compatibility-matrix.md:23-26, 39-47`): Claude Code ✔ real end-to-end handshake (CLI 2.1.322, `claude mcp list → ✔ Connected`; verified 2026-11-08 and 2026-11-10); Codex ✔ add→list→remove (CLI 0.163.0 — honestly noted: list performs no health check); ZCode ⚠ manifest-level validation only (GUI install deliberately not performed, red line 6); Antigravity ❌ NOT RUN (no `agy` CLI). Net: **2/3 real runs, 1/3 open**. All runs to date are Windows 10.0.26300 x64; every host runs the same bundle (`dist/mcp-server.mjs` + vendored better-sqlite3), engine id `causoryn@0.1.0`, stdio transport.

**Open 1.0.0 gates** (`CHANGELOG.md:7-23`, held open per ADR-010): Antigravity install+smoke; ZCode in-GUI smoke; macOS/Linux/ARM validation; MCP SDK v1→v2 (closes K-009); `refresh_index mode=incremental`; TS/C# TESTS edges; OpenAPI drift; `wiki_search` filters; E6 browser run; bundle `.d.ts` fidelity; rate-limit budget; npm audit moderates. Until these close, 1.0.0 will not be declared.

**Overall assessment (ADR-010 discipline)**: the engine surface is solid — five gates ran green in-session, the security matrix is 9/9 with live re-verification, degradation is demonstrably graceful end to end, and the honesty mechanisms (resolution labels, the evidence requirement, immutable snapshots, explicit `partial` statuses) are enforced in code, not asserted in prose. The one new quality item this session surfaced — timeout-class parallel-suite flakiness, green in isolation — is reported here and recommended for the backlog. Everything not yet true is labeled as such; that is the project's defining discipline.
