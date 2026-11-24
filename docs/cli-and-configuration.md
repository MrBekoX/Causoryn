# CLI, Sıfır-Ayar Çalışma Alanı Keşfi ve Konfigürasyon Başvurusu

> **Dil / Language:** **Türkçe** | [English](en/cli-and-configuration.md)
>
> **Kanıt:** `packages/causoryn/src/{cli.ts,setup.ts,doctor.ts,runtime-stage.ts,types.ts}`, `packages/causoryn/scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs,verify-package-ready.mjs}`, `packages/mcp-server/src/{cli-stdio.ts,stdio.ts,runtime-cli.ts,config.ts,context.ts,workspace-ignore-discovery.ts}`, `packages/workspace/src/policy-config.ts` (TŞ v2.1 §9, §10.1, §17, §20 · `ADR-008` · `K-021`..`K-026`).

Bu kılavuz; `causoryn` (`v0.2.4` — Pre-1.0 Public Preview) komut satırı arayüzünü, ön-yükleme Node.js sürüm korumasını, plugin pazaryeri başlatıcısını, sıfır-ayar (`zero-config`) çalışma alanı güvenlik modelini, kaynak ağacı dışı (`out-of-tree`) veri dizini düzenini ve `CAUSORYN_CONFIG` şemasını kaynak kodla birebir eşleşecek şekilde belgeler.

---

## 1. CLI Alt Komutları ve Bayraklar (`causoryn`)

Hızlı kurulum ve sağlık kontrolü için `@latest` etiketi önerilir (deterministik kurulum veya CI sabitlemesi için `@0.2.4` gibi tam sürüm pini de desteklenir):

```bash
npx causoryn@latest setup      # Algılanan host'lar için 5 skill + MCP sunucusunu kurar
npx causoryn@latest doctor     # Node.js >= 24, runtime, 4 sidecar ve host hizalamasını salt-okunur doğrular
# Sürüm sabitlemek için: npx causoryn@0.2.4 setup && npx causoryn@0.2.4 doctor
```

Paket ikilisi (`packages/causoryn/scripts/causoryn.mjs`) aşağıdaki alt komutları sunar:

```text
causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--output-schema-profile <full|omit>]
causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all-detected] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
causoryn --version
causoryn --help
```

### 1.1 `causoryn setup` — 4-Host Kurulum ve Kaldırma Sihirbazı

Desteklenen 4 host ortamı (`antigravity`, `claude-code`, `codex`, `zcode`) için MCP sunucu kayıtlarını ve 5 kanonik yönlendirme skill dosyasını (`causoryn`, `map-system`, `preflight-change`, `verify-change`, `architecture-blueprint`) atomik ve yedekli olarak yapılandırır.

| Bayrak | Açıklama |
|---|---|
| `--client <id>` | Hedef host kimliği (`antigravity`, `claude-code`, `codex`, `zcode`). Birden fazla kez verilebilir (`--client claude-code --client codex`) veya virgülle ayrılabilir (`--client=claude-code,zcode`). |
| `--all-detected` | Yalnızca kullanıcı dizininde algılanan kurulu host'ları hedefler. Ne `--client` ne de `--all-detected` verilirse algılanan host'lar (hiçbiri algılanmadıysa 4 host'un tamamı) seçilir. |
| `--dry-run` | Hiçbir dosya/dizin yazmadan veya silmeden planlanan tüm işlemleri (`create`, `update`, `remove`, `noop`) ve sahnelenecek runtime dizinini önizler. |
| `--yes`, `-y` | Etkileşimli onay sormadan değişiklikleri uygular. Etkileşimli TTY oturumlarında `--yes` verilmezse onay istemi `stderr` üzerinden (`Devam edilsin mi? [y/N]`) sorulur. |
| `--skill` / `--no-skill` | Kanonik `SKILL.md` dosyalarının host skill dizinine kurulmasını açar/kapatır (varsayılan: `--skill` açık). |
| `--uninstall` | Seçili host'lardan `causoryn` MCP sunucu kaydını ve kurulu skill klasörlerini kaldırır; başka hiçbir host `~/.causoryn/runtime` dizinine referans vermiyorsa sahnelenmiş runtime kopyasını da temizler. |
| `--json` | İnsan-okur özet yerine yapısal `SetupResult` JSON nesnesini `stdout`'a yazar. |
| `--help`, `-h` | Kullanım metnini gösterir ve `0` ile çıkar. |

#### Host Başına Yazılan Dosyalar ve Güvenlik Disiplini

| Host (`--client`) | MCP Konfigürasyon Dosyası | Skill Dizini | Özel Kural |
|---|---|---|---|
| `antigravity` | `~/.gemini/config/mcp_config.json` (+ mevcutsa `~/.gemini/antigravity/mcp_config.json`) | `~/.gemini/config/skills/` | Yerel yükleyici uyumu için `mcpServers.causoryn` kaydında `type` alanı yazılmaz. |
| `claude-code` | `~/.claude.json` (veya `$CLAUDE_CONFIG_DIR/.claude.json`) | `~/.claude/skills/` (veya `$CLAUDE_CONFIG_DIR/skills/`) | `mcpServers.causoryn` altında `type: "stdio"` yazar. |
| `codex` | `$CODEX_HOME/config.toml` (varsayılan `~/.codex/config.toml`) | `~/.agents/skills/` | `[mcp_servers.causoryn]` tablosunu ve `startup_timeout_sec = 30` alanını TOML yapısını bozmadan günceller. |
| `zcode` | `~/.zcode/cli/config.json` | `~/.zcode/skills/` | `mcp.servers.causoryn` (`type: "stdio"`) yazar; `mcp.servers` ilk kez oluşturuluyorsa `~/.agents/mcp.json` içindeki mevcut fallback MCP sunucularını koruyarak taşır. |

- **Atomik yazım ve yedekleme:** Var olan her konfigürasyon dosyası değiştirilmeden önce aynı dosya izinleriyle (`varsayılan 0o600`, skill dosyaları için `0o644`) `<dosya>.causoryn.backup` yedeği atomik olarak alınır, ardından geçici dosya + `renameSync` ile hedef güncellenir.
- **Symlink koruması (`CWE-59`):** Hedef konfigürasyon dosyası, `.causoryn.backup` dosyası veya hedef `SKILL.md` sembolik bağlantıysa (`lstatSync().isSymbolicLink()`) yazma işlemi `cli/io-error` (çıkış kodu `2`) ile fail-closed reddedilir.

### 1.2 `causoryn doctor` — Salt-Okunur Sağlık ve Hizalama Denetçisi

`causoryn doctor` **%100 salt okunurdur**: diskte tek bir dosya veya dizin oluşturmaz, değiştirmez veya silmez.

| Bayrak | Açıklama |
|---|---|
| `--client <id>` | Gösterilecek ve çıkış koduna (`healthy`) dahil edilecek host'ları filtreler (`antigravity`, `claude-code`, `codex`, `zcode`). |
| `--json` | Yapısal `DoctorReport` JSON çıktısını `stdout`'a yazar. |
| `--help`, `-h` | Kullanım metnini gösterir. |

Denetlenen dört katman:
1. **Node.js çalışma zamanı (`node`):** Çalışan Node.js ana sürümünün `>= 24` olduğunu doğrular.
2. **Paket ve sahnelenmiş runtime bütünlüğü (`runtime`):** `dist/mcp-server.mjs`, platform/mimari/libc (`glibc` vs `linuxmusl`) uyumlu `dist/node_modules/better-sqlite3/prebuilds/<hedef>-<arch>.node`, `dist/typescript-lib/lib.es2022.full.d.ts`, 4 `native/` worker kaynağı ve derlenmiş `Causoryn.RoslynWorker.dll` varlığını (varsa `~/.causoryn/runtime` üzerinde de) kontrol eder.
3. **Sidecar araç zincirleri (`toolchains`):** `dotnet --version`, `python --version` (POSIX'te `python` yoksa `python3 --version` fallback'i), `go version` ve `cargo --version` komutlarını `shell: false`, 5 sn zaman aşımı ve daraltılmış `DOCTOR_PROBE_ENV_ALLOWLIST` + `PYTHONIOENCODING=utf-8` ile yoklar. Eksik bir sidecar araç zinciri sunucuyu sağlıksız (`UNHEALTHY`) yapmaz; ilgili dil için dürüstçe `l0-l1-fallback` raporlar.
4. **Host hizalaması (`hosts`):** Her host'un konfigürasyon sözdizimini (JSON/TOML), `causoryn` MCP giriş betiğinin diskte var olup olmadığını (`entrypointExists`) ve 5 kanonik skill dosyasını denetler (`ok`, `warn`, `not-configured`, `error`).

**Çıkış kodları:** `0` = sağlıklı (`healthy: true`), `1` = Node.js, runtime veya hedeflenen host'lardan birinde `error` mevcut (`healthy: false`), `2` = geçersiz CLI argümanı.

### 1.3 `causoryn mcp` — Sıfır-Ayar MCP `stdio` Sunucusu

`causoryn mcp` çağrıldığında `scripts/causoryn.mjs` `stdout`'a tek bir karakter bile yazmadan doğrudan `dist/mcp-server.mjs` (`cli-stdio.ts`) modülüne devir yapar.

| Bayrak | Açıklama |
|---|---|
| `--allow-cwd` | Açık `--root` veya `CAUSORYN_CONFIG.allowRoots` verilmemişse başlangıç `process.cwd()` dizinini güvenlik filtresinden (`inspectProjectRootSafety`) geçirerek bağlar; reddedilirse dinamik MCP `roots/list` bağlayıcısını etkinleştirir. |
| `--root <path>` | Yetkili çalışma alanı kökünü açıkça belirler (birden fazla kez verilebilir; `CAUSORYN_CONFIG.allowRoots` değerini ezer). |
| `--auto-data-dir` | Yetkili kök için workspace dışında izole SQLite (`storage.dataDbPath` + `wiki.dataDbPath`) ve `exports/` (`output.allowedOutputDirs`) dizinini otomatik hazırlar. |
| `--data-dir <absPath>` | `--auto-data-dir` temel dizinini (`~/.causoryn` yerine) belirtilen mutlak yola yönlendirir (`--auto-data-dir` bayrağını örtük olarak açar). |
| `--client <id>` | Veri tabanı dosya adını host'a göre ayırır (`graph-<client>.sqlite`; desen: `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`). |
| `--output-schema-profile <full\|omit>` | `tools/list` yanıtında araç başına JSON `outputSchema` gönderimini kontrol eder. Öncelik: `--output-schema-profile` > `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` > (`CLI bayrağı varsa "omit", çıplak başlatmada "full"`). `"omit"` profili host istemcilerde bağlam penceresi (token) tüketimini düşürürken çalışma zamanı zarf doğrulamasını korur. |

### 1.4 `causoryn --version` ve `causoryn --help`

- `causoryn --version` (`-v`, `version`): Paket sürümünü (`0.2.4`) `stdout`'a yazar ve `0` ile çıkar.
- `causoryn --help` (`-h`, `help` veya argümansız `causoryn`): Yardım metnini `stdout`'a yazar ve `0` ile çıkar.

---

## 2. Ön-Yükleme Node.js `>= 24` Koruması ve Plugin Başlatıcısı

### 2.1 `node-version-guard.mjs` (`assertSupportedNodeVersion`)

Hem `scripts/causoryn.mjs` hem de `scripts/plugin-mcp-launcher.mjs`, herhangi bir alt modülü veya native `better-sqlite3` eklentisini yüklemeden **önce** sıfır bağımlılıklı `scripts/lib/node-version-guard.mjs` korumasını çalıştırır:
- Node.js ana sürümü `< 24` ise anında `stderr` kanalına net bir tanı mesajı yazar (`Unsupported Node.js version ... Causoryn requires Node.js >= 24.`), **`stdout` kanalına sıfır bayt yazar** ve çıkış kodu **`2`** ile sonlanır.
- Bu sayede MCP istemcilerinde JSON-RPC `stdout` çerçevelemesi bozulmaz ve N-API sembol hataları yerine anlaşılır sürüm hatası görülür.

### 2.2 `plugin-mcp-launcher.mjs` ve Sürüm Pinleme

Native plugin pazaryerleri (`.claude-plugin/plugin.json`, `.zcode-plugin/plugin.json`, `packages/causoryn/mcp_config.json`) iç içe `npx` alt-süreci açmak yerine doğrudan `scripts/plugin-mcp-launcher.mjs` betiğini çağırır:
- `--expected-version <semver>` bayrağını ve/veya `CAUSORYN_EXPECTED_VERSION` ortam değişkenini okur.
- Hem bayrak hem ortam değişkeni tanımlıysa ve birbirinden farklıysa çelişen sürüm pini nedeniyle `stderr` + `exit 2` ile fail-closed durur.
- Kurulu `package.json` içindeki `name === "causoryn"` ve `version === expectedVersion` eşliğini doğrular; uyuşmazlıkta önbellekte kalmış bayat bir plugin kopyasını sessizce çalıştırmak yerine `exit 2` döner.
- `CAUSORYN_ASSET_ROOT` tanımlı değilse paket köküne bağlar ve kalan argümanları (`mcp --allow-cwd --auto-data-dir ...`) saf `stdout` disipliniyle `dist/mcp-server.mjs`'e aktarır.

---

## 3. Sıfır-Ayar Çalışma Alanı Keşfi ve Güvenlik Modeli

### 3.1 Çıplak `stdio` vs CLI Etkinleştirmesi

- **Çıplak başlatma (`node dist/mcp-server.mjs`, 0 argüman):** Geriye dönük uyumluluk ve güvenli varsayılan (`default-deny`) korunur. `CAUSORYN_CONFIG` verilmemişse `allowRoots: []` ve `outputSchemaProfile: "full"` ile başlar; tüm çalışma alanı araçları `WORKSPACE_NOT_AUTHORIZED` döner.
- **Sıfır-ayar başlatma (`causoryn mcp --allow-cwd --auto-data-dir`):** Terminal tabanlı ajanlar proje dizininden başlatıldığında `process.cwd()` adayı `inspectProjectRootSafety` denetiminden geçirilir.

CLI etkinleştirildiğinde (`deferAutoIndex: true`) `autoIndex` açık ve kök yetkiliyse ilk snapshot’ın yüklenmesi veya ilk tam indeksin başlatılması MCP `initialize` el sıkışmasından sonraya ertelenir; böylece büyük depolarda bile MCP başlangıcı bloklanmaz. `causoryn_index_status` ilk işi tetikleyebilir ve durumu raporlar. Snapshot gerektiren ilk araç çağrıları arka plan işini 15 saniyeye kadar bekleyebilir. `initialize` yanıtı indeksin hazır olduğu anlamına gelmez. Başlatma yolunu `packages/mcp-server/src/{cli-stdio.ts,context.ts}` tanımlar.

Otomatik workspace konfigürasyonu (`buildWorkspaceAutoConfig` + `packages/mcp-server/src/workspace-ignore-discovery.ts`), birincil kökteki `.gitignore`, `.git/info/exclude` ve sınırlı derinlik/bütçeli iç-içe `.gitignore` dosyalarından (derinlik ≤ 6, en fazla 64 dosya, en fazla 4.000 dizin) desteklenen desenleri `extraIgnore` ile birleştirir (sembolik bağlantıları `O_NOFOLLOW` + `(dev, ino)` ile reddeder ve negasyonla çakışabilecek geniş üst dizin desenlerini dışlar). Ayrıca çağıran açıkça `ignore` vermediğinde `buildWorkspaceAutoConfig` kaba `**/bin/**` deseni yerine yalnızca `.NET` çıktı dizinlerini (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` ve tespit edilen `.csproj`/`.fsproj`/`.vbproj` altındaki `<proje>/bin/**`) dışlar; böylece Node `bin/*.ts|js` ve Rust `src/bin/*.rs` kaynakları indekslenmeye devam eder. Glob eşleştiricisi polinom zamanlı sıfır-RegExp iki-işaretçi motoru (`ignore-matcher.ts`) kullanır. [Dil Analizörleri](language-analyzers.md)

### 3.2 `inspectProjectRootSafety` — Reddedilen Güvensiz Kökler

Bir aday dizin (`--allow-cwd` veya MCP `roots/list` `file://` URI'si) `realpathSync` ile gerçek yoluna çözümlenir (Windows `\\?\` önekleri temizlenir) ve aşağıdaki kategorilerden herhangi birine girerse **kesinlikle yetkilendirilmez**:

1. **Boş, `\0` (null byte) içeren, çözümlenemeyen veya dizin olmayan yollar.**
2. **Dosya sistemi kökleri:** `/`, `C:\` vb. (`path.parse(real).root === real`).
3. **Kullanıcı ev dizini (`$HOME` / `%USERPROFILE%`):** Masaüstü IDE'lerin varsayılan çalışma dizini olarak `$HOME` vermesi durumunda tüm kullanıcı diskini indekslemeyi engeller.
4. **Causoryn veri dizinleri ve alt dizinleri:** `~/.causoryn`, `ZCODE_PLUGIN_DATA`, `--data-dir`.
5. **Plugin, bundle ve geçici kurulum dizinleri:** `~/.causoryn/runtime`, `~/.gemini`, `~/.antigravity`, `~/.claude/plugins`, `~/.zcode/plugins`, `~/.codex/plugins`, `~/.agents/plugins`, `CLAUDE_PLUGIN_ROOT`, `ZCODE_PLUGIN_ROOT`, yolunda `node_modules` veya `_npx` segmenti bulunan dizinler ve monorepo kaynak kökü olmayan `bundle-manifest.json` / `causoryn` plugin dizinleri.
6. **Hassas kullanıcı dizinleri:** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`.
7. **İşletim sistemi dizinleri:** POSIX'te `/etc`, `/private/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`; Windows'ta `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` (ve ilgili `SystemRoot`, `WINDIR`, `ProgramFiles`, `ProgramFiles(x86)`, `ProgramData` ortam hedefleri).

### 3.3 Masaüstü IDE'ler için Dinamik MCP `roots/list` Bağlayıcısı

Masaüstü IDE'ler (Antigravity, ZCode GUI, Codex Desktop vb.) MCP sunucusunu çoğu zaman `$HOME`, `/` veya plugin kurulum dizininden başlatır. `--allow-cwd` etkin olduğunda ve açık `--root` / `CAUSORYN_CONFIG.allowRoots` verilmediğinde `attachMcpRootsWorkspaceBinder` devreye girer:

1. Başlangıç `cwd` güvensizse sunucu çökmez; `allowRoots: []` ile güvenli bekleme modunda açılır.
2. `oninitialized` bildiriminde, ilk araç çağrısı öncesinde (`beforeToolCall`) ve istemci `notifications/roots/list_changed` gönderdiğinde single-flight kilidiyle `server.listRoots()` (varsayılan 5.000 ms zaman aşımı) çağrılır.
3. İstemcinin bildirdiği `file://` kökleri sırayla `inspectProjectRootSafety` filtresinden geçirilir; **ilk güvenli proje kökü** seçilerek `DynamicCausorynContext.rebind()` ile aktif bağlam (ve `--auto-data-dir` açıksa ilgili SQLite/export dizini) atomik olarak değiştirilir ve önceki SQLite bağlantıları kapatılır.
4. İstemci tüm güvenli kökleri kaldırırsa bağlam güvenli `allowRoots: []` durumuna geri döner.

---

## 4. Kaynak Ağacı Dışı Veri Dizini Düzeni (`ADR-008`)

Causoryn kaynak analizi sırasında proje dosyalarını salt okunur işler. Kalıcı graph ve wiki veritabanı yolları yetkili çalışma alanı köklerinin dışında olmalıdır. Aşağıdaki düzen varsayılan veri ve derleme önbelleği yollarını gösterir. Elle yapılandırılan `output.allowedOutputDirs`, çalışma alanıyla örtüşen bir dizinde de açıkça dışa aktarıma izin verebilir.

```text
~/.causoryn/                                    # Temel dizin (--data-dir veya ZCODE_PLUGIN_DATA ile değiştirilebilir)
├── runtime/                                    # Geçici _npx kurulumlarından atomik sahnelenen kalıcı çalışma zamanı
│   ├── package.json
│   ├── scripts/{causoryn.mjs,plugin-mcp-launcher.mjs,lib/node-version-guard.mjs}
│   ├── dist/{mcp-server.mjs,bundle-manifest.json,node_modules/better-sqlite3,typescript-lib}
│   ├── native/{roslyn-worker,python-worker,go-worker,rust-worker}
│   └── skills/{causoryn,map-system,preflight-change,verify-change,architecture-blueprint}
├── workspaces/
│   └── <slug>-<hash12>/                        # POSIX izin modu: 0o700 (slug + kanonik kök SHA-256 ilk 12 hex)
│       ├── graph-<client>.sqlite               # storage.dataDbPath + wiki.dataDbPath (--client yoksa graph.sqlite)
│       └── exports/                            # POSIX izin modu: 0o700 (output.allowedOutputDirs hedefi; örn. causoryn-architecture-interactive.html)
└── cache/
    └── rust-worker-target/                     # Rust sidecar derleme önbelleği (CAUSORYN_RUST_TARGET_DIR)
```

- **Temel veri dizini önceliği (`resolveBaseDataDir`):** `--data-dir <mutlak-yol>` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`.
- **`mkdirSync` öncesi ve sonrası güvenlik doğrulaması:** Veri dizinleri oluşturulmadan **önce** tüm önek/ata dizinler taranır; sembolik bağlantılar (`CWE-59`; macOS sistem firmlink'leri `/var`, `/tmp`, `/etc` hariç), dangling symlink'ler ve yetkili `allowRoots` içine düşen yollar `CausorynConfigError` ile reddedilir. Oluşturma sonrasında `realpathSync` ile TOCTOU doğrulaması tekrarlanır.
- **Geçici `_npx` çalışma zamanı sahnelemesi (`stagePersistentRuntime`):** `npx causoryn@latest setup` (veya sabitlenmiş `npx causoryn@0.2.4 setup`) geçici bir `_npx`, `.npx` veya `os.tmpdir()` dizininden çalıştırıldığında paket içeriği `~/.causoryn/.runtime-stage-<pid>-<ts>` altına kopyalanıp atomik `renameSync` (hata anında `.runtime-prev-*` geri alma korumasıyla) ile `~/.causoryn/runtime` dizinine sahnelenir. Böylece npm önbelleği temizlense bile host konfigürasyonlarındaki giriş yolu kırılmaz.

---

## 5. `CAUSORYN_CONFIG` Tam JSON Şeması

`CAUSORYN_CONFIG` ortam değişkeni JSON dizgesi olarak ayrıştırılır ve `causorynServerConfigSchema` (`z.strictObject`) ile doğrulanır.

> **Önemli (`z.strictObject` disiplini):** Şema bilinmeyen anahtarları fail-closed reddeder. Örneğin uzantı filtre modu anahtarı tam olarak `extensionFilterMode`, dosya sayısı sınırı `index.maxFiles` ve dışa aktarım izin listesi `output.allowedOutputDirs` olarak yazılmalıdır (`extensionMode`, `maxFiles` kök alanı veya `outputAllowRoots` gibi şema dışı adlar `CausorynConfigError` ile reddedilir).

### 5.1 Örnek Tam Konfigürasyon

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
  }
}
```

### 5.2 Alan Referans Tablosu

| Alan | Tür | Varsayılan | Doğrulama ve Davranış Kuralı |
|---|---|---|---|
| `workspaceId` | `string` (`min(1)`) | `"default"` (`--auto-data-dir` ile `<slug>`) | Sunucunun tek yetkili çalışma alanı kimliği. |
| `allowRoots` | `string[]` | `[]` | Mutlak dizin yolları (`\0` içeremez). Boş liste = tüm workspace araçları `WORKSPACE_NOT_AUTHORIZED` döner. Aktif kök `allowRoots[0]`'dır. |
| `ignore` | `string[]` | 38 standart desen (`DEFAULT_IGNORE_PATTERNS`, 7 TŞ §20 deseni dahil) | `**/.git/**`, `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/dist/**`, `**/.env*`, `**/*.pem` + ekosistem derleme/sanal-ortam/önbellek dizinleri (`vendor`, `Pods`, `.next`, `.venv`, `target`, `.gradle`, `.vite`, `*.min.js` vb.). Otomatik yapılandırma açık `ignore` verilmediğinde akıllı `bin/` ayrımı uygular. |
| `extraIgnore` | `string[]` | `[]` | `ignore` listesini ezmeden üzerine eklenen ek dışlama glob desenleri. |
| `binaryExtensions` | `string[]` | 68 ikili/ML/sourcemap uzantısı (`DEFAULT_BINARY_EXTENSIONS`) | `.png`, `.pdf`, `.zip`, `.exe`, `.dll`, `.so`, `.dylib`, `.pyc`, `.wasm`, `.sqlite`, `.db`, `.map`, `.whl`, `.parquet`, `.onnx`, `.pt`, `.safetensors`, `.gguf` vb. küçük harfe normalize edilir. |
| `extensionFilterMode` | `"blacklist" \| "whitelist"` | `"blacklist"` | `"blacklist"` modunda `binaryExtensions` reddedilir; `"whitelist"` modunda yalnızca `allowedExtensions` kabul edilir. |
| `allowedExtensions` | `string[]` | `[]` | `"whitelist"` modunda izinli uzantılar (`^\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+$`). |
| `maxFileBytes` | `number` (pozitif tam sayı) | `2_000_000` (2 MB) | Tek kaynak dosyası bayt tavanı; aşım durumunda `LIMIT_EXCEEDED` döner. |
| `index.maxFiles` | `number` (pozitif tam sayı) | `50_000` | Envanterdeki maksimum dosya sayısı tavanı. |
| `results.maxNodes` | `number` (pozitif tam sayı) | `250` | `causoryn_map_system` sayfa başına node tavanı. |
| `results.maxSymbols` | `number` (pozitif tam sayı) | `100` | `causoryn_find_symbols` sonuç tavanı. |
| `results.maxDepth` | `number` (pozitif tam sayı) | `3` | `causoryn_get_symbol_context` komşuluk derinliği tavanı. |
| `results.maxPaths` | `number` (pozitif tam sayı) | `50` | `causoryn_trace_execution` maksimum iz yolu tavanı. |
| `autoIndex` | `boolean` | `true` | Yetkili kökte varsa mevcut kalıcı snapshot kullanılır. İlk indeks, CLI etkinse (`deferAutoIndex`) MCP başlatmasından sonraya ertelenir. Çıplak konfigürasyon yolunda indeksleme senkron çalışabilir. `false` ise otomatik indeks işi başlatılmaz. |
| `output.allowedOutputDirs` | `string[]` | `[]` | `causoryn_export_documentation` için yazma izni olan mevcut dizinler ve alt dizinleri (`view: "interactive"` varsayılan dosya adı `causoryn-architecture-interactive.html`, `view: "architecture"` için `causoryn-architecture.html`). Boşsa `EXPORT_NOT_ALLOWED` döner. Açık izin listesi `allowRoots`’tan bağımsızdır (`OutputAccessPolicy`). [Prompting ve Portallar](prompting-and-architecture-portals.md) |
| `storage.dataDbPath` | `string` (opsiyonel) | `undefined` (`InMemoryGraphRepository`) | Kalıcı SQLite graph + `symbol_fts` dosya yolu. Mutlak olmalı, üst dizini mevcut olmalı ve hem sözcüksel hem `realpath` olarak tüm `allowRoots` dışında kalmalıdır (`ADR-008`). Tanımlıysa çoklu-süreç yarış kurtarması (`tolerateConcurrentPublishRace`) açılır. |
| `wiki.dataDbPath` | `string` (opsiyonel) | `undefined` (`PATH_DENIED` / `INDEX_NOT_READY`) | Living Wiki SQLite (`SqliteWikiStore` + `wiki_fts`) dosya yolu. `storage.dataDbPath` ile aynı güvenlik kurallarına tabidir ve aynı SQLite dosyasını paylaşabilir. |

> **Programatik Sidecar Seçenekleri (`IndexServiceOptions`):** Kütüphane düzeyinde `IndexService` oluşturulurken `csharp` (`dotnetCommand`, `requestTimeoutMs`, `workerDllPath`), `python` (`pythonCommand`, `requestTimeoutMs`, `workerScriptPath`), `go` (`goBinaryPath`, `goWorkerBinaryPath`, `workerDir`, `requestTimeoutMs`) ve `rust` (`workerDir`, `cargoHomeDir`, `requestTimeoutMs`, `cargoBuildTimeoutMs`) seçenekleri doğrudan geçirilebilir; MCP `CAUSORYN_CONFIG` yüzeyinde ise sidecar yolları aşağıdaki ortam değişkenleriyle kontrol edilir.

---

## 6. Ortam Değişkenleri Başvuru Tablosu

| Ortam Değişkeni | Okuyan Katman | Amaç ve Varsayılan Davranış |
|---|---|---|
| `CAUSORYN_CONFIG` | `mcp-server` (`stdio.ts`, `cli-stdio.ts`) | JSON formatında sunucu konfigürasyonu. CLI bayraklarıyla birlikte verildiğinde taban ayarları sağlar (`--root` ve `--auto-data-dir` ilgili alanları tamamlar/ezer). |
| `CAUSORYN_MCP_OUTPUT_SCHEMA_PROFILE` | `mcp-server` (`runtime-cli.ts`) | `full` veya `omit`. `--output-schema-profile` bayrağı verilmediğinde `tools/list` şema profilini belirler. |
| `CAUSORYN_EXPECTED_VERSION` | `plugin-mcp-launcher.mjs` | Plugin başlatıcısında beklenen tam `causoryn` paket sürümünü pinler; uyuşmazlıkta `exit 2`. |
| `CAUSORYN_ASSET_ROOT` | `sidecar-ipc`, `causoryn.mjs`, `plugin-mcp-launcher.mjs` | `native/` worker kaynaklarını barındıran paket/repo kök dizinini açıkça belirtir. |
| `CAUSORYN_TS_LIB_DIR` | `adapters/typescript` | Yerleşik TypeScript `lib.*.d.ts` (`lib.es2022.full.d.ts`) bildirim dosyalarının okunacağı dizini override eder. |
| `CLAUDE_CONFIG_DIR` | `causoryn` (`setup`, `doctor`) | Claude Code yapılandırma kökünü (`~/.claude.json` ve `~/.claude/skills/` yerine `$CLAUDE_CONFIG_DIR/.claude.json` ve `$CLAUDE_CONFIG_DIR/skills/`) değiştirir. |
| `CODEX_HOME` | `causoryn` (`setup`, `doctor`) | Codex yapılandırma dizinini (`~/.codex/config.toml` yerine `$CODEX_HOME/config.toml`) belirler. |
| `ZCODE_PLUGIN_DATA` | `mcp-server` (`runtime-cli.ts`) | `--data-dir` verilmediğinde `--auto-data-dir` için temel veri dizinini (`~/.causoryn` yerine) belirler; ayrıca `inspectProjectRootSafety` tarafından proje kökü olmaktan dışlanır. |
| `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` | Host plugin yükleyicileri & `runtime-cli.ts` | Host pazaryeri manifestlerinde launcher yolunu çözer; `inspectProjectRootSafety` bu dizinlerin yanlışlıkla proje kökü seçilmesini engeller. |
| `DOTNET_ROOT` | `adapters/csharp-roslyn`, `native/roslyn-worker`, `indexing` | `.NET` runtime ve `Microsoft.NETCore.App.Ref` / `Microsoft.AspNetCore.App.Ref` keşif kökü (`fp2` `refsrc=env-dotnet-root`). |
| `CAUSORYN_ROSLYN_WORKER_DLL` | `adapters/csharp-roslyn`, `indexing` | Derlenmiş `Causoryn.RoslynWorker.dll` mutlak yolunu override eder. |
| `CAUSORYN_PYTHON_WORKER_SCRIPT` | `adapters/python`, `indexing` | `native/python-worker/worker.py` betik yolunu override eder. |
| `CAUSORYN_GO_WORKER_BIN` | `adapters/go`, `indexing` | Önceden derlenmiş Go worker ikilisinin yolunu belirtir (`go run ./cmd/worker` adımını atlar). |
| `CAUSORYN_GO_WORKER_DIR` | `adapters/go`, `indexing` | `native/go-worker` modül dizinini override eder. *(Not: Çalışma zamanında `go` derleyici komutu `PATH` üzerinden `"go"` sabitiyle veya programatik `go.goBinaryPath` seçeneğiyle çözülür; `CAUSORYN_GO_BINARY` yalnızca Go adapter test süitinde özel Go ikilisi yoklaması için kullanılan test yardımcısı değişkenidir.)* |
| `CAUSORYN_RUST_WORKER_DIR` | `adapters/rust`, `indexing` | Derlenmiş `causoryn-rust-worker` ikilisini içeren dizini override eder. |
| `CAUSORYN_RUST_TARGET_DIR` | `adapters/rust` | Salt-okunur paket kurulumlarında `cargo build --locked` derleme hedef dizinini (`~/.causoryn/cache/rust-worker-target` yerine) belirler. |
| `CAUSORYN_CARGO_HOME` | `adapters/rust` | `cargo` ikilisini bulmak için child `PATH` başına eklenecek dizini (`~/.cargo/bin` yerine, meta-karakter filtresinden geçirerek) belirler. |

---

## İlgili Belgeler

- [Dokümantasyon Merkezi](README.md) · [Mimari Özeti](architecture.md)
- [Prompt ve Mimari Portal Rehberi](prompting-and-architecture-portals.md)
- [5-Dil Analizörleri ve Sidecar Protokolü](language-analyzers.md) · [MCP Araç Sözleşmeleri](tool-contracts.md)
- [Host Kurulum Rehberleri: Antigravity](hosts/antigravity.md) · [Claude Code](hosts/claude-code.md) · [Codex](hosts/codex.md) · [ZCode (GLM)](hosts/zcode.md)
- [Güvenlik Denetimi](security-pass.md) · [Host Uyumluluk Matrisi](compatibility-matrix.md)
