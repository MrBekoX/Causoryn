# Causoryn'i ZCode'a (GLM) bağlama (CLI Config + Plugin Pazaryeri)

> **Dil / Language:** Türkçe · [English](../en/hosts/zcode.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> Kanıt: TŞ v2.1 §17, §22, §25/8 · K-002 (dördüncü host adaptörü olarak ZCode) · K-021/K-022
> (`causoryn@0.2.2` CLI kurulum sihirbazı + npm plugin pazaryeri) · `marketplace.json` ·
> `packages/causoryn/.zcode-plugin/plugin.json` · `packages/causoryn/src/{setup.ts,doctor.ts}` ·
> `integrations/zcode/causoryn/README.md` · Doğrulama testleri: `plugin-package.test.ts`,
> `plugin-dev-marketplace.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts`,
> `tests/open-source-distribution.test.ts`, `tests/hosts-docs.test.ts`.

Causoryn, LLM çalıştırmayan yerel ve deterministik bir MCP kod istihbaratı motorudur (`causoryn@0.2.2`).
ZCode (GLM) ortamında **iki tamamlayıcı kurulum yüzeyi** sunar:

1. **Birincil CLI kurulumu (önerilen):** `~/.zcode/cli/config.json` (`mcp.servers.causoryn`) +
   `~/.zcode/skills/` üzerine tek komutla `npx causoryn@0.2.2 setup --client zcode --yes`.
2. **Deneysel ZCode Plugin Pazaryeri:** Kök `marketplace.json` (`source: "npm"`) ve paket içi
   `.zcode-plugin/plugin.json` (`--expected-version 0.2.2` başlatıcı kilidiyle).

## Dürüstlük Beyanı — Masaüstü GUI Kurulumu (`NOT RUN`) vs Otomatik Şema/CLI Doğrulaması

- **Etkileşimli masaüstü ZCode GUI kurulumu: `NOT RUN` (ADR-010, kırmızı kural 5 & 6).** ZCode bir
  komut satırı plugin yöneticisi sunmaz (`zcode --help` / `zcode plugin --help` mevcut değildir;
  plugin pazaryeri kurulumu yalnızca masaüstü GUI içerisinden yapılır). Kırmızı kural 6 gereği
  otomatik doğrulama sırasında kullanıcının gerçek ZCode masaüstü profiline kalıcı değişiklik
  yapılmaz; bu nedenle canlı GUI içi kurulum ve GUI içi `tools/list` gözlemi bu oturumda
  çalıştırılmamıştır (`NOT RUN`).
- **Otomatik testlerle doğrulanan yüzeyler:** Kök `marketplace.json`, paket içi
  `packages/causoryn/.zcode-plugin/plugin.json`, monorepo geliştirici fikstürü
  (`integrations/zcode/.claude-plugin/marketplace.json` + `integrations/zcode/causoryn/`),
  izole geçici `$HOME` altında paketli `setup` / `doctor` / `--uninstall` döngüsü ve `.tgz`
  paketinden `stdio` el sıkışması (29 araç)
  `plugin-package.test.ts`, `plugin-dev-marketplace.test.ts`, `setup-and-doctor.test.ts` ve
  `open-source-distribution.test.ts` ile uçtan uca doğrulanmıştır.

---

## 1. Birincil Kurulum — Tek Komut CLI (`npx causoryn@0.2.2 setup`)

```bash
# Değişiklikleri önceden görmek için (salt okunur)
npx causoryn@0.2.2 setup --client zcode --dry-run

# ~/.zcode/cli/config.json (mcp.servers.causoryn) + ~/.zcode/skills/ kurulumu
npx causoryn@0.2.2 setup --client zcode --yes

# Salt okunur sağlık ve hizalama kontrolü
npx causoryn@0.2.2 doctor

# Temiz kaldırma (mcp.servers.causoryn + 5 Causoryn skill’i)
npx causoryn@0.2.2 setup --client zcode --uninstall --yes
```

`architecture-blueprint`, ZCode’un MCP kanıtlarından isteğe bağlı `annotations` hazırlamasına rehberlik eder. Sunucu, aynı snapshot ve export girdileriyle tekrarlanabilir çıktı üretir. Anotasyonsuz export için doğrudan `causoryn_export_documentation` çağırın. [Mimari export sözleşmesi](../tool-contracts.md)

### CLI kurulumunun yaptıkları (`packages/causoryn/src/setup.ts`)

1. **Kalıcı çalışma zamanı sahnelemesi:** Komut geçici bir `npx` önbelleğinden çalıştırıldığında,
   derlenmiş sunucu paketi ve native yan işçiler `~/.causoryn/runtime` altına deterministik olarak
   sahnelenir; böylece `npx` önbelleği temizlense bile ZCode'un başlattığı MCP giriş noktası kırılmaz.
2. **`~/.zcode/cli/config.json` (`mcp.servers.causoryn`) yazımı:** Dosya mevcutsa önce atomik
   `~/.zcode/cli/config.json.causoryn.backup` yedeği alınır (POSIX'te `0o600` izinleriyle) ve
   `mcp.servers.causoryn` kaydı oluşturulur:

   ```json
   {
     "mcp": {
       "servers": {
         "causoryn": {
           "type": "stdio",
           "command": "node",
           "args": [
             "/path/to/runtime/scripts/causoryn.mjs",
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

3. **Otomatik `~/.agents/mcp.json` fallback koruması:** ZCode, `~/.zcode/cli/config.json` içinde
   `mcp.servers` tanımlanmadığı sürece `~/.agents/mcp.json` altındaki `mcpServers` kayıtlarına
   fallback yapar; ancak `mcp.servers` ilk kez tanımlandığında eski fallback dosyasını gölgeleyebilir.
   `causoryn setup`, `mcp.servers` ilk kez oluşturulurken `~/.agents/mcp.json` mevcutsa içindeki
   diğer sunucu kayıtlarını (`command` alanı olanlara `type: "stdio"` ekleyerek) otomatik olarak
   `mcp.servers` altına taşır — böylece mevcut MCP sunucularınız kaybolmaz.
4. **Beş kanonik skill (`~/.zcode/skills/`).** Varsayılan kurulum `causoryn`, `map-system`,
   `preflight-change`, `verify-change` ve `architecture-blueprint` skill’lerini `~/.zcode/skills/<ad>/SKILL.md` altına yerleştirir.
5. **Kaldırma (`--uninstall`):** `npx causoryn@0.2.2 setup --client zcode --uninstall --yes` komutu
   `mcp.servers.causoryn` girdisini siler (başka sunucu kalmadıysa boş `mcp.servers` / `mcp`
   nesnelerini de temizler), `~/.zcode/skills/` altındaki beş Causoryn skill klasörünü kaldırır ve
   başka hiçbir host `~/.causoryn/runtime` dizinine referans vermiyorsa sahnelenmiş runtime'ı da
   temizler.

---

## 2. Deneysel ZCode Plugin Pazaryeri (`marketplace.json` + `.zcode-plugin/plugin.json`)

Depo kökündeki `marketplace.json`, ZCode masaüstü arayüzünden (**Settings → Plugin Management →
Discover → +**) GitHub deposu (`https://github.com/MrBekoX/Causoryn`) veya yerel dizin olarak
eklenebilir; paketi `npm` kaynağından (`source: { "source": "npm", "package": "causoryn", "version": "0.2.2" }`)
ve Türkçe/İngilizce `description_i18n` alanlarıyla tanımlar.

Paketlenen `packages/causoryn/.zcode-plugin/plugin.json` içindeki `mcpServers.causoryn` tanımı:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.2.2",
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

### ZCode ortam değişkenleri ve güvenlik sınırları

- **`ZCODE_PLUGIN_ROOT`:** Kurulu eklentinin salt okunur kök dizinidir. `plugin-mcp-launcher.mjs`
  iç içe `npx` alt-süreci açmadan bu kök altındaki `package.json` dosyasının `--expected-version 0.2.2`
  ile eşleştiğini doğrular ve `dist/mcp-server.mjs` modülünü yükler. `deriveForbiddenPluginDirs`
  (`packages/mcp-server/src/runtime-cli.ts`), `ZCODE_PLUGIN_ROOT` ve `~/.zcode/plugins` dizinlerinin
  analiz edilecek bir proje kökü olarak yetkilendirilmesini kesin olarak engeller.
- **`ZCODE_PROJECT_DIR`:** ZCode'un aktif kullanıcı projesi için atadığı çalışma dizinidir (`cwd`).
  `--allow-cwd` bayrağı bu dizini `inspectProjectRootSafety` süzgecinden geçirerek güvenli proje
  kökü ise bağlar (`$HOME`, sistem dizinleri, `~/.zcode`, `~/.causoryn` gibi hassas kökler
  reddedilir); ayrıca masaüstü oturumunda dinamik MCP `roots/list` bildirimleriyle çalışma alanı
  güncellenebilir.
- **`ZCODE_PLUGIN_DATA`:** `--auto-data-dir` etkin olduğunda (ve açık `--data-dir` verilmediğinde),
  `resolveBaseDataDir` (`packages/mcp-server/src/runtime-cli.ts`) ortamda mutlak bir
  `ZCODE_PLUGIN_DATA` yolu varsa SQLite indeks ve Living Wiki veritabanlarını bu dizin altında
  tutmayı tercih eder; tanımsızsa `~/.causoryn` kullanılır. Her iki durumda da veri dizininin
  yetkili `allowRoots` proje kökünün **kesinlikle dışında** kaldığı doğrulanır (ADR-008: kaynak
  ağaca tek bayt bile yazılmaz).

---

## 3. Monorepo Geliştirici Fikstürü (`integrations/zcode/`)

Kaynak depo üzerinde çalışan geliştiriciler için `integrations/zcode/` altında yerel bir geliştirme
pazaryeri (`causoryn-dev`, `integrations/zcode/.claude-plugin/marketplace.json`) ve fikstür eklenti
(`integrations/zcode/causoryn/.zcode-plugin/plugin.json`) bulunur:

```bash
# 35 dosyalı deterministik F1 bundle üretimi (bundle-manifest.json + mcp-server.mjs +
# mcp-server.mjs.LEGAL.txt + vendored node_modules/better-sqlite3/LICENSE,lib,prebuilds)
npm run build:bundle --workspace packages/mcp-server
```

- Fikstür eklenti, tek dosya olmayan `packages/mcp-server/dist/` bütününü (`mcp-server.mjs` +
  vendored `node_modules/better-sqlite3/`) `userConfig.config_json` → `CAUSORYN_CONFIG` ortam
  değişkeniyle başlatır (varsayılan `{"allowRoots":[]}` — fail-closed default deny; yetkisizken
  workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner).
- Masaüstü ZCode GUI üzerinden manuel test adımları (`Settings → Plugin Management → Discover → +`
  ile `integrations/zcode` dizinini ekleme ve `userConfig.config_json` içine ör.
  `{"allowRoots":["/path/to/your-project"],"workspaceId":"my-app"}` girme)
  `integrations/zcode/causoryn/README.md` içinde ayrıntılı belgelenmiştir; yukarıdaki dürüstlük
  beyanı uyarınca otomatik test oturumunda GUI adımı `NOT RUN` olarak tutulur.

---

## 4. `stdout` / `stderr` disiplini (kırmızı kural 4)

Hem `causoryn.mjs mcp` hem `plugin-mcp-launcher.mjs` hem de çıplak `mcp-server.mjs`, `stdout`
akışına **yalnızca saf JSON-RPC 2.0 MCP mesajları** yazar (`initialize` + `tools/list` → **29 araç**);
tüm operasyonel ve tanılama mesajları `[causoryn]` / `[causoryn-launcher]` önekiyle **`stderr`**
üzerinden iletilir. Böylece ZCode'un stdio protokol ayrıştırıcısı hiçbir log satırından etkilenmez.

## İlgili sayfalar

- [English version](../en/hosts/zcode.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md)
- Diğer host kılavuzları: [Claude Code](claude-code.md) · [Codex CLI](codex.md) · [Antigravity](antigravity.md)
- Monorepo fikstür referansı: `integrations/zcode/causoryn/README.md`
