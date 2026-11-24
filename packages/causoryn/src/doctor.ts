import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getPersistentRuntimeDir } from "./runtime-stage.js";
import {
  detectInstalledClients,
  getClaudeConfigFilePath,
  getHostSkillsDir,
  resolveDefaultPackageRoot,
  resolveEffectiveClaudeConfigDir,
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
  type DoctorLegacyIndexCheck,
  type DoctorLegacyIndexFile,
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

export function defaultToolchainProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): ToolchainProbeOutcome {
  const probeEnv = buildDoctorProbeEnv();
  const runOnce = (cmd: string): ToolchainProbeOutcome => {
    const res = spawnSync(cmd, [...args], {
      cwd: os.tmpdir(),
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
      : `Node.js ${cleaned} is not supported; Node.js >= ${String(REQUIRED_NODE_MAJOR)} is required`,
  };
}

export function isLinuxMusl(
  platform: NodeJS.Platform = process.platform,
  getReport: () => unknown = () => process.report?.getReport?.(),
): boolean {
  if (platform !== "linux") {
    return false;
  }
  try {
    const report = getReport();
    if (isPlainObject(report) && isPlainObject(report["header"])) {
      const glibc = report["header"]["glibcVersionRuntime"];
      return typeof glibc !== "string" || glibc.trim().length === 0;
    }
    return false;
  } catch {
    return false;
  }
}

function resolveCompiledRoslynDllExists(pkgRoot: string): boolean {
  const candidates = [
    path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"),
    path.join(
      pkgRoot,
      "native",
      "roslyn-worker",
      "bin",
      "Release",
      "net10.0",
      "Causoryn.RoslynWorker.dll",
    ),
    path.join(
      pkgRoot,
      "native",
      "roslyn-worker",
      "bin",
      "Debug",
      "net10.0",
      "Causoryn.RoslynWorker.dll",
    ),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

function inspectRuntimeRoot(
  pkgRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  musl: boolean,
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

  const prebuildTarget = platform === "linux" && musl ? "linuxmusl" : platform;
  const prebuildPath = path.join(
    pkgRoot,
    "dist",
    "node_modules",
    "better-sqlite3",
    "prebuilds",
    `${prebuildTarget}-${arch}.node`,
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
  if (!resolveCompiledRoslynDllExists(pkgRoot)) {
    nativeWorkersPresent = false;
    missing.push(path.join(pkgRoot, "native", "roslyn-worker", "Causoryn.RoslynWorker.dll"));
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
  musl: boolean,
): DoctorRuntimeCheck {
  const primary = inspectRuntimeRoot(packageRoot, platform, arch, musl);
  const candidateStaged = getPersistentRuntimeDir(homeDir);
  const hasStaged = existsSync(candidateStaged);
  let stagedRuntimeOk: boolean | null = null;
  const allMissing = [...primary.missingPaths];

  if (hasStaged) {
    const stagedCheck = inspectRuntimeRoot(candidateStaged, platform, arch, musl);
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
        ? `${res.version ?? spec.cmd} (sidecar ready)`
        : `Not found (${res.detail}) — this language falls back to L0/L1 file-level analysis`,
    };
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeExecutableCommand(command: unknown): command is string {
  if (typeof command !== "string") {
    return false;
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }
  let end = trimmed.length;
  while (end > 0 && (trimmed[end - 1] === "/" || trimmed[end - 1] === "\\")) {
    end -= 1;
  }
  const normalized = trimmed.slice(0, end);
  const base = normalized.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === "node" || base === "node.exe";
}

function checkEntrypointExists(command: unknown, args: unknown): boolean | null {
  if (!isNodeExecutableCommand(command) || !Array.isArray(args) || typeof args[0] !== "string") {
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
  claudeConfigDir: string | null,
  detectedSet: ReadonlySet<HostClientId>,
): DoctorHostStatus {
  const detected = detectedSet.has(client);
  const skillsDir = getHostSkillsDir(homeDir, client, claudeConfigDir);
  const skills = inspectSkills(skillsDir);

  let configPath: string;
  switch (client) {
    case "antigravity":
      configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
      break;
    case "claude-code":
      configPath = getClaudeConfigFilePath(homeDir, claudeConfigDir);
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
          parseDetail = "the JSON root value is not an object";
        } else if (client === "zcode") {
          const mcp = parsed["mcp"];
          const servers = isPlainObject(mcp) ? mcp["servers"] : undefined;
          if (mcp !== undefined && !isPlainObject(mcp)) {
            configValid = false;
            parseDetail = "the mcp field is not an object";
          } else if (servers !== undefined && !isPlainObject(servers)) {
            configValid = false;
            parseDetail = "the mcp.servers field is not an object";
          } else if (isPlainObject(servers) && "causoryn" in servers) {
            const entry = servers["causoryn"];
            if (!isPlainObject(entry)) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "the mcp.servers.causoryn field is not an object";
            } else if (
              typeof entry["command"] !== "string" ||
              entry["command"].trim().length === 0
            ) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcp.servers.causoryn.command must be a non-empty string";
            } else {
              mcpConfigured = true;
              entrypointExists = checkEntrypointExists(entry["command"], entry["args"]);
            }
          }
        } else {
          const servers = parsed["mcpServers"];
          if (servers !== undefined && !isPlainObject(servers)) {
            configValid = false;
            parseDetail = "the mcpServers field is not an object";
          } else if (isPlainObject(servers) && "causoryn" in servers) {
            const entry = servers["causoryn"];
            if (!isPlainObject(entry)) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "the mcpServers.causoryn field is not an object";
            } else if (
              typeof entry["command"] !== "string" ||
              entry["command"].trim().length === 0
            ) {
              mcpConfigured = false;
              configValid = false;
              parseDetail = "mcpServers.causoryn.command must be a non-empty string";
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
          parseDetail = `the JSON root value of the secondary Antigravity config is not an object (${secondary})`;
        } else if (
          secParsed["mcpServers"] !== undefined &&
          !isPlainObject(secParsed["mcpServers"])
        ) {
          configValid = false;
          parseDetail = `the mcpServers field of the secondary Antigravity config is not an object (${secondary})`;
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
            parseDetail = `mcpServers.causoryn.command in the secondary Antigravity config must be a non-empty string (${secondary})`;
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
    detail = `Invalid configuration: ${parseDetail}`;
  } else if (brokenEntrypoint) {
    status = "error";
    detail =
      "The MCP server entry script was not found on disk (refresh it with `npx causoryn setup --yes`)";
  } else if (aligned) {
    status = "ok";
    detail = `MCP server and all ${String(CANONICAL_SKILL_NAMES.length)} routing skills are aligned`;
  } else if (!mcpConfigured && skills.installed.length === 0) {
    status = "not-configured";
    detail = detected
      ? "Host detected, but Causoryn is not installed for it yet"
      : "Host not detected";
  } else {
    status = "warn";
    detail = mcpConfigured
      ? `MCP server is configured, but these skills are missing: ${skills.missing.join(", ")}`
      : "Skill files are installed, but the MCP server entry is missing";
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

/** Legacy per-host index name written by earlier versions: `graph-<client>.sqlite`. */
const LEGACY_INDEX_FILE_PATTERN = /^graph-[a-z0-9._-]+\.sqlite$/i;
const SHARED_INDEX_FILE_NAME = "graph.sqlite";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * `workspaces/` directories that may hold per-workspace data dirs: the default
 * `~/.causoryn` data root and, when the environment applies, `ZCODE_PLUGIN_DATA`.
 */
export function resolveLegacyIndexScanDirs(
  homeDir: string,
  explicitHomeProvided = false,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [path.join(homeDir, ".causoryn")];
  if (!explicitHomeProvided || env !== process.env) {
    const zcodeDataDir = env["ZCODE_PLUGIN_DATA"]?.trim();
    if (
      zcodeDataDir !== undefined &&
      zcodeDataDir.length > 0 &&
      !zcodeDataDir.includes("\0") &&
      path.isAbsolute(zcodeDataDir)
    ) {
      roots.push(path.resolve(zcodeDataDir));
    }
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const root of roots) {
    const dir = path.join(root, "workspaces");
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (!seen.has(key)) {
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs;
}

function readDirEntries(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Read-only scan for legacy `graph-<client>.sqlite` files next to (or instead of)
 * the shared `graph.sqlite` in each workspace data directory. Does not descend
 * into symbolic-link entries and never creates, changes, or deletes anything.
 */
export function inspectLegacyIndexFiles(scanDirs: readonly string[]): DoctorLegacyIndexCheck {
  const files: DoctorLegacyIndexFile[] = [];
  for (const workspacesDir of scanDirs) {
    const workspaceEntries = readDirEntries(workspacesDir);
    if (workspaceEntries === null) continue;
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) continue;
      const workspaceDataDir = path.join(workspacesDir, workspaceEntry.name);
      const children = readDirEntries(workspaceDataDir);
      if (children === null) continue;
      const fileNames = new Set(
        children.filter((child) => child.isFile()).map((child) => child.name),
      );
      const sharedIndexPresent = fileNames.has(SHARED_INDEX_FILE_NAME);
      for (const name of fileNames) {
        if (!LEGACY_INDEX_FILE_PATTERN.test(name)) continue;
        files.push({
          path: path.join(workspaceDataDir, name),
          workspaceDataDir,
          sharedIndexPresent,
          sidecars: SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${name}${suffix}`)
            .filter((sidecar) => fileNames.has(sidecar))
            .map((sidecar) => path.join(workspaceDataDir, sidecar)),
        });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (files.length === 0) {
    return {
      status: "ok",
      scannedDirs: [...scanDirs],
      files,
      detail: "No legacy per-host index files (graph-<client>.sqlite) found.",
    };
  }

  const redundant = files.filter((file) => file.sharedIndexPresent).length;
  const pending = files.length - redundant;
  const parts = [
    `Found ${String(files.length)} legacy per-host index file(s) (graph-<client>.sqlite) from an earlier Causoryn version; the server now keeps one shared ${SHARED_INDEX_FILE_NAME} per workspace.`,
  ];
  if (redundant > 0) {
    parts.push(
      `${String(redundant)} of them sit next to an existing ${SHARED_INDEX_FILE_NAME} and can be deleted, together with their -wal/-shm sidecar files.`,
    );
  }
  if (pending > 0) {
    parts.push(
      `${String(pending)} of them have no ${SHARED_INDEX_FILE_NAME} yet: start the MCP server once in that workspace so it migrates the index, then delete them (deleting them earlier only forces a re-index).`,
    );
  }
  parts.push("Doctor never deletes files.");
  return {
    status: "warn",
    scannedDirs: [...scanDirs],
    files,
    detail: parts.join(" "),
  };
}

export type DoctorOverallStatus = "HEALTHY" | "DEGRADED" | "NOT CONFIGURED" | "UNHEALTHY";

export type DoctorReportWithStatus = DoctorReport & {
  readonly overallStatus: DoctorOverallStatus;
  readonly configuredCount: number;
};

function hasToolchainProbeWarn(
  toolchains: Readonly<Record<SidecarToolchainId, DoctorToolchainStatus>>,
): boolean {
  for (const tcId of SIDECAR_TOOLCHAIN_IDS) {
    const tc = toolchains[tcId] as DoctorToolchainStatus & { readonly status?: string };
    if (tc.status === "warn") {
      return true;
    }
  }
  return false;
}

export function computeDoctorOverallStatus(
  report: DoctorReport,
  selectedClients?: readonly HostClientId[],
): { readonly overallStatus: DoctorOverallStatus; readonly configuredCount: number } {
  const clients: readonly HostClientId[] =
    selectedClients !== undefined && selectedClients.length > 0
      ? [...new Set(selectedClients)]
      : HOST_CLIENT_IDS;
  const hostErrors = clients.some((c) => report.hosts[c].status === "error");
  const configuredCount = clients.filter(
    (c) => report.hosts[c].status === "ok" || report.hosts[c].status === "warn",
  ).length;
  const hostWarns = clients.some((c) => report.hosts[c].status === "warn");
  const probeWarns = hasToolchainProbeWarn(report.toolchains);

  if (!report.node.ok || !report.runtime.ok || hostErrors) {
    return { overallStatus: "UNHEALTHY", configuredCount };
  }
  if (configuredCount === 0) {
    return { overallStatus: "NOT CONFIGURED", configuredCount };
  }
  if (hostWarns || probeWarns) {
    return { overallStatus: "DEGRADED", configuredCount };
  }
  return { overallStatus: "HEALTHY", configuredCount };
}

type ExtendedDoctorOptions = DoctorOptions & {
  readonly isMusl?: boolean | undefined;
  readonly claudeConfigDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
};

export function runDoctor(options: ExtendedDoctorOptions = {}): DoctorReportWithStatus {
  const effectiveEnv = options.env ?? process.env;
  const explicitHomeProvided = options.homeDir !== undefined;
  const homeDir = resolveEffectiveHomeDir(options.homeDir);
  const codexHomeDir = resolveEffectiveCodexHomeDir(
    homeDir,
    options.codexHomeDir,
    explicitHomeProvided,
    effectiveEnv,
  );
  const claudeConfigDir = resolveEffectiveClaudeConfigDir(
    options.claudeConfigDir,
    explicitHomeProvided,
    effectiveEnv,
  );
  const packageRoot = path.resolve(options.packageRoot ?? resolveDefaultPackageRoot());
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const musl =
    options.isMusl !== undefined
      ? Boolean(options.isMusl)
      : platform === "linux" && process.platform === "linux"
        ? isLinuxMusl(platform)
        : false;
  const probe = options.probeToolchain ?? defaultToolchainProbe;

  const nodeCheck = checkNodeVersion(nodeVersion);
  const runtimeCheck = checkRuntime(packageRoot, homeDir, platform, arch, musl);
  const toolchains = probeSidecarToolchains(probe);

  const detectedSet = new Set<HostClientId>(
    detectInstalledClients(homeDir, codexHomeDir, claudeConfigDir),
  );
  const targetClients: readonly HostClientId[] =
    options.clients !== undefined && options.clients.length > 0
      ? [...new Set(options.clients)]
      : HOST_CLIENT_IDS;

  const hosts = {} as Record<HostClientId, DoctorHostStatus>;
  for (const client of HOST_CLIENT_IDS) {
    hosts[client] = inspectSingleHost(
      client,
      homeDir,
      codexHomeDir,
      claudeConfigDir,
      detectedSet,
    );
  }

  const legacyIndexFiles = inspectLegacyIndexFiles(
    resolveLegacyIndexScanDirs(homeDir, explicitHomeProvided, effectiveEnv),
  );

  const baseReport: DoctorReport = {
    healthy: false,
    version: CAUSORYN_PACKAGE_VERSION,
    node: nodeCheck,
    runtime: runtimeCheck,
    toolchains,
    hosts,
    legacyIndexFiles,
  };
  const { overallStatus, configuredCount } = computeDoctorOverallStatus(baseReport, targetClients);
  const healthy = overallStatus === "HEALTHY";

  return {
    ...baseReport,
    healthy,
    overallStatus,
    configuredCount,
  };
}

export function formatDoctorReportText(
  report: DoctorReport | DoctorReportWithStatus,
  selectedClients?: readonly HostClientId[],
): string {
  const overallStatus: DoctorOverallStatus =
    selectedClients === undefined &&
    "overallStatus" in report &&
    typeof report.overallStatus === "string"
      ? report.overallStatus
      : computeDoctorOverallStatus(report, selectedClients).overallStatus;

  const lines: string[] = [];
  lines.push(`Causoryn Doctor v${report.version} — ${overallStatus}`);
  if (overallStatus === "NOT CONFIGURED") {
    lines.push(
      "Summary: No MCP host is configured yet. Run `causoryn setup --client <antigravity|claude-code|codex|zcode>` or `causoryn setup --all`.",
    );
  } else if (overallStatus === "DEGRADED") {
    lines.push(
      "Summary: One or more configured hosts or probes reported warnings. Run `causoryn setup --yes` to restore full alignment.",
    );
  }
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
  lines.push("");
  const legacy = report.legacyIndexFiles;
  lines.push(`[Legacy Index Files] ${legacy.status.toUpperCase()} — ${legacy.detail}`);
  for (const file of legacy.files) {
    lines.push(
      file.sharedIndexPresent
        ? `  - ${file.path} (graph.sqlite present: safe to delete)`
        : `  - ${file.path} (graph.sqlite missing: keep it until the server has migrated it)`,
    );
    for (const sidecar of file.sidecars) {
      lines.push(`    sidecar: ${sidecar}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
