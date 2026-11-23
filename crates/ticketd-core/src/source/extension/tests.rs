#![allow(clippy::unwrap_used)]

use std::{
    io::Read,
    net::{Ipv4Addr, TcpListener},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use serde_json::json;

use crate::source::conformance::{
    self, ClosureProbes, CommentProbe, Driver, Fixture, PublishFailure,
};

use super::{host::Limits, *};

fn fixture_connector(host: Arc<Host>, connection: &str) -> ProcessConnector {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/source-extension");
    let launch = Arc::new(Launch::load(&folder).unwrap());
    let probe = Host::default();
    let hello = probe.probe(launch.clone(), &[CONTRACT_VERSION]).unwrap();
    ProcessConnector {
        description: hello.description.clone().unwrap(),
        definition: Definition {
            launch,
            cached: Some(Arc::new(hello)),
        },
        connection_id: Some(connection.into()),
        credentials: Default::default(),
        workflow_config: None,
        host,
        refresh: None,
    }
}

fn configuration(mode: &str) -> ConfigValues {
    json!({ "mode": mode }).as_object().unwrap().clone()
}

fn reference(id: u32) -> ExternalRef {
    ExternalRef {
        identity: crate::source::ExternalIdentity {
            provider: "scripted".into(),
            id: id.to_string(),
        },
        locator: format!("o/r#{id}"),
        partition: "o/r".into(),
    }
}

struct ProcessDriver;

fn fixture<T>(mode: &str, data: T) -> Fixture<T> {
    Fixture {
        connector: Box::new(fixture_connector(Arc::new(Host::default()), "fixture")),
        config: configuration(mode),
        data,
    }
}

impl Driver for ProcessDriver {
    fn discovery() -> Fixture<String> {
        fixture("valid", "3".into())
    }

    fn invalid_configuration() -> Fixture<()> {
        Fixture {
            config: ConfigValues::new(),
            ..fixture("valid", ())
        }
    }

    fn closures() -> Fixture<ClosureProbes> {
        fixture(
            "closure",
            ClosureProbes {
                open: reference(1),
                completed: reference(2),
                no_reason: reference(3),
                unknown_reason: reference(4),
                missing: reference(5),
                unreadable: reference(6),
            },
        )
    }

    fn comments() -> Fixture<CommentProbe> {
        fixture(
            "valid",
            CommentProbe {
                reference: reference(1),
                // The scripted source reports the edited body on the second request.
                edit: Box::new(|| {}),
            },
        )
    }

    fn publish_failure(failure: PublishFailure) -> Fixture<PublishRequest> {
        let mode = match failure {
            PublishFailure::Refused => "refuse",
            PublishFailure::NotSent => "not_sent",
            PublishFailure::ResponseLost => "lose_response",
        };
        fixture(mode, conformance::publication_search().request)
    }

    fn publication_search(complete: bool) -> Fixture<PublicationSearch> {
        fixture(
            if complete { "complete" } else { "incomplete" },
            conformance::publication_search(),
        )
    }
}

conformance::contract_tests!(scripted, super::ProcessDriver);

#[test]
fn malformed_and_oversized_stdout_fail_without_poisoning_the_next_call() {
    let connector = fixture_connector(Arc::new(Host::default()), "first");
    let malformed = connector
        .check_connection(&configuration("broken"))
        .unwrap_err();
    assert!(matches!(malformed, SourceError::Protocol(_)));
    assert!(malformed.to_string().contains("\"not a protocol message\""));
    let large = connector
        .check_connection(&configuration("oversized"))
        .unwrap_err();
    assert!(matches!(large, SourceError::Protocol(_)));
    assert!(large.to_string().contains("line exceeds"));
    let checked = connector.check_connection(&configuration("noisy")).unwrap();
    assert_eq!(checked.connection.account, "octo");
}

#[test]
fn progress_keeps_a_slow_discovery_call_alive() {
    let host = Arc::new(Host::with_limits(Limits {
        request: Duration::from_millis(350),
        ..Limits::default()
    }));
    let connector = fixture_connector(host, "first");
    let page = connector
        .discover(DiscoveryRequest {
            config: &configuration("slow_progress"),
            cursor: None,
            page_size: 10,
        })
        .unwrap();
    assert_eq!(page.issues.len(), 1);
}

#[test]
fn progress_cannot_extend_discovery_past_its_hard_limit() {
    let host = Arc::new(Host::with_limits(Limits {
        request: Duration::from_millis(350),
        hard: Duration::from_millis(650),
        grace: Duration::from_millis(400),
        ..Limits::default()
    }));
    let connector = fixture_connector(host, "first");
    let process = |connector: &dyn Connector| {
        connector
            .check_connection(&configuration("session"))
            .unwrap()
            .connection
            .account
    };
    let before = process(&connector);
    let started = Instant::now();
    let error = connector
        .discover(DiscoveryRequest {
            config: &configuration("cooperative"),
            cursor: None,
            page_size: 10,
        })
        .unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    assert!((Duration::from_millis(600)..Duration::from_secs(3)).contains(&started.elapsed()));
    assert_eq!(process(&connector), before);
}

#[tokio::test]
async fn a_canceled_discovery_keeps_a_cooperating_process() {
    let (before, after) = cancel_discovery("cooperative").await;
    assert_eq!(before, after);
}

#[tokio::test]
async fn a_canceled_discovery_restarts_a_process_that_ignores_cancel() {
    let (before, after) = cancel_discovery("ignore_cancel").await;
    assert_ne!(before, after);
}

async fn cancel_discovery(mode: &'static str) -> (String, String) {
    let host = Arc::new(Host::with_limits(Limits {
        grace: Duration::from_millis(350),
        ..Limits::default()
    }));
    let connector = fixture_connector(host, "first");
    let process = || {
        connector
            .check_connection(&configuration("session"))
            .unwrap()
            .connection
            .account
    };
    let before = process();
    let control = RefreshControl::default();
    let mut progress = control.progress();
    let controlled = connector.for_refresh(&control).unwrap();
    let operation = tokio::task::spawn_blocking(move || {
        controlled.discover(DiscoveryRequest {
            config: &configuration(mode),
            cursor: None,
            page_size: 10,
        })
    });
    tokio::time::timeout(Duration::from_secs(3), progress.changed())
        .await
        .unwrap()
        .unwrap();
    control.cancel();
    let error = tokio::time::timeout(Duration::from_secs(4), operation)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, SourceError::RefreshCanceled), "{error}");
    (before, process())
}

#[test]
fn a_timeout_covers_reads_and_blocked_writes() {
    let host = Arc::new(Host::with_limits(Limits {
        request: Duration::from_millis(300),
        ..Limits::default()
    }));
    let connector = fixture_connector(host, "first");
    let read = connector
        .check_connection(&configuration("hang"))
        .unwrap_err();
    assert!(read.to_string().contains("timed out"));
    connector
        .check_connection(&configuration("stop_reading"))
        .unwrap();
    let output = connector.options(
        "field",
        &"a".repeat(2 * 1024 * 1024),
        &configuration("valid"),
    );
    assert!(output.unwrap_err().to_string().contains("timed out"));
    assert!(connector.check_connection(&configuration("valid")).is_ok());
}

#[test]
fn a_crash_latch_is_specific_to_one_connection_and_retry_clears_it() {
    let host = Arc::new(Host::default());
    let first = fixture_connector(host.clone(), "first");
    let second = first
        .for_connection("second", &configuration("valid"))
        .unwrap();
    for _ in 0..5 {
        let error = first.check_connection(&configuration("crash")).unwrap_err();
        assert!(matches!(error, SourceError::Unavailable(_)), "{error}");
    }
    let error = first.check_connection(&configuration("valid")).unwrap_err();
    assert!(matches!(error, SourceError::ExtensionCrashLimit), "{error}");
    assert!(second.check_connection(&configuration("valid")).is_ok());
    host.retry("first");
    assert!(first.check_connection(&configuration("valid")).is_ok());
}

#[test]
fn connections_reuse_their_own_process_until_idle() {
    let host = Arc::new(Host::with_limits(Limits {
        idle: Duration::from_millis(500),
        ..Limits::default()
    }));
    let first = fixture_connector(host, "first");
    let config = configuration("session");
    let second = first.for_connection("second", &config).unwrap();
    let account = |connector: &dyn Connector| {
        connector
            .check_connection(&config)
            .unwrap()
            .connection
            .account
    };
    let first_process = account(&first);
    assert!(first_process.starts_with("first:"));
    assert_eq!(account(&first), first_process);
    let second_process = account(second.as_ref());
    assert!(second_process.starts_with("second:"));
    assert_ne!(
        first_process.split_once(':').unwrap().1,
        second_process.split_once(':').unwrap().1
    );
    thread::sleep(Duration::from_millis(850));
    assert_ne!(account(&first), first_process);
}

#[test]
fn an_exited_leader_is_unavailable_and_its_descendant_is_stopped() {
    let connector = fixture_connector(Arc::new(Host::default()), "first");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let mut config = configuration("orphan");
    config.insert(
        "port".into(),
        listener.local_addr().unwrap().port().to_string().into(),
    );
    let start = Instant::now();
    let error = connector.check_connection(&config).unwrap_err();
    assert!(matches!(error, SourceError::Unavailable(_)), "{error}");
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "the descendant held the process open"
    );
    listener.set_nonblocking(true).unwrap();
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut text = String::new();
    match stream.read_to_string(&mut text) {
        Ok(_) => assert_eq!(text, "ready"),
        // Terminating the Job Object can reset an accepted Windows socket
        // before its last buffered bytes reach the reader.
        Err(error) if cfg!(windows) && error.kind() == std::io::ErrorKind::ConnectionReset => {
            assert!("ready".starts_with(&text));
        }
        Err(error) => panic!("the descendant's socket did not close: {error}"),
    }
}

#[test]
fn an_installed_folder_is_checked_even_with_a_warm_process() {
    let scratch = tempfile::tempdir().unwrap();
    let registry_folder = scratch.path().join("extensions");
    let registry = ExtensionRegistry::new(registry_folder.clone());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/source-extension");
    let installed = registry
        .add(registry.prepare_add(&fixture).unwrap())
        .unwrap();

    let config = configuration("valid");
    let engine = registry
        .engine()
        .unwrap()
        .for_connection("scripted", "scripted", &config);
    assert!(engine.check_connection("scripted", &config).is_ok());
    std::fs::write(installed.path.join("extra-file"), "changed").unwrap();
    let error = engine.check_connection("scripted", &config).unwrap_err();
    assert!(error.to_string().contains("add it again"), "{error}");
}

#[cfg(unix)]
#[test]
fn an_install_refuses_a_symlink_to_an_executable_outside_the_package() {
    let scratch = tempfile::tempdir().unwrap();
    let installation = ExtensionRegistry::new(scratch.path().join("extensions"));
    let package = scratch.path().join("package");
    std::fs::create_dir(&package).unwrap();
    std::os::unix::fs::symlink("/bin/sh", package.join("tracker")).unwrap();
    std::fs::write(
        package.join("ticketd-source.json"),
        r#"{ "id": "scripted", "version": "0.0.1", "executable": "./tracker" }"#,
    )
    .unwrap();

    let error = installation.prepare_add(&package).err().unwrap();
    assert!(error.to_string().contains("symlinks"), "{error}");
}
