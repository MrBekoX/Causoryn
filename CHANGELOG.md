# Changelog

Bu projedeki tüm önemli değişiklikler bu dosyada belgelenir. Format
[Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temel alınır;
sürümleme [SemVer](https://semver.org/lang/tr/) ilkelerini izler.

## [Unreleased]

**1.0.0 kapıları** (henüz sağlanmadı — ADR-010 gereği 1.0.0 ilan edilmez; bkz. [docs/implementation-status.md](docs/implementation-status.md) Sprint 7 bölümü, F9 ve K-022 kararları):

- Antigravity host kurulum + smoke koşumu (öncül: `agy` CLI'nin makinede bulunması; TŞ §22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla")
- ZCode GUI içi gerçek kurulum + tools/list smoke koşumu (kırmızı çizgi 6, kullanıcı kurulumunu bozmama kısıtıyla)
- macOS/Linux/ARM canlı host dağıtım doğrulaması (TŞ §22 Release satırı; `.github/workflows/ci.yml` `ubuntu-latest` + `windows-latest` + `macos-latest` CI matrisi K-020/K-022 ile eklendi; canlı macOS/ARM64 host smoke hâlâ açık)
- MCP SDK v1.x → v2 hattına yükseltme (TŞ §6 hedefi; K-009 sapma kaydının kapatılması — bugüne dek 1.32.2)
- `causoryn_refresh_index` araç yüzeyinde `mode=incremental` (2026-11-18 K-020 ile açıldı; watcher MCP araca sarılması hâlâ açık) ve per-file parse reuse'un eklenmesi (B7 Partial kalıntısı — graph tutarlılığı bugün değişimde tam türetim zorluyor)
- adapters/csharp-roslyn (ve diğer sidecar dillerde) TESTS kenarı üretimi (`adapters/typescript` `Test` node + `TESTS` kenarı üretimi 2026-11-18 K-020 ile aktifleştirildi; C#/Python/Go/Rust'ta `derive_test_plan` `direct` sinyali hâlâ açık)
- OpenAPI keşfine yanıt-şeması drift'i eklenmesi (K-015(5) sadakat sınırı), TŞ §11 event versiyon uyumsuzluk kuralı (K-015(4)) ve SQL RENAME → `unknown` sınıflamasının netleştirilmesi (K-015(3))
- compare_architecture/architecture_timeline için `.causoryn/architecture-snapshot.json` iş akışı otomasyonu (`causoryn_export_documentation(format="snapshot")` ile izinli `output.allowedOutputDirs` dizinine kanonik blob üreticisi 2026-11-18 K-020 ile eklendi; workspace içine otomatik yazma kırmızı çizgi 2 gereği yapılmaz)
- wiki_search sorgu filtrelerinin (pageKind/language/…) araç yüzeyine açılması, `WIKI_NOTE_CONFLICT` için TOOL_ERROR_GUIDANCE kaydı eklenmesi ve incremental wiki yayımında link/FTS indekslerinin tam graph'tan yeniden yazmasının daraltılması
- E6 offline visualizer'ın gerçek tarayıcı koşusuyla doğrulanması (`causoryn_export_documentation(format="html", view="interactive")` MCP yüzeyi v0.2.2'de açıldı)
- Bundle fidelity: default lib (`.d.ts`) dosyalarının bundle'a katılması veya doküman sınırlaması (çıplak `packages/mcp-server/dist/` 33-dosya F1 klonunda `.d.ts` yoktur; açık kaynak dağıtım paketi `packages/causoryn` içinde `dist/typescript-lib/lib*.d.ts` sahnelemesi ve `resolveTypeScriptLibDir` ile 2026-11-19 K-021'de `state: "ready"` kanıtlandı — docs/security-pass.md Dürüstlük 1)
- Rate-limit/concurrency resource budget (K-010 kapsam dışı beyanı) (adanmış secret-scan kapısı 2026-11-17/18'de `scripts/secret-scan.mjs` ile eklendi ve 2026-11-20 K-022'de 12 kök + kök dosyalarına genişletildi)
- ~~npm audit 10 moderate dev-toolchain uyarısının (minimatch) çözülmesi~~ — **Kapatıldı (2026-11-20, K-022):** `eslint@10.15.0` ve `typescript-eslint@8.73.0` yükseltmesiyle `npm audit` **0 güvenlik açığı** (`0 vulnerabilities`) döndürür.

## [0.2.2] - 2026-11-22

### Added

- **Visual Architecture Projection & Layered SVG Layout (`packages/graph`):** Adaptif dizin-ağacı modül kümeleme (`projectArchitecture`, varsayılan `maxModules: 32`, `UnknownExternal` gürültüsünü dışlayıp `externalSummary` içinde dürüstçe özetler, Tarjan SCC ile döngüsel bağımlılıkları tespit eder) ve sıfır-bağımlılıklı Sugiyama tarzı katmanlı SVG yerleşim + Bezier eğri yönlendirme motoru (`computeArchitectureLayout`, `renderArchitectureSvg`, `renderFlowStripSvg`).
- **Multi-View Visual `causoryn_export_documentation` & Fail-Closed Host-LLM `annotations` (`packages/graph`, `packages/mcp-server`):**
  - Varsayılan `view: "architecture"`: **sıfır-JS, katı offline CSP'li** (`default-src 'none'`) 5 sekmeli katmanlı SVG Offline Architecture Portalı (`html`), subgraph-gruplu render edilebilir `flowchart TB` (`mermaid`), gömülü Mermaid + modül/akış/kontrat/risk özeti (`markdown`) ve `meta.id` uyumlu kompakt blueprint (`json`) üretir; yanıt `data.architectureSummary.moduleIds` listesini döndürür.
  - Opt-in `view: "interactive"` (yalnızca `format: "html"`): pan/zoom, anlık arama, dil/döngü/test filtreleri, 1-hop komşuluk vurgulu sağ Inspector Drawer, tıklanabilir kaynak-satır kanıtları ve Mermaid kopyalama içeren offline etkileşimli portal (`VIEWER_CSP_POLICY`, sıfır `innerHTML`, sıfır `fetch`/CDN).
  - Opsiyonel fail-closed `annotations` (`title`, `architectureStyle`, `executiveSummary`, `domains`, `moduleNotes`, `flows`, `guidedTour`, `decisions`, `risks`): platformdaki Host LLM'in Causoryn MCP araçlarıyla keşfettiği mimari anlatıyı tüm `moduleId`/`nodeId`/`evidenceId`/`keyFiles` kimliklerini doğrulayarak portala gömer (Causoryn çekirdeği %100 LLM-free kalır — ADR-002).
  - `view: "full"` ile eski ham snapshot dökümü geriye uyumlu korunur; 29 araç kataloğu sabit tutulur.
- **Host-LLM Orkestrasyon Skill'i (`skills/architecture-blueprint/SKILL.md`):** Claude Code, Codex, Antigravity ve ZCode'daki platform LLM'ini 6 adımlı deterministik MCP keşif → blueprint → doğrulanmış anotasyon → görsel portal üretim akışına yönlendiren 5. kanonik skill (`CANONICAL_SKILL_NAMES` + 4 host kurulumuna dahil).

### Performance & Fixed

- **PRAGMA `data_version` korumalı SQLite snapshot önbelleği (`packages/storage-sqlite`, `packages/mcp-server`):** Sıcak okumalarda tam 80k+ satırlık snapshot yeniden kurulumunu önleyen sınırlı (max 4 giriş) `SnapshotGraph` önbelleği ve `startDeferredIndex()` içine ertelenmiş kalıcı snapshot yüklemesi (büyük tam-yığın repolarda sıcak sorgular ~100–300x hızlandı).
- **Dinamik `causoryn doctor` paket sürümü (`packages/causoryn`):** `CAUSORYN_PACKAGE_VERSION` artık `packages/causoryn/package.json` dosyasından dinamik okunur.

## [0.2.1] - 2026-11-22

### Fixed

- **Non-blocking MCP startup (`cli-stdio.ts`, `runtime-cli.ts`, `context.ts`):** `causoryn mcp --allow-cwd --auto-data-dir` artık büyük repolarda MCP `initialize` ve `tools/list` el sıkışmasından önce senkron indeksleme yapmaz (`deferAutoIndex: true` + `oninitialized` sonrası arka plan tam async indeksleme); büyük tam-yığın projelerde `initialize` süresi timeout yerine `< 500 ms` seviyesine indirildi.
- **Gerçek-dünya build/venv/cache ignore + kök `.gitignore` uyumu (`packages/workspace`, `runtime-cli.ts`):** `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `target`, `coverage`, `.vs`, `.dotnet`, `.dotnet-home`, `.codex-build` ve `.nupkg`/`.snupkg`/`.pdb` ikilileri varsayılan dışlamaya alındı; `buildWorkspaceAutoConfig` kök `.gitignore` desenlerini negasyon-güvenli biçimde `extraIgnore` ile birleştirir.
- **Polyglot paylaşımlı dış düğüm birleştirme (`packages/indexing`):** İki veya daha fazla dil analizörü aynı `relativePath=null` dış/sanal düğümü (`UnknownExternal`, örn. `Request`) ürettiğinde snapshot oluşturma artık çökmez; kanonik düğüm paylaşılırken dosya-bağlı çakışmalar fail-closed reddedilmeye devam eder.
- **O(1) SQLite pozisyon sayacı & toplu transaction yazımı (`packages/storage-sqlite`, `packages/graph`, `packages/indexing`):** `SqliteGraphRepository` içindeki `addNode`/`addEdge`/`addEvidence` O(N²) `MAX(position)` alt sorguları O(1) sayaçla değiştirildi ve toplu build/envanter yazımları `runInTransaction` ile tek atomik SQLite transaction'ında yürütülür.
- **Yanıt bütçesi koruması (`packages/mcp-server`):** `causoryn_index_status` yanıtındaki `job.diagnostics` ve `job.warnings` dizileri büyük projelerde MCP bağlam penceresini taşmaması için 50 kayıt + kısaltma özeti ile sınırlandı.
- **Release workflow (`release.yml`):** `npm publish "./$TGZ_FILE"` öneki ile yerel tarball yolunun npm tarafından GitHub repo kısayolu sanılması giderildi.

## [0.2.0] - 2026-11-20

### Sürüm kararı (K-022)

**0.2.0 Pre-1.0 Public Preview** — **1.0.0 DEĞİL (ADR-010).** Uzak `v0.1.0`
etiketi `4c9c188f` üzerinde kilitli kaldığından ve Sprint 8 çok-dil genişlemesi,
K-019/K-020/K-021/K-022 teslimleriyle ürün yüzeyi anlamlı biçimde genişlediğinden
yeni minor SemVer **`0.2.0`** yayımlandı (`package.json`, `packages/causoryn/package.json`,
`SERVER_VERSION`, `server.json` ve 4 host pazaryeri manifesti senkron). Yukarıdaki
`[Unreleased]` 1.0.0 kapıları kapanmadan `1.0.0` ilan edilmez.

### Added

- **Çok-dil derin analiz (Sprint 8, K-018):** `native/python-worker` (stdlib `ast`),
  `native/go-worker` (stdlib `go/parser`), `native/rust-worker` (`syn` 2) sidecar'ları,
  `adapters/{python,go,rust}`, 5-dil birleşik `INDEXED_ADAPTERS` ve dürüst resolution/tier
  etiketleri (`workspace_summary.languages` + `coverageOf.tier` + 29 MCP aracı
  `annotations`/`readOnlyHint`, K-019).
- **Pre-1.0 mühendislik iyileştirmeleri (K-020):** opsiyonel kalıcı SQLite graph deposu
  (`storage.dataDbPath`) + `symbol_fts` Agent GPS `fts` ayağı, `causoryn_refresh_index(mode="incremental")`,
  TypeScript BDD `Test`/`TESTS` çıkarımı, `causoryn_export_documentation(format="snapshot")`,
  ortak `@causoryn/sidecar-ipc` süreç çekirdeği ve GitHub Actions CI iş akışı.
- **Açık kaynak çoklu-host dağıtım (`packages/causoryn`, K-021):** `causoryn` tek npm
  paketi (`setup`/`doctor`/`mcp`), 4 host pazaryeri manifesti (Antigravity, Claude Code,
  Codex, ZCode/GLM), 4 kanonik `skills/`, sıfır-ayar `--allow-cwd` + MCP `roots/list` +
  `--auto-data-dir`, `dist/typescript-lib/lib*.d.ts` sahnelemesi ve `mcpName` + `server.json`
  MCP Registry kimliği (`io.github.mrbekox/causoryn`).
- **Açık kaynak yayın yönetişimi & tedarik zinciri (K-022):**
  - `MIT` lisansı (`Causoryn Contributors`), `THIRD-PARTY-NOTICES.md` ve paketlenen
    üçüncü taraf lisans metinleri (`licenses/`).
  - `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`,
    `.github/PULL_REQUEST_TEMPLATE.md` ve `.github/dependabot.yml`.
  - `.github/workflows/ci.yml`: tüm eylemler 40-karakter commit SHA'ya sabitlendi;
    `ubuntu-latest` + `windows-latest` + `macos-latest` matrisi, deterministik Release
    Roslyn derlemesi, `cargo build --locked` ve `verify-package-ready.mjs` eklendi.
  - `.github/workflows/release.yml`: SHA-sabitli etiket/sürüm doğrulaması, `SHA256SUMS.txt`,
    CycloneDX SBOM (`causoryn-sbom.cdx.json`), `actions/attest-build-provenance` ve
    `NPM_TOKEN`'sız OIDC Trusted Publishing (`npm publish --provenance --access public`).
  - `scripts/export-public-tree.mjs`: Seçenek 1 temiz kamuya açık repo dışa aktarıcısı
    (`raw/`, `wiki/`, `docs/superpowers/` ve iç prompt dosyalarını dışlar, `.gitignore`
    iç araç satırlarını temizler ve fail-closed sızıntı doğrulaması yapar).

### Changed

- C# `INDEXED_ADAPTERS` `frameworkLinkers` etiketi `"aspnet-core-route-attributes (L3)"`
  olarak netleştirildi ve `docs/project-overview.tr-en.md` (TR & EN) senkronize edildi.
- `README.md` ve `packages/causoryn/README.md` genel "zero-compile" ifadesi yerine
  bileşen bazlı çalışma zamanı / derleme / çevrimdışı matrisine geçirildi (Go `go run`
  ve Rust soğuk `cargo build --locked` `crates.io` davranışı açıkça belgeli).
- `integrations/zcode/.claude-plugin/marketplace.json` `owner` alanı (`claude plugin validate --strict`
  uyumu) ve dev-fixture uyarıları eklendi; tüm kullanıcıya dönük dokümanlardan yerel
  makine yolları ve kişisel kullanıcı adı temizlendi.

### Security

- `scripts/secret-scan.mjs` 12 dizin kökü (`.github`, `.claude-plugin`, `.agents`, `docs`,
  `skills` dahil) + 13 kök metin dosyasına ve genişletilmiş token/yerel-profil-yolu
  desenlerine yükseltildi.
- `eslint@10.15.0` ve `typescript-eslint@8.73.0` yükseltmesiyle `npm audit` **0 güvenlik
  açığı** (`0 vulnerabilities`) seviyesine getirildi.
- Deterministik Release Roslyn derlemesi (`-c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en`)
  ile yerel makine PDB yollarının DLL içine sızması engellendi.

## [0.1.0] - 2026-11-09

### Sürüm kararı (F9)

**0.1.0 public snapshot** — 1.0.0 DEĞİL. Kök `package.json` `version` alanı
`0.1.0` olarak korunmuştur (değişiklik gerekmedi; karar bu değerin
korunmasıdır) ve `SERVER_VERSION` ile birebirdir. Gerekçe (ADR-010: eksik
özellik Done ilan edilmez): 29 aracın tamamı gerçek implementasyondur ve
release test matrisi (güvenlik 9/9, benchmark, 2/3 host smoke) + changelog
sağlanmıştır; ancak 1.0.0'ın gerektirdiği üç hostun TAMAMI koşumla
doğrulanmış olma (Antigravity NOT RUN), platform dağıtım genişliği
(yalnızca Windows doğrulanmış) ve belgeli sadakat sınırlarının
kapatılmış olma barajı henüz sağlanmadı — ayrıntılı sayım yukarıdaki
Unreleased bölümünde ve `docs/implementation-status.md` Sprint 7 bölümündedir.

### Added

- **MCP motoru:** 29 gerçek araç `tools/list` ile yayımlanır (TŞ §10.2'nin 22
  çekirdeği + §16A.8'in 7 wiki aracı; boş handler yok — ADR-010). Standart
  envelope (`schemaVersion` "2.0"), sabit hata kodu tablosu (TŞ §10.1 + 3
  proje uzantısı: INVALID_ARGUMENT, EVIDENCE_NOT_FOUND, SYMBOL_NOT_FOUND —
  K-008/K-011) ve retryable/userAction rehberi.
- **Core özellikler:** yetenek/workspace özeti/indeks işleri (A), mimari harita +
  sembol arama/bağlam + çağrı izi (B), etki analizi + Architecture Guard
  (policy DSL, Tarjan SCC) + git diff/timeline + Agent GPS + onboarding +
  deterministik export (C).
- **Living Wiki (C2, TŞ §16A):** WikiProjectionEngine, SQLite wiki şeması,
  çift yönlü linkler + broken-link diagnostics, FTS5 çok ayaklı arama,
  sürümler/diff (K-013(7) contractChanges dahil), incremental invalidation
  (link-düzeyi sınırla), annotation overlay (CAS, WIKI_NOTE_CONFLICT), offline
  markdown+HTML export. 7 wiki aracı; `wiki_build` tek yazma aracıdır.
- **Differentiation (D, TŞ §11/§14/§15):** sözleşme keşfi (OpenAPI/AsyncAPI/
  SQL/JSON Schema/protobuf; parse güvenlik kotaları), compatibility + drift
  çekirdekleri, business flow tracing, candidate-only Preflight Manifest
  (kod yazmaz), derive_test_plan (test çalıştırmaz, "geçti" iddiası üretmez).
- **Agent Change Guard (E, TŞ §10.4):** `causoryn_verify_change` — 4 denetim,
  deterministik 8-kuralı verdict zinciri (no_findings | review_required |
  blocking_findings | inconclusive), test durumu dürüstlüğü (not_run
  varsayılan; observed yalnızca evidenceRef+sha256 kanıtıyla), byte-deterministik
  rapor (sprint kapısı: aynı girdi → bit-bit aynı rapor).
- **Offline visualizer (E6):** `apps/visualizer` — sıfır bağımlılıklı
  deterministik HTML+SVG viewer (inline CSS/JS, kısıtlayıcı CSP,
  verified/heuristic/unresolved ayrımı, selection→evidence paneli).
- **C# desteği (B1/B9):** Roslyn sidecar worker (`native/roslyn-worker`, dotnet
  build 0 hata disiplini) + graceful fallback (worker yok → L0/L1, açık
  coverage raporu) + analyzerFingerprint fp2.
- **Paketleme (F1):** esbuild bundle `packages/mcp-server/dist/mcp-server.mjs`
  + external vendored `better-sqlite3` (`dist/node_modules/`); deterministik
  üretim (iki build bit-bit aynı, `dist/bundle-manifest.json` sıralı sha256).
  Artefakt dürüst biçimde "bundle + vendored runtime"dir; tek dosya DEĞİLDİR
  (native .node gömülemez — ADR-010).
- **Host entegrasyonları (F2–F5):** ZCode dev marketplace + plugin manifest
  doğrulaması; Claude Code `.mcp.json`/`claude mcp add` kılavuzu + gerçek
  smoke koşumu (geçici config diziniyle, kullanıcı config'i temiz —
  **2.1.322 ile 2026-11-10'da uçtan uca yeniden doğrulandı**); Codex
  `config.toml`/`codex mcp add` kılavuzu + add→list→remove gerçek smoke
  (temizlik kanıtlı; config.toml yedek/geri yükleme disipliniyle 2026-11-10'da
  yeniden koşuldu); Antigravity plugin.json+mcp.json doküman örneği (agy CLI
  yok — kurulum/smoke NOT RUN, ADR-010).
- **Güvenlik turu (F6, TŞ §22):** paketlenmiş bundle üzerinde 9/9 PASS —
  symlink/traversal, secret leakage (statik canary + davranışsal yemler),
  symlink TOCTOU, poisoned source comment/prompt injection, oversized files,
  malicious Git refs (bundle spawn'da davranışsal kanıt: gerçek commit SHA
  `git cat-file` ile çözülür, kötü ref → `INVALID_REVISION`), network denied
  (netguard preload, sıfır ağ), offline HTML XSS/CSP, stdout disiplini
  (5 bağımsız spawn oturumu). F6 paketi 32/32 test; güvenlik suite'i toplamı
  36/36 (2026-11-10 final turunda tümü yeniden koşuldu).
- **Benchmark (F7, TŞ §21):** 1.000 dosya deterministik fixture üzerinde MCP
  protokol düzeyi ölçümler — sıcak `workspace_summary` 11.8 ms, küçük sembol
  bağlamı 13.0 ms, 200-node map 10.7 ms (medyan; `npm run bench`, 2026-11-10
  koşumu; TŞ §21 rakamları tasarım hedefidir, sonuç değil).

### Documentation

- `docs/architecture.md` (kod-face paket haritası, 12 workspace paketi +
  visualizer + roslyn-worker), `docs/tool-contracts.md` (29 araç sözleşme
  özeti), `docs/compatibility-matrix.md` (host × sonuç; not-run satırları
  dürüst), `docs/hosts/*` (3 host kılavuzu + ZCode README),
  `docs/security-pass.md`, `docs/benchmarks.md`,
  `docs/implementation-status.md` (tüm fazların ADR-010 dürüst tablosu) ve bu
  changelog. Wiki kayıtları (sprint sayfaları, K-001..K-016 kararları)
  `wiki/` altında tutulur.

### Security

- Workspace salt-okunur (ADR-008); yazma yalnızca beyanlı data-root/output
  dizinine; explicit root authorization + default deny; symlink/junction
  escape ve TOCTOU post-open re-check; SQL parametre bağlama; INTERNAL_ERROR
  bilgi sızdırmazlığı; git salt-okunur allowlist (cat-file/ls-tree; shell
  interpolation yok); HTML export'larda CSP + tam escape + sıfır harici
  kaynak; LLM/embedding/model bağımlılığı yok (ADR-002) ve sıfır ağ çıkışı
  (netguard ile davranışsal kanıt).

## İlgili sayfalar

- [docs/implementation-status.md](docs/implementation-status.md) — faz faz durum ve kanıt
- [docs/compatibility-matrix.md](docs/compatibility-matrix.md) — host × sonuç
- [docs/security-pass.md](docs/security-pass.md) · [docs/benchmarks.md](docs/benchmarks.md)
