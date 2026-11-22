/**
 * GitHub Actions CI (.github/workflows/ci.yml) ve Release (.github/workflows/release.yml)
 * iş akışları sözleşme ve güvenlik testleri (F-P1-05, K-022).
 *
 * Kapsam:
 * - Geçerli YAML ayrıştırması (yaml.parse).
 * - En-az-yetki izinleri: her iki iş akışında üst düzey permissions: { contents: "read" }.
 * - Tüm `uses:` eylemlerinde 40 karakterlik hex commit SHA sabitlemesi (@[0-9a-f]{40}).
 * - CI matrisi: ubuntu-latest, windows-latest, macos-latest; fail-fast: false.
 * - Deterministik Release Roslyn derlemesi + `cargo build --locked` + prepack readiness kapısı.
 * - Release iş akışında OIDC Trusted Publishing (`id-token: write`, `attestations: write`,
 *   `--provenance`, `NPM_TOKEN` YOK), `SHA256SUMS.txt`, SBOM (`causoryn-sbom.cdx.json`),
 *   `actions/attest-build-provenance` ve fail-closed etiket/sürüm eşitliği kontrolü.
 * - `run:` bloklarında güvenilmeyen `${{ github.event.* }}` kabuk interpolasyonunun yokluğu.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RELEASE_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "release.yml");

const VERIFIED_ACTION_SHAS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  setupDotnet: "actions/setup-dotnet@0f4a354dd5547a28c70b7853dbd95d5b67886e73",
  setupPython: "actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0",
  setupGo: "actions/setup-go@d8cbb8045d7f43706b9177cceb36c1f91a6644d5",
  rustToolchain: "dtolnay/rust-toolchain@39008827e6b4319a349e9a42dfc90579dd25f1ca",
  attestProvenance: "actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a",
} as const;

const SHA_PINNED_USES_RE = /^[^@\s]+@[0-9a-f]{40}$/;

const DETERMINISTIC_ROSLYN_BUILD =
  "dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en";

const LOCKED_RUST_BUILD = "cargo build --manifest-path native/rust-worker/Cargo.toml --locked";

const PREPACK_VERIFY_CMD = "node packages/causoryn/scripts/verify-package-ready.mjs";

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly run?: string;
}

interface WorkflowJob {
  readonly "runs-on"?: string;
  readonly environment?: string | Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly "timeout-minutes"?: number;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: {
      readonly os?: readonly string[];
    };
  };
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDoc {
  readonly name?: string;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly on?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

function loadWorkflow(filePath: string, label: string): { readonly raw: string; readonly doc: WorkflowDoc } {
  expect(existsSync(filePath), `${label} mevcut olmalı`).toBe(true);
  const raw = readFileSync(filePath, "utf8");
  const parsed: unknown = parse(raw);
  expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
  return { raw, doc: parsed as WorkflowDoc };
}

function collectAllSteps(doc: WorkflowDoc): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      steps.push(step);
    }
  }
  return steps;
}

describe(".github/workflows/ci.yml — CI sözleşmesi ve SHA-sabitli güvenlik kapıları", () => {
  it("dosya mevcuttur, geçerli YAML olarak ayrışır ve üst düzeyde salt-okunur izin tanımlar", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  it("yalnızca main üzerinde push ve pull_request ile tetiklenir; pull_request_target kullanmaz", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const triggers = doc.on;
    expect(triggers).toBeDefined();
    expect(triggers?.["pull_request_target"]).toBeUndefined();
    expect(triggers?.["push"]).toEqual({ branches: ["main"] });
    expect(triggers?.["pull_request"]).toEqual({ branches: ["main"] });
  });

  it("ubuntu-latest, windows-latest ve macos-latest üzerinde fail-fast: false matris tanımlar", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const jobs = Object.values(doc.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const matrixJob = jobs.find((job) => job.strategy?.matrix !== undefined);
    expect(matrixJob, "matris tanımlı CI job bulunmalı").toBeDefined();
    expect(matrixJob?.strategy?.["fail-fast"]).toBe(false);
    expect(matrixJob?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "windows-latest",
      "macos-latest",
    ]);
    expect(matrixJob?.["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("TÜM uses: eylemlerini 40 karakterlik doğrulanmış commit SHA'larına sabitler", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const steps = collectAllSteps(doc);
    const usesSteps = steps.filter((step): step is WorkflowStep & { readonly uses: string } =>
      typeof step.uses === "string",
    );
    expect(usesSteps.length).toBeGreaterThanOrEqual(6);

    for (const step of usesSteps) {
      expect(
        step.uses,
        `eylem 40-karakter SHA ile sabitlenmeli: ${step.uses}`,
      ).toMatch(SHA_PINNED_USES_RE);
    }

    const checkout = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.checkout);
    expect(checkout).toBeDefined();
    expect(checkout?.with).toEqual({ "persist-credentials": false });

    const setupNode = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.setupNode);
    expect(setupNode).toBeDefined();
    expect(String(setupNode?.with?.["node-version"])).toBe("24");

    const setupDotnet = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.setupDotnet);
    expect(setupDotnet).toBeDefined();
    expect(setupDotnet?.with?.["dotnet-version"]).toBe("10.0.x");

    const setupPython = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.setupPython);
    expect(setupPython).toBeDefined();
    expect(String(setupPython?.with?.["python-version"])).toBe("3.12");

    const setupGo = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.setupGo);
    expect(setupGo).toBeDefined();
    expect(setupGo?.with?.["go-version-file"]).toBe("native/go-worker/go.mod");
    expect(setupGo?.with?.["cache"]).toBe(false);

    const setupRust = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.rustToolchain);
    expect(setupRust).toBeDefined();
  });

  it("deterministik Release Roslyn, --locked Rust derlemelerini, prepack doğrulamasını ve kalite kapılarını doğru sırayla yürütür", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string")
      .map((cmd) => cmd.trim());

    const requiredNativeBuilds = [DETERMINISTIC_ROSLYN_BUILD, LOCKED_RUST_BUILD] as const;
    for (const buildCmd of requiredNativeBuilds) {
      expect(
        runBlocks.some((block) => block.includes(buildCmd)),
        `native derleme komutu bulunmalı: ${buildCmd}`,
      ).toBe(true);
    }

    const requiredGates = [
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm run build",
      "npm run build:bundle --workspace packages/mcp-server",
      "npm run build:package --workspace packages/causoryn",
      PREPACK_VERIFY_CMD,
      "npm run lint",
      "npm run secret-scan",
      "npm test",
    ] as const;

    const gateIndices = requiredGates.map((gate) => {
      const idx = runBlocks.findIndex((block) =>
        block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .includes(gate),
      );
      expect(idx, `kalite kapısı bulunmalı: ${gate}`).toBeGreaterThanOrEqual(0);
      return idx;
    });

    const installIdx = gateIndices[0] ?? -1;
    const buildPkgIdx = gateIndices[4] ?? -1;
    const verifyPkgIdx = gateIndices[5] ?? -1;
    const testIdx = gateIndices[gateIndices.length - 1] ?? -1;

    for (const idx of gateIndices.slice(1)) {
      expect(idx).toBeGreaterThanOrEqual(installIdx);
    }
    expect(verifyPkgIdx).toBeGreaterThan(buildPkgIdx);
    expect(verifyPkgIdx).toBeLessThan(testIdx);

    for (const buildCmd of requiredNativeBuilds) {
      const nativeIdx = runBlocks.findIndex((block) => block.includes(buildCmd));
      expect(nativeIdx).toBeLessThan(testIdx);
    }
  });

  it("run: bloklarında güvenilmeyen ${{ github.event.* }} kabuk interpolasyonu içermez", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string");

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const runBlock of runBlocks) {
      expect(runBlock).not.toMatch(/\$\{\{\s*github\.event\./);
    }
  });
});

describe(".github/workflows/release.yml — OIDC Trusted Publishing & provenance sözleşmesi", () => {
  it("dosya mevcuttur, üst düzey salt-okunur izin tanımlar ve v*.*.* tag + workflow_dispatch ile tetiklenir", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    expect(doc.permissions).toEqual({ contents: "read" });

    const triggers = doc.on;
    expect(triggers).toBeDefined();
    expect(triggers?.["pull_request_target"]).toBeUndefined();
    expect(triggers?.["push"]).toEqual({ tags: ["v*.*.*"] });

    const dispatch = triggers?.["workflow_dispatch"] as
      | { readonly inputs?: Readonly<Record<string, unknown>> }
      | undefined;
    expect(dispatch).toBeDefined();
    expect(dispatch?.inputs?.["tag"]).toBeDefined();
  });

  it("release job'ı ubuntu-latest üzerinde release environment ve en-az-yetki OIDC/attestation izinleriyle çalışır", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const jobs = Object.values(doc.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const releaseJob = jobs.find((job) => job.permissions?.["id-token"] === "write");
    expect(releaseJob, "OIDC id-token: write izinli release job bulunmalı").toBeDefined();
    expect(releaseJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(releaseJob?.environment).toBe("release");
    expect(releaseJob?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("TÜM uses: eylemlerini 40 karakterlik commit SHA'larına sabitler ve attest-build-provenance içerir", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const usesSteps = collectAllSteps(doc).filter(
      (step): step is WorkflowStep & { readonly uses: string } => typeof step.uses === "string",
    );
    expect(usesSteps.length).toBeGreaterThanOrEqual(7);

    for (const step of usesSteps) {
      expect(
        step.uses,
        `release eylemi 40-karakter SHA ile sabitlenmeli: ${step.uses}`,
      ).toMatch(SHA_PINNED_USES_RE);
    }

    const checkout = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.checkout);
    expect(checkout).toBeDefined();
    expect(checkout?.with?.["persist-credentials"]).toBe(false);

    const attest = usesSteps.find((step) => step.uses === VERIFIED_ACTION_SHAS.attestProvenance);
    expect(attest, "actions/attest-build-provenance SHA-sabitli adımı bulunmalı").toBeDefined();
    expect(String(attest?.with?.["subject-path"] ?? "")).toContain("release-artifacts");
  });

  it("tag==package.json doğrulaması, derleme/kalite kapıları, SHA256SUMS.txt, SBOM, GitHub Release ve OIDC npm publish (--provenance, NPM_TOKEN yok) yürütür", () => {
    const { raw, doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string");
    const joinedRuns = runBlocks.join("\n");

    expect(joinedRuns).toContain("npm ci --ignore-scripts");
    expect(joinedRuns).toContain("packages/causoryn/package.json");
    expect(joinedRuns).toContain(DETERMINISTIC_ROSLYN_BUILD);
    expect(joinedRuns).toContain(LOCKED_RUST_BUILD);
    expect(joinedRuns).toContain("npm run typecheck");
    expect(joinedRuns).toContain("npm run build");
    expect(joinedRuns).toContain("npm run build:bundle --workspace packages/mcp-server");
    expect(joinedRuns).toContain("npm run build:package --workspace packages/causoryn");
    expect(joinedRuns).toContain(PREPACK_VERIFY_CMD);
    expect(joinedRuns).toContain("npm run lint");
    expect(joinedRuns).toContain("npm run secret-scan");
    expect(joinedRuns).toContain("npm test");
    expect(joinedRuns).toContain("scripts/generate-sbom.mjs");
    expect(joinedRuns).toContain("npm pack");
    expect(joinedRuns).toContain("SHA256SUMS.txt");
    expect(joinedRuns).toContain("causoryn-sbom.cdx.json");
    expect(joinedRuns).toContain("gh release create");
    expect(joinedRuns).toContain('npm publish "./$TGZ_FILE"');
    expect(joinedRuns).toContain("--provenance");
    expect(joinedRuns).toContain("--access public");

    // npm test, npm pack ve npm publish adımlarından ÖNCE koşmalı (fail-closed):
    const testIdx = runBlocks.findIndex((b) =>
      b.split(/\r?\n/).some((line) => line.trim() === "npm test"),
    );
    const packIdx = runBlocks.findIndex((b) => b.includes("npm pack"));
    const publishIdx = runBlocks.findIndex((b) => b.includes("npm publish"));
    expect(testIdx, "release.yml npm test kapısını içermeli").toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeLessThan(packIdx);
    expect(packIdx).toBeLessThan(publishIdx);

    // OIDC Trusted Publishing: uzun ömürlü NPM_TOKEN sırrı kullanılmaz ve
    // actions/setup-node üzerinde registry-url verilmez (aksi halde .npmrc'ye
    // boş _authToken enjekte ederek OIDC akışını ENEEDAUTH ile kırar).
    expect(raw).not.toContain("secrets.NPM_TOKEN");
    expect(raw).not.toContain("NODE_AUTH_TOKEN");
    const setupNode = collectAllSteps(doc).find(
      (step) => step.uses === VERIFIED_ACTION_SHAS.setupNode,
    );
    expect(setupNode).toBeDefined();
    expect(setupNode?.with?.["registry-url"]).toBeUndefined();
  });

  it("run: bloklarında güvenilmeyen ${{ github.event.* }} kabuk interpolasyonu içermez", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string");

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const runBlock of runBlocks) {
      expect(runBlock).not.toMatch(/\$\{\{\s*github\.event\./);
      expect(runBlock).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it("scripts/generate-sbom.mjs tüm yeniden dağıtılan npm + Roslyn bileşenlerini sürümlü purl ile CycloneDX 1.5 SBOM olarak üretir", async () => {
    const sbomScriptPath = path.join(REPO_ROOT, "scripts", "generate-sbom.mjs");
    expect(existsSync(sbomScriptPath), "scripts/generate-sbom.mjs bulunmalı").toBe(true);
    const mod = (await import(
      new URL("../scripts/generate-sbom.mjs", import.meta.url).href
    )) as {
      readonly buildCycloneDxSbom: (options?: { readonly repoRoot?: string; readonly tarballSha256?: string }) => {
        readonly bomFormat: string;
        readonly specVersion: string;
        readonly metadata: { readonly component: { readonly name: string; readonly version: string; readonly purl: string } };
        readonly components: ReadonlyArray<{ readonly name: string; readonly version: string; readonly purl: string }>;
      };
    };

    const sbom = mod.buildCycloneDxSbom({
      repoRoot: REPO_ROOT,
      tarballSha256: "a".repeat(64),
    });
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    expect(sbom.metadata.component.name).toBe("causoryn");
    expect(sbom.metadata.component.purl).toBe(`pkg:npm/causoryn@${sbom.metadata.component.version}`);

    const names = sbom.components.map((c) => c.name);
    for (const requiredComp of [
      "@modelcontextprotocol/sdk",
      "zod",
      "better-sqlite3",
      "typescript",
      "yaml",
      "ajv",
      "Microsoft.CodeAnalysis.Common",
      "Microsoft.CodeAnalysis.CSharp",
    ]) {
      expect(names, `SBOM bileşeni eksik: ${requiredComp}`).toContain(requiredComp);
    }
    for (const comp of sbom.components) {
      expect(comp.version, `SBOM sürümü boş: ${comp.name}`).toMatch(/^\d+\.\d+\.\d+/);
      expect(comp.purl, `SBOM purl sürümü içermeli: ${comp.name}`).toContain(`@${comp.version}`);
    }
  });
});
