import { ContractDiscoveryError } from "./errors.js";
import { MAX_SPEC_NODES } from "./parse-safety.js";

/**
 * Total projection work budget for one spec document (CAU-04, CWE-407/400).
 *
 * The parser limits (MAX_SPEC_BYTES, MAX_SPEC_DEPTH, MAX_SPEC_NODES) bound the
 * INPUT. Projection can still multiply it: every OpenAPI operation or AsyncAPI
 * channel that points at the same local `$ref` schema emits that schema's
 * property list again. The budget bounds the projection itself, counted in
 * deterministic work units (never wall-clock time):
 *
 * - 1 unit per key-path segment looked up for line evidence (`lineOf`), and
 *   1 unit per map entry the first time a map's key index is built;
 * - 1 unit per `$ref` lookup (each distinct reference string is resolved only
 *   once), and, only the first time a schema object is expanded, 1 unit per
 *   `properties` entry and per `required` entry it scans (repeated references
 *   reuse that shape);
 * - per projected candidate: 1 unit, plus 1 per emitted property, required
 *   name and response schema id (emitted representations are counted even
 *   when shared, because they are what the output carries);
 * - per emitted diagnostic: 1 unit;
 * - emitted text by length (textUnits): every string a candidate or diagnostic
 *   carries (names, route/topic, path, schema ids, refs, property names and
 *   types, messages) adds 1 unit per full TEXT_UNIT_CHARS characters, so a
 *   long scalar repeated through a shared `$ref` or a YAML alias is paid for
 *   at every repetition. Strings shorter than TEXT_UNIT_CHARS add nothing.
 *
 * Default: MAX_PROJECTION_WORK_UNITS = 4 x MAX_SPEC_NODES (1,000,000). A
 * document within the parser limits projects each of its nodes a few times
 * over (key index, lookup, candidate, property), so ordinary specs use a small
 * fraction of it; only fan-out through shared references can reach it.
 * Crossing the budget throws ContractDiscoveryError "contracts/limit-exceeded"
 * (the MCP handlers map it to LIMIT_EXCEEDED). The message carries counts
 * only, never source text.
 */
export const MAX_PROJECTION_WORK_UNITS = 4 * MAX_SPEC_NODES;

/** Characters of emitted text covered by the element unit; each further full block costs 1 unit. */
export const TEXT_UNIT_CHARS = 64;

/** Text work units of the given strings: 1 per full TEXT_UNIT_CHARS characters (undefined counts 0). */
export function textUnits(...values: ReadonlyArray<string | undefined>): number {
  let units = 0;
  for (const value of values) {
    if (value !== undefined) units += Math.floor(value.length / TEXT_UNIT_CHARS);
  }
  return units;
}

export class ProjectionBudget {
  readonly limit: number;
  #used = 0;

  constructor(limit: number = MAX_PROJECTION_WORK_UNITS) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        "projection budget limit must be a positive safe integer",
      );
    }
    this.limit = limit;
  }

  /** Work units charged so far. */
  get used(): number {
    return this.#used;
  }

  /** Charges `units` of work; throws contracts/limit-exceeded once the total passes the limit. */
  charge(units: number): void {
    this.#used += units;
    if (this.#used > this.limit) {
      throw new ContractDiscoveryError(
        "contracts/limit-exceeded",
        `Spec projection work budget exceeded (> ${String(this.limit)} work units); ` +
          "the document fans out to more routes, channels or schema properties than one projection may emit",
      );
    }
  }
}

/** Optional projection settings; omitted → a fresh default budget per document. */
export interface ProjectionOptions {
  readonly budget?: ProjectionBudget;
}
