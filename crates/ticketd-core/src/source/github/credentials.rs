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
    override_name: Option<String>,
    account: Option<String>,
    environment: Environment,
    cli: OnceLock<Option<Secret>>,
}

impl AmbientCredentials {
    pub(crate) fn new(
        custom_host: Option<String>,
        id: Option<&str>,
        account: Option<&str>,
    ) -> Self {
        let mut credentials = Self::with_environment(custom_host, |name| std::env::var(name).ok());
        credentials.override_name = id.map(connection_token_variable);
        credentials.account = account.map(str::to_owned);
        credentials
    }

    pub(crate) fn with_environment(
        custom_host: Option<String>,
        environment: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            custom_host,
            override_name: None,
            account: None,
            environment: Box::new(environment),
            cli: OnceLock::new(),
        }
    }
}

pub(super) fn connection_token_variable(id: &str) -> String {
    format!(
        "TICKETD_SOURCE_{}_TOKEN",
        id.to_ascii_uppercase().replace('-', "_")
    )
}

impl CredentialSource for AmbientCredentials {
    fn token(&self) -> Option<Secret> {
        if let Some(value) = self
            .override_name
            .as_deref()
            .and_then(|name| (self.environment)(name))
            && !value.trim().is_empty()
        {
            return Some(Secret::new(value.trim()));
        }
        let names: &[&str] = if self.account.is_some() {
            &[]
        } else if self.custom_host.is_some() {
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
            .get_or_init(|| {
                gh_token(
                    self.custom_host.as_deref().unwrap_or("github.com"),
                    self.account.as_deref(),
                )
            })
            .clone()
    }
}

fn gh_token(host: &str, account: Option<&str>) -> Option<Secret> {
    [
        "gh",
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh",
    ]
    .into_iter()
    .find_map(|program| {
        let mut command = Command::new(program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;

            // Keep background credential checks from opening a desktop console.
            command.creation_flags(CREATE_NO_WINDOW.0);
        }
        command.args(["auth", "token", "--hostname", host]);
        if let Some(account) = account {
            command.args(["--user", account]);
            command
                .env_remove("GH_TOKEN")
                .env_remove("GITHUB_TOKEN")
                .env_remove("GH_ENTERPRISE_TOKEN")
                .env_remove("GITHUB_ENTERPRISE_TOKEN");
        }
        let output = command
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

    #[cfg(windows)]
    #[test]
    fn gh_token_runs_without_a_console_window() {
        use std::{env, fs, os::windows::process::CommandExt};
        use windows::Win32::System::Threading::DETACHED_PROCESS;

        const PROBE: &str = "TICKETD_TEST_GITHUB_CONSOLE";
        if env::var_os(PROBE).is_some() {
            assert!(fs::File::open("CONIN$").is_err(), "probe has a console");
            assert!(
                gh_token("github.com", None)
                    .is_some_and(|token| token.expose() == "test-token-without-console-window"),
                "expected the GitHub CLI fixture to return the token without opening a console window"
            );
            return;
        }

        let directory = tempfile::tempdir().unwrap();
        let fixture = directory.path().join("gh.rs");
        fs::write(
            &fixture,
            r#"
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}

fn main() {
    // SAFETY: This function takes no arguments and reports this process's window.
    if !unsafe { GetConsoleWindow() }.is_null() {
        std::process::exit(1);
    }
    println!("test-token-without-console-window");
}
"#,
        )
        .unwrap();
        let build = Command::new("rustc")
            .arg(&fixture)
            .arg("-o")
            .arg(directory.path().join("gh.exe"))
            .output()
            .unwrap();
        assert!(
            build.status.success(),
            "{}",
            String::from_utf8_lossy(&build.stderr)
        );

        // Match the Windows desktop, which has no console for gh to inherit.
        let probe = Command::new(env::current_exe().unwrap())
            .arg("gh_token_runs_without_a_console_window")
            .env(PROBE, "1")
            .env("PATH", directory.path())
            .creation_flags(DETACHED_PROCESS.0)
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&probe.stdout);
        assert!(
            probe.status.success() && report.contains("1 passed"),
            "{report}"
        );
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
