import { z } from "zod";

/**
 * E3 test durumu dürüstlüğü şemaları — sprint-6 E3 (TŞ v2.1 §10.4).
 *
 * TŞ §10.4 (PyMuPDF çıkarımı, s.11): "Test runner varsayılan kurulmaz veya
 * otomatik çalıştırılmaz. Host'un yaptığı test koşuları ancak
 * dosya/provenance veya açıkça verilen doğrulanabilir test raporuyla
 * observed olarak kaydedilebilir; iddia ile başarılı sayılmaz."
 *
 * Bu modülün sözleşmesi:
 * - OBSERVED_TEST_RUN_SCHEMA : host koşum kaydı GİRDİSİ — evidenceRef
 *   ZORUNLUDUR (dosya/provenance kanıt referansı); evidenceSha256 verilecekse
 *   64 küçük-büyük harfsiz hex olmalıdır; observedCount ≥ 1 (0 koşum
 *   observed olamaz). Kanıtsız koşum iddiası şemadan geçemez (fail-closed).
 * - TEST_RUN_STATUS_SCHEMA   : rapor ÇIKTISINDAKİ koşum durumu — tek nesne
 *   + superRefine (Zod refine): (1) observed ⇒ evidenceRef zorunlu;
 *   (2) not_run ⇒ koşum kanıtı/passed iddiası TAŞIYAMAZ; (3) passed
 *   iddiası yalnızca observed + kanıtlı + rapor sayıları gerçekten geçen
 *   (failedCount === 0 && passedCount ≥ 1) kayıtta mümkündür. Tip düzeyinde
 *   VerifyTestStatus ayrıca discriminated union'dır: not_run dalında
 *   passed/evidenceRef alanları DERLEYİCİ düzeyinde yoktur.
 *
 * Motor HİÇBİR KOŞULDA test çalıştırmaz: bu şemalar yalnızca host'un
 * beyan ettiği koşum kaydını doğrular; koşu üretmez, uydurmaz.
 */

/** 64 karakter küçük hex sha256 (kanıt dosyası karması). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * TŞ §20 kaynak bütçesi örüntüsü (wiki refs 200 tavanı ile aynı sayı):
 * observedTestRun.testNames/evidenceIds dizi tavanı. Güvenlik analisti
 * bulgusu: bağlanamayan her testNames üyesi rapor limitations'ına bir satır
 * eklediğinden sınırsız dizi raporu girdiyle orantılı büyütür; tavan şema
 * kapısında fail-closed engeller (sessiz kırpma yok — aşım açık reddedilir).
 */
export const OBSERVED_RUN_ARRAY_CEILING = 200;

/** Tavan aşım mesajı (şema reddinde deterministik gerekçe). */
const OBSERVED_RUN_ARRAY_CEILING_MESSAGE =
  "en fazla 200 üye (TŞ §20 kaynak bütçesi; girdiyle orantılı rapor büyümesi engellenir)";

/** Boş/blank redli non-boş string. */
const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "değer boş/blank olamaz",
  });

/**
 * Host koşum kaydı girdisi. ZORUNLU alan evidenceRef: kök-göreceli rapor
 * dosyası yolu (örn. "reports/vitest-summary.json") veya doğrulanabilir
 * test raporu referansı. evidenceSha256 verildiyse dosyanın gerçek
 * karmasıdır (dosya kanıtı: yol + hash). Şema tipi bilinçli olarak
 * annotasyonsuzdur: zod çıktı tipleri (mutable string[]) ObservedTestRun'ın
 * readonly sözleşmesiyle invariant uyuşmaz; yapısal uyum normalizeObservedRun
 * katmanında kurulur.
 */
export const OBSERVED_TEST_RUN_SCHEMA = z.strictObject({
  /** TŞ §10.4 koşum bloğu ayırıcısıyla aynı söz dağarcığı (`state`). */
  state: z.literal("observed"),
  evidenceRef: nonBlank,
  evidenceSha256: z
    .string()
    .regex(SHA256_HEX, "evidenceSha256 64 karakter küçük hex sha256 olmalı")
    .optional(),
  evidenceIds: z
    .array(nonBlank)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING, OBSERVED_RUN_ARRAY_CEILING_MESSAGE)
    .optional(),
  observedCount: z
    .number()
    .int("observedCount tam sayı olmalı")
    .min(1, "observedCount en az 1 olmalı; 0 koşum observed olamaz"),
  passedCount: z.number().int().min(0).optional(),
  failedCount: z.number().int().min(0).optional(),
  testNames: z
    .array(nonBlank)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING, OBSERVED_RUN_ARRAY_CEILING_MESSAGE)
    .optional(),
});

/**
 * Rapor çıktısındaki koşum durumu — Zod refine ile dürüstlük invariantları:
 * ayırıcı alan TŞ §10.4 örneğiyle birebir `state`'tir (PDF s.11: "tests":
 * {"state":"not_run",...}; sprint-6 takım denetimi hizalaması);
 * evidenceRef observed'da zorunlu; not_run kanıtsızdır; passed iddiası
 * yalnızca observed + gerçekten geçen rapor sayılarıyla mümkündür.
 */
export const TEST_RUN_STATUS_SCHEMA = z
  .strictObject({
    state: z.enum(["not_run", "observed"]),
    recommendedCount: z.number().int().min(0),
    observedCount: z.number().int().min(0),
    evidenceRef: nonBlank.optional(),
    evidenceSha256: z.string().regex(SHA256_HEX).optional(),
    evidenceIds: z.array(nonBlank).min(1).optional(),
    passed: z.literal(true).optional(),
    passedCount: z.number().int().min(0).optional(),
    failedCount: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.state === "observed") {
      if (value.evidenceRef === undefined || value.evidenceRef.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message:
            "observed koşum kanıtsız olamaz: evidenceRef zorunludur (dosya/provenance veya doğrulanabilir test raporu — TŞ §10.4)",
        });
      }
      if (value.observedCount < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["observedCount"],
          message: "observed koşumda observedCount en az 1 olmalı",
        });
      }
    } else {
      // not_run: koşum kanıtı ve sonuç iddiası TAŞIYAMAZ (tip düzeyinde de
      // yoktur — VerifyTestStatus not_run dalı).
      if (value.observedCount !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["observedCount"],
          message: "not_run koşumda observedCount 0 olmalı",
        });
      }
      if (value.evidenceRef !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceRef"],
          message: "not_run koşum kanıt referansı taşıyamaz",
        });
      }
      if (value.evidenceSha256 !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceSha256"],
          message: "not_run koşum kanıt karması taşıyamaz",
        });
      }
      if (value.evidenceIds !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceIds"],
          message: "not_run koşum kanıt kimliği taşıyamaz",
        });
      }
      if (value.passed !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message:
            "not_run koşumda 'passed' iddiası üretilemez (testler koşulmadı; iddia ile başarılı sayılmaz — TŞ §10.4)",
        });
      }
      if (value.passedCount !== undefined || value.failedCount !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passedCount"],
          message: "not_run koşumda rapor sayıları (passedCount/failedCount) olamaz",
        });
      }
    }
    // passed iddiası: yalnızca observed + kanıtlı + rapor gerçekten geçiyor.
    if (value.passed !== undefined) {
      if (value.state !== "observed") {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message: "'passed' iddiası yalnızca observed kayıtta mümkündür",
        });
      }
      if (
        value.passedCount === undefined ||
        value.failedCount === undefined ||
        value.failedCount !== 0 ||
        value.passedCount < 1
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message:
            "'passed' iddiası yalnızca rapor gerçekten geçiyorsa mümkündür (failedCount === 0 && passedCount ≥ 1)",
        });
      }
    }
  });

/** Zod sorunlarını deterministik, tek satırlık gerekçeye indirger. */
export function formatZodIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(kök)"}: ${issue.message}`,
    )
    .join("; ");
}
