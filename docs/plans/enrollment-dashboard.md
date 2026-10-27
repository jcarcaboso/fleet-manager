# Dashboard enrollment links

Available in Server and Agent 0.3.0. Server 0.2.0 needs an upgrade and the new
migration before this flow is available. Existing enrolled Nodes and enrollment
with CA/token files remain supported.

## Enroll a Node

1. Open the dashboard at `https://your-server:7444` and sign in with an Operator
   token. The dashboard is a separate container; the Server's old
   `https://your-server:7443/dashboard` address redirects there.
2. Choose **Add machine**, enter a unique alias and create a link. It expires
   after 15 minutes by default, with a maximum lifetime of one hour.
3. Run `fleet-agent enroll --link` on the Node and paste the link at the prompt.
4. The Agent generates its P-256 key and CSR locally, verifies HTTPS, and enrolls.
   No separate CA or enrollment JSON download is needed.
5. Run `fleet-agent service install` and `fleet-agent service start`. The **Add
   machine** dialog shows when the machine first checks in.

The alias is bound to the link and must match the Node's key in `fleet.yml`.
The dashboard also supports alias changes. Update the source entry after a
rename; the Node's identity remains the same.

## Link format and trust

The format is `https://HOST[:PORT]/enroll#fleet-v1=PAYLOAD`. The payload is
unpadded base64url of UTF-8 JSON with exactly these fields:

```json
{
  "version": 1,
  "serverUrl": "https://fleet.home.arpa:7443",
  "token": "one-time enrollment token",
  "alias": "homelab-mini",
  "caPem": "public CA certificate in PEM format",
  "expiresAt": "2026-09-08T15:15:00Z"
}
```

Embedding the public CA allows normal TLS certificate and hostname verification
from the first request. There is no unverified download or TLS bypass. Changing
the CA requires a new link; leaf certificate rotation under the same CA does not.
The Operator's browser must trust the Server and dashboard certificates (the
homelab dashboard has its own certificate from the same CA), which may require
installing the homelab CA on that Operator machine once. Enrollment links name the Server
(`/enroll` stays on the Server), not the dashboard.

The Agent accepts at most 16 KiB, requires matching HTTPS origins and exact
paths, rejects extra fields and expired payloads, and never follows redirects.
Obtain the link from your trusted Operator. Replacing an entire link replaces
both the server and its trust root.

The fragment stays out of ordinary HTTP requests and access logs. Opening the
link shows instructions and removes the fragment from browser history without
redeeming it. The dashboard uses no third-party resources or analytics and puts
neither tokens nor links in browser storage. Clipboard tools, screenshots, and
browser synchronization can still expose a link. Keep it private until consumed
or expired.

## Retry and revocation

The database stores token digests, bound aliases, expiry, and revocation state.
Enrollment consumes a token atomically. A different CSR cannot reuse it. Exact
CSR retries recover a lost response during the existing bounded delivery window;
the Agent preserves that pending CSR locally.

Use **Revoke link** while its result is displayed. Revocation blocks enrollment
and delivery retries, but does not revoke an already enrolled Node's identity.
Clearing a link from the screen does not revoke it. This first dashboard does
not list past authorizations or recover their secret links. Its authenticated
revoke endpoint can revoke an authorization if its ID was retained.

## Sessions and deployment

### Revoke or remove a Node

The Node table provides **Revoke** and **Remove** actions. Revocation invalidates
all Node certificates and retains its record and alias. Removal requires typing
the exact alias and deletes the Node, credentials, assignments, attempts, and
enrollment delivery records in one transaction. It works on active or revoked
Nodes and frees the alias. Audit events and shared rollout/bundle data remain.
A changed alias or missing Node causes the request to fail rather than target a
replacement. The existing database foreign keys provide cleanup; no new migration
is required for these actions.

Stop the Agent on the machine. Neither action remotely uninstalls Skills or
erases its local state. Remove the source's `fleet.yml` entry unless reusing the
alias deliberately. A replacement Node needs fresh enrollment, and ownership
conflicts on old Skill directories still require local resolution. The Node
actions are available in Server `0.4.0`.

### Browser sessions

Operator tokens create 30-minute Secure, HttpOnly, SameSite=Strict browser
sessions. The dashboard runs at its own origin and calls the Server's
`/dashboard/api` with credentials, so the dashboard and the Server must be on the
same site (HTTPS, same host name or registrable domain; ports and subdomains may
differ). Mutations require an antiforgery token and `Origin` equal to the
configured dashboard origin. See the
[separate dashboard plan](separate-dashboard.md) for the CORS, cookie and Origin
rules.
Removing or rotating an Operator credential invalidates its sessions. Restarting
the server also ends sessions, whose encryption keys are held in memory.
Dashboard cookies cannot authenticate Operator bearer API or Node mTLS calls.
The server continues to terminate Node mTLS directly.

Set `Fleet__PublicUrl` to the Server's externally reachable HTTPS origin without
a path and `Fleet__DashboardOrigin` to the dashboard's. Without either, the
dashboard API is not available; with an empty `Fleet__DashboardOrigin`, `/` and
`/dashboard` on the Server answer `404 dashboard_not_configured`. Enrollment links
never use an untrusted Host header, and the dashboard API rejects requests that
reach the Server through another origin.

Homelab Compose derives the Server URL from `FLEET_HOSTNAME` and `FLEET_PORT`, with
an optional `FLEET_PUBLIC_URL` override, and the dashboard URL from
`FLEET_HOSTNAME` and `FLEET_DASHBOARD_PORT` (default 7444), with an optional
`FLEET_DASHBOARD_URL` override. Use an explicit bracketed URL for IPv6. These
settings do not change DNS or regenerate TLS certificates.

`Fleet__EnrollmentCaCertificatePath` optionally selects another public CA file
for server TLS trust. It defaults to `Fleet__IssuerCertificatePath`, matching the
homelab setup. Mount the appropriate public CA when server TLS uses a separate
CA. The file must not contain a private key.

Apply `BindAndRevokeEnrollmentAuthorizations` before starting the upgraded
server. Homelab Compose runs migrations during deployment. Back up PostgreSQL
before upgrading using the existing backup procedure.

Server tests cover session isolation, CORS, CSRF/Origin rejection, trust payload,
alias binding, expiry, revocation, exact CSR retries, and alias collisions.
Agent tests cover bounded line input, malformed payloads, secret redaction,
origin/path validation, expiry, and flag conflicts.
