use ticketd_core::{
    CHAT_CHANGE_TAIL, CHAT_EFFECTIVE_SETTINGS_LIMIT, CHAT_NOTICE_LIMIT, CHAT_RESET_TIME_MAX,
    CHAT_TOOL_OUTPUT_LIMIT, Chat, ChatCatchUp, ChatDelivery, ChatDeliveryDecision,
    ChatInputStanding, ChatInteractionKind, ChatInteractionState, ChatItem, ChatLink, ChatLinkKind,
    ChatListFilter, ChatMessage, ChatObservation, ChatRecord, ChatSessionOrigin,
    ChatSubmissionIntent, ChatToolState, ChatTurnState, Error, NewChat, Workspace,
};

const CHAT_TABLES: &str = "DROP TABLE chat_record_writes; DROP TABLE chat_changes; DROP TABLE chat_notices; DROP TABLE chat_interactions; DROP TABLE chat_tools; DROP TABLE chat_submission_attempts; DROP TABLE chat_messages; DROP TABLE chat_turns; DROP TABLE chat_sessions; DROP TABLE chat_links; DROP TABLE chats;";

fn new_chat() -> NewChat {
    NewChat {
        title: None,
        harness: "claude-code".into(),
        execution_folder: "/work/app".into(),
        folder_managed: false,
        links: Vec::new(),
    }
}

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn workspace_with_chat(dir: &tempfile::TempDir) -> (Workspace, Chat) {
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let chat = workspace.create_chat(None, new_chat()).unwrap();
    (workspace, chat)
}

/// Saves one input and takes it through a possible submission into an active turn.
#[allow(clippy::unwrap_used)]
fn start_turn(workspace: &mut Workspace, chat: &Chat, text: &str, turn: &str) -> ChatMessage {
    let input = workspace.save_chat_input(None, &chat.id, text).unwrap();
    let attempt = format!("attempt-{turn}");
    workspace
        .record_chat_submission(&chat.id, &input.id, &attempt, ChatSubmissionIntent::NewTurn)
        .unwrap();
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::SubmissionAcknowledged {
                    attempt_id: attempt.clone(),
                },
                ChatObservation::TurnStarted {
                    turn_id: turn.into(),
                    native_turn_id: None,
                },
                ChatObservation::SubmissionProcessing {
                    attempt_id: attempt,
                    turn_id: turn.into(),
                },
            ],
        )
        .unwrap();
    input
}

#[allow(clippy::unwrap_used)]
fn message(workspace: &Workspace, chat: &Chat, id: &str) -> ChatMessage {
    workspace
        .chat_snapshot(&chat.id, 500)
        .unwrap()
        .items
        .into_iter()
        .find_map(|item| match item {
            ChatItem::Message(message) if message.id == id => Some(message),
            _ => None,
        })
        .unwrap()
}

#[test]
fn a_chat_links_to_several_records_without_belonging_to_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    let other = workspace.create_ticket("Other outcome").unwrap();
    let document = workspace.create_document(Some("Notes"), "Body").unwrap();
    let first = workspace.create_project("App", "/work/app").unwrap();
    let second = workspace.create_project("Site", "/work/site").unwrap();
    let link = |kind, id: &str| ChatLink {
        kind,
        id: id.into(),
    };

    let projectless = workspace.create_chat(None, new_chat()).unwrap();
    assert!(projectless.links.is_empty());
    assert_eq!(projectless.native_session_id, None);

    let chat = workspace
        .create_chat(
            None,
            NewChat {
                folder_managed: true,
                links: vec![
                    link(ChatLinkKind::Project, &first.id),
                    link(ChatLinkKind::Project, &second.id),
                    link(ChatLinkKind::Ticket, &ticket.id),
                ],
                ..new_chat()
            },
        )
        .unwrap();
    workspace
        .set_chat_link(&chat.id, link(ChatLinkKind::Ticket, &other.id), true)
        .unwrap();
    let chat = workspace
        .set_chat_link(&chat.id, link(ChatLinkKind::Document, &document.id), true)
        .unwrap();
    assert_eq!(chat.links.len(), 5);
    assert!(chat.folder_managed);
    assert_eq!(chat.harness, "claude-code");

    let chat = workspace
        .set_chat_link(&chat.id, link(ChatLinkKind::Project, &second.id), false)
        .unwrap();
    assert_eq!(chat.links.len(), 4);
    assert!(matches!(
        workspace.set_chat_link(&chat.id, link(ChatLinkKind::Ticket, "missing"), true),
        Err(Error::NotFound(_))
    ));
    // Linked records are untouched and the ticket still has no project.
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert_eq!(workspace.list_projects().unwrap().len(), 2);
    assert_eq!(
        workspace.list_chats(ChatListFilter::Active).unwrap().len(),
        2
    );
}

#[test]
fn a_repeated_command_id_returns_the_first_result_instead_of_a_second_record() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let chat = workspace.create_chat(Some("create-1"), new_chat()).unwrap();
    let again = workspace.create_chat(Some("create-1"), new_chat()).unwrap();
    assert_eq!(again.id, chat.id);
    assert_eq!(
        workspace.list_chats(ChatListFilter::Active).unwrap().len(),
        1
    );

    let input = workspace
        .save_chat_input(Some("send-1"), &chat.id, "Run the tests")
        .unwrap();
    let repeated = workspace
        .save_chat_input(Some("send-1"), &chat.id, "Run the tests")
        .unwrap();
    assert_eq!(repeated.id, input.id);
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
    assert!(matches!(
        workspace.save_chat_input(Some("send-1"), &chat.id, "Something else"),
        Err(Error::RequestConflict(_))
    ));

    // The same attempt identity is one attempt; it never becomes a second submission.
    workspace
        .record_chat_submission(
            &chat.id,
            &input.id,
            "attempt-1",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    let repeated = workspace
        .record_chat_submission(
            &chat.id,
            &input.id,
            "attempt-1",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    assert_eq!(repeated.attempts.len(), 1);
}

#[test]
fn saved_input_possible_submission_acknowledgment_processing_and_outcome_are_separate_facts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);

    let input = workspace
        .save_chat_input(None, &chat.id, "Fix the bug")
        .unwrap();
    assert!(input.queued);
    assert!(input.attempts.is_empty());
    assert_eq!(workspace.chat_queue(&chat.id).unwrap(), vec![input.clone()]);

    let submitted = workspace
        .record_chat_submission(
            &chat.id,
            &input.id,
            "attempt-1",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    assert!(!submitted.queued);
    assert_eq!(submitted.attempts[0].delivery, ChatDelivery::Possible);
    assert_eq!(submitted.attempts[0].turn_id, None);
    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
    assert_eq!(workspace.chat(&chat.id).unwrap().active_turn, None);

    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionAcknowledged {
                attempt_id: "attempt-1".into(),
            }],
        )
        .unwrap();
    let acknowledged = message(&workspace, &chat, &input.id);
    assert_eq!(
        acknowledged.attempts[0].delivery,
        ChatDelivery::Acknowledged
    );
    assert_eq!(acknowledged.attempts[0].turn_id, None);
    assert_eq!(workspace.chat(&chat.id).unwrap().active_turn, None);

    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::TurnStarted {
                    turn_id: "turn-1".into(),
                    native_turn_id: Some("native-7".into()),
                },
                ChatObservation::SubmissionProcessing {
                    attempt_id: "attempt-1".into(),
                    turn_id: "turn-1".into(),
                },
            ],
        )
        .unwrap();
    let active = workspace.chat(&chat.id).unwrap().active_turn.unwrap();
    assert_eq!(active.state, ChatTurnState::Active);
    assert_eq!(active.native_turn_id.as_deref(), Some("native-7"));
    assert_eq!(
        message(&workspace, &chat, &input.id).attempts[0]
            .turn_id
            .as_deref(),
        Some("turn-1")
    );
    // A Chat has at most one active turn.
    assert!(matches!(
        workspace.record_chat_observations(
            &chat.id,
            vec![ChatObservation::TurnStarted {
                turn_id: "turn-2".into(),
                native_turn_id: None,
            }],
        ),
        Err(Error::Chat(_))
    ));

    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::AssistantText {
                    message_id: "reply-1".into(),
                    turn_id: "turn-1".into(),
                    text: "Looking".into(),
                    complete: false,
                },
                ChatObservation::Tool {
                    tool_id: "tool-1".into(),
                    turn_id: "turn-1".into(),
                    name: "Bash".into(),
                    input: "cargo test".into(),
                    state: ChatToolState::Completed,
                    output: Some(format!("START{}END", "é".repeat(CHAT_TOOL_OUTPUT_LIMIT))),
                },
                ChatObservation::InteractionRequested {
                    interaction_id: "ask-1".into(),
                    turn_id: "turn-1".into(),
                    kind: ChatInteractionKind::Approval,
                    native_request_id: Some("req-1".into()),
                    prompt: "Allow Bash?".into(),
                    reason: None,
                    tool_id: Some("tool-1".into()),
                },
                ChatObservation::InteractionResolved {
                    interaction_id: "ask-1".into(),
                    state: ChatInteractionState::Answered,
                    response: Some("allow".into()),
                },
                ChatObservation::AssistantText {
                    message_id: "reply-1".into(),
                    turn_id: "turn-1".into(),
                    text: "Looking. Fixed.".into(),
                    complete: true,
                },
                ChatObservation::TurnEnded {
                    turn_id: "turn-1".into(),
                    state: ChatTurnState::Completed,
                    detail: None,
                    problem: None,
                    problem_resets_at: None,
                },
            ],
        )
        .unwrap();
    assert_eq!(workspace.chat(&chat.id).unwrap().active_turn, None);
    let snapshot = workspace.chat_snapshot(&chat.id, 50).unwrap();
    let kinds: Vec<&str> = snapshot
        .items
        .iter()
        .map(|item| match item {
            ChatItem::Session(_) => "session",
            ChatItem::Message(_) => "message",
            ChatItem::Turn(_) => "turn",
            ChatItem::Tool(_) => "tool",
            ChatItem::Interaction(_) => "interaction",
            ChatItem::Notice(_) => "notice",
        })
        .collect();
    assert_eq!(kinds, ["message", "turn", "message", "tool", "interaction"]);
    let reply = message(&workspace, &chat, "reply-1");
    assert_eq!(
        (reply.text.as_str(), reply.complete),
        ("Looking. Fixed.", true)
    );
    let ChatItem::Tool(tool) = &snapshot.items[3] else {
        panic!("expected the tool");
    };
    // The approval remembers the tool call it was asked for.
    let ChatItem::Interaction(asked) = &snapshot.items[4] else {
        panic!("expected the approval");
    };
    assert_eq!(asked.tool_id.as_deref(), Some("tool-1"));
    // It keeps when it was asked and answered, so the turn's time can leave the wait out.
    assert!(asked.asked_at.is_some() && asked.resolved_at.is_some());
    assert!(tool.output_truncated);
    // A running step's clock counts from when the host recorded the call.
    assert!(tool.started_at.is_some());
    // The end of the output is what is kept: it is where a command says how it went.
    let kept = tool.output.as_ref().unwrap();
    assert!(kept.len() <= CHAT_TOOL_OUTPUT_LIMIT && kept.len() > CHAT_TOOL_OUTPUT_LIMIT - 4);
    assert!(kept.ends_with("éEND") && !kept.starts_with("START"));
    let ChatItem::Interaction(interaction) = &snapshot.items[4] else {
        panic!("expected the interaction");
    };
    assert_eq!(interaction.state, ChatInteractionState::Answered);
    let ChatItem::Turn(turn) = &snapshot.items[1] else {
        panic!("expected the turn");
    };
    assert_eq!(turn.state, ChatTurnState::Completed);
}

#[test]
fn input_known_not_delivered_returns_to_the_queue_but_uncertain_delivery_is_never_resubmitted() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let input = workspace.save_chat_input(None, &chat.id, "Deploy").unwrap();
    let submit = |workspace: &mut Workspace, attempt: &str| {
        workspace.record_chat_submission(&chat.id, &input.id, attempt, ChatSubmissionIntent::Steer)
    };

    submit(&mut workspace, "attempt-1").unwrap();
    // While the first attempt is unresolved a second one is refused.
    assert!(matches!(
        submit(&mut workspace, "attempt-2"),
        Err(Error::ChatSubmissionUnresolved(_))
    ));
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionNotDelivered {
                attempt_id: "attempt-1".into(),
                detail: Some("steering is not supported".into()),
            }],
        )
        .unwrap();
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);

    submit(&mut workspace, "attempt-2").unwrap();
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionUncertain {
                attempt_id: "attempt-2".into(),
                detail: Some("the reply was lost".into()),
            }],
        )
        .unwrap();
    let uncertain = message(&workspace, &chat, &input.id);
    assert_eq!(uncertain.attempts.len(), 2);
    assert_eq!(uncertain.attempts[1].delivery, ChatDelivery::Uncertain);
    assert!(!uncertain.queued);
    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
    assert!(matches!(
        submit(&mut workspace, "attempt-3"),
        Err(Error::ChatSubmissionUnresolved(_))
    ));

    // Later native evidence can settle an uncertain attempt.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionAcknowledged {
                attempt_id: "attempt-2".into(),
            }],
        )
        .unwrap();
    assert_eq!(
        message(&workspace, &chat, &input.id).attempts[1].delivery,
        ChatDelivery::Acknowledged
    );
    // An acknowledged attempt cannot be rewritten as not delivered.
    assert!(matches!(
        workspace.record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionNotDelivered {
                attempt_id: "attempt-2".into(),
                detail: None,
            }],
        ),
        Err(Error::Chat(_))
    ));
}

#[test]
fn losing_contact_marks_work_uncertain_and_keeps_the_queue_without_dispatching() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "First", "turn-1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::AssistantText {
                    message_id: "reply-1".into(),
                    turn_id: "turn-1".into(),
                    text: "Partial".into(),
                    complete: false,
                },
                ChatObservation::Tool {
                    tool_id: "tool-1".into(),
                    turn_id: "turn-1".into(),
                    name: "Bash".into(),
                    input: "sleep 100".into(),
                    state: ChatToolState::Running,
                    output: None,
                },
                ChatObservation::InteractionRequested {
                    interaction_id: "ask-1".into(),
                    turn_id: "turn-1".into(),
                    kind: ChatInteractionKind::Question,
                    native_request_id: None,
                    prompt: "Which branch?".into(),
                    reason: None,
                    tool_id: None,
                },
            ],
        )
        .unwrap();
    let steering = workspace
        .save_chat_input(None, &chat.id, "Also this")
        .unwrap();
    workspace
        .record_chat_submission(
            &chat.id,
            &steering.id,
            "steer-1",
            ChatSubmissionIntent::Steer,
        )
        .unwrap();
    let queued = workspace.save_chat_input(None, &chat.id, "Later").unwrap();

    let affected = workspace
        .mark_chat_contact_lost(None, "the harness process exited")
        .unwrap();
    assert_eq!(affected, vec![chat.id.clone()]);
    assert_eq!(workspace.chat(&chat.id).unwrap().active_turn, None);
    let snapshot = workspace.chat_snapshot(&chat.id, 50).unwrap();
    for item in &snapshot.items {
        match item {
            ChatItem::Turn(turn) => {
                assert_eq!(turn.state, ChatTurnState::Unknown);
                assert_eq!(turn.detail.as_deref(), Some("the harness process exited"));
            }
            ChatItem::Tool(tool) => assert_eq!(tool.state, ChatToolState::Unknown),
            ChatItem::Interaction(interaction) => {
                assert_eq!(interaction.state, ChatInteractionState::Expired);
            }
            ChatItem::Message(message) if message.id == "reply-1" => {
                assert_eq!(
                    (message.text.as_str(), message.complete),
                    ("Partial", false)
                );
            }
            ChatItem::Message(_) | ChatItem::Session(_) | ChatItem::Notice(_) => {}
        }
    }
    assert_eq!(
        message(&workspace, &chat, &steering.id).attempts[0].delivery,
        ChatDelivery::Uncertain
    );
    // Queued input is retained, untouched, and nothing was submitted for it.
    let queue = workspace.chat_queue(&chat.id).unwrap();
    assert_eq!(queue, vec![queued]);
    // An expired request cannot be answered later.
    assert!(matches!(
        workspace.record_chat_observations(
            &chat.id,
            vec![ChatObservation::InteractionResolved {
                interaction_id: "ask-1".into(),
                state: ChatInteractionState::Answered,
                response: Some("main".into()),
            }],
        ),
        Err(Error::Chat(_))
    ));
    // Nothing is left to reconcile the second time.
    assert!(
        workspace
            .mark_chat_contact_lost(None, "again")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_failed_observation_rolls_back_the_whole_batch_and_its_change_entries() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "First", "turn-1");
    let before = workspace.chat_snapshot(&chat.id, 50).unwrap();

    let result = workspace.record_chat_observations(
        &chat.id,
        vec![
            ChatObservation::AssistantText {
                message_id: "reply-1".into(),
                turn_id: "turn-1".into(),
                text: "Half".into(),
                complete: false,
            },
            ChatObservation::TurnEnded {
                turn_id: "no-such-turn".into(),
                state: ChatTurnState::Completed,
                detail: None,
                problem: None,
                problem_resets_at: None,
            },
        ],
    );
    assert!(matches!(result, Err(Error::Chat(_))));
    let after = workspace.chat_snapshot(&chat.id, 50).unwrap();
    assert_eq!(after, before);
    assert_eq!(workspace.chat_change_sequence().unwrap(), before.sequence);
    assert!(matches!(
        workspace.chat_changes(&chat.id, before.sequence, 10).unwrap(),
        ChatCatchUp::Changes { changes, .. } if changes.is_empty()
    ));
}

#[test]
fn a_view_reads_a_bounded_snapshot_then_follows_ordered_changes_and_resyncs_on_a_gap() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let other = workspace.create_chat(None, new_chat()).unwrap();
    let token = workspace.change_token().unwrap();
    for index in 0..5 {
        workspace
            .save_chat_input(None, &chat.id, &format!("Input {index}"))
            .unwrap();
    }

    let snapshot = workspace.chat_snapshot(&chat.id, 2).unwrap();
    let texts = |items: &[ChatItem]| -> Vec<String> {
        items
            .iter()
            .map(|item| match item {
                ChatItem::Message(message) => message.text.clone(),
                other => panic!("unexpected item {other:?}"),
            })
            .collect()
    };
    assert_eq!(texts(&snapshot.items), ["Input 3", "Input 4"]);
    assert!(snapshot.earlier);
    let ChatItem::Message(oldest) = &snapshot.items[0] else {
        panic!("expected a message");
    };
    let earlier = workspace
        .chat_history(&chat.id, oldest.position, 10)
        .unwrap();
    assert_eq!(texts(&earlier.items), ["Input 0", "Input 1", "Input 2"]);
    assert!(!earlier.earlier);

    // Changes in another Chat are not delivered to this one.
    workspace
        .save_chat_input(None, &other.id, "Elsewhere")
        .unwrap();
    let sixth = workspace
        .save_chat_input(None, &chat.id, "Input 5")
        .unwrap();
    workspace
        .record_chat_submission(
            &chat.id,
            &sixth.id,
            "attempt-1",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    workspace.set_chat_archived(&chat.id, true).unwrap();
    workspace
        .save_chat_input(None, &chat.id, "Input 6")
        .unwrap();

    let ChatCatchUp::Changes {
        changes,
        sequence,
        more,
    } = workspace
        .chat_changes(&chat.id, snapshot.sequence, 2)
        .unwrap()
    else {
        panic!("expected changes");
    };
    assert!(more);
    assert!(changes[0].sequence < changes[1].sequence);
    assert_eq!(sequence, changes[1].sequence);
    // The input changed twice; a follower receives its latest state once.
    assert!(matches!(
        &changes[0].record,
        ChatRecord::Item(ChatItem::Message(message))
            if message.id == sixth.id && message.attempts.len() == 1
    ));
    assert!(matches!(&changes[1].record, ChatRecord::Chat(chat) if chat.archived));
    let ChatCatchUp::Changes { changes, more, .. } =
        workspace.chat_changes(&chat.id, sequence, 2).unwrap()
    else {
        panic!("expected changes");
    };
    assert!(!more);
    assert_eq!(changes.len(), 1);
    assert!(matches!(
        &changes[0].record,
        ChatRecord::Item(ChatItem::Message(message)) if message.text == "Input 6"
    ));

    // High-frequency Chat writes leave the workspace change token alone.
    assert_eq!(workspace.change_token().unwrap(), token);

    // A cursor from before the retained tail, or from another database, must resync.
    start_turn(&mut workspace, &chat, "Long answer", "turn-1");
    let checkpoints = (0..CHAT_CHANGE_TAIL + 10)
        .map(|index| ChatObservation::AssistantText {
            message_id: "reply-1".into(),
            turn_id: "turn-1".into(),
            text: format!("checkpoint {index}"),
            complete: false,
        })
        .collect();
    let head = workspace
        .record_chat_observations(&chat.id, checkpoints)
        .unwrap();
    assert_eq!(head, workspace.chat_change_sequence().unwrap());
    assert_eq!(
        workspace
            .chat_changes(&chat.id, snapshot.sequence, 10)
            .unwrap(),
        ChatCatchUp::Resync
    );
    assert_eq!(
        workspace.chat_changes(&chat.id, head + 1, 10).unwrap(),
        ChatCatchUp::Resync
    );
    let fresh = workspace.chat_snapshot(&chat.id, 2).unwrap();
    assert_eq!(fresh.sequence, head);
    assert!(matches!(
        workspace.chat_changes(&chat.id, fresh.sequence, 10).unwrap(),
        ChatCatchUp::Changes { changes, .. } if changes.is_empty()
    ));
    // The other Chat's log was not trimmed by this one's activity.
    assert!(matches!(
        workspace.chat_changes(&other.id, 0, 10).unwrap(),
        ChatCatchUp::Changes { changes, .. } if changes.len() == 2
    ));
}

#[test]
fn archive_and_trash_keep_identity_history_queue_and_links() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                links: vec![ChatLink {
                    kind: ChatLinkKind::Ticket,
                    id: ticket.id.clone(),
                }],
                ..new_chat()
            },
        )
        .unwrap();
    start_turn(&mut workspace, &chat, "First", "turn-1");
    let queued = workspace.save_chat_input(None, &chat.id, "Queued").unwrap();
    let list = |workspace: &Workspace, filter| -> Vec<String> {
        workspace
            .list_chats(filter)
            .unwrap()
            .into_iter()
            .map(|chat| chat.id)
            .collect()
    };

    // Archive hides the Chat; its active work and queue are unaffected.
    let archived = workspace.set_chat_archived(&chat.id, true).unwrap();
    assert!(archived.archived);
    assert!(archived.active_turn.is_some());
    assert!(list(&workspace, ChatListFilter::Active).is_empty());
    assert_eq!(
        list(&workspace, ChatListFilter::Archived),
        vec![chat.id.clone()]
    );
    workspace
        .save_chat_input(None, &chat.id, "Still accepted")
        .unwrap();
    workspace.set_chat_archived(&chat.id, false).unwrap();
    assert_eq!(
        list(&workspace, ChatListFilter::Active),
        vec![chat.id.clone()]
    );

    // Trash exposes the still-active turn so the host can stop it, and refuses new work.
    let trashed = workspace.set_chat_trashed(&chat.id, true).unwrap();
    assert!(trashed.trashed);
    assert_eq!(
        trashed.active_turn.as_ref().map(|turn| turn.id.as_str()),
        Some("turn-1")
    );
    assert!(list(&workspace, ChatListFilter::Active).is_empty());
    assert_eq!(
        list(&workspace, ChatListFilter::Trashed),
        vec![chat.id.clone()]
    );
    assert!(matches!(
        workspace.save_chat_input(None, &chat.id, "Not while trashed"),
        Err(Error::ChatTrashed(_))
    ));
    assert!(matches!(
        workspace.record_chat_submission(
            &chat.id,
            &queued.id,
            "attempt-9",
            ChatSubmissionIntent::NewTurn
        ),
        Err(Error::ChatTrashed(_))
    ));
    // The host's stop is still recorded against the trashed Chat.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::TurnEnded {
                turn_id: "turn-1".into(),
                state: ChatTurnState::Interrupted,
                detail: None,
                problem: None,
                problem_resets_at: None,
            }],
        )
        .unwrap();

    let restored = workspace.set_chat_trashed(&chat.id, false).unwrap();
    assert_eq!(restored.id, chat.id);
    assert_eq!(restored.links, chat.links);
    assert_eq!(restored.active_turn, None);
    let queue = workspace.chat_queue(&chat.id).unwrap();
    assert_eq!(queue.len(), 2);
    assert_eq!(queue[0], queued);
    assert_eq!(
        workspace.chat_snapshot(&chat.id, 50).unwrap().items.len(),
        4
    );
    // The linked ticket was never touched.
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert!(workspace.list_trash().unwrap().is_empty());
}

#[test]
fn a_resume_records_a_new_native_session_identity_for_the_same_chat() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let started = workspace
        .record_chat_session(&chat.id, "native-a", ChatSessionOrigin::New)
        .unwrap();
    assert_eq!(started.native_session_id.as_deref(), Some("native-a"));
    // Reporting the identity already in use is not a new session.
    workspace
        .record_chat_session(&chat.id, "native-a", ChatSessionOrigin::NativeResume)
        .unwrap();
    workspace.save_chat_input(None, &chat.id, "Before").unwrap();
    let resumed = workspace
        .record_chat_session(&chat.id, "native-b", ChatSessionOrigin::FreshSession)
        .unwrap();
    assert_eq!(resumed.id, chat.id);
    assert_eq!(resumed.native_session_id.as_deref(), Some("native-b"));

    let sessions: Vec<(String, ChatSessionOrigin)> = workspace
        .chat_snapshot(&chat.id, 50)
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Session(session) => Some((session.native_session_id, session.origin)),
            _ => None,
        })
        .collect();
    assert_eq!(
        sessions,
        [
            ("native-a".to_owned(), ChatSessionOrigin::New),
            ("native-b".to_owned(), ChatSessionOrigin::FreshSession)
        ]
    );
    // The earlier input keeps its place and is not replayed into the new session.
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
}

#[test]
fn chat_state_survives_backup_and_restore_without_resuming_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.create_chat(Some("create-1"), new_chat()).unwrap();
    workspace
        .record_chat_session(&chat.id, "native-a", ChatSessionOrigin::New)
        .unwrap();
    start_turn(&mut workspace, &chat, "First", "turn-1");
    workspace.save_chat_input(None, &chat.id, "Queued").unwrap();
    workspace.set_chat_queue_paused(&chat.id, true).unwrap();
    workspace
        .set_chat_execution_folder(&chat.id, "/work/elsewhere", false)
        .unwrap();
    let saved = workspace.chat_snapshot(&chat.id, 50).unwrap();
    workspace.backup(&backup).unwrap();
    let export = workspace.export().unwrap();
    assert_eq!(export["chats"][0]["id"], chat.id.as_str());
    assert_eq!(export["chat_messages"].as_array().unwrap().len(), 2);
    workspace.set_chat_trashed(&chat.id, true).unwrap();
    drop(workspace);

    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let restored = workspace.chat_snapshot(&chat.id, 50).unwrap();
    assert_eq!(restored, saved);
    assert!(restored.chat.queue_paused);
    assert_eq!(restored.chat.execution_folder, "/work/elsewhere");
    assert_eq!(restored.chat.native_session_id.as_deref(), Some("native-a"));
    assert_eq!(
        workspace
            .create_chat(Some("create-1"), new_chat())
            .unwrap()
            .id,
        chat.id
    );
    // The restored turn has no process behind it; the host reconciles before anything runs.
    assert_eq!(
        workspace.mark_chat_contact_lost(None, "restored").unwrap(),
        vec![chat.id.clone()]
    );
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
}

#[test]
fn a_format_before_chat_and_its_backups_gain_chat_storage_without_losing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("old-backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap();
    drop(workspace);
    // Format 66 added Chat storage.
    let previous = 65;
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(&format!("{CHAT_TABLES} PRAGMA user_version = {previous};"))
        .unwrap();
    db.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    let chat = workspace.create_chat(None, new_chat()).unwrap();
    workspace.save_chat_input(None, &chat.id, "Hello").unwrap();
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
    drop(workspace);

    // A backup taken before Chat existed still restores and then migrates on open.
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert!(
        workspace
            .list_chats(ChatListFilter::Active)
            .unwrap()
            .is_empty()
    );
    workspace.create_chat(None, new_chat()).unwrap();
}

#[test]
fn linked_records_are_read_as_they_are_now_not_as_they_were_when_linked() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("First title").unwrap();
    let document = workspace.create_document(None, "# Notes\n\nBody").unwrap();
    let project = workspace.create_project("App", "/work/app").unwrap();
    let link = |kind, id: &str| ChatLink {
        kind,
        id: id.into(),
    };
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                links: vec![
                    link(ChatLinkKind::Ticket, &ticket.id),
                    link(ChatLinkKind::Document, &document.id),
                    link(ChatLinkKind::Project, &project.id),
                ],
                ..new_chat()
            },
        )
        .unwrap();

    let summary = |workspace: &Workspace| -> Vec<(Option<String>, String, bool)> {
        workspace
            .chat_linked_records(&chat.id)
            .unwrap()
            .into_iter()
            .map(|record| (record.reference, record.title, record.trashed))
            .collect()
    };
    assert_eq!(
        summary(&workspace),
        [
            (Some("T-KQ1".into()), "First title".into(), false),
            (None, "Notes".into(), false),
            (None, "App".into(), false),
        ]
    );

    workspace
        .change_ticket(
            "T-KQ1",
            ticketd_core::TicketPatch {
                title: Some("Second title".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace.set_document_trashed(&document.id, true).unwrap();
    let records = workspace.chat_linked_records(&chat.id).unwrap();
    assert_eq!(records[0].title, "Second title");
    assert_eq!(records[0].id, ticket.id);
    assert_eq!(records[0].kind, ChatLinkKind::Ticket);
    assert!(records[1].trashed);
    // Linking a project is context only; the Chat keeps its own folder.
    assert_eq!(
        workspace.chat(&chat.id).unwrap().execution_folder,
        "/work/app"
    );
    assert!(matches!(
        workspace.chat_linked_records("missing"),
        Err(Error::ChatNotFound(_))
    ));
}

#[test]
fn queued_input_can_be_withdrawn_until_a_submission_may_have_reached_the_harness() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let waiting = workspace.save_chat_input(None, &chat.id, "later").unwrap();
    let sent = start_turn(&mut workspace, &chat, "now", "turn-1");

    workspace
        .withdraw_chat_input(&chat.id, &waiting.id)
        .unwrap();

    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
    assert!(matches!(
        workspace.withdraw_chat_input(&chat.id, &sent.id),
        Err(Error::Chat(_))
    ));
    assert_eq!(message(&workspace, &chat, &sent.id).text, "now");
}

#[test]
fn a_submission_its_turn_processed_stays_received_when_contact_is_lost() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let input = workspace.save_chat_input(None, &chat.id, "go").unwrap();
    workspace
        .record_chat_submission(&chat.id, &input.id, "a1", ChatSubmissionIntent::NewTurn)
        .unwrap();
    // The harness never acknowledged; it only correlated a turn, which then completed.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::TurnStarted {
                    turn_id: "t1".into(),
                    native_turn_id: None,
                },
                ChatObservation::SubmissionProcessing {
                    attempt_id: "a1".into(),
                    turn_id: "t1".into(),
                },
                ChatObservation::TurnEnded {
                    turn_id: "t1".into(),
                    state: ChatTurnState::Completed,
                    detail: None,
                    problem: None,
                    problem_resets_at: None,
                },
            ],
        )
        .unwrap();

    let affected = workspace
        .mark_chat_contact_lost(None, "ticketd was restarted")
        .unwrap();

    let attempt = message(&workspace, &chat, &input.id).attempts[0].clone();
    assert!(affected.is_empty());
    assert_eq!(attempt.delivery, ChatDelivery::Possible);
    assert!(attempt.received());
    assert!(!message(&workspace, &chat, &input.id).awaits_decision());
}

#[test]
fn a_person_closes_uncertain_delivery_without_rewriting_what_was_observed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let uncertain = |workspace: &mut Workspace, text: &str, attempt: &str| {
        let input = workspace.save_chat_input(None, &chat.id, text).unwrap();
        workspace
            .record_chat_submission(&chat.id, &input.id, attempt, ChatSubmissionIntent::NewTurn)
            .unwrap();
        workspace.mark_chat_contact_lost(None, "lost").unwrap();
        input
    };
    let discarded = uncertain(&mut workspace, "first", "a1");
    let resent = uncertain(&mut workspace, "second", "a2");
    assert!(message(&workspace, &chat, &resent.id).awaits_decision());

    let after = workspace
        .discard_uncertain_chat_submission(&chat.id, &discarded.id)
        .unwrap();
    assert_eq!(after.attempts.len(), 1);
    assert_eq!(after.attempts[0].delivery, ChatDelivery::Uncertain);
    assert_eq!(
        after.attempts[0].decision,
        Some(ChatDeliveryDecision::Discarded)
    );
    assert!(!after.awaits_decision() && !after.queued);
    // Decided once: it can be neither decided again nor submitted as if it were queued.
    assert!(
        workspace
            .record_chat_resubmission(&chat.id, &discarded.id, "a3")
            .is_err()
    );
    assert!(matches!(
        workspace.record_chat_submission(
            &chat.id,
            &discarded.id,
            "a3",
            ChatSubmissionIntent::NewTurn
        ),
        Err(Error::ChatSubmissionUnresolved(_))
    ));

    let after = workspace
        .record_chat_resubmission(&chat.id, &resent.id, "a4")
        .unwrap();
    let deliveries: Vec<_> = after.attempts.iter().map(|a| a.delivery).collect();
    assert_eq!(
        deliveries,
        [ChatDelivery::Uncertain, ChatDelivery::Possible]
    );
    assert_eq!(
        after.attempts[0].decision,
        Some(ChatDeliveryDecision::Resent)
    );
    assert_eq!(after.attempts[1].decision, None);
    // Repeating the same attempt records nothing new.
    let again = workspace
        .record_chat_resubmission(&chat.id, &resent.id, "a4")
        .unwrap();
    assert_eq!(again.attempts.len(), 2);
    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
}

#[test]
fn a_failed_turn_keeps_its_problem_kind_and_notices_and_reported_settings_are_stored() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "go", "t1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::Notice {
                    notice_id: "n1".into(),
                    text: "x".repeat(CHAT_NOTICE_LIMIT + 10),
                    from_harness: false,
                },
                ChatObservation::TurnEnded {
                    turn_id: "t1".into(),
                    state: ChatTurnState::Failed,
                    detail: Some("usage limit reached".into()),
                    problem: Some("quota_exhausted".into()),
                    problem_resets_at: Some(1_730_948_100),
                },
            ],
        )
        .unwrap();
    let chat = workspace
        .set_chat_effective_settings(&chat.id, r#"{"model":"m"}"#)
        .unwrap();

    assert_eq!(chat.effective_settings.as_deref(), Some(r#"{"model":"m"}"#));
    let items = workspace.chat_snapshot(&chat.id, 50).unwrap().items;
    let turn = items.iter().find_map(|item| match item {
        ChatItem::Turn(turn) => Some(turn),
        _ => None,
    });
    assert_eq!(turn.unwrap().problem.as_deref(), Some("quota_exhausted"));
    assert_eq!(turn.unwrap().problem_resets_at, Some(1_730_948_100));
    let notice = items.iter().find_map(|item| match item {
        ChatItem::Notice(notice) => Some(notice),
        _ => None,
    });
    assert_eq!(notice.unwrap().text.chars().count(), CHAT_NOTICE_LIMIT);
}

#[test]
fn an_approval_keeps_why_it_was_asked_apart_from_what_would_run() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "go", "t1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::InteractionRequested {
                interaction_id: "ask-1".into(),
                turn_id: "t1".into(),
                kind: ChatInteractionKind::Approval,
                native_request_id: Some("req-1".into()),
                prompt: "npm install".into(),
                reason: Some("x".repeat(CHAT_NOTICE_LIMIT + 10)),
                tool_id: None,
            }],
        )
        .unwrap();

    let items = workspace.chat_snapshot(&chat.id, 50).unwrap().items;
    let asked = items.iter().find_map(|item| match item {
        ChatItem::Interaction(interaction) => Some(interaction),
        _ => None,
    });
    assert_eq!(asked.unwrap().prompt, "npm install");
    let reason = asked.unwrap().reason.as_deref().unwrap();
    assert_eq!(reason.chars().count(), CHAT_NOTICE_LIMIT);
}

#[test]
fn input_of_another_chat_is_refused_with_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let other = workspace.create_chat(None, new_chat()).unwrap();
    let input = workspace.save_chat_input(None, &other.id, "go").unwrap();

    let refused = workspace
        .record_chat_submission(&chat.id, &input.id, "a1", ChatSubmissionIntent::NewTurn)
        .unwrap_err();

    assert!(refused.to_string().contains("belongs to another Chat"));
}

#[test]
fn what_a_harness_reports_is_stored_within_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let long = "s".repeat(CHAT_EFFECTIVE_SETTINGS_LIMIT + 10);
    let stored = workspace
        .set_chat_effective_settings(&chat.id, &long)
        .unwrap();
    let kept = stored.effective_settings.map(|kept| kept.chars().count());
    assert_eq!(kept, Some(CHAT_EFFECTIVE_SETTINGS_LIMIT));

    // A reset time that is not a time is dropped, not stored.
    for (turn, reported, kept) in [
        ("t1", CHAT_RESET_TIME_MAX, Some(CHAT_RESET_TIME_MAX)),
        ("t2", CHAT_RESET_TIME_MAX + 1, None),
        ("t3", -1, None),
    ] {
        start_turn(&mut workspace, &chat, "go", turn);
        let ended = ChatObservation::TurnEnded {
            turn_id: turn.into(),
            state: ChatTurnState::Failed,
            detail: None,
            problem: Some("quota_exhausted".into()),
            problem_resets_at: Some(reported),
        };
        workspace
            .record_chat_observations(&chat.id, vec![ended])
            .unwrap();
        let items = workspace.chat_snapshot(&chat.id, 50).unwrap().items;
        let stored = items.iter().find_map(|item| match item {
            ChatItem::Turn(stored) if stored.id == turn => Some(stored.problem_resets_at),
            _ => None,
        });
        assert_eq!(stored, Some(kept), "{reported}");
    }
}

/// One step of a submission's life, as the host or the person causes it.
#[derive(Debug, Clone, Copy)]
enum Step {
    Submit(&'static str),
    NotDelivered(&'static str),
    Rejected(&'static str),
    Acknowledged(&'static str),
    Processing(&'static str),
    LoseContact,
    Resend(&'static str),
    Discard,
}

#[test]
fn every_combination_of_delivery_decision_and_later_observation_has_one_standing() {
    use ChatInputStanding::{AwaitsDecision, Delivered, Queued, Sending, SetAside};
    use Step::{
        Acknowledged, Discard, LoseContact, NotDelivered, Processing, Rejected, Resend, Submit,
    };
    let uncertain = [Submit("a1"), LoseContact];
    let discarded = [Submit("a1"), LoseContact, Discard];
    let resent = [Submit("a1"), LoseContact, Resend("a2")];
    let refused = [Submit("a1"), LoseContact, Resend("a2"), Rejected("a2")];
    let then = |start: &[Step], more: &[Step]| [start, more].concat();
    let table: Vec<(Vec<Step>, ChatInputStanding)> = vec![
        // One attempt, as observed.
        (vec![], Queued),
        (vec![Submit("a1")], Sending),
        (vec![Submit("a1"), NotDelivered("a1")], Queued),
        (vec![Submit("a1"), Rejected("a1")], Queued),
        (vec![Submit("a1"), Acknowledged("a1")], Delivered),
        (vec![Submit("a1"), Processing("a1")], Delivered),
        // Uncertain and undecided, then what is observed later.
        (uncertain.to_vec(), AwaitsDecision),
        (then(&uncertain, &[Rejected("a1")]), Queued),
        (then(&uncertain, &[NotDelivered("a1")]), Queued),
        (then(&uncertain, &[Acknowledged("a1")]), Delivered),
        (then(&uncertain, &[Processing("a1")]), Delivered),
        // Discarded: never queued again, whatever is observed later.
        (discarded.to_vec(), SetAside),
        (then(&discarded, &[Rejected("a1")]), SetAside),
        (then(&discarded, &[NotDelivered("a1")]), SetAside),
        (then(&discarded, &[Acknowledged("a1")]), Delivered),
        (then(&discarded, &[Processing("a1")]), Delivered),
        // Resent: the new attempt's outcome, with the first attempt still uncertain.
        (resent.to_vec(), Sending),
        (refused.to_vec(), AwaitsDecision),
        (then(&resent, &[NotDelivered("a2")]), AwaitsDecision),
        (then(&resent, &[Acknowledged("a2")]), Delivered),
        (then(&resent, &[Processing("a2")]), Delivered),
        (then(&resent, &[LoseContact]), AwaitsDecision),
        (then(&resent, &[Rejected("a1")]), Sending),
        (
            then(&resent, &[LoseContact, Rejected("a2")]),
            AwaitsDecision,
        ),
        (
            then(&resent, &[LoseContact, Rejected("a1")]),
            AwaitsDecision,
        ),
        (then(&resent, &[LoseContact, Discard]), SetAside),
        (
            then(&resent, &[LoseContact, Discard, Rejected("a2")]),
            SetAside,
        ),
        // A refused resend, then a later observation or another decision.
        (then(&refused, &[Rejected("a1")]), Queued),
        (then(&refused, &[Acknowledged("a1")]), Delivered),
        (then(&refused, &[Discard]), SetAside),
        (then(&refused, &[Discard, Rejected("a1")]), SetAside),
        (then(&refused, &[Resend("a3")]), Sending),
        (
            then(&refused, &[Resend("a3"), Rejected("a3")]),
            AwaitsDecision,
        ),
        (
            then(&refused, &[Resend("a3"), Acknowledged("a3")]),
            Delivered,
        ),
    ];

    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    for (row, (steps, expected)) in table.into_iter().enumerate() {
        let chat = workspace.create_chat(None, new_chat()).unwrap();
        let input = workspace.save_chat_input(None, &chat.id, "go").unwrap();
        let id = |attempt: &str| format!("{row}-{attempt}");
        let observe = |workspace: &mut Workspace, observation| {
            workspace
                .record_chat_observations(&chat.id, vec![observation])
                .unwrap();
        };
        for step in &steps {
            match *step {
                Submit(attempt) => {
                    let intent = ChatSubmissionIntent::NewTurn;
                    workspace
                        .record_chat_submission(&chat.id, &input.id, &id(attempt), intent)
                        .unwrap();
                }
                NotDelivered(attempt) => observe(
                    &mut workspace,
                    ChatObservation::SubmissionNotDelivered {
                        attempt_id: id(attempt),
                        detail: None,
                    },
                ),
                Rejected(attempt) => observe(
                    &mut workspace,
                    ChatObservation::SubmissionRejected {
                        attempt_id: id(attempt),
                        detail: None,
                    },
                ),
                Acknowledged(attempt) => observe(
                    &mut workspace,
                    ChatObservation::SubmissionAcknowledged {
                        attempt_id: id(attempt),
                    },
                ),
                Processing(attempt) => {
                    observe(
                        &mut workspace,
                        ChatObservation::TurnStarted {
                            turn_id: id("turn"),
                            native_turn_id: None,
                        },
                    );
                    observe(
                        &mut workspace,
                        ChatObservation::SubmissionProcessing {
                            attempt_id: id(attempt),
                            turn_id: id("turn"),
                        },
                    );
                }
                LoseContact => {
                    workspace
                        .mark_chat_contact_lost(Some(&chat.id), "lost")
                        .unwrap();
                }
                Resend(attempt) => {
                    workspace
                        .record_chat_resubmission(&chat.id, &input.id, &id(attempt))
                        .unwrap();
                }
                Discard => {
                    workspace
                        .discard_uncertain_chat_submission(&chat.id, &input.id)
                        .unwrap();
                }
            }
        }
        let after = message(&workspace, &chat, &input.id);
        let case = format!("row {row}: {steps:?}");
        assert_eq!(after.standing(), expected, "standing, {case}");
        // U15: input the host holds to send as soon as its session opens is being sent,
        // not in the queue; held or not changes nothing else.
        let held = if expected == Queued {
            Sending
        } else {
            expected
        };
        assert_eq!(after.standing_while(false), expected, "not held, {case}");
        assert_eq!(after.standing_while(true), held, "held, {case}");
        assert_eq!(after.queued, expected == Queued, "queued, {case}");
        assert_eq!(
            after.awaits_decision(),
            expected == AwaitsDecision,
            "awaits a decision, {case}"
        );
        let in_queue = !workspace.chat_queue(&chat.id).unwrap().is_empty();
        assert_eq!(in_queue, expected == Queued, "in the queue, {case}");
        // Only queued input can be submitted, and only an open decision can be resent.
        if expected != Queued {
            let intent = ChatSubmissionIntent::NewTurn;
            let submitted =
                workspace.record_chat_submission(&chat.id, &input.id, &id("next"), intent);
            assert!(submitted.is_err(), "not submitted, {case}");
            let resent = workspace.record_chat_resubmission(&chat.id, &input.id, &id("again"));
            assert_eq!(resent.is_ok(), expected == AwaitsDecision, "resent, {case}");
        }
    }
}

/// L3: what the Chat's agent changed in ticketd during a turn, oldest first: status
/// moves and Activities written under the harness's agent name, not others' changes
/// and nothing from before the turn.
#[test]
fn the_ticket_changes_a_chats_agent_made_during_a_turn_are_listed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let ticket = workspace.create_ticket("Reset email").unwrap();
    let reference = ticket.reference.clone();
    let moved = |status| ticketd_core::TicketPatch {
        status: Some(status),
        editing_agent: Some("claude-code".into()),
        ..Default::default()
    };
    workspace
        .add_activity(&reference, "Before the turn", Some("claude-code"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    start_turn(&mut workspace, &chat, "go", "turn-1");

    workspace
        .change_ticket(&reference, moved(ticketd_core::Status::InProgress))
        .unwrap();
    workspace
        .add_activity(&reference, "Drafted the copy", Some("claude-code"))
        .unwrap();
    workspace
        .add_activity(&reference, "Someone else", Some("codex"))
        .unwrap();
    workspace
        .add_activity(&reference, "A person", None)
        .unwrap();

    let changes = workspace
        .chat_turn_agent_changes(&chat.id, "turn-1")
        .unwrap();
    assert_eq!(
        changes,
        [
            ticketd_core::ChatAgentChange::Status {
                reference: reference.clone(),
                title: "Reset email".into(),
                from: "Todo".into(),
                to: "In progress".into(),
            },
            ticketd_core::ChatAgentChange::Update {
                reference,
                excerpt: "Drafted the copy".into(),
            },
        ]
    );
}

/// N2: two Chats of one harness working at the same time are each credited only with
/// the writes made for them (the CLI acting for a Chat); a write with no Chat identity
/// while they overlap is credited to neither, since either could have made it.
#[test]
fn overlapping_chats_of_one_harness_are_credited_only_with_their_own_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let (mut workspace, first) = workspace_with_chat(&dir);
    let second = workspace.create_chat(None, new_chat()).unwrap();
    let reference = workspace.create_ticket("Reset email").unwrap().reference;
    start_turn(&mut workspace, &first, "go", "turn-a");
    start_turn(&mut workspace, &second, "go", "turn-b");

    let mut for_first = Workspace::open(&path).unwrap();
    for_first.act_for_chat(&first.id).unwrap();
    let mut for_second = Workspace::open(&path).unwrap();
    for_second.act_for_chat(&second.id).unwrap();
    for_first
        .add_activity(&reference, "A-note", Some("claude-code"))
        .unwrap();
    for_second
        .add_activity(&reference, "B-note", Some("claude-code"))
        .unwrap();
    workspace
        .add_activity(&reference, "No Chat identity", Some("claude-code"))
        .unwrap();

    let excerpts = |chat: &Chat, turn: &str| {
        workspace
            .chat_turn_agent_changes(&chat.id, turn)
            .unwrap()
            .into_iter()
            .map(|change| match change {
                ticketd_core::ChatAgentChange::Update { excerpt, .. } => excerpt,
                other => panic!("unexpected {other:?}"),
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(excerpts(&first, "turn-a"), ["A-note"]);
    assert_eq!(excerpts(&second, "turn-b"), ["B-note"]);
}

#[allow(clippy::unwrap_used)]
fn end_turn(workspace: &mut Workspace, chat: &Chat, turn: &str) {
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::TurnEnded {
                turn_id: turn.into(),
                state: ChatTurnState::Completed,
                detail: None,
                problem: None,
                problem_resets_at: None,
            }],
        )
        .unwrap();
}

#[allow(clippy::unwrap_used)]
fn last_turn(workspace: &Workspace, chat: &Chat) -> ticketd_core::ChatTurn {
    workspace
        .chat_snapshot(&chat.id, 500)
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Turn(turn) => Some(turn),
            _ => None,
        })
        .max_by_key(|turn| turn.position)
        .unwrap()
}

#[test]
fn what_the_person_read_through_is_kept_and_only_moves_forward() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let message = start_turn(&mut workspace, &chat, "Hello", "turn-1");
    assert_eq!(chat.read_through, None);
    let read = workspace
        .mark_chat_read_through(&chat.id, "turn-1")
        .unwrap();
    assert_eq!(read.read_through.as_deref(), Some("turn-1"));
    // Scrolling back up to an earlier record does not move it back.
    let read = workspace
        .mark_chat_read_through(&chat.id, &message.id)
        .unwrap();
    assert_eq!(read.read_through.as_deref(), Some("turn-1"));
    // A record that is not in this Chat changes nothing.
    let read = workspace
        .mark_chat_read_through(&chat.id, "elsewhere")
        .unwrap();
    assert_eq!(read.read_through.as_deref(), Some("turn-1"));
    drop(workspace);
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert_eq!(
        workspace.chat(&chat.id).unwrap().read_through.as_deref(),
        Some("turn-1")
    );
}

#[test]
fn a_turn_that_ends_after_the_chat_was_seen_is_unseen_until_seen_again() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "Hello", "turn-1");
    // Seen while the turn runs: its outcome is still to come.
    workspace.mark_chat_seen(&chat.id).unwrap();
    end_turn(&mut workspace, &chat, "turn-1");
    let turn = last_turn(&workspace, &chat);
    assert!(workspace.chat(&chat.id).unwrap().unseen(&turn));

    assert!(!workspace.mark_chat_seen(&chat.id).unwrap().unseen(&turn));
    // Seeing it again writes nothing.
    let sequence = workspace.chat_change_sequence().unwrap();
    workspace.mark_chat_seen(&chat.id).unwrap();
    assert_eq!(workspace.chat_change_sequence().unwrap(), sequence);

    // Marked unread, it reads unread without its outcome becoming unseen again.
    let marked = workspace.mark_chat_unread(&chat.id).unwrap();
    assert!(marked.marked_unread && !marked.unseen(&turn));
    let mut reopened = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert!(reopened.chat(&chat.id).unwrap().marked_unread);
    // Seeing it clears the mark.
    assert!(!reopened.mark_chat_seen(&chat.id).unwrap().marked_unread);
}

#[test]
fn mute_is_kept_with_the_chat() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    assert!(!chat.muted);
    assert!(workspace.set_chat_muted(&chat.id, true).unwrap().muted);
    assert!(workspace.chat(&chat.id).unwrap().muted);
    assert!(!workspace.set_chat_muted(&chat.id, false).unwrap().muted);
}

#[test]
fn upgrading_keeps_existing_requests_without_a_tool() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "go", "t1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::InteractionRequested {
                interaction_id: "ask-1".into(),
                turn_id: "t1".into(),
                kind: ChatInteractionKind::Approval,
                native_request_id: None,
                prompt: "npm install".into(),
                reason: None,
                tool_id: Some("tool-1".into()),
            }],
        )
        .unwrap();
    drop(workspace);
    // Format 69 added the tool call an approval was asked for.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "ALTER TABLE chat_interactions DROP COLUMN tool_id; PRAGMA user_version = 68;",
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();
    let items = workspace.chat_snapshot(&chat.id, 50).unwrap().items;
    let asked = items.iter().find_map(|item| match item {
        ChatItem::Interaction(asked) => Some(asked),
        _ => None,
    });
    assert_eq!(
        asked.map(|asked| (asked.prompt.as_str(), asked.tool_id.as_deref())),
        Some(("npm install", None))
    );
}

#[test]
fn upgrading_counts_every_existing_turn_as_seen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "Hello", "turn-1");
    end_turn(&mut workspace, &chat, "turn-1");
    drop(workspace);
    // Format 67 added what the person has seen of each Chat.
    let previous = 66;
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(&format!(
        "ALTER TABLE chats DROP COLUMN seen_through; ALTER TABLE chats DROP COLUMN muted; PRAGMA user_version = {previous};"
    ))
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();
    let upgraded = workspace.chat(&chat.id).unwrap();
    assert!(!upgraded.unseen(&last_turn(&workspace, &chat)));
    assert!(!upgraded.muted);
}
