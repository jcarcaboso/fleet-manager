namespace Fleet.Server.Source;

/// <summary>
/// The <c>Source:*</c> configuration keys and their defaults. Each member reads the configuration when it is called, as the callers
/// always did: a reloaded configuration file applies to the next scan or request, and an invalid value fails only the read that needs
/// it (one scan, not Server startup). Binding the whole section into an options class would change both, so this is not one.
/// </summary>
public sealed class SourceSettings(IConfiguration configuration)
{
    private static readonly SourceLimits Defaults = new();

    /// <summary>The Git remote. Blank means source scanning is disabled.</summary>
    public string? Remote => configuration["Source:Remote"];

    public string MirrorPath => configuration["Source:MirrorPath"] ?? ".local/source.git";

    /// <summary>Not range-checked here: the polling service checks it when it starts.</summary>
    public int PollIntervalSeconds => configuration.GetValue("Source:PollIntervalSeconds", 1800);

    public int ScanTimeoutSeconds => configuration.GetValue("Source:ScanTimeoutSeconds", Defaults.ScanTimeoutSeconds);

    /// <summary>The request timeout of <c>POST source/rescan</c>: the scan's own limit plus time to record it.</summary>
    public TimeSpan RescanRequestTimeout => TimeSpan.FromSeconds(ScanTimeoutSeconds + 30);

    /// <summary>The scanner limits, with the configurable ones read in this order.</summary>
    public SourceLimits Limits() => Defaults with
    {
        MaxMirrorBytes = configuration.GetValue("Source:MaxMirrorBytes", Defaults.MaxMirrorBytes),
        MaxMirrorEntries = configuration.GetValue("Source:MaxMirrorEntries", Defaults.MaxMirrorEntries),
        ScanTimeoutSeconds = ScanTimeoutSeconds,
        GitCommandTimeoutSeconds = configuration.GetValue("Source:GitCommandTimeoutSeconds", Defaults.GitCommandTimeoutSeconds),
    };
}
