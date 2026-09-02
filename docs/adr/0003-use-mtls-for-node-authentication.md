---
status: accepted
date: 2026-09-02
---

# Use one-time enrollment and mTLS for Node authentication

Each Agent will generate its own private and public key pair before enrollment.
It will use a short-lived, single-use enrollment token to submit a signed PKCS #10
certificate request. The Server will verify proof of private-key possession,
atomically consume the enrollment authorization, create the Node identity, and
issue a short-lived X.509 client certificate. The private key never leaves the
Node. Ongoing Agent operations will use mutual TLS, followed by an
application-level check that the exact Node and credential remain active.

This was chosen over a durable bearer credential because copying a bearer secret
is enough to clone a Node. DPoP and HTTP Message Signatures also provide proof of
possession, but they require Fleet to operate token issuance, request-signing,
clock or nonce, and replay rules. Mutual TLS uses the proof already defined by
TLS and is practical for the first self-hosted, single-Workspace Server.

## Consequences

- The Server must operate an issuing certificate authority whose private key is
  stored outside PostgreSQL and has backup, rotation, and compromise procedures.
- Node credentials expire, renew with overlap, support immediate revocation, and
  require Operator-authorized replacement when the private key is lost.
- An exact enrollment retry with the same token and certificate request may
  retrieve the already-issued certificate during a short delivery window. It
  cannot create a second Node or substitute another public key.
- Enrollment secrets never appear in URL query parameters, logs, audit bodies,
  or persistent Agent configuration.
- A copied software private key can still clone a Node. Hardware-backed keys and
  device attestation are possible later hardening, not POC requirements.
- Operator and future browser authentication remain separate from Node mTLS.
- Certificate lifetime, renewal timing, CA storage, and TLS termination topology
  remain protocol and deployment decisions.

The supporting comparison and flow are recorded in
[Node enrollment and authentication research](../research/node-enrollment-and-authentication.md).
