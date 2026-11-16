using System.Text.Json.Serialization;

namespace Fleet.Core.Coordination;

// Source publication: the snapshot the scanner hands over, its result, and source scan records.

public sealed record TargetDescriptor(string Base, string Path);

public sealed record SnapshotBundle(string Digest, string Schema, long Size, byte[] Content);

public sealed record SnapshotSkill(string Name, string BundleDigest);

public sealed record SnapshotFile(string Name, string? BundleDigest);

public sealed record AiClientAssignment(
    string Schema,
    string Client,
    string Mode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? BaseUrl = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Model = null);

public sealed record SnapshotTarget(
    NodeId NodeId,
    string TargetName,
    TargetDescriptor Descriptor,
    IReadOnlyList<SnapshotSkill> Skills,
    SnapshotFile? File = null,
    AiClientAssignment? AiClient = null);

public sealed record SourceWarning(
    string Code,
    string Message,
    IReadOnlyList<string> SourceLocations);

/// <summary>The tip commit of an accepted source revision: first message line, author name (never the email) and committer date.</summary>
public sealed record CommitMetadata(string? Subject, string? Author, DateTimeOffset? CommittedAt);

public sealed record AcceptedSourceSnapshot(
    string SourceRevision,
    IReadOnlyList<SnapshotBundle> Bundles,
    IReadOnlyList<SnapshotTarget> Targets,
    IReadOnlyList<SourceWarning> Warnings,
    DateTimeOffset ObservedAt,
    CommitMetadata? Commit = null);

public enum PublicationOutcome
{
    Accepted,
    Unchanged,
}

public sealed record PublicationResult(
    PublicationOutcome Outcome,
    string SourceRevision,
    DesiredRevisionId? DesiredRevisionId,
    RolloutId? RolloutId,
    int ChangedAssignmentCount);

public enum SourceScanOutcome { Accepted, Unchanged, Invalid, Failed }

public sealed record RecordSourceScan(
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy = null);

public sealed record SourceScanStatus(
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy);

public sealed record SourceScanEntry(
    Guid ScanId,
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy);
