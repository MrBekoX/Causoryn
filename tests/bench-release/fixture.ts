import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256Hex, utf8Encode } from "@causoryn/domain";

/**
 * F7 benchmark fixture üreticisi — deterministik sentetik TypeScript
 * workspace (sprint-7 F7; TŞ v2.1 §21 s.22 "1.000 TS dosyası fixture").
 *
 * Determinizm sözleşmesi: içerik YALNIZCA dosya sırasından (0..fileCount-1)
 * türetilir; rastgelelik, saat, ortam değişkeni kullanılmaz. Aynı
 * fileCount → aynı dosya listesi + bayt-bayt aynı içerik → aynı sha256
 * (buildFixtureModel iki kez koşulup hash eşleşmesiyle testte kanıtlanır).
 *
 * Yerleşim (en fazla 1000 dosya): src/d<D>/p<P>/unitD<D>P<P>N<N>.ts;
 * D=⌊i/100⌋, P=⌊(i%100)/10⌋, N=i%10. Zincir: dosya i, dosya i+1'in sınıfını
 * import eder ve metot gövdesinde onun step metodunu çağırır → TS
 * TypeChecker üzerinden CALLS kenarları (fixture-ts-orders deseniyle aynı
 * kanıt şekli). Son dosyada dışa bağlantı yoktur.
 *
 * Güvenlik (statik güvenlik kuralı): dinamik yol parçaları fs çağrısına girmeden
 * ÖNCE whitelist regex ile doğrulanır (SAFE_* kalıpları); kök os.tmpdir()
 * gerçek yolu içinde olmak ZORUNDADIR (FIXTURE_ROOT_OUTSIDE_TMPDIR);
 * workspace'e (<repo-root>) yazım mimari olarak imkânsızdır.
 */

/** Model'in bir dosya girdisi: kök-göreceli POSIX yolu + tam içerik. */
export interface FixtureEntry {
  readonly relativePath: string;
  readonly content: string;
}

/** Deterministik fixture modeli (bellek-içi; diskteki haliyle birebir). */
export interface FixtureModel {
  readonly fileCount: number;
  readonly entries: readonly FixtureEntry[];
  /** entries'in kanonik özet metninin sha256'sı. */
  readonly hash: string;
  /** İlk dosyanın sınıf adı — komşuluk ölçümünün başlangıç sembolü. */
  readonly firstClassName: string;
}

/** Fixture üretim/yazım reddiyenleri — explicit hata sözleşmesi (negatif dal). */
export class BenchFixtureError extends Error {
  readonly code:
    | "FIXTURE_COUNT_INVALID"
    | "FIXTURE_ROOT_OUTSIDE_TMPDIR"
    | "FIXTURE_ROOT_NOT_CREATABLE"
    | "FIXTURE_ROOT_NOT_EMPTY"
    | "FIXTURE_PATH_REJECTED";

  constructor(
    code:
      | "FIXTURE_COUNT_INVALID"
      | "FIXTURE_ROOT_OUTSIDE_TMPDIR"
      | "FIXTURE_ROOT_NOT_CREATABLE"
      | "FIXTURE_ROOT_NOT_EMPTY"
      | "FIXTURE_PATH_REJECTED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BenchFixtureError";
    this.code = code;
  }
}

/** Maksimum fixture boyutu: TŞ §21 sözleşmesi 1.000 dosyadır. */
export const MAX_FIXTURE_FILES = 1000;

/**
 * Whitelist: yalnızca üreticinin kendi yerleşim deseni kabul edilir.
 * Dosya adları bilinçli olarak KÜÇÜK HARFTİR: adapter canonicalPath yolları
 * lower-case'ler; büyük harfli dosya adı TS1261 casing tanısına yol açar
 * (repo fixture'ları da aynı disipline uyar).
 */
const SAFE_ENTRY_PATH = /^src\/d[0-9]+\/p[0-9]+\/unit-d[0-9]+-p[0-9]+-n[0-9]+\.ts$/;
const SAFE_DIR_PATH = /^src\/d[0-9]+\/p[0-9]+$/;

function suffixOf(index: number): string {
  const d = Math.floor(index / 100);
  const p = Math.floor((index % 100) / 10);
  const n = index % 10;
  return `D${d}P${p}N${n}`;
}

function entryPathOf(index: number): string {
  const lower = suffixOf(index).toLowerCase();
  const fileName = `unit-${lower.slice(0, 2)}-${lower.slice(2, 4)}-${lower.slice(4)}.ts`;
  return `src/d${Math.floor(index / 100)}/p${Math.floor((index % 100) / 10)}/${fileName}`;
}

function classNameOf(index: number): string {
  return `Unit${suffixOf(index)}`;
}

/**
 * from → to import belirteci (NodeNext .js uzantılı). Yerleşim sabit
 * derinlikte olduğu için göreli yol saf metin kurallarıyla üretilir
 * (path.relative çağrısı yok → tamamen deterministik, platform-bağımsız).
 */
function importSpecifierOf(fromIndex: number, toIndex: number): string {
  const fromDir = `d${Math.floor(fromIndex / 100)}/p${Math.floor((fromIndex % 100) / 10)}`;
  const toDir = `d${Math.floor(toIndex / 100)}/p${Math.floor((toIndex % 100) / 10)}`;
  const lower = suffixOf(toIndex).toLowerCase();
  const toBase = `unit-${lower.slice(0, 2)}-${lower.slice(2, 4)}-${lower.slice(4)}.js`;
  if (fromDir === toDir) return `./${toBase}`;
  const fromDomain = `d${Math.floor(fromIndex / 100)}`;
  const toDomain = `d${Math.floor(toIndex / 100)}`;
  if (fromDomain === toDomain) return `../${toDir.replace(`${fromDomain}/`, "")}/${toBase}`;
  return `../../${toDir}/${toBase}`;
}

function entryContentOf(index: number, fileCount: number): string {
  const suffix = suffixOf(index);
  const isLast = index + 1 >= fileCount;
  if (isLast) {
    return [
      "/**",
      ` * Causoryn F7 benchmark fixture — deterministik sentetik dosya ${index + 1}/${fileCount}.`,
      " * Üretici: tests/bench-release/fixture.ts (TŞ v2.1 §21 1k dosya benchmark).",
      " * Elle düzenlenmez; değişiklik yalnızca üreticiden gelir.",
      " */",
      "",
      `export interface Input${suffix} {`,
      "  readonly value: number;",
      "}",
      "",
      `export class Unit${suffix} {`,
      `  step${suffix}(input: Input${suffix}): number {`,
      "    return input.value + 1;",
      "  }",
      "}",
      "",
    ].join("\n");
  }
  const nextIndex = index + 1;
  const nextName = classNameOf(nextIndex);
  const nextSuffix = suffixOf(nextIndex);
  return [
    "/**",
    ` * Causoryn F7 benchmark fixture — deterministik sentetik dosya ${index + 1}/${fileCount}.`,
    " * Üretici: tests/bench-release/fixture.ts (TŞ v2.1 §21 1k dosya benchmark).",
    " * Elle düzenlenmez; değişiklik yalnızca üreticiden gelir.",
    " */",
    `import { ${nextName} } from "${importSpecifierOf(index, nextIndex)}";`,
    "",
    `export interface Input${suffix} {`,
    "  readonly value: number;",
    "}",
    "",
    `export class Unit${suffix} {`,
    `  private readonly next: ${nextName} | undefined;`,
    "",
    `  constructor(next?: ${nextName}) {`,
    "    this.next = next;",
    "  }",
    "",
    `  step${suffix}(input: Input${suffix}): number {`,
    "    const value = input.value + 1;",
    "    if (this.next === undefined || value > 10000) {",
    "      return value;",
    "    }",
    `    return this.next.step${nextSuffix}({ value });`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Kanonik özet metni: her girdi için "posixRelPath\niçerik", girdiler
 * sıra (index) düzeninde. Disk doğrulaması aynı metni diskten kurar.
 */
function canonicalDigestText(entries: readonly FixtureEntry[]): string {
  return entries
    .map((entry) => `${entry.relativePath.replace(/\\/g, "/")}\n${entry.content}`)
    .join("\n");
}

/** Deterministik modeli kurar; geçersiz adet explicit hata ile reddedilir. */
export function buildFixtureModel(fileCount: number): FixtureModel {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > MAX_FIXTURE_FILES) {
    throw new BenchFixtureError(
      "FIXTURE_COUNT_INVALID",
      `fileCount 1..${MAX_FIXTURE_FILES} aralığında olmalı (istenen: ${String(fileCount)})`,
    );
  }
  const entries: FixtureEntry[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    entries.push({
      relativePath: entryPathOf(index),
      content: entryContentOf(index, fileCount),
    });
  }
  return {
    fileCount,
    entries,
    hash: sha256Hex(utf8Encode(canonicalDigestText(entries))),
    firstClassName: classNameOf(0),
  };
}

/**
 * Kökü kanonikleştirir ve os.tmpdir() gerçek yolu İÇİNDE olduğuna dair
 * konteynman kanıtı üretir; aksi halde explicit reddiyen. Windows'ta yol
 * karşılaştırması büyük/küçük harf duyarsız yapılır (NTFS davranışı).
 */
function resolveContainedRoot(root: string): string {
  if (root.length === 0) {
    throw new BenchFixtureError("FIXTURE_ROOT_NOT_CREATABLE", "kök yolu boş");
  }
  let tmpReal: string;
  try {
    tmpReal = realpathSync(os.tmpdir());
  } catch (error) {
    throw new BenchFixtureError(
      "FIXTURE_ROOT_OUTSIDE_TMPDIR",
      `os.tmpdir() gerçek yolu çözümlenemedi: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rootResolved = path.resolve(root);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const tmpCmp = process.platform === "win32" ? tmpReal.toLowerCase() : tmpReal;
  const tmpBoundary = tmpCmp.endsWith(path.sep) ? tmpCmp : tmpCmp + path.sep;
  if (rootCmp !== tmpCmp && !rootCmp.startsWith(tmpBoundary)) {
    throw new BenchFixtureError(
      "FIXTURE_ROOT_OUTSIDE_TMPDIR",
      `fixture kökü os.tmpdir() içinde değil (workspace salt-okunur disiplini): ${root}`,
    );
  }
  return rootResolved;
}

/**
 * Var olan/oluşturulabilir boş kökü hazırlar. Üst bileşen dosya ise ya da
 * mkdir reddedilirse FIXTURE_ROOT_NOT_CREATABLE; dizin doluysa
 * FIXTURE_ROOT_NOT_EMPTY.
 */
function prepareRoot(root: string): string {
  const rootResolved = resolveContainedRoot(root);
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(rootResolved);
  } catch {
    stat = undefined;
  }
  if (stat !== undefined && !stat.isDirectory()) {
    throw new BenchFixtureError(
      "FIXTURE_ROOT_NOT_CREATABLE",
      `kök yolu bir dizin değil: ${rootResolved}`,
    );
  }
  if (stat === undefined) {
    try {
      mkdirSync(rootResolved, { recursive: true });
    } catch (error) {
      throw new BenchFixtureError(
        "FIXTURE_ROOT_NOT_CREATABLE",
        `kök dizini oluşturulamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    const existing = readdirSafe(rootResolved);
    if (existing.length > 0) {
      throw new BenchFixtureError(
        "FIXTURE_ROOT_NOT_EMPTY",
        `hedef dizin dolu (üzerine yazım yok): ${rootResolved} (${String(existing.length)} girdi)`,
      );
    }
  }
  return rootResolved;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Girdi yolunu whitelist'ten geçirip kök altında mutlak yola çevirir. */
function entryAbsPath(rootResolved: string, relativePath: string): string {
  if (!SAFE_ENTRY_PATH.test(relativePath.replace(/\\/g, "/"))) {
    throw new BenchFixtureError(
      "FIXTURE_PATH_REJECTED",
      `girdi yolu üretici whitelist'i dışında: ${relativePath}`,
    );
  }
  const boundary = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  const abs = rootResolved + path.sep + relativePath.replace(/\//g, path.sep);
  if (!abs.startsWith(boundary)) {
    throw new BenchFixtureError(
      "FIXTURE_PATH_REJECTED",
      `girdi yolu kök sınırını aşıyor: ${relativePath}`,
    );
  }
  return abs;
}

/**
 * Modeli diske yazar. Aynı model + aynı (boş) kök → aynı baytlar
 * (deterministik üretim sözleşmesi).
 */
export function writeFixture(
  root: string,
  model: FixtureModel,
): { readonly root: string; readonly fileCount: number; readonly hash: string } {
  const rootResolved = prepareRoot(root);
  const dirs = new Set<string>();
  for (const entry of model.entries) {
    const normalized = entry.relativePath.replace(/\\/g, "/");
    const dir = normalized.slice(0, normalized.lastIndexOf("/"));
    if (!SAFE_DIR_PATH.test(dir)) {
      throw new BenchFixtureError(
        "FIXTURE_PATH_REJECTED",
        `girdi dizini üretici whitelist'i dışında: ${dir}`,
      );
    }
    dirs.add(dir);
  }
  for (const dir of [...dirs].sort()) {
    const dirAbs = rootResolved + path.sep + dir.replace(/\//g, path.sep);
    mkdirSync(dirAbs, { recursive: true });
  }
  for (const entry of model.entries) {
    const abs = entryAbsPath(rootResolved, entry.relativePath);
    writeFileSync(abs, entry.content, "utf8");
  }
  return { root: rootResolved, fileCount: model.fileCount, hash: model.hash };
}

/**
 * Diske yazılmış fixture'ı yeniden okuyup model ile aynı kanonik özetin
 * hash'ini üretir — determinizmin disk-üstü kanıtı.
 */
export function fixtureDiskHash(root: string, model: FixtureModel): string {
  const rootResolved = resolveContainedRoot(root);
  const parts: string[] = [];
  for (const entry of model.entries) {
    const abs = entryAbsPath(rootResolved, entry.relativePath);
    parts.push(`${entry.relativePath.replace(/\\/g, "/")}\n${readFileSync(abs, "utf8")}`);
  }
  return sha256Hex(utf8Encode(parts.join("\n")));
}
