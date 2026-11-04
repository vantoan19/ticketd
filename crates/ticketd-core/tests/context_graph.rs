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

#[test]
fn workspace_graph_search_filters_and_continues() {
    use ticketd_core::WorkspaceGraphRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Searchable needle").unwrap();
    workspace
        .create_document(Some("Other"), "needle in body")
        .unwrap();
    let graph = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            search: Some("needle".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == ticket.id));
    assert_eq!(graph.nodes.len(), 2);
}

#[test]
fn workspace_pages_filter_tags_and_keep_details_hidden_until_requested() {
    use ticketd_core::WorkspaceGraphRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Owner").unwrap();
    let detail = workspace
        .add_activity_with_details(&ticket.reference, "Update", None, Some("Details"), None)
        .unwrap()
        .supporting_document_id
        .unwrap();
    let doc = workspace.create_document(Some("Tagged"), "").unwrap();
    workspace.set_document_tag(&doc.id, "theme", true).unwrap();
    let tagged = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            tag: Some("theme".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(tagged.nodes.len(), 1);
    assert_eq!(tagged.nodes[0].id, doc.id);
    let graph = workspace
        .workspace_graph(&WorkspaceGraphRequest::default())
        .unwrap();
    assert!(!graph.nodes.iter().any(|node| node.id == detail));
    let graph = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            include_details: true,
            ..Default::default()
        })
        .unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == detail));
    for index in 0..55 {
        workspace
            .create_document(Some(&format!("Page {index}")), "")
            .unwrap();
    }
    let first = workspace
        .workspace_graph(&WorkspaceGraphRequest::default())
        .unwrap();
    assert!(first.omitted);
    let second = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            cursor: first.next_cursor.clone(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        first
            .nodes
            .iter()
            .all(|node| second.nodes.iter().all(|other| other.id != node.id))
    );
}

#[test]
fn graph_uses_updated_untitled_document_heading() {
    use ticketd_core::{DocumentPatch, WorkspaceGraphRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace
        .create_document(None, "\n  First heading\nBody")
        .unwrap();
    workspace
        .change_document(
            &doc.id,
            DocumentPatch {
                body: Some("\n Second heading\nMore".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let graph = workspace
        .workspace_graph(&WorkspaceGraphRequest::default())
        .unwrap();
    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.id == doc.id)
            .unwrap()
            .label,
        "Second heading"
    );
}

#[test]
fn workspace_expands_omitted_relationships_under_a_fixed_budget() {
    use ticketd_core::WorkspaceGraphRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let mut tickets = Vec::new();
    for i in 0..20 {
        tickets.push(workspace.create_ticket(&format!("Ticket {i}")).unwrap());
    }
    for i in 0..tickets.len() {
        for j in i + 1..tickets.len() {
            workspace
                .add_dependency(&tickets[i].reference, &tickets[j].reference, None)
                .unwrap();
        }
    }
    let initial = workspace
        .workspace_graph(&WorkspaceGraphRequest::default())
        .unwrap();
    assert!(initial.omitted_groups.iter().any(|kind| kind == "blocks"));
    let expanded = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            adjacency_limit: 12,
            ..Default::default()
        })
        .unwrap();
    assert!(expanded.edges.len() > initial.edges.len());
    assert!(expanded.omitted);
}

#[test]
fn workspace_includes_connections_between_loaded_candidate_pages() {
    use ticketd_core::WorkspaceGraphRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    for index in 0..60 {
        workspace.create_ticket(&format!("Ticket {index}")).unwrap();
    }
    let first = workspace
        .workspace_graph(&WorkspaceGraphRequest::default())
        .unwrap();
    let second = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            cursor: first.next_cursor.clone(),
            ..Default::default()
        })
        .unwrap();
    let reference = |label: &str| label.split(' ').next().unwrap().to_owned();
    let a = reference(&first.nodes[0].label);
    let b = reference(&second.nodes[0].label);
    workspace.add_dependency(&a, &b, None).unwrap();
    let combined = workspace
        .workspace_graph(&WorkspaceGraphRequest {
            cursor: first.next_cursor,
            visible_ids: first.nodes.iter().map(|node| node.id.clone()).collect(),
            ..Default::default()
        })
        .unwrap();
    assert!(combined.edges.iter().any(|edge| edge.kind == "blocks"
        && edge.source == first.nodes[0].id
        && edge.target == second.nodes[0].id));
}

#[test]
fn workspace_search_index_tracks_ticket_and_plan_edits() {
    use ticketd_core::{TicketPatch, WorkspaceGraphRequest};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Before").unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("newly indexed phrase".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_plan_purpose(&plan.id, "newly indexed phrase")
        .unwrap();
    let request = WorkspaceGraphRequest {
        search: Some("newly indexed phrase".into()),
        ..Default::default()
    };
    let graph = workspace.workspace_graph(&request).unwrap();
    assert!(graph.nodes.iter().any(|node| node.id == ticket.id));
    assert!(graph.nodes.iter().any(|node| node.id == plan.id));
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                body: Some("replaced".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let graph = workspace.workspace_graph(&request).unwrap();
    assert!(!graph.nodes.iter().any(|node| node.id == ticket.id));
}
