# Living Wiki Engine — Tasarım ve Uygulama Sözleşmesi

> Kanıt: `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` (TŞ v2.1) — §16A s.14–18, §10 s.9–10, §8–§9 s.8–9, §19–§20 s.21–22, §23 s.23, §24–§25 s.23–24 · `wiki/mcp-tools.md` · `wiki/scope.md` · `wiki/sprint-4.md` · **Dil / Language:** **Türkçe** | [English](en/wiki-spec.md)

> **DURUM (`v0.2.0` Pre-1.0 Public Preview — ADR-010 Dürüstlük Özeti):**
> - **Teslim edilen çekirdek ve MCP yüzeyi:** `@causoryn/wiki` saf projeksiyon motoru (`projectWiki`, `projectWikiIncremental`, `resolveWikiLinks`, `buildWikiLinkIndex`, `WikiSearchStore`, `AnnotationOverlayEngine`, `exportWikiOffline`, `computeWikiCoverageDeltas`, `computeWikiContractChanges`), `@causoryn/storage-sqlite` (`SqliteWikiStore`: `wiki_snapshots`, `wiki_pages`, `wiki_page_sections`, `wiki_links`, `wiki_page_versions`, `wiki_annotations`, `wiki_aliases`, `wiki_fts`) ve `packages/mcp-server/src/services-wiki.ts` altındaki **7 MCP Wiki aracının tamamı** üretimde çalışmaktadır.
> - **Veri kökü ve `.git`'siz `working-tree` uyumu (K-021):** Açık `wiki.dataDbPath` konfigürasyonunun yanı sıra `causoryn mcp --allow-cwd --auto-data-dir [--client <id>]` (ve masaüstü IDE'lerde dinamik MCP `roots/list` bağlaması), kaynak ağacın dışında `~/.causoryn/workspaces/<slug>-<hash12>/graph[-<client>].sqlite` dosyasını otomatik hazırlar. Ayrıca `.git` dizini bulunmayan çalışma alanlarında (ör. dışa aktarılmış arşiv ağaçları) `working-tree` revizyonu Git alt-süreci başlatmadan doğrudan çözülür.
> - **Açık kalan 1.0.0 kapıları:** (1) `causoryn_wiki_search` ek filtreleri (`kinds`, `scope`, `language`, `revision`, `resolution`) şemada beyanlıdır ancak v0.2.0 MCP yüzeyinde açık `INVALID_ARGUMENT` ile reddedilir (`proximity` sıralama ayağı `skippedRankLegs` ile degrade raporlanır); (2) `WIKI_NOTE_CONFLICT` çekirdekte `wiki/annotation-conflict` olarak tam çalışır, ancak v0.2.0'da not yazan MCP aracı bulunmadığından `CAUSORYN_TOOL_ERROR_CODES` tablosuna kaydı yerel not UI/CLI yüzeyiyle birlikte 1.0.0 kapısına bırakılmıştır (K-014); (3) `causoryn_refresh_index` sonrası otomatik Wiki tetiklemesi (`wiki.autoBuildOnSnapshot`) ve `causoryn_export_documentation(view="wiki")` MCP kablolaması henüz açılmamıştır (Wiki yenileme açık `causoryn_wiki_build` çağrısıyla yapılır; `view` parametresi `INVALID_ARGUMENT` döner); artımlı `wiki_build` değişmeyen sayfaların `contentHash` değerini korur ancak SQLite yayım katmanı her yeni `WikiSnapshot` satırında tam anlık görüntüyü yazar.

## 1. Amaç ve kapsam

Living Wiki Engine, Causoryn'in 18 çekirdek özelliğini okunabilir ve yaşayan bir proje Wiki'sinde birleştiren
**çapraz kesen** (cross-cutting) 19. teslim başlığıdır. Wiki ayrı bir kod analiz motoru **değildir**; Unified
Evidence & Knowledge Graph'ın deterministik, sürümlü, sorgulanabilir **projeksiyonudur** (ADR-011: *Living Wiki
as Graph Projection*, TŞ §24).

- **Source of truth**: yetkilendirilmiş kaynak kod + GraphSnapshot + Git referansları + kontrat dosyaları.
  İnsan notları ve host modelinin önerdiği anlatım source of truth yerine geçmez (TŞ §16A).
- **18 çekirdek özellikle ilişki**: Wiki, 18 özelliğin hiçbirinin yerine geçmez; onları tek bir gezinti
  yüzeyinde toplar (TŞ §2.3, §25 madde 10). Architecture Map, Impact Analysis, Contracts vb. özelliklerin
  motor tarafı bağımsız teslim edilir; Wiki bu çıktıların *görünümüdür*.
- **Tasarım kararları**: ADR-011 (Graph Projection), ADR-012 (Generated/Overlay Separation), ADR-013
  (Wiki Revision & Link Integrity); ayrıca ADR-004 (Evidence First), ADR-005 (Immutable Snapshots),
  ADR-008 (Read-only Workspace Default) bu sözleşmeyi bağlar.
- **Hedef araç sayısı**: mevcut 22 çekirdek araç korunur + 7 Wiki aracı = 29 MCP aracı (TŞ §2.3, `wiki/mcp-tools.md`).

## 2. Wiki sayfa türleri ve amaçları

### 2.1 Varsayılan sayfa ağacı (TŞ §16A.1)

Bir çalışma alanı için sol navigasyon ağacı 12 kök kategori taşır (`packages/wiki/src/taxonomy.ts` `WIKI_ROOT_CATEGORIES`):

```
Workspace Wiki
├── Overview                  # repo, diller, kapsam, bilinmeyenler
├── Architecture              # L0–L4 katman/modül/bileşen haritaları
├── Projects & Modules        # her modül için bileşen + bağımlılık
├── APIs & Entry Points       # endpoint, handler, OpenAPI linkleri
├── Business Flows            # checkout/order gibi uçtan uca akışlar
├── Events & Integrations     # producer/consumer, async sözleşmeler
├── Data & Schemas            # entity, tablo, migration, ilişki
├── Contracts & Policies      # mimari kurallar, drift, istisnalar
├── Tests & Quality           # ilgili testler, test planı, coverage gap
├── Architecture Timeline     # commit bazlı değişim / ADR referansları
├── Onboarding                # başlangıç patikaları, kritik modüller
└── Unresolved & Coverage     # eksik parser, heuristic ve belirsizlikler
```

### 2.2 Sayfa türleri (`kind`) ve amaçları

Önerilen sayfa türleri (TŞ §16A.1, s.16): `overview | architecture | project | module | component | symbol | api |
business_flow | event | data | contract | policy | test | timeline | onboarding | coverage`.

| `kind` | Amaç | Ana graph kaynağı |
|---|---|---|
| `overview` | Repo, diller, kapsam, bilinmeyenlerin özeti | Workspace/Repository node'ları |
| `architecture` | L0–L4 katman/modül/bileşen haritaları | CONTAINS/DEPENDS_ON edge'leri |
| `project` | Proje düzeyi özet ve sahiplik | Project node'ları |
| `module` | Modül başına bileşen + bağımlılık görünümü | Module node'ları + DEPENDS_ON |
| `component` | Bileşen (sınıf/servis kümesi) detayı | Class/Interface/Function node'ları |
| `symbol` | Tek sembol: declaration, relations, kanıtlar | Symbol node'ları + CALLS/IMPORTS |
| `api` | Endpoint, handler, OpenAPI linkleri | Endpoint/Handler + ROUTES_TO + ApiContract |
| `business_flow` | Uçtan uca akış (örn. checkout/order) | Execution/Business Flow projeksiyonu |
| `event` | Producer/consumer, async sözleşmeler | PUBLISHES/SUBSCRIBES + EventContract |
| `data` | Entity, tablo, migration, ilişkiler | Database/Table + READS/WRITES |
| `contract` | API/event/schema sözleşme sayfaları | ApiContract/EventContract/SchemaContract/ContractVersion |
| `policy` | Mimari kurallar, drift, istisnalar | Guard policy + suppression verisi |
| `test` | İlgili testler, test planı, coverage gap | TESTS edge'leri + Test Intelligence |
| `timeline` | Commit bazlı değişim / ADR referansları | Git revision + CHANGED_IN |
| `onboarding` | Öğrenme patikası, kritik modüller | Onboarding Mode çıktısı |
| `coverage` | Eksik parser, heuristic, belirsizlikler | unresolved/uncovered graph verisi |

Bir sayfa türü o workspace'in adapter'ı tarafından desteklenmiyorsa sayfa `unsupported` veya `partial` görünümü
döner; veri olmadan doldurulmaz (`packages/wiki/src/projection.ts`: `GraphSnapshot` içinde doğrudan taşınmayan
`business_flow`, `timeline` ve `onboarding` kök kategorileri dürüstçe `no_data` döner; alt sayfalar `WIKI_CHILD_PAGE_SOURCES`
üzerinden `module`, `api`, `event`, `data` ve `contract` düğümleri için üretilir).

### 2.3 Sayfa üretim ilkeleri (TŞ §16A.1)

1. **Gerçek grafa dayanmayan modül veya endpoint sayfası üretilmez.** Boş kategori sayfası `no_data` görünümü
   taşır (`generatedMarkdown: ""`); sanki gerçek analiz yapılmış gibi doldurulmaz.
2. Her sayfada şunlar bulunur: `kind, pageId, parentId, title, route, graphSnapshotId, wikiSnapshotId, coverage,
   freshness, sourceRefs`.
3. `pageId` hash'i **canonical graph identity + sayfa türünden** türetilir (`wikiRootPageIdFor`, `wikiChildPageId`);
   kullanıcıya görünen slug/başlık değişse bile kimlik mümkün oldukça korunur.
4. Rename/relocation kesin çözülemiyorsa `wiki_aliases` ile `candidate_redirect` işaretlenir; yanlış eşleşme
   sessizce yapılmaz (bkz. `WikiPageAlias`, §3.6 ve `resolveWikiLinks`, §3.3).

## 3. Veri modeli — Zod şemaları

Alan adları TŞ §16A.7 (s.17) SQLite şema listesine sadıktır: `WikiSnapshot, WikiPage, WikiPageSection, WikiLink,
WikiPageVersion, WikiAnnotation, WikiPageAlias, WikiSearchIndex`. Çalışma zamanı Zod şemaları (`z.strictObject`)
`packages/wiki/src/{schema.ts,links.ts,overlay.ts,search-schema.ts}` içinde, kalıcı SQLite karşılıkları ise
`packages/storage-sqlite/src/{wiki-schema.ts,wiki-store.ts}` içinde `wiki_*` tablo ailesi olarak kodlanmıştır
(K-013 kararlarıyla kesinleşen enum ve nullable alanlar aşağıda işlenmiştir).

### 3.0 Ortak tipler (TŞ §8, s.8)

```ts
import { z } from "zod";

// TŞ §8: Resolution — verified, çalışma zamanı garantisi DEĞİLDİR.
export const WikiResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

// TŞ §8 Evidence/SourceSpan'e referans. WikiPageSection.evidenceRefs bu kayıtlara işaret eder.
// Span'sız Evidence için konumsuz kanıt referansı uydurulmaz; ilgili bölüm `partial` + uyarı alır.
export const EvidenceRefSchema = z.strictObject({
  evidenceId: z.string(),
  relativePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  sourceHash: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
```

### 3.1 WikiSnapshot (TŞ §16A.7)

```ts
// K-013 #1: GraphSnapshot.state ile birebir hizalıdır; ayrı "error" durum adı YOKTUR.
export const WikiSnapshotStatusSchema = z.enum(["building", "ready", "partial", "failed"]);

export const WikiSnapshotSchema = z.strictObject({
  id: z.string(),               // wikiSnapshotId — graphSnapshotId + WIKI_TEMPLATE_VERSION'dan deterministik türetilir
  workspaceId: z.string(),
  graphSnapshotId: z.string(),  // kaynak; immutable snapshot (ADR-005), yalnızca ready/partial olan girer (§9)
  revisionRef: z.string(),      // Git commit SHA veya working-tree revision descriptor (16A.4)
  status: WikiSnapshotStatusSchema,
  builtAt: z.iso.datetime(),    // ISO 8601 UTC; enjekte saatten gelir, kimlik karmasına katılmaz
  templateVersion: z.string(),  // generated Markdown şablonları sabit sürümlenir (16A.7)
});
export type WikiSnapshot = z.infer<typeof WikiSnapshotSchema>;
```

İki düzey sürüm (TŞ §16A.4): **GraphSnapshot** → ondan deterministik türetilmiş **WikiSnapshot** (`deriveWikiSnapshotId`).
Git commit SHA kalıcı revision kimliğidir; branch/tag hareketli takma addır. Dirty veya `.git` dizini bulunmayan
çalışma alanları için `working-tree` / revision descriptor (`treeFingerprint + configHash + analyzerVersion`)
kullanılır; `.git` mevcut olmasa bile projeksiyon ve `working-tree` sürüm sorgusu hatasız çalışır.

### 3.2 WikiPage ve WikiPageSection (TŞ §16A.7, §16A.1)

```ts
export const WikiPageKindSchema = z.enum([
  "overview", "architecture", "project", "module", "component", "symbol", "api",
  "business_flow", "event", "data", "contract", "policy", "test", "timeline",
  "onboarding", "coverage",
]);

// K-013 #3: kesinleşen kapsam ve tazelik değer kümeleri.
export const CoverageStatusSchema = z.enum(["complete", "partial", "unsupported", "no_data"]);
export const FreshnessSchema = z.enum(["fresh", "stale"]);

export const WikiPageSchema = z.strictObject({
  id: z.string(),                    // pageId — canonical graph identity + kind'tan türetilen sha256 (16A.1)
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),   // kök kategori sayfalarında null
  title: z.string(),
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),           // bölüm içeriklerinin deterministik karması — incremental invalidation anahtarı (16A.10)
  freshness: FreshnessSchema,
  coverage: z.strictObject({
    status: CoverageStatusSchema,
    detail: z.string().optional(),
  }),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]); // K-013 #3

export const WikiPageSectionSchema = z.strictObject({
  id: z.string(),
  pageId: z.string(),
  sectionKey: z.string(),             // sabit şablon bölüm anahtarı (templateVersion ile sürümlenir)
  generatedMarkdown: z.string(),      // yalnızca source-derived veri; elle düzenlenmez (ADR-012)
  evidenceRefs: z.array(EvidenceRefSchema),
  status: WikiPageSectionStatusSchema,
});
export type WikiPageSection = z.infer<typeof WikiPageSectionSchema>;
```

Kural (TŞ §16A.7): `WikiPage` **yalnızca source-derived section data** taşır; generated Markdown şablonları sabit
sürümlenir (`WIKI_TEMPLATE_VERSION`). `WikiProjectionSchema` `superRefine` katmanı tekil sayfa/bölüm kimliklerini
ve ebeveyn/sayfa referans bütünlüğünü çalışma zamanında zorlar.

### 3.3 WikiLink (TŞ §16A.2, §16A.7)

```ts
export const WikiLinkKindSchema = z.enum([
  "PARENT_OF", "DOCUMENTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "PRODUCES",
  "CONSUMES", "TESTED_BY", "FLOWS_TO", "RELATED_CONTRACT", "CHANGED_IN",
]);

export const WikiLinkSchema = z
  .strictObject({
    id: z.string(),
    wikiSnapshotId: z.string(),
    fromPageId: z.string(),
    toPageId: z.string().nullable(), // K-013 #4: çözümlenemeyen hedef toPageId=null ile korunur
    kind: WikiLinkKindSchema,
    resolution: WikiResolutionSchema,
    evidenceRefs: z.array(EvidenceRefSchema), // verified her link ≥1 Evidence (16A.7, ADR-004; superRefine ile zorlanır)
  });
export type WikiLink = z.infer<typeof WikiLinkSchema>;
```

Davranış kuralları (`packages/wiki/src/links.ts`, TŞ §16A.2 + K-013 #4):

- Her ilişki kaynak `GraphEdge`/contract diff/evidence referansı taşır; `verified` bir kenarın span'lı kanıtı yoksa
  link `heuristic`'e düşürülür ve açık uyarı üretilir (doğrulanmış link taklidi yapılmaz).
- Bir yöndeki bağlantıdan **backlink ters indeks üzerinden O(1) otomatik türetilir** (`buildWikiLinkIndex`); iki
  bağımsız link kaydı yazılmaz (çift yönlülük türetilir, kopyalanmaz — ADR-013).
- Bağlantı hedefi silinirse veya çözümlenemezse kayıt sessizce kaybolmaz: `WikiLink` kaydı `toPageId: null` ile
  korunur, hiçbir backlink kovasına düşmez ve **`brokenLinkDiagnostics`** (`{ linkId, fromPageId, toRef, kind, reason }`)
  üretilir (K-013 #4).
- Alias üzerinden `matchConfidence < 1` ile çözümlenen `verified` linkler otomatik olarak `heuristic`'e düşürülür.
- URL/anchor oluştururken normalize edilmiş `pageId`, izin verilen route ve HTML escaping zorunludur.

### 3.4 WikiPageVersion (TŞ §16A.4, §16A.7)

```ts
export const WikiPageVersionSchema = z.strictObject({
  pageId: z.string(),
  wikiSnapshotId: z.string(),
  revisionRef: z.string(),     // kalıcı revision kimliği (commit SHA / working-tree descriptor)
  contentHash: z.string(),
  linkSetHash: z.string(),     // giden link kümesi bütünlüğü (ADR-013)
  templateVersion: z.string(), // 16A.4 "en az ... templateVersion, coverage tutar"
  coverage: z.strictObject({ status: CoverageStatusSchema }),
});
export type WikiPageVersion = z.infer<typeof WikiPageVersionSchema>;
```

Sürüm sınırları: shallow clone, silinmiş Git objesi, veri göçü veya veri kökünde o revizyon için yayımlanmış
`WikiSnapshot` bulunmaması durumunda sürüm `not_available` + `notAvailableReason` döner; geçmiş sayfanın varlığı
sonsuz saklama taahhüdü değildir. Tarihi alias doğrulaması **Git checkout/reset/clean yapılmadan** salt-okunur
`git cat-file -t` ile yapılır (`working-tree` ise `.git` gerektirmeden doğrudan çözülür; TŞ §16A.4, kırmızı çizgi #3).

### 3.5 WikiAnnotation — overlay katmanı (TŞ §16A.6, §16A.7)

Wiki sayfası iki katmandır (ADR-012: Generated/Overlay Separation, `packages/wiki/src/overlay.ts`):

- **Generated layer**: kaynak GraphSnapshot'tan deterministik hazırlanır; her yeniden indekslemede yeniden
  üretilebilir ve **doğrudan elle düzenlenmez**.
- **Overlay layer**: insan notları, ekip açıklamaları, harici bağlantılar, isteğe bağlı kabul edilmiş host-model önerileri.

```ts
export const AnnotationAuthorKindSchema = z.enum(["human", "host_model_proposal"]);
export const AnnotationOriginSchema = z.enum([
  "human_note",            // kullanıcı/ekip notu
  "external_link",         // harici bağlantı
  "host_model_proposal",   // host modelinin yazdığı, kullanıcının kabul ettiği öneri — verified=false KALIR
]);

export const WikiAnnotationSchema = z.strictObject({
  id: z.string().min(1),
  stablePageId: z.string().min(1),       // sayfa yeniden üretilse de anotasyon buna bağlı kalır (16A.6)
  sectionKey: z.string().min(1),         // hangi bölüme eklendiği; generated içeriğin DIŞINDA render edilir
  authorKind: AnnotationAuthorKindSchema,
  origin: AnnotationOriginSchema.optional(),
  verified: z.boolean().optional(),      // origin=host_model_proposal için superRefine ile verified=true yasaktır (16A.6)
  body: z.string(),
  annotationVersion: z.number().int().nonnegative(), // optimistic concurrency CAS (16A.6)
  updatedAt: z.iso.datetime(),
});
export type WikiAnnotation = z.infer<typeof WikiAnnotationSchema>;
```

Kurallar (TŞ §16A.6 + `AnnotationOverlayEngine`):

- `WikiAnnotation` **farklı tabloda** (`wiki_annotations`, generated tablolara FK olmadan) saklanır; generated layer
  yenilendiğinde **asla üzerine yazılmaz** veya silinmez.
- Not oluşturma/düzenleme **ayrı yerel UI/CLI**, açık kullanıcı onayı ve yetki denetimi ile yapılır.
  **Normal MCP okuma aracı kaynak repo veya Wiki notları üzerinde otomatik yazı yapmaz** — yayımlanan 7 MCP aracının
  içinde anotasyon yazan araç **yoktur** (bkz. §5.2 yazma izin matrisi).
- Host modelinin yazdığı herhangi bir açıklama kullanıcı tarafından opsiyonel olarak kabul edilirse overlay'e
  eklenir; `origin=host_model_proposal` yalnızca `authorKind=host_model_proposal` ile bileşebilir ve `verified=false`
  kalır (`renderAnnotationBlock` bunu `[AI ÖNERİSİ — host_model_proposal, verified=false]` etiketiyle insan notundan
  açıkça ayırır). Bu, Causoryn'in kendisinin model çağırdığı anlamına gelmez (kırmızı çizgi #1).
- Kullanıcı notu kaynak koda dayanmayan anlatım içerirse **veri kanıtı statüsü kazanmaz**.
- Rename/removed page sonrası referans kaybında notlar silinmez; `markAnnotationOrphans` güncel `pageId` kümesine
  göre `orphan: true` durumunu türetir ve hedef sayfa aynı deterministik `pageId` ile geri geldiğinde yazma
  gerektirmeden otomatik yeniden bağlanır (orphan recovery, TŞ §19 risk tablosu).
- Optimistic concurrency: `AnnotationOverlayEngine.updateAnnotation`, `expectedAnnotationVersion` ile atomik CAS
  uygular; sürüm uyuşmazlığı çekirdekte `wiki/annotation-conflict` fırlatır.
- Workspace ve user storage açıkça ayrılır; export'ta overlay dahil etme varsayılan olarak **opt-in**dir
  (config: `includeManualNotesInExport: false`, §20).

### 3.6 WikiPageAlias (TŞ §16A.1, §16A.7)

```ts
export const WikiPageAliasSchema = z.object({
  oldPageId: z.string(),
  candidateNewPageId: z.string().nullable(),
  reason: z.string(),                          // örn. rename, relocation
  matchConfidence: z.number().min(0).max(1),   // < 1 ise çözümlenen verified link heuristic'e düşürülür
});
export type WikiPageAlias = z.infer<typeof WikiPageAliasSchema>;
```

Rename/relocation kesin çözülemiyorsa `wiki_aliases` tablosunda `candidate_redirect` işaretlenir (`packages/wiki/src/links.ts`
`WikiAliasEntry`); **yanlış eşleşme sessizce yapılmaz** ve `matchConfidence < 1` olan yönlendirmeler `verified`
link iddiası üretmez.

### 3.7 WikiSearchIndex — FTS5 (TŞ §16A.3, §16A.7)

FTS5 indeks alanları (`wiki_fts`, `packages/wiki/src/search-store.ts`): `title, qualified_symbol, api_route, module, tags, body`
(`manualNotes` aramaya dahil etme TŞ §20'de opsiyoneldir: `wiki.includeManualNotesInSearch: false`).

Arama sıralaması (`packages/wiki/src/search-ranking.ts`, TŞ §16A.3): **tam sembol/route eşleşmesi > başlık > modül >
BM25/FTS5 içerik > graph yakınlığı** (+ deterministik `pageId` leksik eşitlik bozma). Relevance açıklaması
`matchedFields` (altı statik sütun-filtreli FTS sorgusundan) ve `evidenceIds` olarak döner; gizli vektör/embedding
skoru gösterilmez, çünkü embedding servisi **yoktur** (kırmızı çizgi #1). Yakınlık (`proximity`) verisi beslenmediğinde
`skippedRankLegs` içinde dürüstçe raporlanır. Cursor/limit sınırları (varsayılan 50, tavan 200 — K-013 #5), sorgu
normalizasyonu ve FTS phrase kaçışı (`escapeFtsPhrase`, SQL parametresi bağlama) zorunludur.

## 4. MCP araç sözleşmeleri — 7 Wiki aracı

### 4.1 Standart envelope ve hata kodları (TŞ §10.1)

Tüm Wiki araçları 10 alanlı standart `EnvelopeSchema` sözleşmesini kullanır (TŞ §16A.8): `schemaVersion` (`"2.0"`),
`requestId`, `workspaceId`, `snapshotId` (servis edilen `WikiSnapshot` kimliği), `status` (`ok | partial | error`),
`coverage` (`wiki_build`'de kaynak graph çözümlenme istatistiği; salt-okunur Wiki araçlarında `null`), `warnings`,
`data`, `nextCursor` (sayfalamalı 5 araçta `data.nextCursor` ile birebir aynı) ve `error` (`{code, message, retryable, userAction} | null`).
Input/output Zod ile doğrulanır; stdout yalnızca MCP protokol trafiğidir, loglar stderr'e gider (kırmızı çizgi #4).
Stack trace MCP sonucuna yazılmaz. 7 aracın tamamında MCP `annotations` beyan edilir: yalnızca `causoryn_wiki_build`
`readOnlyHint: false` taşır, diğer 6 araç `readOnlyHint: true` taşır.

Hata kodu yönetişimi (`packages/mcp-server/src/errors.ts`, `services-wiki.ts`, K-014):

- **Aktif kullanılan sabit kodlar (`WIKI_TOOL_ERROR_CODES_USED`):** `WORKSPACE_NOT_AUTHORIZED`, `PATH_DENIED`,
  `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND` (açıkça verilen `snapshotId` bulunamadığında), `LIMIT_EXCEEDED`,
  `INVALID_ARGUMENT`, `INVALID_REVISION`, `WIKI_PAGE_NOT_FOUND` (TŞ §10.1 sabit kodu; bilinmeyen `pageId`/`parentId`
  için), `EXPORT_NOT_ALLOWED` (offline export yetkilendirme eşlemesi) ve `INTERNAL_ERROR`.
- **Bilinçli olarak fırlatılmayan / 1.0.0 kapısına bırakılan TŞ §10.1 kodları (K-014 dürüstlük notu):**
  - `WIKI_REVISION_NOT_AVAILABLE`: Çözülemeyen Git alias'ları K-013 #6 gereği `INVALID_REVISION` döndürür; geçerli
    olup veri kökünde `WikiSnapshot` kaydı bulunmayan revizyonlar ise hata fırlatmak yerine veri yüzeyinde
    `availability: "not_available"` + `notAvailableReason` olarak raporlanır.
  - `WIKI_BROKEN_LINK`: K-013 #4 gereği bozuk link hata değil **veri yüzeyidir** (`toPageId: null` +
    `brokenLinkDiagnostics`).
  - `WIKI_NOTE_CONFLICT`: `annotationVersion` CAS çakışması çekirdekte `wiki/annotation-conflict` olarak tam
    kodlanmıştır (`AnnotationOverlayEngine.updateAnnotation`); ancak v0.2.0'da not yazan MCP aracı bulunmadığından
    sunucu `CAUSORYN_TOOL_ERROR_CODES` / `TOOL_ERROR_GUIDANCE` tablosuna kaydı yerel not UI/CLI akışıyla birlikte
    açık 1.0.0 kalemi olarak takip edilmektedir.

### 4.2 Araçlar

Araç girdi alanları TŞ §10.2 kataloğuna (s.10), amaç/izin satırları TŞ §16A.8 tablosuna (s.17) ve `v0.2.0`
`packages/mcp-server/src/services-wiki.ts` şemalarına sadıktır. Tüm output şemaları envelope'un `data` alanının içeriğidir.

#### 4.2.1 `causoryn_wiki_build`

- **Amaç**: Yetkili workspace için `WikiProjection` üretir ve SQLite veri köküne atomik yayınlar (TŞ §16A.8).
- **İzin**: ✍️ **YAZMA VAR (`readOnlyHint: false`) — yalnızca izinli Causoryn data-root'a** (`config.wiki.dataDbPath`
  veya `--auto-data-dir` ile hazırlanan workspace-dışı SQLite; beyan yoksa `PATH_DENIED`). **Kaynak dosyalara asla yazamaz** (§5.2).

```ts
export const WikiBuildInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  mode: z.enum(["full", "incremental"]),      // K-013 #2
  scope: z.string().min(1).optional(),        // v0.2.0'da açık INVALID_ARGUMENT reddi (ADR-010)
  revision: z.string().min(1).optional(),     // verilmezse graph meta revision.id
});

export const WikiBuildDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: z.enum(["ready", "partial"]),
  mode: z.enum(["full", "incremental"]),      // yürütülen gerçek mod
  fallbackReason: z.string().optional(),      // incremental → full degrade gerekçesi
  pagesRegenerated: z.number().int().nonnegative(),
  sectionsRegenerated: z.number().int().nonnegative(),
  linksRegenerated: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
```

- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY` (yayımlanmış `ready`/`partial` GraphSnapshot yok),
  `PATH_DENIED` (`wiki.dataDbPath` beyansız sunucuda default deny), `INVALID_ARGUMENT` (`scope` verildiğinde), `INTERNAL_ERROR`.
- **Davranış**: Yalnızca `ready`/`partial` GraphSnapshot projeksiyona girer; sayfalar, bölümler, linkler, sayfa
  sürümleri ve `wiki_fts` aynı `building` kaydına yazılıp tek SQLite transaction'ında `publishWiki` ile yayınlanır;
  hata durumunda `failWikiBuild` ile `failed` durumuna kapatılır. Aynı `graphSnapshotId` için tekrarlanan çağrı
  idempotent no-op döner. `mode="incremental"` yalnızca etkilenen `pageId`'leri yeniler (`contentHash` koruması);
  önceki snapshot/graph yoksa zarifçe `mode="full"` + `fallbackReason` ile tamamlanır.

#### 4.2.2 `causoryn_wiki_get_tree`

- **Amaç**: Hiyerarşi ve sayfa sıralaması (TŞ §16A.8); 12 kök kategorili sayfa ağacı + hiyerarşik navigasyon (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).**

```ts
export const WikiGetTreeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),         // yoksa en güncel yayımlanmış WikiSnapshot
  parentId: z.string().min(1).optional(),           // alt ağaç kökü
  depth: z.number().int().min(1).max(8).optional(), // alt ağaç derinlik tavanı
  limit: z.number().int().min(1).optional(),        // K-013 #5: varsayılan 50, max 200
  cursor: z.string().min(1).optional(),
});

export const WikiTreeNodeSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),
  title: z.string(),
  route: z.string(),
  coverage: z.strictObject({ status: CoverageStatusSchema }), // no_data kategoriler dolgusuz listelenir (16A.1)
  freshness: FreshnessSchema,
  childCount: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
});

export const WikiGetTreeDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  nodes: z.array(WikiTreeNodeSchema),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (`parentId` bulunamadı),
  `EVIDENCE_NOT_FOUND` (verilen `snapshotId` bulunamadı), `INVALID_ARGUMENT` (bozuk cursor), `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.3 `causoryn_wiki_get_page`

- **Amaç**: Sayfa bölümleri, provenance, coverage, source refs (TŞ §16A.8); sayfa blokları, evidence ve
  freshness (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).**

```ts
export const WikiGetPageInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  snapshotId: z.string().min(1).optional(),
  sections: z.array(z.string().min(1)).optional(), // sectionKey filtresi
  limit: z.number().int().min(1).optional(),       // bölüm sayfalama (varsayılan 50, max 200)
  cursor: z.string().min(1).optional(),
});

export const WikiGetPageDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  page: z.strictObject({
    pageId: z.string(),
    kind: WikiPageKindSchema,
    parentId: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    route: z.string(),
    contentHash: z.string(),
    freshness: FreshnessSchema,
    coverage: z.strictObject({
      status: CoverageStatusSchema,
      detail: z.string().optional(),
    }),
  }),
  sourceRefs: z.array(EvidenceRefSchema),       // sayfanın tüm bölümlerinden türetilen tekrarsız kanıtlar
  sections: z.array(WikiPageSectionSchema),     // generated layer (ADR-012)
  sectionsTotal: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Overlay notu**: `WikiAnnotation` kayıtları bu MCP aracında dönmez (TŞ §16A.6: ayrı yerel UI/CLI akışı).
- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `EVIDENCE_NOT_FOUND`,
  `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.4 `causoryn_wiki_search`

- **Amaç**: FTS5 ve sembol eşleştirme, filtre/pagination (TŞ §16A.8); FTS5 / sembol / endpoint araması (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).** Gizli dosya içeriği gösterilmez: workspace access/secret
  exclusion politikası tüm Wiki index ve snippet'lerine uygulanır (TŞ §19).

```ts
export const WikiSearchInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string(),                              // normalize edilir; FTS phrase kaçışı uygulanır (16A.3)
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),      // K-013 #5: varsayılan 50, max 200
  cursor: z.string().min(1).optional(),
  // Aşağıdaki TŞ §16A.3 filtre alanları şemada beyanlıdır ancak v0.2.0'da açık INVALID_ARGUMENT döner (ADR-010):
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

export const WikiSearchHitSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  title: z.string(),
  route: z.string(),
  freshness: FreshnessSchema,
  qualifiedSymbol: z.string().nullable(),
  apiRoute: z.string().nullable(),
  module: z.string().nullable(),
  snippet: z.string(),
  matchedFields: z.array(z.enum(["title", "qualifiedSymbol", "apiRoute", "module", "tags", "body"])),
  evidenceIds: z.array(z.string()),
});
```

- **Sıralama garantisi**: `CreateOrder` gibi tam sembol/route eşleşmesi, FTS genel eşleşmesinin **üstünde** döner
  (kabul testi, TŞ §16A.10). `proximity` ayağı v0.2.0 MCP yüzeyinde beslenmediğinden `skippedRankLegs` içinde açıkça bildirilir.
- **Token bütçesi**: sonuca uygun özet döner; tam sayfa sonraki `causoryn_wiki_get_page` çağrısıyla alınır (16A.3).
- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND` (verilen `snapshotId` yok),
  `INVALID_ARGUMENT` (boş sorgu, bozuk cursor veya henüz açılmamış ek filtreler), `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.5 `causoryn_wiki_get_links`

- **Amaç**: Bağlantı/backlink ve evidence (TŞ §16A.8); outgoing + incoming/backlinks + evidence (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).**

```ts
export const WikiGetLinksInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
  linkKinds: z.array(WikiLinkKindSchema).optional(),
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiGetLinksDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]),
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),  // backlink ters indeksinden O(1) türetilir (16A.2, ADR-013)
  brokenLinkDiagnostics: z.array(BrokenLinkDiagnosticSchema), // K-013 #4: toPageId=null kayıtlar
  totalMatching: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `EVIDENCE_NOT_FOUND`,
  `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR` (bozuk link hata fırlatmaz; `brokenLinkDiagnostics` verisi olarak döner — K-013 #4).

#### 4.2.6 `causoryn_wiki_get_versions`

- **Amaç**: Erişilebilir Git/snapshot revizyonları (TŞ §16A.8); commit / working-tree Wiki sürümleri (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).** Git tamamen salt okunur; `git cat-file -t` kullanılır,
  checkout/reset/clean asla çalıştırılmaz; `working-tree` ise `.git` dizini gerektirmeden doğrudan çözülür.

```ts
export const WikiGetVersionsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),                 // verilirse sayfa sürümü; verilmezse snapshot revizyonu
  refs: z.array(z.string().min(1)).min(1).max(200).optional(), // commit SHA / branch / tag / working-tree
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiVersionEntrySchema = z.strictObject({
  pageId: z.string().nullable(),
  revisionRef: z.string(),
  wikiSnapshotId: z.string().nullable(),
  builtAt: z.string().nullable(),
  availability: z.enum(["available", "not_available"]),
  notAvailableReason: z.string().optional(),
  contentHash: z.string().optional(),
  linkSetHash: z.string().optional(),
  templateVersion: z.string().optional(),
  coverage: z.strictObject({ status: CoverageStatusSchema }).optional(),
});
```

- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (verilen `pageId` bu
  snapshot'ta yok), `INVALID_REVISION` (söz dizimi bozuk veya Git'te çözümlenemeyen ref — K-013 #6),
  `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.7 `causoryn_wiki_diff`

- **Amaç**: Revision/snapshot sayfa farkları (TŞ §16A.8); sayfa, bölüm, link, kapsam ve sözleşme değişim raporu (§10.2).
- **İzin**: 🔒 **SALT OKUNUR (`readOnlyHint: true`).** Karşılaştırma izole `WikiSnapshot` okumalarıyla yapılır;
  working tree asla değişmez (kabul testi, §16A.10).

```ts
export const WikiDiffInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  base: z.string().min(1),               // wikiSnapshotId veya en güncel yayımlanmış revisionRef — zorunlu
  target: z.string().min(1),             // wikiSnapshotId veya en güncel yayımlanmış revisionRef — zorunlu
  pageId: z.string().min(1).optional(),  // tek sayfa daraltma
});

export const WikiDiffDataSchema = z.strictObject({
  base: z.string(),
  target: z.string(),
  baseWikiSnapshotId: z.string(),
  targetWikiSnapshotId: z.string(),
  addedPages: z.array(z.string()),
  removedPages: z.array(z.string()),
  changedSections: z.array(z.strictObject({
    pageId: z.string(),
    sectionKey: z.string(),
  })),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  contractChanges: z.array(z.strictObject({ // K-013 #7 (Sprint 5 D7 ile kesinleşti)
    contractId: z.string(),
    changeKind: z.enum(["added", "removed", "modified"]),
    summary: z.string(),
  })),
  coverageDelta: z.array(z.strictObject({   // K-013 #3
    pageId: z.string(),
    previous: CoverageStatusSchema,
    current: CoverageStatusSchema,
    reason: z.string().optional(),
  })),
  unresolvedDifferences: z.array(z.strictObject({ pageId: z.string(), reason: z.string() })),
});
```

- **Kısmi belirsizlik**: taban veya hedef `WikiSnapshot` `partial` ise envelope `status: "partial"` döner; arka
  `GraphSnapshot` çözümlenemediğinde `contractChanges: []` + açık uyarı üretilir (TŞ §16A.5, K-013 #7).
- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (`pageId` her iki tarafta
  da yoksa), `INVALID_REVISION` (`base` veya `target` çözümlenemedi), `INVALID_ARGUMENT`, `INTERNAL_ERROR`.

### 4.3 İsteğe bağlı MCP resources

Opsiyonel resource URI: `causoryn://wiki/{workspaceId}/{pageId}?snapshot={wikiSnapshotId}` (TŞ §16A.8).
`v0.2.0` diliminde MCP `resources` yüzeyi yayımlanmamıştır; taşınabilir temel sözleşme 7 MCP tool'dur. MCP Apps
gibi etkileşimli UI uzantıları host destek testinden sonra değerlendirilir; hiçbir host'ta otomatik interaktif
panel varmış gibi vaat edilmez (ADR-010).

## 5. Yazma izni: data-root kuralı ve izin matrisi

### 5.1 `wiki_build` yalnızca izinli data-root'a yazar

- `wiki_build` explicit workspace authorization ister; **kaynak dosyalara yazamaz** (TŞ §16A.8, ADR-008).
- Veri kökü iki yoldan biriyle bağlanır:
  1. **Açık konfigürasyon (`wiki.dataDbPath`):** `validateDataDbPath` (`packages/mcp-server/src/context.ts:230-357`)
     tarafından mutlak yol olması, null byte içermemesi, üst dizinin mevcut olması, SQLite `-wal`/`-shm`/`-journal`
     yan dosyalarının sarkan/kırık symlink olmaması (CWE-59) ve `realpathSync` sonucunun tüm `allowRoots` köklerinin
     kesinlikle dışında kalması fail-closed doğrulanır.
  2. **Sıfır-ayar CLI / Plugin modu (`--auto-data-dir`, K-021):** `buildWorkspaceAutoConfig` (`packages/mcp-server/src/runtime-cli.ts:871-996`),
     taban veri dizini (`--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`) altında `~/.causoryn/workspaces/<slug>-<hash12>/graph[-<client>].sqlite`
     yolunu hem `storage.dataDbPath` hem `wiki.dataDbPath` için otomatik hazırlar (`0o700` dizin izni, oluşturma
     öncesi üst-yol symlink denetimi ve oluşturma sonrası TOCTOU `realpathSync` doğrulaması).
- `LLM_* / API_KEY / MODEL_PROVIDER` konfigürasyonuna izin verilmez (kırmızı çizgi #1).
- Offline Wiki export çekirdeği (`exportWikiOffline`, `packages/wiki/src/export.ts`) `wiki.dataDbPath`'ten ayrı
  olarak yalnızca `OutputAccessPolicy` (`output.allowedOutputDirs`) ile yetkilendirilmiş çıktı dizinine `.tmp` +
  `rename` ile atomik yazar; self-contained HTML katı CSP (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`)
  ve URL defanging uygular, `file://` bağlantısı veya uzak CDN içermez (TŞ §16A.9).

### 5.2 Yazma izin matrisi

| Araç/akış | Yazma izni | Yazma hedefi | Kaynak |
|---|---|---|---|
| `causoryn_wiki_build` | ✅ VAR (`readOnlyHint: false`) | Yalnızca izinli Causoryn data-root SQLite (`wiki.dataDbPath` veya `--auto-data-dir`) | TŞ §16A.8, §19, K-021 |
| `causoryn_wiki_get_tree` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_page` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_search` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_links` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_versions` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur; Git read-only + `.git`'siz `working-tree`) | TŞ §16A.8, kırmızı çizgi #3 |
| `causoryn_wiki_diff` | ❌ YOK (`readOnlyHint: true`) | — (salt okunur; working tree değişmez) | TŞ §16A.8, §16A.10 |
| `causoryn_refresh_index` | ✅ (indeks, `readOnlyHint: false`) | Yalnızca Causoryn graph indeksi (`InMemoryGraphRepository` / `storage.dataDbPath`); v0.2.0'da Wiki yenileme açık `causoryn_wiki_build` ile yapılır | TŞ §10.2, ADR-010 |
| `causoryn_export_documentation` | ✅ (export, `readOnlyHint: false`) | Yalnızca explicit izinli `output.allowedOutputDirs` klasörü (`view` parametresi v0.2.0'da açık `INVALID_ARGUMENT`) | TŞ §10.2, §16A.9, ADR-010 |
| Wiki not ekleme/düzenleme | ✅ (onaylı yerel akış) | **MCP aracı YOK**; çekirdek `AnnotationOverlayEngine` hazır, yerel UI/CLI yüzeyi 1.0.0 kapısında | TŞ §16A.6, §10.2, K-014 |

Anlam: **7 Wiki aracından yalnızca `wiki_build` yazar** ve yalnızca workspace-dışı data-root SQLite'ına; diğer
altısı analiz/query bakımından tamamen salt okunurdur.

## 6. Yeniden kullanım ilkesi: `refresh_index` ve `export_documentation`

TŞ §10.2 + §16A.8 katalog tasarım ilkesi (ve `v0.2.0` dürüst uygulama durumu):

1. **Ayrı `wiki_refresh` ve `wiki_export` MCP aracı AÇILMAZ** — toplam araç sayısı 22 + 7 = 29 olarak kilitlidir.
2. **TŞ hedef akışı vs. `v0.2.0` durumu (ADR-010):**
   - TŞ §20 tasarımında `wiki.autoBuildOnSnapshot: true` ile `causoryn_refresh_index` sonrası otomatik Wiki
     güncellemesi ve `causoryn_export_documentation(view="wiki")` ile offline Wiki dışa aktarımı öngörülmüştür.
   - `v0.2.0` sürümünde çekirdek `projectWikiIncremental` ve `exportWikiOffline` modülleri tam olarak kodlanmış ve
     birim/entegrasyon testleriyle doğrulanmıştır; ancak MCP yüzeyinde Wiki projeksiyonu açıkça `causoryn_wiki_build`
     ile tetiklenir ve `causoryn_export_documentation` üzerinde `view` parametresi geçirildiğinde sessizce yok
     sayılmak yerine açık `INVALID_ARGUMENT` ile reddedilir.
3. **Artımlı (incremental) akış (`packages/wiki/src/incremental.ts`, TŞ §16A.5):** İki `GraphSnapshot` arasındaki
   düğüm/kenar farkından (`diffWikiGraphs`) etkilenen kategori ve alt sayfa `pageId`'leri hesaplanır → değişmeyen
   sayfalar önceki `contentHash` ve içerikleriyle korunur → yeni `WikiSnapshot` ve `wiki_fts` tek atomik SQLite
   transaction'ında yayınlanır → yayına kadar önceki `WikiSnapshot` `stale: true` ile okunmaya devam eder.
4. Wiki not ekleme/düzenleme, normal MCP sorgularından ayrı ve açık kullanıcı izinli yerel CLI/UI akışı olarak
   tutulur (TŞ §10.2, §16A.6).

İlgili TŞ hedef konfigürasyonu (TŞ §20; `v0.2.0` sunucu çalışma zamanında aktif alan `wiki.dataDbPath`'tir, bkz. [CLI ve Konfigürasyon](cli-and-configuration.md)):

```yaml
wiki:
  dataDbPath: "/abs/path/outside-workspace/graph.sqlite" # veya --auto-data-dir ile otomatik
  # TŞ §20 1.0.0 hedef genişlemeleri:
  enabled: true
  autoBuildOnSnapshot: true
  includeManualNotesInSearch: false
  includeManualNotesInExport: false
  historicalSnapshotRetention: "metadata_and_derivatives" # raw source depolanmaz
  offlineExportDefault: true
```

Gözlemlenebilirlik metrikleri (TŞ §21 hedefi): `wiki_projection_duration, wiki_pages_regenerated,
wiki_fts_update_duration, wiki_broken_links, wiki_stale_queries, wiki_orphaned_notes` (`pagesRegenerated` ve
`brokenLinks` halihazırda `causoryn_wiki_build` yanıtında döner).

## 7. Test ve kabul kriterleri (TŞ §16A.10 — Faz C2 doğrulama matrisi)

| Test | Kabul |
|---|---|
| Hiyerarşi | TS Orders fixture'dan Overview → APIs → POST /orders → Service gezintisi ve açık `no_data`/`partial` durumları |
| Çift yönlü link | `from->to` ilişkisi aynı snapshot'ta target backlink sorgusunda bulunur; verified ise evidence mevcut |
| Arama | `CreateOrder` exact symbol eşleşmesi ilgili sayfayı FTS genel eşleşmesinin üstünde döndürür |
| Sürüm | İki fixture Git commit'inde added/removed/changed ve link değişiklikleri doğru; **user working tree değişmez** |
| İnkremental | Sadece bir servis değişince etkilenen sayfalar yenilenir; bağımsız sayfa `contentHash`'i korunur |
| Kullanıcı notu | Art arda iki reindex manuel notları değiştirmez; rename'de not `orphan` kalabilir, **veri kaybı olmaz** |
| Belirsizlik | Dinamik import çözülemiyorsa `partial`/`unresolved`; doğrulanmış link taklidi yapılmaz |
| Güvenlik | Offline HTML'de XSS escape + CSP + URL defang; broken-link diagnostics; secret exclusion snippet'lere uygulanır (§22, §19) |

Her araç için sprint kuralı uygulanmıştır: pozitif + negatif + partial test üçlüsü (TŞ §23 DoD; kanıtlar için bkz. [Uygulama Durumu](implementation-status.md)).

## 8. Açık konular — K-013 kararları ve açık 1.0.0 kalemleri

> **KARARLANDI (2026-11-05, K-013 + Sprint 5 D7):** Faz C2 öncesindeki 7 açık tasarım sorusu **K-013** ile kesin
> karara bağlanmış ve kaynak kodda uygulanmıştır:

1. **`WikiSnapshot.status` değer kümesi (K-013 #1):** `building | ready | partial | failed` — TŞ §8 `GraphSnapshot.state`
   ile birebir aynıdır; ayrı `"error"` durum adı yoktur, hata bildirimi `warnings` + sabit hata kodlarıyla yapılır.
2. **`wiki_build mode` enum değerleri (K-013 #2):** `full | incremental`; geçersiz değer reddedilir, motor içi
   `full-rebuild` kararı MCP yüzeyinde `mode: "full"` + `fallbackReason` olarak döner.
3. **`freshness`, `CoverageStatus`, `section status` ve `coverageDelta` gövdesi (K-013 #3):** `freshness = fresh | stale`,
   `CoverageStatus = complete | partial | unsupported | no_data` (`no_data` asla uydurma metinle doldurulmaz),
   bölüm durumu `ok | partial | no_data` ve `coverageDelta` eleman gövdesi `{ pageId, previous, current, reason? }`.
4. **Bozuk link hedefinin storage gösterimi (K-013 #4):** `WikiLink` kaydı `toPageId: null` ile korunur (sessiz
   silme yok, backlink kovasına girmez) **ve** ayrıca `brokenLinkDiagnostics` kaydı üretilir.
5. **Cursor formatı ve limitler (K-013 #5):** Paylaşılan opak `base64url` `{ "v": 1, "o": <int> }` cursor mekanizması
   kullanılır; varsayılan `limit = 50`, üst tavan `200`, son sayfada `nextCursor = null`.
6. **`wiki_get_versions` branch/tag alias çözümleme davranışı (K-013 #6):** Salt-okunur `git cat-file -t` ile
   çözülür (`working-tree` `.git` gerektirmeden doğrudan çözülür); çözülemeyen ref `INVALID_REVISION` döndürür,
   veri kökünde kaydı olmayan geçerli ref `availability: "not_available"` olarak listelenir.
7. **`contractChanges` diff gövdesi (K-013 #7, Sprint 5 D7'de kesinleşti):** `{ contractId, changeKind: "added" | "removed" | "modified", summary }`
   şemasıyla iki `WikiSnapshot`'ın arka `GraphSnapshot` sözleşme düğümleri (`ApiContract`/`EventContract`/`SchemaContract`/`ContractVersion`)
   üzerinden hesaplanır.

**`v0.2.0` sonrasında `1.0.0` sürüm kapısına kalan açık Wiki maddeleri (CHANGELOG `[Unreleased]` ile senkron):**

- `causoryn_wiki_search` ek filtrelerinin (`kinds`, `scope`, `language`, `revision`, `resolution`) ve `proximity` sıralama ayağının MCP yüzeyinde açılması.
- Yerel not ekleme/düzenleme CLI/UI akışı açıldığında `WIKI_NOTE_CONFLICT` sabit kodunun MCP `CAUSORYN_TOOL_ERROR_CODES` / `TOOL_ERROR_GUIDANCE` tablosuna kaydedilmesi (K-014).
- `causoryn_export_documentation(view="wiki")` ve `wiki.autoBuildOnSnapshot` MCP kablolaması ile artımlı `WikiSnapshot` SQLite satır paylaşımı optimizasyonu.

## 9. İlgili sayfalar

- [Dokümantasyon İndeksi](README.md) — tüm TR/EN dokümanların giriş sayfası
- [Tool Sözleşmeleri](tool-contracts.md) — 29 araç kataloğu, 10 alanlı envelope, sabit 15 hata kodu ve yazma izin matrisi
- [Mimari Haritası](architecture.md) — paket haritası, SQLite `wiki_*` tabloları ve bağımlılık sınırları
- [CLI ve Konfigürasyon](cli-and-configuration.md) — `wiki.dataDbPath`, `--auto-data-dir` ve çalışma alanı yetkilendirmesi
- [Uygulama Durumu](implementation-status.md) — Faz C2 (Sprint 4 W1–W8) ve Faz D (D7) doğrulama kanıtları
- [English Specification](en/wiki-spec.md) — bu spesifikasyonun İngilizce karşılığı
- Tarihsel/birincil kaynak referansları: `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` §16A (s.14–18) · `wiki/mcp-tools.md` · `wiki/scope.md` · `wiki/sprint-4.md` · `wiki/decisions.md` (ADR-004/005/008/010/011/012/013, K-013, K-014, K-021, K-022)
