# Causoryn'i Codex CLI'a bağlama (stdio MCP)

> Kanıt: `codex --version` → `codex-cli 0.163.0`; `codex mcp --help`, `codex mcp add --help`,
> `codex mcp list --help`, `codex mcp remove --help` çıktıları (sözdizimi 2026-11-08'de bu
> sürümle doğrulandı; **2026-11-10'da aynı sürümle canlı smoke yeniden koşuldu**:
> `mcp add causoryn-smoke` → `mcp list` göründü → `mcp remove` → `mcp list` temiz;
> `config.toml` smoke öncesi yedekten geri yüklendi — bkz. §4 serileştirme uyarısı).
> Bundle artifact: `packages/mcp-server/dist/mcp-server.mjs` (F1; external
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

**Dürüst sınırlar (0.163.0 canlı kanıt, 2026-11-10):**

- `codex mcp list` **health-check yapmaz** — kaydı yalnızca config'ten listeler,
  sunucu sürecini başlatmaz. Claude Code'un aksine burada `✔/✘ Connected` yüzeyi yoktur;
  spawn/handshake doğrulaması ancak gerçek bir Codex oturumunda yapılır. Bu kılavuzun
  smoke kanıtı **kayıt seviyesindedir** (add → list göründü → remove → list temiz).
- `add`, komut yolunu doğrulamaz: geçersiz yol (`node Z:/definitely/not/here.mjs`)
  kaydı kabul eder ve list'te `enabled` görünür; hata oturum anında ortaya çıkar.
- Var olmayan sunucu sorgusu gerçek hata yüzeyidir:
  `codex mcp get no-such-server-xyz` → `Error: No MCP server named 'no-such-server-xyz' found.` (exit 1).

## 4. Temizlik

```bash
codex mcp remove causoryn
```

`codex mcp list` çıktısında artık görünmemeli. **Smoke test disiplini**: kalıcı
kayıt istenmiyorsanız add adını `causoryn-smoke` gibi belirgin yapın ve remove sonrası
`codex mcp list` çıktısını temizlik kanıtı olarak saklayın:

```bash
codex mcp add causoryn-smoke -- node <repo-root>/packages/mcp-server/dist/mcp-server.mjs
codex mcp list
codex mcp remove causoryn-smoke
codex mcp list   # ← causoryn-smoke artık YOK (kullanıcı config'i temiz)
```

**Yeniden serileştirme uyarısı (0.163.0 canlı bulgu, 2026-11-10):** `codex mcp add`
ve `codex mcp remove`, `~/.codex/config.toml`'u TOML serileştiricisiyle
**yeniden serileştirir** (dosyayı baştan yazar).
Kayıt düzgün eklenir/kaldırılır (`remove` sonrası dosyada causoryn kalıntısı yoktur),
ancak komşu `[mcp_servers.*]` bloklarının biçimi de değişebilir: canlı koşuda komşu
sunucunun env satır sırası karıştı ve `startup_timeout_sec = 120` → `120.0` yazıldı —
**byte-düzeyi değişmezlik garanti edilmez**. Bu yüzden smoke/deneme öncesi dosyayı
yedekleyin ve sonrası hash'i karşılaştırın:

```bash
cp ~/.codex/config.toml /tmp/config.toml.bak
sha256sum ~/.codex/config.toml   # öncesi
# ... add → list → remove → list ...
sha256sum ~/.codex/config.toml   # sonrası; farklıysa yedeği geri yükleyin
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
