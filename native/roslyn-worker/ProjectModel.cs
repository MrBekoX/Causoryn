using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Causoryn.RoslynWorker;

/** Validated `projects[]` entry (PROTOCOL.md "Projects"). */
internal sealed record ProjectSpec(
    string Path,
    string Directory,
    string AssemblyName,
    IReadOnlyList<GlobalUsingSpec> GlobalUsings,
    IReadOnlyList<string> ProjectReferences);

/** One generated `global using` directive. */
internal sealed record GlobalUsingSpec(string Name, string? Alias, bool IsStatic);

/**
 * MSBuild project model of an analyze request.
 *
 * The adapter evaluates `.csproj` / `Directory.Build.props` files (read-only,
 * inside the workspace) and sends the result; this class only validates it and
 * turns it into compilation units:
 * - a source file belongs to the project whose directory is its nearest
 *   ancestor (MSBuild default compile globbing of SDK-style projects);
 * - every project is compiled separately, so global usings, entry points and
 *   duplicate type names of one project never leak into another;
 * - ProjectReference edges (and their transitive closure, the SDK default) become
 *   compilation references; a cycle is broken deterministically with a warning;
 * - the SDK's implicit global usings are added as one synthetic in-memory tree per
 *   project, generated from validated identifiers only (no free-form code).
 *
 * Determinism: projects, global usings and references are sorted ordinally.
 */
internal static class ProjectModel
{
    /** Assembly name of the compilation that holds the files outside every project. */
    public const string LooseAssemblyName = "CausorynWorker.Analysis";

    private const string ProjectExtension = ".csproj";
    private const int MaxDottedNameLength = 512;

    /** One C# identifier (optionally verbatim `@`); linear, anchored character classes only. `\z`, not `$`: `$` also matches before a trailing newline. */
    private static readonly Regex IdentifierPattern = new(
        @"^@?[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*\z",
        RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    private static readonly Regex AssemblyNamePattern = new(
        @"^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,255}\z",
        RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    public static IReadOnlyList<ProjectSpec> Validate(List<ProjectIn>? projects, List<string> warnings)
    {
        if (projects is null || projects.Count == 0)
        {
            return Array.Empty<ProjectSpec>();
        }

        if (projects.Count > ProtocolConstants.MaxProjectCount)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.LimitExceeded,
                $"project count limit exceeded: {projects.Count.ToString(CultureInfo.InvariantCulture)} > {ProtocolConstants.MaxProjectCount.ToString(CultureInfo.InvariantCulture)}");
        }

        var specs = new List<ProjectSpec>();
        var seenPaths = new HashSet<string>(StringComparer.Ordinal);
        var directoryOwner = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var project in projects)
        {
            if (project.ExtensionData is { Count: > 0 })
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects[] entry contains unknown field(s): {string.Join(", ", project.ExtensionData.Keys)}");
            }

            if (string.IsNullOrEmpty(project.Path))
            {
                throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, "projects[] entry requires the 'path' field");
            }

            var path = NormalizeProjectPath(project.Path, "projects[].path");
            if (!seenPaths.Add(path))
            {
                throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, $"The same project path was given twice: {path}");
            }

            var slash = path.LastIndexOf('/');
            var directory = slash < 0 ? string.Empty : path.Substring(0, slash);
            if (directoryOwner.TryGetValue(directory, out var otherPath))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects '{otherPath}' and '{path}' share the directory '{directory}'; only one project per directory is supported");
            }

            directoryOwner.Add(directory, path);

            if (project.AssemblyName is not null && !AssemblyNamePattern.IsMatch(project.AssemblyName))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects[].assemblyName is not a valid assembly name: {project.AssemblyName}");
            }

            specs.Add(new ProjectSpec(
                path,
                directory,
                project.AssemblyName ?? string.Empty,
                ValidateGlobalUsings(project.GlobalUsings, path, warnings),
                ValidateProjectReferences(project.ProjectReferences, path)));
        }

        specs.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
        return AssignAssemblyNames(specs, warnings);
    }

    /** Path of the project whose directory is the nearest ancestor of a source file; null when none. */
    public static string? OwningProject(string relativePath, IReadOnlyDictionary<string, ProjectSpec> projectByDirectory)
    {
        var directory = relativePath;
        while (true)
        {
            var slash = directory.LastIndexOf('/');
            directory = slash < 0 ? string.Empty : directory.Substring(0, slash);
            if (projectByDirectory.TryGetValue(directory, out var project))
            {
                return project.Path;
            }

            if (directory.Length == 0)
            {
                return null;
            }
        }
    }

    /**
     * Dependency-first compilation order of the projects that own sources, plus
     * each project's transitive ProjectReference closure. References to projects
     * outside the request are skipped with a warning; references to projects
     * without analyzed sources are skipped silently (nothing to compile). A
     * reference that closes a cycle is ignored with an explicit warning.
     */
    public static List<ProjectSpec> CompilationOrder(
        IReadOnlyList<ProjectSpec> projectsWithSources,
        IReadOnlySet<string> requestedProjectPaths,
        List<string> warnings,
        out Dictionary<string, List<string>> referenceClosure)
    {
        var byPath = projectsWithSources.ToDictionary(p => p.Path, StringComparer.Ordinal);
        var directReferences = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var project in projectsWithSources)
        {
            var kept = new List<string>();
            foreach (var reference in project.ProjectReferences)
            {
                if (byPath.ContainsKey(reference))
                {
                    kept.Add(reference);
                }
                else if (!requestedProjectPaths.Contains(reference))
                {
                    warnings.Add($"ProjectReference '{reference}' of project '{project.Path}' is not part of the analysis set; skipped");
                }
            }

            directReferences[project.Path] = kept;
        }

        var order = new List<ProjectSpec>();
        var state = new Dictionary<string, int>(StringComparer.Ordinal);
        var acyclicReferences = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        void Visit(string path)
        {
            state[path] = 1;
            var kept = new List<string>();
            foreach (var reference in directReferences[path])
            {
                state.TryGetValue(reference, out var referenceState);
                if (referenceState == 1)
                {
                    warnings.Add($"ProjectReference cycle: the reference from '{path}' to '{reference}' was ignored");
                    continue;
                }

                if (referenceState == 0)
                {
                    Visit(reference);
                }

                kept.Add(reference);
            }

            acyclicReferences[path] = kept;
            state[path] = 2;
            order.Add(byPath[path]);
        }

        foreach (var project in projectsWithSources)
        {
            if (!state.ContainsKey(project.Path))
            {
                Visit(project.Path);
            }
        }

        referenceClosure = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var project in order)
        {
            var closure = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var reference in acyclicReferences[project.Path])
            {
                closure.Add(reference);
                closure.UnionWith(referenceClosure[reference]);
            }

            referenceClosure[project.Path] = closure.ToList();
        }

        return order;
    }

    /** Synthetic tree path of a project's generated global usings (never emitted as a File node). */
    public static string GlobalUsingsPath(ProjectSpec project) => project.Path + ".GlobalUsings.g.cs";

    /** C# text of the generated global usings; inputs are validated identifiers only. */
    public static string GlobalUsingsSource(IReadOnlyList<GlobalUsingSpec> usings)
    {
        var builder = new StringBuilder("// <auto-generated/>\n");
        foreach (var directive in usings)
        {
            if (directive.Alias is not null)
            {
                builder.Append("global using ").Append(directive.Alias).Append(" = global::").Append(directive.Name).Append(";\n");
            }
            else if (directive.IsStatic)
            {
                builder.Append("global using static global::").Append(directive.Name).Append(";\n");
            }
            else
            {
                builder.Append("global using global::").Append(directive.Name).Append(";\n");
            }
        }

        return builder.ToString();
    }

    /**
     * Validates the global usings of one project. The schema stays strict (an
     * unknown field, or more than MaxGlobalUsingsPerProject entries, rejects
     * the request), but an entry whose content cannot be a global using (not a
     * dotted C# name, an alias that is not one identifier, static together with
     * an alias) is dropped with a warning (security finding F22, round 2): one
     * such entry must not make the whole request fail, which would drop every
     * C# file of the workspace to file-level facts. A dropped entry never
     * reaches the generated global usings tree.
     */
    private static IReadOnlyList<GlobalUsingSpec> ValidateGlobalUsings(List<GlobalUsingIn>? usings, string projectPath, List<string> warnings)
    {
        if (usings is null || usings.Count == 0)
        {
            return Array.Empty<GlobalUsingSpec>();
        }

        if (usings.Count > ProtocolConstants.MaxGlobalUsingsPerProject)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.LimitExceeded,
                $"global using limit exceeded for project {projectPath}: {usings.Count.ToString(CultureInfo.InvariantCulture)} > {ProtocolConstants.MaxGlobalUsingsPerProject.ToString(CultureInfo.InvariantCulture)}");
        }

        var unique = new HashSet<GlobalUsingSpec>();
        var skipped = 0;
        foreach (var item in usings)
        {
            if (item.ExtensionData is { Count: > 0 })
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects[].globalUsings[] entry contains unknown field(s): {string.Join(", ", item.ExtensionData.Keys)}");
            }

            if (item.Name is null)
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects[].globalUsings[] entry requires the 'name' field (project {projectPath})");
            }

            if (!IsDottedName(item.Name))
            {
                Skip($"global using '{Snippet(item.Name)}' of project '{projectPath}' was skipped: it is not a dotted C# name");
                continue;
            }

            if (item.Alias is not null && !IdentifierPattern.IsMatch(item.Alias))
            {
                Skip($"global using '{Snippet(item.Name)}' of project '{projectPath}' was skipped: it has an alias that is not a C# identifier ('{Snippet(item.Alias)}')");
                continue;
            }

            var isStatic = item.Static == true;
            if (isStatic && item.Alias is not null)
            {
                Skip($"global using '{Snippet(item.Name)}' of project '{projectPath}' was skipped: it is both static and aliased");
                continue;
            }

            unique.Add(new GlobalUsingSpec(item.Name, item.Alias, isStatic));
        }

        // One detailed warning per project, then a count: the warnings stay
        // bounded however many entries a project model carries.
        if (skipped > 1)
        {
            warnings.Add($"{(skipped - 1).ToString(CultureInfo.InvariantCulture)} further global usings of project '{projectPath}' were skipped for the same kinds of reasons");
        }

        void Skip(string detail)
        {
            if (skipped == 0)
            {
                warnings.Add(detail);
            }

            skipped += 1;
        }

        static int Rank(GlobalUsingSpec spec) => spec.Alias is not null ? 2 : spec.IsStatic ? 1 : 0;
        return unique
            .OrderBy(Rank)
            .ThenBy(spec => spec.Name, StringComparer.Ordinal)
            .ThenBy(spec => spec.Alias ?? string.Empty, StringComparer.Ordinal)
            .ToList();
    }

    private static IReadOnlyList<string> ValidateProjectReferences(List<string>? references, string projectPath)
    {
        if (references is null || references.Count == 0)
        {
            return Array.Empty<string>();
        }

        if (references.Count > ProtocolConstants.MaxProjectReferencesPerProject)
        {
            throw new ProtocolException(
                ProtocolErrorCodes.LimitExceeded,
                $"project reference limit exceeded for project {projectPath}: {references.Count.ToString(CultureInfo.InvariantCulture)} > {ProtocolConstants.MaxProjectReferencesPerProject.ToString(CultureInfo.InvariantCulture)}");
        }

        var normalized = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var reference in references)
        {
            if (string.IsNullOrEmpty(reference))
            {
                throw new ProtocolException(
                    ProtocolErrorCodes.InvalidArgument,
                    $"projects[].projectReferences[] entry must not be empty (project {projectPath})");
            }

            var path = NormalizeProjectPath(reference, "projects[].projectReferences[]");
            if (!string.Equals(path, projectPath, StringComparison.Ordinal))
            {
                normalized.Add(path);
            }
        }

        return normalized.ToList();
    }

    private static List<ProjectSpec> AssignAssemblyNames(List<ProjectSpec> specs, List<string> warnings)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { LooseAssemblyName };
        var result = new List<ProjectSpec>(specs.Count);
        for (var index = 0; index < specs.Count; index += 1)
        {
            var spec = specs[index];
            var name = spec.AssemblyName;
            if (name.Length == 0)
            {
                var fileName = spec.Path.Substring(spec.Path.LastIndexOf('/') + 1);
                var stem = fileName.Substring(0, fileName.Length - ProjectExtension.Length);
                name = AssemblyNamePattern.IsMatch(stem)
                    ? stem
                    : $"CausorynWorker.Project{index.ToString(CultureInfo.InvariantCulture)}";
            }

            if (!used.Add(name))
            {
                var suffix = 2;
                var candidate = $"{name}.{suffix.ToString(CultureInfo.InvariantCulture)}";
                while (!used.Add(candidate))
                {
                    suffix += 1;
                    candidate = $"{name}.{suffix.ToString(CultureInfo.InvariantCulture)}";
                }

                warnings.Add($"assembly name '{name}' of project '{spec.Path}' is already used in this analysis; compiled as '{candidate}'");
                name = candidate;
            }

            result.Add(spec with { AssemblyName = name });
        }

        return result;
    }

    private const int MaxSnippetLength = 160;

    /** Request text quoted in a warning: control characters flattened, length capped (no surrogate pair split). */
    private static string Snippet(string value)
    {
        var builder = new StringBuilder(Math.Min(value.Length, MaxSnippetLength));
        foreach (var ch in value)
        {
            if (builder.Length >= MaxSnippetLength)
            {
                if (char.IsHighSurrogate(builder[^1]))
                {
                    builder.Length -= 1;
                }

                return builder.Append("...").ToString();
            }

            builder.Append(char.IsControl(ch) ? ' ' : ch);
        }

        return builder.ToString();
    }

    private static bool IsDottedName(string name)
    {
        if (name.Length == 0 || name.Length > MaxDottedNameLength)
        {
            return false;
        }

        foreach (var segment in name.Split('.'))
        {
            if (!IdentifierPattern.IsMatch(segment))
            {
                return false;
            }
        }

        return true;
    }

    private static string NormalizeProjectPath(string raw, string field)
    {
        var posix = raw.Replace('\\', '/');
        if (posix.StartsWith('/') || (posix.Length >= 2 && posix[1] == ':' && char.IsAsciiLetter(posix[0])))
        {
            throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, $"{field}: absolute project paths are not accepted: {raw}");
        }

        foreach (var segment in posix.Split('/'))
        {
            if (segment.Length == 0 || segment == ".")
            {
                throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, $"{field}: project path contains an empty or invalid segment: {raw}");
            }

            if (segment == "..")
            {
                throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, $"{field}: project path escapes the workspace root: {raw}");
            }
        }

        var fileName = posix.Substring(posix.LastIndexOf('/') + 1);
        if (fileName.Length <= ProjectExtension.Length || !fileName.EndsWith(ProjectExtension, StringComparison.OrdinalIgnoreCase))
        {
            throw new ProtocolException(ProtocolErrorCodes.InvalidArgument, $"{field}: project path must name a .csproj file: {raw}");
        }

        return posix;
    }
}
