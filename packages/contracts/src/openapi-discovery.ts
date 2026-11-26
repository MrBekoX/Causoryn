import { nodeId } from "@causoryn/domain";

import { ContractDiscoveryError } from "./errors.js";
import { isPlainObject, parseStructuredSpec } from "./parse-safety.js";
import { compareStrings, sortUnique } from "./order.js";
import { ProjectionBudget, textUnits, type ProjectionOptions } from "./projection-budget.js";
import {
  EMPTY_SCHEMA_SHAPE,
  lastRefSegment,
  RefCache,
  SchemaShapeCache,
  type SchemaShape,
} from "./schema-shape.js";
import type { ContractCandidate, ContractDiagnostic, DiscoveryOutput } from "./types.js";

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
 * - Cost (CAU-04): line evidence comes from per-document indexes, each `$ref`
 *   string is resolved once and each schema object expanded once; the whole
 *   projection is metered by a ProjectionBudget (default
 *   MAX_PROJECTION_WORK_UNITS) and stops with contracts/limit-exceeded.
 */

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/** A `$ref` string resolved once per document: its schema id and its local target, if any. */
interface ResolvedSchemaRef {
  readonly id: string;
  readonly target: Record<string, unknown> | undefined;
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

function responseSchemaIds(
  op: Record<string, unknown>,
  refs: RefCache<ResolvedSchemaRef>,
): string[] {
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
    const ref = schema["$ref"];
    if (typeof ref === "string") ids.push(refs.get(ref).id);
  }
  return sortUnique(ids, compareStrings);
}

export function discoverOpenApiContracts(
  workspaceId: string,
  relativePath: string,
  text: string,
  options: ProjectionOptions = {},
): DiscoveryOutput {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId must not be empty");
  }
  const budget = options.budget ?? new ProjectionBudget();
  const spec = parseStructuredSpec(relativePath, text, { budget });
  const root = spec.root;

  const version = root["openapi"];
  if (typeof version !== "string" || version.trim().length === 0) {
    if (typeof root["swagger"] === "string") {
      throw new ContractDiscoveryError(
        "contracts/unsupported-spec",
        `OpenAPI 2.x (Swagger) is not supported; received version: ${String(root["swagger"])}`,
      );
    }
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "OpenAPI document must have a string 'openapi' field",
    );
  }
  if (!version.startsWith("3.")) {
    throw new ContractDiscoveryError(
      "contracts/unsupported-spec",
      `Only OpenAPI 3.x is discovered; received version: ${version} (OpenAPI 2.x/Swagger is not supported)`,
    );
  }
  const paths = root["paths"];
  if (!isPlainObject(paths)) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "OpenAPI document must have a 'paths' mapping",
    );
  }
  const components = isPlainObject(root["components"]) ? (root["components"] as Record<string, unknown>) : undefined;
  const schemas =
    components !== undefined && isPlainObject(components["schemas"])
      ? (components["schemas"] as Record<string, unknown>)
      : undefined;
  const refs = new RefCache<ResolvedSchemaRef>(budget, (ref) => ({
    id: lastRefSegment(ref),
    target: resolveLocalComponentsSchema(ref, schemas),
  }));
  const shapes = new SchemaShapeCache(budget);

  const contracts: ContractCandidate[] = [];
  const diagnostics: ContractDiagnostic[] = [];
  /** Diagnostics are emitted output too: 1 unit each plus their text (messages quote routes/refs). */
  const report = (diagnostic: ContractDiagnostic): void => {
    budget.charge(1 + textUnits(diagnostic.message, diagnostic.relativePath));
    diagnostics.push(diagnostic);
  };

  for (const [route, itemRaw] of Object.entries(paths)) {
    const pathLine = spec.lineOf("paths", route) ?? 1;
    if (!isPlainObject(itemRaw)) {
      report({
        relativePath,
        code: "contracts/openapi-path-item-invalid",
        message: `paths["${route}"] is not a mapping; pathItem ignored`,
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
      let requestSchemaId: string | undefined;
      const resolvedRefs: string[] = [];
      let certainty: ContractCandidate["certainty"] = "full";
      const opDiagnostics: string[] = [];

      let shape: SchemaShape = EMPTY_SCHEMA_SHAPE;
      if (requestSchema !== undefined) {
        const refRaw = requestSchema["$ref"];
        const resolved = typeof refRaw === "string" ? refs.get(refRaw) : undefined;
        requestSchemaId = resolved?.id;
        // A resolved local $ref reads the component's shape (expanded once per
        // document); otherwise the request schema object itself is read.
        shape = shapes.shapeOf(resolved?.target ?? requestSchema);
        if (typeof refRaw === "string") {
          if (resolved?.target !== undefined) {
            // Çözümlenen yerel ref kanıt olarak yazılır (json-schema keşfiyle
            // tutarlı kanıt taşıma — takım denetimi bulgusu 5).
            resolvedRefs.push(refRaw);
          } else if (refRaw.startsWith("#/")) {
            report({
              relativePath,
              code: "contracts/openapi-ref-unresolved",
              message: `requestBody $ref could not be resolved within the file: ${refRaw}`,
              line: pathLine,
            });
            certainty = "partial";
            opDiagnostics.push("openapi: local request $ref could not be resolved — no request body evidence");
          }
          // Dış $ref (http vb.): şema kimliği son segment olarak taşınır;
          // gövde kanıtı çıkarılmaz (salt-okunur yerel keşif dilimi — belgeli).
        }
      }

      const responseIds = responseSchemaIds(opRaw, refs);
      // Emitted representation is charged per candidate, even when the shape is
      // shared: elements plus text by length (name and qualifiedName both carry it).
      let emitUnits =
        1 +
        shape.emitUnits +
        responseIds.length +
        textUnits(qualifiedName, qualifiedName, route, relativePath, requestSchemaId, ...resolvedRefs, ...opDiagnostics);
      for (const id of responseIds) emitUnits += textUnits(id);
      budget.charge(emitUnits);
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
        responseSchemaIds: responseIds,
        properties: [...shape.properties],
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
      report({
        relativePath,
        code: "contracts/openapi-path-no-operations",
        message: `paths["${route}"] has no recognized HTTP method (parameters-only or $ref pathItems are not discovered by this parser)`,
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
