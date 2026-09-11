using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Transport;

namespace Fleet.Tests;

public sealed class WireContractTests
{
    [Fact]
    public void Node_page_matches_the_fixture_read_by_the_Rust_CLI()
    {
        var page = new Page<NodeStatus>([new(new(Guid.Parse("00000000-0000-0000-0000-000000000001")),
            "linux-example", false, null, FreshnessState.NeverContacted)], null);
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        WireJson.Configure(options);
        var actual = JsonSerializer.SerializeToNode(page, options);
        var expected = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contracts/operator/nodes-page.json")));
        Assert.True(JsonNode.DeepEquals(expected, actual));
    }

    [Fact]
    public void Enrollment_delivery_fixture_uses_the_shared_response_contract()
    {
        var text = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contracts/operator/enrollment-token-response.json"));
        var value = JsonSerializer.Deserialize<EnrollmentAuthorization>(text, JsonSerializerOptions.Web);
        Assert.NotNull(value);
        Assert.Equal("enrollment-token-fixture", value.Token);
        Assert.Equal(new DateTimeOffset(2026, 9, 7, 0, 15, 0, TimeSpan.Zero), value.ExpiresAt);
    }

    [Fact]
    public void Skill_assignments_omit_the_managed_file_extension()
    {
        var assignment = new AgentAssignment(
            new(Guid.NewGuid()), new(Guid.NewGuid()), new(Guid.NewGuid()), new(Guid.NewGuid()),
            "skills", new("home", ".agents/skills"), []);
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        WireJson.Configure(options);

        var json = JsonSerializer.SerializeToNode(assignment, options)!.AsObject();

        Assert.False(json.ContainsKey("file"));
    }
}
