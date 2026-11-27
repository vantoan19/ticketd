//! The Chat host with a scripted harness: real harness traffic, replayed from a
//! JSON-lines fixture, through the real adapter runtime (Claude Code, Codex or
//! Antigravity), the real supervisor (`ChatHost`) and the real core, into a temporary
//! Workspace. A test sends messages, plays the fixture to its marks, answers or
//! refuses approvals, stops the Chat, lets time pass, and asserts external behaviour
//! only: what the Chat's stored history, its attention status and its notices hold.
//!
//! This is the seam the sub-agent tickets (#609) write their tests on. Use it for
//! "given this traffic from the harness, the Chat history says...". Use `FakeAdapter`
//! (`tests/supervisor.rs`) when the test is about the supervisor and needs events the
//! harness protocol cannot produce, and the adapter's own tests (`claude/tests.rs`...)
//! when the question is "which events does this frame become".
//!
//! # Where it lives
//!
//! A `#[cfg(test)]` module of this crate, not a feature. It needs `scripted.rs` and
//! each adapter's crate-private `open_over`, and a feature would have made those
//! reachable from `tests/`, which changes the crate's production API. The price is
//! that tests using it are crate unit tests: add a module under `src/host_script/`
//! (see `tests.rs`) and `use super::*;`.
//!
//! # How a test reads
//!
//! ```ignore
//! #[tokio::test(start_paused = true)]
//! async fn the_approval_waits_for_the_person() {
//!     let mut h = HostScript::claude()
//!         .process([fixture!("claude", "handshake"), fixture!("claude", "permission_wait")])
//!         .start();
//!     h.send("Change it").await;
//!     h.play_to("a permission is pending while output continues").await;
//!     assert_eq!(h.attention().rank, Rank::Approval);
//!     h.approve().await;
//!     h.play().await; // the adapter writes the `respond` frame the fixture expects
//!     assert_eq!(h.transcript(), ["you: Change it", ...]);
//! }
//! ```
//!
//! - `#[tokio::test(start_paused = true)]` is required (it is checked). Time moves
//!   only when every task waits, so `settle()` means "until nothing more happens" and
//!   `pass(duration)` lets a timer fire deterministically.
//! - One `process(...)` is one harness process: the host starts the harness when the
//!   Chat gets its first message and takes the next `process` for every later start
//!   (a restart, a resume). Its argument lists transcripts played back to back, the
//!   first one while the runtime opens (the handshake), with an implicit mark
//!   `after <name>` between them. The open plays up to the first mark it meets, so
//!   a single fixture can hold its own handshake: put a `mark` after it.
//! - `play()` plays the current process up to its next mark (or the end) and lets the
//!   host run until idle; it returns the mark's name. `play_to(name)` insists on that
//!   mark. `play_all()` ignores marks. Between marks the test acts: `send`, `queue`,
//!   `approve`, `deny`, `answer`, `stop`, `lose_process`, `pass`.
//! - Asserting: `transcript()` (one short line per stored item, in history order),
//!   `items()` (the stored `ChatItem`s), `attention()` (the ranked status a Chats row
//!   shows), `live()` (what the host holds in memory: activity, pending approvals),
//!   `notices()`, `opens()`. Prefer `transcript()` and `attention()`: they read only
//!   what a person sees and keep working when storage grows fields.
//! - `finish()` ends a test: the whole fixture was played and the adapter wrote
//!   nothing the fixture did not expect.
//!
//! # Writing a fixture
//!
//! `tests/fixtures/<harness>/<name>.jsonl`, one JSON value per line:
//!
//! - `{"note": "..."}` first: where it came from, honestly ("Converted from a live
//!   codex-cli 0.172.0 capture, sanitized", "Hand-built from the Agent SDK 0.3.322
//!   types; not captured live"). Sanitize everything you commit (README rules).
//! - `{"client": <frame>}`: a frame the adapter must write next. Compared as JSON
//!   values, so the fixture is a strict contract on what ticketd sends. A mismatch
//!   fails with both frames and the first path that differs.
//! - `{"server": <frame>}`: a frame the harness sends.
//! - `{"mark": "what has just happened"}`: playing stops; the test acts, then plays on.
//!
//! The first part of a process is played while the runtime opens, so it holds the
//! handshake (copy `claude/handshake.jsonl`, `codex/handshake.jsonl`, or the lines
//! of `antigravity/host_prompt.jsonl` before its first mark). Later parts start at
//! the first frame after the open. Frames are tagged in the harness's own protocol: Claude
//! fixtures are the bridge's frames (`apps/chat-bridge-claude/src/protocol.ts`), Codex
//! and Antigravity are JSON-RPC (client ids count up from 1 in the order the adapter
//! sends them: a request the fixture forgets shifts every later id).
//!
//! ## Values the host chooses
//!
//! A fixture cannot know them, so these are bound for you in `client` and `server`
//! frames alike:
//!
//! - `"sub-N"` as a whole string value is the id of the Nth input the person sent
//!   (counting the host's submission attempts in history order, from 1), as in
//!   `{"submission_id": "sub-1"}` (Claude) or `"clientUserMessageId": "sub-1"` (Codex).
//! - `"$ticketd-version"` as a whole string value is ticketd's own version (an ACP
//!   `initialize` names it), so a release does not break the fixture.
//! - In Claude frames every `"generation"` number is the generation the host opened
//!   the runtime with (1 for the first start, then counting up), so write 7 as the
//!   existing unit fixtures do, or any number.
//! - The Chat's folder is `/work/chat-1` unless the builder says `.folder(...)`.
//!
//! ## From a research capture
//!
//! Research captures (`{"t", "dir", "msg"}` lines) are not fixtures: `dir` out or `->`
//! becomes `client`, in or `<-` becomes `server`, `t` is dropped (code map 9.1). The
//! captured `client` frames are the research driver's, not ticketd's: regenerate
//! every `client` line from what the adapter writes (run the test; the failure shows
//! the adapter's frame) and keep only the `server` lines. Splice captured turn traffic
//! after the handshake of a fixture that already plays, mask home paths as
//! `/fixture/work`, give thread, turn and item ids stable fixture ids, rewrite
//! timestamps to small constants, and drop account, plan, MCP and installed-skill
//! traffic. For the recordings themselves see `scripts/scrub-harness-recording.mjs`.

// The seam offers more than the proving tests use; the sub-agent tickets use the rest.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tempfile::TempDir;
use tokio::task::JoinHandle;

use crate::attention::{self, Facts, Status};
use crate::scripted::{Peer, Played, pipes};
use crate::stdio::Io;
use crate::{
    Activity, ApprovalDecision, Capabilities, ChatHost, ChatLive, HarnessAdapter, HostError,
    Inspection, InteractionAnswer, LoginState, OpenRequest, OpenedRuntime, Problem, ProblemKind,
    SendMode, WorkspaceOpener,
};
use ticketd_core::{
    Chat, ChatInteractionState, ChatItem, ChatMessage, ChatOwner, ChatRole, ChatSubAgent, ChatTool,
    ChatTurn, NewChat, Workspace, WorkspaceSession,
};

#[cfg(test)]
mod antigravity_sub_agents;
#[cfg(test)]
mod codex_sub_agents;
#[cfg(test)]
mod resume;
#[cfg(test)]
mod sub_agents;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod write_credit;

/// A fixture as the macro [`fixture!`] reads it at compile time.
#[derive(Clone, Copy)]
pub(crate) struct Fixture {
    pub name: &'static str,
    pub text: &'static str,
}

/// `fixture!("codex", "turn_ordering")` is `tests/fixtures/codex/turn_ordering.jsonl`.
macro_rules! fixture {
    ($harness:literal, $name:literal) => {
        $crate::host_script::Fixture {
            name: concat!($harness, "/", $name, ".jsonl"),
            text: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/",
                $harness,
                "/",
                $name,
                ".jsonl"
            )),
        }
    };
}
pub(crate) use fixture;

type OpenFuture = Pin<Box<dyn Future<Output = Result<OpenedRuntime, Problem>> + Send>>;

/// What each adapter provides for a scripted process (`claude::scripted()`...): the
/// real adapter, for everything but starting a process, and the real runtime opened
/// over pipes instead of a spawned child.
pub(crate) struct Runtime {
    pub real: Arc<dyn HarnessAdapter>,
    pub capabilities: Capabilities,
    pub open: fn(Io, OpenRequest) -> OpenFuture,
}

/// The harness a script stands in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Harness {
    Claude,
    Codex,
    Antigravity,
}

impl Harness {
    fn runtime(self) -> Runtime {
        match self {
            Self::Claude => crate::claude::scripted(),
            Self::Codex => crate::codex::scripted(),
            Self::Antigravity => crate::antigravity::scripted(),
        }
    }
}

/// What the adapter and the test share.
struct Shared {
    harness: Harness,
    workspace: PathBuf,
    chat_id: String,
    processes: Mutex<VecDeque<Vec<Fixture>>>,
    /// The provider side of the process that is running now.
    current: tokio::sync::Mutex<Option<Peer>>,
    opens: Mutex<Vec<OpenRequest>>,
    /// What went wrong inside the host's own tasks, reported by the test's next call.
    failures: Mutex<Vec<String>>,
}

impl Shared {
    fn fail(&self, message: String) {
        self.failures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(message);
    }

    /// Rewrites a fixture frame for the values the host chose (module docs).
    fn bind(&self, generation: u64, frame: &mut Value) -> Result<(), String> {
        let mut attempts: Option<Vec<String>> = None;
        self.bind_value(generation, frame, &mut attempts)
    }

    fn bind_value(
        &self,
        generation: u64,
        value: &mut Value,
        attempts: &mut Option<Vec<String>>,
    ) -> Result<(), String> {
        match value {
            Value::String(text) => {
                if text == "$ticketd-version" {
                    env!("CARGO_PKG_VERSION").clone_into(text);
                } else if let Some(number) = text
                    .strip_prefix("sub-")
                    .and_then(|number| number.parse::<usize>().ok())
                {
                    let known = attempts.get_or_insert_with(|| self.attempts());
                    let id = number
                        .checked_sub(1)
                        .and_then(|index| known.get(index))
                        .ok_or_else(|| {
                            format!(
                                "the fixture names \"sub-{number}\", the {number}th input sent, but the test has sent {}",
                                known.len()
                            )
                        })?;
                    id.clone_into(text);
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.bind_value(generation, value, attempts)?;
                }
            }
            Value::Object(fields) => {
                for (key, value) in fields.iter_mut() {
                    if self.harness == Harness::Claude && key == "generation" && value.is_number() {
                        *value = generation.into();
                    } else {
                        self.bind_value(generation, value, attempts)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The ids of the inputs sent so far, in order.
    fn attempts(&self) -> Vec<String> {
        let Ok(workspace) = Workspace::open(&self.workspace) else {
            return Vec::new();
        };
        let Ok(snapshot) = workspace.chat_snapshot(&self.chat_id, 5_000) else {
            return Vec::new();
        };
        snapshot
            .items
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Message(message) if message.role == ChatRole::User => Some(message),
                _ => None,
            })
            .flat_map(|message| message.attempts.into_iter().map(|attempt| attempt.id))
            .collect()
    }
}

/// The real adapter in everything but how its process starts.
struct ScriptedAdapter {
    runtime: Runtime,
    shared: Arc<Shared>,
}

#[async_trait]
impl HarnessAdapter for ScriptedAdapter {
    fn harness(&self) -> crate::Harness {
        self.runtime.real.harness()
    }

    fn attachment_refusal(
        &self,
        attachments: &[ticketd_core::ChatAttachmentContent],
    ) -> Option<crate::Refusal> {
        self.runtime.real.attachment_refusal(attachments)
    }

    async fn inspect(&self) -> Inspection {
        Inspection::Installed {
            executable: PathBuf::from("/opt/scripted-harness"),
            version: None,
            login: LoginState::SignedIn,
            capabilities: self.runtime.capabilities.clone(),
        }
    }

    async fn options(&self) -> Result<crate::HarnessOptions, String> {
        self.runtime.real.options().await
    }

    fn permission_before_session(
        &self,
        recorded: Option<&str>,
        picked: Option<&str>,
    ) -> Option<crate::Setting> {
        self.runtime
            .real
            .permission_before_session(recorded, picked)
    }

    fn record_permission(&self, recorded: Option<&str>, value: &str) -> Option<String> {
        self.runtime.real.record_permission(recorded, value)
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let shared = &self.shared;
        let generation = request.generation.0;
        shared
            .opens
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request.clone());
        let process = shared
            .processes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();
        let Some(process) = process else {
            let message = "the host started the harness once more than the test scripted: add another `.process(...)`".to_owned();
            shared.fail(message.clone());
            return Err(failed(message));
        };
        let (mut peer, io) = pipes();
        let parts: Vec<(&str, &str)> = process.iter().map(|part| (part.name, part.text)).collect();
        peer.load_parts(&parts);
        let bound = Arc::clone(shared);
        peer.bind(Box::new(move |frame| bound.bind(generation, frame)));
        // The runtime opens while the fixture plays its handshake. A frame the fixture
        // did not expect ends the play, and then the runtime would wait for the reply
        // that never comes: stop waiting for it.
        let mut opening = (self.runtime.open)(io, request);
        let mut opened = None;
        let played = {
            let mut playing = Box::pin(peer.play_to_mark());
            loop {
                tokio::select! {
                    played = &mut playing => break played,
                    result = &mut opening, if opened.is_none() => opened = Some(result),
                }
            }
        };
        if let Err(message) = played {
            *shared.current.lock().await = Some(peer);
            shared.fail(format!("while the harness was starting, {message}"));
            return Err(failed(message));
        }
        let opened = match opened {
            Some(opened) => opened,
            None => opening.await,
        };
        *shared.current.lock().await = Some(peer);
        opened
    }
}

fn failed(message: String) -> Problem {
    Problem {
        kind: ProblemKind::Other,
        message,
        detail: None,
        resets_at: None,
    }
}

/// Builds a [`HostScript`].
pub(crate) struct Builder {
    harness: Harness,
    processes: Vec<Vec<Fixture>>,
    folder: String,
}

impl Builder {
    /// Scripts one harness process: its transcripts, played back to back. Call once
    /// per start the test expects.
    pub fn process(mut self, parts: impl IntoIterator<Item = Fixture>) -> Self {
        self.processes.push(parts.into_iter().collect());
        self
    }

    /// The Chat's execution folder, which every fixture's working directory must match.
    pub fn folder(mut self, folder: &str) -> Self {
        folder.clone_into(&mut self.folder);
        self
    }

    pub fn start(self) -> HostScript {
        assert_clock_is_paused();
        let dir = tempfile::tempdir().expect("a temporary Workspace folder");
        let path = dir.path().join("workspace.sqlite3");
        let runtime = self.harness.runtime();
        let key = runtime.real.harness().key.as_str().to_owned();
        let harness_name = runtime.real.harness().name;
        let chat = Workspace::open(&path)
            .expect("a temporary Workspace")
            .create_chat(
                None,
                NewChat {
                    title: None,
                    harness: key,
                    execution_folder: self.folder,
                    folder_managed: false,
                    links: Vec::new(),
                },
            )
            .expect("a Chat");
        let shared = Arc::new(Shared {
            harness: self.harness,
            workspace: path.clone(),
            chat_id: chat.id.clone(),
            processes: Mutex::new(self.processes.into()),
            current: tokio::sync::Mutex::new(None),
            opens: Mutex::new(Vec::new()),
            failures: Mutex::new(Vec::new()),
        });
        let opener: WorkspaceOpener = {
            let path = path.clone();
            Arc::new(move || WorkspaceSession::for_file(&path)?.workspace())
        };
        let adapter = ScriptedAdapter {
            runtime,
            shared: Arc::clone(&shared),
        };
        let host = ChatHost::new(opener, vec![Arc::new(adapter) as Arc<dyn HarnessAdapter>])
            .expect("a Chat host");
        HostScript {
            _dir: dir,
            path,
            host,
            chat,
            shared,
            harness_name,
            calls: Vec::new(),
            earlier: Vec::new(),
        }
    }
}

/// Time must be the test's: the clock has to be paused (`start_paused = true`).
fn assert_clock_is_paused() {
    let before = tokio::time::Instant::now();
    std::thread::sleep(Duration::from_millis(3));
    assert!(
        tokio::time::Instant::now() == before,
        "host_script needs a paused clock: write #[tokio::test(start_paused = true)]"
    );
}

/// A Chat host over a scripted harness. See the module documentation.
pub(crate) struct HostScript {
    _dir: TempDir,
    path: PathBuf,
    host: ChatHost,
    chat: Chat,
    shared: Arc<Shared>,
    harness_name: &'static str,
    /// Host calls that wait for the harness to answer: they run in the background so
    /// the test can play the fixture meanwhile, and are checked at the next `settle`.
    calls: Vec<(&'static str, JoinHandle<Result<(), HostError>>)>,
    /// Before a `restart_ticketd`: the hosts that ran then, with the folders they wrote to.
    earlier: Vec<(TempDir, ChatHost)>,
}

impl HostScript {
    pub fn claude() -> Builder {
        Self::builder(Harness::Claude)
    }

    pub fn codex() -> Builder {
        Self::builder(Harness::Codex)
    }

    pub fn antigravity() -> Builder {
        Self::builder(Harness::Antigravity)
    }

    fn builder(harness: Harness) -> Builder {
        Builder {
            harness,
            processes: Vec::new(),
            folder: "/work/chat-1".to_owned(),
        }
    }

    pub fn host(&self) -> &ChatHost {
        &self.host
    }

    pub fn chat_id(&self) -> &str {
        &self.chat.id
    }

    /// The temporary Workspace's file.
    pub fn workspace_path(&self) -> &std::path::Path {
        &self.path
    }

    /// A second handle on the Workspace, for reads the helpers do not cover.
    pub fn core(&self) -> Workspace {
        Workspace::open(&self.path).expect("the temporary Workspace")
    }

    // --- acting ---------------------------------------------------------------

    /// The person sends a message, as the composer does (a new turn when idle).
    pub async fn send(&mut self, text: &str) -> ChatMessage {
        let message = self
            .host
            .send(&self.chat.id, None, text, SendMode::Auto)
            .await
            .expect("the host accepts the message");
        self.settle().await;
        message
    }

    /// The person queues a message without steering the running turn.
    pub async fn queue(&mut self, text: &str) -> ChatMessage {
        let message = self
            .host
            .send(&self.chat.id, None, text, SendMode::Queue)
            .await
            .expect("the host accepts the message");
        self.settle().await;
        message
    }

    /// Allows the one pending approval.
    pub async fn approve(&mut self) {
        self.answer(InteractionAnswer::Approval(ApprovalDecision::Allow))
            .await;
    }

    /// Refuses the one pending approval.
    pub async fn deny(&mut self) {
        self.answer(InteractionAnswer::Approval(ApprovalDecision::Deny))
            .await;
    }

    /// Answers the one pending approval or question. The host's call waits for the
    /// harness's reply, so it runs in the background: `play()` next to let the fixture
    /// see the answer and reply.
    pub async fn answer(&mut self, answer: InteractionAnswer) {
        let pending = self.live().await.interactions;
        let [request] = pending.as_slice() else {
            panic!(
                "answer() needs exactly one pending approval or question, found {}: {pending:?}",
                pending.len()
            );
        };
        let (host, chat, id) = (
            self.host.clone(),
            self.chat.id.clone(),
            request.interaction_id.clone(),
        );
        self.call(
            "answer",
            async move { host.respond(&chat, &id, answer).await },
        )
        .await;
    }

    /// The person presses Stop.
    pub async fn stop(&mut self) {
        let (host, chat) = (self.host.clone(), self.chat.id.clone());
        self.call("stop", async move { host.stop(&chat).await })
            .await;
    }

    /// ticketd quits and starts again over what it stored. Nothing is written on the way
    /// out, as when the process dies: the new host reads a copy of the Workspace as it was,
    /// and takes the next `process` for the harness it starts afterwards. The old host keeps
    /// running on the file it had, unheard.
    pub async fn restart_ticketd(&mut self) {
        let copy = tempfile::tempdir().expect("a temporary Workspace folder");
        let path = copy.path().join("workspace.sqlite3");
        rusqlite::Connection::open(&self.path)
            .and_then(|connection| {
                connection.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
            })
            .expect("a copy of the Workspace as it was");
        let remaining: Vec<Vec<Fixture>> = self
            .shared
            .processes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect();
        let shared = Arc::new(Shared {
            harness: self.shared.harness,
            workspace: path.clone(),
            chat_id: self.chat.id.clone(),
            processes: Mutex::new(remaining.into()),
            current: tokio::sync::Mutex::new(None),
            opens: Mutex::new(Vec::new()),
            failures: Mutex::new(Vec::new()),
        });
        let opener: WorkspaceOpener = {
            let path = path.clone();
            Arc::new(move || WorkspaceSession::for_file(&path)?.workspace())
        };
        let adapter = ScriptedAdapter {
            runtime: self.shared.harness.runtime(),
            shared: Arc::clone(&shared),
        };
        let host = ChatHost::new(opener, vec![Arc::new(adapter) as Arc<dyn HarnessAdapter>])
            .expect("a Chat host");
        let before = std::mem::replace(&mut self.host, host);
        self.earlier
            .push((std::mem::replace(&mut self._dir, copy), before));
        self.path = path;
        self.shared = shared;
        self.settle().await;
    }

    /// The harness process exits with `code`, whatever the fixture still holds.
    pub async fn lose_process(&mut self, code: i32) {
        self.peer().await.exit(code);
        self.settle().await;
    }

    async fn call(
        &mut self,
        name: &'static str,
        call: impl Future<Output = Result<(), HostError>> + Send + 'static,
    ) {
        self.calls.push((name, tokio::spawn(call)));
        self.settle().await;
    }

    // --- the fixture ----------------------------------------------------------

    /// Plays the running harness process up to its next mark, or to its end, then
    /// lets the host run until idle. Returns the mark's name.
    pub async fn play(&mut self) -> Option<String> {
        self.check();
        let played = self.peer().await.play_to_mark().await;
        self.settle().await;
        match played {
            Ok(Played::Mark(name)) => Some(name),
            Ok(Played::End) => None,
            Err(message) => panic!("{message}"),
        }
    }

    /// Plays to the mark called `name` and fails if another is reached first.
    pub async fn play_to(&mut self, name: &str) {
        let reached = self.play().await;
        assert_eq!(
            reached.as_deref(),
            Some(name),
            "the fixture reached a different mark than the test expected"
        );
    }

    /// Plays to the end of the process's fixture, marks included.
    pub async fn play_all(&mut self) {
        while self.play().await.is_some() {}
    }

    /// Lets every task run until all of them wait, and reports a failed call.
    pub async fn settle(&mut self) {
        tokio::time::sleep(Duration::from_millis(1)).await;
        let mut waiting = Vec::new();
        for (name, call) in std::mem::take(&mut self.calls) {
            if call.is_finished() {
                match call.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => panic!("the host refused {name}: {error:?}"),
                    Err(error) => panic!("the host's {name} call panicked: {error}"),
                }
            } else {
                waiting.push((name, call));
            }
        }
        self.calls = waiting;
        self.check();
    }

    /// Lets `duration` pass on the paused clock, running every timer that falls in it.
    pub async fn pass(&mut self, duration: Duration) {
        tokio::time::sleep(duration).await;
        self.settle().await;
    }

    /// Ends the test: the process's whole fixture was played, the adapter wrote
    /// nothing the fixture did not expect, and no call to the host is still waiting.
    pub async fn finish(&mut self) {
        self.settle().await;
        let mut peer = self.peer().await;
        assert!(
            peer.exhausted(),
            "the test ended before the fixture did: play() on to its end"
        );
        let extra = peer.try_written_within(Duration::from_secs(1)).await;
        drop(peer);
        assert!(
            extra.is_none(),
            "the adapter wrote a frame the fixture does not expect: {}",
            extra.unwrap_or_default()
        );
        assert!(
            self.calls.is_empty(),
            "the host is still waiting on: {:?}",
            self.calls.iter().map(|(name, _)| name).collect::<Vec<_>>()
        );
    }

    /// The running process's provider side. Waits (on the paused clock) for the host
    /// to have started it.
    async fn peer(&self) -> tokio::sync::MappedMutexGuard<'_, Peer> {
        for _ in 0..5_000 {
            if let Ok(peer) =
                tokio::sync::MutexGuard::try_map(self.shared.current.lock().await, Option::as_mut)
            {
                return peer;
            }
            self.check();
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!(
            "no harness process is running: the host starts it when the Chat gets its first message (send one first)"
        );
    }

    fn check(&self) {
        let failures = self
            .shared
            .failures
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    // --- asserting ------------------------------------------------------------

    /// The Chat's stored history, oldest first, read from the Workspace as a restart
    /// would find it.
    pub fn items(&self) -> Vec<ChatItem> {
        self.core()
            .chat_snapshot(&self.chat.id, 5_000)
            .expect("the Chat's history")
            .items
    }

    /// One short line per item of the main agent's transcript, in history order:
    /// `you: text`, `agent: text` (`(streaming)` while cut short), `turn <state>`,
    /// `tool <name> <state>`, `approval|question "<prompt>" <state>`, `notice: text`,
    /// `session <id>`, and `sub-agent "<title>" <state>` for each run of a sub-agent
    /// the main agent started. A sub-agent's own Steps are not in it: they are in
    /// `sub_agent_transcript`, as the view shows them only in the sub-agent's view.
    pub fn transcript(&self) -> Vec<String> {
        let snapshot = self
            .core()
            .chat_snapshot(&self.chat.id, 5_000)
            .expect("the Chat's history");
        snapshot
            .items
            .iter()
            .filter(|item| match item {
                ChatItem::Tool(tool) => tool.owner == ChatOwner::Main,
                ChatItem::Message(message) => message.owner == ChatOwner::Main,
                _ => true,
            })
            .filter(|item| match item {
                // A nested sub-agent's row is in its parent's view.
                ChatItem::SubAgentRun(run) => snapshot
                    .sub_agents
                    .iter()
                    .find(|record| record.native_id == run.sub_agent)
                    .is_some_and(|record| record.parent.is_none()),
                _ => true,
            })
            .map(|item| line(item, &snapshot.sub_agents))
            .collect()
    }

    /// The Chat's sub-agents, oldest first.
    pub fn sub_agents(&self) -> Vec<ChatSubAgent> {
        self.core()
            .chat_snapshot(&self.chat.id, 5_000)
            .expect("the Chat's history")
            .sub_agents
    }

    /// What one sub-agent's own view shows, in history order: `tool <name> <state>` for
    /// each Step it ran and `sub-agent "<title>" <state>` for each sub-agent it started.
    pub fn sub_agent_transcript(&self, native_id: &str) -> Vec<String> {
        let snapshot = self
            .core()
            .chat_snapshot(&self.chat.id, 5_000)
            .expect("the Chat's history");
        snapshot
            .items
            .iter()
            .filter(|item| match item {
                ChatItem::Tool(ChatTool { owner, .. })
                | ChatItem::Message(ChatMessage { owner, .. }) => matches!(
                    owner,
                    ChatOwner::SubAgent { native_id: owner } if owner == native_id
                ),
                ChatItem::SubAgentRun(run) => snapshot
                    .sub_agents
                    .iter()
                    .find(|record| record.native_id == run.sub_agent)
                    .is_some_and(|record| record.parent.as_deref() == Some(native_id)),
                _ => false,
            })
            .map(|item| line(item, &snapshot.sub_agents))
            .collect()
    }

    /// Who asked each stored request, and where it stands, oldest first.
    pub fn requests(&self) -> Vec<(ChatOwner, ChatInteractionState)> {
        self.items()
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Interaction(request) => Some((request.owner, request.state)),
                _ => None,
            })
            .collect()
    }

    /// The text of the Chat's stored notices.
    pub fn notices(&self) -> Vec<String> {
        self.items()
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Notice(notice) => Some(notice.text),
                _ => None,
            })
            .collect()
    }

    /// The Chat's turns, oldest first.
    pub fn turns(&self) -> Vec<ChatTurn> {
        self.items()
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Turn(turn) => Some(turn),
                _ => None,
            })
            .collect()
    }

    /// What the host holds in memory about the Chat now: activity, pending requests.
    pub async fn live(&self) -> ChatLive {
        self.host
            .attach(&self.chat.id)
            .await
            .expect("the Chat attaches")
            .0
            .live
    }

    /// The ranked status the Chats list shows for the Chat, from the host's view of
    /// it: what the Chat is doing, its pending requests, how its last turn ended and
    /// whether the person saw that. (The desktop adds conditions only it knows, such
    /// as an unconfirmed delivery, which this leaves out.)
    pub async fn attention(&self) -> Status {
        let (view, _) = self
            .host
            .attach(&self.chat.id)
            .await
            .expect("the Chat attaches");
        let last_turn = view
            .snapshot
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                ChatItem::Turn(turn) => Some(turn),
                _ => None,
            });
        let last_response = view
            .snapshot
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                ChatItem::Message(message)
                    if message.role == ChatRole::Assistant && message.complete =>
                {
                    Some(message.text.as_str())
                }
                _ => None,
            });
        let activity = match view.live.activity {
            Activity::Idle => "idle",
            Activity::Working => "working",
            Activity::WaitingForYou => "waiting",
        };
        // The sub-agents that ask, named as the view names them (the desktop words the
        // card; here it says the plain title and what is asked).
        let asking: Vec<attention::Asking> = view
            .snapshot
            .items
            .iter()
            .filter_map(|item| match item {
                ChatItem::Interaction(request)
                    if request.state == ChatInteractionState::Pending =>
                {
                    let ChatOwner::SubAgent { native_id } = &request.owner else {
                        return None;
                    };
                    let asker = view
                        .snapshot
                        .sub_agents
                        .iter()
                        .find(|record| &record.native_id == native_id)
                        .and_then(|record| record.said("description"))
                        .unwrap_or_else(|| "Sub-agent".to_owned());
                    Some(attention::Asking {
                        interaction_id: request.id.clone(),
                        card: format!("{asker} wants approval for {}", request.prompt),
                        asker,
                    })
                }
                _ => None,
            })
            .collect();
        attention::status(&Facts {
            asking: &asking,
            chat: &view.snapshot.chat,
            harness: self.harness_name,
            live: &view.live,
            last_turn,
            uncertain: None,
            problem: None,
            failure: None,
            activity,
            opening: view.live.opening.is_some(),
            first_change: None,
            files_changed: None,
            last_response,
            stopped_sub_agents: view
                .snapshot
                .items
                .iter()
                .filter_map(|item| match item {
                    ChatItem::Notice(notice) => notice
                        .sub_agents_stopped
                        .map(|count| (notice.position, count)),
                    _ => None,
                })
                .next_back()
                .filter(|(position, _)| last_turn.is_none_or(|turn| turn.position < *position))
                .map(|(_, count)| count),
        })
    }

    /// Every request the host made to start the harness, in order.
    pub fn opens(&self) -> Vec<OpenRequest> {
        self.shared
            .opens
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

fn line(item: &ChatItem, sub_agents: &[ChatSubAgent]) -> String {
    match item {
        ChatItem::Session(session) => format!("session {}", session.native_session_id),
        ChatItem::Message(message) => {
            let who = match message.role {
                ChatRole::User => "you",
                ChatRole::Assistant => "agent",
            };
            let cut = if message.role == ChatRole::Assistant && !message.complete {
                " (streaming)"
            } else {
                ""
            };
            format!("{who}: {}{cut}", message.text)
        }
        ChatItem::Turn(turn) => format!("turn {}", format!("{:?}", turn.state).to_lowercase()),
        ChatItem::Tool(tool) => format!(
            "tool {} {}",
            tool.name,
            format!("{:?}", tool.state).to_lowercase()
        ),
        ChatItem::Interaction(request) => format!(
            "{} {:?} {}",
            format!("{:?}", request.kind).to_lowercase(),
            request.prompt,
            format!("{:?}", request.state).to_lowercase()
        ),
        ChatItem::Notice(notice) => format!("notice: {}", notice.text),
        ChatItem::SubAgentRun(run) => {
            let title = sub_agents
                .iter()
                .find(|record| record.native_id == run.sub_agent)
                .and_then(|record| record.said("description"))
                .unwrap_or_else(|| "Sub-agent".to_owned());
            let resumed = if run.run > 1 { " (resumed)" } else { "" };
            format!(
                "sub-agent {title:?}{resumed} {}",
                format!("{:?}", run.state).to_lowercase()
            )
        }
    }
}
