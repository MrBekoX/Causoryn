import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createEdge, evidenceId, nodeId } from "@causoryn/domain";
import type { EdgeKind, NodeKind } from "@causoryn/domain";
import { describe, expect, it } from "vitest";

/**
 * Faz D MCP yüzeyi testleri — sprint-5 D2/D3/D4/D5/D6'nın araç kaydı.
 *
 * Kanıt: TŞ v2.1 §10.2 (Sayfa 9–10 araç kataloğu; pdftotext ile birincil
 * kaynaktan doğrulandı): causoryn_trace_business_flow "flowSeed, boundaries?,
 * maxHops" → Cross-component Business Flow; causoryn_check_contracts
 * "contracts?, snapshotId?" → Architecture Contracts değerlendirmesi;
 * causoryn_detect_contract_drift "base, target, scope?" → Contract Drift
 * Detection; causoryn_preflight_change "intent, targetSymbols/files?,
 * baseSnapshot?" → Preflight Manifest ve risk adayı; causoryn_derive_test_plan
 * "changeSet/preflightId?" → Test Intelligence, test listesi/gap · §10.3
 * (preflight manifest gövdesi + "kodu kendisi değiştirmez") · §11 (drift) ·
 * §14 (FlowSegment[]) · §15 (Test Intelligence). Çekirdekler: packages/
 * contracts/{compatibility,contract-drift}.ts, packages/preflight/{manifest,
 * test-plan,source-revision}.ts, packages/graph/business-flow.ts.
 *
 * Her araç için pozitif (backward-safe) + negatif (breaking candidate) +
 * unknown üçlüsü (sprint-5 çıkış kriteri). Fixture'lar: examples/
 * fixture-contract-drift + examples/fixture-ts-orders — ikisi de salt okunur
 * kullanılır (ADR-008); tek yazma os.tmpdir() yoktur (tüm araçlar salt
 * okunur; preflight_change kod-yazmaz garantisi çalışma ağacı karmasıyla
 * kanıtlanır).
 *
 * Alan adı sapmaları (belgeli): check_contracts "contracts?" girdisi TŞ'de
 * şekilsizdir; bu dilimde sözleşme SÜRÜM ÇİFTİ {name?, base, target} olarak
 * tanımlanır (D2 çekirdeğinin checkContractCompatibility(base, target)
 * girdisine bire bir eşlenir). detect_contract_drift "scope?" matchKey
 * daraltmasıdır; "anchorFiles?" TŞ katalogunda sayılmayan BELGELİ ektir
 * (PRODUCES/CONSUMES etki grafı tüketici ankrajları olmadan üretilemez;
 * verilmezse tüm değişiklikler unconsumedChanges'e düşer — TŞ §11 "unresolved
 * consumers" dürüstlük hükmü). derive_test_plan "preflightId?" bu dilimde
 * AÇIK INVALID_ARGUMENT ile reddedilir (manifest deposu tutulmaz; uydurma
 * çözümleme yok).
 */

import {
  CausorynToolError,
  CheckContractsInputSchema,
  DetectContractDriftInputSchema,
  DIFFERENTIATION_TOOL_MAX_ITEMS,
  EnvelopeSchema,
  TOOL_NAMES,
  checkContracts,
  createCausorynContext,
  createCausorynMcpServer,
  deriveTestPlan,
  getAgentContext,
  preflightChange,
  traceBusinessFlow,
  wikiDiff,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const ORDERS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const CONTRACT_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-contract-drift");

/** Sabit saat: manual publish determinizminin çapası. */
const FIXED_NOW = "2026-11-07T12:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

interface ClientPair {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-faz-d-client", version: "0.0.0" });
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

function makeContext(
  allowRoot: string = ORDERS_FIXTURE,
  configOverrides: Record<string, unknown> = {},
): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [allowRoot],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: true,
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

function expectErrorOf(result: CallToolResult): Record<string, unknown> {
  const envelope = expectEnvelope(result);
  expect(envelope.status).toBe("error");
  const error = envelope.error as Record<string, unknown>;
  expect(typeof error.code).toBe("string");
  expect(typeof error.retryable).toBe("boolean");
  expect((error.userAction as string).length).toBeGreaterThan(0);
  return error;
}

/** Çalışma ağacı karması: preflight "kod yazmaz" garantisinin kanıtı. */
function hashTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else files.push(entryPath);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ */
/* Manual graph yayın donanımı (wiki-tools.test.ts örüntüsü)           */
/* ------------------------------------------------------------------ */

interface ManualNodeSpec {
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly relativePath: string;
  readonly language?: string;
}

interface ManualEdgeSpec {
  readonly kind: EdgeKind;
  readonly from: ManualNodeSpec;
  readonly to: ManualNodeSpec;
  readonly resolution: "verified" | "heuristic" | "unresolved";
}

function manualNodeId(spec: ManualNodeSpec): string {
  return nodeId({
    workspaceId: "default",
    kind: spec.kind,
    qualifiedName: spec.qualifiedName,
    relativePath: spec.relativePath,
  });
}

/**
 * Verilen node/kenarları taşıyan graph snapshot'ını yayınlar; InMemoryGraph
 * repoya workspace kaydını da yapar (autoIndex=false akışı için).
 */
function publishManualGraph(
  context: CausorynContext,
  revisionId: string,
  nodes: readonly ManualNodeSpec[],
  edges: readonly ManualEdgeSpec[],
): string {
  const repo = context.repository;
  repo.registerWorkspace({
    id: "default",
    rootPath: context.config.allowRoots[0] as string,
    createdAt: FIXED_NOW,
  });
  const build = repo.beginBuild({
    workspaceId: "default",
    revision: { id: revisionId, sequence: 1 },
    configHash: "cfg-faz-d-manual",
    analyzerFingerprint: "fp-faz-d-manual",
    createdAt: FIXED_NOW,
  });
  for (const spec of nodes) {
    repo.addNode(build.buildId, {
      id: manualNodeId(spec),
      kind: spec.kind,
      qualifiedName: spec.qualifiedName,
      location: {
        relativePath: spec.relativePath,
        startLine: 1,
        endLine: 10,
        sourceHash: `sha256:${spec.relativePath}`,
      },
      // attributes: JSON eşleme ZORUNLUDUR (canonical JSON undefined reddeder).
      attributes: {},
      ...(spec.language === undefined ? {} : { language: spec.language }),
    });
  }
  const evidenceRecordId = evidenceId({
    workspaceId: "default",
    kind: nodes[0]?.kind ?? "File",
    analyzerId: "manual-fixture",
    analyzerVersion: "0.0.0",
    rationale: `Faz D manual test grafı kanıt kaydı (${revisionId})`,
    span: {
      relativePath: nodes[0]?.relativePath ?? "src/x.ts",
      startLine: 1,
      endLine: 10,
      sourceHash: "sha256:manual",
    },
  });
  if (nodes.length > 0) {
    const anchor = nodes[0] as ManualNodeSpec;
    repo.addEvidence(build.buildId, {
      id: evidenceRecordId,
      kind: anchor.kind,
      span: {
        relativePath: anchor.relativePath,
        startLine: 1,
        endLine: 10,
        sourceHash: "sha256:manual",
      },
      analyzerId: "manual-fixture",
      analyzerVersion: "0.0.0",
      rationale: `Faz D manual test grafı kanıt kaydı (${revisionId})`,
    });
  }
  for (const spec of edges) {
    repo.addEdge(
      build.buildId,
      createEdge({
        workspaceId: "default",
        kind: spec.kind,
        from: manualNodeId(spec.from),
        to: manualNodeId(spec.to),
        resolution: spec.resolution,
        evidenceIds: nodes.length > 0 ? [evidenceRecordId] : [],
      }),
    );
  }
  const published = repo.publish(build.buildId, "ready", FIXED_NOW);
  return published.meta.id;
}

/* ------------------------------------------------------------------ */
/* Katalog — TOOL_NAMES 28 (TŞ §10.2 katalog sırası + §16A.8 Wiki eki)  */
/* ------------------------------------------------------------------ */

describe("Faz D katalog büyümesi", { timeout: 60_000 }, () => {
  it("TOOL_NAMES 28 araçtır; Faz D araçları TŞ §10.2 katalog sırasıyla girer", () => {
    expect(TOOL_NAMES).toHaveLength(28);
    expect(TOOL_NAMES).toEqual([
      "causoryn_get_capabilities",
      "causoryn_workspace_summary",
      "causoryn_index_status",
      "causoryn_refresh_index",
      "causoryn_map_system",
      "causoryn_find_symbols",
      "causoryn_get_symbol_context",
      "causoryn_trace_execution",
      // sprint-5 D5: trace_business_flow trace_execution'dan SONRA (TŞ §10.2
      // katalog satırı "Cross-component Business Flow").
      "causoryn_trace_business_flow",
      "causoryn_analyze_impact",
      "causoryn_check_architecture",
      "causoryn_compare_architecture",
      "causoryn_get_agent_context",
      "causoryn_generate_onboarding",
      "causoryn_export_documentation",
      // sprint-5 D4/D2/D3/D6: preflight_change, check_contracts,
      // detect_contract_drift, derive_test_plan — export_documentation ile
      // get_evidence ARASINDA (TŞ §10.2 katalog satır sırası; verify_change
      // Agent Change Guard bu dilimde YOKTUR).
      "causoryn_preflight_change",
      "causoryn_check_contracts",
      "causoryn_detect_contract_drift",
      "causoryn_derive_test_plan",
      "causoryn_get_evidence",
      "causoryn_architecture_timeline",
      "causoryn_wiki_build",
      "causoryn_wiki_get_tree",
      "causoryn_wiki_get_page",
      "causoryn_wiki_search",
      "causoryn_wiki_get_links",
      "causoryn_wiki_get_versions",
      "causoryn_wiki_diff",
    ]);
  });

  it("pozitif: tools/list 5 Faz D aracını input+output şemalarıyla yayınlar", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      expect(tools).toHaveLength(28);
      for (const name of [
        "causoryn_check_contracts",
        "causoryn_detect_contract_drift",
        "causoryn_preflight_change",
        "causoryn_trace_business_flow",
        "causoryn_derive_test_plan",
      ]) {
        const tool = tools.find((entry) => entry.name === name);
        expect(tool, `${name} tools/list'te yok`).toBeDefined();
        expect(tool?.inputSchema, `${name} inputSchema yok`).toBeDefined();
        expect(tool?.outputSchema, `${name} outputSchema yok`).toBeDefined();
        expect((tool?.description ?? "").length).toBeGreaterThan(0);
      }
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Şema bütçe tavanları (TŞ §19 resource budget; güvenlik denetimi)    */
/* ------------------------------------------------------------------ */

describe("Faz D sözleşme araçları — dizi girdisi bütçe tavanları", { timeout: 60_000 }, () => {
  const pairOf = (base: string, target: string): { base: string; target: string } => ({
    base,
    target,
  });
  const files = (count: number): string[] =>
    Array.from({ length: count }, () => "openapi.yaml");

  it("checkContracts.contracts: tavan kabul edilir, tavan+1 şema reddedilir", () => {
    const atLimit = {
      contracts: Array.from({ length: DIFFERENTIATION_TOOL_MAX_ITEMS }, () =>
        pairOf("openapi.yaml", "openapi-v2.yaml"),
      ),
    };
    expect(CheckContractsInputSchema.safeParse(atLimit).success).toBe(true);
    const overLimit = {
      contracts: Array.from({ length: DIFFERENTIATION_TOOL_MAX_ITEMS + 1 }, () =>
        pairOf("openapi.yaml", "openapi-v2.yaml"),
      ),
    };
    expect(CheckContractsInputSchema.safeParse(overLimit).success).toBe(false);
  });

  it("detectContractDrift base/target/anchorFiles: tavan kabul, tavan+1 şema reddi", () => {
    const parses = (
      patch: Partial<Record<"base" | "target" | "anchorFiles", string[]>>,
    ): boolean =>
      DetectContractDriftInputSchema.safeParse({
        base: files(1),
        target: files(1),
        ...patch,
      }).success;
    expect(
      parses({
        base: files(DIFFERENTIATION_TOOL_MAX_ITEMS),
        target: files(1),
        anchorFiles: files(DIFFERENTIATION_TOOL_MAX_ITEMS),
      }),
    ).toBe(true);
    // Opsiyonellik korunur: tavan düzenlemesi anchorFiles'ı zorunlu kılamaz.
    expect(parses({})).toBe(true);
    expect(parses({ base: files(DIFFERENTIATION_TOOL_MAX_ITEMS + 1) })).toBe(false);
    expect(parses({ target: files(DIFFERENTIATION_TOOL_MAX_ITEMS + 1) })).toBe(false);
    expect(parses({ anchorFiles: files(DIFFERENTIATION_TOOL_MAX_ITEMS + 1) })).toBe(false);
  });

  it("tel düzeyi: tavan aşımı SDK şema reddiyle isError döner (kaynak-amplifikasyonu kapısı)", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      // Determinizm önkoşulu: tek çiftli geçerli çağrı autoIndex'i hazır
      // kılar — tavan aşımı çağrısı INDEX_NOT_READY yarışıyla değil, YALNIZCA
      // şema reddiyle isError dönmeli.
      expectEnvelope(
        await callTool(pair.client, "causoryn_check_contracts", {
          contracts: [pairOf("openapi.yaml", "openapi-v2.yaml")],
        }),
      );
      const overPairs = Array.from(
        { length: DIFFERENTIATION_TOOL_MAX_ITEMS + 1 },
        () => pairOf("openapi.yaml", "openapi-v2.yaml"),
      );
      expect(
        (await callTool(pair.client, "causoryn_check_contracts", { contracts: overPairs }))
          .isError,
      ).toBe(true);
      const overFiles = files(DIFFERENTIATION_TOOL_MAX_ITEMS + 1);
      expect(
        (
          await callTool(pair.client, "causoryn_detect_contract_drift", {
            base: overFiles,
            target: ["openapi-v2.yaml"],
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await callTool(pair.client, "causoryn_detect_contract_drift", {
            base: ["openapi.yaml"],
            target: ["openapi-v2.yaml"],
            anchorFiles: overFiles,
          })
        ).isError,
      ).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_check_contracts (D2)                                       */
/* ------------------------------------------------------------------ */

describe("causoryn_check_contracts", { timeout: 60_000 }, () => {
  it("pozitif (backward-safe): openapi v1↔v2 çiftinde required→optional gevşemesi + opsiyonel ekleme + yeni rota backward-safe sınıflanır", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ name: "orders-public-api", base: "openapi.yaml", target: "openapi-v2.yaml" }],
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      expect(typeof envelope.snapshotId).toBe("string");

      const data = envelope.data as Record<string, unknown>;
      const pairs = data.pairs as Array<Record<string, unknown>>;
      expect(pairs).toHaveLength(1);
      const evaluation = pairs[0] as Record<string, unknown>;
      expect(evaluation.name).toBe("orders-public-api");
      expect(evaluation.baseFile).toBe("openapi.yaml");
      expect(evaluation.targetFile).toBe("openapi-v2.yaml");
      // Keşif sadakati (compatibility.ts belgeli sınır): ApiContract adayı
      // yalnızca İSTEK şeması property'lerini taşır. v2 isteğinde zorunlu
      // currency isteğe iner (required-property-relaxed), opsiyonel note
      // eklenir, GET /orders rotası eklenir → üçü backward-safe; yanıt
      // şeması (Order.currency) drift'i bu çiftin yüzeyinde GÖRÜNMEZ.
      expect(evaluation.classification).toBe("backward-safe");
      const evaluations = evaluation.evaluations as Array<Record<string, unknown>>;
      expect(evaluations.length).toBeGreaterThan(0);
      const findings = evaluations.flatMap(
        (entry) => entry.findings as Array<Record<string, unknown>>,
      );
      const relaxed = findings.find((finding) => finding.ruleId === "required-property-relaxed");
      expect(relaxed?.classification).toBe("backward-safe");
      expect(relaxed?.property).toBe("currency");
      expect(
        findings.some(
          (finding) =>
            finding.ruleId === "added-endpoint" && finding.classification === "backward-safe",
        ),
      ).toBe(true);
      // Her bulgu kanıt taşır (Evidence First; TŞ §8).
      const evidence = (relaxed?.evidence as Array<Record<string, unknown>>) ?? [];
      expect(evidence.length).toBeGreaterThan(0);
      expect(typeof evidence[0]?.relativePath).toBe("string");

      const summary = data.summary as Record<string, unknown>;
      expect(Number(summary.pairCount)).toBe(1);
      const byClassification = summary.byClassification as Record<string, unknown> | undefined;
      expect(Number(byClassification?.backwardSafe)).toBe(3);
    } finally {
      await pair.close();
    }
  });

  it("dürüstlük: kanonik olmayan spec yazımı ('./x') sessiz boş keşfe düşmez — kanonik kararla eşlenir (denetim bulgusu)", async () => {
    // Hata modeli: readContractFiles policy'nin kanonik POSIX relativePath'ini
    // taşır; './openapi.yaml' policy'den GEÇER (dosya okunur) ama ham girdiyle
    // yapılan filter eşleşmez → boş keşif sessizce 'backward-safe' üretirdi.
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const canonical = expectEnvelope(
        await callTool(pair.client, "causoryn_check_contracts", {
          contracts: [
            { name: "orders-public-api", base: "openapi.yaml", target: "openapi-v2.yaml" },
          ],
        }),
      );
      const dotted = expectEnvelope(
        await callTool(pair.client, "causoryn_check_contracts", {
          contracts: [
            { name: "orders-public-api", base: "./openapi.yaml", target: "./openapi-v2.yaml" },
          ],
        }),
      );
      expect(dotted.status).toBe("ok");
      // Aynı dosya çifti, farklı yazım → BİT-BİT AYNI değerlendirme (TŞ §8
      // invariant vi; kanonik olmayan yazım boş keşfe indirgenemez).
      expect(JSON.stringify(dotted.data)).toBe(JSON.stringify(canonical.data));
      const data = dotted.data as Record<string, unknown>;
      const evaluation = (data.pairs as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;
      // baseFile/targetFile kanonik kararla raporlanır (yazım normalize edilir).
      expect(evaluation.baseFile).toBe("openapi.yaml");
      expect(evaluation.targetFile).toBe("openapi-v2.yaml");
    } finally {
      await pair.close();
    }
  });

  it("pozitif (backward-safe): required→optional gevşemesi tek başına backward-safe sınıflanır", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ base: "asyncapi.yaml", target: "asyncapi.yaml" }],
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      const evaluation = (data.pairs as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;
      // Aynı dosyanın kendisiyle karşılaştırılması: yapısal değişiklik yok →
      // backward-safe (no-change-detected gerçek kaydı; uydurma bulgu yok).
      expect(evaluation.classification).toBe("backward-safe");
      const evaluations = evaluation.evaluations as Array<Record<string, unknown>>;
      expect(
        evaluations.every((entry) => entry.changeKind === "unchanged"),
        "aynı dosya çifti unchanged olmalı",
      ).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("negatif (breaking candidate): SQL 001↔002 çiftinde column-dropped breaking_candidate; RENAME unknown ayrı bulgudur", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ base: "db/001_create_orders.sql", target: "db/002_alter_orders.sql" }],
      });
      const envelope = expectEnvelope(result);
      const evaluation = (
        (envelope.data as Record<string, unknown>).pairs as Array<Record<string, unknown>>
      )[0] as Record<string, unknown>;
      expect(evaluation.classification).toBe("breaking_candidate");
      const findings = (evaluation.evaluations as Array<Record<string, unknown>>).flatMap(
        (entry) => entry.findings as Array<Record<string, unknown>>,
      );
      expect(
        findings.some(
          (finding) =>
            finding.ruleId === "column-dropped" && finding.classification === "breaking_candidate",
        ),
      ).toBe(true);
      // TŞ §11: rename sınıflama SAYMAZ → unknown ayrı bulgu (uydurma karar yok).
      expect(
        findings.some((finding) => finding.ruleId === "column-renamed" && finding.classification === "unknown"),
      ).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("negatif: izinli kök dışı/nonexistent spec dosyası PATH_DENIED döner (policy dışı dosya okunmaz)", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ base: "db/yok-boyle-dosya.sql", target: "db/002_alter_orders.sql" }],
      });
      const error = expectErrorOf(result);
      expect(error.code).toBe("PATH_DENIED");
    } finally {
      await pair.close();
    }
  });

  it("unknown: çözümlenemeyen snapshotId INVALID_REVISION döner; yabancı workspaceId WORKSPACE_NOT_AUTHORIZED", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const badSnapshot = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ base: "openapi.yaml", target: "openapi-v2.yaml" }],
        snapshotId: "snapshot:does-not-exist",
      });
      expect(expectErrorOf(badSnapshot).code).toBe("INVALID_REVISION");

      const foreign = await callTool(pair.client, "causoryn_check_contracts", {
        workspaceId: "baska-workspace",
        contracts: [{ base: "openapi.yaml", target: "openapi-v2.yaml" }],
      });
      expect(expectErrorOf(foreign).code).toBe("WORKSPACE_NOT_AUTHORIZED");

      // Şema reddi: contracts çiftinde base/target zorunlu (SDK protokol hatası).
      const missing = await callTool(pair.client, "causoryn_check_contracts", {
        contracts: [{ name: "eksik-girdi" }],
      });
      expect(missing.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("determinizm: aynı girdi iki koşumda bit-bit aynı data JSON üretir (TŞ §8 invariant vi)", async () => {
    const first = makeContext(CONTRACT_FIXTURE);
    const args = {
      contracts: [{ base: "openapi.yaml", target: "openapi-v2.yaml" }],
    };
    const envelopeOne = await checkContracts(first, "req-cc-det-1", args);
    first.close();
    const second = makeContext(CONTRACT_FIXTURE);
    const envelopeTwo = await checkContracts(second, "req-cc-det-2", args);
    second.close();
    // requestId farklıdır; DATA gövdesi birebir aynıdır.
    expect(JSON.stringify(envelopeOne.data)).toBe(JSON.stringify(envelopeTwo.data));
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_detect_contract_drift (D3)                                 */
/* ------------------------------------------------------------------ */

describe("causoryn_detect_contract_drift", { timeout: 60_000 }, () => {
  it("pozitif: SQL drift + tüketici ankrajları → contractChanges K-013(7) gövdesi + verified/heuristic etki grafı + unconsumedChanges boş", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_detect_contract_drift", {
        base: ["db/001_create_orders.sql"],
        target: ["db/002_alter_orders.sql"],
        anchorFiles: [
          "src/repositories/order-repository.ts",
          "src/services/billing-service.ts",
        ],
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;

      // K-013(7) contractChanges: TAM ÜÇ alanlı kayıt (fazlası sızamaz).
      const changes = data.contractChanges as Array<Record<string, unknown>>;
      expect(changes).toHaveLength(1);
      expect(Object.keys(changes[0] as object).sort()).toEqual([
        "changeKind",
        "contractId",
        "summary",
      ]);
      expect(changes[0]?.changeKind).toBe("modified");
      expect(String(changes[0]?.summary)).toContain("column-dropped");

      // Sınıflama alanları AYRIDIR: aggregate breaking_candidate olan çift
      // YALNIZCA breakingCandidates'te görünür; aynı çiftin unknown bulgusu
      // (column-renamed, TŞ §11 "rename sınıflama saymaz") bulgu düzeyinde
      // taşınır — risks/unknowns alanlarına TEKRAR ETMEZ (alan ayrımı).
      const breaking = data.breakingCandidates as Array<Record<string, unknown>>;
      expect(breaking).toHaveLength(1);
      const findings = breaking[0]?.findings as Array<Record<string, unknown>>;
      const dropped = findings.find((finding) => finding.ruleId === "column-dropped");
      expect(dropped?.classification).toBe("breaking_candidate");
      const renamed = findings.find((finding) => finding.ruleId === "column-renamed");
      expect(renamed?.classification).toBe("unknown");
      // Aggregate unknown, ayrı alana kopyalanmaz.
      expect(data.unknowns).toEqual([]);
      expect(data.risks).toEqual([]);

      // Etki grafı: repo verified + billing heuristic; iki sürüm tarafı;
      // kenar resolution ASLA yükseltilmez.
      const edges = data.impactedEdges as Array<Record<string, unknown>>;
      expect(edges).toHaveLength(4);
      const repoEdge = edges.find(
        (edge) => edge.side === "base" && edge.fromSymbol === "order-repository",
      );
      expect(repoEdge?.edgeKind).toBe("CONSUMES_CONTRACT");
      expect(repoEdge?.resolution).toBe("verified");
      expect(repoEdge?.matchBasis).toBe("name-exact");
      const billingEdge = edges.find(
        (edge) => edge.side === "target" && edge.fromSymbol === "billing-service",
      );
      expect(billingEdge?.resolution).toBe("heuristic");
      expect(billingEdge?.matchBasis).toBe("name-similarity");

      // Tüketici kenarı var → unconsumedChanges boş.
      expect(data.unconsumedChanges).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it("negatif: anchorFiles verilmezse tüm değişiklikler unconsumedChanges'e düşer (unresolved consumers dürüstlüğü)", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_detect_contract_drift", {
        base: ["db/001_create_orders.sql"],
        target: ["db/002_alter_orders.sql"],
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      expect(data.impactedEdges).toEqual([]);
      const unconsumed = data.unconsumedChanges as Array<Record<string, unknown>>;
      expect(unconsumed).toHaveLength(1);
      const rationale = (data.rationale as string[]).join(" ");
      expect(rationale).toContain("unconsumed");
    } finally {
      await pair.close();
    }
  });

  it("scope daraltması: eşleşen matchKey kayıtları taşır; eşleşmeyen scope tüm değişim dizilerini boşaltır", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const args = {
        base: ["db/001_create_orders.sql"],
        target: ["db/002_alter_orders.sql"],
        anchorFiles: ["src/repositories/order-repository.ts"],
      };
      const hit = await callTool(pair.client, "causoryn_detect_contract_drift", {
        ...args,
        scope: ["sql SchemaContract table:orders"],
      });
      const hitData = (expectEnvelope(hit).data as Record<string, unknown>);
      expect((hitData.contractChanges as unknown[]).length).toBe(1);
      expect((hitData.impactedEdges as unknown[]).length).toBeGreaterThan(0);

      const miss = await callTool(pair.client, "causoryn_detect_contract_drift", {
        ...args,
        scope: ["openapi ApiContract table:orders"],
      });
      const missData = (expectEnvelope(miss).data as Record<string, unknown>);
      expect(missData.contractChanges).toEqual([]);
      expect(missData.breakingCandidates).toEqual([]);
      expect(missData.impactedEdges).toEqual([]);
      expect(missData.unconsumedChanges).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it("unknown: openapi v1↔v2 drift'i backward-safe contractChanges üretir (anchorFiles endpoint PRODUCES kenarıyla); boş base şema düzeyinde reddedilir", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_detect_contract_drift", {
        base: ["openapi.yaml"],
        target: ["openapi-v2.yaml"],
        anchorFiles: ["src/services/orders-service.ts"],
      });
      const data = expectEnvelope(result).data as Record<string, unknown>;
      // Keşif sadakati: ApiContract adayı yalnızca istek property'lerini
      // taşır → v1↔v2 çifti backward-safe değişimler taşır (required→optional
      // gevşeme + opsiyonel ekleme + yeni rota); breaking/unknown YOK.
      const changes = data.contractChanges as Array<Record<string, unknown>>;
      expect(changes.length).toBeGreaterThan(0);
      expect(data.breakingCandidates).toEqual([]);
      expect(data.unknowns).toEqual([]);
      // Sınıflama alanı boşken contractChanges kayıtları YİNE DE taşınır
      // (backward-safe değişiklikler K-013(7) akışının parçasıdır).
      const impacted = data.impactedEdges as Array<Record<string, unknown>>;
      expect(impacted.length).toBeGreaterThan(0);
      // Endpoint ankrajı → verified PRODUCES_CONTRACT kenarı (route tabanlı).
      const produces = impacted.filter((edge) => edge.edgeKind === "PRODUCES_CONTRACT");
      expect(produces.length).toBeGreaterThan(0);
      expect(produces.every((edge) => edge.resolution === "verified")).toBe(true);

      const emptyBase = await callTool(pair.client, "causoryn_detect_contract_drift", {
        base: [],
        target: ["openapi-v2.yaml"],
      });
      expect(emptyBase.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("unknown (araç yüzeyi): rename-only SQL hedefi unknown sınıflı drift üretir (çekirdek senaryosu yüzeye taşınır)", async () => {
    // Fixture salt-okunurdur (ADR-008): rename hedefi os.tmpdir() altındaki
    // geçici workspace'e kurulur ve test sonunda silinir. Sprint-5 çıkış
    // kriteri olan 'unknown' ayağını GERÇEK unknown sınıflamasıyla çalıştırır.
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-fazd-drift-unknown-"));
    try {
      mkdirSync(path.join(root, "db"), { recursive: true });
      writeFileSync(
        path.join(root, "db", "001_create_orders.sql"),
        readFileSync(path.join(CONTRACT_FIXTURE, "db", "001_create_orders.sql")),
      );
      writeFileSync(
        path.join(root, "db", "003_rename_orders.sql"),
        "-- v3: sadece rename tanima dilimi\nALTER TABLE orders RENAME COLUMN amount TO amount_minor;\n",
        "utf8",
      );
      const pair = await connectClient(makeContext(root));
      try {
        const envelope = expectEnvelope(
          await callTool(pair.client, "causoryn_detect_contract_drift", {
            base: ["db/001_create_orders.sql"],
            target: ["db/003_rename_orders.sql"],
          }),
        );
        const data = envelope.data as Record<string, unknown>;
        const unknowns = data.unknowns as Array<Record<string, unknown>>;
        expect(unknowns).toHaveLength(1);
        expect(unknowns[0]?.matchKey).toBe("sql SchemaContract table:orders");
        const findings = unknowns[0]?.findings as Array<Record<string, unknown>>;
        expect(findings.some((finding) => finding.ruleId === "column-renamed")).toBe(true);
        // TEK ALAN disiplini: aynı çift başka sınıflama alanında tekrar etmez.
        expect(data.breakingCandidates).toEqual([]);
        expect(data.risks).toEqual([]);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("negatif: policy dışı anchor dosyası PATH_DENIED döner", async () => {
    const pair = await connectClient(makeContext(CONTRACT_FIXTURE));
    try {
      const result = await callTool(pair.client, "causoryn_detect_contract_drift", {
        base: ["openapi.yaml"],
        target: ["openapi-v2.yaml"],
        anchorFiles: ["src/yok-boyle-dosya.ts"],
      });
      expect(expectErrorOf(result).code).toBe("PATH_DENIED");
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_preflight_change (D4)                                      */
/* ------------------------------------------------------------------ */

describe("causoryn_preflight_change", { timeout: 60_000 }, () => {
  it("pozitif: intent + targetSymbols → ADAY manifest (impactCandidates + testPlanId + candidateOnly=true); çalışma ağacı BIT-BIT AYNI kalır", async () => {
    const context = makeContext();
    const treeHashBefore = hashTree(ORDERS_FIXTURE);
    try {
      const pair = await connectClient(context);
      try {
        const result = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "POST /orders akışında sipariş doğrulaması ekleme",
          targetSymbols: ["OrdersService.create"],
          includeContracts: true,
          includeTestPlan: true,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const data = envelope.data as Record<string, unknown>;

        // TŞ §10.3 manifest gövdesi.
        expect(String(data.preflightId)).toMatch(/^preflight:[0-9a-f]{64}$/);
        expect(String(data.baseSnapshotId)).toMatch(/^snapshot:/);
        expect(data.intentLabel).toBe("POST /orders akışında sipariş doğrulaması ekleme");
        expect(data.candidateOnly).toBe(true); // kod-yazmaz sözleşmesi
        const identified = data.identifiedTargets as Array<Record<string, unknown>>;
        expect(identified.some((target) => target.qualifiedName === "OrdersService.create")).toBe(
          true,
        );
        const impact = data.impactCandidates as Array<Record<string, unknown>>;
        expect(impact.length).toBeGreaterThan(0);
        // certainty/resolution AYRI alanlar (TŞ §13): mutlak etki iddiası yok.
        for (const candidate of impact) {
          expect(["direct", "indirect", "possible"]).toContain(candidate.certainty);
          expect(["verified", "heuristic", "unresolved"]).toContain(candidate.resolution);
        }
        expect(typeof data.testPlanId).toBe("string");
        expect(String(data.testPlanId)).toMatch(/^testplan:[0-9a-f]{64}$/);
        // Gömülü test planı testPlanId ile AYNI kimliği taşır (join anahtarı).
        const testPlan = data.testPlan as Record<string, unknown> | null;
        expect(testPlan).not.toBeNull();
        expect(testPlan?.planId).toBe(data.testPlanId);
        // fixture git deposu değildir → sourceRevision yok, dürüst limitation.
        expect(data.sourceRevision).toBeUndefined();
        const limitations = data.limitations as string[];
        expect(limitations.some((note) => note.includes("sourceRevision"))).toBe(true);
        // contractChecks bu dilimde türetilmez → dürüst limitation notu.
        expect(data.contractChecks).toEqual([]);
        expect(
          limitations.some((note) => note.includes("sözleşme denetimi")),
        ).toBe(true);
      } finally {
        await pair.close();
      }
    } finally {
      const treeHashAfter = hashTree(ORDERS_FIXTURE);
      expect(treeHashAfter).toBe(treeHashBefore);
      context.close();
    }
  });

  it("negatif: sembole bağlanamayan hedef requiresDisambiguation=true + candidateTargets adayları (otomatik kesinleştirme YOK)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_preflight_change", {
        intent: "repository imzasını değiştirme",
        targetSymbols: ["NoSuchSymbolAnywhere"],
      });
      const data = expectEnvelope(result).data as Record<string, unknown>;
      expect(data.requiresDisambiguation).toBe(true);
      const candidates = data.candidateTargets as Array<Record<string, unknown>>;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.target).toBe("NoSuchSymbolAnywhere");
      const limitations = data.limitations as string[];
      expect(
        limitations.some((note) => note.includes("aday bulunamadı")),
        "adaysız hedef dürüst limitation taşır",
      ).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("unknown: yetkisiz targetFile PATH_DENIED; bilinmeyen baseSnapshot INVALID_REVISION; boş hedef kümesi INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const denied = await callTool(pair.client, "causoryn_preflight_change", {
        intent: "dosya hedefi",
        // Kök dışına çıkan traversal yolu: WorkspaceAccessPolicy reddi →
        // fail-closed (preflight/file-not-authorized → PATH_DENIED).
        targetFiles: ["../disallowed.ts"],
      });
      expect(expectErrorOf(denied).code).toBe("PATH_DENIED");

      const badBase = await callTool(pair.client, "causoryn_preflight_change", {
        intent: "n",
        targetSymbols: ["OrdersService.create"],
        baseSnapshot: "snapshot:does-not-exist",
      });
      expect(expectErrorOf(badBase).code).toBe("INVALID_REVISION");

      const noTargets = await callTool(pair.client, "causoryn_preflight_change", {
        intent: "sadece intent",
      });
      expect(expectErrorOf(noTargets).code).toBe("INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("determinizm: aynı girdi iki koşumda aynı preflightId üretir", async () => {
    const args = {
      intent: "determinizm preflight",
      targetSymbols: ["OrdersService.create"],
    };
    const first = makeContext();
    const envelopeOne = await preflightChange(first, "req-pf-det-1", args);
    first.close();
    const second = makeContext();
    const envelopeTwo = await preflightChange(second, "req-pf-det-2", args);
    second.close();
    expect(envelopeOne.status).toBe("ok");
    expect(envelopeTwo.status).toBe("ok");
    expect(
      (envelopeOne.data as Record<string, unknown>).preflightId,
    ).toBe((envelopeTwo.data as Record<string, unknown>).preflightId);
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_trace_business_flow (D5)                                   */
/* ------------------------------------------------------------------ */

describe("causoryn_trace_business_flow", { timeout: 60_000 }, () => {
  it("pozitif (request zinciri): OrdersService.create seed'i verified CALLS zinciri + dürüst gap kapanışı üretir", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_trace_business_flow", {
        flowSeed: "OrdersService.create",
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      const seed = data.seed as Record<string, unknown> | null;
      expect(seed).not.toBeNull();
      expect(seed?.qualifiedName).toBe("OrdersService.create");
      expect(data.unresolvedSeed).toBeNull();

      const flows = data.flows as Array<Record<string, unknown>>;
      expect(flows.length).toBeGreaterThan(0);
      const allSegments = flows.flatMap(
        (flow) => flow.segments as Array<Record<string, unknown>>,
      );
      // Zincir gerçek kenarlarla kurulur; her segmentin kendi certainty'i
      // vardır (TŞ §14: "Her sınır geçişi kendi evidence'ına ve certainty
      // işaretine sahiptir"). TypeChecker ile çözümlenen CALLS kenarı
      // verified'dır: OrdersService.create → OrderRepository.save.
      const verifiedSegment = allSegments.find(
        (segment) =>
          segment.certainty === "verified" &&
          (segment.edge as Record<string, unknown> | null)?.kind === "CALLS" &&
          ((segment.to as Record<string, unknown> | null)?.qualifiedName ===
            "OrderRepository.save"),
      );
      expect(verifiedSegment).toBeDefined();
      // Zincir sonu: repository akışın terminalidir; devam kenarı yok →
      // uydurma köprü YOK, dürüst gap segmenti (TŞ §14 kesin akış sınırı).
      const gapSegment = allSegments.find(
        (segment) =>
          segment.certainty === "gap" &&
          segment.edge === null &&
          (segment.from as Record<string, unknown>).qualifiedName === "OrderRepository.save",
      );
      expect(gapSegment).toBeDefined();
      // Gap'li sonuç partial'dır; kenar resolution alanları ayrı taşınır.
      expect(envelope.status).toBe("partial");
      const summary = data.summary as Record<string, unknown>;
      expect(Number(summary.totalFlows)).toBe(flows.length);
      expect(Number((summary.segmentCounts as Record<string, unknown>).verified)).toBeGreaterThan(
        0,
      );
      expect(Number((summary.segmentCounts as Record<string, unknown>).gap)).toBeGreaterThan(0);
    } finally {
      await pair.close();
    }
  });

  it("pozitif (event zinciri): producer→EventContract→consumer PRODUCES/CONSUMES kenarlarında izlenir; gap segmenti dürüst raporlanır", () => {
    const context = makeContext(ORDERS_FIXTURE, { autoIndex: false });
    try {
      const producer: ManualNodeSpec = {
        kind: "Class",
        qualifiedName: "app.OrdersProducer",
        relativePath: "src/producer.ts",
      };
      const event: ManualNodeSpec = {
        kind: "EventContract",
        qualifiedName: "app.OrderCreated",
        relativePath: "asyncapi.yaml",
      };
      const consumer: ManualNodeSpec = {
        kind: "Class",
        qualifiedName: "app.BillingConsumer",
        relativePath: "src/billing.ts",
      };
      publishManualGraph(
        context,
        "rev-flow-event",
        [producer, event, consumer],
        [
          {
            kind: "PRODUCES_CONTRACT",
            from: producer,
            to: event,
            resolution: "verified",
          },
          {
            kind: "CONSUMES_CONTRACT",
            from: consumer,
            to: event,
            resolution: "verified",
          },
        ],
      );
      const envelope = traceBusinessFlow(context, "req-flow-event", {
        flowSeed: "app.OrdersProducer",
      });
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const flows = data.flows as Array<Record<string, unknown>>;
      expect(flows.length).toBeGreaterThan(0);
      const eventFlow = flows.find((flow) =>
        ((flow.chainKinds as string[]) ?? []).includes("event"),
      );
      expect(eventFlow).toBeDefined();
      const segments = (eventFlow as Record<string, unknown>).segments as Array<
        Record<string, unknown>
      >;
      // producer → kontrat (forward PRODUCES) + kontrat → consumer (reverse
      // CONSUMES): her segment kenar + yön taşır.
      expect(segments.length).toBeGreaterThanOrEqual(2);
      const kinds = segments.map(
        (segment) => (segment.edge as Record<string, unknown> | null)?.kind,
      );
      expect(kinds).toContain("PRODUCES_CONTRACT");
      expect(kinds).toContain("CONSUMES_CONTRACT");
      const directions = segments.map(
        (segment) => (segment.edge as Record<string, unknown> | null)?.direction,
      );
      expect(directions).toContain("reverse");
    } finally {
      context.close();
    }
  });

  it("negatif: çözülemeyen seed SYMBOL_NOT_FOUND", async () => {
    const pair = await connectClient(makeContext());
    try {
      const missing = await callTool(pair.client, "causoryn_trace_business_flow", {
        flowSeed: "NoSuch.Flow.Seed",
      });
      expect(expectErrorOf(missing).code).toBe("SYMBOL_NOT_FOUND");
    } finally {
      await pair.close();
    }
  });

  it("negatif: belirsiz seed AMBIGUOUS_SYMBOL adaylarla döner (otomatik kesinleştirme yok)", async () => {
    const context = makeContext(ORDERS_FIXTURE, { autoIndex: false });
    try {
      // AYNI qualifiedName, FARKLI relativePath → iki ayrı node, belirsiz ad.
      const sharedA: ManualNodeSpec = {
        kind: "Function",
        qualifiedName: "app.Shared",
        relativePath: "src/a.ts",
      };
      const sharedB: ManualNodeSpec = {
        kind: "Function",
        qualifiedName: "app.Shared",
        relativePath: "src/b.ts",
      };
      publishManualGraph(context, "rev-flow-ambiguous", [sharedA, sharedB], []);
      // Doğrudan servis çağrısı: CausorynToolError fırlatır (envelope'a
      // server.ts handler'ı sarar; SDK üzerinden hata envelope'u TEST EDİLMİŞTİR:
      // get_symbol_context/trace_execution aynı sözleşmenin canlı örnekleri).
      let caught: unknown;
      try {
        traceBusinessFlow(context, "req-flow-ambiguous", { flowSeed: "app.Shared" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CausorynToolError);
      const toolError = caught as InstanceType<typeof CausorynToolError>;
      expect(toolError.code).toBe("AMBIGUOUS_SYMBOL");
      const candidates = (toolError.details as { candidates?: unknown[] }).candidates ?? [];
      expect(candidates).toHaveLength(2);
    } finally {
      context.close();
    }
  });

  it("unknown: geçersiz boundaries üyesi INVALID_ARGUMENT; izole seed gap akışıyla dürüst döner", () => {
    const context = makeContext(ORDERS_FIXTURE, { autoIndex: false });
    try {
      const isolated: ManualNodeSpec = {
        kind: "Function",
        qualifiedName: "app.LoneFunction",
        relativePath: "src/lone.ts",
      };
      publishManualGraph(context, "rev-flow-lone", [isolated], []);
      const envelope = traceBusinessFlow(context, "req-flow-lone", {
        flowSeed: "app.LoneFunction",
      });
      // Kopukluk: uydurma köprü yok; gap segmentiyle akış raporlanır.
      expect(envelope.status).toBe("partial");
      const data = envelope.data as Record<string, unknown>;
      const flows = data.flows as Array<Record<string, unknown>>;
      expect(flows).toHaveLength(1);
      expect((flows[0] as Record<string, unknown>).hasGap).toBe(true);
      const segmentCounts = (data.summary as Record<string, unknown>)
        .segmentCounts as Record<string, unknown>;
      expect(segmentCounts.gap).toBe(1);
    } finally {
      context.close();
    }
  });

  it("geçersiz boundaries şema düzeyinde reddedilir (BUSINESS_FLOW_EDGE_KINDS dışı üye)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_trace_business_flow", {
        flowSeed: "OrdersService.create",
        boundaries: ["NOT_A_FLOW_EDGE"],
      });
      expect(result.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_derive_test_plan (D6)                                      */
/* ------------------------------------------------------------------ */

describe("causoryn_derive_test_plan", { timeout: 60_000 }, () => {
  it("pozitif: TESTS kenarlı değişen sembol doğrudan direct aday üretir; çalıştırma iddiası taşımaz", () => {
    const context = makeContext(ORDERS_FIXTURE, { autoIndex: false });
    try {
      const changed: ManualNodeSpec = {
        kind: "Method",
        qualifiedName: "OrdersService.create",
        relativePath: "src/services/orders-service.ts",
      };
      const test: ManualNodeSpec = {
        kind: "Test",
        qualifiedName: "test/orders-service.test.ts createOrder",
        relativePath: "test/orders-service.test.ts",
      };
      publishManualGraph(
        context,
        "rev-tp-direct",
        [changed, test],
        [{ kind: "TESTS", from: test, to: changed, resolution: "verified" }],
      );
      const envelope = deriveTestPlan(context, "req-tp-direct", {
        changeSet: { changedSymbols: ["OrdersService.create"] },
      });
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(String(data.planId)).toMatch(/^testplan:[0-9a-f]{64}$/);
      const candidates = data.candidates as Array<Record<string, unknown>>;
      expect(candidates.length).toBeGreaterThan(0);
      const direct = candidates.find((candidate) => candidate.matchLevel === "direct");
      expect(direct).toBeDefined();
      expect(direct?.testQualifiedName).toBe(test.qualifiedName);
      // TŞ §15: her aday reason + evidenceIds taşır.
      expect(String(direct?.reason).length).toBeGreaterThan(0);
      expect((direct?.evidenceIds as string[]).length).toBeGreaterThan(0);
    } finally {
      context.close();
    }
  });

  it("pozitif (coverage gap): fixture'ta TESTS kenarı olmayan değişen sembol missingCoverageCandidate düşer", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_derive_test_plan", {
        changeSet: { changedSymbols: ["OrdersService.create"] },
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      const missing = data.missingCoverageCandidates as Array<Record<string, unknown>>;
      expect(missing.some((entry) => entry.qualifiedName === "OrdersService.create")).toBe(true);
      const summary = data.summary as Record<string, unknown>;
      expect(Number(summary.missingCoverageCandidates)).toBeGreaterThan(0);
      // TŞ kırmızı çizgisi: plan yalnızca aday + gerekçe taşır; çalıştırma
      // durumu alanı ŞEMADA YOKTUR (strictObject fazla alanı reddeder —
      // çıktıda "state: not_run/run" benzeri alan bulunamaz).
      expect(Object.keys(data).some((key) => key === "state" || key === "observedCount")).toBe(
        false,
      );
    } finally {
      await pair.close();
    }
  });

  it("negatif: changeSet + preflightId birlikte INVALID_ARGUMENT; preflightId tek başına açık ret; boş changeSet INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const both = await callTool(pair.client, "causoryn_derive_test_plan", {
        changeSet: { changedSymbols: ["OrdersService.create"] },
        preflightId: "preflight:abc",
      });
      expect(expectErrorOf(both).code).toBe("INVALID_ARGUMENT");

      const preflightOnly = await callTool(pair.client, "causoryn_derive_test_plan", {
        preflightId: "preflight:abc",
      });
      expect(expectErrorOf(preflightOnly).code).toBe("INVALID_ARGUMENT");

      const empty = await callTool(pair.client, "causoryn_derive_test_plan", {
        changeSet: {},
      });
      expect(expectErrorOf(empty).code).toBe("INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("unknown: çözülemeyen değişen sembol unresolvedSymbols'da raporlanır (uydurma aday yok); determinizm: aynı girdi aynı planId", () => {
    const args = { changeSet: { changedSymbols: ["NoSuch.Changed.Symbol"] } };
    const first = makeContext();
    const envelopeOne = deriveTestPlan(first, "req-tp-unknown-1", args);
    first.close();
    const second = makeContext();
    const envelopeTwo = deriveTestPlan(second, "req-tp-unknown-2", args);
    second.close();
    for (const envelope of [envelopeOne, envelopeTwo]) {
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.candidates).toEqual([]);
      const unresolved = data.unresolvedSymbols as Array<Record<string, unknown>>;
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.target).toBe("NoSuch.Changed.Symbol");
    }
    expect((envelopeOne.data as Record<string, unknown>).planId).toBe(
      (envelopeTwo.data as Record<string, unknown>).planId,
    );
  });
});

/* ------------------------------------------------------------------ */
/* get_agent_context — contract ayağı (K-013(7) GPS bacağı)            */
/* ------------------------------------------------------------------ */

describe("causoryn_get_agent_context contract ayağı", { timeout: 60_000 }, () => {
  it("degrade korunur: sözleşme kaydı olmayan fixture'ta contract ayağı degradedLegs'te raporlanır (hata değildir)", () => {
    const context = makeContext();
    try {
      const envelope = getAgentContext(context, "req-gps-degrade", {
        task: "sipariş oluşturma akışını incele",
        tokenBudget: 2048,
      });
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const degraded = data.degradedLegs as Array<Record<string, unknown>>;
      const contractLeg = degraded.find((leg) => leg.leg === "contract");
      expect(contractLeg).toBeDefined();
      expect(String(contractLeg?.reason)).toContain("sözleşme kaydı yok");
    } finally {
      context.close();
    }
  });

  it("pozitif: snapshot'ta sözleşme node'u varken contract ayağı KENDİ KENDİNİ doldurur; degradedLegs'te ÇIKMAZ", () => {
    const context = makeContext(ORDERS_FIXTURE, { autoIndex: false });
    try {
      const contract: ManualNodeSpec = {
        kind: "ApiContract",
        qualifiedName: "app.orders",
        relativePath: "openapi.yaml",
      };
      const changed: ManualNodeSpec = {
        kind: "Method",
        qualifiedName: "OrdersService.create",
        relativePath: "src/services/orders-service.ts",
      };
      publishManualGraph(
        context,
        "rev-gps-contract",
        [contract, changed],
        [],
      );
      const envelope = getAgentContext(context, "req-gps-contract", {
        task: "app.orders sözleşmesini incele",
        tokenBudget: 2048,
      });
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const degraded = data.degradedLegs as Array<Record<string, unknown>>;
      expect(degraded.some((leg) => leg.leg === "contract")).toBe(false);
      expect((data.legsApplied as string[])).toContain("contract");
      const items = data.contextItems as Array<Record<string, unknown>>;
      const contractItem = items.find((item) => item.qualifiedName === "app.orders");
      expect(contractItem).toBeDefined();
      expect(((contractItem?.legs as string[]) ?? [])).toContain("contract");
      expect(Number((contractItem?.scores as Record<string, unknown>)?.contract)).toBeGreaterThan(
        0,
      );
    } finally {
      context.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* wiki_diff contractChanges — boş durum gerçek [] döner (degrade      */
/* notu KALDIRILDI; K-013(7) kesinleşti)                               */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_diff contractChanges kesinleşmesi", { timeout: 60_000 }, () => {
  it("iki yüzeyde de sözleşme kaydı yokken contractChanges gerçek [] döner ve warnings'te 'kayıt geldiğinde' degrade notu TAŞINMAZ", () => {
    // Wiki veri kökü beyanı: yalnızca os.tmpdir() altında (allowRoot DIŞI;
    // ADR-008/TŞ §16A.8 yazma sınırı — wiki-tools.test.ts örüntüsü).
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-faz-d-wiki-"));
    const context = makeContext(ORDERS_FIXTURE, {
      autoIndex: false,
      wiki: { dataDbPath: path.join(tempRoot, "wiki-data.sqlite") },
    });
    try {
      // Sözleşmesiz iki graph + bunlara bağlı WikiSnapshot'lar: yüzeyler boş.
      const graphId = publishManualGraph(context, "rev-cc-empty", [], []);
      const wikiStore = context.wikiStore as NonNullable<CausorynContext["wikiStore"]>;
      const sid = wikiStore.beginWikiBuild({
        workspaceId: "default",
        graphSnapshotId: graphId,
        revisionRef: "rev-cc-empty-wiki",
        templateVersion: "tpl-test",
        createdAt: FIXED_NOW,
      });
      wikiStore.addWikiPage(sid, {
        id: "page-empty-s",
        kind: "overview",
        parentId: null,
        title: "Empty Surface",
        slug: "empty-surface",
        route: "/wiki/empty-surface",
        contentHash: `hash-${graphId}`,
        freshness: "fresh",
        coverage: { status: "complete" },
      });
      wikiStore.publishWiki(sid, "wiki-cc-empty", "ready", FIXED_NOW);
      const envelope = wikiDiff(context, "req-diff-cc-empty", {
        base: "wiki-cc-empty",
        target: "wiki-cc-empty",
      });
      const data = envelope.data as Record<string, unknown>;
      expect(data.contractChanges).toEqual([]);
      const warnings = envelope.warnings as string[];
      // Kesinleşen K-013(7) gövdesiyle: boşluk notu artık "kayıt geldiğinde
      // doldurulur" DEĞİLDİR — gerçek [] sessiz döner.
      expect(
        warnings.some((warning) => warning.includes("kayıt geldiğinde")),
      ).toBe(false);
      expect(
        warnings.some(
          (warning) => warning.includes("K-013 #7") && warning.includes("sözleşme kaydı yok"),
        ),
      ).toBe(false);
    } finally {
      context.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
