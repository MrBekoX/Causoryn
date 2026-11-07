/**
 * Annotation overlay — test üçlüsü (TŞ v2.1 §16A.6 "İnsan notlarının
 * korunması ve AI metni ayrımı", §16A.10 "Kullanıcı notu" kabul satırı;
 * wiki/sprint-4.md W7; docs/wiki-spec.md §3.5; ADR-012 Generated/Overlay
 * Separation).
 *
 * Pozitif: annotation ekle → reindex (FULL ve INCREMENTAL iki senaryo) →
 * annotation satırları bit-bit aynı + sayfada görünür (generated içeriğin
 * DIŞINA eklenen overlay bloğu; TŞ §16A.10 "Art arda iki reindex, manuel
 * notları değiştirmez").
 * Negatif: eski annotationVersion ile güncelleme → wiki/annotation-conflict
 * (optimistic concurrency, TŞ §16A.6). MCP düzeyinde sabit karşılık
 * WIKI_NOTE_CONFLICT'tur: TŞ §10.1 sabit kod listesi (s.9) bu çalışmada
 * pdftotext ile doğrulandı ve listede bire bir kod VARDIR — K-008 örüntüsü
 * gereği ANNOTATION_CONFLICT adında YENİ uzantı kodu açılmaz (errors.ts'teki
 * EXPORT_NOT_ALLOWED/WIKI_PAGE_NOT_FOUND örnekteleriyle aynı disiplin).
 * Ayrıca: silme yalnızca explicit id ile; başka workspace scope'undan silme
 * denemesi notu silemez (wiki-spec §3.5: workspace/user storage ayrımı;
 * toplu/örtük silme API'si YOKTUR).
 * Partial: hedef sayfa projeksiyondan gidince annotation orphan=true
 * işaretlenir (SİLİNMEZ — satır bit-bit korunur); hedef aynı deterministic
 * pageId ile geri geldiğinde otomatik yeniden bağlanır (orphan recovery;
 * türetilmiş durum — wiki_annotations satırına yazma YAPILMAZ, çünkü şema
 * değişikliği W7 kapsamında yasaktır ve orphan tamamen
 * (stablePageId, güncel projeksiyon) fonksiyonudur).
 *
 * Determinizm: aynı girdi → aynı çıktı; motor saat okumaz (updatedAt
 * çağıranın verir); overlay görünümü leksik sıralı ve deep-frozen.
 *
 * Not: modüller src/index.ts'ten DEĞİL doğrudan dosyadan import edilir
 * (W6 dilimindeki eşzamanlı-çalışma önleminin aynısı — index.ts'e dokunma).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  sha256Hex,
  utf8Encode,
  type SnapshotGraph,
} from "@causoryn/domain";
import { SqliteWikiStore, WikiStoreError } from "@causoryn/storage-sqlite";

import { AnnotationOverlayError } from "../src/errors.js";
import {
  AnnotationOverlayEngine,
  WikiAnnotationSchema,
  buildAnnotationOverlay,
  markAnnotationOrphans,
  renderAnnotationBlock,
  renderWikiPageWithOverlay,
  type WikiAnnotation,
} from "../src/overlay.js";
import { projectWiki } from "../src/projection.js";
import { projectWikiIncremental } from "../src/incremental.js";
import type { WikiProjection } from "../src/schema.js";

/* ------------------------------------------------------------------ */
/* Fixture — orders + billing; billing gidip geri gelir (orphan)       */
/* ------------------------------------------------------------------ */

const WS = "ws_overlay";
const WS_OTHER = "ws_overlay_other";
const CREATED_AT = "2026-11-07T09:00:00.000Z";
const T1 = "2026-11-07T09:05:00.000Z";
const T2 = "2026-11-07T09:10:00.000Z";
const T3 = "2026-11-07T09:15:00.000Z";
const T_ANNOT = "2026-11-07T08:00:00.000Z";
const T_ANNOT_U = "2026-11-07T08:05:00.000Z";

function span(relativePath: string, startLine: number, endLine: number, tag: string) {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}:${tag}`,
  };
}

function buildGraph(options: {
  readonly revision: string;
  readonly includeBilling?: boolean;
  readonly billingTag?: string;
  readonly dropOrdersDependsBilling?: boolean;
}): SnapshotGraph {
  const includeBilling = options.includeBilling ?? true;
  const billingTag = options.billingTag ?? "v1";
  const nodes: Parameters<typeof createSnapshot>[0]["nodes"] = [
    { kind: "Workspace", qualifiedName: "orders-service" },
    { kind: "Project", qualifiedName: "project:orders-service" },
    {
      kind: "Module",
      qualifiedName: "module:orders",
      location: span("src/orders/index.ts", 1, 5, "v1"),
      language: "typescript",
    },
    ...(includeBilling
      ? [
          {
            kind: "Module" as const,
            qualifiedName: "module:billing",
            location: span("src/billing/index.ts", 1, 5, billingTag),
            language: "typescript" as const,
          },
        ]
      : []),
  ];
  const edges: Parameters<typeof createSnapshot>[0]["edges"] = [
    {
      kind: "CONTAINS",
      from: { kind: "Workspace", qualifiedName: "orders-service" },
      to: { kind: "Project", qualifiedName: "project:orders-service" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("package.json", 1, 10, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Workspace kökünde proje bildirimi",
        },
      ],
    },
    {
      kind: "CONTAINS",
      from: { kind: "Project", qualifiedName: "project:orders-service" },
      to: { kind: "Module", qualifiedName: "module:orders" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("src/orders/index.ts", 1, 5, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Proje dizininde orders modülü",
        },
      ],
    },
    ...(includeBilling
      ? [
          {
            kind: "CONTAINS" as const,
            from: {
              kind: "Project" as const,
              qualifiedName: "project:orders-service",
            },
            to: { kind: "Module" as const, qualifiedName: "module:billing" },
            resolution: "verified" as const,
            evidence: [
              {
                kind: "structural" as const,
                span: span("src/billing/index.ts", 1, 5, billingTag),
                analyzerId: "typescript",
                analyzerVersion: "5.9.3",
                rationale: "Proje dizininde billing modülü",
              },
            ],
          },
          ...(options.dropOrdersDependsBilling === true
            ? []
            : [
                {
                  kind: "DEPENDS_ON" as const,
                  from: { kind: "Module" as const, qualifiedName: "module:orders" },
                  to: { kind: "Module" as const, qualifiedName: "module:billing" },
                  resolution: "heuristic" as const,
                  evidence: [
                    {
                      kind: "import-graph" as const,
                      span: span("src/orders/order-service.ts", 1, 3, "v1"),
                      analyzerId: "typescript",
                      analyzerVersion: "5.9.3",
                      rationale: "orders → billing import'u",
                    },
                  ],
                },
              ]),
        ]
      : []),
  ];
  return createSnapshot({
    workspaceId: WS,
    revision: { id: options.revision, sequence: 1 },
    configHash: "cfg-overlay-001",
    analyzerFingerprint: "ts-adapter@1",
    state: "ready",
    createdAt: CREATED_AT,
    nodes,
    edges,
  });
}

const GRAPH_A = buildGraph({ revision: "rev-a" });
// Orphan sahnesi: billing modülü kaybolur (sayfa projeksiyondan gider).
const GRAPH_B_GONE = buildGraph({ revision: "rev-b", includeBilling: false });
// Recovery sahnesi: billing aynı içerikle geri gelir (pageId deterministik).
const GRAPH_C_BACK = buildGraph({ revision: "rev-c" });
// İkinci pozitif reindex senaryosu: billing'in DEPENDS_ON kenarı kalkar →
// billing sayfasının bölüm içeriği GERÇEKTEN değişir (regenerated).
const GRAPH_B_CHANGED = buildGraph({
  revision: "rev-b2",
  billingTag: "v2",
  dropOrdersDependsBilling: true,
});

const PROJECTION_A = projectWiki(GRAPH_A, { builtAt: T1 });

const BILLING_PAGE_ID = PROJECTION_A.pages.find(
  (page) => page.title === "module:billing",
)?.id;
const ORDERS_PAGE_ID = PROJECTION_A.pages.find(
  (page) => page.title === "module:orders",
)?.id;

const HUMAN_BODY = "Manuel not: billingsipariş akışındaki aylık limit kontrolünü burada belgele.";
const HOST_BODY = "Öneri: bu bölümde retry politikasının SLO etkisini anlat.";

const EMPTY_LINK_SET_HASH = sha256Hex(utf8Encode(canonicalJson([])));

/** W5/W6 publish çekirdeği ile aynı transaction disiplini (linksiz minimal). */
function publishProjection(
  store: SqliteWikiStore,
  projection: WikiProjection,
  builtAt: string,
): void {
  const sid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: projection.snapshot.graphSnapshotId,
    revisionRef: projection.snapshot.revisionRef,
    templateVersion: projection.snapshot.templateVersion,
    createdAt: builtAt,
  });
  for (const page of projection.pages) {
    store.addWikiPage(sid, {
      id: page.id,
      kind: page.kind,
      parentId: page.parentId,
      title: page.title,
      slug: page.slug,
      route: page.route,
      contentHash: page.contentHash,
      freshness: page.freshness,
      coverage:
        page.coverage.detail === undefined
          ? { status: page.coverage.status }
          : { status: page.coverage.status, detail: page.coverage.detail },
    });
  }
  for (const section of projection.sections) {
    store.addWikiPageSection(sid, {
      id: section.id,
      pageId: section.pageId,
      sectionKey: section.sectionKey,
      generatedMarkdown: section.generatedMarkdown,
      evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
      status: section.status,
    });
  }
  for (const page of projection.pages) {
    store.addWikiPageVersion(sid, {
      pageId: page.id,
      revisionRef: projection.snapshot.revisionRef,
      contentHash: page.contentHash,
      linkSetHash: EMPTY_LINK_SET_HASH,
      templateVersion: projection.snapshot.templateVersion,
      coverage: { status: page.coverage.status },
    });
  }
  const status = projection.snapshot.status;
  if (status !== "ready" && status !== "partial") {
    throw new Error(`publish edilemez projeksiyon durumu: ${status}`);
  }
  store.publishWiki(sid, projection.snapshot.id, status, builtAt);
}

function seedWorkspace(dbPath: string, workspaceId: string): void {
  const seed = new Database(dbPath);
  try {
    seed
      .prepare(
        "INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)",
      )
      .run(workspaceId, dbPath, CREATED_AT);
  } finally {
    seed.close();
  }
}

function withTempDb(action: (dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "wiki-overlay-"));
  try {
    action(path.join(dir, "wiki.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Depoda kalıcı not kopyasının bit-bit dökümü (canonical JSON, TŞ §8 vi). */
function annotationsFingerprint(store: SqliteWikiStore): string {
  return canonicalJson(
    store.listAnnotations(WS).map((row) => ({ ...row })) as unknown as never,
  );
}

function annotationErrorCode(error: unknown): string {
  expect(error).toBeInstanceOf(AnnotationOverlayError);
  return (error as AnnotationOverlayError).code;
}

/* ------------------------------------------------------------------ */
/* Şema — K-013/wiki-spec §3.5 değer kümeleri                          */
/* ------------------------------------------------------------------ */

describe("WikiAnnotation şeması", () => {
  it("pozitif: human notu ve kabul edilmiş host_model_proposal (verified=false) şemadan geçer", () => {
    const human = WikiAnnotationSchema.safeParse({
      id: "annot-1",
      stablePageId: "page-1",
      sectionKey: "dependencies",
      authorKind: "human",
      origin: "human_note",
      body: "not",
      annotationVersion: 0,
      updatedAt: T_ANNOT,
    });
    expect(human.success).toBe(true);

    const host = WikiAnnotationSchema.safeParse({
      id: "annot-2",
      stablePageId: "page-1",
      sectionKey: "summary",
      authorKind: "host_model_proposal",
      origin: "host_model_proposal",
      verified: false,
      body: "öneri",
      annotationVersion: 0,
      updatedAt: T_ANNOT,
    });
    expect(host.success).toBe(true);
  });

  it("negatif: küme dışı authorKind/origin, host önerisinde verified=true, çapraz eşleşme ve boş gövde reddedilir", () => {
    const base = {
      id: "annot-1",
      stablePageId: "page-1",
      sectionKey: "dependencies",
      body: "not",
      annotationVersion: 0,
      updatedAt: T_ANNOT,
    };
    // author türleri K-013/wiki-spec: human | host_model_proposal.
    expect(
      WikiAnnotationSchema.safeParse({ ...base, authorKind: "ai_agent" }).success,
    ).toBe(false);
    // wiki-spec §3.5 origin kümesi: human_note | external_link | host_model_proposal.
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "human",
        origin: "user",
      }).success,
    ).toBe(false);
    // TŞ §16A.6: host_model_proposal için verified=false KALIR.
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "host_model_proposal",
        origin: "host_model_proposal",
        verified: true,
      }).success,
    ).toBe(false);
    // Çapraz eşleşme: host origin yalnızca host authorKind ile bileşebilir.
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "human",
        origin: "host_model_proposal",
      }).success,
    ).toBe(false);
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "host_model_proposal",
        origin: "human_note",
      }).success,
    ).toBe(false);
    // Boş/beyaz boşluk gövde anotasyonu yoktur.
    expect(
      WikiAnnotationSchema.safeParse({ ...base, authorKind: "human", body: "   " })
        .success,
    ).toBe(false);
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "human",
        annotationVersion: -1,
      }).success,
    ).toBe(false);
    expect(
      WikiAnnotationSchema.safeParse({
        ...base,
        authorKind: "human",
        updatedAt: "2026-11-07 08:00",
      }).success,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Optimistic concurrency — annotationVersion (TŞ §16A.6)              */
/* ------------------------------------------------------------------ */

describe("AnnotationOverlayEngine — optimistic concurrency", () => {
  it("pozitif: create v0 → beklenen sürümle güncelleme v1 → okunan satır aynı ve frozen", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);

      const created = engine.addAnnotation(
        WS,
        {
          id: "annot-1",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          origin: "human_note",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );
      expect(created.annotationVersion).toBe(0);
      expect(created.updatedAt).toBe(T_ANNOT);
      expect(Object.isFrozen(created)).toBe(true);

      const updated = engine.updateAnnotation(
        WS,
        {
          id: "annot-1",
          expectedAnnotationVersion: 0,
          body: "güncellenmiş gövde",
        },
        T_ANNOT_U,
      );
      expect(updated.annotationVersion).toBe(1);
      expect(updated.body).toBe("güncellenmiş gövde");
      expect(updated.updatedAt).toBe(T_ANNOT_U);
      // Patch edilmeyen alanlar değişmez (kimlik + sınıflandırma sabittir).
      expect(updated.stablePageId).toBe(BILLING_PAGE_ID);
      expect(updated.sectionKey).toBe("dependencies");
      expect(updated.authorKind).toBe("human");
      expect(Object.isFrozen(updated)).toBe(true);

      const readBack = engine.getAnnotation(WS, "annot-1");
      expect(readBack).toEqual(updated);
      store.close();
    });
  });

  it("negatif: eski annotationVersion ile güncelleme → wiki/annotation-conflict; satır değişmez", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      engine.addAnnotation(
        WS,
        {
          id: "annot-1",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: "v0 gövde",
        },
        T_ANNOT,
      );
      // Eşzamanlı yazıcı 0 → 1 ilerletmiş olsun.
      engine.updateAnnotation(
        WS,
        { id: "annot-1", expectedAnnotationVersion: 0, body: "v1 gövde" },
        T_ANNOT_U,
      );

      // Bayat beklenti (0) ile gelen ikinci yazıcı çakışma alır:
      // sabit overlay kodu wiki/annotation-conflict; MCP sabit karşılığı
      // WIKI_NOTE_CONFLICT'tur (TŞ §10.1 s.9 — yeni uzantı kodu açılmaz,
      // K-008 örüntüsü: "TŞ listesinde uygun kod yok" önkoşulu sağlanmaz).
      let caught: unknown;
      try {
        engine.updateAnnotation(
          WS,
          { id: "annot-1", expectedAnnotationVersion: 0, body: "bayat yazma" },
          T_ANNOT_U,
        );
      } catch (error) {
        caught = error;
      }
      expect(annotationErrorCode(caught)).toBe("wiki/annotation-conflict");

      // Çakışan yazma satırı DEĞİŞTİRMEDİ: güncel içerik korunur.
      const row = engine.getAnnotation(WS, "annot-1");
      expect(row?.annotationVersion).toBe(1);
      expect(row?.body).toBe("v1 gövde");
      store.close();
    });
  });

  it("negatif: olmayan id ile update/delete → wiki/annotation-not-found; duplicate id → wiki/duplicate-annotation", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);

      let caughtUpdate: unknown;
      try {
        engine.updateAnnotation(
          WS,
          { id: "yok", expectedAnnotationVersion: 0, body: "x" },
          T_ANNOT_U,
        );
      } catch (error) {
        caughtUpdate = error;
      }
      expect(annotationErrorCode(caughtUpdate)).toBe("wiki/annotation-not-found");

      let caughtDelete: unknown;
      try {
        engine.deleteAnnotation(WS, "yok");
      } catch (error) {
        caughtDelete = error;
      }
      expect(annotationErrorCode(caughtDelete)).toBe("wiki/annotation-not-found");

      engine.addAnnotation(
        WS,
        {
          id: "annot-1",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: "ilk",
        },
        T_ANNOT,
      );
      let caughtDuplicate: unknown;
      try {
        engine.addAnnotation(
          WS,
          {
            id: "annot-1",
            stablePageId: BILLING_PAGE_ID!,
            sectionKey: "dependencies",
            authorKind: "human",
            body: "ikinci",
          },
          T_ANNOT,
        );
      } catch (error) {
        caughtDuplicate = error;
      }
      expect(annotationErrorCode(caughtDuplicate)).toBe("wiki/duplicate-annotation");
      store.close();
    });
  });

  it("negatif: merge sonrası invariant bozulursa yazma REDDEDİLİR (wiki/annotation-invalid)", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      engine.addAnnotation(
        WS,
        {
          id: "annot-human",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          origin: "human_note",
          body: "not",
        },
        T_ANNOT,
      );
      engine.addAnnotation(
        WS,
        {
          id: "annot-host",
          stablePageId: ORDERS_PAGE_ID!,
          sectionKey: "summary",
          authorKind: "host_model_proposal",
          origin: "host_model_proposal",
          verified: false,
          body: HOST_BODY,
        },
        T_ANNOT,
      );

      // İnsan notu sonradan host önerisine çevrilemez (authorKind sabittir;
      // origin çapraz eşleşme invarantı merge sonrası da geçerlidir).
      let caughtOrigin: unknown;
      try {
        engine.updateAnnotation(
          WS,
          {
            id: "annot-human",
            expectedAnnotationVersion: 0,
            origin: "host_model_proposal",
          },
          T_ANNOT_U,
        );
      } catch (error) {
        caughtOrigin = error;
      }
      expect(annotationErrorCode(caughtOrigin)).toBe("wiki/annotation-invalid");

      // Host önerisi asla verified=true olamaz (TŞ §16A.6).
      let caughtVerified: unknown;
      try {
        engine.updateAnnotation(
          WS,
          {
            id: "annot-host",
            expectedAnnotationVersion: 0,
            verified: true,
          },
          T_ANNOT_U,
        );
      } catch (error) {
        caughtVerified = error;
      }
      expect(annotationErrorCode(caughtVerified)).toBe("wiki/annotation-invalid");
      store.close();
    });
  });

  it("negatif: silme yalnızca explicit id ile; başka workspace scope'u notu silemez (izolasyon)", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      seedWorkspace(dbPath, WS_OTHER);
      const engine = new AnnotationOverlayEngine(store);
      engine.addAnnotation(
        WS,
        {
          id: "annot-1",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );
      const before = annotationsFingerprint(store);

      // Başka workspace (başka kullanıcı kapsamı) üzerinden silme denemesi:
      // not görünmez → not-found; not bozulmaz (bit-bit aynı kalır).
      let caught: unknown;
      try {
        engine.deleteAnnotation(WS_OTHER, "annot-1");
      } catch (error) {
        caught = error;
      }
      expect(annotationErrorCode(caught)).toBe("wiki/annotation-not-found");
      expect(annotationsFingerprint(store)).toBe(before);

      // Aynı workspace'te explicit id ile silme çalışır; ikinci deneme
      // not-found verir (idempotent değildir — dürüst hata).
      engine.deleteAnnotation(WS, "annot-1");
      expect(engine.listAnnotations(WS)).toHaveLength(0);
      let caughtAgain: unknown;
      try {
        engine.deleteAnnotation(WS, "annot-1");
      } catch (error) {
        caughtAgain = error;
      }
      expect(annotationErrorCode(caughtAgain)).toBe("wiki/annotation-not-found");
      store.close();
    });
  });

  it("negatif: depodan şema dışı satır sessizce üretilmez (wiki/annotation-invalid-row)", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      const raw = new Database(dbPath);
      try {
        raw
          .prepare(
            `INSERT INTO wiki_annotations
               (id, workspace_id, stable_page_id, section_key, author_kind,
                origin, verified, body, annotation_version, updated_at, position)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_annotations))`,
          )
          .run(
            "annot-raw",
            WS,
            BILLING_PAGE_ID!,
            "dependencies",
            "robot", // şema dışı authorKind — değerler PARAMETRE ile bağlanır
            null,
            null,
            "bozuk satır",
            0,
            T_ANNOT,
          );
      } finally {
        raw.close();
      }

      let caughtGet: unknown;
      try {
        engine.getAnnotation(WS, "annot-raw");
      } catch (error) {
        caughtGet = error;
      }
      expect(annotationErrorCode(caughtGet)).toBe("wiki/annotation-invalid-row");

      let caughtList: unknown;
      try {
        engine.listWithOverlayStatus(
          WS,
          PROJECTION_A.pages.map((page) => page.id),
        );
      } catch (error) {
        caughtList = error;
      }
      expect(annotationErrorCode(caughtList)).toBe("wiki/annotation-invalid-row");
      store.close();
    });
  });
});

/* ------------------------------------------------------------------ */
/* Orphan — türetilmiş işaretleme + otomatik yeniden bağlanma          */
/* ------------------------------------------------------------------ */

describe("Orphan işaretleme ve recovery", () => {
  it("partial: hedef sayfa projeksiyondan gidince orphan=true işaretlenir; satır SİLİNMEZ, bit-bit korunur", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      publishProjection(store, PROJECTION_A, T1);
      engine.addAnnotation(
        WS,
        {
          id: "annot-billing",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );
      const before = annotationsFingerprint(store);

      // Reindex: billing modülü kayboldu → sayfa projeksiyonda YOK.
      const projectionGone = projectWiki(GRAPH_B_GONE, { builtAt: T2 });
      expect(
        projectionGone.pages.some((page) => page.id === BILLING_PAGE_ID),
      ).toBe(false);

      const views = engine.listWithOverlayStatus(
        WS,
        projectionGone.pages.map((page) => page.id),
      );
      expect(views).toHaveLength(1);
      expect(views[0]?.id).toBe("annot-billing");
      expect(views[0]?.orphan).toBe(true);

      // Silinme/üzerine yazma YOKTUR: depodaki satır bit-bit aynı.
      expect(annotationsFingerprint(store)).toBe(before);
      store.close();
    });
  });

  it("partial→pozitif: hedef aynı deterministic pageId ile geri gelince orphan=false (otomatik yeniden bağlanma); satır hâlâ bit-bit", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      publishProjection(store, PROJECTION_A, T1);
      engine.addAnnotation(
        WS,
        {
          id: "annot-billing",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );

      const projectionGone = projectWiki(GRAPH_B_GONE, { builtAt: T2 });
      const goneViews = engine.listWithOverlayStatus(
        WS,
        projectionGone.pages.map((page) => page.id),
      );
      expect(goneViews[0]?.orphan).toBe(true);

      // Recovery reindex: billing geri geldi; pageId canonical graph
      // identity'den türediği için BİT-BİT AYNI döner.
      const projectionBack = projectWiki(GRAPH_C_BACK, { builtAt: T3 });
      const backPageId = projectionBack.pages.find(
        (page) => page.title === "module:billing",
      )?.id;
      expect(backPageId).toBe(BILLING_PAGE_ID);

      const backViews = engine.listWithOverlayStatus(
        WS,
        projectionBack.pages.map((page) => page.id),
      );
      expect(backViews).toHaveLength(1);
      expect(backViews[0]?.orphan).toBe(false);
      expect(backViews[0]?.stablePageId).toBe(BILLING_PAGE_ID);
      expect(backViews[0]?.annotationVersion).toBe(0);
      expect(backViews[0]?.body).toBe(HUMAN_BODY);
      store.close();
    });
  });

  it("markAnnotationOrphans saf fonksiyon: sayfa kümesinden türetilir, sıralama deterministiktir", () => {
    const annotations: WikiAnnotation[] = [
      {
        id: "b",
        stablePageId: "page-2",
        sectionKey: "summary",
        authorKind: "human",
        body: "x",
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      },
      {
        id: "a",
        stablePageId: "page-1",
        sectionKey: "dependencies",
        authorKind: "human",
        body: "y",
        annotationVersion: 3,
        updatedAt: T_ANNOT,
      },
    ];
    const views = markAnnotationOrphans(["page-1"], annotations);
    expect(views.map((view) => `${view.stablePageId}/${view.id}`)).toEqual([
      "page-1/a",
      "page-2/b",
    ]);
    expect(views[0]?.orphan).toBe(false);
    expect(views[1]?.orphan).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* TŞ §16A.10 kapısı — iki reindex senaryosu, bit-bit eşitlik          */
/* ------------------------------------------------------------------ */

describe("Reindex not koruma — iki senaryo (bit-bit)", () => {
  it("pozitif (FULL): annotation ekle → tam yeniden build reindex → notlar bit-bit aynı + sayfada görünür", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      publishProjection(store, PROJECTION_A, T1);
      engine.addAnnotation(
        WS,
        {
          id: "annot-human",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          origin: "human_note",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );
      engine.addAnnotation(
        WS,
        {
          id: "annot-host",
          stablePageId: ORDERS_PAGE_ID!,
          sectionKey: "summary",
          authorKind: "host_model_proposal",
          origin: "host_model_proposal",
          verified: false,
          body: HOST_BODY,
        },
        T_ANNOT,
      );
      const before = annotationsFingerprint(store);

      // REINDEX #1: FULL tam yeniden build (projectWiki) + publish.
      const reindexed = projectWiki(GRAPH_C_BACK, { builtAt: T3 });
      expect(reindexed.snapshot.id).not.toBe(PROJECTION_A.snapshot.id);
      publishProjection(store, reindexed, T3);

      // Notlar bit-bit aynı: body/version/updatedAt dahil hiçbir alan
      // değişmemiştir (reindex yalnızca generated içeriği yeniler).
      expect(annotationsFingerprint(store)).toBe(before);
      const rows = engine.listAnnotations(WS);
      expect(rows.map((row) => row.annotationVersion)).toEqual([0, 0]);

      // Sayfada görünür: overlay raporu her iki notu kendi sayfasına
      // bağlar (orphan=false) ve generated DIŞI blokları üretir.
      const report = buildAnnotationOverlay(reindexed.pages, rows);
      expect(report.orphaned).toHaveLength(0);
      const billingOverlay = report.pages.find(
        (entry) => entry.pageId === BILLING_PAGE_ID,
      );
      const ordersOverlay = report.pages.find(
        (entry) => entry.pageId === ORDERS_PAGE_ID,
      );
      expect(billingOverlay?.attached.map((view) => view.id)).toEqual([
        "annot-human",
      ]);
      expect(billingOverlay?.renderedMarkdown).toContain(HUMAN_BODY);
      expect(ordersOverlay?.attached.map((view) => view.id)).toEqual([
        "annot-host",
      ]);
      // AI metni ayrımı (TŞ §16A.6): host bloğu AI önerisi etiketi taşır ve
      // verified=false açıkça görünür.
      expect(ordersOverlay?.renderedMarkdown).toContain("host_model_proposal");
      expect(ordersOverlay?.renderedMarkdown).toContain("verified=false");
      expect(ordersOverlay?.renderedMarkdown).toContain(HOST_BODY);
      expect(ordersOverlay?.renderedMarkdown).not.toContain("Overlay notu");

      // Sayfa kompozisyonu: overlay, generated içeriğin DIŞINA eklenir.
      const generated = reindexed.sections
        .filter((section) => section.pageId === BILLING_PAGE_ID)
        .map((section) => section.generatedMarkdown)
        .join("\n\n");
      const composed = renderWikiPageWithOverlay(
        generated,
        billingOverlay?.renderedMarkdown ?? "",
      );
      expect(composed.startsWith(generated)).toBe(true);
      expect(composed).toContain(HUMAN_BODY);
      store.close();
    });
  });

  it("pozitif (INCREMENTAL): annotation ekle → incremental reindex → notlar bit-bit aynı + yenilenen sayfada görünür", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      const engine = new AnnotationOverlayEngine(store);
      publishProjection(store, PROJECTION_A, T1);
      engine.addAnnotation(
        WS,
        {
          id: "annot-billing",
          stablePageId: BILLING_PAGE_ID!,
          sectionKey: "dependencies",
          authorKind: "human",
          body: HUMAN_BODY,
        },
        T_ANNOT,
      );
      const before = annotationsFingerprint(store);

      // REINDEX: billing bölüm içeriği değişti (DEPENDS_ON kalktı) →
      // incremental yol (§16A.5 md.4).
      const step = projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: GRAPH_B_CHANGED,
        builtAt: T2,
      });
      expect(step.report.mode).toBe("incremental");
      expect(step.report.regeneratedPageIds).toContain(BILLING_PAGE_ID);
      publishProjection(store, step.projection, T2);

      // Notlar bit-bit aynı (depo satırı reindex'ten etkilenmez).
      expect(annotationsFingerprint(store)).toBe(before);

      // Yenilenen sayfada görünür: pageId deterministik korundu, not bağlı.
      const report = buildAnnotationOverlay(
        step.projection.pages,
        engine.listAnnotations(WS),
      );
      const billingOverlay = report.pages.find(
        (entry) => entry.pageId === BILLING_PAGE_ID,
      );
      expect(billingOverlay?.attached).toHaveLength(1);
      expect(billingOverlay?.attached[0]?.orphan).toBe(false);
      expect(billingOverlay?.renderedMarkdown).toContain(HUMAN_BODY);
      store.close();
    });
  });
});

/* ------------------------------------------------------------------ */
/* Render — determinizm ve AI metni ayrımı (TŞ §16A.6)                 */
/* ------------------------------------------------------------------ */

describe("renderAnnotationBlock", () => {
  const human: WikiAnnotation = {
    id: "annot-human-1",
    stablePageId: "page-1",
    sectionKey: "dependencies",
    authorKind: "human",
    origin: "human_note",
    body: "İlk satır\nİkinci satır",
    annotationVersion: 2,
    updatedAt: T_ANNOT,
  };
  const host: WikiAnnotation = {
    id: "annot-host-1",
    stablePageId: "page-1",
    sectionKey: "summary",
    authorKind: "host_model_proposal",
    origin: "host_model_proposal",
    verified: false,
    body: "Model önerisi gövdesi",
    annotationVersion: 0,
    updatedAt: T_ANNOT,
  };

  it("human bloğu golden dizeyle bit-bit eşittir (determinizm pini)", () => {
    expect(renderAnnotationBlock(human)).toBe(
      [
        "> **[Overlay notu — human]** sectionKey:`dependencies` · annotationId:`annot-human-1` · annotationVersion=2 · origin=human_note",
        ">",
        "> İlk satır",
        "> İkinci satır",
      ].join("\n"),
    );
  });

  it("host bloğu AI önerisi etiketi taşır, verified=false açıkça yazılır ve insan bloğundan ayrışır", () => {
    const hostBlock = renderAnnotationBlock(host);
    expect(hostBlock).toBe(
      [
        "> **[AI ÖNERİSİ — host_model_proposal, verified=false]** sectionKey:`summary` · annotationId:`annot-host-1` · annotationVersion=0 · origin=host_model_proposal",
        ">",
        "> Model önerisi gövdesi",
      ].join("\n"),
    );
    expect(hostBlock).not.toBe(renderAnnotationBlock(human));
    // Determinizm: aynı girdi → aynı çıktı.
    expect(renderAnnotationBlock(host)).toBe(renderAnnotationBlock(host));
  });

  it("renderWikiPageWithOverlay: overlay generated içeriğin DIŞINA eklenir; boş overlay dokumaz", () => {
    expect(renderWikiPageWithOverlay("üretilmiş içerik", "")).toBe(
      "üretilmiş içerik",
    );
    const composed = renderWikiPageWithOverlay(
      "üretilmiş içerik",
      "> **[Overlay notu — human]** blok",
    );
    expect(composed).toBe("üretilmiş içerik\n\n> **[Overlay notu — human]** blok");
  });
});

/* ------------------------------------------------------------------ */
/* Storage ince bağlantısı — depo düzeyi sözleşme (yardımcı kanıt)     */
/* ------------------------------------------------------------------ */

describe("SqliteWikiStore annotation ince bağlantısı", () => {
  it("WikiStoreError wiki/annotation-conflict kodu overlay'e aynen taşınır", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      seedWorkspace(dbPath, WS);
      store.writeAnnotation(WS, {
        id: "annot-1",
        stablePageId: BILLING_PAGE_ID!,
        sectionKey: "dependencies",
        authorKind: "human",
        body: "v0",
        annotationVersion: 0,
        updatedAt: T_ANNOT,
      });
      let caught: unknown;
      try {
        store.updateAnnotation(
          WS,
          { id: "annot-1", expectedAnnotationVersion: 5, body: "bayat" },
          T_ANNOT_U,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WikiStoreError);
      expect((caught as WikiStoreError).code).toBe("wiki/annotation-conflict");
      store.close();
    });
  });
});
