//! Embeds the Agent release public keys (`release-keys/*.pem`) so the updater
//! runs only binaries signed by one of them. The list may be empty: such an
//! Agent refuses every update.

use std::{env, fs, path::Path};

fn main() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("release-keys");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut keys = fs::read_dir(&directory)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|extension| extension == "pem"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    keys.sort();
    assert!(keys.len() <= 2, "release-keys/ holds at most two keys");
    let items = keys
        .iter()
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            format!("    include_str!({:?}),\n", path.display().to_string())
        })
        .collect::<String>();
    let output = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("release_keys.rs");
    fs::write(
        output,
        format!("/// PEM public keys from release-keys/.\npub const RELEASE_KEYS: &[&str] = &[\n{items}];\n"),
    )
    .expect("write release_keys.rs");
}
