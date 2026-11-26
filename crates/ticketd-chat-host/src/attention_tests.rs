use super::*;
use crate::turn_ending::recorded_turn;
use crate::{LiveInteraction, ProblemKind, StopReason};

fn idle() -> ChatLive {
    ChatLive::idle()
}

fn chat(seen_through: i64) -> Chat {
    Chat {
        id: "c".to_owned(),
        title: None,
        harness: "codex".to_owned(),
        execution_folder: "/work".to_owned(),
        folder_managed: false,
        archived: false,
        trashed: false,
        queue_paused: false,
        effective_settings: None,
        native_session_id: None,
        links: Vec::new(),
        active_turn: None,
        seen_through,
        read_through: None,
        marked_unread: false,
        muted: false,
        created_at: String::new(),
    }
}

fn turn(position: i64, ending: TurnEnding) -> ChatTurn {
    recorded_turn(position, &ending)
}

fn failed() -> TurnEnding {
    TurnEnding::Failed {
        kind: ProblemKind::Other,
        message: None,
        resets_at: None,
    }
}

fn facts<'a>(chat: &'a Chat, live: &'a ChatLive, last_turn: Option<&'a ChatTurn>) -> Facts<'a> {
    Facts {
        chat,
        harness: "Codex",
        live,
        last_turn,
        uncertain: None,
        problem: None,
        failure: None,
        activity: "idle",
        opening: false,
        first_change: None,
        files_changed: None,
        last_response: Some("All **done**. See `x`."),
    }
}

/// A seen row after a finished turn: the words line two says.
fn seen_words(facts: Facts<'_>) -> String {
    let status = status(&facts);
    assert_eq!(status.rank, Rank::Idle);
    status.word
}

#[test]
fn a_seen_idle_row_says_its_last_outcome_by_priority() {
    let live = idle();
    let ended = turn(5, TurnEnding::Completed);
    let chat = chat(5);
    let change = ChatAgentChange::Status {
        reference: "T-12".to_owned(),
        title: "Demo".to_owned(),
        from: "Todo".to_owned(),
        to: "In review".to_owned(),
    };
    // A record the agent changed comes first, then the files, then the reply.
    let mut all = facts(&chat, &live, Some(&ended));
    all.first_change = Some(&change);
    all.files_changed = Some(3);
    assert_eq!(seen_words(all), "Moved T-12 to In review");
    let mut files = facts(&chat, &live, Some(&ended));
    files.files_changed = Some(3);
    assert_eq!(seen_words(files), "3 files changed");
    let mut one = facts(&chat, &live, Some(&ended));
    one.files_changed = Some(1);
    assert_eq!(seen_words(one), "1 file changed");
    // No files: the reply's first words.
    assert_eq!(
        seen_words(facts(&chat, &live, Some(&ended))),
        "All done. See x."
    );
}

fn moved(reference: &str, from: &str, to: &str) -> ChatAgentChange {
    ChatAgentChange::Status {
        reference: reference.to_owned(),
        title: "Demo".to_owned(),
        from: from.to_owned(),
        to: to.to_owned(),
    }
}

fn posted(reference: &str) -> ChatAgentChange {
    ChatAgentChange::Update {
        reference: reference.to_owned(),
        excerpt: "Done".to_owned(),
    }
}

/// The same cases as `netChanges` in `apps/desktop/src/features/chats/model.test.ts`.
#[test]
fn a_tickets_status_moves_net_into_one_move() {
    // Todo -> In progress -> In review, with an update between: the net move leads.
    assert_eq!(
        net_changes(&[
            moved("T-12", "Todo", "In progress"),
            posted("T-12"),
            moved("T-12", "In progress", "In review"),
        ]),
        [moved("T-12", "Todo", "In review"), posted("T-12")]
    );
    // A move that ends where it began is nothing.
    assert_eq!(
        net_changes(&[
            moved("T-12", "Todo", "In progress"),
            moved("T-12", "In progress", "Todo"),
            posted("T-12"),
        ]),
        [posted("T-12")]
    );
    // Each ticket nets by itself and keeps the place of its first move.
    assert_eq!(
        net_changes(&[
            moved("T-12", "Todo", "In progress"),
            moved("T-13", "Todo", "In progress"),
            moved("T-12", "In progress", "Done"),
        ]),
        [
            moved("T-12", "Todo", "Done"),
            moved("T-13", "Todo", "In progress")
        ]
    );
    // Updates are never merged.
    assert_eq!(
        net_changes(&[posted("T-12"), posted("T-12")]),
        [posted("T-12"), posted("T-12")]
    );
}

#[test]
fn an_idle_row_says_the_first_sentence_of_the_records_row() {
    let live = idle();
    let ended = turn(5, TurnEnding::Completed);
    let chat = chat(5);
    let net = net_changes(&[
        moved("T-12", "Todo", "In progress"),
        posted("T-12"),
        moved("T-12", "In progress", "In review"),
    ]);
    let mut all = facts(&chat, &live, Some(&ended));
    all.first_change = net.first();
    assert_eq!(seen_words(all), "Moved T-12 to In review");
}

#[test]
fn a_reply_is_cut_at_a_word_and_never_inside_a_link() {
    let live = idle();
    let ended = turn(5, TurnEnding::Completed);
    let chat = chat(5);
    let long = "Yes, the migration is safe to run twice because every step checks first and skips what exists";
    let mut cut = facts(&chat, &live, Some(&ended));
    cut.last_response = Some(long);
    let words = seen_words(cut);
    assert!(words.ends_with('…'), "{words}");
    assert!(words.chars().count() <= 61, "{words}");
    assert!(long.starts_with(words.trim_end_matches('…')), "{words}");
    assert!(
        !words.trim_end_matches('…').ends_with(' '),
        "no space before the ellipsis: {words}"
    );
    assert!(
        long[words.trim_end_matches('…').len()..].starts_with(' '),
        "the cut falls at a word: {words}"
    );

    let mut link = facts(&chat, &live, Some(&ended));
    link.last_response = Some("I opened the PR: https://github.com/example/repo/pull/12345");
    assert_eq!(seen_words(link), "I opened the PR…");

    let mut only = facts(&chat, &live, Some(&ended));
    only.last_response = Some("https://github.com/example/repo/pull/12345");
    assert_eq!(seen_words(only), "Done");
}

#[test]
fn an_unused_chat_never_says_idle() {
    let live = idle();
    let status = status(&Facts {
        last_response: None,
        ..facts(&chat(0), &live, None)
    });
    assert_eq!(status.word, "No messages yet");
}

#[test]
fn a_finished_turn_is_done_until_seen_then_idle_in_words() {
    let live = idle();
    let ended = turn(5, TurnEnding::Completed);
    let unseen = status(&facts(&chat(4), &live, Some(&ended)));
    assert_eq!(
        (unseen.rank, unseen.line().as_str()),
        (Rank::Done, "Done · All done. See x.")
    );
    assert!(unseen.unread());
    let seen = status(&facts(&chat(5), &live, Some(&ended)));
    assert_eq!(
        (seen.rank, seen.line().as_str()),
        (Rank::Idle, "All done. See x.")
    );
    assert!(!seen.unread());
}

#[test]
fn a_request_outranks_work_and_a_failure_waits_only_until_seen() {
    let mut live = idle();
    live.activity = crate::Activity::WaitingForYou;
    live.interactions.push(LiveInteraction {
        interaction_id: "i".to_owned(),
        kind: InteractionKind::Approval {
            description: "npm install".to_owned(),
            reason: None,
            decisions: Vec::new(),
        },
    });
    let approval = status(&Facts {
        activity: "waiting",
        ..facts(&chat(0), &live, None)
    });
    assert_eq!(approval.line(), "Approval needed · npm install");
    assert!(approval.rank.needs_you());

    // A command is named as written, without the shell that wraps it.
    let mut wrapped = idle();
    wrapped.interactions.push(LiveInteraction {
        interaction_id: "i".to_owned(),
        kind: InteractionKind::Approval {
            description: r#"/bin/zsh -lc "printf '%s\n' verified >> hello.txt""#.to_owned(),
            reason: None,
            decisions: Vec::new(),
        },
    });
    let approval = status(&Facts {
        activity: "waiting",
        ..facts(&chat(0), &wrapped, None)
    });
    assert_eq!(
        approval.line(),
        r"Approval needed · printf '%s\n' verified >> hello.txt"
    );

    let live = idle();
    let failed = turn(3, failed());
    let unseen = status(&facts(&chat(2), &live, Some(&failed)));
    assert_eq!(unseen.line(), "Failed · Codex stopped with an error");
    assert!(unseen.rank.needs_you());
    let seen = status(&facts(&chat(3), &live, Some(&failed)));
    assert_eq!((seen.rank, seen.word.as_str()), (Rank::Idle, "Failed"));

    let lost = turn(
        3,
        TurnEnding::ContactLost(Some("the harness process ended".to_owned())),
    );
    let interrupted = status(&facts(&chat(2), &live, Some(&lost)));
    assert_eq!(interrupted.line(), "Interrupted · Codex stopped mid-turn");
    assert_eq!(interrupted.rank, Rank::Failed);
}

#[test]
fn marked_unread_is_the_blue_dot_on_the_seen_words_and_never_notifies() {
    let live = idle();
    let failed = turn(3, failed());
    let mut marked = chat(3);
    marked.marked_unread = true;
    let status = status(&facts(&marked, &live, Some(&failed)));
    // Not Failed again: the words it had once seen, with the blue dot.
    assert_eq!((status.rank, status.word.as_str()), (Rank::Idle, "Failed"));
    assert!(status.unread());
    let done = turn(3, TurnEnding::Completed);
    let status_done = super::status(&facts(&marked, &live, Some(&done)));
    assert_eq!(status_done.rank, Rank::Idle);
    assert!(status_done.unread());
    // The row keeps the reply's words; a one-line summary names the outcome.
    assert_eq!(status_done.word, "All done. See x.");
    assert_eq!(status_done.label, "Done");
    assert_eq!(status.label, "Failed");

    let mut notifier = Notifier::default();
    let quiet = HashSet::new();
    let now = Instant::now();
    let seen = super::status(&facts(&chat(3), &live, Some(&failed)));
    notifier.update(&[row(&seen)], &quiet, true, now);
    let alerts = notifier.update(&[row(&status)], &quiet, true, now);
    let later = notifier.update(&[row(&status)], &quiet, true, now + QUIET_WINDOW * 2);
    assert_eq!((alerts, later), (Vec::new(), Vec::new()));
}

#[test]
fn a_turn_the_person_stopped_is_idle_and_a_setup_step_is_words_only() {
    let live = idle();
    let stopped = turn(3, TurnEnding::StoppedByPerson);
    let unseen = status(&facts(&chat(2), &live, Some(&stopped)));
    assert_eq!(
        (unseen.rank, unseen.word.as_str()),
        (Rank::Idle, "You stopped it")
    );
    // Marked unread: the blue dot on its own words.
    assert!(unseen.unread());
    let setup = status(&Facts {
        problem: Some((ChatProblemKind::NotInstalled, false)),
        ..facts(&chat(0), &live, None)
    });
    assert_eq!((setup.rank, setup.word.as_str()), (Rank::Idle, "Not sent"));
}

fn done(line: &str) -> Status {
    Status {
        rank: Rank::Done,
        unseen: true,
        word: "Done".to_owned(),
        label: "Done".to_owned(),
        detail: Some(line.to_owned()),
    }
}

fn row<'a>(status: &'a Status) -> Row<'a> {
    Row {
        id: "c",
        title: "Fix login",
        status,
        muted: false,
    }
}

#[test]
fn done_waits_out_the_quiet_window_and_a_new_turn_cancels_it() {
    let start = Instant::now();
    let nobody = HashSet::new();
    let mut notifier = Notifier::default();
    let working = Status {
        rank: Rank::Working,
        unseen: false,
        word: "Working".to_owned(),
        label: "Working".to_owned(),
        detail: None,
    };
    // What is there at startup is not announced again.
    assert!(
        notifier
            .update(&[row(&working)], &nobody, true, start)
            .is_empty()
    );
    let finished = done("All done");
    assert!(
        notifier
            .update(&[row(&finished)], &nobody, true, start)
            .is_empty()
    );
    assert_eq!(notifier.deadline(), Some(start + QUIET_WINDOW));
    // The turn continued at once: nothing.
    assert!(
        notifier
            .update(&[row(&working)], &nobody, true, start)
            .is_empty()
    );
    assert_eq!(notifier.deadline(), None);

    notifier.update(&[row(&finished)], &nobody, true, start);
    let later = start + QUIET_WINDOW;
    assert_eq!(
        notifier.update(&[row(&finished)], &nobody, true, later),
        [Alert::Show {
            chat_id: "c".to_owned(),
            title: "Fix login".to_owned(),
            body: "Done · All done".to_owned(),
        }]
    );
    // Opening it withdraws the notification.
    let open = HashSet::from(["c".to_owned()]);
    assert_eq!(
        notifier.update(&[row(&finished)], &open, true, later),
        [Alert::Withdraw {
            chat_id: "c".to_owned()
        }]
    );
}

#[test]
fn a_chat_in_view_muted_or_with_notifications_off_is_never_announced() {
    let now = Instant::now();
    let approval = Status {
        rank: Rank::Approval,
        unseen: false,
        word: "Approval needed".to_owned(),
        label: "Approval needed".to_owned(),
        detail: None,
    };
    let idle = Status {
        rank: Rank::Idle,
        unseen: false,
        word: "Idle".to_owned(),
        label: "Idle".to_owned(),
        detail: None,
    };
    let open = HashSet::from(["c".to_owned()]);
    let nobody = HashSet::new();
    let cases = [
        (&open, false, true),
        (&nobody, true, true),
        (&nobody, false, false),
    ];
    for (in_view, muted, enabled) in cases {
        let mut notifier = Notifier::default();
        notifier.update(&[row(&idle)], in_view, enabled, now);
        let waiting = Row {
            muted,
            ..row(&approval)
        };
        assert!(
            notifier
                .update(&[waiting], in_view, enabled, now)
                .is_empty()
        );
    }
    let mut notifier = Notifier::default();
    notifier.update(&[row(&idle)], &nobody, true, now);
    assert_eq!(
        notifier.update(&[row(&approval)], &nobody, true, now).len(),
        1
    );
    // Answered: withdrawn, and not shown again.
    assert!(matches!(
        notifier
            .update(&[row(&idle)], &nobody, true, now)
            .as_slice(),
        [Alert::Withdraw { .. }]
    ));
}

#[test]
fn the_app_icon_count_stops_at_99() {
    assert_eq!(badge_text(0), None);
    assert_eq!(badge_text(3).as_deref(), Some("3"));
    assert_eq!(badge_text(120).as_deref(), Some("99+"));
}

/// What the Chats list says after "Stopped" for each reason ticketd stops a Chat: a
/// few words, at most 15 characters. The transcript says it in full.
const STOP_CAUSES: [(StopReason, &str); 9] = [
    (StopReason::Quit, "ticketd quit"),
    (StopReason::TurnedOff, "Chat turned off"),
    (StopReason::Restore, "backup restored"),
    (StopReason::TakenOver, "you took over"),
    (StopReason::TimeLimit, "time limit"),
    (StopReason::RunEnded, "step ended"),
    (StopReason::Trashed, "trashed"),
    (StopReason::ExplicitResume, "Chat resumed"),
    (StopReason::StorageFailed, "storage failed"),
];

/// The status as a row draws it: the word, which is never shortened, and the line.
fn shown(status: &Status) -> (Rank, &str, String) {
    (status.rank, status.word.as_str(), status.line())
}

/// Every reason ticketd stops a Chat for reads as ticketd's stop: idle, "Stopped" with
/// the cause after it, and never as the harness failing mid-turn (whether or not the
/// harness reported it). The cause is the detail, which a narrow row shortens with an
/// ellipsis; the word is never shortened, so a long one was cut off mid-sentence.
#[test]
fn a_turn_ticketd_stopped_reads_stopped_then_its_cause_for_every_reason() {
    assert_eq!(STOP_CAUSES.map(|(reason, _)| reason), StopReason::ALL);
    assert!(
        STOP_CAUSES
            .iter()
            .all(|(_, cause)| cause.chars().count() <= 15)
    );
    let live = idle();
    for (reason, cause) in STOP_CAUSES {
        let row = (Rank::Idle, "Stopped", format!("Stopped · {cause}"));
        let stopped = turn(3, TurnEnding::StoppedByTicketd(reason));
        // Unseen and seen, it reads the same.
        assert_eq!(shown(&status(&facts(&chat(2), &live, Some(&stopped)))), row);
        assert_eq!(shown(&status(&facts(&chat(3), &live, Some(&stopped)))), row);
        // Settled by lost contact instead of the harness's report, it reads the same.
        let unreported = ChatTurn {
            state: ChatTurnState::Unknown,
            ..stopped
        };
        assert_eq!(
            shown(&status(&facts(&chat(2), &live, Some(&unreported)))),
            row
        );
    }
}

/// A turn stopped by the format-82 build kept no ending and an `unknown` state: the
/// reason is only in its wording. Every reason that build wrote still reads as
/// ticketd's stop, not as lost contact.
#[test]
fn a_turn_ticketd_stopped_before_endings_existed_reads_stopped_then_its_cause() {
    let live = idle();
    for (reason, cause) in STOP_CAUSES {
        let old = ChatTurn {
            ending: None,
            state: ChatTurnState::Unknown,
            detail: Some(reason.detail().to_owned()),
            ..turn(3, TurnEnding::Completed)
        };
        assert_eq!(
            TurnEnding::of(&old),
            Some(TurnEnding::StoppedByTicketd(reason))
        );
        assert_eq!(
            shown(&status(&facts(&chat(2), &live, Some(&old)))),
            (Rank::Idle, "Stopped", format!("Stopped · {cause}"))
        );
    }
}
