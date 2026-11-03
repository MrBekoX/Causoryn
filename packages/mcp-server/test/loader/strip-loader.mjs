/**
 * ESM resolve hook: göreli `.js` specifi'i çözümlenemiyorsa aynı adlı
 * `.ts` dosyası denenir. Protokol/test altyapısı; ürün kodu değildir.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      typeof specifier === "string" &&
      specifier.endsWith(".js") &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      const candidate = specifier.slice(0, -".js".length) + ".ts";
      try {
        return await nextResolve(candidate, context);
      } catch {
        // orijinal hata daha doğru: yeniden fırlat
      }
    }
    throw error;
  }
}
