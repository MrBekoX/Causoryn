# Causoryn'i Codex CLI'a bağlama (`stdio` MCP)

> **Dil / Language:** **Türkçe** | [English](../en/hosts/codex.md) · [Dokümantasyon Merkezi](../README.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> **Durum:** Causoryn 0.3.2'i yansıtır (11 araçlı varsayılan `core` araç profili; tüm host'lar için workspace başına tek, paylaşılan `graph.sqlite`). Bayrakların tam başvurusu için [CLI ve Konfigürasyon](../cli-and-configuration.md), araç kataloğu için [MCP Araç Sözleşmeleri](../tool-contracts.md) sayfasına bakın.

> **Bu sayfa için denetlenen kaynaklar:** `packages/causoryn/src/{setup.ts,toml-patch.ts,doctor.ts,cli.ts}`, `packages/causoryn/.codex-plugin/{plugin.json,mcp.json}`, `.agents/plugins/marketplace.json`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`.

Causoryn, kod zekâsı (code intelligence) için yerel ve deterministik bir MCP sunucusudur. Hiçbir LLM veya ağ API çağrısı yapmaz. Claude Code'un aksine `codex mcp add` komutunun **proje ya da local scope'u yoktur**: kayıtlar kullanıcı genelindeki `~/.codex/config.toml` (veya `$CODEX_HOME/config.toml`) dosyasına gider. Geçici smoke koşuları için `causoryn-smoke` gibi ayrı bir ad kullanın ve ardından `codex mcp remove` ile temizleyin.

## Doğrulama kaydı

Canlı Codex CLI koşuları (hepsi **0.3.0 öncesi** derlemeler üzerinde; 0.3.0'a karşı canlı bir yeniden koşu henüz kayda geçmedi):

| Tarih | Codex CLI | Ne çalıştırıldı | Sonuç |
|---|---|---|---|
| `2026-11-08` | `codex-cli 0.163.0` | `codex mcp --help`, `codex mcp add --help`, `codex mcp list --help`, `codex mcp remove --help`; `causoryn@0.1.0` üzerinde elle `stdout` kontrolü | Sözdizimi doğrulandı; `stdout` 2 satır saf JSON-RPC taşıdı (`initialize` ve o sürümün 29 araçlık kataloğuyla `tools/list`) |
| `2026-11-10` | `codex-cli 0.163.0` | `codex mcp add causoryn-smoke` → `codex mcp list` (görünüyor) → `codex mcp remove` → `codex mcp list` (yok), monorepo bundle | Yaşam döngüsü doğrulandı; `config.toml` sonrasında yedekten geri yüklendi (bkz. bölüm 5.5'teki yeniden serileştirme notu) |
| `2026-11-19` | `codex-cli 0.169.0` | `codex plugin marketplace add` (kök `.agents/plugins/marketplace.json`), `codex mcp add` / `codex mcp list`, paketli `causoryn setup` | Pazaryeri kabul edildi; kayıt listelendi |

Bu sayfada kullanılan 0.3.0 kod yollarının otomatik kapsamı: `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts` (izole geçici `$HOME`, TOML yaması), `tests/open-source-distribution.test.ts` (paketlenmiş `.tgz` handshake'i ve manifest paritesi) ve `tests/mcp-tool-surface-budget.test.ts` (core `tools/list` boyutu).

## Kurulum yolunu seçin

| Yol | Kimin için | Ne çalışır |
|---|---|---|
| **A. `npx causoryn@0.3.2 setup`** (önerilen) | Son kullanıcılar | Paketli giriş noktası `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client codex`; mutlak Node binary'siyle `config.toml` içine kaydedilir |
| **B. Codex plugin pazaryeri** | Plugin'leri tercih eden son kullanıcılar | `.codex-plugin/mcp.json` içinden `npx -y --ignore-scripts --package causoryn@0.3.2 causoryn mcp …` |
| **C. Elle kayıt** (`codex mcp add` veya `config.toml`) | Kaynak checkout üzerinde çalışan katkıcılar | Monorepo bundle `packages/mcp-server/dist/mcp-server.mjs` (yalnızca `CAUSORYN_CONFIG` ile yapılandırılır) |

---

## 1. Seçenek A — Tek komutla kurulum

```bash
# Hiçbir şey yazmadan planlanan değişiklikleri önizleyin
npx causoryn@0.3.2 setup --client codex --dry-run

# $CODEX_HOME/config.toml içindeki [mcp_servers.causoryn] tablosunu yamalayın ve 5 skill'i ~/.agents/skills/ altına kurun
npx causoryn@0.3.2 setup --client codex --yes

# Salt okunur sağlık ve hizalama kontrolü
npx causoryn@0.3.2 doctor --client codex

# Temiz kaldırma ([mcp_servers.causoryn] ve alt tabloları + 5 Causoryn skill'i)
npx causoryn@0.3.2 setup --client codex --uninstall --yes
```

### `setup --client codex` neyi yazar

`setup` tam olarak şu tabloyu yazar (`packages/causoryn/src/toml-patch.ts` içindeki `renderCausorynSections`):

```toml
[mcp_servers.causoryn]
command = "/path/to/node"
args = ["/home/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "codex"]
startup_timeout_sec = 30
```

- **Hedef dosya:** `CODEX_HOME` tanımlıysa `$CODEX_HOME/config.toml`, değilse `~/.codex/config.toml` (`resolveEffectiveCodexHomeDir`). `doctor` aynı dosyayı okur. Bu dizin ya da dosya mevcutsa Codex algılanmış sayılır.
- **Cerrahi TOML yaması:** `codex mcp add`'in aksine `setup` dosyayı yeniden serileştirmez. Yorumlar, üst düzey anahtarlar, komşu `[mcp_servers.<other>]` tabloları ve `[mcp_servers.causoryn.tools.*]` onay alt tabloları olduğu gibi korunur (yalnızca tablolar arasındaki ardışık boş satırlar normalleştirilir) ve dosyanın satır sonu biçimi (`\n` veya `\r\n`) korunur. `[mcp_servers.causoryn]` içinde setup yalnızca `command`, `args` (`--tool-profile` ve `--output-schema` argümanlarınız korunarak) ve `startup_timeout_sec` alanlarını günceller; diğer her anahtar ve `[mcp_servers.causoryn.env]` tablosu değerini ve konumunu korur, güncel bir tablo yeniden yazılmaz.
- **`startup_timeout_sec = 30`**, soğuk Node.js + SQLite açılışına yeterli pay bırakır. Sizin ayarladığınız `30` veya daha yüksek bir değer olduğu gibi korunur; daha düşük veya kullanılamaz bir değer `30`'a yükseltilir ve setup çıktısı bunu belirtir.
- **Mutlak Node binary'si:** `command`, `setup`'ı çalıştıran Node.js'in `process.execPath` değeridir (Node.js ≥ 24 gerekir).
- **Kalıcı runtime:** `setup` bir `_npx` önbelleğinden ya da işletim sisteminin temp dizininden çalıştırıldığında paketi önce `~/.causoryn/runtime` altına kopyalar ve `args[0]`'ı oraya yönlendirir; böylece kayıt `npx` önbelleği temizlendiğinde de çalışmaya devam eder.
- **Skill'ler:** beş kanonik skill — `causoryn`, `map-system`, `preflight-change`, `verify-change` ve `architecture-blueprint` — `~/.agents/skills/<name>/SKILL.md` altına yazılır (`CODEX_HOME` altına değil, ev dizininize). Atlamak için `--no-skill` verin. `architecture-blueprint`, Codex'in MCP kanıtlarından isteğe bağlı `annotations` taslağı hazırlamasına rehberlik eder; annotation'sız export için doğrudan `causoryn_export_documentation` çağırın ([mimari export sözleşmesi](../tool-contracts.md)). Skill'ler host modeli için yönlendirme metnidir: bir skill'in andığı araç ancak etkin araç profili onu kaydediyorsa çağrılabilir.

### `setup` nasıl davranır (tüm host'lar)

- **Algılama:** `--client` veya `--all` olmadan yalnızca algılanan host'lar yapılandırılır; hiçbiri algılanmazsa hiçbir şey yazılmaz ve `setup` `stderr`'e yönlendirme yazarak `1` ile çıkar.
- **Onay:** `--yes` olmadan (ve `--dry-run` olmadan) etkileşimli bir terminal planı gösterir ve `Continue? [y/N]` diye sorar; etkileşimsiz bir kabuk "confirmation required" hatasıyla durur ve hiçbir şey yazmaz.
- **Yedekler:** mevcut bir `config.toml` ilk kez değiştirilmeden önce orijinali `config.toml.causoryn.backup` dosyasına kopyalanır. Bu dosyanın üzerine asla yazılmaz; sonraki değişiklikler ek `config.toml.causoryn.<timestamp>-<nonce>.backup` kopyaları oluşturur.
- **Atomik, idempotent yazımlar:** geçici dosya + rename; mevcut dosya kipi korunur (yeni dosyalar `0600`); aynı ikinci koşu `noop` raporlar.
- **Fail-closed ayrıştırma:** bozuk TOML (kapanmamış string, dizi veya tablolar, `=` içermeyen bir satır, boş bir tablo başlığı ya da iki `[mcp_servers.causoryn]` tablosu gibi tekrarlanan bir tablo başlığı), hiçbir şey yazılmadan koşuyu `cli/malformed-toml` ile durdurur. Sembolik link hedefleri reddedilir.
- **Çıkış kodları:** `setup` başarıda `0`, hiçbir host algılanmadığında ve hiçbiri adlandırılmadığında `1`, herhangi bir hatada `2` ile çıkar.
- **Kaldırma:** `[mcp_servers.causoryn]` tablosunu ve tüm `[mcp_servers.causoryn.*]` alt tablolarını, beş skill dizinini ve — başka hiçbir host config'i ona hâlâ başvurmuyorsa — `~/.causoryn/runtime` dizinini kaldırır.

### `doctor` denetimleri

`causoryn doctor` salt okunurdur. Node.js ≥ 24'ü, paket kökü ile `~/.causoryn/runtime` içindeki runtime dosyalarını, `dotnet` / `python` / `go` / `cargo` araç zincirlerini (eksik olan `l0-l1-fallback` olarak raporlanır: o dil dosya düzeyinde analize geri düşer) ve her host'u denetler. Codex için TOML yapısını doğrular, `[mcp_servers.causoryn]` tablosunu okur, `command` bir Node binary'si olduğunda giriş betiğinin mevcut olduğunu ve beş skill'i denetler. Host durumu `OK`, `WARN`, `NOT-CONFIGURED` veya `ERROR` olur; genel sonuç `HEALTHY`, `DEGRADED`, `NOT CONFIGURED` veya `UNHEALTHY` olur ve `doctor` yalnızca `HEALTHY` için `0` ile (aksi halde `1` ile) çıkar.

## 2. Seçenek B — Yerel Codex plugin pazaryeri

Kök `.agents/plugins/marketplace.json`, Codex plugin pazaryeri şemasını izler:

- `source: { "source": "npm", "package": "causoryn", "version": "0.3.2" }`
- `policy.installation: "AVAILABLE"` ve `policy.authentication: "ON_INSTALL"`. Causoryn hiçbir kimlik bilgisine veya API anahtarına ihtiyaç duymaz; `"ON_INSTALL"`, kurulum anında onay için pazaryeri politika şemasını karşılar.

Kurulu paketin `.codex-plugin/plugin.json` dosyası skill'leri taşır (`"skills": "./skills"`) ve `mcpServers` alanını `./.codex-plugin/mcp.json` dosyasına yönlendirir:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "npx",
      "args": [
        "-y",
        "--ignore-scripts",
        "--package",
        "causoryn@0.3.2",
        "causoryn",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "codex"
      ],
      "startup_timeout_sec": 30
    }
  }
}
```

Codex plugin'i sunucuyu tam sürüm pini ile `npx` üzerinden başlatır; bu yüzden ilk açılış npm registry'ye ya da önceden doldurulmuş bir `npx` önbelleğine ihtiyaç duyar. (Claude Code ve ZCode plugin'leri bunun yerine `plugin-mcp-launcher.mjs` kullanır.)

## 3. Codex'te araç profilleri

Sunucu `core` profiliyle başlar: 11 araç (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`). `outputSchema` varsayılan olarak çıkarıldığı için core `tools/list` yanıtı 15.000 karakterin altında kalır (`--output-schema full` onu geri ekler; yanıtlar her iki durumda da kendi şemalarına göre doğrulanır).

| Profil | Ekledikleri |
|---|---|
| `wiki` | 7 `causoryn_wiki_*` aracı |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | 29 legacy aracın tamamı artı `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 araç); yerini yeni araçlara bırakan legacy araçlar bir deprecation notu taşır |

Profiller virgülle birleştirilir (`wiki,history`). Öncelik sırası `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core` şeklindedir; verilen her değer doğrulanır ve bilinmeyen bir profil adı sunucuyu başlangıçta durdurur. Codex'te:

```toml
# Ya bayrağı paketli giriş noktasının args dizisine ekleyin ...
[mcp_servers.causoryn]
command = "/path/to/node"
args = ["/home/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "codex", "--tool-profile", "wiki,history"]
startup_timeout_sec = 30

# ... ya da ortam değişkenini tanımlayın (monorepo bundle için tek seçenek budur)
[mcp_servers.causoryn.env]
CAUSORYN_TOOL_PROFILE = "full"
```

- `codex mcp add` ile `--env CAUSORYN_TOOL_PROFILE=full` verin.
- `npx causoryn@latest setup --client codex --tool-profile wiki,history --yes` bayrağı sizin yerinize yazar. `causoryn setup`'ı yeniden çalıştırmak `[mcp_servers.causoryn.env]` tablosunu, `--tool-profile` ve `--output-schema` argümanlarını ve tablonun diğer anahtarlarını, ayrıca 30 veya daha yüksek bir `startup_timeout_sec` değerini korur; profili değiştirmek için `setup --tool-profile <list>` verin.
- Pazaryeri plugin'inde manifest kurulu plugin'in içinde bulunur ve düzenlenmemelidir. Codex'in `CAUSORYN_TOOL_PROFILE` değerini kendi ortamından plugin sunucularına aktarıp aktarmadığı doğrulanmamıştır; varsayılan dışında bir profile ihtiyacınız varsa Seçenek A veya C'yi kullanın.

## 4. Veri dizini ve ilk çalıştırma

- `--auto-data-dir` (veya `--data-dir <abs>`) ile indeks `<base>/workspaces/<slug>-<hash12>/graph.sqlite` konumunda, export çıktısı ise `<base>/workspaces/<slug>-<hash12>/exports/` altında tutulur. Taban dizin önceliği her host için aynıdır: `--data-dir` > `~/.causoryn` (`ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` oluşturulamadığında veya yazılamadığında yedek).
- **Tüm host'lar için workspace başına tek veritabanı.** Codex, Claude Code, Antigravity ve ZCode aynı taban dizini kullandıklarında aynı `graph.sqlite` dosyasını açar. `--client codex` yalnızca bir tanılama etiketidir (`build_leases.host_label` olarak kaydedilir). `build_leases` tek-yazar kirası (single-writer lease), iki sürecin aynı anda snapshot yayımlamasını engeller.
- 0.3.0 öncesi sürümler host başına `graph-<client>.sqlite` dosyaları kullanıyordu. `graph.sqlite` henüz yoksa 0.3.0'ın ilk açılışı en yeni geçerli olanı bir kez ona kopyalar; eski dosyalar yerinde kalır ve `causoryn doctor` bunları listeler, böylece silebilirsiniz. `fp3` analizör parmak izi yine de 0.3.0'ın ilk açılışında bir kez yeniden indekslemeye yol açar.
- Dizinler `0700` kipiyle oluşturulur ve her yetkili proje kökünün kesinlikle dışında bulunmalıdır. Analiz edilen kaynak ağacına hiçbir şey yazılmaz.
- İndeksleme bir `worker_threads` worker'ında çalışır. Paketli giriş noktasıyla (Seçenek A ve B), ilk indeks yayımlanmadan önce yapılan bir araç çağrısı en fazla `CAUSORYN_INDEX_WAIT_MS` kadar bekler (varsayılan `15000`; `0` = bekleme) ve ardından `data.status: "indexing"`, `jobId`, `progress` ve `retryAfterMs` ile birlikte `status: "partial"` döndürür. `causoryn_status` hemen yanıt verir.
- `--allow-cwd`, Codex'in sunucuyu başlattığı dizini bir güvenlik denetiminden sonra bağlar; bu denetim `$HOME`, dosya sistemi köklerini, sistem dizinlerini, `~/.codex`, plugin kurulum dizinlerini ve Causoryn veri dizinini reddeder. Başlangıç dizini reddedildiğinde sunucu MCP `roots/list` üzerinden güvenli bir kök gelmesini bekler; o zamana kadar workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürür. Codex'i projenin içinde başlatın ya da `args` dizisine `"--root", "/path/to/your-project"` ekleyin.

---

## 5. Seçenek C — Kaynak checkout'tan elle kayıt

### 5.1 Bundle'ı derleyin

```bash
npm run build:bundle --workspace packages/mcp-server
```

Betik yalnızca `packages/mcp-server/package.json` içinde tanımlıdır (depo kökünde `--workspace` olmadan çalıştırmak `Missing script` hatasıyla başarısız olur). Deterministik çıktı 36 girdili bir `bundle-manifest.json` ile tanımlanır:

```text
packages/mcp-server/dist/
├── bundle-manifest.json         ← sıralı SHA-256 manifesti (36 girdi)
├── mcp-server.mjs               ← stdio giriş noktası (src/stdio.ts'ten derlenir)
├── index-worker.mjs             ← indeksleme worker_threads giriş noktası
├── mcp-server.mjs.LEGAL.txt     ← esbuild'in ürettiği üçüncü taraf lisans bildirimleri
└── node_modules/better-sqlite3/ ← native modül (LICENSE, package.json, lib/, prebuilds/)
```

`dist/` dizininin tamamını bir arada tutun: native `.node` prebuild'leri `mcp-server.mjs` içine gömülemez.

Bu bundle **hiçbir komut satırı bayrağı okumaz**. Yapılandırması yalnızca `CAUSORYN_CONFIG` (katı JSON şeması; `packages/mcp-server/src/config.ts` içindeki `parseCausorynServerConfig`) ve `CAUSORYN_TOOL_PROFILE` üzerinden gelir. `CAUSORYN_CONFIG` olmadan `allowRoots: []` ile fail-closed başlar; bu durumda workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürür. `storage.dataDbPath` olmadan graph bellekte tutulur ve her açılışta yeniden oluşturulur.

### 5.2 Yöntem A — `codex mcp add` (elle düzenlemeye göre önerilir)

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Sözdizimi (`codex mcp add --help`): `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`. `--` sonrasındaki her şey sunucunun başlatma komutudur.

### 5.3 Yöntem B — `config.toml` tablosu (elle düzenleme)

```toml
[mcp_servers.causoryn]
command = "node"
args = ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
startup_timeout_sec = 30

[mcp_servers.causoryn.env]
CAUSORYN_CONFIG = '{"allowRoots":["/path/to/your-project"]}'
```

- `args` içinde **mutlak** bir yol kullanın; Codex, MCP sunucularını geçerli dizininizden bağımsız olarak başlatır.
- İndeksi kalıcı tutmak için `CAUSORYN_CONFIG` değerini `"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}` ile (ve `"wiki":{"dataDbPath":…}` için aynı yolla) genişletin; üst dizin mevcut olmalı ve her yetkili kökün dışında bulunmalıdır.

### 5.4 Doğrulama

```bash
codex mcp list            # insan tarafından okunabilir çıktı
codex mcp list --json     # makine tarafından okunabilir çıktı
codex mcp get causoryn    # tek girdi
```

Beklenen: `causoryn`, `node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs` komutuyla listelenir.

**Dürüst sınırlar (`0.163.0` canlı kanıtı, `2026-11-10`; `0.169.0`'da değişmedi):**

- `codex mcp list` **canlı health-check yapmaz**: sunucuyu başlatmadan `config.toml` dosyasını okur; bu yüzden Claude Code'daki gibi bir `Connected` / `Failed` yoklaması yoktur. Gerçek başlatma ve handshake canlı bir Codex oturumunda gerçekleşir (ve ayrıca otomatik `stdio` spawn testleri ile Claude Code canlı koşularıyla kapsanır).
- `codex mcp add` betik yolunu doğrulamaz: geçersiz bir yolu (`node Z:/definitely/not/here.mjs`) kaydetmek başarılı olur ve `list` çıktısında `enabled` olarak görünür; yalnızca oturum açılışında başarısız olur.
- Bilinmeyen bir ad kesin hatadır: `codex mcp get no-such-server-xyz` → `Error: No MCP server named 'no-such-server-xyz' found.` (çıkış `1`).

### 5.5 Temizlik ve smoke disiplini

```bash
codex mcp remove causoryn
```

Kalıcı olmayan testler için ayrı bir adla kaydedin ve ardından kaldırıldığını doğrulayın:

```bash
codex mcp add causoryn-smoke -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # causoryn-smoke artık yok
```

**TOML yeniden serileştirme uyarısı (`0.163.0` canlı bulgusu, `2026-11-10`):** `codex mcp add` ve `codex mcp remove`, `~/.codex/config.toml` dosyasını ayrıştırıp baştan **yeniden serileştirir**. `causoryn` bloğu temiz biçimde eklenir ve kaldırılır; ancak komşu `[mcp_servers.*]` tablolarının biçimi değişebilir (örneğin `env` içindeki anahtar sırası ya da `startup_timeout_sec = 120` değerinin `120.0` olarak yeniden yazılması). `codex mcp` bayt düzeyinde değişmezlik garanti etmez. Elle yapılan smoke testlerinden önce dosyanın yedeğini alın ve sonrasında hash'leri karşılaştırın:

```bash
cp ~/.codex/config.toml /tmp/config.toml.bak
sha256sum ~/.codex/config.toml   # öncesi
# ... add → list → remove → list ...
sha256sum ~/.codex/config.toml   # sonrası; biçim kaydıysa yedeği geri yükleyin
```

`causoryn setup` yalnızca kendi tablosunu yamaladığı için bu sorunu yaşamaz (bölüm 1).

## 6. `stdout` hijyeni

Her Causoryn giriş noktası `stdout`'a **yalnızca MCP JSON-RPC 2.0 çerçeveleri** yazar; tüm tanılama çıktıları `[causoryn]` (veya `[causoryn-launcher]`) önekiyle `stderr`'e gider; böylece log satırları Codex'in JSON-RPC hattına asla karışmaz.

## 7. Sorun giderme

| Belirti | Neden ve çözüm |
|---|---|
| `setup`, `cli/malformed-toml` ile duruyor | `config.toml` dosyasında bir sözdizimi sorunu ya da tekrarlanan bir tablo başlığı var. Düzeltin veya `config.toml.causoryn.backup` yedeğini geri yükleyin; hiçbir şey yazılmadı. |
| Codex bir başlangıç zaman aşımı bildiriyor | Soğuk açılış yapılandırılmış zaman aşımını aştı. Girdide `startup_timeout_sec = 30` (veya daha yüksek) değerini koruyun. |
| `doctor` giriş betiği için `ERROR` gösteriyor | `~/.causoryn/runtime` ya da orijinal kurulum kaldırılmış. `npx causoryn@0.3.2 setup --client codex --yes` komutunu yeniden çalıştırın. |
| Sunucu açılışta "Unsupported Node.js version" ile çıkıyor | Node.js < 24. Node.js 24+ kurun ve `setup`'ı yeniden çalıştırın. |
| Ek `args` kayboldu | `setup`'ı yeniden çalıştırmak argüman listesini yeniden üretir ve yalnızca `--tool-profile` ile `--output-schema` argümanlarınızı (ayrıca `[mcp_servers.causoryn.env]` tablosunu ve tablonun diğer anahtarlarını) korur. Diğer argümanları yeniden uygulayın veya profil için `setup --tool-profile <list>` kullanın. |
| Workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürüyor | Başlangıç dizini `--allow-cwd` tarafından reddedildi ve kullanılabilir bir kök bildirilmedi ya da çıplak bundle'da `allowRoots` yok. Bkz. bölüm 4 veya 5.1. |
| Wiki veya history araçları `tools/list` içinde yok | Varsayılan `core` profili etkin. Bkz. bölüm 3. |

## İlgili sayfalar

- [5 Dakikada Başlangıç (İngilizce)](../en/tutorial-5-minutes.md) · [CLI ve Konfigürasyon](../cli-and-configuration.md) · [MCP Araç Sözleşmeleri](../tool-contracts.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md) · [English version](../en/hosts/codex.md)
- Diğer host kılavuzları: [Claude Code](claude-code.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
