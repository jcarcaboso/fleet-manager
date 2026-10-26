//! Exercise the actual command dispatch while another process owns the lock.
#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::SystemTime,
};
use uuid::Uuid;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("fleet-inspect-cli-{}", Uuid::new_v4())),
        )
    }

    fn enrolled() -> Self {
        let fixture = Self::new();
        for path in [
            &fixture.0,
            &fixture.0.join("credentials"),
            &fixture.0.join("home"),
        ] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fixture.write(
            "config.json",
            json!({
                "server_url": "https://fleet.invalid", "ca_pem": "CA-MARKER",
                "node_alias": "test-node", "home": fixture.0.join("home")
            }),
        );
        fixture.write(
            "credentials/identity.json",
            json!({
                "workspaceId": Uuid::new_v4(), "nodeId": Uuid::new_v4(),
                "credentialId": Uuid::new_v4(), "certificatePem": "CERTIFICATE-MARKER",
                "privateKeyPem": "PRIVATE-KEY-MARKER", "expiresAt": "2100-01-01T00:00:00Z",
                "pollIntervalSeconds": 30
            }),
        );
        fixture
    }

    fn write(&self, name: &str, value: Value) {
        let path = self.0.join(name);
        fs::write(&path, value.to_string()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_fleet-agent"))
            .arg("--state-dir")
            .arg(&self.0)
            .args(args)
            .output()
            .unwrap()
    }

    fn snapshot(&self) -> BTreeMap<PathBuf, (u32, SystemTime, Vec<u8>)> {
        fn visit(path: &Path, files: &mut BTreeMap<PathBuf, (u32, SystemTime, Vec<u8>)>) {
            let metadata = fs::symlink_metadata(path).unwrap();
            let bytes = if metadata.is_dir() {
                Vec::new()
            } else {
                fs::read(path).unwrap()
            };
            files.insert(
                path.into(),
                (
                    metadata.permissions().mode(),
                    metadata.modified().unwrap(),
                    bytes,
                ),
            );
            if metadata.is_dir() {
                for entry in fs::read_dir(path).unwrap() {
                    visit(&entry.unwrap().path(), files);
                }
            }
        }
        let mut files = BTreeMap::new();
        visit(&self.0, &mut files);
        files
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn inspection_works_under_a_lock_without_changing_state_or_exposing_credentials() {
    let fixture = Fixture::enrolled();
    let lock = File::create(fixture.0.join("agent.lock")).unwrap();
    lock.try_lock().unwrap();
    let before = fixture.snapshot();
    for command in ["status", "targets", "check", "disk"] {
        let output = fixture.run(&[command]);
        assert!(
            output.status.success(),
            "{command}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        if command == "status" {
            assert_eq!(value["service"]["running"], true);
        }
        if command == "check" {
            assert_eq!(value["ok"], true);
        }
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for secret in ["PRIVATE-KEY-MARKER", "CERTIFICATE-MARKER", "CA-MARKER"] {
            assert!(!text.contains(secret));
        }
        assert_eq!(fixture.snapshot(), before, "{command} changed state");
    }
    for args in [
        &["run", "--once"][..],
        &["alias", "other"],
        &["enroll", "--link"],
    ] {
        let output = fixture.run(args);
        assert!(!output.status.success(), "{args:?} unexpectedly ran");
        assert!(String::from_utf8_lossy(&output.stderr).contains("another fleet-agent process"));
        assert_eq!(fixture.snapshot(), before, "{args:?} changed locked state");
    }
    drop(lock);
    let status: Value = serde_json::from_slice(&fixture.run(&["status"]).stdout).unwrap();
    assert_eq!(status["service"]["running"], false);
}

#[test]
fn missing_state_stays_missing_and_check_returns_json_with_failure_exit() {
    let fixture = Fixture::new();
    for command in ["status", "targets", "check", "disk"] {
        let output = fixture.run(&[command]);
        assert_eq!(output.status.code(), Some(1), "{command}");
        assert!(!fixture.0.exists(), "{command} created state");
        if command == "check" {
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["ok"], false);
            assert_eq!(report["checks"][0]["name"], "stateDirectory");
        } else {
            assert!(String::from_utf8_lossy(&output.stderr).contains("Agent is not configured"));
        }
    }
}
