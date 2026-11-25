import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createCausorynContext } from "../src/context.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("wiki search connection hardening", () => {
  it("opens the read-only wiki search connection with PRAGMA trusted_schema = OFF", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-wiki-search-ws-"));
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-wiki-search-data-"));
    dirs.push(root, dataDir);
    const ctx = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [root],
        autoIndex: false,
        wiki: { dataDbPath: path.join(dataDir, "wiki.sqlite") },
      },
      { logger: () => {} },
    );
    try {
      expect(ctx.wikiSearch).not.toBeNull();
      // The search store keeps its connection private; read the pragma through it.
      const db = (ctx.wikiSearch as unknown as { readonly db: Database.Database }).db;
      expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
    } finally {
      ctx.close();
    }
  });
});
