import type { PreflightManifest } from "@causoryn/preflight";
import { describe, expect, it } from "vitest";

import {
  PREFLIGHT_MANIFEST_STORE_LIMIT,
  PreflightManifestStore,
} from "../src/index.js";

/**
 * PreflightManifestStore — süreç-içi depo sözleşmesi (sprint-6 Faz E).
 *
 * Güvenlik analisti bulgusu: depo her put'u SINIRSIZ in-memory Map'te
 * tutuyordu; uzun ömürlü sunucu sürecinde manifest sayısıyla orantılı
 * bellek büyümesi sınırsızdı. Düzeltme: TŞ §20 kaynak bütçesi örüntüsüyle
 * tavan (PREFLIGHT_MANIFEST_STORE_LIMIT) + en eski kaydın FIFO dışarı
 * atılması. Depo disk'e yazmaz (kırmızı çizgi 2); süreç yeniden başlarken
 * kayıtlar düşer (belgeli dürüstlük sınırı — bkz. preflight-store.ts).
 */

/** Depo düzeyi geçerli minimal manifest (depo manifest doğrulamaz). */
function manifestOf(preflightId: string): PreflightManifest {
  return {
    preflightId,
    baseSnapshotId: "snapshot:test",
    intentLabel: "test niyeti",
    candidateOnly: true,
    identifiedTargets: [],
    impactCandidates: [],
    contractChecks: [],
    testPlanId: undefined,
    requiresDisambiguation: false,
    candidateTargets: [],
    limitations: [],
    sourceRevision: undefined,
  };
}

describe("PreflightManifestStore — süreç-içi depo tavanı", () => {
  it("pozitif: put/get tam anahtar eşleşmesiyle çalışır; bilinmeyen kimlik undefined döner", () => {
    const store = new PreflightManifestStore();
    const manifest = manifestOf("preflight:aa");
    store.put(manifest);
    expect(store.get("preflight:aa")).toBe(manifest);
    expect(store.get("preflight:bb")).toBeUndefined();
  });

  it("pozitif: aynı preflightId idempotent üzerine yazar; evict TETİKLENMEZ", () => {
    const store = new PreflightManifestStore();
    const first = manifestOf("preflight:aa");
    const second = manifestOf("preflight:aa");
    store.put(first);
    store.put(second);
    expect(store.get("preflight:aa")).toBe(second);
  });

  it("pozitif: tavan aşımında EN ESKİ manifest dışarı atılır (FIFO evict) — bellek manifest sayısıyla sınırsız büyümez", () => {
    const store = new PreflightManifestStore();
    for (let index = 0; index < PREFLIGHT_MANIFEST_STORE_LIMIT; index++) {
      store.put(manifestOf(`preflight:${String(index).padStart(3, "0")}`));
    }
    const oldestId = `preflight:${"0".repeat(3)}`;
    expect(store.get(oldestId)).toBeDefined();
    // Tavan aşımı: bir distinct manifest daha → en eski düşer, en yeni tutulur.
    store.put(manifestOf("preflight:zz"));
    expect(store.get(oldestId)).toBeUndefined();
    expect(store.get("preflight:zz")).toBeDefined();
    // Düşen kayıt yeniden yazılabilir (evict yalnızca tavanı korur; reddetmez).
    store.put(manifestOf(oldestId));
    expect(store.get(oldestId)).toBeDefined();
  });
});
