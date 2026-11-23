//! The check before the first sync with a bucket: what it leaves behind, which failure each
//! kind of unsuitable bucket gives, how the bucket's region is found, and that Upload,
//! Download and Reconnect wait for it. Bucket behavior is simulated in `support/s3_sim.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use ticketd_core::s3::*;
use ticketd_core::sync::remote::{RemoteError, RemoteStorage};
use ticketd_core::{Error, Workspace};

#[path = "support/s3_sim.rs"]
mod s3_sim;
use s3_sim::{BUCKET, FakeCredentials, Fault, S3Sim, Versioning, target};

const PROBE: &str = "ticketd/.ticketd-bucket-check";
const PROBE_BYTES: &[u8] = b"ticketd checked that this bucket can hold a synced Workspace.\n";

struct Bench {
    sim: S3Sim,
    credentials: FakeCredentials,
}

impl Bench {
    fn new() -> Self {
        Self {
            sim: S3Sim::default(),
            credentials: FakeCredentials::default(),
        }
    }

    fn remote(&self) -> S3Remote<'_> {
        S3Remote::new(target(), "ticketd/", &self.credentials, &self.sim)
            .unwrap()
            .with_pause(|_| {})
    }

    fn check(&self) -> Result<(), BucketCheckError> {
        self.remote().check_bucket()
    }
}

fn denied(action: &str) -> BucketCheckError {
    BucketCheckError::PermissionDenied {
        action: action.into(),
    }
}

#[test]
fn a_passing_check_leaves_exactly_one_probe_object_however_often_it_runs() {
    let bench = Bench::new();
    bench.check().unwrap();
    assert_eq!(bench.sim.keys(), [PROBE]);
    assert_eq!(bench.sim.versions(PROBE).len(), 1);

    // Another desktop, or this one later: the file is there, so nothing more is written.
    bench.check().unwrap();
    assert_eq!(bench.sim.keys(), [PROBE]);
    assert_eq!(bench.sim.versions(PROBE).len(), 1);

    // The same adapter does not ask the bucket again.
    let remote = bench.remote();
    remote.check_bucket().unwrap();
    let requests = bench.sim.requests().len();
    remote.check_bucket().unwrap();
    assert_eq!(bench.sim.requests().len(), requests);
}

#[test]
fn versioning_that_is_off_or_suspended_is_refused_before_anything_is_written() {
    for (versioning, suspended) in [(Versioning::NeverSet, false), (Versioning::Suspended, true)] {
        let bench = Bench::new();
        bench.sim.versioning(versioning);
        assert_eq!(
            bench.check(),
            Err(BucketCheckError::VersioningOff { suspended })
        );
        assert!(bench.sim.keys().is_empty());
    }
    let message = BucketCheckError::VersioningOff { suspended: false }.to_string();
    assert!(message.contains("turn Versioning on"), "{message}");
}

#[test]
fn a_bucket_that_ignores_if_none_match_is_refused() {
    let bench = Bench::new();
    bench.sim.ignore_conditional_writes();
    assert_eq!(bench.check(), Err(BucketCheckError::NoConditionalWrites));

    // A service that does not know the header at all says so.
    let bench = Bench::new();
    bench.sim.fault(Fault::new(
        "PUT",
        ".ticketd-bucket-check",
        501,
        "NotImplemented",
    ));
    assert_eq!(bench.check(), Err(BucketCheckError::NoConditionalWrites));
}

#[test]
fn a_probe_stored_in_the_null_version_is_refused() {
    // Versioning was read as on, then suspended before the probe was written: the probe
    // would sit in the one `null` version, which the next write replaces.
    let bench = Bench::new();
    bench.sim.versioning(Versioning::SuspendedAfterTheRead);
    assert_eq!(
        bench.check(),
        Err(BucketCheckError::VersioningOff { suspended: true })
    );

    // A `null` probe made before Versioning was turned on is only read, and is accepted.
    let bench = Bench::new();
    bench.sim.versioning(Versioning::Suspended);
    bench.sim.put_foreign(PROBE, PROBE_BYTES);
    bench.sim.versioning(Versioning::Enabled);
    bench.check().unwrap();
}

#[test]
fn a_bucket_that_ignores_if_match_is_refused() {
    // An update that names another ETag must be refused, or an edit made after sync read the
    // file could overwrite another device's.
    let bench = Bench::new();
    bench.sim.ignore_if_match();
    assert_eq!(bench.check(), Err(BucketCheckError::NoConditionalUpdates));
    let message = BucketCheckError::NoConditionalUpdates.to_string();
    assert!(message.contains("If-Match"), "{message}");
}

#[test]
fn a_missing_bucket_is_named() {
    let bench = Bench::new();
    bench.sim.remove_bucket();
    assert_eq!(
        bench.check(),
        Err(BucketCheckError::MissingBucket {
            bucket: BUCKET.into()
        })
    );
}

#[test]
fn a_denied_action_is_named_wherever_the_bucket_denies_it() {
    // Each step of the check, and the action S3 names for it.
    let steps = [
        ("GET", "versioning", "s3:GetBucketVersioning"),
        ("PUT", ".ticketd-bucket-check", "s3:PutObject"),
        ("GET", "&versions", "s3:ListBucketVersions"),
        // Files in parts list the uploads in progress before the first part.
        ("GET", "uploads", "s3:ListBucketMultipartUploads"),
    ];
    for (method, url, action) in steps {
        let bench = Bench::new();
        bench.sim.fault(Fault::denied(method, url, action));
        assert_eq!(bench.check(), Err(denied(action)), "{action}");
    }

    // HeadBucket has no body, so the check names the action it was trying. S3 names the
    // bucket's region even in a refusal of the request, and a session that ended has none.
    let bench = Bench::new();
    let mut head = Fault::new("HEAD", BUCKET, 403, "AccessDenied");
    head.body.clear();
    head.headers = vec![("x-amz-bucket-region".into(), s3_sim::REGION.into())];
    bench.sim.fault(head);
    assert_eq!(bench.check(), Err(denied("s3:ListBucket")));

    // When S3 words it differently, the step's own action is named.
    let bench = Bench::new();
    bench
        .sim
        .fault(Fault::new("GET", "versioning", 403, "AccessDenied"));
    assert_eq!(bench.check(), Err(denied("s3:GetBucketVersioning")));
}

#[test]
fn a_head_refusal_without_a_region_is_read_from_a_request_that_can_say_why() {
    // A compatible service can refuse HeadBucket for a bucket policy and name no region.
    // Without a body that looks like an ended session; the listing's answer says which it is.
    let bench = Bench::new();
    let mut head = Fault::new("HEAD", BUCKET, 403, "AccessDenied");
    head.body.clear();
    head.times = 2;
    bench.sim.fault(head);
    bench
        .sim
        .fault(Fault::denied("GET", "list-type=2", "s3:ListBucket"));
    assert_eq!(bench.check(), Err(denied("s3:ListBucket")));

    // A static key refused for its policy is not a wrong key either.
    let bench = Bench {
        sim: S3Sim::default(),
        credentials: FakeCredentials::new(&["token-1", "token-2"]).without_sign_in(),
    };
    let mut head = Fault::new("HEAD", BUCKET, 403, "AccessDenied");
    head.body.clear();
    head.times = 2;
    bench.sim.fault(head);
    bench
        .sim
        .fault(Fault::denied("GET", "list-type=2", "s3:ListBucket"));
    assert_eq!(bench.check(), Err(denied("s3:ListBucket")));
}

#[test]
fn a_session_that_ended_on_head_bucket_renews_the_credentials_once_and_then_needs_sign_in() {
    // The answer to HeadBucket has no body, so the code that says "the session ended" is not
    // there: the status and the missing region header are all there is.
    let bench = Bench {
        sim: S3Sim::default(),
        credentials: FakeCredentials::new(&["token-1", "token-2"]),
    };
    bench.sim.accept_token("token-2");
    bench.check().unwrap();
    assert_eq!(bench.credentials.forgets(), 1);

    let bench = Bench {
        sim: S3Sim::default(),
        credentials: FakeCredentials::new(&["token-1", "token-2"]),
    };
    bench.sim.accept_token("token-3");
    assert_eq!(
        bench.check(),
        Err(BucketCheckError::Storage(RemoteError::Unauthorized))
    );
    // Once for HeadBucket, and once for the listing that reads why it was refused.
    assert_eq!(bench.credentials.forgets(), 2);

    // The same when the region is what the check is asking for.
    let probe = S3Target::new(BUCKET, "us-east-1", None).unwrap();
    assert_eq!(
        discover_bucket_region(&probe, &bench.credentials, &bench.sim),
        Err(BucketCheckError::Storage(RemoteError::Unauthorized))
    );
}

#[test]
fn a_reading_that_is_denied_names_the_read_that_failed() {
    // The read of the current file and the read of one version are different actions.
    let bench = Bench::new();
    let mut fault = Fault::new("GET", PROBE, 403, "AccessDenied");
    fault.times = 1;
    bench.sim.fault(fault);
    assert_eq!(bench.check(), Err(denied("s3:GetObject")));

    let bench = Bench::new();
    let mut fault = Fault::new("GET", "versionId=", 403, "AccessDenied");
    fault.times = 1;
    bench.sim.fault(fault);
    assert_eq!(bench.check(), Err(denied("s3:GetObjectVersion")));
}

#[test]
fn an_encryption_key_the_profile_cannot_use_is_its_own_failure() {
    for fault in [
        Fault::new("PUT", PROBE, 400, "KMS.NotFoundException"),
        Fault::denied("PUT", PROBE, "kms:GenerateDataKey"),
    ] {
        let bench = Bench::new();
        bench.sim.fault(fault);
        let error = bench.check().unwrap_err();
        assert!(
            matches!(error, BucketCheckError::KmsKeyUnusable { .. }),
            "{error:?}"
        );
        assert!(error.to_string().contains("kms:Decrypt"), "{error}");
    }
}

#[test]
fn a_bucket_named_with_kms_is_not_an_encryption_key_problem() {
    let bench = Bench::new();
    let mut fault = Fault::denied("GET", PROBE, "s3:GetObject");
    fault.body = fault
        .body
        .replace("arn:aws:s3:::", "arn:aws:s3:::team-kms-backups/");
    bench.sim.fault(fault);
    assert_eq!(bench.check(), Err(denied("s3:GetObject")));
}

#[test]
fn a_bucket_type_or_service_without_versioning_is_unsupported() {
    let bench = Bench::new();
    let directory = S3Target::new("ticketd--use1-az4--x-s3", "us-east-1", None).unwrap();
    let remote = S3Remote::new(directory, "ticketd/", &bench.credentials, &bench.sim).unwrap();
    assert!(matches!(
        remote.check_bucket(),
        Err(BucketCheckError::UnsupportedBucket { .. })
    ));
    assert!(bench.sim.requests().is_empty());

    let bench = Bench::new();
    bench
        .sim
        .fault(Fault::new("GET", "versioning", 501, "NotImplemented"));
    assert!(matches!(
        bench.check(),
        Err(BucketCheckError::UnsupportedBucket { .. })
    ));
}

#[test]
fn bytes_that_do_not_read_back_are_refused() {
    let bench = Bench::new();
    let mut fault = Fault::new("GET", PROBE, 200, "unused");
    fault.body = "not what was stored".into();
    bench.sim.fault(fault);
    assert_eq!(bench.check(), Err(BucketCheckError::ReadBackMismatch));
}

#[test]
fn an_ended_sign_in_or_a_lost_connection_is_not_the_buckets_fault() {
    let bench = Bench::new();
    bench.sim.offline(true);
    assert_eq!(
        bench.check(),
        Err(BucketCheckError::Storage(RemoteError::Offline))
    );

    let bench = Bench::new();
    bench.sim.accept_token("another-session");
    assert_eq!(
        bench.check(),
        Err(BucketCheckError::Storage(RemoteError::Unauthorized))
    );
}

#[test]
fn the_check_is_the_storages_answer_to_whether_it_is_usable() {
    let bench = Bench::new();
    bench.sim.versioning(Versioning::NeverSet);
    let RemoteError::Other(message) = bench.remote().check_usable().unwrap_err() else {
        panic!("a failed check reads as the storage's own words");
    };
    assert!(message.contains("Versioning is off"), "{message}");

    bench.sim.versioning(Versioning::Enabled);
    bench.remote().check_usable().unwrap();

    let bench = Bench::new();
    bench.sim.accept_token("another-session");
    assert_eq!(
        bench.remote().check_usable(),
        Err(RemoteError::Unauthorized)
    );
}

#[test]
fn a_buckets_region_is_read_from_the_answer_to_a_request_signed_for_us_east_1() {
    let bench = Bench::new();
    bench.sim.in_region("eu-west-1");
    let probe = S3Target::new(BUCKET, "us-east-1", None).unwrap();
    assert_eq!(
        discover_bucket_region(&probe, &bench.credentials, &bench.sim).unwrap(),
        "eu-west-1"
    );

    // A service that names no region is taken to be where it was asked.
    let bench = Bench::new();
    let mut head = Fault::new("HEAD", BUCKET, 200, "unused");
    head.body.clear();
    bench.sim.fault(head);
    assert_eq!(
        discover_bucket_region(&probe, &bench.credentials, &bench.sim).unwrap(),
        "us-east-1"
    );

    let bench = Bench::new();
    bench.sim.remove_bucket();
    assert_eq!(
        discover_bucket_region(&probe, &bench.credentials, &bench.sim),
        Err(BucketCheckError::MissingBucket {
            bucket: BUCKET.into()
        })
    );
}

struct Desk {
    _directory: tempfile::TempDir,
    workspace: Workspace,
}

fn new_desk() -> Desk {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    workspace
        .sync_connect_s3(
            &ticketd_core::sync::S3Binding {
                bucket: BUCKET.into(),
                prefix: "ticketd/".into(),
                profile: "work".into(),
                aws_cli_path: None,
            },
            "arn:aws:iam::123456789012:user/me",
        )
        .unwrap();
    Desk {
        _directory: directory,
        workspace,
    }
}

fn refused(result: Result<impl Sized, Error>) -> String {
    match result {
        Err(Error::Remote(RemoteError::Other(message))) => message,
        Err(other) => panic!("a refusal in the storage's words, not {other}"),
        Ok(_) => panic!("the check should have refused"),
    }
}

#[test]
fn upload_download_and_reconnect_refuse_to_start_without_a_passing_check() {
    let bench = Bench::new();
    bench.sim.versioning(Versioning::NeverSet);
    let remote = bench.remote();
    let mut desk = new_desk();

    // Each refusal leaves this Workspace unbound; it is the one that received the call.
    let unbound = |desk: &Desk| {
        assert!(desk.workspace.sync_binding().unwrap().is_none());
        assert_eq!(desk.workspace.sync_status().unwrap().folder, None);
    };
    let message = refused(desk.workspace.sync_upload_workspace(&remote, "Home"));
    assert!(message.contains("Versioning"), "{message}");
    unbound(&desk);
    assert!(refused(desk.workspace.sync_reconnect(&remote)).contains("Versioning"));
    unbound(&desk);
    assert!(refused(desk.workspace.sync_setup_options(&remote)).contains("Versioning"));
    unbound(&desk);

    // A download takes the Workspace by value, so it is opened again from its file.
    let path = desk._directory.path().join("workspace.sqlite3");
    assert!(
        refused(
            desk.workspace
                .sync_download_workspace(&remote, "some-folder")
        )
        .contains("Versioning")
    );
    let desk = Desk {
        _directory: desk._directory,
        workspace: Workspace::open(&path).unwrap(),
    };
    unbound(&desk);

    // The bucket holds nothing, and no folder was chosen.
    assert!(bench.sim.keys().is_empty());
    let mut desk = desk;
    let message = refused(desk.workspace.sync_upload_workspace(&remote, "Home"));
    assert!(message.contains("Versioning"), "{message}");
    unbound(&desk);
}

#[test]
fn once_the_check_passes_upload_goes_on_to_make_the_folder() {
    let bench = Bench::new();
    let remote = bench.remote();
    let mut desk = new_desk();
    let status = desk
        .workspace
        .sync_upload_workspace(&remote, "Home")
        .unwrap();
    let folder = status.folder.unwrap();

    let keys = bench.sim.keys();
    assert!(keys.contains(&PROBE.to_owned()), "{keys:?}");
    assert!(
        keys.contains(&format!("ticketd/{}/.ticketd-folder", folder.id)),
        "{keys:?}"
    );
}
