use ticketd_core::{
    CHAT_CHANGE_TAIL, CHAT_EFFECTIVE_SETTINGS_LIMIT, CHAT_NOTICE_LIMIT, CHAT_RESET_TIME_MAX,
    CHAT_TOOL_OUTPUT_LIMIT, Chat, ChatCatchUp, ChatDelivery, ChatDeliveryDecision, ChatInputChange,
    ChatInputStanding, ChatInteractionKind, ChatInteractionState, ChatItem, ChatLink, ChatLinkKind,
    ChatListFilter, ChatMessage, ChatObservation, ChatOwner, ChatQueueEdit, ChatRecord,
    ChatSessionOrigin, ChatSubAgent, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper,
    ChatSubmissionIntent, ChatToolState, ChatTurnState, Error, NewChat, Workspace,
};

/// A Workspace file as format `version` left it, holding one Chat (`chat-1`) with one
/// turn (`turn-1`, position 1) in `state`. Rows are seeded with SQL valid at that version,
/// so each column the test cares about is one the version already had.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn old_chat_workspace(path: &std::path::Path, version: i64, state: &str) {
    ticketd_core::create_workspace_at_format_version(path, version).unwrap();
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute(
        "INSERT INTO chats (id, harness, execution_folder) VALUES ('chat-1', 'claude-code', '/work/app')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO chat_turns (id, chat_id, position, state) VALUES ('turn-1', 'chat-1', 1, ?1)",
        [state],
    )
    .unwrap();
}

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
                    origin: None,
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
fn a_saved_input_replays_after_the_upload_limit_is_lowered() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let file =
        |data| ticketd_core::ChatAttachmentContent::from_data_url("note.txt", data, 100).unwrap();
    let original = [file("data:text/plain;base64,bm90ZQ==")];
    let different = [file("data:text/plain;base64,c3RvcA==")];
    let saved = workspace
        .save_chat_input_with_attachments(Some("save"), &chat.id, "Caption", &original)
        .unwrap();
    workspace.set_attachment_upload_limit(2).unwrap();
    assert_eq!(
        workspace
            .save_chat_input_with_attachments(Some("save"), &chat.id, "Caption", &original)
            .unwrap(),
        saved
    );
    assert!(matches!(
        workspace.save_chat_input_with_attachments(Some("save"), &chat.id, "Caption", &different),
        Err(Error::RequestConflict(_))
    ));
    assert!(matches!(
        workspace.save_chat_input_with_attachments(Some("new"), &chat.id, "Caption", &original),
        Err(Error::UploadLimit { limit: 2 })
    ));
    assert_eq!(workspace.chat_queue(&chat.id).unwrap(), [saved]);
}

#[test]
fn a_complete_backup_restores_the_exact_image_in_sent_chat_history() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let other = workspace.create_chat(None, new_chat()).unwrap();
    let image = ticketd_core::ChatAttachmentContent::from_image_data_url(
        "Screenshot.png",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    )
    .unwrap();
    let sent = workspace
        .save_chat_input_with_attachments(None, &chat.id, "", std::slice::from_ref(&image))
        .unwrap();
    let attachment = &sent.attachments[0];
    workspace
        .record_chat_submission(
            &chat.id,
            &sent.id,
            "attempt-image",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::SubmissionAcknowledged {
                attempt_id: "attempt-image".into(),
            }],
        )
        .unwrap();
    assert!(workspace.attachments(50, 0).unwrap().is_empty());
    assert!(
        workspace
            .chat_attachment_content(&other.id, &attachment.id)
            .is_err()
    );

    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    let restored_message = message(&restored, &chat, &sent.id);
    assert_eq!(restored_message.standing(), ChatInputStanding::Delivered);
    assert_eq!(restored_message.attachments, sent.attachments);
    assert_eq!(
        restored
            .chat_attachment_content(&chat.id, &attachment.id)
            .unwrap(),
        image
    );
}

#[test]
fn a_complete_backup_restores_the_exact_files_of_a_held_queue_edit() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let first = ticketd_core::ChatAttachmentContent::from_data_url(
        "sample.txt",
        "data:text/plain;base64,b3JpZ2luYWwgYnl0ZXMNCg==",
        100,
    )
    .unwrap();
    let second = ticketd_core::ChatAttachmentContent::from_data_url(
        "empty.bin",
        "data:application/octet-stream;base64,",
        100,
    )
    .unwrap();
    let queued = workspace
        .save_chat_input_with_attachments(None, &chat.id, "Use both", &[first, second])
        .unwrap();
    assert!(
        workspace
            .confirm_chat_queue_edit(&chat.id, &queued.id, "edit")
            .unwrap()
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    let queue = restored.chat_queue(&chat.id).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, queued.id);
    let queued = &queue[0];
    assert!(queued.editing);
    assert!(queued.queued);
    assert_eq!(queued.text, "Use both");
    assert_eq!(queued.attachments.len(), 2);
    for (file, name, expected) in [
        (
            &queued.attachments[0],
            "sample.txt",
            b"original bytes\r\n".as_slice(),
        ),
        (&queued.attachments[1], "empty.bin", b"".as_slice()),
    ] {
        assert_eq!(file.name, name);
        let destination = dir.path().join(name);
        restored
            .export_chat_attachment(&chat.id, &file.id, &destination)
            .unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), expected);
    }
}

#[test]
fn queued_edit_replacement_is_atomic_and_replays_after_its_originals_are_consumed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let file = ticketd_core::ChatAttachmentContent::from_data_url(
        "notes.txt",
        "data:text/plain;base64,c25hcHNob3Q=",
        100,
    )
    .unwrap();
    let original = workspace
        .save_chat_input_with_attachments(
            None,
            &chat.id,
            "Before editing",
            std::slice::from_ref(&file),
        )
        .unwrap();
    let other = workspace
        .save_chat_input(None, &chat.id, "Another message")
        .unwrap();
    let before_edit = workspace.chat_change_sequence().unwrap();
    assert!(
        workspace
            .confirm_chat_queue_edit(&chat.id, &original.id, "edit-one")
            .unwrap()
    );
    assert!(
        workspace
            .record_chat_queue_submission(
                &chat.id,
                &original.id,
                "send-held",
                ChatSubmissionIntent::NewTurn
            )
            .is_err()
    );

    let ChatCatchUp::Changes { changes, .. } =
        workspace.chat_changes(&chat.id, before_edit, 10).unwrap()
    else {
        panic!("expected queue edit changes");
    };
    assert!(changes.iter().any(|change| matches!(
        &change.record,
        ChatRecord::Item(ChatItem::Message(message)) if message.id == original.id && message.editing
    )));
    assert!(changes.iter().any(|change| matches!(
        &change.record,
        ChatRecord::Chat(updated) if updated.id == chat.id
    )));

    let replaces = vec![original.id.clone(), other.id.clone()];
    let edited = std::slice::from_ref(&file);
    assert!(
        workspace
            .save_chat_input_replacing(Some("save-edit"), &chat.id, "Edited", edited, &replaces)
            .is_err()
    );
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 2);
    assert_eq!(
        workspace
            .chat_message_attachment_contents(&chat.id, &original.id)
            .unwrap()
            .as_slice(),
        edited
    );
    assert!(
        workspace
            .confirm_chat_queue_edit(&chat.id, &other.id, "edit-two")
            .unwrap()
    );

    workspace.set_attachment_upload_limit(1).unwrap();
    assert!(matches!(
        workspace.save_chat_input_replacing(
            Some("save-edit"),
            &chat.id,
            "Edited",
            edited,
            &replaces
        ),
        Err(Error::UploadLimit { limit: 1 })
    ));
    assert!(
        workspace
            .chat_queue(&chat.id)
            .unwrap()
            .iter()
            .all(|message| message.editing)
    );
    workspace.set_attachment_upload_limit(100).unwrap();

    let cursor = workspace.chat_snapshot(&chat.id, 10).unwrap().sequence;
    let receipt = workspace
        .save_chat_input_replacing(Some("save-edit"), &chat.id, "Edited", edited, &replaces)
        .unwrap();
    let saved = receipt.message.as_ref().unwrap();
    assert_eq!(
        workspace.chat_changes(&chat.id, cursor, 10).unwrap(),
        ChatCatchUp::Resync
    );
    let refreshed = workspace.chat_snapshot(&chat.id, 10).unwrap();
    assert!(matches!(
        workspace.chat_changes(&chat.id, refreshed.sequence, 10).unwrap(),
        ChatCatchUp::Changes { changes, .. } if changes.is_empty()
    ));
    assert_eq!(
        workspace.chat_queue(&chat.id).unwrap().as_slice(),
        std::slice::from_ref(saved)
    );
    assert!(!saved.editing);
    assert_eq!(
        workspace
            .chat_message_attachment_contents(&chat.id, &saved.id)
            .unwrap()
            .as_slice(),
        edited
    );
    assert!(
        workspace
            .chat_attachment_content(&chat.id, &original.attachments[0].id)
            .is_err()
    );

    workspace.set_attachment_upload_limit(1).unwrap();
    assert_eq!(
        workspace
            .save_chat_input_replacing(Some("save-edit"), &chat.id, "Edited", edited, &replaces)
            .unwrap(),
        receipt
    );
    assert_eq!(
        workspace
            .replay_chat_input_replacing("save-edit", &chat.id, "Edited", edited, &replaces)
            .unwrap(),
        Some(receipt)
    );
    assert!(matches!(
        workspace.replay_chat_input_replacing(
            "save-edit",
            &chat.id,
            "Edited",
            edited,
            &replaces[..1]
        ),
        Err(Error::RequestConflict(_))
    ));
}

#[test]
fn a_chat_links_to_several_records_without_belonging_to_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Outcome").unwrap();
    let other = workspace.create_ticket("Other outcome").unwrap();
    let document = workspace.create_document(Some("Notes"), "Body").unwrap();
    let folder = |name: &str| {
        let path = dir.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        path.to_str().unwrap().to_owned()
    };
    let first = workspace.create_project("App", &folder("app")).unwrap();
    let second = workspace.create_project("Site", &folder("site")).unwrap();
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
fn the_first_save_of_a_partial_legacy_edit_applies_its_links_again() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let original = workspace
        .save_chat_input(None, &chat.id, "Original")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &original.id, "hold")
        .unwrap();
    let link = ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("Original context").unwrap().id,
    };
    workspace
        .add_chat_links(&chat.id, std::slice::from_ref(&link))
        .unwrap();
    let legacy_link_request = serde_json::json!({
        "operation": "chat_queue_edit_links",
        "chat_id": chat.id,
        "links": [["ticket", link.id]],
    })
    .to_string();
    let db = rusqlite::Connection::open(dir.path().join("workspace.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO request_outcomes (id, request, outcome) VALUES ('chat_queue_edit_links:edit', ?1, ?2)",
        [legacy_link_request, serde_json::to_string(&chat.id).unwrap()],
    ).unwrap();
    workspace
        .set_chat_link(&chat.id, link.clone(), false)
        .unwrap();

    let edit = ChatQueueEdit {
        replaces: vec![original.id],
        links: vec![link],
    };
    assert!(!workspace.chat_queue_edit_saved(&chat.id, "edit").unwrap());
    assert!(matches!(
        workspace.replay_chat_input_replacing("edit", &chat.id, "Edited", &[], &edit.replaces),
        Err(Error::RequestConflict(_))
    ));
    assert!(matches!(
        workspace.save_chat_input_replacing(Some("edit"), &chat.id, "Edited", &[], &edit.replaces),
        Err(Error::RequestConflict(_))
    ));
    assert!(workspace.chat_queue(&chat.id).unwrap()[0].editing);
    let (saved, linked) = workspace
        .save_chat_input_with_edit(Some("edit"), &chat.id, "Edited", &[], Some(&edit))
        .unwrap();

    assert!(linked);
    assert!(workspace.chat_queue_edit_saved(&chat.id, "edit").unwrap());
    assert_eq!(workspace.chat(&chat.id).unwrap().links, edit.links);
    let replacement = workspace.chat_queue(&chat.id).unwrap().remove(0);
    assert_eq!(replacement.id, saved.id);
    assert!(replacement.requires_link_context);
}

#[test]
fn legacy_queue_edit_links_replay_while_another_connection_holds_the_writer() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let original = workspace
        .save_chat_input(None, &chat.id, "Original")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &original.id, "hold")
        .unwrap();
    let link = ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("Context").unwrap().id,
    };
    let edit = ChatQueueEdit {
        replaces: vec![original.id],
        links: vec![link.clone()],
    };
    let (saved, linked) = workspace
        .save_chat_input_with_edit(Some("edit"), &chat.id, "Edited", &[], Some(&edit))
        .unwrap();
    assert!(linked);
    let mut peer = rusqlite::Connection::open(dir.path().join("workspace.sqlite3")).unwrap();
    peer.execute(
        "UPDATE request_outcomes SET request = json_remove(request, '$.links', '$.links_ordered') WHERE id = 'edit'",
        [],
    )
    .unwrap();
    let companion = serde_json::json!({
        "operation": "chat_queue_edit_links",
        "chat_id": chat.id,
        "links": [["ticket", link.id]],
    });
    peer.execute(
        "INSERT INTO request_outcomes (id, request, outcome) VALUES ('chat_queue_edit_links:edit', ?1, ?2)",
        [companion.to_string(), serde_json::to_string(&chat.id).unwrap()],
    ).unwrap();
    assert!(matches!(
        workspace.save_chat_input_replacing(Some("edit"), &chat.id, "Edited", &[], &edit.replaces),
        Err(Error::RequestConflict(_))
    ));
    workspace
        .set_chat_link(&chat.id, link.clone(), false)
        .unwrap();

    let _writer = peer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    assert_eq!(
        workspace
            .replay_chat_input_with_edit("edit", &chat.id, "Edited", &[], Some(&edit))
            .unwrap(),
        Some(saved),
    );
    let changed = ChatQueueEdit {
        links: Vec::new(),
        ..edit
    };
    assert!(matches!(
        workspace.replay_chat_input_with_edit("edit", &chat.id, "Edited", &[], Some(&changed)),
        Err(Error::RequestConflict(_))
    ));
    assert!(matches!(
        workspace.replay_chat_input_replacing("edit", &chat.id, "Edited", &[], &changed.replaces),
        Err(Error::RequestConflict(_))
    ));
    assert!(matches!(
        workspace.replay_chat_queue_edit("edit", &chat.id, "Edited", &[], &changed.replaces),
        Err(Error::RequestConflict(_))
    ));
    assert!(workspace.chat(&chat.id).unwrap().links.is_empty());
}

#[test]
fn a_replacement_only_save_binds_empty_links_even_after_withdrawal() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let original = workspace
        .save_chat_input(None, &chat.id, "Original")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &original.id, "hold")
        .unwrap();
    let replaces = vec![original.id];
    let mut saved = workspace
        .save_chat_input_replacing(Some("edit"), &chat.id, "Edited", &[], &replaces)
        .unwrap();
    workspace.withdraw_chat_input(&chat.id, &saved.id).unwrap();
    saved.message = None;

    assert_eq!(
        workspace
            .replay_chat_input_replacing("edit", &chat.id, "Edited", &[], &replaces)
            .unwrap(),
        Some(saved.clone()),
    );
    assert_eq!(
        workspace
            .save_chat_input_replacing(Some("edit"), &chat.id, "Edited", &[], &replaces)
            .unwrap(),
        saved,
    );
    let changed = ChatQueueEdit {
        replaces,
        links: vec![ChatLink {
            kind: ChatLinkKind::Ticket,
            id: workspace
                .create_ticket("Added only to the retry")
                .unwrap()
                .id,
        }],
    };
    assert!(matches!(
        workspace.replay_chat_input_with_edit("edit", &chat.id, "Edited", &[], Some(&changed)),
        Err(Error::RequestConflict(id)) if id == "edit"
    ));
    assert!(matches!(
        workspace.save_chat_input_with_edit(Some("edit"), &chat.id, "Edited", &[], Some(&changed)),
        Err(Error::RequestConflict(id)) if id == "edit"
    ));
    assert!(workspace.chat(&chat.id).unwrap().links.is_empty());
    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
}

#[test]
fn a_saved_legacy_input_with_no_link_receipt_replays_only_without_links() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let text = "Legacy input";
    let saved = workspace.save_chat_input(None, &chat.id, text).unwrap();
    let request =
        serde_json::json!({"operation": "save_chat_input", "chat_id": chat.id, "text": text});
    rusqlite::Connection::open(dir.path().join("workspace.sqlite3"))
        .unwrap()
        .execute(
            "INSERT INTO request_outcomes (id, request, outcome) VALUES ('legacy', ?1, ?2)",
            [
                request.to_string(),
                serde_json::to_string(&saved.id).unwrap(),
            ],
        )
        .unwrap();

    let linked = ChatInputChange::Link(vec![ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("New link").unwrap().id,
    }]);
    assert!(matches!(
        workspace.replay_chat_input_with_change("legacy", &chat.id, text, &[], Some(&linked)),
        Err(Error::RequestConflict(id)) if id == "legacy"
    ));
    assert!(matches!(
        workspace.save_chat_input_with_change(Some("legacy"), &chat.id, text, &[], Some(&linked)),
        Err(Error::RequestConflict(id)) if id == "legacy"
    ));
    assert_eq!(
        workspace
            .replay_chat_input("legacy", &chat.id, text, &[])
            .unwrap(),
        Some(saved.clone())
    );
    assert_eq!(
        workspace
            .save_chat_input(Some("legacy"), &chat.id, text)
            .unwrap(),
        saved
    );
    assert!(workspace.chat(&chat.id).unwrap().links.is_empty());
    assert_eq!(workspace.chat_queue(&chat.id).unwrap(), [saved]);
}

#[test]
fn public_command_ids_with_the_old_link_prefix_do_not_collide_with_input_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let change = ChatInputChange::Link(vec![ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("Context").unwrap().id,
    }]);
    let public = workspace
        .save_chat_input(
            Some("chat_queue_edit_links:before"),
            &chat.id,
            "Public input",
        )
        .unwrap();
    let (linked, added) = workspace
        .save_chat_input_with_change(Some("before"), &chat.id, "Linked input", &[], Some(&change))
        .unwrap();
    assert!(!public.requires_link_context);
    assert!(added);
    assert!(linked.message.as_ref().unwrap().requires_link_context);
    assert_eq!(
        workspace
            .replay_chat_input_with_change("before", &chat.id, "Linked input", &[], Some(&change))
            .unwrap(),
        Some(linked),
    );
    assert_eq!(
        workspace
            .replay_chat_input(
                "chat_queue_edit_links:before",
                &chat.id,
                "Public input",
                &[]
            )
            .unwrap(),
        Some(public),
    );

    let (already_linked, added) = workspace
        .save_chat_input_with_change(Some("after"), &chat.id, "Linked input", &[], Some(&change))
        .unwrap();
    assert!(!added);
    assert!(already_linked.message.unwrap().requires_link_context);
    workspace
        .save_chat_input(
            Some("chat_queue_edit_links:after"),
            &chat.id,
            "Public input",
        )
        .unwrap();
}

#[test]
fn linked_input_replay_binds_first_occurrence_order_for_new_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let ticket = ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("Outcome").unwrap().id,
    };
    let document = ChatLink {
        kind: ChatLinkKind::Document,
        id: workspace.create_document(Some("Notes"), "Body").unwrap().id,
    };
    let original = ChatInputChange::Link(vec![ticket.clone(), document.clone(), ticket.clone()]);
    let deduplicated = ChatInputChange::Link(vec![ticket.clone(), document.clone()]);
    let reversed = ChatInputChange::Link(vec![document.clone(), ticket.clone()]);
    let (saved, added) = workspace
        .save_chat_input_with_change(Some("new"), &chat.id, "Linked input", &[], Some(&original))
        .unwrap();
    assert!(added);
    let links = workspace.chat_linked_records(&chat.id).unwrap();
    assert_eq!([&links[0].id, &links[1].id], [&ticket.id, &document.id]);
    assert_eq!(
        workspace
            .replay_chat_input_with_change(
                "new",
                &chat.id,
                "Linked input",
                &[],
                Some(&deduplicated)
            )
            .unwrap(),
        Some(saved.clone())
    );
    assert!(matches!(
        workspace.replay_chat_input_with_change("new", &chat.id, "Linked input", &[], Some(&reversed)),
        Err(Error::RequestConflict(id)) if id == "new"
    ));
    assert!(matches!(
        workspace.save_chat_input_with_change(Some("new"), &chat.id, "Linked input", &[], Some(&reversed)),
        Err(Error::RequestConflict(id)) if id == "new"
    ));
    let wrong_kind = ChatInputChange::Link(vec![
        ticket.clone(),
        document,
        ChatLink {
            kind: ChatLinkKind::Project,
            id: ticket.id,
        },
    ]);
    assert!(matches!(
        workspace.replay_chat_input_with_change("new", &chat.id, "Linked input", &[], Some(&wrong_kind)),
        Err(Error::RequestConflict(id)) if id == "new"
    ));

    let (legacy, _) = workspace
        .save_chat_input_with_change(
            Some("legacy"),
            &chat.id,
            "Linked input",
            &[],
            Some(&reversed),
        )
        .unwrap();
    let db = rusqlite::Connection::open(dir.path().join("workspace.sqlite3")).unwrap();
    // This receipt already had input_source but wrote links in sorted order.
    db.execute(
        "UPDATE request_outcomes SET request = json_remove(request, '$.links_ordered') WHERE id = 'legacy'",
        [],
    )
    .unwrap();
    for change in [&original, &reversed] {
        assert_eq!(
            workspace
                .replay_chat_input_with_change(
                    "legacy",
                    &chat.id,
                    "Linked input",
                    &[],
                    Some(change)
                )
                .unwrap(),
            Some(legacy.clone())
        );
        assert_eq!(
            workspace
                .save_chat_input_with_change(
                    Some("legacy"),
                    &chat.id,
                    "Linked input",
                    &[],
                    Some(change)
                )
                .unwrap(),
            (legacy.clone(), false)
        );
    }
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 2);
}

#[test]
fn a_wording_edit_keeps_the_link_context_requirement_of_held_input() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let link = ChatLink {
        kind: ChatLinkKind::Ticket,
        id: workspace.create_ticket("Context").unwrap().id,
    };
    let (linked, _) = workspace
        .save_chat_input_with_change(
            None,
            &chat.id,
            "Linked input",
            &[],
            Some(&ChatInputChange::Link(vec![link.clone()])),
        )
        .unwrap();
    let plain = workspace
        .save_chat_input(None, &chat.id, "Plain input")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &linked.id, "hold-linked")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &plain.id, "hold-plain")
        .unwrap();
    let edit = ChatQueueEdit {
        replaces: vec![linked.id, plain.id],
        links: Vec::new(),
    };

    let (receipt, links_changed) = workspace
        .save_chat_input_with_edit(Some("edit"), &chat.id, "New wording", &[], Some(&edit))
        .unwrap();
    let replacement = receipt.into_message().unwrap();
    assert!(replacement.requires_link_context);
    assert!(!links_changed);
    assert_eq!(workspace.chat(&chat.id).unwrap().links, [link]);
    assert_eq!(workspace.chat_queue(&chat.id).unwrap(), [replacement]);
}

#[test]
fn archived_projects_reject_new_chat_links_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let project = workspace
        .create_project("App", dir.path().to_str().unwrap())
        .unwrap();
    let link = ChatLink {
        kind: ChatLinkKind::Project,
        id: project.id.clone(),
    };
    let linked = workspace
        .create_chat(
            None,
            NewChat {
                links: vec![link.clone()],
                ..new_chat()
            },
        )
        .unwrap();
    let other = workspace.create_chat(None, new_chat()).unwrap();
    let ticket = workspace.create_ticket("Context").unwrap();
    let ticket_link = ChatLink {
        kind: ChatLinkKind::Ticket,
        id: ticket.id,
    };
    workspace.set_project_archived(&project.id, true).unwrap();

    assert!(workspace.project_for_folder(dir.path()).unwrap().is_none());
    assert!(matches!(
        workspace.create_project("Other project", dir.path().to_str().unwrap()),
        Err(Error::CheckoutTaken(name)) if name == "App"
    ));

    assert!(matches!(
        workspace.create_chat(
            None,
            NewChat {
                links: vec![link.clone()],
                ..new_chat()
            }
        ),
        Err(Error::ProjectArchived(_))
    ));
    assert_eq!(
        workspace.list_chats(ChatListFilter::Active).unwrap().len(),
        2
    );
    assert!(matches!(
        workspace.set_chat_link(&other.id, link.clone(), true),
        Err(Error::ProjectArchived(_))
    ));
    assert!(matches!(
        workspace.add_chat_links(&other.id, &[ticket_link, link.clone()]),
        Err(Error::ProjectArchived(_))
    ));
    assert!(workspace.chat(&other.id).unwrap().links.is_empty());

    assert!(
        !workspace
            .add_chat_links(&linked.id, std::slice::from_ref(&link))
            .unwrap()
    );
    assert_eq!(
        workspace
            .set_chat_title(&linked.id, Some("Renamed"))
            .unwrap()
            .links
            .as_slice(),
        std::slice::from_ref(&link)
    );
    assert!(
        workspace
            .set_chat_link(&linked.id, link, false)
            .unwrap()
            .links
            .is_empty()
    );
    workspace.set_project_archived(&project.id, false).unwrap();
    assert_eq!(
        workspace.project_for_folder(dir.path()).unwrap(),
        Some(project)
    );
}

#[test]
fn archiving_a_project_preserves_its_tickets_chats_and_settings() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let checkout = dir.path().to_str().unwrap();
    let project = workspace
        .create_project_with_remote("App", checkout, Some("github.com/team/app"))
        .unwrap();
    let active = workspace
        .create_ticket_in_project("Open", Some(&project.id))
        .unwrap();
    let trashed = workspace
        .create_ticket_in_project("Future restoration", Some(&project.id))
        .unwrap();
    let plan = workspace.create_plan("Release").unwrap();
    workspace
        .set_plan(&active.reference, Some(&plan.id), None)
        .unwrap();
    workspace
        .add_dependency(&active.reference, &trashed.reference, None)
        .unwrap();
    let trashed = workspace
        .set_trashed(&trashed.reference, true, None)
        .unwrap();
    let active = workspace.show_ticket(&active.reference).unwrap();
    let link = ChatLink {
        kind: ChatLinkKind::Project,
        id: project.id.clone(),
    };
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                links: vec![link],
                ..new_chat()
            },
        )
        .unwrap();

    assert!(!project.archived);
    let before = workspace.change_token().unwrap();
    let archived = workspace.set_project_archived(&project.id, true).unwrap();
    assert!(archived.archived);
    assert_eq!(workspace.show_project(&project.id).unwrap(), archived);
    assert_eq!(
        workspace.list_projects().unwrap().as_slice(),
        std::slice::from_ref(&archived)
    );
    assert_eq!(workspace.list_tickets().unwrap().len(), 1);
    assert_eq!(workspace.show_ticket(&active.reference).unwrap(), active);
    assert_eq!(
        workspace.chat_snapshot(&chat.id, 1).unwrap().chat.links,
        chat.links
    );
    let token = workspace.change_token().unwrap();
    assert!(token > before);
    assert_eq!(
        workspace.set_project_archived(&project.id, true).unwrap(),
        archived
    );
    assert_eq!(workspace.change_token().unwrap(), token);

    assert!(matches!(
        workspace.edit_project(&project.id, "Rename", checkout),
        Err(Error::ProjectArchived(name)) if name == "App"
    ));
    assert!(matches!(
        workspace.register_checkout(&project.id, checkout),
        Err(Error::ProjectArchived(_))
    ));
    assert!(matches!(
        workspace.remove_checkout(&project.id, checkout),
        Err(Error::ProjectArchived(_))
    ));
    let restored = workspace
        .set_trashed(&trashed.reference, false, None)
        .unwrap();
    assert_eq!(restored.project_id.as_deref(), Some(project.id.as_str()));
    assert_eq!(restored.id, trashed.id);
    assert_eq!(restored.status, trashed.status);
    assert!(!restored.trashed);
    assert_eq!(
        workspace.set_project_archived(&project.id, false).unwrap(),
        project
    );
    assert_eq!(
        workspace.set_project_archived(&project.id, false).unwrap(),
        project
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
    assert!(
        !workspace
            .replay_chat_queue_edit("send-1", &chat.id, "Run the tests", &[], &[])
            .unwrap()
    );
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
fn a_chats_first_input_text_is_read_whatever_came_after() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    assert_eq!(workspace.chat_first_input_text(&chat.id).unwrap(), None);
    workspace
        .save_chat_input(None, &chat.id, "First message\nmore")
        .unwrap();
    workspace
        .save_chat_input(None, &chat.id, "Second message")
        .unwrap();
    assert_eq!(
        workspace
            .chat_first_input_text(&chat.id)
            .unwrap()
            .as_deref(),
        Some("First message\nmore")
    );
}

#[test]
fn a_chats_first_input_text_is_the_first_saved_even_when_queued_input_is_sent_out_of_order() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let first = workspace
        .save_chat_input(None, &chat.id, "First message")
        .unwrap();
    workspace
        .save_chat_input(None, &chat.id, "First message, then more")
        .unwrap();
    // Sending the first from the queue moves it after the second in the transcript.
    workspace
        .record_chat_queue_submission(
            &chat.id,
            &first.id,
            "attempt-1",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    assert_eq!(
        workspace
            .chat_first_input_text(&chat.id)
            .unwrap()
            .as_deref(),
        Some("First message")
    );
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
                    origin: None,
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
                origin: None,
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
                    turn_id: Some("turn-1".into()),
                    owner: ticketd_core::ChatOwner::Main,
                    text: "Looking".into(),
                    complete: false,
                },
                ChatObservation::Tool {
                    tool_id: "tool-1".into(),
                    turn_id: Some("turn-1".into()),
                    owner: ChatOwner::Main,
                    name: "Bash".into(),
                    input: "cargo test".into(),
                    state: ChatToolState::Completed,
                    output: Some(format!("START{}END", "é".repeat(CHAT_TOOL_OUTPUT_LIMIT))),
                },
                ChatObservation::InteractionRequested {
                    interaction_id: "ask-1".into(),
                    turn_id: Some("turn-1".into()),
                    owner: ChatOwner::Main,
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
                    turn_id: Some("turn-1".into()),
                    owner: ticketd_core::ChatOwner::Main,
                    text: "Looking. Fixed.".into(),
                    complete: true,
                },
                ChatObservation::TurnEnded {
                    turn_id: "turn-1".into(),
                    state: ChatTurnState::Completed,
                    detail: None,
                    problem: None,
                    problem_resets_at: None,
                    ending: None,
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
            ChatItem::SubAgentRun(_) => "sub-agent run",
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
                    turn_id: Some("turn-1".into()),
                    owner: ticketd_core::ChatOwner::Main,
                    text: "Partial".into(),
                    complete: false,
                },
                ChatObservation::Tool {
                    tool_id: "tool-1".into(),
                    turn_id: Some("turn-1".into()),
                    owner: ChatOwner::Main,
                    name: "Bash".into(),
                    input: "sleep 100".into(),
                    state: ChatToolState::Running,
                    output: None,
                },
                ChatObservation::InteractionRequested {
                    interaction_id: "ask-1".into(),
                    turn_id: Some("turn-1".into()),
                    owner: ChatOwner::Main,
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
        .mark_chat_contact_lost(None, "the harness process exited", "contact_lost")
        .unwrap();
    assert_eq!(affected, vec![chat.id.clone()]);
    assert_eq!(workspace.chat(&chat.id).unwrap().active_turn, None);
    let snapshot = workspace.chat_snapshot(&chat.id, 50).unwrap();
    for item in &snapshot.items {
        match item {
            ChatItem::Turn(turn) => {
                assert_eq!(turn.state, ChatTurnState::Unknown);
                assert_eq!(turn.detail.as_deref(), Some("the harness process exited"));
                assert_eq!(turn.ending.as_deref(), Some("contact_lost"));
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
            ChatItem::Message(_)
            | ChatItem::Session(_)
            | ChatItem::Notice(_)
            | ChatItem::SubAgentRun(_) => {}
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
            .mark_chat_contact_lost(None, "again", "contact_lost")
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
                turn_id: Some("turn-1".into()),
                owner: ticketd_core::ChatOwner::Main,
                text: "Half".into(),
                complete: false,
            },
            ChatObservation::TurnEnded {
                turn_id: "no-such-turn".into(),
                state: ChatTurnState::Completed,
                detail: None,
                problem: None,
                problem_resets_at: None,
                ending: None,
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
            turn_id: Some("turn-1".into()),
            owner: ticketd_core::ChatOwner::Main,
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
                ending: None,
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
fn restore_installs_dispatchable_chat_queues_paused() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, queued) = workspace_with_chat(&dir);
    let delivered = workspace.create_chat(None, new_chat()).unwrap();
    start_turn(&mut workspace, &delivered, "Already delivered", "turn-1");
    let held = workspace.create_chat(None, new_chat()).unwrap();
    let draft = workspace
        .save_chat_input(None, &held.id, "Held input")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&held.id, &draft.id, "hold")
        .unwrap();
    let message = workspace
        .save_chat_input(None, &queued.id, "Queued")
        .unwrap();
    let backup = dir.path().join("backup.sqlite3");
    assert!(workspace.backup(&backup).unwrap());
    assert!(!workspace.chat(&queued.id).unwrap().queue_paused);

    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    assert!(restored.chat(&queued.id).unwrap().queue_paused);
    assert_eq!(restored.chat_queue(&queued.id).unwrap(), [message]);
    assert!(!restored.chat(&delivered.id).unwrap().queue_paused);
    assert!(!restored.chat(&held.id).unwrap().queue_paused);
    assert!(restored.chat_queue(&held.id).unwrap()[0].editing);
}

#[test]
fn restore_keeps_the_live_workspace_when_staging_cannot_pause_chat_queues() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace.save_chat_input(None, &chat.id, "Queued").unwrap();
    let backup = dir.path().join("backup.sqlite3");
    assert!(workspace.backup(&backup).unwrap());
    let live = workspace
        .create_ticket("Only in the live Workspace")
        .unwrap();
    drop(workspace);
    rusqlite::Connection::open(&backup)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_queue_pause BEFORE UPDATE OF queue_paused ON chats
             WHEN NEW.queue_paused = 1 BEGIN SELECT RAISE(ABORT, 'queue pause refused'); END;",
        )
        .unwrap();

    let refused = Workspace::restore(&path, &backup).unwrap_err();
    assert!(
        refused.to_string().contains("queue pause refused"),
        "{refused}"
    );
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&live.reference).unwrap(), live);
    assert!(!workspace.chat(&chat.id).unwrap().queue_paused);
}

#[test]
fn a_backup_before_held_edits_can_still_pause_its_queued_input_on_restore() {
    let dir = tempfile::tempdir().unwrap();
    let backup = dir.path().join("backup.sqlite3");
    old_chat_workspace(&backup, 101, "completed");
    rusqlite::Connection::open(&backup)
        .unwrap()
        .execute(
            "INSERT INTO chat_messages (id, chat_id, position, role, text, complete)
             VALUES ('input', 'chat-1', 2, 'user', 'Queued on an older version', 1)",
            [],
        )
        .unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    assert!(restored.chat("chat-1").unwrap().queue_paused);
    assert_eq!(
        restored.chat_queue("chat-1").unwrap()[0].text,
        "Queued on an older version"
    );
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
        workspace
            .mark_chat_contact_lost(None, "restored", "contact_lost")
            .unwrap(),
        vec![chat.id.clone()]
    );
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
}

#[test]
fn a_format_before_chat_and_its_backups_gain_chat_storage_without_losing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("old-backup.sqlite3");
    // Format 66 added Chat storage.
    ticketd_core::create_workspace_at_format_version(&path, 65).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO tickets (id, title, status, reference) VALUES ('t-1', 'Kept', 'Todo', 'T-KQ1')",
        [],
    )
    .unwrap();
    db.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap().title, "Kept");
    let chat = workspace.create_chat(None, new_chat()).unwrap();
    workspace.save_chat_input(None, &chat.id, "Hello").unwrap();
    assert_eq!(workspace.chat_queue(&chat.id).unwrap().len(), 1);
    drop(workspace);

    // A backup taken before Chat existed still restores and then migrates on open.
    Workspace::restore(&path, &backup).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-KQ1").unwrap().title, "Kept");
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
    let project = workspace
        .create_project("App", dir.path().to_str().unwrap())
        .unwrap();
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
fn withdrawing_held_input_requests_a_fresh_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let held = workspace
        .save_chat_input(None, &chat.id, "Held draft")
        .unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &held.id, "hold")
        .unwrap();
    let prior = workspace.chat_snapshot(&chat.id, 50).unwrap();
    assert!(workspace.chat_queue(&chat.id).unwrap()[0].editing);

    workspace.withdraw_chat_input(&chat.id, &held.id).unwrap();

    assert!(matches!(
        workspace
            .chat_changes(&chat.id, prior.sequence, 50)
            .unwrap(),
        ChatCatchUp::Resync
    ));
    assert!(workspace.chat_queue(&chat.id).unwrap().is_empty());
    assert!(
        !workspace
            .chat_snapshot(&chat.id, 50)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(item, ChatItem::Message(message) if message.id == held.id))
    );
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
                    origin: None,
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
                    ending: None,
                },
            ],
        )
        .unwrap();

    let affected = workspace
        .mark_chat_contact_lost(None, "ticketd was restarted", "contact_lost")
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
        workspace
            .mark_chat_contact_lost(None, "lost", "contact_lost")
            .unwrap();
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
                    ending: Some("failed".into()),
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
    assert_eq!(turn.unwrap().ending.as_deref(), Some("failed"));
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
                turn_id: Some("t1".into()),
                owner: ChatOwner::Main,
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
            ending: None,
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
                            origin: None,
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
                        .mark_chat_contact_lost(Some(&chat.id), "lost", "contact_lost")
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

#[test]
fn adjacent_turns_credit_only_their_own_tagged_writes_at_the_same_millisecond() {
    use ticketd_core::{AGENT_CHANGES_RECORD_NAME, ChatAgentChange, Status, TicketPatch};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let (mut host, chat) = workspace_with_chat(&dir);
    let ticket = host.create_ticket("Reset email").unwrap();
    let mut writer = Workspace::open(&path).unwrap();
    writer.act_for_chat(&chat.id).unwrap();

    start_turn(&mut host, &chat, "go", "first");
    writer
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    end_turn(&mut host, &chat, "first");
    let input = host.save_chat_input(None, &chat.id, "next").unwrap();
    writer
        .add_activity(&ticket.reference, "From the gap", None)
        .unwrap();
    host.record_chat_queue_submission(
        &chat.id,
        &input.id,
        "attempt-second",
        ChatSubmissionIntent::NewTurn,
    )
    .unwrap();
    writer
        .add_activity(&ticket.reference, "Before the start was observed", None)
        .unwrap();
    host.record_chat_observations(
        &chat.id,
        vec![
            ChatObservation::TurnStarted {
                turn_id: "second".into(),
                native_turn_id: None,
                origin: None,
            },
            ChatObservation::SubmissionProcessing {
                attempt_id: "attempt-second".into(),
                turn_id: "second".into(),
            },
        ],
    )
    .unwrap();
    host.mark_chat_contact_lost(Some(&chat.id), "lost", "unknown")
        .unwrap();
    writer
        .add_activity(&ticket.reference, "After contact was lost", None)
        .unwrap();
    end_turn(&mut host, &chat, "second");

    // Force an exact tie without relying on how fast these separate commits run.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "UPDATE ticket_history SET timestamp = '2026-01-01T00:00:00.000Z';
             UPDATE activities SET reported_at = '2026-01-01T00:00:00.000Z';
             UPDATE chat_submission_attempts SET recorded_at = '2026-01-01T00:00:00.000Z';
             UPDATE chat_turns SET started_at = '2026-01-01T00:00:00.000Z',
                                   ended_at = '2026-01-01T00:00:00.000Z';",
        )
        .unwrap();
    drop(writer);
    drop(host);

    let mut reopened = Workspace::open(&path).unwrap();
    let expected = [
        (
            "first",
            vec![ChatAgentChange::Status {
                reference: ticket.reference.clone(),
                title: ticket.title,
                from: "Todo".into(),
                to: "In progress".into(),
            }],
        ),
        (
            "second",
            vec![ChatAgentChange::Update {
                reference: ticket.reference,
                excerpt: "Before the start was observed".into(),
            }],
        ),
    ];
    for (turn, changes) in &expected {
        assert_eq!(
            &reopened.chat_turn_agent_changes(&chat.id, turn).unwrap(),
            changes
        );
        reopened
            .record_chat_observations(
                &chat.id,
                vec![ChatObservation::CaptureAgentChanges {
                    turn_id: (*turn).into(),
                }],
            )
            .unwrap();
    }
    let before_trim = reopened.chat_change_sequence().unwrap();
    reopened
        .record_chat_observations(
            &chat.id,
            (0..CHAT_CHANGE_TAIL)
                .map(|i| ChatObservation::Notice {
                    notice_id: format!("notice-{i}"),
                    text: "line".into(),
                    from_harness: true,
                })
                .collect(),
        )
        .unwrap();
    assert_eq!(
        reopened
            .chat_changes(&chat.id, before_trim - 1, 10)
            .unwrap(),
        ChatCatchUp::Resync
    );
    let saved = reopened
        .chat_history(&chat.id, before_trim + 1, 20)
        .unwrap();
    let backup = dir.path().join("copy.sqlite3");
    reopened.backup(&backup).unwrap();
    let check = reopened.inspect_backup(&backup).unwrap().check;
    assert!(
        matches!(
            check,
            ticketd_core::BackupCheck::Valid { format_version, .. }
                if i64::from(format_version) == ticketd_core::FORMAT_VERSION
        ),
        "receipt was written to an incompatible backup: {check:?}"
    );
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &backup).unwrap();
    let restored = Workspace::open(&restored).unwrap();
    let portable = restored.export().unwrap();
    assert!(portable.get("chat_record_writes").is_none());
    for (turn, changes) in expected {
        assert_eq!(
            restored.chat_turn_agent_changes(&chat.id, turn).unwrap(),
            changes
        );
        let input = saved
            .items
            .iter()
            .find_map(|item| match item {
                ChatItem::Tool(tool)
                    if tool.turn_id.as_deref() == Some(turn)
                        && tool.name == AGENT_CHANGES_RECORD_NAME =>
                {
                    Some(&tool.input)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<ChatAgentChange>>(input).unwrap(),
            changes
        );
        assert!(
            portable["chat_tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| {
                    tool["turn_id"] == turn
                        && tool["name"] == AGENT_CHANGES_RECORD_NAME
                        && tool["input"] == *input
                })
        );
    }
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
                ending: None,
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
    // Format 69 added the tool call an approval was asked for.
    old_chat_workspace(&path, 68, "active");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO chat_interactions (id, chat_id, position, turn_id, kind, prompt, state) \
         VALUES ('ask-1', 'chat-1', 1, 'turn-1', 'approval', 'npm install', 'pending')",
        [],
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();
    let items = workspace.chat_snapshot("chat-1", 50).unwrap().items;
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
    // Format 67 added what the person has seen of each Chat.
    old_chat_workspace(&path, 66, "completed");

    let workspace = Workspace::open(&path).unwrap();
    let chat = workspace.chat("chat-1").unwrap();
    let upgraded = workspace.chat(&chat.id).unwrap();
    assert!(!upgraded.unseen(&last_turn(&workspace, &chat)));
    assert!(!upgraded.muted);
}

/// Format 83 adds the column that records how a turn ended; turns recorded before it keep
/// everything else and have no ending.
#[test]
fn a_format_82_workspace_gains_the_turn_ending_column_and_keeps_its_turns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    old_chat_workspace(&path, 82, "completed");

    let workspace = Workspace::open(&path).unwrap();

    let chat = workspace.chat("chat-1").unwrap();
    let turn = last_turn(&workspace, &chat);
    assert_eq!(turn.state, ChatTurnState::Completed);
    assert_eq!(turn.ending, None);
}

#[test]
fn attachment_preview_format_102_keeps_held_files_and_gains_document_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    old_chat_workspace(&path, 102, "completed");
    let db = rusqlite::Connection::open(&path).unwrap();
    // Preview 102 had held edits and attachment snapshots, before the summary column.
    db.execute_batch(
        "ALTER TABLE documents DROP COLUMN summary;
         ALTER TABLE chat_messages ADD COLUMN editing INTEGER NOT NULL DEFAULT 0;
         INSERT INTO chat_messages (id, chat_id, position, role, text, complete, editing)
         VALUES ('input', 'chat-1', 2, 'user', 'original text', 1, 1);
         INSERT INTO chat_attachments (id, message_id, position, name, media_type, bytes)
         VALUES ('file', 'input', 0, 'notes.txt', 'text/plain', x'616263');",
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();
    let queue = workspace.chat_queue("chat-1").unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].text, "original text");
    assert!(queue[0].editing);
    assert!(!queue[0].requires_link_context);
    let files = workspace
        .chat_message_attachment_contents("chat-1", "input")
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].bytes(), b"abc");
    let db = rusqlite::Connection::open(&path).unwrap();
    let summaries: i64 = db
        .query_row(
            "SELECT count(*) FROM pragma_table_info('documents') WHERE name = 'summary'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(summaries, 1);
}

#[test]
fn a_format_85_workspace_keeps_legacy_attribution_and_its_first_turn_end() {
    use ticketd_core::ChatAgentChange;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    old_chat_workspace(&path, 85, "unknown");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "INSERT INTO tickets (id, title, status, reference) VALUES ('ticket', 'Kept', 'Todo', 'T-KQ1');
         UPDATE chat_turns SET position = 3, started_at = '2026-01-01T00:00:00.002Z',
                               ended_at = '2026-01-01T00:00:00.003Z' WHERE id = 'turn-1';
         INSERT INTO chat_changes (chat_id, kind, subject_id)
         VALUES ('chat-1', 'message', 'input'), ('chat-1', 'message', 'input'),
                ('chat-1', 'turn', 'turn-1'), ('chat-1', 'turn', 'turn-1');
         INSERT INTO chat_messages (id, chat_id, position, role, text, complete)
         VALUES ('input', 'chat-1', 1, 'user', 'go', 1);
         INSERT INTO chat_submission_attempts (id, chat_id, message_id, intent, delivery, turn_id, recorded_at)
         VALUES ('attempt', 'chat-1', 'input', 'new_turn', 'acknowledged', 'turn-1', '2026-01-01T00:00:00.000Z');
         INSERT INTO activities (id, ticket_id, brief, reported_at)
         VALUES ('activity', 'ticket', 'Before the observed start', '2026-01-01T00:00:00.001Z');
         INSERT INTO chat_record_writes (chat_id, activity_id) VALUES ('chat-1', 'activity');",
    )
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.chat("chat-1").unwrap();
    workspace.act_for_chat(&chat.id).unwrap();
    let after_old_end = workspace
        .add_activity("T-KQ1", "After the old Turn ended", None)
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, ticketd_core::FORMAT_VERSION);
    // The first end predates the newer attribution rows, even if the timestamps tie.
    db.execute(
        "UPDATE activities SET reported_at = '2026-01-01T00:00:00.003Z' WHERE id = ?1",
        [&after_old_end.id],
    )
    .unwrap();
    end_turn(&mut workspace, &chat, "turn-1");

    assert_eq!(
        workspace
            .chat_turn_agent_changes(&chat.id, "turn-1")
            .unwrap(),
        [ChatAgentChange::Update {
            reference: "T-KQ1".into(),
            excerpt: "Before the observed start".into(),
        }]
    );
}

#[test]
fn the_chats_written_since_a_sequence_are_named_with_their_latest_change() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, quiet) = workspace_with_chat(&dir);
    let busy = workspace.create_chat(None, new_chat()).unwrap();
    start_turn(&mut workspace, &busy, "Go", "turn-1");
    let since = workspace.chat_change_sequence().unwrap();
    assert_eq!(workspace.chats_changed_since(since).unwrap(), Vec::new());

    workspace
        .record_chat_observations(
            &busy.id,
            vec![ChatObservation::Tool {
                tool_id: "tool-1".into(),
                turn_id: Some("turn-1".into()),
                owner: ChatOwner::Main,
                name: "Bash".into(),
                input: "cargo test".into(),
                state: ChatToolState::Completed,
                output: Some("line 1\nline 2\n".into()),
            }],
        )
        .unwrap();
    let head = workspace.chat_change_sequence().unwrap();
    assert_eq!(
        workspace.chats_changed_since(since).unwrap(),
        vec![(busy.id.clone(), head)]
    );
    assert_ne!(quiet.id, busy.id);
    // One step's output is read on its own, in full.
    assert_eq!(
        workspace
            .chat_tool_output(&busy.id, "tool-1")
            .unwrap()
            .as_deref(),
        Some("line 1\nline 2\n")
    );
    assert_eq!(
        workspace.chat_tool_output(&quiet.id, "tool-1").unwrap(),
        None
    );
}

fn sub_agent() -> ChatOwner {
    ChatOwner::SubAgent {
        native_id: "agent-1".into(),
    }
}

/// A Step and an approval of a sub-agent, recorded while no turn is active.
#[allow(clippy::unwrap_used)]
fn record_turnless_sub_agent_work(workspace: &mut Workspace, chat: &Chat) {
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::Tool {
                    tool_id: "sub-tool".into(),
                    turn_id: None,
                    owner: sub_agent(),
                    name: "Bash".into(),
                    input: "cargo test".into(),
                    state: ChatToolState::Running,
                    output: None,
                },
                ChatObservation::InteractionRequested {
                    interaction_id: "sub-ask".into(),
                    turn_id: None,
                    owner: sub_agent(),
                    kind: ChatInteractionKind::Approval,
                    native_request_id: Some("req-sub".into()),
                    prompt: "Allow Bash?".into(),
                    reason: None,
                    tool_id: Some("sub-tool".into()),
                },
            ],
        )
        .unwrap();
}

#[allow(clippy::unwrap_used)]
fn steps_and_approvals(
    workspace: &Workspace,
    chat: &Chat,
) -> (
    Vec<ticketd_core::ChatTool>,
    Vec<ticketd_core::ChatInteraction>,
) {
    let items = workspace.chat_snapshot(&chat.id, 500).unwrap().items;
    let tools = items
        .iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) => Some(tool.clone()),
            _ => None,
        })
        .collect();
    let asks = items
        .iter()
        .filter_map(|item| match item {
            ChatItem::Interaction(ask) => Some(ask.clone()),
            _ => None,
        })
        .collect();
    (tools, asks)
}

#[test]
fn a_sub_agents_step_and_approval_need_no_turn_and_keep_their_owner() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    // The main agent's records are owned by it and keep their turn, as before.
    start_turn(&mut workspace, &chat, "First", "turn-1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::Tool {
                tool_id: "main-tool".into(),
                turn_id: Some("turn-1".into()),
                owner: ChatOwner::Main,
                name: "Read".into(),
                input: "src/lib.rs".into(),
                state: ChatToolState::Completed,
                output: None,
            }],
        )
        .unwrap();
    record_turnless_sub_agent_work(&mut workspace, &chat);

    let (tools, asks) = steps_and_approvals(&workspace, &chat);
    let main = tools.iter().find(|tool| tool.id == "main-tool").unwrap();
    assert_eq!(
        (main.turn_id.as_deref(), &main.owner),
        (Some("turn-1"), &ChatOwner::Main)
    );
    let sub = tools.iter().find(|tool| tool.id == "sub-tool").unwrap();
    assert_eq!((sub.turn_id.as_deref(), &sub.owner), (None, &sub_agent()));
    assert_eq!(
        (asks[0].turn_id.as_deref(), &asks[0].owner),
        (None, &sub_agent())
    );

    // Repeating an observation leaves the record, owner included, as it was.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::Tool {
                tool_id: "sub-tool".into(),
                turn_id: Some("turn-1".into()),
                owner: ChatOwner::Main,
                name: "Bash".into(),
                input: "cargo test".into(),
                state: ChatToolState::Completed,
                output: Some("ok".into()),
            }],
        )
        .unwrap();
    let (tools, _) = steps_and_approvals(&workspace, &chat);
    let sub = tools.iter().find(|tool| tool.id == "sub-tool").unwrap();
    assert_eq!(
        (sub.state, sub.turn_id.as_deref(), &sub.owner),
        (ChatToolState::Completed, None, &sub_agent())
    );

    // A turn that is named must still be this Chat's.
    assert!(matches!(
        workspace.record_chat_observations(
            &chat.id,
            vec![ChatObservation::Tool {
                tool_id: "stray".into(),
                turn_id: Some("nope".into()),
                owner: ChatOwner::Main,
                name: "Bash".into(),
                input: String::new(),
                state: ChatToolState::Running,
                output: None,
            }],
        ),
        Err(Error::Chat(_))
    ));
}

#[test]
fn history_pages_include_turnless_records() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "First", "turn-1");
    end_turn(&mut workspace, &chat, "turn-1");
    record_turnless_sub_agent_work(&mut workspace, &chat);

    let snapshot = workspace.chat_snapshot(&chat.id, 500).unwrap();
    let last = snapshot.items.len();
    let positions: Vec<i64> = snapshot
        .items
        .iter()
        .map(|item| match item {
            ChatItem::Session(item) => item.position,
            ChatItem::Message(item) => item.position,
            ChatItem::Turn(item) => item.position,
            ChatItem::Tool(item) => item.position,
            ChatItem::Interaction(item) => item.position,
            ChatItem::Notice(item) => item.position,
            ChatItem::SubAgentRun(item) => item.position,
        })
        .collect();
    let newest = *positions.iter().max().unwrap();
    // Page two items back from the newest; the turnless pair is what lies after.
    let page = workspace
        .chat_history(&chat.id, newest + 1, last - 1)
        .unwrap();
    let ids: Vec<&str> = page
        .items
        .iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) => Some(tool.id.as_str()),
            ChatItem::Interaction(ask) => Some(ask.id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["sub-tool", "sub-ask"]);
    let older = workspace.chat_history(&chat.id, newest - 1, 1).unwrap();
    assert_eq!(older.items.len(), 1);
}

#[test]
fn losing_contact_ends_turnless_work_and_it_outlives_a_turns_end() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "First", "turn-1");
    record_turnless_sub_agent_work(&mut workspace, &chat);
    // A turn ending does not touch what no turn owns.
    end_turn(&mut workspace, &chat, "turn-1");
    let (tools, asks) = steps_and_approvals(&workspace, &chat);
    assert_eq!(tools[0].state, ChatToolState::Running);
    assert_eq!(asks[0].state, ChatInteractionState::Pending);

    // With no active turn, the running Step and open request still count as live work.
    assert_eq!(
        workspace
            .mark_chat_contact_lost(None, "the harness process exited", "contact_lost")
            .unwrap(),
        vec![chat.id.clone()]
    );
    let (tools, asks) = steps_and_approvals(&workspace, &chat);
    assert_eq!(tools[0].state, ChatToolState::Unknown);
    assert_eq!(asks[0].state, ChatInteractionState::Expired);
}

#[test]
fn the_owner_and_the_missing_turn_are_exported_and_survive_backup_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.create_chat(None, new_chat()).unwrap();
    start_turn(&mut workspace, &chat, "First", "turn-1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::Tool {
                tool_id: "main-tool".into(),
                turn_id: Some("turn-1".into()),
                owner: ChatOwner::Main,
                name: "Read".into(),
                input: "src/lib.rs".into(),
                state: ChatToolState::Completed,
                output: None,
            }],
        )
        .unwrap();
    record_turnless_sub_agent_work(&mut workspace, &chat);

    let export = workspace.export().unwrap();
    let row = |table: &str, id: &str| {
        export[table]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap()
            .clone()
    };
    let sub_tool = row("chat_tools", "sub-tool");
    assert_eq!(sub_tool["sub_agent_id"], "agent-1");
    assert!(sub_tool["turn_id"].is_null());
    let sub_ask = row("chat_interactions", "sub-ask");
    assert_eq!(sub_ask["sub_agent_id"], "agent-1");
    assert!(sub_ask["turn_id"].is_null());
    let main_tool = row("chat_tools", "main-tool");
    assert!(main_tool["sub_agent_id"].is_null());
    assert_eq!(main_tool["turn_id"], "turn-1");

    let saved = workspace.chat_snapshot(&chat.id, 500).unwrap();
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(&restored_path).unwrap();
    assert_eq!(restored.chat_snapshot(&chat.id, 500).unwrap(), saved);
}

#[test]
fn upgrading_from_format_104_makes_existing_steps_and_approvals_main_agent_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    old_chat_workspace(&path, 104, "completed");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "INSERT INTO chat_tools (id, chat_id, position, turn_id, name, input, state) \
             VALUES ('tool-1', 'chat-1', 2, 'turn-1', 'Bash', 'ls', 'completed');
         INSERT INTO chat_interactions (id, chat_id, position, turn_id, kind, prompt, state) \
             VALUES ('ask-1', 'chat-1', 3, 'turn-1', 'approval', 'Allow ls?', 'answered');",
    )
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.chat("chat-1").unwrap();
    let (tools, asks) = steps_and_approvals(&workspace, &chat);
    assert_eq!(
        (tools[0].turn_id.as_deref(), &tools[0].owner),
        (Some("turn-1"), &ChatOwner::Main)
    );
    assert_eq!(
        (asks[0].turn_id.as_deref(), &asks[0].owner),
        (Some("turn-1"), &ChatOwner::Main)
    );
    // The upgraded tables take turnless records.
    record_turnless_sub_agent_work(&mut workspace, &chat);
    let (tools, _) = steps_and_approvals(&workspace, &chat);
    assert_eq!(tools.len(), 2);
}

// --- Sub-agents ---------------------------------------------------------------------

fn start_sub_agent(native_id: &str, run: Option<&str>, turn: Option<&str>) -> ChatObservation {
    ChatObservation::SubAgentStarted {
        native_id: native_id.into(),
        parent: None,
        tool_id: Some("tool-agent".into()),
        turn_id: turn.map(str::to_owned),
        native_run_id: run.map(str::to_owned),
        background: false,
        payload: r#"{"description":"Find limiter bypasses","subagent_type":"Explore"}"#.into(),
    }
}

fn end_sub_agent(native_id: &str, run: Option<&str>, state: ChatSubAgentState) -> ChatObservation {
    ChatObservation::SubAgentEnded {
        native_id: native_id.into(),
        native_run_id: run.map(str::to_owned),
        state,
        stopped_by: None,
        stop_reason: None,
        detail: None,
    }
}

#[allow(clippy::unwrap_used)]
fn sub_agents(workspace: &Workspace, chat: &Chat) -> Vec<ChatSubAgent> {
    workspace.chat_snapshot(&chat.id, 500).unwrap().sub_agents
}

#[allow(clippy::unwrap_used)]
fn run_rows(workspace: &Workspace, chat: &Chat) -> Vec<ChatSubAgentRun> {
    workspace
        .chat_snapshot(&chat.id, 500)
        .unwrap()
        .items
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::SubAgentRun(run) => Some(run),
            _ => None,
        })
        .collect()
}

#[test]
fn a_sub_agent_is_one_record_per_chat_and_native_id_with_its_parent_and_starting_step() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "Review it", "turn-1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("agent-1", Some("run-a"), Some("turn-1")),
                ChatObservation::SubAgentStarted {
                    native_id: "agent-2".into(),
                    parent: Some("agent-1".into()),
                    tool_id: Some("tool-nested".into()),
                    turn_id: Some("turn-1".into()),
                    native_run_id: None,
                    background: true,
                    payload: r#"{"description":"Check the tests"}"#.into(),
                },
                // The same start again changes nothing.
                start_sub_agent("agent-1", Some("run-a"), Some("turn-1")),
            ],
        )
        .unwrap();
    let records = sub_agents(&workspace, &chat);
    assert_eq!(records.len(), 2);
    let first = &records[0];
    assert_eq!(first.native_id, "agent-1");
    assert_eq!(first.parent, None);
    assert_eq!(first.tool_id.as_deref(), Some("tool-agent"));
    assert_eq!(
        first.said("description").as_deref(),
        Some("Find limiter bypasses")
    );
    assert_eq!(first.said("subagent_type").as_deref(), Some("Explore"));
    assert!(!first.background);
    assert_eq!(first.runs.len(), 1);
    assert_eq!(
        first.latest().map(|run| run.state),
        Some(ChatSubAgentState::Running)
    );
    assert_eq!(
        first.latest().and_then(|run| run.turn_id.as_deref()),
        Some("turn-1")
    );
    let nested = &records[1];
    assert_eq!(nested.parent.as_deref(), Some("agent-1"));
    assert!(nested.background);
    // Each run is a row of the Chat's history, in the order they began.
    let rows = run_rows(&workspace, &chat);
    assert_eq!(
        rows.iter()
            .map(|run| run.sub_agent.as_str())
            .collect::<Vec<_>>(),
        ["agent-1", "agent-2"]
    );
    assert!(rows[0].position < rows[1].position);
}

#[test]
fn a_resumed_sub_agent_adds_a_run_and_a_late_frame_of_the_earlier_run_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("agent-1", Some("run-a"), None),
                end_sub_agent("agent-1", Some("run-a"), ChatSubAgentState::Completed),
                start_sub_agent("agent-1", Some("run-b"), None),
            ],
        )
        .unwrap();
    let record = &sub_agents(&workspace, &chat)[0];
    assert_eq!(
        record
            .runs
            .iter()
            .map(|run| (run.run, run.state))
            .collect::<Vec<_>>(),
        [
            (1, ChatSubAgentState::Completed),
            (2, ChatSubAgentState::Running)
        ]
    );
    // The notification of run a arrives again, late: run b is not ended by it.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![end_sub_agent(
                "agent-1",
                Some("run-a"),
                ChatSubAgentState::Failed,
            )],
        )
        .unwrap();
    let record = &sub_agents(&workspace, &chat)[0];
    assert_eq!(
        record.latest().map(|run| run.state),
        Some(ChatSubAgentState::Running)
    );
    assert_eq!(record.runs[0].state, ChatSubAgentState::Completed);
    assert_eq!(run_rows(&workspace, &chat).len(), 2);
}

// --- Restart: sub-agents lost, and the note the next message carries ---------------------

#[test]
fn contact_lost_in_a_chat_where_no_turn_ran_loses_its_running_sub_agents_and_holds_a_notice() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    // A background sub-agent from an earlier session, a finished one, and one running now:
    // no turn is active, none ever had a Step running.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("done", Some("run-a"), None),
                end_sub_agent("done", Some("run-a"), ChatSubAgentState::Completed),
                start_sub_agent("agent-1", Some("run-b"), None),
                start_sub_agent("agent-2", Some("run-c"), None),
            ],
        )
        .unwrap();
    assert!(workspace.chat_restart_notice(&chat.id).unwrap().is_empty());

    let lost = workspace
        .mark_chat_contact_lost(None, "ticketd was restarted", "contact_lost")
        .unwrap();
    assert_eq!(lost, std::slice::from_ref(&chat.id));

    let states: Vec<_> = sub_agents(&workspace, &chat)
        .iter()
        .map(|record| (record.native_id.clone(), record.latest().unwrap().state))
        .collect();
    assert_eq!(
        states,
        [
            ("done".to_owned(), ChatSubAgentState::Completed),
            ("agent-1".to_owned(), ChatSubAgentState::Lost),
            ("agent-2".to_owned(), ChatSubAgentState::Lost),
        ]
    );
    // The Chat holds a notice naming the two lost ones, in the view's data and by the reader.
    let snapshot = workspace.chat_snapshot(&chat.id, 500).unwrap();
    assert_eq!(snapshot.chat.restart_notice, ["agent-1", "agent-2"]);
    let told: Vec<_> = workspace
        .chat_restart_notice(&chat.id)
        .unwrap()
        .into_iter()
        .map(|record| record.native_id)
        .collect();
    assert_eq!(told, ["agent-1", "agent-2"]);

    // Nothing running was lost the second time: the notice stays as it was.
    workspace
        .mark_chat_contact_lost(None, "again", "contact_lost")
        .unwrap();
    assert_eq!(
        workspace
            .chat_snapshot(&chat.id, 500)
            .unwrap()
            .chat
            .restart_notice,
        ["agent-1", "agent-2"]
    );
}

#[test]
fn a_lost_sub_agent_the_main_agent_resumes_leaves_the_notice_as_a_new_run() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("agent-1", Some("run-a"), None),
                start_sub_agent("agent-2", Some("run-b"), None),
            ],
        )
        .unwrap();
    workspace
        .mark_chat_contact_lost(None, "quit", "contact_lost")
        .unwrap();
    // Claude resumes agent-1 by itself before the person writes: a second run.
    workspace
        .record_chat_observations(
            &chat.id,
            vec![start_sub_agent("agent-1", Some("run-d"), None)],
        )
        .unwrap();
    let records = sub_agents(&workspace, &chat);
    assert_eq!(
        records[0]
            .runs
            .iter()
            .map(|run| run.state)
            .collect::<Vec<_>>(),
        [ChatSubAgentState::Lost, ChatSubAgentState::Running]
    );
    let told: Vec<_> = workspace
        .chat_restart_notice(&chat.id)
        .unwrap()
        .into_iter()
        .map(|record| record.native_id)
        .collect();
    assert_eq!(told, ["agent-2"], "only what is still lost is told");
    assert_eq!(
        workspace
            .chat_snapshot(&chat.id, 500)
            .unwrap()
            .chat
            .restart_notice,
        ["agent-2"]
    );
}

#[test]
fn the_note_is_stored_on_the_message_that_carries_it_and_clears_the_notice() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace
        .record_chat_observations(&chat.id, vec![start_sub_agent("agent-1", None, None)])
        .unwrap();
    workspace
        .mark_chat_contact_lost(None, "quit", "contact_lost")
        .unwrap();
    let input = workspace
        .save_chat_input(None, &chat.id, "Pick the review back up")
        .unwrap();
    let note = ticketd_core::ChatMessageNote {
        kind: ticketd_core::ChatMessageNoteKind::LostSubAgents,
        sub_agents: vec!["agent-1".into()],
        text: "From ticketd: this sub-agent was lost.".into(),
    };
    let since = workspace.chat_change_sequence().unwrap();
    workspace
        .record_chat_message_note(&chat.id, &input.id, &note)
        .unwrap();

    assert_eq!(
        message(&workspace, &chat, &input.id).note,
        Some(note.clone())
    );
    let snapshot = workspace.chat_snapshot(&chat.id, 500).unwrap();
    assert!(snapshot.chat.restart_notice.is_empty());
    assert!(workspace.chat_restart_notice(&chat.id).unwrap().is_empty());
    // The sub-agent itself is still lost; only the telling is done.
    assert_eq!(
        sub_agents(&workspace, &chat)[0].latest().unwrap().state,
        ChatSubAgentState::Lost
    );
    // A follower learns of both: the Chat (its notice) and the message (its note).
    let ChatCatchUp::Changes { changes, .. } =
        workspace.chat_changes(&chat.id, since, 100).unwrap()
    else {
        panic!("expected changes");
    };
    assert!(changes.iter().any(
        |change| matches!(&change.record, ChatRecord::Chat(chat) if chat.restart_notice.is_empty())
    ));
    assert!(changes.iter().any(|change| matches!(
        &change.record,
        ChatRecord::Item(ChatItem::Message(message)) if message.note == Some(note.clone())
    )));

    // A message that is not there is refused.
    assert!(
        workspace
            .record_chat_message_note(&chat.id, "no-such-message", &note)
            .is_err()
    );
}

#[test]
fn a_resumed_run_keeps_the_step_that_resumed_it_and_the_first_run_leaves_it_to_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let resume = |run: &str, tool: &str| ChatObservation::SubAgentStarted {
        native_id: "agent-1".into(),
        parent: None,
        tool_id: Some(tool.into()),
        turn_id: None,
        native_run_id: Some(run.into()),
        background: true,
        payload: "{}".into(),
    };
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                resume("run-a", "tool-agent"),
                end_sub_agent("agent-1", Some("run-a"), ChatSubAgentState::Completed),
                resume("run-b", "tool-send"),
            ],
        )
        .unwrap();
    let record = &sub_agents(&workspace, &chat)[0];
    assert_eq!(record.tool_id.as_deref(), Some("tool-agent"));
    assert_eq!(
        record
            .runs
            .iter()
            .map(|run| run.tool_id.as_deref())
            .collect::<Vec<_>>(),
        [None, Some("tool-send")]
    );
}

#[test]
fn a_resume_keeps_what_the_sub_agent_was_first_asked() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let started = |run: &str, prompt: &str| ChatObservation::SubAgentStarted {
        native_id: "agent-1".into(),
        parent: None,
        tool_id: None,
        turn_id: None,
        native_run_id: Some(run.into()),
        background: true,
        payload: format!(r#"{{"description":"Find limiter bypasses","prompt":"{prompt}"}}"#),
    };
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                started("run-a", "Find every way around the limiter."),
                end_sub_agent("agent-1", Some("run-a"), ChatSubAgentState::Completed),
                started("run-b", "Also check retries."),
            ],
        )
        .unwrap();
    let record = &sub_agents(&workspace, &chat)[0];
    assert_eq!(
        record.said("prompt").as_deref(),
        Some("Find every way around the limiter.")
    );
    assert_eq!(
        record.said("description").as_deref(),
        Some("Find limiter bypasses")
    );
}

#[test]
fn a_stopped_run_records_who_stopped_it_and_an_ended_run_stays_ended() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("agent-1", Some("run-a"), None),
                ChatObservation::SubAgentEnded {
                    native_id: "agent-1".into(),
                    native_run_id: Some("run-a".into()),
                    state: ChatSubAgentState::Stopped,
                    stopped_by: Some(ChatSubAgentStopper::MainAgent),
                    stop_reason: Some("ignored for the main agent".into()),
                    detail: Some("ignored for a stopped run".into()),
                },
                end_sub_agent("agent-1", Some("run-a"), ChatSubAgentState::Completed),
            ],
        )
        .unwrap();
    let run = &sub_agents(&workspace, &chat)[0].runs[0];
    assert_eq!(run.state, ChatSubAgentState::Stopped);
    assert_eq!(run.stopped_by, Some(ChatSubAgentStopper::MainAgent));
    assert!(run.ended_at.is_some());
    // A run cannot end as running.
    assert!(
        workspace
            .record_chat_observations(
                &chat.id,
                vec![end_sub_agent("agent-1", None, ChatSubAgentState::Running)],
            )
            .is_err()
    );
}

#[test]
fn the_foreground_runs_of_a_turn_end_with_it_and_a_background_run_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    start_turn(&mut workspace, &chat, "Review it", "turn-1");
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                start_sub_agent("fore", Some("run-a"), Some("turn-1")),
                ChatObservation::SubAgentStarted {
                    native_id: "back".into(),
                    parent: None,
                    tool_id: None,
                    turn_id: Some("turn-1".into()),
                    native_run_id: Some("run-b".into()),
                    background: true,
                    payload: "{}".into(),
                },
                ChatObservation::TurnEnded {
                    turn_id: "turn-1".into(),
                    state: ChatTurnState::Interrupted,
                    detail: None,
                    problem: None,
                    problem_resets_at: None,
                    ending: Some("stopped_by_ticketd:turned_off".into()),
                },
            ],
        )
        .unwrap();
    let records = sub_agents(&workspace, &chat);
    let fore = records[0].latest().unwrap();
    assert_eq!(
        (fore.state, fore.stopped_by, fore.stop_reason.as_deref()),
        (
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::Ticketd),
            Some("turned_off")
        )
    );
    assert_eq!(
        records[1].latest().unwrap().state,
        ChatSubAgentState::Running
    );

    // Contact lost: nothing says whether the background one still runs.
    workspace
        .mark_chat_contact_lost(Some(&chat.id), "ticketd quit", "contact_lost")
        .unwrap();
    assert_eq!(
        sub_agents(&workspace, &chat)[1].latest().unwrap().state,
        ChatSubAgentState::Lost
    );
}

#[test]
fn a_sub_agents_change_reaches_a_follower_as_its_record_and_its_run() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    let since = workspace.chat_change_sequence().unwrap();
    workspace
        .record_chat_observations(
            &chat.id,
            vec![start_sub_agent("agent-1", Some("run-a"), None)],
        )
        .unwrap();
    let ticketd_core::ChatCatchUp::Changes { changes, .. } =
        workspace.chat_changes(&chat.id, since, 100).unwrap()
    else {
        panic!("expected changes");
    };
    let kinds: Vec<&str> = changes
        .iter()
        .map(|change| match &change.record {
            ChatRecord::SubAgent(_) => "record",
            ChatRecord::Item(ChatItem::SubAgentRun(_)) => "run",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["record", "run"]);
}

#[test]
fn upgrading_from_format_104_gives_a_chat_no_sub_agents_and_the_tables_take_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    old_chat_workspace(&path, 104, "completed");
    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.chat("chat-1").unwrap();
    assert!(sub_agents(&workspace, &chat).is_empty());
    workspace
        .record_chat_observations(
            &chat.id,
            vec![start_sub_agent("agent-1", None, Some("turn-1"))],
        )
        .unwrap();
    assert_eq!(sub_agents(&workspace, &chat).len(), 1);
}

#[test]
fn a_turn_the_harness_started_says_so_and_a_stop_of_sub_agents_with_no_turn_is_counted() {
    let dir = tempfile::tempdir().unwrap();
    let (mut workspace, chat) = workspace_with_chat(&dir);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::SubAgentStarted {
                    native_id: "task_a".into(),
                    parent: None,
                    tool_id: None,
                    turn_id: None,
                    native_run_id: None,
                    background: true,
                    payload: "{}".into(),
                },
                ChatObservation::TurnStarted {
                    turn_id: "turn-1".into(),
                    native_turn_id: Some("local-turn-1".into()),
                    origin: Some(ticketd_core::ChatTurnOrigin {
                        by: ticketd_core::ChatTurnStarter::Harness,
                        sub_agent: Some("task_a".into()),
                    }),
                },
                ChatObservation::SubAgentsStopped {
                    notice_id: "stopped-1".into(),
                    count: 2,
                },
            ],
        )
        .unwrap();
    let snapshot = workspace.chat_snapshot(&chat.id, 100).unwrap();
    let turn = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ChatItem::Turn(turn) => Some(turn),
            _ => None,
        })
        .expect("the turn");
    let origin = turn.origin.as_ref().expect("labelled");
    assert_eq!(origin.by, ticketd_core::ChatTurnStarter::Harness);
    assert_eq!(origin.sub_agent.as_deref(), Some("task_a"));
    let notice = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ChatItem::Notice(notice) => Some(notice),
            _ => None,
        })
        .expect("the note");
    assert_eq!(notice.sub_agents_stopped, Some(2));
    assert_eq!(notice.text, "You stopped 2 sub-agents.");
    assert!(!notice.from_harness);
}

#[test]
fn a_sub_agents_message_has_its_owner_and_may_have_no_turn_and_is_exported_and_backed_up() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let chat = workspace.create_chat(None, new_chat()).unwrap();
    start_turn(&mut workspace, &chat, "First", "turn-1");
    let said = |id: &str, turn: Option<&str>, owner: ChatOwner, text: &str| {
        ChatObservation::AssistantText {
            message_id: id.into(),
            turn_id: turn.map(str::to_owned),
            owner,
            text: text.into(),
            complete: true,
        }
    };
    let agent = || ChatOwner::SubAgent {
        native_id: "agent-1".into(),
    };
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                said("main-said", Some("turn-1"), ChatOwner::Main, "Reply"),
                said("sub-said", Some("turn-1"), agent(), "Looking"),
            ],
        )
        .unwrap();
    end_turn(&mut workspace, &chat, "turn-1");
    // After the turn: nothing owns it but the sub-agent.
    workspace
        .record_chat_observations(&chat.id, vec![said("sub-late", None, agent(), "Done")])
        .unwrap();

    let of = |workspace: &Workspace, id: &str| message(workspace, &chat, id);
    assert_eq!(of(&workspace, "main-said").owner, ChatOwner::Main);
    assert_eq!(of(&workspace, "sub-said").owner, agent());
    let late = of(&workspace, "sub-late");
    assert_eq!((late.owner, late.turn_id), (agent(), None));

    let export = workspace.export().unwrap();
    let row = |id: &str| {
        export["chat_messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(row("sub-said")["sub_agent_id"], "agent-1");
    assert!(row("main-said")["sub_agent_id"].is_null());
    assert!(row("sub-late")["turn_id"].is_null());

    let saved = workspace.chat_snapshot(&chat.id, 500).unwrap();
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(&restored_path).unwrap();
    assert_eq!(restored.chat_snapshot(&chat.id, 500).unwrap(), saved);
}
