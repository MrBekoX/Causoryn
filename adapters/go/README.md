# @causoryn/adapter-go — Go Sidecar Worker Adapter (M1-Go)

> Kanıt: TŞ v2.1 §7 (dil adapter'ları), §23 (dil planı — Go satırı) ·
> native/go-worker/PROTOCOL.md v1 · desen: adapters/csharp-roslyn
> (kanıtlanmış Roslyn sidecar örüntüsü)

`native/go-worker/` sürecini yöneten TypeScript adapter. analyze başına
worker süreci başlatır, satır-bazlı stdin/stdout JSON protokolüyle konuşur,
çıktıyı **packages/domain `createSnapshot` GİRDİ sözleşmesine** (ID'siz
SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput) map eder —
canonical ID / de-duplication / dangling kontrolü merkezi normalizer'da
kalır (TŞ §7.1).

## Süreç yaşam döngüsü ve spawn kararı

- **Varsayılan: `go run ./cmd/worker`** — komut config sabiti
  (`goBinaryPath`, default literal `"go"`), argümanlar SABİT dizi
  (`["run", "./cmd/worker"]`), cwd SABİT (`native/go-worker`). Gerekçe:
  worker kaynağı repo-içi tek doğruluk kaynağıdır; go build cache
  (GOCACHE) ısınmış koşumları saniyelere indirir; derleme hatası
  stderr'de açıkça görülür ve unavailable fallback gerekçesine yazılır;
  release paketinde binary artefaktı taşımaya gerek kalmaz. **Sapma:**
  soğuk ilk derleme 30 sn'yi aşabildiğinden default timeout
  120.000 ms'dir (Roslyn adapter 30.000 ms; PROTOCOL.md §8'de belgeli).
- **Önceden derlenmiş binary:** `goWorkerBinaryPath` opsiyonu ya da
  `CAUSORYN_GO_WORKER_BIN` env değişkeni verilirse spawn
  `[binaryPath, []]` olur (go run atlanır). Test konvansiyonu:
  `go build -o native/go-worker/bin/go-worker-test.exe ./cmd/worker`
  (bin/ gitignore kapsamındadır). Kabul testleri her iki modun birebir
  aynı graph ürettiğini kanıtlar.
- **analyze başına yeni süreç** (long-lived daemon değil): timeout/çökmede
  paylaşılan durum yoktur; **restart politikası = bir sonraki istek taze
  süreçle yürütülür** (TŞ §7 adapter izolasyonu).
- **Per-request timeout**: `requestTimeoutMs` (default 120.000 ms).
  Aşımda süreç `kill()` edilir, analize L0/L1 fallback ile devam edilir.
- **Komut güvenliği (kırmızı çizgi 6):** çalıştırılabilir yalnızca
  config sabitidir; kullanıcı girdisi asla komut satırına interpole
  edilmez; fixture içerikleri yalnızca stdin JSON'da taşınır; shell
  kullanılmaz.

## Ortam allowlist'i

Worker süreci parent'ın TÜM env'ini miraslamaz; yalnızca go toolchain'in
çalışması için gerekenler taşınır: `PATH`, `SystemRoot`, `COMSPEC`,
`TEMP`, `TMP`, `USERPROFILE`, `HOME`, `APPDATA` (go env config),
`LOCALAPPDATA` (GOCACHE default), `GOPATH`, `GOROOT`, `GOCACHE`,
`GOMODCACHE`, `GOENV`. Anahtar/token gibi allowlist dışı değerler süreç
listesinden okunamaz (güvenlik bulgusu 1 deseni).

## Graceful fallback (motor çökmez)

Worker başlatılamazsa / çökerse / zaman aşımına düşerse / sözleşmeye
aykırı yanıt verirse:

- `workerAvailable: false`, `state: "partial"`, `coverageRatio: 0`
- `nodes`: L0/L1 — File node'ları (sourceHash attribute'lu) korunur,
  sembol/kenar üretilmez (uydurma yok)
- `warnings`: explicit sebep ("Go worker kullanılamıyor (...)") +
  "L0/L1 dosya düzeyine düşüldü" + worker stderr başlığı; ayrıca stderr'e
  `[go-adapter]` önekli log yazılır
- worker'ın PROTOCOL.md §4'e uygun `status:"error"` yanıtı
  (LIMIT_EXCEEDED vb.) istek reddi olarak ayrıştırılır: hata kodu +
  mesaj warnings'te
- tek dosyadaki girdi sorunu (mutlak yol, `..`, duplicate) DomainError ile
  reddedilir — adapter izolasyonu motorun hata toplayıcısına aittir

## Yetenek beyanı (dürüstlük)

`symbolResolution: false` — go/types semantik model KULLANILMAZ.
Çözümleme tablosu (tam hâli PROTOCOL.md §3):

| Kalıp | resolution |
|---|---|
| Aynı package top-level func'a bare-ident çağrı | `verified` (go/ast) |
| `pkg.Func` (pkg analiz setinde, Func tanımlı) | `heuristic` |
| Set dışı package çağrısı (import temelli, zincirli dahil) | `heuristic` → UnknownExternal |
| Benzersiz metot adı (`x.M()`, `x.field.M()`) | `heuristic` |
| Çok adaylı metot adı / çözümsüz selector | `unresolved` → UnknownExternal |

Route katmanı (L3): `http.HandleFunc/Handle` (`*` metot) + gin/echo/chi
fiil kayıtları (`GET/POST/...`, büyük/küçük harf duyarsız) → Endpoint node +
ROUTES_TO; named handler verified, selector handler tabloyla, func literal
handler Endpoint korunur + uyarı (kenar üretilmez).

## Kullanım

```ts
import { analyzeGoWorkspace } from "@causoryn/adapter-go";
import { createSnapshot } from "@causoryn/domain";

const result = await analyzeGoWorkspace({
  workspaceId: "ws-1",
  files: [{ path: "cmd/app/main.go", content: "package main ..." }],
  options: {
    // goBinaryPath: "/path/to/go",  // default "go" (PATH)
    // goWorkerBinaryPath: "native/go-worker/bin/go-worker.exe", // binary modu
    requestTimeoutMs: 120_000,
  },
});

const snapshot = createSnapshot({
  workspaceId: "ws-1",
  revision: { id: "rev-1", sequence: 0 },
  configHash: "cfg",
  analyzerFingerprint: `go-worker@${result.analyzerVersion}`,
  state: result.state === "partial" ? "partial" : "ready",
  createdAt: "<kurucu saat>.toISOString()",
  nodes: result.nodes,
  edges: result.edges,
  evidence: result.evidence,
});
```

Aynı .go dosyaları indexed snapshot'a TS/C# graph'ıyla birlikte katılır
(analyzerFingerprint fp2 şeması packages/indexing'ten; Go adapter'ının
INDEXED_ADAPTERS/get_capabilities kaydı ayrı entegrasyon dilimidir).

## Doğrulama

```bash
cd native/go-worker && go build ./...          # derleme kanıtı (stdlib-only)
npx vitest run adapters/go/test/go-adapter.test.ts   # kabul testleri (M1)
```
