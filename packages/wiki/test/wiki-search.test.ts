import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteGraphRepository,
  SqliteWikiStore,
  type WikiPageInput,
} from "@causoryn/storage-sqlite";

import {
  DEFAULT_WIKI_SEARCH_LIMIT,
  MAX_WIKI_SEARCH_LIMIT,
  WikiSearchError,
  WikiSearchStore,
  buildWikiMatchExpression,
  decodeWikiSearchCursor,
  encodeWikiSearchCursor,
  escapeFtsPhrase,
  normalizeWikiSearchQuery,
} from "../src/index.js";

/**
 * Wiki FTS5 arama — test üçlüsü (TŞ v2.1 §16A.3; docs/wiki-spec.md §3.7;
 * K-013 #5; sprint-4 W4).
 *
 * Pozitif: 'orders' sorgusu → OrdersService sayfası İLK sırada (exact >
 * başlık > modül > BM25 sıralaması), matchedFields FTS5 sütun gerçeği
 * olarak dolu, evidenceIds sayfa bölümlerinin kanıt referansları; tam
 * route eşleşmesi ("/api/orders") başlık eşleşmesini geçer (exact leg).
 * Negatif: MATCH metakarakterli sorgu '"()*' kaçışlanır, PATLAMAZ; boş
 * sorgu açık reddedilir (wiki/empty-query); limit 0/201/1.5 reddedilir
 * (K-013 #5: default 50, max 200); bozuk cursor reddedilir; başka
 * workspace'in wikiSnapshotId'si çözülemez; building (yayınlanmamış)
 * build'in içeriği aramada görünmez.
 * Partial: graph yakınlık ayak verisi YOK → skippedRankLegs
 * "graphProximity" degrade notu + kalan ayaklarla deterministik sıralama;
 * yakınlık VERİLDİĞİNDE bm25-eşit adaylar yakınlıkla sıralanır.
 *
 * Determinizm: aynı girdi → aynı arama sonucu JSON; tie-break leksik
 * (başlık, pageId). Tüm DB'ler os.tmpdir() altındadır (ADR-008).
 */

const WS = "ws_search";
const WS_ROOT = "D:/fixtures/search";
const GRAPH_SNAPSHOT_ID = "gsnap-search-1";
const GRAPH_SNAPSHOT_ID_2 = "gsnap-search-2";
const REVISION_REF = "b1a2c3d4e5f6";
const TEMPLATE_VERSION = "tpl-wiki-1";
const CREATED_AT = "2026-11-05T09:00:00.000Z";
const BUILT_AT = "2026-11-05T09:05:00.000Z";
const WIKI_ID = "wikisnap-search-1";
const WS_OTHER = "ws_search_other";
const WS_OTHER_ROOT = "D:/fixtures/search-other";
const WIKI_ID_OTHER = "wikisnap-other-1";

const EV_HANDLER = {
  evidenceId: "ev-handler",
  relativePath: "src/orders/create-order.ts",
  startLine: 10,
  endLine: 42,
  sourceHash: "sha256:src/orders/create-order.ts",
};
const EV_FLOW = {
  evidenceId: "ev-flow",
  relativePath: "src/orders/flow.md",
  startLine: 1,
  endLine: 12,
  sourceHash: "sha256:src/orders/flow.md",
};
const EV_ROUTE = {
  evidenceId: "ev-route",
  relativePath: "src/orders/routes.ts",
  startLine: 3,
  endLine: 9,
  sourceHash: "sha256:src/orders/routes.ts",
};

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-wiki-search-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function fixturePage(page: {
  id: string;
  kind: WikiPageInput["kind"];
  title: string;
  route: string;
  freshness?: WikiPageInput["freshness"];
  coverageStatus?: WikiPageInput["coverage"]["status"];
}): WikiPageInput {
  return {
    id: page.id,
    kind: page.kind,
    parentId: null,
    title: page.title,
    slug: page.id,
    route: page.route,
    contentHash: `sha256:page:${page.id}`,
    freshness: page.freshness ?? "fresh",
    coverage: { status: page.coverageStatus ?? "complete" },
  };
}

/** Ana fixture: 7 sayfa; 'orders' sorgusu için tablo araştırılmış kurgu. */
function seedMainWiki(db: Database.Database): number {
  const graph = new SqliteGraphRepository(db.name);
  try {
    graph.registerWorkspace({ id: WS, rootPath: WS_ROOT, createdAt: CREATED_AT });
  } finally {
    graph.close();
  }
  const store = new SqliteWikiStore(db);
  const wikiSid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: GRAPH_SNAPSHOT_ID,
    revisionRef: REVISION_REF,
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
  });
  const pages: WikiPageInput[] = [
    fixturePage({
      id: "p_overview",
      kind: "overview",
      title: "Overview",
      route: "/wiki/overview",
    }),
    fixturePage({
      id: "p_orders_service",
      kind: "symbol",
      title: "OrdersService",
      route: "/wiki/symbol/orders-service",
    }),
    fixturePage({
      id: "p_orders_module",
      kind: "module",
      title: "Order Module",
      route: "/wiki/module/orders",
    }),
    fixturePage({
      id: "p_refund",
      kind: "policy",
      title: "Refund Policy",
      route: "/wiki/policy/refund",
      freshness: "stale",
    }),
    fixturePage({
      id: "p_flow_alpha",
      kind: "business_flow",
      title: "Alpha Flow",
      route: "/wiki/flow/alpha",
    }),
    fixturePage({
      id: "p_flow_beta",
      kind: "business_flow",
      title: "Beta Flow",
      route: "/wiki/flow/beta",
    }),
    fixturePage({
      id: "p_api_route",
      kind: "api",
      title: "Create Order Endpoint",
      route: "/wiki/api/create-order",
    }),
  ];
  for (const page of pages) {
    store.addWikiPage(wikiSid, page);
  }
  store.addWikiPageSection(wikiSid, {
    id: "sec_service_intent",
    pageId: "p_orders_service",
    sectionKey: "intent",
    generatedMarkdown: "OrdersService sipariş akışını yönetir.",
    evidenceRefs: [EV_HANDLER, EV_FLOW],
    status: "ok",
  });
  store.addWikiPageSection(wikiSid, {
    id: "sec_service_spec",
    pageId: "p_orders_service",
    sectionKey: "spec",
    generatedMarkdown: "Create-order kullanım senaryosu.",
    evidenceRefs: [EV_ROUTE, EV_HANDLER],
    status: "ok",
  });
  store.indexWikiFts(wikiSid, [
    {
      pageId: "p_overview",
      title: "Overview",
      body: "Genel bakış: orders ve ödemeler.",
    },
    {
      pageId: "p_orders_service",
      title: "OrdersService",
      qualifiedSymbol: "Shop.OrdersService",
      module: "orders",
      tags: "orders checkout",
      body: "OrdersService orders akışını yönetir.",
    },
    {
      pageId: "p_orders_module",
      title: "Order Module",
      module: "orders",
      body: "orders modülü sipariş işlemlerini kapsar.",
    },
    {
      pageId: "p_refund",
      title: "Refund Policy",
      body: "orders kayıtları arşivlenir.",
    },
    {
      pageId: "p_flow_alpha",
      title: "Alpha Flow",
      body: "orders akışı örneği",
    },
    {
      pageId: "p_flow_beta",
      title: "Beta Flow",
      body: "orders akışı örneği",
    },
    {
      pageId: "p_api_route",
      title: "Create Order Endpoint",
      apiRoute: "/api/orders",
      body: "POST /api/orders kaydı.",
    },
  ]);
  store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);
  return wikiSid;
}

/** Yayınlanmamış (building) ikinci build: arama yüzeyinde GÖRÜNMEZ. */
function seedUnpublishedBuild(db: Database.Database): void {
  const store = new SqliteWikiStore(db);
  const wikiSid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: GRAPH_SNAPSHOT_ID_2,
    revisionRef: REVISION_REF,
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
  });
  store.addWikiPage(
    wikiSid,
    fixturePage({
      id: "p_secret",
      kind: "symbol",
      title: "SecretService",
      route: "/wiki/symbol/secret",
    }),
  );
  store.indexWikiFts(wikiSid, [
    {
      pageId: "p_secret",
      title: "SecretService",
      qualifiedSymbol: "Shop.SecretService",
      body: "secretbuildtoken yalnızca building build'te.",
    },
  ]);
}

/** Başka workspace: cross-workspace guard testi için. */
function seedOtherWorkspace(): void {
  const p = path.join(tempRoot, "other.sqlite");
  const graph = new SqliteGraphRepository(p);
  try {
    graph.registerWorkspace({
      id: WS_OTHER,
      rootPath: WS_OTHER_ROOT,
      createdAt: CREATED_AT,
    });
  } finally {
    graph.close();
  }
  const store = new SqliteWikiStore(p);
  try {
    const wikiSid = store.beginWikiBuild({
      workspaceId: WS_OTHER,
      graphSnapshotId: "gsnap-other-1",
      revisionRef: REVISION_REF,
      templateVersion: TEMPLATE_VERSION,
      createdAt: CREATED_AT,
    });
    store.addWikiPage(
      wikiSid,
      fixturePage({
        id: "p_other_page",
        kind: "overview",
        title: "Other Overview",
        route: "/wiki/other",
      }),
    );
    store.indexWikiFts(wikiSid, [
      { pageId: "p_other_page", title: "Other Overview", body: "orders" },
    ]);
    store.publishWiki(wikiSid, WIKI_ID_OTHER, "ready", BUILT_AT);
  } finally {
    store.close();
  }
}

/** Exact-route > başlık önceliği için ikinci küçük wiki (aynı workspace). */
function seedRouteWiki(db: Database.Database): void {
  const store = new SqliteWikiStore(db);
  const wikiSid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: "gsnap-search-route",
    revisionRef: REVISION_REF,
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
  });
  store.addWikiPage(
    wikiSid,
    fixturePage({
      id: "p_route_exact",
      kind: "api",
      title: "Endpoint",
      route: "/wiki/api/endpoint",
    }),
  );
  store.addWikiPage(
    wikiSid,
    fixturePage({
      id: "p_route_title",
      kind: "api",
      title: "Orders Docs",
      route: "/wiki/api/orders-docs",
    }),
  );
  store.indexWikiFts(wikiSid, [
    {
      pageId: "p_route_exact",
      title: "Endpoint",
      apiRoute: "/api/orders",
      body: "POST /api/orders handler'ı.",
    },
    {
      pageId: "p_route_title",
      title: "Orders Docs",
      body: "/api/orders dokümü.",
    },
  ]);
  store.publishWiki(wikiSid, "wikisnap-search-route", "ready", BUILT_AT);
}

function openSearchStore(db: Database.Database): WikiSearchStore {
  return new WikiSearchStore(db);
}

describe("wiki search — saf çekirdek (query/match/cursor)", () => {
  it("normalizeWikiSearchQuery: trim + iç boşluk tek boşluğa iner; boş → boş string", () => {
    expect(normalizeWikiSearchQuery("  orders   service\t")).toBe(
      "orders service",
    );
    expect(normalizeWikiSearchQuery("   ")).toBe("");
  });

  it("escapeFtsPhrase: çift tırnak ikiye katlanır (Faz A deseni)", () => {
    expect(escapeFtsPhrase('a"b')).toBe('a""b');
    expect(escapeFtsPhrase('orders')).toBe("orders");
  });

  it("buildWikiMatchExpression: kaçışlı phrase sarmalama", () => {
    expect(buildWikiMatchExpression("orders")).toBe('"orders"');
    expect(buildWikiMatchExpression('x"y')).toBe('"x""y"');
  });

  it("cursor codec: roundtrip; bozuk cursor → null", () => {
    expect(decodeWikiSearchCursor(encodeWikiSearchCursor(0))).toBe(0);
    expect(decodeWikiSearchCursor(encodeWikiSearchCursor(150))).toBe(150);
    expect(decodeWikiSearchCursor("not-a-cursor")).toBeNull();
    expect(decodeWikiSearchCursor("")).toBeNull();
  });
});

describe("wiki search — pozitif", () => {
  it("'orders' sorgusu → OrdersService İLK sırada + matchedFields dolu + evidenceIds", () => {
    const db = new Database(path.join(tempRoot, "main.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const result = search.search({ workspaceId: WS, query: "orders" });

      expect(result.wikiSnapshotId).toBe(WIKI_ID);
      expect(result.query).toBe("orders");
      expect(result.matchExpression).toBe('"orders"');
      expect(result.totalMatches).toBe(7);
      expect(result.hits.length).toBe(7);
      expect(result.nextCursor).toBeNull();
      expect(result.skippedRankLegs).toEqual(["graphProximity"]);

      const first = result.hits[0]!;
      expect(first.pageId).toBe("p_orders_service");
      expect(first.title).toBe("OrdersService");
      expect(first.kind).toBe("symbol");
      expect(first.route).toBe("/wiki/symbol/orders-service");
      expect(first.freshness).toBe("fresh");
      expect(first.qualifiedSymbol).toBe("Shop.OrdersService");
      // FTS5 sütun gerçeği: title/qualifiedSymbol token düzeyinde 'orders'
      // DEĞİLDİR ('ordersservice' tek token); module/tags/body eşleşir.
      // matchedFields kanonik sütun sırasındadır.
      expect(first.matchedFields).toEqual(["module", "tags", "body"]);
      // Sayfa bölümlerinin kanıt referansları: tekrarsız + leksik sıralı.
      expect(first.evidenceIds).toEqual(["ev-flow", "ev-handler", "ev-route"]);
      expect(typeof first.snippet).toBe("string");

      // Başlık ayağı olan sayfa, yalnızca modül ayağı olanı geçer.
      expect(result.hits[1]!.pageId).toBe("p_orders_module");
      // bm25-eşit akış sayfaları leksik tie-break ile: Alpha < Beta.
      const alpha = result.hits.findIndex((h) => h.pageId === "p_flow_alpha");
      const beta = result.hits.findIndex((h) => h.pageId === "p_flow_beta");
      expect(alpha).toBeGreaterThan(-1);
      expect(beta).toBeGreaterThan(-1);
      expect(alpha).toBeLessThan(beta);
    } finally {
      db.close();
    }
  });

  it("tam route eşleşmesi ('/api/orders') başlık eşleşmesini geçer (exact > başlık)", () => {
    const db = new Database(path.join(tempRoot, "route.sqlite"));
    try {
      const graph = new SqliteGraphRepository(db.name);
      try {
        graph.registerWorkspace({
          id: WS,
          rootPath: WS_ROOT,
          createdAt: CREATED_AT,
        });
      } finally {
        graph.close();
      }
      seedRouteWiki(db);
      const search = openSearchStore(db);
      const result = search.search({ workspaceId: WS, query: "/api/orders" });

      expect(result.totalMatches).toBe(2);
      expect(result.hits[0]!.pageId).toBe("p_route_exact");
      expect(result.hits[0]!.matchedFields).toContain("apiRoute");
      expect(result.hits[1]!.pageId).toBe("p_route_title");
      // Başlık ayağı tek başına exact route ayağını geçemez.
      expect(result.hits[1]!.matchedFields).not.toContain("apiRoute");
    } finally {
      db.close();
    }
  });

  it("varsayılan ve üst sınır limit sabitleri K-013 #5'e göredir (50 / 200)", () => {
    expect(DEFAULT_WIKI_SEARCH_LIMIT).toBe(50);
    expect(MAX_WIKI_SEARCH_LIMIT).toBe(200);
  });
});

describe("wiki search — NUL bytes and full-text engine errors", () => {
  it("normalizeWikiSearchQuery treats NUL and other control characters as whitespace", () => {
    expect(normalizeWikiSearchQuery("ord\u0000ers")).toBe("ord ers");
    expect(normalizeWikiSearchQuery("\u0000orders\u0001\u007f")).toBe("orders");
    expect(normalizeWikiSearchQuery("\u0000\u0000")).toBe("");
  });

  it("a query with NUL bytes runs as a normal phrase search instead of failing in SQLite", () => {
    const db = new Database(path.join(tempRoot, "nul.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const result = search.search({ workspaceId: WS, query: "orders\u0000" });
      expect(result.query).toBe("orders");
      expect(result.matchExpression).toBe('"orders"');
      expect(result.totalMatches).toBe(7);
      expect(() => search.search({ workspaceId: WS, query: "\u0000" })).toThrowError(
        expect.objectContaining({ code: "wiki/empty-query" }),
      );
    } finally {
      db.close();
    }
  });

  function failingDatabase(error: Error): ConstructorParameters<typeof WikiSearchStore>[0] {
    return {
      prepare: () => ({
        get: () => ({ sid: 1, id: "wikisnap-stub" }),
        all: () => {
          throw error;
        },
      }),
    };
  }

  function sqliteError(code: string, message: string): Error {
    return Object.assign(new Error(message), { name: "SqliteError", code });
  }

  it("an FTS5 query error maps to wiki/invalid-field without SQL, engine text or stack in the message", () => {
    const search = new WikiSearchStore(
      failingDatabase(sqliteError("SQLITE_ERROR", 'fts5: syntax error near "SELECT wiki_fts"')),
    );
    let thrown: unknown;
    try {
      search.search({ workspaceId: WS, query: "orders" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WikiSearchError);
    expect((thrown as WikiSearchError).code).toBe("wiki/invalid-field");
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/SELECT|fts5|wiki_fts|syntax error|\n\s+at /i);
  });

  it("other SQLite failures map to a storage driver error (internal, logged by the service layer)", () => {
    const search = new WikiSearchStore(failingDatabase(sqliteError("SQLITE_CORRUPT", "database disk image is malformed")));
    expect(() => search.search({ workspaceId: WS, query: "orders" })).toThrowError(
      expect.objectContaining({ code: "storage/driver-error" }),
    );
  });
});

describe("wiki search — negatif", () => {
  it("MATCH metakarakterli sorgu '\"()*' kaçışlanır, patlamaz", () => {
    const db = new Database(path.join(tempRoot, "meta.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const result = search.search({ workspaceId: WS, query: '"()*' });
      expect(result.matchExpression).toBe(String.raw`"""()*"`);
      expect(result.totalMatches).toBe(0);
      expect(result.hits).toEqual([]);
      expect(result.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });

  it("boş sorgu açık reddedilir (wiki/empty-query)", () => {
    const db = new Database(path.join(tempRoot, "empty.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      for (const query of ["", "   ", "\t\n"]) {
        expect(() => search.search({ workspaceId: WS, query })).toThrowError(
          WikiSearchError,
        );
        try {
          search.search({ workspaceId: WS, query });
          expect.unreachable("boş sorgu reddedilmeliydi");
        } catch (error) {
          expect(error).toBeInstanceOf(WikiSearchError);
          expect((error as WikiSearchError).code).toBe("wiki/empty-query");
        }
      }
    } finally {
      db.close();
    }
  });

  it("limit doğrulaması: 0 / 201 / 1.5 / NaN reddedilir; 200 kabul edilir (K-013 #5)", () => {
    const db = new Database(path.join(tempRoot, "limit.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
        expect(() =>
          search.search({ workspaceId: WS, query: "orders", limit }),
        ).toThrowError(WikiSearchError);
        try {
          search.search({ workspaceId: WS, query: "orders", limit });
          expect.unreachable(`limit reddedilmeliydi: ${String(limit)}`);
        } catch (error) {
          expect((error as WikiSearchError).code).toBe("wiki/invalid-limit");
        }
      }
      const ok = search.search({ workspaceId: WS, query: "orders", limit: 200 });
      expect(ok.hits.length).toBe(7);
    } finally {
      db.close();
    }
  });

  it("bozuk cursor reddedilir (wiki/invalid-cursor); offset sonrası → boş sayfa", () => {
    const db = new Database(path.join(tempRoot, "cursor.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      expect(() =>
        search.search({
          workspaceId: WS,
          query: "orders",
          cursor: "@@broken@@",
        }),
      ).toThrowError(WikiSearchError);
      try {
        search.search({
          workspaceId: WS,
          query: "orders",
          cursor: "@@broken@@",
        });
        expect.unreachable("bozuk cursor reddedilmeliydi");
      } catch (error) {
        expect((error as WikiSearchError).code).toBe("wiki/invalid-cursor");
      }
      const beyond = search.search({
        workspaceId: WS,
        query: "orders",
        cursor: encodeWikiSearchCursor(100),
      });
      expect(beyond.hits).toEqual([]);
      expect(beyond.nextCursor).toBeNull();
    } finally {
      db.close();
    }
  });

  it("bilinmeyen wikiSnapshotId → wiki/snapshot-not-found", () => {
    const db = new Database(path.join(tempRoot, "snapshot.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      try {
        search.search({
          workspaceId: WS,
          query: "orders",
          wikiSnapshotId: "wikisnap-missing",
        });
        expect.unreachable("snapshot çözülememeliydi");
      } catch (error) {
        expect((error as WikiSearchError).code).toBe("wiki/snapshot-not-found");
      }
    } finally {
      db.close();
    }
  });

  it("cross-workspace wikiSnapshotId çözülemez (workspace kapsamı)", () => {
    const db = new Database(path.join(tempRoot, "main.sqlite"));
    try {
      seedMainWiki(db);
      seedOtherWorkspace();
      const search = openSearchStore(db);
      try {
        search.search({
          workspaceId: WS,
          query: "orders",
          wikiSnapshotId: WIKI_ID_OTHER,
        });
        expect.unreachable("başka workspace'in snapshot'ı çözülememeliydi");
      } catch (error) {
        expect((error as WikiSearchError).code).toBe("wiki/snapshot-not-found");
      }
    } finally {
      db.close();
    }
  });

  it("boş workspaceId → wiki/invalid-field", () => {
    const db = new Database(path.join(tempRoot, "ws.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      try {
        search.search({ workspaceId: "", query: "orders" });
        expect.unreachable("boş workspaceId reddedilmeliydi");
      } catch (error) {
        expect((error as WikiSearchError).code).toBe("wiki/invalid-field");
      }
    } finally {
      db.close();
    }
  });

  it("building (yayınlanmamış) build'in içeriği aramada görünmez", () => {
    const db = new Database(path.join(tempRoot, "building.sqlite"));
    try {
      seedMainWiki(db);
      seedUnpublishedBuild(db);
      const search = openSearchStore(db);
      const result = search.search({
        workspaceId: WS,
        query: "secretbuildtoken",
      });
      expect(result.wikiSnapshotId).toBe(WIKI_ID);
      expect(result.totalMatches).toBe(0);
      expect(result.hits).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("wiki search — partial (yakınlık degrade)", () => {
  it("yakınlık ayak verisi YOK → skippedRankLegs notu + kalan ayaklarla sıralama", () => {
    const db = new Database(path.join(tempRoot, "noprox.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const result = search.search({ workspaceId: WS, query: "orders" });
      expect(result.skippedRankLegs).toEqual(["graphProximity"]);
      const alpha = result.hits.findIndex((h) => h.pageId === "p_flow_alpha");
      const beta = result.hits.findIndex((h) => h.pageId === "p_flow_beta");
      expect(alpha).toBeGreaterThan(-1);
      expect(beta).toBeGreaterThan(-1);
      expect(alpha).toBeLessThan(beta);
    } finally {
      db.close();
    }
  });

  it("yakınlık VERİLDİĞİNDE ayak devreye girer; bm25-eşit adaylar yakınlıkla sıralanır", () => {
    const db = new Database(path.join(tempRoot, "prox.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const proximity = new Map<string, number>([
        ["p_flow_beta", 1],
        ["p_flow_alpha", 9],
      ]);
      const result = search.search({
        workspaceId: WS,
        query: "orders",
        proximity,
      });
      expect(result.skippedRankLegs).toEqual([]);
      const alpha = result.hits.findIndex((h) => h.pageId === "p_flow_alpha");
      const beta = result.hits.findIndex((h) => h.pageId === "p_flow_beta");
      expect(beta).toBeLessThan(alpha);
    } finally {
      db.close();
    }
  });

  it("sayfalama: limit 2 ile tüm sonuçlar sırayla, tekrarsız gezilir; son sayfada nextCursor null", () => {
    const db = new Database(path.join(tempRoot, "page.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const full = search.search({ workspaceId: WS, query: "orders" });
      const expectedOrder = full.hits.map((h) => h.pageId);

      const collected: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = search.search({
          workspaceId: WS,
          query: "orders",
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        });
        expect(page.totalMatches).toBe(full.totalMatches);
        collected.push(...page.hits.map((h) => h.pageId));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor !== null);

      expect(collected).toEqual(expectedOrder);
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.length).toBe(full.totalMatches);
    } finally {
      db.close();
    }
  });

  it("determinizm: aynı girdi → aynı arama sonucu JSON (iki çalıştırma bit-bit eşit)", () => {
    const db = new Database(path.join(tempRoot, "determinism.sqlite"));
    try {
      seedMainWiki(db);
      const search = openSearchStore(db);
      const a = search.search({
        workspaceId: WS,
        query: "orders",
        proximity: new Map([["p_flow_beta", 2]]),
      });
      const b = search.search({
        workspaceId: WS,
        query: "orders",
        proximity: new Map([["p_flow_beta", 2]]),
      });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    } finally {
      db.close();
    }
  });
});
