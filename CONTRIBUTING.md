# Contributing to Causoryn

Thank you for your interest in contributing to **Causoryn**! This guide covers local setup, architectural guardrails, and the pull request workflow.

## Prerequisites

- **Node.js >= 24** (`engines.node` in root `package.json`)
- Optional native sidecar toolchains (required only to build/test the corresponding language sidecars):
  - **.NET 10 SDK** (`native/roslyn-worker` — C# Roslyn sidecar)
  - **Python 3.12+** (`native/python-worker` — stdlib `ast` sidecar)
  - **Go** matching `native/go-worker/go.mod` (`native/go-worker` — stdlib `go/parser` sidecar)
  - **Rust / Cargo stable** (`native/rust-worker` uses `syn` 3)

## Local Monorepo Setup & Verification

Our verification sequence mirrors `.github/workflows/ci.yml`:

```bash
# 1. Install dependencies without executing third-party lifecycle scripts
#    (Causoryn ships verified better-sqlite3 prebuilds; --ignore-scripts
#    blocks untrusted postinstall execution during CI and contributor setup.)
npm ci --ignore-scripts
npm audit --audit-level=high

# 2. Build native sidecar workers (locked dependency graphs)
dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Release -p:DebugType=none -p:ContinuousIntegrationBuild=true -p:SatelliteResourceLanguages=en -p:RestoreLockedMode=true
cargo build --manifest-path native/rust-worker/Cargo.toml --locked

# 3. Run the full quality gate chain
npm run typecheck
npm run build
npm run build:bundle --workspace packages/mcp-server
npm run build:package --workspace packages/causoryn
node packages/causoryn/scripts/verify-package-ready.mjs
npm run lint
npm run secret-scan
node scripts/export-public-tree.mjs --verify-temp --ref HEAD
npm test
```

Performance benchmarks are intentionally isolated from the correctness suite (`vitest.bench.config.ts`) and run separately via:

```bash
npm run bench
```

## Non-Negotiable Architectural Red Lines

Every pull request must preserve Causoryn's core invariants:

1. **No LLM dependencies (`ADR-002`):** Never add LLM API clients, embedding models, or agent framework dependencies (`openai`, `@anthropic-ai/sdk`, `langchain`, etc.). Causoryn is strictly local and deterministic.
2. **Read-only workspace (`ADR-008`):** Never write to, format, or mutate files inside an analyzed workspace. Persistent state may only be written to explicitly authorized data/output paths outside every `allowRoots` directory.
3. **Read-only Git & zero shell interpolation:** Git access uses read-only subcommands (`cat-file`, `ls-tree`, `rev-parse`) via `execFile`/`spawn` with `shell: false`. Never run `git checkout`, `git reset`, or `git clean`, and never interpolate user input into shell commands.
4. **Pure `stdout` MCP framing:** Write only JSON-RPC 2.0 MCP protocol traffic to `stdout`. All logs and diagnostics must go to `stderr`.
5. **Honest coverage & zero stubs (`ADR-010`):** Never publish stub/empty MCP tools, never claim verified resolution without source-span evidence, and always degrade honestly to L0/L1 when an optional sidecar toolchain is unavailable.

## Development Workflow & PR Checklist

1. **TDD first:** Write a failing test demonstrating the bug or new contract (`RED`), observe it fail, implement the minimal clean change, and confirm it passes (`GREEN`). Never weaken or delete existing assertions to make tests pass.
2. **Keep diffs focused:** Avoid unrelated edits outside the scope of your change.
3. **No personal paths or secrets:** Run `npm run secret-scan` and ensure no personal usernames, local drive paths, or credentials appear in code, tests, or documentation.
4. **Keep bilingual docs & changelog in sync:** Causoryn maintains a bilingual Diátaxis documentation hub with 17 Turkish/English parity pairs (`docs/` and `docs/en/`), verified by `tests/release-docs.test.ts` (including relative-link and schema checks). Update matching files in `docs/`, `docs/en/`, `README.md`, and `CHANGELOG.md` (`[Unreleased]`) whenever changing user-facing behavior or tool contracts.
5. **Run all local gates** (`npm audit --audit-level=high`, locked native builds, `typecheck`, `build`, `build:bundle`, `build:package`, `verify-package-ready.mjs`, `lint`, `secret-scan`, `export-public-tree.mjs --verify-temp --ref HEAD`, `npm test`) before opening your PR.

## Community & Security

- Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
- To report a security issue privately, follow [SECURITY.md](SECURITY.md).
- By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
