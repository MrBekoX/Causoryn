# Causoryn Mimari Özeti (kod-face)

> Kanıt: TŞ v2.1 §3, §5, §6, §8, §9, §10, §25 · Ayna sayfa: [wiki/architecture.md](../wiki/architecture.md)
> Bu sayfa kod yazan ajan/kullanıcı içindir: repodaki paketler ile TŞ'nin istediği mimari arasındaki eşlemeyi gösterir.
> Durum notu: bu belge Sprint-1 Faz A iskelet dilimini yansıtır; "planlanan" işaretli her şey henüz implementasyon DEĞİLDİR (ADR-010).

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
| `packages/domain` | Graph/Evidence sözleşmeleri, canonical JSON, deterministik ID | §8 | Kısmi: tipler + ID üretimi var, Zod şemaları görev 3'te |
| `packages/workspace` | Workspace Gateway: trusted roots, inventory, ignore, symlink escape, binary/size filtresi | §5, §9, §25/2 | İskelet (görev 2) |
| `packages/indexing` | IndexCoordinator: pipeline orkestrasyonu, invalidation, atomic publish | §9, §25/4-5 | İskelet (görev 4-5) |
| `packages/graph` | Snapshot üzerinden okuma sorguları, traversal, cursor | §8, §9 | İskelet (görev 5) |
| `packages/storage-sqlite` | SQLite + FTS5 store, migration, atomic snapshot | §9 | İskelet (görev 5) |
| `packages/mcp-server` | stdio transport, input validation, authorization, ApplicationService yönlendirme | §5, §10 | İskelet (görev 6-7) |
| `adapters/typescript` | Compiler API AST + symbol resolution (hedef L1/L2) | §6, §7, §25/4 | İskelet (görev 4) |
| `integrations/zcode/causoryn` | ZCode plugin paketi (mcpServers + skills) | §17, §25/8, K-002 | İskelet (görev 8) |
| `examples/fixture-ts-orders` | İlk TS fixture: POST /orders → OrdersService → repository | §22, §25/4 | İskelet (görev 4) |
| `tests/` | Entegrasyon + smoke testleri (kök Vitest projesi) | §22 | smoke.test.ts mevcut |

Faz A'da bilinçli olarak OLUŞTURULMAYAN paketler (TŞ §18 sonu ilkesi — ilk gün boş paket
kurma yok): `contracts`, `preflight`, `verification`, `wiki`, roslyn sidecar. Bunlar
sonraki sprint dilimlerinde, gerçek implementasyonla birlikte açılır.

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
| MCP | `@modelcontextprotocol/sdk` resmî SDK (2026-07-28 spec) | ^1.32.2 (packages/mcp-server) |
| Validasyon | Zod + JSON Schema | zod ^4 (packages/domain — görev 3'te) |
| TS analizi | TypeScript Compiler API + symbol resolution | adapters/typescript (görev 4) |
| Graph store | SQLite + FTS5, WAL | better-sqlite3 ^13 + @types/better-sqlite3 (packages/storage-sqlite) |
| Git | Salt okunur CLI/library; checkout/reset/clean yasak | — |
| Test | Vitest + fixture/golden + MCP integration | vitest 5.0.5 |
| Lint | typescript-eslint recommended | eslint ^10 + typescript-eslint ^8.72.1 |

Sürüm politikası (TŞ §6): SDK/paket sürümleri implementasyon başında yeniden doğrulanır;
istikrarsız/transitif paketler kilitlenir. TypeScript 5.9.3 kasıtlı olarak kilitlidir:
typescript-eslint 8.72.1 `typescript >=4.8.4 <6.1.0` bekler (npm view, 2026-11-02);
TypeScript 7 native serisi bu aralıkta değildir.

## Build/typecheck/test sözleşmesi

- `npm run test` → Vitest (packages/adapters/integrations/tests altındaki tüm `*.test.ts`)
- `npm run build` → `tsc -b` (kök solution `tsconfig.json` referansları, 7 proje)
- `npm run typecheck` → `tsc -p tsconfig.typecheck.json` (noEmit; src + test + config'ler)
- `npm run lint` → ESLint flat config (typescript-eslint recommended; dist/node_modules/raw/wiki ignore)
- Module çözümleme: NodeNext — bu yüzden tüm relative importlar `.js` ekiyle yazılır.
