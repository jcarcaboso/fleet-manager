# Server foundations decision map

This map tracks decisions that must be resolved before the public POC can claim
secure enrollment, privacy, or measured performance. Accepted stack choices are
recorded elsewhere and are not reopened here.

## #1: Operating and threat envelope

Blocked by: none
Type: Grilling

### Question

What Node counts, operators, network exposure, hosting modes, attacker access,
and data sensitivity must the first public release support?

### Answer

Resolved. The first release is self-hosted. One Server installation
governs exactly one Workspace, and multiple-Workspace hosting is out of scope.
It supports macOS and Linux Agents and may be administered by multiple people.
Every configured Operator is a fully trusted administrator. The POC has no
roles or permission separation between Operators and does not defend against a
malicious authorized Operator. It must still protect against stolen Operator
credentials and compromised Operator workstations.

Agents reach the Server only through a local network or an Operator-managed
private overlay such as Tailscale. Public-internet exposure is unsupported, and
Fleet does not configure or depend on the overlay. The Server may make outbound
connections to its configured Git remote. The protocol still treats network
peers as untrusted and requires TLS and Node mTLS. One Server process with one
PostgreSQL database will be load-tested with 1,000 registered Nodes polling
regularly. This is a capacity target, not a reason to introduce distributed
infrastructure.

Fleet treats Skill contents as opaque, untrusted bytes. Authors may include any
content, including secrets, at their own risk. Fleet does not detect, reject,
rotate, or otherwise manage secrets. It still protects Bundle access, transport,
storage, backups, and logs according to the general security and privacy model.

## #2: Open-source license and governance

Blocked by: none
Type: Grilling

### Question

Which license, contribution attestation, maintainer policy, and release ownership
fit the intended community?

### Answer

The owner selected MIT for the implementation on 2026-09-07. The repository now
contains `LICENSE`. Contribution attestation, maintainer policy, and release
ownership remain open before accepting external contributions.

## #3: Threat model

Blocked by: #1
Type: Grilling

### Question

Which assets and operations need protection from a stolen enrollment token,
compromised Node, stolen Operator credential, compromised Server, malicious
source revision, network attacker, and local unprivileged process?

### Answer

Open. Produce a threat-model document with mitigations, accepted risks, and test
cases.

## #4: Enrollment and ongoing Node authentication

Blocked by: none
Type: Research

### Question

Which standard credential mechanism should follow a short-lived, single-use
enrollment token, and how will issuance, proof of possession, storage, rotation,
revocation, replay resistance, and recovery work?

### Answer

Resolved by [ADR 0003](../adr/0003-use-mtls-for-node-authentication.md).
Enrollment authorization expires, works once, belongs to one Workspace, is
stored only as a digest, and is consumed atomically. The Agent generates its key
pair and submits a signed certificate request. The Server issues a short-lived
client certificate, and ongoing Agent operations use mTLS plus an active Node
and credential check. The
[research note](../research/node-enrollment-and-authentication.md) records the
alternatives. Exact lifetimes, issuing-key operations, and TLS termination remain
in tickets #8 and #9.

## #5: Operator and future admin authentication

Blocked by: #1, #3
Type: Research

### Question

What authenticates the initial Operator CLI, and how can the same authorization
model later support browser sessions and an external identity provider?

### Answer

The owner selected separately configured Operator bearer tokens for the POC on
2026-09-07. The Server stores their SHA-256 digests and requires HTTPS. Every POC
Operator has full administrative authority. Browser sessions and external
identity-provider integration remain deferred and must keep Operator and Node
identities separate.

## #6: Privacy inventory and retention

Blocked by: #1, #3
Type: Grilling

### Question

Which Node metadata, Skill metadata, audit events, diagnostics, and network
attributes are stored, who can read them, and when are they deleted from primary
storage and backups?

### Answer

Open. No outbound telemetry by default and no credential or Bundle content in
logs are accepted starting rules. Fleet does not inspect Bundle content to find
secrets.

## #7: Performance envelope and budgets

Blocked by: #1
Type: Grilling

### Question

What fleet size, polling interval, Bundle size, publication rate, status-query
latency, enrollment rate, and recovery time must one Server process sustain?

### Answer

Partly resolved. One Server process with one PostgreSQL database must sustain a
fixture of 1,000 registered Nodes polling regularly. This is a test target, not
a hosted-service capacity promise. It does not justify caches, queues, or
horizontal scaling before measurement. Polling interval, Bundle sizes,
publication rate, latency thresholds, enrollment bursts, and recovery time
remain open.

## #8: Versioned Agent protocol

Blocked by: #4, #6, #7
Type: Grilling

### Question

What are the exact enrollment, polling, Bundle, acknowledgement, reporting,
error, compatibility, timeout, Bundle-tree encoding, portable path, file
metadata, and size-limit contracts?

### Answer

Open. The architecture fixes complete desired state, idempotent delivery, JSON
metadata with binary Bundle responses, and Bundles that represent complete
nested Skill directory trees under
[ADR 0004](../adr/0004-bundle-complete-skill-directory-trees.md). Exact messages,
Bundle encoding, and numeric limits remain unresolved.

## #9: Server deployment, TLS, migration, and backup

Blocked by: #3, #6, #7
Type: Research

### Question

Where will the first Server run, where does TLS terminate, how are database
migrations applied, and how are PostgreSQL state and credentials backed up and
restored?

### Answer

Open. The POC remains one Server process and one PostgreSQL database.

## #10: Public release and contribution policy

Blocked by: #2, #3, #8, #9
Type: Grilling

### Question

Which checks, compatibility promises, security response process, signed
artifacts, and contributor documentation are required for the first public
release?

### Answer

Open. The engineering standards document supplies the starting checklist.
