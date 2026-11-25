import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { EnvelopeSchema, createCausorynContext, createCausorynMcpServer } from "../src/index.js";

/**
 * Exported artifacts are meant to be shared (HTML portals, Markdown briefs) or
 * committed (`format: "snapshot"` → `.causoryn/architecture-snapshot.json`).
 * None of them may carry the machine's absolute workspace path, which embeds
 * the OS user name and the local folder layout.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const EXPORTS: ReadonlyArray<Record<string, unknown>> = [
  { format: "snapshot" },
  { format: "json" },
  { format: "json", view: "full" },
  { format: "markdown" },
  { format: "markdown", view: "full" },
  { format: "mermaid" },
  { format: "html" },
  { format: "html", view: "interactive" },
];

describe("export_documentation — no absolute local paths in artifacts", { timeout: 120_000 }, () => {
  it("every export format leaves out the workspace's absolute path", async () => {
    const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "causoryn-paths-")));
    cleanups.push(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    // A unique directory name: it appears in every spelling of the path
    // (native, forward slashes, JSON-escaped backslashes).
    const marker = `wsmarker${String(process.pid)}x${String(Date.now())}`;
    const repoDir = path.join(tempRoot, marker, "orders-app");
    const exportDir = path.join(tempRoot, "exports");
    mkdirSync(path.join(repoDir, "src"), { recursive: true });
    mkdirSync(exportDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, "src", "orders-service.ts"),
      ["export class OrdersService {", "  create(sku: string): string {", "    return `ord:${sku}`;", "  }", "}", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "src", "routes.ts"),
      [
        'import { OrdersService } from "./orders-service";',
        "export function createOrder(sku: string): string {",
        "  return new OrdersService().create(sku);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const context = createCausorynContext(
      {
        workspaceId: "paths-check",
        allowRoots: [repoDir],
        output: { allowedOutputDirs: [exportDir] },
        autoIndex: true,
      },
      { logger: () => {} },
    );
    const server = createCausorynMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "export-paths-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.unshift(() => {
      void client.close();
      void server.close();
      context.close();
    });

    const leaks: string[] = [];
    for (const args of EXPORTS) {
      const result = (await client.callTool({
        name: "causoryn_export_documentation",
        arguments: { ...args, outputDir: exportDir },
      })) as CallToolResult;
      const parsed = EnvelopeSchema.parse(result.structuredContent);
      expect(parsed.status, `${JSON.stringify(args)}: ${JSON.stringify(parsed.error)}`).not.toBe("error");
      const file = (parsed.data as { path: string }).path;
      const text = readFileSync(file, "utf8");
      expect(text.length, `${JSON.stringify(args)} wrote an empty file`).toBeGreaterThan(0);
      if (text.includes(marker)) {
        const at = text.indexOf(marker);
        leaks.push(`${JSON.stringify(args)} → ${path.basename(file)}: …${text.slice(Math.max(0, at - 80), at + 40)}…`);
      }
    }
    expect(leaks, leaks.join("\n")).toEqual([]);
  });
});
