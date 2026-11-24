# Living Wiki Engine — Tasarım ve Uygulama Spesifikasyonu

> **Dil / Language:** **Türkçe** | [English](en/wiki-spec.md) · [Dokümantasyon Merkezi](README.md)
>
> **Durum:** Causoryn 0.3.0'ı yansıtır (varsayılan `core` araç profili; Living Wiki araçları isteğe bağlı olarak açılır, bkz. [§2](#2-wiki-araçlarını-ve-depolamayı-etkinleştirme) ve [CLI ve Konfigürasyon](cli-and-configuration.md)).
>
> **Kaynak modüller:** `packages/wiki/src/*` (saf projeksiyon, bağlantı, arama, overlay ve export çekirdekleri) · `packages/storage-sqlite/src/{wiki-schema.ts,wiki-store.ts}` (SQLite kalıcılığı) · `packages/mcp-server/src/services-wiki.ts` (MCP servisleri) · `packages/mcp-server/src/server.ts` + `schemas.ts` (araç kaydı ve girdi şemaları) · `packages/mcp-server/src/version.ts` (`WIKI_TOOL_NAMES`, araç profilleri).

> [!IMPORTANT]
> **Wiki araçları varsayılan araç yüzeyinde değildir.** Varsayılan `core` profili 11 araç listeler ve 7 `causoryn_wiki_*` aracının hiçbiri bunların arasında değildir. Sunucuyu **`--tool-profile wiki`** (veya `--tool-profile wiki,history` ya da `--tool-profile full`) ile başlatın veya **`CAUSORYN_TOOL_PROFILE=wiki`** ortam değişkenini ayarlayın. CLI bayrağı ortam değişkenine üstün gelir; bilinmeyen profil adları başlangıçta reddedilir. Wiki ayrıca bir SQLite veri kökü gerektirir (`--auto-data-dir`, `--data-dir <path>` veya `wiki.dataDbPath`); veri kökü yoksa `causoryn_wiki_build` `PATH_DENIED`, okuma araçları ise `INDEX_NOT_READY` döndürür.

> **Uygulama özeti (dürüst durum):**
> - **Uygulandı:** saf `@causoryn/wiki` motoru (`projectWiki`, `projectWikiIncremental`, `diffWikiGraphs`, `resolveWikiLinks`, `buildWikiLinkIndex`, `WikiSearchStore`, `computeWikiCoverageDeltas`, `computeWikiContractChanges`, `AnnotationOverlayEngine`, `exportWikiOffline`); `wiki_*` tablo ailesi ve `wiki_fts` FTS5 tablosuyla `SqliteWikiStore`; `wiki` / `full` profilleri altındaki 7 MCP wiki aracının tamamı.
> - **Kısmi:** `causoryn_wiki_build` on bir bağlantı türünden yalnızca üçünü üretir (`PARENT_OF`, `DEPENDS_ON`, `CALLS`); `component`, `symbol` ve `policy` sayfa türleri tanımlıdır ancak hiç üretilmez; `mode: "incremental"` değişmeyen sayfa içeriğini korur ama her yeni `WikiSnapshot` için yine de eksiksiz bir satır kümesi yazar; `causoryn_wiki_get_versions` ve `causoryn_wiki_diff`'in revizyon biçimi yalnızca en son yayımlanan `WikiSnapshot`'ı görür.
> - **Uygulanmadı:** ek `causoryn_wiki_search` filtreleri (`kinds`, `scope`, `language`, `revision`, `resolution`; şemada tanımlıdır ve `INVALID_ARGUMENT` ile açıkça reddedilir) ve graf yakınlığı (graph-proximity) sıralama ayağı; anotasyonlar için herhangi bir MCP veya CLI yüzeyi (overlay motoru yalnızca kütüphane düzeyindedir, bu yüzden `WIKI_NOTE_CONFLICT` bir MCP hata kodu değildir); MCP'den veya CLI'dan çevrimdışı wiki export'u (`causoryn_export_documentation(view="wiki")` `INVALID_ARGUMENT` döndürür); yeniden indekslemeden sonra otomatik wiki yeniden oluşturma; wiki snapshot saklama (retention) politikası. Ayrıntılar [§11](#11-limitler-ve-dürüst-eksikler)'de.

## İçindekiler

1. [Amaç ve kapsam](#1-amaç-ve-kapsam)
2. [Wiki araçlarını ve depolamayı etkinleştirme](#2-wiki-araçlarını-ve-depolamayı-etkinleştirme)
3. [Sayfa taksonomisi ve sayfa türleri](#3-sayfa-taksonomisi-ve-sayfa-türleri)
4. [Kimlikler, hash değerleri ve determinizm](#4-kimlikler-hash-değerleri-ve-determinizm)
5. [Veri modeli (Zod şemaları)](#5-veri-modeli-zod-şemaları)
6. [Projeksiyon, bağlantılar ve artımlı geçersizleştirme](#6-projeksiyon-bağlantılar-ve-artımlı-geçersizleştirme)
7. [Depolama şeması (`wiki_*`, `wiki_fts`)](#7-depolama-şeması-wiki_-wiki_fts)
8. [MCP araç sözleşmeleri — 7 wiki aracı](#8-mcp-araç-sözleşmeleri--7-wiki-aracı)
9. [Yazma izinleri ve güvenlik sınırları](#9-yazma-izinleri-ve-güvenlik-sınırları)
10. [Testler ve kabul kriterleri](#10-testler-ve-kabul-kriterleri)
11. [Limitler ve dürüst eksikler](#11-limitler-ve-dürüst-eksikler)
12. [Diğer ilgili dokümanlar](#12-diğer-ilgili-dokümanlar)

## 1. Amaç ve kapsam

Living Wiki Engine, Causoryn'in kanıt grafını SQLite içinde FTS5 indeksiyle saklanan, gezinilebilir, sürümlü ve aranabilir bir proje wiki'sine dönüştürür. İkinci bir kod analizörü **değildir**: üretilen her bölüm yayımlanmış, değişmez bir `GraphSnapshot`'tan (node'lar, edge'ler, kanıt span'leri, kontrat node'ları) türetilir. Wiki kaynak dosyaları kendisi okumaz; bu yüzden indekslemenin dışında bırakılan hiçbir şey ona ulaşmaz.

- **Living Wiki (`causoryn_wiki_*`):** 12 kök kategorili, kalıcı ve revizyonlu bir bilgi tabanı. `causoryn_wiki_build` bir `WikiSnapshot` projekte edip yayımlar; altı okuma aracı (`causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links`, `causoryn_wiki_get_versions`, `causoryn_wiki_diff`) onu sayfa sayfa gezer, bağlantıları ve backlink'leri izler, FTS5 araması yapar ve snapshot'ları karşılaştırır (diff).
- **Görsel Mimari Portalları (`causoryn_export_documentation`, core profil):** istek üzerine `output.allowedOutputDirs` içine yazılan bağımsız çevrimdışı çıktılar (`causoryn-architecture-interactive.html`, sıfır-JS `causoryn-architecture.html`, Mermaid `.mmd`, Architecture Brief `.md`, JSON blueprint). Bu araç Living Wiki'yi dışa aktarmaz (`view: "wiki"` reddedilir). Bkz. [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md).
- **Üretilen katman ve overlay katmanı:** üretilen bölümler serbestçe yeniden oluşturulur ve asla elle düzenlenmez. İnsan notları ve kullanıcının kabul ettiği host-model önerileri, yeniden oluşturmaların hiç dokunmadığı ayrı bir `wiki_annotations` overlay tablosuna aittir (bkz. [§5.6](#56-wikiannotation--overlay-katmanı)).
- **Source of truth (doğruluk kaynağı):** yetkilendirilmiş kaynak kod → `GraphSnapshot` → `WikiSnapshot`. Anotasyonlar ve host-model metni graf kanıtının yerine asla geçmez ve onu yükseltmez.
- **Model çağrısı yok:** wiki motoru hiçbir LLM veya embedding servisini çağırmaz; arama sıralaması FTS5 BM25 ile deterministik kurallardan oluşur ([LLM'siz politika](adr/ADR-002-no-llm.md)).
- **Determinizm:** aynı graph snapshot ve şablon sürümü aynı `WikiSnapshot` kimliğini, sayfa kimliklerini, bölüm kimliklerini, bağlantı kimliklerini ve içerik hash'lerini üretir. `builtAt` saf projeksiyonun bir girdisidir; MCP sunucusu bu değeri çalışma zamanı saatinden alır, bu yüzden zaman damgaları build'ler arasında farklılık gösterir, kimlikler göstermez.

## 2. Wiki araçlarını ve depolamayı etkinleştirme

### 2.1 Araç profilleri

Araç profilleri `packages/mcp-server/src/version.ts` içinde tanımlanır (`TOOL_PROFILES`, `WIKI_TOOL_NAMES`) ve `server.ts` (`resolveProfileToolNames`) ile `runtime-cli.ts` (`parseToolProfile`, `resolveEffectiveToolProfile`) içinde çözümlenir.

| Profil | Listelenen araçlar | Wiki araçları |
|---|---|---|
| `core` (varsayılan) | 11 | yok |
| `wiki` | 18 (11 core + 7 wiki) | 7'sinin tamamı |
| `wiki,history` | 20 (11 core + 7 wiki + 2 history) | 7'sinin tamamı |
| `full` | 32 (29 legacy ad + `causoryn_status`, `causoryn_trace`, `causoryn_contracts`) | 7'sinin tamamı |

Seçim sırası: `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`. Profiller virgülle birleştirilir. `full` profilinde yerini yeni araçlara bırakmış legacy araçlar bir kullanımdan kaldırma (deprecation) notu taşır; wiki araçları kullanımdan kaldırılmamıştır ve `wiki` ile `full` profillerinde aynı şekilde davranır.

### 2.2 Veri kökü

`causoryn_wiki_build`'in yazdığı ve okuma araçlarının okuduğu SQLite veritabanı, yetkilendirilmiş her çalışma alanı kökünün dışında bulunur:

1. **Sıfır-ayar (`--auto-data-dir` veya `--data-dir <path>`):** `buildWorkspaceAutoConfig` (`runtime-cli.ts`) taban dizini çözümler (her host için `--data-dir` > `~/.causoryn`; `ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` kullanılamadığında yedek) ve hem `storage.dataDbPath` hem `wiki.dataDbPath` değerini aynı dosyaya, `<base>/workspaces/<slug>-<hash12>/graph.sqlite` yoluna ayarlar. Tüm host'lar bu tek veritabanını paylaşır; dolayısıyla bir host'tan oluşturulan wiki, aynı veri dizinini kullanan her host tarafından görülür. Dizinler `0700` moduyla oluşturulur ve oluşturmadan önce ve sonra yetkilendirilmiş köklerin kesinlikle dışında oldukları denetlenir.
2. **Açık konfigürasyon:** `CAUSORYN_CONFIG` içinde `wiki.dataDbPath` değerini çalışma alanının dışındaki mutlak bir yola ayarlayın. Bu yol başlangıçta `validateDataDbPath` (`context.ts`) tarafından doğrulanır; bkz. [§9](#9-yazma-izinleri-ve-güvenlik-sınırları).

`wiki` konfigürasyon nesnesi yalnızca `dataDbPath` kabul eder (`config.ts`, katı şema); diğer anahtarlar başlangıçta reddedilir.

Örnek (sıfır-ayar, wiki araçları etkin):

```bash
causoryn mcp --allow-cwd --auto-data-dir --tool-profile wiki
# or
CAUSORYN_TOOL_PROFILE=wiki causoryn mcp --allow-cwd --auto-data-dir
```

Tipik çağrı sırası: graf indeksini bekleyin (`causoryn_status`), `causoryn_wiki_build`'i `mode: "full"` ile çağırın, ardından okuma araçlarını kullanın. Wiki asla otomatik olarak yeniden oluşturulmaz; yeniden indekslemeden sonra `causoryn_wiki_build`'i tekrar çağırın (siz çağırana kadar okuma araçları `stale: true` bildirir).

## 3. Sayfa taksonomisi ve sayfa türleri

### 3.1 Varsayılan sayfa ağacı

Her çalışma alanı wiki'sinde sabit taksonomi sırasında 12 kök kategori sayfası bulunur (`packages/wiki/src/taxonomy.ts`, `WIKI_ROOT_CATEGORIES`). Kategori `key` değeri sayfa kimliği türetmesine girer; rota `/wiki/<slug>` biçimindedir (slug = key).

```text
Workspace Wiki                 key / root kind
├── Overview                   overview / overview              # repository, languages, scope, unknowns
├── Architecture               architecture / architecture      # L0–L4 layer, module, component counts
├── Projects & Modules         projects-modules / project       # modules with components and dependencies
├── APIs & Entry Points        apis-entry-points / api          # endpoints, handlers, route links
├── Business Flows             business-flows / business_flow   # end-to-end flows (always no_data today)
├── Events & Integrations      events-integrations / event      # producers/consumers, async contracts
├── Data & Schemas             data-schemas / data              # databases, tables, columns, readers/writers
├── Contracts & Policies       contracts-policies / contract    # API/event/schema contracts
├── Tests & Quality            tests-quality / test             # test nodes, TESTS edges, coverage gaps
├── Architecture Timeline      architecture-timeline / timeline # commit history (always no_data today)
├── Onboarding                 onboarding / onboarding          # learning paths (always no_data today)
└── Unresolved & Coverage      unresolved-coverage / coverage   # unresolved edges, UnknownExternal nodes
```

### 3.2 Sayfa türleri ve graf kaynakları

Sayfa türü enum'u (`WikiPageKindSchema`) 16 değer içerir: `overview | architecture | project | module | component | symbol | api | business_flow | event | data | contract | policy | test | timeline | onboarding | coverage`. Tablo, mevcut projeksiyonun (`packages/wiki/src/projection.ts`) gerçekte neler ürettiğini gösterir.

| `kind` | Üretim biçimi | Graf kaynağı | Bölüm anahtarları |
|---|---|---|---|
| `overview` | kök sayfa | `Workspace` / `Repository` / `Project` node'ları; node/edge/kanıt sayıları; dil başına node sayıları | `summary`, `languages` |
| `architecture` | kök sayfa | Katman başına node sayıları: L0 `Repository`/`Workspace`, L1 `Project`/`Module`/`Package`, L2 `Class`/`Interface`/`Type`, L3 `Method`/`Function`/`Endpoint`/`Handler`, L4 kontrat node'ları | `layers` |
| `project` | kök sayfa (Projects & Modules) | Konumlarıyla birlikte `Module` node'ları | `modules` |
| `module` | her `Module` node'u için alt sayfa | `CONTAINS` (giden) ve `DEPENDS_ON` (her iki yön) edge'leri | `components`, `dependencies` |
| `api` | kök sayfa + her `Endpoint` node'u için alt sayfa | kök: endpoint listesi; alt: rota, dil, konum, `ROUTES_TO` / `HANDLES` edge'leri | kök `endpoints`; alt `route`, `handler` |
| `event` | kök sayfa + her `Event` / `Topic` / `Queue` node'u için alt sayfa | `PUBLISHES` (giden), `SUBSCRIBES` (gelen) | kök `events`; alt `publishers`, `subscribers` |
| `data` | kök sayfa + her `Table` node'u için alt sayfa | kök: `Database` / `Table` / `Column` sayıları; alt: gelen `READS` / `WRITES` | kök `schemas`; alt `readers-writers` |
| `contract` | kök sayfa (Contracts & Policies) + her kontrat node'u için alt sayfa | `ApiContract` / `EventContract` / `SchemaContract` / `ContractVersion` node'ları ve öznitelikleri | kök `contracts`; alt `definition` |
| `test` | kök sayfa | `Test` node'ları ve `TESTS` edge'leri | `tests`, `coverage-gaps` (her zaman `no_data`) |
| `coverage` | kök sayfa | `resolution: "unresolved"` taşıyan edge'ler ve `UnknownExternal` node'ları | `unresolved` |
| `business_flow`, `timeline`, `onboarding` | kök sayfa, yapısal olarak `no_data` | `GraphSnapshot` içinde taşınmaz (akış, Git geçmişi ve onboarding çıktıları başka motorlardan gelir) | `flows`, `commits`, `path` |
| `component`, `symbol`, `policy` | **üretilmez** | yalnızca enum'da ve SQL `CHECK` kısıtında tanımlıdır | — |

`policy` sayfası yoktur: "Contracts & Policies" kökünün türü `contract`'tır; guard-policy veya baseline-suppression verisi bugün wiki'ye projekte edilmez.

### 3.3 Üretim ilkeleri

1. **Arkasında graf node'u olmayan sayfa yoktur.** Alt sayfalar yalnızca `WIKI_CHILD_PAGE_SOURCES` içinde listelenen node'lar için oluşur; boş kategoriler asla dolgu metinle doldurulmaz.
2. **`no_data` boş kalır.** Bir `no_data` bölümü her zaman `generatedMarkdown: ""` taşır ve kanıt içermez. Yapısal `no_data` kökleri (Business Flows, Architecture Timeline, Onboarding) açıklayıcı bir `coverage.detail` taşır.
3. **Kapsam toplaması** (`materializeWikiPage`): tüm bölümler `no_data` → sayfa `no_data`; tümü `ok` → `complete`; aksi halde `partial`. Katkıda bulunan edge'lerden en az biri `unresolved` ise bölüm `partial` olur.
4. **Desteklenmeyen türler.** Saf motor `supportedPageKinds` seçeneğini kabul eder; bu kümenin dışındaki kategoriler bir uyarıyla ve alt sayfasız olarak `unsupported` olur. MCP build bu seçeneği geçirmez, bu yüzden her tür desteklenmiş kabul edilir.
5. **Kararlı kimlik.** `pageId`, görünen başlıktan veya slug'dan değil, kanonik graf kimliği + sayfa türünden türetilir (bkz. [§4](#4-kimlikler-hash-değerleri-ve-determinizm)).
6. **Rotalar ve slug'lar.** Alt rotalar `/wiki/<categorySlug>/<slug>` biçimindedir; slug, node'un nitelikli adının (qualified name) `[a-z0-9-]` kümesine indirgenmiş hâlidir. Bir kategori içindeki slug çakışmaları, node kimliğinden alınan deterministik bir sonek alır.
7. **Her sayfa**, okuma araçları üzerinden `kind`, `pageId`, `parentId`, `title`, `route`, `coverage`, `freshness`, `contentHash` ve `wikiSnapshotId` / `graphSnapshotId` değerlerini sunar.

## 4. Kimlikler, hash değerleri ve determinizm

Tüm hash'ler, `@causoryn/domain`'den gelen kanonik JSON (sıralı anahtarlar, boşluksuz) üzerinde SHA-256'dır.

| Kimlik | Türetme (kod) |
|---|---|
| `wikiSnapshotId` | `wiki:` + sha256(`[graphSnapshotId, WIKI_TEMPLATE_VERSION]`) — `deriveWikiSnapshotId`; `WIKI_TEMPLATE_VERSION = "1.1.0"` |
| Kök `pageId` | `page:` + sha256(`[workspaceId, "root", categoryKey, categoryKind]`) — `wikiRootPageIdFor` |
| Alt `pageId` | `page:` + sha256(`[workspaceId, "node", pageKind, nodeId]`) — `wikiChildPageId` |
| Bölüm `id` | `section:` + sha256(`[pageId, sectionKey]`) |
| Bağlantı `id` | `wikilink:` + sha256(`[kind, fromPageId, toRef]`) — `services-wiki.ts` |
| `contentHash` | şablon sırasındaki her bölümün `{sectionKey, generatedMarkdown, evidenceRefs, status}` değerleri üzerinde sha256 (`content-hash.ts`); sayfa kimliği, başlık, slug ve rota hariç tutulur, bu yüzden görünen başlığı yeniden adlandırmak onu değiştirmez |
| `linkSetHash` | sayfanın kimliğe göre sıralanmış giden bağlantıları `{id, kind, toPageId, resolution}` üzerinde sha256 |

- **İki düzeyli sürümleme:** `GraphSnapshot` → deterministik `WikiSnapshot`. Wiki'si zaten en son yayımlanmış wiki olan bir graph snapshot için `causoryn_wiki_build`'i yeniden çalıştırmak idempotent bir no-op'tur (`pagesRegenerated: 0` artı bir uyarı).
- **Şablon sürümü:** üretilen bir Markdown şablonunu değiştirmek `WIKI_TEMPLATE_VERSION`'ı yükseltmeyi gerektirir; bu, her `wikiSnapshotId`'yi değiştirir ve artımlı build'leri full build'e geri dönmeye zorlar. Üretilen şablonlar İngilizceye çevrildiğinde sürüm `1.1.0`'a yükseltilmiştir; daha eski bir şablon sürümüyle yayımlanmış bir wiki bu nedenle bir sonraki build'de yeniden oluşturulur.
- **`revisionRef`:** varsayılan olarak graph snapshot'ın `revision.id` değeridir. İndeksleyici buraya `working-tree` kaydeder; bu yüzden `causoryn_wiki_build` açık bir `revision` etiketiyle çağrılmadıkça her `WikiSnapshot`'ın değeri `revisionRef: "working-tree"` olur. `revision` girdisi serbest biçimli bir etikettir; Git'e karşı çözümlenmez.
- **Çıktı sırası:** kökler taksonomi sırasında, alt sayfalar önce kategoriye sonra `pageId`'ye göre sıralanır; tüm çekirdek çıktılar derinlemesine dondurulur (deep-freeze).

## 5. Veri modeli (Zod şemaları)

Çalışma zamanı şemaları `packages/wiki/src/{schema.ts,links.ts,overlay.ts,search-schema.ts}` içinde bulunur ve `packages/storage-sqlite/src/wiki-schema.ts` içindeki `wiki_*` tablolarına eşlenir. Aşağıdaki alıntılar kodla birebir eşleşir.

### 5.1 Ortak tipler

```ts
// Resolution: "verified" means static/checker evidence, not a runtime guarantee.
export const WikiResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

// Reference to a graph Evidence record with a source span. Evidence without a
// span is never turned into a fake location.
export const EvidenceRefSchema = z.strictObject({
  evidenceId: z.string(),
  relativePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  sourceHash: z.string(),
});
```

### 5.2 WikiSnapshot

```ts
// Same value set as GraphSnapshot.state; there is no separate "error" status.
export const WikiSnapshotStatusSchema = z.enum(["building", "ready", "partial", "failed"]);

export const WikiSnapshotSchema = z.strictObject({
  id: z.string(),               // deriveWikiSnapshotId(graphSnapshotId)
  workspaceId: z.string(),
  graphSnapshotId: z.string(),  // only ready/partial graph snapshots are projectable
  revisionRef: z.string(),      // graph revision.id ("working-tree") or the build's revision label
  status: WikiSnapshotStatusSchema,
  builtAt: z.iso.datetime(),    // injected clock; not part of any ID
  templateVersion: z.string(),  // WIKI_TEMPLATE_VERSION
});
```

Yayımlanan durum kaynak grafı yansıtır: `ready` bir graf `ready` bir wiki, `partial` bir graf `partial` bir wiki verir. `building` satırları okuyuculara görünmez; hata fırlatan bir build `failed` olarak kapatılır.

### 5.3 WikiPage ve WikiPageSection

```ts
export const CoverageStatusSchema = z.enum(["complete", "partial", "unsupported", "no_data"]);
export const FreshnessSchema = z.enum(["fresh", "stale"]);
export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]);

export const WikiPageSchema = z.strictObject({
  id: z.string(),                    // pageId (see §4)
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),   // null on the 12 root pages
  title: z.string(),                 // child pages: the node's qualifiedName
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),           // incremental invalidation key
  freshness: FreshnessSchema,
  coverage: z.strictObject({ status: CoverageStatusSchema, detail: z.string().optional() }),
});

export const WikiPageSectionSchema = z.strictObject({
  id: z.string(),
  pageId: z.string(),
  sectionKey: z.string(),            // fixed template key, versioned by WIKI_TEMPLATE_VERSION
  generatedMarkdown: z.string(),     // source-derived only; never edited by hand
  evidenceRefs: z.array(EvidenceRefSchema),
  status: WikiPageSectionStatusSchema,
});
```

`WikiProjectionSchema` (`{ snapshot, pages, sections, warnings }`) yinelenen sayfa veya bölüm kimliklerini, bilinmeyen sayfalara işaret eden bölümleri ve bilinmeyen ebeveynlere işaret eden alt sayfaları reddeder. Sayfa `freshness` değeri `fresh` olarak yazılır; bayatlık her yanıtta `stale` bayrağıyla bildirilir (bkz. [§8.1](#81-ortak-davranış)).

### 5.4 WikiLink ve kırık bağlantı tanılamaları

```ts
export const WikiLinkKindSchema = z.enum([
  "PARENT_OF", "DOCUMENTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "PRODUCES",
  "CONSUMES", "TESTED_BY", "FLOWS_TO", "RELATED_CONTRACT", "CHANGED_IN",
]);

export const WikiLinkSchema = z.strictObject({
  id: z.string(),
  wikiSnapshotId: z.string(),
  fromPageId: z.string(),
  toPageId: z.string().nullable(),   // unresolved targets are kept with toPageId = null
  kind: WikiLinkKindSchema,
  resolution: WikiResolutionSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
}).superRefine(/* a "verified" link without evidenceRefs is rejected */);

export const BrokenLinkDiagnosticSchema = z.strictObject({
  linkId: z.string(),
  fromPageId: z.string(),
  toRef: z.string().nullable(),      // raw target name; null when derived from stored rows
  kind: WikiLinkKindSchema,
  reason: z.string(),
});
```

Kurallar (`packages/wiki/src/links.ts`):

- `verified` bir bağlantı en az bir `EvidenceRef` taşımalıdır; şema ihlalleri reddeder. Build yolu, span kanıtı olmayan `verified` bir graf edge'ini geçersiz bir bağlantı üretmek yerine `heuristic`'e düşürür ve bir uyarı ekler.
- **Backlink'ler saklanmaz, türetilir.** `buildWikiLinkIndex`, saklanan tek bağlantı satırından ileri ve ters eşlemeler kurar; böylece backlink araması O(1)'dir ve karşılıklı (reciprocal) satır bulunmaz.
- **Kırık bağlantılar hata değil, veridir.** `resolveWikiLinks` bir taslağın `toRef` değerini şu sırayla çözümler: sayfa kimliği, slug, alias metni, eski sayfa kimliği yönlendirmesi. Çözümlenemeyen hedef `toPageId: null` ile korunur, backlink kovalarının dışında tutulur ve `brokenLinkDiagnostics` içinde raporlanır. `matchConfidence < 1` olan bir alias üzerinden çözümlenen bağlantı `verified`'dan `heuristic`'e sınırlanır.
- Bilinmeyen bir kaynak sayfadan gelen taslaklar ve yinelenen bağlantı kimlikleri reddedilir.

### 5.5 WikiPageVersion

Her snapshot'ta her sayfa için bir kez saklanır (`wiki_page_versions`, birincil anahtar `(wiki_snapshot_sid, page_id)`):

```ts
interface WikiPageVersion {
  pageId: string;
  wikiSnapshotId: string;
  revisionRef: string;
  contentHash: string;
  linkSetHash: string;       // outgoing link-set integrity hash
  templateVersion: string;
  coverage: { status: CoverageStatus };
}
```

Revizyonlar arası geçmiş ayrı `WikiSnapshot` satırlarında tutulur. Saklanmış bir `WikiSnapshot`'ı olmayan sorgulanmış bir revizyon, `notAvailableReason` ile birlikte `availability: "not_available"` olarak raporlanır; eski sürümlerin tutulması bir saklama (retention) garantisi değildir.

### 5.6 WikiAnnotation — overlay katmanı

`packages/wiki/src/overlay.ts` iki katmanı ayırır: üretilen katman (serbestçe yeniden oluşturulur) ve overlay katmanı (insan notları, harici bağlantılar, kullanıcının kabul ettiği host-model önerileri).

```ts
export const AnnotationAuthorKindSchema = z.enum(["human", "host_model_proposal"]);
export const AnnotationOriginSchema = z.enum(["human_note", "external_link", "host_model_proposal"]);

export const WikiAnnotationSchema = z.strictObject({
  id: z.string().min(1),
  stablePageId: z.string().min(1),   // deterministic pageId the note is attached to
  sectionKey: z.string().min(1),     // rendered outside generatedMarkdown
  authorKind: AnnotationAuthorKindSchema,
  origin: AnnotationOriginSchema.optional(),
  verified: z.boolean().optional(),
  body: z.string(),                  // must not be blank
  annotationVersion: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
}).superRefine(/* see rules below */);
```

Kurallar (`AnnotationOverlayEngine`, `SqliteWikiStore`):

- Anotasyonlar, üretilen `wiki_*` tablolarına yabancı anahtarı (FK) olmayan `wiki_annotations` tablosunda tutulur; sayfaları yeniden oluşturmak onların üzerine asla yazmaz ve onları silmez.
- `origin: "host_model_proposal"` değeri `verified: true` taşıyamaz ve `origin: "host_model_proposal"` yalnızca `authorKind: "host_model_proposal"` ile birlikte kullanılabilir (tersi de geçerlidir). Host önerileri insan notlarından ayrı, kendine özgü bir etiketle render edilir. Causoryn bunları üretmek için hiçbir zaman model çağırmaz.
- **İyimser eşzamanlılık (optimistic concurrency):** `addAnnotation` `0` sürümüyle başlar; `updateAnnotation`, `expectedAnnotationVersion` değerine karşı atomik bir compare-and-swap uygular ve uyuşmazlıkta `wiki/annotation-conflict` fırlatır (amaçlanan MCP kodu `WIKI_NOTE_CONFLICT` kayıtlı değildir, bkz. [§8.2](#82-hata-kodları)). Her başarılı yazma sürümü bir artırır.
- **Yetimler (orphans):** `markAnnotationOrphans`, `stablePageId` güncel projeksiyonda yoksa `orphan: true` türetir; satır asla silinmez veya değiştirilmez. Sayfa kimlikleri deterministik olduğundan, sayfa geri geldiğinde bayrak hiçbir yazma olmadan kendiliğinden kalkar.
- **Yüzey:** anotasyonları okuyan veya yazan hiçbir MCP aracı ve CLI komutu yoktur. `causoryn_wiki_get_page` yalnızca üretilen katmanı döndürür. Overlay, onaylı bir yerel UI/CLI akışını bekleyen, test edilmiş bir kütüphane yeteneğidir.

### 5.7 Alias'lar

`wiki_aliases` (`WikiAliasInput`: `pageId`, `alias`, `source`, `candidateNewPageId?`, `0..1` aralığında `matchConfidence?`) belirsiz yeniden adlandırmaları veya yer değiştirmeleri kaydeder. `candidateNewPageId = null` çözümlenmemiş bir aday yönlendirmeyi işaretler; belirsiz eşleşmeler asla `verified`'a yükseltilmez. `resolveWikiLinks` kendisine verildiğinde alias'ları kullanır, ancak MCP build yolu bugün alias yazmaz ve geçirmez.

### 5.8 WikiSearchIndex (FTS5)

`wiki_fts`; `title`, `qualified_symbol`, `api_route`, `module`, `tags`, `body` sütunlarını indeksler; `page_id` ve `wiki_snapshot_sid` indekslenmeyen birleştirme (join) anahtarlarıdır. Build'in yazdıkları (`buildFtsDocs`):

| Sütun | Değer |
|---|---|
| `title` | sayfa başlığı |
| `qualified_symbol` | alt sayfalar: node'un nitelikli adı (= başlık); kök sayfalar: null |
| `api_route` | `api` alt sayfaları: endpoint'in nitelikli adı; aksi halde null |
| `module` | `module` alt sayfaları: modülün nitelikli adı; aksi halde null |
| `tags` | her zaman null |
| `body` | boş olmayan bölüm Markdown'larının birleşimi; boşsa null |

Anotasyonlar asla indekslenmez.

## 6. Projeksiyon, bağlantılar ve artımlı geçersizleştirme

### 6.1 Tam projeksiyon (`projectWiki`)

1. Graf domain `SnapshotSchema`'ya karşı doğrulanır; ISO biçiminde olmayan `builtAt` reddedilir (`wiki/invalid-input`).
2. Yalnızca `ready` / `partial` graph snapshot'ları kabul edilir (aksi halde `wiki/snapshot-not-projectable`).
3. 12 kök sayfa sabit bölüm şablonlarından oluşturulur, ardından alt sayfalar `WIKI_CHILD_PAGE_SOURCES` üzerinden planlanır (`projects-modules` ← `Module`; `apis-entry-points` ← `Endpoint`; `events-integrations` ← `Event`/`Topic`/`Queue`; `data-schemas` ← `Table`; `contracts-policies` ← kontrat node'ları).
4. Katkıda bulunan edge'lerin span kanıtı her bölüme eklenir (`evidenceId`'ye göre sıralı).
5. Uyarılar tek bir ortak üreticiden üretilir (desteklenmeyen kategoriler, `partial` bölümler), tüm projeksiyon `WikiProjectionSchema`'ya karşı doğrulanır ve derinlemesine dondurulur.

### 6.2 `causoryn_wiki_build` içinde bağlantı üretimi

`buildLinkDrafts` (`services-wiki.ts`) şunları üretir:

- Her kök sayfadan her alt sayfasına, `resolution: "heuristic"` ile ve kanıtsız **`PARENT_OF`** (yapısal taksonomi bağlantısı).
- Her iki ucunda da alt sayfa bulunan, bu türlerdeki graf edge'leri için **`DEPENDS_ON` ve `CALLS`**. Bağlantı edge'in resolution değerini ve span kanıtını korur; span kanıtı olmayan `verified` bir edge bir uyarıyla `heuristic`'e düşürülür.

Aynı sayfa çifti arasındaki aynı türden birden çok edge tek bir bağlantıda birleşir. Diğer sekiz bağlantı türü şemada ve SQL kısıtında tanımlıdır ancak üretilmez. `CALLS` edge'leri genellikle sayfası olmayan fonksiyonları veya metotları bağladığından, `CALLS` bağlantıları yalnızca bir `CALLS` edge'i sayfası olan iki node'u bağladığında görünür. Tüm taslaklar aynı projeksiyondaki sayfaları hedeflediğinden `brokenLinks` normalde `0`'dır; kırık bağlantı modeli çekirdek testlerde sınanır.

### 6.3 Artımlı geçersizleştirme (`projectWikiIncremental`)

`mode: "incremental"`, önceki yayımlanmış `WikiSnapshot`'ı ve onun kaynak graph snapshot'ını kullanır:

1. `diffWikiGraphs`, değişen / eklenen / kaldırılan node, edge ve kanıt kimliklerini ve ayrıca `configChanged`, `analyzerChanged`, `revisionChanged`, `stateChanged` değerlerini hesaplar.
2. **Full build'e geri dönüş** (asla sessizce değil, `mode: "full"` + `fallbackReason` olarak raporlanır) şu durumlarda olur: yayımlanmış bir `WikiSnapshot` yoksa; önceki wiki'nin graph snapshot'ı artık okunamıyorsa; parser konfigürasyonu veya analyzer parmak izi (fingerprint) değiştiyse; şablon sürümü değiştiyse; desteklenen tür kümesi değiştiyse; önceki projeksiyon bütünlük denetimlerinden geçemiyorsa (eksik bölümler, içerik hash uyuşmazlığı, çalışma alanı veya graf kimliği uyuşmazlığı, korunacak bir sayfanın eksik olması).
3. **Sayfa seçimi:** herhangi bir içerik değişikliği graf genelindeki her kök sayfayı seçer (üç yapısal `no_data` kökü dışındaki tüm kökler). Değişen, eklenen veya kaldırılan node'lar ile değişen, eklenen veya kaldırılan edge'lerin her iki ucu kendi alt sayfalarını seçer.
4. **İçerik hash koruması:** seçilen sayfalar yeniden üretilir; yeni `contentHash` eskisine eşitse sayfa korunmuş sayılır. Seçilmeyen sayfalar değiştirilmeden aktarılır.
5. Sonuç, aynı grafın full build'iyle kanonik olarak özdeştir (aynı şablonlar, planlayıcı ve uyarı üreticisi).

`pagesRegenerated` içerik hash'i değişen sayfaları sayar; `sectionsRegenerated` bu sayfaların bölümlerini sayar. Yazma işlemi yeni `WikiSnapshot` için yine de tam bir satır kümesi (sayfalar, bölümler, bağlantılar, sürümler, FTS dokümanları) saklar; bu satır yeniden yazımlarını daraltmak açık bir iştir.

### 6.4 Diff hesaplamaları

- `changedSections`: her iki tarafta da bulunan sayfaların Markdown'ı, durumu veya kanıtı farklı olan bölümleri ile yalnızca bir tarafta bulunan bölüm anahtarları.
- `addedLinks` / `removedLinks`: bağlantı kimliği küme farkı.
- `coverageDelta` (`computeWikiCoverageDeltas`): `coverage.status` değeri değişen sayfalar (bölüm sayısı gerekçesiyle), yeni sayfalar (`previous: "no_data"`) ve kaldırılan sayfalar (`current: "no_data"`).
- `unresolvedDifferences`: `partial` bölüm sayısı değişen ortak sayfalar.
- `contractChanges` (`computeWikiContractChanges`): iki arka graph snapshot'ın kontrat node'larını `"<nodeKind> <qualifiedName>"` anahtarıyla karşılaştırır. `added` ve `modified` kayıtları hedef node kimliğini, `removed` kayıtları taban node kimliğini taşır; `modified`, tür, nitelikli ad, dil, konum ve öznitelik hash'inin değiştiği anlamına gelir ve özet her iki 12 karakterlik hash önekini içerir. Arka graph snapshot'lardan biri artık saklanmıyorsa `contractChanges` bir uyarıyla `[]` olur.

## 7. Depolama şeması (`wiki_*`, `wiki_fts`)

`packages/storage-sqlite/src/wiki-schema.ts` içinde tanımlanır ve ana şemayla birlikte uygulanır (`user_version = 5`). Tüm DDL ve DML, bağlı parametreli statik SQL'dir.

| Tablo | Anahtar | Notlar |
|---|---|---|
| `wiki_snapshots` | `sid` (integer PK); `id` UNIQUE, build sırasında NULL | `workspace_id`, `graph_snapshot_id`, `revision_ref`, `status` (`building\|ready\|partial\|failed`), `created_at`, `built_at`, `template_version`, `failure_reason`. Kısmi (partial) bir unique indeks, `(workspace_id, graph_snapshot_id)` başına yalnızca bir `building` satırına izin verir. |
| `wiki_pages` | `(wiki_snapshot_sid, page_id)` | `kind` ve `coverage_status` `CHECK` kısıtları; `parent_id` aynı tabloya bileşik bir FK'dir; `position` kanonik sırayı korur. |
| `wiki_page_sections` | `(wiki_snapshot_sid, section_id)` | `generated_markdown`, `evidence_refs_json`, `status`; sayfaya FK. |
| `wiki_links` | `(wiki_snapshot_sid, link_id)` | `to_page_id` nullable (kırık bağlantılar); null olmayan hedefler FK ile denetlenir; `from_page_id` ve `to_page_id` üzerinde indeksler. |
| `wiki_page_versions` | `(wiki_snapshot_sid, page_id)` | `revision_ref`, `content_hash`, `link_set_hash`, `template_version`, `coverage_status`. |
| `wiki_annotations` | `id` | Overlay: yalnızca `workspaces` tablosuna bağlıdır, hiçbir wiki snapshot'ına bağlı değildir. |
| `wiki_aliases` | `(workspace_id, page_id, alias)` | `source`, `candidate_new_page_id`, `match_confidence` (`0..1` `CHECK`). |
| `wiki_fts` | FTS5 sanal tablosu | Sütunlar [§5.8](#58-wikisearchindex-fts5)'deki gibidir; FK yoktur. |

Alt tablolar snapshot silindiğinde kademeli olarak (cascade) silinir, ancak bugün hiçbir şey wiki snapshot'larını silmez (bkz. [§11](#11-limitler-ve-dürüst-eksikler)).

**Build ve yayım sırası** (`writeAndPublishWikiProjection`): `beginWikiBuild` bir `building` satırı ekler → sayfalar, bölümler, bağlantılar, sayfa sürümleri ve FTS dokümanları bu satıra yazılır → `publishWiki` tek bir transaction içinde `id`, `status` ve `built_at` değerlerini ayarlar. Herhangi bir hatada satır `failWikiBuild` ile kapatılır (`failed`); böylece yarım yazılmış bir snapshot asla okunamaz ve bayat bir `building` kilidi kalmaz. Arama, aynı dosyaya açılan ikinci, salt okunur bir veritabanı bağlantısı kullanır.

## 8. MCP araç sözleşmeleri — 7 wiki aracı

Yalnızca `--tool-profile wiki`, `wiki,history` veya `full` altında kullanılabilir ([§2.1](#21-araç-profilleri)). Girdi şemaları `packages/mcp-server/src/schemas.ts`'ten kaydedilir (`Wiki*ToolInputSchema`; aşağıdaki servis şemalarıyla biçimce aynıdır); çıktı veri şemaları `services-wiki.ts`'ten gelir. Her yanıt standart 10 alanlı envelope'tur (`schemaVersion: "2.0"`). `outputSchema` varsayılan olarak `tools/list` çıktısına konmaz (`--output-schema full` onu yayımlar); sunucu her iki durumda da her envelope'u doğrular.

### 8.1 Ortak davranış

- **MCP araç annotations'ları:** `causoryn_wiki_build` `readOnlyHint: false` taşır (yalnızca wiki SQLite veri köküne yazar); altı okuma aracı `readOnlyHint: true` taşır. Yedisinin tamamı `destructiveHint: false`, `openWorldHint: false` taşır.
- **Girdi doğrulama:** kayıtlı katı girdi şemasıyla eşleşmeyen argümanlar (bilinmeyen alanlar, yanlış enum değerleri, `limit < 1`, `depth > 8`, 200'den fazla `refs`) handler çalışmadan reddedilir; çağrı bir Causoryn envelope'u yerine `isError: true` döndürür.
- **Önce yetkilendirme:** her araç her şeyden önce çalışma alanını denetler (`workspaceId` varsayılan olarak yapılandırılmış çalışma alanıdır) → `WORKSPACE_NOT_AUTHORIZED`.
- **Envelope alanları:** `envelope.snapshotId`, servis edilen **`WikiSnapshot`** kimliğidir (core araçlar oraya bir graph snapshot kimliği koyar). `envelope.coverage` yalnızca `causoryn_wiki_build` tarafından (kaynak graftan) doldurulur; okuma araçları `null` döndürür. Servis edilen wiki `partial` olduğunda `envelope.status` `partial` olur (`causoryn_wiki_diff` için taraflardan biri `partial` olduğunda).
- **Bayatlık:** bir wiki, `graphSnapshotId` değeri çalışma alanının en son yayımlanmış graph snapshot'ı değilse bayattır. Okuma araçları bu durumda `data.stale: true` (böyle bir alanı olmayan `causoryn_wiki_diff` hariç) ve yeniden build öneren bir uyarı döndürür.
- **Sayfalama:** opak base64url cursor `{ "v": 1, "o": <offset> }`; `limit` varsayılanı 50, en fazla 200 (üzerinde `LIMIT_EXCEEDED`); bozuk bir cursor `INVALID_ARGUMENT` verir; son sayfada `nextCursor` `null` olur ve sayfalamalı beş araçta `envelope.nextCursor`, `data.nextCursor`'a eşittir.
- **Snapshot seçimi:** açık bir `snapshotId`, aynı çalışma alanının yayımlanmış bir `WikiSnapshot`'ı olmalıdır (aksi halde `EVIDENCE_NOT_FOUND`); verilmezse en son yayımlanmış `WikiSnapshot` kullanılır (hiç yoksa veya wiki veri kökü yapılandırılmamışsa `INDEX_NOT_READY`).
- **İndeksleme:** status dışındaki diğer araçlar gibi wiki araçları da ilk graf indeksi için `CAUSORYN_INDEX_WAIT_MS` süresine kadar bekler. Core araçlardan farklı olarak, bir wiki aracının `INDEX_NOT_READY` sonucu hata envelope'u olarak kalır (`partial` bir "indexing" envelope'una dönüştürülmez) ve wiki yanıtları, core araçların aldığı arka plan yeniden indeksleme `stale=true` uyarısını almaz.
- **Dizgeler:** alan adları, enum değerleri ve hata kodları kararlı tanımlayıcılardır. Uyarı metinleri, `reason` / `summary` dizgeleri, hata mesajları ve üretilen Markdown etiketleri serbest metindir; serbest metni ayrıştırmayın. Bu metinlerin tamamı (wiki motoru `packages/wiki`, `services-wiki.ts`, SQLite wiki deposu `packages/storage-sqlite/src/wiki-store.ts` ve salt okunur Git çalıştırıcısı `packages/graph/src/git-read.ts` dahil) sade İngilizcedir.

### 8.2 Hata kodları

Wiki servislerinin kullandığı kodlar (`services-wiki.ts` içindeki `WIKI_TOOL_ERROR_CODES_USED`; `packages/mcp-server/src/errors.ts` içindeki 15 kodun alt kümesi):

| Kod | Ne zaman |
|---|---|
| `WORKSPACE_NOT_AUTHORIZED` | Çalışma alanı yetkili değil (ilk denetlenir) |
| `PATH_DENIED` | Yapılandırılmış bir wiki veri kökü olmadan `causoryn_wiki_build` (varsayılan ret) |
| `INDEX_NOT_READY` | Yayımlanmış graph snapshot yok (build); yayımlanmış `WikiSnapshot` yok veya wiki veri kökü yok (okumalar); aynı graph snapshot için ikinci bir build zaten çalışıyor |
| `EVIDENCE_NOT_FOUND` | Açıkça verilen `snapshotId`, bu çalışma alanının yayımlanmış bir `WikiSnapshot`'ı değil |
| `WIKI_PAGE_NOT_FOUND` | Servis edilen snapshot'ta bilinmeyen `pageId` / `parentId` (`causoryn_wiki_diff` için: her iki tarafta da yok) |
| `INVALID_REVISION` | `causoryn_wiki_get_versions` içindeki bir Git ref çözümlenemiyor; bir `causoryn_wiki_diff` tarafı çözümlenemiyor |
| `INVALID_ARGUMENT` | Build'de `scope`; reddedilen arama filtreleri; boş sorgu; bozuk cursor; geçersiz çekirdek girdisi |
| `LIMIT_EXCEEDED` | `limit` > 200 |
| `INTERNAL_ERROR` | Depolama veya tutarlılık hataları; ayrıntı istemciye değil stderr'e gider |

Çekirdek hata kodları tek bir yerde eşlenir (`wikiErrorToToolError`). Bu fonksiyon ayrıca export kodlarını da eşler (`wiki/output-not-authorized` → `EXPORT_NOT_ALLOWED` ve `wiki/output-path-denied` → `PATH_DENIED`), ancak hiçbir wiki aracı export çekirdeğini çağırmadığından bu kodlara bugün ulaşılamaz.

MCP hata kodu olarak **kayıtlı olmayan** ayrılmış wiki kodları:

- `WIKI_REVISION_NOT_AVAILABLE`: çözümlenemeyen ref'ler `INVALID_REVISION` döndürür; saklanmış bir `WikiSnapshot`'ı olmayan geçerli ref'ler `availability: "not_available"` verisi olarak raporlanır.
- `WIKI_BROKEN_LINK`: kırık bağlantılar hata değil veridir (`toPageId: null` + `brokenLinkDiagnostics`).
- `WIKI_NOTE_CONFLICT`: çakışma çekirdekte `wiki/annotation-conflict` olarak vardır, ancak hiçbir MCP aracı anotasyon yazmadığından kod kayıtlı değildir.

### 8.3 `causoryn_wiki_build`

Çalışma alanının en son yayımlanmış `GraphSnapshot`'ını bir `WikiSnapshot`'a projekte eder ve onu wiki veri köküne atomik olarak yayımlar. Çalışma alanı dosyalarına asla yazmaz.

```ts
export const WikiBuildInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  mode: z.enum(["full", "incremental"]),     // required
  scope: z.string().min(1).optional(),       // reserved: any value → INVALID_ARGUMENT
  revision: z.string().min(1).optional(),    // free-form revisionRef label; default graph revision.id
});

export const WikiBuildDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: z.enum(["ready", "partial"]),
  mode: z.enum(["full", "incremental"]),     // executed mode
  fallbackReason: z.string().optional(),     // set when incremental fell back to full
  pagesRegenerated: z.number().int().nonnegative(),
  sectionsRegenerated: z.number().int().nonnegative(),
  linksRegenerated: z.number().int().nonnegative(),  // links written for the new snapshot
  brokenLinks: z.number().int().nonnegative(),
  warnings: z.array(z.string()),             // same content as envelope.warnings
});
```

- Full modda `pagesRegenerated` / `sectionsRegenerated` / `linksRegenerated`, yazılan toplamlardır.
- İdempotent no-op: en son yayımlanmış `WikiSnapshot` mevcut graph snapshot için deterministik kimliğe zaten sahipse hiçbir şey yazılmaz ve sayaçlar `0` olur.
- Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT` (`scope`), `INDEX_NOT_READY`, `PATH_DENIED`, `INTERNAL_ERROR`.

### 8.4 `causoryn_wiki_get_tree`

Kapsam (coverage), tazelik (freshness) ve alt sayfa sayılarıyla hiyerarşik sayfa ağacı.

```ts
export const WikiGetTreeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),            // subtree root; default: all 12 roots
  depth: z.number().int().min(1).max(8).optional(),  // depth cap; roots are depth 1
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiTreeNodeSchema = z.strictObject({
  pageId: z.string(), kind: WikiPageKindSchema, parentId: z.string().nullable(),
  title: z.string(), route: z.string(),
  coverage: z.strictObject({ status: CoverageStatusSchema }),
  freshness: FreshnessSchema,
  childCount: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
});

export const WikiGetTreeDataSchema = z.strictObject({
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  nodes: z.array(WikiTreeNodeSchema),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

Sıra genişlik önceliklidir (breadth-first): kökler taksonomi sırasında, alt sayfalar `pageId`'ye göre sıralıdır; sayfalama bu sıraya uygulanır. `no_data` kategorileri dolgu olmadan listelenir. Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND` (bilinmeyen `parentId`), `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.5 `causoryn_wiki_get_page`

Üretilen bölümleri, kanıtları ve kaynak referanslarıyla tek bir sayfa.

```ts
export const WikiGetPageInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  snapshotId: z.string().min(1).optional(),
  sections: z.array(z.string().min(1)).optional(),   // sectionKey filter
  limit: z.number().int().min(1).optional(),         // sections per response
  cursor: z.string().min(1).optional(),
});

export const WikiGetPageDataSchema = z.strictObject({
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  page: z.strictObject({
    pageId: z.string(), kind: WikiPageKindSchema, parentId: z.string().nullable(),
    title: z.string(), slug: z.string(), route: z.string(), contentHash: z.string(),
    freshness: FreshnessSchema,
    coverage: z.strictObject({ status: CoverageStatusSchema, detail: z.string().optional() }),
  }),
  sourceRefs: z.array(EvidenceRefSchema),        // deduplicated over ALL sections, sorted by evidenceId
  sections: z.array(WikiPageSectionSchema),      // generated layer only, after filter + pagination
  sectionsTotal: z.number().int().nonnegative(), // sections matching the filter
  nextCursor: z.string().nullable(),
});
```

Anotasyonlar döndürülmez. Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.6 `causoryn_wiki_search`

Tek bir yayımlanmış `WikiSnapshot` üzerinde kaçışlı (escaped) FTS5 araması.

```ts
export const WikiSearchInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string(),                          // trimmed, inner whitespace collapsed; empty → INVALID_ARGUMENT
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  // Declared but not implemented: any value → INVALID_ARGUMENT
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

// data = WikiSearchResultSchema + stale
export const WikiSearchResultSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  workspaceId: z.string(),
  query: z.string(),                // normalized query
  matchExpression: z.string(),      // the escaped FTS5 phrase actually bound
  totalMatches: z.number().int().nonnegative(),
  hits: z.array(WikiSearchHitSchema),
  nextCursor: z.string().nullable(),
  skippedRankLegs: z.array(z.enum(["graphProximity"])),
});

export const WikiSearchHitSchema = z.strictObject({
  pageId: z.string(), kind: WikiPageKindSchema, title: z.string(), route: z.string(),
  freshness: FreshnessSchema,
  qualifiedSymbol: z.string().nullable(), apiRoute: z.string().nullable(), module: z.string().nullable(),
  snippet: z.string(),              // FTS5 snippet(): "[" … "]" markers, "…" ellipsis, 12 tokens
  matchedFields: z.array(z.enum(["title", "qualifiedSymbol", "apiRoute", "module", "tags", "body"])),
  evidenceIds: z.array(z.string()), // deduplicated evidence IDs from the page's sections
});
```

- **Sorgu kaçışı:** normalize edilmiş sorgunun tamamı, parametre olarak bağlanan tek bir FTS5 phrase'ine dönüşür (`"..."`, içteki tırnaklar ikilenir); böylece `AND`, `OR`, `NEAR`, `*`, `:` gibi operatörler metin olarak eşleşir. Bu nedenle çok kelimeli sorgular kelimeleri bitişik bir phrase olarak eşleştirir.
- **Sıralama** (`search-ranking.ts`), en yüksekten başlayarak: sorgunun `qualifiedSymbol` veya `apiRoute` ile büyük/küçük harf duyarsız tam eşleşmesi > sorgunun başlıkta geçmesi > sorgunun modülde geçmesi > FTS5 `bm25()` (ağırlıksız) > graf yakınlığı > eşitlik bozma önce başlığa, sonra `pageId`'ye göre (code-unit karşılaştırması, locale yok). MCP servisi hiçbir zaman yakınlık verisi sağlamaz, bu yüzden `skippedRankLegs` her zaman `["graphProximity"]` olur.
- **Alaka şeffaflığı:** `matchedFields`, altı statik, sütun filtreli FTS5 sorgusundan gelir; gizli bir vektör veya embedding skoru yoktur.
- **Token bütçesi:** isabetler (hits) yalnızca snippet ve meta veri taşır; tam bölümleri `causoryn_wiki_get_page` ile alın.
- Snapshot'ın tüm aday kümesi sayfalamadan önce sıralanır (yüzlerce sayfalık wiki'ler için uygundur).
- Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.7 `causoryn_wiki_get_links`

Bir sayfa için giden bağlantılar, türetilmiş backlink'ler ve kırık bağlantı tanılamaları.

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
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]),
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),        // from the reverse index, not stored rows
  brokenLinkDiagnostics: z.array(BrokenLinkDiagnosticSchema),
  totalMatching: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

`direction` uygulanır: yalnızca seçilen taraf(lar) döndürülür ve `totalMatching` içinde sayılır. Sayfalama önce giden, sonra gelen bağlantılar üzerinde çalışır; `brokenLinkDiagnostics`, sayfanın kendi kırık giden bağlantılarını (`linkKinds` ile filtrelenmiş, sayfalanmamış) `toRef: null` ile listeler, çünkü saklanan satırlar ham hedef adını tutmaz. Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.8 `causoryn_wiki_get_versions`

En son yayımlanmış `WikiSnapshot` için revizyon erişilebilirliği; isteğe bağlı salt okunur Git ref çözümlemesiyle.

```ts
export const WikiGetVersionsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),      // page version instead of snapshot revision
  refs: z.array(z.string().min(1)).min(1).max(200).optional(),
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

export const WikiGetVersionsDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  stale: z.boolean(),
  versions: z.array(WikiVersionEntrySchema),
  nextCursor: z.string().nullable(),
});
```

- İlk girdi her zaman en son yayımlanmış `WikiSnapshot`'tır (`available`); `pageId` verildiğinde o sayfanın `contentHash`, `linkSetHash`, `templateVersion` ve `coverage` değerlerini taşır.
- Her `refs` girdisi doğrulanır (`assertValidGitRef`) ve sağlamlaştırılmış salt okunur Git çalıştırıcısı (`execFile`, `shell: false`, alt komut izin listesi, `-c` geçersiz kılmaları; bkz. [Güvenlik Denetimi](security-pass.md)) üzerinden `git cat-file -t` ile çözümlenir. `working-tree` Git başlatmadan çözümlenir, bu yüzden `.git` içermeyen dizinlerde de çalışır. Çözümlenemeyen tek bir ref tüm çağrıyı `INVALID_REVISION` ile başarısız kılar.
- Çözümlenen bir ref yalnızca en son snapshot'ın `revisionRef` değerine (varsayılan olarak `working-tree`) eşitse `available` olur; çözümlenen diğer her ref bir gerekçeyle `not_available` olur. Daha eski saklanmış snapshot'lar listelenmez ve `snapshotId` girdisi yoktur.
- Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_REVISION`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.9 `causoryn_wiki_diff`

İki yayımlanmış `WikiSnapshot` arasındaki yapısal farklar. Yalnızca saklanmış satırları okur; working tree'ye veya Git'e asla dokunmaz.

```ts
export const WikiDiffInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  base: z.string().min(1),               // wikiSnapshotId, or revisionRef of the latest published wiki
  target: z.string().min(1),
  pageId: z.string().min(1).optional(),  // single-page scope
});

export const WikiDiffDataSchema = z.strictObject({
  base: z.string(), target: z.string(),
  baseWikiSnapshotId: z.string(), targetWikiSnapshotId: z.string(),
  addedPages: z.array(z.string()),
  removedPages: z.array(z.string()),
  changedSections: z.array(z.strictObject({ pageId: z.string(), sectionKey: z.string() })),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  contractChanges: z.array(z.strictObject({
    contractId: z.string(),
    changeKind: z.enum(["added", "removed", "modified"]),
    summary: z.string(),
  })),
  coverageDelta: z.array(z.strictObject({
    pageId: z.string(),
    previous: CoverageStatusSchema,
    current: CoverageStatusSchema,
    reason: z.string().optional(),
  })),
  unresolvedDifferences: z.array(z.strictObject({ pageId: z.string(), reason: z.string() })),
});
```

- Taraf çözümlemesi: çalışma alanının yayımlanmış bir `WikiSnapshot` kimliği veya en son yayımlanmış snapshot'ın `revisionRef` değerine eşit bir dizge. Çoğu snapshot `revisionRef: "working-tree"` değerini paylaştığından `wikiSnapshotId` değerlerini kullanın (`causoryn_wiki_build` veya `causoryn_wiki_get_tree` çıktısından).
- `pageId` kapsamı: sayfa ve bölüm sonuçları o sayfayla, bağlantı sonuçları ona dokunan bağlantılarla, `contractChanges` ise kontrat sayfa kimliği ona eşit olan kayıtlarla sınırlanır. Bir `removed` kaydı taban kimliğini, bir `modified` kaydı hedef kimliğini taşır; bu yüzden yalnızca tabanda bulunan bir sayfaya daraltılmış kapsam `modified` kaydını göstermeyebilir.
- Sayfalanmaz. `envelope.snapshotId` hedef kimliktir; taraflardan biri `partial` ise `envelope.status` `partial` olur.
- Hesaplama ayrıntıları: [§6.4](#64-diff-hesaplamaları).
- Hatalar: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY` (wiki veri kökü yok), `INVALID_REVISION`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INTERNAL_ERROR`.

### 8.10 MCP resources

Tasarım, `causoryn://wiki/{workspaceId}/{pageId}?snapshot={wikiSnapshotId}` resource URI şablonunu ayırır. Bu uygulanmamıştır: sunucu yalnızca `tools` yeteneğini (capability) duyurur. MCP Apps veya başka etkileşimli UI yüzeyleri sağlanmaz.

## 9. Yazma izinleri ve güvenlik sınırları

### 9.1 Veri kökü kuralı

- `causoryn_wiki_build` yalnızca `SqliteWikiStore` üzerinden yapılandırılmış veri köküne yazar; çalışma alanı dosyalarını yazan bir kod yolu yoktur.
- `validateDataDbPath` (`context.ts`), açık bir `wiki.dataDbPath` değerini başlangıçta fail-closed biçimde denetler: mutlak yol; null byte yok; en az bir yetkilendirilmiş kök; her kökün sözcüksel (lexical) olarak dışında; üst dizin mevcut; veritabanı dosyası ve onun `-wal`, `-shm`, `-journal` yan dosyaları dizin olmamalıdır, sarkan (dangling) symlink'ler reddedilir ve üst dizinin ve mevcut her yapıtın (artifact) gerçek yolları her kökün gerçek yolunun dışında olmalıdır (symlink ve junction kaçışları reddedilir). İhlaller sunucuyu bir konfigürasyon hatasıyla durdurur.
- `--auto-data-dir` altında bunun yerine `buildWorkspaceAutoConfig`'in dizin denetimleri uygulanır ([§2.2](#22-veri-kökü)).
- Konfigürasyonda model sağlayıcı veya API anahtarı ayarı yoktur (LLM'siz politika).

### 9.2 Salt okunur Git

`causoryn_wiki_get_versions` yalnızca `packages/graph/src/git-read.ts` içindeki paylaşılan salt okunur çalıştırıcı üzerinden `git cat-file -t <ref>` çalıştırır; `causoryn_wiki_diff` hiç Git çalıştırmaz. İkisi de `checkout`, `reset` veya `clean` çalıştırmaz. Çalıştırıcının ortam sağlamlaştırması (etkili olması için Git 2.45 veya daha yenisini gerektiren `GIT_NO_LAZY_FETCH=1` dahil) [Güvenlik Denetimi](security-pass.md) sayfasında anlatılır.

### 9.3 Çevrimdışı wiki export'u (yalnızca kütüphane)

`exportWikiOffline` (`packages/wiki/src/export.ts`) kendi kendine yeten bir wiki yazar (`index.html`, `markdown/index.md`, sayfa başına bir `.md`) ve veri kökünden ayrıdır:

- Hedef dizinler `OutputAccessPolicy` (`output.allowedOutputDirs`) ile yetkilendirilir; reddedilen bir hedefe hiçbir dosya ve alt dizin yazılmaz.
- Her dosya atomik olarak yazılır (`.tmp` + rename; bayat `.tmp` önce kaldırılır). Dosya kümesi bir bütün olarak transaction'lı değildir: sonraki bir dosya başarısız olursa önceki dosyalar yerinde kalır.
- HTML: her dinamik değer escape edilir; CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`; script, harici kaynak, CDN veya telemetri yoktur; gezinme yalnızca aynı doküman içindeki anchor'larla yapılır; kaynak yollar metin olarak gösterilir, `file://` bağlantısı yoktur; gövde metnindeki ham `http(s)://` dizgeleri etkisizleştirilir (defang).
- Markdown: tablo hücreleri ve başlıklar escape edilir; bölüm gövdelerindeki satır içi HTML ve görsel gömmeleri etkisizleştirilir.
- Dosya adları: çakışmalarda ve Windows'un ayrılmış aygıt adları (`con`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, …) için deterministik kimlik sonekleri taşıyan, temizlenmiş slug'lar; kalan çakışmalar reddedilir, asla üzerine yazılmaz.
- Anotasyonlar dışa aktarılmaz.

Bugün hiçbir MCP aracı veya CLI komutu bu fonksiyonu çağırmaz.

### 9.4 Yazma izni matrisi

| Araç / akış | Yazar mı | Hedef |
|---|---|---|
| `causoryn_wiki_build` | evet (`readOnlyHint: false`) | Yalnızca wiki SQLite veri kökü |
| `causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links` | hayır (`readOnlyHint: true`) | — |
| `causoryn_wiki_get_versions` | hayır (`readOnlyHint: true`) | — (salt okunur Git; `working-tree` Git'siz çözülür) |
| `causoryn_wiki_diff` | hayır (`readOnlyHint: true`) | — (yalnızca saklanmış snapshot'lar) |
| `action: "refresh"` ile `causoryn_status` (`full` profilinde legacy `causoryn_refresh_index`) | evet | Yalnızca graf indeksi; wiki'yi yeniden oluşturmaz |
| `causoryn_export_documentation` | evet | Yalnızca `output.allowedOutputDirs`; `view: "wiki"` → `INVALID_ARGUMENT` |
| Anotasyon oluşturma / güncelleme / silme | — | MCP aracı veya CLI komutu yok; yalnızca çekirdek `AnnotationOverlayEngine` |

Yedi wiki aracından yalnızca `causoryn_wiki_build` yazar ve yalnızca harici SQLite veri köküne yazar.

## 10. Testler ve kabul kriterleri

| Alan | Kabul kriteri | Kapsayan testler |
|---|---|---|
| Hiyerarşi | TypeScript orders fixture'ı (`examples/fixture-ts-orders`) taksonomi sırasında 12 kök, modüller / endpoint'ler için alt sayfalar ve açık `no_data` / `partial` durumları üretir | `packages/wiki/test/wiki-projection.test.ts`, `packages/mcp-server/test/wiki-tools.test.ts` |
| Çift yönlü bağlantılar | Her giden bağlantı aynı snapshot'ta hedefin backlink sorgusuyla bulunur; `verified` bağlantılar kanıt taşır | `packages/wiki/test/wiki-links.test.ts`, `wiki-tools.test.ts` |
| Arama sıralaması | Tam sembol veya rota eşleşmesi (örneğin `CreateOrder`, `post /orders`) genel gövde eşleşmelerinin üstünde sıralanır; `matchedFields` ve `evidenceIds` döndürülür | `packages/wiki/test/wiki-search.test.ts`, `wiki-tools.test.ts` |
| Sürümleme | İki Git commit'inden oluşturulmuş wiki'ler arasındaki diff; eklenen sayfaları, bağlantıları, değişen bölümleri ve kapsam farklarını raporlar ve working tree'ye dokunmaz | `wiki-tools.test.ts` |
| Artımlı build | Tek bir servisi değiştirmek yalnızca etkilenen sayfaları yeniden üretir; bağımsız sayfalar `contentHash` değerlerini korur; geri dönüşler `fallbackReason` raporlar | `packages/wiki/test/wiki-incremental.test.ts`, `packages/mcp-server/test/wiki-build-incremental.test.ts` |
| Anotasyonlar | Art arda iki yeniden oluşturma anotasyon satırlarını bayt bayt bozulmadan bırakır; kaldırılan sayfalar notları veri kaybı olmadan `orphan` olarak işaretler; bayat sürümler `wiki/annotation-conflict` fırlatır | `packages/wiki/test/wiki-overlay.test.ts`, `packages/storage-sqlite/test/wiki-annotation-overlay.test.ts` |
| Belirsizlik | Çözümlenmemiş edge'ler `partial` bölümler üretir ve asla `verified` bağlantı olarak gösterilmez | `wiki-projection.test.ts`, `wiki-links.test.ts` |
| Kontrat değişiklikleri | `added` / `removed` / `modified` kayıtları ve eksik graf geri dönüşü | `packages/wiki/test/contract-changes.test.ts`, `wiki-tools.test.ts` |
| Depolama | Atomik yayım, hatada `failed`, asılı kalan `building` kilidi yok, FK ve `CHECK` kısıtları | `packages/storage-sqlite/test/wiki-store.test.ts`, `wiki-tools.test.ts` |
| Güvenlik | Çalışma alanının içindeki veya bir symlink/junction arkasındaki veri kökü sunucuyu durdurur; export HTML'i escape edilir, CSP ile kısıtlanır ve ağ isteği yapmaz | `wiki-tools.test.ts`, `packages/wiki/test/wiki-export.test.ts` |

Her wiki aracının `wiki-tools.test.ts` içinde pozitif, negatif ve kısmi sonuç durumları vardır. Güncel geçti/kaldı kanıtları için bkz. [Uygulama Durumu](implementation-status.md).

## 11. Limitler ve dürüst eksikler

**Limitler**

| Limit | Değer |
|---|---|
| `limit` (ağaç, sayfa bölümleri, arama, bağlantılar, sürümler) | varsayılan 50, en fazla 200 |
| `depth` (`causoryn_wiki_get_tree`) | 1–8 |
| `refs` (`causoryn_wiki_get_versions`) | 1–200 |
| Arama snippet'i | 12 token |
| Şablon sürümü | `1.1.0` |
| Eşzamanlı build'ler | çalışma alanı ve graph snapshot başına bir `building` satırı |

**Eksikler (uygulanmamış veya kısmi)**

1. `kinds`, `scope`, `language`, `revision`, `resolution` arama filtreleri tanımlıdır ve `INVALID_ARGUMENT` ile reddedilir; sonuçları istemci tarafında filtreleyin. Graf yakınlığı sıralama ayağı hiç beslenmez.
2. Yalnızca `PARENT_OF`, `DEPENDS_ON` ve `CALLS` bağlantıları üretilir; `DOCUMENTS`, `IMPLEMENTS`, `PRODUCES`, `CONSUMES`, `TESTED_BY`, `FLOWS_TO`, `RELATED_CONTRACT`, `CHANGED_IN` yalnızca şemada vardır. `tags` arama sütunu her zaman boştur.
3. `component`, `symbol`, `policy` sayfa türleri hiç üretilmez; Business Flows, Architecture Timeline ve Onboarding her zaman `no_data`'dır; Tests & Quality altındaki `coverage-gaps` bölümü her zaman `no_data`'dır.
4. Yeniden indekslemeden sonra otomatik wiki yeniden oluşturma yoktur (`wiki.autoBuildOnSnapshot` mevcut değildir); `causoryn_wiki_build`'i açıkça çağırın.
5. Artımlı build'ler her `WikiSnapshot` için tam satır kümesini yeniden yazar.
6. Wiki snapshot'ları için saklama (retention) yoktur: idempotent olmayan her build veritabanına tam bir satır kümesi ekler. Graph snapshot saklama politikası yalnızca en yeni iki yayımlanmış graph snapshot'ı tutar; bu yüzden sonraki yeniden indekslemelerden sonra artımlı bir build full build'e geri döner (önceki graf artık yoktur) ve daha eski wiki çiftleri için `contractChanges` bir uyarıyla `[]` olur.
7. `causoryn_wiki_get_versions` yalnızca en son yayımlanmış `WikiSnapshot`'ı raporlar; `causoryn_wiki_diff` bir `revisionRef` değerini yalnızca en son snapshot için çözümler; `revisionRef` varsayılan olarak `working-tree`'dir ve bir Git commit'ine bağlı değildir.
8. Anotasyonlar için MCP veya CLI yüzeyi yoktur; `WIKI_NOTE_CONFLICT` bir MCP hata kodu değildir; anotasyonlar aranamaz ve dışa aktarılamaz (`includeManualNotesInSearch` / `includeManualNotesInExport` seçenekleri mevcut değildir).
9. Çevrimdışı wiki export'u yalnızca kütüphane düzeyindedir; `causoryn_export_documentation(view="wiki")` `INVALID_ARGUMENT` döndürür.
10. Alias'lar (`wiki_aliases`) build tarafından yazılmaz veya kullanılmaz; yeniden adlandırma tespiti etkin değildir.
11. Wiki sayfaları için MCP resources yayımlanmaz.
12. Uyarı, `reason` ve `summary` metinleri, hata mesajları ve üretilen Markdown etiketleri İngilizce serbest metindir; istemciler mesaj ifadelerine değil kodlara ve enum değerlerine dayanmalıdır.
13. Planlanan konfigürasyon anahtarları (`enabled`, `autoBuildOnSnapshot`, `includeManualNotesInSearch`, `includeManualNotesInExport`, `historicalSnapshotRetention`, `offlineExportDefault`) ve planlanan metrikler (`wiki_projection_duration`, `wiki_fts_update_duration`, `wiki_stale_queries`, `wiki_orphaned_notes`, …) mevcut değildir; katı konfigürasyon şeması bu anahtarları reddeder. `pagesRegenerated` ve `brokenLinks`, `causoryn_wiki_build` yanıtlarında raporlanır.

## 12. Diğer ilgili dokümanlar

- [Dokümantasyon Merkezi](README.md) · [5 Dakikalık Hızlı Başlangıç](en/tutorial-5-minutes.md) (İngilizce)
- [MCP Araç Sözleşmeleri](tool-contracts.md) — araç profilleri, envelope, hata kodları, yazma izni özeti
- [CLI ve Konfigürasyon](cli-and-configuration.md) — `--tool-profile`, `CAUSORYN_TOOL_PROFILE`, `--auto-data-dir`, `wiki.dataDbPath`, veri dizini yerleşimi
- [Mimari Özeti](architecture.md) — paket haritası ve depolama yerleşimi
- [Güvenlik Denetimi](security-pass.md) — salt okunur Git sağlamlaştırması ve export güvenliği
- [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md) — `causoryn_export_documentation`
- [Uygulama Durumu](implementation-status.md) · [English Specification](en/wiki-spec.md)
