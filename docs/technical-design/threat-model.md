# Server and CLI POC threat model

The installation has one Workspace on a private network, fully trusted
Operators, a trusted Server OS and PostgreSQL service, and untrusted network
peers, source content, and Node reports. A private overlay provides reachability
only. The Server does not run Skill content or access a Node filesystem.

| Threat | Implemented control | Verification or remaining boundary |
|---|---|---|
| Network peer impersonates an Operator | HTTPS plus a configured random bearer credential; only its SHA-256 is stored on the Server. | HTTP and wrong-scheme authorization tests. A stolen Operator token grants full administrative access. Rotate its configured digest after theft. |
| Network peer signs in to the dashboard | Accounts with PBKDF2-SHA256 password hashes, a per-address sign-in rate limit, `__Host-` SameSite=Strict HttpOnly session cookies, and CSRF tokens. The default `fleet`/`fleet` account must change its password before any other route answers. | Account tests cover the forced change, scope enforcement, the last admin, session invalidation by security stamp, and the admin re-check under the account lock (a request that waited while its account was demoted cannot act). Sign-ins, failed sign-ins and account changes are audited with the account they concern, never the password. Until the default password is changed, anyone who reaches the dashboard first can claim the account, including after an upgrade from token sign-in; this is accepted for self-hosted installs, so sign in right after installing or upgrading. |
| Node calls an Operator route | Separate authentication policies. | Hosting tests submit a Node certificate to an Operator route and reject Operator bearer auth on Node routes. |
| Node impersonation without its private key | P-256 signed CSR and client certificate authentication through TLS. | Certificate signature/chain tests and local HTTPS smoke exercise. TestServer certificate injection alone is not evidence of a TLS handshake. |
| Enrollment token replay | Atomic consumption, CSR-bound response retry window, unique Node/credential identity. | PostgreSQL enrollment tests. A thief with an unused token can enroll first; token delivery must stay private. |
| Revoked or expired certificate reuse | Chain validation and current Node/credential lookup on each request. Expired, non-revoked Node certificates authorize renewal only; the issuing CA must remain valid. | Expired-certificate renewal, endpoint isolation, and revocation tests. Requests already executing may complete during revocation. |
| Expired Server or dashboard certificate stops the Fleet | The Server renews both from the CA before expiry and keeps its own key in memory. It issues nothing a holder of the CA key could not already issue, and leaves certificates from another CA alone. The CA certificate itself needs an Operator; the Server warns in its last 90 days. | `TlsCertificateRenewalTests`, `scripts/smoke-tls-renewal.sh`. Agents also accept the public roots built into the client, so a public CA's certificate for the Server's name would be trusted. |
| Concurrent reports overwrite terminal state | Coordination owns transactions and terminal transition checks. | PostgreSQL duplicate, stale, and concurrent report tests. |
| Source entry escapes its Skill tree | Read Git objects without checkout; reject links, unsafe paths, portable-name collisions, and bounded source content. | Git fixture tests. Agent extraction and filesystem containment remain later work. |
| Credential or content leak through errors | No body logging; CLI omits failed response bodies; source errors use bounded diagnostics. | Hosting and CLI error-redaction tests. Operator CLI enrollment output deliberately contains the new token. |
| Unassigned or revoked Node requests the CLIProxyAPI key | The key endpoint requires Node mTLS and a current `cliproxy` Assignment. The Server reads the key from ordinary deployment configuration and sends `Cache-Control: no-store`. | Authorization and unavailable-key tests cover unassigned and revoked Nodes. Every assigned Node receives the same Workspace key, so revoke that key if an assigned Node account is compromised. |
| Proxy key leaks through desired state or client configuration | Assignments contain only mode, endpoint, and model. The Agent stores the key in private state; Codex command authentication and OpenCode file substitution reference that file. | Wire and configuration tests reject inline secrets and leave OAuth stores unchanged. A same-user process on an assigned Node can still read the key. |
| Malicious or compromised CLIProxyAPI endpoint | The Server requires HTTPS, rejects redirects, bounds time and response bytes, and validates a non-empty catalog before replacing its cache. Agents accept catalogs only from their authenticated Server and verify the assigned endpoint. | The proxy still receives prompts, responses, and tool traffic. Operators must trust it as an inference provider and use a dedicated endpoint and key. |
| Oversized input exhausts memory | Request, response, page, tree, file, entry-count, concurrency and time limits. | Boundary tests. Git fetch still needs disk quotas and a measured repository-transfer budget before release. |
| Malicious configured Git remote or Server administrator | Outside protection from trusted Operators. Git commands use argument lists and no shell. | A compromised Server OS can steal the issuing key and all Bundle bytes. Restore requires credential and key rotation procedures. |
| Copied Node software private key | Active credential revocation limits future use. | Hardware binding is excluded. Copying the private key can clone a Node until revocation. |
| Compromised Server pushes its own Agent binary | Agents run only binaries listed in a release manifest signed with the Ed25519 release key, checked against the public keys compiled into the Agent. The Server has no signing key; it only mirrors the signed files. | Agent updater tests refuse a tampered manifest, a manifest signed by another key and an Agent built without keys. A compromised Server can still withhold updates or ask for the release it serves. |
| Compromised GitHub release assets | The same signature check, on the Server before it caches anything and on the Agent before it stages a binary. Downloads use HTTPS, follow only GitHub's release-asset redirect, and are bounded in size and time. | Server mirror tests reject an untrusted signature, a tampered manifest, an archive that does not match the signed digest and other redirects. |
| Replay of an older signed release | The signature covers the version and every binary digest; the Agent refuses a version that is not newer than its own, and a manifest whose version is not the requested one. Rollback is a local command only. | Agent updater tests cover an older release and an older release under a newer name. |
| Leaked release signing key | The private key exists only as the `AGENT_RELEASE_SIGNING_KEY` secret of the `release-signing` environment. Two trusted keys allow rotation in one release. | Nodes that never receive the rotation release keep trusting the leaked key and need a manual upgrade. See the [release key guide](../../clients/bins/fleet-agent/release-keys/README.md). |
| Oversized or slow release download | Size limits from the signed manifest, absolute caps (64 KiB manifest, 64 MiB binary, 96 MiB archive on the Server) and time limits on both sides. The Server reads archives with its own bounded tar reader: at most 128 MiB unpacked and 64 KiB per PAX or GNU long-name header, checked before anything is allocated. A download that fails any check is deleted. A new binary must answer `--version` within 10 seconds before `current` changes. | Server and Agent tests cover oversized and truncated binaries, archives whose metadata headers claim 1 GiB, archives that unpack too far and truncated archives, and a hanging smoke test. |
| Broken new Agent version | A trial in `update.json`: more than 3 starts or 10 minutes without a successful poll switch `current` back, and the restored version reports the failure. | Unit tests and `scripts/smoke-agent-update.sh` (a real rollback under `systemd --user`). A binary that passes `--version` but crashes before it records its start loops under the service manager; `fleet-agent update rollback` recovers it. |
| Same-user attacker replaces `current` or a staged version | Out of scope, as for every other state file. | The state directory is mode 0700. |

The Server ignores proxy certificate headers and terminates TLS in Kestrel.
The CLI disables redirects, verifies Server trust, and can load a private CA.
The development HTTP exception requires an explicit flag and loopback access.

Public-internet exposure, malicious authenticated Operators, hardware-backed
Node keys, production secret distribution, and protection from a compromised
Server OS are outside this POC. Open release work includes issuing-key rotation,
backup/restore drills, private security reporting, deletion policy, dependency
review ownership, measured load limits, and the complete Agent recovery protocol.

## Node Agent implementation boundary

The Agent authenticates the Server with TLS and uses locally generated P-256
credentials for mTLS. Enrollment tokens come from a private file or environment,
never a command-line token argument. Credential and report state use bounded
regular files in a private directory with atomic replacement and fsync.

CLIProxyAPI adds one shared Workspace secret to this boundary. The Server loads
it from deployment-managed configuration only after authorizing the Node. The Agent
keeps its copy in private state and refreshes it during normal reconciliation.
The source manifest, Assignment, Bundle, database, audit log, and client config
contain no raw key. Key rotation and revocation procedures are in the
[CLIProxyAPI operations guide](cliproxy-operations.md).

Bundle digests, sizes, schemas, paths, file types, and executable flags are
validated before activation. The Agent never executes installed content.
Unowned Skill directories cause conflicts; only receipt-owned names can be
replaced or removed. Local observations also enforce file, depth, and byte
limits, so a large drifted file fails safely. Journals restore observed previous
content after interrupted activation. Agent-state and Target locks serialize
normal concurrent processes.

An attacker already running as the same operating-system user can change its
files and race path checks; this POC does not claim containment against that
attacker. Observed symlinks and hard links are rejected. Corrupt receipts fail
closed. The Server 0.2.0 protocol cannot record a separate post-success drift or
recovery condition; the Agent repairs cached active state and reports this limit
in its installation guide.
