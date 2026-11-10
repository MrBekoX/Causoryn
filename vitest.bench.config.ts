/**
 * Benchmark koşum yapılandırması (`npm run bench`).
 *
 * F7 benchmark duvar-saati duyarlı bir PERFORMANS ölçümüdür; doğruluk
 * kapısı olan `npm run test`'ten (vitest.config.ts exclude) kasıtlı olarak
 * ayrıştırılmıştır (denetim bulgusu, 2026-11-09). Bu config yalnızca
 * bench-release altını koşturur — exclude YOK, böylece CLI filtresi
 * dosyayı bulur. docs/benchmarks.md yenileme:
 *   CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench
 */
const config = {
  test: {
    include: ["tests/bench-release/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
};

export default config;
