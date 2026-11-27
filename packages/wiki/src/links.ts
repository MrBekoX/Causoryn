import { z } from "zod";

import { WikiProjectionError } from "./errors.js";
import { EvidenceRefSchema, WikiResolutionSchema } from "./schema.js";

/**
 * Wiki link modülü — TŞ v2.1 §16A.2 "Çift yönlü bağlantılar ve kanıtlar"
 * ve §16A.7 WikiLink varlığı; docs/wiki-spec.md §3.3/§3.6; K-013 karar #4;
 * sprint-4 W3.
 *
 * TŞ sözleşmesi (§16A.2, PDF s.16):
 * - WikiLink türleri: PARENT_OF, DOCUMENTS, DEPENDS_ON, CALLS, IMPLEMENTS,
 *   PRODUCES, CONSUMES, TESTED_BY, FLOWS_TO, RELATED_CONTRACT, CHANGED_IN.
 * - "Bir yöndeki bağlantıdan backlink ters indeks üzerinden otomatik
 *   türetilir; iki bağımsız link kaydı yazılmaz" (ADR-013): forward +
 *   backlink TEK kayıttan türetilir; backlink sorgusu O(1) ters eşlemedir.
 * - "Bir bağlantı hedefi silinirse hedef sessizce kaybolmaz; ... broken-link
 *   diagnostics üretilir." K-013 #4: bozuk link WikiLink'te toPageId=null
 *   ile KORUNUR ve ayrıca brokenLinkDiagnostics kaydı üretilir.
 * - §16A.7: "Her verified Wiki linki en az bir Evidence kaydına bağlanmalıdır"
 *   (şema düzeyinde zorlanır; storage-sqlite wiki-store.ts:751 ile aynı kural).
 * - §16A.1: "Rename/relocation kesin çözülemiyorsa wiki_aliases ile
 *   candidate_redirect işaretlenir; yanlış eşleşme sessizce yapılmaz" —
 *   alias metni/redirect hedef çözümlemede devrededir; belirsiz redirect
 *   (matchConfidence < 1) üzerinden çözümlenen verified link "heuristic"
 *   e düşürülür (§16A.10 Belirsizlik: doğrulanmış link taklidi yapılmaz).
 *
 * Katman ayrımı: BU MODÜL SAF ÇEKİRDEKTİR — yalnızca zod + kardeş wiki
 * modüllerine bağlıdır; storage tipi import etmez. Girdi kataloğu/alias
 * kayıtları düz veri olarak alınır (SqliteWikiStore.readWikiSnapshot.pages
 * + listAliases çıktısıyla aynı şekiller); çıktı WikiLink kayıtları
 * storage-sqlite WikiLinkInput sözleşmesiyle birebir uyumlu olduğundan
 * kalıcı katman doğrudan yazabilir. Kalıcılık bu pakette DEĞİLDİR.
 *
 * Determinizm: çıktı sıralaması kanoniktir (link kimliği; alias girdileri
 * çözümlemeden önce kanonik sıraya alınır); aynı girdi → bit-bit aynı
 * çıktı; tüm çıktılar deep-frozen; motor saat okumaz, ağ erişmez.
 */

/** TŞ §16A.2 WikiLink tür kümesi (11 değer). */
export const WikiLinkKindSchema = z.enum([
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
]);
export type WikiLinkKind = z.infer<typeof WikiLinkKindSchema>;

/** wiki-spec §3.3 WikiLink — K-013 #4 ile toPageId nullable. */
export const WikiLinkSchema = z
  .strictObject({
    id: z.string(),
    wikiSnapshotId: z.string(),
    fromPageId: z.string(),
    /** K-013 #4: hedef çözümlenemeyen link toPageId=null ile korunur. */
    toPageId: z.string().nullable(),
    kind: WikiLinkKindSchema,
    resolution: WikiResolutionSchema,
    /** TŞ §16A.7: verified link ≥1 Evidence (superRefine ile zorlanır). */
    evidenceRefs: z.array(EvidenceRefSchema),
  })
  .superRefine((link, ctx) => {
    if (link.resolution === "verified" && link.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `A verified wiki link requires at least one Evidence: ${link.id}`,
        path: ["evidenceRefs"],
      });
    }
  });
export type WikiLink = z.infer<typeof WikiLinkSchema>;

/**
 * Çözümleme öncesi link taslağı: hedef, "yazıldığı gibi" ham referanstır
 * (toRef = pageId | slug | alias metni). Çözümleme sırası: (1) sayfa
 * kimliği, (2) slug, (3) alias metni, (4) eski sayfa kimliği redirect'i.
 */
export const WikiLinkDraftSchema = z
  .strictObject({
    id: z.string(),
    fromPageId: z.string(),
    toRef: z.string(),
    kind: WikiLinkKindSchema,
    resolution: WikiResolutionSchema,
    evidenceRefs: z.array(EvidenceRefSchema),
  })
  .superRefine((draft, ctx) => {
    if (draft.id.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "link id must not be empty",
        path: ["id"],
      });
    }
    if (draft.fromPageId.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "link fromPageId must not be empty",
        path: ["fromPageId"],
      });
    }
    if (draft.toRef.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "link toRef must not be empty",
        path: ["toRef"],
      });
    }
    if (draft.resolution === "verified" && draft.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `A verified link draft requires at least one Evidence: ${draft.id}`,
        path: ["evidenceRefs"],
      });
    }
  });
export type WikiLinkDraft = z.infer<typeof WikiLinkDraftSchema>;

/**
 * K-013 #4 broken-link diagnostics kaydı. `toRef`: ham hedef adı —
 * çözümleme anında BİLİNİR; kalıcı WikiLink satırından (to_page_id null)
 * türetilirken ham ad kalıcı modelde taşınmadığından dürüstçe null'dur
 * (uydurulmaz). `reason` kaynak sayfayı ve hedef adını metin taşır
 * (sprint-4 W3 emri: "hangi kaynak sayfa, hangi hedef adı").
 */
export const BrokenLinkDiagnosticSchema = z.strictObject({
  linkId: z.string(),
  fromPageId: z.string(),
  toRef: z.string().nullable(),
  kind: WikiLinkKindSchema,
  reason: z.string(),
});
export type BrokenLinkDiagnostic = z.infer<typeof BrokenLinkDiagnosticSchema>;

/** Hedef kataloğu girdisi: çözümlenebilir sayfalar (id + slug + route). */
export interface WikiPageTarget {
  readonly id: string;
  readonly slug: string;
  readonly route: string;
}

/**
 * Alias girdisi — storage-sqlite wiki_aliases okuma modeliyle birebir
 * (bkz. wiki-schema.ts alan eşlemesi): `pageId` ↔ TŞ oldPageId (alias'ın
 * sahibi eski/kanonik sayfa), `alias` ↔ eski slug/başlık metni,
 * `candidateNewPageId` ↔ redirect hedefi (null/eksik = candidate_redirect
 * çözülememiş; metin sahibi sayfaya çözümlenir), `matchConfidence` ↔ 0..1.
 */
export interface WikiAliasEntry {
  readonly pageId: string;
  readonly alias: string;
  readonly candidateNewPageId?: string | null;
  readonly matchConfidence?: number;
  readonly source?: string;
}

/** resolveWikiLinks girdisi. */
export interface WikiLinkResolutionInput {
  /** Çözümlenen linklere damgalanacak wiki snapshot kimliği. */
  readonly wikiSnapshotId: string;
  readonly pages: readonly WikiPageTarget[];
  readonly aliases?: readonly WikiAliasEntry[];
}

/** resolveWikiLinks çıktısı: çözümlenen linkler + broken diagnostics. */
export interface WikiLinkResolution {
  /** Kanonik sıra: link kimliği artan. Deep-frozen. */
  readonly links: readonly WikiLink[];
  /** Kanonik sıra: link kimliği artan. Deep-frozen. */
  readonly brokenLinkDiagnostics: readonly BrokenLinkDiagnostic[];
  /** Sayfa başına broken link sayacı (fromPageId anahtarlı). */
  readonly brokenCountByPage: ReadonlyMap<string, number>;
}

/** O(1) çift yönlü link indeksi (backlink ters eşleme; ADR-013). */
export interface WikiLinkIndex {
  /** pageId → giden linkler (kanonik sıra; O(1) Map okuması). */
  forwardLinks(pageId: string): readonly WikiLink[];
  /** pageId → ona işaret eden linkler (kanonik sıra; O(1) ters eşleme). */
  backlinks(pageId: string): readonly WikiLink[];
  /**
   * toPageId=null linklerden türetilen diagnostics (kanonik sıra).
   * Kalıcı satırdan türetildiği için toRef=null'dur (ham ad taşınmaz).
   */
  brokenLinkDiagnostics(): readonly BrokenLinkDiagnostic[];
  /** Sayfa başına broken link sayacı (fromPageId anahtarlı). */
  brokenLinkCountByPage(pageId: string): number;
  readonly totalLinkCount: number;
  readonly resolvedLinkCount: number;
  readonly brokenLinkCount: number;
}

function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parseDrafts(drafts: readonly WikiLinkDraft[]): WikiLinkDraft[] {
  return drafts.map((draft, index) => {
    const parsed = WikiLinkDraftSchema.safeParse(draft);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new WikiProjectionError(
        "wiki/invalid-input",
        `WikiLinkDraft[${index}] schema validation failed: ${detail}`,
      );
    }
    return parsed.data;
  });
}

/**
 * Hedef kataloğu: page ids are unique (input invariant). Slugs are not: a
 * child page's slug is unique only inside its category (its route is
 * `/wiki/<category>/<slug>`), so repository content can give a child the slug
 * of a root category or of a child in another category (F31). A bare slug
 * resolves only to the one page that owns it: the page whose route is
 * `/wiki/<slug>` (a root category owns its slug), or else the only page with
 * that slug. A slug shared otherwise is ambiguous and is never guessed.
 */
interface TargetCatalog {
  readonly byId: ReadonlyMap<string, WikiPageTarget>;
  readonly bySlug: ReadonlyMap<string, WikiPageTarget>;
  /** Slug → number of pages sharing it, for slugs no single page owns. */
  readonly ambiguousSlugs: ReadonlyMap<string, number>;
}

function buildCatalog(pages: readonly WikiPageTarget[]): TargetCatalog {
  const byId = new Map<string, WikiPageTarget>();
  const pagesBySlug = new Map<string, WikiPageTarget[]>();
  for (const page of pages) {
    if (byId.has(page.id)) {
      throw new WikiProjectionError(
        "wiki/duplicate-catalog-page",
        `Target catalog contains the same page id twice: ${page.id}`,
      );
    }
    byId.set(page.id, page);
    const sharing = pagesBySlug.get(page.slug);
    if (sharing === undefined) pagesBySlug.set(page.slug, [page]);
    else sharing.push(page);
  }
  const bySlug = new Map<string, WikiPageTarget>();
  const ambiguousSlugs = new Map<string, number>();
  for (const [slug, sharing] of pagesBySlug) {
    const owners =
      sharing.length === 1 ? sharing : sharing.filter((page) => page.route === `/wiki/${slug}`);
    const owner = owners.length === 1 ? owners[0] : undefined;
    if (owner === undefined) ambiguousSlugs.set(slug, sharing.length);
    else bySlug.set(slug, owner);
  }
  return { byId, bySlug, ambiguousSlugs };
}

/**
 * Alias çözümleme tablosu — kanonik sıra (alias metni, sonra sahibi
 * pageId). Aynı alias metnini taşıyan iki kayıt varsa kanonik sırada İLK
 * olan kazanır; sessiz tercihe karşı belirgin kural: kayıt sırası değil
 * kimlik sırası belirleyicidir (determinizm).
 */
interface AliasTable {
  readonly byText: readonly WikiAliasEntry[];
  readonly redirectById: ReadonlyMap<string, WikiAliasEntry>;
}

function buildAliasTable(aliases: readonly WikiAliasEntry[]): AliasTable {
  const canonical = [...aliases].sort((a, b) => {
    const byAlias = byString(a.alias, b.alias);
    return byAlias !== 0 ? byAlias : byString(a.pageId, b.pageId);
  });
  const redirectById = new Map<string, WikiAliasEntry>();
  for (const entry of canonical) {
    if (
      entry.candidateNewPageId !== undefined &&
      entry.candidateNewPageId !== null &&
      !redirectById.has(entry.pageId)
    ) {
      redirectById.set(entry.pageId, entry);
    }
  }
  return { byText: canonical, redirectById };
}

/**
 * Alias kaydının çözüm hedefi: redirect hedefi kataloğa düşüyorsa o,
 * düşmüyorsa sahibi sayfa (kataloğa düşüyorsa). İkisi de katalogda yoksa
 * alias bu girdide hiçbir hedefe çözümlemez (undefined).
 */
function aliasResolutionTarget(
  entry: WikiAliasEntry,
  catalog: TargetCatalog,
): string | undefined {
  const candidate =
    entry.candidateNewPageId === undefined || entry.candidateNewPageId === null
      ? undefined
      : entry.candidateNewPageId;
  if (candidate !== undefined && catalog.byId.has(candidate)) {
    return candidate;
  }
  if (catalog.byId.has(entry.pageId)) {
    return entry.pageId;
  }
  return undefined;
}

/**
 * Ham hedef referansını çözer. Dönüş: toPageId (çözümlendi) veya
 * undefined (broken). `confidenceCapped` — çözüm bir alias üzerinden
 * geldiğinde ve matchConfidence < 1 olduğunda true'dur; verified iddia
 * "heuristic" e düşürülür (doğrulanmış link taklidi yapılmaz, §16A.10).
 */
function resolveToRef(
  toRef: string,
  catalog: TargetCatalog,
  aliases: AliasTable | undefined,
): { toPageId: string; confidenceCapped: boolean } | undefined {
  // (1) Doğrudan sayfa kimliği.
  const byId = catalog.byId.get(toRef);
  if (byId !== undefined) {
    return { toPageId: byId.id, confidenceCapped: false };
  }
  // (2) Slug.
  const bySlug = catalog.bySlug.get(toRef);
  if (bySlug !== undefined) {
    return { toPageId: bySlug.id, confidenceCapped: false };
  }
  if (aliases === undefined) return undefined;
  // (3) Alias metni: kanonik sırada ilk eşleşen kayıt kazanır.
  for (const entry of aliases.byText) {
    if (entry.alias !== toRef) continue;
    const target = aliasResolutionTarget(entry, catalog);
    if (target === undefined) continue;
    const confidence = entry.matchConfidence;
    return {
      toPageId: target,
      confidenceCapped: confidence !== undefined && confidence < 1,
    };
  }
  // (4) Eski sayfa kimliği redirect'i (rename: oldPageId → candidate).
  const redirect = aliases.redirectById.get(toRef);
  if (redirect !== undefined) {
    const target = aliasResolutionTarget(redirect, catalog);
    if (target !== undefined) {
      const confidence = redirect.matchConfidence;
      return {
        toPageId: target,
        confidenceCapped: confidence !== undefined && confidence < 1,
      };
    }
  }
  return undefined;
}

/**
 * Link taslaklarını hedef kataloğu + alias kayıtlarına karşı çözer.
 *
 * - K-013 #4: çözümlenemeyen hedef → WikiLink toPageId=null ile KORUNUR
 *   ve brokenLinkDiagnostics kaydı üretilir (kaynak sayfa + hedef adı
 *   gerekçede taşınır; sessiz silme yok).
 * - Bilinmeyen kaynak sayfalı taslak REDDEDİLİR: broken-link sözleşmesi
 *   yalnızca hedef tarafı içindir (TŞ §16A.2); link, kaynak sayfasıyla
 *   birlikte yaşar — kaynak yoksa üretici hatasıdır, sessiz teşhis
 *   uydurulmaz.
 * - Verified taslak evidencesızsa red (TŞ §16A.7).
 *
 * Determinizm: çıktı link kimliğine göre kanonik sıralı ve deep-frozen;
 * aynı girdi → aynı çıktı.
 */
export function resolveWikiLinks(
  drafts: readonly WikiLinkDraft[],
  input: WikiLinkResolutionInput,
): WikiLinkResolution {
  const parsed = parseDrafts(drafts);
  if (input.wikiSnapshotId.trim().length === 0) {
    throw new WikiProjectionError(
      "wiki/invalid-input",
      "wikiSnapshotId must not be empty",
    );
  }
  const catalog = buildCatalog(input.pages);
  for (const draft of parsed) {
    if (!catalog.byId.has(draft.fromPageId)) {
      throw new WikiProjectionError(
        "wiki/unknown-link-source",
        `Link draft belongs to an unknown source page (the broken-link contract applies only to targets): ${draft.id} → source ${draft.fromPageId}`,
      );
    }
  }
  const seenIds = new Set<string>();
  for (const draft of parsed) {
    if (seenIds.has(draft.id)) {
      throw new WikiProjectionError(
        "wiki/duplicate-link",
        `Duplicate link id: ${draft.id}`,
      );
    }
    seenIds.add(draft.id);
  }
  const aliases =
    input.aliases === undefined ? undefined : buildAliasTable(input.aliases);

  const links: WikiLink[] = [];
  const diagnostics: BrokenLinkDiagnostic[] = [];
  for (const draft of parsed) {
    const resolved = resolveToRef(draft.toRef, catalog, aliases);
    const resolution =
      resolved !== undefined && resolved.confidenceCapped && draft.resolution === "verified"
        ? "heuristic"
        : draft.resolution;
    links.push({
      id: draft.id,
      wikiSnapshotId: input.wikiSnapshotId,
      fromPageId: draft.fromPageId,
      toPageId: resolved === undefined ? null : resolved.toPageId,
      kind: draft.kind,
      resolution,
      evidenceRefs: [...draft.evidenceRefs],
    });
    if (resolved === undefined) {
      const sharedBy = catalog.ambiguousSlugs.get(draft.toRef);
      const cause =
        sharedBy === undefined
          ? "no matching pageId/slug/alias in the catalog"
          : `${String(sharedBy)} pages share the slug and none owns it, so it is not guessed; no matching alias either`;
      diagnostics.push({
        linkId: draft.id,
        fromPageId: draft.fromPageId,
        toRef: draft.toRef,
        kind: draft.kind,
        reason: `Wiki link target could not be resolved: source page '${draft.fromPageId}' target '${draft.toRef}' (kind=${draft.kind}) — ${cause}; the record is kept with toPageId=null`,
      });
    }
  }

  links.sort((a, b) => byString(a.id, b.id));
  diagnostics.sort((a, b) => byString(a.linkId, b.linkId));

  // Savunma katmanı (projectWiki deseni): çözümlenen her link WikiLink
  // şemasından geçmelidir — verified ≥1 Evidence, nullable toPageId ve
  // enum kümeleri burada bir kez daha doğrulanır (alias düşürmesi yalnızca
  // verified→heuristic yönünde olduğundan kanıt kuralını gevşetemez).
  for (const [index, link] of links.entries()) {
    const linkParse = WikiLinkSchema.safeParse(link);
    if (!linkParse.success) {
      const detail = linkParse.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new WikiProjectionError(
        "wiki/invalid-input",
        `Resolved WikiLink[${index}] schema validation failed: ${detail}`,
      );
    }
  }

  const brokenCountByPage = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    brokenCountByPage.set(
      diagnostic.fromPageId,
      (brokenCountByPage.get(diagnostic.fromPageId) ?? 0) + 1,
    );
  }

  return deepFreeze({
    links,
    brokenLinkDiagnostics: diagnostics,
    brokenCountByPage,
  });
}

/**
 * WikiLink kayıtlarından O(1) çift yönlü indeks kurar (ADR-013: çift
 * yönlülük türetilir, kopyalanmaz — TEK kayıt forward + backlink iki
 * yüzü taşır). Girdi şemadan doğrulanır; duplicate link kimliği reddedilir.
 * Kalıcı satırlardan (toPageId=null) türetilen diagnostics'ta ham hedef
 * adı bilinmez ve toRef=null dürüstçe raporlanır.
 *
 * Determinizm: kovalar link kimliğine göre kanonik sıralı; çıktılar
 * deep-frozen.
 */
export function buildWikiLinkIndex(links: readonly WikiLink[]): WikiLinkIndex {
  const validated = links.map((link, index) => {
    const parsed = WikiLinkSchema.safeParse(link);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new WikiProjectionError(
        "wiki/invalid-input",
        `WikiLink[${index}] schema validation failed: ${detail}`,
      );
    }
    return parsed.data;
  });

  const seenIds = new Set<string>();
  for (const link of validated) {
    if (seenIds.has(link.id)) {
      throw new WikiProjectionError(
        "wiki/duplicate-link",
        `Duplicate link id in the index input: ${link.id}`,
      );
    }
    seenIds.add(link.id);
  }

  const canonical = [...validated].sort((a, b) => byString(a.id, b.id));

  const forward = new Map<string, WikiLink[]>();
  const back = new Map<string, WikiLink[]>();
  for (const link of canonical) {
    const fromList = forward.get(link.fromPageId) ?? [];
    fromList.push(link);
    forward.set(link.fromPageId, fromList);
    // K-013 #4: toPageId=null linkler hiçbir backlink kovasına DÜŞMEZ —
    // çözümlenmemiş hedefe backlink söylenmez; diagnostics listelenir.
    if (link.toPageId !== null) {
      const toList = back.get(link.toPageId) ?? [];
      toList.push(link);
      back.set(link.toPageId, toList);
    }
  }

  const broken: BrokenLinkDiagnostic[] = canonical
    .filter((link) => link.toPageId === null)
    .map((link) => ({
      linkId: link.id,
      fromPageId: link.fromPageId,
      toRef: null,
      kind: link.kind,
      reason: `Persisted WikiLink row has toPageId=null: the target of link '${link.id}' is unresolved; the raw target name is not stored in the persisted model, so diagnostics cannot show it`,
    }));

  const brokenCountByPage = new Map<string, number>();
  for (const link of canonical) {
    if (link.toPageId === null) {
      brokenCountByPage.set(
        link.fromPageId,
        (brokenCountByPage.get(link.fromPageId) ?? 0) + 1,
      );
    }
  }

  const frozenForward = new Map<string, readonly WikiLink[]>();
  for (const [pageId, list] of forward) {
    frozenForward.set(pageId, deepFreeze(list));
  }
  const frozenBack = new Map<string, readonly WikiLink[]>();
  for (const [pageId, list] of back) {
    frozenBack.set(pageId, deepFreeze(list));
  }
  const frozenBroken = deepFreeze(broken);

  const EMPTY: readonly WikiLink[] = deepFreeze<WikiLink[]>([]);

  return deepFreeze({
    forwardLinks: (pageId: string): readonly WikiLink[] =>
      frozenForward.get(pageId) ?? EMPTY,
    backlinks: (pageId: string): readonly WikiLink[] =>
      frozenBack.get(pageId) ?? EMPTY,
    brokenLinkDiagnostics: (): readonly BrokenLinkDiagnostic[] => frozenBroken,
    brokenLinkCountByPage: (pageId: string): number =>
      brokenCountByPage.get(pageId) ?? 0,
    totalLinkCount: canonical.length,
    resolvedLinkCount: canonical.length - broken.length,
    brokenLinkCount: broken.length,
  });
}
