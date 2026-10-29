using System.Collections.Concurrent;
using System.ComponentModel.DataAnnotations;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Hosting;

/// <summary>Where the Server gets signed Agent releases, bound from <c>Fleet:AgentReleases</c>.</summary>
public sealed class AgentReleaseOptions
{
    public const string DefaultBaseUrl = "https://github.com/jcarcaboso/fleet-manager/releases/download";

    /// <summary>Release downloads: <c>{BaseUrl}/v{version}/{file}</c>. HTTPS only.</summary>
    public string BaseUrl { get; set; } = DefaultBaseUrl;
    /// <summary>Verified releases are cached here, one <c>v{version}</c> directory each. An offline Server reads the release files placed there.</summary>
    public string CacheDirectory { get; set; } = "/var/lib/fleet/agent-releases";
    /// <summary>PEM Ed25519 public keys that sign releases, at most two. Empty means the keys committed with the Agent and embedded in the Server.</summary>
    public List<string> PublicKeys { get; set; } = [];
    /// <summary>Time limit of one mirror run: the manifest, its signature and every archive.</summary>
    [Range(10, 3600)] public int DownloadTimeoutSeconds { get; set; } = 300;

    public bool HasValidBaseUrl() => Uri.TryCreate(BaseUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        uri.Host.Length > 0 && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0;

    public bool HasValidPublicKeys()
    {
        if (PublicKeys.Count > 2) return false;
        try { foreach (var key in PublicKeys) Ed25519.PublicKeyFromPem(key); return true; }
        catch (FormatException) { return false; }
    }
}

/// <summary>One binary of a verified release: the cached executable for one platform.</summary>
public sealed record AgentReleaseBinary(string Os, string Arch, string Sha256, long Size, string Path);

/// <summary>A verified release: the exact signed manifest bytes, its signature and the cached binaries by <c>{os}-{arch}</c>.</summary>
public sealed record AgentRelease(string Version, byte[] Manifest, byte[] Signature, IReadOnlyDictionary<string, AgentReleaseBinary> Binaries);

/// <summary>
/// Mirrors the signed Agent release of the Server's own version and serves it to Agents over the Node connection. The manifest
/// signature is checked against the trusted keys before any archive is downloaded, and every binary against the manifest's digest
/// and size, so the Server never caches or serves a release that Agents would reject. Downloads follow no redirects except
/// GitHub's release-asset redirect. One mirror run happens at a time; a failure is remembered for a minute so retries do not
/// hammer GitHub. See docs/plans/agent-self-update.md.
/// </summary>
public sealed partial class AgentReleaseMirror(IHttpClientFactory clients, IOptions<AgentReleaseOptions> options, TimeProvider clock,
    ILogger<AgentReleaseMirror> logger)
{
    public const string HttpClientName = "agent-releases";
    public const string ManifestName = "fleet-agent-release.json";
    public const string SignatureName = ManifestName + ".sig";
    public const int MaximumManifestBytes = 64 * 1024;
    /// <summary>The Agent refuses larger executables, and the release script refuses to sign them.</summary>
    public const long MaximumBinaryBytes = 64 * 1024 * 1024;
    private const long MaximumArchiveBytes = 96 * 1024 * 1024;
    /// <summary>The most an archive may unpack to: the binary and the small files beside it.</summary>
    private const long MaximumUnpackedBytes = 128 * 1024 * 1024;
    /// <summary>The largest PAX or GNU long-name header accepted.</summary>
    private const int MaximumTarMetadataBytes = 64 * 1024;
    private static readonly TimeSpan FailureMemory = TimeSpan.FromMinutes(1);
    private static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64" };

    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly ConcurrentDictionary<string, AgentRelease> verified = new(StringComparer.Ordinal);
    private (string Version, DateTimeOffset At, OperatorApiException Error)? lastFailure;
    private IReadOnlyList<byte[]>? keys;

    [GeneratedRegex("^[0-9a-f]{64}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();

    /// <summary>The trusted keys: configured ones, or the ones embedded from <c>clients/bins/fleet-agent/release-keys</c>.</summary>
    public IReadOnlyList<byte[]> TrustedKeys => keys ??= LoadKeys(options.Value);

    public static IReadOnlyList<byte[]> LoadKeys(AgentReleaseOptions settings)
    {
        if (settings.PublicKeys.Count > 0) return settings.PublicKeys.Select(Ed25519.PublicKeyFromPem).ToList();
        var assembly = typeof(AgentReleaseMirror).Assembly;
        return assembly.GetManifestResourceNames().Where(name => name.StartsWith("AgentReleaseKeys/", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal).Select(name =>
            {
                using var stream = assembly.GetManifestResourceStream(name)!;
                using var reader = new StreamReader(stream);
                return Ed25519.PublicKeyFromPem(reader.ReadToEnd());
            }).ToList();
    }

    /// <summary>Returns the verified release of <paramref name="version"/>, mirroring it first when it is not cached.</summary>
    public async Task<AgentRelease> EnsureAsync(SemanticVersion version, CancellationToken cancellationToken)
    {
        if (Cached(version.Text) is { } cached) return cached;
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (Cached(version.Text) is { } again) return again;
            if (lastFailure is { } failure && failure.Version == version.Text && clock.GetUtcNow() - failure.At < FailureMemory)
                throw new OperatorApiException(failure.Error.Status, failure.Error.Code, failure.Error.Message);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(options.Value.DownloadTimeoutSeconds));
            try
            {
                var release = await LoadAsync(version.Text, timeout.Token);
                verified[version.Text] = release;
                lastFailure = null;
                logger.LogInformation("Agent release {Version} is mirrored and verified", version.Text);
                return release;
            }
            catch (OperationCanceledException) when (timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
            {
                throw Remember(version.Text, Unavailable($"Downloading Agent release {version.Text} took longer than {options.Value.DownloadTimeoutSeconds} seconds."));
            }
            catch (OperatorApiException error)
            {
                throw Remember(version.Text, error);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private AgentRelease? Cached(string version) =>
        verified.TryGetValue(version, out var release) && release.Binaries.Values.All(x => File.Exists(x.Path)) ? release : null;

    private OperatorApiException Remember(string version, OperatorApiException error)
    {
        lastFailure = (version, clock.GetUtcNow(), error);
        logger.LogWarning("Agent release {Version} is not available: {Code}", version, error.Code);
        return error;
    }

    private async Task<AgentRelease> LoadAsync(string version, CancellationToken ct)
    {
        if (TrustedKeys.Count == 0)
            throw Unavailable("The Server has no Agent release signing key. Configure Fleet:AgentReleases:PublicKeys or use a release that embeds the key.");
        var directory = Path.Combine(options.Value.CacheDirectory, "v" + version);
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var manifestPath = Path.Combine(directory, ManifestName);
        var signaturePath = Path.Combine(directory, SignatureName);
        var downloaded = new List<string>();
        try
        {
            foreach (var (name, path, limit) in new[] { (ManifestName, manifestPath, (long)MaximumManifestBytes), (SignatureName, signaturePath, 1024L) })
                if (!File.Exists(path))
                {
                    await DownloadAsync(version, name, path, limit, ct);
                    downloaded.Add(path);
                }
            var manifest = await ReadBoundedAsync(manifestPath, MaximumManifestBytes, ct);
            var signature = await File.ReadAllBytesAsync(signaturePath, ct);
            if (!TrustedKeys.Any(key => Ed25519.Verify(key, manifest, signature)))
                throw Invalid($"The signature of Agent release {version} does not verify with a trusted key.");
            var entries = ParseManifest(manifest, version);
            var binaries = new Dictionary<string, AgentReleaseBinary>(StringComparer.Ordinal);
            Directory.CreateDirectory(Path.Combine(directory, "binaries"));
            foreach (var entry in entries)
            {
                var platform = $"{entry.Os}-{entry.Arch}";
                var binary = Path.Combine(directory, "binaries", platform);
                if (!File.Exists(binary) || !await MatchesAsync(binary, entry, ct))
                {
                    var archiveName = $"fleet-agent-{platform}.tar.gz";
                    var archive = Path.Combine(directory, archiveName);
                    var fetched = !File.Exists(archive);
                    if (fetched)
                    {
                        await DownloadAsync(version, archiveName, archive, MaximumArchiveBytes, ct);
                        downloaded.Add(archive);
                    }
                    await ExtractAsync(archive, binary, entry, ct);
                    // Only the verified binary is kept; an archive an Operator placed for an offline Server stays.
                    if (fetched) File.Delete(archive);
                }
                binaries[platform] = new(entry.Os, entry.Arch, entry.Sha256, entry.Size, binary);
            }
            return new(version, manifest, signature, binaries);
        }
        catch
        {
            // Never keep a download that was not verified, so a corrected release can be fetched again.
            foreach (var path in downloaded) File.Delete(path);
            throw;
        }
    }

    private sealed record ManifestEntry(string Os, string Arch, string Sha256, long Size);

    private static List<ManifestEntry> ParseManifest(byte[] manifest, string version)
    {
        try
        {
            var root = JsonDocument.Parse(manifest).RootElement;
            if (root.GetProperty("schema").GetInt32() != 1 || root.GetProperty("name").GetString() != "fleet-agent")
                throw Invalid("The Agent release manifest has an unknown schema or name.");
            if (root.GetProperty("version").GetString() != version)
                throw Invalid($"The Agent release manifest is for version {root.GetProperty("version").GetString()}, not {version}.");
            var entries = root.GetProperty("binaries").EnumerateArray().Select(x => new ManifestEntry(x.GetProperty("os").GetString()!,
                x.GetProperty("arch").GetString()!, x.GetProperty("sha256").GetString()!, x.GetProperty("size").GetInt64())).ToList();
            if (entries.Count == 0 || entries.Select(x => x.Os + "-" + x.Arch).Distinct(StringComparer.Ordinal).Count() != entries.Count ||
                entries.Any(x => !Platforms.Contains(x.Os + "-" + x.Arch) || !Sha256Pattern().IsMatch(x.Sha256) || x.Size is < 1 or > MaximumBinaryBytes))
                throw Invalid("The Agent release manifest lists an unknown platform, a duplicate, an invalid digest or an invalid size.");
            return entries;
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw Invalid("The Agent release manifest is not valid JSON of the expected shape.");
        }
    }

    private static async Task<bool> MatchesAsync(string path, ManifestEntry entry, CancellationToken ct)
    {
        await using var file = File.OpenRead(path);
        return file.Length == entry.Size && Convert.ToHexStringLower(await SHA256.HashDataAsync(file, ct)) == entry.Sha256;
    }

    /// <summary>
    /// Extracts the <c>fleet-agent</c> member of a release archive to <paramref name="destination"/> if it matches the manifest. The
    /// archive is read here rather than by <c>TarReader</c>, which allocates as much as a PAX or GNU long-name header claims before
    /// reading it: every length is bounded before anything is read, and so is the decompressed size of the whole archive.
    /// </summary>
    private static async Task ExtractAsync(string archive, string destination, ManifestEntry entry, CancellationToken ct)
    {
        var name = Path.GetFileName(archive);
        var temporary = destination + ".partial";
        try
        {
            await using var input = File.OpenRead(archive);
            await using var gzip = new GZipStream(input, CompressionMode.Decompress);
            var tar = new TarBlocks(gzip, MaximumUnpackedBytes, name);
            var header = new byte[TarBlocks.BlockSize];
            string? longName = null, paxPath = null;
            long? paxSize = null;
            // An archive may end without its two zero blocks; a header cut short is invalid.
            while (await tar.ReadHeaderAsync(header, ct) && header.AsSpan().ContainsAnyExcept((byte)0))
            {
                var type = (char)header[156];
                var size = TarBlocks.Size(header, name);
                if (type is 'x' or 'g' or 'L' or 'K')
                {
                    if (size > MaximumTarMetadataBytes) throw Invalid($"{name} has a tar metadata header larger than {MaximumTarMetadataBytes} bytes.");
                    var metadata = await tar.ReadAsync((int)size, ct);
                    if (type == 'x') (paxPath, paxSize) = TarBlocks.Pax(metadata, name);
                    else if (type == 'L') longName = System.Text.Encoding.UTF8.GetString(metadata).TrimEnd('\0');
                    continue;
                }
                var member = paxPath ?? longName ?? TarBlocks.Name(header);
                size = paxSize ?? size;
                (longName, paxPath, paxSize) = (null, null, null);
                if (member is not ("fleet-agent" or "./fleet-agent"))
                {
                    await tar.SkipAsync(size, ct);
                    continue;
                }
                if (type is not ('0' or '\0')) throw Invalid($"fleet-agent in {name} is not a regular file.");
                if (size != entry.Size) throw Invalid($"fleet-agent in {name} is {size} bytes; the manifest says {entry.Size}.");
                await using (var output = CreatePrivate(temporary))
                using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                {
                    await tar.CopyAsync(size, chunk =>
                    {
                        hash.AppendData(chunk.Span);
                        return output.WriteAsync(chunk, ct);
                    }, ct);
                    if (Convert.ToHexStringLower(hash.GetHashAndReset()) != entry.Sha256)
                        throw Invalid($"fleet-agent in {name} does not match the signed digest.");
                    await output.FlushAsync(ct);
                }
                File.Move(temporary, destination, true);
                return;
            }
            throw Invalid($"{name} has no fleet-agent executable.");
        }
        catch (Exception error) when (error is InvalidDataException or FormatException or EndOfStreamException)
        {
            throw Invalid($"{name} is not a valid gzip-compressed tar archive.");
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    /// <summary>The 512-byte blocks of a tar stream, with a bound on everything read from it.</summary>
    private sealed class TarBlocks(Stream stream, long limit, string name)
    {
        public const int BlockSize = 512;
        private readonly byte[] buffer = new byte[81920];
        private long total;

        /// <summary>False at the end of the stream; a header cut short throws <see cref="EndOfStreamException"/>.</summary>
        public async Task<bool> ReadHeaderAsync(byte[] header, CancellationToken ct)
        {
            var read = await stream.ReadAtLeastAsync(header, BlockSize, throwOnEndOfStream: false, ct);
            if (read == 0) return false;
            if (read < BlockSize) throw new EndOfStreamException();
            Count(BlockSize);
            return true;
        }

        public async Task<byte[]> ReadAsync(int size, CancellationToken ct)
        {
            var data = new byte[size + Padding(size)];
            await ReadExactlyAsync(data, ct);
            return data[..size];
        }

        public Task SkipAsync(long size, CancellationToken ct) => CopyAsync(size, _ => ValueTask.CompletedTask, ct);

        /// <summary>Passes the next <paramref name="size"/> bytes to <paramref name="sink"/>, then skips the padding to the next block.</summary>
        public async Task CopyAsync(long size, Func<ReadOnlyMemory<byte>, ValueTask> sink, CancellationToken ct)
        {
            for (var left = size + Padding(size); left > 0;)
            {
                var chunk = buffer.AsMemory(0, (int)Math.Min(buffer.Length, left));
                await ReadExactlyAsync(chunk, ct);
                var data = Math.Max(0, Math.Min(chunk.Length, left - Padding(size)));
                if (data > 0) await sink(chunk[..(int)data]);
                left -= chunk.Length;
            }
        }

        private async Task ReadExactlyAsync(Memory<byte> data, CancellationToken ct)
        {
            Count(data.Length);
            await stream.ReadExactlyAsync(data, ct);
        }

        private void Count(long bytes)
        {
            total += bytes;
            if (total > limit) throw Invalid($"{name} unpacks to more than {limit} bytes.");
        }

        private static long Padding(long size) => (BlockSize - size % BlockSize) % BlockSize;

        /// <summary>The octal size field. Base-256 sizes are only needed beyond 8 GiB and are refused.</summary>
        public static long Size(byte[] header, string name)
        {
            var field = header.AsSpan(124, 12);
            if ((field[0] & 0x80) != 0) throw Invalid($"{name} has a tar entry larger than the Server accepts.");
            long size = 0;
            foreach (var digit in field.Trim((byte)' ').TrimEnd((byte)0).Trim((byte)' '))
            {
                if (digit is < (byte)'0' or > (byte)'7') throw new FormatException();
                size = size * 8 + (digit - '0');
            }
            return size;
        }

        /// <summary>The name, with the POSIX ustar prefix (<c>prefix/name</c>); GNU headers use those bytes for other fields.</summary>
        public static string Name(byte[] header)
        {
            static string Field(ReadOnlySpan<byte> field) =>
                System.Text.Encoding.UTF8.GetString(field.IndexOf((byte)0) is var end and >= 0 ? field[..end] : field);
            var memberName = Field(header.AsSpan(0, 100));
            var prefix = header.AsSpan(257, 6).SequenceEqual("ustar\0"u8) ? Field(header.AsSpan(345, 155)) : "";
            return prefix.Length > 0 ? prefix + "/" + memberName : memberName;
        }

        /// <summary>The <c>path</c> and <c>size</c> records of a PAX extended header (<c>"%d %s=%s\n"</c> each).</summary>
        public static (string? Path, long? Size) Pax(byte[] data, string name)
        {
            string? path = null;
            long? size = null;
            for (var at = 0; at < data.Length;)
            {
                var space = Array.IndexOf(data, (byte)' ', at);
                if (space < 0 || !int.TryParse(data.AsSpan(at, space - at), System.Globalization.NumberStyles.None, null, out var length) ||
                    length <= space - at || at + length > data.Length || data[at + length - 1] != (byte)'\n')
                    throw Invalid($"{name} has an invalid PAX extended header.");
                var record = System.Text.Encoding.UTF8.GetString(data, space + 1, at + length - space - 2);
                var equals = record.IndexOf('=');
                if (equals < 0) throw Invalid($"{name} has an invalid PAX extended header.");
                var (key, value) = (record[..equals], record[(equals + 1)..]);
                if (key == "path") path = value;
                else if (key == "size")
                    size = long.TryParse(value, System.Globalization.NumberStyles.None, null, out var parsed) && parsed <= MaximumUnpackedBytes
                        ? parsed
                        : throw Invalid($"{name} has an invalid PAX size.");
                at += length;
            }
            return (path, size);
        }
    }

    private async Task DownloadAsync(string version, string name, string destination, long limit, CancellationToken ct)
    {
        var uri = new Uri($"{options.Value.BaseUrl.TrimEnd('/')}/v{Uri.EscapeDataString(version)}/{name}");
        var client = clients.CreateClient(HttpClientName);
        var temporary = destination + ".download";
        try
        {
            for (var hop = 0; ; hop++)
            {
                using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
                if (IsRedirect(response.StatusCode))
                {
                    var next = response.Headers.Location is { } location ? new Uri(uri, location) : null;
                    if (hop > 0 || next is null || !IsReleaseAssetRedirect(uri, next))
                        throw Unavailable($"Downloading {name} was redirected somewhere the Server does not follow.");
                    uri = next;
                    continue;
                }
                if (response.StatusCode == HttpStatusCode.NotFound)
                    throw Unavailable($"Agent release {version} is not published yet ({name} was not found). Publish the release, or place its files in the Server's release cache.");
                if (!response.IsSuccessStatusCode)
                    throw Unavailable($"Downloading {name} failed with HTTP {(int)response.StatusCode}.");
                if (response.Content.Headers.ContentLength > limit) throw Invalid($"{name} is larger than {limit} bytes.");
                await using var body = await response.Content.ReadAsStreamAsync(ct);
                await using var output = CreatePrivate(temporary);
                var buffer = new byte[81920];
                long total = 0;
                int read;
                while ((read = await body.ReadAsync(buffer, ct)) > 0)
                {
                    total += read;
                    if (total > limit) throw Invalid($"{name} is larger than {limit} bytes.");
                    await output.WriteAsync(buffer.AsMemory(0, read), ct);
                }
                await output.FlushAsync(ct);
                break;
            }
            File.Move(temporary, destination, true);
        }
        catch (HttpRequestException)
        {
            throw Unavailable($"Downloading {name} failed: the release host could not be reached.");
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    // Mode 0600: only the Server reads cached releases.
    private static FileStream CreatePrivate(string path) => OperatingSystem.IsWindows()
        ? new FileStream(path, FileMode.Create, FileAccess.Write)
        : new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
        });

    private static bool IsRedirect(HttpStatusCode status) => status is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or
        HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    /// <summary>GitHub answers release downloads with one redirect to its asset storage. Nothing else is followed.</summary>
    public static bool IsReleaseAssetRedirect(Uri from, Uri to) =>
        from.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) && to.Scheme == Uri.UriSchemeHttps && to.UserInfo.Length == 0 &&
        to.Host.EndsWith(".githubusercontent.com", StringComparison.OrdinalIgnoreCase);

    private static async Task<byte[]> ReadBoundedAsync(string path, int limit, CancellationToken ct)
    {
        var length = new FileInfo(path).Length;
        if (length > limit) throw Invalid($"{Path.GetFileName(path)} is larger than {limit} bytes.");
        return await File.ReadAllBytesAsync(path, ct);
    }

    public const string UnavailableCode = "agent_release_unavailable";
    public const string InvalidCode = "agent_release_invalid";

    private static OperatorApiException Unavailable(string message) => new(StatusCodes.Status503ServiceUnavailable, UnavailableCode, message);

    private static OperatorApiException Invalid(string message) => new(StatusCodes.Status502BadGateway, InvalidCode, message);
}
