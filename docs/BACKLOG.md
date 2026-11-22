# BACKLOG — Faz Bağımlılık Sıralaması ve Güncel Açık Kalemler

**Dil / Language:** Türkçe | [English](en/BACKLOG.md)

> Kanıt: `wiki/roadmap.md` (TŞ v2.1 §23–§25), `wiki/sprint-1.md` – `wiki/sprint-8.md`, `wiki/decisions.md` (`K-001`..`K-022`), [implementation-status.md](implementation-status.md) ve [CHANGELOG.md](../CHANGELOG.md) · İlk bölüm Sprint 1 Görev 11 çıktısı olan faz bağımlılık mimarisini (`#1`–`#6` GitHub issue eşlemesiyle) korur; sonraki bölümler Sprint 8 + `K-019`..`K-022` (`v0.2.0` Pre-1.0 Public Preview) teslimlerini ve `1.0.0` öncesi gerçekten açık kalan kapıları `ADR-010` dürüstlüğüyle listeler.

## 1. Tarihsel Faz → Issue Eşlemesi ve Güncel Durum

| Sıra | Faz | Issue | Bağlı olduğu fazlar | Ana bileşenler | Kabul kapısı | `v0.2.0` durumu (`ADR-010`) |
|---|---|---|---|---|---|---|
| 0 | **A — Foundation** | *Sprint 1 doğrudan teslim* | — | `packages/domain`, `packages/workspace`, `packages/indexing`, `packages/graph`, `packages/storage-sqlite`, `packages/mcp-server`, `adapters/typescript` | Gerçek araç çağrıları + fixture golden + güvenlik testleri | **Done** (11/11, PR #7) |
| 1 | **B — Deep Mapping** | [#1](https://github.com/MrBekoX/Causoryn/issues/1) | A (sert) | `native/roslyn-worker/`, `adapters/csharp-roslyn/`, `packages/indexing`, `packages/graph`, `packages/mcp-server` | C# + TS fixture cross-boundary kanıt zinciri | **7/8 Done · `B7` Partial** (PR #8 + B9 + `K-020`; per-file parse reuse ve watcher MCP yüzeyi açık) |
| 2 | **C — Original Features** | [#2](https://github.com/MrBekoX/Causoryn/issues/2) | A + B (sert); C2 + D (soft, degrade eder) | `packages/graph`, `packages/mcp-server`, `packages/workspace` (`OutputAccessPolicy`) | 10 çekirdek mimari/değişim özelliği gerçek fixture'larla | **Done** (8/8 + B9, PR #9) |
| 3 | **C2 — Living Wiki** | [#3](https://github.com/MrBekoX/Causoryn/issues/3) | A (sert); B (önerilen sıra, sert değil) | `packages/wiki`, `packages/storage-sqlite`, `packages/mcp-server` | 7 Wiki aracı gerçek testler + 2× reindex not koruma (§16A.10) | **Done** (8/8, PR #10) |
| 4 | **D — Differentiation** | [#4](https://github.com/MrBekoX/Causoryn/issues/4) | A + B + C (sert); C2 (soft) | `packages/contracts`, `packages/preflight`, `packages/indexing`, `packages/mcp-server` | Sözleşme/drift + candidate-only preflight fixture'ları | **Done** (7/7 + MCP, PR #11) |
| 5 | **E — Agent Change Guard** | [#5](https://github.com/MrBekoX/Causoryn/issues/5) | A + B + C + **D (sert — E1 `preflightId` tüketir)**; C2 (soft) | `packages/verification`, `apps/visualizer`, `packages/mcp-server` | Byte-deterministik `verify_change` + test çalıştırmama dürüstlüğü | **Done** (6/6 + 29. araç, PR #12) |
| 6 | **F — Cross-host Release** | [#6](https://github.com/MrBekoX/Causoryn/issues/6) | **A–E tamamı** (kapı: 18 modül + Wiki Done) | `packages/mcp-server` (esbuild bundle), `integrations/*`, `docs/` | Release güvenlik/benchmark matrisi + changelog + sürüm kararı | **Done** (9/9, PR #13 → `v0.1.0` snapshot `4c9c188`; F5 `agy` CLI `NOT RUN`) |

## 2. Bağımlılık Grafiği ve Sıralama Mantığı

```text
A (Foundation, Sprint 1)
└─► B (Deep Mapping)              #1   ← yalnız A'ya sert bağımlı
    └─► C (Original Features)     #2   ← A + B; C1 impact D'yi besler
        └─► C2 (Living Wiki)      #3   ← sert bağımlılığı yalnız A; sıralaması roadmap tercihi
            └─► D (Differentiation)   #4 ← B endpoint edge'leri + C impact + D1→D2→D3→D6→D4 iç sırası
                └─► E (Agent Change Guard) #5 ← D4 preflightId SERT bağımlılık
                    └─► F (Cross-host Release) #6 ← A–E tamamı + 18 modül + Wiki Done kapısı
```

Sert bağımlılık zinciri: **A → B → C → D → E → F** (`C2`'nin tek sert bağımlılığı `A`'dır).

1. **A önce:** her faz `GraphSnapshot` + `WorkspaceAccessPolicy` + MCP `stdio` zarfı üstünde durur (`Sprint 1`).
2. **B ikinci:** Roslyn (C#) ve framework `Endpoint` kenarları olmadan D'nin sözleşme keşfi (`D1`) ile iş akışı izi (`D5`) zayıf kalır; C'nin etki analizi API sınırlarını kaçırır (`B1–B8`).
3. **C üçüncü:** mimari koruma, diff/timeline, Agent GPS, onboarding ve deterministik export grafiğin üstündeki ilk kullanıcı değeridir; `C1` impact çıktısı `D4` preflight'ın girdisidir.
4. **C2 dördüncü:** Wiki projeksiyonu yalnız `GraphSnapshot` + SQLite ister; B'den sonraya alınması "çalışan dikey dilim önce" kararının parçasıdır (`K-003`, iptal değil sıralama).
5. **D beşinci:** `D4` preflight; `C1` `impactCandidates` + `D1–D3` `contractChecks` + `D6` `testPlanId` çıktılarını birleştirir (faz içi sıra: **D1 → D2 → D3 → D5 → D6 → D4**).
6. **E altıncı:** `causoryn_verify_change` (`E1`), `preflightId` sözleşmesi olmadan çalışmaz (`D → E` sert kenar; yalnız `E4` `get_evidence` zenginleştirmesi bağımsızdır).
7. **F en son:** sürüm kapısı `ADR-010` dürüstlük kuralına bağlıdır — eksik veya koşulmamış host/platform kapısı varken `1.0.0` ilan edilmez (`F9`: `0.1.0` snapshot; `K-022`: `0.2.0` Pre-1.0 Public Preview).

## 3. Plan Sonrası Teslim Edilen Genişlemeler (Sprint 8 & K-019..K-022 → `v0.2.0`)

7 sprintlik temel planın tamamlanmasının ardından aşağıdaki kapsam kalemleri teslim edilerek backlog'dan kapatılmıştır:

- **Sprint 8 — Çok-Dil Derin Analiz (`K-018`, PR #14):** `native/python-worker` (stdlib `ast`), `native/go-worker` (stdlib `go/parser`), `native/rust-worker` (`syn` 2) sidecar'ları, `adapters/{python,go,rust}` ve 5 dilli birleşik `INDEXED_ADAPTERS` hattı (**Done**).
- **K-019 — Denetim ve Anotasyon Paritesi:** 5 dilde `ROUTES_TO` resolution doğruluğu, Antigravity `$schema`'sız `plugin.json` + `mcp_config.json` + `scripts/mcp-server.mjs` sahnelemesi, 29 araçta yapısal MCP `annotations` (`readOnlyHint`) ve `scripts/secret-scan.mjs` kapısı (**Done**).
- **K-020 — Pre-1.0 Mühendislik İyileştirmeleri:** opsiyonel kalıcı `storage.dataDbPath` SQLite deposu + `symbol_fts` (`get_agent_context` `fts` ayağı), `causoryn_refresh_index(mode="incremental")`, TypeScript BDD `Test`/`TESTS` çıkarımı, `causoryn_export_documentation(format="snapshot")`, ortak `@causoryn/sidecar-ipc` paketi ve GitHub Actions CI (**Done**).
- **K-021 — Açık Kaynak Çoklu-Host Dağıtım (`packages/causoryn`):** tek `causoryn` npm paketi (`setup`/`doctor`/`mcp`), 4 host pazaryeri manifesti (Antigravity, Claude Code, Codex, ZCode/GLM) + 4 kanonik `skills/`, sıfır-ayar `--allow-cwd` + MCP `roots/list` + `--auto-data-dir` ve paketlenen `dist/typescript-lib/lib*.d.ts` (**Done**).
- **K-022 — Açık Kaynak Yayın Yönetişimi ve Tedarik Zinciri (`v0.2.0`):** `MIT` lisansı + `THIRD-PARTY-NOTICES.md` + `licenses/`, deterministik Release Roslyn derlemesi, `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `.github/*` şablonları, Seçenek 1 temiz kamuya açık dışa aktarıcı (`scripts/export-public-tree.mjs`), 40-karakter SHA-sabitli 3-OS `ci.yml` (`ubuntu`/`windows`/`macos`) + OIDC `release.yml` + 13 bileşenli CycloneDX 1.5 SBOM (`scripts/generate-sbom.mjs`), 13 köklü `secret-scan`, `runtime-cli.ts` hassas/sistem kök reddi + `git-read.ts` TOCTOU/env sertleştirmesi, atomik `build-bundle.mjs` + 20 sn spawn timeout'ları (**89 varsayılan test dosyası**, **`1600+` test**) ve `npm audit` = **0 güvenlik açığı** (**Done**).

## 4. Güncel Açık Backlog — `1.0.0` Kapıları (`ADR-010`)

Aşağıdaki kalemler [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` ile birebir hizalıdır; tamamı kapanmadan `1.0.0` yayımlanmış ilan edilmez:

| # | Açık `1.0.0` Kapısı | Mevcut Durum | Kapanış Koşulu |
|---|---|---|---|
| G1 | **Antigravity `agy` CLI kurulum + smoke** | **Not Run** (doğrudan `stdio` 29-araç el sıkışması `antigravity-plugin.test.ts` ile doğrulandı; `agy` ikilisi makinede yok) | `agy` CLI kurulu ortamda `validate --strict`, `install`, `list`, 29 araç keşfi ve temiz kaldırma kanıtı |
| G2 | **ZCode GUI kurulum + `tools/list` smoke** | **Partial (manifest-düzeyi)** (kök ve dev `marketplace.json` + `.zcode-plugin/plugin.json` şema testleriyle doğrulandı) | Kullanıcı onayıyla masaüstü ZCode GUI üzerinden kurulum + 29 araç keşfi duman testi |
| G3 | **Canlı macOS / Linux / ARM64 host smoke** | **Partial** (`.github/workflows/ci.yml` `ubuntu-latest`, `windows-latest`, `macos-latest` üzerinde tam derleme/test koşuyor) | macOS ve Linux (x64/arm64) üzerinde gerçek ajan host CLI/GUI duman koşumlarının belgelenmesi |
| G4 | **MCP SDK v1.x → v2 yükseltmesi (`K-009`)** | **Open** (`@modelcontextprotocol/sdk` `^1.32.2` v1.x hattında) | Kararlı MCP TypeScript SDK v2 sürümüne geçiş ve tüm 29 araç sözleşmesinin doğrulanması |
| G5 | **B7 Live Architecture tam kapanışı** | **Partial** (`refresh_index mode=incremental` ve in-process `watcher.ts` çalışıyor) | Değişen dosyalarda **per-file parse reuse** ve FS watcher'ın MCP kontrol yüzeyine açılması |
| G6 | **Sidecar dillerde (`C#`, `Python`, `Go`, `Rust`) `TESTS` kenarı** | **Partial** (`adapters/typescript` BDD `Test`/`TESTS` üretimi `K-020`'de açıldı) | Roslyn, Python, Go ve Rust worker'larında test fonksiyonu/özniteliği → `Test` node + `TESTS` kenarı çıkarımı |
| G7 | **Sözleşme keşfi ve drift sadakat uzantıları (`K-015`)** | **Partial** (istek şeması + SQL/AsyncAPI/JSON Schema/Protobuf aktif) | OpenAPI **yanıt-şeması** drift'i (`K-015(5)`), TŞ §11 event-versiyon kuralı (`K-015(4)`) ve SQL `RENAME` semantiği (`K-015(3)`) |
| G8 | **Snapshot revizyon iş akışı otomasyonu** | **Partial** (`export_documentation(format="snapshot")` izinli çıktı dizinine `architecture-snapshot.json` üretiyor) | `ADR-008` salt-okunur workspace sınırını ihlal etmeden git revizyon karşılaştırma akışının ergonomik otomasyonu |
| G9 | **Living Wiki yüzey boşlukları** | **Partial** (FTS5 arama, CAS overlay ve incremental sayfa seçimi çalışıyor) | `wiki_search` sorgu filtreleri (`pageKind`/`language`/…), `WIKI_NOTE_CONFLICT` `TOOL_ERROR_GUIDANCE` kaydı ve incremental link/FTS daraltması |
| G10 | **Offline visualizer tarayıcı doğrulaması & MCP yüzeyi (`E6`)** | **Partial** (`apps/visualizer` saf üreticisi DOM/statik testlerle 11/11 yeşil) | Gerçek headless/tarayıcı etkileşim koşusu ve izinli çıktı dizinine viewer HTML yazan opsiyonel MCP yüzeyi |
| G11 | **Çıplak F1 bundle `.d.ts` kapsam kararı** | **Partial** (`packages/causoryn` dağıtımında `dist/typescript-lib/lib*.d.ts` sahneleniyor ve `ready` dönüyor) | Monorepo-içi çıplak `packages/mcp-server/dist/` F1 çıktısına `.d.ts` sahneleme veya kalıcı sınır kararı |
| G12 | **Rate-limit / concurrency kaynak bütçesi (`K-010`)** | **Open** (boyut/derinlik/timeout tavanları aktif; eşzamanlı istek rate-limiter Faz A'da kapsam dışı bırakıldı) | TŞ §10/§20 eşzamanlı çağrı ve kaynak bütçesi sarmalayıcısının eklenmesi |

## 5. `1.0` Sonrası İyileştirme Adayları ve Küçük Teknik Borçlar

- **Go ve Rust için isteğe bağlı derin semantik mod (`1.0+`):** Go sidecar'ında opsiyonel `go/types` semantik çözümleme modu ve Rust sidecar'ında trait-dispatch / semantik tip çıkarımı (mevcut `PROTOCOL.md` dürüst `heuristic` etiketleri bozulmadan).
- **`index_status` çok-dilli sayaç genişletmesi:** `IndexJobRecord` / `causoryn_index_status` yüzeyinde `tsFileCount` yanında `csFileCount` ve Python/Go/Rust dosya sayaçlarının sunulması.
- **İsteğe bağlı Antigravity eklenti bileşenleri:** `integrations/antigravity/causoryn/` altında isteğe bağlı `agents/` / `rules/` / `hooks.json` uzantıları (`skills/` kök ve `packages/causoryn` dağıtımında zaten mevcuttur).
- **İç modül temizlikleri:** `packages/wiki/src/index.ts` barrel dosyasına `overlay` re-export eklenmesi, `candidateStatuses` için bağımsız Zod şeması ve `guard.ts` / `onboarding.ts` içindeki tekrarlı Tarjan SCC yardımcısının ortaklaştırılması.

## 6. Tarihsel GitHub Issue Referansları

| Issue | Başlık |
|---|---|
| [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Phase B: Deep Mapping |
| [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Phase C: Original Features |
| [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Phase C2: Living Wiki |
| [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Phase D: Differentiation |
| [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Phase E: Agent Change Guard |
| [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Phase F: Cross-host Release |

## İlgili sayfalar

- [implementation-status.md](implementation-status.md) — tüm sprintlerin ve `K-019`..`K-022` izleklerinin ayrıntılı kanıt tablosu
- [CHANGELOG.md](../CHANGELOG.md) — `0.2.0` Pre-1.0 Public Preview sürüm notları ve `[Unreleased]` 1.0.0 kapıları
- [architecture.md](architecture.md) — 18 workspace paketi ve 4 native sidecar mimarisi
- [compatibility-matrix.md](compatibility-matrix.md) — 4 host uyumluluk durumu
