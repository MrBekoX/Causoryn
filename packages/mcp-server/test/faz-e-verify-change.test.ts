import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { nodeId } from "@causoryn/domain";
import { describe, expect, it } from "vitest";

/**
 * Faz E MCP yüzeyi testleri — sprint-6 causoryn_verify_change (29. araç).
 *
 * Kanıt: TŞ v2.1 §10.2 (Sayfa 10 araç katalog satırı — PyMuPDF çıkarımı,
 * raw/Causoryn_Teknik_Dokuman_v2.1.pdf): "causoryn_verify_change |
 * preflightId/baseSnapshot, target | Agent Change Guard, post-change kanıt";
 * §10.4 (Sayfa 11): girdi {preflightId, targetRevision: "working-tree",
 * checks: [architecture, contracts, graph-diff, test-plan]}; dürüstlük
 * hükmü: "no_findings güvenli/correct kod garantisi değildir. Test runner
 * varsayılan kurulmaz veya otomatik çalıştırılmaz." Çekirdek: packages/
 * verification (E1-E3 verifyChange saf çekirdeği).
 *
 * Sprint kapısı (wiki/sprint-6.md çıkış kriteri): aynı working-tree + aynı
 * baseSnapshot → byte-deterministik verify raporu; testler koşulmadıysa
 * rapor ASLA "geçti" demez. Test üçlüsü:
 * - POZİTİF : tmp fixture'ta index → preflight_change (manifest depoya
 *             düşer) → dosya değişikliği → verify ×2 → iki koşumda
 *             bit-bit aynı data + reportId; tests.state=not_run +
 *             raporda "geçti" kelimesi YOK.
 * - NEGATİF : bilinmeyen preflightId → INVALID_ARGUMENT (D4 hata eşleme
 *             disiplini: verification/preflight-not-found → INVALID_
 *             ARGUMENT; yeni uzantı kodu basılmaz); preflightId ↔
 *             baseSnapshot uyumsuz → INVALID_ARGUMENT; şema reddi
 *             (targetRevision ≠ "working-tree") → protokol düzeyi isError.
 * - PARTIAL : contracts istenir ama D2/D3 girdisi MCP yüzeyinden
 *             üretilemez → check not_evaluated → verdict inconclusive
 *             + incompleteChecks (tamamlanmamış değerlendirme
 *             review_required izlenimi VERMEZ — TŞ §10.4).
 *
 * Kırmızı çizgi uyumu: examples/ fixture'ları salt okunur olduğundan
 * (ADR-008) tüm yazma os.tmpdir() altındaki geçici fixture'tadır; test
 * sonunda silinir. verify_change çalışma ağacına YAZMAZ: working-tree
 * projeksiyonu atık InMemory repository'ye üretilir (gerçek repo ve
 * kaynak ağaç değişmez); ikinci manuel snapshot yalnızca uyumsuzluk
 * negatifinin karşı kimliği için test donanımıdır.
 */

import {
  CAUSORYN_TOOL_ERROR_CODES,
  EnvelopeSchema,
  TOOL_NAMES,
  VERIFICATION_TOOL_ERROR_CODES_USED,
  VerifyChangeDataSchema,
  VerifyChangeInputSchema,
  createCausorynContext,
  createCausorynMcpServer,
  verificationErrorToToolError,
  verifyChangeTool,
} from "../src/index.js";
import { VerificationError } from "@causoryn/verification";
import type { CausorynContext } from "../src/index.js";

/** Sabit saat: yayın + projeksiyon determinizminin çapası. */
const FIXED_NOW = "2026-11-08T09:00:00.000Z";
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
  const client = new Client({ name: "vitest-faz-e-client", version: "0.0.0" });
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

/** preflight sonucunun data alanını EnvelopeSchema ile çıkarır. */
function preflightDataOf(result: CallToolResult): Record<string, unknown> {
  return expectEnvelope(result).data as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Geçici TS fixture (salt-okunur examples/ yerine; ADR-008)            */
/* ------------------------------------------------------------------ */

const REPO_TS = `export class OrderRepository {
  find(id: string): string {
    return id;
  }
}
`;

const SERVICE_TS = `import { OrderRepository } from "./order-repo.js";

export class OrderService {
  private readonly repo: OrderRepository;

  constructor(repo: OrderRepository) {
    this.repo = repo;
  }

  place(id: string): string {
    return this.repo.find(id);
  }
}
`;

const TEST_TS = `import { OrderService } from "../src/order-service.js";
import { OrderRepository } from "../src/order-repo.js";

export function makeDefaultOrderService(): OrderService {
  return new OrderService(new OrderRepository());
}
`;

/** Temiz policy: src → tests CALLS yasak (fixture'ta asla ihlal edilmez). */
const POLICY_YAML = `version: 1
rules:
  - id: src-must-not-call-tests
    type: forbidden-dependency
    severity: error
    from: "**/src/**"
    to: "**/tests/**"
    edgeKinds: [CALLS]
`;

interface FixturePaths {
  readonly root: string;
  readonly repoTs: string;
  readonly serviceTs: string;
  readonly legacyDir: string;
}

function writeFixture(root: string): FixturePaths {
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  mkdirSync(path.join(root, ".causoryn"), { recursive: true });
  const repoTs = path.join(root, "src", "order-repo.ts");
  const serviceTs = path.join(root, "src", "order-service.ts");
  writeFileSync(repoTs, REPO_TS);
  writeFileSync(serviceTs, SERVICE_TS);
  writeFileSync(path.join(root, "tests", "order-service.test.ts"), TEST_TS);
  writeFileSync(path.join(root, ".causoryn", "architecture.rules.yaml"), POLICY_YAML);
  return { root, repoTs, serviceTs, legacyDir: path.join(root, "src", "legacy") };
}

function makeContext(allowRoot: string, autoIndex = true): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [allowRoot],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex,
    },
    { clock: fixedClock },
  );
}

/* ------------------------------------------------------------------ */
/* Katalog: 29. araç                                                   */
/* ------------------------------------------------------------------ */

describe("causoryn_verify_change araç kaydı (29. araç)", () => {
  it("BAĞLANTI: VERIFICATION_TOOL_ERROR_CODES_USED üyeleri CAUSORYN_TOOL_ERROR_CODES sabit kümesinin alt kümesidir (bütünlük)", () => {
    // Sprint-6 takım denetimi bulgusu 2: belgeleme amaçlı sabit, canlı hata
    // kodu tablosuyla bağlanmadan bırakılmıştı — bu test bütünlüğü kilitler:
    // servis yüzeyinin verebileceğini BEYAN ettiği her kod, errors.ts'teki
    // gerçek CAUSORYN_TOOL_ERROR_CODES üyesi olmalıdır (yeni uzantı kodu
    // basılamaz — K-008 disiplini; üye kümesi saparsa test kırılır).
    expect(VERIFICATION_TOOL_ERROR_CODES_USED.length).toBeGreaterThan(0);
    for (const code of VERIFICATION_TOOL_ERROR_CODES_USED) {
      expect(CAUSORYN_TOOL_ERROR_CODES, `bilinmeyen sabit kod beyanı: ${code}`).toContain(code);
    }
    // Eşleme fonksiyonunun gerçekten ürettiği kodlar beyanla örtüşmeli:
    // verificationErrorToToolError örneklerini tabloya karşı doğrula.
    const emitted = new Set(
      [
        new VerificationError("verification/invalid-input", "test"),
        new VerificationError("verification/preflight-not-found", "test"),
        new VerificationError("verification/file-not-authorized", "test"),
        new VerificationError("verification/snapshot-state", "test"),
      ].map((error) => verificationErrorToToolError(error).code),
    );
    for (const code of emitted) {
      expect(CAUSORYN_TOOL_ERROR_CODES).toContain(code);
      expect(VERIFICATION_TOOL_ERROR_CODES_USED).toContain(code);
    }
  });

  it("POZİTİF: tools/list 29 aracı sunar; verify_change TŞ §10.2 katalog sırasındadır", async () => {
    const pair = await connectClient(makeContext(os.tmpdir(), false));
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((t) => t.name)).toContain("causoryn_verify_change");
      // Katalog sırası (TŞ §10.2 PDF s.10): detect_contract_drift →
      // verify_change → derive_test_plan.
      const driftIndex = TOOL_NAMES.indexOf("causoryn_detect_contract_drift");
      const verifyIndex = TOOL_NAMES.indexOf("causoryn_verify_change");
      const deriveIndex = TOOL_NAMES.indexOf("causoryn_derive_test_plan");
      expect(verifyIndex).toBe(driftIndex + 1);
      expect(deriveIndex).toBe(verifyIndex + 1);
      expect(TOOL_NAMES).toHaveLength(29);
      const verifyTool = tools.find((t) => t.name === "causoryn_verify_change");
      expect(verifyTool?.inputSchema).toBeDefined();
      expect(verifyTool?.outputSchema).toBeDefined();
      // English-first description contract: read-only verification without running tests.
      expect(verifyTool?.description).toMatch(/read-only/i);
      expect(verifyTool?.description).toMatch(/verify/i);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Sprint kapısı: pozitif + byte-determinizm + not_run dürüstlüğü       */
/* ------------------------------------------------------------------ */

describe("causoryn_verify_change sprint kapısı", () => {
  it("POZİTİF: preflight → değişiklik → verify ×2 → bit-bit aynı rapor; tests not_run + raporda 'geçti' yok", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-e-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        // 1) Preflight manifest üret (depo: context.preflightStore).
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "order repo imza değişikliği sonrası doğrulama",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightEnvelope = expectEnvelope(preflightResult);
        const preflightId = preflightEnvelope.data
          ? (preflightDataOf(preflightResult).preflightId as string)
          : "";
        expect(preflightId).toMatch(/^preflight:[0-9a-f]{64}$/);
        const baseSnapshotId = preflightDataOf(preflightResult).baseSnapshotId as string;

        // 2) Değişiklik yap: repo dosyasına yeni metot gövdesi (graph-diff görür).
        writeFileSync(
          fixture.repoTs,
          REPO_TS.replace("    return id;", '    return id.trim().length > 0 ? id : "";'),
        );

        // 3) verify ×2 — aynı girdiyle iki koşum (sprint kapısı).
        const verifyArgs = {
          preflightId,
          checks: ["architecture", "graph-diff", "test-plan"],
        };
        const first = await callTool(pair.client, "causoryn_verify_change", verifyArgs);
        const firstEnvelope = expectEnvelope(first);
        expect(firstEnvelope.status).toBe("ok");
        const firstData = VerifyChangeDataSchema.parse(firstEnvelope.data);

        // TŞ §10.4 üst düzey alanlar: baseSnapshotId/targetSnapshotId/verdict.
        expect(firstData.baseSnapshotId).toBe(baseSnapshotId);
        expect(firstData.targetSnapshotId).toMatch(/^snapshot:[0-9a-f]{64}$/);
        expect(firstData.targetSnapshotId).not.toBe(baseSnapshotId);
        expect(firstData.preflightId).toBe(preflightId);
        expect(firstData.targetRevision).toBe("working-tree");
        // İstenen denetimler kanonik sırada; üçü de evaluated (contracts
        // istenmedi — MCP yüzeyi D2/D3 girdisi olmadan üretmez).
        expect(firstData.requestedChecks).toEqual(["architecture", "graph-diff", "test-plan"]);
        expect(firstData.checks.architecture.status).toBe("evaluated");
        expect(firstData.checks.graphDiff.status).toBe("evaluated");
        expect(firstData.checks.testPlan.status).toBe("evaluated");
        // Temiz ağaç + temiz policy → no_findings; disclaimers ZORUNLU eşlik.
        expect(firstData.verdict).toBe("no_findings");
        expect(firstData.verdictRationale[0]?.rule).toBe("clean-and-resolved");
        expect(firstData.incompleteChecks).toEqual([]);
        expect(firstData.disclaimers.length).toBeGreaterThan(0);

        // E3 dürüstlük: tests.state=not_run (TŞ §10.4 alan sadakati);
        // rapor/'passed' iddiası YOK.
        expect(firstData.tests.state).toBe("not_run");
        expect(firstData.tests.observedCount).toBe(0);
        expect(firstData.checks.testPlan.run.state).toBe("not_run");
        expect(firstData.checks.testPlan.recommendedCount).toBe(
          firstData.tests.recommendedCount,
        );
        // Adaylar vardır (naming: order-service ↔ order-service.test) ve
        // TAMAMI not_run'dır.
        expect(firstData.checks.testPlan.candidates.length).toBeGreaterThan(0);
        for (const candidateStatus of firstData.checks.testPlan.candidateStatuses) {
          expect(candidateStatus.status).toBe("not_run");
        }
        expect(JSON.stringify(firstData.tests)).not.toContain('"passed"');

        // SPRINT KAPISI 1: not_run adaylı raporda "geçti" kelimesi YOK.
        const serialized = JSON.stringify(firstEnvelope.data);
        expect(serialized).not.toContain("geçti");
        expect(serialized).not.toMatch(/\bpassed\b/i);

        // TŞ §10.4 alan sadakati (PDF s.11, sprint-6 takım denetimi
        // bulgusu): yayınlanan envelope gövdesi üst düzey bulgu alanını
        // "architectureFindings", koşum bloğu ayırıcısını "state" olarak
        // TAŞIR; eski üst düzey findings/tests.status sapması yoktur
        // (checks.architecture.findings check-içi yapıdır, meşrudur).
        const topLevelKeys = Object.keys(firstEnvelope.data as Record<string, unknown>);
        expect(topLevelKeys).toContain("architectureFindings");
        expect(topLevelKeys).not.toContain("findings");
        expect(serialized).toContain('"tests":{"state":"not_run"');
        expect(serialized).not.toContain('"tests":{"status"');
        expect(Object.keys(firstData.tests).sort()).toEqual([
          "observedCount",
          "recommendedCount",
          "state",
        ]);

        // SPRINT KAPISI 2: aynı girdiyle ikinci koşum → bit-bit aynı data.
        const second = await callTool(pair.client, "causoryn_verify_change", verifyArgs);
        const secondEnvelope = expectEnvelope(second);
        expect(JSON.stringify(secondEnvelope.data)).toBe(JSON.stringify(firstEnvelope.data));
        expect(secondEnvelope.snapshotId).toBe(firstEnvelope.snapshotId);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("POZİTİF: guard error bulgusu (yasak legacy import) → blocking_findings + bulgu kanıtı", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-block-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "legacy helper bağlantısı ekleniyor",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightId = preflightDataOf(preflightResult).preflightId as string;

        // Değişiklik: src/legacy/old-helper.ts ekle + yasak import bağla.
        mkdirSync(fixture.legacyDir, { recursive: true });
        writeFileSync(
          path.join(fixture.legacyDir, "old-helper.ts"),
          'export function oldShim(): string {\n  return "legacy";\n}\n',
        );
        writeFileSync(
          fixture.serviceTs,
          'import { OrderRepository } from "./order-repo.js";\nimport { oldShim } from "./legacy/old-helper.js";\n\nexport class OrderService {\n  private readonly repo: OrderRepository;\n\n  constructor(repo: OrderRepository) {\n    this.repo = repo;\n  }\n\n  place(id: string): string {\n    return this.repo.find(id) + oldShim();\n  }\n}\n',
        );
        // Policy'ye legacy kuralı ekle (severity error → blocking_findings).
        writeFileSync(
          path.join(fixture.root, ".causoryn", "architecture.rules.yaml"),
          `${POLICY_YAML}  - id: src-must-not-import-legacy
    type: forbidden-dependency
    severity: error
    from: "**"
    to: "**/legacy/**"
    edgeKinds: [IMPORTS]
`,
        );

        const result = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          checks: ["architecture", "graph-diff", "test-plan"],
        });
        const envelope = expectEnvelope(result);
        const data = VerifyChangeDataSchema.parse(envelope.data);
        expect(data.verdict).toBe("blocking_findings");
        expect(data.verdictRationale[0]?.rule).toBe("blocking-finding");
        // TŞ §12 finding sözleşmesi raporda taşınır.
        expect(data.architectureFindings.length).toBeGreaterThan(0);
        const finding = data.architectureFindings[0] as unknown as Record<string, unknown>;
        expect(finding.ruleId).toBe("src-must-not-import-legacy");
        expect(finding.severity).toBe("error");
        expect(finding.suppressed).toBe(false);
        expect(Array.isArray(finding.evidenceIds)).toBe(true);
        expect(data.checks.architecture.findings.length).toBeGreaterThan(0);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* NEGATİF: bilinmeyen preflightId + uyumsuz çift + şema reddi          */
/* ------------------------------------------------------------------ */

describe("causoryn_verify_change negatif yollar", () => {
  it("NEGATİF: bilinmeyen preflightId → INVALID_ARGUMENT (D4 hata eşleme disiplini)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-neg-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const result = await callTool(pair.client, "causoryn_verify_change", {
          preflightId:
            "preflight:0000000000000000000000000000000000000000000000000000000000000000",
        });
        const error = expectErrorOf(result);
        expect(error.code).toBe("INVALID_ARGUMENT");
        expect(String(error.message)).toContain("preflight");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("NEGATİF: preflightId ↔ baseSnapshot uyumsuz → INVALID_ARGUMENT; hiçbori verilmezse girdi reddi", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-mix-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "hizalama testi",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightId = preflightDataOf(preflightResult).preflightId as string;
        const baseSnapshotId = preflightDataOf(preflightResult).baseSnapshotId as string;

        // Uyumlu çift: manifest.baseSnapshotId ile birlikte → rapor üretilir.
        const compatible = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          baseSnapshot: baseSnapshotId,
          checks: ["graph-diff"],
        });
        const compatibleData = VerifyChangeDataSchema.parse(expectEnvelope(compatible).data);
        expect(compatibleData.preflightId).toBe(preflightId);

        // Uyumsuz çift: GERÇEK ikinci snapshot'a karşı manifest — kimlikler
        // çelişir → INVALID_ARGUMENT (ikinci snapshot test donanımıyla
        // yayınlanır; beginBuild/publish wiki-tools.test.ts örüntüsü).
        const repo = pair.context.repository;
        const build = repo.beginBuild({
          workspaceId: "default",
          revision: { id: "manual-other", sequence: 2 },
          configHash: "cfg-faz-e-manual",
          analyzerFingerprint: "fp-faz-e-manual",
          createdAt: FIXED_NOW,
        });
        repo.addNode(build.buildId, {
          id: nodeId({ workspaceId: "default", kind: "Workspace", qualifiedName: "default" }),
          kind: "Workspace",
          qualifiedName: "default",
          attributes: { rootPath: fixture.root },
        });
        const other = repo.publish(build.buildId, "ready", FIXED_NOW);

        const mismatch = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          baseSnapshot: other.meta.id,
          checks: ["graph-diff"],
        });
        expect(expectErrorOf(mismatch).code).toBe("INVALID_ARGUMENT");

        // Hiçbiri verilmezse: en az biri zorunlu (TŞ §10.2 katalog satırı).
        const neither = await callTool(pair.client, "causoryn_verify_change", {});
        expect(expectErrorOf(neither).code).toBe("INVALID_ARGUMENT");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("NEGATİF: targetRevision ≠ working-tree şema reddi (protokol düzeyi isError)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-rev-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const result = await callTool(pair.client, "causoryn_verify_change", {
          targetRevision: "HEAD",
        });
        // Şema reddi SDK düzeyinde isError sonucudur (envelope DEĞİL).
        expect(result.isError).toBe(true);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("NEGATİF: bozuk .causoryn/architecture.rules.yaml → POLICY_INVALID (INTERNAL_ERROR değil; check_architecture sözleşmesi)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-pol-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "bozuk policy eşlemesi doğrulaması",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightId = preflightDataOf(preflightResult).preflightId as string;
        // Guard policy'yi şema reddi (GuardError guard/policy-yaml-invalid)
        // üretecek şekilde boz. services-verification.ts başlığı "şema reddi
        // ise POLICY_INVALID fırlatılır (check_architecture sözleşmesiyle
        // aynı)" sözü verir; söz bu yolda da dürüst olmalıdır.
        writeFileSync(
          path.join(fixture.root, ".causoryn", "architecture.rules.yaml"),
          "version: 1\nrules: [ { bozuk-yaml",
        );
        const result = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          checks: ["architecture"],
        });
        const error = expectErrorOf(result);
        // check_architecture sözleşmesi: şema reddi POLICY_INVALID + düzeltici
        // userAction (INTERNAL_ERROR değil — bulgu öncesi davranış buydu).
        expect(error.code).toBe("POLICY_INVALID");
        expect(String(error.userAction).length).toBeGreaterThan(0);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* PARTIAL: contracts değerlendirilemez → inconclusive                  */
/* ------------------------------------------------------------------ */

describe("causoryn_verify_change partial yollar", () => {
  it("PARTIAL: varsayılan checks ile contracts not_evaluated → verdict inconclusive + incompleteChecks", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-part-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "inconclusive senaryosu",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightId = preflightDataOf(preflightResult).preflightId as string;

        writeFileSync(
          fixture.repoTs,
          REPO_TS.replace("    return id;", '    return id ?? "";'),
        );

        // checks açıkça contracts ister → contracts MCP yüzeyinden spec çifti olmadan
        // üretilemez → not_evaluated → missing-input kuralı inconclusive verir.
        const result = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          checks: ["architecture", "contracts", "graph-diff", "test-plan"],
        });
        const envelope = expectEnvelope(result);
        const data = VerifyChangeDataSchema.parse(envelope.data);
        expect(data.verdict).toBe("inconclusive");
        expect(data.verdictRationale[0]?.rule).toBe("missing-input");
        expect(data.incompleteChecks).toEqual(["contracts"]);
        expect(data.checks.contracts.status).toBe("not_evaluated");
        // Dürüstlük: inconclusive kararı gerekçesiyle raporlanır; uydurma
        // "temiz" kararı yoktur (E2 kural zinciri).
        expect(String(data.verdictRationale[0]?.detail)).toContain("contracts");
        expect(data.unknowns.length).toBeGreaterThan(0);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* Servis düzeyi: baseSnapshot yolu + E3 observed yüzeyi                */
/* ------------------------------------------------------------------ */

describe("causoryn_verify_change servis düzeyi", () => {
  it("POZİTİF: baseSnapshot ile (preflightId'siz) doğrudan servis çağrısı rapor üretir", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-svc-"));
    try {
      const fixture = writeFixture(root);
      const context = makeContext(fixture.root);
      const pair = await connectClient(context);
      try {
        const latest = context.repository.getLatestPublished("default");
        expect(latest).toBeDefined();
        const baseSnapshotId = latest?.snapshot.meta.id as string;

        writeFileSync(
          fixture.repoTs,
          REPO_TS.replace("    return id;", "    return id.toLowerCase();"),
        );

        const report = await verifyChangeTool(
          pair.context,
          "req-verify-svc-1",
          VerifyChangeInputSchema.parse({
            baseSnapshot: baseSnapshotId,
            // contracts bu yüzden istenmez (MCP yüzeyi D2/D3 girdisi olmadan
            // üretmez); üç denetim evaluated → no_findings.
            checks: ["architecture", "graph-diff", "test-plan"],
          }),
        );
        expect(report.status).toBe("ok");
        const data = VerifyChangeDataSchema.parse(report.data);
        expect(data.baseSnapshotId).toBe(baseSnapshotId);
        expect(data.preflightId).toBeUndefined();
        expect(data.preflightAlignment).toBeUndefined();
        expect(data.verdict).toBe("no_findings");
        // Kapsam diff'ten türetilir (derivedFrom: graph-diff).
        expect(data.checks.testPlan.derivedFrom).toBe("graph-diff");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("POZİTİF: observedTestRun kanıtlı kaydı → tests observed + candidateStatus observed bağlaması", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-verify-obs-"));
    try {
      const fixture = writeFixture(root);
      const pair = await connectClient(makeContext(fixture.root));
      try {
        const preflightResult = await callTool(pair.client, "causoryn_preflight_change", {
          intent: "observed koşum kaydı yüzeyi",
          targetFiles: ["src/order-service.ts"],
        });
        const preflightId = preflightDataOf(preflightResult).preflightId as string;

        writeFileSync(
          fixture.repoTs,
          REPO_TS.replace("    return id;", "    return id.toUpperCase();"),
        );

        // Önce not_run koşumu: aday listesinden gerçek testQualifiedName al.
        const first = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          checks: ["test-plan"],
        });
        const firstData = VerifyChangeDataSchema.parse(expectEnvelope(first).data);
        const candidate = firstData.checks.testPlan.candidates[0] as unknown as Record<
          string,
          unknown
        >;
        expect(candidate).toBeDefined();
        const qualifiedName = candidate.testQualifiedName as string;

        // Host koşumu kanıtlı kaydet (evidenceRef ZORUNLU — E3 şeması).
        const second = await callTool(pair.client, "causoryn_verify_change", {
          preflightId,
          checks: ["test-plan"],
          observedTestRun: {
            state: "observed",
            evidenceRef: "reports/vitest-summary.json",
            observedCount: 1,
            passedCount: 1,
            failedCount: 0,
            testNames: [qualifiedName],
          },
        });
        const secondData = VerifyChangeDataSchema.parse(expectEnvelope(second).data);
        const tests = secondData.tests;
        expect(tests.state).toBe("host_asserted");
        if (tests.state !== "host_asserted") throw new Error("erişilemez: tests host_asserted değil");
        expect(tests.evidenceRef).toBe("reports/vitest-summary.json");
        // Dürüstlük: host beyanı motor doğrulaması değildir (engineVerified=false, hostAssertedPassed=true, passed anahtarı yok).
        expect(tests.engineVerified).toBe(false);
        expect(tests.hostAssertedPassed).toBe(true);
        expect("passed" in tests).toBe(false);
        const firstCandidateStatus = secondData.checks.testPlan.candidateStatuses[0] as unknown as
          | Record<string, unknown>
          | undefined;
        expect(firstCandidateStatus?.status).toBe("host_asserted");
        // host_asserted koşum kaydı limitation ile dürüstçe raporlanır (Causoryn
        // test çalıştırmaz; kayıt host beyanıdır).
        expect(
          secondData.limitations.some((limitation) => limitation.includes("host_asserted")),
        ).toBe(true);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
