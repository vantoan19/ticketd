//! Desktop Chat host: the harness adapter contract and the per-Chat supervisor.
//!
//! Adapters translate one harness protocol and report what they observed. They never
//! write workspace storage and never decide queue policy; the supervisor does both
//! through core workflows.

mod claude;
mod codex;
mod contract;
mod host;
mod install;
#[cfg(test)]
mod scripted;
mod stdio;
mod subscription;
mod supervisor;
pub mod testing;

pub use claude::{BRIDGE_SIDECAR_NAME, ClaudeAdapter};
pub use codex::CodexAdapter;
pub use contract::*;
pub use host::*;
pub use subscription::{
    ChatUpdate, SUBSCRIBER_BACKLOG_BYTES, SUBSCRIBER_BACKLOG_ITEMS, Subscription,
};
