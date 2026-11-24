import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ortak tipler, sabitler ve hata sınıfları (`packages/causoryn`, K-021).
 */

function readPackageVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback aşağıda.
  }
  return "0.3.0";
}

export const CAUSORYN_PACKAGE_NAME = "causoryn" as const;
export const CAUSORYN_PACKAGE_VERSION: string = readPackageVersion();

export const HOST_CLIENT_IDS = [
  "antigravity",
  "claude-code",
  "codex",
  "zcode",
] as const;

export type HostClientId = (typeof HOST_CLIENT_IDS)[number];

export const CANONICAL_SKILL_NAMES = [
  "causoryn",
  "map-system",
  "preflight-change",
  "verify-change",
  "architecture-blueprint",
] as const;

export type CanonicalSkillName = (typeof CANONICAL_SKILL_NAMES)[number];

export type SidecarToolchainId = "dotnet" | "python" | "go" | "cargo";

export const SIDECAR_TOOLCHAIN_IDS: readonly SidecarToolchainId[] = [
  "dotnet",
  "python",
  "go",
  "cargo",
] as const;

/**
 * Python commands tried in order when no command is configured (POSIX:
 * python3, then python; win32: python). Pinned copy of
 * `PYTHON_COMMAND_CANDIDATES` from `@causoryn/adapter-python` (this package has
 * no runtime dependency on it); `tests/python-command-candidates.test.ts`
 * guards drift, so `causoryn doctor` probes the interpreter the Python adapter
 * will start.
 */
export const PYTHON_COMMAND_CANDIDATES: {
  readonly posix: readonly string[];
  readonly win32: readonly string[];
} = {
  posix: ["python3", "python"],
  win32: ["python"],
};

/** Default Python command candidates for `platform`, in the order they are tried. */
export function pythonCommandCandidates(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? PYTHON_COMMAND_CANDIDATES.win32 : PYTHON_COMMAND_CANDIDATES.posix;
}

export function isHostClientId(value: string): value is HostClientId {
  return (HOST_CLIENT_IDS as readonly string[]).includes(value);
}

/**
 * Tool profiles accepted by `causoryn setup --tool-profile`. Pinned copy of
 * `TOOL_PROFILES` from `@causoryn/mcp-server` (this package has no runtime
 * dependency on it); `tests/causoryn-setup-tool-profile.test.ts` guards drift.
 */
export const SETUP_TOOL_PROFILES = ["core", "full", "wiki", "history"] as const;

export type SetupToolProfile = (typeof SETUP_TOOL_PROFILES)[number];

export type CausorynCliErrorCode =
  | "cli/invalid-arguments"
  | "cli/malformed-json"
  | "cli/malformed-toml"
  | "cli/confirmation-required"
  | "cli/runtime-stage-failed"
  | "cli/io-error";

export class CausorynCliError extends Error {
  readonly code: CausorynCliErrorCode;

  constructor(code: CausorynCliErrorCode, message: string) {
    super(message);
    this.name = "CausorynCliError";
    this.code = code;
  }
}

export interface CodexMcpServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Value written for `startup_timeout_sec` (default 30); an existing line with this value is kept verbatim. */
  readonly startupTimeoutSec?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface ParsedCodexMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  /** `startup_timeout_sec` as a number (TOML integer or float), or null when absent or unusable. */
  readonly startupTimeoutSec: number | null;
  /** Raw TOML value text of `startup_timeout_sec`; undefined when the key is absent. */
  readonly startupTimeoutSecRaw?: string | undefined;
  /**
   * Environment of the entry, merged from an inline `env = { ... }` table,
   * dotted `env.KEY = "..."` keys and the `[mcp_servers.causoryn.env]` sub-table.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface StagePersistentRuntimeOptions {
  readonly homeDir: string;
  readonly sourcePackageDir: string;
}

export interface StagePersistentRuntimeResult {
  readonly runtimeDir: string;
  readonly cliEntryPath: string;
  readonly launcherPath: string;
}

export interface SetupAction {
  readonly client: HostClientId;
  readonly kind: "mcp-config" | "skill";
  readonly operation: "create" | "update" | "remove" | "noop";
  readonly targetPath: string;
  readonly backupPath: string | null;
  readonly detail: string;
}

export interface SetupOptions {
  readonly homeDir?: string | undefined;
  readonly codexHomeDir?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly ephemeralTmpDir?: string | undefined;
  readonly clients?: readonly HostClientId[] | undefined;
  readonly all?: boolean | undefined;
  /** Explicit alias of the default selection: configure the hosts detected on this machine. */
  readonly allDetected?: boolean | undefined;
  /**
   * Tool profile list (`core`, `full`, `wiki`, `history` or a comma list) written as
   * `--tool-profile <list>` into every generated `causoryn mcp` entry. When omitted,
   * an existing `--tool-profile` argument of the entry is kept.
   */
  readonly toolProfile?: string | undefined;
  readonly nodeExecutable?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly uninstall?: boolean | undefined;
  readonly installSkills?: boolean | undefined;
  readonly confirm?: ((actions: readonly SetupAction[]) => Promise<boolean> | boolean) | undefined;
}

export interface SetupResult {
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly uninstall: boolean;
  readonly selectedClients: readonly HostClientId[];
  readonly stagedRuntimeDir: string | null;
  readonly runtimeCleanedUp: boolean;
  readonly actions: readonly SetupAction[];
  /** True when no `--client` / `--all` was given and no supported host was detected (nothing was changed). */
  readonly noClientsDetected?: boolean | undefined;
  readonly message?: string | undefined;
}

export interface ToolchainProbeOutcome {
  readonly available: boolean;
  /** First non-empty output line of a successful probe. */
  readonly version: string | null;
  readonly detail: string;
  /** Full stdout + stderr text of a successful probe (multi-line output such as `dotnet --list-runtimes`). */
  readonly output?: string | undefined;
  /**
   * Why an unavailable probe failed (defaults to `not-found`):
   * - `not-found`: no such command (informational).
   * - `exited`: the command ran but exited non-zero, typically a version-manager shim or
   *   proxy (rustup, pyenv, asdf) with no toolchain selected; treated as not installed.
   * - `error`: the probe could not complete (timeout, permission denied, other spawn
   *   error), so an installed toolchain is unusable; a warning.
   */
  readonly failure?: "not-found" | "exited" | "error" | undefined;
}

export type ToolchainProbeFn = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => ToolchainProbeOutcome;

export interface DoctorNodeCheck {
  readonly ok: boolean;
  readonly version: string;
  readonly requiredMajor: number;
  readonly detail: string;
}

export interface DoctorRuntimeCheck {
  readonly ok: boolean;
  readonly packageRoot: string;
  readonly bundlePresent: boolean;
  readonly sqlitePrebuildPresent: boolean;
  readonly typescriptLibPresent: boolean;
  readonly nativeWorkersPresent: boolean;
  readonly stagedRuntimeDir: string | null;
  readonly stagedRuntimeOk: boolean | null;
  readonly missingPaths: readonly string[];
}

export interface DoctorToolchainStatus {
  readonly id: SidecarToolchainId;
  /** Whether the probe command ran successfully. */
  readonly available: boolean;
  /** Parsed toolchain version (for `dotnet`: the best Microsoft.NETCore.App runtime found), or null. */
  readonly version: string | null;
  /** Supported minimum version, or null when none is pinned (`cargo`). */
  readonly minimumVersion: string | null;
  /**
   * `ok`: usable and at or above the minimum. `warn`: installed but below the minimum,
   * its version could not be read, or the probe timed out / could not be started —
   * makes the report `DEGRADED`. `absent`: not installed, or the command exits without
   * a usable toolchain; informational only (that language uses L0/L1 analysis).
   */
  readonly status: "ok" | "warn" | "absent";
  readonly mode: "sidecar-ready" | "l0-l1-fallback";
  readonly detail: string;
}

export interface DoctorHostStatus {
  readonly client: HostClientId;
  readonly detected: boolean;
  readonly configPath: string;
  readonly configValid: boolean;
  readonly mcpConfigured: boolean;
  readonly entrypointExists: boolean | null;
  readonly skillsDir: string;
  readonly skillsInstalled: readonly CanonicalSkillName[];
  readonly missingSkills: readonly CanonicalSkillName[];
  readonly aligned: boolean;
  readonly status: "ok" | "warn" | "not-configured" | "error";
  readonly detail: string;
}

/** A legacy per-host index file (`graph-<client>.sqlite`) found in a workspace data directory. */
export interface DoctorLegacyIndexFile {
  readonly path: string;
  readonly workspaceDataDir: string;
  /** Whether the shared `graph.sqlite` exists in the same directory (the legacy file is then redundant). */
  readonly sharedIndexPresent: boolean;
  /** Existing `-wal` / `-shm` / `-journal` sidecar files of the legacy database. */
  readonly sidecars: readonly string[];
}

/**
 * Advisory check for legacy per-host index files. A `warn` here is housekeeping
 * only: it does not change `overallStatus` or the exit code.
 */
export interface DoctorLegacyIndexCheck {
  readonly status: "ok" | "warn";
  readonly scannedDirs: readonly string[];
  readonly files: readonly DoctorLegacyIndexFile[];
  readonly detail: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly version: string;
  readonly node: DoctorNodeCheck;
  readonly runtime: DoctorRuntimeCheck;
  readonly toolchains: Readonly<Record<SidecarToolchainId, DoctorToolchainStatus>>;
  readonly hosts: Readonly<Record<HostClientId, DoctorHostStatus>>;
  readonly legacyIndexFiles: DoctorLegacyIndexCheck;
}

export interface DoctorOptions {
  readonly homeDir?: string | undefined;
  readonly codexHomeDir?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly clients?: readonly HostClientId[] | undefined;
  readonly nodeVersion?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly probeToolchain?: ToolchainProbeFn | undefined;
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isInteractive?: boolean | undefined;
  readonly confirm?: ((promptText: string) => Promise<boolean> | boolean) | undefined;
}

export interface RunCliOptions {
  readonly io?: CliIo | undefined;
  readonly homeDir?: string | undefined;
  readonly codexHomeDir?: string | undefined;
  readonly packageRoot?: string | undefined;
  readonly ephemeralTmpDir?: string | undefined;
  readonly probeToolchain?: ToolchainProbeFn | undefined;
}
