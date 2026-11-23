//! The AWS CLI credential source, against a stand-in `aws` program. The replies below are
//! recorded from AWS CLI 2.19.5 (and, for `--services`, read from its source in 2.34.22); no
//! test runs the real `aws`.
#![cfg(unix)]
// Setup that fails fails the test; clippy's test allowance covers only the test functions.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use tempfile::TempDir;
use ticketd_core::s3::{AwsCli, AwsCliError, ProfileCredentials, SignInCommand};

const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const TOKEN: &str = "IQoJb3JpZ2luX2VjEXAMPLETOKEN";

/// A stand-in `aws`: replies by exact argument list (in order for repeated calls, the last
/// reply repeating) and logs every call to `calls.log` beside it.
struct StandIn {
    dir: TempDir,
    rules: Vec<(String, Vec<Reply>)>,
}

struct Reply {
    out: String,
    err: String,
    code: i32,
}

fn ok(out: &str) -> Reply {
    Reply {
        out: out.into(),
        err: String::new(),
        code: 0,
    }
}

fn fails(code: i32, err: &str) -> Reply {
    Reply {
        out: String::new(),
        err: err.into(),
        code,
    }
}

const VERSION: &str = "aws-cli/2.19.5 Python/3.12.7 Darwin/25.5.0 source/arm64\n";

impl StandIn {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
            rules: Vec::new(),
        }
        .on("--version", vec![ok(VERSION)])
    }

    fn on(mut self, args: &str, replies: Vec<Reply>) -> Self {
        self.rules.push((args.into(), replies));
        self
    }

    fn once(self, args: &str, reply: Reply) -> Self {
        self.on(args, vec![reply])
    }

    /// Writes the script and returns its path. Later rules for the same arguments win.
    fn install(&self) -> PathBuf {
        let root = self.dir.path();
        let replies = root.join("replies");
        fs::create_dir_all(&replies).unwrap();
        let mut script = String::from("#!/bin/sh\nd=\"$(dirname \"$0\")\"\n");
        script += "printf '%s\\n' \"$*\" >> \"$d/calls.log\"\n";
        script += "n=$(grep -cxF -- \"$*\" \"$d/calls.log\")\n";
        for (i, (args, list)) in self.rules.iter().enumerate().rev() {
            for (k, reply) in list.iter().enumerate() {
                let k = k + 1;
                fs::write(replies.join(format!("{i}.{k}.out")), &reply.out).unwrap();
                fs::write(replies.join(format!("{i}.{k}.err")), &reply.err).unwrap();
                fs::write(
                    replies.join(format!("{i}.{k}.code")),
                    reply.code.to_string(),
                )
                .unwrap();
            }
            let quoted = args.replace('\'', "'\\''");
            script += &format!(
                "if [ \"$*\" = '{quoted}' ]; then k=$n; [ $k -gt {len} ] && k={len}; \
                 cat \"$d/replies/{i}.$k.out\"; cat \"$d/replies/{i}.$k.err\" >&2; \
                 exit \"$(cat \"$d/replies/{i}.$k.code\")\"; fi\n",
                len = list.len()
            );
        }
        script += "echo \"unexpected arguments: $*\" >&2\nexit 99\n";
        let path = root.join("aws");
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn cli(&self) -> AwsCli {
        AwsCli::locate_in(Some(&self.install()), &[]).unwrap()
    }

    /// How many times the program ran with exactly these arguments.
    fn calls(&self, args: &str) -> usize {
        fs::read_to_string(self.dir.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == args)
            .count()
    }
}

fn credentials_json(access: &str, expiration: Option<&str>) -> String {
    let mut json = format!(
        "{{\n  \"Version\": 1,\n  \"AccessKeyId\": \"{access}\",\n  \"SecretAccessKey\": \"{SECRET}\""
    );
    if let Some(expiration) = expiration {
        json += &format!(",\n  \"SessionToken\": \"{TOKEN}\",\n  \"Expiration\": \"{expiration}\"");
    }
    json + "\n}\n"
}

const EXPORT: &str = "configure export-credentials --profile work";

// ---- finding the program ---------------------------------------------------------------

#[test]
fn a_missing_program_is_not_found() {
    let empty = TempDir::new().unwrap();
    let error = AwsCli::locate_in(None, &[empty.path().to_path_buf()]).unwrap_err();
    assert!(matches!(error, AwsCliError::NotFound), "{error:?}");

    let chosen = empty.path().join("no-such-aws");
    let error = AwsCli::locate_in(Some(&chosen), &[]).unwrap_err();
    assert!(matches!(error, AwsCliError::NotFound), "{error:?}");
}

#[test]
fn the_program_is_found_in_the_first_usual_location_that_has_one() {
    let first = TempDir::new().unwrap();
    let second = StandIn::new();
    let program = second.install();
    let dirs = [
        first.path().to_path_buf(),
        program.parent().unwrap().to_path_buf(),
    ];
    let cli = AwsCli::locate_in(None, &dirs).unwrap();
    assert_eq!(cli.program(), program);
}

#[test]
fn a_chosen_program_wins_over_the_usual_locations() {
    let usual = StandIn::new();
    let chosen = StandIn::new();
    let chosen_path = chosen.install();
    let usual_dir = usual.install().parent().unwrap().to_path_buf();
    let cli = AwsCli::locate_in(Some(&chosen_path), &[usual_dir]).unwrap();
    assert_eq!(cli.program(), chosen_path);
}

#[test]
fn a_cli_older_than_2_13_or_version_1_is_too_old() {
    for output in [
        "aws-cli/2.12.8 Python/3.11.4 Linux/6.1 exe/x86_64.ubuntu.22 prompt/off\n",
        "aws-cli/1.32.100 Python/3.12.1 Darwin/23.2.0 botocore/1.34.100\n",
        "something else entirely\n",
    ] {
        let aws = StandIn::new().once("--version", ok(output));
        let error = AwsCli::locate_in(Some(&aws.install()), &[]).unwrap_err();
        match error {
            AwsCliError::UnsupportedVersion { found } => {
                assert!(output.starts_with(found.as_str()), "{found}");
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }
}

#[test]
fn version_2_13_and_later_is_accepted() {
    for output in [
        "aws-cli/2.13.0 Python/3.11.4 Linux/6.1\n",
        "aws-cli/2.34.22 Python/3.13.0 Darwin/25.5.0\n",
        "aws-cli/3.0.0 Python/3.14.0 Darwin/26.0.0\n",
    ] {
        let aws = StandIn::new().once("--version", ok(output));
        assert!(
            AwsCli::locate_in(Some(&aws.install()), &[]).is_ok(),
            "{output}"
        );
    }
}

// ---- profiles --------------------------------------------------------------------------

#[test]
fn profiles_are_listed_one_per_line() {
    let aws = StandIn::new().once(
        "configure list-profiles",
        ok("default\nwork\n\nminio-local\n"),
    );
    assert_eq!(
        aws.cli().profiles().unwrap(),
        ["default", "work", "minio-local"]
    );
}

// ---- who is signed in, and which buckets they can list -----------------------------------

const IDENTITY: &str = "sts get-caller-identity --profile work --query Arn --output text";
const BUCKETS: &str = "s3api list-buckets --profile work --query Buckets[].Name --output json";
const ARN: &str = "arn:aws:sts::123456789012:assumed-role/Admin/me";

#[test]
fn the_identity_is_the_caller_arn() {
    let aws = StandIn::new().once(IDENTITY, ok(&format!("{ARN}\n")));
    assert_eq!(aws.cli().identity("work").unwrap(), ARN);
}

#[test]
fn an_identity_asked_of_a_profile_that_never_signed_in_needs_sign_in() {
    let aws = StandIn::new().once(
        IDENTITY,
        fails(
            255,
            "\nError loading SSO Token: Token for work does not exist",
        ),
    );
    let error = aws.cli().identity("work").unwrap_err();
    assert!(error.needs_sign_in(), "{error:?}");
}

#[test]
fn an_identity_that_fails_otherwise_is_a_failure() {
    let aws = StandIn::new().once(
        IDENTITY,
        fails(253, "The config profile (work) could not be found"),
    );
    let error = aws.cli().identity("work").unwrap_err();
    assert!(!error.needs_sign_in(), "{error:?}");
    assert!(matches!(error, AwsCliError::Failed { .. }), "{error:?}");
}

#[test]
fn buckets_are_listed_by_name() {
    let aws = StandIn::new().once(BUCKETS, ok("[\n    \"alpha\",\n    \"beta\"\n]\n"));
    assert_eq!(
        aws.cli().buckets("work").unwrap(),
        Some(vec!["alpha".to_owned(), "beta".to_owned()])
    );
}

#[test]
fn an_account_without_buckets_lists_none() {
    // With no `Buckets` in the reply the query prints `null`.
    let aws = StandIn::new().once(BUCKETS, ok("null\n"));
    assert_eq!(aws.cli().buckets("work").unwrap(), Some(Vec::new()));
}

#[test]
fn a_profile_that_may_not_list_buckets_gets_none_not_an_error() {
    let aws = StandIn::new().once(
        BUCKETS,
        fails(
            254,
            "\nAn error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied",
        ),
    );
    assert_eq!(aws.cli().buckets("work").unwrap(), None);
}

#[test]
fn a_bucket_list_asked_of_an_ended_session_needs_sign_in() {
    let aws = StandIn::new().once(
        BUCKETS,
        fails(
            255,
            "The SSO session associated with this profile has expired or is otherwise invalid.",
        ),
    );
    let error = aws.cli().buckets("work").unwrap_err();
    assert!(error.needs_sign_in(), "{error:?}");
}

#[test]
fn a_bucket_list_that_cannot_be_read_is_unreadable() {
    let aws = StandIn::new().once(BUCKETS, ok("not json"));
    let error = aws.cli().buckets("work").unwrap_err();
    assert!(matches!(error, AwsCliError::Unreadable), "{error:?}");
}

// ---- credentials -----------------------------------------------------------------------

#[test]
fn temporary_credentials_carry_a_token_and_an_expiry() {
    let json = credentials_json("ASIAEXAMPLE", Some("2026-11-23T12:00:00+00:00"));
    let aws = StandIn::new().once(EXPORT, ok(&json));
    let credentials = aws.cli().credentials("work").unwrap();
    assert_eq!(credentials.access_key_id, "ASIAEXAMPLE");
    assert_eq!(credentials.secret_access_key, SECRET);
    assert_eq!(credentials.session_token.as_deref(), Some(TOKEN));
    assert_eq!(
        credentials.expires_at,
        Some("2026-11-23T12:00:00Z".parse::<DateTime<Utc>>().unwrap())
    );
}

#[test]
fn static_keys_have_no_token_and_no_expiry() {
    let json = credentials_json("AKIAEXAMPLE", None);
    let aws = StandIn::new().once(EXPORT, ok(&json));
    let credentials = aws.cli().credentials("work").unwrap();
    assert_eq!(credentials.session_token, None);
    assert_eq!(credentials.expires_at, None);
}

#[test]
fn credentials_never_show_in_debug_output() {
    let json = credentials_json("ASIAEXAMPLE", Some("2026-11-23T12:00:00+00:00"));
    let aws = StandIn::new().once(EXPORT, ok(&json));
    let credentials = aws.cli().credentials("work").unwrap();
    for text in [format!("{credentials:?}"), format!("{credentials:#?}")] {
        for secret in [SECRET, TOKEN, "ASIAEXAMPLE"] {
            assert!(!text.contains(secret), "{text}");
        }
    }
}

#[test]
fn unreadable_output_is_an_error_that_does_not_repeat_it() {
    let aws = StandIn::new().once(
        EXPORT,
        ok(&format!(
            "{{\"AccessKeyId\": \"AKIAEXAMPLE\", \"SecretAccessKey\": \"{SECRET}\", oops"
        )),
    );
    let error = aws.cli().credentials("work").unwrap_err();
    assert!(matches!(error, AwsCliError::Unreadable), "{error:?}");
    for text in [error.to_string(), format!("{error:?}")] {
        assert!(
            !text.contains(SECRET) && !text.contains("AKIAEXAMPLE"),
            "{text}"
        );
    }
}

fn plain_settings(aws: StandIn) -> StandIn {
    aws.once("configure get region --profile work", fails(1, ""))
        .once("configure get services --profile work", fails(1, ""))
        .once("configure get endpoint_url --profile work", fails(1, ""))
}

/// A source whose clock the test moves.
fn source(aws: &StandIn, start: DateTime<Utc>) -> (ProfileCredentials, Arc<Mutex<DateTime<Utc>>>) {
    let now = Arc::new(Mutex::new(start));
    let clock = {
        let now = Arc::clone(&now);
        move || *now.lock().unwrap()
    };
    (
        ProfileCredentials::with_clock(aws.cli(), "work", clock),
        now,
    )
}

#[test]
fn credentials_are_kept_until_shortly_before_they_expire_and_then_exported_again() {
    let start: DateTime<Utc> = "2026-11-23T10:00:00Z".parse().unwrap();
    let first = credentials_json("ASIAFIRST", Some("2026-11-23T11:00:00+00:00"));
    let second = credentials_json("ASIASECOND", Some("2026-11-23T12:00:00+00:00"));
    let aws = plain_settings(StandIn::new().on(EXPORT, vec![ok(&first), ok(&second)]));
    let (source, now) = source(&aws, start);

    assert_eq!(
        source.access().unwrap().credentials.access_key_id,
        "ASIAFIRST"
    );
    // Thirty minutes later it is the same export.
    *now.lock().unwrap() = start + TimeDelta::minutes(30);
    assert_eq!(
        source.access().unwrap().credentials.access_key_id,
        "ASIAFIRST"
    );
    assert_eq!(aws.calls(EXPORT), 1);

    // Two minutes before expiry is inside the safety margin: export again.
    *now.lock().unwrap() = start + TimeDelta::minutes(58);
    assert_eq!(
        source.access().unwrap().credentials.access_key_id,
        "ASIASECOND"
    );
    assert_eq!(aws.calls(EXPORT), 2);
}

#[test]
fn static_keys_are_exported_once() {
    let json = credentials_json("AKIAEXAMPLE", None);
    let aws = plain_settings(StandIn::new().once(EXPORT, ok(&json)));
    let (source, now) = source(&aws, "2026-11-23T10:00:00Z".parse().unwrap());
    source.access().unwrap();
    *now.lock().unwrap() += TimeDelta::days(400);
    source.access().unwrap();
    assert_eq!(aws.calls(EXPORT), 1);
}

#[test]
fn a_failed_export_is_not_kept() {
    let json = credentials_json("AKIAEXAMPLE", None);
    let aws = plain_settings(StandIn::new().on(
        EXPORT,
        vec![
            fails(253, "Unable to retrieve credentials: no network"),
            ok(&json),
        ],
    ));
    let (source, _) = source(&aws, "2026-11-23T10:00:00Z".parse().unwrap());
    assert!(source.access().is_err());
    assert!(source.access().is_ok());
}

#[test]
fn the_access_carries_the_profile_region_and_endpoint() {
    let json = credentials_json("AKIAEXAMPLE", None);
    let aws = StandIn::new()
        .once(EXPORT, ok(&json))
        .once("configure get region --profile work", ok("eu-west-1\n"))
        .once("configure get services --profile work", fails(1, ""))
        .once(
            "configure get endpoint_url --profile work",
            ok("http://localhost:9000\n"),
        );
    let (source, _) = source(&aws, "2026-11-23T10:00:00Z".parse().unwrap());
    let access = source.access().unwrap();
    assert_eq!(access.region.as_deref(), Some("eu-west-1"));
    assert_eq!(
        access.endpoint_url.as_deref(),
        Some("http://localhost:9000")
    );
    assert_eq!(access.credentials.access_key_id, "AKIAEXAMPLE");
    assert!(!format!("{access:?}").contains(SECRET));
}

// ---- sign in needed --------------------------------------------------------------------

#[test]
fn an_ended_session_is_sign_in_needed_and_other_failures_are_not() {
    for (code, message) in [
        (
            253,
            "\nUnable to retrieve credentials: Token has expired and refresh failed\n",
        ),
        (
            253,
            "\nUnable to retrieve credentials: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.\n",
        ),
        (
            253,
            "\nUnable to retrieve credentials: Your session has expired. Please reauthenticate using 'aws login'.\n",
        ),
        // A profile that never signed in: the CLI exits 255.
        (
            255,
            "\nError loading SSO Token: Token for work does not exist\n",
        ),
    ] {
        let aws = StandIn::new().once(EXPORT, fails(code, message));
        let error = aws.cli().credentials("work").unwrap_err();
        assert!(error.needs_sign_in(), "{message}: {error:?}");
        assert!(
            matches!(error, AwsCliError::SignInNeeded { .. }),
            "{error:?}"
        );
    }

    for (code, message) in [
        (
            253,
            "\nUnable to retrieve credentials: The config profile (work) could not be found\n",
        ),
        (
            253,
            "\nUnable to retrieve credentials: Could not connect to the endpoint URL\n",
        ),
        (1, "Token has expired and refresh failed"),
    ] {
        let aws = StandIn::new().once(EXPORT, fails(code, message));
        let error = aws.cli().credentials("work").unwrap_err();
        assert!(!error.needs_sign_in(), "{message}: {error:?}");
        match error {
            AwsCliError::Failed {
                exit_code,
                message: shown,
            } => {
                assert_eq!(exit_code, Some(code));
                assert_eq!(shown, message.trim());
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}

// ---- the sign-in command ---------------------------------------------------------------

fn profile_values(values: &[(&str, &str)]) -> StandIn {
    let mut aws = StandIn::new();
    for key in ["sso_session", "sso_start_url", "login_session"] {
        let reply = match values.iter().find(|(name, _)| *name == key) {
            Some((_, value)) => ok(&format!("{value}\n")),
            None => fails(1, ""),
        };
        aws = aws.once(&format!("configure get {key} --profile work"), reply);
    }
    aws
}

fn sign_in_for(values: &[(&str, &str)]) -> Option<SignInCommand> {
    profile_values(values)
        .cli()
        .sign_in_command("work")
        .unwrap()
}

#[test]
fn an_sso_profile_signs_in_with_aws_sso_login() {
    for values in [
        &[("sso_session", "corp")][..],
        // The SSO settings inline in the profile, as before sso-session sections existed.
        &[("sso_start_url", "https://example.awsapps.com/start")][..],
    ] {
        let command = sign_in_for(values).unwrap();
        assert_eq!(command.args(), ["sso", "login", "--profile", "work"]);
    }
}

#[test]
fn a_console_login_profile_signs_in_with_aws_login() {
    let command = sign_in_for(&[("login_session", "arn:aws:iam::111111111111:user/me")]).unwrap();
    assert_eq!(command.args(), ["login", "--profile", "work"]);
}

#[test]
fn a_static_key_profile_has_no_sign_in_command() {
    assert!(sign_in_for(&[]).is_none());
}

#[test]
fn only_a_profile_with_a_sign_in_command_can_sign_in_again() {
    let credentials = |values: &[(&str, &str)]| {
        ProfileCredentials::new(profile_values(values).cli(), "work").can_sign_in()
    };
    assert!(credentials(&[("sso_session", "corp")]));
    assert!(!credentials(&[]));
}

#[test]
fn running_the_sign_in_command_runs_the_program_with_those_arguments() {
    let aws = profile_values(&[("sso_session", "corp")]).once(
        "sso login --profile work",
        ok("Successfully logged into Start URL\n"),
    );
    let command = aws.cli().sign_in_command("work").unwrap().unwrap();
    command.run().unwrap();
    assert_eq!(aws.calls("sso login --profile work"), 1);

    let failing = profile_values(&[("sso_session", "corp")]).once(
        "sso login --profile work",
        fails(
            253,
            "Missing the following required SSO configuration values: sso_start_url",
        ),
    );
    let command = failing.cli().sign_in_command("work").unwrap().unwrap();
    let error = command.run().unwrap_err();
    assert!(
        matches!(
            error,
            AwsCliError::Failed {
                exit_code: Some(253),
                ..
            }
        ),
        "{error:?}"
    );
}

// ---- region and endpoint ---------------------------------------------------------------

#[test]
fn the_region_and_endpoint_come_from_the_profile() {
    let aws = StandIn::new()
        .once("configure get region --profile minio", ok("eu-west-1\n"))
        .once("configure get services --profile minio", fails(1, ""))
        .once(
            "configure get endpoint_url --profile minio",
            ok("http://localhost:9000\n"),
        );
    let settings = aws.cli().settings("minio").unwrap();
    assert_eq!(settings.region.as_deref(), Some("eu-west-1"));
    assert_eq!(
        settings.endpoint_url.as_deref(),
        Some("http://localhost:9000")
    );
}

#[test]
fn an_endpoint_in_a_services_section_wins_over_the_profile_endpoint() {
    let aws = StandIn::new()
        .once("configure get region --profile minio", ok("us-east-1\n"))
        .once("configure get services --profile minio", ok("storage\n"))
        .once(
            "configure get --services storage s3.endpoint_url --profile minio",
            ok("http://localhost:9001\n"),
        )
        .once(
            "configure get endpoint_url --profile minio",
            ok("http://localhost:9000\n"),
        );
    let settings = aws.cli().settings("minio").unwrap();
    assert_eq!(
        settings.endpoint_url.as_deref(),
        Some("http://localhost:9001")
    );
}

#[test]
fn a_cli_that_cannot_read_a_services_section_falls_back_to_the_profile_endpoint() {
    // CLI 2.19.5 has no `configure get --services`; it exits 252 with this message.
    let aws = StandIn::new()
        .once("configure get region --profile minio", ok("us-east-1\n"))
        .once("configure get services --profile minio", ok("storage\n"))
        .once(
            "configure get --services storage s3.endpoint_url --profile minio",
            fails(252, "\nUnknown options: --services,storage\n"),
        )
        .once(
            "configure get endpoint_url --profile minio",
            ok("http://localhost:9000\n"),
        );
    let settings = aws.cli().settings("minio").unwrap();
    assert_eq!(
        settings.endpoint_url.as_deref(),
        Some("http://localhost:9000")
    );
}

#[test]
fn a_profile_without_a_region_or_endpoint_has_neither() {
    let aws = StandIn::new()
        .once("configure get region --profile plain", fails(1, ""))
        .once("configure get services --profile plain", fails(1, ""))
        .once("configure get endpoint_url --profile plain", fails(1, ""));
    let settings = aws.cli().settings("plain").unwrap();
    assert_eq!(settings.region, None);
    assert_eq!(settings.endpoint_url, None);
}

#[test]
fn a_missing_profile_is_a_failure_not_an_empty_setting() {
    let aws = StandIn::new().once(
        "configure get region --profile nope",
        fails(255, "\nThe config profile (nope) could not be found\n"),
    );
    let error = aws.cli().settings("nope").unwrap_err();
    assert!(
        matches!(
            error,
            AwsCliError::Failed {
                exit_code: Some(255),
                ..
            }
        ),
        "{error:?}"
    );
}

// ---- the process -----------------------------------------------------------------------

#[test]
fn arguments_are_passed_as_given_never_through_a_shell() {
    let profile = "a b; echo pwned";
    let aws = StandIn::new().once(
        &format!("configure export-credentials --profile {profile}"),
        ok(&credentials_json("AKIAEXAMPLE", None)),
    );
    // The whole name arrives as one argument: a shell would have split it at the `;`.
    aws.cli().credentials(profile).unwrap();
    assert_eq!(
        aws.calls(&format!("configure export-credentials --profile {profile}")),
        1
    );
}

#[test]
fn a_program_that_hangs_is_stopped() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("aws");
    fs::write(
        &path,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'aws-cli/2.19.5 Python/3.12.7'; exit 0; fi\nexec sleep 30\n",
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    let cli = AwsCli::locate_in(Some(&path), &[])
        .unwrap()
        .with_timeout(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let error = cli.profiles().unwrap_err();
    assert!(matches!(error, AwsCliError::TimedOut), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
}
