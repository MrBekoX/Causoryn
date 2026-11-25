# @causoryn/adapter-csharp-roslyn — Roslyn Sidecar Worker Adapter (sprint-2 / B2)

> Kanıt: TŞ v2.1 §7 (C#/.NET → "Roslyn sidecar", L2 + controller/minimal API
> L3), §7.1 (adapter arayüzü), §23 (Faz B) · native/roslyn-worker/PROTOCOL.md v1

`native/roslyn-worker/` (B1) sürecini yöneten TypeScript adapter. analyze
başına worker süreci başlatır, satır-bazlı stdin/stdout JSON protokolüyle
konuşur, çıktıyı **packages/domain `createSnapshot` GİRDİ sözleşmesine**
(ID'siz SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput) map
eder — canonical ID / de-duplication / dangling kontrolü merkezi
normalizer'da kalır (TŞ §7.1).

## Süreç yaşam döngüsü ve spawn seçimi

- **Önceden build edilmiş DLL + `dotnet exec`** (`dotnet` + `["exec", <dll>]`)
  seçildi. Gerekçe: `dotnet run` her koşumda kendi build/restore
  orkestrasyonunu çalıştırır (yavaş ve jenerik); worker'ın derlemesi
  kabul testlerinde (tests/roslyn-worker.test.ts) her turda ayrıca
  koşturulup doğrulanıyor (incremental ~2-4 sn) — adapter yalnızca
  kanıtlanmış binary'yi çalıştırır. Komut LİTERAL "dotnet", argümanlar
  SABİT dizidir; fixture içerikleri asla komut satırına gitmez (kırmızı
  çizgi 6) — yalnızca stdin JSON'da taşınır.
- **analyze başına yeni süreç** (long-lived daemon değil): timeout/çökmede
  paylaşılan durum yoktur; **restart politikası = bir sonraki istek taze
  süreçle yürütülür** — kill edilen süreç tek istekle sınırlı olduğundan
  bozuk durum sonraki isteklere sızmaz (TŞ §7 adapter izolasyonu).
- **Per-request timeout**: `requestTimeoutMs` (default 30.000 ms).
  Aşımda süreç `kill()` edilir, analize L0/L1 fallback ile devam edilir.

## Graceful fallback (motor çökmez)

Worker başlatılamazsa / çökerse / zaman aşımına düşerse / sözleşmeye aykırı
yanıt verirse:

- `workerAvailable: false`, `state: "partial"`, `coverageRatio: 0`
- `nodes`: L0/L1 — File node'ları (sourceHash attribute'lu) korunur,
  sembol/kenar üretilmez (uydurma yok)
- `warnings`: explicit sebep ("Roslyn worker kullanılamıyor (...)") +
  "L0/L1 dosya düzeyine düşüldü" + worker stderr başlığı; ayrıca stderr'e
  `[csharp-roslyn-adapter]` önekli log yazılır
- tek dosyadaki girdi sorunu (mutlak yol, `..`, duplicate) DomainError ile
  reddedilir — adapter izolasyonu motorun hata toplayıcısına aittir

## Kullanım

```ts
import { analyzeCSharpWorkspace } from "@causoryn/adapter-csharp-roslyn";
import { createSnapshot } from "@causoryn/domain";
// analyzerFingerprint fp3 kurgusu packages/indexing'ten gelir:
import {
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
} from "@causoryn/indexing";

const result = await analyzeCSharpWorkspace({
  workspaceId: "ws-1",
  files: [{ path: "Controllers/OrdersController.cs", content: "..." }],
  options: { requestTimeoutMs: 30_000 }, // workerDllPath/dotnetCommand da override edilebilir
});

// fp3 (aşağıdaki "KAPATILDI" bölümü): worker healthy yanıttan ref-pack
// keşfi türetilir; keşif bilgisi yoksa nötr etiket kullanılır.
const refPacks = result.workerAvailable
  ? extractRoslynRefPackContext(result.warnings)
  : null;
const analyzerFingerprint = buildAnalyzerFingerprint({
  typescript: null, // TS yoksa null
  csharp: {
    analyzerId: result.analyzerId,
    version: result.analyzerVersion,
    discovery: !result.workerAvailable
      ? "worker-unavailable"
      : refPacks === null
        ? "discovery-unknown"
        : "performed",
    refPacks,
    settings: {
      dotnetCommand: "dotnet",
      requestTimeoutMs: 30_000,
      workerDllPath: "<etkin DLL yolu>",
    },
  },
});

// result.nodes / result.edges / result.evidence → createSnapshot girdisi:
const snapshot = createSnapshot({
  workspaceId: "ws-1",
  revision: { id: "rev-1", sequence: 0 },
  configHash: "...",
  analyzerFingerprint,
  state: result.state,
  createdAt: "<ISO 8601>",
  nodes: result.nodes,
  edges: result.edges,
  evidence: result.evidence,
});
```

## Konfigürasyon

| Seçenek | Default | Not |
|---|---|---|
| `workerDllPath` | repo kökü + `native/roslyn-worker/bin/Debug/net10.0/Causoryn.RoslynWorker.dll` | env `CAUSORYN_ROSLYN_WORKER_DLL` ile de override edilir |
| `dotnetCommand` | `"dotnet"` | PATH'ten çözülür |
| `requestTimeoutMs` | `30000` | aşım → kill + L0/L1 fallback |
| `spawnProcess` | `node:child_process.spawn` | yalnızca test enjeksiyonu |

## MSBuild project model (implicit global usings, one compilation per project)

When `rootDir` is given, `resolveCSharpProjects` (`src/project-model.ts`) reads
`.csproj` and the nearest `Directory.Build.props` (never above `rootDir`)
strictly read-only and sends the worker a `projects` field
(`native/roslyn-worker/PROTOCOL.md`, "Projects"):

- **Ownership:** a source belongs to the nearest ancestor directory holding a
  `.csproj`; each project is compiled separately (no CS7022/duplicate-type
  artifacts across projects). Sources outside every project share one
  compilation, as before.
- **Global usings:** `<ImplicitUsings>` `enable`/`true` (case-insensitive) adds
  the SDK defaults for `Microsoft.NET.Sdk`, `.Web`, `.Worker` and
  `.WindowsDesktop` (`UseWPF` / `UseWindowsForms`) as listed on Microsoft Learn
  (https://learn.microsoft.com/dotnet/core/project-sdk/overview#implicit-using-directives);
  `System.Net.Http` is omitted for .NET Framework targets. `<Using Include/Remove>`
  with `Alias` / `Static` metadata is honored in MSBuild import order
  (`Directory.Build.props` → SDK defaults → project file).
- **ProjectReference:** resolved to owning projects of the analysis set; the
  worker references the transitive closure.
- **Not evaluated (explicit warning when they touch a modeled setting):** MSBuild
  conditions other than `'$(P)' == 'v'` / `!=` on a modeled property, property
  functions/`$(...)` values, `<Choose>`, `<Import>`ed files, `Using Update`,
  `Directory.Build.targets`, SDKs outside the documented table (for example
  `Microsoft.NET.Sdk.Razor`, `MSTest.Sdk`).

## Testler

```bash
npx vitest run adapters/csharp-roslyn   # pozitif + negatif + partial üçlüsü
```

Pozitif test, sonucu gerçekten `createSnapshot`'a besleyerek domain
uyumunu kanıtlar (dangling edge / verified-kenar-≥1-kanıt invariant'ları
kurucuda zorlanır).

## analyzerFingerprint ref-pack kapsamı — KAPATILDI (sprint-2 B9 + denetim takibi)

PROTOCOL.md §6'nın belirttiği gibi, worker'ın otomatik ref-pack keşfi
(DOTNET_ROOT / host / standart kurulum yolu) **referans DLL kümesine ve
dolayısıyla semantiğe** dokunur: farklı makinelerde farklı .NET/ASP.NET
Core pack sürümleri farklı çözümleme sonuçları üretebilir. Bu borç,
packages/indexing B9 diliminde **fp3 şemasıyla kapatıldı**
(`packages/indexing/src/fingerprint.ts`).

fp3 analyzerFingerprint sözleşmesi — "|" ile ayrılmış konumsal segmentler:

    fp3|<ts-adapter>@<ver>|roslyn-worker@<ver>|refpack=<pack>@<sürüm>@<tfmDir>;...|refsrc=<kaynak>|opts=<sha256-16>

- **adapter versiyonu**: koşuma katılan her adapter'ın id@versiyonu.
- **refpack**: worker'ın GERÇEKTEN yüklediği ref pack sürümleri — worker
  healthy yanıt warnings'inden türetilir (ReferenceResolver.cs:248 canonical
  satırı `reference pack loaded: <pack> <version> (<tfmDir>)`). Pack hiç
  bulunamadıysa (`Microsoft.NETCore.App.Ref pack not found; ...` uyarısı)
  `fallback-corelib` (System.Private.CoreLib runtime ref);
  keşif bilgisi yoksa `unavailable` — hiçbir koşulda uydurma sürüm yazılmaz.
- **refsrc**: discovery kaynağı — discovery="performed" iken tfmDir
  `DOTNET_ROOT` altındaysa (dizin sınır ayıracı + Windows büyük/küçük harf
  normalizasyonuyla) `env-dotnet-root`; aksi halde host/standart ayrımı
  TS tarafından ayırt edilemez → dürüst genel etiket `worker-discovered`.
  Keşif yapılamayan koşumlar nötr dürüst etiketler taşır:
  `worker-unavailable` (worker hiç koşamadı), `discovery-unknown`
  (worker HEALTHY ama yanıtta keşif bilgisi yok — varlık ile bilginin
  aynı şey olmadığı denetim bulgusuyla ayrıştırıldı), `sync-run-degraded`
  (senkron indexing köprüsü worker'ı hiç başlatmaz).
- **opts**: IndexService'in C# adapter'a GEÇTİĞİ etkin ayarların
  (dotnetCommand, requestTimeoutMs, workerDllPath) canonical JSON sha256
  özeti (ilk 16 hex). Worker yanıt satır bütçesi (responseMaxChars)
  adapter içindeki sabittir ve IndexService geçmez; geçilmeyen değer
  hash'te "etkin ayar" gibi gösterilmez (bayat kopya riski — denetim
  bulgusu).

Sonuç: farklı ref-pack sürümü/kurulumu/ayarı → FARKLI fingerprint →
makineler arası Graph JSON eşitliği artık yanlış taahhüt edilmez; aynı
makinede aynı girdi → aynı fingerprint (determinizm korunur, TŞ §8
invariant vi). Yüzey: `IndexService.runIndexAsync` (tam pipeline),
`IndexJobManager` refresh işleri (B9 denetim düzeltmesiyle TAM pipeline'ı
koşar), `INDEXED_ADAPTERS` (get_capabilities csharp kaydı). Not: C# L3
route yeteneğinin adı (Protocol.cs CapabilitiesOut default) get_capabilities
yüzey sözleşmesinde (üç levels alanı) yer almadığından INDEXED_ADAPTERS'te
sabit kopyalanmaz; yüzeye ekleme mcp-server dilimine aittir. Doğrulama:
`packages/indexing/test/index-service-csharp.test.ts`.
