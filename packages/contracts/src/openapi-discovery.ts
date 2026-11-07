import { nodeId } from "@causoryn/domain";

import { ContractDiscoveryError } from "./errors.js";
import { isPlainObject, parseStructuredSpec } from "./parse-safety.js";
import { compareStrings, sortUnique } from "./order.js";
import type {
  ContractCandidate,
  ContractDiagnostic,
  ContractProperty,
  DiscoveryOutput,
} from "./types.js";

/**
 * OpenAPI 3.x keşfi — TŞ §11: "OpenAPI (path, method, request/response)".
 * Referans: raw/context-inject/standards/openapi-openapis-org-3.1.0.md
 * (OpenAPI 3.1, JSON Schema 2020-12 ile tam uyumludur).
 *
 * Belgelenmiş sınırlar (dilim):
 * - Yalnızca `openapi: 3.x` kök alanı; 2.x (Swagger) → contracts/unsupported-spec.
 * - Her (path, method) çifti bir ApiContract adayıdır; `operationId` varsa
 *   qualifiedName odur, yoksa `"<METHOD> <route>"`.
 * - requestBody/response içerik anahtarlarından ALFABETİK ilki alınır
 *   (determinizm); `$ref` yerel "#/components/schemas/..." ise şema kimliği
 *   son segment olarak taşınır ve şema gövdesi DOSYA İÇİNDE çözümlenerek
 *   required/properties kanıtı çıkarılır (D2/D3 breaking analizi malzemesi).
 * - parameters (path/query/header) alanları bu dilimde adaya taşınmaz.
 * - $ref ile gösterilmemiş (inline) pathItem/response yapıları için kanıt
 *   satırı path anahtar satırıdır.
 */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

function lastRefSegment(ref: string): string {
  const segments = ref.split("/");
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? ref : last;
}

function resolveLocalComponentsSchema(
  ref: string,
  schemas: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/components/schemas/") || schemas === undefined) return undefined;
  const key = lastRefSegment(ref);
  // Güvenlik (denetim bulgusu): yalnızca KENDİ alan — "#/components/schemas/__proto__"
  // gibi işaretçiler prototip zincirine (Object.prototype) yürüyüp çözümlenmiş
  // sayılamaz (Object.hasOwn).
  if (!Object.hasOwn(schemas, key)) return undefined;
  const found = schemas[key];
  return isPlainObject(found) ? found : undefined;
}

interface SchemaShape {
  readonly required: readonly string[];
  readonly properties: readonly ContractProperty[];
  /** Yerel $ref gerçekten dosya içinde çözümlendiyse ham işaretçi. */
  readonly resolvedPointer?: string;
}

/** Şema gövdesinden required/properties çıkarır (yerel $ref çözümlemesiyle). */
function readSchemaShape(
  schema: Record<string, unknown>,
  schemas: Record<string, unknown> | undefined,
): SchemaShape {
  let target: Record<string, unknown> = schema;
  let resolvedPointer: string | undefined;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const resolved = resolveLocalComponentsSchema(ref, schemas);
    if (resolved !== undefined) {
      target = resolved;
      resolvedPointer = ref;
    }
  }
  const requiredRaw = target["required"];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
    : [];

  const propertiesRaw = target["properties"];
  const properties: ContractProperty[] = [];
  if (isPlainObject(propertiesRaw)) {
    for (const [name, propRaw] of Object.entries(propertiesRaw)) {
      if (!isPlainObject(propRaw)) continue;
      const typeRaw = propRaw["type"];
      const refRaw = propRaw["$ref"];
      const type =
        typeof typeRaw === "string"
          ? typeRaw
          : typeof refRaw === "string"
            ? "ref"
            : "unknown";
      properties.push({ name, type, required: required.includes(name) });
    }
  }
  properties.sort((a, b) => compareStrings(a.name, b.name));
  return { required, properties, ...(resolvedPointer === undefined ? {} : { resolvedPointer }) };
}

/** content eşlemesinden alfabetik ilk anahtarın şemasını alır. */
function firstContentSchema(
  container: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (container === undefined) return undefined;
  const content = container["content"];
  if (!isPlainObject(content)) return undefined;
  const keys = Object.keys(content).sort(compareStrings);
  for (const key of keys) {
    const entry = content[key];
    if (isPlainObject(entry) && isPlainObject(entry["schema"])) {
      return entry["schema"] as Record<string, unknown>;
    }
  }
  return undefined;
}

function schemaIdOf(schema: Record<string, unknown>): string | undefined {
  const ref = schema["$ref"];
  return typeof ref === "string" ? lastRefSegment(ref) : undefined;
}

function responseSchemaIds(op: Record<string, unknown>): string[] {
  const responses = op["responses"];
  if (!isPlainObject(responses)) return [];
  const codes = Object.keys(responses).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return compareStrings(a, b);
  });
  const ids: string[] = [];
  for (const code of codes) {
    const response = responses[code];
    if (!isPlainObject(response)) continue;
    const schema = firstContentSchema(response);
    if (schema === undefined) continue;
    const id = schemaIdOf(schema);
    if (id !== undefined) ids.push(id);
  }
  return sortUnique(ids, compareStrings);
}

export function discoverOpenApiContracts(
  workspaceId: string,
  relativePath: string,
  text: string,
): DiscoveryOutput {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId boş olamaz");
  }
  const spec = parseStructuredSpec(relativePath, text);
  const root = spec.root;

  const version = root["openapi"];
  if (typeof version !== "string" || version.trim().length === 0) {
    if (typeof root["swagger"] === "string") {
      throw new ContractDiscoveryError(
        "contracts/unsupported-spec",
        `OpenAPI 2.x (Swagger) desteklenmez; gelen sürüm: ${String(root["swagger"])}`,
      );
    }
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "OpenAPI belgesinde 'openapi' string alanı zorunludur",
    );
  }
  if (!version.startsWith("3.")) {
    throw new ContractDiscoveryError(
      "contracts/unsupported-spec",
      `Yalnızca OpenAPI 3.x keşfedilir; gelen sürüm: ${version} (OpenAPI 2.x/Swagger desteklenmez)`,
    );
  }
  const paths = root["paths"];
  if (!isPlainObject(paths)) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "OpenAPI belgesinde 'paths' eşlemesi zorunludur",
    );
  }
  const components = isPlainObject(root["components"]) ? (root["components"] as Record<string, unknown>) : undefined;
  const schemas =
    components !== undefined && isPlainObject(components["schemas"])
      ? (components["schemas"] as Record<string, unknown>)
      : undefined;

  const contracts: ContractCandidate[] = [];
  const diagnostics: ContractDiagnostic[] = [];

  for (const [route, itemRaw] of Object.entries(paths)) {
    const pathLine = spec.lineOf("paths", route) ?? 1;
    if (!isPlainObject(itemRaw)) {
      diagnostics.push({
        relativePath,
        code: "contracts/openapi-path-item-invalid",
        message: `paths["${route}"] bir eşleme değil; pathItem yok sayıldı`,
        line: pathLine,
      });
      continue;
    }
    const item = itemRaw;
    let recognizedMethod = false;

    for (const method of HTTP_METHODS) {
      const opRaw = item[method];
      if (!isPlainObject(opRaw)) continue;
      recognizedMethod = true;

      const operationId =
        typeof opRaw["operationId"] === "string" && opRaw["operationId"].trim().length > 0
          ? opRaw["operationId"]
          : undefined;
      const upperMethod = method.toUpperCase() as Uppercase<HttpMethod>;
      const qualifiedName = operationId ?? `${upperMethod} ${route}`;

      const requestSchema = firstContentSchema(
        isPlainObject(opRaw["requestBody"]) ? (opRaw["requestBody"] as Record<string, unknown>) : undefined,
      );
      const requestSchemaId = requestSchema === undefined ? undefined : schemaIdOf(requestSchema);
      const resolvedRefs: string[] = [];
      let certainty: ContractCandidate["certainty"] = "full";
      const opDiagnostics: string[] = [];

      let shape: SchemaShape = { required: [], properties: [] };
      if (requestSchema !== undefined) {
        const read = readSchemaShape(requestSchema, schemas);
        shape = { required: read.required, properties: read.properties };
        const refRaw = requestSchema["$ref"];
        if (typeof refRaw === "string") {
          if (read.resolvedPointer !== undefined) {
            // Çözümlenen yerel ref kanıt olarak yazılır (json-schema keşfiyle
            // tutarlı kanıt taşıma — takım denetimi bulgusu 5).
            resolvedRefs.push(read.resolvedPointer);
          } else if (refRaw.startsWith("#/")) {
            diagnostics.push({
              relativePath,
              code: "contracts/openapi-ref-unresolved",
              message: `requestBody $ref dosya içinde çözümlenemedi: ${refRaw}`,
              line: pathLine,
            });
            certainty = "partial";
            opDiagnostics.push("openapi: yerel request $ref çözümlenemedi — gövde kanıtı yok");
          }
          // Dış $ref (http vb.): şema kimliği son segment olarak taşınır;
          // gövde kanıtı çıkarılmaz (salt-okunur yerel keşif dilimi — belgeli).
        }
      }

      const contract: ContractCandidate = {
        contractId: nodeId({
          workspaceId,
          kind: "ApiContract",
          qualifiedName,
          relativePath,
        }),
        sourceKind: "openapi",
        nodeKind: "ApiContract",
        name: qualifiedName,
        qualifiedName,
        method: upperMethod,
        route,
        responseSchemaIds: responseSchemaIds(opRaw),
        properties: shape.properties,
        requiredPropertyNames: [...shape.required],
        resolvedRefs: sortUnique(resolvedRefs, compareStrings),
        certainty,
        evidence: { relativePath, startLine: pathLine, endLine: pathLine },
        diagnostics: opDiagnostics,
        ...(requestSchemaId === undefined ? {} : { requestSchemaId }),
      };
      contracts.push(contract);
    }

    if (!recognizedMethod) {
      diagnostics.push({
        relativePath,
        code: "contracts/openapi-path-no-operations",
        message: `paths["${route}"] altında tanınan HTTP methodu yok (parametreler/$ref pathItem bu dilimde keşfedilmez)`,
        line: pathLine,
      });
    }
  }

  contracts.sort(compareCandidatesByEvidence);
  return { contracts, diagnostics };
}

function compareCandidatesByEvidence(a: ContractCandidate, b: ContractCandidate): number {
  return (
    compareStrings(a.qualifiedName, b.qualifiedName) ||
    compareStrings(a.evidence.relativePath, b.evidence.relativePath) ||
    a.evidence.startLine - b.evidence.startLine
  );
}

export { METHOD_SET };
