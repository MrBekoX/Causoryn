import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
} from "../packages/causoryn/src/index.js";
import { defaultToolchainProbe } from "../packages/causoryn/src/doctor.js";

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
        probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
        probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
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
      probeToolchain: () => ({ available: true, version: "1.0", detail: "ok" }),
    });
    expect(mixedReport.configuredCount).toBe(2);
    expect(mixedReport.hosts["claude-code"].status).toBe("ok");
    expect(mixedReport.hosts["codex"].status).toBe("warn");
    expect(mixedReport.overallStatus).toBe("DEGRADED");
    expect(mixedReport.healthy).toBe(false);
  });
});
