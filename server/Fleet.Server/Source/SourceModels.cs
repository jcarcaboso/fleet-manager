using Fleet.Core.Coordination;

namespace Fleet.Server.Source;

public abstract record SourceScanResult
{
    private SourceScanResult() { }

    public sealed record Unchanged(string SourceRevision) : SourceScanResult;
    public sealed record Invalid(string? SourceRevision, IReadOnlyList<SourceDiagnostic> Diagnostics) : SourceScanResult;
    public sealed record Snapshot(AcceptedSourceSnapshot Value) : SourceScanResult;
}

public sealed record SourceDiagnostic(string Code, string Message, string? Path = null);

public interface ISourceScanner
{
    Task<SourceScanResult> ScanAsync(string? lastObservedRevision, CancellationToken cancellationToken);
}

public interface IEnrolledNodeSource
{
    Task<IReadOnlyDictionary<string, NodeId>> GetNodeAliasesAsync(CancellationToken cancellationToken);
}

public sealed record SourceLimits(
    int MaxEntries = 10_000,
    int MaxTreeDepth = 16,
    int MaxPathBytes = 1024,
    long MaxFileBytes = 16 * 1024 * 1024,
    long MaxTotalBytes = 256 * 1024 * 1024,
    long MaxBundleBytes = 16 * 1024 * 1024,
    long MaxMirrorBytes = 512L * 1024 * 1024,
    int MaxMirrorEntries = 100_000,
    int MaxManifestBytes = 1024 * 1024,
    int MaxDiagnostics = 100,
    int MaxWarnings = 1_000,
    int MaxWarningWinners = 1_000,
    int MaxWarningLocations = 100,
    int MaxWarningBytes = 256 * 1024,
    int MaxWarningMessageChars = 2_048,
    int ScanTimeoutSeconds = 180,
    int GitCommandTimeoutSeconds = 120);
