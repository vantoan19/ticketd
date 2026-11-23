//! Commands for choosing S3 as the storage of Workspace sync (ADR 0018): the AWS CLI
//! profiles, signing a profile in, who it is signed in as, the buckets it may list, and
//! recording the connection. The AWS CLI does the signing in; ticketd stores no secret.
//! Every command that runs the `aws` program runs off the UI thread.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;
use ticketd_core::{
    s3::{AwsCli, AwsCliError, ProfileCredentials, S3Target, checked_prefix},
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
    TooOld {
        found: String,
    },
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
    cli_at(None)
}

/// The AWS CLI at `path` (the binding's own choice), or the usual locations.
fn cli_at(path: Option<&Path>) -> Outcome<AwsCli> {
    match locate(AwsCli::locate(path))? {
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

/// Forgets the credentials kept for every profile, so the next request exports them again.
/// What a profile signs in as, or where it reaches, may have changed since they were kept.
pub fn forget_all_credentials() {
    *CREDENTIALS.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// Runs the profile's sign-in command, which waits for the person in their browser.
#[tauri::command(async)]
pub fn s3_sign_in(profile: String) -> Outcome<()> {
    check_profile(&profile)?;
    let cli = cli()?;
    if !sign_in_with(&cli, &profile)? {
        return rejected("This profile has no sign-in command. Sign in with the AWS CLI.");
    }
    Ok(())
}

/// Runs the profile's sign-in command; `false` when it has none, so nothing ran.
fn sign_in_with(cli: &AwsCli, profile: &str) -> Outcome<bool> {
    let Some(command) = cli
        .sign_in_command(profile)
        .map_err(|error| failed(&error))?
    else {
        return Ok(false);
    };
    let result = command.run();
    // Whether or not it finished, what was kept may no longer be right.
    credentials(cli, profile).forget();
    result.map_err(|error| failed(&error))?;
    Ok(true)
}

/// What recovering from an ended authorization does first: sign the profile in again when it
/// has a command for that. A profile with static keys or a credential helper has none, and
/// there is nothing to sign in to, so the recovery just tries again.
pub fn sign_in_for_recovery(binding: &S3Binding) -> Outcome<()> {
    check_profile(&binding.profile)?;
    // The program sync itself uses, which may be outside the usual locations.
    let cli = cli_at(binding.aws_cli_path.as_deref().map(Path::new))?;
    sign_in_with(&cli, &binding.profile).map(drop)
}

/// The bucket names the profile may list; `None` when it may not, so the interface asks
/// for the name instead.
#[tauri::command(async)]
pub fn s3_buckets(profile: String) -> Outcome<Option<Vec<String>>> {
    check_profile(&profile)?;
    cli()?.buckets(&profile).map_err(|error| failed(&error))
}

/// Where the connected Workspace's folder is, for a person to open in another tool.
#[derive(Debug, Serialize)]
pub struct FolderLinks {
    /// `s3://bucket/prefix/folder/`, which every S3 service has.
    address: String,
    /// Whether the folder has a page in the AWS console (`sync_open_folder` opens it).
    console: bool,
}

#[tauri::command(async)]
pub fn s3_folder_links() -> Outcome<FolderLinks> {
    let status = open_workspace()?.sync_status()?;
    let (Some(s3), Some(folder)) = (status.s3, status.folder) else {
        return rejected("Sync with S3 is not connected");
    };
    let storage = crate::s3_storage::storage(&s3);
    Ok(FolderLinks {
        address: storage.address(&folder.id),
        console: storage.console_url(&folder.id).is_some(),
    })
}

fn check_profile(profile: &str) -> Outcome<()> {
    if profile.trim().is_empty() || profile.chars().count() > 128 || profile.contains('\n') {
        return rejected("choose an AWS CLI profile");
    }
    Ok(())
}

/// The key prefix as the Workspace folders are kept under it: no leading slash, one trailing
/// slash, and empty only when the person wants the bucket's root. The rules of what the S3
/// storage accepts are the core's, so a prefix that passes here can sync.
fn normalize_prefix(prefix: &str) -> Outcome<String> {
    let trimmed = prefix.trim().trim_start_matches('/');
    checked_prefix(trimmed).map_err(|error| BridgeFailure::plain(&error.to_string()))
}

fn check_bucket(bucket: &str) -> Outcome<&str> {
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return rejected("name the S3 bucket");
    }
    // The same rules as the storage that will use the name; the region does not matter here.
    S3Target::new(bucket, "us-east-1", None)
        .map_err(|error| BridgeFailure::plain(&error.to_string()))?;
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
    // The profile may now sign in as another account or reach another endpoint, so what was
    // kept for it is dropped and the storage is built afresh from it.
    crate::s3_storage::reset();
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
        // What the S3 storage refuses is refused here, where the setup can say so.
        assert!(normalize_prefix("my team/ticketd").is_err());
        assert!(normalize_prefix("tickets\u{e9}/").is_err());
    }

    /// A stand-in `aws` program: a profile signs in through SSO only when `sso` is set, and
    /// a run of any other command is logged in `ran.log` beside it.
    #[cfg(unix)]
    fn stand_in(sso: bool) -> (tempfile::TempDir, AwsCli) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("aws");
        let sso_answer = if sso {
            "echo my-session; exit 0"
        } else {
            "exit 1"
        };
        let script = [
            "#!/bin/sh".to_owned(),
            "case \"$1\" in".to_owned(),
            "--version) echo 'aws-cli/2.19.5 Python/3.12.7';;".to_owned(),
            format!("configure) case \"$3\" in sso_session) {sso_answer};; *) exit 1;; esac;;"),
            "*) echo \"$@\" >> \"$(dirname \"$0\")/ran.log\";;".to_owned(),
            "esac".to_owned(),
        ]
        .join("\n");
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = AwsCli::locate(Some(&program)).unwrap();
        (directory, cli)
    }

    #[test]
    #[cfg(unix)]
    fn a_recovery_signs_a_profile_in_only_when_it_has_a_sign_in_command() {
        let (directory, cli) = stand_in(false);
        // Static keys or a credential helper: nothing to sign in to, so nothing runs and the
        // recovery goes on to try again.
        assert!(!sign_in_with(&cli, "keys").unwrap());
        assert!(!directory.path().join("ran.log").exists());

        let (directory, cli) = stand_in(true);
        assert!(sign_in_with(&cli, "work").unwrap());
        let ran = std::fs::read_to_string(directory.path().join("ran.log")).unwrap();
        assert_eq!(ran.trim(), "sso login --profile work");
    }

    #[test]
    #[cfg(unix)]
    fn a_recovery_signs_in_through_the_aws_program_the_binding_names() {
        use std::os::unix::fs::PermissionsExt;
        // An `aws` outside the usual directories, which default discovery would not find.
        let (directory, _) = stand_in(true);
        let program = directory.path().join("aws");
        let elsewhere = tempfile::tempdir().unwrap();
        let moved = elsewhere.path().join("aws");
        std::fs::copy(&program, &moved).unwrap();
        std::fs::set_permissions(&moved, std::fs::Permissions::from_mode(0o755)).unwrap();
        let binding = S3Binding {
            bucket: "team-bucket".into(),
            prefix: "ticketd/".into(),
            profile: "work".into(),
            aws_cli_path: Some(moved.display().to_string()),
        };
        sign_in_for_recovery(&binding).unwrap();
        let ran = std::fs::read_to_string(elsewhere.path().join("ran.log")).unwrap();
        assert_eq!(ran.trim(), "sso login --profile work");
    }

    #[test]
    #[cfg(unix)]
    fn kept_credentials_are_exported_again_after_they_are_all_forgotten() {
        use std::os::unix::fs::PermissionsExt;
        // Static keys never expire, so only forgetting makes the next request export again.
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("aws");
        std::fs::write(
            &program,
            "#!/bin/sh\ncase \"$1\" in\n--version) echo 'aws-cli/2.19.5 Python/3.12.7';;\n*) echo \"$@\" >> \"$(dirname \"$0\")/ran.log\"; echo '{\"AccessKeyId\":\"AKIAEXAMPLE\",\"SecretAccessKey\":\"secret\"}';;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = AwsCli::locate(Some(&program)).unwrap();
        let profile = "forgetting-test-profile";
        let exports = || {
            std::fs::read_to_string(directory.path().join("ran.log"))
                .unwrap_or_default()
                .lines()
                .filter(|line| line.starts_with("configure export-credentials"))
                .count()
        };
        credentials(&cli, profile).access().unwrap();
        credentials(&cli, profile).access().unwrap();
        assert_eq!(exports(), 1, "kept between requests");
        forget_all_credentials();
        credentials(&cli, profile).access().unwrap();
        assert_eq!(exports(), 2);
    }

    #[test]
    fn a_bucket_is_a_name_without_spaces_or_slashes() {
        assert_eq!(check_bucket(" my-bucket ").unwrap(), "my-bucket");
        assert!(check_bucket("").is_err());
        assert!(check_bucket("my bucket").is_err());
        assert!(check_bucket("s3://my-bucket").is_err());
        // Nor is it one S3 would refuse later.
        assert!(check_bucket("My_Bucket").is_err());
        assert!(check_bucket("ab").is_err());
        assert!(check_bucket("-bucket").is_err());
    }
}
