# Antigravity host entegrasyonu — plugin.json + mcp.json

> Kanıt: raw/Causoryn_Teknik_Dokuman_v2.1.pdf (TŞ v2.1 §17.1 "Antigravity plugin (birincil paket)", §17.4 uyum/güven matrisi, §22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla") · `integrations/antigravity/causoryn/plugin.json` · `integrations/antigravity/causoryn/mcp.json` · `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`

## Dürüstlük beyanı — NOT RUN

**agy CLI bulunamadı — bu hostta kurulum/smoke koşulmadı.**

Makine kanıtı (2026-11-08, Git Bash, aynı oturumda koşuldu):

- Antigravity **IDE'si kurulu**: `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` (Electron uygulaması) — ancak `agy` adında bir çalıştırılabilir yok: dizin listesinde `agy*` eşleşmesi bulunamadı, `bin/` alt dizini yok.
- `agy --version` → `bash: line 3: agy: command not found`
- `command -v agy` → boş çıktı.

TŞ §22 kuralı uygulanır: *"agy CLI yoksa çalıştırılmadı diye açıkça raporla."* (PDF s.23'te bu cümle §22 "Dikey dilim kabul testi" paragrafının kapanışıdır; hemen ardından "23. Geliştirme fazları" başlığı gelir — bölüm atfı §22'dir.) Bu nedenle aşağıdaki **tüm** kurulum/smoke komutları TŞ §17.1'den birebir alınmış **doküman örnekleridir; bu oturumda hiçbiri çalıştırılmamıştır** ve hiçbir koşum kanıtı üretilmemiştir (ADR-010: çalışmayan/koşulmayan şey Done ilan edilmez; uydurma kanıt yasak — kırmızı kural 5).

## Ön koşullar

1. **agy CLI (Antigravity komut satırı aracı)** — bu makinede YOK. Aşağıdaki adımlar ancak agy mevcutken koşulabilir.
2. **Node.js ≥ 24** (kök `package.json` → `engines.node`).
3. **Derlenmiş bundle** (Sprint-7 F1): `npm run build:bundle --workspace packages/mcp-server` (script kök `package.json`'da YOK; yalnızca `packages/mcp-server/package.json` → `scripts.build:bundle` tanımlıdır — çıplak kök koşumu `Missing script` verir) → `packages/mcp-server/dist/mcp-server.mjs` + `packages/mcp-server/dist/node_modules/better-sqlite3/` (lib JS + prebuilds). Dürüst paketleme iddiası (ADR-010): artefakt **tek dosya değildir** — better-sqlite3 NATİF modüldür, esbuild native `.node` dosyasını gömemez; `mcp-server.mjs` + yanındaki vendored `node_modules/better-sqlite3` birlikte taşınır.

## Paket düzeni — TŞ §17.1 hedefi vs bu dilimin gerçek durumu

| TŞ §17.1 hedef düzeni (`integrations/antigravity/causoryn/`) | Bu dilimde |
|---|---|
| `plugin.json` | ✅ VAR |
| `mcp.json` | ✅ VAR |
| `README.md` | ❌ yok (bu dilim kapsamı: plugin.json + mcp.json + `docs/hosts/antigravity.md`) |
| `scripts/mcp-server.mjs` — derlenmiş gerçek başlangıç noktası | ❌ **henüz pakete vendor edilmedi** — `mcp.json` repo düzenindeki F1 bundle'ına işaret eder (aşağıdaki "Yol çözümlemesi" notuna bakın) |
| `skills/` (map-system, trace-flow, preflight-change SKILL.md'leri) | ❌ yok |
| `agents/`, `rules/`, `hooks.json` | ❌ yok |

→ **Açık kalem:** TŞ §17.1 kuralı *"Eklenti paketinde scripts/mcp-server.mjs gerçekten derlenmiş olmalı; root'taki kaynak TS dosyasına işaret edilemez."* F1 bundle derlenmiş ve çalışır durumdadır, ama henüz paket içine kopyalanmamıştır; yayın dağıtımı (Sprint-7 F9) bundle'ı `scripts/` altına vendor edip `args`'ı `${PLUGIN_ROOT}/scripts/mcp-server.mjs`'e taşımalıdır.

**Yol çözümlemesi (dürüst not):** Bu dilimde `mcp.json` repo checkout düzenini varsayar: `${PLUGIN_ROOT}` = `integrations/antigravity/causoryn` olduğunda `../../../packages/mcp-server/dist/mcp-server.mjs` repo kökündeki F1 bundle'ına çözümlenir (ZCode plugin'indeki `${CLAUDE_PLUGIN_ROOT}/../../..` örüntüsüyle aynı). `agy plugin install` paketi başka bir konuma kopyalıyorsa bu göreli yol çözümlenMEZ — dağıtım senaryosunda mutlak yol ya da F9 vendoring şarttır. Bu çözümleme davranışı agy CLI olmadığından **doğrulanamadı** (NOT RUN); test dosyası yalnızca repo-düzeni çözümlemesini diskte var olan bundle'a karşı denetler (bundle yoksa test açık sebeple skip olur — üretilmemiş artefakt "geçti" sayılmaz).

## plugin.json (tam örnek — repodaki dosyanın birebir içeriği)

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.1.0",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

Alanlar — TŞ §17.1 örnek manifest'i ile birebir:

| Alan | Değer | Kaynak |
|---|---|---|
| `$schema` | `https://antigravity.google/schemas/v1/plugin.json` | TŞ §17.1 |
| `name` | `causoryn` | TŞ §17.1 |
| `displayName` | `Causoryn` | TŞ §17.1 |
| `version` | `0.1.0` | TŞ §17.1 + `packages/mcp-server/src/version.ts` (`SERVER_VERSION`) |
| `description` | `Local, evidence-backed codebase and change intelligence via MCP.` | TŞ §17.1 |
| `suggestedPrompts` | TŞ §17.1'deki üç prompt, birebir | TŞ §17.1 |

**ZCode plugin.json'dan uyarlama notu:** ZCode paketi (`integrations/zcode/causoryn/.zcode-plugin/plugin.json`) `mcpServers`'ı plugin.json **içine gömer**; Antigravity formatı (TŞ §17.1) ise sunucu kablolamasını **ayrı `mcp.json`'a** koyar. Uyarlamada ZCode'a özgü `userConfig` (CAUSORYN_CONFIG'u kullanıcıdan alma mekanizması) ve `skills` alanları Antigravity tarafına taşınmadı: `userConfig` token çözümlemesi (`${user_config.config_json}`) agy CLI olmadığından bu hostta doğrulanamaz — uyarlanabilirliği kanıtlanmayan alan yayımlanmaz (kırmızı kural 5). Sunucu kablolaması `mcp.json`'dadır; `plugin.json` bilinçli olarak `mcpServers` TAŞIMAZ (negatif test ile sabit).

## mcp.json (tam örnek — repodaki dosyanın birebir içeriği)

```json
{
  "mcpServers": {
    "engine": {
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs"
      ],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

Alanlar:

| Alan | Değer | Kaynak |
|---|---|---|
| `mcpServers.engine` | sunucu anahtarı `engine` | TŞ §17.1 örnek mcp.json |
| `command` | `node` — yerel stdio süreç; LLM/API çağrısı yok | TŞ §17.1 + kırmızı kural 1 |
| `args[0]` | `${PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs` — **derlenmiş** esbuild bundle (F1); kaynak `.ts` işareti YASAK | TŞ §17.1 kuralı; yol bu dilimin repo-düzeni uyarlaması (yukarıdaki dürüst not) |
| `env.CAUSORYN_CONFIG` | `{"allowRoots":[]}` — **default deny**: hiçbir kök yetkisiz; workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner | TŞ §9/§20; `packages/mcp-server/src/stdio.ts` |

**İki bilinçli sapma (dürüstlük):**

1. **`--data-dir` YOK.** TŞ §17.1 örnek mcp.json'u `args: ["${PLUGIN_ROOT}/scripts/mcp-server.mjs", "--data-dir", "${PLUGIN_DATA}"]` gösterir; ancak **yayımlanan sunucu argv okumaz** — `packages/mcp-server/src/stdio.ts` konfigürasyonun tek kaynağı olarak yalnızca `CAUSORYN_CONFIG` ortam değişkenini okur (başka argv işleme kodu yoktur). `--data-dir` koymak sessizce etkisiz bir argüman olurdu. Wiki veri kökü bu yüzden `CAUSORYN_CONFIG.wiki.dataDbPath` ile beyan edilir (mutlak yol, workspace kökünün DIŞINDA; ihlal sunucuyu düşürür). Sapma test ile sabitlenmiştir (negatif test: `"--data-dir" argv TAŞIMAZ`).
2. **`env` alanı doğrulanamayan tek alandır.** `env`, MCP stdio sunucu-config konvansiyonudur (ZCode plugin'inde aynı alan kullanılır), ancak Antigravity yükleyicisinin `env` çözümleyip çözümlemediği agy CLI olmadığından sınanamadı (NOT RUN). Desteklenmediği takdirde: `CAUSORYN_CONFIG`'u işletim sistemi düzeyinde ortam değişkeni olarak verin — sunucu env'siz de güvenli başlar (default deny; `WORKSPACE_NOT_AUTHORIZED`).

**Çapraz host kuralı (TŞ §17.1, PDF s.19):** *"mcp.json'u farklı host'lara aynen kopyalama."* Bu kablolama Claude Code (`.mcp.json` → `docs/hosts/claude-code.md`) ve Codex (`.codex/config.toml` / `codex mcp add` → `docs/hosts/codex.md`) tarafına birebir taşınmaz; her host kendi token şemasıyla (`${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` / TOML mutlak yolları) ayrı yazılır.

## Kurulum adımları — doküman örneği, NOT RUN

```bash
# 0) Bundle'ı üret (Sprint-7 F1) — deterministik; iki koşum bit-bit aynı manifest
#    (script kökte yoktur; --workspace nitelemesi ZORUNLUDUR)
npm run build:bundle --workspace packages/mcp-server

# 1) Manifest doğrulama (TŞ §17.1) — agy CLI GEREKTİRİR; bu makinede KOŞULMADI
agy plugin validate --strict ./integrations/antigravity/causoryn

# 2) Kurulum — KOŞULMADI
agy plugin install ./integrations/antigravity/causoryn

# 3) Listeleme — KOŞULMADI
agy plugin list

# 4) Tool discovery — KOŞULMADI. Beklenen: 29 araç (TOOL_NAMES,
#    packages/mcp-server/src/version.ts; katalog: wiki/mcp-tools.md)
```

Bu komutlar TŞ §17.1'deki cümlenin aynısıdır: *"Komutlar doküman örneğidir, bu doküman hazırlanırken çalıştırılmış değildir."* agy CLI kurulduğunda adım 1'den itibaren gerçek koşum yapılır; sonuçlar (hangi Antigravity sürümünün hangi manifest/MCP tanım kombinasyonunu istediği dahil — TŞ §17.1: eski belgeler `mcp_config.json` gösterir) aşağıdaki matrise işlenir.

**Temizlik protokolü (kırmızı kural 6):** Bu adımlar koşulduğunda kullanıcının gerçek config'ine kalıcı değişiklik bırakılmaz: kurulum belirgin test kapsamında yapılır ve **smoke sonunda plugin kaldırılır** — agy kaldırma komutu CLI'da doğrulanınca smoke sonunda plugin kaldırılır; kaldırma komutunun gerçek adı bu makinede agy CLI olmadığından doğrulanamadı (NOT RUN). Bu disiplin, aynı Faz'daki claude (`claude mcp remove` → `docs/hosts/claude-code.md`) ve codex (`codex mcp remove` + yedek/hash disiplini → `docs/hosts/codex.md`) dokümanlarındaki temizlik adımlarının Antigravity karşılığıdır.

## Konfigürasyon: CAUSORYN_CONFIG

Sunucu konfigürasyonunun tek kaynağı `CAUSORYN_CONFIG` ortam değişkenidir (JSON). Örnekler:

```bash
# Workspace kökü yetkilendirme (salt okunur analiz; default deny'den çıkış)
CAUSORYN_CONFIG='{"allowRoots":["C:/projects/my-app"]}'

# Wiki yazma kökü beyanı — İZİNLİ data-root, workspace kökünün DIŞINDA (TŞ §16A.8)
CAUSORYN_CONFIG='{"allowRoots":["C:/projects/my-app"],"wiki":{"dataDbPath":"C:/causoryn-data/wiki.sqlite3"}}'
```

- `${PLUGIN_ROOT}` salt okunur kurulum köküdür; `${PLUGIN_DATA}` kalıcı index/artifact dizinidir (TŞ §17.1). Bu dilimin `mcp.json`'u `${PLUGIN_DATA}` **kullanmaz** — sunucu argv okumadığından veri kökü `CAUSORYN_CONFIG.wiki.dataDbPath` ile mutlak yoldan beyan edilir (yukarıdaki sapma notu 1).
- Workspace yolu `${PLUGIN_ROOT}` ile karıştırılmaz; kökler kullanıcı tarafından `allowRoots` ile açıkça yetkilendirilir. Plugin kökünün workspace'e erişimi otomatik/unrestricted varsayılmaz (TŞ §17.1).
- Kırmızı kural 2: yazma yalnızca izinli data-root/output dizinine; workspace salt okunurdur (`verify`/`wiki_build`/`export` yazma beyanları olmadan `PATH_DENIED`/`EXPORT_NOT_ALLOWED` döner).

## Uyum/güven matrisi — Antigravity satırı (TŞ §17.4)

| Entegrasyon | Model kullanımı | MCP kurulum | Uyum testleri | Bu makinedeki durum |
|---|---|---|---|---|
| Antigravity | Seçili Antigravity modeli (Causoryn model seçmez/ayarlamaz) | Plugin: `plugin.json` + sürüme uygun MCP tanımı | `agy validate`, tool discovery, map/preflight/verify | **NOT RUN — agy CLI bulunamadı** |

TŞ §17.4: ajanlar arası davranış eşitliği MCP tool schema + contract testleriyle sağlanır; host UI/permission özdeşliği iddia edilmez. Host modelin tool seçimi isteğe ve model yeteneğine bağlıdır; Causoryn çağrıları zorla çalıştıramaz.

## Açık kalemler (F5 kapanmadı — Done ilan edilmez, ADR-010)

1. **agy CLI kurulduğunda koşulacaklar (NOT RUN listesi):** `agy plugin validate --strict`, `agy plugin install`, `agy plugin list`, tool discovery (29 araç beklentisi), temsilî `map_system`/`preflight_change`/`verify_change` çağrıları, stdout-safi kontrolü (kural 4) ve kapanış temizliği: agy kaldırma komutu CLI'da doğrulanınca smoke sonunda plugin kaldırılır (kırmızı kural 6 — kullanıcı config'ine kalıcı değişiklik bırakılmaz). Tümü tamamlanmadan F5 Done yazılamaz.
2. **F9 release paketlemesi:** F1 bundle'ın `integrations/antigravity/causoryn/scripts/mcp-server.mjs` (+ vendored `node_modules/better-sqlite3`) altına vendor edilmesi ve `args`'ın `${PLUGIN_ROOT}/scripts/mcp-server.mjs`'e taşınması; TŞ §17.1 hedef düzeninin tam karşılanması.
3. **`env` çözümlemesi doğrulaması** ve kurulu Antigravity sürümünün `mcp_config.json` isteyip istemediğinin saptanması (TŞ §17.1 sürüm/yüzey farkı notu).
4. Paketin kalan parçaları (`README.md`, `skills/`, `agents/`, `rules/`, `hooks.json`) — ayrı dilim.

## İlgili dosyalar

- `integrations/antigravity/causoryn/plugin.json` — yayımlanan manifest (bu dokümandaki örneğin birebir kendisi)
- `integrations/antigravity/causoryn/mcp.json` — yayımlanan sunucu kablolaması
- `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` — pozitif + negatif + dürüstlük (NOT RUN beyanı) testleri
- `integrations/zcode/causoryn/.zcode-plugin/plugin.json` — uyarlamasının kaynağı olan ZCode plugin manifest'i
- `docs/hosts/` diğer host sayfaları (Claude Code F3, Codex F4) — ayrı dilimler
- `wiki/mcp-tools.md` — 29 araç kataloğu · `wiki/sprint-7.md` F5 · `wiki/decisions.md` K-002, ADR-010
