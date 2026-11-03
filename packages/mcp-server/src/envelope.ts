import { z } from "zod";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  toolErrorGuidance,
  type CausorynToolError,
} from "./errors.js";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Standart envelope (TŞ v2.1 §10.1 örneği, wiki/mcp-tools.md):
 *
 *   schemaVersion, requestId, workspaceId, snapshotId, status,
 *   coverage, warnings, data, nextCursor (+ hata için error)
 *
 * - status: "ok" | "partial" | "error".
 * - coverage: snapshot graph'ından türetilen çözümlenme istatistiği.
 * - error: sabit hata kodları (CAUSORYN_TOOL_ERROR_CODES); stack trace
 *   sonucun GİRMEZ (TŞ §10.1). data, AMBIGUOUS_SYMBOL'da aday listesi
 *   taşır (TŞ §10.3 requiresDisambiguation deseni), diğer hatalarda null.
 * - Her tool çıktısı SDK outputSchema ile bu şemadan doğrulanır.
 */

export const CoverageSchema = z.strictObject({
  /** Adapter yetenek düzeyi: TS Faz A → L2; analiz edilebilir kaynak yokken L0. */
  tier: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  resolvedEdges: z.number().int().nonnegative(),
  unresolvedEdges: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  coverageRatio: z.number().min(0).max(1),
});

export type Coverage = z.infer<typeof CoverageSchema>;

export const ToolErrorSchema = z.strictObject({
  code: z.enum(CAUSORYN_TOOL_ERROR_CODES),
  message: z.string(),
  /** TŞ §10.1: "Tekrar denenebilirlik ... belirtilir." */
  retryable: z.boolean(),
  /** TŞ §10.1: "... ve kullanici aksiyonu belirtilir." */
  userAction: z.string().min(1),
});

export const EnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: z.string(),
  workspaceId: z.string().nullable(),
  snapshotId: z.string().nullable(),
  status: z.enum(["ok", "partial", "error"]),
  coverage: CoverageSchema.nullable(),
  warnings: z.array(z.string()),
  data: z.unknown(),
  nextCursor: z.string().nullable(),
  error: ToolErrorSchema.nullable(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Per-tool output şeması: envelope + tool'a özgü data şeması. */
export function envelopeOutputSchema(dataSchema: z.ZodType): z.ZodType {
  return EnvelopeSchema.extend({ data: z.union([dataSchema, z.null()]) });
}

export interface EnvelopeInput {
  readonly requestId: string;
  readonly workspaceId: string | null;
  readonly snapshotId: string | null;
  readonly status: "ok" | "partial" | "error";
  readonly coverage: Coverage | null;
  readonly warnings: readonly string[];
  readonly data: unknown;
  readonly nextCursor?: string | null;
  readonly error?:
    | {
        readonly code: CausorynToolError["code"];
        readonly message: string;
        readonly retryable: boolean;
        readonly userAction: string;
      }
    | null;
}

/** Envelope nesnesi kurar; tüm alanlar her yanıtta mevcuttur. */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    snapshotId: input.snapshotId,
    status: input.status,
    coverage: input.coverage,
    warnings: [...input.warnings],
    data: input.data,
    nextCursor: input.nextCursor ?? null,
    error:
      input.error === undefined || input.error === null
        ? null
        : {
            code: input.error.code,
            message: input.error.message,
            retryable: input.error.retryable,
            userAction: input.error.userAction,
          },
  };
}

/** Hata envelope'u: code + mesaj + sabit retryable/userAction rehberi. */
export function errorEnvelope(
  requestId: string,
  workspaceId: string | null,
  snapshotId: string | null,
  error: CausorynToolError,
): Envelope {
  const guidance = toolErrorGuidance(error.code);
  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId,
    status: "error",
    coverage: null,
    warnings: [],
    data: error.details ?? null,
    nextCursor: null,
    error: {
      code: error.code,
      message: error.message,
      retryable: guidance.retryable,
      userAction: guidance.userAction,
    },
  });
}
