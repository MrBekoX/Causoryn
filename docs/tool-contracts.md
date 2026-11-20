# Tool Sözleşmeleri — Yayımlanan 29 Araç (TŞ v2.1 §10.2 + §16A.8)

> Kanıt: `packages/mcp-server/src/version.ts` `TOOL_NAMES` (29 araç; `tools/list`
> TAM OLARAK bu küreyi sunar — boş handler yok, ADR-010) ·
> `packages/mcp-server/src/server.ts` (araç kayıtları + input/output schema'lar) ·
> `packages/mcp-server/src/errors.ts` (sabit hata kodu tablosu) ·
> `wiki/mcp-tools.md` (katalog) · Doğrulama testi: `tests/release-docs.test.ts`
> (tablo kümesi ↔ `TOOL_NAMES` birebir; bu dosyada başka araç adı geçemez) · **Dil / Language:** **Türkçe** | [English](en/tool-contracts.md)

Bu sayfa **özet**tir: yetkili sözleşme kaynak kodun `inputSchema`/`outputSchema`
alanlarıdır (Zod; yanıtta JSON Schema olarak yayınlanır). Tablo, host modelinin
hızlı referansı içindir; uyuşmazlıkta kaynak şema esastır.

## Standart envelope (TŞ §10.1)

Her yanıt 10 alanlı `EnvelopeSchema` (`z.strictObject`) sözleşmesini eksiksiz taşır:
`schemaVersion` ("2.0") + `requestId` + `workspaceId` + `snapshotId` +
`status` (ok | partial | error) + `coverage` + `warnings` + `data` + `nextCursor` +
`error` (10. alan; ok/partial durumunda `null`, hata durumunda `{code, message, retryable, userAction}`).
Hata kodları TŞ §10.1 sabit seti + üç proje uzantısıdır
(`packages/mcp-server/src/errors.ts` `CAUSORYN_TOOL_ERROR_CODES`, 15 kod; uzantılar K-008/K-011 ile kayıtlı, `UNSUPPORTED_LANGUAGE` rezerve sabit koddur);
her hata `retryable` + `userAction` rehberi taşır. Ayrıca `packages/mcp-server/src/server.ts`
yayımlanan 29 aracın tamamında yapısal MCP `annotations` (`readOnlyHint`, `destructiveHint: false`, `openWorldHint: false`)
sunar: yazma matrisindeki 3 araçta (`causoryn_refresh_index`, `causoryn_export_documentation`, `causoryn_wiki_build`)
`readOnlyHint: false`, geri kalan 26 araçta `readOnlyHint: true` beyan edilir. stdout yalnızca MCP protokol
trafiğidir; loglar `[causoryn]` önekiyle stderr'e gider (kırmızı kural 4).

**Evrensel kodlar (tablodan ayrı):** `INTERNAL_ERROR` her araçta beklenmeyen hata
kovasıdır (ham mesaj istemciye sızmaz, requestId korelasyonlu genel mesaj döner);
girdi şeması reddi SDK düzeyinde `isError` ile döner, şemayı geçen anlamsal girdi
hatası `INVALID_ARGUMENT` ile raporlanır.

## Hata kodu yöntem notu (dürüstlük)

Tablodaki kodlar iki kaynaktan derlenmiştir (2026-11-09): (1) `services*.ts`
handler gövdelerinin ve çağırdıkları hata-eşleme yardımcılarının
(`graphErrorToToolError`, `wikiErrorToToolError`, `contractErrorToToolError`,
`preflightErrorToToolError`, `verificationErrorToToolError`,
`indexingErrorToToolError`) statik taraması; (2) `errors.ts` başlığındaki ve
`wiki/decisions.md` K-008/K-011/K-012/K-014/K-015'teki ilk-kullanım kayıtları.
Statik tarama paylaşılan yardımcılar nedeniyle aşırı/dar kalabilir; kesin
eşleme kaynak kod + testlerdir (her aracın negatif testleri hata kodunu
sabitler — bkz. `docs/implementation-status.md`).

## Çekirdek 22 araç (TŞ §10.2 katalog sırası)

| Araç | Girdi (ana alanlar) | Çıktı (data özeti) | Tipik hata kodları |
|---|---|---|---|
| `causoryn_get_capabilities` | `workspace?` | Adapter düzeyleri L0–L4 (5 dil; C# `frameworkLinkers: "aspnet-core-route-attributes (L3)"`), sunucu kimliği (`SERVER_VERSION = "0.2.0"`, `SCHEMA_VERSION = "2.0"`), sunucu limitleri, protokol revizyonu, yayımlanan araç listesi; snapshot gerektirmez | `WORKSPACE_NOT_AUTHORIZED` |
| `causoryn_workspace_summary` | `workspaceId?` | Proje/framework/entrypoint/coverage özeti; sayılar yayınlanmış snapshot'tan türetilir; boş workspace `partial` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_index_status` | `jobId?` | Son (veya verilen) işin progress/snapshot/stale/tanıları; iş yoksa null + yönlendirici uyarı | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_refresh_index` | `mode` (`full` \| `incremental` — içerik karması karşılaştırmalı yenileme; B7 per-file parse reuse ve watcher MCP yüzeyi açık), `scope?` (açık ret) | Anında `jobId`; iş arka planda koşar; yalnızca izinli graph deposuna (`InMemoryGraphRepository` veya `storage.dataDbPath` SQLite) yazar | `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_map_system` | `level` (L0–L3; L3 `Function`/`Method`/`Handler`/`Endpoint`/`Test` kapsar), `filters?`, `maxNodes`, `cursor?` | Deterministik sıralı node+edge sayfaları; gerçek cursor sayfalama | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_find_symbols` | `query`, `kind?`, `limit?` | qualifiedName üzerinde tam/önek/içerir dereceli arama; belirsiz ad → aday listesi | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_symbol_context` | `symbolId` (node kimliği veya qualifiedName), `edgeKinds?`, `depth?` | Sembol node'u + derinliğe kadar komşu kenarlar + kanıt kayıtları | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_trace_execution` | `entrypoint` (endpoint adı/sembol), `maxDepth?`, `maxPaths?` | CALLS+ROUTES_TO üzerinde sınırlı çağrı yolları; kenar başına resolution+evidence ayrı; unresolved kenarda zincir durur (`partial`) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_trace_business_flow` | `flowSeed`, `boundaries?` | İş akışı zincirleri (ROUTES_TO/CALLS/PRODUCES/CONSUMES_CONTRACT/CONTAINS, bounded BFS + ters kontrat izleme); kopukluk `gap` segmentiyle dürüst raporlanır | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `INVALID_REVISION`, `CONTRACT_PARSE_FAILED` |
| `causoryn_analyze_impact` | `targets`/`diff`, `depth?`, `edgeKinds?` | Ters kenar bounded BFS etki yolları; certainty×resolution AYRI alanlar; "%100 etkilenecek" üretilmez; çözülemeyen hedefler `unresolvedTargets` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID` |
| `causoryn_check_architecture` | `policyId?`, `scope?` | `.causoryn/architecture.rules.yaml` değerlendirmesi: no-cycles (Tarjan SCC) + forbidden-dependency bulguları; baseline suppression + orphanSuppressions | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `POLICY_INVALID`, `INVALID_REVISION` |
| `causoryn_compare_architecture` | `baseRef`, `targetRef` | İki git ref arası mimari diff: node ek/çıkar/değişen kümeleri, belgeli confidence'lı rename, kenar + API yüzeyi değişimleri; salt-okunur git okuma | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |
| `causoryn_get_agent_context` | `task`, `candidateScope?`, `tokenBudget` (zorunlu) | exact-symbol → graph-proximity → contract → freshness → fts ayaklı bağlam paketi (`storage.dataDbPath` SQLite ile `symbol_fts` `fts` ayağı aktif; bellek-içi depoda degrade raporlanır); `estimatedTokens`, `omittedCount`, degrade ayaklar açık | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_generate_onboarding` | `audience` (beginner/intermediate/maintainer) | Yapısal onboarding verisi: giriş noktaları, ilk 5 merkezi modül, öğrenme sırası (SCC), kritik akışlar, riskli alanlar; doğal dil host modelin işidir | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_export_documentation` | `format` (json/markdown/mermaid/html/snapshot), `outputDir` (zorunlu), `fileName?`, `view?` (`view` açık `INVALID_ARGUMENT` reddi) | Deterministik graph snapshot dışa aktarma (`snapshot` formatı `compare_architecture`/`architecture_timeline` için kanonik `architecture-snapshot.json` üretir); yazma YALNIZCA `output.allowedOutputDirs` beyanlı dizinine atomiktir (.tmp+rename); HTML offline self-contained (CSP, CDN yok) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EXPORT_NOT_ALLOWED`, `PATH_DENIED` |
| `causoryn_preflight_change` | `intent`, `targetSymbols?`/`targetFiles?`, `baseSnapshot?` | ADAY Preflight Manifest: impactCandidates (certainty/resolution ayrı), contractChecks, testPlanId, limitations, sourceRevision; **diske kod/veri yazmaz** (candidateOnly sabit true; manifest yalnızca süreç-içi `PreflightManifestStore` FIFO 200 bellekte tutulur) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `AMBIGUOUS_SYMBOL`, `SYMBOL_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED` |
| `causoryn_check_contracts` | `contracts?` ({name?, base, target} spec çiftleri), `snapshotId?` | backward-safe/risk/breaking_candidate/unknown sınıflaması; kural adı + eski/yeni satır kanıtı; çift-bağlanamayan tanılar ayrı | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_detect_contract_drift` | `base`, `target`, `scope?`, `anchorFiles?` | Canonical drift: contractChanges ({contractId, changeKind, summary}), breaking/risk/unknown ayrı, PRODUCES/CONSUMES_CONTRACT etki grafı, `unconsumedChanges` (unresolved consumers) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `CONTRACT_PARSE_FAILED` |
| `causoryn_verify_change` | `preflightId?` / `baseSnapshot?` (en az biri), `target?` | Dört denetimli doğrulama raporu: architecture/contracts/graph-diff/test-plan; verdict sabit kural zincirinden: no_findings \| review_required \| blocking_findings \| inconclusive; test durumu `not_run` varsayılan (observed yalnızca evidenceRef+sha256 kanıtıyla); rapor byte-deterministik; **kod yazmaz, test çalıştırmaz** | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `LIMIT_EXCEEDED`, `PATH_DENIED`, `POLICY_INVALID` |
| `causoryn_derive_test_plan` | `changeSet` (changedSymbols/changedFiles) / `preflightId?` (bu yüzeyde açık ret) | Test adayları: direct (TESTS kenarı) + call-site (ters CALLS BFS) + naming (heuristic); reason+evidenceIds+matchLevel; `missingCoverageCandidates`; test ÇALIŞTIRILMAZ, plan kimliği `testplan:<sha256>` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED` |
| `causoryn_get_evidence` | `nodeId`/`edgeId`/`evidenceId`/`findingId` | Kanıt zinciri: relativePath+startLine/endLine+sourceHash+analyzerId+rationale; `targetId`/`chain` özeti; finding:<sha256> policy'den türetilir | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `EVIDENCE_NOT_FOUND`, `POLICY_INVALID` |
| `causoryn_architecture_timeline` | `refs`/`range`, `granularity?` | Git noktalarında deterministik örneklenmiş diff zaman çizelgesi + Faz E ihlal trendi (no-cycles/forbidden nokta başına ayrı; kalite tek sayıya indirgenmez); atlanan noktalar açık listelenir | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `POLICY_INVALID`, `LIMIT_EXCEEDED` |

## Wiki 7 aracı (TŞ §16A.8; `wiki_build` tek yazma aracıdır)

| Araç | Girdi (ana alanlar) | Çıktı (data özeti) | Tipik hata kodları |
|---|---|---|---|
| `causoryn_wiki_build` | `workspaceId?`, `mode` (full\|incremental), `revision?`, `scope?` (açık ret) | Yayımlanmış graph'tan deterministik WikiSnapshot üretir ve YALNIZCA `wiki.dataDbPath` beyanlı (veya `--auto-data-dir` ile hazırlanan) izinli data-root SQLite'ına atomik yazar; incremental desteklenmiyorsa graceful full + `fallbackReason` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `PATH_DENIED`, `EXPORT_NOT_ALLOWED` |
| `causoryn_wiki_get_tree` | `parentId?`, `depth?`, `limit?`, `cursor?` | 12 kök kategorili sayfa ağacı (taksonomi sırası, childCount, coverage/freshness); boş kategori `no_data` (dolgusuz) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_page` | `pageId`, `sectionKey?`, bölüm sayfalama | Tek sayfa: generated bölümler, evidenceRefs provenance, coverage/freshness; overlay anotasyonlar bu araçta dönmez (§16A.6 ayrı yerel akış) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_search` | `query`, `snapshotId?`, `limit?`, `cursor?` (ek filtreler bu dilimde açık `INVALID_ARGUMENT`) | Kaçışlı çok alanlı FTS5 arama; sıralama exact route > başlık > modül > BM25 > graph yakınlığı; matchedFields+evidenceIds+snippet; embedding yok (kırmızı çizgi 1) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, `LIMIT_EXCEEDED` |
| `causoryn_wiki_get_links` | `pageId`, `direction?`, `linkKinds?`, sayfalama | outgoing+incoming (backlink) bağlantılar, resolution+evidence; bozuk link `toPageId:null` + brokenLinkDiagnostics (kayıt korunur) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_versions` | `pageId?`, `refs?`, sayfalama | Yayımlanmış WikiSnapshot revizyonu `available` (contentHash/linkSetHash/coverage); git alias'ları salt-okunur cat-file ile çözülür (`working-tree` `.git` olmadan da çözülür) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION` |
| `causoryn_wiki_diff` | `base`, `target`, `pageId?` | added/removedPages, changedSections, link farkları, coverageDelta ({previous,current,reason?}), unresolvedDifferences, contractChanges (K-013 #7) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `PATH_DENIED`, `LIMIT_EXCEEDED` |

## Sunucu sürümü, 5-dil yetenek matrisi ve sabit 15 hata kodu (v0.2.0)

### 1. Sunucu kimliği ve protokol sabitleri (`packages/mcp-server/src/version.ts`)

- `SERVER_NAME = "causoryn"` — MCP `initialize` el sıkışmasındaki `serverInfo.name`.
- `SERVER_VERSION = "0.2.0"` — Pre-1.0 Public Preview sürümü (K-022; kök `package.json`, `packages/causoryn/package.json` ve `server.json` ile kilitlidir; ADR-010 gereği açık 1.0.0 kapıları kapanmadan `1.0.0` ilan edilmez).
- `SCHEMA_VERSION = "2.0"` — 29 aracın tamamında `envelope.schemaVersion` alanı.
- `protocol.revision` — `@modelcontextprotocol/sdk` üzerinden `LATEST_PROTOCOL_VERSION`.

### 2. `causoryn_get_capabilities` 5-dil adapter matrisi (`INDEXED_ADAPTERS`)

`causoryn_get_capabilities` aracı snapshot gerektirmeden `packages/indexing/src/index.ts` içindeki `INDEXED_ADAPTERS` kaydını döndürür. Kalıcı SQLite `analyzerFingerprint` geriye dönük uyumu için iç dil analizör protokol sürümleri bilinçli olarak `"0.1.0"` değerinde tutulur (K-022):

| Dil (`language`) | `analyzerId` | `astParse` | `symbolResolution` | `frameworkLinkers` | Çalışma modeli |
|---|---|---|---|---|---|
| `typescript` | `ts-adapter` | `L1` | `L2` | `express+nextjs` | Süreç-içi TypeScript Compiler API (`TypeChecker` + Express/Next.js App Router L3 + BDD `Test`/`TESTS`) |
| `csharp` | `roslyn-worker` | `L1` | `L2` | `aspnet-core-route-attributes (L3)` | `dotnet exec` Roslyn sidecar (`@causoryn/sidecar-ipc`; ASP.NET Core controller attribute + Minimal API `MapGet`/`MapPost`) |
| `python` | `python-worker` | `L1` | `L2` | `decorator-route-pattern (L3)` | `python -B` stdlib `ast` sidecar (sıfır dış bağımlılık) |
| `go` | `go-worker` | `L1` | `heuristic-only (semantik L2 yok)` | `http-router-registration (L3)` | Go stdlib `go/parser` + `go/ast` sidecar (`net/http`, `gin`, `echo`, `chi`) |
| `rust` | `rust-worker` | `L1` | `heuristic-heavy` | `attribute-macro-route (L3)` | Rust `syn` 2 sidecar (`axum`, `actix-web`, `rocket` öznitelik makroları) |

### 3. Sabit 15 hata kodu tablosu (`CAUSORYN_TOOL_ERROR_CODES`)

Tüm iş-mantığı ve yetkilendirme hataları protokol hatası olarak değil, `isError: false` ile `envelope.error` (`{ code, message, retryable, userAction }`) içinde döner; yalnızca `INDEX_NOT_READY` ve `INTERNAL_ERROR` kodlarında `retryable: true` beyan edilir:

| Hata kodu (`code`) | `retryable` | Kaynak / yönetişim | Özeti ve istemci aksiyonu (`userAction`) |
|---|---|---|---|
| `WORKSPACE_NOT_AUTHORIZED` | `false` | TŞ §10.1 sabit set | `workspaceId` uyuşmazlığı veya `allowRoots` dışında/boş kök; çalışma alanı kökünü yetkili listeye ekletin |
| `PATH_DENIED` | `false` | TŞ §10.1 sabit set | Ignore politikası, traversal/null-byte reddi veya beyansız `wiki.dataDbPath` yazma denemesi |
| `INDEX_NOT_READY` | `true` | TŞ §10.1 sabit set | Yayımlanmış `ready`/`partial` GraphSnapshot veya WikiSnapshot henüz yok; `causoryn_refresh_index` / `causoryn_wiki_build` sonrası yeniden deneyin |
| `AMBIGUOUS_SYMBOL` | `false` | TŞ §10.1 sabit set | Birden fazla sembol eşleşti; `envelope.data` aday listesini taşır (`kind`/`limit` veya tam kimlikle daraltın) |
| `LIMIT_EXCEEDED` | `false` | TŞ §10.1 sabit set | `maxNodes`, `maxSymbols`, `maxDepth`, `maxPaths` veya Wiki `limit` (tavan 200) aşıldı |
| `INVALID_ARGUMENT` | `false` | Proje uzantısı (K-008) | Zod şemasını geçen anlamsal girdi hatası, bozuk `cursor` veya bu dilimde açık reddedilen parametre (`scope`, `export_documentation(view)`, ek `wiki_search` filtreleri) |
| `EVIDENCE_NOT_FOUND` | `false` | Proje uzantısı (K-008) | Snapshot'ta bulunmayan `nodeId`/`edgeId`/`evidenceId`/`findingId` veya `wikiSnapshotId` |
| `SYMBOL_NOT_FOUND` | `false` | Proje uzantısı (K-011) | Snapshot'ta bulunmayan sembol kimliği, `qualifiedName` veya `entrypoint`/`flowSeed` |
| `POLICY_INVALID` | `false` | TŞ §10.1 sabit set (K-012) | `.causoryn/architecture.rules.yaml` veya baseline dosyası eksik/şema dışı |
| `INVALID_REVISION` | `false` | TŞ §10.1 sabit set (K-012/K-013 #6) | Çözümlenemeyen Git ref/alias veya ref içinde `.causoryn/architecture-snapshot.json` blob'u yok |
| `EXPORT_NOT_ALLOWED` | `false` | TŞ §10.1 sabit set (K-012) | Hedef `outputDir` sunucunun `output.allowedOutputDirs` beyanında değil (default deny) |
| `WIKI_PAGE_NOT_FOUND` | `false` | TŞ §10.1 sabit set (K-014) | İlgili `WikiSnapshot` içinde `pageId` veya `parentId` bulunamadı |
| `CONTRACT_PARSE_FAILED` | `false` | TŞ §10.1 sabit set (K-015) | OpenAPI/AsyncAPI/JSON Schema/SQL/Proto sözleşme dosyası ayrıştırılamadı veya boyut kotasını aştı |
| `UNSUPPORTED_LANGUAGE` | `false` | TŞ §10.1 rezerve sabit kod | Mevcut dilimde eksik sidecar'lar L0/L1 dosya düğümlerine zarifçe düştüğü için servislerce fırlatılmaz; şema uyumu için rezerve tutulur |
| `INTERNAL_ERROR` | `true` | TŞ §10.1 sabit set | Beklenmeyen iç hata; ham sürücü/dosya yolu detayı yalnızca `stderr`'e yazılır, istemciye `requestId` korelasyonlu genel mesaj döner |

### 4. Sayfalama ve sunucu limitleri

- **Opak cursor (`packages/mcp-server/src/cursor.ts`):** `{ "v": 1, "o": <int> }` yapısının `base64url` kodlamasıdır. Bozuk veya kurcalanmış cursor `INVALID_ARGUMENT` döndürür; son sayfada hem `envelope.nextCursor` hem `data.nextCursor` `null` olur.
- **Varsayılan limitler (`causoryn_get_capabilities.data.limits`):** `maxFiles`, `maxFileBytes`, `maxNodes` (varsayılan 250), `maxSymbols` (varsayılan 100), `maxDepth` (varsayılan 3), `maxPaths` (varsayılan 50); Wiki sayfalamalı araçlarında `limit` varsayılan 50, üst sınır 200'dür (K-013 #5).

## Yazma izin matrisi (kırmızı çizgi 2)

| Araç | MCP `readOnlyHint` | Yazabileceği yer / bellek-içi yan etki |
|---|---|---|
| `causoryn_refresh_index` | `false` | Yalnızca Causoryn kendi indeks deposu — varsayılan çıplak stdio kablolamasında süreç-içi `InMemoryGraphRepository` veya beyan edilmişse (`CAUSORYN_CONFIG` ya da `--auto-data-dir`) `storage.dataDbPath` SQLite data-root (`allowRoots` dışında, mutlak yol; kaynak workspace salt-okunur taranır; Rust/Go sidecar ilk derlemeleri kendi toolchain `target`/cache dizinlerini — ör. `~/.causoryn/cache/rust-worker-target` — kullanabilir) |
| `causoryn_export_documentation` | `false` | Yalnızca `output.allowedOutputDirs` beyanlı dizin (atomik `.tmp` + rename; çıplak modda varsayılan `[]` → `EXPORT_NOT_ALLOWED`; `--auto-data-dir` modunda workspace-dışı `exports/` dizini otomatik tanımlanır) |
| `causoryn_wiki_build` | `false` | Yalnızca `wiki.dataDbPath` beyanlı data-root SQLite (workspace dışı, mutlak yol; `--auto-data-dir` modunda `storage.dataDbPath` ile aynı workspace-dışı SQLite dosyasına bağlanır; ayrıca sunucu başlangıcında `openWikiStores` tanımlı `wiki.dataDbPath` üzerinde tekil workspace kaydını ilklendirir) |
| `causoryn_preflight_change` / `causoryn_verify_change` | `true` | **Diske ve çalışma ağacına hiçbir yere yazmaz** (`candidateOnly` sabit `true`, verify-only tip kilidi); `preflight_change` ürettiği manifesti `verify_change(preflightId)` çözümü için yalnızca süreç-içi `PreflightManifestStore` belleğinde (FIFO tavan 200) tutar |
| Diğer tüm araçlar (24 araç) | `true` | Salt okunur (workspace hiçbir koşulda yazılmaz — ADR-008) |

## Tekrar kullanma ilkesi

`causoryn_refresh_index` WikiSnapshot'ı otomatik güncellemez; wiki yenileme
`causoryn_wiki_build`'in kendisidir. `causoryn_export_documentation` bu dilimde her zaman
yayımlanmış graph snapshot'ını dışa aktarır (`view` parametresi verildiğinde açık
`INVALID_ARGUMENT` ile reddedilir — ADR-010). Ayrı `wiki_refresh`/`wiki_export`
aracı AÇILMAZ — `wiki/mcp-tools.md` katalog ilkesiyle aynıdır.

## Sıfır-ayar CLI, dinamik kök bağlama ve `outputSchemaProfile` sözleşmesi (K-021)

`packages/mcp-server/src/runtime-cli.ts` ve `packages/mcp-server/src/server.ts`, hem deterministik gömülü/test kullanımını hem de sıfır-ayar CLI ve masaüstü IDE eklentilerini aynı güvenlik sınırlarıyla destekler:

1. **`--output-schema-profile omit|full` ve %100 sunucu-içi şema doğrulaması:**
   - Öncelik sırası (`resolveEffectiveOutputSchemaProfile`): `--output-schema-profile <full|omit>` bayrağı > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` ortam değişkeni > (`hasCliActivation ? "omit" : "full"`).
   - **Programatik ve çıplak mod (`outputSchemaProfile: "full"`):** `createCausorynMcpServer(context)` ve sıfır argümanlı `node dist/mcp-server.mjs` çağrısı varsayılan olarak 29 aracın tamamında tam JSON Schema `outputSchema` yayınlar ve `CAUSORYN_CONFIG` yoksa `allowRoots: []` (default deny) uygular.
   - **CLI / Plugin modu (`causoryn mcp --allow-cwd --auto-data-dir [--client <id>]`):** CLI ajanlarında (Claude Code, Codex, ZCode, Antigravity) `tools/list` yanıtındaki büyük JSON Schema yükünün host modelinin bağlam penceresini (context token) tüketmemesi için varsayılan `outputSchemaProfile: "omit"` kullanılır (`--output-schema-profile full` veya `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full` ile tam şema açılabilir). **`omit` modunda dahi sunucu her araç yanıtını döndürmeden önce `registration.outputSchema.parse(envelope)` (`server.ts:562-564`) çalıştırır**; böylece tel üzerinde token tasarrufu sağlanırken çalışma zamanı sözleşme sadakati %100 korunur.
2. **Güvenli `--allow-cwd` filtresi ve dinamik MCP `roots/list` bağlaması (`attachMcpRootsWorkspaceBinder`):**
   - `inspectProjectRootSafety`, dosya sistemi köklerini (`/`, `C:\`), kullanıcı ev dizinini (`$HOME`), Causoryn veri dizinlerini (`~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`), eklenti/bundle kurulum dizinlerini (`~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, `bundle-manifest.json`), hassas kullanıcı dizinlerini (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`) ve işletim sistemi dizinlerini (`/etc`, `/usr`, `/System`, `C:\Windows`, `C:\Program Files`) fail-closed reddeder.
   - Başlangıç `cwd` güvenli bir proje diziniyse anında bağlanır; masaüstü IDE'lerde olduğu gibi uygunsuz bir `cwd` ile başlatıldığında sunucu `allowRoots: []` ile güvenli başlar ve `oninitialized`, `beforeToolCall` ile `notifications/roots/list_changed` kancalarında single-flight MCP `roots/list` sorgusu üzerinden ilk güvenli `file://` köküne atomik olarak bağlanır (`DynamicCausorynContext.rebind`).
3. **Kaynak ağacı dışı `--auto-data-dir` hazırlama (`buildWorkspaceAutoConfig`):**
   - Taban veri dizinini (`--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`) çözer ve birincil yetkili kökün kanonik yolundan `<slug>-<hash12>` kimliği türeterek `~/.causoryn/workspaces/<slug>-<hash12>/` altında `graph[-<client>].sqlite` (`storage.dataDbPath` + `wiki.dataDbPath`) ve `exports/` (`output.allowedOutputDirs`) yollarını otomatik hazırlar.
   - Tek bir klasör bile oluşturulmadan önce tüm üst dizinlerin sembolik/sarkan bağ içermediği (CWE-59) ve yetkili `allowRoots` ağaçlarının kesinlikle dışında kaldığı (ADR-008) doğrulanır; dizinler `0o700` izniyle açılır ve oluşturma sonrasında `realpathSync` ile TOCTOU kontrolü tekrarlanır.

## İlgili sayfalar

- [Dokümantasyon İndeksi](README.md) — tüm TR/EN dokümanların giriş sayfası
- [docs/architecture.md](architecture.md) — paket haritası ve bağımlılık sınırları
- [docs/cli-and-configuration.md](cli-and-configuration.md) — CLI bayrakları, ortam değişkenleri ve `CAUSORYN_CONFIG` şeması
- [docs/language-analyzers.md](language-analyzers.md) — 5 dil analizörü ve çözümleme dürüstlüğü
- [docs/wiki-spec.md](wiki-spec.md) — Living Wiki Engine tasarım ve v0.2.0 uygulama sözleşmesi
- [docs/implementation-status.md](implementation-status.md) — araç yüzeylerinin faz faz kanıtları
- [docs/compatibility-matrix.md](compatibility-matrix.md) — host × sonuç matrisi
- `wiki/mcp-tools.md` — katalog ve yazma izni ilkesi · `packages/mcp-server/src/errors.ts` — kod tablosu
