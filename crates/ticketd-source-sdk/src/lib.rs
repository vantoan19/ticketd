//! Build a ticket source extension with the Contract 2 types and stdio server.
//! Extensions translate a tracker into source-independent data. ticketd owns the
//! Workspace, process lifetime, and the operation deadlines.

mod model;
mod presentation;
mod schema;
mod server;
#[doc(hidden)]
pub mod wire;

pub use model::*;
pub use presentation::*;
pub use schema::*;
pub use server::{Extension, ExtensionError, Publication, RequestContext, serve, serve_stdio};
pub use wire::WireFailureCode as ErrorCode;

/// Check that the extension refused a probe for a contract it cannot support.
pub mod conformance {
    use crate::wire::Description;

    #[doc(hidden)]
    pub fn refused_version(hello: &Description, refused: u32, supported: u32) -> bool {
        hello.contract_version.is_none()
            && hello.description.is_none()
            && hello.contract_versions.contains(&supported)
            && !hello.contract_versions.contains(&refused)
    }
}
