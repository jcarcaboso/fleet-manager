using System.Text.RegularExpressions;

namespace Fleet.Tests;

/// <summary>
/// Keeps the Server namespaces in the order the module map in docs/technical-design/extending-fleet.md describes.
/// A namespace may use the namespaces listed for it here and nothing else in Fleet.Server, so no cycle can come back.
/// </summary>
public sealed partial class ModuleBoundaryTests
{
    private static readonly Dictionary<string, string[]> Allowed = new(StringComparer.Ordinal)
    {
        ["Http"] = [],
        ["Metrics"] = [],
        ["Persistence"] = [],
        ["Security"] = ["Http", "Metrics", "Persistence"],
        ["Source"] = ["Metrics", "Persistence", "Security"],
        ["AgentReleases"] = ["Http", "Security"],
        ["CliProxy"] = ["Persistence", "Security", "Source"],
        ["Transport"] = ["AgentReleases", "CliProxy", "Http", "Metrics", "Persistence", "Security", "Source"],
        ["Dashboard"] = ["Http", "Persistence", "Security", "Source", "Transport"],
        ["Hosting"] = ["AgentReleases", "CliProxy", "Dashboard", "Http", "Metrics", "Persistence", "Security", "Source", "Transport"],
    };

    [Fact]
    public void Server_namespaces_use_only_the_namespaces_the_module_map_allows()
    {
        var server = FindUpwards("server/Fleet.Server");
        Assert.NotNull(server);
        var violations = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var folder in Directory.GetDirectories(server).Select(Path.GetFileName).OfType<string>().Where(name => name is not ("bin" or "obj")))
        {
            Assert.True(Allowed.TryGetValue(folder, out var allowed), $"Add the new folder {folder} to the module map and to this test.");
            seen.Add(folder);
            foreach (var file in Directory.EnumerateFiles(Path.Combine(server, folder), "*.cs", SearchOption.AllDirectories))
                foreach (Match match in ServerNamespace().Matches(File.ReadAllText(file)))
                {
                    var used = match.Groups[1].Value;
                    if (used != folder && !allowed.Contains(used, StringComparer.Ordinal))
                        violations.Add($"{folder} must not use {used} ({Path.GetRelativePath(server, file)})");
                }
        }
        Assert.Empty(violations.Distinct());
        Assert.Equal(Allowed.Keys.Order(StringComparer.Ordinal), seen.Order(StringComparer.Ordinal));
    }

    private static string? FindUpwards(string relative)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, relative);
            if (Directory.Exists(candidate)) return candidate;
        }
        return null;
    }

    // Any mention counts, a using line or a qualified name.
    [GeneratedRegex(@"\bFleet\.Server\.([A-Z][A-Za-z]+)\b")]
    private static partial Regex ServerNamespace();
}
