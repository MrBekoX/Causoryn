/**
 * Gitignore benzeri minimal desen eşleyici (TŞ v2.1 §20 workspace.ignore,
 * sprint-1 görev 2 "ignore kuralları").
 *
 * Desteklenen semantik (kasıtlı olarak küçük ve deterministik):
 * - `**`  : sıfır veya daha çok yol segmenti
 * - `*`   : segment içinde sıfır veya daha çok karakter (`/` geçmez)
 * - `?`   : segment içinde tek karakter (`/` geçmez)
 * - `/`   : baştaki veya içteki ayraç deseni kökçe (anchored) yapar
 * - sondaki `/` : deseni yalnızca dizinlerle eşler
 * - slash içermeyen desen basename ile her derinlikte eşleşir (gitignore gibi)
 *
 * Kasıtlı sapma (daha güvenli yönde): `X/**` deseni `X` konteyner dizininin
 * kendisiyle de eşleşir — TŞ §19'un secret sızıntısı (.git/, .env*) reddetme
 * hedefi gereği git'ten biraz daha muhafazakârdır.
 *
 * Güvenlik / karmaşıklık garantisi (SEC-01): RegExp motoru KULLANILMAZ.
 * İki işaretçili polinomik glob algoritması ile geri izleme patlaması (ReDoS)
 * yapısal olarak imkânsızdır; tüm RegExp meta karakterleri (`[`, `(`, `+`, `$`
 * vb.) doğal olarak literal eşlenir.
 *
 * Eşleme, Windows'ta dosya sistemi davranışıyla tutarlı olarak case-insensitive;
 * POSIX'te case-sensitive'dir (platform başına deterministik).
 */

const IS_WIN = process.platform === "win32";
const CHAR_STAR = 42; // '*'
const CHAR_QUESTION = 63; // '?'

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Tek yol segmenti üzerinde `*` (0+ karakter) ve `?` (1 karakter) eşler.
 * İki işaretçili deterministik algoritma: O(|pattern| * |text|) üst sınırı,
 * O(1) bellek, sıfır RegExp, sıfır özyineleme (SEC-01).
 */
function matchSegment(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;
  const pLen = pattern.length;
  const tLen = text.length;

  while (ti < tLen) {
    if (
      pi < pLen &&
      (pattern.charCodeAt(pi) === CHAR_QUESTION ||
        pattern.charCodeAt(pi) === text.charCodeAt(ti))
    ) {
      pi += 1;
      ti += 1;
    } else if (pi < pLen && pattern.charCodeAt(pi) === CHAR_STAR) {
      starIdx = pi;
      matchIdx = ti;
      pi += 1;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx += 1;
      ti = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pLen && pattern.charCodeAt(pi) === CHAR_STAR) {
    pi += 1;
  }

  return pi === pLen;
}

/**
 * Segment dizileri üzerinde `**` (0+ segment) ve segment-içi `*`/`?` eşler.
 * İki işaretçili polinomik algoritma: geri izleme patlaması yoktur (SEC-01).
 */
function matchSegments(
  patSegs: readonly string[],
  candSegs: readonly string[],
): boolean {
  let pi = 0;
  let ci = 0;
  let starIdx = -1;
  let matchIdx = 0;
  const pLen = patSegs.length;
  const cLen = candSegs.length;

  while (ci < cLen) {
    const pSeg = pi < pLen ? patSegs[pi] : undefined;
    if (pSeg === "**") {
      starIdx = pi;
      matchIdx = ci;
      pi += 1;
    } else if (pSeg !== undefined && matchSegment(pSeg, candSegs[ci] as string)) {
      pi += 1;
      ci += 1;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx += 1;
      ci = matchIdx;
    } else {
      return false;
    }
  }

  while (pi < pLen && patSegs[pi] === "**") {
    pi += 1;
  }

  return pi === pLen;
}

interface CompiledPattern {
  readonly segments: readonly string[];
  readonly dirOnly: boolean;
  readonly anchored: boolean;
}

function compilePattern(rawPattern: string, caseInsensitive: boolean): CompiledPattern {
  let p = toPosix(rawPattern);
  const dirOnly = p.endsWith("/");
  if (dirOnly) {
    p = p.slice(0, -1);
  }
  let anchored = p.startsWith("/");
  if (anchored) {
    p = p.slice(1);
  }
  if (!anchored && p.includes("/")) {
    anchored = true;
  }
  const normalized = caseInsensitive ? p.toLowerCase() : p;
  const rawSegments = normalized.split("/");
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "**" && segments[segments.length - 1] === "**") {
      continue;
    }
    segments.push(seg);
  }
  return {
    segments,
    dirOnly,
    anchored,
  };
}

/**
 * Derleme önbelleği (TŞ §21 performans hedefleri, SEC-05): aynı desen checkPath
 * başına (desen × ata derinliği) kez derlenir; önbellek bunu desen başına
 * bir keze indirger. Kapasite dolduğunda tüm önbelleği silmek (thrashing)
 * yerine yalnızca en eski tek anahtar çıkarılır (deterministik FIFO tavanı).
 */
const PATTERN_CACHE_CAP = 4_096;
const patternCache = new Map<string, CompiledPattern>();

function compilePatternCached(rawPattern: string, caseInsensitive: boolean): CompiledPattern {
  const key = (caseInsensitive ? "i\u0000" : "s\u0000") + rawPattern;
  const hit = patternCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const compiled = compilePattern(rawPattern, caseInsensitive);
  if (patternCache.size >= PATTERN_CACHE_CAP) {
    const oldestKey = patternCache.keys().next().value;
    if (oldestKey !== undefined) {
      patternCache.delete(oldestKey);
    }
  }
  patternCache.set(key, compiled);
  return compiled;
}

/**
 * Tek bir aday yol ile tek bir deseni karşılaştırır. `candidatePosixPath`
 * POSIX ayraçlı GÖRECELİ yol olmalıdır (kök içi). Ata dizin genişletmesi
 * çağıranın (politikanın) sorumluluğudur — bu fonksiyon yalnızca verilen
 * yolu desenle karşılaştırır.
 */
export function matchesIgnorePattern(
  candidatePosixPath: string,
  isDirectory: boolean,
  pattern: string,
): boolean {
  const caseInsensitive = IS_WIN;
  const normalized = toPosix(candidatePosixPath);
  const candidate = caseInsensitive ? normalized.toLowerCase() : normalized;
  const compiled = compilePatternCached(pattern, caseInsensitive);
  if (compiled.dirOnly && !isDirectory) {
    return false;
  }
  if (!compiled.anchored) {
    const seg = compiled.segments[0];
    if (seg === undefined) {
      return false;
    }
    if (seg === "**") {
      return true;
    }
    const basename = candidate.slice(candidate.lastIndexOf("/") + 1);
    return matchSegment(seg, basename);
  }
  return matchSegments(compiled.segments, candidate.split("/"));
}

/**
 * Aday yola uygulanan İLK deseni (orijinal yazımıyla) döndürür; eşleşme yoksa
 * undefined. Karar `patterns` dizisi sırasına göre deterministiktir.
 */
export function findMatchingIgnorePattern(
  candidatePosixPath: string,
  isDirectory: boolean,
  patterns: readonly string[],
): string | undefined {
  for (const pattern of patterns) {
    if (matchesIgnorePattern(candidatePosixPath, isDirectory, pattern)) {
      return pattern;
    }
  }
  return undefined;
}
