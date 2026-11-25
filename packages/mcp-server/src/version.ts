/**
 * MCP server identity, protocol schema version, and tool catalog constants.
 */

/** MCP serverInfo.name returned during initialize. */
export const SERVER_NAME = "causoryn";

/** MCP serverInfo.version (kept in sync with package.json). */
export const SERVER_VERSION = "0.3.2";

/** Envelope schemaVersion carried on every tool response. */
export const SCHEMA_VERSION = "2.0";

/** Supported MCP tool profiles selectable via --tool-profile or CAUSORYN_TOOL_PROFILE. */
export const TOOL_PROFILES = ["core", "full", "wiki", "history"] as const;

export type ToolProfile = (typeof TOOL_PROFILES)[number];

/**
 * Default lean core MCP tool catalog (11 consolidated tools).
 */
export const CORE_TOOL_NAMES = [
  "causoryn_status",
  "causoryn_map_system",
  "causoryn_find_symbols",
  "causoryn_get_symbol_context",
  "causoryn_trace",
  "causoryn_get_agent_context",
  "causoryn_preflight_change",
  "causoryn_verify_change",
  "causoryn_contracts",
  "causoryn_get_evidence",
  "causoryn_export_documentation",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

/** Living Wiki tool extension activated by the "wiki" profile. */
export const WIKI_TOOL_NAMES = [
  "causoryn_wiki_build",
  "causoryn_wiki_get_tree",
  "causoryn_wiki_get_page",
  "causoryn_wiki_search",
  "causoryn_wiki_get_links",
  "causoryn_wiki_get_versions",
  "causoryn_wiki_diff",
] as const;

export type WikiToolName = (typeof WIKI_TOOL_NAMES)[number];

/** Architecture history/evolution extension activated by the "history" profile. */
export const HISTORY_TOOL_NAMES = [
  "causoryn_compare_architecture",
  "causoryn_architecture_timeline",
] as const;

export type HistoryToolName = (typeof HISTORY_TOOL_NAMES)[number];

/**
 * Complete legacy 29-tool catalog preserved under --tool-profile full
 * for backward compatibility with existing integrations and prompts.
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

/** Mapping from superseded legacy tool names to their consolidated core replacement. */
export const DEPRECATED_TOOL_REPLACEMENTS: Readonly<Record<string, string>> = {
  causoryn_get_capabilities: "causoryn_status",
  causoryn_workspace_summary: "causoryn_status",
  causoryn_index_status: "causoryn_status",
  causoryn_refresh_index: "causoryn_status",
  causoryn_generate_onboarding: "causoryn_map_system",
  causoryn_trace_execution: "causoryn_trace",
  causoryn_trace_business_flow: "causoryn_trace",
  causoryn_analyze_impact: "causoryn_preflight_change",
  causoryn_derive_test_plan: "causoryn_preflight_change",
  causoryn_check_architecture: "causoryn_verify_change",
  causoryn_check_contracts: "causoryn_contracts",
  causoryn_detect_contract_drift: "causoryn_contracts",
};
