/**
 * Sayfa taksonomisi — TŞ v2.1 §16A.1 "Sayfa taksonomisi ve ağaç hiyerarşisi".
 *
 * Bir çalışma alanı için varsayılan sol navigasyon ağacı 12 kök kategori
 * taşır. Bu katalog motorun SABİT şablonudur: kategori anahtarları pageId
 * türetimine girer ve sürümler arasında kimliği korur (§16A.1: "pageId
 * hash'i canonical graph identity + sayfa türünden türetilir; slug/başlık
 * değişse bile kimlik korunur"). Kategori başlıkları TŞ ağaç çizimindeki
 * bire bir metinlerdir.
 */

import type { WikiPageKind } from "./schema.js";

export interface WikiRootCategory {
  /** Kararlı kimlik; pageId ve route türetimine girer. */
  readonly key: string;
  /** TŞ §16A.1 ağacındaki görünen başlık. */
  readonly title: string;
  /** Route segmenti (`/wiki/<slug>`); key ile aynıdır. */
  readonly slug: string;
  /** Bu kök kategori sayfasının türü (§16A.1 önerilen sayfa türleri). */
  readonly kind: WikiPageKind;
  /** TŞ §16A.1 ağaç yorumundaki amaç notu. */
  readonly description: string;
}

export const WIKI_ROOT_CATEGORIES: readonly WikiRootCategory[] = [
  {
    key: "overview",
    title: "Overview",
    slug: "overview",
    kind: "overview",
    description: "repo, diller, kapsam, bilinmeyenler",
  },
  {
    key: "architecture",
    title: "Architecture",
    slug: "architecture",
    kind: "architecture",
    description: "L0–L4 katman/modül/bileşen haritaları",
  },
  {
    key: "projects-modules",
    title: "Projects & Modules",
    slug: "projects-modules",
    kind: "project",
    description: "her modül için bileşen + bağımlılık",
  },
  {
    key: "apis-entry-points",
    title: "APIs & Entry Points",
    slug: "apis-entry-points",
    kind: "api",
    description: "endpoint, handler, OpenAPI linkleri",
  },
  {
    key: "business-flows",
    title: "Business Flows",
    slug: "business-flows",
    kind: "business_flow",
    description: "checkout/order gibi uçtan uca akışlar",
  },
  {
    key: "events-integrations",
    title: "Events & Integrations",
    slug: "events-integrations",
    kind: "event",
    description: "producer/consumer, async sözleşmeler",
  },
  {
    key: "data-schemas",
    title: "Data & Schemas",
    slug: "data-schemas",
    kind: "data",
    description: "entity, tablo, migration, ilişki",
  },
  {
    key: "contracts-policies",
    title: "Contracts & Policies",
    slug: "contracts-policies",
    kind: "contract",
    description: "mimari kurallar, drift, istisnalar",
  },
  {
    key: "tests-quality",
    title: "Tests & Quality",
    slug: "tests-quality",
    kind: "test",
    description: "ilgili testler, test planı, coverage gap",
  },
  {
    key: "architecture-timeline",
    title: "Architecture Timeline",
    slug: "architecture-timeline",
    kind: "timeline",
    description: "commit bazlı değişim / ADR referansları",
  },
  {
    key: "onboarding",
    title: "Onboarding",
    slug: "onboarding",
    kind: "onboarding",
    description: "başlangıç patikaları, kritik modüller",
  },
  {
    key: "unresolved-coverage",
    title: "Unresolved & Coverage",
    slug: "unresolved-coverage",
    kind: "coverage",
    description: "eksik parser, heuristic ve belirsizlikler",
  },
];

export const WIKI_ROOT_CATEGORY_BY_KEY: ReadonlyMap<string, WikiRootCategory> =
  new Map(WIKI_ROOT_CATEGORIES.map((category) => [category.key, category]));

/**
 * Generated Markdown şablonlarının sabit sürümü (TŞ §16A.7: "generated
 * Markdown şablonları sabit sürümlenir"). WikiSnapshot.templateVersion bu
 * sabiti taşır; şablon değişince sürüm yükseltilir ve tüm sayfa
 * contentHash'leri değişir (W6 invalidation anahtarı).
 */
export const WIKI_TEMPLATE_VERSION = "1.0.0";
