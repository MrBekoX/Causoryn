import os from "node:os";

import type { SqliteWikiStore, WikiPage, WikiSnapshotRead } from "@causoryn/storage-sqlite";
import { describe, expect, it } from "vitest";

import { createCausorynContext, wikiGetTree, type CausorynContext } from "../src/index.js";

/**
 * causoryn_wiki_get_tree walks parentId links. A stored wiki whose parent
 * chain loops (self-parent or A → B → C → A) must not make the walk revisit
 * pages: every page is listed at most once and the call terminates without
 * a depth cap.
 */

const SNAPSHOT_ID = "wiki-snapshot-cycle";

function page(id: string, parentId: string | null): WikiPage {
  return {
    id,
    wikiSnapshotId: SNAPSHOT_ID,
    kind: "overview",
    parentId,
    title: `Page ${id}`,
    slug: id,
    route: `/wiki/${id}`,
    contentHash: `hash-${id}`,
    freshness: "fresh",
    coverage: { status: "complete" },
  };
}

function contextWithWiki(pages: readonly WikiPage[]): CausorynContext {
  const base = createCausorynContext(
    { workspaceId: "default", allowRoots: [os.tmpdir()], autoIndex: false },
    { logger: () => {} },
  );
  const read: WikiSnapshotRead = {
    snapshot: {
      id: SNAPSHOT_ID,
      workspaceId: "default",
      graphSnapshotId: "graph-cycle",
      revisionRef: "rev-cycle",
      status: "ready",
      builtAt: "2026-11-25T00:00:00.000Z",
      templateVersion: "tpl-test",
    },
    pages,
    sections: [],
    links: [],
    versions: [],
  };
  const wikiStore = {
    getLatestPublishedWiki: (workspaceId: string) =>
      workspaceId === "default" ? read : undefined,
    readWikiSnapshot: (snapshotId: string) => (snapshotId === SNAPSHOT_ID ? read : undefined),
  } as unknown as SqliteWikiStore;
  return { ...base, wikiStore };
}

describe("causoryn_wiki_get_tree — cyclic parent chains", () => {
  const cyclicPages = [
    page("root", null),
    page("child", "root"),
    // a → b → c → a: a loop that is not reachable from a root page.
    page("a", "c"),
    page("b", "a"),
    page("c", "b"),
    // Self-parent page.
    page("self", "self"),
  ];

  it("lists each page of a parent cycle once even with a depth cap", () => {
    const context = contextWithWiki(cyclicPages);
    try {
      const envelope = wikiGetTree(context, "req-tree-cycle-depth", {
        parentId: "a",
        depth: 8,
      });
      const data = envelope.data as { nodes: Array<{ pageId: string; depth: number }>; totalNodes: number };
      expect(data.nodes.map((node) => node.pageId)).toEqual(["a", "b", "c"]);
      expect(data.nodes.map((node) => node.depth)).toEqual([1, 2, 3]);
      expect(data.totalNodes).toBe(3);
    } finally {
      context.close();
    }
  });

  it("terminates without a depth cap on a cycle and on a self-parent page", () => {
    const context = contextWithWiki(cyclicPages);
    try {
      const cycle = wikiGetTree(context, "req-tree-cycle", { parentId: "b" });
      expect((cycle.data as { nodes: Array<{ pageId: string }> }).nodes.map((n) => n.pageId)).toEqual([
        "b",
        "c",
        "a",
      ]);
      const self = wikiGetTree(context, "req-tree-self", { parentId: "self" });
      expect((self.data as { nodes: Array<{ pageId: string }> }).nodes.map((n) => n.pageId)).toEqual([
        "self",
      ]);
      // The full tree from the roots is unaffected by unreachable cycles.
      const full = wikiGetTree(context, "req-tree-full", {});
      expect((full.data as { nodes: Array<{ pageId: string }> }).nodes.map((n) => n.pageId)).toEqual([
        "root",
        "child",
      ]);
    } finally {
      context.close();
    }
  });
});
