import { describe, expect, it } from "vitest";

import {
  BrokenLinkDiagnosticSchema,
  WikiLinkDraftSchema,
  WikiLinkKindSchema,
  WikiLinkSchema,
  WikiProjectionError,
  buildWikiLinkIndex,
  resolveWikiLinks,
  type WikiAliasEntry,
  type WikiLinkDraft,
  type WikiPageTarget,
} from "../src/index.js";

/**
 * Wiki link modülü — test üçlüsü (TŞ v2.1 §16A.2 çift yönlü bağlantılar ve
 * kanıtlar, §16A.7 veri modeli, §16A.10 "Çift yönlü link" kabul satırı;
 * docs/wiki-spec.md §3.3/§3.6; K-013 karar #4; sprint-4 W3).
 *
 * Pozitif: A→B linki tek kayıt yazılır; B'nin backlink sorgusu A'yı
 * bulur (§16A.10: "from->to ilişkisi aynı snapshot'ta target backlink
 * sorgusunda bulunur; verified ise evidence mevcut"); hedef slug/pageId
 * ve alias metni/redirect'i doğru çözümlenir (§16A.1 alias redirect).
 * Negatif: çözümlenemeyen hedef → WikiLink toPageId=null KORUNUR ve
 * brokenLinkDiagnostics kaydı üretilir (K-013 #4: sessiz silme yok);
 * kaynak sayfa + hedef adı gerekçede taşınır; kendine link diagnostics
 * ÜRETMEZ ama kendi backlink'inde görünür.
 * Partial: kısmen çözümlenen karışık link kümesi → çözümlenen + broken
 * karışımı, sayfa başına broken sayacı; kalıcı link satırlarından türetilen
 * indeks diagnostics'ta ham hedef adını bilmediğini dürüstçe null taşır.
 *
 * Determinizm: aynı girdi → bit-bit aynı çıktı JSON'u; çıktılar
 * deep-frozen; sıralama kanoniktir (link kimliği). Saf çekirdek: modül
 * yalnızca @causoryn/domain + zod'a bağlıdır; storage tipi import etmez.
 */

const WIKI_SNAPSHOT_ID = "wiki:snapshot-001";

const P_ORDERS = "page:11111111";
const P_BILLING = "page:22222222";
const P_DATA = "page:33333333";

const PAGES: readonly WikiPageTarget[] = [
  {
    id: P_ORDERS,
    slug: "order-service",
    route: "/wiki/projects-modules/order-service",
  },
  {
    id: P_BILLING,
    slug: "billing-service",
    route: "/wiki/projects-modules/billing-service",
  },
  { id: P_DATA, slug: "orders", route: "/wiki/data-schemas/orders" },
];

/**
 * wiki_aliases satırlarının okuma modeli (storage eşlemesi: pageId ↔
 * TŞ oldPageId; alias ↔ eski slug/başlık; candidateNewPageId ↔ redirect).
 */
const ALIASES: readonly WikiAliasEntry[] = [
  // Alias metni sahibi sayfaya çözümlenir (candidate redirect yok).
  { pageId: P_DATA, alias: "orders-table" },
  // Kesin rename redirect: metin yeni sayfaya yönlendirir (confidence 1).
  {
    pageId: P_DATA,
    alias: "legacy-orders",
    candidateNewPageId: P_ORDERS,
    matchConfidence: 1,
  },
  // Belirsiz redirect (confidence < 1): verified iddia düşürülür.
  {
    pageId: P_BILLING,
    alias: "billing-svc",
    candidateNewPageId: P_BILLING,
    matchConfidence: 0.7,
  },
];

function evidenceRef(id: string) {
  return {
    evidenceId: id,
    relativePath: "src/orders/index.ts",
    startLine: 1,
    endLine: 5,
    sourceHash: "sha256:src/orders/index.ts",
  };
}

function draft(overrides: {
  id: string;
  fromPageId: string;
  toRef: string;
  kind?: WikiLinkDraft["kind"];
  resolution?: WikiLinkDraft["resolution"];
  evidenceRefs?: WikiLinkDraft["evidenceRefs"];
}): WikiLinkDraft {
  return {
    id: overrides.id,
    fromPageId: overrides.fromPageId,
    toRef: overrides.toRef,
    kind: overrides.kind ?? "DEPENDS_ON",
    resolution: overrides.resolution ?? "verified",
    evidenceRefs: overrides.evidenceRefs ?? [evidenceRef("ev-1")],
  };
}

function resolveDefault(drafts: readonly WikiLinkDraft[]) {
  return resolveWikiLinks(drafts, {
    wikiSnapshotId: WIKI_SNAPSHOT_ID,
    pages: PAGES,
    aliases: ALIASES,
  });
}

// ---------------------------------------------------------------------------
// Şema sözleşmesi (TŞ §16A.2/§16A.7; K-013 #4)
// ---------------------------------------------------------------------------

describe("WikiLink şeması", () => {
  it("TŞ §16A.2'nin 11 link türünü kabul eder, bilinmeyen türü reddeder", () => {
    expect(WikiLinkKindSchema.options).toHaveLength(11);
    for (const kind of [
      "PARENT_OF",
      "DOCUMENTS",
      "DEPENDS_ON",
      "CALLS",
      "IMPLEMENTS",
      "PRODUCES",
      "CONSUMES",
      "TESTED_BY",
      "FLOWS_TO",
      "RELATED_CONTRACT",
      "CHANGED_IN",
    ] as const) {
      expect(WikiLinkKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(WikiLinkKindSchema.safeParse("CALLS_BACK").success).toBe(false);
  });

  it("verified link evidencesız reddedilir (TŞ §16A.7: her verified link ≥1 Evidence)", () => {
    const noEvidence = WikiLinkSchema.safeParse({
      id: "link:x",
      wikiSnapshotId: WIKI_SNAPSHOT_ID,
      fromPageId: P_ORDERS,
      toPageId: P_BILLING,
      kind: "DEPENDS_ON",
      resolution: "verified",
      evidenceRefs: [],
    });
    expect(noEvidence.success).toBe(false);
    // Modül sınırında red WikiProjectionError olarak raporlanır (wiki/invalid-input).
    expect(() =>
      resolveDefault([
        draft({
          id: "link:x",
          fromPageId: P_ORDERS,
          toRef: P_BILLING,
          resolution: "verified",
          evidenceRefs: [],
        }),
      ]),
    ).toThrow(WikiProjectionError);
  });

  it("toPageId=null geçerlidir ve BrokenLinkDiagnostic şeması kaynak+hedef taşır (K-013 #4)", () => {
    const parsed = WikiLinkSchema.parse({
      id: "link:broken",
      wikiSnapshotId: WIKI_SNAPSHOT_ID,
      fromPageId: P_ORDERS,
      toPageId: null,
      kind: "DEPENDS_ON",
      resolution: "unresolved",
      evidenceRefs: [],
    });
    expect(parsed.toPageId).toBeNull();

    const diagnostic = BrokenLinkDiagnosticSchema.parse({
      linkId: "link:broken",
      fromPageId: P_ORDERS,
      toRef: "ghost-page",
      kind: "DEPENDS_ON",
      reason: "hedef çözümlenemedi",
    });
    expect(diagnostic.toRef).toBe("ghost-page");
    // Kalıcı satırdan türetilen diagnostics ham hedef adını null taşır.
    expect(
      BrokenLinkDiagnosticSchema.parse({
        linkId: "link:broken",
        fromPageId: P_ORDERS,
        toRef: null,
        kind: "DEPENDS_ON",
        reason: "kalıcı satır",
      }).toRef,
    ).toBeNull();
  });

  it("boş kimlik/hedef alanlarını reddeder", () => {
    expect(
      WikiLinkDraftSchema.safeParse({
        id: "link:y",
        fromPageId: P_ORDERS,
        toRef: "   ",
        kind: "DEPENDS_ON",
        resolution: "verified",
        evidenceRefs: [evidenceRef("ev-1")],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pozitif: çift yönlü indeks + hedef çözümleme
// ---------------------------------------------------------------------------

describe("pozitif: çift yönlü link ve backlink ters indeks", () => {
  it("A→B linki tek kayıttır; backlinks(B) A'yı bulur ve verified link evidence taşır (§16A.10)", () => {
    const result = resolveDefault([
      draft({
        id: "link:dep-orders-billing",
        fromPageId: P_ORDERS,
        toRef: P_BILLING,
        kind: "DEPENDS_ON",
        resolution: "verified",
        evidenceRefs: [evidenceRef("ev-dep-1")],
      }),
    ]);

    expect(result.links).toHaveLength(1);
    const link = result.links[0]!;
    expect(link.toPageId).toBe(P_BILLING);
    expect(link.wikiSnapshotId).toBe(WIKI_SNAPSHOT_ID);
    expect(link.resolution).toBe("verified");
    expect(link.evidenceRefs.length).toBeGreaterThanOrEqual(1);

    const index = buildWikiLinkIndex(result.links);
    const backlinks = index.backlinks(P_BILLING);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]!.id).toBe("link:dep-orders-billing");
    expect(backlinks[0]!.fromPageId).toBe(P_ORDERS);
    // §16A.10: verified ise evidence mevcut — backlink yüzeyinde de taşınır.
    expect(backlinks[0]!.evidenceRefs.length).toBe(1);
    expect(index.forwardLinks(P_ORDERS)).toHaveLength(1);
    expect(index.forwardLinks(P_ORDERS)[0]!.toPageId).toBe(P_BILLING);
    // Tek kayıt: çift yönlülük türetilir, iki bağımsız kayıt yazılmaz (ADR-013).
    expect(result.links).toHaveLength(1);
    expect(index.brokenLinkCount).toBe(0);
  });

  it("hedef slug ile çözümlenir", () => {
    const result = resolveDefault([
      draft({
        id: "link:by-slug",
        fromPageId: P_ORDERS,
        toRef: "billing-service",
      }),
    ]);
    expect(result.links[0]!.toPageId).toBe(P_BILLING);
    expect(result.brokenLinkDiagnostics).toHaveLength(0);
  });

  it("alias metni sahibi sayfaya çözümlenir; alias redirect candidate hedefe gider (§16A.1)", () => {
    const result = resolveDefault([
      draft({ id: "link:alias-owner", fromPageId: P_ORDERS, toRef: "orders-table" }),
      draft({ id: "link:alias-redirect", fromPageId: P_BILLING, toRef: "legacy-orders" }),
    ]);
    const byId = new Map(result.links.map((link) => [link.id, link]));
    expect(byId.get("link:alias-owner")!.toPageId).toBe(P_DATA);
    // candidateNewPageId tanımlı → redirect hedefi kazanır (confidence 1).
    expect(byId.get("link:alias-redirect")!.toPageId).toBe(P_ORDERS);
    expect(result.brokenLinkDiagnostics).toHaveLength(0);
  });

  it("belirsiz alias (confidence<1) üzerinden çözümlenen verified link heuristic'e düşer (doğrulanmış taklit yok)", () => {
    const result = resolveDefault([
      draft({
        id: "link:fuzzy-alias",
        fromPageId: P_ORDERS,
        toRef: "billing-svc",
        resolution: "verified",
        evidenceRefs: [evidenceRef("ev-fuzzy")],
      }),
    ]);
    const link = result.links[0]!;
    expect(link.toPageId).toBe(P_BILLING);
    // K-013 #4 ruhu + §16A.10 Belirsizlik: alias redirect kesin eşleşme
    // değildir; verified iddia sessizce korunmaz.
    expect(link.resolution).toBe("heuristic");
    expect(link.evidenceRefs).toHaveLength(1);
  });

  it("kesin alias (confidence=1) verified çözümlemeyi korur", () => {
    const result = resolveDefault([
      draft({
        id: "link:exact-alias",
        fromPageId: P_BILLING,
        toRef: "legacy-orders",
        resolution: "verified",
        evidenceRefs: [evidenceRef("ev-exact")],
      }),
    ]);
    expect(result.links[0]!.resolution).toBe("verified");
    expect(result.links[0]!.toPageId).toBe(P_ORDERS);
  });
});

// ---------------------------------------------------------------------------
// Negatif: broken-link diagnostics (K-013 #4)
// ---------------------------------------------------------------------------

describe("negatif: broken-link diagnostics", () => {
  it("olmayan sayfaya link toPageId=null korunur VE diagnostics kaydı üretilir (kaynak sayfa + hedef adı)", () => {
    const result = resolveDefault([
      draft({
        id: "link:ghost-target",
        fromPageId: P_ORDERS,
        toRef: "ghost-page",
        resolution: "verified",
        evidenceRefs: [evidenceRef("ev-ghost")],
      }),
    ]);
    // K-013 #4: kayıt sessizce SİLİNMEZ — toPageId=null ile korunur.
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.toPageId).toBeNull();
    // Diagnostics: hangi kaynak sayfa, hangi hedef adı.
    expect(result.brokenLinkDiagnostics).toHaveLength(1);
    const diagnostic = result.brokenLinkDiagnostics[0]!;
    expect(diagnostic.linkId).toBe("link:ghost-target");
    expect(diagnostic.fromPageId).toBe(P_ORDERS);
    expect(diagnostic.toRef).toBe("ghost-page");
    expect(diagnostic.reason).toContain(P_ORDERS);
    expect(diagnostic.reason).toContain("ghost-page");
    // Kaldırılan hedef indeksin hiçbir backlink kovasına düşmez.
    const index = buildWikiLinkIndex(result.links);
    expect(index.backlinks("page:nonexistent")).toHaveLength(0);
    expect(index.brokenLinkCount).toBe(1);
  });

  it("kendine link kendi backlink'inde görünür ama diagnostics ÜRETMEZ", () => {
    const result = resolveDefault([
      draft({ id: "link:self", fromPageId: P_ORDERS, toRef: P_ORDERS }),
    ]);
    expect(result.links[0]!.toPageId).toBe(P_ORDERS);
    expect(result.brokenLinkDiagnostics).toHaveLength(0);
    const index = buildWikiLinkIndex(result.links);
    const selfBacklinks = index.backlinks(P_ORDERS);
    expect(selfBacklinks).toHaveLength(1);
    expect(selfBacklinks[0]!.fromPageId).toBe(P_ORDERS);
    expect(index.brokenLinkCountByPage(P_ORDERS)).toBe(0);
  });

  it("bilinmeyen kaynak sayfalı draft reddedilir (kaynak sayfa yoksa link üretilmez)", () => {
    expect(() =>
      resolveDefault([
        draft({ id: "link:orphan-source", fromPageId: "page:missing", toRef: P_BILLING }),
      ]),
    ).toThrow(WikiProjectionError);
  });

  it("aynı link kimliği iki kez gelirse reddedilir", () => {
    expect(() =>
      resolveDefault([
        draft({ id: "link:dup", fromPageId: P_ORDERS, toRef: P_BILLING }),
        draft({ id: "link:dup", fromPageId: P_ORDERS, toRef: P_DATA }),
      ]),
    ).toThrow(/link:dup/);
  });

  it("hiçbir sayfaya bağlanamayan alias metni broken diagnostics üretir", () => {
    const result = resolveWikiLinks(
      [draft({ id: "link:orphan-alias", fromPageId: P_ORDERS, toRef: "orphan-text" })],
      {
        wikiSnapshotId: WIKI_SNAPSHOT_ID,
        pages: PAGES,
        aliases: [{ pageId: "page:gone", alias: "orphan-text" }],
      },
    );
    expect(result.links[0]!.toPageId).toBeNull();
    expect(result.brokenLinkDiagnostics).toHaveLength(1);
    expect(result.brokenLinkDiagnostics[0]!.toRef).toBe("orphan-text");
  });
});

// ---------------------------------------------------------------------------
// Partial: karışık küme + sayfa başına broken sayacı + determinizm
// ---------------------------------------------------------------------------

describe("partial: karışık link kümesi ve determinizm", () => {
  const MIXED: readonly WikiLinkDraft[] = [
    draft({ id: "link:a-resolved-slug", fromPageId: P_ORDERS, toRef: "billing-service" }),
    draft({ id: "link:b-resolved-id", fromPageId: P_ORDERS, toRef: P_DATA }),
    draft({ id: "link:c-broken", fromPageId: P_BILLING, toRef: "no-such-page" }),
    draft({ id: "link:d-self", fromPageId: P_DATA, toRef: P_DATA }),
  ];

  it("kısmen çözümlenen küme karışık durum + sayfa başına broken sayacı verir", () => {
    const result = resolveDefault(MIXED);
    expect(result.links).toHaveLength(4);
    const byId = new Map(result.links.map((link) => [link.id, link]));
    expect(byId.get("link:a-resolved-slug")!.toPageId).toBe(P_BILLING);
    expect(byId.get("link:b-resolved-id")!.toPageId).toBe(P_DATA);
    expect(byId.get("link:c-broken")!.toPageId).toBeNull();
    expect(byId.get("link:d-self")!.toPageId).toBe(P_DATA);

    expect(result.brokenLinkDiagnostics).toHaveLength(1);
    expect(result.brokenLinkDiagnostics[0]!.linkId).toBe("link:c-broken");

    // Sayfa başına broken sayacı: yalnızca broken link üreten kaynak sayfa.
    expect(result.brokenCountByPage.get(P_BILLING)).toBe(1);
    expect(result.brokenCountByPage.get(P_ORDERS)).toBeUndefined();

    const index = buildWikiLinkIndex(result.links);
    expect(index.totalLinkCount).toBe(4);
    expect(index.resolvedLinkCount).toBe(3);
    expect(index.brokenLinkCount).toBe(1);
    expect(index.brokenLinkCountByPage(P_BILLING)).toBe(1);
    expect(index.brokenLinkCountByPage(P_ORDERS)).toBe(0);
    expect(index.backlinks(P_BILLING)).toHaveLength(1);
    expect(index.backlinks(P_DATA)).toHaveLength(2); // b-resolved-id + d-self
    expect(index.forwardLinks(P_ORDERS)).toHaveLength(2);
  });

  it("kalıcı link satırlarından türetilen indeks diagnostics'ta ham hedef adını null taşır (dürüst degrade)", () => {
    const resolved = resolveDefault(MIXED);
    // Depolama round-trip benzetimi: yalnızca WikiLink alanları kalır.
    const persisted = resolved.links.map((link) => ({
      id: link.id,
      wikiSnapshotId: link.wikiSnapshotId,
      fromPageId: link.fromPageId,
      toPageId: link.toPageId,
      kind: link.kind,
      resolution: link.resolution,
      evidenceRefs: link.evidenceRefs,
    }));
    const index = buildWikiLinkIndex(persisted);
    expect(index.brokenLinkCount).toBe(1);
    const diagnostics = index.brokenLinkDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.linkId).toBe("link:c-broken");
    expect(diagnostics[0]!.fromPageId).toBe(P_BILLING);
    expect(diagnostics[0]!.toRef).toBeNull();
    expect(diagnostics[0]!.kind).toBe("DEPENDS_ON");
    expect(diagnostics[0]!.reason).toContain("link:c-broken");
  });

  it("aynı girdi → bit-bit aynı çıktı JSON'u; çıktılar deep-frozen; sıralama kanonik", () => {
    const shuffled = [...MIXED].reverse();
    const first = resolveDefault(MIXED);
    const second = resolveDefault(shuffled);
    const jsonFirst = JSON.stringify({
      links: first.links,
      diagnostics: first.brokenLinkDiagnostics,
    });
    const jsonSecond = JSON.stringify({
      links: second.links,
      diagnostics: second.brokenLinkDiagnostics,
    });
    expect(jsonSecond).toBe(jsonFirst);
    // Kanonik sıra: link kimliğine göre.
    const ids = first.links.map((link) => link.id);
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);

    const index = buildWikiLinkIndex(first.links);
    expect(Object.isFrozen(index.backlinks(P_BILLING))).toBe(true);
    expect(Object.isFrozen(index.forwardLinks(P_ORDERS))).toBe(true);
    expect(Object.isFrozen(index.brokenLinkDiagnostics())).toBe(true);
    expect(Object.isFrozen(first.links)).toBe(true);
    expect(Object.isFrozen(first.brokenLinkDiagnostics)).toBe(true);
  });

  it("boş link kümesi boş indeks verir; bilinmeyen sayfa sorgusu boş dizi döner", () => {
    const result = resolveDefault([]);
    expect(result.links).toHaveLength(0);
    expect(result.brokenLinkDiagnostics).toHaveLength(0);
    const index = buildWikiLinkIndex(result.links);
    expect(index.totalLinkCount).toBe(0);
    expect(index.backlinks(P_ORDERS)).toHaveLength(0);
    expect(index.forwardLinks(P_ORDERS)).toHaveLength(0);
    expect(index.backlinks("page:unknown")).toHaveLength(0);
    expect(index.brokenLinkCountByPage("page:unknown")).toBe(0);
  });
});
