import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  sha256Hex,
  utf8Encode,
  type SnapshotGraph,
} from "@causoryn/domain";
import type { ContractChangeRecord } from "@causoryn/contracts";

import {
  WikiProjectionError,
  computeWikiContractChanges,
  wikiContractSurfaceOf,
  WIKI_CONTRACT_NODE_KINDS,
  type WikiContractNodeSurface,
} from "../src/index.js";

/**
 * wiki_diff contractChanges saf çekirdeği — K-013(7) kesinleşmesi (sprint-5
 * D7 dilimi; wiki/decisions.md K-013 #7).
 *
 * Üretici sözleşme: packages/contracts contract-drift.ts ContractChangeRecord
 * — {contractId, changeKind: added|removed|modified, summary}. Bu çekirdek,
 * iki WikiSnapshot'ın ARKA GRAPH SNAPSHOT'larının sözleşme node yüzeylerini
 * (ApiContract/EventContract/SchemaContract/ContractVersion; projection.ts
 * CONTRACT_NODE_KINDS ile aynı küme) karşılaştırır ve K-013(7) kayıtlarını
 * üretir. Kural değerlendirmesi (backward/breaking) BURADA YOKTUR — o D2/D3
 * çekirdeğinin işidir; bu katman yalnızca node yüzey farkını dürüstçe raporlar.
 *
 * Kimlik seçimi D3 kuralıyla aynıdır: değişiklik sonrasında geçerli kimlik —
 * target'ta varsa TARGET kimliği (added/modified), yoksa BASE kimliği
 * (removed). Anahtar (matchKey) = "<nodeKind> <qualifiedName>" (D2 stableKey
 * endpoint-olmayan dalının graph node yüzeyi karşılığı; graph node'u
 * method/route'u yazılmış alan olarak taşımaz).
 *
 * Pozitif: added + modified kayıtları, kimlik seçimi, determinizm.
 * Negatif: removed kaydı BASE kimliğiyle; unchanged kayıt raporlanmaz.
 * Partial: boş yüzeyler → [] (dürüst boşluk); geçersiz yüzey girdisi açık red.
 */

function surface(
  contractId: string,
  nodeKind: string,
  qualifiedName: string,
  content: string,
): WikiContractNodeSurface {
  return {
    contractId,
    nodeKind,
    qualifiedName,
    contentHash: `hash-${content}`,
  };
}

describe("computeWikiContractChanges — pozitif", () => {
  it("added ve modified kayıtlarını üretir; modified TARGET kimliğini taşır; unchanged raporlanmaz", () => {
    const base = [
      surface("node:aaa", "ApiContract", "app.OrdersApi", "v1"),
      surface("node:bbb", "EventContract", "app.OrderCreated", "v1"),
    ];
    const target = [
      // Modified: aynı anahtar, farklı içerik karması, FARKLI kimlik →
      // D3 "değişiklik sonrasında geçerli kimlik" kuralı: TARGET kimliği.
      surface("node:aaa2", "ApiContract", "app.OrdersApi", "v2"),
      // Unchanged: aynı anahtar, aynı içerik karması → raporlanmaz.
      surface("node:bbb", "EventContract", "app.OrderCreated", "v1"),
      // Added: anahtar yalnızca target'ta.
      surface("node:ccc", "SchemaContract", "table:customers", "v1"),
    ];

    const changes = computeWikiContractChanges(base, target);

    expect(changes).toHaveLength(2);
    const modified = changes.find((change) => change.changeKind === "modified");
    expect(modified).toEqual<ContractChangeRecord>({
      contractId: "node:aaa2",
      changeKind: "modified",
      summary: "app.OrdersApi modified: contract content hash changed (base=hash-v1 → target=hash-v2)",
    });
    const added = changes.find((change) => change.changeKind === "added");
    expect(added).toEqual<ContractChangeRecord>({
      contractId: "node:ccc",
      changeKind: "added",
      summary: "table:customers added: new entry in the target WikiSnapshot's graph contract surface",
    });
    // K-013(7) gövdesi TAM ÜÇ alandır: fazla/eksik alan yok.
    for (const change of changes) {
      expect(Object.keys(change).sort()).toEqual(["changeKind", "contractId", "summary"]);
    }
  });

  it("çıktı kanonik sıralıdır (contractId, changeKind, summary) ve girdi sırasından bağımsızdır", () => {
    const base = [
      surface("node:bbb", "EventContract", "app.OrderCreated", "v1"),
      surface("node:aaa", "ApiContract", "app.OrdersApi", "v1"),
    ];
    const target = [
      surface("node:ccc", "SchemaContract", "table:customers", "v1"),
      surface("node:aaa2", "ApiContract", "app.OrdersApi", "v2"),
      surface("node:bbb", "EventContract", "app.OrderCreated", "v1"),
    ];

    const ordered = computeWikiContractChanges(base, target);
    const shuffled = computeWikiContractChanges([...base].reverse(), [...target].reverse());

    expect(ordered.map((change) => change.contractId)).toEqual([
      "node:aaa2",
      "node:ccc",
    ]);
    expect(JSON.stringify(ordered)).toBe(JSON.stringify(shuffled));
  });

  it("aynı girdi iki koşumda bit-bit aynı JSON'u üretir (determinizm)", () => {
    const base = [surface("node:aaa", "ApiContract", "app.OrdersApi", "v1")];
    const target = [surface("node:bbb", "EventContract", "app.OrderCreated", "v1")];
    const a = computeWikiContractChanges(base, target);
    const b = computeWikiContractChanges(base, target);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("computeWikiContractChanges — negatif", () => {
  it("removed kaydını BASE kimliğiyle üretir (hedefte geçerli kimlik yok)", () => {
    const base = [
      surface("node:aaa", "ApiContract", "app.OrdersApi", "v1"),
      surface("node:bbb", "EventContract", "app.OrderCreated", "v1"),
    ];
    const target = [surface("node:aaa", "ApiContract", "app.OrdersApi", "v1")];

    const changes = computeWikiContractChanges(base, target);
    expect(changes).toEqual<readonly ContractChangeRecord[]>([
      {
        contractId: "node:bbb",
        changeKind: "removed",
        summary: "app.OrderCreated removed: no entry in the target WikiSnapshot's graph contract surface",
      },
    ]);
  });

  it("her iki yüzeyde aynı anahtar + aynı içerik karması → boş (değişiklik yok)", () => {
    const base = [surface("node:aaa", "ApiContract", "app.OrdersApi", "v1")];
    const target = [surface("node:aaa", "ApiContract", "app.OrdersApi", "v1")];
    expect(computeWikiContractChanges(base, target)).toEqual([]);
  });
});

describe("computeWikiContractChanges — partial (dürüst boşluk ve sınırlar)", () => {
  it("boş yüzeyler boş döner (sözleşme kaydı yok; uydurma kayıt üretilmez)", () => {
    expect(computeWikiContractChanges([], [])).toEqual([]);
    const base = [surface("node:aaa", "ApiContract", "app.OrdersApi", "v1")];
    expect(computeWikiContractChanges(base, [])).toHaveLength(1);
    expect(computeWikiContractChanges([], base)).toHaveLength(1);
  });

  it("aynı anahtarlı birden çok kayıt kanonik kimlik sırasında İLK kazanır (D2 first-wins örüntüsü)", () => {
    const base = [
      // Aynı anahtar iki kayıt: node:x1 < node:x2 kanonik sırada → x1 kazanır.
      surface("node:x2", "ApiContract", "app.OrdersApi", "dupe-later"),
      surface("node:x1", "ApiContract", "app.OrdersApi", "dupe-first"),
    ];
    const target = [surface("node:x1b", "ApiContract", "app.OrdersApi", "changed")];

    const changes = computeWikiContractChanges(base, target);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeKind: "modified", contractId: "node:x1b" });
    // Kazanan x1'in içerik karması ("hash-dupe-first" → summary'de 12 karakter
    // parçası "hash-dupe-fi"); x2 ("dupe-later") KAZANMAZ.
    expect(changes[0]?.summary).toContain("base=hash-dupe-fi");
    expect(changes[0]?.summary).not.toContain("dupe-later");
  });

  it("geçersiz yüzey girdisi açık reddedilir (WikiProjectionError; uydurma kayıt yok)", () => {
    for (const bad of [
      [surface("", "ApiContract", "app.OrdersApi", "v1")],
      [surface("node:aaa", "", "app.OrdersApi", "v1")],
      [surface("node:aaa", "ApiContract", "", "v1")],
      [{ contractId: "node:aaa", nodeKind: "ApiContract", qualifiedName: "app.OrdersApi", contentHash: "" }],
      [{ contractId: "node:aaa", nodeKind: "ApiContract", qualifiedName: "app.OrdersApi" }],
    ]) {
      expect(() =>
        computeWikiContractChanges(bad as readonly WikiContractNodeSurface[], []),
      ).toThrow(WikiProjectionError);
    }
    try {
      computeWikiContractChanges(
        [surface("", "ApiContract", "app.OrdersApi", "v1")],
        [],
      );
    } catch (error) {
      expect((error as WikiProjectionError).code).toBe("wiki/invalid-contract-surface");
    }
  });
});

describe("wikiContractSurfaceOf", () => {
  /** Yalnızca sözleşme yüzeyi denenen küçük graph (Class node'u yüzey dışı). */
  function buildGraph(state: SnapshotGraph["meta"]["state"] = "ready"): SnapshotGraph {
    return createSnapshot({
      workspaceId: "ws_cc",
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state,
      createdAt: "2026-11-08T00:00:00.000Z",
      nodes: [
        {
          kind: "ApiContract",
          qualifiedName: "app.OrdersApi",
          relativePath: "openapi.yaml",
          location: {
            relativePath: "openapi.yaml",
            startLine: 1,
            endLine: 20,
            sourceHash: "h1",
          },
          attributes: { route: "/orders", method: "post" },
        },
        {
          kind: "Class",
          qualifiedName: "app.OrdersService",
          relativePath: "src/orders/OrdersService.ts",
          location: {
            relativePath: "src/orders/OrdersService.ts",
            startLine: 1,
            endLine: 10,
            sourceHash: "h2",
          },
        },
        {
          kind: "EventContract",
          qualifiedName: "app.OrderCreated",
          relativePath: "asyncapi.yaml",
        },
      ],
      edges: [],
    });
  }

  it("yalnızca sözleşme node türlerini yüzeye alır; kimlik domain nodeId sözleşmesidir", () => {
    const graph = buildGraph();
    const surfaceOf = wikiContractSurfaceOf(graph);
    expect(surfaceOf).toHaveLength(2);
    expect(surfaceOf.map((entry) => entry.qualifiedName).sort()).toEqual([
      "app.OrderCreated",
      "app.OrdersApi",
    ]);
    // contractId = domain nodeId(workspace, kind, qualifiedName, relativePath)
    // — packages/contracts types.ts ContractCandidate.contractId sözleşmesi.
    const api = surfaceOf.find((entry) => entry.qualifiedName === "app.OrdersApi");
    expect(api?.contractId).toMatch(/^node:[0-9a-f]{64}$/);
    expect(api?.nodeKind).toBe("ApiContract");
  });

  it("contentHash = sha256(canonicalJson(node içeriği)); kimlik dışı içerik farkı karmayı değiştirir", () => {
    const api = wikiContractSurfaceOf(buildGraph()).find(
      (entry) => entry.qualifiedName === "app.OrdersApi",
    );
    expect(api).toBeDefined();
    const expected = sha256Hex(
      utf8Encode(
        canonicalJson({
          kind: "ApiContract",
          qualifiedName: "app.OrdersApi",
          location: {
            relativePath: "openapi.yaml",
            startLine: 1,
            endLine: 20,
            sourceHash: "h1",
          },
          attributes: { method: "post", route: "/orders" },
        }),
      ),
    );
    expect(api?.contentHash).toBe(expected);
  });

  it("aynı graph iki koşumda aynı yüzeyi üretir; yüzey kimliğe göre kanonik sıralıdır", () => {
    const a = wikiContractSurfaceOf(buildGraph());
    const b = wikiContractSurfaceOf(buildGraph());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const ids = a.map((entry) => entry.contractId);
    expect([...ids].sort()).toEqual(ids);
  });

  it("WIKI_CONTRACT_NODE_KINDS projection CONTRACT_NODE_KINDS kümesiyle aynıdır", () => {
    expect([...WIKI_CONTRACT_NODE_KINDS].sort()).toEqual([
      "ApiContract",
      "ContractVersion",
      "EventContract",
      "SchemaContract",
    ]);
  });
});
