/**
 * Node/edge tür kataloğu — TŞ v2.1 §8'in bire bir listesi.
 * Çalışma zamanı setleri, ID üretiminde tür doğrulaması için türetilir.
 */

export const NODE_KINDS = [
  "Workspace",
  "Repository",
  "Project",
  "Module",
  "Package",
  "File",
  "Namespace",
  "Class",
  "Interface",
  "Type",
  "Function",
  "Method",
  "Endpoint",
  "Handler",
  "Event",
  "Topic",
  "Queue",
  "Database",
  "Table",
  "Column",
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
  "Test",
  "Config",
  "UnknownExternal",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "CONTAINS",
  "IMPORTS",
  "DECLARES",
  "CALLS",
  "REFERENCES",
  "IMPLEMENTS",
  "INHERITS",
  "INJECTS",
  "ROUTES_TO",
  "READS",
  "WRITES",
  "PUBLISHES",
  "SUBSCRIBES",
  "HANDLES",
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
  "VALIDATES",
  "TESTS",
  "DEPENDS_ON",
  "CONFIGURES",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const RESOLUTIONS = ["verified", "heuristic", "unresolved"] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

export const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

export const EDGE_KIND_SET: ReadonlySet<string> = new Set(EDGE_KINDS);

export const RESOLUTION_SET: ReadonlySet<string> = new Set(RESOLUTIONS);
