import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCausorynContext, type CausorynContext } from "./context.js";
import {
  attachMcpRootsWorkspaceBinder,
  buildWorkspaceAutoConfig,
  createDynamicCausorynContext,
  inspectProjectRootSafety,
  parseMcpCliArgs,
  resolveEffectiveOutputSchemaProfile,
  type ParsedMcpCliArgs,
} from "./runtime-cli.js";
import { createCausorynMcpServer, type OutputSchemaProfile } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * K-021 Sıfır-Ayar CLI / Plugin MCP stdio giriş noktası (`causoryn mcp ...`).
 *
 * Not: `src/stdio.ts` TŞ §20 / F1 saf `CAUSORYN_CONFIG` giriş noktası olarak
 * (`process.argv` okumadan) korunur; açık kaynak `packages/causoryn` paketi ise
 * bu modülü (`src/cli-stdio.ts`) `packages/causoryn/dist/mcp-server.mjs` olarak
 * derler.
 *
 * stdout disiplini: bu süreç stdout'a YALNIZCA MCP protokol trafiği yazar;
 * tüm loglar `console.error` ile STDERR'e gider (TŞ §10.1).
 */

const NON_BLOCKING_BOOT_TOOLS: ReadonlySet<string> = new Set([
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

function main(): void {
  let cliArgs: ParsedMcpCliArgs;
  let outputSchemaProfile: OutputSchemaProfile;
  try {
    cliArgs = parseMcpCliArgs(process.argv.slice(2));
    outputSchemaProfile = resolveEffectiveOutputSchemaProfile(cliArgs, process.env);
  } catch (error) {
    console.error(
      `[causoryn] CLI argüman hatası: ${error instanceof Error ? error.message : String(error)}`,
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
        `[causoryn] CAUSORYN_CONFIG geçerli JSON değil: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }
  } else if (!cliArgs.hasCliActivation) {
    console.error(
      "[causoryn] CAUSORYN_CONFIG tanımsız; allowRoots: [] güvenli default kullanılıyor (workspace araçları WORKSPACE_NOT_AUTHORIZED döner)",
    );
  }

  let activeContext: CausorynContext;
  let beforeToolCallHook: ((toolName: string) => Promise<void>) | undefined;
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
          activeContext = createDynamicCausorynContext(
            createCausorynContext(config, {
              deferAutoIndex: true,
              ...(cliArgs.client === undefined ? {} : { hostLabel: cliArgs.client }),
            }),
          );
          activeContext.logger(
            `[causoryn] --allow-cwd ile güvenli çalışma alanı bağlandı: ${cwdSafety.canonicalRoot} (workspaceId=${activeContext.config.workspaceId})`,
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
          "[causoryn] yetkili kök belirtilmedi (--root veya --allow-cwd yok); allowRoots: [] güvenli default kullanılıyor",
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
      `[causoryn] başlatma başarısız: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }

  const server = createCausorynMcpServer(activeContext, {
    outputSchemaProfile,
    ...(cliArgs.hasCliActivation
      ? {
          beforeToolCall: async (toolName: string): Promise<void> => {
            await beforeToolCallHook?.(toolName);
            if (toolName === "causoryn_index_status") {
              activeContext.startDeferredIndex?.();
            } else if (!NON_BLOCKING_BOOT_TOOLS.has(toolName)) {
              await activeContext.waitForInitialIndex?.(15_000);
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
      // MCP initialize + olası anlık tools/list yanıtının event-loop blokajına
      // yakalanmaması için arka plan ilk indeks kısa bir gecikmeyle başlar.
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
      activeContext.logger(`causoryn mcp server hazir (${SERVER_NAME}@${SERVER_VERSION})`);
    })
    .catch((error: unknown) => {
      activeContext.close();
      console.error(
        `[causoryn] stdio transport başlatılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}

main();
