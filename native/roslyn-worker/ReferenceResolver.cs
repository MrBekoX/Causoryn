using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;

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
    private const int MaxExtraReferenceDirs = 64;
    private const int MaxExtraReferenceDlls = 512;

    // Smallest possible PE image (DOS header + PE signature + COFF header);
    // anything smaller, including FIFOs and other zero-length entries, is
    // never opened.
    private const long MinReferenceDllBytes = 128;
    private const long MaxExtraReferenceDllBytes = 64L * 1024 * 1024;

    /**
     * Creates one MetadataReference per path. A file that cannot be opened or
     * read (removed, locked, no permission, invalid image) is skipped with an
     * explicit warning; it never fails the whole analysis.
     */
    public static List<MetadataReference> LoadMetadataReferences(
        IReadOnlyList<string> referencePaths,
        ICollection<string> warnings)
    {
        var references = new List<MetadataReference>(referencePaths.Count);
        foreach (var path in referencePaths)
        {
            try
            {
                references.Add(MetadataReference.CreateFromFile(path));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or BadImageFormatException
                or NotSupportedException or ArgumentException or System.Security.SecurityException)
            {
                warnings.Add(
                    $"reference '{Path.GetFileName(path)}' could not be loaded and was skipped ({ex.GetType().Name})");
            }
        }

        return references;
    }

    /**
     * Referans DLL yollarını döndürür. `workerTfm` örn. "net10.0".
     * Bulunamayan veya güvensiz (UNC/symlink) kaynaklar için `warnings` içine açık not yazılır.
     */
    public static IReadOnlyList<string> Resolve(
        IReadOnlyList<string>? extraDirs,
        string workerTfm,
        ICollection<string> warnings)
    {
        var paths = new SortedSet<string>(StringComparer.Ordinal);
        var seenFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var dotnetRoots = CandidateDotNetRoots(warnings).ToList();
        var bclAdded = TryAddRefPack(dotnetRoots, "Microsoft.NETCore.App.Ref", workerTfm, paths, seenFileNames, warnings);
        var aspNetCoreAdded = TryAddRefPack(dotnetRoots, "Microsoft.AspNetCore.App.Ref", workerTfm, paths, seenFileNames, warnings);

        if (!bclAdded)
        {
            var coreLib = typeof(object).Assembly.Location;
            if (!string.IsNullOrEmpty(coreLib) && File.Exists(coreLib))
            {
                paths.Add(coreLib);
                seenFileNames.Add(Path.GetFileName(coreLib));
                warnings.Add(
                    "Microsoft.NETCore.App.Ref pack not found; runtime fallback: " +
                    $"only the {Path.GetFileName(coreLib)} reference was added. Symbols derived " +
                    "from BCL types may stay unresolved (in-source CALLS/CONTAINS are not affected).");
            }
        }

        if (!aspNetCoreAdded)
        {
            warnings.Add(
                "Microsoft.AspNetCore.App.Ref pack not found; controller/minimal API " +
                "attributes cannot be resolved semantically — heuristic ROUTES_TO " +
                "edges are produced by the known-name rule.");
        }

        if (extraDirs is { Count: > 0 })
        {
            var processedDirs = 0;
            var addedExtraDlls = 0;
            foreach (var rawDir in extraDirs)
            {
                if (processedDirs >= MaxExtraReferenceDirs)
                {
                    warnings.Add($"referenceDirs limit ({MaxExtraReferenceDirs}) exceeded; remaining entries skipped");
                    break;
                }

                if (string.IsNullOrWhiteSpace(rawDir) || rawDir.Contains('\0'))
                {
                    warnings.Add("invalid empty/null-byte referenceDirs entry skipped");
                    continue;
                }

                var dir = rawDir.Trim();
                // Lexical UNC/device (all 4 slash combinations) and non-fully-qualified rejection
                // BEFORE any filesystem call (prevents SMB/NTLM leak and rejects drive-relative paths).
                if (IsUncOrDevicePath(dir) || !Path.IsPathFullyQualified(dir))
                {
                    warnings.Add($"unsafe or relative referenceDirs entry rejected: {dir}");
                    continue;
                }

                // Strip non-root trailing separators so GetFileAttributesEx / lstat inspects
                // the link entry itself rather than traversing through a trailing-slash symlink.
                var normalizedDir = TrimTrailingDirectorySeparators(dir);

                // Ancestors are inspected from the root down before the entry itself, so an
                // ancestor link to a remote (UNC/device) target is never traversed.
                bool remoteAncestor;
                try
                {
                    remoteAncestor = HasRemoteLinkedAncestor(normalizedDir);
                }
                catch
                {
                    warnings.Add($"referenceDirs entry could not be verified: {dir} (skipped)");
                    continue;
                }

                if (remoteAncestor)
                {
                    warnings.Add($"referenceDirs entry rejected: an ancestor directory links to a remote or device path: {dir}");
                    continue;
                }

                // Check symlink/reparse-point BEFORE Directory.Exists so a symlinked directory
                // pointing to a UNC share is never traversed.
                try
                {
                    var dirInfo = new DirectoryInfo(normalizedDir);
                    if (IsSymlinkOrReparsePoint(dirInfo))
                    {
                        warnings.Add($"symlink/reparse-point referenceDirs entry rejected: {dir}");
                        continue;
                    }

                    if (dirInfo.Attributes == (FileAttributes)(-1) || !Directory.Exists(normalizedDir))
                    {
                        warnings.Add($"referenceDirs entry does not exist: {dir} (skipped)");
                        continue;
                    }
                }
                catch
                {
                    warnings.Add($"referenceDirs entry could not be verified: {dir} (skipped)");
                    continue;
                }

                processedDirs += 1;
                addedExtraDlls += AddExtraDlls(normalizedDir, paths, seenFileNames, MaxExtraReferenceDlls - addedExtraDlls);
                if (addedExtraDlls >= MaxExtraReferenceDlls)
                {
                    warnings.Add($"referenceDirs DLL limit ({MaxExtraReferenceDlls}) exceeded; remaining DLLs skipped");
                    break;
                }
            }
        }

        return paths.ToList();
    }

    private static bool IsUncOrDevicePath(string path) =>
        path.Length >= 2 &&
        (path[0] == '\\' || path[0] == '/') &&
        (path[1] == '\\' || path[1] == '/');

    /** Link target that would leave the local file system (UNC, device, NT or drive-relative). */
    private static bool IsRemoteLinkTarget(string target) =>
        IsUncOrDevicePath(target) ||
        target.StartsWith(@"\??\", StringComparison.Ordinal) ||
        target.StartsWith(@"UNC\", StringComparison.OrdinalIgnoreCase) ||
        (OperatingSystem.IsWindows() && target.Length >= 2 && target[1] == ':' &&
         (target.Length == 2 || (target[2] != '\\' && target[2] != '/')));

    /**
     * True when a directory between the file system root and `path`
     * (exclusive) is a symbolic link or junction whose target is remote.
     * Components are inspected from the root down, so every link target is
     * read through an already verified local chain and a remote target is
     * never traversed.
     */
    private static bool HasRemoteLinkedAncestor(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full);
        if (string.IsNullOrEmpty(root))
        {
            return false;
        }

        var segments = full[root.Length..]
            .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
        var current = root;
        for (var index = 0; index < segments.Length - 1; index++)
        {
            current = Path.Combine(current, segments[index]);
            var target = new DirectoryInfo(current).LinkTarget;
            if (target is not null && IsRemoteLinkTarget(target))
            {
                return true;
            }
        }

        return false;
    }

    private static string TrimTrailingDirectorySeparators(string path)
    {
        var current = path;
        while (true)
        {
            var next = Path.TrimEndingDirectorySeparator(current);
            if (next.Length == current.Length)
            {
                return current;
            }

            current = next;
        }
    }

    private static bool IsSymlinkOrReparsePoint(FileSystemInfo info)
    {
        var attributes = info.Attributes;
        if (attributes != (FileAttributes)(-1) &&
            (attributes & FileAttributes.ReparsePoint) != 0)
        {
            return true;
        }

        return info.LinkTarget is not null;
    }

    private static bool IsManagedAssembly(string dllPath)
    {
        try
        {
            using var stream = new FileStream(dllPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var peReader = new PEReader(stream);
            return peReader.HasMetadata;
        }
        catch
        {
            return false;
        }
    }

    private static IEnumerable<string> CandidateDotNetRoots(ICollection<string> warnings)
    {
        // 1) Explicit environment variable: only a fully qualified local path is
        //    used; UNC/device and relative values are rejected before any file
        //    system access.
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrEmpty(dotnetRoot))
        {
            var trimmed = dotnetRoot.Trim();
            if (trimmed.Contains('\0') || IsUncOrDevicePath(trimmed) || !Path.IsPathFullyQualified(trimmed))
            {
                warnings.Add("DOTNET_ROOT is not a fully qualified local path and was ignored");
            }
            else if (Directory.Exists(trimmed))
            {
                yield return trimmed;
            }
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
        HashSet<string> seenFileNames,
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

            AddDlls(tfmDir, paths, seenFileNames);
            warnings.Add($"reference pack loaded: {packName} {versionDir} ({tfmDir})");
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

    private static void AddDlls(string dir, SortedSet<string> paths, HashSet<string> seenFileNames)
    {
        foreach (var dll in Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly))
        {
            if (paths.Add(dll))
            {
                seenFileNames.Add(Path.GetFileName(dll));
            }
        }
    }

    private static int AddExtraDlls(
        string dir,
        SortedSet<string> paths,
        HashSet<string> seenFileNames,
        int remainingBudget)
    {
        if (remainingBudget <= 0)
        {
            return 0;
        }

        var added = 0;
        IEnumerable<string> dlls;
        try
        {
            dlls = Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly)
                .OrderBy(p => p, StringComparer.Ordinal);
        }
        catch
        {
            return 0;
        }

        foreach (var dll in dlls)
        {
            if (added >= remainingBudget)
            {
                break;
            }

            var fileName = Path.GetFileName(dll);
            if (seenFileNames.Contains(fileName))
            {
                continue;
            }

            try
            {
                var fileInfo = new FileInfo(dll);
                if (IsSymlinkOrReparsePoint(fileInfo))
                {
                    continue;
                }

                // Zero-length entries (FIFOs, sockets, empty files) are never
                // opened: opening a FIFO would block the worker.
                if (fileInfo.Length < MinReferenceDllBytes || fileInfo.Length > MaxExtraReferenceDllBytes)
                {
                    continue;
                }
            }
            catch
            {
                continue;
            }

            if (!IsManagedAssembly(dll))
            {
                continue;
            }

            if (paths.Add(dll))
            {
                seenFileNames.Add(fileName);
                added += 1;
            }
        }

        return added;
    }
}
