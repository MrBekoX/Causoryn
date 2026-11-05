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

const result = await analyzeCSharpWorkspace({
  workspaceId: "ws-1",
  files: [{ path: "Controllers/OrdersController.cs", content: "..." }],
  options: { requestTimeoutMs: 30_000 }, // workerDllPath/dotnetCommand da override edilebilir
});

// result.nodes / result.edges / result.evidence → createSnapshot girdisi:
const snapshot = createSnapshot({
  workspaceId: "ws-1",
  revision: { id: "rev-1", sequence: 0 },
  configHash: "...",
  analyzerFingerprint: `roslyn-worker@${result.analyzerVersion}`,
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

## Testler

```bash
npx vitest run adapters/csharp-roslyn   # pozitif + negatif + partial üçlüsü
```

Pozitif test, sonucu gerçekten `createSnapshot`'a besleyerek domain
uyumunu kanıtlar (dangling edge / verified-kenar-≥1-kanıt invariant'ları
kurucuda zorlanır).

## Açık borç — analyzerFingerprint kapsamı (sonraki dilim)

PROTOCOL.md §6'nın belirttiği gibi, worker'ın otomatik ref-pack keşfi
(DOTNET_ROOT / host / standart kurulum yolu) **referans DLL kümesine ve
dolayısıyla semantiğe** dokunur: farklı makinelerde farklı .NET/ASP.NET
Core pack sürümleri farklı çözümleme sonuçları üretebilir. Bu sürümde
analyzerFingerprint yalnızca `roslyn-worker@<version>` kurgusudur; ref-pack
sürümü/host bağlamı fingerprint'e DAHİL DEĞİLDİR → TŞ §8 invariant (vi) ("aynı
kod+config+adapter versiyonu aynı Graph JSON") makineler arası tam
taahhüt değildir. Borç: indexing/mcp-server entegrasyonu diliminde
fingerprint kurgusuna ref-pack sürümleri + discovery kaynağı eklenmelidir
(o zamana dek makineler arası Graph JSON eşitliği talep edilmemelidir).
