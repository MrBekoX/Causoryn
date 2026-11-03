# Implementation Status — Sprint 1 (Faz A: Foundation)

> Kanıt: sprint-1 görev sonucu raporları (orkestratör doğrulamalı, t1–t8) + disk spot-check (bu oturum, 2026-11-03) + kapı sonuçları · TŞ v2.1 §25, ADR-010 · [wiki/sprint-1.md](../wiki/sprint-1.md)

> **ADR-010 kuralı (TŞ):** Çalışmayan şey Done yazılmaz. Aşağıdaki tabloda her durum, görevin kabul ölçütlerinin o anki diskteki ve rapordaki gerçek haline göre verilmiştir; eksik kalan her kalemin kendisi belirtilmiştir.

## Kanıt işaretleri (efsane)

| İşaret | Anlamı | Kimin doğrulaması |
|---|---|---|
| **[D]** | Bu doküman yazılırken bizzat diskte doğrulandı (dosya okuma, `grep`, `ls`, `git diff`) | Bu dokümanı yazan ajan |
| **[R]** | Orkestratör tarafından doğrulanmış görev sonucu raporu (görev süresinde koşuldu) | Orkestratör |
| **[K]** | Kapı sonucu: `npm run test` / `typecheck` / `build` / `lint` — **orkestratör çalıştırdı, tümü yeşil**; bu dokümanı yazan ajan süiti tekrar koşmadı | Orkestratör |
| **[S]** | Statik sayım: test dosyasındaki `it(`/`test(` bloklarının `grep` ile sayımı — **koşum sayısı değildir** | Bu dokümanı yazan ajan |

## Sprint 1 görev tablosu

| # | Görev | Durum | Kanıt |
|---|---|---|---|
| 1 | Repo/package ve test araçları; `docs/architecture.md`, `docs/adr/ADR-002-no-llm.md` | **Done** | **[D]** Kök `package.json`: `workspaces: ["packages/*","adapters/*","integrations/*/*"]`, `scripts: test/build/typecheck/lint`, `private:true`, `engines.node>=24`; `tsconfig.base.json`: `strict:true`, `module/moduleResolution:nodenext`, `declaration:true`; `docs/architecture.md`, `docs/adr/ADR-002-no-llm.md`, `tests/smoke.test.ts` (13 [S] test bloğu) diskte. **[R]** t1: 8 madde tek tek doğrulandı; FTS5 çalışma kanıtı (`FTS5_OK`); TS 5.9.3 pin gerekçesi (typescript-eslint peer aralığı). **[K]** dört kapı yeşil. |
| 2 | `WorkspaceAccessPolicy`: explicit root authorization, ignore, symlink escape, binary/size filtresi | **Done** | **[D]** `packages/workspace/src/workspace-access-policy.ts` başlığında sabit karar sırası (kök yetkilendirme → null byte → leksik `..` → ignore → realpath CWE-59 → **5b kanonik yola ignore re-check** → uzantı/boyut) ve TŞ §19 post-open re-check TOCTOU sözleşmesi yazılı; `policy-config.ts`, `ignore-matcher.ts`, `policy-error.ts` mevcut; test dosyasında 53 [S] blok. **[R]** t2: takım denetiminin 6 bulgusu işlendi; 4 davranışsal bulgu (kanonik ignore bypass, `sizeBytes` NaN/negatif, çok segmentli uzantı, `..foo` over-deny) TDD ile — kırmızı kanıtlanıp yeşile getirildi; 142/142. |
| 3 | `GraphNode/GraphEdge/Evidence/GraphSnapshot` — Zod schema + deterministic ID | **Done** | **[D]** `packages/domain/src/graph-kinds.ts` birebir okundu: `NODE_KINDS` = **27**, `EDGE_KINDS` = **20** (TŞ §8 listesi); `graph-schema.ts`, `snapshot.ts`, `canonical-json.ts`, `ids.ts`, `sha256.ts` diskte; domain testleri 75 [S] blok (39 graph-schema). **[R]** t3: kırmızı-first (`Cannot find module '../src/graph-schema.js'`), sonra 76/76; verified-edge ≥1 evidence, dangling/duplicate refine, deep-freeze, iki bağımsız kurulumda aynı canonical JSON + aynı snapshot ID. |
| 4 | TypeScript Compiler API adapter + `POST /orders → OrdersService → repository` fixture kanıtı | **Done** | **[D]** `adapters/typescript/src/{analyzer,index,types}.ts`; fixture 5 dosya (`examples/fixture-ts-orders/src/app.ts`, `http/router.ts`, `routes/orders.ts`, `services/orders-service.ts`, `repositories/order-repository.ts`); adapter testi 22 [S] blok. **[R]** t4: kırmızı-first (`analyzeTypeScriptProgram is not a function`), sonra 22/22; CONTAINS/IMPORTS/CALLS/ROUTES_TO kanıt zincirleri fixture satırlarıyla (`router.post("/orders"`, `ordersService.create(`, `this.repository.save(`) eşleşti; broken.ts `state=partial` izolasyonu; çözülemeyen çağrı `unresolved` (uydurma node yok); determinizm (bit-bit aynı JSON). **[D]** `package-lock.json`'da `adapters/typescript` kaydı var (satır 28; t4 raporundaki lock eksikliği artık lock'ta görünüyor — kesin senkron doğrulaması `npm ci` gerektirir, koşulmadı). |
| 5 | In-memory GraphRepository + SQLite adapter; atomic snapshot testleri | **Done** | **[D]** `packages/graph/src/{repository,errors,build-id,validation,finalize,memory-repository,index}.ts` ve `packages/storage-sqlite/src/{schema,sqlite-repository,index}.ts` diskte; graph 16 + sqlite 16 + round-trip 3 [S] blok; `tests/smoke.test.ts`'te `SCAFFOLD_PACKAGE_DIRS: []` — tüm paketler gerçek implementasyon, scaffold dürüstlük listesi boşaldı. **[R]** t5: kırmızı-first (34 fail, implementasyon yokken), sonra 199/199; atomic publish (building görünmez, stale bayrağı), transaction rollback (`graph/publish-failed`), dangling edge reddi (iki gerçeklemede), bellek↔SQLite `snapshotCanonicalJson` birebir, WAL + `foreign_keys=1` satır bazında, FTS5 published-only parametreli MATCH. |
| 6 | MCP stdio server: `get_capabilities`, `workspace_summary`, `map_system`, `find_symbols` | **Done** | **[D]** `packages/mcp-server/src/{server,envelope,errors,services,stdio,context,cursor,config,version,index}.ts` diskte; `errors.ts:36-57` kod→(retryable, userAction) sabit tablosu; `packages/indexing/src/{index-service,inventory,errors,index}.ts` pipeline mevcut; mcp-server 21 + indexing 6 [S] blok. **[R]** t6: retryable/userAction eksikliği TDD ile kırmızı → yeşil (16/16); boş workspace partial üçlüsü (summary+map+find_symbols `status=partial`); INVALID_ARGUMENT'ın "tek proje uzantısı" olduğu dürüstçe düzeltildi; son durum 222/222. **[K]** kapılar yeşil. |
| 7 | `get_evidence` ile en az bir CALLS edge'inin kaynak dosya/satır doğrulaması | **Done** | **[D]** `packages/mcp-server/src/server.ts:109` `causoryn_get_evidence` kaydı; 5 tool adı grep ile (`get_capabilities`, `workspace_summary`, `map_system`, `find_symbols`, `get_evidence`); `errors.ts:23` `EVIDENCE_NOT_FOUND` (başlık notu: TŞ §10.1'de yok — INVALID_ARGUMENT gibi proje uzantısı). **[R]** t7: kırmızı-first (7 failed), sonra 20/20; entegrasyon kanıtı tamamen MCP araçlarıyla: `find_symbols → map_system` ile OrdersService.create → OrderRepository.save CALLS kenarı bulunur, `get_evidence` span'i fixture **diskten** okunup `this.repository.save(` satırı + `sourceHash=sha256(dosya)` + `analyzerId='ts-adapter'` ile doğrulanır; 225/225. **[K]** kapılar yeşil. |
| 8 | ZCode plugin paketi: `plugin.json` (mcpServers + skills), `map-system` skill'i, README | **Done** | **[D]** `integrations/zcode/causoryn/.zcode-plugin/plugin.json` birebir okundu: `mcpServers.causoryn` (stdio, `packages/mcp-server/dist/stdio.js`, `CAUSORYN_CONFIG` ← `userConfig.config_json`, default `allowRoots:[]` — yetkisiz kök reddi) + `skills:"skills"`; `skills/map-system/SKILL.md` (araya yerleşen frontmatter + argüman/envelope/hata kurtarma yönlendirmesi); `README.md`; `test/plugin-package.test.ts` 12 [S] blok. **[R]** t8: README hata kodu bağlantı testi TDD (kırmızı: `EVIDENCE_NOT_FOUND` eksikti) → 12/12; 237/237; TŞ §10.1 18 kodluk taban liste birincil kaynaktan (pymupdf çıkarımı) doğrulandı. |
| 9 | Unit/integration/security testleri; `docs/implementation-status.md` tablosu | **Done** | **[D]** Envanter: 16 test dosyası, 238 [S] test bloğu (detay aşağıda "Test kapsamı"); güvenlik düzeltmeleri diff ile okundu: (1) `packages/domain/src/snapshot.ts` `asJsonValue` → `Object.defineProperty` (`__proto__` own anahtarının sessiz veri kaybı giderildi) + yeni `snapshot-attributes.test.ts` (3 blok: pozitif korunum, negatif prototype-pollution yok, partial); (2) `packages/mcp-server/src/server.ts` INTERNAL_ERROR artık genel mesaj + requestId korelasyonu döndürüyor, ham sürücü mesajı yalnızca stderr loguna — `mcp-server.test.ts`'e 2 güvenlik testi (`SQLITE_CONSTRAINT`/`D:\gizli` sızmaz, Error olmayan throw sızmaz). **[K]** Orkestratör güvenlik analizi: 2 bulgu, ikisi giderildi, kapılar yeniden yeşil. Bu dosya = görevin doküman kalemi. **Not:** bu 4 dosya çalışma ağacında commit edilmemiş (commit orkestratörde). |
| 10 | `docs/wiki-spec.md`: sayfa türleri, snapshot/page/link/annotation şemaları, 7 Wiki aracı sözleşmesi | **Done** | **[D]** `docs/wiki-spec.md` (≈37 KB) diskte; başlık + bölüm yapısı + örnek şemalar bizzat okundu: §2.1 12 kök kategorili sayfa ağacı, §2.2 16 `kind` tablosu, §3.0–3.7 Zod taslak şemalar (WikiSnapshot, WikiPage/Section, WikiLink, WikiPageVersion, WikiAnnotation overlay, WikiPageAlias, WikiSearchIndex FTS5), §4.2.1–4.2.7 tam 7 Wiki aracı (`causoryn_wiki_build/get_tree/get_page/search/get_links/get_versions/diff` — input/output şema + hata kodları + davranış); örneklenen bölümler gerçek içerikli (TŞ §16A atıflı, `[TASLAK ÖNERİ]` etiketli) — boş stub yok. Başlıkta ADR-010 dürüstlük beyanı: "implement edilmeyen tasarım sözleşmesi, Living Wiki Not Started". **Not:** bu göreve ait orkestratör doğrulama raporu verilmedi; kanıt bu oturumun disk doğrulamasıdır [D]. |
| 11 | Sonraki fazlar için bağımlılık sıralı issue backlog'u | **Done** | **[D]** `docs/BACKLOG.md`: faz sırası A→B→C→D→E→F (sert bağımlılık zinciri), bağımlılık grafiği (C2'nin tek sert bağımlılığı A; paralellikler), D iç sırası D1→D2→D3→D5→D6→D4, kapsam notu (ADR-010 ruhu), faz→issue eşleme tablosu. **[D]** GitHub issue'ları bu oturumda `gh issue list --repo MrBekoX/Causoryn` ile doğrulandı: #1–#6 açık ve başlıklar BACKLOG ile birebir (Phase B: Deep Mapping … Phase F: Cross-host Release). Referans verilen `wiki/sprint-2.md`–`sprint-7.md`, `wiki/roadmap.md` diskte mevcut. |

**Sprint 1 geneli: 11/11 görev Done.**

## Test kapsamı (görev 9 envanteri)

Statik sayım [S] — `grep -cE "^\s*(it|test)\("`, dosya başına; koşum sonucu değildir (son koşum: orkestratör kapısı [K], yeşil):

| Alan | Dosyalar | [S] blok |
|---|---|---|
| `packages/domain` | canonical-json 7, graph-schema 39, ids 17, sha256 4, snapshot-attributes 3, utf8 5 | 75 |
| `packages/workspace` | workspace-access-policy 53 | 53 |
| `packages/indexing` | index-service 6 | 6 |
| `packages/graph` | repository 16 | 16 |
| `packages/storage-sqlite` | sqlite-repository 16, round-trip 3 | 19 |
| `packages/mcp-server` | mcp-server 21, stdio-stdout 1 | 22 |
| `adapters/typescript` | typescript-adapter 22 | 22 |
| `integrations/zcode/causoryn` | plugin-package 12 | 12 |
| `tests` | smoke 13 | 13 |
| **Toplam** | 16 dosya | **238** |

Test türleri: unit (domain/workspace/graph schema & politika), integration (adapter→`createSnapshot`→repository; bellek↔SQLite round-trip; MCP istemci↔sunucu InMemoryTransport çağrıları; stdio stdout hijyeni), security (path traversal, symlink/junction escape, `__proto__` attribute hardening, INTERNAL_ERROR bilgi sızması, SQL parametreleme davranışı, allowRoots default-deny).

## Güvenlik analizi sonuçları (görev 9)

Orkestratör raporu [K]: analiz 2 bulgu üretti, ikisi giderildi ve kapılar yeniden yeşile alındı. Bu oturumda diff'ler birebir doğrulandı [D]:

1. **`__proto__` attribute bütünlüğü** — `packages/domain/src/snapshot.ts`: `asJsonValue`'daki `out[key] = value` ataması `key === "__proto__"` olduğunda `Object.prototype`'ın inherited setter'ına gidiyor ve own anahtar sessizce düşüyordu; `Object.defineProperty` ile own data property yazımı sağlandı. Yeni test: `packages/domain/test/snapshot-attributes.test.ts` (3 blok).
2. **INTERNAL_ERROR bilgi sızması** — `packages/mcp-server/src/server.ts`: beklenmeyen hatanın ham mesajı (sürücü detayı, tablo adı, mutlak yol) istemciye değil yalnızca stderr loguna; istemciye `requestId` korelasyonlu genel mesaj. Yeni testler: `packages/mcp-server/test/mcp-server.test.ts` (+2 blok).

## Açık kalemler (durumu etkilemeyen, orkestratör/kullanıcıya notlar)

1. **Commit planı**: HEAD `4eeb1e5`; görev-9 güvenlik düzeltmeleri (4 dosya: `snapshot.ts`, `snapshot-attributes.test.ts`, `server.ts`, `mcp-server.test.ts`) çalışma ağacında commit edilmemiş — commit/push orkestratör kalemidir.
2. **wiki kayıtları** (wiki yazma yasağı nedeniyle görev ajanları yazamadı): `wiki/decisions.md`'e ADR/K girişleri — (a) `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND` uzantı hata kodları (TŞ §10.1 18 kodluk taban listede yok; kanıt: `packages/mcp-server/src/errors.ts:6-26` + birincil kaynak doğrulaması), (b) SDK sürüm sapması (kurulu `@modelcontextprotocol/sdk` 1.32.2 / v1.x vs TŞ §6 SDK v2 hedefi; `packages/mcp-server/src/index.ts:17-21` beyanı), (c) rate-limit/concurrency limitlerinin Faz A kapsam dışı beyanı (TŞ §10 resource budget). `wiki/log.md`'e `dev` girişleri.
3. **npm audit**: 10 moderate uyarı kalıyor — tek kök: `minimatch <11.0.1` (GHSA-g3hv-75wg-m249), yalnızca dev-toolchain (eslint 10 + typescript-eslint 8 transitive); önerilen `npm audit fix --force` eslint'i v4'e düşürür, uygulanmadı.
4. **Kapsam notları** (görev raporlarından [R]): t4 `heuristicCandidatePath` dalı testle kapsanmıyor; SQLite gerçekleme tek bağlantılı/senkron, eşzamanlı yazıcı sözleşmesi Faz A'da tanımlı değil, snapshot silme API'si yok (FTS5 temizliği gerektirir); `tests/smoke.test.ts`'teki "MCP stdio server + 4 araç" yorumu 5 araçla bayat (yalnızca yorum, assertion değil); `docs/wiki-spec.md` §8'de implementasyon öncesi karar bekleyen açık konular var.

## İlgili sayfalar

- [docs/architecture.md](architecture.md) — paket haritası ve bağımlılık sınırları
- [docs/BACKLOG.md](BACKLOG.md) — faz bağımlılık sıralaması (görev 11 çıktısı)
- [docs/wiki-spec.md](wiki-spec.md) — Living Wiki tasarım sözleşmesi (görev 10 çıktısı)
- [docs/adr/ADR-002-no-llm.md](adr/ADR-002-no-llm.md) — LLM'siz motor kararı
- [wiki/sprint-1.md](../wiki/sprint-1.md) · [wiki/architecture.md](../wiki/architecture.md) · [wiki/decisions.md](../wiki/decisions.md)
