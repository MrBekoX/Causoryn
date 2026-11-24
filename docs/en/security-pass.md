# Security Audit and Supply-Chain Boundaries

> **Language:** [Türkçe](../security-pass.md) | **English** · [Documentation Hub](README.md)

## Current Runtime Security Boundaries (`v0.2.4` + Post-v0.2.4 Hardening)

**Bundle identity:** `packages/mcp-server/dist/mcp-server.mjs` SHA-256 `fdb1ac8b3d7c75d187de3d406704f5068140e8ec693a2f4acbc4c8a13fd2fbbd`. `dist/bundle-manifest.json` records this digest alongside `dist/index-worker.mjs`, third-party license notices, and the vendored native SQLite runtime (**36 entries total**).

### 1. Untrusted-Repository Toolchain & Sidecar Isolation

Analyzing untrusted repositories must never allow repository-local configuration files to execute arbitrary code on the host:

- **Cargo / Rust sidecar (`adapters/rust/src/{cargo.ts,analyzer.ts,worker-process.ts}`):** `probeCargo` and `runCargoBuild` always execute with `cwd: path.dirname(manifestPath)` inside Causoryn's trusted `native/rust-worker` directory (never inside the analyzed repo), force `CARGO_BUILD_RUSTC_WRAPPER=""` (neutralizing repo-local `.cargo/config.toml` `rustc-wrapper` and `rust-toolchain.toml` hijacks), and pin compiled worker binaries via `causoryn-rust-worker.sha256.json` (`{ sourceFingerprint, binarySha256 }`) verified with `O_NOFOLLOW` + regular-file + SHA-256 checks before spawning.
- **Read-only Git layer (`packages/graph/src/git-read.ts`):** Uses `execFile` (`shell: false`) with a strict subcommand allowlist (`cat-file`, `ls-tree`, and constrained `rev-parse --verify --end-of-options <ref>^{commit}` for `HEAD~N`/`HEAD^`), minimal environment (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<devNull>`, `GIT_ATTR_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LFS_SKIP_SMUDGE=1`), and pre-subcommand `-c` overrides (`core.fsmonitor=false`, `core.hooksPath=<devNull>`, `core.pager=cat`, `core.sshCommand=false`, `core.askPass=`, `diff.external=false`, `protocol.allow=never`, `protocol.ext.allow=never`, `safe.bareRepository=explicit`) blocking malicious `.git/config` execution (`extensions.partialClone`, `core.sshCommand`, `core.fsmonitor`, `diff.external`).
- **Go sidecar (`adapters/go/src/{worker-process.ts,types.ts}`):** Forces `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, removes `GOENV` from the environment allowlist, and runs in trusted `cwd: input.workerDir`.
- **Python sidecar (`adapters/python/src/worker-process.ts`):** Launches with `["-I", "-B", "-X", "utf8", workerScriptPath]` in `cwd: path.dirname(workerScriptPath)` (`-I` isolated mode strips `PYTHONPATH`, user site-packages, and `cwd` from `sys.path`, neutralizing malicious `sitecustomize.py` / `.pth` files; `-X utf8` preserves Windows UTF-8 stdio).
- **C# Roslyn sidecar (`adapters/csharp-roslyn/src/{worker-process.ts,types.ts}`):** Pins `cwd: path.dirname(workerDllPath)` and forces `DOTNET_STARTUP_HOOKS=""`, `DOTNET_CLI_TELEMETRY_OPTOUT="1"`, `DOTNET_NOLOGO="1"`, `DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1"`. Read-only NuGet discovery from `obj/project.assets.json` enforces symlink/UNC guards and bounded caps.
- **Shared IPC & Doctor probes (`packages/sidecar-ipc/src/index.ts`, `packages/causoryn/src/doctor.ts`):** `sidecar-ipc` enforces `shell: false`, `windowsHide: true`, and a mandatory non-empty `cwd`; `doctor` executes all toolchain version probes with `cwd: os.tmpdir()` and an allowlisted environment.

### 2. Win32 UNC Lexical Pre-Check, Sensitive Ancestor Rejection & Trusted Rules

- **Win32 UNC / device path pre-check (`packages/workspace/src/path-safety.ts`):** `assertNotUncOrDevicePath` lexically rejects `\\host\share`, `//host/share`, `\\?\...`, and `\\.\...` paths **before any `fs.*` syscall** (`realpathSync`/`lstatSync`) across `WorkspaceAccessPolicy`, `OutputAccessPolicy`, and `runtime-cli.ts`, preventing Windows SMB/NTLM credential leaks.
- **Root-safety & sensitive ancestor rejection (`packages/mcp-server/src/runtime-cli.ts`):** `inspectProjectRootSafety` rejects filesystem roots, `$HOME` **and all `$HOME` ancestor directories** (`C:\Users`, `/home`, `/Users`), Causoryn data/plugin/cache directories, sensitive user folders (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.claude`, `~/.codex`, `~/.zcode`), and OS/scratch directories (`/etc`, `/System`, `/usr`, `/proc`, `/sys`, `/root`, `/tmp`, `/var`, `/bin`, `/sbin`, `/lib`, `/dev`, `C:\Windows`, `C:\Program Files`, `C:\ProgramData`).
- **Trusted baseline-commit architecture rules (`packages/mcp-server/src/services-verification.ts`):** `causoryn_verify_change` reads `.causoryn/architecture.rules.yaml` and `architecture.baseline.yaml` from the trusted Git baseline commit (`baseRef`, defaulting to `HEAD`) so an edit cannot weaken architecture rules in the same diff; untrusted working-tree fallback emits an explicit `trustWarning`.
- **SQLite CVE defense-in-depth (`packages/storage-sqlite/src/schema.ts`):** New databases set `PRAGMA page_size = 4096` before table creation and retain default FTS5 `detail=full`.

### 3. Exports, Confined TS Host & Deterministic SHA-256 Interactive CSP

- **Export authorization & atomic writes:** `causoryn_export_documentation` writes strictly inside `output.allowedOutputDirs` via `flag: "wx"` + `EEXIST`-guarded temp files and atomic renames (`EXPORT_NOT_ALLOWED` for undeclared directories; `PATH_DENIED` for unsafe names or escapes).
- **Deterministic SHA-256 CSP on interactive portals (`packages/graph/src/architecture-export.ts`):** Default `view="architecture"` HTML is script-free (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`). Opt-in `view="interactive"` (`causoryn-architecture-interactive.html`) computes the exact SHA-256 digest of its embedded script and emits `default-src 'none'; script-src 'sha256-<hash>'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` (zero `script-src 'unsafe-inline'`, zero `innerHTML`, zero `fetch`/CDN).
- **Zero-RegExp glob & confined TS host:** `ignore-matcher.ts` uses a linear/polynomial two-pointer glob engine (zero ReDoS); `tsconfig-loader.ts` and `configureConfinedCompilerHost` confine TypeScript reads to `rootDir` and bundled `typescript-lib` with `O_NOFOLLOW` + `(dev, ino)` verification.
- **Fail-closed annotation validation:** Optional Host-LLM `annotations` are validated against strict Zod schemas and active graph/projection IDs (collecting up to 25 errors in one pass under `INVALID_ARGUMENT`).

---

## CI/CD and Supply-Chain Security Hardening

1. **`.github/workflows/security.yml`:** Fail-closed **`zizmor`** workflow static audit, PR **`dependency-review-action`** (`high`+ advisories and SPDX copyleft denylist), `npm audit --audit-level=high`, and fail-closed `--locked-mode` NuGet JSON vulnerability audit.
2. **`.github/workflows/codeql.yml`:** 5-language **CodeQL** v4 SAST (`javascript-typescript`, `python`, `csharp`, `go`, `actions`) with `security-extended` queries (`0` open alerts).
3. **`.github/workflows/scorecard.yml`:** OpenSSF **Scorecard** analysis uploading SARIF results.
4. **`.github/workflows/release.yml` — Hermetic 3-job SLSA pipeline:**
   - `verify-and-test` (`contents: read`, Linux `step-security/harden-runner`): tag/version/`origin/main` checks, `npm ci --ignore-scripts`, `npm audit --audit-level=high`, lint, typecheck, `secret-scan`, `npm test`, and `export-public-tree.mjs --verify-temp`.
   - `build-and-pack` (`needs: verify-and-test`, zero test execution): clean checkout, locked Roslyn (`-p:RestoreLockedMode=true`) + Rust (`--locked`) builds, bundle & package staging, `verify-package-ready.mjs` immediately before `npm pack`, isolated tarball smoke, CycloneDX 1.5 SBOM (`scripts/generate-sbom.mjs`), and `SHA256SUMS.txt`.
   - `publish` (`needs: build-and-pack`, `environment: release`): `sha256sum -c SHA256SUMS.txt`, `actions/attest-build-provenance`, tokenless npm OIDC Trusted Publishing (`npm publish --provenance --access public`), and GitHub Release upload.
5. **`.github/workflows/ci.yml` & `.github/dependabot.yml`:** 3-OS matrix (`ubuntu-latest`, `windows-latest`, `macos-15`), 40-char SHA-pinned actions, Linux `step-security/harden-runner`, 13-root `scripts/secret-scan.mjs`, and 7-day Dependabot cooldown across npm, Cargo, NuGet, and GitHub Actions.

---

## Packaged-Bundle Threat Matrix (9/9 PASS)

The packaged-bundle security suite spawns the compiled `mcp-server.mjs` + vendored native `better-sqlite3` runtime as a real child process from a protected SHA-256-verified clone (`cloneBundleTo`, `CLONE_MAX_ATTEMPTS = 5`):

| # | Threat Class | Package-Level Control | Result | Verification Suite |
|---|---|---|---|---|
| 1 | **Symlink / path traversal** | Junction/symlink escape baits never enter inventory; `..\\escape.html` rejected with `PATH_DENIED`; undeclared export dirs return `EXPORT_NOT_ALLOWED` | PASS | `tests/security-release/f6-security-release.test.ts` + `packages/workspace/test/workspace-access-policy.test.ts` |
| 2 | **Secret leakage** | Static 8-pattern credential scan with runtime CANARY self-test + `.env`/`keys/api.pem` behavioral baits → 0 matches across bundle, vendor files, and session outputs | PASS | `scanForCredentials` (`tests/security-release/helpers/bundle-client.ts`) + `npm run secret-scan` |
| 3 | **Symlink TOCTOU** | Post-open `O_NOFOLLOW` + `fstat` `(dev, ino)` verification and dual-check inventory reads (`safe-file-read.ts`, `inventory.ts`, `git-read.ts`) | PASS | `tests/security-release/` + unit TOCTOU suites |
| 4 | **Poisoned comments / prompt injection** | Source comments (`IGNORE ALL PREVIOUS INSTRUCTIONS…`, `<script>`) remain inert data; JSON-RPC framing stays valid; SQL-like queries return `SYMBOL_NOT_FOUND` | PASS | `tests/security-release/f6-security-release.test.ts` |
| 5 | **Oversized files** | Files exceeding `maxFileBytes` stay excluded from inventory; oversized policy files fail closed with `LIMIT_EXCEEDED` | PASS | `tests/security-release/f6-security-release.test.ts` |
| 6 | **Malicious Git refs & `.git/config`** | `execFile` (`shell: false`), allowlist (`cat-file`, `ls-tree`, constrained `rev-parse`), hardened `-c` flags, `GIT_NO_LAZY_FETCH=1`; bad refs return `INVALID_REVISION` | PASS | `tests/security-release/f6-security-release.test.ts` + `tests/git-read.test.ts` |
| 7 | **Network denied** | Zero runtime network imports (`node:http/https/net/tls/dgram/dns`, `fetch(`, `WebSocket`) in bundle; `NODE_OPTIONS=--require net-guard.cjs` behavioral session leaves `netlog.jsonl` empty (0 bytes) | PASS | `tests/security-release/f6-security-release.test.ts` + `tests/security-release/helpers/net-guard.cjs` |
| 8 | **Offline HTML XSS / CSP** | Default HTML uses `default-src 'none'` (zero scripts); interactive HTML uses deterministic `script-src 'sha256-...'`; zero external URLs or `innerHTML` | PASS | `tests/security-release/` + `packages/graph/test/architecture-export.test.ts` + `packages/mcp-server/test/architecture-export-tool.test.ts` + `tests/visualizer-viewer.test.ts` |
| 9 | **`stdout` framing discipline** | Across 5 independent spawn sessions, `stdout` carries exclusively single-line JSON-RPC 2.0 frames; all logs go to `stderr` | PASS | `tests/security-release/` + `packages/mcp-server/test/stdio-stdout.test.ts` |

Additional untrusted-repository isolation regression suites: `tests/toolchain-isolation.test.ts` (malicious `.cargo/config.toml`, `global.json`, `sitecustomize.py`, tampered `causoryn-rust-worker.sha256.json`) and `tests/path-safety.test.ts` (Win32 UNC/device lexical pre-check before `realpathSync`).

---

## Reproducible Verification Commands

```bash
npx vitest run tests/toolchain-isolation.test.ts tests/git-read.test.ts tests/path-safety.test.ts
npx vitest run tests/security-release/
npx vitest run tests/ci-workflow.test.ts
npm run secret-scan
```

## Related Pages

- [Architecture Overview](architecture.md) · [MCP Tool Contracts](tool-contracts.md)
- [Host Compatibility Matrix](compatibility-matrix.md) · [Implementation Status](implementation-status.md)
- [SECURITY.md](../../SECURITY.md) · [No-LLM Architecture Policy](adr/ADR-002-no-llm.md)
