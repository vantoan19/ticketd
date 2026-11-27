//! Desktop Chat host: the harness adapter contract and the per-Chat supervisor.
//!
//! Adapters translate one harness protocol and report what they observed. They never
//! write workspace storage and never decide queue policy; the supervisor does both
//! through core workflows.

mod antigravity;
mod attachment_input;
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
#[cfg(test)]
mod host_script;
mod install;
mod json_rpc;
mod outcome;
#[cfg(all(debug_assertions, unix))]
mod recording;
pub mod records;
mod registry;
mod runtime;
#[cfg(test)]
mod scripted;
mod stdio;
pub mod step_kind;
mod subscription;
mod supervisor;
pub mod testing;
mod tool_steps;
mod turn_ending;
mod unattended;
mod wire;
mod write_credit;

pub use claude::{BRIDGE_SIDECAR_NAME, ClaudeAdapter, read_claude_steps};
pub use codex::CodexAdapter;
pub use contract::*;
pub use host::*;
#[cfg(all(debug_assertions, unix))]
pub use recording::prepare_harness_recording;
pub use registry::{HostResources, REGISTRATIONS, Registration, registration};
pub use subscription::{
    ChatUpdate, SUBSCRIBER_BACKLOG_BYTES, SUBSCRIBER_BACKLOG_ITEMS, Subscription,
};
pub use tool_steps::*;
pub use turn_ending::{StopReason, TurnEnding};
pub use unattended::TurnEnd;
