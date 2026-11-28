//! Test support shared by the adapters: the provider side of a scripted process. A
//! fixture is a JSON-lines transcript of `client` frames the adapter must write,
//! `server` frames the provider sends, and `mark` lines where the test acts.
//!
//! `crate::host_script` builds on this to run a whole Chat host over a fixture.

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

/// Rewrites a fixture frame before it is sent or compared, for values a fixture
/// cannot know (see `host_script`'s "values the host chooses"). `Err` says why not.
pub(crate) type Binder = Box<dyn FnMut(&mut Value) -> Result<(), String> + Send>;

/// One line of a fixture and where it came from, for failure messages.
struct Step {
    line: Value,
    at: String,
}

/// How far a call to [`Peer::play_to_mark`] got.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Played {
    /// Stopped at a `mark` line, with its name.
    Mark(String),
    /// The transcript is exhausted.
    End,
}

/// The provider side of the pipes.
pub(crate) struct Peer {
    from_adapter: BufReader<DuplexStream>,
    to_adapter: Option<DuplexStream>,
    pub stderr: DuplexStream,
    pub exit: Arc<watch::Sender<Option<Option<i32>>>>,
    /// Bytes of a frame the adapter has begun to write and a timed-out read has taken.
    partial: Vec<u8>,
    script: VecDeque<Step>,
    binder: Option<Binder>,
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
    pipes_with_input_capacity(64 * 1024)
}

pub(crate) fn pipes_with_input_capacity(capacity: usize) -> (Peer, Io) {
    let (stdin, from_adapter) = duplex(capacity);
    let (to_adapter, stdout) = duplex(64 * 1024);
    let (stderr_writer, stderr) = duplex(64 * 1024);
    let exit = Arc::new(watch::Sender::new(None));
    let peer = Peer {
        from_adapter: BufReader::new(from_adapter),
        to_adapter: Some(to_adapter),
        stderr: stderr_writer,
        exit: Arc::clone(&exit),
        partial: Vec::new(),
        script: VecDeque::new(),
        binder: None,
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
        self.load_parts(&[("fixture", fixture)]);
    }

    /// Loads several named transcripts as one, with a `mark` between them so a test
    /// can act when one part is done (the first part is usually the handshake). Lines
    /// that are none of `client`, `server` and `mark` (the `note`) are skipped.
    pub fn load_parts(&mut self, parts: &[(&str, &str)]) {
        self.script.clear();
        for (index, (name, fixture)) in parts.iter().enumerate() {
            if index > 0 {
                self.script.push_back(Step {
                    line: serde_json::json!({"mark": format!("after {}", parts[index - 1].0)}),
                    at: (*name).to_owned(),
                });
            }
            for (number, line) in fixture.lines().enumerate() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let at = format!("{name}:{}", number + 1);
                let line = serde_json::from_str(line)
                    .unwrap_or_else(|error| panic!("{at} is not JSON: {error}"));
                self.script.push_back(Step { line, at });
            }
        }
    }

    pub fn bind(&mut self, binder: Binder) {
        self.binder = Some(binder);
    }

    /// Whether the transcript has nothing left but marks.
    pub fn exhausted(&self) -> bool {
        self.script
            .iter()
            .all(|step| step.line.get("client").is_none() && step.line.get("server").is_none())
    }

    /// Plays the transcript up to the next mark or its end.
    pub async fn play(&mut self) {
        if let Err(failure) = self.play_to_mark().await {
            panic!("{failure}");
        }
    }

    /// As [`Peer::play`], saying where it stopped, and returning what went wrong as
    /// text instead of panicking: the host's own task opens the runtime, and a panic
    /// there would be lost.
    pub async fn play_to_mark(&mut self) -> Result<Played, String> {
        while let Some(step) = self.script.pop_front() {
            if let Some(mark) = step.line.get("mark") {
                return Ok(Played::Mark(
                    mark.as_str()
                        .map_or_else(|| mark.to_string(), str::to_owned),
                ));
            }
            if let Some(frame) = step.line.get("server") {
                let frame = self.bound(frame, &step.at)?;
                self.send(&format!("{frame}\n")).await;
            } else if let Some(expected) = step.line.get("client") {
                let expected = self.bound(expected, &step.at)?;
                let actual = self
                    .try_written()
                    .await
                    .map_err(|why| format!("{}: {why}", step.at))?;
                let Some(actual) = actual else {
                    return Err(format!(
                        "{}: the fixture expects the adapter to write\n  {}\nbut it wrote nothing in 5 s",
                        step.at,
                        shown(&expected),
                    ));
                };
                if actual != expected {
                    return Err(format!(
                        "{}: the adapter wrote a frame the fixture does not expect\n  fixture: {}\n  adapter: {}\n  first difference: {}",
                        step.at,
                        shown(&expected),
                        shown(&actual),
                        difference(&expected, &actual, "$"),
                    ));
                }
            }
        }
        Ok(Played::End)
    }

    fn bound(&mut self, frame: &Value, at: &str) -> Result<Value, String> {
        let mut frame = frame.clone();
        if let Some(binder) = &mut self.binder {
            binder(&mut frame).map_err(|why| format!("{at}: {why}"))?;
        }
        Ok(frame)
    }

    pub async fn send(&mut self, line: &str) {
        let stdout = self.to_adapter.as_mut().expect("stdout is open");
        stdout.write_all(line.as_bytes()).await.expect("stdout");
    }

    /// The next frame the adapter wrote, or `None` when it wrote none in 5 s. An
    /// `Err` says the adapter wrote something that is not a JSON frame.
    pub async fn try_written(&mut self) -> Result<Option<Value>, String> {
        self.try_written_within(Duration::from_secs(5)).await
    }

    /// As [`Peer::try_written`], waiting `wait`. A frame the adapter has only begun
    /// to write when the wait ends stays buffered: the next call returns it whole.
    pub async fn try_written_within(&mut self, wait: Duration) -> Result<Option<Value>, String> {
        let read = timeout(wait, self.from_adapter.read_until(b'\n', &mut self.partial)).await;
        let Ok(read) = read else {
            return Ok(None);
        };
        read.map_err(|error| format!("reading the adapter's output failed: {error}"))?;
        if self.partial.is_empty() {
            return Ok(None);
        }
        let line = std::mem::take(&mut self.partial);
        serde_json::from_slice(&line).map(Some).map_err(|error| {
            format!(
                "the adapter wrote something that is not JSON ({error}): {}",
                String::from_utf8_lossy(&line).trim_end()
            )
        })
    }

    /// The next frame the adapter wrote.
    pub async fn written(&mut self) -> Value {
        self.try_written()
            .await
            .unwrap_or_else(|why| panic!("{why}"))
            .expect("the adapter wrote a frame")
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

/// A frame on one line, cut where it would flood a failure message.
fn shown(frame: &Value) -> String {
    let text = frame.to_string();
    match text.char_indices().nth(1500) {
        Some((cut, _)) => format!("{}... ({} bytes)", &text[..cut], text.len()),
        None => text,
    }
}

/// Where two frames first differ, as a path with both values.
fn difference(expected: &Value, actual: &Value, path: &str) -> String {
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => {
            for (key, value) in expected {
                match actual.get(key) {
                    None => return format!("{path}.{key} is missing from the adapter's frame"),
                    Some(other) if other != value => {
                        return difference(value, other, &format!("{path}.{key}"));
                    }
                    Some(_) => {}
                }
            }
            match actual.keys().find(|key| !expected.contains_key(*key)) {
                Some(key) => format!("{path}.{key} is not in the fixture's frame"),
                None => "none".to_owned(),
            }
        }
        (Value::Array(expected), Value::Array(actual)) if expected.len() == actual.len() => {
            for (index, (value, other)) in expected.iter().zip(actual).enumerate() {
                if value != other {
                    return difference(value, other, &format!("{path}[{index}]"));
                }
            }
            "none".to_owned()
        }
        _ => format!(
            "{path}: fixture {}, adapter {}",
            shown(expected),
            shown(actual)
        ),
    }
}

fn files_brief(files: &[crate::FileChange]) -> String {
    let files: Vec<String> = files
        .iter()
        .map(|file| {
            let counts = match (file.added_lines, file.removed_lines) {
                (Some(added), Some(removed)) => format!(" +{added} -{removed}"),
                _ => String::new(),
            };
            let unconfirmed = if file.confirmed { "" } else { " unconfirmed" };
            format!("{:?} {}{counts}{unconfirmed}", file.kind, file.path)
        })
        .collect();
    format!("files {files:?}")
}

/// One event in short form, for comparing sequences.
pub(crate) fn brief(kind: &EventKind) -> String {
    match kind {
        EventKind::SessionIdentified { native_session } => format!("session {}", native_session.0),
        EventKind::SubmissionEvidence {
            submission,
            evidence,
        } => format!("evidence {} {evidence:?}", submission.0),
        EventKind::TurnStarted { turn, origin } => match origin {
            None => format!("turn-started {}", turn.0),
            Some(origin) => format!("turn-started {} by {origin:?}", turn.0),
        },
        EventKind::TextDelta { item, text, .. } => format!("delta {} {text:?}", item.0),
        EventKind::MessageCompleted { item, text, .. } => format!("message {} {text:?}", item.0),
        EventKind::ToolUpdated {
            item,
            title,
            status,
            output,
            ..
        } => format!("tool {} {title:?} {status:?} {output:?}", item.0),
        EventKind::SubAgentStarted(start) => format!(
            "sub-agent-started {} run {:?} parent {:?} tool {:?} background {} {}",
            start.sub_agent.0,
            start.run,
            start.parent.as_ref().map(|parent| parent.0.as_str()),
            start.tool.as_ref().map(|tool| tool.0.as_str()),
            start.background,
            start.native
        ),
        EventKind::SubAgentUpdated {
            sub_agent,
            run,
            background,
            native,
        } => format!(
            "sub-agent-updated {} run {run:?} background {background:?} {native:?}",
            sub_agent.0
        ),
        EventKind::SubAgentEnded {
            sub_agent,
            run,
            outcome,
            detail,
        } => format!(
            "sub-agent-ended {} run {run:?} {outcome:?} {detail:?}",
            sub_agent.0
        ),
        EventKind::SubAgentToolUpdated {
            sub_agent,
            item,
            title,
            status,
            output,
            ..
        } => format!(
            "sub-agent-tool {} {} {title:?} {status:?} {output:?}",
            sub_agent.0, item.0
        ),
        EventKind::SubAgentMessage {
            sub_agent,
            item,
            text,
        } => format!("sub-agent-message {} {} {text:?}", sub_agent.0, item.0),
        EventKind::SubAgentReasoningUpdated {
            sub_agent,
            run,
            item,
            running,
            started_at,
            ended_at,
            text,
        } => format!(
            "sub-agent-reasoning {} run {run:?} {} {} {started_at:?} {ended_at:?} {text:?}",
            sub_agent.0,
            item.0,
            if *running { "running" } else { "done" }
        ),
        EventKind::SubAgentFilesChanged {
            sub_agent,
            run,
            files,
        } => format!(
            "sub-agent-{} {} run {run:?}",
            files_brief(files),
            sub_agent.0
        ),
        EventKind::InteractionRequested(request) => match &request.kind {
            InteractionKind::Approval {
                description,
                reason,
                decisions,
            } => format!(
                "approval {} {description:?} {reason:?} {decisions:?}",
                request.request.0
            ),
            InteractionKind::NativeApproval {
                description,
                reason,
                options,
            } => format!(
                "approval {} {description:?} {reason:?} {options:?}",
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
        EventKind::TurnEvidence { turn, evidence } => {
            let mut said = Vec::new();
            if evidence.interrupt_written {
                said.push("interrupt-written".to_owned());
            }
            if let Some(denied) = &evidence.denied {
                said.push(format!("denied {denied:?}"));
            }
            if let Some(why) = &evidence.not_started {
                said.push(format!("not-started {why:?}"));
            }
            format!("turn-evidence {} {}", turn.0, said.join(", "))
        }
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
        EventKind::ReasoningUpdated {
            item,
            running,
            started_at,
            ended_at,
            text,
            heading,
            ..
        } => format!(
            "reasoning {} {} {started_at:?} {ended_at:?} {text:?} {heading:?}",
            item.0,
            if *running { "running" } else { "done" }
        ),
        EventKind::PlanUpdated { plan, .. } => {
            let steps: Vec<String> = plan
                .steps
                .iter()
                .map(|step| match &step.active_label {
                    Some(label) => format!("{:?} {} ({label})", step.status, step.text),
                    None => format!("{:?} {}", step.status, step.text),
                })
                .collect();
            format!("plan {steps:?} {:?}", plan.explanation)
        }
        EventKind::FilesChanged { files, .. } => files_brief(files),
        EventKind::ContextUsage(usage) => format!(
            "context {} of {} {:?} {:?}",
            usage.used,
            usage.window,
            usage
                .categories
                .iter()
                .map(|category| format!("{} {}", category.name, category.tokens))
                .collect::<Vec<_>>(),
            usage.compacts_at
        ),
        EventKind::Compacted => "compacted".to_owned(),
        EventKind::CommandsListed(commands) => format!(
            "commands {}",
            commands
                .iter()
                .map(|command| command.name.as_str())
                .collect::<Vec<_>>()
                .join(",")
        ),
        EventKind::SettingsState(settings) => {
            let one = |name: &str, setting: &Option<crate::Setting>| match setting {
                None => String::new(),
                Some(setting) => {
                    let options: Vec<&str> =
                        setting.options.iter().map(|o| o.id.as_str()).collect();
                    let answered = setting
                        .answered_by
                        .as_ref()
                        .map_or(String::new(), |model| format!(" answered by {model}"));
                    let fixed = if setting.unchangeable.is_some() {
                        " fixed"
                    } else {
                        ""
                    };
                    format!(
                        " {name}={}{options:?}{fixed}{answered}",
                        setting.current.as_deref().unwrap_or("?")
                    )
                }
            };
            format!(
                "settings{}{}{}",
                one("model", &settings.model),
                one("effort", &settings.effort),
                one("permission", &settings.permission)
            )
        }
        EventKind::Unknown { detail, .. } => format!("unknown {}", detail.kind()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_frame_cut_off_by_a_timed_out_read_arrives_whole_on_the_next() {
        let (mut peer, mut io) = pipes();
        io.stdin.write_all(br#"{"cmd":"su"#).await.expect("stdin");
        assert_eq!(
            peer.try_written_within(Duration::from_millis(10)).await,
            Ok(None)
        );
        io.stdin.write_all(b"bmit\"}\n").await.expect("stdin");
        assert_eq!(
            peer.try_written().await,
            Ok(Some(serde_json::json!({"cmd": "submit"})))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_frame_that_is_not_json_is_returned_as_an_error_not_a_panic() {
        let (mut peer, mut io) = pipes();
        io.stdin.write_all(b"not json\n").await.expect("stdin");
        let error = peer.try_written().await.expect_err("it is not JSON");
        assert!(
            error.contains("not JSON") && error.contains("not json"),
            "{error}"
        );
        // The bad line is consumed: the next frame reads cleanly.
        io.stdin.write_all(b"{\"ok\":true}\n").await.expect("stdin");
        assert_eq!(
            peer.try_written().await,
            Ok(Some(serde_json::json!({"ok": true})))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn play_to_mark_reports_a_malformed_frame_where_the_fixture_expected_one() {
        let (mut peer, mut io) = pipes();
        peer.load(r#"{"client":{"ok":true}}"#);
        io.stdin.write_all(b"{oops\n").await.expect("stdin");
        let failure = peer.play_to_mark().await.expect_err("it is not JSON");
        assert!(failure.starts_with("fixture:1:"), "{failure}");
    }
}
