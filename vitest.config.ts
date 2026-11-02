/**
 * Vitest yapılandırması (TŞ v2.1 §6 — deterministik davranış, Vitest).
 *
 * Not: dosya kasıtlı olarak import'suz düz nesne export'udur; `defineConfig`
 * yalnızca tip kolaylaştırıcıdır. Include desenleri Sprint-1 iskelet dilimiyle
 * genişletildi: packages/, adapters/, integrations/ ve tests/ altındaki tüm
 * *.test.ts dosyaları; node_modules/dist dışlanır.
 */
const config = {
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "integrations/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
};

export default config;
