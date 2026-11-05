use ticketd_core::Workspace;

#[test]
fn change_token_moves_on_every_kind_of_write_and_is_stable_otherwise() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("token.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let mut last = workspace.change_token().unwrap();
    let mut moved = |workspace: &Workspace, what: &str| {
        let next = workspace.change_token().unwrap();
        assert_ne!(next, last, "{what} should change the token");
        last = next;
    };

    let first = workspace.create_ticket("First").unwrap();
    moved(&workspace, "creating a ticket");
    let second = workspace.create_ticket("Second").unwrap();
    moved(&workspace, "creating another ticket");
    workspace
        .add_activity(&first.reference, "Progress", Some("agent"))
        .unwrap();
    moved(&workspace, "an Activity");
    workspace.add_tag(&first.reference, "ui").unwrap();
    moved(&workspace, "a tag");
    workspace
        .add_dependency(&first.reference, &second.reference, None)
        .unwrap();
    moved(&workspace, "a relationship");
    workspace.create_plan("Plan").unwrap();
    moved(&workspace, "a plan");
    let document = workspace.create_document(Some("Doc"), "Body").unwrap();
    moved(&workspace, "a Document");
    workspace.set_document_pin(&document.id, true).unwrap();
    moved(&workspace, "pinning a Document");

    // Reads, repeated polls and opening a Document leave it alone.
    let stable = workspace.change_token().unwrap();
    workspace.find_tickets(&Default::default()).ok();
    workspace.open_document(&document.id).unwrap();
    assert_eq!(workspace.change_token().unwrap(), stable);
    assert_eq!(workspace.change_token().unwrap(), stable);

    // Another connection (the CLI or an agent) is seen through a fresh handle.
    let mut other = Workspace::open(&path).unwrap();
    other.create_ticket("From the CLI").unwrap();
    assert_ne!(workspace.change_token().unwrap(), stable);
}

#[test]
fn change_token_moves_when_a_plan_spec_or_document_link_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("plan.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let document = workspace.create_document(Some("Spec"), "Body").unwrap();
    let before = workspace.change_token().unwrap();
    workspace
        .set_plan_document(&plan.id, &document.id, true)
        .unwrap();
    let linked = workspace.change_token().unwrap();
    assert_ne!(linked, before);
    workspace
        .set_plan_spec(&plan.id, Some(&document.id))
        .unwrap();
    let spec = workspace.change_token().unwrap();
    assert_ne!(spec, linked);
    workspace
        .set_plan_document(&plan.id, &document.id, false)
        .unwrap();
    assert_ne!(workspace.change_token().unwrap(), spec);
}
