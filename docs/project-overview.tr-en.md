# Causoryn — Proje Dokümanı / Project Document (TR · EN)

> **Dil / Language:** **Türkçe** (ilk yarı / first half) | [English](#english) (ikinci yarı / second half) · [Dokümantasyon Merkezi](README.md) · [Documentation Hub](en/README.md)
>
> Bu dosyanın `docs/en/` altında ayrı bir karşılığı yoktur; iki dil aynı dosyada simetrik içerikle tutulur. / This file has no separate `docs/en/` counterpart; both languages live in this one file with symmetric content.

---

# Causoryn — Kapsamlı Proje Dokümanı (0.3.0, Pre-1.0)

> **Durum:** Causoryn 0.3.2'i yansıtır (Pre-1.0; `1.0.0` ilan edilmedi; varsayılan `core` araç profili, workspace başına tek paylaşılan `graph.sqlite`, `worker_threads` ile bloklamasız indeksleme). Ayrıntıda [İngilizce referans dokümanları](en/README.md) ve kaynak kod belirleyicidir; bu sayfa ile kaynak çelişirse kaynak kazanır.
>
> **Sürüm çizgisi:** `K-022` açık kaynak yayını (`0.2.0`) → `0.2.1` çalışma zamanı iyileştirmeleri → `K-023` görsel mimari dışa aktarımı (`0.2.2`) → `K-024` evrensel JS/CJS + hapsedilmiş `tsconfig`/`jsconfig` + bloklamasız envanter (`0.2.3`) → `K-025` CI/CD tedarik zinciri sertleştirmesi ve `K-026` doğal dil skill + iki dilli dokümantasyon (`0.2.4`) → **`0.3.0`** araç profilleri, paylaşılan indeks ve `worker_threads` indeksleme. Tarihler ve önceki koşum kayıtları: [değişiklik günlüğü](../CHANGELOG.md) · [uygulama durumu](implementation-status.md).

## 1. Yönetici Özeti

Causoryn, repository kodunu **Unified Evidence & Knowledge Graph**'a dönüştüren, **model bağımsız ve LLM çalıştırmayan** yerel stdio MCP motorudur. Motor ve paketlenen runtime LLM, embedding ve model API'si kullanmaz. İsteğe bağlı `architecture-blueprint` akışında host modeli anlatı hazırlayabilir ve bunu `causoryn_export_documentation` aracına `annotations` olarak iletebilir. Causoryn bu veriyi şema, boyut bütçeleri ve snapshot/projeksiyon referanslarına göre doğrular (tek çağrıda en fazla 25 hata), ardından sabit dışa aktarım kurallarıyla işler. [LLM kullanmama kararı](adr/ADR-002-no-llm.md) · [Architecture Blueprint skill](../skills/architecture-blueprint/SKILL.md)

`SERVER_VERSION = "0.3.2"` ve `SCHEMA_VERSION = "2.0"`. Varsayılan **`core` profili 11 MCP aracı** yayımlar; `wiki` (+7), `history` (+2) ve `full` (29 legacy ad + 3 birleştirilmiş ad = **32 araç**) profilleri isteğe bağlıdır. Beş dil adapter'ından TypeScript/JavaScript süreç içinde, C# / Python / Go / Rust ortak `@causoryn/sidecar-ipc` üzerinden sidecar olarak çalışır. İndeksleme `worker_threads` içinde yürür ve tüm host'lar workspace başına tek bir `graph.sqlite` paylaşır. Depoda Vitest'in varsayılan kapsamına giren 120 izlenen test dosyası ve ayrı çalıştırılan 1 benchmark test dosyası (toplam 121 Vitest dosyası) bulunur. Açık 1.0.0 kapıları ve koşum kanıtı §8–§10'dadır. [Araç kataloğu](../packages/mcp-server/src/version.ts) · [Adapter kataloğu](../packages/indexing/src/index.ts) · [Test kapsamı](../vitest.config.ts)

## 2. Çözülen Problem: AI Ajanlarının Kör Kodlaması

Kodlama ajanı bir sembolü, çağrı zincirini veya değişikliğin etkisini incelemek için graph ve evidence kayıtlarını sorgulayabilir. `verified` kenarlar en az bir evidence kaydına bağlıdır. Kaynak span'ı olan kayıt `relativePath`, satır aralığı ve `sourceHash` taşır. Her ilişki `verified`, `heuristic` veya `unresolved` etiketi taşır. Örneğin Python adapter'ı import üzerinden tahmin ettiği çağrıyı `heuristic`, çözemediği çağrıyı `UnknownExternal` hedefli `unresolved` olarak gösterir. Her envelope dil başına kapsamı `coverage.byLanguage` alanında raporlar; böylece güçlü TypeScript kapsamı başka bir dildeki L0 düşüşünü gizleyemez. [Graph şeması](../packages/domain/src/graph-schema.ts) · [Python protokolü](../native/python-worker/PROTOCOL.md)

## 3. Ürün Döngüsü

Döngü **Discover → Preflight → Agent Edits → Verify → Explain**'dir:

| Adım | Causoryn'in rolü | Temsilci araçlar (`core`; ek profiller belirtilmiştir) | Yazar mı? |
|---|---|---|---|
| Discover | Kanıtlı mimari/sembol bağlamı ve görev odaklı bağlam paketi | `causoryn_status`, `causoryn_map_system` (`profile: "onboarding"` dahil), `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace` (`mode: "execution" \| "business-flow"`), `causoryn_get_agent_context` | Hayır; yalnız `causoryn_status` `action: "refresh"` Causoryn'in kendi indeksine yazar |
| Preflight | Aday manifest, etki adayları, test planı ve kontrat denetimi | `causoryn_preflight_change` (`candidateOnly: true`; `include: ["impact", "test-plan"]`), `causoryn_contracts` (`action: "check" \| "drift"`) | Hayır |
| Agent Edits | Düzenleme host modelde yapılır; Causoryn katılmaz | — | Hayır |
| Verify | Çalışma ağacını `architecture`, `graph-diff`, `test-plan` (ve istenirse `contracts`) denetimleriyle doğrular; test ÇALIŞTIRMAZ | `causoryn_verify_change` | Hayır; çalışma ağacı geçici bellek-içi depoya indekslenir |
| Explain | Kanıt zinciri ve mimari dışa aktarım; isteğe bağlı Living Wiki ve mimari geçmişi | `causoryn_get_evidence`, `causoryn_export_documentation`; `wiki` profili: 7 `causoryn_wiki_*` aracı; `history` profili: `causoryn_compare_architecture`, `causoryn_architecture_timeline` | `causoryn_export_documentation` yalnız `output.allowedOutputDirs` dizinine, `causoryn_wiki_build` yalnız `wiki.dataDbPath` deposuna |

Dürüstlük sınırı açıktır: test planı `TESTS` kenarlarından ve çağrı noktalarından aday üretir ama test koşturmaz; host'un bildirdiği test sonuçları yalnız `state: "host_asserted"` (`engineVerified: false`) olarak kaydedilir ve `no_findings` bir doğruluk garantisi değildir (raporlar `disclaimers` taşır). Kalıcı hafıza **Living Wiki**'dir: graph'tan türetilen, `wiki` profilinde 7 araçla sunulan kesişen bilgi katmanıdır.

## 4. Mimari

### 4.1 Pipeline

Yerel analiz yolu **Workspace Gateway (UNC/aygıt yolu ön denetimi + `allowRoots` + kök güvenliği) → File Inventory (`collectInventoryAsync`) → Language/Framework Adapters → Normalization ve Symbol / Hierarchy (CHA) / Contract Resolution → Unified Evidence Graph → Immutable Snapshot (akışlı SHA-256 kimliği) → paylaşılan `graph.sqlite`'ta yayın (`build_leases` ile tek yazıcı) → Domain Queries & Verification → MCP structuredContent (11 araçlık `core` profil)** sırasını izler. Host modeli MCP istemcisi tarafında çalışır. Kod odaklı pipeline bloğu `docs/architecture.md:13-22` (Türkçe) ve `docs/en/architecture.md:13-22` (İngilizce) aralığındadır. [Mimari](architecture.md)

### 4.2 Paketler ve bağımlılık sınırları

Monorepo **18 npm workspace paketi** (`12 packages/*` + `5 adapters/*` + `1 integrations/zcode/causoryn`; kök dahil 19 `package.json`), kök `tsconfig.json` içinde 14 doğrudan proje referansı, standalone `apps/visualizer`, 4 `native/*` sidecar (`native/roslyn-worker` deterministik Release derlemeli `net10.0` worker, `native/python-worker`, `native/go-worker`, `native/rust-worker`), kök 4-host açık kaynak pazaryeri manifestleri + `npx causoryn setup` / `causoryn doctor` CLI dağıtımı (`THIRD-PARTY-NOTICES.md` + `licenses/` dahil), 5 SHA-sabitli GitHub Actions iş akışı (`.github/workflows/ci.yml`, `security.yml`, `codeql.yml`, `scorecard.yml`, `release.yml`) + `.github/dependabot.yml`, `integrations/antigravity/causoryn` eklenti dizini ve 8 `examples/*` fixture'dan oluşur:

| Paket (`packages/*`) | Sorumluluk |
|---|---|
| `domain` | Graph/Evidence sözleşmeleri, Zod şemaları, canonical JSON, deterministik SHA-256 kimlikleri, akışlı snapshot karması (`computeStreamingSnapshotId`); 27 node türü ve 20 edge türü |
| `sidecar-ipc` | Ortak sidecar IPC çekirdeği: NDJSON framing, timeout, stdout/stderr bütçesi (varsayılan 64 MiB), her spawn'da `shell: false` + `windowsHide: true`, boş/NUL içeren `cwd` reddi, allowlist env, dinamik varlık kökü |
| `workspace` | Gateway: leksik UNC/aygıt yolu reddi, trusted roots, envanter, RegExp'siz polinom-zamanlı ignore eşleştirici, symlink escape reddi, `OutputAccessPolicy` |
| `indexing` | 5 dilli orkestrasyon (`INDEXED_ADAPTERS`), `collectInventoryAsync`, `worker_threads` ve süreç-içi geri dönüşlü `IndexJobManager`, `file_facts` erken kesmeli artımlı planlayıcı, build lease ve yetim build kurtarma, `symbol_fts` besleme |
| `graph` | Snapshot sorguları, traversal/impact/guard/compare, mimari projeksiyon ve dışa aktarım (`snapshot` dahil), agent context yerelleştirme, salt-okunur `git-read.ts` |
| `storage-sqlite` | SQLite WAL + FTS5 (`SqliteGraphRepository` + `SqliteWikiStore`); şema `user_version = 5` (`build_leases`, `file_facts`, `symbol_fts`) |
| `contracts` | Salt-okunur sözleşme keşfi ve drift sınıflandırması (OpenAPI, AsyncAPI, SQL DDL, JSON Schema, Protobuf) |
| `preflight` | Candidate-only manifest + test planı türetimi; kod yazmaz |
| `verification` | `verify_change` saf çekirdeği (4 denetim, `host_asserted` test durumu) |
| `wiki` | GraphSnapshot→WikiSnapshot projeksiyonu, FTS5 arama |
| `mcp-server` | stdio + sıfır-ayar `--allow-cwd` / MCP `roots/list` / `--auto-data-dir` (hassas/sistem dizin reddi) + `storage.dataDbPath` veya varsayılan `InMemoryGraphRepository` + araç profilleri (11 core / 32 full) + `outputSchema` profili + `notifications/progress` + MCP `annotations` (`readOnlyHint`) |
| `causoryn` | Açık kaynak çoklu-host CLI (`causoryn setup\|doctor\|mcp`) ve 4-host plugin dağıtım paketi (`0.3.0`, `MIT`, `THIRD-PARTY-NOTICES.md`, sıfır dış npm bağımlılığı, 5 skill) |

`typescript` 5.9.3 derleyicisi ve `esbuild` (`^0.28.2`) bundle üreticisi kök manifestte tanımlıdır. [Kök manifest](../package.json) · [Mimari](architecture.md)

Üç sınır 0.3.0 ağacında `grep` ile yeniden doğrulandı: (1) `domain` **yaprak pakettir** — kendi modülleri dışındaki tek import'u `zod`'dur; (2) `workspace` yalnızca `node:fs`, `node:path` ve `zod` kullanır; (3) parser detayı `mcp-server`'a sızmaz — hiçbir `@causoryn/adapter-*` paketi import edilmez, adapter'lara yalnız `@causoryn/indexing` üzerinden erişilir. `verification` saf fonksiyon disiplinindedir: `packages/verification/src` altında `node:fs`, `Date.` veya `Math.random` geçmez; test koşucusu çalıştırmaz, `observed` sayıları yalnızca kanıtla kabul edilir.

### 4.3 Evidence modeli ve deterministik kimlik

`Evidence = {id, kind, span?, analyzerId, analyzerVersion, rationale}`; `SourceSpan = {relativePath, startLine≥1, endLine≥startLine, sourceHash}`. Envanter dışı hedefler `indexing/internal` ile reddedilir. `verified` kenar ≥1 evidence invariant'ı **üç katmanda** zorlanır: kurucu `domain/verified-edge-requires-evidence` hatası, Zod `superRefine` şema reddi ve depo doğrulaması; `heuristic`/`unresolved` kenarlar bilinçli olarak kanıtsız kalabilir. Snapshot invariant'ları (dangling edge, duplicate ID, bilinmeyen evidence) kurucu, şema ve depoda denetlenir; depo girişinde her node/edge/evidence kimliği yeniden hesaplanır ve uyuşmazlık `graph/*-id-mismatch` ile reddedilir (`packages/graph/src/validation.ts:23-27`).

Kimlikler canonical JSON + SHA-256'dır: node `(workspaceId, kind, qualifiedName, relativePath|null)`, edge `(workspaceId, kind, from, to)`, evidence `[workspaceId, kind, analyzerId, analyzerVersion, rationale, span|null]` (`packages/domain/src/ids.ts:147-161`). Snapshot kimliği `snapshot:` + `SHA-256(canonical JSON([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))`'tir; **saat kimliğe girmez**, tasarım notu `packages/domain/src/snapshot.ts:22-35`'tedir. 0.3.0'da `computeStreamingSnapshotId` (`snapshot.ts:441-468`) aynı kanonik baytları tek bir büyük string kurmadan akışla karma'lar; kimlikler değişmedi (eski satır atfı için §10.4). Duvar saati `meta.createdAt` alanında taşınır. Nüans: aynı `IndexService` sürecinde ardışık yeniden indeksleme çağrıları `revision.sequence` (`this.runCount + 1`) artışıyla yeni `snapshotId` üretir; bağımsız taze süreçlerde aynı içerik ve aynı `sequence` birebir aynı `snapshotId` üretir. Sonuç `deepFreeze` ile dondurulmuş immutable snapshot'tır; diziler ID'ye göre kanonik sırada tutulur. Erken kesmeli artımlı bir build, aynı girdilerin temiz tam build'iyle aynı snapshot kimliğini üretmek zorundadır (`tests/incremental-early-cutoff.test.ts`).

Deterministik yeniden üretim, aynı kaynak içeriğini ve revision kimliğini/sırasını, eşdeğer workspace kimliğini, etkin envanter kurallarını, analizör araç zincirini ve yapılandırmayı gerektirir; şema sürümlü `analyzerFingerprint` (`ANALYZER_FINGERPRINT_SCHEMA_VERSION`, 0.3.0'da `fp3`) adapter sürümlerini, worker durumunu ve seçenek karmalarını içerdiğinden eksik bir toolchain'in kurulması yeni bir snapshot üretir. `fp3` (0.3.0) önceki derlemelerden kalan kalıcı snapshot'ları ve `file_facts` kayıtlarını geçersiz kılar, çünkü 0.3.0'da node span'leri ve kanıt metinleri değişti. `meta.createdAt`, çağrıya ait `requestId`, iş ilerleyişi ve worker erişilebilirliği çalışma durumuna göre değişebilir. `meta.createdAt` snapshot kimliğine girmese de bazı dışa aktarım formatlarına yazılır. [Snapshot kimliği](../packages/domain/src/snapshot.ts) · [Mimari dışa aktarım](../packages/graph/src/architecture-export.ts) · [MCP çağrısı](../packages/mcp-server/src/server.ts)

### 4.4 Depolama, indeksleme ve yayın disiplini

SQLite (`better-sqlite3` 13.2.0, SQLite 3.54.1): `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`; `symbol_fts` + `wiki_fts` FTS5 araması embedding'sizdir; şema `user_version = 5`, v1–v4 veritabanları tek transaction'da v5'e yükseltilir (daha yeni şemalı bir dosyaya asla yazılmaz; onun yerine `graph.schema-<N>.sqlite` kullanılır); DDL statik literal, veri parametrelidir. `--auto-data-dir` / `--data-dir` ile workspace başına tek dosya `<base>/workspaces/<slug>-<hash12>/graph.sqlite` (+ `exports/`) kullanılır; taban dizin her host için `--data-dir` > `~/.causoryn` sırasıyla seçilir (`ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` kullanılamadığında yedek), `0700` izinle ve yetkili köklerin kesinlikle dışında oluşturulur. `storage.dataDbPath` beyan edilmezse süreç-içi `InMemoryGraphRepository` kullanılır. `--client` yalnız tanılama etiketidir (`build_leases.host_label`); 0.2.x'teki host başına `graph-<client>.sqlite` dosyalarının en yeni geçerli olanı eksik bir `graph.sqlite`'a bir kez kopyalanır; eski dosyalar yerinde kalır ve `causoryn doctor` bunları listeler.

**Bloklamasız indeksleme:** stdio girişi ilk indeksi erteler; `initialize` ve `tools/list` hemen yanıtlanır. SQLite deposunda `IndexJobManager` işi `worker_threads` içinde (`index-worker-core.ts`, bundle'da `dist/index-worker.mjs`) çalıştırır; bellek-içi depoda veya worker girişi kullanılamadığında aynı pipeline süreç içinde asenkron çalışır. `_meta.progressToken` gönderen istemciler `notifications/progress` alır. `causoryn_status` dışındaki araçlar ilk indeks için `CAUSORYN_INDEX_WAIT_MS` kadar (varsayılan 15000 ms; `0` = bekleme yok) bekler, ardından `status: "partial"` ve `{ status: "indexing", jobId, progress, retryAfterMs }` döner. Yeniden indeksleme sürerken yanıtlar son yayımlanmış snapshot'ı `stale=true` uyarısıyla sunar.

**Artımlı indeksleme:** `causoryn_status` `action: "refresh"` (`mode: "incremental" | "full"`) bir iş kuyruğa alır. Artımlı koşum `file_facts` tablosundaki dosya başına olguları (içerik karması, public-interface karması, import edilen yollar, serileştirilmiş node/edge/evidence) okur; yalnız değişen dosyalar ve public arayüzü değiştiyse doğrudan ters bağımlıları yeniden analiz edilir (erken kesme); TypeScript önceki `ts.Program`'ı (`oldProgram`) yeniden kullanır. Yapılandırma, analizör parmak izi veya dil kümesi değişikliği, soğuk önbellek ya da tutarsız olgular tam build'e düşer.

**Atomik yayın:** build, hiçbir okuma yolunun göremediği `building` satırıyla başlar ve tek SQLite transaction'ında `ready|partial` olur; `failed` build akışa girmez; yayımsız okuma `storage/corrupt-row` reddidir. Yayın, workspace'in `build_leases` satırını gerektirir (`lease_id`, `owner_pid`, `host_label`, `hostname`, `owner_instance`, `heartbeat_at`, `expires_at`; varsayılan TTL 120 sn, heartbeat 10 sn; aynı host'ta PID canlılığı birincil), böylece iki süreç aynı anda yayımlayamaz; `recoverOrphanBuilds` canlı lease'e ait olmayan `building` satırlarını kurtarılmış yetim olarak işaretler. Yayından sonra `pruneOldSnapshots` en yeni 2 yayımlanmış snapshot'ı tutar ve yetim `symbol_fts` satırlarını siler. Sıcak açılış tüm graph'ı yüklemek yerine `getLatestSnapshotMeta` okur; yayımlanmış snapshot önbelleği `PRAGMA data_version` korumalıdır ve `MAX_PUBLISHED_CACHE_ENTRIES = 1` ile sınırlıdır (`0.2.2`'de `K-023` dört girişle başlamıştı).

Önceki sürümlerden süren davranışlar: `0.2.1` ile ilk indeks MCP `initialized` bildiriminden sonra arka planda başlar, sıfır ayarlı yapılandırma güvenli kök `.gitignore` desenlerini `extraIgnore` ile birleştirir, ortak pathless dış düğümler birleştirilir. `0.2.3` (`K-024`) mevcut `ts-adapter` içine evrensel JavaScript/CommonJS (`.js`/`.jsx`/`.mjs`/`.cjs`), kök-içi hapsedilmiş `tsconfig.json`/`jsconfig.json` yüklemesi, polinom-zamanlı sıfır-RegExp glob eşleştirme + `.git/info/exclude`/iç-içe `.gitignore` + akıllı `bin/` ayrımı, her 64 girdide olay döngüsüne dönen `collectInventoryAsync` taraması ve varsayılan `causoryn-architecture-interactive.html` çıktı adını ekledi. [Başlangıç akışı](../packages/mcp-server/src/cli-stdio.ts) · [Workspace yapılandırması](../packages/mcp-server/src/runtime-cli.ts) · [İş yöneticisi](../packages/indexing/src/job-manager.ts) · [IndexService](../packages/indexing/src/index-service.ts) · [SQLite deposu](../packages/storage-sqlite/src/sqlite-repository.ts)

## 5. MCP Araç Yüzeyi ve Profiller

`tools/list` yalnız etkin profilin araçlarını yayımlar (`packages/mcp-server/src/version.ts`, profil çözümü `server.ts` `resolveProfileToolNames`); boş handler yayımlanmaz:

| Profil | Araç | İçerik |
|---|---|---|
| `core` (varsayılan) | 11 | `causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation` |
| `wiki` | 18 | core + 7 `causoryn_wiki_*` (`wiki_build` tek yazan wiki aracıdır; `wiki_search` FTS5, embedding yok) |
| `history` | 13 | core + `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `wiki,history` | 20 | Profiller virgülle birleşir |
| `full` | 32 | 29 legacy `TOOL_NAMES` + `causoryn_status`, `causoryn_trace`, `causoryn_contracts`; yerine geçilmiş legacy araçlar açıklamada `(Deprecated: use <replacement>)` ve envelope'ta kullanımdan kaldırma uyarısı taşır |

Seçim sırası `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`'dur; bilinmeyen profil adı sunucuyu başlangıçta durdurur. `causoryn setup` her host'u `core` ile kaydeder (`setup --tool-profile <list>` başka bir profil yazar). `tools/list` varsayılan olarak `outputSchema` içermez (`--output-schema omit|full`, ortam `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE`); sunucu yine de her envelope'u aracın Zod çıktı şemasıyla doğrular. Core `tools/list` yükü ≤ 15.000 karakterdir (`tests/mcp-tool-surface-budget.test.ts`).

**Legacy eşleme** (`DEPRECATED_TOOL_REPLACEMENTS`): `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index` → `causoryn_status` (`action: "inspect" | "refresh"`); `generate_onboarding` → `causoryn_map_system` (`profile: "onboarding"`); `trace_execution`, `trace_business_flow` → `causoryn_trace`; `analyze_impact`, `derive_test_plan` → `causoryn_preflight_change` (`include`); `check_architecture` → `causoryn_verify_change` (`checks: ["architecture"]`); `check_contracts`, `detect_contract_drift` → `causoryn_contracts` (`action: "check" | "drift"`). Legacy adlar yalnız `full` profilinde vardır.

**Tarihsel yüzey:** 0.3.0 öncesinde `tools/list` 29 aracın tamamını yayımlıyordu; `7+6+3+3+3+7=29` tematik dağılımı, `v0.2.0` Türkçe sözleşme sayfasının `docs/tool-contracts.md:45,72` başlıklarındaki `22 çekirdek + 7 wiki = 29` resmi kataloğunun özetiydi ve 3 yazan + 26 salt-okunur araç vardı. Bu 29 ad bugün `full` profilinde korunur.

**Annotations:** her araç MCP `annotations` beyan eder (`destructiveHint: false`, `openWorldHint: false`). `readOnlyHint: false` yalnız Causoryn'e ait konumlara yazabilen dört araçtadır: `causoryn_status`, `causoryn_refresh_index` (`full`), `causoryn_export_documentation`, `causoryn_wiki_build` (`wiki`/`full`). Böylece `core`'da 2 yazan + 9 salt-okunur, `full`'da 4 yazan + 28 salt-okunur araç bulunur.

**Envelope**: 10 alanlı `z.strictObject` — `schemaVersion` (`"2.0"`), `requestId`, `workspaceId`, `snapshotId`, `status(ok|partial|error)`, `coverage` (tier L0-L4, kenar çözüm sayıları, `coverageRatio`, isteğe bağlı dil başına `byLanguage`), `warnings`, `data`, `nextCursor`, `error`; tümü her yanıtta bulunur. Envelope hataları `isError=false` structuredContent ile taşınır (statü sözleşmesi, protokol hatası değil); stack trace sonuca girmez, beklenmeyen hata `INTERNAL_ERROR` + `requestId` ile döner, ayrıntı yalnız stderr'dedir; `AMBIGUOUS_SYMBOL` yolunda `data` aday listesi taşır.

**Hata kodları**: 15 sabit kod (`CAUSORYN_TOOL_ERROR_CODES`); kod→(`retryable`, `userAction`) eşlemesi `TOOL_ERROR_GUIDANCE`'da deterministiktir. `retryable=true` yalnız `INDEX_NOT_READY` ve `INTERNAL_ERROR` kodlarındadır. `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND` ve `SYMBOL_NOT_FOUND` taban kataloğun ötesindeki üç proje uzantısıdır — ilk ikisi `K-008`, `SYMBOL_NOT_FOUND` ise `K-011` ile karara bağlandı (`packages/mcp-server/src/errors.ts:62-64`); Faz C'de dördüncü bir uzantı kodu basılmadı, sabit `EXPORT_NOT_ALLOWED` kodu yeterliydi (`K-012`). `UNSUPPORTED_LANGUAGE` taban katalogdan korunan **rezerve sabit kod**dur; eksik worker'lar L0/L1 fallback ile düştüğü için bugün fırlatılmaz (`errors.ts:66-68`). Bazı `userAction` metinleri hâlâ legacy araç adlarını anar; `core`'da bunların yerine `causoryn_status` kullanılır.

**Yazma matrisi** — analiz edilen workspace her zaman salt okunurdur:

| Araç | Hedef | Sınır |
|---|---|---|
| `causoryn_status` / `causoryn_refresh_index` (`readOnlyHint: false`) | Yalnız Causoryn graph deposu | `action: "inspect"` hiçbir şey yazmaz; `action: "refresh"` (legacy `refresh_index`) bir indeks işi kuyruğa alır. Hedef `storage.dataDbPath` yoksa süreç-içi `InMemoryGraphRepository`, varsa o SQLite dosyasıdır (mutlak yol, `allowRoots` dışında). Rust worker ilk kullanımda harici Cargo hedef dizinine (`~/.causoryn/cache/rust-worker-target` veya `CAUSORYN_RUST_TARGET_DIR`) derlenebilir |
| `causoryn_export_documentation` (`readOnlyHint: false`) | `output.allowedOutputDirs` | Boş liste `EXPORT_NOT_ALLOWED` döndürür; `--auto-data-dir` kaynak ağacı dışındaki `exports/` dizinini ekler. Yazım atomiktir (`flag: "wx"` geçici dosya + rename). `format="snapshot"` canonical `architecture-snapshot.json` üretir |
| `causoryn_wiki_build` (`readOnlyHint: false`, `wiki`/`full`) | `wiki.dataDbPath` | Mutlak yol zorunlu, `allowRoots` içinde olamaz; beyansızsa `PATH_DENIED`. `--auto-data-dir` ile graph deposuyla aynı `graph.sqlite` kullanılır. Sunucu başlangıcında `openWikiStores` tanımlı `wiki.dataDbPath` üzerinde workspace satırını ilklendirir |
| `causoryn_preflight_change` / `causoryn_verify_change` (`readOnlyHint: true`) | Diske yazmaz | `candidateOnly` sabit `true`; manifest yalnız süreç-içi `PreflightManifestStore` belleğinde (FIFO, 200 kayıt) tutulur ve sunucu yeniden başlayınca kaybolur; `verify_change` çalışma ağacını geçici bellek-içi depoya indeksler |

`storage.dataDbPath` ve `wiki.dataDbPath` başlangıçta sıkı doğrulanır: mutlak yol, null byte yasak, sürücü kökü, sarkan symlink ve SQLite `-wal`/`-shm`/`-journal` yan dosyaları dahil hiçbir yetkili kökün içinde olamaz; ihlal sunucuyu `CausorynConfigError` ile durdurur — sessiz devam yok.

**Mimari dışa aktarım.** `view="architecture"` JSON blueprint, alt gruplu Mermaid, Markdown brief ve betiksiz (`default-src 'none'`) katmanlı SVG içeren offline HTML üretir. `view="interactive"` HTML için çevrimdışı arama, yakınlaştırma ve kanıt paneli sunar; gömülü betik `script-src 'sha256-<hash>'` CSP ile çalışır (`'unsafe-inline'` betik izni yok). `view="full"` ham graph dökümünü korur. `format="snapshot"`, varsayılan veya `full` görünümle ham `CompareContentSet` üretir. `view="wiki"` ve geçersiz görünüm, format veya anotasyon kombinasyonları `INVALID_ARGUMENT` döndürür. `options` ve `annotations` yalnız `architecture` ve `interactive` görünümlerinde kullanılır. İsteğe bağlı `annotations` eklenmedikçe çıktı graph verisinden türetilir. Sağlanan referansların (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`) ve şema sınırlarının doğrulanması dışarıdan gelen anlatının doğruluğunu garanti etmez. Aynı snapshot, format, görünüm, seçenekler ve geçerli anotasyon girdisi dışa aktarım baytlarını sabitler. [Araç sözleşmesi](tool-contracts.md) · [Dışa aktarım testleri](../packages/graph/test/architecture-export.test.ts)

**Cursor/limit**: cursor opak sürümlü codec'tir (`{v:1,o:<int>}` → base64url); bozuk, kurcalanmış veya eski biçimli cursor `INVALID_ARGUMENT` döner; `nextCursor` son sayfada `null`'dır. Limitler: `results.maxNodes` 250, `results.maxSymbols` 100, `results.maxDepth` 3, `results.maxPaths` 50, `index.maxFiles` 50.000, `maxFileBytes` 2.000.000; wiki varsayılanı 50 / tavanı 200 (`K-013`); aşım `LIMIT_EXCEEDED`. `causoryn_trace` varsayılan `maxDepth`/`maxPaths` değerlerini (6 / 25) yapılandırma tavanına kırpar ve uyarı ekler; kontrat araçları liste başına en fazla 25 çift/yol kabul eder; `maxProximityDepth` tavanı 4'tür.

## 6. Dil Desteği

### 6.1 İki eksen, beş adapter

"L0-L4" iki eksendir: (1) **adapter yetenek ekseni** — L0 dosya/manifest → L4 flow/contract cross-link; (2) **harita hiyerarşisi** — `causoryn_map_system` için L0 Workspace/Repository/Project → L3 Function/Method/Handler/Endpoint/Test; L4 akış haritası açıkça reddedilir (0.3.0 kaynağı için §10.4). Bu bölüm birincisini anlatır. TypeScript süreç içidir (Compiler API: Program + AST + TypeChecker; ESM + CommonJS; monorepo workspace paket çözümü; CHA `INHERITS`/`IMPLEMENTS`; BDD `Test`/`TESTS` çıkarımı); öteki dört dil `@causoryn/sidecar-ipc` üzerinden sidecar'dır: python saf stdlib `ast`, go `go/parser` + `go/ast`, rust `syn` 3, csharp Roslyn (`dotnet exec`; CHA ve salt-okunur NuGet referans keşfi). `INDEXED_ADAPTERS` 5 kayıt tutar; `causoryn_status` (`data.capabilities.adapters`) ve legacy `get_capabilities` bu diziden `{language, analyzerId, version, levels}` projeksiyonunu döndürür. `coverage.tier`, TS/JS/C#/Python AST/sembol node'u varsa `L2`, yalnız Go/Rust AST/sembol node'u varsa `L1`, hiç sembol/AST node'u yoksa `L0` hesaplar; `coverage.byLanguage` aynı hesabı dil başına verir:

| Dil | Motor | Resolution beyanı | L3 route |
|---|---|---|---|
| TypeScript / JavaScript | TS Compiler API (in-process) | L2 (TypeChecker verified) | `express+nextjs` + genel `<x>.<verb>` kalıbı |
| C# | Roslyn `SemanticModel` | L2 — gerçek semantik sidecar | `aspnet-core-route-attributes (L3)`: controller `[Route]`/`[Http*]` + Minimal API `MapGet`/… |
| Python | stdlib `ast` | L2 + "tam type inference YOK" | `decorator-route-pattern (L3)`: `@carrier.get/…` + Flask `route` |
| Go | stdlib `go/parser` | "heuristic-only (no semantic L2)", `symbolResolution: false` | `http-router-registration (L3)`: Handle/HandleFunc + chi/gin/echo |
| Rust | `syn` 3 | "heuristic-heavy" | `attribute-macro-route (L3)`: attribute-macro fiilleri + axum/actix/rocket |

C#'ın L3 yüzeyi `frameworkLinkers: "aspnet-core-route-attributes (L3)"` olarak beyan edilir (`packages/indexing/src/index.ts:205`, `K-022`); worker içi tam yetenek beyanı `aspnetcore-controller-attribute-and-minimal-api-call-pattern`'dir (`native/roslyn-worker/Protocol.cs:234`).

### 6.2 Resolution dürüstlüğü

Etiketler dil başına sabittir (`K-018`; ayrıntı [dil analizörleri](language-analyzers.md)): **typescript** — TypeChecker'ın analiz edilen bir sembole çözdüğü çağrı/import/kalıtım `verified`; göreli modül adayı veya `node:*` builtin `heuristic`; sembol çözülmezse `unresolved`. **csharp** — `SemanticModel`'in çözdüğü her çağrı ve `BaseType`/`Interfaces` `verified`; referans derlemeleri eksikse bilinen-ad kuralı `heuristic`. **python** — `verified` yalnız aynı modül (`self.<m>`, `Sınıf.<m>` dahil); import edilen `heuristic` + ambiguity; yerel/builtin/tanımsız `unresolved` → `UnknownExternal`. **go** — paketler **dizin** ile anahtarlanır; `verified` aynı-paket çıplak tanımlayıcı ile `go.mod` modül yoluyla tek pakete çözülen `pkg.Func()` çağrısıdır (yerel değişken gölgelemesi AST'ten ayırt edilemez — belgeli); `go.mod` yoksa dizin soneki/paket adı eşleşmesi, benzersiz metot ve arayüz metodu `heuristic`; builtin kenar ÜRETİLMEZ. **rust** — yalnız aynı modüldeki çıplak `fn` çağrısı `verified`; son iki segmentte tek eşleşen nitelikli yol (`Type::method`, `mod::fn`) `unverified-module-prefix-suffix-match` ambiguity'siyle `heuristic`; metot çağrıları `heuristic` (trait dispatch yok). Belirleyici kaynak `native/rust-worker/src/analyzer.rs`'dir; kural `two_segment_suffix_match_emits_heuristic_with_explicit_ambiguity_never_verified` birim testiyle sabitlenir.

`ROUTES_TO` kenarları **TS, Python ve Rust'ta** `verified` + evidence'lıdır; **C#'ta** controller öznitelik tipleri veya Minimal API uzantı metotları Roslyn semantic model ile `Microsoft.AspNetCore.*` köküne çözülebildiğinde `verified`, çözülemediğinde bilinen-ad kuralıyla `heuristic` (+ `ambiguity`) üretilir (`native/roslyn-worker/WorkerAnalyzer.cs:1475-1508`, 0.3.0'da Minimal API semantik kapısı; controller kararı `WorkerAnalyzer.cs:1692-1728`); **Go'da** aynı-paket tanımlı handler fonksiyonu `verified`, selector handler `CALLS` tablosunu izler (`heuristic` veya `unresolved`), tanımsız çıplak handler adı `unresolved` (`UnknownExternal`), inline anonim `func` literal ise Endpoint'i koruyup kenar üretmez (`native/go-worker/internal/analyze/routes.go:120-170`, ayrıca `:106-111`).

Nüans: sidecar worker protokol çıktısındaki `coverageRatio` `verified / total` kenar oranıdır (Python fixture'ında 16/25 = 0.64), MCP envelope `coverage.coverageRatio` alanı ise `(verified + heuristic) / totalEdges` olarak hesaplanır.

### 6.3 Degrade katmanları

Üç düzey vardır: (1) **adapter** — 4 sidecar'da özdeş fallback: `workerAvailable:false`, `state:"partial"`, `coverageRatio:0`, `sourceHash`'li File node'ları korunur, yetenekler false, açık uyarı ve `coverage.byLanguage`'da düşük tier. (2) **toolchain** — spawn'lar sabit komut + sabit argüman + env allowlist kullanır ve analiz edilen depoda değil Causoryn'in güvenilir worker dizininde çalışır: python için `python` komutu sabit `-I -B -X utf8 <script>` argümanlarıyla (isolated mode: `PYTHON*` ortam değişkenleri ve betik dizini `sys.path`'e alınmaz; `-B` `__pycache__` yazımını kapatır; `PYTHONPATH` taşınmaz), go `go run ./cmd/worker` veya `CAUSORYN_GO_WORKER_BIN` (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; timeout 120 sn), rust literal `cargo build --locked` (`adapters/rust/src/cargo.ts`; `CARGO_BUILD_RUSTC_WRAPPER=""`, harici hedef dizini, SHA-256 pinli ikili; soğuk derleme 600 sn), csharp `dotnet exec` (`DOTNET_STARTUP_HOOKS=""`). (3) **dosya/pipeline** — SyntaxError hata değildir: `partial` + dosya/satır tanısı üretilir, sağlam dosyaların grafiği sürer.

Tarihsel canlı kanıt (2026-11-16 analiz oturumu, 0.3.0'da yeniden koşulmadı): broken.py + ok.py → exit 0, `partial`, `diagnostics[{code:"SyntaxError",line:1}]`; `npx vitest run packages/indexing/test/index-service-multilang.test.ts` ilk koşumda `spawn dotnet ENOENT` → C# adapter L0/L1'e düştü, diğer 4 dil tam üretildi, snapshot `partial` yayımlandı, motor ayakta kaldı; PATH düzeltmesiyle 9/9 geçti (55.97 sn).

### 6.4 Örnek senaryo: bir Python projesi verilirse ne olur?

Kullanıcı `examples/fixture-python-app`'i (3 dosya) yetkili kök olarak bağlar ve `causoryn_status` `action: "refresh"` çağırır (legacy adı `causoryn_refresh_index`). Akış: WorkspaceAccessPolicy yetkilendirir → envanter → adapter worker spawn'ı → stdlib `ast` parse → tek build'e katma → `ready` yayın. Aşağıdaki sonuç 2026-11-16 tarihli canlı koşumdur; o tarihte worker `python -B native/python-worker/worker.py` ile başlatılıyordu (0.3.0'da argümanlar `-I -B -X utf8`). Sayılar [uygulama durumu](implementation-status.md) sayfasındaki çok dilli genişleme kaydıyla birebir aynıdır:

- **exit 0, ready** — 21 node (3 File, 1 Class, 8 Function, 2 Method, 2 Endpoint, 5 UnknownExternal), 25 edge (11 CONTAINS/verified, 3 CALLS/verified, 4 CALLS/heuristic, 5 CALLS/unresolved, 2 ROUTES_TO/verified), worker `coverageRatio` 0.64.
- `@app.get("/x")` → Endpoint + ROUTES_TO verified; aynı modül `helper()` → CALLS verified; `utils.run()` import'u → heuristic + ambiguity; çözülemeyen ad → UnknownExternal + unresolved — uydurma hedef yok.
- Host modeli `causoryn_find_symbols` / `causoryn_get_symbol_context` ile bağlamı, `causoryn_get_evidence` ile span + `sourceHash`'li zinciri okur.
- Python hiç olmasaydı: spawn başarısız → L0/L1 düşüş, `sourceHash`'li File node'lar + uyarı ile `partial` yayın; graph boş dönmez ama sembol katmanı olmaz — motor çökmez.

## 7. Güvenlik Modeli

Runtime'ın LLM veya embedding bağımlılığı yoktur. Kaynak analizi salt okunurdur; veri depoları ve dışa aktarımlar ayrı yazma politikalarına tabidir. stdout yalnız MCP protokol mesajlarını taşır, tanılama stderr'e gider. Yayımlanan her aracın çalışan bir handler'ı olmak zorundadır.

**WorkspaceAccessPolicy**, leksik UNC/aygıt yolu ön denetiminden (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…` herhangi bir dosya sistemi çağrısından önce reddedilir) sonra sabit 6 adımlı karar sırası uygular: (1) kök yetkilendirmesi — yalnız yapılandırmada beyan edilen allowRoot'lar, realpath canonicalization (MCP isteği tek başına kök ekleyemez); (2) null byte reddi; (3) leksik `..`/mutlak yol reddi; (4) ignore (atalar dahil); (5) realpath symlink/junction escape reddi (CWE-59); (5b) kanonik yola ignore yeniden uygulaması — symlink secret-deny listesini bypass edemez; (6) uzantı + `maxFileBytes`. Sıfır-ayar CLI/IDE akışında (`--allow-cwd` ve MCP `roots/list`) `inspectProjectRootSafety` ek savunma derinliği olarak dosya sistemi köklerini, `$HOME` ve atalarını (`C:\Users`, `/home`, `/Users`), Causoryn veri/eklenti kurulum dizinlerini (`~/.causoryn`, `_npx`, `node_modules`), hassas kullanıcı dizinlerini (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), OS sistem dizinlerini (`/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/bin`, `/sbin`, `/lib`, `/dev`, Windows sistem konumları) ve çıplak `/tmp`, `/var` köklerini proje kökü olarak reddeder; `--auto-data-dir` yetkili köklerin dışında `0700` ve sarkan-symlink (CWE-59) kontrolüyle hazırlanır. Kullanıcı bir `output.allowedOutputDirs` dizinini açıkça tanımladığında export yetkisi bu liste ve realpath containment ile belirlenir (`packages/workspace/src/output-policy.ts:11-48`).

**Toolchain izolasyonu ve tedarik zinciri:** 4 sidecar worker sabit komut + sabit argüman + env allowlist ile ve shell interpolation olmadan başlatılır (`packages/sidecar-ipc/src/index.ts`, `adapters/*/src/worker-process.ts`, `adapters/rust/src/cargo.ts`). `packages/graph/src/git-read.ts` `execFile` + `shell: false`, alt komut allowlist'i (`cat-file`, `ls-tree`, kısıtlı `rev-parse`), 10 anahtarlı minimal env allowlist'i (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<null aygıt>`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1` …), alt komut öncesi `-c` geçersiz kılmaları (`core.fsmonitor=false`, `core.sshCommand=false`, `protocol.allow=never` …) ve çalışma ağacı blob okumalarında `O_NOFOLLOW` + açma-sonrası `dev`/`ino` TOCTOU doğrulaması uygular; `HEAD~N`/`HEAD^` `rev-parse --verify --end-of-options` ile çözülür. CLI başlatıcıları import öncesi Node `>=24` muhafızı (`node-version-guard.mjs`) ve `--expected-version` pini (`plugin-mcp-launcher.mjs`) zorlar; Roslyn worker deterministik Release bayraklarıyla (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`) derlenir, böylece DLL içine yerel PDB yolu sızmaz. `causoryn_verify_change` mimari kurallarını güvenilir Git `baseRef`'ten okur; çalışma ağacına düşerse `architecture-rules-loaded-from-untrusted-working-tree` uyarısı ekler.

Paketlenmiş bundle tehdit matrisi **9/9 PASS** kayıtlıdır: symlink/traversal, secret leakage, TOCTOU, poisoned comment, oversized files, malicious refs, network denied, offline HTML XSS/CSP, stdout disiplini ([güvenlik denetimi](security-pass.md)). Son koşum (2026-11-24): `npx vitest run tests/security-release/ tests/toolchain-isolation.test.ts tests/git-read.test.ts tests/path-safety.test.ts` → 6 dosya, 58 test geçti (`tests/security-release/` 36/36). Üretim kaynak, doküman ve workflow yüzeyi `npm run secret-scan` (`scripts/secret-scan.mjs`, **13 kök** + 13 kök metin dosyası) ile taranır; `K-022` yayın hazırlığı koşumunda `npm audit` **0 güvenlik açığı** bildirdi, CI ise her koşumda `npm audit --audit-level=high` çalıştırır.

## 8. Kalite ve Testler

Varsayılan Vitest kuralları 120 izlenen test dosyasını kapsar; `tests/bench-release/benchmark.test.ts` ayrı çalıştırılır (toplam 121 Vitest test dosyası). Kök paket `test`, `test:watch`, `bench`, `build`, `build:package`, `typecheck`, `lint` ve `secret-scan` komutlarını tanımlar. Repoda 5 SHA-sabitli iş akışı vardır: `.github/workflows/ci.yml` (`ubuntu-latest` + `windows-latest` + `macos-26-intel` merge kapısı, gece arm64 `macos-26`, 5 dil toolchain'i, `-p:RestoreLockedMode=true`, `cargo build --locked`, `export-public-tree.mjs --verify-temp --ref HEAD`), `security.yml` (`zizmor`, PR `dependency-review`, npm + NuGet denetimi), 5 dilli `codeql.yml`, OpenSSF `scorecard.yml` ve 3 işli `release.yml` (`verify-and-test` → `build-and-pack` → `publish`; `K-025` ile kurulan 2 işli SLSA ayrımı 0.3.0'da üçe çıktı); her Linux işi `step-security/harden-runner` çalıştırır. 4 ekosistemli, 7 günlük soğuma süreli `.github/dependabot.yml` `tests/ci-workflow.test.ts` ile sabitlenir. [Test yapılandırması](../vitest.config.ts) · [Paket komutları](../package.json) · [Uygulama durumu](implementation-status.md)

Aşağıdaki tablo kayıtlı koşum sonuçlarıdır; bu belge güncellenirken yeniden çalıştırılmadı:

| Kapı | Komut | Kayıtlı sonuç |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 (önceki yayın hazırlığı) |
| build | `npm run build` | exit 0 (önceki yayın hazırlığı) |
| lint | `npm run lint` | exit 0, sıfır ihlal (önceki yayın hazırlığı) |
| secret-scan | `npm run secret-scan` | exit 0 (`scripts/secret-scan.mjs`, izlenen ve yok sayılmayan her dosya, 0 eşleşme) |
| security | `npx vitest run tests/security-release/` | 36/36 (2026-11-24 dahil) |
| bench | `npm run bench` | 2026-11-10: 8/8; medyan 11.8/13.0/10.7 ms, soğuk indeks 16370.3 ms; hedefler referanstır ([benchmark'lar](benchmarks.md)) |
| npm audit | `npm audit --json` | `K-022` koşumunda **0 güvenlik açığı** (`eslint@10.15.0` ve `typescript-eslint@8.73.0` yükseltmesiyle) |

`K-022` kapsamında yük altında gözlenen `ENOENT` ve timeout sorunlarına karşı `build-bundle.mjs` yazımı atomik hale getirildi ve bazı süreç testlerine 20 saniyelik açık timeout eklendi. Bundle, `better-sqlite3` native eklentisi JavaScript'e gömülemediği için kasıtlı olarak çok dosyalıdır; 36 girdili `dist/bundle-manifest.json` her dosyanın SHA-256'sını kaydeder. `.github/workflows/release.yml` `SHA256SUMS.txt` ve CycloneDX 1.5 SBOM üretir, build provenance'ını onaylar ve token'sız npm OIDC ile yayımlar (`npm publish --provenance --access public`).

Bilinen sınırlar (0.3.0): Antigravity `agy` CLI kurulum/smoke NOT RUN (doğrudan `stdio` el sıkışması otomatik testte doğrulanır); ZCode masaüstü GUI kurulumu NOT RUN; 3-OS CI geçer ama canlı macOS/ARM64 host CLI/GUI smoke açık kapıdır; MCP SDK 1.32.2 v1.x; Live Architecture watcher MCP yüzeyi yok (`file_facts` erken kesme ve `oldProgram` yeniden kullanımı mevcut; `K-020` ile açılan `refresh_index mode=incremental` bugün `causoryn_status` `action: "refresh"`); paylaşılan veritabanı koordinasyonu Partial (yalnız tek yazıcılı yayın ve yetim kurtarma iddia edilir); rate-limit kapsam dışı (`K-010`); visualizer gerçek tarayıcı koşusu yok; çıplak `packages/mcp-server/dist/` bundle'ında `.d.ts` yoktur (`packages/causoryn` `K-021` dağıtımı `dist/typescript-lib/lib*.d.ts` ile `ready` durumuna ulaşır).

## 9. Karar Kayıtları (seçme)

Karar kayıtları proje içi karar defterinde tutulur; aşağıdaki seçme ürünü etkileyen kararları özetler. Süreç ve metodoloji kararları (`K-001`–`K-007`) bu özetin kapsamı dışındadır.

| Karar | Özet |
|---|---|
| K-008/K-011/K-012 | Hata kodu yönetişimi: `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND` kararlı (`K-008`); `SYMBOL_NOT_FOUND` üçüncü uzantı (`K-011`); Faz C'de dördüncü uzantı İSTENMEDİ — mevcut `EXPORT_NOT_ALLOWED` yeterliydi (`K-012`) |
| K-009/K-010 | MCP SDK 1.32.2 v1.x sapması kabul (v2 yükseltmesi 1.0.0 kapısı); rate-limit/concurrency kapsam dışı |
| K-013/K-014 | Wiki açık konuları: opak cursor 50/200; bozuk link `WikiLink` olarak korunur + `brokenLinkDiagnostics` (hata değil, veri yüzeyi) |
| K-015/K-016 | `CONTRACT_PARSE_FAILED` ilk kullanımı; SQL RENAME → `unknown`; `verify_change` için deterministik verdict zinciri (`no_findings` / `review_required` / `blocking_findings` / `inconclusive`); "geçen test sayısı" host beyanıdır, çekirdek dosya okumaz |
| K-017 | **0.1.0 genel snapshot** (kapılar açık); bundle "mcp-server.mjs + vendored better-sqlite3", tek dosya iddiası yok; `TOOL_NAMES` 29 adla kilitli (0.3.0'da bu 29 ad `full` profilinde korunur) |
| K-018 | Çok dilli resolution etiketleri `PROTOCOL.md` tablolarıyla sabitlendi; iki hatalı ifade (Go nitelikli çağrı = verified; Rust tamamen heuristic) disk gerçeğiyle düzeltildi |
| K-019/K-020/K-021 | Denetim düzeltmeleri (`ROUTES_TO` 5-dil doğruluğu, Antigravity `mcp_config.json` + bundle sahnelemesi, MCP `annotations`) + Pre-1.0 mühendislik iyileştirmeleri (`storage.dataDbPath` kalıcı SQLite + `symbol_fts` `fts` ayağı, `refresh_index mode=incremental`, TS `Test`/`TESTS`, `export_documentation format=snapshot`, `@causoryn/sidecar-ipc`, GitHub Actions CI) + açık kaynak çoklu-host dağıtım (`packages/causoryn`, `npx causoryn setup`, `causoryn doctor`, 4 host pazaryeri manifestleri, `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, `dist/typescript-lib/lib*.d.ts`) |
| K-022 | **0.2.0 Pre-1.0**: kamuya açık repo dışa aktarımı, MIT ve üçüncü taraf lisans bildirimleri, SHA-sabitli üç işletim sistemi CI, OIDC yayın ve SBOM |
| K-023 | **0.2.2**: görsel mimari projeksiyonu, offline HTML/SVG portalı, isteğe bağlı ve referans kontrollü host anotasyonları, `architecture-blueprint` skill'i ve `PRAGMA data_version` önbelleği |
| K-024 | **0.2.3**: evrensel JS/CJS (`.js`/`.jsx`/`.mjs`/`.cjs`, CommonJS), kök-içi hapsedilmiş `tsconfig.json`/`jsconfig.json` yükleyicisi, polinom-zamanlı sıfır-RegExp glob + akıllı ignore/`bin/`, `collectInventoryAsync` ve `causoryn-architecture-interactive.html` varsayılan adı |
| K-025 | **0.2.4**: CI/CD ve tedarik zinciri sertleştirmesi: `zizmor`, 5-dil `CodeQL`, OpenSSF `Scorecard`, 2-job SLSA `release.yml`, Linux `step-security/harden-runner`, `-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp` ve 7 günlük Dependabot soğuma süresi (`tests/ci-workflow.test.ts`) |
| K-026 | **0.2.4**: iki dilli doğal dil skill tetikleme, `causoryn_export_documentation` MCP Zod `.describe()` şema belgeleri ve 17 çiftli Diátaxis TR/EN dokümantasyon yenilemesi |
| 0.3.0 | Varsayılan 11 araçlık `core` profili ve `wiki`/`history`/`full` profilleri, varsayılan olarak `outputSchema`'sız `tools/list`, workspace başına paylaşılan `graph.sqlite` + `build_leases`, `worker_threads` indeksleme, `file_facts` erken kesme, toolchain izolasyonu ve UNC/aygıt yolu reddi ([sürüm kaydı](../CHANGELOG.md)) |

## 10. Durum ve Sürüm

### 10.1 Sürüm çizgisi

**0.3.0 Pre-1.0** değişiklik günlüğünde 2026-11-24 tarihini taşır; `1.0.0` ilan edilmedi. Minör sürüm, varsayılan araç yüzeyi kırıcı biçimde değiştiği için (29 araç → 11 araçlık `core`) yükseltildi.

| Sürüm | Tarih | Öne çıkan | Kayıt |
|---|---|---|---|
| `v0.1.0` | 2026-11-09 | 29 araçlık ilk genel snapshot; tarihsel etiket `4c9c188` (`4c9c188f`) üzerinde dondurulmuş | `K-017` |
| — | — | Python/Go/Rust sidecar'larıyla çok dilli genişleme sonrası eski taban `d197f21` | `K-018` |
| `0.2.0` | 2026-11-20 | Açık kaynak yayın yönetişimi | `K-022` |
| `0.2.1` | 2026-11-22 | Arka planda ilk indeks, `.gitignore` birleşimi, toplu SQLite yazımı | — |
| `0.2.2` | 2026-11-22 | Görsel mimari portalları | `K-023` |
| `0.2.3` | 2026-11-23 | Evrensel JS/CJS, hapsedilmiş config, bloklamasız envanter | `K-024` |
| `0.2.4` | 2026-11-24 | Tedarik zinciri sertleştirmesi; doğal dil skill + iki dilli doküman | `K-025`, `K-026` |
| `0.3.0` | 2026-11-24 | Araç profilleri, paylaşılan indeks, `worker_threads`, `file_facts` | [CHANGELOG](../CHANGELOG.md) |

Kamuya açık olmayan proje wiki'sinin `wiki/index.md:5-28` haritası bu tarihçeye giden iç bağlantıları içerir; wiki dizini açık kaynak ağacında yer almaz. [Değişiklik günlüğü](../CHANGELOG.md) · [Uygulama durumu](implementation-status.md)

### 10.2 Host matrisi

Canlı host CLI koşumları 0.3.0 öncesinde, 29 araçlık katalogla kaydedildi ([uyumluluk matrisi](compatibility-matrix.md)): Claude Code ✔ gerçek handshake (CLI 2.1.322, 2026-11-10; 2.1.328 ile 2026-11-19'da `plugin validate --strict` + `claude mcp list → ✔ Connected`); Codex ✔ add→list→remove (CLI 0.163.0 ve 0.169.0; `codex mcp list` health-check yapmaz — kayıt düzeyi smoke); ZCode ⚠ manifest ve yalıtılmış CLI doğrulaması (masaüstü GUI kurulumu `NOT RUN`); Antigravity ❌ `agy` CLI kurulum/smoke **NOT RUN** (`agy` ikilisi doğrulama makinesinde yok). `integrations/antigravity/causoryn/` altında `plugin.json` (`$schema`'sız yerel yükleyici uyumlu), `mcp_config.json` (yerel yükleyici birincil tanımı), `mcp.json` (taşınabilir manifest), `README.md` ve `build:bundle` ile deterministik sahnelenen `scripts/mcp-server.mjs` + `scripts/index-worker.mjs` (+ vendored `better-sqlite3`) bulunur; `antigravity-plugin.test.ts` içindeki doğrudan `stdio` el sıkışması 0.3.0 öncesinde 29 aracı listeliyordu, 0.3.0'da 11 core aracı listeler. CLI host düzeyinde net durum 2/3 gerçek koşumdur. 0.3.0 profil davranışı canlı host CLI'larıyla yeniden koşulmadı; otomatik testlerle doğrulanır (`tests/mcp-tool-surface-budget.test.ts`, `tests/open-source-distribution.test.ts`, `packages/mcp-server/test/stdio-stdout.test.ts`). Tüm host'lar aynı `causoryn@0.3.2` motorunu çalıştırır (`dist/mcp-server.mjs` + `dist/index-worker.mjs` + vendored `better-sqlite3`); kılavuzlar `docs/hosts/`, `integrations/zcode/` ve `integrations/antigravity/` altındadır.

### 10.3 Kalan 1.0.0 kapıları

`CHANGELOG.md` `[Unreleased]` ve [uygulama durumu](implementation-status.md) ile aynı liste: (1) Antigravity `agy` CLI canlı kurulum + smoke; (2) ZCode masaüstü GUI kurulumu + `tools/list` smoke; (3) canlı macOS / Linux / ARM64 host smoke; (4) MCP TypeScript SDK v1.x (`^1.32.2`) → v2 (`K-009` kapanışı); (5) Live Architecture watcher MCP yüzeyi (Partial); (6) C#/Python/Go/Rust `Test`/`TESTS` çıkarımı (`adapters/typescript` üretimi `K-020` ile açıldı); (7) OpenAPI yanıt-şeması drift + event-version kuralı + SQL `RENAME` sınıflandırması; (8) analiz edilen workspace'e yazmadan salt-okunur snapshot revizyon akışı (`export_documentation format=snapshot` üreticisi `K-020` ile açıldı; MCP geçmiş araçları diğer commit'leri git nesnelerinden salt okunur analiz eder; proje/build girdileri (C# proje dosyaları, kurulu paketler) hâlâ çalışma ağacından gelir); (9) `wiki_search` filtreleri + `WIKI_NOTE_CONFLICT` rehberi + daraltılmış artımlı wiki yayını; (10) offline etkileşimli HTML portalı ve `apps/visualizer` için gerçek tarayıcı kabulü; (11) çıplak monorepo bundle'ı için varsayılan lib (`.d.ts`) kararı; (12) eşzamanlı MCP istekleri için rate-limit bütçesi (`K-010`). Zaten kapatılanlar: `scripts/secret-scan.mjs` kapısı (13 kök) ve `npm audit` 0 güvenlik açığı (`K-022`). Kapılar sağlanmadan 1.0.0 ilan edilmez.

### 10.4 Satır atıfları (tarihsel karşılaştırma)

Satır numaraları kod değiştikçe kayar. Aşağıdaki atıflar 0.2.x tarihli kayıtlardır ve kayıt bütünlüğü için korunur; her birinin doğru olduğu etiket ve 0.3.0'daki karşılığı yanında verilmiştir:

- `packages/mcp-server/src/services.ts:698-716,765-771` — `v0.2.0`'da `map_system` harita hiyerarşisi (`MapSystemInputSchema`, `MAP_LEVEL_KINDS`) ve L4 reddi. 0.3.0'da aynı kod `services.ts:968-988,1037-1043` aralığındadır.
- `packages/domain/src/snapshot.ts:379-397` — `v0.2.4`'te snapshot kimlik formülü. 0.3.0'da bu aralık karmaya beslenen kanonik edge/evidence JSON projeksiyonlarını tutar; kimlik `computeStreamingSnapshotId` içinde (`snapshot.ts:441-468`) hesaplanır.
- `native/roslyn-worker/WorkerAnalyzer.cs:1475-1508` — `v0.2.4`'te C# controller öznitelik kararı. 0.3.0'da bu aralık Minimal API semantik kapısını gösterir; controller öznitelik kararı `WorkerAnalyzer.cs:1692-1728`'dedir.
- `docs/tool-contracts.md:45,72` — `v0.2.0` Türkçe katalog başlıkları (`22 çekirdek + 7 wiki`). 0.3.0'da sayfa profil yapısına göre yeniden düzenlendi.
- `wiki/index.md:5-28` — kamuya açık olmayan proje wiki haritası; açık kaynak ağacında doğrulanamaz.

[Uygulama durumu](implementation-status.md) arşivlenmiş kabul kanıtlarını ve açık işleri, [uyumluluk matrisi](compatibility-matrix.md) host başına koşum düzeyini, [mühendislik backlog'u](BACKLOG.md) kapıların kapanış ölçütlerini gösterir. Hızlı başlangıç: [5 dakikalık eğitim](en/tutorial-5-minutes.md) (İngilizce).

---

# English

# Causoryn — Comprehensive Project Document (0.3.0, Pre-1.0)

> **Status:** reflects Causoryn 0.3.2 (pre-1.0; `1.0.0` is not declared; default `core` tool profile, one shared `graph.sqlite` per workspace, non-blocking `worker_threads` indexing). For detail, the [English reference documentation](en/README.md) and the source code are authoritative; if this page and the source disagree, the source wins.
>
> **Release line:** `K-022` open-source release (`0.2.0`) → `0.2.1` runtime improvements → `K-023` visual architecture exports (`0.2.2`) → `K-024` universal JS/CJS + confined `tsconfig`/`jsconfig` + non-blocking inventory (`0.2.3`) → `K-025` CI/CD supply-chain hardening and `K-026` natural-language skills + bilingual documentation (`0.2.4`) → **`0.3.0`** tool profiles, shared index, and `worker_threads` indexing. Dates and earlier run records: [changelog](../CHANGELOG.md) · [implementation status](en/implementation-status.md).

## 1. Executive Summary

Causoryn is a **local, model-independent code-analysis engine** served over stdio MCP. Its runtime converts a repository into a **Unified Evidence & Knowledge Graph** without calling an LLM, embedding service, or model API. In the optional `architecture-blueprint` workflow, the host model can prepare prose and send it to `causoryn_export_documentation` as `annotations`. Causoryn validates that input against its schema, size budgets, and snapshot/projection references (up to 25 errors per call) and renders it with fixed export rules. [No-LLM decision record](en/adr/ADR-002-no-llm.md) · [Architecture Blueprint skill](../skills/architecture-blueprint/SKILL.md)

`SERVER_VERSION = "0.3.2"` and `SCHEMA_VERSION = "2.0"`. The default **`core` profile publishes 11 MCP tools**; the `wiki` (+7), `history` (+2), and `full` (29 legacy names + 3 consolidated names = **32 tools**) profiles are opt-in. The engine has five adapters: TypeScript/JavaScript runs in-process, and C#, Python, Go, and Rust run as sidecars over `@causoryn/sidecar-ipc`. Indexing runs in `worker_threads`, and all hosts share one `graph.sqlite` per workspace. The repository contains 120 tracked test files covered by the default Vitest configuration and 1 separately run benchmark test file (121 Vitest files total). See §8–§10 for run evidence and the open 1.0.0 gates. [Tool catalog](../packages/mcp-server/src/version.ts) · [Adapter catalog](../packages/indexing/src/index.ts) · [Test configuration](../vitest.config.ts)

## 2. Problem Statement — AI Agents Code Blind

A coding agent can query the graph and its evidence to inspect symbols, calls, and the potential impact of an edit. Every `verified` edge links to at least one evidence record. When present, source spans carry `relativePath`, line bounds, and `sourceHash`. Each relationship receives a `verified`, `heuristic`, or `unresolved` label. For example, the Python adapter marks a call inferred from imports as `heuristic` and an unresolved call as `UnknownExternal`. Every envelope reports per-language coverage in `coverage.byLanguage`, so strong TypeScript coverage cannot hide an L0 fallback in another language. [Graph schema](../packages/domain/src/graph-schema.ts) · [Python protocol](../native/python-worker/PROTOCOL.md)

## 3. Product Loop

Agent work is structured as **Discover → Preflight → Agent Edits → Verify → Explain**:

| Stage | Causoryn's role | Representative tools (`core`; extra profiles noted) | Writes? |
|---|---|---|---|
| Discover | Evidence-backed architecture/symbol context and task-focused context packs | `causoryn_status`, `causoryn_map_system` (including `profile: "onboarding"`), `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace` (`mode: "execution" \| "business-flow"`), `causoryn_get_agent_context` | No; only `causoryn_status` `action: "refresh"` writes to Causoryn's own index |
| Preflight | Candidate manifest, impact candidates, test plan, and contract checks | `causoryn_preflight_change` (`candidateOnly: true`; `include: ["impact", "test-plan"]`), `causoryn_contracts` (`action: "check" \| "drift"`) | No |
| Agent Edits | The host model edits the tree; Causoryn takes no part | — | No |
| Verify | Re-checks the working tree with the `architecture`, `graph-diff`, `test-plan` (and, on request, `contracts`) checks; never runs tests | `causoryn_verify_change` | No; the working tree is indexed into a scratch in-memory repository |
| Explain | Evidence chains and architecture exports; optional Living Wiki and architecture history | `causoryn_get_evidence`, `causoryn_export_documentation`; `wiki` profile: 7 `causoryn_wiki_*` tools; `history` profile: `causoryn_compare_architecture`, `causoryn_architecture_timeline` | `causoryn_export_documentation` only into `output.allowedOutputDirs`, `causoryn_wiki_build` only into the `wiki.dataDbPath` store |

The honesty boundary is explicit: the test plan proposes candidates from `TESTS` edges and call sites but never runs tests; host-reported test results are recorded only as `state: "host_asserted"` (`engineVerified: false`), and `no_findings` is not a correctness guarantee (reports carry `disclaimers`). Persistent memory is the **Living Wiki**: a cross-cutting knowledge layer derived from the graph and served by 7 tools in the `wiki` profile.

## 4. Architecture

### 4.1 Pipeline

The local analysis path runs **Workspace Gateway (UNC/device-path pre-check + `allowRoots` + root safety) → File Inventory (`collectInventoryAsync`) → Language/Framework Adapters → Normalization and Symbol / Hierarchy (CHA) / Contract Resolution → Unified Evidence Graph → Immutable Snapshot (streaming SHA-256 ID) → publication in the shared `graph.sqlite` (single writer via `build_leases`) → Domain Queries & Verification → MCP `structuredContent` (11-tool `core` profile)**. The host-selected model operates on the MCP client side. The code-facing pipeline block is at `docs/architecture.md:13-22` (Turkish) and `docs/en/architecture.md:13-22` (English). [Architecture](en/architecture.md)

### 4.2 Packages and dependency boundaries

The monorepo comprises **18 npm workspace packages** (`12 packages/*` + `5 adapters/*` + `1 integrations/zcode/causoryn`; 19 `package.json` manifests including the root), 14 direct project references in the root `tsconfig.json`, the standalone `apps/visualizer`, 4 `native/*` sidecar workers (`native/roslyn-worker` built as a deterministic Release `net10.0` worker, `native/python-worker`, `native/go-worker`, `native/rust-worker`), root 4-host open-source marketplace manifests + `npx causoryn setup` / `causoryn doctor` CLI distribution (including `THIRD-PARTY-NOTICES.md` + `licenses/`), 5 SHA-pinned GitHub Actions workflows (`.github/workflows/ci.yml`, `security.yml`, `codeql.yml`, `scorecard.yml`, `release.yml`) + `.github/dependabot.yml`, the `integrations/antigravity/causoryn` plugin directory, and 8 `examples/*` fixtures:

| Package (`packages/*`) | Responsibility |
|---|---|
| `domain` | Graph/evidence contracts, Zod schemas, canonical JSON, deterministic SHA-256 IDs, streaming snapshot hash (`computeStreamingSnapshotId`); 27 node kinds and 20 edge kinds |
| `sidecar-ipc` | Shared sidecar IPC core: NDJSON framing, timeouts, stdout/stderr budgets (64 MiB by default), `shell: false` + `windowsHide: true` on every spawn, rejection of an empty or NUL-containing `cwd`, allowlist env, dynamic asset root |
| `workspace` | Gateway: lexical UNC/device-path rejection, trusted roots, inventory, zero-RegExp polynomial-time ignore matcher, symlink-escape rejection, `OutputAccessPolicy` |
| `indexing` | 5-language orchestration (`INDEXED_ADAPTERS`), `collectInventoryAsync`, `IndexJobManager` with `worker_threads` and in-process fallback, `file_facts` early-cutoff incremental planner, build leases and orphan-build recovery, `symbol_fts` population |
| `graph` | Snapshot queries, traversal/impact/guard/compare, architecture projection and export (`snapshot` included), agent-context localization, read-only `git-read.ts` |
| `storage-sqlite` | SQLite WAL + FTS5 (`SqliteGraphRepository` + `SqliteWikiStore`); schema `user_version = 5` (`build_leases`, `file_facts`, `symbol_fts`) |
| `contracts` | Read-only contract discovery and drift classification (OpenAPI, AsyncAPI, SQL DDL, JSON Schema, Protobuf) |
| `preflight` | Candidate-only manifest + test-plan derivation; writes no code |
| `verification` | Pure `verify_change` core (4 checks, `host_asserted` test state) |
| `wiki` | GraphSnapshot → WikiSnapshot projection, FTS5 search |
| `mcp-server` | stdio transport + zero-config `--allow-cwd` / MCP `roots/list` / `--auto-data-dir` (sensitive/system root denylist) + `storage.dataDbPath` or the default `InMemoryGraphRepository` + tool profiles (11 core / 32 full) + `outputSchema` profile + `notifications/progress` + MCP `annotations` (`readOnlyHint`) |
| `causoryn` | Open-source multi-host CLI (`causoryn setup\|doctor\|mcp`) and 4-host plugin distribution package (`0.3.0`, `MIT`, `THIRD-PARTY-NOTICES.md`, zero external npm dependencies, 5 skills) |

The root manifest declares the `typescript` 5.9.3 compiler and the `esbuild` (`^0.28.2`) bundler. [Root manifest](../package.json) · [Architecture](en/architecture.md)

Three boundaries were re-checked with `grep` against the 0.3.0 tree: (1) **`domain` is a leaf** — its only import outside its own modules is `zod`; (2) `workspace` uses only `node:fs`, `node:path`, and `zod`; (3) parser detail never leaks into `mcp-server` — it imports no `@causoryn/adapter-*` package, and adapters are reached only through `@causoryn/indexing`. `verification` follows pure-function discipline: no `node:fs`, `Date.`, or `Math.random` appears in `packages/verification/src`; it never runs a test runner, and `observed` counts are accepted only from evidence.

### 4.3 Evidence model and deterministic identity

`Evidence = {id, kind, span?, analyzerId, analyzerVersion, rationale}`; `SourceSpan = {relativePath, startLine≥1, endLine≥startLine, sourceHash}`. Targets outside the inventory are rejected with `indexing/internal`. The verified-edge invariant (≥1 evidence) is enforced in **three layers**: the constructor throws `domain/verified-edge-requires-evidence`, the Zod `superRefine` rejects violations, and the repository re-validates on write; `heuristic`/`unresolved` edges may stay evidence-free by design. Snapshot invariants (dangling edges, duplicate IDs, unknown evidence) are checked in the constructor, the schema, and the repository; on write the repository re-derives every node/edge/evidence ID and rejects mismatches with `graph/*-id-mismatch` (`packages/graph/src/validation.ts:23-27`).

IDs are canonical JSON + SHA-256: node keys on `(workspaceId, kind, qualifiedName, relativePath|null)`, edge on `(workspaceId, kind, from, to)`, and evidence on `[workspaceId, kind, analyzerId, analyzerVersion, rationale, span|null]` (`packages/domain/src/ids.ts:147-161`). The snapshot ID is `snapshot:` + `SHA-256(canonical JSON([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))`; **the clock never enters an ID**, and the design note sits at `packages/domain/src/snapshot.ts:22-35`. In 0.3.0, `computeStreamingSnapshotId` (`snapshot.ts:441-468`) hashes the same canonical bytes as a stream without building one large string, so IDs did not change (older line reference: §10.4). The wall-clock timestamp travels in `meta.createdAt`. Nuance: consecutive re-index calls within the same `IndexService` process increment `revision.sequence` (`this.runCount + 1`) and yield a new `snapshotId`, whereas fresh independent runs on identical content and `sequence` yield bit-identical `snapshotId`s. Snapshots are deep-frozen with `deepFreeze` and kept in canonical ID order. An early-cutoff incremental build must produce the same snapshot ID as a clean full build of the same inputs (`tests/incremental-early-cutoff.test.ts`).

Reproducing deterministic analysis requires equivalent source content, revision identity and sequence, workspace identity, effective inventory rules, analyzer toolchains, and configuration; because the schema-versioned `analyzerFingerprint` (`ANALYZER_FINGERPRINT_SCHEMA_VERSION`, `fp3` in 0.3.0) encodes adapter versions, worker state, and option hashes, installing a missing toolchain yields a new snapshot. `fp3` (0.3.0) invalidates persisted snapshots and `file_facts` from earlier builds, because node spans and evidence text changed in 0.3.0. `meta.createdAt`, the client `requestId`, job progress, and worker availability can vary with runtime state. Some export formats include `meta.createdAt`, which is excluded from the snapshot ID. [Snapshot identity](../packages/domain/src/snapshot.ts) · [Architecture export](../packages/graph/src/architecture-export.ts) · [MCP request handling](../packages/mcp-server/src/server.ts)

### 4.4 Storage, indexing, and publish discipline

SQLite (`better-sqlite3` 13.2.0, SQLite 3.54.1) runs `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`; `symbol_fts` + `wiki_fts` FTS5 search needs no embeddings; the schema is `user_version = 5`, and v1–v4 databases upgrade to v5 in one transaction (a file with a newer schema is never written; `graph.schema-<N>.sqlite` is used instead); DDL is static literal text and data is bound as parameters. With `--auto-data-dir` / `--data-dir`, each workspace uses one file, `<base>/workspaces/<slug>-<hash12>/graph.sqlite` (+ `exports/`); the base is chosen as `--data-dir` > `~/.causoryn` for every host (`ZCODE_PLUGIN_DATA` only as a fallback when `~/.causoryn` is unusable) and is created with mode `0700`, strictly outside the authorized roots. Without a declared `storage.dataDbPath`, the server uses the process-local `InMemoryGraphRepository`. `--client` is only a diagnostic label (`build_leases.host_label`); the newest valid per-host `graph-<client>.sqlite` file written by 0.2.x is copied once into a missing `graph.sqlite`; legacy files stay in place and `causoryn doctor` lists them.

**Non-blocking indexing:** the stdio entry point defers the first index, so `initialize` and `tools/list` answer immediately. With a SQLite store, `IndexJobManager` runs the job in `worker_threads` (`index-worker-core.ts`, bundled as `dist/index-worker.mjs`); with the in-memory repository, or if the worker entry cannot be used, the same pipeline runs in-process and asynchronously. Clients that send `_meta.progressToken` receive `notifications/progress`. Tools other than `causoryn_status` wait up to `CAUSORYN_INDEX_WAIT_MS` (default 15000 ms; `0` = do not wait) for the first index, then return `status: "partial"` with `{ status: "indexing", jobId, progress, retryAfterMs }`. While a re-index runs, responses serve the latest published snapshot with a `stale=true` warning.

**Incremental indexing:** `causoryn_status` with `action: "refresh"` (`mode: "incremental" | "full"`) queues a job. Incremental runs read per-file facts from the `file_facts` table (content hash, public-interface hash, imported paths, serialized nodes/edges/evidence); only changed files, plus their direct reverse dependents when the public interface changed, are re-analyzed (early cutoff), and TypeScript reuses the previous `ts.Program` (`oldProgram`). A configuration, analyzer-fingerprint, or language-set change, a cold cache, or inconsistent facts fall back to a full build.

**Atomic publish:** a build starts as a `building` row that no read path can see and turns `ready|partial` in one SQLite transaction; `failed` builds never publish; reading an unpublished snapshot is rejected with `storage/corrupt-row`. Publishing requires the workspace's `build_leases` row (`lease_id`, `owner_pid`, `host_label`, `hostname`, `owner_instance`, `heartbeat_at`, `expires_at`; default TTL 120 s, heartbeat 10 s; PID liveness first on the same host), so two processes cannot publish at the same time; `recoverOrphanBuilds` marks `building` rows not owned by a live lease as recovered orphans. After a publish, `pruneOldSnapshots` keeps the newest 2 published snapshots and deletes orphaned `symbol_fts` rows. Warm startup reads `getLatestSnapshotMeta` instead of hydrating the full graph; the published-snapshot cache is guarded by `PRAGMA data_version` and capped by `MAX_PUBLISHED_CACHE_ENTRIES = 1` (`K-023` in `0.2.2` started with four entries).

Behavior carried over from earlier releases: since `0.2.1` the first index starts in the background after the MCP `initialized` notification, zero-config workspaces merge safe root `.gitignore` patterns into `extraIgnore`, and compatible pathless external nodes are deduplicated. `0.2.3` (`K-024`) added universal JavaScript/CommonJS (`.js`/`.jsx`/`.mjs`/`.cjs`) inside the existing `ts-adapter`, root-confined `tsconfig.json`/`jsconfig.json` loading, a zero-RegExp polynomial-time glob matcher + `.git/info/exclude`/nested `.gitignore` + smart `bin/` handling, a `collectInventoryAsync` scan that yields to the event loop every 64 entries, and the default `causoryn-architecture-interactive.html` filename. [Startup](../packages/mcp-server/src/cli-stdio.ts) · [Workspace configuration](../packages/mcp-server/src/runtime-cli.ts) · [Job manager](../packages/indexing/src/job-manager.ts) · [IndexService](../packages/indexing/src/index-service.ts) · [SQLite repository](../packages/storage-sqlite/src/sqlite-repository.ts)

## 5. MCP Tool Surface and Profiles

`tools/list` publishes only the tools of the active profile (`packages/mcp-server/src/version.ts`; profile resolution in `server.ts` `resolveProfileToolNames`); empty handlers are never published:

| Profile | Tools | Contents |
|---|---|---|
| `core` (default) | 11 | `causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation` |
| `wiki` | 18 | core + 7 `causoryn_wiki_*` (`wiki_build` is the only wiki writer; `wiki_search` uses FTS5, no embeddings) |
| `history` | 13 | core + `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `wiki,history` | 20 | Profiles combine with commas |
| `full` | 32 | 29 legacy `TOOL_NAMES` + `causoryn_status`, `causoryn_trace`, `causoryn_contracts`; superseded legacy tools carry `(Deprecated: use <replacement>)` in their description and a deprecation warning in the envelope |

Selection order is `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`; an unknown profile name stops the server at startup. `causoryn setup` registers every host with `core` (`setup --tool-profile <list>` writes another profile). `tools/list` omits `outputSchema` by default (`--output-schema omit|full`, env `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE`); the server still validates every envelope against the tool's Zod output schema. The core `tools/list` payload stays ≤ 15,000 characters (`tests/mcp-tool-surface-budget.test.ts`).

**Legacy mapping** (`DEPRECATED_TOOL_REPLACEMENTS`): `get_capabilities`, `workspace_summary`, `index_status`, `refresh_index` → `causoryn_status` (`action: "inspect" | "refresh"`); `generate_onboarding` → `causoryn_map_system` (`profile: "onboarding"`); `trace_execution`, `trace_business_flow` → `causoryn_trace`; `analyze_impact`, `derive_test_plan` → `causoryn_preflight_change` (`include`); `check_architecture` → `causoryn_verify_change` (`checks: ["architecture"]`); `check_contracts`, `detect_contract_drift` → `causoryn_contracts` (`action: "check" | "drift"`). Legacy names exist only in the `full` profile.

**Historical surface:** before 0.3.0, `tools/list` published all 29 tools; the `7+6+3+3+3+7=29` thematic grouping summarized the formal `22 core + 7 wiki = 29` catalog whose headings sat at `docs/tool-contracts.md:45, 72` in the `v0.2.0` Turkish contract page, with 3 write tools + 26 read-only tools. Those 29 names are preserved in the `full` profile today.

**Annotations:** every tool declares MCP `annotations` (`destructiveHint: false`, `openWorldHint: false`). `readOnlyHint: false` is set only on the four tools that can write to Causoryn-owned locations: `causoryn_status`, `causoryn_refresh_index` (`full`), `causoryn_export_documentation`, and `causoryn_wiki_build` (`wiki`/`full`). The `core` profile therefore has 2 write + 9 read-only tools, and `full` has 4 write + 28 read-only tools.

**Envelope**: every response is a 10-field `z.strictObject` with all fields present — `schemaVersion` (`"2.0"`), `requestId`, `workspaceId`, `snapshotId`, `status` (`ok|partial|error`), `coverage` (tier L0–L4, edge resolution counts, `coverageRatio`, optional per-language `byLanguage`), `warnings`, `data`, `nextCursor`, `error`. Errors travel *inside* the envelope (`isError=false`), never as protocol faults; stack traces never reach the client — unexpected failures return `INTERNAL_ERROR` with a generic message and `requestId`, and raw detail goes to stderr only; `AMBIGUOUS_SYMBOL` carries candidates in `data`.

**Error codes**: a fixed table of 15 codes (`CAUSORYN_TOOL_ERROR_CODES`) with deterministic `retryable` + `userAction` guidance in `TOOL_ERROR_GUIDANCE`; only `INDEX_NOT_READY` and `INTERNAL_ERROR` are retryable. `INVALID_ARGUMENT`, `EVIDENCE_NOT_FOUND`, and `SYMBOL_NOT_FOUND` are the three project extensions beyond the base catalog — `K-008` covers the first two and `K-011` records `SYMBOL_NOT_FOUND` (`packages/mcp-server/src/errors.ts:62-64`); `K-012` records that Phase C declined a fourth extension because the fixed code `EXPORT_NOT_ALLOWED` sufficed. `UNSUPPORTED_LANGUAGE` is retained from the base catalog as a **reserved fixed code** that is not thrown today, because missing or failing workers degrade via the L0/L1 adapter fallback (`errors.ts:66-68`). Some `userAction` strings still name legacy tools; in `core`, use `causoryn_status` instead.

**Write-permission matrix** — the analyzed workspace is always read-only:

| Tool | Target | Guard |
|---|---|---|
| `causoryn_status` / `causoryn_refresh_index` (`readOnlyHint: false`) | Causoryn's own graph repository only | `action: "inspect"` writes nothing; `action: "refresh"` (legacy `refresh_index`) queues an index job. The target is the in-process `InMemoryGraphRepository` when `storage.dataDbPath` is unset, otherwise that SQLite file (absolute path outside `allowRoots`). On first use the Rust worker may be compiled into the external Cargo target directory (`~/.causoryn/cache/rust-worker-target` or `CAUSORYN_RUST_TARGET_DIR`) |
| `causoryn_export_documentation` (`readOnlyHint: false`) | `output.allowedOutputDirs` | An empty list yields `EXPORT_NOT_ALLOWED`; `--auto-data-dir` adds the `exports/` directory outside the source tree. Writes are atomic (`flag: "wx"` temp file + rename). `format="snapshot"` emits canonical `architecture-snapshot.json` |
| `causoryn_wiki_build` (`readOnlyHint: false`, `wiki`/`full`) | `wiki.dataDbPath` | Absolute path required, never inside `allowRoots`; unset ⇒ `PATH_DENIED`. With `--auto-data-dir` it is the same `graph.sqlite` as the graph store. At startup `openWikiStores` initializes the workspace row in `wiki.dataDbPath` when configured |
| `causoryn_preflight_change` / `causoryn_verify_change` (`readOnlyHint: true`) | Writes nothing to disk | `candidateOnly` fixed `true`; the manifest is cached only in the in-process `PreflightManifestStore` (FIFO, 200 entries) and is lost on restart; `verify_change` indexes the working tree into a scratch in-memory repository |

Both `storage.dataDbPath` and `wiki.dataDbPath` are strictly validated at startup — absolute, no null bytes, and outside every authorized root (including drive-root boundaries, dangling symlinks, and SQLite `-wal`/`-shm`/`-journal` sidecars); violations stop the server with `CausorynConfigError` rather than continuing silently.

**Architecture exports.** `view="architecture"` produces a JSON blueprint, grouped Mermaid, a Markdown brief, or script-free (`default-src 'none'`) offline HTML with layered SVG. `view="interactive"` adds offline search, zoom, and an evidence inspector for HTML; its embedded script runs under a `script-src 'sha256-<hash>'` CSP (no `'unsafe-inline'` script permission). `view="full"` preserves the raw graph export. `format="snapshot"` emits a raw `CompareContentSet` with the default or `full` view. `view="wiki"` and invalid combinations of view, format, and annotations yield `INVALID_ARGUMENT`. `options` and `annotations` apply to the `architecture` and `interactive` views. With no annotations, the engine derives the output from the graph. For supplied annotations, schema limits and references (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`) are validated; that check covers references and structure, and the accuracy of the external narrative depends on its author. Matching snapshot, format, view, options, and valid annotations produce matching export bytes. [Tool contract](en/tool-contracts.md) · [Export tests](../packages/graph/test/architecture-export.test.ts)

**Pagination and limits**: cursors are opaque, versioned offsets (`{v:1,o:<int>}`, base64url-encoded); undecodable, tampered, or old-format cursors return `INVALID_ARGUMENT`; `nextCursor` is `null` on the last page. Limits: `results.maxNodes` 250, `results.maxSymbols` 100, `results.maxDepth` 3, `results.maxPaths` 50, `index.maxFiles` 50,000, `maxFileBytes` 2,000,000; wiki tools default to 50 with a 200 cap (`K-013`); breaches raise `LIMIT_EXCEEDED`. `causoryn_trace` clamps its default `maxDepth`/`maxPaths` (6 / 25) to the configured ceilings with a warning; contract tools accept at most 25 pairs or paths per list; `maxProximityDepth` caps at 4.

## 6. Language Support

### 6.1 Two axes, five adapters

"L0–L4" names two axes: (1) the **adapter capability** axis — L0 file/manifest → L4 flow/contract cross-linking; (2) the **map hierarchy** of `causoryn_map_system` — L0 Workspace/Repository/Project → L3 Function/Method/Handler/Endpoint/Test, with L4 flow maps explicitly rejected (0.3.0 source: §10.4). This section covers the first axis. TypeScript runs in-process (Compiler API: Program + AST + TypeChecker; ESM + CommonJS; monorepo workspace package resolution; CHA `INHERITS`/`IMPLEMENTS`; BDD `Test`/`TESTS` extraction); the other four languages run as sidecars over `@causoryn/sidecar-ipc`: Python on stdlib-only `ast`, Go on `go/parser` + `go/ast`, Rust on `syn` 3, C# on Roslyn (`dotnet exec`; CHA and read-only NuGet reference discovery). `INDEXED_ADAPTERS` holds 5 entries; `causoryn_status` (`data.capabilities.adapters`) and the legacy `get_capabilities` project `{language, analyzerId, version, levels}` from it. `coverage.tier` reports `L2` when TS/JS/C#/Python AST/symbol nodes exist, `L1` when only Go/Rust AST/symbol nodes exist, and `L0` otherwise; `coverage.byLanguage` gives the same calculation per language:

| Language | Engine | Resolution label | L3 routes |
|---|---|---|---|
| TypeScript / JavaScript | TS Compiler API (in-process) | L2 (TypeChecker verified) | `express+nextjs` + generic `<x>.<verb>` pattern |
| C# | Roslyn `SemanticModel` | L2 — true semantic sidecar | `aspnet-core-route-attributes (L3)`: controller `[Route]`/`[Http*]` + Minimal API `MapGet`/… |
| Python | stdlib `ast` | L2 + "no full type inference" | `decorator-route-pattern (L3)`: `@carrier.get/…` + Flask `route` |
| Go | stdlib `go/parser` | "heuristic-only (no semantic L2)", `symbolResolution: false` | `http-router-registration (L3)`: Handle/HandleFunc + chi/gin/echo |
| Rust | `syn` 3 | "heuristic-heavy" | `attribute-macro-route (L3)`: attribute-macro verbs + axum/actix/rocket |

C#'s L3 surface is declared as `frameworkLinkers: "aspnet-core-route-attributes (L3)"` (`packages/indexing/src/index.ts:205`, `K-022`); the worker-internal capability label is `aspnetcore-controller-attribute-and-minimal-api-call-pattern` (`native/roslyn-worker/Protocol.cs:234`). The Go label `heuristic-only (no semantic L2)` is the literal runtime string ("no semantic L2").

### 6.2 Resolution honesty per language

Labels are fixed per language (`K-018`; details in [language analyzers](en/language-analyzers.md)): **TypeScript** — calls, imports, and inheritance that the TypeChecker resolves to an analyzed symbol are `verified`; relative module candidates or `node:*` builtins are `heuristic`; no resolved symbol means `unresolved`. **C#** — every call and `BaseType`/`Interfaces` resolved by the `SemanticModel` is `verified`; the known-name rule is `heuristic` when reference assemblies are missing. **Python** — `verified` only for the same module (including `self.<m>` and `Class.<m>`); imported symbols are `heuristic` + ambiguity; locals, builtins, and undefined names are `unresolved` → `UnknownExternal`. **Go** — packages are keyed by **directory**; `verified` covers same-package bare identifiers and `pkg.Func()` calls that resolve through the `go.mod` module path to exactly one package (local-variable shadowing cannot be distinguished from the AST — documented); without `go.mod`, directory-suffix/package-name matches, unique method names, and interface methods are `heuristic`; builtins produce no edge. **Rust** — only bare `fn` calls in the same module are `verified`; a qualified path (`Type::method`, `mod::fn`) with a single match on its last two segments is `heuristic` with the `unverified-module-prefix-suffix-match` ambiguity; method calls are `heuristic` (no trait dispatch). `native/rust-worker/src/analyzer.rs` is authoritative; the unit test `two_segment_suffix_match_emits_heuristic_with_explicit_ambiguity_never_verified` pins the rule.

`ROUTES_TO` edges are `verified` + evidenced in **TypeScript, Python, and Rust**; in **C#**, `ROUTES_TO` is `verified` when the semantic model resolves controller attribute types or Minimal API extension methods to `Microsoft.AspNetCore.*`, and falls back to `heuristic` (+ `ambiguity`) under known-name matching (`native/roslyn-worker/WorkerAnalyzer.cs:1475-1508`, which in 0.3.0 is the Minimal API semantic gate; the controller decision is at `WorkerAnalyzer.cs:1692-1728`); in **Go**, `ROUTES_TO` is `verified` for same-package handler functions, follows the `CALLS` table for selector handlers (`heuristic` or `unresolved`), is `unresolved` (`UnknownExternal`) for undefined bare handler names, and is omitted (Endpoint kept) for inline `func` literals (`native/go-worker/internal/analyze/routes.go:120-170`, plus `:106-111`).

Nuance: the sidecar worker protocol output defines `coverageRatio` as `verified / total` edges (16/25 = 0.64 in the Python fixture), whereas the MCP envelope `coverage.coverageRatio` computes `(verified + heuristic) / totalEdges`.

### 6.3 Degradation never kills the engine

There are three levels: (1) **adapter** — the same fallback in all 4 sidecars: `workerAvailable:false`, `state:"partial"`, `coverageRatio:0`, source-hashed File nodes kept, capabilities false, an explicit warning, and a lower tier in `coverage.byLanguage`. (2) **toolchain** — spawns use a fixed command, fixed arguments, and an environment allowlist, and run from Causoryn's trusted worker directory rather than the analyzed repository: for Python, the `python` command with the fixed arguments `-I -B -X utf8 <script>` (isolated mode: `PYTHON*` environment variables are ignored and the script directory is not added to `sys.path`; `-B` disables `__pycache__` writes; `PYTHONPATH` is not forwarded); Go `go run ./cmd/worker` or `CAUSORYN_GO_WORKER_BIN` (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; 120 s timeout); Rust literal `cargo build --locked` (`adapters/rust/src/cargo.ts`; `CARGO_BUILD_RUSTC_WRAPPER=""`, external target directory, SHA-256-pinned binary; 600 s cold build); C# `dotnet exec` (`DOTNET_STARTUP_HOOKS=""`). (3) **file/pipeline** — a SyntaxError is a diagnostic, not a failure: `partial` plus a file/line diagnostic, while healthy files keep their graph.

Historical live evidence (2026-11-16 analysis session, not re-run on 0.3.0): broken.py + ok.py → exit 0, `partial`, `diagnostics[{code:"SyntaxError",line:1}]`; the first run of `npx vitest run packages/indexing/test/index-service-multilang.test.ts` hit `spawn dotnet ENOENT` → the C# adapter fell to L0/L1, the other four languages produced full layers, the snapshot published as `partial`, and the engine stayed up; with PATH fixed it went 9/9 (55.97 s).

### 6.4 Worked example: hand it a Python project

A user binds `examples/fixture-python-app` (three files) as an authorized root and calls `causoryn_status` with `action: "refresh"` (legacy name `causoryn_refresh_index`). Flow: WorkspaceAccessPolicy authorizes → inventory → adapter worker spawn → stdlib `ast` parse → merge into one build → `ready` publish. The result below is a live run dated 2026-11-16; at that time the worker was started with `python -B native/python-worker/worker.py` (in 0.3.0 the arguments are `-I -B -X utf8`). The figures match the multi-language expansion record in [implementation status](en/implementation-status.md) digit for digit:

- **exit 0, ready** — 21 nodes (3 File / 1 Class / 8 Function / 2 Method / 2 Endpoint / 5 UnknownExternal), 25 edges (11 CONTAINS verified, 3 CALLS verified, 4 CALLS heuristic, 5 CALLS unresolved, 2 ROUTES_TO verified), worker `coverageRatio` 0.64.
- `@app.get("/x")` → Endpoint + verified ROUTES_TO; same-module `helper()` → verified CALLS; imported `utils.run()` → heuristic + ambiguity; an unknown name → UnknownExternal + unresolved — never a fabricated target.
- The host model reads context with `causoryn_find_symbols` / `causoryn_get_symbol_context` and the span + `sourceHash` chain with `causoryn_get_evidence`.
- Without Python: the spawn fails → L0/L1 fallback, `partial` publish with source-hashed File nodes + a warning; the graph is not empty, but there is no symbol layer — the engine does not crash.

## 7. Security Model

The runtime has no LLM or embedding dependency. Source analysis is read-only; data stores and exports have separate write policies. Stdout carries only MCP protocol messages and diagnostics go to stderr. Every published tool must have a working handler.

**WorkspaceAccessPolicy** runs after a lexical UNC/device-path pre-check (`\\host\share`, `//host/share`, `\\?\…`, `\\.\…` are rejected before any filesystem call) and applies a fixed six-step decision order: (1) root authorization against config-declared allowRoots only, realpath canonicalized (an MCP request cannot add a root); (2) null-byte rejection; (3) lexical `..`/absolute-path rejection; (4) ignore rules including ancestors; (5) realpath symlink/junction escape rejection (CWE-59); (5b) ignore rules re-applied to the canonical path so a symlink cannot bypass the secret-deny list; (6) extension filter + `maxFileBytes`. On zero-config CLI/IDE flows (`--allow-cwd` and MCP `roots/list`), `inspectProjectRootSafety` adds a defense-in-depth denylist that rejects filesystem roots, `$HOME` and its ancestors (`C:\Users`, `/home`, `/Users`), Causoryn data/plugin install directories (`~/.causoryn`, `_npx`, `node_modules`), sensitive user directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), OS system directories (`/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/bin`, `/sbin`, `/lib`, `/dev`, Windows system locations), and the bare `/tmp` and `/var` roots as project roots; `--auto-data-dir` provisions `0700` storage strictly outside authorized roots with dangling-symlink (CWE-59) checks. When the user declares `output.allowedOutputDirs` explicitly, export authorization is governed by that list and realpath containment (`packages/workspace/src/output-policy.ts:11-48`).

**Toolchain isolation and supply chain:** the 4 sidecar workers start with a fixed command, fixed arguments, and an environment allowlist, with no shell interpolation (`packages/sidecar-ipc/src/index.ts`, `adapters/*/src/worker-process.ts`, `adapters/rust/src/cargo.ts`). `packages/graph/src/git-read.ts` applies `execFile` + `shell: false`, a subcommand allowlist (`cat-file`, `ls-tree`, constrained `rev-parse`), a 10-key minimal env allowlist (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<null device>`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, …), pre-subcommand `-c` overrides (`core.fsmonitor=false`, `core.sshCommand=false`, `protocol.allow=never`, …), and `O_NOFOLLOW` + post-open `dev`/`ino` TOCTOU verification on working-tree blobs; `HEAD~N`/`HEAD^` are resolved with `rev-parse --verify --end-of-options`. CLI launchers enforce a pre-import Node `>=24` guard (`node-version-guard.mjs`) and an `--expected-version` pin (`plugin-mcp-launcher.mjs`); the Roslyn worker is built with deterministic Release flags (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`), so no local PDB path leaks into the DLL. `causoryn_verify_change` reads architecture rules from the trusted Git `baseRef`; if it has to fall back to the working tree, it adds the `architecture-rules-loaded-from-untrusted-working-tree` warning.

The packaged-bundle threat matrix is recorded as **9/9 PASS**: symlink/path traversal, secret leakage, TOCTOU, poisoned source comments, oversized files, malicious Git refs, network denied, offline HTML XSS/CSP, stdout discipline ([security audit](en/security-pass.md)). Latest run (2026-11-24): `npx vitest run tests/security-release/ tests/toolchain-isolation.test.ts tests/git-read.test.ts tests/path-safety.test.ts` → 6 files, 58 tests passed (`tests/security-release/` 36/36). Production sources, docs, and workflows are scanned by `npm run secret-scan` (`scripts/secret-scan.mjs`, **13** directory roots + 13 root text files); the `K-022` release-preparation run of `npm audit` reported **0** vulnerabilities, and CI runs `npm audit --audit-level=high` on every run.

## 8. Quality and Tests

The default Vitest configuration covers 120 tracked test files; `tests/bench-release/benchmark.test.ts` runs separately (121 Vitest test files total). The root package defines `test`, `test:watch`, `bench`, `build`, `build:package`, `typecheck`, `lint`, and `secret-scan`. The repository defines 5 SHA-pinned workflows: `.github/workflows/ci.yml` (`ubuntu-latest` + `windows-latest` + `macos-26-intel` merge gate, nightly arm64 `macos-26`, 5 language toolchains, `-p:RestoreLockedMode=true`, `cargo build --locked`, `export-public-tree.mjs --verify-temp --ref HEAD`), `security.yml` (`zizmor`, PR `dependency-review`, npm + NuGet audits), 5-language `codeql.yml`, OpenSSF `scorecard.yml`, and the 3-job `release.yml` (`verify-and-test` → `build-and-pack` → `publish`; the 2-job SLSA split introduced in `K-025` became three jobs in 0.3.0); every Linux job runs `step-security/harden-runner`. A 4-ecosystem, 7-day-cooldown `.github/dependabot.yml` is pinned by `tests/ci-workflow.test.ts`. [Test configuration](../vitest.config.ts) · [Package scripts](../package.json) · [Implementation status](en/implementation-status.md)

The table below lists recorded run results; they were not re-run while this page was updated:

| Gate | Command | Recorded result |
|---|---|---|
| typecheck | `npm run typecheck` | exit 0 (earlier release preparation) |
| build | `npm run build` | exit 0 (earlier release preparation) |
| lint | `npm run lint` | exit 0, zero violations (earlier release preparation) |
| secret-scan | `npm run secret-scan` | exit 0 (`scripts/secret-scan.mjs`, every tracked and untracked-not-ignored file, 0 matches) |
| security | `npx vitest run tests/security-release/` | 36/36 (including 2026-11-24) |
| benchmark | `npm run bench` | 2026-11-10: 8/8; medians 11.8/13.0/10.7 ms, cold index 16370.3 ms; targets are reference baselines ([benchmarks](en/benchmarks.md)) |
| npm audit | `npm audit --json` | **0 vulnerabilities** in the `K-022` run (after upgrading to `eslint@10.15.0` and `typescript-eslint@8.73.0`) |

To address observed load-sensitive `ENOENT` and timeouts, `K-022` switched `build-bundle.mjs` to atomic writes and added explicit 20-second timeouts to selected subprocess tests. The bundle is deliberately multi-file because the `better-sqlite3` native addon cannot be inlined into JavaScript; a 36-entry `dist/bundle-manifest.json` records each file's SHA-256. `.github/workflows/release.yml` generates `SHA256SUMS.txt` and a CycloneDX 1.5 SBOM, attests build provenance, and publishes via tokenless npm OIDC (`npm publish --provenance --access public`).

Known limits (0.3.0): Antigravity `agy` CLI install/smoke NOT RUN (the direct `stdio` handshake is verified by an automated test); ZCode desktop GUI install NOT RUN; 3-OS CI passes, but live macOS/ARM64 host CLI/GUI smoke remains an open gate; MCP SDK 1.32.2 (v1.x); no Live Architecture watcher MCP surface (`file_facts` early cutoff and `oldProgram` reuse exist; `refresh_index mode=incremental`, enabled in `K-020`, is now `causoryn_status` `action: "refresh"`); shared-database coordination is Partial (only single-writer publishing and orphan recovery are claimed); rate limiting out of scope (`K-010`); no real-browser visualizer run; the bare `packages/mcp-server/dist/` bundle lacks `.d.ts` files (the `packages/causoryn` `K-021` distribution stages `dist/typescript-lib/lib*.d.ts` and reaches the `ready` state).

## 9. Decision Records (selected)

Decision records live in the project's internal decision register; the selection below summarizes the decisions that shape the product. Process and methodology decisions (`K-001`–`K-007`) are outside the scope of this overview.

| ID | Decision |
|---|---|
| K-008/K-011 | Error-code extensions `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND` (`K-008`) and the third extension `SYMBOL_NOT_FOUND` (`K-011`) |
| K-009/K-010 | MCP SDK divergence accepted (1.32.2, v1.x; the v2 upgrade is a 1.0.0 gate); rate-limit/concurrency out of scope |
| K-012 | Phase C declined a fourth extension — the existing fixed code `EXPORT_NOT_ALLOWED` sufficed, so no fourth extension was minted |
| K-013/K-014 | Wiki questions fixed: opaque cursor 50/200; broken links preserved as `WikiLink` data + `brokenLinkDiagnostics`, not errors |
| K-015/K-016 | `CONTRACT_PARSE_FAILED` first use; SQL RENAME → `unknown`; deterministic `verify_change` verdict chain (`no_findings` / `review_required` / `blocking_findings` / `inconclusive`); "passed count = host claim, core reads no files" |
| K-017 | **0.1.0 public snapshot, explicitly not 1.0.0**; bundle honestly "mcp-server.mjs + vendored better-sqlite3", not single-file; `TOOL_NAMES` locked at 29 (in 0.3.0 those 29 names are preserved in the `full` profile) |
| K-018 | Per-language resolution labels fixed by `PROTOCOL.md` tables; two inaccurate claims (Go qualified calls = verified; Rust wholly heuristic) corrected against the code on disk |
| K-019/K-020/K-021 | Audit remediations (`ROUTES_TO` 5-language fidelity, Antigravity `mcp_config.json` + bundle staging, MCP `annotations`) + Pre-1.0 engineering improvements (`storage.dataDbPath` SQLite persistence + `symbol_fts` `fts` leg, `refresh_index mode=incremental`, TS `Test`/`TESTS`, `export_documentation format=snapshot`, `@causoryn/sidecar-ipc`, GitHub Actions CI) + open-source multi-host distribution (`packages/causoryn`, `npx causoryn setup`, `causoryn doctor`, 4-host marketplace manifests, `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, `dist/typescript-lib/lib*.d.ts`) |
| K-022 | **0.2.0 Pre-1.0**: public tree export, MIT and third-party notices, SHA-pinned CI on three operating systems, OIDC release and SBOM |
| K-023 | **0.2.2**: visual architecture projection, offline HTML/SVG portal, optional reference-checked host annotations, the `architecture-blueprint` skill, and the `PRAGMA data_version` cache |
| K-024 | **0.2.3**: universal JS/CJS (`.js`/`.jsx`/`.mjs`/`.cjs`, CommonJS), root-confined `tsconfig.json`/`jsconfig.json` loader, zero-RegExp polynomial-time glob + smart ignore/`bin/`, `collectInventoryAsync`, and the default `causoryn-architecture-interactive.html` |
| K-025 | **0.2.4**: CI/CD & supply-chain hardening: `zizmor`, 5-language `CodeQL`, OpenSSF `Scorecard`, 2-job SLSA `release.yml`, Linux `step-security/harden-runner`, `-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp`, and a 7-day Dependabot cooldown (`tests/ci-workflow.test.ts`) |
| K-026 | **0.2.4**: bilingual natural-language skill triggering, MCP Zod `.describe()` schema docs on `causoryn_export_documentation`, and the 17-pair Diátaxis TR/EN documentation overhaul |
| 0.3.0 | Default 11-tool `core` profile plus the `wiki`/`history`/`full` profiles, `tools/list` without `outputSchema` by default, one shared `graph.sqlite` per workspace + `build_leases`, `worker_threads` indexing, `file_facts` early cutoff, toolchain isolation, and UNC/device-path rejection ([release notes](../CHANGELOG.md)) |

## 10. Status and Version

### 10.1 Release line

The changelog dates **0.3.0 Pre-1.0** to 2026-11-24; `1.0.0` is not declared. The minor version was bumped because the default tool surface changed in a breaking way (29 tools → the 11-tool `core` profile).

| Version | Date | Highlights | Record |
|---|---|---|---|
| `v0.1.0` | 2026-11-09 | First public snapshot with 29 tools; historical tag frozen at `4c9c188` (`4c9c188f`) | `K-017` |
| — | — | Earlier base `d197f21` after the multi-language expansion with the Python/Go/Rust sidecars | `K-018` |
| `0.2.0` | 2026-11-20 | Open-source release governance | `K-022` |
| `0.2.1` | 2026-11-22 | Background first index, `.gitignore` merge, batched SQLite writes | — |
| `0.2.2` | 2026-11-22 | Visual architecture portals | `K-023` |
| `0.2.3` | 2026-11-23 | Universal JS/CJS, confined config, non-blocking inventory | `K-024` |
| `0.2.4` | 2026-11-24 | Supply-chain hardening; natural-language skills + bilingual docs | `K-025`, `K-026` |
| `0.3.0` | 2026-11-24 | Tool profiles, shared index, `worker_threads`, `file_facts` | [CHANGELOG](../CHANGELOG.md) |

The `wiki/index.md:5-28` map of the non-public project wiki holds the internal links to this history; the wiki directory is not part of the open-source tree. [Changelog](../CHANGELOG.md) · [Implementation status](en/implementation-status.md)

### 10.2 Host support

The live host CLI runs were recorded before 0.3.0, against the 29-tool catalog ([compatibility matrix](en/compatibility-matrix.md)): Claude Code ✔ real end-to-end handshake (CLI 2.1.322 on 2026-11-10; on 2026-11-19 with 2.1.328, `plugin validate --strict` + `claude mcp list → ✔ Connected`); Codex ✔ add→list→remove (CLI 0.163.0 and 0.169.0; `codex mcp list` performs no health check — a registration-level smoke); ZCode ⚠ manifest and isolated CLI validation (desktop GUI install `NOT RUN`); Antigravity ❌ `agy` CLI install/smoke **NOT RUN** (no `agy` binary on the verification machine). `integrations/antigravity/causoryn/` ships `plugin.json` (`$schema`-free for the local loader), `mcp_config.json` (primary local loader config), `mcp.json` (portable manifest), `README.md`, and the deterministically `build:bundle`-staged `scripts/mcp-server.mjs` + `scripts/index-worker.mjs` (+ vendored `better-sqlite3`); the direct `stdio` handshake in `antigravity-plugin.test.ts` listed 29 tools before 0.3.0 and lists the 11 core tools in 0.3.0. Net CLI host runs: **2/3 real runs, 1/3 open**. The 0.3.0 profile behavior has not been re-run on the live host CLIs; automated tests cover it (`tests/mcp-tool-surface-budget.test.ts`, `tests/open-source-distribution.test.ts`, `packages/mcp-server/test/stdio-stdout.test.ts`). Every host runs the same `causoryn@0.3.2` engine (`dist/mcp-server.mjs` + `dist/index-worker.mjs` + vendored `better-sqlite3`); host guides live in `docs/hosts/`, `integrations/zcode/`, and `integrations/antigravity/`.

### 10.3 Remaining 1.0.0 gates

The same list as `CHANGELOG.md` `[Unreleased]` and [implementation status](en/implementation-status.md): (1) live Antigravity `agy` CLI install + smoke; (2) ZCode desktop GUI install + `tools/list` smoke; (3) live macOS / Linux / ARM64 host smoke; (4) MCP TypeScript SDK v1.x (`^1.32.2`) → v2 (closes `K-009`); (5) Live Architecture watcher MCP surface (Partial); (6) C#/Python/Go/Rust `Test`/`TESTS` extraction (`adapters/typescript` production enabled in `K-020`); (7) OpenAPI response-schema drift + event-version rule + SQL `RENAME` classification; (8) a read-only snapshot revision workflow that never writes into analyzed workspaces (the `export_documentation format=snapshot` producer was added in `K-020`; the MCP history tools analyze other commits read-only from their git objects; project/build inputs (C# project files, installed packages) still come from the working tree); (9) `wiki_search` filters + `WIKI_NOTE_CONFLICT` guidance + a narrower incremental wiki publish; (10) real-browser acceptance of the offline interactive HTML portal and `apps/visualizer`; (11) a default-lib (`.d.ts`) decision for the bare monorepo bundle; (12) a rate-limit budget across concurrent MCP requests (`K-010`). Already closed: the `scripts/secret-scan.mjs` gate (13 roots) and `npm audit` with 0 vulnerabilities (`K-022`). Until these close, 1.0.0 will not be declared.

### 10.4 Line references (historical comparison)

Line numbers drift as code changes. The references below come from 0.2.x-dated records and are kept for record integrity; each lists the tag where it was exact and its 0.3.0 counterpart:

- `packages/mcp-server/src/services.ts:698-716, 765-771` — the `map_system` map hierarchy (`MapSystemInputSchema`, `MAP_LEVEL_KINDS`) and L4 rejection in `v0.2.0`. In 0.3.0 the same code is at `services.ts:968-988, 1037-1043`.
- `packages/domain/src/snapshot.ts:379-397` — the snapshot ID formula in `v0.2.4`. In 0.3.0 this range holds the canonical edge/evidence JSON projections that feed the hash; the ID is computed in `computeStreamingSnapshotId` (`snapshot.ts:441-468`).
- `native/roslyn-worker/WorkerAnalyzer.cs:1475-1508` — the C# controller-attribute decision in `v0.2.4`. In 0.3.0 this range shows the Minimal API semantic gate; the controller-attribute decision is at `WorkerAnalyzer.cs:1692-1728`.
- `docs/tool-contracts.md:45, 72` — the `v0.2.0` Turkish catalog headings (`22 core + 7 wiki`). In 0.3.0 the page is reorganized by profile.
- `wiki/index.md:5-28` — the non-public project wiki map; it cannot be verified in the open-source tree.

[Implementation status](en/implementation-status.md) records historical acceptance evidence and open work, the [compatibility matrix](en/compatibility-matrix.md) shows the evidence available for each host, and the [engineering backlog](en/BACKLOG.md) carries the closure criteria for each gate. Quick start: [5-minute tutorial](en/tutorial-5-minutes.md).
