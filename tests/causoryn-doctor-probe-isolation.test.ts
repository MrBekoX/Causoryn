/**
 * `causoryn doctor` toolchain probes (dotnet / python / go / cargo):
 * - the toolchain is resolved to an absolute path outside the current
 *   working directory (and never through a relative or cwd PATH entry),
 * - the probe runs from the probed executable's own directory, not from
 *   the shared temporary directory, so project files there (go.mod,
 *   rust-toolchain.toml, .python-version, global.json) do not apply,
 * - the probe environment pins the Go toolchain like the Go adapter and
 *   disables the Windows cwd-first executable search.
 * Doctor stays read-only: the probes create no files or directories.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { defaultToolchainProbe } from "../packages/causoryn/src/doctor.js";
import {
  buildMarkerExecutable,
  plantMarkers,
  startedMarkers,
  withCwdSearchUnmasked,
} from "./spawn-marker.js";

const IS_WIN = process.platform === "win32";
const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

/** Runs `fn` with os.tmpdir() pointing at `dir`. */
async function withTmpdir<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const keys = ["TMPDIR", "TEMP", "TMP"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = dir;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PROBED = ["dotnet", "python", "python3", "go", "cargo"] as const;

describe("doctor toolchain probes are isolated from the working and temporary directories", () => {
  const marker = buildMarkerExecutable();

  it.skipIf(marker === null)(
    "toolchains planted in the cwd / temporary directory are never started",
    async () => {
      const fixture = tempDir("causoryn-doctor-planted-");
      const planted = plantMarkers(marker!, fixture, PROBED);
      await withTmpdir(fixture, () =>
        withCwdSearchUnmasked(fixture, () => {
          for (const command of PROBED) {
            defaultToolchainProbe(command, ["--version"], 10_000);
          }
        }),
      );
      expect(startedMarkers(planted)).toEqual([]);
    },
    240_000,
  );

  it.skipIf(marker === null)(
    "a command that exists only in the cwd is reported as not found",
    async () => {
      const fixture = tempDir("causoryn-doctor-cwd-only-");
      const planted = plantMarkers(marker!, fixture, ["causoryn-probe-cwd-only"]);
      const outcome = await withCwdSearchUnmasked(fixture, () =>
        defaultToolchainProbe("causoryn-probe-cwd-only", ["--version"], 10_000),
      );
      expect(outcome.available).toBe(false);
      expect(outcome.failure).toBe("not-found");
      expect(startedMarkers(planted)).toEqual([]);
    },
    240_000,
  );

  it("probes run from the executable's own directory with the Go toolchain pinned and create no files", async () => {
    const fixture = tempDir("causoryn-doctor-probe-env-");
    const script = [
      "console.log(JSON.stringify({",
      "  cwd: process.cwd(),",
      "  gotoolchain: process.env.GOTOOLCHAIN ?? null,",
      "  goenv: process.env.GOENV ?? null,",
      "  gowork: process.env.GOWORK ?? null,",
      "  noDefault: process.env.NoDefaultCurrentDirectoryInExePath ?? null,",
      "}));",
    ].join("\n");
    const outcome = await withTmpdir(fixture, () =>
      defaultToolchainProbe(process.execPath, ["-e", script], 10_000),
    );
    expect(outcome.available).toBe(true);
    const seen = JSON.parse(outcome.version ?? "{}") as Record<string, string | null>;
    expect(realpathSync.native(seen["cwd"] ?? "")).toBe(
      realpathSync.native(path.dirname(process.execPath)),
    );
    expect(seen["gotoolchain"]).toBe("local");
    expect(seen["goenv"]).toBe("off");
    expect(seen["gowork"]).toBe("off");
    expect(seen["noDefault"]).toBe(IS_WIN ? "1" : null);
    expect(readdirSync(fixture)).toEqual([]);
  });
});
