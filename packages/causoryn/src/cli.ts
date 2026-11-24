import readline from "node:readline/promises";

import { formatDoctorReportText, runDoctor } from "./doctor.js";
import { runSetup } from "./setup.js";
import {
  CAUSORYN_PACKAGE_VERSION,
  CausorynCliError,
  HOST_CLIENT_IDS,
  isHostClientId,
  type CliIo,
  type HostClientId,
  type RunCliOptions,
  type SetupAction,
  type SetupResult,
} from "./types.js";

/**
 * `causoryn` CLI command parser and runner (`setup`, `doctor`, `--version`,
 * `--help`; `mcp` is handed off directly by `scripts/causoryn.mjs` to
 * `dist/mcp-server.mjs` with clean `stdout` JSON-RPC framing).
 */

/** Exit code of `causoryn setup` when no host was detected and none was named (nothing changed). */
const SETUP_NO_HOST_EXIT_CODE = 1;

const HELP_TEXT = `Usage:
  causoryn mcp [--allow-cwd] [--root <path>] [--auto-data-dir] [--data-dir <path>] [--client <id>] [--tool-profile <core|full|wiki|history>] [--output-schema <omit|full>]
  causoryn setup [--client <antigravity|claude-code|codex|zcode>...] [--all] [--all-detected] [--yes] [--dry-run] [--uninstall] [--skill | --no-skill] [--json]
  causoryn doctor [--client <antigravity|claude-code|codex|zcode>...] [--json]
  causoryn --version
  causoryn --help
`;

function defaultCliIo(): CliIo {
  return {
    stdout: (text: string) => {
      process.stdout.write(text);
    },
    stderr: (text: string) => {
      process.stderr.write(text);
    },
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (promptText: string): Promise<boolean> => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return false;
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = (await rl.question(promptText)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },
  };
}

function parseClientValues(raw: string): HostClientId[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new CausorynCliError(
      "cli/invalid-arguments",
      `A valid host ID is required for --client (${HOST_CLIENT_IDS.join(", ")})`,
    );
  }
  const parsed: HostClientId[] = [];
  for (const part of parts) {
    if (!isHostClientId(part)) {
      throw new CausorynCliError(
        "cli/invalid-arguments",
        `Invalid --client value "${part}". Supported values: ${HOST_CLIENT_IDS.join(", ")}`,
      );
    }
    parsed.push(part);
  }
  return parsed;
}

interface ParsedSetupCliFlags {
  readonly clients: HostClientId[];
  readonly all: boolean;
  readonly allDetected: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly uninstall: boolean;
  readonly installSkills: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

function parseSetupFlags(args: readonly string[]): ParsedSetupCliFlags {
  const clients: HostClientId[] = [];
  let all = false;
  let allDetected = false;
  let yes = false;
  let dryRun = false;
  let uninstall = false;
  let installSkills = true;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--all-detected") {
      allDetected = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--uninstall") {
      uninstall = true;
    } else if (arg === "--skill") {
      installSkills = true;
    } else if (arg === "--no-skill") {
      installSkills = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--client") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new CausorynCliError("cli/invalid-arguments", "--client flag requires a value");
      }
      clients.push(...parseClientValues(next));
      i += 1;
    } else if (arg.startsWith("--client=")) {
      clients.push(...parseClientValues(arg.slice("--client=".length)));
    } else {
      throw new CausorynCliError(
        "cli/invalid-arguments",
        `Unknown setup argument: ${arg}`,
      );
    }
  }

  return {
    clients,
    all,
    allDetected,
    yes,
    dryRun,
    uninstall,
    installSkills,
    json,
    help,
  };
}

interface ParsedDoctorCliFlags {
  readonly clients: HostClientId[];
  readonly json: boolean;
  readonly help: boolean;
}

function parseDoctorFlags(args: readonly string[]): ParsedDoctorCliFlags {
  const clients: HostClientId[] = [];
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--client") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new CausorynCliError("cli/invalid-arguments", "--client flag requires a value");
      }
      clients.push(...parseClientValues(next));
      i += 1;
    } else if (arg.startsWith("--client=")) {
      clients.push(...parseClientValues(arg.slice("--client=".length)));
    } else {
      throw new CausorynCliError(
        "cli/invalid-arguments",
        `Unknown doctor argument: ${arg}`,
      );
    }
  }

  return { clients, json, help };
}

function formatSetupActionsText(actions: readonly SetupAction[]): string {
  if (actions.length === 0) {
    return "  (no changes)\n";
  }
  return `${actions
    .map(
      (a) =>
        `  - [${a.client}] ${a.operation.toUpperCase()} (${a.kind}): ${a.targetPath} (${a.detail})`,
    )
    .join("\n")}\n`;
}

function formatSetupResultText(result: SetupResult): string {
  const modeLabel = result.dryRun
    ? "DRY-RUN PREVIEW"
    : result.applied
      ? result.uninstall
        ? "UNINSTALLED"
        : "APPLIED"
      : "NO CHANGES";
  const lines: string[] = [];
  lines.push(`Causoryn Setup — ${modeLabel}`);
  if (result.stagedRuntimeDir !== null) {
    lines.push(`Staged Runtime: ${result.stagedRuntimeDir}`);
  }
  if (result.runtimeCleanedUp) {
    lines.push("Staged Runtime Cleanup: removed ~/.causoryn/runtime (no remaining host references)");
  }
  if (result.message !== undefined && result.message.length > 0) {
    lines.push(result.message);
  }
  lines.push("Planned / Applied Actions:");
  lines.push(formatSetupActionsText(result.actions).trimEnd());
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? defaultCliIo();
  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (first === "--version" || first === "-v" || first === "version") {
    io.stdout(`${CAUSORYN_PACKAGE_VERSION}\n`);
    return 0;
  }

  try {
    if (first === "setup") {
      const flags = parseSetupFlags(argv.slice(1));
      if (flags.help) {
        io.stdout(HELP_TEXT);
        return 0;
      }

      const confirmHandler =
        !flags.yes && !flags.dryRun && io.isInteractive === true && io.confirm !== undefined
          ? async (actions: readonly SetupAction[]): Promise<boolean> => {
              io.stderr(`The following changes will be applied:\n${formatSetupActionsText(actions)}`);
              return await io.confirm!("Continue? [y/N] ");
            }
          : undefined;

      const result = await runSetup({
        homeDir: options.homeDir,
        codexHomeDir: options.codexHomeDir,
        packageRoot: options.packageRoot,
        ephemeralTmpDir: options.ephemeralTmpDir,
        ...(flags.clients.length > 0 ? { clients: flags.clients } : {}),
        all: flags.all,
        allDetected: flags.allDetected,
        yes: flags.yes,
        dryRun: flags.dryRun,
        uninstall: flags.uninstall,
        installSkills: flags.installSkills,
        confirm: confirmHandler,
      });

      if (result.noClientsDetected === true) {
        // Nothing was configured: guide the user on stderr and fail so scripts notice.
        if (flags.json) {
          io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        }
        io.stderr(`[causoryn] ${result.message ?? "No supported MCP host was detected."}\n`);
        return SETUP_NO_HOST_EXIT_CODE;
      }

      if (flags.json) {
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout(formatSetupResultText(result));
      }
      return 0;
    }

    if (first === "doctor") {
      const flags = parseDoctorFlags(argv.slice(1));
      if (flags.help) {
        io.stdout(HELP_TEXT);
        return 0;
      }

      const report = runDoctor({
        homeDir: options.homeDir,
        codexHomeDir: options.codexHomeDir,
        packageRoot: options.packageRoot,
        ...(flags.clients.length > 0 ? { clients: flags.clients } : {}),
        probeToolchain: options.probeToolchain,
      });

      if (flags.json) {
        io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        io.stdout(
          formatDoctorReportText(report, flags.clients.length > 0 ? flags.clients : undefined),
        );
      }
      return report.healthy ? 0 : 1;
    }

    throw new CausorynCliError(
      "cli/invalid-arguments",
      `Unknown subcommand: "${first}". Run \`causoryn --help\` for usage.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`[causoryn] error: ${message}\n`);
    return 2;
  }
}
