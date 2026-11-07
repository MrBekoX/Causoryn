/**
 * @causoryn/contracts — salt-okunur sözleşme keşfi (TŞ v2.1 §11, sprint-5 D1).
 *
 * Keşif kaynakları: OpenAPI (path/method/request-response), AsyncAPI
 * (topic/payload), SQL migration (sadeleştirilmiş parser), JSON Schema
 * (yerel $ref) ve protobuf (sadeleştirilmiş proto3 parser).
 * Her bulunan sözleşme → ApiContract/EventContract/SchemaContract node
 * adayı; produces/consumes kenar adayı D1 diliminde net route (openapi),
 * net topic kimliği (asyncapi) ve net isim (sql) eşleşmelerinde verified,
 * isim benzerliği heuristic'tir (TŞ §11).
 *
 * Kapsam sınırı (dürüstlük): TŞ §11'in saydığı "schema kimliği" tabanlı
 * verified kenar (ör. json-schema/protobuf SchemaContract adayının servis
 * tarafına schemaId ile bağlanması) D1'de ÜRETİLMEZ; ServiceAnchor'a schemaId
 * taşınması ve schema-id tabanlı eşleştirme D2/D3 dilimindedir (bkz.
 * match.ts kural 4, types.ts ServiceAnchor).
 *
 * Paket LLM/embedding bağımlılığı İÇERMEZ; salt-okunur disiplin
 * WorkspaceAccessPolicy ile zorlanır; çekirdek saf ve deterministiktir.
 */

export { ContractDiscoveryError } from "./errors.js";
export type { ContractErrorCode } from "./errors.js";

export {
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_SPEC_NODES,
  MAX_TEXT_NESTING,
  assertSpecSize,
  parseStructuredSpec,
} from "./parse-safety.js";
export type { ParsedSpec } from "./parse-safety.js";

export type {
  ContractCandidate,
  ContractCertainty,
  ContractDiagnostic,
  ContractDiscoveryResult,
  ContractEdgeCandidate,
  ContractEdgeKind,
  ContractEvidenceSpan,
  ContractFileInput,
  ContractMatchBasis,
  ContractNodeKind,
  ContractProperty,
  ContractSourceKind,
  DiscoveryOutput,
  ServiceAnchor,
  ServiceAnchorKind,
} from "./types.js";

export { compareContractCandidates, compareEdges, compareStrings } from "./order.js";

export { discoverOpenApiContracts } from "./openapi-discovery.js";
export { discoverAsyncApiContracts } from "./asyncapi-discovery.js";
export { discoverSqlContracts } from "./sql-discovery.js";
export { discoverJsonSchemaContracts } from "./json-schema-discovery.js";
export { discoverProtobufContracts } from "./protobuf-discovery.js";

export { scanServiceAnchors } from "./anchor-scan.js";
export { matchContractEdges } from "./match.js";

export {
  discoverContractsFromTexts,
  readContractFiles,
} from "./discover.js";
