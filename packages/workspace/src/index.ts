/**
 * @causoryn/workspace — Workspace Gateway paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §5 Pipeline + §9, Sprint-1 görev 2):
 * trusted root doğrulaması (explicit authorization), file inventory,
 * ignore kuralları, symlink escape tespiti ve binary/size filtreleri.
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek implementasyon Sprint-1
 * görev 2'de (`WorkspaceAccessPolicy`) yazılacaktır. ADR-010 uyarınca
 * bu paket Done olarak beyan EDİLMEZ.
 */

/** Workspace Gateway paketinin Faz A dilimindeki mimari sözleşmesi. */
export interface WorkspacePackageContract {
  readonly name: "@causoryn/workspace";
  readonly role: "workspace-gateway";
  readonly responsibilities: readonly [
    "explicit-root-authorization",
    "file-inventory",
    "ignore-rules",
    "symlink-escape-detection",
    "binary-and-size-filters",
  ];
  readonly designSource: "TŞ v2.1 §5, §9, §25/2";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek API Sprint-1 görev 2'de gelir. */
export const workspacePackageContract: WorkspacePackageContract = {
  name: "@causoryn/workspace",
  role: "workspace-gateway",
  responsibilities: [
    "explicit-root-authorization",
    "file-inventory",
    "ignore-rules",
    "symlink-escape-detection",
    "binary-and-size-filters",
  ],
  designSource: "TŞ v2.1 §5, §9, §25/2",
  status: "scaffold",
};
