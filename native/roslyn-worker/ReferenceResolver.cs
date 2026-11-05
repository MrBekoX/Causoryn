using System.Text.RegularExpressions;

namespace Causoryn.RoslynWorker;

/**
 * Derleme referans çözücü — worker'ın bellek-içi derlemesine BCL ve
 * ASP.NET Core "ref assembly" kümelerini bağlar (TŞ §7: Roslyn sidecar,
 * ASP.NET Core L3).
 *
 * Strateji (sırayla denenir; bulunanlar toplanır):
 *  1. İstekteki opsiyonel `referenceDirs` (B2 adapter'ının açık verdiği
 *     dizinler — her .dll bir MetadataReference olarak eklenir).
 *  2. DOTNET_ROOT / dotnet host konumundan erişilen kurulum kökü altında:
 *     - packs/Microsoft.NETCore.App.Ref/<sürüm>/ref/netX.Y   (BCL)
 *     - packs/Microsoft.AspNetCore.App.Ref/<sürüm>/ref/netX.Y (ASP.NET Core)
 *  3. Ref pack'ler yoksa çalışma zamanı düşüşü: System.Private.CoreLib
 *     (typeof(object).Assembly) referansı — kaynak-içi semantik çözümleme
 *     çalışmaya devam eder, BCL türetilen tipler çözümsüz kalır ve tanı/
 *     uyarı açıkça raporlanır (graceful degradation).
 *
 * Dosyalar daima sıralı döndürülür (deterministik derleme — aynı girdi
 * aynı semantik sonuç).
 */
public static class ReferenceResolver
{
    private static readonly Regex VersionDirRegex = new("^\\d+\\.\\d+\\.\\d+$", RegexOptions.Compiled);
    private static readonly Regex TfmDirRegex = new("^net(\\d+)\\.(\\d+)$", RegexOptions.Compiled);

    /**
     * Referans DLL yollarını döndürür. `workerTfm` örn. "net10.0".
     * Bulunamayan kaynaklar için `warnings` içine açık not yazılır.
     */
    public static IReadOnlyList<string> Resolve(
        IReadOnlyList<string>? extraDirs,
        string workerTfm,
        ICollection<string> warnings)
    {
        var paths = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var dir in extraDirs ?? Array.Empty<string>())
        {
            if (Directory.Exists(dir))
            {
                AddDlls(dir, paths);
            }
            else
            {
                warnings.Add($"referenceDirs girdisi yok: {dir} (atlandı)");
            }
        }

        var dotnetRoots = CandidateDotNetRoots();
        var bclAdded = TryAddRefPack(dotnetRoots, "Microsoft.NETCore.App.Ref", workerTfm, paths, warnings);
        var aspNetCoreAdded = TryAddRefPack(dotnetRoots, "Microsoft.AspNetCore.App.Ref", workerTfm, paths, warnings);

        if (!bclAdded)
        {
            var coreLib = typeof(object).Assembly.Location;
            if (!string.IsNullOrEmpty(coreLib) && File.Exists(coreLib))
            {
                paths.Add(coreLib);
                warnings.Add(
                    "Microsoft.NETCore.App.Ref pack bulunamadı; çalışma zamanı düşüşü: " +
                    $"yalnızca {Path.GetFileName(coreLib)} referansı eklendi. BCL tiplerinden " +
                    "türeyen semboller çözümsüz kalabilir (kaynak-içi CALLS/CONTAINS etkilenmez).");
            }
        }

        if (!aspNetCoreAdded)
        {
            warnings.Add(
                "Microsoft.AspNetCore.App.Ref pack bulunamadı; controller/minimal API " +
                "öz nitelikleri semantik olarak çözümlenemez — bilinen-ad kuralı ile " +
                "heuristic ROUTES_TO üretilir (TŞ §8 resolution kuralı).");
        }

        return paths.ToList();
    }

    private static IEnumerable<string> CandidateDotNetRoots()
    {
        // 1) Açık ortam değişkeni.
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrEmpty(dotnetRoot) && Directory.Exists(dotnetRoot))
        {
            yield return dotnetRoot;
        }

        // 2) Host binary'si dotnet.exe/dotnet ise kurulum kökü onun ata dizinidir.
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(processPath))
        {
            var dir = Path.GetDirectoryName(processPath);
            var fileName = Path.GetFileName(processPath);
            if (dir is not null &&
                (fileName.Equals("dotnet", StringComparison.OrdinalIgnoreCase) ||
                 fileName.Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase)))
            {
                yield return dir;
            }
        }

        // 3) Bilinen standart kurulum konumları (platform matrisi: TŞ §7).
        var standardRoots = OperatingSystem.IsWindows()
            ? new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet") }
            : new[] { "/usr/share/dotnet", "/usr/lib/dotnet" };
        foreach (var root in standardRoots)
        {
            if (Directory.Exists(root))
            {
                yield return root;
            }
        }
    }

    private static bool TryAddRefPack(
        IEnumerable<string> roots,
        string packName,
        string workerTfm,
        SortedSet<string> paths,
        ICollection<string> warnings)
    {
        foreach (var root in roots)
        {
            var packRoot = Path.Combine(root, "packs", packName);
            if (!Directory.Exists(packRoot))
            {
                continue;
            }

            var versionDir = HighestVersionDir(packRoot);
            if (versionDir is null)
            {
                continue;
            }

            var tfmDir = SelectTfmDir(Path.Combine(packRoot, versionDir, "ref"), workerTfm);
            if (tfmDir is null)
            {
                continue;
            }

            AddDlls(tfmDir, paths);
            warnings.Add($"referans paketi yüklendi: {packName} {versionDir} ({tfmDir})");
            return true;
        }

        return false;
    }

    /** Sürüm dizinleri içinden semantik sürüm sıralamasıyla en yenisini seçer. */
    private static string? HighestVersionDir(string parent)
    {
        if (!Directory.Exists(parent))
        {
            return null;
        }

        string? best = null;
        Version? bestVersion = null;
        foreach (var entry in Directory.EnumerateDirectories(parent))
        {
            var name = Path.GetFileName(entry);
            if (!VersionDirRegex.IsMatch(name) || !Version.TryParse(name, out var version))
            {
                continue;
            }

            if (bestVersion is null || version > bestVersion)
            {
                best = name;
                bestVersion = version;
            }
        }

        return best;
    }

    /**
     * ref/ altından TFM seçimi: önce worker TFM'iyle birebir eşleşme,
     * sonra worker TFM'inden küçük/eşit en yüksek, en sonda en yüksek.
     */
    private static string? SelectTfmDir(string refParent, string workerTfm)
    {
        if (!Directory.Exists(refParent))
        {
            return null;
        }

        var candidates = new List<(string Dir, int Major, int Minor)>();
        foreach (var dir in Directory.EnumerateDirectories(refParent))
        {
            var name = Path.GetFileName(dir);
            var match = TfmDirRegex.Match(name);
            if (!match.Success)
            {
                continue;
            }

            candidates.Add((dir, int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value)));
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        var exact = Path.Combine(refParent, workerTfm);
        if (Directory.Exists(exact))
        {
            return exact;
        }

        var workerMatch = TfmDirRegex.Match(workerTfm);
        int workerMajor = workerMatch.Success ? int.Parse(workerMatch.Groups[1].Value) : 0;
        int workerMinor = workerMatch.Success ? int.Parse(workerMatch.Groups[2].Value) : 0;

        var candidatesSorted = candidates
            .OrderByDescending(c => c.Major)
            .ThenByDescending(c => c.Minor)
            .ToList();

        var compatible = candidatesSorted.FirstOrDefault(c => c.Major < workerMajor ||
            (c.Major == workerMajor && c.Minor <= workerMinor));
        return (compatible.Dir ?? candidatesSorted[0].Dir);
    }

    private static void AddDlls(string dir, SortedSet<string> paths)
    {
        foreach (var dll in Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly))
        {
            paths.Add(dll);
        }
    }
}
