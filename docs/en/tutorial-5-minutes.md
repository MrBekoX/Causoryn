# 5-Minute Quickstart Tutorial

> **Language:** **English** · [Documentation Hub](README.md) · [Root README](../../README.md)

This hands-on tutorial walks through Causoryn's end-to-end engineering loop on the bundled TypeScript orders service fixture ([`examples/fixture-ts-orders`](../../examples/fixture-ts-orders/README.md)) in about five minutes:

1. Install Causoryn and verify your environment (read-only).
2. Connect over MCP and inspect the indexed architecture graph.
3. Guard a signature change with `preflight -> edit -> verify`.
4. Localize code with natural-language queries and trace call chains.
5. Switch MCP tool profiles (`core`, `wiki`, `history`, `full`) when you need extended surfaces.

**Prerequisites:** Node.js `>= 24` and a local clone of this repository (or any TypeScript/JavaScript project of your own).

---

## Step 1: Install & Verify (`setup` & `doctor`)

Configure Causoryn for your AI coding host (Claude Code is shown below; replace `claude-code` with `codex`, `antigravity`, or `zcode`, or pass `--all-detected` to configure every detected host):

```bash
# Preview planned host config and skill writes without modifying disk
npx causoryn setup --client claude-code --dry-run

# Apply configuration (backs up existing host config to *.causoryn.backup once and never overwrites it)
npx causoryn setup --client claude-code --yes

# Verify Node.js >= 24, runtime integrity, optional sidecar toolchains, and host alignment (100% read-only)
npx causoryn doctor
```

Expected health summary from `npx causoryn doctor`:

- `HEALTHY` when Node.js `>= 24`, the staged runtime is complete, and at least one host is configured with its five canonical skills.
- `NOT CONFIGURED` if no host has been set up yet, or `DEGRADED` if a configured host is missing skills or has warnings.
- Missing optional language toolchains (`dotnet`, `python`, `go`, `cargo`) are reported as `l0-l1-fallback` without marking the core server unhealthy.

---

## Step 2: Connect MCP & Inspect (`causoryn_status` -> `causoryn_map_system`)

Open [`examples/fixture-ts-orders`](../../examples/fixture-ts-orders/README.md) in your coding agent host; the entry that `causoryn setup` registered binds the opened folder. To start the server by hand, run `npx` from a directory outside the project with npm's prefix pinned to a directory you own, and name the project with `--root`: `cd ~ && npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /path/to/examples/fixture-ts-orders --auto-data-dir`.

Causoryn boots with the **11-tool default `core` profile** (`tools/list <= 15,000` chars) and stores its shared SQLite WAL graph index (`graph.sqlite`) outside your repository under `~/.causoryn/workspaces/<slug>-<hash12>/` so your source tree remains strictly read-only.

### 2a. Check status, capabilities, and workspace summary

Ask your agent (or call `causoryn_status` directly):

> *"Check Causoryn status and summarize the indexed workspace."*

```json
{
  "tool": "causoryn_status",
  "arguments": {
    "action": "inspect"
  }
}
```

`causoryn_status` returns:
- Active server capabilities, tool list, and per-language coverage breakdown (`coverage.byLanguage`).
- Latest published snapshot ID, freshness (`stale`), and background indexing progress (or queues a refresh when you pass `{ "action": "refresh", "mode": "incremental" }`).
- Workspace file counts, detected languages (`typescript`), entrypoints (`POST /orders`), and edge resolution ratios (`verified` / `heuristic` / `unresolved`).

### 2b. Map the system structure

Next, inspect the L2 module and symbol graph with `causoryn_map_system`:

```json
{
  "tool": "causoryn_map_system",
  "arguments": {
    "level": "L2",
    "maxNodes": 50
  }
}
```

In `examples/fixture-ts-orders`, the graph reveals five source files wired into a clean layered chain:

```text
POST /orders (Endpoint)
  -> ordersRoute (src/app.ts)
  -> createOrdersRoute (src/routes/orders.ts)
  -> OrdersService.create (src/services/orders-service.ts)
  -> OrderRepository.save (src/repositories/order-repository.ts)
```

Tip: Pass `{ "profile": "onboarding", "audience": "maintainer" }` to `causoryn_map_system` for entrypoints, central modules, topological learning order, and risk hotspots.

---

## Step 3: Guard a Change (`causoryn_preflight_change` -> Edit -> `causoryn_verify_change`)

Suppose you plan to add an `idempotencyKey` field to `CreateOrderInput` and update `OrdersService.create` in `src/services/orders-service.ts`.

### 3a. Run pre-edit preflight (zero disk writes)

```json
{
  "tool": "causoryn_preflight_change",
  "arguments": {
    "intent": "Add idempotencyKey parameter to OrdersService.create",
    "targetFiles": ["src/services/orders-service.ts"]
  }
}
```

`causoryn_preflight_change` writes zero bytes to your repository (`candidateOnly: true`) and returns:
- A `preflightId` you will pass to `causoryn_verify_change` after editing.
- `impactCandidates` from reverse dependency traversal (excluding noisy container `CONTAINS` edges, while including `CALLS`, `IMPORTS`, `INHERITS`, and `IMPLEMENTS` propagation) — pinpointing `src/routes/orders.ts` (`createOrdersRoute`) and `src/app.ts` with separate `certainty` (`direct` / `indirect` / `possible`) and `resolution` (`verified` / `heuristic` / `unresolved`) labels plus evidence IDs.
- A content-addressed candidate `testPlanId` (Causoryn never executes tests behind your back).

### 3b. Make your edit

Update `src/services/orders-service.ts` (and its caller in `src/routes/orders.ts` if desired) in your working tree — or intentionally introduce a reverse import from `src/repositories/order-repository.ts` back into `src/services/orders-service.ts` to watch Causoryn catch a new cycle.

### 3c. Run post-edit verification

```json
{
  "tool": "causoryn_verify_change",
  "arguments": {
    "preflightId": "<preflightId-from-step-3a>"
  }
}
```

By default, `causoryn_verify_change` runs `architecture`, `graph-diff`, and `test-plan` checks asynchronously across all configured languages (only running `contracts` when explicitly requested or contract spec pairs are present) and produces a byte-deterministic verdict (`no_findings`, `review_required`, `blocking_findings`, or `inconclusive`):

- In Git repositories, `.causoryn/architecture.rules.yaml` and `.causoryn/architecture.baseline.yaml` are loaded from the trusted baseline commit (`baseRef`, defaulting to `HEAD`) so an edit cannot silently weaken architecture rules in the same diff.
- Test status defaults honestly to `state: "not_run"`. If your host reports test output via `observedTestRun`, Causoryn records it explicitly as `state: "host_asserted"` with `engineVerified: false`.

---

## Step 4: Localize Code & Trace Execution (`causoryn_get_agent_context` & `causoryn_trace`)

### 4a. Natural-language code localization

Use `causoryn_get_agent_context` when you want ranked files and symbols within an explicit token budget (backed by path + identifier `camelCase`/`snake_case` tokenization, SQLite FTS5 BM25 ranking, and structural degree scoring — zero embeddings or LLM calls):

```json
{
  "tool": "causoryn_get_agent_context",
  "arguments": {
    "task": "Where are POST /orders requests validated and persisted?",
    "tokenBudget": 2000
  }
}
```

### 4b. Trace execution or cross-component business flows

Use `causoryn_trace` with `mode: "execution"` (default) to follow `ROUTES_TO` and `CALLS` chains with explicit per-edge resolution and source-span evidence:

```json
{
  "tool": "causoryn_trace",
  "arguments": {
    "mode": "execution",
    "entrypoint": "POST /orders",
    "maxDepth": 6,
    "maxPaths": 25
  }
}
```

Switch to `"mode": "business-flow"` to trace across routes, handlers, services, repositories, and contract boundaries (reporting any unlinked discontinuity honestly as a `gap` segment). Oversized `maxDepth` or `maxPaths` inputs are clamped to server ceilings with an explicit warning rather than failing the call.

You can inspect exact file/line/SHA-256 provenance for any returned node, edge, or finding ID via `causoryn_get_evidence`.

---

## Step 5: Switch MCP Tool Profiles (`--tool-profile`)

The default **`core`** profile registers **11 consolidated tools** to keep agent context windows small and tool selection accurate. When you need Living Wiki queries, Git architecture history, or backward-compatible legacy tool names, enable additional profiles via `--tool-profile` or the `CAUSORYN_TOOL_PROFILE` environment variable:

```bash
# Preferred: let setup write the profile into your host entries
npx causoryn@0.3.2 setup --tool-profile wiki,history --yes

# Manual start: run npx outside the project with a pinned npm prefix, and name the project with --root
cd ~

# Default lean surface (11 consolidated core tools)
npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /path/to/your-project --auto-data-dir

# Add Living Wiki (7 tools) and Git architecture history (2 tools) alongside core (20 tools total)
npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /path/to/your-project --auto-data-dir --tool-profile wiki,history

# Expose all 29 legacy tool names + 3 consolidated core aliases (32 tools total, backward compatible)
npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /path/to/your-project --auto-data-dir --tool-profile full

# Or select via environment variable in any host MCP config
CAUSORYN_TOOL_PROFILE=wiki,history npx -y --ignore-scripts --prefix ~/.npx-causoryn causoryn@0.3.2 mcp --root /path/to/your-project --auto-data-dir
```

| Profile Value | Registered Tools | Best For |
|---|---|---|
| `core` *(default)* | 11 consolidated tools | Daily coding agent sessions (`tools/list <= 15,000` chars) |
| `wiki` | 11 core + 7 Living Wiki tools (18) | Persistent SQLite + FTS5 project wiki navigation and diffs |
| `history` | 11 core + 2 Git architecture tools (13) | Cross-revision architecture comparisons and violation timelines |
| `wiki,history` | 11 core + 7 wiki + 2 history (20) | Combined knowledge base and architecture evolution workflows |
| `full` | All 29 legacy tools + 3 consolidated core tools (32) | Legacy prompts or scripts calling individual superseded tool names |

---

## Next Steps

- **[MCP Tool Contracts](tool-contracts.md)** — Full input/output reference for the 11-tool `core` profile, extension profiles, and error codes.
- **[CLI & Configuration Reference](cli-and-configuration.md)** — Flags, environment variables, shared SQLite workspace layout, and `CAUSORYN_CONFIG`.
- **[Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)** — Generate offline layered SVG and interactive SHA-256 CSP architecture portals.
- **[Host Setup Guides](README.md#1-tutorials--how-to-guides)** — Antigravity, Claude Code, Codex, and ZCode (GLM).
