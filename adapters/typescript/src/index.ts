/**
 * @causoryn/adapter-typescript — TypeScript Language Adapter paket iskeleti.
 *
 * Sorumluluk alanı (TŞ v2.1 §6, §7, §7.1, Sprint-1 görev 4): TypeScript
 * Compiler API ile AST üretimi, symbol resolution (hedef L2, seçili
 * framework L3), LanguageAdapter arayüzüne uyum. Adapter çıktısı
 * capabilities/unsupportedConstructs/coverageRatio/warnings taşır.
 *
 * Bağımlılık sınırı (wiki/architecture.md): adapter motoru çökertmez —
 * bir adapter'ın çalışamaması tüm motoru etkilemez (TŞ §5.1).
 *
 * Bu modül bir iskelet placeholder'ıdır: gerçek adapter Sprint-1 görev 4
 * diliminde yazılacaktır. ADR-010 uyarınca bu paket Done olarak beyan
 * EDİLMEZ.
 */

/** TypeScript adapter'ının Faz A dilimindeki mimari sözleşmesi. */
export interface TypeScriptAdapterPackageContract {
  readonly name: "@causoryn/adapter-typescript";
  readonly role: "language-adapter";
  readonly resolver: "typescript-compiler-api";
  readonly targetLevels: readonly ["L1", "L2"];
  readonly responsibilities: readonly [
    "ast-parse",
    "symbol-resolution",
    "capability-and-coverage-reporting",
  ];
  readonly designSource: "TŞ v2.1 §6, §7, §7.1, §25/4";
  readonly status: "scaffold";
}

/** Paketin statik sözleşmesi; gerçek adapter Sprint-1 görev 4'te gelir. */
export const typescriptAdapterPackageContract: TypeScriptAdapterPackageContract = {
  name: "@causoryn/adapter-typescript",
  role: "language-adapter",
  resolver: "typescript-compiler-api",
  targetLevels: ["L1", "L2"],
  responsibilities: [
    "ast-parse",
    "symbol-resolution",
    "capability-and-coverage-reporting",
  ],
  designSource: "TŞ v2.1 §6, §7, §7.1, §25/4",
  status: "scaffold",
};
