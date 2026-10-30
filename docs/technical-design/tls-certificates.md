# TLS certificates

Fleet runs one private CA. This document lists what it signs, what renews each
certificate, and what reaches Agents. The decision is recorded in
[ADR 0005](../adr/0005-renew-tls-certificates-inside-the-server.md).

| Certificate | Lifetime | Renewed by | Agents need |
|---|---|---|---|
| Node client certificate | 7 days (`Fleet:CertificateLifetimeDays`) | The Agent, in its poll cycle, with less than a day left | Nothing |
| Server TLS certificate | 90 days | The Server, in memory, with less than 30 days left | Nothing |
| Dashboard TLS certificate | 90 days | The Server, in the shared volume; the dashboard reloads it | Nothing |
| Fleet CA certificate | 10 years (365 days before Fleet 0.12.2) | An Operator: `setup.py --renew-ca` | Nothing, with the same key |

Certificates issued by a public CA for a proxy in front of Fleet are not part of
this. The proxy that terminates them owns their renewal.

## Node certificates

The Agent checks its certificate at the start of each cycle. With less than a day
left, or already expired, it sends a new key's certificate request to
`POST /agent/v1/credentials/renew`, the one route that accepts an expired
certificate. A Node that was offline for a long time renews before anything else.

The old credential stays valid until it expires, so a lost response costs nothing:
the Agent still holds its old identity and pending key, and asks again. Revocation
stops renewal. The issuing CA must be valid.

## Server certificate

`TlsCertificateRenewal` runs before the listener binds and then every
`Fleet:TlsCertificateCheckSeconds`.

1. It reads the file in `Kestrel:Certificates:Default`. If another CA signed that
   file, or it has no subject alternative names, Fleet leaves it to Kestrel, reports
   its expiry, and logs a warning.
2. Otherwise a file with more than `Fleet:TlsCertificateRenewBeforeDays` left and a
   later expiry than the current certificate becomes the current certificate. This
   is how an Operator replaces it, and it needs no restart.
3. A current certificate that is due is replaced by one with a new key, the same
   subject and names, and the extensions `setup.py` uses, lasting
   `Fleet:TlsCertificateLifetimeDays` but never past the CA's expiry.

The certificate reaches Kestrel through `ServerCertificateSelector`, so new
connections get it and open ones finish undisturbed. Its key exists only in memory.

If issuing fails, the Server keeps what it has, logs an error and tries again at the
next check. At startup it falls back to the file, however close to expiry.

## Dashboard certificate

The dashboard has no CA key and no network path to the Server, so the Server writes
to the `dashboard-tls` volume, set by `Fleet:DashboardCertificateDirectory`. It
replaces `dashboard.key` and then `dashboard.pem`, each with one rename. The
dashboard checks `dashboard.pem` every `FLEET_TLS_RELOAD_SECONDS` (default 60) and
reloads nginx when it changes, after `nginx -t` accepts the pair.

The `configure` service seeds this volume on every deployment. It keeps the
certificate already there unless the seed lasts longer, so a stale copy in the
secret store cannot undo a renewal, while one an Operator just issued still wins.

Without that directory setting the Server leaves the dashboard alone. The dashboard's
health check verifies the certificate, so an expired one makes the container
unhealthy even behind a proxy that skips verification.

## Watching renewal

`GET /operator/v1/metrics` reports `tls.server.not_after_unix`,
`tls.dashboard.not_after_unix` and `tls.ca.not_after_unix`, and counts
`tls.server.renewal.ok`, `tls.server.renewal.failed`, `tls.dashboard.renewal.ok` and
`tls.dashboard.renewal.failed`. The Meter has `fleet.tls.renewals`. A failure is
logged as an error, and the CA logs a warning at each check in its last 90 days.

## Extending the CA

From `CertificateLifetimeDays` before the CA expires, the Server refuses to start
and every Node renewal fails. Extend it before then:

```sh
python3 setup.py --renew-ca
docker compose up -d --force-recreate --wait
```

This reissues `ca.pem` with the same key, subject and extensions, later dates and a
new serial number. Every certificate already issued stays valid, in both directions:
the Server accepts Node certificates issued before it, and Agents that still hold the
old `ca.pem` accept Server certificates issued after it.

That second direction holds even after the old `ca.pem` has expired. An Agent keeps
the CA certificate from its enrollment link for as long as it is enrolled, and
rustls-webpki reads only a trust anchor's name and key, not its dates.
`an_agent_keeps_trusting_a_ca_whose_certificate_it_holds_has_expired` pins this. If a
dependency update breaks that test, a CA extension would then need a delivery
mechanism, so treat it as a compatibility break and not as a test to change.

Software that does check dates, such as the `curl` in the Compose health checks,
reads `ca.pem` from the volumes, which the next deployment updates.

## Replacing the CA key

Only a compromised or lost key, or a change of algorithm, needs this. Fleet has no
mechanism for it: `ca_pem` is written once at enrollment and nothing changes it, and
the Server trusts exactly one CA. Today the procedure is to create a new CA, enroll
every Node again, and revoke the old Nodes.

A rotation without that would have these parts. None of them is built.

- **Delivery.** The Agent announces a new capability, and the poll response carries
  the digest of the current trust bundle. The Agent fetches the bundle over mTLS when
  it differs, and writes it to a new file rather than `config.json`, because that
  struct denies unknown fields and rollback to an older Agent must keep working. The
  old anchor stays until the new bundle has been written. A PEM with several
  certificates already loads as several anchors.
- **Acknowledgement.** Each poll reports the digest the Agent holds, and the Server
  stores it per Node, which takes a migration and a place to show the Nodes that lag.
- **Stage 1, announce.** The old CA still issues everything. The bundle is old plus
  new. Wait until every Node has acknowledged it.
- **Stage 2, switch.** The new CA issues Node and Server certificates. The Server
  still accepts Node certificates from the old CA, which needs
  `NodeCertificateIssuer.ValidateChain` to take several anchors and
  `EnrollmentLinkSettings` to carry a bundle. Node renewal moves every Node over
  within one certificate lifetime.
- **Stage 3, retire.** Once no active credential comes from the old CA, the bundle
  and the Server's trust drop it.

The overlap is what keeps a Node from being locked out, so stage 2 must not start
before every Node has acknowledged. An Agent that slept through stage 1 cannot verify
a Server certificate from the new CA, and could only come back by enrolling again.
After a compromise the overlap is itself the danger, because trusting the old key is
the problem. Then enroll every Node again instead.

## Testing

- `TlsCertificateRenewalTests` covers each decision above and serves renewals from
  real Kestrel listeners.
- The Agent's `protocol.rs` tests run its real HTTP client against a real TLS server.
- `scripts/check-setup-certificates.py` checks `setup.py --renew` and `--renew-ca`
  with a strict verifier, including a client that kept the old CA.
- `scripts/smoke-dashboard-image.sh` checks that the dashboard reloads a certificate.
- `scripts/smoke-tls-renewal.sh SERVER_IMAGE DASHBOARD_IMAGE AGENT_BINARY` runs a
  disposable Compose stack with a real Agent through expiring certificates, Server
  certificate changes, Compose reruns and restarts.
