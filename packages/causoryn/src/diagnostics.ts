/**
 * Error text for host config files that never quotes their content (CWE-209).
 * Host configs hold credentials (MCP server env values, tokens in args), so
 * `causoryn setup` and `causoryn doctor` report a broken file by its path,
 * the position and the key, never by the offending text.
 */

/**
 * A `JSON.parse` failure as its position only. V8's own message quotes the
 * source around the error (`Unexpected token 'S', "..." is not valid JSON`),
 * so only the digits of its position are carried over.
 */
export function describeJsonSyntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const lineColumn = /\(line (\d{1,9}) column (\d{1,9})\)/.exec(message);
  if (lineColumn !== null) {
    return `invalid JSON at line ${lineColumn[1] ?? "?"}, column ${lineColumn[2] ?? "?"}`;
  }
  const position = /\bat position (\d{1,12})\b/.exec(message);
  if (position !== null) {
    return `invalid JSON at character ${position[1] ?? "?"}`;
  }
  if (message.includes("Unexpected end of JSON input")) {
    return "invalid JSON: the file ends before the JSON value is complete";
  }
  return "invalid JSON syntax (an unexpected token)";
}
