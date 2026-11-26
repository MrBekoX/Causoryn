import { afterEach, describe, expect, it } from "vitest";

import {
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
  type RoslynFingerprintContext,
  type RoslynRefPackEntry,
} from "../src/index.js";

/**
 * The analyzerFingerprint must not carry the absolute .NET reference-pack
 * directory (security finding F30, CWE-497): the Roslyn worker reports
 * `reference pack loaded: <pack> <version> (<tfmDir>)` with tfmDir under the
 * discovered dotnet root, and a user-local install (~/.dotnet, DOTNET_ROOT in
 * the profile, %LOCALAPPDATA%) puts the OS user name and folder layout into
 * that path. The fingerprint is snapshot.meta.analyzerFingerprint, which the
 * JSON, Markdown and HTML documentation exports print.
 *
 * The fingerprint keeps what identifies the reference assemblies: the pack,
 * its version and the target framework directory name. Those still change the
 * fingerprint (cache invalidation), and the same input still gives the same
 * fingerprint (determinism).
 */

const SETTINGS = {
  dotnetCommand: "dotnet",
  requestTimeoutMs: 30_000,
  workerDllPath: "native/roslyn-worker/bin/Release/net10.0/Causoryn.RoslynWorker.dll",
} as const;

function fingerprintOf(packs: readonly RoslynRefPackEntry[]): string {
  const csharp: RoslynFingerprintContext = {
    analyzerId: "roslyn-worker",
    version: "0.1.0",
    discovery: "performed",
    refPacks: { packs, source: "worker-discovered" },
    settings: SETTINGS,
  };
  return buildAnalyzerFingerprint({ typescript: null, csharp });
}

const LINUX_USER_PACK: RoslynRefPackEntry = {
  pack: "Microsoft.NETCore.App.Ref",
  version: "8.0.11",
  tfmDir: "/home/demo/.dotnet/packs/Microsoft.NETCore.App.Ref/8.0.11/ref/net8.0",
};

const WINDOWS_USER_PACK: RoslynRefPackEntry = {
  pack: "Microsoft.AspNetCore.App.Ref",
  version: "10.0.1",
  tfmDir: "C:\\Users\\demo\\AppData\\Local\\Microsoft\\dotnet\\packs\\Microsoft.AspNetCore.App.Ref\\10.0.1\\ref\\net10.0",
};

const originalDotnetRoot = process.env["DOTNET_ROOT"];
afterEach(() => {
  if (originalDotnetRoot === undefined) delete process.env["DOTNET_ROOT"];
  else process.env["DOTNET_ROOT"] = originalDotnetRoot;
});

describe("analyzerFingerprint refpack segment (no local install path)", () => {
  it("records pack, version and target framework, never the absolute directory or the user name (POSIX)", () => {
    const fp = fingerprintOf([LINUX_USER_PACK]);
    expect(fp.split("|")).toContain("refpack=Microsoft.NETCore.App.Ref@8.0.11@net8.0");
    expect(fp).not.toContain("demo");
    expect(fp).not.toContain("/home");
    expect(fp).not.toContain(".dotnet");
    expect(fp).not.toContain("/");
  });

  it("records pack, version and target framework, never the absolute directory or the user name (Windows)", () => {
    const fp = fingerprintOf([LINUX_USER_PACK, WINDOWS_USER_PACK]);
    expect(fp.split("|")).toContain(
      "refpack=Microsoft.NETCore.App.Ref@8.0.11@net8.0;Microsoft.AspNetCore.App.Ref@10.0.1@net10.0",
    );
    expect(fp).not.toContain("demo");
    expect(fp).not.toContain("Users");
    expect(fp).not.toContain("AppData");
    expect(fp).not.toContain("\\");
    expect(fp).not.toContain("C:");
  });

  it("keeps the path out when the fingerprint is built from the worker's own warning lines", () => {
    process.env["DOTNET_ROOT"] = "/home/demo/.dotnet";
    const context = extractRoslynRefPackContext([
      "reference pack loaded: Microsoft.NETCore.App.Ref 8.0.11 (/home/demo/.dotnet/packs/Microsoft.NETCore.App.Ref/8.0.11/ref/net8.0)",
    ]);
    expect(context).not.toBeNull();
    // The discovery source is still derived from the full directory.
    expect(context?.source).toBe("env-dotnet-root");
    const fp = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp: {
        analyzerId: "roslyn-worker",
        version: "0.1.0",
        discovery: "performed",
        refPacks: context,
        settings: SETTINGS,
      },
    });
    expect(fp.split("|")).toEqual(
      expect.arrayContaining(["refpack=Microsoft.NETCore.App.Ref@8.0.11@net8.0", "refsrc=env-dotnet-root"]),
    );
    expect(fp).not.toContain("demo");
  });

  it("stays deterministic, and a pack version, target framework or pack set change still changes it", () => {
    const base = fingerprintOf([LINUX_USER_PACK]);
    expect(fingerprintOf([{ ...LINUX_USER_PACK }])).toBe(base);
    expect(
      fingerprintOf([
        { ...LINUX_USER_PACK, version: "8.0.12", tfmDir: LINUX_USER_PACK.tfmDir.replace("8.0.11", "8.0.12") },
      ]),
    ).not.toBe(base);
    expect(fingerprintOf([{ ...LINUX_USER_PACK, tfmDir: LINUX_USER_PACK.tfmDir.replace(/net8\.0$/, "net7.0") }])).not.toBe(
      base,
    );
    expect(fingerprintOf([LINUX_USER_PACK, WINDOWS_USER_PACK])).not.toBe(base);
  });

  it("the same reference pack installed under another root gives the same fingerprint (same reference assemblies)", () => {
    const userLocal = fingerprintOf([LINUX_USER_PACK]);
    const systemWide = fingerprintOf([
      { ...LINUX_USER_PACK, tfmDir: "/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/8.0.11/ref/net8.0" },
    ]);
    expect(systemWide).toBe(userLocal);
  });

  it("takes the directory name when the reported directory ends with a separator", () => {
    expect(fingerprintOf([{ ...LINUX_USER_PACK, tfmDir: `${LINUX_USER_PACK.tfmDir}/` }])).toBe(
      fingerprintOf([LINUX_USER_PACK]),
    );
  });
});
