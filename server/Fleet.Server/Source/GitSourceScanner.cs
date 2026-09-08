using System.Text;
using Fleet.Core.Coordination;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Fleet.Server.Source;

public sealed class GitSourceScanner(
    string remote,
    string mirrorPath,
    IEnrolledNodeSource nodes,
    SourceLimits? limits = null) : ISourceScanner
{
    private const int CoordinationWarningMessageChars = 2_048;
    private readonly SourceLimits _limits = limits ?? new();
    private readonly GitProcess _git = new();
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly StringComparer PortableComparer = StringComparer.OrdinalIgnoreCase;

    public async Task<SourceScanResult> ScanAsync(string? lastObservedRevision, CancellationToken cancellationToken)
    {
        using var scanTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        scanTimeout.CancelAfter(TimeSpan.FromSeconds(_limits.ScanTimeoutSeconds));
        var scanToken = scanTimeout.Token;
        try
        {
            ValidateLimits();
            await PrepareMirrorAsync(scanToken);
            var revision = Text(await RunGitAsync(["rev-parse", "refs/remotes/origin/main^{commit}"], scanToken));
            if (StringComparer.Ordinal.Equals(revision, lastObservedRevision))
                return new SourceScanResult.Unchanged(revision);

            var treeOutputLimit = checked(((long)_limits.MaxEntries + 1) * (_limits.MaxPathBytes + 128L));
            var entries = ParseTree(await RunGitAsync(["ls-tree", "-lrz", "--full-tree", revision], scanToken, treeOutputLimit));
            var diagnostics = new DiagnosticBag(_limits.MaxDiagnostics);
            ValidateRepositoryEntries(entries, diagnostics);
            var manifestEntry = entries.SingleOrDefault(x => x.Path == "fleet.yml");
            if (manifestEntry is null)
            {
                diagnostics.Add("missing_manifest", "The repository root must contain fleet.yml.", "fleet.yml");
                return new SourceScanResult.Invalid(revision, diagnostics.Items);
            }
            if (manifestEntry.Type != "blob" || manifestEntry.Mode is not ("100644" or "100755"))
                return new SourceScanResult.Invalid(revision, diagnostics.Items);
            if (manifestEntry.Size > _limits.MaxManifestBytes)
            {
                diagnostics.Add("manifest_too_large", $"fleet.yml exceeds {_limits.MaxManifestBytes} bytes.", "fleet.yml");
                return new SourceScanResult.Invalid(revision, diagnostics.Items);
            }

            var manifestBytes = await ReadBlobAsync(manifestEntry!, scanToken);

            FleetManifest manifest;
            try
            {
                var yaml = StrictUtf8.GetString(manifestBytes);
                ValidateYamlEvents(yaml);
                manifest = new DeserializerBuilder()
                    .WithNamingConvention(NullNamingConvention.Instance)
                    .WithDuplicateKeyChecking()
                    .Build()
                    .Deserialize<FleetManifest>(yaml);
            }
            catch (Exception exception) when (exception is YamlException or DecoderFallbackException)
            {
                return Invalid(revision, "invalid_manifest", "fleet.yml does not match the fleet/v1 schema.", "fleet.yml");
            }

            ValidateManifest(manifest, await nodes.GetNodeIdsAsync(scanToken), diagnostics);
            if (diagnostics.Any)
                return new SourceScanResult.Invalid(revision, diagnostics.Items);
            var skillsByGroup = await BuildSkillsAsync(entries, manifest.Groups ?? [], diagnostics, scanToken);
            if (diagnostics.Any)
                return new SourceScanResult.Invalid(revision, diagnostics.Items);

            var bundles = skillsByGroup.Values.SelectMany(x => x.Values).Select(x => x.Bundle)
                .DistinctBy(x => x.Digest, StringComparer.Ordinal).OrderBy(x => x.Digest, StringComparer.Ordinal).ToArray();
            var warnings = BuildWarnings(manifest, skillsByGroup, diagnostics, scanToken);
            if (diagnostics.Any)
                return new SourceScanResult.Invalid(revision, diagnostics.Items);
            var targets = BuildTargets(manifest, skillsByGroup);
            return new SourceScanResult.Snapshot(new AcceptedSourceSnapshot(revision, bundles, targets, warnings, DateTimeOffset.UtcNow));
        }
        catch (Exception exception) when (exception is GitSourceException or IOException or UnauthorizedAccessException or DecoderFallbackException or FormatException or OverflowException)
        {
            return Invalid(null, "git_source_failure", Bound(exception.Message));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Invalid(null, "git_source_failure", "Source scanning exceeded its time limit.");
        }
    }

    private async Task PrepareMirrorAsync(CancellationToken cancellationToken)
    {
        ValidateRemote(remote);
        EnsurePrivateMirrorDirectory(mirrorPath);
        var marker = Path.Combine(mirrorPath, ".fleet-source-mirror-v1");
        if (!File.Exists(marker))
        {
            if (Directory.EnumerateFileSystemEntries(mirrorPath).Any())
                throw new GitSourceException("The source mirror directory was not created by Fleet.");
            await RunGitAsync(["init", "--bare"], cancellationToken);
            File.WriteAllText(marker, "fleet-source-mirror-v1\n", Encoding.ASCII);
        }
        ValidateMirrorTree(cancellationToken);
        if (!Text(await RunGitAsync(["rev-parse", "--is-bare-repository"], cancellationToken)).Equals("true", StringComparison.Ordinal))
            throw new GitSourceException("The source mirror is not a bare Git repository.");
        WriteControlledRepositoryConfig();
        await RunGitAsync(["fetch", "--force", "--depth=1", "--no-tags", "--prune", "--no-recurse-submodules",
            "--no-auto-maintenance", "--no-write-fetch-head", "--upload-pack=git-upload-pack", "--", remote,
            "+refs/heads/main:refs/remotes/origin/main"],
            cancellationToken, 1024 * 1024);
        ValidateMirrorTree(cancellationToken);
    }

    private async Task<Dictionary<string, Dictionary<string, BuiltSkill>>> BuildSkillsAsync(
        IReadOnlyList<TreeEntry> entries, IReadOnlyList<string> groups, DiagnosticBag diagnostics, CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, Dictionary<string, BuiltSkill>>(StringComparer.Ordinal);
        foreach (var group in groups)
        {
            var prefix = $"groups/{group}/";
            var groupEntries = entries.Where(x => x.Path.StartsWith(prefix, StringComparison.Ordinal)).ToArray();
            var skillNames = groupEntries.Select(x => x.Path[prefix.Length..].Split('/')[0]).Distinct(StringComparer.Ordinal).Order().ToArray();
            var built = new Dictionary<string, BuiltSkill>(StringComparer.Ordinal);
            foreach (var skill in skillNames)
            {
                var skillPrefix = $"{prefix}{skill}/";
                var source = groupEntries.Where(x => x.Path.StartsWith(skillPrefix, StringComparison.Ordinal)).ToArray();
                ValidateName(skill, "skill", skillPrefix, diagnostics);
                if (!source.Any(x => x.Path == skillPrefix + "SKILL.md" && x.Type == "blob" && x.Mode != "120000"))
                    diagnostics.Add("missing_skill_manifest", "A Skill root must contain SKILL.md.", skillPrefix + "SKILL.md");
                var files = new List<SourceFile>(source.Length);
                var seen = new HashSet<string>(PortableComparer);
                foreach (var entry in source)
                {
                    var relative = entry.Path[skillPrefix.Length..].Normalize(NormalizationForm.FormC);
                    if (!seen.Add(relative)) diagnostics.Add("path_collision", "Paths collide after case folding or Unicode normalization.", entry.Path);
                    if (entry.Type != "blob" || entry.Mode == "120000") continue;
                    files.Add(new SourceFile(relative, await ReadBlobAsync(entry, cancellationToken), entry.Mode == "100755"));
                }
                if (!diagnostics.Any)
                {
                    var encodedSize = BundleEncoder.EncodedSize(files);
                    if (encodedSize > _limits.MaxBundleBytes)
                        diagnostics.Add("bundle_too_large", $"Encoded Bundle exceeds {_limits.MaxBundleBytes} bytes.", skillPrefix.TrimEnd('/'));
                    else
                        built.Add(skill, new BuiltSkill(BundleEncoder.Encode(skill, files), skillPrefix.TrimEnd('/')));
                }
            }
            result[group] = built;
        }
        return result;
    }

    private void ValidateRepositoryEntries(IReadOnlyList<TreeEntry> entries, DiagnosticBag diagnostics)
    {
        if (entries.Count > _limits.MaxEntries) diagnostics.Add("too_many_entries", $"Repository has more than {_limits.MaxEntries} entries.");
        long total = 0;
        var seen = new Dictionary<string, (string Original, bool IsFile)>(PortableComparer);
        foreach (var entry in entries)
        {
            string normalized;
            try { normalized = entry.Path.Normalize(NormalizationForm.FormC); }
            catch (ArgumentException) { diagnostics.Add("invalid_path", "Path contains invalid Unicode.", entry.Path); continue; }
            var segments = normalized.Split('/');
            if (normalized.StartsWith('/') || segments.Any(x => x is "" or "." or "..") || normalized.Contains('\\'))
                diagnostics.Add("unsafe_path", "Path must be a safe relative slash-separated path.", entry.Path);
            if (StrictUtf8.GetByteCount(normalized) > _limits.MaxPathBytes) diagnostics.Add("path_too_long", "Path exceeds the byte limit.", entry.Path);
            if (segments.Length > _limits.MaxTreeDepth) diagnostics.Add("tree_too_deep", "Path exceeds the tree depth limit.", entry.Path);
            var prefix = "";
            for (var index = 0; index < segments.Length; index++)
            {
                prefix = index == 0 ? segments[index] : $"{prefix}/{segments[index]}";
                var isFile = index == segments.Length - 1;
                if (seen.TryGetValue(prefix, out var prior) && (prior.Original != prefix || prior.IsFile != isFile))
                    diagnostics.Add("path_collision", "Paths or directory prefixes collide after case folding or Unicode normalization.", entry.Path);
                else
                    seen.TryAdd(prefix, (prefix, isFile));
            }
            if (entry.Type != "blob" || entry.Mode is not ("100644" or "100755")) diagnostics.Add("unsafe_entry_type", "Only regular files are accepted.", entry.Path);
            if (entry.Size > _limits.MaxFileBytes) diagnostics.Add("file_too_large", "File exceeds the size limit.", entry.Path);
            total = checked(total + entry.Size);
        }
        if (total > _limits.MaxTotalBytes) diagnostics.Add("source_too_large", "Repository file bytes exceed the total size limit.");
    }

    private static void ValidateManifest(FleetManifest manifest, IReadOnlySet<NodeId> enrolled, DiagnosticBag diagnostics)
    {
        if (manifest is null) { diagnostics.Add("invalid_manifest", "fleet.yml must contain a mapping."); return; }
        if (manifest.Schema != "fleet/v1") diagnostics.Add("unsupported_schema", "schema must be fleet/v1.", "fleet.yml");
        if (manifest.Groups is null) diagnostics.Add("missing_groups", "groups is required.", "fleet.yml");
        else
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var group in manifest.Groups) { ValidateName(group, "group", "fleet.yml", diagnostics); if (!seen.Add(group)) diagnostics.Add("duplicate_group", $"Group '{group}' is declared more than once.", "fleet.yml"); }
        }
        var defaultTarget = manifest.Targets?.Skills;
        ValidateTarget(defaultTarget?.Base, defaultTarget?.Path, diagnostics);
        if (manifest.Nodes is null) { diagnostics.Add("missing_nodes", "nodes is required.", "fleet.yml"); return; }
        if (manifest.Nodes.Count > 10_000) { diagnostics.Add("too_many_nodes", "nodes contains more than 10000 entries.", "fleet.yml"); return; }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (name, node) in manifest.Nodes)
        {
            if (node is null || !Guid.TryParse(node.Id, out var parsedId) || !enrolled.Contains(new NodeId(parsedId))) diagnostics.Add("unknown_node", $"Node '{name}' references an unknown Node ID.", "fleet.yml");
            else if (!ids.Add(node.Id)) diagnostics.Add("duplicate_node_id", $"Node ID '{node.Id}' is referenced more than once.", "fleet.yml");
            var target = node?.Targets?.Skills;
            if (target is null) { diagnostics.Add("missing_node_target", $"Node '{name}' must configure the skills Target.", "fleet.yml"); continue; }
            ValidateTarget(defaultTarget?.Base, target.Path ?? defaultTarget?.Path, diagnostics);
            if (target.Groups is null) diagnostics.Add("missing_node_groups", $"Node '{name}' must declare its groups list.", "fleet.yml");
            else foreach (var group in target.Groups) if (!(manifest.Groups?.Contains(group, StringComparer.Ordinal) ?? false)) diagnostics.Add("unknown_group", $"Node '{name}' subscribes to undeclared group '{group}'.", "fleet.yml");
        }
    }

    private static void ValidateTarget(string? @base, string? path, DiagnosticBag diagnostics)
    {
        if (@base != "home") diagnostics.Add("invalid_target_base", "The skills Target base must be home.", "fleet.yml");
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains('\\') || path.Split('/').Any(x => x is "" or "." or ".."))
            diagnostics.Add("invalid_target_path", "The skills Target path must be a non-empty safe relative path.", "fleet.yml");
    }

    private static void ValidateName(string? name, string kind, string path, DiagnosticBag diagnostics)
    {
        if (string.IsNullOrEmpty(name) || name.Length > 63 || name.Any(c => !(c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-')) || name[0] == '-' || name[^1] == '-')
            diagnostics.Add($"invalid_{kind}_name", $"{kind} names must use lowercase letters, numbers, and interior hyphens.", path);
    }

    private static IReadOnlyList<SnapshotTarget> BuildTargets(FleetManifest manifest, Dictionary<string, Dictionary<string, BuiltSkill>> groups)
        => manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal).Select(pair =>
        {
            var target = pair.Value.Targets.Skills;
            var skills = new Dictionary<string, SnapshotSkill>(StringComparer.Ordinal);
            foreach (var group in manifest.Groups.Where(g => target.Groups!.Contains(g, StringComparer.Ordinal)))
                foreach (var skill in groups[group].OrderBy(x => x.Key, StringComparer.Ordinal))
                    skills.TryAdd(skill.Key, new SnapshotSkill(skill.Key, skill.Value.Bundle.Digest));
            return new SnapshotTarget(new NodeId(Guid.Parse(pair.Value.Id)), "skills", new TargetDescriptor("home", target.Path ?? manifest.Targets.Skills.Path!), skills.Values.ToArray());
        }).ToArray();

    private IReadOnlyList<SourceWarning> BuildWarnings(FleetManifest manifest, Dictionary<string, Dictionary<string, BuiltSkill>> groups,
        DiagnosticBag diagnostics, CancellationToken cancellationToken)
    {
        var locations = groups.SelectMany(g => g.Value.Select(s => (s.Key, s.Value.Location))).GroupBy(x => x.Key, StringComparer.Ordinal)
            .Where(x => x.Skip(1).Any()).ToDictionary(x => x.Key,
                x => (IReadOnlyList<string>)x.Select(v => v.Location).Take(_limits.MaxWarningLocations + 1).ToArray(), StringComparer.Ordinal);
        var warnings = new List<SourceWarning>();
        var aggregateBytes = 0;
        foreach (var duplicate in locations.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (warnings.Count >= _limits.MaxWarnings)
            {
                diagnostics.Add("too_many_warnings", $"Source produces more than {_limits.MaxWarnings} warnings.");
                break;
            }
            var winners = manifest.Nodes
                .Select(node =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return (node.Value.Id, Groups: manifest.Groups.Where(g => node.Value.Targets.Skills.Groups!.Contains(g, StringComparer.Ordinal) && groups[g].ContainsKey(duplicate.Key)).ToArray());
                })
                .Where(x => x.Groups.Length > 1)
                .OrderBy(x => x.Id, StringComparer.Ordinal)
                .Select(x => $"{x.Id}={groups[x.Groups[0]][duplicate.Key].Location}")
                .Take(_limits.MaxWarningWinners + 1)
                .ToArray();
            if (duplicate.Value.Count > _limits.MaxWarningLocations || winners.Length > _limits.MaxWarningWinners)
            {
                diagnostics.Add("warning_too_large", $"Duplicate Skill warning for '{duplicate.Key}' exceeds its location or Node limit.");
                continue;
            }
            if (winners.Length > 0)
            {
                var message = $"Skill '{duplicate.Key}' occurs in multiple subscribed groups. Winners by Node are {string.Join(", ", winners)}.";
                if (message.Length > _limits.MaxWarningMessageChars)
                {
                    diagnostics.Add("warning_too_large", $"Duplicate Skill warning for '{duplicate.Key}' exceeds {_limits.MaxWarningMessageChars} characters.");
                    continue;
                }
                aggregateBytes = checked(aggregateBytes + StrictUtf8.GetByteCount(message) + duplicate.Value.Sum(x => StrictUtf8.GetByteCount(x)));
                if (aggregateBytes > _limits.MaxWarningBytes)
                {
                    diagnostics.Add("warnings_too_large", $"Source warnings exceed {_limits.MaxWarningBytes} UTF-8 bytes.");
                    break;
                }
                warnings.Add(new SourceWarning("duplicate_skill_name", message, duplicate.Value));
            }
        }
        return warnings;
    }

    private async Task<byte[]> ReadBlobAsync(TreeEntry entry, CancellationToken cancellationToken)
        => await RunGitAsync(["cat-file", "blob", entry.ObjectId], cancellationToken, entry.Size);

    private Task<byte[]> RunGitAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken, long maxOutputBytes = 16 * 1024 * 1024)
    {
        string[] hardened =
        [
            "-c", "protocol.allow=never",
            "-c", "protocol.https.allow=always",
            "-c", "protocol.ssh.allow=always",
            "-c", "protocol.file.allow=always",
            "-c", "protocol.ext.allow=never",
            "-c", "http.followRedirects=false",
            "-c", "fetch.recurseSubmodules=false",
            "-c", "submodule.recurse=false",
            "-c", "core.hooksPath=/dev/null",
            "-c", "credential.helper=",
            "-c", "credential.interactive=never",
            "-c", "fetch.fsckObjects=true",
            "-c", "gc.auto=0",
            .. arguments,
        ];
        return _git.RunAsync(mirrorPath, hardened, cancellationToken, maxOutputBytes,
            TimeSpan.FromSeconds(_limits.GitCommandTimeoutSeconds));
    }

    private void ValidateMirrorTree(CancellationToken cancellationToken)
    {
        long size = 0;
        var count = 0;
        if (File.Exists(Path.Combine(mirrorPath, "objects", "info", "alternates")))
            throw new GitSourceException("The source mirror must not use an alternate object store.");
        foreach (var path in Directory.EnumerateFileSystemEntries(mirrorPath, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (++count > _limits.MaxMirrorEntries)
                throw new GitSourceException("The source mirror exceeds its entry limit.");
            var info = new FileInfo(path);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.LinkTarget is not null)
                throw new GitSourceException("The source mirror must not contain symbolic links.");
            if ((info.Attributes & FileAttributes.Directory) == 0)
                size = checked(size + info.Length);
            if (size > _limits.MaxMirrorBytes)
                throw new GitSourceException("The source mirror exceeds its on-disk byte limit.");
        }
    }

    private static void EnsurePrivateMirrorDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            throw new GitSourceException("The source mirror requires Unix directory permissions.");
        var fullPath = Path.GetFullPath(path);
        for (var current = new DirectoryInfo(fullPath); current is not null; current = current.Parent)
            if (current.Exists && ((current.Attributes & FileAttributes.ReparsePoint) != 0 || current.LinkTarget is not null))
                throw new GitSourceException("The source mirror path must not contain symbolic links.");
        if (File.Exists(fullPath) && !Directory.Exists(fullPath))
            throw new GitSourceException("The source mirror path must be a directory.");
        var info = new DirectoryInfo(fullPath);
        if (info.Exists && ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.LinkTarget is not null))
            throw new GitSourceException("The source mirror path must not be a symbolic link.");
        Directory.CreateDirectory(fullPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.SetUnixFileMode(fullPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        if (File.GetUnixFileMode(fullPath) != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute))
            throw new GitSourceException("The source mirror directory must allow access only to the service account.");
    }

    private void WriteControlledRepositoryConfig()
    {
        var config = Path.Combine(mirrorPath, "config");
        var info = new FileInfo(config);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.LinkTarget is not null)
            throw new GitSourceException("The source mirror configuration must not be a symbolic link.");
        File.WriteAllText(config, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\tlogallrefupdates = false\n\tsharedrepository = 0\n", Encoding.ASCII);
    }

    private void ValidateLimits()
    {
        if (_limits.MaxEntries <= 0 || _limits.MaxTreeDepth <= 0 || _limits.MaxPathBytes <= 0 ||
            _limits.MaxFileBytes <= 0 || _limits.MaxTotalBytes <= 0 || _limits.MaxBundleBytes <= 0 ||
            _limits.MaxMirrorBytes <= 0 || _limits.MaxMirrorEntries <= 0 || _limits.MaxManifestBytes <= 0 || _limits.MaxDiagnostics <= 0 ||
            _limits.MaxWarnings <= 0 || _limits.MaxWarningWinners <= 0 || _limits.MaxWarningLocations <= 0 ||
            _limits.MaxWarningBytes <= 0 || _limits.MaxWarningMessageChars is <= 0 or > CoordinationWarningMessageChars ||
            _limits.ScanTimeoutSeconds <= 0 || _limits.GitCommandTimeoutSeconds <= 0)
            throw new GitSourceException("Source limits must be positive.");
    }

    private static void ValidateRemote(string value)
    {
        if (Path.IsPathFullyQualified(value)) return;
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "ssh" or "file")
        {
            if (uri.Scheme == "https" && !string.IsNullOrEmpty(uri.UserInfo))
                throw new GitSourceException("HTTPS source remotes must not contain credentials.");
            return;
        }
        if (value.IndexOf(':') > 0 && !value.Contains("://", StringComparison.Ordinal) && !value.StartsWith('-')) return;
        throw new GitSourceException("The source remote must use HTTPS, SSH, or an absolute local file path.");
    }

    private static void ValidateYamlEvents(string yaml)
    {
        var parser = new Parser(new StringReader(yaml));
        var depth = 0;
        var events = 0;
        while (parser.MoveNext())
        {
            if (++events > 10_000) throw new YamlException("YAML contains too many parsing events.");
            if (parser.Current is AnchorAlias)
                throw new YamlException("YAML aliases are not accepted.");
            if (parser.Current is MappingStart or SequenceStart)
            {
                if (++depth > 32) throw new YamlException("YAML nesting is too deep.");
            }
            else if (parser.Current is MappingEnd or SequenceEnd)
            {
                depth--;
            }
        }
    }

    private IReadOnlyList<TreeEntry> ParseTree(byte[] bytes)
    {
        var result = new List<TreeEntry>();
        var paths = new HashSet<string>(StringComparer.Ordinal);
        var start = 0;
        while (start < bytes.Length)
        {
            if (result.Count > _limits.MaxEntries)
                throw new GitSourceException("git ls-tree returned too many entries.");
            var end = Array.IndexOf(bytes, (byte)0, start);
            if (end < 0) throw new GitSourceException("git ls-tree returned an unterminated entry.");
            var record = StrictUtf8.GetString(bytes, start, end - start);
            var tab = record.IndexOf('\t');
            if (tab < 0) throw new GitSourceException("git ls-tree returned a malformed entry.");
            var metadata = record[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (metadata.Length != 4) throw new GitSourceException("git ls-tree returned malformed metadata.");
            if (metadata[2].Length is not (40 or 64) || !metadata[2].All(Uri.IsHexDigit))
                throw new GitSourceException("git ls-tree returned an invalid object identifier.");
            if (metadata[1] == "blob" && metadata[3] == "-")
                throw new GitSourceException("git ls-tree omitted a blob size.");
            var size = metadata[3] == "-" ? 0 : long.TryParse(metadata[3], System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var parsed) ? parsed : throw new GitSourceException("git ls-tree returned an invalid size.");
            var path = record[(tab + 1)..];
            if (!paths.Add(path)) throw new GitSourceException("git ls-tree returned a duplicate path.");
            result.Add(new TreeEntry(metadata[0], metadata[1], metadata[2], size, path));
            start = end + 1;
        }
        return result;
    }

    private static string Text(byte[] bytes) => StrictUtf8.GetString(bytes).Trim();
    private static string Bound(string value) => value.Length <= 512 ? value : value[..512];
    private static SourceScanResult.Invalid Invalid(string? revision, string code, string message, string? path = null) => new(revision, [new(code, message, path)]);
    private sealed record TreeEntry(string Mode, string Type, string ObjectId, long Size, string Path);
    private sealed record BuiltSkill(SnapshotBundle Bundle, string Location);
    private sealed class DiagnosticBag(int max)
    {
        private readonly List<SourceDiagnostic> _items = [];
        public IReadOnlyList<SourceDiagnostic> Items => _items;
        public bool Any => _items.Count > 0;
        public void Add(string code, string message, string? path = null)
        {
            if (_items.Count < max) _items.Add(new(BoundUtf8(code, 100), BoundUtf8(message, 1024), path is null ? null : BoundUtf8(path, 1024)));
        }

        private static string BoundUtf8(string value, int maxBytes)
        {
            if (StrictUtf8.GetByteCount(value) <= maxBytes) return value;
            var result = new StringBuilder();
            var bytes = 0;
            foreach (var rune in value.EnumerateRunes())
            {
                var count = rune.Utf8SequenceLength;
                if (bytes + count > maxBytes) break;
                result.Append(rune.ToString());
                bytes += count;
            }
            return result.ToString();
        }
    }
}
