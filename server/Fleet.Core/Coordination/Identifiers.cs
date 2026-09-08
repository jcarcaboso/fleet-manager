namespace Fleet.Core.Coordination;

public readonly record struct WorkspaceId(Guid Value);
public readonly record struct NodeId(Guid Value);
public readonly record struct CredentialId(Guid Value);
public readonly record struct DesiredRevisionId(Guid Value);
public readonly record struct RolloutId(Guid Value);
public readonly record struct AssignmentId(Guid Value);
public readonly record struct AttemptId(Guid Value);
