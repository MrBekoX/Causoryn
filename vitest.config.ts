/**
 * Vitest yapılandırması (TŞ v2.1 §6 — deterministik davranış, Vitest).
 *
 * Not: dosya kasıtlı olarak import'suz düz nesne export'udur; `defineConfig`
 * yalnızca tip kolaylaştırıcıdır. Include desenleri Sprint-1 iskelet dilimiyle
 * genişletildi: packages/, adapters/, integrations/ ve tests/ altındaki tüm
 * *.test.ts dosyaları; node_modules/dist dışlanır.
 *
 * tests/bench-release dışlanır (denetim bulgusu, 2026-11-09): F7 benchmark
 * duvar-saati duyarlı bir PERFORMANS ölçümüdür — doğruluk kapısı değil.
 * `npm run test`'in paralel yükü altında çağrı deadline'ı (30 s) aşılıp
 * satır dürüstçe not_measured'a düşebileceğinden varsayılan suite'te
 * flaky-potansiyellidir ve ölçüm değerleri de süitte anlamlıdır.
 * Ayrı koşum: `npm run bench` (docs/benchmarks.md yenileme:
 * CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench).
 */
const config = {
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "integrations/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/bench-release/**"],
    environment: "node",
  },
};

export default config;
