/**
 * MSBuild project model of the C# adapter: SDK implicit global usings,
 * `Using` items, `Directory.Build.props`, ProjectReference and project ownership.
 *
 * Unit tests run without dotnet (pure read-only discovery over temporary
 * directories). The live tests drive the real Roslyn worker through
 * analyzeCSharpWorkspace and prove two things for an SDK-style project:
 * with `<ImplicitUsings>enable</ImplicitUsings>` the false CS0246/CS0103
 * diagnostics disappear and BCL calls become verified CALLS edges; with the
 * feature disabled the same sources keep their diagnostics (nothing is filtered).
 *
 * Temporary workspaces live under os.tmpdir() and are removed; the repository
 * is never written. Process safety: the worker runs as the literal `dotnet`
 * executable with a fixed argument array (adapter worker-process.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRoslynWorkerBinary } from "../../../tests/roslyn-worker-build.js";
import {
  analyzeCSharpWorkspace,
  resolveCSharpProjects,
  type CSharpProjectSpec,
  type RoslynAdapterResult,
} from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKER_DLL = join(REPO_ROOT, "native", "roslyn-worker", "bin", "Debug", "net10.0", "Causoryn.RoslynWorker.dll");

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Creates a temporary workspace (plus an outer directory) from relative path → content. */
function workspace(files: Record<string, string>, outerFiles: Record<string, string> = {}): string {
  const outer = mkdtempSync(join(os.tmpdir(), "causoryn-csproj-model-"));
  tempRoots.push(outer);
  const root = join(outer, "ws");
  mkdirSync(root);
  const write = (base: string, entries: Record<string, string>): void => {
    for (const [relative, content] of Object.entries(entries)) {
      const target = join(base, ...relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  };
  write(outer, outerFiles);
  write(root, files);
  return root;
}

function project(body: string, sdk = "Microsoft.NET.Sdk"): string {
  return `<Project Sdk="${sdk}">\n${body}\n</Project>\n`;
}

function props(entries: Record<string, string>): string {
  const lines = Object.entries(entries).map(([name, value]) => `    <${name}>${value}</${name}>`);
  return `  <PropertyGroup>\n${lines.join("\n")}\n  </PropertyGroup>`;
}

function names(spec: CSharpProjectSpec | undefined): string[] {
  return (spec?.globalUsings ?? []).map((u) =>
    u.alias !== undefined ? `${u.alias}=${u.name}` : u.static === true ? `static ${u.name}` : u.name,
  );
}

const BASE = [
  "System",
  "System.Collections.Generic",
  "System.IO",
  "System.Linq",
  "System.Net.Http",
  "System.Threading",
  "System.Threading.Tasks",
];

describe("resolveCSharpProjects: SDK implicit global usings", () => {
  it.each(["enable", "true", "Enable", "TRUE", "  enable  "])(
    "ImplicitUsings '%s' adds the Microsoft.NET.Sdk defaults",
    (value) => {
      const root = workspace({
        "App/App.csproj": project(props({ ImplicitUsings: value, TargetFramework: "net10.0" })),
        "App/Program.cs": "class P { }",
      });
      const result = resolveCSharpProjects(root, ["App/Program.cs"]);
      expect(result.projects.map((p) => p.path)).toEqual(["App/App.csproj"]);
      expect(names(result.projects[0])).toEqual(BASE);
      expect(result.warnings).toEqual([]);
    },
  );

  it.each(["disable", "false", ""])("ImplicitUsings '%s' adds nothing (project still partitioned)", (value) => {
    const root = workspace({
      "App/App.csproj": project(props({ ImplicitUsings: value })),
      "App/Program.cs": "class P { }",
    });
    const result = resolveCSharpProjects(root, ["App/Program.cs"]);
    expect(result.projects).toEqual([{ path: "App/App.csproj", globalUsings: [], projectReferences: [] }]);
  });

  it("an absent ImplicitUsings property adds nothing", () => {
    const root = workspace({ "App/App.csproj": project(props({ TargetFramework: "net8.0" })), "App/a.cs": "" });
    expect(names(resolveCSharpProjects(root, ["App/a.cs"]).projects[0])).toEqual([]);
  });

  it("Microsoft.NET.Sdk.Web and Microsoft.NET.Sdk.Worker add their documented namespaces", () => {
    const root = workspace({
      "Web/Web.csproj": project(props({ ImplicitUsings: "enable" }), "Microsoft.NET.Sdk.Web"),
      "Web/a.cs": "",
      "Svc/Svc.csproj": project(props({ ImplicitUsings: "enable" }), "Microsoft.NET.Sdk.Worker/8.0.0"),
      "Svc/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["Web/a.cs", "Svc/a.cs"]);
    const svc = result.projects.find((p) => p.path === "Svc/Svc.csproj");
    const web = result.projects.find((p) => p.path === "Web/Web.csproj");
    expect(names(web)).toEqual(
      [
        ...BASE,
        "System.Net.Http.Json",
        "Microsoft.AspNetCore.Builder",
        "Microsoft.AspNetCore.Hosting",
        "Microsoft.AspNetCore.Http",
        "Microsoft.AspNetCore.Routing",
        "Microsoft.Extensions.Configuration",
        "Microsoft.Extensions.DependencyInjection",
        "Microsoft.Extensions.Hosting",
        "Microsoft.Extensions.Logging",
      ].sort(),
    );
    expect(names(svc)).toEqual(
      [
        ...BASE,
        "Microsoft.Extensions.Configuration",
        "Microsoft.Extensions.DependencyInjection",
        "Microsoft.Extensions.Hosting",
        "Microsoft.Extensions.Logging",
      ].sort(),
    );
  });

  it("WPF removes System.IO and System.Net.Http; Windows Forms adds System.Drawing and System.Windows.Forms", () => {
    const root = workspace({
      "Wpf/Wpf.csproj": project(props({ ImplicitUsings: "enable", UseWPF: "true" }), "Microsoft.NET.Sdk.WindowsDesktop"),
      "Wpf/a.cs": "",
      "Forms/Forms.csproj": project(props({ ImplicitUsings: "enable", UseWindowsForms: "True" })),
      "Forms/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["Wpf/a.cs", "Forms/a.cs"]);
    expect(names(result.projects.find((p) => p.path === "Wpf/Wpf.csproj"))).toEqual(
      BASE.filter((n) => n !== "System.IO" && n !== "System.Net.Http"),
    );
    expect(names(result.projects.find((p) => p.path === "Forms/Forms.csproj"))).toEqual(
      [...BASE, "System.Drawing", "System.Windows.Forms"].sort(),
    );
  });

  it(".NET Framework target frameworks do not get System.Net.Http", () => {
    const root = workspace({
      "Old/Old.csproj": project(props({ ImplicitUsings: "enable", TargetFramework: "net48", LangVersion: "10" })),
      "Old/a.cs": "",
      "Multi/Multi.csproj": project(props({ ImplicitUsings: "enable", TargetFrameworks: "net48;net8.0" })),
      "Multi/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["Old/a.cs", "Multi/a.cs"]);
    expect(names(result.projects.find((p) => p.path === "Old/Old.csproj"))).not.toContain("System.Net.Http");
    // The modern target is preferred for the single analysis compilation.
    expect(names(result.projects.find((p) => p.path === "Multi/Multi.csproj"))).toContain("System.Net.Http");
  });

  it("legacy (non-SDK) projects get no implicit usings and no warning", () => {
    const root = workspace({
      "Legacy/Legacy.csproj":
        '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n' +
        props({ ImplicitUsings: "enable" }) +
        '\n  <ItemGroup><Using Include="System.Text" /></ItemGroup>\n</Project>\n',
      "Legacy/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["Legacy/a.cs"]);
    expect(names(result.projects[0])).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("an SDK outside the documented table is reported, not guessed", () => {
    const root = workspace({
      "Tests/Tests.csproj": project(props({ ImplicitUsings: "enable" }), "MSTest.Sdk/3.6.0"),
      "Tests/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["Tests/a.cs"]);
    expect(names(result.projects[0])).toEqual([]);
    expect(result.warnings).toEqual([
      "C# project 'Tests/Tests.csproj': SDK 'MSTest.Sdk' is not modeled; its implicit global usings and Using items were not added",
    ]);
  });
});

describe("resolveCSharpProjects: Using items and Directory.Build.props", () => {
  it("honors Using Include, Remove, Alias and Static (attributes and metadata elements)", () => {
    const root = workspace({
      "App/App.csproj": project(
        props({ ImplicitUsings: "enable" }) +
          "\n  <ItemGroup>\n" +
          '    <Using Remove="System.Net.Http" />\n' +
          '    <Using Include="System.Text;System.Text.Json" />\n' +
          '    <Using Include="System.Math" Static="true" />\n' +
          '    <Using Include="System.Console"><Static>True</Static></Using>\n' +
          '    <Using Include="System.Text.StringBuilder" Alias="SB" />\n' +
          '    <Using Include="System.Collections.Generic.Dictionary"><Alias>Dict</Alias></Using>\n' +
          '    <Using Include="System" />\n' +
          "  </ItemGroup>",
      ),
      "App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(result.warnings).toEqual([]);
    expect(names(result.projects[0])).toEqual([
      "System",
      "System.Collections.Generic",
      "System.IO",
      "System.Linq",
      "System.Text",
      "System.Text.Json",
      "System.Threading",
      "System.Threading.Tasks",
      "static System.Console",
      "static System.Math",
      "Dict=System.Collections.Generic.Dictionary",
      "SB=System.Text.StringBuilder",
    ]);
  });

  it("Using items apply without ImplicitUsings (explicit global usings are independent)", () => {
    const root = workspace({
      "App/App.csproj": project('  <ItemGroup><Using Include="System" /></ItemGroup>'),
      "App/a.cs": "",
    });
    expect(names(resolveCSharpProjects(root, ["App/a.cs"]).projects[0])).toEqual(["System"]);
  });

  it("Directory.Build.props enables ImplicitUsings; the project file overrides it", () => {
    const root = workspace({
      "Directory.Build.props": `<Project>\n${props({ ImplicitUsings: "enable" })}\n</Project>\n`,
      "src/On/On.csproj": project(props({ TargetFramework: "net10.0" })),
      "src/On/a.cs": "",
      "src/Off/Off.csproj": project(props({ ImplicitUsings: "disable" })),
      "src/Off/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["src/On/a.cs", "src/Off/a.cs"]);
    expect(names(result.projects.find((p) => p.path === "src/On/On.csproj"))).toEqual(BASE);
    expect(names(result.projects.find((p) => p.path === "src/Off/Off.csproj"))).toEqual([]);
  });

  it("the nearest Directory.Build.props wins and its Using Remove cannot remove SDK defaults (import order)", () => {
    const root = workspace({
      "Directory.Build.props": `<Project>\n${props({ ImplicitUsings: "disable" })}\n</Project>\n`,
      "src/Directory.Build.props":
        `<Project>\n${props({ ImplicitUsings: "enable" })}\n` +
        '  <ItemGroup><Using Remove="System.Linq" /><Using Include="System.Text" /></ItemGroup>\n</Project>\n',
      "src/App/App.csproj": project(""),
      "src/App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["src/App/a.cs"]);
    expect(names(result.projects[0])).toEqual([...BASE, "System.Text"].sort());
  });

  it("the self-default condition '$(ImplicitUsings)' == '' is evaluated", () => {
    const root = workspace({
      "Directory.Build.props":
        "<Project>\n  <PropertyGroup>\n" +
        "    <ImplicitUsings Condition=\"'$(ImplicitUsings)' == ''\">enable</ImplicitUsings>\n" +
        "  </PropertyGroup>\n</Project>\n",
      "App/App.csproj": project(""),
      "App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(names(result.projects[0])).toEqual(BASE);
    expect(result.warnings).toEqual([]);
  });

  it("other conditions are not evaluated and say so explicitly", () => {
    const root = workspace({
      "App/App.csproj": project(
        "  <PropertyGroup Condition=\"'$(Configuration)' == 'Debug'\">\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n" +
          "  <ItemGroup Condition=\"'$(TargetFramework)' == 'net8.0'\"><Using Include=\"System.Text\" /></ItemGroup>",
      ),
      "App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(names(result.projects[0])).toEqual([]);
    expect(result.warnings).toEqual([
      "C# project 'App/App.csproj': <ImplicitUsings> in App/App.csproj is set under a condition that is not evaluated ('$(Configuration)' == 'Debug'); the setting was ignored",
      "C# project 'App/App.csproj': a Using item in App/App.csproj is conditional ('$(TargetFramework)' == 'net8.0') and not evaluated; the item was skipped",
    ]);
  });

  it("project-file text quoted in warnings has control characters flattened and is length-capped", () => {
    const longCondition = `'$(A)'\n==\r\n'${"x".repeat(400)}'`;
    const root = workspace({
      "App/App.csproj": project(
        `  <PropertyGroup Condition="${longCondition}">\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>`,
      ),
      "App/a.cs": "",
    });
    const [warning] = resolveCSharpProjects(root, ["App/a.cs"]).warnings;
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/[\r\n]/);
    expect(warning?.length ?? 0).toBeLessThan(400);
    expect(warning).toContain("...");
  });

  it("never reads a Directory.Build.props above the workspace root", () => {
    const root = workspace(
      { "App/App.csproj": project(""), "App/a.cs": "" },
      { "Directory.Build.props": `<Project>\n${props({ ImplicitUsings: "enable" })}\n</Project>\n` },
    );
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(names(result.projects[0])).toEqual([]);
  });

  it("invalid Using names are skipped with a warning (no code injection reaches the worker)", () => {
    const root = workspace({
      "App/App.csproj": project(
        '  <ItemGroup><Using Include="System; class Injected { }" /><Using Include="System.Math" Static="true" Alias="M" /></ItemGroup>',
      ),
      "App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    // MSBuild splits Include on ';': "System" is a valid item, the rest is not.
    expect(names(result.projects[0])).toEqual(["System"]);
    expect(result.warnings).toEqual([
      "C# project 'App/App.csproj': Using item 'class Injected { }' in App/App.csproj is not a dotted C# name; skipped",
      "C# project 'App/App.csproj': Using item 'System.Math' in App/App.csproj is both static and aliased, which the .NET SDK rejects; skipped",
    ]);
  });

  it("malformed project XML degrades with a warning; the project is still partitioned", () => {
    const root = workspace({
      "App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</PropertyGroup></Project>',
      "App/a.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(result.projects).toEqual([{ path: "App/App.csproj", globalUsings: [], projectReferences: [] }]);
    expect(result.warnings[0]).toMatch(/^C# project 'App\/App\.csproj': App\/App\.csproj is not valid MSBuild XML/);
  });
});

describe("resolveCSharpProjects: ownership, references and safety", () => {
  it("sources belong to the nearest project directory; files outside projects stay unassigned", () => {
    const root = workspace({
      "App/App.csproj": project(""),
      "App/a.cs": "",
      "App/Nested/Inner.csproj": project(""),
      "App/Nested/b.cs": "",
      "App/Sub/c.cs": "",
      "Scripts/d.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs", "App/Nested/b.cs", "App/Sub/c.cs", "Scripts/d.cs"]);
    expect(result.projects.map((p) => p.path)).toEqual(["App/App.csproj", "App/Nested/Inner.csproj"]);
  });

  it("several project files in one directory: the ordinal-first one owns the sources, with a warning", () => {
    const root = workspace({ "App/B.csproj": project(""), "App/A.csproj": project(""), "App/a.cs": "" });
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(result.projects.map((p) => p.path)).toEqual(["App/A.csproj"]);
    expect(result.warnings).toEqual([
      "C# project discovery: 'App' contains 2 project files; 'A.csproj' owns its sources and the others were ignored",
    ]);
  });

  it("ProjectReference paths resolve to owning projects; outside-workspace references are skipped", () => {
    const root = workspace({
      "src/App/App.csproj": project(
        "  <ItemGroup>\n" +
          '    <ProjectReference Include="..\\Lib\\Lib.csproj" />\n' +
          '    <ProjectReference Include="..\\..\\..\\Outside\\Outside.csproj" />\n' +
          '    <ProjectReference Include="..\\NoSources\\NoSources.csproj" />\n' +
          "  </ItemGroup>",
      ),
      "src/App/a.cs": "",
      "src/Lib/Lib.csproj": project(props({ AssemblyName: "Company.Lib" })),
      "src/Lib/b.cs": "",
      "src/NoSources/NoSources.csproj": project(""),
    });
    const result = resolveCSharpProjects(root, ["src/App/a.cs", "src/Lib/b.cs"]);
    expect(result.projects).toEqual([
      { path: "src/App/App.csproj", globalUsings: [], projectReferences: ["src/Lib/Lib.csproj"] },
      { path: "src/Lib/Lib.csproj", assemblyName: "Company.Lib", globalUsings: [], projectReferences: [] },
    ]);
    expect(result.warnings).toEqual([
      "C# project 'src/App/App.csproj': ProjectReference '..\\..\\..\\Outside\\Outside.csproj' points outside the workspace; skipped",
    ]);
  });

  it("no project files → no projects (single shared compilation, historical behavior)", () => {
    const root = workspace({ "a.cs": "", "x/b.cs": "" });
    expect(resolveCSharpProjects(root, ["a.cs", "x/b.cs"])).toEqual({ projects: [], warnings: [] });
  });

  it("an unusable root (relative or missing) yields no projects", () => {
    expect(resolveCSharpProjects("relative/root", ["a.cs"])).toEqual({ projects: [], warnings: [] });
    expect(resolveCSharpProjects(join(os.tmpdir(), "causoryn-missing-root-xyz"), ["a.cs"])).toEqual({
      projects: [],
      warnings: [],
    });
  });

  it("a symbolic-link project file is never read", () => {
    const root = workspace({ "real/Real.csproj": project(props({ ImplicitUsings: "enable" })), "App/a.cs": "" });
    try {
      symlinkSync(join(root, "real", "Real.csproj"), join(root, "App", "App.csproj"), "file");
    } catch {
      // Symlink creation needs a privilege on some Windows setups; the guarded
      // path is then covered by the regular-file check alone.
      return;
    }
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(result.projects).toEqual([]);
  });

  it("ProjectReference items of Directory.Build.props apply to every project (relative to the project directory)", () => {
    const root = workspace({
      "Directory.Build.props":
        '<Project>\n  <ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup>\n</Project>\n',
      "App/App.csproj": project(""),
      "App/a.cs": "",
      "Core/Core.csproj": project(""),
      "Core/c.cs": "",
    });
    const result = resolveCSharpProjects(root, ["App/a.cs", "Core/c.cs"]);
    expect(result.projects.find((p) => p.path === "App/App.csproj")?.projectReferences).toEqual(["Core/Core.csproj"]);
    // A project never references itself.
    expect(result.projects.find((p) => p.path === "Core/Core.csproj")?.projectReferences).toEqual([]);
  });

  it("an <Import> inside Directory.Build.props is reported as not followed", () => {
    const root = workspace({
      "Directory.Build.props": '<Project>\n  <Import Project="..\\Shared.props" />\n</Project>\n',
      "App/App.csproj": project(""),
      "App/a.cs": "",
    });
    expect(resolveCSharpProjects(root, ["App/a.cs"]).warnings).toEqual([
      "C# project 'App/App.csproj': <Import> elements in Directory.Build.props are not followed; settings in imported files were not modeled",
    ]);
  });

  it("an unsafe nearest Directory.Build.props stops the search with a warning (no fallback to a farther one)", () => {
    const root = workspace({
      "Directory.Build.props": `<Project>\n${props({ ImplicitUsings: "enable" })}\n</Project>\n`,
      "App/App.csproj": project(""),
      "App/a.cs": "",
    });
    mkdirSync(join(root, "App", "Directory.Build.props"));
    const result = resolveCSharpProjects(root, ["App/a.cs"]);
    expect(names(result.projects[0])).toEqual([]);
    expect(result.warnings).toEqual([
      "C# project 'App/App.csproj': App/Directory.Build.props is not a regular file reached without symbolic links; it was not read and its settings were not modeled",
    ]);
  });

  it("a project reached through a linked intermediate directory (junction/symlink) is never read", () => {
    const root = workspace({ "real/App/App.csproj": project(props({ ImplicitUsings: "enable" })), "real/App/a.cs": "" });
    try {
      symlinkSync(join(root, "real"), join(root, "link"), "junction");
    } catch {
      return; // no link support on this file system
    }
    const result = resolveCSharpProjects(root, ["link/App/a.cs"]);
    expect(result.projects).toEqual([]);
  });

  it("is deterministic", () => {
    const root = workspace({
      "A/A.csproj": project(props({ ImplicitUsings: "enable" })),
      "A/a.cs": "",
      "B/B.csproj": project('  <ItemGroup><ProjectReference Include="../A/A.csproj" /></ItemGroup>'),
      "B/b.cs": "",
    });
    const first = JSON.stringify(resolveCSharpProjects(root, ["B/b.cs", "A/a.cs"]));
    expect(JSON.stringify(resolveCSharpProjects(root, ["A/a.cs", "B/b.cs"]))).toBe(first);
  });
});

/* ------------------------------------------------------------------ */
/* Live: real Roslyn worker through analyzeCSharpWorkspace              */
/* ------------------------------------------------------------------ */

const dotnetAvailable = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!dotnetAvailable) {
  console.error("[csharp-project-model] dotnet SDK not found: live worker tests were not run (reported as not executed)");
}

const RUNNER_SOURCE = [
  "namespace App;",
  "",
  "public static class Runner",
  "{",
  "    public static int Run()",
  "    {",
  "        Console.WriteLine(\"start\");",
  "        Thread.Sleep(1);",
  "        var items = new List<int>();",
  "        items.Add(1);",
  "        return items.Count;",
  "    }",
  "}",
  "",
].join("\n");

function sdkProject(implicitUsings: string, items = ""): string {
  return project(
    props({ OutputType: "Exe", TargetFramework: "net10.0", ImplicitUsings: implicitUsings, Nullable: "enable" }) +
      (items.length > 0 ? `\n  <ItemGroup>\n${items}\n  </ItemGroup>` : ""),
  );
}

function diagnosticCodes(result: RoslynAdapterResult | null): string[] {
  return (result?.diagnostics ?? []).map((d) => d.code).sort();
}

function callTo(result: RoslynAdapterResult | null, from: string, to: string): string | undefined {
  return (result?.edges ?? []).find(
    (edge) => edge.kind === "CALLS" && edge.from.qualifiedName === from && edge.to.qualifiedName === to,
  )?.resolution;
}

describe.skipIf(!dotnetAvailable)("analyzeCSharpWorkspace: SDK implicit global usings (live worker)", () => {
  let enabled: RoslynAdapterResult | null = null;
  let disabled: RoslynAdapterResult | null = null;
  let removed: RoslynAdapterResult | null = null;
  let included: RoslynAdapterResult | null = null;
  let withoutRoot: RoslynAdapterResult | null = null;

  beforeAll(async () => {
    const build = buildRoslynWorkerBinary();
    if (build.status !== 0 || !existsSync(WORKER_DLL)) {
      throw new Error(`worker build failed (exit=${String(build.status)}); live tests are not run against a stale binary`);
    }
    const options = { workerDllPath: WORKER_DLL, requestTimeoutMs: 120_000 };
    const run = async (csproj: string, source = RUNNER_SOURCE): Promise<RoslynAdapterResult> => {
      const root = workspace({ "App/App.csproj": csproj, "App/Runner.cs": source });
      return analyzeCSharpWorkspace({
        workspaceId: "csproj-model-live",
        rootDir: root,
        files: [{ path: "App/Runner.cs", content: source }],
        options,
      });
    };
    enabled = await run(sdkProject("enable"));
    disabled = await run(sdkProject("disable"));
    removed = await run(sdkProject("enable", '    <Using Remove="System.Threading" />'));
    included = await run(
      sdkProject(
        "disable",
        '    <Using Include="System" />\n    <Using Include="System.Math" Static="true" />\n    <Using Include="System.Text.StringBuilder" Alias="SB" />',
      ),
      [
        "namespace App;",
        "public static class Runner",
        "{",
        "    public static string Run()",
        "    {",
        "        var builder = new SB();",
        "        builder.Append(Sqrt(16.0));",
        "        Console.WriteLine(builder.ToString());",
        "        return builder.ToString();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    withoutRoot = await analyzeCSharpWorkspace({
      workspaceId: "csproj-model-live",
      files: [{ path: "App/Runner.cs", content: RUNNER_SOURCE }],
      options,
    });
  }, 300_000);

  it("ImplicitUsings enable: no CS0246/CS0103 and the snapshot is ready", () => {
    expect(enabled?.workerAvailable).toBe(true);
    expect(diagnosticCodes(enabled)).toEqual([]);
    expect(enabled?.state).toBe("ready");
  });

  it("ImplicitUsings enable: BCL calls are verified CALLS edges to explicit external nodes", () => {
    expect(callTo(enabled, "App.Runner.Run", "System.Console.WriteLine")).toBe("verified");
    expect(callTo(enabled, "App.Runner.Run", "System.Threading.Thread.Sleep")).toBe("verified");
    expect(callTo(enabled, "App.Runner.Run", "System.Collections.Generic.List.Add")).toBe("verified");
    expect(enabled?.coverageRatio).toBe(1);
  });

  it("ImplicitUsings disable: the same sources keep CS0246/CS0103 (diagnostics are not filtered)", () => {
    expect(disabled?.state).toBe("partial");
    expect(diagnosticCodes(disabled)).toContain("CS0103");
    expect(diagnosticCodes(disabled)).toContain("CS0246");
    expect(callTo(disabled, "App.Runner.Run", "Console.WriteLine")).toBe("unresolved");
  });

  it("without rootDir no project model is built: diagnostics remain as before", () => {
    expect(diagnosticCodes(withoutRoot)).toContain("CS0103");
  });

  it("Using Remove drops exactly that namespace", () => {
    const codes = diagnosticCodes(removed);
    expect(codes).toContain("CS0103"); // Thread is no longer imported
    expect(
      (removed?.diagnostics ?? []).every((d) => d.message.includes("Thread")),
    ).toBe(true);
    expect(callTo(removed, "App.Runner.Run", "System.Console.WriteLine")).toBe("verified");
  });

  it("Using Include with Static and Alias metadata resolves without ImplicitUsings", () => {
    expect(diagnosticCodes(included)).toEqual([]);
    expect(callTo(included, "App.Runner.Run", "System.Math.Sqrt")).toBe("verified");
    expect(callTo(included, "App.Runner.Run", "System.Text.StringBuilder")).toBe("verified");
    expect(callTo(included, "App.Runner.Run", "System.Console.WriteLine")).toBe("verified");
  });
});
