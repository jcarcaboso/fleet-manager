namespace Fleet.Core.Coordination;

/// <summary>Publication of source revisions and the record of each source scan.</summary>
public interface ISourcePublication
{
    Task<PublicationResult> AcceptSourceSnapshotAsync(
        AcceptedSourceSnapshot snapshot,
        CancellationToken cancellationToken = default);

    Task RecordSourceScanAsync(
        RecordSourceScan scan,
        CancellationToken cancellationToken = default);
}
