# Install the Fleet CLI

The release archive contains a static Linux amd64 `fleet` executable, the MIT
license, and `SHA256SUMS` for the extracted files. It does not need Rust or a
system TLS library at runtime.

## Linux amd64

Download `fleet-linux-amd64.tar.gz` and its adjacent
`fleet-linux-amd64.tar.gz.sha256` file to the same directory. Verify and install
the executable with:

```sh
sha256sum --check fleet-linux-amd64.tar.gz.sha256
tar -xzf fleet-linux-amd64.tar.gz
sha256sum --check SHA256SUMS
sudo install -m 0755 fleet /usr/local/bin/fleet
fleet --help
```

Set the Server URL and Operator token before running a command:

```sh
export FLEET_SERVER_URL=https://fleet.example.com
export FLEET_OPERATOR_TOKEN='replace-with-an-operator-token'
fleet nodes list
```

Use `--ca-cert FILE` when the Server uses a private certificate authority. Plain
HTTP is accepted only for a loopback Server and requires `--allow-http`.

## Build the Linux archive

The build requires Docker with BuildKit support. From the repository root, run:

```sh
./scripts/build-cli.sh
```

The script builds locked dependencies from `clients/Cargo.lock`, runs the Rust
workspace tests, and writes the archive and its checksum under `artifacts/`.
The script creates a temporary build context containing the client workspace and
the two contract fixtures used by its tests. Server files and local configuration
are not sent to the builder.

## Build on macOS

The project does not currently ship a macOS binary. Developers can build one
from source after installing the Rust 1.95.0 toolchain:

```sh
cd clients
cargo test --workspace --locked
cargo build --package fleet --release --locked
./target/release/fleet --help
```

The resulting executable is native to the Mac that built it. Building separate
archives for Apple silicon and Intel Macs, signing them, and notarizing them are
still release work.
