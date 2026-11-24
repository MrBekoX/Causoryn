using System.Text;
using System.Text.Json;

namespace Causoryn.RoslynWorker;

/**
 * Giriş noktası — satır-bazlı stdin/stdout JSON protokol döngüsü.
 *
 * Kırmızı çizgi (proje sözleşmesi 4): stdout'ta YALNIZCA protokol satırları
 * taşınır; her log satırı Console.Error (stderr) üzerinden yazılır. Girdi/
 * çıktı kodlaması BOM'suz UTF-8'dir; her yanıt tek satırdır (JSON içindeki
 * yeni satırlar serileştirici tarafından \n olarak kaçırılır).
 *
 * Hata davranışı: bozuk JSON / doğrulama hatası → status:"error" yanıtı ve
 * döngü DEVAM EDER; yalnızca stdout/stdin'in kendisi kırılırsa süreç çıkar.
 * Çıkış kodu: 0 = normal EOF, 1 = kablo hatası (çıktı yazılamadı).
 *
 * Stack savunması (denetim bulgusu düzeltmesi): StackOverflowException
 * .NET'te yakalanamaz ve süreci öldürür; Roslyn parse/gezinme derin iç içe
 * AST'lerde stack tüketir. Ana döngü, geniş stack'li ayrı bir thread'de
 * koşar (WorkerAnalyzer'ın MAX_TRAVERSAL_DEPTH sert sınırıyla birlikte
 * iki katmanlı savunma — çöküş kanıtı: eski binary 5000 katmanlı ifadede
 * 0xC00000FD STATUS_STACK_OVERFLOW ile ölmüştü).
 */
public static class Program
{
    /** RunLoop çıkış kodu; Join sonrası tek okuma — yarış yok. */
    private static int _loopExitCode = 1;

    public static int Main()
    {
        // 256 MB: Roslyn guard'lı derinlik istisnası (InsufficientExecutionStackException)
        // fırlatmadan önce mümkün olduğunca derine inmeye çalışır; büyük stack
        // makul derinliklerde istisnasız çalışmayı sağlar, üstünde ise worker
        // yakalanabilir istisnayı ADAPTER_INTERNAL tanısına çevirir (WorkerAnalyzer).
        var loopThread = new Thread(RunLoopThread, maxStackSize: 256 * 1024 * 1024);
        loopThread.Start();
        loopThread.Join();
        return _loopExitCode;
    }

    private static void RunLoopThread()
    {
        _loopExitCode = RunLoop();
    }

    private static int RunLoop()
    {
        using var stdout = Console.OpenStandardOutput();
        using var writer = new StreamWriter(stdout, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        {
            AutoFlush = true,
            NewLine = "\n",
        };

        using var stdin = Console.OpenStandardInput();
        using var reader = new StreamReader(stdin, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        var lineReader = new LimitedLineReader(reader);

        Log($"worker started — protocol v{ProtocolConstants.ProtocolVersion}, analyzer {ProtocolConstants.AnalyzerId} v{ProtocolConstants.AnalyzerVersion}");

        try
        {
            while (true)
            {
                var line = lineReader.ReadLine(out var exceededLimit);
                if (exceededLimit)
                {
                    // Satır sınırı aşımı: satır içerikle işlenmez; id:null +
                    // LIMIT_EXCEEDED yanıtı yazılır ve döngü devam eder.
                    var limitResponse = Error(
                        null,
                        ProtocolErrorCodes.LimitExceeded,
                        $"request line exceeded the {ProtocolConstants.MaxRequestLineChars:N0} character limit; line skipped");
                    writer.WriteLine(JsonSerializer.Serialize(limitResponse, ProtocolJson.Options));
                    Log("request line limit exceeded — line skipped");
                    continue;
                }

                if (line is null)
                {
                    break; // EOF
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue; // sessiz satır atlanır (protokol gereği mesaj tek satır JSON)
                }

                var response = HandleLine(line);
                writer.WriteLine(JsonSerializer.Serialize(response, ProtocolJson.Options));
                Log($"request processed: id={DescribeId(response.Id)} status={response.Status}");
            }
        }
        catch (IOException ex)
        {
            Log($"wire error, worker exiting: {ex.Message}");
            return 1;
        }

        Log("stdin EOF — worker shutting down");
        return 0;
    }

    /**
     * Boyut sınırlı satır okuyucu (bulgu: sınırsız ReadLine OOM çöküşü
     * üretebilir). Parça-parça okur; MaxRequestLineChars aşılırsa satırı
     * DISCARD eder (newline'a kadar), exceededLimit=true döner. Buffer
     * durumu (kalan char'lar) çağrılar arasında INSTANCE alanında taşınır —
     * aksi halde tek Read turunda gelen birden çok satır kaybolur ('\n'
     * anında erken dönüş, kalanı düşürür). '\r' atlanır (CRLF tolere;
     * JSON string içindeki CR zaten \r kaçışlıdır).
     */
    private sealed class LimitedLineReader
    {
        private readonly TextReader _reader;
        private readonly char[] _buffer = new char[8192];
        private int _bufferIndex;
        private int _bufferLength;

        public LimitedLineReader(TextReader reader)
        {
            _reader = reader;
        }

        public string? ReadLine(out bool exceededLimit)
        {
            exceededLimit = false;
            var builder = new StringBuilder();
            var discarding = false;

            while (true)
            {
                if (_bufferIndex >= _bufferLength)
                {
                    _bufferLength = _reader.Read(_buffer, 0, _buffer.Length);
                    _bufferIndex = 0;
                    if (_bufferLength == 0)
                    {
                        // EOF: newline'sız kalıntı varsa son satırdır.
                        if (discarding)
                        {
                            exceededLimit = true;
                            return null;
                        }

                        return builder.Length == 0 ? null : builder.ToString();
                    }
                }

                var ch = _buffer[_bufferIndex++];
                if (ch == '\n')
                {
                    if (discarding)
                    {
                        exceededLimit = true;
                        return null;
                    }

                    var line = builder.ToString();
                    builder.Clear();
                    return line;
                }

                if (ch == '\r')
                {
                    continue;
                }

                if (!discarding)
                {
                    builder.Append(ch);
                    if (builder.Length > ProtocolConstants.MaxRequestLineChars)
                    {
                        discarding = true;
                        builder.Clear();
                    }
                }
            }
        }
    }

    private static WorkerResponse HandleLine(string line)
    {
        try
        {
            var request = JsonSerializer.Deserialize<WorkerRequest>(line, ProtocolJson.Options)
                ?? throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, "request JSON must not be empty");

            if (request.Type != "analyze")
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"unknown request type: '{request.Type}' (supported: 'analyze')");
            }

            return WorkerAnalyzer.Analyze(request);
        }
        catch (ProtocolException ex)
        {
            return Error(TryExtractId(line), ex.Code, ex.Message);
        }
        catch (JsonException ex)
        {
            return Error(TryExtractId(line), ProtocolErrorCodes.InvalidArgument, $"request JSON could not be parsed: {ex.Message}");
        }
        catch (Exception ex)
        {
            Log($"beklenmeyen hata: {ex}");
            return Error(
                TryExtractId(line),
                ProtocolErrorCodes.InternalError,
                "unexpected error inside the worker (see the stderr log)");
        }
    }

    private static WorkerResponse Error(JsonElement? id, string code, string message) => new()
    {
        Id = id,
        Status = "error",
        Error = new ErrorOut { Code = code, Message = message },
    };

    /** Bozuk satırlarda bile istemciye echo yapılabilecek 'id' alanını kurtarır. */
    private static JsonElement? TryExtractId(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                   document.RootElement.TryGetProperty("id", out var id)
                ? id.Clone()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string DescribeId(JsonElement? id) => id switch
    {
        null => "(none)",
        { ValueKind: JsonValueKind.String } element => element.GetString() ?? "(empty)",
        _ => id.Value.GetRawText(),
    };

    private static void Log(string message) => Console.Error.WriteLine($"[roslyn-worker] {message}");
}
