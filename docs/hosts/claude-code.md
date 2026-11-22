# Causoryn'i Claude Code'a bağlama (stdio MCP)

> **Dil / Language:** Türkçe · [English](../en/hosts/claude-code.md) · [Uyumluluk Matrisi](../compatibility-matrix.md)

> Kanıt: **K-021/K-022 dağıtım (2026-11-19):** `claude --version` → `2.1.328 (Claude Code)` ile
> `claude plugin validate --strict` (kök `.claude-plugin/marketplace.json`) + `claude mcp list`
> `√ Connected` ve `npx causoryn@0.2.1 setup --client claude-code` doğrulandı. **Tarihsel F3
> monorepo bundle smoke kanıtı:** `claude --version` → `2.1.322 (Claude Code)`; `claude mcp --help`
> ve `claude mcp add --help` çıktıları (sözdizimi ilk kez 2026-11-08'de 2.1.319 ile, **2026-11-10'da
> 2.1.322 ile uçtan uca yeniden doğrulandı**: yönlendirilmiş geçici config'de `mcp add` → `mcp list`
> `✔ Connected` → `mcp remove`; smoke öncesi/sonrası `sha256sum ~/.claude.json` birebir aynı).
> Monorepo bundle artifact: `packages/mcp-server/dist/mcp-server.mjs` (F1 esbuild bundle; external
> `better-sqlite3` prebuilds `dist/node_modules/` altındadır — "tek dosya" değil, `dist/` klasörünün
> bütününü dağıtın). Doğrulama testi: `tests/hosts-docs.test.ts`.

Causoryn, LLM çalıştırmayan yerel ve deterministik bir MCP motorudur (`causoryn@0.2.1`). CLI yoksa
`npm install -g @anthropic-ai/claude-code` ile kurulur.

## 0. Son Kullanıcı Hızlı Kurulumu (Önerilen — K-021 / `v0.2.1`)

### Seçenek 0A — Tek Komut CLI (`npx causoryn@0.2.1 setup`)

```bash
# Değişiklikleri önceden görmek için (salt okunur)
npx causoryn@0.2.1 setup --client claude-code --dry-run

# ~/.claude.json + ~/.claude/skills/ kurulumu (.causoryn.backup yedeği ve kalıcı ~/.causoryn/runtime ile)
npx causoryn@0.2.1 setup --client claude-code --yes

# Sağlık kontrolü (salt okunur)
npx causoryn@0.2.1 doctor

# Temiz kaldırma (mcpServers.causoryn + 4 yönlendirme skill dosyası)
npx causoryn@0.2.1 setup --client claude-code --uninstall --yes
```

**`v0.2.1` `CLAUDE_CONFIG_DIR` desteği:** Ortamda `CLAUDE_CONFIG_DIR` tanımlıysa hem
`causoryn setup --client claude-code` hem de `causoryn doctor` varsayılan `~/.claude.json` ve
`~/.claude/skills/` yerine `$CLAUDE_CONFIG_DIR/.claude.json` ve `$CLAUDE_CONFIG_DIR/skills/`
yollarını kullanır (`resolveEffectiveClaudeConfigDir`, `packages/causoryn/src/setup.ts`). Böylece
çoklu profil ve izole CI/test ortamlarında kullanıcının birincil ev dizinine hiçbir bayt yazılmaz.

### Seçenek 0B — Yerel Claude Code Plugin Pazaryeri

```text
/plugin marketplace add MrBekoX/Causoryn
/plugin install causoryn@causoryn
```

- **Pazaryeri ve sürüm kilidi (`--expected-version 0.2.1`):** Kök `.claude-plugin/marketplace.json`
  (`source: { "source": "npm", "package": "causoryn", "version": "0.2.1" }`) ve paket içi
  `packages/causoryn/.claude-plugin/plugin.json`, sunucuyu
  `${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs --expected-version 0.2.1 --allow-cwd --auto-data-dir --client claude-code`
  komutuyla başlatır. Başlatıcı betik (`plugin-mcp-launcher.mjs`), iç içe `npx` alt-süreci açmadan
  kurulu plugin `package.json` dosyasındaki `version === "0.2.1"` eşitliğini (ve varsa
  `CAUSORYN_EXPECTED_VERSION` ortam değişkeniyle tutarlılığını) denetler; sürüm uyuşmazlığında
  `stderr` üzerinden açık hata verip `exit 2` ile çıkar, doğrulama geçtiğinde `CAUSORYN_ASSET_ROOT`
  atayarak doğrudan `dist/mcp-server.mjs` modülünü yükler.

> **2026-11-19 canlı CLI kanıtı (`claude 2.1.328`):** Kök `.claude-plugin/marketplace.json`
> üzerinde `claude plugin validate --strict` geçti ve kayıtlı sunucu `claude mcp list` çıktısında
> `√ Connected` döndü.

---

## Monorepo Geliştirici Akışı (F1 Bundle — `packages/mcp-server/dist/`)

Aşağıdaki adımlar kaynak depodan yerel esbuild bundle'ı bağlamak isteyen geliştiriciler içindir.

### 1. Ön koşul: bundle'ı üret

```bash
cd packages/mcp-server
npm run build:bundle   # esbuild tek-ÇIKIŞ bundle + external native binding kopyası
```

Çıktı sözleşmesi (her yapıda aynı — deterministik, 35 dosyalı `bundle-manifest.json`):

```
packages/mcp-server/dist/
├── bundle-manifest.json              ← 35 dosyanın sıralı sha256 özeti
├── mcp-server.mjs                    ← stdio giriş noktası (sağlam hash bundle-manifest.json'da)
├── mcp-server.mjs.LEGAL.txt          ← esbuild gömülü paket lisans bildirimleri
└── node_modules/better-sqlite3/      ← external native modül (LICENSE + package.json + lib/ + prebuilds/)
```

`mcp-server.mjs`'i **yalnız başına taşımayın**; `dist/` klasörünü bütün olarak dağıtın (native
`.node` prebuilds ile `mcp-server.mjs.LEGAL.txt` ve `better-sqlite3/LICENSE` lisans dosyaları birlikte
taşınır; `bundle-manifest.json` toplam 35 girdi içerir).

### 2. Yöntem A — proje-scoped `.mcp.json` (ekibe paylaşılabilir)

Proje kökünüze bir `.mcp.json` dosyası koyun:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["/path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs"]
    }
  }
}
```

- `args` içindeki yol, Causoryn'i başka bir projeden kullanacaksanız **mutlak** olmalıdır.
- İlk kullanımda Claude Code `.mcp.json` sunucularını "Pending approval" olarak gösterir;
  `claude mcp list` onay durumunu yansıtır. Onay akışı `claude mcp reset-project-choices` ile
  sıfırlanabilir (`claude mcp --help`).

### 3. Yöntem B — `claude mcp add` (local scope)

`claude mcp add`'in default scope'u **local**'dir (`-s local` veya `--scope local` ile kayıt,
çalıştırıldığınız proje için `~/.claude.json` içine yazılır; diğer projeler etkilenmez):

```bash
cd /path/to/your-project
claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

Notlar:

- `--` sonrasındaki her şey sunucunun başlatma komutudur (`claude mcp add --help`).
- stdio transport default'tur (`-t stdio` gerekmez).
- Kullanıcı-genel kayıt isterseniz `-s user` kullanın; **bu doküman local'i önerir** (en dar
  kapsam ilkesi).

### 4. Doğrulama

```bash
claude mcp list
```

Beklenen: listede `causoryn` görünür ve health-check ✓ (connected) gösterir. `mcp list`, sunucu
sürecini gerçekten başlatıp MCP handshake yapar — 2.1.322 canlı koşusunda
`causoryn: node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs - ✔ Connected` döndü
(2026-11-19 `2.1.328` koşusunda `√ Connected` ile yeniden teyit edildi). Tek sunucunun detayı için:

```bash
claude mcp get causoryn
```

**Negatif davranış (2.1.322 canlı kanıt, 2026-11-10):** geçersiz komut yoluyla kayıtlı sunucu
(`node Z:/definitely/not/here.mjs`) listede `✘ Failed to connect — CONNECTION_CLOSED` olarak
raporlanır; host hatayı sessizce geçmez. `add` ise komutu doğrulamaz — kaydı kabul eder; hata
yalnızca `list`/`get` health-check'inde ortaya çıkar.

### 5. Temizlik

```bash
claude mcp remove causoryn
```

Scope belirtilmezse kayıtlı olduğu scope'tan kaldırır (`claude mcp remove --help`).

### 6. stdout disiplini (kırmızı kural 4)

Causoryn sunucu süreci stdout'a **yalnızca MCP protokol trafiği** yazar; tüm loglar `[causoryn]`
önekiyle **stderr**'e gider. Bu yüzden host tarafında hiçbir log satırı protokol akışını bozmaz.
Manuel doğrulama (2026-11-08, bundle `causoryn@0.1.0`; `causoryn@0.2.1` ile sürdürüldü):

- stdout: 2 satır saf JSON-RPC (initialize yanıtı + `tools/list` → **29 araç**)
- stderr: yalnızca `[causoryn] CAUSORYN_CONFIG tanımsız; ...` + hazır logu

### 7. Konfigürasyon: `CAUSORYN_CONFIG` (TŞ §20)

Çıplak `packages/mcp-server/dist/mcp-server.mjs` (`src/stdio.ts`) izin verilen workspace köklerini
`CAUSORYN_CONFIG` ortam değişkeninden okur (JSON). Tanımsızsa güvenli default devrededir:
`allowRoots: []` → tüm workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner, hiçbir kök sessizce
yetkilendirilmez.

```bash
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["/path/to/your-project"]}' \
  -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
```

### 8. Smoke test protokolü (kullanıcı config'i temiz kalır)

#### 8a. Yönlendirilmiş protokol (önerilen; claude 2.1.322'de 2026-11-10'da uçtan uca yeniden doğrulandı)

`CLAUDE_CONFIG_DIR` ortam değişkeni claude'un TÜM config yazılarını geçici dizine yönlendirir;
gerçek `~/.claude.json`'a smoke ile ilgili hiçbir bayt yazılmaz:

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$(cygpath -w "$TMP_CFG")"   # Windows/Git Bash

claude mcp add causoryn -s local -- node /path/to/causoryn/packages/mcp-server/dist/mcp-server.mjs
# → çıktı "File modified: $TMP_CFG/.claude.json" yolunu göstermelidir

claude mcp list          # → causoryn … ✔ Connected
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Temizlik kanıtı: smoke öncesi/sonrası `sha256sum ~/.claude.json` aynı çıkar.

#### 8b. Dürüst kalıntı notu (yönlendirmesiz akış)

`CLAUDE_CONFIG_DIR` yönlendirmesi OLMADAN koşulan `claude mcp add/remove`, kaldırma sonrasında
gerçek `~/.claude.json` içinde geçici-proje anahtarlı **boş bir bookkeeping girdisi** bırakabilir
(`"mcpServers": {}` + `allowedTools`/`hasTrustDialogAccepted` vb. durum alanları). Bu, CLI'nin
standart proje defteridir; 2.1.319'da bu anahtarı silen bir CLI komutu YOKTUR (2026-11-08'de
doğrulandı). Kayıt kendisi remove ile tamamen silinir — kalıntı yalnızca boş proje anahtarıdır ve
smoke için kesin çözüm 8a'daki yönlendirmedir.

Not: herhangi bir `claude` çağrısı, kullanıcının oturum telemetrisini (ör. `pluginUsage` sayaçları)
kullanıcı genelinde güncelleyebilir; bu MCP kaydıyla ilgisiz, kaçınılmaz CLI davranışıdır.

## İlgili sayfalar

- [English version](../en/hosts/claude-code.md)
- [Uyumluluk Matrisi](../compatibility-matrix.md)
- Diğer host kılavuzları: [Codex CLI](codex.md) · [ZCode](zcode.md) · [Antigravity](antigravity.md)
