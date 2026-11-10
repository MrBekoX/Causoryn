/**
 * list-files.mjs için tip bildirimi: tip denetimi kapsamındaki test dosyası
 * (build-list-files.test.ts) bu modülü import eder; uygulama JavaScript'tir
 * ve yalnızca build script'i ile testler kullanır.
 */

/** UTF-16 kod birimi (codepoint) düzeninde karşılaştırıcı: host/locale'den bağımsız. */
export function compareCodepoint(a: string, b: string): number;

/**
 * Sıralı, deterministik dosya listesi (baseDir'e göreli, POSIX ayraçlı).
 * Sıralama codepoint düzenindedir — localeCompare kullanılmaz.
 */
export function listFiles(rootDir: string, baseDir?: string): string[];
