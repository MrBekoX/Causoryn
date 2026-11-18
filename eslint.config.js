/**
 * ESLint flat config (Sprint-1 görev 7).
 *
 * typescript-eslint recommended kuralları; derleme çıktıları (dist),
 * bağımlılıklar (node_modules) ve değişmez kaynaklar (raw/, wiki/) hariç
 * tutulur. Kural seti kasıtlı olarak küçük tutulur: kesin doğrulama
 * `npm run typecheck` (strict TS) ve testlerle yapılır.
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "integrations/antigravity/causoryn/scripts/**",
      "out/**",
      "raw/**",
      "wiki/**",
      "docs/**",
      ".zcode/**",
      ".causoryn/**",
      ".causoryn-runtime/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js"],
    rules: {
      // `_` öneki "kasıtlı olarak kullanılmayan" konvansiyonudur: rest
      // destructuring ile alan strip etmede kullanılır (örn.
      // `const { span: _omit, ...withoutSpan } = evidence`). Kural kapalı
      // DEĞİLDİR — gerçek kullanılmayan değişkenler hâlâ hatadır.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
