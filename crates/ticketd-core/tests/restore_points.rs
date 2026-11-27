//! Restore points: one a day on the first open, the last seven kept, safety copies kept
//! besides them, each checked after writing, and attachment files shared so that deleting an
//! old point never breaks a newer one.
#[path = "support/old_workspace.rs"]
mod old_workspace;

use std::{fs, path::Path};

use chrono::{DateTime, FixedOffset};
use rusqlite::Connection;
use ticketd_core::{BackupCheck, RESTORE_POINTS_KEPT, RestorePointKind, Workspace};

/// A moment in the person's own time, so the tests decide what a day is.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn at(moment: &str) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(moment).unwrap()
}

fn day(number: u32) -> DateTime<FixedOffset> {
    at(&format!("2026-11-{number:02}T08:52:00+10:00"))
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn open(dir: &Path) -> Workspace {
    Workspace::open(dir.join("workspace.sqlite3")).unwrap()
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn shared_files(workspace: &Workspace) -> usize {
    fs::read_dir(workspace.restore_points_folder().unwrap().join("files"))
        .map_or(0, |files| files.count())
}

#[test]
fn the_first_open_of_each_day_saves_one_point_and_the_rest_of_that_day_saves_none() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(dir.path());
    workspace.create_ticket("Plan the launch").unwrap();

    let first = workspace
        .save_daily_restore_point_at(day(26))
        .unwrap()
        .unwrap();
    assert_eq!(first.kind, RestorePointKind::Daily);
    assert_eq!(first.saved_at, "2026-11-25T22:52:00Z");
    assert_eq!(first.problem, None);
    assert_eq!(first.summary.as_ref().map(|s| s.tickets), Some(1));
    // Later the same day, and from another process: nothing to do.
    assert!(
        workspace
            .save_daily_restore_point_at(at("2026-11-26T23:50:00+10:00"))
            .unwrap()
            .is_none()
    );
    // Midnight in the person's time zone starts a new day, though it is still the same day
    // in UTC.
    let next = workspace
        .save_daily_restore_point_at(at("2026-11-27T00:10:00+10:00"))
        .unwrap();
    assert!(next.is_some());
    let listed = workspace.restore_points().unwrap().points;
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].saved_at, "2026-11-26T14:10:00Z");
}

#[test]
fn points_live_beside_the_workspace_file_never_inside_it_or_its_attachment_storage() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    let point = workspace
        .save_daily_restore_point_at(day(26))
        .unwrap()
        .unwrap();
    let folder = dir.path().join("workspace.sqlite3.restore-points");
    assert_eq!(
        workspace
            .restore_points_folder()
            .unwrap()
            .canonicalize()
            .unwrap(),
        folder.canonicalize().unwrap()
    );
    let folder = folder.canonicalize().unwrap();
    assert!(
        Path::new(&point.path)
            .canonicalize()
            .unwrap()
            .starts_with(&folder)
    );
    assert!(!folder.starts_with(dir.path().join("workspace.sqlite3.attachments")));
}

#[test]
fn the_last_seven_points_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    for number in 10..20 {
        workspace.save_daily_restore_point_at(day(number)).unwrap();
    }
    let kept = workspace.restore_points().unwrap().points;
    assert_eq!(kept.len(), RESTORE_POINTS_KEPT);
    assert_eq!(kept[0].saved_at, "2026-11-18T22:52:00Z");
    assert_eq!(kept[6].saved_at, "2026-11-12T22:52:00Z");
    // Nothing of the three that went is left in the folder.
    let folder = workspace.restore_points_folder().unwrap();
    let files = fs::read_dir(folder)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".sqlite3")
        })
        .count();
    assert_eq!(files, 7);
}

#[test]
fn back_up_now_adds_a_point_without_a_path_and_counts_among_the_seven() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    workspace.save_daily_restore_point_at(day(26)).unwrap();
    let saved = workspace
        .save_manual_restore_point_at(at("2026-11-26T09:30:00+10:00"))
        .unwrap();
    assert_eq!(saved.kind, RestorePointKind::Manual);
    // A manual point is not today's daily one.
    assert!(
        workspace
            .save_daily_restore_point_at(at("2026-11-26T10:00:00+10:00"))
            .unwrap()
            .is_none()
    );
    let kinds: Vec<_> = workspace
        .restore_points()
        .unwrap()
        .points
        .iter()
        .map(|point| point.kind)
        .collect();
    assert_eq!(kinds, [RestorePointKind::Manual, RestorePointKind::Daily]);
}

#[test]
fn safety_copies_are_listed_with_their_labels_and_kept_besides_the_seven() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    // A copy saved before an update: opening a Workspace from an older format makes one.
    old_workspace::workspace_with_attachment(&path, 47, "trace.txt", b"retained");
    let workspace = Workspace::open(&path).unwrap();
    for number in 10..14 {
        workspace.save_daily_restore_point_at(day(number)).unwrap();
    }
    let point = workspace
        .restore_points()
        .unwrap()
        .points
        .into_iter()
        .find(|point| point.kind == RestorePointKind::Daily)
        .unwrap()
        .path;
    drop(workspace);
    // And one saved before a restore.
    Workspace::restore(&path, &point).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    // More days than the seven it keeps.
    for number in 14..24 {
        workspace.save_daily_restore_point_at(day(number)).unwrap();
    }
    let list = workspace.restore_points().unwrap();
    let count = |kind| {
        list.points
            .iter()
            .filter(|point| point.kind == kind)
            .count()
    };
    assert_eq!(count(RestorePointKind::Daily), RESTORE_POINTS_KEPT);
    assert_eq!(count(RestorePointKind::PreMigration), 1);
    assert_eq!(count(RestorePointKind::Safety), 1);
    let update = list
        .points
        .iter()
        .find(|point| point.kind == RestorePointKind::PreMigration)
        .unwrap();
    assert_eq!(
        update.update_version.as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(update.problem, None);
    assert!(update.summary.is_some());
}

#[test]
fn a_point_that_fails_its_check_is_kept_and_says_it_cannot_be_restored() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    // A Workspace an earlier build left without one of its triggers still saves a point,
    // and the point does not pass the check a restore makes.
    let trigger: String = Connection::open(dir.path().join("workspace.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    Connection::open(dir.path().join("workspace.sqlite3"))
        .unwrap()
        .execute_batch(&format!("DROP TRIGGER \"{trigger}\""))
        .unwrap();
    let point = workspace
        .save_daily_restore_point_at(day(26))
        .unwrap()
        .unwrap();
    assert!(point.problem.is_some(), "{point:?}");
    assert!(point.summary.is_none());
    let listed = workspace.restore_points().unwrap().points;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].problem, point.problem);
    // Restoring it is refused for the same reason.
    assert!(matches!(
        workspace.inspect_backup(&point.path).unwrap().check,
        BackupCheck::MissingTables { .. }
    ));
}

#[test]
fn an_attachment_file_that_went_missing_makes_its_points_unrestorable_in_the_list() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let mut workspace = open(dir.path());
    workspace.import_attachment("one", &source, None).unwrap();
    workspace.save_daily_restore_point_at(day(26)).unwrap();
    assert_eq!(workspace.restore_points().unwrap().points[0].problem, None);
    let folder = workspace.restore_points_folder().unwrap().join("files");
    for file in fs::read_dir(folder).unwrap() {
        fs::remove_file(file.unwrap().path()).unwrap();
    }
    let listed = workspace.restore_points().unwrap().points;
    assert!(listed[0].problem.is_some());
}

#[test]
fn unchanged_attachment_files_are_shared_and_deleting_old_points_never_breaks_a_newer_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(dir.path());
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&first, b"the first file").unwrap();
    fs::write(&second, b"the second file").unwrap();
    let kept = workspace.import_attachment("one", &first, None).unwrap();
    workspace.save_daily_restore_point_at(day(10)).unwrap();
    // Its bytes and the record of its upload.
    assert_eq!(shared_files(&workspace), 2);
    let added = workspace.import_attachment("two", &second, None).unwrap();
    // Seven more days: the first point, the only one without the second file, goes.
    for number in 11..18 {
        workspace.save_daily_restore_point_at(day(number)).unwrap();
    }
    // Eight points over two attachments cost their four files once, not eight times.
    assert_eq!(shared_files(&workspace), 4);
    let list = workspace.restore_points().unwrap();
    assert_eq!(list.points.len(), RESTORE_POINTS_KEPT);
    assert!(list.points.iter().all(|point| point.problem.is_none()));
    // The oldest point left still restores both files, and so does the newest.
    for point in [&list.points[0], &list.points[6]] {
        let inspection = workspace.inspect_backup(&point.path).unwrap();
        assert!(matches!(inspection.check, BackupCheck::Valid { .. }));
        let content = inspection.attachment_content.unwrap();
        assert_eq!(content.container_version, Some(2));
        assert_eq!(content.retained_files, 2);
    }
    let newest = list.points[0].path.clone();
    drop(workspace);
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &newest).unwrap();
    let restored = Workspace::open(&target).unwrap();
    for (attachment, bytes) in [
        (kept, b"the first file".as_slice()),
        (added, b"the second file".as_slice()),
    ] {
        let output = dir.path().join(&attachment.id);
        restored.export_attachment(&attachment.id, &output).unwrap();
        assert_eq!(fs::read(output).unwrap(), bytes);
    }
}

#[test]
fn files_no_remaining_point_needs_are_deleted_with_the_points_that_named_them() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    workspace.save_daily_restore_point_at(day(10)).unwrap();
    let store = workspace.restore_points_folder().unwrap().join("files");
    fs::create_dir_all(&store).unwrap();
    fs::write(store.join("left-over"), b"x").unwrap();
    workspace.save_daily_restore_point_at(day(11)).unwrap();
    assert_eq!(shared_files(&workspace), 0);
}

#[test]
fn a_save_that_was_interrupted_leaves_nothing_in_the_list_and_is_cleared_next_time() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    let folder = workspace.restore_points_folder().unwrap();
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("20261125T000000Z-daily-abcd1234.sqlite3"),
        b"half",
    )
    .unwrap();
    fs::write(folder.join(".tmpHalfWritten"), b"half").unwrap();
    assert!(workspace.restore_points().unwrap().points.is_empty());
    workspace.save_daily_restore_point_at(day(26)).unwrap();
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 3, "{names:?}"); // point, record, lock
}

/// A record that cannot be read is not the same as no record: the point it belongs to was
/// finished, so the next save neither deletes it nor the attachment files it needs.
#[test]
fn a_point_whose_record_cannot_be_read_is_kept_with_its_attachment_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(dir.path());
    let file = dir.path().join("first.txt");
    fs::write(&file, b"the first file").unwrap();
    workspace.import_attachment("one", &file, None).unwrap();
    let point = workspace
        .save_daily_restore_point_at(day(10))
        .unwrap()
        .unwrap();
    let files_before = shared_files(&workspace);
    assert_eq!(files_before, 2);
    let database = std::path::PathBuf::from(&point.path);
    let record = database.with_extension("json");
    fs::write(&record, b"{ not json").unwrap();

    // The next saves are where unfinished points are cleared and old files pruned.
    workspace.save_daily_restore_point_at(day(11)).unwrap();
    for number in 12..20 {
        workspace.save_daily_restore_point_at(day(number)).unwrap();
    }

    assert!(database.is_file(), "the point was deleted");
    assert_eq!(fs::read(&record).unwrap(), b"{ not json");
    // Its attachment files outlive the seven newer points that do not need them.
    assert_eq!(shared_files(&workspace), files_before);
    assert_eq!(
        workspace.restore_points().unwrap().points.len(),
        RESTORE_POINTS_KEPT
    );
}

/// When neither the record nor the point can say which attachment files it needs, no shared
/// file is deleted: they may all be needed.
#[test]
fn shared_files_stay_while_a_point_that_cannot_be_read_may_need_them() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = open(dir.path());
    let point = workspace
        .save_daily_restore_point_at(day(10))
        .unwrap()
        .unwrap();
    let database = std::path::PathBuf::from(&point.path);
    fs::write(database.with_extension("json"), b"").unwrap();
    fs::write(&database, b"not a database").unwrap();
    let store = workspace.restore_points_folder().unwrap().join("files");
    fs::create_dir_all(&store).unwrap();
    fs::write(store.join("unknown-owner"), b"x").unwrap();

    workspace.save_daily_restore_point_at(day(11)).unwrap();

    assert!(database.is_file());
    assert!(store.join("unknown-owner").is_file());
}

/// A shared file damaged without changing its length is not reused: the next point writes
/// the healthy bytes over it, so one bad file does not stop every later point.
#[test]
fn a_shared_file_whose_bytes_changed_is_replaced_from_the_healthy_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(dir.path());
    let file = dir.path().join("first.txt");
    fs::write(&file, b"the first file").unwrap();
    let attachment = workspace.import_attachment("one", &file, None).unwrap();
    workspace.save_daily_restore_point_at(day(10)).unwrap();
    let store = workspace.restore_points_folder().unwrap().join("files");
    let healthy: Vec<_> = fs::read_dir(&store)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| (fs::read(&path).unwrap(), path))
        .collect();
    for (bytes, path) in &healthy {
        fs::write(path, vec![0xAA; bytes.len()]).unwrap();
    }

    let next = workspace
        .save_daily_restore_point_at(day(11))
        .unwrap()
        .unwrap();

    assert_eq!(next.problem, None);
    for (bytes, path) in &healthy {
        assert_eq!(&fs::read(path).unwrap(), bytes, "{}", path.display());
    }
    let inspection = workspace.inspect_backup(&next.path).unwrap();
    assert!(matches!(inspection.check, BackupCheck::Valid { .. }));
    drop(workspace);
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &next.path).unwrap();
    let output = dir.path().join("out");
    Workspace::open(&target)
        .unwrap()
        .export_attachment(&attachment.id, &output)
        .unwrap();
    assert_eq!(fs::read(output).unwrap(), b"the first file");
}

#[test]
fn a_backup_saved_to_a_path_is_still_a_standalone_file_that_restores_anywhere() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.txt");
    fs::write(&source, b"retained").unwrap();
    let mut workspace = open(dir.path());
    let attachment = workspace.import_attachment("one", &source, None).unwrap();
    workspace.save_daily_restore_point_at(day(26)).unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let backup = elsewhere.path().join("copy.sqlite3");
    workspace.backup(&backup).unwrap();
    let content = workspace
        .inspect_backup(&backup)
        .unwrap()
        .attachment_content
        .unwrap();
    assert_eq!(content.container_version, Some(1));
    let target = elsewhere.path().join("restored.sqlite3");
    drop(workspace);
    Workspace::restore(&target, &backup).unwrap();
    let output = elsewhere.path().join("out.txt");
    Workspace::open(&target)
        .unwrap()
        .export_attachment(&attachment.id, &output)
        .unwrap();
    assert_eq!(fs::read(output).unwrap(), b"retained");
}

#[test]
fn a_points_counts_are_read_from_the_point_beside_the_workspaces_own() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(dir.path());
    let login = workspace.create_ticket("Login").unwrap().reference;
    workspace.create_ticket("Search").unwrap();
    workspace.create_document(Some("Context"), "Why").unwrap();
    workspace.add_activity(&login, "Started", None).unwrap();
    let point = workspace
        .save_daily_restore_point_at(day(26))
        .unwrap()
        .unwrap();
    let at_the_point = point.summary.clone().unwrap();
    // The Workspace moves on after the point was saved.
    workspace.create_ticket("Billing").unwrap();
    workspace.add_activity(&login, "Done", None).unwrap();
    workspace.add_activity(&login, "Shipped", None).unwrap();

    let inspection = workspace.inspect_backup(&point.path).unwrap();

    // The counts the restore dialog shows: this Workspace now, and the point.
    assert_eq!(
        (
            inspection.current.tickets,
            inspection.current.documents,
            inspection.current.activities
        ),
        (3, 1, 3)
    );
    let BackupCheck::Valid { summary, .. } = inspection.check else {
        panic!("a restore point is a valid backup: {:?}", inspection.check);
    };
    assert_eq!(
        (summary.tickets, summary.documents, summary.activities),
        (2, 1, 1)
    );
    assert_eq!(summary, at_the_point);
    // The last change is the point's own: nothing later than what it held.
    assert!(summary.last_change.is_some());
    assert!(summary.last_change <= inspection.current.last_change);
}
