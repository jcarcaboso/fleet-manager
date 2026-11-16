namespace Fleet.Core.Coordination;

// What an Agent reports besides Attempt results: failure detail, disk usage, telemetry, drift, repair failures and update progress.

/// <summary>Bounded description of why an Attempt failed, sent by the Agent after its terminal report.</summary>
public sealed record AttemptDetail(string? Diagnostic, string? Path, string? Step);

/// <summary>One measured volume as an Agent reports it. <c>Label</c> is <c>home</c> or <c>state</c>.</summary>
public sealed record DiskVolume(string Label, long TotalBytes, long UsedBytes, long AvailableBytes);

public sealed record DiskUsageReport(IReadOnlyList<DiskVolume> Volumes);

/// <summary>What an Agent reports about itself and its machine. Only <c>AgentVersion</c> is required; the other fields are null when the Agent could not read them.</summary>
public sealed record AgentTelemetryReport(string AgentVersion, string? OsName, string? OsVersion, string? OsKernel, string? Arch,
    string? Hostname, string? User, string? InstallMethod, string? ServiceManager, string? StateDirectory);

/// <summary>What an Agent reports after repairing drift: the assigned Target and its Target-relative file paths.</summary>
public sealed record DriftReport(string Target, IReadOnlyList<string> Files);

/// <summary>
/// An idle repair of a current Assignment that failed after the Assignment's own Attempt succeeded. <c>Diagnostic</c>, <c>Path</c> and
/// <c>Step</c> follow <see cref="AttemptDetailRules"/>.
/// </summary>
public sealed record RepairFailure(string Target, AssignmentId AssignmentId, string ErrorCode, string Diagnostic, string? Path, string? Step);

/// <summary>Every repair that currently fails on a Node. The Server stores exactly these; an empty list clears them.</summary>
public sealed record RepairFailureReport(IReadOnlyList<RepairFailure> Failures);

/// <summary>
/// What an Agent reports about an update: the request it answers (<c>UpdateId</c> from the poll), the target version, the new state
/// and, for <c>failed</c>, an error code.
/// </summary>
public sealed record AgentUpdateReport(Guid UpdateId, string Version, string State, string? ErrorCode);
