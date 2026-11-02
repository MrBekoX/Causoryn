/**
 * Vitest yapılandırması (TŞ v2.1 §6 — deterministik davranış, Vitest).
 *
 * Not: dosya kasıtlı olarak import'suz düz nesne export'udur. Bootstrapping
 * aşamasında vitest paketi proje `node_modules`'unda kurulu değilken (npm
 * install yapılmadan, `npx --no-install` ile) yapılandırmanın yüklenememesi
 * sorunu böylece önlenir; `defineConfig` yalnızca tip kolaylaştırıcıdır.
 */
const config = {
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
};

export default config;
