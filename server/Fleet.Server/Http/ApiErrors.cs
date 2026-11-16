namespace Fleet.Server.Http;

/// <summary>An Operator API failure with the standard <c>{ code, message }</c> body.</summary>
public sealed class OperatorApiException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

/// <summary>Endpoint metadata: errors from this endpoint include the safe <c>message</c> next to the code.</summary>
public sealed class ErrorMessages
{
    public static ErrorMessages Instance { get; } = new();
}

/// <summary>
/// The error codes and bodies shared by every HTTP surface. This namespace depends on nothing else in the Server, so Transport,
/// Security, Hosting and the dashboard can all throw and map these errors without depending on each other.
/// </summary>
public static class ApiErrors
{
    /// <summary>The code of a request whose Operator credential lacks the scope an action needs.</summary>
    public const string ScopeDeniedCode = "insufficient_scope";

    /// <summary>
    /// The HTTP status of a <see cref="Fleet.Core.Coordination.CoordinationException"/> code. Every code not listed is 400, including
    /// <c>enrollment_not_found</c>; the mapping is a wire contract.
    /// </summary>
    internal static int CoordinationErrorStatus(string code) => code switch
    {
        "unauthorized" or "invalid_credential" or "node_unauthorized" or "bundle_not_authorized" or "cliproxy_credential_not_authorized" => 403,
        "not_found" or "node_not_found" or "credential_not_found" or "attempt_not_found" or "target_not_found" or "enrollment_link_not_found" or "revision_not_found" or
            "rollout_not_found" => 404,
        "node_alias_in_use" or "node_revoked" or "node_alias_changed" or "target_not_failed" or "attempt_not_failed" or
            "agent_update_unsupported" or "agent_update_current" or "agent_update_in_progress" or "agent_update_not_cancellable" => 409,
        _ => 400
    };

    // Routes carrying ErrorMessages metadata (every Operator API and dashboard API route) return { code, message }. Every other route keeps { code }.
    internal static Task WriteError(HttpContext context, string code, string message) =>
        context.GetEndpoint()?.Metadata.GetMetadata<ErrorMessages>() is null
            ? context.Response.WriteAsJsonAsync(new { code })
            : context.Response.WriteAsJsonAsync(new { code, message });
}
