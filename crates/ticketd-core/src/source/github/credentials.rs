//! Credentials supplied to older connector fixtures.

/// A credential. Its `Debug` output is redacted and it has no `Display`.
#[derive(Clone)]
pub(crate) struct Secret(String);

impl Secret {
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The token text, for the one place that builds an authorization header.
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

pub(crate) trait CredentialSource: Send + Sync {
    /// The token to use now, or `None` when none is available.
    fn token(&self) -> Option<Secret>;
}
