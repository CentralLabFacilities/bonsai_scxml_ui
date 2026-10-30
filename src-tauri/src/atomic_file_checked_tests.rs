use super::*;
use std::sync::Barrier;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bonsai-checked-save-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn entries(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        paths.sort();
        paths
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_precondition_requires_present_string_or_explicit_null() {
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        expected_file_version: FileVersionPrecondition,
    }
    assert!(serde_json::from_str::<Request>("{}").is_err());
    for invalid in ["false", "123", "{}", "[]"] {
        let json = format!("{{\"expectedFileVersion\":{invalid}}}");
        assert!(serde_json::from_str::<Request>(&json).is_err());
    }
    let absent: Request = serde_json::from_str("{\"expectedFileVersion\":null}").unwrap();
    assert_eq!(absent.expected_file_version.as_deref(), None);
    let loaded: Request = serde_json::from_str("{\"expectedFileVersion\":\"loaded\"}").unwrap();
    assert_eq!(loaded.expected_file_version.as_deref(), Some("loaded"));
}

#[test]
fn checked_create_and_replace_report_the_exact_committed_version() {
    let fixture = Fixture::new();
    let path = fixture.path("new.xml");
    let created = write_atomic_checked(&path, b"new\r\n", None);
    assert_eq!(created.status, "saved");
    assert_eq!(created.file_version, Some(file_version(&path, b"new\r\n")));
    assert_eq!(fs::read(&path).unwrap(), b"new\r\n");
    let replaced = write_atomic_checked(&path, b"replacement\n", created.file_version.as_deref());
    assert_eq!(replaced.status, "saved");
    assert_eq!(
        replaced.file_version,
        Some(file_version(&path, b"replacement\n"))
    );
    assert_eq!(fs::read(&path).unwrap(), b"replacement\n");
    assert_eq!(fixture.entries(), vec![path]);
}
#[test]
fn checked_save_rejects_stale_and_deleted_baselines_without_writing() {
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, b"loaded A").unwrap();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    fs::write(&path, b"pulled B").unwrap();
    let conflict = write_atomic_checked(&path, b"local edits", Some(&baseline));
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.state, Some("changed"));
    assert_eq!(
        conflict.observed_file_version,
        Some(file_version(&path, b"pulled B"))
    );
    assert_eq!(fs::read(&path).unwrap(), b"pulled B");
    fs::remove_file(&path).unwrap();
    let conflict = write_atomic_checked(&path, b"must not recreate", Some(&baseline));
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.state, Some("missing"));
    assert!(!path.exists());
    assert!(fixture.entries().is_empty());
}

#[test]
fn checked_save_final_check_rejects_an_external_replacement_after_staging() {
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, b"loaded A").unwrap();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    let changed = path.clone();
    let result = write_atomic_checked_with(
        &path,
        b"local edits",
        Some(&baseline),
        CheckedSaveHooks {
            before_final_check: Some(Box::new(move || {
                let staged_external = changed.with_extension("external");
                fs::write(&staged_external, b"pulled B").unwrap();
                fs::rename(staged_external, &changed).unwrap();
            })),
            ..Default::default()
        },
    );
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read(&path).unwrap(), b"pulled B");
    assert_eq!(fixture.entries(), vec![path]);
}

#[test]
fn checked_save_final_check_rejects_deletion_and_directory_replacement() {
    for make_directory in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.path("workflow.xml");
        fs::write(&path, b"loaded A").unwrap();
        let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
        let changed = path.clone();
        let result = write_atomic_checked_with(
            &path,
            b"local edits",
            Some(&baseline),
            CheckedSaveHooks {
                before_final_check: Some(Box::new(move || {
                    fs::remove_file(&changed).unwrap();
                    if make_directory {
                        fs::create_dir(&changed).unwrap();
                    }
                })),
                ..Default::default()
            },
        );
        assert_eq!(result.status, "conflict");
        assert_eq!(
            result.state,
            Some(if make_directory { "invalid" } else { "missing" })
        );
        assert_eq!(path.is_dir(), make_directory);
        assert_eq!(fixture.entries().len(), usize::from(make_directory));
    }
}

#[test]
fn simultaneous_checked_application_saves_serialize_and_one_stale_writer_conflicts() {
    let fixture = Fixture::new();
    let path = fixture.path("workflow.xml");
    fs::write(&path, b"loaded A").unwrap();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    let start = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [b"local B".as_slice(), b"local C"]
        .into_iter()
        .map(|bytes| {
            let path = path.clone();
            let baseline = baseline.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                (bytes, write_atomic_checked(&path, bytes, Some(&baseline)))
            })
        })
        .collect();
    start.wait();
    let outcomes: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|(_, result)| result.status == "saved")
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|(_, result)| result.status == "conflict")
            .count(),
        1
    );
    let winner = outcomes.iter().find(|(_, result)| result.success).unwrap();
    let loser = outcomes.iter().find(|(_, result)| !result.success).unwrap();
    assert_eq!(fs::read(&path).unwrap(), winner.0);
    assert_eq!(loser.1.observed_file_version, winner.1.file_version);
    assert_eq!(fixture.entries(), vec![path]);
}

#[test]
fn absent_precondition_is_atomic_create_only_even_after_the_final_check() {
    let fixture = Fixture::new();
    let path = fixture.path("child.xml");
    let external = path.clone();
    let result = write_atomic_checked_with(
        &path,
        b"extracted child",
        None,
        CheckedSaveHooks {
            before_publish: Some(Box::new(move || {
                fs::write(external, b"external creator").unwrap()
            })),
            ..Default::default()
        },
    );
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read(&path).unwrap(), b"external creator");
    assert_eq!(fixture.entries(), vec![path.clone()]);
    let result = write_atomic_checked(&path, b"must not replace", None);
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read(&path).unwrap(), b"external creator");
}

#[test]
fn confirmed_save_as_version_does_not_authorize_a_later_replacement() {
    let fixture = Fixture::new();
    let path = fixture.path("selected.xml");
    fs::write(&path, b"confirmed destination").unwrap();
    let (canonical, version) = inspect_save_destination(&path).unwrap();
    fs::write(&path, b"changed after confirmation").unwrap();
    let result = write_atomic_checked(&canonical, b"local document", version.as_deref());
    assert_eq!(result.status, "conflict");
    assert_eq!(fs::read(path).unwrap(), b"changed after confirmation");
}

#[test]
fn checked_staging_error_preserves_bytes_permissions_and_cleans_temporary() {
    let fixture = Fixture::new();
    let path = fixture.path("private.xml");
    fs::write(&path, b"original").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let before = fs::metadata(&path).unwrap().permissions();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    let result = write_atomic_checked_with(
        &path,
        b"partial replacement",
        Some(&baseline),
        CheckedSaveHooks {
            fail_stage: true,
            ..Default::default()
        },
    );
    assert_eq!(result.status, "error");
    assert_eq!(result.file_version, None);
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(fs::metadata(&path).unwrap().permissions(), before);
    assert_eq!(fixture.entries(), vec![path]);
}

#[test]
fn checked_postcommit_sync_error_reports_committed_exact_bytes_and_version() {
    let fixture = Fixture::new();
    for exists in [false, true] {
        let path = fixture.path(if exists { "existing.xml" } else { "new.xml" });
        if exists {
            fs::write(&path, b"original").unwrap();
        }
        let expected = inspect_save_destination(&path).unwrap().1;
        let result = write_atomic_checked_with(
            &path,
            b"committed\r\n",
            expected.as_deref(),
            CheckedSaveHooks {
                fail_directory_sync: true,
                ..Default::default()
            },
        );
        assert_eq!(result.status, "saved");
        assert!(result.success);
        assert_eq!(result.durability_uncertain, Some(true));
        assert!(result.error.unwrap().contains("committed"));
        assert_eq!(
            result.file_version,
            Some(file_version(&path, b"committed\r\n"))
        );
        assert_eq!(fs::read(path).unwrap(), b"committed\r\n");
    }
    assert_eq!(fixture.entries().len(), 2);
}

#[cfg(unix)]
#[test]
fn checked_save_rejects_symlink_retarget_before_and_during_staging() {
    use std::os::unix::fs::symlink;
    for during_staging in [false, true] {
        let fixture = Fixture::new();
        let a = fixture.path("a.xml");
        let b = fixture.path("b.xml");
        let link = fixture.path("link.xml");
        fs::write(&a, b"same bytes").unwrap();
        fs::write(&b, b"same bytes").unwrap();
        symlink(&a, &link).unwrap();
        let baseline = inspect_save_destination(&link).unwrap().1.unwrap();
        let retarget = {
            let link = link.clone();
            let b = b.clone();
            move || {
                fs::remove_file(&link).unwrap();
                symlink(&b, &link).unwrap();
            }
        };
        let hooks = if during_staging {
            CheckedSaveHooks {
                before_final_check: Some(Box::new(retarget)),
                ..Default::default()
            }
        } else {
            retarget();
            CheckedSaveHooks::default()
        };
        let result = write_atomic_checked_with(&link, b"must not save", Some(&baseline), hooks);
        assert_eq!(result.status, "conflict");
        assert_eq!(
            result.observed_file_version,
            Some(file_version(&b, b"same bytes"))
        );
        assert_eq!(fs::read(&a).unwrap(), b"same bytes");
        assert_eq!(fs::read(&b).unwrap(), b"same bytes");
        assert_eq!(fs::read_link(&link).unwrap(), b);
        assert_eq!(fixture.entries().len(), 3);
    }
}

#[cfg(unix)]
#[test]
fn checked_save_rejects_readonly_and_preserves_existing_permissions_on_success() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let path = fixture.path("private.xml");
    fs::write(&path, b"original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    let denied = write_atomic_checked(&path, b"denied", Some(&baseline));
    assert_eq!(denied.status, "error");
    assert_eq!(denied.state, Some("unreadable"));
    assert_eq!(fs::read(&path).unwrap(), b"original");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let saved = write_atomic_checked(&path, b"saved", Some(&baseline));
    assert_eq!(saved.status, "saved");
    assert_eq!(fs::read(&path).unwrap(), b"saved");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn final_check_rejects_destination_made_readonly_after_staging() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let path = fixture.path("private.xml");
    fs::write(&path, b"original").unwrap();
    let baseline = inspect_save_destination(&path).unwrap().1.unwrap();
    let changed = path.clone();
    let result = write_atomic_checked_with(
        &path,
        b"local replacement",
        Some(&baseline),
        CheckedSaveHooks {
            before_final_check: Some(Box::new(move || {
                fs::set_permissions(changed, fs::Permissions::from_mode(0o444)).unwrap();
            })),
            ..Default::default()
        },
    );
    assert_eq!(result.status, "error");
    assert_eq!(result.state, Some("unreadable"));
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o444
    );
    assert_eq!(fixture.entries(), vec![path]);
}

#[cfg(unix)]
#[test]
fn context_bound_saves_recheck_library_containment_before_staging_and_before_commit() {
    use crate::workspace::library::BehaviorDirectoryMapping;
    use crate::workspace::resolver::resolve_workflow_source_path_io;
    use std::os::unix::fs::symlink;
    for during_staging in [false, true] {
        let fixture = Fixture::new();
        let root = fixture.path("library");
        fs::create_dir(&root).unwrap();
        let original = root.join("original.xml");
        let outside = fixture.path("outside.xml");
        let link = root.join("source.xml");
        fs::write(&original, b"loaded workflow").unwrap();
        fs::write(&outside, b"outside must stay intact").unwrap();
        symlink(&original, &link).unwrap();
        let baseline = inspect_save_destination(&original).unwrap().1.unwrap();
        let mappings = vec![BehaviorDirectoryMapping {
            key: "LIB".into(),
            path: root.to_string_lossy().into_owned(),
        }];
        let escape = {
            let link = link.clone();
            let outside = outside.clone();
            move || {
                fs::remove_file(&link).unwrap();
                symlink(&outside, &link).unwrap();
            }
        };
        let hooks = if during_staging {
            CheckedSaveHooks {
                before_final_check: Some(Box::new(escape)),
                ..Default::default()
            }
        } else {
            escape();
            CheckedSaveHooks::default()
        };
        let resolve = || {
            resolve_workflow_source_path_io("${LIB}/source.xml", &mappings, None)
                .map(|resolved| resolved.path)
        };
        let result = write_atomic_checked_resolving_with(
            &original,
            b"local edits",
            Some(&baseline),
            hooks,
            Some(&resolve),
        );
        assert_eq!(result.status, "error");
        assert_eq!(result.state, Some("unreadable"));
        assert!(result.error.unwrap().contains("outside"));
        assert_eq!(fs::read(&original).unwrap(), b"loaded workflow");
        assert_eq!(fs::read(&outside).unwrap(), b"outside must stay intact");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
    }
}

#[test]
fn context_mapping_change_conflicts_even_when_canonical_save_path_is_unchanged() {
    use crate::workspace::library::BehaviorDirectoryMapping;
    use crate::workspace::resolver::resolve_workflow_source_path_io;
    let fixture = Fixture::new();
    let first = fixture.path("first");
    let second = fixture.path("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let original = first.join("workflow.xml");
    let remapped = second.join("workflow.xml");
    fs::write(&original, b"same bytes").unwrap();
    fs::write(&remapped, b"same bytes").unwrap();
    let baseline = inspect_save_destination(&original).unwrap().1.unwrap();
    let mappings = vec![BehaviorDirectoryMapping {
        key: "LIB".into(),
        path: second.to_string_lossy().into_owned(),
    }];
    let result =
        write_atomic_checked_resolving(&original, b"must not save", Some(&baseline), || {
            resolve_workflow_source_path_io("${LIB}/workflow.xml", &mappings, None)
                .map(|resolved| resolved.path)
        });
    assert_eq!(result.status, "conflict");
    assert_eq!(
        result.observed_file_version,
        Some(file_version(&remapped, b"same bytes"))
    );
    assert_eq!(fs::read(original).unwrap(), b"same bytes");
    assert_eq!(fs::read(remapped).unwrap(), b"same bytes");
}
