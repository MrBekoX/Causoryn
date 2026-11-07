/**
 * wiki_annotations ince bağlantı testleri — sprint-4 W7 (TŞ v2.1 §16A.6
 * "Anotasyon güncellemeleri optimistic concurrency (annotationVersion) ile
 * korunur"; §16A.7 WikiAnnotation eması; wiki/sprint-4.md W7).
 *
 * Kapsam: SqliteWikiStore'un W7 ile eklenen anotasyon yöntemleri
 * (getAnnotation / updateAnnotation CAS / deleteAnnotation). ŞEMA
 * DEĞİŞİKLİĞİ YOKTUR — wiki_annotations tablosu W2'de kuruldu
 * (wiki-schema.ts) ve bu dilim yalnızca mevcut tabloyu KULLANIR.
 *
 * Pozitif: beklenen annotationVersion ile CAS güncellemesi v+1 döner;
 * stablePageId/authorKind kimlik alanları güncellenemez (API yüzeyinde
 * yoktur) ve satırda bit-bit korunur.
 * Negatif: bayat sürüm → wiki/annotation-conflict (MCP sabit karşılığı
 * WIKI_NOTE_CONFLICT, TŞ §10.1 s.9 — pdftotext ile doğrulandı; K-008
 * örüntüsü gereği yeni uzantı kodu açılmaz); olmayan id / başka workspace
 * → wiki/annotation-not-found; silme yalnızca explicit id ile.
 * Not koruma: iki tam reindex publish'i (begin/add/publish) annotation
 * satırlarına dokunmaz — satırlar bit-bit aynıdır (TŞ §16A.10 "Kullanıcı
 * notu" kabul satırının depo düzeyi kanıtı).
 *
 * Doğrudan modül import'u (index.ts'e dokunmadan); değerler daima
 * PARAMETRE ile bağlanır, SQL metni statiktir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteGraphRepository } from "../src/sqlite-repository.js";
import { SqliteWikiStore, WikiStoreError } from "../src/wiki-store.js";

const WS = "ws_annotation_storage";
const WS_OTHER = "ws_annotation_storage_other";
const CREATED_AT = "2026-11-07T09:00:00.000Z";
const T1 = "2026-11-07T09:05:00.000Z";
const T2 = "2026-11-07T09:10:00.000Z";
const T_ANNOT = "2026-11-07T08:00:00.000Z";
const T_ANNOT_U = "2026-11-07T08:05:00.000Z";

const PAGE_ID = "page_root_overview";
const BODY_V0 = "ilk gövde";
const BODY_V1 = "güncellenmiş gövde";

/** W2 deseni: workspace kaydı graph repository üzerinden yapılır (şema kurulumuyla). */
function registerWorkspace(dbPath: string, workspaceId: string): void {
  const graph = new SqliteGraphRepository(dbPath);
  try {
    graph.registerWorkspace({
      id: workspaceId,
      rootPath: dbPath,
      createdAt: CREATED_AT,
    });
  } finally {
    graph.close();
  }
}

function withTempDb(action: (dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "wiki-annotation-storage-"));
  try {
    action(path.join(dir, "wiki.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Depodaki tüm anotasyon satırlarının bit-bit dökümü (raw read). */
function annotationsFingerprint(dbPath: string): string {
  const raw = new Database(dbPath);
  try {
    const rows = raw
      .prepare(
        `SELECT id, workspace_id, stable_page_id, section_key, author_kind,
                origin, verified, body, annotation_version, updated_at, position
         FROM wiki_annotations ORDER BY position`,
      )
      .all();
    return JSON.stringify(rows);
  } finally {
    raw.close();
  }
}

/** Tek kök sayfalık minimal wiki snapshot publish'i (reindex simülasyonu). */
function publishMinimalWiki(
  store: SqliteWikiStore,
  graphSnapshotId: string,
  builtAt: string,
): void {
  const sid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId,
    revisionRef: `rev-${graphSnapshotId}`,
    templateVersion: "tpl-test",
    createdAt: builtAt,
  });
  store.addWikiPage(sid, {
    id: PAGE_ID,
    kind: "overview",
    parentId: null,
    title: "Overview",
    slug: "overview",
    route: "/wiki/overview",
    contentHash: `hash-${graphSnapshotId}`,
    freshness: "fresh",
    coverage: { status: "complete" },
  });
  store.publishWiki(sid, `wiki-${graphSnapshotId}`, "ready", builtAt);
}

describe("SqliteWikiStore — annotation CAS ve kimlik disiplini", () => {
  it("pozitif: beklenen annotationVersion ile CAS güncellemesi v+1 döndürür; kimlik alanları sabittir", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        origin: "human_note",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });

      const updated = store.updateAnnotation(
        WS,
        { id: "annot-1", expectedAnnotationVersion: 0, body: BODY_V1 },
        T_ANNOT_U,
      );
      expect(updated.annotationVersion).toBe(1);
      expect(updated.body).toBe(BODY_V1);
      expect(updated.updatedAt).toBe(T_ANNOT_U);
      expect(updated.stablePageId).toBe(PAGE_ID);
      expect(updated.authorKind).toBe("human");
      expect(updated.sectionKey).toBe("dependencies");
      expect(updated.origin).toBe("human_note");

      expect(store.getAnnotation(WS, "annot-1")).toEqual(updated);
      // Yok sorgusu: undefined döner (hata değil — okuma sözleşmesi).
      expect(store.getAnnotation(WS, "yok")).toBeUndefined();
      store.close();
    });
  });

  it("negatif: bayat annotationVersion → wiki/annotation-conflict; satır bayat yazmayla DEĞİŞMEZ", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      store.updateAnnotation(
        WS,
        { id: "annot-1", expectedAnnotationVersion: 0, body: BODY_V1 },
        T_ANNOT_U,
      );

      let caught: unknown;
      try {
        store.updateAnnotation(
          WS,
          { id: "annot-1", expectedAnnotationVersion: 0, body: "bayat yazma" },
          T_ANNOT_U,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WikiStoreError);
      expect((caught as WikiStoreError).code).toBe("wiki/annotation-conflict");

      const row = store.getAnnotation(WS, "annot-1");
      expect(row?.annotationVersion).toBe(1);
      expect(row?.body).toBe(BODY_V1);
      expect(row?.updatedAt).toBe(T_ANNOT_U);
      store.close();
    });
  });

  it("negatif: olmayan id → wiki/annotation-not-found; başka workspace scope'u okuyamaz/silemez", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      registerWorkspace(dbPath, WS_OTHER);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      const before = annotationsFingerprint(dbPath);

      expect(store.getAnnotation(WS_OTHER, "annot-1")).toBeUndefined();

      let caughtUpdate: unknown;
      try {
        store.updateAnnotation(
          WS_OTHER,
          { id: "annot-1", expectedAnnotationVersion: 0, body: "sızma" },
          T_ANNOT_U,
        );
      } catch (error) {
        caughtUpdate = error;
      }
      expect(caughtUpdate).toBeInstanceOf(WikiStoreError);
      expect((caughtUpdate as WikiStoreError).code).toBe("wiki/annotation-not-found");

      let caughtDelete: unknown;
      try {
        store.deleteAnnotation(WS_OTHER, "annot-1");
      } catch (error) {
        caughtDelete = error;
      }
      expect(caughtDelete).toBeInstanceOf(WikiStoreError);
      expect((caughtDelete as WikiStoreError).code).toBe("wiki/annotation-not-found");

      // İzolasyon: cross-workspace yazma/silme denemeleri satırı bozmaz.
      expect(annotationsFingerprint(dbPath)).toBe(before);
      store.close();
    });
  });

  it("negatif: geçersiz expectedAnnotationVersion → wiki/invalid-field", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      let caught: unknown;
      try {
        store.updateAnnotation(
          WS,
          { id: "annot-1", expectedAnnotationVersion: -1, body: "x" },
          T_ANNOT_U,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WikiStoreError);
      expect((caught as WikiStoreError).code).toBe("wiki/invalid-field");
      store.close();
    });
  });

  it("deleteAnnotation yalnızca explicit id ile siler; tekrar silme not-found döner", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      store.writeAnnotation(WS, {
        id: "annot-2",
        stablePageId: PAGE_ID,
        sectionKey: "summary",
        authorKind: "host_model_proposal",
        origin: "host_model_proposal",
        verified: false,
        body: "öneri",
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });

      store.deleteAnnotation(WS, "annot-1");
      const remaining = store.listAnnotations(WS);
      expect(remaining.map((row) => row.id)).toEqual(["annot-2"]);

      let caught: unknown;
      try {
        store.deleteAnnotation(WS, "annot-1");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WikiStoreError);
      expect((caught as WikiStoreError).code).toBe("wiki/annotation-not-found");
      store.close();
    });
  });

  it("not koruma (depo düzeyi): iki tam reindex publish'i annotation satırlarına dokunmaz — bit-bit", () => {
    withTempDb((dbPath) => {
      registerWorkspace(dbPath, WS);
      const store = new SqliteWikiStore(dbPath);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: PAGE_ID,
        sectionKey: "dependencies",
        authorKind: "human",
        origin: "human_note",
        body: BODY_V0,
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      const before = annotationsFingerprint(dbPath);

      // REINDEX #1 ve #2: her biri yeni graph snapshot + tam publish.
      publishMinimalWiki(store, "graph-1", T1);
      expect(annotationsFingerprint(dbPath)).toBe(before);
      publishMinimalWiki(store, "graph-2", T2);
      expect(annotationsFingerprint(dbPath)).toBe(before);

      // Reindex gerçekten yeni publish üretti (boş geçiş yok).
      const latest = store.getLatestPublishedWiki(WS);
      expect(latest?.snapshot.id).toBe("wiki-graph-2");
      store.close();
    });
  });
});
