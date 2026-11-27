//! Codex never resumes the main agent when a sub-agent it started finishes, so ticketd
//! does, through the whole host: recorded app-server traffic from a fixture, the real
//! Codex runtime, supervisor and core, and what the Chat's history and status say after.
//! The sub-agent's traffic is converted from a live codex-cli 0.172.0 capture; the turn
//! ticketd starts afterwards, the second sub-agent and the nested one are hand-built from
//! the same shapes (see each fixture's first line).

use super::{HostScript, fixture};
use crate::attention::{Alert, Notifier, Rank, Row, Status};
use std::collections::HashSet;
use std::time::{Duration, Instant};
use ticketd_core::{ChatTurnStarter, ChatTurnState};

const PROMPT: &str = "Start one sub-agent on the slow check, do not wait for it, and end your turn";

/// The child thread of the first fixture.
const CHILD: &str = "00000000-0000-4000-8000-000000000003";

/// Feeds the statuses the Chats list showed to the system's notifier, as the desktop
/// does, and keeps what it announced.
struct Watch {
    notifier: Notifier,
    base: Instant,
    at: u64,
    shown: Vec<String>,
}

impl Watch {
    fn new() -> Self {
        Self {
            notifier: Notifier::default(),
            base: Instant::now(),
            at: 0,
            shown: Vec::new(),
        }
    }

    fn see(&mut self, status: &Status, after_ms: u64) {
        self.at += after_ms;
        let rows = [Row {
            id: "chat",
            title: "Review the rate limiter",
            status,
            muted: false,
        }];
        let now = self.base + Duration::from_millis(self.at);
        for alert in self.notifier.update(&rows, &HashSet::new(), true, now) {
            if let Alert::Show { body, .. } = alert {
                self.shown.push(body);
            }
        }
    }
}

fn woken_turn_origin(h: &HostScript) -> (ChatTurnStarter, Option<String>) {
    let turns = h.turns();
    assert_eq!(turns.len(), 2, "{:?}", h.transcript());
    assert_eq!(turns[0].origin, None);
    let origin = turns[1].origin.clone().expect("the turn is labelled");
    (origin.by, origin.sub_agent)
}

#[tokio::test(start_paused = true)]
async fn a_sub_agent_that_finishes_while_the_main_agent_is_idle_wakes_it_with_one_message() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_outlives_turn"),
        ])
        .start();
    let mut watch = Watch::new();
    watch.see(&h.attention().await, 0);
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    // The turn is over and the sub-agent works on: the Chat is still working.
    assert_eq!(h.live().await.sub_agents, 1);
    assert_eq!(h.attention().await.rank, Rank::Working);

    h.play_to("the sub-agent runs its command").await;
    // It finishes. Codex starts nothing by itself: nothing goes out in the first moments
    // (a second sub-agent may finish with it), and the Chat has not gone quiet.
    h.play_to("the sub-agent finished").await;
    assert_eq!(h.live().await.sub_agents, 0);
    h.pass(Duration::from_millis(100)).await;
    assert_eq!(h.turns().len(), 1);
    let status = h.attention().await;
    assert_eq!(status.rank, Rank::Working, "{status:?}");
    watch.see(&status, 100);
    h.pass(Duration::from_secs(5)).await;

    // Then ticketd tells the main agent, once, and its turn is labelled so.
    h.play_to("the woken turn ended").await;
    assert_eq!(
        woken_turn_origin(&h),
        (ChatTurnStarter::Ticketd, Some(CHILD.to_owned()))
    );
    assert_eq!(h.turns()[1].state, ChatTurnState::Completed);
    // The message is ticketd's, not a message the person sent.
    let transcript = h.transcript();
    assert!(
        transcript
            .iter()
            .any(|line| line == "agent: The check passed."),
        "{transcript:?}"
    );
    assert!(
        transcript
            .iter()
            .all(|line| !line.starts_with("you:") || line == "you: Start one sub-agent on the slow check, do not wait for it, and end your turn"),
        "{transcript:?}"
    );

    // One Done, when the woken turn is over.
    let status = h.attention().await;
    assert_eq!((status.rank, status.word.as_str()), (Rank::Done, "Done"));
    watch.see(&status, 100);
    watch.see(&status, 3_000);
    assert_eq!(watch.shown.len(), 1, "{:?}", watch.shown);

    // Nothing else is sent, however long it stays quiet.
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
    assert_eq!(h.turns().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn several_sub_agents_finishing_together_are_covered_by_one_message() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_two"),
        ])
        .start();
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while two sub-agents run")
        .await;
    assert_eq!(h.live().await.sub_agents, 2);
    h.play_to("both sub-agents finished").await;
    assert_eq!(h.live().await.sub_agents, 0);
    // The fixture holds the one message, naming both.
    h.play_to("the woken turn ended").await;
    assert_eq!(h.turns().len(), 2);
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
    assert_eq!(h.turns().len(), 2, "{:?}", h.transcript());
}

#[tokio::test(start_paused = true)]
async fn a_nested_sub_agent_finishing_does_not_wake_the_main_agent() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_nested"),
        ])
        .start();
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    h.play_to("the sub-agent started its own").await;
    h.play_to("the nested sub-agent finished").await;
    // The nested one is over; its parent still runs. The main agent hears nothing.
    h.pass(Duration::from_secs(30)).await;
    assert_eq!(h.turns().len(), 1);
    h.play_to("the sub-agent finished").await;
    // The direct one finished: one message, naming it alone (the fixture's text).
    h.play_to("the woken turn ended").await;
    assert_eq!(
        woken_turn_origin(&h),
        (ChatTurnStarter::Ticketd, Some(CHILD.to_owned()))
    );
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
}

#[tokio::test(start_paused = true)]
async fn the_persons_message_goes_first_and_carries_what_finished() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_person_first"),
        ])
        .start();
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    h.play_to("the sub-agent finished").await;
    // The person writes before ticketd's message went out: theirs is the turn, with the
    // result in its context, and ticketd sends nothing of its own.
    h.send("What did it find?").await;
    h.play_to("the person's turn ended").await;
    let turns = h.turns();
    assert_eq!(turns.len(), 2, "{:?}", h.transcript());
    assert_eq!(turns[1].origin, None, "the person started it");
    assert!(
        h.transcript()
            .iter()
            .any(|line| line == "you: What did it find?"),
        "the stored message is the person's own words: {:?}",
        h.transcript()
    );
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
    assert_eq!(h.turns().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_sub_agent_that_finishes_while_the_persons_message_is_on_its_way_wakes_nothing() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_while_sending"),
        ])
        .start();
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    h.play_to("the sub-agent runs its command").await;
    // The person's message is written while the sub-agent still runs, then the sub-agent
    // finishes before Codex has answered it: no turn runs yet.
    h.send("What did it find?").await;
    h.play_to("the sub-agent finished").await;
    assert_eq!(h.live().await.sub_agents, 0);
    h.play_to("the person's turn ended").await;
    // That message's turn is the one that covers the finish: ticketd sends nothing of its
    // own afterwards, however long it stays quiet.
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
    let turns = h.turns();
    assert_eq!(turns.len(), 2, "{:?}", h.transcript());
    assert_eq!(turns[1].origin, None, "the person started it");
}

#[tokio::test(start_paused = true)]
async fn a_wake_turn_that_fails_shows_failed_and_notifies_but_leaves_the_queue_alone() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_failed"),
        ])
        .start();
    let mut watch = Watch::new();
    watch.see(&h.attention().await, 0);
    h.send(PROMPT).await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    h.play_to("the sub-agent finished").await;
    h.play_to("the woken turn failed").await;

    assert_eq!(
        woken_turn_origin(&h),
        (ChatTurnStarter::Ticketd, Some(CHILD.to_owned()))
    );
    assert_eq!(h.turns()[1].state, ChatTurnState::Failed);
    let status = h.attention().await;
    assert_eq!(status.rank, Rank::Failed, "{status:?}");
    watch.see(&status, 100);
    assert_eq!(watch.shown.len(), 1, "{:?}", watch.shown);
    // The person's queue is not paused for a turn they did not start, and ticketd does
    // not try again on its own.
    assert!(!h.core().chat(h.chat_id()).expect("the Chat").queue_paused);
    h.pass(Duration::from_secs(60)).await;
    h.finish().await;
    assert_eq!(h.turns().len(), 2);
}

/// The stored history of the Chat right after the first wake, while the other sub-agent
/// still runs, with ids and times made stable: the file the desktop's view of the wake is
/// built from (`apps/desktop/src-tauri/src/chat_view.rs` reads it). Regenerated only with
/// `TICKETD_UPDATE_VIEW_FIXTURES=1`.
const STORED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/codex/sub_agent_wake.stored.json"
);

#[tokio::test(start_paused = true)]
async fn each_finish_wakes_the_main_agent_once_while_the_other_sub_agent_still_runs() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_wake_while_another_runs"),
        ])
        .start();
    h.send("Upgrade the payment client to v5. Split the refund calls and the webhook handler between two agents.")
        .await;
    h.play_to("the parent's turn ended while two sub-agents run")
        .await;
    assert_eq!(h.live().await.sub_agents, 2);

    // One finishes while the other runs on: the main agent is told about that one.
    h.play_to("the first sub-agent finished").await;
    h.play_to("the woken turn ended").await;
    assert_eq!(h.live().await.sub_agents, 1);
    let turns = h.turns();
    assert_eq!(turns.len(), 2, "{:?}", h.transcript());
    assert_eq!(
        turns[1].origin.as_ref().map(|origin| origin.by),
        Some(ChatTurnStarter::Ticketd)
    );

    let snapshot = h
        .core()
        .chat_snapshot(h.chat_id(), 5_000)
        .expect("the Chat's history");
    // The change log's sequence counts every write, which varies with how the host's
    // tasks interleave under load: it is not what the view is built from.
    let stored = super::sub_agents::made_stable(
        &serde_json::to_string_pretty(&snapshot).expect("it serializes"),
    )
    .lines()
    .map(|line| {
        if line.trim_start().starts_with("\"sequence\":") {
            "  \"sequence\": 0,".to_owned()
        } else {
            line.to_owned()
        }
    })
    .collect::<Vec<_>>()
    .join("\n");
    if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
        std::fs::write(STORED, format!("{stored}\n")).expect("the file is written");
    }
    let kept = std::fs::read_to_string(STORED).expect(
        "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script::codex_wake",
    );
    assert!(
        kept.trim_end() == stored,
        "the stored history changed; if that is intended, regenerate {STORED} with TICKETD_UPDATE_VIEW_FIXTURES=1"
    );

    // The other finishes later: one more message, for that one.
    h.play_to("the second sub-agent finished").await;
    h.play_to("the second woken turn ended").await;
    let turns = h.turns();
    assert_eq!(turns.len(), 3, "{:?}", h.transcript());
    assert!(turns[1..].iter().all(|turn| turn.origin.is_some()));
    assert_ne!(
        turns[1]
            .origin
            .as_ref()
            .and_then(|origin| origin.sub_agent.clone()),
        turns[2]
            .origin
            .as_ref()
            .and_then(|origin| origin.sub_agent.clone())
    );
    h.pass(Duration::from_secs(30)).await;
    h.finish().await;
}
