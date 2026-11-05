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
    assert!(outgoing[0].passage.is_empty());
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

#[test]
fn context_documents_name_how_each_one_relates_to_the_ticket() {
    use ticketd_core::TicketPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    let attached = workspace.create_document(Some("Attached"), "").unwrap();
    let described = workspace.create_document(Some("Described"), "").unwrap();
    let updated = workspace.create_document(Some("Updated"), "").unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &attached.id, true)
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some(format!("See [d](ticketd://document/{})", described.id)),
                ..Default::default()
            },
        )
        .unwrap();
    let activity = workspace
        .add_activity(
            &ticket.reference,
            &format!(
                "Read [u](ticketd://document/{}) and [a](ticketd://document/{})",
                updated.id, attached.id
            ),
            None,
        )
        .unwrap();
    let context = workspace
        .ticket_context(
            &ticket.reference,
            ContextOptions {
                documents: true,
                ..Default::default()
            },
        )
        .unwrap();
    let items = context.documents.unwrap().items;
    let found: Vec<_> = items
        .iter()
        .map(|item| (item.id.as_str(), item.source.as_str()))
        .collect();
    assert_eq!(
        found,
        [
            (attached.id.as_str(), "explicit"),
            (described.id.as_str(), "description"),
            (updated.id.as_str(), "update"),
        ]
    );
    assert_eq!(items[2].activity_id.as_deref(), Some(activity.id.as_str()));
}

#[test]
fn linking_activity_details_to_a_ticket_keeps_them_as_a_document() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ship").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Brief", None, Some("Trace"), None)
        .unwrap();
    let id = activity.supporting_document_id.clone().unwrap();
    assert!(!workspace.show_document(&id).unwrap().kept);
    workspace
        .set_ticket_document(&ticket.reference, &id, true)
        .unwrap();
    assert!(workspace.show_document(&id).unwrap().kept);
}
