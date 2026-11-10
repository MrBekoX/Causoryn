# Causoryn'i Claude Code'a bağlama (stdio MCP)

> Kanıt: `claude --version` → `2.1.322 (Claude Code)`; `claude mcp --help` ve
> `claude mcp add --help` çıktıları (sözdizimi ilk kez 2026-11-08'de 2.1.319 ile,
> **2026-11-10'da 2.1.322 ile uçtan uca yeniden doğrulandı**: yönlendirilmiş geçici
> config'de `mcp add` → `mcp list` `✔ Connected` → `mcp remove`; smoke öncesi/sonrası
> `sha256sum ~/.claude.json` birebir aynı). Bundle artifact:
> `packages/mcp-server/dist/mcp-server.mjs`
> (F1 esbuild bundle; external `better-sqlite3` prebuilds `dist/node_modules/`
> altındadır — "tek dosya" değil, `dist/` klasörünün bütününü dağıtın).
> Doğrulama testi: `tests/hosts-docs.test.ts`.

Causoryn, LLM çalıştırmayan yerel ve deterministik bir MCP motorudur. Bu kılavuz,
`packages/mcp-server/dist/` altındaki stdio bundle'ını **Claude Code 2.1.322+**
sürümüne kaydeder. CLI yoksa `npm install -g @anthropic-ai/claude-code` ile kurulur.

## 0. Ön koşul: bundle'ı üret

```bash
cd packages/mcp-server
npm run build:bundle   # esbuild tek-ÇIKIŞ bundle + external native binding kopyası
```

Çıktı sözleşmesi (her yapıda aynı — deterministik):

```
packages/mcp-server/dist/
├── mcp-server.mjs                    ← stdio giriş noktası (sağlam hash bundle-manifest.json'da)
└── node_modules/better-sqlite3/      ← external native modül (esbuild .node gömemez)
```

`mcp-server.mjs`'i **yalnız başına taşımayın**; `dist/` klasörünü bütün olarak
dağıtın (native `.node` prebuilds zorunludur).

## 1. Yöntem A — proje-scoped `.mcp.json` (ekibe paylaşılabilir)

Proje kökünüze bir `.mcp.json` dosyası koyun:

```json
{
  "mcpServers": {
    "causoryn": {
      "command": "node",
      "args": ["<repo-root>/packages/mcp-server/dist/mcp-server.mjs"]
    }
  }
}
```

- `args` içindeki yol, Causoryn'i başka bir projeden kullanacaksanız **mutlak** olmalıdır.
- İlk kullanımda Claude Code `.mcp.json` sunucularını "Pending approval" olarak
  gösterir; `claude mcp list` onay durumunu yansıtır. Onay akışı
  `claude mcp reset-project-choices` ile sıfırlanabilir (`claude mcp --help`).

## 2. Yöntem B — `claude mcp add` (local scope)

`claude mcp add`'in default scope'u **local**'dir (`-s local` yazılı ya da yazılmasız
kayıt, çalıştırıldığınız proje için `~/.claude.json` içine yazılır; diğer projeler
etkilenmez):

```bash
cd /path/to/your-project
claude mcp add causoryn -s local -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
```

Notlar:

- `--` sonrasındaki her şey sunucunun başlatma komutudur (`claude mcp add --help`).
- stdio transport default'tur (`-t stdio` gerekmez).
- Kullanıcı-genel kayıt isterseniz `-s user` kullanın; **bu doküman local'i önerir**
  (en dar kapsam ilkesi).

## 3. Doğrulama

```bash
claude mcp list
```

Beklenen: listede `causoryn` görünür ve health-check ✓ (connected) gösterir. `mcp list`,
sunucu sürecini gerçekten başlatıp MCP handshake yapar — 2.1.322 canlı koşusunda
`causoryn: node <repo-root>/packages/mcp-server/dist/mcp-server.mjs - ✔ Connected` döndü.
Tek sunucunun detayı için:

```bash
claude mcp get causoryn
```

**Negatif davranış (2.1.322 canlı kanıt, 2026-11-10):** geçersiz komut yoluyla
kayıtlı sunucu (`node Z:/definitely/not/here.mjs`) listede
`✘ Failed to connect — CONNECTION_CLOSED` olarak raporlanır; host hatayı sessizce
geçmez. `add` ise komutu doğrulamaz — kaydı kabul eder; hata yalnızca
`list`/`get` health-check'inde ortaya çıkar.

## 4. Temizlik

```bash
claude mcp remove causoryn
```

Scope belirtilmezse kayıtlı olduğu scope'tan kaldırır (`claude mcp remove --help`).

## 5. stdout disiplini (kırmızı kural 4)

Causoryn sunucu süreci stdout'a **yalnızca MCP protokol trafiği** yazar; tüm loglar
`[causoryn]` önekiyle **stderr**'e gider. Bu yüzden host tarafında hiçbir log
satırı protokol akışını bozmaz. Manuel doğrulama (2026-11-08, bundle
`causoryn@0.1.0`):

- stdout: 2 satır saf JSON-RPC (initialize yanıtı + `tools/list` → **29 araç**)
- stderr: yalnızca `[causoryn] CAUSORYN_CONFIG tanımsız; ...` + hazır logu

## 6. Konfigürasyon: `CAUSORYN_CONFIG` (TŞ §20)

Sunucu izin verilen workspace köklerini `CAUSORYN_CONFIG` ortam değişkeninden okur
(JSON). Tanımsızsa güvenli default devrededir: `allowRoots: []` → tüm workspace
araçları `WORKSPACE_NOT_AUTHORIZED` döner, hiçbir kök sessizce yetkilendirilmez.

```bash
claude mcp add causoryn -s local \
  -e CAUSORYN_CONFIG='{"allowRoots":["D:/calisma/dizini"]}' \
  -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
```

## 7. Smoke test protokolü (kullanıcı config'i temiz kalır)

### 7a. Yönlendirilmiş protokol (önerilen; claude 2.1.322'de 2026-11-10'da uçtan uca yeniden doğrulandı)

`CLAUDE_CONFIG_DIR` ortam değişkeni claude'un TÜM config yazılarını geçici dizine
yönlendirir; gerçek `~/.claude.json`'a smoke ile ilgili hiçbir bayt yazılmaz:

```bash
TMP_CFG=$(mktemp -d) && TMP_PROJ=$(mktemp -d)
cd "$TMP_PROJ"
export CLAUDE_CONFIG_DIR="$(cygpath -w "$TMP_CFG")"   # Windows/Git Bash

claude mcp add causoryn -s local -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
# → çıktı "File modified: $TMP_CFG/.claude.json" yolunu göstermelidir

claude mcp list          # → causoryn … ✔ Connected
claude mcp remove causoryn -s local
rm -rf "$TMP_CFG" "$TMP_PROJ"
```

Temizlik kanıtı: smoke öncesi/sonrası `sha256sum ~/.claude.json` aynı çıkar.

### 7b. Dürüst kalıntı notu (yönlendirmesiz akış)

`CLAUDE_CONFIG_DIR` yönlendirmesi OLMADAN koşulan `claude mcp add/remove`, kaldırma
sonrasında gerçek `~/.claude.json` içinde geçici-proje anahtarlı **boş bir bookkeeping
girdisi** bırakabilir (`"mcpServers": {}` + `allowedTools`/`hasTrustDialogAccepted` vb.
durum alanları). Bu, CLI'nin standart proje defteridir; 2.1.319'da bu anahtarı silen bir
CLI komutu YOKTUR (2026-11-08'de doğrulandı). Kayıt kendisi remove ile tamamen silinir —
kalıntı yalnızca boş proje anahtarıdır ve smoke için kesin çözüm 7a'daki yönlendirmedir.

Not: herhangi bir `claude` çağrısı, kullanıcının oturum telemetrisini (ör. `pluginUsage`
sayaçları) kullanıcı genelinde güncelleyebilir; bu MCP kaydıyla ilgisiz, kaçınılmaz CLI
davranışıdır.
