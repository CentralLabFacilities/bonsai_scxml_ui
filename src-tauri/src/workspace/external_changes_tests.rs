use std::fs::{self, File, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::inspection::{
    inspect_workflow_source, revalidate_workflow_sources, RevalidationState,
    WorkflowRevalidationRequest, MAX_REVALIDATION_REQUESTS,
};
use super::library::BehaviorDirectoryMapping;
use crate::atomic_file::write_atomic_checked;
use crate::file_version::file_version;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
const A: &str = "<scxml initial=\"A\"><state id=\"A\"/></scxml>\r\n";
const B: &str = "<scxml initial=\"B\"><state id=\"B\"/></scxml>\r\n";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bonsai-external-workflow-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn request(
    src: impl Into<String>,
    baseline: Option<&str>,
    current: Option<&Path>,
) -> WorkflowRevalidationRequest {
    WorkflowRevalidationRequest {
        src: src.into(),
        file_version: baseline.map(str::to_owned),
        current_file_path: current.map(|path| path.to_string_lossy().into_owned()),
    }
}

#[test]
fn metadata_preserved_atomic_replacement_revalidates_exact_new_bytes_not_cached_workflow() {
    // Failing-before case: the former mtime+size cache returned A here.
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, A).unwrap();
    let first = inspect_workflow_source(path.to_str().unwrap(), &[], None).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    let replacement = fixture.path("replacement.xml");
    assert_eq!(A.len(), B.len());
    fs::write(&replacement, B).unwrap();
    File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    fs::rename(replacement, &path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), metadata.len());
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        metadata.modified().unwrap()
    );
    let results = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap();
    assert_eq!(results[0].state, RevalidationState::Changed);
    let inspected = results[0].inspection.as_ref().unwrap();
    assert_eq!(inspected.content.as_bytes(), B.as_bytes());
    assert_eq!(inspected.workflow.states[0].scxml_id, "B");
    assert_ne!(inspected.file_version, first.file_version);
    assert_eq!(inspected.file_version, file_version(&path, B.as_bytes()));
    assert_eq!(fs::read(&path).unwrap(), B.as_bytes());
    let stale = write_atomic_checked(&path, b"local edits", Some(&first.file_version));
    assert_eq!(stale.status, "conflict");
    assert_eq!(fs::read(&path).unwrap(), B.as_bytes());
}

#[test]
fn identical_byte_replacement_is_unchanged_and_newline_bytes_are_not_normalized() {
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, A).unwrap();
    let first = inspect_workflow_source(path.to_str().unwrap(), &[], None).unwrap();
    let replacement = fixture.path("replacement.xml");
    fs::write(&replacement, A).unwrap();
    fs::rename(replacement, &path).unwrap();
    let results = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap();
    assert_eq!(results[0].state, RevalidationState::Unchanged);
    assert!(results[0].inspection.is_none());
    assert_eq!(results[0].file_version.as_ref(), Some(&first.file_version));
    fs::write(&path, A.replace("\r\n", "\n")).unwrap();
    let results = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap();
    assert_eq!(results[0].state, RevalidationState::Changed);
    assert_ne!(results[0].file_version.as_ref(), Some(&first.file_version));
}

#[test]
fn invalid_utf8_invalid_scxml_missing_and_directory_never_fall_back_to_cached_success() {
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, A).unwrap();
    let first = inspect_workflow_source(path.to_str().unwrap(), &[], None).unwrap();
    for invalid in [b"not SCXML".as_slice(), b"\xff\xfe"] {
        fs::write(&path, invalid).unwrap();
        let result = revalidate_workflow_sources(
            &[request(
                path.to_string_lossy(),
                Some(&first.file_version),
                None,
            )],
            &[],
        )
        .unwrap()
        .remove(0);
        assert_eq!(result.state, RevalidationState::Invalid);
        assert_eq!(result.file_version, Some(file_version(&path, invalid)));
        assert!(result.inspection.is_none());
        assert!(result.error.is_some());
    }
    fs::remove_file(&path).unwrap();
    let missing = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(missing.state, RevalidationState::Missing);
    assert!(missing.inspection.is_none());
    assert!(missing.error.is_some());
    fs::create_dir(&path).unwrap();
    let directory = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(directory.state, RevalidationState::Invalid);
    assert!(directory.inspection.is_none());
    fs::remove_dir(&path).unwrap();
    fs::write(&path, B).unwrap();
    let recovered = revalidate_workflow_sources(
        &[request(
            path.to_string_lossy(),
            Some(&first.file_version),
            None,
        )],
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(recovered.state, RevalidationState::Changed);
    assert_eq!(recovered.inspection.unwrap().content, B);
}

#[test]
fn each_batch_resolves_current_mapping_and_relative_declaring_context() {
    let fixture = Fixture::new();
    let left = fixture.path("left");
    let right = fixture.path("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    fs::write(left.join("child.xml"), A).unwrap();
    fs::write(right.join("child.xml"), B).unwrap();
    let mapping = |path: &Path| {
        vec![BehaviorDirectoryMapping {
            key: "LIB".into(),
            path: path.to_string_lossy().into_owned(),
        }]
    };
    let first = inspect_workflow_source("${LIB}/child.xml", &mapping(&left), None).unwrap();
    let result = revalidate_workflow_sources(
        &[request("${LIB}/child.xml", Some(&first.file_version), None)],
        &mapping(&right),
    )
    .unwrap()
    .remove(0);
    assert_eq!(result.state, RevalidationState::Changed);
    assert_eq!(result.inspection.unwrap().content, B);
    let result = revalidate_workflow_sources(
        &[
            request(
                "child.xml",
                Some(&first.file_version),
                Some(&left.join("parent.xml")),
            ),
            request(
                "child.xml",
                Some(&first.file_version),
                Some(&right.join("parent.xml")),
            ),
        ],
        &[],
    )
    .unwrap();
    assert_eq!(result[0].state, RevalidationState::Unchanged);
    assert_eq!(result[1].state, RevalidationState::Changed);
    assert_eq!(result[1].inspection.as_ref().unwrap().content, B);
}

#[test]
fn equivalent_contexts_share_bytes_but_not_library_authorization_or_root_metadata() {
    let fixture = Fixture::new();
    let path = fixture.path("child.xml");
    fs::write(&path, A).unwrap();
    let mappings = vec![BehaviorDirectoryMapping {
        key: "LIB".into(),
        path: fixture.0.to_string_lossy().into_owned(),
    }];
    let results = revalidate_workflow_sources(
        &[
            request(path.to_string_lossy(), None, None),
            request("${LIB}/child.xml", None, None),
            request("child.xml", None, Some(&fixture.path("parent.xml"))),
        ],
        &mappings,
    )
    .unwrap();
    assert!(results
        .iter()
        .all(|result| result.state == RevalidationState::Changed));
    assert_eq!(results[0].inspection.as_ref().unwrap().root_key, None);
    assert_eq!(
        results[1].inspection.as_ref().unwrap().root_key.as_deref(),
        Some("LIB")
    );
    assert_eq!(results[2].inspection.as_ref().unwrap().root_key, None);
    assert!(results
        .iter()
        .all(|result| result.file_version == results[0].file_version));
    let oversized: Vec<_> = (0..=MAX_REVALIDATION_REQUESTS)
        .map(|_| request("missing.xml", None, None))
        .collect();
    assert!(revalidate_workflow_sources(&oversized, &[]).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_retarget_is_changed_and_library_escape_is_rejected_even_with_cached_direct_access() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let root = fixture.path("library");
    fs::create_dir(&root).unwrap();
    let a = root.join("a.xml");
    let b = root.join("b.xml");
    let outside = fixture.path("outside.xml");
    fs::write(&a, A).unwrap();
    fs::write(&b, A).unwrap();
    fs::write(&outside, B).unwrap();
    let link = root.join("link.xml");
    symlink(&a, &link).unwrap();
    let mappings = vec![BehaviorDirectoryMapping {
        key: "LIB".into(),
        path: root.to_string_lossy().into_owned(),
    }];
    let first = inspect_workflow_source("${LIB}/link.xml", &mappings, None).unwrap();
    fs::remove_file(&link).unwrap();
    symlink(&b, &link).unwrap();
    let retargeted = revalidate_workflow_sources(
        &[request("${LIB}/link.xml", Some(&first.file_version), None)],
        &mappings,
    )
    .unwrap()
    .remove(0);
    assert_eq!(retargeted.state, RevalidationState::Changed);
    assert_eq!(
        retargeted.file_version,
        Some(file_version(&b, A.as_bytes()))
    );
    fs::remove_file(&link).unwrap();
    symlink(&outside, &link).unwrap();
    let results = revalidate_workflow_sources(
        &[
            request(outside.to_string_lossy(), None, None),
            request("${LIB}/link.xml", Some(&first.file_version), None),
        ],
        &mappings,
    )
    .unwrap();
    assert_eq!(results[0].state, RevalidationState::Changed);
    assert_eq!(results[1].state, RevalidationState::Unreadable);
    assert!(results[1].error.as_ref().unwrap().contains("outside"));
    assert!(results[1].inspection.is_none());
    assert_eq!(fs::read(outside).unwrap(), B.as_bytes());
}

/// Run explicitly with a real Git executable; no desktop/GTK or network needed:
/// cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features --locked headless_git_pull_smoke -- --ignored --nocapture
#[test]
#[ignore = "real local Git clone/push/pull smoke; run explicitly"]
fn headless_git_pull_smoke() {
    use std::process::Command;
    fn git(directory: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args([
                "-c",
                "user.name=Bonsai Smoke",
                "-c",
                "user.email=smoke@example.invalid",
            ])
            .args(args)
            .output()
            .expect("headless smoke requires git in PATH");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let fixture = Fixture::new();
    let remote = fixture.path("remote.git");
    let producer = fixture.path("producer");
    let observer = fixture.path("observer");
    git(
        &fixture.0,
        &[
            "init",
            "--bare",
            "--initial-branch=main",
            remote.to_str().unwrap(),
        ],
    );
    git(
        &fixture.0,
        &["init", "--initial-branch=main", producer.to_str().unwrap()],
    );
    fs::write(producer.join("parent.xml"), A).unwrap();
    fs::write(producer.join("child.xml"), A).unwrap();
    git(&producer, &["add", "."]);
    git(&producer, &["commit", "-m", "A"]);
    git(
        &producer,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&producer, &["push", "-u", "origin", "main"]);
    git(
        &fixture.0,
        &[
            "clone",
            remote.to_str().unwrap(),
            observer.to_str().unwrap(),
        ],
    );
    let mappings = vec![BehaviorDirectoryMapping {
        key: "LIB".into(),
        path: observer.to_string_lossy().into_owned(),
    }];
    let first_parent = inspect_workflow_source("${LIB}/parent.xml", &mappings, None).unwrap();
    let first_child = inspect_workflow_source("${LIB}/child.xml", &mappings, None).unwrap();
    fs::write(producer.join("parent.xml"), B).unwrap();
    fs::write(producer.join("child.xml"), B).unwrap();
    git(&producer, &["add", "."]);
    git(&producer, &["commit", "-m", "B"]);
    git(&producer, &["push"]);
    git(&observer, &["pull", "--ff-only"]);
    let results = revalidate_workflow_sources(
        &[
            request("${LIB}/parent.xml", Some(&first_parent.file_version), None),
            request("${LIB}/child.xml", Some(&first_child.file_version), None),
        ],
        &mappings,
    )
    .unwrap();
    for result in &results {
        assert_eq!(result.state, RevalidationState::Changed);
        assert_eq!(result.inspection.as_ref().unwrap().content, B);
        println!(
            "pulled {}: version={} bytes={:?}",
            result.path.as_ref().unwrap(),
            result.file_version.as_ref().unwrap(),
            result.inspection.as_ref().unwrap().content.as_bytes()
        );
    }
    let parent = observer.join("parent.xml");
    let stale = write_atomic_checked(
        &parent,
        b"unsaved local parent",
        Some(&first_parent.file_version),
    );
    assert_eq!(stale.status, "conflict");
    assert_eq!(fs::read(&parent).unwrap(), B.as_bytes());
    println!(
        "stale Save: status={} preserved={:?}",
        stale.status,
        fs::read(&parent).unwrap()
    );
    let child = observer.join("child.xml");
    let accepted = write_atomic_checked(&child, A.as_bytes(), results[1].file_version.as_deref());
    assert_eq!(accepted.status, "saved");
    assert_eq!(fs::read(&child).unwrap(), A.as_bytes());
    assert_eq!(
        accepted.file_version,
        Some(file_version(&child, A.as_bytes()))
    );
    println!(
        "accepted Save: status={} committed={:?}",
        accepted.status,
        fs::read(child).unwrap()
    );
}
