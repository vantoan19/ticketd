//! Commands for choosing S3 as the storage of Workspace sync (ADR 0018): the AWS CLI
//! profiles, signing a profile in, who it is signed in as, the buckets it may list, and
//! recording the connection. The AWS CLI does the signing in; ticketd stores no secret.
//! Every command that runs the `aws` program runs off the UI thread.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;
use ticketd_core::{
    s3::{AwsCli, AwsCliError, ProfileCredentials},
    sync::{S3Binding, SyncStatus},
};

use super::{BridgeFailure, open_workspace};

type Outcome<T> = Result<T, BridgeFailure>;

fn rejected<T>(message: &str) -> Outcome<T> {
    Err(BridgeFailure::plain(message))
}

fn failed(error: &AwsCliError) -> BridgeFailure {
    BridgeFailure::plain(&error.to_string())
}

/// What the interface needs to know about the AWS CLI before offering profiles.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CliState {
    Ready,
    /// No `aws` program in the usual places.
    Missing,
    /// Older than ticketd needs; `found` is what its `--version` printed.
    TooOld { found: String },
}

#[derive(Debug, Serialize)]
pub struct Profiles {
    cli: CliState,
    /// Empty unless the CLI is ready.
    profiles: Vec<String>,
}

/// Locates the CLI, where a missing or too old one is a state to show, not a failure.
fn locate(located: Result<AwsCli, AwsCliError>) -> Outcome<Result<AwsCli, CliState>> {
    match located {
        Ok(cli) => Ok(Ok(cli)),
        Err(AwsCliError::NotFound) => Ok(Err(CliState::Missing)),
        Err(AwsCliError::UnsupportedVersion { found }) => Ok(Err(CliState::TooOld { found })),
        Err(other) => Err(failed(&other)),
    }
}

fn cli() -> Outcome<AwsCli> {
    match locate(AwsCli::locate(None))? {
        Ok(cli) => Ok(cli),
        Err(CliState::Missing) => rejected("The AWS CLI was not found."),
        Err(CliState::TooOld { found }) => rejected(&format!(
            "ticketd needs AWS CLI version 2.13 or later; this one reports \"{found}\"."
        )),
        Err(CliState::Ready) => rejected("The AWS CLI could not be used."),
    }
}

fn profiles_of(located: Result<AwsCli, AwsCliError>) -> Outcome<Profiles> {
    Ok(match locate(located)? {
        Ok(cli) => Profiles {
            profiles: cli.profiles().map_err(|error| failed(&error))?,
            cli: CliState::Ready,
        },
        Err(state) => Profiles {
            cli: state,
            profiles: Vec::new(),
        },
    })
}

/// The AWS CLI's state and the profile names in the person's configuration.
#[tauri::command(async)]
pub fn s3_profiles() -> Outcome<Profiles> {
    profiles_of(AwsCli::locate(None))
}

/// Whether a profile is signed in, and if not, whether ticketd can start the sign-in.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Identity {
    /// `identity` is the ARN the profile signs in as.
    SignedIn { identity: String },
    SignInNeeded {
        /// Whether the profile has a sign-in command (`aws sso login`, `aws login`). A
        /// profile with static keys or a credential helper has none.
        can_sign_in: bool,
        message: String,
    },
}

#[tauri::command(async)]
pub fn s3_identity(profile: String) -> Outcome<Identity> {
    let cli = cli()?;
    identity_of(&cli, &profile)
}

fn identity_of(cli: &AwsCli, profile: &str) -> Outcome<Identity> {
    check_profile(profile)?;
    match cli.identity(profile) {
        Ok(identity) => Ok(Identity::SignedIn { identity }),
        Err(AwsCliError::SignInNeeded { message }) => Ok(Identity::SignInNeeded {
            can_sign_in: cli
                .sign_in_command(profile)
                .map_err(|error| failed(&error))?
                .is_some(),
            message,
        }),
        Err(other) => Err(failed(&other)),
    }
}

/// Credentials kept in memory, one set per profile, shared by everything that signs
/// requests for it. Signing in drops what is kept, so the next request exports fresh ones.
static CREDENTIALS: Mutex<Option<HashMap<String, Arc<ProfileCredentials>>>> = Mutex::new(None);

pub fn credentials(cli: &AwsCli, profile: &str) -> Arc<ProfileCredentials> {
    let mut kept = CREDENTIALS.lock().unwrap_or_else(PoisonError::into_inner);
    Arc::clone(
        kept.get_or_insert_default()
            .entry(profile.to_owned())
            .or_insert_with(|| Arc::new(ProfileCredentials::new(cli.clone(), profile))),
    )
}

/// Runs the profile's sign-in command, which waits for the person in their browser.
#[tauri::command(async)]
pub fn s3_sign_in(profile: String) -> Outcome<()> {
    check_profile(&profile)?;
    let cli = cli()?;
    let Some(command) = cli
        .sign_in_command(&profile)
        .map_err(|error| failed(&error))?
    else {
        return rejected("This profile has no sign-in command. Sign in with the AWS CLI.");
    };
    let result = command.run();
    // Whether or not it finished, what was kept may no longer be right.
    credentials(&cli, &profile).forget();
    result.map_err(|error| failed(&error))
}

/// The bucket names the profile may list; `None` when it may not, so the interface asks
/// for the name instead.
#[tauri::command(async)]
pub fn s3_buckets(profile: String) -> Outcome<Option<Vec<String>>> {
    check_profile(&profile)?;
    cli()?.buckets(&profile).map_err(|error| failed(&error))
}

fn check_profile(profile: &str) -> Outcome<()> {
    if profile.trim().is_empty() || profile.chars().count() > 128 || profile.contains('\n') {
        return rejected("choose an AWS CLI profile");
    }
    Ok(())
}

/// The key prefix as the Workspace folders are kept under it: no leading slash, one trailing
/// slash, and empty only when the person wants the bucket's root.
fn normalize_prefix(prefix: &str) -> Outcome<String> {
    let trimmed = prefix.trim().trim_start_matches('/');
    if trimmed.chars().count() > 512 || trimmed.contains("//") || trimmed.contains('\n') {
        return rejected("use a shorter prefix without empty parts, such as ticketd/");
    }
    Ok(match trimmed {
        "" => String::new(),
        text if text.ends_with('/') => text.to_owned(),
        text => format!("{text}/"),
    })
}

fn check_bucket(bucket: &str) -> Outcome<&str> {
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return rejected("name the S3 bucket");
    }
    if bucket.chars().count() > 255 || bucket.contains(|c: char| c.is_whitespace() || c == '/') {
        return rejected("an S3 bucket name has no spaces or slashes");
    }
    Ok(bucket)
}

/// Records the connection: this Workspace will sync through `bucket` and `prefix`, and this
/// desktop signs in through `profile`. Choosing a Workspace follows.
#[tauri::command(async)]
pub fn sync_connect_s3(bucket: String, prefix: String, profile: String) -> Outcome<SyncStatus> {
    check_profile(&profile)?;
    let bucket = check_bucket(&bucket)?;
    let prefix = normalize_prefix(&prefix)?;
    let cli = cli()?;
    let identity = match identity_of(&cli, &profile)? {
        Identity::SignedIn { identity } => identity,
        Identity::SignInNeeded { .. } => return rejected("Sign in to this AWS profile first."),
    };
    let binding = S3Binding {
        bucket: bucket.to_owned(),
        prefix,
        profile,
        aws_cli_path: None,
    };
    let status = open_workspace()?.sync_connect_s3(&binding, &identity)?;
    crate::wake::CHANGED.notify();
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_old_cli_is_a_state_with_no_profiles() {
        let missing = profiles_of(Err(AwsCliError::NotFound)).unwrap();
        assert_eq!(missing.cli, CliState::Missing);
        assert!(missing.profiles.is_empty());

        let old = profiles_of(Err(AwsCliError::UnsupportedVersion {
            found: "aws-cli/1.27.0".into(),
        }))
        .unwrap();
        assert_eq!(
            old.cli,
            CliState::TooOld {
                found: "aws-cli/1.27.0".into()
            }
        );
    }

    #[test]
    fn any_other_failure_locating_the_cli_is_a_failure() {
        assert!(profiles_of(Err(AwsCliError::TimedOut)).is_err());
    }

    #[test]
    fn a_prefix_ends_in_one_slash_and_does_not_start_with_one() {
        let of = |text: &str| normalize_prefix(text).unwrap();
        assert_eq!(of("ticketd/"), "ticketd/");
        assert_eq!(of("  ticketd "), "ticketd/");
        assert_eq!(of("/team/ticketd"), "team/ticketd/");
        assert_eq!(of(""), "");
        assert_eq!(of("/"), "");
        assert!(normalize_prefix("team//ticketd").is_err());
    }

    #[test]
    fn a_bucket_is_a_name_without_spaces_or_slashes() {
        assert_eq!(check_bucket(" my-bucket ").unwrap(), "my-bucket");
        assert!(check_bucket("").is_err());
        assert!(check_bucket("my bucket").is_err());
        assert!(check_bucket("s3://my-bucket").is_err());
    }
}
