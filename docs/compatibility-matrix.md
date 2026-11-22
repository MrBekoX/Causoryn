# Compatibility Matrix — Host × Sonuç (Sprint 7 / Faz F + K-021/K-022 `v0.2.1`, TŞ §22-§23)

> **Dil / Language:** Türkçe · [English](en/compatibility-matrix.md)

> Kanıt: `wiki/sprint-7.md` F2–F5 · `wiki/decisions.md` K-021/K-022 · [docs/hosts/claude-code.md](hosts/claude-code.md),
> [docs/hosts/codex.md](hosts/codex.md), [docs/hosts/zcode.md](hosts/zcode.md), [docs/hosts/antigravity.md](hosts/antigravity.md),
> `integrations/zcode/causoryn/README.md` ·
> TŞ v2.1 §22 (Cross-host smoke: "Antigravity plugin validate/list, Claude Code /mcp, Codex mcp
> list … agy CLI yoksa çalıştırılmadı diye açıkça raporla") ve §23 Faz F kapısı · Kırmızı çizgi 5
> (koşulmayan smoke "not run" olarak AÇIK raporlanır) ve kırmızı çizgi 6 (kullanıcı config'ine
> kalıcı değişiklik bırakma) · Doğrulama testi: `tests/release-docs.test.ts` (Antigravity satırı
> NOT RUN; ZCode satırı yalnızca manifest doğrulama iddia eder; FİNAL turu blokları bayat
> sürüm/sayı iddialarını kırmızıya düşürür).

Motor kimliği: `causoryn@0.2.1` (`SERVER_VERSION` — Pre-1.0 Public Preview; tarihsel F1–F9 koşumları
`causoryn@0.1.0` ile yapıldı), stdio MCP, `tools/list` TAM OLARAK 29 araç (`TOOL_NAMES`,
`packages/mcp-server/src/version.ts`). Dağıtım paketi `packages/causoryn` (`npx causoryn@0.2.1 setup`)
ve monorepo F1 bundle'ı (`packages/mcp-server/dist/mcp-server.mjs` + vendored
`node_modules/better-sqlite3/`) aynı motoru çalıştırır (artefakt kasıtlı olarak tek dosya değildir —
native `.node` gömülemez, ADR-010). Yerel canlı host doğrulama ortamı: Windows 10.0.26300 x64,
Node ≥ 24; 3-OS GitHub Actions CI matrisi (`.github/workflows/ci.yml`: `ubuntu-latest`,
`windows-latest`, `macos-latest`) K-022'de üç işletim sisteminin tamamında yeşil doğrulandı.

## Host × sonuç matrisi (ilk koşum 2026-11-08 · F8 final 2026-11-10 · K-021/K-022 taze CLI doğrulama 2026-11-19)

| Host | Kurulum | Smoke / doğrulama | stdout temizliği | Sonuç |
|---|---|---|---|---|
| Claude Code | ✅ CLI **2.1.322** (2026-11-10) & **2.1.328** (2026-11-19) mevcut (sözdizimi ilk 2026-11-08'de 2.1.319 ile doğrulandı); `CLAUDE_CONFIG_DIR` geçici dizine yönlendirilerek `claude mcp add -s local` + K-021 `npx causoryn@0.2.1 setup --client claude-code` & kök `.claude-plugin/marketplace.json` | ✅ `claude mcp list` → `causoryn … ✔ Connected` uçtan uca koşuldu — **ilk 2026-11-08 (2.1.319), 2026-11-10'da 2.1.322 ile yeniden doğrulandı, 2026-11-19'da `claude 2.1.328` ile `plugin validate --strict` + `mcp list √ Connected` teyit edildi**; remove ile kaldırıldı; temizlik kanıtı: smoke öncesi/sonrası `sha256sum ~/.claude.json` birebir aynı; negatif davranış kayıtlı: geçersiz komut yolu `✘ Failed to connect — CONNECTION_CLOSED` raporlanır, host hatayı sessizce geçmez ([docs/hosts/claude-code.md](hosts/claude-code.md)) | ✅ Manuel doğrulama + K-021 `.tgz` E2E: stdout saf JSON-RPC (initialize + tools/list → 29 araç), loglar yalnızca stderr | KOŞULDU (F3 + K-021) |
| Codex CLI | ✅ CLI 0.163.0 (2026-11-10) & **0.169.0** (2026-11-19) mevcut; `codex mcp add causoryn-smoke` + K-021 `npx causoryn@0.2.1 setup --client codex` + `.agents/plugins/marketplace.json`; **2026-11-10 yeniden koşumunda `~/.codex/config.toml` önce yedeklendi** — add/remove dosyayı yeniden serileştirir, byte-düzeyi değişmezlik yoktur ([docs/hosts/codex.md](hosts/codex.md) §5 canlı bulgu) | ✅ add → `codex mcp list` (görünür) → `codex mcp remove` → `codex mcp list` (artık YOK) temizlik kanıtıyla — **ilk 2026-11-08, 2026-11-10'da yeniden koşuldu, 2026-11-19'da `codex-cli 0.169.0` ile `plugin marketplace add` + `mcp add/list` doğrulandı**; dürüst sınır (0.163.0/0.169.0 canlı kanıt): `codex mcp list` health-check YAPMAZ — smoke kayıt-düzeyidir; spawn/handshake kanıtı Claude satırındaki gerçek bağlantı koşumundadır | ✅ Manuel doğrulama + K-021 `.tgz` E2E: stdout saf JSON-RPC (initialize + tools/list → 29 araç), stderr yalnızca `[causoryn]` logları | KOŞULDU (F4 + K-021) |
| ZCode (plugin) | ⚠️ ZCode CLI YOK (kurulum desktop GUI adımıdır); K-021 `npx causoryn@0.2.1 setup --client zcode` (`~/.zcode/cli/config.json` + `~/.agents/mcp.json` fallback koruması) izole temp `$HOME` içinde doğrulandı; **gerçek GUI kurulumu kasıtlı olarak yapılmaz** (kırmızı çizgi 6, [docs/hosts/zcode.md](hosts/zcode.md)) | ⚠️ **Manifest doğrulama koşuldu**: kök `marketplace.json` + paket `.zcode-plugin/plugin.json` (`--expected-version 0.2.1`) + dev marketplace (`integrations/zcode/.claude-plugin/marketplace.json`) + plugin manifest/skill/bundle-bağlantı testleri (`plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts`, `open-source-distribution.test.ts`) yeşil; GUI içi kurulum+tools/list adımları belgeli, bu oturumda koşulmadı (NOT RUN) | ✅ Aynı süreç stdio disiplini (birim testi `stdio-stdout.test.ts` + K-021 `.tgz` E2E); host UI içi gözlem KOŞULMADI | MANIFEST DOĞRULAMA — GUI kurulum koşulmadı (F2 + K-021) |
| Antigravity | ❌ **NOT RUN** — `agy` CLI bu makinede YOK (`agy --version` → command not found; `command -v agy` boş; Antigravity IDE kurulu fakat CLI çalıştırılabilir'i yok); K-021 `npx causoryn@0.2.1 setup --client antigravity` izole temp `$HOME` içinde doğrulandı | ❌ **NOT RUN** — `agy plugin validate/install/list` ve tool discovery hiçbiri koşulmadı (TŞ §22 kuralı: "agy CLI yoksa çalıştırılmadı diye açıkça raporla"); `plugin.json` (`$schema`'sız yerel yükleyici uyumlu) + `mcp_config.json` + `mcp.json` + `README.md` ve sahnelenmiş `scripts/mcp-server.mjs` üzerinde şema + doğrudan `stdio` el sıkışması (29 araç) `antigravity-plugin.test.ts` ile doğrulandı; `agy` CLI kurulum/smoke NOT RUN ([docs/hosts/antigravity.md](hosts/antigravity.md)) | ❌ **NOT RUN** — host UI içi stdout gözlemi yapılamadı (sunucu sürecinin kendi stdio disiplini birim testli) | NOT RUN (F5 — agy CLI yok; ADR-010: koşulmayan Done yazılmaz) |

## Host-bağımsız paket kontrolleri (matrix'i tamamlayan kanıtlar)

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| F1 bundle determinizmi | ✅ İki build bit-bit aynı; manifest (35 dosya: `mcp-server.mjs`, `mcp-server.mjs.LEGAL.txt`, `node_modules/better-sqlite3/LICENSE` + runtime/prebuilds, sıralı sha256) `mcp-server.mjs` ile birebir — final turda (60735ff) ve K-022 lisans turunda doğrulandı, diskteki `dist/bundle-manifest.json` 35 girdiyle doğrulandı | `packages/mcp-server/test/bundle.test.ts`; `tests/hosts-docs.test.ts` manifest sha256 karşıtlığı |
| K-021/K-022 `packages/causoryn` dağıtım paketi | ✅ `build-package.mjs` + `verify-package-ready.mjs` + izole `npm pack` `.tgz` E2E (4-host `setup`/`doctor` + `mcp` stdio el sıkışması + `THIRD-PARTY-NOTICES.md` / `licenses/`) | `tests/open-source-distribution.test.ts`; `packages/causoryn/test/setup-and-doctor.test.ts` |
| 3-OS GitHub Actions CI matrisi (K-022) | ✅ `ubuntu-latest`, `windows-latest` ve `macos-latest` üzerinde Node 24 + .NET 10 + Python 3.12 + Go + Rust derleme, bundle, dağıtım paketi hazırlık kapısı, lint, secret-scan ve tam test paketi yeşil geçti | `.github/workflows/ci.yml` |
| F6 güvenlik turu (paketlenmiş bundle, TŞ §22 matrisi) | ✅ 9/9 satır PASS (traversal/symlink, secret leakage, TOCTOU, prompt injection, oversized, malicious refs, network denied, offline XSS/CSP, stdout disiplini); **final tur (e3d0bc2, 2026-11-10)**: tüm satırlar bağımsız oturumda yeniden koşuldu + matris 6. satırı bundle-düzeyi davranışsal kanıta yükseltildi (F6-K7: gerçek commit SHA `git cat-file` ile bundle içinde çözülür, 3 kötü ref → `INVALID_REVISION`) | `docs/security-pass.md`; `npx vitest run tests/security-release/f6-security-release.test.ts` → **32/32**; paketin tamamı `npx vitest run tests/security-release/` → **36/36** |
| F7 performans (1k dosya fixture, MCP protokol düzeyi) | ✅ Medyanlar (**2026-11-10 final koşumu**): workspace_summary 11.8 ms, sembol bağlamı 13.0 ms, 200-node map 10.7 ms — TŞ §21 referans hedeflerinin içinde (hedef tasarım değeri, sonuç değil); ilk koşum 2026-11-08 daha düşük ölçtü (5.3/8.2/5.7 ms) — her iki koşum da hedeflerin çok altında | `docs/benchmarks.md`; `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (config: `vitest.bench.config.ts`; doğruluk kapısı `npm run test`'ten kasıtlı ayrıdır) |
| Stdio stdout hijyeni (birim) | ✅ stdout yalnızca MCP protokolü; loglar `[causoryn]` önekiyle stderr | `packages/mcp-server/test/stdio-stdout.test.ts` |

## Dürüstlük notları

1. **3 hosttan 2'si gerçek koşumla doğrulandı; Antigravity koşulamadı.** TŞ §23 Faz F kapısındaki
   "3 host kurulum testleri" kalemi bu nedenle 2/3 ile raporlanır; kalan 1/3 NOT RUN'dır ve
   [docs/hosts/antigravity.md](hosts/antigravity.md)'de koşulacak komut listesiyle açık tutulur (agy
   CLI kurulduğunda matris güncellenir).
2. **ZCode satırı bilinçli olarak manifest ve izole CLI-config düzeyindedir:** kırmızı çizgi 6, smoke
   testlerin kullanıcının gerçek ZCode kurulumuna kalıcı değişiklik bırakmasını yasaklar; GUI-only
   pazaryeri kurulumu bu kısıtla canlı koşulmaz. Kurulum adımları ([docs/hosts/zcode.md](hosts/zcode.md),
   `integrations/zcode/causoryn/README.md` ve `npx causoryn@0.2.1 setup --client zcode --yes`)
   belgelenmiştir ve etkileşimli masaüstü GUI bu oturumda yürütülmedi (`NOT RUN`).
3. **stdout temizliği iki katmandır:** her hostta aynı motor koştuğundan süreç-düzeyi disiplin tek
   kanıtla taşınır (birim test + F6'nın 5 bağımsız spawn oturumu — final turda F6-K7 ile 4'ten 5'e
   çıktı — + Claude/Codex manuel doğrulamaları + K-021 `.tgz` E2E); host UI içi gözlem yalnızca
   Claude Code ve Codex'te yapılabildi.
4. **Platform doğrulama ayrımı:** bu matristeki canlı etkileşimli host CLI koşumları Windows x64
   üzerindedir; `.github/workflows/ci.yml` `ubuntu-latest`, `windows-latest` ve `macos-latest`
   üzerinde tüm build/bundle/package/lint/secret-scan/test kapılarını K-022'de yeşil yürütmüştür,
   ancak canlı etkileşimli macOS/ARM64 host CLI/GUI smoke (TŞ §22 Release satırı) henüz NOT RUN'dır
   — 1.0.0 kapısı olarak açık tutulur.
5. **Uyum/güven ilkesi (TŞ §17.4):** hostlar arası davranış eşitliği MCP tool schema + contract
   testleriyle sağlanır; host UI/permission özdeşliği iddia edilmez. Causoryn host modelin tool
   seçimini zorlayamaz.

## İlgili sayfalar

- [docs/hosts/claude-code.md](hosts/claude-code.md) · [docs/hosts/codex.md](hosts/codex.md) · [docs/hosts/zcode.md](hosts/zcode.md) · [docs/hosts/antigravity.md](hosts/antigravity.md) · `integrations/zcode/causoryn/README.md` · `integrations/antigravity/causoryn/README.md`
- [docs/security-pass.md](security-pass.md) · [docs/benchmarks.md](benchmarks.md) · [docs/tool-contracts.md](tool-contracts.md)
- [docs/implementation-status.md](implementation-status.md) — Sprint 7/8 bölümleri ve F9/K-022 sürüm kararları
- [English version](en/compatibility-matrix.md)
