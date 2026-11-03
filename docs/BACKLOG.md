# BACKLOG — Faz Bağımlılık Sıralaması

> Kanıt: [wiki/roadmap.md](../wiki/roadmap.md) (TŞ v2.1 §23–§25), [wiki/sprint-2.md](../wiki/sprint-2.md) – [wiki/sprint-7.md](../wiki/sprint-7.md) · Bu dosya sprint-1 görev 11 çıktısıdır; GitHub issue'ları ile birebir eşleşir (sprint-1.md görev 11).

## Faz → Issue eşlemesi ve sıra

| Sıra | Faz | Issue | Bağlı olduğu fazlar | Ana bileşenler | Kabul kapısı |
|---|---|---|---|---|---|
| 0 | **A — Foundation** | *issue yok — sprint-1 aktif iş* | — | `packages/domain`, `packages/workspace`, `packages/indexing`, `packages/graph`, `packages/storage-sqlite`, `packages/mcp-server`, `adapters/typescript` | Real tool calls + fixture golden + security tests |
| 1 | **B — Deep Mapping** | [#1](https://github.com/MrBekoX/Causoryn/issues/1) | A (sert) | `native/roslyn-worker/`, `adapters/csharp-roslyn/`, `packages/indexing`, `packages/graph`, `packages/mcp-server` | C# + TS fixture cross-boundary evidence |
| 2 | **C — Original Features** | [#2](https://github.com/MrBekoX/Causoryn/issues/2) | A + B (sert); C2 + D (soft, degrade eder) | `packages/graph`, `packages/mcp-server`, `packages/workspace` (export) | Eski 10 özellik gerçek fixture'larla |
| 3 | **C2 — Living Wiki** | [#3](https://github.com/MrBekoX/Causoryn/issues/3) | A (sert); B (önerilen sıra, sert değil) | `packages/wiki` (yeni), `packages/storage-sqlite`, `packages/mcp-server` | 7 Wiki tool real tests + kabul senaryoları |
| 4 | **D — Differentiation** | [#4](https://github.com/MrBekoX/Causoryn/issues/4) | A + B + C (sert); C2 (soft) | `packages/contracts` (yeni), `packages/preflight` (yeni), `packages/indexing`, `packages/mcp-server` | Contract/drift + preflight fixtures |
| 5 | **E — Agent Change Guard** | [#5](https://github.com/MrBekoX/Causoryn/issues/5) | A + B + C + **D (sert — E1 preflightId tüketir)**; C2 (soft) | `packages/verification` (yeni), `apps/visualizer` (yeni), `packages/mcp-server` | Before/after reproducibility + no-test-run honesty |
| 6 | **F — Cross-host Release** | [#6](https://github.com/MrBekoX/Causoryn/issues/6) | **A–E tamamı** (kapı: 18 modül + Wiki Done) | `packages/mcp-server` (esbuild bundle), `integrations/zcode/causoryn`, `docs/` | Release test matrisi + changelog |

## Bağımlılık grafiği

```
A (Foundation, sprint-1)
└─► B (Deep Mapping)              #1   ← yalnız A'ya sert bağımlı
    └─► C (Original Features)     #2   ← A + B; C1 impact D'yi besler
        └─► C2 (Living Wiki)      #3   ← sert bağımlılığı yalnız A; sıralaması roadmap tercihi
            └─► D (Differentiation)   #4 ← B endpoint edge'leri + C impact + D1→D2→D3→D6→D4 iç sırası
                └─► E (Agent Change Guard) #5 ← D4 preflightId SERT bağımlılık
                    └─► F (Cross-host Release) #6 ← A–E tamamı + 18 modül + Wiki Done kapısı
```

Sert bağımlılık zinciri (telef): **A → B → C → D → E → F**. C2 grafiğin ortasında durur ama tek sert bağımlılığı A'dır (bkz. aşağıda "Sıra değişebilir mi").

## Sıralama mantığı

1. **A önce** — her faz `GraphSnapshot` + `WorkspaceAccessPolicy` + MCP çatısı üstünde durur (sprint-1).
2. **B ikinci** — Roslyn (C#) ve framework endpoint edge'leri olmadan D'nin sözleşme keşfi (D1) ile iş akışı izi (D5) zayıf kalır; C'nin etki analizi API sınırlarını kaçırır (sprint-2.md B1–B8).
3. **C üçüncü** — "eski 10 özellik" seti grafiğin üstündeki ilk kullanıcı değeri; C1 impact çıktısı D4 preflight'ın girdisidir (sprint-3.md).
4. **C2 dördüncü** — Wiki projeksiyonu yalnız `GraphSnapshot` + SQLite ister; B'den sonraya itilmesi roadmap'in "çalışan dikey dilim önce" kararının parçasıdır, iptal değildir (roadmap.md §1.0 kapsam notu).
5. **D beşinci** — D4 preflight, C1 impactCandidates + D1–D3 contractChecks + D6 testPlanId çıktılarını birleştirir; bu yüzden faz içi sıra **D1 → D2 → D3 → D5 → D6 → D4**'tür (sprint-5.md).
6. **E altıncı** — `causoryn_verify_change` (E1) preflightId olmadan çalışmaz: D → E sert kenar (sprint-6.md E1). E4 (get_evidence zenginleştirme) tek başına erken kalkabilir.
7. **F en son** — sürüm kapısı 18 modül + Wiki Done (roadmap.md); kapsam gerçekçiliğine göre F9'da 0.1.0 snapshot / 1.0.0 kararı ADR-010 ruhuyla verilir (sprint-7.md).

## Sıra değişebilir mi?

- **C ↔ C2 yer değiştirebilir**: C2'nin sert bağımlılığı yalnızca A'dır; W1–W8 B çıktısı zorunlu kılmaz.
- **C2 ∥ D paralel yapılabilir**: farklı paketler (`packages/wiki` vs `packages/contracts`); çakışma yalnız `packages/mcp-server` tool kayıt düzeyindedir.
- **E, D tamamlanmadan başlayamaz** (E1 sert); yalnız E4 bağımsız kalkar.
- **F, tüm fazlar Done olmadan 1.0.0 olarak açılmamalı** — ADR-010: eksik özellik Done ilan edilmez; kapsam kısalırsa etiket 0.1.0 olur.

## Issue linkleri

| Issue | Başlık |
|---|---|
| [#1](https://github.com/MrBekoX/Causoryn/issues/1) | Phase B: Deep Mapping |
| [#2](https://github.com/MrBekoX/Causoryn/issues/2) | Phase C: Original Features |
| [#3](https://github.com/MrBekoX/Causoryn/issues/3) | Phase C2: Living Wiki |
| [#4](https://github.com/MrBekoX/Causoryn/issues/4) | Phase D: Differentiation |
| [#5](https://github.com/MrBekoX/Causoryn/issues/5) | Phase E: Agent Change Guard |
| [#6](https://github.com/MrBekoX/Causoryn/issues/6) | Phase F: Cross-host Release |

Her issue gövdesi İngilizcedir ve şunları içerir: fazın bağımlılık-sıralı görev listesi (checkbox), bağlı olduğu fazlar/bileşenler, çıkış kriterleri, roadmap.md'deki 8 maddelik Definition of Done ve TŞ kırmızı çizgileri.

## Kapsam notu

TŞ 18 özellik + Wiki'yi 1.0.0'a koyar; tek geliştirici gerçeği nedeniyle roadmap çalışan dikey dilimi (Faz A) öne alır. Bu bir iptal değil sıralama kararıdır ([wiki/roadmap.md](../wiki/roadmap.md) §1.0 kapsam notu; ADR-010 ruhu).
