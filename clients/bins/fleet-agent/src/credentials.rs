use std::{
    fs, io,
    path::{Path, PathBuf},
};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::protocol::{EnrollmentResponse, RenewalResponse};

const PENDING_FILE: &str = "pending.json";
const IDENTITY_FILE: &str = "identity.json";
const MAX_CREDENTIAL_FILE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingCredential {
    pub private_key_pem: String,
    pub csr_pem: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredIdentity {
    pub workspace_id: Uuid,
    pub node_id: Uuid,
    pub credential_id: Uuid,
    pub certificate_pem: String,
    pub private_key_pem: String,
    pub expires_at: String,
    pub poll_interval_seconds: u64,
}

impl StoredIdentity {
    pub fn identity_pem(&self) -> Vec<u8> {
        let mut pem =
            Vec::with_capacity(self.certificate_pem.len() + self.private_key_pem.len() + 1);
        pem.extend_from_slice(self.certificate_pem.as_bytes());
        if !self.certificate_pem.ends_with('\n') {
            pem.push(b'\n');
        }
        pem.extend_from_slice(self.private_key_pem.as_bytes());
        pem
    }
}

pub struct CredentialStore {
    directory: PathBuf,
}

impl CredentialStore {
    pub fn open(directory: impl Into<PathBuf>) -> io::Result<Self> {
        let directory = directory.into();
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "credential path must be a directory and not a symlink",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(&directory)?
            }
            Err(error) => return Err(error),
        }
        set_private_permissions(&directory, true)?;
        Ok(Self { directory })
    }

    pub fn load_identity(&self) -> io::Result<Option<StoredIdentity>> {
        let path = self.directory.join(IDENTITY_FILE);
        let bytes = match read_private_file(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn load_or_generate_pending(&self) -> io::Result<PendingCredential> {
        let pending_path = self.directory.join(PENDING_FILE);
        match read_private_file(&pending_path) {
            Ok(bytes) => {
                return serde_json::from_slice(&bytes)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(other)?;
        let private_key_pem = key.serialize_pem();
        let mut params = CertificateParams::new(Vec::<String>::new()).map_err(other)?;
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "fleet-agent");
        params.distinguished_name = name;
        let csr_pem = params
            .serialize_request(&key)
            .map_err(other)?
            .pem()
            .map_err(other)?;
        let pending = PendingCredential {
            private_key_pem,
            csr_pem,
        };
        atomic_write(&pending_path, &serde_json::to_vec(&pending).map_err(other)?)?;
        Ok(pending)
    }

    pub fn complete_enrollment(
        &self,
        pending: &PendingCredential,
        response: &EnrollmentResponse,
    ) -> io::Result<StoredIdentity> {
        self.store(StoredIdentity {
            workspace_id: response.workspace_id,
            node_id: response.node_id,
            credential_id: response.credential_id,
            certificate_pem: response.certificate_pem.clone(),
            private_key_pem: pending.private_key_pem.clone(),
            expires_at: response.expires_at.clone(),
            poll_interval_seconds: response.poll_interval_seconds,
        })
    }

    pub fn complete_renewal(
        &self,
        pending: &PendingCredential,
        response: &RenewalResponse,
    ) -> io::Result<StoredIdentity> {
        let current = self
            .load_identity()?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "node identity is missing"))?;
        self.store(StoredIdentity {
            credential_id: response.credential_id,
            certificate_pem: response.certificate_pem.clone(),
            private_key_pem: pending.private_key_pem.clone(),
            expires_at: response.expires_at.clone(),
            ..current
        })
    }

    pub fn clear_pending(&self) -> io::Result<()> {
        match fs::remove_file(self.directory.join(PENDING_FILE)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        sync_directory(&self.directory)
    }

    fn store(&self, identity: StoredIdentity) -> io::Result<StoredIdentity> {
        let json = serde_json::to_vec(&identity).map_err(other)?;
        atomic_write(&self.directory.join(IDENTITY_FILE), &json)?;
        self.clear_pending()?;
        Ok(identity)
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    use std::io::Write;
    if let Err(error) = (|| {
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(path.parent().unwrap())
    })() {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn read_private_file(path: &Path) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "credential file must be a regular file and not a symlink",
        ));
    }
    if metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "credential file is too large",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "credential file permissions are not private",
            ));
        }
    }
    fs::read(path)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}
fn other(error: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::other(error)
}

#[cfg(unix)]
fn set_private_permissions(path: &Path, directory: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )
}
#[cfg(not(unix))]
fn set_private_permissions(_path: &Path, _directory: bool) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("fleet-credential-test-{}", Uuid::new_v4())))
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn enrollment() -> EnrollmentResponse {
        EnrollmentResponse {
            workspace_id: Uuid::from_u128(1),
            node_id: Uuid::from_u128(2),
            credential_id: Uuid::from_u128(3),
            certificate_pem: "old certificate".into(),
            expires_at: "2026-10-01T00:00:00Z".into(),
            poll_interval_seconds: 30,
        }
    }

    fn error_kind<T>(result: io::Result<T>) -> io::ErrorKind {
        match result {
            Ok(_) => panic!("operation unexpectedly succeeded"),
            Err(error) => error.kind(),
        }
    }

    #[test]
    fn pending_credentials_are_reused_for_enrollment_retry() {
        let root = TestDirectory::new();
        let store = CredentialStore::open(&root.0).unwrap();
        let first = store.load_or_generate_pending().unwrap();
        let second = store.load_or_generate_pending().unwrap();
        assert_eq!(first.private_key_pem, second.private_key_pem);
        assert_eq!(first.csr_pem, second.csr_pem);
        assert!(first.csr_pem.contains("BEGIN CERTIFICATE REQUEST"));
        assert!(root.0.join(PENDING_FILE).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn credential_directory_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDirectory::new();
        let store = CredentialStore::open(&root.0).unwrap();
        store.load_or_generate_pending().unwrap();
        assert_eq!(
            fs::metadata(&root.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.0.join(PENDING_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directory_and_credential_file() {
        use std::os::unix::fs::symlink;

        let root = TestDirectory::new();
        fs::create_dir_all(&root.0).unwrap();
        let linked_directory = root.0.with_extension("link");
        let _linked_cleanup = TestDirectory(linked_directory.clone());
        symlink(&root.0, &linked_directory).unwrap();
        assert_eq!(
            error_kind(CredentialStore::open(&linked_directory)),
            io::ErrorKind::InvalidInput
        );

        let store = CredentialStore::open(&root.0).unwrap();
        let target = root.0.join("target");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, root.0.join(IDENTITY_FILE)).unwrap();
        assert_eq!(
            error_kind(store.load_identity()),
            io::ErrorKind::InvalidData
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_public_or_oversized_credential_files() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDirectory::new();
        let store = CredentialStore::open(&root.0).unwrap();
        let identity = root.0.join(IDENTITY_FILE);
        fs::write(&identity, b"{}").unwrap();
        fs::set_permissions(&identity, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            error_kind(store.load_identity()),
            io::ErrorKind::PermissionDenied
        );

        fs::set_permissions(&identity, fs::Permissions::from_mode(0o600)).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&identity).unwrap();
        file.set_len(MAX_CREDENTIAL_FILE_BYTES + 1).unwrap();
        assert_eq!(
            error_kind(store.load_identity()),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn renewal_updates_credential_and_preserves_node_identity() {
        let root = TestDirectory::new();
        let store = CredentialStore::open(&root.0).unwrap();
        let first_key = store.load_or_generate_pending().unwrap();
        let enrolled = store
            .complete_enrollment(&first_key, &enrollment())
            .unwrap();
        let renewal_key = store.load_or_generate_pending().unwrap();
        let renewed = store
            .complete_renewal(
                &renewal_key,
                &RenewalResponse {
                    credential_id: Uuid::from_u128(4),
                    certificate_pem: "new certificate".into(),
                    expires_at: "2026-11-01T00:00:00Z".into(),
                },
            )
            .unwrap();

        assert_eq!(renewed.workspace_id, enrolled.workspace_id);
        assert_eq!(renewed.node_id, enrolled.node_id);
        assert_eq!(
            renewed.poll_interval_seconds,
            enrolled.poll_interval_seconds
        );
        assert_eq!(renewed.credential_id, Uuid::from_u128(4));
        assert_eq!(renewed.private_key_pem, renewal_key.private_key_pem);
        assert_eq!(
            store.load_identity().unwrap().unwrap().certificate_pem,
            "new certificate"
        );
        assert!(!root.0.join(PENDING_FILE).exists());
    }
}
