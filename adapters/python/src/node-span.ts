/**
 * Worker node span → node `location` mapping (PROTOCOL.md "Node fields":
 * optional `span: { startLine, endLine }`, 1-based, inclusive).
 *
 * Worker output is not trusted: the span is copied only when it is a pair of
 * positive integers with startLine <= endLine that ends inside the file the
 * adapter sent, and only for a non-File node bound to that file. The location
 * takes its relativePath and sourceHash from the adapter's own request, never
 * from the worker. A rejected span is dropped (the node keeps the indexer's
 * file anchor) and reported once per response by `nodeSpanWarnings`.
 */
import type { SourceSpan } from "@causoryn/domain";

/** One analyzed file as the adapter sent it to the worker. */
export interface NodeSpanSource {
  readonly sourceHash: string;
  /** Upper bound for a 1-based line number inside the file. */
  readonly lineCount: number;
}

/**
 * Number of lines of `content` counted with every line terminator a worker may
 * use (CRLF, CR, LF, NEL, LS, PS; CRLF counts once), so it bounds the line
 * numbers of all workers (Roslyn uses all of them, Python CR/LF, Go and syn LF).
 */
export function countSourceLines(content: string): number {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x0d) {
      lines += 1;
      if (content.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (code === 0x0a || code === 0x85 || code === 0x2028 || code === 0x2029) {
      lines += 1;
    }
  }
  return lines;
}

/** Builds the span sources of the files sent to the worker. */
export function nodeSpanSources(
  entries: ReadonlyArray<{
    readonly relativePath: string;
    readonly content: string;
    readonly sourceHash: string;
  }>,
): ReadonlyMap<string, NodeSpanSource> {
  return new Map(
    entries.map((entry) => [
      entry.relativePath,
      { sourceHash: entry.sourceHash, lineCount: countSourceLines(entry.content) },
    ]),
  );
}

/** Longest qualified name quoted in a span warning. */
const MAX_LABEL_NAME_CHARS = 200;

function isPositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Maps the raw worker `span` of one node to its `location`. Returns undefined
 * when the node has no span or when the span is rejected (the reason is pushed
 * to `rejected`).
 */
export function mapNodeLocation(
  raw: unknown,
  node: { readonly kind: string; readonly qualifiedName: string; readonly relativePath?: string },
  sources: ReadonlyMap<string, NodeSpanSource>,
  rejected: string[],
): SourceSpan | undefined {
  if (raw === undefined) return undefined;
  // The name comes from the worker: bounded before it reaches a warning.
  const name =
    node.qualifiedName.length > MAX_LABEL_NAME_CHARS
      ? `${node.qualifiedName.slice(0, MAX_LABEL_NAME_CHARS)}...`
      : node.qualifiedName;
  const label = `${node.kind} ${name}`;
  const reject = (reason: string): undefined => {
    rejected.push(`${label}: ${reason}`);
    return undefined;
  };

  if (node.kind === "File") return reject("File nodes carry no span");
  const source = node.relativePath === undefined ? undefined : sources.get(node.relativePath);
  if (node.relativePath === undefined || source === undefined) {
    return reject("the node is not bound to an analyzed file");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("span is not an object");
  }
  const { startLine, endLine } = raw as Record<string, unknown>;
  if (!isPositiveLine(startLine) || !isPositiveLine(endLine)) {
    return reject("startLine and endLine must be positive integers");
  }
  if (startLine > endLine) {
    return reject(`startLine ${String(startLine)} is after endLine ${String(endLine)}`);
  }
  if (endLine > source.lineCount) {
    return reject(
      `endLine ${String(endLine)} is past the last line (${String(source.lineCount)}) of the file`,
    );
  }
  return { relativePath: node.relativePath, startLine, endLine, sourceHash: source.sourceHash };
}

/** One summary warning for the spans rejected in a response (none when all were valid). */
export function nodeSpanWarnings(rejected: readonly string[]): string[] {
  if (rejected.length === 0) return [];
  const count = rejected.length === 1 ? "1 invalid node span" : `${String(rejected.length)} invalid node spans`;
  return [
    `dropped ${count} from the worker; those nodes keep their file anchor (first: ${rejected[0] ?? ""})`,
  ];
}
