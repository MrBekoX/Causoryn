# Causoryn Mimari Özeti (kod-face)

> Kanıt: TŞ v2.1 §3, §5, §6, §8, §9, §10, §16A, §17, §25 · Ayna sayfa: [wiki/architecture.md](../wiki/architecture.md)
> Bu sayfa kod yazan ajan/kullanıcı içindir: repodaki paketler ile TŞ'nin istediği mimari arasındaki eşlemeyi gösterir.
> Durum notu: bu belge Sprint-8 çok-dil genişlemesi ve 2026-11-18 denetim senkronu
> sonundaki kod halini yansıtır (`v0.1.0` public snapshot, HEAD `d197f21` + denetim
> güncellemeleri; toplam **16 npm workspace paketi**: `10 packages/*` + `5 adapters/*`
> + `1 integrations/zcode/causoryn`, ayrıca standalone `apps/visualizer`, 4 `native/*`
> sidecar ve `integrations/antigravity/causoryn` eklenti dizini); durum kolonları
> [docs/implementation-status.md](implementation-status.md) kanıtlarıyla ADR-010
> dürüstlük kuralına tabidir.

## Pipeline

```
Workspace Gateway → File Inventory → Language/Framework Adapters → Normalization
  → Symbol/Contract Resolution → Unified Evidence Graph → Immutable Snapshot
  → Domain Queries → MCP structuredContent → Host-selected model
```

Kaynak: TŞ v2.1 §5. Analizin tamamı yerel ve deterministiktir; graph/storage katmanında
AI/LLM bağımlılığı yoktur (ADR-002, bkz. [docs/adr/ADR-002-no-llm.md](adr/ADR-002-no-llm.md)).

## Paket ↔ sorumluluk eşlemesi (bu repodaki hâliyle)

| Paket | Rol | TŞ kaynak | Durum |
|---|---|---|---|
| `packages/domain` | Graph/Evidence sözleşmeleri, Zod şemaları, canonical JSON, deterministik ID | §8 | Done: 27 node + 20 edge türü, verified kenar ≥1 evidence |
| `packages/workspace` | Workspace Gateway: trusted roots, inventory, ignore, symlink escape, binary/size filtresi, OutputAccessPolicy | §5, §9, §25/2 | Done (53 test; fail-closed policy) |
| `packages/indexing` | IndexCoordinator: 5-dil pipeline orkestrasyonu (TS in-process + C#/Python/Go/Rust sidecar yönlendirme, `INDEXED_ADAPTERS` 5 kayıt), job manager, watcher (in-process), fingerprint fp2 | §9, §25/4-5 | Done; **B7 Partial kalıntısı**: per-file parse reuse yok, watcher MCP aracı değil, `refresh_index mode=incremental` açık ret |
| `packages/graph` | Snapshot sorguları, traversal/cursor, impact, guard (policy DSL), compare/timeline (salt-okunur git), export/onboarding/agent-context, evidence chain | §8, §9, §12, §13, §15, §16 | Done (belgeli sınırlar: blob üreticisi yok — compare/timeline elle yazılmış blob ile çalışır) |
| `packages/storage-sqlite` | SQLite + FTS5 store, migration, atomic snapshot + WikiStore (wiki_* şeması, FTS/alias indeksleri, annotation CAS) | §9, §16A.7 | Done |
| `packages/contracts` | Salt-okunur sözleşme keşfi: OpenAPI/AsyncAPI/SQL/JSON Schema/protobuf + parse güvenlik kotaları (1 MiB/derinlik/alias) + compatibility/drift çekirdeği | §11, §10.2 | Done (belgeli sınır: openapi keşfi yalnızca istek şeması — yanıt-şeması drift yüzeyde görünmez, K-015(5)) |
| `packages/preflight` | candidate-only Preflight Manifest (candidateOnly sabit true — kod yazmaz) + derive_test_plan (direct/call-site/naming) | §10.2/§10.3, §15 | Done (belgeli sınır: adapter'lar TESTS kenarı üretmez → direct sinyal gerçek graph'ta dormant) |
| `packages/verification` | verify_change saf çekirdeği: 4 denetim, 8-kuralı verdict zinciri, test durumu dürüstlüğü (not_run/observed+kanıt), byte-deterministik rapor | §10.4 | Done (E3 `passed` doğrulaması host beyanı üzerinden — K-016(3)) |
| `packages/wiki` | Living Wiki projeksiyonu: link çözümleme (11 tür), FTS5 arama, incremental invalidation, annotation overlay (CAS), offline markdown+HTML export | §16A | Done (link-düzeyi invalidasyon sınırlı — mcp-server incremental yayımı indeksleri tam graph'tan yeniden yazar) |
| `packages/mcp-server` | stdio transport, input validation, authorization, 29 araç kablolaması + MCP `annotations` (`readOnlyHint`), 10 alanlı envelope + sabit hata kodları, bundle girişi (F1) | §5, §10 | Done (`tools/list` TAM OLARAK 29 araç; SDK 1.32.2 v1.x — K-009 sapması) |
| `adapters/typescript` | Compiler API AST + symbol resolution + framework linkers (Express/Next.js) (L1/L2) | §6, §7, §25/4 | Done (cross-file receiver etiket sınırı belgeli) |
| `adapters/csharp-roslyn` | Roslyn worker TS adapter: spawn (`dotnet exec`), istek/yanıt, timeout, graceful fallback | §7 | Done (worker yok → L0/L1 + açık coverage) |
| `adapters/python` | Python stdlib `ast` sidecar TS adapter: `python -B` spawn, satır-JSON protokol v1, timeout, L0/L1 fallback | §7, §23 | Done (`decorator-route-pattern (L3)`; aynı modül `verified`, import `heuristic`) |
| `adapters/go` | Go `go/parser`+`go/ast` sidecar TS adapter: `go run` / `goWorkerBinaryPath`, 120 sn timeout, L0/L1 fallback | §7, §23 | Done (`heuristic-only (semantik L2 yok)`, `SymbolResolution:false`; L3 HTTP/router kayıtları) |
| `adapters/rust` | Rust `syn 2` sidecar TS adapter: literal `cargo` build + worker spawn, framing/timeout, L0/L1 fallback | §7, §23 | Done (`heuristic-heavy`; L3 attribute-macro route tespiti) |
| `apps/visualizer` | Offline HTML+SVG viewer üretici: sıfır bağımlılık, inline CSS/JS, kısıtlayıcı CSP, resolution renk ayrımı, selection→evidence paneli | §16 | Done (gerçek tarayıcı koşusu yok — DOM-düzeyi vitest + statik inceleme; viewer HTML'i izinli output'a yazan MCP yüzeyi kapsam dışı) |
| `native/roslyn-worker` | C# Roslyn sidecar (stdin/stdout protokol; derleme-regresyon disiplini: build başarısızlığı sessiz geçilmez) | §7, §23/B1 | Done (dotnet 10 koşumlarıyla; platform matrisi Windows-düzeyi doğrulanmış) |
| `native/python-worker` | Python saf stdlib `ast` sidecar (`worker.py`, sıfır dış bağımlılık, satır-JSON protokol v1 + `PROTOCOL.md`) | §7, §23 | Done |
| `native/go-worker` | Go stdlib `go/parser`+`go/ast` sidecar (`cmd/worker`, satır-JSON protokol v1 + `PROTOCOL.md`) | §7, §23 | Done |
| `native/rust-worker` | Rust `syn 2` + `serde_json` Cargo sidecar (`causoryn-rust-worker`, satır-JSON protokol v1 + `PROTOCOL.md`) | §7, §23 | Done |
| `integrations/zcode/causoryn` | ZCode plugin paketi: `.zcode-plugin/plugin.json` (mcpServers + userConfig) + skills + dev marketplace (`.claude-plugin/marketplace.json`) | §17, §25/8, K-002 | Done (manifest doğrulama; GUI kurulum koşulmadı — kırmızı kural 6) |
| `integrations/antigravity/causoryn` | Antigravity eklenti dizini: `plugin.json` (`$schema`'sız yerel yükleyici uyumlu) + `mcp_config.json` (birincil yerel yükleyici tanımı) + `mcp.json` (TŞ §17.1 taşınabilir manifest) + `README.md` + `build:bundle` ile sahnelenen `scripts/mcp-server.mjs` (+ vendored `better-sqlite3`) | §17.1, §22 | Partial — doğrudan `stdio` spawn doğrulandı (29 araç); `agy` CLI yok: kurulum/smoke NOT RUN; `skills/`/`agents/`/`rules/`/`hooks.json` ayrı dilim |
| `examples/fixture-ts-orders` · `examples/fixture-ts-express` · `examples/fixture-ts-nextjs` · `examples/fixture-csharp-orders` · `examples/fixture-contract-drift` · `examples/fixture-python-app` · `examples/fixture-go-app` · `examples/fixture-rust-app` | 8 deterministik dil ve sözleşme-drift fixture'ı (TS×3, C#, Python, Go, Rust, contract-drift) | §22, §25/4 | Done |
| `tests/` | Entegrasyon + smoke + güvenlik (F6) + benchmark (F7) + secret-scan + host/release doküman doğrulama testleri (kök Vitest projesi) | §22 | Done (78 `*.test.ts` dosyası; varsayılan süit 77 dosya, `tests/bench-release` ayrık; detay implementation-status'ta) |

Toplam monorepo envanteri: **16 npm workspace paketi** (`10 packages/*` + `5 adapters/*` +
`1 integrations/zcode/causoryn`), standalone `apps/visualizer`, 4 `native/*` sidecar
ve `integrations/antigravity/causoryn` eklenti dizini. TŞ §18 sonu ilkesi (ilk gün
boş paket kurma yok) aynen işledi: `contracts`, `preflight`, `verification`, `wiki`
ve dört sidecar worker, gerçek implementasyonla birlikte açıldı (Faz B1, C2, D, E ve
Sprint-8); yukarıdaki tablo bu paketlerin bugünkü sorumluluklarını ve belgeli
sınırlarını taşır.

## Bağımlılık sınırları (değimez — TŞ §5.1)

1. `packages/domain` hiçbir MCP/adapter/host paketini import etmez.
2. Adapter'lar dil adapter interface'lerine bağlanır; bir adapter çökerse motor çökmez.
3. `packages/mcp-server` yalnızca ApplicationService arayüzlerini tüketir; parser detayı
   tool handler'a sızmaz.
4. Görselleştirme graph JSON'u render eder; yeni edge/kanıt icat etmez.
5. Plugin skill/rule metni host modeli yönlendirir; host modelini değiştiremez.

## Graph domain sözleşmesi (özet — TŞ §8)

- **Node türleri:** Workspace, Repository, Project, Module, File, Class, Endpoint, Handler,
  Event, Database, ApiContract, Test, Config, UnknownExternal… (tam katalog TŞ §8)
- **Edge türleri:** CONTAINS, IMPORTS, DECLARES, CALLS, REFERENCES, IMPLEMENTS, INHERITS,
  INJECTS, ROUTES_TO, READS, WRITES, PUBLISHES, SUBSCRIBES, HANDLES, PRODUCES_CONTRACT,
  CONSUMES_CONTRACT, VALIDATES, TESTS, DEPENDS_ON, CONFIGURES (tam katalog TŞ §8)
- **Resolution:** `verified | heuristic | unresolved`. `verified`, çalışma zamanı garantisi
  DEĞİLDİR; doğrulanan şey statik sembol/eşleştirme ilişkisidir.
- **Evidence:** relativePath, startLine/endLine, sourceHash, analyzerId, analyzerVersion,
  rationale taşır (ADR-004 Evidence First: verified kenar ≥1 kanıt).
- **Invariant'lar:** verified kenar ≥1 evidence · dangling edge yok · deterministik ID
  (workspace+relativePath+symbol identity) · immutable snapshot (ADR-005) · aynı
  giriş → aynı Graph JSON · sıralama/cursor deterministik.

## Storage (TŞ §9)

SQLite + FTS5 (WAL uygun olduğunda). Planlanan tablo ailesi: workspaces, files,
file_versions, snapshots, nodes, edges, evidence, contracts, contract_versions, findings,
tests, index_jobs, schema_migrations, symbol_fts ve wiki_* ailesi. Composite indeksler:
(snapshot_id, kind), (snapshot_id, from_id), (snapshot_id, to_id), (snapshot_id,
relative_path). Atomic publish: yeni indeks `building` durumunda hazırlanır; integrity
kontrolünden sonra `ready` veya coverage eksikse `partial` yayımlanır; varsayılan sorgular
en son kullanılabilir snapshot'ı döndürür, eski snapshot `stale=true` ile sorgulanabilir
kalır. Yazma yalnızca izinli data-root'a; kullanıcı workspace'i salt okunurdur (ADR-008).
Tüm SQL sorgularında dış girdiler parametre bağlamasıyla kullanılır; SQL metni asla
dize birleştirmeyle kurulmaz.

## Teknoloji yığını (TŞ §6, bu repodaki kilitli sürümler)

| Alan | Tercih | Bu repoda |
|---|---|---|
| Çekirdek | TypeScript strict, Node.js LTS | TS 5.9.3 (strict), Node ≥24 |
| MCP | `@modelcontextprotocol/sdk` resmî SDK (2026-07-28 spec) | ^1.32.2 (packages/mcp-server) — **v1.x hattı; TŞ §6 SDK v2 hedefine yükseltme yapılamadı (npm install kısıtı), sapma kaydı K-009** |
| Paketleme | Tek-çıktı bundle | esbuild ^0.28.2 (F1; better-sqlite3 external — native .node gömülemez, ADR-010) |
| Validasyon | Zod + JSON Schema | zod ^4 (packages/domain, contracts, wiki, mcp-server) |
| TS analizi | TypeScript Compiler API + symbol resolution | `adapters/typescript` (in-process) |
| Çok-dil sidecar'lar | C# Roslyn, Python `ast`, Go `go/parser`, Rust `syn 2` | `native/roslyn-worker`, `native/python-worker`, `native/go-worker`, `native/rust-worker` + `adapters/*` |
| Graph store | SQLite + FTS5, WAL | better-sqlite3 ^13 + @types/better-sqlite3 (packages/storage-sqlite) |
| Git | Salt okunur CLI/library; checkout/reset/clean yasak | `packages/graph/src/git-read.ts` (`execFile` allowlist: `cat-file`, `ls-tree`) |
| Test | Vitest + fixture/golden + MCP integration | vitest 5.0.5 |
| Lint | typescript-eslint recommended | eslint ^10 + typescript-eslint ^8.72.1 |

Sürüm politikası (TŞ §6): SDK/paket sürümleri implementasyon başında yeniden doğrulanır;
istikrarsız/transitif paketler kilitlenir. TypeScript 5.9.3 kasıtlı olarak kilitlidir:
typescript-eslint 8.72.1 `typescript >=4.8.4 <6.1.0` bekler (npm view, 2026-11-02);
TypeScript 7 native serisi bu aralıkta değildir.

## Build/typecheck/test sözleşmesi

- `npm run test` → Vitest (packages/adapters/integrations/tests altındaki tüm
  `*.test.ts`; **`tests/bench-release/**` hariçtir** — F7 benchmark duvar-saati
  duyarlı performans ölçümüdür, doğruluk kapısı değil; paralel süit yükü altında
  flaky-potansiyellidir)
- `npm run bench` → yalnızca `tests/bench-release/` (`vitest.bench.config.ts`);
  `docs/benchmarks.md` yenileme: `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench`
- `npm run build` → `tsc -b` (kök solution `tsconfig.json` 12 doğrudan referans:
  7 paket (`domain`, `workspace`, `indexing`, `graph`, `storage-sqlite`,
  `mcp-server`, `wiki`) + 5 dil adapter'ı (`typescript`, `csharp-roslyn`, `rust`,
  `python`, `go`); `contracts`/`preflight`/`verification` bu zincirle transitif
  derlenir; `apps/visualizer` ve `integrations/*` vitest/esbuild tarafından
  derlenir; F1 bundle ayrı script: `npm run build:bundle --workspace packages/mcp-server`
  → `dist/mcp-server.mjs` + vendored `better-sqlite3` + `dist/bundle-manifest.json`
  + `integrations/antigravity/causoryn/scripts/` deterministik sahnelemesi — iki build
  bit-bit aynı)
- `npm run typecheck` → `tsc -p tsconfig.typecheck.json` (noEmit; src + test + config'ler)
- `npm run lint` → ESLint flat config (typescript-eslint recommended; dist/node_modules/raw/wiki ignore)
- `npm run secret-scan` → `node scripts/secret-scan.mjs` (7 üretim kökü üzerinde kimlik bilgisi, token ve private-key kalıbı taraması; eşleşmede veya eksik kökte exit 1)
- Module çözümleme: NodeNext — bu yüzden tüm relative importlar `.js` ekiyle yazılır.
