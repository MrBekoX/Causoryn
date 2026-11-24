import { z } from "zod";

import type {
  ArchitectureCheckResult,
  ContractsCheckResult,
  GraphDiffCheckResult,
  TestPlanCheckResult as LegacyTestPlanCheckResult,
  VerificationReport as LegacyVerificationReport,
  VerifyChangeInput as LegacyVerifyChangeInput,
} from "./types.js";

/**
 * E3 test status honesty schemas — host-supplied test runs are ALWAYS
 * recorded as `state: "host_asserted"` with `engineVerified: false`.
 *
 * Causoryn NEVER installs or executes a test runner and NEVER marks
 * self-reported host test claims as engine-verified `observed` / `passed: true`.
 *
 * Contract:
 * - OBSERVED_TEST_RUN_SCHEMA : host-supplied test run INPUT — `evidenceRef`
 *   is mandatory (non-blank); `evidenceSha256` (if provided) must be 64-char
 *   lowercase hex; `observedCount >= 1`. Accepts `"host_asserted"` or legacy
 *   `"observed"` on input and ALWAYS normalizes output to `"host_asserted"`.
 * - TEST_RUN_STATUS_SCHEMA   : report OUTPUT test run status — strict object
 *   with superRefine invariants:
 *   (1) `state: "not_run"` forbids evidence, counts, `engineVerified`, and
 *       `hostAssertedPassed`, and requires `observedCount === 0`;
 *   (2) `state: "host_asserted"` requires `engineVerified: false`, boolean
 *       `hostAssertedPassed`, non-blank `evidenceRef`, and `observedCount >= 1`;
 *   (3) `hostAssertedPassed: true` is allowed ONLY when `failedCount === 0 &&
 *       passedCount >= 1`;
 *   (4) engine-verified `passed` and `state: "observed"` are rejected at both
 *       the TypeScript type level and runtime Zod schema level.
 */

export interface ObservedTestRun {
  /** Accepts `"host_asserted"` or legacy `"observed"` on input; output is always `"host_asserted"`. */
  readonly state: "observed" | "host_asserted";
  /** Required file/provenance reference for the host-reported test run. */
  readonly evidenceRef: string;
  /** Optional 64-char lowercase hex SHA-256 digest of the referenced report file. */
  readonly evidenceSha256?: string;
  /** Optional supporting evidence IDs. */
  readonly evidenceIds?: readonly string[];
  /** Number of tests reported by the host (>= 1). */
  readonly observedCount: number;
  /** Number of passing tests reported by the host. */
  readonly passedCount?: number;
  /** Number of failing tests reported by the host. */
  readonly failedCount?: number;
  /** Explicit testNodeId or exact testQualifiedName bindings. */
  readonly testNames?: readonly string[];
}

export interface VerifyTestCandidateStatus {
  readonly candidateId: string;
  readonly testNodeId: string;
  readonly testQualifiedName: string;
  readonly status: "not_run" | "host_asserted";
}

export type VerifyTestStatus =
  | {
      readonly state: "not_run";
      readonly recommendedCount: number;
      readonly observedCount: 0;
    }
  | {
      readonly state: "host_asserted";
      /** Always false: Causoryn does not execute or independently verify host-reported tests. */
      readonly engineVerified: false;
      /** True only when host reported failedCount === 0 and passedCount >= 1 (still host-asserted). */
      readonly hostAssertedPassed: boolean;
      readonly recommendedCount: number;
      readonly observedCount: number;
      readonly evidenceRef: string;
      readonly evidenceSha256?: string;
      readonly evidenceIds?: readonly string[];
      readonly passedCount?: number;
      readonly failedCount?: number;
    };

export type TestPlanCheckResult = Omit<
  LegacyTestPlanCheckResult,
  "run" | "candidateStatuses"
> & {
  readonly run: VerifyTestStatus;
  readonly candidateStatuses: readonly VerifyTestCandidateStatus[];
};

export type VerificationReport = Omit<
  LegacyVerificationReport,
  "tests" | "checks"
> & {
  readonly tests: VerifyTestStatus;
  readonly checks: {
    readonly architecture: ArchitectureCheckResult;
    readonly contracts: ContractsCheckResult;
    readonly graphDiff: GraphDiffCheckResult;
    readonly testPlan: TestPlanCheckResult;
  };
};

export type VerifyChangeInput = Omit<LegacyVerifyChangeInput, "observedTestRun"> & {
  readonly observedTestRun?: ObservedTestRun;
};

/** 64 karakter küçük hex sha256 (kanıt dosyası karması). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Resource budget ceiling for observedTestRun.testNames/evidenceIds arrays.
 */
export const OBSERVED_RUN_ARRAY_CEILING = 200;

/** Ceiling rejection message (deterministic schema error). */
const OBSERVED_RUN_ARRAY_CEILING_MESSAGE =
  "at most 200 entries (resource budget ceiling prevents unbounded report growth)";

/** Non-blank string helper. */
const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "value must not be blank",
  });

/**
 * Host-supplied test run input schema. `evidenceRef` is mandatory; accepts
 * `"host_asserted"` or legacy `"observed"` on input and is always downgraded
 * to `state: "host_asserted"` (`engineVerified: false`) in report outputs.
 */
export const OBSERVED_TEST_RUN_SCHEMA = z.strictObject({
  state: z.enum(["observed", "host_asserted"]),
  evidenceRef: nonBlank,
  evidenceSha256: z
    .string()
    .regex(SHA256_HEX, "evidenceSha256 must be a 64-character lowercase hex sha256")
    .optional(),
  evidenceIds: z
    .array(nonBlank)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING, OBSERVED_RUN_ARRAY_CEILING_MESSAGE)
    .optional(),
  observedCount: z
    .number()
    .int("observedCount must be an integer")
    .min(1, "observedCount must be at least 1"),
  passedCount: z.number().int().min(0).optional(),
  failedCount: z.number().int().min(0).optional(),
  testNames: z
    .array(nonBlank)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING, OBSERVED_RUN_ARRAY_CEILING_MESSAGE)
    .optional(),
});

/**
 * Output test run status schema enforcing honesty invariants:
 * - Never permits engine-verified `state: "observed"` or `passed: true`.
 * - Host-supplied runs are strictly `state: "host_asserted"` with
 *   `engineVerified: false` and boolean `hostAssertedPassed`.
 */
export const TEST_RUN_STATUS_SCHEMA = z
  .strictObject({
    state: z.enum(["not_run", "host_asserted"]),
    engineVerified: z.literal(false).optional(),
    hostAssertedPassed: z.boolean().optional(),
    recommendedCount: z.number().int().min(0),
    observedCount: z.number().int().min(0),
    evidenceRef: nonBlank.optional(),
    evidenceSha256: z.string().regex(SHA256_HEX).optional(),
    evidenceIds: z.array(nonBlank).min(1).optional(),
    passedCount: z.number().int().min(0).optional(),
    failedCount: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.state === "host_asserted") {
      if (value.engineVerified !== false) {
        ctx.addIssue({
          code: "custom",
          path: ["engineVerified"],
          message:
            "host_asserted test status must set engineVerified: false (Causoryn does not execute or independently verify tests)",
        });
      }
      if (value.hostAssertedPassed === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["hostAssertedPassed"],
          message: "host_asserted test status must include boolean hostAssertedPassed",
        });
      }
      if (value.evidenceRef === undefined || value.evidenceRef.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message: "host_asserted test run requires a non-blank evidenceRef",
        });
      }
      if (value.observedCount < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["observedCount"],
          message: "host_asserted test run must have observedCount >= 1",
        });
      }
      if (
        value.hostAssertedPassed === true &&
        (value.passedCount === undefined ||
          value.failedCount === undefined ||
          value.failedCount !== 0 ||
          value.passedCount < 1)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["hostAssertedPassed"],
          message:
            "hostAssertedPassed may only be true when failedCount === 0 and passedCount >= 1",
        });
      }
    } else {
      // not_run: must not carry any evidence, engineVerified, or hostAssertedPassed claims.
      if (value.observedCount !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["observedCount"],
          message: "not_run test status must have observedCount === 0",
        });
      }
      if (value.engineVerified !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["engineVerified"],
          message: "not_run test status must not include engineVerified",
        });
      }
      if (value.hostAssertedPassed !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["hostAssertedPassed"],
          message: "not_run test status must not include hostAssertedPassed",
        });
      }
      if (value.evidenceRef !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message: "not_run test status must not include evidenceRef",
        });
      }
      if (value.evidenceSha256 !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceSha256"],
          message: "not_run test status must not include evidenceSha256",
        });
      }
      if (value.evidenceIds !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceIds"],
          message: "not_run test status must not include evidenceIds",
        });
      }
      if (value.passedCount !== undefined || value.failedCount !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passedCount"],
          message: "not_run test status must not include passedCount or failedCount",
        });
      }
    }
  });

/** Formats Zod issues into a deterministic single-line summary. */
export function formatZodIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)"}: ${issue.message}`,
    )
    .join("; ");
}
