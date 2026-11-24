import { z } from "zod";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  toolErrorGuidance,
  type CausorynToolError,
} from "./errors.js";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Standard MCP tool response envelope:
 *
 *   schemaVersion, requestId, workspaceId, snapshotId, status,
 *   coverage, warnings, data, nextCursor, error
 *
 * - status: "ok" | "partial" | "error".
 * - coverage: graph edge resolution statistics (overall + per-language byLanguage).
 * - error: fixed error codes (CAUSORYN_TOOL_ERROR_CODES); stack traces never leak.
 */

export const LanguageCoverageSchema = z.strictObject({
  tier: z.enum(["L0", "L1", "L2"]),
  files: z.number().int().nonnegative(),
  verifiedEdges: z.number().int().nonnegative(),
  heuristicEdges: z.number().int().nonnegative(),
  unresolvedEdges: z.number().int().nonnegative(),
  coverageRatio: z.number().min(0).max(1),
});

export type LanguageCoverage = z.infer<typeof LanguageCoverageSchema>;

export const CoverageSchema = z.strictObject({
  /** Highest adapter capability tier across analyzed workspace symbols (L0 when no AST symbols exist). */
  tier: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  resolvedEdges: z.number().int().nonnegative(),
  unresolvedEdges: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  coverageRatio: z.number().min(0).max(1),
  /** Per-language tier and edge breakdown (sorted keys) so one language never masks L0 degradation in another. */
  byLanguage: z.record(z.string(), LanguageCoverageSchema).optional(),
});

export type Coverage = z.infer<typeof CoverageSchema>;

export const IndexingInProgressDataSchema = z.strictObject({
  indexing: z.literal(true),
  status: z.literal("indexing"),
  jobId: z.string(),
  progress: z.strictObject({
    phase: z.string(),
    completed: z.number().int().min(0),
    total: z.number().int().positive(),
  }),
  retryAfterMs: z.number().int().positive(),
});

export type IndexingInProgressData = z.infer<typeof IndexingInProgressDataSchema>;

export const ToolErrorSchema = z.strictObject({
  code: z.enum(CAUSORYN_TOOL_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
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

/** Per-tool output schema: envelope + tool-specific data schema (or indexing-in-progress / null). */
export function envelopeOutputSchema(dataSchema: z.ZodType): z.ZodType {
  return EnvelopeSchema.extend({
    data: z.union([dataSchema, IndexingInProgressDataSchema, z.null()]),
  });
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

/** Builds a normalized envelope with all required fields populated. */
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

/** Builds a standardized error envelope with deterministic retryable/userAction guidance. */
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
