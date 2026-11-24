import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

/**
 * Faz C MCP yüzeyi testleri — sprint-3 C1–C7'nin araç kaydı (bu dilim C8).
 *
 * Kanıt: TŞ v2.1 §10.2 (Sayfa 9–10 araç kataloğu: analyze_impact
 * "targets/diff, depth, edgeKinds"; check_architecture "policyId?, scope?";
 * compare_architecture "baseRef, targetRef"; get_agent_context "task,
 * candidateScope?, tokenBudget"; generate_onboarding "audience, focus?";
 * export_documentation "format, view, output?"; architecture_timeline
 * "refs/range, granularity") · §12 (Guard finding sözleşmesi) · §13 (Impact/
 * Diff/Timeline) · §15 (Agent GPS) · §16 (Onboarding/Export güvenliği) ·
 * packages/graph/src/{impact,guard,compare,agent-context,onboarding,export,
 * timeline}.ts çekirdek sözleşmeleri.
 *
 * Her araç için pozitif + negatif + partial üçlüüsü (sprint-1 kuralı).
 * Fixture workspace'ler yalnızca os.tmpdir() altında yaşar; examples/
 * fixture-ts-orders salt okunur kullanılır (ADR-008). Git tabanlı
 * compare/timeline fikstürü, geçici bir git deposunda salt-okunur
 * cat-file/ls-tree ile okunacak `.causoryn/architecture-snapshot.json`
 * blob'larıyla kurulur (checkout/reset/clean YOK — TŞ §13).
 */

import {
  EnvelopeSchema,
  TOOL_NAMES,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";
import { GraphRepositoryError } from "@causoryn/graph";
import { graphErrorToToolError } from "../src/services-architecture.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

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
    workspaceId: "default",
    allowRoots: [FIXTURE_ROOT],
    results: { maxNodes: 250, maxSymbols: 100 },
    autoIndex: true,
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
/* Git tabanlı compare/timeline fikstürü                               */
/* ------------------------------------------------------------------ */

/** CompareContentSet JSON'u (TŞ §13 diff girdisi; timeline blob sözleşmesi). */
function contentSetJson(entries: {
  readonly nodes: readonly Record<string, unknown>[];
  readonly edges: readonly Record<string, unknown>[];
}): string {
  return `${JSON.stringify({ nodes: entries.nodes, edges: entries.edges }, null, 2)}\n`;
}

function identity(
  kind: string,
  qualifiedName: string,
  relativePath: string,
): Record<string, unknown> {
  return { kind, qualifiedName, relativePath };
}

/** v1: AlphaService sınıfı + metodu + CONTAINS kenarı. */
const V1_CONTENT = contentSetJson({
  nodes: [
    { ...identity("Class", "AlphaService", "src/alpha.ts"), signature: "class AlphaService" },
    {
      ...identity("Method", "AlphaService.create", "src/alpha.ts"),
      signature: "create(): number",
    },
  ],
  edges: [
    {
      kind: "CONTAINS",
      from: identity("Class", "AlphaService", "src/alpha.ts"),
      to: identity("Method", "AlphaService.create", "src/alpha.ts"),
      resolution: "verified",
    },
  ],
});

/** v2: AlphaService tamamen yok; ilgisiz BetaManager geldi (rename iddiası YOK). */
const V2_CONTENT = contentSetJson({
  nodes: [
    { ...identity("Class", "BetaManager", "src/beta/manager.ts"), signature: "class BetaManager" },
    {
      ...identity("Method", "BetaManager.manage", "src/beta/manager.ts"),
      signature: "manage(): void",
    },
  ],
  edges: [
    {
      kind: "CONTAINS",
      from: identity("Class", "BetaManager", "src/beta/manager.ts"),
      to: identity("Method", "BetaManager.manage", "src/beta/manager.ts"),
      resolution: "verified",
    },
  ],
});

interface GitFixture {
  readonly root: string;
  readonly cleanup: () => void;
}

/**
 * Geçici git deposu: v1 → v1-same (içerik aynı) → v2 → v3 zinciri.
 * Her commit `.causoryn/architecture-snapshot.json` blob'u taşır
 * (TIMELINE_SNAPSHOT_BLOB_PATH sözleşmesi). Yalnızca salt-okunur okuma
 * komutlarıyla tüketilir (cat-file/ls-tree).
 */
function makeGitFixture(): GitFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-fazc-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  };
  const blobPath = path.join(root, ".causoryn", "architecture-snapshot.json");
  const commit = (message: string, content: string, tag: string): void => {
    writeFileSync(blobPath, content, "utf8");
    git("add", ".");
    git("commit", "-m", message);
    git("tag", tag);
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@causoryn.local");
    git("config", "user.name", "Causoryn Fixture");
    mkdirSync(path.join(root, ".causoryn"), { recursive: true });
    commit("base", V1_CONTENT, "v1");
    // İçerik aynı olan ikinci commit: commit'i boş olmaktan çıkarmak için
    // blob DIŞI bir dosya değişir; snapshot blob içeriği birebir aynıdır.
    writeFileSync(path.join(root, "NOTES.md"), "aynı içerik, farklı revizyon\n", "utf8");
    commit("same-content", V1_CONTENT, "v1-same");
    commit("target", V2_CONTENT, "v2");
    // v3 de blob değişmeden commitlenir (örneklemede atlanan ara nokta).
    writeFileSync(path.join(root, "NOTES.md"), "ara revizyon\n", "utf8");
    commit("mid", V2_CONTENT, "v3");
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Blob'suz git deposu: noktalar unanalyzed kalmalı (uydurma içerik yok). */
function makeGitFixtureWithoutBlobs(): GitFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-bare-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@causoryn.local");
    git("config", "user.name", "Causoryn Fixture");
    writeFileSync(path.join(root, "README.md"), "# bare\n", "utf8");
    git("add", ".");
    git("commit", "-m", "first");
    git("tag", "t1");
    writeFileSync(path.join(root, "README.md"), "# bare 2\n", "utf8");
    git("add", ".");
    git("commit", "-m", "second");
    git("tag", "t2");
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Katalog: 23 araç (16 + Wiki 7)                                      */
/* ------------------------------------------------------------------ */

describe("graphErrorToToolError — sabit eşleme birim testleri", () => {
  it("INTERNAL_ERROR eşlemesi orijinal mesajı ENJEKTE EDİLEN logger'a taşır; istemci mesajına sızdırmaz", () => {
    // Takım denetimi bulgusu: ortam hataları (git yok/komut başarısız/yazma
    // hatası) genel mesaj verip detayı DÜŞÜRÜYORDU; errors.ts INTERNAL_ERROR
    // userAction'ı "stderr loglarını inceleyin" dediğinden detayın gerçekte
    // loglanması zorunludur.
    const logs: string[] = [];
    const mapped = graphErrorToToolError(
      new GraphRepositoryError(
        "compare/git-command-failed",
        "git cat-file başarısız: gizli-dosya-yolu D:\\gizli\\repo içinde",
      ),
      (message: string) => logs.push(message),
    );
    expect(mapped.code).toBe("INTERNAL_ERROR");
    // Ham mesaj ve içindeki detaylar istemciye sızdırılmaz (TŞ §10.1).
    expect(mapped.message).not.toContain("git cat-file başarısız");
    expect(mapped.message).not.toContain("gizli-dosya-yolu");
    expect(mapped.message).not.toContain("compare/git-command-failed");
    // Aynı detaylar loga düşer (userAction'ın "stderr loglarını inceleyin"
    // yönlendirmesi bu garantinin karşılığıdır).
    const joined = logs.join("\n");
    expect(joined).toContain("compare/git-command-failed");
    expect(joined).toContain("gizli-dosya-yolu");
  });

  it("sabit sözleşme kodları eşlemesi mesajı TAŞIR: POLICY_INVALID/INVALID_REVISION/EXPORT_NOT_ALLOWED/PATH_DENIED/INVALID_ARGUMENT", () => {
    // Pass-through eşlemelerde orijinal sözleşme mesajı istemciye yararlıdır
    // (policy şema ihlali ayrıntısı, ref bulunamadı gerekçesi vb.); yalnızca
    // INTERNAL_ERROR eşlemesi mesajı genelletir (üstteki test). Burada sabit
    // kod + mesaj taşınma sözleşmesi doğrulanır.
    const cases: ReadonlyArray<[string, string]> = [
      ["guard/policy-invalid", "POLICY_INVALID"],
      ["compare/ref-not-found", "INVALID_REVISION"],
      ["export/output-not-authorized", "EXPORT_NOT_ALLOWED"],
      ["export/output-path-denied", "PATH_DENIED"],
      ["timeline/invalid-range", "INVALID_REVISION"],
      ["timeline/invalid-input", "INVALID_ARGUMENT"],
    ];
    for (const [sourceCode, expected] of cases) {
      const message = `detay-${sourceCode}`;
      const mapped = graphErrorToToolError(new GraphRepositoryError(sourceCode, message));
      expect(mapped.code, sourceCode).toBe(expected);
      expect(mapped.message, `${sourceCode} mesajı taşınmalı`).toBe(message);
    }
  });
});

describe("Faz C MCP yüzeyi — katalog", { timeout: 30_000 }, () => {
  it("tools/list: tam olarak 29 araç (9 çekirdek + Faz C 7 + Wiki 7 + Faz D 5 + Faz E 1); TŞ §10.2 + §16A.8 katalog sırası", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      const listedNames = new Set(tools.map((t) => t.name));
      for (const legacyName of TOOL_NAMES) {
        expect(listedNames.has(legacyName), `missing legacy tool ${legacyName}`).toBe(true);
      }
      expect(tools).toHaveLength(32);
      expect(TOOL_NAMES).toHaveLength(29);
      // Katalog sırası TŞ §10.2 PDF sırasını izler: trace_business_flow
      // trace_execution'dan sonra (sprint-5 D5), Faz D'nin diğer dört aracı
      // export_documentation ile get_evidence arasında (sprint-5 D2/D3/D4/D6);
      // architecture_timeline get_evidence'dan sonra gelir; sprint-6 E1-E3
      // (Faz E) causoryn_verify_change detect_contract_drift ile
      // derive_test_plan arasına girer (TŞ §10.2 PDF s.10 satır sırası);
      // Wiki'nin 7 aracı TŞ §16A.8 tablo sırasıyla katalog sonundadır.
      expect(TOOL_NAMES).toEqual([
        "causoryn_get_capabilities",
        "causoryn_workspace_summary",
        "causoryn_index_status",
        "causoryn_refresh_index",
        "causoryn_map_system",
        "causoryn_find_symbols",
        "causoryn_get_symbol_context",
        "causoryn_trace_execution",
        "causoryn_trace_business_flow",
        "causoryn_analyze_impact",
        "causoryn_check_architecture",
        "causoryn_compare_architecture",
        "causoryn_get_agent_context",
        "causoryn_generate_onboarding",
        "causoryn_export_documentation",
        "causoryn_preflight_change",
        "causoryn_check_contracts",
        "causoryn_detect_contract_drift",
        "causoryn_verify_change",
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
      for (const tool of tools) {
        expect(tool.inputSchema, `${tool.name} inputSchema yok`).toBeDefined();
        expect(tool.outputSchema, `${tool.name} outputSchema yok`).toBeDefined();
        expect(tool.description, `${tool.name} açıklamasız`).toBeTruthy();
      }
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C1 — causoryn_analyze_impact                                        */
/* ------------------------------------------------------------------ */

describe("causoryn_analyze_impact", { timeout: 30_000 }, () => {
  it("pozitif: qualifiedName hedefi çözülür; ters BFS doğrudan etki yolları verified/direct taşır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_analyze_impact", {
        targets: ["OrderRepository.save"],
        depth: 1,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).not.toBeNull();

      const data = envelope.data as Record<string, unknown>;
      const targets = data.targets as Array<Record<string, unknown>>;
      expect(targets).toHaveLength(1);
      expect(targets[0]?.qualifiedName).toBe("OrderRepository.save");
      expect(data.unresolvedTargets).toEqual([]);

      const paths = data.paths as Array<Record<string, unknown>>;
      expect(paths.length).toBeGreaterThanOrEqual(1);
      for (const path of paths) {
        expect(path.targetNodeId).toBe(targets[0]?.nodeId);
        expect(path.depth).toBe(1);
        expect(path.certainty).toBe("direct");
        expect(path.resolution).toBe("verified");
        const edges = path.edges as Array<Record<string, unknown>>;
        expect(edges).toHaveLength(1);
        expect((path.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);
      }
      // Etki kümesi hedefi içermez; ters kenar üzerinden gelen node'lar var (CONTAINS gürültüsü olmadan).
      const affected = data.affectedNodes as Array<Record<string, unknown>>;
      expect(affected.length).toBeGreaterThanOrEqual(1);
      expect(affected.some((n) => n.kind === "Workspace")).toBe(false);
      const summary = data.summary as Record<string, unknown>;
      expect(summary.totalPaths).toBe(paths.length);
      // depth=1'de OrdersService.create üzerinden createOrdersRoute'a (depth=2) daha derin CALLS kenarı var:
      expect(data.truncated).toBe(true);
      const truncatedBy = data.truncatedBy as string[];
      expect(truncatedBy).toContain("maxDepth");

      // Determinizm (TŞ §8 invariant vi): aynı istek → aynı data.
      const repeat = await callTool(pair.client, "causoryn_analyze_impact", {
        targets: ["OrderRepository.save"],
        depth: 1,
      });
      expect(expectEnvelope(repeat).data).toEqual(data);
    } finally {
      await pair.close();
    }
  });

  it("negatif: çözülemeyen hedef unresolvedTargets'ta raporlanır (hata değildir); geçersiz edgeKinds → INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const unknown = await callTool(pair.client, "causoryn_analyze_impact", {
        targets: ["NoSuchSymbolAnywhere"],
      });
      const envelope = expectEnvelope(unknown);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.targets).toEqual([]);
      const unresolved = data.unresolvedTargets as Array<Record<string, unknown>>;
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.target).toBe("NoSuchSymbolAnywhere");
      expect((data.paths as unknown[]).length).toBe(0);

      const badKinds = await callTool(pair.client, "causoryn_analyze_impact", {
        targets: ["OrdersService.create"],
        edgeKinds: ["CALLS", "NO_SUCH_KIND"],
      });
      expect((expectErrorOf(badKinds).code)).toBe("INVALID_ARGUMENT");

      // Boş targets şema düzeyinde reddedilir (protokol isError).
      const empty = await callTool(pair.client, "causoryn_analyze_impact", { targets: [] });
      expect(empty.isError).toBe(true);
      expect(empty.structuredContent).toBeUndefined();

      // Yetki denetimi ilk adımdır.
      const authz = await callTool(pair.client, "causoryn_analyze_impact", {
        workspaceId: "baska-workspace",
        targets: ["x"],
      });
      expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await pair.close();
    }
  });

  it("partial: istenen depth tavana (8) kırpılır; rationale açıkça raporlanır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_analyze_impact", {
        targets: ["OrdersService.create"],
        depth: 99,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const limits = data.limits as Record<string, unknown>;
      expect(limits.maxDepth).toBe(8);
      const rationales = data.rationales as string[];
      expect(rationales.some((r) => r.includes("maxDepth"))).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C2 — causoryn_check_architecture                                    */
/* ------------------------------------------------------------------ */

/** Guard fikstürü: kendi policy/baseline dosyası + orders tarzı kaynak. */
interface GuardFixture {
  readonly root: string;
  readonly outDir: string;
  readonly cleanup: () => void;
}

function makeGuardFixture(options?: {
  readonly policyYaml?: string;
  readonly baselineYaml?: string;
}): GuardFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-guard-fazc-"));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-guard-out-"));
  try {
    const policyYaml =
      options?.policyYaml ??
      [
        "version: 1",
        "rules:",
        "  - id: services-must-not-call-repositories",
        "    type: forbidden-dependency",
        '    from: "**/services/**"',
        '    to: "**/repositories/**"',
        "    edgeKinds: [CALLS]",
        "    severity: error",
        "",
      ].join("\n");
    mkdirSync(path.join(root, ".causoryn"), { recursive: true });
    writeFileSync(path.join(root, ".causoryn", "architecture.rules.yaml"), policyYaml, "utf8");
    if (options?.baselineYaml !== undefined) {
      writeFileSync(
        path.join(root, ".causoryn", "architecture.baseline.yaml"),
        options.baselineYaml,
        "utf8",
      );
    }
    mkdirSync(path.join(root, "src", "services"), { recursive: true });
    mkdirSync(path.join(root, "src", "repositories"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "services", "orders-service.ts"),
      [
        'import { OrderRepository } from "../repositories/order-repository.js";',
        "export class OrdersService {",
        "  private readonly repository: OrderRepository;",
        "  constructor(repository: OrderRepository) {",
        "    this.repository = repository;",
        "  }",
        "  create(): number {",
        "    return this.repository.save();",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "src", "repositories", "order-repository.ts"),
      ["export class OrderRepository {", "  save(): number { return 1; }", "}", ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "src", "main.ts"),
      [
        'import { OrdersService } from "./services/orders-service.js";',
        'import { OrderRepository } from "./repositories/order-repository.js";',
        "const service = new OrdersService(new OrderRepository());",
        "service.create();",
        "",
      ].join("\n"),
      "utf8",
    );
    return { root, outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

describe("causoryn_check_architecture", { timeout: 30_000 }, () => {
  it("pozitif: workspace policy dosyası değerlendirilir; TŞ §12 finding sözleşmesi taşınır", async () => {
    const fixture = makeGuardFixture();
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard", allowRoots: [fixture.root] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_check_architecture", {});
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        expect(envelope.snapshotId).not.toBeNull();

        const data = envelope.data as Record<string, unknown>;
        const findings = data.findings as Array<Record<string, unknown>>;
        expect(findings).toHaveLength(1);
        const finding = findings[0] as Record<string, unknown>;
        expect(finding.ruleId).toBe("services-must-not-call-repositories");
        expect(finding.ruleType).toBe("forbidden-dependency");
        expect(finding.severity).toBe("error");
        expect(finding.from).toBe("OrdersService.create");
        expect(finding.to).toBe("OrderRepository.save");
        expect(finding.suppressed).toBe(false);
        expect(finding.suppression).toBeUndefined();
        expect((finding.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);
        expect(String(finding.id).startsWith("finding:")).toBe(true);
        expect(finding.snapshotId).toBe(envelope.snapshotId);

        const summary = data.summary as Record<string, unknown>;
        expect(summary.findings).toBe(1);
        expect(summary.suppressed).toBe(0);
        expect(data.policyPath).toBe(".causoryn/architecture.rules.yaml");
        expect((data.evaluatedRules as number)).toBe(1);
        expect(data.orphanSuppressions).toEqual([]);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("pozitif: baseline suppression bulguyu baskılar; bayat ruleId orphanSuppressions'ta listelenir", async () => {
    const fixture = makeGuardFixture({
      baselineYaml: [
        "version: 1",
        "suppressions:",
        "  - ruleId: services-must-not-call-repositories",
        "    reason: bilinen geçici borç",
        "    owner: mimari ekip",
        "    date: 2026-11-01",
        "  - ruleId: emekli-olduysa",
        "    reason: policy'de karşılığı yok",
        "    owner: mimari ekip",
        "    date: 2026-11-01",
        "",
      ].join("\n"),
    });
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard-sup", allowRoots: [fixture.root] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_check_architecture", {});
        const data = expectEnvelope(result).data as Record<string, unknown>;
        const findings = data.findings as Array<Record<string, unknown>>;
        expect(findings).toHaveLength(1);
        const finding = findings[0] as Record<string, unknown>;
        expect(finding.suppressed).toBe(true);
        const suppression = finding.suppression as Record<string, unknown>;
        expect(suppression.reason).toBe("bilinen geçici borç");
        expect(suppression.owner).toBe("mimari ekip");
        expect(suppression.date).toBe("2026-11-01");

        const orphans = data.orphanSuppressions as Array<Record<string, unknown>>;
        expect(orphans).toHaveLength(1);
        expect(orphans[0]?.ruleId).toBe("emekli-olduysa");
        const summary = data.summary as Record<string, unknown>;
        expect(summary.suppressed).toBe(1);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("negatif: bozuk policy YAML → POLICY_INVALID; policyId/scope bu dilimde INVALID_ARGUMENT", async () => {
    const fixture = makeGuardFixture({ policyYaml: "version: 1\nrules: [bozuk\n" });
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard-bad", allowRoots: [fixture.root] }),
      );
      try {
        const badPolicy = await callTool(pair.client, "causoryn_check_architecture", {});
        const error = expectErrorOf(badPolicy);
        expect(error.code).toBe("POLICY_INVALID");
        expect(error.retryable).toBe(false);

        const policyId = await callTool(pair.client, "causoryn_check_architecture", {
          policyId: "secili-politika",
        });
        expect(expectErrorOf(policyId).code).toBe("INVALID_ARGUMENT");

        const scope = await callTool(pair.client, "causoryn_check_architecture", {
          scope: "modules",
        });
        expect(expectErrorOf(scope).code).toBe("INVALID_ARGUMENT");

        const authz = await callTool(pair.client, "causoryn_check_architecture", {
          workspaceId: "baska-workspace",
        });
        expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("negatif: policy dosyası config.maxFileBytes tavanını aşarsa LIMIT_EXCEEDED (TŞ §20 dosya başına byte bütçesi)", async () => {
    // Takım denetimi bulgusu: policy/baseline okuması boyut bütçesi olmadan
    // tam belleğe okunuyordu; TŞ §19 gereği depo dosyası güvenilmez girdidir
    // ve TŞ §20 "dosya başına byte" resource bütçesi uygulanmalıdır.
    const fixture = makeGuardFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "guard-big",
          allowRoots: [fixture.root],
          // Policy dosyası (~350 byte) bu tavanı aşıyor; indeksleme aynı
          // tavanla kaynakları atlar ve snapshot partial yayınlar (yeterli).
          maxFileBytes: 128,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_check_architecture", {});
        const error = expectErrorOf(result);
        expect(error.code).toBe("LIMIT_EXCEEDED");
        expect(JSON.stringify(error.message)).toContain("maxFileBytes");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("partial: policy dosyası yok → POLICY_INVALID yönlendirmesi; ihlal yoksa boş findings + uyarı", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-guard-nopolicy-"));
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard-none", allowRoots: [emptyRoot] }),
      );
      try {
        const missing = await callTool(pair.client, "causoryn_check_architecture", {});
        const error = expectErrorOf(missing);
        expect(error.code).toBe("POLICY_INVALID");
        expect(JSON.stringify(error.message)).toContain("architecture.rules.yaml");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }

    // İhlal üretmeyen kural: bulgu boş; yönetişim yüzeyi çalışır.
    const fixture = makeGuardFixture({
      policyYaml: [
        "version: 1",
        "rules:",
        "  - id: services-must-not-call-repositories",
        "    type: forbidden-dependency",
        '    from: "**/services/**"',
        '    to: "**/yok-boyle-dizin/**"',
        "    edgeKinds: [CALLS]",
        "    severity: error",
        "",
      ].join("\n"),
    });
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard-clean", allowRoots: [fixture.root] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_check_architecture", {});
        const envelope = expectEnvelope(result);
        const data = envelope.data as Record<string, unknown>;
        expect(data.findings).toEqual([]);
        const summary = data.summary as Record<string, unknown>;
        expect(summary.findings).toBe(0);
        expect((envelope.warnings as string[]).some((w) => w.includes("ihlal"))).toBe(true);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C3 — causoryn_compare_architecture                                  */
/* ------------------------------------------------------------------ */

describe("causoryn_compare_architecture", { timeout: 30_000 }, () => {
  it("pozitif: git blob'larından içerik kümesi okunur; node/edge ek-çıkar sayıları deterministik", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "cmp",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "v2",
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        expect(envelope.snapshotId).toBeNull();

        const data = envelope.data as Record<string, unknown>;
        expect(data.baseRef).toBe("v1");
        expect(data.targetRef).toBe("v2");
        const diff = data.diff as Record<string, unknown>;
        const summary = diff.summary as Record<string, unknown>;
        expect(summary.added).toBe(2);
        expect(summary.removed).toBe(2);
        expect(summary.changed).toBe(0);
        // Tamamen ilgisiz isim/path/signature: rename İDDİA EDİLMEZ (TŞ §13).
        expect(summary.renamed).toBe(0);
        expect(summary.uncertain).toBe(0);
        expect(summary.unchangedNodes).toBe(0);
        expect(summary.edgeAdded).toBe(1);
        expect(summary.edgeRemoved).toBe(1);
        expect(summary.apiSurfaceChanges).toBe(0);

        const added = diff.added as Array<Record<string, unknown>>;
        expect(added.map((n) => (n.node as Record<string, unknown>).qualifiedName).sort())
          .toEqual(["BetaManager", "BetaManager.manage"]);
        const removed = diff.removed as Array<Record<string, unknown>>;
        expect(removed.map((n) => (n.node as Record<string, unknown>).qualifiedName).sort())
          .toEqual(["AlphaService", "AlphaService.create"]);

        const repeat = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "v2",
        });
        expect(expectEnvelope(repeat).data).toEqual(data);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("negatif: çözümlenemeyen ref → INVALID_REVISION; refs+range birlikte → INVALID_ARGUMENT", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "cmp-bad",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const unknownRef = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "yok-boyle-tag",
        });
        const error = expectErrorOf(unknownRef);
        expect(error.code).toBe("INVALID_REVISION");
        expect(JSON.stringify(error.message)).toContain("yok-boyle-tag");

        const badPattern = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "-p",
        });
        expect(expectErrorOf(badPattern).code).toBe("INVALID_ARGUMENT");

        // compare şeması TŞ §10.2'ye sadıktır (baseRef/targetRef); fazladan
        // refs alanı strictObject şemasından protokol düzeyinde geçmez.
        const extraneous = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "v2",
          refs: ["v1", "v2"],
        });
        expect(extraneous.isError).toBe(true);
        expect(extraneous.structuredContent).toBeUndefined();

        const authz = await callTool(pair.client, "causoryn_compare_architecture", {
          workspaceId: "baska-workspace",
          baseRef: "v1",
          targetRef: "v2",
        });
        expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("partial: içerik aynı iki revizyon → tüm sayılar sıfır; unchangedNodes gerçek küçük-üçlü taşır", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "cmp-same",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_compare_architecture", {
          baseRef: "v1",
          targetRef: "v1-same",
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const diff = (envelope.data as Record<string, unknown>).diff as Record<string, unknown>;
        const summary = diff.summary as Record<string, unknown>;
        expect(summary.added).toBe(0);
        expect(summary.removed).toBe(0);
        expect(summary.changed).toBe(0);
        expect(summary.renamed).toBe(0);
        expect(summary.uncertain).toBe(0);
        expect(summary.unchangedNodes).toBe(2);
        expect(summary.edgeAdded).toBe(0);
        expect(summary.edgeRemoved).toBe(0);
        expect(summary.edgeUnchanged).toBe(1);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C4 — causoryn_get_agent_context                                     */
/* ------------------------------------------------------------------ */

describe("causoryn_get_agent_context", { timeout: 30_000 }, () => {
  it("pozitif: görev metni arama sorgusu olarak çalışır; paket + muhasebe alanları dolu", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "save order repository",
        tokenBudget: 2048,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).not.toBeNull();

      const data = envelope.data as Record<string, unknown>;
      const tokens = data.queryTokens as string[];
      expect(tokens.length).toBeGreaterThan(0);
      expect(data.tokenBudget).toBe(2048);
      const items = data.contextItems as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect((data.candidateCount as number)).toBeGreaterThanOrEqual(items.length);
      expect((data.estimatedTokens as number)).toBeGreaterThan(0);
      expect(data.estimatedTokens).toBeLessThanOrEqual(2048);
      const legs = data.legsApplied as string[];
      expect(legs).toContain("exact-symbol");
      const degraded = data.degradedLegs as Array<Record<string, unknown>>;
      expect(degraded.map((d) => d.leg)).toContain("fts");
      for (const item of items) {
        expect(typeof item.nodeId).toBe("string");
        expect(typeof item.qualifiedName).toBe("string");
        expect((item.evidenceIds as string[]).length).toBeGreaterThanOrEqual(0);
        expect((item.reason as string).length).toBeGreaterThan(0);
        expect((item.estimatedTokens as number)).toBeGreaterThan(0);
        // TŞ §15: görev metni çıktıya yazılmaz (yalnızca arama verisi).
        expect(JSON.stringify(item)).not.toContain("save order repository");
      }

      const repeat = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "save order repository",
        tokenBudget: 2048,
      });
      expect(expectEnvelope(repeat).data).toEqual(data);
    } finally {
      await pair.close();
    }
  });

  it("negatif: boş görev metni reddedilir; tokenBudget zorunlu (TŞ §10.2 ?siz); candidateScope bu dilimde INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      // Tam boş metin şema düzeyinde reddedilir (protokol isError).
      const emptyTask = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "",
      });
      expect(emptyTask.isError).toBe(true);
      expect(emptyTask.structuredContent).toBeUndefined();

      // Takım denetimi bulgusu: TŞ §10.2 satırı "task, candidateScope?,
      // tokenBudget" — tokenBudget'ta ? YOK (zorunlu alan); yüzey şeması da
      // zorunludur (çekirdek default'u 2048 araç yüzeyinde açılmaz).
      const missingBudget = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "görev",
      });
      expect(missingBudget.isError).toBe(true);
      expect(missingBudget.structuredContent).toBeUndefined();

      // Yalnızca boşluklu metin şemayı geçer; çekirdek sözleşmesi (task boş
      // olmayan arama verisi olmalı) envelope düzeyinde INVALID_ARGUMENT döner.
      const blankTask = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "   ",
        tokenBudget: 2048,
      });
      expect(expectErrorOf(blankTask).code).toBe("INVALID_ARGUMENT");

      const zeroBudget = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "görev",
        tokenBudget: 0,
      });
      expect(zeroBudget.isError).toBe(true);

      const candidateScope = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "görev",
        tokenBudget: 2048,
        candidateScope: "src/**",
      });
      const error = expectErrorOf(candidateScope);
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(JSON.stringify(error.message)).toContain("candidateScope");

      const authz = await callTool(pair.client, "causoryn_get_agent_context", {
        workspaceId: "baska-workspace",
        task: "görev",
        tokenBudget: 2048,
      });
      expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await pair.close();
    }
  });

  it("partial: tokenBudget=1 → tüm adaylar pakete sığmaz (omittedCount) + contract/fts ayakları degrade", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_agent_context", {
        task: "save order repository",
        tokenBudget: 1,
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      expect(data.tokenBudget).toBe(1);
      expect((data.contextItems as unknown[]).length).toBe(0);
      expect((data.omittedCount as number)).toBeGreaterThan(0);
      expect(data.omittedCount).toBe(data.candidateCount);
      const rationales = data.rationales as string[];
      expect(rationales.length).toBeGreaterThanOrEqual(1);
      const degraded = data.degradedLegs as Array<Record<string, unknown>>;
      const legs = degraded.map((d) => d.leg);
      expect(legs).toContain("contract");
      expect(legs).toContain("fts");
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C5 — causoryn_generate_onboarding                                   */
/* ------------------------------------------------------------------ */

describe("causoryn_generate_onboarding", { timeout: 30_000 }, () => {
  it("pozitif: audience=beginner profilini üretir; giriş noktaları + öğrenme sırası yapısal veri", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_generate_onboarding", {
        audience: "beginner",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.profile).toBe("beginner");
      expect(data.snapshotId).toBe(envelope.snapshotId);

      const entryPoints = data.entryPoints as Array<Record<string, unknown>>;
      expect(entryPoints.length).toBeGreaterThanOrEqual(1);
      expect(
        entryPoints.map((e) => e.qualifiedName as string),
      ).toContain("POST /orders");

      const topModules = data.topModules as Array<Record<string, unknown>>;
      expect(topModules.length).toBeLessThanOrEqual(5);
      for (const module of topModules) {
        expect(typeof (module.degree as number)).toBe("number");
        expect(typeof (module.centrality as number)).toBe("number");
      }
      const learningOrder = data.learningOrder as Array<Record<string, unknown>>;
      expect(learningOrder.length).toBeGreaterThanOrEqual(1);
      expect(learningOrder[0]?.order).toBe(1);

      const repeat = await callTool(pair.client, "causoryn_generate_onboarding", {
        audience: "beginner",
      });
      expect(expectEnvelope(repeat).data).toEqual(data);
    } finally {
      await pair.close();
    }
  });

  it("negatif: bilinmeyen audience şemadan reddedilir; geçersiz limits → INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const badAudience = await callTool(pair.client, "causoryn_generate_onboarding", {
        audience: "expert",
      });
      expect(badAudience.isError).toBe(true);
      expect(badAudience.structuredContent).toBeUndefined();

      const focus = await callTool(pair.client, "causoryn_generate_onboarding", {
        audience: "beginner",
        focus: "src/services",
      });
      expect(expectErrorOf(focus).code).toBe("INVALID_ARGUMENT");

      const zeroLimit = await callTool(pair.client, "causoryn_generate_onboarding", {
        audience: "beginner",
        limits: { maxLearningSteps: 0 },
      });
      // limits pozitif tam sayı şeması: 0 protokol düzeyinde reddedilir.
      expect(zeroLimit.isError).toBe(true);
      expect(zeroLimit.structuredContent).toBeUndefined();

      const authz = await callTool(pair.client, "causoryn_generate_onboarding", {
        workspaceId: "baska-workspace",
        audience: "beginner",
      });
      expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await pair.close();
    }
  });

  it("partial: boş workspace → no-entry-endpoint uyarısı; bölüm boş ama rapor anahtarları tam", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-onboarding-empty-"));
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "ob-empty", allowRoots: [emptyRoot] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_generate_onboarding", {
          audience: "maintainer",
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("partial");
        const data = envelope.data as Record<string, unknown>;
        expect(data.profile).toBe("maintainer");
        expect(data.entryPoints).toEqual([]);
        const warnings = data.warnings as Array<Record<string, unknown>>;
        expect(warnings.map((w) => w.code)).toContain("onboarding/no-entry-endpoint");
        // Tüm bölümler anahtar olarak bulunur (boş dizi sözleşmesi).
        for (const key of [
          "topModules",
          "learningOrder",
          "criticalFlows",
          "tests",
          "unknownEdges",
          "riskAreas",
        ]) {
          expect(Array.isArray(data[key]), `bölüm eksik: ${key}`).toBe(true);
        }
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* C6 — causoryn_export_documentation                                  */
/* ------------------------------------------------------------------ */

describe("causoryn_export_documentation", { timeout: 30_000 }, () => {
  it("pozitif: izinli output dizinine JSON export; atomik yazma diskinde doğrulanır", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-out-"));
    try {
      const pair = await connectClient(
        makeContext({ output: { allowedOutputDirs: [outDir] } }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_export_documentation", {
          format: "json",
          outputDir: outDir,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const data = envelope.data as Record<string, unknown>;
        expect(data.format).toBe("json");
        expect(data.atomic).toBe(true);
        expect((data.bytes as number)).toBeGreaterThan(0);
        const writtenPath = data.path as string;
        expect(existsSync(writtenPath)).toBe(true);
        // Yazılan dosya yayınlanmış snapshot'ın canonical JSON'udur.
        const written = JSON.parse(readFileSync(writtenPath, "utf8")) as Record<string, unknown>;
        const meta = written.meta as Record<string, unknown>;
        expect(meta.id).toBe(envelope.snapshotId);
        expect(existsSync(`${writtenPath}.tmp`)).toBe(false);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("negatif: beyanlı olmayan output dizini → EXPORT_NOT_ALLOWED (TŞ §10.1 sabit kod; yazma olmaz); view bu dilimde INVALID_ARGUMENT", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-out-"));
    const foreignDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-foreign-"));
    try {
      const pair = await connectClient(
        makeContext({ output: { allowedOutputDirs: [outDir] } }),
      );
      try {
        // Takım denetimi bulgusu: TŞ §10.1 sabit listesinde EXPORT_NOT_ALLOWED
        // VAR (raw PDF s.9); "beyanlı output listesinde değil" senaryosu tam
        // bu kodun karşılığıdır — yeni uzantı kodu K-008 örüntüsünün
        // önkoşulunu ("TŞ listesinde uygun kod yok") ihlal ederdi.
        const notAllowed = await callTool(pair.client, "causoryn_export_documentation", {
          format: "json",
          outputDir: foreignDir,
        });
        const error = expectErrorOf(notAllowed);
        expect(error.code).toBe("EXPORT_NOT_ALLOWED");
        expect(error.retryable).toBe(false);
        expect(existsSync(path.join(foreignDir, "causoryn-architecture.json"))).toBe(false);

        // Beyan hiç yoksa (default deny) da aynı sabit kod döner.
        const pairNoDeclaration = await connectClient(makeContext({}));
        try {
          const noDeclaration = await callTool(
            pairNoDeclaration.client,
            "causoryn_export_documentation",
            { format: "json", outputDir: foreignDir },
          );
          expect(expectErrorOf(noDeclaration).code).toBe("EXPORT_NOT_ALLOWED");
        } finally {
          await pairNoDeclaration.close();
        }

        const wikiView = await callTool(pair.client, "causoryn_export_documentation", {
          format: "json",
          outputDir: outDir,
          view: "wiki",
        });
        expect(expectErrorOf(wikiView).code).toBe("INVALID_ARGUMENT");

        const authz = await callTool(pair.client, "causoryn_export_documentation", {
          workspaceId: "baska-workspace",
          format: "json",
          outputDir: outDir,
        });
        expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(foreignDir, { recursive: true, force: true });
    }
  });

  it("partial: fileName ile markdown export; ayraçlı dosya adı → PATH_DENIED", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-out-"));
    try {
      const pair = await connectClient(
        makeContext({ output: { allowedOutputDirs: [outDir] } }),
      );
      try {
        const custom = await callTool(pair.client, "causoryn_export_documentation", {
          format: "markdown",
          outputDir: outDir,
          fileName: "mimari-belge.md",
        });
        const envelope = expectEnvelope(custom);
        const data = envelope.data as Record<string, unknown>;
        expect(data.format).toBe("markdown");
        expect(path.basename(data.path as string)).toBe("mimari-belge.md");
        const content = readFileSync(data.path as string, "utf8");
        expect(content.startsWith("# Causoryn Architecture Documentation")).toBe(true);
        // Snapshot gerçek tablo satırları içerir (escape edilmiş hücreler).
        expect(content).toContain("OrdersService.create");

        const traversal = await callTool(pair.client, "causoryn_export_documentation", {
          format: "json",
          outputDir: outDir,
          fileName: "alt/kaçak.json",
        });
        expect(expectErrorOf(traversal).code).toBe("PATH_DENIED");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* C7 — causoryn_architecture_timeline                                 */
/* ------------------------------------------------------------------ */

describe("causoryn_architecture_timeline", { timeout: 30_000 }, () => {
  it("pozitif: refs noktaları analyze edilir; ardışık diff özetleri compare'den türetilir", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "tl",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "v2"],
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        expect(envelope.snapshotId).toBeNull();

        const data = envelope.data as Record<string, unknown>;
        const timeline = data.timeline as Record<string, unknown>;
        expect(timeline.requestedPoints).toBe(2);
        expect(timeline.analyzedPoints).toBe(2);
        expect(timeline.unanalyzedPoints).toBe(0);
        const points = timeline.points as Array<Record<string, unknown>>;
        expect(points.map((p) => p.ref)).toEqual(["v1", "v2"]);
        expect(points[0]?.nodeCount).toBe(2);
        expect(points[1]?.nodeCount).toBe(2);

        const intervals = timeline.intervals as Array<Record<string, unknown>>;
        expect(intervals).toHaveLength(1);
        expect(intervals[0]?.kind).toBe("diff");
        const changes = intervals[0]?.changes as Record<string, unknown>;
        expect(changes.added).toBe(2);
        expect(changes.removed).toBe(2);
        expect(changes.unchangedNodes).toBe(0);

        const sampling = timeline.sampling as Record<string, unknown>;
        expect(sampling.applied).toBe(false);

        const repeat = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "v2"],
        });
        expect(expectEnvelope(repeat).data).toEqual(data);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("negatif: refs+range birlikte / tek ref / aralık kökü → INVALID_ARGUMENT veya INVALID_REVISION", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "tl-bad",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const both = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "v2"],
          range: { from: "v1", to: "v2" },
        });
        expect(expectErrorOf(both).code).toBe("INVALID_ARGUMENT");

        const single = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1"],
        });
        // refs şema minimumu 2: tek ref protokol düzeyinde reddedilir.
        expect(single.isError).toBe(true);
        expect(single.structuredContent).toBeUndefined();

        const unknownRef = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "yok-boyle-tag"],
        });
        expect(expectErrorOf(unknownRef).code).toBe("INVALID_REVISION");

        const badRange = await callTool(pair.client, "causoryn_architecture_timeline", {
          range: { from: "v2", to: "v1" },
        });
        expect(expectErrorOf(badRange).code).toBe("INVALID_REVISION");

        const granularity = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "v2"],
          granularity: "milestone",
        });
        expect(expectErrorOf(granularity).code).toBe("INVALID_ARGUMENT");

        const authz = await callTool(pair.client, "causoryn_architecture_timeline", {
          workspaceId: "baska-workspace",
          refs: ["v1", "v2"],
        });
        expect(expectErrorOf(authz).code).toBe("WORKSPACE_NOT_AUTHORIZED");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("partial: maxRevisions örnekleme atlanan noktaları açık raporlar; blob'suz noktalar unanalyzed kalır", async () => {
    const fixture = makeGitFixture();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "tl-sample",
          allowRoots: [fixture.root],
          autoIndex: false,
        }),
      );
      try {
        const sampled = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["v1", "v3", "v2"],
          maxRevisions: 2,
        });
        const envelope = expectEnvelope(sampled);
        const timeline = (envelope.data as Record<string, unknown>)
          .timeline as Record<string, unknown>;
        const sampling = timeline.sampling as Record<string, unknown>;
        expect(sampling.applied).toBe(true);
        expect(sampling.selectedCount).toBe(2);
        const skipped = sampling.skipped as Array<Record<string, unknown>>;
        expect(skipped).toEqual([{ sourceIndex: 1, ref: "v3" }]);
        // Seçilen uçlar korunur: v1 → v2 diff'i.
        const points = timeline.points as Array<Record<string, unknown>>;
        expect(points.map((p) => p.ref)).toEqual(["v1", "v2"]);
        const intervals = timeline.intervals as Array<Record<string, unknown>>;
        expect(intervals[0]?.kind).toBe("diff");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }

    // Blob'suz depo: hiçbir nokta analiz edilemez; sayı UYDURULMAZ.
    const bare = makeGitFixtureWithoutBlobs();
    try {
      const pair = await connectClient(
        makeContext({
          workspaceId: "tl-bare",
          allowRoots: [bare.root],
          autoIndex: false,
        }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_architecture_timeline", {
          refs: ["t1", "t2"],
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const timeline = (envelope.data as Record<string, unknown>)
          .timeline as Record<string, unknown>;
        expect(timeline.analyzedPoints).toBe(0);
        expect(timeline.unanalyzedPoints).toBe(2);
        const points = timeline.points as Array<Record<string, unknown>>;
        for (const point of points) {
          expect(point.status).toBe("unanalyzed");
          expect(String(point.unanalyzedReason)).toContain("manifest-not-found");
          expect(point.nodeCount).toBeUndefined();
        }
        const intervals = timeline.intervals as Array<Record<string, unknown>>;
        expect(intervals[0]?.kind).toBe("unanalyzed-interval");
        const reasons = (intervals[0]?.reasons ?? {}) as Record<string, unknown>;
        expect(String(reasons.from)).toContain("manifest-not-found");
        expect(String(reasons.to)).toContain("manifest-not-found");
      } finally {
        await pair.close();
      }
    } finally {
      bare.cleanup();
    }
  });
});
