# Tool Sözleşmeleri — Yayımlanan 29 Araç (TŞ v2.1 §10.2 + §16A.8)

> Kanıt: `packages/mcp-server/src/version.ts` `TOOL_NAMES` (29 araç; `tools/list`
> TAM OLARAK bu küreyi sunar — boş handler yok, ADR-010) ·
> `packages/mcp-server/src/server.ts` (araç kayıtları + input/output schema'lar) ·
> `packages/mcp-server/src/errors.ts` (sabit hata kodu tablosu) ·
> `wiki/mcp-tools.md` (katalog) · Doğrulama testi: `tests/release-docs.test.ts`
> (tablo kümesi ↔ `TOOL_NAMES` birebir; bu dosyada başka araç adı geçemez).

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
| `causoryn_get_capabilities` | `workspace?` | Adapter düzeyleri L0–L4, sunucu limitleri, protokol revizyonu, yayımlanan araç listesi; snapshot gerektirmez | `WORKSPACE_NOT_AUTHORIZED` |
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
| `causoryn_wiki_build` | `workspaceId?`, `mode` (full\|incremental) | Yayımlanmış graph'tan deterministik WikiSnapshot üretir ve YALNIZCA `wiki.dataDbPath` beyanlı izinli data-root SQLite'ına atomik yazar; incremental desteklenmiyorsa graceful full + `fallbackReason` | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT`, `PATH_DENIED`, `EXPORT_NOT_ALLOWED` |
| `causoryn_wiki_get_tree` | `parentId?`, `depth?`, `limit?`, `cursor?` | 12 kök kategorili sayfa ağacı (taksonomi sırası, childCount, coverage/freshness); boş kategori `no_data` (dolgusuz) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_page` | `pageId`, `sectionKey?`, bölüm sayfalama | Tek sayfa: generated bölümler, evidenceRefs provenance, coverage/freshness; overlay anotasyonlar bu araçta dönmez (§16A.6 ayrı yerel akış) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_search` | `query`, `limit?`, `cursor?` | Kaçışlı çok alanlı FTS5 arama; sıralama exact route > başlık > modül > BM25 > graph yakınlığı; matchedFields+evidenceIds+snippet; embedding yok (kırmızı çizgi 1) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_links` | `pageId`, `direction?`, `linkKinds?`, sayfalama | outgoing+incoming (backlink) bağlantılar, resolution+evidence; bozuk link `toPageId:null` + brokenLinkDiagnostics (kayıt korunur) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT` |
| `causoryn_wiki_get_versions` | `pageId?`, `refs?`, sayfalama | Yayımlanmış WikiSnapshot revizyonu `available` (contentHash/linkSetHash/coverage); git alias'ları salt-okunur cat-file ile çözülür | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION` |
| `causoryn_wiki_diff` | `base`, `target`, `pageScope?` | added/removedPages, changedSections, link farkları, coverageDelta ({previous,current,reason?}), unresolvedDifferences, contractChanges (K-013 #7) | `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `PATH_DENIED`, `LIMIT_EXCEEDED` |

## Yazma izin matrisi (kırmızı çizgi 2)

| Araç | MCP `readOnlyHint` | Yazabileceği yer / bellek-içi yan etki |
|---|---|---|
| `causoryn_refresh_index` | `false` | Yalnızca Causoryn kendi indeks deposu — varsayılan stdio kablolamasında süreç-içi `InMemoryGraphRepository` veya beyan edilmişse `storage.dataDbPath` SQLite data-root (`allowRoots` dışında, mutlak yol; kaynak workspace salt-okunur taranır; Rust/Go sidecar ilk derlemeleri kendi toolchain `target`/cache dizinlerini kullanabilir) |
| `causoryn_export_documentation` | `false` | Yalnızca `output.allowedOutputDirs` beyanlı dizin (atomik `.tmp` + rename; varsayılan `[]` → `EXPORT_NOT_ALLOWED`) |
| `causoryn_wiki_build` | `false` | Yalnızca `wiki.dataDbPath` beyanlı data-root SQLite (workspace dışı, mutlak yol; ayrıca sunucu başlangıcında `openWikiStores` tanımlı `wiki.dataDbPath` üzerinde tekil workspace kaydını ilklendirir) |
| `causoryn_preflight_change` / `causoryn_verify_change` | `true` | **Diske ve çalışma ağacına hiçbir yere yazmaz** (`candidateOnly` sabit `true`, verify-only tip kilidi); `preflight_change` ürettiği manifesti `verify_change(preflightId)` çözümü için yalnızca süreç-içi `PreflightManifestStore` belleğinde (FIFO tavan 200) tutar |
| Diğer tüm araçlar (24 araç) | `true` | Salt okunur (workspace hiçbir koşulda yazılmaz — ADR-008) |

## Tekrar kullanma ilkesi

`causoryn_refresh_index` WikiSnapshot'ı otomatik güncellemez; wiki yenileme
`causoryn_wiki_build`'in kendisidir. `causoryn_export_documentation` bu dilimde her zaman
yayımlanmış graph snapshot'ını dışa aktarır (`view` parametresi verildiğinde açık
`INVALID_ARGUMENT` ile reddedilir — ADR-010). Ayrı `wiki_refresh`/`wiki_export`
aracı AÇILMAZ — wiki/mcp-tools.md katalog ilkesiyle aynıdır.

## İlgili sayfalar

- [docs/architecture.md](architecture.md) — paket haritası ve bağımlılık sınırları
- [docs/implementation-status.md](implementation-status.md) — araç yüzeylerinin faz faz kanıtları
- [docs/compatibility-matrix.md](compatibility-matrix.md) — host × sonuç matrisi
- `wiki/mcp-tools.md` — katalog ve yazma izni ilkesi · `packages/mcp-server/src/errors.ts` — kod tablosu
