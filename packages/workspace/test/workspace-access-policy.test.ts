import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WorkspaceAccessPolicy test üçlüleri (TŞ v2.1 §19, §20, §25/2; sprint-1 görev 2).
 *
 * Her özellik için: pozitif (yetkili erişim kabul), negatif (yetkisiz kök,
 * ../ traversal, symlink kök dışına, aşırı büyük dosya, binary uzantı) ve
 * partial (edge case) testler. Testler depoya YAZMAZ (ADR-008): tüm fixture
 * dizinleri os.tmpdir() altında mkdtemp ile üretilir ve afterEach'de silinir.
 *
 * Windows ayrıntıları (TŞ §19 "Workspace dışına ../, symlink, junction, UNC
 * kaçışı → Realpath canonicalization, allowlist"): junction'lar ayrıcalık
 * gerektirmez; dosya symlink'i ayrıcalık gerektirebildiğinden yeteneği
 * yoklanır ve yoksa test atlanır (atlanan test raporda açıkça belirtilir).
 */

import {
  DEFAULT_BINARY_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_MAX_FILE_BYTES,
  WorkspaceAccessPolicy,
  WorkspacePolicyError,
  matchesIgnorePattern,
  parseWorkspacePolicyConfig,
} from "../src/index.js";
import type { PolicyDecision } from "../src/index.js";

const IS_WIN = process.platform === "win32";

/* ------------------------------------------------------------------ */
/* Test yardımcıları                                                   */
/* ------------------------------------------------------------------ */

let tempSeq = 0;

function makeRoot(): string {
  tempSeq += 1;
  return mkdtempSync(path.join(tmpdir(), `causoryn-wsp-${String(tempSeq).padStart(3, "0")}-`));
}

/** Standart fixture ağacı: temiz dosyalar + ignore edilecek + binary + büyük. */
function seedFixture(root: string): void {
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(root, "src", "code.ts"), "export const x = 1;\n");
  writeFileSync(path.join(root, "src", "deep", "nested.ts"), "export const y = 2;\n");
  writeFileSync(path.join(root, "README"), "extensionless\n");
  writeFileSync(path.join(root, "notes.md"), "# notes\n");
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(root, ".env.local"), "SECRET=1\n");
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  writeFileSync(path.join(root, "secrets", "key.pem"), "-----BEGIN\n");
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "bundle.js"), "var b=1;\n");
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "assets", "logo.png"), "PNGDATA");
  writeFileSync(path.join(root, "src", "big.ts"), "x".repeat(64));
}

/** Yetkili tek köklü politika; ek config ile override edilebilir. */
function policyFor(root: string, extra: Record<string, unknown> = {}): WorkspaceAccessPolicy {
  return WorkspaceAccessPolicy.create({ allowRoots: [root], ...extra });
}

function expectAllowed(decision: PolicyDecision): { relativePath: string } {
  if (!decision.allowed) {
    throw new Error(`izin beklenmişti ama reddedildi: ${decision.code} — ${decision.reason}`);
  }
  return { relativePath: decision.relativePath };
}

function denyOf(decision: PolicyDecision): { code: string; reason: string; rule?: string } {
  if (decision.allowed) {
    throw new Error(`red beklenmişti ama izin verildi: ${decision.relativePath}`);
  }
  return decision.rule === undefined
    ? { code: decision.code, reason: decision.reason }
    : { code: decision.code, reason: decision.reason, rule: decision.rule };
}

/** Dosya symlink'i oluşturma ayrıcalığı yoklanır (Windows: admin/Dev Mode). */
const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "causoryn-wsp-probe-"));
  try {
    const target = path.join(probeDir, "t.txt");
    writeFileSync(target, "probe");
    const link = path.join(probeDir, "l.txt");
    symlinkSync(target, link, "file");
    return readFileSync(link, "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

/* ------------------------------------------------------------------ */
/* 1) Policy konfigürasyon şeması (Zod)                                */
/* ------------------------------------------------------------------ */

describe("policy konfigürasyon şeması (Zod, TŞ §20)", () => {
  it("pozitif: boş input → güvenli varsayılanlar (allowRoots=[], TŞ §20 default ignore + maxFileBytes)", () => {
    const parsed = parseWorkspacePolicyConfig({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.allowRoots).toEqual([]);
    expect(parsed.config.ignore).toEqual(DEFAULT_IGNORE_PATTERNS);
    expect(parsed.config.extraIgnore).toEqual([]);
    expect(parsed.config.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(2_000_000); // TŞ §20 index.maxFileBytes
    expect(parsed.config.extensionFilterMode).toBe("blacklist");
    expect(parsed.config.binaryExtensions).toEqual(DEFAULT_BINARY_EXTENSIONS);
    expect(parsed.config.allowedExtensions).toEqual([]);
    // TŞ §20 default ignore listesi bire bir:
    for (const p of ["**/.git/**", "**/node_modules/**", "**/bin/**", "**/obj/**", "**/dist/**", "**/.env*", "**/*.pem"]) {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(p);
    }
  });

  it("negatif: bilinmeyen alan strict şemada reddedilir → POLICY_INVALID", () => {
    const parsed = parseWorkspacePolicyConfig({ allowRoots: [], unknownField: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("workspace/policy-invalid");
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("negatif: maxFileBytes 0 veya negatif veya tam sayı değil → POLICY_INVALID", () => {
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const parsed = parseWorkspacePolicyConfig({ maxFileBytes: bad });
      expect(parsed.ok, `maxFileBytes=${String(bad)} kabul edilmemeli`).toBe(false);
    }
  });

  it("negatif: boş string veya null-byte içeren allowRoot → POLICY_INVALID", () => {
    expect(parseWorkspacePolicyConfig({ allowRoots: [""] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["D:\\repo\u0000evil"] }).ok).toBe(false);
  });

  it("negatif: göreli allowRoot reddedilir (CWD'ye bağımlı kök deterministik değildir, TŞ §6)", () => {
    expect(parseWorkspacePolicyConfig({ allowRoots: ["repo"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["./repo"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["../repo"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["C:drive-relative"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowRoots: ["D:\\mutlak\\kok"] }).ok).toBe(true);
  });

  it("partial: ignore override edilir, extraIgnore eklenir", () => {
    const parsed = parseWorkspacePolicyConfig({ ignore: ["**/vendor/**"], extraIgnore: ["**/*.min.js"] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.ignore).toEqual(["**/vendor/**"]);
    expect(parsed.config.extraIgnore).toEqual(["**/*.min.js"]);
  });

  it("partial: whitelist modu + allowedExtensions kabul edilir", () => {
    const parsed = parseWorkspacePolicyConfig({
      extensionFilterMode: "whitelist",
      allowedExtensions: [".ts", ".js"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.extensionFilterMode).toBe("whitelist");
    expect(parsed.config.allowedExtensions).toEqual([".ts", ".js"]);
  });

  it("negatif: geçersiz uzantı biçimi (nokta öneksiz) → POLICY_INVALID", () => {
    expect(parseWorkspacePolicyConfig({ binaryExtensions: ["png"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowedExtensions: [".ts", ""] }).ok).toBe(false);
  });
});

describe("WorkspaceAccessPolicy.create (POLICY_INVALID eşlemesi)", () => {
  it("negatif: geçersiz config → WorkspacePolicyError (workspace/policy-invalid)", () => {
    expect(() => WorkspaceAccessPolicy.create({ maxFileBytes: -5 })).toThrowError(WorkspacePolicyError);
    try {
      WorkspaceAccessPolicy.create({ boyleBirAlan: 1 });
      throw new Error("WorkspacePolicyError beklenmişti ama fırlatılmadı");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspacePolicyError);
      expect((err as WorkspacePolicyError).code).toBe("workspace/policy-invalid");
    }
  });

  it("pozitif: config donuk (frozen) döner, sonraki değişiklik politika kararını bozmaz", () => {
    const cfg = { allowRoots: [makeRoot()] } as Record<string, unknown>;
    const policy = WorkspaceAccessPolicy.create(cfg);
    expect(Object.isFrozen(policy.config)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2) Explicit root authorization (varsayılan reddet)                  */
/* ------------------------------------------------------------------ */

describe("explicit root authorization (TŞ §9/§20, ADR-008)", () => {
  it("negatif: allowRoots boşken (varsayılan) HİÇBİR kök yetkilendirilmez", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = WorkspaceAccessPolicy.create({});
    expect(denyOf(policy.authorizeRoot(root)).code).toBe("workspace/root-not-authorized");
    expect(denyOf(policy.checkPath(root, "src/code.ts")).code).toBe("workspace/root-not-authorized");
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: beyan edilen kök yetkilendirilir ve canonical realpath döner", () => {
    const root = makeRoot();
    const policy = policyFor(root);
    const decision = policy.authorizeRoot(root);
    const allowed = expectAllowed(decision);
    expect(allowed.relativePath).toBe(".");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: beyan edilmemiş kök reddedilir (MCP isteği tek başına kök ekleyemez, TŞ §20)", () => {
    const root = makeRoot();
    const other = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(denyOf(policy.authorizeRoot(other)).code).toBe("workspace/root-not-authorized");
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it("negatif: var olmayan kök reddedilir (realpath doğrulanamayan kök güven kaynağı olamaz)", () => {
    const root = makeRoot();
    const ghost = path.join(root, "yok-boyle-dizin");
    const policy = policyFor(ghost);
    expect(denyOf(policy.authorizeRoot(ghost)).code).toBe("workspace/root-not-authorized");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: yetkisiz kökle checkPath çağrısı root-not-authorized döner (path kontrolüne hiç girilmez)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    const other = makeRoot();
    mkdirSync(path.join(other, "src"), { recursive: true });
    writeFileSync(path.join(other, "src", "code.ts"), "export const z = 3;\n");
    expect(denyOf(policy.checkPath(other, "src/code.ts")).code).toBe("workspace/root-not-authorized");
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 3) Path traversal ve null byte (OWASP Path Traversal)               */
/* ------------------------------------------------------------------ */

describe("path traversal koruması (OWASP Path Traversal, TŞ §19)", () => {
  it("pozitif: yetkili kök altındaki dosya kabul edilir ve POSIX relativePath döner", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "src/code.ts")).relativePath).toBe("src/code.ts");
    expect(expectAllowed(policy.checkPath(root, "src/deep/nested.ts")).relativePath).toBe("src/deep/nested.ts");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: '../' ile kök dışına çıkış reddedilir (PATH_DENIED)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, "../outside.txt")).code).toBe("workspace/path-denied");
    expect(denyOf(policy.checkPath(root, "src/../../../outside.txt")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: kök dışına mutlak yol reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const outside = makeRoot();
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, path.join(outside, "secret.txt"))).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("negatif: null byte içeren yol reddedilir (OWASP %00 bypass)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, "src/code.ts\u0000.png")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: kök içine geri dönen '..' çözümlemesi izinlidir (src/../src/code.ts)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "src/../src/code.ts")).relativePath).toBe("src/code.ts");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: kök kendisi ('.') izinlidir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkPath(root, "."));
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: kök altındaki mutlak yol kabul edilir (resolve sonrası kök içinde)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkPath(root, path.join(root, "src", "code.ts")));
    rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 4) Symlink escape koruması (CWE-59; TŞ §19 junction/symlink kaçışı) */
/* ------------------------------------------------------------------ */

describe("symlink escape koruması (CWE-59, TŞ §19)", () => {
  it("negatif: junction kök dışındaki dizine işaret ederse erişim reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const outside = makeRoot();
    mkdirSync(path.join(outside, "vault"), { recursive: true });
    writeFileSync(path.join(outside, "vault", "secret.txt"), "gizli\n");
    const junction = path.join(root, "link-out");
    symlinkSync(path.join(outside, "vault"), junction, "junction");
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, "link-out/secret.txt")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("negatif: symlink'in kendisi dosya olsa da kök dışına çıkarsa reddedilir", { skip: !CAN_CREATE_FILE_SYMLINK }, () => {
    const root = makeRoot();
    seedFixture(root);
    const outside = makeRoot();
    writeFileSync(path.join(outside, "secret.txt"), "gizli\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"), "file");
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, "leak.txt")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("partial: kök içine işaret eden junction İZİNLİDİR (görev tanımındaki edge case)", () => {
    const root = makeRoot();
    seedFixture(root);
    symlinkSync(path.join(root, "src"), path.join(root, "link-in"), "junction");
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "link-in/code.ts")).relativePath).toBe("src/code.ts");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: olmayan hedef yolunda en derin mevcut ata gerçek yoluyla denetlenir", () => {
    const root = makeRoot();
    seedFixture(root);
    const outside = makeRoot();
    const junction = path.join(root, "link-future");
    symlinkSync(outside, junction, "junction");
    const policy = policyFor(root);
    // link-future kök dışına çıkıyor; altındaki henüz var olmayan dosya da reddedilmeli.
    expect(denyOf(policy.checkPath(root, "link-future/not-created-yet.ts")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 5) Windows yol davranışı (case-insensitive, \\?\, karışık ayraç)    */
/* ------------------------------------------------------------------ */

describe("Windows yol davranışı (TŞ §19)", () => {
  it("pozitif: büyük/küçük harf farklı yazılan yetkili yol kabul edilir", { skip: !IS_WIN }, () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root.toLowerCase());
    expectAllowed(policy.authorizeRoot(root.toUpperCase()));
    expectAllowed(policy.checkPath(root, "SRC/CODE.TS"));
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: \\\\?\\ önekli candidate ve allowRoot eşleşmesi çözülür", { skip: !IS_WIN }, () => {
    const root = makeRoot();
    seedFixture(root);
    const prefixedRoot = `\\\\?\\${root}`;
    const policy = policyFor(prefixedRoot);
    expectAllowed(policy.authorizeRoot(root)); // beyan \\?\ ile, kullanım düz yol
    expectAllowed(policy.checkPath(root, `\\\\?\\${path.join(root, "src", "code.ts")}`));
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: ters bölü ayraçlı candidate normalize edilir", { skip: !IS_WIN }, () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "src\\deep\\nested.ts")).relativePath).toBe("src/deep/nested.ts");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: farklı sürücü harfine mutlak yol reddedilir", { skip: !IS_WIN }, () => {
    const root = makeRoot(); // örn. C:\...
    const policy = policyFor(root);
    const drive = root.slice(0, 2); // "C:"
    const otherDrive = drive === "C:" ? "D:" : "C:";
    expect(denyOf(policy.checkPath(root, `${otherDrive}\\disaridan\\secret.txt`)).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 6) Ignore kuralları (TŞ §20 default listesi + kullanıcı ignore)     */
/* ------------------------------------------------------------------ */

describe("ignore kuralları (TŞ §20, gitignore benzeri minimal eşleme)", () => {
  it("negatif: .git, node_modules, dist, .env*, *.pem default ignore ile reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    for (const candidate of [
      "node_modules/pkg/index.js",
      ".git/HEAD",
      "dist/bundle.js",
      ".env.local",
      "secrets/key.pem",
    ]) {
      const denied = denyOf(policy.checkPath(root, candidate));
      expect(denied.code, candidate).toBe("workspace/path-denied");
      expect(denied.rule, candidate).toBeTruthy();
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: ignore edilmeyen normal dosyalar kabul edilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkPath(root, "src/code.ts"));
    expectAllowed(policy.checkPath(root, "notes.md"));
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: kullanıcı extraIgnore'u default'lara EKLENİR (default'lar korunur)", () => {
    const root = makeRoot();
    seedFixture(root);
    writeFileSync(path.join(root, "app.min.js"), "var a=1;");
    const policy = policyFor(root, { extraIgnore: ["**/*.min.js"] });
    expect(denyOf(policy.checkPath(root, "app.min.js")).code).toBe("workspace/path-denied");
    expect(denyOf(policy.checkPath(root, "node_modules/pkg/index.js")).code).toBe("workspace/path-denied"); // default hâlâ aktif
    expectAllowed(policy.checkPath(root, "src/code.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: dizin-only desen (generated/) altındaki dosyalar ata dizin üzerinden reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    mkdirSync(path.join(root, "generated"), { recursive: true });
    writeFileSync(path.join(root, "generated", "gen.ts"), "export const g = 1;\n");
    const policy = policyFor(root, { extraIgnore: ["generated/"] });
    expect(denyOf(policy.checkPath(root, "generated/gen.ts")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: anchored desen (/build) yalnızca kök seviyesinde eşleşir, src/build eşleşmez", () => {
    const root = makeRoot();
    seedFixture(root);
    mkdirSync(path.join(root, "build"), { recursive: true });
    writeFileSync(path.join(root, "build", "out.txt"), "b");
    mkdirSync(path.join(root, "src", "build"), { recursive: true });
    writeFileSync(path.join(root, "src", "build", "keep.ts"), "export const k = 1;\n");
    const policy = policyFor(root, { extraIgnore: ["/build"] });
    expect(denyOf(policy.checkPath(root, "build/out.txt")).code).toBe("workspace/path-denied");
    expectAllowed(policy.checkPath(root, "src/build/keep.ts"));
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: slash'sız desen (*.log) her derinlikte basename eşleşir", () => {
    const root = makeRoot();
    seedFixture(root);
    mkdirSync(path.join(root, "logs"), { recursive: true });
    writeFileSync(path.join(root, "logs", "run.log"), "log");
    writeFileSync(path.join(root, "trace.log"), "log");
    const policy = policyFor(root, { extraIgnore: ["*.log"] });
    expect(denyOf(policy.checkPath(root, "logs/run.log")).code).toBe("workspace/path-denied");
    expect(denyOf(policy.checkPath(root, "trace.log")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: matchesIgnorePattern birimi — ** ve ? semantiği deterministiktir", () => {
    const caseInsensitive = IS_WIN;
    expect(matchesIgnorePattern("a/.git/HEAD", false, "**/.git/**")).toBe(true);
    expect(matchesIgnorePattern(".git/HEAD", false, "**/.git/**")).toBe(true);
    expect(matchesIgnorePattern("x/.env.production", false, "**/.env*")).toBe(true);
    expect(matchesIgnorePattern("certs/key.pem", false, "**/*.pem")).toBe(true);
    expect(matchesIgnorePattern("src/code.ts", false, "**/*.pem")).toBe(false);
    expect(matchesIgnorePattern("logs/run.log", false, "*.log")).toBe(true);
    expect(matchesIgnorePattern("logs/run.log", false, "/build")).toBe(false);
    expect(matchesIgnorePattern("build/x.txt", false, "/build")).toBe(false); // dosya-only eşleşme: /build dizini hedefler
    expect(matchesIgnorePattern("ab/b.txt", false, "?b/**")).toBe(true);
    expect(matchesIgnorePattern("abc/b.txt", false, "?b/**")).toBe(false);
    expect(matchesIgnorePattern("src/code.ts", false, "**/vendor/**")).toBe(false);
    // Windows'ta eşleme case-insensitive'dir (FS davranışıyla tutarlı):
    expect(matchesIgnorePattern("SRC/.GIT/HEAD", false, "**/.git/**")).toBe(caseInsensitive);
  });
});

/* ------------------------------------------------------------------ */
/* 7) Binary / boyut filtresi (TŞ §19 kaynak tüketimi limiti, §20)     */
/* ------------------------------------------------------------------ */

describe("binary/boyut filtresi (TŞ §19, §20)", () => {
  it("negatif: default binary uzantı (.png) reddedilir ve matched kural bildirilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    const denied = denyOf(policy.checkFile(root, "assets/logo.png"));
    expect(denied.code).toBe("workspace/path-denied");
    expect(denied.rule).toBe(".png");
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: kaynak dosya uzantıları blacklist modunda engellenmez", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkFile(root, "src/code.ts"));
    expectAllowed(policy.checkFile(root, "notes.md"));
    expectAllowed(policy.checkFile(root, "README")); // uzantısız blacklist modunda serbest
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: maxFileBytes aşan dosya LIMIT_EXCEEDED ile reddedilir (fs boyutuyla)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root, { maxFileBytes: 16 });
    const denied = denyOf(policy.checkFile(root, "src/big.ts"));
    expect(denied.code).toBe("workspace/limit-exceeded");
    expect(denied.rule).toBe("maxFileBytes");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: explicit sizeBytes parametresi limit aşımında reddeder (fs'e bakmadan)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(denyOf(policy.checkFile(root, "src/code.ts", 5_000_000)).code).toBe("workspace/limit-exceeded");
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: limit içindeki explicit sizeBytes kabul edilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkFile(root, "src/code.ts", 42));
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: whitelist modunda yalnızca beyan edilen uzantılar geçer, uzantısız dosya reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root, {
      extensionFilterMode: "whitelist",
      allowedExtensions: [".ts", ".js"],
    });
    expectAllowed(policy.checkFile(root, "src/code.ts"));
    const deniedMd = denyOf(policy.checkFile(root, "notes.md"));
    expect(deniedMd.code).toBe("workspace/path-denied");
    expect(deniedMd.rule).toBe(".md");
    const deniedNoExt = denyOf(policy.checkFile(root, "README"));
    expect(deniedNoExt.code).toBe("workspace/path-denied");
    expect(deniedNoExt.rule).toBe("(uzantısız)");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: blacklist'te olmayan bilinmeyen uzantı (.xyz) blacklist modunda serbesttir", () => {
    const root = makeRoot();
    seedFixture(root);
    writeFileSync(path.join(root, "data.xyz"), "unknown");
    const policy = policyFor(root);
    expectAllowed(policy.checkFile(root, "data.xyz"));
    rmSync(root, { recursive: true, force: true });
  });

  it("pozitif: default binary uzantı seti makul kapsamdadır (örnek set kontrolü)", () => {
    for (const ext of [".exe", ".dll", ".so", ".dylib", ".zip", ".tar", ".gz", ".png", ".jpg", ".gif", ".ico", ".pdf", ".woff", ".ttf", ".sqlite", ".pyc", ".wasm", ".bin"]) {
      expect(DEFAULT_BINARY_EXTENSIONS).toContain(ext);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7.5) Takım denetimi bulguları (regresyon)                           */
/* ------------------------------------------------------------------ */

describe("denetim bulguları: kanonik yol ignore re-check (bypass yok)", () => {
  it("negatif: kök içine işaret eden junction secret-ignore hedefine ulaşıyorsa kanonik yolda reddedilir", () => {
    const root = makeRoot();
    seedFixture(root); // .git/HEAD mevcut; direct '.git/HEAD' ignore ile reddedilir
    symlinkSync(path.join(root, ".git"), path.join(root, "meta-link"), "junction");
    const policy = policyFor(root);
    // Doğrudan yol reddedilir:
    expect(denyOf(policy.checkPath(root, ".git/HEAD")).rule).toBe("**/.git/**");
    // Junction üzerinden aynı hedef de reddedilmelidir (bypass YOK):
    const denied = denyOf(policy.checkPath(root, "meta-link/HEAD"));
    expect(denied.code).toBe("workspace/path-denied");
    expect(denied.rule).toBe("**/.git/**");
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: ignore edilmeyen hedefe giden kök-içi junction izinli kalır ve canonical relativePath döner", () => {
    const root = makeRoot();
    seedFixture(root);
    symlinkSync(path.join(root, "src"), path.join(root, "alias-src"), "junction");
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "alias-src/code.ts")).relativePath).toBe("src/code.ts");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("denetim bulguları: sizeBytes girdi doğrulaması", () => {
  it("negatif: NaN / negatif / sonsuz sizeBytes deterministik olarak reddedilir (limit sessiz geçilemez)", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const denied = denyOf(policy.checkFile(root, "src/code.ts", bad));
      expect(denied.code, `sizeBytes=${String(bad)}`).toBe("workspace/path-denied");
      expect(denied.rule, `sizeBytes=${String(bad)}`).toBe("sizeBytes");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("partial: sizeBytes=0 (boş dosya) geçerli girdidir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expectAllowed(policy.checkFile(root, "src/code.ts", 0));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("denetim bulguları: çok segmentli uzantı şeması", () => {
  it("partial: '.d.ts' ve '.min.js' şemada kabul edilir; sondaki/art arda nokta reddedilir", () => {
    const parsed = parseWorkspacePolicyConfig({ allowedExtensions: [".ts", ".d.ts", ".min.js"] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.allowedExtensions).toEqual([".ts", ".d.ts", ".min.js"]);
    expect(parseWorkspacePolicyConfig({ allowedExtensions: [".ts."] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ allowedExtensions: [".d..ts"] }).ok).toBe(false);
    expect(parseWorkspacePolicyConfig({ binaryExtensions: [".tar.gz"] }).ok).toBe(true);
  });
});

describe("denetim bulguları: '..' ile başlayan yasal adlar", () => {
  it("partial: '..foo' yasal dosya adı reddedilmez (boundary-duyarlı traversal kontrolü)", () => {
    const root = makeRoot();
    seedFixture(root);
    writeFileSync(path.join(root, "..foo"), "ok\n");
    const policy = policyFor(root);
    expect(expectAllowed(policy.checkPath(root, "..foo")).relativePath).toBe("..foo");
    rmSync(root, { recursive: true, force: true });
  });

  it("negatif: tam '..' segmenti (üst dizin) hâlâ reddedilir", () => {
    const root = makeRoot();
    seedFixture(root);
    const policy = policyFor(root);
    expect(denyOf(policy.checkPath(root, "..")).code).toBe("workspace/path-denied");
    expect(denyOf(policy.checkPath(root, "../sibling.txt")).code).toBe("workspace/path-denied");
    rmSync(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* 8) Determinizm (TŞ §6: aynı giriş → aynı karar)                     */
/* ------------------------------------------------------------------ */

describe("determinizm (TŞ §6)", () => {
  it("pozitif: aynı config + aynı girdiler → birebir aynı karar (iki ayrı instance)", () => {
    const root = makeRoot();
    seedFixture(root);
    const cfg = () => ({ allowRoots: [root], extraIgnore: ["**/*.min.js"] });
    const a = WorkspaceAccessPolicy.create(cfg());
    const b = WorkspaceAccessPolicy.create(cfg());
    const cases: Array<[string, string]> = [
      ["src/code.ts", "checkPath"],
      ["node_modules/pkg/index.js", "checkPath"],
      ["assets/logo.png", "checkFile"],
    ];
    for (const [candidate, method] of cases) {
      const da = method === "checkPath" ? a.checkPath(root, candidate) : a.checkFile(root, candidate);
      const db = method === "checkPath" ? b.checkPath(root, candidate) : b.checkFile(root, candidate);
      expect(da).toEqual(db);
    }
    rmSync(root, { recursive: true, force: true });
  });
});
