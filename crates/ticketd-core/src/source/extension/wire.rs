use super::super::{FieldIssue, SourceError};
use super::redaction::Redactions;
pub(super) use ticketd_source_sdk::wire::*;

pub(super) trait RpcErrorExt {
    fn into_source_error(self, secrets: &Redactions) -> SourceError;
}

impl RpcErrorExt for RpcError {
    fn into_source_error(self, secrets: &super::redaction::Redactions) -> SourceError {
        if let Some(mut failure) = self.data
            && self.code == -32000
        {
            failure.message = secrets.text(&failure.message);
            secrets.fields(&mut failure.fields);
            return into_source_error(failure);
        }
        SourceError::Protocol(format!(
            "JSON-RPC error {}: {}",
            self.code,
            secrets.text(&self.message)
        ))
    }
}

fn into_source_error(mut failure: WireFailure) -> SourceError {
    use WireFailureCode::*;
    let error = match failure.code {
        Unauthenticated => SourceError::Unauthenticated(failure.message),
        Forbidden => SourceError::Forbidden(failure.message),
        NotFound => SourceError::NotFound(failure.message),
        RateLimited => SourceError::RateLimited {
            retry_after_secs: failure.retry_after_secs,
        },
        Unavailable => SourceError::Unavailable(failure.message),
        NotSent => SourceError::NotSent(failure.message),
        Rejected => SourceError::Rejected(failure.message),
        Protocol => SourceError::Protocol(failure.message),
        Unsupported => SourceError::Unsupported("this operation"),
        InvalidConfiguration => {
            if failure.fields.is_empty() {
                failure.fields.push(FieldIssue::for_form(failure.message));
            }
            SourceError::InvalidConfiguration(failure.fields)
        }
    };
    if error.class() == failure.class {
        error
    } else {
        SourceError::Protocol("the source error's code and class disagree".into())
    }
}
