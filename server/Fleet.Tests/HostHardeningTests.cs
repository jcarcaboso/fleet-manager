using System.Security.Cryptography;
using System.Text;
using Fleet.Server.Hosting;
using Fleet.Server.Security;
using Microsoft.Extensions.Configuration;

namespace Fleet.Tests;

public sealed class HostHardeningTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("http://0.0.0.0:8080", true)]
    [InlineData("http://localhost:8080", false)]
    [InlineData("https://localhost:7443/admin", false)]
    [InlineData("https://user:password@localhost:7443", false)]
    public void Unsafe_or_implicit_listeners_are_rejected(string? urls, bool allowHttp)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["urls"] = urls }).Build();
        Assert.Throws<InvalidOperationException>(() => ListenerPolicy.Validate(configuration, allowHttp));
    }

    [Theory]
    [InlineData("https://127.0.0.1:7443", false)]
    [InlineData("https://10.0.0.10:7443", false)]
    [InlineData("http://[::1]:8080", true)]
    public void Explicit_TLS_and_opted_in_loopback_listeners_are_accepted(string urls, bool allowHttp)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["urls"] = urls }).Build();
        ListenerPolicy.Validate(configuration, allowHttp);
    }

    [Fact]
    public void Operator_configuration_rejects_ambiguous_identity_and_shared_tokens()
    {
        var options = new FleetOptions();
        Assert.False(options.HasValidOperators());
        options.Operators.Add("alice", Digest("alice-token"));
        options.Operators.Add("bob", Digest("bob-token"));
        Assert.True(options.HasValidOperators());
        options.OperatorName = "alice";
        options.OperatorTokenSha256 = Digest("legacy-token");
        Assert.False(options.HasValidOperators());
        options.OperatorName = "legacy";
        Assert.True(options.HasValidOperators());
        options.Operators["bob"] = options.Operators["alice"].ToUpperInvariant();
        Assert.False(options.HasValidOperators());
    }

    [Fact]
    public void Metrics_use_bounded_outcomes_and_omit_source_values()
    {
        using var metrics = new FleetMetrics();
        metrics.RecordSourceScan("secret://credential@host");
        metrics.RecordSourceScan("accepted");
        metrics.RecordRequest("poll", 403, .1, 0);
        var values = metrics.Snapshot();
        Assert.Equal(1, values["source.failed"]);
        Assert.Equal(1, values["source.accepted"]);
        Assert.Equal(1, values["poll.unauthorized"]);
        Assert.DoesNotContain(values.Keys, x => x.Contains("secret", StringComparison.Ordinal));
    }

    private static string Digest(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
