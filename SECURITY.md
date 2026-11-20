# Security Policy

## Supported Versions

Causoryn is currently in **Pre-1.0 Public Preview (`0.2.x`)**. Security fixes are provided for the latest `0.2.x` release line:

| Version | Supported |
|---|---|
| `0.2.x` | Yes |
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

Causoryn is designed as a **local, deterministic, LLM-free** MCP code-analysis server. The following guarantees are security boundaries enforced by automated tests:

1. **Read-only analyzed workspace (`ADR-008`):** Causoryn never writes to, modifies, formats, or cleans files inside any analyzed workspace root. Writes are restricted to explicitly authorized external paths (`storage.dataDbPath`, `wiki.dataDbPath`, `output.allowedOutputDirs`, or `--auto-data-dir` under `~/.causoryn/workspaces/`).
2. **Explicit authorization & default deny:** Running the bare stdio server without CLI workspace flags defaults to `{"allowRoots":[]}` and fails closed with `WORKSPACE_NOT_AUTHORIZED`. Packaged CLI `--allow-cwd` rejects filesystem roots, `$HOME`, Causoryn's own data directory, and plugin cache directories.
3. **Path containment & symlink/TOCTOU defense:** Workspace reads and authorized data/output writes enforce realpath containment, reject symlink/junction escapes, and check against dangling-symlink overwrites (CWE-59).
4. **Read-only Git access:** Git operations use an explicit read-only allowlist (`cat-file`, `ls-tree`, `rev-parse`) via `execFile` without shell interpolation (`shell: false`). Mutating Git commands (`checkout`, `reset`, `clean`) are never executed.
5. **Local & LLM-free runtime (`ADR-002`):** The runtime contains zero LLM SDKs, embedding clients, telemetry, or outbound network calls. (Note: the optional Rust sidecar runs `cargo build --locked` on first cold use, which may fetch its 12 locked crates from `crates.io` unless pre-cached.)
6. **Clean MCP `stdout` channel:** `stdout` emits only JSON-RPC 2.0 MCP frames; all diagnostic logs are written exclusively to `stderr`.
7. **Static HTML export hardening:** Offline HTML documentation and visualizer outputs apply full escaping, restrictive Content Security Policy (CSP), and zero external CDN/script/analytics references.

## Out of Scope

The following are outside Causoryn's security boundary:

- Vulnerabilities in third-party host applications (Antigravity, Claude Code, Codex, ZCode) or their LLM models
- Model hallucinations or tool-selection decisions made by the host LLM outside Causoryn's structured MCP output
- Attacks requiring an adversary who already possesses arbitrary local code execution as the user before Causoryn starts
- Denial-of-service caused solely by intentionally passing arbitrarily huge inputs after raising configured safety limits
- Absent optional language toolchains (`dotnet`, `python`, `go`, `cargo`), which intentionally degrade to L0/L1 file-level provenance
