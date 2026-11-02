/**
 * @causoryn/indexing — IndexCoordinator paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §9 Incremental pipeline + §25/4-5):
 * Discover → Parse → Resolve → Normalize → Verify invariants → Store
 * pipeline'ının orkestrasyonu, dosya watcher invalidation (300–1000 ms
 * debounce), atomic snapshot publish.
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek implementasyon Sprint-1
 * görev 4-5 diliminde yazılacaktır. ADR-010 uyarınca bu paket Done olarak
 * beyan EDİLMEZ.
 */

/** Indexing paketinin Faz A dilimindeki mimari sözleşmesi. */
export interface IndexingPackageContract {
  readonly name: "@causoryn/indexing";
  readonly role: "index-coordinator";
  readonly responsibilities: readonly [
    "pipeline-orchestration",
    "incremental-invalidation",
    "atomic-snapshot-publish",
  ];
  readonly designSource: "TŞ v2.1 §9, §25/4-5";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek API sonraki dilimlerde gelir. */
export const indexingPackageContract: IndexingPackageContract = {
  name: "@causoryn/indexing",
  role: "index-coordinator",
  responsibilities: [
    "pipeline-orchestration",
    "incremental-invalidation",
    "atomic-snapshot-publish",
  ],
  designSource: "TŞ v2.1 §9, §25/4-5",
  status: "scaffold",
};
