/**
 * Wiki arama sorgu çekirdeği — TŞ v2.1 §16A.3, sprint-4 W4.
 *
 * Kullanıcı sorgusu → kaçışlı FTS5 MATCH ifadesi. Kaçış deseni Faz A'daki
 * kanıtlanmış uygulamadır (packages/storage-sqlite/src/sqlite-repository.ts,
 * searchSymbols): kullanıcı girdisi phrase ("...") sözdizimiyle sarmalanır
 * ve içteki çift tırnaklar ikiye katlanır; operatör/metakarakter metni
 * (`(`, `)`, `*`, `AND`, `OR`, `NEAR`, `:` ...) MATCH diline operatör
 * olarak KATILMAZ — ifade PARAMETRE olarak bağlanır (TŞ §16A.3 "FTS söz
 * dizimi escape'i zorunludur").
 *
 * Saf çekirdek: MCP türü import etmez; depo erişimi search-store.ts'tedir.
 */

/**
 * Sorgu normalizasyonu (TŞ §16A.3): baş/son boşluk atılır, iç boşluk
 * dizileri tek boşluğa iner. Deterministiktir; aynı girdi her zaman aynı
 * normalize değeri üretir. Unicode boşlukları `\s` ile kapsanır.
 */
export function normalizeWikiSearchQuery(rawQuery: string): string {
  if (typeof rawQuery !== "string") return "";
  // NUL and other C0/C1 control characters (and DEL) count as whitespace:
  // FTS5 parses the MATCH expression as a C string, so an embedded NUL would
  // end the phrase early and fail with an "unterminated string" error.
  let withoutControls = "";
  for (const ch of rawQuery) {
    const code = ch.charCodeAt(0);
    withoutControls += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return withoutControls.trim().replace(/\s+/gu, " ");
}

/**
 * Phrase kaçışı: içteki çift tırnak ikiye katlanır (`"a"b` → `a""b`).
 * Kaçışlanan metin `"..."`
 * içine gömüldüğünde FTS5 onu tek bir literal phrase olarak çözümler.
 */
export function escapeFtsPhrase(term: string): string {
  return term.replaceAll('"', '""');
}

/**
 * Normalize edilmiş sorguyu kaçışlı MATCH phrase ifadesine çevirir.
 * Örn. `orders` → `"orders"`; `x"y` → `"x""y"`; `"()*` → `"""()*"`.
 * ifade, hazırlanmış ifadede MATCH ? parametresi olarak bağlanır.
 */
export function buildWikiMatchExpression(normalizedQuery: string): string {
  return `"${escapeFtsPhrase(normalizedQuery)}"`;
}
