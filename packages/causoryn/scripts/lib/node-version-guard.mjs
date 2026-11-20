/**
 * Pre-import Node.js runtime version guard (>= 24, K-021 / F-P2-04).
 *
 * Zero external dependencies: runs before loading native addons or Node 24
 * APIs so unsupported runtimes exit cleanly with code 2 and a clear stderr
 * diagnostic while preserving strict stdout hygiene for MCP JSON-RPC.
 */

export function assertSupportedNodeVersion(
  nodeVersion = process.versions.node,
  minMajor = 24,
) {
  const cleaned = String(nodeVersion ?? "").trim().replace(/^v/i, "");
  const majorStr = cleaned.split(".")[0] ?? "0";
  const major = Number.parseInt(majorStr, 10);
  const ok = Number.isFinite(major) && major >= minMajor;
  if (!ok) {
    process.stderr.write(
      `[causoryn] Unsupported Node.js version (${cleaned || "unknown"}). Causoryn requires Node.js >= ${String(minMajor)}.\n`,
    );
    process.exit(2);
  }
  return { ok: true, major };
}
