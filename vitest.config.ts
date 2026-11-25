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
    // The default 5 s is too tight for slow CI runners (the macOS Intel merge
    // gate saturates its 4 vCPUs while suites spawn toolchains, and short
    // in-memory tests then see multi-second scheduling stalls). Tests that need
    // a precise limit set their own; a real hang still fails.
    testTimeout: 20_000,
    // CI runners have 4 vCPUs, and many suites start heavy child processes
    // (.NET Roslyn, cargo, go, python, MCP servers) on top of the test workers,
    // which starved timing-sensitive tests. On CI: at most 2 test workers, and a
    // failed test is retried once (the reporter still lists retried tests).
    ...(process.env["CI"] === "true" ? { maxWorkers: 2, retry: 1 } : {}),
  },
};

export default config;
