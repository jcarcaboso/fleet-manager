namespace Fleet.Core.Coordination;

public sealed class CoordinationException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
