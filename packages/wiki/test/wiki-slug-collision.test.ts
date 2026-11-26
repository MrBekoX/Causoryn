import { describe, expect, it } from "vitest";

import { createSnapshot, type SnapshotGraph } from "@causoryn/domain";

import {
  WikiProjectionError,
  projectWiki,
  resolveWikiLinks,
  wikiSlugify,
  type WikiLinkDraft,
  type WikiPageTarget,
  type WikiProjection,
} from "../src/index.js";

/**
 * F31 (CWE-694): a child page's slug is unique only inside its category, so
 * repository content can give a child the slug of a root category
 * (`@app.route("/", methods=["OVERVIEW"])` → Endpoint "OVERVIEW /" → slug
 * "overview"), and two children in different categories can share a slug
 * (a Table and a Topic both named "orders"). The link catalog required every
 * slug to be unique, so wiki_build failed for that workspace on every run.
 * The catalog now keys pages by id; a bare slug resolves only when it names
 * one page, and a root category owns its own slug. Page slugs and routes are
 * unchanged.
 */

const WS = "ws_slug_collision";
const BUILT_AT = "2026-11-26T09:05:00.000Z";

function graphWith(nodes: ReadonlyArray<{ kind: "Endpoint" | "Table" | "Topic"; qualifiedName: string }>): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-slug-001", sequence: 1 },
    configHash: "cfg-slug-001",
    analyzerFingerprint: "py-adapter@1",
    state: "ready",
    createdAt: "2026-11-26T09:00:00.000Z",
    nodes: [{ kind: "Workspace" as const, qualifiedName: "repo" }, ...nodes],
    edges: [],
  });
}

function targetsOf(projection: WikiProjection): WikiPageTarget[] {
  return projection.pages.map((page) => ({ id: page.id, slug: page.slug, route: page.route }));
}

/** The PARENT_OF drafts wiki_build writes: every child linked from its root category, by page id. */
function parentDrafts(projection: WikiProjection): WikiLinkDraft[] {
  return projection.pages
    .filter((page) => page.parentId !== null)
    .map((page) => ({
      id: `link:parent:${page.id}`,
      fromPageId: page.parentId as string,
      toRef: page.id,
      kind: "PARENT_OF" as const,
      resolution: "heuristic" as const,
      evidenceRefs: [],
    }));
}

function pageWithRoute(projection: WikiProjection, route: string): { id: string; slug: string } {
  const page = projection.pages.find((candidate) => candidate.route === route);
  if (page === undefined) throw new Error(`no page at ${route}`);
  return page;
}

describe("F31: wiki links resolve when a child slug equals another page's slug", () => {
  it("resolves every link when an endpoint route name slugifies to a root category slug", () => {
    expect(wikiSlugify("OVERVIEW /")).toBe("overview");
    const projection = projectWiki(graphWith([{ kind: "Endpoint", qualifiedName: "OVERVIEW /" }]), { builtAt: BUILT_AT });
    const child = pageWithRoute(projection, "/wiki/apis-entry-points/overview");
    const root = pageWithRoute(projection, "/wiki/overview");
    expect(child.slug).toBe(root.slug);

    const drafts = parentDrafts(projection);
    const resolution = resolveWikiLinks(drafts, { wikiSnapshotId: projection.snapshot.id, pages: targetsOf(projection) });
    expect(resolution.links).toHaveLength(drafts.length);
    expect(resolution.brokenLinkDiagnostics).toEqual([]);
    expect(resolution.links.find((link) => link.toPageId === child.id)?.fromPageId).toBe(
      pageWithRoute(projection, "/wiki/apis-entry-points").id,
    );
  });

  it("lets the root category own its slug: a bare 'overview' still names the root page", () => {
    const projection = projectWiki(graphWith([{ kind: "Endpoint", qualifiedName: "OVERVIEW /" }]), { builtAt: BUILT_AT });
    const root = pageWithRoute(projection, "/wiki/overview");
    const resolution = resolveWikiLinks(
      [
        {
          id: "link:by-slug",
          fromPageId: root.id,
          toRef: "overview",
          kind: "DOCUMENTS",
          resolution: "heuristic",
          evidenceRefs: [],
        },
      ],
      { wikiSnapshotId: projection.snapshot.id, pages: targetsOf(projection) },
    );
    expect(resolution.links[0]?.toPageId).toBe(root.id);
  });

  it("resolves links when children in two categories share a slug, and never guesses that slug", () => {
    const projection = projectWiki(
      graphWith([
        { kind: "Table", qualifiedName: "orders" },
        { kind: "Topic", qualifiedName: "orders" },
      ]),
      { builtAt: BUILT_AT },
    );
    const table = pageWithRoute(projection, "/wiki/data-schemas/orders");
    const topic = pageWithRoute(projection, "/wiki/events-integrations/orders");
    expect(table.slug).toBe(topic.slug);

    const drafts: WikiLinkDraft[] = [
      ...parentDrafts(projection),
      {
        id: "link:ambiguous",
        fromPageId: table.id,
        toRef: "orders",
        kind: "RELATED_CONTRACT",
        resolution: "heuristic",
        evidenceRefs: [],
      },
    ];
    const resolution = resolveWikiLinks(drafts, { wikiSnapshotId: projection.snapshot.id, pages: targetsOf(projection) });
    expect(resolution.links.filter((link) => link.toPageId !== null)).toHaveLength(drafts.length - 1);
    const ambiguous = resolution.links.find((link) => link.id === "link:ambiguous");
    expect(ambiguous?.toPageId).toBeNull();
    expect(resolution.brokenLinkDiagnostics.map((diagnostic) => diagnostic.linkId)).toEqual(["link:ambiguous"]);
    expect(resolution.brokenLinkDiagnostics[0]?.reason).toMatch(/2 pages share the slug/);
  });

  it("resolves links when a suffixed child slug equals another child's natural slug (F88)", () => {
    const first = projectWiki(
      graphWith([
        { kind: "Endpoint", qualifiedName: "GET /a" },
        { kind: "Endpoint", qualifiedName: "get /a" },
      ]),
      { builtAt: BUILT_AT },
    );
    const suffixed = first.pages.find((page) => page.slug.startsWith("get-a-"));
    if (suffixed === undefined) throw new Error("expected a suffixed slug");
    const projection = projectWiki(
      graphWith([
        { kind: "Endpoint", qualifiedName: "GET /a" },
        { kind: "Endpoint", qualifiedName: "get /a" },
        { kind: "Endpoint", qualifiedName: suffixed.slug },
      ]),
      { builtAt: BUILT_AT },
    );
    const sharing = projection.pages.filter((page) => page.slug === suffixed.slug);
    expect(sharing).toHaveLength(2);

    const drafts = parentDrafts(projection);
    const resolution = resolveWikiLinks(drafts, { wikiSnapshotId: projection.snapshot.id, pages: targetsOf(projection) });
    expect(resolution.links.every((link) => link.toPageId !== null)).toBe(true);
  });

  it("still refuses a catalog that lists the same page id twice", () => {
    const pages: WikiPageTarget[] = [
      { id: "page:1", slug: "a", route: "/wiki/a" },
      { id: "page:1", slug: "b", route: "/wiki/b" },
    ];
    expect(() => resolveWikiLinks([], { wikiSnapshotId: "wiki:1", pages })).toThrow(WikiProjectionError);
    try {
      resolveWikiLinks([], { wikiSnapshotId: "wiki:1", pages });
    } catch (error) {
      expect((error as WikiProjectionError).code).toBe("wiki/duplicate-catalog-page");
    }
  });
});
