import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_SKILL_NAMES,
  formatDoctorReportText,
  runDoctor,
  runSetup,
  type ToolchainProbeFn,
} from "../packages/causoryn/src/index.js";
import { defaultToolchainProbe } from "../packages/causoryn/src/doctor.js";

/**
 * Probe that answers like supported sidecar toolchains. Doctor checks the
 * version floors (Python >= 3.10, Go >= 1.22, .NET 10 runtime), so the output
 * must look like the real `--version` / `--list-runtimes` output.
 */
const SUPPORTED_TOOLCHAIN_OUTPUT: Readonly<Record<string, string>> = {
  dotnet: "Microsoft.NETCore.App 10.0.11 [/usr/share/dotnet/shared/Microsoft.NETCore.App]",
  python: "Python 3.12.4",
  go: "go version go1.22.5 linux/amd64",
  cargo: "cargo 1.100.0 (3acc79c0c 2026-11-05)",
};

const supportedToolchainProbe: ToolchainProbeFn = (command) => {
  const output = SUPPORTED_TOOLCHAIN_OUTPUT[command];
  if (output === undefined) throw new Error(`unexpected toolchain probe: ${command}`);
  return { available: true, version: output, detail: "ok", output };
};

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-t18-doctor-${prefix}-`));
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
  mkdirSync(path.join(pkgRoot, "scripts"), { recursive: true });
  mkdirSync(
    path.join(pkgRoot, "dist", "node_modules", "better-sqlite3", "prebuilds"),
    { recursive: true },
  );
  mkdirSync(path.join(pkgRoot, "dist", "typescript-lib"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "native", "python-worker"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "native", "go-worker", "cmd", "worker"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "native", "rust-worker"), { recursive: true });
  mkdirSync(path.join(pkgRoot, "native", "roslyn-worker"), { recursive: true });

  writeFileSync(path.join(pkgRoot, "package.json"), '{"name":"causoryn","version":"0.2.5"}', "utf8");
  writeFileSync(path.join(pkgRoot, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(path.join(pkgRoot, "dist", "mcp-server.mjs"), "// bundle\n", "utf8");
  writeFileSync(
    path.join(
      pkgRoot,
      "dist",
      "node_modules",
      "better-sqlite3",
      "prebuilds",
      `${process.platform}-${process.arch}.node`,
    ),
    "bin",
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "dist", "typescript-lib", "lib.es2022.full.d.ts"),
    "interface Array<T> {}\n",
    "utf8",
  );
  writeFileSync(path.join(pkgRoot, "native", "python-worker", "worker.py"), "# py\n", "utf8");
  writeFileSync(
    path.join(pkgRoot, "native", "go-worker", "cmd", "worker", "main.go"),
    "package main\n",
    "utf8",
  );
  writeFileSync(path.join(pkgRoot, "native", "rust-worker", "Cargo.toml"), "[package]\n", "utf8");
  writeFileSync(
    path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.csproj"),
    "<Project />\n",
    "utf8",
  );
  writeFileSync(
    path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
    "dll",
    "utf8",
  );

  for (const skillName of CANONICAL_SKILL_NAMES) {
    const dir = path.join(pkgRoot, "skills", skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf8");
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

describe("doctor: legacy per-host index files (graph-<client>.sqlite)", { timeout: 30_000 }, () => {
  it("warns (read-only) about legacy graph-*.sqlite files and says they can be deleted once graph.sqlite exists", async () => {
    const sandbox = createTempDir("legacy-index");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);
    const workspaces = path.join(fakeHome, ".causoryn", "workspaces");

    // Migrated workspace: shared graph.sqlite next to two legacy files (+ a WAL sidecar).
    const migrated = path.join(workspaces, "orders-0123456789ab");
    mkdirSync(path.join(migrated, "exports"), { recursive: true });
    writeFileSync(path.join(migrated, "graph.sqlite"), "shared", "utf8");
    writeFileSync(path.join(migrated, "graph-claude-code.sqlite"), "legacy", "utf8");
    writeFileSync(path.join(migrated, "graph-claude-code.sqlite-wal"), "wal", "utf8");
    writeFileSync(path.join(migrated, "graph-codex.sqlite"), "legacy", "utf8");
    // Not yet migrated: only a legacy file, no graph.sqlite.
    const pending = path.join(workspaces, "billing-ba9876543210");
    mkdirSync(pending, { recursive: true });
    writeFileSync(path.join(pending, "graph-zcode.sqlite"), "legacy", "utf8");
    // Unrelated files are ignored.
    writeFileSync(path.join(migrated, "graph.sqlite-wal"), "wal", "utf8");
    writeFileSync(path.join(migrated, "notes-graph-x.sqlite.txt"), "x", "utf8");

    const before = snapshotTree(fakeHome);
    const report = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    // Strictly read-only: nothing created, changed, or deleted.
    expect(snapshotTree(fakeHome)).toEqual(before);

    const legacy = report.legacyIndexFiles;
    expect(legacy.status).toBe("warn");
    expect(legacy.files.map((f) => path.relative(workspaces, f.path).replace(/\\/g, "/"))).toEqual([
      "billing-ba9876543210/graph-zcode.sqlite",
      "orders-0123456789ab/graph-claude-code.sqlite",
      "orders-0123456789ab/graph-codex.sqlite",
    ]);
    const byName = new Map(legacy.files.map((f) => [path.basename(f.path), f]));
    expect(byName.get("graph-claude-code.sqlite")?.sharedIndexPresent).toBe(true);
    expect(byName.get("graph-claude-code.sqlite")?.sidecars.map((s) => path.basename(s))).toEqual([
      "graph-claude-code.sqlite-wal",
    ]);
    expect(byName.get("graph-zcode.sqlite")?.sharedIndexPresent).toBe(false);
    expect(legacy.detail).toContain("can be deleted");
    expect(legacy.detail).toContain("graph.sqlite");

    const text = formatDoctorReportText(report);
    expect(text).toContain("[Legacy Index Files] WARN");
    expect(text).toContain(path.join(migrated, "graph-codex.sqlite"));
    expect(text).toMatch(/graph-codex\.sqlite[^\n]*safe to delete/);
    expect(text).toMatch(/graph-zcode\.sqlite[^\n]*graph\.sqlite missing/);
    expect(text).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);

    // The warning is advisory housekeeping: a fully aligned host stays HEALTHY (exit code 0).
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      yes: true,
    });
    const healthy = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      clients: ["claude-code"],
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(healthy.overallStatus).toBe("HEALTHY");
    expect(healthy.legacyIndexFiles.status).toBe("warn");
    const healthyText = formatDoctorReportText(healthy, ["claude-code"]);
    expect(healthyText).toContain("— HEALTHY");
    expect(healthyText).toContain("[Legacy Index Files] WARN");
  });

  it("reports OK when no legacy index files exist (and when the data root is absent)", () => {
    const sandbox = createTempDir("legacy-none");
    const fakeHome = path.join(sandbox, "home");
    const pkgRoot = createFakePkg(sandbox);
    mkdirSync(fakeHome, { recursive: true });

    const absent = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: path.join(fakeHome, ".codex"),
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(absent.legacyIndexFiles.status).toBe("ok");
    expect(absent.legacyIndexFiles.files).toEqual([]);
    expect(readdirSync(fakeHome)).toEqual([]);

    const ws = path.join(fakeHome, ".causoryn", "workspaces", "app-aaaaaaaaaaaa");
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "graph.sqlite"), "shared", "utf8");
    const clean = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: path.join(fakeHome, ".codex"),
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(clean.legacyIndexFiles.status).toBe("ok");
    expect(formatDoctorReportText(clean)).toContain("[Legacy Index Files] OK");
  });
});

describe("Task 1.1 & 1.8b — doctor.ts probe cwd isolation, absolute node path check, honest status", () => {
  it("defaultToolchainProbe runs with cwd: os.tmpdir() instead of untrusted process.cwd()", () => {
    const untrustedDir = createTempDir("untrusted-cwd");
    mkdirSync(path.join(untrustedDir, ".cargo"), { recursive: true });
    writeFileSync(
      path.join(untrustedDir, ".cargo", "config.toml"),
      '[build]\nrustc-wrapper = "should-never-run"\n',
      "utf8",
    );
    writeFileSync(
      path.join(untrustedDir, "global.json"),
      '{"sdk":{"version":"99.99.99-malicious","rollForward":"disable"}}\n',
      "utf8",
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(untrustedDir);
      const outcome = defaultToolchainProbe(
        process.execPath,
        ["-e", "console.log(process.cwd())"],
        5_000,
      );
      expect(outcome.available).toBe(true);
      expect(outcome.version).not.toBeNull();
      const probedCwd = realpathSync(outcome.version!);
      const expectedTmp = realpathSync(os.tmpdir());
      expect(probedCwd.toLowerCase()).toBe(expectedTmp.toLowerCase());
      expect(probedCwd.toLowerCase()).not.toBe(realpathSync(untrustedDir).toLowerCase());
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("checkEntrypointExists accepts absolute node paths (process.execPath, POSIX /usr/local/bin/node, Windows node.exe) as well as bare 'node'", () => {
    const sandbox = createTempDir("abs-node-entrypoint");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);
    const existingScript = path.join(pkgRoot, "scripts", "causoryn.mjs");
    const missingScript = path.join(sandbox, "missing-script.mjs");
    mkdirSync(fakeHome, { recursive: true });

    for (const nodeCmd of [
      "node",
      process.execPath,
      "/usr/local/bin/node",
      "C:\\Program Files\\nodejs\\node.exe",
    ]) {
      // Valid script path -> entrypointExists: true
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ mcpServers: { causoryn: { command: nodeCmd, args: [existingScript, "mcp"] } } }),
        "utf8",
      );
      const okReport = runDoctor({
        homeDir: fakeHome,
        codexHomeDir: fakeCodex,
        packageRoot: pkgRoot,
        clients: ["claude-code"],
        nodeVersion: "24.10.0",
        probeToolchain: supportedToolchainProbe,
      });
      expect(okReport.hosts["claude-code"].entrypointExists, `valid script with ${nodeCmd}`).toBe(true);

      // Missing script path -> entrypointExists: false -> error
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ mcpServers: { causoryn: { command: nodeCmd, args: [missingScript, "mcp"] } } }),
        "utf8",
      );
      const brokenReport = runDoctor({
        homeDir: fakeHome,
        codexHomeDir: fakeCodex,
        packageRoot: pkgRoot,
        clients: ["claude-code"],
        nodeVersion: "24.10.0",
        probeToolchain: supportedToolchainProbe,
      });
      expect(brokenReport.hosts["claude-code"].entrypointExists, `missing script with ${nodeCmd}`).toBe(false);
      expect(brokenReport.hosts["claude-code"].status).toBe("error");
      expect(brokenReport.healthy).toBe(false);
    }
  });

  it("NEVER reports HEALTHY when configuredCount === 0 (reports NOT CONFIGURED) or when any configured host is warn (reports DEGRADED)", async () => {
    const sandbox = createTempDir("honest-status");
    const fakeHome = path.join(sandbox, "home");
    const fakeCodex = path.join(fakeHome, ".codex");
    const pkgRoot = createFakePkg(sandbox);
    mkdirSync(fakeHome, { recursive: true });

    // 1) 0 hosts configured -> NOT CONFIGURED (healthy: false)
    const emptyReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(emptyReport.healthy).toBe(false);
    expect(emptyReport.overallStatus).toBe("NOT CONFIGURED");
    const emptyText = formatDoctorReportText(emptyReport);
    expect(emptyText).toContain("NOT CONFIGURED");
    expect(emptyText).not.toContain("— HEALTHY");

    // 2) Host configured WITHOUT skills (status: "warn") -> DEGRADED (healthy: false)
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: false,
      yes: true,
    });
    const warnReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      clients: ["claude-code"],
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(warnReport.hosts["claude-code"].status).toBe("warn");
    expect(warnReport.healthy).toBe(false);
    expect(warnReport.overallStatus).toBe("DEGRADED");
    const warnText = formatDoctorReportText(warnReport, ["claude-code"]);
    expect(warnText).toContain("DEGRADED");
    expect(warnText).not.toContain("— HEALTHY");

    // 3) Host fully configured WITH skills (status: "ok") -> HEALTHY (healthy: true)
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["claude-code"],
      installSkills: true,
      yes: true,
    });
    const healthyReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      clients: ["claude-code"],
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(healthyReport.hosts["claude-code"].status).toBe("ok");
    expect(healthyReport.healthy).toBe(true);
    expect(healthyReport.overallStatus).toBe("HEALTHY");
    const healthyText = formatDoctorReportText(healthyReport, ["claude-code"]);
    expect(healthyText).toContain("— HEALTHY");

    // 4) Single configured & aligned host among all 4 hosts -> still HEALTHY (other 3 are not-configured)
    const allHostsSingleOk = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(allHostsSingleOk.configuredCount).toBe(1);
    expect(allHostsSingleOk.overallStatus).toBe("HEALTHY");
    expect(allHostsSingleOk.healthy).toBe(true);

    // 5) Mix of 1 ok host + 1 warn host (codex without skills) -> DEGRADED across all hosts
    await runSetup({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
      clients: ["codex"],
      installSkills: false,
      yes: true,
    });
    const mixedReport = runDoctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodex,
      packageRoot: pkgRoot,
      nodeVersion: "24.10.0",
      probeToolchain: supportedToolchainProbe,
    });
    expect(mixedReport.configuredCount).toBe(2);
    expect(mixedReport.hosts["claude-code"].status).toBe("ok");
    expect(mixedReport.hosts["codex"].status).toBe("warn");
    expect(mixedReport.overallStatus).toBe("DEGRADED");
    expect(mixedReport.healthy).toBe(false);
  });
});
