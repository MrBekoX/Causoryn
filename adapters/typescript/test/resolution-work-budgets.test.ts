import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramIncremental,
  loadWorkspacePackages,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import { memoizeModuleResolver } from "../src/analyzer.js";
import {
  createVirtualAliasResolutionState,
  loadWorkspaceTsConfigs,
  MAX_VIRTUAL_ALIAS_PROBES_PER_RUN,
  MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER,
  MAX_WORKSPACE_DIR_LISTINGS,
  MAX_WORKSPACE_PATTERNS,
  resolveScopedModuleName,
  type ScopedTsConfig,
} from "../src/tsconfig-loader.js";

/**
 * Work budgets for module resolution and workspace discovery.
 *
 * Every assertion counts work deterministically (map lookups, resolver calls,
 * directory listings); none depends on wall-clock time.
 */

const VIRTUAL_ROOT = "/virtual/alias-budget";
/** Candidate paths probed for one extensionless alias target (base + 9 extensions + 9 index files). */
const CANDIDATES_PER_TARGET = 19;
const PATTERN_COUNT = 200;
const TARGETS_PER_PATTERN = 16;

/** 200 patterns `a*`, `aa*`, ... that all match one long `a...` specifier, 16 missing targets each. */
function craftedPaths(extra: Record<string, string[]> = {}): Record<string, string[]> {
  const paths: Record<string, string[]> = { ...extra };
  const crafted = PATTERN_COUNT - Object.keys(extra).length;
  for (let i = 0; i < crafted; i += 1) {
    paths[`${"a".repeat(i + 1)}*`] = Array.from(
      { length: TARGETS_PER_PATTERN },
      (_, j) => `missing-${String(j)}/*`,
    );
  }
  return paths;
}

function craftedConfig(): ScopedTsConfig {
  const loaded = loadWorkspaceTsConfigs(VIRTUAL_ROOT, [
    {
      relativePath: "tsconfig.json",
      content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: craftedPaths() } }),
    },
  ]);
  const config = loaded.configs[0];
  if (config?.paths === undefined) throw new Error("crafted tsconfig was not loaded");
  expect(config.paths.size).toBe(PATTERN_COUNT);
  return config;
}

/** In-memory source map that counts every lookup (the only work the alias fallback does). */
class CountingEntries extends Map<string, { relativePath: string; absolutePath: string }> {
  lookups = 0;

  override get(key: string): { relativePath: string; absolutePath: string } | undefined {
    this.lookups += 1;
    return super.get(key);
  }
}

const NO_DISK_HOST: ts.ModuleResolutionHost = {
  fileExists: () => false,
  readFile: () => undefined,
  directoryExists: () => false,
};

const MATCHING_SPECIFIER = "a".repeat(PATTERN_COUNT + 20);

function resolveCrafted(
  config: ScopedTsConfig,
  entries: CountingEntries,
  moduleName: string,
  containingFile: string,
  state?: ReturnType<typeof createVirtualAliasResolutionState>,
): ts.ResolvedModuleFull | undefined {
  return resolveScopedModuleName({
    moduleName,
    containingFile,
    rootPosix: VIRTUAL_ROOT,
    programOptions: {},
    configs: [config],
    resolutionHost: NO_DISK_HOST,
    entries,
    ...(state === undefined ? {} : { virtualAliasState: state }),
  });
}

describe("tsconfig paths virtual alias fallback work budget", { timeout: 120_000 }, () => {
  it("caps the in-memory alias targets probed for one specifier", () => {
    const config = craftedConfig();
    const entries = new CountingEntries();

    const resolved = resolveCrafted(config, entries, MATCHING_SPECIFIER, `${VIRTUAL_ROOT}/src/main.ts`);

    expect(resolved).toBeUndefined();
    // One lookup for the containing file, then at most the per-specifier cap of target probes.
    expect(entries.lookups).toBeLessThanOrEqual(
      1 + MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER * CANDIDATES_PER_TARGET,
    );
  });

  it("memoizes the alias outcome per scoped config and specifier for one analysis run", () => {
    const config = craftedConfig();
    const entries = new CountingEntries();
    const state = createVirtualAliasResolutionState();

    for (let i = 0; i < 50; i += 1) {
      resolveCrafted(config, entries, MATCHING_SPECIFIER, `${VIRTUAL_ROOT}/src/f${String(i)}.ts`, state);
    }

    // 50 containing-file lookups + a single capped probe sequence.
    expect(entries.lookups).toBeLessThanOrEqual(
      50 + MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER * CANDIDATES_PER_TARGET,
    );
    expect(state.warnings.some((w) => w.includes("tsconfig paths alias probing stopped"))).toBe(true);
  });

  it("stops all alias probing once the per-run budget is spent and records one warning", () => {
    const config = craftedConfig();
    const entries = new CountingEntries();
    const state = createVirtualAliasResolutionState(100);

    for (let i = 0; i < 10; i += 1) {
      resolveCrafted(config, entries, `${MATCHING_SPECIFIER}x${String(i)}`, `${VIRTUAL_ROOT}/src/main.ts`, state);
    }

    expect(state.probes).toBe(100);
    expect(entries.lookups).toBeLessThanOrEqual(10 + 100 * CANDIDATES_PER_TARGET);
    const budgetWarnings = state.warnings.filter((w) => w.includes("probe budget (100) exhausted"));
    expect(budgetWarnings).toHaveLength(1);
  });

  it("still resolves an ordinary alias target through the in-memory fallback", () => {
    const loaded = loadWorkspaceTsConfigs(VIRTUAL_ROOT, [
      {
        relativePath: "tsconfig.json",
        content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
      },
    ]);
    const config = loaded.configs[0]!;
    const entries = new CountingEntries();
    const utilAbs = `${VIRTUAL_ROOT}/src/util.ts`;
    const utilKey = ts.sys.useCaseSensitiveFileNames ? utilAbs : utilAbs.toLowerCase();
    entries.set(utilKey, { relativePath: "src/util.ts", absolutePath: utilAbs });
    const state = createVirtualAliasResolutionState();

    const resolved = resolveCrafted(config, entries, "@app/util", `${VIRTUAL_ROOT}/src/main.ts`, state);

    expect(resolved?.resolvedFileName).toBe(utilAbs);
    expect(state.warnings).toEqual([]);
  });

  it("keeps the analysis going: crafted alias imports stay unresolved with a warning, real aliases still resolve", () => {
    const root = path.resolve(tmpdir(), "causoryn-alias-budget-virtual-root");
    const crafted = `import "${MATCHING_SPECIFIER}";`;
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_alias_budget",
      rootDir: root,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: craftedPaths({ "@app/*": ["src/*"] }) },
          }),
        },
      ],
      sources: [
        {
          relativePath: "src/main.ts",
          content: [
            'import { util } from "@app/util";',
            ...Array.from({ length: 50 }, () => crafted),
            "export function main(): number {",
            "  return util();",
            "}",
            "",
          ].join("\n"),
        },
        { relativePath: "src/util.ts", content: "export function util(): number {\n  return 1;\n}\n" },
      ],
    });

    const importsUtil = result.edges.find(
      (edge) =>
        edge.kind === "IMPORTS" &&
        edge.from.qualifiedName === "src/main.ts" &&
        edge.to.qualifiedName === "src/util.ts",
    );
    expect(importsUtil?.resolution).toBe("verified");
    const craftedImport = result.edges.find(
      (edge) => edge.kind === "IMPORTS" && edge.to.qualifiedName === MATCHING_SPECIFIER,
    );
    expect(craftedImport?.resolution).toBe("unresolved");
    expect(result.warnings.some((w) => w.includes("tsconfig paths alias probing stopped"))).toBe(true);
    expect(
      result.edges.some(
        (edge) => edge.kind === "CALLS" && edge.from.qualifiedName === "main" && edge.to.qualifiedName === "util",
      ),
    ).toBe(true);
  });
});

describe("alias probe budget on incremental runs", { timeout: 300_000 }, () => {
  it("spends the run budget in the same order on full and incremental runs", () => {
    const root = path.resolve(tmpdir(), "causoryn-alias-budget-order-virtual-root");
    // Five crafted patterns give every `aaaaa...` specifier 80 missing targets:
    // each such import spends the whole per-specifier cap of 64 probes.
    const paths: Record<string, string[]> = { "lib*": ["missing/*"], "l*": ["src/*"] };
    for (let i = 1; i <= 5; i += 1) {
      paths[`${"a".repeat(i)}*`] = Array.from({ length: 16 }, (_, j) => `missing-${String(j)}/*`);
    }
    const exhaustingImports = Math.ceil(MAX_VIRTUAL_ALIAS_PROBES_PER_RUN / MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER) + 20;
    const sources = (aValue: number) => [
      // a.ts is processed first and pulls c.ts in before b.ts: c.ts spends the budget.
      { relativePath: "src/a.ts", content: `import "./c";\nexport const a = ${String(aValue)};\n` },
      // "libx" resolves only through the alias fallback ("lib*" misses, "l*" -> src/ibx).
      {
        relativePath: "src/b.ts",
        content: 'import { x } from "libx";\nexport function useX(): number {\n  return x();\n}\n',
      },
      {
        relativePath: "src/c.ts",
        content: Array.from({ length: exhaustingImports }, (_, i) => `import "aaaaa${String(i)}";`).join("\n"),
      },
      { relativePath: "src/ibx.ts", content: "export function x(): number {\n  return 1;\n}\n" },
    ];
    const input = (aValue: number) => ({
      workspaceId: "ws_alias_budget_order",
      rootDir: root,
      configFiles: [
        { relativePath: "tsconfig.json", content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }) },
      ],
      sources: sources(aValue),
    });

    const first = analyzeTypeScriptProgramIncremental(input(1));
    const incremental = analyzeTypeScriptProgramIncremental({
      ...input(2),
      incrementalState: first.nextIncrementalState,
    }).result;
    const full = analyzeTypeScriptProgram(input(2));

    const importOfB = (result: TypeScriptAdapterResult) =>
      result.edges.find((edge) => edge.kind === "IMPORTS" && edge.from.qualifiedName === "src/b.ts");
    expect(full.warnings.some((w) => w.includes("probe budget"))).toBe(true);
    expect(importOfB(incremental)).toEqual(importOfB(full));
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(full));
  });
});

describe("module resolution memo", () => {
  it("resolves one specifier once per containing file and replays the outcome", () => {
    const calls: string[] = [];
    const resolvedModule: ts.ResolvedModuleFull = {
      resolvedFileName: "/r/src/b.ts",
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
    const resolve = memoizeModuleResolver((moduleName, containingFile) => {
      calls.push(`${containingFile}|${moduleName}`);
      return moduleName === "./b" ? resolvedModule : undefined;
    });

    for (let i = 0; i < 100; i += 1) {
      expect(resolve("./b", "/r/src/a.ts")).toBe(resolvedModule);
      expect(resolve("missing", "/r/src/a.ts")).toBeUndefined();
    }
    expect(resolve("./b", "/r/src/c.ts")).toBe(resolvedModule);

    expect(calls).toEqual(["/r/src/a.ts|./b", "/r/src/a.ts|missing", "/r/src/c.ts|./b"]);
  });
});

describe("package.json workspaces discovery work budget", { timeout: 120_000 }, () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value), "utf8");
  }

  /** Counts directory listings made while discovering workspace manifests. */
  function countListings(run: () => void): number {
    const spy = vi.spyOn(fs, "readdirSync");
    run();
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    return calls;
  }

  /**
   * Serves a large directory tree under `root` without creating it on disk:
   * `childrenOf(rel)` lists the subdirectories of a root-relative directory
   * ("" is the root). Files (the root package.json) stay real. Returns the
   * number of directory listings `run` made.
   */
  function countListingsOverVirtualTree(
    root: string,
    childrenOf: (rel: string) => readonly string[] | undefined,
    run: () => void,
  ): number {
    const toPosix = (p: string): string => p.replace(/\\/g, "/");
    const rootPosix = toPosix(root);
    const realRootPosix = toPosix(fs.realpathSync(root));
    const relOf = (p: fs.PathLike): string | undefined => {
      const posix = toPosix(String(p));
      if (posix === rootPosix) return "";
      return posix.startsWith(`${rootPosix}/`) ? posix.slice(rootPosix.length + 1) : undefined;
    };
    const isVirtualDir = (rel: string): boolean => {
      if (rel === "") return false;
      const slash = rel.lastIndexOf("/");
      const parent = slash < 0 ? "" : rel.slice(0, slash);
      return childrenOf(parent)?.includes(rel.slice(slash + 1)) === true;
    };
    const realReaddir = fs.readdirSync.bind(fs) as (p: fs.PathLike) => string[];
    const realLstat = fs.lstatSync.bind(fs) as (p: fs.PathLike) => fs.Stats;
    const realRealpath = fs.realpathSync.bind(fs) as (p: fs.PathLike) => string;
    const dirStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike) => {
      const rel = relOf(p);
      return rel === undefined ? realReaddir(p) : [...(childrenOf(rel) ?? [])];
    }) as typeof fs.readdirSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike) => {
      const rel = relOf(p);
      return rel !== undefined && isVirtualDir(rel) ? dirStat : realLstat(p);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) => {
      const rel = relOf(p);
      return rel !== undefined && isVirtualDir(rel) ? `${realRootPosix}/${rel}` : realRealpath(p);
    }) as typeof fs.realpathSync);
    try {
      run();
      return readdir.mock.calls.length;
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("lists each directory once no matter how often a workspaces pattern repeats", () => {
    const root = makeRoot("causoryn-ws-repeat-");
    for (let i = 0; i < 8; i += 1) {
      writeJson(path.join(root, `pkg${String(i)}`, "package.json"), { name: `@acme/pkg${String(i)}` });
      mkdirSync(path.join(root, `pkg${String(i)}`, "x", "y"), { recursive: true });
    }
    writeJson(path.join(root, "package.json"), {
      name: "repeat-root",
      private: true,
      workspaces: [...Array.from({ length: 3000 }, () => "*/*/*"), "pkg*"],
    });

    let loaded: ReturnType<typeof loadWorkspacePackages> | undefined;
    const listings = countListings(() => {
      loaded = loadWorkspacePackages("/virtual", undefined, root);
    });

    // root + 8 packages + 8 "x" + 8 "x/y" directories: 25 distinct directories.
    expect(listings).toBeGreaterThan(0);
    expect(listings).toBeLessThanOrEqual(25);
    expect([...loaded!.packages.keys()].sort()).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `@acme/pkg${String(i)}`),
      "repeat-root",
    ]);
  });

  it("ignores workspaces patterns past the pattern limit with a warning", () => {
    const root = makeRoot("causoryn-ws-pattern-cap-");
    writeJson(path.join(root, "packages", "alpha", "package.json"), { name: "@acme/alpha" });
    writeJson(path.join(root, "package.json"), {
      name: "pattern-cap-root",
      private: true,
      workspaces: [
        "packages/*",
        ...Array.from({ length: MAX_WORKSPACE_PATTERNS + 50 }, (_, i) => `missing-${String(i)}/*`),
      ],
    });

    let loaded: ReturnType<typeof loadWorkspacePackages> | undefined;
    const listings = countListings(() => {
      loaded = loadWorkspacePackages("/virtual", undefined, root);
    });

    expect(loaded!.packages.has("@acme/alpha")).toBe(true);
    expect(
      loaded!.warnings.some((w) =>
        w.includes(`workspaces pattern limit (${String(MAX_WORKSPACE_PATTERNS)}) exceeded`),
      ),
    ).toBe(true);
    // Root listed once (cached) for every pattern, plus packages/ and packages/alpha.
    expect(listings).toBeLessThanOrEqual(4);
  });

  it("stops expanding further patterns once the manifest candidate limit is reached", () => {
    const root = makeRoot("causoryn-ws-candidate-cap-");
    writeJson(path.join(root, "package.json"), {
      name: "candidate-cap-root",
      private: true,
      workspaces: ["*", "*/s", "*/s*", "*/*"],
    });
    const tops = Array.from({ length: 260 }, (_, i) => `d${String(i).padStart(3, "0")}`);

    const listings = countListingsOverVirtualTree(
      root,
      (rel) => (rel === "" ? tops : tops.includes(rel) ? ["s"] : []),
      () => {
        loadWorkspacePackages("/virtual", undefined, root);
      },
    );

    // "*" fills all 256 candidates from the single root listing; nothing else is scanned.
    expect(listings).toBe(1);
  });

  it("bounds the distinct directory listings of one discovery run and warns once", () => {
    const root = makeRoot("causoryn-ws-listing-budget-");
    const tops = Array.from({ length: 50 }, (_, i) => `t${String(i)}`);
    const subs = Array.from({ length: 45 }, (_, j) => `s${String(j)}`);
    expect(tops.length * (subs.length + 1) + 1).toBeGreaterThan(MAX_WORKSPACE_DIR_LISTINGS);
    writeJson(path.join(root, "package.json"), {
      name: "listing-budget-root",
      private: true,
      workspaces: tops.map((top) => `${top}/*/zzz`),
    });

    let loaded: ReturnType<typeof loadWorkspacePackages> | undefined;
    const listings = countListingsOverVirtualTree(
      root,
      (rel) => (rel === "" ? tops : tops.includes(rel) ? subs : []),
      () => {
        loaded = loadWorkspacePackages("/virtual", undefined, root);
      },
    );

    expect(listings).toBeLessThanOrEqual(MAX_WORKSPACE_DIR_LISTINGS);
    expect(
      loaded!.warnings.filter((w) => w.includes("workspace package scan stopped after")),
    ).toHaveLength(1);
  });
});
