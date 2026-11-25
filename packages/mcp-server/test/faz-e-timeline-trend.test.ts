import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

/**
 * Sprint-6 E5 MCP yüzeyi testleri — causoryn_architecture_timeline ihlal
 * trendi (milestone bazlı evrim).
 *
 * Kanıt: TŞ v2.1 §13 (Timeline: refs/range özetleri; "Ölçüler 'kalite
 * skoru' olarak tek sayıya indirgenmez"; "analiz edilmeyen aralıklar açık
 * raporlanır") · §12 (C2 guard kural türleri: no-cycles /
 * forbidden-dependency) · packages/graph/src/timeline.ts (saf trend
 * çekirdeği + salt-okunur git spawn katmanı) ·
 * packages/mcp-server/src/services-architecture.ts (C7 timeline bölümü).
 *
 * Pozitif: 3 milestone → diff özetleri (Sprint-3 davranışı korunur) +
 * trend; çıktı zod outputSchema'dan geçer (EnvelopeSchema parse), iki
 * koşum byte-deterministik, bileşik kalite skoru alanı YOK.
 * Negatif: geçersiz milestone ref → INVALID_REVISION (trend hataları
 * yutulmaz).
 * Partial: bir milestone'un manifest'i bozuk → unanalyzed-interval korunur
 * VE trend değerleri o noktada null + neden taşır.
 *
 * Kırmızı çizgiler: geçici depo yalnızca salt-okunur cat-file ile okunur
 * (checkout/reset/clean YOK); fixture os.tmpdir() altında yaşar.
 */

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

interface ClientPair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

/** Context'i SDK InMemory transport üzerinden bir Client'a bağlar. */
async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-client", version: "0.0.0" });
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

function makeContext(configOverrides: Record<string, unknown> = {}): CausorynContext {
  return createCausorynContext({
    workspaceId: "trend",
    allowRoots: [],
    results: { maxNodes: 250, maxSymbols: 100 },
    autoIndex: false,
    ...configOverrides,
  });
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

/** Yanıtı envelope şemasına zorlar; başarıda envelope'u döndürür. */
function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

function expectErrorOf(result: CallToolResult): Record<string, unknown> {
  const envelope = expectEnvelope(result);
  expect(envelope.status).toBe("error");
  const error = envelope.error as Record<string, unknown>;
  expect(typeof error.code).toBe("string");
  expect(typeof error.retryable).toBe("boolean");
  expect((error.userAction as string).length).toBeGreaterThan(0);
  return error;
}

/* ------------------------------------------------------------------ */
/* Geçici git fikstürü: 3 milestone + bozuk-manifest milestone          */
/* ------------------------------------------------------------------ */

const POLICY_YAML = [
  "version: 1",
  "rules:",
  "  - id: layer-cycle",
  "    type: no-cycles",
  "    edgeKinds: [CALLS]",
  "    severity: error",
  "  - id: no-service-to-repository",
  "    type: forbidden-dependency",
  '    from: "**/services/**"',
  '    to: "**/repositories/**"',
  "    edgeKinds: [CALLS]",
  "    severity: error",
  "",
].join("\n");

const BROKEN_JSON_MANIFEST = '{ "nodes": [ bozuk json';

interface ModuleIdentity {
  readonly kind: string;
  readonly qualifiedName: string;
  readonly relativePath: string;
}

const BILLING: ModuleIdentity = {
  kind: "Module",
  qualifiedName: "services.Billing",
  relativePath: "src/services/billing.ts",
};
const CORE: ModuleIdentity = {
  kind: "Module",
  qualifiedName: "core.Helper",
  relativePath: "src/core/helper.ts",
};
const REPO: ModuleIdentity = {
  kind: "Module",
  qualifiedName: "repositories.BillingDb",
  relativePath: "src/repositories/billing-db.ts",
};
const UI: ModuleIdentity = {
  kind: "Module",
  qualifiedName: "ui.Panel",
  relativePath: "src/ui/panel.ts",
};

function callsEdge(from: ModuleIdentity, to: ModuleIdentity): Record<string, unknown> {
  return { kind: "CALLS", from, to, resolution: "heuristic" };
}

function contentSetJson(entries: {
  readonly nodes: readonly ModuleIdentity[];
  readonly edges: readonly Record<string, unknown>[];
}): string {
  return `${JSON.stringify({ nodes: entries.nodes, edges: entries.edges }, null, 2)}\n`;
}

/** m1: services→core; ihlal yok. m2: +services→repositories; forbidden 1. */
/** m3: +services↔ui döngüsü; forbidden kenarı kalktı; no-cycles 1. */
function makeGitTrendFixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-trend-faze-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  };
  const blobPath = path.join(root, ".causoryn", "architecture-snapshot.json");
  const policyPath = path.join(root, ".causoryn", "architecture.rules.yaml");
  const commit = (message: string, tag: string, manifest: string): void => {
    writeFileSync(blobPath, manifest, "utf8");
    git("add", ".");
    git("commit", "-m", message);
    git("tag", tag);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "trend-fixture@causoryn.local");
    git("config", "user.name", "Causoryn Trend Fixture");
    mkdirSync(path.join(root, ".causoryn"), { recursive: true });

    writeFileSync(policyPath, POLICY_YAML, "utf8");
    commit(
      "milestone tm1",
      "tm1",
      contentSetJson({ nodes: [BILLING, CORE], edges: [callsEdge(BILLING, CORE)] }),
    );
    commit(
      "milestone tm2",
      "tm2",
      contentSetJson({
        nodes: [BILLING, CORE, REPO],
        edges: [callsEdge(BILLING, CORE), callsEdge(BILLING, REPO)],
      }),
    );
    commit(
      "milestone tm3",
      "tm3",
      contentSetJson({
        nodes: [BILLING, CORE, REPO, UI],
        edges: [
          callsEdge(BILLING, CORE),
          callsEdge(BILLING, UI),
          callsEdge(UI, BILLING),
        ],
      }),
    );
    // Bozuk manifest taşıyan milestone: policy geçerli, içerik çözülemez.
    commit("milestone tm-bad", "tm-bad", BROKEN_JSON_MANIFEST);
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

describe("causoryn_architecture_timeline — sprint-6 E5 ihlal trendi", { timeout: 60_000 }, () => {
  it("pozitif: 3 milestone → diff özetleri (Sprint-3) + metrik başına ayrı trend serileri; kalite skoru YOK; byte-deterministik", async () => {
    const fixture = makeGitTrendFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "trend-ok",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["tm1", "tm2", "tm3"],
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");

        const data = envelope.data as Record<string, unknown>;
        const timeline = data.timeline as Record<string, unknown>;
        // Sprint-3 davranışı korunur: 3 nokta → 2 diff aralığı.
        expect(timeline.requestedPoints).toBe(3);
        expect(timeline.analyzedPoints).toBe(3);
        const intervals = timeline.intervals as Array<Record<string, unknown>>;
        expect(intervals).toHaveLength(2);
        expect(intervals.every((interval) => interval.kind === "diff")).toBe(true);

        // E5: trend bölümü ayrı seriler taşır; bileşik skor alanı YOK.
        const trend = timeline.trend as Record<string, unknown>;
        expect(trend.evaluatedPoints).toBe(3);
        expect(trend.unavailablePoints).toBe(0);
        const points = trend.points as Array<Record<string, unknown>>;
        expect(points).toHaveLength(3);
        expect(points.every((point) => point.status === "evaluated")).toBe(true);
        const series = trend.series as Array<Record<string, unknown>>;
        expect(series.map((entry) => entry.metric)).toEqual([
          "no-cycles",
          "forbidden-dependency",
        ]);

        const cycles = series[0] as Record<string, unknown>;
        const cyclesValues = cycles.values as Array<Record<string, unknown>>;
        expect(cyclesValues.map((value) => value.count)).toEqual([0, 0, 1]);
        const cyclesSteps = cycles.steps as Array<Record<string, unknown>>;
        expect(cyclesSteps.map((step) => step.direction)).toEqual([
          "flat",
          "increasing",
        ]);
        expect(cycles.direction).toBe("increasing");

        const forbidden = series[1] as Record<string, unknown>;
        const forbiddenValues = forbidden.values as Array<Record<string, unknown>>;
        expect(forbiddenValues.map((value) => value.count)).toEqual([0, 1, 0]);
        const forbiddenSteps = forbidden.steps as Array<Record<string, unknown>>;
        expect(forbiddenSteps.map((step) => step.direction)).toEqual([
          "increasing",
          "decreasing",
        ]);
        expect(forbidden.direction).toBe("flat");

        // TŞ §13 kırmızı çizgisi: hiçbir bileşik kalite skoru üretilmez.
        const serialized = JSON.stringify(data);
        expect(serialized).not.toContain("qualityScore");
        expect(serialized).not.toContain('"score"');

        // TŞ §8 invariant vi: aynı girdi iki koşum birebir aynı veri.
        const repeat = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["tm1", "tm2", "tm3"],
        });
        expect(expectEnvelope(repeat).data).toEqual(data);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("negatif: geçersiz milestone (var olmayan ref) → INVALID_REVISION; trend hataları yutulmaz", async () => {
    const fixture = makeGitTrendFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "trend-bad-ref",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["tm1", "no-such-milestone"],
        });
        expect(expectErrorOf(result).code).toBe("INVALID_REVISION");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("partial: bozuk manifest milestone → unanalyzed-interval KORUNUR + trend eksik noktası null + neden taşır", async () => {
    const fixture = makeGitTrendFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "trend-partial",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["tm1", "tm-bad"],
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");

        const timeline = (envelope.data as Record<string, unknown>)
          .timeline as Record<string, unknown>;
        // Sprint-3 davranışı: analiz edilemeyen aralık açık raporlanır.
        expect((timeline.points as Array<Record<string, unknown>>)[1]).toMatchObject({
          ref: "tm-bad",
          status: "unanalyzed",
        });
        const intervals = timeline.intervals as Array<Record<string, unknown>>;
        expect(intervals).toHaveLength(1);
        expect(intervals[0]?.kind).toBe("unanalyzed-interval");

        // E5: trend eksik noktası uydurma sayı YOK.
        const trend = timeline.trend as Record<string, unknown>;
        expect(trend.evaluatedPoints).toBe(1);
        expect(trend.unavailablePoints).toBe(1);
        const series = trend.series as Array<Record<string, unknown>>;
        const cycles = series[0] as Record<string, unknown>;
        const values = cycles.values as Array<Record<string, unknown>>;
        expect(values[1]).toMatchObject({
          index: 1,
          ref: "tm-bad",
          count: null,
        });
        expect(
          String((values[1] as { reason?: string }).reason ?? "").startsWith(
            "manifest-not-json",
          ),
        ).toBe(true);
        expect(cycles.steps).toHaveLength(0);
        expect(cycles.direction).toBe("undetermined");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
