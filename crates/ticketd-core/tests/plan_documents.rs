use ticketd_core::Workspace;

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
    let overview = workspace.plan_context(&plan.id, false).unwrap();
    assert!(overview["documents"][0]["body"].is_null());
    let context = workspace.plan_context(&plan.id, true).unwrap();
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
    workspace.set_plan_spec(&plan.id, Some(&earlier.id)).unwrap();
    workspace.keep_document(&earlier.id).unwrap();
    let ids: Vec<_> = workspace.recent_documents().unwrap().into_iter().map(|d| d.id).collect();
    assert_eq!(ids, vec![latest.id, earlier.id]);
    let ticket = workspace.create_ticket("Ticket").unwrap();
    let detail = workspace.add_activity_with_details(&ticket.reference, "Brief", None, Some("Body"), None).unwrap().supporting_document_id.unwrap();
    workspace.keep_document(&detail).unwrap();
    assert!(workspace.recent_documents().unwrap().iter().any(|d| d.id == detail));
}
