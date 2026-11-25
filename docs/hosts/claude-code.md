# Causoryn'i Claude Code'a bağlama (`stdio` MCP)

> **Dil / Language:** **Türkçe** | [English](../en/hosts/claude-code.md) · [Dokümantasyon Merkezi](../README.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> **Durum:** Causoryn 0.3.1'i yansıtır (11 araçlı varsayılan `core` araç profili; tüm host'lar için workspace başına tek, paylaşılan `graph.sqlite`). Bayrakların tam başvurusu için [CLI ve Konfigürasyon](../cli-and-configuration.md), araç kataloğu için [MCP Araç Sözleşmeleri](../tool-contracts.md) sayfasına bakın.

> **Bu sayfa için denetlenen kaynaklar:** `packages/causoryn/src/{setup.ts,doctor.ts,cli.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs}`, `packages/causoryn/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `packages/mcp-server/src/{stdio.ts,cli-stdio.ts,runtime-cli.ts,config.ts}`, `packages/mcp-server/scripts/build-bundle.mjs`.

Causoryn, kod zekâsı (code intelligence) için yerel ve deterministik bir MCP sunucusudur. Hiçbir LLM veya ağ API çağrısı yapmaz. Claude Code henüz kurulu değilse `npm install -g @anthropic-ai/claude-code` ile kurun.

## Doğrulama kaydı

Canlı Claude Code CLI koşuları (hepsi **0.3.0 öncesi** derlemeler üzerinde; 0.3.0'a karşı canlı bir yeniden koşu henüz kayda geçmedi):

| Tarih | Claude Code | Ne çalıştırıldı | Sonuç |
|---|---|---|---|
| `2026-11-08` | `2.1.319` | `claude mcp --help`, `claude mcp add --help` sözdizimi kontrolü; `causoryn@0.1.0` üzerinde elle `stdout` kontrolü | Sözdizimi doğrulandı; `stdout` 2 satır saf JSON-RPC taşıdı (`initialize` ve o sürümün 29 araçlık kataloğuyla `tools/list`) |
| `2026-11-10` | `2.1.322` | Yönlendirilmiş geçici bir `CLAUDE_CONFIG_DIR` içinde `claude mcp add` → `claude mcp list` → `claude mcp remove` (monorepo bundle) | `✔ Connected`; `sha256sum ~/.claude.json` öncesinde ve sonrasında birebir aynı; geçersiz yol denemesi `✘ Failed to connect — CONNECTION_CLOSED` raporladı |
| `2026-11-19` | `2.1.328` | Kök `.claude-plugin/marketplace.json` üzerinde `claude plugin validate --strict`; paketli `causoryn setup`; `claude mcp list` | Doğrulama geçti; `√ Connected` |

Bu sayfada kullanılan 0.3.0 kod yollarının otomatik kapsamı: `tests/causoryn-setup.test.ts`, `tests/causoryn-doctor.test.ts`, `packages/causoryn/test/setup-and-doctor.test.ts` (izole geçici `$HOME`), `tests/open-source-distribution.test.ts` (paketlenmiş `.tgz` handshake'i), `tests/mcp-tool-surface-budget.test.ts` (core `tools/list` boyutu) ve `tests/hosts-docs.test.ts` (monorepo bundle varlığı ve manifest hash'i).

## Kurulum yolunu seçin

| Yol | Kimin için | Ne çalışır |
|---|---|---|
| **A. `npx causoryn@0.3.1 setup`** (önerilen) | Son kullanıcılar | Paketli giriş noktası `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client claude-code`; mutlak Node binary'siyle `~/.claude.json` içine kaydedilir |
| **B. Claude Code plugin pazaryeri** | `/plugin` akışını tercih eden son kullanıcılar | Kurulu npm paketindeki paketli `plugin-mcp-launcher.mjs` |
| **C. Elle kayıt** (`.mcp.json` veya `claude mcp add`) | Kaynak checkout üzerinde çalışan katkıcılar | Monorepo bundle `packages/mcp-server/dist/mcp-server.mjs` (yalnızca `CAUSORYN_CONFIG` ile yapılandırılır) |

---

## 1. Seçenek A — Tek komutla kurulum

```bash
# Hiçbir şey yazmadan planlanan değişiklikleri önizleyin
npx causoryn@0.3.1 setup --client claude-code --dry-run

# MCP sunucusunu ~/.claude.json içine kaydedin ve 5 skill'i ~/.claude/skills/ altına kurun
npx causoryn@0.3.1 setup --client claude-code --yes

# Salt okunur sağlık ve hizalama kontrolü
npx causoryn@0.3.1 doctor --client claude-code

# Temiz kaldırma (mcpServers.causoryn + 5 Causoryn skill'i)
npx causoryn@0.3.1 setup --client claude-code --uninstall --yes
```

### `setup --client claude-code` neyi yazar

`setup`, `~/.claude.json` dosyasındaki **üst düzey** `mcpServers` nesnesine `causoryn` anahtarını ekler ya da mevcut bir kayıtta yalnızca sahibi olduğu anahtarları (`command`, `args`, `type`) günceller (bu, Claude Code'un user scope'udur; sunucu böylece her projede kullanılabilir, `--allow-cwd` ise Claude Code'un başlatıldığı proje dizinini bağlar). Dosyadaki diğer anahtarlar korunur:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": [
        "/home/you/.causoryn/runtime/scripts/causoryn.mjs",
        "mcp",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "claude-code"
      ]
    }
  }
}
```

- **Mutlak Node binary'si:** `command`, `setup`'ı çalıştıran Node.js'in `process.execPath` değeridir (Node.js ≥ 24 gerekir); `PATH` üzerinde aranan çıplak bir `node` değildir.
- **Kalıcı runtime:** `setup` geçici bir konumdan (bir `_npx` önbellek dizini ya da işletim sisteminin temp dizini altındaki herhangi bir yer) çalıştırıldığında paketi önce `~/.causoryn/runtime` altına kopyalar (geçici bir dizinde hazırlanır ve rename ile yerine alınır) ve `args[0]`'ı oraya yönlendirir; böylece kayıt `npx` önbelleği temizlendiğinde de çalışmaya devam eder. Normal bir kurulumdan çalıştırıldığında `args[0]` o kurulumu gösterir.
- **`CLAUDE_CONFIG_DIR`:** bu değişken tanımlıysa `setup` ve `doctor`, `~/.claude.json` ve `~/.claude/skills/` yerine `$CLAUDE_CONFIG_DIR/.claude.json` ve `$CLAUDE_CONFIG_DIR/skills/` yollarını kullanır (`packages/causoryn/src/setup.ts` içindeki `resolveEffectiveClaudeConfigDir`). Birden çok profil ve izole smoke koşuları için kullanın.
- **Skill'ler:** beş kanonik skill — `causoryn`, `map-system`, `preflight-change`, `verify-change` ve `architecture-blueprint` — `~/.claude/skills/<name>/SKILL.md` altına yazılır. Yalnızca MCP sunucusunu kaydetmek için `--no-skill` verin. `architecture-blueprint`, Claude'un MCP kanıtlarından isteğe bağlı `annotations` taslağı hazırlamasına rehberlik eder; annotation'sız export için doğrudan `causoryn_export_documentation` çağırın ([mimari export sözleşmesi](../tool-contracts.md)). Skill'ler host modeli için yönlendirme metnidir: bir skill'in andığı araç ancak etkin araç profili onu kaydediyorsa çağrılabilir.

### `setup` nasıl davranır (tüm host'lar)

- **Algılama:** `--client` veya `--all` olmadan `setup` yalnızca algılanan host'ları yapılandırır. `~/.claude.json` veya `~/.claude` mevcutsa (ya da `CLAUDE_CONFIG_DIR` ile o dizin veya içindeki `.claude.json` mevcutsa) Claude Code algılanmış sayılır. Hiçbir host algılanmazsa hiçbir dosya yazılmaz, komut bir client'ın nasıl seçileceğini `stderr`'e yazdırır ve `1` ile çıkar.
- **Onay:** `--yes` olmadan (ve `--dry-run` olmadan) etkileşimli bir terminal planı gösterir ve `Continue? [y/N]` diye sorar. Etkileşimsiz bir kabukta komut "confirmation required" hatasıyla durur ve hiçbir şey yazmaz.
- **Yedekler:** mevcut bir config ilk kez değiştirilmeden önce orijinali `~/.claude.json.causoryn.backup` dosyasına kopyalanır. Bu dosyanın üzerine asla yazılmaz; sonraki değişiklikler ek `~/.claude.json.causoryn.<timestamp>-<nonce>.backup` kopyaları oluşturur. Yeni oluşturulan bir dosyanın yedeği alınmaz.
- **Atomik, idempotent yazımlar:** her dosya geçici bir kardeş dosyaya yazılır ve mevcut dosya kipi korunarak rename ile yerine alınır (yeni config dosyaları `0600` kipiyle oluşturulur). Aynı ikinci koşu `noop` raporlar ve hiçbir dosyaya ya da yedeğe dokunmaz.
- **Fail-closed ayrıştırma:** geçerli JSON olmayan ya da `mcpServers` alanı nesne olmayan bir config, hiçbir şey yazılmadan koşuyu `cli/malformed-json` ile durdurur. Sembolik link hedefleri ve normal olmayan dosyalar reddedilir.
- **Çıkış kodları:** `setup` başarıda (dry run, no-op ve reddedilen onay sorusu dahil) `0`, hiçbir host algılanmadığında ve hiçbiri adlandırılmadığında `1` (hiçbir şey yazılmaz), herhangi bir hatada `2` ile çıkar.
- **Kaldırma:** `--uninstall`, `mcpServers.causoryn` girdisini (geriye boş bir `mcpServers` nesnesi kalır) ve beş skill dizinini siler; `~/.causoryn/runtime` dizinini ise yalnızca başka hiçbir host config'i ona hâlâ başvurmuyorsa kaldırır.

### `doctor` denetimleri

`causoryn doctor` salt okunurdur. Node.js ≥ 24'ü ve paket kökü ile `~/.causoryn/runtime` içindeki runtime dosyalarını (`dist/mcp-server.mjs`, geçerli platform için `better-sqlite3` prebuild'i, paketlenmiş TypeScript kütüphanesi ve native sidecar worker kaynakları) denetler; `dotnet`, `python`, `go` ve `cargo` araç zincirlerini yoklar (eksik bir araç zinciri `l0-l1-fallback` olarak raporlanır; yani o dil dosya düzeyinde analize geri düşer) ve her host'u inceler:

- Claude Code host durumu `OK` (geçerli config, `mcpServers.causoryn` mevcut, `command` bir Node binary'si olduğunda giriş betiği mevcut, beş skill'in tamamı mevcut), `WARN` (tüm skill'ler olmadan MCP girdisi ya da girdi olmadan skill'ler), `NOT-CONFIGURED` veya `ERROR` (ayrıştırılamayan config ya da eksik giriş betiği — `setup`'ı yeniden çalıştırın) olur.
- Genel sonuç `HEALTHY`, `DEGRADED`, `NOT CONFIGURED` veya `UNHEALTHY` olur. `doctor` yalnızca `HEALTHY` için `0`, diğer tüm durumlarda `1` ile çıkar. `--client claude-code`, genel sonucu Claude Code ile sınırlar.

## 2. Seçenek B — Yerel Claude Code plugin pazaryeri

```text
/plugin marketplace add MrBekoX/Causoryn
/plugin install causoryn@causoryn
```

Kök `.claude-plugin/marketplace.json` bir npm kaynağı beyan eder (`{ "source": "npm", "package": "causoryn", "version": "0.3.1" }`). Kurulu paketin `.claude-plugin/plugin.json` dosyası skill'leri taşır (`"skills": "./skills"`) ve sunucuyu şöyle kaydeder:

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs",
        "--expected-version",
        "0.3.1",
        "--allow-cwd",
        "--auto-data-dir",
        "--client",
        "claude-code"
      ]
    }
  }
}
```

`plugin-mcp-launcher.mjs`, kurulu `package.json` dosyasının tam olarak `--expected-version` sürümündeki `causoryn` paketi olduğunu (ve tanımlıysa `CAUSORYN_EXPECTED_VERSION` değeriyle uyuştuğunu) denetler. İç içe bir `npx` süreci başlatmaz. Sürüm uyuşmazlığında ya da bundle eksikse `stderr` üzerine bir `[causoryn-launcher]` mesajı yazarak `2` ile çıkar. Aksi halde `CAUSORYN_ASSET_ROOT` değerini atar ve `dist/mcp-server.mjs` modülünü doğrudan import eder; böylece `stdout` MCP çerçevelerine ayrılmış kalır. `${CLAUDE_PLUGIN_ROOT}` hiçbir zaman analiz edilen proje kökü olarak kabul edilmez.

## 3. Claude Code'da araç profilleri

Sunucu `core` profiliyle başlar: 11 araç (`causoryn_status`, `causoryn_map_system`, `causoryn_find_symbols`, `causoryn_get_symbol_context`, `causoryn_trace`, `causoryn_get_agent_context`, `causoryn_preflight_change`, `causoryn_verify_change`, `causoryn_contracts`, `causoryn_get_evidence`, `causoryn_export_documentation`). `outputSchema` varsayılan olarak çıkarıldığı için core `tools/list` yanıtı 15.000 karakterin altında kalır (`--output-schema full` onu geri ekler; yanıtlar her iki durumda da kendi şemalarına göre doğrulanır).

| Profil | Ekledikleri |
|---|---|
| `wiki` | 7 `causoryn_wiki_*` aracı |
| `history` | `causoryn_compare_architecture`, `causoryn_architecture_timeline` |
| `full` | 29 legacy aracın tamamı artı `causoryn_status`, `causoryn_trace`, `causoryn_contracts` (32 araç); yerini yeni araçlara bırakan legacy araçlar bir deprecation notu taşır |

Profiller virgülle birleştirilir (`wiki,history`). Öncelik sırası `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core` şeklindedir; verilen her değer doğrulanır ve bilinmeyen bir profil adı sunucuyu başlangıçta durdurur. Claude Code'da:

- **`setup`'ın yazdığı girdi:** `npx causoryn@latest setup --client claude-code --tool-profile wiki,history --yes` çalıştırın ya da elle `args` dizisinin sonuna `"--tool-profile", "wiki,history"` ekleyin veya `~/.claude.json` içindeki `causoryn` girdisine `"env": { "CAUSORYN_TOOL_PROFILE": "full" }` ekleyin. `setup`'ı yeniden çalıştırmak girdinin `env` nesnesini, `--tool-profile` ve `--output-schema` argümanlarını ve eklediğiniz diğer anahtarları (örneğin `disabled`) korur; profili değiştirmek için `setup --tool-profile <list>` verin.
- **`claude mcp add`:** paketli giriş noktası (kurulu npm paketi): `claude mcp add causoryn -s local -- node /path/to/node_modules/causoryn/scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client claude-code --tool-profile full`. Monorepo bundle (CLI bayrağı okumaz): `claude mcp add causoryn -s local -e CAUSORYN_TOOL_PROFILE=full -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs`.
- **Pazaryeri plugin'i:** manifest kurulu plugin'in içinde bulunur ve düzenlenmemelidir. `CAUSORYN_TOOL_PROFILE` yalnızca Claude Code onu kendi ortamından plugin MCP sunucularına aktarırsa etkili olur; bu doğrulanmamıştır. Varsayılan dışında bir profile ihtiyacınız varsa Seçenek A veya C'yi kullanın.

## 4. Veri dizini ve ilk çalıştırma

- `--auto-data-dir` (veya `--data-dir <abs>`) ile indeks `<base>/workspaces/<slug>-<hash12>/graph.sqlite` konumunda, export çıktısı ise `<base>/workspaces/<slug>-<hash12>/exports/` altında tutulur. Taban dizin önceliği her host için aynıdır: `--data-dir` > `~/.causoryn` (`ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` oluşturulamadığında veya yazılamadığında yedek).
- **Tüm host'lar için workspace başına tek veritabanı.** Claude Code, Codex, Antigravity ve ZCode aynı taban dizini kullandıklarında aynı `graph.sqlite` dosyasını açar. `--client claude-code` yalnızca bir tanılama etiketidir (`build_leases.host_label` olarak kaydedilir). `build_leases` tek-yazar kirası (single-writer lease), iki sürecin aynı anda snapshot yayımlamasını engeller.
- 0.3.0 öncesi sürümler host başına `graph-<client>.sqlite` dosyaları kullanıyordu. `graph.sqlite` henüz yoksa 0.3.0'ın ilk açılışı en yeni geçerli olanı bir kez ona kopyalar; eski dosyalar yerinde kalır ve `causoryn doctor` bunları listeler, böylece silebilirsiniz. `fp3` analizör parmak izi yine de 0.3.0'ın ilk açılışında bir kez yeniden indekslemeye yol açar.
- Dizinler `0700` kipiyle oluşturulur ve her yetkili proje kökünün kesinlikle dışında bulunmalıdır (sözcüksel ve gerçek yol denetimleri; sembolik linkli üst dizinler reddedilir). Analiz edilen kaynak ağacına hiçbir şey yazılmaz.
- İndeksleme bir `worker_threads` worker'ında çalışır. Paketli giriş noktasıyla (Seçenek A ve B), ilk indeks yayımlanmadan önce yapılan bir araç çağrısı en fazla `CAUSORYN_INDEX_WAIT_MS` kadar bekler (varsayılan `15000`; `0` = bekleme) ve ardından `data.status: "indexing"`, `jobId`, `progress` ve `retryAfterMs` ile birlikte `status: "partial"` döndürür. `causoryn_status` hemen yanıt verir.
- `--allow-cwd` güvenli olmayan başlangıç dizinlerini reddeder (örneğin `$HOME`, bir dosya sistemi kökü, sistem dizinleri, `~/.claude`, plugin kurulum dizinleri veya Causoryn veri dizini). Bu durumda sunucu yetkili bir kök olmadan başlar ve host'un MCP `roots/list` üzerinden bildirdiği ilk güvenli `file://` kökünü bağlar; o zamana kadar workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürür. Claude Code'u projenin içinde başlatın ya da `--root /path/to/your-project` verin.

---

## 5. Seçenek C — Kaynak checkout'tan elle kayıt

### 5.1 Bundle'ı derleyin

```bash
npm run build:bundle --workspace packages/mcp-server
```

Betik yalnızca `packages/mcp-server/package.json` içinde tanımlıdır; depo kökünde `--workspace` olmadan çalıştırmak `Missing script` hatasıyla başarısız olur. Çıktı derlemeler arasında deterministiktir ve 36 girdili bir `bundle-manifest.json` (dosya başına sıralı SHA-256) ile tanımlanır:

```text
packages/mcp-server/dist/
├── bundle-manifest.json         ← sıralı SHA-256 manifesti (36 girdi)
├── mcp-server.mjs               ← stdio giriş noktası (src/stdio.ts'ten derlenir)
├── index-worker.mjs             ← indeksleme worker_threads giriş noktası
├── mcp-server.mjs.LEGAL.txt     ← esbuild'in ürettiği üçüncü taraf lisans bildirimleri
└── node_modules/better-sqlite3/ ← native modül (LICENSE, package.json, lib/, prebuilds/)
```

`mcp-server.mjs` dosyasını tek başına **taşımayın**. `better-sqlite3`, esbuild'in gömemediği native `.node` prebuild'leri içerir; bu yüzden `dist/` dizininin tamamı bir arada kalmalıdır.

Bu bundle çıplak giriş noktasıdır: **hiçbir komut satırı bayrağı okumaz**. Tek yapılandırma kaynağı `CAUSORYN_CONFIG` ortam değişkeni (katı JSON şeması; `packages/mcp-server/src/config.ts` içindeki `parseCausorynServerConfig`) ve buna ek olarak `CAUSORYN_TOOL_PROFILE`'dır. `CAUSORYN_CONFIG` olmadan `allowRoots: []` ile fail-closed başlar; bu durumda workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürür. `storage.dataDbPath` olmadan graph bellekte tutulur ve her açılışta yeniden oluşturulur.

### 5.2 Yöntem A — proje kapsamlı `.mcp.json` (ekibinizle paylaşılabilir)

Proje köküne bir `.mcp.json` dosyası koyun:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"],
      "env": {
        "CAUSORYN_CONFIG": "{\"allowRoots\":[\"/path/to/your-project\"]}"
      }
    }
  }
}
```

- Causoryn hedef projenin dışında duruyorsa `args` içinde **mutlak** bir yol kullanın.
- Claude Code, `.mcp.json` sunucularını ilk kullanımda onay bekliyor (pending approval) olarak işaretler; `claude mcp list` onay durumunu gösterir, `claude mcp reset-project-choices` ise proje onay seçimlerini sıfırlar.

### 5.3 Yöntem B — `claude mcp add` (local scope)

`claude mcp add` varsayılan olarak **local** scope'u kullanır (`-s local` / `--scope local`, girdiyi `~/.claude.json` içinde geçerli proje anahtarının altına yazar ve diğer projeleri etkilemez):

```bash
cd /path/to/your-project
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

- `--` sonrasındaki her şey sunucunun başlatma komutudur; `stdio` varsayılan transport'tur (`-t stdio` isteğe bağlıdır).
- `-s user` sunucuyu tüm projeler için kaydeder. Bu kılavuz `local`'i önerir (en az ayrıcalık ilkesi).

İndeksi diskte kalıcı tutmak için proje dışında bir veritabanı yolu da beyan edin; örneğin `{"allowRoots":["/path/to/your-project"],"storage":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"},"wiki":{"dataDbPath":"/path/to/causoryn-data/graph.sqlite"}}` (üst dizin mevcut olmalı ve her yetkili kökün dışında bulunmalıdır).

### 5.4 Doğrulama

```bash
claude mcp list
claude mcp get causoryn
```

`claude mcp list` sunucuyu başlatır ve bir MCP handshake'i gerçekleştirir. `2026-11-10` koşusu (`2.1.322`) `causoryn: node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs - ✔ Connected` yazdırdı; `2026-11-19` koşusu (`2.1.328`) `√ Connected` yazdırdı.

**Negatif davranış (`2.1.322`, `2026-11-10`):** var olmayan bir betikle (`node Z:/definitely/not/here.mjs`) kaydedilmiş bir sunucu `✘ Failed to connect — CONNECTION_CLOSED` olarak listelenir. `claude mcp add` kayıt anında yolu doğrulamaz; hatalar `list` / `get` health check'inde ortaya çıkar.

### 5.5 Temizlik

```bash
claude mcp remove causoryn
```

`-s` verilmezse Claude Code sunucuyu hangi scope'ta kayıtlıysa oradan kaldırır.

### 5.6 Smoke test protokolü (gerçek config'inizde kalıntı bırakmadan)

**Yönlendirilmiş protokol (önerilen; `2026-11-10` tarihinde `2.1.322` ile uçtan uca çalıştırıldı).** `CLAUDE_CONFIG_DIR`, tüm yapılandırma yazımlarını geçici bir dizine gönderir:

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$TMP_CFG"                 # Windows'ta Git Bash: "$(cygpath -w "$TMP_CFG")"

claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
# → çıktı "File modified: $TMP_CFG/.claude.json" satırını gösterir
claude mcp list                                      # → causoryn … ✔ Connected
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Temizlik kanıtı: `sha256sum ~/.claude.json` koşu öncesinde ve sonrasında birebir aynıdır. Aynı değişken `causoryn setup` / `causoryn doctor` koşularını da izole eder.

**Yönlendirmesiz koşular için kalıntı notu.** `claude mcp add` / `claude mcp remove` komutlarını `CLAUDE_CONFIG_DIR` olmadan çalıştırmak, `~/.claude.json` içinde geçici dizin için boş bir proje girdisi bırakabilir (`"mcpServers": {}` ile birlikte `allowedTools` ve `hasTrustDialogAccepted` gibi kayıt tutma alanları). `remove`, `causoryn` girdisinin kendisini tamamen siler; ancak Claude Code'da (`2.1.319` / `2.1.322`) boş bir proje girdisini temizleyen bir CLI alt komutu yoktur. Yönlendirilmemiş herhangi bir `claude` çağrısı `pluginUsage` gibi genel sayaçları da güncelleyebilir; bu MCP kaydının bir parçası değil, host davranışıdır.

## 6. `stdout` hijyeni

Her Causoryn giriş noktası (`causoryn.mjs mcp`, `plugin-mcp-launcher.mjs` ve çıplak `mcp-server.mjs`) `stdout`'a **yalnızca MCP JSON-RPC 2.0 çerçeveleri** yazar. Tanılama çıktıları `[causoryn]` veya `[causoryn-launcher]` önekiyle `stderr`'e gider; böylece log satırları Claude Code'un JSON-RPC akışını bozamaz.

## 7. Sorun giderme

| Belirti | Neden ve çözüm |
|---|---|
| `setup`, `cli/malformed-json` ile duruyor | `~/.claude.json` geçerli JSON değil ya da `mcpServers` bir nesne değil. Dosyayı düzeltin veya `~/.claude.json.causoryn.backup` yedeğini geri yükleyin; hiçbir şey yazılmadı. |
| `setup` sembolik bir linke yazmayı reddediyor | Sembolik linkli config dosyaları bilinçli olarak reddedilir. `CLAUDE_CONFIG_DIR`'i gerçek dizine yönlendirin ya da linki normal bir dosyayla değiştirin. |
| `setup` "confirmation required" bildiriyor | `--yes` verilmeden etkileşimsiz kabukta çalıştırıldı. Gözden geçirmek için `--dry-run` ile, ardından `--yes` ile yeniden çalıştırın. |
| `doctor` giriş betiği için `ERROR` gösteriyor | `~/.causoryn/runtime` ya da orijinal kurulum kaldırılmış. `npx causoryn@0.3.1 setup --client claude-code --yes` komutunu yeniden çalıştırın. |
| Sunucu açılışta "Unsupported Node.js version" ile çıkıyor | Node.js < 24. Node.js 24+ kurun ve `command` onu göstersin diye `setup`'ı yeniden çalıştırın. |
| `[causoryn-launcher]` sürüm uyuşmazlığı (çıkış `2`) | Kurulu plugin paketi `--expected-version` ile eşleşmiyor. Plugin'i güncelleyin veya yeniden kurun. |
| Workspace araçları `WORKSPACE_NOT_AUTHORIZED` döndürüyor | `--allow-cwd` başlangıç dizinini reddetti ve host kullanılabilir bir kök bildirmedi ya da çıplak bundle'da `allowRoots` yok. Bkz. bölüm 4 veya 5.1. |
| Wiki veya history araçları `tools/list` içinde yok | Varsayılan `core` profili etkin. Bkz. bölüm 3. |
| İlk çağrı `data.status: "indexing"` ile `status: "partial"` döndürüyor | İlk indeks hâlâ oluşturuluyor. `retryAfterMs` süresi sonunda yeniden deneyin ya da `causoryn_status` çağırın. |

## İlgili sayfalar

- [5 Dakikada Başlangıç (İngilizce)](../en/tutorial-5-minutes.md) · [CLI ve Konfigürasyon](../cli-and-configuration.md) · [MCP Araç Sözleşmeleri](../tool-contracts.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md) · [English version](../en/hosts/claude-code.md)
- Diğer host kılavuzları: [Codex CLI](codex.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
