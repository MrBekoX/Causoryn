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

import { describeJsonSyntaxError } from "./diagnostics.js";
import {
  assertPrivateDirectory,
  assertPrivateTree,
  assertSafeWritePath,
  copyFileNoClobber,
  isFreeOfLinkedComponents,
  publishFileNoClobber,
  readRegularFileText,
  removeTreeNoFollow,
  writeExclusiveFile,
  type TreeIdentity,
  type TreeRemovalFs,
} from "./fs-guard.js";
import { insertMissingOwnedKeys } from "./owned-keys.js";
import {
  classifySkillOwnership,
  sha256OfText,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTALL_RECORD_FILE,
  SkillInstallRecord,
} from "./skill-ownership.js";
import {
  getPersistentRuntimeDir,
  isAtOrBelowDir,
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
  type CanonicalSkillName,
  type CausorynCliErrorCode,
  type DirectoryOwnershipProbe,
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
  /** Mode of the parent directories setup creates (default: the process umask). */
  readonly dirMode?: number;
  /**
   * Skill files: SHA-256 of the file setup decided to replace, or null when
   * it was absent. The write is refused when the file changed since then.
   */
  readonly expectedCurrentSha256?: string | null;
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
  /** SHA-256 of the SKILL.md that was proven Causoryn's while planning; anything else is kept. */
  readonly expectedSha256: string;
}

/** New content of Causoryn's skill install record (null: remove the file). */
interface RecordUpdate {
  readonly path: string;
  readonly content: string | null;
}

interface PlannedExecution {
  readonly selectedClients: readonly HostClientId[];
  readonly noClientsDetected: boolean;
  readonly needsRuntimeStage: boolean;
  readonly targetRuntimeDir: string;
  readonly actions: readonly SetupAction[];
  readonly writes: readonly FileWriteInstruction[];
  readonly removals: readonly FileRemoveInstruction[];
  readonly recordUpdate: RecordUpdate | null;
  readonly projectedConfigs: ReadonlyMap<string, string>;
  /** Home and explicitly configured host directories (CWE-59 trust bases). */
  readonly trustedBases: readonly string[];
}

type InstalledSkillState =
  | { readonly state: "absent" }
  | { readonly state: "owned"; readonly onlySkillFile: boolean; readonly sha256: string }
  | { readonly state: "modified" }
  | { readonly state: "foreign"; readonly reason: string };

/** Classifies an installed skill directory without following links (see skill-ownership.ts). */
function classifyInstalledSkill(
  skillDir: string,
  skillName: CanonicalSkillName,
  shippedContent: string | null,
  trustedBases: readonly string[],
  record: SkillInstallRecord,
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
  const skillRead = readRegularFileText(skillFile, SKILL_FILE_MAX_BYTES);
  if (skillRead.kind === "missing") {
    return { state: "foreign", reason: "has no SKILL.md" };
  }
  if (skillRead.kind !== "ok") {
    return { state: "foreign", reason: "has a SKILL.md that is not a regular file of at most 1 MiB" };
  }
  const ownership = classifySkillOwnership({
    skillName,
    filePath: skillFile,
    text: skillRead.text,
    shippedContent,
    record,
  });
  if (ownership === "modified") return { state: "modified" };
  if (ownership === "foreign") {
    return { state: "foreign", reason: "has a SKILL.md that does not belong to Causoryn" };
  }
  const entries = readdirSync(skillDir);
  return {
    state: "owned",
    onlySkillFile: entries.length === 1 && entries[0] === "SKILL.md",
    sha256: sha256OfText(skillRead.text),
  };
}

/** SHA-256 of the regular file at `filePath` ("absent" / "other" when it is missing / not a readable regular file). */
function currentFileSha256(filePath: string): string {
  const read = readRegularFileText(filePath, SKILL_FILE_MAX_BYTES);
  if (read.kind === "missing") return "absent";
  return read.kind === "ok" ? sha256OfText(read.text) : "other";
}

function changedWhileRunningError(filePath: string): CausorynCliError {
  return new CausorynCliError(
    "cli/io-error",
    `${filePath} changed while setup was running, so it was left as it is. Run setup again.`,
  );
}

/**
 * Before the first mutation: every skill file setup will replace or remove
 * must still be exactly what it was while planning (for example the user may
 * have edited it during the confirmation prompt). Nothing is changed otherwise.
 */
function assertPlannedSkillFilesUnchanged(plan: PlannedExecution): void {
  for (const writeOp of plan.writes) {
    if (writeOp.expectedCurrentSha256 === undefined) continue;
    if (currentFileSha256(writeOp.targetPath) !== (writeOp.expectedCurrentSha256 ?? "absent")) {
      throw changedWhileRunningError(writeOp.targetPath);
    }
  }
  for (const removal of plan.removals) {
    const skillFile = removal.mode === "skill-dir" ? path.join(removal.targetPath, "SKILL.md") : removal.targetPath;
    if (currentFileSha256(skillFile) !== removal.expectedSha256) {
      throw changedWhileRunningError(skillFile);
    }
  }
}

/** Executes one planned skill removal, re-validating it first (no link is followed). */
function removeInstalledSkill(removal: FileRemoveInstruction, trustedBases: readonly string[]): void {
  const skillDir = removal.mode === "skill-dir" ? removal.targetPath : path.dirname(removal.targetPath);
  const skillFile = path.join(skillDir, "SKILL.md");
  let dirStat;
  try {
    dirStat = lstatSync(skillDir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory() || !isFreeOfLinkedComponents(skillDir, trustedBases, { includeTarget: true })) return;
  // Only the exact bytes proven Causoryn's while planning are removed.
  if (currentFileSha256(skillFile) !== removal.expectedSha256) return;
  unlinkSync(skillFile);
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
    const manifestRead = readRegularFileText(path.join(runtimeDir, "package.json"));
    if (manifestRead.kind !== "ok") return false;
    const manifest: unknown = JSON.parse(manifestRead.text);
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

/** Own property `key` of `obj` (never an inherited one), or undefined. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Copy of `source`'s own enumerable properties into an object without a
 * prototype: a lookup such as `servers["causoryn"]` then never finds an
 * inherited value, and an own `__proto__` key stays a plain key.
 */
function nullPrototypeCopy(source: Record<string, unknown>): Record<string, unknown> {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    copy[key] = source[key];
  }
  return copy;
}

/** Keys never copied from a migrated JSON object (CWE-1321). */
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function parseJsonObjectStrict(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // CWE-209: the parser's message quotes the file's text, which may hold credentials.
    throw new CausorynCliError(
      "cli/malformed-json",
      `Malformed JSON configuration file (${filePath}): ${describeJsonSyntaxError(error)}`,
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
  const env = ownValue(existingEntry, "env");
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
        preserved: extractPreservedMcpArgs(existing !== undefined ? ownValue(existing, "args") : undefined),
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

  const existingServersRaw = ownValue(doc, "mcpServers");
  if (existingServersRaw !== undefined && !isPlainObject(existingServersRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcpServers" field must be a JSON object (${targetPath})`,
    );
  }
  const servers = nullPrototypeCopy(isPlainObject(existingServersRaw) ? existingServersRaw : {});

  if (uninstall) {
    if (!existed || !Object.hasOwn(servers, "causoryn")) {
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

/** Largest `~/.agents/mcp.json` setup reads for the ZCode migration (bytes). */
const ZCODE_FALLBACK_MAX_BYTES = 1024 * 1024;

/**
 * Reads the ZCode fallback config `~/.agents/mcp.json` with the protection
 * of the configs setup writes (CWE-59): no symbolic link or junction below
 * the home directory, a regular file (never a link, FIFO or device) of at most
 * {@link ZCODE_FALLBACK_MAX_BYTES}. Returns null when it does not exist; any
 * other unusable file fails setup before a change (its servers would
 * otherwise silently disappear from ZCode once `mcp.servers` exists).
 */
function readZcodeFallbackDoc(
  fallbackPath: string,
  trustedBases: readonly string[],
): Record<string, unknown> | null {
  try {
    lstatSync(fallbackPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new CausorynCliError(
      "cli/io-error",
      `Could not read the ZCode fallback config status (${fallbackPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertSafeWritePath(fallbackPath, trustedBases, { purpose: "read" });
  const read = readRegularFileText(fallbackPath, ZCODE_FALLBACK_MAX_BYTES);
  if (read.kind === "missing") return null;
  if (read.kind !== "ok") {
    let reason = "it is not a regular file";
    try {
      const st = lstatSync(fallbackPath);
      if (st.isSymbolicLink()) {
        reason = "it is a symbolic link (CWE-59)";
      } else if (st.isFile() && st.size > ZCODE_FALLBACK_MAX_BYTES) {
        reason = "it is larger than 1 MiB";
      }
    } catch {
      // Keep the generic reason.
    }
    throw new CausorynCliError(
      "cli/io-error",
      `Refusing to read the ZCode fallback config ${fallbackPath}: ${reason}. ` +
        'Replace it with a regular file, or add its servers to "mcp.servers" in ~/.zcode/cli/config.json by hand, then run setup again.',
    );
  }
  return parseJsonObjectStrict(read.text, fallbackPath);
}

/** A migrated fallback server entry: own keys only, reserved keys dropped, `type` added for stdio commands. */
function normalizeFallbackServerEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.entries(entry).filter(([key]) => !RESERVED_OBJECT_KEYS.has(key));
  const needsType = typeof ownValue(entry, "command") === "string" && !Object.hasOwn(entry, "type");
  // Object.fromEntries defines own properties: no key can reach a prototype.
  return Object.fromEntries(needsType ? [["type", "stdio"], ...kept] : kept);
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
  readonly trustedBases: readonly string[];
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
    trustedBases,
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

  const mcpRaw = ownValue(doc, "mcp");
  if (mcpRaw !== undefined && !isPlainObject(mcpRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcp" field must be a JSON object (${targetPath})`,
    );
  }
  const mcpObj: Record<string, unknown> = isPlainObject(mcpRaw) ? { ...mcpRaw } : {};

  const serversRaw = ownValue(mcpObj, "servers");
  if (serversRaw !== undefined && !isPlainObject(serversRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `The "mcp.servers" field must be a JSON object (${targetPath})`,
    );
  }
  const hadServersDefined = isPlainObject(serversRaw);
  const servers = nullPrototypeCopy(isPlainObject(serversRaw) ? serversRaw : {});

  if (uninstall) {
    if (!existed || !Object.hasOwn(servers, "causoryn")) {
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
  // Only the fallback's own server names are copied; reserved names never are (CWE-1321).
  const fallbackDoc = hadServersDefined ? null : readZcodeFallbackDoc(fallbackPath, trustedBases);
  const skippedFallbackNames: string[] = [];
  if (fallbackDoc !== null) {
    const fallbackServers = ownValue(fallbackDoc, "mcpServers");
    if (fallbackServers !== undefined && !isPlainObject(fallbackServers)) {
      throw new CausorynCliError(
        "cli/malformed-json",
        `The "mcpServers" field must be a JSON object (${fallbackPath})`,
      );
    }
    if (isPlainObject(fallbackServers)) {
      for (const name of Object.keys(fallbackServers)) {
        if (name === "causoryn") continue;
        if (RESERVED_OBJECT_KEYS.has(name)) {
          skippedFallbackNames.push(name);
          continue;
        }
        const entry = fallbackServers[name];
        servers[name] = isPlainObject(entry) ? normalizeFallbackServerEntry(entry) : entry;
      }
    }
  }

  servers["causoryn"] = buildJsonCausorynEntry({
    includeStdioType: true,
    nodeExecutable,
    cliScriptPath,
    client: "zcode",
    toolProfile,
    existingEntry: ownValue(servers, "causoryn"),
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
    detail:
      fallbackDoc !== null
        ? `configured mcp.servers.causoryn (kept the fallback servers from ~/.agents/mcp.json${
            skippedFallbackNames.length > 0
              ? `; did not import the reserved server names ${skippedFallbackNames.join(", ")}`
              : ""
          })`
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
  const targetPath = path.join(params.codexHomeDir, "config.toml");
  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  const existingRaw = existed ? readFileSync(targetPath, "utf8") : "";
  try {
    planCodexMcpConfigFromText({ ...params, targetPath, existed, existingRaw });
  } catch (error) {
    // TOML errors name the line and key (never the value); add the file.
    if (error instanceof CausorynCliError && error.code === "cli/malformed-toml") {
      throw new CausorynCliError("cli/malformed-toml", `${error.message} (${targetPath})`);
    }
    throw error;
  }
}

function planCodexMcpConfigFromText(params: {
  readonly nodeExecutable: string;
  readonly cliScriptPath: string;
  readonly toolProfile: string | undefined;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
  readonly targetPath: string;
  readonly existed: boolean;
  readonly existingRaw: string;
}): void {
  const {
    nodeExecutable,
    cliScriptPath,
    toolProfile,
    uninstall,
    actions,
    writes,
    projectedConfigs,
    targetPath,
    existed,
    existingRaw,
  } = params;

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
  // CWE-209: only the parsed number is reported, never the raw TOML text of the value.
  const present = existingEntry?.startupTimeoutSecRaw !== undefined;
  const userValue = existingEntry?.startupTimeoutSec ?? null;
  if (userValue !== null && userValue >= minimum) {
    return { seconds: userValue, note: `kept startup_timeout_sec = ${String(userValue)}` };
  }
  if (userValue !== null) {
    return {
      seconds: minimum,
      note: `raised startup_timeout_sec from ${String(userValue)} to the required minimum of ${String(minimum)}`,
    };
  }
  if (present) {
    return {
      seconds: minimum,
      note: `replaced the unusable startup_timeout_sec value with ${String(minimum)}`,
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
  readonly record: SkillInstallRecord;
  /** Whether the install record may be written (its path has no link below a trusted base). */
  readonly recordTrusted: boolean;
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
    record,
    recordTrusted,
  } = params;
  const hostSkillsRoot = getHostSkillsDir(homeDir, client, claudeConfigDir);

  for (const skillName of CANONICAL_SKILL_NAMES) {
    const destSkillDir = path.join(hostSkillsRoot, skillName);
    const destSkillFile = path.join(destSkillDir, "SKILL.md");

    if (uninstall) {
      // Remove only what is proven Causoryn's (install record or a shipped
      // version); never follow links.
      let shippedContent: string | null = null;
      try {
        shippedContent = readSourceSkillFileSync(path.join(skillsSourceDir, skillName, "SKILL.md"));
      } catch {
        shippedContent = null;
      }
      const installed = classifyInstalledSkill(destSkillDir, skillName, shippedContent, trustedBases, record);
      if (installed.state === "absent") {
        record.delete(destSkillFile);
      } else if (installed.state === "modified") {
        actions.push({
          client,
          kind: "skill",
          operation: "noop",
          targetPath: destSkillFile,
          backupPath: null,
          detail: `kept ${destSkillDir}: its SKILL.md was changed after Causoryn installed it (the current content was not created by Causoryn)`,
        });
      } else if (installed.state === "owned") {
        removals.push({
          targetPath: installed.onlySkillFile ? destSkillDir : destSkillFile,
          mode: installed.onlySkillFile ? "skill-dir" : "skill-file",
          expectedSha256: installed.sha256,
        });
        record.delete(destSkillFile);
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
    let current: string | null = null;
    if (existed) {
      const read = readRegularFileText(destSkillFile, SKILL_FILE_MAX_BYTES);
      if (read.kind !== "ok") {
        actions.push({
          client,
          kind: "skill",
          operation: "noop",
          targetPath: destSkillFile,
          backupPath: null,
          detail: `skipped skill ${skillName}: ${destSkillFile} was not created by Causoryn (not a regular file of at most 1 MiB), so it was kept and Causoryn's skill was not installed`,
        });
        continue;
      }
      current = read.text;
    }
    if (current === content) {
      // Exactly the shipped content, so provably Causoryn's: record it again
      // in case the install record was lost, so that a later release still
      // recognizes it. Not below a link (setup never writes there, so it never
      // claims such a file), and only into a record that was read in full or
      // does not exist: a record below a link, or one that could not be read
      // (not a regular file, too large, a format this version does not
      // understand), is left as it is instead of failing an otherwise
      // unchanged run or being replaced by the selected hosts' entries only.
      const unusableRecord = describeUnusableRecord(homeDir, record, recordTrusted);
      if (unusableRecord === null && isFreeOfLinkedComponents(destSkillFile, trustedBases)) {
        record.set(destSkillFile, sha256OfText(content));
      }
      actions.push({
        client,
        kind: "skill",
        operation: "noop",
        targetPath: destSkillFile,
        backupPath: null,
        detail:
          unusableRecord === null
            ? `unchanged: skill ${skillName} is already up to date`
            : `unchanged: skill ${skillName} is already up to date (not recorded: ${unusableRecord}, so it was left as it is)`,
      });
      continue;
    }
    if (current !== null) {
      // CAU-10: never replace a SKILL.md Causoryn cannot prove it wrote.
      const ownership = classifySkillOwnership({
        skillName,
        filePath: destSkillFile,
        text: current,
        shippedContent: content,
        record,
      });
      if (ownership !== "owned") {
        actions.push({
          client,
          kind: "skill",
          operation: "noop",
          targetPath: destSkillFile,
          backupPath: null,
          detail:
            ownership === "modified"
              ? `skipped skill ${skillName}: ${destSkillFile} was changed after Causoryn installed it (the current content was not created by Causoryn), so it was kept and not updated (move it away and run setup again to install the current version)`
              : `skipped skill ${skillName}: ${destSkillFile} was not created by Causoryn, so it was kept and Causoryn's skill was not installed (move it away and run setup again to install it)`,
        });
        continue;
      }
    }
    writes.push({
      targetPath: destSkillFile,
      content,
      createBackup: false,
      defaultMode: 0o644,
      expectedCurrentSha256: current === null ? null : sha256OfText(current),
    });
    // Same rule as the up-to-date branch: a record that could not be read in
    // full is never replaced by the selected hosts' entries only (other hosts'
    // entries would be lost). The skill is still written; it stays
    // recognizable as Causoryn's by its shipped content.
    const unusableRecordForWrite = describeUnusableRecord(homeDir, record, recordTrusted);
    if (unusableRecordForWrite === null) {
      record.set(destSkillFile, sha256OfText(content));
    }
    actions.push({
      client,
      kind: "skill",
      operation: existed ? "update" : "create",
      targetPath: destSkillFile,
      backupPath: null,
      detail:
        unusableRecordForWrite === null
          ? `installed skill ${skillName}`
          : `installed skill ${skillName} (not recorded: ${unusableRecordForWrite}, so it was left as it is)`,
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
 * Writes a file that never replaces an existing file: the bytes go to an
 * exclusive temporary file first and are then published without clobbering
 * (`publish`: a hard link for backups, which are never replaced later; an
 * exclusive copy for a new skill file, which a later setup run replaces).
 * Returns false when `destPath` already exists (nothing is written).
 */
function writeFileNoClobber(
  destPath: string,
  data: Buffer,
  mode: number,
  suffix: string,
  publish: (tmpPath: string, destPath: string) => boolean = publishFileNoClobber,
): boolean {
  const tmpPath = `${destPath}.${suffix}.tmp`;
  try {
    writeExclusiveFile(tmpPath, data, mode);
    if (process.platform !== "win32") {
      chmodSync(tmpPath, mode);
    }
    return publish(tmpPath, destPath);
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
  const { targetPath, content, createBackup, defaultMode = 0o600, dirMode, expectedCurrentSha256 } = instruction;
  const parentDir = path.dirname(targetPath);
  // CWE-59: no component below the home / configured host directory may be a
  // link; checked before and after creating missing parent directories.
  assertSafeWritePath(targetPath, trustedBases);
  mkdirSync(parentDir, dirMode !== undefined ? { recursive: true, mode: dirMode } : { recursive: true });
  assertSafeWritePath(targetPath, trustedBases);

  const existed = assertRegularOrAbsentTarget(targetPath);
  const originalBytes = existed ? readFileSync(targetPath) : null;
  if (originalBytes !== null && originalBytes.equals(Buffer.from(content, "utf8"))) {
    // Defense-in-depth idempotency: never write or touch backups when bytes match
    // (also when two hosts share one skills directory and the first wrote it).
    return;
  }
  if (
    expectedCurrentSha256 !== undefined &&
    (originalBytes === null ? expectedCurrentSha256 !== null : sha256OfText(originalBytes.toString("utf8")) !== expectedCurrentSha256)
  ) {
    // CAU-10: the file is no longer the one setup decided to replace.
    throw changedWhileRunningError(targetPath);
  }

  const effectiveMode = existed ? (statSync(targetPath).mode & 0o777) || defaultMode : defaultMode;
  const nonce = randomBytes(4).toString("hex");
  const suffix = `${String(process.pid)}-${String(Date.now())}-${nonce}`;

  if (expectedCurrentSha256 === null && originalBytes === null) {
    // CAU-10: a skill file planned as absent is published without ever
    // replacing a file that appears meanwhile (no rename over it).
    if (!writeFileNoClobber(targetPath, Buffer.from(content, "utf8"), effectiveMode, `new-${suffix}`, copyFileNoClobber)) {
      throw changedWhileRunningError(targetPath);
    }
    return;
  }

  if (createBackup && existed && originalBytes !== null) {
    const primaryBackupPath = `${targetPath}.causoryn.backup`;
    const primaryBackupExisted = assertRegularOrAbsentTarget(primaryBackupPath);
    // First-time backup preserves the user's original pre-Causoryn config forever;
    // it is published without clobbering, so a concurrent writer cannot replace it.
    const wrotePrimary =
      !primaryBackupExisted &&
      writeFileNoClobber(primaryBackupPath, originalBytes, effectiveMode, `bk-${suffix}`);
    if (!wrotePrimary) {
      // NEVER overwrite the original .causoryn.backup; write a secondary timestamped backup instead.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const secondaryBackupPath = `${targetPath}.causoryn.${stamp}-${nonce}.backup`;
      assertRegularOrAbsentTarget(secondaryBackupPath);
      if (!writeFileNoClobber(secondaryBackupPath, originalBytes, effectiveMode, `bk2-${suffix}`)) {
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
  /** Inspection of an existing `~/.causoryn` (default: this process and file system). */
  readonly directoryProbe?: DirectoryOwnershipProbe | undefined;
  /** File system calls of the uninstall runtime removal (default: node:fs). */
  readonly treeRemovalFs?: TreeRemovalFs | undefined;
};

/** Causoryn's skill install record (CAU-10). */
function getSkillInstallRecordPath(homeDir: string): string {
  return path.join(homeDir, ".causoryn", SKILL_INSTALL_RECORD_FILE);
}

/**
 * Why the install record must not take a re-recorded entry, or null when it
 * may (it was read in full, or does not exist yet).
 */
function describeUnusableRecord(homeDir: string, record: SkillInstallRecord, recordTrusted: boolean): string | null {
  const recordPath = getSkillInstallRecordPath(homeDir);
  if (!recordTrusted) {
    return `the skill install record ${recordPath} is below a link (or a path component that is not a directory)`;
  }
  if (record.state === "unreadable") {
    return `the skill install record ${recordPath} could not be read (it is not a regular file of at most 1 MiB)`;
  }
  if (record.state === "malformed") {
    return `the skill install record ${recordPath} could not be read (it is not in a format this version of Causoryn understands)`;
  }
  return null;
}

/** Non-throwing {@link assertPrivateDirectory}: true when `dir` is absent or private. */
function isPrivateOrAbsentDirectory(dir: string, probe: DirectoryOwnershipProbe | undefined): boolean {
  try {
    lstatSync(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    assertPrivateDirectory(dir, "cli/io-error", probe);
    return true;
  } catch {
    return false;
  }
}

/** Throws unless an existing `dir` is private (see {@link assertPrivateDirectory}); absent is fine. */
function assertPrivateIfPresent(dir: string, code: CausorynCliErrorCode, probe: DirectoryOwnershipProbe | undefined): void {
  try {
    lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  assertPrivateDirectory(dir, code, probe);
}

/** Removes the install record file without following a link (absent: nothing to do). */
function removeRecordFile(recordPath: string): void {
  let st;
  try {
    st = lstatSync(recordPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!st.isFile()) {
    throw new CausorynCliError("cli/io-error", `The skill install record is not a regular file: ${recordPath}`);
  }
  unlinkSync(recordPath);
}

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
  // CAU-14: hosts must not resolve the command through their own PATH or working directory.
  if (!uninstall && !path.isAbsolute(nodeExecutable)) {
    throw new CausorynCliError(
      "cli/invalid-arguments",
      "nodeExecutable must be an absolute path to the Node.js executable: a bare or relative command would be resolved by each host through its own PATH and working directory",
    );
  }

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

  // CAU-10: the install record proves which skill files Causoryn wrote. One
  // below a link proves nothing (and writing it fails below). On uninstall a
  // record in a non-private ~/.causoryn is not trusted either and is left
  // alone, so uninstall still removes the configs and the skills that are
  // exactly shipped content; setup itself refuses such a directory below.
  const recordPath = getSkillInstallRecordPath(homeDir);
  const recordTrusted =
    isFreeOfLinkedComponents(recordPath, trustedBases) &&
    (!uninstall || isPrivateOrAbsentDirectory(path.dirname(recordPath), options.directoryProbe));
  const record =
    installSkills && selectedClients.length > 0 && recordTrusted
      ? SkillInstallRecord.load(recordPath)
      : SkillInstallRecord.empty();

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
          trustedBases,
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
        record,
        recordTrusted,
      });
    }
  }

  const recordUpdate: RecordUpdate | null =
    record.changed && (recordTrusted || !uninstall)
      ? { path: recordPath, content: record.serialize() }
      : null;

  // Fail before any mutation (and in --dry-run) when a planned write would go
  // through a link below the home directory or a configured host directory.
  for (const writeOp of writes) {
    assertSafeWritePath(writeOp.targetPath, trustedBases);
  }
  if (recordUpdate !== null) {
    assertSafeWritePath(recordPath, trustedBases);
    assertRegularOrAbsentTarget(recordPath);
  }
  // CAU-14 (CWE-732): ~/.causoryn holds the staged runtime every host config
  // points at and the install record; an existing one must be private. This
  // also applies when nothing is staged because setup runs from a package
  // already below ~/.causoryn (such as ~/.causoryn/runtime itself): the host
  // configs then point into it as well.
  const causorynDir = path.dirname(targetRuntimeDir);
  const configsPointIntoCausorynDir =
    !uninstall && selectedClients.length > 0 && isAtOrBelowDir(effectiveRuntimePkg, causorynDir);
  if (needsRuntimeStage || configsPointIntoCausorynDir || recordUpdate !== null) {
    assertPrivateIfPresent(
      causorynDir,
      needsRuntimeStage ? "cli/runtime-stage-failed" : "cli/io-error",
      options.directoryProbe,
    );
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
      recordUpdate,
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
    plan.needsRuntimeStage ||
    plan.writes.length > 0 ||
    plan.removals.length > 0 ||
    plan.recordUpdate !== null;

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

  // CAU-10: a skill file that changed since planning (for example during the
  // confirmation prompt) stops the run before anything is changed.
  assertPlannedSkillFilesUnchanged(plan);

  let stagedRuntimeDir: string | null = null;
  if (plan.needsRuntimeStage) {
    const staged = stagePersistentRuntime({
      homeDir,
      sourcePackageDir: packageRoot,
      directoryProbe: options.directoryProbe,
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

  // The install record is updated last: a record entry is only ever written
  // for a skill file that is already on disk.
  if (plan.recordUpdate !== null) {
    assertPrivateIfPresent(path.dirname(plan.recordUpdate.path), "cli/io-error", options.directoryProbe);
    if (plan.recordUpdate.content === null) {
      removeRecordFile(plan.recordUpdate.path);
    } else {
      writeFileAtomicWithBackup(
        {
          targetPath: plan.recordUpdate.path,
          content: plan.recordUpdate.content,
          createBackup: false,
          defaultMode: 0o600,
          dirMode: 0o700,
        },
        plan.trustedBases,
        renameFn,
      );
    }
  }

  let runtimeCleanedUp = false;
  let runtimeCleanupSkipped: string | undefined;
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
      runtimeCleanupSkipped = removeStagedRuntime(plan.targetRuntimeDir, options);
      runtimeCleanedUp = runtimeCleanupSkipped === undefined;
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
    ...(runtimeCleanupSkipped === undefined ? {} : { message: runtimeCleanupSkipped }),
  };
}

/**
 * F39 (CWE-367): removes the staged runtime only when ~/.causoryn and every
 * directory of the runtime tree are private (CAU-14 rule: real directories,
 * on POSIX owned by the current user and not writable by group or other
 * users), so no other local user can swap a directory for a link while it is
 * removed; the removal also checks each directory's identity as it goes.
 * Uninstall itself stays possible with a non-private ~/.causoryn: the runtime
 * is then left in place and the returned text says why (nothing is removed).
 */
function removeStagedRuntime(runtimeDir: string, options: ExtendedSetupOptions): string | undefined {
  const causorynDir = path.dirname(runtimeDir);
  let identities: ReadonlyMap<string, TreeIdentity>;
  try {
    assertPrivateDirectory(causorynDir, "cli/io-error", options.directoryProbe);
    identities = assertPrivateTree(runtimeDir, "cli/io-error", options.directoryProbe, options.treeRemovalFs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return (
      `Staged Runtime Cleanup: skipped, the runtime at ${runtimeDir} was left in place. ${reason} ` +
      "Remove it yourself once you have checked it."
    );
  }
  removeTreeNoFollow(runtimeDir, {
    expected: identities,
    ...(options.treeRemovalFs === undefined ? {} : { fs: options.treeRemovalFs }),
  });
  return undefined;
}
