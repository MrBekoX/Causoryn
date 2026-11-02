/**
 * @causoryn/storage-sqlite — SQLite graph store paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §9, §25/5): workspaces/files/snapshots/nodes/
 * edges/evidence/index_jobs/symbol_fts tablo ailesi, schema migration'lar,
 * FTS5 sembol arama ve atomic publish (building → ready|partial geçişi;
 * eski snapshot stale=true ile sorgulanabilir kalır).
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek implementasyon Sprint-1
 * görev 5 diliminde yazılacaktır. ADR-010 uyarınca bu paket Done olarak
 * beyan EDİLMEZ.
 */

/** Storage paketinin Faz A dilimindeki mimari sözleşmesi. */
export interface StoragePackageContract {
  readonly name: "@causoryn/storage-sqlite";
  readonly role: "graph-store";
  readonly responsibilities: readonly [
    "sqlite-schema-and-migrations",
    "fts5-symbol-search",
    "atomic-snapshot-publish",
  ];
  readonly writeScope: "yalnızca izinli data-root; kullanıcı workspace'i salt okunur (ADR-008)";
  readonly designSource: "TŞ v2.1 §9, §25/5";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek API Sprint-1 görev 5'te gelir. */
export const storagePackageContract: StoragePackageContract = {
  name: "@causoryn/storage-sqlite",
  role: "graph-store",
  responsibilities: [
    "sqlite-schema-and-migrations",
    "fts5-symbol-search",
    "atomic-snapshot-publish",
  ],
  writeScope: "yalnızca izinli data-root; kullanıcı workspace'i salt okunur (ADR-008)",
  designSource: "TŞ v2.1 §9, §25/5",
  status: "scaffold",
};
