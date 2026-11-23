//! Desktop Chat host: the harness adapter contract and the per-Chat supervisor.
//!
//! Adapters translate one harness protocol and report what they observed. They never
//! write workspace storage and never decide queue policy; the supervisor does both
//! through core workflows.

pub mod attention;
mod claude;
pub mod cli;
mod codex;
pub mod conditions;
#[cfg(test)]
mod conformance;
pub mod context;
mod contract;
pub mod diffstat;
mod host;
mod install;
mod json_rpc;
mod outcome;
pub mod records;
mod runtime;
#[cfg(test)]
mod scripted;
mod stdio;
pub mod step_kind;
mod subscription;
mod supervisor;
pub mod testing;
mod turn_ending;
mod unattended;
mod wire;

pub use claude::{BRIDGE_SIDECAR_NAME, ClaudeAdapter};
pub use codex::CodexAdapter;
pub use contract::*;
pub use host::*;
pub use subscription::{
    ChatUpdate, SUBSCRIBER_BACKLOG_BYTES, SUBSCRIBER_BACKLOG_ITEMS, Subscription,
};
pub use turn_ending::{StopReason, TurnEnding};
pub use unattended::TurnEnd;
