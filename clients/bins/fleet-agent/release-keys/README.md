# Agent release keys

Each `*.pem` file here is an Ed25519 public key that signs Agent releases. The
tag workflow refuses to publish a release whose manifest does not verify with
one of these keys. Self-updating Agents will embed the same keys and run only
binaries listed in a manifest signed by one of them.

Keep at most two keys: the current one and, during a rotation, the next one.

## Create the signing key

Run this once, offline, on a trusted machine:

```sh
openssl genpkey -algorithm ed25519 -out fleet-agent-release.key
openssl pkey -in fleet-agent-release.key -pubout \
  -out clients/bins/fleet-agent/release-keys/release-2026.pem
```

1. In the GitHub repository settings, create the environment
   `release-signing`. Limit its deployment tags to `v*` and, if you want, add
   required reviewers.
2. Add the whole content of `fleet-agent-release.key`, including the `BEGIN` and
   `END` lines, as the environment secret `AGENT_RELEASE_SIGNING_KEY`.
3. Commit the public key file through a pull request.
4. Store `fleet-agent-release.key` offline (for example in a password manager)
   and delete the working copy. Anyone with it can sign Agent binaries.

## Rotate the key

1. Create a new key pair as above with a new file name and commit the public
   key next to the old one.
2. Release once while still signing with the old key. Agents on this release
   trust both keys.
3. Replace `AGENT_RELEASE_SIGNING_KEY` with the new private key, remove the old
   public key, and release again.

Agents that skip the middle release do not trust the new key and need one
manual upgrade. After a leaked key, rotate immediately; Agents that still trust
the leaked key must be upgraded by hand.
