import { canonicalJson, type JsonValue } from "@causoryn/domain";
import { sha256Hex } from "@causoryn/domain";
import { utf8Encode } from "@causoryn/domain";

import type { WikiPage, WikiPageSection, WikiProjection } from "./schema.js";

/**
 * Wiki içerik karmaları — TŞ v2.1 §16A.10 incremental kabul ölçütü
 * ("bağımsız sayfa contentHash'i korunur") ve W6 incremental invalidation
 * anahtarı. Tüm karmalar paketin FIPS 180-4 sha256Hex'i + canonical JSON
 * (anahtar sıralı, beyaz boşluksuz) üzerinden üretilir; aynı içerik her
 * zaman aynı karma üretir.
 */

/**
 * Bir sayfanın bölüm içeriklerinin kanonik JSON değeri. Sayfa kimliği,
 * başlık ve route bilinçli olarak DIŞARIDA bırakılmıştır: §16A.1 uyarınca
 * slug/başlık değişse bile içerik aynıysa hash korunmalıdır.
 */
export function wikiPageContentJsonValue(
  sections: readonly WikiPageSection[],
): JsonValue {
  return sections.map((section) => ({
    sectionKey: section.sectionKey,
    generatedMarkdown: section.generatedMarkdown,
    evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
    status: section.status,
  }));
}

/** Sayfa içerik karması: bölüm içeriği (şablon sırasında) sha256(canonical). */
export function wikiPageContentHash(
  sections: readonly WikiPageSection[],
): string {
  return sha256Hex(utf8Encode(canonicalJson(wikiPageContentJsonValue(sections))));
}

/**
 * Bütün projeksiyonun kanonik JSON'u (bit-bit deterministik seri hâli).
 * Alan anahtarları canonicalJson tarafından sıralanır; dizi sırası
 * projenin kanonik düzenidir (kökler taksonomi sırasıyla, alt sayfalar
 * pageId sırasıyla).
 */
export function wikiProjectionCanonicalJson(
  projection: WikiProjection,
): string {
  return canonicalJson({
    snapshot: {
      id: projection.snapshot.id,
      workspaceId: projection.snapshot.workspaceId,
      graphSnapshotId: projection.snapshot.graphSnapshotId,
      revisionRef: projection.snapshot.revisionRef,
      status: projection.snapshot.status,
      builtAt: projection.snapshot.builtAt,
      templateVersion: projection.snapshot.templateVersion,
    },
    pages: projection.pages.map((page) => pageJsonValue(page)),
    sections: projection.sections.map((section) => sectionJsonValue(section)),
    warnings: [...projection.warnings],
  });
}

/**
 * Snapshot düzeyi içerik karması (W6: iki projeksiyonun içeriksel olarak
 * aynı olup olmadığının tek kıyas anahtarı). `builtAt` ve `id` bilinçli
 * olarak DIŞARIDA bırakılmıştır: aynı graph + aynı girdilerle iki kez
 * üretilen projeksiyon saat etiketinden bağımsız olarak aynı karmayı
 * taşır. Uyarılar içerik değil raporlama yüzeyidir; karmaya girmez.
 */
export function wikiProjectionContentHash(projection: WikiProjection): string {
  return sha256Hex(
    utf8Encode(
      canonicalJson({
        snapshot: {
          workspaceId: projection.snapshot.workspaceId,
          graphSnapshotId: projection.snapshot.graphSnapshotId,
          revisionRef: projection.snapshot.revisionRef,
          status: projection.snapshot.status,
          templateVersion: projection.snapshot.templateVersion,
        },
        pages: projection.pages.map((page) => pageJsonValue(page)),
        sections: projection.sections.map((section) =>
          sectionJsonValue(section),
        ),
      }),
    ),
  );
}

function pageJsonValue(page: WikiPage): JsonValue {
  return {
    id: page.id,
    wikiSnapshotId: page.wikiSnapshotId,
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
  };
}

function sectionJsonValue(section: WikiPageSection): JsonValue {
  return {
    id: section.id,
    pageId: section.pageId,
    sectionKey: section.sectionKey,
    generatedMarkdown: section.generatedMarkdown,
    evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
    status: section.status,
  };
}
