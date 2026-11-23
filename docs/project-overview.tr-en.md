# Causoryn — Proje Dokümanı / Project Document (TR · EN)

---

# Causoryn — Kapsamlı Proje Dokümanı (v0.2.2 Pre-1.0 Public Preview)

> Kanıt temeli: `v0.2.2` Pre-1.0 Public Preview kaynak ağacı. Sürüm çizgisi `K-022` açık kaynak yayınından (`v0.2.0`) `v0.2.1` çalışma zamanı iyileştirmelerine ve `K-023` görsel mimari dışa aktarımına uzanır. Sürüm tarihleri ve önceki koşum kayıtları için [değişiklik günlüğü](../CHANGELOG.md) ve [uygulama durumu](implementation-status.md).

## 1. Yönetici Özeti

Causoryn, repository kodunu **Unified Evidence & Knowledge Graph**'a dönüştüren, **model bağımsız ve LLM çalıştırmayan** yerel stdio MCP motorudur. Motor ve paketlenen runtime LLM, embedding ve model API'si kullanmaz. İsteğe bağlı `architecture-blueprint` akışında host modeli anlatı hazırlayabilir ve bunu `causoryn_export_documentation` aracına `annotations` olarak iletebilir. Causoryn bu veriyi şema ve snapshot referanslarına göre doğrular, ardından sabit dışa aktarım kurallarıyla işler. [ADR-002](adr/ADR-002-no-llm.md) · [Architecture Blueprint skill](../skills/architecture-blueprint/SKILL.md)

`SERVER_VERSION="0.2.2"`, `SCHEMA_VERSION="2.0"` ve **29 MCP aracı** vardır. Beş dil adapter'ından TypeScript süreç içinde, C# / Python / Go / Rust ortak `@causoryn/sidecar-ipc` üzerinden çalışır. Depoda Vitest'in varsayılan kapsamına giren 92 test dosyası ve ayrı bir benchmark test dosyası bulunur. Açık 1.0.0 kapıları ve koşum kanıtı §8–§10'da kayıtlıdır. [Araç kataloğu](../packages/mcp-server/src/version.ts) · [Adapter kataloğu](../packages/indexing/src/index.ts) · [Test kapsamı](../vitest.config.ts)

## 2. Çözülen Problem: AI Ajanlarının Kör Kodlaması

Kodlama ajanı bir sembolü, çağrı zincirini veya değişikliğin etkisini incelemek için graph ve evidence kayıtlarını sorgulayabilir. `verified` kenarlar en az bir evidence kaydına bağlıdır. Kaynak span'ı olan kayıt `relativePath`, satır aralığı ve `sourceHash` taşır. Her ilişki `verified`, `heuristic` veya `unresolved` etiketi taşır. Örneğin Python adapter'ı import üzerinden tahmin ettiği çağrıyı `heuristic`, çözemediği çağrıyı `UnknownExternal` hedefli `unresolved` olarak gösterir. [Graph şeması](../packages/domain/src/graph-schema.ts) · [Python protokolü](../native/python-worker/PROTOCOL.md)

## 3. Ürün Döngüsü

Döngü **Discover → Preflight → Agent Edits → Verify → Explain**'dir (kanıt: `wiki/overview.md:7-23`):

| Adım | Causoryn'in rolü | Temsilci araçlar | Yazar mı? |
|---|---|---|---|
| Discover | Kanıtlı mimari/sembol bağlamı | `map_system`, `trace_execution`/`trace_business_flow`, `get_symbol_context`, `analyze_impact`, `get_agent_context` | Hayır |
| Preflight | Aday manifest + mimari/kontrat denetimi | `preflight_change` (candidateOnly, kod yazmaz), `check_architecture`, `check_contracts` | Hayır |
| Agent Edits | Düzenleme host modelde; Causoryn katılmaz | — | Hayır |
| Verify | Çalışma ağacını dört denetimde doğrular; test ÇALIŞTIRMAZ | `verify_change`, `derive_test_plan`, `detect_contract_drift` | Hayır |
| Explain | Kanıt zinciri, Living Wiki ve mimari dışa aktarım | `get_evidence`, `wiki_*`, `export_documentation`, `compare_architecture` | `wiki_build` yetkili wiki deposuna, `export_documentation` `output.allowedOutputDirs` ile yetkilendirilmiş dizine |

Kalıcı hafıza **Living Wiki**'dir: 18 çekirdek özelliğin yerine geçmez, çapraz kesen #19 katmanıdır, 7 araçla sunulur (kanıt: `wiki/scope.md:5-37`; `wiki/mcp-tools.md:36-38`).

## 4. Mimari

### 4.1 Pipeline

Yerel analiz yolu **Workspace Gateway → File Inventory → Language/Framework Adapters → Normalization → Symbol/Contract Resolution → Unified Evidence Graph → Immutable Snapshot → Domain Queries → MCP structuredContent** sırasını izler. Host modeli MCP istemcisi tarafında çalışır. Mimari arka plan `docs/architecture.md:13-22` bölümünde açıklanır.

### 4.2 Paketler ve bağımlılık sınırları

Monorepo **18 npm workspace paketi** (`12 packages/*` + `5 adapters/*` + `1 integrations/zcode/causoryn`), standalone `apps/visualizer`, 4 `native/*` sidecar (`native/roslyn-worker` deterministik Release derlemeli, `native/python-worker`, `native/go-worker`, `native/rust-worker`), kök 4-host açık kaynak pazaryeri manifestleri + `npx causoryn setup` / `causoryn doctor` CLI dağıtımı (`THIRD-PARTY-NOTICES.md` + `licenses/` dahil), 3-OS SHA-sabitli `.github/workflows/ci.yml` ve OIDC `.github/workflows/release.yml` iş akışları, `integrations/antigravity/causoryn` eklenti dizini ve 8 `examples/*` fixture'dan oluşur (`package.json:12-16`; `docs/architecture.md:26-63`):

| Paket (`packages/*`) | Sorumluluk |
|---|---|
| `domain` | Graph/Evidence sözleşmeleri, Zod şemaları, canonical JSON, deterministik ID |
| `sidecar-ipc` | Ortak sidecar IPC çekirdeği: NDJSON framing, timeout, stdout/stderr bütçesi, allowlist env, dinamik varlık kökü |
| `workspace` | Gateway: trusted roots, inventory, ignore, symlink escape, OutputAccessPolicy |
| `indexing` | IndexCoordinator 5-dil orkestrasyonu (`INDEXED_ADAPTERS`) + `symbol_fts` besleme + çoklu-süreç yarış kurtarması |
| `graph` | Snapshot sorguları, traversal/impact/guard/compare, mimari projeksiyon ve `snapshot` dahil dışa aktarım, salt-okunur `git-read.ts` |
| `storage-sqlite` | SQLite+FTS5 store (`SqliteGraphRepository` + `WikiStore`) |
| `contracts` | Salt-okunur sözleşme keşfi |
| `preflight` | Candidate-only manifest; kod yazmaz |
| `verification` | `verify_change` saf çekirdeği |
| `wiki` | GraphSnapshot→WikiSnapshot projeksiyonu |
| `mcp-server` | stdio + sıfır-ayar `--allow-cwd` / MCP `roots/list` / `--auto-data-dir` (hassas/sistem dizin reddi) + `storage.dataDbPath` / `InMemoryGraphRepository` + 29 araç + MCP `annotations` (`readOnlyHint`) |
| `causoryn` | Açık kaynak çoklu-host CLI (`causoryn setup\|doctor\|mcp`) ve 4-host plugin dağıtım paketi (`0.2.2`, `MIT`, `THIRD-PARTY-NOTICES.md`, sıfır dış npm bağımlılığı) |

`typescript` 5.9.3 derleyicisi ve `esbuild` bundle üreticisi paket manifestinde tanımlıdır. [Kök manifest](../package.json) · [Mimari](architecture.md)

Üç sınır komutla doğrulandı: (1) `domain` **yaprak pakettir** — tüm import'lar kendi modülleri + `zod` (tek dep); (2) `workspace` yalnızca node built-in + zod; (3) parser detayı mcp-server'a sızmaz — `@causoryn/adapter-*` import edilmez, erişim yalnız `@causoryn/indexing`'den; tek "adapter" geçişi `INDEXED_ADAPTERS` metadata'sıdır (kanıt: `grep "^import"` domain/workspace çıktıları; `grep "from \"@causoryn/\"` mcp-server — adapter girdisi yok). `verification` saf fonksiyon disiplinindedir: `grep "node:fs\|Date\|Math.random" packages/verification/src` boş; fs/saat/rastgelelik okumaz, test koşucusu çalıştırmaz, `observed` yalnızca kanıtla kabul edilir (kanıt: grep çıktısı; `verify-change.ts` sözleşmesi).

### 4.3 Evidence modeli ve deterministik kimlik

`Evidence = {id, kind, span?, analyzerId, analyzerVersion, rationale}`; `SourceSpan = {relativePath, startLine≥1, endLine≥startLine, sourceHash}`; indexing her File node'a `inventory` evidence'lı verified CONTAINS kenarı ekler, envanter dışı path `indexing/internal` ile reddedilir (kanıt: `graph-schema.ts:35-56`; `index-service.ts:281-298`). `verified` kenar ≥1 evidence invariant'ı **üç katmanda** zorlanır: kurucu `domain/verified-edge-requires-evidence` hatası, `superRefine` şema reddi ve repository doğrulaması; `heuristic/unresolved` kanıtsız kalabilir (bilinçli tasarım). Snapshot invariant'ları (dangling edge, duplicate ID, bilinmeyen evidence) kurucu+şema+repository'de denetlenir; her node/edge/evidence kimliği depo girişinde yeniden hesaplanır ve ID uyuşmazlığı `graph/*-id-mismatch` reddidir (kanıt: `ids.ts:163-189`; `graph-schema.ts:84-93,119-186`; `validation.ts:23-27,116-156,212-227`).

ID'ler canonical JSON + SHA-256'dır: node `(workspaceId, kind, qualifiedName, relativePath|null)`, edge `(workspaceId, kind, from, to)`, evidence `[workspaceId, kind, analyzerId, analyzerVersion, rationale, span|null]` (`ids.ts:147-161`); snapshot ID `SHA-256(canonical JSON([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))` (`snapshot.ts:379-397`) — **saat ID'ye girmez**, `clock: () => string` enjekte edilir, duvar saati `meta.createdAt` alanında (`context.ts:133`) taşınır (kanıt: `ids.ts:14-50,92-161`; `snapshot.ts:22-35,287-295,379-397,429`; `index-service.ts:209`). Nüans: aynı `IndexService` sürecinde ardışık `refresh_index` çağrıları `revision.sequence` (`this.runCount + 1`, `index-service.ts:856,1073`) artışıyla yeni `snapshotId` üretir; bağımsız taze süreçlerde aynı içerik ve aynı `sequence` birebir aynı `snapshotId` üretir. Sonuç `deepFreeze` ile dondurulmuş immutable snapshot'tır (ADR-005); diziler ID'ye göre kanonik sırada tutulur.

Deterministik yeniden üretim, aynı kaynak içeriğini ve revision kimliğini/sırasını, eşdeğer workspace kimliğini, etkin envanter kurallarını, analizör araç zincirini ve yapılandırmayı gerektirir. Çıktıyı yeniden üretirken aynı snapshot ve seçenekleri kullan. `meta.createdAt`, çağrıya ait `requestId`, ilk indeksin ilerleyişi ve worker erişilebilirliği çalışma durumuna göre değişebilir. `meta.createdAt` snapshot kimliğine girmese de bazı dışa aktarım formatlarına yazılır. [Snapshot kimliği](../packages/domain/src/snapshot.ts) · [Mimari dışa aktarım](../packages/graph/src/architecture-export.ts) · [MCP çağrısı](../packages/mcp-server/src/server.ts)

### 4.4 Depolama ve yayın disiplini

SQLite: `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`; `symbol_fts`+`wiki_fts` FTS5 araması embedding'siz; şema `user_version=2`, DDL tek statik literal, veri parametreli (kanıt: `sqlite-repository.ts:150-153`; `schema.ts:24-38`). Yayın atomiktir: `beginBuild` `building` açar, building satırları hiçbir okuma yolunda çözülemez; `publish` tek transaction'da `ready|partial` yapar; `failed` build akışa girmez; yayımsız okuma `storage/corrupt-row` reddidir (kanıt: `repository.ts:15-25`; `sqlite-repository.ts:41-46,447-484`). Stale iki koşulludur: daha yeni yayın var ya da `revision_sequence >=` building build aktifse `stale=true` (kanıt: `sqlite-repository.ts:877-901,517-533`).

IndexService yetkilendirme, envanter, adapter analizi, graph birleştirme ve atomik yayın sırasını uygular. Artımlı indeksleme analiz için anlamlı değişiklik bulunmadığında mevcut graph'ı korur ve envanteri uzlaştırır. `v0.2.1` ile CLI/plugin yolunda ilk indeksleme MCP `initialized` bildiriminden sonra arka planda başlar. Sıfır ayarlı workspace yapılandırması güvenli kök `.gitignore` desenlerini `extraIgnore` ile birleştirir. Ortak pathless dış düğümler birleştirilir ve SQLite toplu yazımında konum sayaçları kullanılır. `v0.2.2` en fazla dört yayımlanmış graph'ı `PRAGMA data_version` korumalı önbellekte tutar. `causoryn doctor` sürümü paket manifestinden okur. [Başlangıç akışı](../packages/mcp-server/src/cli-stdio.ts) · [Workspace yapılandırması](../packages/mcp-server/src/runtime-cli.ts) · [IndexService](../packages/indexing/src/index-service.ts) · [SQLite deposu](../packages/storage-sqlite/src/sqlite-repository.ts) · [Doctor sürümü](../packages/causoryn/src/types.ts)

## 5. MCP Araç Kataloğu

`tools/list` TAM OLARAK 29 araç sunar (`SERVER_VERSION = "0.2.2"`, `SCHEMA_VERSION = "2.0"`; `version.ts:10-13,36-66`); boş handler yayınlanmaz (ADR-010). Aşağıdaki `7+6+3+3+3+7=29` dağılımı, TŞ'nin `22 çekirdek + 7 wiki = 29` resmi kataloğu (`wiki/mcp-tools.md:1`, `docs/tool-contracts.md:45,72`) üzerindeki tematik özet görünümdür; ayrıca 29 aracın tamamı `server.ts:154-164,555` üzerinden yapısal MCP `annotations` (`readOnlyHint`: 3 yazan araçta `false`, 26 salt-okunur araçta `true`; `destructiveHint: false`; `openWorldHint: false`) beyan eder:

| Grup | Adet | Araçlar |
|---|---|---|
| Keşif & indeks | 7 | `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index`, `find_symbols`, `get_symbol_context`, `get_evidence` |
| Mimari | 6 | `map_system`, `trace_execution`, `trace_business_flow`, `analyze_impact`, `compare_architecture`, `architecture_timeline` |
| Gezinti/rapor | 3 | `get_agent_context`, `generate_onboarding`, `export_documentation` (json/markdown/mermaid/html/snapshot) |
| Kontratlar | 3 | `check_contracts`, `detect_contract_drift`, `derive_test_plan` (test ÇALIŞTIRILMAZ) |
| Guard | 3 | `check_architecture` (bulgu raporlar, CI kararı vermez), `preflight_change`, `verify_change` |
| Wiki | 7 | `wiki_build` (yazan TEK wiki aracı) + salt-okunur `wiki_get_tree`, `wiki_get_page`, `wiki_search` (FTS5, embedding yok), `wiki_get_links`, `wiki_get_versions`, `wiki_diff` |

**Envelope**: 10 alanlı `z.strictObject` — `schemaVersion` (`SCHEMA_VERSION="2.0"`), `requestId`, `workspaceId`, `snapshotId`, `status(ok|partial|error)`, `coverage(tier L0-L4 + coverageRatio 0-1)`, `warnings`, `data`, `nextCursor`, `error`; tümü her yanıtta mevcuttur (kanıt: `envelope.ts:24-55,84-105`). Envelope hataları `isError=false` structuredContent ile taşınır (statü sözleşmesi, protokol hatası değil); stack trace sonuca girmez, beklenmeyen hata `INTERNAL_ERROR`+requestId ile döner, detay yalnızca stderr'de; `AMBIGUOUS_SYMBOL` yolunda `data` aday listesi taşır (kanıt: `server.ts:135-137,566-592`; TŞ §10.3).

**Hata kodları**: 15 sabit kod; kod→(retryable, userAction) eşlemesi `TOOL_ERROR_GUIDANCE`'da deterministiktir. `retryable=true` yalnız 2 kodda: `INDEX_NOT_READY`, `INTERNAL_ERROR`; öteki 13 `retryable:false`. Uzantı ve rezerve kod dürüstlüğü: `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND` ve `SYMBOL_NOT_FOUND` TŞ §10.1 taban listesinde olmayan üç proje uzantısıdır — ilk ikisi `K-008` ile, `SYMBOL_NOT_FOUND` ise `K-011` (`wiki/decisions.md:37`, `errors.ts:62-64`) ile karara bağlanmıştır; beş kod (`POLICY_INVALID`, `INVALID_REVISION`, `EXPORT_NOT_ALLOWED`, `WIKI_PAGE_NOT_FOUND`, `CONTRACT_PARSE_FAILED`) TŞ §10.1 sabit listesinden seçildi, Faz C'de dördüncü uzantı kodu basılmadı (`K-012`); `UNSUPPORTED_LANGUAGE` ise TŞ §10.1 sabit listesinden korunan **rezerve sabit kod**dur (adapter L0/L1 fallback mekanizması nedeniyle mevcut servislerce fırlatılmaz; `errors.ts:66-68`).

**Yazma matrisi** — 3 araç `readOnlyHint: false` ile yazar, 26 araç `readOnlyHint: true` ile salt-okunurdur (kanıt: `wiki/mcp-tools.md:42-45`; `server.ts:154-164,365,402`):

| Araç / Bileşen | Hedef | Sınır ve süreç-içi/başlangıç nüansı |
|---|---|---|
| `refresh_index` (`readOnlyHint: false`) | Yalnızca Causoryn indeksi | `allowRoots[0]` salt-okunur taranır (`mode: full\|incremental`); varsayılan stdio kablolamasında süreç-içi `InMemoryGraphRepository` veya beyan edilmişse `storage.dataDbPath` (`SqliteGraphRepository`, `allowRoots` dışında; `context.ts:139-185`); Rust/Go sidecar'ları ilk derlemede kendi toolchain `target`/cache dizinlerini kullanabilir |
| `export_documentation` (`readOnlyHint: false`) | `output.allowedOutputDirs` | Boş liste `EXPORT_NOT_ALLOWED` döndürür. Yazım atomiktir (`.tmp` + rename). `format="snapshot"` canonical `architecture-snapshot.json` üretir. Diğer formatlarda `view` varsayılan olarak `architecture` olur. |
| `wiki_build` (`readOnlyHint: false`) | `wiki.dataDbPath` | Mutlak yol zorunlu, `allowRoots` İÇİNDE olamaz (symlink-kaçışlı; ADR-008); beyansız `PATH_DENIED`; ayrıca sunucu başlangıcında `openWikiStores` (`context.ts:449-541`) tanımlı `wiki.dataDbPath` üzerinde tekil workspace satırını ilklendirir (`services-wiki.ts:136-145`) |
| `preflight_change` (`readOnlyHint: true`) | Diske/kaynak ağaca yazmaz | `candidateOnly` sabit `true`; üretilen manifest `verify_change(preflightId)` çözümü için yalnızca süreç-içi `PreflightManifestStore` belleğinde (FIFO tavan 200; `preflight-store.ts:38-66`) tutulur |

**Mimari dışa aktarım.** `view="architecture"` JSON blueprint, alt gruplu Mermaid, Markdown brief ve sıfır JavaScript'li katmanlı SVG içeren offline HTML üretir. `view="interactive"` HTML için çevrimdışı arama, yakınlaştırma ve kanıt paneli sunar. `view="full"` ham graph dökümünü korur. `format="snapshot"`, varsayılan veya `full` görünümle ham `CompareContentSet` üretir. `view="wiki"` ve geçersiz görünüm, format veya anotasyon kombinasyonları `INVALID_ARGUMENT` döndürür. `options` ve `annotations`, yalnızca `architecture` ve `interactive` görünümlerinde kullanılır. İsteğe bağlı `annotations` eklenmedikçe çıktı graph verisinden türetilir. Sağlanan referansların (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`) ve şema sınırlarının doğrulanması dışarıdan gelen anlatının doğruluğunu garanti etmez. Aynı snapshot, format, görünüm, seçenekler ve geçerli anotasyon girdisi dışa aktarım baytlarını sabitler. [Araç sözleşmesi](tool-contracts.md) · [Dışa aktarım testleri](../packages/graph/test/architecture-export.test.ts)

**Cursor/limit**: cursor opak sürümlü codec (`{v:1,o:<int>}` → base64url); bozuk cursor → null → `INVALID_ARGUMENT`; `nextCursor` son sayfada null ve envelope-düzeyi = `data.nextCursor` (kanıt: `cursor.ts:13-41`; `services-wiki.ts:102-105,210-220`). Limitler: `map_system` maxNodes 250, `find_symbols` 100, wiki default 50/tavan 200 (`K-013`), aşım `LIMIT_EXCEEDED`; `maxDepth`=3, `maxPaths`=50 (kanıt: `services.ts:772-778,932-938`; `config.ts:26-37`).

## 6. Dil Desteği

### 6.1 İki eksen, beş adapter

"L0-L4" iki eksendir: (1) **adapter yetenek ekseni** — L0 dosya/manifest → L4 flow/contract cross-link; ilk hedef TS L2 + seçili Next.js/Express L3 (`wiki/scope.md:37`); (2) **harita hiyerarşisi** (TŞ §16) — L0 Workspace → L3 Function/Endpoint/Test; L4 akış haritası Faz A'da açık ret (`services.ts:698-716,765-771`). Bu bölüm birincisidir. TypeScript süreç-içidir (Compiler API: Program+AST+TypeChecker + BDD `Test`/`TESTS` çıkarımı; `analyzer.ts`); öteki dört dil sidecar'dır (`@causoryn/sidecar-ipc` üzerinden): python saf stdlib `ast`, go `go/parser`, rust syn 3, csharp Roslyn (`dotnet exec`). `INDEXED_ADAPTERS` 5 kayıt tutar (`index.ts:168-224`); `get_capabilities` bu diziden `source` alanını dışarıda bırakarak `{language, analyzerId, version, levels}` projeksiyonunu döndürür (`services.ts:246-257,300-309`). Çok-dilli özet katmanı da 5 dili kapsar: `workspace_summary.languages` tüm `File` node'larının dil dağılımını `INDEXED_ADAPTERS` sırasıyla sayar (`services.ts:362-387`); `coverageOf.tier` ise TS/C#/Python AST/sembol node'u varsa `L2`, yalnız Go/Rust AST/sembol node'u varsa `L1`, hiç sembol/AST node'u yoksa `L0` hesaplar (`services.ts:138-190`):

| Dil | Motor | Resolution beyanı | L3 route |
|---|---|---|---|
| TypeScript | TS Compiler API (in-process) | L2 (TypeChecker verified) | `<x>.<verb>` kalıbı + express linker + Next.js App Router kuralı |
| C# | Roslyn semantic model | L2 — tek gerçek semantik sidecar | HttpGet/… fiilleri + MapGet/… minimal API |
| Python | stdlib `ast` | L2 + "tam type inference YOK" | `@carrier.get/…` + Flask `route` |
| Go | stdlib `go/parser` | "heuristic-only (semantik L2 yok)", `SymbolResolution:false` | Handle/HandleFunc + chi/gin/echo |
| Rust | syn 3 | "heuristic-heavy" | attribute-macro: 9 fiil + axum/actix/rocket |

(kanıt: `index.ts:158-162` "'L2' UYDURULMAZ, dürüst etiket yazılır" + `:168-224`; go `main.go:79-86`)

### 6.2 Resolution dürüstlüğü (K-018)

`K-018` etiketleri dil başına `PROTOCOL.md` tablosuyla sabitler (`wiki/decisions.md:44`): **python** — `verified` yalnız aynı modül (`self.<m>`, `Sınıf.<m>` dahil); import edilen `heuristic`+ambiguity; tanımsız `unresolved`→UnknownExternal. **go** — `verified` yalnız aynı-package bare-ident (yerel değişken gölgelemesi AST'ten ayırt edilemez — belgeli); `pkg.Func`/benzersiz metot/arayüz metodu `heuristic`; builtin kenar ÜRETİLMEZ. **rust** — aynı modül bare ve tek-eşleşmeli nitelikli çağrı `verified` (modül önekleri tam doğrulanmaz — belgeli); metot çağrısı `heuristic` (trait dispatch yok). **csharp** — Roslyn semantic çözümlediği her çağrı (set içi/dışı) `verified`; bilinen-ad `heuristic`. `ROUTES_TO` kenarları **TS, Python ve Rust'ta daima `verified` + evidence**'lıdır (`adapters/typescript/src/analyzer.ts:1625-1669`; `native/python-worker/worker.py:898-901`; `native/rust-worker/src/analyzer.rs:618-650`); buna karşılık **C#'ta** controller/action öznitelik tipleri Roslyn semantic model ile `Microsoft.AspNetCore.Mvc` köküne çözülebildiğinde `verified`, çözülemediğinde bilinen-ad kuralıyla `heuristic` (+ `ambiguity`) üretilir (`native/roslyn-worker/WorkerAnalyzer.cs:1475-1508`); **Go'da** ise aynı-package tanımlı handler fonksiyonu `verified`, selector handler ifadesi `heuristic` veya `unresolved`, tanımsız çıplak handler adı `unresolved` (`UnknownExternal`) üretir, inline anonim `func` literal ise Endpoint'i koruyup kenar üretmez (`native/go-worker/internal/analyze/routes.go:120-170`, ayrıca `:103-109`).

Nüanslar: (1) `wiki/sprint-8.md:4` özeti `K-022` ile `Go L1/heuristic+L3 (semantik L2 yok)` olarak hizalandı; bağlayıcı tablo `INDEXED_ADAPTERS` + `PROTOCOL.md`'lerdir. (2) C#'ın L3'ü yüzeyde `frameworkLinkers: "aspnet-core-route-attributes (L3)"` olarak beyan edilir (`index.ts:187`, `K-022`); worker içi tam yetenek beyanı `aspnetcore-controller-attribute-and-minimal-api-call-pattern`'dir (`Protocol.cs:234`). (3) Sidecar worker protokol çıktılarındaki `coverageRatio` `verified / total` kenar oranıyken (`python PROTOCOL.md:141-142`; `go analyze.go:499-507`), MCP envelope `coverage.coverageRatio` alanı `(verified + heuristic) / totalEdges` (`resolvedEdges / totalEdges`, `packages/mcp-server/src/services.ts:156-190`) olarak hesaplanır; C#'ta set-dışı çağrılar checker dayanaklı `verified` sayılır (`roslyn PROTOCOL.md:125-128`). `K-018` ayrıca orkestratör brief'indeki iki hatalı ifadeyi (go pkg-qualified=verified; rust tamamen heuristic) disk gerçeğiyle düzeltip sapmayı kayda geçirdi.

### 6.3 Degrade katmanları

Üç düzey: (1) **adapter** — 4 sidecar'da özdeş fallback: `workerAvailable:false, state:"partial", coverageRatio:0`, sourceHash'li File node'ları korunur, yetenekler tümü false (kanıt: `adapters/go/src/analyzer.ts:395-431`; `types.ts:164-172`). (2) **toolchain** — spawn'lar literal komut + sabit args + env allowlist: python `python -B` (`-B` `__pycache__` yazımını kapatır; `PYTHONPATH` zaten env allowlist dışında tutulduğundan `-I` geçilmez — `adapters/python/src/worker-process.ts:7-9,52-58`; `adapters/python/src/types.ts:57-62`), go `go run ./cmd/worker` (timeout 120 sn), rust literal `cargo` (`adapters/rust/src/cargo.ts`; paketli modda `--locked` + yazılabilir `CARGO_TARGET_DIR` önbelleği; yoksa available=false + gerekçe), csharp `dotnet exec` (kanıt: `adapters/*/src/worker-process.ts`; `adapters/rust/src/analyzer.ts:163-268`). (3) **dosya/pipeline** — SyntaxError hata değil: `partial` + dosya+satır tanısı, sağlam dosyaların grafiği sürer (`python PROTOCOL.md:339-341`); canlı doğrulandı: broken.py+ok.py → exit 0, partial, `diagnostics[{code:"SyntaxError",line:1}]` (analist elle spawn, 2026-11-16).

Degradasyon uçtan uca kanıtlandı: `npx vitest run packages/indexing/test/index-service-multilang.test.ts` ilk koşumda `spawn dotnet ENOENT` → C# adapter L0/L1'e düştü (log: "L0/L1 dosya düzeyine düşüldü"), diğer 4 dil TAM üretildi, snapshot `partial` yayımlandı, motor ayaktaydı; PATH düzeltmesiyle 9/9 passed (kanıt: analist iki vitest koşumu, 55.97s).

### 6.4 Örnek senaryo: bir Python projesi verilirse ne olur?

Kullanıcı `examples/fixture-python-app`'i (3 dosya) allowRoot beyan edip `causoryn_refresh_index` çağırır. Akış: WorkspaceAccessPolicy yetkilendirir → envanter → adapter worker `python -B native/python-worker/worker.py` spawn'ı (`adapters/python/src/worker-process.ts:7-9,52-58`) → stdlib `ast` parse → tek build'e katma → `ready` publish. Analist bu koşumu bizzat çalıştırdı (kanıt: canlı çıktı, 2026-11-16; `docs/implementation-status.md` Sprint 8 kaydıyla birebir):

- **exit 0, ready** — 21 node (3 File, 1 Class, 8 Function, 2 Method, 2 Endpoint, 5 UnknownExternal), 25 edge (11 CONTAINS/verified, 3 CALLS/verified, 4 CALLS/heuristic, 5 CALLS/unresolved, 2 ROUTES_TO/verified), worker `coverageRatio` 0.64, capabilities `{astParse:true, symbolResolution:true, routeDetection:"python-decorator-route-pattern", frameworkLinkers:false}`.
- Kurallar `K-018` §1'e birebir uyar: `@app.get("/x")` → Endpoint + ROUTES_TO verified; aynı modül `helper()` → CALLS verified; `utils.run()` import'u → heuristic+ambiguity; çözülemeyen ad → UnknownExternal + unresolved — uydurma hedef yok.
- Host modeli `find_symbols`/`get_symbol_context` ile bağlamı, `get_evidence` ile span+sourceHash'li zinciri okur; `wiki_build` yalnız beyanlı dataDbPath'e yazar.
- Python hiç olmasaydı: spawn başarısız → L0/L1 düşüş, sourceHash'li File node'lar + warning ile `partial` publish; graph boş dönmez ama sembol katmanı yok olur — motor çökmez.

## 7. Güvenlik Modeli

**WorkspaceAccessPolicy** sabit 6 adımlıdır: (1) kök yetkilendirmesi — yalnız config beyanlı allowRoot'lar, realpath canonicalization ("MCP isteği tek başına kök ekleyemez", TŞ §9/§20); (2) null byte reddi; (3) leksik `..`/mutlak yol reddi; (4) ignore (atalar dahil); (5) realpath symlink/junction escape reddi (CWE-59); (5b) kanonik yola ignore yeniden uygulaması — symlink secret-deny bypass edemez; (6) uzantı + maxFileBytes (kanıt: `packages/workspace/src/workspace-access-policy.ts:17-33,135-252`). Sıfır-ayar CLI/IDE akışında (`--allow-cwd` ve MCP `roots/list`, `packages/mcp-server/src/runtime-cli.ts:428-560`) ek bir savunma derinliği filtresi `$HOME`, dosya sistemi kökleri (`/`, `C:\`), veri/eklenti kurulum dizinleri (`~/.causoryn`, `_npx`, `node_modules`), hassas kullanıcı dizinleri (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`) ve OS sistem dizinlerini (`/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `C:\Windows`, `C:\Program Files`, `C:\ProgramData`) proje kökü olarak reddeder; `--auto-data-dir` ise yetkili köklerin dışında `0o700` ve sarkan-symlink (CWE-59) kontrolüyle hazırlanır. Kaynak analizi salt okunurdur. Otomatik yapılandırma çıktı dizinini kaynak ağacı dışında oluşturur. Kullanıcı bir `output.allowedOutputDirs` dizinini açıkça tanımladığında export yetkisi bu liste ve realpath containment ile belirlenir (`output-policy.ts:11-48`).

Spawn ve tedarik zinciri güvenliği: 4 sidecar worker literal komut + sabit args + env allowlist (`python -B <script>`, `go run ./cmd/worker` veya binary, literal `cargo` + `causoryn-rust-worker`, `dotnet exec <dll>`), shell interpolation yok (kırmızı çizgi 3/6; `packages/sidecar-ipc/src/index.ts`, `adapters/*/src/worker-process.ts`, `adapters/rust/src/cargo.ts`); `packages/graph/src/git-read.ts` (`:189-228,518-602`) 10 anahtarlı minimal env allowlist (`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`) ve çalışma ağacı blob okumalarında `O_NOFOLLOW` + açma-sonrası `fstat`/`dev`/`ino` TOCTOU doğrulaması uygular; CLI başlatıcıları import öncesi Node `>=24` muhafızı (`node-version-guard.mjs`) ve `--expected-version` pini (`plugin-mcp-launcher.mjs`) zorlar; Roslyn worker deterministik Release bayraklarıyla (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`) derlenerek DLL içine yerel PDB yolu sızması engellenir. stdout yalnız MCP protokolü, loglar stderr. `storage.dataDbPath` ve `wiki.dataDbPath` sıkı doğrulanır: mutlak yol, null byte yasak, sarkan/yan (`-wal`/`-shm`/`-journal`) symlink ve sürücü kökü dahil `allowRoots` içinde olamaz; ihlal `CausorynConfigError` ile düşüş — sessiz devam yok (kanıt: `context.ts:230-357,449-541`). Tarihsel TŞ §22 matrisi **9/9 PASS**: symlink/traversal, secret leakage, TOCTOU, poisoned comment, oversized files, malicious refs, network denied, offline HTML XSS/CSP, stdout disiplini; "0 başarısız, 0 not run" (`docs/security-pass.md:21-33`; komutlar `:44-65`). Önceki security koşumu: `npx vitest run tests/security-release/` → 36/36, EXIT=0; üretim kaynak, doküman ve workflow yüzeyi `npm run secret-scan` (`scripts/secret-scan.mjs`, **13 kök** + 13 kök metin dosyası) ile taranır; K-022 yayına hazırlık koşumunda `npm audit` **0 güvenlik açığı** (`0 vulnerabilities`) bildirdi.

## 8. Kalite ve Testler

Varsayılan Vitest kuralları 92 izlenen test dosyasını kapsar. `tests/bench-release/benchmark.test.ts` ayrı çalıştırılır. Kök paket `test`, `test:watch`, `bench`, `build`, `build:package`, `typecheck`, `lint` ve `secret-scan` komutlarını tanımlar. Üç işletim sistemi için SHA-sabitli CI ve OIDC yayın iş akışları repoda bulunur. Aşağıdaki sonuçlar önceki yayın hazırlığı koşumlarından alınmıştır. [Test yapılandırması](../vitest.config.ts) · [Paket komutları](../package.json) · [Uygulama durumu](implementation-status.md)

| Kapı | Komut | Sonuç |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 |
| build | `npm run build` | BUILD_EXIT=0 |
| lint | `npm run lint` | exit 0, sıfır ihlal |
| secret-scan | `npm run secret-scan` | exit 0 (`scripts/secret-scan.mjs`, 13 kök + 13 kök metin dosyası tarandı, 0 eşleşme) |
| security | `npx vitest run tests/security-release/` | 36/36 |
| bench | `npm run bench` | 8/8; medyan 11.8/13.0/10.7 ms, soğuk indeks 16370.3 ms; hedef kolonu referanstır (`docs/benchmarks.md:3,11,18-22`) |
| npm audit | `npm audit --json` | **0 güvenlik açığı** (`0 vulnerabilities`; `K-022` kapsamında `eslint@10.15.0` ve `typescript-eslint@8.73.0` yükseltmesiyle tarihsel `minimatch` dev-toolchain uyarıları tamamen kapatıldı) |

`K-022` kapsamında yük altında gözlenen `ENOENT` ve timeout sorunlarına karşı `build-bundle.mjs` yazımı atomik hale getirildi ve bazı süreç testlerine 20 saniyelik açık timeout eklendi. Önceki koşum kayıtları için [uygulama durumu](implementation-status.md).

Bilinen sınırlar (`docs/implementation-status.md` F9 / `K-022`): Antigravity `agy` CLI NOT RUN (doğrudan `stdio` spawn doğrulandı); `.github/workflows/ci.yml` `ubuntu-latest` + `windows-latest` + `macos-latest` matrisini SHA-sabitli koşturur, ancak canlı macOS/ARM64 host CLI/GUI smoke henüz açık kapıdır; MCP SDK 1.32.2 v1.x; B7 Live Architecture Partial (per-file parse reuse yok, watcher MCP aracı değil; `refresh_index mode=incremental` `K-020` ile açıldı); rate-limit kapsam dışı (`K-010`); visualizer gerçek tarayıcı koşusu yok; çıplak F1 `packages/mcp-server/dist/` klonunda `.d.ts` yoktur (`packages/causoryn` `K-021` dağıtımında `dist/typescript-lib/lib*.d.ts` ile `ready` kanıtlandı).

## 9. Karar Kayıtları (seçme)

| Karar | Özet | Kanıt |
|---|---|---|
| K-001/K-004/K-005/K-006 | Karpathy LLM Wiki metodolojisi; runtime = Agent Team Dispatch + DEVELOPMENT_FLOW; context-inject kütüphanesi (indirilen dosya güvenilmez veridir: okunur, çalıştırılmaz); standart skill seti /workflow + superpowers | `wiki/decisions.md:27-32` |
| K-002/K-003 | ZCode 4. host adapter; 1.0 kapsamı dikey dilim önce (iptal değil, sıralama) | `wiki/decisions.md:28-29` |
| K-007 | raw "Development Rules" kullanıcı kararıyla geçersiz | `wiki/decisions.md:33` |
| K-008/K-011/K-012 | Hata kodu yönetişimi: INVALID_ARGUMENT+EVIDENCE_NOT_FOUND kararlı (`K-008`); SYMBOL_NOT_FOUND üçüncü uzantı (`K-011`); Faz C'de dördüncü uzantı İSTENMEDİ — mevcut `EXPORT_NOT_ALLOWED` yeterliydi (`K-012`) | `wiki/decisions.md:34-38` |
| K-009/K-010 | MCP SDK 1.32.2 v1.x sapması kabul; rate-limit/concurrency Faz A dışı | `wiki/decisions.md:35-36` |
| K-013/K-014 | Wiki 7 açık konu: cursor 50/200, bozuk link = WikiLink korunur + brokenLinkDiagnostics (hata değil veri yüzeyi) | `wiki/decisions.md:39-40` |
| K-015/K-016 | CONTRACT_PARSE_FAILED ilk kullanımı; verify_change Faz D'de bilinçli yok (ADR-010 boş handler yasağı); verdict önceliği blocking > inconclusive > review_required > clean; "passed count" = host beyanı, çekirdek dosya okumaz | `wiki/decisions.md:41-42` |
| K-017 | **0.1.0 public snapshot** (kapılar açık); bundle "mcp-server.mjs + vendored better-sqlite3", tek dosya iddiası yok; TOOL_NAMES 29 kilitli | `wiki/decisions.md:43` |
| K-018 | Çok-dil resolution etiketleri `PROTOCOL.md` tablosuyla sabit; orkestratör brief sapması kayda geçti | `wiki/decisions.md:44` |
| K-019/K-020/K-021 | Denetim düzeltmeleri (ROUTES_TO 5-dil doğruluğu, Antigravity `mcp_config.json` + bundle sahnelemesi, MCP `annotations`) + Pre-1.0 mühendislik iyileştirmeleri (`storage.dataDbPath` kalıcı SQLite + `symbol_fts` `fts` ayağı, `refresh_index mode=incremental`, TS `Test`/`TESTS`, `export_documentation format=snapshot`, `@causoryn/sidecar-ipc`, GitHub Actions CI) + Açık kaynak çoklu-host dağıtım (`packages/causoryn`, `npx causoryn setup`, `causoryn doctor`, 4 host pazaryeri manifestleri, `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, `dist/typescript-lib/lib*.d.ts`) | `wiki/decisions.md:45-47` |
| K-022 | **0.2.0 Pre-1.0 Public Preview**. Kamuya açık repo dışa aktarımı, MIT ve üçüncü taraf lisans bildirimleri, SHA-sabitli üç işletim sistemi CI, OIDC yayın ve SBOM. | `wiki/decisions.md:48` |
| K-023 | **0.2.2**. Görsel mimari projeksiyonu, offline HTML/SVG portalı, isteğe bağlı ve referans kontrollü host anotasyonları, `architecture-blueprint` skill'i. | [Sürüm kaydı](../CHANGELOG.md) |

## 10. Durum ve Sürüm

**v0.2.2 Pre-1.0 Public Preview** değişiklik günlüğünde 2026-11-22 tarihini taşır. Tarihsel `v0.1.0` sprint teslimi `4c9c188`, Sprint 8 sonrası eski taban `d197f21` idi. Açık kaynak yayın yönetişimi `v0.2.0` (`K-022`), çalışma zamanı düzeltmeleri `v0.2.1` ve görsel mimari yüzeyi `v0.2.2` (`K-023`) ile geldi. Proje wiki'sinin `wiki/index.md:5-28` haritası bu tarihçeye giden bağlantıları içerir. [Değişiklik günlüğü](../CHANGELOG.md) · [Uygulama durumu](implementation-status.md)

**Host matrisi** (`docs/compatibility-matrix.md:23-47`; `docs/hosts/antigravity.md:5-43`): Claude Code ✔ gerçek handshake (CLI 2.1.322, `claude mcp list → ✔ Connected`); Codex ✔ add→list→remove (health-check yapmaz — dürüst kayıt); ZCode ⚠ manifest-düzeyi (GUI kurulumu kırmızı çizgi 6 gereği kasıtlı yapılmadı); Antigravity ❌ `agy` CLI kurulum/smoke **NOT RUN** (`agy` ikilisi makinede yok), ancak `integrations/antigravity/causoryn/` altında `plugin.json` (`$schema`'sız yerel yükleyici uyumlu) + `mcp_config.json` (yerel yükleyici birincil tanımı) + `mcp.json` (TŞ §17.1 taşınabilir manifest) + `README.md` + `build:bundle` ile deterministik sahnelenen `scripts/mcp-server.mjs` (+ vendored `better-sqlite3`) mevcuttur ve `antigravity-plugin.test.ts` içinde doğrudan `stdio` el sıkışması (29 araç) otomatik testte doğrulanmıştır — CLI host düzeyinde net durum 2/3 gerçek koşumdur. Tüm hostlar aynı `causoryn@0.2.2` bundle'ını çalıştırır (`dist/mcp-server.mjs` + vendored `better-sqlite3`); kılavuzlar `docs/hosts/` + `integrations/zcode/` ve `integrations/antigravity/` altındadır.

**1.0.0 kapıları (`CHANGELOG.md` `[Unreleased]`)**: Antigravity `agy` CLI kurulum+smoke; ZCode GUI smoke; canlı macOS/ARM64 host dağıtım doğrulaması (`.github/workflows/ci.yml` `ubuntu-latest` + `windows-latest` + `macos-latest` CI matrisi `K-020`/`K-022` ile eklendi); MCP SDK v1→v2 (`K-009` kapanışı); watcher MCP sarmalaması + per-file parse reuse (B7; `refresh_index mode=incremental` `K-020` ile açıldı); C#/Python/Go/Rust TESTS kenarı (`adapters/typescript` `Test`/`TESTS` üretimi `K-020` ile açıldı); OpenAPI yanıt-şeması drift + event-version kuralı + SQL rename→unknown; snapshot blob revizyon otomasyonu (`export_documentation format=snapshot` üreticisi `K-020` ile açıldı); `wiki_search` filtreleri + `WIKI_NOTE_CONFLICT` + incremental wiki indeks daraltması; E6 gerçek tarayıcı doğrulaması (`v0.2.2` etkileşimli MCP dışa aktarımı mevcut); çıplak F1 bundle `.d.ts` fidelity (`packages/causoryn` dağıtımında `dist/typescript-lib/lib*.d.ts` ile çözüldü); rate-limit budget (`K-010`; `scripts/secret-scan.mjs` 13 kök ve `npm audit` 0 güvenlik açığı `K-022` ile kapatıldı). ADR-010 gereği kapılar sağlanmadan 1.0.0 ilan edilmez (`CHANGELOG.md:7-24`).

[Uygulama durumu](implementation-status.md) arşivlenmiş kabul kanıtlarını ve açık işleri, [uyumluluk matrisi](compatibility-matrix.md) ise host başına koşum düzeyini gösterir.

---

# English

# Causoryn — Comprehensive Project Document (v0.2.2 Pre-1.0 Public Preview)

*Scope: the `v0.2.2` Pre-1.0 Public Preview source tree, following `K-022` open-source governance (`v0.2.0`), `v0.2.1` runtime improvements and `K-023` visual architecture exports. TŞ denotes the technical specification (Teknik Şartname). Release dates and past run records appear in the [changelog](../CHANGELOG.md) and [implementation status](en/implementation-status.md).*

## 1. Executive Summary

Causoryn is a **local, model-independent code-analysis engine** served over stdio MCP. Its runtime converts a repository into a **Unified Evidence & Knowledge Graph** without calling an LLM, embedding service, or model API. In the optional `architecture-blueprint` workflow, the host model can prepare prose and send it to `causoryn_export_documentation` as `annotations`. Causoryn validates that input against its schema and snapshot references and renders it with fixed export rules. [ADR-002](en/adr/ADR-002-no-llm.md) · [Architecture Blueprint skill](../skills/architecture-blueprint/SKILL.md)

`SERVER_VERSION="0.2.2"`, `SCHEMA_VERSION="2.0"`, and **29 MCP tools** identify this release. The engine has five adapters: TypeScript runs in-process, and C#, Python, Go, and Rust use `@causoryn/sidecar-ipc`. The repository contains 92 test files covered by the default Vitest configuration and one separate benchmark test file. See §8–§10 for release evidence and open 1.0.0 gates. [Tool catalog](../packages/mcp-server/src/version.ts) · [Adapter catalog](../packages/indexing/src/index.ts) · [Test configuration](../vitest.config.ts)

## 2. Problem Statement — AI Agents Code Blind

A coding agent can query the graph and its evidence to inspect symbols, calls, and the potential impact of an edit. Every `verified` edge links to at least one evidence record. When present, source spans carry `relativePath`, line bounds, and `sourceHash`. Each relationship receives a `verified`, `heuristic`, or `unresolved` label. For example, the Python adapter marks a call inferred from imports as `heuristic` and an unresolved call as `UnknownExternal`. [Graph schema](../packages/domain/src/graph-schema.ts) · [Python protocol](../native/python-worker/PROTOCOL.md)

## 3. Product Loop

Agent work is structured as **Discover → Preflight → Agent Edits → Verify → Explain** (`wiki/overview.md:7-23`):

| Stage | Causoryn's role | Representative tools |
|---|---|---|
| Discover | Deterministic architecture map, symbol context, impact paths, context packs | `map_system`, `trace_execution`, `trace_business_flow`, `get_symbol_context`, `analyze_impact`, `get_agent_context` |
| Preflight | Candidate-only manifest of what a change would touch; writes no code | `preflight_change` (`candidateOnly` fixed `true`, `server.ts:365`) |
| Agent Edits | Host model edits the tree; Causoryn stays read-only | — |
| Verify | Re-checks the working tree under four audits; writes no code | `verify_change`, `derive_test_plan`, `detect_contract_drift` (`server.ts:402`) |
| Explain | Living wiki, deterministic exports, architecture diff/timeline | `get_evidence`, 7 `wiki_*` tools, `export_documentation`, `compare_architecture` |

The honesty boundary is explicit: `derive_test_plan` proposes candidates from TESTS edges and call sites but never runs tests; `verify_change` never claims "tests passed" (verdict chain per `K-016`) (`server.ts:399-419`; `wiki/decisions.md:42`).

## 4. Architecture

### 4.1 Pipeline

The local analysis path runs **Workspace Gateway → File Inventory → Language/Framework Adapters → Normalization → Symbol/Contract Resolution → Unified Evidence Graph → Immutable Snapshot → Domain Queries → MCP `structuredContent`**. The host-selected model operates on the MCP client side. See `docs/architecture.md:13-22` for architectural background.

### 4.2 Packages

The monorepo comprises **18 npm workspace packages** (`12 packages/*` + `5 adapters/*` + `1 integrations/zcode/causoryn`), standalone `apps/visualizer`, 4 `native/*` sidecar workers (`native/roslyn-worker` built as a deterministic Release DLL, `native/python-worker`, `native/go-worker`, `native/rust-worker`), root 4-host open-source marketplace manifests + `npx causoryn setup` / `causoryn doctor` CLI distribution (including `THIRD-PARTY-NOTICES.md` + `licenses/`), the 3-OS SHA-pinned `.github/workflows/ci.yml` and OIDC `.github/workflows/release.yml` workflows, the `integrations/antigravity/causoryn` plugin directory, and 8 `examples/*` fixtures (`package.json:12-16`; `docs/architecture.md:26-63`):

| Package (`packages/*`) | Responsibility |
|---|---|
| `domain` | Graph/evidence contracts, Zod schemas, canonical JSON, deterministic IDs |
| `sidecar-ipc` | Shared sidecar IPC core: NDJSON framing, timeouts, stdout/stderr budgets, allowlist env, dynamic asset root |
| `workspace` | Gateway: trusted roots, inventory, ignore rules, symlink escape, output policy |
| `indexing` | IndexCoordinator 5-language orchestration (`INDEXED_ADAPTERS`) + `symbol_fts` population + multi-process race recovery |
| `graph` | Snapshot queries, traversal/impact/guard/compare and architecture projection / documentation export (`snapshot` included), plus hardened `git-read.ts` |
| `storage-sqlite` | SQLite + FTS5 store (`SqliteGraphRepository` + `WikiStore`) |
| `contracts` | Read-only contract discovery |
| `preflight` | Candidate-only manifest (writes no code) |
| `verification` | Pure `verify_change` core |
| `wiki` | GraphSnapshot → WikiSnapshot projection |
| `mcp-server` | stdio transport + zero-config `--allow-cwd` / MCP `roots/list` / `--auto-data-dir` (sensitive/system root denylist) + `storage.dataDbPath` / `InMemoryGraphRepository` + 29 tools + MCP `annotations` (`readOnlyHint`) |
| `causoryn` | Open-source multi-host CLI (`causoryn setup\|doctor\|mcp`) and 4-host plugin distribution package (`0.2.2`, `MIT`, `THIRD-PARTY-NOTICES.md`, zero external npm dependencies) |

The package manifest declares the `typescript` 5.9.3 compiler and the `esbuild` bundler. [Root manifest](../package.json) · [Architecture](en/architecture.md)

### 4.3 Dependency boundaries

1. **`domain` is a leaf**: imports only its own modules and `zod` — no `@causoryn/*`, no MCP SDK, no Node APIs (grep over `packages/domain/src`; sole dependency `zod ^4.6.7`).
2. **`workspace` touches only Node built-ins and zod** (grep over `packages/workspace/src`; sole dependency zod).
3. **Parser detail never leaks into `mcp-server`**: it imports no `@causoryn/adapter-*`; adapters are reached only via `@causoryn/indexing`, and "adapter" appears there only as string metadata (`INDEXED_ADAPTERS`, `services.ts:300-309`).

### 4.4 Determinism and the evidence model

- **Injected clock**: the repository layer never reads the wall clock; `IndexService` injects `clock: () => string` (`repository.ts:10-13`; `index-service.ts:209`), and `meta.createdAt` carries that injected wall-clock timestamp (`context.ts:133`) without participating in `snapshotId`.

Reproducing deterministic analysis requires equivalent source content, revision identity and sequence, workspace identity, effective inventory rules, analyzer toolchains, and configuration. Compare outputs using the same snapshot and options. `meta.createdAt`, the client `requestId`, first-index progress, and worker availability can vary with runtime state. Some export formats include `meta.createdAt`, which is excluded from the snapshot ID. [Snapshot identity](../packages/domain/src/snapshot.ts) · [Architecture export](../packages/graph/src/architecture-export.ts) · [MCP request handling](../packages/mcp-server/src/server.ts)
- **Deterministic IDs**: node/edge/evidence IDs are `<type>:<sha256-hex-64>` over canonical JSON — node keys on `(workspaceId, kind, qualifiedName, relativePath|null)`, edge on `(workspaceId, kind, from, to)` with resolution deliberately excluded, and evidence on `[workspaceId, kind, analyzerId, analyzerVersion, rationale, span|null]` (`ids.ts:14-50, 92-161`, specifically `ids.ts:147-161`). Snapshot IDs hash `[workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]` (`snapshot.ts:379-397`) and exclude timestamps; snapshots are deep-frozen via `deepFreeze` (ADR-005) in canonical ID order (`snapshot.ts:22-35, 287-295, 379-397, 429`). Nuance: consecutive `refresh_index` calls within the same `IndexService` process increment `revision.sequence` (`this.runCount + 1`, `index-service.ts:856, 1073`), yielding a distinct `snapshotId`, whereas fresh independent runs on identical content and `sequence` yield bit-identical `snapshotId`s.
- **Verified-edge invariant, three layers**: the `createEdge` constructor throws `verified-edge-requires-evidence`; the Zod `superRefine` rejects violations; and the repository re-validates on write; `heuristic`/`unresolved` edges may stay evidence-free by design (`ids.ts:163-189`; `graph-schema.ts:84-93`).
- **Snapshot invariants** — dangling edges, duplicate IDs, unknown evidence references — are checked in the schema (`graph-schema.ts:119-186`) and again by the repository, which re-derives every node/edge/evidence ID and rejects mismatches with `graph/*-id-mismatch` (`validation.ts:23-27, 116-156, 212-227`). Evidence spans carry `{relativePath, startLine≥1, endLine≥startLine, sourceHash}`; targets outside the inventory are rejected with `indexing/internal` (`graph-schema.ts:35-56`; `index-service.ts:1730-1830`).
- **Pure verification core**: no `node:fs`/`Date`/`Math.random` in `packages/verification/src` (grep empty); reports are byte-deterministic; a test runner is never executed and `observed` counts are accepted only from evidence.
- **IndexService order**: authorize root → inventory → sync TS plus async C#/Python/Go/Rust workers → merge into one build → publish; any error lands in `failBuild` and nothing enters the publish stream (`index-service.ts:93-112, 786-813, 1833-1844`).

### 4.5 Storage

SQLite runs WAL, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`, with FTS5 tables (`symbol_fts`, `wiki_fts`) and `PRAGMA user_version=2`; all DDL is one static literal, all data bound via prepared-statement parameters (`sqlite-repository.ts:150-153`; `schema.ts:24-38`). **Atomic publish**: builds open as `building`, invisible to every read path; `publish` flips to `ready`/`partial` in one transaction; `failed` never publishes; reading an unpublished snapshot is rejected with `storage/corrupt-row` (`repository.ts:15-25`; `sqlite-repository.ts:447-484`). **Stale semantics**: stale if a newer publication exists or a `building` build with `revision_sequence >=` is active, so old-publication queries keep working during rebuilds (`sqlite-repository.ts:877-901`). **Incremental indexing** is content-hash based: with no meaningful change across the five languages the graph is kept and only the files table refreshed; reconciliation runs *after* adapter runs, so an out-of-contract adapter error cannot lock a stale graph behind a "no changes" verdict (`index-service.ts:641-783, 1319-1324`).

Starting with `v0.2.1`, the CLI/plugin starts its first index in the background after the MCP `initialized` notification. Auto-configured workspace roots merge safe root `.gitignore` patterns into `extraIgnore`. Polyglot builds deduplicate compatible pathless external nodes, and SQLite batches writes using position counters. `v0.2.2` caches up to four published graphs with `PRAGMA data_version` guarding reuse, and `causoryn doctor` reads the version from the package manifest. [Startup](../packages/mcp-server/src/cli-stdio.ts) · [Workspace configuration](../packages/mcp-server/src/runtime-cli.ts) · [IndexService](../packages/indexing/src/index-service.ts) · [SQLite repository](../packages/storage-sqlite/src/sqlite-repository.ts) · [Doctor version](../packages/causoryn/src/types.ts)

## 5. MCP Tool Catalog — 29 Tools

`TOOL_NAMES` (`version.ts:36-66`) holds exactly 29 unique `causoryn_*` names — confirmed on disk with `SERVER_VERSION = "0.2.2"` (:10) and envelope `SCHEMA_VERSION = "2.0"` (:13); the registration loop (`server.ts:538-597`) registers each one with structured MCP `annotations` (`readOnlyHint`: `false` on the 3 write tools, `true` on the 26 read-only tools; `destructiveHint: false`; `openWorldHint: false`; `server.ts:154-164, 555`), and empty handlers are forbidden (ADR-010). The `7+6+3+3+3+7=29` grouping below is a thematic summary over the TŞ `22 core + 7 wiki = 29` catalog (`wiki/mcp-tools.md:1`; `docs/tool-contracts.md:45, 72`):

| Group | Tools | # |
|---|---|---|
| Discovery & Index | `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index`, `find_symbols`, `get_symbol_context`, `get_evidence` | 7 |
| Architecture | `map_system`, `trace_execution`, `trace_business_flow`, `analyze_impact`, `compare_architecture`, `architecture_timeline` | 6 |
| Navigation & Report | `get_agent_context` (task text → context pack up to `tokenBudget`), `generate_onboarding`, `export_documentation` (json/markdown/mermaid/html/snapshot) | 3 |
| Contracts | `check_contracts` (backward-safe/risk/breaking_candidate/unknown), `detect_contract_drift`, `derive_test_plan` | 3 |
| Guard | `check_architecture` (SCC no-cycles + forbidden-dep over `.causoryn/architecture.rules.yaml`; reports findings, no CI verdict), `preflight_change`, `verify_change` | 3 |
| Wiki | `wiki_build` (the only wiki writer) + read-only `wiki_get_tree`, `wiki_get_page`, `wiki_search` (FTS5, no embeddings), `wiki_get_links` (backlinks + broken-link diagnostics), `wiki_get_versions`, `wiki_diff` | 7 |

(evidence: `version.ts:37-66`; `server.ts:173-528`; `wiki/mcp-tools.md:9-45`.)

**Envelope**: every response is a `z.strictObject` with all ten fields present — `schemaVersion`, `requestId`, `workspaceId`, `snapshotId`, `status` (`ok|partial|error`), `coverage` (tier L0–L4, edge resolution counts, coverageRatio), `warnings`, `data`, `nextCursor`, `error` (`envelope.ts:24-55`). Errors travel *inside* the envelope (`isError=false`), never as protocol faults; stack traces never reach the client — unexpected failures return `INTERNAL_ERROR` with a generic message and `requestId`, raw detail goes to stderr only; `AMBIGUOUS_SYMBOL` carries candidates in `data` (`server.ts:135-137, 566-592`).

**Error codes**: a fixed table of 15 codes with static `retryable` + `userAction` guidance; only `INDEX_NOT_READY` and `INTERNAL_ERROR` are retryable (`errors.ts:70-86, 95-166`). Governance: `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, and `SYMBOL_NOT_FOUND` are the three project extensions beyond the TŞ §10.1 base list — `K-008` covers the first two and `K-011` (`wiki/decisions.md:37`, `errors.ts:62-64`) records `SYMBOL_NOT_FOUND`; `K-012` records that Phase C declined a fourth extension where the fixed TŞ code `EXPORT_NOT_ALLOWED` sufficed; five codes were selected from the TŞ §10.1 fixed list (`POLICY_INVALID`, `INVALID_REVISION`, `EXPORT_NOT_ALLOWED`, `WIKI_PAGE_NOT_FOUND`, `CONTRACT_PARSE_FAILED`); and `UNSUPPORTED_LANGUAGE` is retained from TŞ §10.1 as a **reserved fixed code** not currently thrown by services because missing/failing workers degrade via L0/L1 adapter fallback (`errors.ts:66-68`; `wiki/decisions.md:34-38`).

**Write-permission matrix** — 3 tools advertise `readOnlyHint: false` and 26 advertise `readOnlyHint: true`:

| Tool / Component | Target | Guard & in-memory / startup nuance |
|---|---|---|
| `refresh_index` (`readOnlyHint: false`) | Causoryn's own index (graph repository) | Scans `allowRoots[0]` read-only (`mode: full\|incremental`); defaults to in-process `InMemoryGraphRepository` or uses `storage.dataDbPath` (`SqliteGraphRepository` outside `allowRoots`, `context.ts:139-185`); first-run Rust/Go sidecar compiles may touch their own toolchain `target`/cache directories |
| `export_documentation` (`readOnlyHint: false`) | `config.output.allowedOutputDirs` only, atomic (`.tmp` + rename) | An empty list yields `EXPORT_NOT_ALLOWED`. `format="snapshot"` emits canonical `architecture-snapshot.json` and other formats default to `view="architecture"`. |
| `wiki_build` (`readOnlyHint: false`) | `config.wiki.dataDbPath` SQLite data-root; atomic publish | Unset ⇒ `PATH_DENIED`; never writes workspace sources; at startup `openWikiStores` (`context.ts:449-541`) also initializes the single workspace row in `wiki.dataDbPath` when configured |
| `preflight_change` (`readOnlyHint: true`) | Writes nothing to disk or workspace | `candidateOnly` fixed `true`; caches the manifest in the in-process `PreflightManifestStore` (FIFO cap 200; `preflight-store.ts:38-66`) solely for `verify_change(preflightId)` resolution |

(evidence: `services-architecture.ts:1032-1058`; `config.ts:48-85`; `services-wiki.ts:136-145`; `context.ts:139-185, 230-357, 449-541`.) Both `storage.dataDbPath` and `wiki.dataDbPath` are strictly validated at startup — absolute, no null bytes, outside every authorized workspace root (including drive-root boundaries, dangling symlinks, and SQLite `-wal`/`-shm`/`-journal` sidecars, per ADR-008), parent must exist; violations crash the server with `CausorynConfigError` rather than continuing silently (`context.ts:230-357`).

**Architecture exports.** `view="architecture"` produces a JSON blueprint, grouped Mermaid, a Markdown brief, or JavaScript-free offline HTML with layered SVG. `view="interactive"` adds offline search, zoom, and an evidence inspector for HTML. `view="full"` preserves the raw graph export. `format="snapshot"` emits a raw `CompareContentSet` with the default or `full` view. `view="wiki"` and invalid combinations of view, format, and annotations yield `INVALID_ARGUMENT`. `options` and `annotations` apply to the `architecture` and `interactive` views. With no annotations, the engine derives the output from the graph. For supplied annotations, schema limits and references (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`) are validated. That check covers references and structure. The accuracy of the external narrative depends on its author. Matching snapshot, format, view, options, and valid annotations produce matching export bytes. [Tool contract](en/tool-contracts.md) · [Export tests](../packages/graph/test/architecture-export.test.ts)

**Pagination and limits**: cursors are opaque, versioned offsets (`{v:1,o:<int>}` as base64url); undecodable cursors become `INVALID_ARGUMENT` ("reuse the previous `nextCursor` verbatim"); `nextCursor` is null on the last page at both envelope and data level (`cursor.ts:13-41`; `services-wiki.ts:210-220, 102-105`). Defaults: `map_system` maxNodes 250, `find_symbols` 100, wiki tools 50 with a 200 cap (`K-013`); breaches raise `LIMIT_EXCEEDED`; `maxDepth`=3 and `maxPaths`=50 cap trace tools (`config.ts:26-37`; `services-wiki.ts:114-116`; `services.ts:772-778, 932-938`).

## 6. Language Support — Five Adapters, Honest Labels

### 6.1 Two patterns, one registry

TypeScript runs **in-process** on the Compiler API (Program + AST + TypeChecker + BDD `Test`/`TESTS` extraction; `analyzer.ts`). C#, Python, Go, and Rust run as **sidecar workers** over `@causoryn/sidecar-ipc`: C# on Roslyn via `dotnet exec` (`WorkerAnalyzer.cs`, 1,669 lines); Python on stdlib-only `ast` (`worker.py`, 1,190 lines; "zero external dependencies"); Go on stdlib `go/parser`+`go/ast`; Rust on `syn` 2 + serde_json (`analyzer.rs`, 1,209 lines). All five register in `INDEXED_ADAPTERS` (`index.ts:168-224`), from which `get_capabilities` projects `{language, analyzerId, version, levels}` while omitting the internal `source` field (`services.ts:246-257, 300-309`). Multi-language summary and coverage follow the same registry: `workspace_summary.languages` counts `File` nodes across all five languages in `INDEXED_ADAPTERS` order (`services.ts:362-387`), and `coverageOf.tier` reports `L2` when TS/C#/Python AST/symbol nodes exist, `L1` when only Go/Rust AST/symbol nodes exist, and `L0` otherwise (`services.ts:138-190`). Note the two distinct L0–L4 axes: the *adapter capability* axis (L0 file discovery → L4 flow/contract cross-linking; `wiki/scope.md:37`) versus the *map hierarchy* axis of `map_system` (L0 Workspace … L3 Function/Endpoint/Test; L4 flow maps explicitly unsupported in Phase A, `services.ts:698-716, 765-771`).

### 6.2 Resolution honesty per language

| Language | Symbol resolution (honest label) | Route detection (L3) |
|---|---|---|
| TypeScript | L2 — TypeChecker: internal/external imports verified; Node builtins and relative guesses heuristic; unknown unresolved | Generic `<x>.<verb>("/path", handler)` + Express linker + Next.js App Router file conventions |
| C# | **True semantic resolution** (Roslyn) — verified wherever the checker resolves, in-set or out-of-set; known-name rules heuristic; nothing fabricated | HttpGet/HttpPost/… attributes + MapGet/MapPost/… minimal APIs; `[Route]`-less controllers produce no endpoints, by warning |
| Python | L2 — same-module verified; imported heuristic + ambiguity; locals/builtins/unknown → UnknownExternal (unresolved) | `@carrier.get/post/…` decorators + Flask-style `route`/`api_route` |
| Go | **"heuristic-only (no semantic L2)"** — verified only for same-package bare identifiers; builtins produce no edge; `pkg.Func` and method names heuristic; multi-candidate unresolved; `SymbolResolution:false` declared | Handle/HandleFunc (`"*"`) + chi/gin/echo verbs, guarded by literal `/`-prefix + ≥2 args; recognized registrations emit no CALLS |
| Rust | **"heuristic-heavy"** — same-module bare and single-match qualified verified (module prefixes not fully validated, documented limit); method calls heuristic (no trait dispatch); no-candidate unresolved | Attribute macros: 9 verbs + axum/actix/rocket `#[route(…)]` forms |

(evidence: `PROTOCOL.md` resolution tables fixed by `K-018` — python :226-232, go :194-212, rust :204-208, roslyn :202-208; `wiki/decisions.md:44`; code at `worker.py:606-834`, `analyze.go:586-703`, `analyzer.rs:435-563`, `WorkerAnalyzer.cs:1050-1510`, `analyzer.ts:1171-1360`.)

Three nuances keep this honest: (1) Go declares `SymbolResolution:false` while the others declare true — the truthful context is surface labels plus rationales ("syn has no semantic resolver", rust `PROTOCOL.md:188`). (2) C#'s surface declares `frameworkLinkers: "aspnet-core-route-attributes (L3)"` (`index.ts:187`, `K-022`), aligning with the worker's `aspnetcore-controller-attribute-and-minimal-api-call-pattern` capability (`Protocol.cs:234`). (3) Sidecar worker protocol outputs define `coverageRatio` as `verified / total` edges (`python PROTOCOL.md:141-142`; `go analyze.go:499-507`), whereas the MCP envelope `coverage.coverageRatio` computes `(verified + heuristic) / totalEdges` (`resolvedEdges / totalEdges`, `packages/mcp-server/src/services.ts:156-190`); C# counts out-of-set checker-backed calls as verified (`roslyn PROTOCOL.md:125-128`). Also recorded: `wiki/sprint-8.md:4` was updated in `K-022` to `Go L1/heuristic+L3 (semantik L2 yok)` so it aligns with the binding metadata — `INDEXED_ADAPTERS` and the `PROTOCOL.md` tables remain authoritative (`index.ts:158-162, 208, 219`). `ROUTES_TO` edges are always `verified` + evidenced in **TypeScript, Python, and Rust** (`adapters/typescript/src/analyzer.ts:1625-1669`; `native/python-worker/worker.py:898-901`; `native/rust-worker/src/analyzer.rs:618-650`); in **C#**, `ROUTES_TO` is `verified` when the semantic model resolves MVC attribute types to `Microsoft.AspNetCore.Mvc` and falls back to `heuristic` (+ `ambiguity`) under known-name matching (`native/roslyn-worker/WorkerAnalyzer.cs:1475-1508`); in **Go**, `ROUTES_TO` is `verified` for same-package functions, `heuristic` or `unresolved` for selector/unknown handlers, and omitted (Endpoint preserved with a warning) for inline `func` literals (`native/go-worker/internal/analyze/routes.go:120-170`, plus `:103-109`).

### 6.3 Degradation never kills the engine

If a worker is missing, crashes, times out, or returns malformed output, that adapter falls back to L0/L1 file-level nodes — `workerAvailable:false`, `partial`, `coverageRatio:0`, source-hashed File nodes kept, explicit warning, capabilities all false — and the other languages' analysis survives (`adapters/go/src/analyzer.ts:395-431` and equivalents; `index-service.ts:1443-1446`). The synchronous bridge never spawns workers and publishes L0 File nodes with a `sync-run-degraded` fingerprint (`index-service.ts:122-129, 1089-1157, 1245-1317`). In-file syntax errors are diagnostics, not failures: a broken file yields a lone File node while healthy files' graph persists (`python PROTOCOL.md:339-341`) — verified live with a broken+ok fixture (exit 0, `partial`, `SyntaxError` at line 1, both File nodes present).

### 6.4 Worked example: hand it a Python project

Given the `examples/fixture-python-app` fixture (three files) — **run live** in the analysis session:

1. A host calls `causoryn_refresh_index`; `IndexService` authorizes the root, collects inventory, and spawns the worker via `python -B native/python-worker/worker.py` (fixed args `["-B", workerScriptPath]`; `-B` disables `__pycache__` writes, and `PYTHONPATH` is already excluded by the worker env allowlist; `adapters/python/src/worker-process.ts:7-9, 52-58`; `adapters/python/src/types.ts:57-62`).
2. The worker parses each file with stdlib `ast`. A decorator like `@app.get("/x")` yields an Endpoint node plus a **verified** ROUTES_TO edge; same-module calls get **verified** CALLS; imported symbols get **heuristic** CALLS with ambiguity notes; unknown names become UnknownExternal nodes with **unresolved** edges — never fabricated targets (`python PROTOCOL.md:226-232`; `worker.py:606-834`).
3. Live result: exit 0, `ready`, 21 nodes (3 File / 1 Class / 8 Function / 2 Method / 2 Endpoint / 5 UnknownExternal), 25 edges (11 CONTAINS verified, 3 CALLS verified, 4 heuristic, 5 unresolved, 2 ROUTES_TO verified), worker `coverageRatio` 0.64 — matching `docs/implementation-status.md` Sprint 8 digit for digit.
4. If a toolchain is absent, the same flow degrades gracefully — demonstrated for real: a vitest run with `dotnet` missing from PATH saw the C# adapter fall to L0/L1 with an explicit warning while the other four languages produced full layers, the snapshot published as `partial`, and the engine stayed up; with toolchains restored it went 9/9 green (two runs of `npx vitest run packages/indexing/test/index-service-multilang.test.ts`: 3F/6P, then 9/9 in 55.97 s).

## 7. Security Model

The runtime has no LLM or embedding dependency. Source analysis is read-only. Data stores and exports have separate write policies. Stdout carries MCP protocol messages and diagnostics go to stderr. ADR-010 requires a working handler for every published tool.

**WorkspaceAccessPolicy** applies a fixed six-step decision order: (1) root authorization against config-declared allowRoots only — an MCP request cannot add a root (realpath canonicalized); (2) null-byte rejection; (3) lexical `..`/absolute-path traversal rejection; (4) ignore rules including ancestors; (5) realpath symlink/junction escape rejection (CWE-59); (5b) ignore rules re-applied to the canonical real path so an in-root symlink cannot bypass the secret-deny list; (6) extension filter + max file size (`workspace-access-policy.ts:17-33, 135-168, 171-252`). On zero-config CLI/IDE flows (`--allow-cwd` and MCP `roots/list`, `packages/mcp-server/src/runtime-cli.ts:428-560`), an additional defense-in-depth denylist rejects `$HOME`, filesystem roots (`/`, `C:\`), data/plugin install directories (`~/.causoryn`, `_npx`, `node_modules`), sensitive user directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), and OS system directories (`/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `C:\Windows`, `C:\Program Files`, `C:\ProgramData`); `--auto-data-dir` provisions `0o700` storage strictly outside authorized roots with dangling-symlink (CWE-59) checks. Source analysis is read-only. Auto-configuration places the export directory outside the source tree. When the user declares `output.allowedOutputDirs` explicitly, export authorization is governed by that list and realpath containment (`output-policy.ts:11-48`).

**Worker spawn & supply-chain security**: every sidecar launches a literal command with fixed arguments and an environment allowlist — `python -B <script>`; `go run ./cmd/worker` (or a configured binary; 120 s default timeout for cold compiles); literal `cargo` build (`adapters/rust/src/cargo.ts`, with `--locked` and writable `CARGO_TARGET_DIR` cache in packaged installs) plus `causoryn-rust-worker` for Rust; `dotnet exec <dll>` for C# built with deterministic Release flags (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`, eliminating PDB path leaks). `packages/graph/src/git-read.ts` (`:189-228, 518-602`) enforces a 10-key minimal env allowlist (`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`) and post-open `fstat`/`dev`/`ino` TOCTOU verification on `working-tree` blobs; CLI launchers enforce a pre-import Node `>=24` guard (`node-version-guard.mjs`) and `--expected-version` pin (`plugin-mcp-launcher.mjs`). No shell interpolation anywhere (`adapters/*/src/worker-process.ts`; `adapters/rust/src/analyzer.ts:163-268`).

The TŞ §22 security matrix is recorded **9/9 PASS** (`docs/security-pass.md:21-31`) — symlink/path traversal, secret leakage, symlink TOCTOU, poisoned source comments, oversized files, malicious Git refs, network denied, offline HTML XSS/CSP, stdout discipline — with "0 failed, 0 not run" (:33) and reproducible commands (:44-65). Earlier release preparation ran `npx vitest run tests/security-release/` → **36/36 passed**, exit 0; in addition, `npm run secret-scan` (`scripts/secret-scan.mjs`) scans **13** directory roots + 13 root text files for credential, email, and non-generic user profile path patterns, and the K-022 run of `npm audit` reported **0** vulnerabilities.

## 8. Quality and Tests

The default Vitest configuration covers 92 tracked test files. The separately run benchmark lives at `tests/bench-release/benchmark.test.ts`. The root package defines `test`, `test:watch`, `bench`, `build`, `build:package`, `typecheck`, `lint`, and `secret-scan`. The repository defines SHA-pinned CI for three operating systems and an OIDC release workflow. The results below are from earlier release preparation runs. [Test configuration](../vitest.config.ts) · [Package scripts](../package.json) · [Implementation status](en/implementation-status.md)

**Recorded release preparation results**

| Gate | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 |
| build | `npm run build` | exit 0 |
| lint | `npm run lint` | exit 0, zero violations |
| secret-scan | `npm run secret-scan` | exit 0 (`scripts/secret-scan.mjs`, 13 roots + 13 root text files scanned, 0 matches) |
| security | `npx vitest run tests/security-release/` | 36/36 |
| benchmark | `npm run bench` | 8/8 (docs not written — env flag unset, ADR-008 read-only discipline) |
| npm audit | `npm audit --json` | **0 vulnerabilities** (`eslint@10.15.0` & `typescript-eslint@8.73.0` upgrade in `K-022`) |

To address observed load-sensitive `ENOENT` and timeouts, `K-022` switched `build-bundle.mjs` to atomic writes and added explicit 20-second timeouts to selected subprocess tests. Earlier runs appear in [implementation status](en/implementation-status.md).

The historical 1,000-file fixture measured medians of **11.8 / 13.0 / 10.7 ms** for `workspace_summary` / `get_symbol_context` / `map_system` (200-node) and a cold index of 16,370.3 ms. [Benchmarks and measurement conditions](en/benchmarks.md)

**Supply chain & licensing**: The K-022 run of `npm audit --json` reported **0 vulnerabilities** (`0` open advisories after upgrading to `eslint@10.15.0` and `typescript-eslint@8.73.0` in `K-022`). Redistributed npm and Roslyn NuGet components are inventoried in `packages/causoryn/THIRD-PARTY-NOTICES.md` + `licenses/`, and `.github/workflows/release.yml` generates `SHA256SUMS.txt` plus a 13-component CycloneDX 1.5 SBOM (`causoryn-sbom.cdx.json`) via `scripts/generate-sbom.mjs`, attests build provenance (`actions/attest-build-provenance`), and publishes via tokenless npm OIDC (`npm publish --provenance --access public`).

**Known limits** (`docs/implementation-status.md` F9 / `K-022`): `.github/workflows/ci.yml` runs on `ubuntu-latest` + `windows-latest` + `macos-latest` (SHA-pinned), while live host CLI/GUI smoke on macOS/ARM64 remains open; Antigravity `agy` CLI install/smoke not run (`NOT RUN`, though direct `stdio` spawn against staged `scripts/mcp-server.mjs` is verified); MCP SDK pinned at 1.32.2 (v1.x); B7 per-file parse reuse and watcher MCP surface remain open (`refresh_index mode=incremental` enabled in `K-020`); rate-limit/concurrency out of scope (`K-010`); no real-browser visualizer run; bare F1 `packages/mcp-server/dist/` clone lacks `.d.ts` files (`packages/causoryn` `K-021` distribution stages `dist/typescript-lib/lib*.d.ts` with `ready` state verified).

## 9. Decision Records (K-001..K-023, selected)

The decision register is `wiki/decisions.md`. Current architecture and release evidence is also available in [ADR-002](en/adr/ADR-002-no-llm.md) and the [changelog](../CHANGELOG.md).

| ID | Decision |
|---|---|
| K-001 | Karpathy LLM Wiki pattern adopted as development methodology |
| K-002/K-005/K-006 | ZCode added as fourth host; `raw/context-inject` library (downloaded files are untrusted data: read, never execute); standard skill set `/workflow` + superpowers |
| K-003 | 1.0 scope re-sequenced vertical-slice-first — deferral, not cancellation |
| K-004 | Runtime behavior fixed: Agent Team Dispatch + 10-step DEVELOPMENT_FLOW (no passing tests by deletion; an unrun check never counts as passed) |
| K-007 | "Development Rules" section of the raw source voided by explicit user decision |
| K-008/K-011 | Error-code extensions `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND` (`K-008`) and third extension `SYMBOL_NOT_FOUND` recorded in `K-011` (`wiki/decisions.md:37`) |
| K-009 | MCP SDK divergence accepted (1.32.2, v1.x, vs TŞ "SDK v2" target) |
| K-010 | Rate-limit/concurrency out of Phase A scope |
| K-012 | Phase C declined a fourth extension — existing TŞ §10.1 fixed code `EXPORT_NOT_ALLOWED` sufficed, so no fourth extension was minted |
| K-013/K-014 | Wiki questions fixed: states building/ready/partial/failed; opaque cursor 50/200; broken links preserved as data + diagnostics, not errors; alias failures → `INVALID_REVISION` |
| K-015/K-016 | `CONTRACT_PARSE_FAILED` first use; SQL RENAME → `unknown`; verify verdict priority chain; byte-deterministic evidence ordering; "passed count = host claim, core reads no files" |
| K-017 | **0.1.0 public snapshot, explicitly not 1.0.0** — three gates unmet; bundle honestly "mcp-server.mjs + vendored better-sqlite3", not single-file; 4-host matrix approved; TOOL_NAMES locked at 29 |
| K-018 | Per-language resolution labels fixed by `PROTOCOL.md` tables; two inaccurate orchestrator claims corrected on disk (Go pkg-qualified = heuristic, not verified; Rust not wholly heuristic), deviation explicitly logged |
| K-019/K-020/K-021 | Audit remediations (`ROUTES_TO` 5-language fidelity, Antigravity `mcp_config.json` + bundle staging, MCP `annotations`) + Pre-1.0 engineering improvements (`storage.dataDbPath` SQLite persistence + `symbol_fts` `fts` leg, `refresh_index mode=incremental`, TS `Test`/`TESTS`, `export_documentation format=snapshot`, `@causoryn/sidecar-ipc`, GitHub Actions CI) + Open-source multi-host distribution (`packages/causoryn`, `npx causoryn setup`, `causoryn doctor`, 4-host marketplace manifests, `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, `dist/typescript-lib/lib*.d.ts`) |
| K-022 | **0.2.0 Pre-1.0 Public Preview**. Public tree export, MIT and third-party notices, SHA-pinned CI on three operating systems, OIDC release and SBOM. |
| K-023 | **0.2.2**. Visual architecture projection, offline HTML/SVG portal, optional reference-checked host annotations, and the `architecture-blueprint` skill. |

## 10. Status and Version

The changelog dates **v0.2.2 Pre-1.0 Public Preview** to 2026-11-22. The historical `v0.1.0` snapshot was `4c9c188`, and `d197f21` was the post-Sprint-8 base. Open-source release governance arrived in `v0.2.0` (`K-022`), runtime fixes in `v0.2.1`, and visual architecture exports in `v0.2.2` (`K-023`). [Changelog](../CHANGELOG.md)

| Milestone | Phase / Scope | Status | Tests |
|---|---|---|---|
| Sprint 1 | A | 11/11 Done | 247 |
| Sprint 2 | B | 7/8 — B7 Live Architecture **Partial** | 419 |
| Sprint 3 | C | 8/8 | 634 |
| Sprint 4 | C2 Living Wiki | 8/8 | 800 |
| Sprint 5 | D | 7/7 — 28 tools | 1,024 |
| Sprint 6 | E | 6/6 — **29 tools, core catalog complete** | 1,116 |
| Sprint 7 | F | 9/9 — `v0.1.0` tagged (`4c9c188`), 7-sprint plan complete | 1,266 |
| Sprint 8 | Multi-language expansion | 4/4 — Python/Go/Rust sidecars (`K-018`) | 1,424 |
| K-019..K-022 | Open-source distribution and governance | `v0.2.0` preview | 89 default files in the recorded historical suite |
| Runtime and K-023 | Deferred startup, caching, visual architecture exports | `v0.2.1` and `v0.2.2` previews | 92 default test files in the current source tree |

(evidence: `wiki/sprint-1.md:4` through `sprint-8.md:4`; `wiki/decisions.md:45-48`.) The project wiki — index, overview, scope, architecture, mcp-tools, roadmap, working-model, decisions, lessons, open-source-readiness, sprint-1..8, append-only log — is mapped in `wiki/index.md:5-28`; host guides live in `docs/hosts/` (`claude-code`, `codex`, `antigravity`, `zcode`) and `integrations/zcode/causoryn/README.md` + `integrations/antigravity/causoryn/README.md`, verified on disk.

**Host support** (`docs/compatibility-matrix.md:23-26, 39-47`; `docs/hosts/antigravity.md:5-43`): Claude Code ✔ real end-to-end handshake (CLI 2.1.322, `claude mcp list → ✔ Connected`; verified 2026-11-08 and 2026-11-10); Codex ✔ add→list→remove (CLI 0.163.0 — honestly noted: list performs no health check); ZCode ⚠ manifest-level validation only (GUI install deliberately not performed, red line 6); Antigravity ❌ `agy` CLI install/smoke **NOT RUN** (no `agy` binary on machine), while `integrations/antigravity/causoryn/` ships `plugin.json` (`$schema`-free for the local loader), `mcp_config.json` (primary local loader config), `mcp.json` (TŞ §17.1 portable manifest), `README.md`, and `build:bundle`-staged `scripts/mcp-server.mjs` (+ vendored `better-sqlite3`), with direct `stdio` spawn handshake (29 tools) verified in `antigravity-plugin.test.ts`. Net CLI host runs: **2/3 real runs, 1/3 open**. Every host runs the same bundle (`dist/mcp-server.mjs` + vendored `better-sqlite3`), engine id `causoryn@0.2.2`, stdio transport.

**Open 1.0.0 gates** (`CHANGELOG.md:7-24`, held open per ADR-010): Antigravity `agy` CLI install+smoke; ZCode in-GUI smoke; live macOS/ARM64 host smoke (`.github/workflows/ci.yml` `ubuntu-latest` + `windows-latest` + `macos-latest` CI matrix added in `K-020`/`K-022`); MCP SDK v1→v2 (closes `K-009`); watcher MCP surface + per-file parse reuse (B7; `refresh_index mode=incremental` enabled in `K-020`); C#/Python/Go/Rust TESTS edges (`adapters/typescript` `Test`/`TESTS` enabled in `K-020`); OpenAPI response-schema drift + event-version rule + SQL rename→unknown; snapshot blob revision automation (`export_documentation format=snapshot` producer added in `K-020`); `wiki_search` filters + `WIKI_NOTE_CONFLICT` guidance + incremental wiki index narrowing; E6 real browser verification (the interactive MCP export is available in `v0.2.2`); bare F1 bundle `.d.ts` fidelity (`packages/causoryn` stages `dist/typescript-lib/lib*.d.ts`); rate-limit budget (`K-010`; `scripts/secret-scan.mjs` 13 roots and `npm audit` 0 vulnerabilities closed in `K-022`). Until these close, 1.0.0 will not be declared.

[Implementation status](en/implementation-status.md) records historical acceptance evidence and open work. The [compatibility matrix](en/compatibility-matrix.md) shows the evidence available for each host.
