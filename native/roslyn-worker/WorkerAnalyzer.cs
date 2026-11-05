using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Causoryn.RoslynWorker;

/**
 * Roslyn çekirdek çözümleyici — TŞ v2.1 §7 "C#/.NET ASP.NET Core → Roslyn
 * sidecar, L2 hedef, controller/minimal API L3" dilimi (sprint-2 / B1).
 *
 * Çıkarım disiplini (adapters/typescript/src/analyzer.ts ile aynı sözleşme):
 * - CONTAINS  : File → üst düzey tip bildirimi; Tip → üye Method (istek
 *               gereği property bildirimleri de Method düğümüyle eşlenir —
 *               property, CIL düzeyinde erişimci metotlarına çözülür; bu
 *               yaklaşım PROTOCOL.md'de belgelenmiştir).
 * - CALLS     : çağrı/nesne-oluşturma ifadeleri Roslyn semantic model ile
 *               hedef sembole çözümlenir (verified); çözümleme analizin
 *               DIŞINA taşarsa açık UnknownExternal node (checker dayanaklı
 *               verified); hiç çözümlenemezse UnknownExternal + unresolved —
 *               uydurma kenar YOK (TŞ §8 resolution kuralı).
 * - ROUTES_TO : ASP.NET Core controller öznitelikleri ([Route]/[HttpGet]...)
 *               ve minimal API MapGet/MapPost... çağrı kalıbı → Endpoint
 *               node + Endpoint → handler kenarı (route-attribute kanıtı).
 *               Öznitelik/uzantı tipi semantic model ile Microsoft.* köküne
 *               çözülürse verified; yalnızca bilinen ad kuralı varsa
 *               heuristic + açık ambiguity (TŞ §8: "bilinen kural ama kesin
 *               çözümleme yok").
 *
 * Invariant'lar (TŞ §8): (i) verified kenar ≥1 kanıt; (ii) dangling edge
 * yok — dış kaynaklar açık UnknownExternal node; (iv/vi) deterministik
 * çıktı — girdi sıralanır, çıktı kanonik anahtarla sıralanır, saat okunmaz.
 *
 * Hata izolasyonu: tek dosyadaki sorun analizi düşürmez; tanılar dosya
 * başına toplanır, status "partial" bildirilir.
 */
public static class WorkerAnalyzer
{
    /** Minimal API endpoint kayıt metot adları (bilinen kural kapısı). */
    private static readonly HashSet<string> MinimalApiMapNames = new(StringComparer.Ordinal)
    {
        "MapGet", "MapPost", "MapPut", "MapDelete", "MapPatch",
    };

    /** HTTP fiil öznitelik adı → fiil (bilinen kural tablosu). */
    private static readonly Dictionary<string, string> VerbAttributeNames =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["HttpGet"] = "GET",
            ["HttpPost"] = "POST",
            ["HttpPut"] = "PUT",
            ["HttpPatch"] = "PATCH",
            ["HttpDelete"] = "DELETE",
            ["HttpHead"] = "HEAD",
            ["HttpOptions"] = "OPTIONS",
        };

    private const string AspNetMvcNamespace = "Microsoft.AspNetCore.Mvc";
    private const string EndpointRouteBuilderExtensions = "Microsoft.AspNetCore.Builder.EndpointRouteBuilderExtensions";

    /** Bu dilimde modellenmeyen dil yapıları (TŞ §7 C# satırı: reflection, dynamic DI, source generators). */
    private static readonly string[] UnsupportedConstructs =
    {
        "reflection/dynamic-dispatch",
        "dynamic-di-configuration",
        "source-generators",
        "function-local-declarations",
        "inline-anonymous-route-handlers",
        "constructor-initializer-chains",
        "field-initializer-calls",
        "convention-routing-templates",
    };

    /* ------------------------------------------------------------------ */
    /* Kayıt yapıları                                                      */
    /* ------------------------------------------------------------------ */

    private sealed record SourceEntry(string RelativePath, string SourceHash, SyntaxTree Tree);

    private sealed record NodeRecord(NodeRefOut Ref, NodeOut Node, string Key);

    private sealed record AttributeMatch(AttributeSyntax Node, string SimpleName, bool Semantic, string? Template, string? Verb);

    private sealed record ControllerInfo(TypeDeclarationSyntax Declaration, NodeRecord Record, string QualifiedName);

    private sealed class GraphAssembler
    {
        private readonly Dictionary<string, NodeRecord> _nodes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, EdgeRecord> _edges = new(StringComparer.Ordinal);
        private readonly HashSet<string> _warningSeen = new(StringComparer.Ordinal);

        /**
         * Güvenlik bulgusu 4: yanıt node bütçesi. _nodes.Count limitte
         * kaldığında yeni node'lar ADMIT EDİLMEZ; admit edilmemiş uçlu
         * kenarlar da eklenmez (dangling edge yok — worker çıktısı
         * createSnapshot dangling refine'ından geçmek zorundadır).
         * Truncated=true → yanıt RESPONSE_TRUNCATED tanısı alır ve
         * status "partial" olur (sessiz kesim yoktur).
         */
        private readonly int _nodeLimit;

        public bool Truncated { get; private set; }

        public GraphAssembler(int nodeLimit)
        {
            _nodeLimit = nodeLimit;
        }

        public List<string> Warnings { get; } = new();

        public NodeRecord EnsureNode(string kind, string qualifiedName, string? relativePath, Dictionary<string, object>? attributes)
        {
            if (!GraphKinds.NodeKinds.Contains(kind))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InternalError,
                    $"TŞ §8 node kataloğu dışı tür üretilemez: {kind}");
            }

            var key = NodeKey(kind, qualifiedName, relativePath);
            if (_nodes.TryGetValue(key, out var existing))
            {
                return existing;
            }

            var record = new NodeRecord(
                new NodeRefOut { Kind = kind, QualifiedName = qualifiedName, RelativePath = relativePath },
                new NodeOut
                {
                    Kind = kind,
                    QualifiedName = qualifiedName,
                    Language = ProtocolConstants.Language,
                    RelativePath = relativePath,
                    Attributes = attributes ?? new Dictionary<string, object>(),
                },
                key);
            if (_nodes.Count >= _nodeLimit)
            {
                // Limit dolu: kayıt EMİSİYONA GİRMEZ; referansı döner ki
                // çağıran akış bozulmasın, ama AddEdge bu kaydı admit
                // saymaz (dangling üretmez).
                Truncated = true;
                return record;
            }
            _nodes.Add(key, record);
            return record;
        }

        public NodeRecord EnsureExternal(string qualifiedName)
        {
            return EnsureNode("UnknownExternal", qualifiedName, null, null);
        }

        public void AddEdge(string kind, NodeRecord from, NodeRecord to, string resolution, EvidenceOut evidence, AmbiguityOut? ambiguity)
        {
            if (!GraphKinds.EdgeKinds.Contains(kind))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InternalError,
                    $"TŞ §8 edge kataloğu dışı tür üretilemez: {kind}");
            }

            // Güvenlik bulgusu 4: ucu admit edilmemiş (limit aşımı) kenar
            // yayınlanmaz — truncated kenar, dangling üretmemek için bilinçli
            // düşüştür; Truncated zaten node reddinde işaretlenir.
            if (!_nodes.ContainsKey(from.Key) || !_nodes.ContainsKey(to.Key))
            {
                return;
            }

            var key = $"{kind}\u001e{from.Key}\u001e{to.Key}";
            if (!_edges.TryGetValue(key, out var record))
            {
                record = new EdgeRecord(from, to, kind, resolution, ambiguity);
                _edges.Add(key, record);
            }

            record.AddEvidence(evidence);
        }

        public void AddWarning(string message)
        {
            if (_warningSeen.Add(message))
            {
                Warnings.Add(message);
            }
        }

        public List<NodeOut> SortedNodes() =>
            _nodes.Values.OrderBy(n => n.Key, StringComparer.Ordinal).Select(n => n.Node).ToList();

        public List<EdgeOut> SortedEdges() =>
            _edges.Values.OrderBy(EdgeSortKey, StringComparer.Ordinal).Select(e => e.ToOut()).ToList();

        public List<EvidenceOut> SortedDistinctEvidence()
        {
            var seen = new Dictionary<string, EvidenceOut>(StringComparer.Ordinal);
            foreach (var edge in _edges.Values)
            {
                foreach (var evidence in edge.Evidence)
                {
                    var key = EvidenceKey(evidence);
                    if (!seen.ContainsKey(key))
                    {
                        seen.Add(key, evidence);
                    }
                }
            }

            return seen.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => p.Value).ToList();
        }

        private static string EdgeSortKey(EdgeRecord e) => $"{e.Kind}\u001e{e.From.Key}\u001e{e.To.Key}";

        private static string NodeKey(string kind, string qualifiedName, string? relativePath) =>
            $"{kind}\u001f{qualifiedName}\u001f{relativePath ?? string.Empty}";

        internal static string EvidenceKey(EvidenceOut e)
        {
            var span = e.Span is null
                ? string.Empty
                : $"{e.Span.RelativePath}\u001e{e.Span.StartLine}\u001e{e.Span.EndLine}\u001e{e.Span.SourceHash}";
            return $"{e.Kind}\u001e{e.AnalyzerId}\u001e{e.AnalyzerVersion}\u001e{e.Rationale}\u001e{span}";
        }

        private sealed class EdgeRecord
        {
            private readonly Dictionary<string, EvidenceOut> _evidence = new(StringComparer.Ordinal);

            public EdgeRecord(NodeRecord from, NodeRecord to, string kind, string resolution, AmbiguityOut? ambiguity)
            {
                From = from;
                To = to;
                Kind = kind;
                Resolution = resolution;
                Ambiguity = ambiguity;
            }

            public NodeRecord From { get; }
            public NodeRecord To { get; }
            public string Kind { get; }
            public string Resolution { get; }
            public AmbiguityOut? Ambiguity { get; }
            public IReadOnlyCollection<EvidenceOut> Evidence => _evidence.Values;

            public void AddEvidence(EvidenceOut evidence)
            {
                var key = GraphAssembler.EvidenceKey(evidence);
                if (!_evidence.ContainsKey(key))
                {
                    _evidence.Add(key, evidence);
                }
            }

            public EdgeOut ToOut() => new()
            {
                Kind = Kind,
                From = From.Ref,
                To = To.Ref,
                Resolution = Resolution,
                Evidence = _evidence.Values.OrderBy(GraphAssembler.EvidenceKey, StringComparer.Ordinal).ToList(),
                Ambiguity = Ambiguity,
            };
        }
    }

    /**
     * Analiz bağlamı. Sınıf (record değil), çünkü gezinme sırasında mutasyon
     * durumu taşır: derinlik tanısının dosya başına tek kez verilmesi.
     */
    private sealed class CallContext
    {
        public CallContext(
            SourceEntry entry,
            IReadOnlyList<SourceEntry> entries,
            SemanticModel model,
            GraphAssembler assembler,
            Dictionary<ISymbol, NodeRecord> registry,
            List<DiagnosticOut> diagnostics)
        {
            Entry = entry;
            Entries = entries;
            Model = model;
            Assembler = assembler;
            Registry = registry;
            Diagnostics = diagnostics;
        }

        public SourceEntry Entry { get; }
        public IReadOnlyList<SourceEntry> Entries { get; }
        public SemanticModel Model { get; }
        public GraphAssembler Assembler { get; }
        public Dictionary<ISymbol, NodeRecord> Registry { get; }
        public List<DiagnosticOut> Diagnostics { get; }

        /** Derinlik sınırı tanısı dosya başına yalnızca bir kez verilir. */
        public bool DepthReported { get; set; }
    }

    /* ------------------------------------------------------------------ */
    /* Ana giriş                                                           */
    /* ------------------------------------------------------------------ */

    public static WorkerResponse Analyze(WorkerRequest request)
    {
        ValidateRequest(request);

        // Güvenlik bulgusu 4: yanıt node bütçesi — istekteki opsiyonel
        // maxNodes veya sert tavan (ProtocolConstants.MaxResponseNodes).
        var nodeLimit = request.MaxNodes ?? ProtocolConstants.MaxResponseNodes;

        var assembler = new GraphAssembler(nodeLimit);
        var warnings = assembler.Warnings;

        // 1) Kaynaklar: yol normalizasyonu, çakışma reddi, deterministik sıra.
        //    Parse, dosya başına izole edilir: derin AST Roslyn parser'ında
        //    InsufficientExecutionStackException üretebilir (guard'lı, yakalanabilir);
        //    tek dosyanın sorunu analizi düşürmez (TŞ §5.1 / TS adapter kuralı).
        var entries = new List<SourceEntry>();
        var seenPaths = new HashSet<string>(StringComparer.Ordinal);
        var parseDiagnostics = new List<DiagnosticOut>();
        foreach (var file in request.Files!)
        {
            var relativePath = NormalizeRelativePath(file.Path);
            if (!seenPaths.Add(relativePath))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"Aynı kaynak yolu iki kez verildi: {relativePath}");
            }

            SyntaxTree tree;
            try
            {
                tree = CSharpSyntaxTree.ParseText(
                    file.Content,
                    new CSharpParseOptions(languageVersion: LanguageVersion.Latest),
                    path: relativePath);
            }
            catch (Exception ex)
            {
                parseDiagnostics.Add(new DiagnosticOut
                {
                    RelativePath = relativePath,
                    Code = "ADAPTER_INTERNAL",
                    Message = $"dosya ayrıştırılamadı, analiz setinden çıkarıldı: {ex.Message}",
                    Line = 0,
                });
                continue;
            }

            entries.Add(new SourceEntry(relativePath, Sha256Hex(file.Content), tree));
        }

        entries.Sort((a, b) => string.CompareOrdinal(a.RelativePath, b.RelativePath));

        // 2) Referanslar + derleme (bellek-içi; workspace'e dokunulmaz — ADR-008).
        var referencePaths = ReferenceResolver.Resolve(request.ReferenceDirs, "net10.0", warnings);
        var references = referencePaths.Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        // Top-level statement içeren girdi yürütülebilir derlenmelidir
        // (CS8805); aksi halde kütüphane çıktısı CS5001 uyarısı üretmez.
        // Her iki durum da girdiden türetilir → deterministik.
        var hasTopLevelStatements = entries.Any(e =>
            e.Tree.GetRoot() is CompilationUnitSyntax unit &&
            unit.Members.OfType<GlobalStatementSyntax>().Any());
        var outputKind = hasTopLevelStatements ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary;
        var compilation = CSharpCompilation.Create(
            "CausorynWorker.Analysis",
            entries.Select(e => e.Tree),
            references,
            new CSharpCompilationOptions(
                outputKind,
                nullableContextOptions: NullableContextOptions.Enable));

        // 3) Tanılar: Roslyn 5.0 GetDiagnostics (parse+declaration+semantic+body)
        //    tek çağrı; Warning+Error korunur, dosyaya eşlenir (1 tabanlı satır)
        //    ve kanonik sıraya dizilir (TŞ §8 invariant iv). Aşama izole:
        //    derin AST'de Roslyn bind/tanı aşaması InsufficientExecutionStackException
        //    fırlatabilir (guard'lı) — yakalanır, bütün girdiye ADAPTER_INTERNAL
        //    tanısı + uyarı yazılır ve analiz partial olarak sürer.
        var entryByTree = entries.ToDictionary(e => e.Tree, e => e);
        var diagnostics = parseDiagnostics;
        try
        {
            foreach (var diagnostic in compilation.GetDiagnostics())
            {
                if (diagnostic.Severity is not (DiagnosticSeverity.Error or DiagnosticSeverity.Warning))
                {
                    continue;
                }

                if (diagnostic.Location.SourceTree is not SyntaxTree sourceTree ||
                    !entryByTree.TryGetValue(sourceTree, out var entry))
                {
                    continue; // dosya-dışı derleme tanısı bu protokolde taşınmaz
                }

                var lineSpan = diagnostic.Location.GetLineSpan();
                var line = lineSpan.IsValid ? lineSpan.StartLinePosition.Line + 1 : 0;
                diagnostics.Add(new DiagnosticOut
                {
                    RelativePath = entry.RelativePath,
                    Code = diagnostic.Id,
                    Message = diagnostic.GetMessage(),
                    Line = line,
                });
            }
        }
        catch (Exception ex)
        {
            foreach (var entry in entries)
            {
                diagnostics.Add(new DiagnosticOut
                {
                    RelativePath = entry.RelativePath,
                    Code = "ADAPTER_INTERNAL",
                    Message = $"derleme tanı aşaması tamamlanamadı ({ex.GetType().Name}); girdi derinliği kod bütçesini aşıyor",
                    Line = 0,
                });
            }

            warnings.Add("tanı aşaması tamamlanamadı: " + ex.Message);
        }

        diagnostics.Sort((a, b) =>
        {
            var byPath = string.CompareOrdinal(a.RelativePath, b.RelativePath);
            if (byPath != 0)
            {
                return byPath;
            }

            var byLine = a.Line.CompareTo(b.Line);
            if (byLine != 0)
            {
                return byLine;
            }

            var byCode = string.CompareOrdinal(a.Code, b.Code);
            return byCode != 0 ? byCode : string.CompareOrdinal(a.Message, b.Message);
        });

        var registry = new Dictionary<ISymbol, NodeRecord>(SymbolEqualityComparer.Default);
        var controllers = new List<(SourceEntry Entry, ControllerInfo Info)>();

        /**
         * Aşama izolasyonu (TS adapter runPhase kuralı): tek dosyadaki
         * sorun — Roslyn semantic aşamalarının derinlik guard'ı dahil —
         * analizi düşürmez; ADAPTER_INTERNAL tanısı olarak toplanır ve
         * analiz partial olarak sürer.
         */
        void RunPhaseIsolated(SourceEntry phaseEntry, Action phase)
        {
            try
            {
                phase();
            }
            catch (InsufficientExecutionStackException)
            {
                diagnostics.Add(new DiagnosticOut
                {
                    RelativePath = phaseEntry.RelativePath,
                    Code = "ADAPTER_INTERNAL",
                    Message = "çözümleme aşaması derinlik sınırına takıldı (InsufficientExecutionStackException); aşama bu dosya için atlandı",
                    Line = 0,
                });
                warnings.Add($"çözümleme derinlik sınırı: {phaseEntry.RelativePath} (aşama atlandı)");
            }
            catch (Exception ex)
            {
                diagnostics.Add(new DiagnosticOut
                {
                    RelativePath = phaseEntry.RelativePath,
                    Code = "ADAPTER_INTERNAL",
                    Message = ex.Message,
                    Line = 0,
                });
                warnings.Add($"çözümleme aşaması hata verdi: {phaseEntry.RelativePath} ({ex.GetType().Name})");
            }
        }

        // 4) Faz 1: bildirimler (CONTAINS + registry) — önce TÜM dosyalar,
        //    böylece çapraz-dosya sembol araması registry'de tam olur.
        foreach (var entry in entries)
        {
            RunPhaseIsolated(entry, () =>
            {
                var model = compilation.GetSemanticModel(entry.Tree);
                var fileRecord = assembler.EnsureNode(
                    "File", entry.RelativePath, entry.RelativePath,
                    new Dictionary<string, object> { ["sourceHash"] = entry.SourceHash });
                WalkCompilationUnit(entry, fileRecord.Node, model, assembler, registry, controllers);
            });
        }

        // 5) Faz 2: çağrılar + minimal API rotaları (semantic model).
        foreach (var entry in entries)
        {
            RunPhaseIsolated(entry, () =>
            {
                var model = compilation.GetSemanticModel(entry.Tree);
                VisitCalls(entry, entries, model, assembler, registry, diagnostics);
            });
        }

        // 6) Faz 3: controller öznitelik rotaları (semantic + bilinen ad kuralı).
        foreach (var (entry, info) in controllers)
        {
            RunPhaseIsolated(entry, () =>
            {
                var model = compilation.GetSemanticModel(entry.Tree);
                ExtractControllerRoutes(entry, info, model, assembler, registry);
            });
        }

        // 7) Kanonik çıktı (TŞ §8 invariant iv/vi).
        if (assembler.Truncated)
        {
            // Güvenlik bulgusu 4: sessiz kesim yok — tanı düşer, status
            // aşağıdaki mevcut ifadeyle "partial" olur.
            diagnostics.Add(new DiagnosticOut
            {
                RelativePath = string.Empty,
                Code = "RESPONSE_TRUNCATED",
                Message = $"yanıt node bütçesi aşıldı (maxNodes={nodeLimit.ToString(System.Globalization.CultureInfo.InvariantCulture)}); aşan node/kenarlar yayınlanmadı",
                Line = 0,
            });
        }
        var edges = assembler.SortedEdges();
        var verified = edges.Count(e => e.Resolution == "verified");
        var coverageRatio = edges.Count == 0
            ? 0d
            : Math.Round((double)verified * 10000d / edges.Count, 4, MidpointRounding.AwayFromZero) / 10000d;

        return new WorkerResponse
        {
            Id = request.Id,
            Status = diagnostics.Count > 0 ? "partial" : "ready",
            Worker = new WorkerInfo(),
            Capabilities = new CapabilitiesOut
            {
                AstParse = true,
                SymbolResolution = true,
                ContainsEdges = true,
                CallEdges = true,
                ImportEdges = false,
                FrameworkLinkers = false,
            },
            CoverageRatio = coverageRatio,
            UnsupportedConstructs = UnsupportedConstructs.ToList(),
            Warnings = warnings,
            Diagnostics = diagnostics,
            Nodes = assembler.SortedNodes(),
            Edges = edges,
            Evidence = assembler.SortedDistinctEvidence(),
        };
    }

    private static void ValidateRequest(WorkerRequest request)
    {
        if (request.Id.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, "'id' alanı zorunludur");
        }

        if (string.IsNullOrWhiteSpace(request.Type))
        {
            throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, "'type' alanı zorunludur");
        }

        if (request.ProtocolVersion is not null && request.ProtocolVersion != ProtocolConstants.ProtocolVersion)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.InvalidArgument,
                $"Desteklenmeyen protokol sürümü: '{request.ProtocolVersion}' (desteklenen: '{ProtocolConstants.ProtocolVersion}')");
        }

        if (request.ExtensionData is { Count: > 0 })
        {
            throw new ProtocolException(
                ProtocolErrorCodes.InvalidArgument,
                $"İstek bilinmeyen alan içeriyor: {string.Join(", ", request.ExtensionData.Keys)}");
        }

        if (request.Files is null || request.Files.Count == 0)
        {
            throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, "'files' alanı zorunludur (en az bir kaynak)");
        }

        // Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut
        // limitleri) — aşım LIMIT_EXCEEDED, süreç ölmez.
        if (request.Files.Count > ProtocolConstants.MaxFileCount)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.LimitExceeded,
                $"files sayısı sınırı aşıldı: {request.Files.Count} > {ProtocolConstants.MaxFileCount}");
        }

        // Güvenlik bulgusu 4: maxNodes aralık denetimi — null → sert tavan;
        // 1..MaxResponseNodes dışı açık INVALID_ARGUMENT reddi (sessiz
        // clamp yerine; ADR-010 açık red kültürü).
        if (request.MaxNodes is < 1 or > ProtocolConstants.MaxResponseNodes)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.InvalidArgument,
                $"maxNodes 1..{ProtocolConstants.MaxResponseNodes} aralığında olmalı; gelen: {request.MaxNodes?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "null"}");
        }

        foreach (var file in request.Files)
        {
            if (file.Path is null || file.Content is null)
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    "files[] girdisi 'path' ve 'content' alanlarını zorunlu kılar");
            }

            if (file.ExtensionData is { Count: > 0 })
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"files[] girdisi bilinmeyen alan içeriyor: {string.Join(", ", file.ExtensionData.Keys)}");
            }

            var contentBytes = Encoding.UTF8.GetByteCount(file.Content);
            if (contentBytes > ProtocolConstants.MaxFileContentBytes)
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.LimitExceeded,
                    $"dosya içerik boyutu sınırı aşıldı: {file.Path} ({contentBytes} bayt > {ProtocolConstants.MaxFileContentBytes})");
            }
        }
    }

    private static string NormalizeRelativePath(string raw)
    {
        var posix = raw.Replace('\\', '/');
        if (posix.StartsWith('/') || Regex.IsMatch(posix, "^[a-zA-Z]:"))
        {
            throw new ProtocolException(
                ProtocolErrorCodes.InvalidArgument,
                $"Mutlak kaynak yolu kabul edilmez: {raw}");
        }

        foreach (var segment in posix.Split('/'))
        {
            if (segment.Length == 0 || segment == ".")
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"Kaynak yolu boş/geçersiz segment içeriyor: {raw}");
            }

            if (segment == "..")
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"Kaynak yolu kök dışına çıkıyor: {raw}");
            }
        }

        return posix;
    }

    private static string Sha256Hex(string content)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /* ------------------------------------------------------------------ */
    /* Faz 1: bildirimler → CONTAINS + registry                            */
    /* ------------------------------------------------------------------ */

    private static void WalkCompilationUnit(
        SourceEntry entry,
        NodeOut fileNode,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry,
        List<(SourceEntry Entry, ControllerInfo Info)> controllers)
    {
        if (entry.Tree.GetRoot() is not CompilationUnitSyntax unit)
        {
            return;
        }

        foreach (var member in unit.Members)
        {
            WalkMember(entry, member, string.Empty, fileNode, model, assembler, registry, controllers);
        }
    }

    private static void WalkMember(
        SourceEntry entry,
        SyntaxNode member,
        string nsPrefix,
        NodeOut fileNode,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry,
        List<(SourceEntry Entry, ControllerInfo Info)> controllers)
    {
        switch (member)
        {
            case NamespaceDeclarationSyntax ns:
                foreach (var child in ns.Members)
                {
                    WalkMember(entry, child, JoinNamespace(nsPrefix, ns.Name.ToString()), fileNode, model, assembler, registry, controllers);
                }

                break;

            case FileScopedNamespaceDeclarationSyntax fsns:
                foreach (var child in fsns.Members)
                {
                    WalkMember(entry, child, JoinNamespace(nsPrefix, fsns.Name.ToString()), fileNode, model, assembler, registry, controllers);
                }

                break;

            case TypeDeclarationSyntax typeDecl:
                RegisterType(entry, typeDecl, nsPrefix, fileNode, model, assembler, registry, controllers);
                foreach (var child in typeDecl.Members)
                {
                    WalkMember(entry, child, nsPrefix, fileNode, model, assembler, registry, controllers);
                }

                break;

            case GlobalStatementSyntax { Statement: LocalFunctionStatementSyntax localFunction }:
                RegisterTopLevelLocalFunction(entry, localFunction, fileNode, model, assembler, registry);
                break;

            case EnumDeclarationSyntax enumDecl:
                RegisterEnum(entry, enumDecl, nsPrefix, fileNode, model, assembler, registry);
                break;
        }
    }

    private static string JoinNamespace(string prefix, string name)
    {
        var trimmed = name.Trim();
        return prefix.Length == 0 ? trimmed : $"{prefix}.{trimmed}";
    }

    private static void RegisterType(
        SourceEntry entry,
        TypeDeclarationSyntax typeDecl,
        string nsPrefix,
        NodeOut fileNode,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry,
        List<(SourceEntry Entry, ControllerInfo Info)> controllers)
    {
        var name = typeDecl.Identifier.ValueText;
        var kind = TypeKindOf(typeDecl);
        var qualifiedName = JoinNamespace(nsPrefix, name);
        var record = assembler.EnsureNode(kind, qualifiedName, entry.RelativePath, null);
        var symbol = model.GetDeclaredSymbol(typeDecl);
        if (symbol is not null)
        {
            registry[symbol] = record;
        }

        AddContains(assembler, entry, typeDecl, fileNode, record,
            $"CONTAINS: {entry.RelativePath} dosyasındaki {qualifiedName} {kind.ToLowerInvariant()} bildirimi AST span kanıtıyla eşlendi.");

        if (typeDecl is ClassDeclarationSyntax classDecl)
        {
            controllers.Add((entry, new ControllerInfo(classDecl, record, qualifiedName)));
        }

        RegisterTypeMembers(entry, typeDecl, qualifiedName, record, model, assembler, registry);
    }

    private static void RegisterTypeMembers(
        SourceEntry entry,
        TypeDeclarationSyntax typeDecl,
        string ownerQualifiedName,
        NodeRecord ownerRecord,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry)
    {
        foreach (var member in typeDecl.Members)
        {
            switch (member)
            {
                case MethodDeclarationSyntax method:
                    RegisterMember(entry, method, ownerQualifiedName, ownerRecord, "Method",
                        method.Identifier.ValueText, model, assembler, registry);
                    break;

                case ConstructorDeclarationSyntax ctor:
                    RegisterMember(entry, ctor, ownerQualifiedName, ownerRecord, "Method", "constructor",
                        model, assembler, registry);
                    break;

                case PropertyDeclarationSyntax property:
                    // Belgelenmiş yaklaşım: property, CIL düzeyinde erişimci
                    // metotlarına çözüldüğü için Method düğümüyle temsil edilir.
                    RegisterMember(entry, property, ownerQualifiedName, ownerRecord, "Method",
                        property.Identifier.ValueText, model, assembler, registry);
                    break;
            }
        }
    }

    private static void RegisterMember(
        SourceEntry entry,
        SyntaxNode declaration,
        string ownerQualifiedName,
        NodeRecord ownerRecord,
        string kind,
        string memberName,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry)
    {
        var qualifiedName = $"{ownerQualifiedName}.{memberName}";
        var record = assembler.EnsureNode(kind, qualifiedName, entry.RelativePath, null);
        var symbol = declaration switch
        {
            MethodDeclarationSyntax m => (ISymbol?)model.GetDeclaredSymbol(m),
            ConstructorDeclarationSyntax c => (ISymbol?)model.GetDeclaredSymbol(c),
            PropertyDeclarationSyntax p => (ISymbol?)model.GetDeclaredSymbol(p),
            _ => null,
        };
        if (symbol is not null)
        {
            registry[symbol] = record;
        }

        AddContains(assembler, entry, declaration, ownerRecord.Node, record,
            $"CONTAINS: {ownerQualifiedName} bildirimi içindeki {memberName} üyesi AST span kanıtıyla eşlendi.");
    }

    private static void RegisterTopLevelLocalFunction(
        SourceEntry entry,
        LocalFunctionStatementSyntax localFunction,
        NodeOut fileNode,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry)
    {
        var symbol = model.GetDeclaredSymbol(localFunction);
        // Top-level local function sentetik Program sınıfına derlenir; bu
        // kural PROTOCOL.md'de belgelenmiştir (qualifiedName: Program.<ad>).
        var ownerDisplay = symbol?.ContainingType?.ToDisplayString() ?? "Program";
        var qualifiedName = $"{ownerDisplay}.{localFunction.Identifier.ValueText}";
        var record = assembler.EnsureNode("Function", qualifiedName, entry.RelativePath, null);
        if (symbol is not null)
        {
            registry[symbol] = record;
        }

        AddContains(assembler, entry, localFunction, fileNode, record,
            $"CONTAINS: {entry.RelativePath} dosyasındaki {qualifiedName} yerel fonksiyon bildirimi AST span kanıtıyla eşlendi.");
    }

    private static string TypeKindOf(TypeDeclarationSyntax typeDecl) => typeDecl switch
    {
        ClassDeclarationSyntax => "Class",
        InterfaceDeclarationSyntax => "Interface",
        StructDeclarationSyntax => "Type",
        RecordDeclarationSyntax recordDecl =>
            recordDecl.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "Type" : "Class",
        _ => "Type",
    };

    private static void RegisterEnum(
        SourceEntry entry,
        EnumDeclarationSyntax enumDecl,
        string nsPrefix,
        NodeOut fileNode,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry)
    {
        var name = enumDecl.Identifier.ValueText;
        var qualifiedName = JoinNamespace(nsPrefix, name);
        var record = assembler.EnsureNode("Type", qualifiedName, entry.RelativePath, null);
        var symbol = model.GetDeclaredSymbol(enumDecl);
        if (symbol is not null)
        {
            registry[symbol] = record;
        }

        AddContains(assembler, entry, enumDecl, fileNode, record,
            $"CONTAINS: {entry.RelativePath} dosyasındaki {qualifiedName} enum bildirimi AST span kanıtıyla eşlendi.");
    }

    private static void AddContains(
        GraphAssembler assembler,
        SourceEntry entry,
        SyntaxNode declaration,
        NodeOut fromNode,
        NodeRecord toRecord,
        string rationale)
    {
        var from = assembler.EnsureNode(fromNode.Kind, fromNode.QualifiedName, fromNode.RelativePath, null);
        assembler.AddEdge("CONTAINS", from, toRecord, "verified",
            SpanEvidence(entry, declaration, "ast-span", rationale), null);
    }

    /* ------------------------------------------------------------------ */
    /* Faz 2: çağrılar + minimal API                                       */
    /* ------------------------------------------------------------------ */

    /**
     * AST gezinme derinlik üst sınırı (denetim bulgusu düzeltmesi):
     * sınırsız özyineleme patolojik derin AST'de StackOverflowException
     * üretir (.NET'te yakalanamaz, süreç ölür). Sınır aşımında alt ağaç
     * atlanır, ADAPTER_INTERNAL tanısı + uyarı verilir ve analiz
     * "partial" olarak raporlanır — "tek dosyadaki sorun analizi
     * düşürmez" hedefiyle (sınıf başlığı) uyumlu. Çöküş kanıtı: eski
     * binary 5000 katmanlı ifadede 0xC00000FD ile ölmüştü; yeni kod aynı
     * girdide tanı üretip yanıtı döner (tests/roslyn-worker.test.ts).
     */
    private const int MaxTraversalDepth = 1000;

    private static void VisitCalls(
        SourceEntry entry,
        IReadOnlyList<SourceEntry> entries,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry,
        List<DiagnosticOut> diagnostics)
    {
        var context = new CallContext(entry, entries, model, assembler, registry, diagnostics);
        VisitNode(context, entry.Tree.GetRoot(), null, depth: 0);
    }

    private static void VisitNode(CallContext context, SyntaxNode node, NodeRecord? caller, int depth)
    {
        if (depth > MaxTraversalDepth)
        {
            ReportDepthExceeded(context, node);
            return; // derin alt ağaç atlanır
        }

        var currentCaller = CallerFor(context, node) ?? caller;

        if (node is InvocationExpressionSyntax invocation)
        {
            TryMinimalApiRoute(context, invocation, currentCaller);
            EmitCall(context, invocation, currentCaller);
        }
        else if (node is ObjectCreationExpressionSyntax or ImplicitObjectCreationExpressionSyntax)
        {
            EmitCreation(context, node, currentCaller);
        }

        foreach (var child in node.ChildNodes())
        {
            VisitNode(context, child, currentCaller, depth + 1);
        }
    }

    /** Derinlik aşımı tanısı: dosya başına bir kez (CallContext.DepthReported). */
    private static void ReportDepthExceeded(CallContext context, SyntaxNode node)
    {
        if (context.DepthReported)
        {
            return;
        }

        context.DepthReported = true;
        var lineSpan = context.Entry.Tree.GetLineSpan(node.Span);
        context.Diagnostics.Add(new DiagnosticOut
        {
            RelativePath = context.Entry.RelativePath,
            Code = "ADAPTER_INTERNAL",
            Message = $"AST gezinme derinliği {MaxTraversalDepth} sınırını aştı; derin alt ağaçlar atlandı",
            Line = lineSpan.IsValid ? lineSpan.StartLinePosition.Line + 1 : 0,
        });
        context.Assembler.AddWarning(
            $"AST derinlik sınırı aşıldı: {context.Entry.RelativePath} (derin alt ağaçlar atlandı)");
    }

    private static NodeRecord? CallerFor(CallContext context, SyntaxNode node)
    {
        ISymbol? symbol = node switch
        {
            MethodDeclarationSyntax m => (ISymbol?)context.Model.GetDeclaredSymbol(m),
            ConstructorDeclarationSyntax c => (ISymbol?)context.Model.GetDeclaredSymbol(c),
            PropertyDeclarationSyntax p => (ISymbol?)context.Model.GetDeclaredSymbol(p),
            AccessorDeclarationSyntax acc when acc.Parent?.Parent is PropertyDeclarationSyntax p2 =>
                (ISymbol?)context.Model.GetDeclaredSymbol(p2),
            LocalFunctionStatementSyntax lf => (ISymbol?)context.Model.GetDeclaredSymbol(lf),
            _ => null,
        };
        return symbol is null ? null : RegistryLookup(context, symbol);
    }

    private static NodeRecord? RegistryLookup(CallContext context, ISymbol symbol)
    {
        if (context.Registry.TryGetValue(symbol, out var hit))
        {
            return hit;
        }

        var original = symbol.OriginalDefinition;
        if (!SymbolEqualityComparer.Default.Equals(original, symbol) &&
            context.Registry.TryGetValue(original, out var originalHit))
        {
            return originalHit;
        }

        return null;
    }

    private static void EmitCall(CallContext context, InvocationExpressionSyntax invocation, NodeRecord? caller)
    {
        if (caller is null)
        {
            // Çağıran bağlamı modellenmeyen çağrılar (top-level ifadeler,
            // alan başlatıcıları) bu dilimde CALLS kenarı üretmez (TS
            // adapter'daki "modül üstü çağrılar" kuralıyla aynı).
            return;
        }

        var expressionText = invocation.Expression.ToString().Trim();
        var info = context.Model.GetSymbolInfo(invocation);

        if (info.Symbol is null && info.CandidateSymbols.Length > 0)
        {
            EmitUnresolvedCall(context, caller, invocation, expressionText, new AmbiguityOut
            {
                Candidates = info.CandidateSymbols.Select(s => s.ToDisplayString()).ToList(),
                Reason = "Aşırı yükleme belirsizliği; semantik model tek aday seçemedi.",
            });
            return;
        }

        if (info.Symbol is null)
        {
            EmitUnresolvedCall(context, caller, invocation, expressionText, null);
            return;
        }

        var target = ResolveTargetRecord(context, info.Symbol);
        if (target is not null)
        {
            context.Assembler.AddEdge("CALLS", caller, target, "verified",
                SpanEvidence(context.Entry, invocation, "semantic-symbol",
                    $"CALLS: {caller.Node.QualifiedName} içindeki çağrı ifadesi Roslyn semantic model ile {target.Node.QualifiedName} sembolüne çözümlendi (verified)."),
                null);
            return;
        }

        // Semantik çözümleme var ama hedef analiz setinin dışında: açık
        // UnknownExternal node + checker dayanaklı verified kenar (TS
        // adapter ile aynı kural).
        var externalName = ExternalQualifiedName(info.Symbol);
        var external = context.Assembler.EnsureExternal(externalName);
        context.Assembler.AddEdge("CALLS", caller, external, "verified",
            SpanEvidence(context.Entry, invocation, "semantic-symbol",
                $"CALLS: {caller.Node.QualifiedName} içindeki çağrı analiz seti dışındaki {externalName} sembolüne çözümlendi; dış kaynak açık UnknownExternal node olarak temsil edildi."),
            null);
    }

    private static void EmitCreation(CallContext context, SyntaxNode creation, NodeRecord? caller)
    {
        if (caller is null)
        {
            return;
        }

        var expressionText = creation.ToString().Trim();
        var info = context.Model.GetSymbolInfo(creation);

        if (info.Symbol is null && info.CandidateSymbols.Length > 0)
        {
            EmitUnresolvedCall(context, caller, creation, expressionText, new AmbiguityOut
            {
                Candidates = info.CandidateSymbols.Select(s => s.ToDisplayString()).ToList(),
                Reason = "Kurucu aşırı yükleme belirsizliği; semantik model tek aday seçemedi.",
            });
            return;
        }

        var ctor = info.Symbol as IMethodSymbol;
        var containingType = ctor?.ContainingType;
        if (containingType is null)
        {
            EmitUnresolvedCall(context, caller, creation, expressionText, null);
            return;
        }

        // new X() hedefi TS adapter kuralıyla kurulan SINIFIN kendisidir.
        var target = ResolveTargetRecord(context, containingType);
        if (target is not null)
        {
            context.Assembler.AddEdge("CALLS", caller, target, "verified",
                SpanEvidence(context.Entry, creation, "semantic-symbol",
                    $"CALLS: {caller.Node.QualifiedName} içindeki nesne oluşturma {target.Node.QualifiedName} sınıfına çözümlendi (semantic-symbol, verified)."),
                null);
            return;
        }

        var externalName = ExternalQualifiedName(containingType);
        var external = context.Assembler.EnsureExternal(externalName);
        context.Assembler.AddEdge("CALLS", caller, external, "verified",
            SpanEvidence(context.Entry, creation, "semantic-symbol",
                $"CALLS: {caller.Node.QualifiedName} içindeki nesne oluşturma analiz seti dışındaki {externalName} sınıfına çözümlendi; dış kaynak açık UnknownExternal node olarak temsil edildi."),
            null);
    }

    private static void EmitUnresolvedCall(
        CallContext context,
        NodeRecord caller,
        SyntaxNode callSite,
        string callText,
        AmbiguityOut? ambiguity)
    {
        var target = context.Assembler.EnsureExternal(callText);
        context.Assembler.AddEdge("CALLS", caller, target, "unresolved",
            SpanEvidence(context.Entry, callSite, "ast-span",
                $"CALLS: {caller.Node.QualifiedName} içindeki '{callText}' çağrısı çözümlenemedi; uydurma hedef yerine açık UnknownExternal node üzerinde unresolved işaretlendi."),
            ambiguity);
        context.Assembler.AddWarning(
            $"CALLS çözümlenemedi: {context.Entry.RelativePath} '{callText}' (unresolved, UnknownExternal node üretildi)");
    }

    private static NodeRecord? ResolveTargetRecord(CallContext context, ISymbol symbol)
    {
        var hit = RegistryLookup(context, symbol);
        if (hit is not null)
        {
            return hit;
        }

        var declaringReference = symbol.DeclaringSyntaxReferences.FirstOrDefault();
        if (declaringReference is null)
        {
            return null; // metadata sembolü — set dışı
        }

        // Analiz setinde bildirilmiş ama registry'de yok: bildirimden türet.
        return DeriveRecord(context, symbol);
    }

    private static NodeRecord? DeriveRecord(CallContext context, ISymbol symbol)
    {
        string kind;
        string qualifiedName;

        switch (symbol)
        {
            case IMethodSymbol method when method.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor:
                return method.ContainingType is null ? null : DeriveRecord(context, method.ContainingType);

            case IMethodSymbol method when method.MethodKind == MethodKind.LocalFunction:
                kind = "Function";
                qualifiedName = $"{method.ContainingType?.ToDisplayString() ?? "Program"}.{method.Name}";
                break;

            case IMethodSymbol method:
                kind = "Method";
                qualifiedName = $"{TypeQualifiedName(method.ContainingType)}.{method.Name}";
                break;

            case IPropertySymbol property:
                kind = "Method"; // property → Method yaklaşımı (PROTOCOL.md)
                qualifiedName = $"{TypeQualifiedName(property.ContainingType)}.{property.Name}";
                break;

            case INamedTypeSymbol type:
                kind = CatalogKindOf(type);
                qualifiedName = TypeQualifiedName(type);
                break;

            default:
                return null;
        }

        var relativePath = RelativePathOfDeclaration(context, symbol);
        return context.Assembler.EnsureNode(kind, qualifiedName, relativePath, null);
    }

    private static string? RelativePathOfDeclaration(CallContext context, ISymbol symbol)
    {
        foreach (var reference in symbol.DeclaringSyntaxReferences)
        {
            foreach (var entry in context.Entries)
            {
                if (entry.Tree.Equals(reference.SyntaxTree))
                {
                    return entry.RelativePath;
                }
            }
        }

        return null;
    }

    private static string CatalogKindOf(INamedTypeSymbol type) => type.TypeKind switch
    {
        TypeKind.Interface => "Interface",
        TypeKind.Struct or TypeKind.Enum => "Type",
        TypeKind.Class when type.IsRecord && type.IsValueType => "Type",
        TypeKind.Class => "Class",
        _ => "Type",
    };

    private static string TypeQualifiedName(INamedTypeSymbol? type)
    {
        if (type is null)
        {
            return string.Empty;
        }

        var owner = type.ContainingType is null
            ? type.Name
            : $"{TypeQualifiedName(type.ContainingType)}.{type.Name}";
        var ns = type.ContainingNamespace;
        return ns is { IsGlobalNamespace: false } ? $"{ns.ToDisplayString()}.{owner}" : owner;
    }

    private static string ExternalQualifiedName(ISymbol symbol)
    {
        var ns = symbol.ContainingNamespace;
        var nsPrefix = ns is { IsGlobalNamespace: false } ? $"{ns.ToDisplayString()}." : string.Empty;
        return symbol switch
        {
            IMethodSymbol method => $"{nsPrefix}{TypeQualifiedName(method.ContainingType)}.{method.OriginalDefinition.Name}",
            IPropertySymbol property => $"{nsPrefix}{TypeQualifiedName(property.ContainingType)}.{property.OriginalDefinition.Name}",
            INamedTypeSymbol type => $"{nsPrefix}{TypeQualifiedName(type)}",
            _ => $"{nsPrefix}{symbol.Name}",
        };
    }

    /* ------------------------------------------------------------------ */
    /* Faz 2a: minimal API rotaları                                        */
    /* ------------------------------------------------------------------ */

    private static void TryMinimalApiRoute(CallContext context, InvocationExpressionSyntax invocation, NodeRecord? caller)
    {
        var name = invocation.Expression switch
        {
            MemberAccessExpressionSyntax memberAccess => memberAccess.Name.Identifier.ValueText,
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            GenericNameSyntax generic => generic.Identifier.ValueText,
            _ => null,
        };

        var isMethods = name == "MapMethods";
        if (name is null || (!isMethods && !MinimalApiMapNames.Contains(name)))
        {
            return;
        }

        var assembler = context.Assembler;
        var info = context.Model.GetSymbolInfo(invocation.Expression);
        // MapGet/MapPost aile birçok overload taşır; semantik kapı, çözülen
        // veya aday sembollerin içerici tipini denetler (probe kanıtı:
        // method-group argümanı Symbol=null + candidate döner).
        var mapSymbols = info.Symbol is null
            ? info.CandidateSymbols
            : [info.Symbol];
        var semanticBasis = mapSymbols
            .OfType<IMethodSymbol>()
            .Any(methodSymbol => methodSymbol.ContainingType.ToDisplayString() == EndpointRouteBuilderExtensions);

        var arguments = invocation.ArgumentList.Arguments;
        if (arguments.Count == 0)
        {
            return;
        }

        var pathValue = context.Model.GetConstantValue(arguments[0].Expression);
        if (!pathValue.HasValue || pathValue.Value is not string path)
        {
            assembler.AddWarning(
                $"Minimal API rotası modellenmedi: {context.Entry.RelativePath} '{name}(...)' — rota kalıbı sabit string değil");
            return;
        }

        List<string> verbs;
        if (isMethods)
        {
            verbs = arguments.Count > 1 ? ParseVerbsArgument(context, arguments[1].Expression) : new List<string>();
            if (verbs.Count == 0)
            {
                assembler.AddWarning(
                    $"Minimal API rotası modellenmedi: {context.Entry.RelativePath} 'MapMethods(...)' — HTTP fiilleri sabit string dizisi değil");
                return;
            }
        }
        else
        {
            verbs = new List<string> { name.Substring(3).ToUpperInvariant() };
        }

        foreach (var verb in verbs)
        {
            var endpoint = assembler.EnsureNode(
                "Endpoint",
                $"{verb} {path}",
                context.Entry.RelativePath,
                new Dictionary<string, object> { ["method"] = verb, ["path"] = path });

            var handlerRecord = ResolveHandler(context, arguments);
            if (handlerRecord is null)
            {
                continue; // endpoint node korunur, uydurma kenar üretilmez
            }

            var basisText = semanticBasis
                ? "EndpointRouteBuilderExtensions uzantı metodu semantic model ile doğrulandı"
                : "bilinen ad kuralı (semantic model uzantı metodunu çözümlemedi)";
            var resolution = semanticBasis ? "verified" : "heuristic";
            AmbiguityOut? ambiguity = semanticBasis
                ? null
                : new AmbiguityOut
                {
                    Candidates = new List<string> { name },
                    Reason = "Minimal API kayıt metodu ad kuralı ile tanındı; Microsoft.AspNetCore.Builder semantiği çözümlenemedi.",
                };

            assembler.AddEdge("ROUTES_TO", endpoint, handlerRecord, resolution,
                SpanEvidence(context.Entry, invocation, "route-attribute",
                    $"ROUTES_TO: '{verb} {path}' minimal API kaydı ({basisText}) {handlerRecord.Node.QualifiedName} handler'ına çözümlendi."),
                ambiguity);
        }
    }

    private static List<string> ParseVerbsArgument(CallContext context, ExpressionSyntax expression)
    {
        IEnumerable<ExpressionSyntax>? initializers = expression switch
        {
            ImplicitArrayCreationExpressionSyntax implicitArray => implicitArray.Initializer?.Expressions,
            ArrayCreationExpressionSyntax arrayCreation => arrayCreation.Initializer?.Expressions,
            CollectionExpressionSyntax collection => collection.Elements
                .OfType<ExpressionElementSyntax>()
                .Select(element => element.Expression),
            _ => null,
        };

        var verbs = new List<string>();
        if (initializers is null)
        {
            return verbs;
        }

        foreach (var initializer in initializers)
        {
            var value = context.Model.GetConstantValue(initializer);
            if (value.HasValue && value.Value is string verb)
            {
                verbs.Add(verb.ToUpperInvariant());
            }
        }

        return verbs;
    }

    private static NodeRecord? ResolveHandler(CallContext context, SeparatedSyntaxList<ArgumentSyntax> arguments)
    {
        foreach (var argument in arguments.Skip(1))
        {
            var expression = argument.Expression;
            if (expression is AnonymousFunctionExpressionSyntax)
            {
                context.Assembler.AddWarning(
                    $"Route handler modellenmedi: {context.Entry.RelativePath} minimal API kaydı — inline/anonymous handler unsupportedConstructs kapsamında");
                return null;
            }

            if (expression is not (IdentifierNameSyntax or MemberAccessExpressionSyntax))
            {
                continue;
            }

            var info = context.Model.GetSymbolInfo(expression);
            var symbol = info.Symbol
                ?? (info.CandidateSymbols.Length == 1 ? info.CandidateSymbols[0] : null);
            if (symbol is null)
            {
                // Çok adaylı method-group: analiz setindeki aday tercih edilir
                // (ör. top-level local function, tek adayda olduğu gibi).
                foreach (var candidate in info.CandidateSymbols)
                {
                    var candidateRecord = ResolveTargetRecord(context, candidate);
                    if (candidateRecord is not null)
                    {
                        return candidateRecord;
                    }
                }

                context.Assembler.AddWarning(
                    $"ROUTES_TO çözümlenemedi: {context.Entry.RelativePath} minimal API handler sembolü bulunamadı ('{expression}')");
                return null;
            }

            var record = ResolveTargetRecord(context, symbol);
            if (record is null)
            {
                // Handler analiz seti dışında: açık external node (TS adapter kuralı).
                return context.Assembler.EnsureExternal(ExternalQualifiedName(symbol));
            }

            return record;
        }

        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Faz 3: controller öznitelik rotaları                                */
    /* ------------------------------------------------------------------ */

    private static void ExtractControllerRoutes(
        SourceEntry entry,
        ControllerInfo controller,
        SemanticModel model,
        GraphAssembler assembler,
        Dictionary<ISymbol, NodeRecord> registry)
    {
        var declaration = controller.Declaration;
        var classSymbol = model.GetDeclaredSymbol(declaration);
        if (!IsController(classSymbol, controller.QualifiedName))
        {
            return;
        }

        var classRoute = FindAttribute(declaration.AttributeLists, model,
            semanticDisplay: $"{AspNetMvcNamespace}.RouteAttribute",
            simpleNames: new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Route", "RouteAttribute" });

        if (classRoute is null || classRoute.Template is null)
        {
            assembler.AddWarning(
                $"Controller rotası modellenmedi: {controller.QualifiedName} — [Route] özniteliği yok; convention routing kalıbı statik olarak belirlenemez (unsupportedConstructs: convention-routing-templates)");
            return;
        }

        var controllerName = declaration.Identifier.ValueText;
        foreach (var method in declaration.Members.OfType<MethodDeclarationSyntax>())
        {
            foreach (var verbAttribute in FindVerbAttributes(method.AttributeLists, model))
            {
                var methodRoute = FindAttribute(method.AttributeLists, model,
                    semanticDisplay: $"{AspNetMvcNamespace}.RouteAttribute",
                    simpleNames: new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Route", "RouteAttribute" });

                var template = ComposeTemplate(
                    classRoute.Template,
                    methodRoute?.Template ?? verbAttribute.Template ?? string.Empty,
                    controllerName,
                    method.Identifier.ValueText);

                var verb = verbAttribute.Verb ?? string.Empty;
                var endpoint = assembler.EnsureNode(
                    "Endpoint",
                    $"{verb} {template}",
                    entry.RelativePath,
                    new Dictionary<string, object> { ["method"] = verb, ["path"] = template });

                var actionSymbol = model.GetDeclaredSymbol(method);
                var actionRecord = actionSymbol is null ? null : RegistryLookupPlain(registry, actionSymbol);
                if (actionRecord is null)
                {
                    assembler.AddWarning(
                        $"ROUTES_TO çözümlenemedi: {controller.QualifiedName}.{method.Identifier.ValueText} action kaydı registry'de yok");
                    continue;
                }

                var allSemantic = classRoute.Semantic && verbAttribute.Semantic && (methodRoute is null || methodRoute.Semantic);
                var resolution = allSemantic ? "verified" : "heuristic";
                AmbiguityOut? ambiguity = null;
                if (!allSemantic)
                {
                    var unresolvedNames = new List<string>();
                    if (!classRoute.Semantic)
                    {
                        unresolvedNames.Add(classRoute.SimpleName);
                    }

                    if (!verbAttribute.Semantic)
                    {
                        unresolvedNames.Add(verbAttribute.SimpleName);
                    }

                    if (methodRoute is { Semantic: false })
                    {
                        unresolvedNames.Add(methodRoute.SimpleName);
                    }

                    ambiguity = new AmbiguityOut
                    {
                        Candidates = unresolvedNames,
                        Reason = "ASP.NET Core öznitelik tipleri semantic model ile Microsoft.AspNetCore.Mvc köküne çözümlenemedi; bilinen ad kuralı uygulandı (TŞ §8 heuristic).",
                    };
                }

                var basisText = allSemantic
                    ? "öznitelik tipleri semantic model ile Microsoft.AspNetCore.Mvc köküne çözümlendi"
                    : "bilinen ad kuralı (semantic model öznitelik tipini çözümlemedi)";

                assembler.AddEdge("ROUTES_TO", endpoint, actionRecord, resolution,
                    SpanEvidence(entry, verbAttribute.Node, "route-attribute",
                        $"ROUTES_TO: '{verbAttribute.Verb} {template}' controller route kaydı ({basisText}) {actionRecord.Node.QualifiedName} action'ına çözümlendi."),
                    ambiguity);
            }
        }
    }

    private static NodeRecord? RegistryLookupPlain(Dictionary<ISymbol, NodeRecord> registry, ISymbol symbol)
    {
        if (registry.TryGetValue(symbol, out var hit))
        {
            return hit;
        }

        var original = symbol.OriginalDefinition;
        return !SymbolEqualityComparer.Default.Equals(original, symbol) && registry.TryGetValue(original, out var originalHit)
            ? originalHit
            : null;
    }

    private static bool IsController(INamedTypeSymbol? classSymbol, string qualifiedName)
    {
        if (qualifiedName.EndsWith("Controller", StringComparison.Ordinal))
        {
            return true;
        }

        var baseType = classSymbol?.BaseType;
        while (baseType is not null)
        {
            var display = baseType.OriginalDefinition.ToDisplayString();
            if (display is "Microsoft.AspNetCore.Mvc.ControllerBase" or "Microsoft.AspNetCore.Mvc.Controller")
            {
                return true;
            }

            baseType = baseType.BaseType;
        }

        return false;
    }

    private static List<AttributeMatch> FindVerbAttributes(SyntaxList<AttributeListSyntax> attributeLists, SemanticModel model)
    {
        var matches = new List<AttributeMatch>();
        foreach (var attribute in attributeLists.SelectMany(list => list.Attributes))
        {
            var simpleName = AttributeSimpleName(attribute.Name);
            if (!VerbAttributeNames.TryGetValue(simpleName, out var verb))
            {
                continue;
            }

            var semantic = IsAspNetMvcAttribute(attribute, model, $"{AspNetMvcNamespace}.{simpleName}Attribute");
            var template = FirstPositionalConstantString(attribute, model);
            matches.Add(new AttributeMatch(attribute, simpleName, semantic, template, verb));
        }

        return matches;
    }

    private static AttributeMatch? FindAttribute(
        SyntaxList<AttributeListSyntax> attributeLists,
        SemanticModel model,
        string semanticDisplay,
        HashSet<string> simpleNames)
    {
        foreach (var attribute in attributeLists.SelectMany(list => list.Attributes))
        {
            var simpleName = AttributeSimpleName(attribute.Name);
            if (!simpleNames.Contains(simpleName))
            {
                continue;
            }

            var semantic = IsAspNetMvcAttribute(attribute, model, semanticDisplay);
            var template = FirstPositionalConstantString(attribute, model);
            return new AttributeMatch(attribute, simpleName, semantic, template, null);
        }

        return null;
    }

    private static string AttributeSimpleName(NameSyntax name) => name switch
    {
        SimpleNameSyntax simple => simple.Identifier.ValueText,
        QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
        AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
        _ => name.ToString(),
    };

    private static bool IsAspNetMvcAttribute(AttributeSyntax attribute, SemanticModel model, string expectedDisplay)
    {
        var info = model.GetSymbolInfo(attribute);
        return info.Symbol is IMethodSymbol ctor &&
               ctor.ContainingType.OriginalDefinition.ToDisplayString() == expectedDisplay;
    }

    private static string? FirstPositionalConstantString(AttributeSyntax attribute, SemanticModel model)
    {
        var first = attribute.ArgumentList?.Arguments
            .FirstOrDefault(a => a.NameEquals is null && a.NameColon is null);
        if (first is null)
        {
            return null;
        }

        var value = model.GetConstantValue(first.Expression);
        return value.HasValue && value.Value is string text ? text : null;
    }

    private static string ComposeTemplate(string classTemplate, string methodTemplate, string controllerName, string actionName)
    {
        // ASP.NET kuralı: '~/...' metot kalıbı sınıf kalıbını EZER.
        if (methodTemplate.StartsWith("~/", StringComparison.Ordinal))
        {
            return NormalizeTemplate(methodTemplate.Substring(2), controllerName, actionName);
        }

        var parts = new[] { classTemplate.Trim('/'), methodTemplate.Trim('/') }
            .Where(p => p.Length > 0);
        return NormalizeTemplate(string.Join("/", parts), controllerName, actionName);
    }

    private static string NormalizeTemplate(string template, string controllerName, string actionName)
    {
        var controllerBaseName = controllerName.EndsWith("Controller", StringComparison.Ordinal)
            ? controllerName.Substring(0, controllerName.Length - "Controller".Length)
            : controllerName;

        var replaced = template
            .Replace("[controller]", controllerBaseName, StringComparison.OrdinalIgnoreCase)
            .Replace("[action]", actionName, StringComparison.OrdinalIgnoreCase);

        // "[area]" bu dilimde çözülemez — olduğu gibi kalır (PROTOCOL.md belgeli).
        var collapsed = Regex.Replace(replaced, "/{2,}", "/").Trim('/');
        return "/" + collapsed;
    }

    /* ------------------------------------------------------------------ */
    /* Kanıt                                                               */
    /* ------------------------------------------------------------------ */

    private static EvidenceOut SpanEvidence(SourceEntry entry, SyntaxNode node, string kind, string rationale)
    {
        var lineSpan = entry.Tree.GetLineSpan(node.Span);
        return new EvidenceOut
        {
            Kind = kind,
            Span = new SpanOut
            {
                RelativePath = entry.RelativePath,
                StartLine = lineSpan.StartLinePosition.Line + 1,
                EndLine = lineSpan.EndLinePosition.Line + 1,
                SourceHash = entry.SourceHash,
            },
            AnalyzerId = ProtocolConstants.AnalyzerId,
            AnalyzerVersion = ProtocolConstants.AnalyzerVersion,
            Rationale = rationale,
        };
    }
}
