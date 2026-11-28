use ticketd_core::{MetadataSelection, Workspace};

#[test]
fn shared_documents_and_spec_survive_reopen_without_changing_ticket_membership() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace.create_plan("First").unwrap();
    let second = workspace.create_plan("Second").unwrap();
    let doc = workspace
        .create_document(Some("Spec"), "# Context")
        .unwrap();
    workspace
        .set_plan_document(&first.id, &doc.id, true)
        .unwrap();
    workspace.set_plan_spec(&first.id, Some(&doc.id)).unwrap();
    workspace
        .set_plan_document(&second.id, &doc.id, true)
        .unwrap();
    let replacement = workspace
        .create_document(Some("Replacement"), "New spec")
        .unwrap();
    workspace
        .set_plan_spec(&first.id, Some(&replacement.id))
        .unwrap();
    assert_eq!(
        workspace
            .show_plan(&first.id)
            .unwrap()
            .plan
            .spec_document_id
            .as_deref(),
        Some(replacement.id.as_str())
    );
    workspace.set_plan_spec(&first.id, Some(&doc.id)).unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    let view = workspace.show_plan(&first.id).unwrap();
    assert_eq!(view.plan.spec_document_id.as_deref(), Some(doc.id.as_str()));
    assert!(view.documents.iter().any(|item| item.id == doc.id));
    assert!(view.documents.iter().any(|item| item.id == replacement.id));
    assert!(view.members.is_empty());
    assert_eq!(workspace.show_plan(&second.id).unwrap().documents.len(), 1);
}

#[test]
fn designating_activity_details_promotes_and_preserves_support_and_replay() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let ticket = workspace.create_ticket("Ticket").unwrap();
    let activity = workspace
        .add_activity_with_details(&ticket.reference, "Update", None, Some("Details"), None)
        .unwrap();
    let id = activity.supporting_document_id.unwrap();
    assert!(
        !workspace
            .recent_documents()
            .unwrap()
            .iter()
            .any(|d| d.id == id)
    );
    let request = || WriteRequest::SetPlanSpec {
        plan_id: plan.id.clone(),
        document_id: Some(id.clone()),
    };
    let result = workspace.write(Some("spec-request"), request()).unwrap();
    workspace.set_plan_spec(&plan.id, None).unwrap();
    assert_eq!(
        workspace.write(Some("spec-request"), request()).unwrap(),
        result
    );
    assert!(matches!(result, WriteResult::Plan(_)));
    assert!(
        workspace
            .recent_documents()
            .unwrap()
            .iter()
            .any(|d| d.id == id)
    );
    assert_eq!(
        workspace.show_plan(&plan.id).unwrap().documents[0].heading,
        "Update"
    );
    let document = workspace.show_document(&id).unwrap();
    assert_eq!(document.origin_brief.as_deref(), Some("Update"));
    assert_eq!(
        document.origin_ticket.as_deref(),
        Some(ticket.reference.as_str())
    );
    assert!(document.kept);
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().plan_id,
        None
    );
    let export = workspace.export().unwrap();
    assert_eq!(export["plan_documents"][0]["document_id"], id);
}

#[test]
fn plan_context_bounds_explicit_document_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let doc = workspace
        .create_document(Some("Long"), &"x".repeat(5000))
        .unwrap();
    workspace
        .set_plan_document(&plan.id, &doc.id, true)
        .unwrap();
    let overview = serde_json::to_value(workspace.plan_context(&plan.id, false).unwrap()).unwrap();
    assert!(overview["documents"][0]["body"].is_null());
    let context = serde_json::to_value(workspace.plan_context(&plan.id, true).unwrap()).unwrap();
    assert_eq!(
        context["documents"][0]["body"].as_str().unwrap().len(),
        4096
    );
    assert_eq!(context["documents"][0]["body_truncated"], true);
    assert!(
        context["documents"][0]["fetch"]
            .as_str()
            .unwrap()
            .contains(&doc.id)
    );
}

#[test]
fn plan_spec_and_keep_do_not_record_a_browsing_visit() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let earlier = workspace.create_document(Some("Earlier"), "").unwrap();
    let latest = workspace.create_document(Some("Latest"), "").unwrap();
    workspace
        .set_plan_spec(&plan.id, Some(&earlier.id))
        .unwrap();
    workspace.keep_document(&earlier.id).unwrap();
    let ids: Vec<_> = workspace
        .recent_documents()
        .unwrap()
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(ids, vec![latest.id, earlier.id]);
    let ticket = workspace.create_ticket("Ticket").unwrap();
    let detail = workspace
        .add_activity_with_details(&ticket.reference, "Brief", None, Some("Body"), None)
        .unwrap()
        .supporting_document_id
        .unwrap();
    workspace.keep_document(&detail).unwrap();
    assert!(
        workspace
            .recent_documents()
            .unwrap()
            .iter()
            .any(|d| d.id == detail)
    );
}

#[test]
fn document_plans_tell_spec_from_supporting_documents() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Checkout revamp").unwrap();
    let doc = workspace.create_document(Some("Spec"), "body").unwrap();
    assert!(workspace.document_plans(&doc.id).unwrap().is_empty());
    workspace
        .set_plan_document(&plan.id, &doc.id, true)
        .unwrap();
    let plans = workspace.document_plans(&doc.id).unwrap();
    assert_eq!(
        (plans[0].0.name.as_str(), plans[0].1),
        ("Checkout revamp", false)
    );
    workspace.set_plan_spec(&plan.id, Some(&doc.id)).unwrap();
    assert!(workspace.document_plans(&doc.id).unwrap()[0].1);
}

#[test]
fn bounded_plan_reads_keep_full_counts_and_legacy_views_while_paging_members_and_documents() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let first = workspace.create_plan("First").unwrap();
    workspace.create_plan("Second").unwrap();
    workspace.create_plan("Third").unwrap();
    for number in 1..=3 {
        let ticket = workspace
            .create_ticket(&format!("Member {number}"))
            .unwrap();
        workspace
            .change_ticket(
                &ticket.reference,
                ticketd_core::TicketPatch {
                    plan_id: Some(Some(first.id.clone())),
                    ..Default::default()
                },
            )
            .unwrap();
        let document = workspace
            .create_document(
                Some(&format!("Document {number}")),
                "large body is not read for the list",
            )
            .unwrap();
        workspace
            .set_plan_document(&first.id, &document.id, true)
            .unwrap();
    }
    let complete = workspace.show_plan(&first.id).unwrap();
    let first_page = workspace
        .show_plan_bounded(&first.id, Some(2), 0, true)
        .unwrap();
    let second_page = workspace
        .show_plan_bounded(&first.id, Some(2), 2, true)
        .unwrap();
    assert_eq!(first_page.members.len(), 2);
    assert_eq!(second_page.members.len(), 1);
    assert_eq!(first_page.counts.todo, 3);
    assert_eq!(second_page.counts.todo, 3);
    assert_eq!(first_page.documents.len(), 2);
    assert_eq!(second_page.documents.len(), 1);
    assert_eq!(
        second_page.members[0].reference,
        complete.members[2].reference
    );
    assert_eq!(second_page.documents[0].id, complete.documents[2].id);
    assert!(
        workspace
            .show_plan_bounded(&first.id, Some(0), 0, true)
            .unwrap()
            .members
            .is_empty()
    );
    let plans = workspace.list_plans_bounded(true, Some(2), 0).unwrap();
    let rest = workspace.list_plans_bounded(true, Some(2), 2).unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(rest.len(), 1);
    assert_eq!(workspace.list_plans(true).unwrap().len(), 3);
}

#[test]
fn metadata_projection_omits_bodies_and_bounds_prerequisites_without_changing_legacy_tickets() {
    use ticketd_core::TicketFilter;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Projected").unwrap();
    let ticket = workspace.create_ticket("Projected member").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            ticketd_core::TicketPatch {
                body: Some("Canonical body must never be copied into graph metadata".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_plan(&ticket.reference, Some(&plan.id), None)
        .unwrap();
    for number in 0..51 {
        let blocker = workspace
            .create_ticket(&format!("Blocker {number}"))
            .unwrap();
        workspace
            .add_dependency(&blocker.reference, &ticket.reference, None)
            .unwrap();
    }
    let filter = TicketFilter {
        plan: Some(plan.id.clone()),
        limit: 1,
        ..Default::default()
    };
    let projection = workspace
        .find_ticket_metadata(
            &filter,
            Some(MetadataSelection::Ids(std::slice::from_ref(&ticket.id))),
            false,
        )
        .unwrap();
    assert_eq!(projection.items.len(), 1);
    assert_eq!(projection.items[0].reference, ticket.reference);
    assert_eq!(projection.items[0].availability.as_deref(), Some("Blocked"));
    let encoded = serde_json::to_value(&projection.items[0]).unwrap();
    assert!(encoded.get("body").is_none());
    assert!(encoded.get("prerequisites").is_none());
    assert!(!projection.omitted);
    let flow = workspace.find_ticket_metadata(&filter, None, true).unwrap();
    assert!(flow.omitted);
    assert_eq!(flow.items[0].prerequisites.as_ref().unwrap().len(), 50);
    let legacy = workspace.find_tickets(&filter).unwrap();
    assert_eq!(
        legacy[0].body,
        "Canonical body must never be copied into graph metadata"
    );
    assert_eq!(legacy[0].prerequisites.len(), 51);
    assert_eq!(legacy[0].availability, projection.items[0].availability);
    let summary = workspace
        .show_plan_bounded(&plan.id, Some(2), 0, false)
        .unwrap();
    assert!(summary.members.is_empty());
    assert_eq!(summary.counts.todo, 1);
    assert_eq!(workspace.show_plan(&plan.id).unwrap().members.len(), 1);
    assert!(
        workspace
            .find_ticket_metadata(
                &filter,
                Some(MetadataSelection::Ids(&vec![ticket.id; 251])),
                false
            )
            .is_err()
    );
}

#[test]
fn metadata_names_tickets_by_reference_as_a_bulk_selection_does() {
    use ticketd_core::{Status, TicketFilter, TicketPatch};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    let todo = workspace.create_ticket("Still to do").unwrap();
    let done = workspace.create_ticket("Finished").unwrap();
    workspace.create_ticket("Not selected").unwrap();
    workspace
        .change_ticket(
            &done.reference,
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_plan(&done.reference, Some(&plan.id), None)
        .unwrap();
    // A reference that names no ticket is left out, not an error.
    let selected = [
        done.reference.clone(),
        todo.reference.clone(),
        "T-ZZ999".to_owned(),
    ];
    let filter = TicketFilter {
        limit: 100,
        ..Default::default()
    };
    let mut found: Vec<_> = workspace
        .find_ticket_metadata(
            &filter,
            Some(MetadataSelection::References(&selected)),
            false,
        )
        .unwrap()
        .items
        .into_iter()
        .map(|ticket| (ticket.reference, ticket.status, ticket.plan_id))
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        found,
        [
            (todo.reference, Status::Todo, None),
            (done.reference, Status::Done, Some(plan.id)),
        ]
    );
}

#[test]
fn plan_context_marks_a_trashed_document_and_leaves_out_its_body() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let doc = workspace
        .create_document(Some("Old"), "secret text")
        .unwrap();
    workspace
        .set_plan_document(&plan.id, &doc.id, true)
        .unwrap();
    workspace.set_document_trashed(&doc.id, true).unwrap();
    let context = serde_json::to_value(workspace.plan_context(&plan.id, true).unwrap()).unwrap();
    assert_eq!(context["documents"][0]["trashed"], true);
    assert!(context["documents"][0]["body"].is_null());
    assert_eq!(context["documents"][0]["body_truncated"], false);
}

#[test]
fn plan_names_are_bounded_and_archive_is_as_idempotent_as_reactivate() {
    use ticketd_core::Error;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert!(matches!(
        workspace.create_plan(&"n".repeat(1001)),
        Err(Error::PlanNameTooLong(1000))
    ));
    let plan = workspace
        .create_plan(&format!("  {}  ", "n".repeat(1000)))
        .unwrap();
    assert_eq!(plan.name.chars().count(), 1000);
    assert!(matches!(
        workspace.change_plan(&plan.id, Some(&"n".repeat(1001)), None),
        Err(Error::PlanNameTooLong(1000))
    ));
    workspace.change_plan(&plan.id, None, Some(true)).unwrap();
    let again = workspace.change_plan(&plan.id, None, Some(true)).unwrap();
    assert!(again.archived);
    // Renaming an archived Plan is still a change it refuses.
    assert!(matches!(
        workspace.change_plan(&plan.id, Some("New"), Some(true)),
        Err(Error::PlanArchived)
    ));
    workspace.change_plan(&plan.id, None, Some(false)).unwrap();
    assert!(
        !workspace
            .change_plan(&plan.id, None, Some(false))
            .unwrap()
            .archived
    );
}

#[test]
fn plan_overview_reads_newest_documents_first_and_preserves_legacy_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let plan = workspace.create_plan("Plan").unwrap();
    let mut documents = Vec::new();
    for title in ["Design", "Verification", "Spec"] {
        let document = workspace.create_document(Some(title), "").unwrap();
        workspace
            .set_plan_document(&plan.id, &document.id, true)
            .unwrap();
        documents.push(document);
    }
    documents.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    let overview = workspace.show_plan_overview(&plan.id).unwrap();
    assert_eq!(
        overview
            .documents
            .iter()
            .map(|doc| &doc.id)
            .collect::<Vec<_>>(),
        documents.iter().map(|doc| &doc.id).collect::<Vec<_>>()
    );
    let legacy = workspace.show_plan(&plan.id).unwrap();
    assert!(
        legacy
            .documents
            .windows(2)
            .all(|pair| pair[0].id < pair[1].id)
    );
}
