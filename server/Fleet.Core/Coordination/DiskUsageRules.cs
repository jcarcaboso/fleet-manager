namespace Fleet.Core.Coordination;

/// <summary>Validation and arithmetic for disk usage reports, shared by the Server route, the coordinator and the Operator views.</summary>
public static class DiskUsageRules
{
    public const int MaximumVolumes = 2;
    public const string HomeLabel = "home";
    public const string StateLabel = "state";

    /// <summary>Throws <c>invalid_request</c> unless the report has one or two distinct known volumes with consistent byte counts.</summary>
    public static void Validate(DiskUsageReport? report)
    {
        var volumes = report?.Volumes;
        if (volumes is null || volumes.Count is < 1 or > MaximumVolumes)
            throw Invalid("volumes must contain one or two entries.");
        var labels = new HashSet<string>(StringComparer.Ordinal);
        foreach (var volume in volumes)
        {
            if (volume is null || volume.Label is not (HomeLabel or StateLabel))
                throw Invalid($"label must be {HomeLabel} or {StateLabel}.");
            if (!labels.Add(volume.Label)) throw Invalid("volume labels must be distinct.");
            if (volume.TotalBytes < 0 || volume.UsedBytes < 0 || volume.AvailableBytes < 0)
                throw Invalid("byte counts must not be negative.");
            // Both operands are non-negative, so the subtraction cannot overflow, unlike used + available.
            if (volume.UsedBytes > volume.TotalBytes - volume.AvailableBytes)
                throw Invalid("usedBytes plus availableBytes must not exceed totalBytes.");
        }
    }

    /// <summary><c>used / (used + available) * 100</c> rounded to one decimal, which is how <c>df</c> computes it. 0 when both are 0.</summary>
    public static double UsedPercent(long usedBytes, long availableBytes)
    {
        var denominator = (decimal)usedBytes + availableBytes;
        return denominator == 0 ? 0 : (double)Math.Round(usedBytes * 100m / denominator, 1, MidpointRounding.AwayFromZero);
    }

    private static CoordinationException Invalid(string message) => new("invalid_request", message);
}
