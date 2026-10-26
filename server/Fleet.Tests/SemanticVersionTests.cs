using Fleet.Core.Coordination;

namespace Fleet.Tests;

public sealed class SemanticVersionTests
{
    [Theory]
    [InlineData("0.0.0")]
    [InlineData("0.8.1")]
    [InlineData("10.20.30")]
    [InlineData("1.0.0-rc.1")]
    [InlineData("1.0.0-0")]
    [InlineData("1.0.0-alpha-1.x-y")]
    [InlineData("1.0.0-0abc")]
    [InlineData("99999999999999999999.0.0")]
    public void Accepts_core_versions_with_an_optional_prerelease(string text)
    {
        Assert.True(SemanticVersion.TryParse(text, out var version));
        Assert.Equal(text, version.Text);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1")]
    [InlineData("1.2")]
    [InlineData("1.2.3.4")]
    [InlineData("v1.2.3")]
    [InlineData("01.2.3")]
    [InlineData("1.02.3")]
    [InlineData("1.2.03")]
    [InlineData("1.2.3-")]
    [InlineData("1.2.3-.a")]
    [InlineData("1.2.3-a..b")]
    [InlineData("1.2.3-01")]
    [InlineData("1.2.3-a_b")]
    [InlineData("1.2.3+build")]
    [InlineData("1.2.3-rc.1+build")]
    [InlineData(" 1.2.3")]
    [InlineData("1.2.3 ")]
    [InlineData("1.2.3\n")]
    [InlineData("-1.2.3")]
    [InlineData("1.2.x")]
    [InlineData("١.٢.٣")]
    public void Rejects_everything_else(string? text) => Assert.False(SemanticVersion.TryParse(text, out _));

    [Fact]
    public void Parse_throws_for_text_that_is_not_a_version() => Assert.Throws<FormatException>(() => SemanticVersion.Parse("1.2"));

    // The precedence example from semver.org, in ascending order, followed by core-number cases.
    private static readonly string[] Ascending =
    [
        "0.0.0", "0.0.1", "0.1.0", "0.1.9", "0.1.10", "0.2.0", "1.0.0-0", "1.0.0-1", "1.0.0-2", "1.0.0-10", "1.0.0-alpha", "1.0.0-alpha.1",
        "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1-rc.1", "1.0.1", "1.10.0", "2.0.0",
        "10.0.0", "99999999999999999999.0.0", "100000000000000000000.0.0"
    ];

    [Fact]
    public void Orders_versions_by_semver_precedence()
    {
        for (var i = 0; i < Ascending.Length; i++)
            for (var j = 0; j < Ascending.Length; j++)
            {
                var left = SemanticVersion.Parse(Ascending[i]);
                var right = SemanticVersion.Parse(Ascending[j]);
                Assert.Equal(Math.Sign(i.CompareTo(j)), Math.Sign(left.CompareTo(right)));
                Assert.Equal(i == j, left.Equals(right));
                Assert.Equal(i < j, left < right);
                Assert.Equal(i > j, left > right);
                Assert.Equal(i <= j, left <= right);
                Assert.Equal(i >= j, left >= right);
            }
    }

    [Fact]
    public void Equal_versions_compare_equal_and_hash_alike_and_null_is_lowest()
    {
        var a = SemanticVersion.Parse("1.2.3-rc.1");
        var b = SemanticVersion.Parse("1.2.3-rc.1");
        Assert.Equal(0, a.CompareTo(b));
        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
        Assert.Equal(1, a.CompareTo(null));
        Assert.False(a.Equals(null));
        Assert.Equal("1.2.3-rc.1", a.ToString());
        Assert.True(SemanticVersion.Parse("1.0.0").IsPrerelease == false && a.IsPrerelease);
    }

    [Theory]
    [InlineData("0.8.0", "0.8.1", true)]
    [InlineData("0.8.1", "0.8.1", false)]
    [InlineData("0.9.0", "0.8.1", false)]
    [InlineData("0.8.1-rc.1", "0.8.1", true)]
    [InlineData("0.9.0-rc.1", "0.8.1", false)]
    [InlineData("0.8.1", "0.8.1-rc.1", false)]
    [InlineData("0.8.1-beta", "0.8.1-rc.1", true)]
    [InlineData("0.8.9", "0.8.10", true)]
    [InlineData("not a version", "0.8.1", false)]
    public void Outdated_means_lower_than_the_latest_version(string running, string latest, bool expected) =>
        Assert.Equal(expected, AgentTelemetryRules.IsOutdated(running, SemanticVersion.Parse(latest)));

    [Fact]
    public void The_Server_version_is_a_version_without_build_metadata() =>
        Assert.DoesNotContain('+', ServerVersion.Current.Text);
}
