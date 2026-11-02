# Living Wiki Engine — Tasarım Sözleşmesi

> Kanıt: raw/Causoryn_Teknik_Dokuman_v2.1.pdf (TŞ v2.1) — §16A s.14–18, §10 s.9–10, §8–§9 s.8–9, §19–§20 s.21–22, §23 s.23, §24–§25 s.23–24 · wiki/mcp-tools.md · wiki/scope.md · wiki/sprint-4.md

> **DURUM: TASARIM SÖZLEŞMESİ — BU BİLEŞENDE HİÇBİR ŞEY IMPLEMENT EDİLMEDİ.**
> Koddan bağımsız sayfa, çalışan tool, şema dosyası, test veya fixture YOKTUR. Bu doküman sprint-1 görev 10'un
> tasarım çıktısıdır; implementasyon Faz C2'ye (sprint-4.md, W1–W8) aittir. TŞ ADR-010 uyarınca çalışmayan
> hiçbir şey "Done" yazılmaz; Living Wiki şu an **Not Started** durumundadır.

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
- **Hedef araç sayısı**: mevcut 22 çekirdek araç korunur + 7 Wiki aracı = 29 MCP aracı (TŞ §2.3, wiki/mcp-tools.md).

## 2. Wiki sayfa türleri ve amaçları

### 2.1 Varsayılan sayfa ağacı (TŞ §16A.1)

Bir çalışma alanı için sol navigasyon ağacı 12 kök kategori taşır:

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
| `contract` | API/event/schema sözleşme sayfaları | ApiContract/SchemaContract |
| `policy` | Mimari kurallar, drift, istisnalar | Guard policy + suppression verisi |
| `test` | İlgili testler, test planı, coverage gap | TESTS edge'leri + Test Intelligence |
| `timeline` | Commit bazlı değişim / ADR referansları | Git revision + CHANGED_IN |
| `onboarding` | Öğrenme patikası, kritik modüller | Onboarding Mode çıktısı |
| `coverage` | Eksik parser, heuristic, belirsizlikler | unresolved/uncovered graph verisi |

Bir sayfa türü o workspace'in adapter'ı tarafından desteklenmiyorsa sayfa `unsupported` veya `partial` görünümü
döner; veri olmadan doldurulmaz.

### 2.3 Sayfa üretim ilkeleri (TŞ §16A.1)

1. **Gerçek grafa dayanmayan modül veya endpoint sayfası üretilmez.** Boş kategori sayfası `no_data` görünümü
   taşır; sanki gerçek analiz yapılmış gibi doldurulmaz.
2. Her sayfada şunlar bulunur: `kind, pageId, parentId, title, route, graphSnapshotId, wikiSnapshotId, coverage,
   freshness, sourceRefs`.
3. `pageId` hash'i **canonical graph identity + sayfa türünden** türetilir; kullanıcıya görünen slug/başlık
   değişse bile kimlik mümkün oldukça korunur.
4. Rename/relocation kesin çözülemiyorsa `wiki_aliases` ile `candidate_redirect` işaretlenir; yanlış eşleşme
   sessizce yapılmaz (bkz. `WikiPageAlias`, §3.7).

## 3. Veri modeli — Zod şema taslakları

Alan adları TŞ §16A.7 (s.17) SQLite şema listesine sadıktır: `WikiSnapshot, WikiPage, WikiPageSection, WikiLink,
WikiPageVersion, WikiAnnotation, WikiPageAlias, WikiSearchIndex`. SQLite karşılıkları Faz C2'de
`packages/storage-sqlite` içinde `wiki_*` tablo ailesi olarak kurulacaktır (TŞ §9; wiki/sprint-4.md W2).

> Aşağıdaki Zod taslakları **implement edilmemiş** tasarım artefaktıdır (sprint-1.md "Tool başına: inputSchema +
> outputSchema (Zod)" kuralına hazırlık). TŞ'de değer kümesi açık olmayan alanlara `[TASLAK ÖNERİ]` notu düşülmüştür;
> bunlar implementasyon öncesi karar bekler ve dokümanda iddia olarak değil, öneri olarak okunmalıdır.

### 3.0 Ortak tipler (TŞ §8, s.8)

```ts
import { z } from "zod";

// TŞ §8: Resolution — verified, çalışma zamanı garantisi DEĞİLDİR.
export const ResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

// TŞ §8 Evidence/SourceSpan'e referans. WikiPageSection.evidenceRefs bu kayıtlara işaret eder.
// [TASLAK ÖNERİ] referans gövdesi; Evidence'in kendisi TŞ §8 şemasıyla graph tarafında yaşar.
export const EvidenceRefSchema = z.object({
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
export const WikiSnapshotStatusSchema = z.enum(["building", "ready", "partial", "failed"]);
// [TASLAK ÖNERİ] Değer kümesi TŞ'de WikiSnapshot için açık değildir; §8 GraphSnapshot.state
// (building|ready|partial|failed) ile hizalanmıştır. TŞ §16A.5 "ready/partial/error statüsü belirtilir"
// ifadesindeki "error" bildirimi, failed/sorgu hatası ayrımının implementasyonda netleştirilmesini gerektirir.

export const WikiSnapshotSchema = z.object({
  id: z.string(),               // wikiSnapshotId — graphSnapshotId'den deterministik türetilir (16A.4: iki düzey sürüm)
  workspaceId: z.string(),
  graphSnapshotId: z.string(),  // kaynak; immutable snapshot (ADR-005), yalnızca ready/partial olan girer (§9)
  revisionRef: z.string(),      // Git commit SHA veya dirty working-tree revision descriptor (16A.4)
  status: WikiSnapshotStatusSchema,
  builtAt: z.string().datetime(), // ISO 8601 [TASLAK ÖNERİ]
  templateVersion: z.string(),    // generated Markdown şablonları sabit sürümlenir (16A.7)
});
export type WikiSnapshot = z.infer<typeof WikiSnapshotSchema>;
```

İki düzey sürüm (TŞ §16A.4): **GraphSnapshot** → ondan deterministik türetilmiş **WikiSnapshot**. Git commit SHA
kalıcı revision kimliğidir; branch/tag hareketli takma addır. Dirty working-tree için ayrı revision descriptor
(`treeFingerprint + configHash + analyzerVersion`) kullanılır.

### 3.2 WikiPage ve WikiPageSection (TŞ §16A.7, §16A.1)

```ts
export const WikiPageKindSchema = z.enum([
  "overview", "architecture", "project", "module", "component", "symbol", "api",
  "business_flow", "event", "data", "contract", "policy", "test", "timeline",
  "onboarding", "coverage",
]);

export const CoverageStatusSchema = z.enum(["complete", "partial", "no_data", "unsupported"]);
// [TASLAK ÖNERİ] "no_data" (16A.1: boş kategori doldurulmaz), "unsupported"/"partial" (16A.1:
// adapter desteklemiyorsa unsupported/partial döner) TŞ'den; "complete" adı öneridir.

export const WikiPageSchema = z.object({
  id: z.string(),                    // pageId — canonical graph identity + kind'tan türetilen hash (16A.1)
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),   // [TASLAK ÖNERİ] kök kategori sayfalarında null
  title: z.string(),
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),           // sayfa içeriği deterministik hash — incremental invalidation anahtarı (16A.10)
  freshness: z.enum(["fresh", "stale"]), // [TASLAK ÖNERİ] TŞ stale=true semantiğiyle hizalı (§9, §16A.5)
  coverage: z.object({
    status: CoverageStatusSchema,
    detail: z.string().optional(),
  }),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]); // [TASLAK ÖNERİ]

export const WikiPageSectionSchema = z.object({
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
sürümlenir. SQLite FTS5 external-content stratejisi seçilirse trigger/rebuild testleri gereklidir.

### 3.3 WikiLink (TŞ §16A.2, §16A.7)

```ts
export const WikiLinkKindSchema = z.enum([
  "PARENT_OF", "DOCUMENTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "PRODUCES",
  "CONSUMES", "TESTED_BY", "FLOWS_TO", "RELATED_CONTRACT", "CHANGED_IN",
]);

export const WikiLinkSchema = z.object({
  id: z.string(),
  wikiSnapshotId: z.string(),
  fromPageId: z.string(),
  toPageId: z.string(),       // hedef sayfa silinirse kayıt sessizce silinmez; bkz. aşağıdaki not
  kind: WikiLinkKindSchema,
  resolution: ResolutionSchema,
  evidenceRefs: z.array(EvidenceRefSchema),  // verified her link ≥1 Evidence (16A.7, ADR-004)
});
export type WikiLink = z.infer<typeof WikiLinkSchema>;
```

Davranış kuralları (TŞ §16A.2):

- Her ilişki kaynak GraphEdge/contract diff/evidence referansı taşır.
- Bir yöndeki bağlantıdan **backlink ters indeks üzerinden otomatik türetilir**; iki bağımsız link kaydı
  yazılmaz (çift yönlülük türetilir, kopyalanmaz — ADR-013).
- Bağlantı hedefi silinirse hedef sessizce kaybolmaz; sayfa `removed` veya `redirect_candidate` statüsünde
  gösterilir ve **broken-link diagnostics** üretilir. `[TASLAK ÖNERİ]` hedefsiz kalan `WikiLink` kaydının
  tutulma biçimi (null hedef vs. diagnostics kaydı) implementasyonda netleştirilir.
- URL/anchor oluştururken normalize edilmiş `pageId`, izin verilen route ve HTML escaping zorunludur.

### 3.4 WikiPageVersion (TŞ §16A.4, §16A.7)

```ts
export const WikiPageVersionSchema = z.object({
  pageId: z.string(),
  wikiSnapshotId: z.string(),
  revisionRef: z.string(),     // kalıcı revision kimliği (commit SHA / working-tree descriptor)
  contentHash: z.string(),
  linkSetHash: z.string(),     // link kümesi bütünlüğü (ADR-013)
  templateVersion: z.string(), // 16A.4 "en az ... templateVersion, coverage tutar"
  coverage: z.object({ status: CoverageStatusSchema }),
});
export type WikiPageVersion = z.infer<typeof WikiPageVersionSchema>;
```

Sürüm sınırları: shallow clone, silinmiş Git objesi, veri göçü veya indeks cache eviction durumunda sürüm
`not_available` dönebilir; geçmiş sayfanın varlığı sonsuz saklama taahhüdü değildir. Tarihi analiz **Git
checkout/reset/clean yapılmadan** `git show`/object read ile yapılır (TŞ §16A.4; kırmızı çizgi #3 ile uyumlu).

### 3.5 WikiAnnotation — overlay katmanı (TŞ §16A.6, §16A.7)

Wiki sayfası iki katmandır (ADR-012: Generated/Overlay Separation):

- **Generated layer**: kaynak GraphSnapshot'tan deterministik hazırlanır; her yeniden indekslemede yeniden
  üretilebilir ve **doğrudan elle düzenlenmez**.
- **Overlay layer**: insan notları, ekip açıklamaları, harici bağlantılar, isteğe bağlı host-model önerileri.

```ts
export const AnnotationAuthorKindSchema = z.enum(["human", "host_model_proposal"]); // [TASLAK ÖNERİ] değer adları
export const AnnotationOriginSchema = z.enum([
  "human_note",            // kullanıcı/ekip notu
  "external_link",         // harici bağlantı
  "host_model_proposal",   // host modelinin yazdığı, kullanıcının kabul ettiği öneri — verified=false KALIR
]); // [TASLAK ÖNERİ]

export const WikiAnnotationSchema = z.object({
  id: z.string(),
  stablePageId: z.string(),       // sayfa yeniden üretilse de anotasyon buna bağlı kalır (16A.6)
  sectionKey: z.string(),         // hangi bölüme eklendiği; generated içeriğin DIŞINDA render edilir
  authorKind: AnnotationAuthorKindSchema,
  origin: AnnotationOriginSchema,
  verified: z.boolean(),          // origin=host_model_proposal için daima false (16A.6)
  body: z.string(),
  annotationVersion: z.number().int().nonnegative(), // optimistic concurrency (16A.6)
  updatedAt: z.string().datetime(),
});
export type WikiAnnotation = z.infer<typeof WikiAnnotationSchema>;
```

Kurallar (TŞ §16A.6):

- `WikiAnnotation` **farklı storage/tabloda** saklanır; generated layer yenilendiğinde **asla üzerine yazılmaz**.
- Not oluşturma/düzenleme v1.0'da **ayrı yerel UI/CLI**, açık kullanıcı onayı ve yetki denetimi ile yapılır.
  **Normal MCP okuma aracı kaynak repo veya Wiki notları üzerinde otomatik yazı yapmaz** — 7 MCP aracının içinde
  anotasyon yazan araç **yoktur** (bkz. §5 yazma izin matrisi).
- Host modelinin yazdığı herhangi bir açıklama kullanıcı tarafından opsiyonel olarak kabul edilirse overlay'e
  eklenir; `origin=host_model_proposal` ve `verified=false` kalır. Bu, Causoryn'in kendisinin model çağırdığı
  anlamına gelmez (kırmızı çizgi #1).
- Kullanıcı notu kaynak koda dayanmayan anlatım içerirse **veri kanıtı statüsü kazanmaz**.
- Rename/removed page sonrası referans kaybında notlar silinmez; `orphaned` listesinde manuel yeniden bağlama
  bekler (orphan recovery, TŞ §19 risk tablosu).
- Workspace ve user storage açıkça ayrılır; export'ta overlay dahil etme varsayılan olarak **opt-in**dir
  (config: `includeManualNotesInExport: false`, §20).

### 3.6 WikiPageAlias (TŞ §16A.1, §16A.7)

```ts
export const WikiPageAliasSchema = z.object({
  oldPageId: z.string(),
  candidateNewPageId: z.string(),
  reason: z.string(),                          // örn. rename, relocation
  matchConfidence: z.number().min(0).max(1),   // [TASLAK ÖNERİ] 0..1 aralığı
});
export type WikiPageAlias = z.infer<typeof WikiPageAliasSchema>;
```

Rename/relocation kesin çözülemiyorsa `candidate_redirect` işaretlenir; **yanlış eşleşme sessizce yapılmaz**.

### 3.7 WikiSearchIndex — FTS5 (TŞ §16A.3, §16A.7)

FTS5 indeks alanları: `title, qualifiedSymbol, apiRoute, module, tags, deterministicBody, manualNotes (opt-in)`.
`manualNotes` aramaya dahil etme config ile opsiyoneldir: `wiki.includeManualNotesInSearch: false` (TŞ §20).

Arama sıralaması (TŞ §16A.3): **tam sembol/route eşleşmesi > başlık > modül > BM25/FTS5 içerik > graph yakınlığı**.
Relevance açıklaması `matchedFields` ve `evidenceIds` olarak döner; gizli vektör/embedding skoru gösterilmez,
çünkü embedding servisi **yoktur** (kırmızı çizgi #1). Sorgu filtreleri: `pageKind, language, project, revision,
resolution, scope`. Cursor/limit sınırları, query normalizasyonu ve FTS söz dizimi escape'i zorunludur. FTS5
güncellemesi transactional ve artımlıdır.

## 4. MCP araç sözleşmeleri — 7 Wiki aracı

### 4.1 Standart envelope ve hata kodları (TŞ §10.1)

Tüm Wiki araçları mevcut standart envelope'u kullanır (TŞ §16A.8): `schemaVersion, requestId, workspaceId,
snapshotId, status, coverage, warnings, data, nextCursor`. `status` örneği: `partial` (TŞ §10.1 envelope örneği).
Input/output Zod ile doğrulanır; uzun sonuçlar `limit/cursor` ile bölünür; stdout yalnızca MCP protokol trafiğidir,
loglar stderr'e gider (kırmızı çizgi #4). Stack trace MCP sonucuna yazılmaz; tekrar denenebilirlik ve kullanıcı
aksiyonu belirtilir.

İlgili hata kodu seti (TŞ §10.1, s.9): `WORKSPACE_NOT_AUTHORIZED, PATH_DENIED, INDEX_NOT_READY, AMBIGUOUS_SYMBOL,
UNRESOLVED_FLOW, UNSUPPORTED_LANGUAGE, INVALID_REVISION, CONTRACT_PARSE_FAILED, POLICY_INVALID, STALE_PREFLIGHT,
LIMIT_EXCEEDED, CANCELLED, EXPORT_NOT_ALLOWED, INTERNAL_ERROR, WIKI_PAGE_NOT_FOUND, WIKI_REVISION_NOT_AVAILABLE,
WIKI_BROKEN_LINK, WIKI_NOTE_CONFLICT`.

Kapsam notu: `WIKI_NOTE_CONFLICT` (annotationVersion optimistic concurrency çakışması, TŞ §16A.6) yukarıdaki 7
MCP okuma aracında **doğrudan dönmez**; not yazma/CLI-UI akışına aittir. `EXPORT_NOT_ALLOWED` benzer şekilde
`causoryn_export_documentation` akışına aittir. `WIKI_BROKEN_LINK` hem broken-link diagnostics verisi hem de
hata kodu olarak kullanılabilir `[TASLAK ÖNERİ]`.

### 4.2 Araçlar

Araç girdi alanları TŞ §10.2 kataloğuna (s.10), amaç/izin satırları TŞ §16A.8 tablosuna (s.17) sadıktır.
Tüm output şemaları envelope'un `data` alanının içeriğidir; `cursor` alanlı her çıktıda `nextCursor` taşınır.

#### 4.2.1 `causoryn_wiki_build`

- **Amaç**: Yetkili workspace için WikiProjection üretir/önbelleğe alır (TŞ §16A.8).
- **İzin**: ✍️ **YAZMA VAR — yalnızca izinli Causoryn data-root'a** (TŞ §16A.8: "yalnızca izinli Causoryn
  data-root'a yazar"). `wiki_build` explicit workspace authorization ister; **kaynak dosyalara yazamaz** (§5.2).

```ts
// Input (TŞ §10.2: scope?, revision?, mode?)
export const WikiBuildInputSchema = z.object({
  workspaceId: z.string(),        // envelope/oturum binding'inden; [TASLAK ÖNERİ] tüm input'lara eklenir
  scope: z.array(z.string()).optional(),   // alt küme kısıtı; boş/eksik = tüm workspace
  revision: z.string().optional(),         // commit SHA veya working-tree descriptor (16A.4)
  mode: z.enum(["full", "incremental"]).optional(), // [TASLAK ÖNERİ] değer kümesi TŞ'de açık değildir
});
export type WikiBuildInput = z.infer<typeof WikiBuildInputSchema>;

// Output (data alanı) [TASLAK ÖNERİ gövde; TŞ dayanağı §16A.8 "evidence coverage döndürür" + §21 metrikleri]
export const WikiBuildOutputSchema = z.object({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  status: WikiSnapshotStatusSchema,     // yalnızca ready/partial GraphSnapshot'tan publish (§9)
  pagesRegenerated: z.number().int(),   // §21: wiki_pages_regenerated
  brokenLinks: z.number().int(),        // §21: wiki_broken_links
  warnings: z.array(z.string()),
});
```

- **Hata kodları**: `WORKSPACE_NOT_AUTHORIZED` (workspace yetkisi yok), `INDEX_NOT_READY` (yayınlanmış
  ready/partial GraphSnapshot yok — §9 publish kuralı), `UNSUPPORTED_LANGUAGE` (kapsamdaki dil adapter'ı yok),
  `LIMIT_EXCEEDED`, `CANCELLED`, `INTERNAL_ERROR`.
- **Davranış**: yalnızca `ready`/`partial` GraphSnapshot WikiProjectionEngine'e giriş olabilir; sayfalar ve
  `wiki_fts` **aynı SQLite transaction'ı** içinde hazırlanır; eski tutarlı WikiSnapshot `stale=true` ile
  gösterilmeye devam eder (TŞ §9).

#### 4.2.2 `causoryn_wiki_get_tree`

- **Amaç**: Hiyerarşi ve sayfa sıralaması (TŞ §16A.8); sayfa ağacı + hiyerarşik navigasyon (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.**

```ts
// Input (TŞ §10.2: snapshotId?, parentId?, depth?, cursor?)
export const WikiGetTreeInputSchema = z.object({
  workspaceId: z.string(),
  snapshotId: z.string().optional(),   // yoksa en son yayınlanmış WikiSnapshot [TASLAK ÖNERİ]
  parentId: z.string().optional(),     // alt ağaç kökü
  depth: z.number().int().min(1).max(8).optional(), // üst sınır §20 results.maxDepth=8 ile hizalı [TASLAK ÖNERİ]
  cursor: z.string().optional(),
});

// Output (data) [TASLAK ÖNERİ gövde]
export const WikiTreeNodeSchema = z.object({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),
  title: z.string(),
  route: z.string(),
  coverage: z.object({ status: CoverageStatusSchema }), // no_data kategoriler dolgusuz listelenir (16A.1)
  freshness: z.enum(["fresh", "stale"]),
  childCount: z.number().int(),
});
export const WikiGetTreeOutputSchema = z.object({
  snapshotId: z.string(),
  nodes: z.array(WikiTreeNodeSchema),
  stale: z.boolean(),   // eski snapshot okunuyorsa true (§9)
});
```

- **Hata kodları**: `WIKI_PAGE_NOT_FOUND` (parentId bulunamadı), `WORKSPACE_NOT_AUTHORIZED`, `LIMIT_EXCEEDED`,
  `INTERNAL_ERROR`.

#### 4.2.3 `causoryn_wiki_get_page`

- **Amaç**: Sayfa bölümleri, provenance, coverage, source refs (TŞ §16A.8); sayfa blokları, evidence ve
  freshness (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.**

```ts
// Input (TŞ §10.2: pageId, snapshotId?, sections?, cursor?)
export const WikiGetPageInputSchema = z.object({
  workspaceId: z.string(),
  pageId: z.string(),                    // zorunlu
  snapshotId: z.string().optional(),
  sections: z.array(z.string()).optional(), // sectionKey filtresi
  cursor: z.string().optional(),            // uzun sayfalarda bölüm sayfalama
});

// Output (data) — 16A.1 sayfa alanları + generated/overlay ayrımı [TASLAK ÖNERİ gövde]
export const WikiGetPageOutputSchema = z.object({
  page: z.object({
    kind: WikiPageKindSchema,
    pageId: z.string(),
    parentId: z.string().nullable(),
    title: z.string(),
    route: z.string(),
    graphSnapshotId: z.string(),
    wikiSnapshotId: z.string(),
    coverage: z.object({ status: CoverageStatusSchema }),
    freshness: z.enum(["fresh", "stale"]),
    sourceRefs: z.array(EvidenceRefSchema),
  }),
  sections: z.array(WikiPageSectionSchema),           // generated layer (ADR-012)
  annotations: z.array(WikiAnnotationSchema).optional(), // overlay; sadece opt-in/izinle (16A.6)
  stale: z.boolean(),
});
```

- **Hata kodları**: `WIKI_PAGE_NOT_FOUND`, `WORKSPACE_NOT_AUTHORIZED`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.4 `causoryn_wiki_search`

- **Amaç**: FTS5 ve sembol eşleştirme, filtre/pagination (TŞ §16A.8); FTS5 / sembol / endpoint araması (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.** Gizli dosya içeriği gösterilmez: workspace access/secret exclusion politikası
  tüm Wiki index ve snippet'lerine uygulanır (TŞ §19).

```ts
// Input (TŞ §10.2: query, kinds?, scope?, snapshotId?, cursor?; §16A.3 filtreleri)
export const WikiSearchInputSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),                       // normalize edilir; FTS söz dizimi escape edilir (16A.3)
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().optional(),            // [TASLAK ÖNERİ] project/module yolu
  snapshotId: z.string().optional(),
  resolution: ResolutionSchema.optional(), // §16A.3 filtre listesi
  language: z.string().optional(),
  revision: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
});

// Output (data) [TASLAK ÖNERİ gövde; sıralama 16A.3'e göre]
export const WikiSearchHitSchema = z.object({
  pageId: z.string(),
  title: z.string(),
  pagePath: z.string(),        // erişilebilir sayfa yolu (16A.3)
  snippet: z.string(),
  matchedFields: z.array(z.string()),      // relevance açıklaması (16A.3)
  evidenceIds: z.array(z.string()),
  relatedSymbol: z.string().optional(),
  snapshotId: z.string(),
  freshness: z.enum(["fresh", "stale"]),
});
export const WikiSearchOutputSchema = z.object({
  hits: z.array(WikiSearchHitSchema),
  stale: z.boolean(),
});
```

- **Sıralama garantisi**: `CreateOrder` gibi tam sembol eşleşmesi, FTS genel eşleşmesinin **üstünde** döner
  (kabul testi, TŞ §16A.10).
- **Token bütçesi**: sonuca uygun özet döner; tam sayfa sonraki `wiki_get_page` çağrısıyla alınır (16A.3).
- **Hata kodları**: `WIKI_PAGE_NOT_FOUND` (snapshot yok/kök arama hatası), `WORKSPACE_NOT_AUTHORIZED`,
  `LIMIT_EXCEEDED`, `INDEX_NOT_READY` (FTS indeksi henüz kurulmadıysa), `INTERNAL_ERROR`.

#### 4.2.5 `causoryn_wiki_get_links`

- **Amaç**: Bağlantı/backlink ve evidence (TŞ §16A.8); outgoing + incoming/backlinks + evidence (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.**

```ts
// Input (TŞ §10.2: pageId, direction?, linkKinds?, cursor?; §16A.2 direction="both" örneği)
export const WikiGetLinksInputSchema = z.object({
  workspaceId: z.string(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional().default("both"),
  linkKinds: z.array(WikiLinkKindSchema).optional(),
  snapshotId: z.string().optional(),
  cursor: z.string().optional(),
});

// Output (data) — resolution + evidence ile (16A.2) [TASLAK ÖNERİ gövde]
export const WikiGetLinksOutputSchema = z.object({
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),  // backlink ters indeksinden türetilir (16A.2)
  brokenLinkDiagnostics: z.array(z.object({
    linkId: z.string(),
    kind: WikiLinkKindSchema,
    reason: z.string(),   // hedef removed/redirect_candidate statüsündeyse (16A.2)
  })),
});
```

- **Hata kodları**: `WIKI_PAGE_NOT_FOUND`, `WIKI_BROKEN_LINK` (bozuk bağlantı sorgusu diagnostics modunda
  hata olarak da dönebilir `[TASLAK ÖNERİ]`), `WORKSPACE_NOT_AUTHORIZED`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.6 `causoryn_wiki_get_versions`

- **Amaç**: Erişilebilir Git/snapshot revizyonları (TŞ §16A.8); commit / working-tree Wiki sürümleri (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.** Git tamamen salt okunur; `git show`/object read; checkout/reset/clean yok.

```ts
// Input (TŞ §10.2: pageId?, refs?, cursor?)
export const WikiGetVersionsInputSchema = z.object({
  workspaceId: z.string(),
  pageId: z.string().optional(),   // verilirse sayfa geçmişi; verilmezse snapshot revizyonları
  refs: z.array(z.string()).optional(), // commit SHA / branch / tag (branch hareketli takma addır, 16A.4)
  cursor: z.string().optional(),
});

// Output (data) [TASLAK ÖNERİ gövde]
export const WikiVersionEntrySchema = z.object({
  revisionRef: z.string(),
  wikiSnapshotId: z.string(),
  builtAt: z.string().datetime(),
  availability: z.enum(["available", "not_available"]), // shallow clone / silinmiş obje / cache eviction (16A.4)
  notAvailableReason: z.string().optional(),
});
export const WikiGetVersionsOutputSchema = z.object({
  versions: z.array(WikiVersionEntrySchema),
});
```

- **Hata kodları**: `INVALID_REVISION` (söz dizimi/çözümlenemeyen ref), `WIKI_REVISION_NOT_AVAILABLE`
  (veri göçü, silinmiş Git objesi, cache eviction — 16A.4), `WORKSPACE_NOT_AUTHORIZED`, `LIMIT_EXCEEDED`,
  `INTERNAL_ERROR`.

#### 4.2.7 `causoryn_wiki_diff`

- **Amaç**: Revision/snapshot sayfa farkları (TŞ §16A.8); sayfa, bölüm ve link değişim raporu (§10.2).
- **İzin**: 🔒 **SALT OKUNUR.** Tarihi revision karşılaştırması izole snapshot üretimiyle yapılır; working tree
  değişmez (kabul testi, §16A.10).

```ts
// Input (TŞ §10.2: base, target, pageId?)
export const WikiDiffInputSchema = z.object({
  workspaceId: z.string(),
  base: z.string(),      // revisionRef / wikiSnapshotId — zorunlu
  target: z.string(),    // revisionRef / wikiSnapshotId — zorunlu
  pageId: z.string().optional(), // tek sayfa daraltma
});

// Output (data) — alan kümesi TŞ §16A.4'ten birebir [TASLAK ÖNERİ yalnızca gövde tipleri]
export const WikiDiffOutputSchema = z.object({
  addedPages: z.array(z.string()),          // pageId listeleri [TASLAK ÖNERİ: detay nesnesi eklenebilir]
  removedPages: z.array(z.string()),
  changedSections: z.array(z.object({
    pageId: z.string(),
    sectionKey: z.string(),
  })),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  contractChanges: z.array(z.object({ contractId: z.string(), note: z.string() })), // [TASLAK ÖNERİ gövde]
  coverageDelta: z.record(z.string(), z.unknown()),   // [TASLAK ÖNERİ]
  unresolvedDifferences: z.array(z.object({ pageId: z.string(), reason: z.string() })), // [TASLAK ÖNERİ]
});
```

- **Kısmi belirsizlik**: sürüm stabil olmadığında veya parsing kısmi ise fark `inconclusive`/`partial` gösterilir
  (TŞ §16A.5). Manuel anotasyonlar diff raporuna **ayrı ve yalnızca istenirse** eklenir (TŞ §16A.7).
- **Hata kodları**: `INVALID_REVISION`, `WIKI_REVISION_NOT_AVAILABLE`, `WORKSPACE_NOT_AUTHORIZED`,
  `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 4.3 İsteğe bağlı MCP resources

Opsiyonel resource URI: `causoryn://wiki/{workspaceId}/{pageId}?snapshot={wikiSnapshotId}` (TŞ §16A.8).
Resources/read ve resource templates **yalnızca host desteklediğinde** yayımlanır; taşınabilir temel sözleşme
7 MCP tool'dur. MCP Apps gibi etkileşimli UI uzantıları host destek testinden sonra değerlendirilir; hiçbir
host'ta otomatik interaktif panel varmış gibi vaat edilmez.

## 5. Yazma izni: data-root kuralı ve izin matrisi

### 5.1 `wiki_build` yalnızca izinli data-root'a yazar

- `wiki_build` explicit workspace authorization ister; **kaynak dosyalara yazamaz** (TŞ §16A.8).
- Index ve snapshot **PLUGIN_DATA veya kullanıcı tanımlı data dizininde** tutulur; izinli export dışına dosya
  yazılmaz; file watcher kaynak dosyayı değiştirmez (TŞ §19, s.21).
- Yazım disiplini: izinli data-root/output-root, **atomic write**, chmod, traversal checks (TŞ §19).
- Ortam değişkeni: `CAUSORYN_DATA_DIR` (TŞ §20). `LLM_* / API_KEY / MODEL_PROVIDER` konfigürasyonuna izin verilmez.
- Offline Wiki export/viewer da izinli data-root ile sınırlıdır; canlı viewer yalnızca açıkça başlatılan local
  process, loopback binding, origin/CSRF kontrolleri ve izinli data-root ile (TŞ §16A.9).

### 5.2 Yazma izin matrisi

| Araç/akış | Yazma izni | Yazma hedefi | Kaynak |
|---|---|---|---|
| `causoryn_wiki_build` | ✅ VAR | Yalnızca izinli Causoryn data-root | TŞ §16A.8, §19 |
| `causoryn_wiki_get_tree` | ❌ YOK | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_page` | ❌ YOK | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_search` | ❌ YOK | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_links` | ❌ YOK | — (salt okunur) | TŞ §16A.8 |
| `causoryn_wiki_get_versions` | ❌ YOK | — (salt okunur; Git read-only) | TŞ §16A.8, kırmızı çizgi #3 |
| `causoryn_wiki_diff` | ❌ YOK | — (salt okunur; working tree değişmez) | TŞ §16A.8, §16A.10 |
| `causoryn_refresh_index` | ✅ (indeks) | Yalnızca Causoryn indeksi; WikiSnapshot'ı otomatik günceller | TŞ §10.2, mcp-tools.md |
| `causoryn_export_documentation` | ✅ (export) | Yalnızca explicit izinli output klasörü | TŞ §10.2, §16A.9 |
| Wiki not ekleme/düzenleme | ✅ (onaylı) | **MCP aracı YOK**; ayrı yerel UI/CLI + açık kullanıcı onayı | TŞ §16A.6, §10.2 |

Anlam: **7 Wiki aracından yalnızca `wiki_build` yazar** ve yalnızca data-root'a; diğer altısı analiz/query
bakımından salt okunurdur (TŞ §10.2 tool tasarım kuralı: "refresh_index yalnızca Causoryn indeksi üzerinde yazma
iznine sahiptir; export_documentation yalnızca explicit izinli output klasörüne yazar. Diğerleri analiz/query
bakımından salt okunurdur.").

## 6. Yeniden kullanım ilkesi: `refresh_index` ve `export_documentation`

TŞ §10.2 + §16A.8 (aynı ilke wiki/mcp-tools.md §"Tekrar kullanma ilkesi"nde):

1. `causoryn_refresh_index` başarılı bir GraphSnapshot yayımladığında **ilgili WikiSnapshot'ı otomatik günceller**
   (config: `wiki.autoBuildOnSnapshot: true`, TŞ §20).
2. `causoryn_export_documentation(view="wiki")` offline Wiki'yi (Markdown veya HTML) dışa aktarır.
3. Bu yüzden **ayrı `wiki_refresh` ve `wiki_export` tool'u AÇILMAZ** — araç sayısı 22 + 7 olarak kalır.
4. Wiki not ekleme/düzenleme, normal MCP sorgularından ayrı ve açık kullanıcı izinli CLI/yerel UI akışı olarak
   tasarlanır (TŞ §10.2).

Incremental akış (TŞ §16A.5): FileWatcher debounce → fingerprint + affected dependency closure → yeni
GraphSnapshot `building` → WikiProjectionEngine yalnızca ilişkili pageId'leri ve backlink/FTS indekslerini
günceller → link integrity/evidence/hash invariant kontrolü → **atomik, tutarlı publish** (GraphSnapshot +
WikiSnapshot) → yayına kadar eski Wiki `stale=true` ile okunur; `ready/partial/error` statüsü belirtilir.
Rename, branch switch, watcher overflow, parser config değişiminde **reconciliation scan** zorunludur.

İlgili konfigürasyon (TŞ §20, `causoryn.config.yaml` → `wiki:`):

```yaml
wiki:
  enabled: true
  autoBuildOnSnapshot: true
  includeManualNotesInSearch: false
  includeManualNotesInExport: false
  historicalSnapshotRetention: "metadata_and_derivatives" # raw source depolanmaz
  offlineExportDefault: true
```

Gözlemlenebilirlik metrikleri (TŞ §21): `wiki_projection_duration, wiki_pages_regenerated,
wiki_fts_update_duration, wiki_broken_links, wiki_stale_queries, wiki_orphaned_notes`.

## 7. Test ve kabul kriterleri (TŞ §16A.10 — implementasyon zamanı, Faz C2)

| Test | Kabul |
|---|---|
| Hiyerarşi | TS Orders fixture'dan Overview → APIs → POST /orders → Service gezintisi ve açık `no_data`/`partial` durumları |
| Çift yönlü link | `from->to` ilişkisi aynı snapshot'ta target backlink sorgusunda bulunur; verified ise evidence mevcut |
| Arama | `CreateOrder` exact symbol eşleşmesi ilgili sayfayı FTS genel eşleşmesinin üstünde döndürür |
| Sürüm | İki fixture Git commit'inde added/removed/changed ve link değişiklikleri doğru; **user working tree değişmez** |
| İnkremental | Sadece bir servis değişince etkilenen sayfalar yenilenir; bağımsız sayfa `contentHash`'i korunur |
| Kullanıcı notu | Art arda iki reindex manuel notları değiştirmez; rename'de not `orphaned` kalabilir, **veri kaybı olmaz** |
| Belirsizlik | Dinamik import çözülemiyorsa `partial`/`unresolved`; doğrulanmış link taklidi yapılmaz |
| Güvenlik | Offline HTML'de XSS escape + CSP; broken-link diagnostics; secret exclusion snippet'lere uygulanır (§22, §19) |

Her araç için sprint kuralı geçerlidir: pozitif + negatif + partial test üçlüsü (wiki/sprint-1.md; TŞ §23 DoD).

## 8. Açık konular (implementasyon öncesi karar bekler)

TŞ'de açık olmayan ve Faz C2 başında karara bağlanması gereken noktalar — bu dokümanda `[TASLAK ÖNERİ]` etiketiyle
önerilmiştir, iddia olarak değil:

1. `WikiSnapshot.status` değer kümesi (`failed` vs ayrı `error` bildirimi, §16A.5).
2. `wiki_build mode` enum değerleri (§10.2 yalnızca `mode?` diyor).
3. `freshness`, `CoverageStatus`, `section status` enum adları ve `coverageDelta` gövde tipi.
4. Bozuk link hedefinin storage gösterimi (`WikiLink.toPageId` null vs diagnostics kaydı).
5. Cursor formatı, varsayılan `limit` değerleri ve `nextCursor` sonraserme semantiği (MCP 2026-07-28 pagination
   ile hizalama, TŞ §16A.8).
6. `wiki_get_versions` çıktısında branch/tag alias çözümleme davranışı.
7. `contractChanges` diff gövdesi (Contracts fazı D ile senkron).

## 9. İlgili sayfalar

- [wiki/mcp-tools.md](../wiki/mcp-tools.md) — 29 araç kataloğu, envelope, yazma izin matrisi
- [wiki/scope.md](../wiki/scope.md) — 19. teslim: Living Wiki Engine (çapraz kesen)
- [wiki/sprint-4.md](../wiki/sprint-4.md) — Faz C2 implementasyon görevleri (W1–W8)
- [wiki/architecture.md](../wiki/architecture.md) — graph sözleşmesi, SQLite `wiki_*` tabloları, bağımlılık sınırları
- [wiki/decisions.md](../wiki/decisions.md) — ADR-004/005/008/010/011/012/013
- Kaynak: `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` §16A (s.14–18) — source of truth
