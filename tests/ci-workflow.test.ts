/**
 * GitHub Actions CI/CD ve tedarik zinciri güvenliği sözleşme testleri (F-P1-05, K-022, K-025).
 *
 * Kapsam:
 * - Tüm 5 iş akışı (`.github/workflows/{ci,release,security,codeql,scorecard}.yml`)
 *   ve `.github/dependabot.yml` için geçerli YAML ayrıştırması.
 * - Ortak güvenlik kapıları: üst düzey salt-okunur `permissions: { contents: "read" }`,
 *   `concurrency`, `timeout-minutes`, `pull_request_target` yasağı, %100 40-karakter SHA
 *   sabitlemesi + izinli action depo listesi (`ALLOWED_ACTION_REPOS`) + değişmez semver
 *   yorumu (`# vX.Y.Z`) — böylece Dependabot SHA güncellemeleri güvenli biçimde geçer,
 *   `persist-credentials: false`, Linux job'larında ilk adım `step-security/harden-runner`
 *   (Docker-dışı job'larda `disable-sudo-and-containers: true`; Docker tabanlı Scorecard'da
 *   container runtime korunur), ve `run:` bloklarında sıfır `${{ ... }}` interpolasyonu.
 * - CI (`ci.yml`): 3-OS matrisi (`ubuntu-latest`, `windows-latest`, sabit `macos-15`), deterministik Release + RestoreLockedMode Roslyn + locked Rust,
 *   `npm audit --audit-level=high`, cross-platform `export-public-tree.mjs --verify-temp` ve testler.
 * - Release (`release.yml`): korumalı `v*.*.*` etiket tabanlı üç-job hermetik CD (`verify-and-test`
 *   salt-okunur → `build-and-pack` temiz checkout, sıfır test, `verify-package-ready.mjs` hemen
 *   ardından `npm pack` → `publish` OIDC/environment), hermetik derleme (`cache: npm` YOK),
 *   `fetch-depth: 0` + `origin/main` ata doğrulaması, tek-tarball doğrulaması, derin izole smoke
 *   testi (`--version`, `doctor --json`, MCP `initialize`), CycloneDX SBOM, `sha256sum -c`,
 *   `attest-build-provenance`, prerelease-farkında OIDC `npm publish` (`--tag next`) ve idempotent
 *   `gh release create --verify-tag`.
 * - Security (`security.yml`): fail-closed `zizmor`, PR `dependency-review-action` (yüksek açık +
 *   güncel SPDX copyleft lisans engeli) ve fail-closed çoklu-ekosistem (`npm` + `--locked-mode`
 *   NuGet JSON taraması, `NU1900` uyarılarında fail-closed).
 * - CodeQL (`codeql.yml`): 5 dil matrisi, doğru Go `setupGo < init < goBuild < analyze` sırası
 *   ve fork PR güvenli `upload:` ifadesi.
 * - OpenSSF Scorecard (`scorecard.yml`): `publish_results: true` iş akışı kısıtlarına tam uyum.
 * - Dependabot (`.github/dependabot.yml`): monorepo workspace kapsamı, tedarik zinciri `cooldown`
 *   ve `patterns` tanımlı `groups`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const CI_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "ci.yml");
const RELEASE_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "release.yml");
const SECURITY_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "security.yml");
const CODEQL_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "codeql.yml");
const SCORECARD_WORKFLOW_PATH = path.join(WORKFLOWS_DIR, "scorecard.yml");
const DEPENDABOT_PATH = path.join(REPO_ROOT, ".github", "dependabot.yml");

const EXPECTED_WORKFLOW_FILES = [
  "ci.yml",
  "codeql.yml",
  "release.yml",
  "scorecard.yml",
  "security.yml",
] as const;

const ALLOWED_ACTION_REPOS = new Set<string>([
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-dotnet",
  "actions/setup-python",
  "actions/setup-go",
  "actions/upload-artifact",
  "actions/download-artifact",
  "actions/attest-build-provenance",
  "actions/attest",
  "actions/dependency-review-action",
  "github/codeql-action/init",
  "github/codeql-action/analyze",
  "github/codeql-action/upload-sarif",
  "dtolnay/rust-toolchain",
  "zizmorcore/zizmor-action",
  "ossf/scorecard-action",
  "step-security/harden-runner",
]);

const UNTAGGED_UPSTREAM_ACTION_REPOS = new Set<string>(["dtolnay/rust-toolchain"]);

const SCORECARD_APPROVED_ACTION_REPOS = new Set<string>([
  "step-security/harden-runner",
  "actions/checkout",
  "ossf/scorecard-action",
  "actions/upload-artifact",
  "github/codeql-action/upload-sarif",
]);

const SHA_PINNED_USES_RE = /^([^@\s]+)@([0-9a-f]{40})$/;

function parsePinnedUses(uses: string): { readonly repo: string; readonly sha: string } | null {
  const match = SHA_PINNED_USES_RE.exec(uses);
  if (!match || !match[1] || !match[2]) return null;
  return { repo: match[1], sha: match[2] };
}

function usesPinnedAction(step: WorkflowStep | undefined, expectedRepo: string): boolean {
  if (typeof step?.uses !== "string") return false;
  const parsed = parsePinnedUses(step.uses);
  return parsed !== null && parsed.repo === expectedRepo;
}

const DETERMINISTIC_ROSLYN_BUILD =
  "dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en -p:RestoreLockedMode=true";

const LOCKED_RUST_BUILD = "cargo build --manifest-path native/rust-worker/Cargo.toml --locked";

const PREPACK_VERIFY_CMD = "node packages/causoryn/scripts/verify-package-ready.mjs";

const PUBLIC_EXPORT_GATE_CMD = "node scripts/export-public-tree.mjs --verify-temp --ref HEAD";

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly shell?: string;
  readonly uses?: string;
  readonly "working-directory"?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly run?: string;
}

interface WorkflowMatrixInclude {
  readonly language?: string;
  readonly "build-mode"?: string;
}

interface WorkflowJob {
  readonly name?: string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly "runs-on"?: string;
  readonly environment?: string | Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly "timeout-minutes"?: number;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly container?: unknown;
  readonly services?: unknown;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: {
      readonly os?: readonly string[];
      readonly include?: readonly WorkflowMatrixInclude[];
    };
  };
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowConcurrency {
  readonly group?: string;
  readonly "cancel-in-progress"?: boolean | string;
}

interface WorkflowDoc {
  readonly name?: string;
  readonly permissions?: Readonly<Record<string, unknown>> | string;
  readonly concurrency?: WorkflowConcurrency;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly on?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

interface DependabotCooldown {
  readonly "default-days"?: number;
  readonly "semver-major-days"?: number;
  readonly "semver-minor-days"?: number;
  readonly "semver-patch-days"?: number;
}

interface DependabotGroup {
  readonly patterns?: readonly string[];
  readonly "dependency-type"?: string;
  readonly "update-types"?: readonly string[];
}

interface DependabotIgnore {
  readonly "dependency-name"?: string;
  readonly versions?: readonly string[];
  readonly "update-types"?: readonly string[];
}

interface DependabotUpdate {
  readonly "package-ecosystem"?: string;
  readonly directory?: string;
  readonly directories?: readonly string[];
  readonly schedule?: Readonly<Record<string, unknown>>;
  readonly cooldown?: DependabotCooldown;
  readonly ignore?: readonly DependabotIgnore[];
  readonly groups?: Readonly<Record<string, DependabotGroup>>;
  readonly labels?: readonly string[];
}

interface DependabotDoc {
  readonly version?: number;
  readonly updates?: readonly DependabotUpdate[];
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

describe("Tüm GitHub Actions iş akışları — ortak tedarik zinciri güvenlik sözleşmesi (K-025)", () => {
  it("tam olarak 5 beklenen iş akışı dosyasını barındırır", () => {
    const files = readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(files).toEqual([...EXPECTED_WORKFLOW_FILES]);
  });

  it("her iş akışında salt-okunur üst düzey permissions, concurrency, timeout-minutes, SHA-sabitli izinli action, değişmez semver yorumu, doğru harden-runner ve sıfır ${{ }} run interpolasyonu vardır", () => {
    for (const fileName of EXPECTED_WORKFLOW_FILES) {
      const fullPath = path.join(WORKFLOWS_DIR, fileName);
      const label = `.github/workflows/${fileName}`;
      const { raw, doc } = loadWorkflow(fullPath, label);

      expect(doc.permissions, `${label} üst düzeyde salt-okunur izin tanımlamalı`).toEqual({
        contents: "read",
      });
      expect(doc.on?.["pull_request_target"], `${label} pull_request_target kullanamaz`).toBeUndefined();
      expect(doc.concurrency?.group, `${label} concurrency.group tanımlamalı`).toBeTruthy();
      expect(
        doc.concurrency?.["cancel-in-progress"],
        `${label} concurrency.cancel-in-progress tanımlamalı`,
      ).toBeDefined();

      // Kayan major tag (# v7, # v4), hareketli dal (# stable) veya bilinmeyen ref (# pinned-commit)
      // yorumları zizmor ref-version-mismatch bulgusu üretmemesi için kullanılmaz;
      // etiketli tüm action'larda değişmez semver yorumu (# vX.Y.Z) zorunludur:
      for (const line of raw.split(/\r?\n/)) {
        const usesMatch = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s*(#.*))?$/.exec(line);
        if (!usesMatch) continue;
        const usesRef = (usesMatch[1] ?? "").replace(/^(['"])(.*)\1$/, "$2");
        const comment = usesMatch[2] ?? "";
        expect(line, `${label} kayan major tag yorumu kullanmamalı: ${line.trim()}`).not.toMatch(
          /#\s*v\d+\s*$/,
        );
        expect(line, `${label} hareketli # stable yorumu kullanmamalı: ${line.trim()}`).not.toMatch(
          /#\s*stable\s*$/,
        );
        expect(line, `${label} bilinmeyen # pinned-commit yorumu kullanmamalı: ${line.trim()}`).not.toMatch(
          /#\s*pinned-commit\s*$/,
        );
        const parsedRef = parsePinnedUses(usesRef);
        expect(parsedRef, `${label} ham satırda 40-karakter SHA sabitlemesi zorunlu: ${line.trim()}`).not.toBeNull();
        if (parsedRef && !UNTAGGED_UPSTREAM_ACTION_REPOS.has(parsedRef.repo)) {
          expect(
            comment,
            `${label} değişmez semver yorumu (# vX.Y.Z) taşımalı: ${line.trim()}`,
          ).toMatch(/^#\s*v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/);
        }
      }

      const jobs = Object.entries(doc.jobs ?? {});
      expect(jobs.length, `${label} en az bir job içermeli`).toBeGreaterThanOrEqual(1);

      for (const [jobId, job] of jobs) {
        const jobLabel = `${label}#${jobId}`;
        expect(job["timeout-minutes"], `${jobLabel} timeout-minutes tanımlamalı`).toBeGreaterThan(0);
        expect(job["timeout-minutes"], `${jobLabel} timeout-minutes <= 60 olmalı`).toBeLessThanOrEqual(60);

        const steps = job.steps ?? [];
        expect(steps.length, `${jobLabel} en az bir step içermeli`).toBeGreaterThan(0);

        const runsOn = String(job["runs-on"] ?? "");
        const hasLinux =
          runsOn.includes("ubuntu") ||
          (job.strategy?.matrix?.os ?? []).some((osName) => osName.includes("ubuntu"));
        const usesDockerAction = steps.some((s) => usesPinnedAction(s, "ossf/scorecard-action"));

        if (hasLinux) {
          const firstStep = steps[0];
          expect(
            usesPinnedAction(firstStep, "step-security/harden-runner"),
            `${jobLabel} ilk adım SHA-sabitli step-security/harden-runner olmalı`,
          ).toBe(true);
          expect(firstStep?.with?.["egress-policy"], `${jobLabel} egress-policy: audit`).toBe("audit");
          expect(
            firstStep?.with?.["disable-sudo"],
            `${jobLabel} eski disable-sudo anahtarını kullanmamalı`,
          ).toBeUndefined();

          if (usesDockerAction) {
            // Docker container action (ossf/scorecard-action) container runtime gerektirir:
            expect(
              firstStep?.with?.["disable-sudo-and-containers"],
              `${jobLabel} Docker action kullandığı için disable-sudo-and-containers: true kullanamaz`,
            ).not.toBe(true);
          } else {
            expect(
              firstStep?.with?.["disable-sudo-and-containers"],
              `${jobLabel} Docker-dışı Linux job'ında disable-sudo-and-containers: true zorunlu`,
            ).toBe(true);
          }

          if (runsOn.includes("matrix.os")) {
            expect(firstStep?.if, `${jobLabel} çoklu-OS matriste Linux korumalı olmalı`).toContain(
              "runner.os == 'Linux'",
            );
          }
        }

        for (const step of steps) {
          if (typeof step.uses === "string") {
            const parsedUses = parsePinnedUses(step.uses);
            expect(parsedUses, `${jobLabel} 40-karakter SHA sabitlemesi zorunlu: ${step.uses}`).not.toBeNull();
            expect(
              parsedUses !== null && ALLOWED_ACTION_REPOS.has(parsedUses.repo),
              `${jobLabel} doğrulanmış repo allowlist dışı action kullanıyor: ${step.uses}`,
            ).toBe(true);

            if (parsedUses?.repo === "actions/checkout") {
              expect(
                step.with?.["persist-credentials"],
                `${jobLabel} checkout persist-credentials: false zorunlu`,
              ).toBe(false);
            }
          }

          // En sıkı script-injection koruması: HİÇBİR run: bloğunda ${{ ... }} interpolasyonu yok:
          if (typeof step.run === "string") {
            expect(step.run, `${jobLabel} run: bloğunda ${{ }} interpolasyonu yasak`).not.toMatch(
              /\$\{\{/,
            );
          }
        }
      }
    }
  });

  it("SHA sabitleme ve izinli depo doğrulayıcısı Dependabot SHA güncellemelerini kabul eder, etiketsiz veya yabancı action'ları reddeder", () => {
    const validBump = parsePinnedUses(
      "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
    );
    expect(validBump).toEqual({
      repo: "actions/attest-build-provenance",
      sha: "4d101475d8b20a2381f78447822ac1eab6504dd8",
    });
    expect(ALLOWED_ACTION_REPOS.has(validBump!.repo)).toBe(true);

    // Kayan tag, kısa SHA veya büyük harfli SHA reddedilir:
    expect(parsePinnedUses("actions/attest-build-provenance@v4")).toBeNull();
    expect(parsePinnedUses("actions/checkout@main")).toBeNull();
    expect(parsePinnedUses("actions/checkout@3d3c42e")).toBeNull();
    expect(parsePinnedUses("actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1")).toBeNull();

    // İzinli olmayan üçüncü parti depo reddedilir:
    const unlisted = parsePinnedUses("untrusted-org/some-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(unlisted).not.toBeNull();
    expect(ALLOWED_ACTION_REPOS.has(unlisted!.repo)).toBe(false);
  });
});

describe(".github/workflows/ci.yml — CI sözleşmesi ve SHA-sabitli güvenlik kapıları", () => {
  it("dosya mevcuttur, geçerli YAML olarak ayrışır, salt-okunur job izni ve main-korumalı concurrency tanımlar", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.jobs?.["verify"]?.permissions).toEqual({ contents: "read" });
    expect(String(doc.concurrency?.["cancel-in-progress"] ?? "")).toContain("refs/heads/main");
  });

  it("yalnızca main üzerinde push ve pull_request ile tetiklenir; pull_request_target kullanmaz", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const triggers = doc.on;
    expect(triggers).toBeDefined();
    expect(triggers?.["pull_request_target"]).toBeUndefined();
    expect(triggers?.["push"]).toEqual({ branches: ["main"] });
    expect(triggers?.["pull_request"]).toEqual({ branches: ["main"] });
  });

  it("ubuntu-latest, windows-latest ve sabitlenmiş macos-15 üzerinde fail-fast: false matris tanımlar", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const jobs = Object.values(doc.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const matrixJob = jobs.find((job) => job.strategy?.matrix !== undefined);
    expect(matrixJob, "matris tanımlı CI job bulunmalı").toBeDefined();
    expect(matrixJob?.strategy?.["fail-fast"]).toBe(false);
    expect(matrixJob?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "windows-latest",
      "macos-15",
    ]);
    expect(matrixJob?.["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("TÜM uses: eylemlerini 40 karakterlik doğrulanmış commit SHA'larına sabitler", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const steps = collectAllSteps(doc);
    const usesSteps = steps.filter((step): step is WorkflowStep & { readonly uses: string } =>
      typeof step.uses === "string",
    );
    expect(usesSteps.length).toBeGreaterThanOrEqual(7);

    const checkout = usesSteps.find((step) => usesPinnedAction(step, "actions/checkout"));
    expect(checkout).toBeDefined();
    expect(checkout?.with).toEqual({ "persist-credentials": false });

    const setupNode = usesSteps.find((step) => usesPinnedAction(step, "actions/setup-node"));
    expect(setupNode).toBeDefined();
    expect(String(setupNode?.with?.["node-version"])).toBe("24");

    const setupDotnet = usesSteps.find((step) => usesPinnedAction(step, "actions/setup-dotnet"));
    expect(setupDotnet).toBeDefined();
    expect(setupDotnet?.with?.["dotnet-version"]).toBe("10.0.x");

    const setupPython = usesSteps.find((step) => usesPinnedAction(step, "actions/setup-python"));
    expect(setupPython).toBeDefined();
    expect(String(setupPython?.with?.["python-version"])).toBe("3.12");

    const setupGo = usesSteps.find((step) => usesPinnedAction(step, "actions/setup-go"));
    expect(setupGo).toBeDefined();
    expect(setupGo?.with?.["go-version-file"]).toBe("native/go-worker/go.mod");
    expect(setupGo?.with?.["cache"]).toBe(false);

    const setupRust = usesSteps.find((step) => usesPinnedAction(step, "dtolnay/rust-toolchain"));
    expect(setupRust).toBeDefined();
  });

  it("deterministik RestoreLockedMode Roslyn, --locked Rust, npm audit, shell:bash'sız public-export --verify-temp ve kalite kapılarını doğru sırayla yürütür", () => {
    const { doc } = loadWorkflow(CI_WORKFLOW_PATH, ".github/workflows/ci.yml");
    const steps = collectAllSteps(doc);
    const runBlocks = steps
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string")
      .map((cmd) => cmd.trim());

    for (const buildCmd of [DETERMINISTIC_ROSLYN_BUILD, LOCKED_RUST_BUILD] as const) {
      expect(
        runBlocks.some((block) => block.includes(buildCmd)),
        `native derleme komutu bulunmalı: ${buildCmd}`,
      ).toBe(true);
    }

    const requiredGates = [
      "npm ci --ignore-scripts",
      "npm audit --audit-level=high",
      "npm run typecheck",
      "npm run build",
      "npm run build:bundle --workspace packages/mcp-server",
      "npm run build:package --workspace packages/causoryn",
      PREPACK_VERIFY_CMD,
      "npm run lint",
      "npm run secret-scan",
      PUBLIC_EXPORT_GATE_CMD,
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
    const buildPkgIdx = gateIndices[5] ?? -1;
    const verifyPkgIdx = gateIndices[6] ?? -1;
    const exportIdx = gateIndices[9] ?? -1;
    const testIdx = gateIndices[10] ?? -1;

    for (const idx of gateIndices.slice(1)) {
      expect(idx).toBeGreaterThanOrEqual(installIdx);
    }
    expect(verifyPkgIdx).toBeGreaterThan(buildPkgIdx);
    expect(verifyPkgIdx).toBeLessThan(testIdx);
    expect(exportIdx).toBeGreaterThan(installIdx);
    expect(exportIdx).toBeLessThan(testIdx);

    // Windows'ta MSYS2 GNU tar çatışmasını önlemek için public-export adımında shell: bash kullanılmaz:
    const exportStep = steps.find((step) => (step.run ?? "").includes("export-public-tree.mjs"));
    expect(exportStep?.shell).toBeUndefined();

    for (const buildCmd of [DETERMINISTIC_ROSLYN_BUILD, LOCKED_RUST_BUILD] as const) {
      const nativeIdx = runBlocks.findIndex((block) => block.includes(buildCmd));
      expect(nativeIdx).toBeLessThan(testIdx);
    }
  });
});

describe(".github/workflows/release.yml — üç-job hermetik OIDC Trusted Publishing & SLSA CD sözleşmesi (Task 1.4)", () => {
  it("dosya mevcuttur, üst düzey salt-okunur izin + iptal-edilmez concurrency tanımlar ve v*.*.* tag + workflow_dispatch ile tetiklenir", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);

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

  it("verify-and-test (salt-okunur) → build-and-pack (temiz checkout, sıfır test, salt-okunur) → publish (environment: release + OIDC) 3-job zincirini SLSA ilkeleriyle ayırır", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    expect(Object.keys(doc.jobs ?? {})).toEqual(["verify-and-test", "build-and-pack", "publish"]);

    const verifyJob = doc.jobs?.["verify-and-test"];
    const buildPackJob = doc.jobs?.["build-and-pack"];
    const publishJob = doc.jobs?.["publish"];

    expect(verifyJob, "salt-okunur verify-and-test job tanımlı olmalı").toBeDefined();
    expect(buildPackJob, "hermetik build-and-pack job tanımlı olmalı").toBeDefined();
    expect(publishJob, "ayrıcalıklı publish job tanımlı olmalı").toBeDefined();

    // 1. verify-and-test: salt-okunur, YAZMA/OIDC yetkisi ve release environment YOK:
    expect(verifyJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(verifyJob?.needs).toBeUndefined();
    expect(verifyJob?.environment).toBeUndefined();
    expect(verifyJob?.permissions).toEqual({ contents: "read" });

    const verifyRuns = (verifyJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(verifyRuns).not.toContain("npm pack");
    expect(verifyRuns).not.toContain("npm publish");

    // 2. build-and-pack: verify-and-test bağımlı, salt-okunur, SIFIR test yürütmesi:
    expect(buildPackJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(buildPackJob?.needs).toBe("verify-and-test");
    expect(buildPackJob?.environment).toBeUndefined();
    expect(buildPackJob?.permissions).toEqual({ contents: "read" });

    const buildPackRuns = (buildPackJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(buildPackRuns, "build-and-pack sıfır npm test içermeli").not.toMatch(/\bnpm\s+test\b/);
    expect(buildPackRuns, "build-and-pack sıfır vitest içermeli").not.toMatch(/\bvitest\b/);
    expect(buildPackRuns).not.toContain("npm publish");

    // 3. publish: build-and-pack bağımlı, release environment + OIDC, derleme/test kodu çalıştırmaz:
    expect(publishJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(publishJob?.needs).toBe("build-and-pack");
    expect(publishJob?.environment).toBe("release");
    expect(publishJob?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });

    const publishRuns = (publishJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(publishRuns).not.toContain("npm ci");
    expect(publishRuns).not.toMatch(/\bnpm\s+test\b/);
    expect(publishRuns).not.toMatch(/\bvitest\b/);
    expect(publishRuns).not.toContain("cargo build");
    expect(publishRuns).not.toContain("dotnet build");
    expect(publishRuns).not.toContain("npm pack");
  });

  it("fetch-depth: 0 + temiz checkout'lar, hermetik setup-node (3 job'da cache/registry-url yok), artifact paylaşımı ve attest-build-provenance içerir", () => {
    const { doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const verifySteps = doc.jobs?.["verify-and-test"]?.steps ?? [];
    const buildPackSteps = doc.jobs?.["build-and-pack"]?.steps ?? [];
    const publishSteps = doc.jobs?.["publish"]?.steps ?? [];

    const verifyCheckout = verifySteps.find((step) => usesPinnedAction(step, "actions/checkout"));
    expect(verifyCheckout).toBeDefined();
    expect(verifyCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(verifyCheckout?.with?.["fetch-depth"]).toBe(0);
    expect(verifyCheckout?.with?.["ref"]).toBeUndefined();

    const buildPackCheckout = buildPackSteps.find((step) => usesPinnedAction(step, "actions/checkout"));
    expect(buildPackCheckout, "build-and-pack temiz checkout yapmalı").toBeDefined();
    expect(buildPackCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(buildPackCheckout?.with?.["ref"]).toBeUndefined();

    // Hiçbir setup-node adımında cache veya registry-url yok ve setup-node@v7'de
    // package-manager-cache: false açıkça verilir (zizmor cache-poisoning & OIDC ENEEDAUTH kapalı):
    const setupNodes = collectAllSteps(doc).filter((step) =>
      usesPinnedAction(step, "actions/setup-node"),
    );
    expect(setupNodes.length).toBe(3);
    for (const sn of setupNodes) {
      expect(sn.with?.["cache"]).toBeUndefined();
      expect(sn.with?.["package-manager-cache"]).toBe(false);
      expect(sn.with?.["registry-url"]).toBeUndefined();
    }

    const upload = buildPackSteps.find((step) => usesPinnedAction(step, "actions/upload-artifact"));
    expect(upload?.with?.["name"]).toBe("release-artifacts");
    expect(
      verifySteps.some((step) => usesPinnedAction(step, "actions/upload-artifact")),
      "verify-and-test artifact yüklememeli",
    ).toBe(false);

    const download = publishSteps.find((step) => usesPinnedAction(step, "actions/download-artifact"));
    expect(download?.with?.["name"]).toBe("release-artifacts");

    const attest = publishSteps.find(
      (step) =>
        usesPinnedAction(step, "actions/attest-build-provenance") ||
        usesPinnedAction(step, "actions/attest"),
    );
    expect(attest, "actions/attest-build-provenance (veya actions/attest) SHA-sabitli adımı bulunmalı").toBeDefined();
    expect(String(attest?.with?.["subject-path"] ?? "")).toContain("release-artifacts");
  });

  it("fail-closed sıra ile verify-and-test, hermetik build-and-pack (verify-package-ready.mjs HEMEN ÖNCE npm pack), tek-tarball + derin MCP smoke testi, SBOM, sha256sum -c, prerelease-farkında OIDC publish ve idempotent GitHub Release yürütür", () => {
    const { raw, doc } = loadWorkflow(RELEASE_WORKFLOW_PATH, ".github/workflows/release.yml");
    const verifySteps = doc.jobs?.["verify-and-test"]?.steps ?? [];
    const buildPackSteps = doc.jobs?.["build-and-pack"]?.steps ?? [];
    const publishSteps = doc.jobs?.["publish"]?.steps ?? [];

    const findIdx = (steps: readonly WorkflowStep[], predicate: (s: WorkflowStep) => boolean): number =>
      steps.findIndex(predicate);

    // Job 1: verify-and-test
    const vTagCheckIdx = findIdx(
      verifySteps,
      (s) =>
        (s.run ?? "").includes("merge-base") &&
        (s.run ?? "").includes("--is-ancestor") &&
        (s.run ?? "").includes("refs/remotes/origin/main") &&
        (s.run ?? "").includes("packages/causoryn/package.json"),
    );
    const vInstallIdx = findIdx(verifySteps, (s) => (s.run ?? "").includes("npm ci --ignore-scripts"));
    const vAuditIdx = findIdx(verifySteps, (s) => (s.run ?? "").includes("npm audit --audit-level=high"));
    const vRoslynIdx = findIdx(verifySteps, (s) => (s.run ?? "").includes(DETERMINISTIC_ROSLYN_BUILD));
    const vRustIdx = findIdx(verifySteps, (s) => (s.run ?? "").includes(LOCKED_RUST_BUILD));
    const vTypecheckIdx = findIdx(verifySteps, (s) => (s.run ?? "").trim() === "npm run typecheck");
    const vLintIdx = findIdx(verifySteps, (s) => (s.run ?? "").trim() === "npm run lint");
    const vSecretIdx = findIdx(verifySteps, (s) => (s.run ?? "").trim() === "npm run secret-scan");
    const vExportIdx = findIdx(verifySteps, (s) => (s.run ?? "").includes(PUBLIC_EXPORT_GATE_CMD));
    const vTestIdx = findIdx(verifySteps, (s) =>
      (s.run ?? "")
        .split(/\r?\n/)
        .some((line) => line.trim() === "npm test"),
    );

    const verifyOrdered = [
      ["verify.tagCheck", vTagCheckIdx],
      ["verify.install", vInstallIdx],
      ["verify.audit", vAuditIdx],
      ["verify.roslyn", vRoslynIdx],
      ["verify.rust", vRustIdx],
      ["verify.typecheck", vTypecheckIdx],
      ["verify.lint", vLintIdx],
      ["verify.secretScan", vSecretIdx],
      ["verify.exportGate", vExportIdx],
      ["verify.test", vTestIdx],
    ] as const;

    for (const [name, idx] of verifyOrdered) {
      expect(idx, `release.yml verify-and-test adımı eksik: ${name}`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < verifyOrdered.length; i += 1) {
      const prev = verifyOrdered[i - 1]!;
      const curr = verifyOrdered[i]!;
      expect(
        curr[1],
        `verify-and-test adım sırası bozuk: ${prev[0]}(${prev[1]}) < ${curr[0]}(${curr[1]}) olmalı`,
      ).toBeGreaterThan(prev[1]);
    }

    // Job 2: build-and-pack (hermetic, zero test execution, verify-package-ready.mjs IMMEDIATELY before npm pack)
    const bpInstallIdx = findIdx(buildPackSteps, (s) => (s.run ?? "").includes("npm ci --ignore-scripts"));
    const bpRoslynIdx = findIdx(buildPackSteps, (s) => (s.run ?? "").includes(DETERMINISTIC_ROSLYN_BUILD));
    const bpBuildIdx = findIdx(buildPackSteps, (s) => (s.run ?? "").trim() === "npm run build");
    const bpBundleIdx = findIdx(buildPackSteps, (s) =>
      (s.run ?? "").includes("npm run build:bundle --workspace packages/mcp-server"),
    );
    const bpPkgBuildIdx = findIdx(buildPackSteps, (s) =>
      (s.run ?? "").includes("npm run build:package --workspace packages/causoryn"),
    );
    const bpVerifyReadyIdx = findIdx(buildPackSteps, (s) =>
      (s.run ?? "").includes(PREPACK_VERIFY_CMD),
    );
    const bpPackIdx = findIdx(buildPackSteps, (s) => (s.run ?? "").includes("npm pack"));
    const bpSmokeIdx = findIdx(
      buildPackSteps,
      (s) =>
        (s.run ?? "").includes("--version") &&
        (s.run ?? "").includes('"$ACTUAL_VERSION" != "$EXPECTED_VERSION"') &&
        (s.run ?? "").includes("doctor --json") &&
        (s.run ?? "").includes('"initialize"'),
    );
    const bpSbomIdx = findIdx(buildPackSteps, (s) =>
      (s.run ?? "").includes("scripts/generate-sbom.mjs"),
    );
    const bpUploadIdx = findIdx(buildPackSteps, (s) =>
      usesPinnedAction(s, "actions/upload-artifact"),
    );

    const buildPackOrdered = [
      ["buildPack.install", bpInstallIdx],
      ["buildPack.roslyn", bpRoslynIdx],
      ["buildPack.build", bpBuildIdx],
      ["buildPack.bundle", bpBundleIdx],
      ["buildPack.package", bpPkgBuildIdx],
      ["buildPack.verifyReady", bpVerifyReadyIdx],
      ["buildPack.pack", bpPackIdx],
      ["buildPack.sbom", bpSbomIdx],
      ["buildPack.smoke", bpSmokeIdx],
      ["buildPack.upload", bpUploadIdx],
    ] as const;

    for (const [name, idx] of buildPackOrdered) {
      expect(idx, `release.yml build-and-pack adımı eksik: ${name}`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < buildPackOrdered.length; i += 1) {
      const prev = buildPackOrdered[i - 1]!;
      const curr = buildPackOrdered[i]!;
      expect(
        curr[1],
        `build-and-pack adım sırası bozuk: ${prev[0]}(${prev[1]}) < ${curr[0]}(${curr[1]}) olmalı`,
      ).toBeGreaterThan(prev[1]);
    }
    // Critical Task 1.4 invariant: verify-package-ready.mjs is the IMMEDIATE gate before npm pack (zero steps between them)
    expect(
      bpPackIdx - bpVerifyReadyIdx,
      "verify-package-ready.mjs, build-and-pack içinde npm pack adımının HEMEN öncesindeki son kapı olmalı",
    ).toBe(1);
    // SHA256SUMS.txt + SBOM are generated IMMEDIATELY after npm pack, before any smoke/test
    // step runs against the packed tarball, so the checksums describe the artifact exactly as packed.
    expect(
      bpSbomIdx - bpPackIdx,
      "generate-sbom.mjs (SHA256SUMS.txt + SBOM) must be the step immediately after npm pack in build-and-pack",
    ).toBe(1);

    // Job 3: publish
    const pDownloadIdx = findIdx(publishSteps, (s) =>
      usesPinnedAction(s, "actions/download-artifact"),
    );
    const pChecksumIdx = findIdx(publishSteps, (s) =>
      (s.run ?? "").includes("sha256sum -c SHA256SUMS.txt"),
    );
    const pAttestIdx = findIdx(
      publishSteps,
      (s) =>
        usesPinnedAction(s, "actions/attest-build-provenance") ||
        usesPinnedAction(s, "actions/attest"),
    );
    const pPublishIdx = findIdx(
      publishSteps,
      (s) =>
        (s.run ?? "").includes('npm publish "./$TGZ_FILE"') &&
        (s.run ?? "").includes("--provenance") &&
        (s.run ?? "").includes("--access public") &&
        (s.run ?? "").includes("--tag next"),
    );
    const pGhReleaseIdx = findIdx(
      publishSteps,
      (s) =>
        s.env?.["GH_REPO"] === "${{ github.repository }}" &&
        (s.run ?? "").includes("gh release create") &&
        (s.run ?? "").includes('--repo "$GH_REPO"') &&
        (s.run ?? "").includes("--verify-tag") &&
        (s.run ?? "").includes("--prerelease") &&
        (s.run ?? "").includes("gh release upload"),
    );

    const publishOrdered = [
      ["publish.download", pDownloadIdx],
      ["publish.checksum", pChecksumIdx],
      ["publish.attest", pAttestIdx],
      ["publish.npmPublish", pPublishIdx],
      ["publish.ghRelease", pGhReleaseIdx],
    ] as const;

    for (const [name, idx] of publishOrdered) {
      expect(idx, `release.yml publish adımı eksik: ${name}`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < publishOrdered.length; i += 1) {
      const prev = publishOrdered[i - 1]!;
      const curr = publishOrdered[i]!;
      expect(
        curr[1],
        `publish adım sırası bozuk: ${prev[0]}(${prev[1]}) < ${curr[0]}(${curr[1]}) olmalı`,
      ).toBeGreaterThan(prev[1]);
    }

    // `ls -1 ... | head -n 1` anti-pattern yasak; tek tarball kesin doğrulanır:
    expect(raw).not.toContain("ls -1 release-artifacts/*.tgz");
    expect(raw).not.toContain("secrets.NPM_TOKEN");
    expect(raw).not.toContain("NODE_AUTH_TOKEN");
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

describe(".github/workflows/security.yml — zizmor, Dependency Review ve çoklu-ekosistem güvenlik denetimi", () => {
  it("push, pull_request, haftalık schedule ve workflow_dispatch ile tetiklenir", () => {
    const { doc } = loadWorkflow(SECURITY_WORKFLOW_PATH, ".github/workflows/security.yml");
    expect(doc.on?.["push"]).toEqual({ branches: ["main"] });
    expect(doc.on?.["pull_request"]).toEqual({ branches: ["main"] });
    expect(Array.isArray(doc.on?.["schedule"])).toBe(true);
    expect("workflow_dispatch" in (doc.on ?? {})).toBe(true);
  });

  it("zizmor job'ı fail-closed (advanced-security: false, annotations: true, strict-collection: true) ve salt-okunur çalışır", () => {
    const { doc } = loadWorkflow(SECURITY_WORKFLOW_PATH, ".github/workflows/security.yml");
    const zizmorJob = doc.jobs?.["zizmor"];
    expect(zizmorJob, "zizmor job tanımlı olmalı").toBeDefined();
    expect(zizmorJob?.permissions).toEqual({ contents: "read" });

    const zizmorStep = (zizmorJob?.steps ?? []).find((step) =>
      usesPinnedAction(step, "zizmorcore/zizmor-action"),
    );
    expect(zizmorStep, "SHA-sabitli zizmor-action adımı bulunmalı").toBeDefined();
    expect(zizmorStep?.with?.["strict-collection"]).toBe(true);
    expect(zizmorStep?.with?.["persona"]).toBe("regular");
    expect(zizmorStep?.with?.["min-severity"]).toBe("medium");
    expect(zizmorStep?.with?.["advanced-security"]).toBe(false);
    expect(zizmorStep?.with?.["annotations"]).toBe(true);
    expect(zizmorStep?.with?.["fail-on-no-inputs"]).toBe(true);
  });

  it("dependency-review job'ı yalnızca PR'larda çalışır, high+ açıkları ve güncel SPDX copyleft lisanslarını reddeder", () => {
    const { doc } = loadWorkflow(SECURITY_WORKFLOW_PATH, ".github/workflows/security.yml");
    const depJob = doc.jobs?.["dependency-review"];
    expect(depJob, "dependency-review job tanımlı olmalı").toBeDefined();
    expect(depJob?.if).toBe("github.event_name == 'pull_request'");
    expect(depJob?.permissions).toEqual({ contents: "read" });

    const depStep = (depJob?.steps ?? []).find((step) =>
      usesPinnedAction(step, "actions/dependency-review-action"),
    );
    expect(depStep, "SHA-sabitli dependency-review-action adımı bulunmalı").toBeDefined();
    expect(depStep?.with?.["fail-on-severity"]).toBe("high");
    expect(depStep?.with?.["comment-summary-in-pr"]).toBe("never");
    const denied = String(depStep?.with?.["deny-licenses"] ?? "");
    for (const spdx of [
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
      "AGPL-3.0-only",
      "AGPL-3.0-or-later",
      "LGPL-2.1-only",
      "LGPL-3.0-only",
    ]) {
      expect(denied, `modern SPDX copyleft kimliği eksik: ${spdx}`).toContain(spdx);
    }
  });

  it("dependency-audit job'ı npm audit, --locked-mode NuGet restore ve NU1900-korumalı fail-closed JSON taraması çalıştırır", () => {
    const { doc } = loadWorkflow(SECURITY_WORKFLOW_PATH, ".github/workflows/security.yml");
    const auditJob = doc.jobs?.["dependency-audit"];
    expect(auditJob, "dependency-audit job tanımlı olmalı").toBeDefined();
    expect(auditJob?.permissions).toEqual({ contents: "read" });

    const joined = (auditJob?.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(joined).toContain("npm audit --audit-level=high");
    expect(joined).toContain(
      "dotnet restore native/roslyn-worker/Causoryn.RoslynWorker.csproj --locked-mode",
    );
    expect(joined).toContain("--vulnerable");
    expect(joined).toContain("--include-transitive");
    expect(joined).toContain("--format");
    expect(joined).toContain("json");
    // NU1900 warning'leri dahil report.problems fail-closed kontrol edilmeli + canlı api.nuget.org kaynağı doğrulanmalı
    // (.NET 10 0 açıkta frameworks dizisini çıkardığından frameworkCount===0 ile yanlış-pozitif üretmez):
    expect(joined).not.toContain('p.level === "error"');
    expect(joined).not.toContain("frameworkCount === 0");
    expect(joined).toContain("report.problems");
    expect(joined).toContain("api.nuget.org");
  });
});

describe(".github/workflows/codeql.yml — 5-dil SAST sözleşmesi", () => {
  it("5-dil matrisi, doğru Go adım sırası (setupGo < init < goBuild < analyze) ve fork-PR güvenli upload ile CodeQL v4 çalıştırır", () => {
    const { doc } = loadWorkflow(CODEQL_WORKFLOW_PATH, ".github/workflows/codeql.yml");
    expect(doc.on?.["push"]).toEqual({ branches: ["main"] });
    expect(doc.on?.["pull_request"]).toEqual({ branches: ["main"] });
    expect(Array.isArray(doc.on?.["schedule"])).toBe(true);
    expect("workflow_dispatch" in (doc.on ?? {})).toBe(true);

    const analyzeJob = doc.jobs?.["analyze"];
    expect(analyzeJob, "analyze job tanımlı olmalı").toBeDefined();
    expect(analyzeJob?.permissions).toEqual({
      "security-events": "write",
      actions: "read",
      contents: "read",
    });
    expect(analyzeJob?.strategy?.["fail-fast"]).toBe(false);

    const includes = analyzeJob?.strategy?.matrix?.include ?? [];
    expect(includes).toEqual([
      { language: "javascript-typescript", "build-mode": "none" },
      { language: "python", "build-mode": "none" },
      { language: "csharp", "build-mode": "none" },
      { language: "actions", "build-mode": "none" },
      { language: "go", "build-mode": "manual" },
    ]);

    const steps = analyzeJob?.steps ?? [];
    const goSetupIdx = steps.findIndex((step) => usesPinnedAction(step, "actions/setup-go"));
    const initIdx = steps.findIndex((step) => usesPinnedAction(step, "github/codeql-action/init"));
    const goBuildIdx = steps.findIndex((step) => (step.run ?? "").includes("go build ./..."));
    const analyzeIdx = steps.findIndex((step) => usesPinnedAction(step, "github/codeql-action/analyze"));

    expect(goSetupIdx).toBeGreaterThan(0);
    expect(initIdx).toBeGreaterThan(goSetupIdx);
    expect(goBuildIdx).toBeGreaterThan(initIdx);
    expect(analyzeIdx).toBeGreaterThan(goBuildIdx);

    expect(steps[goSetupIdx]?.if).toContain("matrix.language == 'go'");
    expect(steps[initIdx]?.with?.["queries"]).toBe("security-extended");
    expect(steps[goBuildIdx]?.["working-directory"]).toBe("native/go-worker");

    // Fork PR'larda SARIF 403 çökmesini önleyen upload ifadesi:
    const uploadExpr = String(steps[analyzeIdx]?.with?.["upload"] ?? "");
    expect(uploadExpr).toContain("head.repo.full_name == github.repository");
    expect(uploadExpr).toContain("'always'");
    expect(uploadExpr).toContain("'never'");
  });
});

describe(".github/workflows/scorecard.yml — OpenSSF Scorecard publish_results kısıt uyumu", () => {
  it("branch_protection_rule, schedule, push(main) ve workflow_dispatch ile tetiklenir; pull_request kullanmaz", () => {
    const { doc } = loadWorkflow(SCORECARD_WORKFLOW_PATH, ".github/workflows/scorecard.yml");
    expect(doc.on?.["push"]).toEqual({ branches: ["main"] });
    expect("branch_protection_rule" in (doc.on ?? {})).toBe(true);
    expect(Array.isArray(doc.on?.["schedule"])).toBe(true);
    expect("workflow_dispatch" in (doc.on ?? {})).toBe(true);
    expect(doc.on?.["pull_request"]).toBeUndefined();
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("OpenSSF Scorecard publish_results: true kısıtlarına uyar (env/defaults/run yok, step.env yok, Docker runtime açık, yalnızca 5 onaylı action)", () => {
    const { doc } = loadWorkflow(SCORECARD_WORKFLOW_PATH, ".github/workflows/scorecard.yml");
    expect(doc.env).toBeUndefined();
    expect(doc.defaults).toBeUndefined();

    const analysisJob = doc.jobs?.["analysis"];
    expect(analysisJob, "analysis job tanımlı olmalı").toBeDefined();
    expect(analysisJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(analysisJob?.env).toBeUndefined();
    expect(analysisJob?.defaults).toBeUndefined();
    expect(analysisJob?.container).toBeUndefined();
    expect(analysisJob?.services).toBeUndefined();
    expect(analysisJob?.permissions).toEqual({
      "security-events": "write",
      "id-token": "write",
      contents: "read",
      actions: "read",
    });

    const steps = analysisJob?.steps ?? [];
    for (const step of steps) {
      expect(step.run, "Scorecard publish_results job'ında run: adımı yasaktır").toBeUndefined();
      expect(step.env, "Scorecard publish_results adımlarında env yasaktır").toBeUndefined();
      expect(typeof step.uses).toBe("string");
      const repoPath = (step.uses ?? "").split("@")[0] ?? "";
      expect(
        SCORECARD_APPROVED_ACTION_REPOS.has(repoPath),
        `Scorecard onaylı liste dışı action: ${repoPath}`,
      ).toBe(true);
    }

    const scorecardStep = steps.find((step) => usesPinnedAction(step, "ossf/scorecard-action"));
    expect(scorecardStep?.with?.["publish_results"]).toBe(true);
    expect(scorecardStep?.with?.["results_format"]).toBe("sarif");
    expect(scorecardStep?.with?.["results_file"]).toBe("results.sarif");

    const uploadArtifactStep = steps.find((step) => usesPinnedAction(step, "actions/upload-artifact"));
    expect(uploadArtifactStep?.with?.["path"]).toBe("results.sarif");

    const uploadSarifStep = steps.find((step) =>
      usesPinnedAction(step, "github/codeql-action/upload-sarif"),
    );
    expect(uploadSarifStep?.with?.["sarif_file"]).toBe("results.sarif");
  });
});

describe(".github/dependabot.yml — monorepo workspace kapsamı, cooldown ve gruplama sözleşmesi", () => {
  it("4 ekosistemde >=7 günlük cooldown, tek kök npm workspace directory, TypeScript major koruması, geçerli disk yolları, patterns'lı groups ve github-actions semver-*-days yasağı uygular", () => {
    expect(existsSync(DEPENDABOT_PATH), ".github/dependabot.yml mevcut olmalı").toBe(true);
    const parsed = parse(readFileSync(DEPENDABOT_PATH, "utf8")) as DependabotDoc;
    expect(parsed.version).toBe(2);

    const updates = parsed.updates ?? [];
    const byEco = new Map(updates.map((u) => [u["package-ecosystem"], u]));

    // npm workspaces monorepo tek kök package-lock.json kullanır; bölünmüş directories
    // alt-paketlerde lockfile senkronunu bozup `npm ci` EUSAGE hatasına yol açar:
    const npmCfg = byEco.get("npm");
    expect(npmCfg?.directory).toBe("/");
    expect(npmCfg?.directories).toBeUndefined();
    const tsIgnore = (npmCfg?.ignore ?? []).find(
      (rule) => rule["dependency-name"] === "typescript",
    );
    expect(tsIgnore, "TypeScript 7.0 native Go Compiler API kırılması için major ignore kuralı bulunmalı").toBeDefined();
    expect(tsIgnore?.["update-types"]).toContain("version-update:semver-major");

    for (const eco of ["npm", "cargo", "nuget", "github-actions"] as const) {
      const cfg = byEco.get(eco);
      expect(cfg, `${eco} Dependabot girdisi bulunmalı`).toBeDefined();
      expect(cfg?.cooldown?.["default-days"], `${eco} default-days >= 7 olmalı`).toBeGreaterThanOrEqual(7);

      // Somut (glob olmayan) dizinlerin diskte var olduğunu doğrula:
      const concreteDirs = [
        ...(typeof cfg?.directory === "string" ? [cfg.directory] : []),
        ...(cfg?.directories ?? []),
      ].filter((d) => !d.includes("*"));
      for (const dir of concreteDirs) {
        const rel = dir.replace(/^\/+/, "");
        const abs = rel.length === 0 ? REPO_ROOT : path.join(REPO_ROOT, ...rel.split("/"));
        expect(existsSync(abs), `${eco} dizini diskte mevcut olmalı: ${dir}`).toBe(true);
      }

      const groups = Object.entries(cfg?.groups ?? {});
      expect(groups.length, `${eco} groups tanımlamalı`).toBeGreaterThanOrEqual(1);
      for (const [groupName, groupDef] of groups) {
        expect(
          groupDef.patterns?.length ?? 0,
          `${eco}#${groupName} patterns tanımlamalı`,
        ).toBeGreaterThanOrEqual(1);
      }
    }

    for (const semverEco of ["npm", "cargo", "nuget"] as const) {
      expect(
        byEco.get(semverEco)?.cooldown?.["semver-major-days"],
        `${semverEco} semver-major-days >= 14 olmalı`,
      ).toBeGreaterThanOrEqual(14);
    }

    // github-actions SemVer olmayan ekosistemdir; semver-*-days şema hatası üretir:
    const ghaCooldown = byEco.get("github-actions")?.cooldown;
    expect(ghaCooldown?.["semver-major-days"]).toBeUndefined();
    expect(ghaCooldown?.["semver-minor-days"]).toBeUndefined();
    expect(ghaCooldown?.["semver-patch-days"]).toBeUndefined();
  });
});
