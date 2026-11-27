import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  compileIgnoreRuleSet,
  IGNORE_MATCH_WORK_BUDGET,
  type IgnoreMatchBudget,
  type IgnoreRuleSet,
} from "./ignore-matcher.js";
import {
  describeLinkInspectionFailure,
  describeWindowsPathSegmentIssue,
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  LINK_TARGET_INSPECTION_ENABLED,
  normalizeRootLevelAlias,
  pathCrossesLink,
  readRootLevelLinks,
  type PolicyEnvironment,
} from "./path-safety.js";
import {
  effectiveIgnorePatterns,
  parseWorkspacePolicyConfig,
  type WorkspacePolicyConfig,
} from "./policy-config.js";
import { WorkspacePolicyError, type PolicyErrorCode } from "./policy-error.js";

/**
 * WorkspaceAccessPolicy — Workspace Gateway'in erişim karar mercii
 * (TŞ v2.1 §5 WorkspaceAccess modülü, §9 "explicit izin olmadan indeksleme
 * başlamaz", §19 tehdit modeli, §25/2; sprint-1 görev 2).
 *
 * Karar sırası her aday için sabittir (determinizm, TŞ §6):
 *   1. kök yetkilendirmesi (önce leksik allowlist, sonra realpath canonicalization + allowlist)
 *   2. null byte reddi
 *   3. leksik `..`/mutlak yol sarmalama kontrolü (OWASP normalize)
 *   4. ignore kuralları (atalar dahil; geçiş başına iş bütçesi, aşımda red)
 *   5. realpath (symlink/junction) sarmalama kontrolü (CWE-59; TŞ §19)
 *   5b. kanonik gerçek yola ignore kurallarının YENİDEN uygulanması
 *       (kök-içi symlink'in secret-deny listini bypass etmesi engellenir)
 *   6. uzantı filtresi + boyut limiti (yalnızca checkFile)
 *
 * TŞ §19 "file handle sonrası path tekrar kontrolü" SÖZLEŞMESİ: bu sınıfın
 * kararları dosya açılışından ÖNCE üretilir; realpath ile check arasındaki
 * TOCTOU penceresi bu modülde kapatılamaz. Dosyayı açan katman (file
 * inventory / indexing) açma sonrası dosyanın gerçek yolunu bu politika
 * üzerinden YENİDEN denetlemek ZORUNDADIR — bu gereklilik downstream kabul
 * ölçütüdür ve backlog'a işlenmelidir (bkz. sprint görevleri).
 */

const IS_WIN = process.platform === "win32";

/**
 * Volumes that alias names (Windows 8.3 short names and letter case, macOS letter
 * case) need ignore rules re-applied to the native canonical long-name path:
 * `fs.realpathSync` keeps the spelling it was given (`GIT~1`, `.GIT`), while
 * `fs.realpathSync.native` reports the name stored on disk.
 */
const CHECK_NATIVE_NAME_ALIASES = IS_WIN || process.platform === "darwin";

/** Upper bound for the per-instance root caches (roots are few in practice). */
const ROOT_CACHE_CAP = 256;

/**
 * The one reason given for every root outside the declared allowRoots, whatever the
 * filesystem holds at that path (Claude Security F21: no existence/file-type oracle).
 */
const ROOT_NOT_DECLARED_REASON =
  "root is not inside a user-declared allowRoot (explicit authorization required)";

type IgnoreRuleOutcome =
  | { readonly kind: "matched"; readonly pattern: string }
  | { readonly kind: "none" }
  | { readonly kind: "budget-exhausted" };

const IGNORE_BUDGET_DENY_REASON =
  "ignore rule matching for this path exceeded its work budget; the path is denied (fail closed)";

function nativeRealpath(target: string): string {
  // Mocked `node:fs` modules may not carry `.native`; fall back to the JS realpath.
  const native = (realpathSync as { native?: (p: string) => string }).native;
  return typeof native === "function" ? native(target) : realpathSync(target);
}

function rememberBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= ROOT_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export type PolicyAllow = {
  readonly allowed: true;
  /** realpath ile çözümlenmiş, doğrulanmış kök. */
  readonly canonicalRoot: string;
  /** POSIX ayraçlı kök-göreceli yol; kök kendisi için ".". */
  readonly relativePath: string;
};

export type PolicyDeny = {
  readonly allowed: false;
  readonly code: PolicyErrorCode;
  readonly reason: string;
  /** Kararı üreten kural (ignore deseni, uzantı, "maxFileBytes"). */
  readonly rule?: string;
};

export type PolicyDecision = PolicyAllow | PolicyDeny;

/**
 * Accumulates the ignore-matching work of the decisions it is handed to, so a
 * caller that runs many decisions (the inventory) can bound their total
 * (Claude Security F32). The policy only adds to it.
 */
export interface IgnoreWorkMeter {
  /** Matcher steps spent, summed over every ignore pass of every decision. */
  steps: number;
  /** Decisions denied because one of their ignore passes ran out of its budget. */
  budgetDenials: number;
}

export interface PolicyCheckOptions {
  /** Receives the ignore-matching work of this decision. */
  readonly ignoreWork?: IgnoreWorkMeter;
}

function deny(code: PolicyErrorCode, reason: string, rule?: string): PolicyDeny {
  return rule === undefined ? { allowed: false, code, reason } : { allowed: false, code, reason, rule };
}

/** `\\?\C:\...` ve `\\?\UNC\srv\share` öneklerini karşılaştırılabilir forma indirger. */
function stripWin32DevicePrefix(p: string): string {
  if (!IS_WIN) return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** Sarmalama karşılaştırmaları için platform-normalize anahtar üretir. */
function comparablePath(p: string): string {
  const stripped = stripWin32DevicePrefix(p);
  return IS_WIN ? stripped.toLowerCase() : stripped;
}

/** `target`ın `root` altında (veya root ile aynı) olduğunu belirler. */
function isInside(root: string, target: string): boolean {
  const r = comparablePath(root);
  const t = comparablePath(target);
  if (t === r) return true;
  const boundary = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(boundary);
}

/** `paths` without repeats (compared like containment: case-folded on Windows), first spelling kept. */
function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = comparablePath(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPosixRelative(nativeRelative: string): string {
  const posix = nativeRelative.split(path.sep).join("/");
  return posix.length === 0 ? "." : posix;
}

/**
 * Boundary-duyarlı traversal kararı: `path.relative` çıktısında yalnızca
 * tam ".." segmenti veya "../" öneki kök dışına çıkıştır; "..foo" yasal bir
 * dosya/dizin adıdır ve reddedilmez (over-deny düzeltmesi, bypass değil).
 */
function isLexicalEscape(nativeRelative: string): boolean {
  return (
    nativeRelative === ".." ||
    nativeRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(nativeRelative)
  );
}

/** Windows-only lexical check shared by root and candidate paths. */
function windowsSegmentDeny(code: PolicyErrorCode, rawPath: string, label: string): PolicyDeny | undefined {
  if (!IS_WIN) return undefined;
  const finding = findWindowsUnsafePathSegment(rawPath);
  if (finding === undefined) return undefined;
  return deny(code, `${label}: ${describeWindowsPathSegmentIssue(finding)}`, `windows-${finding.issue}`);
}

export class WorkspaceAccessPolicy {
  private readonly canonicalRoots: readonly string[];
  private readonly ignorePatterns: readonly string[];
  /** The ignore decision (exact rules, then look-alike folded secret / VCS rules). */
  private readonly ignoreRules: IgnoreRuleSet;
  /**
   * Lexical forms of the declared allowRoots. Their components were inspected for
   * UNC/device link targets once, in the constructor (they are the user's own
   * configuration); paths below them are inspected again on every call.
   */
  private readonly declaredRoots: readonly string[];
  /** The filesystem root's own links (see {@link readRootLevelLinks}); empty on Windows. */
  private readonly rootLinks: ReadonlyMap<string, string>;
  /**
   * The authorized area for the lexical gate and the confined link walk: every
   * allowRoot in its declared and canonical forms, and both again with a leading
   * root-level link alias normalized (macOS `/var` -> `/private/var`).
   */
  private readonly areaRoots: readonly string[];
  /** canonicalRoot → native canonical (long-name, on-disk case) root. */
  private readonly nativeRoots = new Map<string, string>();

  private constructor(readonly config: WorkspacePolicyConfig, environment: PolicyEnvironment) {
    this.canonicalRoots = config.allowRoots.map((root) => {
      if (isUncOrDevicePath(root)) {
        throw new WorkspacePolicyError(
          "workspace/policy-invalid",
          `allowRoot must not be a UNC or Win32 device path (rejected before filesystem access): ${root}`,
        );
      }
      if (LINK_TARGET_INSPECTION_ENABLED) {
        const inspection = inspectLinkTargets(root);
        if (!inspection.ok) {
          throw new WorkspacePolicyError(
            "workspace/policy-invalid",
            `allowRoot is not usable (${root}): ${describeLinkInspectionFailure(inspection, { within: root })}`,
          );
        }
      }
      try {
        return realpathSync(root);
      } catch {
        // Beyan edilmiş ama diskte olmayan kök: leksik normalize formla tutulur;
        // authorizeRoot realpath doğrulaması gerektirdiği için yine reddeder.
        return path.resolve(root);
      }
    });
    this.declaredRoots = config.allowRoots.map((root) => path.resolve(root));
    // Read once, after the allowRoots were validated: public system configuration,
    // never anything derived from a caller's path.
    this.rootLinks = environment.rootLinks ?? (IS_WIN ? new Map<string, string>() : readRootLevelLinks());
    this.areaRoots = uniquePaths([
      ...this.declaredRoots,
      ...this.canonicalRoots,
      ...[...this.declaredRoots, ...this.canonicalRoots].map((root) => normalizeRootLevelAlias(root, this.rootLinks)),
    ]);
    this.ignorePatterns = effectiveIgnorePatterns(config);
    this.ignoreRules = compileIgnoreRuleSet(this.ignorePatterns);
  }

  /**
   * Şemayı doğrulayıp politikayı kurar; geçersiz config → POLICY_INVALID hatası.
   * `environment.rootLinks` replaces the filesystem root's links read at creation
   * (tests simulate another platform's layout with it).
   */
  static create(input: unknown, environment: PolicyEnvironment = {}): WorkspaceAccessPolicy {
    const parsed = parseWorkspacePolicyConfig(input);
    if (!parsed.ok) {
      throw new WorkspacePolicyError(
        parsed.code,
        `Invalid policy configuration (POLICY_INVALID): ${parsed.issues.join("; ")}`,
      );
    }
    return new WorkspaceAccessPolicy(parsed.config, environment);
  }

  /**
   * Kök yetkilendirmesi: yalnızca kullanıcının config'te beyan ettiği
   * allowRoot'lar (veya bunların alt dizinleri) kabul edilir; kök gerçek
   * yola (realpath) çözümlenemiyorsa ve bir dizin değilse reddedilir
   * (TŞ §20: MCP isteği tek başına kök ekleyemez).
   *
   * The decision is lexical first (Claude Security F21): a root that is not spelled
   * inside a declared allowRoot (its declared or its canonical form) is denied with
   * one fixed reason before any lstat/readlink/realpath/stat, so the caller learns
   * nothing about what exists outside the authorized area. Inside it, the real path
   * must stay inside an allowRoot before its type is reported.
   */
  authorizeRoot(rootPath: string): PolicyDecision {
    if (rootPath.length === 0) {
      return deny("workspace/root-not-authorized", "root path is empty");
    }
    if (rootPath.includes("\0")) {
      return deny("workspace/root-not-authorized", "root path contains a null byte");
    }
    if (isUncOrDevicePath(rootPath)) {
      return deny(
        "workspace/root-not-authorized",
        "root path must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    const aliasDeny = windowsSegmentDeny("workspace/root-not-authorized", rootPath, "root path is not usable");
    if (aliasDeny !== undefined) {
      return aliasDeny;
    }
    // Lexical gate: nothing below touches the filesystem for a root spelled outside
    // the declared area.
    const gate = this.lexicalAreaOf(path.resolve(rootPath));
    if (gate === undefined) {
      return deny("workspace/root-not-authorized", ROOT_NOT_DECLARED_REASON);
    }
    const { lexical: lexicalRoot, area: trustedStart } = gate;
    const linkDeny = this.inspectRootLinks(lexicalRoot, trustedStart);
    if (linkDeny !== undefined) {
      return linkDeny;
    }
    let canonical: string;
    try {
      canonical = realpathSync(lexicalRoot);
    } catch {
      // A root below a link that cannot be resolved (a dangling link planted in
      // the repository) gets the same answer as any root outside the allowRoots,
      // so the reason never tells whether a link target outside them exists.
      if (pathCrossesLink(lexicalRoot, trustedStart)) {
        return deny("workspace/root-not-authorized", ROOT_NOT_DECLARED_REASON);
      }
      return deny(
        "workspace/root-not-authorized",
        "root could not be resolved to a real path (missing or inaccessible); an unverifiable root cannot be trusted",
      );
    }
    // Containment before the type check: the type of a link target outside the
    // allowRoots is never reported.
    const declared = this.canonicalRoots.find((canonicalRoot) => isInside(canonicalRoot, canonical));
    if (declared === undefined) {
      return deny("workspace/root-not-authorized", ROOT_NOT_DECLARED_REASON);
    }
    let isDirectory = true;
    try {
      isDirectory = statSync(canonical).isDirectory();
    } catch {
      return deny("workspace/root-not-authorized", "root status could not be read");
    }
    if (!isDirectory) {
      return deny("workspace/root-not-authorized", "root is not a directory");
    }
    return { allowed: true, canonicalRoot: canonical, relativePath: "." };
  }

  /**
   * The allowRoot form (declared spelling first, then canonical, then both with a
   * root-level link alias normalized) that lexically contains `resolvedRoot`, tried
   * as spelled and then with its own leading root-level alias normalized (macOS
   * `/tmp/proj` against a declared `/private/tmp/proj`); undefined when none does.
   * Purely lexical: the root-link map was read at creation. `lexical` is the
   * spelling that matched, used for the filesystem steps that follow (it names the
   * same object, through the system's own root link). Every form is a trusted start
   * point for link inspection: the declared form was inspected in the constructor,
   * and the others are its resolved real-path forms.
   */
  private lexicalAreaOf(resolvedRoot: string): { readonly lexical: string; readonly area: string } | undefined {
    const normalized = normalizeRootLevelAlias(resolvedRoot, this.rootLinks);
    for (const lexical of normalized === resolvedRoot ? [resolvedRoot] : [resolvedRoot, normalized]) {
      const area = this.areaRoots.find((areaRoot) => isInside(areaRoot, lexical));
      if (area !== undefined) {
        return { lexical, area };
      }
    }
    return undefined;
  }

  /** Yol erişim kararı: yetki → null byte → traversal → ignore → symlink escape. */
  checkPath(rootPath: string, candidatePath: string, options: PolicyCheckOptions = {}): PolicyDecision {
    const meter = options.ignoreWork;
    const rootDecision = this.authorizeRoot(rootPath);
    if (!rootDecision.allowed) {
      return rootDecision;
    }
    if (candidatePath.includes("\0")) {
      return deny("workspace/path-denied", "candidate path contains a null byte (OWASP %00 bypass)");
    }
    if (isUncOrDevicePath(candidatePath)) {
      return deny(
        "workspace/path-denied",
        "candidate path must not be a UNC or Win32 device path (rejected before filesystem access)",
        "unc-or-device-path",
      );
    }
    // 2b) Windows name aliases: `a.pem::$DATA`, `a.pem.`, `a.pem ` and device names
    //     (NUL, CON, ...) would name a different object than the deny rules see.
    const aliasDeny = windowsSegmentDeny("workspace/path-denied", candidatePath, "candidate path is not usable");
    if (aliasDeny !== undefined) {
      return aliasDeny;
    }

    // 3) Leksik çözümleme: `..` ve mutlak yollar normalize edilir (OWASP: normalize before IO).
    //    `\\?\` aygıt önekleri path işlemlerinden ÖNCE sıyırılır (win32 path.resolve
    //    önekli yolu kökten farklı bir kimlik olarak görür).
    //    Üst dizini OS symlink'i olan yetkili köklerde (örn. macOS `/var` → `/private/var`),
    //    çağıranın verdiği `rootPath` altındaki mutlak aday yol önce `canonicalRoot`,
    //    gerekirse yetkili `lexicalRoot` üzerinden göreli çözülüp `canonicalRoot`'a
    //    bağlanır; ardından ignore + CWE-59 realpath containment aynı sıkılıkla koşar.
    const candidateNormalized = stripWin32DevicePrefix(candidatePath);
    let absolute = path.isAbsolute(candidateNormalized)
      ? path.resolve(candidateNormalized)
      : path.resolve(rootDecision.canonicalRoot, candidateNormalized);
    let relative = path.relative(rootDecision.canonicalRoot, absolute);
    if (isLexicalEscape(relative) && path.isAbsolute(candidateNormalized)) {
      const lexicalRoot = path.resolve(stripWin32DevicePrefix(rootPath));
      if (lexicalRoot !== rootDecision.canonicalRoot) {
        const relativeFromCallerRoot = path.relative(lexicalRoot, absolute);
        if (!isLexicalEscape(relativeFromCallerRoot)) {
          relative = relativeFromCallerRoot;
          absolute = path.resolve(rootDecision.canonicalRoot, relativeFromCallerRoot);
        }
      }
    }
    if (isLexicalEscape(relative)) {
      return deny(
        "workspace/path-denied",
        "candidate path escapes the root after lexical resolution (`..` traversal or a different root)",
        "..",
      );
    }

    // 3b) Links below the (already canonical) root whose target is a UNC/device path
    //     are rejected from lstat/readlink alone, before any stat/realpath follows them.
    if (LINK_TARGET_INSPECTION_ENABLED) {
      const inspection = inspectLinkTargets(absolute, { startDir: rootDecision.canonicalRoot });
      if (!inspection.ok) {
        return deny(
          "workspace/path-denied",
          `candidate path is not usable: ${describeLinkInspectionFailure(inspection, { within: rootDecision.canonicalRoot })}`,
          inspection.reason,
        );
      }
    }

    // 4) Ignore kuralları: dosyanın kendisi VE ata dizinleri değerlendirilir.
    //    Each ignore pass has its own work budget (F32).
    const lexicalPosix = toPosixRelative(relative);
    if (lexicalPosix !== ".") {
      const outcome = this.matchIgnoreRules(lexicalPosix, absolute, meter);
      if (outcome.kind === "budget-exhausted") {
        return deny("workspace/path-denied", IGNORE_BUDGET_DENY_REASON, "ignore-match-budget");
      }
      if (outcome.kind === "matched") {
        return deny("workspace/path-denied", "candidate path matches an ignore rule", outcome.pattern);
      }
    }

    // 5) Symlink/junction escape: gerçek yol kök sarmalanmış mı? (CWE-59, TŞ §19)
    const resolved = this.resolveRealpath(absolute);
    if (resolved === undefined) {
      return deny("workspace/path-denied", "the real path of the candidate could not be resolved");
    }
    if (!isInside(rootDecision.canonicalRoot, resolved)) {
      return deny(
        "workspace/path-denied",
        "the real path of the candidate (symlink/junction) escapes the root",
        "realpath-containment",
      );
    }
    // 5b) Kanonik gerçek yola ignore re-check (TŞ §19 secret exclusion):
    // kök içine işaret eden bir junction/symlink, leksik adıyla ignore
    // deny-list'ini BYPASS edemez — gerçek hedef yolu (ve atalarını) aynı
    // kurallara tabidir (örn. link → .git, '.git/HEAD' gibi reddedilir).
    const canonicalRelative = path.relative(rootDecision.canonicalRoot, resolved);
    const canonicalPosix = toPosixRelative(canonicalRelative);
    if (canonicalPosix !== "." && canonicalPosix !== lexicalPosix) {
      const outcome = this.matchIgnoreRules(canonicalPosix, resolved, meter);
      if (outcome.kind === "budget-exhausted") {
        return deny("workspace/path-denied", IGNORE_BUDGET_DENY_REASON, "ignore-match-budget");
      }
      if (outcome.kind === "matched") {
        return deny(
          "workspace/path-denied",
          "the canonical real path matches an ignore rule (ignore bypass through a symlink was blocked)",
          outcome.pattern,
        );
      }
    }
    // 5c) Native long-name re-check: an 8.3 short name (`GIT~1`) or a letter-case
    //     alias survives `realpathSync` unchanged; the native real path expands it
    //     to the stored name, so ignore rules see `.git` and containment is
    //     verified on the same canonical form.
    if (CHECK_NATIVE_NAME_ALIASES) {
      const nativeDeny = this.checkNativeNameAliases(
        rootDecision.canonicalRoot,
        absolute,
        canonicalPosix,
        meter,
      );
      if (nativeDeny !== undefined) {
        return nativeDeny;
      }
    }
    // Dönen relativePath canonical'dır: kök içine işaret eden symlink'in
    // gerçek hedefi raporlanır (inventory gerçek dosyayı okur).
    return {
      allowed: true,
      canonicalRoot: rootDecision.canonicalRoot,
      relativePath: canonicalPosix,
    };
  }

  /**
   * Dosya erişim kararı: checkPath + uzantı filtresi + boyut limiti.
   * `sizeBytes` verilmezse mevcut dosyanın gerçek boyutu okunur; dosya yoksa
   * boyut adımı atlanır (planlanan dosya yalnızca yol kurallarına tabidir).
   */
  checkFile(
    rootPath: string,
    candidatePath: string,
    sizeBytes?: number,
    options: PolicyCheckOptions = {},
  ): PolicyDecision {
    // Girdi doğrulaması (config'in aksine bu bir runtime argümanıdır):
    // NaN/Infinity, `NaN > maxFileBytes === false` olduğundan boyut limitini
    // SESSİZCE geçebilirdi — deterministik red zorunludur.
    if (sizeBytes !== undefined && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
      return deny(
        "workspace/path-denied",
        "invalid sizeBytes: a finite, non-negative number is expected",
        "sizeBytes",
      );
    }
    const decision = this.checkPath(rootPath, candidatePath, options);
    if (!decision.allowed) {
      return decision;
    }

    // 6a) Uzantı filtresi (binary kara liste / beyaz liste).
    const extension = path.extname(decision.relativePath).toLowerCase();
    if (this.config.extensionFilterMode === "blacklist") {
      if (extension !== "" && this.config.binaryExtensions.includes(extension)) {
        return deny(
          "workspace/path-denied",
          `extension is on the binary blacklist: ${extension}`,
          extension,
        );
      }
    } else {
      const allowed = this.config.allowedExtensions.includes(extension);
      if (!allowed) {
        return deny(
          "workspace/path-denied",
          extension === "" ? "files without an extension are not allowed in whitelist mode" : `extension is not in the whitelist: ${extension}`,
          extension === "" ? "(no extension)" : extension,
        );
      }
    }

    // 6b) Boyut limiti (TŞ §19 kaynak tüketimi; §20 index.maxFileBytes).
    let effectiveSize = sizeBytes;
    if (effectiveSize === undefined) {
      const statTarget =
        decision.relativePath === "." ? decision.canonicalRoot : path.resolve(decision.canonicalRoot, decision.relativePath);
      effectiveSize = this.readFileBytesIfFile(statTarget);
    }
    if (effectiveSize !== undefined && effectiveSize > this.config.maxFileBytes) {
      return deny(
        "workspace/limit-exceeded",
        `file size (${String(effectiveSize)} bytes) exceeds the maxFileBytes limit (${String(this.config.maxFileBytes)})`,
        "maxFileBytes",
      );
    }
    return decision;
  }

  /**
   * First ignore rule matching `posixRelative` or any of its ancestors (shallowest
   * ancestor first, then pattern order); the last segment is treated as a directory
   * unless `absoluteForFileCheck` is a file. All ancestors are matched in one pass
   * under a budget of its own (F32), whose spending is added to `meter`. The
   * configured secret / VCS deny rules are then matched again with look-alike
   * folding (F44).
   */
  private matchIgnoreRules(
    posixRelative: string,
    absoluteForFileCheck: string,
    meter: IgnoreWorkMeter | undefined,
  ): IgnoreRuleOutcome {
    const lastIsDirectory = !this.existsAsFile(absoluteForFileCheck);
    const budget: IgnoreMatchBudget = { remaining: IGNORE_MATCH_WORK_BUDGET };
    const outcome = this.ignoreRules.match(posixRelative, lastIsDirectory, budget);
    if (meter !== undefined) {
      meter.steps += IGNORE_MATCH_WORK_BUDGET - budget.remaining;
      if (outcome.kind === "budget-exhausted") {
        meter.budgetDenials += 1;
      }
    }
    return outcome;
  }

  /**
   * Inspects the components of a root path for UNC/device link targets before the
   * first realpath/stat. Nothing is cached: a component below a declared allowRoot
   * may change between calls, so it is inspected on every call. The walk starts at
   * `trustedStart`, the allowRoot form that lexically contains the root (roots
   * spelled outside every allowRoot never get here), and never follows a link out
   * of the allowRoots: such a root gets the same answer as any root outside them,
   * whatever the chain leads to (F21). The denial names a link path only inside
   * `trustedStart`, never a link target (F42).
   */
  private inspectRootLinks(lexicalRoot: string, trustedStart: string): PolicyDeny | undefined {
    if (!LINK_TARGET_INSPECTION_ENABLED) {
      return undefined;
    }
    const inspection = inspectLinkTargets(lexicalRoot, {
      startDir: trustedStart,
      confineTo: this.areaRoots,
    });
    if (!inspection.ok && inspection.reason === "link-leaves-area") {
      return deny("workspace/root-not-authorized", ROOT_NOT_DECLARED_REASON);
    }
    if (!inspection.ok) {
      return deny(
        "workspace/root-not-authorized",
        `root path is not usable: ${describeLinkInspectionFailure(inspection, { within: trustedStart })}`,
        inspection.reason,
      );
    }
    return undefined;
  }

  /** Native canonical form of an authorized canonical root (cached per instance). */
  private nativeRootOf(canonicalRoot: string): string | undefined {
    const cached = this.nativeRoots.get(canonicalRoot);
    if (cached !== undefined) {
      return cached;
    }
    let nativeRoot: string;
    try {
      nativeRoot = nativeRealpath(canonicalRoot);
    } catch {
      return undefined;
    }
    rememberBounded(this.nativeRoots, canonicalRoot, nativeRoot);
    return nativeRoot;
  }

  private checkNativeNameAliases(
    canonicalRoot: string,
    absolute: string,
    canonicalPosix: string,
    meter: IgnoreWorkMeter | undefined,
  ): PolicyDeny | undefined {
    const nativeRoot = this.nativeRootOf(canonicalRoot);
    const nativeResolved = this.resolveRealpath(absolute, nativeRealpath);
    if (nativeRoot === undefined || nativeResolved === undefined) {
      return deny(
        "workspace/path-denied",
        "the native canonical path of the candidate could not be resolved",
        "native-realpath",
      );
    }
    if (!isInside(nativeRoot, nativeResolved)) {
      return deny(
        "workspace/path-denied",
        "the native canonical path of the candidate escapes the root",
        "realpath-containment",
      );
    }
    const nativePosix = toPosixRelative(path.relative(nativeRoot, nativeResolved));
    if (nativePosix === "." || comparablePath(nativePosix) === comparablePath(canonicalPosix)) {
      return undefined;
    }
    const outcome = this.matchIgnoreRules(nativePosix, nativeResolved, meter);
    if (outcome.kind === "budget-exhausted") {
      return deny("workspace/path-denied", IGNORE_BUDGET_DENY_REASON, "ignore-match-budget");
    }
    if (outcome.kind === "none") {
      return undefined;
    }
    return deny(
      "workspace/path-denied",
      "the native canonical long-name path matches an ignore rule (a short-name or letter-case alias was blocked)",
      outcome.pattern,
    );
  }

  private existsAsFile(absolutePath: string): boolean {
    try {
      return statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  }

  private readFileBytesIfFile(absolutePath: string): number | undefined {
    try {
      const st = statSync(absolutePath);
      return st.isFile() ? st.size : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * realpath çözümlemesi: aday varsa kendisi; yoksa en derin mevcut atanın
   * gerçek yolu + kalan segmentler (henüz var olmayan planlanan dosya,
   * symlink'li ata üzerinden kaçışa yine kapatıktır — CWE-59).
   */
  private resolveRealpath(
    absolutePath: string,
    realpath: (target: string) => string = realpathSync,
  ): string | undefined {
    try {
      return realpath(absolutePath);
    } catch {
      // yok: ata zincirinde ilerle
    }
    let prefix = absolutePath;
    const missing: string[] = [];
    for (;;) {
      const parent = path.dirname(prefix);
      const base = path.basename(prefix);
      if (parent === prefix) {
        return undefined; // dosya sistemi köküne ulaşıldı, hiçbir ata çözümlenemedi
      }
      missing.unshift(base);
      prefix = parent;
      try {
        return path.join(realpath(prefix), ...missing);
      } catch {
        // ata da yok: zincire devam
      }
    }
  }
}
