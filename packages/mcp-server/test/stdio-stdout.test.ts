import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * stdout-safi testi (TŞ v2.1 §10.1: "stdout sadece MCP stdio protokol
 * trafiği; loglar stderr"; sprint-1 çalışma kuralları).
 *
 * Gerçek stdio server bir child process olarak başlatılır (Node 24 yerel
 * TS desteği: --experimental-transform-types — kaynakta parameter property
 * bulunduğundan strip-only yetmez — + test loader'ı .js→.ts eşlemesi ile),
 * NDJSON JSON-RPC el sıkışması stdin'e yazılır ve:
 * - stdout'taki HER satırın geçerli JSON-RPC 2.0 mesajı olduğu,
 * - initialize → tools/list → tools/call akışının protokol düzeyinde
 *   çalıştığı,
 * - sunucu loglarının stderr'e yazıldığı (stdout'a sızmadığı)
 * kanıtlanır. Test sonunda stdin kapatılır ve süreç temiz çıkış yapar.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const STDIO_ENTRY = path.join(REPO_ROOT, "packages", "mcp-server", "src", "stdio.ts");
const LOADER_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "test",
  "loader",
  "register-strip.mjs",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

const CONFIG = {
  workspaceId: "default",
  allowRoots: [FIXTURE_ROOT],
  results: { maxNodes: 250, maxSymbols: 100 },
  autoIndex: true,
};

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
}

const READY_MARKER = "causoryn mcp server hazir";

describe("stdio server — stdout saflığı ve protokol el sıkışması", () => {
  it("stdout yalnızca JSON-RPC taşır; initialize/tools/list/tools/call yanıtlanır; loglar stderr'de", async () => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        pathToFileURL(LOADER_ENTRY).href,
        STDIO_ENTRY,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CAUSORYN_CONFIG: JSON.stringify(CONFIG) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const pending = new Map<
      number,
      { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }
    >();

    const waitForResponse = (id: number): Promise<JsonRpcMessage> =>
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });

    const responses = {
      init: waitForResponse(1),
      list: waitForResponse(2),
      call: waitForResponse(3),
    };

    let sent = false;
    const sendRequests = (): void => {
      if (sent) return;
      sent = true;
      const messages = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "stdio-purity-test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "causoryn_get_capabilities", arguments: {} },
        },
      ];
      for (const message of messages) {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      }
    };

    // Kill güvenlik ağı: kaynak-spawn'lı çocuk (--experimental-transform-types
    // + ilk indeksleme) sıcak modül önbelleğinde ~2.6 s'te hazırken, soğuk
    // önbellek/paralel suite yükü altında 35 s ölçüldü (elle spawn
    // enstrümantasyonu, 2026-11-09). 30 s'lik eski ağır, meşru yavaş
    // başlangıcı hazır olmadan öldürüyordu; ağı hazır-olduktan-sonra-yanıt
    // vermeyen gerçek askıda kalmayı yakalamak için 90 s'e taşındı.
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 90_000);

    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    // Dürüst hızlı hata: çocuk 3 yanıtı vermeden kapandıysa (ör. kill
    // ağırı vurduysa / başlangıçta çöktüyse) bekleyen yanıtlar REDDEDİLMELİ;
    // aksi halde aşağıdaki Promise.all askıda kalır ve test, gerçek nedeni
    // ("yanıtsız ölüm") gizleyerek tüm zaman aşımına sürüklenir (gözlenen
    // 60 s timeout'un mekanizması). Yanıtlar geldiyse pending zaten boştur —
    // etkisiz. Yerinde iade edilen reject, hata mesajındaki stdout/stderr
    // dökümüyle kök nedeni görünür kılar.
    child.on("close", () => {
      for (const entry of pending.values()) {
        entry.reject(new Error("child process yanıtsız kapandı"));
      }
      pending.clear();
    });

    child.stdout?.setEncoding("utf8");
    // NDJSON satır tamponu: tools/list yanıtı 23 araçla (her biri tam JSON
    // Schema taşır) tek satırlık dev bir mesajdır ve socket chunk sınırında
    // PARÇALANABİLİR. Chunk'lar "\n"e kadar biriktirilmeden JSON.parse
    // yapılmaz; aksi halde parça satırlar çözümlenemez ve pending yanıt
    // asla düşmez (sprint-3 C8 katalog büyümesinde yakalanan gerçek hata).
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf("\n");
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        stdoutLines.push(trimmed);
        try {
          const message = JSON.parse(trimmed) as JsonRpcMessage;
          const id = typeof message.id === "number" ? message.id : undefined;
          if (id !== undefined && pending.has(id)) {
            pending.get(id)?.resolve(message);
            pending.delete(id);
          }
        } catch {
          // saf olmayan satır: aşağıdaki stdout saflığı assert'inde raporlanır
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        stderrLines.push(trimmed);
        // Sunucu hazır logu: istekler startup logundan SONRA gönderilir.
        if (trimmed.includes(READY_MARKER)) {
          sendRequests();
        }
      }
    });

    const exitCode = await (async () => {
      // 3 yanıtın tamamı alınınca stdin kapatılır; süreç temiz çıkmalı.
      await Promise.all([responses.init, responses.list, responses.call]).catch(() => {
        throw new Error(
          `child process 3 yanıt vermedi. stdout=${JSON.stringify(stdoutLines)} stderr=${JSON.stringify(stderrLines)}`,
        );
      });
      child.stdin?.end();
      const code = await exitPromise;
      clearTimeout(killTimer);
      // Askıda kalan yanıtları temizle (varsa).
      for (const entry of pending.values()) {
        entry.reject(new Error("child process kapandı"));
      }
      return code;
    })();

    const [initMsg, listMsg, callMsg] = await Promise.all([
      responses.init,
      responses.list,
      responses.call,
    ]);

    // stdout'taki her satır geçerli JSON-RPC 2.0 mesajı olmalı (TŞ §10.1).
    expect(stdoutLines.length).toBe(3);
    for (const line of stdoutLines) {
      let message: JsonRpcMessage | undefined;
      expect(() => {
        message = JSON.parse(line) as JsonRpcMessage;
      }).not.toThrow();
      expect(
        message?.jsonrpc,
        `stdout satırı protokol dışı: ${line}`,
      ).toBe("2.0");
    }

    const initResult = initMsg.result as {
      serverInfo?: { name?: string; version?: string };
    };
    expect(initMsg.id).toBe(1);
    expect(initResult.serverInfo?.name).toBe("causoryn");
    expect(typeof initResult.serverInfo?.version).toBe("string");

    expect(listMsg.id).toBe(2);
    const listResult = listMsg.result as { tools?: Array<{ name?: string }> };
    // Sprint-2 B6: causoryn_index_status + causoryn_refresh_index, B5:
    // causoryn_get_symbol_context, B4: causoryn_trace_execution, sprint-3
    // C8: Faz C'nin 7 aracı, sprint-4 W5: Living Wiki'nin 7 aracı, sprint-5
    // D2-D6: Faz D'nin 5 aracı, sprint-6 E1-E3: Faz E'nin causoryn_verify_
    // change aracı eklendi (TŞ §10.2 + §16A.8 katalog büyümesi; liste
    // alfabetik karşılaştırılır).
    expect(listResult.tools?.map((t) => t.name).sort()).toEqual([
      "causoryn_analyze_impact",
      "causoryn_architecture_timeline",
      "causoryn_check_architecture",
      "causoryn_check_contracts",
      "causoryn_compare_architecture",
      "causoryn_derive_test_plan",
      "causoryn_detect_contract_drift",
      "causoryn_export_documentation",
      "causoryn_find_symbols",
      "causoryn_generate_onboarding",
      "causoryn_get_agent_context",
      "causoryn_get_capabilities",
      "causoryn_get_evidence",
      "causoryn_get_symbol_context",
      "causoryn_index_status",
      "causoryn_map_system",
      "causoryn_preflight_change",
      "causoryn_refresh_index",
      "causoryn_trace_business_flow",
      "causoryn_trace_execution",
      "causoryn_verify_change",
      "causoryn_wiki_build",
      "causoryn_wiki_diff",
      "causoryn_wiki_get_links",
      "causoryn_wiki_get_page",
      "causoryn_wiki_get_tree",
      "causoryn_wiki_get_versions",
      "causoryn_wiki_search",
      "causoryn_workspace_summary",
    ]);

    expect(callMsg.id).toBe(3);
    const callResult = callMsg.result as {
      structuredContent?: { status?: string; schemaVersion?: string };
      isError?: boolean;
    };
    expect(callResult.isError).toBeFalsy();
    expect(callResult.structuredContent?.schemaVersion).toBe("2.0");
    expect(callResult.structuredContent?.status).toBe("ok");

    // Loglar stderr'de göründü; stdout'a sızmadı.
    expect(stderrLines.some((line) => line.includes(READY_MARKER))).toBe(true);
    expect(exitCode).toBe(0);
    // Zaman aşımı kill ağırının (90 s) üzerinde: asıl iddia kümesi
    // DEĞİŞMEDİ — yalnızca soğuk başlangıç bütçesi gerçek ölçüme göre.
  }, 120_000);
});
