# Compatibility Matrix — Host × Sonuç (Sprint 7 / Faz F, TŞ §22-§23)

> Kanıt: `wiki/sprint-7.md` F2–F5 · `docs/hosts/claude-code.md`, `docs/hosts/codex.md`,
> `docs/hosts/antigravity.md`, `integrations/zcode/causoryn/README.md` · TŞ v2.1 §22
> (Cross-host smoke: "Antigravity plugin validate/list, Claude Code /mcp, Codex mcp
> list … agy CLI yoksa çalıştırılmadı diye açıkça raporla") ve §23 Faz F kapısı ·
> Kırmızı çizgi 5 (koşulmayan smoke "not run" olarak AÇIK raporlanır) ve kırmızı
> çizgi 6 (kullanıcı config'ine kalıcı değişiklik bırakma) · Doğrulama testi:
> `tests/release-docs.test.ts` (Antigravity satırı NOT RUN; ZCode satırı yalnızca
> manifest doğrulama iddia eder).

Motor kimliği: `causoryn@0.1.0` (`SERVER_VERSION`), stdio MCP, `tools/list` TAM
OLARAK 29 araç (`TOOL_NAMES`, `packages/mcp-server/src/version.ts`). Tüm hostlar
aynı bundle'ı çalıştırır: `packages/mcp-server/dist/mcp-server.mjs` + vendored
`node_modules/better-sqlite3/` (F1; artefakt kasıtlı olarak tek dosya değildir —
native `.node` gömülemez, ADR-010). Ortam: Windows 10.0.26300 x64, Node ≥ 24.

## Host × sonuç matrisi (koşum tarihi 2026-11-08)

| Host | Kurulum | Smoke / doğrulama | stdout temizliği | Sonuç |
|---|---|---|---|---|
| Claude Code | ✅ CLI 2.1.319 mevcut; `CLAUDE_CONFIG_DIR` geçici dizine yönlendirilerek `claude mcp add -s local` kaydı | ✅ `claude mcp list` → `causoryn … ✔ Connected` uçtan uca koşuldu; remove ile kaldırıldı; kullanıcı `~/.claude.json`'a smoke ile ilgili bayt yazılmadı (yönlendirme kanıtı: "File modified: <tmp>/.claude.json") | ✅ Manuel doğrulama: stdout 2 satır saf JSON-RPC (initialize + tools/list → 29 araç), loglar yalnızca stderr | KOŞULDU (F3) |
| Codex CLI | ✅ CLI 0.163.0 mevcut; `codex mcp add causoryn-smoke` belirgin adla eklendi (kullanıcı-genel config'e geçici kayıt — Codex'te local scope YOK) | ✅ add → `codex mcp list` (görünür) → `codex mcp remove` → `codex mcp list` (artık YOK) temizlik kanıtıyla; yaşam döngüsü uçtan uca koşuldu | ✅ Manuel doğrulama: stdout 2 satır saf JSON-RPC (initialize + tools/list → 29 araç), stderr yalnızca `[causoryn]` logları | KOŞULDU (F4) |
| ZCode (plugin) | ⚠️ ZCode CLI YOK (kurulum desktop GUI adımıdır); **gerçek kurulum kasıtlı olarak yapılmaz** (kırmızı çizgi 6) | ⚠️ **Manifest doğrulama koşuldu**: dev marketplace (`integrations/zcode/.claude-plugin/marketplace.json`) + plugin manifest/skill/bundle-bağlantı testleri (`plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`) yeşil; GUI içi kurulum+tools/list adımları README'de belgeli, bu oturumda koşulmadı | ✅ Aynı süreç stdio disiplini (birim testi `stdio-stdout.test.ts`); host UI içi gözlem KOŞULMADI | MANIFEST DOĞRULAMA — GUI kurulum koşulmadı (F2) |
| Antigravity | ❌ **NOT RUN** — `agy` CLI bu makinede YOK (`agy --version` → command not found; `command -v agy` boş; Antigravity IDE kurulu fakat CLI çalıştırılabilir'i yok) | ❌ **NOT RUN** — `agy plugin validate/install/list` ve tool discovery hiçbiri koşulmadı (TŞ §22 kuralı: "agy CLI yoksa çalıştırılmadı diye açıkça raporla"); `plugin.json` + `mcp.json` TŞ §17.1'den birebir yazıldı ve statik testlerle denetlendi (`antigravity-plugin.test.ts`) | ❌ **NOT RUN** — host UI içi stdout gözlemi yapılamadı (sunucu sürecinin kendi stdio disiplini birim testli) | NOT RUN (F5 — agy CLI yok; ADR-010: koşulmayan Done yazılmaz) |

## Host-bağımsız paket kontrolleri (matrix'i tamamlayan kanıtlar)

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| F1 bundle determinizmi | ✅ İki build bit-bit aynı; manifest (33 dosya, sıralı sha256) `mcp-server.mjs` ile birebir | `packages/mcp-server/test/bundle.test.ts`; `tests/hosts-docs.test.ts` manifest sha256 karşıtlığı |
| F6 güvenlik turu (paketlenmiş bundle, TŞ §22 matrisi) | ✅ 9/9 satır PASS (traversal/symlink, secret leakage, TOCTOU, prompt injection, oversized, malicious refs, network denied, offline XSS/CSP, stdout disiplini) | `docs/security-pass.md`; `npx vitest run tests/security-release/f6-security-release.test.ts` → 26/26 |
| F7 performans (1k dosya fixture, MCP protokol düzeyi) | ✅ Medyanlar: workspace_summary 5.3 ms, sembol bağlamı 8.2 ms, 200-node map 5.7 ms — TŞ §21 referans hedeflerinin içinde (hedef tasarım değeri, sonuç değil) | `docs/benchmarks.md`; `tests/bench-release/benchmark.test.ts` |
| Stdio stdout hijyeni (birim) | ✅ stdout yalnızca MCP protokolü; loglar `[causoryn]` önekiyle stderr | `packages/mcp-server/test/stdio-stdout.test.ts` |

## Dürüstlük notları

1. **3 hosttan 2'si gerçek koşumla doğrulandı; Antigravity koşulamadı.** TŞ §23
   Faz F kapısındaki "3 host kurulum testleri" kalemi bu nedenle 2/3 ile
   raporlanır; kalan 1/3 NOT RUN'dır ve `docs/hosts/antigravity.md`'de koşulacak
   komut listesiyle açık tutulur (agy CLI kurulduğunda matris güncellenir).
2. **ZCode satırı bilinçli olarak manifest-düzeyindedir:** kırmızı çizgi 6,
   smoke testlerin kullanıcının gerçek ZCode kurulumuna kalıcı değişiklik
   bırakmasını yasaklar; GUI-only kurulum bu kısıtla koşulamaz. Kurulum
   adımları (`integrations/zcode/causoryn/README.md` Installation) GUI
   yol tarifidir ve bu oturumda yürütülmedi.
3. **stdout temizliği iki katmandır:** her hostta aynı bundle koştuğundan
   süreç-düzeyi disiplin tek kanıtla taşınır (birim test + F6'nın 4 bağımsız
   spawn oturumu + Claude/Codex manuel doğrulamaları); host UI içi gözlem
   yalnızca Claude Code ve Codex'te yapılabildi.
4. **Windows-düzeyi doğrulama:** bu matristeki tüm koşumlar Windows x64
   üzerindedir; macOS/Linux/ARM dağıtım hedefleri (TŞ §22 Release satırı) bu
   sprintte koşulmadı — sürüm kararında açık kalem olarak sayılır.
5. **Uyum/güven ilkesi (TŞ §17.4):** hostlar arası davranış eşitliği MCP tool
   schema + contract testleriyle sağlanır; host UI/permission özdeşliği iddia
   edilmez. Causoryn host modelin tool seçimini zorlayamaz.

## İlgili sayfalar

- [docs/hosts/claude-code.md](hosts/claude-code.md) · [docs/hosts/codex.md](hosts/codex.md) · [docs/hosts/antigravity.md](hosts/antigravity.md) · `integrations/zcode/causoryn/README.md`
- [docs/security-pass.md](security-pass.md) · [docs/benchmarks.md](benchmarks.md) · [docs/tool-contracts.md](tool-contracts.md)
- [docs/implementation-status.md](implementation-status.md) — Sprint 7 bölümü ve F9 sürüm kararı
