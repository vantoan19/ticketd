//! Where the GitHub connector finds a token. ticketd never asks for, stores,
//! logs or exports one: it reuses the credential the person already has.

use std::process::{Command, Stdio};

/// A credential. Its `Debug` output is redacted and it has no `Display`.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

pub trait CredentialSource: Send + Sync {
    /// The token to use now, or `None` when none is available.
    fn token(&self) -> Option<Secret>;
}

/// Looks for a token in the environment, then asks the GitHub CLI.
///
/// Order: `TICKETD_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then
/// `gh auth token`. The CLI lookup covers a desktop app launched from a
/// launcher, which inherits none of the shell's environment.
pub struct AmbientCredentials {
    /// Whether the `gh` fallback applies: it only knows github.com.
    ask_gh: bool,
}

impl AmbientCredentials {
    pub fn new(ask_gh: bool) -> Self {
        Self { ask_gh }
    }
}

impl CredentialSource for AmbientCredentials {
    fn token(&self) -> Option<Secret> {
        for name in ["TICKETD_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(Secret::new(value));
                }
            }
        }
        if self.ask_gh {
            return gh_token();
        }
        None
    }
}

fn gh_token() -> Option<Secret> {
    [
        "gh",
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh",
    ]
    .into_iter()
    .find_map(|program| {
        let output = Command::new(program)
            .args(["auth", "token", "--hostname", "github.com"])
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let token = String::from_utf8(output.stdout).ok()?;
        let token = token.trim();
        (!token.is_empty()).then(|| Secret::new(token))
    })
}
