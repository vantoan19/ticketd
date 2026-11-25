#![allow(clippy::unwrap_used, clippy::panic)] // Setup that fails fails the test.

use std::{thread::sleep, time::Duration};
use ticketd_core::{CurrentWork, Status, TicketPatch, Workspace};

fn open_workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    (dir, workspace)
}

/// Timestamps have millisecond resolution; a pause keeps "most recently updated" unambiguous.
fn tick() {
    sleep(Duration::from_millis(5));
}

fn document(workspace: &mut Workspace, title: &str) -> String {
    tick();
    workspace.create_document(Some(title), "body").unwrap().id
}

fn set_status(workspace: &mut Workspace, reference: &str, status: Status) {
    workspace
        .change_ticket(
            reference,
            TicketPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
}

fn headings(group: &ticketd_core::CurrentWorkGroup) -> Vec<&str> {
    group.documents.iter().map(|d| d.heading.as_str()).collect()
}

fn group<'a>(work: &'a CurrentWork, plan: &str) -> &'a ticketd_core::CurrentWorkGroup {
    work.groups
        .iter()
        .find(|group| group.plan.as_ref().map(|p| p.name.as_str()) == Some(plan))
        .unwrap_or_else(|| panic!("a group for {plan}"))
}

fn open_tickets(work: &CurrentWork) -> &ticketd_core::CurrentWorkGroup {
    work.groups
        .iter()
        .find(|group| group.plan.is_none())
        .expect("an Open tickets group")
}

#[test]
fn a_document_in_an_active_plan_is_current_with_the_spec_first() {
    let (_dir, mut workspace) = open_workspace();
    let plan = workspace.create_plan("Checkout").unwrap();
    let notes = document(&mut workspace, "Notes");
    let spec = document(&mut workspace, "Spec");
    let newest = document(&mut workspace, "Newest");
    for id in [&notes, &spec, &newest] {
        workspace.set_plan_document(&plan.id, id, true).unwrap();
    }
    workspace.set_plan_spec(&plan.id, Some(&spec)).unwrap();

    let work = workspace.current_work(false).unwrap();
    assert_eq!(work.groups.len(), 1);
    let checkout = group(&work, "Checkout");
    assert_eq!(checkout.plan.as_ref().unwrap().id, plan.id);
    assert_eq!(headings(checkout), ["Spec", "Newest", "Notes"]);
    assert_eq!((work.finished, work.unlinked), (0, 0));
}

#[test]
fn a_document_of_an_open_ticket_joins_that_tickets_active_plan() {
    let (_dir, mut workspace) = open_workspace();
    let plan = workspace.create_plan("Checkout").unwrap();
    let ticket = workspace.create_ticket("Build it").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    let log = document(&mut workspace, "Log");
    workspace
        .set_ticket_document(&ticket.reference, &log, true)
        .unwrap();

    let work = workspace.current_work(false).unwrap();
    assert_eq!(work.groups.len(), 1);
    assert_eq!(headings(group(&work, "Checkout")), ["Log"]);
}

#[test]
fn a_document_of_an_open_ticket_without_a_plan_is_under_open_tickets_last() {
    let (_dir, mut workspace) = open_workspace();
    let ticket = workspace.create_ticket("Loose work").unwrap();
    set_status(&mut workspace, &ticket.reference, Status::InReview);
    let loose = document(&mut workspace, "Loose notes");
    workspace
        .set_ticket_document(&ticket.reference, &loose, true)
        .unwrap();
    // The Plan group is older than the Open tickets group, yet comes first.
    let plan = workspace.create_plan("Older plan").unwrap();
    let planned = document(&mut workspace, "Planned");
    workspace
        .set_plan_document(&plan.id, &planned, true)
        .unwrap();
    tick();
    workspace
        .change_document(
            &loose,
            ticketd_core::DocumentPatch {
                body: Some("newer".into()),
                ..Default::default()
            },
        )
        .unwrap();

    let work = workspace.current_work(false).unwrap();
    assert_eq!(work.groups.len(), 2);
    assert_eq!(headings(&work.groups[0]), ["Planned"]);
    assert_eq!(headings(open_tickets(&work)), ["Loose notes"]);
    assert!(work.groups[1].plan.is_none());
}

#[test]
fn a_document_attached_to_an_active_plan_keeps_that_plan_over_its_ticket() {
    let (_dir, mut workspace) = open_workspace();
    let own = workspace.create_plan("Own").unwrap();
    let other = workspace.create_plan("Other").unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&other.id), None)
        .unwrap();
    let doc = document(&mut workspace, "Shared");
    workspace.set_plan_document(&own.id, &doc, true).unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &doc, true)
        .unwrap();

    let work = workspace.current_work(false).unwrap();
    assert_eq!(work.groups.len(), 1);
    assert_eq!(headings(group(&work, "Own")), ["Shared"]);
}

#[test]
fn an_archived_plan_with_a_done_ticket_is_finished_work() {
    let (_dir, mut workspace) = open_workspace();
    let plan = workspace.create_plan("Shipped").unwrap();
    let ticket = workspace.create_ticket("Ship it").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    let attached = document(&mut workspace, "Attached");
    let ticketed = document(&mut workspace, "Ticketed");
    workspace
        .set_plan_document(&plan.id, &attached, true)
        .unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &ticketed, true)
        .unwrap();
    set_status(&mut workspace, &ticket.reference, Status::Done);
    workspace.change_plan(&plan.id, None, Some(true)).unwrap();

    let work = workspace.current_work(false).unwrap();
    assert!(work.groups.is_empty());
    assert_eq!((work.finished, work.unlinked), (2, 0));
    let finished: Vec<_> = workspace
        .finished_documents_page(50, 0, false)
        .unwrap()
        .into_iter()
        .map(|d| d.heading)
        .collect();
    assert_eq!(finished, ["Ticketed", "Attached"]);
}

#[test]
fn a_document_with_no_links_is_in_no_plan_or_ticket() {
    let (_dir, mut workspace) = open_workspace();
    document(&mut workspace, "Older loose");
    document(&mut workspace, "Newer loose");

    let work = workspace.current_work(false).unwrap();
    assert!(work.groups.is_empty());
    assert_eq!((work.finished, work.unlinked), (0, 2));
    let page = |limit, offset| -> Vec<String> {
        workspace
            .unlinked_documents_page(limit, offset, false)
            .unwrap()
            .into_iter()
            .map(|d| d.heading)
            .collect()
    };
    assert_eq!(page(1, 0), ["Newer loose"]);
    assert_eq!(page(1, 1), ["Older loose"]);
}

#[test]
fn a_trashed_ticket_does_not_link_its_document() {
    let (_dir, mut workspace) = open_workspace();
    let ticket = workspace.create_ticket("Gone").unwrap();
    let doc = document(&mut workspace, "Orphan");
    workspace
        .set_ticket_document(&ticket.reference, &doc, true)
        .unwrap();
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();

    let work = workspace.current_work(false).unwrap();
    assert!(work.groups.is_empty());
    assert_eq!((work.finished, work.unlinked), (0, 1));
}

#[test]
fn a_pinned_document_keeps_its_group() {
    let (_dir, mut workspace) = open_workspace();
    let plan = workspace.create_plan("Checkout").unwrap();
    let doc = document(&mut workspace, "Pinned spec");
    workspace.set_plan_document(&plan.id, &doc, true).unwrap();
    workspace.set_document_pin(&doc, true).unwrap();

    let work = workspace.current_work(false).unwrap();
    assert_eq!(headings(group(&work, "Checkout")), ["Pinned spec"]);
}

#[test]
fn groups_are_ordered_by_their_most_recently_updated_document() {
    let (_dir, mut workspace) = open_workspace();
    let first = workspace.create_plan("First").unwrap();
    let second = workspace.create_plan("Second").unwrap();
    let old = document(&mut workspace, "Old");
    let new = document(&mut workspace, "New");
    workspace.set_plan_document(&first.id, &new, true).unwrap();
    workspace.set_plan_document(&second.id, &old, true).unwrap();

    let names = |work: &CurrentWork| -> Vec<String> {
        work.groups
            .iter()
            .map(|g| g.plan.as_ref().unwrap().name.clone())
            .collect()
    };
    assert_eq!(
        names(&workspace.current_work(false).unwrap()),
        ["First", "Second"]
    );
    tick();
    workspace
        .change_document(
            &old,
            ticketd_core::DocumentPatch {
                body: Some("edited".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        names(&workspace.current_work(false).unwrap()),
        ["Second", "First"]
    );
}

#[test]
fn update_details_and_trash_follow_the_browsing_rules() {
    let (_dir, mut workspace) = open_workspace();
    let ticket = workspace.create_ticket("Work").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Update", None, Some("Details"), None)
        .unwrap();
    let details = activity.supporting_document_id.unwrap();
    let trashed = document(&mut workspace, "Trashed");
    workspace.set_document_trashed(&trashed, true).unwrap();

    let hidden = workspace.current_work(false).unwrap();
    assert_eq!(
        (hidden.finished, hidden.unlinked, hidden.trashed),
        (0, 0, 1)
    );
    let shown = workspace.current_work(true).unwrap();
    assert_eq!(shown.finished + shown.unlinked, 1);
    assert!(
        workspace
            .unlinked_documents_page(50, 0, true)
            .unwrap()
            .iter()
            .chain(
                workspace
                    .finished_documents_page(50, 0, true)
                    .unwrap()
                    .iter()
            )
            .any(|d| d.id == details)
    );
}

#[test]
fn recent_can_be_sorted_by_title() {
    let (_dir, mut workspace) = open_workspace();
    document(&mut workspace, "banana");
    document(&mut workspace, "Cherry");
    document(&mut workspace, "Apple");
    let titles: Vec<_> = workspace
        .documents_by_title_page(50, 0, false)
        .unwrap()
        .into_iter()
        .map(|d| d.heading)
        .collect();
    assert_eq!(titles, ["Apple", "banana", "Cherry"]);
}
