/**
 * Sunucu kimliği ve sabitler (TŞ v2.1 §10.1 envelope schemaVersion "2.0";
 * sürüm paket package.json ile senkron tutulur).
 */

/** MCP serverInfo.name (initialize yanıtı). */
export const SERVER_NAME = "causoryn";

/** MCP serverInfo.version. */
export const SERVER_VERSION = "0.1.0";

/** Tüm araç yanıtlarındaki envelope.schemaVersion (TŞ §10.1 örneği). */
export const SCHEMA_VERSION = "2.0";

/**
 * Yayımlanan araçlar (TŞ §10.2 katalog sırası). Sprint-1: 5 çekirdek araç;
 * sprint-2 B6: causoryn_index_status + causoryn_refresh_index; sprint-2 B5:
 * causoryn_get_symbol_context; sprint-2 B4: causoryn_trace_execution;
 * sprint-3 C8 (Faz C): causoryn_analyze_impact, causoryn_check_architecture,
 * causoryn_compare_architecture, causoryn_get_agent_context,
 * causoryn_generate_onboarding, causoryn_export_documentation,
 * causoryn_architecture_timeline eklendi. Sıra TŞ §10.2 PDF katalog
 * sırasını izler: Faz C araçları trace_execution ile get_evidence arasında,
 * architecture_timeline get_evidence'dan SONRADIR. tools/list TAM OLARAK bu
 * 16 aracı sunar; boş handler yayınlanmaz (ADR-010, wiki/mcp-tools.md kuralı).
 */
export const TOOL_NAMES = [
  "causoryn_get_capabilities",
  "causoryn_workspace_summary",
  "causoryn_index_status",
  "causoryn_refresh_index",
  "causoryn_map_system",
  "causoryn_find_symbols",
  "causoryn_get_symbol_context",
  "causoryn_trace_execution",
  "causoryn_analyze_impact",
  "causoryn_check_architecture",
  "causoryn_compare_architecture",
  "causoryn_get_agent_context",
  "causoryn_generate_onboarding",
  "causoryn_export_documentation",
  "causoryn_get_evidence",
  "causoryn_architecture_timeline",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
