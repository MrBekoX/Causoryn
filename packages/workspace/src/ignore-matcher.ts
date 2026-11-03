/**
 * Gitignore benzeri minimal desen eşleyici (TŞ v2.1 §20 workspace.ignore,
 * sprint-1 görev 2 "ignore kuralları").
 *
 * Desteklenen semantik (kasıtlı olarak küçük ve deterministik):
 * - `**`  : bir veya birden çok yol segmenti (öndeki `**` sıfır segment de olabilir)
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
 * Eşleme, Windows'ta dosya sistemi davranışıyla tutarlı olarak case-insensitive;
 * POSIX'te case-sensitive'dir (platform başına deterministik).
 */

const IS_WIN = process.platform === "win32";

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function escapeSegmentChars(segment: string): string {
  let out = "";
  let starRun = false;
  for (const ch of segment) {
    if (ch === "*") {
      if (!starRun) {
        out += "[^/]*";
        starRun = true;
      }
      continue;
    }
    starRun = false;
    if (ch === "?") {
      out += "[^/]";
    } else if ("\\.+^$|()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

interface CompiledPattern {
  readonly regex: RegExp;
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
  const segments = p.split("/");
  let re = "^";
  // Ayraç muhasebesi: `**` grupları kendi ayraçlarını taşır:
  // - öndeki **  -> "(?:[^/]+/)*" (her tekrarın sonunda "/" var) → sonraki token "/" EKLEMEZ
  // - ortadaki ** -> "(?:/[^/]+)*" (her tekrarın başında "/" var) → sonraki token "/" EKLER
  let pendingSlash: "none" | "required" = "required";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === undefined) continue; // split boş segment üretmez; noUncheckedIndexedAccess daralması
    const last = i === segments.length - 1;
    if (seg === "**") {
      if (i === 0 && last) {
        re += ".*"; // yalnız `**`: her şeyi eşle
        pendingSlash = "required";
        continue;
      }
      if (i === 0) {
        re += "(?:[^/]+/)*"; // öndeki ** ayracı yutar; sıfır segment de olabilir
        pendingSlash = "none";
        continue;
      }
      if (last) {
        re += pendingSlash === "none" ? ".*" : "(?:/.*)?"; // sondaki /** : konteyner dizin ve tüm içeriği
        pendingSlash = "required";
        continue;
      }
      re += "(?:/[^/]+)*"; // ortadaki ** : sıfır veya daha çok "/segment"
      pendingSlash = "required";
      continue;
    }
    // Literal segment: önceki token ayacı yuttuysa öneksiz, aksi hâlde "/" önekli.
    re += (i > 0 && pendingSlash === "required" ? "/" : "") + escapeSegmentChars(seg);
    pendingSlash = "required";
  }
  re += "$";
  return {
    regex: new RegExp(re, caseInsensitive ? "i" : ""),
    dirOnly,
    anchored,
  };
}

/**
 * Derleme önbelleği (TŞ §21 performans hedefleri): aynı desen checkPath
 * başına (desen × ata derinliği) kez derlenir; önbellek bunu desen başına
 * bir keze indirger. Saf fonksiyon olduğundan davranış değişmez; sınır
 * aşımında temizlenir (bellek tavanı, kararlar yine deterministik).
 */
const PATTERN_CACHE_CAP = 1000;
const patternCache = new Map<string, CompiledPattern>();

function compilePatternCached(rawPattern: string, caseInsensitive: boolean): CompiledPattern {
  const key = (caseInsensitive ? "i\u0000" : "s\u0000") + rawPattern;
  const hit = patternCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const compiled = compilePattern(rawPattern, caseInsensitive);
  if (patternCache.size >= PATTERN_CACHE_CAP) {
    patternCache.clear();
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
  const target = compiled.anchored ? candidate : candidate.slice(candidate.lastIndexOf("/") + 1);
  return compiled.regex.test(target);
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
