/**
 * @causoryn/graph — Graph sorgu katmanı paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §8 + §9, ADR-005 Immutable Snapshots):
 * snapshot üzerinden okuma sorguları (map_system, find_symbols, traversal),
 * deterministik sıralama/cursor, coverage raporlama. Bu paket graph verisini
 * üretmez; yalnızca mevcut snapshot'ı sorgular.
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek implementasyon Sprint-1
 * görev 5 diliminde yazılacaktır. ADR-010 uyarınca bu paket Done olarak
 * beyan EDİLMEZ.
 */

/** Graph sorgu paketinin Faz A dilimindeki mimari sözleşmesi. */
export interface GraphPackageContract {
  readonly name: "@causoryn/graph";
  readonly role: "graph-queries";
  readonly responsibilities: readonly [
    "snapshot-read-queries",
    "deterministic-traversal-and-cursors",
    "coverage-reporting",
  ];
  readonly invariants: readonly [
    "verified-edge-requires-evidence",
    "no-dangling-edges",
    "deterministic-ids",
    "immutable-snapshot",
    "same-input-same-graph-json",
  ];
  readonly designSource: "TŞ v2.1 §8, §9, ADR-004/005";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek API Sprint-1 görev 5'te gelir. */
export const graphPackageContract: GraphPackageContract = {
  name: "@causoryn/graph",
  role: "graph-queries",
  responsibilities: [
    "snapshot-read-queries",
    "deterministic-traversal-and-cursors",
    "coverage-reporting",
  ],
  invariants: [
    "verified-edge-requires-evidence",
    "no-dangling-edges",
    "deterministic-ids",
    "immutable-snapshot",
    "same-input-same-graph-json",
  ],
  designSource: "TŞ v2.1 §8, §9, ADR-004/005",
  status: "scaffold",
};
