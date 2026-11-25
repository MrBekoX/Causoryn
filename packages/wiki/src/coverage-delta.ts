import { z } from "zod";

import { WikiProjectionError } from "./errors.js";
import {
  CoverageStatusSchema,
  type CoverageStatus,
  type WikiProjection,
} from "./schema.js";

/**
 * coverageDelta — K-013 (3): gövde {previous, current, reason?} bire bir.
 * TŞ §16A.4 wiki_diff çıktısındaki coverageDelta alanının veri gövdesidir;
 * iki projeksiyon karşılaştırılarak hesaplanır.
 */

export const CoverageDeltaSchema = z.strictObject({
  previous: CoverageStatusSchema,
  current: CoverageStatusSchema,
  reason: z.string().optional(),
});
export type CoverageDelta = z.infer<typeof CoverageDeltaSchema>;

/** Tek sayfa için kapsam geçişi kaydı. */
export interface WikiCoverageDeltaEntry {
  readonly pageId: string;
  readonly delta: CoverageDelta;
}

/**
 * Tekil coverageDelta kurucusu: değer kümelerini şemayla doğrular;
 * bilinmeyen bir durum adı (örn. K-013'ün reddettiği "error") WikiProjectionError
 * ile reddedilir.
 */
export function computeCoverageDelta(
  previous: CoverageStatus,
  current: CoverageStatus,
  reason?: string,
): CoverageDelta {
  const parsed = CoverageDeltaSchema.safeParse({
    previous,
    current,
    ...(reason === undefined ? {} : { reason }),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/invalid-coverage-delta",
      `Invalid coverageDelta: ${detail}`,
    );
  }
  return parsed.data;
}

function sectionStatusCounts(
  projection: WikiProjection,
  pageId: string,
): Map<"ok" | "partial" | "no_data", number> {
  const counts = new Map<"ok" | "partial" | "no_data", number>();
  for (const section of projection.sections) {
    if (section.pageId !== pageId) continue;
    counts.set(section.status, (counts.get(section.status) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(
  counts: Map<"ok" | "partial" | "no_data", number>,
): string {
  return (
    `ok=${counts.get("ok") ?? 0},` +
    `partial=${counts.get("partial") ?? 0},` +
    `no_data=${counts.get("no_data") ?? 0}`
  );
}

/**
 * İki projeksiyon arasındaki sayfa bazlı kapsam geçişlerini hesaplar.
 *
 * Semantik (dürüstlük kuralları):
 * - Ortak sayfalarda yalnızca coverage.status değişenler raporlanır;
 *   gerekçe, iki tarafın bölüm durum sayımlarının mekanik özetidir.
 * - Yalnızca mevcut projeksiyonda görünen sayfa: previous=no_data
 *   ("önceki veri yoktu"), gerekçe "yeni sayfa".
 * - Yalnızca önceki projeksiyonda görünen sayfa: current=no_data,
 *   gerekçe "sayfa kaldırıldı".
 * - Çıktı pageId'ye göre kanonik sıralıdır; aynı girdi → aynı çıktı.
 */
export function computeWikiCoverageDeltas(
  previous: WikiProjection,
  current: WikiProjection,
): readonly WikiCoverageDeltaEntry[] {
  const previousById = new Map(previous.pages.map((page) => [page.id, page]));
  const currentById = new Map(current.pages.map((page) => [page.id, page]));
  const allIds = new Set<string>([...previousById.keys(), ...currentById.keys()]);

  const entries: WikiCoverageDeltaEntry[] = [];
  for (const pageId of [...allIds].sort()) {
    const inPrevious = previousById.get(pageId);
    const inCurrent = currentById.get(pageId);

    if (inPrevious !== undefined && inCurrent !== undefined) {
      if (inPrevious.coverage.status === inCurrent.coverage.status) continue;
      entries.push({
        pageId,
        delta: computeCoverageDelta(
          inPrevious.coverage.status,
          inCurrent.coverage.status,
          `sections ${formatCounts(sectionStatusCounts(previous, pageId))} → ` +
            formatCounts(sectionStatusCounts(current, pageId)),
        ),
      });
      continue;
    }

    if (inCurrent !== undefined) {
      entries.push({
        pageId,
        delta: computeCoverageDelta(
          "no_data",
          inCurrent.coverage.status,
          "page not present in the previous projection (new page)",
        ),
      });
      continue;
    }

    if (inPrevious !== undefined) {
      entries.push({
        pageId,
        delta: computeCoverageDelta(
          inPrevious.coverage.status,
          "no_data",
          "page not present in the current projection (removed)",
        ),
      });
    }
  }
  return entries;
}
