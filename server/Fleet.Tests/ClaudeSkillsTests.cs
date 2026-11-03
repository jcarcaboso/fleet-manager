using System.Text.Json;
using Fleet.Core.Coordination;

namespace Fleet.Tests;

public sealed class ClaudeSkillsTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("disk-usage,agent-update", false)]
    [InlineData("claude-skills-v2", false)]
    [InlineData("claude-skills", true)]
    [InlineData("disk-usage, CLAUDE-SKILLS ,agent-update", true)]
    public async Task Poll_delivers_Claude_skills_only_after_the_Agent_announces_support(string? capabilities, bool supported)
    {
        var node = await fixture.EnrollAsync("claude-skills-" + Guid.NewGuid().ToString("N"));
        var bundle = OperatorApiFixture.Bundle("fleet.bundle/v1", "Claude skills");
        await fixture.PublishRawAsync("claude-skills-" + Guid.NewGuid().ToString("N"), [bundle],
        [
            new(node.NodeId, "skills/claude", new("home", ".claude/skills"), [new("review", bundle.Digest)])
        ]);

        var response = await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate, capabilities: capabilities);
        Assert.Equal(200, response.Response.StatusCode);
        using var body = await JsonDocument.ParseAsync(response.Response.Body);
        var assignment = body.RootElement.GetProperty("assignment");
        if (supported)
        {
            Assert.Equal("skills/claude", assignment.GetProperty("targetName").GetString());
            Assert.Equal(".claude/skills", assignment.GetProperty("target").GetProperty("path").GetString());
        }
        else
        {
            Assert.Equal(JsonValueKind.Null, assignment.ValueKind);
            var upgraded = await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate, capabilities: "claude-skills");
            using var upgradedBody = await JsonDocument.ParseAsync(upgraded.Response.Body);
            Assert.Equal("skills/claude", upgradedBody.RootElement.GetProperty("assignment").GetProperty("targetName").GetString());
        }
    }
}
