import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { CausorynContext } from "./context.js";
import { CausorynToolError } from "./errors.js";
import {
  envelopeOutputSchema,
  errorEnvelope,
  type Envelope,
} from "./envelope.js";
import {
  AmbiguityDataSchema,
  CapabilitiesDataSchema,
  FindSymbolsDataSchema,
  FindSymbolsInputSchema,
  GetCapabilitiesInputSchema,
  GetEvidenceDataSchema,
  GetEvidenceInputSchema,
  GetSymbolContextDataSchema,
  GetSymbolContextInputSchema,
  IndexStatusDataSchema,
  IndexStatusInputSchema,
  MapDataSchema,
  MapSystemInputSchema,
  RefreshIndexDataSchema,
  RefreshIndexInputSchema,
  WorkspaceSummaryDataSchema,
  WorkspaceSummaryInputSchema,
  findSymbols,
  getCapabilities,
  getEvidence,
  getSymbolContext,
  indexStatus,
  mapSystem,
  refreshIndex,
  workspaceSummary,
} from "./services.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * MCP protokol adaptasyonu (TŞ v2.1 §5/§10, ADR-003): SDK McpServer
 * üzerinden tam olarak 8 gerçek araç yayımlanır (sprint-1: 5 çekirdek araç;
 * sprint-2 B6: causoryn_index_status + causoryn_refresh_index; sprint-2 B5:
 * causoryn_get_symbol_context; tools/list boş handler yayınlamaz — ADR-010).
 * Her araç:
 * - Zod inputSchema (SDK girdiyi otomatik doğrular; şema reddi protokol
 *   düzeyinde isError sonucu döner),
 * - Zod outputSchema (SDK structuredContent'i envelope şemasıyla doğrular),
 * - envelope yanıt (text fallback: JSON serileştirilmiş envelope — TŞ
 *   §10.1 "insan okunabilir kısa text fallback").
 *
 * Envelope düzeyi hatalar (WORKSPACE_NOT_AUTHORIZED, INDEX_NOT_READY, …)
 * isError=false structuredContent ile taşınır: statü sözleşmesidir, protokol
 * hatası değildir (TŞ §10.1 hata kodları yanıt gövdesinde yaşar).
 */

interface ToolRegistration {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly handler: (requestId: string, args: unknown) => Envelope;
}

function envelopeResult(envelope: Envelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function buildRegistrations(context: CausorynContext): readonly ToolRegistration[] {
  return [
    {
      name: "causoryn_get_capabilities",
      title: "Causoryn yetenekleri",
      description:
        "Adapter düzeyleri (L0–L4), sunucu limitleri, protokol revizyonu ve yayımlanan araç listesini döndürür. Snapshot gerektirmez.",
      inputSchema: GetCapabilitiesInputSchema,
      outputSchema: envelopeOutputSchema(CapabilitiesDataSchema),
      handler: (requestId, args) =>
        getCapabilities(context, requestId, args as z.infer<typeof GetCapabilitiesInputSchema>),
    },
    {
      name: "causoryn_workspace_summary",
      title: "Workspace özeti",
      description:
        "Proje/framework/entrypoint/coverage özeti; tüm sayılar yayınlanmış graph snapshot'ından türetilir.",
      inputSchema: WorkspaceSummaryInputSchema,
      outputSchema: envelopeOutputSchema(WorkspaceSummaryDataSchema),
      handler: (requestId, args) =>
        workspaceSummary(context, requestId, args as z.infer<typeof WorkspaceSummaryInputSchema>),
    },
    {
      name: "causoryn_index_status",
      title: "İndeks durumu",
      description:
        "Snapshot, stale, iş (job) ilerlemesi ve tanıları raporlar: jobId verilirse o iş, verilmezse en son iş; iş/snapshot yoksa null alanlar + yönlendirici uyarı döner.",
      inputSchema: IndexStatusInputSchema,
      outputSchema: envelopeOutputSchema(IndexStatusDataSchema),
      handler: (requestId, args) =>
        indexStatus(context, requestId, args as z.infer<typeof IndexStatusInputSchema>),
    },
    {
      name: "causoryn_refresh_index",
      title: "İndeks yenileme",
      description:
        "Yeni snapshot işi başlatır (mode: full; incremental Live Architecture dilimine aittir): çağrı anında jobId döner, iş arka planda koşar; causoryn_index_status ile izlenir. Yalnızca Causoryn izinli data-root'una yazar.",
      inputSchema: RefreshIndexInputSchema,
      outputSchema: envelopeOutputSchema(RefreshIndexDataSchema),
      handler: (requestId, args) =>
        refreshIndex(context, requestId, args as z.infer<typeof RefreshIndexInputSchema>),
    },
    {
      name: "causoryn_map_system",
      title: "Architecture Map",
      description:
        "L0–L3 düzeylerinde mimari harita: level/filters/maxNodes/cursor ile deterministik sıralı node+edge sayfaları; gerçek cursor sayfalama.",
      inputSchema: MapSystemInputSchema,
      outputSchema: envelopeOutputSchema(MapDataSchema),
      handler: (requestId, args) =>
        mapSystem(context, requestId, args as z.infer<typeof MapSystemInputSchema>),
    },
    {
      name: "causoryn_find_symbols",
      title: "Sembol arama",
      description:
        "qualifiedName üzerinde tam/önek/içerir dereceli sembol arama; kind filtresi, limit, AMBIGUOUS_SYMBOL adayları.",
      inputSchema: FindSymbolsInputSchema,
      outputSchema: envelopeOutputSchema(
        // Hata yolu: AMBIGUOUS_SYMBOL data'sı aday listesi taşır (TŞ §10.3).
        AmbiguityDataSchema.or(FindSymbolsDataSchema),
      ),
      handler: (requestId, args) =>
        findSymbols(context, requestId, args as z.infer<typeof FindSymbolsInputSchema>),
    },
    {
      name: "causoryn_get_symbol_context",
      title: "Sembol bağlamı",
      description:
        "Sembol node'u + istenen derinliğe kadar komşu kenarlar (edgeKinds filtreli, deterministik sıralı) + kanıt kayıtları; symbolId node kimliği veya qualifiedName kabul eder (belirsiz ad AMBIGUOUS_SYMBOL adayları döner).",
      inputSchema: GetSymbolContextInputSchema,
      outputSchema: envelopeOutputSchema(
        // Hata yolu: AMBIGUOUS_SYMBOL data'sı aday listesi taşır (TŞ §10.3).
        AmbiguityDataSchema.or(GetSymbolContextDataSchema),
      ),
      handler: (requestId, args) =>
        getSymbolContext(context, requestId, args as z.infer<typeof GetSymbolContextInputSchema>),
    },
    {
      name: "causoryn_get_evidence",
      title: "Evidence provenance",
      description:
        "Node/edge/evidence kimliğinin kanıt dizisi: relativePath, startLine/endLine, sourceHash, analyzerId, rationale. Yayınlanmış snapshot'ta olmayan kimlik EVIDENCE_NOT_FOUND döndürür.",
      inputSchema: GetEvidenceInputSchema,
      outputSchema: envelopeOutputSchema(GetEvidenceDataSchema),
      handler: (requestId, args) =>
        getEvidence(context, requestId, args as z.infer<typeof GetEvidenceInputSchema>),
    },
  ];
}

/** Context'i MCP McpServer'a bağlar; tam olarak 8 araç kaydeder. */
export function createCausorynMcpServer(context: CausorynContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  for (const registration of buildRegistrations(context)) {
    server.registerTool(
      registration.name,
      {
        title: registration.title,
        description: registration.description,
        inputSchema: registration.inputSchema,
        outputSchema: registration.outputSchema,
      },
      async (args, extra) => {
        const requestId = String(extra.requestId);
        try {
          const envelope = registration.handler(requestId, args);
          return envelopeResult(envelope);
        } catch (error) {
          if (error instanceof CausorynToolError) {
            context.logger(
              `tool ${registration.name} envelope hatası: ${error.code}: ${error.message}`,
            );
            return envelopeResult(
              errorEnvelope(requestId, context.config.workspaceId, null, error),
            );
          }
          // Ham hata mesajı (sürücü/kütüphane detayı: tablo adı, kimlik,
          // mutlak yol…) YALNIZCA stderr loguna gider; istemciye requestId
          // korelasyonlu genel mesaj döner (TŞ §10.1: stack/stack detayı
          // sonuca girmez; iç detay sızması da aynı ilkeye tabidir).
          const detail = error instanceof Error ? error.message : String(error);
          context.logger(`tool ${registration.name} beklenmeyen hata: ${detail}`);
          return envelopeResult(
            errorEnvelope(
              requestId,
              context.config.workspaceId,
              null,
              new CausorynToolError(
                "INTERNAL_ERROR",
                `Beklenmeyen iç hata; ayrıntılar sunucu loglarında (requestId: ${requestId})`,
              ),
            ),
          );
        }
      },
    );
  }
  return server;
}
