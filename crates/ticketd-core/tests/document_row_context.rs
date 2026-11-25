#![allow(clippy::unwrap_used, clippy::panic)] // Setup that fails fails the test.

use ticketd_core::{DocumentSummary, Status, TicketPatch, Workspace};

fn row(rows: Vec<DocumentSummary>, id: &str) -> DocumentSummary {
    rows.into_iter()
        .find(|row| row.id == id)
        .unwrap_or_else(|| panic!("row {id} is listed"))
}

fn open_workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    (dir, workspace)
}

#[test]
fn a_row_names_its_plans_archived_ones_included_and_which_it_is_the_spec_of() {
    let (_dir, mut workspace) = open_workspace();
    let active = workspace.create_plan("Checkout revamp").unwrap();
    let old = workspace.create_plan("Old launch").unwrap();
    let doc = workspace.create_document(Some("Notes"), "body").unwrap();
    let spec = workspace.create_document(Some("Spec"), "body").unwrap();
    workspace
        .set_plan_document(&active.id, &doc.id, true)
        .unwrap();
    workspace.set_plan_document(&old.id, &doc.id, true).unwrap();
    workspace.set_plan_spec(&active.id, Some(&spec.id)).unwrap();
    workspace.change_plan(&old.id, None, Some(true)).unwrap();

    let all = workspace.all_documents_page(50, 0, false).unwrap();
    let notes = row(all.clone(), &doc.id);
    let plans: Vec<_> = notes
        .plans
        .iter()
        .map(|plan| (plan.name.as_str(), plan.archived, plan.spec))
        .collect();
    assert_eq!(
        plans,
        vec![
            ("Checkout revamp", false, false),
            ("Old launch", true, false)
        ]
    );
    let spec = row(all, &spec.id);
    assert_eq!(spec.plans.len(), 1);
    assert_eq!(
        (spec.plans[0].name.as_str(), spec.plans[0].spec),
        ("Checkout revamp", true)
    );
}

#[test]
fn a_row_names_the_tickets_that_mention_or_attach_it_but_not_trashed_ones() {
    let (_dir, mut workspace) = open_workspace();
    let doc = workspace.create_document(Some("Brief"), "body").unwrap();
    let link = format!("[Brief](ticketd://document/{})", doc.id);
    let mentioning = workspace.create_ticket("Mentions it").unwrap();
    workspace
        .change_ticket(
            &mentioning.reference,
            TicketPatch {
                body: Some(link),
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    let attaching = workspace.create_ticket("Attaches it").unwrap();
    workspace
        .set_ticket_document(&attaching.reference, &doc.id, true)
        .unwrap();
    let gone = workspace.create_ticket("Trashed").unwrap();
    workspace
        .set_ticket_document(&gone.reference, &doc.id, true)
        .unwrap();
    workspace.set_trashed(&gone.reference, true, None).unwrap();

    let found = row(workspace.all_documents_page(50, 0, false).unwrap(), &doc.id);
    let tickets: Vec<_> = found
        .tickets
        .iter()
        .map(|ticket| {
            (
                ticket.reference.as_str(),
                ticket.title.as_str(),
                ticket.status.as_str(),
            )
        })
        .collect();
    assert_eq!(
        tickets,
        vec![
            (mentioning.reference.as_str(), "Mentions it", "In progress"),
            (attaching.reference.as_str(), "Attaches it", "Todo"),
        ]
    );
}

#[test]
fn a_document_with_no_plan_and_no_ticket_has_an_empty_context() {
    let (_dir, mut workspace) = open_workspace();
    let doc = workspace.create_document(Some("Loose"), "body").unwrap();
    let found = row(workspace.all_documents_page(50, 0, false).unwrap(), &doc.id);
    assert!(found.plans.is_empty() && found.tickets.is_empty());
}

#[test]
fn a_row_says_whether_the_document_was_opened_on_this_computer() {
    let (_dir, mut workspace) = open_workspace();
    let ticket = workspace.create_ticket("Work").unwrap();
    // Details made by an update start unopened; keeping one lists it without opening it.
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Update", None, Some("Details"), None)
        .unwrap();
    let id = activity.supporting_document_id.unwrap();
    workspace.keep_document(&id).unwrap();
    let before = row(workspace.all_documents_page(50, 0, false).unwrap(), &id);
    assert!(!before.opened);
    workspace.open_document(&id).unwrap();
    let after = row(workspace.all_documents_page(50, 0, false).unwrap(), &id);
    assert!(after.opened);
}

#[test]
fn recent_all_pinned_and_search_rows_carry_the_same_context() {
    let (_dir, mut workspace) = open_workspace();
    let plan = workspace.create_plan("Launch").unwrap();
    let doc = workspace
        .create_document(Some("Launch checklist"), "steps")
        .unwrap();
    workspace
        .set_plan_document(&plan.id, &doc.id, true)
        .unwrap();
    workspace.set_document_pin(&doc.id, true).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &doc.id, true)
        .unwrap();

    let expected = row(workspace.all_documents_page(50, 0, false).unwrap(), &doc.id);
    assert_eq!(expected.plans.len(), 1);
    assert_eq!(expected.tickets.len(), 1);
    assert!(expected.opened);
    assert_eq!(
        row(workspace.recent_documents().unwrap(), &doc.id),
        expected
    );
    assert_eq!(
        row(workspace.pinned_documents(50, 0).unwrap(), &doc.id),
        expected
    );
    let found = workspace
        .search_documents("checklist", None, 50, 0)
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].plans, expected.plans);
    assert_eq!(found[0].tickets, expected.tickets);
    assert_eq!(found[0].opened, expected.opened);
    let tagged = {
        workspace.set_document_tag(&doc.id, "launch", true).unwrap();
        workspace
            .search_documents("", Some("launch"), 50, 0)
            .unwrap()
    };
    assert_eq!(tagged[0].plans, expected.plans);
}
