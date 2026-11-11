//! Desktop Chat host: the harness adapter contract and, later, the per-Chat supervisor.
//!
//! Adapters translate one harness protocol and report what they observed. They never
//! write workspace storage and never decide queue policy; the supervisor does both
//! through core workflows.

pub mod cli;
mod codex;
pub mod context;
mod contract;
pub mod testing;

pub use codex::CodexAdapter;
pub use contract::*;
