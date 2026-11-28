use ticketd_core::{ContextOptions, TicketPatch, TicketPeekCounts, Workspace};

#[test]
fn peek_counts_include_all_linked_work_and_count_documents_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Review the delivery").unwrap();
    let reference = &ticket.reference;
    for index in 1..=21 {
        let child = workspace
            .create_ticket(&format!("Subticket {index}"))
            .unwrap();
        workspace
            .set_parent(&child.reference, Some(reference), None)
            .unwrap();
        if index == 21 {
            workspace
                .add_dependency(&child.reference, reference, None)
                .unwrap();
        }
    }
    let blocker = workspace.create_ticket("Blocker").unwrap();
    workspace
        .add_dependency(&blocker.reference, reference, None)
        .unwrap();

    let mention = workspace.create_ticket("Where the work started").unwrap();
    workspace
        .change_ticket(
            &mention.reference,
            TicketPatch {
                body: Some(format!("See {reference}.")),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    workspace
        .add_activity(
            &mention.reference,
            &format!("Again, see {reference}."),
            None,
        )
        .unwrap();
    workspace
        .create_document(Some("Incoming reference"), &format!("See {reference}."))
        .unwrap();

    let document = workspace.create_document(Some("Checklist"), "").unwrap();
    let document_link = workspace.context_link_markdown(&document.id).unwrap();
    workspace
        .set_ticket_document(reference, &document.id, true)
        .unwrap();
    workspace
        .change_ticket(
            reference,
            TicketPatch {
                body: Some(document_link.clone()),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    workspace
        .add_activity(reference, &document_link, None)
        .unwrap();
    let file = workspace
        .import_attachment_bytes("capture", "proof.txt", b"proof", |_, _| true)
        .unwrap();
    workspace
        .set_ticket_attachment(reference, &file.id, true)
        .unwrap();

    let context = workspace
        .ticket_context(
            reference,
            ContextOptions {
                relationships: true,
                ..ContextOptions::default()
            },
        )
        .unwrap();
    assert_eq!(
        context.relationships.unwrap().children.next_offset,
        Some(20)
    );
    assert_eq!(
        workspace.ticket_peek_counts(reference).unwrap(),
        TicketPeekCounts {
            linked: 24,
            files: 2
        }
    );
}
