# @causoryn/adapter-python

Python dil adapter'ı — `native/python-worker` (saf stdlib `ast` sidecar)
süreç yönetimi (TŞ v2.1 §7: "Python AST + framework rules; L1/L2, seçili
L3"). `adapters/csharp-roslyn` deseninin birebir Python uyarlaması:
spawn → stdin'e tek satır JSON istek → satır-bazlı framing ile ilk tam
satırı oku → katalog doğrulaması → domain `createSnapshot` girdisine map.

## Kullanım

```ts
import { analyzePythonWorkspace } from "@causoryn/adapter-python";

const result = await analyzePythonWorkspace({
  workspaceId: "ws-1",
  files: [{ path: "app.py", content: sourceCode }],
});
// result.nodes / result.edges / result.evidence → createSnapshot girdisi
```

Adapter ID ÜRETMEZ (TŞ §7.1: canonical ID merkezi normalizer'dadır);
çıktı `SnapshotNodeInput`/`SnapshotEdgeInput`/`SnapshotEvidenceInput`
sözleşmesiyle ID'sizdir.

## Süreç politikası

- **Analyze başına yeni süreç** (long-lived daemon değil): çökme/timeout
  durumu diğer isteklere sızmaz; "restart" = bir sonraki istekte taze
  süreç (csharp-roslyn README kuralıyla aynı).
- **Timeout/çökme/bozuk yanıt → L0/L1 fallback:** motor ÇÖKMEZ;
  `workerAvailable=false`, `state=partial`, `coverageRatio=0`, File
  node'ları (sourceHash'li) korunur, explicit `warnings` + stderr log.
- **Spawn güvenliği (kırmızı çizgi 6):** komut `python` (varsayılan; POSIX'te
  önce `python3` denenir; `pythonCommand` seçeneğiyle override), analiz edilen
  workspace dışındaki `PATH` girdilerinden mutlak yola çözümlenir; argümanlar
  SABİT `["-I", "-B", "-X", "utf8", workerScriptPath]` (izole mod, bytecode
  yazımı yok, UTF-8 stdio) ve `cwd` = worker script dizini. Worker script yolu
  mutlak olmalıdır ve repo içi sabittir;
  `CAUSORYN_PYTHON_WORKER_SCRIPT` ortam değişkeniyle config düzeyinde
  override edilebilir. İstek içeriği yalnızca stdin JSON'da taşınır.
- **Env allowlist:** worker yalnızca `PATH`, `SystemRoot`, `COMSPEC`,
  `TEMP`, `TMP`, `USERPROFILE`, `HOME` değişkenlerini görür;
  `PYTHONPATH` bilinçli taşınmaz (saf stdlib — ortam determinizmi
  etkileyemez). `PYTHONIOENCODING` parent değerinden bağımsız her zaman
  `utf-8` sabitlenir (takım denetimi bulgusu: piped stderr locale kod
  sayfasına düşüp log metnini bozuyordu; worker da kendi tarafında
  `reconfigure` ile sabitler).
- **Framing bütçesi:** yanıt satırı `responseMaxChars` (varsayılan 64M
  char) aşarsa süreç kill edilir + fallback.

## Yetenekler (TŞ §7 beyanı)

| Alan | Değer | Not |
|---|---|---|
| `astParse` | true | stdlib `ast` — L1 bildirim geçişi (File/Function/Method/Class/Endpoint) |
| `symbolResolution` | true | L2 isim bağlamı: aynı modül → verified; import → heuristic (ambiguity'li); çözümsüz → UnknownExternal + unresolved. Tam type inference YOK. |
| `containsEdges` / `callEdges` | true | CONTAINS + CALLS, her kenar ≥1 evidence |
| `importEdges` | false | IMPORTS kenarı bu dilimde üretilmez; import tablosu yalnızca CALLS çözümü içindir |
| `routeDetection` | `"python-decorator-route-pattern"` | L3: FastAPI tarzı `@app.get/@app.post...`, Flask `@app.route` (+ `methods` listesi, varsayılan GET); Endpoint node + verified ROUTES_TO (route-attribute kanıtı) |
| `frameworkLinkers` | false | Express/Next.js tarzı linker bu dilimde yok |

Ayrıntılı mesaj şemaları, sınırlar ve resolution dürüstlük tablosu:
`native/python-worker/PROTOCOL.md`.

## Örtülü kapsam dışı (unsupported)

`unsupportedConstructs` worker yanıtında taşınır: monkey-patching,
runtime DI, `importlib/__import__` dinamik importu, yerel değişken tip
çıkarımı (local-variable-type-inference), caller'sız modül düzeyi
çağrılar, literal olmayan dekoratör yolları, fonksiyon-içi importlar.
