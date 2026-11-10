import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cloneBundleTo, startBundleSession, type BundleSession } from "./helpers/bundle-client.js";

/**
 * bundle-client close() sözleşmesi (denetim bulgusu, 2026-11-09):
 * close() yalnızca SONRADAN gelen 'close' olayını bekler; çocuk süreç
 * çağrıdan ÖNCE ölmüşse olay tekrar ateşlenmez ve promise asla çözülmez —
 * test/afterAll timeout'ları (30-60 s) yanıltıcı "timeout" hatasıyla
 * geri düşer. Sözleşme: close(), zaten ölmüş bir çocukta anında çözülür
 * (exitCode; sinyalle ölümde null).
 */

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundle-client close() — zaten ölmüş çocuk sürecin davranışı", () => {
  it("NEGATİF: süreç close() çağrısından önce öldüyse close anında çözülür (askıda kalmaz)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-close-dead-"));
    tempDirs.push(dir);
    const bundlePath = cloneBundleTo(dir);
    const session: BundleSession = await startBundleSession({
      bundlePath,
      cwd: dir,
      config: {
        workspaceId: "close-dead",
        allowRoots: [],
        results: { maxNodes: 10, maxSymbols: 10 },
      },
    });
    expect(session.childPid).toBeGreaterThan(0);

    // Çocuğu close()'tan ÖNCE öldür; 'close' olayı bu noktada zaten
    // ateşlenmiş olur (olay tekrarı yoktur).
    process.kill(session.childPid);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Kırmızı kanıt çerçevesi: eski close() bu çağrıda sonsuza dek bekler;
    // 5 s'lik yarış kaybederse test dürüstçe "askıda" diye düşer.
    let loser: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        session.close(),
        new Promise<never>((_resolve, reject) => {
          loser = setTimeout(
            () => reject(new Error("close() 5 s içinde çözülmedi — ölü çocukta askıda kaldı")),
            5_000,
          );
          loser.unref();
        }),
      ]);
      // Önemli olan ÇÖZÜLMESİDİR; kod platform semantiğine bağlıdır:
      // Windows TerminateProcess zorla çıkış kodu 1 döndürür, POSIX'te
      // SIGTERM ile ölüm exitCode null + signalCode SIGTERM'dir.
      if (process.platform === "win32") {
        expect(code).toBe(1);
      } else {
        expect(code).toBeNull();
      }
    } finally {
      clearTimeout(loser);
    }
  }, 60_000);
});
