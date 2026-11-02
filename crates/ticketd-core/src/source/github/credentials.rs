//! Where the GitHub connector finds a token. ticketd never asks for, stores,
//! logs or exports one: it reuses the credential the person already has.

use std::{
    process::{Command, Stdio},
    sync::OnceLock,
};

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

type Environment = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Looks for a token in the environment, then asks the GitHub CLI.
///
/// For github.com the order is `TICKETD_GITHUB_TOKEN`, `GH_TOKEN`,
/// `GITHUB_TOKEN`, then `gh auth token`. `GH_TOKEN` and `GITHUB_TOKEN` are
/// github.com credentials, so for any other API host (GitHub Enterprise Server)
/// they are never sent: only `TICKETD_GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
/// `gh auth token --hostname <host>` apply. The CLI lookup also covers a desktop
/// app launched from a launcher, which inherits none of the shell's environment,
/// and its answer is kept for the life of the process, so a refresh that makes
/// many requests starts the CLI once.
pub(crate) struct AmbientCredentials {
    /// The host of a custom API address, or `None` for github.com.
    custom_host: Option<String>,
    environment: Environment,
    cli: OnceLock<Option<Secret>>,
}

impl AmbientCredentials {
    pub(crate) fn new(custom_host: Option<String>) -> Self {
        Self::with_environment(custom_host, |name| std::env::var(name).ok())
    }

    pub(crate) fn with_environment(
        custom_host: Option<String>,
        environment: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            custom_host,
            environment: Box::new(environment),
            cli: OnceLock::new(),
        }
    }
}

impl CredentialSource for AmbientCredentials {
    fn token(&self) -> Option<Secret> {
        let names: &[&str] = if self.custom_host.is_some() {
            &["TICKETD_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]
        } else {
            &["TICKETD_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        };
        for name in names {
            if let Some(value) = (self.environment)(name) {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(Secret::new(value));
                }
            }
        }
        self.cli
            .get_or_init(|| gh_token(self.custom_host.as_deref().unwrap_or("github.com")))
            .clone()
    }
}

fn gh_token(host: &str) -> Option<Secret> {
    [
        "gh",
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh",
    ]
    .into_iter()
    .find_map(|program| {
        let output = Command::new(program)
            .args(["auth", "token", "--hostname", host])
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

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn a_github_com_token_is_never_offered_to_another_host() {
        let github = AmbientCredentials::with_environment(
            None,
            env(&[("GH_TOKEN", "dotcom"), ("GITHUB_TOKEN", "dotcom-too")]),
        );
        assert_eq!(github.token().unwrap().expose(), "dotcom");

        let enterprise = AmbientCredentials::with_environment(
            Some("ghe.corp.example".into()),
            env(&[("GH_TOKEN", "dotcom"), ("GITHUB_TOKEN", "dotcom-too")]),
        );
        // Neither github.com variable applies; with no CLI login for that host
        // there is no credential at all (the CLI is asked for that host only).
        assert!(
            enterprise
                .token()
                .is_none_or(|token| token.expose() != "dotcom" && token.expose() != "dotcom-too")
        );
    }

    #[test]
    fn an_enterprise_host_uses_its_own_variables() {
        let enterprise = AmbientCredentials::with_environment(
            Some("ghe.corp.example".into()),
            env(&[("GH_ENTERPRISE_TOKEN", "corp"), ("GH_TOKEN", "dotcom")]),
        );
        assert_eq!(enterprise.token().unwrap().expose(), "corp");
        let explicit = AmbientCredentials::with_environment(
            Some("ghe.corp.example".into()),
            env(&[
                ("TICKETD_GITHUB_TOKEN", "mine"),
                ("GH_ENTERPRISE_TOKEN", "corp"),
            ]),
        );
        assert_eq!(explicit.token().unwrap().expose(), "mine");
    }
}
