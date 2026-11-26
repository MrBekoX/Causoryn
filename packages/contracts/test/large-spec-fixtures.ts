/**
 * Generated in-test fixtures for the CAU-04 projection-cost tests: large but
 * valid OpenAPI/AsyncAPI documents that stay inside the parser limits
 * (MAX_SPEC_BYTES, MAX_SPEC_NODES). Every route/channel points at ONE shared
 * `#/components/schemas/Shared` schema, so a naive projection re-expands the
 * same schema once per operation. The generators also return the 1-based line
 * of every route/channel key, so evidence lines can be checked exactly.
 */

export interface GeneratedSpec {
  readonly text: string;
  /** route (OpenAPI) or topic (AsyncAPI) → 1-based line of its key. */
  readonly keyLines: ReadonlyMap<string, number>;
}

export interface GenerateOptions {
  /** Line terminator; default "\n". */
  readonly eol?: string;
  /** `type` of every Shared property; default "string". */
  readonly propertyType?: string;
}

function sharedSchemaLines(properties: number, propertyType = "string"): string[] {
  const names = Array.from({ length: properties }, (_, index) => `field${String(index)}`);
  const lines = ["components:", "  schemas:", "    Shared:", "      type: object"];
  lines.push(names.length === 0 ? "      required: []" : `      required: [${names.join(", ")}]`);
  lines.push("      properties:");
  for (const name of names) {
    lines.push(`        ${name}:`, `          type: ${propertyType}`);
  }
  if (names.length === 0) lines.pop();
  return lines;
}

export function routeName(index: number): string {
  return `/resource${String(index)}`;
}

export function topicName(index: number): string {
  return `topic.${String(index)}`;
}

/** OpenAPI 3.1: `routes` paths, each `post` with a request body `$ref` to Shared. */
export function generateOpenApi(routes: number, properties: number, options: GenerateOptions = {}): GeneratedSpec {
  const lines = ["openapi: 3.1.0", "info:", "  title: Generated API", "  version: 1.0.0", "paths:"];
  const keyLines = new Map<string, number>();
  for (let index = 0; index < routes; index += 1) {
    const route = routeName(index);
    lines.push(`  ${route}:`);
    keyLines.set(route, lines.length);
    lines.push(
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema:",
      '              $ref: "#/components/schemas/Shared"',
      "      responses:",
      '        "200":',
      "          content:",
      "            application/json:",
      "              schema:",
      '                $ref: "#/components/schemas/Shared"',
    );
  }
  lines.push(...sharedSchemaLines(properties, options.propertyType));
  return { text: lines.join(options.eol ?? "\n"), keyLines };
}

/** AsyncAPI 2.6: `channels` topics, each `publish` with a payload `$ref` to Shared. */
export function generateAsyncApi(channels: number, properties: number, options: GenerateOptions = {}): GeneratedSpec {
  const lines = ["asyncapi: 2.6.0", "info:", "  title: Generated events", "  version: 1.0.0", "channels:"];
  const keyLines = new Map<string, number>();
  for (let index = 0; index < channels; index += 1) {
    const topic = topicName(index);
    lines.push(`  ${topic}:`);
    keyLines.set(topic, lines.length);
    lines.push(
      "    publish:",
      "      message:",
      "        payload:",
      '          $ref: "#/components/schemas/Shared"',
    );
  }
  lines.push(...sharedSchemaLines(properties, options.propertyType));
  return { text: lines.join(options.eol ?? "\n"), keyLines };
}
