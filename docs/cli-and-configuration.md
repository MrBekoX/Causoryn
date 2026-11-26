# CLI, Sıfır-Ayar Çalışma Alanı Keşfi ve Konfigürasyon Başvurusu

> **Dil / Language:** **Türkçe** | [English](en/cli-and-configuration.md) · [Dokümantasyon Merkezi](README.md)
>
> **Durum:** Causoryn 0.3.2'i yansıtır (varsayılan `core` araç profili, çalışma alanı başına tek ortak `graph.sqlite`; araçların kendisi için bkz. [MCP Araç Sözleşmeleri](tool-contracts.md)).
>
> **Kaynak modüller:** `packages/causoryn/src/{cli.ts,setup.ts,doctor.ts,runtime-stage.ts,types.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs,verify-package-ready.mjs}`, `packages/mcp-server/src/{cli-stdio.ts,stdio.ts,runtime-cli.ts,config.ts,context.ts,workspace-ignore-discovery.ts}`, `packages/workspace/src/{policy-config.ts,path-safety.ts,ignore-matcher.ts,output-policy.ts}`.

Bu başvuru belgesi; her `causoryn` CLI alt komutunu ve bayrağını, MCP araç profillerini, ön-yükleme Node.js `>= 24` korumasını, sürümü sabitlenmiş plugin başlatıcısını, çalışma alanı kökü keşfini ve kök güvenlik filtresini, kaynak ağacı dışındaki veri dizinini, katı `CAUSORYN_CONFIG` şemasını, tüm ortam değişkenlerini ve çıktı/loglama politikasını kapsar.

---

## 1. CLI alt komutları ve bayraklar (`causoryn`)

Hızlı kurulum ve salt-okunur sağlık denetimi için `@latest` kullanın (`@0.3.2` gibi tam sürüm pini de çalışır ve CI için önerilir):

```bash
npx causoryn@latest setup --yes        # bu makinede algılanan host'lar için MCP sunucusunu + 5 skill'i kaydeder
npx causoryn@latest doctor             # Node.js, runtime dosyaları, sidecar araç zincirleri ve host konfigürasyonlarını salt-okunur denetler
# Tam pin: npx causoryn@0.3.2 setup --yes && npx causoryn@0.3.2 doctor
```

`causoryn` ikilisi (`packages/causoryn/scripts/causoryn.mjs`) şunları sunar:

```text
causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--tool-profile <core|full|wiki|history>] [--output-schema <omit|full>]
causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all] [--all-detected] [--tool-profile <list>] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
causoryn --version
causoryn --help
```

`causoryn mcp` doğrudan `dist/mcp-server.mjs`'e devredilir; `setup`, `doctor`, `--version` ve `--help` ise `dist/index.js` (`runCli`) içinde çalışır. Bilinmeyen alt komutlar ve bilinmeyen `setup`/`doctor` bayrakları `2` koduyla ve `stderr`'de bir `[causoryn] error: ...` satırıyla çıkar; `mcp` argüman hataları `[causoryn] CLI argument error: ...` ile `2` koduyla çıkar.

### 1.1 `causoryn setup` — 4 host için kurulum ve kaldırma

Desteklenen 4 host (`antigravity`, `claude-code`, `codex`, `zcode`) için `causoryn` MCP sunucu kaydını ve 5 kanonik skill'i (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`) kaydeder (veya kaldırır).

| Bayrak | Açıklama |
|---|---|
| `--client <id>` | Hedef host. Tekrarlanabilir (`--client claude-code --client codex`) veya virgülle ayrılabilir (`--client=claude-code,zcode`). Yalnızca 4 host kimliği kabul edilir. `--all` ve algılamaya göre önceliklidir. |
| `--all` | 4 host'un tamamını, algılanmasalar bile yapılandırır. |
| `--all-detected` | Varsayılan davranışın açık takma adı: bu makinede algılanan host'ları hedefler (ne `--client` ne de `--all` verildiğinde davranış budur). Hiçbir host algılanmazsa `setup` **0 dosya** yazar, `stderr`'e yönlendirme basar (host'u `--client <id>` ile adlandırın veya `--all` kullanın) ve `1` ile çıkar. |
| `--tool-profile <list>` | Üretilen her `causoryn mcp` kaydına `--tool-profile <list>` yazar: `core`, `full`, `wiki`, `history` veya `wiki,history` gibi virgüllü bir liste (doğrulanır; geçersiz değer `2` ile çıkar). `--uninstall` ile birlikte kullanılamaz. Bu bayrak olmadan mevcut bir kayıt sahip olduğu `--tool-profile` değerini korur. |
| `--dry-run` | Hiçbir şey yazmadan veya silmeden planlanan işlemleri (`create`, `update`, `remove`, `noop`) ve varsa runtime sahneleme dizinini listeler. |
| `--yes`, `-y` | Değişiklikleri onay sormadan uygular. `--yes` olmadan etkileşimli bir TTY oturumunda `stderr` üzerinden `Continue? [y/N]` sorulur; bekleyen değişikliği olan etkileşimsiz bir oturum `cli/confirmation-required` (çıkış `2`) ile başarısız olur. |
| `--skill` / `--no-skill` | 5 skill dizinini (`SKILL.md`) kurar (varsayılan) veya atlar. Mevcut bir `SKILL.md` yalnızca setup onu Causoryn'in yazdığını kanıtlayabildiğinde değiştirilir (bkz. aşağıdaki *Skill sahipliği*); diğer her dosya korunur ve raporlanır. `--uninstall` ile birlikte skill'lerin kaldırılıp kaldırılmayacağını belirler. |
| `--uninstall` | Seçili host'lardan `causoryn` MCP kaydını ve sahipliği kanıtlanan Causoryn skill'lerini kaldırır; düzenlenmiş veya yabancı bir `SKILL.md` korunur ve raporlanır. Kalan hiçbir host konfigürasyonu `~/.causoryn/runtime`'a referans vermediğinde bu dizin silinir. |
| `--json` | `SetupResult` nesnesini biçimlendirilmiş JSON olarak `stdout`'a yazar. |
| `--help`, `-h` | Kullanım metnini basar ve `0` ile çıkar. |

**Çıkış kodları:** çalışma tamamlandığında `0` ("değişiklik yok" ve reddedilen onay istemi dahil); hiçbir host algılanmadığında ve hiçbiri adlandırılmadığında `1` (hiçbir şey değişmez); geçersiz argümanlar, bozuk host konfigürasyonları (`cli/malformed-json`), sembolik bağlantı olan hedefler veya diğer G/Ç hataları (`cli/io-error`), eksik onay ya da başarısız bir runtime sahneleme adımı için `2`.

#### Host başına algılama, hedef yollar ve davranış

| Host (`--client`) | Algılanma koşulu | MCP konfigürasyon dosyası | Skill dizini | Host'a özgü davranış |
|---|---|---|---|---|
| `antigravity` | `~/.gemini/antigravity` veya `~/.gemini/config/mcp_config.json` mevcut (Gemini CLI'dan kalan yalın bir `~/.gemini` yeterli değildir) | `~/.gemini/config/mcp_config.json` (mevcutsa `~/.gemini/antigravity/mcp_config.json` de) | `~/.gemini/config/skills/` | Antigravity'nin yerel MCP yükleyicisi için `mcpServers.causoryn` kaydını `type` alanı olmadan yazar. |
| `claude-code` | `~/.claude.json` veya `~/.claude` mevcut (ya da `$CLAUDE_CONFIG_DIR` / onun `.claude.json` dosyası) | `~/.claude.json` (veya `$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/skills/` (veya `$CLAUDE_CONFIG_DIR/skills/`) | `mcpServers.causoryn` kaydını `type: "stdio"` ile yazar. |
| `codex` | `$CODEX_HOME` (varsayılan `~/.codex`) veya onun `config.toml` dosyası mevcut | `$CODEX_HOME/config.toml` | `~/.agents/skills/` | Yalnızca `[mcp_servers.causoryn]` tablosunu yamalar; yorumları, diğer TOML bölümlerini ve tablonun diğer anahtarlarını ve alt tablolarını korur. `startup_timeout_sec` `30` olarak yazılır; kullanıcının `30` veya daha yüksek değeri olduğu gibi korunur, daha düşük veya kullanılamaz bir değer `30`'a yükseltilir (setup çıktısı bunu belirtir). |
| `zcode` | `~/.zcode` veya `~/.zcode/cli/config.json` mevcut | `~/.zcode/cli/config.json` | `~/.zcode/skills/` | `mcp.servers.causoryn` (`type: "stdio"`) yazar; `mcp.servers` ilk kez oluşturulurken `~/.agents/mcp.json` içindeki mevcut sunucular taşınır (ayrılmış `__proto__`, `constructor` ve `prototype` adları atlanır ve raporlanır). |

- **Üretilen sunucu kaydı:** `command`, `setup`'ı çalıştıran mutlak Node.js ikilisidir (`process.execPath`); böylece `PATH`'i daraltılmış masaüstü host'lar da sunucuyu başlatabilir. `args` değeri `<runtime>/scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --client <host>` şeklindedir; `setup --tool-profile <list>` kullanıldığında sonuna `--tool-profile <list>` eklenir. Aksi hâlde host'lar, kendileri için `CAUSORYN_TOOL_PROFILE` veya `CAUSORYN_CONFIG.toolProfile` ayarlanmadıkça `core` profiliyle başlar.
- **`setup`'ı yeniden çalıştırmak Causoryn kaydındaki düzenlemelerinizi korur:** setup yalnızca `command`, `args` (içindeki `--tool-profile` ve `--output-schema` / `--output-schema-profile` argümanlarınız korunur), Claude Code ve ZCode JSON kayıtlarındaki `type: "stdio"` ve Codex `startup_timeout_sec` (bkz. yukarıdaki tablo) alanlarının sahibidir. Diğer her anahtar — `env`, `disabled`, `autoApprove`, `alwaysAllow`, `timeout` ve bilinmeyen anahtarlar — değerini ve konumunu korur; zaten güncel olan bir kayıt yeniden yazılmaz. Profili değiştirmek için `--tool-profile <list>` verin.
- **Kalıcı runtime sahnelemesi:** `setup` geçici bir konumdan (`_npx` veya `.npx` segmenti içeren bir yol ya da `os.tmpdir()` içi) çalıştığında runtime'ı `~/.causoryn/.runtime-stage-<pid>-<timestamp>` altına kopyalar ve atomik olarak `~/.causoryn/runtime` ile yer değiştirir (önceki kopya `.runtime-prev-*` olarak tutulur ve hata durumunda geri yüklenir). Host konfigürasyonları ardından `~/.causoryn/runtime`'ı gösterir; böylece npx önbelleği temizlendikten sonra da çalışmaya devam eder.
- **Özel `~/.causoryn`:** runtime sahnelenmeden, kurulum kaydı yazılmadan veya host konfigürasyonları `~/.causoryn` içini gösterecek şekilde yazılmadan önce (örneğin setup `--no-skill` ile doğrudan `~/.causoryn/runtime` içinden çalıştığında; planlama sırasında denetlenir, bu yüzden `--dry-run` de raporlar) mevcut bir `~/.causoryn` gerçek bir dizin (sembolik bağlantı veya junction değil) olmalı ve POSIX'te geçerli kullanıcıya ait olmalı, grup veya diğerleri tarafından yazılabilir olmamalıdır. Aksi hâlde setup hiçbir şeyi değiştirmeden `Refusing to use <dir>: it is owned by another user (uid …, current uid …). Remove it or give it to the current user, then run setup again.` veya `Refusing to use <dir>: it is writable by other users (mode …). Restrict it with chmod go-w <dir> and run setup again.` ile durur (`cli/runtime-stage-failed` veya `cli/io-error`, çıkış `2`). Windows ACL'leri incelenmez; orada yalnızca link ve dizin denetimleri uygulanır. `--uninstall` böyle bir dizinde başarısız olmaz: içindeki kurulum kaydını yok sayar, bu yüzden yalnızca yayımlanmış içerikle birebir eşleşen skill'ler kaldırılır.
- **Skill sahipliği ve kurulum kaydı:** setup yazdığı her `SKILL.md`'yi `~/.causoryn/installed-skills.json` içine kaydeder (mutlak yol ve yazılan baytların SHA-256'sı; dosya hiçbir şey listelemediğinde silinir). Zaten birebir güncel olan bir Causoryn skill'i de (kayıt yazılabiliyorsa ve skill bir link'in altında değilse) yeniden kaydedilir; böylece kaybolan bir kayıt, sonraki yükseltme veya kaldırmada Causoryn'in kendi skill'lerini yabancı skill'e dönüştürmez. Setup'ın tam okuyamadığı bir kayıt (bir link'in altında, en fazla 1 MiB'lık normal bir dosya değil ya da daha yeni bir `schemaVersion` gibi bu sürümün anlamadığı bir biçimde) asla yeniden yazılmaz: skill yine kurulur veya olduğu gibi kalır ve işlem ayrıntısı `(not recorded: <reason>, so it was left as it is)` ile biter. Mevcut bir `SKILL.md`, baytları bu kayıtla eşleştiğinde, setup'ın şimdi kuracağı `SKILL.md` ile birebir aynı olduğunda (LF veya CRLF satır sonları) ya da Causoryn'in `0.3.2`'ye kadar yayımladığı skill sürümlerinden biriyle birebir aynı olduğunda Causoryn'e ait sayılır. Yalnızca böyle bir dosya setup tarafından değiştirilir veya `--uninstall` tarafından kaldırılır. Kurulumdan sonra düzenlediğiniz bir skill ya da bir Causoryn skill adını kullanan kendi skill'iniz korunur: setup `skipped skill <name>: <path> was not created by Causoryn …` (veya `… was changed after Causoryn installed it …`), uninstall ise `kept <dir>: …` raporlar. Causoryn'in sürümünü kurmak için böyle bir dosyayı başka yere taşıyıp setup'ı yeniden çalıştırın. Uninstall sırasında bir skill dizini yalnızca `SKILL.md` tek girdisi olduğunda silinir; aksi hâlde yalnızca `SKILL.md` kaldırılır. Planlanan bir dosya planlama ile yürütme arasında değişirse (örneğin onay istemi açıkken) setup hiçbir şeyi değiştirmez ve `<file> changed while setup was running, so it was left as it is. Run setup again.` ile durur.
- **İdempotent yazım ve özgün yedek:** Üretilen dosya mevcut dosyayla bayt bayt aynıysa hiçbir şey yazılmaz ve yedek alınmaz (`noop`). İlk gerçek değişiklik, özgün içeriğinizle `<file>.causoryn.backup` dosyasını yazar; bu dosyanın üzerine asla yazılmaz. Sonraki değişiklikler zaman damgalı bir `<file>.causoryn.<timestamp>-<nonce>.backup` yazar. Dosyalar geçici bir dosya ve `rename` ile değiştirilir; mevcut izinler korunur (yeni konfigürasyonlar `0o600`, skill'ler `0o644`).
- **Symlink koruması (CWE-59):** Hedef konfigürasyon, bir yedek yolu veya hedef `SKILL.md` sembolik bağlantıysa `setup` yazmadan önce `cli/io-error` (çıkış `2`) ile durur. ZCode fallback dosyası `~/.agents/mcp.json` da aynı korumayla okunur (ev dizininin altında link veya junction yok, en fazla 1 MiB'lık normal bir dosya).
- **Tanılarda konfigürasyon değeri yok:** bir host konfigürasyonuyla ilgili hatalar (`env`, `command` veya `args` gibi Codex TOML değerleri; JSON sözdizimi hataları) `setup` ve `doctor` çıktısında (metin ve `--json`) dosyayı, satırı/sütunu ve anahtarı adlandırır; değeri veya çevresindeki metni asla göstermez. `startup_timeout_sec` notu yalnızca ayrıştırılan sayıyı raporlar.
- **Mutlak `nodeExecutable`:** `nodeExecutable` geçen programatik çağıranlar mutlak bir yol vermelidir; yalın veya göreli bir komut `cli/invalid-arguments` ile reddedilir, çünkü her host onu kendi `PATH`'i ve çalışma dizini üzerinden çözümlerdi.

### 1.2 `causoryn doctor` — salt-okunur sağlık denetimi

`causoryn doctor` hiçbir zaman dosya oluşturmaz, değiştirmez veya silmez. Araç zinciri yoklamaları `cwd: os.tmpdir()` ile çalışır; böylece geçerli dizindeki `.cargo/config.toml` veya `global.json` gibi projeye özgü dosyalar devreye girmez.

| Bayrak | Açıklama |
|---|---|
| `--client <id>` | Host satırlarını ve durum değerlendirmesini verilen host(lar) ile sınırlar. |
| `--json` | Tam `DoctorReport` JSON'unu `stdout`'a yazar. |
| `--help`, `-h` | Kullanım metnini basar ve `0` ile çıkar. |

Denetlenen alt sistemler:

1. **Node.js (`node`):** ana sürüm `>= 24`.
2. **Paket runtime'ı (`runtime`):** `dist/mcp-server.mjs`, `dist/node_modules/better-sqlite3/prebuilds/` altındaki platform/mimari/libc uyumlu `better-sqlite3` prebuild'i (`glibc` vs `linuxmusl`), `dist/typescript-lib/lib.es2022.full.d.ts`, 4 `native/` worker kaynağı ve derlenmiş bir `Causoryn.RoslynWorker.dll`; sahnelenmiş `~/.causoryn/runtime` mevcutsa o da denetlenir. (`dist/index-worker.mjs`, `doctor` tarafından değil, derleme zamanında `scripts/verify-package-ready.mjs` tarafından denetlenir.)
3. **Sidecar araç zincirleri (`toolchains`):** `dotnet --list-runtimes` (bir Microsoft.NETCore.App **10.x** runtime'ı gerekir; Roslyn worker `net10.0` hedefler ve başka bir ana sürüme roll-forward yapmaz), POSIX'te önce `python3 --version` sonra `python --version`, Windows'ta `python --version` (Python adapter'ıyla aynı varsayılan komut sırası; en az **3.10**), `go version` (en az **1.26**), `cargo --version` (sabitlenmiş alt sınır yok); her biri `shell: false`, 5 sn zaman aşımı ve izin listesine alınmış bir ortamla (`DOCTOR_PROBE_ENV_ALLOWLIST` artı `PYTHONIOENCODING=utf-8`) çalışır. Her araç zinciri `status` (`ok`, `warn` veya `absent`), `minimumVersion`, `version` ve `mode` (`sidecar-ready` veya `l0-l1-fallback`) raporlar. `absent` (kurulu değil) bilgi amaçlıdır: o dil dosya düzeyinde `L0`/`L1` analizine düşer. `warn` (kurulu ama alt sınırın altında, sürümü okunamıyor ya da yoklama zaman aşımına uğradı veya başlatılamadı) raporu `DEGRADED` yapar.
4. **Host hizalaması (`hosts`):** JSON/TOML sözdizimi, `causoryn` kaydının varlığı, yapılandırılmış giriş betiğinin diskte olup olmadığı (`command` olarak hem yalın `node` hem mutlak Node yolları kabul edilir) ve 5 skill. Her host `ok`, `warn` (tüm skill'ler olmadan MCP kaydı veya kayıt olmadan skill'ler), `not-configured` veya `error` (bozuk konfigürasyon ya da eksik giriş betiği) olarak değerlendirilir.
5. **Eski indeks dosyaları (`legacyIndexFiles`):** `~/.causoryn/workspaces/*/` altında 0.3.0 öncesi sürümlerden kalan host başına `graph-<client>.sqlite` dosyalarının salt-okunur taraması. Her dosya `-wal`/`-shm` yan dosyalarıyla ve yanında paylaşılan `graph.sqlite`'ın zaten bulunup bulunmadığıyla (bulunuyorsa silinebilir) listelenir. Bu denetim yalnızca uyarır: genel durumu veya çıkış kodunu değiştirmez ve `doctor` hiçbir dosyayı silmez.

**Genel durum ve çıkış kodları:**

- `HEALTHY` (çıkış `0`): Node `>= 24`, runtime eksiksiz, en az bir yapılandırılmış host, host uyarısı veya hatası yok.
- `DEGRADED` (çıkış `1`): runtime sorunsuz ancak yapılandırılmış bir host `warn` raporluyor (örneğin eksik skill'ler) ya da bir sidecar araç zinciri `warn` raporluyor.
- `NOT CONFIGURED` (çıkış `1`): runtime sorunsuz ancak henüz hiçbir host'ta Causoryn yapılandırılmamış.
- `UNHEALTHY` (çıkış `1`): Node `< 24`, eksik runtime dosyaları veya bir host konfigürasyonunda `error`.
- Çıkış `2`: geçersiz CLI argümanları.

### 1.3 `causoryn mcp` — MCP `stdio` sunucusu

`scripts/causoryn.mjs mcp`, `CAUSORYN_ASSET_ROOT`'u (ayarlı değilse) ayarlar ve `stdout`'a hiçbir şey yazmadan `dist/mcp-server.mjs` modülünü (`cli-stdio.ts`'ten derlenir) içe aktarır.

| Bayrak | Açıklama |
|---|---|
| `--allow-cwd` | `--root` ve `CAUSORYN_CONFIG.allowRoots` verilmemişse `process.cwd()`'yi `inspectProjectRootSafety` ile denetler ve güvenliyse bağlar. Güvensizse sunucu `allowRoots: []` ile başlar ve bunun yerine MCP `roots/list` listesindeki ilk güvenli girdiyi bağlar ([§3.4](#34-dinamik-mcp-rootslist-bağlama)). Değer almaz. |
| `--root <path>` | Bir çalışma alanı kökünü açıkça yetkilendirir. Tekrarlanabilir; ilk kök indekslenen çalışma alanıdır. Göreli yollar geçerli dizine göre çözülür. Verildiğinde `CAUSORYN_CONFIG.allowRoots` değerinin yerini alır. UNC ve Win32 aygıt yolları reddedilir. |
| `--auto-data-dir` | Çalışma alanının dışında `<base>/workspaces/<slug>-<hash12>/` veri dizinini oluşturur; `storage.dataDbPath` ve `wiki.dataDbPath` değerlerini bu dizindeki `graph.sqlite`'a, `output.allowedOutputDirs` değerini de `exports/` dizinine bağlar ([§4](#4-kaynak-ağacı-dışı-veri-dizini-düzeni)). Değer almaz. Bir kök bağlandığında uygulanır — başlangıçta ya da daha sonra `roots/list` bir kök sağladığında. |
| `--data-dir <absPath>` | `--auto-data-dir` için temel dizin (varsayılan `~/.causoryn`). Mutlak olmalı, NUL baytı içermemeli ve UNC/aygıt yolu olmamalıdır. `--auto-data-dir`'i örtük olarak açar. |
| `--client <id>` | Tanılama amaçlı host etiketi (desen `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`); `build_leases.host_label` alanına ve log satırlarına yazılır. Hiçbir yolu değiştirmez: tüm host'lar çalışma alanının `graph.sqlite` dosyasını paylaşır. |
| `--tool-profile <list>` | Etkin MCP araç profili: `core` (varsayılan, 11 araç), `wiki` (+7), `history` (+2), `wiki,history` gibi virgüllü bir liste (20) veya `full` (29 legacy + 3 birleştirilmiş = 32). Öncelik sırası: `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`. Verilen her değer doğrulanır (daha öncelikli bir kaynağın geçersiz kıldığı değer de); bilinmeyen adlar başlatmayı başarısız kılar. |
| `--output-schema <omit\|full>` *(takma adı `--output-schema-profile`)* | `tools/list` yanıtının her aracın JSON `outputSchema`'sını içerip içermeyeceği. Öncelik sırası: bayrak > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `omit`. Sunucu her iki modda da her yanıt envelope'unu doğrular. |

**Bayrak sözdizimi:** `--flag value` ve `--flag=value` biçimlerinin ikisi de çalışır. Konumsal argümanlar, bilinmeyen bayraklar, boş değerler, kendisi bilinen bir bayrak olan değerler ve NUL baytı içeren her argüman reddedilir.

**Başlangıç çıkış kodları:** CLI argüman hataları, geçersiz `CAUSORYN_TOOL_PROFILE` / `CAUSORYN_CONFIG.toolProfile` / `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` değerleri, geçerli JSON olmayan `CAUSORYN_CONFIG` veya doğrulamadan geçemeyen bir konfigürasyon (`CausorynConfigError`; örneğin çalışma alanı içindeki bir veri yolu) için `2`; stdio taşıması başlatılamazsa `1`. Tüm tanılar `stderr`'e gider.

### 1.4 `causoryn --version` ve `causoryn --help`

- `causoryn --version` (ayrıca `-v`, `version`): paket sürümünü (bu sürüm için `0.3.2`) basar ve `0` ile çıkar.
- `causoryn --help` (ayrıca `-h`, `help` veya argümansız): yukarıdaki kullanım metnini basar ve `0` ile çıkar.

---

## 2. Ön-yükleme Node.js `>= 24` koruması ve plugin başlatıcısı

### 2.1 `scripts/lib/node-version-guard.mjs` (`assertSupportedNodeVersion`)

Hem `scripts/causoryn.mjs` hem de `scripts/plugin-mcp-launcher.mjs`, herhangi bir bundle'ı veya native `better-sqlite3` eklentisini içe aktarmadan **önce** bu bağımlılıksız korumayı çalıştırır. Node.js `< 24` üzerinde `stderr`'e `[causoryn] Unsupported Node.js version (...). Causoryn requires Node.js >= 24.` yazar, `stdout`'a hiçbir şey yazmaz ve `2` ile çıkar. Bu, MCP stdio çerçevelemesini temiz tutar ve eski runtime'larda anlaşılması güç native-eklenti yükleme hatalarını önler.

### 2.2 `scripts/plugin-mcp-launcher.mjs` ve sürüm pinleme

Host plugin manifestleri (`.claude-plugin/plugin.json`, `.zcode-plugin/plugin.json`, `.codex-plugin/mcp.json`, `packages/causoryn/mcp_config.json`), iç içe bir `npx` süreci yerine `scripts/plugin-mcp-launcher.mjs`'i doğrudan `node` ile ve host'un `cwd` alanı olan her yerde plugin kökünden başlatır:

- `--expected-version <semver>` (veya `--expected-version=<semver>`) ve/veya `CAUSORYN_EXPECTED_VERSION` kabul eder; diğer tüm argümanlar sunucuya aktarılır.
- `--project-dir <dir>` (veya `--project-dir=<dir>`; ZCode `${ZCODE_PROJECT_DIR}` geçirir) kabul eder: var olan bir dizine giden tam nitelikli yerel bir yol (UNC/aygıt yolu, NUL ve genişletilmemiş `${…}` yok) bundle yüklenmeden hemen önce sunucunun çalışma dizini olur; böylece `--allow-cwd` proje kökü güvenlik denetimini ona uygular. Başka her değer `stderr` üzerinde `[causoryn-launcher] --project-dir ignored (<reason>)` ile yok sayılır ve sunucu MCP `roots/list` bekler. Bayrak sunucuya asla iletilmez.
- İki pin birbirini tutmazsa, `package.json#name` `causoryn` değilse, `package.json#version` pinden farklıysa veya `dist/mcp-server.mjs` eksikse `stderr`'e yazarak `2` ile çıkar. Bu, önbellekte kalmış bayat bir plugin kopyasının sessizce çalışmasını engeller.
- `CAUSORYN_ASSET_ROOT` ayarlı değilse veya boşsa paket köküne ayarlar ve `dist/mcp-server.mjs`'i içe aktarır. Miras alınan bir değer yalnızca aynı `causoryn` paket sürümünü (`package.json`) ve bir `native/` dizinini barındıran, var olan bir dizinin mutlak yoluysa korunur; aksi halde `stderr`'e `[causoryn-launcher] CAUSORYN_ASSET_ROOT rejected …` yazarak `2` ile çıkar.

---

## 3. Başlatma modları, çalışma alanı keşfi ve güvenlik modeli

### 3.1 Başlatma modları

| Mod | Nasıl başlar | Kök kaynağı | İlk indeks |
|---|---|---|---|
| **Çıplak** | Argümansız `node dist/mcp-server.mjs` (veya `packages/mcp-server/src/stdio.ts`) | Yalnızca `CAUSORYN_CONFIG.allowRoots`; yoksa `allowRoots: []` ve bir `stderr` notu; bu durumda çalışma alanı araçları `WORKSPACE_NOT_AUTHORIZED` döner | `autoIndex` açık ve bir kök ayarlıysa: `storage.dataDbPath` içinde yayımlanmış bir snapshot varsa onu yeniden kullanır, yoksa sunucu bağlanmadan **önce senkron olarak** indeksler. |
| **CLI etkinleştirmesi** | Herhangi bir `causoryn mcp ...` argümanı | `--root` / `CAUSORYN_CONFIG.allowRoots` > `--allow-cwd` ile güvenli cwd > `--allow-cwd` ile MCP `roots/list` > hiçbiri | Ertelenir: MCP `initialized`'dan yaklaşık 100 ms sonra veya ilk `causoryn_status` çağrısında başlar; böylece `initialize` ve `tools/list` hemen yanıt verir. SQLite deposunda zaten yayımlanmış bir snapshot varsa hemen sunulur ve arka planda bir incremental yenileme kuyruğa alınır. |

Her iki mod da başlangıç ayarlarını aynı çözümleyiciyle (`resolveMcpServerSettings`) belirler: araç profili `--tool-profile` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`, çıktı şeması profili `--output-schema` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > `omit` ve `CAUSORYN_INDEX_WAIT_MS`. Çıplak mod bayrak almaz; bu yüzden yalnızca ortam ve `CAUSORYN_CONFIG` uygulanır.

### 3.2 Bloklamayan indeksleme, sıcak okumalar ve güncellik

- **Worker thread:** İndeks işleri, süreç-içi asenkron bir fallback'le birlikte bir `worker_threads` worker'ında (`dist/index-worker.mjs`) çalışır; böylece büyük bir depo analiz edilirken MCP olay döngüsü yanıt vermeye devam eder.
- **Sıcak başlangıç:** Mevcut bir `graph.sqlite` ile `getLatestSnapshotMeta`, tüm grafiği yüklemeden snapshot meta verisini okur, yayımlanmış snapshot hemen sunulur ve arka plandaki bir incremental yenileme (değişmemiş dosya başına olguları `file_facts`'ten yeniden kullanarak) sunucu kapalıyken düzenlenen dosyaları yakalar. Sonraki kod değişikliklerinden sonra `causoryn_status`'u `action: "refresh"` ile çağırın.
- **Sınırlı bekleme:** Snapshot'a bağımlı araçlar ilk indeks için `CAUSORYN_INDEX_WAIT_MS` (varsayılan `15000`, `0` = bekleme yok) kadar bekler; ardından başarısız olmak yerine `status: "partial"` ile yapısal bir `{ indexing: true, status: "indexing", jobId, progress, retryAfterMs }` yükü döner. `_meta.progressToken` gönderen istemciler `notifications/progress` alır.
- **Bayat okumalar:** Yeniden indeksleme sürerken yanıtlar bir `stale=true` uyarısı taşır ve en son yayımlanmış snapshot'ı sunar.
- **SQLite ayarları:** WAL günlük modu, `busy_timeout = 5000`, yeni veritabanlarında ayarlanan `page_size = 4096` (SQLite'ın varsayılan sayfa boyutu; bir güvenlik kontrolü değil, bir konfigürasyon olgusudur). Causoryn yalnızca kendi veri dizinindeki veritabanı dosyalarını açar; analiz edilen bir çalışma alanındaki veritabanı veya WAL dosyalarını asla açmaz.

### 3.3 `inspectProjectRootSafety` — reddedilen kökler

Herhangi bir dosya sistemi çağrısından önce `isUncOrDevicePath` (`packages/workspace/src/path-safety.ts`) `\\host\share`, `//host/share`, `\\?\...` ve `\\.\...` yollarını reddeder; böylece aday bir kök asla giden bir SMB/NTLM bağlantısını tetikleyemez. Kalan yol `realpathSync` ile kanonikleştirilir (Win32 `\\?\` önekleri temizlenir) ve aşağıdaki kurallardan herhangi birine uyarsa reddedilir. `--allow-cwd` veya `roots/list` kaynaklı her aday bu denetimden geçer; açık `--root` / `allowRoots` değerleri verildiği gibi güvenilir kabul edilir (yalnızca UNC/aygıt biçimi ve `--auto-data-dir` ile birlikte mevcut dizin olup olmadıkları denetlenir).

1. Boş, NUL içeren, çözümlenemeyen veya dizin olmayan yollar.
2. Dosya sistemi ve sürücü kökleri (`/`, `C:\` ve diğer her sürücü kökü).
3. Ev dizini (`$HOME` / `%USERPROFILE%`) **ve onun her atası** (`/home`, `/Users`, `C:\Users` ...).
4. Causoryn veri dizinleri ve alt dizinleri: `~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`.
5. Plugin, bundle ve kurulum önbelleği dizinleri: `~/.causoryn/runtime`, `~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, `node_modules` veya `_npx` segmenti içeren yollar, `bundle-manifest.json` gibi plugin kurulum işaretçileri taşıyan dizinler ve bir `causoryn` plugin kurulumunun içindeki her dizin (monorepo çalışma alanı kökleri tanınır ve bu nedenle reddedilmez).
6. Hassas kullanıcı dizinleri: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`.
7. Altlarındaki her şey dahil sistem dizinleri: POSIX'te `/etc`, `/private/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/bin`, `/sbin`, `/lib`, `/dev`; Windows'ta `SystemRoot`, `WINDIR`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramData` ve fallback'leri `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`.
8. Yalnızca tam eşleşme olarak paylaşılan geçici kökler (içlerindeki proje alt dizinlerine izin verilmeye devam eder): `os.tmpdir()` ve POSIX'te `/tmp`, `/private/tmp`, `/var`, `/private/var`, `/var/tmp`, `/private/var/tmp`.

### 3.4 Dinamik MCP `roots/list` bağlama

`--allow-cwd` verildiğinde ve açık kök olmadığında kökü `attachMcpRootsWorkspaceBinder` yönetir:

1. cwd güvensizse (sunucuları `$HOME`, `/` veya bir plugin klasöründe başlatan masaüstü IDE'lerde tipiktir), sunucu başarısız olmak yerine `allowRoots: []` ile başlar.
2. `oninitialized` anında, ilk araç çağrısından önce ve her `notifications/roots/list_changed` bildiriminde, istemci `roots` yeteneğini bildiriyorsa single-flight bir `roots/list` isteği (5.000 ms zaman aşımı) çalıştırır.
3. `file://` URI'leri sırayla `inspectProjectRootSafety` ile denetlenir; ilk güvenli dizin `DynamicCausorynContext.rebind()` aracılığıyla atomik olarak bağlanır (`--auto-data-dir` açıksa veri dizini hazırlanır ve önceki SQLite tanıtıcıları kapatılır).
4. Sonraki bir liste hiç güvenli kök içermiyorsa sunucu `allowRoots: []` durumuna yeniden bağlanır. Başlangıçta bağlanan bir cwd de istemci `roots/list_changed` gönderdiğinde değiştirilebilir.

### 3.5 Ignore keşfi ve akıllı `bin/` işleme

Sunucu konfigürasyonunu CLI bayraklarından oluşturduğunda (`buildWorkspaceAutoConfig` + `workspace-ignore-discovery.ts`), birincil kökteki ignore desenlerini şu sırayla `extraIgnore` ile birleştirir:

1. Kökteki `.gitignore` (en fazla 256 KB; `O_NOFOLLOW` ve bir `(dev, ino)` denetimiyle okunur, böylece sembolik bağlantılar izlenmez).
2. `.git/info/exclude`; yalnızca `.git` gerçek bir dizinse (sembolik bağlantı değilse).
3. Sınırlı bir taramayla bulunan iç içe `.gitignore` dosyaları: derinlik ≤ 6, en fazla 64 dosya ve 4.000 dizin; her desen kendi alt dizinine kapsamlanır; toplamda en fazla 1.000 keşfedilmiş desen. Negasyonlar ihtiyatlı ele alınır (negatiflenmiş bir dosyayı gizleyebilecek geniş dizin desenleri dışarıda bırakılır).

Çağıran kendi `ignore` listesini vermezse, kaba varsayılan `**/bin/**` yerine `.NET` çıktı desenleri kullanılır (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` artı derinlik 4 içinde bulunan en fazla 128 `.csproj`/`.fsproj`/`.vbproj` projesi için `<projectDir>/bin/**`); böylece Node `bin/*.ts|js` ve Rust `src/bin/*.rs` kaynakları indekslenmeye devam eder. Eşleştirme doğrusal zamanlı, regex kullanmayan bir glob eşleştiricisiyle (`packages/workspace/src/ignore-matcher.ts`) yapılır. Bkz. [Dil Analizörleri](language-analyzers.md).

---

## 4. Kaynak ağacı dışı veri dizini düzeni

Causoryn analiz edilen kaynak ağacına asla yazmaz. `--auto-data-dir` ile aynı depoyu açan her MCP host'u aynı SQLite veritabanını (`graph.sqlite`, WAL modu) kullanır. Tek-yazar koordinasyonu `build_leases` tablosundaki heartbeat kiralarıyla (`lease_id`, `owner_pid`, `host_label`, `hostname`, `owner_instance`, `heartbeat_at`, `expires_at`; varsayılan TTL 120 sn, heartbeat 10 sn'de bir ana iş parçacığından ve faz sınırlarında) sağlanır; bu, eşzamanlı iki yayımcıyı önler. Aynı host'ta bir sahip PID'i yaşadığı sürece canlı sayılır (TTL ikincildir); başka bir host'ta yalnızca TTL geçerlidir; 10 dakikadan eski bir heartbeat (`CAUSORYN_LEASE_STALE_CEILING_MS`) her zaman ölü sayılır. Canlı bir sahiple karşılaşan koşu onu bekler (`waiting_for_peer`, en fazla `CAUSORYN_PEER_WAIT_TIMEOUT_MS`) ve girdiler eşleşirse onun snapshot'ını yeniden kullanır. `recoverOrphanBuilds`, çöken bir sürecin `building` durumunda bıraktığı derlemeleri kurtarılmış yetimler olarak işaretler.

```text
~/.causoryn/                                    # her host için temel dizin (geçersiz kılma: --data-dir; ZCODE_PLUGIN_DATA yalnızca yedek)
├── runtime/                                    # `setup`'ın geçici npx önbelleğinden sahnelediği kalıcı runtime
│   ├── package.json
│   ├── scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs}
│   ├── dist/{mcp-server.mjs,index-worker.mjs,index.js,bundle-manifest.json,node_modules/better-sqlite3,typescript-lib}
│   ├── native/{roslyn-worker,python-worker,go-worker,rust-worker}
│   └── skills/{causoryn,map-system,preflight-change,verify-change,architecture-blueprint}
├── installed-skills.json                       # `setup` kurulum kaydı: yazdığı her SKILL.md için yol + SHA-256
├── workspaces/
│   └── <slug>-<hash12>/                        # POSIX'te mod 0o700
│       ├── graph.sqlite                        # storage.dataDbPath + wiki.dataDbPath: graph, file_facts, build_leases, symbol_fts, wiki deposu
│       ├── graph.schema-<N>.sqlite             # yalnızca graph.sqlite bu build'den daha yeni bir şemadaysa (bu build ona asla yazmaz)
│       ├── history/                            # history araçlarının commit analizi önbelleği (<commitSha>-<anahtar>.json, yalnızca sahibine açık)
│       └── exports/                            # mod 0o700; output.allowedOutputDirs (ör. causoryn-architecture-interactive.html)
└── cache/
    └── rust-worker-target/                     # yazılabilir Cargo hedef dizini (CAUSORYN_RUST_TARGET_DIR) + causoryn-rust-worker.sha256.json pini
```

- **Temel dizin önceliği** (`resolveBaseDataDir`): `--data-dir <absPath>` > `~/.causoryn`; her host için aynıdır, böylece ZCode indeksi diğer host'larla paylaşır. `ZCODE_PLUGIN_DATA` yalnızca `~/.causoryn` oluşturulamadığında veya yazılamadığında yedek olarak kullanılır (açık bir `--data-dir` asla yedeğe düşmez). `--data-dir` ve `ZCODE_PLUGIN_DATA` mutlak olmalı ve UNC/aygıt yolu olmamalıdır; ayarlanmış bir `ZCODE_PLUGIN_DATA` kullanılmasa bile doğrulanır.
- **Çalışma alanı klasör adı:** `<slug>`, kökün temel adının küçük harfe çevrilmiş, `[a-z0-9._-]` dışındaki karakterleri `-` ile değiştirilmiş, baştaki/sondaki `.`, `_`, `-` karakterleri kırpılmış ve 48 karaktere kesilmiş hâlidir (boşsa `workspace`). `<hash12>`, kanonik kök yolunun SHA-256 değerinin ilk 12 hex karakteridir. Slug aynı zamanda varsayılan `workspaceId`'dir.
- **Ortak veritabanı ve eski dosyalar:** Önceki sürümler host başına bir `graph-<client>.sqlite` oluşturuyordu. `graph.sqlite` henüz yoksa ilk başlangıç en yeni geçerli eski dosyayı bir kez ona kopyalar (her aday salt-okunur açılır ve desteklenen bir `user_version` ile `PRAGMA quick_check`'ten geçmelidir; kopya SQLite'ın çevrimiçi yedeklemesiyle yapılır ve başka bir sürecin önce oluşturduğu dosyanın üzerine yazmadan yayımlanır). Eski dosyalar yerinde bırakılır; `causoryn doctor` bunları listeler, böylece silebilirsiniz. `--client` artık dosya adını değiştirmez.
- **Daha yeni şema koruması:** `graph.sqlite` bu build'in desteklediğinden daha yeni bir Causoryn şemasıyla damgalanmışsa bu build ona asla yazmaz; bunun yerine `graph.schema-<N>.sqlite` (N = kendi şema sürümü) kullanır ve `stderr`'e tek bir satır yazar. Güncel şema v6'dır; v1–v5 veritabanları açılışta taşınır, bu yüzden `0.3.2` (şema v5) bir v6 `graph.sqlite` dosyasına dokunmaz ve `graph.schema-5.sqlite` kullanır.
- **`mkdir` öncesi ve sonrası kapsama denetimleri:** Herhangi bir şey oluşturulmadan önce hedefin mevcut her atası denetlenir (`assertDataDirAncestorsSafe`, `assertNotSymlinkDirectory`, `assertStrictlyOutsideWorkspaceRoots`): sembolik bağlantılar (CWE-59; macOS sistem firmlink'leri `/var`, `/tmp`, `/etc` serbesttir), sarkan bağlantılar, dizin olmayanlar ve yetkili bir kökün içine çözümlenen her yol `CausorynConfigError` ile reddedilir. Oluşturmadan sonra `realpathSync`, TOCTOU yarışlarına karşı kapsamayı yeniden denetler.
- **`CAUSORYN_CONFIG` kazanır:** `CAUSORYN_CONFIG` zaten `storage.dataDbPath`, `wiki.dataDbPath`, `output.allowedOutputDirs` veya `workspaceId` ayarlıyorsa, `--auto-data-dir` bu değerleri korur ve yalnızca eksik olanları doldurur.
- **Veritabanı başına tek kök:** her graph ve wiki veritabanı, `workspaceId`'si için `allowRoots[0]`'ın kanonik kökünü (gerçek yol; Windows'ta büyük/küçük harf duyarsız) kaydeder ve depolama şeması v6'dan beri onu kanonik olarak işaretler (`workspaces.root_canonical`): işaretli bir kök link izlenmeden, kaydedildiği gibi karşılaştırılır; böylece sonradan link'e dönüşen kayıtlı bir kök reddedilir. `<slug>-<hash12>` düzeni her köke kendi veritabanını verir; bir `CAUSORYN_CONFIG`'in aynı `workspaceId` altında ikinci bir kök için yeniden kullandığı veritabanı başlatmada reddedilir (bkz. [§5.2](#52-alan-başvurusu) içindeki `storage.dataDbPath`).
- **Saklama:** Her yayım, aynı işlemde eski snapshot'ları budar (`pruneOldSnapshots` en yeni 2 yayımlanmış snapshot'ı tutar ve yetim `symbol_fts` satırlarını siler), ardından pasif bir WAL checkpoint çalıştırır. Snapshot kimlikleri kanonik snapshot baytları üzerinde akışlı bir SHA-256'dır; bu nedenle kanonik biçimle özdeş kalır.
- **`--auto-data-dir` olmadan:** `CAUSORYN_CONFIG` yolları beyan etmedikçe graph süreç-içi bir `InMemoryGraphRepository` içinde yaşar (çıkışta kaybolur), dışa aktarımlar `EXPORT_NOT_ALLOWED` döner ve wiki araçları kullanılamaz (`PATH_DENIED` / `INDEX_NOT_READY`).

---

## 5. Tam `CAUSORYN_CONFIG` şeması

`CAUSORYN_CONFIG`, başlangıçta ayrıştırılan ve `causorynServerConfigSchema`'ya (`packages/mcp-server/src/config.ts`; `packages/workspace/src/policy-config.ts` içindeki `workspacePolicyConfigSchema`'yı genişletir) göre doğrulanan bir JSON dizgesidir.

> **Katı şema:** Her iki düzey de `z.strictObject`'tir; bu nedenle bilinmeyen anahtarlar başlatmayı `CausorynConfigError` (çıkış `2`) ile başarısız kılar. Anahtar adlarını tam olarak kullanın: `extensionFilterMode` (`extensionMode` değil), `index.maxFiles` (kök düzeyinde bir `maxFiles` değil), `output.allowedOutputDirs` (`outputAllowRoots` değil).

**CLI bayraklarıyla birleştirme:** CLI modunda JSON taban değerleri sağlar; `--root`, `allowRoots`'un yerini alır; `--auto-data-dir`, `workspaceId`, `storage.dataDbPath`, `wiki.dataDbPath` ve `output.allowedOutputDirs` alanlarını yalnızca JSON'un ayarsız bıraktığı yerlerde doldurur; keşfedilen ignore desenleri `extraIgnore`'a eklenir. JSON'daki boş olmayan bir `allowRoots` açık kök sayılır; bu durumda `--allow-cwd` ve `roots/list` bağlama atlanır.

### 5.1 Tam örnek

```json
{
  "workspaceId": "orders-service",
  "allowRoots": ["/work/orders-service"],
  "ignore": [
    "**/.git/**",
    "**/node_modules/**",
    "**/bin/**",
    "**/obj/**",
    "**/dist/**",
    "**/.env*",
    "**/*.pem"
  ],
  "extraIgnore": ["**/coverage/**", "**/generated/**"],
  "extensionFilterMode": "blacklist",
  "allowedExtensions": [],
  "maxFileBytes": 2000000,
  "index": {
    "maxFiles": 50000
  },
  "results": {
    "maxNodes": 250,
    "maxSymbols": 100,
    "maxDepth": 3,
    "maxPaths": 50
  },
  "autoIndex": true,
  "output": {
    "allowedOutputDirs": ["/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/exports"]
  },
  "storage": {
    "dataDbPath": "/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/graph.sqlite"
  },
  "wiki": {
    "dataDbPath": "/Users/you/.causoryn/workspaces/orders-service-a1b2c3d4e5f6/graph.sqlite"
  },
  "toolProfile": "core"
}
```

### 5.2 Alan başvurusu

| Alan | Tür | Varsayılan | Doğrulama ve çalışma zamanı davranışı |
|---|---|---|---|
| `workspaceId` | `string` (en az 1) | `"default"` (`--auto-data-dir` altında `<slug>`) | Tek yetkili çalışma alanının opak kimliği; farklı bir `workspaceId` ile yapılan araç çağrıları `WORKSPACE_NOT_AUTHORIZED` döner. |
| `allowRoots` | `string[]` | `[]` | NUL baytı içermeyen mutlak dizin yolları (CLI modunda UNC/aygıt yolları reddedilir). Boş = varsayılan ret (`WORKSPACE_NOT_AUTHORIZED`). `allowRoots[0]` indekslenen köktür. |
| `ignore` | `string[]` | 38 desen (`DEFAULT_IGNORE_PATTERNS`) | `**/.git/**`, `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/dist/**`, `**/.env*`, `**/*.pem`, ayrıca derleme, sanal ortam ve önbellek klasörleri (`.next`, `.venv`, `__pycache__`, `target`, `coverage`, `vendor`, `Pods`, `.gradle`, `.vite`, ...) ve `**/*.min.js` / `**/*.min.mjs`. Ayarlanması varsayılanların yerini alır ve akıllı `bin/` iyileştirmesini devre dışı bırakır. |
| `extraIgnore` | `string[]` | `[]` | `ignore`'un yerini almadan ondan sonra eklenir; CLI modundaki ignore keşfi buraya ekler. |
| `binaryExtensions` | `string[]` | 68 uzantı (`DEFAULT_BINARY_EXTENSIONS`) | `blacklist` modunda kullanılan, küçük harfe çevrilmiş ret listesi (görseller, arşivler, çalıştırılabilir dosyalar ve kütüphaneler, `.pyc`, `.wasm`, `.sqlite`, `.db`, ofis dosyaları, `.map`, `.whl`, `.parquet`, `.onnx`, `.pt`, `.safetensors`, `.gguf`, ...). Her girdi `^\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+$` ile eşleşmelidir. |
| `extensionFilterMode` | `"blacklist" \| "whitelist"` | `"blacklist"` | `blacklist`, `binaryExtensions`'ı atlar; `whitelist` yalnızca `allowedExtensions`'ı kabul eder. |
| `allowedExtensions` | `string[]` | `[]` | `whitelist` modunda izin verilen uzantılar (aynı biçim kuralı). |
| `maxFileBytes` | pozitif tam sayı | `2000000` | Dosya başına boyut sınırı. Daha büyük dosyalar indeksleyici tarafından atlanır ve dosya politikası tarafından reddedilir (`workspace/limit-exceeded`); politika/baseline dosya okumalarını da sınırlar. |
| `index.maxFiles` | pozitif tam sayı | `50000` | En büyük envanter boyutu; aşılması indeks işini `LIMIT_EXCEEDED` ile başarısız kılar. |
| `results.maxNodes` | pozitif tam sayı | `250` | `causoryn_map_system` için sayfa tavanı (bunun üzerindeki `maxNodes` → `LIMIT_EXCEEDED`) ve sembol bağlamı için node üst sınırı. |
| `results.maxSymbols` | pozitif tam sayı | `100` | `causoryn_find_symbols` `limit` değeri için tavan ve varsayılan. |
| `results.maxDepth` | pozitif tam sayı | `3` | Sembol bağlamı `depth` değeri için tavan (üzeri → `LIMIT_EXCEEDED`); yürütme izleri buna kırpılır. |
| `results.maxPaths` | pozitif tam sayı | `50` | Yürütme izi `maxPaths` değerinin kırpıldığı tavan. |
| `autoIndex` | `boolean` | `true` | Bir kök ayarlıysa başlangıçta indeksler (veya saklanan snapshot'ı yeniden kullanır); CLI modunda ertelenir, çıplak modda senkrondur. `false` = bir yenileme istenene kadar araçlar `INDEX_NOT_READY` döner. |
| `output.allowedOutputDirs` | `string[]` | `[]` | `causoryn_export_documentation`'ın yazabileceği mevcut dizinler (ve alt dizinleri). Başlangıçta çözümlenir; çözümlenemeyen bir girdi sunucuyu durdurur. `allowRoots`'tan bağımsızdır. Boş = `EXPORT_NOT_ALLOWED`. Bkz. [Prompting ve Mimari Portallar](prompting-and-architecture-portals.md). |
| `storage.dataDbPath` | isteğe bağlı `string` | ayarsız (`InMemoryGraphRepository`) | Graph, `file_facts`, `build_leases` ve `symbol_fts` için SQLite dosyası. Mutlak olmalı, NUL baytı içermemeli, üst dizini mevcut olmalı, boş olmayan bir `allowRoots` ile birlikte verilmeli ve hem sözcüksel olarak hem `realpath` sonrasında her kökün kesinlikle dışında olmalıdır; aksi hâlde başlatma başarısız olur. Ortak veritabanı kira koordinasyonunu etkinleştirir. Veritabanı, `workspaceId` için `allowRoots[0]`'ın kanonik kökünü kaydeder; o `workspaceId`'yi farklı bir kök için zaten tutuyorsa başlatma `CausorynConfigError` ile durur (`storage.dataDbPath holds workspace "<id>" recorded for a different root than allowRoots[0]; refusing to open it …`) ve dosya değiştirilmez. 0.3.2 sunucusunun aynı kökü başka bir yazımla (sondaki ayırıcı, büyük/küçük harf, bir link) kaydettiği eşleşen (işaretsiz) bir kayıt bir kez çözümlenir, ilk açılışta kanonik köke yeniden yazılır ve işaretlenir; bu yüzden böyle bir veritabanı yazılabilir olmalıdır (aksi hâlde başlatma `storage.dataDbPath workspace record could not be written: …` ile durur). Her kök için ayrı bir `storage.dataDbPath` ya da farklı bir `workspaceId` kullanın. History önbelleği bu dosyanın yanındaki `history/` dizinindedir. |
| `wiki.dataDbPath` | isteğe bağlı `string` | ayarsız (`causoryn_wiki_build` → `PATH_DENIED`, wiki okumaları → `INDEX_NOT_READY`) | Living Wiki deposu (`wiki_fts`) için SQLite dosyası. Kök bağlama dahil `storage.dataDbPath` ile aynı denetimler uygulanır (ret mesajı bu durumda `wiki.dataDbPath` adını taşır); aynı dosya olabilir. |
| `toolProfile` | isteğe bağlı `string` | ayarsız | Ne `--tool-profile` ne de `CAUSORYN_TOOL_PROFILE` verildiğinde kullanılan araç profili (`core`, `full`, `wiki`, `history` veya virgüllü bir liste). Bayrak ve ortam değişkeniyle aynı ayrıştırıcıyla doğrulanır; geçersiz değer başlatmayı durdurur. `causoryn mcp`, çıplak `stdio.ts` girişi ve programatik gömme için geçerlidir. |

> **Programatik sidecar seçenekleri (`IndexServiceOptions`):** `IndexService`'i doğrudan oluşturan kütüphane çağıranları `csharp` (`dotnetCommand`, `requestTimeoutMs`, `workerDllPath`), `python` (`pythonCommand`, `requestTimeoutMs`, `workerScriptPath`), `go` (`goBinaryPath`, `goWorkerBinaryPath`, `workerDir`, `requestTimeoutMs`) ve `rust` (`workerDir`, `cargoHomeDir`, `requestTimeoutMs`, `cargoBuildTimeoutMs`) seçeneklerini geçebilir. MCP sunucu dağıtımlarında sidecar konumları aşağıdaki ortam değişkenlerinden gelir.

---

## 6. Ortam değişkenleri

| Değişken | Okuyan | Amaç ve varsayılan |
|---|---|---|
| `CAUSORYN_CONFIG` | `mcp-server` (`cli-stdio.ts`, `stdio.ts`) | JSON sunucu konfigürasyonu ([§5](#5-tam-causoryn_config-şeması)). Geçersiz JSON `2` ile çıkar. |
| `CAUSORYN_TOOL_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `core`, `wiki`, `history`, `full` veya virgüllü bir liste; `--tool-profile` yokken kullanılır ve `CAUSORYN_CONFIG.toolProfile`'dan önceliklidir (varsayılan `core`). Geçersiz değerler başlatmayı başarısız kılar. |
| `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `omit` (varsayılan) veya `full`; `--output-schema` yokken kullanılır. Geçersiz değerler başlatmayı başarısız kılar. |
| `CAUSORYN_INDEX_WAIT_MS` | `mcp-server` (`runtime-cli.ts`) | İlk indeks için milisaniye cinsinden bekleme penceresi (varsayılan `15000`; `0` indeksleme durumunu hemen döner; negatif veya sayısal olmayan değerler varsayılana düşer). |
| `CAUSORYN_HISTORY_MAX_ANALYSES` | `mcp-server` (`history-commit-analysis.ts`) | Tek bir `causoryn_compare_architecture` / `causoryn_architecture_timeline` çağrısının git nesnelerinden taze analiz edebileceği commit sayısı (pozitif tam sayı; varsayılanlar: compare `2`, timeline `4`; geçersiz bir değer loglanır ve yok sayılır). Önbellekteki commit'ler sayılmaz; bütçeyi aşan noktalar `analysis-budget-exceeded` bildirir ve sonraki bir çağrıda analiz edilir. |
| `CAUSORYN_HISTORY_MAX_COMMIT_BYTES` | `mcp-server` (`history-commit-analysis.ts`) | Tek bir taze commit analizinin okuyabileceği kaynak metni (UTF-8 bayt; varsayılan `33554432` = 32 MiB). Analizin koştuğu worker iş parçacığının heap sınırını da belirler: 256 MiB artı bu bütçenin başlanan her MiB'ı için 24 MiB (varsayılan 1024 MiB), en çok makine belleğinin yarısı ve 8192 MiB, asla 256 MiB'ın altında değil; bunu aşan worker `analysis-memory-exceeded` bildirir. Her `CAUSORYN_HISTORY_*` ayarı gibi pozitif bir tamsayı alır (`CAUSORYN_HISTORY_BUSY_WAIT_MS` ayrıca `0` da alır); geçersiz bir değer loglanır ve yok sayılır. Aşıldığında nokta `commit-byte-budget-exceeded` bildirir. |
| `CAUSORYN_HISTORY_MAX_REQUEST_BYTES` | `mcp-server` (`history-commit-analysis.ts`) | Bir history aracı çağrısının tüm taze analizlerinin birlikte okuyabileceği kaynak metni (varsayılan `67108864` = 64 MiB); aşıldığında: `request-byte-budget-exceeded`. |
| `CAUSORYN_HISTORY_MAX_ANALYSIS_MS` | `mcp-server` (`history-commit-analysis.ts`) | Tek bir taze commit analizinin milisaniye cinsinden duvar saati sınırı (varsayılan `120000`); ağaç girdileri ve blob okumaları arasında ve analiz worker'ının her ilerleme mesajında denetlenir, worker'ı sonlandıran bir zamanlayıcıyla uygulanır ve her git sürecine zaman aşımı olarak geçirilir. Aşıldığında: `analysis-deadline-exceeded`. |
| `CAUSORYN_HISTORY_MAX_REQUEST_MS` | `mcp-server` (`history-commit-analysis.ts`) | Bir çağrının tüm taze analizlerinin, yuva beklemesi dahil duvar saati sınırı (varsayılan `300000`); aşıldığında: `request-deadline-exceeded`. |
| `CAUSORYN_HISTORY_MAX_CONCURRENT` | `mcp-server` (`history-commit-analysis.ts`) | Tek bir sunucu sürecinde aynı anda koşabilecek taze commit analizi sayısı (varsayılan `1`). |
| `CAUSORYN_HISTORY_BUSY_WAIT_MS` | `mcp-server` (`history-commit-analysis.ts`) | Bir çağrının boş bir analiz yuvası için (FIFO) ne kadar bekleyeceği (varsayılan `30000`; `0` beklemez; aynı anda en çok 16 çağrı bekler). Yuva alamayan çağrı `analysis-busy` bildirir. |
| `CAUSORYN_HISTORY_CACHE_MAX_ENTRIES` | `mcp-server` (`history-commit-analysis.ts`) | History önbellek dizininde tutulan girdi sayısı (varsayılan `256`); her kayıttan sonra bunu aşan en eski girdiler çıkarılır. |
| `CAUSORYN_HISTORY_CACHE_MAX_BYTES` | `mcp-server` (`history-commit-analysis.ts`) | History önbellek girdilerinin toplam baytı (varsayılan `1073741824` = 1 GiB); önce en eski girdiler çıkarılır. |
| `CAUSORYN_PEER_WAIT_TIMEOUT_MS` | `indexing` (`index-service.ts`) | Bir indeks koşusunun build lease'ini tutan canlı bir eşi ne kadar bekleyeceği (varsayılan `900000` = 15 dk; `0` beklemeyi kapatır). Zaman aşımında iş `peer_busy` sonucuyla `failed` biter ve mevcut snapshot sunulmaya devam eder. |
| `CAUSORYN_PEER_POLL_INTERVAL_MS` | `indexing` (`index-service.ts`) | Eş beklenirken ilk yoklama aralığı (varsayılan `100`; üstel geri çekilmeyle büyür). |
| `CAUSORYN_LEASE_STALE_CEILING_MS` | `indexing` (`index-service.ts`) | Lease heartbeat'leri için sert bayatlık tavanı (varsayılan `600000` = 10 dk); daha eski bir heartbeat, PID'i yaşasa bile ölü sayılır. |
| `CAUSORYN_EXPECTED_VERSION` | `plugin-mcp-launcher.mjs` | Başlatıcının bulması gereken tam paket sürümü (uyuşmazlıkta çıkış `2`). |
| `CAUSORYN_ASSET_ROOT` | `sidecar-ipc`, `causoryn.mjs`, `plugin-mcp-launcher.mjs` | `native/` sidecar varlıklarını bulmak için kullanılan kök; ayarlı değilse başlatıcılar tarafından paket köküne ayarlanır. `plugin-mcp-launcher.mjs` miras alınan bir değeri yalnızca aynı `causoryn` sürümünün paket dizini için kabul eder (bölüm 2.2). |
| `CAUSORYN_TS_LIB_DIR` | `adapters/typescript` | Paketlenmiş TypeScript `lib.*.d.ts` dosyalarının (`lib.es2022.full.d.ts`) konumu. |
| `CLAUDE_CONFIG_DIR` | `causoryn` (`setup`, `doctor`) | Claude Code konfigürasyonunu ve skill'lerini `$CLAUDE_CONFIG_DIR/.claude.json` ve `$CLAUDE_CONFIG_DIR/skills/` konumlarına taşır. |
| `CODEX_HOME` | `causoryn` (`setup`, `doctor`) | Codex konfigürasyon dizini (`$CODEX_HOME/config.toml`, varsayılan `~/.codex`). |
| `ZCODE_PLUGIN_DATA` | `mcp-server` (`runtime-cli.ts`) | `--auto-data-dir` için yedek temel veri dizini; yalnızca `~/.causoryn` oluşturulamadığında veya yazılamadığında ve `--data-dir` yokken kullanılır; ayarlandığında her zaman doğrulanır ve asla proje kökü olarak kabul edilmez. |
| `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` | host plugin yükleyicileri, `runtime-cli.ts` | Plugin manifestleri tarafından başlatıcıyı bulmak için kullanılır; bu dizinler asla proje kökü olarak kabul edilmez. |
| `DOTNET_ROOT` | `adapters/csharp-roslyn`, `native/roslyn-worker`, `indexing` | .NET runtime'ı ile `Microsoft.NETCore.App.Ref` / `Microsoft.AspNetCore.App.Ref` referans paketleri için birincil kök. |
| `CAUSORYN_ROSLYN_WORKER_DLL` | `adapters/csharp-roslyn`, `indexing` | Derlenmiş bir `Causoryn.RoslynWorker.dll` yolu. |
| `CAUSORYN_PYTHON_WORKER_SCRIPT` | `adapters/python`, `indexing` | `native/python-worker/worker.py` yolu. |
| `CAUSORYN_GO_WORKER_BIN` | `adapters/go`, `indexing` | Önceden derlenmiş bir Go worker ikilisinin yolu (`go run ./cmd/worker` adımını atlar). |
| `CAUSORYN_GO_WORKER_DIR` | `adapters/go`, `indexing` | `native/go-worker` modülünün konumu. Çalışma zamanında Go komutu `PATH`'teki `go`'dur (veya programatik olarak `go.goBinaryPath`); `CAUSORYN_GO_BINARY` yalnızca Go adapter test süiti için bir yardımcıdır. |
| `CAUSORYN_RUST_WORKER_DIR` | `adapters/rust`, `indexing` | Derlenmiş bir `causoryn-rust-worker` ikilisini içeren dizin. Açıkça yapılandırılmış bir dizin asla yerinde derlenmez; ikili orada yoksa Rust analizörü L0/L1'e düşer. |
| `CAUSORYN_RUST_TARGET_DIR` | `adapters/rust` | İsteğe bağlı `cargo build --locked` için derleme önbelleği (varsayılan `~/.causoryn/cache/rust-worker-target`). Worker crate'i oradaki bir hazırlık (staging) dizinine kopyalanır ve onun içindeki `--target-dir` ile derlenir; derlenen ikili `causoryn-rust-worker.sha256.json` ile pinlenir. Analiz edilen workspace içindeki bir önbellek dizini reddedilir. |
| `CAUSORYN_CARGO_HOME` | `adapters/rust` | `cargo`'yu bulmak için alt sürecin `PATH`'inin başına eklenen dizin (varsayılan `~/.cargo/bin`; güvenli bir komut yolu olarak doğrulanır). |

MCP sunucusunun başlattığı her alt süreç (sidecar'lar, `git`, `cargo`; Windows'ta `System32` altındaki `taskkill`), analiz edilen workspace dışındaki `PATH` girdilerinden çözümlenen mutlak bir çalıştırılabilir yoldan, `shell: false` ve güvenilir bir çalışma diziniyle başlatılır ve daraltılmış, sertleştirilmiş bir ortam alır (örneğin Go için `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; Python için `python -I -B -X utf8`; Roslyn için boş bir `DOTNET_STARTUP_HOOKS`; Cargo için boş bir `CARGO_BUILD_RUSTC_WRAPPER`). Python adapter'ı (ve `causoryn doctor`) POSIX'te önce `python3` sonra `python` dener, Windows'ta `python` kullanır; açıkça yapılandırılmış bir `pythonCommand` olduğu gibi kullanılır. Ayrıntılar: [Güvenlik Denetimi](security-pass.md).

---

## 7. Çıktı kanalları ve loglama politikası

- **`causoryn mcp`:** `stdout` yalnızca MCP JSON-RPC çerçevelerini taşır. Her log satırı, uyarı ve başlangıç tanısı `[causoryn]` önekiyle `stderr`'e gider. Node koruması ve başlatıcılar aynı kurala uyar.
- **`setup` / `doctor`:** İnsan tarafından okunabilir metin (veya `--json` ile JSON) `stdout`'a gider; onay istemleri ve hatalar `stderr`'e gider.
- **Araç yanıtları:** Her sonuç envelope'u hem `structuredContent` olarak hem de JSON metni olarak taşır. `--output-schema omit|full` yalnızca `tools/list`'in JSON `outputSchema`'yı duyurup duyurmayacağını kontrol eder; envelope her iki modda da Zod şemasına göre doğrulanır.
- **Dosyalar:** Dışa aktarımlar yalnızca `output.allowedOutputDirs` içine, export'un kendisinin oluşturduğu rastgele adlı bir geçici dosya (`flag: "wx"`; mod `0666`, umask ile daraltılır) ve `rename` aracılığıyla yazılır; önceden var olan bir `<target>.tmp` dosyasına asla dokunulmaz. Graph ve wiki depoları yalnızca çalışma alanının dışındaki beyan edilmiş SQLite dosyalarına, history araçlarının önbelleği ise yalnızca `storage.dataDbPath` yanındaki `history/` dizinine yazılır.

---

## 8. Örnekler

`npx` örnekleri analiz edilen projenin dışındaki bir dizinden, npm prefix'i size ait bir dizine sabitlenerek (`--prefix`) çalışır; böylece projenin `.npmrc`, `node_modules` ve `node_modules/.bin` dizini sunucunun çözümlenmesine katılmaz ve proje `--root` veya `CAUSORYN_CONFIG` ile adlandırılır. Günlük kullanım için `causoryn setup` bunun yerine mutlak runtime yolunu kaydeder.

**`setup`'ın yazdığı tipik host kaydı (Claude Code, `~/.claude.json`):**

```json
{
  "mcpServers": {
    "causoryn": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/Users/you/.causoryn/runtime/scripts/causoryn.mjs", "mcp", "--allow-cwd", "--auto-data-dir", "--client", "claude-code"]
    }
  }
}
```

**Wiki ve history araçlarıyla açık kök:**

```bash
npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /work/orders-service --auto-data-dir --client ci --tool-profile wiki,history
```

**Ortam değişkenleri aracılığıyla, yayımlanmış çıktı şemalarıyla tam legacy katalog:**

```bash
CAUSORYN_TOOL_PROFILE=full CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE=full npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /work/orders-service --auto-data-dir
```

**Bellek-içi graph ile `CAUSORYN_CONFIG`'ten kök (veri dizini yok, dışa aktarım yok, wiki yok):**

```bash
CAUSORYN_CONFIG='{"allowRoots":["/work/orders-service"]}' npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp
```

**Kalıcılık, dışa aktarımlar ve wiki ile `CAUSORYN_CONFIG`'ten kök:**

```bash
CAUSORYN_CONFIG='{"allowRoots":["/work/orders-service"],"results":{"maxDepth":6}}' npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --auto-data-dir --tool-profile wiki
```

**Önizleme ve kaldırma:**

```bash
npx causoryn@latest setup --client codex --dry-run
npx causoryn@latest setup --uninstall --all --yes
npx causoryn@latest doctor --client claude-code --json
```

---

## İlgili belgeler

- [5 Dakikalık Hızlı Başlangıç Eğitimi (İngilizce)](en/tutorial-5-minutes.md) · [Dokümantasyon Merkezi](README.md)
- [Mimari Özeti](architecture.md) · [Prompting ve Mimari Portallar Rehberi](prompting-and-architecture-portals.md)
- [Dil Analizörleri](language-analyzers.md) · [MCP Araç Sözleşmeleri](tool-contracts.md)
- [Host Kurulum Rehberleri: Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
- [Güvenlik Denetimi](security-pass.md) · [Uyumluluk Matrisi](compatibility-matrix.md)
