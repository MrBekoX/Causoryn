/**
 * In-memory `ConfinedFsProbe` for OS-independent tests of the confined
 * TypeScript compiler host. Paths are matched exactly (POSIX or drive style),
 * every call is recorded so tests can assert which paths were touched.
 */
import type {
  ConfinedFsProbe,
  ConfinedFsStat,
  ConfinedReadResult,
} from "../src/confined-fs.js";

export interface FakeConfinedFsSpec {
  /** Real directories. */
  readonly dirs?: readonly string[];
  /** Regular files and their content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Symbolic links / junctions and their raw target. */
  readonly links?: Readonly<Record<string, string>>;
  /** Non-regular entries (FIFO, socket, device). */
  readonly others?: readonly string[];
  /** realpath() results for the region bases (default: the path itself when it is a directory). */
  readonly realpaths?: Readonly<Record<string, string>>;
  /** readdir() results; default derives the direct children from the spec. */
  readonly readdirs?: Readonly<Record<string, readonly string[]>>;
}

export interface FakeConfinedFs extends ConfinedFsProbe {
  /** `<operation> <path>` for every probe call, in call order. */
  readonly calls: string[];
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function createFakeConfinedFs(spec: FakeConfinedFsSpec): FakeConfinedFs {
  const dirs = new Set(spec.dirs ?? []);
  const files = new Map(Object.entries(spec.files ?? {}));
  const links = new Map(Object.entries(spec.links ?? {}));
  const others = new Set(spec.others ?? []);
  const calls: string[] = [];

  const childrenOf = (dir: string): string[] => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const entry of [...dirs, ...files.keys(), ...links.keys(), ...others]) {
      if (!entry.startsWith(prefix)) continue;
      const rest = entry.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue;
      names.add(rest);
    }
    return [...names];
  };

  return {
    calls,
    realpath(path: string): string | undefined {
      calls.push(`realpath ${path}`);
      const mapped = spec.realpaths?.[path];
      if (mapped !== undefined) return mapped;
      return dirs.has(path) ? path : undefined;
    },
    lstat(path: string): ConfinedFsStat | undefined {
      calls.push(`lstat ${path}`);
      if (links.has(path)) return { kind: "symlink", size: 0 };
      if (dirs.has(path)) return { kind: "directory", size: 0 };
      const content = files.get(path);
      if (content !== undefined) return { kind: "file", size: byteLength(content) };
      if (others.has(path)) return { kind: "other", size: 0 };
      return undefined;
    },
    readlink(path: string): string | undefined {
      calls.push(`readlink ${path}`);
      return links.get(path);
    },
    readdir(path: string): readonly string[] | undefined {
      calls.push(`readdir ${path}`);
      const listed = spec.readdirs?.[path];
      if (listed !== undefined) return listed;
      return dirs.has(path) ? childrenOf(path) : undefined;
    },
    readText(path: string, expected: ConfinedFsStat, maxBytes: number): ConfinedReadResult {
      calls.push(`readText ${path}`);
      if (expected.kind !== "file") return { status: "unreadable" };
      const content = files.get(path);
      if (content === undefined) return { status: "unreadable" };
      const bytes = byteLength(content);
      if (bytes > maxBytes) return { status: "too-large" };
      return { status: "ok", text: content, bytes };
    },
  };
}
