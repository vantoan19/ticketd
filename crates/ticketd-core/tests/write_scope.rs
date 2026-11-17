//! The write scope: what every Workspace write does to a ticket in Trash, and how many
//! events a write that creates a ticket logs. One table runs each public ticket write.

use serde_json::json;
use ticketd_core::{
    ActivityPatch, BatchOperation, Error, EvidenceInput, EvidenceKind, RelationshipKind, Status,
    TicketChange, TicketPatch, Workspace, WorkspaceEvent, WorkspaceEventType, WriteRequest,
    WriteResult,
};

/// A Workspace with a ticket in Trash and the things the writes need around it.
struct Fixture {
    _dir: tempfile::TempDir,
    workspace: Workspace,
    /// The ticket in Trash.
    trashed: String,
    /// A ticket that is not in Trash: blocks the trashed one, is its parent, and is
    /// related to it.
    visible: String,
    /// A ticket that is not in Trash and has no links.
    other: String,
    document: String,
    attachment: String,
    activity: String,
    evidence: String,
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let trashed = workspace.create_ticket("Trashed").unwrap().reference;
    let visible = workspace.create_ticket("Visible").unwrap().reference;
    let other = workspace.create_ticket("Other").unwrap().reference;
    workspace.add_dependency(&visible, &trashed, None).unwrap();
    workspace
        .set_parent(&trashed, Some(&visible), None)
        .unwrap();
    workspace
        .add_contextual_relationship(&visible, &trashed, RelationshipKind::Related, None)
        .unwrap();
    let activity = workspace
        .add_activity(&trashed, "Started", None)
        .unwrap()
        .id;
    let evidence = workspace
        .add_evidence(
            &trashed,
            EvidenceInput {
                kind: EvidenceKind::Branch,
                name: "work".into(),
                value: "main".into(),
                editing_agent: None,
            },
        )
        .unwrap()
        .id;
    let document = workspace.create_document(Some("Brief"), "Body").unwrap().id;
    let attachment = workspace
        .import_attachment_bytes("upload", "notes.log", b"safe", |_, _| true)
        .unwrap()
        .id;
    workspace.add_tag(&trashed, "kept").unwrap();
    workspace.set_trashed(&trashed, true, None).unwrap();
    Fixture {
        _dir: dir,
        workspace,
        trashed,
        visible,
        other,
        document,
        attachment,
        activity,
        evidence,
    }
}

type Write = fn(&mut Fixture) -> Result<(), Error>;

fn patch_title() -> TicketPatch {
    TicketPatch {
        title: Some("Renamed".into()),
        ..Default::default()
    }
}

/// Writes a person can make to a ticket in Trash, besides taking it out of Trash.
fn allowed_on_a_trashed_ticket() -> Vec<(&'static str, Write)> {
    vec![
        ("restore", |f| {
            f.workspace.set_trashed(&f.trashed, false, None).map(drop)
        }),
        ("detach a Document", |f| {
            f.workspace
                .set_ticket_document(&f.trashed, &f.document, false)
                .map(drop)
        }),
        ("detach from a visible blocker", |f| {
            f.workspace
                .remove_dependency(&f.visible, &f.trashed, None)
                .map(drop)
        }),
        ("detach a visible related ticket", |f| {
            f.workspace
                .remove_contextual_relationship(
                    &f.visible,
                    &f.trashed,
                    RelationshipKind::Related,
                    None,
                )
                .map(drop)
        }),
        ("remove the parent", |f| {
            f.workspace.set_parent(&f.trashed, None, None).map(drop)
        }),
        ("detach a child from a visible parent", |f| {
            f.workspace
                .detach_child(&f.visible, &f.trashed, None)
                .map(drop)
        }),
        ("follow", |f| f.workspace.set_following(&f.trashed, true)),
        ("remind", |f| {
            f.workspace
                .set_reminder(&f.trashed, Some("2030-01-01T00:00:00Z"))
        }),
    ]
}

/// Writes that change a ticket in Trash, or attach something to it: all refused.
fn refused_on_a_trashed_ticket() -> Vec<(&'static str, Write)> {
    vec![
        ("change_ticket", |f| {
            f.workspace
                .change_ticket(&f.trashed, patch_title())
                .map(drop)
        }),
        ("set_plan", |f| {
            f.workspace.set_plan(&f.trashed, None, None).map(drop)
        }),
        ("add_tag", |f| {
            f.workspace.add_tag(&f.trashed, "new").map(drop)
        }),
        ("remove_tag", |f| {
            f.workspace.remove_tag(&f.trashed, "kept").map(drop)
        }),
        ("add_activity", |f| {
            f.workspace.add_activity(&f.trashed, "More", None).map(drop)
        }),
        ("add_activity_with_details", |f| {
            f.workspace
                .add_activity_with_details(&f.trashed, "More", None, Some("Detail"), None)
                .map(drop)
        }),
        ("edit_activity", |f| {
            f.workspace
                .edit_activity(
                    &f.trashed,
                    &f.activity,
                    ActivityPatch {
                        brief: Some("Edited".into()),
                        editing_agent: None,
                    },
                )
                .map(drop)
        }),
        ("delete_activity", |f| {
            f.workspace.delete_activity(&f.trashed, &f.activity)
        }),
        ("add_evidence", |f| {
            f.workspace
                .add_evidence(&f.trashed, evidence_input())
                .map(drop)
        }),
        ("edit_evidence", |f| {
            f.workspace
                .edit_evidence(&f.trashed, &f.evidence, evidence_input())
                .map(drop)
        }),
        ("delete_evidence", |f| {
            f.workspace.delete_evidence(&f.trashed, &f.evidence)
        }),
        ("add_dependency, trashed blocker", |f| {
            f.workspace
                .add_dependency(&f.trashed, &f.other, None)
                .map(drop)
        }),
        ("add_dependency, trashed dependent", |f| {
            f.workspace
                .add_dependency(&f.other, &f.trashed, None)
                .map(drop)
        }),
        ("add_contextual_relationship", |f| {
            f.workspace
                .add_contextual_relationship(
                    &f.other,
                    &f.trashed,
                    RelationshipKind::Discovered,
                    None,
                )
                .map(drop)
        }),
        ("set_parent, trashed child", |f| {
            f.workspace
                .set_parent(&f.trashed, Some(&f.other), None)
                .map(drop)
        }),
        ("set_parent, trashed parent", |f| {
            f.workspace
                .set_parent(&f.other, Some(&f.trashed), None)
                .map(drop)
        }),
        ("mark_duplicate, trashed source", |f| {
            f.workspace
                .mark_duplicate(&f.trashed, &f.other, None)
                .map(drop)
        }),
        ("mark_duplicate, trashed canonical", |f| {
            f.workspace
                .mark_duplicate(&f.other, &f.trashed, None)
                .map(drop)
        }),
        ("remove_duplicate", |f| {
            f.workspace.remove_duplicate(&f.trashed, None).map(drop)
        }),
        ("take_ownership", |f| {
            f.workspace.take_ownership(&f.trashed, None).map(drop)
        }),
        ("attach a Document", |f| {
            f.workspace
                .set_ticket_document(&f.trashed, &f.document, true)
                .map(drop)
        }),
        ("attach a file", |f| {
            f.workspace
                .set_ticket_attachment(&f.trashed, &f.attachment, true)
                .map(drop)
        }),
        ("detach a file", |f| {
            f.workspace
                .set_ticket_attachment(&f.trashed, &f.attachment, false)
                .map(drop)
        }),
        ("a batch change", |f| {
            f.workspace
                .apply_batch(vec![BatchOperation::Change {
                    ticket: f.trashed.clone(),
                    change: Box::new(TicketChange {
                        patch: patch_title(),
                        ..Default::default()
                    }),
                }])
                .map(drop)
        }),
        ("a retryable ChangeTicket", |f| {
            f.workspace
                .write(
                    Some("change"),
                    WriteRequest::ChangeTicket {
                        reference: f.trashed.clone(),
                        patch: patch_title(),
                    },
                )
                .map(drop)
        }),
    ]
}

fn evidence_input() -> EvidenceInput {
    EvidenceInput {
        kind: EvidenceKind::Commit,
        name: "fix".into(),
        value: "abc".into(),
        editing_agent: None,
    }
}

#[test]
fn a_write_to_a_ticket_in_trash_is_refused_and_leaves_no_trace() {
    for (name, write) in refused_on_a_trashed_ticket() {
        let mut fixture = fixture();
        let token = fixture.workspace.change_token().unwrap();
        let head = fixture.workspace.workspace_event_head().unwrap();
        let history = fixture.workspace.ticket_history(&fixture.trashed).unwrap();

        let error = write(&mut fixture).expect_err(name);
        // A batch names the operation that failed; the cause is what it was refused for.
        let cause = match &error {
            Error::BatchOperation { source, .. } => &**source,
            other => other,
        };

        assert!(
            matches!(cause, Error::Trashed(_)),
            "{name}: expected the ticket to be refused as trashed, got {error:?}"
        );
        assert_eq!(fixture.workspace.change_token().unwrap(), token, "{name}");
        assert_eq!(
            fixture.workspace.workspace_event_head().unwrap(),
            head,
            "{name}"
        );
        assert_eq!(
            fixture.workspace.ticket_history(&fixture.trashed).unwrap(),
            history,
            "{name}"
        );
    }
}

#[test]
fn the_writes_a_trashed_ticket_still_allows_succeed() {
    for (name, write) in allowed_on_a_trashed_ticket() {
        let mut fixture = fixture();
        write(&mut fixture).unwrap_or_else(|error| panic!("{name}: {error:?}"));
    }
}

#[test]
fn a_ticket_in_trash_is_not_attached_a_document_but_keeps_the_ones_it_has() {
    let mut fixture = fixture();
    fixture
        .workspace
        .set_trashed(&fixture.trashed, false, None)
        .unwrap();
    fixture
        .workspace
        .set_ticket_document(&fixture.trashed, &fixture.document, true)
        .unwrap();
    fixture
        .workspace
        .set_trashed(&fixture.trashed, true, None)
        .unwrap();

    let other = fixture
        .workspace
        .create_document(Some("Second"), "More")
        .unwrap()
        .id;
    assert!(matches!(
        fixture
            .workspace
            .set_ticket_document(&fixture.trashed, &other, true),
        Err(Error::Trashed(_))
    ));
    fixture
        .workspace
        .set_ticket_document(&fixture.trashed, &fixture.document, false)
        .unwrap();
    assert!(
        fixture
            .workspace
            .context_links(&fixture.trashed, 100, 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_empty_title_or_tag_is_refused_at_once_even_while_another_connection_holds_the_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap().reference;
    let lock = rusqlite::Connection::open(&path).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();

    let started = std::time::Instant::now();
    assert!(matches!(
        workspace.create_ticket("  "),
        Err(Error::EmptyTitle)
    ));
    let blank_title = TicketPatch {
        title: Some(" ".into()),
        ..Default::default()
    };
    assert!(matches!(
        workspace.change_ticket(&ticket, blank_title),
        Err(Error::EmptyTitle)
    ));
    assert!(matches!(
        workspace.add_tag(&ticket, " "),
        Err(Error::EmptyTag)
    ));
    assert!(matches!(
        workspace.remove_tag(&ticket, " "),
        Err(Error::EmptyTag)
    ));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "validation waited for the write lock"
    );
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn created_events(workspace: &Workspace, after: i64) -> Vec<WorkspaceEvent> {
    workspace
        .workspace_events_after(after, 100)
        .unwrap()
        .into_iter()
        .filter(|event| {
            matches!(
                event.kind,
                WorkspaceEventType::TicketCreated
                    | WorkspaceEventType::TicketUpdated
                    | WorkspaceEventType::TicketStatusChanged
            )
        })
        .collect()
}

#[test]
fn every_write_that_creates_a_ticket_logs_one_created_event_with_the_final_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let project = workspace
        .create_project("Website", dir.path().to_str().unwrap())
        .unwrap()
        .id;
    let plan = workspace.create_plan("Launch").unwrap().id;
    let document = workspace.create_document(Some("Spec"), "Flow").unwrap().id;

    type Create = Box<dyn Fn(&mut Workspace) -> String>;
    let creates: Vec<(&str, Create)> = vec![
        (
            "create_ticket",
            Box::new(|w| w.create_ticket("Plain").unwrap().reference),
        ),
        (
            "create_ticket_in_context",
            Box::new({
                let (project, plan) = (project.clone(), plan.clone());
                move |w| {
                    w.create_ticket_in_context("In context", Some(&project), Some(&plan))
                        .unwrap()
                        .reference
                }
            }),
        ),
        (
            "create_ticket_from_document",
            Box::new({
                let document = document.clone();
                move |w| {
                    w.create_ticket_from_document(&document, "From a Document")
                        .unwrap()
                        .reference
                }
            }),
        ),
        (
            "create_ticket_from_document_following",
            Box::new({
                let document = document.clone();
                move |w| {
                    w.create_ticket_from_document_following(&document, "Followed", true)
                        .unwrap()
                        .reference
                }
            }),
        ),
        (
            "a batch that creates then fills in",
            Box::new({
                let project = project.clone();
                move |w| {
                    let tickets = w
                        .apply_batch(vec![
                            BatchOperation::Create {
                                name: "new".into(),
                                title: "Batched".into(),
                                project_id: Some(project.clone()),
                            },
                            BatchOperation::Change {
                                ticket: "$new".into(),
                                change: Box::new(TicketChange {
                                    patch: TicketPatch {
                                        body: Some("Details".into()),
                                        status: Some(Status::InProgress),
                                        ..Default::default()
                                    },
                                    ..Default::default()
                                }),
                            },
                        ])
                        .unwrap();
                    tickets.last().unwrap().reference.clone()
                }
            }),
        ),
        (
            "a retryable CreateTicketWithContent",
            Box::new(|w| {
                let request: WriteRequest = serde_json::from_value(json!({
                    "operation": "create_ticket_with_content",
                    "title": "With content", "body": "Text", "status": "Done",
                    "project_id": null, "plan_id": null, "tags": [], "follow": false,
                }))
                .unwrap();
                let WriteResult::Ticket(ticket) = w.write(Some("create"), request).unwrap() else {
                    panic!("expected a ticket")
                };
                ticket.reference
            }),
        ),
    ];

    for (name, create) in creates {
        let head = workspace.workspace_event_head().unwrap();
        let reference = create(&mut workspace);
        let ticket = workspace.show_ticket(&reference).unwrap();

        let events = created_events(&workspace, head);
        assert_eq!(events.len(), 1, "{name}: {events:?}");
        assert_eq!(events[0].kind, WorkspaceEventType::TicketCreated, "{name}");
        assert_eq!(events[0].ticket_id, ticket.id, "{name}");
        assert_eq!(
            events[0].current,
            Some(json!({
                "title": ticket.title, "body": ticket.body, "status": ticket.status,
                "project_id": ticket.project_id, "plan_id": ticket.plan_id,
            })),
            "{name}"
        );
    }
}
