use ticketd_core::{ContextOptions, Workspace};

#[test]
fn an_explicit_reference_leaves_the_description_alone_and_shows_in_every_context_view() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    let document = workspace.create_document(Some("Brief"), "Body").unwrap();

    let linked = workspace
        .set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();
    assert_eq!(linked.body, ticket.body);
    // Adding again is not an error and does not duplicate.
    workspace
        .set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();

    let outgoing = workspace.context_links(&ticket.reference, 100, 0).unwrap();
    assert_eq!(outgoing.len(), 1);
    assert!(outgoing[0].explicit);
    assert_eq!(outgoing[0].target_id, document.id);
    let incoming = workspace.context_backlinks(&document.id, 100, 0).unwrap();
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].source_label, ticket.reference);
    assert_eq!(
        workspace.document_backlinks(&document.id, 100, 0).unwrap()[0].source_reference,
        ticket.reference
    );
    let graph = workspace.context_graph(&ticket.reference, true).unwrap();
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.source == linked.id && edge.target == document.id)
    );
    let context = workspace
        .ticket_context(
            &ticket.reference,
            ContextOptions {
                documents: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(context.documents.unwrap().items[0].id, document.id);
    assert_eq!(
        workspace.export().unwrap()["ticket_documents"][0]["document_id"],
        document.id
    );

    let token = workspace.change_token().unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &document.id, false)
        .unwrap();
    assert_ne!(workspace.change_token().unwrap(), token);
    assert!(
        workspace
            .context_links(&ticket.reference, 100, 0)
            .unwrap()
            .is_empty()
    );
    // Removing what is not attached is not an error.
    workspace
        .set_ticket_document(&ticket.reference, &document.id, false)
        .unwrap();
}

#[test]
fn a_description_mention_is_not_explicit_and_a_trashed_document_cannot_be_attached() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    let document = workspace.create_document(Some("Brief"), "Body").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            ticketd_core::TicketPatch {
                body: Some(format!("See [Brief](ticketd://document/{})", document.id)),
                ..Default::default()
            },
        )
        .unwrap();
    let links = workspace.context_links(&ticket.reference, 100, 0).unwrap();
    assert_eq!(links.len(), 1);
    assert!(!links[0].explicit);
    // Unlinking a mention-only Document changes nothing.
    workspace
        .set_ticket_document(&ticket.reference, &document.id, false)
        .unwrap();
    assert_eq!(
        workspace
            .context_links(&ticket.reference, 100, 0)
            .unwrap()
            .len(),
        1
    );
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert!(
        workspace
            .set_ticket_document(&ticket.reference, &document.id, true)
            .is_err()
    );
}
