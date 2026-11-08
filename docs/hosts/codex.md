# Causoryn'i Codex CLI'a bağlama (stdio MCP)

> Kanıt: `codex --version` → `codex-cli 0.163.0`; `codex mcp --help`, `codex mcp add --help`,
> `codex mcp list --help`, `codex mcp remove --help` çıktıları (sözdizimi 2026-11-08'de bu
> sürümle doğrulandı). Bundle artifact: `packages/mcp-server/dist/mcp-server.mjs` (F1; external
> `better-sqlite3` prebuilds `dist/node_modules/` altında — `dist/` klasörünü bütün dağıtın).
> Doğrulama testi: `tests/hosts-docs.test.ts`.

Causoryn, LLM çalıştırmayan yerel ve deterministik bir MCP motorudur. Bu kılavuz,
`packages/mcp-server/dist/` altındaki stdio bundle'ını **Codex CLI 0.163.0+** sürümüne
kaydeder. Codex'te `claude mcp add`'teki gibi **proje/local scope seçeneği YOKTUR** —
`codex mcp add`, sunucuyu kullanıcı-genel `~/.codex/config.toml` dosyasına yazar. Bu
yüzden smoke/deneme kayıtları **belirgin bir adla** eklenip **remove ile kaldırılmalıdır**
(aşağıdaki yaşam döngüsü).

## 0. Ön koşul: bundle'ı üret

```bash
cd packages/mcp-server
npm run build:bundle   # esbuild bundle + external native binding kopyası
```

Çıktı sözleşmesi:

```
packages/mcp-server/dist/
├── mcp-server.mjs                    ← stdio giriş noktası
└── node_modules/better-sqlite3/      ← external native modül (esbuild .node gömemez)
```

## 1. Yöntem A — `config.toml` bloğu (elle düzenleme)

`~/.codex/config.toml` içine (TOML):

```toml
[mcp_servers.causoryn]
command = "node"
args = ["<repo-root>/packages/mcp-server/dist/mcp-server.mjs"]
```

- `args` içindeki yol **mutlak** önerilir (Codex sunucuyu herhangi bir çalışma
  dizininden başlatır).
- Ortam değişkeni eklemek için `codex mcp add --help`'teki `--env <KEY=VALUE>`
  seçeneği vardır; TOML'da karşılığı `env_vars`/`env` anahtarıdır — kullandığınız
  Codex sürümünün `config.toml` şemasına bakın (0.163.0 yardım metni sadece CLI
  bayrağını belgeler).

## 2. Yöntem B — `codex mcp add` (önerilen; elle config düzenlemekten güvenli)

```bash
codex mcp add causoryn -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
```

Sözdizimi (`codex mcp add --help`): `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`.
`--` sonrası başlatma komutudur; `--env CAUSORYN_CONFIG='{"allowRoots":["D:/calisma"]}'`
ile workspace yetkilendirmesi verilebilir (aşağıda §5).

## 3. Doğrulama

```bash
codex mcp list            # metin çıktı
codex mcp list --json     # betik dostu çıktı
codex mcp get causoryn    # tek sunucu detayı
```

Beklenen: `causoryn`, `node <repo-root>/packages/mcp-server/dist/mcp-server.mjs`
komutuyla listede görünür.

## 4. Temizlik

```bash
codex mcp remove causoryn
```

`codex mcp list` çıktısında artık görünmemeli. **Smoke test disiplini**: kalıcı
kayıt istenmiyorsa add adını `causoryn-smoke` gibi belirgin yapın ve remove sonrası
`codex mcp list` çıktısını temizlik kanıtı olarak saklayın:

```bash
codex mcp add causoryn-smoke -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # ← causoryn-smoke artık YOK (kullanıcı config'i temiz)
```

## 5. Konfigürasyon: `CAUSORYN_CONFIG` (TŞ §20)

`CAUSORYN_CONFIG` JSON olarak verilir; tanımsızsa güvenli default `allowRoots: []`
devrededir (workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner):

```bash
codex mcp add causoryn \
  --env CAUSORYN_CONFIG='{"allowRoots":["D:/calisma/dizini"]}' \
  -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
```

## 6. stdout disiplini (kırmızı kural 4)

Causoryn sunucu süreci stdout'a **yalnızca MCP protokol trafiği** yazar; tüm loglar
`[causoryn]` önekiyle **stderr**'e gider — Codex'in JSON-RPC boru hattını log satırları
bozmaz. Manuel doğrulama (2026-11-08, bundle `causoryn@0.1.0`): stdout 2 satır saf
JSON-RPC (initialize + `tools/list` → **29 araç**); stderr yalnızca `[causoryn]` logları.
