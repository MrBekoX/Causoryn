import type { PreflightManifest } from "@causoryn/preflight";

/**
 * Süreç-içi Preflight Manifest deposu — sprint-6 Faz E MCP yüzeyi
 * (causoryn_verify_change'in TŞ §10.2 "preflightId" girdisinin çözümü).
 *
 * TŞ §1 ürün döngüsü (Discover → Preflight → Agent Edits → Verify):
 * causoryn_preflight_change manifest'İ YALNIZCA yanıt gövdesinde döndürür
 * (sprint-5 D4: manifest deposu tutulmaz, candidateOnly=true; kod yazmaz).
 * causoryn_verify_change ise TŞ §10.2 katalog satırındaki birincil girdi
 * olarak preflightId alır — sprint-5'te bu kimlik ÇÖZÜMLENEMİYORDU
 * (derive_test_plan "preflightId bu dilimde çözümlenmez" open-ret'i).
 * Faz E bu boşluğu kapatır: preflight_change ürettiği manifesti BU depoya
 * kaydeder (preflightId = manifest.preflightId; içerik adresli
 * "preflight:<sha256>" — aynı manifest idempotent olarak aynı anahtara
 * yazar), verify_change preflightId'yi buradan çözer.
 *
 * Dürüstlük sınırları (belgeli):
 * - Depo SÜREÇ-İÇİDİR (in-memory). Sunucu yeniden başlatıldığında kayıtlar
 *   düşer; bilinmeyen preflightId INVALID_ARGUMENT ile reddedilir ve hata
 *   metni causoryn_preflight_change'i önceleyen akışı söyler. Disk kalıcılığı
 *   bu dilimin kapsamı değildir (TŞ manifest'i yanıt gövdesi kaynaklıdır;
 *   kalıcı depo sonraki dilimlere aittir).
 * - Depo KAYNAK AĞACINA VE İZİNLİ DATA-ROOT'A YAZMAZ (kırmızı çizgi 2):
 *   yalnızca bellekte Map anahtar-değer tutar.
 * - get yalnızca TAM anahtar eşleşmesiyle döner (önek/fuzzy çözümleme yok —
 *   uydurma kimlik eşlemesi yasaktır).
 */
export class PreflightManifestStore {
  private readonly manifests = new Map<string, PreflightManifest>();

  /** Manifesti anahtarlar; aynı preflightId idempotent olarak üzerine yazar. */
  put(manifest: PreflightManifest): void {
    this.manifests.set(manifest.preflightId, manifest);
  }

  /** Tam anahtar eşleşmesiyle manifest döndürür; yoksa undefined. */
  get(preflightId: string): PreflightManifest | undefined {
    return this.manifests.get(preflightId);
  }
}
