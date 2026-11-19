/**
 * Ortak tipler, sabitler ve hata sınıfları (`packages/causoryn`, K-021).
 */

export const CAUSORYN_PACKAGE_NAME = "causoryn" as const;
export const CAUSORYN_PACKAGE_VERSION = "0.1.0" as const;

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
] as const;

export type CanonicalSkillName = (typeof CANONICAL_SKILL_NAMES)[number];

export type SidecarToolchainId = "dotnet" | "python" | "go" | "cargo";

export const SIDECAR_TOOLCHAIN_IDS: readonly SidecarToolchainId[] = [
  "dotnet",
  "python",
  "go",
  "cargo",
] as const;

export function isHostClientId(value: string): value is HostClientId {
  return (HOST_CLIENT_IDS as readonly string[]).includes(value);
}

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
  readonly startupTimeoutSec?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface ParsedCodexMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly startupTimeoutSec: number | null;
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
  readonly allDetected?: boolean | undefined;
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
}

export interface ToolchainProbeOutcome {
  readonly available: boolean;
  readonly version: string | null;
  readonly detail: string;
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
  readonly available: boolean;
  readonly version: string | null;
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

export interface DoctorReport {
  readonly healthy: boolean;
  readonly version: string;
  readonly node: DoctorNodeCheck;
  readonly runtime: DoctorRuntimeCheck;
  readonly toolchains: Readonly<Record<SidecarToolchainId, DoctorToolchainStatus>>;
  readonly hosts: Readonly<Record<HostClientId, DoctorHostStatus>>;
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
