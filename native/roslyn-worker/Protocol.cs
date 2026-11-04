using System.Text.Json;
using System.Text.Json.Serialization;

namespace Causoryn.RoslynWorker;

/**
 * stdin/stdout JSON protokolü — TŞ v2.1 §7 (Roslyn sidecar) ve
 * native/roslyn-worker/PROTOCOL.md sözleşmesi (sprint-2 / B1).
 *
 * Alan adları, packages/domain/src/snapshot.ts'teki createSnapshot GİRDİ
 * sözleşmesiyle (SnapshotNodeInput / SnapshotEdgeInput / SnapshotEvidenceInput
 * — NodeRef uçlu, ID'siz) birebir hizalıdır:
 * Node {kind, qualifiedName, language?, relativePath?, attributes},
 * Edge {kind, from: NodeRef, to: NodeRef, resolution, evidence?, ambiguity?},
 * Evidence {kind, span?, analyzerId, analyzerVersion, rationale},
 * SourceSpan {relativePath, startLine, endLine, sourceHash}.
 * (graph-schema.ts'teki GraphNode'tan fark: NodeRef'te location yerine
 * relativePath kimlik alanıdır — worker çıktısı doğrudan createSnapshot'a
 * beslenir.)
 *
 * Bilinçli sapma (PROTOCOL.md §"ID'ler"): worker KİMLİK ÜRETMEZ. TŞ §7.1
 * gereği canonical ID, de-duplication ve güven seviyesi merkezi normalizer'da
 * (packages/domain createSnapshot) yönetilir; worker çıktısı ID'siz
 * NodeRef/Edge/Evidence girdisidir ve B2'deki TS adapter bunu workspaceId ile
 * createSnapshot'a besler (invariant iii tek noktadan korunur).
 */

public static class ProtocolConstants
{
    /** Bu worker'ın uyguladığı protokol sürümü ( kırılabilir değişiklikte artar). */
    public const string ProtocolVersion = "1";

    /** TŞ §8 Evidence.analyzerId karşılığı — sabit analyzer kimliği. */
    public const string AnalyzerId = "roslyn-worker";

    /** csproj Version ile senkron tutulur; Evidence.analyzerVersion'a yazılır. */
    public const string AnalyzerVersion = "0.1.0";

    /** Node dil etiketi — TS adapter'ın "typescript" karşılığı. */
    public const string Language = "csharp";

    /**
     * Kaynak sınırları — TŞ §9 resource budget, K-010 (yalnızca boyut
     * limitleri). Aşım → LIMIT_EXCEEDED hata yanıtı; süreç ölmez.
     *
     * MaxRequestLineChars: tek istek satırı için üst sınır (char sayımı).
     * UTF-8'de her char ≥1 bayt olduğundan char limiti bayt limitinin
     * KÖTÜMSER üst sınırıdır — 64M char, 64 MB bayt bütçesini aşamaz.
     * Aşılırsa satır tüketilir (bir sonraki newline'a kadar), id:null +
     * LIMIT_EXCEEDED yanıtı döner ve döngü devam eder.
     */
    public const int MaxRequestLineChars = 64 * 1024 * 1024;

    /** Tek analyze isteğindeki maksimum dosya sayısı. */
    public const int MaxFileCount = 5000;

    /** files[] tek girdisinin UTF-8 bayt üst sınırı (TŞ §20 maxFileBytes ile uyumlu). */
    public const int MaxFileContentBytes = 2_000_000;
}

/**
 * Hata kodları: TŞ §10.1 listesinden (INTERNAL_ERROR, LIMIT_EXCEEDED) ve
 * repoya ait K-008 uzantısından (INVALID_ARGUMENT) alınır; worker kendi kodu
 * icat etmez. LIMIT_EXCEEDED'in TŞ §10.1'deki yeri birincil kaynaktan
 * doğrulanmıştır (TŞ çıkarım satır 620; packages/mcp-server/src/errors.ts:21).
 */
public static class ProtocolErrorCodes
{
    public const string InvalidArgument = "INVALID_ARGUMENT";
    public const string InternalError = "INTERNAL_ERROR";
    public const string LimitExceeded = "LIMIT_EXCEEDED";
}

/**
 * TŞ §8 katalog aynası (packages/domain/src/graph-kinds.ts). Worker çıktısı
 * bu kümelere göre çıktı anında doğrulanır — liste dışı kind üretilemez.
 */
public static class GraphKinds
{
    public static readonly IReadOnlySet<string> NodeKinds = new HashSet<string>
    {
        "Workspace", "Repository", "Project", "Module", "Package", "File",
        "Namespace", "Class", "Interface", "Type", "Function", "Method",
        "Endpoint", "Handler", "Event", "Topic", "Queue", "Database", "Table",
        "Column", "ApiContract", "EventContract", "SchemaContract",
        "ContractVersion", "Test", "Config", "UnknownExternal",
    };

    public static readonly IReadOnlySet<string> EdgeKinds = new HashSet<string>
    {
        "CONTAINS", "IMPORTS", "DECLARES", "CALLS", "REFERENCES", "IMPLEMENTS",
        "INHERITS", "INJECTS", "ROUTES_TO", "READS", "WRITES", "PUBLISHES",
        "SUBSCRIBES", "HANDLES", "PRODUCES_CONTRACT", "CONSUMES_CONTRACT",
        "VALIDATES", "TESTS", "DEPENDS_ON", "CONFIGURES",
    };
}

/* ------------------------------------------------------------------ */
/* İstek                                                               */
/* ------------------------------------------------------------------ */

public sealed class WorkerRequest
{
    [JsonPropertyName("id")]
    public JsonElement Id { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("protocolVersion")]
    public string? ProtocolVersion { get; set; }

    [JsonPropertyName("files")]
    public List<SourceFileIn>? Files { get; set; }

    [JsonPropertyName("referenceDirs")]
    public List<string>? ReferenceDirs { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; set; }
}

public sealed class SourceFileIn
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? ExtensionData { get; set; }
}

/* ------------------------------------------------------------------ */
/* Yanıt                                                               */
/* ------------------------------------------------------------------ */

public sealed class WorkerResponse
{
    /**
     * id her yanıtta MEVCUTTUR; bozuk satırlarda null olarak yazılır.
     * Never koşulu, genel WhenWritingNull varsayılanını bu alan için ezer.
     */
    [JsonPropertyName("id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public JsonElement? Id { get; set; }

    [JsonPropertyName("protocolVersion")]
    public string ProtocolVersion { get; set; } = ProtocolConstants.ProtocolVersion;

    [JsonPropertyName("status")]
    public string Status { get; set; } = "ready";

    [JsonPropertyName("worker")]
    public WorkerInfo? Worker { get; set; }

    [JsonPropertyName("capabilities")]
    public CapabilitiesOut? Capabilities { get; set; }

    [JsonPropertyName("coverageRatio")]
    public double? CoverageRatio { get; set; }

    [JsonPropertyName("unsupportedConstructs")]
    public List<string>? UnsupportedConstructs { get; set; }

    [JsonPropertyName("warnings")]
    public List<string>? Warnings { get; set; }

    [JsonPropertyName("diagnostics")]
    public List<DiagnosticOut>? Diagnostics { get; set; }

    [JsonPropertyName("nodes")]
    public List<NodeOut>? Nodes { get; set; }

    [JsonPropertyName("edges")]
    public List<EdgeOut>? Edges { get; set; }

    [JsonPropertyName("evidence")]
    public List<EvidenceOut>? Evidence { get; set; }

    [JsonPropertyName("error")]
    public ErrorOut? Error { get; set; }
}

public sealed class WorkerInfo
{
    [JsonPropertyName("analyzerId")]
    public string AnalyzerId { get; set; } = ProtocolConstants.AnalyzerId;

    [JsonPropertyName("analyzerVersion")]
    public string AnalyzerVersion { get; set; } = ProtocolConstants.AnalyzerVersion;
}

/** Adapter yetenek beyanı (TŞ §7: her adapter çıktısında capabilities bulunur). */
public sealed class CapabilitiesOut
{
    [JsonPropertyName("astParse")]
    public bool AstParse { get; set; }

    [JsonPropertyName("symbolResolution")]
    public bool SymbolResolution { get; set; }

    [JsonPropertyName("containsEdges")]
    public bool ContainsEdges { get; set; }

    [JsonPropertyName("callEdges")]
    public bool CallEdges { get; set; }

    /** B1 diliminde C# using → IMPORTS kenarı üretilmez (açık beyan). */
    [JsonPropertyName("importEdges")]
    public bool ImportEdges { get; set; }

    [JsonPropertyName("routeDetection")]
    public string RouteDetection { get; set; } = "aspnetcore-controller-attribute-and-minimal-api-call-pattern";

    [JsonPropertyName("frameworkLinkers")]
    public bool FrameworkLinkers { get; set; }
}

public sealed class ErrorOut
{
    [JsonPropertyName("code")]
    public string Code { get; set; } = string.Empty;

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;
}

public sealed class DiagnosticOut
{
    [JsonPropertyName("relativePath")]
    public string RelativePath { get; set; } = string.Empty;

    [JsonPropertyName("code")]
    public string Code { get; set; } = string.Empty;

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    /** Bilinmiyorsa 0 (TS adapter DiagnosticOut kuralı). */
    [JsonPropertyName("line")]
    public int Line { get; set; }
}

/* ------------------------------------------------------------------ */
/* Graph kayıtları — domain alan adlarıyla hizalı (ID'siz)             */
/* ------------------------------------------------------------------ */

/** TŞ §8 SourceSpan karşılığı. */
public sealed class SpanOut
{
    [JsonPropertyName("relativePath")]
    public string RelativePath { get; set; } = string.Empty;

    [JsonPropertyName("startLine")]
    public int StartLine { get; set; }

    [JsonPropertyName("endLine")]
    public int EndLine { get; set; }

    [JsonPropertyName("sourceHash")]
    public string SourceHash { get; set; } = string.Empty;
}

/** TŞ §8 Evidence karşılığı (ID'siz; domain içerikten ID türetir). */
public sealed class EvidenceOut
{
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("span")]
    public SpanOut? Span { get; set; }

    [JsonPropertyName("analyzerId")]
    public string AnalyzerId { get; set; } = ProtocolConstants.AnalyzerId;

    [JsonPropertyName("analyzerVersion")]
    public string AnalyzerVersion { get; set; } = ProtocolConstants.AnalyzerVersion;

    [JsonPropertyName("rationale")]
    public string Rationale { get; set; } = string.Empty;
}

/** Kenar ucu referansı — domain NodeRef (node kimlik anahtarı) karşılığı. */
public sealed class NodeRefOut
{
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("qualifiedName")]
    public string QualifiedName { get; set; } = string.Empty;

    [JsonPropertyName("relativePath")]
    public string? RelativePath { get; set; }
}

/** TŞ §8 GraphNode karşılığı (ID'siz). */
public sealed class NodeOut
{
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("qualifiedName")]
    public string QualifiedName { get; set; } = string.Empty;

    [JsonPropertyName("language")]
    public string? Language { get; set; }

    [JsonPropertyName("relativePath")]
    public string? RelativePath { get; set; }

    [JsonPropertyName("attributes")]
    public Dictionary<string, object> Attributes { get; set; } = new();
}

/** TŞ §8 GraphEdge karşılığı (ID'siz; uçlar NodeRef). */
public sealed class EdgeOut
{
    [JsonPropertyName("kind")]
    public string Kind { get; set; } = string.Empty;

    [JsonPropertyName("from")]
    public NodeRefOut From { get; set; } = new();

    [JsonPropertyName("to")]
    public NodeRefOut To { get; set; } = new();

    [JsonPropertyName("resolution")]
    public string Resolution { get; set; } = string.Empty;

    [JsonPropertyName("evidence")]
    public List<EvidenceOut> Evidence { get; set; } = new();

    [JsonPropertyName("ambiguity")]
    public AmbiguityOut? Ambiguity { get; set; }
}

public sealed class AmbiguityOut
{
    [JsonPropertyName("candidates")]
    public List<string> Candidates { get; set; } = new();

    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;
}

/* ------------------------------------------------------------------ */
/* İstisna + serileştirme                                              */
/* ------------------------------------------------------------------ */

/** İstek düzeyinde reddedilen girdi → status:"error" yanıtı üretir. */
public sealed class ProtocolException : Exception
{
    public string Code { get; }

    public ProtocolException(string code, string message) : base(message)
    {
        Code = code;
    }
}

public static class ProtocolJson
{
    /**
     * Satır-bazlı framing için kompakt serileştirme; PropertyNamePolicy
     * devre dışıdır çünkü tüm alanlar açık [JsonPropertyName] taşır.
     * WhenWritingNull, domain strictObject'in null reddiyle uyumlu olarak
     * opsiyonel alanları null yerine YOK olarak yazar.
     */
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
}
