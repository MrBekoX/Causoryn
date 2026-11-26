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
 * Work left for one ancestor-aware ignore decision, in matcher steps (one step per
 * inner-loop iteration of the segment matcher, plus one per automaton transition).
 * Shared by every pass that belongs to the same decision and decremented in place.
 */
export interface IgnoreMatchBudget {
  remaining: number;
}

/**
 * Steps one ignore pass may spend (Claude Security F32): one match of a path and
 * its ancestors against the rule set. WorkspaceAccessPolicy gives each pass of a
 * decision (lexical spelling, canonical real path, native long name) its own
 * budget, so a path reached through a link is not denied for needing two passes.
 * An ordinary configuration (the default list, or 1000 typical .gitignore lines
 * on a path 30 directories deep) needs well under half of it; a crafted pattern
 * set against a deep directory chain exhausts it in a few milliseconds and the
 * decision fails closed. Callers that run many decisions (the inventory) bound
 * their total separately.
 */
export const IGNORE_MATCH_WORK_BUDGET = 1_000_000;

/** Budget of the exported single-pattern helpers, which run without a cap. */
const UNBOUNDED: IgnoreMatchBudget = { remaining: Number.POSITIVE_INFINITY };

/**
 * Tek yol segmenti üzerinde `*` (0+ karakter) ve `?` (1 karakter) eşler.
 * İki işaretçili deterministik algoritma: O(|pattern| * |text|) üst sınırı,
 * O(1) bellek, sıfır RegExp, sıfır özyineleme (SEC-01). Her döngü adımı
 * `budget`tan düşülür; bütçe biterse eşleşme yok sayılır ve çağıran
 * `budget.remaining < 0` ile tükenmeyi ayırt eder.
 */
function matchSegment(pattern: string, text: string, budget: IgnoreMatchBudget = UNBOUNDED): boolean {
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;
  const pLen = pattern.length;
  const tLen = text.length;

  while (ti < tLen) {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      return false;
    }
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
  /**
   * `closureEnd[i]` = first index `j >= i` whose segment is not `**` (or the
   * segment count): from state `i`, letting each `**` match zero segments reaches
   * every state in `i..closureEnd[i]`.
   */
  readonly closureEnd: readonly number[];
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
  const closureEnd = new Array<number>(segments.length + 1);
  closureEnd[segments.length] = segments.length;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    closureEnd[index] = segments[index] === "**" ? (closureEnd[index + 1] as number) : index;
  }
  return {
    segments,
    dirOnly,
    anchored,
    closureEnd,
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

export type AncestorIgnoreMatch =
  | {
      readonly kind: "matched";
      /** The first matching pattern, as written. */
      readonly pattern: string;
      /** Number of `/` segments of the shortest matching ancestor (the path itself = all). */
      readonly depth: number;
    }
  | { readonly kind: "none" }
  /** The budget ran out before the decision was complete; callers fail closed. */
  | { readonly kind: "budget-exhausted" };

export interface AncestorIgnoreMatchOptions {
  readonly budget: IgnoreMatchBudget;
  /** Folds letter case of patterns and path; defaults to the platform rule (Windows only). */
  readonly caseInsensitive?: boolean;
  /**
   * Folds each path segment before matching, in place of plain lower-casing
   * (implies case-insensitive pattern compilation). See {@link lookAlikeFold}.
   */
  readonly foldSegment?: (segment: string) => string;
}

/**
 * Code points {@link lookAlikeFold} drops: combining marks, and default-ignorable
 * code points (zero-width joiner/space, soft hyphen, word joiner, BOM, variation
 * selectors...), which Linux casefold before 6.12 ignores when it compares names.
 */
const DROPPED_BY_LOOK_ALIKE_FOLD = /[\p{M}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Folds a path segment to the spelling a case-insensitive filesystem may treat it
 * as: compatibility decomposition (NFKD), combining marks and default-ignorable
 * code points dropped, and each character upper-cased then lower-cased. NTFS
 * compares names by upper-casing, so U+0131 (dotless i) and U+017F (long s) match
 * "i" and "s" there; JavaScript lower-casing alone keeps them apart. Used only for
 * the secret / VCS deny rules, where folding too much denies a look-alike name
 * (fail closed) and folding too little would allow one.
 */
export function lookAlikeFold(segment: string): string {
  let folded = "";
  for (const ch of segment.normalize("NFKD")) {
    if (DROPPED_BY_LOOK_ALIKE_FOLD.test(ch)) continue;
    folded += ch.toUpperCase().toLowerCase();
  }
  return folded;
}

/**
 * Default secret / VCS deny rules (TŞ §20) that are matched again, when they are
 * configured, with each segment folded by {@link lookAlikeFold} on every platform
 * (Claude Security F44). On a case-insensitive volume (WSL drvfs, ext4/f2fs
 * casefold, NTFS) `.GIT/config` opens `.git/config`, and so does `.gıt/config`
 * on NTFS, which upper-cases U+0131 to "I"; neither `fs.realpathSync` nor
 * `realpathSync.native` reports the on-disk spelling on drvfs. Other patterns keep
 * the platform's case rule.
 */
export const LOOK_ALIKE_DENY_PATTERNS: ReadonlySet<string> = new Set(["**/.git/**", "**/.env*", "**/*.pem"]);

/** One ignore decision over a fixed pattern list; see {@link compileIgnoreRuleSet}. */
export interface IgnoreRuleSet {
  /**
   * First rule matching `posixRelative` or any of its ancestors (shallowest first,
   * then pattern order); the last segment counts as a directory when
   * `lastIsDirectory`. Every step is charged to `budget`; `budget-exhausted` means
   * the caller must treat the path as ignored (fail closed).
   */
  match(posixRelative: string, lastIsDirectory: boolean, budget: IgnoreMatchBudget): AncestorIgnoreMatch;
}

/**
 * The ignore decision shared by WorkspaceAccessPolicy and every other path filter
 * that must agree with it (the history inventory): the patterns with the
 * platform's case rule, then the configured {@link LOOK_ALIKE_DENY_PATTERNS} again
 * with look-alike folding, both under the same budget.
 */
export function compileIgnoreRuleSet(patterns: readonly string[]): IgnoreRuleSet {
  const exactPatterns = [...patterns];
  const foldedPatterns = exactPatterns.filter((pattern) => LOOK_ALIKE_DENY_PATTERNS.has(pattern));
  return {
    match(posixRelative, lastIsDirectory, budget) {
      const exact = findFirstAncestorIgnoreMatch(posixRelative, lastIsDirectory, exactPatterns, { budget });
      if (exact.kind !== "none" || foldedPatterns.length === 0) {
        return exact;
      }
      return findFirstAncestorIgnoreMatch(posixRelative, lastIsDirectory, foldedPatterns, {
        budget,
        foldSegment: lookAlikeFold,
      });
    },
  };
}

/**
 * Matches `posixRelative` AND each of its ancestors against `patterns` in one pass
 * per pattern (Claude Security F32). The result is exactly that of calling
 * {@link findMatchingIgnorePattern} on every `/` prefix from the shallowest to the
 * full path (ancestors as directories, the last segment as a directory only when
 * `lastIsDirectory`) and taking the first hit, but each pattern walks the path
 * once: an anchored pattern runs as a set of automaton states over the segments
 * instead of being restarted for every prefix, so a pattern with many segments no
 * longer costs (prefixes × segments × backtracking).
 *
 * Every step is charged to `options.budget`; when it runs out the result is
 * `budget-exhausted` and the caller must treat the path as denied.
 */
export function findFirstAncestorIgnoreMatch(
  posixRelative: string,
  lastIsDirectory: boolean,
  patterns: readonly string[],
  options: AncestorIgnoreMatchOptions,
): AncestorIgnoreMatch {
  const foldSegment = options.foldSegment;
  const caseInsensitive = foldSegment !== undefined || (options.caseInsensitive ?? IS_WIN);
  const budget = options.budget;
  // The policy splits on `/`; the single-pattern matcher also treats `\` as a
  // separator inside each prefix. Tokens follow the matcher, checkpoints (the
  // prefixes that are actually decided) follow the `/` segments.
  const tokens: string[] = [];
  const checkpoints: number[] = [];
  for (const segment of posixRelative.split("/")) {
    const folded = foldSegment !== undefined ? foldSegment(segment) : caseInsensitive ? segment.toLowerCase() : segment;
    for (const token of toPosix(folded).split("/")) {
      tokens.push(token);
    }
    checkpoints.push(tokens.length);
  }
  const depthCount = checkpoints.length;
  let best: { readonly pattern: string; readonly depth: number } | undefined;
  for (const pattern of patterns) {
    // Only a shallower match can still change the answer: at the same depth the
    // earlier pattern wins, as in the per-prefix loop.
    const maxDepth = best === undefined ? depthCount : best.depth - 1;
    if (maxDepth < 1) {
      break;
    }
    const depth = shallowestMatchingDepth(
      compilePatternCached(pattern, caseInsensitive),
      tokens,
      checkpoints,
      maxDepth,
      lastIsDirectory,
      budget,
    );
    if (budget.remaining < 0) {
      return { kind: "budget-exhausted" };
    }
    if (depth !== undefined) {
      best = { pattern, depth };
    }
  }
  return best === undefined ? { kind: "none" } : { kind: "matched", pattern: best.pattern, depth: best.depth };
}

/** Shallowest checkpoint depth (1-based, at most `maxDepth`) at which `compiled` matches. */
function shallowestMatchingDepth(
  compiled: CompiledPattern,
  tokens: readonly string[],
  checkpoints: readonly number[],
  maxDepth: number,
  lastIsDirectory: boolean,
  budget: IgnoreMatchBudget,
): number | undefined {
  const depthCount = checkpoints.length;
  const isDirectoryAt = (depth: number): boolean => depth < depthCount || lastIsDirectory;
  if (!compiled.anchored) {
    const segment = compiled.segments[0];
    if (segment === undefined) {
      return undefined;
    }
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      if (compiled.dirOnly && !isDirectoryAt(depth)) {
        continue;
      }
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        return undefined;
      }
      // Basename of the prefix = its last token.
      if (segment === "**" || matchSegment(segment, tokens[(checkpoints[depth - 1] as number) - 1] as string, budget)) {
        return budget.remaining < 0 ? undefined : depth;
      }
      if (budget.remaining < 0) {
        return undefined;
      }
    }
    return undefined;
  }

  // Anchored: state `i` = the first `i` pattern segments match the tokens read so
  // far. `**` matches zero or more segments (closure), any other segment exactly
  // one. The active states are kept ascending and duplicate-free in two buffers
  // that are swapped per token.
  const patternSegments = compiled.segments;
  const closureEnd = compiled.closureEnd;
  const finalState = patternSegments.length;
  let current = new Int32Array(finalState + 1);
  let next = new Int32Array(finalState + 1);
  let currentLength = appendClosure(current, 0, 0, closureEnd);
  let depth = 1;
  const lastToken = checkpoints[maxDepth - 1] as number;
  for (let tokenIndex = 0; tokenIndex < lastToken; tokenIndex += 1) {
    const token = tokens[tokenIndex] as string;
    let nextLength = 0;
    for (let index = 0; index < currentLength; index += 1) {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        return undefined;
      }
      const state = current[index] as number;
      if (state >= finalState) {
        continue;
      }
      const patternSegment = patternSegments[state] as string;
      if (patternSegment === "**") {
        nextLength = appendClosure(next, nextLength, state, closureEnd);
      } else if (matchSegment(patternSegment, token, budget)) {
        nextLength = appendClosure(next, nextLength, state + 1, closureEnd);
      } else if (budget.remaining < 0) {
        return undefined;
      }
    }
    if (nextLength === 0) {
      return undefined; // no longer prefix can match either
    }
    const swap = current;
    current = next;
    next = swap;
    currentLength = nextLength;
    if (tokenIndex + 1 === checkpoints[depth - 1]) {
      const accepts = current[currentLength - 1] === finalState;
      if (accepts && !(compiled.dirOnly && !isDirectoryAt(depth))) {
        return depth;
      }
      depth += 1;
    }
  }
  return undefined;
}

/**
 * Appends the closure of `state` (`state..closureEnd[state]`) to the ascending,
 * duplicate-free `states[0..length)` and returns the new length. Callers pass
 * non-decreasing states, and `closureEnd` is monotone, so the result stays
 * ascending: only the part above the current last element is appended.
 */
function appendClosure(
  states: Int32Array,
  length: number,
  state: number,
  closureEnd: readonly number[],
): number {
  let from = state;
  if (length > 0 && (states[length - 1] as number) >= from) {
    from = (states[length - 1] as number) + 1;
  }
  let appended = length;
  const end = closureEnd[state] as number;
  for (let value = from; value <= end; value += 1) {
    states[appended] = value;
    appended += 1;
  }
  return appended;
}
