import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  snapshotCanonicalJson,
  type SnapshotInput,
} from "../src/snapshot.js";

/**
 * Snapshot node attributes → canonical JSON bütünlüğü.
 *
 * Güvenlik analizi bulgusu: asJsonValue kendi `out[key] = value` ataması
 * `key === "__proto__"` olduğunda Object.prototype'ın inherited accessor'ına
 * (setter) gider; own anahtar sessizce DÜŞER (snapshotCanonicalJson
 * çıktısında veri kaybı; çapraz-nesne pollution yoktur). JSON.parse ile
 * üretilen (ör. harici bir kaynak dosyasından gelen) attribute anahtarları
 * own "__proto__" taşıyabilir — bütünlük hardening.
 */

const WS = "ws-proto";

function makeInput(attributes: Record<string, unknown>): SnapshotInput {
  return {
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-1",
    analyzerFingerprint: "ts-adapter@0.1.0",
    state: "ready",
    createdAt: "2026-11-03T00:00:00.000Z",
    nodes: [{ kind: "Class", qualifiedName: "OrdersService", attributes }],
    edges: [],
  };
}

describe("snapshot attributes — dangerous own keys", () => {
  it("pozitif: own '__proto__' anahtarı canonical JSON'da korunur (sessiz veri kaybı yok)", () => {
    // JSON.parse, "__proto__"u GERÇEK own data property olarak üretir.
    const raw = JSON.parse(
      '{"__proto__":{"evil":1},"role":"api"}',
    ) as Record<string, unknown>;
    const snapshot = createSnapshot(makeInput(raw));
    const json = snapshotCanonicalJson(snapshot);
    expect(json).toContain('"__proto__"');
    expect(json).toContain('"evil"');
    expect(json).toContain('"role"');
    expect(json).toContain('"api"');
  });

  it("negatif: düzeltme global prototype'ı kirletmez (Object.prototype değişmez)", () => {
    const raw = JSON.parse(
      '{"__proto__":{"evil":1},"b":2}',
    ) as Record<string, unknown>;
    const snapshot = createSnapshot(makeInput(raw));
    const probe = {} as Record<string, unknown>;
    expect((probe as { evil?: unknown }).evil).toBeUndefined();
    const attributes = snapshot.nodes[0]?.attributes ?? {};
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(attributes)).toEqual(
      expect.arrayContaining(["__proto__", "b"]),
    );
  });

  it("partial: primitive '__proto__' değeri de korunur ve canonical JSON deterministiktir", () => {
    const raw = JSON.parse(
      '{"__proto__":"str-deger","b":2}',
    ) as Record<string, unknown>;
    const json = snapshotCanonicalJson(createSnapshot(makeInput(raw)));
    expect(json).toContain('"__proto__":"str-deger"');
    expect(json).toContain('"b"');
    expect(snapshotCanonicalJson(createSnapshot(makeInput(raw)))).toBe(json);
  });
});
