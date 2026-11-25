/**
 * Confined TypeScript compiler host: link resolution happens before any
 * following file system call, UNC/device link targets are never touched,
 * disk reads are bounded, and the host never writes, never exposes the
 * process environment and never enumerates the disk.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeTypeScriptProgram } from "../src/index.js";
import { configureConfinedCompilerHost } from "../src/analyzer.js";
import {
  classifyLinkTarget,
  isSafePathSegment,
  isUncDeviceOrNtPath,
  MAX_CONFINED_DISK_FILE_BYTES,
} from "../src/confined-fs.js";
import { createFakeConfinedFs } from "./fake-confined-fs.js";

const ROOT = "D:/ws";
const LIB = "D:/tools/ts/lib";

interface SpyHost {
  readonly host: ts.CompilerHost;
  readonly baseCalls: string[];
}

/** A compiler host whose disk methods only record that they were called. */
function spyHost(): SpyHost {
  const baseCalls: string[] = [];
  const record = (name: string) => (p: string) => {
    baseCalls.push(`${name} ${p}`);
    return undefined as never;
  };
  const host = {
    fileExists: (p: string) => {
      baseCalls.push(`fileExists ${p}`);
      return true;
    },
    readFile: (p: string) => {
      baseCalls.push(`readFile ${p}`);
      return "export declare const LEAKED: string;";
    },
    directoryExists: (p: string) => {
      baseCalls.push(`directoryExists ${p}`);
      return true;
    },
    realpath: (p: string) => {
      baseCalls.push(`realpath ${p}`);
      return p;
    },
    getDirectories: (p: string) => {
      baseCalls.push(`getDirectories ${p}`);
      return ["evil", "evil2", "evil3", "outside", "pkg"];
    },
    readDirectory: record("readDirectory"),
  } as unknown as ts.CompilerHost;
  return { host, baseCalls };
}

const isUncLike = (call: string): boolean => {
  const p = call.slice(call.indexOf(" ") + 1);
  return p.startsWith("//") || p.startsWith("\\\\") || p.startsWith("\\??\\");
};

describe("confined compiler host: link resolution before file system access", () => {
  it("never follows a node_modules link whose target is a UNC, device or NT path", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, `${ROOT}/node_modules/@scope`, LIB],
      links: {
        [`${ROOT}/node_modules/evil`]: "\\\\attacker.example\\share\\pkg",
        [`${ROOT}/node_modules/evil2`]: "//attacker.example/share/pkg",
        [`${ROOT}/node_modules/evil3`]: "\\\\?\\UNC\\attacker.example\\share",
        [`${ROOT}/node_modules/@scope/pipe`]: "\\\\.\\pipe\\evil",
        [`${ROOT}/node_modules/nt`]: "\\??\\UNC\\attacker.example\\share",
      },
      readdirs: { [`${ROOT}/node_modules`]: ["evil", "evil2", "evil3", "nt", "@scope"] },
    });
    const { host, baseCalls } = spyHost();
    const resolutionHost = configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), {
      fs: fake,
    });

    for (const pkg of ["evil", "evil2", "evil3", "nt", "@scope/pipe"]) {
      const file = `${ROOT}/node_modules/${pkg}/index.d.ts`;
      expect(host.fileExists(file)).toBe(false);
      expect(host.readFile(file)).toBeUndefined();
      expect(host.directoryExists?.(`${ROOT}/node_modules/${pkg}`)).toBe(false);
      expect(resolutionHost.directoryExists?.(`${ROOT}/node_modules/${pkg}`)).toBe(false);
      expect(resolutionHost.realpath?.(file).toLowerCase().startsWith(ROOT.toLowerCase())).toBe(false);
    }
    expect(host.getDirectories?.(`${ROOT}/node_modules`)).toEqual(["@scope"]);

    // No base host disk call at all, and no probe call on a UNC/device path.
    expect(baseCalls).toEqual([]);
    expect(fake.calls.filter(isUncLike)).toEqual([]);
  });

  it("refuses an intermediate link that leaves the workspace without touching the target", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, "E:/outside/pkg", LIB],
      files: { "E:/outside/pkg/index.d.ts": "export declare const OUTSIDE: string;" },
      links: { [`${ROOT}/node_modules/outside`]: "E:\\outside\\pkg" },
    });
    const { host, baseCalls } = spyHost();
    const resolutionHost = configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), {
      fs: fake,
    });

    expect(host.fileExists(`${ROOT}/node_modules/outside/index.d.ts`)).toBe(false);
    expect(host.readFile(`${ROOT}/node_modules/outside/index.d.ts`)).toBeUndefined();
    // realpath reports the escaping target lexically so module resolution rejects it.
    expect(resolutionHost.realpath?.(`${ROOT}/node_modules/outside/index.d.ts`)).toBe(
      "E:/outside/pkg/index.d.ts",
    );
    expect(baseCalls).toEqual([]);
    expect(fake.calls.some((call) => call.includes("E:/outside") || call.includes("E:\\outside"))).toBe(false);
  });

  it("resolves relative and absolute links that stay inside the workspace (pnpm layout)", () => {
    const store = `${ROOT}/node_modules/.pnpm/rel@1.0.0/node_modules/rel`;
    const fake = createFakeConfinedFs({
      dirs: [
        ROOT,
        `${ROOT}/node_modules`,
        `${ROOT}/node_modules/.pnpm`,
        `${ROOT}/node_modules/.pnpm/rel@1.0.0`,
        `${ROOT}/node_modules/.pnpm/rel@1.0.0/node_modules`,
        store,
        LIB,
      ],
      files: {
        [`${store}/index.d.ts`]: "export declare function relFn(): number;",
        [`${store}/package.json`]: '{"name":"rel","types":"index.d.ts"}',
        [`${LIB}/lib.es2022.d.ts`]: "interface Array<T> {}",
      },
      links: {
        [`${ROOT}/node_modules/rel`]: ".pnpm\\rel@1.0.0\\node_modules\\rel",
        [`${ROOT}/node_modules/abs`]: "D:\\ws\\node_modules\\.pnpm\\rel@1.0.0\\node_modules\\rel\\",
        [`${ROOT}/node_modules/ext`]: "\\\\?\\D:\\ws\\node_modules\\.pnpm\\rel@1.0.0\\node_modules\\rel",
      },
    });
    const { host, baseCalls } = spyHost();
    const resolutionHost = configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), {
      fs: fake,
    });

    for (const pkg of ["rel", "abs", "ext"]) {
      expect(host.fileExists(`${ROOT}/node_modules/${pkg}/index.d.ts`)).toBe(true);
      expect(host.readFile(`${ROOT}/node_modules/${pkg}/index.d.ts`)).toContain("relFn");
      expect(host.directoryExists?.(`${ROOT}/node_modules/${pkg}`)).toBe(true);
      expect(resolutionHost.realpath?.(`${ROOT}/node_modules/${pkg}/index.d.ts`)).toBe(
        `${store}/index.d.ts`,
      );
    }
    expect(host.readFile(`${LIB}/lib.es2022.d.ts`)).toContain("interface Array");
    // Outside node_modules nothing is read from disk, even inside the workspace.
    expect(host.fileExists(`${ROOT}/src/secret.d.ts`)).toBe(false);
    expect(baseCalls).toEqual([]);
  });

  it("stops at a link cycle instead of looping", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, LIB],
      links: {
        [`${ROOT}/node_modules/a`]: `${ROOT}/node_modules/b`,
        [`${ROOT}/node_modules/b`]: `${ROOT}/node_modules/a`,
      },
    });
    const { host } = spyHost();
    configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), { fs: fake });
    expect(host.fileExists(`${ROOT}/node_modules/a/index.d.ts`)).toBe(false);
    expect(fake.calls.length).toBeLessThan(200);
  });

  it("refuses Windows device names and alternate data streams in disk paths", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, `${ROOT}/node_modules/pkg`, LIB],
      files: {
        [`${ROOT}/node_modules/pkg/nul.d.ts`]: "export {};",
        [`${ROOT}/node_modules/pkg/index.d.ts:hidden`]: "export {};",
      },
    });
    const { host } = spyHost();
    configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), { fs: fake });
    expect(host.fileExists(`${ROOT}/node_modules/pkg/nul.d.ts`)).toBe(false);
    expect(host.fileExists(`${ROOT}/node_modules/pkg/index.d.ts:hidden`)).toBe(false);
    expect(fake.calls.some((call) => call.includes("nul.d.ts") || call.includes(":hidden"))).toBe(false);
  });
});

describe("confined compiler host: bounded disk reads", () => {
  const fifoPath = `${ROOT}/node_modules/fifo/index.d.ts`;
  const bigPath = `${ROOT}/node_modules/big/index.d.ts`;

  it("does not read non-regular files and skips declarations above the per-file limit", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, `${ROOT}/node_modules/fifo`, `${ROOT}/node_modules/big`, LIB],
      files: { [bigPath]: `export declare const BIG: "${"x".repeat(200)}";` },
      others: [fifoPath],
    });
    const { host, baseCalls } = spyHost();
    const warnings: string[] = [];
    configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), {
      fs: fake,
      maxDiskFileBytes: 64,
      addWarning: (message) => warnings.push(message),
    });

    expect(host.fileExists(fifoPath)).toBe(false);
    expect(host.readFile(fifoPath)).toBeUndefined();
    expect(host.fileExists(bigPath)).toBe(false);
    expect(host.readFile(bigPath)).toBeUndefined();
    expect(fake.calls.filter((call) => call.startsWith("readText"))).toEqual([]);
    expect(baseCalls).toEqual([]);
    expect(warnings).toContain(
      "declaration file skipped: node_modules/big/index.d.ts exceeds the 64-byte disk read limit",
    );
    expect(warnings).toContain(
      "declaration file skipped: node_modules/fifo/index.d.ts is not a regular file",
    );
  });

  it("stops reading from disk once the total read budget is used", () => {
    const fake = createFakeConfinedFs({
      dirs: [ROOT, `${ROOT}/node_modules`, `${ROOT}/node_modules/a`, `${ROOT}/node_modules/b`, LIB],
      files: {
        [`${ROOT}/node_modules/a/index.d.ts`]: "export declare const A: 1; // 40 bytes...",
        [`${ROOT}/node_modules/b/index.d.ts`]: "export declare const B: 2; // 40 bytes...",
      },
    });
    const { host } = spyHost();
    const warnings: string[] = [];
    configureConfinedCompilerHost(host, new Map(), ROOT, LIB, new Map(), {
      fs: fake,
      maxDiskTotalBytes: 60,
      addWarning: (message) => warnings.push(message),
    });

    expect(host.readFile(`${ROOT}/node_modules/a/index.d.ts`)).toContain("const A");
    expect(host.readFile(`${ROOT}/node_modules/b/index.d.ts`)).toBeUndefined();
    expect(warnings).toContain(
      "declaration reads stopped: the 60-byte total disk read budget of this analysis was used; remaining node_modules declarations were not read",
    );
  });

  it("uses a 16 MiB default per-file limit", () => {
    expect(MAX_CONFINED_DISK_FILE_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("confined compiler host: no writes, no environment, no disk enumeration", () => {
  const temps: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["CAUSORYN_CONFINED_HOST_PROBE"];
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("writeFile/createDirectory throw, getEnvironmentVariable is empty, readDirectory lists only in-memory sources, trace stays off stdout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-confined-host-"));
    temps.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "secret.ts"), "export const SECRET = 1;\n", "utf8");
    const rootPosix = root.replace(/\\/g, "/");
    const entryPath = `${rootPosix}/src/a.ts`;
    const entries = new Map([
      [
        ts.sys.useCaseSensitiveFileNames ? entryPath : entryPath.toLowerCase(),
        { absolutePath: entryPath, content: "export const a = 1;\n" },
      ],
    ]);

    const host = ts.createCompilerHost({}, true);
    configureConfinedCompilerHost(host, entries, rootPosix, undefined);

    const outFile = path.join(root, "out.js");
    expect(() => host.writeFile(outFile, "x", false)).toThrow(/never writes/);
    expect(existsSync(outFile)).toBe(false);
    const newDir = path.join(root, "created");
    const createDirectory = (host as unknown as { createDirectory?: (d: string) => void }).createDirectory;
    expect(() => createDirectory?.(newDir)).toThrow(/never writes/);
    expect(existsSync(newDir)).toBe(false);

    process.env["CAUSORYN_CONFINED_HOST_PROBE"] = "visible-to-the-process";
    expect(host.getEnvironmentVariable?.("CAUSORYN_CONFINED_HOST_PROBE")).toBe("");
    expect(host.getEnvironmentVariable?.("PATH")).toBe("");

    expect(host.readDirectory?.(rootPosix, [".ts"], undefined, ["**/*"])).toEqual([entryPath]);
    expect(host.readDirectory?.(`${rootPosix}/src`, [".tsx"], undefined, ["**/*"])).toEqual([]);

    const stdoutWrite = vi.spyOn(process.stdout, "write");
    host.trace?.("======== Resolving module 'x' ========");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("reads a declaration through a real in-workspace directory link with the default probe", () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-confined-link-"));
    temps.push(root);
    const store = path.join(root, "node_modules", ".pnpm", "linked@1.0.0", "node_modules", "linked");
    mkdirSync(store, { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(store, "package.json"), '{"name":"linked","types":"index.d.ts"}', "utf8");
    writeFileSync(path.join(store, "index.d.ts"), "export declare function linkedFn(): number;\n", "utf8");
    let linked = false;
    try {
      symlinkSync(store, path.join(root, "node_modules", "linked"), process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch {
      // Link creation may need privileges in restricted sandboxes.
    }
    if (!linked) return;

    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_confined_link",
      rootDir: root,
      configFiles: [],
      sources: [
        {
          relativePath: "src/app.ts",
          content: 'import { linkedFn } from "linked";\nexport const v: number = linkedFn();\n',
        },
      ],
    });
    const edge = result.edges.find(
      (e) => e.kind === "IMPORTS" && e.from.qualifiedName === "src/app.ts" && e.to.qualifiedName === "linked",
    );
    expect(edge?.resolution).not.toBe("unresolved");
    expect(result.diagnostics.filter((d) => d.code === "TS2307")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("never opens a FIFO placed in node_modules", () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-confined-fifo-"));
    temps.push(root);
    const pkgDir = path.join(root, "node_modules", "fifo");
    mkdirSync(pkgDir, { recursive: true });
    const fifo = path.join(pkgDir, "index.d.ts");
    const made = spawnSync("mkfifo", [fifo], { shell: false });
    if (made.status !== 0) return;

    const host = ts.createCompilerHost({}, true);
    configureConfinedCompilerHost(host, new Map(), root, undefined);
    expect(host.fileExists(fifo)).toBe(false);
    expect(host.readFile(fifo)).toBeUndefined();
  });
});

describe("confined-fs lexical helpers", () => {
  it("classifies UNC, device and NT-namespace paths", () => {
    for (const raw of ["\\\\host\\share", "//host/share", "\\/host", "/\\host", "\\\\.\\pipe\\x", "\\\\?\\UNC\\h\\s", "\\??\\C:\\x"]) {
      expect(isUncDeviceOrNtPath(raw)).toBe(true);
    }
    for (const raw of ["C:\\x", "C:/x", "/usr/lib", "rel/x", "\\rooted"]) {
      expect(isUncDeviceOrNtPath(raw)).toBe(false);
    }
  });

  it("classifies link targets", () => {
    expect(classifyLinkTarget("\\\\host\\share")).toBeUndefined();
    expect(classifyLinkTarget("\\\\?\\UNC\\host\\share")).toBeUndefined();
    expect(classifyLinkTarget("\\??\\UNC\\host\\share")).toBeUndefined();
    expect(classifyLinkTarget("\\\\?\\Volume{1}\\x")).toBeUndefined();
    expect(classifyLinkTarget("C:relative")).toBeUndefined();
    expect(classifyLinkTarget("\\\\?\\C:\\store\\pkg")).toBe("C:/store/pkg");
    expect(classifyLinkTarget("\\??\\C:\\store\\pkg")).toBe("C:/store/pkg");
    expect(classifyLinkTarget("C:\\store\\pkg")).toBe("C:/store/pkg");
    expect(classifyLinkTarget("../.pnpm/x")).toBe("../.pnpm/x");
    expect(classifyLinkTarget("/opt/store")).toBe("/opt/store");
  });

  it("refuses unsafe path segments", () => {
    expect(isSafePathSegment("index.d.ts", true)).toBe(true);
    expect(isSafePathSegment("CON", true)).toBe(false);
    expect(isSafePathSegment("nul.d.ts", true)).toBe(false);
    expect(isSafePathSegment("com1", true)).toBe(false);
    expect(isSafePathSegment("a:b", true)).toBe(false);
    expect(isSafePathSegment("a:b", false)).toBe(true);
    expect(isSafePathSegment("..", false)).toBe(false);
    expect(isSafePathSegment("console.d.ts", true)).toBe(true);
  });
});
