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
 * - Depo TAVANLIDIR (PREFLIGHT_MANIFEST_STORE_LIMIT; TŞ §20 kaynak bütçesi
 *   örüntüsü). Güvenlik analisti bulgusu: sınırsız Map uzun ömürlü sunucu
 *   sürecinde manifest sayısıyla orantılı bellek büyümesine izin veriyordu;
 *   tavan aşımında EN ESKİ kayıt FIFO dışarı atılır (reddetme yok — en yeni
 *   her zaman tutulur; aynı preflightId'nin idempotent yeniden yazması evict
 *   tetiklemez). Düşen bir preflightId yeniden put edilebilir; verify_change
 *   tarafında düşmüş kimlik INVALID_ARGUMENT ile açıkça raporlanır.
 * - Depo KAYNAK AĞACINA VE İZİNLİ DATA-ROOT'A YAZMAZ (kırmızı çizgi 2):
 *   yalnızca bellekte Map anahtar-değer tutar.
 * - get yalnızca TAM anahtar eşleşmesiyle döner (önek/fuzzy çözümleme yok —
 *   uydurma kimlik eşlemesi yasaktır).
 */

/** TŞ §20 kaynak bütçesi örüntüsü: depoda tutulan azami manifest sayısı. */
export const PREFLIGHT_MANIFEST_STORE_LIMIT = 200;

export class PreflightManifestStore {
  private readonly manifests = new Map<string, PreflightManifest>();

  /**
   * Manifesti anahtarlar; aynı preflightId idempotent olarak üzerine yazar.
   * Tavan aşımında (distinct anahtar) en eski kayıt FIFO dışarı atılır —
   * Map ekleme sırasını korur; mevcut anahtarın yeniden yazılması sırayı
   * değiştirmez, dolayısıyla evict deterministiktir.
   */
  put(manifest: PreflightManifest): void {
    if (
      !this.manifests.has(manifest.preflightId) &&
      this.manifests.size >= PREFLIGHT_MANIFEST_STORE_LIMIT
    ) {
      const oldest = this.manifests.keys().next();
      if (oldest.done !== true) {
        this.manifests.delete(oldest.value);
      }
    }
    this.manifests.set(manifest.preflightId, manifest);
  }

  /** Tam anahtar eşleşmesiyle manifest döndürür; yoksa undefined. */
  get(preflightId: string): PreflightManifest | undefined {
    return this.manifests.get(preflightId);
  }
}
