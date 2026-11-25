import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  TOOL_NAMES,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

const tempDirs: string[] = [];
function makeOutDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-mcp-arch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function connectClient(context: CausorynContext) {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-arch-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function expectEnvelope(result: CallToolResult) {
  expect(result.isError).not.toBe(true);
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

function expectToolErrorCode(result: CallToolResult, expectedCode: string): void {
  const env = expectEnvelope(result);
  expect(env.status).toBe("error");
  const err = env.error as { code?: string } | undefined;
  expect(err?.code).toBe(expectedCode);
}

describe("causoryn_export_documentation — v0.2.2 visual architecture & Host-LLM annotations", { timeout: 30_000 }, () => {
  it("varsayılan view=architecture ile HTML (sıfır-JS SVG portal), Mermaid (temiz flowchart), Markdown ve JSON üretir; 29 araç kataloğu sabit kalır", async () => {
    const outDir = makeOutDir();
    const pair = await connectClient(
      createCausorynContext({
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: true,
        output: { allowedOutputDirs: [outDir] },
      }),
    );
    try {
      const list = await pair.client.listTools();
      expect(list.tools).toHaveLength(32);
      expect(TOOL_NAMES).toHaveLength(29);
      for (const name of TOOL_NAMES) {
        expect(list.tools.some((t) => t.name === name)).toBe(true);
      }

      // 1. Default JSON blueprint: exposes meta.id AND architectureSummary.moduleIds
      const jsonRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: { format: "json", outputDir: outDir },
      });
      const jsonEnv = expectEnvelope(jsonRes as CallToolResult);
      expect(jsonEnv.status).toBe("ok");
      const jsonData = jsonEnv.data as {
        path: string;
        view?: string;
        architectureSummary?: { moduleCount: number; annotated: boolean; moduleIds: string[] };
      };
      expect(jsonData.view).toBe("architecture");
      expect(jsonData.architectureSummary?.annotated).toBe(false);
      expect((jsonData.architectureSummary?.moduleIds.length ?? 0)).toBeGreaterThan(0);

      const writtenJson = JSON.parse(readFileSync(jsonData.path, "utf8")) as Record<string, unknown>;
      expect((writtenJson.meta as Record<string, unknown>).id).toBe(jsonEnv.snapshotId);
      expect(writtenJson.view).toBe("architecture");

      // 2. Default HTML: zero-JS strict-CSP layered SVG portal (NOT raw node table!)
      const htmlRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: { format: "html", outputDir: outDir },
      });
      const htmlEnv = expectEnvelope(htmlRes as CallToolResult);
      const htmlData = htmlEnv.data as { path: string; view?: string };
      expect(htmlData.view).toBe("architecture");
      const htmlContent = readFileSync(htmlData.path, "utf8");
      expect(htmlContent).toContain("<svg ");
      expect(htmlContent).toContain("default-src 'none'");
      expect(/<script/i.test(htmlContent)).toBe(false);
      expect(/https?:\/\//i.test(htmlContent)).toBe(false);

      // 3. Default Mermaid: clean flowchart TB with subgraph
      const mmdRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: { format: "mermaid", outputDir: outDir },
      });
      const mmdData = expectEnvelope(mmdRes as CallToolResult).data as { path: string };
      const mmdContent = readFileSync(mmdData.path, "utf8");
      expect(mmdContent.startsWith("flowchart TB\n")).toBe(true);
      expect(mmdContent).toContain("subgraph ");

      // 4. Two-step Host-LLM workflow: use returned moduleIds to submit grounded annotations -> interactive portal
      const moduleIds = jsonData.architectureSummary?.moduleIds ?? [];
      const firstModId = moduleIds[0];
      if (firstModId === undefined) throw new Error("expected at least one moduleId");

      const interRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "html",
          view: "interactive",
          outputDir: outDir,
          fileName: "orders-portal.html",
          annotations: {
            title: "Orders Fixture Interactive Portal",
            architectureStyle: "Modular Service Architecture",
            executiveSummary: "Deterministic order processing example.",
            moduleNotes: [
              {
                moduleId: firstModId,
                summary: "Primary verified module from fixture-ts-orders.",
              },
            ],
            guidedTour: [
              {
                step: 1,
                title: "Start at first module",
                targetModuleId: firstModId,
                explanation: "Walk through verified order creation calls.",
              },
            ],
          },
        },
      });
      const interData = expectEnvelope(interRes as CallToolResult).data as {
        path: string;
        view?: string;
        architectureSummary?: { annotated: boolean };
      };
      expect(interData.view).toBe("interactive");
      expect(interData.architectureSummary?.annotated).toBe(true);
      const interHtml = readFileSync(interData.path, "utf8");
      expect(interHtml).toContain("causoryn-portal-data");
      expect(interHtml).toContain("Orders Fixture Interactive Portal");
      expect(interHtml).toContain("Primary verified module from fixture-ts-orders.");
      expect(interHtml).not.toContain("innerHTML");

      // 5. Explicit view="full" exports legacy raw snapshot dump
      const fullRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "mermaid",
          view: "full",
          outputDir: outDir,
          fileName: "raw-full.mmd",
        },
      });
      const fullData = expectEnvelope(fullRes as CallToolResult).data as { path: string; view?: string };
      expect(fullData.view).toBe("full");
      expect(readFileSync(fullData.path, "utf8").startsWith("flowchart TD\n")).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("uydurma moduleId, view=interactive+mermaid, view=full+annotations ve view=wiki çağrılarını fail-closed INVALID_ARGUMENT ile reddeder", async () => {
    const outDir = makeOutDir();
    const pair = await connectClient(
      createCausorynContext({
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: true,
        output: { allowedOutputDirs: [outDir] },
      }),
    );
    try {
      const badMod = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "html",
          outputDir: outDir,
          annotations: {
            moduleNotes: [{ moduleId: "mod:src/fabricated", summary: "Hallucinated module" }],
          },
        },
      });
      expectToolErrorCode(badMod as CallToolResult, "INVALID_ARGUMENT");

      const badInteractiveFmt = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "mermaid",
          view: "interactive",
          outputDir: outDir,
        },
      });
      expectToolErrorCode(badInteractiveFmt as CallToolResult, "INVALID_ARGUMENT");

      const badFullAnn = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "html",
          view: "full",
          outputDir: outDir,
          annotations: { title: "Not allowed in full raw view" },
        },
      });
      expectToolErrorCode(badFullAnn as CallToolResult, "INVALID_ARGUMENT");

      const wikiView = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "json",
          view: "wiki",
          outputDir: outDir,
        },
      });
      expectToolErrorCode(wikiView as CallToolResult, "INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("fileName verilmeden ardışık html (varsayılan architecture) ve html+interactive çağrıları çakışmadan ayrı dosyalara yazar; açık fileName önceliklidir", async () => {
    const outDir = makeOutDir();
    const pair = await connectClient(
      createCausorynContext({
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: true,
        output: { allowedOutputDirs: [outDir] },
      }),
    );
    try {
      // 1. Default format="html" (default view="architecture", no fileName) -> causoryn-architecture.html
      const archRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: { format: "html", outputDir: outDir },
      });
      const archEnv = expectEnvelope(archRes as CallToolResult);
      expect(archEnv.status).toBe("ok");
      const archData = archEnv.data as { path: string; view?: string };
      expect(archData.view).toBe("architecture");
      expect(path.basename(archData.path)).toBe("causoryn-architecture.html");

      // 2. format="html", view="interactive" without fileName -> causoryn-architecture-interactive.html
      const interRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: { format: "html", view: "interactive", outputDir: outDir },
      });
      const interEnv = expectEnvelope(interRes as CallToolResult);
      expect(interEnv.status).toBe("ok");
      const interData = interEnv.data as { path: string; view?: string };
      expect(interData.view).toBe("interactive");
      expect(path.basename(interData.path)).toBe("causoryn-architecture-interactive.html");
      expect(interData.path).not.toBe(archData.path);

      // Verify both files coexist and default HTML was NOT overwritten
      const archContent = readFileSync(archData.path, "utf8");
      const interContent = readFileSync(interData.path, "utf8");
      expect(archContent).toContain("<svg ");
      expect(archContent).toContain("default-src 'none'");
      expect(/<script/i.test(archContent)).toBe(false);
      expect(interContent).toContain("causoryn-portal-data");
      expect(interContent).toContain("<svg ");
      expect(archContent).not.toBe(interContent);

      // 3. Explicit fileName takes precedence even with view="interactive"
      const customRes = await pair.client.callTool({
        name: "causoryn_export_documentation",
        arguments: {
          format: "html",
          view: "interactive",
          outputDir: outDir,
          fileName: "custom-portal.html",
        },
      });
      const customEnv = expectEnvelope(customRes as CallToolResult);
      expect(customEnv.status).toBe("ok");
      const customData = customEnv.data as { path: string; view?: string };
      expect(customData.view).toBe("interactive");
      expect(path.basename(customData.path)).toBe("custom-portal.html");
      expect(readFileSync(customData.path, "utf8")).toContain("causoryn-portal-data");

      expect(readdirSync(outDir).sort()).toEqual([
        "causoryn-architecture-interactive.html",
        "causoryn-architecture.html",
        "custom-portal.html",
      ]);
    } finally {
      await pair.close();
    }
  });
});
