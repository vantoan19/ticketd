//! Input the core refuses or normalizes the same way whichever entry point sent it:
//! checkout folders, request IDs, tag changes and editing agent names.

use std::time::Duration;

use ticketd_core::{Error, TicketPatch, Workspace, WriteRequest};

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn open() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    (dir, workspace)
}

/// A new folder in `dir`, as the canonical path text a Project stores.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn folder(dir: &tempfile::TempDir, name: &str) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    path.canonicalize().unwrap().to_str().unwrap().to_owned()
}

#[test]
#[allow(clippy::unwrap_used)]
fn unregistering_a_checkout_keeps_the_primary_path_one_of_the_registered_paths() {
    let (dir, mut workspace) = open();
    let (first, second) = (folder(&dir, "first"), folder(&dir, "second"));
    let project = workspace.create_project("P", &first).unwrap();
    workspace.register_checkout(&project.id, &second).unwrap();

    let moved = workspace.remove_checkout(&project.id, &first).unwrap();
    assert_eq!(
        (moved.path.as_str(), moved.paths),
        (second.as_str(), vec![second.clone()])
    );

    let empty = workspace.remove_checkout(&project.id, &second).unwrap();
    assert_eq!((empty.path.as_str(), empty.paths.len()), ("", 0));

    // Naming the folder again registers it, as a rename that sends the old path does.
    let again = workspace.edit_project(&project.id, "P", &first).unwrap();
    assert_eq!((again.path, again.paths), (first.clone(), vec![first]));
}

#[test]
#[allow(clippy::unwrap_used)]
fn a_project_checkout_is_an_existing_folder_stored_as_an_absolute_path() {
    let (dir, mut workspace) = open();
    let real = folder(&dir, "real");
    let file = dir.path().join("file.txt");
    std::fs::write(&file, "not a folder").unwrap();
    let missing = dir.path().join("missing");
    let project = workspace.create_project("P", &real).unwrap();

    for refused in [
        missing.to_str().unwrap(),
        file.to_str().unwrap(),
        "./relative",
    ] {
        assert!(
            matches!(
                workspace.create_project("Q", refused),
                Err(Error::NoCheckoutFolder(_))
            ),
            "create {refused}"
        );
        assert!(
            matches!(
                workspace.edit_project(&project.id, "P", refused),
                Err(Error::NoCheckoutFolder(_))
            ),
            "edit {refused}"
        );
    }
    assert_eq!(workspace.list_projects().unwrap().len(), 1);

    // A path that reaches the folder another way is stored as the folder's own path.
    let indirect = format!("{real}/../real");
    assert_eq!(
        workspace
            .edit_project(&project.id, "P", &indirect)
            .unwrap()
            .path,
        real
    );

    // Renaming a Project whose folder has since gone still works.
    std::fs::remove_dir(&real).unwrap();
    let renamed = workspace
        .edit_project(&project.id, "Renamed", &real)
        .unwrap();
    assert_eq!((renamed.name.as_str(), renamed.path), ("Renamed", real));
}

#[test]
#[allow(clippy::unwrap_used)]
fn a_blank_request_id_is_refused_instead_of_keying_the_write() {
    let (_dir, mut workspace) = open();
    let create = |title: &str| WriteRequest::CreateTicket {
        title: title.into(),
        project_id: None,
    };
    for blank in ["", "   "] {
        assert!(matches!(
            workspace.write(Some(blank), create("W")),
            Err(Error::EmptyRequestId)
        ));
    }
    assert!(workspace.list_tickets().unwrap().is_empty());
    workspace.write(None, create("W")).unwrap();
}

#[test]
#[allow(clippy::unwrap_used)]
fn a_tag_change_is_recorded_in_history_and_moves_updated_at() {
    let (_dir, mut workspace) = open();
    let ticket = workspace.create_ticket("T").unwrap();
    let before = workspace.show_ticket(&ticket.reference).unwrap().updated_at;

    std::thread::sleep(Duration::from_millis(20));
    workspace
        .add_tag_as(&ticket.reference, " Urgent ", Some("codex"))
        .unwrap();
    workspace.add_tag(&ticket.reference, "urgent").unwrap();
    let added = workspace.show_ticket(&ticket.reference).unwrap().updated_at;
    assert!(added > before);

    std::thread::sleep(Duration::from_millis(20));
    workspace
        .remove_tag_as(&ticket.reference, "urgent", Some("codex"))
        .unwrap();
    workspace.remove_tag(&ticket.reference, "urgent").unwrap();
    assert!(workspace.show_ticket(&ticket.reference).unwrap().updated_at > added);

    let changes: Vec<_> = workspace
        .ticket_history(&ticket.reference)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.kind == "tag")
        .map(|entry| (entry.from_value, entry.to_value, entry.editing_agent))
        .collect();
    assert_eq!(
        changes,
        [
            (String::new(), "urgent".into(), Some("codex".into())),
            ("urgent".into(), String::new(), Some("codex".into())),
        ]
    );
}

#[test]
#[allow(clippy::unwrap_used)]
fn an_editing_agent_is_trimmed_and_a_blank_one_is_no_attribution() {
    let (_dir, mut workspace) = open();
    let ticket = workspace.create_ticket("T").unwrap();
    let change = |status, agent: &str| TicketPatch {
        status: Some(status),
        editing_agent: Some(agent.into()),
        ..Default::default()
    };
    workspace
        .change_ticket(&ticket.reference, change(ticketd_core::Status::Done, ""))
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            change(ticketd_core::Status::Todo, "  spaced  "),
        )
        .unwrap();
    let agents: Vec<_> = workspace
        .ticket_history(&ticket.reference)
        .unwrap()
        .into_iter()
        .map(|entry| entry.editing_agent)
        .collect();
    assert_eq!(agents, [None, Some("spaced".to_owned())]);
}

#[test]
#[allow(clippy::unwrap_used)]
fn an_unregistered_folder_matches_no_project_by_either_lookup() {
    let (dir, mut workspace) = open();
    let checkout = folder(&dir, "checkout");
    let project = workspace.create_project("P", &checkout).unwrap();
    let inside = std::path::Path::new(&checkout);
    assert_eq!(
        workspace.resolve_project(inside).unwrap().unwrap().id,
        project.id
    );
    assert_eq!(
        workspace.project_for_folder(inside).unwrap().unwrap().id,
        project.id
    );

    workspace.remove_checkout(&project.id, &checkout).unwrap();
    assert!(workspace.resolve_project(inside).unwrap().is_none());
    assert!(workspace.project_for_folder(inside).unwrap().is_none());
}

#[test]
#[allow(clippy::unwrap_used)]
fn unregistering_a_folder_that_is_not_registered_is_an_error() {
    let (dir, mut workspace) = open();
    let (checkout, other) = (folder(&dir, "checkout"), folder(&dir, "other"));
    let project = workspace.create_project("P", &checkout).unwrap();
    assert!(matches!(
        workspace.remove_checkout(&project.id, &other),
        Err(Error::CheckoutNotRegistered(name)) if name == "P"
    ));
    assert_eq!(
        workspace.show_project(&project.id).unwrap().paths,
        vec![checkout]
    );
}
