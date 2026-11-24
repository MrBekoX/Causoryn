/**
 * CALLS edge resolution breakdown + per-language unresolved ratio for the
 * real-repository benchmark (`scripts/bench/real-repo-eval.mjs`).
 *
 * Why this exists: the overall "unresolved edge %" counts every edge whose
 * resolution is `verified` or `heuristic` as resolved. A `verified` CALLS edge
 * whose target is an `UnknownExternal` node is a call that the analyzer
 * confirmed lands OUTSIDE the analyzed workspace (a library, runtime or test
 * framework such as `expect(...)` or `Array.prototype.push`). It is labelled,
 * not resolved to a project symbol. This module separates those edges from
 * `verified` CALLS edges into project symbols so the headline ratio can be
 * read honestly, and reports the unresolved ratio per language.
 *
 * Data source: Causoryn's own `graph.sqlite` (schema in
 * `packages/storage-sqlite/src/schema.ts`), opened read-only by the caller.
 * Only the latest published snapshot of a workspace is counted, using the
 * same ordering as `SqliteGraphRepository.getLatestWorkspaceSummaryMeta`.
 * Per-language attribution uses the same rule as the engine's
 * `coverage.byLanguage` (`packages/mcp-server/src/services.ts` `coverageOf`):
 * source-node language, else target-node language; `Workspace --CONTAINS-->`
 * edges are never attributed to a language.
 *
 * All SQL is static; values are bound only as prepared-statement parameters.
 * Works with any driver exposing `prepare(sql).get(...)` / `.all(...)`
 * (better-sqlite3, `node:sqlite`). Zero dependencies.
 */

export const UNKNOWN_EXTERNAL_KIND = "UnknownExternal";

const RESOLUTIONS = new Set(["verified", "heuristic", "unresolved"]);

/** Same ordering as SqliteGraphRepository.getLatestWorkspaceSummaryMeta. */
const LATEST_PUBLISHED_SNAPSHOT_SQL = `
  SELECT sid, id, workspace_id AS workspaceId, state
  FROM snapshots
  WHERE workspace_id = ? AND state IN ('ready','partial')
  ORDER BY revision_sequence DESC, published_at DESC, sid DESC
  LIMIT 1`;

const SNAPSHOT_BY_ID_SQL = `
  SELECT sid, id, workspace_id AS workspaceId, state
  FROM snapshots
  WHERE id = ?`;

const PUBLISHED_WORKSPACES_SQL = `
  SELECT DISTINCT workspace_id AS workspaceId
  FROM snapshots
  WHERE state IN ('ready','partial')
  ORDER BY workspace_id ASC`;

const EDGE_GROUPS_SQL = `
  SELECT e.kind AS edgeKind,
         e.resolution AS resolution,
         fn.kind AS fromKind,
         fn.language AS fromLanguage,
         tn.kind AS targetKind,
         tn.language AS targetLanguage,
         COUNT(*) AS count
  FROM edges e
  LEFT JOIN nodes fn
    ON fn.snapshot_sid = e.snapshot_sid AND fn.node_id = e.from_id
  LEFT JOIN nodes tn
    ON tn.snapshot_sid = e.snapshot_sid AND tn.node_id = e.to_id
  WHERE e.snapshot_sid = ?
  GROUP BY e.kind, e.resolution, fn.kind, fn.language, tn.kind, tn.language`;

/** `part / whole` as a percentage rounded to 2 decimals; `null` when `whole` is 0. */
export function percentOf(part, whole) {
  if (whole === 0) return null;
  return Math.round((part / whole) * 10_000) / 100;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Language an edge is attributed to, or `null` (unattributed).
 * Mirrors `coverageOf` in packages/mcp-server/src/services.ts.
 */
export function attributeEdgeLanguage(row) {
  if (row.fromKind === "Workspace" && row.edgeKind === "CONTAINS") return null;
  return nonEmptyString(row.fromLanguage) ?? nonEmptyString(row.targetLanguage);
}

function toCount(value) {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`edge group count must be a non-negative integer (got ${String(value)})`);
  }
  return n;
}

function emptyCalls() {
  return { total: 0, verifiedInternal: 0, verifiedExternal: 0, heuristic: 0, unresolved: 0 };
}

function finishCalls(calls) {
  return {
    ...calls,
    pct: {
      verifiedInternal: percentOf(calls.verifiedInternal, calls.total),
      verifiedExternal: percentOf(calls.verifiedExternal, calls.total),
      heuristic: percentOf(calls.heuristic, calls.total),
      unresolved: percentOf(calls.unresolved, calls.total),
    },
  };
}

function addCall(calls, resolution, targetKind, count) {
  calls.total += count;
  if (resolution === "verified") {
    if (targetKind === UNKNOWN_EXTERNAL_KIND) {
      calls.verifiedExternal += count;
    } else {
      calls.verifiedInternal += count;
    }
  } else if (resolution === "heuristic") {
    calls.heuristic += count;
  } else {
    calls.unresolved += count;
  }
}

/**
 * Pure aggregation over grouped edge rows
 * `{ edgeKind, resolution, fromKind, fromLanguage, targetKind, targetLanguage, count }`.
 */
export function aggregateEdgeBreakdown(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("aggregateEdgeBreakdown expects an array of edge group rows");
  }

  let totalEdges = 0;
  let unresolvedEdges = 0;
  const calls = emptyCalls();
  const languages = new Map();
  const unattributed = { totalEdges: 0, unresolvedEdges: 0 };

  for (const row of rows) {
    const count = toCount(row?.count);
    const resolution = row.resolution;
    if (!RESOLUTIONS.has(resolution)) {
      throw new TypeError(`unexpected edge resolution: ${String(resolution)}`);
    }
    const isUnresolved = resolution === "unresolved";
    const isCalls = row.edgeKind === "CALLS";

    totalEdges += count;
    if (isUnresolved) unresolvedEdges += count;
    if (isCalls) addCall(calls, resolution, row.targetKind, count);

    const language = attributeEdgeLanguage(row);
    if (language === null) {
      unattributed.totalEdges += count;
      if (isUnresolved) unattributed.unresolvedEdges += count;
      continue;
    }
    let bucket = languages.get(language);
    if (bucket === undefined) {
      bucket = {
        totalEdges: 0,
        verifiedEdges: 0,
        heuristicEdges: 0,
        unresolvedEdges: 0,
        calls: emptyCalls(),
      };
      languages.set(language, bucket);
    }
    bucket.totalEdges += count;
    if (resolution === "verified") bucket.verifiedEdges += count;
    else if (resolution === "heuristic") bucket.heuristicEdges += count;
    else bucket.unresolvedEdges += count;
    if (isCalls) addCall(bucket.calls, resolution, row.targetKind, count);
  }

  const byLanguage = {};
  for (const language of [...languages.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bucket = languages.get(language);
    byLanguage[language] = {
      totalEdges: bucket.totalEdges,
      verifiedEdges: bucket.verifiedEdges,
      heuristicEdges: bucket.heuristicEdges,
      unresolvedEdges: bucket.unresolvedEdges,
      unresolvedPct: percentOf(bucket.unresolvedEdges, bucket.totalEdges),
      calls: finishCalls(bucket.calls),
    };
  }

  return {
    totalEdges,
    unresolvedEdges,
    unresolvedPct: percentOf(unresolvedEdges, totalEdges),
    calls: finishCalls(calls),
    byLanguage,
    unattributed,
  };
}

function resolveLatestPublishedSnapshot(db, snapshotId) {
  let workspaceId;
  if (snapshotId !== undefined && snapshotId !== null) {
    const requested = db.prepare(SNAPSHOT_BY_ID_SQL).get(snapshotId);
    if (requested === undefined) {
      throw new Error(`snapshot ${snapshotId} not found in graph database`);
    }
    workspaceId = requested.workspaceId;
  } else {
    const workspaces = db.prepare(PUBLISHED_WORKSPACES_SQL).all();
    if (workspaces.length === 0) {
      throw new Error("graph database has no published (ready/partial) snapshot");
    }
    if (workspaces.length > 1) {
      throw new Error(
        `graph database has published snapshots for ${String(workspaces.length)} workspaces; pass the snapshotId to choose one`,
      );
    }
    workspaceId = workspaces[0].workspaceId;
  }

  const latest = db.prepare(LATEST_PUBLISHED_SNAPSHOT_SQL).get(workspaceId);
  if (latest === undefined || typeof latest.id !== "string" || latest.id.length === 0) {
    throw new Error(`workspace ${String(workspaceId)} has no published (ready/partial) snapshot`);
  }
  if (snapshotId !== undefined && snapshotId !== null && latest.id !== snapshotId) {
    throw new Error(
      `snapshot ${snapshotId} is not the latest published snapshot of workspace ${String(workspaceId)} (latest: ${latest.id})`,
    );
  }
  return latest;
}

/**
 * Breakdown of the latest published snapshot. When `snapshotId` is given it
 * must be that latest snapshot (guards against counting a stale one).
 */
export function computeEdgeBreakdown(db, options = {}) {
  const snapshot = resolveLatestPublishedSnapshot(db, options.snapshotId);
  const rows = db.prepare(EDGE_GROUPS_SQL).all(snapshot.sid);
  return {
    workspaceId: snapshot.workspaceId,
    snapshotId: snapshot.id,
    snapshotState: snapshot.state,
    ...aggregateEdgeBreakdown(rows),
  };
}

/**
 * Cross-checks the database breakdown with the MCP envelope `coverage`
 * (`totalEdges`, `unresolvedEdges`, `byLanguage`). Languages missing on one
 * side count as zero edges.
 */
export function compareWithMcpCoverage(breakdown, coverage) {
  if (coverage === null || coverage === undefined) {
    return { compared: false, totalsMatch: false, mismatchedLanguages: [] };
  }
  const totalsMatch =
    breakdown.totalEdges === coverage.totalEdges &&
    breakdown.unresolvedEdges === coverage.unresolvedEdges;
  const mcpByLanguage = coverage.byLanguage ?? {};
  const languages = new Set([...Object.keys(breakdown.byLanguage), ...Object.keys(mcpByLanguage)]);
  const mismatchedLanguages = [];
  for (const language of [...languages].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ours = breakdown.byLanguage[language];
    const theirs = mcpByLanguage[language];
    const same =
      (ours?.verifiedEdges ?? 0) === (theirs?.verifiedEdges ?? 0) &&
      (ours?.heuristicEdges ?? 0) === (theirs?.heuristicEdges ?? 0) &&
      (ours?.unresolvedEdges ?? 0) === (theirs?.unresolvedEdges ?? 0);
    if (!same) mismatchedLanguages.push(language);
  }
  return { compared: true, totalsMatch, mismatchedLanguages };
}

function formatPct(value) {
  return value === null ? "n/a" : `${String(value)}%`;
}

function formatCount(value) {
  return value.toLocaleString("en-US");
}

/**
 * Markdown lines for the benchmark report. Accepts either
 * `{ available: true, ...computeEdgeBreakdown() }` or `{ available: false, reason }`.
 */
export function formatEdgeBreakdownMarkdown(breakdown) {
  const lines = ["### CALLS Edge Resolution Breakdown", ""];
  if (breakdown?.available !== true) {
    lines.push(
      `Not measured: ${String(breakdown?.reason ?? "edge breakdown unavailable")}. The overall unresolved edge % above cannot be split by CALLS target for this run.`,
    );
    lines.push("");
    return lines;
  }

  const c = breakdown.calls;
  lines.push(
    `Source: \`graph.sqlite\` read-only, latest published snapshot \`${breakdown.snapshotId}\` (state \`${breakdown.snapshotState}\`). All edge kinds: ${formatCount(breakdown.unresolvedEdges)} unresolved of ${formatCount(breakdown.totalEdges)} (${formatPct(breakdown.unresolvedPct)}).`,
  );
  lines.push("");
  lines.push(
    "How to read the overall unresolved edge %: it counts every `verified` or `heuristic` edge as resolved. A `verified` CALLS edge whose target is an `UnknownExternal` node (`verifiedExternal`) is a call the analyzer confirmed lands outside the analyzed workspace, in a library, runtime or test framework (for example `expect(...)` or `Array.prototype.push`). These edges are labelled as external; they are not resolved to a project symbol. Only `verifiedInternal` CALLS edges end at a symbol defined in the workspace.",
  );
  lines.push("");
  lines.push(`| CALLS bucket | Edges | % of CALLS (${formatCount(c.total)}) |`);
  lines.push("|---|---|---|");
  lines.push(`| \`verifiedInternal\` | ${formatCount(c.verifiedInternal)} | ${formatPct(c.pct.verifiedInternal)} |`);
  lines.push(`| \`verifiedExternal\` | ${formatCount(c.verifiedExternal)} | ${formatPct(c.pct.verifiedExternal)} |`);
  lines.push(`| \`heuristic\` | ${formatCount(c.heuristic)} | ${formatPct(c.pct.heuristic)} |`);
  lines.push(`| \`unresolved\` | ${formatCount(c.unresolved)} | ${formatPct(c.pct.unresolved)} |`);
  lines.push("");

  const languageEntries = Object.entries(breakdown.byLanguage);
  lines.push("### Unresolved Edge Ratio by Language");
  lines.push("");
  if (languageEntries.length === 0) {
    lines.push("No edge is attributed to a language in this snapshot.");
    lines.push("");
    return lines;
  }
  lines.push(
    "Unresolved % = unresolved edges / all edges attributed to the language (source-node language, else target-node language; the same rule as `coverage.byLanguage`).",
  );
  lines.push("");
  lines.push(
    "| Language | Edges | Unresolved | Unresolved % | CALLS | CALLS verifiedInternal | CALLS verifiedExternal | CALLS heuristic | CALLS unresolved |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [language, bucket] of languageEntries) {
    const lc = bucket.calls;
    lines.push(
      `| ${language} | ${formatCount(bucket.totalEdges)} | ${formatCount(bucket.unresolvedEdges)} | ${formatPct(bucket.unresolvedPct)} | ${formatCount(lc.total)} | ${formatCount(lc.verifiedInternal)} | ${formatCount(lc.verifiedExternal)} | ${formatCount(lc.heuristic)} | ${formatCount(lc.unresolved)} |`,
    );
  }
  if (breakdown.unattributed.totalEdges > 0) {
    lines.push(
      `| (no language) | ${formatCount(breakdown.unattributed.totalEdges)} | ${formatCount(breakdown.unattributed.unresolvedEdges)} | ${formatPct(percentOf(breakdown.unattributed.unresolvedEdges, breakdown.unattributed.totalEdges))} | — | — | — | — | — |`,
    );
  }
  lines.push("");

  const consistency = breakdown.consistencyWithMcpCoverage;
  if (consistency !== undefined && consistency.compared) {
    const ok = consistency.totalsMatch && consistency.mismatchedLanguages.length === 0;
    lines.push(
      ok
        ? "Cross-check: database totals and per-language counts match the MCP `coverage` of the same snapshot."
        : `Cross-check MISMATCH against the MCP \`coverage\`: totalsMatch=${String(consistency.totalsMatch)}, languages=[${consistency.mismatchedLanguages.join(", ")}].`,
    );
    lines.push("");
  }
  return lines;
}
