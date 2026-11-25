import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_SKILL_NAMES,
  SIDECAR_TOOLCHAIN_IDS,
  formatDoctorReportText,
  runCli,
  runDoctor,
  runSetup,
  type ToolchainProbeFn,
  type ToolchainProbeOutcome,
} from "../packages/causoryn/src/index.js";
import { defaultToolchainProbe } from "../packages/causoryn/src/doctor.js";

/**
 * Doctor sidecar-toolchain health: an installed toolchain that is below the
 * supported floor (Python >= 3.10, Go >= 1.26, .NET 10 runtime) or whose probe
 * fails is a warning that makes the report DEGRADED; an absent optional
 * toolchain is informational only. Doctor stays strictly read-only.
 */

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-doctor-tc-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createFakePkg(baseDir: string): string {
  const pkgRoot = path.join(baseDir, "pkg");
  const files: Record<string, string> = {
    "package.json": '{"name":"causoryn","version":"0.3.0"}',
    "scripts/causoryn.mjs": "#!/usr/bin/env node\n",
    "dist/mcp-server.mjs": "// bundle\n",
    [`dist/node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`]: "bin",
    "dist/typescript-lib/lib.es2022.full.d.ts": "interface Array<T> {}\n",
    "native/python-worker/worker.py": "# py\n",
    "native/go-worker/cmd/worker/main.go": "package main\n",
    "native/rust-worker/Cargo.toml": "[package]\n",
    "native/roslyn-worker/Causoryn.RoslynWorker.csproj": "<Project />\n",
    "native/roslyn-worker/Causoryn.RoslynWorker.dll": "dll",
  };
  for (const skillName of CANONICAL_SKILL_NAMES) {
    files[`skills/${skillName}/SKILL.md`] = `---\nname: ${skillName}\n---\n`;
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pkgRoot, ...rel.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return pkgRoot;
}

function snapshotTree(rootDir: string): string[] {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      if (item.isDirectory()) {
        entries.push(`d:${rel}`);
        walk(full);
      } else {
        const st = statSync(full);
        entries.push(`f:${rel}:${String(st.size)}:${String(st.mtimeMs)}`);
      }
    }
  };
  walk(rootDir);
  return entries.sort();
}

const HEALTHY_OUTPUT: Readonly<Record<string, string>> = {
  dotnet: [
    "Microsoft.AspNetCore.App 10.0.11 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]",
    "Microsoft.NETCore.App 8.0.1 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
    "Microsoft.NETCore.App 10.0.11 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
  ].join("\n"),
  python: "Python 3.12.4",
  go: "go version go1.26.11 linux/amd64",
  cargo: "cargo 1.100.0 (3acc79c0c 2026-11-05)",
};

function ok(output: string): ToolchainProbeOutcome {
  const firstLine = output.split("\n")[0] ?? output;
  return { available: true, version: firstLine, detail: "ok", output };
}

/**
 * Probe that answers like real, supported toolchains, with per-command overrides.
 * `python3` is not installed unless overridden, so on POSIX (where doctor tries
 * python3 before python) the `python` answers below are the ones reported.
 */
function makeProbe(
  overrides: Partial<Record<string, ToolchainProbeOutcome>> = {},
  seen?: Array<{ command: string; args: readonly string[] }>,
): ToolchainProbeFn {
  return (command, args) => {
    seen?.push({ command, args });
    const override = overrides[command];
    if (override !== undefined) return override;
    if (command === "python3") {
      return { available: false, version: null, detail: "ENOENT", failure: "not-found" };
    }
    const output = HEALTHY_OUTPUT[command];
    if (output === undefined) throw new Error(`unexpected probe command ${command}`);
    return ok(output);
  };
}

interface ConfiguredSandbox {
  readonly sandbox: string;
  readonly home: string;
  readonly codexHome: string;
  readonly pkgRoot: string;
}

async function createConfiguredSandbox(prefix: string): Promise<ConfiguredSandbox> {
  const sandbox = createTempDir(prefix);
  const home = path.join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  const codexHome = path.join(home, ".codex");
  const pkgRoot = createFakePkg(sandbox);
  await runSetup({
    homeDir: home,
    codexHomeDir: codexHome,
    packageRoot: pkgRoot,
    ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
    clients: ["claude-code"],
    yes: true,
  });
  return { sandbox, home, codexHome, pkgRoot };
}

function doctorIn(sb: ConfiguredSandbox, probe: ToolchainProbeFn) {
  return runDoctor({
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot: sb.pkgRoot,
    nodeVersion: "24.19.2",
    probeToolchain: probe,
  });
}

describe("doctor: sidecar toolchain health feeds the overall status", { timeout: 30_000 }, () => {
  it("reports HEALTHY with every supported toolchain at or above its floor, probing `dotnet --list-runtimes`", async () => {
    const sb = await createConfiguredSandbox("healthy");
    const seen: Array<{ command: string; args: readonly string[] }> = [];
    const report = doctorIn(sb, makeProbe({}, seen));

    expect(report.overallStatus).toBe("HEALTHY");
    expect(report.healthy).toBe(true);
    expect(seen.find((p) => p.command === "dotnet")?.args).toEqual(["--list-runtimes"]);
    for (const id of SIDECAR_TOOLCHAIN_IDS) {
      expect(report.toolchains[id].status, id).toBe("ok");
      expect(report.toolchains[id].mode, id).toBe("sidecar-ready");
    }
    expect(report.toolchains.python.minimumVersion).toBe("3.10");
    expect(report.toolchains.go.minimumVersion).toBe("1.26");
    // The doctor floor is the Go line native/go-worker/go.mod declares.
    expect(report.toolchains.go.minimumVersion).toBe(
      /^go (\d+\.\d+)/m.exec(readFileSync(new URL("../native/go-worker/go.mod", import.meta.url), "utf8"))?.[1],
    );
    expect(report.toolchains.dotnet.minimumVersion).toBe("10.0");
    expect(report.toolchains.cargo.minimumVersion).toBeNull();
    expect(report.toolchains.python.version).toBe("3.12.4");
    expect(report.toolchains.go.version).toBe("1.26.11");
    expect(report.toolchains.dotnet.version).toBe("10.0.11");
    expect(report.toolchains.cargo.version).toBe("1.100.0");

    // Boundary versions are accepted.
    const boundary = doctorIn(
      sb,
      makeProbe({
        python: ok("Python 3.10.0"),
        go: ok("go version go1.26 darwin/arm64"),
        dotnet: ok("Microsoft.NETCore.App 10.0.0 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]"),
      }),
    );
    expect(boundary.overallStatus).toBe("HEALTHY");
  });

  it.each([
    ["python", ok("Python 3.9.18"), /Python 3\.9\.18 is below the supported minimum 3\.10/],
    ["python", ok("Python 2.7.18"), /below the supported minimum 3\.10/],
    ["go", ok("go version go1.25.9 linux/amd64"), /Go 1\.25\.9 is below the supported minimum 1\.26/],
    [
      "dotnet",
      ok(
        "Microsoft.AspNetCore.App 10.0.1 [/x]\nMicrosoft.NETCore.App 8.0.1 [/x]\nMicrosoft.NETCore.App 9.0.19 [/x]",
      ),
      /No \.NET 10 runtime \(Microsoft\.NETCore\.App 10\.x\).*8\.0\.1, 9\.0\.19/,
    ],
    ["dotnet", ok("Microsoft.NETCore.App 11.0.0 [/x]"), /No \.NET 10 runtime.*11\.0\.0.*roll/i],
    ["dotnet", ok("Microsoft.AspNetCore.App 10.0.1 [/x]"), /No \.NET 10 runtime.*none/i],
    ["python", ok("pyenv: python: command not found shim"), /could not read a version/i],
    [
      "go",
      { available: false, version: null, detail: "ETIMEDOUT", failure: "error" } as ToolchainProbeOutcome,
      /probe failed \(ETIMEDOUT\)/,
    ],
    [
      "cargo",
      { available: false, version: null, detail: "EACCES", failure: "error" } as ToolchainProbeOutcome,
      /`cargo --version` probe failed \(EACCES\)/,
    ],
  ])("an installed but unusable %s toolchain is a warning that makes the report DEGRADED (%#)", async (id, outcome, detailPattern) => {
    const sb = await createConfiguredSandbox(`warn-${id}`);
    const before = snapshotTree(sb.sandbox);
    const report = doctorIn(sb, makeProbe({ [id]: outcome }));

    expect(snapshotTree(sb.sandbox)).toEqual(before);
    const tc = report.toolchains[id as keyof typeof report.toolchains];
    expect(tc.status).toBe("warn");
    expect(tc.mode).toBe("l0-l1-fallback");
    expect(tc.detail).toMatch(detailPattern);
    expect(tc.detail).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(report.hosts["claude-code"].status).toBe("ok");
    expect(report.overallStatus).toBe("DEGRADED");
    expect(report.healthy).toBe(false);

    const text = formatDoctorReportText(report);
    expect(text).toContain("DEGRADED");
    expect(text).toContain(`  - ${id}: WARN`);
    expect(text).toMatch(/Summary: .*toolchain/i);
  });

  it("treats an absent optional toolchain as informational (stays HEALTHY)", async () => {
    const sb = await createConfiguredSandbox("absent");
    const absent = (detail: string): ToolchainProbeOutcome => ({
      available: false,
      version: null,
      detail,
      failure: "not-found",
    });
    const report = doctorIn(
      sb,
      makeProbe({
        dotnet: absent("ENOENT"),
        go: absent("ENOENT"),
        // Injected probes that predate `failure` default to "not found".
        cargo: { available: false, version: null, detail: "missing" },
      }),
    );
    expect(report.overallStatus).toBe("HEALTHY");
    for (const id of ["dotnet", "go", "cargo"] as const) {
      expect(report.toolchains[id].status, id).toBe("absent");
      expect(report.toolchains[id].mode, id).toBe("l0-l1-fallback");
      expect(report.toolchains[id].detail, id).toMatch(/Not found/);
    }
    expect(report.toolchains.python.status).toBe("ok");
    expect(formatDoctorReportText(report)).toContain("  - go: ABSENT");
  });

  it("treats a shim or proxy that exits without a toolchain (rustup, pyenv) as not installed, not as a warning", async () => {
    const sb = await createConfiguredSandbox("exited");
    const report = doctorIn(
      sb,
      makeProbe({
        cargo: {
          available: false,
          version: null,
          detail: "error: rustup could not choose a version of cargo to run",
          failure: "exited",
        },
        python: {
          available: false,
          version: null,
          detail: "pyenv: python: command not found",
          failure: "exited",
        },
      }),
    );
    expect(report.overallStatus).toBe("HEALTHY");
    expect(report.toolchains.cargo.status).toBe("absent");
    expect(report.toolchains.cargo.detail).toMatch(
      /^Not usable: `cargo --version` exited without a working toolchain \(error: rustup could not choose a version of cargo to run\); treated as not installed/,
    );
    expect(report.toolchains.python.status).toBe("absent");
  });

  it("keeps NOT CONFIGURED / UNHEALTHY precedence over a toolchain warning", async () => {
    const sandbox = createTempDir("precedence");
    const home = path.join(sandbox, "home");
    mkdirSync(home, { recursive: true });
    const pkgRoot = createFakePkg(sandbox);
    const probe = makeProbe({ python: ok("Python 3.8.10") });
    const notConfigured = runDoctor({
      homeDir: home,
      codexHomeDir: path.join(home, ".codex"),
      packageRoot: pkgRoot,
      nodeVersion: "24.19.2",
      probeToolchain: probe,
    });
    expect(notConfigured.toolchains.python.status).toBe("warn");
    expect(notConfigured.overallStatus).toBe("NOT CONFIGURED");

    const oldNode = runDoctor({
      homeDir: home,
      codexHomeDir: path.join(home, ".codex"),
      packageRoot: pkgRoot,
      nodeVersion: "22.11.0",
      probeToolchain: probe,
    });
    expect(oldNode.overallStatus).toBe("UNHEALTHY");
  });

  it("CLI `doctor` exits 1 on a toolchain warning and 0 once it is fixed", async () => {
    const sb = await createConfiguredSandbox("cli");
    const run = async (probe: ToolchainProbeFn) => {
      const out: string[] = [];
      const exitCode = await runCli(["doctor", "--json"], {
        homeDir: sb.home,
        codexHomeDir: sb.codexHome,
        packageRoot: sb.pkgRoot,
        probeToolchain: probe,
        io: { stdout: (t) => out.push(t), stderr: () => undefined },
      });
      return { exitCode, report: JSON.parse(out.join("")) as { overallStatus: string } };
    };
    const degraded = await run(makeProbe({ go: ok("go version go1.20.1 windows/amd64") }));
    expect(degraded.exitCode).toBe(1);
    expect(degraded.report.overallStatus).toBe("DEGRADED");
    const healthy = await run(makeProbe());
    expect(healthy.exitCode).toBe(0);
    expect(healthy.report.overallStatus).toBe("HEALTHY");
  });
});

describe("defaultToolchainProbe classifies failures", { timeout: 30_000 }, () => {
  it("reports a missing command as not-found, a non-zero exit as exited, a timeout as an error, and keeps the full output", () => {
    const missing = defaultToolchainProbe("causoryn-no-such-toolchain-7f3a", ["--version"], 5_000);
    expect(missing.available).toBe(false);
    expect(missing.failure).toBe("not-found");

    const failing = defaultToolchainProbe(
      process.execPath,
      ["-e", "process.stderr.write('boom\\n'); process.exit(3)"],
      5_000,
    );
    expect(failing.available).toBe(false);
    expect(failing.failure).toBe("exited");
    expect(failing.detail).toBe("boom");

    const hanging = defaultToolchainProbe(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 300);
    expect(hanging.available).toBe(false);
    expect(hanging.failure).toBe("error");
    expect(hanging.detail).toBe("ETIMEDOUT");

    const multiLine = defaultToolchainProbe(
      process.execPath,
      ["-e", "console.log('line one'); console.log('line two')"],
      5_000,
    );
    expect(multiLine.available).toBe(true);
    expect(multiLine.version).toBe("line one");
    expect(multiLine.output).toContain("line two");
  });
});
