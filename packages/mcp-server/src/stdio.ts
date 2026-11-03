import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCausorynContext, type CausorynContext } from "./context.js";
import { createCausorynMcpServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * Local stdio giriş noktası (TŞ v2.1 §10, ADR-003).
 *
 * stdout disiplini: bu süreç stdout'a YALNIZCA MCP protokol trafiği
 * yazar (SDK StdioServerTransport); her log console.error ile STDERR'e
 * gider (TŞ §10.1). Konfigürasyon `CAUSORYN_CONFIG` ortam değişkeninden
 * JSON olarak okunur (TŞ §20 ortam değişkeni ilkesi); verilmezse güvenli
 * default kullanılır (allowRoots: [] → tüm workspace araçları
 * WORKSPACE_NOT_AUTHORIZED döner, hiçbir kök sessizce yetkilendirilmez).
 *
 * Kullanım:
 *   CAUSORYN_CONFIG='{"allowRoots":["/abs/root"]}' node src/stdio.ts
 */

function main(): void {
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
  } else {
    console.error(
      "[causoryn] CAUSORYN_CONFIG tanımsız; allowRoots: [] güvenli default kullanılıyor (workspace araçları WORKSPACE_NOT_AUTHORIZED döner)",
    );
  }

  let context: CausorynContext;
  try {
    context = createCausorynContext(parsed);
  } catch (error) {
    console.error(
      `[causoryn] başlatma başarısız: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2); // never döner; context akış aşağısında tanımlıdır
  }

  const server = createCausorynMcpServer(context);
  server
    .connect(new StdioServerTransport())
    .then(() => {
      // Hazır logu: yalnızca stderr (stdout-safi testi bu satırı bekler).
      context.logger(`causoryn mcp server hazir (${SERVER_NAME}@${SERVER_VERSION})`);
    })
    .catch((error: unknown) => {
      console.error(
        `[causoryn] stdio transport başlatılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}

main();
