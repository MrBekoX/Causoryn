import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCausorynContext, type CausorynContext } from "./context.js";
import {
  attachMcpRootsWorkspaceBinder,
  buildWorkspaceAutoConfig,
  createDynamicCausorynContext,
  inspectProjectRootSafety,
  parseMcpCliArgs,
  prepareWorkspaceDatabase,
  resolveEffectiveOutputSchemaProfile,
  resolveEffectiveToolProfile,
  resolveIndexWaitTimeoutMs,
  type ParsedMcpCliArgs,
} from "./runtime-cli.js";
import {
  createCausorynMcpServer,
  type BeforeToolCallContext,
  type OutputSchemaProfile,
} from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * Zero-config CLI / Plugin MCP stdio entrypoint (`causoryn mcp ...`).
 *
 * stdout discipline: this process writes ONLY MCP JSON-RPC frames to stdout;
 * all logs are written to stderr via `console.error`.
 */

const NON_BLOCKING_BOOT_TOOLS: ReadonlySet<string> = new Set([
  "causoryn_status",
  "causoryn_get_capabilities",
  "causoryn_index_status",
  "causoryn_refresh_index",
]);

function hasNonEmptyAllowRoots(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const allowRoots = (value as Record<string, unknown>)["allowRoots"];
  return Array.isArray(allowRoots) && allowRoots.length > 0;
}

async function main(): Promise<void> {
  let cliArgs: ParsedMcpCliArgs;
  let outputSchemaProfile: OutputSchemaProfile;
  let toolProfile: string;
  try {
    cliArgs = parseMcpCliArgs(process.argv.slice(2));
    outputSchemaProfile = resolveEffectiveOutputSchemaProfile(cliArgs, process.env);
    toolProfile = resolveEffectiveToolProfile(cliArgs, process.env);
  } catch (error) {
    console.error(
      `[causoryn] CLI argument error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }

  const rawConfig = process.env.CAUSORYN_CONFIG;
  let parsed: unknown = {};
  if (rawConfig !== undefined && rawConfig.length > 0) {
    try {
      parsed = JSON.parse(rawConfig) as unknown;
    } catch (error) {
      console.error(
        `[causoryn] CAUSORYN_CONFIG is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }
  } else if (!cliArgs.hasCliActivation) {
    console.error(
      "[causoryn] CAUSORYN_CONFIG unset; using safe default allowRoots: [] (workspace tools return WORKSPACE_NOT_AUTHORIZED)",
    );
  }

  let activeContext: CausorynContext;
  let beforeToolCallHook:
    | ((toolName: string, hookContext?: BeforeToolCallContext) => Promise<void>)
    | undefined;
  let needsDynamicBinder = false;

  try {
    if (!cliArgs.hasCliActivation) {
      activeContext = createCausorynContext(parsed);
    } else {
      const explicitRoots = cliArgs.roots.length > 0 || hasNonEmptyAllowRoots(parsed);
      if (explicitRoots) {
        const config = buildWorkspaceAutoConfig({
          roots: cliArgs.roots,
          autoDataDir: cliArgs.autoDataDir,
          ...(cliArgs.dataDir !== undefined ? { dataDir: cliArgs.dataDir } : {}),
          ...(cliArgs.client !== undefined ? { client: cliArgs.client } : {}),
          rawBaseConfig: parsed,
        });
        // Legacy graph-<client>.sqlite -> graph.sqlite before any connection opens.
        await prepareWorkspaceDatabase(config);
        activeContext = createDynamicCausorynContext(
          createCausorynContext(config, {
            deferAutoIndex: true,
            ...(cliArgs.client === undefined ? {} : { hostLabel: cliArgs.client }),
          }),
        );
      } else if (cliArgs.allowCwd) {
        const cwdSafety = inspectProjectRootSafety(process.cwd(), {
          ...(cliArgs.dataDir !== undefined ? { dataDir: cliArgs.dataDir } : {}),
        });
        if (cwdSafety.safe) {
          const config = buildWorkspaceAutoConfig({
            roots: [cwdSafety.canonicalRoot],
            autoDataDir: cliArgs.autoDataDir,
            ...(cliArgs.dataDir !== undefined ? { dataDir: cliArgs.dataDir } : {}),
            ...(cliArgs.client !== undefined ? { client: cliArgs.client } : {}),
            rawBaseConfig: parsed,
          });
          await prepareWorkspaceDatabase(config);
          activeContext = createDynamicCausorynContext(
            createCausorynContext(config, {
              deferAutoIndex: true,
              ...(cliArgs.client === undefined ? {} : { hostLabel: cliArgs.client }),
            }),
          );
          activeContext.logger(
            `[causoryn] authorized workspace via --allow-cwd: ${cwdSafety.canonicalRoot} (workspaceId=${activeContext.config.workspaceId})`,
          );
        } else {
          const fallbackConfig = buildWorkspaceAutoConfig({
            roots: [],
            autoDataDir: false,
            rawBaseConfig: parsed,
          });
          activeContext = createDynamicCausorynContext(
            createCausorynContext(fallbackConfig, { deferAutoIndex: true }),
          );
        }
        needsDynamicBinder = true;
      } else {
        console.error(
          "[causoryn] no workspace root specified (no --root or --allow-cwd); using safe default allowRoots: []",
        );
        const config = buildWorkspaceAutoConfig({
          roots: [],
          autoDataDir: false,
          rawBaseConfig: parsed,
        });
        activeContext = createCausorynContext(config);
      }
    }
  } catch (error) {
    console.error(
      `[causoryn] startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }

  const indexWaitTimeoutMs = resolveIndexWaitTimeoutMs(process.env);

  const server = createCausorynMcpServer(activeContext, {
    outputSchemaProfile,
    toolProfile,
    indexWaitTimeoutMs,
    ...(cliArgs.hasCliActivation
      ? {
          beforeToolCall: async (
            toolName: string,
            hookContext?: BeforeToolCallContext,
          ): Promise<void> => {
            if (beforeToolCallHook !== undefined) {
              await beforeToolCallHook(toolName, hookContext);
              return;
            }
            if (toolName === "causoryn_status" || toolName === "causoryn_index_status") {
              activeContext.startDeferredIndex?.();
            } else if (!NON_BLOCKING_BOOT_TOOLS.has(toolName)) {
              await activeContext.waitForInitialIndex?.({
                timeoutMs: indexWaitTimeoutMs,
                ...(hookContext?.signal === undefined ? {} : { signal: hookContext.signal }),
                ...(hookContext?.progressToken === undefined
                  ? {}
                  : {
                      onProgress: (update) =>
                        hookContext.sendProgress({
                          progress: update.progress,
                          total: update.total,
                          message: update.message,
                        }),
                    }),
              });
            }
          },
        }
      : {}),
  });

  if (needsDynamicBinder && "rebind" in activeContext) {
    const binder = attachMcpRootsWorkspaceBinder(
      server,
      activeContext as ReturnType<typeof createDynamicCausorynContext>,
      {
        allowCwd: true,
        ...(activeContext.config.allowRoots.length === 0 ? { cwd: process.cwd() } : {}),
        autoDataDir: cliArgs.autoDataDir,
        ...(cliArgs.dataDir !== undefined ? { dataDir: cliArgs.dataDir } : {}),
        ...(cliArgs.client !== undefined ? { client: cliArgs.client } : {}),
        rawBaseConfig: parsed,
      },
    );
    beforeToolCallHook = binder.beforeToolCall;
  }

  const previousOnInitialized = server.server.oninitialized;
  server.server.oninitialized = (): void => {
    previousOnInitialized?.();
    if (cliArgs.hasCliActivation) {
      // Defer initial background indexing briefly so MCP initialize + tools/list stay instant.
      const bootTimer = setTimeout(() => {
        activeContext.startDeferredIndex?.();
      }, 100);
      bootTimer.unref();
    }
  };

  const previousOnClose = server.server.onclose;
  server.server.onclose = (): void => {
    previousOnClose?.();
    activeContext.close();
  };

  server
    .connect(new StdioServerTransport())
    .then(() => {
      activeContext.logger(`causoryn mcp server ready (${SERVER_NAME}@${SERVER_VERSION})`);
    })
    .catch((error: unknown) => {
      activeContext.close();
      console.error(
        `[causoryn] failed to start stdio transport: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}

main().catch((error: unknown) => {
  console.error(
    `[causoryn] startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
});
