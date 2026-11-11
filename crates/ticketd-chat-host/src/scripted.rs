//! Test support shared by the adapters: the provider side of a scripted process. A
//! fixture is a JSON-lines transcript of `client` frames the adapter must write,
//! `server` frames the provider sends, and `mark` lines where the test acts.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, duplex};
use tokio::sync::watch;
use tokio::time::timeout;

use crate::stdio::{ChildProcess, Io};
use crate::{EventKind, InteractionKind, TurnOutcome};

/// The provider side of the pipes.
pub(crate) struct Peer {
    from_adapter: BufReader<DuplexStream>,
    to_adapter: Option<DuplexStream>,
    pub stderr: DuplexStream,
    pub exit: Arc<watch::Sender<Option<Option<i32>>>>,
    script: VecDeque<Value>,
}

struct ScriptedChild {
    exit: Arc<watch::Sender<Option<Option<i32>>>>,
}

#[async_trait]
impl ChildProcess for ScriptedChild {
    async fn wait(&mut self) -> Option<i32> {
        let mut exit = self.exit.subscribe();
        let code = exit.wait_for(Option::is_some).await;
        code.ok().and_then(|code| *code).flatten()
    }

    /// A killed process exits without a code.
    async fn kill(&mut self) {
        self.exit.send_replace(Some(None));
    }
}

pub(crate) fn pipes() -> (Peer, Io) {
    let (stdin, from_adapter) = duplex(64 * 1024);
    let (to_adapter, stdout) = duplex(64 * 1024);
    let (stderr_writer, stderr) = duplex(64 * 1024);
    let exit = Arc::new(watch::Sender::new(None));
    let peer = Peer {
        from_adapter: BufReader::new(from_adapter),
        to_adapter: Some(to_adapter),
        stderr: stderr_writer,
        exit: Arc::clone(&exit),
        script: VecDeque::new(),
    };
    let io = Io {
        stdout: Box::new(stdout),
        stdin: Box::new(stdin),
        stderr: Some(Box::new(stderr)),
        child: Box::new(ScriptedChild { exit }),
    };
    (peer, io)
}

impl Peer {
    pub fn load(&mut self, fixture: &str) {
        self.script = fixture
            .lines()
            .map(|line| serde_json::from_str(line).expect("fixture line is JSON"))
            .collect();
    }

    /// Plays the transcript up to the next mark or its end.
    pub async fn play(&mut self) {
        while let Some(step) = self.script.pop_front() {
            if step.get("mark").is_some() {
                return;
            }
            if let Some(frame) = step.get("server") {
                self.send(&format!("{frame}\n")).await;
            } else if let Some(expected) = step.get("client") {
                assert_eq!(&self.written().await, expected);
            }
        }
    }

    pub async fn send(&mut self, line: &str) {
        let stdout = self.to_adapter.as_mut().expect("stdout is open");
        stdout.write_all(line.as_bytes()).await.expect("stdout");
    }

    /// The next frame the adapter wrote.
    pub async fn written(&mut self) -> Value {
        let mut line = String::new();
        timeout(
            Duration::from_secs(5),
            self.from_adapter.read_line(&mut line),
        )
        .await
        .expect("the adapter wrote a frame")
        .expect("stdin");
        serde_json::from_str(&line).expect("the adapter wrote JSON")
    }

    /// Lets every task run until idle, then proves the adapter wrote nothing more.
    pub async fn assert_nothing_written(&mut self) {
        let mut line = String::new();
        let read = timeout(
            Duration::from_secs(1),
            self.from_adapter.read_line(&mut line),
        );
        assert!(read.await.is_err(), "unexpected frame: {line}");
    }

    pub async fn stdin_closed(&mut self) -> bool {
        let mut line = String::new();
        matches!(self.from_adapter.read_line(&mut line).await, Ok(0))
    }

    pub fn exit(&mut self, code: i32) {
        self.exit.send_replace(Some(Some(code)));
        self.to_adapter = None;
    }
}

/// One event in short form, for comparing sequences.
pub(crate) fn brief(kind: &EventKind) -> String {
    match kind {
        EventKind::SessionIdentified { native_session } => format!("session {}", native_session.0),
        EventKind::SubmissionEvidence {
            submission,
            evidence,
        } => format!("evidence {} {evidence:?}", submission.0),
        EventKind::TurnStarted { turn } => format!("turn-started {}", turn.0),
        EventKind::TextDelta { item, text, .. } => format!("delta {} {text:?}", item.0),
        EventKind::MessageCompleted { item, text, .. } => format!("message {} {text:?}", item.0),
        EventKind::ToolUpdated {
            item,
            title,
            status,
            output,
            ..
        } => format!("tool {} {title:?} {status:?} {output:?}", item.0),
        EventKind::InteractionRequested(request) => match &request.kind {
            InteractionKind::Approval {
                description,
                decisions,
            } => format!(
                "approval {} {description:?} {decisions:?}",
                request.request.0
            ),
            InteractionKind::Question { questions } => {
                let question = &questions[0];
                format!(
                    "question {} {} {:?} {:?}",
                    request.request.0, question.id, question.prompt, question.options
                )
            }
        },
        EventKind::InteractionResolved {
            request,
            resolution,
        } => format!("resolved {} {resolution:?}", request.0),
        EventKind::TurnEnded {
            turn,
            outcome,
            submissions,
        } => {
            let outcome = match outcome {
                TurnOutcome::Failed(problem) => format!("Failed({:?})", problem.kind),
                other => format!("{other:?}"),
            };
            let submissions: Vec<&str> = submissions.iter().map(|id| id.0.as_str()).collect();
            format!("turn-ended {} {outcome} {submissions:?}", turn.0)
        }
        EventKind::RuntimeLost { exit_code, .. } => format!("lost {exit_code:?}"),
        EventKind::Notice {
            turn,
            kind,
            message,
            ..
        } => match turn {
            Some(turn) => format!("notice {kind:?} {} {message:?}", turn.0),
            None => format!("notice {kind:?}"),
        },
        EventKind::Unknown { detail, .. } => format!("unknown {}", detail.kind()),
    }
}
