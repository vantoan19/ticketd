//! A newline-delimited JSON-RPC connection over a harness's stdio.
//!
//! One reader applies incoming frames in wire order, including late replies. Harnesses
//! interpret messages through a synchronous handler. Writes and deferred answers run
//! independently of the reader.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, BufReader};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, mpsc, oneshot};
use tokio::time::{Instant, timeout};

use crate::stdio::{
    ChildProcess, Io, Line, Reader, StderrTail, Writer, close_outcome, read_line, runtime_lost,
    write_bounded,
};
use crate::{
    AutomationPromptAdmission, CloseOutcome, EVENT_BUFFER, EventKind, EventStream, Harness,
    Refusal, RuntimeEvent, RuntimeGeneration, WRITE_TIMEOUT,
};

/// Largest protocol frame kept. A completed item can carry a whole command output.
pub(crate) const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Timed-out requests remembered so a late reply reconciles instead of looking unknown.
const MAX_TOMBSTONES: usize = 64;
/// Includes deferred work and replies waiting for the input pipe.
const MAX_PENDING_RESPONSES: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

pub(crate) type Reply = Result<Value, RpcError>;

#[derive(Debug, PartialEq)]
enum Frame {
    Reply { id: Value, reply: Reply },
    Incoming(Incoming),
}

#[derive(Debug, PartialEq)]
pub(crate) enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// A reply with no matching request, including one that already resolved.
    UnknownReply {
        id: Value,
    },
    /// A line that is not a JSON-RPC message. Its content is not kept.
    Malformed {
        bytes: usize,
    },
    /// A line longer than the frame bound, skipped without buffering it.
    Oversized {
        bytes: usize,
    },
}

/// Reads the next frame, or `None` at end of stream. Memory use is bounded by
/// `max_bytes`.
async fn read_frame<R>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Frame>>
where
    R: AsyncBufRead + Unpin,
{
    Ok(read_line(reader, max_bytes).await?.map(|line| match line {
        Line::Complete(line) => parse_frame(&line),
        Line::Oversized { bytes } => Frame::Incoming(Incoming::Oversized { bytes }),
    }))
}

fn parse_frame(line: &[u8]) -> Frame {
    let malformed = Frame::Incoming(Incoming::Malformed { bytes: line.len() });
    let Ok(Value::Object(mut message)) = serde_json::from_slice::<Value>(line) else {
        return malformed;
    };
    let id = message.remove("id").filter(|id| !id.is_null());
    if let Some(Value::String(method)) = message.remove("method") {
        let params = message.remove("params").unwrap_or(Value::Null);
        return Frame::Incoming(match id {
            Some(id) => Incoming::Request { id, method, params },
            None => Incoming::Notification { method, params },
        });
    }
    let Some(id) = id else {
        return malformed;
    };
    if let Some(error) = message.remove("error") {
        let reply = Err(RpcError {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            data: error.get("data").cloned().unwrap_or(Value::Null),
        });
        return Frame::Reply { id, reply };
    }
    match message.remove("result") {
        Some(result) => Frame::Reply {
            id,
            reply: Ok(result),
        },
        None => malformed,
    }
}

/// One serialized frame with its line terminator.
fn encode(mut frame: Value, include_version: bool) -> Vec<u8> {
    if include_version && let Value::Object(fields) = &mut frame {
        fields.insert("jsonrpc".to_owned(), json!("2.0"));
    }
    let mut line = frame.to_string().into_bytes();
    line.push(b'\n');
    line
}

/// Outgoing requests awaiting a reply, plus tombstones for those that timed out.
#[derive(Debug)]
struct Pending<C> {
    waiting: HashMap<u64, (C, oneshot::Sender<Reply>)>,
    tombstones: VecDeque<(u64, C)>,
}

enum Resolved<C> {
    Waiting(C, oneshot::Sender<Reply>),
    /// The caller stopped waiting; the reply is late evidence.
    Late(C),
    Unknown,
}

impl<C> Pending<C> {
    pub fn new() -> Self {
        Self {
            waiting: HashMap::new(),
            tombstones: VecDeque::new(),
        }
    }

    pub fn register(&mut self, id: u64, context: C) -> oneshot::Receiver<Reply> {
        let (sender, receiver) = oneshot::channel();
        self.waiting.insert(id, (context, sender));
        receiver
    }

    /// Takes the request a reply belongs to. Each request resolves once.
    pub fn resolve(&mut self, id: &Value) -> Resolved<C> {
        let Some(id) = id.as_u64() else {
            return Resolved::Unknown;
        };
        if let Some((context, sender)) = self.waiting.remove(&id) {
            return Resolved::Waiting(context, sender);
        }
        match self.tombstones.iter().position(|(dead, _)| *dead == id) {
            Some(index) => match self.tombstones.remove(index) {
                Some((_, context)) => Resolved::Late(context),
                None => Resolved::Unknown,
            },
            None => Resolved::Unknown,
        }
    }

    /// Stops waiting for a reply but remembers the request. Returns false when the
    /// reply already arrived, in which case the caller's receiver holds it.
    pub fn abandon(&mut self, id: u64) -> bool {
        let Some((context, _sender)) = self.waiting.remove(&id) else {
            return false;
        };
        if self.tombstones.len() == MAX_TOMBSTONES {
            self.tombstones.pop_front();
        }
        self.tombstones.push_back((id, context));
        true
    }

    /// The runtime is gone: every waiter observes a dropped sender.
    pub fn fail_all(&mut self) {
        self.waiting.clear();
        self.tombstones.clear();
    }
}

/// The harness's synchronous interpretation of incoming messages. Handlers run in
/// arrival order, under the same lock as command preparation.
pub(crate) trait Peer: Send + 'static {
    type Call: Send;

    fn replied(&mut self, call: Self::Call, reply: &Reply, late: bool) -> Vec<EventKind>;
    fn received(&mut self, incoming: Incoming) -> (Vec<EventKind>, Option<Response>);
    /// Retains buffered observations before the reader announces a loss.
    fn retain_on_loss(&mut self, _events: &mut Vec<EventKind>) {}
    fn disconnected(&mut self);
}

/// An automatic response to a harness request. An expensive answer can run on a
/// separate task while the reader keeps applying incoming frames.
pub(crate) enum Response {
    Immediate(Value),
    Deferred(Pin<Box<dyn Future<Output = Value> + Send>>),
}

pub(crate) struct Options {
    pub harness: Harness,
    /// Add the JSON-RPC 2.0 version member to outgoing messages. The reader
    /// accepts messages with or without the member.
    pub include_version: bool,
    pub reply_timeout: Duration,
}

pub(crate) enum WriteFailure {
    /// A check failed; nothing was written.
    Refused(Refusal),
    /// The write failed part-way or the pipe is broken; delivery is unknown.
    Lost,
}

pub(crate) enum CallOutcome {
    Refused(Refusal),
    Reply(Value),
    /// The harness answered with a JSON-RPC error.
    Error(RpcError),
    /// Written, no reply in time. A tombstone remains for a late reply.
    TimedOut,
    /// Written or possibly written, then the process went away.
    Lost,
}

pub(crate) struct State<P: Peer> {
    closed: bool,
    pub peer: P,
    next_id: u64,
    pending: Pending<P::Call>,
}

impl<P: Peer> State<P> {
    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    /// Disconnects the peer and returns whether the runtime was still open.
    fn disconnect(&mut self) -> bool {
        let was_open = !self.closed;
        // Retire any peer work before releasing callers waiting on the connection.
        self.peer.disconnected();
        self.closed = true;
        self.pending.fail_all();
        was_open
    }

    fn lose_connection(&mut self, events: &mut Vec<EventKind>) -> bool {
        if !self.closed {
            self.peer.retain_on_loss(events);
        }
        self.disconnect()
    }

    fn apply(&mut self, frame: Frame) -> (Vec<EventKind>, Option<Response>) {
        let (id, reply) = match frame {
            Frame::Reply { id, reply } => (id, reply),
            Frame::Incoming(incoming) => return self.peer.received(incoming),
        };
        let events = match self.pending.resolve(&id) {
            // Apply evidence before the caller can act on the reply. A dropped
            // receiver means the caller stopped waiting before its own timeout.
            Resolved::Waiting(call, sender) if !sender.is_closed() => {
                let events = self.peer.replied(call, &reply, false);
                let _ = sender.send(reply);
                events
            }
            Resolved::Waiting(call, _) | Resolved::Late(call) => {
                self.peer.replied(call, &reply, true)
            }
            Resolved::Unknown => return self.peer.received(Incoming::UnknownReply { id }),
        };
        (events, None)
    }
}

pub(crate) struct Connection<P: Peer> {
    state: Mutex<State<P>>,
    stdin: AsyncMutex<Option<Writer>>,
    child: AsyncMutex<Box<dyn ChildProcess>>,
    stderr: StderrTail,
    options: Options,
    generation: RuntimeGeneration,
}

impl<P: Peer> Connection<P> {
    pub(crate) fn start(
        io: Io,
        peer: P,
        generation: RuntimeGeneration,
        options: Options,
    ) -> (Arc<Self>, EventStream, mpsc::Sender<RuntimeEvent>) {
        let stderr = StderrTail::default();
        if let Some(pipe) = io.stderr {
            stderr.clone().spawn_drain(pipe, options.harness);
        }
        let connection = Arc::new(Self {
            state: Mutex::new(State {
                closed: false,
                peer,
                next_id: 1,
                pending: Pending::new(),
            }),
            stdin: AsyncMutex::new(Some(io.stdin)),
            child: AsyncMutex::new(io.child),
            stderr,
            options,
            generation,
        });
        let (sender, events) = mpsc::channel(EVENT_BUFFER);
        tokio::spawn(Arc::clone(&connection).read(io.stdout, sender.clone()));
        (connection, events, sender)
    }

    pub(crate) fn generation(&self) -> RuntimeGeneration {
        self.generation
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, State<P>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn stderr(&self) -> String {
        self.stderr.snapshot()
    }

    /// Runs the final state checks after obtaining the input pipe, so nothing can
    /// write between the checks and the start of the write.
    async fn write_checked<T, Frames: IntoIterator<Item = Value>>(
        &self,
        prepare: impl FnOnce(&mut State<P>) -> Result<(Frames, T), Refusal>,
        admission: Option<AutomationPromptAdmission>,
    ) -> Result<T, WriteFailure> {
        let mut stdin = self.stdin.lock().await;
        let _prompt = AutomationPromptAdmission::for_write(admission)
            .await
            .map_err(WriteFailure::Refused)?;
        let (frames, prepared) = {
            let mut state = self.state();
            if state.closed {
                return Err(WriteFailure::Refused(Refusal::RuntimeClosed));
            }
            prepare(&mut state).map_err(WriteFailure::Refused)?
        };
        let deadline = Instant::now() + WRITE_TIMEOUT;
        for frame in frames {
            let bytes = encode(frame, self.options.include_version);
            let remaining = deadline.saturating_duration_since(Instant::now());
            write_bounded(&mut stdin, &self.child, &bytes, remaining)
                .await
                .map_err(|_| WriteFailure::Lost)?;
        }
        Ok(prepared)
    }

    pub(crate) async fn write(
        &self,
        prepare: impl FnOnce(&mut P) -> Result<Value, Refusal>,
    ) -> Result<(), WriteFailure> {
        self.write_frames(|peer| Ok([prepare(peer)?])).await
    }

    /// Writes a checked sequence under one input lock and one deadline.
    pub(crate) async fn write_frames<Frames: IntoIterator<Item = Value>>(
        &self,
        prepare: impl FnOnce(&mut P) -> Result<Frames, Refusal>,
    ) -> Result<(), WriteFailure> {
        self.write_checked(|state| Ok((prepare(&mut state.peer)?, ())), None)
            .await
    }

    /// Sends one request and waits a bounded time for its reply. Registration and
    /// command preparation use the same lock as frame application.
    pub(crate) async fn call(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
    ) -> CallOutcome {
        self.call_with_admission(method, prepare, None).await
    }

    pub(crate) async fn call_with_admission(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
        admission: Option<AutomationPromptAdmission>,
    ) -> CallOutcome {
        let written = self
            .send_request_with_admission(method, prepare, admission)
            .await;
        let (id, mut receiver) = match written {
            Ok(registered) => registered,
            Err(WriteFailure::Refused(refusal)) => return CallOutcome::Refused(refusal),
            Err(WriteFailure::Lost) => return CallOutcome::Lost,
        };
        let reply = match timeout(self.options.reply_timeout, &mut receiver).await {
            Ok(reply) => reply.ok(),
            // The reply may have raced the timeout; then the receiver holds it.
            Err(_) if self.state().pending.abandon(id) => return CallOutcome::TimedOut,
            Err(_) => receiver.try_recv().ok(),
        };
        match reply {
            Some(Ok(result)) => CallOutcome::Reply(result),
            Some(Err(error)) => CallOutcome::Error(error),
            None => CallOutcome::Lost,
        }
    }

    /// Writes a request whose eventual reply is handled by the reader.
    pub(crate) async fn send_request(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
    ) -> Result<(u64, oneshot::Receiver<Reply>), WriteFailure> {
        self.send_request_with_admission(method, prepare, None)
            .await
    }

    async fn send_request_with_admission(
        &self,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
        admission: Option<AutomationPromptAdmission>,
    ) -> Result<(u64, oneshot::Receiver<Reply>), WriteFailure> {
        self.write_checked(
            |state| {
                let (params, call) = prepare(&mut state.peer)?;
                let id = state.next_id;
                state.next_id += 1;
                let receiver = state.pending.register(id, call);
                let frame = json!({"id": id, "method": method, "params": params});
                Ok(([frame], (id, receiver)))
            },
            admission,
        )
        .await
    }

    pub(crate) async fn close(&self, bound: Duration, who: &str, may_run: &str) -> CloseOutcome {
        self.state().disconnect();
        close_outcome(&self.stdin, &self.child, bound, who, may_run).await
    }

    /// Releases the input pipe if a runtime is dropped without an explicit close.
    pub(crate) fn close_on_drop(&self) {
        self.state().disconnect();
        if let Ok(mut stdin) = self.stdin.try_lock() {
            *stdin = None;
        }
    }

    async fn read(self: Arc<Self>, stdout: Reader, events: mpsc::Sender<RuntimeEvent>) {
        let generation = self.generation;
        let mut stdout = BufReader::new(stdout);
        let response_slots = Arc::new(Semaphore::new(MAX_PENDING_RESPONSES));
        let (was_open, tail, saturation) = loop {
            let frame = read_frame(&mut stdout, MAX_FRAME_BYTES).await;
            let response = {
                let mut state = self.state();
                let Ok(Some(frame)) = frame else {
                    let mut tail = Vec::new();
                    break (state.lose_connection(&mut tail), tail, None);
                };
                let (kinds, response) = state.apply(frame);
                // Reserve the entire batch without waiting. On saturation the
                // runtime stops here, keeping its final observed frame intact.
                match events.try_reserve_many(kinds.len()) {
                    Ok(permits) => {
                        for (permit, kind) in permits.zip(kinds) {
                            permit.send(RuntimeEvent { generation, kind });
                        }
                    }
                    Err(mpsc::error::TrySendError::Full(())) if !events.is_closed() => {
                        let mut tail = kinds;
                        break (
                            state.lose_connection(&mut tail),
                            tail,
                            Some("the harness event buffer filled"),
                        );
                    }
                    // Some callers intentionally discard events while using RPC.
                    Err(_) => {}
                }
                response
            };
            if let Some(response) = response {
                // A full input pipe or a slow answer must leave the reader free.
                let Ok(slot) = Arc::clone(&response_slots).try_acquire_owned() else {
                    let mut tail = Vec::new();
                    break (
                        self.state().lose_connection(&mut tail),
                        tail,
                        Some("the harness response queue filled"),
                    );
                };
                let connection = Arc::clone(&self);
                tokio::spawn(async move {
                    let _slot = slot;
                    let frame = match response {
                        Response::Immediate(frame) => frame,
                        Response::Deferred(answer) => answer.await,
                    };
                    let _ = connection.write(|_| Ok(frame)).await;
                });
            }
        };
        drop(stdout);
        let loss = if was_open {
            let mut loss = runtime_lost(&self.stdin, &self.child, &self.stderr).await;
            if let (Some(reason), EventKind::RuntimeLost { diagnostics, .. }) =
                (saturation, &mut loss)
            {
                if !diagnostics.is_empty() {
                    diagnostics.insert(0, '\n');
                }
                diagnostics.insert_str(0, reason);
            }
            Some(loss)
        } else {
            None
        };
        drop(self);
        // No further RPC can succeed. Deliver remaining observations before the
        // terminal event, after the observations already in the channel.
        for kind in tail.into_iter().chain(loss) {
            if events
                .send(RuntimeEvent { generation, kind })
                .await
                .is_err()
            {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::BufReader;

    use super::*;

    async fn frames(input: &[u8], max_bytes: usize) -> Vec<Frame> {
        let mut reader = BufReader::with_capacity(8, input);
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = read_frame(&mut reader, max_bytes).await {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn versioned_framing_writes_json_rpc_2_0_messages() {
        for mut message in [
            json!({"id": 1, "method": "initialize", "params": {}}),
            json!({"method": "session/cancel", "params": {"sessionId": "s"}}),
            json!({"id": "server-1", "result": null}),
            json!({"id": "server-2", "error": {"code": -32601, "message": "unknown"}}),
        ] {
            let line = encode(message.clone(), true);
            assert_eq!(line.last(), Some(&b'\n'));
            message["jsonrpc"] = json!("2.0");
            assert_eq!(serde_json::from_slice::<Value>(&line).ok(), Some(message));
        }
    }

    struct EchoPeer;

    impl Peer for EchoPeer {
        type Call = ();

        fn replied(&mut self, (): (), reply: &Reply, _: bool) -> Vec<EventKind> {
            if matches!(reply, Ok(result) if result == "completed") {
                return vec![EventKind::TurnEnded {
                    turn: crate::NativeTurnId::new("turn"),
                    outcome: crate::TurnOutcome::Completed,
                    submissions: vec![crate::SubmissionId::new("first")],
                }];
            }
            Vec::new()
        }

        fn received(&mut self, incoming: Incoming) -> (Vec<EventKind>, Option<Response>) {
            let response = match incoming {
                Incoming::Request { id, method, params } if method == "example/echo" => {
                    Some(Response::Immediate(json!({"id": id, "result": params})))
                }
                Incoming::Notification { method, params } if method == "example/progress" => {
                    return (
                        vec![EventKind::TextDelta {
                            turn: crate::NativeTurnId::new("turn"),
                            item: crate::NativeItemId::new("item"),
                            text: params.to_string(),
                        }],
                        None,
                    );
                }
                _ => None,
            };
            (Vec::new(), response)
        }

        fn disconnected(&mut self) {}
    }

    #[tokio::test]
    async fn a_versioned_peer_answers_incoming_requests_while_waiting_for_a_reply() {
        let (mut peer, io) = crate::scripted::pipes();
        let (connection, _events, _) = Connection::start(
            io,
            EchoPeer,
            RuntimeGeneration(1),
            Options {
                harness: &ticketd_core::harnesses::CLAUDE_CODE,
                include_version: true,
                reply_timeout: Duration::from_secs(5),
            },
        );
        let command = tokio::spawn(async move {
            connection
                .call("example/start", |_| Ok((json!({}), ())))
                .await
        });
        assert_eq!(
            peer.written().await,
            json!({"jsonrpc": "2.0", "id": 1, "method": "example/start", "params": {}})
        );

        peer.send(
            "{\"jsonrpc\":\"2.0\",\"id\":\"server-1\",\"method\":\"example/echo\",\"params\":{\"a\":1}}\n",
        )
        .await;
        assert_eq!(
            peer.written().await,
            json!({"jsonrpc": "2.0", "id": "server-1", "result": {"a": 1}})
        );

        peer.send("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":true}\n")
            .await;
        assert!(matches!(
            command.await,
            Ok(CallOutcome::Reply(Value::Bool(true)))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_event_stream_preserves_reply_evidence_and_reports_saturation() {
        let (mut peer, io) = crate::scripted::pipes();
        let generation = RuntimeGeneration(13);
        let (connection, mut events, _) = Connection::start(
            io,
            EchoPeer,
            generation,
            Options {
                harness: &ticketd_core::harnesses::CODEX,
                include_version: false,
                reply_timeout: Duration::from_secs(1),
            },
        );
        let call = |method| {
            let connection = Arc::clone(&connection);
            tokio::spawn(async move { connection.call(method, |_| Ok((json!({}), ()))).await })
        };
        let first = call("example/first");
        let first_id = peer.written().await["id"].clone();
        let second = call("example/second");
        let second_id = peer.written().await["id"].clone();

        for sequence in 0..EVENT_BUFFER {
            let frame = json!({"method": "example/progress", "params": sequence});
            peer.send(&format!("{frame}\n")).await;
        }
        peer.send("{\"id\":\"server-1\",\"method\":\"example/echo\",\"params\":true}\n")
            .await;
        assert_eq!(
            peer.written().await,
            json!({"id": "server-1", "result": true})
        );

        let first_reply = json!({"id": first_id, "result": "completed"});
        let second_reply = json!({"id": second_id, "result": true});
        peer.send(&format!("{first_reply}\n{second_reply}\n")).await;
        assert!(matches!(first.await, Ok(CallOutcome::Reply(result)) if result == "completed"));
        assert!(matches!(second.await, Ok(CallOutcome::Lost)));
        assert!(matches!(
            connection
                .call("example/third", |_| Ok((json!({}), ())))
                .await,
            CallOutcome::Refused(Refusal::RuntimeClosed)
        ));
        peer.exit(23);

        for sequence in 0..EVENT_BUFFER {
            assert!(matches!(
                events.recv().await,
                Some(RuntimeEvent { generation: observed, kind: EventKind::TextDelta { text, .. } })
                    if observed == generation && text == sequence.to_string()
            ));
        }
        assert_eq!(
            events.recv().await,
            Some(RuntimeEvent {
                generation,
                kind: EventKind::TurnEnded {
                    turn: crate::NativeTurnId::new("turn"),
                    outcome: crate::TurnOutcome::Completed,
                    submissions: vec![crate::SubmissionId::new("first")],
                },
            })
        );
        assert!(matches!(
            events.recv().await,
            Some(RuntimeEvent { generation: observed, kind: EventKind::RuntimeLost { exit_code: Some(23), diagnostics } })
                if observed == generation && diagnostics.contains("event buffer")
        ));
        assert_eq!(events.recv().await, None);
    }

    #[tokio::test]
    async fn classifies_replies_requests_and_notifications() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32600,\"message\":\"no\"}}\n",
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":\"srv-1\",\"method\":\"example/request\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"example/notification\",\"params\":{\"a\":1}}\n",
            "not json\n",
            "{\"id\":3}\n",
            "{\"id\":4,\"result\":{}",
        );

        let frames = frames(input.as_bytes(), 1024).await;

        assert_eq!(
            frames,
            vec![
                Frame::Reply {
                    id: json!(1),
                    reply: Ok(json!({"ok": true})),
                },
                Frame::Reply {
                    id: json!(2),
                    reply: Err(RpcError {
                        code: -32600,
                        message: "no".to_owned(),
                        data: Value::Null,
                    }),
                },
                Frame::Incoming(Incoming::Request {
                    id: json!("srv-1"),
                    method: "example/request".to_owned(),
                    params: json!({}),
                }),
                Frame::Incoming(Incoming::Notification {
                    method: "example/notification".to_owned(),
                    params: json!({"a": 1}),
                }),
                Frame::Incoming(Incoming::Malformed { bytes: 8 }),
                Frame::Incoming(Incoming::Malformed { bytes: 8 }),
            ]
        );
    }

    #[tokio::test]
    async fn skips_an_oversized_frame_and_keeps_reading() {
        let input = format!(
            "{{\"method\":\"big\",\"params\":\"{}\"}}\n{{\"method\":\"next\"}}\n",
            "x".repeat(100)
        );

        let frames = frames(input.as_bytes(), 64).await;

        assert_eq!(
            frames,
            vec![
                Frame::Incoming(Incoming::Oversized { bytes: 128 }),
                Frame::Incoming(Incoming::Notification {
                    method: "next".to_owned(),
                    params: Value::Null,
                }),
            ]
        );
    }

    #[test]
    fn a_timed_out_request_resolves_late_once_and_tombstones_are_bounded() {
        let mut pending = Pending::new();
        let _receiver = pending.register(1, "first");
        assert!(pending.abandon(1));
        assert!(!pending.abandon(1));

        assert!(matches!(
            pending.resolve(&json!(1)),
            Resolved::Late("first")
        ));
        assert!(matches!(pending.resolve(&json!(1)), Resolved::Unknown));

        for id in 10..(10 + MAX_TOMBSTONES as u64 + 1) {
            let _receiver = pending.register(id, "later");
            pending.abandon(id);
        }
        assert!(matches!(pending.resolve(&json!(10)), Resolved::Unknown));
        assert!(matches!(pending.resolve(&json!(11)), Resolved::Late(_)));
    }
}
