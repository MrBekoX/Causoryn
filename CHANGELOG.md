# Changelog

Bu projedeki tüm önemli değişiklikler bu dosyada belgelenir. Format
[Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) temel alınır;
sürümleme [SemVer](https://semver.org/lang/tr/) ilkelerini izler.

## [Unreleased]

**1.0.0 kapıları** (henüz sağlanmadı — ADR-010 gereği yayımlanmış sürüm ilan edilmez; bkz. [docs/implementation-status.md](docs/implementation-status.md) Sprint 7 bölümü ve F9 kararı):

- Antigravity host kurulum + smoke koşumu (öncül: `agy` CLI'nin makinede bulunması; TŞ §22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla")
- ZCode GUI içi gerçek kurulum + tools/list smoke koşumu (kırmızı çizgi 6, kullanıcı kurulumunu bozmama kısıtıyla)
- macOS/Linux/ARM dağıtım hedeflerinin doğrulanması (TŞ §22 Release satırı; bugüne dek yalnızca Windows x64 koşuldu)
- MCP SDK v1.x → v2 hattına yükseltme (TŞ §6 hedefi; K-009 sapma kaydının kapatılması — npm install kısıtı nedeniyle bugüne dek 1.32.2)
- `causoryn_refresh_index` araç yüzeyinde `mode=incremental` açılımı (watcher in-process altyapısı hâlâ açık ret veriyor)
- adapters/typescript + adapters/csharp-roslyn TESTS kenarı üretimi (derive_test_plan `direct` sinyali bugün gerçek graph'ta dormant)
- OpenAPI keşfine yanıt-şeması drift'i eklenmesi (K-015(5) sadakat sınırı) ve TŞ §11 event versiyon uyumsuzluk kuralı (K-015(4))
- compare_architecture/architecture_timeline için `.causoryn/architecture-snapshot.json` blob üreticisi (bugün elle yazılmış blob gerekiyor)
- Rate-limit/concurrency resource budget (K-010 kapsam dışı beyanı) ve adanmış secret-scan script'i
- npm audit 10 moderate dev-toolchain uyarısının (minimatch) çözülmesi

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
  smoke koşumu (geçici config diziniyle, kullanıcı config'i temiz); Codex
  `config.toml`/`codex mcp add` kılavuzu + add→list→remove gerçek smoke
  (temizlik kanıtlı); Antigravity plugin.json+mcp.json doküman örneği (agy CLI
  yok — kurulum/smoke NOT RUN, ADR-010).
- **Güvenlik turu (F6, TŞ §22):** paketlenmiş bundle üzerinde 9/9 PASS —
  symlink/traversal, secret leakage (statik canary + davranışsal yemler),
  symlink TOCTOU, poisoned source comment/prompt injection, oversized files,
  malicious Git refs, network denied (netguard preload, sıfır ağ), offline
  HTML XSS/CSP, stdout disiplini (4 bağımsız spawn oturumu).
- **Benchmark (F7, TŞ §21):** 1.000 dosya deterministik fixture üzerinde MCP
  protokol düzeyi ölçümler — sıcak `workspace_summary` 5.3 ms, küçük sembol
  bağlamı 8.2 ms, 200-node map 5.7 ms (medyan; TŞ §21 rakamları tasarım
  hedefidir, sonuç değil).

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
