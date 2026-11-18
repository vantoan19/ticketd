//! The read models answer what the full reads they replace answered, on one seeded
//! Workspace that has every relationship a list row shows.
use ticketd_core::{
    AttentionEntry, Chat, ChatLink, ChatLinkKind, ChatListFilter, ChatSuggestion, ChatSummary,
    FolderChat, InboxAttention, InboxEntry, NewChat, PrerequisiteCounts, ReminderState,
    ReviewState, Status, Ticket, TicketFilter, TicketOrder, TicketPatch, TicketRow,
    TicketWithUpdate, Workspace,
};

/// Ticket `n` of the seeded Workspace, as listed.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn numbered(tickets: &[Ticket], n: usize) -> Ticket {
    tickets
        .iter()
        .find(|ticket| ticket.title.starts_with(&format!("Ticket {n} ")))
        .unwrap()
        .clone()
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn agent_status(workspace: &mut Workspace, reference: &str, status: Status, agent: Option<&str>) {
    workspace
        .change_ticket(
            reference,
            TicketPatch {
                status: Some(status),
                editing_agent: agent.map(str::to_owned),
                ..Default::default()
            },
        )
        .unwrap();
}

/// What the desktop's Inbox worked out with a read per entry: every page of entries, each
/// reviewed ticket shown and its history read, and each reminder read.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn attention_the_old_way(workspace: &Workspace) -> InboxAttention {
    let mut entries = Vec::new();
    for offset in (0..).step_by(100) {
        let page = workspace.inbox_page(100, offset, false).unwrap();
        let done = page.len() < 100;
        entries.extend(page);
        if done {
            break;
        }
    }
    let agent_review = |entry: &InboxEntry| {
        entry.kind == "status"
            && entry.to_value == "In review"
            && entry
                .editing_agent
                .as_deref()
                .is_some_and(|agent| agent != "local-person")
    };
    let mut reviewed: Vec<String> = entries
        .iter()
        .filter(|entry| agent_review(entry))
        .map(|entry| entry.reference.clone())
        .collect();
    reviewed.sort();
    reviewed.dedup();
    let reviews: Vec<ReviewState> = reviewed
        .into_iter()
        .map(|reference| ReviewState {
            status: workspace.show_ticket(&reference).unwrap().status,
            latest_status_change: workspace
                .ticket_history(&reference)
                .unwrap()
                .into_iter()
                .rfind(|entry| entry.kind == "status"),
            reference,
        })
        .collect();
    let mut reminded: Vec<String> = entries
        .iter()
        .filter(|entry| entry.kind == "reminder")
        .map(|entry| entry.reference.clone())
        .collect();
    reminded.sort();
    reminded.dedup();
    let reminders: Vec<ReminderState> = reminded
        .into_iter()
        .filter_map(|reference| {
            workspace
                .reminder(&reference)
                .unwrap()
                .map(|due_at| ReminderState { reference, due_at })
        })
        .collect();
    let entries = entries
        .into_iter()
        .map(|entry| {
            let needs_you = if agent_review(&entry) {
                reviews.iter().any(|review| {
                    review.reference == entry.reference
                        && review.status == Status::InReview
                        && review.latest_status_change.as_ref().is_some_and(|latest| {
                            latest.to_value == "In review"
                                && latest.editing_agent == entry.editing_agent
                                && entry.timestamp >= latest.timestamp
                        })
                })
            } else if entry.kind == "reminder" {
                reminders.iter().any(|reminder| {
                    reminder.reference == entry.reference && reminder.due_at == entry.to_value
                })
            } else {
                false
            };
            AttentionEntry { entry, needs_you }
        })
        .collect();
    InboxAttention {
        entries,
        reviews,
        reminders,
    }
}

#[test]
fn inbox_attention_decides_what_needs_the_person_as_the_inbox_did() {
    let Seeded { mut workspace, .. } = seeded();
    let listed = workspace.list_tickets().unwrap();
    let reference = |n| numbered(&listed, n).reference;
    for n in [1, 3, 5, 6, 7] {
        workspace.set_following(&reference(n), true).unwrap();
    }
    // Still in review from the agent: needs the person.
    agent_status(
        &mut workspace,
        &reference(1),
        Status::InReview,
        Some("agent"),
    );
    // Moved on by the person since: no longer.
    agent_status(
        &mut workspace,
        &reference(3),
        Status::InReview,
        Some("agent"),
    );
    agent_status(&mut workspace, &reference(3), Status::Done, None);
    // Reviewed twice: only the latest review needs the person.
    agent_status(
        &mut workspace,
        &reference(5),
        Status::InReview,
        Some("agent"),
    );
    agent_status(
        &mut workspace,
        &reference(5),
        Status::InProgress,
        Some("agent"),
    );
    agent_status(
        &mut workspace,
        &reference(5),
        Status::InReview,
        Some("agent"),
    );
    workspace
        .add_activity(&reference(1), "Agent note", Some("agent"))
        .unwrap();
    // A due reminder needs the person; one set again after it came due does not.
    for n in [6, 7] {
        workspace
            .set_reminder(&reference(n), Some("2020-01-01T00:00:00Z"))
            .unwrap();
    }
    workspace.deliver_due_reminders().unwrap();
    workspace
        .set_reminder(&reference(7), Some("2099-01-01T00:00:00Z"))
        .unwrap();

    let attention = workspace.inbox_attention().unwrap();
    let mut old = attention_the_old_way(&workspace);
    let mut new = attention.clone();
    for state in [&mut old, &mut new] {
        state.reviews.sort_by(|a, b| a.reference.cmp(&b.reference));
        state
            .reminders
            .sort_by(|a, b| a.reference.cmp(&b.reference));
    }
    assert_eq!(new, old);
    let needing: Vec<(String, String)> = attention
        .entries
        .iter()
        .filter(|entry| entry.needs_you)
        .map(|entry| (entry.entry.reference.clone(), entry.entry.kind.clone()))
        .collect();
    assert_eq!(
        needing,
        [
            (reference(6), "reminder".to_owned()),
            (reference(5), "status".to_owned()),
            (reference(1), "status".to_owned()),
        ]
    );
}

#[test]
fn chat_summaries_are_the_listed_chats_with_the_chats_in_their_folder() {
    let Seeded { mut workspace, .. } = seeded();
    let listed = workspace.list_tickets().unwrap();
    let mut chat = |title: &str, folder: &str, ticket: Option<usize>| {
        workspace
            .create_chat(
                None,
                NewChat {
                    title: Some(title.into()),
                    harness: "claude".into(),
                    execution_folder: folder.into(),
                    folder_managed: false,
                    links: ticket
                        .map(|n| ChatLink {
                            kind: ChatLinkKind::Ticket,
                            id: numbered(&listed, n).id,
                        })
                        .into_iter()
                        .collect(),
                },
            )
            .unwrap()
    };
    let first = chat("First", "/work/app", Some(1));
    let second = chat("Second", "/work/app", Some(3));
    let archived = chat("Archived", "/work/app", None);
    let trashed = chat("Trashed", "/work/app", None);
    chat("Elsewhere", "/work/site", Some(1));
    workspace.set_chat_archived(&archived.id, true).unwrap();
    workspace.set_chat_trashed(&trashed.id, true).unwrap();
    workspace.mark_chat_changed(&first.id).unwrap();
    workspace
        .set_chat_title(&second.id, Some("Second, renamed"))
        .unwrap();

    let outside_trash: Vec<Chat> = [ChatListFilter::Active, ChatListFilter::Archived]
        .into_iter()
        .flat_map(|filter| workspace.list_chats(filter).unwrap())
        .collect();
    for filter in [
        ChatListFilter::Active,
        ChatListFilter::Archived,
        ChatListFilter::Trashed,
    ] {
        let expected: Vec<ChatSummary> = workspace
            .list_chats(filter)
            .unwrap()
            .into_iter()
            .map(|chat| ChatSummary {
                folder_chats: outside_trash
                    .iter()
                    .filter(|other| {
                        other.id != chat.id && other.execution_folder == chat.execution_folder
                    })
                    .map(|other| FolderChat {
                        id: other.id.clone(),
                        title: other.title.clone(),
                        archived: other.archived,
                        trashed: other.trashed,
                    })
                    .collect(),
                chat,
            })
            .collect();
        assert_eq!(
            workspace.chat_summaries(filter).unwrap(),
            expected,
            "{filter:?}"
        );
    }
    let active = workspace.chat_summaries(ChatListFilter::Active).unwrap();
    assert_eq!(active.len(), 3);
    assert_eq!(active[0].chat.id, second.id);
    assert_eq!(
        active[0]
            .folder_chats
            .iter()
            .map(|chat| chat.id.as_str())
            .collect::<Vec<_>>(),
        [first.id.as_str(), archived.id.as_str()]
    );
}

#[test]
fn active_tickets_are_the_tickets_changed_last() {
    let Seeded { workspace, .. } = seeded();
    let mut expected = workspace.list_tickets().unwrap();
    expected.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    for limit in [1, 4, 50] {
        let found: Vec<_> = workspace
            .active_tickets(limit)
            .unwrap()
            .into_iter()
            .map(|ticket| {
                (
                    ticket.reference,
                    ticket.title,
                    ticket.status,
                    ticket.updated_at,
                )
            })
            .collect();
        let wanted: Vec<_> = expected
            .iter()
            .take(limit)
            .map(|ticket| {
                (
                    ticket.reference.clone(),
                    ticket.title.clone(),
                    ticket.status,
                    ticket.updated_at.clone(),
                )
            })
            .collect();
        assert_eq!(found, wanted, "limit {limit}");
    }
}

#[test]
fn chat_suggestions_continue_review_and_triage_from_the_tickets_under_way() {
    let Seeded { mut workspace, .. } = seeded();
    let listed = workspace.list_tickets().unwrap();
    let reference = |n| numbered(&listed, n).reference;
    workspace.set_following(&reference(3), true).unwrap();
    workspace
        .add_activity(&reference(3), "Parser done", Some("agent"))
        .unwrap();
    let skip = std::collections::HashSet::from([numbered(&listed, 10).id]);
    let suggested: Vec<String> = workspace
        .chat_suggestions(None, skip)
        .unwrap()
        .into_iter()
        .map(|suggestion| match suggestion {
            ChatSuggestion::Continue { ticket, .. } => format!("continue {}", ticket.reference),
            ChatSuggestion::Review { ticket, .. } => format!("review {}", ticket.reference),
            ChatSuggestion::Triage { count, links, .. } => {
                let links: Vec<_> = links.into_iter().map(|ticket| ticket.reference).collect();
                format!("triage {count} {}", links.join(","))
            }
        })
        .collect();
    assert_eq!(
        suggested,
        [
            format!("continue {}", reference(3)),
            format!("review {}", reference(4)),
            format!("triage 1 {}", reference(3)),
        ]
    );
}

struct Seeded {
    workspace: Workspace,
    _dir: tempfile::TempDir,
}

#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn status(workspace: &mut Workspace, ticket: &Ticket, status: Status) {
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(status),
                ..Default::default()
            },
        )
        .unwrap();
}

/// Twelve tickets: tags, a blocker that is Done and one that is not, a parent with two
/// children, a duplicate, Activities, a ticket in a Project, one in Trash, and every
/// status that the list and board group by.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn seeded() -> Seeded {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("models.sqlite3")).unwrap();
    let project = workspace.create_project("App", "/tmp/app").unwrap();
    let tickets: Vec<Ticket> = (1..=12)
        .map(|n| {
            workspace
                .create_ticket(&format!("Ticket {n} about the importer"))
                .unwrap()
        })
        .collect();
    let t = |n: usize| &tickets[n - 1];
    workspace.add_tag(&t(1).reference, "ui").unwrap();
    workspace.add_tag(&t(1).reference, "api").unwrap();
    workspace.add_tag(&t(3).reference, "ui").unwrap();
    workspace
        .add_dependency(&t(2).reference, &t(1).reference, None)
        .unwrap();
    workspace
        .add_dependency(&t(3).reference, &t(1).reference, None)
        .unwrap();
    workspace
        .add_dependency(&t(4).reference, &t(5).reference, None)
        .unwrap();
    status(&mut workspace, t(2), Status::Done);
    workspace
        .set_parent(&t(6).reference, Some(&t(5).reference), None)
        .unwrap();
    workspace
        .set_parent(&t(7).reference, Some(&t(5).reference), None)
        .unwrap();
    workspace
        .mark_duplicate(&t(8).reference, &t(9).reference, None)
        .unwrap();
    workspace
        .add_activity(&t(1).reference, "Started on the parser", Some("agent"))
        .unwrap();
    workspace
        .add_activity(&t(1).reference, &"Long brief ".repeat(200), None)
        .unwrap();
    workspace
        .add_activity(&t(10).reference, "Waiting on review", None)
        .unwrap();
    workspace
        .change_ticket(
            &t(10).reference,
            TicketPatch {
                project_id: Some(Some(project.id.clone())),
                body: Some("Räksmörgås for the gateway".into()),
                ..Default::default()
            },
        )
        .unwrap();
    status(&mut workspace, t(3), Status::InProgress);
    status(&mut workspace, t(10), Status::InProgress);
    status(&mut workspace, t(4), Status::InReview);
    status(&mut workspace, t(11), Status::Canceled);
    workspace.set_trashed(&t(12).reference, true, None).unwrap();
    Seeded {
        workspace,
        _dir: dir,
    }
}

/// The filters a list and a board page through.
fn pages() -> Vec<TicketFilter> {
    let mut filters = vec![
        TicketFilter::default(),
        TicketFilter {
            order: TicketOrder::Workflow,
            limit: 5,
            offset: 3,
            ..Default::default()
        },
        TicketFilter {
            query: "importer".into(),
            ..Default::default()
        },
        TicketFilter {
            tags: vec!["ui".into()],
            ..Default::default()
        },
    ];
    for status in [
        Status::Todo,
        Status::InProgress,
        Status::InReview,
        Status::Done,
        Status::Canceled,
        Status::Duplicate,
    ] {
        filters.push(TicketFilter {
            status: Some(status),
            order: TicketOrder::Workflow,
            ..Default::default()
        });
    }
    filters
}

#[test]
fn a_ticket_row_says_what_the_full_ticket_says_without_its_body() {
    let Seeded { workspace, .. } = seeded();
    for filter in pages() {
        let expected: Vec<TicketRow> = workspace
            .find_tickets_with_updates(&filter)
            .unwrap()
            .into_iter()
            .map(
                |TicketWithUpdate {
                     ticket,
                     latest_update,
                 }| {
                    // The seeded Workspace has no source, so no row names one.
                    assert!(ticket.source.is_none());
                    TicketRow {
                        tags: ticket.tags,
                        latest_update,
                        source: None,
                        duplicate_of: ticket.duplicate_of,
                        prerequisites: PrerequisiteCounts {
                            total: ticket.prerequisites.len(),
                            unresolved: ticket
                                .prerequisites
                                .iter()
                                .filter(|blocker| blocker.unresolved)
                                .count(),
                        },
                        parent: ticket.parent,
                        id: ticket.id,
                        reference: ticket.reference,
                        title: ticket.title,
                        status: ticket.status,
                        trashed: ticket.trashed,
                        project_id: ticket.project_id,
                        plan_id: ticket.plan_id,
                        availability: ticket.availability,
                        updated_at: ticket.updated_at,
                    }
                },
            )
            .collect();
        assert_eq!(workspace.find_ticket_rows(&filter).unwrap(), expected);
    }
    let rows = workspace
        .find_ticket_rows(&TicketFilter::default())
        .unwrap();
    let first = rows
        .iter()
        .find(|row| row.title.starts_with("Ticket 1 "))
        .unwrap();
    assert_eq!(first.tags, ["api", "ui"]);
    assert_eq!(
        first.prerequisites,
        PrerequisiteCounts {
            total: 2,
            unresolved: 1
        }
    );
    let brief = &first.latest_update.as_ref().unwrap().brief;
    assert!(brief.truncated && brief.text.chars().count() == 1024);
}

#[test]
fn a_listed_ticket_is_the_ticket_shown_on_its_own() {
    let Seeded { workspace, .. } = seeded();
    let listed = workspace.list_tickets().unwrap();
    assert_eq!(listed.len(), 11);
    let numbered = |n: usize| {
        listed
            .iter()
            .find(|ticket| ticket.title.starts_with(&format!("Ticket {n} ")))
            .unwrap()
    };
    assert_eq!(numbered(1).availability.as_deref(), Some("Blocked"));
    assert_eq!(
        numbered(1)
            .prerequisites
            .iter()
            .map(|blocker| (blocker.reference.clone(), blocker.unresolved))
            .collect::<Vec<_>>(),
        [
            (numbered(2).reference.clone(), false),
            (numbered(3).reference.clone(), true)
        ]
    );
    assert_eq!(
        numbered(5)
            .children
            .iter()
            .map(|child| child.reference.clone())
            .collect::<Vec<_>>(),
        [numbered(6).reference.clone(), numbered(7).reference.clone()]
    );
    assert_eq!(
        numbered(6).parent.as_ref().map(|parent| &parent.reference),
        Some(&numbered(5).reference)
    );
    assert_eq!(
        numbered(8).duplicate_of,
        Some(numbered(9).reference.clone())
    );
    assert_eq!(numbered(9).duplicates, [numbered(8).reference.clone()]);
    assert!(numbered(10).latest_update.is_some() && numbered(4).latest_update.is_none());
    for ticket in listed {
        assert_eq!(ticket, workspace.show_ticket(&ticket.reference).unwrap());
    }
    let page = workspace
        .find_tickets(&TicketFilter {
            order: TicketOrder::Workflow,
            ..Default::default()
        })
        .unwrap();
    for ticket in page {
        assert_eq!(ticket, workspace.show_ticket(&ticket.reference).unwrap());
    }
}
