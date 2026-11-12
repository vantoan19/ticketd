use ticketd_core::{Error, TicketPatch, Workspace};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace(directory: &tempfile::TempDir, name: &str) -> Workspace {
    Workspace::open(directory.path().join(name)).unwrap()
}

#[test]
fn tickets_take_the_device_code_and_the_next_device_counter() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    // Test runs fix the otherwise random code (the `test-device-code` feature).
    assert_eq!(workspace.device_code().unwrap(), "KQ");

    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();

    assert_eq!(first.reference, "T-KQ1");
    assert_eq!(second.reference, "T-KQ2");
    assert_eq!(workspace.show_ticket("T-KQ2").unwrap().id, second.id);
    assert_eq!(workspace.list_tickets().unwrap()[0].reference, "T-KQ2");
}

#[test]
fn a_numeric_reference_is_not_an_alias() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    workspace.create_ticket("First").unwrap();

    assert!(matches!(
        workspace.show_ticket("T-1"),
        Err(Error::NotFound(reference)) if reference == "T-1"
    ));
}

#[test]
fn a_fresh_code_applies_to_new_tickets_and_leaves_issued_references_alone() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let issued = workspace.create_ticket("Before").unwrap();

    let code = workspace.renew_device_code().unwrap();

    assert_ne!(code, "KQ");
    assert!(code.len() == 2 && code.chars().all(|c| c.is_ascii_uppercase()));
    assert_eq!(workspace.device_code().unwrap(), code);
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap().id, issued.id);
    let next = workspace.create_ticket("After").unwrap();
    assert_eq!(next.reference, format!("T-{code}2"));
    assert_eq!(workspace.show_ticket(&next.reference).unwrap().id, next.id);
}

#[test]
fn workspaces_with_different_codes_never_issue_the_same_reference() {
    let directory = tempfile::tempdir().unwrap();
    let mut a = workspace(&directory, "a.sqlite3");
    let mut b = workspace(&directory, "b.sqlite3");
    b.renew_device_code().unwrap();

    let from_a: Vec<String> = (0..3)
        .map(|_| a.create_ticket("A").unwrap().reference)
        .collect();
    let from_b: Vec<String> = (0..3)
        .map(|_| b.create_ticket("B").unwrap().reference)
        .collect();

    assert!(from_a.iter().all(|reference| !from_b.contains(reference)));
}

#[test]
fn text_mentions_and_links_resolve_device_references() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let target = workspace.create_ticket("Target").unwrap();
    let source = workspace.create_ticket("Source").unwrap();
    assert_eq!(
        workspace.context_link_markdown("T-KQ1").unwrap(),
        "[T-KQ1](ticketd://ticket/T-KQ1)"
    );

    // T-1 and T-kq1 are not references; T-KQ3 names a ticket that does not exist yet.
    workspace
        .change_ticket(
            &source.reference,
            TicketPatch {
                body: Some("See T-KQ1, not T-1 or T-kq1.\n\nLater: T-KQ3".into()),
                ..Default::default()
            },
        )
        .unwrap();

    let backlinks = workspace.backlinks("T-KQ1", 10, 0).unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_reference, "T-KQ2");
    let links = workspace.context_links("T-KQ2", 10, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_id, target.id);
    assert_eq!(links[0].target_label, "T-KQ1");

    let later = workspace.create_ticket("Later").unwrap();
    let links = workspace.context_links("T-KQ2", 10, 0).unwrap();
    assert!(links.iter().any(|link| link.target_id == later.id));
}

#[test]
fn a_restored_workspace_takes_a_fresh_code_so_its_counter_cannot_reissue_a_reference() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("a.sqlite3");
    let backup = directory.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let kept = workspace.create_ticket("Kept").unwrap();
    workspace.backup(&backup).unwrap();
    // Created after the backup: restoring rewinds the counter past this reference.
    assert_eq!(workspace.create_ticket("Lost").unwrap().reference, "T-KQ2");
    drop(workspace);

    Workspace::restore(&path, &backup).unwrap();
    let mut restored = Workspace::open(&path).unwrap();

    assert_ne!(restored.device_code().unwrap(), "KQ");
    assert_eq!(restored.show_ticket("T-KQ1").unwrap().id, kept.id);
    assert_ne!(restored.create_ticket("New").unwrap().reference, "T-KQ2");
}
