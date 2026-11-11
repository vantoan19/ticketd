//! Framing for `codex app-server` over stdio: newline-delimited JSON-RPC 2.0 messages
//! with the `"jsonrpc"` member omitted, in both directions.

use std::collections::{HashMap, VecDeque};
use std::io;

use serde_json::Value;
use tokio::io::AsyncBufRead;
use tokio::sync::oneshot;

pub(super) use crate::stdio::StderrTail;
use crate::stdio::{Line, read_line};

/// Largest protocol frame kept. Provisional; a completed item carries a command's
/// whole aggregated output in one frame.
pub(super) const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Timed-out requests remembered so a late reply reconciles instead of looking unknown.
pub(super) const MAX_TOMBSTONES: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Value,
}

pub(super) type Reply = Result<Value, RpcError>;

#[derive(Debug, PartialEq)]
pub(super) enum Frame {
    Reply {
        id: Value,
        reply: Reply,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
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
pub(super) async fn read_frame<R>(reader: &mut R, max_bytes: usize) -> io::Result<Option<Frame>>
where
    R: AsyncBufRead + Unpin,
{
    Ok(read_line(reader, max_bytes).await?.map(|line| match line {
        Line::Complete(line) => parse_frame(&line),
        Line::Oversized { bytes } => Frame::Oversized { bytes },
    }))
}

fn parse_frame(line: &[u8]) -> Frame {
    let malformed = Frame::Malformed { bytes: line.len() };
    let Ok(Value::Object(mut message)) = serde_json::from_slice::<Value>(line) else {
        return malformed;
    };
    let id = message.remove("id").filter(|id| !id.is_null());
    if let Some(Value::String(method)) = message.remove("method") {
        let params = message.remove("params").unwrap_or(Value::Null);
        return match id {
            Some(id) => Frame::Request { id, method, params },
            None => Frame::Notification { method, params },
        };
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
pub(super) fn encode(frame: &Value) -> Vec<u8> {
    let mut line = frame.to_string().into_bytes();
    line.push(b'\n');
    line
}

/// Outgoing requests awaiting a reply, plus tombstones for those that timed out.
#[derive(Debug)]
pub(super) struct Pending<C> {
    waiting: HashMap<u64, (C, oneshot::Sender<Reply>)>,
    tombstones: VecDeque<(u64, C)>,
}

pub(super) enum Resolved<C> {
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::BufReader;

    use super::*;
    use crate::stdio::MAX_STDERR_TAIL_BYTES;

    async fn frames(input: &[u8], max_bytes: usize) -> Vec<Frame> {
        let mut reader = BufReader::with_capacity(8, input);
        let mut frames = Vec::new();
        while let Ok(Some(frame)) = read_frame(&mut reader, max_bytes).await {
            frames.push(frame);
        }
        frames
    }

    #[tokio::test]
    async fn classifies_replies_requests_and_notifications() {
        let input = concat!(
            "{\"id\":1,\"result\":{\"ok\":true}}\n",
            "{\"id\":2,\"error\":{\"code\":-32600,\"message\":\"no\"}}\n",
            "\n",
            "{\"id\":\"srv-1\",\"method\":\"item/tool/call\",\"params\":{}}\n",
            "{\"method\":\"turn/started\",\"params\":{\"a\":1}}\n",
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
                Frame::Request {
                    id: json!("srv-1"),
                    method: "item/tool/call".to_owned(),
                    params: json!({}),
                },
                Frame::Notification {
                    method: "turn/started".to_owned(),
                    params: json!({"a": 1}),
                },
                Frame::Malformed { bytes: 8 },
                Frame::Malformed { bytes: 8 },
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
                Frame::Oversized { bytes: 128 },
                Frame::Notification {
                    method: "next".to_owned(),
                    params: Value::Null,
                },
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

    #[tokio::test]
    async fn stderr_keeps_only_a_bounded_tail() {
        let tail = StderrTail::default();
        let mut noise = vec![b'a'; MAX_STDERR_TAIL_BYTES * 2];
        noise.extend_from_slice(b"final line\n");

        tail.clone().drain(noise.as_slice()).await;

        let snapshot = tail.snapshot();
        assert!(snapshot.len() <= MAX_STDERR_TAIL_BYTES);
        assert!(snapshot.ends_with("final line"));
    }
}
