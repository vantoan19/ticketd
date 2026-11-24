//! The S3 storage of this desktop's S3 binding (ADR 0018). One [`S3Storage`] serves a
//! binding for as long as the app runs, like the one Drive storage. It reaches the bucket
//! through the AWS CLI profile, which needs the CLI to be installed and signed in, so it
//! is put together on first use, not when the Workspace is read. A CLI that is missing or
//! a session that ended is then an error of that call, which sync turns into a state the
//! person sees, and the next call tries again.

use std::{
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use ticketd_core::{
    s3::{
        AwsCli, AwsCliError, CredentialSource, Credentials, ProfileCredentials, S3Remote, S3Target,
        S3TargetError, UreqS3Transport, cli_failure, discover_bucket_region,
    },
    sync::{
        S3Binding,
        remote::{
            RemoteCapabilities, RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey,
            RemoteRevision, RemoteStorage,
        },
        s3_service_changed,
    },
};

use crate::s3_commands;

/// A storage put together, and where it reaches.
pub struct Built {
    pub storage: Arc<dyn RemoteStorage>,
    pub target: S3Target,
}

type Build = dyn Fn(&S3Binding) -> Result<Built, RemoteError> + Send + Sync;

/// Reads the S3 service the profile reaches now, as [`S3Binding::endpoint`] keeps it.
type Reach = dyn Fn(&S3Binding) -> Result<String, RemoteError> + Send + Sync;

/// How long a built storage is trusted to still reach what the profile says. The profile is
/// the person's own file, edited while the app runs; reading it is a process of the AWS CLI,
/// so it is read now and then, not per request.
const RECHECK: Duration = Duration::from_secs(120);

struct Kept {
    built: Arc<Built>,
    /// When the profile's service was last compared with the one this storage reached.
    checked: Instant,
}

pub struct S3Storage {
    binding: S3Binding,
    build: Box<Build>,
    reach: Box<Reach>,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
    built: Mutex<Option<Kept>>,
}

impl S3Storage {
    pub fn new(binding: S3Binding) -> Self {
        Self::with_build(binding, build)
    }

    fn with_build(
        binding: S3Binding,
        build: impl Fn(&S3Binding) -> Result<Built, RemoteError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            binding,
            build: Box::new(build),
            reach: Box::new(reach),
            clock: Box::new(Instant::now),
            built: Mutex::new(None),
        }
    }

    /// Reads the profile's service with `reach` and the time from `clock`, for tests.
    #[cfg(test)]
    fn with_reach(
        mut self,
        reach: impl Fn(&S3Binding) -> Result<String, RemoteError> + Send + Sync + 'static,
        clock: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        self.reach = Box::new(reach);
        self.clock = Box::new(clock);
        self
    }

    /// The storage ready to use. A failure keeps nothing, so the next call tries again.
    ///
    /// A kept storage is trusted for [`RECHECK`]; after that the profile's service is read
    /// again, and a storage that reached another one is dropped, so the build refuses it (the
    /// profile was edited while the app ran).
    pub fn built(&self) -> Result<Arc<Built>, RemoteError> {
        let mut kept = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        let now = (self.clock)();
        if let Some(held) = kept.as_mut() {
            if now.saturating_duration_since(held.checked) < RECHECK {
                return Ok(Arc::clone(&held.built));
            }
            // Counted from this read, whether or not it worked: a profile that cannot be read
            // says nothing against the storage, and is not read again for every request.
            held.checked = now;
            match (self.reach)(&self.binding) {
                Ok(reached) if reached != service(&held.built.target) => *kept = None,
                _ => return Ok(Arc::clone(&held.built)),
            }
        }
        let built = Arc::new((self.build)(&self.binding)?);
        *kept = Some(Kept {
            built: Arc::clone(&built),
            checked: now,
        });
        Ok(built)
    }

    fn storage(&self) -> Result<Arc<dyn RemoteStorage>, RemoteError> {
        Ok(Arc::clone(&self.built()?.storage))
    }

    pub fn binding(&self) -> &S3Binding {
        &self.binding
    }

    /// The S3 service the profile reached when the storage was put together, as
    /// [`S3Binding::endpoint`] keeps it; `None` while it has not been built.
    pub fn reached(&self) -> Option<String> {
        let kept = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        Some(service(&kept.as_ref()?.built.target).to_owned())
    }

    /// The `s3://` address of a Workspace folder, for a person to open in another tool.
    pub fn address(&self, folder: &str) -> String {
        address(&self.binding, folder)
    }

    /// The AWS console page of a Workspace folder, when its bucket is on AWS and the
    /// storage can be reached to know where. `None` for another S3 service.
    pub fn console_url(&self, folder: &str) -> Option<String> {
        let built = self.built().ok()?;
        console_url(&built.target, &self.binding, folder)
    }
}

pub fn address(binding: &S3Binding, folder: &str) -> String {
    format!("s3://{}/{}{folder}/", binding.bucket, binding.prefix)
}

/// The S3 service a target reaches, as [`S3Binding::endpoint`] keeps it: the empty string
/// is AWS's own.
pub fn service(target: &S3Target) -> &str {
    target.endpoint().unwrap_or_default()
}

/// Refuses a profile that reaches another S3 service than the one the binding was connected
/// through. A binding with none recorded takes whatever the profile reaches.
fn check_service(binding: &S3Binding, reached: &str) -> Result<(), RemoteError> {
    match binding.endpoint.as_deref() {
        Some(recorded) if recorded != reached => Err(RemoteError::ServiceChanged(
            s3_service_changed(recorded, reached),
        )),
        _ => Ok(()),
    }
}

/// The S3 console page of the folder: the standard AWS partition only, since the
/// consoles of China and GovCloud live elsewhere, and none for any other endpoint.
pub fn console_url(target: &S3Target, binding: &S3Binding, folder: &str) -> Option<String> {
    let region = target.region();
    if target.endpoint().is_some() || region.starts_with("cn-") || region.starts_with("us-gov-") {
        return None;
    }
    Some(format!(
        "https://{region}.console.aws.amazon.com/s3/buckets/{}?region={region}&prefix={}{folder}/&showversions=false",
        binding.bucket, binding.prefix
    ))
}

impl RemoteStorage for S3Storage {
    fn capabilities(&self) -> RemoteCapabilities {
        // Every S3 does what ticketd asks of it (ADR 0018), which the adapter reports
        // the same way; they are known before any request.
        RemoteCapabilities {
            conditional_writes: true,
            keeps_revisions: true,
        }
    }

    fn check_usable(&self) -> Result<(), RemoteError> {
        self.storage()?.check_usable()
    }

    fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
        self.storage()?.folders()
    }

    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
        self.storage()?.ensure_folder(folder, name)
    }

    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
        self.storage()?.list(folder)
    }

    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn std::io::Write,
    ) -> Result<(), RemoteError> {
        self.storage()?.download(folder, key, version, output)
    }

    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
    ) -> Result<RemoteFile, RemoteError> {
        self.storage()?.write(folder, key, name, expected, content)
    }

    fn revisions(&self, folder: &str, key: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError> {
        self.storage()?.revisions(folder, key)
    }
}

/// What a failure of the AWS CLI means to sync: a session to sign in to again, or a failure.
fn cli_error(error: AwsCliError) -> RemoteError {
    cli_failure(&error)
}

/// One set of credentials of a profile, shared with the sign-in command that forgets it.
struct Shared(Arc<ProfileCredentials>);

impl CredentialSource for Shared {
    fn credentials(&self) -> Result<Credentials, AwsCliError> {
        self.0.credentials()
    }

    fn forget(&self) {
        self.0.forget();
    }

    fn can_sign_in(&self) -> bool {
        self.0.can_sign_in()
    }
}

/// The S3 service the profile reaches now, read from the AWS CLI's configuration.
fn reach(binding: &S3Binding) -> Result<String, RemoteError> {
    let cli = AwsCli::locate(binding.aws_cli_path.as_deref().map(Path::new)).map_err(cli_error)?;
    let settings = cli.settings(&binding.profile).map_err(cli_error)?;
    // The region is not asked of the target: it only normalizes the endpoint.
    let target = S3Target::new(
        &binding.bucket,
        "us-east-1",
        settings.endpoint_url.as_deref(),
    )
    .map_err(|error| RemoteError::Other(error.to_string()))?;
    Ok(service(&target).to_owned())
}

fn build(binding: &S3Binding) -> Result<Built, RemoteError> {
    let cli = AwsCli::locate(binding.aws_cli_path.as_deref().map(Path::new)).map_err(cli_error)?;
    let settings = cli.settings(&binding.profile).map_err(cli_error)?;
    let other = |error: S3TargetError| RemoteError::Other(error.to_string());
    let endpoint = settings.endpoint_url.as_deref();
    let credentials = Arc::new(Shared(s3_commands::credentials(&cli, &binding.profile)));
    // An AWS bucket has a region of its own, which the profile's need not be: ask AWS where
    // it is. Another service has no other region than the profile's.
    let probe_region = match endpoint {
        Some(_) => settings.region.as_deref().unwrap_or("us-east-1"),
        None => "us-east-1",
    };
    let probe = S3Target::new(&binding.bucket, probe_region, endpoint).map_err(other)?;
    // Before anything is sent: a profile edited to another service must not be signed for.
    check_service(binding, service(&probe))?;
    let region = discover_bucket_region(
        &probe,
        credentials.as_ref(),
        &UreqS3Transport::new(probe.clone()),
    )?;
    let target = S3Target::new(&binding.bucket, &region, endpoint).map_err(other)?;
    // The adapter owns what it signs and sends with, so a build that fails, or a storage that
    // is replaced, frees them.
    let transport = Arc::new(UreqS3Transport::new(target.clone()));
    let remote =
        S3Remote::shared(target.clone(), &binding.prefix, credentials, transport).map_err(other)?;
    Ok(Built {
        storage: Arc::new(remote),
        target,
    })
}

static KEPT: Mutex<Option<Arc<S3Storage>>> = Mutex::new(None);

/// Tests that keep or drop the process-wide storage and credentials take this, so one
/// test's reset cannot drop what a test running beside it is counting on.
#[cfg(test)]
pub(crate) static TEST_STATE: Mutex<()> = Mutex::new(());

/// Keeps a storage already built for `binding`, as if sync had reached `target` through it.
#[cfg(test)]
pub(crate) fn keep_built(binding: &S3Binding, remote: Arc<dyn RemoteStorage>, target: S3Target) {
    let storage = Arc::new(S3Storage::with_build(binding.clone(), move |_| {
        Ok(Built {
            storage: Arc::clone(&remote),
            target: target.clone(),
        })
    }));
    storage.built().ok();
    *KEPT.lock().unwrap_or_else(PoisonError::into_inner) = Some(storage);
}

/// Drops the kept storage and the credentials kept for every profile. The next call builds
/// the storage from the profile as it is now: its endpoint, its region and its account. Setup
/// choices (connect, upload, download, reconnect) call this, since a person who comes back to
/// them may have changed the profile.
pub fn reset() {
    *KEPT.lock().unwrap_or_else(PoisonError::into_inner) = None;
    s3_commands::forget_all_credentials();
}

/// The storage of an S3 binding. One value is kept, so what it learned (the region, a
/// folder's marker) lasts between runs; a changed binding gets a new one.
pub fn storage(binding: &S3Binding) -> Arc<S3Storage> {
    let mut kept = KEPT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(storage) = kept.as_ref()
        && storage.binding() == binding
    {
        return Arc::clone(storage);
    }
    let storage = Arc::new(S3Storage::new(binding.clone()));
    *kept = Some(Arc::clone(&storage));
    storage
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use ticketd_core::sync::remote::FakeRemote;

    fn binding() -> S3Binding {
        S3Binding {
            bucket: "team-bucket".into(),
            prefix: "ticketd/".into(),
            profile: "work".into(),
            aws_cli_path: None,
            endpoint: Some(String::new()),
        }
    }

    fn built(fake: &FakeRemote, region: &str, endpoint: Option<&str>) -> Built {
        Built {
            storage: Arc::new(fake.clone()),
            target: S3Target::new("team-bucket", region, endpoint).unwrap(),
        }
    }

    #[test]
    fn a_storage_that_could_not_be_put_together_fails_that_call_and_tries_again() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let fake = FakeRemote::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let storage = S3Storage::with_build(binding(), move |_| {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(RemoteError::Unauthorized)
            } else {
                Ok(built(&fake, "us-east-1", None))
            }
        });
        // The session ended: sync's state for it, not a failure of the app.
        assert!(matches!(storage.folders(), Err(RemoteError::Unauthorized)));
        // Signed in again, the next call works, and the storage is made once.
        storage.ensure_folder("f1", "Team").unwrap();
        assert_eq!(storage.folders().unwrap()[0].id, "f1");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    /// A bucket the check turns down; nothing else of it is used.
    struct Unusable;

    impl RemoteStorage for Unusable {
        fn capabilities(&self) -> RemoteCapabilities {
            RemoteCapabilities {
                conditional_writes: true,
                keeps_revisions: true,
            }
        }
        fn check_usable(&self) -> Result<(), RemoteError> {
            Err(RemoteError::Other("turn on Versioning".into()))
        }
        fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
            Err(RemoteError::NotFound)
        }
        fn ensure_folder(&self, _: &str, _: &str) -> Result<(), RemoteError> {
            Err(RemoteError::NotFound)
        }
        fn list(&self, _: &str) -> Result<Vec<RemoteFile>, RemoteError> {
            Err(RemoteError::NotFound)
        }
        fn download(
            &self,
            _: &str,
            _: &RemoteKey,
            _: &str,
            _: &mut dyn std::io::Write,
        ) -> Result<(), RemoteError> {
            Err(RemoteError::NotFound)
        }
        fn write(
            &self,
            _: &str,
            _: &RemoteKey,
            _: &str,
            _: Option<&str>,
            _: &mut dyn RemoteContent,
        ) -> Result<RemoteFile, RemoteError> {
            Err(RemoteError::NotFound)
        }
        fn revisions(&self, _: &str, _: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError> {
            Err(RemoteError::NotFound)
        }
    }

    #[test]
    fn the_buckets_own_check_is_what_the_core_gets() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let storage = S3Storage::with_build(binding(), |_| {
            Ok(Built {
                storage: Arc::new(Unusable),
                target: S3Target::new("team-bucket", "us-east-1", None).unwrap(),
            })
        });
        let Err(RemoteError::Other(message)) = storage.check_usable() else {
            panic!("the bucket's refusal did not reach the core");
        };
        assert_eq!(message, "turn on Versioning");
    }

    #[test]
    fn a_folder_is_named_by_its_address_and_the_console_page_where_aws_has_one() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let fake = FakeRemote::new();
        let aws = built(&fake, "eu-west-1", None);
        assert_eq!(address(&binding(), "f1"), "s3://team-bucket/ticketd/f1/");
        assert_eq!(
            console_url(&aws.target, &binding(), "f1").unwrap(),
            "https://eu-west-1.console.aws.amazon.com/s3/buckets/team-bucket?region=eu-west-1&prefix=ticketd/f1/&showversions=false"
        );
        // Another S3 service, and the AWS partitions with consoles elsewhere, have none.
        let other = built(&fake, "us-east-1", Some("https://s3.example.com"));
        assert_eq!(console_url(&other.target, &binding(), "f1"), None);
        let china = built(&fake, "cn-north-1", None);
        assert_eq!(console_url(&china.target, &binding(), "f1"), None);
    }

    #[test]
    fn the_storage_says_which_service_it_reached_once_it_is_built() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let fake = FakeRemote::new();
        let on = |endpoint: Option<&'static str>| {
            let fake = fake.clone();
            S3Storage::with_build(binding(), move |_| Ok(built(&fake, "us-east-1", endpoint)))
        };
        let minio = on(Some("https://minio.example.com:9000"));
        assert_eq!(minio.reached(), None, "nothing is known before the build");
        minio.folders().unwrap();
        assert_eq!(
            minio.reached().as_deref(),
            Some("https://minio.example.com:9000")
        );
        let aws = on(None);
        aws.folders().unwrap();
        assert_eq!(aws.reached().as_deref(), Some(""));
    }

    #[test]
    fn a_binding_with_no_service_recorded_takes_whatever_the_profile_reaches() {
        let recorded = |endpoint: Option<&str>| S3Binding {
            endpoint: endpoint.map(str::to_owned),
            ..binding()
        };
        assert!(check_service(&recorded(None), "https://minio.example.com:9000").is_ok());
        assert!(check_service(&recorded(Some("")), "").is_ok());
        assert!(
            check_service(
                &recorded(Some("https://minio.example.com:9000")),
                "https://minio.example.com:9000"
            )
            .is_ok()
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_profile_that_now_reaches_another_service_stops_sync_before_anything_is_sent() {
        use std::os::unix::fs::PermissionsExt;
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // The profile was edited to point at MinIO; the Workspace's bucket was connected on AWS.
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("aws");
        std::fs::write(
            &program,
            "#!/bin/sh\ncase \"$1\" in\n--version) echo 'aws-cli/2.19.5 Python/3.12.7';;\nconfigure) case \"$3\" in endpoint_url) echo https://minio.example.com:9000;; *) exit 1;; esac;;\nesac\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let storage = S3Storage::new(S3Binding {
            aws_cli_path: Some(program.display().to_string()),
            ..binding()
        });

        let Err(RemoteError::ServiceChanged(message)) = storage.folders() else {
            panic!("a profile that reaches another service was used");
        };
        assert!(message.contains("This profile now points to another S3 service"));
        assert!(message.contains("https://minio.example.com:9000"));
        assert!(message.contains("AWS"));
        assert!(message.contains("disconnect sync, then connect again"));
        // Nothing was kept: the profile pointing back works again at the next call.
        assert_eq!(storage.reached(), None);
    }

    /// A profile whose endpoint a test edits, and a clock it moves, behind a storage that
    /// builds like the real one: it refuses a profile that reaches another service.
    struct Session {
        storage: S3Storage,
        profile: Arc<Mutex<String>>,
        clock: Arc<Mutex<Duration>>,
        builds: Arc<AtomicUsize>,
        reads: Arc<AtomicUsize>,
    }

    fn session(recorded: &str, profile: &str) -> Session {
        let profile = Arc::new(Mutex::new(profile.to_owned()));
        let clock = Arc::new(Mutex::new(Duration::ZERO));
        let builds = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let fake = FakeRemote::new();
        let (edited, counted) = (Arc::clone(&profile), Arc::clone(&builds));
        let (read, counting) = (Arc::clone(&profile), Arc::clone(&reads));
        let (base, moved) = (Instant::now(), Arc::clone(&clock));
        let storage = S3Storage::with_build(
            S3Binding {
                endpoint: Some(recorded.to_owned()),
                ..binding()
            },
            move |binding| {
                counted.fetch_add(1, Ordering::SeqCst);
                let reached = edited.lock().unwrap().clone();
                check_service(binding, &reached)?;
                Ok(built(&fake, "us-east-1", Some(&reached)))
            },
        )
        .with_reach(
            move |_| {
                counting.fetch_add(1, Ordering::SeqCst);
                Ok(read.lock().unwrap().clone())
            },
            move || base + *moved.lock().unwrap(),
        );
        Session {
            storage,
            profile,
            clock,
            builds,
            reads,
        }
    }

    impl Session {
        fn edit_profile(&self, endpoint: &str) {
            *self.profile.lock().unwrap() = endpoint.to_owned();
        }
        fn wait(&self, time: Duration) {
            *self.clock.lock().unwrap() += time;
        }
    }

    #[test]
    fn a_profile_edited_while_the_app_runs_is_noticed_within_the_recheck_time() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let at = |port: u16| format!("http://127.0.0.1:{port}");
        let session = session(&at(9000), &at(9000));
        session.storage.folders().unwrap();

        // The profile now reaches another service. Until the recheck time passes, the
        // storage is used as built, and the profile is not read per request.
        session.edit_profile(&at(9001));
        session.wait(RECHECK / 2);
        for _ in 0..5 {
            session.storage.folders().unwrap();
        }
        assert_eq!(session.reads.load(Ordering::SeqCst), 0);

        // Then the next call reads the profile, drops the storage and refuses.
        session.wait(RECHECK);
        let Err(RemoteError::ServiceChanged(said)) = session.storage.folders() else {
            panic!("a profile that reaches another service was still used");
        };
        assert!(said.contains("http://127.0.0.1:9001"), "{said}");
        assert!(said.contains("http://127.0.0.1:9000"), "{said}");
        assert_eq!(session.reads.load(Ordering::SeqCst), 1);
        assert_eq!(session.storage.reached(), None);
        // It keeps refusing, and a profile pointing back works again.
        assert!(matches!(
            session.storage.folders(),
            Err(RemoteError::ServiceChanged(_))
        ));
        session.edit_profile(&at(9000));
        session.storage.folders().unwrap();
    }

    #[test]
    fn a_profile_that_did_not_change_keeps_its_storage_and_is_read_once_per_recheck() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let session = session("https://minio.example.com", "https://minio.example.com");
        for _ in 0..3 {
            session.storage.folders().unwrap();
            session.wait(RECHECK + Duration::from_secs(1));
        }
        // Read at the second and the third call, never rebuilt.
        assert_eq!(session.reads.load(Ordering::SeqCst), 2);
        assert_eq!(session.builds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_profile_that_cannot_be_read_for_the_recheck_keeps_the_storage_until_the_next_one() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let fake = FakeRemote::new();
        let now = Arc::new(Mutex::new(Duration::ZERO));
        let (base, moved) = (Instant::now(), Arc::clone(&now));
        let reads = Arc::new(AtomicUsize::new(0));
        let counting = Arc::clone(&reads);
        let storage =
            S3Storage::with_build(binding(), move |_| Ok(built(&fake, "us-east-1", None)))
                .with_reach(
                    move |_| {
                        counting.fetch_add(1, Ordering::SeqCst);
                        Err(RemoteError::Other("the CLI is busy".into()))
                    },
                    move || base + *moved.lock().unwrap(),
                );
        storage.folders().unwrap();
        *now.lock().unwrap() += RECHECK + Duration::from_secs(1);
        // A failed read says nothing against the storage, and is not repeated per request.
        for _ in 0..4 {
            storage.folders().unwrap();
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_reset_gives_the_next_call_a_storage_built_afresh_from_the_profile() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let binding = S3Binding {
            bucket: "reset-test-bucket".into(),
            ..binding()
        };
        let first = storage(&binding);
        assert!(Arc::ptr_eq(&first, &storage(&binding)));
        // The profile's endpoint or account may have changed since it was built.
        reset();
        assert!(!Arc::ptr_eq(&first, &storage(&binding)));
    }

    #[test]
    fn the_console_page_needs_the_storage_to_be_reachable() {
        let _state = crate::s3_storage::TEST_STATE
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let storage = S3Storage::with_build(binding(), |_| Err(RemoteError::Offline));
        assert_eq!(storage.console_url("f1"), None);
        assert_eq!(storage.address("f1"), "s3://team-bucket/ticketd/f1/");
    }
}
