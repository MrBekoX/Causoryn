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

- **Workflow & dependency security (`.github/workflows/security.yml`):** Runs fail-closed `zizmor` static workflow auditing, PR `dependency-review-action` (blocking `high`+ advisories and copyleft SPDX licenses), `npm audit --audit-level=high`, and fail-closed `--locked-mode` NuGet JSON auditing (`dotnet list ... package --vulnerable --include-transitive --format json`).
- **5-language SAST (`.github/workflows/codeql.yml`):** Runs CodeQL v4 (`security-extended`) across `javascript-typescript`, `python`, `csharp`, `go`, and `actions`.
- **OpenSSF Scorecard (`.github/workflows/scorecard.yml`):** Runs `ossf/scorecard-action` (`publish_results: true`) with SARIF upload to GitHub Code Scanning.
- **2-job SLSA release pipeline (`.github/workflows/release.yml`):** Separates the read-only `build-and-verify` job (`step-security/harden-runner` with `egress-policy: audit`, hermetic builds, CycloneDX 1.5 SBOM via `scripts/generate-sbom.mjs`, and `SHA256SUMS.txt`) from the privileged `attest-and-publish` job (`environment: release`), which verifies checksums, runs `actions/attest-build-provenance`, and publishes via tokenless npm OIDC Trusted Publishing (`npm publish --provenance --access public`; zero `NPM_TOKEN` secrets).
- **Locked, SHA-pinned CI & cooldown (`.github/workflows/ci.yml`, `.github/dependabot.yml`):** 100% 40-character SHA-pinned GitHub Actions, `persist-credentials: false`, zero `${{ ... }}` interpolation in `run:` steps, `npm ci --ignore-scripts`, `-p:RestoreLockedMode=true`, `cargo build --locked`, `scripts/export-public-tree.mjs --verify-temp --ref HEAD`, and a 7-day supply-chain Dependabot cooldown across 4 ecosystems (`npm`, `cargo`, `nuget`, `github-actions`).

## Out of Scope

The following are outside Causoryn's security boundary:

- Vulnerabilities in third-party host applications (Antigravity, Claude Code, Codex, ZCode) or their LLM models
- Model hallucinations or tool-selection decisions made by the host LLM outside Causoryn's structured MCP output
- Attacks requiring an adversary who already possesses arbitrary local code execution as the user before Causoryn starts
- Denial-of-service caused solely by intentionally passing arbitrarily huge inputs after raising configured safety limits
- Absent optional language toolchains (`dotnet`, `python`, `go`, `cargo`), which intentionally degrade to L0/L1 file-level provenance
