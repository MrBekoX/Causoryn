import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCausorynContext, createCausorynMcpServer } from "@causoryn/mcp-server";
import type { CausorynContext } from "@causoryn/mcp-server";

import { buildFixtureModel, writeFixture } from "./fixture.js";

/**
 * F7 benchmark koşum düzeneği (sprint-7 F7; TŞ v2.1 §21 s.22).
 *
 * Ölçüm yöntemi (docs/benchmarks.md'te birebir beyan edilir):
 * - MCP protokol düzeyi: @modelcontextprotocol/sdk InMemoryTransport +
 *   client.callTool — motor + validasyon + envelope'un tamamı ölçüm içindedir.
 * - Süre kaynağı: process.hrtime.bigint().
 * - Her ölçümde önce 1 warm-up çağrısı (ölçülmez), ardından N=3 koşum;
 *   raporlanan değer MEDYAN'dır (flaky önlemi).
 * - Çağrı başına deadline: aşım/istisna o satırı "not_measured" yapar
 *   (neden raporlanır), diğer satırlar etkilenmez (partial sözleşme).
 * - Soğuk indeks ayrı bilgi alanıdır: sabit süre vaadi yoktur (TŞ §21).
 *
 * Fault enjeksiyonu (partial test): options.fault verildiğinde ilgili
 * ölçümün çağrı yolu istisna fırlatır — gerçek ortam kesintisiyle aynı
 * yakalama yolundan geçer; satır "not_measured" olur, diğerleri ölçülür.
 *
 * Temizlik: geçici fixture dizini her koşumda rmSync ile silinir; client ve
 * context kapatılır. Yazma YALNIZCA os.tmpdir() altındaki izinli geçici
 * dizinedir (fixture.ts konteynman guard'ı) — workspace'e yazım yoktur.
 */

export type MeasurementId =
  | "workspace_summary_warm"
  | "graph_neighborhood_small"
  | "map_system_200";

export interface MeasurementRow {
  readonly id: MeasurementId;
  /** Ölçülen araç + argüman açıklaması (docs tablosu için). */
  readonly tool: string;
  readonly call: string;
  /** TŞ §21 referans hedefi — tasarım hedefidir, sonuç DEĞİLDİR. */
  readonly targetMs: number;
  /** N koşumun milisaniye örnekleri; ölçülemediyse null. */
  readonly runs: readonly number[] | null;
  /** Medyan; ölçülemediyse null. */
  readonly medianMs: number | null;
  readonly status: "measured" | "not_measured";
  /** not_measured durumunda insan-okur neden; ölçüldüyse null. */
  readonly reason: string | null;
}

export interface BenchEnvironment {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly cpuModel: string;
  readonly totalMemBytes: number;
}

export interface BenchReport {
  readonly startedAt: string;
  readonly fileCount: number;
  readonly fixtureEntryCount: number;
  readonly fixtureHash: string;
  /** Soğuk indeks süresi (bilgi amaçlı; TŞ §21: sabit süre vaadi yok). */
  readonly coldIndexMs: number | null;
  /** Yayımlanan snapshot durumu: ready | partial (tanı varsa partial). */
  readonly indexState: string;
  /** TŞ §21 parse_errors metriği: adapter tanı sayısı. */
  readonly diagnosticCount: number;
  /** İlk tanılar (en fazla 5) — partial durumun kanıtı için. */
  readonly firstDiagnostics: readonly string[];
  readonly runsPerMeasurement: number;
  readonly callDeadlineMs: number;
  readonly timingMethod: string;
  readonly environment: BenchEnvironment;
  readonly rows: readonly MeasurementRow[];
}

export interface RunBenchmarkOptions {
  readonly fileCount: number;
  readonly runsPerMeasurement?: number;
  readonly callDeadlineMs?: number;
  /** Partial senaryo: belirtilen ölçümde sanal ortam kesintisi. */
  readonly fault?: {
    readonly measurementId: MeasurementId;
    readonly message: string;
  };
}

const DEFAULT_RUNS = 3;
const DEFAULT_DEADLINE_MS = 30_000;

export const TIMING_METHOD =
  "MCP protokol düzeyi (@modelcontextprotocol/sdk InMemoryTransport üzerinde client.callTool); " +
  "süre process.hrtime.bigint(); her ölçümde 1 warm-up çağrısı (ölçülmez) + N koşum; " +
  "raporlanan değer medyan; çağrı başına deadline aşımı/istisnası satırı 'not measured' yapar";

interface MeasurementDef {
  readonly id: MeasurementId;
  readonly tool: string;
  readonly call: string;
  readonly targetMs: number;
}

const MEASUREMENT_DEFS: readonly MeasurementDef[] = [
  {
    id: "workspace_summary_warm",
    tool: "causoryn_workspace_summary",
    call: "{}",
    targetMs: 1000,
  },
  {
    id: "graph_neighborhood_small",
    tool: "causoryn_get_symbol_context",
    call: "{ symbolId: <ilk sınıf>, depth: 1 }",
    targetMs: 500,
  },
  {
    id: "map_system_200",
    tool: "causoryn_map_system",
    call: '{ level: "L2", maxNodes: 200 }',
    targetMs: 2000,
  },
];

/** Deadline'lı bekleme: söz verilen süre aşılırsa reddiyen (askıda koşum yok). */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`çağrı deadline aşımı (${String(deadlineMs)} ms)`));
    }, deadlineMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface CallOutcome {
  readonly ms: number;
  readonly errorText: string | null;
}

function toolErrorText(result: CallToolResult): string {
  const items = result.content as ReadonlyArray<{ type?: string; text?: string }>;
  const hit = items.find((item) => item.type === "text");
  const text = hit?.text ?? "";
  return text.length > 0 ? text.slice(0, 200) : "araç hata zarfı döndürdü";
}

async function timedToolCall(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
  deadlineMs: number,
): Promise<CallOutcome> {
  const started = process.hrtime.bigint();
  try {
    const raw: unknown = await withDeadline(
      client.callTool({ name: tool, arguments: args }),
      deadlineMs,
    );
    const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
    const result = raw as CallToolResult;
    if (result.isError === true) {
      return { ms, errorText: toolErrorText(result) };
    }
    return { ms, errorText: null };
  } catch (error) {
    return {
      ms: Number(process.hrtime.bigint() - started) / 1_000_000,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Komşuluk ölçümünün başlangıç sembolünü çözer (ölçüm DIŞI hazırlık):
 * deterministik ilk sınıf adı find_symbols ile aranır, tek/ilk aday alınır.
 */
async function resolveStartSymbolId(
  client: Client,
  query: string,
  deadlineMs: number,
): Promise<{ readonly symbolId: string } | { readonly error: string }> {
  try {
    const raw: unknown = await withDeadline(
      client.callTool({
        name: "causoryn_find_symbols",
        arguments: { query, limit: 5 },
      }),
      deadlineMs,
    );
    const result = raw as CallToolResult;
    if (result.isError === true) {
      return { error: `find_symbols hata zarfı: ${toolErrorText(result)}` };
    }
    const envelope = result.structuredContent as
      | { data?: { hits?: ReadonlyArray<{ symbolId?: string }> } }
      | undefined;
    const symbolId = envelope?.data?.hits?.[0]?.symbolId;
    if (typeof symbolId !== "string" || symbolId.length === 0) {
      return { error: `başlangıç sembolü bulunamadı (query: ${query})` };
    }
    return { symbolId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Benchmark'i koşturur: deterministik fixture'ı geçici izinli dizine üretir,
 * soğuk indeksli taze bir Causoryn context'i kurar, üç ölçümü N koşumla
 * medyan olarak raporlar. Ortam kesintisi/araç hatası satır bazında
 * yakalanır — tek satır 'not measured' olabilir; süreç dışına hata çıkmaz.
 */
export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchReport> {
  const runsPerMeasurement = options.runsPerMeasurement ?? DEFAULT_RUNS;
  const deadlineMs = options.callDeadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = new Date().toISOString();

  // (1) Deterministik fixture modeli (geçersiz adet burada explicit hata
  // verir — negatif sözleşme; fs henüz dokunulmadı).
  const model = buildFixtureModel(options.fileCount);

  // (2) Geçici izinli dizine yaz (os.tmpdir altı; fixture.ts guard'ı).
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-bench-"));
  let context: CausorynContext | undefined;
  let client: Client | undefined;
  try {
    writeFixture(root, model);

    // (3) Soğuk indeks: senkron ilk indeksleme; sabit süre vaadi yok
    // (TŞ §21) — yalnızca bilgi amaçlı ölçülür. autoIndex yerine MANUEL
    // runIndex: tanılar (parse_errors, TŞ §21 metriği) ve snapshot durumu
    // rapora girer — partial durumu sebepsiz kalmaz.
    context = createCausorynContext({
      workspaceId: "default",
      allowRoots: [root],
      results: { maxNodes: 250, maxSymbols: 100, maxDepth: 3, maxPaths: 50 },
      autoIndex: false,
    });
    const coldStarted = process.hrtime.bigint();
    const indexRun = context.indexService.runIndex(root);
    const coldIndexMs = Number(process.hrtime.bigint() - coldStarted) / 1_000_000;
    const firstDiagnostics = indexRun.diagnostics
      .slice(0, 5)
      .map(
        (diagnostic) =>
          `${diagnostic.relativePath}:${String(diagnostic.line)} ${diagnostic.code} ${diagnostic.message}`,
      );
    // Şeffaflık (loglar stderr'e — stdout yalnızca MCP protokolü, TŞ §10.1).
    if (indexRun.diagnostics.length > 0) {
      process.stderr.write(
        `[causoryn-bench] index state=${indexRun.state} diagnostics=${String(indexRun.diagnostics.length)}\n`,
      );
      for (const line of firstDiagnostics) {
        process.stderr.write(`[causoryn-bench] tanı: ${line}\n`);
      }
    }

    // (4) MCP protokol bağlantısı.
    const server = createCausorynMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "causoryn-bench", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // (5) Komşuluk başlangıç sembolü (ölçüm dışı hazırlık).
    const symbol = await resolveStartSymbolId(client, model.firstClassName, deadlineMs);
    const startSymbolId = "symbolId" in symbol ? symbol.symbolId : null;

    // (6) Ölçümler — satır bazında izolasyon.
    const rows: MeasurementRow[] = [];
    for (const def of MEASUREMENT_DEFS) {
      rows.push(
        await measureRow(client, def, {
          runsPerMeasurement,
          deadlineMs,
          fault: options.fault,
          startSymbolId,
        }),
      );
    }

    const cpus = os.cpus();
    return {
      startedAt,
      fileCount: model.fileCount,
      fixtureEntryCount: model.entries.length,
      fixtureHash: model.hash,
      coldIndexMs,
      indexState: indexRun.state,
      diagnosticCount: indexRun.diagnostics.length,
      firstDiagnostics,
      runsPerMeasurement,
      callDeadlineMs: deadlineMs,
      timingMethod: TIMING_METHOD,
      environment: {
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpuModel: cpus[0]?.model ?? "bilinmiyor",
        totalMemBytes: os.totalmem(),
      },
      rows,
    };
  } finally {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // temizlik hatası ölçümü etkilemez
      }
    }
    if (context !== undefined) {
      try {
        context.close();
      } catch {
        // temizlik hatası ölçümü etkilemez
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function measureRow(
  client: Client,
  def: MeasurementDef,
  ctx: {
    readonly runsPerMeasurement: number;
    readonly deadlineMs: number;
    readonly fault?: { readonly measurementId: MeasurementId; readonly message: string } | undefined;
    readonly startSymbolId: string | null;
  },
): Promise<MeasurementRow> {
  // Guard önce: komşuluk ölçümü başlangıç sembolü olmadan yapılmaz; args
  // kurulumu guard SONRASINA taşındı — ulaşılamaz yer tutucu fallback'i yok
  // (denetim bulgusu, 2026-11-10). graph dalında ctx.startSymbolId buraya
  // string olarak gelir; null ise fonksiyon yukarıda dönmüştür.
  if (def.id === "graph_neighborhood_small" && ctx.startSymbolId === null) {
    return {
      id: def.id,
      tool: def.tool,
      call: def.call,
      targetMs: def.targetMs,
      runs: null,
      medianMs: null,
      status: "not_measured",
      reason: "başlangıç sembolü çözümlenemedi — komşuluk ölçümü atlandı",
    };
  }
  const args: Record<string, unknown> =
    def.id === "graph_neighborhood_small"
      ? { symbolId: ctx.startSymbolId, depth: 1 }
      : def.id === "map_system_200"
        ? { level: "L2", maxNodes: 200 }
        : {};

  const invoke = async (callIndex: number): Promise<CallOutcome> => {
    if (ctx.fault?.measurementId === def.id) {
      // Sanal ortam kesintisi: gerçek istisna yoluyla aynı yakalamaya girer.
      throw new Error(`${ctx.fault.message} (koşum ${String(callIndex)})`);
    }
    return timedToolCall(client, def.tool, args, ctx.deadlineMs);
  };

  try {
    // Warm-up: JIT/bellek izleri eşitlensin; süresi raporlanmaz.
    const warm = await invoke(0);
    if (warm.errorText !== null) {
      return notMeasured(def, `warm-up başarısız: ${warm.errorText}`);
    }
    const samples: number[] = [];
    for (let callIndex = 1; callIndex <= ctx.runsPerMeasurement; callIndex += 1) {
      const outcome = await invoke(callIndex);
      if (outcome.errorText !== null) {
        return notMeasured(
          def,
          `koşum ${String(callIndex)}/${String(ctx.runsPerMeasurement)} başarısız: ${outcome.errorText}`,
        );
      }
      samples.push(outcome.ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median === undefined) {
      return notMeasured(def, "örnek toplanamadı");
    }
    return {
      id: def.id,
      tool: def.tool,
      call: def.call,
      targetMs: def.targetMs,
      runs: samples,
      medianMs: median,
      status: "measured",
      reason: null,
    };
  } catch (error) {
    return notMeasured(
      def,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function notMeasured(def: MeasurementDef, reason: string): MeasurementRow {
  return {
    id: def.id,
    tool: def.tool,
    call: def.call,
    targetMs: def.targetMs,
    runs: null,
    medianMs: null,
    status: "not_measured",
    reason,
  };
}
