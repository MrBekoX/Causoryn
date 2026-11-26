/**
 * POSIX path semantics for the git metadata check, on every platform:
 * validateRepositoryLayout runs against an in-memory POSIX file system, with
 * node:path mapped to path.posix and process.platform reported as "linux"
 * while the module is loaded and called. This covers behaviour a Windows host
 * would otherwise never run: a backslash is an ordinary file-name character
 * (also at the end of a directory name), and refusal texts are checked with
 * POSIX spellings, where metadata text can spell a path verbatim.
 *
 * The in-memory file system resolves paths the way the kernel does: links in
 * the middle of a path are followed, ".." applies to the directory reached so
 * far, lstat and readlink do not follow the last component. readdir lists the
 * entries with their lstat types; a name that is not valid UTF-8 is listed as
 * its bytes with encoding "buffer" and lossily decoded otherwise, as Node does.
 */
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphRepositoryError } from "../packages/graph/src/errors.js";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.posix, default: actual.posix };
});

const memfs = vi.hoisted(() => {
  interface Entry {
    readonly kind: "dir" | "file" | "link";
    readonly ino: number;
    /** File content (text or bytes) or link text. */
    readonly data: string | Buffer;
  }
  const volume = new Map<string, Entry>();
  /** Names of the entries in each directory (readdir). */
  const children = new Map<string, Set<string>>();
  let nextIno = 1;

  const parentOf = (p: string): string => {
    const index = p.lastIndexOf("/");
    return index <= 0 ? "/" : p.slice(0, index);
  };
  const childOf = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
  const errno = (code: string, p: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: ${p}`), { code });

  const put = (p: string, kind: Entry["kind"], data: string | Buffer = ""): void => {
    volume.set(p, { kind, ino: nextIno++, data });
    if (p !== "/") {
      const parent = parentOf(p);
      const names = children.get(parent) ?? new Set<string>();
      names.add(p.slice(parent === "/" ? 1 : parent.length + 1));
      children.set(parent, names);
    }
  };
  const dir = (p: string): void => {
    const missing: string[] = [];
    for (let at = p; !volume.has(at); at = parentOf(at)) {
      missing.push(at);
      if (at === "/") break;
    }
    for (const at of missing.reverse()) put(at, "dir");
  };
  const file = (p: string, content: string | Buffer): void => {
    dir(parentOf(p));
    put(p, "file", content);
  };
  const link = (p: string, target: string): void => {
    dir(parentOf(p));
    put(p, "link", target);
  };
  /**
   * Entry names that are bytes, not valid UTF-8 (POSIX allows any byte but
   * "/" and NUL). Kept under a private key; readdir reports them the way Node
   * does on POSIX: as the bytes with encoding "buffer", as their lossy UTF-8
   * decoding (U+FFFD, a name that does not exist) otherwise.
   */
  const rawNames = new Map<string, Buffer>();
  const rawLink = (parent: string, name: Buffer, target: string): void => {
    const key = `\u0000raw:${name.toString("hex")}`;
    rawNames.set(key, name);
    link(childOf(parent, key), target);
  };
  const clear = (): void => {
    volume.clear();
    children.clear();
    rawNames.clear();
  };

  interface Found {
    /** Physical path of the last component. */
    readonly at: string;
    readonly entry: Entry | undefined;
  }

  const walk = (start: string, text: string, followLast: boolean, state: { hops: number }, original: string): Found => {
    const parts = text.split("/").filter((part) => part !== "" && part !== ".");
    let current = start;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const last = index === parts.length - 1;
      if (part === "..") {
        current = parentOf(current);
        continue;
      }
      const next = childOf(current, part);
      const entry = volume.get(next);
      if (entry === undefined) {
        if (last) return { at: next, entry: undefined };
        throw errno("ENOENT", original);
      }
      if (entry.kind === "link" && (!last || followLast)) {
        state.hops += 1;
        if (state.hops > 40) throw errno("ELOOP", original);
        const text = String(entry.data);
        const target = walk(text.startsWith("/") ? "/" : current, text, true, state, original);
        if (last) return target;
        if (target.entry === undefined) throw errno("ENOENT", original);
        if (target.entry.kind !== "dir") throw errno("ENOTDIR", original);
        current = target.at;
        continue;
      }
      if (last) return { at: next, entry };
      if (entry.kind !== "dir") throw errno("ENOTDIR", original);
      current = next;
    }
    return { at: current, entry: volume.get(current) };
  };
  const lookup = (p: string, followLast: boolean): Found => {
    if (!p.startsWith("/")) throw errno("EINVAL", p);
    return walk("/", p, followLast, { hops: 0 }, p);
  };
  const existing = (p: string, followLast: boolean): Found & { readonly entry: Entry } => {
    const found = lookup(p, followLast);
    if (found.entry === undefined) throw errno("ENOENT", p);
    return found as Found & { readonly entry: Entry };
  };
  const stats = (entry: Entry, bigint: boolean | undefined) => ({
    dev: bigint === true ? 1n : 1,
    ino: bigint === true ? BigInt(entry.ino) : entry.ino,
    isFile: () => entry.kind === "file",
    isDirectory: () => entry.kind === "dir",
    isSymbolicLink: () => entry.kind === "link",
    isFIFO: () => false,
  });

  const fs = {
    lstat: async (p: unknown, options?: { bigint?: boolean }) => stats(existing(String(p), false).entry, options?.bigint),
    readlink: async (p: unknown) => {
      const { entry } = existing(String(p), false);
      if (entry.kind !== "link") throw errno("EINVAL", String(p));
      return String(entry.data);
    },
    realpath: async (p: unknown) => existing(String(p), true).at,
    /** Follows a link at the last component, like readdir(3); entry types as lstat reports them. */
    readdir: async (p: unknown, options?: { encoding?: string }) => {
      const found = existing(String(p), true);
      if (found.entry.kind !== "dir") throw errno("ENOTDIR", String(p));
      return [...(children.get(found.at) ?? [])].sort().map((key) => {
        const kind = volume.get(childOf(found.at, key))!.kind;
        const raw = rawNames.get(key);
        const name =
          options?.encoding === "buffer"
            ? (raw ?? Buffer.from(key, "utf8"))
            : raw === undefined
              ? key
              : raw.toString("utf8");
        return {
          name,
          parentPath: String(p),
          isFile: () => kind === "file",
          isDirectory: () => kind === "dir",
          isSymbolicLink: () => kind === "link",
          isFIFO: () => false,
          isSocket: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
        };
      });
    },
    open: async (p: unknown) => {
      const { entry } = existing(String(p), true);
      if (entry.kind === "dir") throw errno("EISDIR", String(p));
      const bytes = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
      let offset = 0;
      return {
        stat: async (options?: { bigint?: boolean }) => stats(entry, options?.bigint),
        read: async (buffer: Buffer, at: number, length: number) => {
          const count = Math.max(0, Math.min(length, bytes.length - offset));
          bytes.copy(buffer, at, offset, offset + count);
          offset += count;
          return { bytesRead: count, buffer };
        },
        close: async () => undefined,
      };
    },
  };
  return { volume, clear, dir, file, link, rawLink, fs };
});

vi.mock("node:fs/promises", () => ({ ...memfs.fs, default: memfs.fs }));

type LayoutModule = typeof import("../packages/graph/src/git-repository-layout.js");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let layoutModule: LayoutModule;

beforeAll(async () => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
  layoutModule = await import("../packages/graph/src/git-repository-layout.js");
});
afterAll(() => {
  Object.defineProperty(process, "platform", realPlatform);
});
beforeEach(() => {
  memfs.clear();
});

/** A git directory at `gitDir` (HEAD, objects/info). */
function gitDirectoryAt(gitDir: string): void {
  memfs.file(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  memfs.dir(path.join(gitDir, "objects", "info"));
}

async function rejection(action: () => Promise<unknown>): Promise<GraphRepositoryError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphRepositoryError);
    return error as GraphRepositoryError;
  }
  throw new Error("expected a GraphRepositoryError rejection");
}

function expectNotNamed(message: string, location: string): void {
  expect(message).not.toContain(location);
  expect(message).not.toContain(JSON.stringify(location).slice(1, -1));
}

describe("POSIX semantics harness", () => {
  it("runs with POSIX path rules", () => {
    expect(process.platform).toBe("linux");
    expect(path.sep).toBe("/");
  });

  it("accepts a plain .git directory", async () => {
    gitDirectoryAt("/w/root/.git");

    const layout = await layoutModule.validateRepositoryLayout("/w/root", "rev-parse");

    expect(layout).toEqual({ kind: "git-directory", root: "/w/root", gitDir: "/w/root/.git", commonDir: "/w/root/.git" });
  });
});

describe("POSIX semantics: a backslash ending a directory name is part of the name, not a separator", () => {
  it("joins a gitdir pointer onto a root named 'foo\\' with '/'", async () => {
    gitDirectoryAt("/w/foo\\/g");
    memfs.file("/w/foo\\/.git", "gitdir: g\n");

    const layout = await layoutModule.validateRepositoryLayout("/w/foo\\", "rev-parse");

    expect(layout.kind).toBe("gitfile-within-root");
    expect(layout.gitDir).toBe("/w/foo\\/g");
  });

  it("joins a commondir onto a git directory named 'g\\' with '/'", async () => {
    gitDirectoryAt("/w/root/g\\");
    memfs.file("/w/root/g\\/commondir", ".\n");
    memfs.file("/w/root/.git", "gitdir: g\\\n");

    const layout = await layoutModule.validateRepositoryLayout("/w/root", "rev-parse");

    expect(layout.kind).toBe("gitfile-within-root");
    expect(layout.gitDir).toBe("/w/root/g\\");
    expect(layout.commonDir).toBe("/w/root/g\\");
  });
});

describe("POSIX semantics: refusals name no resolved location outside the root", () => {
  it("names an outside link that leads to a network path only inside the quoted include text", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.link("/w/outside/l", "//127.0.0.1/causoryn-unused-share/x");
    memfs.file("/w/root/.git/config", "[include]\n\tpath = /w/outside/l/x.cfg\n");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    const quoted = JSON.stringify("/w/outside/l/x.cfg");
    expect(error.message).toContain(quoted);
    expectNotNamed(error.message.split(quoted).join(""), "/w/outside");
    expect(error.message).not.toContain("causoryn-unused-share");
  });

  it("names neither an outside link nor its target when an include reaches it through a link in the root", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.link("/w/root/.git/in", "/w/outside");
    memfs.link("/w/outside/l", "//127.0.0.1/causoryn-unused-share/x");
    memfs.file("/w/root/.git/config", "[include]\n\tpath = in/l/x.cfg\n");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    expect(error.message).toContain('"in/l/x.cfg"');
    expectNotNamed(error.message, "/w/outside");
    expect(error.message).not.toContain("causoryn-unused-share");
  });
});

describe("POSIX semantics: an alternates line keeps its CR, as git reads it (F40)", () => {
  it("refuses 'evil\\r' where objects/evil<CR> links into another object store", async () => {
    gitDirectoryAt("/w/root/.git");
    gitDirectoryAt("/w/other/.git");
    memfs.link("/w/root/.git/objects/evil\r", "/w/other/.git/objects");
    memfs.file("/w/root/.git/objects/info/alternates", "evil\r\n");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects/info/alternates");
    expectNotNamed(error.message, "/w/other");
  });
});

describe("POSIX semantics: links below refs/ and at fixed git directory entries stay in scope (F7)", () => {
  it("refuses a loose ref that is a relative symbolic link to another repository's ref", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.file("/w/other/.git/refs/heads/main", "0123456789012345678901234567890123456789\n");
    memfs.link("/w/root/.git/refs/heads/x", "../../../../other/.git/refs/heads/main");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("outside the repository");
    expectNotNamed(error.message, "/w/other");
  });

  it("refuses a link outside the repository below a ref directory that links inside the root", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.file("/w/outside/secret", "TOP-SECRET-LINE\n");
    memfs.link("/w/root/tagstore/v1", "/w/outside/secret");
    memfs.link("/w/root/.git/refs/tags", "/w/root/tagstore");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("outside the repository");
    expectNotNamed(error.message, "/w/outside");
  });

  it("accepts HEAD as the symbolic link 'refs/heads/main' and a ref directory that links to itself", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.volume.delete("/w/root/.git/HEAD");
    memfs.file("/w/root/.git/refs/heads/main", "0123456789012345678901234567890123456789\n");
    memfs.link("/w/root/.git/HEAD", "refs/heads/main");
    memfs.link("/w/root/.git/refs/heads/loop", ".");

    const layout = await layoutModule.validateRepositoryLayout("/w/root", "rev-parse");

    expect(layout.kind).toBe("git-directory");
  });

  it("refuses a link below refs/ whose name is not valid UTF-8 (checked by its bytes, not a U+FFFD name)", async () => {
    gitDirectoryAt("/w/root/.git");
    memfs.file("/w/outside/secret", "TOP-SECRET-LINE\n");
    // git reads the byte name, e.g. through HEAD's "ref: refs/heads/<0xff>".
    memfs.rawLink("/w/root/.git/refs/heads", Buffer.from([0xff]), "/w/outside/secret");

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("UTF-8");
    expectNotNamed(error.message, "/w/outside");
  });

  it("counts every directory listing against the file system budget", async () => {
    gitDirectoryAt("/w/root/.git");
    for (let index = 0; index < layoutModule.MAX_LAYOUT_FS_OPERATIONS + 100; index += 1) {
      memfs.dir(`/w/root/.git/refs/heads/d${String(index)}`);
    }

    const error = await rejection(() => layoutModule.validateRepositoryLayout("/w/root", "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("file system operations");
  });
});
