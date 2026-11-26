# Antigravity Host Entegrasyonu — `plugin.json` + `mcp_config.json` + `mcp.json`

> **Dil / Language:** **Türkçe** | [English](../en/hosts/antigravity.md) · [Dokümantasyon Merkezi](../README.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> **Durum:** Causoryn 0.3.2'i yansıtır (11 araçlı varsayılan `core` araç profili; tüm hostlar için workspace başına tek ortak `graph.sqlite`). Antigravity `agy` CLI ayağı **`NOT RUN`** durumundadır (bkz. bölüm 3).

> **Bu sayfa için kontrol edilen kaynaklar:** `packages/causoryn/src/{setup.ts,doctor.ts}`, kök `plugin.json` / `mcp_config.json` / `mcp.json` / `server.json`, `packages/causoryn/{plugin.json,mcp_config.json}`, `integrations/antigravity/causoryn/{plugin.json,mcp_config.json,mcp.json,README.md}`, `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`. Yükleyici davranışı, Antigravity'nin yerleşik eklenti dokümantasyonundan (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md`) alınmıştır.

Causoryn, kod istihbaratı için yerel ve deterministik bir MCP sunucusudur. Hiçbir LLM veya ağ API çağrısı yapmaz. Antigravity, kullanıcının seçtiği modeli kullanır; Causoryn hiçbir zaman model seçmez veya modeli geçersiz kılmaz.

## 1. Son kullanıcı için hızlı kurulum (`npx causoryn@0.3.2 setup`)

```bash
# Planlanan değişiklikleri hiçbir şey yazmadan önizle
npx causoryn@0.3.2 setup --client antigravity --dry-run

# Sunucuyu ~/.gemini/config/mcp_config.json içine kaydet ve 5 skill'i ~/.gemini/config/skills/ altına kur
npx causoryn@0.3.2 setup --client antigravity --yes

# Salt okunur sağlık ve hizalama kontrolü
npx causoryn@0.3.2 doctor --client antigravity

# Temiz kaldırma (mcpServers.causoryn + 5 Causoryn skill'i)
npx causoryn@0.3.2 setup --client antigravity --uninstall --yes
```

### `setup --client antigravity` neleri yazar

`setup`, birincil `~/.gemini/config/mcp_config.json` dosyasındaki `mcpServers` nesnesine `causoryn` anahtarını ekler ya da mevcut bir kaydın yalnızca `command` ve `args` alanlarını günceller (diğer anahtarları korunur); ikincil `~/.gemini/antigravity/mcp_config.json` dosyasına ise **yalnızca bu dosya zaten varsa** aynı işlemi uygular. Diğer anahtarlar korunur. Girdide `type` alanı yoktur:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "/path/to/node",
      "args": [
        "/home/you/.causoryn/runtime/scripts/causoryn.mjs",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "antigravity"
      ]
    }
  }
}
```

- **Algılama:** Antigravity yalnızca `~/.gemini/antigravity` veya `~/.gemini/config/mcp_config.json` mevcutsa algılanmış sayılır. Tek başına bir `~/.gemini` dizini (örneğin Gemini CLI'dan kalan) Antigravity olarak değerlendirilmez (`detectInstalledClients`; `tests/causoryn-setup.test.ts` kapsamında).
- **Mutlak Node binary'si:** `command`, `setup` komutunu çalıştıran Node.js'in `process.execPath` değeridir (Node.js ≥ 24 gerekir).
- **Kalıcı runtime:** `setup` bir `_npx` önbelleğinden veya işletim sisteminin geçici dizininden çalıştığında, paketi önce `~/.causoryn/runtime` altına kopyalar ve `args[0]` değerini oraya yönlendirir; böylece kayıt, `npx` önbelleği temizlendikten sonra da geçerli kalır.
- **Skill'ler:** `causoryn`, `map-system`, `preflight-change`, `verify-change` ve `architecture-blueprint`, `~/.gemini/config/skills/<name>/SKILL.md` altına yazılır (`--no-skill` bunları atlar). `architecture-blueprint`, seçili Antigravity modelinin MCP kanıtlarından isteğe bağlı `annotations` taslağı hazırlamasına rehberlik eder; sunucu, aynı snapshot ve export girdilerinden tekrarlanabilir çıktı üretir. Anotasyonsuz export için doğrudan `causoryn_export_documentation` çağırın ([mimari export sözleşmesi](../tool-contracts.md)). Skill'ler host modeli için rehber metinlerdir: bir skill'in andığı araç ancak etkin araç profili o aracı kaydediyorsa çağrılabilir. Setup'ın Causoryn'in kurduğunu kanıtlayamadığı mevcut bir `SKILL.md` (aynı adlı kendi skill'iniz ya da düzenlediğiniz bir Causoryn skill'i) korunur ve `skipped skill …` olarak raporlanır; kurulum kaydı `~/.causoryn/installed-skills.json` dosyasıdır ([CLI ve Konfigürasyon](../cli-and-configuration.md)).

### `setup` ve `doctor` nasıl davranır

- **Onay:** `--yes` (ve `--dry-run`) olmadan etkileşimli bir terminal planı gösterir ve `Continue? [y/N]` diye sorar; etkileşimsiz bir kabuk ise "confirmation required" hatasıyla durur ve hiçbir şey yazmaz.
- **Yedekler:** Mevcut bir config ilk kez değiştirilmeden önce özgün dosya, yanına `mcp_config.json.causoryn.backup` olarak kopyalanır. Bu dosyanın üzerine hiçbir zaman yazılmaz; sonraki değişiklikler ek `mcp_config.json.causoryn.<timestamp>-<nonce>.backup` kopyaları oluşturur.
- **Atomik, idempotent, fail-closed:** geçici dosya + rename, mevcut dosya modu korunarak (yeni dosyalar `0600`); aynı ikinci koşum `noop` raporlar; geçersiz JSON veya nesne olmayan bir `mcpServers`, koşumu `cli/malformed-json` ile durdurur; sembolik bağlantı hedefleri reddedilir. `setup` başarıda `0`, hiçbir host algılanmadığında ve hiçbiri adlandırılmadığında `1`, hatada `2` ile çıkar.
- **Kaldırma:** `mcpServers.causoryn` girdisini her iki dosyadan siler (boş bir `mcpServers` nesnesi kalır), sahipliği kanıtlanan Causoryn skill'lerini (düzenlenmiş veya yabancı bir `SKILL.md` korunur ve raporlanır) kaldırır ve başka hiçbir host config'i hâlâ referans vermiyorsa `~/.causoryn/runtime` dizinini de siler.
- **`doctor`** (salt okunur) Antigravity hostunu `OK`, `WARN`, `NOT-CONFIGURED` veya `ERROR` olarak raporlar. MCP girdisi birincil dosyada aranır; ikincil dosya varsa yalnızca geçerli JSON olup olmadığı ve kullanılabilir bir `causoryn.command` içerip içermediği denetlenir. Ayrıca Node.js ≥ 24, runtime dosyaları ve `dotnet` / `python` / `go` / `cargo` araç zincirleri kontrol edilir (eksik olanlar `l0-l1-fallback` olarak raporlanır; bu, o dil için dosya düzeyinde analiz anlamına gelir). Genel sonuç `HEALTHY`, `DEGRADED`, `NOT CONFIGURED` veya `UNHEALTHY` olur; çıkış kodu yalnızca `HEALTHY` için `0`'dır.

## 2. Depo kökünden veya npm paket dizininden kurulum

Son kullanıcılar Antigravity'nin eklenti yükleyicisini depo köküne (`https://github.com/MrBekoX/Causoryn`) veya kurulu bir `causoryn` npm paket dizinine de yönlendirebilir. Bu manifestler `tests/open-source-distribution.test.ts` ile doğrulanır; Antigravity içinde yüklenmeleri ise **çalıştırılmamıştır** (bölüm 3).

| Konum | `plugin.json` | `mcp_config.json` sunucu başlatma |
|---|---|---|
| Depo kökü | `name`, `displayName`, `version` `0.3.2`, `description`, `author`, `homepage`, `repository`, `suggestedPrompts` | `cwd: ${PLUGIN_ROOT}` ile `npx -y --ignore-scripts --prefix ${PLUGIN_DATA} causoryn@0.3.2 mcp --allow-cwd --auto-data-dir --client antigravity` |
| `packages/causoryn` (yayımlanan npm paketi) | Aynı alanlar | `cwd: ${PLUGIN_ROOT}` ile `node ${PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs --expected-version 0.3.2 --allow-cwd --auto-data-dir --client antigravity` |

Paket dizini varyantı `plugin-mcp-launcher.mjs` kullanır: kurulu `package.json` dosyasının tam olarak `--expected-version` sürümündeki `causoryn` olduğunu (ve tanımlıysa `CAUSORYN_EXPECTED_VERSION` ile uyuştuğunu) denetler; herhangi bir uyuşmazlıkta `stderr` üzerine `[causoryn-launcher]` mesajı yazarak `2` ile çıkar; aksi halde iç içe bir `npx` süreci açmadan `dist/mcp-server.mjs` modülünü doğrudan import eder. Başlatıcı yolu `${PLUGIN_ROOT}` ile eklenti köküne bağlanır; Antigravity bu token'ı bir eklentinin `mcp_config.json` dosyasında eklenti dizinine genişletir (yerleşik `mcp-app-development` skill dokümanı). Çıplak göreli bir yol, `node` tarafından host'un sunucuyu başlattığı çalışma dizinine göre çözülürdü.

`npx` manifestleri `--ignore-scripts` geçirir: yayımlanan `causoryn` paketinin bağımlılığı ve kurulum betiği yoktur (SQLite native eklentisi `dist/` içinde önceden derlenmiş gelir), bu yüzden kurulum sırasında hiçbir şeyin çalışması gerekmez. Her Antigravity manifesti sunucuyu `cwd: ${PLUGIN_ROOT}` ile başlatır; `npx` manifestleri ayrıca npm prefix'ini eklentinin veri dizinine sabitler (`--prefix ${PLUGIN_DATA}`). Böylece analiz edilen projenin npm yapılandırması, `node_modules` ve `node_modules/.bin` dizini sunucunun çözümlenmesine katılmaz. `--allow-cwd` eklenti dizinini reddettiği için workspace MCP `roots/list` üzerinden bağlanır.

İki kök manifest daha diğer MCP istemcilerine hizmet eder: `mcp.json` (`type: "stdio"`, `cwd: ${PLUGIN_ROOT}` ve `npx -y --ignore-scripts --prefix ${PLUGIN_DATA} causoryn@0.3.2 mcp --allow-cwd --auto-data-dir` içeren taşınabilir `mcpServers.causoryn`) ve `server.json` (MCP Registry girdisi `io.github.mrbekox/causoryn`, npm paketi `causoryn`, `stdio` taşıması, runtime argümanı `--ignore-scripts`, paket argümanları `mcp --allow-cwd --auto-data-dir`). Registry biçiminde çalışma dizini veya eklenti kökü alanı yoktur; bu yüzden `npx`'i proje dizininde çalıştıran bir registry istemcisi paketi yine o projenin npm bağlamında çözer. Bu belgelenmiş bir artık sınırdır; `causoryn setup` mutlak runtime yolunu kaydederek bundan kaçınır.

---

## 3. Doğrulama durumu — `NOT RUN` (`agy` CLI) ve doğrudan `stdio` doğrulaması

**agy CLI bulunamadı — bu hostta kurulum/smoke koşulmadı.** Doğrulama hostunda CLI eklenti kurulumu ve smoke testleri `NOT RUN` durumundadır.

Makine kanıtı (`2026-11-08` / `2026-11-18`):

- **Antigravity IDE kurulu** (`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`, bir Electron masaüstü uygulaması), ancak kurulum dizininde `agy` binary'si yok (`agy*` eşleşmesi yok, `bin/` alt dizini yok).
- `agy --version` → `bash: line 3: agy: command not found`
- `command -v agy` → boş çıktı.

Uygulanan kural: `agy` CLI yoksa CLI adımlarının çalıştırılmadığı açıkça raporlanır. (Projenin iç teknik şartnamesindeki raporlama kuralına atıfla: TŞ §22 kuralı uygulanır — §22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla".)

**Doğrulama sınırı:**

1. **Doğrudan `stdio` protokol doğrulaması (otomatik, 0.3.0 kodu):** `npm run build:bundle --workspace packages/mcp-server`, `integrations/antigravity/causoryn/scripts/mcp-server.mjs` dosyasını (`index-worker.mjs` ve vendored `better-sqlite3` ile birlikte) sahneledikten sonra `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts`, eklenti dizininde `mcp_config.json` içindeki birebir `command`, `args` ve `env` ile gerçek bir alt süreç başlatır ve şunları denetler: `initialize` → `serverInfo.name` `causoryn` ve güncel `SERVER_VERSION`; `tools/list` → tam olarak 11 `core` aracı; `causoryn_status` → `data.authorized: false` ile `status: "ok"`; `causoryn_map_system` → `WORKSPACE_NOT_AUTHORIZED`; `stdout` üzerinde tam olarak dört JSON-RPC 2.0 satırı; `stderr` üzerinde hazır mesajı; çıkış kodu `0`. Bundle sahnelenmemişse test atlanır.
2. **Paketlenmiş `setup` / `doctor` / `--uninstall`:** izole bir geçici `$HOME` içinde doğrulandı (`packages/causoryn/test/setup-and-doctor.test.ts`, `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`). Doğrulama hostunun gerçek `~/.gemini` profili değiştirilmedi.
3. **`agy` CLI kurulum/smoke komutları ve IDE içinde eklenti yükleme (`NOT RUN`):** bölüm 6'daki `agy plugin validate --strict`, `agy plugin install` ve `agy plugin list` komutları doküman örnekleridir. Hiçbiri çalıştırılmadı; herhangi bir CLI veya IDE kurulumu iddia edilmez.

## 4. Monorepo fikstürü için ön koşullar

1. **`agy` CLI** — CLI tabanlı `validate` / `install` / `list` akışı için gerekir; doğrulama hostunda yoktur (`NOT RUN`). Yerleşik Antigravity eklenti yükleyicisi ise `plugin.json` + `mcp_config.json` dosyalarını doğrudan eklenti dizininden okur.
2. **Node.js ≥ 24** (kök `package.json` → `engines.node`).
3. **Derlenmiş ve sahnelenmiş bundle:** `npm run build:bundle --workspace packages/mcp-server`. Script yalnızca `packages/mcp-server/package.json` içinde tanımlıdır; kökte `--workspace` olmadan koşulursa `Missing script` hatasıyla başarısız olur. Komut, `packages/mcp-server/dist/` altına `bundle-manifest.json` (36 SHA-256 girdisi), `mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt` ve `node_modules/better-sqlite3/` (LICENSE, `package.json`, `lib/`, `prebuilds/`) yazar; ardından aynı dosyaları `integrations/antigravity/causoryn/scripts/` altına kopyalar (gitignored). Artefakt **tek başına bir dosya değildir**: `better-sqlite3`, `.node` binary'leri esbuild tarafından gömülemeyen native bir eklentidir; bu yüzden `mcp-server.mjs`, yanındaki `node_modules/better-sqlite3/` diziniyle birlikte taşınmalıdır.

## 5. Monorepo fikstür düzeni (`integrations/antigravity/causoryn/`)

| Bileşen | Durum |
|---|---|
| `plugin.json` | Mevcut (`$schema` çıkarıldı; yalnızca yerleşik yükleyicinin kabul ettiği anahtarlar) |
| `mcp_config.json` | Mevcut (yerleşik yükleyicinin okuduğu birincil MCP tanımı; `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`) |
| `mcp.json` | Mevcut (taşınabilir manifest karşılığı; `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"`) |
| `README.md` | Mevcut (kurulum, güvenlik modeli ve `NOT RUN` açıklaması) |
| `scripts/mcp-server.mjs` (+ `index-worker.mjs`, `node_modules/better-sqlite3/`, `bundle-manifest.json`) | `npm run build:bundle --workspace packages/mcp-server` ile deterministik olarak sahnelenir (gitignored) |
| `skills/` | Fikstürün parçası değildir. Beş kanonik skill, depodaki `skills/` dizininde ve `packages/causoryn` paketinde yayımlanır. |
| `agents/`, `rules/`, `hooks.json` | Dahil değil (isteğe bağlı, başlanmadı) |

**Çift manifest ve yol çözümlemesi:**

- Yerleşik Antigravity eklenti yükleyicisi (`agy-customizations/docs/plugins.md`, `plugin/SKILL.md:200-266`), eklenti kökündeki **`mcp_config.json`** dosyasını okur ve `${PLUGIN_ROOT}` token'ını eklenti dizinine genişletir (`mcp-app-development/SKILL.md`); bu yüzden giriş `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` olur. Token'sız çıplak göreli bir yol (`scripts/mcp-server.mjs`), `node` tarafından host'un çalışma dizinine (analiz edilen bir depo olabilir) göre çözülürdü; fikstür testi bu biçimi reddeder.
- Taşınabilir eklenti sözleşmesi, aynı `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` ile **`mcp.json`** kullanır. Her iki manifest de üst dizine çıkmadan aynı sahnelenmiş giriş noktasını gösterir.
- MCP sunucu adları Antigravity eklentileri arasında tek bir ad alanını paylaşır (`plugin/SKILL.md:304-306`); bu yüzden her iki manifest de genel bir ad yerine eklentiye özgü **`causoryn`** anahtarını kullanır.

### `plugin.json` (fikstürün birebir içeriği)

```json
{
  "name": "causoryn",
  "displayName": "Causoryn",
  "version": "0.3.2",
  "description": "Local, evidence-backed codebase and change intelligence via MCP.",
  "suggestedPrompts": [
    "Map this workspace and show evidence for critical dependencies",
    "Run a change preflight for the selected endpoint",
    "Verify my working-tree changes against architecture contracts"
  ]
}
```

| Alan | Değer | Amaç |
|---|---|---|
| `name` | `causoryn` | Global olarak benzersiz eklenti anahtarı |
| `displayName` | `Causoryn` | Yükleyici arayüzündeki başlık |
| `version` | `0.3.2` | `packages/mcp-server/src/version.ts` (`SERVER_VERSION`) ile senkron tutulur |
| `description` | `Local, evidence-backed codebase and change intelligence via MCP.` | Yükleyici kartı metni |
| `suggestedPrompts` | Üç başlangıç prompt'u | Yükleyici kartı / ayrıntı görünümü |

**`$schema` neden çıkarıldı:** yerleşik yükleyici (`plugin/SKILL.md:228-266`) üst düzey anahtar olarak yalnızca `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `author`, `homepage`, `repository` ve `disabled` alanlarını kabul eder ve bilinmeyen alanları (`$schema` ve `mcpServers` dahil) sessizce atar. Fikstür testi bu izin listesini zorunlu kılar ve `plugin.json` içinde `$schema` veya `mcpServers` bulunmasını reddeder.

### `mcp_config.json` (birincil — yerleşik yükleyici)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/scripts/mcp-server.mjs"
      ],
      "cwd": "${PLUGIN_ROOT}",
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

### `mcp.json` (taşınabilir karşılık)

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": [
        "${PLUGIN_ROOT}/scripts/mcp-server.mjs"
      ],
      "cwd": "${PLUGIN_ROOT}",
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[]}"
      }
    }
  }
}
```

| Alan | Değer | Kural |
|---|---|---|
| `mcpServers.causoryn` | Sunucu anahtarı `causoryn` | Paylaşılan sunucu ad alanında çakışmaları önler |
| `command` | `node` | Yerel `stdio` süreci; LLM veya harici API çağrısı yok |
| `args[0]` | Hem `mcp_config.json` hem `mcp.json` içinde `"${PLUGIN_ROOT}/scripts/mcp-server.mjs"` | Sahnelenmiş, derlenmiş esbuild çıktısı; ham `.ts` giriş noktaları, çıplak göreli veya mutlak yollar ve üst dizin kaçışları fikstür testi tarafından reddedilir |
| `cwd` | Her iki manifestte `"${PLUGIN_ROOT}"` | Sunucu analiz edilen bir projede değil, eklenti dizininde başlar; fikstür testi proje dizini olan bir `cwd` değerini reddeder |
| `env.CAUSORYN_CONFIG` | `{"allowRoots":[]}` | **Default deny**; `parseCausorynServerConfig` ile doğrulanır (katı nesne, mutlak `allowRoots`); bir kök yetkilendirilene kadar workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner |

### Çıplak `stdio.ts` ve paketlenmiş `cli-stdio.ts`

- **Çıplak monorepo giriş noktası (`packages/mcp-server/src/stdio.ts`, bu fikstürün kullandığı):** `process.argv` okumaz. Konfigürasyonu yalnızca `CAUSORYN_CONFIG` ve `CAUSORYN_TOOL_PROFILE` ortam değişkenlerinden gelir; fikstür manifestlerinin `--data-dir` geçirmemesinin nedeni budur, veri yolları `CAUSORYN_CONFIG` içinde beyan edilir. `storage.dataDbPath` olmadan graph bellekte tutulur.
- **Paketlenmiş giriş noktası (`packages/causoryn/dist/mcp-server.mjs`, `packages/mcp-server/src/cli-stdio.ts` kaynağından derlenir):** `--allow-cwd`, `--root`, `--auto-data-dir`, `--data-dir`, `--client`, `--tool-profile` ve `--output-schema` bayraklarını, ayrıca dinamik MCP `roots/list` workspace bağlamasını destekler. `npx causoryn@0.3.2 setup --client antigravity --yes` bu giriş noktasını kaydeder.

**Hostlar arası kural:** `mcp.json` dosyasını hostlar arasında asla birebir kopyalamayın. Claude Code ([claude-code.md](claude-code.md)), Codex ([codex.md](codex.md)) ve ZCode ([zcode.md](zcode.md)) her biri kendi konfigürasyon biçimini ve değişken token'larını kullanır.

## 6. Kurulum adımları — doküman örneği, `NOT RUN`

```bash
# 0) Bundle'ı derle ve fikstürün scripts/ dizinine sahnele (deterministik;
#    kök package.json'da build:bundle script'i olmadığından --workspace zorunludur)
npm run build:bundle --workspace packages/mcp-server

# 1) Manifest doğrulama — agy CLI gerektirir; doğrulama hostunda NOT RUN
agy plugin validate --strict ./integrations/antigravity/causoryn

# 2) Kurulum — NOT RUN
agy plugin install ./integrations/antigravity/causoryn

# 3) Listeleme — NOT RUN
agy plugin list

# 4) Araç keşfi — agy üzerinden NOT RUN. Doğrudan stdio spawn testi
#    11 core aracını doğruladı (packages/mcp-server/src/version.ts içindeki CORE_TOOL_NAMES).
```

Bu komutlar doküman örneğidir, bu doküman hazırlanırken çalıştırılmış değildir. `agy` CLI kullanılabilir olduğunda 1–4. adımlar canlı olarak koşulacak ve sonuçları [Uyumluluk Matrisi](../compatibility-matrix.md)'ne işlenecektir.

**Temizlik protokolü:** canlı bir smoke koşusunda kullanıcının gerçek yapılandırmasına kalıcı değişiklik bırakılmaz: kurulum izole bir test kapsamında yapılır ve **smoke sonunda plugin kaldırılır**. `agy` için kesin kaldırma alt komutu henüz doğrulanmadı (`NOT RUN`); diğer hostlardaki karşılıkları `claude mcp remove` ve `codex mcp remove` komutlarıdır.

## 7. Konfigürasyon: `CAUSORYN_CONFIG` (çıplak giriş noktası)

Çıplak `stdio.ts` giriş noktası için tek konfigürasyon kaynağı `CAUSORYN_CONFIG`'dir (`parseCausorynServerConfig` ile doğrulanan JSON):

```bash
# Bir workspace kökünü yetkilendir (salt okunur analiz; default deny'dan çıkar)
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'

# Graph'ı ve Living Wiki'yi workspace'in DIŞINDAKİ bir veri kökünde kalıcı tut
CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"],"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"},"wiki":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}}'
```

- `${PLUGIN_ROOT}`, salt okunur eklenti kurulum köküdür. Hiçbir zaman analiz edilen bir workspace kökü değildir; `allowRoots` içinde her zaman açık, mutlak proje yolları beyan edin.
- Yazma işlemleri yalnızca workspace dışında beyan edilmiş veri veya çıktı konumlarında yapılır. `wiki.dataDbPath` yoksa `causoryn_wiki_build`, `PATH_DENIED` ile fail-closed davranır; `output.allowedOutputDirs` yoksa `causoryn_export_documentation`, `EXPORT_NOT_ALLOWED` ile fail-closed davranır. Beyan edilen yollar mevcut olmalı (veritabanı dosyaları için üst dizin) ve yetkili tüm köklerin dışında bulunmalıdır.

## 8. Araç profilleri, veri dizini ve ilk çalıştırma

**Araç profilleri.** Sunucu `core` profiliyle başlar: 11 araç (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`); `outputSchema` varsayılan olarak `tools/list` yanıtından çıkarılır (yanıtlar yine de doğrulanır). `wiki`, 7 `causoryn_wiki_*` aracını ekler; `history`, `causoryn_compare_architecture` ve `causoryn_architecture_timeline` araçlarını ekler; `full` ise 32 araç kaydeder (29 legacy araç ile `causoryn_status`, `causoryn_trace`, `causoryn_contracts`; yerini yenisine bırakan legacy araçlar deprecation notu taşır). Öncelik `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core` şeklindedir; verilen her değer doğrulanır ve bilinmeyen bir ad sunucuyu başlangıçta durdurur.

- **`setup` tarafından yazılan girdi:** `npx causoryn@latest setup --client antigravity --tool-profile wiki,history --yes` çalıştırın ya da elle `args` dizisine `"--tool-profile", "wiki,history"` ekleyin veya `"env": { "CAUSORYN_TOOL_PROFILE": "full" }` ekleyin. `setup` yeniden çalıştırıldığında girdinin `env` nesnesi, `--tool-profile` ve `--output-schema` argümanları ve eklediğiniz diğer anahtarlar korunur; profili değiştirmek için `setup --tool-profile <list>` verin.
- **Fikstür (çıplak giriş noktası):** CLI bayrağı almaz; `env` içinde `CAUSORYN_CONFIG`'in yanına `"CAUSORYN_TOOL_PROFILE": "full"` ekleyin ya da `CAUSORYN_CONFIG` JSON'u içinde `"toolProfile": "full"` ayarlayın.

**Veri dizini.** `--auto-data-dir` ile paketlenmiş giriş noktası indeksi `<base>/workspaces/<slug>-<hash12>/graph.sqlite` altında tutar (export'lar `.../exports/` altında); taban dizin önceliği her host için `--data-dir` > `~/.causoryn` şeklindedir (`ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` kullanılamadığında yedek). Tüm hostlar workspace başına bu tek veritabanını paylaşır; `--client antigravity` yalnızca tanılama etiketidir (`build_leases.host_label`) ve `build_leases` tek yazıcı kilidi (lease), iki sürecin aynı anda snapshot yayımlamasını engeller. 0.3.0 öncesi sürümlerden kalan host başına `graph-<client>.sqlite` dosyaları eksik bir `graph.sqlite`'a bir kez kopyalanır (en yeni geçerli olan) ve yerinde bırakılır; `causoryn doctor` bunları listeler. Dizinler `0700` olarak oluşturulur ve yetkili tüm köklerin kesinlikle dışında olmalıdır.

**İlk çalıştırma.** İndeksleme bir `worker_threads` worker'ında çalışır. Paketlenmiş giriş noktasında, ilk indeks yayımlanmadan önce yapılan bir araç çağrısı en fazla `CAUSORYN_INDEX_WAIT_MS` (varsayılan `15000`) kadar bekler, ardından `data.status: "indexing"` ve `retryAfterMs` ile `status: "partial"` döner. `--allow-cwd` güvensiz başlangıç dizinlerini (`$HOME`, dosya sistemi kökleri, sistem dizinleri, `~/.gemini`, eklenti kurulum dizinleri, veri dizini) reddeder ve ardından MCP `roots/list` ile bildirilen ilk güvenli köke bağlanır.

### Sorun giderme

| Belirti | Neden ve çözüm |
|---|---|
| `setup` desteklenen bir host algılanmadığını söylüyor | Ne `~/.gemini/antigravity` ne de `~/.gemini/config/mcp_config.json` mevcut (tek başına `~/.gemini` sayılmaz). `--client antigravity` değerini açıkça geçin. |
| `setup`, `cli/malformed-json` ile duruyor | `mcp_config.json` dosyalarından biri geçerli JSON değil veya `mcpServers` bir nesne değil. Dosyayı düzeltin veya `.causoryn.backup` yedeğini geri yükleyin; hiçbir şey yazılmadı. |
| `doctor`, giriş script'i için `ERROR` gösteriyor | `~/.causoryn/runtime` veya özgün kurulum silinmiş. `npx causoryn@0.3.2 setup --client antigravity --yes` komutunu yeniden çalıştırın. |
| `setup`, `skipped skill <name>: … was not created by Causoryn` (veya `… was changed after Causoryn installed it`) raporluyor | Causoryn skill adına sahip, setup'ın kendisinin kurduğunu kanıtlayamadığı bir `SKILL.md` var: kendi skill'iniz ya da düzenlediğiniz bir Causoryn skill'i. Dosya korundu. Olduğu gibi bırakın ya da başka yere taşıyıp Causoryn'in sürümünü kurmak için setup'ı yeniden çalıştırın. |
| `setup`, `Refusing to use <dir>: it is writable by other users` veya `… it is owned by another user` ile duruyor | POSIX'te mevcut bir `~/.causoryn`, sahnelenen runtime'ı ve skill kurulum kaydını tuttuğu için size ait olmalı ve grup veya diğerleri tarafından yazılabilir olmamalıdır. `chmod go-w ~/.causoryn` çalıştırın ya da dizini silin veya kullanıcınıza verin, ardından setup'ı yeniden çalıştırın; hiçbir şey değiştirilmedi. |
| `setup`, `<file> changed while setup was running, so it was left as it is` ile duruyor | Setup'ın değiştirmeyi veya kaldırmayı planladığı bir skill dosyası koşum sırasında değişti (örneğin onay istemi açıkken) ve olduğu gibi bırakıldı. Setup'ı yeniden çalıştırın. |
| `[causoryn-launcher]` sürüm uyuşmazlığı (çıkış `2`) | Paket dizini `--expected-version` ile eşleşmiyor. Eşleşen paket sürümünü yeniden kurun. |
| Workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürüyor | `--allow-cwd` başlangıç dizinini reddetti ve `roots/list` üzerinden güvenli bir kök gelmedi ya da fikstürde hâlâ `allowRoots: []` var. Proje klasörünü açın veya kökü beyan edin (bölüm 7). |
| Wiki veya history araçları `tools/list` içinde yok | Varsayılan `core` profili. Yukarıdaki araç profili notlarına bakın. |

## 9. Uyumluluk satırı — Antigravity

| Entegrasyon | Model kullanımı | MCP kurulumu | Uyumluluk testleri | Doğrulama hostundaki durum |
|---|---|---|---|---|
| Antigravity | Kullanıcının seçtiği Antigravity modeli (Causoryn hiçbir zaman model seçmez veya geçersiz kılmaz) | `npx causoryn@0.3.2 setup --client antigravity --yes` veya eklenti: `plugin.json` + `mcp_config.json` (yerleşik yükleyici) + `mcp.json` (taşınabilir) | Doğrudan `stdio` spawn (11 core aracı) ve izole `setup`/`doctor` doğrulandı; `agy validate` / `install` / `list` | **`NOT RUN` — `agy` CLI bulunamadı** (doğrudan `stdio` el sıkışması otomatik testlerde doğrulandı) |

Hostlar arası parite, MCP tool şeması ve sözleşme düzeyinde tanımlanır; host UI/permission özdeşliği iddia edilmez ve Causoryn bir host modelini araç çağırmaya zorlayamaz.

## 10. Açık kalemler (`agy` CLI ayağı açık kalır ve Done olarak işaretlenmez)

1. **`agy` CLI kullanılabilir olduğunda kontrol listesi (`NOT RUN`):** `agy plugin validate --strict`, `agy plugin install`, `agy plugin list`, Antigravity içinde canlı araç keşfi (varsayılan profille 11 core aracı beklenir), temsilî `causoryn_map_system` / `causoryn_preflight_change` / `causoryn_verify_change` çağrıları ve sonunda kullanıcı config'ine dokunulmadan eklentinin kaldırılması.
2. **İsteğe bağlı eklenti özelleştirmeleri:** `agents/`, `rules/`, `hooks.json` — başlanmadı.

## İlgili dosyalar ve kılavuzlar

- `integrations/antigravity/causoryn/plugin.json` — fikstür eklenti manifesti (yerleşik yükleyici için `$schema`'sız)
- `integrations/antigravity/causoryn/mcp_config.json` — yerleşik yükleyici için birincil MCP config'i
- `integrations/antigravity/causoryn/mcp.json` — taşınabilir MCP manifest karşılığı
- `integrations/antigravity/causoryn/README.md` — kullanıcıya dönük kurulum ve güvenlik dokümantasyonu
- `integrations/antigravity/causoryn/test/antigravity-plugin.test.ts` — manifest şeması, sahnelenmiş `stdio` spawn, negatif ve dürüstlük testleri
- `packages/mcp-server/scripts/build-bundle.mjs` — `dist/` derlemesi ve `integrations/antigravity/causoryn/scripts/` altına deterministik sahneleme
- [5 Dakikada Başlangıç (İngilizce)](../en/tutorial-5-minutes.md) · [CLI ve Konfigürasyon](../cli-and-configuration.md) · [MCP Araç Sözleşmeleri](../tool-contracts.md)
- Diğer host kılavuzları: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [ZCode](zcode.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md) · [English version](../en/hosts/antigravity.md)
