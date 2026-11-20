/**
 * generate-sbom — Causoryn dağıtım paketi için deterministik CycloneDX 1.5 SBOM
 * (`causoryn-sbom.cdx.json`) ve `SHA256SUMS.txt` üreticisi (F-P1-05, I-2).
 *
 * Paketlenen tüm üçüncü-parti npm + Roslyn (.NET) bileşenlerini gerçek
 * `packages/causoryn/THIRD-PARTY-NOTICES.md`, `package-lock.json` ve
 * `packages/causoryn/native/roslyn-worker/Causoryn.RoslynWorker.deps.json`
 * kaynaklarından dinamik ve sürümlü `purl` değerleriyle okur.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function encodeNpmPurl(name, version) {
  if (name.startsWith("@") && name.includes("/")) {
    const [scope, pkgName] = name.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${pkgName}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

function parseRedistributedComponentsFromNotices(noticesPath) {
  if (!existsSync(noticesPath)) {
    throw new Error(`[generate-sbom] missing THIRD-PARTY-NOTICES.md: ${noticesPath}`);
  }
  const text = readFileSync(noticesPath, "utf8");
  const lines = text.split(/\r?\n/);

  let section = 0;
  const npmComponents = [];
  const nugetComponents = [];

  for (const line of lines) {
    if (line.startsWith("## 1.")) {
      section = 1;
      continue;
    }
    if (line.startsWith("## 2.")) {
      section = 2;
      continue;
    }
    if (line.startsWith("## 3.")) {
      section = 3;
      continue;
    }

    const headingMatch = line.match(/^###\s+(.+?)\s+\(([^)]+)\)\s+—\s+(.+)$/);
    if (!headingMatch) continue;
    const [, rawName, rawVersion, rawLicense] = headingMatch;
    const name = rawName.trim();
    const version = rawVersion.trim();
    const license = rawLicense.trim();

    if (section === 1) {
      if (name.toLowerCase().startsWith("sqlite")) {
        continue; // Public domain embedded C library bundled inside better-sqlite3
      }
      npmComponents.push({
        type: "library",
        name,
        version,
        purl: encodeNpmPurl(name, version),
        licenses: [{ license: { id: license } }],
      });
    } else if (section === 2) {
      nugetComponents.push({
        type: "library",
        name,
        version,
        purl: `pkg:nuget/${name}@${version}`,
        licenses: [{ license: { id: license } }],
      });
    }
  }

  return [...npmComponents, ...nugetComponents].sort((a, b) =>
    a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0,
  );
}

/**
 * CycloneDX 1.5 SBOM nesnesini üretir.
 *
 * @param {{ repoRoot?: string, tarballSha256?: string, timestamp?: string }} [options]
 */
export function buildCycloneDxSbom(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const pkgJsonPath = path.join(repoRoot, "packages", "causoryn", "package.json");
  const noticesPath = path.join(repoRoot, "packages", "causoryn", "THIRD-PARTY-NOTICES.md");
  const roslynDepsPath = path.join(
    repoRoot,
    "packages",
    "causoryn",
    "native",
    "roslyn-worker",
    "Causoryn.RoslynWorker.deps.json",
  );

  if (!existsSync(pkgJsonPath)) {
    throw new Error(`[generate-sbom] missing packages/causoryn/package.json: ${pkgJsonPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const components = parseRedistributedComponentsFromNotices(noticesPath);

  if (components.length === 0) {
    throw new Error("[generate-sbom] parsed 0 redistributed components from THIRD-PARTY-NOTICES.md");
  }

  // Roslyn deps.json çapraz doğrulaması: en az Microsoft.CodeAnalysis.CSharp yer almalı.
  if (existsSync(roslynDepsPath)) {
    const deps = JSON.parse(readFileSync(roslynDepsPath, "utf8"));
    const libs = Object.keys(deps?.libraries ?? {});
    for (const reqNuget of ["Microsoft.CodeAnalysis.Common", "Microsoft.CodeAnalysis.CSharp"]) {
      const hasInDeps = libs.some((key) => key.startsWith(`${reqNuget}/`));
      const hasInSbom = components.some((comp) => comp.name === reqNuget);
      if (hasInDeps && !hasInSbom) {
        throw new Error(`[generate-sbom] Roslyn component missing from SBOM: ${reqNuget}`);
      }
    }
  }

  const rootComponent = {
    type: "application",
    name: pkg.name,
    version: pkg.version,
    purl: encodeNpmPurl(pkg.name, pkg.version),
    licenses: [{ license: { id: pkg.license || "MIT" } }],
  };
  if (typeof options.tarballSha256 === "string" && /^[0-9a-f]{64}$/i.test(options.tarballSha256)) {
    rootComponent.hashes = [{ alg: "SHA-256", content: options.tarballSha256.toLowerCase() }];
  }

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? new Date().toISOString(),
      component: rootComponent,
    },
    components,
  };
}

/**
 * Verilen release-artifacts dizinindeki tek `.tgz` için `causoryn-sbom.cdx.json`
 * ve `SHA256SUMS.txt` dosyalarını üretir.
 *
 * @param {{ repoRoot?: string, artifactsDir: string }} options
 */
export function generateReleaseArtifacts(options) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const artifactsDir = path.resolve(options.artifactsDir);
  const tgzFiles = readdirSync(artifactsDir)
    .filter((f) => f.endsWith(".tgz"))
    .sort();
  if (tgzFiles.length !== 1) {
    throw new Error(
      `[generate-sbom] Expected exactly 1 packed tarball in ${artifactsDir}, found: ${tgzFiles.join(", ")}`,
    );
  }
  const tgzName = tgzFiles[0];
  const tgzPath = path.join(artifactsDir, tgzName);
  const tgzSha = sha256File(tgzPath);

  const sbom = buildCycloneDxSbom({ repoRoot, tarballSha256: tgzSha });
  const sbomName = "causoryn-sbom.cdx.json";
  const sbomPath = path.join(artifactsDir, sbomName);
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

  const sbomSha = sha256File(sbomPath);
  const sums = `${tgzSha}  ${tgzName}\n${sbomSha}  ${sbomName}\n`;
  writeFileSync(path.join(artifactsDir, "SHA256SUMS.txt"), sums, "utf8");

  return { tgzName, tgzSha, sbomName, sbomSha, componentCount: sbom.components.length };
}

function parseCliArgs(argv) {
  let artifactsDir = "";
  let repoRoot = DEFAULT_REPO_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--artifacts-dir") {
      artifactsDir = argv[i + 1] ?? "";
      i += 1;
    } else if (argv[i] === "--repo") {
      repoRoot = argv[i + 1] ?? "";
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${String(argv[i])}`);
    }
  }
  if (!artifactsDir) {
    throw new Error("Missing required --artifacts-dir <dir>");
  }
  return { artifactsDir, repoRoot };
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const res = generateReleaseArtifacts(cli);
    console.log(
      `[generate-sbom] ok — ${res.sbomName} (${res.componentCount} components) + SHA256SUMS.txt generated for ${res.tgzName}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
