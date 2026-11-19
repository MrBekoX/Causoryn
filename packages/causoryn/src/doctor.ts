import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getPersistentRuntimeDir } from "./runtime-stage.js";
import {
  detectInstalledClients,
  getHostSkillsDir,
  resolveDefaultPackageRoot,
  resolveEffectiveCodexHomeDir,
  resolveEffectiveHomeDir,
} from "./setup.js";
import { readCodexMcpServer, validateTomlStructure } from "./toml-patch.js";
import {
  CANONICAL_SKILL_NAMES,
  CAUSORYN_PACKAGE_VERSION,
  HOST_CLIENT_IDS,
  SIDECAR_TOOLCHAIN_IDS,
  type CanonicalSkillName,
  type DoctorHostStatus,
  type DoctorNodeCheck,
  type DoctorOptions,
  type DoctorReport,
  type DoctorRuntimeCheck,
  type DoctorToolchainStatus,
  type HostClientId,
  type SidecarToolchainId,
  type ToolchainProbeFn,
  type ToolchainProbeOutcome,
} from "./types.js";

/**
 * Salt-okunur sağlık ve hizalama denetçisi (`causoryn doctor`, K-021).
 *
 * Kırmızı çizgi: Bu modül HİÇBİR dosya veya dizin oluşturmaz, değiştirmez
 * veya silmez; tüm kontroller salt okunurdur.
 */

const SIDECAR_PROBE_TIMEOUT_MS = 5_000;
const REQUIRED_NODE_MAJOR = 24;

export const DOCTOR_PROBE_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "DOTNET_ROOT",
  "DOTNET_CLI_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "GOENV",
  "CARGO_HOME",
  "RUSTUP_HOME",
] as const;

export function buildDoctorProbeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DOCTOR_PROBE_ENV_ALLOWLIST) {
    const val = sourceEnv[key];
    if (val !== undefined && val.length > 0) {
      env[key] = val;
    }
  }
  env["PYTHONIOENCODING"] = "utf-8";
  return env;
}

function defaultToolchainProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): ToolchainProbeOutcome {
  const probeEnv = buildDoctorProbeEnv();
  const runOnce = (cmd: string): ToolchainProbeOutcome => {
    const res = spawnSync(cmd, [...args], {
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      env: probeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.error !== undefined) {
      const code = (res.error as NodeJS.ErrnoException).code ?? res.error.message;
      return {
        available: false,
        version: null,
        detail: String(code),
      };
    }
    if (res.status !== 0) {
      const stderrLine = (res.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
      return {
        available: false,
        version: null,
        detail: stderrLine.length > 0 ? stderrLine : `exit ${String(res.status)}`,
      };
    }
    const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      available: true,
      version: combined ?? cmd,
      detail: "ok",
    };
  };

  const primary = runOnce(command);
  if (!primary.available && command === "python" && process.platform !== "win32") {
    const py3 = runOnce("python3");
    if (py3.available) return py3;
  }
  return primary;
}

function checkNodeVersion(rawNodeVersion: string): DoctorNodeCheck {
  const cleaned = rawNodeVersion.trim().replace(/^v/i, "");
  const majorStr = cleaned.split(".")[0] ?? "0";
  const major = Number.parseInt(majorStr, 10);
  const ok = Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR;
  return {
    ok,
    version: cleaned,
    requiredMajor: REQUIRED_NODE_MAJOR,
    detail: ok
      ? `Node.js ${cleaned} (>= ${String(REQUIRED_NODE_MAJOR)})`
      : `Node.js ${cleaned} desteklenmiyor; Node.js >= ${String(REQUIRED_NODE_MAJOR)} gerekli`,
  };
}

function inspectRuntimeRoot(
  pkgRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): {
  readonly bundlePresent: boolean;
  readonly sqlitePrebuildPresent: boolean;
  readonly typescriptLibPresent: boolean;
  readonly nativeWorkersPresent: boolean;
  readonly missingPaths: readonly string[];
} {
  const missing: string[] = [];
  const bundlePath = path.join(pkgRoot, "dist", "mcp-server.mjs");
  const bundlePresent = existsSync(bundlePath);
  if (!bundlePresent) missing.push(bundlePath);

  const prebuildPath = path.join(
    pkgRoot,
    "dist",
    "node_modules",
    "better-sqlite3",
    "prebuilds",
    `${platform}-${arch}.node`,
  );
  const sqlitePrebuildPresent = existsSync(prebuildPath);
  if (!sqlitePrebuildPresent) missing.push(prebuildPath);

  const tsLibPath = path.join(
    pkgRoot,
    "dist",
    "typescript-lib",
    "lib.es2022.full.d.ts",
  );
  const typescriptLibPresent = existsSync(tsLibPath);
  if (!typescriptLibPresent) missing.push(tsLibPath);

  const requiredNativeFiles = [
    path.join(pkgRoot, "native", "python-worker", "worker.py"),
    path.join(pkgRoot, "native", "go-worker", "cmd", "worker", "main.go"),
    path.join(pkgRoot, "native", "rust-worker", "Cargo.toml"),
    path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.csproj"),
  ];
  let nativeWorkersPresent = true;
  for (const nativeFile of requiredNativeFiles) {
    if (!existsSync(nativeFile)) {
      nativeWorkersPresent = false;
      missing.push(nativeFile);
    }
  }

  return {
    bundlePresent,
    sqlitePrebuildPresent,
    typescriptLibPresent,
    nativeWorkersPresent,
    missingPaths: missing,
  };
}

function checkRuntime(
  packageRoot: string,
  homeDir: string,
  platform: NodeJS.Platform,
  arch: string,
): DoctorRuntimeCheck {
  const primary = inspectRuntimeRoot(packageRoot, platform, arch);
  const candidateStaged = getPersistentRuntimeDir(homeDir);
  const hasStaged = existsSync(candidateStaged);
  let stagedRuntimeOk: boolean | null = null;
  const allMissing = [...primary.missingPaths];

  if (hasStaged) {
    const stagedCheck = inspectRuntimeRoot(candidateStaged, platform, arch);
    stagedRuntimeOk =
      stagedCheck.bundlePresent &&
      stagedCheck.sqlitePrebuildPresent &&
      stagedCheck.typescriptLibPresent &&
      stagedCheck.nativeWorkersPresent;
    if (!stagedRuntimeOk) {
      for (const m of stagedCheck.missingPaths) {
        allMissing.push(m);
      }
    }
  }

  const ok =
    primary.bundlePresent &&
    primary.sqlitePrebuildPresent &&
    primary.typescriptLibPresent &&
    primary.nativeWorkersPresent &&
    (stagedRuntimeOk === null || stagedRuntimeOk);

  return {
    ok,
    packageRoot,
    bundlePresent: primary.bundlePresent,
    sqlitePrebuildPresent: primary.sqlitePrebuildPresent,
    typescriptLibPresent: primary.typescriptLibPresent,
    nativeWorkersPresent: primary.nativeWorkersPresent,
    stagedRuntimeDir: hasStaged ? candidateStaged : null,
    stagedRuntimeOk,
    missingPaths: allMissing,
  };
}

function probeSidecarToolchains(
  probe: ToolchainProbeFn,
): Record<SidecarToolchainId, DoctorToolchainStatus> {
  const specs: ReadonlyArray<{ id: SidecarToolchainId; cmd: string; args: readonly string[] }> = [
    { id: "dotnet", cmd: "dotnet", args: ["--version"] },
    { id: "python", cmd: "python", args: ["--version"] },
    { id: "go", cmd: "go", args: ["version"] },
    { id: "cargo", cmd: "cargo", args: ["--version"] },
  ];

  const out = {} as Record<SidecarToolchainId, DoctorToolchainStatus>;
  for (const spec of specs) {
    const res = probe(spec.cmd, spec.args, SIDECAR_PROBE_TIMEOUT_MS);
    out[spec.id] = {
      id: spec.id,
      available: res.available,
      version: res.version,
      mode: res.available ? "sidecar-ready" : "l0-l1-fallback",
      detail: res.available
        ? `${res.version ?? spec.cmd} (sidecar hazır)`
        : `Bulunamadı (${res.detail}) — bu dil L0/L1 dosya düzeyine zarifçe düşer`,
    };
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkEntrypointExists(command: unknown, args: unknown): boolean | null {
  if (command !== "node" || !Array.isArray(args) || typeof args[0] !== "string") {
    return null;
  }
  const scriptArg = args[0];
  if (scriptArg.includes("$")) {
    return null;
  }
  return existsSync(scriptArg);
}

function inspectSkills(skillsDir: string): {
  readonly installed: CanonicalSkillName[];
  readonly missing: CanonicalSkillName[];
} {
  const installed: CanonicalSkillName[] = [];
  const missing: CanonicalSkillName[] = [];
  for (const skillName of CANONICAL_SKILL_NAMES) {
    const file = path.join(skillsDir, skillName, "SKILL.md");
    if (existsSync(file) && statSync(file).isFile()) {
      installed.push(skillName);
    } else {
      missing.push(skillName);
    }
  }
  return { installed, missing };
}

function inspectSingleHost(
  client: HostClientId,
  homeDir: string,
  codexHomeDir: string,
  detectedSet: ReadonlySet<HostClientId>,
): DoctorHostStatus {
  const detected = detectedSet.has(client);
  const skillsDir = getHostSkillsDir(homeDir, client);
  const skills = inspectSkills(skillsDir);

  let configPath: string;
  switch (client) {
    case "antigravity":
      configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
      break;
    case "claude-code":
      configPath = path.join(homeDir, ".claude.json");
      break;
    case "codex":
      configPath = path.join(codexHomeDir, "config.toml");
      break;
    case "zcode":
      configPath = path.join(homeDir, ".zcode", "cli", "config.json");
      break;
  }

  let configValid = true;
  let mcpConfigured = false;
  let entrypointExists: boolean | null = null;
  let parseDetail = "";

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    if (client === "codex") {
      try {
        validateTomlStructure(raw);
        const parsed = readCodexMcpServer(raw);
        if (parsed !== null) {
          mcpConfigured = true;
          entrypointExists = checkEntrypointExists(parsed.command, parsed.args);
        }
      } catch (error) {
        configValid = false;
        parseDetail = error instanceof Error ? error.message : String(error);
      }
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
          configValid = false;
          parseDetail = "JSON kök değeri nesne değil";
        } else if (client === "zcode") {
          const mcp = parsed["mcp"];
          const servers = isPlainObject(mcp) ? mcp["servers"] : undefined;
          if (mcp !== undefined && !isPlainObject(mcp)) {
            configValid = false;
            parseDetail = "mcp alanı nesne değil";
          } else if (servers !== undefined && !isPlainObject(servers)) {
            configValid = false;
            parseDetail = "mcp.servers alanı nesne değil";
          } else if (isPlainObject(servers) && "causoryn" in servers) {
            const entry = servers["causoryn"];
            if (!isPlainObject(entry)) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcp.servers.causoryn alanı nesne değil";
            } else if (
              typeof entry["command"] !== "string" ||
              entry["command"].trim().length === 0
            ) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcp.servers.causoryn.command boş olmayan bir dizge olmalı";
            } else {
              mcpConfigured = true;
              entrypointExists = checkEntrypointExists(entry["command"], entry["args"]);
            }
          }
        } else {
          const servers = parsed["mcpServers"];
          if (servers !== undefined && !isPlainObject(servers)) {
            configValid = false;
            parseDetail = "mcpServers alanı nesne değil";
          } else if (isPlainObject(servers) && "causoryn" in servers) {
            const entry = servers["causoryn"];
            if (!isPlainObject(entry)) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcpServers.causoryn alanı nesne değil";
            } else if (
              typeof entry["command"] !== "string" ||
              entry["command"].trim().length === 0
            ) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcpServers.causoryn.command boş olmayan bir dizge olmalı";
            } else {
              mcpConfigured = true;
              entrypointExists = checkEntrypointExists(entry["command"], entry["args"]);
            }
          }
        }
      } catch (error) {
        configValid = false;
        parseDetail = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // Antigravity ikincil mcp_config.json dosyası varsa onun da bozuk olmadığını denetle
  if (client === "antigravity" && configValid) {
    const secondary = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    if (existsSync(secondary)) {
      try {
        const secParsed: unknown = JSON.parse(readFileSync(secondary, "utf8"));
        if (!isPlainObject(secParsed)) {
          configValid = false;
          parseDetail = `İkincil Antigravity JSON kök değeri nesne değil (${secondary})`;
        } else if (
          secParsed["mcpServers"] !== undefined &&
          !isPlainObject(secParsed["mcpServers"])
        ) {
          configValid = false;
          parseDetail = `İkincil Antigravity mcpServers alanı nesne değil (${secondary})`;
        } else if (
          isPlainObject(secParsed["mcpServers"]) &&
          "causoryn" in secParsed["mcpServers"]
        ) {
          const secEntry = secParsed["mcpServers"]["causoryn"];
          if (
            !isPlainObject(secEntry) ||
            typeof secEntry["command"] !== "string" ||
            secEntry["command"].trim().length === 0
          ) {
            configValid = false;
            parseDetail = `İkincil Antigravity mcpServers.causoryn.command boş olmayan bir dizge olmalı (${secondary})`;
          }
        }
      } catch (error) {
        configValid = false;
        parseDetail = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const brokenEntrypoint = entrypointExists === false;
  const aligned =
    configValid &&
    mcpConfigured &&
    !brokenEntrypoint &&
    skills.missing.length === 0;

  let status: DoctorHostStatus["status"];
  let detail: string;
  if (!configValid) {
    status = "error";
    detail = `Bozuk konfigürasyon: ${parseDetail}`;
  } else if (brokenEntrypoint) {
    status = "error";
    detail = "MCP sunucu giriş betiği diskte bulunamadı (`npx causoryn setup --yes` ile yenileyin)";
  } else if (aligned) {
    status = "ok";
    detail = "MCP sunucusu ve 4 yönlendirme skill dosyası tam hizalı";
  } else if (!mcpConfigured && skills.installed.length === 0) {
    status = "not-configured";
    detail = detected
      ? "Host algılandı ancak Causoryn henüz kurulmamış"
      : "Host algılanmadı";
  } else {
    status = "warn";
    detail = mcpConfigured
      ? `MCP kurulu ancak eksik skill'ler var: ${skills.missing.join(", ")}`
      : "Skill dosyaları mevcut ancak MCP sunucu kaydı yok";
  }

  return {
    client,
    detected,
    configPath,
    configValid,
    mcpConfigured,
    entrypointExists,
    skillsDir,
    skillsInstalled: skills.installed,
    missingSkills: skills.missing,
    aligned,
    status,
    detail,
  };
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const explicitHomeProvided = options.homeDir !== undefined;
  const homeDir = resolveEffectiveHomeDir(options.homeDir);
  const codexHomeDir = resolveEffectiveCodexHomeDir(
    homeDir,
    options.codexHomeDir,
    explicitHomeProvided,
  );
  const packageRoot = path.resolve(options.packageRoot ?? resolveDefaultPackageRoot());
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const probe = options.probeToolchain ?? defaultToolchainProbe;

  const nodeCheck = checkNodeVersion(nodeVersion);
  const runtimeCheck = checkRuntime(packageRoot, homeDir, platform, arch);
  const toolchains = probeSidecarToolchains(probe);

  const detectedSet = new Set<HostClientId>(detectInstalledClients(homeDir, codexHomeDir));
  const targetClients: readonly HostClientId[] =
    options.clients !== undefined && options.clients.length > 0
      ? [...new Set(options.clients)]
      : HOST_CLIENT_IDS;

  const hosts = {} as Record<HostClientId, DoctorHostStatus>;
  for (const client of HOST_CLIENT_IDS) {
    hosts[client] = inspectSingleHost(client, homeDir, codexHomeDir, detectedSet);
  }

  const hostErrors = targetClients.some((c) => hosts[c].status === "error");
  const healthy = nodeCheck.ok && runtimeCheck.ok && !hostErrors;

  return {
    healthy,
    version: CAUSORYN_PACKAGE_VERSION,
    node: nodeCheck,
    runtime: runtimeCheck,
    toolchains,
    hosts,
  };
}

export function formatDoctorReportText(
  report: DoctorReport,
  selectedClients?: readonly HostClientId[],
): string {
  const lines: string[] = [];
  lines.push(`Causoryn Doctor v${report.version} — ${report.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  lines.push("");
  lines.push(`[Node.js] ${report.node.ok ? "OK" : "ERROR"} — ${report.node.detail}`);
  lines.push(
    `[Runtime] ${report.runtime.ok ? "OK" : "ERROR"} — root=${report.runtime.packageRoot}`,
  );
  if (report.runtime.missingPaths.length > 0) {
    for (const missing of report.runtime.missingPaths) {
      lines.push(`  missing: ${missing}`);
    }
  }
  lines.push("");
  lines.push("[Sidecar Toolchains]");
  for (const tcId of SIDECAR_TOOLCHAIN_IDS) {
    const tc = report.toolchains[tcId];
    lines.push(`  - ${tc.id}: ${tc.mode} (${tc.detail})`);
  }
  lines.push("");
  lines.push("[Hosts]");
  const clientsToShow =
    selectedClients !== undefined && selectedClients.length > 0
      ? selectedClients
      : HOST_CLIENT_IDS;
  for (const client of clientsToShow) {
    const h = report.hosts[client];
    lines.push(`  - ${h.client}: ${h.status.toUpperCase()} — ${h.detail}`);
  }
  return `${lines.join("\n")}\n`;
}
