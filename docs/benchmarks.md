# Causoryn Performans Benchmark — Faz F / Sprint 7 (F7)

> Kanıt: raw/Causoryn_Teknik_Dokuman_v2.1.pdf §21 (s.22): "1.000 TS dosyası fixture üzerinde sıcak workspace_summary <1 sn, küçük graph neighborhood <500 ms, sınırlı 200 node map <2 sn". TŞ bu rakamları **tasarım hedefi** olarak verir ve açıkça şunu söyler: "bu rakamlar tasarım hedefi, gerçekleşmiş test sonucu değildir". Dolayısıyla aşağıdaki hedef kolonu **referans**tır, sonuç değil; tabloda yalnızca ölçülen değerler raporlanır.
> ADR-010 dürüstlük kuralı: ölçülemeyen şey ölçülmüş yazılmaz — ortam kesintisi/deadline aşımı olan satır `not measured (<neden>)` olarak raporlanır.

## Ölçüm yöntemi

- Fixture: deterministik sentetik TypeScript workspace, 1000 dosya (üretici: `tests/bench-release/fixture.ts`; aynı fileCount → bayt-bayt aynı içerik; sha256: `2b14c5ab89f5f1c2059f3152d5da6156d726d9d498343acd2fbf2aea64e8d958`).
- MCP protokol düzeyi (@modelcontextprotocol/sdk InMemoryTransport üzerinde client.callTool); süre process.hrtime.bigint(); her ölçümde 1 warm-up çağrısı (ölçülmez) + N koşum; raporlanan değer medyan; çağrı başına deadline aşımı/istisnası satırı 'not measured' yapar.
- Koşum başına çağrı deadline'ı: 30000 ms.
- Soğuk indeks (bilgi amaçlı): sabit süre vaadi yoktur (TŞ §21); ölçülen: 16370.3 ms (1000 dosya).
- Snapshot durumu: ready; adapter tanısı (TŞ §21 parse_errors metriği): 0 (fixture tanısız; state=ready)
- Ortam: node v24.16.0, win32 10.0.26300 x64, CPU: Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz, bellek: 32 GB.
- Yeniden üretim: `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (config: `vitest.bench.config.ts`; varsayılan vitest koşumu `tests/bench-release/**`'ı dışlar ve depoya yazmaz — ADR-008 salt-okunur test disiplini).

## Sonuçlar — koşum 2026-11-10T19:29:35.301Z

| Ölçüm | Araç çağrısı | Hedef (TŞ §21 referans — tasarım hedefi, sonuç değil) | Koşumlar (ms, N=3) | Medyan (ms) | Değerlendirme |
|---|---|---|---|---|---|
| workspace_summary_warm | `causoryn_workspace_summary` {} | < 1000 ms | 11.9 / 11.0 / 11.8 | 11.8 | hedef içinde (referans < 1000 ms) |
| graph_neighborhood_small | `causoryn_get_symbol_context` { symbolId: <ilk sınıf>, depth: 1 } | < 500 ms | 13.0 / 14.9 / 12.3 | 13.0 | hedef içinde (referans < 500 ms) |
| map_system_200 | `causoryn_map_system` { level: "L2", maxNodes: 200 } | < 2000 ms | 20.5 / 10.7 / 9.3 | 10.7 | hedef içinde (referans < 2000 ms) |

## Notlar

- Ölçümler MCP protokol düzeyinde yapılmıştır: motor + input validasyonu + envelope üretimi çağrı süresinin tamamı içindedir.
- Tek koşum içi değerler makine yüküne duyarlıdır; karşılaştırma için medyan kolonu esas alınır. Aynı girdi (fileCount + hash) her koşumda birebir aynı fixture'ı üretir — ölçüm gürültüsü yalnızca zamandan gelir.
