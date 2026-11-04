use ticketd_core::Workspace;

#[test]
fn graph_connects_plan_ticket_and_document_in_both_directions() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let ticket = workspace.create_ticket("Ticket").unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    let doc = workspace
        .create_document(Some("Spec"), &format!("See {}", ticket.reference))
        .unwrap();
    workspace.set_plan_spec(&plan.id, Some(&doc.id)).unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == plan.id));
    assert!(graph.nodes.iter().any(|node| node.id == doc.id));
    assert!(graph.edges.iter().any(|edge| edge.kind == "membership"));
    assert!(graph.edges.iter().any(|edge| edge.kind == "mention"));
    assert!(graph.edges.iter().any(|edge| edge.kind == "spec"));
    let graph = workspace.context_graph(&doc.id, false).unwrap();
    assert!(graph.edges.iter().any(|edge| edge.kind == "spec"));
}

#[test]
fn graph_finds_visible_references_to_tickets_created_later() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace
        .create_document(Some("Early"), "Read [T-1](https://example.com) for context")
        .unwrap();
    let ticket = workspace.create_ticket("Later").unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == doc.id));
    assert!(graph.edges.iter().any(|edge| {
        edge.kind == "mention"
            && edge
                .explanation
                .as_deref()
                .unwrap_or_default()
                .contains("T-1")
    }));
}

#[test]
fn activity_details_are_hidden_until_requested_and_direct_focus_stays_connected() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Ticket").unwrap();
    let activity = workspace
        .add_activity_with_details(
            &ticket.reference,
            "Investigation",
            None,
            Some("Details"),
            None,
        )
        .unwrap();
    let detail = activity.supporting_document_id.unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(graph.hidden_details);
    assert!(!graph.nodes.iter().any(|node| node.id == detail));
    let graph = workspace.context_graph(&ticket.reference, true).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == detail));
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.kind == "support"
                && edge.explanation.as_deref() == Some("Investigation"))
    );
    let graph = workspace.context_graph(&detail, false).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == ticket.id));
    workspace.keep_document(&detail).unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == detail));
}

#[test]
fn deliberate_expansion_reaches_a_second_hop() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let third = workspace.create_ticket("Third").unwrap();
    let second = workspace
        .create_document(Some("Second"), &third.reference)
        .unwrap();
    let first = workspace.create_plan("First").unwrap();
    workspace
        .set_plan_spec(&first.id, Some(&second.id))
        .unwrap();
    let graph = workspace
        .context_graph_expanded(&first.id, false, std::slice::from_ref(&second.id))
        .unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == third.id));
}

#[test]
fn graph_continues_a_bounded_membership_group() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Hub").unwrap();
    for n in 0..60 {
        let ticket = workspace.create_ticket(&format!("Member {n}")).unwrap();
        workspace
            .set_plan(&ticket.reference, Some(&plan.id), None)
            .unwrap();
    }
    let first = workspace.context_graph(&plan.id, false).unwrap();
    let continuation = first
        .continuations
        .iter()
        .find(|item| item.kind == "membership")
        .unwrap();
    assert_eq!(continuation.next_offset, Some(50));
    let page = ticketd_core::ContextGraphPage {
        anchor: continuation.anchor.clone(),
        group: continuation.group,
        offset: continuation.next_offset.unwrap(),
    };
    let more = workspace
        .context_graph_with_pages(&plan.id, false, &[], &[page])
        .unwrap();
    assert_eq!(more.nodes.len(), 61);
    assert!(
        !more
            .continuations
            .iter()
            .any(|item| item.kind == "membership")
    );
}

#[test]
fn activity_graph_mentions_follow_edits_and_deletion() {
    use ticketd_core::ActivityPatch;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Source").unwrap();
    let doc = workspace.create_document(Some("Target"), "").unwrap();
    let activity = workspace
        .add_activity(
            &ticket.reference,
            &format!("See [target](ticketd://document/{}) and T-2", doc.id),
            None,
        )
        .unwrap();
    let late = workspace.create_ticket("Late").unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == doc.id));
    assert!(graph.nodes.iter().any(|node| node.id == late.id));
    workspace
        .edit_activity(
            &ticket.reference,
            &activity.id,
            ActivityPatch {
                brief: Some("No references".into()),
                editing_agent: None,
            },
        )
        .unwrap();
    let graph = workspace.context_graph(&ticket.reference, false).unwrap();
    assert!(
        !graph
            .nodes
            .iter()
            .any(|node| node.id == doc.id || node.id == late.id)
    );
    workspace
        .delete_activity(&ticket.reference, &activity.id)
        .unwrap();
}
