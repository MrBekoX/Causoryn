# Security Policy

## Supported Versions

Causoryn is currently **pre-1.0 (`0.3.x`)**. Security fixes are provided for the latest `0.3.x` release line:

| Version | Supported |
|---|---|
| `0.3.x` | Yes |
| `0.2.x` | No (upgrade to `0.3.x`; see the migration notes in `CHANGELOG.md`) |
| `< 0.2.0` (`0.1.0` snapshot) | No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Instead, use **GitHub Private Vulnerability Reporting**:

- Open a private security advisory at: <https://github.com/MrBekoX/Causoryn/security/advisories/new>

Include as much of the following as possible:

- Affected version (`causoryn --version` or commit SHA) and host client (Antigravity, Claude Code, Codex, ZCode, or standalone stdio)
- Operating system, architecture, and Node.js / sidecar toolchain versions
- Minimal reproduction steps or proof-of-concept input
- Expected security boundary vs. observed behavior

### Response SLA

- **Acknowledgment:** within **72 hours**
- **Initial triage and severity assessment:** within **7 calendar days**
- **Remediation & coordinated disclosure:** target **30 days** for Critical/High findings and up to **90 days** for Medium/Low findings, coordinated with the reporter before public disclosure

## Threat Model & Security Boundaries

Causoryn is a **local, LLM-free** MCP code-analysis server. Its automated security tests cover the following boundaries.

1. **Read-only source analysis (`ADR-008`):** Analyzers read project files. Persistent graph and wiki databases must resolve outside `allowRoots`. Automatic setup places exports outside the workspace. Explicit export destinations follow `output.allowedOutputDirs`, which can authorize a location inside a workspace.
2. **Explicit authorization & default deny:** Running the bare stdio server without CLI workspace flags defaults to `{"allowRoots":[]}` and fails closed with `WORKSPACE_NOT_AUTHORIZED`. Packaged CLI `--allow-cwd` rejects filesystem roots, `$HOME`, Causoryn's own data directory, and plugin cache directories.
3. **Path containment & symlink/TOCTOU defense:** Workspace reads and authorized data/output writes enforce realpath containment, reject symlink/junction escapes, and check against dangling-symlink overwrites (CWE-59).
4. **Read-only Git access:** Git operations use the explicit `cat-file` and `ls-tree` allowlist via `execFile` with `shell: false`.
5. **Local & LLM-free analysis (`ADR-002`):** The engine has no model or embedding clients and sends no source code to a model or telemetry service. The optional Rust sidecar’s cold `cargo build --locked` may fetch locked crates. A connected host controls its own model calls and data handling. [ADR-002](docs/en/adr/ADR-002-no-llm.md)
6. **Clean MCP `stdout` channel:** `stdout` emits only JSON-RPC 2.0 MCP frames; all diagnostic logs are written exclusively to `stderr`.
7. **Offline HTML exports:** Architecture and interactive HTML apply escaping and restrictive Content Security Policy (CSP), and use no external assets. The interactive view uses inline JavaScript. Optional annotations undergo schema and graph-reference validation. The caller is responsible for the accuracy of the prose. [Security audit](docs/en/security-pass.md)

## Supply-Chain & CI/CD Security

Causoryn's GitHub Actions pipeline and release process enforce layered supply-chain controls verified automatically by `tests/ci-workflow.test.ts`:

- **Workflow & dependency security (`.github/workflows/security.yml`):** Runs fail-closed `zizmor` static workflow auditing, PR `dependency-review-action` (blocking `high`+ advisories and copyleft SPDX licenses), `npm audit --audit-level=high`, fail-closed `--locked-mode` NuGet JSON auditing (`dotnet list ... package --vulnerable --include-transitive --format json`), `cargo audit --deny warnings` on the shipped `native/rust-worker/Cargo.lock` (`cargo-audit` installed at an exact version with `--locked`), and `govulncheck` on the Go worker (exact version, run on the `go.mod` toolchain with `GOTOOLCHAIN=local`). The Go worker declares the oldest still-supported Go release line in `native/go-worker/go.mod`.
- **5-language SAST (`.github/workflows/codeql.yml`):** Runs CodeQL v4 (`security-extended`) across `javascript-typescript`, `python`, `csharp`, `go`, and `actions`.
- **OpenSSF Scorecard (`.github/workflows/scorecard.yml`):** Runs `ossf/scorecard-action` (`publish_results: true`) with SARIF upload to GitHub Code Scanning.
- **3-job SLSA release pipeline (`.github/workflows/release.yml`):** Every job runs `step-security/harden-runner` (`egress-policy: audit`) first.
  - `verify-and-test` (`contents: read`): tag format, package version and `origin/main` ancestry checks, locked builds, lint, secret scan, public-export leak gate, and the full test suite.
  - `build-and-pack` (`contents: read`, no tests): clean checkout and hermetic build; `SHA256SUMS.txt` and the CycloneDX 1.5 SBOM (`scripts/generate-sbom.mjs`) are generated immediately after `npm pack`, and the tarball and SBOM SHA-256 digests are exported as job outputs (after checking that `SHA256SUMS.txt` is byte-for-byte the two expected records) before the packed tarball is smoke-tested, then re-checked after the smoke test.
  - `publish` (`environment: release`, `id-token: write`, `attestations: write`, `contents: write`): runs no build or test code; recomputes the downloaded digests and compares them with the `build-and-pack` job outputs (not only with the `SHA256SUMS.txt` shipped in the same artifact), rebuilds the expected two-record checksum list (tarball, then SBOM) from those outputs, requires the downloaded `SHA256SUMS.txt` to be byte-for-byte identical to it, and runs `sha256sum --strict -c` only on the locally rebuilt list (never on the downloaded file); then runs `actions/attest-build-provenance`, and publishes via tokenless npm OIDC Trusted Publishing (`npm publish --provenance --access public`; zero `NPM_TOKEN` secrets). GitHub Release assets are never overwritten: on a rerun an existing asset must have the same SHA-256, otherwise the job fails.
- **Locked, SHA-pinned CI & cooldown (`.github/workflows/ci.yml`, `.github/dependabot.yml`):** 100% 40-character SHA-pinned GitHub Actions, `persist-credentials: false`, zero `${{ ... }}` interpolation in `run:` steps, `npm ci --ignore-scripts`, `-p:RestoreLockedMode=true`, `cargo build --locked`, `scripts/export-public-tree.mjs --verify-temp --ref HEAD`, and a 7-day supply-chain Dependabot cooldown across 4 ecosystems (`npm`, `cargo`, `nuget`, `github-actions`). The merge gate runs on `ubuntu-latest`, `windows-latest` and `macos-26-intel`; the `main` branch ruleset requires the `Verify (ubuntu-latest)`, `Verify (windows-latest)` and `Verify (macos-26-intel)` checks. The nightly and manually dispatched runs add the Apple Silicon `macos-26` leg.
- **Host manifests:** plugin manifests start the launcher through the host's plugin-root variable (`${CLAUDE_PLUGIN_ROOT}`, `${ZCODE_PLUGIN_ROOT}`, Antigravity `${PLUGIN_ROOT}`) or, for Codex, which expands no variables, through an inline bootstrap (`node --input-type=module --eval …`, `env_vars: ["CODEX_HOME"]`, `env: {"NoDefaultCurrentDirectoryInExePath": "1"}` so `cmd.exe` and the server's child processes never search the current directory) that imports only `node:` built-ins, refuses a `node` binary inside the workspace and an empty or non-absolute `PATH` entry before the one that supplies `node`, and loads the launcher by its absolute real path in Codex's plugin cache, failing closed (exit `2`) when that path cannot be proven; never through a path relative to the analyzed project. The ZCode and Antigravity servers start in the plugin root (ZCode passes the project as the validated `--project-dir`), and the `npx` manifests pin npm's prefix to the plugin's data directory and pass `--ignore-scripts` (the published package has no dependencies and no install scripts). `tests/host-manifest-launch-safety.test.ts` checks every shipped manifest and pins the Codex bootstrap by SHA-256. Documented exceptions without a plugin-root `cwd`: the Claude Code manifest (no `cwd` field), the Codex manifest (runs in the session directory, `node` resolved from `PATH`; an empty or relative `PATH` entry before Node's directory can still select a project `node`, which then runs instead of the bootstrap, and a static manifest cannot name an absolute Node binary because Codex expands no variables and has no per-platform command; `causoryn setup` registers the absolute Node binary), and the MCP Registry `server.json` (no working-directory field). `server.json` passes `--ignore-scripts --prefix=~/` to `npx`, so npm treats the home directory as the project and the analyzed repository's `.npmrc` and a committed `node_modules/causoryn` do not decide what npm runs (`tests/registry-npx-context.test.ts`). Its documented residuals: npm still puts `<cwd>/node_modules/.bin` on `PATH`, so a repository can shadow the `node` the package's bin shim starts; on Windows `cmd.exe` running a `.cmd` shim searches the current directory first; and the client resolves `npx` itself.

## Out of Scope

The following are outside Causoryn's security boundary:

- Vulnerabilities in third-party host applications (Antigravity, Claude Code, Codex, ZCode) or their LLM models
- Model hallucinations or tool-selection decisions made by the host LLM outside Causoryn's structured MCP output
- Attacks requiring an adversary who already possesses arbitrary local code execution as the user before Causoryn starts
- Denial-of-service caused solely by intentionally passing arbitrarily huge inputs after raising configured safety limits
- Absent optional language toolchains (`dotnet`, `python`, `go`, `cargo`), which intentionally degrade to L0/L1 file-level provenance
