//! One proving test per harness: real fixtures, the real adapter, supervisor and core.

use super::{Fixture, HostScript, fixture};
use crate::attention::Rank;
use crate::{InteractionAnswer, QuestionAnswer};
use ticketd_core::ChatTurnState;

#[tokio::test(start_paused = true)]
async fn claude_asks_for_a_permission_then_a_question_and_records_both_answers() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "permission_wait"),
        ])
        .start();

    h.send("Change it").await;
    h.play_to("a permission is pending while output continues")
        .await;

    assert_eq!(h.attention().await.rank, Rank::Approval);
    assert_eq!(
        h.transcript(),
        [
            "you: Change it",
            "turn active",
            "tool Write running",
            "tool ticketd files completed",
            "approval \"Write to a.txt\" pending",
            "agent: Waiting (streaming)",
        ]
    );

    h.approve().await;
    h.play_to("the permission was answered and a question asked")
        .await;

    assert_eq!(h.attention().await.rank, Rank::Question);
    let history = h.transcript();
    assert!(
        history.contains(&"approval \"Write to a.txt\" answered".to_owned()),
        "{history:?}"
    );

    h.answer(InteractionAnswer::Answers(vec![
        QuestionAnswer {
            question_id: "Which scope?".to_owned(),
            values: vec!["Small".to_owned()],
        },
        QuestionAnswer {
            question_id: "Which files?".to_owned(),
            values: vec!["a.txt".to_owned(), "b.txt".to_owned()],
        },
    ]))
    .await;
    h.play_all().await;
    h.finish().await;
    assert!(
        h.transcript()
            .contains(&"question \"Which scope?\\nWhich files?\" answered".to_owned()),
        "{:?}",
        h.transcript()
    );
}

#[tokio::test(start_paused = true)]
async fn codex_runs_a_command_the_person_allowed_and_ends_the_turn() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "turn_ordering"),
        ])
        .start();

    h.send("List the files").await;
    h.play_to("the approval arrived before the turn/start reply")
        .await;
    assert_eq!(h.attention().await.rank, Rank::Approval);

    h.approve().await;
    h.play_all().await;
    h.finish().await;

    assert_eq!(
        h.transcript(),
        [
            "you: List the files",
            "session thr_1",
            "turn completed",
            "agent: Looking. One file: README.md",
            "tool ls completed",
            "approval \"ls\" answered",
        ]
    );
    let status = h.attention().await;
    assert_eq!((status.rank, status.unseen), (Rank::Done, true));
}

#[tokio::test(start_paused = true)]
async fn antigravity_answers_a_prompt_and_ends_the_turn_on_its_reply() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "host_prompt")])
        .start();

    h.send("Return the synthetic fixture word.").await;
    // The first mark ("the session is open") ends the handshake the open plays.
    h.play_to("the prompt was written").await;
    assert_eq!(h.attention().await.rank, Rank::Working);

    h.play_all().await;
    h.finish().await;

    assert_eq!(
        h.transcript(),
        [
            "you: Return the synthetic fixture word.",
            "session session-1",
            "turn completed",
            "agent: Synthetic ACP model fixture",
        ]
    );
    let status = h.attention().await;
    assert_eq!((status.rank, status.unseen), (Rank::Done, true));
}

/// A short transcript written in the test: the session asks, the person refuses, then
/// stops the turn. Marks let the test act between the frames.
const REFUSE_AND_STOP: Fixture = Fixture {
    name: "inline refuse-and-stop",
    text: r#"
{"client":{"id":"c4","cmd":"submit","generation":7,"submission_id":"sub-1","text":"Change it"}}
{"server":{"v":1,"event":"input_handed_to_sdk","generation":7,"submission_id":"sub-1"}}
{"server":{"v":1,"event":"input_processing","generation":7,"submission_ids":["sub-1"]}}
{"server":{"v":1,"event":"permission_request","generation":7,"request_id":"7-1","tool_name":"Write","tool_use_id":"toolu_1","input":{"file_path":"/work/chat-1/a.txt"},"title":"Write to a.txt","display_name":"Write","description":null,"decision_reason":null,"blocked_path":null,"agent_id":null,"default_to_no":false,"can_remember":true}}
{"mark":"asked"}
{"client":{"id":"c5","cmd":"respond","generation":7,"request_id":"7-1","decision":{"kind":"deny"}}}
{"server":{"v":1,"event":"request_resolved","generation":7,"id":"c5","request_id":"7-1","outcome":"deny"}}
{"mark":"refused"}
{"client":{"id":"c6","cmd":"interrupt","generation":7}}
{"server":{"v":1,"event":"interrupt_result","generation":7,"id":"c6","receipt":true,"still_queued_submission_ids":[]}}
{"server":{"v":1,"event":"turn_result","generation":7,"correlation":"uuid","submission_ids":["sub-1"],"unmatched_uuids":[],"pending_submission_ids":[],"subtype":"error_during_execution","is_error":true,"result_text":null,"errors":[],"stop_reason":null,"terminal_reason":"aborted","denials":[],"queued_turn_count":0,"num_turns":1,"duration_ms":12,"session_id":"sess-1"}}
"#,
};

#[tokio::test(start_paused = true)]
async fn a_refused_approval_and_a_stop_leave_a_stopped_turn_nothing_pending() {
    let mut h = HostScript::claude()
        .process([fixture!("claude", "handshake"), REFUSE_AND_STOP])
        .start();

    h.send("Change it").await;
    h.play_to("asked").await;
    h.deny().await;
    h.play_to("refused").await;
    assert!(h.live().await.interactions.is_empty());

    h.stop().await;
    h.play_all().await;
    h.finish().await;

    let history = h.transcript();
    assert!(
        history.contains(&"approval \"Write to a.txt\" answered".to_owned()),
        "{history:?}"
    );
    assert!(
        history.contains(&"turn interrupted".to_owned()),
        "{history:?}"
    );
    let status = h.attention().await;
    assert_eq!(
        (status.rank, status.word.as_str()),
        (Rank::Idle, "You stopped it")
    );
}

/// The harness exits mid-turn; the host starts the next scripted process when the
/// person sends again, and the first turn stays recorded as lost.
#[tokio::test(start_paused = true)]
async fn a_lost_process_is_recorded_and_the_next_message_starts_the_next_process() {
    let first_turn = Fixture {
        name: "inline first turn",
        text: r#"
{"client":{"id":"c4","cmd":"submit","generation":7,"submission_id":"sub-1","text":"One"}}
{"server":{"v":1,"event":"input_handed_to_sdk","generation":7,"submission_id":"sub-1"}}
{"server":{"v":1,"event":"input_processing","generation":7,"submission_ids":["sub-1"]}}
{"mark":"working"}
"#,
    };
    // The second input is the second one the Chat has had, whichever process takes it.
    let second_turn = Fixture {
        name: "inline second turn",
        text: r#"
{"client":{"id":"c4","cmd":"submit","generation":7,"submission_id":"sub-2","text":"Two"}}
{"server":{"v":1,"event":"input_handed_to_sdk","generation":7,"submission_id":"sub-2"}}
{"mark":"taken"}
"#,
    };
    let mut h = HostScript::claude()
        .process([fixture!("claude", "handshake"), first_turn])
        .process([fixture!("claude", "handshake"), second_turn])
        .start();

    h.send("One").await;
    h.play_to("working").await;
    let [first] = h.turns().try_into().expect("one turn is working");
    assert_eq!(first.state, ChatTurnState::Active);
    h.lose_process(1).await;
    // The same turn stays in the history, as one whose outcome was not observed.
    let lost = h.turns().into_iter().find(|turn| turn.id == first.id);
    assert_eq!(
        lost.map(|turn| turn.state),
        Some(ChatTurnState::Unknown),
        "{:?}",
        h.transcript()
    );
    assert_eq!(h.opens().len(), 1);

    h.send("Two").await;
    h.play_to("taken").await;
    assert_eq!(h.opens().len(), 2);
    assert_eq!(h.attention().await.rank, Rank::Working);
}

#[tokio::test(start_paused = true)]
#[should_panic(
    expected = "first difference: $.text: fixture \"Change it\", adapter \"Something else\""
)]
async fn an_unexpected_frame_fails_showing_both_frames() {
    let mut h = HostScript::claude()
        .process([fixture!("claude", "handshake"), REFUSE_AND_STOP])
        .start();

    h.send("Something else").await;
    h.play().await;
}
