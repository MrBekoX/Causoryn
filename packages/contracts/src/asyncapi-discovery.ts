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
 * AsyncAPI keşfi — TŞ §11: "AsyncAPI veya bilinen message schema
 * (topic/payload)".
 *
 * Belgelenmiş sınırlar (dilim):
 * - `asyncapi: 2.x` ve `3.x` kök alanı kabul edilir; bunun dışı →
 *   contracts/unsupported-spec. ANCAK şema sözdizimi yalnızca v2
 *   düzenindeki `channels.<topic>.publish|subscribe.message.payload`
 *   şekli keşfedilir; v3 `operations`/`messages` ayrımı bu dilimde
 *   yoktur → v3 belgelerinde "no-operations" diagnostic'ı düşer ve aday
 *   partial işaretlenir (dürüst degrade).
 * - Bir channel'da hem publish hem subscribe varsa İKİ ayrı aday üretilir;
 *   qualifiedName `<topic>#<direction>` ile ayrıştırılır.
 * - message/payload $ref'leri yalnızca YEREL dosya içinde
 *   ("#/components/messages|schemas/...") çözümlenir.
 */

const CHANNEL_OPERATIONS = ["publish", "subscribe"] as const;

type ChannelDirection = (typeof CHANNEL_OPERATIONS)[number];

function lastRefSegment(ref: string): string {
  const segments = ref.split("/");
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? ref : last;
}

function resolveLocalComponent(
  ref: string,
  group: string,
  components: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!ref.startsWith(`#/components/${group}/`) || components === undefined) return undefined;
  const found = components[group];
  if (!isPlainObject(found)) return undefined;
  const entry = found[lastRefSegment(ref)];
  return isPlainObject(entry) ? entry : undefined;
}

interface SchemaShape {
  readonly required: readonly string[];
  readonly properties: readonly ContractProperty[];
}

function readShape(schema: Record<string, unknown>): SchemaShape {
  const requiredRaw = schema["required"];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
    : [];
  const propertiesRaw = schema["properties"];
  const properties: ContractProperty[] = [];
  if (isPlainObject(propertiesRaw)) {
    for (const [name, propRaw] of Object.entries(propertiesRaw)) {
      if (!isPlainObject(propRaw)) continue;
      const typeRaw = propRaw["type"];
      const type =
        typeof typeRaw === "string"
          ? typeRaw
          : typeof propRaw["$ref"] === "string"
            ? "ref"
            : "unknown";
      properties.push({ name, type, required: required.includes(name) });
    }
  }
  properties.sort((a, b) => compareStrings(a.name, b.name));
  return { required, properties };
}

export function discoverAsyncApiContracts(
  workspaceId: string,
  relativePath: string,
  text: string,
): DiscoveryOutput {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId boş olamaz");
  }
  const spec = parseStructuredSpec(relativePath, text);
  const root = spec.root;

  const version = root["asyncapi"];
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "AsyncAPI belgesinde 'asyncapi' string alanı zorunludur",
    );
  }
  if (!version.startsWith("2.") && !version.startsWith("3.")) {
    throw new ContractDiscoveryError(
      "contracts/unsupported-spec",
      `Desteklenmeyen AsyncAPI ana sürümü: ${version} (2.x ve 3.x keşfedilir)`,
    );
  }
  const channels = root["channels"];
  if (!isPlainObject(channels)) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "AsyncAPI belgesinde 'channels' eşlemesi zorunludur",
    );
  }
  const components = isPlainObject(root["components"])
    ? (root["components"] as Record<string, unknown>)
    : undefined;

  const contracts: ContractCandidate[] = [];
  const diagnostics: ContractDiagnostic[] = [];

  for (const [topic, channelRaw] of Object.entries(channels)) {
    const topicLine = spec.lineOf("channels", topic) ?? 1;
    if (!isPlainObject(channelRaw)) {
      diagnostics.push({
        relativePath,
        code: "contracts/asyncapi-channel-invalid",
        message: `channels["${topic}"] bir eşleme değil; channel yok sayıldı`,
        line: topicLine,
      });
      continue;
    }
    const channel = channelRaw;
    let recognizedOperation = false;

    for (const direction of CHANNEL_OPERATIONS) {
      const opRaw = channel[direction];
      if (!isPlainObject(opRaw)) continue;
      recognizedOperation = true;
      let refUnresolved = false;
      const resolvedRefs: string[] = [];

      // message: inline veya yerel #/components/messages $ref'i
      let message = isPlainObject(opRaw["message"]) ? (opRaw["message"] as Record<string, unknown>) : undefined;
      const messageRef = message?.["$ref"];
      if (typeof messageRef === "string") {
        const resolved = resolveLocalComponent(messageRef, "messages", components);
        if (resolved !== undefined) {
          message = resolved;
          resolvedRefs.push(messageRef);
        } else {
          refUnresolved = true;
          diagnostics.push({
            relativePath,
            code: "contracts/asyncapi-message-ref-unresolved",
            message: `message $ref dosya içinde çözümlenemedi: ${messageRef}`,
            line: topicLine,
          });
        }
      }

      let payloadSchemaId: string | undefined;
      let shape: SchemaShape = { required: [], properties: [] };
      const payload = message === undefined ? undefined : message["payload"];
      if (isPlainObject(payload)) {
        const payloadRef = payload["$ref"];
        if (typeof payloadRef === "string") {
          payloadSchemaId = lastRefSegment(payloadRef);
          const resolved = resolveLocalComponent(payloadRef, "schemas", components);
          if (resolved !== undefined) {
            shape = readShape(resolved);
            resolvedRefs.push(payloadRef);
          } else {
            refUnresolved = true;
            diagnostics.push({
              relativePath,
              code: "contracts/asyncapi-payload-ref-unresolved",
              message: `payload $ref dosya içinde çözümlenemedi: ${payloadRef}`,
              line: topicLine,
            });
          }
        } else {
          shape = readShape(payload);
        }
      }

      const qualifiedName = `${topic}#${direction}`;
      const certainty: ContractCandidate["certainty"] = refUnresolved ? "partial" : "full";
      contracts.push({
        contractId: nodeId({
          workspaceId,
          kind: "EventContract",
          qualifiedName,
          relativePath,
        }),
        sourceKind: "asyncapi",
        nodeKind: "EventContract",
        name: topic,
        qualifiedName,
        topic,
        channelDirection: direction satisfies ChannelDirection,
        responseSchemaIds: [],
        properties: shape.properties,
        requiredPropertyNames: [...shape.required],
        resolvedRefs: sortUnique(resolvedRefs, compareStrings),
        certainty,
        evidence: { relativePath, startLine: topicLine, endLine: topicLine },
        diagnostics: [],
        ...(payloadSchemaId === undefined ? {} : { payloadSchemaId }),
      });
    }

    if (!recognizedOperation) {
      diagnostics.push({
        relativePath,
        code: "contracts/asyncapi-no-operations",
        message: `channels["${topic}"] altında publish/subscribe operasyonu yok (v3 operations düzeni bu dilimde keşfedilmez)`,
        line: topicLine,
      });
      contracts.push({
        contractId: nodeId({
          workspaceId,
          kind: "EventContract",
          qualifiedName: `${topic}#none`,
          relativePath,
        }),
        sourceKind: "asyncapi",
        nodeKind: "EventContract",
        name: topic,
        qualifiedName: `${topic}#none`,
        topic,
        responseSchemaIds: [],
        properties: [],
        requiredPropertyNames: [],
        resolvedRefs: [],
        certainty: "partial",
        evidence: { relativePath, startLine: topicLine, endLine: topicLine },
        diagnostics: ["asyncapi: yön (publish/subscribe) bu dilimde belirlenemedi"],
      });
    }
  }

  contracts.sort(
    (a, b) =>
      compareStrings(a.qualifiedName, b.qualifiedName) ||
      compareStrings(a.evidence.relativePath, b.evidence.relativePath) ||
      a.evidence.startLine - b.evidence.startLine,
  );
  return { contracts, diagnostics };
}
