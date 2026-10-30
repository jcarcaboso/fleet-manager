---
status: accepted
date: 2026-10-30
---

# Renew TLS certificates inside the Server

The Server renews its own TLS certificate in memory and replaces the dashboard's
certificate in the volume they share. Renewal does not need the secret store,
the deployment tooling or a restart. The certificate files a deployment supplies
only seed the Server: it uses them while they have time left.

The Server already holds the CA key, because it signs Node certificates, and
Agents trust the CA and pin nothing. A certificate issued in memory therefore
exposes nothing new and needs no persistence: a restart simply issues another.

This was chosen over renewal in deployment tooling because that needs write access
to the secret store from the host that runs Fleet, and over writing a renewed file
into the Server's volume because that volume is read-only and a later deployment
would copy the old file back. Kestrel cannot reload a replaced file here either:
it only does so for listeners configured under `Kestrel:Endpoints`, and the image
uses `ASPNETCORE_URLS`.

The CA stays out of this. Its expiry does not need a new key: reissuing the CA
certificate with the same key and subject extends it, and Agents need nothing,
because they verify against the name and key of the CA they enrolled with and
ignore that certificate's dates. `setup.py --renew-ca` does this, once a decade
now that new CAs last that long. Replacing the CA key is a different operation,
which Fleet has no mechanism for and does not need for renewal.

## Consequences

- The certificates in the deployment's secret store go stale, and that is harmless.
  They must still exist, and an expired one is accepted as a seed.
- A certificate another CA signed is left to Kestrel and to whoever issued it.
- The dashboard's volume is owned by the Server's user, and the dashboard reads it
  through the Server's group. It is the only volume they share.
- The Agent's tolerance of an expired CA certificate is a property of rustls-webpki.
  An Agent test pins it, because the CA extension depends on it.
- Replacing a CA key still means enrolling every Node again. The design for doing it
  without that is in [TLS certificates](../technical-design/tls-certificates.md).
