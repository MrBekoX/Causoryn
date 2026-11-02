/**
 * @causoryn/mcp-server — MCP protokol adaptasyonu paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §5 + §10.1, Sprint-1 görev 6-7): local stdio
 * transport (ADR-003), Zod input validation, authorization, rate/size
 * limitleri ve Core application service arayüzlerine yönlendirme.
 *
 * Kırmızı çizgiler (TŞ §10.1):
 * - stdout YALNIZCA MCP stdio protokol trafiği; tüm loglar stderr.
 * - tools/list yalnızca gerçekten implement edilmiş araçları yayınlar;
 *   boş handler yayınlanmaz (ADR-010).
 * - Bu paket parser/analysis detayı içermez; yalnızca ApplicationService
 *   arayüzlerini tüketir (wiki/architecture.md bağımlılık sınırı 3).
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek server Sprint-1 görev 6-7
 * diliminde yazılacaktır. ADR-010 uyarınca bu paket Done olarak beyan
 * EDİLMEZ.
 */

/** MCP server paketinin Faz A dilimindeki mimari sözleşmesi. */
export interface McpServerPackageContract {
  readonly name: "@causoryn/mcp-server";
  readonly role: "mcp-protocol-adaptation";
  readonly responsibilities: readonly [
    "stdio-transport",
    "zod-input-validation",
    "authorization-and-limits",
    "application-service-routing",
  ];
  readonly invariants: readonly [
    "stdout-mcp-protocol-only",
    "no-empty-tool-handlers",
    "parser-details-stay-out",
  ];
  readonly designSource: "TŞ v2.1 §5, §10, ADR-003/010";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek server Sprint-1 görev 6-7'de gelir. */
export const mcpServerPackageContract: McpServerPackageContract = {
  name: "@causoryn/mcp-server",
  role: "mcp-protocol-adaptation",
  responsibilities: [
    "stdio-transport",
    "zod-input-validation",
    "authorization-and-limits",
    "application-service-routing",
  ],
  invariants: [
    "stdout-mcp-protocol-only",
    "no-empty-tool-handlers",
    "parser-details-stay-out",
  ],
  designSource: "TŞ v2.1 §5, §10, ADR-003/010",
  status: "scaffold",
};
