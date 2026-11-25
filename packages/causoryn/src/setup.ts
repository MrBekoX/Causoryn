import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeWritePath,
  isFreeOfLinkedComponents,
  publishFileNoClobber,
  removeTreeNoFollow,
  writeExclusiveFile,
} from "./fs-guard.js";
import { insertMissingOwnedKeys } from "./owned-keys.js";
import {
  getPersistentRuntimeDir,
  isEphemeralRuntimeDir,
  isSameRuntimeDir,
  stagePersistentRuntime,
} from "./runtime-stage.js";
import {
  readCodexMcpServer,
  removeCodexMcpServer,
  upsertCodexMcpServer,
} from "./toml-patch.js";
import {
  CANONICAL_SKILL_NAMES,
  CausorynCliError,
  HOST_CLIENT_IDS,
  SETUP_TOOL_PROFILES,
  type HostClientId,
  type ParsedCodexMcpServer,
  type SetupAction,
  type SetupOptions,
  type SetupResult,
} from "./types.js";

/**
 * 4-host (`antigravity`, `claude-code`, `codex`, `zcode`) kurulum / kaldırma
 * sihirbazı (`causoryn setup`, K-021).
 */

interface FileWriteInstruction {
  readonly targetPath: string;
  readonly content: string;
  readonly createBackup: boolean;
  readonly defaultMode?: number;
}

function assertRegularOrAbsentTarget(filePath: string): boolean {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new CausorynCliError(
      "cli/io-error",
      `Could not read the target file status (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new CausorynCliError(
      "cli/io-error",
      `Refusing to write through a symbolic link for security reasons (CWE-59): ${filePath}`,
    );
  }
  if (!st.isFile()) {
    throw new CausorynCliError(
      "cli/io-error",
      `The target path is not a regular file: ${filePath}`,
    );
  }
  return true;
}

function assertConfigAndBackupTargetsSafe(targetPath: string): boolean {
  const existed = assertRegularOrAbsentTarget(targetPath);
  assertRegularOrAbsentTarget(`${targetPath}.causoryn.backup`);
  return existed;
}

/**
 * Uninstall removal of one installed skill. `skill-dir` removes the skill
 * directory (it holds only Causoryn's SKILL.md); `skill-file` removes only
 * SKILL.md and keeps the directory with the user's other files.
 */
interface FileRemoveInstruction {
  readonly targetPath: string;
  readonly mode: "skill-dir" | "skill-file";
  readonly skillName: string;
  readonly expectedContent: string | null;
}

interface PlannedExecution {
  readonly selectedClients: readonly HostClientId[];
  readonly noClientsDetected: boolean;
  readonly needsRuntimeStage: boolean;
  readonly targetRuntimeDir: string;
  readonly actions: readonly SetupAction[];
  readonly writes: readonly FileWriteInstruction[];
  readonly removals: readonly FileRemoveInstruction[];
  readonly projectedConfigs: ReadonlyMap<string, string>;
  /** Home and explicitly configured host directories (CWE-59 trust bases). */
  readonly trustedBases: readonly string[];
}

type InstalledSkillState =
  | { readonly state: "absent" }
  | { readonly state: "owned"; readonly onlySkillFile: boolean }
  | { readonly state: "foreign"; readonly reason: string };

/**
 * True when an installed SKILL.md was written by Causoryn: it equals the
 * packaged skill, or its front matter names this skill and it refers to
 * Causoryn (an older Causoryn version).
 */
function isCausorynSkillContent(
  content: string,
  skillName: string,
  expectedContent: string | null,
): boolean {
  if (expectedContent !== null && content === expectedContent) return true;
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontMatter === null) return false;
  const nameLine = /^name:[ \t]*["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/m.exec(frontMatter[1] ?? "");
  return nameLine?.[1] === skillName && /causoryn/i.test(content);
}

/** Classifies an installed skill directory without following links. */
function classifyInstalledSkill(
  skillDir: string,
  skillName: string,
  expectedContent: string | null,
  trustedBases: readonly string[],
): InstalledSkillState {
  let dirStat;
  try {
    dirStat = lstatSync(skillDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "foreign", reason: "could not be inspected" };
  }
  if (!isFreeOfLinkedComponents(skillDir, trustedBases)) {
    return { state: "foreign", reason: "is below a symbolic link or junction" };
  }
  if (dirStat.isSymbolicLink()) {
    return { state: "foreign", reason: "is a symbolic link or junction" };
  }
  if (!dirStat.isDirectory()) {
    return { state: "foreign", reason: "is not a directory" };
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  let fileStat;
  try {
    fileStat = lstatSync(skillFile);
  } catch {
    return { state: "foreign", reason: "has no SKILL.md" };
  }
  if (!fileStat.isFile()) {
    return { state: "foreign", reason: "has a SKILL.md that is not a regular file" };
  }
  if (!isCausorynSkillContent(readFileSync(skillFile, "utf8"), skillName, expectedContent)) {
    return { state: "foreign", reason: "has a SKILL.md that does not belong to Causoryn" };
  }
  const entries = readdirSync(skillDir);
  return { state: "owned", onlySkillFile: entries.length === 1 && entries[0] === "SKILL.md" };
}

/** Executes one planned skill removal, re-validating it first (no link is followed). */
function removeInstalledSkill(removal: FileRemoveInstruction, trustedBases: readonly string[]): void {
  const skillDir = removal.mode === "skill-dir" ? removal.targetPath : path.dirname(removal.targetPath);
  const current = classifyInstalledSkill(
    skillDir,
    removal.skillName,
    removal.expectedContent,
    trustedBases,
  );
  if (current.state !== "owned") return;
  unlinkSync(path.join(skillDir, "SKILL.md"));
  if (removal.mode === "skill-dir") {
    try {
      rmdirSync(skillDir);
    } catch (err) {
      // A file created meanwhile keeps the directory (never removed recursively).
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }
}

/** True when the persistent runtime directory is a real directory staged by Causoryn. */
function isOwnedRuntimeDir(runtimeDir: string, trustedBases: readonly string[]): boolean {
  if (!isFreeOfLinkedComponents(runtimeDir, trustedBases, { includeTarget: true })) return false;
  try {
    if (!lstatSync(runtimeDir).isDirectory()) return false;
    const manifestPath = path.join(runtimeDir, "package.json");
    if (!lstatSync(manifestPath).isFile()) return false;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return isPlainObject(manifest) && manifest["name"] === "causoryn";
  } catch {
    return false;
  }
}

function buildNoClientsDetectedMessage(uninstall: boolean): string {
  const command = uninstall ? "causoryn setup --uninstall" : "causoryn setup";
  return [
    "No supported MCP host was detected, so nothing was changed.",
    `Name the host explicitly (supported: ${HOST_CLIENT_IDS.join(", ")}), for example:`,
    `  ${command} --client claude-code`,
    `  ${command} --client codex --client zcode`,
    `  ${command} --all    (every supported host)`,
  ].join("\n");
}

/** Guidance returned (and printed by the CLI) when setup finds no host and no `--client` / `--all`. */
export const NO_CLIENTS_DETECTED_MESSAGE = buildNoClientsDetectedMessage(false);

/** Uninstall variant of {@link NO_CLIENTS_DETECTED_MESSAGE}. */
export const NO_CLIENTS_DETECTED_UNINSTALL_MESSAGE = buildNoClientsDetectedMessage(true);

export function resolveDefaultPackageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function resolveEffectiveHomeDir(explicitHomeDir?: string): string {
  if (explicitHomeDir !== undefined && explicitHomeDir.trim().length > 0) {
    return path.resolve(explicitHomeDir);
  }
  const envHome = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (envHome !== undefined && envHome.trim().length > 0) {
    return path.resolve(envHome);
  }
  return path.resolve(os.homedir());
}

export function resolveEffectiveCodexHomeDir(
  homeDir: string,
  explicitCodexHomeDir?: string,
  explicitHomeProvided = false,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitCodexHomeDir !== undefined && explicitCodexHomeDir.trim().length > 0) {
    return path.resolve(explicitCodexHomeDir);
  }
  if (!explicitHomeProvided || env !== process.env) {
    const envCodex = env["CODEX_HOME"];
    if (envCodex !== undefined && envCodex.trim().length > 0) {
      return path.resolve(envCodex);
    }
  }
  return path.join(homeDir, ".codex");
}

export function resolveEffectiveClaudeConfigDir(
  explicitClaudeConfigDir?: string,
  explicitHomeProvided = false,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicitClaudeConfigDir !== undefined && explicitClaudeConfigDir.trim().length > 0) {
    return path.resolve(explicitClaudeConfigDir);
  }
  if (!explicitHomeProvided || env !== process.env) {
    const envClaude = env["CLAUDE_CONFIG_DIR"];
    if (envClaude !== undefined && envClaude.trim().length > 0) {
      return path.resolve(envClaude);
    }
  }
  return null;
}

export function getClaudeConfigFilePath(
  homeDir: string,
  claudeConfigDir?: string | null,
): string {
  return claudeConfigDir !== undefined && claudeConfigDir !== null
    ? path.join(claudeConfigDir, ".claude.json")
    : path.join(homeDir, ".claude.json");
}

export function getHostSkillsDir(
  homeDir: string,
  client: HostClientId,
  claudeConfigDir?: string | null,
): string {
  switch (client) {
    case "antigravity":
      return path.join(homeDir, ".gemini", "config", "skills");
    case "claude-code":
      return claudeConfigDir !== undefined && claudeConfigDir !== null
        ? path.join(claudeConfigDir, "skills")
        : path.join(homeDir, ".claude", "skills");
    case "codex":
      return path.join(homeDir, ".agents", "skills");
    case "zcode":
      return path.join(homeDir, ".zcode", "skills");
  }
}

export function detectInstalledClients(
  homeDir: string,
  codexHomeDir: string,
  claudeConfigDir?: string | null,
): HostClientId[] {
  const detected: HostClientId[] = [];
  // Detect Antigravity ONLY via real Antigravity markers — never bare ~/.gemini
  // (which causes false positives for Gemini CLI users).
  if (
    existsSync(path.join(homeDir, ".gemini", "antigravity")) ||
    existsSync(path.join(homeDir, ".gemini", "config", "mcp_config.json"))
  ) {
    detected.push("antigravity");
  }
  const claudeDetected =
    claudeConfigDir !== undefined && claudeConfigDir !== null
      ? existsSync(claudeConfigDir) || existsSync(path.join(claudeConfigDir, ".claude.json"))
      : existsSync(path.join(homeDir, ".claude.json")) || existsSync(path.join(homeDir, ".claude"));
  if (claudeDetected) {
    detected.push("claude-code");
  }
  if (
    existsSync(codexHomeDir) ||
    existsSync(path.join(codexHomeDir, "config.toml"))
  ) {
    detected.push("codex");
  }
  if (
    existsSync(path.join(homeDir, ".zcode")) ||
    existsSync(path.join(homeDir, ".zcode", "cli", "config.json"))
  ) {
    detected.push("zcode");
  }
  return detected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectStrict(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `Malformed JSON configuration file (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The JSON root value must be an object (${filePath})`,
    );
  }
  return parsed;
}

function resolveSkillsSourceDir(packageRoot: string): string {
  const inPkg = path.join(packageRoot, "skills");
  if (existsSync(path.join(inPkg, "causoryn", "SKILL.md"))) {
    return inPkg;
  }
  const repoCandidate = path.join(path.dirname(path.dirname(packageRoot)), "skills");
  if (existsSync(path.join(repoCandidate, "causoryn", "SKILL.md"))) {
    return repoCandidate;
  }
  return inPkg;
}

/**
 * Validates and normalizes a `--tool-profile` value (`core`, `full`, `wiki`,
 * `history` or a comma list; duplicates removed, order kept), mirroring
 * `parseToolProfile` of `@causoryn/mcp-server`.
 */
export function normalizeSetupToolProfile(raw: string): string {
  const supported = SETUP_TOOL_PROFILES.join(", ");
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CausorynCliError(
      "cli/invalid-arguments",
      `--tool-profile cannot be empty. Supported values: ${supported} (or a comma-separated combination such as wiki,history)`,
    );
  }
  const profiles: string[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!(SETUP_TOOL_PROFILES as readonly string[]).includes(token)) {
      throw new CausorynCliError(
        "cli/invalid-arguments",
        `Invalid --tool-profile value "${token}". Supported values: ${supported} (or a comma-separated combination such as wiki,history)`,
      );
    }
    if (!profiles.includes(token)) {
      profiles.push(token);
    }
  }
  return profiles.join(",");
}

const TOOL_PROFILE_FLAG = "--tool-profile";
const OUTPUT_SCHEMA_FLAGS: ReadonlySet<string> = new Set([
  "--output-schema",
  "--output-schema-profile",
]);

/**
 * `causoryn mcp` arguments a user may add to a Causoryn entry by hand (the
 * installed skills tell them to). Re-running setup keeps them verbatim, in the
 * user's spelling (`--flag value` or `--flag=value`); the last occurrence wins,
 * as in the server's own argument parser.
 */
interface PreservedMcpArgs {
  readonly toolProfile: readonly string[];
  readonly outputSchema: readonly string[];
}

const NO_PRESERVED_MCP_ARGS: PreservedMcpArgs = { toolProfile: [], outputSchema: [] };

function extractPreservedMcpArgs(existingArgs: unknown): PreservedMcpArgs {
  if (!Array.isArray(existingArgs)) {
    return NO_PRESERVED_MCP_ARGS;
  }
  let toolProfile: readonly string[] = [];
  let outputSchema: readonly string[] = [];
  for (let i = 0; i < existingArgs.length; i += 1) {
    const token: unknown = existingArgs[i];
    if (typeof token !== "string") continue;
    const eqIdx = token.indexOf("=");
    const flag = token.startsWith("--") && eqIdx > 0 ? token.slice(0, eqIdx) : token;
    const isToolProfile = flag === TOOL_PROFILE_FLAG;
    if (!isToolProfile && !OUTPUT_SCHEMA_FLAGS.has(flag)) continue;
    let captured: readonly string[];
    if (flag !== token) {
      captured = [token];
    } else {
      const next: unknown = existingArgs[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        captured = [token, next];
        i += 1;
      } else {
        captured = [token];
      }
    }
    if (isToolProfile) {
      toolProfile = captured;
    } else {
      outputSchema = captured;
    }
  }
  return { toolProfile, outputSchema };
}

interface McpArgsCustomization {
  /** Normalized `--tool-profile` value from the setup flag; overrides the preserved one. */
  readonly toolProfile?: string | undefined;
  readonly preserved: PreservedMcpArgs;
}

function buildMcpArgs(
  cliScriptPath: string,
  client: HostClientId,
  customization: McpArgsCustomization,
): string[] {
  const { toolProfile, preserved } = customization;
  return [
    cliScriptPath,
    "mcp",
    "--allow-cwd",
    "--auto-data-dir",
    "--client",
    client,
    ...(toolProfile !== undefined ? [TOOL_PROFILE_FLAG, toolProfile] : preserved.toolProfile),
    ...preserved.outputSchema,
  ];
}

/**
 * Keys of a Causoryn server entry that `causoryn setup` owns. Setup rewrites
 * only these; every other key of an existing entry belongs to the user or the
 * host (for example `disabled`, `autoApprove`, `alwaysAllow`, `timeout`, `env`
 * or any unknown key) and is kept with its value and position.
 *
 * - JSON hosts: `command`, `args` and, for Claude Code and ZCode, `type`
 *   (always "stdio"; Antigravity entries get no `type`, so a user-added one
 *   is kept). In `args`, user-added `--tool-profile` / `--output-schema`
 *   arguments are carried over (see {@link extractPreservedMcpArgs}). `env`
 *   is not owned (Causoryn writes no env keys) but must be a JSON object.
 * - Codex TOML `[mcp_servers.causoryn]`: `command`, `args` and
 *   `startup_timeout_sec` (a user value of at least
 *   {@link CODEX_MIN_STARTUP_TIMEOUT_SEC} is kept, a lower or unusable one is
 *   replaced, and the setup output says so). The user's env keys (inline
 *   `env = {...}`, dotted `env.KEY` or the env sub-table) are kept but always
 *   written as the `[mcp_servers.causoryn.env]` sub-table. Other keys,
 *   comments and `[mcp_servers.causoryn.*]` sub-tables are kept verbatim
 *   (see `upsertCodexMcpServer`).
 *
 * Owned keys missing from an existing entry are inserted where a fresh entry
 * would have them, so an up-to-date entry is byte-identical after a re-run.
 */
const JSON_OWNED_ENTRY_KEYS_WITH_TYPE = ["type", "command", "args"] as const;
const JSON_OWNED_ENTRY_KEYS_WITHOUT_TYPE = ["command", "args"] as const;

/** Minimum Codex `startup_timeout_sec` setup accepts; a lower user value is raised to it. */
const CODEX_MIN_STARTUP_TIMEOUT_SEC = 30;

/**
 * Validates the `env` of an existing JSON Causoryn entry: setup keeps it as
 * is, and a non-object `env` is rejected instead of being silently kept or
 * dropped.
 */
function assertExistingJsonEntryEnv(
  existingEntry: Record<string, unknown>,
  fieldPath: string,
  targetPath: string,
): void {
  const env = existingEntry["env"];
  if (env !== undefined && !isPlainObject(env)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "${fieldPath}.env" field must be a JSON object (${targetPath})`,
    );
  }
}

function buildJsonCausorynEntry(params: {
  readonly includeStdioType: boolean;
  readonly nodeExecutable: string;
  readonly cliScriptPath: string;
  readonly client: HostClientId;
  readonly toolProfile: string | undefined;
  readonly existingEntry: unknown;
  readonly fieldPath: string;
  readonly targetPath: string;
}): Record<string, unknown> {
  const existing = isPlainObject(params.existingEntry) ? params.existingEntry : undefined;
  if (existing !== undefined) {
    assertExistingJsonEntryEnv(existing, params.fieldPath, params.targetPath);
  }
  const ownedKeys: readonly string[] = params.includeStdioType
    ? JSON_OWNED_ENTRY_KEYS_WITH_TYPE
    : JSON_OWNED_ENTRY_KEYS_WITHOUT_TYPE;
  const ownedValues = new Map<string, unknown>([
    ["type", "stdio"],
    ["command", params.nodeExecutable],
    [
      "args",
      buildMcpArgs(params.cliScriptPath, params.client, {
        toolProfile: params.toolProfile,
        preserved: extractPreservedMcpArgs(existing?.["args"]),
      }),
    ],
  ]);
  // Owned values are replaced in place; every other key is kept as is.
  const entries = insertMissingOwnedKeys(
    Object.entries(existing ?? {}).map(([key, value]): [string, unknown] =>
      ownedKeys.includes(key) ? [key, ownedValues.get(key)] : [key, value],
    ),
    ([key]) => (ownedKeys.includes(key) ? key : null),
    ownedKeys,
    (key): [string, unknown] => [key, ownedValues.get(key)],
  );
  // Object.fromEntries defines own properties, so a "__proto__" key stays a key.
  return Object.fromEntries(entries);
}

function planMcpServersJsonFile(params: {
  readonly client: "antigravity" | "claude-code";
  readonly targetPath: string;
  readonly nodeExecutable: string;
  readonly cliScriptPath: string;
  readonly toolProfile: string | undefined;
  readonly uninstall: boolean;
  readonly includeStdioType: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const {
    client,
    targetPath,
    nodeExecutable,
    cliScriptPath,
    toolProfile,
    uninstall,
    includeStdioType,
    actions,
    writes,
    projectedConfigs,
  } = params;

  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  let existingRaw: string | null = null;
  let doc: Record<string, unknown> = {};
  if (existed) {
    existingRaw = readFileSync(targetPath, "utf8");
    doc = parseJsonObjectStrict(existingRaw, targetPath);
  }

  const existingServersRaw = doc["mcpServers"];
  if (existingServersRaw !== undefined && !isPlainObject(existingServersRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcpServers" field must be a JSON object (${targetPath})`,
    );
  }
  const servers: Record<string, unknown> = existingServersRaw
    ? { ...existingServersRaw }
    : {};

  if (uninstall) {
    if (!existed || !("causoryn" in servers)) {
      actions.push({
        client,
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: no causoryn MCP entry to remove",
      });
      return;
    }
    delete servers["causoryn"];
    const nextDoc: Record<string, unknown> = {
      ...doc,
      mcpServers: servers,
    };
    const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
    if (existingRaw === nextRaw) {
      projectedConfigs.set(path.resolve(targetPath), existingRaw);
      actions.push({
        client,
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: mcpServers.causoryn already removed",
      });
      return;
    }
    writes.push({ targetPath, content: nextRaw, createBackup: true, defaultMode: 0o600 });
    projectedConfigs.set(path.resolve(targetPath), nextRaw);
    actions.push({
      client,
      kind: "mcp-config",
      operation: "remove",
      targetPath,
      backupPath: `${targetPath}.causoryn.backup`,
      detail: "removed mcpServers.causoryn",
    });
    return;
  }

  servers["causoryn"] = buildJsonCausorynEntry({
    includeStdioType,
    nodeExecutable,
    cliScriptPath,
    client,
    toolProfile,
    existingEntry: servers["causoryn"],
    fieldPath: "mcpServers.causoryn",
    targetPath,
  });
  const nextDoc: Record<string, unknown> = {
    ...doc,
    mcpServers: servers,
  };
  const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
  if (existed && existingRaw === nextRaw) {
    projectedConfigs.set(path.resolve(targetPath), existingRaw);
    actions.push({
      client,
      kind: "mcp-config",
      operation: "noop",
      targetPath,
      backupPath: null,
      detail: "unchanged: mcpServers.causoryn is already up to date",
    });
    return;
  }
  writes.push({ targetPath, content: nextRaw, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), nextRaw);
  actions.push({
    client,
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: "configured mcpServers.causoryn",
  });
}

function planZcodeMcpConfig(params: {
  readonly homeDir: string;
  readonly nodeExecutable: string;
  readonly cliScriptPath: string;
  readonly toolProfile: string | undefined;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const {
    homeDir,
    nodeExecutable,
    cliScriptPath,
    toolProfile,
    uninstall,
    actions,
    writes,
    projectedConfigs,
  } = params;
  const targetPath = path.join(homeDir, ".zcode", "cli", "config.json");
  const fallbackPath = path.join(homeDir, ".agents", "mcp.json");

  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  let existingRaw: string | null = null;
  let doc: Record<string, unknown> = {};
  if (existed) {
    existingRaw = readFileSync(targetPath, "utf8");
    doc = parseJsonObjectStrict(existingRaw, targetPath);
  }

  const mcpRaw = doc["mcp"];
  if (mcpRaw !== undefined && !isPlainObject(mcpRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcp" field must be a JSON object (${targetPath})`,
    );
  }
  const mcpObj: Record<string, unknown> = mcpRaw ? { ...mcpRaw } : {};

  const serversRaw = mcpObj["servers"];
  if (serversRaw !== undefined && !isPlainObject(serversRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcp.servers" field must be a JSON object (${targetPath})`,
    );
  }
  const hadServersDefined = isPlainObject(serversRaw);
  const servers: Record<string, unknown> = hadServersDefined ? { ...serversRaw } : {};

  if (uninstall) {
    if (!existed || !("causoryn" in servers)) {
      actions.push({
        client: "zcode",
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: no ZCode mcp.servers.causoryn entry to remove",
      });
      return;
    }
    delete servers["causoryn"];
    let nextMcp: Record<string, unknown> | undefined;
    if (Object.keys(servers).length === 0) {
      delete mcpObj["servers"];
      nextMcp = Object.keys(mcpObj).length > 0 ? mcpObj : undefined;
    } else {
      nextMcp = { ...mcpObj, servers };
    }
    const nextDoc: Record<string, unknown> = { ...doc };
    if (nextMcp === undefined) {
      delete nextDoc["mcp"];
    } else {
      nextDoc["mcp"] = nextMcp;
    }
    const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
    if (existingRaw === nextRaw) {
      projectedConfigs.set(path.resolve(targetPath), existingRaw);
      actions.push({
        client: "zcode",
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: ZCode mcp.servers.causoryn already removed",
      });
      return;
    }
    writes.push({ targetPath, content: nextRaw, createBackup: true, defaultMode: 0o600 });
    projectedConfigs.set(path.resolve(targetPath), nextRaw);
    actions.push({
      client: "zcode",
      kind: "mcp-config",
      operation: "remove",
      targetPath,
      backupPath: `${targetPath}.causoryn.backup`,
      detail: "removed ZCode mcp.servers.causoryn",
    });
    return;
  }

  // ZCode fallback kuralı: mcp.servers ilk kez oluşturuluyorsa ~/.agents/mcp.json
  // altındaki mevcut mcpServers kayıtlarını ezmeden taşı!
  if (!hadServersDefined && existsSync(fallbackPath)) {
    const fallbackDoc = parseJsonObjectStrict(readFileSync(fallbackPath, "utf8"), fallbackPath);
    const fallbackServers = fallbackDoc["mcpServers"];
    if (fallbackServers !== undefined && !isPlainObject(fallbackServers)) {
      throw new CausorynCliError(
        "cli/malformed-json",
        `The "mcpServers" field must be a JSON object (${fallbackPath})`,
      );
    }
    if (isPlainObject(fallbackServers)) {
      for (const [name, entry] of Object.entries(fallbackServers)) {
        if (name === "causoryn") continue;
        if (isPlainObject(entry)) {
          const normalized =
            typeof entry["command"] === "string" && entry["type"] === undefined
              ? { type: "stdio", ...entry }
              : { ...entry };
          servers[name] = normalized;
        } else {
          servers[name] = entry;
        }
      }
    }
  }

  servers["causoryn"] = buildJsonCausorynEntry({
    includeStdioType: true,
    nodeExecutable,
    cliScriptPath,
    client: "zcode",
    toolProfile,
    existingEntry: servers["causoryn"],
    fieldPath: "mcp.servers.causoryn",
    targetPath,
  });

  const nextDoc: Record<string, unknown> = {
    ...doc,
    mcp: {
      ...mcpObj,
      servers,
    },
  };
  const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
  if (existed && existingRaw === nextRaw) {
    projectedConfigs.set(path.resolve(targetPath), existingRaw);
    actions.push({
      client: "zcode",
      kind: "mcp-config",
      operation: "noop",
      targetPath,
      backupPath: null,
      detail: "unchanged: mcp.servers.causoryn is already up to date",
    });
    return;
  }
  writes.push({ targetPath, content: nextRaw, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), nextRaw);
  actions.push({
    client: "zcode",
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: !hadServersDefined && existsSync(fallbackPath)
      ? "configured mcp.servers.causoryn (kept the fallback servers from ~/.agents/mcp.json)"
      : "configured mcp.servers.causoryn",
  });
}

function planCodexMcpConfig(params: {
  readonly codexHomeDir: string;
  readonly nodeExecutable: string;
  readonly cliScriptPath: string;
  readonly toolProfile: string | undefined;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const {
    codexHomeDir,
    nodeExecutable,
    cliScriptPath,
    toolProfile,
    uninstall,
    actions,
    writes,
    projectedConfigs,
  } = params;
  const targetPath = path.join(codexHomeDir, "config.toml");
  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  const existingRaw = existed ? readFileSync(targetPath, "utf8") : "";

  if (uninstall) {
    if (!existed) {
      actions.push({
        client: "codex",
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: Codex config.toml does not exist",
      });
      return;
    }
    const removed = removeCodexMcpServer(existingRaw);
    if (!removed.removed) {
      actions.push({
        client: "codex",
        kind: "mcp-config",
        operation: "noop",
        targetPath,
        backupPath: null,
        detail: "unchanged: no [mcp_servers.causoryn] table to remove",
      });
      return;
    }
    writes.push({ targetPath, content: removed.content, createBackup: true, defaultMode: 0o600 });
    projectedConfigs.set(path.resolve(targetPath), removed.content);
    actions.push({
      client: "codex",
      kind: "mcp-config",
      operation: "remove",
      targetPath,
      backupPath: `${targetPath}.causoryn.backup`,
      detail: "removed [mcp_servers.causoryn]",
    });
    return;
  }

  // Keep the user's --tool-profile / --output-schema arguments, env keys
  // (inline `env = {...}`, dotted `env.KEY` or the env sub-table), a
  // sufficient startup_timeout_sec and every key Causoryn does not own.
  const existingEntry = existed ? readCodexMcpServer(existingRaw) : null;
  const timeout = resolveCodexStartupTimeout(existingEntry);
  const updated = upsertCodexMcpServer(existingRaw, {
    command: nodeExecutable,
    args: buildMcpArgs(cliScriptPath, "codex", {
      toolProfile,
      preserved: extractPreservedMcpArgs(existingEntry?.args),
    }),
    startupTimeoutSec: timeout.seconds,
    ...(existingEntry !== null && Object.keys(existingEntry.env).length > 0
      ? { env: existingEntry.env }
      : {}),
  });
  if (existed && existingRaw === updated) {
    projectedConfigs.set(path.resolve(targetPath), existingRaw);
    actions.push({
      client: "codex",
      kind: "mcp-config",
      operation: "noop",
      targetPath,
      backupPath: null,
      detail: "unchanged: [mcp_servers.causoryn] is already up to date",
    });
    return;
  }
  writes.push({ targetPath, content: updated, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), updated);
  actions.push({
    client: "codex",
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: `configured [mcp_servers.causoryn] (${timeout.note})`,
  });
}

/**
 * `startup_timeout_sec` written for Codex: the user's value when it is at
 * least {@link CODEX_MIN_STARTUP_TIMEOUT_SEC}, otherwise the minimum. `note`
 * tells the user what happened to their value.
 */
function resolveCodexStartupTimeout(existingEntry: ParsedCodexMcpServer | null): {
  readonly seconds: number;
  readonly note: string;
} {
  const minimum = CODEX_MIN_STARTUP_TIMEOUT_SEC;
  const raw = existingEntry?.startupTimeoutSecRaw;
  const userValue = existingEntry?.startupTimeoutSec ?? null;
  if (userValue !== null && userValue >= minimum) {
    return { seconds: userValue, note: `kept startup_timeout_sec = ${raw ?? String(userValue)}` };
  }
  if (userValue !== null) {
    return {
      seconds: minimum,
      note: `raised startup_timeout_sec from ${raw ?? String(userValue)} to the required minimum of ${String(minimum)}`,
    };
  }
  if (raw !== undefined) {
    return {
      seconds: minimum,
      note: `replaced the unusable startup_timeout_sec value ${raw} with ${String(minimum)}`,
    };
  }
  return { seconds: minimum, note: `startup_timeout_sec = ${String(minimum)}` };
}

function readSourceSkillFileSync(srcSkillFile: string): string {
  let fd: number;
  try {
    // O_NOFOLLOW bilinçli olarak eklenmez: symlink'li npm/pnpm kurulumları desteklenir.
    fd = openSync(srcSkillFile, fsConstants.O_RDONLY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      throw new CausorynCliError(
        "cli/io-error",
        `Source skill file not found: ${srcSkillFile}`,
      );
    }
    throw new CausorynCliError(
      "cli/io-error",
      `Could not read the source skill file (${srcSkillFile}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new CausorynCliError(
        "cli/io-error",
        `Source skill file not found: ${srcSkillFile}`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Kapatma hatası yoksayılır.
    }
  }
}

function planSkillsForClient(params: {
  readonly homeDir: string;
  readonly claudeConfigDir: string | null;
  readonly client: HostClientId;
  readonly skillsSourceDir: string;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly removals: FileRemoveInstruction[];
  readonly trustedBases: readonly string[];
}): void {
  const {
    homeDir,
    claudeConfigDir,
    client,
    skillsSourceDir,
    uninstall,
    actions,
    writes,
    removals,
    trustedBases,
  } = params;
  const hostSkillsRoot = getHostSkillsDir(homeDir, client, claudeConfigDir);

  for (const skillName of CANONICAL_SKILL_NAMES) {
    const destSkillDir = path.join(hostSkillsRoot, skillName);
    const destSkillFile = path.join(destSkillDir, "SKILL.md");

    if (uninstall) {
      // Remove only what Causoryn installed; never follow links.
      let expectedContent: string | null = null;
      try {
        expectedContent = readSourceSkillFileSync(path.join(skillsSourceDir, skillName, "SKILL.md"));
      } catch {
        expectedContent = null;
      }
      const installed = classifyInstalledSkill(destSkillDir, skillName, expectedContent, trustedBases);
      if (installed.state === "owned") {
        removals.push({
          targetPath: installed.onlySkillFile ? destSkillDir : destSkillFile,
          mode: installed.onlySkillFile ? "skill-dir" : "skill-file",
          skillName,
          expectedContent,
        });
        actions.push({
          client,
          kind: "skill",
          operation: "remove",
          targetPath: destSkillFile,
          backupPath: null,
          detail: installed.onlySkillFile
            ? `removed skill ${skillName}`
            : `removed skill ${skillName} (kept the directory: it contains other files)`,
        });
      } else if (installed.state === "foreign") {
        actions.push({
          client,
          kind: "skill",
          operation: "noop",
          targetPath: destSkillFile,
          backupPath: null,
          detail: `kept ${destSkillDir}: not created by Causoryn (it ${installed.reason})`,
        });
      }
      continue;
    }

    const srcSkillFile = path.join(skillsSourceDir, skillName, "SKILL.md");
    const content = readSourceSkillFileSync(srcSkillFile);
    const existed = assertRegularOrAbsentTarget(destSkillFile);
    if (existed && readFileSync(destSkillFile, "utf8") === content) {
      actions.push({
        client,
        kind: "skill",
        operation: "noop",
        targetPath: destSkillFile,
        backupPath: null,
        detail: `unchanged: skill ${skillName} is already up to date`,
      });
      continue;
    }
    writes.push({ targetPath: destSkillFile, content, createBackup: false, defaultMode: 0o644 });
    actions.push({
      client,
      kind: "skill",
      operation: existed ? "update" : "create",
      targetPath: destSkillFile,
      backupPath: null,
      detail: `installed skill ${skillName}`,
    });
  }
}

function normalizePathSlashes(value: string): string {
  const normalized = value.replace(/[\\/]+/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function jsonContainsMarker(node: unknown, marker: string): boolean {
  if (typeof node === "string") {
    return normalizePathSlashes(node).includes(marker);
  }
  if (Array.isArray(node)) {
    return node.some((item) => jsonContainsMarker(item, marker));
  }
  if (isPlainObject(node)) {
    return Object.values(node).some((val) => jsonContainsMarker(val, marker));
  }
  return false;
}

function anyRemainingHostReferencesRuntime(params: {
  readonly homeDir: string;
  readonly codexHomeDir: string;
  readonly claudeConfigDir: string | null;
  readonly runtimeDir: string;
  readonly projectedConfigs: ReadonlyMap<string, string>;
}): boolean {
  const { homeDir, codexHomeDir, claudeConfigDir, runtimeDir, projectedConfigs } = params;
  const runtimeMarker = normalizePathSlashes(path.resolve(runtimeDir));

  const readEffective = (filePath: string): string | null => {
    const resolved = path.resolve(filePath);
    if (projectedConfigs.has(resolved)) {
      return projectedConfigs.get(resolved) ?? null;
    }
    if (!existsSync(resolved)) return null;
    try {
      return readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  };

  const jsonFiles = [
    path.join(homeDir, ".gemini", "config", "mcp_config.json"),
    path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"),
    getClaudeConfigFilePath(homeDir, claudeConfigDir),
    path.join(homeDir, ".zcode", "cli", "config.json"),
  ];

  for (const jsonPath of jsonFiles) {
    const raw = readEffective(jsonPath);
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (jsonContainsMarker(parsed, runtimeMarker)) {
        return true;
      }
    } catch {
      if (normalizePathSlashes(raw).includes(runtimeMarker)) {
        return true;
      }
    }
  }

  const codexTomlRaw = readEffective(path.join(codexHomeDir, "config.toml"));
  if (codexTomlRaw !== null) {
    try {
      const parsed = readCodexMcpServer(codexTomlRaw);
      if (parsed !== null) {
        const joined = [parsed.command, ...parsed.args].map(normalizePathSlashes).join(" ");
        if (joined.includes(runtimeMarker)) return true;
      }
    } catch {
      if (normalizePathSlashes(codexTomlRaw).includes(runtimeMarker)) return true;
    }
  }

  return false;
}

function atomicWriteFile(
  destPath: string,
  data: string | Buffer,
  mode: number,
  suffix: string,
  renameFn: typeof renameSync = renameSync,
): void {
  const tmpPath = `${destPath}.causoryn.${suffix}.tmp`;
  let renamed = false;
  try {
    // "wx": an entry planted at the temporary name is never followed or reused.
    writeExclusiveFile(tmpPath, data, mode);
    if (process.platform !== "win32") {
      chmodSync(tmpPath, mode);
    }
    renameFn(tmpPath, destPath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort cleanup of temp file on write/rename failure.
      }
    }
  }
}

/**
 * Writes a backup that never replaces an existing file: the bytes go to an
 * exclusive temporary file first and are then published without clobbering.
 * Returns false when `backupPath` already exists (nothing is written).
 */
function writeBackupNoClobber(
  backupPath: string,
  data: Buffer,
  mode: number,
  suffix: string,
): boolean {
  const tmpPath = `${backupPath}.${suffix}.tmp`;
  try {
    writeExclusiveFile(tmpPath, data, mode);
    if (process.platform !== "win32") {
      chmodSync(tmpPath, mode);
    }
    return publishFileNoClobber(tmpPath, backupPath);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup of the temporary backup file.
    }
  }
}

function writeFileAtomicWithBackup(
  instruction: FileWriteInstruction,
  trustedBases: readonly string[],
  renameFn: typeof renameSync = renameSync,
): void {
  const { targetPath, content, createBackup, defaultMode = 0o600 } = instruction;
  const parentDir = path.dirname(targetPath);
  // CWE-59: no component below the home / configured host directory may be a
  // link; checked before and after creating missing parent directories.
  assertSafeWritePath(targetPath, trustedBases);
  mkdirSync(parentDir, { recursive: true });
  assertSafeWritePath(targetPath, trustedBases);

  const existed = assertRegularOrAbsentTarget(targetPath);
  const originalBytes = existed ? readFileSync(targetPath) : null;
  if (originalBytes !== null && originalBytes.equals(Buffer.from(content, "utf8"))) {
    // Defense-in-depth idempotency: never write or touch backups when bytes match.
    return;
  }

  const effectiveMode = existed ? (statSync(targetPath).mode & 0o777) || defaultMode : defaultMode;
  const nonce = randomBytes(4).toString("hex");
  const suffix = `${String(process.pid)}-${String(Date.now())}-${nonce}`;

  if (createBackup && existed && originalBytes !== null) {
    const primaryBackupPath = `${targetPath}.causoryn.backup`;
    const primaryBackupExisted = assertRegularOrAbsentTarget(primaryBackupPath);
    // First-time backup preserves the user's original pre-Causoryn config forever;
    // it is published without clobbering, so a concurrent writer cannot replace it.
    const wrotePrimary =
      !primaryBackupExisted &&
      writeBackupNoClobber(primaryBackupPath, originalBytes, effectiveMode, `bk-${suffix}`);
    if (!wrotePrimary) {
      // NEVER overwrite the original .causoryn.backup; write a secondary timestamped backup instead.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const secondaryBackupPath = `${targetPath}.causoryn.${stamp}-${nonce}.backup`;
      assertRegularOrAbsentTarget(secondaryBackupPath);
      if (!writeBackupNoClobber(secondaryBackupPath, originalBytes, effectiveMode, `bk2-${suffix}`)) {
        throw new CausorynCliError(
          "cli/io-error",
          `Refusing to overwrite an existing backup file: ${secondaryBackupPath}`,
        );
      }
    }
  }

  atomicWriteFile(targetPath, content, effectiveMode, suffix, renameFn);
}

export type ExtendedSetupOptions = SetupOptions & {
  readonly claudeConfigDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly all?: boolean | undefined;
  readonly nodeExecutable?: string | undefined;
  readonly renameFile?: typeof renameSync | undefined;
};

export type ExtendedSetupResult = SetupResult & {
  readonly message?: string | undefined;
};

function buildExecutionPlan(options: ExtendedSetupOptions): {
  readonly homeDir: string;
  readonly codexHomeDir: string;
  readonly claudeConfigDir: string | null;
  readonly packageRoot: string;
  readonly plan: PlannedExecution;
} {
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
  const uninstall = options.uninstall === true;
  const installSkills = options.installSkills ?? true;
  const nodeExecutable =
    options.nodeExecutable !== undefined && options.nodeExecutable.trim().length > 0
      ? options.nodeExecutable.trim()
      : process.execPath;

  let toolProfile: string | undefined;
  if (options.toolProfile !== undefined) {
    if (uninstall) {
      throw new CausorynCliError(
        "cli/invalid-arguments",
        "--tool-profile cannot be combined with --uninstall",
      );
    }
    toolProfile = normalizeSetupToolProfile(options.toolProfile);
  }

  // Host selection: --client > --all > detected hosts. `allDetected` (--all-detected)
  // is an explicit alias of the default and selects the detected hosts as well.
  let selectedClients: HostClientId[];
  let noClientsDetected = false;
  if (options.clients !== undefined && options.clients.length > 0) {
    selectedClients = [...new Set(options.clients)];
  } else if (options.all === true) {
    selectedClients = [...HOST_CLIENT_IDS];
  } else {
    selectedClients = detectInstalledClients(homeDir, codexHomeDir, claudeConfigDir);
    noClientsDetected = selectedClients.length === 0;
  }

  // CWE-59 trust bases: the home directory plus host config directories the
  // user configured explicitly (they may themselves be links; resolved once).
  const trustedBases: string[] = [homeDir];
  if (claudeConfigDir !== null) trustedBases.push(claudeConfigDir);
  if (path.relative(path.join(homeDir, ".codex"), codexHomeDir) !== "") trustedBases.push(codexHomeDir);

  const targetRuntimeDir = getPersistentRuntimeDir(homeDir);
  const needsRuntimeStage =
    !uninstall &&
    selectedClients.length > 0 &&
    !isSameRuntimeDir(packageRoot, targetRuntimeDir) &&
    isEphemeralRuntimeDir(packageRoot, { tmpDir: options.ephemeralTmpDir });

  const effectiveRuntimePkg = needsRuntimeStage ? targetRuntimeDir : packageRoot;
  const cliScriptPath = path.join(effectiveRuntimePkg, "scripts", "causoryn.mjs");
  const skillsSourceDir = resolveSkillsSourceDir(packageRoot);

  const actions: SetupAction[] = [];
  const writes: FileWriteInstruction[] = [];
  const removals: FileRemoveInstruction[] = [];
  const projectedConfigs = new Map<string, string>();

  for (const client of selectedClients) {
    switch (client) {
      case "antigravity": {
        const primaryPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        planMcpServersJsonFile({
          client: "antigravity",
          targetPath: primaryPath,
          nodeExecutable,
          cliScriptPath,
          toolProfile,
          uninstall,
          includeStdioType: false,
          actions,
          writes,
          projectedConfigs,
        });
        const secondaryPath = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
        let secondaryPresent = false;
        try {
          lstatSync(secondaryPath);
          secondaryPresent = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new CausorynCliError(
              "cli/io-error",
              `Could not read the target file status (${secondaryPath}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (secondaryPresent) {
          planMcpServersJsonFile({
            client: "antigravity",
            targetPath: secondaryPath,
            nodeExecutable,
            cliScriptPath,
            toolProfile,
            uninstall,
            includeStdioType: false,
            actions,
            writes,
            projectedConfigs,
          });
        }
        break;
      }
      case "claude-code": {
        planMcpServersJsonFile({
          client: "claude-code",
          targetPath: getClaudeConfigFilePath(homeDir, claudeConfigDir),
          nodeExecutable,
          cliScriptPath,
          toolProfile,
          uninstall,
          includeStdioType: true,
          actions,
          writes,
          projectedConfigs,
        });
        break;
      }
      case "codex": {
        planCodexMcpConfig({
          codexHomeDir,
          nodeExecutable,
          cliScriptPath,
          toolProfile,
          uninstall,
          actions,
          writes,
          projectedConfigs,
        });
        break;
      }
      case "zcode": {
        planZcodeMcpConfig({
          homeDir,
          nodeExecutable,
          cliScriptPath,
          toolProfile,
          uninstall,
          actions,
          writes,
          projectedConfigs,
        });
        break;
      }
    }

    if (installSkills) {
      planSkillsForClient({
        homeDir,
        claudeConfigDir,
        client,
        skillsSourceDir,
        uninstall,
        actions,
        writes,
        removals,
        trustedBases,
      });
    }
  }

  // Fail before any mutation (and in --dry-run) when a planned write would go
  // through a link below the home directory or a configured host directory.
  for (const writeOp of writes) {
    assertSafeWritePath(writeOp.targetPath, trustedBases);
  }

  return {
    homeDir,
    codexHomeDir,
    claudeConfigDir,
    packageRoot,
    plan: {
      selectedClients,
      noClientsDetected,
      needsRuntimeStage,
      targetRuntimeDir,
      actions,
      writes,
      removals,
      projectedConfigs,
      trustedBases,
    },
  };
}

export async function runSetup(options: ExtendedSetupOptions = {}): Promise<ExtendedSetupResult> {
  const dryRun = options.dryRun === true;
  const uninstall = options.uninstall === true;
  const { homeDir, codexHomeDir, claudeConfigDir, packageRoot, plan } = buildExecutionPlan(options);
  const noClientsMsg = plan.noClientsDetected
    ? {
        noClientsDetected: true,
        message: uninstall ? NO_CLIENTS_DETECTED_UNINSTALL_MESSAGE : NO_CLIENTS_DETECTED_MESSAGE,
      }
    : {};

  if (dryRun) {
    return {
      dryRun: true,
      applied: false,
      uninstall,
      selectedClients: plan.selectedClients,
      stagedRuntimeDir: plan.needsRuntimeStage ? plan.targetRuntimeDir : null,
      runtimeCleanedUp: false,
      actions: plan.actions,
      ...noClientsMsg,
    };
  }

  const hasMutations =
    plan.needsRuntimeStage || plan.writes.length > 0 || plan.removals.length > 0;

  if (!hasMutations) {
    return {
      dryRun: false,
      applied: false,
      uninstall,
      selectedClients: plan.selectedClients,
      stagedRuntimeDir: null,
      runtimeCleanedUp: false,
      actions: plan.actions,
      ...noClientsMsg,
    };
  }

  const autoApprove = options.yes ?? true;
  if (!autoApprove) {
    if (options.confirm === undefined) {
      throw new CausorynCliError(
        "cli/confirmation-required",
        "Setup needs confirmation: pass `--yes` to apply the changes or `--dry-run` to preview them.",
      );
    }
    const approved = await options.confirm(plan.actions);
    if (!approved) {
      return {
        dryRun: false,
        applied: false,
        uninstall,
        selectedClients: plan.selectedClients,
        stagedRuntimeDir: null,
        runtimeCleanedUp: false,
        actions: plan.actions,
      };
    }
  }

  let stagedRuntimeDir: string | null = null;
  if (plan.needsRuntimeStage) {
    const staged = stagePersistentRuntime({
      homeDir,
      sourcePackageDir: packageRoot,
    });
    stagedRuntimeDir = staged.runtimeDir;
  }

  const renameFn = options.renameFile ?? renameSync;
  for (const writeOp of plan.writes) {
    writeFileAtomicWithBackup(writeOp, plan.trustedBases, renameFn);
  }

  for (const removeOp of plan.removals) {
    removeInstalledSkill(removeOp, plan.trustedBases);
  }

  let runtimeCleanedUp = false;
  // Only a real runtime directory staged by Causoryn is removed; a link (or
  // anything below a link) is left alone and nothing inside is followed.
  if (uninstall && isOwnedRuntimeDir(plan.targetRuntimeDir, plan.trustedBases)) {
    const stillReferenced = anyRemainingHostReferencesRuntime({
      homeDir,
      codexHomeDir,
      claudeConfigDir,
      runtimeDir: plan.targetRuntimeDir,
      projectedConfigs: plan.projectedConfigs,
    });
    if (!stillReferenced) {
      removeTreeNoFollow(plan.targetRuntimeDir);
      runtimeCleanedUp = true;
    }
  }

  return {
    dryRun: false,
    applied: true,
    uninstall,
    selectedClients: plan.selectedClients,
    stagedRuntimeDir,
    runtimeCleanedUp,
    actions: plan.actions,
  };
}
