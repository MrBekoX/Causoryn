import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

/**
 * causoryn_wiki_build mode=incremental — TŞ §16A.5 madde 4-6'nın araç
 * yüzeyindeki kanıtı (denetim bulgusu 3): W6 motoru (packages/wiki
 * projectWikiIncremental) artık hazır olduğundan incremental geçerli bir
 * moddur (K-013 #2: mode = full | incremental) ve açık ret metni bayattır.
 *
 * Pozitif: tek route dosyası ekleme → yalnızca etkilenen sayfalar
 * yenilenir (pagesRegenerated < toplam sayfa), eski WikiSnapshot sorgulanabilir
 * kalır (stale=true, TŞ §16A.5 madde 6), wiki_diff addedPages taşır.
 * Negatif: önceki WikiSnapshot yokken incremental → graceful full build +
 * fallbackReason (dürüst degrade; sessiz yok sayma yok).
 * Partial: önceki kaynak graph snapshot okunamıyorsa (depo kaybı/eviction)
 * → graceful full-rebuild + fallbackReason.
 *
 * Rapor eşlemesi (denetim bulgusu 4): motor içi "full-rebuild" modu K-013
 * #2 enum'una (full|incremental) ait değildir; araç çıktısında
 * data.mode="full" + data.fallbackReason olarak eşlenir.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

const FIXED_NOW = "2026-11-07T12:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

interface ClientPair {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-wiki-inc-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    context,
    close: async () => {
      await client.close();
      await server.close();
      context.close();
    },
  };
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-wiki-inc-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeContext(
  configOverrides: Record<string, unknown> = {},
): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: true,
      wiki: { dataDbPath: path.join(tempRoot, "wiki-data.sqlite") },
      ...configOverrides,
    },
    { clock: fixedClock },
  );
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

async function buildWiki(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const envelope = expectEnvelope(
    await callTool(client, "causoryn_wiki_build", { mode: "full", ...args }),
  );
  expect(envelope.status).toBe("ok");
  return envelope.data as Record<string, unknown>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function makeFixtureGitCopy(): string {
  const copyRoot = path.join(tempRoot, "fixture-copy");
  cpSync(FIXTURE_ROOT, copyRoot, { recursive: true });
  git(copyRoot, "init");
  git(copyRoot, "config", "user.email", "vitest@example.com");
  git(copyRoot, "config", "user.name", "vitest");
  git(copyRoot, "add", "-A");
  git(copyRoot, "commit", "-m", "state-a");
  return copyRoot;
}

/** Tek route dosyası ekler + app.ts'i ona bağlar (tek "servis değişimi"). */
function extendFixtureCopy(copyRoot: string): void {
  writeFileSync(
    path.join(copyRoot, "src", "routes", "shipments.ts"),
    [
      "/**",
      " * fixture-ts-orders — test kopyasına eklenen ikinci route katmanı.",
      " * */",
      "",
      'import { type Request, type Response, type RouteHandler } from "../http/router.js";',
      "",
      "export function createShipmentsRoute(): RouteHandler<{ id: string }> {",
      "  return (request: Request<{ id: string }>, response: Response): void => {",
      "    response.json({ id: request.body.id });",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const appPath = path.join(copyRoot, "src", "app.ts");
  const appSource = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";
  const extended = appSource
    .replace(
      'import { createOrdersRoute } from "./routes/orders.js";',
      'import { createOrdersRoute } from "./routes/orders.js";\nimport { createShipmentsRoute } from "./routes/shipments.js";',
    )
    .replace(
      'router.post("/orders", ordersRoute);',
      'router.post("/orders", ordersRoute);\nrouter.post("/shipments", createShipmentsRoute());',
    );
  writeFileSync(appPath, extended, "utf8");
}

describe("causoryn_wiki_build mode=incremental", { timeout: 120_000 }, () => {
  it("pozitif: tek route değişir → yalnızca etkilenen sayfalar yenilenir; eski WikiSnapshot stale=true ile sorgulanır (TŞ §16A.5 madde 4-6)", async () => {
    const copyRoot = makeFixtureGitCopy();
    const pair = await connectClient(
      makeContext({ allowRoots: [copyRoot] }),
    );
    try {
      const fullData = await buildWiki(pair.client);
      const oldWikiId = String(fullData.wikiSnapshotId);
      const totalBefore = Number(fullData.pagesRegenerated);
      expect(totalBefore).toBeGreaterThan(0);

      extendFixtureCopy(copyRoot);
      git(copyRoot, "add", "-A");
      git(copyRoot, "commit", "-m", "state-b");
      pair.context.indexService.runIndex(copyRoot);

      const incEnvelope = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_build", {
          mode: "incremental",
        }),
      );
      expect(incEnvelope.status).toBe("ok");
      const data = incEnvelope.data as Record<string, unknown>;

      // K-013 #2 + bulgusu 4: incremental yürütüldü; fallback yok.
      expect(data.mode).toBe("incremental");
      expect(data.fallbackReason).toBeUndefined();
      expect(String(data.wikiSnapshotId)).not.toBe(oldWikiId);

      // TŞ §16A.5 madde 4: yalnızca ilişkili pageId'ler yenilendi.
      const regenerated = Number(data.pagesRegenerated);
      expect(regenerated).toBeGreaterThanOrEqual(1);
      const tree = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", { limit: 200 }),
      );
      const totalAfter = Number((tree.data as Record<string, unknown>).totalNodes);
      expect(regenerated).toBeLessThan(totalAfter);
      expect(Number(data.sectionsRegenerated)).toBeLessThanOrEqual(
        Number(fullData.sectionsRegenerated),
      );
      // bulgusu 8: data.warnings daima-boş değil ve envelope ile aynı.
      expect(JSON.stringify(data.warnings)).toBe(
        JSON.stringify(incEnvelope.warnings),
      );

      // TŞ §16A.5 madde 6: eski WikiSnapshot sorgulanabilir kalır ve
      // kaynak graph'ı güncel olmadığından stale=true döner.
      const oldTree = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {
          snapshotId: oldWikiId,
          limit: 200,
        }),
      );
      expect((oldTree.data as Record<string, unknown>).stale).toBe(true);

      //wiki_diff: eski → yeni addedPages taşır (yeni shipments sayfaları).
      const diff = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: oldWikiId,
          target: String(data.wikiSnapshotId),
        }),
      );
      expect(
        ((diff.data as Record<string, unknown>).addedPages as string[]).length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await pair.close();
    }
  });

  it("negatif: yayımlanmış WikiSnapshot yokken incremental → graceful full build + fallbackReason (dürüst degrade)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const envelope = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_build", {
          mode: "incremental",
        }),
      );
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      // Bulgusu 4 eşlemesi: motor içi fallback → araçta mode="full".
      expect(data.mode).toBe("full");
      expect(String(data.fallbackReason)).toMatch(/WikiSnapshot/i);
      const warnings = envelope.warnings as string[];
      expect(warnings.some((w) => /incremental/i.test(w))).toBe(true);
      expect(Number(data.pagesRegenerated)).toBeGreaterThan(0);
    } finally {
      await pair.close();
    }
  });

  it("partial: önceki kaynak graph snapshot okunamıyorsa → graceful full-rebuild + fallbackReason (TŞ §16A.5 reconciliation uyumu)", async () => {
    const copyRoot = makeFixtureGitCopy();
    const wikiDb = path.join(tempRoot, "shared-wiki.sqlite");
    const first = await connectClient(
      makeContext({ allowRoots: [copyRoot], wiki: { dataDbPath: wikiDb } }),
    );
    let oldWikiId = "";
    try {
      const fullData = await buildWiki(first.client);
      oldWikiId = String(fullData.wikiSnapshotId);
    } finally {
      await first.close();
    }

    // İkinci context: aynı wiki veri kökü, TAZE in-memory graph deposu ve
    // DEĞİŞMİŞ çalışma ağacı → previous WikiSnapshot var ama kaynak graph
    // bu depoda yok (eviction semantiği).
    extendFixtureCopy(copyRoot);
    const second = await connectClient(
      makeContext({ allowRoots: [copyRoot], wiki: { dataDbPath: wikiDb } }),
    );
    try {
      const envelope = expectEnvelope(
        await callTool(second.client, "causoryn_wiki_build", {
          mode: "incremental",
        }),
      );
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.mode).toBe("full");
      expect(String(data.fallbackReason)).toMatch(/graph/i);
      expect(String(data.wikiSnapshotId)).not.toBe(oldWikiId);
      const warnings = envelope.warnings as string[];
      expect(warnings.some((w) => /full-rebuild|tam yeniden build/i.test(w))).toBe(
        true,
      );
    } finally {
      await second.close();
    }
  });

  it("negatif: yabancı workspace WORKSPACE_NOT_AUTHORIZED döner (incremental dahil yetki önce)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const envelope = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_build", {
          mode: "incremental",
          workspaceId: "baska-workspace",
        }),
      );
      expect(envelope.status).toBe("error");
      expect((envelope.error as Record<string, unknown>).code).toBe(
        "WORKSPACE_NOT_AUTHORIZED",
      );
    } finally {
      await pair.close();
    }
  });
});
