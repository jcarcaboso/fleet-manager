# Node enrollment and authentication research

Status: accepted direction, 2026-09-02

## Context

The first release is self-hosted. One Server installation governs one
Workspace. Each Node runs an outbound-only Agent. The Server may later expose a
browser-facing admin interface, but Node and Operator authentication remain
separate.

Agents reach the Server only through a local network or an Operator-managed
private overlay such as Tailscale. Fleet does not configure that overlay and
does not support exposing the Server directly to the public internet. The
authentication design still treats the transport network as untrusted.

The enrollment token is already constrained to one Workspace, expires, works
once, is stored only as a digest, and is consumed atomically. This research asks
what identity the Agent should use afterward.

## Compared mechanisms

| Mechanism | Main advantage | Main cost |
|---|---|---|
| Opaque bearer credential over TLS | Small implementation and easy proxy operation | A copied credential can impersonate the Node until revocation |
| Short-lived client certificate with mTLS | Standard proof of private-key possession on every TLS connection | Certificate authority, renewal, and TLS termination need careful operation |
| DPoP-bound access token | Proof of possession works through a conventional TLS proxy | Token endpoint, signed proofs, nonce or clock handling, and replay state add protocol machinery |
| HTTP Message Signatures | Can bind selected headers and content to a Node key | Fleet would still need to define a signing profile and replay policy |

Bearer credentials are possession credentials. Anyone holding one can use it,
so TLS, redaction, short lifetimes, and revocation limit but do not remove clone
risk. [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) defines their use
over HTTP and requires protection in storage and transport.

TLS 1.3 client authentication requires the client to sign the handshake with
the private key matching its certificate. This supplies proof of possession
without a Fleet-specific signing protocol.
[RFC 9846](https://www.rfc-editor.org/rfc/rfc9846/) defines the TLS 1.3
`CertificateVerify` exchange.

DPoP binds access tokens to a key, HTTP method, and target URI. Strict replay
prevention also requires short proof lifetimes and tracking unique proof IDs.
[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) defines those checks and
their storage trade-offs.

HTTP Message Signatures standardize canonical signing of HTTP fields, but the
application still chooses required fields, algorithms, time bounds, key lookup,
and replay rules. [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) does
not provide a complete Node-authentication protocol.

## Accepted POC choice

Use the enrollment token only to bootstrap a Node-generated P-256 key into a
short-lived X.509 client certificate. Use mTLS for ongoing Agent operations.

This choice fits the current security goal better than a durable bearer secret:

- a database read does not reveal Agent private keys;
- a captured certificate or HTTP request cannot authenticate without the key;
- the key registered at enrollment is used immediately;
- TLS supplies the proof-of-possession protocol; and
- ASP.NET Core and Rust TLS implementations already support client
  certificates.

It does not bind an identity to physical hardware. Malware running as the Agent
user can use the key, and a copied software key can clone the Node. Hardware
keys and device attestation remain later hardening options.

The bearer alternative is still viable if simple reverse-proxy operation is
more important than clone resistance. The research does not recommend building
bearer authentication now merely as a migration step.

## Enrollment flow

1. An Operator creates a new-Node enrollment authorization. The Server generates
   32 random bytes, encodes them as an identifiable base64url token, stores only
   a domain-separated SHA-256 digest and metadata, and displays the token once.
2. The default expiry is 10 minutes. The response forbids caching. The token
   never appears in a URL, process argument, cookie, normal log field, or audit
   payload.
3. The Agent generates an ECDSA P-256 private key locally, stores it atomically
   with owner-only permissions, and creates a signed PKCS #10 certificate
   request. [RFC 2986](https://www.rfc-editor.org/rfc/rfc2986.html) defines the
   proof of possession carried by that request.
4. Over server-authenticated TLS, the Agent sends the token in the
   `Authorization` header and the bounded certificate request in the body.
5. The Server validates the request before token consumption. It ignores all
   requested subject names and extensions, verifies the request signature, and
   constructs the certificate fields itself.
6. One PostgreSQL transaction consumes the matching unexpired token, creates the
   Node and credential records, and records the audit event. A conditional
   `UPDATE ... RETURNING` makes concurrent consumption choose one winner under
   PostgreSQL Read Committed semantics.
   [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
   documents the concurrent update behavior.
7. The Server returns the opaque Node ID, client certificate and chain, expiry,
   renewal time, polling policy, and Server time. The Agent private key never
   leaves the Node.
8. The Agent stores the certificate atomically, erases the enrollment token
   where practical, and uses mTLS for subsequent Agent operations.

The certificate contains only an opaque Node identifier. It has client
authentication extended key usage, no hostname or user metadata, and a random
serial. [RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html) defines the X.509
profile constraints.

## Lost response and retries

Consuming the token and losing the HTTP response must not strand or duplicate a
Node. The consumed record therefore retains the certificate-request fingerprint
and issued certificate for a short delivery window.

An exact retry with the same token and certificate request returns the same
public certificate during that window. It does not create a second Node or
credential. A request using the token with a different key receives the same
generic rejection as an invalid token. Once the delivery window closes,
recovery requires a new Operator authorization.

This preserves single consumption. The retry only retrieves the result of the
one accepted transition, and the certificate is unusable without the original
private key.

## Renewal, revocation, and recovery

- Issue short-lived certificates. Thirty days with renewal around day twenty
  is a starting policy, not yet an accepted budget.
- Add random renewal jitter so Nodes do not renew together.
- A healthy Agent submits a new certificate request over its authenticated mTLS
  connection. Keep old and new credentials valid for a short overlap, then
  revoke the old credential.
- Check both credential and Node status in PostgreSQL on every Agent operation.
  TLS certificate validity alone does not provide immediate application-level
  revocation.
- Losing the key requires an Operator-issued credential-replacement
  authorization bound to the existing Node. It never accepts a caller-supplied
  Node identity as proof.
- A suspected compromise revokes all previous credentials for that Node when
  the replacement succeeds. Routine rotation may overlap credentials.
- Revoking the Node revokes every credential belonging to it.

The term `Enrollment token` remains reserved for creating a Node. If the
replacement design is accepted, its authorization needs a separate domain term
because it changes credentials without creating a new Node.

## Server and proxy implications

ASP.NET Core supports certificate authentication. Certificate authentication
happens at the TLS layer, and a TLS-terminating proxy must authenticate the
certificate before forwarding trusted identity to the application.
[Microsoft's certificate guidance](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/certauth?view=aspnetcore-10.0)
and [proxy guidance](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/proxy-load-balancer?view=aspnetcore-10.0)
describe this split.

The safest initial deployment is a dedicated Agent origin or listener where
Kestrel terminates mTLS. Operator and future browser traffic can use a separate
origin or listener without requiring browser client certificates. A later
trusted-proxy mode must specify exact proxy identities, strip client-supplied
certificate headers, block direct backend access, and keep the database status
check.

The online issuing key must remain outside PostgreSQL, have a backup and
rotation procedure, and never appear in logs. Exact CA creation, storage, TLS
termination, and disaster recovery belong to the Server deployment decision.

## Parameters still required

The authentication mechanism, private-network scope, and 1,000-Node load
fixture are accepted. The remaining parameters are:

1. the polling interval and request distribution for that fixture;
2. the supported TLS termination topology for the first release;
3. client-certificate lifetime and renewal overlap;
4. issuing-key creation, storage, backup, and rotation;
5. the first private-key storage adapter on Linux and macOS; and
6. the exact credential-replacement authorization and audit policy.
