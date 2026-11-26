import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

import { describeJsonSyntaxError } from "./diagnostics.js";
import {
  collectUntrustedRoots,
  resolveExecutable,
  sanitizePathValue,
  trustedWorkingDirectory,
  withoutCwdExecutableSearch,
} from "./executable-resolution.js";
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
  CausorynCliError,
  HOST_CLIENT_IDS,
  SIDECAR_TOOLCHAIN_IDS,
  pythonCommandCandidates,
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
const WINDOWS_COMMAND_NOT_FOUND_EXIT = 9009;

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

/**
 * Probe environment: allowlisted variables only, plus the same Go toolchain
 * pinning the Go adapter uses (GOTOOLCHAIN=local, GOENV=off, GOWORK=off, so
 * doctor reports the toolchain the adapter will actually run) and, on
 * win32, NoDefaultCurrentDirectoryInExePath=1.
 */
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
  env["GOTOOLCHAIN"] = "local";
  env["GOENV"] = "off";
  env["GOWORK"] = "off";
  return withoutCwdExecutableSearch(env);
}

const PROBE_NOT_FOUND: ToolchainProbeOutcome = {
  available: false,
  version: null,
  detail: "ENOENT",
  failure: "not-found",
};

/**
 * Runs `<command> <args>` and classifies the result. The command is resolved
 * to an absolute executable first (relative, empty and cwd PATH entries are
 * skipped; see executable-resolution.ts) and runs from its own directory —
 * a fixed directory of the toolchain installation — rather than from the
 * shared temporary directory, where project files such as go.mod,
 * rust-toolchain.toml, .python-version or global.json could select another
 * toolchain. Nothing is created on disk.
 */
export function defaultToolchainProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): ToolchainProbeOutcome {
  const untrustedRoots = collectUntrustedRoots();
  const probeEnv = buildDoctorProbeEnv();
  for (const key of Object.keys(probeEnv)) {
    if (key.toUpperCase() !== "PATH") continue;
    const sanitized = sanitizePathValue(probeEnv[key] ?? "", untrustedRoots);
    if (sanitized.length > 0) probeEnv[key] = sanitized;
    else delete probeEnv[key];
  }
  const runOnce = (cmd: string): ToolchainProbeOutcome => {
    const executable = resolveExecutable(cmd, { env: probeEnv, untrustedRoots });
    if (executable === null) {
      return PROBE_NOT_FOUND;
    }
    const cwd = trustedWorkingDirectory([path.dirname(executable)], untrustedRoots);
    if (cwd === null) {
      return PROBE_NOT_FOUND;
    }
    const res = spawnSync(executable, [...args], {
      cwd,
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
        // Only a missing executable is "not installed"; a timeout or EACCES means
        // an installed toolchain cannot be used.
        failure: code === "ENOENT" ? "not-found" : "error",
      };
    }
    if (res.status !== 0) {
      const stderrLine = (res.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
      return {
        available: false,
        version: null,
        detail: stderrLine.length > 0 ? stderrLine : `exit ${String(res.status)}`,
        // Exit code 9009 is the Windows "command not found" code, also returned by
        // the Microsoft Store `python.exe` alias when Python is not installed. Any
        // other non-zero exit is usually a version-manager shim or proxy (rustup,
        // pyenv, asdf) without a selected toolchain.
        failure:
          process.platform === "win32" && res.status === WINDOWS_COMMAND_NOT_FOUND_EXIT
            ? "not-found"
            : "exited",
      };
    }
    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const firstLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      available: true,
      version: firstLine ?? cmd,
      detail: "ok",
      output,
    };
  };

  // Alternative commands (python3 / python) are tried by the caller, in the
  // Python adapter's order (see probeSidecarToolchains).
  return runOnce(command);
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

interface ToolchainVersionCheck {
  /** Parsed version, or null when the probe output carries none. */
  readonly version: string | null;
  /** Why the toolchain does not meet the requirement, or null when it does. */
  readonly problem: string | null;
}

interface SidecarToolchainSpec {
  readonly id: SidecarToolchainId;
  /**
   * Commands tried in order (the same order the language adapter uses); the
   * first one that is not "not found" is the one reported.
   */
  readonly commands: (platform: NodeJS.Platform) => readonly string[];
  readonly args: readonly string[];
  readonly label: string;
  readonly minimumVersion: string | null;
  readonly check: (output: string, cmd: string) => ToolchainVersionCheck;
}

interface NumericVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

function toNumericVersion(match: RegExpExecArray): NumericVersion {
  const major = Number.parseInt(match[1] ?? "0", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  const patch = Number.parseInt(match[3] ?? "0", 10);
  const text = [match[1], match[2], match[3]].filter((part) => part !== undefined).join(".");
  return { major, minor, patch, text: `${text}${match[4] ?? ""}` };
}

function compareNumericVersion(a: NumericVersion, b: NumericVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function firstOutputLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function unreadableVersion(cmd: string, args: readonly string[], output: string): ToolchainVersionCheck {
  return {
    version: null,
    problem: `Could not read a version from the \`${[cmd, ...args].join(" ")}\` output ("${firstOutputLine(output)}")`,
  };
}

/** Checks `<prefix><major>.<minor>[.<patch>]` against a `major.minor` floor. */
function checkVersionFloor(params: {
  readonly output: string;
  readonly pattern: RegExp;
  readonly label: string;
  readonly minimum: { readonly major: number; readonly minor: number };
  readonly cmd: string;
  readonly args: readonly string[];
}): ToolchainVersionCheck {
  const match = params.pattern.exec(params.output);
  if (match === null) {
    return unreadableVersion(params.cmd, params.args, params.output);
  }
  const version = toNumericVersion(match);
  const floor: NumericVersion = { ...params.minimum, patch: 0, text: "" };
  if (compareNumericVersion(version, floor) < 0) {
    return {
      version: version.text,
      problem: `${params.label} ${version.text} is below the supported minimum ${String(params.minimum.major)}.${String(params.minimum.minor)}`,
    };
  }
  return { version: version.text, problem: null };
}

const REQUIRED_DOTNET_RUNTIME_MAJOR = 10;
const NETCORE_RUNTIME_LINE = /^Microsoft\.NETCore\.App (\d+)\.(\d+)\.(\d+)(\S*)/gm;

/**
 * The Roslyn worker targets `net10.0` and is started with `dotnet exec`, so it
 * needs a Microsoft.NETCore.App 10.x runtime: the default roll-forward policy
 * (`Minor`) never moves to another major version
 * (https://learn.microsoft.com/dotnet/core/versions/selection#framework-dependent-apps-roll-forward).
 * `dotnet --list-runtimes` works without an SDK, unlike `dotnet --version`.
 */
function checkDotnetRuntimes(output: string): ToolchainVersionCheck {
  const runtimes = [...output.matchAll(NETCORE_RUNTIME_LINE)].map((m) => toNumericVersion(m));
  const supported = runtimes
    .filter((runtime) => runtime.major === REQUIRED_DOTNET_RUNTIME_MAJOR)
    .sort(compareNumericVersion);
  const best = supported[supported.length - 1];
  if (best !== undefined) {
    return { version: best.text, problem: null };
  }
  const installed = runtimes.map((runtime) => runtime.text).join(", ");
  return {
    version: null,
    problem: `No .NET ${String(REQUIRED_DOTNET_RUNTIME_MAJOR)} runtime (Microsoft.NETCore.App ${String(REQUIRED_DOTNET_RUNTIME_MAJOR)}.x) found; installed Microsoft.NETCore.App runtimes: ${installed.length > 0 ? installed : "none"}. The C# worker targets net${String(REQUIRED_DOTNET_RUNTIME_MAJOR)}.0, and the default roll-forward policy does not run it on another major version`,
  };
}

const SIDECAR_TOOLCHAIN_SPECS: readonly SidecarToolchainSpec[] = [
  {
    id: "dotnet",
    commands: () => ["dotnet"],
    args: ["--list-runtimes"],
    label: ".NET runtime",
    minimumVersion: `${String(REQUIRED_DOTNET_RUNTIME_MAJOR)}.0`,
    check: checkDotnetRuntimes,
  },
  {
    id: "python",
    // Same candidates and order as the Python adapter's default command.
    commands: pythonCommandCandidates,
    args: ["--version"],
    label: "Python",
    minimumVersion: "3.10",
    check: (output, cmd) =>
      checkVersionFloor({
        output,
        pattern: /\bPython (\d+)\.(\d+)(?:\.(\d+))?/,
        label: "Python",
        minimum: { major: 3, minor: 10 },
        cmd,
        args: ["--version"],
      }),
  },
  {
    id: "go",
    commands: () => ["go"],
    args: ["version"],
    label: "Go",
    // Same Go line as native/go-worker/go.mod (oldest supported Go release line).
    minimumVersion: "1.26",
    check: (output, cmd) =>
      checkVersionFloor({
        output,
        pattern: /\bgo(\d+)\.(\d+)(?:\.(\d+))?/,
        label: "Go",
        minimum: { major: 1, minor: 26 },
        cmd,
        args: ["version"],
      }),
  },
  {
    id: "cargo",
    commands: () => ["cargo"],
    args: ["--version"],
    label: "Cargo",
    minimumVersion: null,
    check: (output, cmd) => {
      const match = /\bcargo (\d+)\.(\d+)\.(\d+)/.exec(output);
      return match === null
        ? unreadableVersion(cmd, ["--version"], output)
        : { version: toNumericVersion(match).text, problem: null };
    },
  },
];

const L0_L1_FALLBACK_NOTE = "this language falls back to L0/L1 file-level analysis";

function evaluateSidecarToolchain(
  spec: SidecarToolchainSpec,
  res: ToolchainProbeOutcome,
  cmd: string,
  tried: readonly string[],
): DoctorToolchainStatus {
  const base = { id: spec.id, available: res.available, minimumVersion: spec.minimumVersion };
  // With several candidate commands, say which one was found (the one the adapter starts).
  const via = tried.length > 1 ? ` via \`${cmd}\`` : "";
  if (!res.available) {
    const probeCommand = `\`${[cmd, ...spec.args].join(" ")}\``;
    if (res.failure === "error") {
      return {
        ...base,
        version: null,
        status: "warn",
        mode: "l0-l1-fallback",
        detail: `${probeCommand} probe failed (${res.detail}) — ${L0_L1_FALLBACK_NOTE} until the toolchain works`,
      };
    }
    return {
      ...base,
      version: null,
      status: "absent",
      mode: "l0-l1-fallback",
      detail:
        res.failure === "exited"
          ? `Not usable: ${probeCommand} exited without a working toolchain (${res.detail}); treated as not installed — ${L0_L1_FALLBACK_NOTE}`
          : `Not found (${res.detail}${tried.length > 1 ? `; tried ${tried.join(", ")}` : ""}) — ${L0_L1_FALLBACK_NOTE}`,
    };
  }
  const check = spec.check(res.output ?? res.version ?? "", cmd);
  if (check.problem !== null) {
    return {
      ...base,
      version: check.version,
      status: "warn",
      mode: "l0-l1-fallback",
      detail: `${check.problem}${via} — unsupported: the sidecar may fail, and this language then falls back to L0/L1 file-level analysis`,
    };
  }
  return {
    ...base,
    version: check.version,
    status: "ok",
    mode: "sidecar-ready",
    detail: `${spec.label} ${check.version ?? ""}${via}${spec.minimumVersion !== null ? `, minimum ${spec.minimumVersion}` : ""}`,
  };
}

function isNotFoundOutcome(res: ToolchainProbeOutcome): boolean {
  return !res.available && (res.failure ?? "not-found") === "not-found";
}

function probeSidecarToolchains(
  probe: ToolchainProbeFn,
  platform: NodeJS.Platform,
): Record<SidecarToolchainId, DoctorToolchainStatus> {
  const out = {} as Record<SidecarToolchainId, DoctorToolchainStatus>;
  for (const spec of SIDECAR_TOOLCHAIN_SPECS) {
    const candidates = spec.commands(platform);
    // A candidate that exists but fails is reported as is: the adapter would start it too.
    let cmd = candidates[0] ?? spec.id;
    let res = probe(cmd, spec.args, SIDECAR_PROBE_TIMEOUT_MS);
    for (let i = 1; i < candidates.length && isNotFoundOutcome(res); i += 1) {
      cmd = candidates[i] ?? cmd;
      res = probe(cmd, spec.args, SIDECAR_PROBE_TIMEOUT_MS);
    }
    out[spec.id] = evaluateSidecarToolchain(spec, res, cmd, candidates);
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
        // CWE-209: Causoryn's TOML errors name the line and key, never the value;
        // any other error text is not carried over.
        parseDetail =
          error instanceof CausorynCliError ? error.message : "the Codex config.toml could not be read as TOML";
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
        // CWE-209: the JSON parser's message quotes the file's text.
        parseDetail = describeJsonSyntaxError(error);
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
        parseDetail = `${describeJsonSyntaxError(error)} in the secondary Antigravity config (${secondary})`;
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

/**
 * A toolchain that is installed but unusable (below its minimum version, version
 * unreadable, or the probe timed out / could not start) degrades the report; an
 * absent one (including a shim that exits without a toolchain) does not.
 */
function hasToolchainProbeWarn(
  toolchains: Readonly<Record<SidecarToolchainId, DoctorToolchainStatus>>,
): boolean {
  return SIDECAR_TOOLCHAIN_IDS.some((tcId) => toolchains[tcId].status === "warn");
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
  const toolchains = probeSidecarToolchains(probe, platform);

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
    const clientsInScope =
      selectedClients !== undefined && selectedClients.length > 0 ? selectedClients : HOST_CLIENT_IDS;
    if (clientsInScope.some((client) => report.hosts[client].status === "warn")) {
      lines.push(
        "Summary: One or more configured hosts reported warnings. Run `causoryn setup --yes` to restore full alignment.",
      );
    }
    if (hasToolchainProbeWarn(report.toolchains)) {
      lines.push(
        "Summary: A sidecar toolchain is installed but unusable (see [Sidecar Toolchains]); install a supported version or fix it, then run `causoryn doctor` again.",
      );
    }
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
    lines.push(`  - ${tc.id}: ${tc.status.toUpperCase()} — ${tc.mode} (${tc.detail})`);
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
