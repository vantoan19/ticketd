use super::*;
use crate::LiveInteraction;

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

fn turn(position: i64, state: ChatTurnState) -> ChatTurn {
    ChatTurn {
        id: format!("t{position}"),
        position,
        native_turn_id: None,
        state,
        detail: None,
        started_at: String::new(),
        ended_at: None,
        problem: None,
        problem_resets_at: None,
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
        last_change: None,
        last_response: Some("All **done**. See `x`."),
    }
}

#[test]
fn a_finished_turn_is_done_until_seen_then_idle_in_words() {
    let live = idle();
    let ended = turn(5, ChatTurnState::Completed);
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
    let failed = turn(3, ChatTurnState::Failed);
    let unseen = status(&facts(&chat(2), &live, Some(&failed)));
    assert_eq!(unseen.line(), "Failed · Codex stopped with an error");
    assert!(unseen.rank.needs_you());
    let seen = status(&facts(&chat(3), &live, Some(&failed)));
    assert_eq!((seen.rank, seen.word.as_str()), (Rank::Idle, "Failed"));

    let lost = turn(3, ChatTurnState::Unknown);
    let interrupted = status(&facts(&chat(2), &live, Some(&lost)));
    assert_eq!(interrupted.line(), "Interrupted · Codex stopped mid-turn");
    assert_eq!(interrupted.rank, Rank::Failed);
}

#[test]
fn marked_unread_is_the_blue_dot_on_the_seen_words_and_never_notifies() {
    let live = idle();
    let failed = turn(3, ChatTurnState::Failed);
    let mut marked = chat(3);
    marked.marked_unread = true;
    let status = status(&facts(&marked, &live, Some(&failed)));
    // Not Failed again: the words it had once seen, with the blue dot.
    assert_eq!((status.rank, status.word.as_str()), (Rank::Idle, "Failed"));
    assert!(status.unread());
    let done = turn(3, ChatTurnState::Completed);
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
    let stopped = turn(3, ChatTurnState::Interrupted);
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
