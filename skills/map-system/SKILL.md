---
name: map-system
description: Route the host model to causoryn_map_system when it needs a read-only architecture map of the authorized workspace (package/module/class/function hierarchy), including correct arguments (level, filters, maxNodes, cursor), envelope reading and Causoryn error-code recovery. Use for codebase overviews, structure questions and navigational queries about the workspace.
---

# map-system — Causoryn Architecture Map routing

Causoryn is a **local, deterministic, LLM-free** code-analysis engine. This skill routes
the host model to `causoryn_map_system`, a read-only tool that requires an authorized
workspace root (`--allow-cwd`, MCP `roots`, or explicit `allowRoots` configuration).

## When to call `causoryn_map_system`

Call `causoryn_map_system` when the task needs the *shape* of the system: top-level
projects, module/file layout, class/type inventory or callable surface — not the content
of one file. Do not use it to read file bodies; use the host's own file tools for that.

### Arguments

| Argument | Type | Notes |
| --- | --- | --- |
| `level` | `"L0"` \| `"L1"` \| `"L2"` \| `"L3"` (optional, default `"L2"`) | `L0` = Workspace / Repository / Project; `L1` = Module / Package / File / Namespace / Config; `L2` = Class / Interface / Type; `L3` = Function / Method / Handler / Endpoint. `L4` (flow maps) is **not supported in this release** and answers `INVALID_ARGUMENT` (use `causoryn_trace_execution` or `causoryn_trace_business_flow` for flow tracing). |
| `filters` | object (optional) | `filters.kinds`: array of node kinds (subset of the level's kinds, e.g. `["Class"]`); `filters.pathPrefix`: relative path prefix such as `packages/domain`. |
| `maxNodes` | positive integer (optional) | Server default cap is 250. Requesting more than the configured cap answers `LIMIT_EXCEEDED`; lower the value instead of retrying with the same one. |
| `cursor` | string (optional) | Page cursor from a previous response's `nextCursor`. Pass it back verbatim; a stale or corrupted cursor answers `INVALID_ARGUMENT`. |
| `workspaceId` | string (optional) | Omit unless targeting a specific workspace identifier reported by the server. |

Start broad (`level: "L2"`), then drill into `L3` with `filters.pathPrefix` narrowed to
the interesting directory. For symbol lookup by name use `causoryn_find_symbols`, for
project/framework coverage summaries use `causoryn_workspace_summary`, and to check
adapter levels and server limits first use `causoryn_get_capabilities`. To inspect the
provenance behind a mapped node use `causoryn_get_evidence` with the node `id`.

## Reading the response

Every tool answers the standard Causoryn envelope:
`schemaVersion, requestId, workspaceId, snapshotId, status, coverage, warnings, data, nextCursor`.

- `status`: `"ok"` or `"partial"` (partial snapshot — treat numbers as incomplete and
  mention it); `"error"` carries a structured `error.code` in the envelope body.
- `data.totalNodes` / `data.returned` / `data.truncated`: page position.
- `data.nodes[]`: `id`, `kind`, `qualifiedName`, optional `language`, optional
  `location { relativePath, startLine, endLine }` — cite locations when reporting.
- `data.edges[]`: `id`, `from`, `to`, `kind`, `resolution` (only edges whose both ends
  are on this page).
- `nextCursor`: non-null means more pages — call `causoryn_map_system` again with the
  same `level`/`filters` plus this `cursor` until `nextCursor` is `null`.

## Error codes and recovery

| `error.code` | Meaning | Action |
| --- | --- | --- |
| `WORKSPACE_NOT_AUTHORIZED` | No authorized root bound yet, or unknown `workspaceId`. | Stop retrying. Open a project directory (so `--allow-cwd` or MCP `roots` binds it) or declare `allowRoots` in server config, then retry. |
| `INDEX_NOT_READY` | No published snapshot yet (indexing still running or not triggered). | Check `causoryn_index_status` (or trigger `causoryn_refresh_index`), wait briefly, and retry once. |
| `INVALID_ARGUMENT` | Semantically invalid input: unsupported `L4` level, broken `cursor`, bad filter shape. | Fix the argument (use `L0`–`L3`, pass the cursor back unchanged) and retry once. |
| `LIMIT_EXCEEDED` | `maxNodes` above the server cap. | Retry with a smaller `maxNodes`. |
| `INTERNAL_ERROR` | Unexpected server failure. | Retry once; if it persists, report it with the stderr log hint — do not fabricate results. |

Envelope-level codes arrive with `isError: false` `structuredContent`; protocol/schema
rejections arrive as tool errors instead. Do not paraphrase codes — quote them verbatim.

## Hard limits of this skill

- Use the map for structural facts and source evidence. For an artifact export with its own
  output authorization, see the `architecture-blueprint` skill.
- Never invent node ids, qualified names or evidence: only cite what an envelope
  actually returned.
