use std::path::Path;

use sha2::{Digest, Sha256};

/// Opaque identity of a canonical destination and one captured source image.
/// Callers must hash the bytes they actually parse/publish, never a second read.
pub(crate) fn file_version(canonical_path: &Path, bytes: &[u8]) -> String {
    let mut identity = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        identity.update(canonical_path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for character in canonical_path.as_os_str().encode_wide() {
            identity.update(character.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    identity.update(canonical_path.to_string_lossy().as_bytes());
    format!("sha256:{:x}:{:x}", identity.finalize(), Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_bind_exact_bytes_and_destination_identity() {
        let a = Path::new("/a/workflow.xml");
        let b = Path::new("/b/workflow.xml");
        assert_eq!(file_version(a, b"a\r\n"), file_version(a, b"a\r\n"));
        assert_ne!(file_version(a, b"a\r\n"), file_version(a, b"a\n"));
        assert_ne!(file_version(a, b"a"), file_version(b, b"a"));
        assert!(file_version(a, b"abc").ends_with(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
    }
}
