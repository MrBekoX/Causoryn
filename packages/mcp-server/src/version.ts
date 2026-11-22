/**
 * Sunucu kimliği ve sabitler (TŞ v2.1 §10.1 envelope schemaVersion "2.0";
 * sürüm paket package.json ile senkron tutulur).
 */

/** MCP serverInfo.name (initialize yanıtı). */
export const SERVER_NAME = "causoryn";

/** MCP serverInfo.version. */
export const SERVER_VERSION = "0.2.1";

/** Tüm araç yanıtlarındaki envelope.schemaVersion (TŞ §10.1 örneği). */
export const SCHEMA_VERSION = "2.0";

/**
 * Yayımlanan araçlar (TŞ §10.2 katalog sırası + §16A.8 Wiki eki). Sprint-1:
 * 5 çekirdek araç; sprint-2 B6: causoryn_index_status + causoryn_refresh_index;
 * sprint-2 B5: causoryn_get_symbol_context; sprint-2 B4:
 * causoryn_trace_execution; sprint-3 C8 (Faz C): causoryn_analyze_impact,
 * causoryn_check_architecture, causoryn_compare_architecture,
 * causoryn_get_agent_context, causoryn_generate_onboarding,
 * causoryn_export_documentation, causoryn_architecture_timeline;
 * sprint-4 W5 (Faz C2 Living Wiki, TŞ §16A.8 tablo sırası):
 * causoryn_wiki_build, causoryn_wiki_get_tree, causoryn_wiki_get_page,
 * causoryn_wiki_search, causoryn_wiki_get_links, causoryn_wiki_get_versions,
 * causoryn_wiki_diff; sprint-5 D2-D6 (Faz D Differentiation, TŞ §10.2 PDF
 * katalog satır sırası): causoryn_trace_business_flow trace_execution'dan
 * sonra; causoryn_preflight_change, causoryn_check_contracts ve
 * causoryn_detect_contract_drift export_documentation ile get_evidence
 * ARASINDA (katalog satırı sırası); sprint-6 E1-E3 (Faz E Agent Change
 * Guard, TŞ §10.2 PDF s.10 katalog satırı): causoryn_verify_change
 * detect_contract_drift ile derive_test_plan ARASINDA (katalog satır
 * sırası; boş handler yayınlama yasağı, ADR-010). tools/list TAM OLARAK bu
 * 29 aracı sunar; boş handler yayınlanmaz (ADR-010, wiki/mcp-tools.md kuralı).
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
  "causoryn_trace_business_flow",
  "causoryn_analyze_impact",
  "causoryn_check_architecture",
  "causoryn_compare_architecture",
  "causoryn_get_agent_context",
  "causoryn_generate_onboarding",
  "causoryn_export_documentation",
  "causoryn_preflight_change",
  "causoryn_check_contracts",
  "causoryn_detect_contract_drift",
  "causoryn_verify_change",
  "causoryn_derive_test_plan",
  "causoryn_get_evidence",
  "causoryn_architecture_timeline",
  "causoryn_wiki_build",
  "causoryn_wiki_get_tree",
  "causoryn_wiki_get_page",
  "causoryn_wiki_search",
  "causoryn_wiki_get_links",
  "causoryn_wiki_get_versions",
  "causoryn_wiki_diff",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
