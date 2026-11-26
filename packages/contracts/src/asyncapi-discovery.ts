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
 * - Cost (CAU-04): line evidence comes from per-document indexes, each `$ref`
 *   string is resolved once and each schema object expanded once; the whole
 *   projection is metered by a ProjectionBudget (default
 *   MAX_PROJECTION_WORK_UNITS) and stops with contracts/limit-exceeded.
 */

const CHANNEL_OPERATIONS = ["publish", "subscribe"] as const;

type ChannelDirection = (typeof CHANNEL_OPERATIONS)[number];

/** A `$ref` string resolved once per document. */
interface ResolvedComponentRef {
  readonly id: string;
  readonly target: Record<string, unknown> | undefined;
}

function resolveLocalComponent(
  ref: string,
  group: string,
  components: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!ref.startsWith(`#/components/${group}/`) || components === undefined) return undefined;
  const found = components[group];
  if (!isPlainObject(found)) return undefined;
  const key = lastRefSegment(ref);
  // Güvenlik (denetim bulgusu): yalnızca KENDİ alan — "__proto__" gibi
  // segmentler prototip zincirine yürüyüp çözümlenmiş sayılamaz (Object.hasOwn).
  if (!Object.hasOwn(found, key)) return undefined;
  const entry = found[key];
  return isPlainObject(entry) ? entry : undefined;
}

export function discoverAsyncApiContracts(
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

  const version = root["asyncapi"];
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "AsyncAPI document must have a string 'asyncapi' field",
    );
  }
  if (!version.startsWith("2.") && !version.startsWith("3.")) {
    throw new ContractDiscoveryError(
      "contracts/unsupported-spec",
      `Unsupported AsyncAPI major version: ${version} (only 2.x and 3.x are discovered)`,
    );
  }
  const channels = root["channels"];
  if (!isPlainObject(channels)) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      "AsyncAPI document must have a 'channels' mapping",
    );
  }
  const components = isPlainObject(root["components"])
    ? (root["components"] as Record<string, unknown>)
    : undefined;
  const messageRefs = new RefCache<ResolvedComponentRef>(budget, (ref) => ({
    id: lastRefSegment(ref),
    target: resolveLocalComponent(ref, "messages", components),
  }));
  const payloadRefs = new RefCache<ResolvedComponentRef>(budget, (ref) => ({
    id: lastRefSegment(ref),
    target: resolveLocalComponent(ref, "schemas", components),
  }));
  const shapes = new SchemaShapeCache(budget);

  const contracts: ContractCandidate[] = [];
  const diagnostics: ContractDiagnostic[] = [];
  /** Diagnostics are emitted output too: 1 unit each plus their text (messages quote topics/refs). */
  const report = (diagnostic: ContractDiagnostic): void => {
    budget.charge(1 + textUnits(diagnostic.message, diagnostic.relativePath));
    diagnostics.push(diagnostic);
  };

  for (const [topic, channelRaw] of Object.entries(channels)) {
    const topicLine = spec.lineOf("channels", topic) ?? 1;
    if (!isPlainObject(channelRaw)) {
      report({
        relativePath,
        code: "contracts/asyncapi-channel-invalid",
        message: `channels["${topic}"] is not a mapping; channel ignored`,
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
        const resolved = messageRefs.get(messageRef).target;
        if (resolved !== undefined) {
          message = resolved;
          resolvedRefs.push(messageRef);
        } else {
          refUnresolved = true;
          report({
            relativePath,
            code: "contracts/asyncapi-message-ref-unresolved",
            message: `message $ref could not be resolved within the file: ${messageRef}`,
            line: topicLine,
          });
        }
      }

      let payloadSchemaId: string | undefined;
      let shape: SchemaShape = EMPTY_SCHEMA_SHAPE;
      const payload = message === undefined ? undefined : message["payload"];
      if (isPlainObject(payload)) {
        const payloadRef = payload["$ref"];
        if (typeof payloadRef === "string") {
          const resolvedPayload = payloadRefs.get(payloadRef);
          payloadSchemaId = resolvedPayload.id;
          const resolved = resolvedPayload.target;
          if (resolved !== undefined) {
            shape = shapes.shapeOf(resolved);
            resolvedRefs.push(payloadRef);
          } else {
            refUnresolved = true;
            report({
              relativePath,
              code: "contracts/asyncapi-payload-ref-unresolved",
              message: `payload $ref could not be resolved within the file: ${payloadRef}`,
              line: topicLine,
            });
          }
        } else {
          shape = shapes.shapeOf(payload);
        }
      }

      const qualifiedName = `${topic}#${direction}`;
      const certainty: ContractCandidate["certainty"] = refUnresolved ? "partial" : "full";
      // Emitted representation is charged per candidate, even when the shape is
      // shared: elements plus text by length.
      budget.charge(
        1 +
          shape.emitUnits +
          textUnits(topic, qualifiedName, topic, relativePath, payloadSchemaId, ...resolvedRefs),
      );
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
        properties: [...shape.properties],
        requiredPropertyNames: [...shape.required],
        resolvedRefs: sortUnique(resolvedRefs, compareStrings),
        certainty,
        evidence: { relativePath, startLine: topicLine, endLine: topicLine },
        diagnostics: [],
        ...(payloadSchemaId === undefined ? {} : { payloadSchemaId }),
      });
    }

    if (!recognizedOperation) {
      report({
        relativePath,
        code: "contracts/asyncapi-no-operations",
        message: `channels["${topic}"] has no publish/subscribe operation (the AsyncAPI v3 operations layout is not discovered by this parser)`,
        line: topicLine,
      });
      const noneName = `${topic}#none`;
      const noneNote = "asyncapi: direction (publish/subscribe) could not be determined by this parser";
      budget.charge(1 + textUnits(topic, noneName, topic, relativePath, noneNote));
      contracts.push({
        contractId: nodeId({
          workspaceId,
          kind: "EventContract",
          qualifiedName: noneName,
          relativePath,
        }),
        sourceKind: "asyncapi",
        nodeKind: "EventContract",
        name: topic,
        qualifiedName: noneName,
        topic,
        responseSchemaIds: [],
        properties: [],
        requiredPropertyNames: [],
        resolvedRefs: [],
        certainty: "partial",
        evidence: { relativePath, startLine: topicLine, endLine: topicLine },
        diagnostics: [noneNote],
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
