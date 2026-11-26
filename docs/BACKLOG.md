# Teknik Backlog — Faz Sıralaması ve Açık `1.0.0` Kapıları

> **Dil / Language:** **Türkçe** | [English](en/BACKLOG.md) · [Dokümantasyon Merkezi](README.md)

> **Durum:** Causoryn 0.3.2'i yansıtır (11 araçlık varsayılan `core` araç profili). `1.0.0` ilan edilmemiştir.

Bu sayfa; özgün teslim fazlarının bağımlılık sırasını, o plandan sonra teslim edilenleri, kapanış koşullarıyla birlikte açık `1.0.0` sürüm kapılarını ve 1.0 sonrası adayları kaydeder. Her durumun kanıtı [Uygulama Durumu](implementation-status.md) belgesindedir; sürüm notları [CHANGELOG.md](../CHANGELOG.md) içindedir. Çalışmayan hiçbir şey `Done` olarak işaretlenmez.

## 1. Teslim Fazları ve Güncel Durum

| Sıra | Faz | Issue | Bağlı olduğu | Ana bileşenler | Kabul kapısı | 0.3.0 durumu |
|---|---|---|---|---|---|---|
| 0 | **Temel (Foundation)** | *(doğrudan teslim edildi)* | — | `packages/domain`, `packages/workspace`, `packages/indexing`, `packages/graph`, `packages/storage-sqlite`, `packages/mcp-server`, `adapters/typescript` | Gerçek araç çağrıları, fixture golden dosyaları, güvenlik testleri | **Done** (11/11, PR #7) |
| 1 | **Derin eşleme (Deep mapping)** | [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Temel (sert) | `native/roslyn-worker/`, `adapters/csharp-roslyn/`, `packages/indexing`, `packages/graph`, `packages/mcp-server` | C# + TypeScript sınır ötesi (cross-boundary) kanıt zinciri | **7/8 Done · Live Architecture watcher Partial** (dosya bazlı yeniden kullanım 0.3.0'da `file_facts` ile geldi; watcher hâlâ bir MCP yüzeyi değil) |
| 2 | **Mimari zekâ (Architecture intelligence)** | [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Temel + Derin eşleme (sert); Living Wiki ve sözleşmeler (yumuşak, temiz biçimde degrade olur) | `packages/graph`, `packages/mcp-server`, `packages/workspace` (`OutputAccessPolicy`) | Gerçek fixture'lar üzerinde mimari ve değişiklik zekâsı özellikleri | **Done** (PR #9) |
| 3 | **Living Wiki** | [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Temel (sert); Derin eşleme (önerilen sıra, sert değil) | `packages/wiki`, `packages/storage-sqlite`, `packages/mcp-server` | 7 wiki aracı canlı test edildi; manuel notlar iki yeniden indekslemeden sağ çıkar | **Done** (8/8, PR #10) |
| 4 | **Sözleşmeler, preflight ve iş akışı** | [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Temel + Derin eşleme + Mimari zekâ (sert); Living Wiki (yumuşak) | `packages/contracts`, `packages/preflight`, `packages/indexing`, `packages/mcp-server` | Sözleşme/drift fixture'ları ve yalnızca aday üreten (candidate-only) preflight | **Done** (PR #11) |
| 5 | **Ajan değişiklik koruması (Agent change guard)** | [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Yukarıdakilerin tümü; preflight manifestine (`preflightId`) **sert** bağımlılık; Living Wiki (yumuşak) | `packages/verification`, `apps/visualizer`, `packages/mcp-server` | Bayt düzeyinde deterministik `verify_change`; testlerin koştuğunu asla iddia etmez | **Done** (PR #12) |
| 6 | **Cross-host sürüm (Cross-host release)** | [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Önceki tüm fazlar (kapı: tüm modüller ve Living Wiki Done) | `packages/mcp-server` (esbuild bundle), `integrations/*`, `docs/` | Sürüm güvenlik ve benchmark matrisi, changelog, sürüm kararı | **Done** (PR #13 → `v0.1.0` snapshot `4c9c188`; Antigravity `agy` CLI `NOT RUN`) |

## 2. Bağımlılık Grafiği ve Sıralama Gerekçesi

```text
Temel (Foundation)
└─► Derin eşleme (#1)                       ← yalnızca Temel'e sert bağımlı
    └─► Mimari zekâ (#2)                    ← Temel + Derin eşleme; etki analizi preflight'ı besler
        └─► Living Wiki (#3)                ← yalnızca Temel'e sert bağımlı; dikey dilimden sonra sıralandı
            └─► Sözleşmeler ve preflight (#4)  ← rota kenarları + etki analizi; iç sıra: keşif → uyumluluk → drift → iş akışı → test planı → preflight manifesti
                └─► Ajan değişiklik koruması (#5) ← preflight kimliği SERT bağımlılıktır
                    └─► Cross-host sürüm (#6)     ← önceki tüm fazlar
```

Sert bağımlılık omurgası: **Temel → Derin eşleme → Mimari zekâ → Sözleşmeler ve preflight → Ajan değişiklik koruması → Cross-host sürüm**. Living Wiki kesin olarak yalnızca Temel'e bağlıdır.

1. **Önce Temel:** her faz `GraphSnapshot`, `WorkspaceAccessPolicy` ve MCP stdio envelope'u üzerine kurulur.
2. **İkinci olarak Derin eşleme:** Roslyn (C#) ve framework `Endpoint` kenarları olmadan sözleşme keşfi ile iş akışı izlemenin rota çapası yoktur ve etki analizi API sınırlarını kaçırır.
3. **Üçüncü olarak Mimari zekâ:** Architecture Guard, diff/timeline, ajan bağlamı, onboarding ve deterministik dışa aktarımlar grafın üzerinde değer üretir; etki analizi de preflight manifestini besler.
4. **Dördüncü olarak Living Wiki:** projeksiyon yalnızca `GraphSnapshot` ve SQLite gerektirir; derin eşlemeden sonraya konması önce dikey dilim önceliğini yansıtır (iptal değil, erteleme).
5. **Beşinci olarak Sözleşmeler ve preflight:** preflight manifesti etki adaylarını, sözleşme denetimlerini ve bir test planı kimliğini birleştirir.
6. **Altıncı olarak Ajan değişiklik koruması:** `causoryn_verify_change` bir `preflightId` gerektirir; yalnızca `causoryn_get_evidence` kanıt zinciri zenginleştirmesi bağımsız ilerleyebilirdi.
7. **En son Cross-host sürüm:** sürüm etiketlemesi dürüstlük politikasını izler — host veya sadakat kapıları açıkken `1.0.0` ilan edilmez (karar önce bir `0.1.0` kamuya açık snapshot, sonra `0.2.0`, şimdi `0.3.0` oldu).

## 3. Özgün Plandan Sonra Teslim Edilenler

| Teslim | Kapsam | Durum |
|---|---|---|
| **Çok dilli derin analiz** (PR #14) | `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), `native/rust-worker` (`syn`), `adapters/{python,go,rust}`, birleşik 5 dilli `INDEXED_ADAPTERS` | **Done** |
| **Harici denetim kapanışı** | 5 dilde `ROUTES_TO` çözümleme doğruluğu; Antigravity `$schema`'sız `plugin.json`, `mcp_config.json`, `scripts/mcp-server.mjs` sahnelemesi; yapılandırılmış MCP araç anotasyonları (`readOnlyHint`); `scripts/secret-scan.mjs` | **Done** |
| **Pre-1.0 mühendislik iyileştirmeleri** | İsteğe bağlı kalıcı SQLite deposu (`storage.dataDbPath`) + `symbol_fts` ajan bağlamı ayağı; incremental `refresh_index`; TypeScript BDD `Test` / `TESTS` çıkarımı; `export_documentation(format="snapshot")`; `@causoryn/sidecar-ipc`; GitHub Actions CI | **Done** |
| **Açık kaynak çoklu host dağıtımı** (`packages/causoryn`) | Yayımlanabilir `causoryn` npm paketi (`setup` / `doctor` / `mcp`), 4 host pazaryeri manifesti ve kanonik `skills/`, sıfır ayarlı `--allow-cwd` + MCP `roots/list` + `--auto-data-dir`, pakete dahil `dist/typescript-lib/lib*.d.ts` | **Done** |
| **Açık kaynak yönetişimi ve tedarik zinciri** (`0.2.0`) | `MIT` + `THIRD-PARTY-NOTICES.md` + `licenses/`, deterministik Release Roslyn derlemesi, yönetişim dosyaları ve şablonları, temiz kamuya açık dışa aktarıcı, SHA sabitlemeli 3-OS `ci.yml`, CycloneDX SBOM'lu OIDC `release.yml`, 13 köklü secret taraması, kök reddi listesi ve Git TOCTOU/env sertleştirmesi, `npm audit` = 0 güvenlik açığı | **Done** |
| **`0.2.1` — başlatma ve indeksleme** | MCP el sıkışmasından sonra arka plan indekslemesi, build/önbellek dışlamaları ve kök `.gitignore`, dış düğüm tekilleştirmesi, toplu SQLite transaction'ları, sınırlı iş tanıları | **Done** |
| **`0.2.2` — görsel mimari dışa aktarımları** | Katmanlı SVG, Mermaid, Markdown ve JSON görünümleri, yalnızca HTML etkileşimli portal, doğrulanan çağıran anotasyonları, `architecture-blueprint` skill'i, `PRAGMA data_version` korumalı snapshot önbelleği, sürümünü manifestten alan `doctor` | **Done** |
| **`0.2.3` — JavaScript/CommonJS ve sınırlandırılmış analiz** | `ts-adapter` içinde `.js` / `.jsx` / `.mjs` / `.cjs` + CommonJS + JavaScript Express/Next.js; köke hapsedilmiş `tsconfig.json` / `jsconfig.json`; polinom zamanlı glob eşleştirici, `.git/info/exclude`, iç içe `.gitignore`, `bin/` işleme; `collectInventoryAsync`; varsayılan `causoryn-architecture-interactive.html` | **Done** |
| **`0.2.4` — CI/CD ve tedarik zinciri sertleştirmesi** | `security.yml` (`zizmor`, `dependency-review-action`, `npm audit --audit-level=high`, kilitli modda NuGet taraması), CodeQL, OpenSSF Scorecard, provenance'lı release hattı, `-p:RestoreLockedMode=true`, `export-public-tree.mjs --verify-temp --ref HEAD`, 7 günlük Dependabot soğuma süresi, `tests/ci-workflow.test.ts` | **Done** |
| **`0.2.4` — skill'ler ve dokümantasyon** | İki dilli doğal dil skill tetikleyicileri, `causoryn_export_documentation` üzerinde Zod `.describe()` belgeleri, [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md) dahil TR/EN dokümantasyon merkezi, deterministik vs. anotasyonlu prompt örnekleri | **Done** |
| **`0.3.0` — yalın MCP yüzeyi** | 11 araçlık `core` varsayılanı, `wiki` / `history` / `full` profilleri (`--tool-profile`, `CAUSORYN_TOOL_PROFILE`, `CAUSORYN_CONFIG.toolProfile`, `causoryn setup --tool-profile`), birleştirilmiş `causoryn_status` / `causoryn_trace` / `causoryn_contracts`, varsayılan olarak çıkarılan `outputSchema`, İngilizce araç açıklamaları | **Done** |
| **`0.3.0` — çalışma zamanı** | İlerleme bildirimleri ve sınırlı ilk indeks beklemesiyle `worker_threads` indekslemesi; dosya bazlı `file_facts` erken kesmesi ve TypeScript `oldProgram` yeniden kullanımı; akışlı (streaming) snapshot kimlikleri, hafif sıcak açılış ve snapshot saklama | **Done** |
| **`0.3.0` — paylaşımlı workspace veritabanı** | Tüm host'lar için (ZCode dahil) workspace başına tek `graph.sqlite`, host/PID canlılıklı `build_leases` ile tek yazıcılı yayımlama, canlı bir eşin build'ini bekleme ve yeniden kullanma, dürüst iş durumları (`reused`, `outcome`, `published`), sahipsiz `building` kurtarması, daha yeni şema korumalı şema v5, eski `graph-<client>.sqlite` dosyalarının tek seferlik taşınması | **Done** (bkz. [Uygulama Durumu](implementation-status.md)) |
| **`0.3.0` — güvenlik sertleştirmesi** | Analiz edilen depolar için araç zinciri izolasyonu (Git, Go, Python, Roslyn, Cargo, `doctor`): workspace dışında çözümlenen mutlak çalıştırılabilirler, güvenilir çalışma dizinleri, hazırlanmış crate kopyasından Rust worker derlemesi, sertleştirilmiş salt-okunur Git; sözcüksel UNC/aygıt yolu reddi, proje kökü olarak `$HOME` ve üst dizinlerinin reddi, etkileşimli portal için SHA-256 CSP, üç işli release iş akışı | **Done** |
| **`0.3.0` — analiz doğruluğu** | Go dizin + `go.mod` paket anahtarlaması; `heuristic` etiketli Rust sonek eşleşmeleri ve `unresolved` çok adaylı çağrılar; TypeScript bildirim span'leri ve dosya başına ESM/CJS algılama (`fp3` parmak izi); `verify_change` güvenilir taban kuralları ve `host_asserted` test durumu; preflight tabanlı test planları; ajan bağlamı konumlandırma sıralaması; TypeScript monorepo workspace'leri, çağrı imzaları, TypeScript ve C# için sınıf hiyerarşisi kenarları; salt okunur NuGet keşfi; `coverage.byLanguage` | **Done** |
| **`0.3.0` — güvenilir geçmiş kaynakları** | `causoryn_compare_architecture` ve `causoryn_architecture_timeline`, yayımlanmış yerel indeksi birebir eşleştiği kanıtlanan commit için ve `working-tree` için kullanır; diğer noktalar commit'lenmiş snapshot blob'unu okur ve `snapshot-loaded-from-committed-git-blob` taşır | **Partial** (indekslenen dışındaki geçmiş revizyonlar hâlâ commit'lenmiş bir snapshot gerektirir) |
| **`0.3.0` — değerlendirme ve dokümanlar** | Gerçek depo kesinlik/duyarlılık/gecikme düzeneği (`scripts/bench/real-repo-eval.mjs`), [5 dakikalık eğitim](en/tutorial-5-minutes.md) (İngilizce), İngilizce kamuya açık dokümanlar, `CHANGELOG.md` ve CLI çıktısı | **Done** |

## 4. Açık `1.0.0` Sürüm Kapıları

| # | Kapı | Mevcut durum | Kapanış koşulu |
|---|---|---|---|
| 1 | **Antigravity `agy` CLI kurulum + smoke** | **NOT RUN** — doğrulama makinesinde `agy` ikilisi yok; doğrudan stdio el sıkışması (11 core araç) `antigravity-plugin.test.ts` ile kapsanır | `agy` CLI bulunan bir makinede `agy plugin validate --strict`, `install`, `list`, host içi araç keşfi ve temiz bir kaldırma koşmak |
| 2 | **ZCode masaüstü GUI kurulumu + `tools/list` smoke** | **Partial** — manifestler ve izole CLI yapılandırması testlerle doğrulandı | Kullanıcının onayıyla canlı bir masaüstü ZCode kurulumu ve araç keşfi smoke'u koşmak |
| 3 | **Canlı macOS / Linux / ARM64 host smoke** | **Partial** — 3-OS CI `ubuntu-latest`, `windows-latest`, Intel `macos-26-intel` üzerinde (gece koşusunda ayrıca Apple Silicon `macos-26`); canlı host koşumları yalnızca Windows x64 için mevcut ve 0.3.0 öncesine ait | macOS ve Linux (`x64` / `arm64`) üzerinde canlı CLI/masaüstü host smoke koşumlarını kaydetmek |
| 4 | **MCP TypeScript SDK v1.x → v2** | **Open** — `@modelcontextprotocol/sdk` `^1.32.2` | Kararlı v2 SDK'ya geçmek ve her araç profilini ve sözleşmeyi yeniden doğrulamak |
| 5 | **Live Architecture watcher MCP yüzeyi** | **Partial** — `file_facts` erken kesmesi ve `oldProgram` yeniden kullanımı teslim edildi; `WorkspaceWatcher` yalnızca süreç içi | Dosya sistemi watcher yaşam döngüsünü MCP üzerinden güvenli biçimde açmak |
| 6 | **Sidecar dillerinde `Test` / `TESTS` çıkarımı** (C#, Python, Go, Rust) | **Partial** — yalnızca TypeScript/JavaScript için etkin; sidecar'lar bu türleri yalnızca protokol enum'larında listeler | Roslyn, Python, Go ve Rust worker'larından `Test` düğümleri ve `TESTS` kenarları üretmek |
| 7 | **Sözleşme ve drift sadakati** | **Partial** — OpenAPI istek şemaları, SQL, AsyncAPI, JSON Schema ve Protobuf etkin | OpenAPI yanıt şeması drift'ini, olay sürümü uyumsuzluğu kuralını ve SQL `RENAME` sınıflandırmasını (bugün `unknown`) eklemek |
| 8 | **Salt okunur snapshot revizyon iş akışı** | **Partial** — `causoryn_export_documentation(format="snapshot")` yetkili çıktı dizinlerine yazar; MCP timeline/compare, yayımlanmış yerel indeksi birebir eşleştiği kanıtlanan commit ve `working-tree` için kullanır, diğer her commit'i git nesnelerinden analiz eder (salt okunur, data root altında önbellekli, çağrı başına bütçeli); commit'lenmiş `.causoryn/architecture-snapshot.json` blob'ları (güven uyarısıyla) yalnızca son yedektir | Proje ve build girdilerini (C# proje dosyaları, paket manifestleri) de commit'ten okumak; böylece commit analizi bunları çalışma ağacından almaz |
| 9 | **Living Wiki yüzeyi** | **Partial** — FTS5 arama, CAS overlay ve incremental sayfa seçimi etkin; `wiki_search` `kinds` / `scope` / `language` / `revision` / `resolution` filtrelerini bildirir ancak reddeder | Bu filtreleri kabul etmek, onaylı bir not yazma akışıyla birlikte `WIKI_NOTE_CONFLICT` kodunu MCP hata rehberliğine eklemek ve incremental link/FTS yeniden yazımlarını daraltmak |
| 10 | **Etkileşimli portal ve visualizer tarayıcı kabulü** | **Partial** — DOM ve güvenlik testleri ile SHA-256 CSP doğrulandı | Çevrimdışı etkileşimlerin gerçek tarayıcıda kabulü |
| 11 | **Çıplak monorepo bundle'ında default-lib kapsamı** | **Partial** — `packages/causoryn` `dist/typescript-lib/lib*.d.ts` dosyalarını paketler ve `state: "ready"` durumuna ulaşır; `packages/mcp-server/dist/` ulaşmaz | Default-lib `.d.ts` dosyalarını çıplak bundle'a sahnelemek ya da bu sınırı kalıcı olarak belgelemek |
| 12 | **Rate-limit / eşzamanlılık bütçesi** | **Open** — boyut, derinlik ve timeout tavanları uygulanıyor; genel bir istek eşzamanlılık sınırlayıcısı yok (history araçlarının taze commit analizlerinin kendi eşzamanlılık sınırı ve bayt/süre bütçeleri var) | MCP istekleri genelinde eşzamanlı çağrı ve kaynak bütçesi uygulamasını eklemek |

### Kapı listesi dışındaki bilinen 0.3.0 sınırları

- **Endpoint node span'leri:** Endpoint node'ları (tüm dillerde) dosya çapasını (`startLine = endLine = 1`) korur; sembol node'ları artık her dilde gerçek bildirim span'lerini taşır.
- **Host smoke güncelliği:** Claude Code ve Codex canlı CLI koşumları 0.3.0'dan önce kaydedildi; 0.3.0 araç profilleri yalnızca otomatik testlerle kapsanır ([uyumluluk matrisi](compatibility-matrix.md)).

## 5. 1.0 Sonrası Adaylar ve Küçük Teknik Borçlar

- **Go ve Rust için isteğe bağlı daha derin semantik:** `native/go-worker` içinde isteğe bağlı `go/types` çözümlemesi ve `native/rust-worker` içinde trait-dispatch çözümlemesi; kullanılamadıklarında dürüst etiketler korunur.
- **Dil başına dosya sayaçları:** durum yüklerinde `tsFileCount` yanında `csFileCount` (iş kaydında izlenir) ve Python / Go / Rust sayılarını göstermek.
- **İsteğe bağlı Antigravity plugin uzantıları:** `integrations/antigravity/causoryn/` altında `agents/`, `rules/` veya `hooks.json` (`skills/` zaten depo kökünde ve `packages/causoryn` içinde gelir).
- **İç temizlikler:** `packages/wiki/src/index.ts` içinden `overlay` re-export'u, `candidateStatuses` için bağımsız bir Zod şeması ve `guard.ts` ile `onboarding.ts` arasında tek bir yinelemeli Tarjan SCC yardımcısının paylaşılması.

## 6. GitHub Issue Referansları

| Issue | Faz |
|---|---|
| [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Derin eşleme (Deep mapping) |
| [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Mimari zekâ (özgün özellikler) |
| [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Living Wiki |
| [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Sözleşmeler, preflight ve iş akışı (farklılaşma) |
| [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Ajan değişiklik koruması (Agent change guard) |
| [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Cross-host sürüm (Cross-host release) |

## İlgili sayfalar

- [Uygulama Durumu](implementation-status.md) — faz bazlı kanıt tabloları ve 0.3.0 yetenek tablosu
- [CHANGELOG.md](../CHANGELOG.md) — sürüm notları
- [Mimari Özeti](architecture.md) — workspace paketleri ve native sidecar'lar
- [Host Uyumluluk Matrisi](compatibility-matrix.md) — host × sonuç matrisi
