//! Desktop Chat host: the harness adapter contract and, later, the per-Chat supervisor.
//!
//! Adapters translate one harness protocol and report what they observed. They never
//! write workspace storage and never decide queue policy; the supervisor does both
//! through core workflows.

mod contract;
pub mod testing;

pub use contract::*;
