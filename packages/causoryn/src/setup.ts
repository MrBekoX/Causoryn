import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  type HostClientId,
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
      `Hedef dosya durumu okunamadı (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new CausorynCliError(
      "cli/io-error",
      `Güvenlik nedeniyle sembolik bağlantı üzerine yazılamaz (CWE-59): ${filePath}`,
    );
  }
  if (!st.isFile()) {
    throw new CausorynCliError(
      "cli/io-error",
      `Hedef yol düzenli bir dosya değil: ${filePath}`,
    );
  }
  return true;
}

function assertConfigAndBackupTargetsSafe(targetPath: string): boolean {
  const existed = assertRegularOrAbsentTarget(targetPath);
  assertRegularOrAbsentTarget(`${targetPath}.causoryn.backup`);
  return existed;
}

interface FileRemoveInstruction {
  readonly targetPath: string;
}

interface PlannedExecution {
  readonly selectedClients: readonly HostClientId[];
  readonly needsRuntimeStage: boolean;
  readonly targetRuntimeDir: string;
  readonly actions: readonly SetupAction[];
  readonly writes: readonly FileWriteInstruction[];
  readonly removals: readonly FileRemoveInstruction[];
  readonly projectedConfigs: ReadonlyMap<string, string>;
}

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
  if (
    existsSync(path.join(homeDir, ".gemini", "config")) ||
    existsSync(path.join(homeDir, ".gemini", "antigravity")) ||
    existsSync(path.join(homeDir, ".gemini"))
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
      `Bozuk JSON konfigürasyon dosyası (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `JSON kök değeri bir nesne olmalı (${filePath})`,
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

function buildMcpArgs(cliScriptPath: string, client: HostClientId): string[] {
  return [
    cliScriptPath,
    "mcp",
    "--allow-cwd",
    "--auto-data-dir",
    "--client",
    client,
  ];
}

function planMcpServersJsonFile(params: {
  readonly client: "antigravity" | "claude-code";
  readonly targetPath: string;
  readonly cliScriptPath: string;
  readonly uninstall: boolean;
  readonly includeStdioType: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const {
    client,
    targetPath,
    cliScriptPath,
    uninstall,
    includeStdioType,
    actions,
    writes,
    projectedConfigs,
  } = params;

  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  let doc: Record<string, unknown> = {};
  if (existed) {
    doc = parseJsonObjectStrict(readFileSync(targetPath, "utf8"), targetPath);
  }

  const existingServersRaw = doc["mcpServers"];
  if (existingServersRaw !== undefined && !isPlainObject(existingServersRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `"mcpServers" alanı bir JSON nesnesi olmalı (${targetPath})`,
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
        detail: "causoryn MCP kaydı zaten mevcut değil",
      });
      return;
    }
    delete servers["causoryn"];
    const nextDoc: Record<string, unknown> = {
      ...doc,
      mcpServers: servers,
    };
    const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
    writes.push({ targetPath, content: nextRaw, createBackup: true, defaultMode: 0o600 });
    projectedConfigs.set(path.resolve(targetPath), nextRaw);
    actions.push({
      client,
      kind: "mcp-config",
      operation: "remove",
      targetPath,
      backupPath: `${targetPath}.causoryn.backup`,
      detail: "mcpServers.causoryn kaldırıldı",
    });
    return;
  }

  const entry: Record<string, unknown> = {
    ...(includeStdioType ? { type: "stdio" } : {}),
    command: "node",
    args: buildMcpArgs(cliScriptPath, client),
  };
  servers["causoryn"] = entry;
  const nextDoc: Record<string, unknown> = {
    ...doc,
    mcpServers: servers,
  };
  const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
  writes.push({ targetPath, content: nextRaw, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), nextRaw);
  actions.push({
    client,
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: "mcpServers.causoryn yapılandırıldı",
  });
}

function planZcodeMcpConfig(params: {
  readonly homeDir: string;
  readonly cliScriptPath: string;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const { homeDir, cliScriptPath, uninstall, actions, writes, projectedConfigs } = params;
  const targetPath = path.join(homeDir, ".zcode", "cli", "config.json");
  const fallbackPath = path.join(homeDir, ".agents", "mcp.json");

  const existed = assertConfigAndBackupTargetsSafe(targetPath);
  let doc: Record<string, unknown> = {};
  if (existed) {
    doc = parseJsonObjectStrict(readFileSync(targetPath, "utf8"), targetPath);
  }

  const mcpRaw = doc["mcp"];
  if (mcpRaw !== undefined && !isPlainObject(mcpRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `"mcp" alanı bir JSON nesnesi olmalı (${targetPath})`,
    );
  }
  const mcpObj: Record<string, unknown> = mcpRaw ? { ...mcpRaw } : {};

  const serversRaw = mcpObj["servers"];
  if (serversRaw !== undefined && !isPlainObject(serversRaw)) {
    throw new CausorynCliError(
      "cli/malformed-json",
      `"mcp.servers" alanı bir JSON nesnesi olmalı (${targetPath})`,
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
        detail: "ZCode mcp.servers.causoryn kaydı mevcut değil",
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
    writes.push({ targetPath, content: nextRaw, createBackup: true, defaultMode: 0o600 });
    projectedConfigs.set(path.resolve(targetPath), nextRaw);
    actions.push({
      client: "zcode",
      kind: "mcp-config",
      operation: "remove",
      targetPath,
      backupPath: `${targetPath}.causoryn.backup`,
      detail: "ZCode mcp.servers.causoryn kaldırıldı",
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
        `"mcpServers" alanı bir JSON nesnesi olmalı (${fallbackPath})`,
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

  servers["causoryn"] = {
    type: "stdio",
    command: "node",
    args: buildMcpArgs(cliScriptPath, "zcode"),
  };

  const nextDoc: Record<string, unknown> = {
    ...doc,
    mcp: {
      ...mcpObj,
      servers,
    },
  };
  const nextRaw = `${JSON.stringify(nextDoc, null, 2)}\n`;
  writes.push({ targetPath, content: nextRaw, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), nextRaw);
  actions.push({
    client: "zcode",
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: !hadServersDefined && existsSync(fallbackPath)
      ? "mcp.servers.causoryn yapılandırıldı (~/.agents/mcp.json fallback sunucuları korundu)"
      : "mcp.servers.causoryn yapılandırıldı",
  });
}

function planCodexMcpConfig(params: {
  readonly codexHomeDir: string;
  readonly cliScriptPath: string;
  readonly uninstall: boolean;
  readonly actions: SetupAction[];
  readonly writes: FileWriteInstruction[];
  readonly projectedConfigs: Map<string, string>;
}): void {
  const { codexHomeDir, cliScriptPath, uninstall, actions, writes, projectedConfigs } = params;
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
        detail: "Codex config.toml mevcut değil",
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
        detail: "[mcp_servers.causoryn] zaten mevcut değil",
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
      detail: "[mcp_servers.causoryn] kaldırıldı",
    });
    return;
  }

  const updated = upsertCodexMcpServer(existingRaw, {
    command: "node",
    args: buildMcpArgs(cliScriptPath, "codex"),
    startupTimeoutSec: 30,
  });
  writes.push({ targetPath, content: updated, createBackup: existed, defaultMode: 0o600 });
  projectedConfigs.set(path.resolve(targetPath), updated);
  actions.push({
    client: "codex",
    kind: "mcp-config",
    operation: existed ? "update" : "create",
    targetPath,
    backupPath: existed ? `${targetPath}.causoryn.backup` : null,
    detail: "[mcp_servers.causoryn] yapılandırıldı (startup_timeout_sec = 30)",
  });
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
}): void {
  const { homeDir, claudeConfigDir, client, skillsSourceDir, uninstall, actions, writes, removals } =
    params;
  const hostSkillsRoot = getHostSkillsDir(homeDir, client, claudeConfigDir);

  for (const skillName of CANONICAL_SKILL_NAMES) {
    const destSkillDir = path.join(hostSkillsRoot, skillName);
    const destSkillFile = path.join(destSkillDir, "SKILL.md");

    if (uninstall) {
      if (existsSync(destSkillDir)) {
        removals.push({ targetPath: destSkillDir });
        actions.push({
          client,
          kind: "skill",
          operation: "remove",
          targetPath: destSkillFile,
          backupPath: null,
          detail: `Skill kaldırıldı: ${skillName}`,
        });
      }
      continue;
    }

    const srcSkillFile = path.join(skillsSourceDir, skillName, "SKILL.md");
    if (!existsSync(srcSkillFile) || !statSync(srcSkillFile).isFile()) {
      throw new CausorynCliError(
        "cli/io-error",
        `Kaynak skill dosyası bulunamadı: ${srcSkillFile}`,
      );
    }
    const content = readFileSync(srcSkillFile, "utf8");
    const existed = assertRegularOrAbsentTarget(destSkillFile);
    writes.push({ targetPath: destSkillFile, content, createBackup: false, defaultMode: 0o644 });
    actions.push({
      client,
      kind: "skill",
      operation: existed ? "update" : "create",
      targetPath: destSkillFile,
      backupPath: null,
      detail: `Skill kuruldu: ${skillName}`,
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

function writeFileAtomicWithBackup(instruction: FileWriteInstruction): void {
  const { targetPath, content, createBackup, defaultMode = 0o600 } = instruction;
  const parentDir = path.dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });

  const existed = assertRegularOrAbsentTarget(targetPath);
  const effectiveMode = existed ? (statSync(targetPath).mode & 0o777) || defaultMode : defaultMode;
  const suffix = `${String(process.pid)}-${String(Date.now())}`;

  if (createBackup && existed) {
    const backupPath = `${targetPath}.causoryn.backup`;
    assertRegularOrAbsentTarget(backupPath);
    const originalBytes = readFileSync(targetPath);
    const backupTmp = `${backupPath}.${suffix}.tmp`;
    writeFileSync(backupTmp, originalBytes, { mode: effectiveMode });
    if (process.platform !== "win32") {
      chmodSync(backupTmp, effectiveMode);
    }
    renameSync(backupTmp, backupPath);
  }

  const tmpPath = `${targetPath}.causoryn.${suffix}.tmp`;
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: effectiveMode });
  if (process.platform !== "win32") {
    chmodSync(tmpPath, effectiveMode);
  }
  renameSync(tmpPath, targetPath);
}

type ExtendedSetupOptions = SetupOptions & {
  readonly claudeConfigDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
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

  let selectedClients: HostClientId[];
  if (options.clients !== undefined && options.clients.length > 0) {
    selectedClients = [...new Set(options.clients)];
  } else if (options.allDetected === true) {
    selectedClients = detectInstalledClients(homeDir, codexHomeDir, claudeConfigDir);
  } else {
    const detected = detectInstalledClients(homeDir, codexHomeDir, claudeConfigDir);
    selectedClients = detected.length > 0 ? detected : [...HOST_CLIENT_IDS];
  }

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
          cliScriptPath,
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
              `Hedef dosya durumu okunamadı (${secondaryPath}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (secondaryPresent) {
          planMcpServersJsonFile({
            client: "antigravity",
            targetPath: secondaryPath,
            cliScriptPath,
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
          cliScriptPath,
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
          cliScriptPath,
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
          cliScriptPath,
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
      });
    }
  }

  return {
    homeDir,
    codexHomeDir,
    claudeConfigDir,
    packageRoot,
    plan: {
      selectedClients,
      needsRuntimeStage,
      targetRuntimeDir,
      actions,
      writes,
      removals,
      projectedConfigs,
    },
  };
}

export async function runSetup(options: ExtendedSetupOptions = {}): Promise<SetupResult> {
  const dryRun = options.dryRun === true;
  const uninstall = options.uninstall === true;
  const { homeDir, codexHomeDir, claudeConfigDir, packageRoot, plan } = buildExecutionPlan(options);

  if (dryRun) {
    return {
      dryRun: true,
      applied: false,
      uninstall,
      selectedClients: plan.selectedClients,
      stagedRuntimeDir: plan.needsRuntimeStage ? plan.targetRuntimeDir : null,
      runtimeCleanedUp: false,
      actions: plan.actions,
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
    };
  }

  const autoApprove = options.yes ?? true;
  if (!autoApprove) {
    if (options.confirm === undefined) {
      throw new CausorynCliError(
        "cli/confirmation-required",
        "Kurulum onayı gerekli: değişiklikleri uygulamak için `--yes` veya önizlemek için `--dry-run` kullanın.",
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

  for (const writeOp of plan.writes) {
    writeFileAtomicWithBackup(writeOp);
  }

  for (const removeOp of plan.removals) {
    rmSync(removeOp.targetPath, { recursive: true, force: true });
  }

  let runtimeCleanedUp = false;
  if (uninstall && existsSync(plan.targetRuntimeDir)) {
    const stillReferenced = anyRemainingHostReferencesRuntime({
      homeDir,
      codexHomeDir,
      claudeConfigDir,
      runtimeDir: plan.targetRuntimeDir,
      projectedConfigs: plan.projectedConfigs,
    });
    if (!stillReferenced) {
      rmSync(plan.targetRuntimeDir, { recursive: true, force: true });
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
