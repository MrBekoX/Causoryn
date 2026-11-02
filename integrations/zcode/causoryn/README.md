# @causoryn/zcode-plugin — ZCode Plugin Paketi (iskelet)

> Kanıt: TŞ v2.1 §17, §25/8 · wiki/decisions.md K-002 · wiki/sprint-1.md görev 8

Causoryn'in dördüncü host adapter'ı olan **ZCode** için plugin paketinin yer tutucusudur.

TŞ'de bu görev Antigravity plugin'i olarak tanımlıdır (§25/8: `plugin.json`,
`mcp.json`, `map-system` skill'i ve tanıtım README); K-002 kararıyla ZCode
plugin formatı (`mcpServers` + `skills` + `commands`) dördüncü host olarak
eklenmiştir. Aynı motor, dördüncü host'a bağlanır.

## Planlanan içerik (Sprint-1 görev 8 — henüz YOK, ADR-010: Done yazılmaz)

- `plugin.json` — `mcpServers` (local stdio Causoryn server'ı) + `skills` + `commands`
- `map-system` skill'i — host modeli `causoryn_map_system` aracını yönlendirir
- Tanıtım README'si — kurulum ve kullanım

Plugin içindeki skill/rule metni host modeli yönlendirir; host modelini
değiştiremez (TŞ §5.1 bağımlılık sınırı 5).

## İlgili sayfalar

- wiki/architecture.md — bağımlılık sınırları
- wiki/mcp-tools.md — araç kataloğu
- wiki/sprint-1.md — görev 8
