using Fleet.Core.Coordination;

namespace Fleet.Tests;

public sealed class Phase4RulesTests
{
    [Fact]
    public void Commit_metadata_loses_control_characters_is_cut_without_splitting_a_surrogate_pair_and_empties_to_null()
    {
        var cleaned = CommitMetadataRules.Sanitize(new("  a\tb\u0000c\u009bd\u2028e  ", "Ada\nLovelace", new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero)))!;
        Assert.Equal("abcde", cleaned.Subject);
        Assert.Equal("AdaLovelace", cleaned.Author);
        Assert.Equal(new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero), cleaned.CommittedAt);

        // The 200th character would be half of an emoji: the whole emoji goes.
        var cut = CommitMetadataRules.Sanitize(new(new string('x', 199) + "\U0001F600 tail", null, null))!;
        Assert.Equal(new string('x', 199), cut.Subject);
        Assert.Null(cut.Author);

        Assert.Null(CommitMetadataRules.Sanitize(null));
        Assert.Null(CommitMetadataRules.Sanitize(new(" \t\n", "\u0000", null)));
        Assert.NotNull(CommitMetadataRules.Sanitize(new(null, null, DateTimeOffset.UnixEpoch)));
        var offsetDate = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.FromHours(2));
        var utcDate = CommitMetadataRules.Sanitize(new(null, null, offsetDate))!.CommittedAt!.Value;
        Assert.Equal(TimeSpan.Zero, utcDate.Offset);
        Assert.Equal(offsetDate, utcDate);
    }

    [Theory]
    [InlineData("skills", new[] { "a/b" }, true)]
    [InlineData("skills", new[] { "..a/b..c/..d" }, true)]
    [InlineData("skills", new string[0], false)]
    [InlineData("skills", new[] { "/abs" }, false)]
    [InlineData("skills", new[] { "\\abs" }, false)]
    [InlineData("skills", new[] { "C:/abs" }, false)]
    [InlineData("skills", new[] { "a/../b" }, false)]
    [InlineData("skills", new[] { ".." }, false)]
    [InlineData("skills", new[] { "a\tb" }, false)]
    [InlineData("", new[] { "a" }, false)]
    public void Drift_reports_need_a_target_and_relative_paths(string target, string[] files, bool valid)
    {
        if (valid) DriftRules.Validate(new(target, files));
        else Assert.Equal("invalid_request", Assert.Throws<CoordinationException>(() => DriftRules.Validate(new(target, files))).Code);
    }

    [Theory]
    [InlineData(IssueStateAction.Snooze, 1, true)]
    [InlineData(IssueStateAction.Snooze, 168, true)]
    [InlineData(IssueStateAction.Snooze, 0, false)]
    [InlineData(IssueStateAction.Snooze, 169, false)]
    [InlineData(IssueStateAction.Snooze, null, false)]
    [InlineData(IssueStateAction.Acknowledge, null, true)]
    [InlineData(IssueStateAction.Acknowledge, 5, false)]
    [InlineData(IssueStateAction.Reopen, 5, false)]
    public void Snooze_needs_hours_from_1_to_168_and_the_other_actions_do_not_take_them(IssueStateAction action, int? hours, bool valid)
    {
        if (valid) IssueStateRules.ValidateHours(action, hours);
        else Assert.Equal("invalid_request", Assert.Throws<CoordinationException>(() => IssueStateRules.ValidateHours(action, hours)).Code);
    }
}
