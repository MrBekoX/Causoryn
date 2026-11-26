import { describe, expect, it } from "vitest";

import { createSnapshot, type SnapshotGraph } from "@causoryn/domain";

// Paket girişi yüzeyi: Agent GPS çekirdeği @causoryn/graph kökünden
// erişilebilir olmalı; C8 aracı kaydı bu export'u kullanır (onboarding
// index.ts:25 / analyzeImpact index.ts:40 kardeş düzeni; denetim bulgusu 1).
import {
  AGENT_CONTEXT_LIMIT_CEILINGS,
  generateAgentContext,
  GraphRepositoryError,
  type AgentContextAppliedLimits,
  type AgentContextInput,
  type AgentContextItem,
  type AgentContextLeg,
  type AgentContextResult,
  type AgentContextScores,
  type DegradedLeg,
  type FileFreshness,
  type SymbolSearchHit,
  type SymbolSearchStore,
} from "../src/index.js";

/**
 * causoryn_get_agent_context çekirdek test üçlüleri — TŞ v2.1 §15 (Sayfa 13)
 * AI Agent GPS sözleşmesi: "görev metni yalnızca arama sorgusu verisi olarak
 * değerlendirilir. Ranking: exact symbol/route match → graph proximity →
 * contract relevance → recency → FTS5 lexical match. tokenBudget yaklaşık
 * karakter/token maliyetiyle uygulanır ve estimatedTokens adıyla raporlanır.
 * contextItems dosya yolu, dar span, reason, evidence ve omittedCount sunar."
 * Araç girdisi: TŞ §10.2 (task, candidateScope?, tokenBudget).
 *
 * Pozitif: "orders service değiştirilecek" görevi OrdersService'i birebir
 * sembol eşleşmesiyle bulur; komşuları graph-proximity ayakından gelir; her
 * sonuç hangi ayakların katkı verdiğini raporlar; bütçe dolunca kalan adaylar
 * omittedCount'a yazılır; iki koşum bit-bit aynı JSON'u üretir.
 * Negatif: anlamsız sorgu boş sonuç + rationale döner; tokenBudget=0 açık
 * reddedilir; boş görev metni reddedilir; building snapshot reddedilir.
 * Partial: contract + FTS ayakları verilmediğinde degrade listesi raporlanır
 * ve kalan ayaklarla (exact/proximity/freshness) sonuç üretilir; FTS deposu
 * verildiğinde fts ayakı devreye girer.
 *
 * Sprint-5 D7 (K-013(7) sonrası): contract ayakının girdisi artık İKİ
 * kaynaktan birleşir — (a) açık input.contractSymbols, (b) snapshot'ın
 * SÖZLEŞME NODE YÜZEYİ (ApiContract/EventContract/SchemaContract/
 * ContractVersion; D1/D2 sözleşme kayıtları grafiğe geldiğinde otomatik
 * dolar). Kayıt varken ayak degradedLegs'ten ÇIKAR ve sıralamaya katkı
 * yazar (öncelik K-012/TŞ §15: exact > proximity > CONTRACT > freshness >
 * fts); kayıt yokken degrade davranışı KORUNUR (test bunu sabitler).
 */

const WORKSPACE_ID = "ws_gps";

/** Test fixture'ı: küçük "orders" sistemi + izole CustomerService/AuditLog. */
function buildSnapshot(state: SnapshotGraph["meta"]["state"] = "ready"): SnapshotGraph {
  return createSnapshot({
    workspaceId: WORKSPACE_ID,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg",
    analyzerFingerprint: "fp",
    state,
    createdAt: "2026-11-05T00:00:00Z",
    nodes: [
      {
        kind: "Class",
        qualifiedName: "app.OrdersService",
        relativePath: "src/orders/OrdersService.ts",
        location: {
          relativePath: "src/orders/OrdersService.ts",
          startLine: 10,
          endLine: 120,
          sourceHash: "h1",
        },
      },
      {
        kind: "Method",
        qualifiedName: "app.OrdersService.create",
        relativePath: "src/orders/OrdersService.ts",
        location: {
          relativePath: "src/orders/OrdersService.ts",
          startLine: 40,
          endLine: 80,
          sourceHash: "h1",
        },
      },
      {
        kind: "Class",
        qualifiedName: "app.OrdersRepository",
        relativePath: "src/orders/OrdersRepository.ts",
        location: {
          relativePath: "src/orders/OrdersRepository.ts",
          startLine: 5,
          endLine: 60,
          sourceHash: "h2",
        },
      },
      {
        kind: "Endpoint",
        qualifiedName: "POST /orders",
        relativePath: "src/orders/routes.ts",
        location: {
          relativePath: "src/orders/routes.ts",
          startLine: 8,
          endLine: 16,
          sourceHash: "h3",
        },
      },
      {
        kind: "Class",
        qualifiedName: "app.CustomerService",
        relativePath: "src/customer/CustomerService.ts",
        location: {
          relativePath: "src/customer/CustomerService.ts",
          startLine: 3,
          endLine: 50,
          sourceHash: "h4",
        },
      },
      {
        kind: "Class",
        qualifiedName: "app.AuditLog",
        relativePath: "src/audit/AuditLog.ts",
        location: {
          relativePath: "src/audit/AuditLog.ts",
          startLine: 1,
          endLine: 20,
          sourceHash: "h5",
        },
      },
      {
        // Bulgu 4 senaryosu: kenarı heuristic VE kanıtsız (domain invariant'ı
        // yalnızca verified kenara ≥1 evidence şart koşar) — BFS parent'ı bu
        // kenar olursa contextItem.evidenceIds boş kalır (meşru durum).
        kind: "Class",
        qualifiedName: "app.RowCache",
        relativePath: "src/cache/RowCache.ts",
        location: {
          relativePath: "src/cache/RowCache.ts",
          startLine: 12,
          endLine: 34,
          sourceHash: "h6",
        },
      },
    ],
    edges: [
      {
        kind: "ROUTES_TO",
        from: { kind: "Endpoint", qualifiedName: "POST /orders", relativePath: "src/orders/routes.ts" },
        to: { kind: "Class", qualifiedName: "app.OrdersService", relativePath: "src/orders/OrdersService.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "route-registration",
            analyzerId: "ts-linker",
            analyzerVersion: "0.1.0",
            rationale: "Express route kaydı",
          },
        ],
      },
      {
        kind: "CALLS",
        from: { kind: "Class", qualifiedName: "app.OrdersService", relativePath: "src/orders/OrdersService.ts" },
        to: { kind: "Class", qualifiedName: "app.OrdersRepository", relativePath: "src/orders/OrdersRepository.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            analyzerId: "ts-linker",
            analyzerVersion: "0.1.0",
            rationale: "Doğrudan çağrı",
          },
        ],
      },
      {
        kind: "DECLARES",
        from: { kind: "Class", qualifiedName: "app.OrdersService", relativePath: "src/orders/OrdersService.ts" },
        to: { kind: "Method", qualifiedName: "app.OrdersService.create", relativePath: "src/orders/OrdersService.ts" },
        resolution: "verified",
        evidence: [
          {
            kind: "declaration",
            analyzerId: "ts-linker",
            analyzerVersion: "0.1.0",
            rationale: "Sınıf üyesi bildirimi",
          },
        ],
      },
      {
        // Bulgu 4 senaryosu: kanıtsız heuristic kenar (evidence verilmez).
        kind: "CALLS",
        from: { kind: "Class", qualifiedName: "app.OrdersRepository", relativePath: "src/orders/OrdersRepository.ts" },
        to: { kind: "Class", qualifiedName: "app.RowCache", relativePath: "src/cache/RowCache.ts" },
        resolution: "heuristic",
      },
    ],
  });
}

const FRESHNESS: readonly FileFreshness[] = [
  { relativePath: "src/orders/routes.ts", updatedAt: "2026-11-05T08:00:00Z" },
  { relativePath: "src/orders/OrdersService.ts", updatedAt: "2026-11-04T10:00:00Z" },
  { relativePath: "src/orders/OrdersRepository.ts", updatedAt: "2026-11-03T09:00:00Z" },
  { relativePath: "src/customer/CustomerService.ts", updatedAt: "2026-01-01T00:00:00Z" },
];

/**
 * D7 fixture'ı: D1/D2 sözleşme kayıtları grafiğe ingeste edilmiş snapshot —
 * sözleşme yüzeyi (ApiContract/EventContract) node'ları İZOLEdir (kenarsız;
 * proximity kirliliği yok) ve "orders" tokenlarıyla kesişen ada sahiptir.
 */
function buildSnapshotWithContracts(
  state: SnapshotGraph["meta"]["state"] = "ready",
): SnapshotGraph {
  return createSnapshot({
    workspaceId: WORKSPACE_ID,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg",
    analyzerFingerprint: "fp",
    state,
    createdAt: "2026-11-05T00:00:00Z",
    nodes: [
      {
        kind: "Class",
        qualifiedName: "app.OrdersArchiver",
        relativePath: "src/orders/OrdersArchiver.ts",
        location: {
          relativePath: "src/orders/OrdersArchiver.ts",
          startLine: 1,
          endLine: 30,
          sourceHash: "hc1",
        },
      },
      {
        // Sözleşme yüzeyi: "orders" tokenı Class ile BİREBİR ortak →
        // exact=1 + proximity seed eşitliği; contract ayakı BAĞI KIRAR.
        kind: "ApiContract",
        qualifiedName: "app.OrdersApi",
        relativePath: "openapi.yaml",
        location: {
          relativePath: "openapi.yaml",
          startLine: 1,
          endLine: 40,
          sourceHash: "hc2",
        },
      },
      {
        // "orders contract" sorgusunun "contract" tokenıyla kesişir; ama
        // "orders" tokenıyla KESİŞMEZ (birebirlik: orders ≠ order).
        kind: "EventContract",
        qualifiedName: "app.OrderCreated",
        relativePath: "asyncapi.yaml",
      },
      {
        kind: "Class",
        qualifiedName: "app.AuditLog",
        relativePath: "src/audit/AuditLog.ts",
        location: {
          relativePath: "src/audit/AuditLog.ts",
          startLine: 1,
          endLine: 20,
          sourceHash: "hc3",
        },
      },
    ],
    edges: [],
  });
}

/** D7 contract-ayak testlerinin tazelik girdisi: Archiver dosyası EN TAZE. */
const CONTRACT_FRESHNESS: readonly FileFreshness[] = [
  { relativePath: "src/orders/OrdersArchiver.ts", updatedAt: "2026-11-05T09:00:00Z" },
  { relativePath: "openapi.yaml", updatedAt: "2026-11-01T00:00:00Z" },
];

function nodeByQualifiedName(snapshot: SnapshotGraph, qualifiedName: string): string {
  const node = snapshot.nodes.find((n) => n.qualifiedName === qualifiedName);
  if (node === undefined) {
    throw new Error(`fixture node bulunamadı: ${qualifiedName}`);
  }
  return node.id;
}

/** FTS deposu sahtesi: sabit hit listesi döner (sıra = FTS relevance sırası). */
function fakeSymbolSearchStore(
  hits: readonly SymbolSearchHit[],
): SymbolSearchStore {
  return {
    indexSymbols: () => undefined,
    searchSymbols: () => hits,
  };
}

describe("generateAgentContext — pozitif", () => {
  it("orders sorgusu OrdersService'i exact ayakla, komşuları proximity ayakla bulur; ayak katkıları raporlanır", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
    });

    expect(result.snapshotId).toBe(snapshot.meta.id);
    expect(result.snapshotState).toBe("ready");
    expect(result.queryTokens).toEqual(["orders", "service", "değiştirilecek"]);
    expect(result.tokenBudget).toBe(4096);

    // Birebir sembol eşleşmesi: OrdersService tokenları [orders, service].
    const first = result.contextItems[0];
    expect(first).toBeDefined();
    expect(first?.qualifiedName).toBe("app.OrdersService");
    expect(first?.legs).toEqual<readonly AgentContextLeg[]>([
      "exact-symbol",
      "graph-proximity",
      "freshness",
    ]);
    expect(first?.scores.exact).toBe(2);
    expect(first?.scores.proximity).toBe(1); // seed: depth 0 → 1/(1+0)
    expect(first?.proximityDepth).toBe(0);
    expect(first?.relativePath).toBe("src/orders/OrdersService.ts");
    expect(first?.span).toEqual({ startLine: 10, endLine: 120 });
    expect(first?.estimatedTokens).toBeGreaterThan(0);

    // Komşular proximity ayakından: seed depth 0, BFS keşfi depth 1 → 0.5.
    // OrdersRepository adı "orders" tokenı içerdiğinden seed olur (depth 0);
    // create ise yalnızca BFS ile bulunur (depth 1, parent kenar DECLARES).
    const repo = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersRepository",
    );
    expect(repo).toBeDefined();
    expect(repo?.legs).toContain("graph-proximity");
    expect(repo?.proximityDepth).toBe(0);
    expect(repo?.scores.proximity).toBe(1);
    const create = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersService.create",
    );
    expect(create?.legs).toContain("graph-proximity");
    expect(create?.legs).not.toContain("exact-symbol");
    expect(create?.proximityDepth).toBe(1);
    expect(create?.scores.proximity).toBe(0.5);
    // Açıklanabilirlik: proximity yolu parent kenarın kanıtlarını taşır.
    expect(create?.evidenceIds.length).toBeGreaterThan(0);

    // legsApplied kanonik ayak sırasında; contract/fts verilmedi → yok.
    expect(result.legsApplied).toEqual<readonly AgentContextLeg[]>([
      "exact-symbol",
      "graph-proximity",
      "freshness",
    ]);

    // Tazelik ayakı: routes.ts en yeni dosya (distinct rank 0 → 1.0).
    const endpoint = result.contextItems.find(
      (item) => item.qualifiedName === "POST /orders",
    );
    expect(endpoint?.scores.freshness).toBe(1);
    expect(endpoint?.legs).toContain("freshness");
  });

  it("sıralama ayak sırasına göre leksiktir: exact > proximity > freshness", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
    });

    // 1) OrdersService (exact 2) başa çıkar.
    // 2) exact 1 grubunda proximity'siz CustomerService, proximity'li
    //    endpoint'in ALTINDA kalır (ayak sırası: proximity freshness'i yener).
    // 3) endpoint ile OrdersRepository exact+proximity'de EŞİTTİR; tazelik
    //    kararı verir: routes.ts (1.0) > OrdersRepository.ts (0.5).
    const names = result.contextItems.map((item) => item.qualifiedName);
    expect(names.indexOf("app.OrdersService")).toBe(0);
    expect(names.indexOf("POST /orders")).toBeLessThan(
      names.indexOf("app.CustomerService"),
    );
    expect(names.indexOf("POST /orders")).toBeLessThan(
      names.indexOf("app.OrdersRepository"),
    );
    // İzole AuditLog hiçbir ayakla eşleşmez → aday listesinde yok.
    expect(names).not.toContain("app.AuditLog");
    expect(result.candidateCount).toBe(result.contextItems.length);
  });

  it("tokenBudget paketi sınırlar: estimatedTokens = ceil(jsonChars/4), taşan adaylar omittedCount'a yazılır", () => {
    const snapshot = buildSnapshot();
    const full = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget,
      fileFreshness: FRESHNESS,
    });
    // Bütçe geniş: tüm adaylar pakete girer, hiçbir şey atlanmaz.
    expect(full.omittedCount).toBe(0);
    expect(full.contextItems.length).toBe(6);
    const packageTokens = full.contextItems.reduce(
      (sum, item) => sum + item.estimatedTokens,
      0,
    );
    expect(full.estimatedTokens).toBe(packageTokens);
    // Açık formül: item estimatedTokens = ceil(item JSON karakter sayısı / 4).
    for (const item of full.contextItems) {
      const { estimatedTokens, ...body } = item;
      expect(estimatedTokens).toBe(
        Math.ceil(JSON.stringify(body).length / 4),
      );
    }

    // Bütçe 1: hiçbir item sığamaz → paket boş, 5 aday atlanır.
    const tight = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 1,
      fileFreshness: FRESHNESS,
    });
    expect(tight.contextItems).toEqual([]);
    expect(tight.omittedCount).toBe(6);
    expect(tight.estimatedTokens).toBe(0);
    expect(tight.candidateCount).toBe(6);
    expect(
      tight.rationales.some((r) => r.includes("tokenBudget")),
    ).toBe(true);
  });

  it("aynı girdi iki koşumda bit-bit aynı JSON'u üretir (determinizm)", () => {
    const snapshot = buildSnapshot();
    const input = {
      task: "orders service değiştirilecek",
      tokenBudget: 2048,
      fileFreshness: FRESHNESS,
    };
    const a = generateAgentContext(snapshot, input);
    const b = generateAgentContext(snapshot, input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("girdi dizi sırasından bağımsızdır: nodes/edges ters çevrilmiş snapshot aynı JSON'u üretir (denetim bulgusu 3)", () => {
    const snapshot = buildSnapshot();
    const repoId = nodeByQualifiedName(snapshot, "app.OrdersRepository");
    const input = {
      task: "orders service değiştirilecek",
      tokenBudget: 2048,
      fileFreshness: FRESHNESS,
      contractSymbols: ["app.OrdersService"],
      symbolSearch: fakeSymbolSearchStore([
        {
          symbol: "OrdersRepository",
          nodeId: repoId,
          snapshotId: snapshot.meta.id,
        },
      ]),
    };
    const baseline = generateAgentContext(snapshot, input);
    // Modül dokümanındaki "girdi dizilerinin sırasına bağlı değildir" iddiası:
    // tüm node/edge dizileri ters sırada verilir; tüm ayaklar (exact,
    // proximity, contract, freshness, fts) açıkken kanonik sıralamalar
    // sıralamayı tamamen telafi etmelidir.
    const flippedSnapshot: SnapshotGraph = {
      ...snapshot,
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
    };
    const flipped = generateAgentContext(flippedSnapshot, input);
    expect(JSON.stringify(flipped)).toBe(JSON.stringify(baseline));
  });

  it("paket girişi yüzeyi: Agent GPS çekirdeği ve tipleri kök exportundan erişilebilir (denetim bulgusu 1)", () => {
    // C8 araç kaydı @causoryn/graph kökünden import eder; bu testin
    // import bloğunun TAMAMI ../src/index.js'tendir — yüzey eksilirse
    // dosya komple kırmızıdır.
    const input: AgentContextInput = { task: "orders service" };
    const result: AgentContextResult = generateAgentContext(
      buildSnapshot(),
      input,
    );
    expect(result.contextItems.length).toBeGreaterThan(0);
    const first: AgentContextItem | undefined = result.contextItems[0];
    const leg: AgentContextLeg | undefined = first?.legs[0];
    expect(leg).toBe("exact-symbol");
    const scores: AgentContextScores | undefined = first?.scores;
    expect(scores?.exact).toBeGreaterThan(0);
    const limits: AgentContextAppliedLimits = AGENT_CONTEXT_LIMIT_CEILINGS;
    expect(limits.tokenBudget).toBe(4096);
    const degraded: DegradedLeg = { leg: "fts", reason: "yüzey testi" };
    expect(degraded.leg).toBe("fts");
    const freshness: FileFreshness = {
      relativePath: "a.ts",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(freshness.updatedAt).toContain("2026");
  });

  it("kanıtsız adaylarda evidenceIds boş kalır: kenarsız seed ve kanıtsız heuristic parent kenar (denetim bulgusu 4)", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
    });
    // Kenarsız exact seed: CustomerService'in temas kenarı yoktur; kanıt
    // yalnızca graph'taki gerçek Evidence kayıtlarından gelir, boşluk asla
    // uydurma kanıtla doldurulmaz.
    const customer = result.contextItems.find(
      (item) => item.qualifiedName === "app.CustomerService",
    );
    expect(customer?.legs).toContain("exact-symbol");
    expect(customer?.evidenceIds).toEqual([]);
    // Kanıtsız heuristic parent: RowCache, OrdersRepository seed'inden
    // evidence taşımayan CALLS(heuristic) kenarıyla depth 1'de keşfedilir.
    const rowCache = result.contextItems.find(
      (item) => item.qualifiedName === "app.RowCache",
    );
    expect(rowCache?.legs).toContain("graph-proximity");
    expect(rowCache?.proximityDepth).toBe(1);
    expect(rowCache?.scores.proximity).toBe(0.5);
    expect(rowCache?.evidenceIds).toEqual([]);
  });

  it("contractSymbols verildiğinde contract ayakı görev tokenlarıyla kesişen kontrat sembolüne katkı yazar", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
      contractSymbols: ["app.OrdersService", "app.AuditLog"],
    });
    expect(result.legsApplied).toContain("contract");
    expect(result.degradedLegs.map((l) => l.leg)).not.toContain("contract");
    const orders = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersService",
    );
    expect(orders?.legs).toContain("contract");
    expect(orders?.scores.contract).toBe(1);
    // AuditLog kontratta ama görev tokenlarıyla kesişmez → aday olmaz.
    expect(
      result.contextItems.map((i) => i.qualifiedName),
    ).not.toContain("app.AuditLog");
  });

  it("D7: snapshot'taki sözleşme kayıtları contract ayakını degrade listesinden çıkarır ve katkı yazar (contractSymbols'sız)", () => {
    const snapshot = buildSnapshotWithContracts();
    const result = generateAgentContext(snapshot, {
      task: "orders contract değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: CONTRACT_FRESHNESS,
    });
    // Ayak koştu: legsApplied'da, degradedLegs'te DEĞİL.
    expect(result.legsApplied).toContain("contract");
    expect(result.degradedLegs.map((l) => l.leg)).not.toContain("contract");
    // ApiContract "app.OrdersApi": görev tokenlarıyla kesişir (orders) →
    // contract katkısı 1. EventContract "app.OrderCreated": "orders"/
    // "contract" tokenlarıyla KESİŞMEZ (orders ≠ order; birebirlik) → aday
    // listesinde bile olmamalı (kontrat ilgisi görevle ilişkili olmak
    // zorundadır — çekirdek sözleşmesi).
    const api = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersApi",
    );
    expect(api?.legs).toContain("contract");
    expect(api?.scores.contract).toBe(1);
    expect(api?.scores.exact).toBe(1);
    expect(
      result.contextItems.map((i) => i.qualifiedName),
    ).not.toContain("app.OrderCreated");
  });

  it("D7: sıralama önceliği K-012/TŞ §15 — CONTRACT, freshness'i (recency) yener", () => {
    const snapshot = buildSnapshotWithContracts();
    const result = generateAgentContext(snapshot, {
      task: "orders",
      tokenBudget: 4096,
      fileFreshness: CONTRACT_FRESHNESS,
    });
    // "orders" sorgusu: OrdersArchiver (Class, exact=1, seed prox=1) ile
    // OrdersApi (ApiContract, exact=1, seed prox=1) AYNI puandadır; tazelik
    // Archiver lehine (1.0 vs 0.5) ama CONTRACT ayakı BAĞI KIRAR ve
    // ApiContract'ı ÜSTE çıkarır (exact > proximity > CONTRACT > freshness).
    const names = result.contextItems.map((item) => item.qualifiedName);
    expect(names.indexOf("app.OrdersApi")).toBeLessThan(
      names.indexOf("app.OrdersArchiver"),
    );
    const archiver = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersArchiver",
    );
    expect(archiver?.scores.freshness).toBe(1);
    expect(archiver?.scores.contract).toBe(0);
    const api = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersApi",
    );
    expect(api?.scores.freshness).toBe(0.5);
    expect(api?.scores.contract).toBe(1);
    // AuditLog sorguyla kesişmez → aday yok.
    expect(names).not.toContain("app.AuditLog");
  });

  it("FTS deposu verildiğinde fts ayakı koşar ve hit node'una katkı yazar", () => {
    const snapshot = buildSnapshot();
    const repoId = nodeByQualifiedName(snapshot, "app.OrdersRepository");
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
      symbolSearch: fakeSymbolSearchStore([
        {
          symbol: "OrdersRepository",
          nodeId: repoId,
          snapshotId: snapshot.meta.id,
        },
      ]),
    });
    expect(result.legsApplied).toContain("fts");
    const repo = result.contextItems.find(
      (item) => item.qualifiedName === "app.OrdersRepository",
    );
    expect(repo?.legs).toContain("fts");
    expect(repo?.scores.fts).toBeGreaterThan(0);
    // Ayak önceliği: repo fts=1 alsa da son ayak olan fts, önceki ayaklarda
    // önde olan endpoint'i (exact 1, prox 0.5, fresh 1.0) geçemez.
    const names = result.contextItems.map((item) => item.qualifiedName);
    expect(names.indexOf("POST /orders")).toBeLessThan(
      names.indexOf("app.OrdersRepository"),
    );
  });
});

describe("generateAgentContext — negatif", () => {
  it("anlamsız sorgu boş sonuç + rationale döner; hiçbir aday üretilmez", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "zzzqqq bilinmeyen",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
    });
    expect(result.contextItems).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.omittedCount).toBe(0);
    expect(result.estimatedTokens).toBe(0);
    expect(result.rationales.length).toBeGreaterThan(0);
    // Görev metni çıktıya aynen yazılmaz; yalnızca normalize tokenlar taşınır.
    expect(result.queryTokens).toEqual(["zzzqqq", "bilinmeyen"]);
  });

  it("anlamsız sorguda görevle kesişmeyen contractSymbols katkı üretmez", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "zzzqqq bilinmeyen",
      tokenBudget: 4096,
      contractSymbols: ["app.AuditLog"],
    });
    expect(result.contextItems).toEqual([]);
    expect(result.legsApplied).toContain("contract");
    expect(result.degradedLegs.map((l) => l.leg)).not.toContain("contract");
  });

  it("D7 unknown: snapshot sözleşme yüzeyi dolu ama görev tokenları hiçbir sözleşme sembolüyle kesişmiyorsa aday üretmez, hata çıkmaz", () => {
    const snapshot = buildSnapshotWithContracts();
    const result = generateAgentContext(snapshot, {
      task: "zzzqqq bilinmeyen",
      tokenBudget: 4096,
    });
    // Ayak koştu (yüzey dolu → degrade yok) ama görevle ilişki yok → katkı 0.
    expect(result.legsApplied).toContain("contract");
    expect(result.degradedLegs.map((l) => l.leg)).not.toContain("contract");
    for (const item of result.contextItems) {
      expect(item.scores.contract).toBe(0);
      expect(item.legs).not.toContain("contract");
    }
    // Yüzeydeki hiçbir sözleşme node'u anlamsız sorguya aday olmaz.
    expect(
      result.contextItems.map((i) => i.qualifiedName),
    ).not.toContain("app.OrdersApi");
    expect(
      result.contextItems.map((i) => i.qualifiedName),
    ).not.toContain("app.OrderCreated");
  });

  it("tokenBudget=0 açık reddedilir (graph/agent-context-invalid-input)", () => {
    const snapshot = buildSnapshot();
    expect(() =>
      generateAgentContext(snapshot, { task: "orders", tokenBudget: 0 }),
    ).toThrow(GraphRepositoryError);
    try {
      generateAgentContext(snapshot, { task: "orders", tokenBudget: 0 });
    } catch (error) {
      expect((error as GraphRepositoryError).code).toBe(
        "graph/agent-context-invalid-input",
      );
    }
  });

  it("geçersiz girdiler reddedilir: boş görev metni, negatif bütçe, kötü proximity derinliği", () => {
    const snapshot = buildSnapshot();
    for (const task of ["", "   "]) {
      expect(() => generateAgentContext(snapshot, { task })).toThrow(
        GraphRepositoryError,
      );
    }
    expect(() =>
      generateAgentContext(snapshot, { task: "orders", tokenBudget: -5 }),
    ).toThrow(GraphRepositoryError);
    expect(() =>
      generateAgentContext(snapshot, { task: "orders", maxProximityDepth: 0 }),
    ).toThrow(GraphRepositoryError);
    try {
      generateAgentContext(snapshot, { task: "orders", tokenBudget: 1.5 });
    } catch (error) {
      expect((error as GraphRepositoryError).code).toBe(
        "graph/agent-context-invalid-input",
      );
    }
  });

  it("building/failed snapshot reddedilir (graph/agent-context-snapshot-state)", () => {
    // Bulgu 2: başlıkla kapsam uyumu — state union'ının her iki
    // yayımlanamaz dalı (building VE failed, graph-schema.ts:109) denenir.
    for (const state of ["building", "failed"] as const) {
      const snapshot = buildSnapshot(state);
      expect(() =>
        generateAgentContext(snapshot, { task: "orders service" }),
      ).toThrow(GraphRepositoryError);
      try {
        generateAgentContext(snapshot, { task: "orders service" });
      } catch (error) {
        expect((error as GraphRepositoryError).code).toBe(
          "graph/agent-context-snapshot-state",
        );
      }
    }
  });
});

describe("generateAgentContext — partial (degrade)", () => {
  it("contract+FTS ayakları yok: degrade listesi raporlanır, kalan ayaklarla sonuç üretilir", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      fileFreshness: FRESHNESS,
    });

    expect(result.degradedLegs.map((l) => l.leg)).toEqual(["contract", "fts"]);
    // D7 sonrası degrade gerekçesi: snapshot'ta sözleşme kaydı YOK ve
    // contractSymbols verilmedi (K-013(7) kesinleşti; kayıt gelince ayak
    // otomatik dolar — yukarıdaki D7 pozitif testleri bunu sabitler).
    expect(result.degradedLegs[0]?.reason).toContain("no contract records");
    expect(result.degradedLegs[0]?.reason).toContain("contractSymbols");
    expect(result.degradedLegs[1]?.reason.length).toBeGreaterThan(0);
    expect(result.legsApplied).toEqual<readonly AgentContextLeg[]>([
      "exact-symbol",
      "graph-proximity",
      "freshness",
    ]);
    // Degrade ayaklar hata değildir: kalan ayaklarla tam sonuç.
    expect(result.contextItems.length).toBe(6);
    expect(result.contextItems[0]?.qualifiedName).toBe("app.OrdersService");
  });

  it("D7: sözleşme kaydı OLMAYAN snapshot'ta contract ayağı degrade kalır (boş contractSymbols da ayak açmaz)", () => {
    const snapshot = buildSnapshot();
    const withEmptyInput = generateAgentContext(snapshot, {
      task: "orders service değiştirilecek",
      tokenBudget: 4096,
      contractSymbols: [],
    });
    expect(withEmptyInput.degradedLegs.map((l) => l.leg)).toContain("contract");
    expect(withEmptyInput.legsApplied).not.toContain("contract");
  });

  it("fileFreshness verilmezse freshness ayağı da degradedir; exact+proximity ayakları yeter", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service",
      tokenBudget: 4096,
    });
    expect(result.degradedLegs.map((l) => l.leg)).toEqual([
      "contract",
      "freshness",
      "fts",
    ]);
    expect(result.legsApplied).toEqual<readonly AgentContextLeg[]>([
      "exact-symbol",
      "graph-proximity",
    ]);
    expect(result.contextItems.length).toBeGreaterThan(0);
    for (const item of result.contextItems) {
      expect(item.legs).not.toContain("freshness");
      expect(item.scores.freshness).toBe(0);
    }
  });

  it("tavan üstü tokenBudget tavana indirilir ve rationale ile raporlanır", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "orders service",
      tokenBudget: 999_999,
      fileFreshness: FRESHNESS,
    });
    expect(result.tokenBudget).toBe(AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget);
    expect(
      result.rationales.some((r) => r.includes("tokenBudget")),
    ).toBe(true);
  });

  it("FTS hit'i snapshot dışı nodeId düşürülür ve rationale ile raporlanır", () => {
    const snapshot = buildSnapshot();
    const result = generateAgentContext(snapshot, {
      task: "zzzqqq bilinmeyen",
      tokenBudget: 4096,
      symbolSearch: fakeSymbolSearchStore([
        {
          symbol: "GhostSymbol",
          nodeId: "node:ghost",
          snapshotId: snapshot.meta.id,
        },
      ]),
    });
    expect(
      result.contextItems.map((i) => i.nodeId),
    ).not.toContain("node:ghost");
    expect(result.rationales.some((r) => r.includes("fts"))).toBe(true);
    // Snapshot içi eşleşme yoksa aday da yoktur (yalnızca ghost hit vardı).
    expect(result.candidateCount).toBe(0);
  });
});

describe("generateAgentContext — CodeQL #17 splitIdentifierTokens paritesi ve ReDoS koruması", () => {
  it("camelCase ve ACRONYM sınırlarını (HTTPServer, XMLHttpRequest, getURLPath) birebir ayırır", () => {
    const snapshot = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-acronym", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-05T00:00:00Z",
      nodes: [
        { kind: "Class", qualifiedName: "net.HTTPServer", relativePath: "src/http.ts" },
        { kind: "Class", qualifiedName: "net.XMLHttpRequest", relativePath: "src/xhr.ts" },
        { kind: "Function", qualifiedName: "net.getURLPath", relativePath: "src/url.ts" },
        { kind: "Class", qualifiedName: "net.IOError", relativePath: "src/io.ts" },
      ],
      edges: [],
    });

    const httpServer = generateAgentContext(snapshot, { task: "http server" });
    expect(httpServer.contextItems[0]?.qualifiedName).toBe("net.HTTPServer");
    expect(httpServer.contextItems[0]?.scores.exact).toBe(2);
    // "httpserver" bölündüğü için tek parça olarak eşleşmez.
    expect(generateAgentContext(snapshot, { task: "httpserver" }).contextItems).toEqual([]);

    const xhr = generateAgentContext(snapshot, { task: "xml http request" });
    expect(xhr.contextItems[0]?.qualifiedName).toBe("net.XMLHttpRequest");
    expect(xhr.contextItems[0]?.scores.exact).toBe(3);

    const urlPath = generateAgentContext(snapshot, { task: "get url path" });
    expect(urlPath.contextItems[0]?.qualifiedName).toBe("net.getURLPath");
    expect(urlPath.contextItems[0]?.scores.exact).toBe(3);

    const ioErr = generateAgentContext(snapshot, { task: "io error" });
    expect(ioErr.contextItems[0]?.qualifiedName).toBe("net.IOError");
    expect(ioErr.contextItems[0]?.scores.exact).toBe(2);
  });

  it("40.000 büyük harfli adversarial identifier O(n) sürede işlenir (polynomial ReDoS yok)", () => {
    const longUpper = "A".repeat(40_000);
    const snapshot = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-redos-upper", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-05T00:00:00Z",
      nodes: [
        { kind: "Class", qualifiedName: `app.${longUpper}`, relativePath: "src/long.ts" },
      ],
      edges: [],
    });

    const start = performance.now();
    const result = generateAgentContext(snapshot, {
      task: longUpper.toLowerCase(),
      tokenBudget: 4096,
    });
    const elapsedMs = performance.now() - start;

    expect(result.candidateCount).toBe(1);
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe("generateAgentContext — Wave 2 LocAgent localization & proximity cleanup", () => {
  it("tokenizes full File path + basename instead of reducing '.ts' paths to extension 'ts'", () => {
    const snapshot = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-file-tok", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-24T00:00:00Z",
      nodes: [
        {
          kind: "File",
          qualifiedName: "packages/mcp-server/src/server.ts",
          relativePath: "packages/mcp-server/src/server.ts",
        },
        {
          kind: "File",
          qualifiedName: "packages/mcp-server/src/envelope.ts",
          relativePath: "packages/mcp-server/src/envelope.ts",
        },
        {
          kind: "File",
          qualifiedName: "packages/core/src/a_alpha.ts",
          relativePath: "packages/core/src/a_alpha.ts",
        },
      ],
      edges: [],
    });

    const envRes = generateAgentContext(snapshot, { task: "Where is the response envelope built?" });
    expect(envRes.contextItems[0]?.qualifiedName).toBe("packages/mcp-server/src/envelope.ts");

    const srvRes = generateAgentContext(snapshot, { task: "MCP server entrypoint" });
    expect(srvRes.contextItems[0]?.qualifiedName).toBe("packages/mcp-server/src/server.ts");
  });

  it("excludes Workspace root and upward reverse CONTAINS from proximity BFS and breaks ties by structural degree (not alphabetically)", () => {
    const snapshot = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-prox-clean", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-24T00:00:00Z",
      nodes: [
        { kind: "Workspace", qualifiedName: WORKSPACE_ID },
        {
          kind: "File",
          qualifiedName: "packages/mcp-server/src/a_leaf.ts",
          relativePath: "packages/mcp-server/src/a_leaf.ts",
        },
        {
          kind: "File",
          qualifiedName: "packages/mcp-server/src/server.ts",
          relativePath: "packages/mcp-server/src/server.ts",
        },
        {
          kind: "File",
          qualifiedName: "packages/mcp-server/src/cli.ts",
          relativePath: "packages/mcp-server/src/cli.ts",
        },
        {
          kind: "File",
          qualifiedName: "packages/unrelated/src/a_unrelated.ts",
          relativePath: "packages/unrelated/src/a_unrelated.ts",
        },
      ],
      edges: [
        {
          kind: "CONTAINS",
          from: { kind: "Workspace", qualifiedName: WORKSPACE_ID },
          to: { kind: "File", qualifiedName: "packages/mcp-server/src/a_leaf.ts", relativePath: "packages/mcp-server/src/a_leaf.ts" },
          resolution: "verified",
          evidence: [{ kind: "inv", analyzerId: "idx", analyzerVersion: "0.3.0", rationale: "ws" }],
        },
        {
          kind: "CONTAINS",
          from: { kind: "Workspace", qualifiedName: WORKSPACE_ID },
          to: { kind: "File", qualifiedName: "packages/mcp-server/src/server.ts", relativePath: "packages/mcp-server/src/server.ts" },
          resolution: "verified",
          evidence: [{ kind: "inv", analyzerId: "idx", analyzerVersion: "0.3.0", rationale: "ws" }],
        },
        {
          kind: "CONTAINS",
          from: { kind: "Workspace", qualifiedName: WORKSPACE_ID },
          to: { kind: "File", qualifiedName: "packages/unrelated/src/a_unrelated.ts", relativePath: "packages/unrelated/src/a_unrelated.ts" },
          resolution: "verified",
          evidence: [{ kind: "inv", analyzerId: "idx", analyzerVersion: "0.3.0", rationale: "ws" }],
        },
        {
          kind: "IMPORTS",
          from: { kind: "File", qualifiedName: "packages/mcp-server/src/cli.ts", relativePath: "packages/mcp-server/src/cli.ts" },
          to: { kind: "File", qualifiedName: "packages/mcp-server/src/server.ts", relativePath: "packages/mcp-server/src/server.ts" },
          resolution: "verified",
          evidence: [{ kind: "imp", analyzerId: "ts", analyzerVersion: "0.3.0", rationale: "cli imports server" }],
        },
      ],
    });

    const result = generateAgentContext(snapshot, { task: "mcp" });
    const names = result.contextItems.map((i) => i.qualifiedName);
    expect(names).not.toContain(WORKSPACE_ID);
    expect(names).not.toContain("packages/unrelated/src/a_unrelated.ts");
    // server.ts has higher non-CONTAINS structural importance than a_leaf.ts
    expect(names.indexOf("packages/mcp-server/src/server.ts")).toBeLessThan(
      names.indexOf("packages/mcp-server/src/a_leaf.ts"),
    );
  });
});

describe("agent context — very large per-edge evidence lists (security scan F47)", () => {
  it("collects incident evidence without spreading an edge's evidenceIds into call arguments", () => {
    // One CALLS edge merging many call sites carries one evidence id per
    // site, set by the analysed repository. Spreading 500k ids into
    // Array.prototype.push exceeds V8's argument limit (RangeError) and used
    // to break get_agent_context for the whole workspace.
    const graph = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-f47", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-05T00:00:00Z",
      nodes: [
        { kind: "Class", qualifiedName: "app.OrdersService", relativePath: "src/orders/OrdersService.ts" },
        { kind: "Class", qualifiedName: "app.Billing", relativePath: "src/billing/Billing.ts" },
      ],
      edges: [
        {
          kind: "CALLS",
          from: { kind: "Class", qualifiedName: "app.OrdersService", relativePath: "src/orders/OrdersService.ts" },
          to: { kind: "Class", qualifiedName: "app.Billing", relativePath: "src/billing/Billing.ts" },
          resolution: "heuristic",
        },
      ],
    });
    const count = 500_000;
    // Reverse order: the item must still carry the 8 smallest ids, sorted.
    const evidenceIds = Array.from(
      { length: count },
      (_, i) => `evidence:${String(count - 1 - i).padStart(7, "0")}`,
    );
    const snapshot: SnapshotGraph = {
      ...graph,
      edges: graph.edges.map((edge) => ({ ...edge, evidenceIds })),
    };

    const result = generateAgentContext(snapshot, { task: "OrdersService" });

    const item = result.contextItems.find((entry) => entry.qualifiedName === "app.OrdersService");
    expect(item).toBeDefined();
    expect(item?.evidenceIds).toEqual(
      Array.from({ length: 8 }, (_, i) => `evidence:${String(i).padStart(7, "0")}`),
    );
  });
});
