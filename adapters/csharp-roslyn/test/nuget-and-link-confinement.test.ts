/**
 * C# adapter confinement: NuGet `packageFolders` from an untrusted
 * `obj/project.assets.json` are honoured only inside the trusted NuGet roots
 * or the workspace, intermediate links are never traversed, and the worker
 * environment pins the .NET host diagnostics/deps switches and validates
 * DOTNET_ROOT.
 */
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeCSharpWorkspace, discoverNugetReferenceDirs, runWorkerAnalyze } from "../src/index.js";
import { readBoundedFileNoFollow } from "../src/safe-fs.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Real path of a fresh temp dir (macOS: /var -> /private/var). */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A NuGet-layout package folder `<cache>/<id>/<version>/lib/net10.0/<Name>.dll`; returns the DLL dir. */
function makePackage(cache: string, id: string, version = "1.0.0"): string {
  const dir = join(cache, id.toLowerCase(), version, "lib", "net10.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.dll`), "stub", "utf8");
  return dir;
}

function writeAssets(projectDir: string, packageFolders: readonly string[], packages: readonly string[], libraryPaths?: Readonly<Record<string, string>>): void {
  const targets: Record<string, unknown> = {};
  const libraries: Record<string, unknown> = {};
  for (const id of packages) {
    targets[`${id}/1.0.0`] = { type: "package", compile: { [`lib/net10.0/${id}.dll`]: {} } };
    libraries[`${id}/1.0.0`] = { type: "package", path: libraryPaths?.[id] ?? `${id.toLowerCase()}/1.0.0` };
  }
  mkdirSync(join(projectDir, "obj"), { recursive: true });
  writeFileSync(
    join(projectDir, "obj", "project.assets.json"),
    JSON.stringify({
      version: 3,
      targets: { "net10.0": targets },
      libraries,
      packageFolders: Object.fromEntries(packageFolders.map((folder) => [folder, {}])),
    }),
    "utf8",
  );
}

/** Trust options that trust nothing outside the workspace (empty env, empty home). */
function noTrust(): { env: Record<string, string>; homeDir: string } {
  return { env: {}, homeDir: tempDir("causoryn-empty-home-") };
}

describe("NuGet packageFolders confinement", () => {
  it("ignores packageFolders outside the trusted NuGet roots and the workspace (filesystem root, foreign cache)", () => {
    const base = tempDir("causoryn-nuget-untrusted-");
    const ws = join(base, "ws");
    const foreignCache = join(base, "foreign-cache");
    const foreignDll = makePackage(foreignCache, "Foreign.Pkg");
    // The filesystem root as a packageFolder plus a library path reaching the foreign DLL dir.
    const fsRoot = parse(foreignCache).root;
    const fromRoot = relative(fsRoot, join(foreignCache, "foreign.pkg", "1.0.0")).split(/[\\/]/).join("/");
    writeAssets(ws, [fsRoot, `${foreignCache}${process.platform === "win32" ? "\\" : "/"}`], ["Foreign.Pkg"], {
      "Foreign.Pkg": fromRoot,
    });

    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([]);
    expect(discovered.referenceDirs).not.toContain(foreignDll);
    expect(discovered.warnings).toEqual([
      "obj/project.assets.json: ignored 2 NuGet packageFolders entries outside the trusted NuGet package roots and the workspace",
    ]);
  });

  it("honours a cache trusted through NUGET_PACKAGES", () => {
    const base = tempDir("causoryn-nuget-env-");
    const ws = join(base, "ws");
    const cache = join(base, "cache");
    const dll = makePackage(cache, "Acme.Env");
    writeAssets(ws, [`${cache}/`], ["Acme.Env"]);
    const trust = noTrust();
    expect(discoverNugetReferenceDirs(ws, trust).referenceDirs).toEqual([]);
    expect(
      discoverNugetReferenceDirs(ws, { ...trust, env: { NUGET_PACKAGES: cache } }).referenceDirs,
    ).toEqual([realpathSync(dll)]);
  });

  it("honours caches trusted through NUGET_FALLBACK_PACKAGES and the default ~/.nuget/packages", () => {
    const base = tempDir("causoryn-nuget-fallback-");
    const ws = join(base, "ws");
    const fallbackA = join(base, "fallback-a");
    const fallbackB = join(base, "fallback-b");
    const home = join(base, "home");
    const defaultCache = join(home, ".nuget", "packages");
    const dllA = makePackage(fallbackA, "Acme.A");
    const dllB = makePackage(fallbackB, "Acme.B");
    const dllHome = makePackage(defaultCache, "Acme.Home");
    writeAssets(ws, [fallbackA, fallbackB, defaultCache], ["Acme.A", "Acme.B", "Acme.Home"]);

    const discovered = discoverNugetReferenceDirs(ws, {
      env: { NUGET_FALLBACK_PACKAGES: `${fallbackA};${fallbackB}` },
      homeDir: home,
    });
    expect(discovered.referenceDirs).toEqual([realpathSync(dllA), realpathSync(dllB), realpathSync(dllHome)].sort());
    expect(discovered.warnings).toEqual([]);
  });

  it("honours the globalPackagesFolder of the user-level NuGet.Config", () => {
    const base = tempDir("causoryn-nuget-config-");
    const ws = join(base, "ws");
    const home = join(base, "home");
    const appData = join(base, "appdata");
    const configured = join(base, "configured-cache");
    const dll = makePackage(configured, "Acme.Configured");
    const configDir =
      process.platform === "win32" ? join(appData, "NuGet") : join(home, ".nuget", "NuGet");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "NuGet.Config"),
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<configuration>",
        "  <config>",
        `    <add key="globalPackagesFolder" value="${configured}" />`,
        "  </config>",
        "</configuration>",
        "",
      ].join("\n"),
      "utf8",
    );
    writeAssets(ws, [configured], ["Acme.Configured"]);
    mkdirSync(home, { recursive: true });

    expect(
      discoverNugetReferenceDirs(ws, { env: { APPDATA: appData }, homeDir: home }).referenceDirs,
    ).toEqual([realpathSync(dll)]);
  });

  it("honours a packages folder inside the workspace without any trust configuration", () => {
    const base = tempDir("causoryn-nuget-local-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    const dll = makePackage(local, "Acme.Local");
    writeAssets(ws, [local], ["Acme.Local"]);
    expect(discoverNugetReferenceDirs(ws, noTrust()).referenceDirs).toEqual([realpathSync(dll)]);
  });

  it("ignores a packageFolder that is lexically inside a trusted root but reached through a link leaving it", () => {
    const base = tempDir("causoryn-nuget-hop-");
    const ws = join(base, "ws");
    const trusted = join(base, "trusted");
    const outside = join(base, "outside");
    mkdirSync(trusted, { recursive: true });
    makePackage(join(outside, "inner"), "Acme.Hop");
    try {
      symlinkSync(outside, join(trusted, "hop"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // link creation needs privileges in some sandboxes
    }
    writeAssets(ws, [join(trusted, "hop", "inner")], ["Acme.Hop"]);
    const discovered = discoverNugetReferenceDirs(ws, { env: { NUGET_PACKAGES: trusted }, homeDir: noTrust().homeDir });
    expect(discovered.referenceDirs).toEqual([]);
    expect(discovered.warnings).toHaveLength(1);
  });

  it("forwards the ignored-packageFolders warning in the analysis result", async () => {
    const base = tempDir("causoryn-nuget-warn-");
    const ws = join(base, "ws");
    const foreign = join(base, "foreign");
    makePackage(foreign, "Acme.Foreign");
    writeAssets(ws, [foreign], ["Acme.Foreign"]);
    let request: Record<string, unknown> | undefined;
    const result = await analyzeCSharpWorkspace({
      workspaceId: "ws_nuget_warning",
      rootDir: ws,
      files: [{ path: "Program.cs", content: "public class P {}" }],
      options: {
        spawnProcess: () =>
          syntheticWorker((raw) => {
            request = JSON.parse(raw) as Record<string, unknown>;
            return { id: "analyze:ws_nuget_warning", protocolVersion: "1", status: "ready", coverageRatio: 1, nodes: [], edges: [], evidence: [] };
          }),
      },
    });
    expect(request?.["referenceDirs"]).toBeUndefined();
    expect(result.warnings).toContain(
      "obj/project.assets.json: ignored 1 NuGet packageFolders entry outside the trusted NuGet package roots and the workspace",
    );
  });
});

/** Writes `obj/project.assets.json` with explicit targets/libraries (net10.0) and package folders. */
function writeRawAssets(
  projectDir: string,
  packageFolders: readonly string[],
  targets: Record<string, unknown>,
  libraries: Record<string, unknown>,
): void {
  mkdirSync(join(projectDir, "obj"), { recursive: true });
  writeFileSync(
    join(projectDir, "obj", "project.assets.json"),
    JSON.stringify({
      version: 3,
      targets: { "net10.0": targets },
      libraries,
      packageFolders: Object.fromEntries(packageFolders.map((folder) => [folder, {}])),
    }),
    "utf8",
  );
}

/**
 * An assets file under `projectDir` whose package `acme.wide/1.0.0` exists but whose
 * 30,000 compile entries all lie in distinct, missing directories (4 probes each).
 * `early` adds a package with a real DLL that sorts before it.
 */
function writeWideAssets(projectDir: string, local: string, early?: string): void {
  mkdirSync(join(local, "acme.wide", "1.0.0", "lib"), { recursive: true });
  const wideCompile = Object.fromEntries(Array.from({ length: 30_000 }, (_, index) => [`lib/d${String(index)}/x.dll`, {}]));
  const targets: Record<string, unknown> = { "Acme.Wide/1.0.0": { type: "package", compile: wideCompile } };
  const libraries: Record<string, unknown> = { "Acme.Wide/1.0.0": { type: "package", path: "acme.wide/1.0.0" } };
  if (early !== undefined) {
    targets[`${early}/1.0.0`] = { type: "package", compile: { [`lib/net10.0/${early}.dll`]: {} } };
    libraries[`${early}/1.0.0`] = { type: "package", path: `${early.toLowerCase()}/1.0.0` };
  }
  writeRawAssets(projectDir, [local], targets, libraries);
}

const PER_FILE_STOP = (displayPath: string): string =>
  `${displayPath}: NuGet reference discovery stopped after 10000 file system probes for this assets file; its remaining entries were not inspected`;
const GLOBAL_STOP =
  "NuGet reference discovery stopped after 20000 file system probes; the remaining project.assets.json entries were not inspected";

describe("NuGet assets discovery budget (security finding F45)", () => {
  it("one assets file stops at its own probe budget with a warning; packages found before it are kept", () => {
    const base = tempDir("causoryn-nuget-budget-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    const realDll = makePackage(local, "Acme.Early");
    writeWideAssets(ws, local, "Acme.Early");

    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([realpathSync(realDll)]);
    expect(discovered.warnings).toEqual([PER_FILE_STOP("obj/project.assets.json")]);
  }, 60_000);

  it("one crafted assets file cannot starve the assets files after it", () => {
    const base = tempDir("causoryn-nuget-starve-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    writeWideAssets(join(ws, "a"), local);
    const laterDll = makePackage(local, "Acme.Later");
    writeAssets(join(ws, "b"), [local], ["Acme.Later"]);

    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([realpathSync(laterDll)]);
    expect(discovered.warnings).toEqual([PER_FILE_STOP("a/obj/project.assets.json")]);
  }, 60_000);

  it("the global probe budget still bounds the whole discovery across assets files", () => {
    const base = tempDir("causoryn-nuget-global-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    for (const name of ["a1", "a2", "a3", "a4", "a5"]) writeWideAssets(join(ws, name), local);
    makePackage(local, "Acme.Last");
    writeAssets(join(ws, "z"), [local], ["Acme.Last"]);

    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([]);
    expect(discovered.warnings).toContain(PER_FILE_STOP("a1/obj/project.assets.json"));
    expect(discovered.warnings[discovered.warnings.length - 1]).toBe(GLOBAL_STOP);
  }, 120_000);

  it("a packageFolders key with more than 256 path components is ignored without spending the budget", () => {
    const base = tempDir("causoryn-nuget-deep-key-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    mkdirSync(local, { recursive: true });
    // Lexically inside the workspace, so only its depth makes it unusable.
    const deepKey = join(ws, ...Array.from({ length: 20_001 }, () => "x"));
    writeRawAssets(join(ws, "a"), [deepKey], {}, {});
    const laterDll = makePackage(local, "Acme.After");
    writeAssets(join(ws, "b"), [local], ["Acme.After"]);

    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([realpathSync(laterDll)]);
    expect(discovered.warnings).toEqual([
      "a/obj/project.assets.json: ignored 1 NuGet packageFolders entry with more than 256 path components",
    ]);
  }, 60_000);

  it("compile entries that share a directory probe it once (the probe budget is not spent per entry)", () => {
    const base = tempDir("causoryn-nuget-memo-");
    const ws = join(base, "ws");
    const local = join(ws, "packages");
    const dllDir = makePackage(local, "Acme.Shared");
    // 5,000 entries in the same existing directory; only the last DLL exists.
    const compile = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`lib/net10.0/m${String(index).padStart(4, "0")}.dll`, {}]));
    writeFileSync(join(dllDir, "m4999.dll"), "stub", "utf8");
    writeRawAssets(ws, [local], { "Acme.Shared/1.0.0": { type: "package", compile } }, {
      "Acme.Shared/1.0.0": { type: "package", path: "acme.shared/1.0.0" },
    });
    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([realpathSync(dllDir)]);
    expect(discovered.warnings).toEqual([]);
  }, 60_000);

  it("only the first 8 package folders of an assets file are inspected, with a warning", () => {
    const base = tempDir("causoryn-nuget-folders-");
    const ws = join(base, "ws");
    const folders = Array.from({ length: 12 }, (_, index) => join(ws, `f${String(index).padStart(2, "0")}`));
    for (const folder of folders) mkdirSync(folder, { recursive: true });
    const firstDll = makePackage(folders[0]!, "Acme.First");
    makePackage(folders[11]!, "Acme.Last");
    writeAssets(ws, folders, ["Acme.First", "Acme.Last"]);
    const discovered = discoverNugetReferenceDirs(ws, noTrust());
    expect(discovered.referenceDirs).toEqual([realpathSync(firstDll)]);
    expect(discovered.warnings).toEqual([
      "obj/project.assets.json: only the first 8 usable NuGet packageFolders entries were inspected; 4 further entries were skipped",
    ]);
  });
});

describe("intermediate links in workspace reads", () => {
  it("readBoundedFileNoFollow refuses a path whose intermediate directory is a link, even inside the root", () => {
    const root = tempDir("causoryn-cs-intermediate-");
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "App.csproj"), "<Project />", "utf8");
    expect(readBoundedFileNoFollow(join(root, "real", "App.csproj"), root, 1024)).toBe("<Project />");
    try {
      symlinkSync(join(root, "real"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect(readBoundedFileNoFollow(join(root, "alias", "App.csproj"), root, 1024)).toBeNull();
  });
});

function syntheticWorker(responseFactory: (requestJson: string) => unknown): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  let input = "";
  const record = child as unknown as Record<string, unknown>;
  record.stdout = stdout;
  record.stderr = new EventEmitter();
  record.stdin = Object.assign(stdin, {
    write: (chunk: string | Buffer) => {
      input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return true;
    },
    end: () => {
      const response = responseFactory(input.trim());
      queueMicrotask(() => stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`, "utf8")));
    },
  });
  record.killed = false;
  record.exitCode = null;
  record.signalCode = null;
  record.kill = () => true;
  return child;
}

describe("worker process environment", () => {
  async function capturedEnv(dotnetRoot: string | undefined, untrustedRoots: string[]): Promise<Readonly<Record<string, string>>> {
    const previous = process.env["DOTNET_ROOT"];
    if (dotnetRoot === undefined) delete process.env["DOTNET_ROOT"];
    else process.env["DOTNET_ROOT"] = dotnetRoot;
    let env: Readonly<Record<string, string>> = {};
    try {
      const workerDll = join(tempDir("causoryn-cs-env-"), "Causoryn.RoslynWorker.dll");
      const outcome = await runWorkerAnalyze({
        dotnetCommand: process.execPath,
        workerDllPath: workerDll,
        requestPayload: { id: "env" },
        requestTimeoutMs: 5_000,
        untrustedRoots,
        spawnProcess: (_command, _args, options) => {
          env = options.env;
          return syntheticWorker(() => ({ id: "env", protocolVersion: "1", status: "ready" }));
        },
      });
      expect(outcome.status).toBe("ok");
    } finally {
      if (previous === undefined) delete process.env["DOTNET_ROOT"];
      else process.env["DOTNET_ROOT"] = previous;
    }
    return env;
  }

  it("pins DOTNET_EnableDiagnostics=0 and an empty DOTNET_ADDITIONAL_DEPS", async () => {
    const env = await capturedEnv(undefined, []);
    expect(env["DOTNET_EnableDiagnostics"]).toBe("0");
    expect(env["DOTNET_ADDITIONAL_DEPS"]).toBe("");
    expect(env["DOTNET_STARTUP_HOOKS"]).toBe("");
  });

  it("keeps a local DOTNET_ROOT outside the workspace and drops relative, UNC or in-workspace values", async () => {
    const ws = tempDir("causoryn-cs-ws-");
    const outside = tempDir("causoryn-cs-dotnet-");
    expect((await capturedEnv(outside, [ws]))["DOTNET_ROOT"]).toBe(outside);
    expect((await capturedEnv(join(ws, "dotnet"), [ws]))["DOTNET_ROOT"]).toBeUndefined();
    expect((await capturedEnv("relative/dotnet", [ws]))["DOTNET_ROOT"]).toBeUndefined();
    expect((await capturedEnv("\\\\host.invalid\\share\\dotnet", [ws]))["DOTNET_ROOT"]).toBeUndefined();
    expect((await capturedEnv("//host.invalid/share/dotnet", [ws]))["DOTNET_ROOT"]).toBeUndefined();
  });
});
