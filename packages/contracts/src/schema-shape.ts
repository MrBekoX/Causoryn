import { isPlainObject } from "./parse-safety.js";
import { compareStrings } from "./order.js";
import { textUnits, type ProjectionBudget } from "./projection-budget.js";
import type { ContractProperty } from "./types.js";

/**
 * Schema shapes (required names + one-level property list) shared by the
 * OpenAPI and AsyncAPI projections, memoized per document (CAU-04).
 *
 * A shape is read from ONE schema object: `properties` entries become
 * {name, type, required}; a property that is itself a `$ref` is reported as
 * type "ref" and is not followed. Expansion therefore never recurses, so `$ref`
 * cycles (A → B → A, or a property pointing back at its own schema) end after
 * one hop by construction.
 */

export interface SchemaShape {
  readonly required: readonly string[];
  readonly properties: readonly ContractProperty[];
  /**
   * Work units of emitting this shape once in a candidate: 1 per property and
   * per required name, plus the text units of their names and types.
   */
  readonly emitUnits: number;
}

export const EMPTY_SCHEMA_SHAPE: SchemaShape = { required: [], properties: [], emitUnits: 0 };

/**
 * Shapes keyed by schema object identity: the target of every `$ref` to the
 * same component, and an inline schema repeated through YAML aliases, are
 * expanded once; later lookups return the same shape (and the same property
 * objects). The first expansion charges 1 unit per `properties` entry and per
 * `required` entry it scans.
 */
export class SchemaShapeCache {
  readonly #shapes = new WeakMap<Record<string, unknown>, SchemaShape>();
  readonly #budget: ProjectionBudget;

  constructor(budget: ProjectionBudget) {
    this.#budget = budget;
  }

  shapeOf(schema: Record<string, unknown>): SchemaShape {
    const cached = this.#shapes.get(schema);
    if (cached !== undefined) return cached;

    const requiredRaw = schema["required"];
    const propertiesRaw = schema["properties"];
    const entries = isPlainObject(propertiesRaw) ? Object.entries(propertiesRaw) : [];
    this.#budget.charge((Array.isArray(requiredRaw) ? requiredRaw.length : 0) + entries.length);

    const required = Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
      : [];
    const requiredNames = new Set(required);
    const properties: ContractProperty[] = [];
    for (const [name, propRaw] of entries) {
      if (!isPlainObject(propRaw)) continue;
      const typeRaw = propRaw["type"];
      const type =
        typeof typeRaw === "string"
          ? typeRaw
          : typeof propRaw["$ref"] === "string"
            ? "ref"
            : "unknown";
      properties.push({ name, type, required: requiredNames.has(name) });
    }
    properties.sort((a, b) => compareStrings(a.name, b.name));

    // Loops, not spreads: `required` can be long enough to overflow call arguments.
    let emitUnits = properties.length + required.length;
    for (const name of required) emitUnits += textUnits(name);
    for (const property of properties) emitUnits += textUnits(property.name, property.type);

    const shape: SchemaShape = { required, properties, emitUnits };
    this.#shapes.set(schema, shape);
    return shape;
  }
}

/**
 * `$ref` string → resolution, computed once per distinct reference string and
 * reused; every lookup charges 1 unit. Keeps repeated (also alias-repeated)
 * references from re-splitting and re-resolving the same pointer.
 */
export class RefCache<T> {
  readonly #resolved = new Map<string, T>();
  readonly #budget: ProjectionBudget;
  readonly #resolve: (ref: string) => T;

  constructor(budget: ProjectionBudget, resolve: (ref: string) => T) {
    this.#budget = budget;
    this.#resolve = resolve;
  }

  get(ref: string): T {
    this.#budget.charge(1);
    if (this.#resolved.has(ref)) return this.#resolved.get(ref) as T;
    const value = this.#resolve(ref);
    this.#resolved.set(ref, value);
    return value;
  }
}

/** Last `/` segment of a reference (the schema id); the whole string if that segment is empty. */
export function lastRefSegment(ref: string): string {
  const segments = ref.split("/");
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? ref : last;
}
