/**
 * @causoryn/sidecar-ipc birim testleri — ortak sidecar worker IPC çekirdeği
 * (TŞ v2.1 §7 adapter izolasyonu, §9 resource budget).
 *
 * Kapsam:
 * - buildAllowlistedWorkerEnv: yalnızca allowlist'teki boş-olmayan env
 *   değişkenlerini kopyalar; gizli değişkenleri sızdırmaz; overrides'ı
 *   koşulsuz uygular.
 * - runLineJsonWorker: parçalı NDJSON framing, boş satır atlama, zaman aşımı,
 *   stdout/stderr karakter bütçeleri, geçersiz JSON, erken çıkış (exit/signal),
 *   spawn senkron/asenkron hataları, stdin EPIPE yutma / senkron yazma hatası,
 *   onKillChild kancası ve exactOptionalPropertyTypes uyumlu cwd aktarımı.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildAllowlistedWorkerEnv,
  resolveCausorynAssetRoot,
  runLineJsonWorker,
  type SidecarSpawnOptions,
} from "@causoryn/sidecar-ipc";

/** Absolute fake command (the injected spawn never runs it; bare names are refused). */
const WORKER_COMMAND = path.join(os.tmpdir(), "worker-bin");

interface FakeChildController {
  readonly child: ChildProcess;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly stdin: EventEmitter & {
    write: (chunk: string) => boolean;
    end: () => void;
  };
  readonly writtenChunks: string[];
  stdinEnded: boolean;
  killCount: number;
}

function createFakeChild(options?: {
  readonly pid?: number;
  readonly throwOnWrite?: Error;
}): FakeChildController {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const writtenChunks: string[] = [];

  const controller: FakeChildController = {
    child,
    stdout,
    stderr,
    stdin: Object.assign(stdinEmitter, {
      write: (chunk: string): boolean => {
        if (options?.throwOnWrite !== undefined) {
          throw options.throwOnWrite;
        }
        writtenChunks.push(chunk);
        return true;
      },
      end: (): void => {
        controller.stdinEnded = true;
      },
    }),
    writtenChunks,
    stdinEnded: false,
    killCount: 0,
  };

  const record = child as unknown as Record<string, unknown>;
  record["stdout"] = stdout;
  record["stderr"] = stderr;
  record["stdin"] = controller.stdin;
  record["pid"] = options?.pid;
  record["killed"] = false;
  record["exitCode"] = null;
  record["signalCode"] = null;
  record["kill"] = (): boolean => {
    controller.killCount += 1;
    record["killed"] = true;
    return true;
  };

  return controller;
}

describe("buildAllowlistedWorkerEnv", () => {
  it("yalnızca allowlist'teki boş-olmayan process.env değerlerini kopyalar; gizli değişkenleri sızdırmaz", () => {
    const prevAllowed = process.env["CAUSORYN_IPC_ALLOWED"];
    const prevEmpty = process.env["CAUSORYN_IPC_EMPTY"];
    const prevUnlisted = process.env["SECRET_API_KEY"];

    process.env["CAUSORYN_IPC_ALLOWED"] = "izinli-deger";
    process.env["CAUSORYN_IPC_EMPTY"] = "";
    process.env["SECRET_API_KEY"] = "gizli-" + "anahtar";

    try {
      const env = buildAllowlistedWorkerEnv([
        "CAUSORYN_IPC_ALLOWED",
        "CAUSORYN_IPC_EMPTY",
        "CAUSORYN_IPC_MISSING",
      ]);

      expect(env).toEqual({
        CAUSORYN_IPC_ALLOWED: "izinli-deger",
      });
      expect(env["SECRET_API_KEY"]).toBeUndefined();
      expect("CAUSORYN_IPC_EMPTY" in env).toBe(false);
      expect("CAUSORYN_IPC_MISSING" in env).toBe(false);
    } finally {
      if (prevAllowed === undefined) delete process.env["CAUSORYN_IPC_ALLOWED"];
      else process.env["CAUSORYN_IPC_ALLOWED"] = prevAllowed;

      if (prevEmpty === undefined) delete process.env["CAUSORYN_IPC_EMPTY"];
      else process.env["CAUSORYN_IPC_EMPTY"] = prevEmpty;

      if (prevUnlisted === undefined) delete process.env["SECRET_API_KEY"];
      else process.env["SECRET_API_KEY"] = prevUnlisted;
    }
  });

  it("overrides değerlerini parent ortamından bağımsız olarak koşulsuz uygular", () => {
    const prevEncoding = process.env["PYTHONIOENCODING"];
    const prevPath = process.env["CAUSORYN_IPC_PATH_TEST"];

    process.env["PYTHONIOENCODING"] = "cp1254";
    process.env["CAUSORYN_IPC_PATH_TEST"] = "/usr/bin";

    try {
      const env = buildAllowlistedWorkerEnv(
        ["CAUSORYN_IPC_PATH_TEST", "PYTHONIOENCODING"],
        {
          PYTHONIOENCODING: "utf-8",
          CAUSORYN_IPC_PATH_TEST: "/opt/worker:/usr/bin",
        },
      );

      expect(env["PYTHONIOENCODING"]).toBe("utf-8");
      expect(env["CAUSORYN_IPC_PATH_TEST"]).toBe("/opt/worker:/usr/bin");
    } finally {
      if (prevEncoding === undefined) delete process.env["PYTHONIOENCODING"];
      else process.env["PYTHONIOENCODING"] = prevEncoding;

      if (prevPath === undefined) delete process.env["CAUSORYN_IPC_PATH_TEST"];
      else process.env["CAUSORYN_IPC_PATH_TEST"] = prevPath;
    }
  });
});

describe("runLineJsonWorker", () => {
  it("parçalı NDJSON stdout framing: kısmi parçaları birleştirir, baştaki boş satırları atlar ve ilk JSON satırını parse eder", async () => {
    const fake = createFakeChild();

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: ["--mode", "analyze"],
      env: { PATH: "/usr/bin" },
      requestPayload: { id: "req-1", type: "analyze" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.emit("data", Buffer.from("[worker] hazir\n", "utf8"));
          fake.stdout.emit("data", Buffer.from("\n", "utf8"));
          fake.stdout.emit("data", Buffer.from("   \r\n", "utf8"));
          fake.stdout.emit("data", Buffer.from('{"id":"req-1",', "utf8"));
          fake.stdout.emit(
            "data",
            Buffer.from('"status":"ready"}\n{"id":"ikinci-satir"}\n', "utf8"),
          );
        });
        return fake.child;
      },
    });

    expect(outcome).toEqual({
      status: "ok",
      response: { id: "req-1", status: "ready" },
      stderr: "[worker] hazir\n",
      detail: "",
    });
    expect(fake.writtenChunks).toEqual([
      '{"id":"req-1","type":"analyze"}\n',
    ]);
    expect(fake.stdinEnded).toBe(true);
  });

  it("keeps a response that is delivered after the process 'exit' event (stdout drains before 'close')", async () => {
    // Real child processes may emit 'exit' before the last stdout chunk is read:
    // a worker that answers, sees EOF on stdin and exits 0 must not lose its answer.
    const fake = createFakeChild();
    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "req-exit-first" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        setTimeout(() => {
          const record = fake.child as unknown as Record<string, unknown>;
          record["exitCode"] = 0;
          fake.child.emit("exit", 0, null);
          setTimeout(() => {
            fake.stdout.emit("data", Buffer.from('{"id":"req-exit-first","status":"ready"}\n', "utf8"));
            fake.child.emit("close", 0, null);
          }, 20);
        }, 0);
        return fake.child;
      },
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.response).toEqual({ id: "req-exit-first", status: "ready" });
  });

  it("reports an early exit once stdout has closed without a response line", async () => {
    const fake = createFakeChild();
    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "req-exit-empty" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        setTimeout(() => {
          const record = fake.child as unknown as Record<string, unknown>;
          record["exitCode"] = 0;
          fake.child.emit("exit", 0, null);
          fake.child.emit("close", 0, null);
        }, 0);
        return fake.child;
      },
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.detail).toContain("worker exited (exit=0)");
  });

  it("newline gelmeyen yarım satırda requestTimeoutMs sonunda süreci sonlandırır ve tam timeout detayı döner", async () => {
    const fake = createFakeChild();
    const requestTimeoutMs = 80;

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "half" },
      requestTimeoutMs,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.emit("data", Buffer.from("bekliyor", "utf8"));
          fake.stdout.emit("data", Buffer.from('{"id":"half"', "utf8"));
        });
        return fake.child;
      },
    });

    expect(outcome.status).toBe("timeout");
    expect(outcome.response).toBeNull();
    expect(outcome.stderr).toBe("bekliyor");
    expect(outcome.detail).toBe(
      `worker did not respond within ${String(requestTimeoutMs)} ms (timeout); the process was terminated and the next request uses a fresh process`,
    );
    expect(fake.killCount).toBe(1);
  });

  it("responseMaxChars aşımında süreci sonlandırır ve unavailable + tam sınır detayı döner", async () => {
    const fake = createFakeChild();
    const responseMaxChars = 32;

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "oversize-stdout" },
      requestTimeoutMs: 5_000,
      responseMaxChars,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.emit("data", Buffer.from("x".repeat(20), "utf8"));
          fake.stdout.emit("data", Buffer.from("y".repeat(20) + "\n", "utf8"));
        });
        return fake.child;
      },
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.response).toBeNull();
    expect(outcome.detail).toBe(
      `worker response line exceeded the ${String(responseMaxChars)} character limit; the process was terminated and the next request uses a fresh process with L0/L1 fallback`,
    );
    expect(fake.killCount).toBe(1);
  });

  it("stderrMaxChars aşımında stderr'i kırpar, süreci sonlandırır ve unavailable + tam sınır detayı döner", async () => {
    const fake = createFakeChild();
    const stderrMaxChars = 25;

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "oversize-stderr" },
      requestTimeoutMs: 5_000,
      stderrMaxChars,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.emit("data", Buffer.from("a".repeat(15), "utf8"));
          fake.stderr.emit("data", Buffer.from("b".repeat(20), "utf8"));
        });
        return fake.child;
      },
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.response).toBeNull();
    expect(outcome.stderr).toBe("a".repeat(15) + "b".repeat(10));
    expect(outcome.stderr.length).toBe(stderrMaxChars);
    expect(outcome.detail).toBe(
      `worker stderr output exceeded the ${String(stderrMaxChars)} character limit; the process was terminated and the next request uses a fresh process with L0/L1 fallback`,
    );
    expect(fake.killCount).toBe(1);
  });

  it("geçersiz JSON yanıt satırında süreci sonlandırır ve geçersiz JSON detayı döner", async () => {
    const fake = createFakeChild();

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "bad-json" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stdout.emit("data", Buffer.from("{bozuk-json\n", "utf8"));
        });
        return fake.child;
      },
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.response).toBeNull();
    expect(outcome.detail.startsWith("worker response is not valid JSON: ")).toBe(
      true,
    );
    expect(fake.killCount).toBe(1);
  });

  it("yanıttan önce exit kodu ile kapanan süreçte unavailable ve stderr özetli detay döner", async () => {
    const fakeWithStderr = createFakeChild();
    const outcomeWithStderr = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "exit-code" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fakeWithStderr.stderr.emit(
            "data",
            Buffer.from("  çökme sebebi  \n", "utf8"),
          );
          fakeWithStderr.child.emit("exit", 2, null);
        });
        return fakeWithStderr.child;
      },
    });

    expect(outcomeWithStderr).toEqual({
      status: "unavailable",
      response: null,
      stderr: "  çökme sebebi  \n",
      detail: "worker exited (exit=2); stderr: çökme sebebi",
    });
    expect(fakeWithStderr.killCount).toBe(0);

    const fakeEmpty = createFakeChild();
    const outcomeEmpty = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "exit-null" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fakeEmpty.child.emit("exit", null, null);
        });
        return fakeEmpty.child;
      },
    });

    expect(outcomeEmpty.detail).toBe(
      "worker exited (exit=unknown); stderr: (empty)",
    );
  });

  it("yanıttan önce sinyal ile sonlanan süreçte sinyal adını taşıyan detay döner", async () => {
    const fake = createFakeChild();

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "exit-signal" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.child.emit("exit", null, "SIGTERM");
        });
        return fake.child;
      },
    });

    expect(outcome).toEqual({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "worker terminated by signal (SIGTERM)",
    });
    expect(fake.killCount).toBe(0);
  });

  it("spawnProcess senkron hata fırlattığında veya child error olayı ürettiğinde başlatılamadı detayı döner", async () => {
    const syncOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "spawn-sync-err" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        throw new Error("senkron ENOENT");
      },
    });

    expect(syncOutcome).toEqual({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "worker process could not be started: senkron ENOENT",
    });

    const fake = createFakeChild();
    const asyncOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "spawn-async-err" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.child.emit("error", new Error("asenkron ENOENT"));
        });
        return fake.child;
      },
    });

    expect(asyncOutcome).toEqual({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "worker process could not be started: asenkron ENOENT",
    });
  });

  it("stdin EPIPE error olayını uncaught exception olmadan yutar; stdin.write senkron hatasında açık detay döner", async () => {
    const fakeEpipe = createFakeChild();
    const epipeOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "epipe" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          const epipe = Object.assign(new Error("write EPIPE"), {
            code: "EPIPE",
          });
          fakeEpipe.stdin.emit("error", epipe);
          fakeEpipe.child.emit("exit", 1, null);
        });
        return fakeEpipe.child;
      },
    });

    expect(epipeOutcome.status).toBe("unavailable");
    expect(epipeOutcome.detail).toBe("worker exited (exit=1); stderr: (empty)");

    const fakeWriteThrow = createFakeChild({
      throwOnWrite: new Error("boru kapali"),
    });
    const writeThrowOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "write-throw" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => fakeWriteThrow.child,
    });

    expect(writeThrowOutcome).toEqual({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "request could not be written to the worker: boru kapali",
    });
    expect(fakeWriteThrow.killCount).toBe(1);
  });

  it("onKillChild kancasını yalnızca çalışan çocuk süreç sonlandırılırken çağırır", async () => {
    const killedPids: Array<number | undefined> = [];
    const runningFake = createFakeChild({ pid: 9001 });

    const timeoutOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "hook-timeout" },
      requestTimeoutMs: 60,
      spawnProcess: () => runningFake.child,
      onKillChild: (closing) => {
        killedPids.push(closing.pid);
      },
    });

    expect(timeoutOutcome.status).toBe("timeout");
    expect(runningFake.killCount).toBe(1);
    expect(killedPids).toEqual([9001]);

    const exitedFake = createFakeChild({ pid: 9002 });
    const exitedOutcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "hook-exited" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          exitedFake.child.emit("exit", 1, null);
        });
        return exitedFake.child;
      },
      onKillChild: (closing) => {
        killedPids.push(closing.pid);
      },
    });

    expect(exitedOutcome.status).toBe("unavailable");
    expect(exitedFake.killCount).toBe(0);
    expect(killedPids).toEqual([9001]);
  });

  it("cwd tanımsızken spawnProcess seçeneklerine cwd anahtarı eklemez; tanımlıyken aynen geçirir", async () => {
    const capturedOptions: SidecarSpawnOptions[] = [];

    const withoutCwdFake = createFakeChild();
    await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: ["exec"],
      env: { PATH: "/bin" },
      requestPayload: { id: "no-cwd" },
      requestTimeoutMs: 5_000,
      spawnProcess: (_cmd, _args, options) => {
        capturedOptions.push(options);
        queueMicrotask(() => {
          withoutCwdFake.stdout.emit("data", Buffer.from('{"ok":true}\n', "utf8"));
        });
        return withoutCwdFake.child;
      },
    });

    const withCwdFake = createFakeChild();
    await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: ["run"],
      env: { PATH: "/bin" },
      cwd: "/repo/native/go-worker",
      requestPayload: { id: "with-cwd" },
      requestTimeoutMs: 5_000,
      spawnProcess: (_cmd, _args, options) => {
        capturedOptions.push(options);
        queueMicrotask(() => {
          withCwdFake.stdout.emit("data", Buffer.from('{"ok":true}\n', "utf8"));
        });
        return withCwdFake.child;
      },
    });

    expect(capturedOptions).toHaveLength(2);
    const firstOpts = capturedOptions[0];
    const secondOpts = capturedOptions[1];
    if (firstOpts === undefined || secondOpts === undefined) {
      throw new Error("spawn seçenekleri yakalanamadı");
    }

    expect("cwd" in firstOpts).toBe(false);
    expect(Object.keys(firstOpts).sort()).toEqual([
      "env",
      "shell",
      "stdio",
      "windowsHide",
    ]);
    // win32 children additionally get NoDefaultCurrentDirectoryInExePath=1.
    const expectedEnv =
      process.platform === "win32"
        ? { PATH: "/bin", NoDefaultCurrentDirectoryInExePath: "1" }
        : { PATH: "/bin" };
    expect(firstOpts).toEqual({
      stdio: ["pipe", "pipe", "pipe"],
      env: expectedEnv,
      shell: false,
      windowsHide: true,
    });

    expect("cwd" in secondOpts).toBe(true);
    expect(secondOpts).toEqual({
      stdio: ["pipe", "pipe", "pipe"],
      env: expectedEnv,
      cwd: "/repo/native/go-worker",
      shell: false,
      windowsHide: true,
    });
  });

  it("boş veya yalnızca boşluk içeren cwd değerini süreç başlatmadan reddeder", async () => {
    let spawnCalled = false;
    for (const invalidCwd of ["", "   ", "\t\n", "/tmp/\0bad"]) {
      const outcome = await runLineJsonWorker({
        command: WORKER_COMMAND,
        args: [],
        env: { PATH: "/bin" },
        cwd: invalidCwd,
        requestPayload: { id: "invalid-cwd" },
        requestTimeoutMs: 5_000,
        spawnProcess: () => {
          spawnCalled = true;
          return createFakeChild().child;
        },
      });
      expect(outcome.status).toBe("unavailable");
      expect(outcome.detail).toContain("cwd");
    }
    expect(spawnCalled).toBe(false);
  });

  it("refuses bare or relative command names without spawning (Windows searches the cwd first)", async () => {
    let spawnCalled = false;
    for (const command of ["worker-bin", "./worker-bin", "bin/worker-bin", "", "C:worker.exe"]) {
      const outcome = await runLineJsonWorker({
        command,
        args: [],
        env: { PATH: "/bin" },
        cwd: os.tmpdir(),
        requestPayload: { id: "bare-command" },
        requestTimeoutMs: 5_000,
        spawnProcess: () => {
          spawnCalled = true;
          return createFakeChild().child;
        },
      });
      expect(outcome.status).toBe("unavailable");
      expect(outcome.detail).toContain("must be an absolute path");
    }
    expect(spawnCalled).toBe(false);
  });

  it("çok-baytlı UTF-8 karakterleri (ş, ğ, İ, —) iki Buffer parçası arasında bölündüğünde bozulmadan (U+FFFD üretmeden) çözümler", async () => {
    const fake = createFakeChild();
    const expectedText = "Türkçe çağrı çözümlemesi — doğrulandı (şğüöçıİ)";
    const fullStdout = Buffer.from(JSON.stringify({ message: expectedText }) + "\n", "utf8");
    const fullStderr = Buffer.from("uyarı: işğü — tamam\n", "utf8");

    // "ş" (0xC5 0x9F) veya "—" (0xE2 0x80 0x94) karakterinin TAM ORTASINDAN böl!
    const emDashOffset = fullStdout.indexOf(Buffer.from("—", "utf8"));
    expect(emDashOffset).toBeGreaterThan(0);
    const stdoutPart1 = fullStdout.subarray(0, emDashOffset + 1); // 3-byte UTF-8'in ilk baytından sonra kes!
    const stdoutPart2 = fullStdout.subarray(emDashOffset + 1);

    const stderrDashOffset = fullStderr.indexOf(Buffer.from("—", "utf8"));
    const stderrPart1 = fullStderr.subarray(0, stderrDashOffset + 1);
    const stderrPart2 = fullStderr.subarray(stderrDashOffset + 1);

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "utf8-split" },
      requestTimeoutMs: 5_000,
      spawnProcess: () => {
        queueMicrotask(() => {
          fake.stderr.emit("data", stderrPart1);
          fake.stderr.emit("data", stderrPart2);
          fake.stdout.emit("data", stdoutPart1);
          fake.stdout.emit("data", stdoutPart2);
        });
        return fake.child;
      },
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.response).toEqual({ message: expectedText });
    expect(outcome.stderr).toBe("uyarı: işğü — tamam\n");
    expect(JSON.stringify(outcome.response)).not.toContain("\uFFFD");
    expect(outcome.stderr).not.toContain("\uFFFD");
  });
});

describe("resolveCausorynAssetRoot", () => {
  it("CAUSORYN_ASSET_ROOT ortam değişkeni dolu olduğunda yürüyüş yapmadan trim+resolve edilmiş yolu döner", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ipc-env-"));
    try {
      const overrideDir = path.join(tmpDir, "custom-assets");
      const entryUrl = pathToFileURL(
        path.join(tmpDir, "pkg", "dist", "mcp-server.mjs"),
      ).href;

      const resolved = resolveCausorynAssetRoot(entryUrl, {
        env: { CAUSORYN_ASSET_ROOT: `  ${overrideDir}  ` },
      });

      expect(resolved).toBe(path.resolve(overrideDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("derinlik-1 paketlenmiş düzende (<tmp>/pkg/dist/mcp-server.mjs) <tmp>/pkg kökünü bulur", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ipc-pkg-"));
    try {
      const pkgRoot = path.join(tmpDir, "pkg");
      const distDir = path.join(pkgRoot, "dist");
      const pythonWorkerDir = path.join(pkgRoot, "native", "python-worker");
      mkdirSync(distDir, { recursive: true });
      mkdirSync(pythonWorkerDir, { recursive: true });
      writeFileSync(path.join(pythonWorkerDir, "worker.py"), "# worker\n", "utf8");

      const entryUrl = pathToFileURL(path.join(distDir, "mcp-server.mjs")).href;
      const resolved = resolveCausorynAssetRoot(entryUrl, { env: {} });

      expect(resolved).toBe(pkgRoot);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("derinlik-3 monorepo düzeninde (<tmp>/repo/adapters/python/dist/analyzer.js) <tmp>/repo kökünü bulur", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ipc-repo-"));
    try {
      const repoRoot = path.join(tmpDir, "repo");
      const adapterDistDir = path.join(repoRoot, "adapters", "python", "dist");
      const pythonWorkerDir = path.join(repoRoot, "native", "python-worker");
      mkdirSync(adapterDistDir, { recursive: true });
      mkdirSync(pythonWorkerDir, { recursive: true });
      writeFileSync(path.join(pythonWorkerDir, "worker.py"), "# worker\n", "utf8");

      const entryUrl = pathToFileURL(path.join(adapterDistDir, "analyzer.js")).href;
      const resolved = resolveCausorynAssetRoot(entryUrl, { env: {} });

      expect(resolved).toBe(repoRoot);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("native/python-worker/worker.py bulunamadığında klasik 3-seviye üst dizine düşer", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ipc-fallback-"));
    try {
      const startDir = path.join(
        tmpDir,
        "isolated",
        "adapters",
        "python",
        "dist",
      );
      mkdirSync(startDir, { recursive: true });

      const entryUrl = pathToFileURL(path.join(startDir, "analyzer.js")).href;
      const resolved = resolveCausorynAssetRoot(entryUrl, { env: {} });

      expect(resolved).toBe(
        path.dirname(path.dirname(path.dirname(startDir))),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("yalnızca boşluk içeren CAUSORYN_ASSET_ROOT ('   ') değerini yok sayıp dizin yürüyüşüne düşer", () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "causoryn-ipc-whitespace-"),
    );
    try {
      const pkgRoot = path.join(tmpDir, "pkg");
      const distDir = path.join(pkgRoot, "dist");
      const pythonWorkerDir = path.join(pkgRoot, "native", "python-worker");
      mkdirSync(distDir, { recursive: true });
      mkdirSync(pythonWorkerDir, { recursive: true });
      writeFileSync(
        path.join(pythonWorkerDir, "worker.py"),
        "# worker\n",
        "utf8",
      );

      const entryUrl = pathToFileURL(path.join(distDir, "mcp-server.mjs")).href;
      const resolved = resolveCausorynAssetRoot(entryUrl, {
        env: { CAUSORYN_ASSET_ROOT: "   " },
      });

      expect(resolved).toBe(pkgRoot);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("özel maxWalkDepth sınırına uyar: sığ sınırda fallback'e düşer, derin sınırda hedef kökü bulur", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ipc-depth-"));
    try {
      const deepRoot = path.join(tmpDir, "deep-root");
      const pythonWorkerDir = path.join(deepRoot, "native", "python-worker");
      const nestedStartDir = path.join(deepRoot, "a", "b", "c", "d", "e");
      mkdirSync(pythonWorkerDir, { recursive: true });
      mkdirSync(nestedStartDir, { recursive: true });
      writeFileSync(
        path.join(pythonWorkerDir, "worker.py"),
        "# worker\n",
        "utf8",
      );

      const entryUrl = pathToFileURL(path.join(nestedStartDir, "entry.js")).href;

      // Varsayılan maxWalkDepth=4 derinlik-5'teki deepRoot'a ulaşamaz → 3-seviye üst dizine (deepRoot/a/b) düşer.
      expect(resolveCausorynAssetRoot(entryUrl, { env: {} })).toBe(
        path.dirname(path.dirname(path.dirname(nestedStartDir))),
      );

      // Açık sığ maxWalkDepth=2 de ulaşamaz → 3-seviye üst dizine düşer.
      expect(
        resolveCausorynAssetRoot(entryUrl, { env: {}, maxWalkDepth: 2 }),
      ).toBe(path.dirname(path.dirname(path.dirname(nestedStartDir))));

      // Özel maxWalkDepth=5 derinlik-5'teki deepRoot'u bulur.
      expect(
        resolveCausorynAssetRoot(entryUrl, { env: {}, maxWalkDepth: 5 }),
      ).toBe(deepRoot);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runLineJsonWorker process termination and child environment", () => {
  const IS_WIN = process.platform === "win32";

  it("runs the tree-kill hook BEFORE the direct kill and kills directly only once the hook has settled", async () => {
    const events: string[] = [];
    const fake = createFakeChild({ pid: 9101 });
    const record = fake.child as unknown as Record<string, unknown>;
    record["kill"] = (): boolean => {
      events.push("direct-kill");
      fake.killCount += 1;
      record["killed"] = true;
      return true;
    };
    let releaseHook: () => void = () => {};
    const hookDone = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });

    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "tree-kill-order" },
      requestTimeoutMs: 50,
      spawnProcess: () => fake.child,
      onKillChild: () => {
        events.push("tree-kill");
        return hookDone;
      },
    });

    expect(outcome.status).toBe("timeout");
    // The parent must still be alive while the tree kill enumerates its children.
    expect(events).toEqual(["tree-kill"]);
    expect(fake.killCount).toBe(0);

    releaseHook();
    await vi.waitFor(() => {
      expect(events).toEqual(["tree-kill", "direct-kill"]);
    });
    expect(fake.killCount).toBe(1);
  });

  it("applies the direct kill after the fallback delay when the tree-kill hook never settles", async () => {
    const fake = createFakeChild({ pid: 9102 });
    const outcome = await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "tree-kill-hang" },
      requestTimeoutMs: 50,
      killFallbackMs: 80,
      spawnProcess: () => fake.child,
      onKillChild: () => new Promise<void>(() => {}),
    });
    expect(outcome.status).toBe("timeout");
    expect(fake.killCount).toBe(0);
    await vi.waitFor(() => {
      expect(fake.killCount).toBe(1);
    });
  });

  it("still kills the child directly when the tree-kill hook throws or is absent", async () => {
    const throwing = createFakeChild({ pid: 9103 });
    await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "tree-kill-throws" },
      requestTimeoutMs: 50,
      spawnProcess: () => throwing.child,
      onKillChild: () => {
        throw new Error("taskkill unavailable");
      },
    });
    expect(throwing.killCount).toBe(1);

    const plain = createFakeChild({ pid: 9104 });
    await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: {},
      requestPayload: { id: "no-tree-kill" },
      requestTimeoutMs: 50,
      spawnProcess: () => plain.child,
    });
    expect(plain.killCount).toBe(1);
  });

  it("disables the Windows cwd-first executable search in every child environment (POSIX env unchanged)", async () => {
    const captured: SidecarSpawnOptions[] = [];
    const fake = createFakeChild();
    await runLineJsonWorker({
      command: WORKER_COMMAND,
      args: [],
      env: { PATH: "/bin", NODEFAULTCURRENTDIRECTORYINEXEPATH: "0" },
      requestPayload: { id: "child-env" },
      requestTimeoutMs: 5_000,
      spawnProcess: (_cmd, _args, options) => {
        captured.push(options);
        queueMicrotask(() => {
          fake.stdout.emit("data", Buffer.from('{"ok":true}\n', "utf8"));
        });
        return fake.child;
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.env).toEqual(
      IS_WIN
        ? { PATH: "/bin", NoDefaultCurrentDirectoryInExePath: "1" }
        : { PATH: "/bin", NODEFAULTCURRENTDIRECTORYINEXEPATH: "0" },
    );
  });
});
