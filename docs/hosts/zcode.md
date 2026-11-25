# Causoryn'i ZCode'a (GLM) Bağlama (CLI Config + Plugin Pazaryeri)

> **Dil / Language:** **Türkçe** | [English](../en/hosts/zcode.md) · [Dokümantasyon Merkezi](../README.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> **Durum:** Causoryn 0.3.1'i yansıtır (11 araçlı varsayılan `core` araç profili; tüm hostlar için workspace başına tek ortak `graph.sqlite`). Etkileşimli ZCode masaüstü GUI kurulumu **`NOT RUN`** durumundadır (bkz. doğrulama bölümü).

> **Bu sayfa için kontrol edilen kaynaklar:** `packages/causoryn/src/{setup.ts,doctor.ts,cli.ts,runtime-stage.ts}`, kök `marketplace.json`, `packages/causoryn/.zcode-plugin/plugin.json`, `packages/causoryn/scripts/plugin-mcp-launcher.mjs`, `integrations/zcode/.claude-plugin/marketplace.json`, `integrations/zcode/causoryn/{.zcode-plugin/plugin.json,README.md}`, `packages/mcp-server/src/{runtime-cli.ts,cli-stdio.ts,stdio.ts}`.

Causoryn, kod istihbaratı için yerel ve deterministik bir MCP sunucusudur. Hiçbir LLM veya ağ API çağrısı yapmaz. ZCode (GLM) üzerinde **iki kurulum yüzeyi** sunar:

1. **CLI kurulumu (önerilen):** `npx causoryn@0.3.1 setup --client zcode --yes`, `~/.zcode/cli/config.json` (`mcp.servers.causoryn`) ve `~/.zcode/skills/` dosyalarını yapılandırır.
2. **ZCode plugin pazaryeri:** depo kökündeki `marketplace.json` (npm kaynağı) ve paketlenmiş `.zcode-plugin/plugin.json`; sürüm, `plugin-mcp-launcher.mjs --expected-version 0.3.1` ile sabitlenir.

## Doğrulama durumu — masaüstü GUI (`NOT RUN`) ve otomatik şema/CLI testleri

- **Etkileşimli ZCode masaüstü GUI kurulumu: `NOT RUN`.** ZCode komut satırından çalışan bir plugin yükleyicisi sunmaz (`zcode --help` / `zcode plugin --help` mevcut değildir; pazaryeri kurulumu yalnızca masaüstü GUI'de yapılır). Otomatik doğrulama bir geliştiricinin gerçek ZCode masaüstü profilini hiçbir zaman değiştirmez; bu nedenle GUI içi kurulum ve GUI içinde `tools/list` gözlemi çalıştırılmadı.
- **Otomatik olarak doğrulananlar (0.3.0 kodu):** kök `marketplace.json`, paketlenmiş `packages/causoryn/.zcode-plugin/plugin.json`, monorepo geliştirme fikstürü (`integrations/zcode/.claude-plugin/marketplace.json` + `integrations/zcode/causoryn/`), izole bir geçici `$HOME` içinde paketlenmiş `setup` / `doctor` / `--uninstall` yaşam döngüsü (`~/.agents/mcp.json` fallback kopyası dahil) ve paketlenmiş `.tgz` üzerinden `stdio` el sıkışması (`tools/list`, `outputSchema` olmadan ve 15.000 karakterin altında tam olarak 11 core aracını döndürür). Test paketleri: `integrations/zcode/causoryn/test/plugin-package.test.ts`, `integrations/zcode/causoryn/test/plugin-dev-marketplace.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts`, `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `tests/open-source-distribution.test.ts`.

---

## 1. Birincil kurulum — tek komutluk CLI

```bash
# Planlanan değişiklikleri hiçbir şey yazmadan önizle
npx causoryn@0.3.1 setup --client zcode --dry-run

# ~/.zcode/cli/config.json (mcp.servers.causoryn) + ~/.zcode/skills/ yapılandır
npx causoryn@0.3.1 setup --client zcode --yes

# Salt okunur sağlık ve hizalama kontrolü
npx causoryn@0.3.1 doctor --client zcode

# Temiz kaldırma (mcp.servers.causoryn + 5 Causoryn skill'i)
npx causoryn@0.3.1 setup --client zcode --uninstall --yes
```

### `setup --client zcode` ne yapar (`packages/causoryn/src/setup.ts`)

1. **Kalıcı runtime sahnelemesi.** `setup` geçici bir konumdan (bir `_npx` önbellek dizini veya işletim sisteminin geçici dizini altındaki herhangi bir yer) çalıştığında paketi (derlenmiş bundle, indeksleme worker'ı, native sidecar worker kaynakları, skill'ler, manifestler) `~/.causoryn/` altındaki geçici bir dizine kopyalar ve bir rename ile `~/.causoryn/runtime` yerine geçirir. Böylece yapılandırılan giriş noktası, `npx` önbelleği temizlendikten sonra da geçerli kalır.
2. **Atomik `~/.zcode/cli/config.json` güncellemesi.** Dosya mevcutsa özgün hali önce `~/.zcode/cli/config.json.causoryn.backup` olarak kopyalanır (bu dosyanın üzerine daha sonra hiç yazılmaz; sonraki değişiklikler `config.json.causoryn.<timestamp>-<nonce>.backup` kopyaları oluşturur). Ardından dosya bu girdiyle atomik olarak yazılır (geçici dosya + rename, mevcut mod korunur, yeni dosyalar `0600`); diğer anahtarlar korunur:

   ```json
   {
     "mcp": {
       "servers": {
         "causoryn": {
           "type": "stdio",
           "command": "/path/to/node",
           "args": [
             "/home/you/.causoryn/runtime/scripts/causoryn.mjs",
             "mcp",
             "--allow-cwd",
             "--auto-data-dir",
             "--client",
             "zcode"
           ]
         }
       }
     }
   }
   ```

   `command`, `setup` komutunu çalıştıran Node.js'in (≥ 24) mutlak `process.execPath` değeridir.
3. **`~/.agents/mcp.json` fallback'inin korunması.** ZCode, yalnızca `~/.zcode/cli/config.json` içinde `mcp.servers` bulunmadığı sürece `~/.agents/mcp.json` (`mcpServers`) dosyasına fallback yapar; dolayısıyla `mcp.servers` oluşturulması bu sunucuları gizler. `setup`, `mcp.servers` nesnesini ilk kez oluşturduğunda ve `~/.agents/mcp.json` mevcutsa, `causoryn` dışındaki her girdiyi `mcp.servers` altına kopyalar; `command` alanı olup `type` alanı olmayan girdilere `type: "stdio"` ekler. Hatalı biçimli bir `~/.agents/mcp.json`, herhangi bir şey yazılmadan önce koşumu `cli/malformed-json` ile durdurur.
4. **Beş kanonik skill.** `causoryn`, `map-system`, `preflight-change`, `verify-change` ve `architecture-blueprint`, `~/.zcode/skills/<name>/SKILL.md` altına yazılır (`--no-skill` bunları atlar). `architecture-blueprint`, ZCode'un MCP kanıtlarından isteğe bağlı `annotations` taslağı hazırlamasına rehberlik eder; anotasyonsuz export için doğrudan `causoryn_export_documentation` çağırın ([mimari export sözleşmesi](../tool-contracts.md)). Skill'ler host modeli için rehber metinlerdir: bir skill'in andığı araç ancak etkin araç profili o aracı kaydediyorsa çağrılabilir.
5. **Temiz kaldırma.** `--uninstall`, `mcp.servers.causoryn` girdisini siler, boşalan `mcp.servers` nesnesini ve ardından boşalan `mcp` nesnesini kaldırır, beş skill dizinini siler ve başka hiçbir host config'i referans vermiyorsa `~/.causoryn/runtime` dizinini kaldırır. `~/.agents/mcp.json` dosyasından kopyalanan sunucular `mcp.servers` içinde kalır.

Ortak davranış: ZCode, `~/.zcode` veya `~/.zcode/cli/config.json` mevcutsa algılanmış sayılır; `--yes` (ve `--dry-run`) olmadan etkileşimli bir terminal `Continue? [y/N]` diye sorar, etkileşimsiz bir kabuk ise "confirmation required" hatasıyla durur; aynı ikinci koşum `noop` raporlar; geçersiz JSON veya nesne olmayan `mcp` / `mcp.servers` değerleri koşumu `cli/malformed-json` ile durdurur; sembolik bağlantı hedefleri reddedilir; `setup` başarıda `0`, hiçbir host algılanmadığında ve hiçbiri adlandırılmadığında `1`, hatada `2` ile çıkar.

### `doctor` kontrolleri

`causoryn doctor` salt okunurdur. ZCode için `~/.zcode/cli/config.json` dosyasını ayrıştırır, boş olmayan bir `command` içeren `mcp.servers.causoryn` girdisini arar, `command` bir Node binary'si olduğunda giriş script'inin varlığını denetler ve beş skill'i kontrol eder. Host durumu `OK`, `WARN`, `NOT-CONFIGURED` veya `ERROR` olur. `doctor` ayrıca Node.js ≥ 24, runtime dosyaları ve `dotnet` / `python` / `go` / `cargo` araç zincirlerini kontrol eder (eksik olanlar `l0-l1-fallback` olarak raporlanır: o dil için dosya düzeyinde analiz). Genel sonuç `HEALTHY`, `DEGRADED`, `NOT CONFIGURED` veya `UNHEALTHY` olur ve çıkış kodu yalnızca `HEALTHY` için `0`'dır.

---

## 2. ZCode plugin pazaryeri (`marketplace.json` + `.zcode-plugin/plugin.json`)

Depo pazaryerini ZCode masaüstü arayüzünde (**Settings → Plugin Management → Discover → +**) GitHub deposundan (`https://github.com/MrBekoX/Causoryn`) veya yerel bir checkout'tan ekleyin. Kök `marketplace.json`, İngilizce ve Türkçe `description_i18n` meta verisiyle bir npm plugin kaynağı (`{ "source": "npm", "package": "causoryn", "version": "0.3.1" }`) tanımlar. (Bu GUI adımı doğrulamada `NOT RUN` durumundadır.)

Paketlenmiş `packages/causoryn/.zcode-plugin/plugin.json`, skill'leri taşır (`"skills": "skills"`) ve sunucuyu şöyle bağlar:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.3.1",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "zcode"
      ],
      "cwd": "${ZCODE_PROJECT_DIR}"
    }
  }
}
```

`plugin-mcp-launcher.mjs`, iç içe bir `npx` süreci başlatmadan kurulu `package.json` dosyasının tam olarak `--expected-version` sürümündeki `causoryn` olduğunu (ve tanımlıysa `CAUSORYN_EXPECTED_VERSION` ile uyuştuğunu) denetler; herhangi bir uyuşmazlıkta veya bundle eksikse `stderr` üzerine `[causoryn-launcher]` mesajı yazarak `2` ile çıkar; aksi halde `dist/mcp-server.mjs` modülünü doğrudan import eder.

### ZCode ortam değişkenleri ve güvenlik sınırları

- **`ZCODE_PLUGIN_ROOT`:** eklentinin salt okunur kurulum kökü. `deriveForbiddenPluginDirs` (`packages/mcp-server/src/runtime-cli.ts`), `ZCODE_PLUGIN_ROOT` veya `~/.zcode/plugins` dizinlerinin analiz edilen bir proje kökü olarak yetkilendirilmesine hiçbir zaman izin vermez.
- **`ZCODE_PROJECT_DIR`:** `cwd` olarak geçirilen etkin proje dizini. `--allow-cwd`, bu dizini yetkilendirmeden önce `inspectProjectRootSafety` ile denetler. Reddedilen adaylar arasında UNC ve aygıt yolları, dosya sistemi kökleri, `$HOME` ve üst dizinleri, işletim sistemi dizinleri, hassas dizinler (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), eklenti kurulum dizinleri ve Causoryn veri dizinleri bulunur. Dizin reddedildiğinde sunucu yetkili bir kök olmadan başlar ve istemcinin MCP `roots/list` üzerinden bildirdiği ilk güvenli `file://` köke bağlanır (`notifications/roots/list_changed` bildiriminde de); o zamana kadar workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner.
- **`ZCODE_PLUGIN_DATA`:** ZCode diğer tüm host'larla aynı taban veri dizinini (`--data-dir` > `~/.causoryn`) kullanır; böylece tüm host'lar workspace başına tek bir indeksi paylaşır. `ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` oluşturulamadığında veya yazılamadığında yedek olarak kullanılır; ayarlandığında mutlak bir yol olmalıdır (UNC/aygıt yolları reddedilir) ve kullanılmasa bile doğrulanır. İndeksi `ZCODE_PLUGIN_DATA` altında bulunan mevcut ZCode kullanıcıları bir kez yeniden indeksler. Causoryn herhangi bir şey oluşturmadan önce veri dizininin yetkili tüm workspace'lerin kesinlikle dışında olduğunu doğrular; analiz edilen kaynak ağaca hiçbir zaman yazılmaz.

---

## 3. Araç profilleri, paylaşılan veri dizini ve ilk çalıştırma

**Araç profilleri.** Sunucu `core` profiliyle başlar: 11 araç (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`); `outputSchema` varsayılan olarak `tools/list` yanıtından çıkarılır (`--output-schema full` ekler; yanıtlar her iki durumda da doğrulanır).

| Profil | Ekledikleri |
|---|---|
| `wiki` | 7 `causoryn_wiki_*` aracı |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | 29 legacy aracın tamamı ile `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 araç); yerini yenisine bırakan legacy araçlar deprecation notu taşır |

Profiller virgülle birleştirilir (`wiki,history`). Öncelik `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core` şeklindedir; verilen her değer doğrulanır ve bilinmeyen bir ad sunucuyu başlangıçta durdurur.

- **`setup` tarafından yazılan girdi:** `npx causoryn@latest setup --client zcode --tool-profile wiki,history --yes` çalıştırın ya da elle `~/.zcode/cli/config.json` içindeki `mcp.servers.causoryn.args` dizisine `"--tool-profile", "wiki,history"` ekleyin. `setup` yeniden çalıştırıldığında girdinin `env` nesnesi, `--tool-profile` ve `--output-schema` argümanları ve eklediğiniz diğer anahtarlar korunur; profili değiştirmek için `setup --tool-profile <list>` verin.
- **Geliştirme fikstürü (çıplak giriş noktası, CLI bayrağı yok):** fikstür manifestinin `env` bloğuna `"CAUSORYN_TOOL_PROFILE": "full"` ekleyin.
- **Pazaryeri eklentisi:** manifest kurulu eklentinin içinde bulunur ve düzenlenmemelidir. ZCode'un `CAUSORYN_TOOL_PROFILE` değişkenini kendi ortamından eklenti sunucularına aktarıp aktarmadığı doğrulanmadı; varsayılan dışı bir profile ihtiyacınız varsa CLI kurulum yolunu kullanın.

**Paylaşılan veri dizini.** `--auto-data-dir` ile indeks `<base>/workspaces/<slug>-<hash12>/graph.sqlite` altında, export çıktısı ise `.../exports/` altında bulunur; taban dizin önceliği ZCode dahil her host için `--data-dir` > `~/.causoryn` şeklindedir (`ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` kullanılamadığında yedek). Bu yüzden tüm hostlar workspace başına tek bir veritabanını paylaşır; `--client zcode` yalnızca tanılama etiketidir (`build_leases.host_label`) ve `build_leases` tek yazıcı kilidi (lease), iki sürecin aynı anda snapshot yayımlamasını engeller. 0.3.0 öncesi sürümlerden kalan host başına `graph-<client>.sqlite` dosyaları eksik bir `graph.sqlite`'a bir kez kopyalanır (en yeni geçerli olan) ve `causoryn doctor`'ın listelemesi için yerinde bırakılır. Dizinler `0700` olarak oluşturulur.

**İlk çalıştırma.** İndeksleme bir `worker_threads` worker'ında çalışır. Paketlenmiş giriş noktasında (CLI kurulumu ve pazaryeri eklentisi), ilk indeks yayımlanmadan önce yapılan bir araç çağrısı en fazla `CAUSORYN_INDEX_WAIT_MS` (varsayılan `15000`; `0` = hiç beklenmez) kadar bekler, ardından `data.status: "indexing"`, `jobId`, `progress` ve `retryAfterMs` ile `status: "partial"` döner; `causoryn_status` ise hemen yanıt verir.

---

## 4. Monorepo geliştirme fikstürü (`integrations/zcode/`)

Kaynak checkout'tan test eden katkıcılar için `integrations/zcode/`, yerel bir geliştirme pazaryeri (`integrations/zcode/.claude-plugin/marketplace.json` içinde `causoryn-dev`, plugin kaynağı `./causoryn`) ve tek yönlendirme skill'i `skills/map-system/SKILL.md` ile gelen `integrations/zcode/causoryn/.zcode-plugin/plugin.json` eklenti fikstürünü sağlar.

```bash
# Deterministik bundle'ı derle: bundle-manifest.json (36 girdi) + mcp-server.mjs +
# index-worker.mjs + mcp-server.mjs.LEGAL.txt + vendored node_modules/better-sqlite3/
npm run build:bundle --workspace packages/mcp-server
```

Fikstür manifesti derlenmiş monorepo bundle'ını başlatır ve kullanıcı konfigürasyonunu ona `CAUSORYN_CONFIG` olarak iletir (alıntı):

```json
{
  "userConfig": {
    "config_json": {
      "type": "string",
      "default": "{\"allowRoots\":[]}"
    }
  },
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/../../../packages/mcp-server/dist/mcp-server.mjs"
      ],
      "cwd": "${CLAUDE_PROJECT_DIR}",
      "env": {
        "CAUSORYN_CONFIG": "${user_config.config_json}"
      }
    }
  }
}
```

- Bundle, `mcp-server.mjs` ile yanındaki vendored `node_modules/better-sqlite3/` dizininden oluşur (native `.node` prebuild'leri satır içine gömülemez); bu yüzden `packages/mcp-server/dist/` dizininin tamamı bir arada kalmalıdır.
- Bu çıplak giriş noktası hiçbir CLI bayrağı okumaz. Varsayılan `{"allowRoots":[]}` fail-closed'dır: bir kök beyan edilene kadar workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner; örneğin `{"allowRoots":["/path/to/your-project"],"workspaceId":"my-app"}`. `storage.dataDbPath` olmadan graph bellekte tutulur.
- Manuel masaüstü GUI adımları (`integrations/zcode` dizinini **Settings → Plugin Management → Discover → +** üzerinden ekleme ve `userConfig.config_json` ayarlama) `integrations/zcode/causoryn/README.md` içinde belgelenmiştir. Yukarıda belirtildiği gibi, etkileşimli GUI koşumu otomatik test paketlerinde `NOT RUN` durumundadır.

## 5. `stdout` / `stderr` hijyeni

`causoryn.mjs mcp`, `plugin-mcp-launcher.mjs` ve çıplak `mcp-server.mjs` genelinde `stdout` **yalnızca JSON-RPC 2.0 MCP çerçevelerini** taşır. Tüm tanılama ve başlangıç logları `[causoryn]` veya `[causoryn-launcher]` önekiyle `stderr` üzerine gider; böylece ZCode'un `stdio` taşıması temiz kalır.

## 6. Sorun giderme

| Belirti | Neden ve çözüm |
|---|---|
| `~/.agents/mcp.json` içindeki sunucular ZCode'da kullanılamıyor | ZCode, `~/.agents/mcp.json` dosyasını yalnızca `mcp.servers` yokken okur. `setup` bu girdileri yalnızca `mcp.servers` nesnesini kendisi oluşturduğunda kopyalar; `mcp.servers` zaten varsa girdileri elle içine kopyalayın. |
| `setup`, `cli/malformed-json` ile duruyor | `~/.zcode/cli/config.json` veya `~/.agents/mcp.json` geçerli JSON değil ya da `mcp` / `mcp.servers` bir nesne değil. Dosyayı düzeltin veya `.causoryn.backup` yedeğini geri yükleyin; hiçbir şey yazılmadı. |
| `doctor`, giriş script'i için `ERROR` gösteriyor | `~/.causoryn/runtime` veya özgün kurulum silinmiş. `npx causoryn@0.3.1 setup --client zcode --yes` komutunu yeniden çalıştırın. |
| `[causoryn-launcher]` sürüm uyuşmazlığı (çıkış `2`) | Kurulu eklenti paketi `--expected-version` ile eşleşmiyor. Eklentiyi güncelleyin veya yeniden kurun. |
| Sunucu başlangıçta "Unsupported Node.js version" ile çıkıyor | Node.js < 24. Node.js 24+ kurun ve `setup` komutunu yeniden çalıştırın. |
| Workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürüyor | `ZCODE_PROJECT_DIR` reddedildi ve `roots/list` üzerinden güvenli bir kök gelmedi ya da fikstürde `allowRoots` yok. Proje klasörünün kendisini ZCode'da açın veya kökü beyan edin. |
| Wiki veya history araçları `tools/list` içinde yok | Varsayılan `core` profili. Bkz. bölüm 3. |

## İlgili sayfalar

- [5 Dakikada Başlangıç (İngilizce)](../en/tutorial-5-minutes.md) · [CLI ve Konfigürasyon](../cli-and-configuration.md) · [MCP Araç Sözleşmeleri](../tool-contracts.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md) · [English version](../en/hosts/zcode.md)
- Diğer host kılavuzları: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [Antigravity](antigravity.md)
- Monorepo fikstür referansı: `integrations/zcode/causoryn/README.md`
