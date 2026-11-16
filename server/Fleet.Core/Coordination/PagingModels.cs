namespace Fleet.Core.Coordination;

// Paging of Operator lists.

/// <summary>How a list is ordered: by ID (the default, cursor is the last ID) or newest first by its timestamp, then ID.</summary>
public enum PageOrder { Id, Newest }

public sealed record PageRequest(int Limit, string? Cursor = null, PageOrder Order = PageOrder.Id)
{
    public const int MaximumLimit = 100;
}

public sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor);
