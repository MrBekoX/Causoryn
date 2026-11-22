# Causoryn'i Codex CLI'a bağlama (stdio MCP)

> **Dil / Language:** Türkçe · [English](../en/hosts/codex.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> Kanıt: **K-021/K-022 dağıtım (2026-11-19):** `codex --version` → `codex-cli 0.169.0` ile
> `codex plugin marketplace add` (`.agents/plugins/marketplace.json`) + `codex mcp add/list` ve
> `npx causoryn@0.2.1 setup --client codex` doğrulandı. **Tarihsel F4 monorepo bundle smoke kanıtı:**
> `codex --version` → `codex-cli 0.163.0`; `codex mcp --help`, `codex mcp add --help`,
> `codex mcp list --help`, `codex mcp remove --help` çıktıları (sözdizimi 2026-11-08'de bu sürümle
> doğrulandı; **2026-11-10'da aynı sürümle canlı smoke yeniden koşuldu**: `mcp add causoryn-smoke`
> → `mcp list` göründü → `mcp remove` → `mcp list` temiz; `config.toml` smoke öncesi yedekten geri
> yüklendi — bkz. §5 serileştirme uyarısı). Monorepo bundle artifact:
> `packages/mcp-server/dist/mcp-server.mjs` (F1; external `better-sqlite3` prebuilds
> `dist/node_modules/` altında — `dist/` klasörünü bütün dağıtın). Doğrulama testi:
> `tests/hosts-docs.test.ts`.

Causoryn, LLM çalıştırmayan yerel ve deterministik bir MCP motorudur (`causoryn@0.2.1`). Codex'te
`claude mcp add`'teki gibi **proje/local scope seçeneği YOKTUR** — `codex mcp add`, sunucuyu
kullanıcı-genel `~/.codex/config.toml` (veya `$CODEX_HOME/config.toml`) dosyasına yazar. Bu yüzden
smoke/deneme kayıtları **belirgin bir adla** eklenip **remove ile kaldırılmalıdır**.

## 0. Son Kullanıcı Hızlı Kurulumu (Önerilen — K-021 / `v0.2.1`)

### Seçenek 0A — Tek Komut CLI (`npx causoryn@0.2.1 setup`)

```bash
# Değişiklikleri önceden görmek için (salt okunur)
npx causoryn@0.2.1 setup --client codex --dry-run

# $CODEX_HOME/config.toml [mcp_servers.causoryn] + ~/.agents/skills/ kurulumu (.causoryn.backup yedeğiyle)
npx causoryn@0.2.1 setup --client codex --yes

# Sağlık kontrolü (salt okunur)
npx causoryn@0.2.1 doctor

# Temiz kaldırma ([mcp_servers.causoryn] + 4 yönlendirme skill dosyası)
npx causoryn@0.2.1 setup --client codex --uninstall --yes
```

**`v0.2.1` `CODEX_HOME` ve `startup_timeout_sec = 30` ayrıntıları:**

- **`CODEX_HOME` desteği:** Ortamda `CODEX_HOME` tanımlıysa hem `causoryn setup --client codex`
  hem de `causoryn doctor`, MCP sunucu bloğunu `$CODEX_HOME/config.toml` içinde yönetir;
  tanımsızsa varsayılan `~/.codex/config.toml` kullanılır (`resolveEffectiveCodexHomeDir`,
  `packages/causoryn/src/setup.ts`). 4 kanonik yönlendirme skill dosyası (`causoryn`, `map-system`,
  `preflight-change`, `verify-change`) ise `~/.agents/skills/` altına kurulur.
- **Hedefli TOML yaması + `startup_timeout_sec = 30`:** `causoryn setup`, `codex mcp add`'in aksine
  komşu TOML bloklarını yeniden serileştirmeden yalnızca `[mcp_servers.causoryn]` bölümünü günceller
  (`upsertCodexMcpServer`), mevcut dosyadan atomik `.causoryn.backup` yedeği alır ve soğuk Node.js +
  SQLite açılışı için `startup_timeout_sec = 30` değerini yazar.

### Seçenek 0B — Yerel Codex Plugin Pazaryeri

Kök `.agents/plugins/marketplace.json` ve paket içi `packages/causoryn/.codex-plugin/plugin.json`
(+ `.codex-plugin/mcp.json`) manifestleri Codex plugin pazaryeriyle uyumludur (`2026-11-19`,
`codex-cli 0.169.0` ile `codex plugin marketplace add` + `codex mcp add/list` doğrulandı):

- `.agents/plugins/marketplace.json`, npm kaynağını (`source: { "source": "npm", "package": "causoryn", "version": "0.2.1" }`) ve kurulum politikasını `policy.installation: "AVAILABLE"`, `policy.authentication: "ON_INSTALL"` olarak beyan eder (Causoryn tamamen yerel ve LLM/API anahtarsız çalıştığından harici kimlik bilgisi gerekmez; Codex şeması kurulum anı onay akışı için `"ON_INSTALL"` değerini bekler).
- `packages/causoryn/.codex-plugin/mcp.json`, sunucuyu `causoryn@0.2.1` paket pini, `--allow-cwd --auto-data-dir --client codex` bayrakları ve `"startup_timeout_sec": 30` ile tanımlar.

---

## Monorepo Geliştirici Akışı (F1 Bundle — `packages/mcp-server/dist/`)

### 1. Ön koşul: bundle'ı üret

```bash
cd packages/mcp-server
npm run build:bundle   # esbuild bundle + external native binding kopyası
```

Çıktı sözleşmesi (deterministik, 35 dosyalı `bundle-manifest.json`):

```
packages/mcp-server/dist/
├── bundle-manifest.json              ← 35 dosyanın sıralı sha256 özeti
├── mcp-server.mjs                    ← stdio giriş noktası
├── mcp-server.mjs.LEGAL.txt          ← esbuild gömülü paket lisans bildirimleri
└── node_modules/better-sqlite3/      ← external native modül (LICENSE + package.json + lib/ + prebuilds/)
```

### 2. Yöntem A — `config.toml` bloğu (elle düzenleme)

`~/.codex/config.toml` (veya `$CODEX_HOME/config.toml`) içine (TOML):

```toml
[mcp_servers.causoryn]
command = "node"
args = ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
startup_timeout_sec = 30
```

- `args` içindeki yol **mutlak** önerilir (Codex sunucuyu herhangi bir çalışma dizininden başlatır).
- Ortam değişkeni eklemek için `codex mcp add --help`'teki `--env <KEY=VALUE>` seçeneği vardır;
  TOML'da karşılığı `env_vars`/`env` anahtarıdır — kullandığınız Codex sürümünün `config.toml`
  şemasına bakın (0.163.0 yardım metni sadece CLI bayrağını belgeler).

### 3. Yöntem B — `codex mcp add` (önerilen; elle config düzenlemekten güvenli)

```bash
codex mcp add causoryn -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Sözdizimi (`codex mcp add --help`):
`codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`. `--` sonrası başlatma komutudur;
`--env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}'` ile workspace yetkilendirmesi
verilebilir (aşağıda §6).

### 4. Doğrulama

```bash
codex mcp list            # metin çıktı
codex mcp list --json     # betik dostu çıktı
codex mcp get causoryn    # tek sunucu detayı
```

Beklenen: `causoryn`, `node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs` komutuyla
listede görünür.

**Dürüst sınırlar (0.163.0 canlı kanıt, 2026-11-10; 0.169.0'da korunur):**

- `codex mcp list` **health-check yapmaz** — kaydı yalnızca config'ten listeler, sunucu sürecini
  başlatmaz. Claude Code'un aksine burada `✔/✘ Connected` yüzeyi yoktur; spawn/handshake
  doğrulaması ancak gerçek bir Codex oturumunda yapılır. Bu kılavuzun smoke kanıtı **kayıt
  seviyesindedir** (add → list göründü → remove → list temiz).
- `add`, komut yolunu doğrulamaz: geçersiz yol (`node Z:/definitely/not/here.mjs`) kaydı kabul eder
  ve list'te `enabled` görünür; hata oturum anında ortaya çıkar.
- Var olmayan sunucu sorgusu gerçek hata yüzeyidir:
  `codex mcp get no-such-server-xyz` → `Error: No MCP server named 'no-such-server-xyz' found.`
  (exit 1).

### 5. Temizlik

```bash
codex mcp remove causoryn
```

`codex mcp list` çıktısında artık görünmemeli. **Smoke test disiplini**: kalıcı kayıt
istemiyorsanız add adını `causoryn-smoke` gibi belirgin yapın ve remove sonrası `codex mcp list`
çıktısını temizlik kanıtı olarak saklayın:

```bash
codex mcp add causoryn-smoke -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # ← causoryn-smoke artık YOK (kullanıcı config'i temiz)
```

**Yeniden serileştirme uyarısı (0.163.0 canlı bulgu, 2026-11-10):** `codex mcp add` ve
`codex mcp remove`, `~/.codex/config.toml`'u TOML serileştiricisiyle **yeniden serileştirir**
(dosyayı baştan yazar). Kayıt düzgün eklenir/kaldırılır (`remove` sonrası dosyada causoryn
kalıntısı yoktur), ancak komşu `[mcp_servers.*]` bloklarının biçimi de değişebilir: canlı koşuda
komşu sunucunun env satır sırası karıştı ve `startup_timeout_sec = 120` → `120.0` yazıldı —
**byte-düzeyi değişmezlik garanti edilmez**. Bu yüzden smoke/deneme öncesi dosyayı yedekleyin ve
sonrası hash'i karşılaştırın:

```bash
cp ~/.codex/config.toml /tmp/config.toml.bak
sha256sum ~/.codex/config.toml   # öncesi
# ... add → list → remove → list ...
sha256sum ~/.codex/config.toml   # sonrası; farklıysa yedeği geri yükleyin
```

### 6. Konfigürasyon: `CAUSORYN_CONFIG` (TŞ §20)

`CAUSORYN_CONFIG` JSON olarak verilir; tanımsızsa güvenli default `allowRoots: []` devrededir
(workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner):

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### 7. stdout disiplini (kırmızı kural 4)

Causoryn sunucu süreci stdout'a **yalnızca MCP protokol trafiği** yazar; tüm loglar `[causoryn]`
önekiyle **stderr**'e gider — Codex'in JSON-RPC boru hattını log satırları bozmaz. Manuel doğrulama
(2026-11-08, bundle `causoryn@0.1.0`; `causoryn@0.2.1` ile sürdürüldü): stdout 2 satır saf JSON-RPC
(initialize + `tools/list` → **29 araç**); stderr yalnızca `[causoryn]` logları.

## İlgili sayfalar

- [English version](../en/hosts/codex.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md)
- Diğer host kılavuzları: [Claude Code](claude-code.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
