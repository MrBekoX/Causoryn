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
 * JSON Schema keşfi — TŞ §11: "manifest/protobuf/JSON Schema".
 * Referans: raw/context-inject/standards/json-schema-ietf-2020-12.md.
 *
 * Belgelenmiş sınırlar (dilim):
 * - $ref çözümlemesi YALNIZCA yerel dosya içinde ("#/..." işaretçileri)
 *   yapılır; dış $ref (http://, diğer dosya) AĞ'A/FS'E GİRMEZ —
 *   contracts/json-schema-external-ref diagnostic'ı düşer ve aday partial
 *   olur (salt-okunur keşif + determinizm kırmızı çizgileri).
 * - Çözümlenemeyen yerel işaretçi → contracts/json-schema-ref-unresolved.
 * - $schema alanı yoksa ancak properties/$defs/definitions/type varsa
 *   "varsayılan şema" kabul edilir (assumed diagnostic'ı + partial).
 * - Hiçbir şema işareti yoksa sözleşme ÜRETİLMEZ; yalnızca
 *   contracts/json-schema-not-a-schema diagnostic'ı düşer.
 * - properties düzeyi: yalnızca KÖK properties listelenir (alt şemaların
 *   alanları adayın properties'ine katılmaz; $defs tanımları ayrı sözleşme
 *   ÜRETMEZ).
 * - JSON Pointer ~0/~1 kaçış çözümlemesi bu dilimde yoktur (düz segment).
 */

function stemOf(relativePath: string): string {
  const base = relativePath.split(/[\\/]/u).pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function propertyType(prop: Record<string, unknown>): string {
  const typeRaw = prop["type"];
  if (typeof typeRaw === "string") return typeRaw;
  if (typeof prop["$ref"] === "string") return "ref";
  if (isPlainObject(prop["items"]) || isPlainObject(prop["prefixItems"])) return "array";
  return "unknown";
}

/** Derin yürüyüşle tüm {"$ref": "..."} işaretçilerini toplar. */
function collectRefs(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectRefs(child, into);
    return;
  }
  if (isPlainObject(value)) {
    const ref = value["$ref"];
    if (typeof ref === "string") into.push(ref);
    for (const child of Object.values(value)) collectRefs(child, into);
  }
}

/** "#/a/b" işaretçisini kök nesnede çözer; ~ kaçışı çözülmez (belgeli dilim).
 * Güvenlik (denetim bulgusu): yalnızca KENDİ alan üzerinden gezilir —
 * "__proto__"/"constructor" gibi segmentler prototip zincirine yürüyemez
 * (Object.hasOwn; aksi halde çözülemeyen $ref sessizce "resolved" sayılır). */
function resolveLocalPointer(root: Record<string, unknown>, pointer: string): boolean {
  if (!pointer.startsWith("#/")) return false;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(2).split("/")) {
    if (!isPlainObject(current) && !Array.isArray(current)) return false;
    if (isPlainObject(current)) {
      if (!Object.hasOwn(current, rawSegment)) return false;
      current = current[rawSegment];
    } else {
      const index = Number(rawSegment);
      if (!Number.isInteger(index)) return false;
      const next = (current as unknown[])[index];
      if (next === undefined) return false;
      current = next;
    }
  }
  return true;
}

function isOfficialJsonSchemaUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "json-schema.org") {
    return true;
  }
  if (!hostname.endsWith(".json-schema.org")) {
    return false;
  }
  if (hostname.startsWith(".") || hostname.includes("..")) {
    return false;
  }
  return true;
}

export function discoverJsonSchemaContracts(
  workspaceId: string,
  relativePath: string,
  text: string,
): DiscoveryOutput {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId must not be empty");
  }
  const spec = parseStructuredSpec(relativePath, text);
  const root = spec.root;
  const diagnostics: ContractDiagnostic[] = [];

  const schemaUri = root["$schema"];
  const isOfficialSchema = isOfficialJsonSchemaUri(schemaUri);
  const hasSchemaMarks =
    isPlainObject(root["properties"]) ||
    isPlainObject(root["$defs"]) ||
    isPlainObject(root["definitions"]) ||
    typeof root["type"] === "string";

  if (!isOfficialSchema && !hasSchemaMarks) {
    diagnostics.push({
      relativePath,
      code: "contracts/json-schema-not-a-schema",
      message:
        "Root has no JSON Schema marker (no $schema/properties/$defs/definitions/type); no contract produced",
      line: spec.lineOf("$schema") ?? spec.lineOf("properties") ?? 1,
    });
    return { contracts: [], diagnostics };
  }

  const assumed = !isOfficialSchema;
  if (assumed) {
    diagnostics.push({
      relativePath,
      code: "contracts/json-schema-assumed",
      message: "No $schema field; assumed a schema from the properties/$defs/type markers",
      line: spec.lineOf("$schema") ?? spec.lineOf("properties") ?? 1,
    });
  }

  const id = typeof root["$id"] === "string" ? root["$id"] : undefined;
  const title = typeof root["title"] === "string" ? root["title"] : undefined;
  const stem = stemOf(relativePath);
  const name = id ?? title ?? stem;
  const qualifiedName = id ?? `schema:${stem}`;

  const requiredRaw = root["required"];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  // A set keeps the required check constant per property (CAU-04: no
  // per-property scan of the required list).
  const requiredNames = new Set(required);

  const properties: ContractProperty[] = [];
  const propsRoot = root["properties"];
  if (isPlainObject(propsRoot)) {
    for (const [propName, propRaw] of Object.entries(propsRoot)) {
      if (!isPlainObject(propRaw)) continue;
      properties.push({
        name: propName,
        type: propertyType(propRaw),
        required: requiredNames.has(propName),
      });
    }
  }
  properties.sort((a, b) => compareStrings(a.name, b.name));

  const refs: string[] = [];
  collectRefs(root, refs);
  const resolvedRefs: string[] = [];
  for (const ref of sortUnique(refs, compareStrings)) {
    if (ref.startsWith("#/")) {
      if (resolveLocalPointer(root, ref)) {
        resolvedRefs.push(ref);
      } else {
        diagnostics.push({
          relativePath,
          code: "contracts/json-schema-ref-unresolved",
          message: `Local $ref could not be resolved within the file: ${ref}`,
          line: spec.lineOf("$id") ?? spec.lineOf("properties") ?? 1,
        });
      }
    } else {
      diagnostics.push({
        relativePath,
        code: "contracts/json-schema-external-ref",
        message: `External $ref is not resolved (read-only local discovery; no network/filesystem access): ${ref}`,
        line: spec.lineOf("$id") ?? spec.lineOf("properties") ?? 1,
      });
    }
  }

  const evidenceLine = spec.lineOf("$id") ?? spec.lineOf("title") ?? spec.lineOf("$schema") ?? 1;

  const contract: ContractCandidate = {
    contractId: nodeId({
      workspaceId,
      kind: "SchemaContract",
      qualifiedName,
      relativePath,
    }),
    sourceKind: "json-schema",
    nodeKind: "SchemaContract",
    name,
    qualifiedName,
    responseSchemaIds: [],
    properties,
    requiredPropertyNames: [...required],
    resolvedRefs,
    certainty: diagnostics.length > 0 ? "partial" : "full",
    evidence: { relativePath, startLine: evidenceLine, endLine: evidenceLine },
    diagnostics: assumed ? ["json-schema: no $schema field, schema assumed"] : [],
  };
  return { contracts: [contract], diagnostics };
}
