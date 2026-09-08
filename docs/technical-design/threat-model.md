# Server and CLI POC threat model

The installation has one Workspace on a private network, fully trusted
Operators, a trusted Server OS and PostgreSQL service, and untrusted network
peers, source content, and Node reports. A private overlay provides reachability
only. The Server does not run Skill content or access a Node filesystem.

| Threat | Implemented control | Verification or remaining boundary |
|---|---|---|
| Network peer impersonates an Operator | HTTPS plus a configured random bearer credential; only its SHA-256 is stored on the Server. | HTTP and wrong-scheme authorization tests. A stolen Operator token grants full administrative access. Rotate its configured digest after theft. |
| Node calls an Operator route | Separate authentication policies. | Hosting tests submit a Node certificate to an Operator route and reject Operator bearer auth on Node routes. |
| Node impersonation without its private key | P-256 signed CSR and client certificate authentication through TLS. | Certificate signature/chain tests and local HTTPS smoke exercise. TestServer certificate injection alone is not evidence of a TLS handshake. |
| Enrollment token replay | Atomic consumption, CSR-bound response retry window, unique Node/credential identity. | PostgreSQL enrollment tests. A thief with an unused token can enroll first; token delivery must stay private. |
| Revoked or expired certificate reuse | Chain validation and current Node/credential lookup on each request. | Revocation and unrelated-Node isolation tests. Requests already executing may complete during revocation. |
| Concurrent reports overwrite terminal state | Coordination owns transactions and terminal transition checks. | PostgreSQL duplicate, stale, and concurrent report tests. |
| Source entry escapes its Skill tree | Read Git objects without checkout; reject links, unsafe paths, portable-name collisions, and bounded source content. | Git fixture tests. Agent extraction and filesystem containment remain later work. |
| Credential or content leak through errors | No body logging; CLI omits failed response bodies; source errors use bounded diagnostics. | Hosting and CLI error-redaction tests. Operator CLI enrollment output deliberately contains the new token. |
| Oversized input exhausts memory | Request, response, page, tree, file, entry-count, concurrency and time limits. | Boundary tests. Git fetch still needs disk quotas and a measured repository-transfer budget before release. |
| Malicious configured Git remote or Server administrator | Outside protection from trusted Operators. Git commands use argument lists and no shell. | A compromised Server OS can steal the issuing key and all Bundle bytes. Restore requires credential and key rotation procedures. |
| Copied Node software private key | Active credential revocation limits future use. | Hardware binding is excluded. Copying the private key can clone a Node until revocation. |

The Server ignores proxy certificate headers and terminates TLS in Kestrel.
The CLI disables redirects, verifies Server trust, and can load a private CA.
The development HTTP exception requires an explicit flag and loopback access.

Public-internet exposure, malicious authenticated Operators, hardware-backed
Node keys, production secret distribution, and protection from a compromised
Server OS are outside this POC. Open release work includes issuing-key rotation,
backup/restore drills, private security reporting, deletion policy, dependency
review ownership, measured load limits, and the complete Agent recovery protocol.
