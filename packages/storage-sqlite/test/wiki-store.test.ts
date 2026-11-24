import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson, type JsonValue } from "@causoryn/domain";

import {
  GraphRepositoryError,
  SqliteGraphRepository,
} from "../src/index.js";
import {
  SqliteWikiStore,
  WikiStoreError,
  type WikiPageInput,
  type WikiSnapshotMetaInput,
  type WikiSnapshotRead,
} from "../src/index.js";

/**
 * Wiki SQLite şeması test üçlüsü (TŞ v2.1 §16A.7; wiki/sprint-4.md W2).
 *
 * Pozitif: örnek WikiSnapshot yaz → oku → canonical JSON birebir eşitlik
 * (TŞ §8 invariant vi uygulanışı); FTS5 insert + MATCH; iki ayrı
 * veritabanına aynı girdi → aynı JSON (determinizm); overlay anotasyon
 * reindex'ten etkilenmez (TŞ §16A.6).
 * Negatif: FK ihlali reddi; geçersiz enum (status/freshness) reddi;
 * verified link kanıtsız reddedilir (TŞ §16A.7 kuralı); building
 * snapshot okuma yollarında görünmez.
 * Partial: kısmi snapshot (bölümleri eksik sayfa) → status=partial,
 * pages tutarlı; v1 damgalı DB wiki tablolarıyla yükselir.
 *
 * Tüm veritabanları os.tmpdir() altındadır; depoya yazılmaz (ADR-008).
 */

const WS = "ws_wiki";
const WS_ROOT = "D:/fixtures/orders";
const GRAPH_SNAPSHOT_ID = "gsnap-orders-1";
const REVISION_REF = "b1a2c3d4e5f6";
const TEMPLATE_VERSION = "tpl-wiki-1";
const CREATED_AT = "2026-11-05T09:00:00.000Z";
const BUILT_AT = "2026-11-05T09:05:00.000Z";
const WIKI_ID = "wikisnap-orders-1";
const WIKI_ID_2 = "wikisnap-orders-2";
const WS_OTHER = "ws_wiki_other";
const WIKI_ID_OTHER = "wikisnap-other-1";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-wiki-store-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function dbPath(name: string): string {
  return path.join(tempRoot, name);
}

/** Workspace kaydını graph deposu üzerinden yapar (FK hedefi). */
function registerWorkspace(p: string): void {
  const graph = new SqliteGraphRepository(p);
  try {
    graph.registerWorkspace({ id: WS, rootPath: WS_ROOT, createdAt: CREATED_AT });
  } finally {
    graph.close();
  }
}

function wikiMeta(graphSnapshotId: string): WikiSnapshotMetaInput {
  return {
    workspaceId: WS,
    graphSnapshotId,
    revisionRef: REVISION_REF,
    templateVersion: TEMPLATE_VERSION,
    createdAt: CREATED_AT,
  };
}

const REF_HANDLER = {
  evidenceId: "ev-handler-1",
  relativePath: "src/orders/create-order.ts",
  startLine: 10,
  endLine: 42,
  sourceHash: "sha256:src/orders/create-order.ts",
};

function fixturePages(): WikiPageInput[] {
  return [
    {
      id: "p_overview",
      kind: "overview",
      parentId: null,
      title: "Overview",
      slug: "overview",
      route: "/wiki/overview",
      contentHash: "sha256:page:overview",
      freshness: "fresh",
      coverage: { status: "complete" },
    },
    {
      id: "p_api",
      kind: "api",
      parentId: "p_overview",
      title: "POST /orders",
      slug: "api-post-orders",
      route: "/wiki/api/post-orders",
      contentHash: "sha256:page:api",
      freshness: "stale",
      coverage: { status: "partial", detail: "handler gövdesi çözümlenemedi" },
    },
  ];
}

/** Bir wiki build'ine standart fixture içeriğini yazar. */
function fillFixture(store: SqliteWikiStore, wikiSid: number): void {
  for (const page of fixturePages()) {
    store.addWikiPage(wikiSid, page);
  }
  store.addWikiPageSection(wikiSid, {
    id: "sec_api_intent",
    pageId: "p_api",
    sectionKey: "intent",
    generatedMarkdown: "Sipariş oluşturma endpoint'i.",
    evidenceRefs: [REF_HANDLER],
    status: "ok",
  });
  store.addWikiPageSection(wikiSid, {
    id: "sec_api_notes",
    pageId: "p_api",
    sectionKey: "notes",
    generatedMarkdown: "",
    evidenceRefs: [],
    status: "no_data",
  });
  store.addWikiLink(wikiSid, {
    id: "l_api_docs",
    fromPageId: "p_api",
    toPageId: "p_overview",
    kind: "DOCUMENTS",
    resolution: "verified",
    evidenceRefs: [REF_HANDLER],
  });
  // K-013 #4: bozuk link korunur — toPageId null.
  store.addWikiLink(wikiSid, {
    id: "l_broken_dep",
    fromPageId: "p_overview",
    toPageId: null,
    kind: "DEPENDS_ON",
    resolution: "unresolved",
    evidenceRefs: [],
  });
  store.addWikiPageVersion(wikiSid, {
    pageId: "p_api",
    revisionRef: REVISION_REF,
    contentHash: "sha256:page:api",
    linkSetHash: "sha256:links:api",
    templateVersion: TEMPLATE_VERSION,
    coverage: { status: "partial" },
  });
  store.indexWikiFts(wikiSid, [
    {
      pageId: "p_api",
      title: "POST /orders",
      qualifiedSymbol: "OrdersService.create",
      apiRoute: "POST /orders",
      module: "orders",
      tags: "orders api create",
      body: "CreateOrder handler sipariş kaydı açar.",
    },
    {
      pageId: "p_overview",
      title: "Overview",
      qualifiedSymbol: null,
      apiRoute: null,
      module: null,
      tags: "overview",
      body: "Depo genel bakış sayfası.",
    },
  ]);
}

function expectedRead(snapshotId: string, status: "ready" | "partial"): WikiSnapshotRead {
  return {
    snapshot: {
      id: snapshotId,
      workspaceId: WS,
      graphSnapshotId: GRAPH_SNAPSHOT_ID,
      revisionRef: REVISION_REF,
      status,
      builtAt: BUILT_AT,
      templateVersion: TEMPLATE_VERSION,
    },
    pages: [
      {
        id: "p_overview",
        wikiSnapshotId: snapshotId,
        kind: "overview",
        parentId: null,
        title: "Overview",
        slug: "overview",
        route: "/wiki/overview",
        contentHash: "sha256:page:overview",
        freshness: "fresh",
        coverage: { status: "complete" },
      },
      {
        id: "p_api",
        wikiSnapshotId: snapshotId,
        kind: "api",
        parentId: "p_overview",
        title: "POST /orders",
        slug: "api-post-orders",
        route: "/wiki/api/post-orders",
        contentHash: "sha256:page:api",
        freshness: "stale",
        coverage: { status: "partial", detail: "handler gövdesi çözümlenemedi" },
      },
    ],
    sections: [
      {
        id: "sec_api_intent",
        pageId: "p_api",
        sectionKey: "intent",
        generatedMarkdown: "Sipariş oluşturma endpoint'i.",
        evidenceRefs: [REF_HANDLER],
        status: "ok",
      },
      {
        id: "sec_api_notes",
        pageId: "p_api",
        sectionKey: "notes",
        generatedMarkdown: "",
        evidenceRefs: [],
        status: "no_data",
      },
    ],
    links: [
      {
        id: "l_api_docs",
        wikiSnapshotId: snapshotId,
        fromPageId: "p_api",
        toPageId: "p_overview",
        kind: "DOCUMENTS",
        resolution: "verified",
        evidenceRefs: [REF_HANDLER],
      },
      {
        id: "l_broken_dep",
        wikiSnapshotId: snapshotId,
        fromPageId: "p_overview",
        toPageId: null,
        kind: "DEPENDS_ON",
        resolution: "unresolved",
        evidenceRefs: [],
      },
    ],
    versions: [
      {
        pageId: "p_api",
        wikiSnapshotId: snapshotId,
        revisionRef: REVISION_REF,
        contentHash: "sha256:page:api",
        linkSetHash: "sha256:links:api",
        templateVersion: TEMPLATE_VERSION,
        coverage: { status: "partial" },
      },
    ],
  };
}

function canon(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

describe("wiki store — pozitif", () => {
  it("WikiSnapshot yaz → oku → canonical JSON birebir", () => {
    const p = dbPath("positive.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store, wikiSid);

      // Building satırı okuma yolunda asla çözülmez.
      expect(store.readWikiSnapshot(WIKI_ID)).toBeUndefined();

      const published = store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);
      expect(canon(published)).toBe(canon(expectedRead(WIKI_ID, "ready")));

      const reread = store.readWikiSnapshot(WIKI_ID);
      expect(reread).toBeDefined();
      expect(canon(reread)).toBe(canon(expectedRead(WIKI_ID, "ready")));
    } finally {
      store.close();
    }
  });

  it("FTS5 insert + MATCH: sayfa arama hit döner; isabet yoksa boş", () => {
    const p = dbPath("fts.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store, wikiSid);
      store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);

      const hits = store.searchWiki("CreateOrder");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.pageId).toBe("p_api");
      expect(hits[0]?.wikiSnapshotId).toBe(WIKI_ID);

      expect(store.searchWiki("yok-boyle-bir-terim")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("searchWiki workspace filtresiyle cross-workspace hit döndürmez", () => {
    const p = dbPath("fts-scope.db");
    registerWorkspace(p);
    const graph = new SqliteGraphRepository(p);
    try {
      graph.registerWorkspace({
        id: WS_OTHER,
        rootPath: "D:/fixtures/other",
        createdAt: CREATED_AT,
      });
    } finally {
      graph.close();
    }
    const store = new SqliteWikiStore(p);
    try {
      const sid1 = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store, sid1);
      store.publishWiki(sid1, WIKI_ID, "ready", BUILT_AT);

      const sid2 = store.beginWikiBuild({
        ...wikiMeta("gsnap-other-1"),
        workspaceId: WS_OTHER,
        createdAt: "2026-11-05T12:00:00.000Z",
      });
      store.addWikiPage(sid2, fixturePages()[0] as WikiPageInput);
      store.indexWikiFts(sid2, [
        { pageId: "p_overview", title: "CreateOrder kopya" },
      ]);
      store.publishWiki(sid2, WIKI_ID_OTHER, "ready", "2026-11-05T12:05:00.000Z");

      const scoped = store.searchWiki("CreateOrder", { workspaceId: WS });
      expect(scoped.map((hit) => hit.wikiSnapshotId)).toEqual([WIKI_ID]);
      const otherScoped = store.searchWiki("CreateOrder", {
        workspaceId: WS_OTHER,
      });
      expect(otherScoped.map((hit) => hit.wikiSnapshotId)).toEqual([
        WIKI_ID_OTHER,
      ]);
      // Filtresiz çağrı iki workspace'in de satırlarını görür (mevcut gevşek
      // davranış korunur; tam scoping W4/W5'te — TŞ §16A.3, K-013 #5).
      expect(store.searchWiki("CreateOrder")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("Determinizm: aynı girdi ikinci veritabanında aynı JSON'u üretir", () => {
    // Kanıt kapsamı: AYNI koşum içinde iki bağımsız DB dosyası; okuma
    // modeli DB üretilmiş alan (sid/timestamp) içermediğinden canonical
    // JSON birebir eşittir. Kelimesi kelimesine 'iki ayrı vitest koşumu'
    // karşılaştırması ayrı raporlanır (bu dosya iki kez koşulur).
    const p1 = dbPath("det-1.db");
    const p2 = dbPath("det-2.db");
    registerWorkspace(p1);
    registerWorkspace(p2);
    const store1 = new SqliteWikiStore(p1);
    const store2 = new SqliteWikiStore(p2);
    try {
      const sid1 = store1.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store1, sid1);
      const sid2 = store2.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store2, sid2);
      const read1 = store1.publishWiki(sid1, WIKI_ID, "ready", BUILT_AT);
      const read2 = store2.publishWiki(sid2, WIKI_ID, "ready", BUILT_AT);
      expect(canon(read1)).toBe(canon(read2));
    } finally {
      store1.close();
      store2.close();
    }
  });

  it("Overlay: reindex sonrası anotasyon ve alias değişmez (TŞ §16A.6)", () => {
    const p = dbPath("overlay.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const sid1 = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store, sid1);
      store.publishWiki(sid1, WIKI_ID, "ready", BUILT_AT);

      store.writeAnnotation(WS, {
        id: "an_retry",
        stablePageId: "p_api",
        sectionKey: "notes",
        authorKind: "human",
        origin: "human_note",
        verified: true,
        body: "Bu handler retry politikasını kullanır.",
        annotationVersion: 3,
        updatedAt: "2026-11-05T10:00:00.000Z",
      });
      store.writeAlias(WS, {
        pageId: "p_api",
        alias: "orders-api-eski-slug",
        source: "rename",
        candidateNewPageId: "p_api",
        matchConfidence: 0.9,
      });

      // Reindex simülasyonu: yeni wiki snapshot building → published.
      // Parent FK gereği parent sayfa (p_overview) önce yazılır.
      const sid2 = store.beginWikiBuild({
        ...wikiMeta("gsnap-orders-2"),
        createdAt: "2026-11-05T11:00:00.000Z",
      });
      store.addWikiPage(sid2, fixturePages()[0] as WikiPageInput);
      store.addWikiPage(sid2, fixturePages()[1] as WikiPageInput);
      store.publishWiki(sid2, WIKI_ID_2, "partial", "2026-11-05T11:05:00.000Z");

      const annotations = store.listAnnotations(WS);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toEqual({
        id: "an_retry",
        stablePageId: "p_api",
        sectionKey: "notes",
        authorKind: "human",
        origin: "human_note",
        verified: true,
        body: "Bu handler retry politikasını kullanır.",
        annotationVersion: 3,
        updatedAt: "2026-11-05T10:00:00.000Z",
      });

      const aliases = store.listAliases(WS);
      expect(aliases).toEqual([
        {
          pageId: "p_api",
          alias: "orders-api-eski-slug",
          source: "rename",
          candidateNewPageId: "p_api",
          matchConfidence: 0.9,
        },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("wiki store — negatif", () => {
  it("FK ihlali: bilinmeyen sayfaya section/link yazımı reddedilir", () => {
    const p = dbPath("negative-fk.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      store.addWikiPage(wikiSid, fixturePages()[0] as WikiPageInput);

      expect(
        () =>
          store.addWikiPageSection(wikiSid, {
            id: "sec_orphan",
            pageId: "p_missing",
            sectionKey: "intent",
            generatedMarkdown: "x",
            evidenceRefs: [],
            status: "ok",
          }),
      ).toThrow(WikiStoreError);
      try {
        store.addWikiPageSection(wikiSid, {
          id: "sec_orphan",
          pageId: "p_missing",
          sectionKey: "intent",
          generatedMarkdown: "x",
          evidenceRefs: [],
          status: "ok",
        });
        expect.unreachable("FK ihlali beklenmişti");
      } catch (error) {
        expect(error).toBeInstanceOf(WikiStoreError);
        expect((error as WikiStoreError).message).toContain("FOREIGN KEY");
      }

      try {
        store.addWikiLink(wikiSid, {
          id: "l_dangling",
          fromPageId: "p_missing",
          toPageId: null,
          kind: "DEPENDS_ON",
          resolution: "unresolved",
          evidenceRefs: [],
        });
        expect.unreachable("FK ihlali beklenmişti");
      } catch (error) {
        expect((error as WikiStoreError).message).toContain("FOREIGN KEY");
      }
    } finally {
      store.close();
    }
  });

  it("Geçersiz enum: freshness/status reddedilir (K-013 kümesi)", () => {
    const p = dbPath("negative-enum.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));

      expect(() =>
        store.addWikiPage(wikiSid, {
          id: "p_bad",
          kind: "api",
          parentId: null,
          title: "Bad",
          slug: "bad",
          route: "/wiki/bad",
          contentHash: "sha256:x",
          freshness: "expired" as WikiPageInput["freshness"],
          coverage: { status: "complete" },
        }),
      ).toThrow(/freshness/);

      expect(() =>
        store.publishWiki(wikiSid, WIKI_ID, "failed" as "ready", BUILT_AT),
      ).toThrow(WikiStoreError);
      // Red sonrası building satırı zarar görmeden publish edilebilir.
      const published = store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);
      expect(published.snapshot.status).toBe("ready");
    } finally {
      store.close();
    }
  });

  it("verified link kanıtsız reddedilir (TŞ §16A.7 kuralı)", () => {
    const p = dbPath("negative-verified.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      for (const page of fixturePages()) store.addWikiPage(wikiSid, page);
      expect(() =>
        store.addWikiLink(wikiSid, {
          id: "l_noevidence",
          fromPageId: "p_api",
          toPageId: "p_overview",
          kind: "DOCUMENTS",
          resolution: "verified",
          evidenceRefs: [],
        }),
      ).toThrow(/kanıt|evidence/i);
    } finally {
      store.close();
    }
  });

  it("Bilinmeyen workspace reddedilir (wiki/unknown-workspace)", () => {
    const p = dbPath("negative-ws.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      expect(() =>
        store.beginWikiBuild({ ...wikiMeta(GRAPH_SNAPSHOT_ID), workspaceId: "ws_yok" }),
      ).toThrow(WikiStoreError);
    } finally {
      store.close();
    }
  });

  it("Aynı graph snapshot için ikinci aktif build reddedilir", () => {
    const p = dbPath("negative-active-build.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      expect(() => store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID))).toThrow(
        /active wiki build/i,
      );
    } finally {
      store.close();
    }
  });

  it("FTS yazımı yalnızca aktif build'de ve tamamen doğrulanmış listede olur", () => {
    const p = dbPath("negative-fts-guard.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      fillFixture(store, wikiSid);
      store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);

      // (a) Publish edilmiş snapshot'a sonradan FTS yazımı reddedilir:
      // arama sonuçları publish sonrası sessizce değiştirilemez.
      expect(() =>
        store.indexWikiFts(wikiSid, [{ pageId: "p_api", title: "Geç yazım" }]),
      ).toThrow(WikiStoreError);

      // (b) Listedeki bozuk doc, İLK INSERT'ten önce reddedilir; hiçbir
      // satır yazılmaz (atomik doğrulama).
      const sid2 = store.beginWikiBuild({
        ...wikiMeta("gsnap-orders-2"),
        createdAt: "2026-11-05T12:00:00.000Z",
      });
      try {
        store.indexWikiFts(sid2, [
          { pageId: "p_api", title: "Geçerli doc" },
          { pageId: "p_api", title: "Bozuk doc", qualifiedSymbol: "" },
        ]);
        expect.unreachable("bozuk doc reddedilmeliydi");
      } catch (error) {
        // Ortak doğrulama yardımcıları GraphRepositoryError, wiki-özel
        // kontroller WikiStoreError fırlatır (sqlite-repository.ts deseni).
        expect(
          error instanceof WikiStoreError ||
            error instanceof GraphRepositoryError,
        ).toBe(true);
      }
      const probe = new Database(p, { readonly: true });
      try {
        const row = probe
          .prepare(
            "SELECT COUNT(*) AS count FROM wiki_fts WHERE wiki_snapshot_sid = ?",
          )
          .get(sid2) as { count: number };
        expect(row.count).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      store.close();
    }
  });
});

describe("wiki store — partial", () => {
  it("Kısmi snapshot: sections eksik sayfa olsa da pages tutarlı, status=partial", () => {
    const p = dbPath("partial.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      const pages = fixturePages();
      store.addWikiPage(wikiSid, pages[0] as WikiPageInput);
      store.addWikiPage(wikiSid, pages[1] as WikiPageInput);
      // Yalnızca p_api'ye section; p_overview'suz kalır (kısmi üretim).
      store.addWikiPageSection(wikiSid, {
        id: "sec_api_intent",
        pageId: "p_api",
        sectionKey: "intent",
        generatedMarkdown: "Kısmi içerik.",
        evidenceRefs: [REF_HANDLER],
        status: "partial",
      });
      const read = store.publishWiki(wikiSid, WIKI_ID, "partial", BUILT_AT);
      expect(read.snapshot.status).toBe("partial");
      expect(read.pages.map((page) => page.id)).toEqual(["p_overview", "p_api"]);
      expect(read.sections).toHaveLength(1);
      expect(read.sections[0]?.status).toBe("partial");
      const reread = store.readWikiSnapshot(WIKI_ID);
      expect(canon(reread)).toBe(canon(read));
    } finally {
      store.close();
    }
  });

  it("unsupported coverage değeri round-trip edilir (TŞ §16A.1)", () => {
    const p = dbPath("unsupported-coverage.db");
    registerWorkspace(p);
    const store = new SqliteWikiStore(p);
    try {
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      store.addWikiPage(wikiSid, {
        id: "p_unsupported",
        kind: "coverage",
        parentId: null,
        title: "Unresolved & Coverage",
        slug: "unresolved-coverage",
        route: "/wiki/unresolved-coverage",
        contentHash: "sha256:page:unsupported",
        freshness: "fresh",
        coverage: {
          status: "unsupported",
          detail: "adapter bu sayfa türünü desteklemiyor",
        },
      });
      const read = store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);
      expect(read.pages).toHaveLength(1);
      expect(read.pages[0]?.coverage.status).toBe("unsupported");
      expect(read.pages[0]?.coverage.detail).toBe(
        "adapter bu sayfa türünü desteklemiyor",
      );
      const reread = store.readWikiSnapshot(WIKI_ID);
      expect(canon(reread)).toBe(canon(read));
    } finally {
      store.close();
    }
  });

  it("v1 damgalı DB wiki tablolarıyla yükselir; graph tabloları bozulmaz", () => {
    const p = dbPath("migration.db");
    // v1 benzeri DB: graph workspaces tablosu + bir kayıt + user_version=1.
    const legacy = new Database(p);
    legacy.exec(
      `CREATE TABLE workspaces (
         id TEXT PRIMARY KEY,
         root_path TEXT NOT NULL,
         created_at TEXT NOT NULL
       );`,
    );
    legacy
      .prepare("INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)")
      .run(WS, WS_ROOT, CREATED_AT);
    legacy.pragma("user_version = 1");
    legacy.close();

    const store = new SqliteWikiStore(p);
    try {
      const probe = new Database(p, { readonly: true });
      try {
        const version = probe.pragma("user_version", { simple: true });
        expect(version).toBe(5);
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wiki_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        const names = tables.map((row) => row.name);
        expect(names).toContain("wiki_pages");
        expect(names).toContain("wiki_page_sections");
        expect(names).toContain("wiki_links");
        expect(names).toContain("wiki_page_versions");
        expect(names).toContain("wiki_annotations");
        expect(names).toContain("wiki_aliases");
        expect(names).toContain("wiki_fts");
        const wsRow = probe
          .prepare("SELECT id FROM workspaces WHERE id = ?")
          .get(WS) as { id: string } | undefined;
        expect(wsRow?.id).toBe(WS);
      } finally {
        probe.close();
      }

      // Yükseltilmiş DB'de wiki akışı çalışır.
      const wikiSid = store.beginWikiBuild(wikiMeta(GRAPH_SNAPSHOT_ID));
      store.addWikiPage(wikiSid, fixturePages()[0] as WikiPageInput);
      const read = store.publishWiki(wikiSid, WIKI_ID, "ready", BUILT_AT);
      expect(read.snapshot.status).toBe("ready");
    } finally {
      store.close();
    }
  });
});
