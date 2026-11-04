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
fn graph_identifies_limited_relationship_groups() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Large plan").unwrap();
    for index in 0..52 {
        let ticket = workspace.create_ticket(&format!("Ticket {index}")).unwrap();
        workspace
            .set_plan(&ticket.reference, Some(&plan.id), None)
            .unwrap();
    }
    let graph = workspace.context_graph(&plan.id, false).unwrap();
    assert!(graph.omitted);
    assert!(
        graph
            .omitted_groups
            .iter()
            .any(|group| group == "membership")
    );
}
