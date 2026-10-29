/**
 * Request-body binding, as the Server does it. The Server reads every JSON body into a C# record with
 * `UnmappedMemberHandling = Disallow` (`WireJson.Configure`): a member that is not in the record, a value of the wrong type, a missing
 * `[JsonRequired]` member, a missing body or a body that is not an object is `400 invalid_request`
 * ("The request is malformed or a parameter is invalid.") before any route logic runs. Members that are not required and not sent keep
 * the record's default (`null`, `false`, `0` or the declared default). Names match case-insensitively (web defaults).
 *
 * The shapes below are the records of `server/Fleet.Server/Transport/OperatorApi.cs` and `Dashboard/DashboardEndpoints.cs`
 * (`RetryRequest`, `RemoveNodeRequest`, `LinkRequest`, `SelectionRequest`, `CliProxySelectionPolicy`, `LoginRequest` and the account requests) and
 * `WireModels.cs` (`OperatorRenameAliasRequest`, `IssueStateRequest`, `AgentUpdatesRequest`). Routes without a body parameter (`revoke`,
 * `disk-usage/refresh`, `agent-update`, `agent-update/cancel`, `logout`, `source/rescan`, `cliproxy/refresh`, `accounts/{name}/delete`) ignore
 * whatever is posted, like the Server.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** `string` and the collections accept `null` (nullable reference types); `int` is an Int32, `long` an Int64 (JSON numbers only, no strings). */
export type Kind = 'string' | 'int' | 'int?' | 'long' | 'bool' | 'bool?' | 'strings' | 'boolMap' | Shape;

export interface Shape {
  /** C# member name in camelCase -> type. */
  fields: Record<string, Kind>;
  /** Members marked `[JsonRequired]`: they must be present (null is allowed when the type is nullable). */
  required?: string[];
}

const POLICY: Shape = {
  fields: { includeNew: 'bool', disabledFamilies: 'strings', modelOverrides: 'boolMap', enabledFamilies: 'strings', skipClaudeModelsForOtherClients: 'bool' },
};

export const SHAPES = {
  login: { fields: { name: 'string', password: 'string' } },
  changePassword: { fields: { currentPassword: 'string', newPassword: 'string' } },
  createAccount: { fields: { name: 'string', password: 'string', scope: 'string' } },
  accountScope: { fields: { scope: 'string' } },
  accountPassword: { fields: { password: 'string' } },
  rename: { fields: { currentAlias: 'string', alias: 'string' } },
  retry: { fields: { target: 'string' } },
  remove: { fields: { alias: 'string' } },
  issueState: { fields: { id: 'string', action: 'string', hours: 'int?' }, required: ['id', 'action'] },
  link: { fields: { alias: 'string', expiresInSeconds: 'int' } },
  selection: { fields: { baseUrl: 'string', version: 'long', policy: POLICY } },
  agentUpdates: { fields: { nodes: 'strings', allOutdated: 'bool?' } },
} satisfies Record<string, Shape>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape of the body that `POST <path>` binds, or `null` when the route takes no body (or is no route). */
export function shapeFor(path: string): Shape | null {
  if (path === 'login') return SHAPES.login;
  if (path === 'account/password') return SHAPES.changePassword;
  if (path === 'accounts') return SHAPES.createAccount;
  const a = /^accounts\/[^/]+\/(scope|password)$/.exec(path);
  if (a) return a[1] === 'scope' ? SHAPES.accountScope : SHAPES.accountPassword;
  if (path === 'nodes/rename') return SHAPES.rename;
  if (path === 'issues/state') return SHAPES.issueState;
  if (path === 'enrollment-links') return SHAPES.link;
  if (path === 'cliproxy/selection') return SHAPES.selection;
  if (path === 'agent-updates') return SHAPES.agentUpdates;
  const m = /^nodes\/([^/]+)\/(retry|remove)$/.exec(path);
  if (m) {
    /* remove is `{id:guid}`: any other segment is not this route. */
    if (m[2] === 'remove') {
      let id: string;
      try { id = decodeURIComponent(m[1]!); } catch { return null; }
      return GUID.test(id) ? SHAPES.remove : null;
    }
    return SHAPES.retry;
  }
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function valueFits(kind: Kind, v: unknown): boolean {
  if (typeof kind === 'object') return v === null || (isObject(v) && bindShape(kind, v) !== null);
  switch (kind) {
    case 'string': return v === null || typeof v === 'string';
    case 'int': return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 2 ** 31 - 1;
    case 'int?': return v === null || valueFits('int', v);
    case 'long': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'bool': return typeof v === 'boolean';
    case 'bool?': return v === null || typeof v === 'boolean';
    case 'strings': return v === null || (Array.isArray(v) && v.every(x => x === null || typeof x === 'string'));
    case 'boolMap': return v === null || (isObject(v) && Object.values(v).every(x => typeof x === 'boolean'));
  }
}

/** The members of `value` under their canonical names, or `null` when the value does not bind to the shape. */
function bindShape(shape: Shape, value: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const byLower = new Map(Object.keys(shape.fields).map(k => [k.toLowerCase(), k]));
  for (const [key, v] of Object.entries(value)) {
    const name = byLower.get(key.toLowerCase());
    if (!name) return null; // unmapped member
    const kind = shape.fields[name]!;
    if (!valueFits(kind, v)) return null;
    out[name] = typeof kind === 'object' && isObject(v) ? bindShape(kind, v) : v;
  }
  for (const name of shape.required ?? []) if (!(name in out)) return null;
  return out;
}

/**
 * Binds a request body to a shape. `body` is the parsed JSON (`null` when the request had no body, the body was not valid JSON or it was
 * the literal `null`). Returns the members under their canonical names, or `null` for a body the Server answers with 400 invalid_request.
 */
export function bindBody(shape: Shape, body: Json): Record<string, any> | null {
  return isObject(body) ? bindShape(shape, body) : null;
}
