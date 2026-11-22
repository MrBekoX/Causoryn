# Antigravity host entegrasyonu — plugin.json + mcp_config.json + mcp.json

> **Dil / Language:** Türkçe · [English](../en/hosts/antigravity.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> Kanıt: raw/Causoryn_Teknik_Dokuman_v2.1.pdf (TŞ v2.1 §17.1 "Antigravity plugin (birincil paket)", §17.4 uyum/güven matrisi, §22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla") · Antigravity yerleşik eklenti dokümantasyonu (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md`) · `packages/causoryn` (K-021 tek dağıtım paketi) · `integrations/antigravity/causoryn/plugin.json` · `integrations/antigravity/causoryn/mcp_config.json` · `integrations/antigravity/causoryn/mcp.json` · `integrations/antigravity/causoryn/README.md` · `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`

## Son Kullanıcı Hızlı Kurulumu (Önerilen — K-021 / `v0.2.2`)

```bash
# Değişiklikleri önceden görmek için (salt okunur)
npx causoryn@0.2.2 setup --client antigravity --dry-run

# ~/.gemini/config/mcp_config.json + ~/.gemini/config/skills/ kurulumu (.causoryn.backup yedeğiyle)
npx causoryn@0.2.2 setup --client antigravity --yes

# Sağlık kontrolü (salt okunur)
npx causoryn@0.2.2 doctor

# Temiz kaldırma (mcpServers.causoryn + 4 yönlendirme skill dosyası)
npx causoryn@0.2.2 setup --client antigravity --uninstall --yes
```

Not: `~/.gemini/antigravity/mcp_config.json` ikincil konfigürasyon dosyası diskte mevcutsa `causoryn setup` ve `causoryn doctor` bu dosyayı da birincil `~/.gemini/config/mcp_config.json` ile senkronize biçimde günceller ve doğrular. Ya da doğrudan kök depodan (`https://github.com/MrBekoX/Causoryn`, kök `plugin.json` + `mcp_config.json`) kurun. Aşağıdaki `integrations/antigravity/causoryn/` bölümü, monorepo içi sahnelenmiş F1 bundle test fikstürünü ve TŞ §17.1 / §22 doğrulama kayıtlarını belgeler.

## Dürüstlük beyanı — NOT RUN (`agy` CLI) vs Doğrudan `stdio` Protokol Doğrulaması

**agy CLI bulunamadı — bu hostta kurulum/smoke koşulmadı.**

Makine kanıtı (2026-11-08 / 2026-11-18):

- Antigravity **IDE'si kurulu**: `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` (Electron uygulaması) — ancak `agy` adında bir çalıştırılabilir yok: dizin listesinde `agy*` eşleşmesi bulunamadı, `bin/` alt dizini yok.
- `agy --version` → `bash: line 3: agy: command not found`
- `command -v agy` → boş çıktı.

TŞ §22 kuralı uygulanır: *"agy CLI yoksa çalıştırılmadı diye açıkça raporla."* (PDF s.23'te bu cümle §22 "Dikey dilim kabul testi" paragrafının kapanışıdır; hemen ardından "23. Geliştirme fazları" başlığı gelir — bölüm atfı §22'dir.)

**Dürüst doğrulama ayrımı (ADR-010, kırmızı kural 5):**

1. **Doğrudan `stdio` protokol doğrulaması (OTOMATİK TESTTE KOŞULDU):** `npm run build:bundle --workspace packages/mcp-server` ile `integrations/antigravity/causoryn/scripts/mcp-server.mjs` (+ vendored `better-sqlite3`) sahnelendiğinde, `antigravity-plugin.test.ts` doğrudan eklenti kökünde (`cwd: PLUGIN_DIR`) `mcp_config.json` içindeki `command` + `args` + `env` ile gerçek `child_process.spawn` el sıkışması koşar: `initialize` → `causoryn@0.2.2`, `tools/list` → 29 araç, `causoryn_get_capabilities` → `status: "ok"`, `causoryn_workspace_summary` → `WORKSPACE_NOT_AUTHORIZED` ve `stdout` üzerinde yalnızca JSON-RPC 2.0 satırları doğrulanır.
2. **`agy` CLI kurulum/smoke komutları (NOT RUN):** Aşağıdaki `agy plugin validate --strict`, `agy plugin install` ve `agy plugin list` adımları TŞ §17.1'den alınmış **doküman örnekleridir; bu makinede `agy` CLI bulunmadığından hiçbiri çalıştırılmamıştır** (`NOT RUN`) ve hiçbir CLI/IDE kurulum kanıtı üretilmemiştir.

## Ön koşullar

1. **agy CLI (Antigravity komut satırı aracı)** — CLI tabanlı `validate`/`install`/`list` akışı için gerekir; bu makinede YOK (`NOT RUN`). Yerleşik Antigravity eklenti yükleyicisi ise doğrudan eklenti dizinindeki `plugin.json` + `mcp_config.json` dosyalarını okur.
2. **Node.js ≥ 24** (kök `package.json` → `engines.node`).
3. **Derlenmiş ve sahnelenmiş bundle**: `npm run build:bundle --workspace packages/mcp-server` (script kök `package.json`'da YOK; yalnızca `packages/mcp-server/package.json` → `scripts.build:bundle` tanımlıdır — çıplak kök koşumu `Missing script` verir). Bu komut hem `packages/mcp-server/dist/` altında 35 girdili `bundle-manifest.json` + `mcp-server.mjs` + `mcp-server.mjs.LEGAL.txt` + `node_modules/better-sqlite3/` üretir hem de adım 4 olarak aynı çıktıları deterministik biçimde `integrations/antigravity/causoryn/scripts/` altına temizleyip kopyalar (`scripts/mcp-server.mjs`, `scripts/mcp-server.mjs.LEGAL.txt`, `scripts/node_modules/better-sqlite3/{LICENSE,package.json,lib,prebuilds}`, `scripts/bundle-manifest.json`; `.gitignore` ile sürüm kontrolü dışında tutulur). Dürüst paketleme iddiası (ADR-010): artefakt **tek dosya değildir** — `better-sqlite3` NATİF modüldür, `esbuild` native `.node` dosyasını gömemez; `mcp-server.mjs` + yanındaki vendored `node_modules/better-sqlite3` birlikte taşınır.

## Paket düzeni — TŞ §17.1 + Yerel Antigravity Yükleyicisi Çift Uyumluluk

| Hedef bileşen (`integrations/antigravity/causoryn/`) | Durum |
|---|---|
| `plugin.json` | ✅ VAR (`$schema` çıkarıldı; yalnızca yerel yükleyicinin izin verdiği alanlar) |
| `mcp_config.json` | ✅ VAR (yerleşik Antigravity eklenti yükleyicisinin okuduğu birincil MCP tanımı; `scripts/mcp-server.mjs`) |
| `mcp.json` | ✅ VAR (TŞ §17.1 taşınabilir manifest karşılığı; `${PLUGIN_ROOT}/scripts/mcp-server.mjs`) |
| `README.md` | ✅ VAR (kullanıcıya dönük kurulum, güvenlik ve `NOT RUN` dokümanı) |
| `scripts/mcp-server.mjs` (+ `scripts/node_modules/better-sqlite3/` + `scripts/bundle-manifest.json`) | ✅ `npm run build:bundle --workspace packages/mcp-server` ile deterministik sahnelenir (`.gitignore`'da; repoya commit edilmez) |
| `skills/` (`map-system`, `trace-flow`, `preflight-change`) | ⚠️ Monorepo fikstüründe yok; kanonik 4 skill (`causoryn`, `map-system`, `preflight-change`, `verify-change`) kök `skills/` ve `packages/causoryn` paketinde yayımlanır |
| `agents/`, `rules/`, `hooks.json` | ❌ yok (ayrı dilim) |

**Çift manifest ve yol çözümlemesi kararı:**
- Yerleşik Antigravity eklenti yükleyicisi (`agy-customizations/docs/plugins.md` ve `plugin/SKILL.md:200-266`) eklenti kökünde **`mcp_config.json`** dosyasını okur ve eklenti-içi göreli `"scripts/mcp-server.mjs"` yolunu çalıştırır.
- TŞ §17.1 taşınabilir eklenti sözleşmesi ise **`mcp.json`** içinde `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` yolunu tanımlar. Eski kırılgan repo-içi üst-dizin yolu kaldırılmış; her iki manifest de sahnelenmiş `scripts/mcp-server.mjs` girişinde birleştirilmiştir.
- MCP sunucu adları Antigravity genelinde global ad alanını paylaştığından (`plugin/SKILL.md:304-306`), diğer eklentilerle çakışmayı önlemek üzere her iki dosyada da sunucu anahtarı generic `engine` yerine eklenti adıyla (**`causoryn`**) tanımlanır.

## plugin.json (tam örnek — repodaki dosyanın birebir içeriği)

```json
{
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.2.2",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

Alanlar ve `$schema` temizliği gerekçesi:

| Alan | Değer | Kaynak |
|---|---|---|
| `name` | `causoryn` | Yerel yükleyici global benzersiz anahtar + TŞ §17.1 |
| `displayName` | `Causoryn` | Yerel yükleyici UI başlığı + TŞ §17.1 |
| `version` | `0.2.2` | TŞ §17.1 + `packages/mcp-server/src/version.ts` (`SERVER_VERSION`) |
| `description` | `Local, evidence-backed codebase and change intelligence via MCP.` | TŞ §17.1 |
| `suggestedPrompts` | TŞ §17.1'deki üç prompt, birebir | Yerel yükleyici kart/detay görünümü + TŞ §17.1 |

**`$schema` neden çıkarıldı?** Yerleşik Antigravity eklenti yükleyicisi (`plugin/SKILL.md:228-266`) yalnızca `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`, `homepage`, `repository` ve `disabled` üst-düzey alanlarını kabul eder; bunun dışındaki bilinmeyen üst-düzey alanları (`$schema` ve `mcpServers` dahil) **sessizce atar** (*"Unknown top-level fields are silently discarded by the loader"*). Test doğrulayıcısı bu izinli listeyi zorunlu kılar ve `$schema` veya `mcpServers` eklendiğinde açık hatayla reddeder.

## mcp_config.json (birincil — yerleşik Antigravity eklenti yükleyicisi)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "scripts/mcp-server.mjs"
      ],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

## mcp.json (TŞ §17.1 taşınabilir eklenti manifesti karşılığı)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/scripts/mcp-server.mjs"
      ],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

Alanlar ve bilinçli sözleşme kuralları:

| Alan | Değer | Kaynak |
|---|---|---|
| `mcpServers.causoryn` | sunucu anahtarı `causoryn` (global çakışmasızlık kuralı; generic sunucu adı kullanılmaz) | `plugin/SKILL.md` + TŞ §17.1 uyarlaması |
| `command` | `node` — yerel `stdio` süreç; LLM/API çağrısı yok | TŞ §17.1 + kırmızı kural 1 |
| `args[0]` | `mcp_config.json`: `"scripts/mcp-server.mjs"` · `mcp.json`: `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` — sahnelenmiş derlenmiş `esbuild` bundle; kaynak `.ts` işareti ve üst-dizin kaçışı YASAK | Yerel yükleyici + TŞ §17.1 |
| `env.CAUSORYN_CONFIG` | `{"allowRoots":[]}` — **default deny**: gerçek `parseCausorynServerConfig` (`z.strictObject` + mutlak `allowRoots`) şemasından geçer; hiçbir kök yetkisizken workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner | TŞ §9/§20; `packages/mcp-server/src/config.ts` + `stdio.ts` |

**Çıplak `stdio.ts` vs Paketlenmiş `cli-stdio.ts` ayrımı (`--data-dir` / `--allow-cwd`):**
- **Çıplak F1 monorepo girişi (`packages/mcp-server/src/stdio.ts`, bu `integrations/antigravity/causoryn/` fikstürünün kullandığı giriş):** argv okumaz — konfigürasyonun tek kaynağı yalnızca `CAUSORYN_CONFIG` ortam değişkenidir (`process.argv` işleme kodu yoktur; bu yüzden buradaki `mcp.json` içinde `--data-dir` bulunmaz ve wiki/graph veri kökü `CAUSORYN_CONFIG` üzerinden beyan edilir).
- **Paketlenmiş dağıtım girişi (`packages/causoryn/dist/mcp-server.mjs`, `packages/mcp-server/src/cli-stdio.ts`):** K-021 ile son kullanıcı dağıtımı için sıfır-ayar CLI bayraklarını (`--allow-cwd`, `--auto-data-dir`, `--data-dir`, `--client antigravity`) ve masaüstü IDE dinamik MCP `roots/list` bağlamasını destekler (`npx causoryn@0.2.2 setup --client antigravity --yes` bu paketlenmiş girişi yapılandırır).

**Çapraz host kuralı (TŞ §17.1, PDF s.19):** *"mcp.json'u farklı host'lara aynen kopyalama."* Bu kablolama Claude Code (`.mcp.json` → `docs/hosts/claude-code.md`) ve Codex (`.codex/config.toml` / `codex mcp add` → `docs/hosts/codex.md`) tarafına birebir taşınmaz; her host kendi token ve yol şemasıyla ayrı yazılır.

## Kurulum adımları — doküman örneği, NOT RUN

```bash
# 0) Bundle'ı üret ve Antigravity scripts/ dizinine sahnele — deterministik
#    (script kökte yoktur; --workspace nitelemesi ZORUNLUDUR)
npm run build:bundle --workspace packages/mcp-server

# 1) Manifest doğrulama (TŞ §17.1) — agy CLI GEREKTİRİR; bu makinede KOŞULMADI (NOT RUN)
agy plugin validate --strict ./integrations/antigravity/causoryn

# 2) Kurulum — KOŞULMADI (NOT RUN)
agy plugin install ./integrations/antigravity/causoryn

# 3) Listeleme — KOŞULMADI (NOT RUN)
agy plugin list

# 4) Tool discovery — agy üzerinden KOŞULMADI (NOT RUN). Doğrudan stdio spawn testinde
#    29 araç (TOOL_NAMES, packages/mcp-server/src/version.ts) doğrulandı.
```

Bu komutlar TŞ §17.1'deki cümlenin aynısıdır: *"Komutlar doküman örneğidir, bu doküman hazırlanırken çalıştırılmış değildir."* `agy` CLI kurulduğunda adım 1'den itibaren gerçek CLI koşumu yapılır ve sonuçlar aşağıdaki matrise işlenir.

**Temizlik protokolü (kırmızı kural 6):** Bu adımlar koşulduğunda kullanıcının gerçek config'ine kalıcı değişiklik bırakılmaz: kurulum belirgin test kapsamında yapılır ve **smoke sonunda plugin kaldırılır** — `agy` kaldırma komutu CLI'da doğrulanınca smoke sonunda plugin kaldırılır; kaldırma komutunun gerçek adı bu makinede `agy` CLI olmadığından doğrulanamadı (`NOT RUN`). Bu disiplin, aynı Faz'daki claude (`claude mcp remove` → `docs/hosts/claude-code.md`) ve codex (`codex mcp remove` + yedek/hash disiplini → `docs/hosts/codex.md`) dokümanlarındaki temizlik adımlarının Antigravity karşılığıdır.

## Konfigürasyon: CAUSORYN_CONFIG

Çıplak `stdio.ts` girişi için konfigürasyonun tek kaynağı `CAUSORYN_CONFIG` ortam değişkenidir (JSON, `parseCausorynServerConfig` katı şeması). Örnekler:

```bash
# Workspace kökü yetkilendirme (salt okunur analiz; default deny'den çıkış)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'

# Wiki yazma kökü beyanı — İZİNLİ data-root, workspace kökünün DIŞINDA (TŞ §16A.8)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"],"wiki":{"dataDbPath":"/path/to/causoryn-data/wiki.sqlite3"}}'
```

- `${PLUGIN_ROOT}` salt okunur kurulum köküdür; workspace yolu `${PLUGIN_ROOT}` ile karıştırılmaz ve kökler kullanıcı tarafından `allowRoots` içinde mutlak yollarla açıkça yetkilendirilir (TŞ §17.1).
- Kırmızı kural 2: yazma yalnızca izinli data-root/output dizinine; workspace salt okunurdur (`wiki_build`/`export` yazma beyanları olmadan `PATH_DENIED`/`EXPORT_NOT_ALLOWED` döner).

## Uyum/güven matrisi — Antigravity satırı (TŞ §17.4)

| Entegrasyon | Model kullanımı | MCP kurulum | Uyum testleri | Bu makinedeki durum |
|---|---|---|---|---|
| Antigravity | Seçili Antigravity modeli (Causoryn model seçmez/ayarlamaz) | Plugin: `plugin.json` + `mcp_config.json` (yerel yükleyici) + `mcp.json` (TŞ §17.1) veya `npx causoryn@0.2.2 setup --client antigravity --yes` | Doğrudan `stdio` spawn doğrulandı (29 araç); `agy validate`/`install`/`list` | **NOT RUN — agy CLI bulunamadı** (doğrudan `stdio` protokol el sıkışması testte geçti) |

TŞ §17.4: ajanlar arası davranış eşitliği MCP tool schema + contract testleriyle sağlanır; host UI/permission özdeşliği iddia edilmez. Host modelin tool seçimi isteğe ve model yeteneğine bağlıdır; Causoryn çağrıları zorla çalıştıramaz.

## Açık kalemler (F5 `agy` CLI ayağı kapanmadı — Done ilan edilmez, ADR-010)

1. **agy CLI kurulduğunda koşulacaklar (NOT RUN listesi):** `agy plugin validate --strict`, `agy plugin install`, `agy plugin list`, Antigravity host üzerinden canlı tool discovery (29 araç beklentisi), temsilî `map_system`/`preflight_change`/`verify_change` çağrıları ve kapanış temizliği (`smoke sonunda plugin kaldırılır`, kullanıcı config'ine `kalıcı değişiklik bırakılmaz`).
2. **İsteğe bağlı eklenti özelleştirmeleri:** `agents/`, `rules/`, `hooks.json` — ayrı dilim.

## İlgili dosyalar

- `integrations/antigravity/causoryn/plugin.json` — yayımlanan eklenti manifest'i (`$schema`'sız yerel yükleyici uyumlu)
- `integrations/antigravity/causoryn/mcp_config.json` — yerleşik Antigravity eklenti yükleyicisi birincil MCP tanımı
- `integrations/antigravity/causoryn/mcp.json` — TŞ §17.1 taşınabilir MCP manifest karşılığı
- `integrations/antigravity/causoryn/README.md` — kullanıcıya dönük kurulum ve güvenlik dokümanı
- `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` — manifest şeması (`parseCausorynServerConfig`), sahnelenmiş `stdio` spawn, negatif ve dürüstlük testleri
- `packages/mcp-server/scripts/build-bundle.mjs` — `dist/` üretimi + `integrations/antigravity/causoryn/scripts/` deterministik sahnelemesi
- `docs/hosts/` diğer host sayfaları: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [ZCode](zcode.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md) · [English version](../en/hosts/antigravity.md)
