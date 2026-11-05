import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Denetim bulgusu (düşük, davranışsal): senkron runPipeline envanter
 * mutabakatını (files tablosu upsert) TS adapter koşumundan ÖNCE yapıyordu;
 * async yol aynı tehlikeyi bilinçli olarak tersine çevirmişti (adapter
 * hatasından SONRA mutabakat; aksi hâlde güncellenen files tablosu sonraki
 * incremental koşumu "değişiklik yok" no-op'una itip bayat graph'ı korur —
 * B10 denetim bulgusu testi). Bu dosya iki koşum yolunun aynı sıralama
 * sözleşmesinde olduğunu zorlar: adapter sözleşme dışı fırlattığında
 * senkron yolda da envanter DOKUNULMAMIŞ kalmalı.
 *
 * Test seam: analyzeTypeScriptProgram modül mock'u (B10'un csharp.analyzeCSharp
 * enjeksiyon precedansıyla aynı kural — prod varsayılan dokunulmaz).
 */

const FIXED_NOW = "2026-11-05T00:00:00.000Z";

vi.mock("@causoryn/adapter-typescript", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@causoryn/adapter-typescript")>();
  return {
    ...actual,
    analyzeTypeScriptProgram: () => {
      throw new Error("sync-order-boom");
    },
  };
});

import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexService } from "../src/index.js";

describe("runIndex senkron yol — envanter mutabakatı adapter koşumundan SONRA (sıralama sözleşmesi)", () => {
  it("adapter sözleşme dışı throw → hata rethrow; files tablosu upsert YAPILMAMIŞ kalır", () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-sync-order-"));
    try {
      // Analiz edilebilir tek TS dosyası: adapter mock'u her koşumda throw eder.
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n", "utf8");

      const repository = new InMemoryGraphRepository();
      const service = new IndexService({
        workspaceId: "sync-order",
        policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
        repository,
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });

      let caught: unknown;
      try {
        service.runIndex(root);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toContain("sync-order-boom");
      // Kritik iddia: files tablosu adapter koşumundan SONRA güncellenmelidir
      // → throw yolunda envanter boş kalır; sonraki incremental karma
      // karşılaştırması değişikliği gerçekten görür ve bayat graph'ı
      // "değişiklik yok" sanarak koruyamaz (async yoldaki B10 sözleşmesi).
      expect(repository.listFiles("sync-order")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
